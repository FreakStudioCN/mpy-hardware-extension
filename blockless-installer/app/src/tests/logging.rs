use super::*;
use crate::test_support::temp_path;

/// Regression test for the round-1 finding: `write` used to
/// `create_dir_all` the log directory on every call, which silently
/// put `BLK` back on disk the moment anything logged after
/// `ops::uninstall` had already removed it. A write against a
/// directory that does not exist must be dropped, not recreate it.
#[test]
fn a_write_after_the_logs_dir_is_gone_drops_the_line_and_never_recreates_it() {
    let logs_dir = temp_path("writer");
    let _ = std::fs::remove_dir_all(&logs_dir);
    assert!(!logs_dir.exists(), "test setup: must start absent");

    let mut writer = PerWriteFileWriter {
        logs_dir: logs_dir.clone(),
    };
    let written = std::io::Write::write(&mut writer, b"a log line\n").unwrap();

    assert_eq!(
        written, 11,
        "must report the full buffer written even on drop"
    );
    assert!(
        !logs_dir.exists(),
        "a write against a missing logs/ must never recreate it"
    );
}
