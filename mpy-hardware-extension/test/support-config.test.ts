import assert from "node:assert/strict";
import test from "node:test";

import { SUPPORT_CONTACTS, SUPPORT_DIAGNOSTICS_FIELDS, orderContactsByLocale } from "../src/core/support-config.ts";

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

test("diagnostics fields cover the section-08 essentials", () => {
  for (const key of ["session_id", "current_phase", "submodule_commit", "mpremote", "stdout_stderr_summary"]) {
    assert.ok(SUPPORT_DIAGNOSTICS_FIELDS.includes(key as any), `${key} in diagnostics fields`);
  }
});
