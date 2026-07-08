import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

// The bundled MicroPython_Skills commit, read at build/package time from the submodule
// (one level up from this nested package). Both the dev build (build-extension.mjs) and
// the packaging build (prepare-vsce.mjs) bake it into the bundle via esbuild `define` ->
// process.env.SKILLS_COMMIT, because the installed VSIX has no .git and so cannot resolve
// it at runtime for the diagnostics snapshot. Returns "unknown" outside a checkout.
export function readSkillsCommit() {
  try {
    const dir = resolve(process.cwd(), "..", "third_party", "MicroPython_Skills");
    return execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim() || "unknown";
  } catch {
    return "unknown"; // not a git checkout (e.g. building from a tarball)
  }
}
