// The upstream skill dirs the VSIX bundles. Its own module (not inlined in prepare-vsce.mjs) so a
// test can read it without running the packager, which rewrites dist/ and the vendored tree.
//
// V0: the 6 protocol-native `-plugin` skill dirs (their scripts/ + the resources those scripts read:
// templates, schemas, knowledge), the on-demand flows, plus shared-plugin-scripts and the
// toolchain-spec schemas. The cloud model names scripts by their bare filename and serve.py's run_v0
// resolver finds them under any bundled scripts/ dir, so the whole dir must ship — not a
// cherry-picked allowlist. We DROP the heavy prose (SKILL.md/README) and the test/sample/mock
// fixtures. WONTFIX (issue #3/#4): the packaged device shim runs the scripts but never reads
// SKILL.md, and the cloud backend loads skill prose from its OWN copy (skill_catalog.py / live
// serve), not from the VSIX. Only an offline/self-hosted full-protocol run would need the .md
// re-included.
//
// Every dir serve.py indexes (_V0_PLUGIN_DIRS) must appear here, or the packaged VSIX fails
// script_not_found on a run that works in dev — the dev-vs-packaged trap. plugin-dirs-contract
// asserts that direction.
export const PLUGIN_DIRS = [
  "upy-analyze-plugin",
  "upy-select-hw-plugin",
  "upy-flash-mpy-firmware-plugin",
  "upy-scaffold-plugin",
  "upy-generate-plugin",
  "upy-deploy-plugin",
  // Optional flows, now served: their script_run scripts must ship or the packaged VSIX
  // fails script_not_found on every gen-driver/wiring/diagram run.
  "upy-gen-driver-plugin",
  "upy-wiring-plugin",
  "upy-diagram-plugin",
  // Sipeed MaixPy export (standalone global tool): its validate_maixpy_export.py runs on the
  // generated sipeed_vision/ files, so it must ship for a packaged export run to validate.
  "upy-maixpy-export-plugin",
  "shared-plugin-scripts",
  "upy-project-gen-toolchain-spec",
  // Legacy (non-plugin) scaffold/download scripts: the host's script.run_scaffold /
  // script.run_download_drivers dispatch passes --project-dir and expects files written to
  // disk, which only these legacy scripts do (the -plugin equivalents are stdout-only). See
  // serve.py SCRIPT_FILES. Must ship or the packaged VSIX fails on scaffold/download.
  "upy-scaffold",
  "upy-generate",
];
