//! `HTTPS_PROXY`/`HTTP_PROXY` env honored (`/scope.md` §11). Its own test
//! binary (cargo compiles each `tests/*.rs` file as a separate process) so
//! mutating `HTTP_PROXY` here can never race the lib's other unit tests --
//! this is the only test in the crate that touches process env.

use blockless_installer_core::fetch::{fetch_and_verify, FetchOptions};
use std::io::{Read, Write};
use std::net::TcpListener;
use std::time::Duration;

/// A `.invalid` host (RFC 2606: reserved, guaranteed never to resolve) as the
/// fetch target. If the client attempted a direct connection it would fail
/// DNS resolution immediately; a successful fetch is only possible if the
/// request was routed to our fake proxy instead, which never resolves or
/// forwards anything -- it just answers any request it receives.
const TARGET_URL: &str = "http://blockless-fetch-proxy-test.invalid/asset";

#[test]
fn proxy_env_is_honored_for_the_download() {
    let body = b"served by the proxy, not the origin".to_vec();
    let expected_sha256 = {
        use sha2::{Digest, Sha256};
        let mut hasher = Sha256::new();
        hasher.update(&body);
        hasher
            .finalize()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>()
    };

    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap();
    let body_for_thread = body.clone();
    let handle = std::thread::spawn(move || {
        let (mut stream, _) = listener
            .accept()
            .expect("proxy never received a connection");
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
        let request_line = String::from_utf8_lossy(&seen);
        assert!(
            request_line.contains(TARGET_URL)
                || request_line.contains("blockless-fetch-proxy-test.invalid"),
            "proxy did not receive an absolute-URI request for the target: {request_line}"
        );
        let head = format!(
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            body_for_thread.len()
        );
        let _ = stream.write_all(head.as_bytes());
        let _ = stream.write_all(&body_for_thread);
        let _ = stream.flush();
    });

    // SAFETY: this test binary runs alone (see the module doc) -- no other
    // test in this process reads or mutates HTTP_PROXY concurrently.
    unsafe {
        std::env::set_var("HTTP_PROXY", format!("http://{addr}"));
    }

    let client = reqwest::blocking::Client::new();
    let dest = std::env::temp_dir().join(format!(
        "blockless-installer-fetch-proxy-test-{}.bin",
        std::process::id()
    ));
    let opts = FetchOptions {
        max_attempts: 1,
        backoff_base: Duration::from_millis(1),
    };

    let result = fetch_and_verify(&client, TARGET_URL, &expected_sha256, &dest, &opts);

    unsafe {
        std::env::remove_var("HTTP_PROXY");
    }
    handle.join().expect("proxy thread panicked");

    result.expect("fetch through the env-configured proxy failed");
    assert_eq!(std::fs::read(&dest).unwrap(), body);
    let _ = std::fs::remove_file(&dest);
}
