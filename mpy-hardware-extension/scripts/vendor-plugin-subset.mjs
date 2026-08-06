import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

import { MAINTENANCE_SCRIPTS, PLUGIN_DIRS } from "./plugin-dirs.mjs";

// The VSIX vendor step, extracted from prepare-vsce.mjs so a test can run the REAL
// selection logic against the real submodule instead of re-describing it. vsce can only
// package files inside the extension dir, but the upstream subset lives in the repo-root
// submodule one level up — so it is vendored in. serve.py's scripts_root() resolves
// <ext>/third_party/MicroPython_Skills in a packaged VSIX (see python/shim/serve.py).
//
// Only vendorPluginSubset is exported. The ignore rules stay private on purpose: a test that
// imported them could only re-assert them, which is the tautology the packaged-runtime test
// avoids by asserting the file set they produce.

// The dirs to bundle (and why each must ship) live in plugin-dirs.mjs, the single source
// plugin-dirs-contract asserts serve.py's _V0_PLUGIN_DIRS against. We DROP the heavy prose
// (SKILL.md/README) and the test/sample/mock fixtures by design: the packaged device shim
// runs the scripts but never reads SKILL.md, and the cloud backend loads skill prose from
// its OWN copy (skill_catalog.py / live serve), not from the VSIX.
const EXCLUDE_DIRS = new Set(["test", "tests", "sample", "samples", "mock-messages", "__pycache__"]);

// Curation cruft that must never ship: the board-source staging area and
// its dated archives carry the maintainer's local paths + fetch-failure traces (a CSV, a
// ZIP of OCR reports, cleanup manifests). None is read at runtime.
//
// Bundled Python environments must never ship either: a plugin builds its own runtime venv
// ON THE USER'S MACHINE (e.g. flash's bootstrap_esptool.py creates scripts/.venv-esptool and
// pip-installs esptool into it). A maintainer's local copy of that env is dead weight — it is
// platform-specific (macOS bin/python vs Windows Scripts/python.exe), bakes the base
// interpreter's absolute path so it is broken on any other machine, and bootstrap rebuilds it
// regardless. Skip any `.venv*` dir and any `site-packages` (a checked-in one leaked 50MB of
// native binaries into the VSIX).
function shouldSkip(relPosix) {
  const parts = relPosix.split("/");
  if (parts.some((p) => EXCLUDE_DIRS.has(p) || p === "_official_pending" || p.startsWith("_archive_") || p.startsWith(".venv") || p === "site-packages")) return true;
  if (MAINTENANCE_SCRIPTS.includes(parts[parts.length - 1])) return true;
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
