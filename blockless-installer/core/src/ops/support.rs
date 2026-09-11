use super::*;
use crate::uninstall::{self, UninstallFlags, UninstallOutcome};
use crate::verify::{self, VerifyInputs};
pub fn diagnostics(ctx: &OpsContext, target_zip: &Path) -> Result<(), OpsError> {
    info!(target = %target_zip.display(), "diagnostics: starting");
    let file = std::fs::File::create(target_zip).map_err(|e| {
        OpsError::Diagnostics(format!("could not create {}: {e}", target_zip.display()))
    })?;
    let mut writer = zip::ZipWriter::new(file);
    let options: zip::write::FileOptions<'_, ()> =
        zip::write::FileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    let zip_err = |e: zip::result::ZipError| OpsError::Diagnostics(e.to_string());
    let io_err = |e: std::io::Error| OpsError::Diagnostics(e.to_string());

    if ctx.paths.logs.is_dir() {
        let entries = std::fs::read_dir(&ctx.paths.logs).map_err(io_err)?;
        for entry in entries {
            let entry = entry.map_err(io_err)?;
            if !entry.file_type().map_err(io_err)?.is_file() {
                continue;
            }
            let name = entry.file_name();
            writer
                .start_file(format!("logs/{}", name.to_string_lossy()), options)
                .map_err(zip_err)?;
            let bytes = std::fs::read(entry.path()).map_err(io_err)?;
            std::io::Write::write_all(&mut writer, &bytes).map_err(io_err)?;
        }
    }

    if ctx.paths.state.is_file() {
        writer.start_file("state.json", options).map_err(zip_err)?;
        let bytes = std::fs::read(&ctx.paths.state).map_err(io_err)?;
        std::io::Write::write_all(&mut writer, &bytes).map_err(io_err)?;
    }

    writer
        .start_file("manifest.json", options)
        .map_err(zip_err)?;
    let manifest_bytes = serde_json::to_vec_pretty(ctx.manifest)
        .map_err(|e| OpsError::Diagnostics(e.to_string()))?;
    std::io::Write::write_all(&mut writer, &manifest_bytes).map_err(io_err)?;

    let facts = serde_json::json!({
        "os": match ctx.os { Os::MacOs => "macos", Os::Windows => "windows" },
        "arch": match ctx.arch { Arch::X64 => "x64", Arch::Arm64 => "arm64" },
        "installerVersion": ctx.manifest.installer_version,
    });
    writer.start_file("facts.json", options).map_err(zip_err)?;
    let facts_bytes =
        serde_json::to_vec_pretty(&facts).map_err(|e| OpsError::Diagnostics(e.to_string()))?;
    std::io::Write::write_all(&mut writer, &facts_bytes).map_err(io_err)?;

    writer.finish().map_err(zip_err)?;
    info!("diagnostics: finished");
    Ok(())
}

pub fn verify(env: &dyn Environment, ctx: &OpsContext) -> Vec<verify::CheckResult> {
    info!("verify: starting");
    let inputs = VerifyInputs {
        code_candidates: &ctx.code_candidates,
        profile_name: &ctx.manifest.profile_name,
        ext_id: &ctx.manifest.components.extension.id,
        py_ext_id: &ctx.manifest.components.python_extension.id,
        pylance_id: PYLANCE_ID,
        mpremote_version: &ctx.manifest.components.mpremote.version,
        blk: &ctx.paths.blk,
        code_user: &ctx.paths.code_user,
        state_path: &ctx.paths.state,
    };
    let results = verify::run_checks(env, env, env, &inputs);
    let failed = results.iter().filter(|r| !r.pass).count();
    if failed == 0 {
        info!(checks = results.len(), "verify: all checks passed");
    } else {
        warn!(checks = results.len(), failed, "verify: some checks failed");
    }
    results
}

pub fn uninstall(
    env: &dyn Environment,
    ctx: &OpsContext,
    flags: &UninstallFlags,
) -> UninstallOutcome {
    info!(
        all = flags.all,
        keep_vscode = flags.keep_vscode,
        "uninstall: starting"
    );
    let vscode_dirs = vscode_install_locations(ctx);
    let outcome = uninstall::uninstall(
        env,
        env,
        &ctx.paths.state,
        &ctx.paths.storage,
        &ctx.profiles_dir(),
        &ctx.manifest.profile_name,
        &ctx.paths.blk,
        &vscode_dirs,
        flags,
    );
    info!(outcome = ?outcome, "uninstall: finished");
    outcome
}

/// Every location this OS's install could plausibly have put VS Code, not
/// just whichever candidate happens to be runnable right now -- a broken or
/// stale `code` CLI must not leave a real install undetected by uninstall.
/// Mac: every `mac_install_targets` entry joined with the app bundle name
/// directly (matches `vscode.rs`'s own writability-fallback candidates
/// one-to-one, independent of runnability -- up to two real locations).
/// Windows: every `code_candidates` entry mapped through `vscode_app_root`
/// unconditionally, the same way -- there is only ever one Windows install
/// location, but it must not depend on `--version` succeeding either, or a
/// corrupt/half-deleted install with `vscodeInstalledByUs: true` is silently
/// left behind.
pub(super) fn vscode_install_locations(ctx: &OpsContext) -> Vec<PathBuf> {
    match ctx.os {
        Os::MacOs => ctx
            .mac_install_targets
            .iter()
            .map(|t| t.join("Visual Studio Code.app"))
            .collect(),
        Os::Windows => ctx
            .code_candidates
            .iter()
            .filter_map(|c| vscode_app_root(ctx.os, c))
            .collect(),
    }
}

/// The VS Code install root from its `code` CLI path: mac
/// `<target>/Visual Studio Code.app` (5 ancestors up from
/// `.../Contents/Resources/app/bin/code`); Windows
/// `<LOCALAPPDATA>/Programs/Microsoft VS Code` (2 ancestors up from
/// `.../bin/code.cmd`).
fn vscode_app_root(os: Os, code_cli: &Path) -> Option<PathBuf> {
    let up = match os {
        Os::MacOs => 5,
        Os::Windows => 2,
    };
    code_cli.ancestors().nth(up).map(Path::to_path_buf)
}
