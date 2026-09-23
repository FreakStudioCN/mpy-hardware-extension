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
///
/// TWO MEANINGS, deliberately, and worth knowing before you tune it:
/// [`fetch_and_verify`] uses it as an IDLE bound (the gap between chunks of a
/// large streaming body), while [`get_text_with_retry`] uses it as a TOTAL
/// per-request deadline for one small JSON document. Lowering it to tighten
/// stall detection on downloads therefore also caps the update-API request
/// outright. Split this field before that difference matters.
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

/// Download `url` to `dest` with retry but WITHOUT a sha256 check, returning
/// the sha256 of whatever arrived so the caller can log it.
///
/// **Use this for exactly one thing: Microsoft's Evergreen WebView2
/// bootstrapper.** Everything the manifest pins goes through
/// [`fetch_and_verify`] and must keep doing so.
///
/// Why no hash: `go.microsoft.com/fwlink/p/?LinkId=2124703` is a redirector
/// that always serves the current bootstrapper, so there is no stable digest
/// to pin, and inventing one would mean writing a hash we cannot fetch
/// authoritatively -- precisely what the rig documentation forbids. Integrity
/// is instead established by the artifact's AUTHENTICODE SIGNATURE, checked
/// before it is executed, by the same `verify_signature` gate the VS Code
/// installer already passes through (Microsoft subject pin included). That is
/// a stronger claim than a hash pinned in our own repo: it chains to
/// Microsoft rather than to us.
///
/// The returned digest is for the log only. It is NOT a gate, and a caller
/// that treats it as one has misunderstood this function.
pub fn download_unverified(
    client: &reqwest::blocking::Client,
    url: &str,
    dest: &Path,
    opts: &FetchOptions,
) -> Result<String, FetchError> {
    let parent = dest.parent().unwrap_or_else(|| Path::new("."));
    std::fs::create_dir_all(parent).map_err(|source| FetchError::Io {
        path: parent.to_path_buf(),
        source,
    })?;
    fetch_with_retry(client, url, dest, opts)
}

/// GET `url` and return the body as text, retried under the SAME policy as
/// [`fetch_and_verify`]'s downloads (`FetchOptions::max_attempts`, exponential
/// backoff from `backoff_base`).
///
/// Exists because the VS Code update-API request was a single unretried
/// `client.get(url).send()` in `vscode.rs`, while the download it gates got
/// the full retry treatment. Found on the Windows Sandbox rig, 2026-09-21: a
/// first Install surfaced "could not reach the VS Code update API" as a
/// failure screen and a manual retry cleared it, with nothing else changed.
/// The cause was not captured -- a freshly booted sandbox whose NAT/DNS had
/// not settled is the likeliest explanation, not a confirmed one -- but a
/// single-shot request on the path that gates the whole install is worth
/// retrying whatever the cause was. A cold
/// machine with slow DHCP is exactly the profile a one-click installer runs
/// on, so the request that gates the whole install must be at least as robust
/// as the download that follows it.
///
/// Each attempt is bounded by `opts.read_timeout` as a TOTAL per-request
/// deadline, not by the idle watchdog [`retry::fetch_with_retry`] uses. Note
/// the client's own timeouts do NOT cover this: `download_client` sets
/// `.timeout(None)` so a 542 MB transfer is never capped, which is why the
/// bound has to be applied per request here.
///
/// A total bound is the stronger choice for this call. The watchdog is
/// idle-based, so a peer trickling one byte per window defeats it; an absolute
/// deadline does not care. That trade only works because this reads one small
/// JSON document -- applying it to a download would cap the transfer, which is
/// exactly what `download_client` refuses to do.
///
/// **A 4xx is not retried**, except 408 Request Timeout and 429 Too Many
/// Requests. A client error is a fact about the request, not a transient, and
/// retrying it would just burn the whole backoff budget before reporting the
/// same thing -- the same reasoning that makes a sha256 mismatch a hard
/// failure rather than a retry. 408 and 429 are the two 4xx codes that are
/// transient by definition: a classroom installing at once is exactly who gets
/// rate-limited.
pub fn get_text_with_retry(
    client: &reqwest::blocking::Client,
    url: &str,
    opts: &FetchOptions,
) -> Result<String, reqwest::Error> {
    let attempts = opts.max_attempts.max(1);
    let mut last: Option<reqwest::Error> = None;
    for attempt in 0..attempts {
        match client
            .get(url)
            // BOUND THE ATTEMPT. `download_client` sets `.timeout(None)` on
            // purpose -- a 542 MB transfer must not be capped -- so without a
            // per-request timeout here an attempt can never end, and a retry
            // that can never fire is not a retry. `tcp_keepalive` does not
            // help: it detects a peer that stops ACKing, not one that ACKs and
            // sends nothing (see this module's docs). A server that accepts
            // the connection and then stalls mid-headers would block the
            // installer's worker thread forever, with the GUI showing a step
            // that never completes.
            //
            // `RequestBuilder::timeout` overrides the client's for this
            // request only, so the download path is untouched. A total bound
            // is right here where `fetch_with_retry` uses an idle watchdog,
            // because this reads one small JSON document rather than
            // streaming hundreds of megabytes.
            .timeout(opts.read_timeout)
            .send()
            .and_then(|r| r.error_for_status())
            .and_then(|r| r.text())
        {
            Ok(body) => return Ok(body),
            Err(e) => {
                let client_error = e.status().is_some_and(|s| {
                    s.is_client_error()
                        && s != reqwest::StatusCode::REQUEST_TIMEOUT
                        && s != reqwest::StatusCode::TOO_MANY_REQUESTS
                });
                // Logged per failed attempt, so a retry that SUCCEEDS still
                // leaves evidence it happened: without this line a transient
                // the retry absorbed is indistinguishable from one that never
                // occurred, and an induced-fault rig run would prove nothing
                // readable.
                //
                // WHERE IT LANDS. This line is emitted only by
                // `get_text_with_retry`, so in practice it covers the VS Code
                // update API. The download path (`fetch_with_retry`, in
                // `retry.rs`) emits no tracing at all, so the WebView2
                // bootstrapper fetch never reaches here regardless of where
                // logs are writable -- that path reports through its own
                // dialog.
                //
                // It reaches `logs/installer.log`, and hence the diagnostics
                // bundle, whenever `BLK/logs` exists. The GUI's writer
                // (`app/src/logging.rs`) never creates it -- only `run_install`
                // does, deliberately, because recreating it at startup would
                // put `BLK` back on a machine a prior uninstall had cleaned --
                // so on a fresh or freshly-cleaned machine, lines emitted
                // before the first install are dropped.
                tracing::warn!(
                    url,
                    attempt = attempt + 1,
                    of = attempts,
                    will_retry = !client_error && attempt + 1 < attempts,
                    error = %e,
                    "GET failed"
                );
                last = Some(e);
                if client_error {
                    break;
                }
                if attempt + 1 < attempts {
                    std::thread::sleep(opts.backoff_for(attempt));
                }
            }
        }
    }
    Err(last.expect("the loop body runs at least once and only exits via Ok or Some(e)"))
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

#[path = "fetch/retry.rs"]
mod retry;
use retry::fetch_with_retry;

#[cfg(test)]
#[path = "tests/fetch.rs"]
mod tests;
