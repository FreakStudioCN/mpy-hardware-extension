#![cfg(any(target_os = "macos", target_os = "windows"))]
//! Rig-only: does the REAL `running_vscode_pids` see a REAL running VS Code?
//!
//! Every other test of this trait injects a fake. That is what makes the logic
//! testable, and it is exactly why the real macOS implementation was broken from
//! M0 onward without a single test noticing: it searched for
//! `.../Contents/MacOS/Electron`, which matches nothing, so it always returned
//! an empty vec and every guard keyed on it was inert. `uninstall` never refused
//! while VS Code was running, the profile seed never skipped, and the settings
//! writer's "never write while VS Code is running" rule never held -- around
//! `storage.json`, which holds every profile and window state the user has.
//!
//! Observed on a real macOS VM before the fix: uninstall removed the profile
//! with two VS Code windows open, and VS Code recreated it underneath.
//!
//! `#[ignore]`d because it needs a machine with VS Code installed AND running,
//! which no CI runner has. Run it on the acceptance rig, with VS Code open:
//!
//!     cargo test --test live_vscode_running -- --ignored --nocapture

use blockless_installer_core::profile::CommandRunner;
use blockless_installer_core::system::SystemEnvironment;

#[test]
#[ignore = "needs VS Code installed AND running; run explicitly on the acceptance rig"]
fn real_running_vscode_is_detected() {
    let pids = SystemEnvironment
        .running_vscode_pids()
        .expect("the real VS Code process query must succeed");
    println!("running_vscode_pids() -> {pids:?}");
    assert!(
        !pids.is_empty(),
        "the real detector found no VS Code processes. Either VS Code is not \
         actually running (this test requires it to be open), or the detector is \
         broken again. It has been broken before: the pattern must match the app \
         BUNDLE, because macOS will not let pgrep -f read the hardened main \
         process's argv, so anything aimed at the main executable finds nothing."
    );
}

#[test]
#[ignore = "needs VS Code CLOSED; the negative half, run explicitly on the rig"]
fn no_vscode_running_is_reported_as_none() {
    let pids = SystemEnvironment
        .running_vscode_pids()
        .expect("the real VS Code process query must succeed");
    println!("running_vscode_pids() -> {pids:?}");
    assert!(
        pids.is_empty(),
        "the detector reported VS Code as running while it should be closed: \
         {pids:?}. A pattern loose enough to match something else would make \
         uninstall refuse forever, which is the opposite failure and just as bad."
    );
}
