import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createPanel, createViewProvider } from "../src/webview/panel.ts";

test("webview start_session runs API-backed pipeline and renders generated outputs", async () => {
  const ws = mkdtempSync(join(tmpdir(), "mpyhw-ws-"));
  try {
    const posted: any[] = [];
    const requested: string[] = [];
    let handler: ((message: any) => Promise<void>) | undefined;
    const panel = {
      webview: {
        cspSource: "vscode-resource:",
        html: "",
        postMessage: (message: any) => posted.push(message),
        onDidReceiveMessage: (next: any) => {
          handler = next;
        },
      },
    };
    const vscode = {
      ViewColumn: { One: 1 },
      workspace: { workspaceFolders: [{ uri: { fsPath: ws } }] },
      window: {
        createWebviewPanel: () => panel,
        showWarningMessage: async (message: string) => message.startsWith("Overwrite ") ? "Overwrite" : "Cancel",
      },
    };
    const fetchImpl = async (url: string, init?: RequestInit) => {
      requested.push(url);
      if (url === "http://api.test/v1/skills") {
        // Toolchain handshake: server == bundled, so no skew warning.
        return jsonResponse({ toolchain_version: "1", skills: [] });
      }
      if (url === "http://api.test/v1/packages/resolve") {
        const body = JSON.parse(String(init?.body));
        assert.deepEqual(body.capabilities, ["temperature_sensing", "digital_output"]);
        return jsonResponse({ selected: { name: "aht20_driver", version: "1.0.0" }, candidates: [], needs_user_choice: false, questions: [] });
      }
      if (url === "http://api.test/v1/packages/aht20_driver/1.0.0/driver-context") {
        return jsonResponse(aht20Context());
      }
      if (url === "http://api.test/v1/boards/esp32-s3-devkitc-1") {
        return jsonResponse(board());
      }
      throw new Error(`unexpected URL ${url}`);
    };

    createPanel(vscode, {}, { apiBaseUrl: "http://api.test", fetchImpl, loopMode: "template" });
    await handler?.({ type: "start_session", intent: "超过30度亮红灯", boardId: "esp32-s3-devkitc-1" });

    assert.match(panel.webview.html, /id="intent"/);
    assert.deepEqual(requested, [
      "http://api.test/v1/tools",
      "http://api.test/v1/skills",
      "http://api.test/v1/packages/resolve",
      "http://api.test/v1/packages/aht20_driver/1.0.0/driver-context",
      "http://api.test/v1/boards/esp32-s3-devkitc-1",
    ]);
    assert.deepEqual(posted.map((message) => message.type), ["trace_event", "manifest_updated", "code_updated", "trace_event", "files_written", "session_done"]);
    assert.equal(posted.at(-1).terminal, "generated");
    assert.match(posted.find((message) => message.type === "code_updated").code, /MPYHW_READY/);
    // Files land under the open workspace (not a fallback), so no "saved here" notice.
    assert.ok(existsSync(join(ws, "blockless-project", "main.py")));
    assert.ok(existsSync(join(ws, "blockless-project", ".git")), "project folder is initialized as a git repo for generate commits");
    assert.ok(!posted.some((m) => m.type === "session_event" && m.event?.kind === "saved_location"));
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("with no workspace open, generation saves to the globalStorage fallback and tells the user where, with a reveal action", async () => {
  const gs = mkdtempSync(join(tmpdir(), "mpyhw-gs-"));
  try {
    const posted: any[] = [];
    const revealed: any[] = [];
    let handler: ((message: any) => Promise<void>) | undefined;
    const panel = {
      webview: {
        cspSource: "vscode-resource:",
        html: "",
        postMessage: (message: any) => posted.push(message),
        onDidReceiveMessage: (next: any) => { handler = next; },
      },
    };
    const vscode = {
      ViewColumn: { One: 1 },
      Uri: { file: (p: string) => ({ fsPath: p }) },
      commands: { executeCommand: (cmd: string, arg: any) => { revealed.push({ cmd, arg }); } },
      window: { createWebviewPanel: () => panel, showWarningMessage: async () => "Cancel" },
      // no workspace.workspaceFolders → the globalStorage fallback is used
    };

    createPanel(vscode, {}, { apiBaseUrl: "http://api.test", fetchImpl: pipelineFetch, loopMode: "template", globalStoragePath: gs });
    await handler?.({ type: "start_session", intent: "超过30度亮红灯", boardId: "esp32-s3-devkitc-1" });

    const projectDir = join(gs, "blockless-project");
    const saved = posted.find((m) => m.type === "session_event" && m.event?.kind === "saved_location");
    assert.ok(saved, "a saved_location notice is posted so the user can find their project");
    assert.equal(saved.event.path, projectDir);
    assert.ok(existsSync(join(projectDir, "main.py")), "files actually landed in the fallback dir");
    assert.ok(posted.some((m) => m.type === "files_written"), "files_written still posts (no regression)");
    assert.equal(posted.at(-1).terminal, "generated");

    // The reveal button's action opens that folder in the OS file manager.
    await handler?.({ type: "open_path", path: projectDir });
    assert.deepEqual(revealed, [{ cmd: "revealFileInOS", arg: { fsPath: projectDir } }]);
  } finally {
    rmSync(gs, { recursive: true, force: true });
  }
});

test("with neither a workspace nor globalStorage, generation reports workspace_unavailable instead of writing to process.cwd()", async () => {
  const posted: any[] = [];
  let handler: ((message: any) => Promise<void>) | undefined;
  const panel = {
    webview: {
      cspSource: "vscode-resource:",
      html: "",
      postMessage: (message: any) => posted.push(message),
      onDidReceiveMessage: (next: any) => { handler = next; },
    },
  };
  const vscode = {
    ViewColumn: { One: 1 },
    window: { createWebviewPanel: () => panel, showWarningMessage: async () => "Cancel" },
  };

  createPanel(vscode, {}, { apiBaseUrl: "http://api.test", fetchImpl: pipelineFetch, loopMode: "template" });
  await handler?.({ type: "start_session", intent: "超过30度亮红灯", boardId: "esp32-s3-devkitc-1" });

  assert.ok(posted.some((m) => m.type === "files_write_failed" && m.error === "workspace_unavailable"), "no writable root → a clean workspace_unavailable, never a cwd write");
  assert.ok(!posted.some((m) => m.type === "files_written"));
});

test("webview defaults to the LLM agent loop and forwards its terminal", async () => {
  const posted: any[] = [];
  let handler: ((message: any) => Promise<void>) | undefined;
  const panel = {
    webview: {
      cspSource: "vscode-resource:",
      html: "",
      postMessage: (message: any) => posted.push(message),
      onDidReceiveMessage: (next: any) => { handler = next; },
    },
  };
  const vscode = {
    ViewColumn: { One: 1 },
    window: { createWebviewPanel: () => panel, showWarningMessage: async () => "Cancel" },
  };
  // The LLM replies with plain text and no tool call, and keeps doing so even after
  // the loop's corrective nudge — a genuine stall (protocol-loop.ts gives up after
  // MAX_TOOLLESS_TURNS consecutive toolless replies), not a clean hand-back. The
  // panel must forward the distinct "stalled" terminal to the webview rather than
  // folding it into awaiting_user or spinning to max_turns.
  const fetchImpl = (async (url: string) => {
    assert.match(url, /\/v1\/llm\/messages$/);
    const sse = [
      JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "What should the device do?" } }),
      JSON.stringify({ type: "message_stop" }),
    ].map((data) => `data: ${data}`).join("\n\n");
    return { ok: true, status: 200, text: async () => sse } as unknown as Response;
  }) as unknown as typeof fetch;

  createPanel(vscode, {}, { apiBaseUrl: "http://api.test", fetchImpl });
  await handler?.({ type: "start_session", intent: "build an ai companion", boardId: "esp32-s3-devkitc-1" });

  assert.equal(posted.at(-1).type, "session_done");
  assert.equal(posted.at(-1).terminal, "stalled");
});

test("webview blocks sessions when the remote protocol version mismatches the bundled contract", async () => {
  const posted: any[] = [];
  let handler: ((message: any) => Promise<void>) | undefined;
  const panel = {
    webview: {
      cspSource: "vscode-resource:",
      html: "",
      postMessage: (message: any) => posted.push(message),
      onDidReceiveMessage: (next: any) => { handler = next; },
    },
  };
  const vscode = {
    ViewColumn: { One: 1 },
    window: { createWebviewPanel: () => panel, showWarningMessage: async () => "Cancel" },
  };
  const fetchImpl = (async (url: string) => {
    if (url === "http://api.test/v1/tools") {
      // The backend declares a protocol version the bundled extension can't speak.
      return jsonResponse({ protocol_version: "9.9.9", tools: [] });
    }
    throw new Error(`unexpected URL ${url}`);
  }) as unknown as typeof fetch;

  createPanel(vscode, {}, { apiBaseUrl: "http://api.test", fetchImpl });
  await handler?.({ type: "start_session", intent: "blink an led", boardId: "esp32-s3-devkitc-1" });

  assert.deepEqual(posted, [
    { type: "session_error", error: "protocol_version_mismatch" },
    { type: "session_done", terminal: "session_error" },
  ]);
});

test("webview lets the user choose a device port when multiple devices are connected", async () => {
  const posted: any[] = [];
  let handler: ((message: any) => Promise<void>) | undefined;
  const selectedPorts: Array<string | null> = [];
  const panel = {
    webview: {
      cspSource: "vscode-resource:",
      html: "",
      postMessage: (message: any) => posted.push(message),
      onDidReceiveMessage: (next: any) => { handler = next; },
    },
  };
  const shim = {
    scan: async () => ["COM7", "COM8"],
    setPort: (port: string | null) => selectedPorts.push(port),
  };
  const vscode = {
    ViewColumn: { One: 1 },
    window: {
      createWebviewPanel: () => panel,
      showQuickPick: async (items: string[]) => items[1],
      showWarningMessage: async () => "Cancel",
    },
  };

  createPanel(vscode, {}, { apiBaseUrl: "http://api.test", fetchImpl: async () => { throw new Error("no network expected"); }, shim });
  await handler?.({ type: "select_device" });

  assert.deepEqual(selectedPorts, ["COM8"]);
  assert.deepEqual(posted.find((message) => message.type === "device_selected"), { type: "device_selected", port: "COM8" });
});

test("deploy confirm sets the chosen port on the prompt response, before the agent is unblocked", async () => {
  let handler: ((message: any) => Promise<void>) | undefined;
  const selectedPorts: Array<string | null> = [];
  const panel = {
    webview: {
      cspSource: "vscode-resource:",
      html: "",
      postMessage: () => {},
      onDidReceiveMessage: (next: any) => { handler = next; },
    },
  };
  const shim = {
    scan: async () => ["COM7", "COM8"],
    setPort: (port: string | null) => selectedPorts.push(port),
  };
  const vscode = {
    ViewColumn: { One: 1 },
    window: { createWebviewPanel: () => panel, showWarningMessage: async () => "Cancel" },
  };

  createPanel(vscode, {}, { apiBaseUrl: "http://api.test", fetchImpl: async () => { throw new Error("no network expected"); }, shim });
  // A cancel carries no port; a confirm carries the chosen one and must set it
  // synchronously in the same handler that resolves the deploy prompt.
  await handler?.({ type: "ui_prompt_response", promptId: "deploy-1", answer: "cancel", port: null });
  await handler?.({ type: "ui_prompt_response", promptId: "deploy-2", answer: "confirm", port: "COM8" });

  assert.deepEqual(selectedPorts, ["COM8"]);
});

test("view provider wires the same session controller into a docked webview view", async () => {
  const posted: any[] = [];
  let handler: ((message: any) => Promise<void>) | undefined;
  const view = {
    webview: {
      cspSource: "vscode-resource:",
      html: "",
      options: undefined as any,
      postMessage: (message: any) => posted.push(message),
      onDidReceiveMessage: (next: any) => { handler = next; },
    },
  };
  const vscode = { window: { showWarningMessage: async () => "Cancel" } };
  const fetchImpl = async (url: string, init?: RequestInit) => {
    if (url === "http://api.test/v1/packages/resolve") {
      return jsonResponse({ selected: { name: "aht20_driver", version: "1.0.0" }, candidates: [], needs_user_choice: false, questions: [] });
    }
    if (url === "http://api.test/v1/packages/aht20_driver/1.0.0/driver-context") return jsonResponse(aht20Context());
    if (url === "http://api.test/v1/boards/esp32-s3-devkitc-1") return jsonResponse(board());
    throw new Error(`unexpected URL ${url}`);
  };

  const provider = createViewProvider(vscode, {}, { apiBaseUrl: "http://api.test", fetchImpl, loopMode: "template" });
  provider.resolveWebviewView(view);
  await handler?.({ type: "start_session", intent: "超过30度亮红灯", boardId: "esp32-s3-devkitc-1" });

  assert.deepEqual(view.webview.options, { enableScripts: true });
  assert.match(view.webview.html, /id="intent"/);
  assert.equal(posted.at(-1).type, "session_done");
  assert.equal(posted.at(-1).terminal, "generated");
});

test("webview reports backend GitHub auth exchange failures", async () => {
  const posted: any[] = [];
  let handler: ((message: any) => Promise<void>) | undefined;
  const view = {
    webview: {
      cspSource: "vscode-resource:",
      html: "",
      options: undefined as any,
      postMessage: (message: any) => posted.push(message),
      onDidReceiveMessage: (next: any) => { handler = next; },
    },
  };
  const vscode = {
    authentication: {
      getSession: async () => ({ accessToken: "gho-token" }),
    },
    window: { showWarningMessage: async () => "Cancel" },
  };
  const fetchImpl = async (url: string) => {
    if (url === "http://api.test/v1/auth/github") {
      return jsonResponse({ detail: { error: "github_auth_failed", status: 401 } }, 401);
    }
    throw new Error(`unexpected URL ${url}`);
  };

  const provider = createViewProvider(vscode, {}, { apiBaseUrl: "http://api.test", fetchImpl });
  provider.resolveWebviewView(view);
  await handler?.({ type: "start_session", intent: "超过30度亮红灯", boardId: "esp32-s3-devkitc-1" });

  assert.deepEqual(posted, [
    { type: "session_error", error: "github_token_exchange_failed" },
    { type: "session_done", terminal: "session_error" },
  ]);
});

test("request_boards probes /v1/health and forwards the server mode to the webview", async () => {
  const posted: any[] = [];
  let handler: ((message: any) => Promise<void>) | undefined;
  const panel = {
    webview: {
      cspSource: "vscode-resource:",
      html: "",
      postMessage: (message: any) => posted.push(message),
      onDidReceiveMessage: (next: any) => { handler = next; },
    },
  };
  const vscode = {
    ViewColumn: { One: 1 },
    window: { createWebviewPanel: () => panel, showWarningMessage: async () => "Cancel" },
  };
  const fetchImpl = (async (url: string) => {
    if (url === "http://api.test/v1/boards") return jsonResponse({ builtin: [], community: [] });
    if (url === "http://api.test/v1/health") return jsonResponse({ status: "ok", mode: "stub" });
    throw new Error(`unexpected URL ${url}`);
  }) as unknown as typeof fetch;

  createPanel(vscode, {}, { apiBaseUrl: "http://api.test", fetchImpl });
  await handler?.({ type: "request_boards" });

  assert.deepEqual(posted.find((message) => message.type === "server_mode"), { type: "server_mode", mode: "stub" });
});


test("request_boards forwards the official MicroPython board catalog to the webview", async () => {
  const posted: any[] = [];
  let handler: ((message: any) => Promise<void>) | undefined;
  const panel = {
    webview: {
      cspSource: "vscode-resource:",
      html: "",
      postMessage: (message: any) => posted.push(message),
      onDidReceiveMessage: (next: any) => { handler = next; },
    },
  };
  const vscode = {
    ViewColumn: { One: 1 },
    window: { createWebviewPanel: () => panel, showWarningMessage: async () => "Cancel" },
  };
  const fetchImpl = (async (url: string) => {
    if (url === "http://api.test/v1/boards") return jsonResponse({ builtin: [], community: [] });
    if (url === "http://api.test/v1/micropython/boards") return jsonResponse({ source_url: "https://micropython.org/download/", fetched_at: "2026-06-20T00:07:34+00:00", stale: true, boards: [{ id: "ESP32_GENERIC_S3" }], filters: { port: ["esp32"] } });
    if (url === "http://api.test/v1/health") return jsonResponse({ status: "ok" });
    throw new Error(`unexpected URL ${url}`);
  }) as unknown as typeof fetch;

  createPanel(vscode, {}, { apiBaseUrl: "http://api.test", fetchImpl });
  await handler?.({ type: "request_boards" });

  assert.deepEqual(posted.find((message) => message.type === "micropython_boards"), {
    type: "micropython_boards",
    source_url: "https://micropython.org/download/",
    fetched_at: "2026-06-20T00:07:34+00:00",
    stale: true,
    boards: [{ id: "ESP32_GENERIC_S3" }],
    filters: { port: ["esp32"] },
  });
});test("request_boards treats a backend that omits a mode as live (badge stays hidden)", async () => {
  const posted: any[] = [];
  let handler: ((message: any) => Promise<void>) | undefined;
  const panel = {
    webview: {
      cspSource: "vscode-resource:",
      html: "",
      postMessage: (message: any) => posted.push(message),
      onDidReceiveMessage: (next: any) => { handler = next; },
    },
  };
  const vscode = {
    ViewColumn: { One: 1 },
    window: { createWebviewPanel: () => panel, showWarningMessage: async () => "Cancel" },
  };
  const fetchImpl = (async (url: string) => {
    if (url === "http://api.test/v1/boards") return jsonResponse({ builtin: [], community: [] });
    if (url === "http://api.test/v1/health") return jsonResponse({ status: "ok" });
    throw new Error(`unexpected URL ${url}`);
  }) as unknown as typeof fetch;

  createPanel(vscode, {}, { apiBaseUrl: "http://api.test", fetchImpl });
  await handler?.({ type: "request_boards" });

  assert.deepEqual(posted.find((message) => message.type === "server_mode"), { type: "server_mode", mode: "live" });
});

// The template pipeline's API calls (minus the assertions in the first test).
// /v1/tools is intentionally unhandled → it throws, which checkToolRegistry
// swallows (couldn't check → proceed), matching the first test's behaviour.
const pipelineFetch = (async (url: string) => {
  if (url === "http://api.test/v1/skills") return jsonResponse({ toolchain_version: "1", skills: [] });
  if (url === "http://api.test/v1/packages/resolve") return jsonResponse({ selected: { name: "aht20_driver", version: "1.0.0" }, candidates: [], needs_user_choice: false, questions: [] });
  if (url === "http://api.test/v1/packages/aht20_driver/1.0.0/driver-context") return jsonResponse(aht20Context());
  if (url === "http://api.test/v1/boards/esp32-s3-devkitc-1") return jsonResponse(board());
  throw new Error(`unexpected URL ${url}`);
}) as unknown as typeof fetch;

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

function aht20Context() {
  return { package: { name: "aht20_driver", version: "1.0.0" }, import_names: ["aht20"], constructors: ["AHT20(i2c)"], read_properties: ["temperature"], bus: ["i2c"], pin_roles: ["i2c_sda", "i2c_scl"], install: { url: "https://upypi.net/pkgs/aht20/1.0.0/package.json" } };
}

function board() {
  return { board_id: "esp32-s3-devkitc-1", pin_recommendations: { i2c_sda: "GPIO5", i2c_scl: "GPIO6", led_default: "GPIO2" }, pin_capabilities: { GPIO5: ["i2c_sda"], GPIO6: ["i2c_scl"], GPIO2: ["led_anode", "gpio_out"] }, available_modules: ["machine", "time"] };
}

test("retry_session resumes the saved phase with the saved intent (not an empty turn)", async () => {
  const posted: any[] = [];
  const llmBodies: string[] = [];
  let handler: ((message: any) => Promise<void>) | undefined;
  const panel = {
    webview: {
      cspSource: "vscode-resource:",
      html: "",
      postMessage: (message: any) => posted.push(message),
      onDidReceiveMessage: (next: any) => { handler = next; },
    },
  };
  const vscode = {
    ViewColumn: { One: 1 },
    window: { createWebviewPanel: () => panel, showWarningMessage: async () => "Cancel" },
  };
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    assert.match(url, /\/v1\/llm\/messages$/);
    llmBodies.push(String(init?.body ?? "{}"));
    const sse = [
      JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "ok" } }),
      JSON.stringify({ type: "message_stop" }),
    ].map((data) => `data: ${data}`).join("\n\n");
    return { ok: true, status: 200, text: async () => sse } as unknown as Response;
  }) as unknown as typeof fetch;

  createPanel(vscode, {}, { apiBaseUrl: "http://api.test", fetchImpl });
  await handler?.({ type: "start_session", intent: "blink an led", boardId: "esp32-s3-devkitc-1" });
  await handler?.({ type: "retry_session" });

  const terminals = posted.filter((m) => m.type === "session_done").map((m) => m.terminal);
  assert.equal(terminals.length, 2, "retry must run a second loop pass");
  const retried = JSON.parse(llmBodies.at(-1)!);
  // The protocol restarts the phase conversation (manifest carries state, not the
  // message log), resuming the saved phase with the saved intent — never an empty turn.
  assert.equal(retried.phase, "analyze", "retry resumes the saved phase");
  assert.ok(retried.messages.at(-1).content, "retry re-sends the saved intent, not an empty user turn");
});

// --- local session-log export / reveal (Support & Feedback) ---

function seedSession(ws: string): string {
  const dir = join(ws, ".mpyhw", "sessions", "session-aaa111-bbb");
  mkdirSync(dir, { recursive: true });
  const content = '{"type":"session_started","ts":"2026-07-08T19:00:00.000Z","intent":"blink"}\n{"type":"phase_start","phase":"analyze"}\n';
  writeFileSync(join(dir, "session.jsonl"), content, "utf-8");
  return content;
}

function exportPanel(ws: string, opts: { windowExtra?: any } & Record<string, any> = {}) {
  const { windowExtra = {}, ...topExtra } = opts;
  const posted: any[] = [];
  let handler: ((message: any) => Promise<void>) | undefined;
  const panel = { webview: { cspSource: "", html: "", postMessage: (m: any) => posted.push(m), onDidReceiveMessage: (n: any) => { handler = n; } } };
  const vscode = {
    ViewColumn: { One: 1 },
    Uri: { file: (p: string) => ({ fsPath: p }) },
    workspace: { workspaceFolders: [{ uri: { fsPath: ws } }] },
    // keep createWebviewPanel (wires the handler) and merge any extra window methods
    window: { createWebviewPanel: () => panel, ...windowExtra },
    ...topExtra,
  };
  createPanel(vscode, {}, { apiBaseUrl: "http://api.test", fetchImpl: (async () => { throw new Error("no network in export test"); }) as any, loopMode: "template" });
  return { posted, run: (m: any) => handler?.(m) };
}

test("export_session_log saves the newest session.jsonl to the chosen path", async () => {
  const ws = mkdtempSync(join(tmpdir(), "mpyhw-ws-"));
  try {
    const srcContent = seedSession(ws);
    const target = join(ws, "exported.jsonl");
    const { posted, run } = exportPanel(ws, { windowExtra: { showSaveDialog: async () => ({ fsPath: target }) } });
    await run({ type: "export_session_log" });
    assert.ok(existsSync(target), "export file written to the chosen path");
    assert.equal(readFileSync(target, "utf-8"), srcContent, "exported content matches the session log");
    assert.ok(posted.some((m) => m.type === "logs_status" && /exported/i.test(m.text)), "posts an exported status");
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("export_session_log with no logs posts a 'no logs yet' status and writes nothing", async () => {
  const ws = mkdtempSync(join(tmpdir(), "mpyhw-ws-"));
  try {
    let dialogCalled = false;
    const { posted, run } = exportPanel(ws, { windowExtra: { showSaveDialog: async () => { dialogCalled = true; return undefined; } } });
    await run({ type: "export_session_log" });
    assert.equal(dialogCalled, false, "no save dialog when there is nothing to export");
    assert.ok(posted.some((m) => m.type === "logs_status" && /no session logs/i.test(m.text)));
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("reveal_logs_folder reveals the .mpyhw/sessions dir when logs exist", async () => {
  const ws = mkdtempSync(join(tmpdir(), "mpyhw-ws-"));
  try {
    seedSession(ws);
    const revealed: any[] = [];
    const { run } = exportPanel(ws, { commands: { executeCommand: (cmd: string, arg: any) => { revealed.push({ cmd, arg }); } } });
    await run({ type: "reveal_logs_folder" });
    const hit = revealed.find((r) => r.cmd === "revealFileInOS");
    assert.ok(hit, "revealFileInOS is invoked");
    assert.ok(String(hit.arg.fsPath).endsWith(join(".mpyhw", "sessions")), "reveals the sessions dir");
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});
