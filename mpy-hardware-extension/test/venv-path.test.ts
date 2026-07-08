import assert from "node:assert/strict";
import { delimiter } from "node:path";
import test from "node:test";

import { withVenvOnPath } from "../scripts/venv-path.mjs";

test("withVenvOnPath prepends the venv bin to an existing PATH", () => {
  const out = withVenvOnPath({ PATH: `/usr/bin${delimiter}/bin` }, "/proj/.venv/bin");
  assert.equal(out.PATH, `/proj/.venv/bin${delimiter}/usr/bin${delimiter}/bin`);
});

test("withVenvOnPath overrides the real key casing (Windows Path), no duplicate PATH", () => {
  const out = withVenvOnPath({ Path: "C:\\sys" }, "C:\\proj\\.venv\\Scripts");
  // the existing lowercase-ish "Path" key is the one updated...
  assert.equal(out.Path, `C:\\proj\\.venv\\Scripts${delimiter}C:\\sys`);
  // ...and no stray uppercase "PATH" key is introduced alongside it
  assert.ok(!("PATH" in out));
});

test("withVenvOnPath handles a missing PATH by seeding it", () => {
  const out = withVenvOnPath({}, "/v/bin");
  assert.equal(out.PATH, `/v/bin${delimiter}`);
});
