use super::*;

#[test]
fn bundled_vsix_defaults_relative_to_the_manifest() {
    assert_eq!(
        resolve_vsix_path(
            None,
            Path::new("bundle/installer.manifest.json"),
            "components/blockless.vsix",
        ),
        PathBuf::from("bundle/components/blockless.vsix")
    );
}

#[test]
fn explicit_vsix_override_wins_over_the_manifest() {
    assert_eq!(
        resolve_vsix_path(
            Some(Path::new("custom/blockless.vsix")),
            Path::new("bundle/installer.manifest.json"),
            "components/blockless.vsix",
        ),
        PathBuf::from("custom/blockless.vsix")
    );
}

#[test]
fn absolute_bundled_path_is_used_as_is() {
    assert_eq!(
        resolve_vsix_path(
            None,
            Path::new("bundle/installer.manifest.json"),
            "/opt/blockless/blockless.vsix",
        ),
        PathBuf::from("/opt/blockless/blockless.vsix")
    );
}

#[test]
fn default_manifest_path_sits_next_to_the_current_exe() {
    let exe = std::env::current_exe().unwrap();
    let expected = exe
        .parent()
        .map(|dir| dir.join("installer.manifest.json"))
        .unwrap();
    assert_eq!(default_manifest_path(), expected);
}

#[test]
fn mac_install_targets_orders_system_before_user_and_is_empty_on_windows() {
    let raw = RawEnv {
        home: Some("/Users/test".to_string()),
        ..Default::default()
    };
    assert_eq!(
        mac_install_targets(Os::MacOs, &raw),
        vec![
            PathBuf::from("/Applications"),
            PathBuf::from("/Users/test/Applications"),
        ]
    );
    assert_eq!(
        mac_install_targets(Os::Windows, &raw),
        Vec::<PathBuf>::new()
    );
}
