import { build } from "esbuild";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { readSkillsCommit } from "./skills-commit.mjs";
import { vendorPluginSubset } from "./vendor-plugin-subset.mjs";

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

// Which dirs/files make up the subset (and why) lives in vendor-plugin-subset.mjs so the
// packaged-runtime test can run the same selection against the real submodule.
const vendored = vendorPluginSubset(upstreamRoot, destRoot);
console.log(`Vendored ${vendored} V0 plugin files into ${destRoot}`);
