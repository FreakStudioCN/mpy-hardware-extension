use super::*;

fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    let digest = hasher.finalize();
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;

/// A tiny single-purpose HTTP/1.1 server: serves exactly `responses.len()`
/// connections, one canned (status, body) response each, `Connection:
/// close` after every response so the client always opens a fresh
/// connection per attempt (lines the server's accept() count up 1:1 with
/// the client's retry attempts).
struct TestServer {
    addr: SocketAddr,
    stop: Arc<AtomicBool>,
    handle: Option<std::thread::JoinHandle<()>>,
}

impl TestServer {
    /// A server that never receives the connections it expects must fail
    /// fast, not hang the test (and, if this were ever the real bug
    /// instead of a deliberate mutation, not hang the whole CI job). That
    /// is `Drop`'s job: it signals `stop` and only then joins.
    ///
    /// It used to be a 5-second wall clock instead, which is a race rather
    /// than a lifetime: the deadline began when the server started waiting,
    /// not when the client did anything, so a loaded machine could burn it
    /// before the request was sent. The thread then returned, dropped the
    /// listener, and a pending connect was reset. Measured on Windows as an
    /// intermittent ConnectionReset, the failing run taking 5.09s against
    /// 0.1s clean, striking a different test almost every time and none of
    /// them in isolation.
    fn start(responses: Vec<(u16, Vec<u8>)>) -> TestServer {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        listener.set_nonblocking(true).unwrap();
        let stop = Arc::new(AtomicBool::new(false));
        let thread_stop = Arc::clone(&stop);
        let handle = std::thread::spawn(move || {
            for (status, body) in responses {
                let mut stream = match Self::accept_one(&listener, &thread_stop) {
                    Some(s) => s,
                    None => return,
                };
                // Windows hands back an accepted socket that INHERITED the
                // listener's non-blocking mode; Unix does not. The listener is
                // non-blocking only so accept() can poll a deadline, and
                // everything below assumes blocking: the read loop turns
                // WouldBlock into n == 0 and stops without reading the request,
                // and write_all can WouldBlock into a discarded error, so the
                // client sees a connection that closed without a response.
                stream.set_nonblocking(false).unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                let mut buf = [0u8; 4096];
                let mut seen = Vec::new();
                loop {
                    let n = stream.read(&mut buf).unwrap_or(0);
                    if n == 0 {
                        break;
                    }
                    seen.extend_from_slice(&buf[..n]);
                    if seen.windows(4).any(|w| w == b"\r\n\r\n") {
                        break;
                    }
                }
                let reason = if status == 200 { "OK" } else { "Error" };
                let head = format!(
                    "HTTP/1.1 {status} {reason}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                );
                // Surfaced, not discarded. A swallowed write error here reaches
                // the test as a confusing client-side "connection closed
                // without a response" instead of naming the side that failed.
                if let Err(e) = stream
                    .write_all(head.as_bytes())
                    .and_then(|()| stream.write_all(&body))
                    .and_then(|()| stream.flush())
                {
                    eprintln!("test server failed to write its response: {e}");
                }
            }
        });
        TestServer {
            addr,
            stop,
            handle: Some(handle),
        }
    }

    fn url(&self) -> String {
        format!("http://{}/asset", self.addr)
    }

    fn accept_one(
        listener: &TcpListener,
        thread_stop: &Arc<AtomicBool>,
    ) -> Option<std::net::TcpStream> {
        loop {
            if thread_stop.load(Ordering::Relaxed) {
                return None;
            }
            match listener.accept() {
                Ok((s, _)) => return Some(s),
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(5));
                }
                Err(_) => return None,
            }
        }
    }

    /// Sends a valid response head advertising a body, then never writes a
    /// single body byte and never closes the connection -- alive, ACKing,
    /// silent. Reproduces the peer `tcp_keepalive` cannot see: it only
    /// detects a peer that stops ACKing, not one that stops sending.
    fn start_stalling_after_headers(status: u16) -> TestServer {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        listener.set_nonblocking(true).unwrap();
        let stop = Arc::new(AtomicBool::new(false));
        let thread_stop = Arc::clone(&stop);
        let handle = std::thread::spawn(move || {
            let mut stream = match Self::accept_one(&listener, &thread_stop) {
                Some(s) => s,
                None => return,
            };
            stream.set_nonblocking(false).unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut buf = [0u8; 4096];
            let mut seen = Vec::new();
            loop {
                let n = stream.read(&mut buf).unwrap_or(0);
                if n == 0 {
                    break;
                }
                seen.extend_from_slice(&buf[..n]);
                if seen.windows(4).any(|w| w == b"\r\n\r\n") {
                    break;
                }
            }
            let reason = if status == 200 { "OK" } else { "Error" };
            let head = format!("HTTP/1.1 {status} {reason}\r\nContent-Length: 4096\r\n\r\n");
            if let Err(e) = stream
                .write_all(head.as_bytes())
                .and_then(|()| stream.flush())
            {
                eprintln!("test server failed to write its stalling response head: {e}");
            }
            // No body ever arrives. Hold the connection open until told to
            // stop, instead of closing it -- a close would be a different
            // failure (connection reset), not the one under test.
            while !thread_stop.load(Ordering::Relaxed) {
                std::thread::sleep(Duration::from_millis(20));
            }
        });
        TestServer {
            addr,
            stop,
            handle: Some(handle),
        }
    }
}

impl Drop for TestServer {
    fn drop(&mut self) {
        // Signal BEFORE joining, or a server still waiting for a connection
        // nobody will make would hang the suite.
        self.stop.store(true, Ordering::Relaxed);
        if let Some(h) = self.handle.take() {
            let _ = h.join();
        }
    }
}

fn temp_dest(name: &str) -> PathBuf {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!(
        "blockless-installer-fetch-test-{name}-{}-{n}",
        std::process::id()
    ));
    dir.join("asset.bin")
}

fn fast_opts(max_attempts: u32) -> FetchOptions {
    FetchOptions {
        max_attempts,
        backoff_base: Duration::from_millis(1),
        read_timeout: Duration::from_secs(5),
    }
}

#[test]
fn sha_mismatch_fails_loudly_and_writes_nothing() {
    let body = b"correct bytes".to_vec();
    let server = TestServer::start(vec![(200, body)]);
    let client = reqwest::blocking::Client::new();
    let dest = temp_dest("sha-mismatch");

    let err = fetch_and_verify(
        &client,
        &server.url(),
        "0000000000000000000000000000000000000000000000000000000000000000",
        &dest,
        &fast_opts(1),
    )
    .unwrap_err();

    assert!(
        matches!(err, FetchError::Sha256Mismatch { .. }),
        "got {err:?}"
    );
    assert!(
        !dest.exists(),
        "a mismatched download must never reach the final path"
    );
}

#[test]
fn retry_then_succeed() {
    let body = b"eventually correct".to_vec();
    let expected = sha256_hex(&body);
    let server = TestServer::start(vec![(503, vec![]), (503, vec![]), (200, body.clone())]);
    let client = reqwest::blocking::Client::new();
    let dest = temp_dest("retry-then-succeed");

    fetch_and_verify(&client, &server.url(), &expected, &dest, &fast_opts(3)).unwrap();

    assert_eq!(std::fs::read(&dest).unwrap(), body);
}

#[test]
fn verified_download_atomically_replaces_an_existing_destination() {
    let body = b"new verified bytes".to_vec();
    let expected = sha256_hex(&body);
    let server = TestServer::start(vec![(200, body.clone())]);
    let client = reqwest::blocking::Client::new();
    let dest = temp_dest("replace-existing");
    std::fs::create_dir_all(dest.parent().unwrap()).unwrap();
    std::fs::write(&dest, b"old bytes").unwrap();

    fetch_and_verify(&client, &server.url(), &expected, &dest, &fast_opts(1)).unwrap();

    assert_eq!(std::fs::read(&dest).unwrap(), body);
}

#[test]
fn retry_exhausted_fails_loudly() {
    let server = TestServer::start(vec![(503, vec![]), (503, vec![]), (503, vec![])]);
    let client = reqwest::blocking::Client::new();
    let dest = temp_dest("retry-exhausted");

    let err = fetch_and_verify(
        &client,
        &server.url(),
        "deadbeef00000000000000000000000000000000000000000000000000000000",
        &dest,
        &fast_opts(3),
    )
    .unwrap_err();

    match err {
        FetchError::RequestFailed { attempts, .. } => assert_eq!(attempts, 3),
        other => panic!("expected RequestFailed, got {other:?}"),
    }
    assert!(!dest.exists());
}

#[test]
fn sha256_hex_matches_known_vector() {
    // sha256("") -- a fixed, independently-verifiable vector, to catch a
    // hasher/encoding mistake that a self-referential round-trip test
    // (hash it, then compare to itself) could never catch.
    assert_eq!(
        sha256_hex(b""),
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    );
}

#[test]
fn stalled_but_alive_connection_errors_instead_of_hanging() {
    // Run on its own thread and bound the wait with recv_timeout: deleting
    // the idle-read watchdog must fail this test, not hang the suite.
    let read_timeout = Duration::from_millis(150);
    let server = TestServer::start_stalling_after_headers(200);
    let client = reqwest::blocking::Client::new();
    let url = server.url();
    let dest = temp_dest("stalled");
    let opts = FetchOptions {
        max_attempts: 1,
        backoff_base: Duration::from_millis(1),
        read_timeout,
    };

    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let result = fetch_and_verify(
            &client,
            &url,
            "deadbeef00000000000000000000000000000000000000000000000000000000",
            &dest,
            &opts,
        );
        let _ = tx.send(result);
    });

    let result = rx
        .recv_timeout(read_timeout * 10)
        .expect("a stalled connection must error within roughly the read timeout, not hang");
    let err = result.unwrap_err();
    assert!(
        matches!(err, FetchError::BodyReadFailed { .. }),
        "got {err:?}"
    );
}

#[test]
fn backoff_doubles_each_attempt() {
    let opts = FetchOptions {
        max_attempts: 4,
        backoff_base: Duration::from_millis(10),
        read_timeout: Duration::from_secs(5),
    };
    assert_eq!(opts.backoff_for(0), Duration::from_millis(10));
    assert_eq!(opts.backoff_for(1), Duration::from_millis(20));
    assert_eq!(opts.backoff_for(2), Duration::from_millis(40));
}
