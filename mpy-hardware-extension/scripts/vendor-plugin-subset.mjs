import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

// The VSIX vendor step, extracted from prepare-vsce.mjs so a test can run the REAL
// selection logic against the real submodule instead of re-describing it. vsce can only
// package files inside the extension dir, but the upstream subset lives in the repo-root
// submodule one level up — so it is vendored in. serve.py's scripts_root() resolves
// <ext>/third_party/MicroPython_Skills in a packaged VSIX (see python/shim/serve.py).
//
// Only vendorPluginSubset is exported. The ignore rules stay private on purpose: a test that
// imported them could only re-assert them, which is the tautology the packaged-runtime test
// avoids by asserting the file set they produce.

// V0: bundle the 6 protocol-native `-plugin` skill dirs (their scripts/ + the
// resources those scripts read: templates, schemas, knowledge), plus shared-plugin-
// scripts and the toolchain-spec schemas. The cloud model names scripts by their bare
// filename and serve.py's run_v0 resolver finds them under any bundled scripts/ dir,
// so the whole dir must ship — not a cherry-picked allowlist. We DROP the heavy prose
// (SKILL.md/README) and the test/sample/mock fixtures by design: the packaged device shim
// runs the scripts but never reads SKILL.md, and the cloud backend loads skill prose from
// its OWN copy (skill_catalog.py / live serve), not from the VSIX. Only an
// offline/self-hosted full-protocol run would need the .md re-included.
const PLUGIN_DIRS = [
  "upy-analyze-plugin",
  "upy-select-hw-plugin",
  "upy-flash-mpy-firmware-plugin",
  "upy-scaffold-plugin",
  "upy-generate-plugin",
  "upy-deploy-plugin",
  // Optional flows, now served: their script_run scripts must ship or the packaged VSIX
  // fails script_not_found on every gen-driver/wiring/diagram run (the dev-vs-packaged trap:
  // they resolve in a dev checkout but are absent from the VSIX unless bundled here).
  "upy-gen-driver-plugin",
  "upy-wiring-plugin",
  "upy-diagram-plugin",
  "shared-plugin-scripts",
  "upy-project-gen-toolchain-spec",
  // Legacy (non-plugin) scaffold/download scripts: the host's script.run_scaffold /
  // script.run_download_drivers dispatch passes --project-dir and expects files written to
  // disk, which only these legacy scripts do (the -plugin equivalents are stdout-only). See
  // serve.py SCRIPT_FILES. Must ship or the packaged VSIX fails on scaffold/download.
  "upy-scaffold",
  "upy-generate",
];

const EXCLUDE_DIRS = new Set(["test", "tests", "sample", "samples", "mock-messages", "__pycache__"]);

// Curation cruft that must never ship: the board-source staging area and
// its dated archives carry the maintainer's local paths + fetch-failure traces (a CSV, a
// ZIP of OCR reports, cleanup manifests). None is read at runtime.
function shouldSkip(relPosix) {
  const parts = relPosix.split("/");
  if (parts.some((p) => EXCLUDE_DIRS.has(p) || p === "_official_pending" || p.startsWith("_archive_"))) return true;
  return relPosix.endsWith(".md") || relPosix.endsWith(".pyc") || relPosix.endsWith(".csv") || relPosix.endsWith(".zip");
}

// The generated board JSONs bake build-time provenance whose values are the maintainer's
// local absolute paths (e.g. "G:\\...") — dead at runtime (no reader in the extension or
// the vendored scripts, verified) but shipped in every VSIX. Drop any key/element whose
// string value is a Windows absolute path. Name-agnostic (can't miss a field) and
// value-conditional (can't delete a legitimate non-path field).
const WIN_ABS_PATH = /^[A-Za-z]:[\\/]/;
function stripLocalPaths(value) {
  if (Array.isArray(value)) {
    return value.filter((v) => !(typeof v === "string" && WIN_ABS_PATH.test(v))).map(stripLocalPaths);
  }
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (typeof v === "string" && WIN_ABS_PATH.test(v)) continue;
      out[k] = stripLocalPaths(v);
    }
    return out;
  }
  return value;
}

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

// Copy the V0 subset of `upstreamRoot` into a freshly emptied `destRoot`. Returns the
// number of files vendored.
export function vendorPluginSubset(upstreamRoot, destRoot) {
  rmSync(destRoot, { recursive: true, force: true });
  let vendored = 0;
  for (const dir of PLUGIN_DIRS) {
    const absDir = join(upstreamRoot, dir);
    if (!existsSync(absDir)) continue;
    for (const abs of walk(absDir)) {
      const rel = relative(upstreamRoot, abs).replaceAll("\\", "/");
      if (shouldSkip(rel)) continue;
      const to = join(destRoot, rel);
      mkdirSync(dirname(to), { recursive: true });
      if (rel.includes("/boards/") && rel.endsWith(".json")) {
        writeFileSync(to, JSON.stringify(stripLocalPaths(JSON.parse(readFileSync(abs, "utf8"))), null, 2) + "\n");
      } else {
        cpSync(abs, to);
      }
      vendored++;
    }
  }
  return vendored;
}
