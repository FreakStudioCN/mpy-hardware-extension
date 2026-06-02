const WEBVIEW_TYPES = new Set(["start_session", "cancel_session", "ui_prompt_response", "select_device", "approve_confirm", "reject_confirm"]);
const HOST_TYPES = new Set(["session_event", "trace_event", "manifest_updated", "code_updated", "serial_output", "confirm_needed", "ui_prompt_needed", "plan_needed", "session_done", "session_error"]);

export function validateWebviewMessage(message: any) {
  if (!message || !WEBVIEW_TYPES.has(message.type)) return invalid("unknown_message_type");
  if (message.type === "start_session" && (!message.intent || !message.boardId)) return invalid("malformed_payload");
  if (message.type === "ui_prompt_response" && (!message.promptId || typeof message.answer !== "string")) return invalid("malformed_payload");
  if (message.type === "select_device" && !message.port) return invalid("malformed_payload");
  return { ok: true };
}

export function validateHostMessage(message: any) {
  if (!message || !HOST_TYPES.has(message.type)) return invalid("unknown_message_type");
  if (message.type === "code_updated" && typeof message.code !== "string") return invalid("malformed_payload");
  if (message.type === "serial_output" && !Array.isArray(message.lines)) return invalid("malformed_payload");
  if (message.type === "manifest_updated" && typeof message.manifest !== "object") return invalid("malformed_payload");
  if (message.type === "ui_prompt_needed" && (!message.promptId || typeof message.question !== "string")) return invalid("malformed_payload");
  if (message.type === "plan_needed" && (!message.promptId || typeof message.plan !== "object")) return invalid("malformed_payload");
  return { ok: true };
}

function invalid(error: string) {
  return { ok: false, error };
}
