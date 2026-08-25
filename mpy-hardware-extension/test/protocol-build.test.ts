import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";

import { containLocalPath, correctRedundantArgPaths, createProtocolLoop } from "../src/core/protocol-build.ts";
import { PROTOCOL_TOOLS } from "../src/core/protocol-registry.ts";

// cp_from pulls a device file to the HOST, so the model-supplied local destination must be
// contained to the project root — never allowed to write elsewhere on the host (#6 / Codex).
const ROOT = resolve("/work/proj");

test("containLocalPath keeps a normal relative dst inside the project root", () => {
  assert.equal(containLocalPath(ROOT, "logs/run.txt", "/log.txt"), resolve(ROOT, "logs/run.txt"));
});

test("containLocalPath strips a leading slash (device-absolute) into the project root", () => {
  assert.equal(containLocalPath(ROOT, "/main.py", "/main.py"), resolve(ROOT, "main.py"));
});

test("containLocalPath falls back to the device basename when dst is empty", () => {
  assert.equal(containLocalPath(ROOT, "", "/lib/driver.py"), resolve(ROOT, "driver.py"));
});

test("containLocalPath rejects a dst that escapes the project root", () => {
  assert.equal(containLocalPath(ROOT, "../../etc/passwd", "/x"), null);
});

// ":" is mpremote's marker for a path ON THE BOARD (":log/run_3.log" = /log/run_3.log there).
// A real run passed that same string as the HOST destination and created a directory literally
// named ":log" in the project. Harmless on macOS, invalid on Windows.
test("containLocalPath strips the mpremote device marker from a host destination", () => {
  assert.equal(containLocalPath(ROOT, ":log/run_3.log", ":log/run_3.log"), resolve(ROOT, "log/run_3.log"));
  assert.equal(containLocalPath(ROOT, ":/log/run_0.log", ":/log/run_0.log"), resolve(ROOT, "log/run_0.log"));
});

test("containLocalPath strips the device marker from the basename fallback too", () => {
  assert.equal(containLocalPath(ROOT, "", ":log/run_3.log"), resolve(ROOT, "run_3.log"));
});

test("containLocalPath still rejects an escape that hides behind the device marker", () => {
  assert.equal(containLocalPath(ROOT, ":../../etc/passwd", ":x"), null);
});

function sseTool(id: string, name: string, input: any) {
  return [
    `data: ${JSON.stringify({ type: "content_block_start", content_block: { type: "tool_use", id, name } })}`,
    `data: ${JSON.stringify({ type: "content_block_delta", delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } })}`,
    `data: ${JSON.stringify({ type: "content_block_stop" })}`,
    `data: ${JSON.stringify({ type: "message_stop" })}`,
    "",
  ].join("\n\n");
}

test("a script's accepted_flags survive the whole path to the model", async () => {
  // END TO END on purpose. serve.py attaches each script's option list so the model never needs
  // a `--help` turn, and the value crosses three layers to reach it: shim -> protocol-build ->
  // protocol-loop. Two of those rebuild the result from a FIXED field list, and each dropped it
  // in turn -- the fix was applied twice and stayed invisible both times, because each attempt
  // was verified at one boundary instead of along the path. A run afterwards still made 10
  // --help probes and recorded the field zero times.
  const bodies: any[] = [];
  let turn = 0;
  const fetchImpl = async (_url: any, init: any) => {
    bodies.push(JSON.parse(String(init.body)));
    turn += 1;
    const tool = turn === 1
      ? sseTool("s", "script_run", { script_id: "s", interpreter: "python", script: "deploy_result.py", args: ["--output-json", "x.json"] })
      : sseTool("done", "phase_complete", { result: "partial", summary: "ok", next_phase: null, manifest_content: {} });
    return new Response(tool, { status: 200, headers: { "content-type": "text/event-stream" } }) as any;
  };

  const loop = createProtocolLoop({
    apiBaseUrl: "http://api.test",
    fetchImpl: fetchImpl as any,
    getAuthToken: async () => "token",
    projectRoot: "/tmp",
    shim: {
      // Exactly what serve.py returns, extra field included.
      runV0Script: async () => ({ status: "ok", exit_code: 0, stdout: "{}", accepted_flags: ["--output-json", "--port"] }),
    },
  } as any);
  await loop({ intent: "x", maxTurnsPerPhase: 3 });

  const toolResult = bodies[1].messages.at(-1).content[0];
  const payload = JSON.parse(toolResult.content);
  assert.deepEqual(payload.accepted_flags, ["--output-json", "--port"], "the model must receive the script's flag list");
});

test("createProtocolLoop sends the V0 cloud envelope through the production LLM client", async () => {
  const bodies: any[] = [];
  const fetchImpl = async (_url: any, init: any) => {
    bodies.push(JSON.parse(String(init.body)));
    return new Response(sseTool("done", "phase_complete", {
      result: "success",
      summary: "ok",
      next_phase: null,
      manifest_content: { done: true },
    }), { status: 200, headers: { "content-type": "text/event-stream" } }) as any;
  };

  const loop = createProtocolLoop({ apiBaseUrl: "http://api.test", fetchImpl: fetchImpl as any, getAuthToken: async () => "token" });
  const result = await loop({ intent: "build a thermometer", traceId: "trace-create-loop" });

  assert.equal(result.terminal, "complete");
  assert.equal(bodies.length, 1);
  assert.equal(bodies[0].phase, "analyze");
  assert.deepEqual(bodies[0].manifest, {});
  assert.equal(bodies[0].trace_id, "trace-create-loop");
  assert.deepEqual(bodies[0].tools, PROTOCOL_TOOLS);
  assert.deepEqual(bodies[0].messages, [{ role: "user", content: "build a thermometer" }]);
});

test("createProtocolLoop retries connect timeouts and ends as llm_unreachable", async () => {
  let calls = 0;
  const events: any[] = [];
  const fetchImpl = (async () => {
    calls++;
    const error: any = new TypeError("fetch failed");
    error.cause = Object.assign(new Error("Connect Timeout Error"), { code: "UND_ERR_CONNECT_TIMEOUT" });
    throw error;
  }) as unknown as typeof fetch;

  const loop = createProtocolLoop({ apiBaseUrl: "http://api.test", fetchImpl, getAuthToken: async () => "token", connectRetryDelaysMs: [0, 0] } as any);
  const result = await loop({ intent: "blink an led", traceId: "connect-timeout", onEvent: (event: any) => events.push(event) });

  assert.equal(result.terminal, "llm_unreachable");
  assert.equal(calls, 3);
  assert.deepEqual(events.filter((event) => event.type === "connect_retry").map((event) => event.attempt), [1, 2]);
  assert.match(String(events.find((event) => event.type === "connect_retry")?.detail), /UND_ERR_CONNECT_TIMEOUT/);
});

function sseText(text: string) {
  return [
    `data: ${JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text } })}`,
    `data: ${JSON.stringify({ type: "message_stop" })}`,
    "",
  ].join("\n\n");
}

// The sibling of the "partial" flattening, and the last terminal this mapping still collapsed. A
// model that keeps naming a next phase runs the loop to MAX_PHASES and ends "incomplete" -- a
// pathological build. Folded into awaiting_user it reached the webview as a clean hand-back, which
// renders NO terminal line at all, while term_incomplete ("Stopped (too many phases)") shipped in
// both locales unreachable from the production path.
test("createProtocolLoop keeps 'incomplete' distinct instead of folding it into awaiting_user", async () => {
  let calls = 0;
  // Every phase reports success and names another phase, so the chain never terminates itself.
  // Both named phases are deliberately the NON-STRICT ones: a strict gate would refuse the
  // success for never running its validator and the phase would stall, which is a different
  // terminal and would not exercise the cap at all.
  const fetchImpl = async () => {
    calls += 1;
    return new Response(sseTool(`p${calls}`, "phase_complete", {
      result: "success",
      summary: "on to the next one",
      next_phase: calls % 2 === 0 ? "analyze" : "upy-flash-mpy-firmware-plugin",
      manifest_content: {},
    }), { status: 200, headers: { "content-type": "text/event-stream" } }) as any;
  };

  const loop = createProtocolLoop({ apiBaseUrl: "http://api.test", fetchImpl: fetchImpl as any, getAuthToken: async () => "token" });
  const result = await loop({ intent: "build a thermometer", traceId: "trace-incomplete" });

  assert.equal(result.terminal, "incomplete", "a phase chain that hits the cap is not a clean hand-back");
});

test("createProtocolLoop maps a stalled loop (no tool calls, repeated prose) to terminal 'stalled', distinct from awaiting_user", async () => {
  // The model never emits a tool call; after MAX_TOOLLESS_TURNS the phase gives up
  // and runProtocolBuild returns terminal: "stalled" (protocol-loop.ts). That must
  // flow through createProtocolLoop as "stalled", not get folded into the generic
  // "awaiting_user" hand-back — a stalled build is a stuck build, not a clean pause.
  const fetchImpl = async () =>
    new Response(sseText("thinking out loud, never calling a tool"), { status: 200, headers: { "content-type": "text/event-stream" } }) as any;

  const loop = createProtocolLoop({ apiBaseUrl: "http://api.test", fetchImpl: fetchImpl as any, getAuthToken: async () => "token" });
  const result = await loop({ intent: "build a thermometer", traceId: "trace-stalled" });

  assert.equal(result.terminal, "stalled");
});

test("createProtocolLoop reports firmware flashing actions as unsupported, not as project run success", async () => {
  const bodies: any[] = [];
  let calls = 0;
  const fetchImpl = async (_url: any, init: any) => {
    bodies.push(JSON.parse(String(init.body)));
    calls++;
    if (calls === 1) {
      return new Response(sseTool("flash", "device_command", { action: "flash_firmware", cmd_id: "fw1" }), { status: 200, headers: { "content-type": "text/event-stream" } }) as any;
    }
    return new Response(sseTool("done", "phase_complete", { result: "partial", summary: "firmware unsupported", next_phase: null, manifest_content: {} }), { status: 200, headers: { "content-type": "text/event-stream" } }) as any;
  };

  const loop = createProtocolLoop({ apiBaseUrl: "http://api.test", fetchImpl: fetchImpl as any, getAuthToken: async () => "token", shim: {} } as any);
  const result = await loop({ intent: "flash MicroPython", maxTurnsPerPhase: 2 });

  // partial, NOT complete: the phase reported it could not do the work. This asserted "complete"
  // while the model was saying "firmware unsupported" -- the same conflation that let a select-hw
  // phase which could not resolve its board report a completed build.
  //
  // And "partial", not "awaiting_user", which is what it asserted next. terminalForResult stops
  // an unfinished phase from reporting the build complete, and the mapping then collapsed that
  // into the generic hand-back, which the webview renders as "Waiting for your reply" and
  // classifies as clean. A build whose last phase gave up promised the user nothing was wrong and
  // that it was waiting on them. The distinction has to survive to the consumer to be worth
  // making.
  assert.equal(result.terminal, "partial");
  const toolResult = bodies[1].messages.at(-1).content[0];
  assert.equal(toolResult.type, "tool_result");
  const payload = JSON.parse(toolResult.content);
  assert.equal(payload.ok, false);
  assert.equal(payload.error_kind, "firmware_action_requires_script_run");
});

test("createProtocolLoop runs a local full-chain V0 e2e through production host backings", async () => {
  const projectDir = await mkdtemp(join(tmpdir(), "mpyhw-local-e2e-"));
  const requests: any[] = [];
  const events: any[] = [];
  const scriptCalls: any[] = [];
  const phaseTurns: Record<string, number> = {};

  const tool = (id: string, name: string, input: any) =>
    new Response(sseTool(id, name, input), { status: 200, headers: { "content-type": "text/event-stream" } }) as any;
  const fetchImpl = async (_url: any, init: any) => {
    const body = JSON.parse(String(init.body));
    requests.push(body);
    const phase = body.phase;
    const turn = phaseTurns[phase] ?? 0;
    phaseTurns[phase] = turn + 1;

    if (phase === "analyze") return tool("analyze-done", "phase_complete", { result: "success", summary: "analyzed", next_skill: "/select-hw", manifest_content: { phase } });
    if (phase === "select-hw") {
      // The gated phases run their validator first: a success no gate confirmed is refused.
      if (turn === 0) return tool("select-gate", "script_run", { script_id: "sg", interpreter: "python", script: "select_hw_manifest.py", args: ["--validate-phase-complete", "--compare-manifest", "v.json", "--expected-artifact", "d.json"] });
      return tool("select-done", "phase_complete", { result: "success", summary: "selected", next_phase: "flash-mpy-firmware", manifest_content: { phase, board_id: "esp32-s3-devkitc-1" } });
    }
    if (phase === "upy-flash-mpy-firmware-plugin") return tool("flash-done", "phase_complete", { result: "success", summary: "flash skipped", next_skill: "upy-scaffold-plugin", manifest_content: { phase, board_id: "esp32-s3-devkitc-1" } });
    if (phase === "upy-scaffold-plugin") {
      if (turn === 0) return tool("scaffold-dir", "file_operation", { op: "mkdir", path: "firmware", op_id: "mk-fw" });
      if (turn === 1) return tool("scaffold-script", "script_run", { script_id: "scaffold", interpreter: "python", script: "init_scaffold.py", args: [] });
      return tool("scaffold-done", "phase_complete", { result: "success", summary: "scaffolded", next_phase: "generate", manifest_content: { phase, board_id: "esp32-s3-devkitc-1" } });
    }
    if (phase === "upy-generate-plugin") {
      if (turn === 0) return tool("write-main", "file_operation", { op: "write", path: "firmware/main.py", content: "print('MPYHW_READY')\n" + "#".repeat(120), op_id: "main" });
      if (turn === 1) return tool("gen-gate", "script_run", { script_id: "gg", interpreter: "python", script: "check_phase_complete_consistency.py", args: ["--phase-complete", "pc.json"] });
      return tool("generate-done", "phase_complete", { result: "success", summary: "generated", next_phase: "deploy", manifest_content: { phase, board_id: "esp32-s3-devkitc-1" } });
    }
    if (phase === "upy-deploy-plugin") {
      if (turn === 0) return tool("serial", "device_command", { action: "stream", cmd_id: "serial" });
      if (turn === 1) return tool("deploy-gate", "script_run", { script_id: "dg", interpreter: "python", script: "deploy_result.py", args: ["--output-json", "deploy_result.json"] });
      return tool("deploy-done", "phase_complete", { result: "success", summary: "deployed", next_phase: null, manifest_content: { phase, board_id: "esp32-s3-devkitc-1" } });
    }
    return tool("unknown", "phase_complete", { result: "failed", summary: phase, next_phase: null });
  };

  const contained = (path: string) => {
    const target = resolve(projectDir, String(path ?? ""));
    return target === projectDir || target.startsWith(projectDir + sep) ? target : null;
  };
  const walk = async (base: string, out: string[] = []) => {
    for (const entry of await readdir(base, { withFileTypes: true })) {
      const full = join(base, entry.name);
      const rel = relative(projectDir, full).replace(/\\/g, "/");
      if (entry.isDirectory()) {
        out.push(rel + "/");
        await walk(full, out);
      } else {
        out.push(rel);
      }
    }
    return out;
  };

  const loop = createProtocolLoop({
    apiBaseUrl: "http://api.test",
    fetchImpl: fetchImpl as any,
    getAuthToken: async () => "token",
    projectRoot: projectDir,
    shim: {
      runV0Script: async (call: any) => {
        scriptCalls.push(call);
        // init_scaffold.py renders the project, and add_upy_resources copies the .upy schemas
        // on every render as required resources. The stub has to produce one: the loop rejects
        // a scaffold phase_complete whose project carries no scaffold-authored file, because
        // that is how a phase that never rendered anything looks. .flake8 is deliberately NOT
        // the marker -- a model that skips apply_scaffold writes its own.
        if (call.script === "init_scaffold.py") {
          await mkdir(join(projectDir, ".upy", "schemas"), { recursive: true });
          await writeFile(join(projectDir, ".upy", "schemas", "project-manifest.schema.json"), "{}\n", "utf-8");
        }
        // A gated phase now needs its validator to REPORT a pass before phase_complete is
        // accepted, so the stub has to answer like the real gate rather than with a bare "{}"
        // (which carries no verdict at all). Same shape the real scripts print.
        if (/select_hw_manifest\.py|check_phase_complete_consistency\.py|deploy_result\.py/.test(String(call.script))) {
          return { status: "ok", stdout: '{"status":"ok","errors":[]}', stderr: "", exit_code: 0 };
        }
        return { status: "ok", stdout: "{}", stderr: "", exit_code: 0 };
      },
      // all_lines carries lines beyond the matched markers (a print() the deploy
      // verification read saw between them) — the posted serial_output event must
      // carry those too, not just the matched markers.
      serialReadUntil: async () => ({ ok: true, lines: ["MPYHW_READY", "temp=24.1"], allLines: ["booting", "MPYHW_READY", "temp=24.1"] }),
    },
    writeProjectFile: async (path, content) => {
      const target = contained(path);
      if (!target || target === projectDir) return { ok: false, error_kind: "path_outside_workspace" };
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content, "utf-8");
      return { ok: true, path };
    },
    readWorkspaceFile: async (path) => {
      const target = contained(path);
      if (!target) return { ok: false, error_kind: "path_outside_workspace" };
      try { return { ok: true, content: await readFile(target, "utf-8") }; }
      catch { return { ok: false, error_kind: "not_found" }; }
    },
    listFiles: async (path) => {
      const target = contained(path);
      if (!target) return { ok: false, error_kind: "path_outside_workspace" };
      try { return { ok: true, entries: await walk(target) }; }
      catch { return { ok: false, error_kind: "not_found" }; }
    },
    makeProjectDir: async (path) => {
      const target = contained(path);
      if (!target || target === projectDir) return { ok: false, error_kind: "path_outside_workspace" };
      await mkdir(target, { recursive: true });
      return { ok: true };
    },
    deleteProjectPath: async (path) => {
      const target = contained(path);
      if (!target || target === projectDir) return { ok: false, error_kind: "path_outside_workspace" };
      await rm(target, { recursive: true, force: true });
      return { ok: true };
    },
  });

  try {
    const result = await loop({
      intent: "build an ESP32-S3 temperature alarm",
      traceId: "local-e2e",
      maxTurnsPerPhase: 5,
      onEvent: (event: any) => events.push(event),
    });

    assert.equal(result.terminal, "complete");
    assert.deepEqual(
      requests.map((body) => body.phase).filter((phase, index, arr) => arr.indexOf(phase) === index),
      ["analyze", "select-hw", "upy-flash-mpy-firmware-plugin", "upy-scaffold-plugin", "upy-generate-plugin", "upy-deploy-plugin"],
    );
    assert.equal((await stat(join(projectDir, "firmware", "main.py"))).size > 100, true);
    assert.match(await readFile(join(projectDir, "firmware", "main.py"), "utf-8"), /MPYHW_READY/);
    // The scaffold render, plus one validator per gated phase: select-hw, generate and deploy
    // each have to report a pass before their phase_complete is accepted.
    assert.deepEqual(
      scriptCalls.map((c: any) => c.script),
      ["select_hw_manifest.py", "init_scaffold.py", "check_phase_complete_consistency.py", "deploy_result.py"],
    );
    // The active phase must ride on script_run so the host resolver picks the running phase's
    // own copy of a basename shared by >1 served plugin. Mutation: drop `phase: extra?.phase` in
    // protocol-build.ts (or `phase: phaseCtx.phase` in protocol-loop.ts) and this fails — otherwise
    // the generate flow silently regresses to ambiguous_script_name with no failing test.
    // Found by name, not by index: gated phases now run validators before this one, so a
    // positional assertion here would silently start checking a different call.
    assert.equal(scriptCalls.find((c: any) => c.script === "init_scaffold.py")?.phase, "upy-scaffold-plugin");
    assert.equal(scriptCalls.find((c: any) => c.script === "deploy_result.py")?.phase, "upy-deploy-plugin");
    assert.ok(events.some((event) => event.type === "serial_output" && event.lines.includes("MPYHW_READY")));
    // The non-marker "booting" line (all_lines only, not in the matched `lines`) must
    // reach the Serial page too — the whole point of forwarding the full read window.
    // Mutation: join `lines` instead of `allLines` in protocol-build.ts -> this fails.
    assert.ok(events.some((event) => event.type === "serial_output" && event.lines.includes("booting")));
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("createProtocolLoop forwards onSafePoint so supplements are consumed at phase boundaries", async () => {
  // Regression: protocol-build built the runProtocolBuild input WITHOUT onSafePoint, so
  // queued user supplements were never consumed in production even though the unit tests
  // (which call runProtocolBuild directly / use a mock loop) all passed. This drives the
  // real production glue and asserts the hook fires at each phase boundary.
  const fetchImpl = async (_url: any, init: any) => {
    const body = JSON.parse(String(init.body));
    // analyze -> flash: both are TRACKED but non-strict gates, so this exercises the safe-point
    // hook across a real phase boundary without also having to satisfy a validator, which is a
    // different test's job.
    const next = body.phase === "analyze" ? "upy-flash-mpy-firmware-plugin" : null;
    return new Response(sseTool("done", "phase_complete", { result: "success", summary: "ok", next_phase: next, manifest_content: {} }), { status: 200, headers: { "content-type": "text/event-stream" } }) as any;
  };
  const safePointPhases: string[] = [];
  const loop = createProtocolLoop({ apiBaseUrl: "http://api.test", fetchImpl: fetchImpl as any, getAuthToken: async () => "token" });
  await loop({ intent: "x", traceId: "t", onSafePoint: (phase: string) => { safePointPhases.push(phase); return null; } });
  assert.deepEqual(safePointPhases, ["analyze", "upy-flash-mpy-firmware-plugin"], "onSafePoint must fire after each phase_complete via the production glue");
});

// Run a single model-issued device_command through the loop and return the tool_result the
// model receives (turn 1 = the device op, turn 2 = phase_complete -> terminal).
async function runDeviceCommand(input: any, extraDeps: any): Promise<any> {
  const bodies: any[] = [];
  let calls = 0;
  const fetchImpl = async (_url: any, init: any) => {
    bodies.push(JSON.parse(String(init.body)));
    calls++;
    if (calls === 1) return new Response(sseTool("dc", "device_command", input), { status: 200, headers: { "content-type": "text/event-stream" } }) as any;
    return new Response(sseTool("done", "phase_complete", { result: "partial", summary: "done", next_phase: null, manifest_content: {} }), { status: 200, headers: { "content-type": "text/event-stream" } }) as any;
  };
  const loop = createProtocolLoop({ apiBaseUrl: "http://api.test", fetchImpl: fetchImpl as any, getAuthToken: async () => "token", ...extraDeps } as any);
  await loop({ intent: "do a device op", maxTurnsPerPhase: 2 });
  return JSON.parse(bodies[1].messages.at(-1).content[0].content);
}

test("device rm is declined at the host: removePath never runs, model gets delete_declined", async () => {
  const removed: string[] = [];
  const shim = { removePath: async (p: string) => { removed.push(p); } };
  const payload = await runDeviceCommand({ action: "rm", dst: "main.py" }, { shim, confirmDeviceDelete: async () => false });
  assert.equal(removed.length, 0, "the destructive shim call never runs on decline");
  assert.equal(payload.ok, false);
  assert.equal(payload.error_kind, "delete_declined");
});

test("device rm proceeds after confirm, and the gate runs strictly before removePath", async () => {
  const removed: string[] = [];
  const shim = { removePath: async (p: string) => { removed.push(p); } };
  // asserting count 0 inside the confirm proves the gate is before the destructive call
  // (the Stop guarantee: a Stop during the confirm can still prevent the delete).
  const confirmDeviceDelete = async () => { assert.equal(removed.length, 0, "confirm asked before the delete"); return true; };
  const payload = await runDeviceCommand({ action: "rm", dst: "main.py" }, { shim, confirmDeviceDelete });
  assert.deepEqual(removed, ["main.py"], "removePath runs once with the target after confirm");
  assert.equal(payload.ok, true);
});

test("device cp_from confirms an overwrite; a decline skips copyFromDevice", async () => {
  const copied: any[] = [];
  const shim = { copyFromDevice: async (src: string, dst: string) => { copied.push([src, dst]); } };
  const payload = await runDeviceCommand({ action: "cp_from", src: "/main.py", dst: "main.py" }, { shim, projectRoot: ROOT, confirmDeviceCopyOverwrite: async () => false });
  assert.equal(copied.length, 0, "no host write on a declined overwrite");
  assert.equal(payload.ok, false);
  assert.equal(payload.error_kind, "overwrite_declined");
});

test("device cp_from proceeds after an overwrite confirm and writes to the contained host path", async () => {
  const copied: any[] = [];
  const shim = { copyFromDevice: async (src: string, dst: string) => { copied.push([src, dst]); } };
  const payload = await runDeviceCommand({ action: "cp_from", src: "/main.py", dst: "main.py" }, { shim, projectRoot: ROOT, confirmDeviceCopyOverwrite: async () => true });
  assert.deepEqual(copied, [["/main.py", resolve(ROOT, "main.py")]]);
  assert.equal(payload.ok, true);
});


// The Skill documents the project root as sessions/<id>/project, so the model prefixes project/
// onto everything. Writes and reads already drop that segment; arguments did not, so a gate ran
// one level too deep and answered GENERATE_PLAN_MISSING while the plan sat at the real root.
test("script arguments drop a redundant project/ segment", async () => {
  const root = await mkdtemp(join(tmpdir(), "mpyhw-args-"));
  try {
    assert.deepEqual(
      correctRedundantArgPaths(root, ["--plan", "project/generate_plan.json"]),
      ["--plan", "generate_plan.json"],
    );
    // How it actually arrived in the measured run.
    assert.deepEqual(correctRedundantArgPaths(root, ["--project-dir", "project"]), ["--project-dir", "."]);
    // The equals form carries both halves in one entry; only the value is corrected.
    assert.deepEqual(correctRedundantArgPaths(root, ["--project-dir=project"]), ["--project-dir=."]);
    assert.deepEqual(
      correctRedundantArgPaths(root, ["--plan=project/generate_plan.json"]),
      ["--plan=generate_plan.json"],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// The literal is NOT respected even when it exists. The writer never puts a generated file under
// project/, so such a directory is a product of the same confusion: in the measured run the model
// passed --project-dir project and the scaffold built the whole tree one level down. Honouring it
// would keep the project split across two trees.
test("an existing project/ directory does not stop the correction", async () => {
  const root = await mkdtemp(join(tmpdir(), "mpyhw-args2-"));
  try {
    await mkdir(join(root, "project", "firmware"), { recursive: true });
    assert.deepEqual(correctRedundantArgPaths(root, ["project/firmware"]), ["firmware"]);
    assert.deepEqual(correctRedundantArgPaths(root, ["--project-dir", "project"]), ["--project-dir", "."]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an argument that is not a redundant path is left exactly as sent", async () => {
  const root = await mkdtemp(join(tmpdir(), "mpyhw-args3-"));
  try {
    assert.deepEqual(
      correctRedundantArgPaths(root, ["--require-plan", "--check-files", "firmware/main.py", "-v", "", "docs/x.json"]),
      ["--require-plan", "--check-files", "firmware/main.py", "-v", "", "docs/x.json"],
    );
    // A bare "project" that is not a path flag's value stays put.
    assert.deepEqual(correctRedundantArgPaths(root, ["--name", "project"]), ["--name", "project"]);
    // And an escape attempt is refused rather than corrected.
    assert.deepEqual(correctRedundantArgPaths(root, ["project/../../etc/passwd"]), ["project/../../etc/passwd"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// The tests above call the corrector directly, so they stay green if the WIRING is deleted. This
// one drives the real loop with the arguments from the measured run and asserts what the shim
// receives, which is the sink that matters.
test("the loop hands the shim corrected script arguments", async () => {
  const projectDir = await mkdtemp(join(tmpdir(), "mpyhw-argwire-"));
  const scriptCalls: any[] = [];
  const phaseTurns: Record<string, number> = {};
  try {
    const tool = (id: string, name: string, input: any) =>
      new Response(sseTool(id, name, input), { status: 200, headers: { "content-type": "text/event-stream" } }) as any;
    const fetchImpl = async (_url: any, init: any) => {
      const body = JSON.parse(String(init.body));
      const turn = phaseTurns[body.phase] ?? 0;
      phaseTurns[body.phase] = turn + 1;
      if (turn === 0) {
        return tool("gate", "script_run", {
          script_id: "g", interpreter: "python", script: "run_quality_gates.py",
          args: ["--project-dir", "project", "--plan", "project/generate_plan.json"],
        });
      }
      return tool("done", "phase_complete", { result: "success", summary: "done", next_phase: null, manifest_content: {} });
    };

    const loop = createProtocolLoop({
      apiBaseUrl: "http://api.test",
      fetchImpl: fetchImpl as any,
      getAuthToken: async () => "token",
      projectRoot: projectDir,
      shim: {
        runV0Script: async (call: any) => { scriptCalls.push(call); return { status: "ok", stdout: "{}", stderr: "", exit_code: 0 }; },
      },
    });

    await loop({ intent: "x", traceId: "argwire", startPhase: "upy-generate-plugin", maxTurnsPerPhase: 4, onEvent: () => {} });

    assert.equal(scriptCalls.length, 1);
    assert.deepEqual(
      scriptCalls[0].args,
      ["--project-dir", ".", "--plan", "generate_plan.json"],
      "the gate must be handed paths that resolve to the tree the writer actually wrote",
    );
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});
