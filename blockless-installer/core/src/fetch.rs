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

#[path = "fetch/retry.rs"]
mod retry;
use retry::fetch_with_retry;

#[cfg(test)]
#[path = "tests/fetch.rs"]
mod tests;
