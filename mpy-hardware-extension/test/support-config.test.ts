import assert from "node:assert/strict";
import test from "node:test";

import { ISSUE_FORM_URL, SUPPORT_CONTACTS, SUPPORT_DIAGNOSTICS_FIELDS, buildIssueReportUrl, orderContactsByLocale } from "../src/core/support-config.ts";

test("every support contact has an id, a label, and a value or url", () => {
  for (const c of SUPPORT_CONTACTS) {
    assert.ok(c.id, "id present");
    assert.ok(c.label, "label present");
    assert.ok(c.value || c.url, `${c.id} has a value or url`);
  }
  // copyable contacts must carry copyable text; link-only contacts must carry a url
  assert.equal(SUPPORT_CONTACTS.find((c) => c.id === "wechat")?.copyable, true);
  assert.ok(SUPPORT_CONTACTS.find((c) => c.id === "discord")?.url);
});

test("orderContactsByLocale surfaces locale-priority contacts first", () => {
  const zh = orderContactsByLocale(SUPPORT_CONTACTS, "zh-CN").map((c) => c.id);
  assert.ok(zh.indexOf("wechat") < zh.indexOf("discord"), "zh-CN sees WeChat before Discord");

  const en = orderContactsByLocale(SUPPORT_CONTACTS, "en").map((c) => c.id);
  assert.ok(en.indexOf("discord") < en.indexOf("wechat"), "en sees Discord before WeChat");

  // ordering is a reordering, never a filter — every contact is still present
  assert.equal(zh.length, SUPPORT_CONTACTS.length);
  assert.equal(en.length, SUPPORT_CONTACTS.length);
});

test("orderContactsByLocale matches the locale case-insensitively", () => {
  // vscode.env.language is lowercase BCP-47 (VS Code sends "zh-cn", never "zh-CN"),
  // but the config priority is written "zh-CN". A Chinese user must still see the
  // China-first contacts (WeChat/QQ) ahead of Discord.
  const zh = orderContactsByLocale(SUPPORT_CONTACTS, "zh-cn").map((c) => c.id);
  assert.ok(zh.indexOf("wechat") < zh.indexOf("discord"), "zh-cn sees WeChat before Discord");
  assert.ok(zh.indexOf("qq_group") < zh.indexOf("discord"), "zh-cn sees QQ before Discord");
});

test("diagnostics fields cover the section-08 essentials", () => {
  for (const key of ["session_id", "current_phase", "submodule_commit", "mpremote", "stdout_stderr_summary"]) {
    assert.ok(SUPPORT_DIAGNOSTICS_FIELDS.includes(key as any), `${key} in diagnostics fields`);
  }
});

test("buildIssueReportUrl url-encodes the report and includes/omits contact", () => {
  const url = buildIssueReportUrl({ issueType: "bug", description: "logs & panel #broke\nsecond line", contact: "me@x.com" });
  assert.ok(url.startsWith(ISSUE_FORM_URL + "?"), "targets the configured issue form");
  const query = url.slice(url.indexOf("?") + 1);
  // special chars from the description must be percent-encoded, not raw in the query
  assert.doesNotMatch(query, /[ #]/, "spaces and # are encoded, not raw");
  const decoded = decodeURIComponent(query);
  assert.match(decoded, /\[bug\] logs & panel #broke/, "title is [type] + first line");
  assert.match(decoded, /Contact: me@x\.com/, "contact included when given");

  const noContact = decodeURIComponent(buildIssueReportUrl({ issueType: "question", description: "hi" }));
  assert.doesNotMatch(noContact, /Contact:/, "no contact section when omitted");
});

test("buildIssueReportUrl truncates attached diagnostics under the url cap", () => {
  const url = buildIssueReportUrl({ issueType: "bug", description: "x", diagnosticsText: "d".repeat(9000) });
  const body = decodeURIComponent(url.slice(url.indexOf("body=") + "body=".length));
  const diagChars = (body.match(/d/g) || []).length;
  assert.ok(diagChars > 0 && diagChars <= 3500, `diagnostics truncated to the cap (${diagChars})`);
  assert.match(body, /Diagnostics:/, "diagnostics block present");
});

test("buildIssueReportUrl bounds the total body under the url limit", () => {
  const url = buildIssueReportUrl({ issueType: "bug", description: "d".repeat(9000), diagnosticsText: "x".repeat(9000) });
  const body = decodeURIComponent(url.slice(url.indexOf("body=") + "body=".length));
  // Reverting the `.slice(0, ISSUE_BODY_MAX)` in buildIssueReportUrl fails this.
  assert.ok(body.length <= 6000, `body bounded to the cap (${body.length})`);
});
