import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";

import { PARTNERS } from "../src/core/partner-config.ts";

test("every partner has an id, name, ascii .png file, and https url", () => {
  assert.equal(PARTNERS.length, 5);
  for (const p of PARTNERS) {
    assert.ok(p.id && p.name, `${p.id} has id + name`);
    assert.match(p.file, /^[a-z0-9_-]+\.png$/, `${p.id} file is ascii .png (no CN filename)`);
    assert.match(p.url, /^https:\/\//, `${p.id} url is https`);
  }
});

test("each partner logo file exists in the committed assets", () => {
  for (const p of PARTNERS) {
    const path = new URL(`../src/webview/assets/partners/${p.file}`, import.meta.url);
    assert.ok(existsSync(path), `${p.file} is committed`);
  }
});
