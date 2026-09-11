use super::*;
/// Remove `env/` first, then re-run step 3 -- deterministic rather than
/// trusting `uv`'s own detect-and-reuse over a possibly-broken existing
/// venv. Steps 1/2/4 are untouched.
pub fn repair_runtime(env: &dyn Environment, ctx: &OpsContext) -> Result<State, OpsError> {
    info!("repair-runtime: starting");
    let prior = read_prior_state_lenient(&ctx.paths.state);
    let mut current = prior.unwrap_or_default();

    let env_dir = ctx.paths.blk.join("env");
    if env_dir.exists() {
        env.remove_dir_all(&env_dir)
            .map_err(|reason| OpsError::RemoveEnv {
                path: env_dir.clone(),
                reason,
            })
            .inspect_err(|e| warn!(error = %e, "repair-runtime: could not remove env/"))?;
        info!("repair-runtime: removed existing env/");
    }

    runtime::ensure_runtime(
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
    .inspect_err(|e| warn!(error = %e, "repair-runtime: step 3 (runtime) failed"))?;
    current.mpremote_version = ctx.manifest.components.mpremote.version.clone();
    current.env_python = ctx.paths.env_python.to_string_lossy().into_owned();
    current.steps.python = true;
    stamp_and_write(&mut current, &ctx.paths.state)?;
    info!("repair-runtime: step 3 (runtime) done");

    Ok(current)
}
