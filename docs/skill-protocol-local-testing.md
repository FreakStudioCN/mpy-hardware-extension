# Skill Protocol Local Testing Guide

This guide is for the person editing the MicroPython project-generation skills.
Use it before testing against the cloud backend or real hardware.

## Goal

A skill change is acceptable only if its intended actions can be expressed through
the plugin protocol and the VS Code extension can execute those actions locally.

The local fixture path tests that boundary without:

- a running `mpyhw-api`
- a database
- DeepSeek
- Render
- a connected board

## Who Tests What

The skill author tests first.

Their job is to prove that the skill's workflow can be represented as protocol
messages:

- ask the user with `approval_request`
- report progress with `status_update`
- write or read project files with `file_operation`
- run local toolchain scripts with `script_run`
- operate the board with `device_command`
- end every phase with `phase_complete`

The plugin author tests second, using the same fixture, to prove the extension
can render the UI, write files, call local tools, and advance phases.

This separates skill/protocol problems from server/client/hardware problems.

## First Local Check

From `mpy-hardware-extension/`:

```powershell
npm run protocol:fixture -- test/fixtures/protocol-smoke.json
```

Expected shape:

```text
terminal=complete
phases=analyze:success -> generate:success
files=firmware/main.py
approvals=1
device_calls=(none)
script_runs=(none)
```

If this fails, do not test the cloud backend yet. The local protocol boundary is
not valid.

## Fixture Format

A fixture is a JSON file with an `intent` and a `script`. The `script` is keyed
by phase. Each phase contains model turns. Each turn contains the protocol tool
calls the model would emit.

Minimal shape:

```json
{
  "intent": "make an ESP32 temperature alarm",
  "script": {
    "analyze": [
      [
        {
          "name": "approval_request",
          "input": {
            "approval_id": "device_confirm",
            "question": "Confirm parts?",
            "items": [{ "id": "sensor", "name": "Temperature sensor" }],
            "actions": [{ "label": "Confirm", "value": "confirm", "primary": true }]
          }
        }
      ],
      [
        {
          "name": "phase_complete",
          "input": {
            "result": "success",
            "summary": "Analysis complete",
            "next_phase": "generate",
            "manifest_content": { "phase": "analyze" }
          }
        }
      ]
    ]
  }
}
```

Every phase must eventually emit `phase_complete`. If it does not, the fixture
will end as `stalled`.

## Skill Author Checklist

For each changed skill phase:

1. Write or update a fixture that represents the intended happy path.
2. Run `npm run protocol:fixture -- <fixture-path>`.
3. Confirm `terminal=complete`.
4. Confirm the phase list matches the intended workflow.
5. Confirm required files appear under `files=...`.
6. Confirm user interactions appear under `approvals=...`.
7. Confirm device operations appear under `device_calls=...` only when that phase
   should touch hardware.
8. Confirm local scripts appear under `script_runs=...` only when the phase should
   run host tools.

Then run the focused extension checks:

```powershell
node --no-warnings --experimental-strip-types --test test/protocol-fixture.test.ts test/protocol-loop.test.ts
npm run typecheck
```

## Interpreting Failures

`terminal=stalled`

The phase did not emit `phase_complete`, or the fixture ran out of turns.

`unknown_tool`

The skill or server adapter is still producing an old tool name. Convert it to
one of the six protocol tools.

`protocol_payload_invalid`

The tool name is right, but its payload does not match
`contracts/protocol_messages.json`.

`files=(none)`

The workflow did not write files through `file_operation`.

`approvals=0`

The workflow did not ask the user through `approval_request`. If the user needs
to choose or confirm anything, this is a skill/protocol issue.

## After Local Fixture Passes

Only then move outward:

1. Backend prompt/contract tests in `mpyhw-api`.
2. Real-model protocol smoke or headless E2E.
3. VS Code F5/manual UI test.
4. Cloud backend test.
5. Real hardware test.

Do not start with cloud or hardware. That mixes too many failure sources and
makes it unclear whether the problem is the skill, the protocol adapter, the
plugin, the server, or the board.
