use super::*;
pub fn update_extension(env: &dyn Environment, ctx: &OpsContext) -> Result<State, OpsError> {
    info!("update-extension: starting");
    require_vsix(ctx)?;
    let prior = read_prior_state_lenient(&ctx.paths.state);
    let seed = state::seed_from_prior(prior.as_ref(), "blockless");
    let mut current = prior.unwrap_or_default();

    let code_cli = ctx
        .code_candidates
        .iter()
        .find(|c| env.version(c).is_some())
        .cloned()
        .unwrap_or_else(|| ctx.code_candidates[0].clone());

    let ext_outcome = extensions::ensure_extensions(
        env,
        env,
        &code_cli,
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
        true, // force: bypass the sha-match skip
    )
    .inspect_err(|e| warn!(error = %e, "update-extension: step 2 (extension) failed"))?;
    current.profile_created_by_us = ext_outcome.profile_created_by_us;
    current.ext_vsix_sha256 = ext_outcome.ext_vsix_sha256;
    current.steps.extension = true;
    stamp_and_write(&mut current, &ctx.paths.state)?;
    info!("update-extension: step 2 (extension) done");

    Ok(current)
}
