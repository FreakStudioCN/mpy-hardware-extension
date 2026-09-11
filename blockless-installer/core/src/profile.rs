//! The "Blockless" VS Code profile: offline registration, resolving where it
//! really lives on disk, and the window-launch fallback with its teardown.
//! Ports `register_profile_offline`/`Register-ProfileOffline`,
//! `profile_registered`/`Test-ProfileRegistered`,
//! `resolve_profile_location`/`Get-ProfileLocation`, and
//! `register_profile`/`Register-Profile` + `stop_code_and_wait`/`Stop-OurCode`.
//!
//! The window-launch fallback resolves the real VS Code process the same way
//! M0's Windows script does (`Get-CodePids` before/after): `code_cli` is a
//! wrapper -- on mac a short shell script, on Windows a `.cmd` -- that hands
//! off to the real Electron process and may itself have already exited by
//! the time that process is up, so the PID `spawn()` returns is never used
//! for teardown. Instead: snapshot `running_vscode_pids()` before spawning,
//! spawn, poll for registration, then diff `running_vscode_pids()` again to
//! find whichever PID(s) newly appeared. Only those get torn down, and only
//! if nothing was already running before we spawned -- so a window the user
//! opened themselves is never touched. All process operations go through
//! [`CommandRunner`] so this is testable without a real VS Code binary or
//! real wall-clock waits.

use serde_json::Value;
use std::path::{Path, PathBuf};
use std::time::Duration;

#[derive(Debug, thiserror::Error)]
pub enum ProfileError {
    #[error("could not create profile directory {path}: {source}")]
    CreateDir {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("could not write {path}: {source}")]
    Write {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
}

/// Process operations `profile.rs` needs, injected so every code path here is
/// unit-testable without a real VS Code binary. A production implementation
/// is OS-specific (mac: `osascript ... quit` + `pgrep`; Windows: `taskkill` +
/// `Get-Process`) and lands with `vscode.rs`/`ops.rs`, which are the first
/// callers that run for real.
pub trait CommandRunner {
    /// PIDs of any currently-running VS Code app processes on this machine.
    /// Re-checked immediately before every spawn (never cached from an
    /// earlier point) -- the user may have opened VS Code during a long
    /// prior download.
    fn running_vscode_pids(&self) -> Result<Vec<u32>, String>;
    /// Spawn `code_cli` with `args`, returning its PID.
    fn spawn(&self, code_cli: &Path, args: &[&str]) -> std::io::Result<u32>;
    /// Is this exact PID still alive?
    fn is_alive(&self, pid: u32) -> bool;
    /// Ask this exact PID to close gracefully (mac: `osascript ... quit`,
    /// M0's own mechanism; Windows: `taskkill` without `/F`) so VS Code gets
    /// a chance to save window and profile state before exiting. The
    /// caller (`stop_and_wait`, below) always polls `is_alive` on this same
    /// PID afterward, so exact-PID scoping holds even where the underlying
    /// mechanism (mac's `osascript`) can only target the app as a whole.
    fn request_graceful_close(&self, pid: u32);
    /// Force-kill this exact PID (last resort, only ever a PID we spawned).
    fn force_kill(&self, pid: u32);
    /// Injected so poll loops don't burn real wall-clock time in tests.
    fn sleep(&self, d: Duration);
}

/// Read `storage.json` leniently: `None` for both "does not exist" and
/// "exists but failed to read or parse". Matches M0's uniform swallow (JXA's
/// `try { JSON.parse } catch { return }`, or Windows' `try {...} catch {return
/// ""}`): both platforms treat an existing-but-broken file as "can't use it",
/// never as fatal -- there is always a fallback path (the window launch).
fn read_storage_lenient(path: &Path) -> Option<Value> {
    let bytes = std::fs::read(path).ok()?;
    serde_json::from_slice(&bytes).ok()
}

/// The profile's on-disk location (the `profiles/<location>` directory id),
/// looked up by name in `storage.json`'s `userDataProfiles` array.
pub fn resolve_profile_location(storage_path: &Path, profile_name: &str) -> Option<String> {
    let root = read_storage_lenient(storage_path)?;
    let list = root.get("userDataProfiles")?.as_array()?;
    for entry in list {
        let name = entry.get("name").and_then(Value::as_str);
        if name == Some(profile_name) {
            return entry
                .get("location")
                .and_then(Value::as_str)
                .map(str::to_string);
        }
    }
    None
}

pub fn profile_registered(storage_path: &Path, profile_name: &str) -> bool {
    resolve_profile_location(storage_path, profile_name).is_some()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RegisterOfflineOutcome {
    AlreadyRegistered,
    /// A VS Code instance is running: it owns `storage.json` in memory and
    /// would clobber our edit on its own next save. Do nothing; the window
    /// fallback ([`register_profile`]) covers this case.
    SkippedVscodeRunning,
    /// `storage.json` exists but could not be read/parsed. Never replace an
    /// unparseable file (it may hold other profiles' window state); the
    /// window fallback covers this case too.
    SkippedUnparseableStorage,
    Registered,
}

/// Register the profile WITHOUT launching VS Code: seed `storage.json`'s
/// `userDataProfiles` entry directly and create `profiles/<seed_location>/`.
/// This is the fix for "panel never auto-opens" (see `NOTES.md`): a live
/// window created then closed mid-startup leaves half-written window state,
/// so the real first launch resolves against the default profile. Seeding
/// means no window exists before the final launch.
pub fn register_profile_offline(
    runner: &dyn CommandRunner,
    storage_path: &Path,
    profiles_dir: &Path,
    profile_name: &str,
    seed_location: &str,
) -> Result<RegisterOfflineOutcome, ProfileError> {
    if profile_registered(storage_path, profile_name) {
        return Ok(RegisterOfflineOutcome::AlreadyRegistered);
    }
    if runner
        .running_vscode_pids()
        .map_or(true, |pids| !pids.is_empty())
    {
        return Ok(RegisterOfflineOutcome::SkippedVscodeRunning);
    }

    let mut root = match std::fs::read(storage_path) {
        Ok(bytes) => match serde_json::from_slice::<Value>(&bytes) {
            Ok(v) => v,
            Err(_) => return Ok(RegisterOfflineOutcome::SkippedUnparseableStorage),
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Value::Object(Default::default()),
        Err(_) => return Ok(RegisterOfflineOutcome::SkippedUnparseableStorage),
    };

    // A storage.json that parses but isn't a JSON object (VS Code never
    // writes one that isn't, but a hand-edited or foreign file could be) has
    // nowhere to hold userDataProfiles -- treat it the same as unparseable
    // rather than panic or silently drop the registration. Checked before
    // creating the profile directory below, so a storage.json we can't use
    // never leaves an orphaned profile dir behind.
    let Some(obj) = root.as_object_mut() else {
        return Ok(RegisterOfflineOutcome::SkippedUnparseableStorage);
    };

    let profile_dir = profiles_dir.join(seed_location);
    std::fs::create_dir_all(&profile_dir).map_err(|source| ProfileError::CreateDir {
        path: profile_dir,
        source,
    })?;
    if !obj.get("userDataProfiles").is_some_and(Value::is_array) {
        obj.insert("userDataProfiles".to_string(), Value::Array(Vec::new()));
    }
    let list = obj
        .get_mut("userDataProfiles")
        .unwrap()
        .as_array_mut()
        .unwrap();
    let already_present = list
        .iter()
        .any(|e| e.get("name").and_then(Value::as_str) == Some(profile_name));
    if !already_present {
        let mut entry = serde_json::Map::new();
        entry.insert(
            "location".to_string(),
            Value::String(seed_location.to_string()),
        );
        entry.insert("name".to_string(), Value::String(profile_name.to_string()));
        list.push(Value::Object(entry));
    }

    let body = serde_json::to_vec(&root).expect("Value always serializes");
    write_atomic(storage_path, &body).map_err(|source| ProfileError::Write {
        path: storage_path.to_path_buf(),
        source,
    })?;
    Ok(RegisterOfflineOutcome::Registered)
}

fn write_atomic(dest: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let parent = dest.parent().unwrap_or_else(|| Path::new("."));
    std::fs::create_dir_all(parent)?;
    let file_name = dest
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "storage.json".to_string());
    let tmp = parent.join(format!("{file_name}.tmp"));
    std::fs::write(&tmp, bytes)?;
    std::fs::rename(&tmp, dest)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RegisterProfileOutcome {
    AlreadyRegistered,
    Registered,
    TimedOut,
    SpawnFailed,
}

/// Fallback only: a live VS Code owns `storage.json`, or the offline seed
/// otherwise didn't take. Launch `code_cli --profile <name> --new-window`,
/// poll for registration, then close whichever process(es) newly appeared --
/// but only if nothing was already running before we launched.
///
/// `spawn()`'s own return value is deliberately unused for teardown: on mac,
/// `code_cli` is a shell wrapper that hands off to `Visual Studio
/// Code.app/.../Electron` and typically exits well before that real process
/// is even up, so its PID names a process that is already gone by the time
/// we'd poll `is_alive` on it -- indistinguishable from "closed successfully"
/// and, before this fix, exactly why the real window this fallback opens was
/// never actually closed. The real PID(s) are resolved the same way M0's own
/// Windows script does it (`Get-CodePids` before/after): diff
/// `running_vscode_pids()` from before spawning against after the poll.
///
/// Attach-to-existing-instance caveat (documented, not fixable by PID
/// bookkeeping): if the user opens VS Code during the poll below while ours
/// is still starting, `--new-window` attaches to our not-yet-registered
/// instance rather than spawning a second one, so closing "our" PID would
/// close theirs too. The only guard against ever tearing down a session we
/// didn't start alone is the re-probe immediately before spawning: if
/// anything was already running at that instant, we never call
/// [`stop_and_wait`] at all.
pub fn register_profile(
    runner: &dyn CommandRunner,
    code_cli: &Path,
    storage_path: &Path,
    profile_name: &str,
) -> RegisterProfileOutcome {
    if profile_registered(storage_path, profile_name) {
        return RegisterProfileOutcome::AlreadyRegistered;
    }
    let before = match runner.running_vscode_pids() {
        Ok(pids) => pids,
        Err(_) => return RegisterProfileOutcome::SpawnFailed,
    };
    if runner
        .spawn(code_cli, &["--profile", profile_name, "--new-window"])
        .is_err()
    {
        return RegisterProfileOutcome::SpawnFailed;
    }

    let mut registered = false;
    for _ in 0..60 {
        if profile_registered(storage_path, profile_name) {
            registered = true;
            break;
        }
        runner.sleep(Duration::from_millis(500));
    }

    if before.is_empty() {
        if let Ok(after) = runner.running_vscode_pids() {
            for pid in after.into_iter().filter(|p| !before.contains(p)) {
                stop_and_wait(runner, pid);
            }
        }
    }

    if registered {
        RegisterProfileOutcome::Registered
    } else {
        RegisterProfileOutcome::TimedOut
    }
}

/// Graceful close, then force-kill if that doesn't take within the wait
/// window, then wait again to confirm exit -- so the caller's next launch is
/// a fresh instance (a running extension host won't load a newly installed
/// extension). Ports `stop_code_and_wait`/`Stop-OurCode`; always targets the
/// exact PID passed in, never a pattern match.
pub fn stop_and_wait(runner: &dyn CommandRunner, pid: u32) {
    runner.request_graceful_close(pid);
    for _ in 0..60 {
        if !runner.is_alive(pid) {
            return;
        }
        runner.sleep(Duration::from_millis(250));
    }
    runner.force_kill(pid);
    for _ in 0..20 {
        if !runner.is_alive(pid) {
            return;
        }
        runner.sleep(Duration::from_millis(250));
    }
}

#[cfg(test)]
#[path = "tests/profile.rs"]
mod tests;
