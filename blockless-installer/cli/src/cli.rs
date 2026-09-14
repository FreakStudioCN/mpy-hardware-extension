//! The argument grammar only -- no OS dependency, so it compiles and is
//! unit-tested on every target (unlike `main`'s dispatch body, which needs
//! `system::SystemEnvironment` and is cfg-gated to macOS/Windows).
//!
//! `resolve_vsix_path`/`default_manifest_path`/`mac_install_targets` live in
//! `blockless_installer_core::bootstrap` now, not here -- the GUI shell
//! needs the same wiring and cannot depend on this bin-only crate.

use clap::{Parser, Subcommand};
use std::path::PathBuf;

#[derive(Parser)]
#[command(
    name = "blockless-installer",
    version,
    about = "Blockless one-click installer"
)]
pub struct Cli {
    /// Path to the manifest JSON. Defaults to installer.manifest.json
    /// alongside this binary.
    #[arg(long, global = true)]
    pub manifest: Option<PathBuf>,
    /// Override the bundled Blockless extension VSIX path from the manifest.
    /// Unused by repair-runtime/verify/diagnostics/uninstall.
    #[arg(long, global = true)]
    pub vsix: Option<PathBuf>,
    #[command(subcommand)]
    pub command: Command,
}

#[derive(Subcommand, Debug, PartialEq, Eq)]
pub enum Command {
    /// Fresh install: all four steps in order, ending with a foreground
    /// open into the profile.
    Install,
    /// Steps 1, 2, 4 (detect-skip-do); never touches the Python runtime.
    Repair,
    /// Removes the contained env/ deterministically, then reprovisions
    /// Python + mpremote from scratch.
    RepairRuntime,
    /// Force-reinstalls the bundled extension, bypassing the sha-match
    /// skip, and re-journals its sha.
    UpdateExtension,
    /// The 7 acceptance checks. One PASS/FAIL line per check; exits 0 only
    /// if all pass.
    Verify,
    /// Bundles logs/ + state.json + the resolved manifest + OS/arch/version
    /// facts into a zip.
    Diagnostics {
        #[arg(long)]
        output: PathBuf,
    },
    /// Removes the profile (if we created it) and the contained runtime.
    /// VS Code is removed only if we installed it, unless overridden.
    Uninstall {
        /// Remove VS Code even if this installer didn't put it there.
        #[arg(long)]
        all: bool,
        /// Never remove VS Code, even if this installer installed it. This
        /// installer stops tracking it once the rest of the uninstall
        /// finishes: --all is the only way to remove it after that.
        #[arg(long)]
        keep_vscode: bool,
    },
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(args: &[&str]) -> Cli {
        let mut full = vec!["blockless-installer"];
        full.extend_from_slice(args);
        Cli::try_parse_from(full).unwrap_or_else(|e| panic!("failed to parse {args:?}: {e}"))
    }

    #[test]
    fn parses_each_subcommand_to_the_right_variant() {
        assert_eq!(parse(&["install"]).command, Command::Install);
        assert_eq!(parse(&["repair"]).command, Command::Repair);
        assert_eq!(parse(&["repair-runtime"]).command, Command::RepairRuntime);
        assert_eq!(
            parse(&["update-extension"]).command,
            Command::UpdateExtension
        );
        assert_eq!(parse(&["verify"]).command, Command::Verify);
    }

    #[test]
    fn diagnostics_requires_output() {
        let cli = parse(&["diagnostics", "--output", "/tmp/bundle.zip"]);
        match cli.command {
            Command::Diagnostics { output } => assert_eq!(output, PathBuf::from("/tmp/bundle.zip")),
            other => panic!("expected Diagnostics, got {other:?}"),
        }
        assert!(
            Cli::try_parse_from(["blockless-installer", "diagnostics"]).is_err(),
            "diagnostics must require --output"
        );
    }

    #[test]
    fn uninstall_flags_default_false_and_parse_when_set() {
        match parse(&["uninstall"]).command {
            Command::Uninstall { all, keep_vscode } => {
                assert!(!all);
                assert!(!keep_vscode);
            }
            other => panic!("expected Uninstall, got {other:?}"),
        }
        match parse(&["uninstall", "--all"]).command {
            Command::Uninstall { all, keep_vscode } => {
                assert!(all);
                assert!(!keep_vscode);
            }
            other => panic!("expected Uninstall, got {other:?}"),
        }
        match parse(&["uninstall", "--keep-vscode"]).command {
            Command::Uninstall { all, keep_vscode } => {
                assert!(!all);
                assert!(keep_vscode);
            }
            other => panic!("expected Uninstall, got {other:?}"),
        }
    }

    #[test]
    fn manifest_and_vsix_are_global_overrides() {
        let cli = parse(&[
            "--manifest",
            "/custom/manifest.json",
            "--vsix",
            "/custom/ext.vsix",
            "verify",
        ]);
        assert_eq!(cli.manifest, Some(PathBuf::from("/custom/manifest.json")));
        assert_eq!(cli.vsix, Some(PathBuf::from("/custom/ext.vsix")));
    }

    #[test]
    fn missing_subcommand_is_a_parse_error_not_a_silent_default() {
        assert!(Cli::try_parse_from(["blockless-installer"]).is_err());
    }
}
