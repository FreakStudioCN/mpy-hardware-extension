//! The per-attempt half of [`super::fetch_and_verify`]: one GET-and-read
//! on a watchdog thread, bounded between reads, retried with backoff by
//! [`fetch_with_retry`]. Split out of `fetch.rs` for size only; every
//! decision here is documented on the item it belongs to.

use super::{FetchError, FetchOptions};
use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

/// See [`fetch_with_retry`]'s per-attempt temp name: unique across every
/// call in this process, not just within one call's retry loop.
static ATTEMPT_SERIAL: AtomicU64 = AtomicU64::new(0);

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
/// The unrecoverable cost is the blocked thread itself, for the life of the
/// process, together with what it holds: its socket and its open handle on
/// the already-unlinked `attempt_tmp`, so that file's blocks stay allocated
/// until the process exits even though no name points at them. A CLI
/// process outlives it by, at most, its own exit.
///
/// The GUI shell is the long-lived host this used to say would need the
/// cost re-argued, and it has been: `app/src/main.rs` caps installs at
/// `MAX_INSTALL_ATTEMPTS_PER_PROCESS`, so a window left open cannot
/// accumulate abandoned threads without bound. The worst case is that cap
/// times `FetchOptions::max_attempts` threads and file descriptors for one
/// process's life, since an install aborts on its first failed fetch.
/// Anything else long-lived that calls this has to make the same argument.
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
        // Close the write handle BEFORE reporting: the caller renames the
        // file and, for VS Code on Windows, executes it the moment it hears
        // `Success`. An image with a write handle still open on another
        // thread fails `CreateProcess` with a sharing violation.
        drop(file);
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

pub(super) fn fetch_with_retry(
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
        // Distinct per attempt, process-wide: an abandoned watchdog thread
        // from a prior, timed-out attempt may still hold ITS file open when
        // this one starts, and must never share a path with it. The serial
        // is global rather than this loop's index because a long-lived host
        // (the GUI) fetches the same `dest` again in a later call, and on
        // Windows a name whose delete is still pending behind an open
        // handle cannot be created again -- `File::create` would fail with
        // access denied and be classed as a local I/O error, ending the
        // whole fetch without a retry. Built from the raw OsStr, not
        // `tmp.display()` (lossy for non-UTF-8 paths, which would silently
        // point every attempt somewhere else).
        let serial = ATTEMPT_SERIAL.fetch_add(1, Ordering::Relaxed);
        let mut attempt_tmp_name = tmp.as_os_str().to_os_string();
        attempt_tmp_name.push(format!(".{serial}"));
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
