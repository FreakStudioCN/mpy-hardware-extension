import { build } from "esbuild";
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";

import { readSkillsCommit } from "./skills-commit.mjs";

// `vscode:prepublish` — produce everything that must ship in the VSIX but is not a
// committed source file:
//   1. the bundled CommonJS entry (dist/extension/activate.cjs), and
//   2. the upstream toolchain scripts/schemas/templates the device shim runs.
// vsce can only package files inside the extension dir, but the upstream subset
// lives in the repo-root submodule one level up — so it is vendored in here.
// serve.py's scripts_root() resolves <ext>/third_party/MicroPython_Skills in a
// packaged VSIX (see python/shim/serve.py).

// 1. Bundle src/extension/activate.ts -> dist/extension/activate.cjs (same config
//    as build-extension.mjs; import.meta.url shimmed so readWebviewHtml resolves).
//    Bake the submodule commit so the packaged VSIX reports it (it ships no .git).
mkdirSync("dist/extension", { recursive: true });
await build({
  entryPoints: ["src/extension/activate.ts"],
  outfile: "dist/extension/activate.cjs",
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node18",
  external: ["vscode"],
  banner: { js: "const __import_meta_url = require('node:url').pathToFileURL(__filename).href;" },
  define: { "import.meta.url": "__import_meta_url", "process.env.SKILLS_COMMIT": JSON.stringify(readSkillsCommit()) },
  logLevel: "info",
});

// 2. Vendor the upstream toolchain subset into <ext>/third_party.
const upstreamRoot = join("..", "third_party", "MicroPython_Skills");
if (!existsSync(upstreamRoot)) {
  console.error(`Upstream submodule not found at ${upstreamRoot} — run \`git submodule update --init --recursive\` before packaging.`);
  process.exit(1);
}
const destRoot = join("third_party", "MicroPython_Skills");
rmSync(destRoot, { recursive: true, force: true });

// V0: bundle the 6 protocol-native `-plugin` skill dirs (their scripts/ + the
// resources those scripts read: templates, schemas, knowledge), plus shared-plugin-
// scripts and the toolchain-spec schemas. The cloud model names scripts by their bare
// filename and serve.py's run_v0 resolver finds them under any bundled scripts/ dir,
// so the whole dir must ship — not a cherry-picked allowlist. We DROP the heavy prose
// (SKILL.md/README) and the test/sample/mock fixtures. WONTFIX (issue #3/#4): the packaged
// device shim runs the scripts but never reads SKILL.md, and the cloud backend loads skill
// prose from its OWN copy (skill_catalog.py / live serve), not from the VSIX. Only an
// offline/self-hosted full-protocol run would need the .md re-included.
const PLUGIN_DIRS = [
  "upy-analyze-plugin",
  "upy-select-hw-plugin",
  "upy-flash-mpy-firmware-plugin",
  "upy-scaffold-plugin",
  "upy-generate-plugin",
  "upy-deploy-plugin",
  // Optional flows, now served: their script_run scripts must ship or the packaged VSIX
  // fails script_not_found on every gen-driver/wiring/diagram run (the #39 dev-vs-packaged trap).
  "upy-gen-driver-plugin",
  "upy-wiring-plugin",
  "upy-diagram-plugin",
  "shared-plugin-scripts",
  "upy-project-gen-toolchain-spec",
];
const EXCLUDE_DIRS = new Set(["test", "tests", "sample", "samples", "mock-messages", "__pycache__"]);
function shouldSkip(relPosix) {
  const parts = relPosix.split("/");
  if (parts.some((p) => EXCLUDE_DIRS.has(p))) return true;
  return relPosix.endsWith(".md") || relPosix.endsWith(".pyc");
}
let vendored = 0;
for (const dir of PLUGIN_DIRS) {
  const absDir = join(upstreamRoot, dir);
  if (!existsSync(absDir)) continue;
  for (const abs of walk(absDir)) {
    const rel = relative(upstreamRoot, abs).replaceAll("\\", "/");
    if (shouldSkip(rel)) continue;
    const to = join(destRoot, rel);
    mkdirSync(dirname(to), { recursive: true });
    cpSync(abs, to);
    vendored++;
  }
}
console.log(`Vendored ${vendored} V0 plugin files into ${destRoot}`);

function walk(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}
