// Version of the toolchain scripts (init_scaffold / validate_json / render_wiring /
// render_diagram / download_drivers) bundled into this VSIX at package time. Bump
// it together with mpyhw-api/app/toolchain.py TOOLCHAIN_VERSION whenever a bundled
// script's contract changes. The handshake warns (non-blocking) when an installed
// extension's bundled scripts are older than what the live API's skills expect.
//
// 2: init_scaffold and its firmware templates changed across TWO skills pin moves and
// this constant was not bumped for either, so v1 covers 65bef88 through 5ab8e9c. The
// change that matters to an installed extension is that the templates now print
// MPYHW_READY after hardware init: an older bundled scaffold renders firmware that
// never prints it, while the live deploy skill stop-matches on it, so the capture
// stalls and the phase fails with nothing naming the cause. That is exactly the
// warning this version exists to produce.
export const BUNDLED_TOOLCHAIN_VERSION = "2";

// The VSIX version (mirrors package.json "version"). Hand-kept in sync the same way
// BUNDLED_TOOLCHAIN_VERSION is — bump both when you bump package.json. Used by the
// support diagnostics snapshot (section 08 "extension version").
export const EXTENSION_VERSION = "0.4.2";

// True only when the server clearly advertises a NEWER toolchain than we bundle.
// Unknown / unparseable / equal / older server versions never warn (fail-open).
export function toolchainOutdated(serverVersion: unknown, bundled: string = BUNDLED_TOOLCHAIN_VERSION): boolean {
  const server = Number(serverVersion);
  const have = Number(bundled);
  if (!Number.isFinite(server) || !Number.isFinite(have)) return false;
  return server > have;
}
