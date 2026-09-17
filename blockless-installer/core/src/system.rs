//! The real, OS-native implementation of [`crate::ops::Environment`] for an
//! actual machine. Everything here is a thin `std::process::Command`
//! shell-out to the exact tool + flags the M0 scripts already proved work
//! (`codesign`, `ditto`, `xattr`, `tar`; `taskkill`, `Get-AuthenticodeSignature`,
//! the User Setup installer flags) -- this file is NOT re-deriving behavior,
//! it is porting a command line verbatim per OS.
//!
//! Cfg-gated per target: only the current build's own OS module compiles at
//! all, so neither module can be exercised (compiled OR run) on the other
//! platform, or in this sandbox, which is neither. Every other module in
//! this crate is unit-tested against a fake implementation of the same
//! traits; this file's correctness is verified on the acceptance rig, not
//! here (see `/scope.md`'s "Acceptance"). The mac module's own tar-extraction
//! tests happen to run on any Unix (`tar` isn't mac-specific), but
//! installer-ci.yml only runs `ubuntu-latest` and `windows-latest`, neither
//! of which sets `target_os = "macos"` -- so even those never execute in
//! CI, only when `cargo test` runs for real on a Mac (or in a sandbox like
//! this one, at build time, as they were before landing here).
//!
//! One deliberate, flagged deviation from `/scope.md`'s stated preference:
//! Windows signature verification shells out to PowerShell's
//! `Get-AuthenticodeSignature` (exactly what `install-blockless.ps1` already
//! does) rather than the `windows` crate's `WinVerifyTrust` binding. The
//! `windows` crate needs a real Windows toolchain to build against; this
//! sandbox has none, and shipping an unverifiable FFI integration seemed
//! like the wrong trade against a mechanism M0 already proved on a real
//! Windows Sandbox. The security PROPERTY (gate on a Valid Authenticode
//! signature whose signer's Subject pins `O=Microsoft Corporation`, before
//! anything is extracted or executed) is identical either way. Revisiting
//! this on real Windows hardware is a reasonable follow-up, not a gap in
//! what it protects against.

#[cfg(target_os = "macos")]
pub use mac::MacEnvironment as SystemEnvironment;
#[cfg(target_os = "windows")]
pub use windows::WindowsEnvironment as SystemEnvironment;

#[cfg(target_os = "macos")]
#[path = "system/mac.rs"]
mod mac;

#[cfg(target_os = "windows")]
#[path = "system/windows.rs"]
mod windows;
