import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";

import { containLocalPath, createProtocolLoop } from "../src/core/protocol-build.ts";
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
      serialReadUntil: async () => ({ ok: true, lines: ["MPYHW_READY", "temp=24.1"] }),
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
    assert.ok(events.some((event) => event.type === "serial_output" && event.lines.includes("MPYHW_READY")));
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});
