//! The ownership journal (`state.json`), the exact M0 schema. Ports
//! `read_prior_state`/`Read-PriorState`'s carry-forward rules and
//! `write_state`/`Write-State`'s write.
//!
//! `state.json` is the sole record of what THIS installer owns (`vscodeInstalledByUs`,
//! `profileCreatedByUs`) and where its profile really lives on disk
//! (`profileLocation`). `uninstall.rs` (commit 11) trusts it to decide what is
//! safe to delete, so a read here fails loudly on a corrupt/unreadable file
//! rather than silently treating it as "no prior state" -- unlike M0's
//! grep-based `read_prior_state`, which degrades quietly because a shell
//! regex has no other option. Writes are atomic (temp file + rename in the
//! same directory), unlike M0's plain heredoc `cat >`, so a crash mid-write
//! can never leave a torn journal behind for `uninstall.rs` to misread.
//!
//! The schema is additive-only going forward (new fields may be added, never
//! removed or repurposed), so unknown fields are ignored on read rather than
//! rejected -- a newer installer's journal must still be readable by this
//! one.

use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Debug, thiserror::Error)]
pub enum StateError {
    #[error("could not read {path}: {source}")]
    Read {
        path: std::path::PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("could not parse {path}: {source}")]
    Parse {
        path: std::path::PathBuf,
        #[source]
        source: serde_json::Error,
    },
    #[error("could not write {path}: {source}")]
    Write {
        path: std::path::PathBuf,
        #[source]
        source: std::io::Error,
    },
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct Steps {
    pub vscode: bool,
    pub extension: bool,
    pub python: bool,
    pub settings: bool,
}

impl Steps {
    pub fn all_ok(&self) -> bool {
        self.vscode && self.extension && self.python && self.settings
    }
}

/// The exact M0 `state.json` schema (`/scope.md` "state.json" settled
/// decision). Field order here matches the doc for easy side-by-side review;
/// serde's `camelCase` rename maps every field to its M0 JSON key with no
/// per-field overrides needed.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct State {
    pub product_version: String,
    pub vscode_installed_by_us: bool,
    pub profile_created_by_us: bool,
    pub profile_location: String,
    pub steps: Steps,
    pub mpremote_version: String,
    pub env_python: String,
    pub ext_vsix_sha256: String,
    pub settings_mechanism: String,
    pub updated_at: String,
}

impl State {
    /// `Ok(None)` if no journal exists yet (a fresh machine). `Err` if it
    /// exists but is unreadable or fails to parse -- callers that need M0's
    /// lenient "couldn't read it, proceed as if it's not there" behavior make
    /// that choice explicitly at the call site; this function never makes it
    /// for them.
    pub fn read(path: &Path) -> Result<Option<State>, StateError> {
        let bytes = match std::fs::read(path) {
            Ok(b) => b,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(source) => {
                return Err(StateError::Read {
                    path: path.to_path_buf(),
                    source,
                });
            }
        };
        let state = serde_json::from_slice(&bytes).map_err(|source| StateError::Parse {
            path: path.to_path_buf(),
            source,
        })?;
        Ok(Some(state))
    }

    /// Atomic write: temp file in the same directory, then rename. A reader
    /// (including a concurrent `verify`/`uninstall`) never observes a
    /// partially written journal.
    pub fn write(&self, path: &Path) -> Result<(), StateError> {
        let parent = path.parent().unwrap_or_else(|| Path::new("."));
        std::fs::create_dir_all(parent).map_err(|source| StateError::Write {
            path: parent.to_path_buf(),
            source,
        })?;
        let body = serde_json::to_string_pretty(self).expect("State always serializes");
        let tmp = parent.join(format!(
            "{}.tmp",
            path.file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| "state.json".to_string())
        ));
        std::fs::write(&tmp, body).map_err(|source| StateError::Write {
            path: tmp.clone(),
            source,
        })?;
        std::fs::rename(&tmp, path).map_err(|source| StateError::Write {
            path: path.to_path_buf(),
            source,
        })
    }
}

/// What a new run inherits from the prior journal before any step runs
/// (ports `read_prior_state`/`Read-PriorState`). `None` (no prior journal, or
/// a caller choosing to treat a read error as none) yields all-default seeds.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Seed {
    /// Sticky-true: once an installer has recorded installing VS Code, every
    /// later run inherits `true` even if that run's own step 1 skips (VS
    /// Code already present) -- otherwise the skip branch's untouched
    /// `false` default would clobber it and `uninstall.rs` would refuse to
    /// remove a VS Code this installer put there.
    pub vscode_installed_by_us: bool,
    /// Sticky-true, same reasoning, for the profile.
    pub profile_created_by_us: bool,
    /// A previously journaled location is authoritative until a fresh
    /// resolve replaces it; only fall back to the caller's seed constant
    /// (e.g. `"blockless"`) when nothing was journaled yet.
    pub profile_location: String,
    /// The sha this run started with, kept for `extensions.rs`'s
    /// current-build comparison (`our_ext_is_bundled_build`). The
    /// incremental-write-before-step-2-completes concern this field's
    /// sibling once existed for is already covered without it: every op
    /// starts `current` as a full clone of `prior` (`prior.unwrap_or_default()`),
    /// so `current.ext_vsix_sha256` already carries the previous value
    /// forward through every write until step 2 explicitly overwrites it --
    /// a separate seeded copy here was dead weight nothing ever read.
    pub prior_ext_vsix_sha256: String,
}

pub fn seed_from_prior(prior: Option<&State>, default_profile_location: &str) -> Seed {
    match prior {
        None => Seed {
            vscode_installed_by_us: false,
            profile_created_by_us: false,
            profile_location: default_profile_location.to_string(),
            prior_ext_vsix_sha256: String::new(),
        },
        Some(state) => Seed {
            vscode_installed_by_us: state.vscode_installed_by_us,
            profile_created_by_us: state.profile_created_by_us,
            profile_location: if state.profile_location.is_empty() {
                default_profile_location.to_string()
            } else {
                state.profile_location.clone()
            },
            prior_ext_vsix_sha256: state.ext_vsix_sha256.clone(),
        },
    }
}

/// `YYYY-MM-DDTHH:MM:SSZ`, matching M0's `date -u +%Y-%m-%dT%H:%M:%SZ`. No
/// date/time crate: `state.rs` is the only thing in the core that needs a
/// timestamp, so a dependency for one `strftime` call is not worth it.
/// Callers stamp a `State`'s `updated_at` with this immediately before
/// `write` -- `write` itself never touches the wall clock, so it stays a
/// pure, deterministically testable serialize-to-disk.
pub fn now_iso8601() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    format_unix_seconds(now.as_secs())
}

fn format_unix_seconds(total_secs: u64) -> String {
    let days = (total_secs / 86400) as i64;
    let secs_of_day = total_secs % 86400;
    let (hh, mm, ss) = (
        secs_of_day / 3600,
        (secs_of_day % 3600) / 60,
        secs_of_day % 60,
    );
    let (y, m, d) = civil_from_days(days);
    format!("{y:04}-{m:02}-{d:02}T{hh:02}:{mm:02}:{ss:02}Z")
}

/// Howard Hinnant's `civil_from_days`: days since 1970-01-01 (the Unix epoch)
/// -> proleptic Gregorian (year, month, day). Public-domain algorithm
/// (http://howardhinnant.github.io/date_algorithms.html), chosen so
/// `now_iso8601` needs no external date/time crate.
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = (z - era * 146097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let y = if m <= 2 { y + 1 } else { y };
    (y, m, d)
}

#[cfg(test)]
#[path = "tests/state.rs"]
mod tests;
