use super::*;
#[test]
fn windows_uninstall_removes_a_broken_install_version_check_fails() {
    // End-to-end: `ops::uninstall` on Windows, with `vscodeInstalledByUs`
    // true and the install directory present on disk, but the `code` CLI
    // no longer runs (`version()` returns `None`) -- the install must
    // still be found and removed, not silently left behind with
    // `vscode_removed: false`.
    let dir = temp_dir("windows-uninstall-broken");
    let manifest = test_manifest();
    let vsix = write_vsix(&dir, b"vsix contents");
    let mut ctx = make_ctx(&dir, &manifest, &vsix);
    ctx.os = Os::Windows;
    let vscode_dir = dir
        .join("LOCALAPPDATA")
        .join("Programs")
        .join("Microsoft VS Code");
    let code_cli = vscode_dir.join("bin").join("code.cmd");
    ctx.code_candidates = vec![code_cli.clone()];
    ctx.mac_install_targets = vec![];
    std::fs::create_dir_all(&vscode_dir).unwrap();

    let state = State {
        vscode_installed_by_us: true,
        profile_created_by_us: false,
        ..Default::default()
    };
    state.write(&ctx.paths.state).unwrap();

    let env = FakeEnvironment::new(&code_cli, &vsix);
    *env.vscode_version.borrow_mut() = None; // the broken CLI: --version fails

    let outcome = uninstall(&env, &ctx, &UninstallFlags::default());

    match outcome {
        UninstallOutcome::Finished { vscode_removed, .. } => {
            assert!(vscode_removed, "a broken-CLI install must still be removed")
        }
        other => panic!("expected Finished, got {other:?}"),
    }
    assert!(!vscode_dir.exists());
}
