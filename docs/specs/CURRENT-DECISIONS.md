# Current Decisions

This file is the single active spec for the current MVP. It records decisions
that constrain implementation. Do not add historical design text here; if a
decision changes, update this file and the code/tests in the same change.

Last updated: 2026-06-03

## Product Boundary

- The product is a MicroPython hardware coding agent for building and running
  code on supported boards from natural language hardware intent.
- ESP32 devices are allowed to use device-side networking when the board profile
  declares the required MicroPython modules.
- Hardware support is not limited to the golden path. The golden path is only
  an acceptance sample; package intelligence and driver contexts define the
  broader support surface.

## Runtime Architecture

- The agent loop runs in the VS Code extension, not in `mpyhw-api`.
- `mpyhw-api` is a backend service for auth, credits, LLM provider proxying,
  board/package/tool content, and telemetry.
- The Python shim only handles local device IO: scan, package install, file
  write, flash/run, and serial read. It must not contain LLM, manifest, audit,
  or package-selection logic.
- Device-touching actions are gated by the extension UI before deploy.

## LLM Provider

- The current backend uses a provider adapter. The default provider is
  DeepSeek/OpenAI-compatible chat completions.
- The client consumes the backend's normalized SSE event shape. Do not assume
  raw Anthropic pass-through behavior.
- `/v1/llm/messages` is protected by session auth and metered credits.
- `/v1/credits` is the active balance endpoint. `/v1/quota` is obsolete.

## Board Profiles

- `board.available_modules` is the authoritative allowlist for built-in
  MicroPython modules available on a board.
- Driver contexts add allowed import names for installed or generated driver
  modules.
- Built-in Espressif profiles declare:
  - `machine`
  - `time`
  - `math`
  - `json`
  - `network`
  - `socket`
  - `ssl`
- Therefore `import network`, `import socket`, and `import ssl` are allowed for
  ESP32-S3 and ESP32-C3 when those profiles are selected.
- If a board's firmware differs, the profile must be updated from real device
  capability probing or verified firmware data. Do not solve profile mismatch
  by bypassing audit.

## Code Audit

- `audit_code` allows imports only from:
  - `board.available_modules`
  - resolved driver context `import_names`
- `__import__`, `exec`, and `eval` are always banned because they bypass static
  audit.
- The agent must never recommend hiding imports or bypassing audit.
- If audit rejects generated code, valid repairs are:
  - regenerate using allowed modules,
  - select or update a compatible board profile,
  - fetch the missing driver context,
  - ask the user for a product-level tradeoff.

## Code Generation

- Codegen must be grounded on the selected board profile, manifest, and resolved
  driver contexts.
- The agent must fetch package context before using a package API.
- The agent must not invent driver APIs, constructors, import names, or pin
  roles.
- Multi-file projects are allowed only when needed. Simple projects should stay
  as a single `main.py`.

## Manifest And Pins

- The manifest is the deterministic contract between intent, selected packages,
  wiring, and generated code.
- Pin allocation must satisfy `board.pin_capabilities`.
- `pin_recommendations` are preferred defaults, not proof that any arbitrary
  role is legal on the pin.
- Physical wiring that cannot be inferred must be confirmed through `ask_user`
  or the deploy checkpoint UI.

## Tools

- Canonical tools are the only tools the LLM may call.
- Tool execution is categorized as:
  - local extension logic,
  - backend package/content calls,
  - local Python shim calls,
  - UI prompts.
- Unknown tools return structured errors instead of crashing the loop.
- Tool registry mismatch between client and backend should block or clearly
  warn before a session starts.

## Package Intelligence

- Package search, package resolution, and driver-context extraction are backend
  responsibilities.
- The extension must not reimplement package ranking or driver-context
  extraction.
- Generated code may only use package APIs that are present in driver context.

## Session Flow

- The normal flow is:
  1. understand hardware intent,
  2. query board profile,
  3. resolve package candidates,
  4. fetch driver context,
  5. propose manifest,
  6. confirm plan,
  7. generate code,
  8. audit code,
  9. deploy through shim,
  10. read serial output.
- The agent should drive the workflow with tools, not plain-text menus.
- Plain assistant text is only for summaries, explanations, or cases where the
  current request is complete.

## User Interaction

- If the agent needs user input to proceed, it must call `ask_user`.
- It must not ask an answer-required question only as plain assistant text.
- Plan confirmation and deploy readiness are owned by the host UI, not by
  conversational text from the agent.

## Current Non-Goals

- Do not maintain multiple active specs for the same behavior.
- Do not keep legacy Anthropic pass-through, quota, or intent-gate descriptions
  as current design constraints.
- Do not add roadmap details here unless they constrain current implementation.
- Do not archive deleted specs as "legacy" active docs. Historical recovery is
  available through git.
