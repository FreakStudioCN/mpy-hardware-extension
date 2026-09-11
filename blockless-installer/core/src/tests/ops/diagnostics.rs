use super::*;
#[test]
fn diagnostics_bundle_contains_expected_entries() {
    let dir = temp_dir("diagnostics");
    let manifest = test_manifest();
    let vsix = write_vsix(&dir, b"vsix contents");
    let ctx = make_ctx(&dir, &manifest, &vsix);
    std::fs::create_dir_all(&ctx.paths.logs).unwrap();
    std::fs::write(ctx.paths.logs.join("install.log"), b"log contents").unwrap();
    std::fs::create_dir_all(&ctx.paths.blk).unwrap();
    State::default().write(&ctx.paths.state).unwrap();

    let zip_path = dir.join("diagnostics.zip");
    diagnostics(&ctx, &zip_path).unwrap();

    let file = std::fs::File::open(&zip_path).unwrap();
    let mut archive = zip::ZipArchive::new(file).unwrap();
    let names: Vec<String> = (0..archive.len())
        .map(|i| archive.by_index(i).unwrap().name().to_string())
        .collect();
    assert!(names.contains(&"logs/install.log".to_string()), "{names:?}");
    assert!(names.contains(&"state.json".to_string()), "{names:?}");
    assert!(names.contains(&"manifest.json".to_string()), "{names:?}");
    assert!(names.contains(&"facts.json".to_string()), "{names:?}");

    let mut facts_file = archive.by_name("facts.json").unwrap();
    let mut facts_content = String::new();
    std::io::Read::read_to_string(&mut facts_file, &mut facts_content).unwrap();
    let facts: serde_json::Value = serde_json::from_str(&facts_content).unwrap();
    assert_eq!(facts["os"], "macos");
    assert_eq!(facts["arch"], "arm64");
}
