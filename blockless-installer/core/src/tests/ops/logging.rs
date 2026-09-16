//! What `ops` writes to the log, as a support engineer would read it.

use super::*;

/// A `tracing` writer that captures formatted output into a shared
/// buffer, so a test can assert on log content.
#[derive(Clone, Default)]
pub(super) struct CapturingWriter(pub(super) std::sync::Arc<std::sync::Mutex<Vec<u8>>>);
impl std::io::Write for CapturingWriter {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(buf);
        Ok(buf.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}
impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for CapturingWriter {
    type Writer = CapturingWriter;
    fn make_writer(&'a self) -> Self::Writer {
        self.clone()
    }
}

/// The one `tracing` subscriber every log-capturing test in this module
/// shares, installed at most once process-wide.
///
/// `cargo test`'s default parallel runner has many OTHER tests calling
/// `install`/`repair` concurrently on other threads, sharing these same
/// `info!`/`warn!` callsites. A THREAD-LOCAL subscriber
/// (`tracing::subscriber::with_default`) loses this race: a callsite's
/// process-wide interest is cached on first-ever use, and a concurrent
/// thread still running under the no-op default can win that race and
/// cache it "not interested" out from under a test -- empirically,
/// roughly 1 run in 3 under the full suite. A single global default
/// instead makes every callsite's interest resolve once, globally, with
/// no thread-local toggling and thus no window for the race.
///
/// Only the FIRST caller's `try_init` actually succeeds (global default
/// can only be set once per process); every caller gets back a clone of
/// the SAME shared writer regardless of which one won, via `OnceLock`,
/// so which log-capturing test happens to run first doesn't matter --
/// they all observe the one real subscriber. Other, non-capturing
/// parallel tests free-ride on it harmlessly (their lines just add
/// noise a `contains` check ignores).
pub(super) fn capturing_log_writer() -> CapturingWriter {
    static WRITER: std::sync::OnceLock<CapturingWriter> = std::sync::OnceLock::new();
    WRITER
        .get_or_init(|| {
            let writer = CapturingWriter::default();
            let _ = tracing_subscriber::fmt()
                .with_writer(writer.clone())
                .with_ansi(false)
                .try_init();
            writer
        })
        .clone()
}

#[test]
fn install_logs_every_step() {
    // Proves ops.rs actually emits a log line per step (the reviewer's
    // finding: nothing logged, so diagnostics bundled an empty logs/),
    // not just that the tracing macro calls compile.
    let writer = capturing_log_writer();

    let dir = temp_dir("install-logs");
    let manifest = test_manifest_matching(b"vsix contents");
    let vsix = write_vsix(&dir, b"vsix contents");
    let ctx = make_ctx(&dir, &manifest, &vsix);
    let env = FakeEnvironment::new(&ctx.code_candidates[0], &vsix);

    let before = writer.0.lock().unwrap().len();
    install(&env, &ctx).unwrap();
    let logged = String::from_utf8(writer.0.lock().unwrap()[before..].to_vec()).unwrap();
    for expected in [
        "install: starting",
        "install: step 1 (vscode) done skipped=true",
        "install: step 2 (extension) done",
        "install: step 3 (runtime) done",
        "install: step 4 (settings) done applied=true",
        "install: finished",
    ] {
        assert!(
            logged.contains(expected),
            "missing {expected:?} in:\n{logged}"
        );
    }
}
