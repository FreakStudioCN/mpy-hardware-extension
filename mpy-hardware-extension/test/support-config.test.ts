import assert from "node:assert/strict";
import test from "node:test";

import { CREDITS_REQUEST_EMAIL, ISSUE_FORM_URL, SUPPORT_CONTACTS, SUPPORT_DIAGNOSTICS_FIELDS, buildCreditsRequestMailto, buildIssueReportUrl, orderContactsByLocale } from "../src/core/support-config.ts";

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

test("buildIssueReportUrl bounds the total ENCODED url under GitHub's limit", () => {
  // url is already percent-encoded, so url.length IS the encoded length GitHub sees for the 414.
  const url = buildIssueReportUrl({ issueType: "bug", description: "d".repeat(9000), diagnosticsText: "x".repeat(9000) });
  assert.ok(url.length <= 8192, `encoded url under GitHub's ~8k limit (${url.length})`);
});

test("buildIssueReportUrl keeps a CJK report under the url limit and never splits a surrogate (#35 review)", () => {
  // A CJK char is 3 UTF-8 bytes = 9 encoded chars, so bounding the RAW length let the encoded URL
  // overrun ~8k and 414 — the common CN-first path. Bounding the ENCODED length fixes it.
  const cjk = buildIssueReportUrl({ issueType: "bug", description: "中".repeat(5000), diagnosticsText: "错误".repeat(3000) });
  assert.ok(cjk.length <= 8192, `encoded CJK url under the limit (${cjk.length})`);
  assert.match(decodeURIComponent(cjk), /\[bug\] 中+/, "still a valid prefilled issue, not truncated to nothing");
  // Mutation: revert to a raw `.slice(0, N)` bound -> the encoded CJK url blows past 8192 here.

  // An emoji straddling the title/body truncation boundary must not throw a lone-surrogate URIError.
  const emoji = { issueType: "bug", description: "X".repeat(73) + "😀 crashy", diagnosticsText: "e".repeat(9000) };
  assert.doesNotThrow(() => buildIssueReportUrl(emoji), "code-point slicing avoids the encodeURIComponent throw");
  assert.match(decodeURIComponent(buildIssueReportUrl(emoji)), /\[bug\]/, "still a decodable url");
  // Mutation: revert title/body to plain `.slice()` -> the emoji at the boundary throws URIError.
});

test("buildIssueReportUrl tolerates a lone surrogate already split by an upstream slice (#35 re-review)", () => {
  // The code-point helpers never CREATE a split, but panel.ts/session-controller slice on code UNITS,
  // so an input can arrive with a lone surrogate. Each field must be sanitized, not just kept intact.
  const hi = "\uD83D"; // lone high surrogate (emoji split by a slice(0,n))
  const lo = "\uDE00"; // lone low surrogate (tail split by a slice(-n))
  const cases = [
    { issueType: "bug", description: "X".repeat(4999) + hi },        // description path (panel.ts:566)
    { issueType: "bug", description: "ok", contact: "a@b.com" + hi }, // contact path (panel.ts:569)
    { issueType: "bug", description: "ok", diagnosticsText: lo + "traceback" }, // diagnostics tail (session-controller:717)
    { issueType: "bug" + hi, description: "ok" },                     // title/issueType path (broad string export)
  ];
  for (const c of cases) {
    assert.doesNotThrow(() => buildIssueReportUrl(c), `lone surrogate must not throw URIError: ${JSON.stringify(Object.keys(c))}`);
    const decoded = decodeURIComponent(buildIssueReportUrl(c));
    assert.ok(!decoded.includes(hi) && !decoded.includes(lo), "the injected lone surrogate is stripped, not carried into the url");
  }
  // Mutation: drop stripLoneSurrogates from buildIssueReportUrl -> encodeURIComponent throws URIError here.
});

test("buildCreditsRequestMailto targets the support email and carries every identifier line (#97)", () => {
  const url = buildCreditsRequestMailto({
    githubLogin: "octocat",
    balance: "42",
    dailyGrant: "100",
    resetsAt: "2026-07-26T00:00:00Z",
    extensionVersion: "1.2.3",
    pluginVersion: "4.5.6",
    sessionId: "sess-9",
  });
  assert.ok(url.startsWith(`mailto:${CREDITS_REQUEST_EMAIL}?`), "addresses the config support email, not a hardcoded literal");
  const body = decodeURIComponent(url.slice(url.indexOf("body=") + "body=".length));
  assert.match(body, /Contact email: please fill in your email/, "user-filled contact line present");
  assert.match(body, /GitHub login: octocat/);
  assert.match(body, /Credit balance: 42/);
  assert.match(body, /Daily grant: 100/);
  assert.match(body, /Resets at: 2026-07-26T00:00:00Z/);
  assert.match(body, /Extension version: 1\.2\.3/);
  assert.match(body, /Plugin version: 4\.5\.6/);
  assert.match(body, /Session id: sess-9/);
  // Not a payment portal: no payment/recharge/top-up language in the generated mail.
  assert.doesNotMatch(body.toLowerCase(), /pay|recharge|top-up|top up/, "contact entry, not a payment portal");
});

test("buildCreditsRequestMailto keeps a CJK login under the encoded budget and never throws on a lone surrogate (#97)", () => {
  const cjk = buildCreditsRequestMailto({
    githubLogin: "用户".repeat(2000), balance: "0", dailyGrant: "0", resetsAt: "", extensionVersion: "1", pluginVersion: "1", sessionId: "",
  });
  assert.ok(cjk.length < 2083, "encoded mailto stays under the Windows mailto command cap");
  assert.doesNotThrow(() => buildCreditsRequestMailto({
    githubLogin: "octo\uD83D", balance: "0", dailyGrant: "0", resetsAt: "", extensionVersion: "1", pluginVersion: "1", sessionId: "\uDE00x",
  }), "a lone surrogate in login/session must not throw URIError");
});
