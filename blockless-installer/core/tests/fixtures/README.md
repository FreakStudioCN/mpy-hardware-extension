# Fixtures

`vscode-update-api.darwin-universal.json` is a REAL response, captured from
`GET https://update.code.visualstudio.com/api/update/darwin-universal/stable/latest`
on the macOS acceptance rig on 2026-09-09.

It replaced a hand-authored stand-in named `...SHAPE.json`, which existed
because no environment with a route to that host had ever run this. The
replacement is a required acceptance step per `/scope.md`, not cleanup, and it
was worth doing: the real payload carries a `notes` field the stand-in did not
have. An invented fixture asserts a shape nobody has observed, so its parse test
only proves the parser agrees with whoever wrote the fixture.

The stand-in's `sha256hash` was deliberately all-zeros rather than a
plausible-looking 64-hex string, so nobody downstream could mistake it for a
real digest. The captured file carries a genuine digest, and
`resolver_parses_the_captured_response` asserts it by shape (64 hex characters,
not all-zeros) rather than by literal value, so the test does not need editing
on every VS Code release.

## Re-capturing it

The version-specific values here go stale with each VS Code release. That is
expected: this fixture pins the SHAPE, and `live_update_api.rs`'s rig-only
ignored test is what checks that the live response still matches it. Only
re-capture when that test fails, meaning the API's shape actually changed.

On a machine with a route to the host:

1. `curl https://update.code.visualstudio.com/api/update/darwin-universal/stable/latest`
   and save the raw body over `vscode-update-api.darwin-universal.json`.
2. Update the `productVersion` assertion in
   `core/src/manifest.rs`'s `resolver_parses_the_captured_response`, and the
   capture date in `CAPTURED_UPDATE_API`'s doc comment.
3. `cargo test --test live_update_api -- --ignored` to confirm the live
   response parses against what you just recorded.

Only the fields `VscodeUpdateApiResponse` reads (`url`, `sha256hash`,
`productVersion`) are load-bearing; the rest are kept so the fixture stays a
faithful copy of a real payload rather than a trimmed one.
