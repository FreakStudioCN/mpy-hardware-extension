//! Rig-only: proves the real update API's response still parses as
//! `VscodeUpdateApiResponse`, i.e. still matches
//! `tests/fixtures/vscode-update-api.darwin-universal.json` -- which is now a
//! REAL capture, taken on the macOS acceptance rig on 2026-09-09, replacing
//! the hand-authored stand-in that stood in for one until then. Never run in
//! CI or the sandbox: both lack a route to `update.code.visualstudio.com`
//! (see `/scope.md`, "No live third-party endpoints in CI").
//!
//! This failing is the signal to re-capture, and the only one: the fixture's
//! version-specific values go stale with every VS Code release, which does not
//! matter, because what it pins is the SHAPE. See `tests/fixtures/README.md`.

use blockless_installer_core::manifest::VscodeUpdateApiResponse;

#[test]
#[ignore = "hits the real VS Code update API; run explicitly on the acceptance rig"]
fn live_response_still_matches_captured_shape() {
    let body = reqwest::blocking::get(
        "https://update.code.visualstudio.com/api/update/darwin-universal/stable/latest",
    )
    .expect("request to the VS Code update API failed")
    .text()
    .expect("could not read the response body");
    VscodeUpdateApiResponse::parse(&body)
        .expect("live response no longer matches the hand-authored shape fixture");
}
