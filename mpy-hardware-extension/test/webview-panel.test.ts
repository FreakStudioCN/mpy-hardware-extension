import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

test("artifact browser: request_artifacts indexes relative paths; open_artifact honors the trust boundary", async () => {
  const ws = mkdtempSync(join(tmpdir(), "mpyhw-ws-"));
  try {
    const posted: any[] = [];
    const opened: string[] = [];
    const commandCalls: Array<{ cmd: string; path?: string }> = [];
    let handler: ((message: any) => Promise<void>) | undefined;
    const panel = {
      webview: {
        cspSource: "vscode-resource:",
        html: "",
        options: undefined as any,
        postMessage: (message: any) => posted.push(message),
        onDidReceiveMessage: (next: any) => { handler = next; },
        asWebviewUri: (uri: any) => ({ toString: () => `vscode-resource://${uri.fsPath}` }),
      },
    };
    const vscode = {
      ViewColumn: { One: 1 },
      workspace: {
        workspaceFolders: [{ uri: { fsPath: ws } }],
        openTextDocument: async (uri: any) => { opened.push(uri.fsPath ?? String(uri)); return { uri }; },
      },
      window: {
        createWebviewPanel: () => panel,
        showWarningMessage: async (message: string) => message.startsWith("Overwrite ") ? "Overwrite" : "Cancel",
        showTextDocument: async () => {},
      },
      commands: { executeCommand: async (cmd: string, arg: any) => { commandCalls.push({ cmd, path: arg?.fsPath }); } },
      Uri: { file: (p: string) => ({ fsPath: p }) },
    };
    const fetchImpl = async (url: string) => {
      if (url === "http://api.test/v1/skills") return jsonResponse({ toolchain_version: "1", skills: [] });
      if (url === "http://api.test/v1/packages/resolve") return jsonResponse({ selected: { name: "aht20_driver", version: "1.0.0" }, candidates: [], needs_user_choice: false, questions: [] });
      if (url === "http://api.test/v1/packages/aht20_driver/1.0.0/driver-context") return jsonResponse(aht20Context());
      if (url === "http://api.test/v1/boards/esp32-s3-devkitc-1") return jsonResponse(board());
      if (url === "http://api.test/v1/tools") return jsonResponse({ tools: [] });
      throw new Error(`unexpected URL ${url}`);
    };

    createPanel(vscode, {}, { apiBaseUrl: "http://api.test", fetchImpl, loopMode: "template" });
    // Image artifacts load under CSP via asWebviewUri, so the workspace must be an allowed root.
    assert.ok(
      Array.isArray(panel.webview.options?.localResourceRoots)
        && panel.webview.options.localResourceRoots.some((r: any) => r.fsPath === ws),
      "localResourceRoots includes the workspace",
    );
    await handler?.({ type: "start_session", intent: "超过30度亮红灯", boardId: "esp32-s3-devkitc-1" });
    assert.ok(existsSync(join(ws, "blockless-project", "main.py")), "artifact persisted to disk");

    await handler?.({ type: "request_artifacts" });
    const index = posted.filter((m) => m.type === "artifacts_index").at(-1);
    assert.ok(index, "artifacts_index posted");
    const main = index.artifacts.find((a: any) => a.relative_path.endsWith("main.py"));
    assert.ok(main, "main.py is indexed");
    assert.equal(main.relative_path, "blockless-project/main.py");
    assert.doesNotMatch(main.relative_path, /^[A-Za-z]:/, "no drive letter to the UI");
    assert.doesNotMatch(main.relative_path, /^\//, "path is relative");
    assert.equal(main.kind, "code");
    assert.ok(main.size > 0 && main.sha256.length === 64, "metadata computed");
    // The absolute path must never cross to the webview (§4.2): no absolute_path field,
    // and no value in any emitted row is an absolute/drive-letter path.
    for (const a of index.artifacts) {
      assert.ok(!("absolute_path" in a), "absolute_path stripped from the webview payload");
      for (const v of Object.values(a)) {
        if (typeof v === "string") {
          assert.doesNotMatch(v, /^([A-Za-z]:|\/)/, `no absolute value leaked: ${v}`);
        }
      }
    }

    // in-index open resolves to the real absolute path in the editor. (Clear first: the
    // start_session flow auto-opens main.py once, which we don't want to count here.)
    opened.length = 0;
    await handler?.({ type: "open_artifact", relative_path: "blockless-project/main.py" });
    assert.deepEqual(opened, [join(ws, "blockless-project", "main.py")]);
    // A text/code artifact opens in the editor, not via a preview command (md/image routing).
    assert.ok(!commandCalls.some((c) => c.cmd === "vscode.open" || c.cmd === "markdown.showPreview"),
      "text artifact routed to the editor, not a preview command");

    // trust boundary: traversal / out-of-index paths never open
    opened.length = 0;
    await handler?.({ type: "open_artifact", relative_path: "../../etc/passwd" });
    await handler?.({ type: "open_artifact", relative_path: "blockless-project/nope.py" });
    assert.deepEqual(opened, [], "hostile / out-of-index paths refused");
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

test("artifact browser lists on-disk project artifacts without a build (reopened panel)", async () => {
  const ws = mkdtempSync(join(tmpdir(), "mpyhw-ws-"));
  try {
    // A prior build's output already on disk; no session runs this time (reopened panel).
    mkdirSync(join(ws, "blockless-project", "firmware", "drivers"), { recursive: true });
    writeFileSync(join(ws, "blockless-project", "main.py"), "print('hi')");
    writeFileSync(join(ws, "blockless-project", "project-manifest.json"), "{}");
    writeFileSync(join(ws, "blockless-project", "firmware", "drivers", "aht20.py"), "# driver");

    const posted: any[] = [];
    let handler: ((message: any) => Promise<void>) | undefined;
    const panel = {
      webview: {
        cspSource: "vscode-resource:", html: "", options: undefined as any,
        postMessage: (m: any) => posted.push(m),
        onDidReceiveMessage: (n: any) => { handler = n; },
      },
    };
    const vscode = {
      ViewColumn: { One: 1 },
      workspace: { workspaceFolders: [{ uri: { fsPath: ws } }] },
      window: { createWebviewPanel: () => panel, showWarningMessage: async () => "Cancel" },
      Uri: { file: (p: string) => ({ fsPath: p }) },
    };

    createPanel(vscode, {}, { apiBaseUrl: "http://api.test", fetchImpl: async () => jsonResponse({}), loopMode: "template" });
    await handler?.({ type: "request_artifacts" });

    const index = posted.filter((m) => m.type === "artifacts_index").at(-1);
    assert.ok(index, "artifacts_index posted");
    const rels = index.artifacts.map((a: any) => a.relative_path);
    assert.ok(rels.includes("blockless-project/main.py"), "on-disk main.py indexed without a build");
    assert.ok(rels.includes("blockless-project/project-manifest.json"), "on-disk manifest indexed");
    assert.ok(rels.some((r: string) => r.endsWith("firmware/drivers/aht20.py")), "on-disk driver indexed (nested)");
    const kinds = new Set(index.artifacts.map((a: any) => a.kind));
    assert.ok(kinds.has("manifest") && kinds.has("code") && kinds.has("driver"), "kinds classified from disk paths");
    assert.ok(index.artifacts.every((a: any) => a.origin === "disk"), "on-disk scan marks origin=disk");
    for (const a of index.artifacts) {
      assert.ok(!("absolute_path" in a), "no absolute_path leaked");
      assert.doesNotMatch(a.relative_path, /^([A-Za-z]:|\/)/, "relative display path");
    }
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("artifact browser never indexes a symlink that escapes the project root (#28 F2)", async () => {
  const ws = mkdtempSync(join(tmpdir(), "mpyhw-ws-"));
  try {
    mkdirSync(join(ws, "blockless-project"), { recursive: true });
    writeFileSync(join(ws, "blockless-project", "main.py"), "print('hi')");
    // A secret file OUTSIDE the project, and a symlink inside the project pointing at it.
    const secret = join(ws, "secret.py");
    writeFileSync(secret, "# out-of-tree secret");
    try {
      symlinkSync(secret, join(ws, "blockless-project", "leak.py"));
    } catch {
      return; // symlink creation needs privilege (Windows without dev mode) — skip, not fail
    }

    const posted: any[] = [];
    let handler: ((message: any) => Promise<void>) | undefined;
    const panel = {
      webview: {
        cspSource: "vscode-resource:", html: "", options: undefined as any,
        postMessage: (m: any) => posted.push(m),
        onDidReceiveMessage: (n: any) => { handler = n; },
      },
    };
    const vscode = {
      ViewColumn: { One: 1 },
      workspace: { workspaceFolders: [{ uri: { fsPath: ws } }] },
      window: { createWebviewPanel: () => panel, showWarningMessage: async () => "Cancel" },
      Uri: { file: (p: string) => ({ fsPath: p }) },
    };

    createPanel(vscode, {}, { apiBaseUrl: "http://api.test", fetchImpl: async () => jsonResponse({}), loopMode: "template" });
    await handler?.({ type: "request_artifacts" });

    const index = posted.filter((m) => m.type === "artifacts_index").at(-1);
    assert.ok(index, "artifacts_index posted");
    const rels = index.artifacts.map((a: any) => a.relative_path);
    assert.ok(rels.includes("blockless-project/main.py"), "the real file is indexed");
    assert.ok(!rels.some((r: string) => r.endsWith("leak.py")), "the escaping symlink is not indexed");
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("artifact browser stays session-scoped in the no-workspace fallback (no shared bucket)", async () => {
  const gs = mkdtempSync(join(tmpdir(), "mpyhw-gs-"));
  try {
    // Prior/other-session leftovers sitting in the SHARED globalStorage project dir.
    mkdirSync(join(gs, "blockless-project", "firmware"), { recursive: true });
    writeFileSync(join(gs, "blockless-project", "select_hw_validated.json"), "{}");
    writeFileSync(join(gs, "blockless-project", "firmware", "main.py"), "print('old')");

    const posted: any[] = [];
    let handler: ((message: any) => Promise<void>) | undefined;
    const panel = {
      webview: {
        cspSource: "vscode-resource:", html: "", options: undefined as any,
        postMessage: (m: any) => posted.push(m),
        onDidReceiveMessage: (n: any) => { handler = n; },
      },
    };
    const vscode = {
      ViewColumn: { One: 1 },
      workspace: { workspaceFolders: undefined }, // no workspace open -> globalStorage fallback
      window: { createWebviewPanel: () => panel, showWarningMessage: async () => "Cancel" },
      Uri: { file: (p: string) => ({ fsPath: p }) },
    };

    createPanel(vscode, {}, { apiBaseUrl: "http://api.test", fetchImpl: async () => jsonResponse({}), loopMode: "template", globalStoragePath: gs });
    await handler?.({ type: "request_artifacts" });

    const index = posted.filter((m) => m.type === "artifacts_index").at(-1);
    assert.ok(index, "artifacts_index posted");
    // The shared bucket's cross-session leftovers must NOT appear (no build ran this session).
    assert.equal(index.artifacts.length, 0, "no shared-bucket files surfaced without a session build");
  } finally {
    rmSync(gs, { recursive: true, force: true });
  }
});

test("with no workspace open, sessions record to globalStorage and appear in Recent Sessions", async () => {
  const gs = mkdtempSync(join(tmpdir(), "mpyhw-gs-"));
  try {
    const posted: any[] = [];
    let handler: ((message: any) => Promise<void>) | undefined;
    const panel = {
      webview: {
        cspSource: "vscode-resource:", html: "",
        postMessage: (m: any) => posted.push(m),
        onDidReceiveMessage: (n: any) => { handler = n; },
      },
    };
    const vscode = {
      ViewColumn: { One: 1 },
      Uri: { file: (p: string) => ({ fsPath: p }) },
      window: { createWebviewPanel: () => panel, showWarningMessage: async () => "Cancel" },
      // no workspace.workspaceFolders → globalStorage fallback
    };

    createPanel(vscode, {}, { apiBaseUrl: "http://api.test", fetchImpl: pipelineFetch, loopMode: "template", globalStoragePath: gs });
    await handler?.({ type: "start_session", intent: "超过30度亮红灯", boardId: "esp32-s3-devkitc-1" });

    // The session was recorded under <globalStorage>/.mpyhw/sessions even with no workspace open.
    assert.ok(existsSync(join(gs, ".mpyhw", "sessions")), "sessions dir created under globalStorage");
    await handler?.({ type: "request_recent_sessions" });
    const recent = posted.filter((m) => m.type === "recent_sessions").at(-1);
    assert.ok(recent, "recent_sessions posted");
    assert.equal(recent.sessions.length, 1, "the just-run session appears in Recent Sessions");
    assert.match(recent.sessions[0].id, /^session-/, "id is a real session dir");
  } finally {
    rmSync(gs, { recursive: true, force: true });
  }
});

test("the current session's tree (log + checkpoints) is browsable, not just blockless-project", async () => {
  const ws = mkdtempSync(join(tmpdir(), "mpyhw-ws-"));
  try {
    const posted: any[] = [];
    let handler: ((message: any) => Promise<void>) | undefined;
    const panel = {
      webview: {
        cspSource: "vscode-resource:", html: "",
        postMessage: (m: any) => posted.push(m),
        onDidReceiveMessage: (n: any) => { handler = n; },
      },
    };
    const vscode = {
      ViewColumn: { One: 1 },
      Uri: { file: (p: string) => ({ fsPath: p }) },
      workspace: { workspaceFolders: [{ uri: { fsPath: ws } }] },
      window: { createWebviewPanel: () => panel, showWarningMessage: async () => "Cancel" },
    };

    createPanel(vscode, {}, { apiBaseUrl: "http://api.test", fetchImpl: pipelineFetch, loopMode: "template" });
    await handler?.({ type: "start_session", intent: "超过30度亮红灯", boardId: "esp32-s3-devkitc-1" });

    // The recorder wrote ws/.mpyhw/sessions/<id>/session.jsonl during the run; add a checkpoint
    // like the safe-point mechanism would, then confirm both surface (§8.3 sessions/<id>/ tree).
    const sessionsDir = join(ws, ".mpyhw", "sessions");
    const id = readdirSync(sessionsDir)[0];
    mkdirSync(join(sessionsDir, id, "checkpoints"), { recursive: true });
    writeFileSync(join(sessionsDir, id, "checkpoints", "analyze.json"), "{}");

    await handler?.({ type: "request_artifacts" });
    const index = posted.filter((m) => m.type === "artifacts_index").at(-1);
    assert.ok(index, "artifacts_index posted");
    const rels = index.artifacts.map((a: any) => a.relative_path);
    assert.ok(rels.some((r: string) => r.endsWith("session.jsonl") && r.includes("/sessions/")), "session log is browsable from the session tree");
    const cp = index.artifacts.find((a: any) => a.relative_path.endsWith("checkpoints/analyze.json"));
    assert.ok(cp, "checkpoint file is browsable");
    assert.equal(cp.kind, "checkpoint", "checkpoint files classify as their own kind, not generic log");
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});
