# Changelog

## 0.4.3

- Build loop refuses evidence it cannot trust: a deploy needs a real upload record, a final reset needs an observed reboot, phase results must be a known verdict — and it names what it cannot fix instead of looping; a stalled phase reports its reason.
- Refusals and tool results are actionable so the loop converges; replayed conversations are bounded and the working indicator stays visible.
- Serial page streams live device output (was a file list); Env page lets you pick the serial port instead of forcing COM-port deletion.
- Device Tools: export a single upload-ready folder for the board; Sipeed MaixPy vision-module export, grounded in references.
- Approval cards let you add components to the device list; BOM renders procurement search queries and purchase links.
- Recent Sessions render a past session as chat instead of opening its raw log; panel auto-open no longer reports a failed reveal as a fault.
- Boards that reset on open are reached reliably; the device shim stages and verifies by path.
- Backend: OpenAI provider available behind `MPYHW_LLM_PROVIDER` (DeepSeek stays default); token budget follows the provider; a thinking model's stream is kept alive and each phase gets what it needs injected.
- One-click installer scripts for macOS and Windows.
- Internal: e2e verdict reads the run and a phase can be resumed; every gate message is graded on every baseline run; MicroPython_Skills pin moved to 5ab8e9c.

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
