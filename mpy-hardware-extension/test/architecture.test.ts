import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(join(here, "..", rel), "utf-8");

// The production webview path is createProtocolLoop (panel.ts createLoop). The legacy
// 27-tool createAgentBackedLoop lingered as a dead import in panel.ts (alongside the
// still-used DEV_API_BASE_URL) — exactly the residue that makes maintainers misjudge the
// real run path (issue #3 / #5). Guard it: the panel must not import the legacy loop.
test("the webview panel does not import the legacy createAgentBackedLoop", () => {
  const panel = read("src/webview/panel.ts");
  assert.doesNotMatch(
    panel,
    /import\s*\{[^}]*\bcreateAgentBackedLoop\b[^}]*\}\s*from/,
    "createAgentBackedLoop is the dead 27-tool loop; the panel uses createProtocolLoop. Its real users are the dev CLIs (run-live-gen / run-golden-path), not the panel.",
  );
});
