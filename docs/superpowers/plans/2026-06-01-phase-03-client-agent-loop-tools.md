# Phase 3 Client Agent Loop And Tool Dispatch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the client-side agent loop that consumes SSE, dispatches tools, appends observations, and terminates sessions deterministically.

**Architecture:** The loop lives in `mpy-hardware-extension/src/core` and is UI-independent. It uses injected executors for API, shim, and UI prompts so tests can run with fake streams and fake tools.

**Tech Stack:** TypeScript, Node.js test runner, zod, fetch/SSE parser, fake transport tests.

---

## File Structure

Create or modify:

```text
mpy-hardware-extension/src/core/
  session-state.ts
  sse-client.ts
  tool-registry.ts
  tool-dispatch.ts
  context-builder.ts
  agent-loop.ts
  termination.ts
  observations.ts
mpy-hardware-extension/test/
  sse-client.test.ts
  tool-dispatch.test.ts
  context-builder.test.ts
  agent-loop.test.ts
  termination.test.ts
```

## Task 1: Session State And Observations

**Files:**
- Create: `src/core/session-state.ts`
- Create: `src/core/observations.ts`
- Create: `test/termination.test.ts`

- [ ] **Step 1: Define session model**

Fields:

- `traceId`
- `intent`
- `boardId`
- `turnSeq`
- `repairRound`
- `loadedSkills`
- `messages`
- `lastRuntimeMarker`

- [ ] **Step 2: Test observation normalization**

Tests must assert:

- Large `read_serial_until` outputs are truncated to tail content.
- Tool errors keep `error_kind`.
- Observations are serializable into Anthropic-compatible `tool_result` blocks.

- [ ] **Step 3: Verify**

Run:

```powershell
cd mpy-hardware-extension
node --test --import tsx test/termination.test.ts
```

Expected: session and observation helpers pass.

## Task 2: SSE Client Parser

**Files:**
- Create: `src/core/sse-client.ts`
- Create: `test/sse-client.test.ts`

- [ ] **Step 1: Test Anthropic SSE event parsing**

Use scripted SSE events for:

- text delta
- tool use start
- input JSON delta
- message stop
- stream error
- first text starts with `<not_hardware>`

- [ ] **Step 2: Implement parser**

Parser must emit typed events:

- `text_delta`
- `thinking_delta`
- `tool_use_complete`
- `message_stop`
- `not_hardware_detected`
- `stream_error`

- [ ] **Step 3: Verify**

Run:

```powershell
node --test --import tsx test/sse-client.test.ts
```

Expected: parser reconstructs tool input JSON and detects not-hardware first text.

## Task 3: Tool Registry And Dispatch

**Files:**
- Create: `src/core/tool-registry.ts`
- Create: `src/core/tool-dispatch.ts`
- Create: `test/tool-dispatch.test.ts`

- [ ] **Step 1: Add tests for executor routing**

Tests must assert:

- `query_board_profile`, `propose_manifest`, `audit_code`, `load_skill`, `generate_code` route to local executors.
- `search_packages`, `resolve_package_candidates`, `get_package_context` route to API proxy.
- `scan_device`, `install_package`, `write_main_py`, `flash_and_run`, `read_serial_until` route to shim.
- `ask_user` routes to UI prompt executor.
- Unknown tool returns `UnknownToolError` observation, not a thrown crash.

- [ ] **Step 2: Implement registry**

Use the canonical 14 tool names from `docs/specs/04-coding-harness-design.md`.

- [ ] **Step 3: Verify**

Run:

```powershell
node --test --import tsx test/tool-dispatch.test.ts
```

Expected: every canonical tool routes to exactly one executor.

## Task 4: Context Builder

**Files:**
- Create: `src/core/context-builder.ts`
- Create: `test/context-builder.test.ts`

- [ ] **Step 1: Add tests**

Tests must assert:

- Foundational skills are always included.
- Loaded task skills are included only after `load_skill`.
- Board profile brief is included.
- Package index summary is included.
- Tool catalog summary is included.
- Context builder never includes raw serial output longer than the truncation limit.

- [ ] **Step 2: Implement context builder**

Inputs must be cache/content objects fetched from the API content endpoints. Tests use mocked content objects with the same shape.

- [ ] **Step 3: Verify**

Run:

```powershell
node --test --import tsx test/context-builder.test.ts
```

Expected: system blocks are deterministic and bounded.

## Task 5: Agent Loop With Fake SSE Streams

**Files:**
- Create: `src/core/agent-loop.ts`
- Create: `test/agent-loop.test.ts`

- [ ] **Step 1: Add scripted stream tests**

Test these scenarios:

- Happy path: tool calls package search, context lookup, manifest proposal, code generation, package install, flash, serial read, final answer.
- `not_hardware`: first text triggers terminal `not_hardware` and no tools run.
- Tool hallucination: unknown tool returns observation and the loop continues.
- Manifest validator failure: loop appends invalid manifest observation.
- Serial success marker: loop terminates success only after expected marker is observed.
- Max turns: terminal `max_turns` after 20 turns.
- Repair exhausted: terminal `repair_exhausted` after 3 runtime repair attempts.

- [ ] **Step 2: Implement loop**

Keep UI out of the loop. Accept callbacks:

- `onEvent`
- `confirmTool`
- `askUser`
- `apiClient`
- `shimClient`
- `sseClient`

- [ ] **Step 3: Verify**

Run:

```powershell
node --test --import tsx test/agent-loop.test.ts
npm run typecheck
```

Expected: scripted sessions pass without network or hardware.

## Task 6: API Client Integration Tests

**Files:**
- Create: `src/core/api-client.ts`
- Create: `test/api-client.test.ts`

- [ ] **Step 1: Add tests with mocked fetch**

Tests must assert:

- Package search maps API JSON into tool observations.
- Driver context missing maps to `driver_context_missing`.
- `/v1/tools` mismatch produces a warning event.
- SSE interruption becomes `sse_stream_interrupted`.

- [ ] **Step 2: Implement API client**

Use fetch injection for tests.

- [ ] **Step 3: Verify**

Run:

```powershell
node --test --import tsx test/api-client.test.ts
```

Expected: API client handles success and structured failures.

## Phase 3 Exit Verification

Run:

```powershell
cd mpy-hardware-extension
npm test
npm run typecheck
```

Expected:

- Agent loop passes all fake-stream scenarios.
- No test requires a real LLM, API server, VS Code, or hardware.

## Phase 3 Acceptance Checklist

Automated acceptance:

```powershell
cd mpy-hardware-extension
npm test
npm run typecheck
```

Scenario acceptance:

- Scripted happy path reaches terminal `success` only after serial success marker observation.
- `not_hardware` first text terminates before any tool dispatch.
- Unknown tool names become structured observations, not crashes.
- `generate_code` fails with `driver_context_missing` if context was not loaded.
- `audit_code` uses board modules plus driver-context imports.
- `repair_exhausted` triggers after the defined repair-round limit.
- API client preserves structured package errors such as `driver_context_missing`.

Blocking failures:

- Agent loop requires a real LLM to pass tests.
- Tool dispatch bypasses the canonical registry.
- Package tools implement ranking locally instead of calling API client wrappers.
