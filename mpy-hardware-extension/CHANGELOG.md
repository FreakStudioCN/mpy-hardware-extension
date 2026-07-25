# Changelog

## 0.4.2

- Session restore: reopening VS Code replays your previous build — narration, answered cards (inert, with the chosen option marked), diagram tab, and activity feed — instead of a blank panel.
- Restore hardening: restore is refused while a save is in progress; malformed or path-traversal trace ids are rejected.
- Approval cards now highlight the chosen option on live cards too.
- Marketplace listing: searchable display name ("Blockless — MicroPython Hardware Builder") and expanded keywords.

## 0.4.1

- Point the default backend at the new hosted address (`blockless.upypi.net`); the previous default host was retired.

## 0.4.0

- 6 boards with full pin-aware profiles (was 3): + ESP32 DevKit V1, Raspberry Pi Pico, ESP8266 NodeMCU.
- Stuck builds now say "Build got stuck" with a one-click retry (previously silent).
- Generate phase is more reliable: deterministic cleanup before quality gates, turn-0 hallucination guard, precise gate-failure corrections.
- Pinned Python toolchain — quality gates no longer drift with upstream lint releases.
- Per-user daily cap support + admin usage rollup (server-side).

## 0.3.0

First public release.

- Default to the hosted backend; the API URL is now configurable via the
  `mpyhw.apiBaseUrl` setting (with an `MPYHW_API_BASE` dev override).
- Marketplace packaging via `@vscode/vsce` with full listing metadata and a PNG
  icon.
- Proprietary license.
