import assert from "node:assert/strict";
import test from "node:test";

import { executeProtocolTool, runProtocolBuild } from "../src/core/protocol-loop.ts";

const tu = (id: string, name: string, input: any) => ({ type: "tool_use_complete", id, name, input });
const stop = { type: "message_stop" };

// Collect every corrective message the loop appended to the conversation.
function correctives(bodies: any[]): string[] {
  const out: string[] = [];
  for (const message of bodies[bodies.length - 1]?.messages ?? []) {
    if (message.role !== "user" || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (block.type === "text" && String(block.text).startsWith("Quality gate failed")) out.push(block.text);
    }
  }
  return out;
}

function recordingLlm(turns: (n: number) => any[]) {
  const bodies: any[] = [];
  return {
    bodies,
    client: {
      streamMessages: async (b: any) => {
        bodies.push(JSON.parse(JSON.stringify(b)));
        const events = turns(bodies.length);
        return (async function* () { for (const e of events) yield e; })();
      },
    },
  };
}

// A gate report's entries come in two REAL shapes, and gateEntryReason has read both since the
// stall detail was fixed. The corrective path still required `.code`, so every STRING entry was
// filtered out -- and the string shape is what the select-hw and analyze validators emit
// (update_manifest.py and init_manifest.py append plain sentences to `errors`). The phases that
// fail on a malformed manifest got no corrective message at all.
test("a string-shaped gate report still names what failed", async () => {
  const report = JSON.stringify({ errors: ["missing required field: project_name", "devices must not be empty"] });
  const { bodies, client } = recordingLlm((n) => n === 1
    ? [tu("g1", "script_run", { interpreter: "python", script: "init_manifest.py" }), stop]
    : [tu("p1", "phase_complete", { result: "success", next_phase: null }), stop]);

  await runProtocolBuild(
    { intent: "x", traceId: "t", maxTurnsPerPhase: 4 },
    { llmClient: client, runScript: async () => ({ ok: true, success: false, stdout: report }) } as any,
  );

  const messages = correctives(bodies);
  assert.equal(messages.length, 1, `expected one corrective message, got ${messages.length}`);
  assert.match(messages[0], /- missing required field: project_name/);
  assert.match(messages[0], /- devices must not be empty/);
  // The name is the entry itself, not an "undefined:" prefix from a missing code.
  assert.doesNotMatch(messages[0], /undefined/);
});

// apply_scaffold serializes the SAME python list at the top level and inside
// phase_complete.payload, so reading both sources concatenated printed every scaffold error
// twice and spent ten corrective slots on five real errors.
test("a scaffold report carried at both paths is enumerated once", async () => {
  const errors = [
    { code: "SCAFFOLD_LINT_FAILED", message: "firmware/main.py:3:1: F401 'os' imported but unused" },
    { code: "FILE_CONFLICT", message: "target files already exist with different content" },
  ];
  const report = JSON.stringify({ status: "partial", structured_errors: errors, phase_complete: { payload: { structured_errors: errors } } });
  const { bodies, client } = recordingLlm((n) => n === 1
    ? [tu("s1", "script_run", { interpreter: "python", script: "apply_scaffold.py" }), stop]
    : [tu("p1", "phase_complete", { result: "success", next_phase: null }), stop]);

  await runProtocolBuild(
    { intent: "x", traceId: "t", maxTurnsPerPhase: 4 },
    { llmClient: client, runScript: async () => ({ ok: true, success: false, stdout: report }) } as any,
  );

  const [message] = correctives(bodies);
  assert.ok(message, "no corrective message");
  assert.equal(message.match(/SCAFFOLD_LINT_FAILED/g)?.length, 1, message);
  assert.equal(message.match(/FILE_CONFLICT/g)?.length, 1, message);
});

// A stream that dies AFTER tool_use_complete still advanced the protocol: the call arrived
// whole. Ending the phase there threw it away along with every turn before it, and nothing
// retries mid-stream -- withConnectRetries wraps only the awaited streamMessages call, never a
// throw out of it.next(). One transient socket hang-up on turn 50 of 60 ended the run.
test("a stream that dies after a complete tool call keeps the phase alive", async () => {
  const ran: string[] = [];
  let turn = 0;
  const llm = {
    streamMessages: async () => {
      turn += 1;
      if (turn === 1) {
        return (async function* () {
          yield tu("d1", "script_run", { interpreter: "python", script: "check.py" });
          throw new Error("socket hang up");
        })();
      }
      return (async function* () {
        yield tu("d2", "phase_complete", { result: "success", next_phase: null });
        yield stop;
      })();
    },
  };

  const result = await runProtocolBuild(
    { intent: "x", traceId: "t", maxTurnsPerPhase: 6 },
    { llmClient: llm, runScript: async (_i: string, script: string) => { ran.push(script); return { ok: true, success: true, stdout: "{}" }; } } as any,
  );

  assert.deepEqual(ran, ["check.py"], "the completed tool call was discarded");
  assert.equal(result.terminal, "complete");
});

// The same failure with NOTHING to act on is still terminal, and still says why.
test("a stream that dies with no tool call stalls and names the reason", async () => {
  const events: any[] = [];
  const llm = {
    streamMessages: async () => (async function* () {
      yield { type: "text_delta", text: "thinking..." };
      throw new Error("socket hang up");
    })(),
  };

  const result = await runProtocolBuild(
    { intent: "x", traceId: "t", maxTurnsPerPhase: 6, onEvent: (e: any) => events.push(e) },
    { llmClient: llm } as any,
  );

  assert.equal(result.terminal, "stalled");
  const stalled = events.find((e) => e.type === "phase_stalled");
  assert.equal(stalled?.reason, "stream_error");
  assert.match(JSON.stringify(stalled?.detail), /socket hang up/);
});

// `&& deps.readFile` made the scaffold-rendered guard silently absent whenever no reader was
// wired. makeWorkspaceReader and makeWorkspaceWriter go undefined together, so such a run never
// wrote the project either and its scaffold `success` cannot be true. Every other missing dep
// in this file fails loud; this one used to be the exception.
test("a scaffold success with no workspace reader is refused, not waved through", async () => {
  const { result, phaseControl } = await executeProtocolTool(
    tu("p", "phase_complete", { result: "success", next_phase: "upy-generate-plugin" }) as any,
    { intent: "x" } as any,
    {} as any,
    { phase: "upy-scaffold-plugin", turn: 3 },
  );
  assert.equal(result.ok, false);
  assert.equal(result.error_kind, "workspace_unavailable");
  assert.equal(phaseControl, undefined, "the phase advanced on an unverifiable success");
});

test("a scaffold success is accepted when the marker really is there", async () => {
  const { result, phaseControl } = await executeProtocolTool(
    tu("p", "phase_complete", { result: "success", next_phase: "upy-generate-plugin" }) as any,
    { intent: "x" } as any,
    { readFile: async () => ({ ok: true, content: "" }) } as any,
    { phase: "upy-scaffold-plugin", turn: 3 },
  );
  assert.equal(result.ok, true);
  assert.equal(phaseControl?.result, "success");
});

// The write side was closed ("never record a generated file body") but the READ side puts the
// same body into session.jsonl and the consented cloud tool_dispatch payload -- and the model
// reads a file back before it rewrites one, so it is the easier path to hit. conf.py is where
// this product puts credentials.
test("a file read does not record the file's content in telemetry", async () => {
  const events: any[] = [];
  const secret = 'WIFI_PASSWORD = "hunter2-this-must-not-be-recorded"\nSSID = "home"\n';
  const { bodies, client } = recordingLlm((n) => n === 1
    ? [tu("r", "file_operation", { op: "read", path: "firmware/conf.py" }), stop]
    : [tu("p1", "phase_complete", { result: "success", next_phase: null }), stop]);

  await runProtocolBuild(
    { intent: "x", traceId: "t", maxTurnsPerPhase: 4, onEvent: (e: any) => events.push(e) },
    { llmClient: client, readFile: async () => ({ ok: true, content: secret }) } as any,
  );

  // The MODEL still gets the real file: this is a telemetry rule, not a capability change.
  assert.match(JSON.stringify(bodies[bodies.length - 1].messages), /hunter2/);
  const recorded = JSON.stringify(events.filter((e) => e.type === "tool_result"));
  assert.ok(!recorded.includes("hunter2"), recorded);
  assert.match(recorded, /chars [0-9a-f]{8}/, "the body was dropped without its length and digest");
});

// The over-cap alarm has to be recorded as ITSELF. The controller's catch-all wraps an unknown
// event as a trace_event, and that mapper returns null for this one -- so without its own
// branch the alarm is counted as telemetry_dropped and never reaches the cloud DB.
test("the controller records history_over_cap instead of burying it in a trace_event", async () => {
  const { SessionController } = await import("../src/extension/session-controller.ts");
  const recorded: any[] = [];
  const posted: any[] = [];
  const controller = new SessionController({
    postMessage: (m: any) => posted.push(m),
    recorderFactory: () => ({ record: async (e: any) => { recorded.push(e); } }),
    loop: async ({ onEvent }: any) => {
      onEvent({ type: "history_over_cap", phase: "upy-generate-plugin", chars: 512_345, turn: 41 });
      return { terminal: "complete" };
    },
  } as any);

  await controller.start({ intent: "x", boardId: "auto" });

  const alarm = recorded.find((e) => e.type === "history_over_cap");
  assert.ok(alarm, "history_over_cap was not recorded as itself");
  assert.equal(alarm.chars, 512_345);
  assert.equal(alarm.phase, "upy-generate-plugin");
  // Record-only: "487,320 chars on turn 41" is triage material, not something a user can act on.
  assert.ok(!posted.some((m) => m.type === "history_over_cap"), "the alarm was pushed to the webview");
});
