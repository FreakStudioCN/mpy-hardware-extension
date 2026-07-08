import { build } from "esbuild";
import { mkdirSync } from "node:fs";

import { readSkillsCommit } from "./skills-commit.mjs";

// Bundle the real TS extension entry into the CommonJS artifact VS Code loads.
// Before this, dist/extension/activate.cjs was hand-maintained and forked from
// src/, so the tested agent code never shipped. Now src/ is the single source.
mkdirSync("dist/extension", { recursive: true });

// Bake the bundled MicroPython_Skills commit so the diagnostics snapshot reports it in an
// installed VSIX (which has no .git); "unknown" outside a checkout.
const skillsCommit = readSkillsCommit();

await build({
  entryPoints: ["src/extension/activate.ts"],
  outfile: "dist/extension/activate.cjs",
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node18",
  external: ["vscode"],
  // import.meta.url is unavailable in CJS output; map it to the bundled file's
  // own URL so readWebviewHtml() can resolve the packaged index.html.
  banner: { js: "const __import_meta_url = require('node:url').pathToFileURL(__filename).href;" },
  define: { "import.meta.url": "__import_meta_url", "process.env.SKILLS_COMMIT": JSON.stringify(skillsCommit) },
  logLevel: "info",
});

console.log("Built dist/extension/activate.cjs from src/extension/activate.ts");
