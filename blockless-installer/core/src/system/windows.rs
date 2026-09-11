use crate::extensions::ExtensionsRunner;
use crate::profile::CommandRunner;
use crate::runtime::RuntimeRunner;
use crate::uninstall::UninstallRunner;
use crate::vscode::{InstallError, SignatureError, VscodeInstaller};
use std::path::Path;
use std::process::Command;
use std::time::Duration;

pub struct WindowsEnvironment;

fn run_ok(cmd: &mut Command) -> bool {
    cmd.status().map(|s| s.success()).unwrap_or(false)
}

fn stdout_of(cmd: &mut Command) -> Option<String> {
    let out = cmd.output().ok()?;
    if !out.status.success() {
        return None;
    }
    String::from_utf8(out.stdout).ok()
}

fn powershell(script: &str) -> Command {
    let mut cmd = Command::new("powershell");
    cmd.args(["-NoProfile", "-NonInteractive", "-Command", script]);
    cmd
}

/// Escape a path for interpolation into a PowerShell single-quoted
/// string: doubling `'` is PowerShell's own escape for it inside a
/// single-quoted literal. Without this, a path containing `'` (rare but
/// legal in a Windows username/dir name) breaks out of the string and
/// its trailing text is interpreted as script rather than data.
fn ps_quote(path: &Path) -> String {
    path.display().to_string().replace('\'', "''")
}

impl CommandRunner for WindowsEnvironment {
    fn running_vscode_pids(&self) -> Result<Vec<u32>, String> {
        let out = stdout_of(&mut powershell(
            "(Get-Process -Name Code -ErrorAction SilentlyContinue).Id",
        ))
        .ok_or_else(|| "could not query running VS Code processes".to_string())?;
        out.lines()
            .filter(|line| !line.trim().is_empty())
            .map(|line| line.trim().parse().map_err(|e| format!("invalid PID: {e}")))
            .collect()
    }
    fn spawn(&self, code_cli: &Path, args: &[&str]) -> std::io::Result<u32> {
        Command::new(code_cli).args(args).spawn().map(|c| c.id())
    }
    fn is_alive(&self, pid: u32) -> bool {
        run_ok(&mut powershell(&format!(
            "if (Get-Process -Id {pid} -ErrorAction SilentlyContinue) {{ exit 0 }} else {{ exit 1 }}"
        )))
    }
    fn request_graceful_close(&self, pid: u32) {
        // WITHOUT /F: posts WM_CLOSE so VS Code saves window/profile
        // state before exiting (matches M0's Stop-OurCode).
        let _ = Command::new("taskkill")
            .args(["/PID", &pid.to_string()])
            .status();
    }
    fn force_kill(&self, pid: u32) {
        let _ = Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/F"])
            .status();
    }
    fn sleep(&self, d: Duration) {
        std::thread::sleep(d);
    }
}

impl VscodeInstaller for WindowsEnvironment {
    fn version(&self, code_cli: &Path) -> Option<String> {
        stdout_of(Command::new(code_cli).arg("--version"))
            .and_then(|s| s.lines().next().map(str::to_string))
    }
    fn is_writable(&self, _dir: &Path) -> bool {
        // Unused on Windows: install always targets %LOCALAPPDATA%,
        // never a writability-selected target (vscode.rs never calls
        // this on the Windows branch).
        true
    }
    fn extract_archive(&self, _archive: &Path, _target_dir: &Path) -> Result<(), InstallError> {
        Err(InstallError(
            "extract_archive is a macOS-only operation".to_string(),
        ))
    }
    fn install_verified_app(
        &self,
        _app_dir: &Path,
        _target_dir: &Path,
    ) -> Result<(), InstallError> {
        Err(InstallError(
            "install_verified_app is a macOS-only operation".to_string(),
        ))
    }
    fn strip_quarantine(&self, _app_dir: &Path) {}
    fn run_silent_installer(&self, installer_exe: &Path) -> Result<(), InstallError> {
        if run_ok(Command::new(installer_exe).args([
            "/VERYSILENT",
            "/NORESTART",
            "/SUPPRESSMSGBOXES",
            "/MERGETASKS=!runcode",
        ])) {
            Ok(())
        } else {
            Err(InstallError(format!(
                "{} /VERYSILENT failed",
                installer_exe.display()
            )))
        }
    }
    fn verify_signature(&self, artifact: &Path) -> Result<(), SignatureError> {
        // See this file's module doc: PowerShell Get-AuthenticodeSignature
        // (exactly what install-blockless.ps1 already uses), not the
        // windows crate's WinVerifyTrust binding -- a deliberate,
        // flagged deviation, not a weaker check.
        let script = format!(
            // -LiteralPath, not the positional/-FilePath binding: -FilePath
            // is wildcard-capable, so a path containing `[`/`]` (legal in
            // a Windows username) would resolve as a character class
            // instead of matching itself literally -- same class as the
            // Expand-Archive fix above.
            "$sig = Get-AuthenticodeSignature -LiteralPath '{}'; \
             if ($sig.Status -ne 'Valid') {{ exit 1 }}; \
             if ($sig.SignerCertificate.Subject -notmatch 'O=Microsoft Corporation(,|$)') {{ exit 1 }}; \
             exit 0",
            ps_quote(artifact)
        );
        if run_ok(&mut powershell(&script)) {
            Ok(())
        } else {
            Err(SignatureError(format!(
                "{} is not authentically signed by Microsoft",
                artifact.display()
            )))
        }
    }
    fn remove_unverified_install(&self, _app_dir: &Path) -> Result<(), InstallError> {
        Ok(())
    }
}

impl ExtensionsRunner for WindowsEnvironment {
    fn list_extensions(&self, code_cli: &Path, profile_name: &str) -> Option<Vec<String>> {
        let out = stdout_of(Command::new(code_cli).args([
            "--profile",
            profile_name,
            "--list-extensions",
        ]))?;
        Some(
            out.lines()
                .filter(|l| !l.is_empty())
                .map(str::to_string)
                .collect(),
        )
    }
    fn install_extension(&self, code_cli: &Path, profile_name: &str, vsix_or_id: &str) -> bool {
        run_ok(Command::new(code_cli).args([
            "--profile",
            profile_name,
            "--install-extension",
            vsix_or_id,
            "--force",
        ]))
    }
}

impl RuntimeRunner for WindowsEnvironment {
    fn mpremote_version(&self, envpy: &Path) -> Option<String> {
        stdout_of(Command::new(envpy).args(["-m", "mpremote", "version"]))
    }
    fn uv_version(&self, uv_bin: &Path) -> Option<String> {
        stdout_of(Command::new(uv_bin).arg("--version"))
    }
    fn extract_uv(&self, archive: &Path, dest_dir: &Path) -> Result<(), String> {
        std::fs::create_dir_all(dest_dir).map_err(|e| e.to_string())?;
        let script = format!(
            // -LiteralPath, not -Path: -Path is wildcard-capable, so a
            // path containing `[`/`]` (legal in a Windows username, and
            // otherwise indistinguishable from an intentional glob)
            // would resolve as a character class instead of matching
            // itself literally.
            "Expand-Archive -LiteralPath '{}' -DestinationPath '{}' -Force",
            ps_quote(archive),
            ps_quote(dest_dir)
        );
        if !run_ok(&mut powershell(&script)) {
            return Err(format!("Expand-Archive {} failed", archive.display()));
        }
        relocate_binary_if_nested(dest_dir, "uv.exe")
    }
    fn run_uv(&self, uv_bin: &Path, args: &[&str], env: &[(&str, &str)]) -> bool {
        let mut cmd = Command::new(uv_bin);
        cmd.args(args);
        for (k, v) in env {
            cmd.env(k, v);
        }
        run_ok(&mut cmd)
    }
    /// Not a Windows concern: `install_name_tool` is a macOS tool and uv
    /// never reaches for it here. Answering true keeps the shim branch shut
    /// on this platform regardless of anything else.
    fn developer_tools_present(&self) -> bool {
        true
    }
}

impl UninstallRunner for WindowsEnvironment {
    fn remove_dir_all(&self, path: &Path) -> Result<(), String> {
        std::fs::remove_dir_all(path).map_err(|e| e.to_string())
    }
    fn run_vscode_uninstaller(&self, vscode_dir: &Path) -> Result<bool, String> {
        let unins = vscode_dir.join("unins000.exe");
        if !unins.exists() {
            return Ok(false);
        }
        if run_ok(Command::new(&unins).args(["/VERYSILENT", "/NORESTART", "/SUPPRESSMSGBOXES"])) {
            Ok(true)
        } else {
            Err(format!("{} /VERYSILENT failed", unins.display()))
        }
    }
}

/// See the mac module's `relocate_binary_if_nested`: same uncertainty,
/// same fallback (works whether `Expand-Archive` produced a flat or a
/// one-level-nested layout).
fn relocate_binary_if_nested(dest_dir: &Path, name: &str) -> Result<(), String> {
    if dest_dir.join(name).exists() {
        return Ok(());
    }
    let entries = std::fs::read_dir(dest_dir).map_err(|e| e.to_string())?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            let nested = path.join(name);
            if nested.exists() {
                std::fs::rename(&nested, dest_dir.join(name)).map_err(|e| e.to_string())?;
                return Ok(());
            }
        }
    }
    Err(format!(
        "{name} not found in the extracted archive at {} (neither flat nor one level nested)",
        dest_dir.display()
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ps_quote_doubles_embedded_single_quotes() {
        assert_eq!(
            ps_quote(Path::new(r"C:\Users\it's me\code")),
            r"C:\Users\it''s me\code"
        );
    }

    #[test]
    fn ps_quote_is_identity_on_a_quote_free_path() {
        assert_eq!(
            ps_quote(Path::new(r"C:\Users\normal\code")),
            r"C:\Users\normal\code"
        );
    }

    #[test]
    fn ps_quote_handles_multiple_quotes() {
        assert_eq!(ps_quote(Path::new("a'b'c")), "a''b''c");
    }
}
