import { build } from "esbuild";
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";

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
  define: { "import.meta.url": "__import_meta_url" },
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

const files = [
  "upy-project-gen-toolchain-spec/scripts/validate_json.py",
  "upy-project-gen-toolchain-spec/project-manifest.schema.json",
  "upy-project-gen-toolchain-spec/wiring.schema.json",
  "upy-project-gen-toolchain-spec/diagram.schema.json",
  "upy-scaffold/scripts/init_scaffold.py",
  "upy-generate/scripts/download_drivers.py",
  "upy-wiring/scripts/render_wiring_local.py",
  "upy-diagram/scripts/render_diagram_local.py",
  ...walk(join(upstreamRoot, "upy-scaffold", "templates")).map((abs) => relative(upstreamRoot, abs).replaceAll("\\", "/")),
];
for (const rel of files) {
  const to = join(destRoot, rel);
  mkdirSync(dirname(to), { recursive: true });
  cpSync(join(upstreamRoot, rel), to);
}
console.log(`Vendored ${files.length} upstream files into ${destRoot}`);

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
