// Version of the toolchain scripts (init_scaffold / validate_json / render_wiring /
// render_diagram / download_drivers) bundled into this VSIX at package time. Bump
// it together with mpyhw-api/app/toolchain.py TOOLCHAIN_VERSION whenever a bundled
// script's contract changes. The handshake warns (non-blocking) when an installed
// extension's bundled scripts are older than what the live API's skills expect.
export const BUNDLED_TOOLCHAIN_VERSION = "1";

// The VSIX version (mirrors package.json "version"). Hand-kept in sync the same way
// BUNDLED_TOOLCHAIN_VERSION is — bump both when you bump package.json. Used by the
// support diagnostics snapshot (section 08 "extension version").
export const EXTENSION_VERSION = "0.4.1";

// True only when the server clearly advertises a NEWER toolchain than we bundle.
// Unknown / unparseable / equal / older server versions never warn (fail-open).
export function toolchainOutdated(serverVersion: unknown, bundled: string = BUNDLED_TOOLCHAIN_VERSION): boolean {
  const server = Number(serverVersion);
  const have = Number(bundled);
  if (!Number.isFinite(server) || !Number.isFinite(have)) return false;
  return server > have;
}
