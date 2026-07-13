// Single source of truth for the support / community / feedback config, from Ruili's
// section-08 deliverable (support-contact-and-feedback-config). Config-driven: the
// SupportContactPanel renders from this list, contacts are never hardcoded in render
// logic. Swap the values here when Ruili updates them; the panel doesn't change.

export type SupportContact = {
  id: string;
  label: string;
  value?: string; // copyable text (WeChat id, QQ group, email address)
  url?: string; // mailto: / https: opened via the host openExternal
  localePriority?: string[]; // locales that should see this contact first
  copyable?: boolean; // one-click copy (WeChat / QQ / email)
};

export const SUPPORT_CONTACTS: readonly SupportContact[] = [
  { id: "wechat", label: "WeChat Contact", value: "wxinliliszdyyr", localePriority: ["zh-CN"], copyable: true },
  { id: "qq_group", label: "QQ Group", value: "347622978", localePriority: ["zh-CN"], copyable: true },
  { id: "email", label: "Email Feedback", value: "1069653183@qq.com", url: "mailto:1069653183@qq.com", copyable: true },
  { id: "discord", label: "Discord Community", url: "https://discord.gg/EPRn28fJ2", localePriority: ["en", "default"] },
  { id: "github_repo", label: "GitHub Repository", url: "https://github.com/FreakStudioCN/mpy-hardware-extension" },
  { id: "github_issues", label: "GitHub Issues", url: "https://github.com/FreakStudioCN/mpy-hardware-extension/issues" },
];

// Order contacts so the locale's priority entries come first (zh-CN sees WeChat/QQ first;
// other locales see Discord first via the "default" tag), stable within each group.
// Case-insensitive: vscode.env.language is lowercase BCP-47 ("zh-cn"), while the config
// priorities are written "zh-CN" — compare in one case so a Chinese user still matches.
export function orderContactsByLocale(contacts: readonly SupportContact[], locale: string): SupportContact[] {
  const loc = (locale ?? "").toLowerCase();
  const prioritized = (c: SupportContact): boolean => {
    const p = (c.localePriority ?? []).map((x) => x.toLowerCase());
    return p.includes(loc) || (loc !== "zh-cn" && p.includes("default"));
  };
  return [...contacts].sort((a, b) => Number(prioritized(b)) - Number(prioritized(a)));
}

// Fields to gather when reporting an issue (section 08 minimal diagnostics). Keys only —
// the host fills the values; the panel shows/exports them so a bug report is actionable.
export const SUPPORT_DIAGNOSTICS_FIELDS = [
  "session_id",
  "current_phase",
  "recent_activity",
  "key_errors",
  "artifact_index",
  "plugin_version",
  "extension_version",
  "submodule_commit",
  "os",
  "node",
  "npm",
  "python",
  "mpremote",
  "selected_board",
  "serial_port",
  "last_command",
  "stdout_stderr_summary",
] as const;
export type SupportDiagnosticsField = (typeof SUPPORT_DIAGNOSTICS_FIELDS)[number];

// Assemble the diagnostics snapshot from a merged field bag (session + host values):
// every declared field in canonical order, any missing value as "", plus the joined
// text form for one-click copy. Keeps the 17-field contract and its ordering in one
// place — callers can only over-supply; unknown keys are dropped, absent keys are blank.
export function buildDiagnosticsFields(merged: Record<string, string>): { text: string; fields: Record<string, string> } {
  const fields: Record<string, string> = {};
  for (const key of SUPPORT_DIAGNOSTICS_FIELDS) fields[key] = merged[key] ?? "";
  const text = SUPPORT_DIAGNOSTICS_FIELDS.map((key) => `${key}: ${fields[key]}`).join("\n");
  return { text, fields };
}

// Issue-report form (section 08 §6.3: let the user pick an issue type, describe it, and
// optionally leave contact info). The type list and target are config here, never hardcoded
// in the render.
export const ISSUE_TYPES = ["bug", "feature_request", "question", "other"] as const;
export type IssueType = (typeof ISSUE_TYPES)[number];

// The report target is the github_issues contact's /new page, derived from the same config
// entry so a single URL change moves both the "Open GitHub Issues" button and the form.
const GITHUB_ISSUES_URL =
  SUPPORT_CONTACTS.find((c) => c.id === "github_issues")?.url ??
  "https://github.com/FreakStudioCN/mpy-hardware-extension/issues";
export const ISSUE_FORM_URL = `${GITHUB_ISSUES_URL}/new`;

// GitHub caps a GET issue URL around 8k; keep the attached diagnostics well under that so the
// title + description always survive.
const ISSUE_BODY_DIAG_MAX = 3500;
const ISSUE_TITLE_MAX = 80;

// Build a prefilled GitHub "new issue" URL from the form fields. Pure (the host validates the
// inputs first), so it is unit-testable. Everything is URL-encoded; diagnostics are truncated.
export function buildIssueReportUrl(input: {
  issueType: string;
  description: string;
  contact?: string;
  diagnosticsText?: string;
}): string {
  const firstLine = input.description.trim().split("\n")[0] ?? "";
  const title = `[${input.issueType}] ${firstLine}`.slice(0, ISSUE_TITLE_MAX);
  const parts = [input.description.trim()];
  const contact = input.contact?.trim();
  if (contact) parts.push(`\nContact: ${contact}`);
  const diag = input.diagnosticsText?.trim();
  if (diag) parts.push("\n\nDiagnostics:\n```\n" + diag.slice(0, ISSUE_BODY_DIAG_MAX) + "\n```");
  const body = parts.join("\n");
  return `${ISSUE_FORM_URL}?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`;
}
