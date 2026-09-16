//! The window's log file: `installer.log` under `BLK/logs`, opened and
//! closed per write. See [`PerWriteFileWriter`] for why neither a held
//! handle nor a startup `create_dir_all` is acceptable here.

use blockless_installer_core::bootstrap::Machine;
use blockless_installer_core::platform::RawEnv;
use std::path::PathBuf;

/// The one log file name, shared with `commands::log_path_of`; the CLI
/// spells the same name in `cli/src/main.rs::init_logging`.
pub(crate) const LOG_FILE_NAME: &str = "installer.log";

/// Never keeps `installer.log` open persistently: this window is long-lived
/// and holds Uninstall, which may delete the very directory a held handle
/// lives under (a real risk on Windows). Opens, appends, and closes on
/// every single write -- the GUI's version of the CLI's
/// `init_stderr_logging`/`init_logging` per-process posture
/// (`cli/src/main.rs`), just per-write instead of per-process.
///
/// `logs_dir` is never created inside `write` -- only `run_install`
/// creates it (once, before `ops::install` runs, since install's own
/// steps are what the log exists to capture). NOT at startup either: this
/// directory sits inside `BLK`, which a PRIOR process's `uninstall` may
/// have deleted, and re-creating it the moment this window opens would
/// silently put `BLK` back on a machine that was supposed to be clean --
/// the same failure one layer out from recreating it mid-run. A missing/
/// unwritable `logs/` (including "uninstalled, never reinstalled since")
/// is exactly the case this must degrade out of: drop the line, never
/// panic, and never recreate what uninstall removed.
#[derive(Clone)]
pub(crate) struct PerWriteFileWriter {
    pub(crate) logs_dir: PathBuf,
}

impl std::io::Write for PerWriteFileWriter {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        let path = self.logs_dir.join(LOG_FILE_NAME);
        if let Ok(mut file) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
        {
            let _ = std::io::Write::write_all(&mut file, buf);
            let _ = std::io::Write::flush(&mut file);
        }
        Ok(buf.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for PerWriteFileWriter {
    type Writer = PerWriteFileWriter;
    fn make_writer(&'a self) -> Self::Writer {
        self.clone()
    }
}

pub(crate) fn init_logging() {
    let raw = RawEnv::from_process();
    let Some(logs_dir) = Machine::detect(&raw).ok().map(|machine| machine.paths.logs) else {
        return;
    };
    // No create_dir_all here -- see PerWriteFileWriter's own doc comment
    // for why startup is exactly the wrong place for it too, not just
    // inside write().
    let writer = PerWriteFileWriter { logs_dir };
    let _ = tracing_subscriber::fmt()
        .with_writer(writer)
        .with_ansi(false)
        .try_init();
}

#[cfg(test)]
#[path = "tests/logging.rs"]
mod tests;
