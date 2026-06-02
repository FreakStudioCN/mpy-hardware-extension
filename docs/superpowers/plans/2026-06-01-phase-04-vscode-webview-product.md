# Phase 4 VS Code WebView Product Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the usable VS Code extension shell around the working agent loop: intent input, device selection, trace, manifest/code preview, serial output, confirmations, and ask-user prompts.

**Architecture:** VS Code Extension Host owns commands, lifecycle, Python/shim process, and agent loop. WebView owns rendering and user input only. Hardware side effects always pass through Extension Host confirmations.

**Tech Stack:** VS Code Extension API, TypeScript, WebView HTML/CSS/TS, xterm.js, Monaco or lightweight code preview for MVP.

---

## File Structure

Create or modify:

```text
mpy-hardware-extension/
  package.json
  src/extension/
    activate.ts
    commands.ts
    shim-process.ts
    python-env.ts
    device-picker.ts
    session-controller.ts
    workspace-writer.ts
  src/webview/
    panel.ts
    index.html
    app.ts
    styles.css
    protocol.ts
  test/
    extension-protocol.test.ts
    python-env.test.ts
    shim-process.test.ts
    workspace-writer.test.ts
```

## Task 1: Extension Activation And Commands

**Files:**
- Create: `src/extension/activate.ts`
- Create: `src/extension/commands.ts`
- Modify: `package.json`

- [ ] **Step 1: Add extension entry and command contribution**

Add command:

- `mpyhw.openPanel`

Activation event:

- `onCommand:mpyhw.openPanel`

- [ ] **Step 2: Verify command registration**

Run:

```powershell
cd mpy-hardware-extension
npm run typecheck
```

Expected: extension entry typechecks.

## Task 2: WebView Protocol

**Files:**
- Create: `src/webview/protocol.ts`
- Create: `test/extension-protocol.test.ts`

- [ ] **Step 1: Define message protocol**

Messages from WebView to Extension Host:

- `start_session`
- `cancel_session`
- `answer_prompt`
- `select_device`
- `approve_confirm`
- `reject_confirm`

Messages from Extension Host to WebView:

- `session_event`
- `trace_event`
- `manifest_updated`
- `code_updated`
- `serial_output`
- `confirm_needed`
- `ask_user_needed`
- `session_done`
- `session_error`

- [ ] **Step 2: Test runtime validation**

Tests must reject unknown message types and malformed payloads.

- [ ] **Step 3: Verify**

Run:

```powershell
node --test --import tsx test/extension-protocol.test.ts
```

Expected: protocol validator accepts only known messages.

## Task 3: Python Environment And Shim Process

**Files:**
- Create: `src/extension/python-env.ts`
- Create: `src/extension/shim-process.ts`
- Create: `test/python-env.test.ts`
- Create: `test/shim-process.test.ts`

- [ ] **Step 1: Test Python discovery order**

Tests must cover:

- user setting path wins
- VS Code Python extension path is used when available
- PATH fallback is used
- no Python returns a typed error

- [ ] **Step 2: Test shim JSON-RPC framing**

Use a fake child process stream. Assert:

- requests include JSON-RPC `id`, `method`, `params`
- responses resolve the matching promise
- stderr emits diagnostic events
- child crash returns `shim_crash`

- [ ] **Step 3: Implement**

Implement discovery and shim process wrapper. Do not install packages during unit tests; inject process/exec dependencies.

- [ ] **Step 4: Verify**

Run:

```powershell
node --test --import tsx test/python-env.test.ts test/shim-process.test.ts
npm run typecheck
```

Expected: shim lifecycle is tested without starting real Python.

## Task 4: Device Picker And Workspace Writer

**Files:**
- Create: `src/extension/device-picker.ts`
- Create: `src/extension/workspace-writer.ts`
- Create: `test/workspace-writer.test.ts`

- [ ] **Step 1: Device picker behavior**

Device picker calls shim `device.scan`, presents available ports, and returns selected `{port, boardId}`.

- [ ] **Step 2: Workspace writer tests**

Tests must assert:

- `main.py` and `manifest.json` are written to the selected workspace folder.
- Existing user files are not overwritten without explicit confirm.
- Generated artifacts are grouped under a predictable path if no workspace is open.

- [ ] **Step 3: Verify**

Run:

```powershell
node --test --import tsx test/workspace-writer.test.ts
```

Expected: file writes are scoped and safe.

## Task 5: WebView UI

**Files:**
- Create: `src/webview/panel.ts`
- Create: `src/webview/index.html`
- Create: `src/webview/app.ts`
- Create: `src/webview/styles.css`

- [ ] **Step 1: Build first screen**

First viewport must show the actual tool:

- device selector
- quota/status line
- intent textarea
- start/cancel controls
- current progress trace
- code preview
- serial output

- [ ] **Step 2: Wire messages**

WebView sends `start_session`; Extension Host streams session events back.

- [ ] **Step 3: Verify manually in Extension Development Host**

Run:

```powershell
npm run typecheck
```

Then launch Extension Development Host from VS Code and run `mpyhw.openPanel`.

Expected:

- Panel opens.
- Start button sends `start_session`.
- Fake/dev mode session can populate trace, manifest, code, and serial panels.

## Task 6: Session Controller Integration

**Files:**
- Create: `src/extension/session-controller.ts`

- [ ] **Step 1: Connect WebView to Phase 3 agent loop**

The controller wires:

- `onEvent` -> WebView trace messages
- `confirmTool` -> VS Code confirmation dialog
- `askUser` -> WebView ask-user component
- shim executor -> `ShimProcess`
- API executor -> Phase 3 API client

- [ ] **Step 2: Test with fake agent loop**

Unit test the controller with a fake loop that emits events and asks for confirmation.

- [ ] **Step 3: Verify manually**

Run in Extension Development Host with fake SSE mode.

Expected:

- User sees trace updates.
- Confirm dialog appears for write/install/run.
- Rejecting confirm terminates with clear UI state.
- Approving confirm continues.

## Phase 4 Exit Verification

Run:

```powershell
cd mpy-hardware-extension
npm test
npm run typecheck
```

Manual verification:

- Extension Development Host opens panel.
- Fake session renders complete trace.
- Real Phase 1/Phase 3 local pipeline can display generated manifest and code.

## Phase 4 Acceptance Checklist

Automated acceptance:

```powershell
cd mpy-hardware-extension
npm test
npm run typecheck
```

Manual UI acceptance in Extension Development Host:

- `mpyhw.openPanel` opens the WebView without console errors.
- First screen shows device selector, quota/status, intent input, start/cancel, trace, code preview, and serial output areas.
- `start_session` from WebView reaches Extension Host.
- A fake/dev session renders trace events, manifest preview, generated code, and serial output.
- Hardware-mutating tools require confirmation.
- Rejecting confirmation terminates with clear state.
- `ask_user` prompt can be answered from the WebView and resumes the session.

Blocking failures:

- WebView can trigger install/write/run without Extension Host confirmation.
- Generated files overwrite existing user files without explicit confirmation.
- UI cannot display structured terminal errors from the agent loop.
