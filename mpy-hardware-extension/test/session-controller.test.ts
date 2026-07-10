import assert from "node:assert/strict";
import test from "node:test";

import { SessionController } from "../src/extension/session-controller.ts";

// Let a loop that awaits one gate advance to the next: after resolving the first
// prompt, the loop's continuation (and the next gate's message/record) runs on a
// microtask, so drain a few before inspecting.
const flushMicrotasks = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

test("records protocol status_update and phase_start (not postMessage-only) so the cloud DB sees phase progress", async () => {
  const recorded: any[] = [];
  const controller = new SessionController({
    postMessage: () => {},
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
    postMessage: () => {},
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
    postMessage: () => {},
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
    postMessage: () => {},
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
    postMessage: () => {},
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
    postMessage: () => {},
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
  assert.deepEqual(deploy.manifest, { board_id: "esp32-s3-devkitc-1" });
  controller.resolvePrompt(deploy.promptId, "cancel");
  const result = await started;

  assert.equal(result.terminal, "user_cancelled");
  assert.deepEqual(messages.map((m) => m.type), [
    "trace_event",
    "manifest_updated",
    "code_updated",
    "serial_output",
    "deploy_needed",
    "session_done",
  ]);
});

test("session controller rejects a concurrent start while a run is in flight", async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let loopStarts = 0;
  const controller = new SessionController({
    postMessage: () => {},
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
  let release: () => void = () => {};
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

  assert.deepEqual(written, [{ "main.py": "print('MPYHW_READY')", "manifest.json": JSON.stringify({ board_id: "esp32-s3-devkitc-1" }, null, 2) }]);
  assert.deepEqual(messages.find((message) => message.type === "files_written"), { type: "files_written", paths: ["C:/project/main.py", "C:/project/manifest.json"] });
});

test("session controller accumulates multi-file projects by path and writes them all", async () => {
  const written: any[] = [];
  const controller = new SessionController({
    postMessage: () => {},
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
    "manifest.json": JSON.stringify({ board_id: "esp32-s3-devkitc-1" }, null, 2),
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
    postMessage: () => {},
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
    postMessage: () => {},
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
    postMessage: () => {},
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
    postMessage: () => {},
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
    postMessage: () => {},
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
    postMessage: () => {},
    recorderFactory: (traceId: string) => { traceIds.push(traceId); return { record: async () => {} }; },
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
    postMessage: () => {},
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
    postMessage: () => {},
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
    postMessage: () => {},
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
    postMessage: () => {},
    loop: async ({ onEvent }: any) => {
      onEvent({ type: "phase_start", phase: "upy-analyze-plugin" });
      onEvent({ type: "phase_complete", payload: { phase: "upy-analyze-plugin", artifacts: [
        { type: "project_manifest", path: "project-manifest.json" },
        { type: "session_state", path: ".mpyhw/sessions/s/session_state.json" },
        { type: "table", headers: ["a"] }, // no path -> skipped
      ] } });
      onEvent({ type: "phase_start", phase: "upy-select-hw-plugin" });
      onEvent({ type: "phase_complete", payload: { phase: "upy-select-hw-plugin", artifacts: [
        { type: "project_manifest", path: "project-manifest.json" }, // dup path -> first phase wins
        { type: "generate_plan", path: "select_hw_validated.json" },
      ] } });
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
    postMessage: () => {},
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
  const controller = new SessionController({ postMessage: () => {}, loop: async () => ({ terminal: "complete" }) });
  assert.doesNotThrow(() => controller.cancel(), "cancel with nothing in flight and no killDevice is a no-op");
});

test("reset() also hard-interrupts an in-flight device op (killDevice) so a new build leaves nothing running", async () => {
  let killed = 0;
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const controller = new SessionController({
    postMessage: () => {},
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
