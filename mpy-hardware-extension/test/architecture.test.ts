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

test("package metadata points users to the upstream FreakStudioCN repository", () => {
  const pkg = JSON.parse(read("package.json"));
  assert.equal(pkg.repository.url, "https://github.com/FreakStudioCN/mpy-hardware-extension.git");
  assert.equal(pkg.homepage, "https://github.com/FreakStudioCN/mpy-hardware-extension#readme");
  assert.equal(pkg.bugs.url, "https://github.com/FreakStudioCN/mpy-hardware-extension/issues");
});

// Security regression lock (audit P0-1): apiBaseUrl/pythonPath/pipIndexUrl each control a
// dangerous sink — where the auth token + generated code are POSTed, which binary the doctor
// executes, and which pip index the venv installs from. Left at the default `window` scope, a
// malicious repo's .vscode/settings.json could set them and redirect a trusted user's traffic
// or run an arbitrary executable. `machine` scope makes them settable only in User/Remote
// settings, never per-workspace. Do NOT relax this without re-reading the audit.
test("execution/network-sensitive settings are machine-scoped (not workspace-overridable)", () => {
  const pkg = JSON.parse(read("package.json"));
  const props = pkg.contributes.configuration.properties;
  for (const id of ["mpyhw.apiBaseUrl", "mpyhw.pythonPath", "mpyhw.pipIndexUrl"]) {
    assert.equal(props[id]?.scope, "machine", `${id} must be scope:"machine" so a workspace cannot override it`);
  }
});