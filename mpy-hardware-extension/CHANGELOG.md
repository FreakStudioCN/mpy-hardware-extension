# Changelog

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
