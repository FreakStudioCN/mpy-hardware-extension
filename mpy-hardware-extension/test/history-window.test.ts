import assert from "node:assert/strict";
import test from "node:test";

import { runProtocolBuild } from "../src/core/protocol-loop.ts";
import { blockTextLength, boundHistory, historyChars, HISTORY_MAX_CHARS } from "../src/core/history-window.ts";

const tu = (id: string, name: string, input: any) => ({ type: "tool_use_complete", id, name, input });
const stop = { type: "message_stop" };

// The cap counted only `content`/`text` string blocks. An assistant turn carries its payload in
// tool_use.input, which is where a file_operation WRITE puts a whole generated file body -- so
// the generate phase, the one that writes files and the one this cap exists for, was invisible
// to it. Measured before the fix: a 20-turn write phase went out at 614,027 chars while
// historyChars() reported 520, and boundHistory elided nothing at all.
test("a write-heavy phase is bounded: a file body in tool_use.input counts and collapses", async () => {
  const bodies: any[] = [];
  const body30k = "y".repeat(30_000);
  const llm = {
    streamMessages: async (b: any) => {
      bodies.push(JSON.parse(JSON.stringify(b)));
      return (async function* () {
        yield { type: "thinking_delta", text: "z".repeat(2_000) };
        yield tu(`w-${bodies.length}`, "file_operation", { op: "write", path: `firmware/mod_${bodies.length}.py`, content: body30k });
        yield stop;
      })();
    },
  };

  await runProtocolBuild(
    { intent: "x", traceId: "t", startPhase: "upy-generate-plugin", maxTurnsPerPhase: 20 },
    { llmClient: llm, writeFile: async (path: string) => ({ ok: true, path }) } as any,
  );

  const peak = Math.max(...bodies.map((b) => JSON.stringify(b.messages).length));
  assert.ok(bodies.length >= 15, `expected a long phase, got ${bodies.length} turns`);
  assert.ok(peak <= HISTORY_MAX_CHARS, `replayed history went out over the cap: ${peak} chars`);

  // The identity of each call survives; only the body is replaced. A collapsed history the
  // model cannot read is not a fix.
  const last = bodies[bodies.length - 1].messages;
  const writes = last.flatMap((m: any) => (Array.isArray(m.content) ? m.content : [])).filter((b: any) => b.type === "tool_use");
  assert.ok(writes.length > 0, "no tool_use survived");
  for (const w of writes) assert.match(String(w.input.path), /^firmware\/mod_\d+\.py$/);
  assert.ok(writes.some((w: any) => String(w.input.content).startsWith("<elided ")), "no file body was ever collapsed");
});

// Mutation guard for the block accounting itself: each shape must be measured, or the sum is
// wrong in a way only a live run reveals.
test("every block shape contributes its own characters", () => {
  assert.equal(blockTextLength({ type: "tool_result", content: "abcd" }), 4);
  assert.equal(blockTextLength({ type: "text", text: "abcde" }), 5);
  assert.equal(blockTextLength({ type: "thinking", thinking: "abc" }), 3);
  const use = { type: "tool_use", id: "a", name: "file_operation", input: { path: "p", content: "xxxxx" } };
  assert.equal(blockTextLength(use), JSON.stringify(use.input).length);
  assert.equal(blockTextLength({ type: "text" }), 0);
});

// Re-collapsing an already-collapsed body nests the markers and eats 28 characters off the
// surviving head every pass, so a long phase grinds the oldest results down to nothing but
// "<elided ...>" wrappers whose digest describes the previous elision rather than the body.
test("an already-collapsed body is never collapsed a second time", () => {
  const big = "q".repeat(100_000);
  const messages: any[] = [];
  for (let i = 0; i < 12; i += 1) {
    messages.push({ role: "assistant", content: [{ type: "tool_use", id: `t${i}`, name: "script_run", input: { script: "s.py" } }] });
    messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: `t${i}`, content: big }] });
  }

  boundHistory(messages);
  const first = messages[1].content[0].content;
  assert.ok(first.startsWith("<elided 100000 chars "), first.slice(0, 40));

  // Second pass over a history that is still over the cap: the same block must be left alone.
  boundHistory(messages);
  const second = messages[1].content[0].content;
  assert.equal(second, first, "an elided body was elided again");
  assert.equal(second.match(/<elided /g)?.length, 1, "elision markers nested");
});

// The protected recent window alone can exceed the cap (capToolOutput bounds ONE result at 80k
// and a turn can carry several), and the request goes out anyway. Returning silently made the
// next triage of that non-retryable 400 start from "the cap was in place, so this is not size".
test("boundHistory reports failure when the protected window alone is over the cap", () => {
  const messages = Array.from({ length: 6 }, (_, i) => ({
    role: "user",
    content: [{ type: "tool_result", tool_use_id: `t${i}`, content: "w".repeat(100_000) }],
  }));
  assert.ok(historyChars(messages) > HISTORY_MAX_CHARS);
  assert.equal(boundHistory(messages), false);
  // Still over the cap: nothing outside the protected window could be collapsed.
  assert.ok(historyChars(messages) > HISTORY_MAX_CHARS);
});

test("boundHistory reports success when it fits, and when it can collapse its way there", () => {
  assert.equal(boundHistory([{ role: "user", content: "short" }]), true);
  const messages: any[] = [];
  for (let i = 0; i < 12; i += 1) {
    messages.push({ role: "assistant", content: [{ type: "tool_use", id: `t${i}`, name: "script_run", input: { script: "s.py" } }] });
    messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: `t${i}`, content: "q".repeat(60_000) }] });
  }
  assert.equal(boundHistory(messages), true);
  assert.ok(historyChars(messages) <= HISTORY_MAX_CHARS);
});

// A phase whose history cannot be brought under the cap must SAY so; the run continues, but a
// 400 a few turns later needs this line to be diagnosable.
test("a phase that cannot get under the cap emits history_over_cap", async () => {
  const events: any[] = [];
  const huge = "h".repeat(90_000);
  let turns = 0;
  // THREE calls per turn: capToolOutput bounds one result at 80k, so it takes several in the
  // same turn for the 8 protected messages to exceed 480k on their own -- which is exactly the
  // case boundHistory cannot fix and must not stay quiet about.
  const llm = {
    streamMessages: async () => {
      turns += 1;
      return (async function* () {
        // Args carry the turn, so each turn's calls are a DIFFERENT signature. An identical call
        // failing identically is now stopped at the fourth repeat, which would end this phase at
        // 4 turns and it would never build the history this test is about. A real long phase
        // re-runs a gate over changing work, not the byte-identical call forever.
        for (const n of [1, 2, 3]) yield tu(`c-${turns}-${n}`, "script_run", { interpreter: "python", script: "check.py", args: [`--attempt=${turns}`] });
        yield stop;
      })();
    },
  };
  await runProtocolBuild(
    { intent: "x", traceId: "t", startPhase: "upy-generate-plugin", maxTurnsPerPhase: 14, onEvent: (e: any) => events.push(e) },
    // exit_code, not `success`: the loop reads the exit code, and this phase is long because
    // its gate keeps FAILING. Repeating a succeeding call would be stopped as a loop instead,
    // and the history would never reach the cap this test is about.
    { llmClient: llm, runScript: async () => ({ ok: true, exit_code: 1, stdout: huge }) } as any,
  );
  const over = events.filter((e) => e.type === "history_over_cap");
  assert.ok(over.length > 0, "an over-cap request went out with nothing reported");
  assert.ok(over[0].chars > HISTORY_MAX_CHARS, over[0]);
  assert.equal(over[0].phase, "upy-generate-plugin");
});

// The elision marker costs ~28 characters while the head keeps a full 400, so a value just over
// the head budget comes out LONGER than it went in. Collapsing it would make boundHistory grow
// the history it was called to shrink, one negative saving at a time.
test("a body barely over the head budget is left alone, never enlarged", () => {
  const justOver = "s".repeat(401);
  const messages: any[] = [];
  for (let i = 0; i < 12; i += 1) {
    messages.push({ role: "assistant", content: [{ type: "tool_use", id: `t${i}`, name: "script_run", input: { script: "s.py" } }] });
    messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: `t${i}`, content: i === 0 ? justOver : "q".repeat(100_000) }] });
  }
  const before = historyChars(messages);

  boundHistory(messages);

  assert.equal(messages[1].content[0].content, justOver, "a value that cannot shrink was rewritten anyway");
  assert.ok(historyChars(messages) <= before, "boundHistory grew the history it was asked to shrink");
});
