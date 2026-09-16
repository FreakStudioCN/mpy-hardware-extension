//! Shared by every test module in this crate.

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

/// A unique path for one test's fixture, NOT created: some tests need
/// their directory to start absent. The process id and the counter
/// together keep two concurrent test binaries, and two tests in one
/// binary, off each other's fixtures. Same shape as the core suites' own
/// helper.
///
/// A fixed name under the system temp directory looks harmless and is
/// not: a second process removing, rewriting or chmod-ing the same path
/// makes a test fail intermittently, or pass against the wrong state.
pub(crate) fn temp_path(name: &str) -> PathBuf {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    std::env::temp_dir().join(format!(
        "blockless-installer-gui-test-{name}-{}-{n}",
        std::process::id()
    ))
}
