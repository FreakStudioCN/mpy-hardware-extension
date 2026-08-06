import assert from "node:assert/strict";
import test from "node:test";

import { SessionController } from "../src/extension/session-controller.ts";
import { isNetworkRenderDenied } from "../src/core/optional-flow-schema.ts";
import { buildGenDriverDispatch } from "../src/core/gen-driver-schema.ts";

// Let a loop that awaits one gate advance to the next: after resolving the first
// prompt, the loop's continuation (and the next gate's message/record) runs on a
// microtask, so drain a few before inspecting.
const flushMicrotasks = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

test("records protocol status_update and phase_start (not postMessage-only) so the cloud DB sees phase progress", async () => {
  const recorded: any[] = [];
  const controller = new SessionController({
    postMessage: () => { },
    recorderFactory: () => ({ record: async (e: any) => { recorded.push(e); } }),
    loop: async ({ onEvent }) => {
      onEvent({ type: "phase_start", phase: "select-hw" });
      onEvent({ type: "status_update", payload: { title: "正在搜索驱动" } });
      return { terminal: "complete" };
    },
  });

  await controller.start({ intent: "env monitor", boardId: "auto" });

  assert.ok(
    recorded.some((e) => e.type === "phase_start" && e.phase === "select-hw"),
    "phase_start must be recorded — it was postMessage-only, so the cloud DB never saw phase boundaries",
  );
  assert.ok(
    recorded.some((e) => e.type === "status_update" && e.payload?.title === "正在搜索驱动"),
    "status_update must be recorded — it was postMessage-only, so the cloud DB never saw the progress timeline",
  );
});

test("carries start() preferences into the loop input so the server gets the user's context", async () => {
  // Codex review of #3: preferences must reach the loop through the real entry point, not
  // dead-end at the panel. The webview passes the UI locale on start; the controller threads
  // it (and any mode/existing_hardware) into the loop input -> protocol context.
  let loopInput: any = null;
  const controller = new SessionController({
    postMessage: () => { },
    loop: async (input: any) => { loopInput = input; return { terminal: "complete" }; },
  });

  await controller.start({ intent: "x", boardId: "esp32-c3-devkitm-1", preferences: { locale: "zh-cn", mode: "beginner" } });

  assert.equal(loopInput.preferences?.locale, "zh-cn");
  assert.equal(loopInput.preferences?.mode, "beginner");
});

test("carries the recommend board_selection_mode into the loop (not dropped at the host)", async () => {
  // #43: the webview emits board_selection_mode: "recommend" on the no-board path; the host
  // must forward it so the server knows the user asked it to pick, and must clear it on a fresh session.
  const inputs: any[] = [];
  const controller = new SessionController({
    postMessage: () => { },
    loop: async (input: any) => { inputs.push(input); return { terminal: "complete" }; },
  });

  await controller.start({ intent: "recommend me a board", boardId: "auto", boardSelectionMode: "recommend" });
  assert.equal(inputs[0].boardSelectionMode, "recommend", "recommend flag reaches the loop input");

  await controller.start({ intent: "now a specific one", boardId: "rpi-pico-w" }); // fresh session, no flag
  assert.equal(inputs[1].boardSelectionMode, undefined, "a fresh session does not inherit the stale recommend flag");
});

test("a fresh session (board change / reset) does not inherit stale preferences", async () => {
  // Codex review of #3: preferences are session-level; a new board or a reset must not
  // ground an unrelated build with the previous session's context.
  const inputs: any[] = [];
  const controller = new SessionController({
    postMessage: () => { },
    loop: async (input: any) => { inputs.push(input); return { terminal: "complete" }; },
  });

  await controller.start({ intent: "a", boardId: "esp32-c3-devkitm-1", preferences: { existing_hardware: "old gear" } });
  await controller.start({ intent: "b", boardId: "rpi-pico-w" }); // different board, no preferences supplied
  assert.equal(inputs[1].preferences?.existing_hardware, undefined, "a new board's build must not inherit the old session's preferences");

  controller.reset();
  await controller.start({ intent: "c", boardId: "rpi-pico-w" }); // post-reset, no preferences
  assert.equal(inputs[2].preferences?.existing_hardware, undefined, "a reset build must not inherit stale preferences");
});

test("a reset does not leak the recommend board_selection_mode into the next build", async () => {
  // reset() must clear boardSelectionMode like it clears preferences/preSelectedBoard.
  // It sets boardId=null, so the next start()'s board-change clear is skipped — without an
  // explicit clear here, a recommend run leaks the stale flag into a post-reset build that
  // never asked for a recommendation (buildContext then forwards board_selection_mode).
  const inputs: any[] = [];
  const controller = new SessionController({
    postMessage: () => { },
    loop: async (input: any) => { inputs.push(input); return { terminal: "complete" }; },
  });

  await controller.start({ intent: "recommend me a board", boardId: "auto", boardSelectionMode: "recommend" });
  assert.equal(inputs[0].boardSelectionMode, "recommend");

  controller.reset();
  await controller.start({ intent: "a build with no recommend this time", boardId: "auto" }); // post-reset, no flag
  assert.equal(inputs[1].boardSelectionMode, undefined, "a reset build must not inherit the stale recommend flag");
});

test("a reset clears the artifact accumulators so a new session does not surface the prior session's artifacts", async () => {
  // #28 F6: reset() sets boardId=null, so the next start()'s board-change clear is skipped
  // (same trap as boardSelectionMode above). Without an explicit clear, producedPaths and
  // phaseArtifacts persist across Restart, so request_artifacts in the new session would show
  // (and let you open) the previous session's files with stale phase attribution.
  // Only session A produces artifacts; session B's loop is silent, so any artifact present
  // after B starts can only be A's leftovers.
  const controller = new SessionController({
    postMessage: () => { },
    loop: async ({ intent, onEvent }: any) => {
      if (typeof intent === "string" && intent.includes("session A")) {
        onEvent({ type: "phase_complete", payload: { phase: "analyze", artifacts: [{ type: "manifest", path: "project-manifest.json" }] } });
        onEvent({ type: "file_written", path: "/abs/session-a/main.py" });
      }
      return { terminal: "complete" };
    },
  });

  await controller.start({ intent: "session A", boardId: "auto" });
  assert.equal(controller.phaseArtifactRecords().length, 1, "phase-declared artifact captured during session A");
  assert.ok(controller.artifactSources().some((s) => s.absolute_path === "/abs/session-a/main.py"), "loop-written file tracked during session A");

  controller.reset();
  assert.equal(controller.phaseArtifactRecords().length, 0, "reset clears phase-declared artifacts");
  assert.equal(controller.artifactSources().length, 0, "reset clears produced/persisted paths");

  // A post-reset start on the SAME board (boardId was nulled -> board-change clear is skipped)
  // must still begin with an empty accumulator, not session A's leftovers.
  await controller.start({ intent: "session B, produces nothing", boardId: "auto" });
  assert.equal(controller.phaseArtifactRecords().length, 0, "session B does not inherit session A's phase artifacts");
  assert.ok(!controller.artifactSources().some((s) => s.absolute_path === "/abs/session-a/main.py"), "session B does not inherit session A's produced files");
});

test("reset() clears the Save Version accumulators (terminal/diagram/credits) so the next snapshot doesn't inherit them", async () => {
  const controller = new SessionController({
    postMessage: () => { },
    loop: async ({ onEvent }: any) => {
      onEvent({ type: "diagram_updated", diagram: { nodes: ["a"] } });
      onEvent({ type: "credits", remaining: 42, dailyGrant: 100, resetsAt: "2026-07-07T00:00:00Z" });
      return { terminal: "complete" };
    },
  });

  await controller.start({ intent: "acc", boardId: "auto" });
  let snap = controller.getSnapshotState();
  assert.equal(snap.terminal, "complete", "terminal accumulated from the run");
  assert.deepEqual(snap.diagram, { nodes: ["a"] }, "authored diagram accumulated");
  assert.equal(snap.credits?.balance, 42, "credits accumulated");

  // reset() must null ALL THREE. They are cleared on BOTH fresh-session paths (reset() and start()'s
  // board-change block); reset() nulls boardId, so on a reset it is THIS clear that runs. The
  // board-change path is covered by the "REPRO PR#47 blocker 1" test below.
  controller.reset();
  snap = controller.getSnapshotState();
  assert.equal(snap.terminal, null, "reset clears terminal");
  assert.equal(snap.diagram, undefined, "reset clears diagram");
  assert.equal(snap.credits, null, "reset clears credits");
});

test("REPRO PR#47 blocker 1: a board-change fresh session must not inherit the previous session's Save Version accumulators", async () => {
  let call = 0;
  const controller = new SessionController({
    postMessage: () => { },
    loop: async ({ onEvent }: any) => {
      call++;
      if (call === 1) {
        onEvent({ type: "diagram_updated", diagram: { nodes: ["board-A-diagram"] } });
        onEvent({ type: "credits", remaining: 42, dailyGrant: 100, resetsAt: "2026-07-07T00:00:00Z" });
      }
      return { terminal: "complete" }; // run 2 emits NO diagram/credits
    },
  });
  await controller.start({ intent: "blink", boardId: "board-a" });
  // Fresh session via BOARD CHANGE, not reset(): start()'s board-change branch clears state,
  // keyErrors, phaseArtifacts, ... and must clear the three Save Version accumulators too, or
  // board A's authored diagram/credits leak into board B's snapshot.json for session restore.
  await controller.start({ intent: "unrelated project", boardId: "board-b" });
  const snap = controller.getSnapshotState();
  assert.equal(snap.diagram, undefined, "board B's snapshot must not carry board A's authored diagram");
  assert.equal(snap.credits, null, "board B's snapshot must not carry board A's credits");
});

test("seedFromSnapshot restores state/board/preferences without running, and refuses while a run is active", async () => {
  const controller = new SessionController({ postMessage: () => { }, loop: async () => ({ terminal: "complete" }) });
  const ok = controller.seedFromSnapshot({
    state: { manifest: { m: 1 }, phase: "generate", intent: "blink" },
    boardId: "esp32", preSelectedBoard: { id: "esp32" }, boardSelectionMode: "recommend",
    preferences: { mode: "beginner", locale: "en" }, currentPhase: "generate",
    manifest: { m: 1 }, diagram: { nodes: ["a"] },
    optionalNextPhases: [{ phase: "upy-diagram-plugin" }],
    generatePhaseComplete: { type: "phase_complete", payload: { result: "success" } },
  });
  assert.equal(ok, true, "seed succeeds when idle");
  const snap = controller.getSnapshotState();
  assert.deepEqual(snap.state, { manifest: { m: 1 }, phase: "generate", intent: "blink" }, "resume state restored");
  assert.equal(snap.boardId, "esp32", "board restored");
  assert.equal(snap.currentPhase, "generate", "phase restored");
  assert.deepEqual(snap.diagram, { nodes: ["a"] }, "diagram carried for a re-save");
  // The optional-flow offers + upstream generate result are restored, so a restored session can re-run
  // wiring/diagram: the host gate reads getOptionalNextPhases + the wrapped upstream generate result.
  assert.deepEqual(controller.getOptionalNextPhases(), [{ phase: "upy-diagram-plugin" }], "optional-flow offers restored");
  assert.deepEqual(controller.getLatestGeneratePhaseComplete(), { type: "phase_complete", payload: { result: "success" } }, "upstream generate restored so a re-run has a valid source");
  assert.equal(controller.hasSnapshotState(), true, "a restored session is itself re-savable");

  // The restored session adopts ITS OWN id + terminal, so a post-restore Save Version writes into that
  // session's dir (not the session that ran before it) and carries the real terminal, not null.
  assert.equal(controller.seedFromSnapshot({ boardId: "b", traceId: "session-xyz-1", terminal: "complete" }), true, "re-seed succeeds when idle");
  const s2 = controller.getSnapshotState();
  assert.equal(s2.traceId, "session-xyz-1", "restore adopts the snapshot's trace id");
  assert.equal(s2.terminal, "complete", "the restored terminal is carried for a re-save");

  // Residual wipe (#28/#33): re-seeding a DIFFERENT session must NOT inherit the prior seed's
  // diagram/terminal — a snapshot written after this restore must carry only this session's data.
  assert.equal(controller.seedFromSnapshot({ boardId: "c" }), true, "third seed succeeds when idle");
  const s3 = controller.getSnapshotState();
  assert.equal(s3.diagram, undefined, "a fresh restore does not inherit the previous restore's diagram");
  assert.equal(s3.terminal, null, "a fresh restore does not inherit the previous restore's terminal");
  assert.equal(s3.traceId, null, "a fresh restore without an id does not inherit the previous id");

  // Must NOT clobber a live run's state: with a run in flight (abort set), seeding is refused.
  let release: () => void = () => { };
  const gate = new Promise<void>((r) => { release = r; });
  const c2 = new SessionController({ postMessage: () => { }, loop: async () => { await gate; return { terminal: "complete" }; } });
  const running = c2.start({ intent: "x", boardId: "auto" });
  assert.equal(c2.seedFromSnapshot({ boardId: "b" }), false, "seed refuses while a run owns the state");
  release(); await running;
});

test("a restored authored diagram survives a later wiring optional-flow run (guard held across the startPhase excursion)", async () => {
  const posts: any[] = [];
  // The loop streams a devices-bearing manifest_updated (what a wiring/diagram run emits) then completes —
  // exactly the production path: start_optional_flow -> startPhase -> run() -> loop onEvent. Driving the real
  // run() entry is the point: run() clears per-run state at entry, so a bare postEvent would miss the bug.
  const controller = new SessionController({
    postMessage: (m) => posts.push(m),
    loop: async ({ onEvent }: any) => {
      onEvent({ type: "manifest_updated", manifest: { devices: [{ id: "aht20", interface: "I2C" }] } });
      return { terminal: "complete" };
    },
  });
  // Restore a session whose snapshot HAD an authored diagram + a device-bearing manifest.
  controller.seedFromSnapshot({ manifest: { devices: [{ id: "aht20" }] }, diagram: { authored: true, nodes: ["led"] } });
  posts.length = 0;
  // Run the wiring optional flow the way the panel does. preserveManifest is set inside startPhase; the
  // authored-diagram guard must survive the run-entry clear (class fix at run():238), so NO derived
  // diagram_updated is posted to clobber the restored authored one.
  await controller.startPhase({ phase: "upy-wiring-plugin", envelope: "{}" });
  assert.ok(posts.some((m) => m.type === "manifest_updated"), "the wiring tab refreshes from the run's manifest");
  assert.ok(!posts.some((m) => m.type === "diagram_updated"), "the restored authored diagram is NOT clobbered by the excursion's derived view");
});

test("records and posts a phase_stalled event so a stuck build surfaces (not swallowed as a generic trace)", async () => {
  const recorded: any[] = [];
  const posted: any[] = [];
  const controller = new SessionController({
    postMessage: (m) => posted.push(m),
    recorderFactory: () => ({ record: async (e: any) => { recorded.push(e); } }),
    loop: async ({ onEvent }) => {
      onEvent({ type: "phase_stalled", phase: "select-hw", reason: "no_tool_call" });
      return { terminal: "stalled" };
    },
  });

  await controller.start({ intent: "x", boardId: "auto" });

  assert.ok(
    recorded.some((e) => e.type === "phase_stalled" && e.phase === "select-hw"),
    "phase_stalled must be recorded as itself so the cloud DB sees the stall, not buried in a trace_event",
  );
  assert.ok(
    posted.some((m) => m.type === "phase_stalled"),
    "phase_stalled must be posted to the webview so the user sees a stuck/retry state",
  );
});

test("records and posts a phase_error so an unknown next_phase surfaces (not swallowed as a generic trace)", async () => {
  const recorded: any[] = [];
  const posted: any[] = [];
  const controller = new SessionController({
    postMessage: (m) => posted.push(m),
    recorderFactory: () => ({ record: async (e: any) => { recorded.push(e); } }),
    loop: async ({ onEvent }) => {
      onEvent({ type: "phase_error", error_kind: "unknown_next_phase", next_phase: "upy-verify-plugin" });
      return { terminal: "failed" };
    },
  });

  await controller.start({ intent: "x", boardId: "auto" });

  assert.ok(
    recorded.some((e) => e.type === "phase_error" && e.error_kind === "unknown_next_phase" && e.next_phase === "upy-verify-plugin"),
    "phase_error must be recorded as itself so session.jsonl shows WHY the build ended failed",
  );
  assert.ok(
    posted.some((m) => m.type === "phase_error" && m.next_phase === "upy-verify-plugin"),
    "phase_error must be posted to the webview so the user sees the reason, not a bare 'failed'",
  );
  assert.match(
    controller.getDiagnostics().key_errors,
    /unknown_next_phase: upy-verify-plugin/,
    "phase_error must reach key_errors so a support bug report carries the reason",
  );
});

test("session controller streams loop events and gates deploy via confirmDeploy", async () => {
  const messages: any[] = [];
  const controller = new SessionController({
    postMessage: (message) => messages.push(message),
    loop: async ({ onEvent, confirmDeploy }) => {
      onEvent({ type: "trace", text: "start" });
      onEvent({ type: "manifest_updated", manifest: { board_id: "esp32-s3-devkitc-1" } });
      onEvent({ type: "code_updated", code: "print('MPYHW_READY')", path: "main.py" });
      onEvent({ type: "serial_output", lines: ["MPYHW_READY"] });
      const approved = await confirmDeploy();
      return { terminal: approved ? "success" : "user_cancelled" };
    },
  });

  const started = controller.start({ intent: "temp", boardId: "esp32-s3-devkitc-1" });
  const deploy = messages.find((m) => m.type === "deploy_needed");
  assert.ok(deploy, "expected a deploy_needed message before any device action");
  // The chokepoint now enriches a wiring-less manifest with a derived (here empty, no
  // devices) wiring shape, so the deploy card carries it too.
  assert.deepEqual(deploy.manifest, { board_id: "esp32-s3-devkitc-1", wiring: { buses: [], standalone: [] } });
  controller.resolvePrompt(deploy.promptId, "cancel");
  const result = await started;

  assert.equal(result.terminal, "user_cancelled");
  assert.deepEqual(messages.map((m) => m.type), [
    "trace_event",
    "manifest_updated",
    "diagram_updated",
    "code_updated",
    "serial_output",
    "deploy_needed",
    "session_done",
  ]);
});

test("session controller rejects a concurrent start while a run is in flight", async () => {
  let release: () => void = () => { };
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let loopStarts = 0;
  const controller = new SessionController({
    postMessage: () => { },
    loop: async () => { loopStarts += 1; await gate; return { terminal: "success" }; },
  });

  const first = controller.start({ intent: "a", boardId: "esp32-s3-devkitc-1" });
  const second = controller.start({ intent: "b", boardId: "esp32-s3-devkitc-1" });
  await Promise.resolve();
  const startsWhileConcurrent = loopStarts;

  release();
  const [firstResult, secondResult] = await Promise.all([first, second]);

  assert.equal(startsWhileConcurrent, 1, "a concurrent start must not launch a second loop");
  assert.equal(secondResult.terminal, "session_busy");
  assert.equal(firstResult.terminal, "success");
});

test("reset() supersedes the in-flight run: late messages are dropped and a new start is accepted", async () => {
  const messages: any[] = [];
  let release: () => void = () => { };
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const controller = new SessionController({
    postMessage: (m) => messages.push(m),
    loop: async ({ onEvent, signal }) => {
      onEvent({ type: "trace", text: "early" });   // before reset -> should be posted
      await gate;                                    // park the run in flight
      onEvent({ type: "trace", text: "late" });      // after reset -> must be dropped
      return { terminal: signal?.aborted ? "cancelled" : "success" };
    },
  });

  const first = controller.start({ intent: "a", boardId: "esp32-s3-devkitc-1" });
  await Promise.resolve();                            // let the loop reach `await gate`
  controller.reset();                                // supersede + abort the in-flight run
  release();
  const firstResult = await first;

  // The superseded run emits NO terminal and NO late events into the cleared feed.
  assert.equal(messages.some((m) => m.type === "session_done"), false, "superseded run posts no session_done");
  assert.equal(
    messages.some((m) => m.type === "trace_event" && /late/.test(m.event?.text ?? "")),
    false,
    "superseded run's late events are dropped",
  );
  assert.equal(firstResult.terminal, "cancelled");

  // A fresh start right after reset is accepted (not rejected as session_busy).
  messages.length = 0;
  const second = await controller.start({ intent: "b", boardId: "esp32-s3-devkitc-1" });
  assert.notEqual(second.terminal, "session_busy");
  assert.equal(messages.some((m) => m.type === "session_done"), true, "the new run posts its own session_done");
});

test("reset() supersedes a THROWING run: its catch records/accumulates nothing into the next session (#29)", async () => {
  const recorded: any[] = [];
  let release: () => void = () => { };
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const controller = new SessionController({
    postMessage: () => { },
    recorderFactory: () => ({ record: async (e: any) => { recorded.push(e); } }),
    loop: async () => { await gate; throw new Error("boom"); }, // parks in flight, then throws after reset
  });

  const first = controller.start({ intent: "a", boardId: "esp32-s3-devkitc-1" });
  await Promise.resolve();          // let the loop reach `await gate`
  controller.reset();               // supersede: current() is now false for the in-flight run
  release();
  await first;

  // The superseded run's catch path is guarded by current(), so it records NOTHING and does not
  // push into keyErrors -- else its "boom" leaks into the freshly-reset next session's log/snapshot.
  assert.equal(recorded.some((e) => e.type === "session_error"), false, "superseded throw records no session_error");
  assert.equal(recorded.some((e) => e.type === "session_finished"), false, "superseded throw records no session_finished");
  assert.ok(!/boom/.test(controller.getDiagnostics().key_errors ?? ""), "the superseded error did not poison the next session's key_errors");
});

test("session controller writes generated files after code and manifest are available", async () => {
  const written: any[] = [];
  const messages: any[] = [];
  const controller = new SessionController({
    postMessage: (message) => messages.push(message),
    writeFiles: async (files) => {
      written.push(files);
      return { ok: true, paths: ["C:/project/main.py", "C:/project/manifest.json"] };
    },
    loop: async ({ onEvent }) => {
      onEvent({ type: "manifest_updated", manifest: { board_id: "esp32-s3-devkitc-1" } });
      onEvent({ type: "code_updated", code: "print('MPYHW_READY')" });
      return { terminal: "generated" };
    },
  });

  await controller.start({ intent: "temp", boardId: "esp32-s3-devkitc-1" });

  // latestManifest is the enriched copy (derived empty wiring), so the headless batch
  // serializes that — harmless; the real extension writes from persistedPaths instead.
  assert.deepEqual(written, [{ "main.py": "print('MPYHW_READY')", "manifest.json": JSON.stringify({ board_id: "esp32-s3-devkitc-1", wiring: { buses: [], standalone: [] } }, null, 2) }]);
  assert.deepEqual(messages.find((message) => message.type === "files_written"), { type: "files_written", paths: ["C:/project/main.py", "C:/project/manifest.json"] });
});

test("session controller accumulates multi-file projects by path and writes them all", async () => {
  const written: any[] = [];
  const controller = new SessionController({
    postMessage: () => { },
    writeFiles: async (files) => {
      written.push(files);
      return { ok: true, paths: Object.keys(files) };
    },
    loop: async ({ onEvent }) => {
      onEvent({ type: "manifest_updated", manifest: { board_id: "esp32-s3-devkitc-1" } });
      onEvent({ type: "code_updated", code: "from lib.aht20 import AHT20\nprint('MPYHW_READY')", path: "main.py" });
      onEvent({ type: "code_updated", code: "class AHT20:\n    pass", path: "lib/aht20.py" });
      return { terminal: "generated" };
    },
  });

  await controller.start({ intent: "thermometer", boardId: "esp32-s3-devkitc-1" });

  assert.deepEqual(written, [{
    "main.py": "from lib.aht20 import AHT20\nprint('MPYHW_READY')",
    "lib/aht20.py": "class AHT20:\n    pass",
    "manifest.json": JSON.stringify({ board_id: "esp32-s3-devkitc-1", wiring: { buses: [], standalone: [] } }, null, 2),
  }]);
});

test("session controller reports loop-persisted files without a redundant batch write", async () => {
  // When the loop persists files itself (write_project_file / generate_code emit
  // file_written), the post-loop batch is skipped: no second write, no duplicate
  // manifest.json, and files_written reports exactly the loop-persisted paths.
  let writeFilesCalled = false;
  const messages: any[] = [];
  const controller = new SessionController({
    postMessage: (message) => messages.push(message),
    writeFiles: async () => { writeFilesCalled = true; return { ok: true, paths: [] }; },
    loop: async ({ onEvent }) => {
      onEvent({ type: "manifest_updated", manifest: { board_id: "esp32-s3-devkitc-1" } });
      onEvent({ type: "file_written", path: "C:/project/project-manifest.json" });
      onEvent({ type: "code_updated", code: "print('MPYHW_READY')", path: "firmware/main.py" });
      onEvent({ type: "file_written", path: "C:/project/firmware/main.py" });
      return { terminal: "generated" };
    },
  });

  await controller.start({ intent: "temp", boardId: "esp32-s3-devkitc-1" });

  assert.equal(writeFilesCalled, false, "the post-loop batch must not re-write loop-persisted files");
  assert.deepEqual(
    messages.find((message) => message.type === "files_written"),
    { type: "files_written", paths: ["C:/project/project-manifest.json", "C:/project/firmware/main.py"] },
  );
});

test("session controller reports generated file write failures without changing terminal state", async () => {
  const messages: any[] = [];
  const controller = new SessionController({
    postMessage: (message) => messages.push(message),
    writeFiles: async () => ({ ok: false, error_kind: "overwrite_rejected" }),
    loop: async ({ onEvent }) => {
      onEvent({ type: "manifest_updated", manifest: { board_id: "esp32-s3-devkitc-1" } });
      onEvent({ type: "code_updated", code: "print('MPYHW_READY')" });
      return { terminal: "generated" };
    },
  });

  const result = await controller.start({ intent: "temp", boardId: "esp32-s3-devkitc-1" });

  assert.equal(result.terminal, "generated");
  assert.deepEqual(messages.find((message) => message.type === "files_write_failed"), { type: "files_write_failed", error: "overwrite_rejected" });
});

test("session controller routes ask_user to the webview and feeds the answer back", async () => {
  const messages: any[] = [];
  let captured: string | null = "unset";
  const controller = new SessionController({
    postMessage: (message) => messages.push(message),
    loop: async ({ askUser }) => {
      captured = await askUser("Which board are you using?");
      return { terminal: "generated" };
    },
  });

  const started = controller.start({ intent: "x", boardId: "b" });
  const prompt = messages.find((m) => m.type === "ui_prompt_needed");
  assert.ok(prompt, "expected a ui_prompt_needed message");
  assert.equal(prompt.question, "Which board are you using?");

  controller.resolvePrompt(prompt.promptId, "esp32-s3-devkitc-1");
  const result = await started;

  assert.equal(captured, "esp32-s3-devkitc-1");
  assert.equal(result.terminal, "generated");
});

test("session controller forwards an ask_user's needs-text options and placeholder to the webview", async () => {
  const messages: any[] = [];
  const controller = new SessionController({
    postMessage: (message) => messages.push(message),
    loop: async ({ askUser }) => {
      await askUser("Which approach?", ["Built-in socket", "Provide a URL"], ["Provide a URL"], "Paste the GitHub URL");
      return { terminal: "generated" };
    },
  });

  const started = controller.start({ intent: "x", boardId: "b" });
  const prompt = messages.find((m) => m.type === "ui_prompt_needed");
  assert.ok(prompt, "expected a ui_prompt_needed message");
  assert.deepEqual([...prompt.options], ["Built-in socket", "Provide a URL"]);
  assert.deepEqual([...prompt.optionsRequiringText], ["Provide a URL"], "the needs-text option is forwarded");
  assert.equal(prompt.textPlaceholder, "Paste the GitHub URL", "the placeholder is forwarded");

  controller.resolvePrompt(prompt.promptId, "Provide a URL\nhttps://example.com/x");
  await started;
});

test("session controller routes confirmPlan to the webview as plan_needed and resolves the choice", async () => {
  const messages: any[] = [];
  let decision: any = "unset";
  const controller = new SessionController({
    postMessage: (message) => messages.push(message),
    loop: async ({ confirmPlan }) => {
      decision = await confirmPlan({ intent: "blink", estimate: 3, capabilities: ["digital_output"], wiring: [] });
      return { terminal: "generated" };
    },
  });

  const started = controller.start({ intent: "x", boardId: "b" });
  const plan = messages.find((m) => m.type === "plan_needed");
  assert.ok(plan, "expected a plan_needed message");
  assert.equal(plan.plan.estimate, 3);

  controller.resolvePrompt(plan.promptId, "confirm");
  await started;
  assert.equal(decision.action, "confirm");
});

test("session controller confirmPlan resolves a revise decision carrying the feedback", async () => {
  const messages: any[] = [];
  let decision: any = "unset";
  const controller = new SessionController({
    postMessage: (message) => messages.push(message),
    loop: async ({ confirmPlan }) => { decision = await confirmPlan({ estimate: 2 }); return { terminal: "generated" }; },
  });

  const started = controller.start({ intent: "x", boardId: "b" });
  const plan = messages.find((m) => m.type === "plan_needed");
  controller.resolvePrompt(plan.promptId, "revise", { feedback: "用 TFT 彩屏" });
  await started;
  assert.deepEqual(decision, { action: "revise", feedback: "用 TFT 彩屏" });
});

test("session controller routes confirmComponents to the webview as components_needed and resolves kept devices + additions", async () => {
  const messages: any[] = [];
  let decision: any = "unset";
  const controller = new SessionController({
    postMessage: (message) => messages.push(message),
    loop: async ({ confirmComponents }) => {
      decision = await confirmComponents([{ name: "SSD1306 OLED" }, { name: "WS2812 RGB LED" }]);
      return { terminal: "generated" };
    },
  });

  const started = controller.start({ intent: "x", boardId: "b" });
  const prompt = messages.find((m) => m.type === "components_needed");
  assert.ok(prompt, "expected a components_needed message");
  assert.equal(prompt.devices.length, 2);

  controller.resolvePrompt(prompt.promptId, "confirm", { devices: ["SSD1306 OLED"], feedback: "加 DHT22" });
  await started;
  assert.deepEqual(decision, { action: "confirm", devices: ["SSD1306 OLED"], feedback: "加 DHT22" });
});

test("streamed SSE credit updates reach the webview as a credits session_event (not a swallowed trace_event)", async () => {
  // The backend emits a live SSE `{ type: "credits", remaining, daily_grant, resets_at }`
  // after each turn; sse-client maps it to `{ type: "credits", remaining, dailyGrant, resetsAt }`
  // and agent-loop forwards it to onEvent. The controller must hand it to the webview in the
  // exact shape the quota bar reads — `{ type: "session_event", event: { kind: "credits",
  // balance, dailyGrant, resetsAt } }` — or the live balance never updates and the low/exhausted
  // states never trip mid-build.
  const messages: any[] = [];
  const controller = new SessionController({
    postMessage: (m) => messages.push(m),
    loop: async ({ onEvent }) => {
      onEvent({ type: "credits", remaining: 7, dailyGrant: 100, resetsAt: "2026-07-07T00:00:00Z" });
      return { terminal: "generated" };
    },
  });

  await controller.start({ intent: "x", boardId: "b" });

  const credits = messages.find((m) => m.type === "session_event" && m.event?.kind === "credits");
  assert.ok(credits, "a streamed credits event must post as a session_event the quota bar can read, not be swallowed as a trace_event");
  assert.equal(credits.event.balance, 7, "the webview reads event.balance — it must carry the stream's `remaining`");
  assert.equal(credits.event.dailyGrant, 100);
  assert.equal(credits.event.resetsAt, "2026-07-07T00:00:00Z");
  assert.equal(
    messages.some((m) => m.type === "trace_event" && m.event?.type === "credits"),
    false,
    "the raw SSE credits event must not fall through to the generic trace_event branch",
  );
});

test("session controller forwards a loop summary event to the webview as a summary message", async () => {
  const messages: any[] = [];
  const controller = new SessionController({
    postMessage: (m) => messages.push(m),
    loop: async ({ onEvent }) => { onEvent({ type: "summary", text: "all done" }); return { terminal: "generated" }; },
  });

  await controller.start({ intent: "x", boardId: "b" });
  const summary = messages.find((m) => m.type === "summary");
  assert.ok(summary, "expected a summary message");
  assert.equal(summary.text, "all done");
});

test("session controller confirmPlan resolves cancel on cancel answer and on session cancel", async () => {
  // explicit "cancel" answer
  let a: any = "unset";
  const c1 = new SessionController({
    postMessage: () => { },
    loop: async ({ confirmPlan }) => { a = await confirmPlan({ estimate: 2 }); return { terminal: "generated" }; },
  });
  const s1 = c1.start({ intent: "x", boardId: "b" });
  // resolve the pending plan prompt with cancel
  c1.resolvePrompt("plan-1", "cancel");
  await s1;
  assert.equal(a.action, "cancel");

  // session cancel unblocks a pending plan as cancel
  let b: any = "unset";
  const c2 = new SessionController({
    postMessage: () => { },
    loop: async ({ confirmPlan, signal }) => { b = await confirmPlan({ estimate: 2 }); return { terminal: signal?.aborted ? "cancelled" : "generated" }; },
  });
  const s2 = c2.start({ intent: "x", boardId: "b" });
  c2.cancel();
  await s2;
  assert.equal(b.action, "cancel");
});

test("session controller routes confirmDeploy to the webview as deploy_needed and resolves the choice", async () => {
  const messages: any[] = [];
  let confirmed: boolean | "unset" = "unset";
  const controller = new SessionController({
    postMessage: (message) => messages.push(message),
    loop: async ({ onEvent, confirmDeploy }) => {
      onEvent({ type: "manifest_updated", manifest: { board_id: "esp32-s3-devkitc-1", wiring: [{ role: "led_anode", pin: "GPIO2" }] } });
      confirmed = await confirmDeploy();
      return { terminal: "success" };
    },
  });

  const started = controller.start({ intent: "x", boardId: "b" });
  const deploy = messages.find((m) => m.type === "deploy_needed");
  assert.ok(deploy, "expected a deploy_needed message carrying the manifest for the wiring diagram");
  assert.deepEqual(deploy.manifest, { board_id: "esp32-s3-devkitc-1", wiring: [{ role: "led_anode", pin: "GPIO2" }] });

  controller.resolvePrompt(deploy.promptId, "confirm");
  await started;
  assert.equal(confirmed, true);
});

test("session controller confirmDeploy resolves false on session cancel", async () => {
  let approved: boolean | "unset" = "unset";
  const controller = new SessionController({
    postMessage: () => { },
    loop: async ({ confirmDeploy, signal }) => { approved = await confirmDeploy(); return { terminal: signal?.aborted ? "cancelled" : "generated" }; },
  });
  const started = controller.start({ intent: "x", boardId: "b" });
  controller.cancel();
  await started;
  assert.equal(approved, false);
});

test("session controller records UI prompts, the deploy gate, artifacts, and terminal state", async () => {
  const recorded: any[] = [];
  const controller = new SessionController({
    postMessage: () => { },
    recorderFactory: (traceId: string) => ({
      record: async (event: any) => void recorded.push({ traceId, ...event }),
    }),
    loop: async ({ onEvent, askUser, confirmDeploy }) => {
      const answer = await askUser("Which output should it use?");
      onEvent({ type: "manifest_updated", manifest: { board_id: "esp32-s3-devkitc-1", answer } });
      onEvent({ type: "code_updated", code: "print('MPYHW_READY')", path: "main.py" });
      onEvent({ type: "serial_output", lines: ["MPYHW_READY"] });
      await confirmDeploy();
      return { terminal: "success" };
    },
  });

  const started = controller.start({ intent: "build companion", boardId: "esp32-s3-devkitc-1" });
  const prompt = recorded.find((event) => event.type === "ui_prompt");
  assert.ok(prompt, "expected ui_prompt event");
  controller.resolvePrompt(prompt.promptId, "OLED");
  await flushMicrotasks();
  const deploy = recorded.find((event) => event.type === "deploy_proposed");
  assert.ok(deploy, "expected deploy_proposed event after the artifacts");
  controller.resolvePrompt(deploy.promptId, "confirm");
  await started;

  assert.deepEqual(recorded.map((event) => event.type), [
    "session_started",
    "user_message",
    "ui_prompt",
    "ui_prompt_answer",
    "artifact",
    "artifact",
    "serial_output",
    "deploy_proposed",
    "ui_prompt_answer",
    "session_finished",
  ]);
  assert.equal(recorded[0].intent, "build companion");
  assert.equal(recorded[1].intent, "build companion");
  assert.equal(recorded[3].answer, "OLED");
  assert.equal(recorded[4].kind, "manifest");
  assert.equal(recorded[5].code, "print('MPYHW_READY')");
  assert.equal(recorded[5].path, "main.py", "the code artifact record carries path too, not just code — a view-only restore has no other way to learn the file's real name");
  assert.equal(recorded[7].manifest.board_id, "esp32-s3-devkitc-1");
  assert.equal(recorded[8].answer, "confirm");
  assert.equal(recorded[9].terminal, "success");
});

test("session controller carries agent state into the next user message", async () => {
  const statesSeen: any[] = [];
  const returnedStates = [
    { traceId: "session", intent: "first", boardId: "esp32-s3-devkitc-1", messages: [{ role: "user", content: "first" }] },
    { traceId: "session", intent: "first", boardId: "esp32-s3-devkitc-1", messages: [{ role: "user", content: "first" }, { role: "user", content: "second" }] },
  ];
  const controller = new SessionController({
    postMessage: () => { },
    loop: async (input) => {
      statesSeen.push(input.state);
      return { terminal: "awaiting_user", state: returnedStates[statesSeen.length - 1] };
    },
  });

  await controller.start({ intent: "first", boardId: "esp32-s3-devkitc-1" });
  await controller.start({ intent: "second", boardId: "esp32-s3-devkitc-1" });

  assert.equal(statesSeen[0], undefined);
  assert.deepEqual(statesSeen[1], returnedStates[0]);
});

test("session controller reset drops the conversation so the next start is a fresh build under a new trace", async () => {
  const statesSeen: any[] = [];
  const traceIds: string[] = [];
  const carried = { traceId: "session", intent: "first", boardId: "esp32-s3-devkitc-1", messages: [{ role: "user", content: "first" }] };
  const controller = new SessionController({
    postMessage: () => { },
    recorderFactory: (traceId: string) => { traceIds.push(traceId); return { record: async () => { } }; },
    loop: async (input) => { statesSeen.push(input.state); return { terminal: "awaiting_user", state: carried }; },
  });

  await controller.start({ intent: "first", boardId: "esp32-s3-devkitc-1" });
  controller.reset();
  await controller.start({ intent: "unrelated next project", boardId: "esp32-s3-devkitc-1" });

  // First run starts cold; the second would have CONTINUED (seen `carried`) without
  // the reset — instead it starts cold again, and under a distinct trace id.
  assert.equal(statesSeen[0], undefined);
  assert.equal(statesSeen[1], undefined, "reset must drop the carried state so the next start is a new conversation");
  assert.equal(traceIds.length, 2, "the post-reset start must mint a fresh recorder trace");
  assert.notEqual(traceIds[0], traceIds[1]);
});

test("session controller cancel unblocks a pending ask_user with a null answer", async () => {
  let captured: string | null = "unset";
  const controller = new SessionController({
    postMessage: () => { },
    loop: async ({ askUser, signal }) => {
      captured = await askUser("?");
      return { terminal: signal?.aborted ? "cancelled" : "generated" };
    },
  });

  const started = controller.start({ intent: "x", boardId: "b" });
  controller.cancel();
  const result = await started;

  assert.equal(captured, null);
  assert.equal(result.terminal, "cancelled");
});

test("session controller reports loop crashes to the webview", async () => {
  const messages: any[] = [];
  const controller = new SessionController({
    postMessage: (message) => messages.push(message),
    loop: async () => {
      throw new Error("api down");
    },
  });

  const result = await controller.start({ intent: "temp", boardId: "esp32-s3-devkitc-1" });

  assert.deepEqual(result, { terminal: "session_error", error: "api down" });
  assert.deepEqual(messages, [
    { type: "session_error", error: "api down" },
    { type: "session_done", terminal: "session_error" },
  ]);
});

test("a loop crash with an error cause surfaces the cause code in the message", async () => {
  // undici buries the real network reason (ECONNRESET, ETIMEDOUT) in error.cause;
  // discarding it left prod telemetry with an undebuggable bare "fetch failed".
  const messages: any[] = [];
  const controller = new SessionController({
    postMessage: (message) => messages.push(message),
    loop: async () => {
      const error: any = new Error("fetch failed");
      error.cause = Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
      throw error;
    },
  });

  const result = await controller.start({ intent: "temp", boardId: "esp32-s3-devkitc-1" });

  assert.equal(result.terminal, "session_error");
  assert.match(String(result.error), /fetch failed/);
  assert.match(String(result.error), /ECONNRESET/);
});

test("retry() re-enters the loop with the saved state and an empty intent", async () => {
  // The manual-retry path: a session that ended llm_unreachable keeps its state;
  // retry() must re-issue the interrupted turn (empty intent, same state) without
  // recording a fake user_message.
  const loopInputs: any[] = [];
  const messages: any[] = [];
  const records: any[] = [];
  let mode: "down" | "up" = "down";
  const controller = new SessionController({
    postMessage: (message) => messages.push(message),
    recorderFactory: () => ({ record: async (event: any) => void records.push(event) }) as any,
    loop: async (input: any) => {
      loopInputs.push({ intent: input.intent, state: input.state });
      if (mode === "down") return { terminal: "llm_unreachable", state: { messages: [{ role: "user", content: "build it" }] } };
      return { terminal: "awaiting_user", state: input.state };
    },
  });

  const first = await controller.start({ intent: "build it", boardId: "auto" });
  assert.equal(first.terminal, "llm_unreachable");

  mode = "up";
  const second = await controller.retry();
  assert.equal(second.terminal, "awaiting_user");
  assert.equal(loopInputs.length, 2);
  assert.equal(loopInputs[1].intent, "");
  assert.deepEqual(loopInputs[1].state, { messages: [{ role: "user", content: "build it" }] });
  // Telemetry: the retry is visible as session_retry, not a fabricated user_message.
  assert.ok(records.some((r) => r.type === "session_retry"), "expected a session_retry record");
  assert.equal(records.filter((r) => r.type === "user_message").length, 1);
  // The webview gets a normal terminal for the retried run.
  assert.deepEqual(messages.filter((m) => m.type === "session_done").map((m) => m.terminal), ["llm_unreachable", "awaiting_user"]);
});

test("retry() without a saved session is a safe no-op", async () => {
  const messages: any[] = [];
  let loopStarts = 0;
  const controller = new SessionController({
    postMessage: (message) => messages.push(message),
    loop: async () => { loopStarts++; return { terminal: "awaiting_user" }; },
  });

  const result = await controller.retry();

  assert.equal(result.terminal, "nothing_to_retry");
  assert.equal(loopStarts, 0);
});

test("a second resolvePrompt for the same promptId does not re-invoke the resolver and records ui_prompt_answer_duplicate", async () => {
  const recorded: any[] = [];
  let loopAnswer: any = "unset";
  const controller = new SessionController({
    postMessage: () => { },
    recorderFactory: () => ({ record: async (event: any) => void recorded.push(event) }),
    loop: async ({ askUser }) => {
      loopAnswer = await askUser("Which output should it use?");
      return { terminal: "generated" };
    },
  });

  const started = controller.start({ intent: "x", boardId: "b" });
  await flushMicrotasks();
  const prompt = recorded.find((event) => event.type === "ui_prompt");
  assert.ok(prompt, "expected ui_prompt event");

  controller.resolvePrompt(prompt.promptId, "OLED");
  // The race under test: a second answer lands for the SAME promptId (stale
  // card click / re-delivered message). It must not reach the loop.
  controller.resolvePrompt(prompt.promptId, "TFT");
  await started;

  assert.equal(loopAnswer, "OLED", "the loop sees only the first answer — the resolver is not re-invoked");
  assert.equal(recorded.filter((event) => event.type === "ui_prompt_answer").length, 1, "exactly one real answer recorded");
  const dup = recorded.find((event) => event.type === "ui_prompt_answer_duplicate");
  assert.ok(dup, "the duplicate resolve leaves a telemetry trace");
  assert.equal(dup.promptId, prompt.promptId);
  assert.equal(dup.answer, "TFT", "the trace carries the ignored duplicate answer");
});

// ---- User supplements at the after-phase_complete safe point (deliverables 07) ----

test("queues a supplement mid-run and surfaces it at the safe point (absorb -> folded into next context)", async () => {
  const posted: any[] = [];
  let safePoint: string | null | undefined;
  let controller: SessionController;
  controller = new SessionController({
    postMessage: (m: any) => posted.push(m),
    loop: async ({ onEvent, onSafePoint }: any) => {
      onEvent({ type: "phase_start", phase: "analyze" });
      controller.submitSupplement("raise the temperature threshold to 40");
      safePoint = onSafePoint("analyze");
      return { terminal: "complete" };
    },
  });

  await controller.start({ intent: "env monitor", boardId: "auto" });

  const received = posted.find((m) => m.type === "user_supplement_received");
  assert.ok(received, "a queued supplement emits user_supplement_received");
  assert.equal(received.status, "queued");
  assert.equal(received.phase, "analyze", "receivedPhase is stamped from the current phase");
  const applied = posted.find((m) => m.type === "user_supplement_applied");
  assert.equal(applied.decision, "absorb", "a logic change absorbs");
  assert.equal(safePoint, "raise the temperature threshold to 40", "absorbed text is returned to the loop for the next phase context");
});

test("a reroute supplement is flag-and-surface: applied event, but NO auto-jump text returned", async () => {
  const posted: any[] = [];
  let safePoint: string | null | undefined;
  let controller: SessionController;
  controller = new SessionController({
    postMessage: (m: any) => posted.push(m),
    loop: async ({ onEvent, onSafePoint }: any) => {
      onEvent({ type: "phase_start", phase: "analyze" });
      controller.submitSupplement("use an esp32 board instead");
      safePoint = onSafePoint("analyze");
      return { terminal: "complete" };
    },
  });

  await controller.start({ intent: "x", boardId: "auto" });

  const applied = posted.find((m) => m.type === "user_supplement_applied");
  assert.equal(applied.decision, "reroute");
  assert.equal(applied.phase, "upy-select-hw-plugin", "the applied event names the reroute target");
  assert.equal(safePoint, null, "reroute does not fold text into the next phase (no auto-jump for P0)");
});

test("a pin change becomes reconfirm once code already exists (spec §6)", async () => {
  const posted: any[] = [];
  let controller: SessionController;
  controller = new SessionController({
    postMessage: (m: any) => posted.push(m),
    loop: async ({ onEvent, onSafePoint }: any) => {
      onEvent({ type: "phase_start", phase: "upy-generate-plugin" });
      onEvent({ type: "code_updated", code: "print('hi')", path: "main.py" }); // code now exists
      controller.submitSupplement("move the sensor to GPIO 15");
      onSafePoint("upy-generate-plugin");
      return { terminal: "complete" };
    },
  });

  await controller.start({ intent: "x", boardId: "auto" });

  const applied = posted.find((m) => m.type === "user_supplement_applied");
  assert.equal(applied.decision, "reconfirm", "pin change + existing code -> reconfirm, not a silent reroute");
});

test("two notes queued before a safe point are both surfaced (not lost, §9)", async () => {
  const posted: any[] = [];
  let controller: SessionController;
  controller = new SessionController({
    postMessage: (m: any) => posted.push(m),
    loop: async ({ onEvent, onSafePoint }: any) => {
      onEvent({ type: "phase_start", phase: "analyze" });
      controller.submitSupplement("raise the threshold to 40");
      controller.submitSupplement("also lower the sample interval");
      onSafePoint("analyze");
      return { terminal: "complete" };
    },
  });

  await controller.start({ intent: "x", boardId: "auto" });

  assert.equal(posted.filter((m) => m.type === "user_supplement_received").length, 2);
  assert.equal(posted.filter((m) => m.type === "user_supplement_applied").length, 2, "both queued notes are consumed");
});

test("an empty/whitespace supplement is ignored (no queue entry, no event)", async () => {
  const posted: any[] = [];
  let safePoint: string | null | undefined;
  let controller: SessionController;
  controller = new SessionController({
    postMessage: (m: any) => posted.push(m),
    loop: async ({ onEvent, onSafePoint }: any) => {
      onEvent({ type: "phase_start", phase: "analyze" });
      controller.submitSupplement("   ");
      safePoint = onSafePoint("analyze");
      return { terminal: "complete" };
    },
  });

  await controller.start({ intent: "x", boardId: "auto" });

  assert.equal(posted.some((m) => m.type === "user_supplement_received"), false, "blank note is not queued");
  assert.equal(safePoint, null, "nothing to consume");
});

test("an absorb note queued on the FINAL phase is surfaced as deferred, not falsely applied", async () => {
  // The safe point after the last phase_complete has no next phase to fold an absorb
  // note into. It must be surfaced honestly (decision "deferred") rather than claimed
  // "applied"/absorbed, and it must NOT be returned as fold-in text (nowhere to go).
  const posted: any[] = [];
  let safePoint: string | null | undefined;
  let controller: SessionController;
  controller = new SessionController({
    postMessage: (m: any) => posted.push(m),
    loop: async ({ onEvent, onSafePoint }: any) => {
      onEvent({ type: "phase_start", phase: "upy-generate-plugin" });
      controller.submitSupplement("raise the threshold to 40");
      safePoint = onSafePoint("upy-generate-plugin", false); // no next phase
      return { terminal: "complete" };
    },
  });

  await controller.start({ intent: "x", boardId: "auto" });

  const applied = posted.find((m) => m.type === "user_supplement_applied");
  assert.equal(applied.decision, "deferred", "an absorb note with no next phase is deferred, not applied");
  assert.equal(safePoint, null, "nothing is folded forward when there is no next phase");
});

test("artifactSources stamps each file with the phase it was written in (not the final phase)", async () => {
  const controller = new SessionController({
    postMessage: () => { },
    loop: async ({ onEvent }: any) => {
      onEvent({ type: "phase_start", phase: "upy-analyze-plugin" });
      onEvent({ type: "file_written", path: "/ws/blockless-project/project-manifest.json" });
      onEvent({ type: "phase_start", phase: "upy-generate-plugin" });
      onEvent({ type: "file_written", path: "/ws/blockless-project/firmware/main.py" });
      return { terminal: "complete" };
    },
  });

  await controller.start({ intent: "x", boardId: "auto" });

  const sources = controller.artifactSources();
  const byPath = (p: string) => sources.find((s) => s.absolute_path === p);
  assert.equal(byPath("/ws/blockless-project/project-manifest.json")?.phase, "upy-analyze-plugin");
  assert.equal(byPath("/ws/blockless-project/firmware/main.py")?.phase, "upy-generate-plugin");
  assert.ok(sources.every((s) => s.origin === "session"), "live artifacts are session-origin");
});

test("phase_complete artifacts are captured with their Skill role and producing phase", async () => {
  const controller = new SessionController({
    postMessage: () => { },
    loop: async ({ onEvent }: any) => {
      onEvent({ type: "phase_start", phase: "upy-analyze-plugin" });
      onEvent({
        type: "phase_complete", payload: {
          phase: "upy-analyze-plugin", artifacts: [
            { type: "project_manifest", path: "project-manifest.json" },
            { type: "session_state", path: ".mpyhw/sessions/s/session_state.json" },
            { type: "table", headers: ["a"] }, // no path -> skipped
          ]
        }
      });
      onEvent({ type: "phase_start", phase: "upy-select-hw-plugin" });
      onEvent({
        type: "phase_complete", payload: {
          phase: "upy-select-hw-plugin", artifacts: [
            { type: "project_manifest", path: "project-manifest.json" }, // dup path -> first phase wins
            { type: "generate_plan", path: "select_hw_validated.json" },
          ]
        }
      });
      return { terminal: "complete" };
    },
  });

  await controller.start({ intent: "x", boardId: "auto" });

  const recs = controller.phaseArtifactRecords();
  const byPath = (p: string) => recs.find((r) => r.path === p);
  assert.equal(byPath("project-manifest.json")?.role, "project_manifest");
  assert.equal(byPath("project-manifest.json")?.phase, "upy-analyze-plugin", "keeps first producing phase");
  assert.equal(byPath("select_hw_validated.json")?.role, "generate_plan");
  assert.equal(byPath("select_hw_validated.json")?.phase, "upy-select-hw-plugin");
  assert.ok(!recs.some((r) => (r as any).role === "table"), "artifacts without a path are skipped");
  assert.equal(recs.length, 3, "manifest (deduped) + session_state + generate_plan");
});

// ---- Immediate Stop for in-flight device actions (deliverables 07 §4) ----

test("cancel() hard-interrupts the device (killDevice) and aborts the loop signal, preserving the log (§4/§9)", async () => {
  // Stop must kill an in-flight device op NOW, not wait for the tool to finish. A mock
  // loop parks in a device()-like await that only settles once the signal aborts; cancel()
  // fires killDevice alongside the signal abort, and the cancelled run still records
  // session_finished WITH state (log + resumable checkpoint preserved).
  let killed = 0;
  const recorded: any[] = [];
  const controller = new SessionController({
    postMessage: () => { },
    killDevice: () => { killed++; },
    recorderFactory: () => ({ record: async (e: any) => { recorded.push(e); } }),
    loop: async ({ signal }: any) => {
      await new Promise<void>((resolve) => {
        if (signal?.aborted) return resolve();
        signal?.addEventListener?.("abort", () => resolve(), { once: true });
      });
      return { terminal: "cancelled", state: { messages: [{ role: "user", content: "flash it" }] } };
    },
  });

  const started = controller.start({ intent: "flash it", boardId: "esp32-s3-devkitc-1" });
  await Promise.resolve();
  controller.cancel();
  const result = await started;

  assert.equal(killed, 1, "cancel() calls killDevice so the in-flight mpremote op dies now, not after it completes");
  assert.equal(result.terminal, "cancelled", "the aborted signal ends the run as cancelled");
  const finished = recorded.find((e) => e.type === "session_finished");
  assert.ok(finished, "a cancelled run still records session_finished (log preserved, §9)");
  assert.deepEqual(finished.state, { messages: [{ role: "user", content: "flash it" }] }, "the checkpoint state is preserved on Stop");
});

test("cancel() is a safe no-op when idle and when killDevice is not provided", async () => {
  // killDevice is optional (shim.kill is idempotent); a controller with no killDevice dep
  // and no run in flight must cancel without throwing.
  const controller = new SessionController({ postMessage: () => { }, loop: async () => ({ terminal: "complete" }) });
  assert.doesNotThrow(() => controller.cancel(), "cancel with nothing in flight and no killDevice is a no-op");
});

test("reset() also hard-interrupts an in-flight device op (killDevice) so a new build leaves nothing running", async () => {
  let killed = 0;
  let release: () => void = () => { };
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const controller = new SessionController({
    postMessage: () => { },
    killDevice: () => { killed++; },
    loop: async ({ signal }: any) => { await gate; return { terminal: signal?.aborted ? "cancelled" : "success" }; },
  });

  const first = controller.start({ intent: "a", boardId: "esp32-s3-devkitc-1" });
  await Promise.resolve();
  controller.reset();       // supersede + abort + kill the in-flight device op
  release();
  await first;

  assert.equal(killed, 1, "reset() supersede path also kills the in-flight device op");
});

test("confirmFileOp posts an in-panel confirm card carrying the path; proceed=true, else keep the file (§4)", async () => {
  const messages: any[] = [];
  const controller = new SessionController({ postMessage: (m) => messages.push(m), loop: async () => ({ terminal: "complete" }) });

  const proceed = controller.confirmFileOp("overwrite", "firmware/main.py");
  const card = messages.find((m) => m.type === "file_op_confirm_needed");
  assert.ok(card, "posts a file_op_confirm_needed card (not a VS Code toast)");
  assert.equal(card.op, "overwrite");
  assert.equal(card.path, "firmware/main.py", "the card carries the file path for the in-chat prompt");
  controller.resolvePrompt(card.promptId, "proceed");
  assert.equal(await proceed, true, "proceed -> overwrite");

  const ignored = controller.confirmFileOp("delete", "firmware/old.py");
  const c2 = messages.find((m) => m.type === "file_op_confirm_needed" && m.path === "firmware/old.py");
  controller.resolvePrompt(c2.promptId, "ignore");
  assert.equal(await ignored, false, "ignore -> keep the file");

  const cancelled = controller.confirmFileOp("overwrite", "firmware/x.py");
  const c3 = messages.find((m) => m.type === "file_op_confirm_needed" && m.path === "firmware/x.py");
  controller.resolvePrompt(c3.promptId, null); // session cancel/finish
  assert.equal(await cancelled, false, "a cancelled prompt keeps the file (safe default for a destructive op)");
});

test("isRunning gates device tools: true while a run owns the port, false once it finishes", async () => {
  let release: () => void = () => { };
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const controller = new SessionController({
    postMessage: () => { },
    loop: async () => { await gate; return { terminal: "success" }; },
  });

  assert.equal(controller.isRunning(), false, "an idle controller is not running");
  const run = controller.start({ intent: "a", boardId: "esp32-s3-devkitc-1" });
  await Promise.resolve();
  assert.equal(controller.isRunning(), true, "a run in flight owns the device");
  release();
  await run;
  assert.equal(controller.isRunning(), false, "the device is free once the run finishes");
});

test("reset() releases the device gate so device tools work after a Stop", async () => {
  const gate = new Promise<void>(() => { }); // never resolves — a stuck run
  const controller = new SessionController({
    postMessage: () => { },
    loop: async () => { await gate; return { terminal: "success" }; },
  });

  const run = controller.start({ intent: "a", boardId: "esp32-s3-devkitc-1" });
  run.catch(() => { }); // the superseded run is left to unwind; ignore its settle
  await Promise.resolve();
  assert.equal(controller.isRunning(), true);
  controller.reset();
  assert.equal(controller.isRunning(), false, "reset() nulls abort so the device is free");
});

test("recordDeviceTool writes a device_tool log line for each command (spec 41 log artifacts)", async () => {
  const recorded: any[] = [];
  const controller = new SessionController({
    postMessage: () => { },
    recorderFactory: () => ({ record: async (e: any) => { recorded.push(e); } }),
    loop: async () => ({ terminal: "complete" }),
  });

  await controller.start({ intent: "x", boardId: "auto" }); // creates the session recorder
  await controller.recordDeviceTool("list", { path: "/" }, { ok: true });
  await controller.recordDeviceTool("mip_install", { url: "github:x" }, { ok: false, error: "boom" });

  const tools = recorded.filter((e) => e.type === "device_tool");
  assert.equal(tools.length, 2);
  assert.equal(tools[0].command, "list"); assert.equal(tools[0].ok, true);
  assert.equal(tools[1].command, "mip_install"); assert.equal(tools[1].ok, false); assert.equal(tools[1].error, "boom");
});

// A rich upstream project-manifest (one I2C sensor + one direct-GPIO LED) the
// analyze/select-hw phases produce, with the pinout deriveWiring needs. Fresh object
// per call so no test can leak mutation into another.
function richManifest(): any {
  return {
    board_id: "esp32-s3-devkitc-1",
    mcu: { board: "ESP32-S3" },
    devices: [
      { name: "aht20", type: "temp_humidity", interface: "I2C", i2c_addr: ["0x38"] },
      { name: "status_led", type: "led", interface: "GPIO" },
    ],
    pinout: [
      { device: "aht20", pin_name: "I2C0 SDA", gpio: "GPIO8", type: "i2c" },
      { device: "aht20", pin_name: "I2C0 SCL", gpio: "GPIO9", type: "i2c" },
      { device: "status_led", pin_name: "GP2", gpio: "GPIO2", type: "gpio_out" },
    ],
  };
}

// Run a scripted loop that emits `events` in order then finishes, collecting every
// posted message. No writeFiles dep, so writeArtifactsIfReady is a no-op.
async function runEvents(events: any[]): Promise<any[]> {
  const messages: any[] = [];
  const controller = new SessionController({
    postMessage: (m) => messages.push(m),
    loop: async ({ onEvent }: any) => { for (const e of events) onEvent(e); return { terminal: "generated" }; },
  });
  await controller.start({ intent: "wiring", boardId: "esp32-s3-devkitc-1" });
  return messages;
}

test("manifest_updated without renderable wiring: posted manifest gets derived buses/standalone and a derived diagram is emitted", async () => {
  const messages = await runEvents([{ type: "manifest_updated", manifest: richManifest() }]);

  const manifest = messages.find((m) => m.type === "manifest_updated");
  assert.ok(manifest.manifest.wiring, "wiring attached to the wiring-less manifest");
  assert.equal(manifest.manifest.wiring.buses.length, 1, "the I2C bus is derived");
  assert.equal(manifest.manifest.wiring.buses[0].id, "I2C0");
  assert.equal(manifest.manifest.wiring.standalone.length, 1, "the GPIO LED is a standalone part");
  assert.equal(manifest.manifest.wiring.standalone[0].pin, "GPIO2");

  const diagram = messages.find((m) => m.type === "diagram_updated");
  assert.ok(diagram, "the dead diagram_updated wire is now driven from the manifest");
  assert.ok(diagram.diagram.architecture.layers.length > 0, "diagram carries architecture layers");
  assert.ok(diagram.diagram.flow.length > 0, "diagram carries a run flow");
});

test("manifest_updated with authored renderable wiring is passed through verbatim (no derivation)", async () => {
  // A renderable { buses/standalone } authored wiring whose bus id (I2C9) could never be
  // derived from the devices — proves it was passed through, not re-derived. Flipping the
  // guard to always-derive would replace this with a derived I2C0 bus and fail deepEqual.
  const authored = { ...richManifest(), wiring: { buses: [{ type: "i2c", id: "I2C9", signals: [], devices: [] }], standalone: [] } };
  const messages = await runEvents([{ type: "manifest_updated", manifest: authored }]);

  const manifest = messages.find((m) => m.type === "manifest_updated");
  assert.deepEqual(manifest.manifest.wiring, authored.wiring, "authored renderable wiring is untouched");
  assert.strictEqual(manifest.manifest, authored, "a renderable manifest is posted by reference, not shallow-copied");
});

test("manifest_updated with legacy bus-keyed wiring is passed through, not derived over", async () => {
  // { i2c: { sda, scl, devices } } is the THIRD shape buildComponents renders. With no
  // devices[], deriving over it would yield an empty { buses:[], standalone:[] } and blank
  // the tab — so the guard must recognise it as renderable and pass it through. The
  // webview-dom test for this shape posts straight to the DOM, bypassing the controller,
  // so only a host-side test pins the chokepoint guard.
  const busKeyed = { board_id: "esp32-s3-devkitc-1", wiring: { i2c: { sda: "GPIO5", scl: "GPIO6", devices: [{ address: "0x38", label: "AHT20" }] } } };
  const messages = await runEvents([{ type: "manifest_updated", manifest: busKeyed }]);

  const manifest = messages.find((m) => m.type === "manifest_updated");
  assert.deepEqual(manifest.manifest.wiring, busKeyed.wiring, "bus-keyed wiring is preserved, not replaced by an empty derived shape");
  assert.strictEqual(manifest.manifest, busKeyed, "a renderable bus-keyed manifest is posted by reference");
});

test("manifest_updated with a format->path-map wiring still derives a renderable shape (regression lock)", async () => {
  // The real wiring plugin's manifest.wiring is a format->path map, NOT a renderable
  // shape. A naive presence-guard would pass it through and regress the tab to empty;
  // the renderable-shape guard treats it as absent and derives instead.
  const pathMap = { ...richManifest(), wiring: { json: "docs/wiring.json", md: "docs/wiring.md", svg: "docs/wiring.svg", png: "docs/wiring.png" } };
  const messages = await runEvents([{ type: "manifest_updated", manifest: pathMap }]);

  const manifest = messages.find((m) => m.type === "manifest_updated");
  assert.ok(Array.isArray(manifest.manifest.wiring.buses), "the path map was replaced by a derived buses[]");
  assert.equal(manifest.manifest.wiring.buses.length, 1, "the I2C bus is derived from devices[]");
  assert.equal(manifest.manifest.wiring.json, undefined, "the non-renderable path map is gone");
});

test("an authored diagram_updated suppresses the manifest-derived diagram (authored wins)", async () => {
  const authoredDiagram = { architecture: { layers: [{ id: "custom", modules: [{ name: "authored.py" }] }] }, flow: [{ phase: "boot" }] };
  const messages = await runEvents([
    { type: "diagram_updated", diagram: authoredDiagram },
    { type: "manifest_updated", manifest: richManifest() },
  ]);

  const diagrams = messages.filter((m) => m.type === "diagram_updated");
  assert.equal(diagrams.length, 1, "the manifest does not overwrite the authored diagram with a derived one");
  assert.deepEqual(diagrams[0].diagram, authoredDiagram);
});

test("empty devices[] emits empty wiring and diagram shapes without throwing (empty-state contract)", async () => {
  const messages = await runEvents([{ type: "manifest_updated", manifest: { board_id: "esp32-s3-devkitc-1", devices: [] } }]);

  const manifest = messages.find((m) => m.type === "manifest_updated");
  assert.deepEqual(manifest.manifest.wiring, { buses: [], standalone: [] }, "empty wiring shape, not a throw");
  const diagram = messages.find((m) => m.type === "diagram_updated");
  assert.deepEqual(diagram.diagram, { architecture: { layers: [] }, flow: [] }, "empty diagram shape leaves the tab in its empty state");
});

test("deriving never mutates the loop's manifest object", async () => {
  // protocol-loop holds this same reference for the next phase's prompt; enriching it
  // in place would leak derived wiring upstream. The chokepoint must shallow-copy.
  const loopManifest = richManifest();
  const snapshot = JSON.parse(JSON.stringify(loopManifest));
  const messages = await runEvents([{ type: "manifest_updated", manifest: loopManifest }]);

  assert.deepEqual(loopManifest, snapshot, "the manifest the loop still holds is byte-for-byte unchanged");
  const posted = messages.find((m) => m.type === "manifest_updated");
  assert.notStrictEqual(posted.manifest, loopManifest, "the enriched manifest is a distinct object");
});

test("the authored-diagram guard resets per build across reset(): a second run derives again", async () => {
  // Build 1 has an authored diagram (guard latches). After reset(), build 2 must derive
  // again. reset() clears the guard directly; this pins the reset() path (the run() clear
  // is pinned separately by the no-reset continuation test below).
  const messages: any[] = [];
  let run = 0;
  const controller = new SessionController({
    postMessage: (m) => messages.push(m),
    loop: async ({ onEvent }: any) => {
      run += 1;
      if (run === 1) onEvent({ type: "diagram_updated", diagram: { architecture: { layers: [{ id: "custom", modules: [] }] }, flow: [] } });
      onEvent({ type: "manifest_updated", manifest: richManifest() });
      return { terminal: "generated" };
    },
  });

  await controller.start({ intent: "one", boardId: "esp32-s3-devkitc-1" });
  controller.reset();
  await controller.start({ intent: "two", boardId: "esp32-s3-devkitc-1" });

  const diagrams = messages.filter((m) => m.type === "diagram_updated");
  assert.equal(diagrams.length, 2, "build one posts the authored diagram; build two derives its own");
  assert.ok(diagrams[1].diagram.architecture.layers.some((l: any) => l.id === "driver"), "build two's diagram is the manifest-derived one");
});

test("the authored-diagram guard clears on every run() start, even without a reset (continuation)", async () => {
  // A second start() on the same controller and board with NO reset() still re-enters run(),
  // which must clear the guard — otherwise an authored diagram from build one stays latched
  // and build two's manifest never emits its derived diagram. Pins run()'s clear specifically
  // (the reset-based test above passes even if only reset() clears).
  const messages: any[] = [];
  let run = 0;
  const controller = new SessionController({
    postMessage: (m) => messages.push(m),
    loop: async ({ onEvent }: any) => {
      run += 1;
      if (run === 1) onEvent({ type: "diagram_updated", diagram: { architecture: { layers: [{ id: "custom", modules: [] }] }, flow: [] } });
      onEvent({ type: "manifest_updated", manifest: richManifest() });
      return { terminal: "generated" };
    },
  });

  await controller.start({ intent: "one", boardId: "esp32-s3-devkitc-1" });
  await controller.start({ intent: "two", boardId: "esp32-s3-devkitc-1" }); // same board, NO reset

  const diagrams = messages.filter((m) => m.type === "diagram_updated");
  assert.equal(diagrams.length, 2, "build two derives its own diagram — run() cleared the guard without a reset");
  assert.ok(diagrams[1].diagram.architecture.layers.some((l: any) => l.id === "driver"), "build two's diagram is the manifest-derived one");
});

test("recordSupportAction writes to the log, feeds recent_activity, and posts to the webview", async () => {
  const recorded: any[] = [];
  const posted: any[] = [];
  const controller = new SessionController({
    postMessage: (m: any) => posted.push(m),
    recorderFactory: () => ({ record: async (e: any) => { recorded.push(e); } }),
    loop: async () => ({ terminal: "complete" }),
  });
  await controller.start({ intent: "x", boardId: "auto" });

  recorded.length = 0; posted.length = 0;
  controller.recordSupportAction({ type: "support_diagnostics_exported", scope: "session" });

  // Reverting `this.record(event)` in recordSupportAction fails this assertion.
  assert.ok(recorded.some((e) => e.type === "support_diagnostics_exported"), "written to the session log");
  assert.ok(posted.some((m) => m.type === "support_diagnostics_exported"), "forwarded to the Activity feed");
  assert.match(controller.getDiagnostics().recent_activity, /support_diagnostics_exported/, "surfaced in recent_activity");
});

test("stdout_stderr_summary tails serial output, stays bounded, and clears on reset", async () => {
  const controller = new SessionController({
    postMessage: () => {},
    // Feed 25 serial_output lines; the tail cap is 20, so L0..L4 must be dropped.
    loop: async ({ onEvent }: any) => {
      for (let i = 0; i < 25; i++) onEvent({ type: "serial_output", lines: [`L${i}`] });
      return { terminal: "complete" };
    },
  });
  await controller.start({ intent: "x", boardId: "auto" });

  const summary = controller.getDiagnostics().stdout_stderr_summary;
  assert.match(summary, /\bL24\b/, "keeps the newest line");
  assert.match(summary, /\bL5\b/, "L5 is the oldest kept (cap 20)");
  assert.doesNotMatch(summary, /\bL4\b/, "L0..L4 dropped beyond the cap");
  assert.doesNotMatch(summary, /\bL0\b/, "oldest is dropped");

  // Reverting the `this.stdoutTail = []` in reset() fails this.
  controller.reset();
  assert.equal(controller.getDiagnostics().stdout_stderr_summary, "", "reset clears the tail");
});

test("stdout_stderr_summary keeps the NEWEST lines under the cap, dropping the oldest (#35 review)", async () => {
  // 20 lines of ~207 chars -> joined tail well over the 2000-char cap. For a crash diagnostic the
  // traceback is the newest line, so the cap must keep the END, not the start.
  const lines = Array.from({ length: 20 }, (_, i) => `L${i}_${"z".repeat(200)}`);
  lines[0] = "OLDEST_" + "z".repeat(200);
  lines[19] = "NEWEST_TRACEBACK_" + "z".repeat(200);
  const controller = new SessionController({
    postMessage: () => {},
    loop: async ({ onEvent }: any) => { onEvent({ type: "serial_output", lines }); return { terminal: "complete" }; },
  });
  await controller.start({ intent: "x", boardId: "auto" });
  const summary = controller.getDiagnostics().stdout_stderr_summary;
  assert.ok(summary.length <= 2000, `summary truncated to the 2000-char cap (${summary.length})`);
  assert.match(summary, /NEWEST_TRACEBACK/, "the newest line (the traceback) is kept");
  assert.doesNotMatch(summary, /OLDEST/, "the oldest line is dropped");
  // Mutation: revert getDiagnostics to `.slice(0, N)` -> keeps OLDEST, drops NEWEST_TRACEBACK.
});

test("the stdout tail clears on a board switch, not only on reset", async () => {
  let runs = 0;
  const controller = new SessionController({
    postMessage: () => {},
    loop: async ({ onEvent }: any) => { runs++; if (runs === 1) onEvent({ type: "serial_output", lines: ["fromA"] }); return { terminal: "complete" }; },
  });
  await controller.start({ intent: "x", boardId: "boardA" });
  assert.match(controller.getDiagnostics().stdout_stderr_summary, /fromA/);
  // A different board is a fresh session; reverting the start()-board-switch clear leaks board A's tail.
  await controller.start({ intent: "y", boardId: "boardB" });
  assert.equal(controller.getDiagnostics().stdout_stderr_summary, "", "board switch clears the stdout tail");
});

test("startPhase dispatches the optional run at its phase with the envelope as the first message", async () => {
  const inputs: any[] = [];
  let finalPhase: string | null = "upy-analyze-plugin";
  const controller = new SessionController({
    postMessage: () => { },
    loop: async (input: any) => { inputs.push(input); return { terminal: "complete", state: { phase: finalPhase, manifest: input.state?.manifest, intent: input.intent } }; },
  });

  finalPhase = "upy-gen-driver-plugin"; // standalone: the run ends on the phase it was dispatched at
  const res = await controller.startPhase({ phase: "upy-gen-driver-plugin", envelope: "START_PHASE_ENVELOPE", manifest: { drv: 1 } });
  assert.equal(res.terminal, "complete");
  const disp = inputs.at(-1);
  assert.equal(disp.state.phase, "upy-gen-driver-plugin", "loop starts at the dispatched phase (body.phase)");
  assert.deepEqual(disp.state.manifest, { drv: 1 }, "startManifest threads through");
  assert.equal(disp.intent, "START_PHASE_ENVELOPE", "the envelope is the first user message");
});

test("startPhase is a transparent excursion: a standalone run restores the prior main-flow state", async () => {
  const inputs: any[] = [];
  let finalPhase: string | null = null;
  const controller = new SessionController({
    postMessage: () => { },
    loop: async (input: any) => { inputs.push(input); return { terminal: "complete", state: { phase: finalPhase, manifest: input.state?.manifest ?? { m: 1 }, intent: input.intent } }; },
  });

  finalPhase = "upy-analyze-plugin";                       // seed a prior main-flow state
  await controller.start({ intent: "build a thing", boardId: "auto" });
  finalPhase = "upy-gen-driver-plugin";                    // standalone dispatch ends on its own phase
  await controller.startPhase({ phase: "upy-gen-driver-plugin", envelope: "ENV", manifest: { drv: 1 } });
  // Mutation: drop the `this.state = priorState` restore -> retry resumes gen-driver and this fails.
  finalPhase = "x";
  await controller.retry();
  assert.equal(inputs.at(-1).state.phase, "upy-analyze-plugin", "a standalone excursion did NOT leave gen-driver in the resume state");
});

test("startPhase keeps the chained state when the optional run continues into a canonical phase (pipeline)", async () => {
  const inputs: any[] = [];
  let finalPhase: string | null = null;
  const controller = new SessionController({
    postMessage: () => { },
    loop: async (input: any) => { inputs.push(input); return { terminal: "complete", state: { phase: finalPhase, manifest: input.state?.manifest ?? {}, intent: input.intent } }; },
  });

  finalPhase = "upy-analyze-plugin";
  await controller.start({ intent: "build", boardId: "auto" });
  finalPhase = "upy-generate-plugin";                      // pipeline: gen-driver chained into generate
  await controller.startPhase({ phase: "upy-gen-driver-plugin", envelope: "ENV" });
  finalPhase = "x";
  await controller.retry();
  assert.equal(inputs.at(-1).state.phase, "upy-generate-plugin", "a pipeline continuation kept the chained (canonical) state");
});

test("startPhase rejects while a run is in flight (register #16)", async () => {
  const posted: any[] = [];
  let release: (() => void) | null = null;
  const controller = new SessionController({
    postMessage: (m: any) => posted.push(m),
    loop: () => new Promise<any>((r) => { release = () => r({ terminal: "complete" }); }),
  });
  const running = controller.start({ intent: "x", boardId: "auto" });
  await flushMicrotasks();
  const busy = await controller.startPhase({ phase: "upy-gen-driver-plugin", envelope: "E" });
  assert.equal(busy.terminal, "session_busy", "no second run over an in-flight one");
  assert.ok(posted.some((m) => m.type === "session_busy"));
  release!();
  await running;
});

test("a gen-driver phase_complete surfaces gen_driver_status; other phases do not", async () => {
  const posted: any[] = [];
  const controller = new SessionController({
    postMessage: (m: any) => posted.push(m),
    loop: async ({ onEvent }: any) => {
      // gen-driver phase_complete uses the DOMAIN token "gen-driver" and carries driver_status
      onEvent({ type: "phase_complete", payload: { phase: "gen-driver", result: "success", driver_status: "ready", summary: "SHT30 driver ready" } });
      // a non-gen-driver phase_complete must NOT post gen_driver_status
      onEvent({ type: "phase_complete", payload: { phase: "generate", result: "success" } });
      return { terminal: "complete" };
    },
  });
  await controller.start({ intent: "x", boardId: "auto" });
  const statuses = posted.filter((m) => m.type === "gen_driver_status");
  // Mutation: drop the gen_driver_status post -> 0; drop the phase check -> 2 (generate leaks in).
  assert.equal(statuses.length, 1, "only the gen-driver phase_complete posts gen_driver_status");
  assert.equal(statuses[0].status, "ready");
  assert.equal(statuses[0].detail, "SHT30 driver ready");
});

test("a diagram run's thin manifest_content does not blank a devices-bearing manifest across runs (#17)", async () => {
  // The real flow is TWO run()s: a generate build sets the devices manifest, then a SEPARATE diagram
  // excursion (startPhase) streams a thin one. run() clears latestManifest at entry, so the guard only
  // works if the excursion preserves it — a one-run test (both events in one loop) can't catch this.
  const posted: any[] = [];
  let onEventFor: (onEvent: (e: any) => void) => void = () => { };
  const controller = new SessionController({
    postMessage: (m: any) => posted.push(m),
    loop: async ({ onEvent }: any) => { onEventFor(onEvent); return { terminal: "complete", state: { phase: "upy-diagram-plugin" } }; },
  });
  // run 1: a normal build streams a devices-bearing manifest
  onEventFor = (onEvent) => onEvent({ type: "manifest_updated", manifest: { devices: [{ name: "SHT30" }], wiring: { buses: [], standalone: [] } } });
  await controller.start({ intent: "x", boardId: "auto" });
  assert.equal((controller.getLatestManifest() as any).devices.length, 1, "run 1 set the devices manifest");
  // run 2: a SEPARATE diagram excursion streams a thin manifest_content
  posted.length = 0;
  onEventFor = (onEvent) => onEvent({ type: "manifest_updated", manifest: { phase: "diagram" } });
  await controller.startPhase({ phase: "upy-diagram-plugin", envelope: "ENV" });
  const m = controller.getLatestManifest() as any;
  // Mutation: drop preserveManifest (or the devices guard) -> the excursion clears/clobbers latestManifest
  // and devices vanish.
  assert.ok(Array.isArray(m?.devices) && m.devices.length === 1, "the devices manifest survives the separate diagram run");
  const lastPosted = posted.filter((p) => p.type === "manifest_updated").at(-1);
  assert.equal(lastPosted.manifest.devices?.length, 1, "the re-posted manifest keeps the devices so the Wiring tab stays populated");
});

test("capturePhaseArtifacts folds a gen-driver file_list and keeps skipping path-less entries", async () => {
  const controller = new SessionController({
    postMessage: () => { },
    loop: async ({ onEvent }: any) => {
      onEvent({ type: "phase_complete", payload: { phase: "gen-driver", result: "success", artifacts: [
        // gen-driver leads with a file_list whose paths nest at files[].path
        { type: "file_list", files: [{ path: "firmware/drivers/sht30_driver/__init__.py" }, { path: "firmware/drivers/sht30_driver/mock.py" }] },
        // a flat {type, path} entry is captured as-is
        { type: "markdown", path: "docs/wiring.md" },
        // a path-less, file_list-less entry (diagram's type:"table") has nothing to open -> skipped
        { type: "table", rows: [["a", "b"]] },
      ] } });
      return { terminal: "complete" };
    },
  });
  await controller.start({ intent: "x", boardId: "auto" });
  const paths = controller.phaseArtifactRecords().map((r) => r.path).sort();
  // Mutation: revert to the top-level-path-only capture -> the two file_list paths vanish.
  assert.deepEqual(paths, ["docs/wiring.md", "firmware/drivers/sht30_driver/__init__.py", "firmware/drivers/sht30_driver/mock.py"]);
  assert.ok(!controller.phaseArtifactRecords().some((r) => r.role === "table"), "the path-less table entry is not captured");
});

test("a generate driver-ready block posts gen_driver_required; a clean generate does not (#53)", async () => {
  const posted: any[] = [];
  const controller = new SessionController({
    postMessage: (m: any) => posted.push(m),
    loop: async ({ onEvent }: any) => {
      // generate blocks pre-application-generation on a cold driver (partial + structured_errors)
      onEvent({ type: "phase_complete", payload: { phase: "generate", result: "partial", structured_errors: [{ code: "COLD_DRIVER_REQUIRED", device: "SHT30", next_action: "run_upy_gen_driver_plugin_or_simulate_only" }] } });
      // a clean generate must NOT offer
      onEvent({ type: "phase_complete", payload: { phase: "generate", result: "success" } });
      return { terminal: "complete" };
    },
  });
  await controller.start({ intent: "x", boardId: "auto" });
  const offers = posted.filter((m) => m.type === "gen_driver_required");
  // Mutation: drop the detect+post -> 0; broaden to non-partial -> the clean generate also offers (2).
  assert.equal(offers.length, 1, "only the blocked generate offers the gen-driver run");
  assert.equal(offers[0].blocks[0].device, "SHT30");
});

test("captures generate's optional_next_phases and clears them on reset (#8, register #9)", async () => {
  const posted: any[] = [];
  const controller = new SessionController({
    postMessage: (m: any) => posted.push(m),
    loop: async ({ onEvent }: any) => {
      onEvent({ type: "phase_complete", payload: { phase: "generate", result: "success", optional_next_phases: [{ phase: "upy-diagram-plugin", reason: "arch diagram" }, { phase: "upy-wiring-plugin" }] } });
      return { terminal: "complete" };
    },
  });
  await controller.start({ intent: "x", boardId: "auto" });
  assert.equal(controller.getOptionalNextPhases().length, 2, "captured the offered flows");
  assert.ok(posted.some((m) => m.type === "optional_flows" && m.phases.length === 2), "posts optional_flows so the panel can gate the entries");
  // register #9: reset() must clear it, or a Restart leaves the prior session's offers live.
  // Mutation: drop the optionalNextPhases clear in reset() -> stays 2 and this fails.
  controller.reset();
  assert.equal(controller.getOptionalNextPhases().length, 0, "reset clears the captured flows");
});

test("captures the generate phase_complete for the wiring/diagram source (Q3) and clears it on reset", async () => {
  const controller = new SessionController({
    postMessage: () => { },
    loop: async ({ onEvent }: any) => {
      onEvent({ type: "phase_complete", payload: { phase: "generate", result: "success", summary: "app generated" } });
      // a non-generate phase_complete must NOT overwrite it
      onEvent({ type: "phase_complete", payload: { phase: "gen-driver", result: "success" } });
      return { terminal: "complete" };
    },
  });
  await controller.start({ intent: "x", boardId: "auto" });
  // Mutation: drop the generate capture -> undefined and the run gets no source_phase_complete_path.
  assert.equal((controller.getLatestGeneratePhaseComplete() as any)?.summary, "app generated", "keeps the generate result, not gen-driver's");
  controller.reset();
  assert.equal(controller.getLatestGeneratePhaseComplete(), undefined, "reset clears it (register #9)");
});

test("optional_next_phases accepts the plain-string shape too (normalized to {phase})", async () => {
  const posted: any[] = [];
  const controller = new SessionController({
    postMessage: (m: any) => posted.push(m),
    loop: async ({ onEvent }: any) => {
      // some generate emitters (the diagram plugin's fixture) use plain strings, not {phase} objects
      onEvent({ type: "phase_complete", payload: { phase: "generate", result: "success", optional_next_phases: ["upy-wiring-plugin", "upy-diagram-plugin"] } });
      return { terminal: "complete" };
    },
  });
  await controller.start({ intent: "x", boardId: "auto" });
  // Mutation: drop the string normalization -> phase is undefined and the entries/host-gate never fire.
  assert.deepEqual(controller.getOptionalNextPhases().map((o) => o.phase), ["upy-wiring-plugin", "upy-diagram-plugin"]);
  const flows = posted.find((m) => m.type === "optional_flows");
  assert.ok(flows.phases.every((p: any) => typeof p.phase === "string"), "posted phases key on .phase for the panel");
});

test("a successful generate with NO optional_next_phases still offers wiring+diagram (spec 04)", async () => {
  // The generate SKILL requires optional_next_phases on success but the model sometimes drops it,
  // which used to leave the flows unreachable. A successful generate must make them triggerable.
  const posted: any[] = [];
  const controller = new SessionController({
    postMessage: (m: any) => posted.push(m),
    loop: async ({ onEvent }: any) => {
      onEvent({ type: "phase_complete", payload: { phase: "generate", result: "success", summary: "app generated" } });
      return { terminal: "complete" };
    },
  });
  await controller.start({ intent: "x", boardId: "auto" });
  // Mutation: drop the generate-success default -> both stay unreachable and this fails.
  assert.deepEqual(controller.getOptionalNextPhases().map((o) => o.phase), ["upy-wiring-plugin", "upy-diagram-plugin"], "synthesizes the default offer after a successful generate");
  const flows = posted.find((m) => m.type === "optional_flows");
  assert.ok(flows && flows.phases.length === 2, "posts optional_flows so the entries appear without the model's offer");
});

test("a non-success generate does NOT offer the optional flows", async () => {
  // A partial/failed generate has not produced valid firmware for wiring/diagram to read.
  const posted: any[] = [];
  const controller = new SessionController({
    postMessage: (m: any) => posted.push(m),
    loop: async ({ onEvent }: any) => {
      onEvent({ type: "phase_complete", payload: { phase: "generate", result: "partial", summary: "incomplete" } });
      return { terminal: "complete" };
    },
  });
  await controller.start({ intent: "x", boardId: "auto" });
  // Mutation: drop the result==="success" guard -> a partial generate offers flows and this fails.
  assert.equal(controller.getOptionalNextPhases().length, 0, "no offer after a non-success generate");
  // A partial DOES post optional_flows, but EMPTY: that is the clear signal that hides the webview entries
  // (register #3, so a prior success's offers can't linger), not an offer. What matters: zero phases offered.
  const flows = posted.filter((m) => m.type === "optional_flows");
  assert.ok(flows.every((m) => m.phases.length === 0), "any optional_flows posted for a partial is empty (a clear, not an offer)");
});

test("generate degraded shape (phase only in manifest_content) still offers + captures for Q3", async () => {
  // REAL runtime shape (2026-07-16 trace): the model dropped the top-level payload.phase AND
  // optional_next_phases, putting phase only in manifest_content. The offer + Q3 capture key off
  // the DOMAIN phase, so they must resolve it from manifest_content, not payload.phase.
  // Mutation: check event.payload.phase only -> both are undefined here and this fails.
  const posted: any[] = [];
  const controller = new SessionController({
    postMessage: (m: any) => posted.push(m),
    loop: async ({ onEvent }: any) => {
      onEvent({ type: "phase_complete", payload: { result: "success", summary: "app generated", next_phase: "upy-deploy-plugin", manifest_content: { phase: "generate", domain_phase: "generate" } } });
      return { terminal: "complete" };
    },
  });
  await controller.start({ intent: "x", boardId: "auto" });
  assert.deepEqual(controller.getOptionalNextPhases().map((o) => o.phase), ["upy-wiring-plugin", "upy-diagram-plugin"], "offers both flows off manifest_content.phase");
  assert.ok(posted.some((m) => m.type === "optional_flows" && m.phases.length === 2), "posts optional_flows for the degraded shape");
  assert.equal((controller.getLatestGeneratePhaseComplete() as any)?.summary, "app generated", "Q3 captures the generate result off manifest_content.phase");
});

test("a later partial generate clears the offers and keeps the last success payload (#3)", async () => {
  // Offers + latestGeneratePhaseComplete must gate on result === "success". A success installs offers and
  // stores its payload; a LATER partial generate (even one carrying optional_next_phases) must CLEAR the
  // offers and NOT clobber the stored success — else the host permits wiring/diagram against a partial the
  // plugin rejects. Mutation: install offers without the success gate, or set latest on any result -> fails.
  const posted: any[] = [];
  const controller = new SessionController({
    postMessage: (m: any) => posted.push(m),
    loop: async ({ onEvent }: any) => {
      onEvent({ type: "phase_complete", payload: { result: "success", summary: "app generated", manifest_content: { phase: "generate" } } });
      onEvent({ type: "phase_complete", payload: { result: "partial", summary: "blocked", optional_next_phases: ["upy-wiring-plugin"], manifest_content: { phase: "generate" } } });
      return { terminal: "complete" };
    },
  });
  await controller.start({ intent: "x", boardId: "auto" });
  assert.deepEqual(controller.getOptionalNextPhases(), [], "the later partial cleared the offers");
  assert.equal((controller.getLatestGeneratePhaseComplete() as any)?.summary, "app generated", "the success payload survives the later partial");
  const flows = posted.filter((m) => m.type === "optional_flows");
  assert.deepEqual(flows.at(-1)?.phases, [], "the last optional_flows post is empty so the webview hides the entries");
});

test("stores the driver-ready gate and threads it to a pipeline dispatch across two runs (#4)", async () => {
  // Detection runs at generate-time (has errors); dispatch runs later with the manifest only. An
  // error-code-only block (the manifest device has NO status) isn't re-derivable at dispatch, so the stored
  // gate result must force pipeline. Register #19: a later clean generate clears it. Mutations that fail this:
  // don't store at :654 -> getter 0; drop the `blocked` handling in buildGenDriverDispatch -> standalone;
  // drop the clean-generate clear -> run 2 stays blocked.
  const posted: any[] = [];
  let call = 0;
  const controller = new SessionController({
    postMessage: (m: any) => posted.push(m),
    loop: async ({ onEvent }: any) => {
      call += 1;
      if (call === 1) {
        // manifest_updated populates getLatestManifest() (what panel.ts snapshots for the dispatch); the
        // device is statusless here, so ONLY the stored error-code gate can force pipeline.
        onEvent({ type: "manifest_updated", manifest: { phase: "generate", devices: [{ name: "MAX30102", driver: { source: "github" } }] } });
        onEvent({ type: "phase_complete", payload: { phase: "generate", result: "partial",
          errors: [{ code: "DRIVER_STATUS_UNSUPPORTED", device: "MAX30102", driver_status: "installed" }],
          manifest_content: { phase: "generate", devices: [{ name: "MAX30102", driver: { source: "github" } }] } } });
      } else {
        onEvent({ type: "phase_complete", payload: { phase: "generate", result: "success", summary: "ok",
          manifest_content: { phase: "generate", devices: [{ name: "MAX30102", driver: { status: "ready", driver_id: "max30102", path: "p.py", hardware_marker: "SELF_TEST_PASS:max30102:HR" } }] } } });
      }
      return { terminal: "complete" };
    },
  });
  await controller.start({ intent: "x", boardId: "auto" });
  assert.ok(posted.some((m) => m.type === "gen_driver_required"), "offered gen-driver");
  assert.equal(controller.getDriverReadyBlocks().length, 1, "the gate result is stored");
  // The exact expression panel.ts uses to dispatch, over the (statusless) manifest:
  const payload = buildGenDriverDispatch({
    sessionId: "s", msgId: "m", timestamp: "t",
    sources: [{ type: "current_cold_driver_item", artifact_path: null, sha256: null, primary: true, metadata: {} }],
    manifestContent: controller.getLatestManifest(),
    blocked: controller.getDriverReadyBlocks().length > 0,
  }).payload as any;
  assert.equal(payload.mode, "pipeline", "error-code-only block still forces pipeline");
  assert.ok(payload.manifest_content && payload.source_phase, "pipeline carries manifest_content + source_phase");

  await controller.start({ intent: "y", boardId: "auto" });
  assert.equal(controller.getDriverReadyBlocks().length, 0, "a later clean generate success clears the stored gate");
});

test("getLastPhaseComplete records the run's terminal result so a render can gate on success", async () => {
  // A wiring/diagram excursion gates its post-run render on result === "success"; a partial run
  // (e.g. mermaid.ink network render denied) must be distinguishable. Mutation: drop the
  // lastPhaseComplete capture -> undefined and the render would false-succeed on a partial run.
  const partial = new SessionController({
    postMessage: () => { },
    loop: async ({ onEvent }: any) => {
      onEvent({ type: "phase_complete", payload: { manifest_content: { phase: "wiring" }, result: "partial" } });
      return { terminal: "complete" };
    },
  });
  await partial.start({ intent: "x", boardId: "auto" });
  assert.equal(partial.getLastPhaseComplete()?.result, "partial", "captures a partial run's result");

  const ok = new SessionController({
    postMessage: () => { },
    loop: async ({ onEvent }: any) => {
      onEvent({ type: "phase_complete", payload: { phase: "upy-diagram-plugin", manifest_content: { phase: "diagram" }, result: "success" } });
      return { terminal: "complete" };
    },
  });
  await ok.start({ intent: "x", boardId: "auto" });
  assert.equal(ok.getLastPhaseComplete()?.result, "success", "captures a successful run's result");
});

test("getLastPhaseComplete captures the run's errors (so a network-render denial can be honored)", async () => {
  // A deny yields partial + *_IMAGE_RENDER_PERMISSION_DENIED; the panel skips the host render on it.
  // Mutation: drop errors from the capture -> the deny is invisible and the host renders anyway.
  const controller = new SessionController({
    postMessage: () => { },
    loop: async ({ onEvent }: any) => {
      onEvent({ type: "phase_complete", payload: { manifest_content: { phase: "diagram" }, result: "partial", errors: ["DIAGRAM_IMAGE_RENDER_PERMISSION_DENIED"] } });
      return { terminal: "complete" };
    },
  });
  await controller.start({ intent: "x", boardId: "auto" });
  assert.match(JSON.stringify(controller.getLastPhaseComplete()?.errors), /RENDER_PERMISSION_DENIED/, "captures the deny error");
  controller.reset();
  assert.equal(controller.getLastPhaseComplete(), undefined, "reset clears it (register #9)");
});

test("getLastPhaseComplete retains structured network_permission so a decision-only deny is honored (#1)", async () => {
  // The diagram deny fixture carries network_permission.decision "deny". The controller must RETAIN it,
  // not just phase/result/errors — otherwise a deny whose error code the panel regex doesn't match (here a
  // non-*_PERMISSION_DENIED code) would slip through and the host would upload to mermaid.ink. Mutation:
  // drop network_permission from the lastPhaseComplete capture -> isNetworkRenderDenied is false and this fails.
  const controller = new SessionController({
    postMessage: () => { },
    loop: async ({ onEvent }: any) => {
      onEvent({ type: "phase_complete", payload: { manifest_content: { phase: "diagram" }, result: "partial", errors: [{ code: "SOME_OTHER_PARTIAL_REASON" }], network_permission: { domain: "mermaid.ink", decision: "deny" } } });
      return { terminal: "complete" };
    },
  });
  await controller.start({ intent: "x", boardId: "auto" });
  const runInfo = controller.getLastPhaseComplete();
  assert.deepEqual((runInfo?.network_permission as any), { domain: "mermaid.ink", decision: "deny" }, "the structured decision is retained");
  assert.equal(isNetworkRenderDenied(runInfo), true, "a decision-only deny is honored (no matching error code)");
});

test("a later run that emits no phase_complete does not leak the prior run's result (run() entry clears)", async () => {
  // register #19: without the clear at run() entry, an excursion that emits nothing would inherit a
  // prior run's success and the render would fire. Mutation: drop the run()-entry clear -> stays success.
  let call = 0;
  const controller = new SessionController({
    postMessage: () => { },
    loop: async ({ onEvent }: any) => {
      call += 1;
      if (call === 1) onEvent({ type: "phase_complete", payload: { manifest_content: { phase: "diagram" }, result: "success" } });
      return { terminal: "complete" }; // 2nd run emits nothing
    },
  });
  await controller.start({ intent: "x", boardId: "auto" });
  assert.equal(controller.getLastPhaseComplete()?.result, "success");
  await controller.start({ intent: "y", boardId: "auto" });
  assert.equal(controller.getLastPhaseComplete(), undefined, "the second run's entry cleared the prior result");
});

// ---- per-phase credit usage (card #87) ----

// Drive one turn: a phase boundary, then the credits event the backend streams after it.
const creditsTurn = (onEvent: any, phase: string, remaining: number, extra: Record<string, any> = {}) => {
  onEvent({ type: "phase_start", phase });
  onEvent({ type: "credits", remaining, dailyGrant: 50, resetsAt: "2026-07-26T00:00:00Z", ...extra });
};

test("a credits event writes a per-phase credit_usage record stamped with the phase in flight", async () => {
  // The credits event is the ONE place per-turn consumption arrives, and currentPhase moves on
  // as soon as the next phase starts — so the record must be stamped at arrival. Mutation: stamp
  // it at flush/session end instead and every record reports the LAST phase.
  const recorded: any[] = [];
  const controller = new SessionController({
    postMessage: () => { },
    anonId: "machine-42",
    recorderFactory: () => ({ record: async (e: any) => { recorded.push(e); } }),
    loop: async ({ onEvent }: any) => {
      onEvent({ type: "manifest_updated", manifest: { board_id: "esp32", devices: [{ id: "a" }, { id: "b" }] } });
      creditsTurn(onEvent, "analyze", 49);
      onEvent({ type: "code_updated", path: "main.py", code: "import machine\nled = machine.Pin(2)\n" });
      creditsTurn(onEvent, "generate", 46);
      return { terminal: "complete" };
    },
  });

  await controller.start({ intent: "blink an LED", boardId: "esp32" });

  const usage = recorded.filter((e) => e.type === "credit_usage").map((e) => e.usage);
  assert.equal(usage.length, 2, "one record per metered turn");
  assert.equal(usage[0].phase, "analyze");
  assert.equal(usage[0].operation, "phase");
  assert.equal(usage[0].remaining_quota, 49);
  assert.equal(usage[0].device_count, 2, "complexity dimension from the manifest in flight");
  assert.equal(usage[0].anon_id, "machine-42");
  assert.ok(String(usage[0].session_id).startsWith("session-"), "carries the session trace id");
  assert.equal(usage[1].phase, "upy-generate-plugin");
  assert.equal(usage[1].operation, "generate");
  assert.equal(usage[1].credits_consumed, 3, "49 -> 46 is the second turn's balance delta");
  assert.equal(usage[1].remaining_quota, 46);
  assert.equal(usage[1].generated_file_count, 1);
  assert.equal(usage[1].code_line_count, 3, "line COUNT only — never the code");
  // By construction the record cannot carry the intent or the generated source.
  const serialized = JSON.stringify(usage);
  assert.equal(serialized.includes("machine.Pin"), false, "generated code must not reach the record");
  assert.equal(serialized.includes("blink an LED"), false, "the intent must not reach the record");
});

test("the webview gets the usage on the same session_event the quota bar reads", async () => {
  // Single source of truth: the Activity credit line and the quota bar must not be able to
  // disagree. Mutation: post usage on its own message -> two events, two sources of truth.
  const posted: any[] = [];
  const controller = new SessionController({
    postMessage: (m: any) => posted.push(m),
    loop: async ({ onEvent }: any) => { creditsTurn(onEvent, "generate", 46); return { terminal: "complete" }; },
  });

  await controller.start({ intent: "x", boardId: "esp32" });

  const events = posted.filter((m) => m.type === "session_event" && m.event?.kind === "credits");
  assert.equal(events.length, 1, "exactly one credits message");
  assert.equal(events[0].event.balance, 46, "the quota bar's balance");
  assert.equal(events[0].event.usage.remaining_quota, 46, "and the usage record's, from the same event");
  assert.equal(events[0].event.usage.operation, "generate");
});

test("a balance increase (refund/refill) reports unknown consumption, never a fabricated 0 or a negative", async () => {
  // The server refunds a reserved credit (or the daily grant refills), so the balance goes UP.
  // The delta is then meaningless — a paid-then-refilled turn is indistinguishable from a pure
  // refund — so this turn's cost is UNKNOWN, not 0. The old behavior clamped the inverted delta
  // to 0, which misreads a paid turn across a refill as free and understates real spend.
  // Mutation: report 0 (or the negative delta) here -> the rollup counts a refill turn as known-free.
  const recorded: any[] = [];
  const controller = new SessionController({
    postMessage: () => { },
    recorderFactory: () => ({ record: async (e: any) => { recorded.push(e); } }),
    loop: async ({ onEvent }: any) => {
      creditsTurn(onEvent, "analyze", 47);
      creditsTurn(onEvent, "analyze", 49); // refund/refill: balance climbs back up
      return { terminal: "complete" };
    },
  });

  await controller.start({ intent: "x", boardId: "esp32" });

  const usage = recorded.filter((e) => e.type === "credit_usage").map((e) => e.usage);
  assert.equal(usage[1].credits_consumed, undefined, "a balance increase yields unknown, not a fabricated 0");
  assert.equal(usage[1].remaining_quota, 49, "the balance itself is still reported truthfully");
});

test("a paid turn across a daily refill is not swallowed as free", async () => {
  // The concrete failure the unknown-on-increase rule prevents: the balance is nearly spent,
  // the daily grant refills, then a real paid turn follows. The refill turn is unknown, and
  // because the baseline re-advances to the post-refill balance, the paid turn after it is
  // measured correctly instead of against a stale pre-refill baseline.
  // Mutation: clamp the inverted delta to 0 on the refill -> the refill turn reads free AND its
  // stale baseline makes the following paid turn's delta wrong too.
  const recorded: any[] = [];
  const controller = new SessionController({
    postMessage: () => { },
    recorderFactory: () => ({ record: async (e: any) => { recorded.push(e); } }),
    loop: async ({ onEvent }: any) => {
      creditsTurn(onEvent, "generate", 2);   // baseline: 2 left
      creditsTurn(onEvent, "generate", 50);  // daily refill -> unknown, re-baselines to 50
      creditsTurn(onEvent, "generate", 49);  // a real 1-credit turn against the new baseline
      return { terminal: "complete" };
    },
  });

  await controller.start({ intent: "x", boardId: "esp32" });

  const usage = recorded.filter((e) => e.type === "credit_usage").map((e) => e.usage);
  assert.equal(usage[1].credits_consumed, undefined, "the refill turn's cost is unknown, not 0");
  assert.equal(usage[2].credits_consumed, 1, "the paid turn after the refill is measured correctly");
});

test("a retry and an absorbed supplement label the turn they pay for", async () => {
  // A retried generate must not be counted as a first-try generate, and the turn that folds in
  // a queued note is its own cost line. Mutation: derive the operation from the phase alone ->
  // both records read "generate" and retry/supplement cost is invisible.
  const recorded: any[] = [];
  const controller = new SessionController({
    postMessage: () => { },
    recorderFactory: () => ({ record: async (e: any) => { recorded.push(e); } }),
    loop: async ({ onEvent, onSafePoint }: any) => {
      onEvent({ type: "phase_start", phase: "generate" });
      onSafePoint?.("generate", true); // drains the queued supplement
      onEvent({ type: "credits", remaining: 48, dailyGrant: 50 });
      return { terminal: "llm_unreachable", state: { phase: "generate" } };
    },
  });

  await controller.start({ intent: "x", boardId: "esp32" });
  controller.submitSupplement("also log the temperature");
  await controller.start({ intent: "y", boardId: "esp32" });
  await controller.retry();

  const usage = recorded.filter((e) => e.type === "credit_usage").map((e) => e.usage);
  assert.equal(usage[0].operation, "generate", "no note queued, no retry: bills to the phase");
  assert.equal(usage[1].operation, "supplement", "the turn that absorbed the note");
  assert.equal(usage[2].operation, "retry", "the re-issued turn");
  assert.equal(usage[2].retry_count, 1, "the manual retry is counted");
});

test("credit accumulators do not bleed across sessions (Restart)", async () => {
  // reset() nulls boardId, so start()'s board-change clear is short-circuited — the credit
  // state must be cleared in reset() too. Mutation: clear only on board change -> run 2's first
  // record inherits run 1's balance baseline (a bogus 44-credit delta), retry_count and flags.
  const recorded: any[] = [];
  const controller = new SessionController({
    postMessage: () => { },
    recorderFactory: () => ({ record: async (e: any) => { recorded.push(e); } }),
    loop: async ({ onEvent }: any) => {
      onEvent({ type: "connect_retry", attempt: 1, maxAttempts: 3 });
      creditsTurn(onEvent, "wiring", 46);
      creditsTurn(onEvent, "diagram", 44);
      return { terminal: "complete" };
    },
  });

  await controller.start({ intent: "x", boardId: "esp32" });
  const first = recorded.filter((e) => e.type === "credit_usage").map((e) => e.usage);
  assert.equal(first[1].wiring, true);
  assert.equal(first[1].diagram, true);
  assert.equal(first[1].retry_count, 1);
  assert.equal(first[1].credits_consumed, 2);

  recorded.length = 0;
  controller.reset();
  await controller.start({ intent: "y", boardId: "esp32" });

  const second = recorded.filter((e) => e.type === "credit_usage").map((e) => e.usage);
  assert.equal(second[0].credits_consumed, undefined, "no balance baseline carried over");
  assert.notEqual(second[0].session_id, first[0].session_id, "a fresh session id");
  assert.equal(controller.getCreditUsage().length, second.length, "the accumulator holds only this session");
  assert.equal(second[0].retry_count, 1, "this session's own retry, not run 1's");
});

test("credit accumulators are cleared on a board switch too", async () => {
  // The other clear site: a new board is a new session without a reset(). Mutation: drop the
  // board-change clear -> the ESP32 run's wiring flag and balance baseline follow the RP2040 run.
  const recorded: any[] = [];
  const controller = new SessionController({
    postMessage: () => { },
    recorderFactory: () => ({ record: async (e: any) => { recorded.push(e); } }),
    loop: async ({ onEvent }: any) => { creditsTurn(onEvent, "wiring", 40); return { terminal: "complete" }; },
  });

  await controller.start({ intent: "x", boardId: "esp32" });
  recorded.length = 0;
  await controller.start({ intent: "y", boardId: "rp2040" });

  const usage = recorded.filter((e) => e.type === "credit_usage").map((e) => e.usage);
  assert.equal(usage[0].credits_consumed, undefined, "no balance baseline from the ESP32 session");
  assert.equal(controller.getCreditUsage().length, 1, "only the RP2040 session's record");
});

test("a stalled phase attaches its error code to the turn that paid for it", async () => {
  // A failing turn still costs a credit; without the code the aggregate cannot tell an
  // expensive failure from an expensive success. Mutation: drop lastErrorCode -> undefined.
  const recorded: any[] = [];
  const controller = new SessionController({
    postMessage: () => { },
    recorderFactory: () => ({ record: async (e: any) => { recorded.push(e); } }),
    loop: async ({ onEvent }: any) => {
      onEvent({ type: "phase_start", phase: "generate" });
      onEvent({ type: "phase_stalled", phase: "generate", reason: "no_tool_calls" });
      onEvent({ type: "credits", remaining: 45, dailyGrant: 50 });
      onEvent({ type: "credits", remaining: 44, dailyGrant: 50 });
      return { terminal: "stalled" };
    },
  });

  await controller.start({ intent: "x", boardId: "esp32" });

  const usage = recorded.filter((e) => e.type === "credit_usage").map((e) => e.usage);
  assert.equal(usage[0].error_code, "no_tool_calls");
  assert.equal(usage[1].error_code, undefined, "one-shot: it labels the turn it happened in");
});

test("a credits event carrying the server fields records model, tokens and the real charge", async () => {
  // Card #87 slice C: the four blocked fields land in the record once the backend sends
  // them, and the authoritative charge coexists with the balance-delta estimate. Mutation:
  // drop the mapping in accumulateCreditUsage -> the record is estimate-only forever.
  const recorded: any[] = [];
  const controller = new SessionController({
    postMessage: () => { },
    recorderFactory: () => ({ record: async (e: any) => { recorded.push(e); } }),
    loop: async ({ onEvent }: any) => {
      onEvent({ type: "phase_start", phase: "generate" });
      onEvent({ type: "credits", remaining: 46, dailyGrant: 50, charged: 3, model: "deepseek-v4-pro", inputTokens: 1200, outputTokens: 180, cacheHitTokens: 1024 });
      return { terminal: "complete" };
    },
  });

  await controller.start({ intent: "x", boardId: "esp32" });

  const usage = recorded.filter((e) => e.type === "credit_usage").map((e) => e.usage)[0];
  assert.equal(usage.charged, 3, "the authoritative deduction");
  assert.equal(usage.model, "deepseek-v4-pro");
  assert.equal(usage.input_tokens, 1200);
  assert.equal(usage.output_tokens, 180);
  assert.equal(usage.cache_hit_tokens, 1024);
  assert.equal(usage.remaining_quota, 46);
  // The very first turn of a session has no balance baseline, so only the server's charge
  // can answer what it cost — which is exactly why the field is worth having.
  assert.equal(usage.credits_consumed, undefined);
});

test("an old backend still produces a valid record with the server fields unset", async () => {
  // The extension ships before the server deploys. Mutation: default the fields to 0 ->
  // every pre-enrichment session reports free turns and a 0-token model.
  const recorded: any[] = [];
  const controller = new SessionController({
    postMessage: () => { },
    recorderFactory: () => ({ record: async (e: any) => { recorded.push(e); } }),
    loop: async ({ onEvent }: any) => {
      onEvent({ type: "phase_start", phase: "generate" });
      onEvent({ type: "credits", remaining: 49, dailyGrant: 50 });
      onEvent({ type: "credits", remaining: 46, dailyGrant: 50 });
      return { terminal: "complete" };
    },
  });

  await controller.start({ intent: "x", boardId: "esp32" });

  const usage = recorded.filter((e) => e.type === "credit_usage").map((e) => e.usage);
  for (const key of ["charged", "model", "input_tokens", "output_tokens", "cache_hit_tokens"]) {
    assert.equal(key in usage[1], false, `${key} must stay unset against an old backend`);
  }
  assert.equal(usage[1].operation, "generate", "and the record is otherwise complete");
  assert.equal(usage[1].credits_consumed, 3, "the balance delta still carries the cost");
});

test("a run's error code does not follow it into the next run of the same session", async () => {
  // The error code is one-shot: it labels the turn it happened in. A run that ends on a
  // terminal phase_error emits no further credits event to clear it, and a same-board
  // continuation start() skips the board-change clear. Mutation: drop the run() prologue
  // clear -> run 2's first metered turn is stamped TOOL_SCHEMA_INVALID.
  const recorded: any[] = [];
  let run = 0;
  const controller = new SessionController({
    postMessage: () => { },
    recorderFactory: () => ({ record: async (e: any) => { recorded.push(e); } }),
    loop: async ({ onEvent }: any) => {
      run++;
      if (run === 1) {
        onEvent({ type: "phase_start", phase: "generate" });
        onEvent({ type: "phase_error", error_kind: "TOOL_SCHEMA_INVALID" });
        return { terminal: "failed" };
      }
      onEvent({ type: "phase_start", phase: "generate" });
      onEvent({ type: "credits", remaining: 46, dailyGrant: 50 });
      return { terminal: "complete" };
    },
  });

  await controller.start({ intent: "x", boardId: "esp32" });
  await controller.start({ intent: "y", boardId: "esp32" }); // SAME board: no change-clear

  const usage = recorded.filter((e) => e.type === "credit_usage").map((e) => e.usage);
  assert.equal(usage.length, 1, "only run 2 metered a turn");
  assert.equal("error_code" in usage[0], false, "run 1's failure must not label run 2's turn");
});

test("a retry still labels its turn even though run() clears the error code", async () => {
  // retryTurnPending is set immediately before run(), so the prologue must NOT clear it.
  // Mutation: clear retryTurnPending alongside lastErrorCode -> the re-issued turn reads
  // "generate" and retry cost becomes invisible.
  const recorded: any[] = [];
  const controller = new SessionController({
    postMessage: () => { },
    recorderFactory: () => ({ record: async (e: any) => { recorded.push(e); } }),
    loop: async ({ onEvent }: any) => {
      onEvent({ type: "phase_start", phase: "generate" });
      onEvent({ type: "credits", remaining: 48, dailyGrant: 50 });
      return { terminal: "llm_unreachable", state: { phase: "generate" } };
    },
  });

  await controller.start({ intent: "x", boardId: "esp32" });
  recorded.length = 0;
  await controller.retry();

  const usage = recorded.filter((e) => e.type === "credit_usage").map((e) => e.usage);
  assert.equal(usage[0].operation, "retry", "the re-issued turn keeps its label");
});

test("the diagnostics rollup says so when the cap dropped the oldest turns", async () => {
  // The ring is bounded at 100; without a marker a truncated rollup reads as the whole
  // build's cost. Mutation: drop the counter -> a 130-turn session reports only its last
  // 100 turns with no sign anything is missing.
  const controller = new SessionController({
    postMessage: () => { },
    loop: async ({ onEvent }: any) => {
      onEvent({ type: "phase_start", phase: "generate" });
      // 130 metered turns, each costing exactly 1 credit.
      for (let i = 0; i < 130; i++) onEvent({ type: "credits", remaining: 1000 - i, dailyGrant: 50, charged: 1 });
      return { terminal: "complete" };
    },
  });

  await controller.start({ intent: "x", boardId: "esp32" });

  const text = controller.getDiagnostics().credit_usage;
  assert.match(text, /^\(oldest 30 turns dropped\) /, `expected a truncation marker: ${text}`);
  assert.match(text, /100 credits over 100 turns/, "and the retained turns are still rolled up");
  assert.equal(controller.getCreditUsage().length, 100, "the ring itself is bounded");
});

test("a session inside the cap carries no truncation marker", async () => {
  const controller = new SessionController({
    postMessage: () => { },
    loop: async ({ onEvent }: any) => {
      onEvent({ type: "phase_start", phase: "generate" });
      onEvent({ type: "credits", remaining: 46, dailyGrant: 50, charged: 1 });
      return { terminal: "complete" };
    },
  });

  await controller.start({ intent: "x", boardId: "esp32" });

  assert.equal(controller.getDiagnostics().credit_usage, "upy-generate-plugin/generate: 1 credit over 1 turn, remaining 46");
});
