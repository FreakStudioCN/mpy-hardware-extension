//! Download + sha256 verify + retry/backoff + proxy (`/scope.md` §11 / ARCHITECTURE §11).
//!
//! Every artifact this installer fetches (VS Code, uv, the offline uv-managed
//! Python) goes through [`fetch_and_verify`]: retries cover transport failures
//! only (connection errors, timeouts, non-2xx status), matching M0's
//! `curl --retry 3` semantics; a completed download whose sha256 does not
//! match the manifest is a hard, non-retried failure -- retrying a
//! deterministic wrong-content response would not fix it, and silently
//! accepting it is exactly the class of bug this exists to prevent. The file
//! is only ever written to its final path atomically (temp file + rename in
//! the same directory), after the hash check passes, so a failed or
//! in-progress download can never be mistaken for a verified artifact.
//!
//! The `reqwest::blocking::Client` proxy detection is left at its default
//! (`Client::builder().build()`, never `.no_proxy()`), which honors
//! `HTTPS_PROXY`/`HTTP_PROXY` from the environment automatically.

use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

/// Bound the connect phase, not the transfer.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(30);
/// `SO_KEEPALIVE`, so a connection that opens and then dies is detected by the
/// OS rather than by a clock that cannot tell "dead" from "slow".
const TCP_KEEPALIVE: Duration = Duration::from_secs(30);
/// Default for [`FetchOptions::read_timeout`]: bound the gap BETWEEN reads,
/// not the transfer as a whole. A peer that keeps answering ACKs but never
/// sends another body byte -- a stalled proxy, a hung server -- is otherwise
/// invisible to `tcp_keepalive`, which only detects a peer that stops
/// ACKing.
///
/// This is enforced by [`fetch_with_retry`]'s own watchdog, not by the
/// `reqwest::blocking::Client` config: `reqwest::blocking::ClientBuilder`
/// has no `read_timeout` (only the async `reqwest::ClientBuilder` does), and
/// wiring one in through `From<async_impl::ClientBuilder>` compiles but
/// panics on the first body byte ("there is no reactor running") -- the
/// timer it installs needs `tokio::time::sleep`, and the blocking client's
/// `Response::read()` drives that future with its own thread-parking poll
/// loop that never enters a real Tokio runtime.
const READ_TIMEOUT: Duration = Duration::from_secs(60);

/// The client every download goes through.
///
/// `reqwest::blocking::Client::new()` must NEVER be used for an artifact
/// fetch. Its default timeout is 30 seconds and covers connect, read AND
/// write, so it caps the whole transfer. VS Code's universal build is 542 MB,
/// which that budget clears only above roughly 152 Mbps sustained; below it
/// every attempt dies mid-body with "error decoding response body", four times
/// over, and the installer cannot install VS Code at all. Measured on a real
/// macOS VM, and invisible to every test here, which serve tiny bodies from
/// localhost, and to CI, which never touches a live endpoint. M0's
/// `curl --retry 3` sets no total timeout and is unaffected.
///
/// So: no total timeout, a bounded connect, and keepalive to notice a peer
/// that has gone away. A slow link that keeps delivering bytes takes as long
/// as it takes; one that stops delivering them is caught separately, by the
/// idle-read watchdog in [`fetch_with_retry`] (see [`READ_TIMEOUT`]).
pub fn download_client() -> Result<reqwest::blocking::Client, reqwest::Error> {
    reqwest::blocking::Client::builder()
        // Proxy detection stays at its default, never `.no_proxy()`, so
        // HTTPS_PROXY/HTTP_PROXY keep working.
        .timeout(None)
        .connect_timeout(CONNECT_TIMEOUT)
        .tcp_keepalive(TCP_KEEPALIVE)
        .build()
}

#[derive(Debug, thiserror::Error)]
pub enum FetchError {
    #[error("GET {url} failed after {attempts} attempt(s): {source}")]
    RequestFailed {
        url: String,
        attempts: u32,
        #[source]
        source: reqwest::Error,
    },
    #[error("reading response body from {url} failed after {attempts} attempt(s): {source}")]
    BodyReadFailed {
        url: String,
        attempts: u32,
        #[source]
        source: std::io::Error,
    },
    #[error("sha256 mismatch for {url}: expected {expected}, got {actual}")]
    Sha256Mismatch {
        url: String,
        expected: String,
        actual: String,
    },
    #[error("could not write {path}: {source}")]
    Io {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
}

/// Retry policy. `max_attempts` counts the FIRST try too (matching curl's
/// `--retry 3` = up to 4 total attempts): `max_attempts: 4` retries three
/// times after an initial failure. Backoff is exponential from
/// `backoff_base`, doubling each subsequent attempt.
///
/// `read_timeout` bounds the gap between body reads within a single
/// attempt (see [`READ_TIMEOUT`]); it is unrelated to `max_attempts` and
/// `backoff_base`, which govern retrying a failed attempt.
#[derive(Debug, Clone)]
pub struct FetchOptions {
    pub max_attempts: u32,
    pub backoff_base: Duration,
    pub read_timeout: Duration,
}

impl Default for FetchOptions {
    fn default() -> Self {
        FetchOptions {
            max_attempts: 4,
            backoff_base: Duration::from_millis(500),
            read_timeout: READ_TIMEOUT,
        }
    }
}

impl FetchOptions {
    fn backoff_for(&self, attempts_so_far: u32) -> Duration {
        self.backoff_base * 2u32.saturating_pow(attempts_so_far)
    }
}

/// GET `url` with retry, verify the body's sha256 against `expected_sha256_hex`
/// (case-insensitive), then atomically write it to `dest`. `dest`'s parent
/// directory is created if missing. On any failure `dest` is left untouched
/// (never a partial or unverified file at the final path).
pub fn fetch_and_verify(
    client: &reqwest::blocking::Client,
    url: &str,
    expected_sha256_hex: &str,
    dest: &Path,
    opts: &FetchOptions,
) -> Result<(), FetchError> {
    let parent = dest.parent().ok_or_else(|| FetchError::Io {
        path: dest.to_path_buf(),
        source: std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "destination has no parent directory",
        ),
    })?;
    std::fs::create_dir_all(parent).map_err(|source| FetchError::Io {
        path: parent.to_path_buf(),
        source,
    })?;
    let file_name = dest.file_name().ok_or_else(|| FetchError::Io {
        path: dest.to_path_buf(),
        source: std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "destination has no file name",
        ),
    })?;
    let tmp = parent.join(format!("{}.tmp", file_name.to_string_lossy()));
    let actual = fetch_with_retry(client, url, &tmp, opts)?;
    if !actual.eq_ignore_ascii_case(expected_sha256_hex) {
        let _ = std::fs::remove_file(&tmp);
        return Err(FetchError::Sha256Mismatch {
            url: url.to_string(),
            expected: expected_sha256_hex.to_string(),
            actual,
        });
    }
    replace_atomic(&tmp, dest).map_err(|source| FetchError::Io {
        path: dest.to_path_buf(),
        source,
    })?;
    Ok(())
}

#[cfg(not(windows))]
fn replace_atomic(tmp: &Path, dest: &Path) -> std::io::Result<()> {
    std::fs::rename(tmp, dest)
}

#[cfg(windows)]
fn replace_atomic(tmp: &Path, dest: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };

    let from: Vec<u16> = tmp.as_os_str().encode_wide().chain(Some(0)).collect();
    let to: Vec<u16> = dest.as_os_str().encode_wide().chain(Some(0)).collect();
    let ok = unsafe {
        MoveFileExW(
            from.as_ptr(),
            to.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if ok == 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}

/// A body-read chunk, or the final outcome, from the watchdog thread in
/// [`run_attempt_with_idle_timeout`].
enum ReadEvent {
    Chunk,
    Done(AttemptOutcome),
}

enum AttemptOutcome {
    Success(String),
    Request(reqwest::Error),
    /// The network read itself failed (including the idle-timeout
    /// watchdog's own synthetic error) -- retried like any other transport
    /// failure.
    Body(std::io::Error),
    /// A LOCAL filesystem operation on `attempt_tmp` failed (create/write/flush).
    /// Kept distinct from `Body` so it surfaces as `FetchError::Io` with
    /// the path attached and is NOT retried: a full disk or a permissions
    /// problem will not resolve itself by asking the server again, and
    /// silently folding it into `Body` lost the path from the error and
    /// burned the whole retry budget on a failure retrying could never fix.
    Io(PathBuf, std::io::Error),
}

/// Runs one whole GET-and-read attempt (request, headers, body) on a
/// background thread, hashing the body as it streams to `attempt_tmp`, and
/// bounds the gap between EVERY signal -- including the very first, the
/// wait for a response at all -- with `read_timeout` from the CALLING
/// thread. Neither `send()` nor `response.read()` can be bounded directly
/// (see [`READ_TIMEOUT`]'s doc comment for why the reqwest-level knob does
/// not work here): a peer that completes the TCP handshake and then sends
/// NOTHING, not even a status line, is exactly as unbounded as one that
/// sends headers and then stalls the body, and both are covered by the same
/// watchdog.
///
/// On timeout the background thread is abandoned still blocked in its own
/// `send()`/`read()` call, rather than joined -- but it checks in with the
/// caller (`tx.send`) after headers arrive and after every chunk, and stops
/// itself and removes `attempt_tmp` the moment that check reveals the
/// caller is gone, rather than silently finishing a transfer -- up to the
/// full artifact size -- nobody is waiting for. A peer that goes silent
/// AFTER headers and NEVER sends another byte leaves the abandoned thread
/// blocked forever in `read()`, with an `attempt_tmp` it can never clean up
/// itself -- but `fetch_with_retry`'s own `Body`-branch cleanup, one
/// `read_timeout` later, removes that same path, so no file survives on
/// disk even then.
/// The only unrecoverable cost is the blocked thread itself, for the life
/// of the process; this CLI process outlives it by, at most, its own exit,
/// but a long-lived host (e.g. a future GUI shell) would need this
/// re-argued.
fn run_attempt_with_idle_timeout(
    client: reqwest::blocking::Client,
    url: String,
    attempt_tmp: PathBuf,
    read_timeout: Duration,
) -> AttemptOutcome {
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut response = match client
            .get(&url)
            .send()
            .and_then(|resp| resp.error_for_status())
        {
            Ok(response) => response,
            Err(e) => {
                let _ = tx.send(ReadEvent::Done(AttemptOutcome::Request(e)));
                return;
            }
        };
        // Headers arrived. Check in before creating anything on disk: if
        // the caller already gave up waiting for exactly this signal,
        // there is nothing to clean up yet.
        if tx.send(ReadEvent::Chunk).is_err() {
            return;
        }
        let mut file = match std::fs::File::create(&attempt_tmp) {
            Ok(file) => file,
            Err(e) => {
                let _ = tx.send(ReadEvent::Done(AttemptOutcome::Io(attempt_tmp.clone(), e)));
                return;
            }
        };
        let mut hasher = Sha256::new();
        let mut buffer = [0u8; 64 * 1024];
        let body_result = loop {
            let count = match response.read(&mut buffer) {
                Ok(0) => break Ok(()),
                Ok(count) => count,
                Err(e) => break Err(AttemptOutcome::Body(e)),
            };
            if let Err(e) = file.write_all(&buffer[..count]) {
                break Err(AttemptOutcome::Io(attempt_tmp.clone(), e));
            }
            hasher.update(&buffer[..count]);
            if tx.send(ReadEvent::Chunk).is_err() {
                // The caller already gave up on this attempt. Stop
                // downloading and remove the partial file instead of
                // silently finishing a transfer nobody is waiting for.
                drop(file);
                let _ = std::fs::remove_file(&attempt_tmp);
                return;
            }
        };
        let outcome = match body_result {
            Ok(()) => match file.flush() {
                Ok(()) => {
                    let digest = hasher.finalize();
                    AttemptOutcome::Success(digest.iter().map(|b| format!("{b:02x}")).collect())
                }
                Err(e) => AttemptOutcome::Io(attempt_tmp.clone(), e),
            },
            Err(outcome) => outcome,
        };
        let _ = tx.send(ReadEvent::Done(outcome));
    });

    loop {
        match rx.recv_timeout(read_timeout) {
            Ok(ReadEvent::Chunk) => continue,
            Ok(ReadEvent::Done(outcome)) => return outcome,
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                return AttemptOutcome::Body(std::io::Error::new(
                    std::io::ErrorKind::TimedOut,
                    format!("no response or body data received for {read_timeout:?}"),
                ));
            }
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                return AttemptOutcome::Body(std::io::Error::other(
                    "the download worker thread ended without reporting an outcome",
                ));
            }
        }
    }
}

fn fetch_with_retry(
    client: &reqwest::blocking::Client,
    url: &str,
    tmp: &Path,
    opts: &FetchOptions,
) -> Result<String, FetchError> {
    enum AttemptError {
        Request(reqwest::Error),
        Body(std::io::Error),
    }

    let mut last_err: Option<AttemptError> = None;
    for attempt in 0..opts.max_attempts.max(1) {
        // Distinct per attempt: an abandoned watchdog thread from a prior,
        // timed-out attempt may still be writing to ITS file when this one
        // starts, and must never share a path with it. Built from the raw
        // OsStr, not `tmp.display()` (lossy for non-UTF-8 paths, which
        // would silently point every attempt somewhere else).
        let mut attempt_tmp_name = tmp.as_os_str().to_os_string();
        attempt_tmp_name.push(format!(".{attempt}"));
        let attempt_tmp = PathBuf::from(attempt_tmp_name);
        let outcome = run_attempt_with_idle_timeout(
            client.clone(),
            url.to_string(),
            attempt_tmp.clone(),
            opts.read_timeout,
        );
        match outcome {
            AttemptOutcome::Success(actual) => {
                std::fs::rename(&attempt_tmp, tmp).map_err(|source| {
                    // Same-directory rename essentially never fails, but if
                    // it does, the fully downloaded and hash-verified body
                    // is still sitting at `attempt_tmp` -- do not leak it.
                    let _ = std::fs::remove_file(&attempt_tmp);
                    FetchError::Io {
                        path: tmp.to_path_buf(),
                        source,
                    }
                })?;
                return Ok(actual);
            }
            AttemptOutcome::Request(e) => {
                last_err = Some(AttemptError::Request(e));
                if attempt + 1 < opts.max_attempts {
                    std::thread::sleep(opts.backoff_for(attempt));
                }
            }
            AttemptOutcome::Body(e) => {
                last_err = Some(AttemptError::Body(e));
                let _ = std::fs::remove_file(&attempt_tmp);
                if attempt + 1 < opts.max_attempts {
                    std::thread::sleep(opts.backoff_for(attempt));
                }
            }
            AttemptOutcome::Io(path, source) => {
                // A local filesystem problem, not a transport one:
                // retrying would just burn the whole backoff budget on a
                // failure the server cannot fix. Fails immediately, like
                // fetch_and_verify's own Io errors.
                let _ = std::fs::remove_file(&attempt_tmp);
                return Err(FetchError::Io { path, source });
            }
        }
    }
    match last_err.expect("loop ran at least once") {
        AttemptError::Request(source) => Err(FetchError::RequestFailed {
            url: url.to_string(),
            attempts: opts.max_attempts.max(1),
            source,
        }),
        AttemptError::Body(source) => Err(FetchError::BodyReadFailed {
            url: url.to_string(),
            attempts: opts.max_attempts.max(1),
            source,
        }),
    }
}

#[cfg(test)]
#[path = "tests/fetch.rs"]
mod tests;
