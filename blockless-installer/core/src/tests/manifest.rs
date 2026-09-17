use super::*;

const COMMITTED_MANIFEST: &str = include_str!("../../../manifest/installer.manifest.json");
/// A REAL response, captured from `update.code.visualstudio.com` on the
/// macOS acceptance rig on 2026-09-09. It replaces a hand-authored
/// stand-in that had stood in for a real capture because no environment
/// with a route to that host had ever run this.
///
/// Worth keeping in mind when reading the assertions below: the previous
/// fixture asserted a shape nobody had ever observed, so the parse test
/// only proved the parser agreed with its author. This one carries a field
/// that stand-in did not have -- `notes` -- which is exactly the kind of
/// difference an invented fixture cannot surface.
///
/// Version-specific values here go stale with every VS Code release. That
/// is fine and intended: this fixture pins the SHAPE, and
/// `live_update_api.rs`'s rig-only ignored test is what checks the live
/// response still matches it.
const CAPTURED_UPDATE_API: &str =
    include_str!("../../tests/fixtures/vscode-update-api.darwin-universal.json");

#[test]
fn committed_manifest_parses_and_validates() {
    let manifest = Manifest::parse(COMMITTED_MANIFEST).expect("committed manifest is valid");
    assert_eq!(manifest.schema_version, 1);
    assert_eq!(manifest.profile_name, "Blockless");
    assert_eq!(manifest.components.uv.version, "0.11.29");
    assert_eq!(manifest.components.mpremote.version, "1.28.0");
    assert_eq!(manifest.components.python.series, "3.12");
    assert_eq!(manifest.components.extension.version, "0.4.3");
    assert_eq!(manifest.components.python_extension.id, "ms-python.python");
}

/// `components.uv.sha256.*` (all 4 platforms) now carry the real uv
/// 0.11.29 checksums, fetched from each asset's published `.sha256` file
/// at `github.com/astral-sh/uv/releases/download/0.11.29/` and
/// independently re-verified against a downloaded archive. Only
/// `components.extension.sha256` stays a deliberate all-zero
/// placeholder -- the real VSIX build is stamped later, by
/// `mpy-hardware-extension/scripts/stamp-installer-manifest.mjs`, never
/// by hand here. This test is the canary for BOTH groups: it fails the
/// moment any single pin is silently changed (a real uv value swapped
/// for a different one, or the extension placeholder accidentally
/// stamped) without this test being updated to match -- see
/// `extension.sha256`'s equivalent ops-level canary in
/// `ops::tests::install_against_the_unmodified_committed_manifest_refuses_the_real_vsix`.
#[test]
fn committed_manifest_sha256_pins_are_the_documented_values() {
    let manifest = Manifest::parse(COMMITTED_MANIFEST).unwrap();
    assert_eq!(
        manifest.components.uv.sha256.darwin_aarch64,
        "61c04acc52a33ef0f331e494bdfbedcdb6c26c6970c022ed3699e5860f8930e3"
    );
    assert_eq!(
        manifest.components.uv.sha256.darwin_x86_64,
        "c4c4de482da9ccdd076dc4fb5cfe7b740609029385c72f58606be3153602387d"
    );
    assert_eq!(
        manifest.components.uv.sha256.win32_x64,
        "a047d55651bc3e0ca24595b25ec4cfcb10f9dca9fb56514e661269b37d4fae68"
    );
    assert_eq!(
        manifest.components.uv.sha256.win32_arm64,
        "55b597ae81bc29531a7c352a1431a8a73cc2755d7a5b9ec454580cbe02e5154f"
    );
    assert_eq!(manifest.components.extension.sha256, "0".repeat(64));
}

#[test]
fn parses_every_source_kind() {
    let manifest = Manifest::parse(COMMITTED_MANIFEST).unwrap();
    assert_eq!(manifest.components.vscode.source, Source::Download);
    assert_eq!(manifest.components.uv.source, Source::Download);
    assert_eq!(manifest.components.python.source, Source::Managed);
    assert_eq!(manifest.components.mpremote.source, Source::Pip);
    assert_eq!(manifest.components.extension.source, Source::Bundled);
    assert_eq!(
        manifest.components.python_extension.source,
        Source::Marketplace
    );
}

#[test]
fn rejects_unknown_source() {
    let json = COMMITTED_MANIFEST.replacen(r#""source": "pip""#, r#""source": "torrent""#, 1);
    let err = Manifest::parse(&json).unwrap_err();
    assert!(matches!(err, ManifestError::Parse(_)), "got {err:?}");
}

#[test]
fn rejects_source_wrong_for_its_slot() {
    // Syntactically valid ("marketplace" is a real Source), but wrong for
    // this slot: our extension must always be bundled, never Marketplace
    // (ARCHITECTURE §6 -- installing a same-numbered-but-different build
    // from the Marketplace is the exact regression this manifest guards).
    let json = COMMITTED_MANIFEST.replacen(
        r#""extension": {
      "source": "bundled","#,
        r#""extension": {
      "source": "marketplace","#,
        1,
    );
    assert_ne!(json, COMMITTED_MANIFEST, "replacement did not match");
    let err = Manifest::parse(&json).unwrap_err();
    match err {
        ManifestError::UnexpectedSource {
            component,
            expected,
            got,
        } => {
            assert_eq!(component, "extension");
            assert_eq!(expected, "bundled");
            assert_eq!(got, "marketplace");
        }
        other => panic!("expected UnexpectedSource, got {other:?}"),
    }
}

#[test]
fn rejects_unsupported_schema_version() {
    let json = COMMITTED_MANIFEST.replacen(r#""schemaVersion": 1"#, r#""schemaVersion": 2"#, 1);
    let err = Manifest::parse(&json).unwrap_err();
    assert!(
        matches!(err, ManifestError::UnsupportedSchemaVersion(2)),
        "got {err:?}"
    );
}

#[test]
fn rejects_missing_required_field() {
    let json = COMMITTED_MANIFEST.replacen(r#""profileName": "Blockless","#, "", 1);
    let err = Manifest::parse(&json).unwrap_err();
    assert!(matches!(err, ManifestError::Parse(_)), "got {err:?}");
}

#[test]
fn rejects_malformed_sha256() {
    let json = COMMITTED_MANIFEST.replacen(
        r#""win32-arm64": "55b597ae81bc29531a7c352a1431a8a73cc2755d7a5b9ec454580cbe02e5154f""#,
        r#""win32-arm64": "not-hex""#,
        1,
    );
    let err = Manifest::parse(&json).unwrap_err();
    match err {
        ManifestError::InvalidSha256 { field, .. } => {
            assert_eq!(field, "uv.sha256.win32-arm64");
        }
        other => panic!("expected InvalidSha256, got {other:?}"),
    }
}

#[test]
fn resolver_parses_the_captured_response() {
    // A real captured response now, so this proves the parser handles what
    // the API actually sends, which the hand-authored stand-in could not.
    // It is still not proof the LIVE response matches today -- that is
    // `live_update_api.rs`'s rig-only ignored test.
    let resp = VscodeUpdateApiResponse::parse(CAPTURED_UPDATE_API).unwrap();
    assert_eq!(resp.product_version, "1.136.2");
    assert!(resp.url.starts_with("https://"));
    // A real 64-hex digest, unlike the stand-in's deliberate all-zeros.
    // Asserted by shape, not by value: the point is that the parser reads
    // a genuine digest through, and pinning the literal would only mean
    // re-editing this test on every VS Code release.
    assert_eq!(resp.sha256_hash.len(), 64);
    assert!(
        resp.sha256_hash.chars().all(|c| c.is_ascii_hexdigit()),
        "sha256hash should be hex, got {}",
        resp.sha256_hash
    );
    assert_ne!(
        resp.sha256_hash,
        "0".repeat(64),
        "this fixture is a real capture; all-zeros would mean the stand-in came back"
    );
}

#[test]
fn update_api_url_uses_the_right_platform_slug() {
    let manifest = Manifest::parse(COMMITTED_MANIFEST).unwrap();
    let vscode = &manifest.components.vscode;
    assert_eq!(
        vscode.update_api_url(Os::MacOs, Arch::Arm64),
        "https://update.code.visualstudio.com/api/update/darwin-universal/stable/latest"
    );
    assert_eq!(
        vscode.update_api_url(Os::MacOs, Arch::X64),
        "https://update.code.visualstudio.com/api/update/darwin-universal/stable/latest"
    );
    assert_eq!(
        vscode.update_api_url(Os::Windows, Arch::X64),
        "https://update.code.visualstudio.com/api/update/win32-x64-user/stable/latest"
    );
    assert_eq!(
        vscode.update_api_url(Os::Windows, Arch::Arm64),
        "https://update.code.visualstudio.com/api/update/win32-arm64-user/stable/latest"
    );
}

#[test]
fn uv_platform_key_matches_the_running_target() {
    assert_eq!(
        UvPlatformKey::for_target(Os::MacOs, Arch::Arm64),
        UvPlatformKey::DarwinAarch64
    );
    assert_eq!(
        UvPlatformKey::for_target(Os::MacOs, Arch::X64),
        UvPlatformKey::DarwinX8664
    );
    assert_eq!(
        UvPlatformKey::for_target(Os::Windows, Arch::X64),
        UvPlatformKey::Win32X64
    );
    assert_eq!(
        UvPlatformKey::for_target(Os::Windows, Arch::Arm64),
        UvPlatformKey::Win32Arm64
    );
}

#[test]
fn uv_download_url_embeds_the_manifest_version_and_right_asset() {
    let manifest = Manifest::parse(COMMITTED_MANIFEST).unwrap();
    let uv = &manifest.components.uv;
    assert_eq!(
        uv.download_url(UvPlatformKey::DarwinAarch64),
        "https://github.com/astral-sh/uv/releases/download/0.11.29/uv-aarch64-apple-darwin.tar.gz"
    );
    assert_eq!(
        uv.download_url(UvPlatformKey::Win32X64),
        "https://github.com/astral-sh/uv/releases/download/0.11.29/uv-x86_64-pc-windows-msvc.zip"
    );
}

#[test]
fn uv_sha256_for_looks_up_the_matching_platform() {
    let manifest = Manifest::parse(COMMITTED_MANIFEST).unwrap();
    let uv = &manifest.components.uv;
    assert_eq!(
        uv.sha256_for(UvPlatformKey::DarwinX8664),
        uv.sha256.darwin_x86_64
    );
    assert_eq!(
        uv.sha256_for(UvPlatformKey::Win32Arm64),
        uv.sha256.win32_arm64
    );
}
