use super::*;

fn mac_env(home: &str) -> RawEnv {
    RawEnv {
        target_os: "macos".to_string(),
        target_arch: "aarch64".to_string(),
        home: Some(home.to_string()),
        ..Default::default()
    }
}

fn windows_env(appdata: &str, local_appdata: &str) -> RawEnv {
    RawEnv {
        target_os: "windows".to_string(),
        target_arch: "x86_64".to_string(),
        appdata: Some(appdata.to_string()),
        local_appdata: Some(local_appdata.to_string()),
        processor_architecture: Some("AMD64".to_string()),
        ..Default::default()
    }
}

#[test]
fn detects_macos() {
    let raw = mac_env("/Users/erson");
    assert_eq!(Os::detect(&raw), Ok(Os::MacOs));
}

#[test]
fn detects_windows() {
    let raw = windows_env(
        r"C:\Users\erson\AppData\Roaming",
        r"C:\Users\erson\AppData\Local",
    );
    assert_eq!(Os::detect(&raw), Ok(Os::Windows));
}

#[test]
fn rejects_unsupported_os() {
    let raw = RawEnv {
        target_os: "linux".to_string(),
        ..Default::default()
    };
    assert_eq!(
        Os::detect(&raw),
        Err(PlatformError::UnsupportedOs("linux".to_string()))
    );
}

#[test]
fn mac_paths_are_under_home() {
    let raw = mac_env("/Users/erson");
    let paths = Paths::resolve(Os::MacOs, &raw).unwrap();
    let home = PathBuf::from("/Users/erson");
    let blk = home
        .join("Library")
        .join("Application Support")
        .join("Blockless");
    assert_eq!(paths.blk, blk);
    assert_eq!(paths.downloads, blk.join("downloads"));
    assert_eq!(paths.logs, blk.join("logs"));
    assert_eq!(paths.state, blk.join("state.json"));
    assert_eq!(paths.env_python, blk.join("env").join("bin").join("python"));
    let code_user = home
        .join("Library")
        .join("Application Support")
        .join("Code")
        .join("User");
    assert_eq!(paths.code_user, code_user);
    assert_eq!(
        paths.storage,
        code_user.join("globalStorage").join("storage.json")
    );
}

#[test]
fn mac_paths_missing_home_errors() {
    let raw = RawEnv {
        target_os: "macos".to_string(),
        ..Default::default()
    };
    assert_eq!(
        Paths::resolve(Os::MacOs, &raw),
        Err(PlatformError::MissingEnvVar("HOME"))
    );
}

#[test]
fn windows_paths_split_appdata_from_local_appdata() {
    let appdata = r"C:\Users\erson\AppData\Roaming";
    let local_appdata = r"C:\Users\erson\AppData\Local";
    let raw = windows_env(appdata, local_appdata);
    let paths = Paths::resolve(Os::Windows, &raw).unwrap();
    let blk = PathBuf::from(local_appdata).join("Blockless");
    assert_eq!(paths.blk, blk);
    assert_eq!(paths.downloads, blk.join("downloads"));
    assert_eq!(paths.logs, blk.join("logs"));
    assert_eq!(paths.state, blk.join("state.json"));
    assert_eq!(
        paths.env_python,
        blk.join("env").join("Scripts").join("python.exe")
    );
    let code_user = PathBuf::from(appdata).join("Code").join("User");
    assert_eq!(paths.code_user, code_user);
    assert_eq!(
        paths.storage,
        code_user.join("globalStorage").join("storage.json")
    );
}

#[test]
fn windows_paths_missing_local_appdata_errors() {
    let raw = RawEnv {
        target_os: "windows".to_string(),
        appdata: Some(r"C:\Users\erson\AppData\Roaming".to_string()),
        ..Default::default()
    };
    assert_eq!(
        Paths::resolve(Os::Windows, &raw),
        Err(PlatformError::MissingEnvVar("LOCALAPPDATA"))
    );
}

#[test]
fn windows_paths_missing_appdata_errors() {
    let raw = RawEnv {
        target_os: "windows".to_string(),
        local_appdata: Some(r"C:\Users\erson\AppData\Local".to_string()),
        ..Default::default()
    };
    assert_eq!(
        Paths::resolve(Os::Windows, &raw),
        Err(PlatformError::MissingEnvVar("APPDATA"))
    );
}

#[test]
fn mac_code_cli_candidates_prefer_applications_then_home() {
    let raw = mac_env("/Users/erson");
    let candidates = code_cli_candidates(Os::MacOs, &raw).unwrap();
    assert_eq!(
        candidates,
        vec![
            PathBuf::from("/Applications")
                .join("Visual Studio Code.app")
                .join("Contents")
                .join("Resources")
                .join("app")
                .join("bin")
                .join("code"),
            PathBuf::from("/Users/erson")
                .join("Applications")
                .join("Visual Studio Code.app")
                .join("Contents")
                .join("Resources")
                .join("app")
                .join("bin")
                .join("code"),
        ]
    );
}

#[test]
fn windows_code_cli_candidate_is_under_local_appdata() {
    let local_appdata = r"C:\Users\erson\AppData\Local";
    let raw = windows_env(r"C:\Users\erson\AppData\Roaming", local_appdata);
    let candidates = code_cli_candidates(Os::Windows, &raw).unwrap();
    assert_eq!(
        candidates,
        vec![PathBuf::from(local_appdata)
            .join("Programs")
            .join("Microsoft VS Code")
            .join("bin")
            .join("code.cmd")]
    );
}

#[test]
fn windows_arch_reads_processor_architecture_arm64() {
    let raw = RawEnv {
        target_os: "windows".to_string(),
        processor_architecture: Some("ARM64".to_string()),
        ..Default::default()
    };
    assert_eq!(Arch::detect(Os::Windows, &raw), Ok(Arch::Arm64));
}

#[test]
fn windows_arch_reads_processor_architecture_amd64() {
    let raw = RawEnv {
        target_os: "windows".to_string(),
        processor_architecture: Some("AMD64".to_string()),
        ..Default::default()
    };
    assert_eq!(Arch::detect(Os::Windows, &raw), Ok(Arch::X64));
}

#[test]
fn windows_arch_missing_processor_architecture_errors() {
    let raw = RawEnv {
        target_os: "windows".to_string(),
        ..Default::default()
    };
    assert_eq!(
        Arch::detect(Os::Windows, &raw),
        Err(PlatformError::MissingEnvVar("PROCESSOR_ARCHITECTURE"))
    );
}

#[test]
fn mac_arch_never_consults_processor_architecture() {
    // A macOS process would never see PROCESSOR_ARCHITECTURE set, but even if
    // it were (e.g. carried over from a cross-build harness), mac arch must
    // come from the process's own arch, never that Windows-only variable.
    let raw = RawEnv {
        target_os: "macos".to_string(),
        target_arch: "x86_64".to_string(),
        processor_architecture: Some("ARM64".to_string()),
        ..Default::default()
    };
    assert_eq!(Arch::detect(Os::MacOs, &raw), Ok(Arch::X64));
}

#[test]
fn mac_arch_detects_arm64() {
    let raw = RawEnv {
        target_os: "macos".to_string(),
        target_arch: "aarch64".to_string(),
        ..Default::default()
    };
    assert_eq!(Arch::detect(Os::MacOs, &raw), Ok(Arch::Arm64));
}
