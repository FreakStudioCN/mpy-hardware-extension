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

function sseTool(id: string, name: string, input: any) {
  return [
    `data: ${JSON.stringify({ type: "content_block_start", content_block: { type: "tool_use", id, name } })}`,
    `data: ${JSON.stringify({ type: "content_block_delta", delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } })}`,
    `data: ${JSON.stringify({ type: "content_block_stop" })}`,
    `data: ${JSON.stringify({ type: "message_stop" })}`,
    "",
  ].join("\n\n");
}

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

  assert.equal(result.terminal, "complete");
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
    if (phase === "select-hw") return tool("select-done", "phase_complete", { result: "success", summary: "selected", next_phase: "flash-mpy-firmware", manifest_content: { phase, board_id: "esp32-s3-devkitc-1" } });
    if (phase === "upy-flash-mpy-firmware-plugin") return tool("flash-done", "phase_complete", { result: "success", summary: "flash skipped", next_skill: "upy-scaffold-plugin", manifest_content: { phase, board_id: "esp32-s3-devkitc-1" } });
    if (phase === "upy-scaffold-plugin") {
      if (turn === 0) return tool("scaffold-dir", "file_operation", { op: "mkdir", path: "firmware", op_id: "mk-fw" });
      if (turn === 1) return tool("scaffold-script", "script_run", { script_id: "scaffold", interpreter: "python", script: "init_scaffold.py", args: [] });
      return tool("scaffold-done", "phase_complete", { result: "success", summary: "scaffolded", next_phase: "generate", manifest_content: { phase, board_id: "esp32-s3-devkitc-1" } });
    }
    if (phase === "upy-generate-plugin") {
      if (turn === 0) return tool("write-main", "file_operation", { op: "write", path: "firmware/main.py", content: "print('MPYHW_READY')\n" + "#".repeat(120), op_id: "main" });
      return tool("generate-done", "phase_complete", { result: "success", summary: "generated", next_phase: "deploy", manifest_content: { phase, board_id: "esp32-s3-devkitc-1" } });
    }
    if (phase === "upy-deploy-plugin") {
      if (turn === 0) return tool("serial", "device_command", { action: "stream", cmd_id: "serial" });
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
    assert.equal(scriptCalls.length, 1);
    assert.equal(scriptCalls[0].script, "init_scaffold.py");
    // The active phase must ride on script_run so the host resolver picks the running phase's
    // own copy of a basename shared by >1 served plugin. Mutation: drop `phase: extra?.phase` in
    // protocol-build.ts (or `phase: phaseCtx.phase` in protocol-loop.ts) and this fails — otherwise
    // the generate flow silently regresses to ambiguous_script_name with no failing test.
    assert.equal(scriptCalls[0].phase, "upy-scaffold-plugin");
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
    const next = body.phase === "analyze" ? "select-hw" : null;
    return new Response(sseTool("done", "phase_complete", { result: "success", summary: "ok", next_phase: next, manifest_content: {} }), { status: 200, headers: { "content-type": "text/event-stream" } }) as any;
  };
  const safePointPhases: string[] = [];
  const loop = createProtocolLoop({ apiBaseUrl: "http://api.test", fetchImpl: fetchImpl as any, getAuthToken: async () => "token" });
  await loop({ intent: "x", traceId: "t", onSafePoint: (phase: string) => { safePointPhases.push(phase); return null; } });
  assert.deepEqual(safePointPhases, ["analyze", "select-hw"], "onSafePoint must fire after each phase_complete via the production glue");
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
