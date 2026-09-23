use super::*;
use std::cell::RefCell;

/// Fully hermetic: no network, no real signature check, no real installer.
///
/// `available` answers from a queue so a test can say "missing, then present"
/// (a successful install) or "missing, then still missing".
struct FakeRunner {
    available: RefCell<Vec<bool>>,
    download: Result<(), String>,
    signature: Result<(), SignatureError>,
    bootstrapper: Result<(), InstallError>,
    downloaded: RefCell<Vec<PathBuf>>,
    verified: RefCell<Vec<PathBuf>>,
    ran: RefCell<Vec<PathBuf>>,
    /// The sequence of calls, so a test can assert that verification precedes
    /// execution rather than only that both happened.
    order: RefCell<Vec<&'static str>>,
}

impl FakeRunner {
    fn new(available: Vec<bool>) -> Self {
        FakeRunner {
            available: RefCell::new(available),
            download: Ok(()),
            signature: Ok(()),
            bootstrapper: Ok(()),
            downloaded: RefCell::new(Vec::new()),
            verified: RefCell::new(Vec::new()),
            ran: RefCell::new(Vec::new()),
            order: RefCell::new(Vec::new()),
        }
    }
}

impl Webview2Runner for FakeRunner {
    fn runtime_available(&self) -> bool {
        let mut q = self.available.borrow_mut();
        if q.is_empty() {
            false
        } else {
            q.remove(0)
        }
    }
    fn download_bootstrapper(&self, dest: &Path) -> Result<(), String> {
        self.downloaded.borrow_mut().push(dest.to_path_buf());
        self.order.borrow_mut().push("download");
        self.download.clone()
    }
    fn verify_signature(&self, artifact: &Path) -> Result<(), SignatureError> {
        self.verified.borrow_mut().push(artifact.to_path_buf());
        self.order.borrow_mut().push("verify");
        match &self.signature {
            Ok(()) => Ok(()),
            Err(e) => Err(SignatureError(e.0.clone())),
        }
    }
    fn run_bootstrapper(&self, exe: &Path) -> Result<(), InstallError> {
        self.ran.borrow_mut().push(exe.to_path_buf());
        self.order.borrow_mut().push("run");
        match &self.bootstrapper {
            Ok(()) => Ok(()),
            Err(e) => Err(InstallError(e.0.clone())),
        }
    }
}

fn dir(tag: &str) -> PathBuf {
    std::env::temp_dir().join(format!("blk-wv2-{tag}"))
}

#[test]
fn present_runtime_downloads_nothing() {
    let runner = FakeRunner::new(vec![true]);
    assert_eq!(
        ensure_webview2(&runner, &dir("present")),
        Webview2Outcome::AlreadyPresent
    );
    assert!(
        runner.downloaded.borrow().is_empty(),
        "an available runtime must never trigger a download"
    );
    assert!(runner.ran.borrow().is_empty());
}

#[test]
fn missing_runtime_is_downloaded_verified_and_installed_in_that_order() {
    let runner = FakeRunner::new(vec![false, true]);
    assert_eq!(
        ensure_webview2(&runner, &dir("ok")),
        Webview2Outcome::Installed
    );
    assert_eq!(runner.downloaded.borrow().len(), 1);
    assert_eq!(runner.verified.borrow().len(), 1);
    assert_eq!(runner.ran.borrow().len(), 1);
    assert_eq!(
        runner.verified.borrow()[0],
        runner.ran.borrow()[0],
        "the artifact that was verified must be the one that was run"
    );
}

/// The signature is the ONLY integrity gate on a file downloaded without a
/// hash pin, so a bad signature must stop execution entirely. A regression
/// here would mean running an unverified executable fetched off the internet.
#[test]
fn a_bad_signature_means_the_bootstrapper_is_never_run() {
    let mut runner = FakeRunner::new(vec![false, true]);
    runner.signature = Err(SignatureError("not Microsoft".to_string()));

    let outcome = ensure_webview2(&runner, &dir("badsig"));
    match outcome {
        Webview2Outcome::Failed(msg) => assert!(
            msg.contains("not authentically signed"),
            "the message must say why it refused: {msg}"
        ),
        other => panic!("expected Failed, got {other:?}"),
    }
    assert_eq!(
        runner.verified.borrow().len(),
        1,
        "it must have been checked"
    );
    assert!(
        runner.ran.borrow().is_empty(),
        "an unverified artifact must NEVER be executed"
    );
}

/// The docs claim a rejected artifact is DELETED, not merely left unrun. That
/// was asserted nowhere and could not be: the fake creates no file. This test
/// writes a real file at the path `ensure_webview2` uses, so the cleanup is
/// observable.
#[test]
fn a_rejected_artifact_is_removed_from_disk() {
    let d = std::env::temp_dir().join(format!("blk-wv2-reject-{}", std::process::id()));
    std::fs::create_dir_all(&d).unwrap();
    let artifact = d.join("MicrosoftEdgeWebview2Setup.exe");
    std::fs::write(&artifact, b"not really microsoft's").unwrap();

    let mut runner = FakeRunner::new(vec![false, false]);
    runner.signature = Err(SignatureError("not Microsoft".to_string()));

    let _ = ensure_webview2(&runner, &d);

    assert!(
        !artifact.exists(),
        "an artifact that failed signature verification must not be left on disk"
    );
    let _ = std::fs::remove_dir_all(&d);
}

/// Ordering is the security property -- verify BEFORE run. Counts alone cannot
/// show it, so the fake records the sequence.
#[test]
fn verification_happens_before_execution() {
    let runner = FakeRunner::new(vec![false, true]);

    let _ = ensure_webview2(&runner, &dir("order"));

    assert_eq!(
        runner.order.borrow().as_slice(),
        &["download", "verify", "run"]
    );
}

#[test]
fn a_download_failure_is_reported_and_verifies_nothing() {
    let mut runner = FakeRunner::new(vec![false, false]);
    runner.download = Err("connection reset".to_string());

    match ensure_webview2(&runner, &dir("dlfail")) {
        Webview2Outcome::Failed(msg) => {
            assert!(msg.contains("could not download"), "{msg}");
            assert!(
                msg.contains("connection reset"),
                "must keep the cause: {msg}"
            );
        }
        other => panic!("expected Failed, got {other:?}"),
    }
    assert!(runner.verified.borrow().is_empty());
    assert!(runner.ran.borrow().is_empty());
}

#[test]
fn an_installer_that_fails_is_reported() {
    let mut runner = FakeRunner::new(vec![false, false]);
    runner.bootstrapper = Err(InstallError("exit 1603".to_string()));

    match ensure_webview2(&runner, &dir("runfail")) {
        Webview2Outcome::Failed(msg) => assert!(msg.contains("1603"), "{msg}"),
        other => panic!("expected Failed, got {other:?}"),
    }
}

/// A non-zero exit is not the verdict either: if the runtime is there
/// afterwards, the installer must start rather than refuse on a working PC.
#[test]
fn an_installer_that_exits_non_zero_but_leaves_a_runtime_counts_as_installed() {
    let mut runner = FakeRunner::new(vec![false, true]);
    runner.bootstrapper = Err(InstallError("exit 3010".to_string()));

    assert_eq!(
        ensure_webview2(&runner, &dir("nonzero-ok")),
        Webview2Outcome::Installed
    );
}

/// Availability is re-checked AFTER the installer runs rather than trusting
/// its exit code -- the same "confirm, do not assume" lesson the uninstall
/// learned. An installer that reports success while leaving no runtime is a
/// distinct, stranger state than an outright failure, and says so.
#[test]
fn a_successful_installer_that_leaves_no_runtime_is_not_reported_as_success() {
    let runner = FakeRunner::new(vec![false, false]);
    assert_eq!(
        ensure_webview2(&runner, &dir("still-missing")),
        Webview2Outcome::RanButStillMissing
    );
    assert_eq!(runner.ran.borrow().len(), 1, "it did run");
}
