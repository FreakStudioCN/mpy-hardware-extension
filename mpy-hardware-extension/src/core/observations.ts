const SERIAL_TAIL_LIMIT = 20;
const TEXT_FIELD_LIMIT = 1200;
// Absolute paths leak the username + local tree. Match a space inside a path only when
// it is followed by more path chars (so "C:/Users/Haipeng Wu/..." redacts whole), and
// stop at a quote/newline so surrounding context (", line 5, ...") survives.
const ABS_PATH_RE = /(?:[A-Za-z]:[\\/]|\/(?:Users|home|var|tmp|mnt|Volumes)\/)(?:[^\s"'\r\n]| (?=[^\s"'\r\n]))+/g;
const RAW_COMMAND_RE = /\bmpremote\s+connect\b[^\n\r"]*/gi;

export function normalizeObservation(toolName: string, output: any) {
  const sanitized = sanitizeValue(output);
  const observation: any = {
    tool: toolName,
    ok: sanitized?.ok !== false,
    output: { ...sanitized },
    truncated: false,
  };
  if (sanitized?.error_kind) {
    observation.error_kind = sanitized.error_kind;
  }
  if (Array.isArray(sanitized?.lines) && sanitized.lines.length > SERIAL_TAIL_LIMIT) {
    observation.output.lines = sanitized.lines.slice(-SERIAL_TAIL_LIMIT);
    observation.truncated = true;
  }
  if (markTruncated(output, sanitized)) observation.truncated = true;
  return observation;
}

export function toToolResultBlock(toolUseId: string, observation: any) {
  return {
    type: "tool_result",
    tool_use_id: toolUseId,
    content: JSON.stringify(observation),
  };
}

function sanitizeValue(value: any): any {
  if (typeof value === "string") return sanitizeText(value);
  if (Array.isArray(value)) return value.map(sanitizeValue);
  if (value && typeof value === "object") {
    const out: any = {};
    for (const [key, item] of Object.entries(value)) {
      if (key === "project_dir" || key === "runner_path" || key === "scripts_root") {
        out[key] = "[redacted-path]";
      } else if ((key === "artifacts" || key === "paths") && Array.isArray(item)) {
        out[key] = item.map((entry) => typeof entry === "string" ? sanitizePathEntry(entry) : sanitizeValue(entry));
      } else {
        out[key] = sanitizeValue(item);
      }
    }
    return out;
  }
  return value;
}

function sanitizeText(text: string): string {
  let out = text.replace(RAW_COMMAND_RE, "[redacted-command]");
  out = out.replace(ABS_PATH_RE, "[redacted-path]");
  if (out.length > TEXT_FIELD_LIMIT) {
    return `${out.slice(0, TEXT_FIELD_LIMIT)}...[truncated]`;
  }
  return out;
}

function isAbsolutePath(path: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("/");
}

function sanitizePathEntry(path: string): string {
  return isAbsolutePath(path) ? "[redacted-path]" : sanitizeText(path);
}

function markTruncated(original: any, sanitized: any): boolean {
  if (typeof original === "string") return original.length > TEXT_FIELD_LIMIT || original !== sanitized;
  if (Array.isArray(original)) return original.some((item, index) => markTruncated(item, sanitized?.[index]));
  if (original && typeof original === "object") {
    return Object.keys(original).some((key) => markTruncated(original[key], sanitized?.[key]));
  }
  return false;
}
