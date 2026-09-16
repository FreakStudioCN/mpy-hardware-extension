use super::*;

/// `install` = `repair` (steps 1, 2, 4) plus step 3 (runtime) plus the final
/// foreground open. Steps run in the M0 order (1, 2, 3, 4), not repair's
/// (1, 2, 4) then 3 tacked on, so a fresh machine's env_python already
/// exists by the time step 4 writes `mpyhw.pythonPath`.
pub fn install(env: &dyn Environment, ctx: &OpsContext) -> Result<State, OpsError> {
    info!("install: starting");
    ctx.progress
        .emit(&ProgressEvent::OpStarted { op: "install" });
    require_vsix(ctx)?;
    let prior = read_prior_state_lenient(&ctx.paths.state);
    let seed = state::seed_from_prior(prior.as_ref(), "blockless");
    let mut current = prior.unwrap_or_default();
    // `install` always re-attempts all four steps, unlike `repair`/
    // `repair_runtime` which intentionally touch only a subset -- so unlike
    // those, a prior journal's step flags carry no meaning for THIS run and
    // must not survive into it. Without this reset, an incremental write
    // from an early step (still holding the stale prior flags for steps not
    // yet reached) can leave e.g. a stale `steps.python: true` on disk if
    // this run then dies before actually re-verifying that step.
    current.steps = state::Steps::default();
    current.profile_location = seed.profile_location.clone();
    current.mpremote_version = ctx.manifest.components.mpremote.version.clone();
    current.env_python = ctx.paths.env_python.to_string_lossy().into_owned();

    ctx.progress.emit(&ProgressEvent::StepStarted {
        op: "install",
        step: 1,
        name: "vscode",
    });
    let vscode_outcome = vscode::ensure_vscode(
        env,
        &ctx.client,
        ctx.os,
        &ctx.code_candidates,
        &ctx.mac_install_targets,
        &ctx.update_api_url(),
        &ctx.paths.downloads,
        &ctx.fetch_opts,
    )
    .inspect_err(|e| warn!(error = %e, "install: step 1 (vscode) failed"))?;
    current.product_version = vscode_outcome.product_version.clone();
    current.vscode_installed_by_us = seed.vscode_installed_by_us || vscode_outcome.installed_by_us;
    current.steps.vscode = true;
    stamp_and_write(&mut current, &ctx.paths.state)?;
    log_version_mismatch("install", &vscode_outcome);
    info!(
        skipped = !vscode_outcome.installed_by_us,
        "install: step 1 (vscode) done"
    );
    ctx.progress.emit(&ProgressEvent::StepFinished {
        op: "install",
        step: 1,
        name: "vscode",
        skipped: Some(!vscode_outcome.installed_by_us),
    });

    ctx.progress.emit(&ProgressEvent::StepStarted {
        op: "install",
        step: 2,
        name: "extension",
    });
    let ext_outcome = extensions::ensure_extensions(
        env,
        env,
        &vscode_outcome.code_cli,
        &ctx.paths.storage,
        &ctx.profiles_dir(),
        &ctx.manifest.profile_name,
        "blockless",
        &ctx.manifest.components.extension.id,
        &ctx.manifest.components.python_extension.id,
        PYLANCE_ID,
        ctx.vsix_path.as_deref(),
        &ctx.manifest.components.extension.sha256,
        &seed.prior_ext_vsix_sha256,
        seed.profile_created_by_us,
        false,
    )
    .inspect_err(|e| warn!(error = %e, "install: step 2 (extension) failed"))?;
    current.profile_created_by_us = ext_outcome.profile_created_by_us;
    current.ext_vsix_sha256 = ext_outcome.ext_vsix_sha256;
    current.steps.extension = true;
    if let Some(loc) =
        profile::resolve_profile_location(&ctx.paths.storage, &ctx.manifest.profile_name)
    {
        current.profile_location = loc;
    }
    stamp_and_write(&mut current, &ctx.paths.state)?;
    info!(
        skipped = ext_outcome.already_current,
        "install: step 2 (extension) done"
    );
    ctx.progress.emit(&ProgressEvent::StepFinished {
        op: "install",
        step: 2,
        name: "extension",
        skipped: Some(ext_outcome.already_current),
    });

    ctx.progress.emit(&ProgressEvent::StepStarted {
        op: "install",
        step: 3,
        name: "runtime",
    });
    let runtime_outcome = runtime::ensure_runtime(
        env,
        &ctx.client,
        ctx.os,
        ctx.arch,
        &ctx.manifest.components.uv,
        &ctx.manifest.components.python.series,
        &ctx.manifest.components.mpremote.version,
        &ctx.paths.blk,
        &ctx.paths.env_python,
        &ctx.paths.downloads,
        &ctx.fetch_opts,
    )
    .inspect_err(|e| warn!(error = %e, "install: step 3 (runtime) failed"))?;
    current.steps.python = true;
    stamp_and_write(&mut current, &ctx.paths.state)?;
    let runtime_skipped = runtime_outcome == RuntimeStepOutcome::AlreadyPresent;
    info!(skipped = runtime_skipped, "install: step 3 (runtime) done");
    ctx.progress.emit(&ProgressEvent::StepFinished {
        op: "install",
        step: 3,
        name: "runtime",
        skipped: Some(runtime_skipped),
    });

    ctx.progress.emit(&ProgressEvent::StepStarted {
        op: "install",
        step: 4,
        name: "settings",
    });
    let settings_outcome = settings::ensure_settings(
        env,
        &vscode_outcome.code_cli,
        &ctx.paths.storage,
        &ctx.profiles_dir(),
        &ctx.manifest.profile_name,
        "blockless",
        &ctx.paths.env_python,
        &ctx.manifest.settings,
    )
    .inspect_err(|e| warn!(error = %e, "install: step 4 (settings) failed"))?;
    current.profile_location = settings_outcome.profile_location;
    current.settings_mechanism = "A".to_string();
    current.steps.settings = true;
    stamp_and_write(&mut current, &ctx.paths.state)?;
    info!(
        applied = settings_outcome.applied,
        "install: step 4 (settings) done"
    );
    ctx.progress.emit(&ProgressEvent::StepFinished {
        op: "install",
        step: 4,
        name: "settings",
        skipped: Some(!settings_outcome.applied),
    });

    // Final: foreground open into the profile. Every earlier step that
    // spawned a child of its own (register_profile's window fallback) has
    // already closed it before returning, so this is always a fresh
    // extension host -- never an attach to a lingering child, never the
    // user's own session.
    if let Err(e) = env.spawn(
        &vscode_outcome.code_cli,
        &["--profile", &ctx.manifest.profile_name, "--new-window"],
    ) {
        warn!(error = %e, "install: final foreground open failed to spawn");
    }
    info!("install: finished");
    ctx.progress
        .emit(&ProgressEvent::OpFinished { op: "install" });

    Ok(current)
}
