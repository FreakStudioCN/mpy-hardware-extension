import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
    // manifest_updated now drives a derived diagram_updated (Wiring/Diagram tabs).
    assert.deepEqual(posted.map((message) => message.type), ["trace_event", "manifest_updated", "diagram_updated", "code_updated", "trace_event", "files_written", "session_done"]);
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

    // §4.2 also covers the files_written message (#28 F3/F7): it renders its paths in the
    // activity feed, so an absolute/drive-letter path there is a leak the artifacts_index
    // check above would miss. The generate flow above wrote main.py, so it was posted.
    const written = posted.filter((m) => m.type === "files_written");
    assert.ok(written.length > 0, "generate posted a files_written");
    for (const m of written) {
      for (const p of m.paths ?? []) {
        assert.doesNotMatch(p, /^([A-Za-z]:|\/)/, `files_written path must be relative, got: ${p}`);
      }
      assert.ok((m.paths ?? []).some((p: string) => p.endsWith("main.py")), "the written file is still reported");
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

test("device tools reach the shim and post a result when idle", async () => {
  const ws = mkdtempSync(join(tmpdir(), "mpyhw-ws-"));
  try {
    const posted: any[] = [];
    let handler: ((message: any) => Promise<void>) | undefined;
    const panel = { webview: { cspSource: "", html: "", postMessage: (m: any) => posted.push(m), onDidReceiveMessage: (n: any) => { handler = n; } } };
    const vscode = { ViewColumn: { One: 1 }, workspace: { workspaceFolders: [{ uri: { fsPath: ws } }] }, window: { createWebviewPanel: () => panel } };
    let listCalled = 0;
    const shim = { listDir: async (_p: string) => { listCalled++; return ["boot.py", "lib"]; } };
    const fetchImpl = (async () => { throw new Error("no api needed"); }) as unknown as typeof fetch;
    createPanel(vscode, {}, { shim, apiBaseUrl: "http://api.test", fetchImpl, loopMode: "template" });

    await handler!({ type: "device_tool_list", path: "/" });
    assert.equal(listCalled, 1, "an idle device command reaches the shim");
    const result = posted.find((m) => m.type === "device_tool_result");
    assert.ok(result && result.command === "list", "and posts a device_tool_result");
    assert.deepEqual(result.result.entries, ["boot.py", "lib"]);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("device tools upload sends the raw file bytes (binary-safe) to the user-path shim write — N1", async () => {
  const ws = mkdtempSync(join(tmpdir(), "mpyhw-ws-"));
  try {
    const posted: any[] = [];
    let handler: ((message: any) => Promise<void>) | undefined;
    const panel = { webview: { cspSource: "", html: "", postMessage: (m: any) => posted.push(m), onDidReceiveMessage: (n: any) => { handler = n; } } };
    const wrote: Array<{ path: string; bytes: Uint8Array }> = [];
    // Non-UTF-8 bytes: a TextDecoder in the handler would replace these with U+FFFD and corrupt the upload.
    const fileBytes = new Uint8Array([0xff, 0xfe, 0x00, 0x89]);
    const vscode = {
      ViewColumn: { One: 1 },
      workspace: { workspaceFolders: [{ uri: { fsPath: ws } }], fs: { readFile: async () => fileBytes } },
      window: { createWebviewPanel: () => panel, showOpenDialog: async () => [{ fsPath: join(ws, "blob.mpy") }] },
    };
    const shim = { writeUserDeviceFile: async (path: string, bytes: Uint8Array) => { wrote.push({ path, bytes }); } };
    const fetchImpl = (async () => { throw new Error("no api"); }) as unknown as typeof fetch;
    createPanel(vscode, {}, { shim, apiBaseUrl: "http://api.test", fetchImpl, loopMode: "template" });

    await handler!({ type: "device_tool_upload", dir: "" }); // root upload — a plain path, no lib/firmware prefix
    assert.equal(wrote.length, 1, "upload reached the shim's user-path write at the device root");
    assert.equal(wrote[0].path, "blob.mpy", "a plain filename (no allowlist prefix) is accepted");
    assert.deepEqual(wrote[0].bytes, fileBytes, "raw bytes pass through, not a lossy-decoded string");
    assert.ok(posted.some((m) => m.type === "device_tool_result" && m.command === "upload"));
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test("device tools download rejects a traversal basename and never touches the port — N3", async () => {
  const ws = mkdtempSync(join(tmpdir(), "mpyhw-ws-"));
  try {
    const posted: any[] = [];
    let handler: ((message: any) => Promise<void>) | undefined;
    const panel = { webview: { cspSource: "", html: "", postMessage: (m: any) => posted.push(m), onDidReceiveMessage: (n: any) => { handler = n; } } };
    const copied: any[] = [];
    const vscode = { ViewColumn: { One: 1 }, workspace: { workspaceFolders: [{ uri: { fsPath: ws } }] }, window: { createWebviewPanel: () => panel } };
    const shim = { copyFromDevice: async (r: string, l: string) => { copied.push({ r, l }); } };
    const fetchImpl = (async () => { throw new Error("no api"); }) as unknown as typeof fetch;
    createPanel(vscode, {}, { shim, apiBaseUrl: "http://api.test", fetchImpl, loopMode: "template" });

    await handler!({ type: "device_tool_download", path: "/lib/.." });
    assert.ok(posted.some((m) => m.type === "device_tool_error" && m.error === "invalid_device_path"), "traversal basename rejected");
    assert.equal(copied.length, 0, "the shim/port is never touched for a rejected path");
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test("device tools download does not clobber an existing workspace file — N3", async () => {
  const ws = mkdtempSync(join(tmpdir(), "mpyhw-ws-"));
  try {
    writeFileSync(join(ws, "boot.py"), "original");
    const posted: any[] = [];
    let handler: ((message: any) => Promise<void>) | undefined;
    const panel = { webview: { cspSource: "", html: "", postMessage: (m: any) => posted.push(m), onDidReceiveMessage: (n: any) => { handler = n; } } };
    const copied: any[] = [];
    const vscode = {
      ViewColumn: { One: 1 },
      workspace: { workspaceFolders: [{ uri: { fsPath: ws } }] },
      window: { createWebviewPanel: () => panel, showTextDocument: async () => {} },
      Uri: { file: (p: string) => ({ fsPath: p }) },
    };
    const shim = { copyFromDevice: async (r: string, l: string) => { copied.push({ r, l }); } };
    const fetchImpl = (async () => { throw new Error("no api"); }) as unknown as typeof fetch;
    createPanel(vscode, {}, { shim, apiBaseUrl: "http://api.test", fetchImpl, loopMode: "template" });

    await handler!({ type: "device_tool_download", path: "/boot.py" });
    assert.equal(copied.length, 1);
    assert.match(copied[0].l, /boot \(1\)\.py$/, "downloaded to a non-clobbering name");
    assert.equal(readFileSync(join(ws, "boot.py"), "utf8"), "original", "the existing file is untouched");
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test("device tools delete is host-armed: a bare message only arms; the echoed nonce deletes once; a replay can't re-delete — §4", async () => {
  const ws = mkdtempSync(join(tmpdir(), "mpyhw-ws-"));
  try {
    const posted: any[] = [];
    let handler: ((message: any) => Promise<void>) | undefined;
    const panel = { webview: { cspSource: "", html: "", postMessage: (m: any) => posted.push(m), onDidReceiveMessage: (n: any) => { handler = n; } } };
    const vscode = { ViewColumn: { One: 1 }, workspace: { workspaceFolders: [{ uri: { fsPath: ws } }] }, window: { createWebviewPanel: () => panel } };
    const removed: string[] = [];
    const shim = { removePath: async (p: string) => { removed.push(p); } };
    const fetchImpl = (async () => { throw new Error("no api"); }) as unknown as typeof fetch;
    createPanel(vscode, {}, { shim, apiBaseUrl: "http://api.test", fetchImpl, loopMode: "template" });

    // 1) Bare delete = arm only (the stale/duplicate case): nothing removed; host issues a nonce.
    await handler!({ type: "device_tool_delete", path: "/boot.py" });
    assert.equal(removed.length, 0, "a bare delete does not remove — it only arms");
    const armed = posted.find((m) => m.type === "device_tool_delete_armed" && m.path === "/boot.py");
    assert.ok(armed && armed.nonce, "host posts an arm carrying a one-shot nonce");

    // 2) A stale message with the WRONG nonce still only re-arms, never deletes.
    await handler!({ type: "device_tool_delete", path: "/boot.py", nonce: "not-the-nonce" });
    assert.equal(removed.length, 0, "a mismatched nonce cannot delete");

    // 3) Echo the current nonce -> the delete happens exactly once. (Step 2 re-armed, so use the latest.)
    const latest = posted.filter((m) => m.type === "device_tool_delete_armed").at(-1);
    await handler!({ type: "device_tool_delete", path: "/boot.py", nonce: latest.nonce });
    assert.deepEqual(removed, ["/boot.py"], "the confirm with the host nonce deletes exactly once");

    // 4) Replay the consumed nonce -> no second delete (re-arms instead).
    await handler!({ type: "device_tool_delete", path: "/boot.py", nonce: latest.nonce });
    assert.deepEqual(removed, ["/boot.py"], "a replayed nonce cannot delete again");
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test("device tools download fails (never clobbers) once every dedup slot is taken — N3", async () => {
  const ws = mkdtempSync(join(tmpdir(), "mpyhw-ws-"));
  try {
    // Fill boot.py + boot (1..1000).py so uniqueLocalPath has no free slot left.
    writeFileSync(join(ws, "boot.py"), "original");
    for (let n = 1; n <= 1000; n++) writeFileSync(join(ws, `boot (${n}).py`), "");
    const posted: any[] = [];
    let handler: ((message: any) => Promise<void>) | undefined;
    const panel = { webview: { cspSource: "", html: "", postMessage: (m: any) => posted.push(m), onDidReceiveMessage: (n: any) => { handler = n; } } };
    const copied: any[] = [];
    const vscode = {
      ViewColumn: { One: 1 },
      workspace: { workspaceFolders: [{ uri: { fsPath: ws } }] },
      window: { createWebviewPanel: () => panel, showTextDocument: async () => {} },
      Uri: { file: (p: string) => ({ fsPath: p }) },
    };
    const shim = { copyFromDevice: async (r: string, l: string) => { copied.push({ r, l }); } };
    const fetchImpl = (async () => { throw new Error("no api"); }) as unknown as typeof fetch;
    createPanel(vscode, {}, { shim, apiBaseUrl: "http://api.test", fetchImpl, loopMode: "template" });

    await handler!({ type: "device_tool_download", path: "/boot.py" });
    assert.ok(
      posted.some((m) => m.type === "device_tool_error" && m.command === "download" && m.error === "too_many_download_duplicates"),
      "dedup exhaustion is a surfaced error, not a silent clobber",
    );
    assert.equal(copied.length, 0, "no copy to the clobbering original path");
    assert.equal(readFileSync(join(ws, "boot.py"), "utf8"), "original", "the existing file is untouched");
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test("device tools are refused with device_busy while a session run owns the port (spec §41)", async () => {
  const ws = mkdtempSync(join(tmpdir(), "mpyhw-ws-"));
  try {
    const posted: any[] = [];
    let handler: ((message: any) => Promise<void>) | undefined;
    const panel = { webview: { cspSource: "", html: "", postMessage: (m: any) => posted.push(m), onDidReceiveMessage: (n: any) => { handler = n; } } };
    const vscode = { ViewColumn: { One: 1 }, workspace: { workspaceFolders: [{ uri: { fsPath: ws } }] }, window: { createWebviewPanel: () => panel } };
    let listCalled = 0;
    const shim = { scan: async () => ["/dev/ttyX"], setPort: () => {}, kill: () => {}, listDir: async () => { listCalled++; return ["boot.py"]; } };
    // Protocol + toolchain checks resolve; the loop's first real call blocks on a gate so the
    // run stays in-flight. `blocked` resolves exactly when we reach it (run() has set abort by
    // then), so the busy check is deterministic. Releasing it (then erroring) unwinds the run.
    let releaseFetch: () => void = () => {};
    let reachedBlock: () => void = () => {};
    const fetchGate = new Promise<void>((res) => { releaseFetch = res; });
    const blocked = new Promise<void>((res) => { reachedBlock = res; });
    const fetchImpl = (async (url: string) => {
      if (url.endsWith("/v1/tools")) return jsonResponse({ tools: [] });
      if (url.endsWith("/v1/skills")) return jsonResponse({ toolchain_version: "1", skills: [] });
      reachedBlock();
      await fetchGate;
      throw new Error("stop");
    }) as unknown as typeof fetch;
    createPanel(vscode, {}, { shim, apiBaseUrl: "http://api.test", fetchImpl, loopMode: "template" });

    const running = handler!({ type: "start_session", intent: "x", boardId: "esp32-s3-devkitc-1" });
    await blocked; // the run is now in-flight, owning the device

    await handler!({ type: "device_tool_list", path: "/" });
    assert.ok(posted.some((m) => m.type === "device_busy"), "a device command during a run is refused with device_busy");
    assert.equal(listCalled, 0, "the shim is not touched while a run owns the port");

    releaseFetch(); // unblock the loop so the session errors out and the run finishes
    await running.catch(() => {});
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("a re-entrant start_session while a run is in-flight is rejected session_busy, not queued as a duplicate — register #1", async () => {
  const ws = mkdtempSync(join(tmpdir(), "mpyhw-ws-"));
  try {
    const posted: any[] = [];
    let handler: ((message: any) => Promise<void>) | undefined;
    const panel = { webview: { cspSource: "", html: "", postMessage: (m: any) => posted.push(m), onDidReceiveMessage: (n: any) => { handler = n; } } };
    const vscode = { ViewColumn: { One: 1 }, workspace: { workspaceFolders: [{ uri: { fsPath: ws } }] }, window: { createWebviewPanel: () => panel } };
    const shim = { scan: async () => ["/dev/ttyX"], setPort: () => {}, kill: () => {} };
    let releaseFetch: () => void = () => {};
    let reachedBlock: () => void = () => {};
    const fetchGate = new Promise<void>((res) => { releaseFetch = res; });
    const blocked = new Promise<void>((res) => { reachedBlock = res; });
    let llmCalls = 0;
    const fetchImpl = (async (url: string) => {
      if (url.endsWith("/v1/tools")) return jsonResponse({ tools: [] });
      if (url.endsWith("/v1/skills")) return jsonResponse({ toolchain_version: "1", skills: [] });
      llmCalls++;
      reachedBlock();
      await fetchGate;
      throw new Error("stop");
    }) as unknown as typeof fetch;
    createPanel(vscode, {}, { shim, apiBaseUrl: "http://api.test", fetchImpl, loopMode: "template" });

    const running = handler!({ type: "start_session", intent: "x", boardId: "esp32-s3-devkitc-1" });
    await blocked; // the first run is in-flight, holding the device queue

    posted.length = 0; // isolate the re-entrant response
    await handler!({ type: "start_session", intent: "y", boardId: "esp32-s3-devkitc-1" });
    assert.ok(posted.some((m) => m.type === "session_busy"), "a second start while running is rejected session_busy");
    assert.equal(llmCalls, 1, "the second start does not reach the loop (no duplicate run queued behind the held port)");
    // Mutation: drop the isRunning() pre-check -> the second start blocks on the held queue, posts no
    // session_busy here, and runs a duplicate after release (llmCalls would reach 2).

    releaseFetch();
    await running.catch(() => {});
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test("device tools download reports success even when the editor refuses to open a binary — PR #31 finding 4", async () => {
  const ws = mkdtempSync(join(tmpdir(), "mpyhw-ws-"));
  try {
    const posted: any[] = [];
    let handler: ((message: any) => Promise<void>) | undefined;
    const panel = { webview: { cspSource: "", html: "", postMessage: (m: any) => posted.push(m), onDidReceiveMessage: (n: any) => { handler = n; } } };
    const revealed: any[] = [];
    const vscode = {
      ViewColumn: { One: 1 },
      workspace: { workspaceFolders: [{ uri: { fsPath: ws } }] },
      window: { createWebviewPanel: () => panel, showTextDocument: async () => { throw new Error("File seems to be binary and cannot be opened as text"); } },
      commands: { executeCommand: async (cmd: string, uri: any) => { revealed.push({ cmd, uri }); } },
      Uri: { file: (p: string) => ({ fsPath: p }) },
    };
    const shim = { copyFromDevice: async () => {} };
    const fetchImpl = (async () => { throw new Error("no api"); }) as unknown as typeof fetch;
    createPanel(vscode, {}, { shim, apiBaseUrl: "http://api.test", fetchImpl, loopMode: "template" });

    await handler!({ type: "device_tool_download", path: "/blob.mpy" });
    assert.ok(posted.some((m) => m.type === "device_tool_result" && m.command === "download"), "a good download reports success");
    assert.ok(!posted.some((m) => m.type === "device_tool_error"), "a binary that won't open in the editor is NOT reported as an error");
    assert.ok(revealed.some((r) => r.cmd === "revealFileInOS"), "falls back to revealing the saved file in the OS");
    // Mutation: drop the try/catch around showTextDocument -> the reject surfaces as device_tool_error.
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test("device tools run again after a session releases the queue — PR #31 finding 5", async () => {
  const ws = mkdtempSync(join(tmpdir(), "mpyhw-ws-"));
  try {
    const posted: any[] = [];
    let handler: ((message: any) => Promise<void>) | undefined;
    const panel = { webview: { cspSource: "", html: "", postMessage: (m: any) => posted.push(m), onDidReceiveMessage: (n: any) => { handler = n; } } };
    const vscode = { ViewColumn: { One: 1 }, workspace: { workspaceFolders: [{ uri: { fsPath: ws } }] }, window: { createWebviewPanel: () => panel } };
    let listCalled = 0;
    const shim = { scan: async () => ["/dev/ttyX"], setPort: () => {}, kill: () => {}, listDir: async () => { listCalled++; return ["boot.py"]; } };
    const fetchImpl = (async (url: string) => {
      if (url.endsWith("/v1/tools")) return jsonResponse({ tools: [] });
      if (url.endsWith("/v1/skills")) return jsonResponse({ toolchain_version: "1", skills: [] });
      throw new Error("stop"); // the run errors out and reaches its terminal, releasing the held queue
    }) as unknown as typeof fetch;
    createPanel(vscode, {}, { shim, apiBaseUrl: "http://api.test", fetchImpl, loopMode: "template" });

    await handler!({ type: "start_session", intent: "x", boardId: "esp32-s3-devkitc-1" }); // holds the queue, releases at the terminal
    assert.ok(posted.some((m) => m.type === "session_done"), "the run reached its terminal");

    await handler!({ type: "device_tool_list", path: "/" }); // would wedge forever if the run still held the queue
    assert.ok(posted.some((m) => m.type === "device_tool_result" && m.command === "list"), "device tools work again once the run released the queue");
    assert.equal(listCalled, 1, "the list reached the shim");
    // Mutation: drop `finally { releaseRun() }` -> the queue stays held and this device_tool_list never resolves.
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

// Minimal panel wired only for package-browser message handling (no workspace/shim).
function packageSearchPanel(fetchImpl: any): { getHandler: () => (m: any) => Promise<void>; posted: any[]; requested: string[] } {
  const posted: any[] = [];
  let handler: ((m: any) => Promise<void>) | undefined;
  const panel = {
    webview: {
      cspSource: "vscode-resource:",
      html: "",
      postMessage: (message: any) => posted.push(message),
      onDidReceiveMessage: (next: any) => { handler = next; },
    },
  };
  const vscode = { ViewColumn: { One: 1 }, window: { createWebviewPanel: () => panel, showWarningMessage: async () => "Cancel" } };
  const requested: string[] = [];
  const wrapped = async (url: string, init?: RequestInit) => { requested.push(url); return fetchImpl(url, init); };
  createPanel(vscode, {}, { apiBaseUrl: "http://api.test", fetchImpl: wrapped });
  return { getHandler: () => handler!, posted, requested };
}

test("package browser host: Auto searches both live sources and never the local catalog", async () => {
  // Auto merges live micropython-lib + uPyPI; it must NOT hit /v1/packages/search (the
  // graftsense-heavy local catalog), and each result carries its own source.
  const { getHandler, posted, requested } = packageSearchPanel(async (url: string) => {
    if (url.startsWith("http://api.test/v1/packages/upypi/search")) return jsonResponse({ results: [{ name: "bmp280", url: "u" }], source: "upypi" });
    if (url.startsWith("http://api.test/v1/packages/micropython-lib/search")) return jsonResponse({ results: [{ name: "aioble", version: "0.6.0", source: "micropython_lib" }], source: "micropython_lib" });
    throw new Error(`unexpected ${url}`);
  });

  await getHandler()({ type: "package_search", source: "auto", query: "b" });

  assert.ok(requested.some((u) => u.includes("/v1/packages/upypi/search?q=b")), "Auto hits uPyPI");
  assert.ok(requested.some((u) => u.includes("/v1/packages/micropython-lib/search?q=b")), "Auto hits micropython-lib");
  assert.ok(!requested.some((u) => u.includes("/v1/packages/search")), "Auto never hits the local catalog");
  const result = posted.find((m) => m.type === "package_search_result");
  const bySource: Record<string, string> = {};
  for (const r of result.results) bySource[r.name] = r.source;
  assert.equal(bySource["bmp280"], "upypi", "uPyPI hit tagged with its per-result source");
  assert.equal(bySource["aioble"], "micropython_lib", "lib hit keeps its source");
});

test("package browser host: Auto returns the surviving source when the other upstream is down", async () => {
  const { getHandler, posted } = packageSearchPanel(async (url: string) => {
    if (url.startsWith("http://api.test/v1/packages/upypi/search")) return jsonResponse({ detail: { error: "upstream_unavailable" } }, 502);
    if (url.startsWith("http://api.test/v1/packages/micropython-lib/search")) return jsonResponse({ results: [{ name: "aioble", source: "micropython_lib" }], source: "micropython_lib" });
    throw new Error(`unexpected ${url}`);
  });

  await getHandler()({ type: "package_search", source: "auto", query: "aio" });

  const result = posted.find((m) => m.type === "package_search_result");
  assert.ok(result, "one source down still returns results");
  assert.equal(posted.find((m) => m.type === "package_search_error"), undefined, "no error while one source survives");
  assert.deepEqual(result.results.map((r: any) => r.name), ["aioble"]);
});

test("package browser host: Auto errors only when BOTH live sources are down", async () => {
  const { getHandler, posted } = packageSearchPanel(async () => jsonResponse({ detail: { error: "upstream_unavailable" } }, 502));
  await getHandler()({ type: "package_search", source: "auto", query: "x" });
  assert.ok(posted.find((m) => m.type === "package_search_error"), "both down -> package_search_error");
});

test("package browser host: Auto dedups by name keeping the micropython-lib record, deterministic order", async () => {
  const { getHandler, posted } = packageSearchPanel(async (url: string) => {
    if (url.startsWith("http://api.test/v1/packages/upypi/search")) return jsonResponse({ results: [{ name: "aioble", url: "u" }, { name: "zzz", url: "u2" }], source: "upypi" });
    if (url.startsWith("http://api.test/v1/packages/micropython-lib/search")) return jsonResponse({ results: [{ name: "aioble", version: "0.6.0", source: "micropython_lib" }], source: "micropython_lib" });
    throw new Error(`unexpected ${url}`);
  });

  // query "z": prefix and alphabetical DISAGREE (alpha would be aioble,zzz), so this order
  // only holds if prefix ranking is applied.
  await getHandler()({ type: "package_search", source: "auto", query: "z" });

  const result = posted.find((m) => m.type === "package_search_result");
  const names = result.results.map((r: any) => r.name);
  assert.equal(names.filter((n: string) => n === "aioble").length, 1, "aioble appears once (deduped)");
  assert.equal(result.results.find((r: any) => r.name === "aioble").source, "micropython_lib", "the micropython-lib record wins the dedup");
  assert.deepEqual(names, ["zzz", "aioble"], "prefix-match ranks ahead of alphabetical");
});

test("package browser host: uPyPI and micropython-lib route to their own endpoints", async () => {
  const { getHandler, requested, posted } = packageSearchPanel(async (url: string) => {
    if (url.startsWith("http://api.test/v1/packages/upypi/search")) return jsonResponse({ results: [{ name: "bmp280", url: "u" }], source: "upypi" });
    if (url.startsWith("http://api.test/v1/packages/micropython-lib/search")) return jsonResponse({ results: [{ name: "aioble", source: "micropython_lib" }], source: "micropython_lib" });
    throw new Error(`unexpected ${url}`);
  });

  await getHandler()({ type: "package_search", source: "upypi", query: "bmp" });
  await getHandler()({ type: "package_search", source: "micropython_lib", query: "aio" });

  assert.ok(requested.some((u) => u.includes("/v1/packages/upypi/search?q=bmp")), "uPyPI routed to the upypi endpoint");
  assert.ok(requested.some((u) => u.includes("/v1/packages/micropython-lib/search?q=aio")), "micropython-lib routed to its endpoint");
  // Explicit-branch uPyPI hits must be tagged per-result (backend returns them untagged);
  // an untagged hit would mis-render + install by bare name.
  const upResult = posted.find((m) => m.type === "package_search_result" && m.source === "upypi");
  assert.equal(upResult.results[0].source, "upypi", "explicit uPyPI hits are tagged source:upypi");
});

test("package browser host: an upstream failure posts package_search_error, not a throw", async () => {
  const { getHandler, posted } = packageSearchPanel(async () => jsonResponse({ detail: { error: "upstream_unavailable" } }, 502));

  await getHandler()({ type: "package_search", source: "upypi", query: "x" });

  assert.ok(posted.find((m) => m.type === "package_search_error"), "a 502 degrades to package_search_error");
});

test("device_tool_list_lib lists /lib via the shim under its own command name (not list)", async () => {
  const posted: any[] = [];
  let handler: ((m: any) => Promise<void>) | undefined;
  const dirs: string[] = [];
  const panel = { webview: { cspSource: "vscode-resource:", html: "", postMessage: (m: any) => posted.push(m), onDidReceiveMessage: (n: any) => { handler = n; } } };
  const shim = { listDir: async (dir: string) => { dirs.push(dir); return ["aioble/"]; } };
  const vscode = { ViewColumn: { One: 1 }, window: { createWebviewPanel: () => panel, showWarningMessage: async () => "Cancel" } };
  createPanel(vscode, {}, { apiBaseUrl: "http://api.test", fetchImpl: async () => { throw new Error("no network"); }, shim });

  await handler!({ type: "device_tool_list_lib" });

  assert.deepEqual(dirs, ["/lib"], "lists the board's /lib");
  const res = posted.find((m) => m.type === "device_tool_result" && m.command === "list_lib");
  assert.ok(res, "result carries the distinct list_lib command, not list");
  assert.deepEqual(res.result.entries, ["aioble/"]);
});

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

test("retry_session drains the device queue before re-taking the port (lock both directions) — §41", async () => {
  const order: string[] = [];
  let releaseTool: () => void = () => {};
  const toolGate = new Promise<void>((res) => { releaseTool = res; });
  // start_session may do several LLM fetches; mark the FIRST fetch after start finishes as
  // the retry's loop pass (counting fetches is unreliable — analyze can take >1 turn).
  let startDone = false;
  let retryFetchMarked = false;
  let handler: ((message: any) => Promise<void>) | undefined;
  const panel = { webview: { cspSource: "vscode-resource:", html: "", postMessage: () => {}, onDidReceiveMessage: (n: any) => { handler = n; } } };
  const vscode = { ViewColumn: { One: 1 }, window: { createWebviewPanel: () => panel, showWarningMessage: async () => "Cancel" } };
  const fetchImpl = (async (url: string) => {
    assert.match(url, /\/v1\/llm\/messages$/);
    if (startDone && !retryFetchMarked) { retryFetchMarked = true; order.push("retry_fetch"); } // must come AFTER the tool releases
    const sse = [
      JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "ok" } }),
      JSON.stringify({ type: "message_stop" }),
    ].map((d) => `data: ${d}`).join("\n\n");
    return { ok: true, status: 200, text: async () => sse } as unknown as Response;
  }) as unknown as typeof fetch;
  // A slow device tool that holds the deviceQueue until the gate releases.
  const shim = { listDir: async () => { await toolGate; order.push("listDir_done"); return ["boot.py"]; } };

  createPanel(vscode, {}, { shim, apiBaseUrl: "http://api.test", fetchImpl });
  await handler?.({ type: "start_session", intent: "blink an led", boardId: "esp32-s3-devkitc-1" }); // seeds retry state
  startDone = true; // every fetch from here on belongs to the retry

  const toolP = handler?.({ type: "device_tool_list", path: "/" }); // acquires the queue, blocks on the gate
  const retryP = handler?.({ type: "retry_session" });             // its acquireRunOwnership must queue behind the tool
  releaseTool();
  await Promise.all([toolP, retryP]);

  // With the lock: the tool completes first, THEN the retry's loop fetch runs. Without it,
  // retry_fetch would land before listDir_done.
  assert.deepEqual(order, ["listDir_done", "retry_fetch"], "retry waited for the in-flight device tool to release the port");
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

// --- local session-log export / reveal (Support & Feedback, #25) ---

// ids are time-sortable (session-<base36 ms>-<rand>), so a lexicographically-larger id is a
// newer session. Content embeds the id so a test can tell which session was exported.
function seedSession(ws: string, id = "session-aaa111-bbb", ts = "2026-07-08T19:00:00.000Z"): string {
  const dir = join(ws, ".mpyhw", "sessions", id);
  mkdirSync(dir, { recursive: true });
  const content = `{"type":"session_started","ts":"${ts}","intent":"${id}"}\n{"type":"phase_start","phase":"analyze"}\n`;
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
    window: { createWebviewPanel: () => panel, ...windowExtra },
    ...topExtra,
  };
  createPanel(vscode, {}, { apiBaseUrl: "http://api.test", fetchImpl: (async () => { throw new Error("no network in export test"); }) as any, loopMode: "template" });
  return { posted, run: (m: any) => handler?.(m) };
}

test("export_session_log saves the NEWEST session.jsonl, not an older one (#25)", async () => {
  const ws = mkdtempSync(join(tmpdir(), "mpyhw-ws-"));
  try {
    seedSession(ws, "session-aaa111-old", "2026-07-08T10:00:00.000Z");
    const newest = seedSession(ws, "session-zzz999-new", "2026-07-08T20:00:00.000Z");
    const target = join(ws, "exported.jsonl");
    const { posted, run } = exportPanel(ws, { windowExtra: { showSaveDialog: async () => ({ fsPath: target }) } });
    await run({ type: "export_session_log" });
    assert.ok(existsSync(target), "export file written");
    assert.equal(readFileSync(target, "utf-8"), newest, "the NEWEST session's log is exported (id sorts last), not the older one");
    assert.ok(posted.some((m) => m.type === "logs_status" && /exported/i.test(m.text)), "posts an exported status");
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("export_session_log default filename is the session id without a double 'session-' prefix (#25)", async () => {
  const ws = mkdtempSync(join(tmpdir(), "mpyhw-ws-"));
  try {
    seedSession(ws, "session-aaa111-bbb");
    let defaultName: string | undefined;
    const { run } = exportPanel(ws, { windowExtra: { showSaveDialog: async (o: any) => { defaultName = o?.defaultUri?.fsPath; return undefined; } } });
    await run({ type: "export_session_log" });
    assert.ok(defaultName, "save dialog was offered a default filename");
    assert.ok(defaultName!.endsWith(join("session-aaa111-bbb.jsonl")), `default is <id>.jsonl, got ${defaultName}`);
    assert.doesNotMatch(defaultName!, /session-session-/, "no doubled 'session-' prefix");
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("export_session_log with a cancelled save dialog writes nothing and posts no status (#25)", async () => {
  const ws = mkdtempSync(join(tmpdir(), "mpyhw-ws-"));
  try {
    seedSession(ws);
    const { posted, run } = exportPanel(ws, { windowExtra: { showSaveDialog: async () => undefined } });
    await run({ type: "export_session_log" });
    assert.ok(!posted.some((m) => m.type === "logs_status"), "a cancelled dialog is a no-op: no status, no error");
    assert.ok(!posted.some((m) => m.type === "support_diagnostics_exported"), "a cancelled export records no Activity event");
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("export_session_log surfaces a real listing error instead of a misleading 'no logs' (#25 fail-fast)", async () => {
  const ws = mkdtempSync(join(tmpdir(), "mpyhw-ws-"));
  try {
    // .mpyhw/sessions is a FILE, so readdir throws ENOTDIR (not ENOENT) — must surface.
    mkdirSync(join(ws, ".mpyhw"), { recursive: true });
    writeFileSync(join(ws, ".mpyhw", "sessions"), "not a dir");
    const { posted, run } = exportPanel(ws, { windowExtra: { showSaveDialog: async () => ({ fsPath: join(ws, "x.jsonl") }) } });
    await run({ type: "export_session_log" });
    assert.ok(posted.some((m) => m.type === "logs_status" && /export failed/i.test(m.text)), "a real listing error is surfaced");
    assert.ok(!posted.some((m) => m.type === "logs_status" && /no session logs/i.test(m.text)), "must not mask a real error as 'no logs'");
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("export_session_log with no logs posts a 'no logs yet' status and writes nothing (#25)", async () => {
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

test("reveal_logs_folder reveals the .mpyhw/sessions dir when logs exist (#25)", async () => {
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

test("export_session_log falls back to globalStorage logs when no workspace is open (#25)", async () => {
  const gs = mkdtempSync(join(tmpdir(), "mpyhw-gs-"));
  try {
    const srcContent = seedSession(gs); // <gs>/.mpyhw/sessions/session-aaa111-bbb/session.jsonl
    const target = join(gs, "exported.jsonl");
    const posted: any[] = [];
    let handler: ((message: any) => Promise<void>) | undefined;
    const panel = { webview: { cspSource: "", html: "", postMessage: (m: any) => posted.push(m), onDidReceiveMessage: (n: any) => { handler = n; } } };
    const vscode = {
      ViewColumn: { One: 1 },
      Uri: { file: (p: string) => ({ fsPath: p }) },
      window: { createWebviewPanel: () => panel, showSaveDialog: async () => ({ fsPath: target }) },
      // no workspace.workspaceFolders -> sessionRoot falls back to globalStorage
    };
    createPanel(vscode, {}, { apiBaseUrl: "http://api.test", fetchImpl: (async () => { throw new Error("no network"); }) as any, loopMode: "template", globalStoragePath: gs });
    await handler?.({ type: "export_session_log" });
    assert.ok(existsSync(target), "export works with no workspace open, using the globalStorage logs root");
    assert.equal(readFileSync(target, "utf-8"), srcContent, "exported content matches the globalStorage session log");
    assert.ok(posted.some((m) => m.type === "logs_status" && /exported/i.test(m.text)));
    // A successful export records the §8.1 event once (reverting the recordSupportAction call
    // in the export success branch fails this).
    assert.equal(posted.filter((m) => m.type === "support_diagnostics_exported").length, 1, "success records support_diagnostics_exported once");
  } finally {
    rmSync(gs, { recursive: true, force: true });
  }
});

// SSE tool-call frame (mirrors protocol-build.test.ts sseTool) for driving the agent loop.
function sseToolCall(id: string, name: string, input: any): string {
  return [
    JSON.stringify({ type: "content_block_start", content_block: { type: "tool_use", id, name } }),
    JSON.stringify({ type: "content_block_delta", delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } }),
    JSON.stringify({ type: "content_block_stop" }),
    JSON.stringify({ type: "message_stop" }),
  ].map((d) => `data: ${d}`).join("\n\n");
}

test("a model-issued device rm is routed through the host confirm gate (wired into the loop)", async () => {
  const posted: any[] = [];
  let handler: ((m: any) => Promise<void>) | undefined;
  // Auto-decline the confirm the moment the host asks — proves the gate is armed, and a
  // decline means the destructive call must not run. If the panel wiring is removed the gate
  // is skipped, no confirm is posted, and removePath fires: both assertions then fail.
  const panel = {
    webview: {
      cspSource: "", html: "",
      postMessage: (m: any) => { posted.push(m); if (m.type === "file_op_confirm_needed") void handler?.({ type: "ui_prompt_response", promptId: m.promptId, answer: "ignore" }); },
      onDidReceiveMessage: (n: any) => { handler = n; },
    },
  };
  const vscode = { ViewColumn: { One: 1 }, window: { createWebviewPanel: () => panel, showWarningMessage: async () => "Cancel" } };
  const removed: string[] = [];
  const shim = { removePath: async (p: string) => { removed.push(p); } };
  let calls = 0;
  const fetchImpl = (async (url: string) => {
    assert.match(url, /\/v1\/llm\/messages$/);
    calls++;
    const sse = calls === 1
      ? sseToolCall("rm1", "device_command", { action: "rm", dst: "main.py" })
      : sseToolCall("done", "phase_complete", { result: "partial", summary: "done", next_phase: null, manifest_content: {} });
    return { ok: true, status: 200, text: async () => sse } as unknown as Response;
  }) as unknown as typeof fetch;

  createPanel(vscode, {}, { apiBaseUrl: "http://api.test", fetchImpl, shim });
  await handler?.({ type: "start_session", intent: "delete a device file", boardId: "esp32-s3-devkitc-1" });

  const confirms = posted.filter((m) => m.type === "file_op_confirm_needed" && /device:main\.py/.test(String(m.path)));
  assert.equal(confirms[0]?.op, "delete", "the panel wires the first (plain delete) confirm into the loop");
  assert.ok(!confirms.some((m) => m.op === "device_delete"), "declining the first card short-circuits before the second confirmation");
  assert.equal(removed.length, 0, "a declined confirm means removePath never runs");
});

// deliverables 07 §4 row 60: a device delete is irreversible, so it needs a SECOND confirmation
// beyond the host-file single card. Proceeding on the first card must still ask the stronger
// "device_delete" card, and the rm runs only if that second card is also proceeded.
test("a model-issued device rm asks a second confirmation; declining it leaves the file", async () => {
  const posted: any[] = [];
  let handler: ((m: any) => Promise<void>) | undefined;
  // Proceed on the plain-delete card, decline the stronger erase card. If the second gate is
  // dropped, removePath fires on the first proceed and this fails.
  const panel = {
    webview: {
      cspSource: "", html: "",
      postMessage: (m: any) => { posted.push(m); if (m.type === "file_op_confirm_needed") void handler?.({ type: "ui_prompt_response", promptId: m.promptId, answer: m.op === "device_delete" ? "ignore" : "proceed" }); },
      onDidReceiveMessage: (n: any) => { handler = n; },
    },
  };
  const vscode = { ViewColumn: { One: 1 }, window: { createWebviewPanel: () => panel, showWarningMessage: async () => "Cancel" } };
  const removed: string[] = [];
  const shim = { removePath: async (p: string) => { removed.push(p); } };
  let calls = 0;
  const fetchImpl = (async (url: string) => {
    assert.match(url, /\/v1\/llm\/messages$/);
    calls++;
    const sse = calls === 1
      ? sseToolCall("rm1", "device_command", { action: "rm", dst: "main.py" })
      : sseToolCall("done", "phase_complete", { result: "partial", summary: "done", next_phase: null, manifest_content: {} });
    return { ok: true, status: 200, text: async () => sse } as unknown as Response;
  }) as unknown as typeof fetch;

  createPanel(vscode, {}, { apiBaseUrl: "http://api.test", fetchImpl, shim });
  await handler?.({ type: "start_session", intent: "delete a device file", boardId: "esp32-s3-devkitc-1" });

  const ops = posted.filter((m) => m.type === "file_op_confirm_needed" && /device:main\.py/.test(String(m.path))).map((m) => m.op);
  assert.deepEqual(ops, ["delete", "device_delete"], "both the plain and the stronger confirmation are asked, in order");
  assert.equal(removed.length, 0, "declining the second confirmation leaves the device file intact");
});

test("a model-issued device rm deletes only after both confirmations proceed", async () => {
  const posted: any[] = [];
  let handler: ((m: any) => Promise<void>) | undefined;
  const panel = {
    webview: {
      cspSource: "", html: "",
      postMessage: (m: any) => { posted.push(m); if (m.type === "file_op_confirm_needed") void handler?.({ type: "ui_prompt_response", promptId: m.promptId, answer: "proceed" }); },
      onDidReceiveMessage: (n: any) => { handler = n; },
    },
  };
  const vscode = { ViewColumn: { One: 1 }, window: { createWebviewPanel: () => panel, showWarningMessage: async () => "Cancel" } };
  const removed: string[] = [];
  const shim = { removePath: async (p: string) => { removed.push(p); } };
  let calls = 0;
  const fetchImpl = (async (url: string) => {
    assert.match(url, /\/v1\/llm\/messages$/);
    calls++;
    const sse = calls === 1
      ? sseToolCall("rm1", "device_command", { action: "rm", dst: "main.py" })
      : sseToolCall("done", "phase_complete", { result: "partial", summary: "done", next_phase: null, manifest_content: {} });
    return { ok: true, status: 200, text: async () => sse } as unknown as Response;
  }) as unknown as typeof fetch;

  createPanel(vscode, {}, { apiBaseUrl: "http://api.test", fetchImpl, shim });
  await handler?.({ type: "start_session", intent: "delete a device file", boardId: "esp32-s3-devkitc-1" });

  const ops = posted.filter((m) => m.type === "file_op_confirm_needed" && /device:main\.py/.test(String(m.path))).map((m) => m.op);
  assert.deepEqual(ops, ["delete", "device_delete"], "both confirmations are asked before the delete");
  assert.deepEqual(removed, ["main.py"], "removePath runs once after both confirmations proceed");
});

test("a model-issued cp_from confirms on a pre-existing dest, skips the copy on decline, and does not prompt for a new dest (wired into the loop)", async () => {
  const ws = mkdtempSync(join(tmpdir(), "mpyhw-ws-"));
  try {
    // Generation is contained under <workspace>/blockless-project, which is the loop's
    // projectRoot and what the pre-build snapshot walks — the pre-existing file must live there.
    const proj = join(ws, "blockless-project");
    mkdirSync(proj, { recursive: true });
    writeFileSync(join(proj, "boot.py"), "user file"); // pre-existing host file -> snapshot records it at start
    const posted: any[] = [];
    let handler: ((m: any) => Promise<void>) | undefined;
    const panel = {
      webview: {
        cspSource: "", html: "",
        postMessage: (m: any) => { posted.push(m); if (m.type === "file_op_confirm_needed") void handler?.({ type: "ui_prompt_response", promptId: m.promptId, answer: "ignore" }); },
        onDidReceiveMessage: (n: any) => { handler = n; },
      },
    };
    const vscode = { ViewColumn: { One: 1 }, workspace: { workspaceFolders: [{ uri: { fsPath: ws } }] }, window: { createWebviewPanel: () => panel, showWarningMessage: async () => "Cancel" } };
    const copied: Array<[string, string]> = [];
    const shim = { copyFromDevice: async (src: string, dst: string) => { copied.push([src, dst]); } };
    let turn = 0;
    const fetchImpl = (async (url: string) => {
      // toolchain handshake (a workspace-backed session does this before the first turn)
      if (url.endsWith("/v1/tools")) return jsonResponse({ tools: [] });
      if (url.endsWith("/v1/skills")) return jsonResponse({ toolchain_version: "1", skills: [] });
      assert.match(url, /\/v1\/llm\/messages$/);
      turn++;
      const sse = turn === 1 ? sseToolCall("cp1", "device_command", { action: "cp_from", src: "/boot.py", dst: "boot.py" })
        : turn === 2 ? sseToolCall("cp2", "device_command", { action: "cp_from", src: "/new.py", dst: "new.py" })
          : sseToolCall("done", "phase_complete", { result: "partial", summary: "done", next_phase: null, manifest_content: {} });
      return { ok: true, status: 200, text: async () => sse } as unknown as Response;
    }) as unknown as typeof fetch;

    createPanel(vscode, {}, { apiBaseUrl: "http://api.test", fetchImpl, shim });
    await handler?.({ type: "start_session", intent: "pull device files", boardId: "esp32-s3-devkitc-1" });

    assert.ok(posted.some((m) => m.type === "file_op_confirm_needed" && m.op === "overwrite" && /boot\.py/.test(String(m.path))), "the panel wires the cp_from overwrite confirm into the loop");
    // the pre-existing dest was declined (not copied); the new dest copied with no prompt
    assert.deepEqual(copied, [["/new.py", join(proj, "new.py")]]);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("submit_issue_report validates host-side and opens a prefilled issue url", async () => {
  const posted: any[] = [];
  const opened: string[] = [];
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
    Uri: { parse: (s: string) => ({ scheme: new URL(s).protocol.replace(/:$/, ""), toString: () => s }) },
    env: { openExternal: async (u: any) => { opened.push(u.toString()); return true; } },
    window: { createWebviewPanel: () => panel, showWarningMessage: async () => "Cancel" },
  };
  createPanel(vscode, {}, { apiBaseUrl: "http://api.test", loopMode: "template" });

  // an unknown issue type is collapsed to "other" host-side — never trusted into the URL
  await handler?.({ type: "submit_issue_report", issueType: "malicious", description: "it broke", attachDiagnostics: false });
  assert.equal(opened.length, 1, "opens the prefilled issue url");
  assert.match(opened[0], /\/issues\/new\?/, "targets the github new-issue page");
  const decoded = decodeURIComponent(opened[0]);
  assert.doesNotMatch(decoded, /malicious/, "unknown type collapsed to other, never trusted into the URL");
  assert.match(decoded, /\[other\] it broke/, "type tag is the allowlisted value");

  // an empty (whitespace-only) description is rejected host-side, opens nothing
  opened.length = 0;
  await handler?.({ type: "submit_issue_report", issueType: "bug", description: "   ", attachDiagnostics: false });
  assert.equal(opened.length, 0, "empty description opens nothing");
});

test("request_diagnostics records support_diagnostics_exported with plugin vs session scope", async () => {
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

  // no session yet -> plugin scope
  await handler?.({ type: "request_diagnostics" });
  const plugin = posted.filter((m) => m.type === "support_diagnostics_exported");
  assert.equal(plugin.length, 1, "records the export event");
  assert.equal(plugin[0].scope, "plugin", "no session -> plugin scope");

  // after a session runs, session_id is set -> session scope
  await handler?.({ type: "start_session", intent: "build an env monitor", boardId: "esp32-s3-devkitc-1" });
  posted.length = 0;
  await handler?.({ type: "request_diagnostics" });
  const session = posted.filter((m) => m.type === "support_diagnostics_exported");
  assert.equal(session.length, 1);
  assert.equal(session[0].scope, "session", "after a session -> session scope");
});

test("copy_support_contact copies the config value by id, ignoring webview-supplied text", async () => {
  const posted: any[] = [];
  const copied: string[] = [];
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
    env: { clipboard: { writeText: async (t: string) => { copied.push(t); } } },
    window: { createWebviewPanel: () => panel, showWarningMessage: async () => "Cancel" },
  };
  createPanel(vscode, {}, { apiBaseUrl: "http://api.test", loopMode: "template" });

  // the webview supplies a spoofed `text`; the host must ignore it and copy the config value.
  await handler?.({ type: "copy_support_contact", contactId: "wechat", text: "attacker-controlled" });
  assert.deepEqual(copied, ["wxinliliszdyyr"], "copies the config value for the id, not the webview text");
  assert.ok(posted.some((m) => m.type === "support_feedback_opened" && m.entry === "wechat" && m.action === "copy"), "records the copy");

  copied.length = 0; posted.length = 0;
  await handler?.({ type: "copy_support_contact", contactId: "does-not-exist" });
  assert.equal(copied.length, 0, "unknown contact id copies nothing");
  assert.ok(!posted.some((m) => m.type === "support_feedback_opened"), "and records nothing");
});

test("request_diagnostics reports the shim's selected serial port", async () => {
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
  const shim = { getPort: () => "COM7", setPort() {}, scan: async () => ["COM7"] };
  createPanel(vscode, {}, { apiBaseUrl: "http://api.test", loopMode: "template", shim });

  await handler?.({ type: "request_diagnostics" });
  const diag = posted.find((m) => m.type === "diagnostics");
  assert.ok(diag, "diagnostics posted");
  // Reverting the `serial_port: shim.getPort()` merge in collectDiagnostics fails this.
  assert.equal(diag.fields.serial_port, "COM7", "serial_port reflects the shim's selected port");
});

test("open_support_panel records support_feedback_opened", async () => {
  const posted: any[] = [];
  let handler: ((message: any) => Promise<void>) | undefined;
  const panel = {
    webview: { cspSource: "vscode-resource:", html: "", postMessage: (message: any) => posted.push(message), onDidReceiveMessage: (next: any) => { handler = next; } },
  };
  const vscode = { ViewColumn: { One: 1 }, window: { createWebviewPanel: () => panel, showWarningMessage: async () => "Cancel" } };
  createPanel(vscode, {}, { apiBaseUrl: "http://api.test", loopMode: "template" });

  await handler?.({ type: "open_support_panel" });
  assert.ok(posted.some((m) => m.type === "support_feedback_opened" && m.entry === "panel"), "records the panel open");
});

test("open_external records only a support-contact url, never a partner/board link", async () => {
  const posted: any[] = [];
  let handler: ((message: any) => Promise<void>) | undefined;
  const panel = {
    webview: { cspSource: "vscode-resource:", html: "", postMessage: (message: any) => posted.push(message), onDidReceiveMessage: (next: any) => { handler = next; } },
  };
  const vscode = {
    ViewColumn: { One: 1 },
    Uri: { parse: (s: string) => ({ scheme: new URL(s).protocol.replace(/:$/, ""), toString: () => s }) },
    env: { openExternal: async () => true },
    window: { createWebviewPanel: () => panel, showWarningMessage: async () => "Cancel" },
  };
  createPanel(vscode, {}, { apiBaseUrl: "http://api.test", loopMode: "template" });

  await handler?.({ type: "open_external", url: "https://discord.gg/EPRn28fJ2" }); // a support contact url
  assert.ok(posted.some((m) => m.type === "support_feedback_opened" && m.entry === "discord"), "a support contact url records");

  posted.length = 0;
  await handler?.({ type: "open_external", url: "https://wiznet.io/" }); // a partner url, not a contact
  assert.ok(!posted.some((m) => m.type === "support_feedback_opened"), "a non-contact link records nothing");
});

test("submit_issue_report records support_feedback_opened entry report_issue", async () => {
  const posted: any[] = [];
  let handler: ((message: any) => Promise<void>) | undefined;
  const panel = {
    webview: { cspSource: "vscode-resource:", html: "", postMessage: (message: any) => posted.push(message), onDidReceiveMessage: (next: any) => { handler = next; } },
  };
  const vscode = {
    ViewColumn: { One: 1 },
    Uri: { parse: (s: string) => ({ scheme: new URL(s).protocol.replace(/:$/, ""), toString: () => s }) },
    env: { openExternal: async () => true },
    window: { createWebviewPanel: () => panel, showWarningMessage: async () => "Cancel" },
  };
  createPanel(vscode, {}, { apiBaseUrl: "http://api.test", loopMode: "template" });

  await handler?.({ type: "submit_issue_report", issueType: "bug", description: "it broke", attachDiagnostics: false });
  assert.ok(posted.some((m) => m.type === "support_feedback_opened" && m.entry === "report_issue"), "records the issue submit");
});

test("start_gen_driver gates on a source and a workspace before dispatching", async () => {
  const posted: any[] = [];
  let handler: ((message: any) => Promise<void>) | undefined;
  const panel = { webview: { cspSource: "", html: "", postMessage: (m: any) => posted.push(m), onDidReceiveMessage: (n: any) => { handler = n; } } };
  // No workspace folder and no globalStoragePath -> projectFolder is undefined.
  const vscode = { ViewColumn: { One: 1 }, workspace: { workspaceFolders: undefined }, window: { createWebviewPanel: () => panel } };
  createPanel(vscode, {}, { apiBaseUrl: "http://api.test", fetchImpl: async () => jsonResponse({}) as any, loopMode: "template" });

  // Empty sources + no driver_request -> refused up front (never reaches a run).
  await handler?.({ type: "start_gen_driver", sources: [] });
  assert.ok(posted.some((m) => m.type === "gen_driver_status" && m.status === "failed" && /Add at least one source/.test(m.detail)), "empty input is refused");

  // A valid source but no workspace -> refused (no project dir to stage into / run in). Mutation:
  // drop the !projectFolder guard -> staging/dispatch proceeds against an undefined root and this fails.
  posted.length = 0;
  await handler?.({ type: "start_gen_driver", sources: [{ type: "chip_model", metadata: { chip_model: "SHT30" } }] });
  assert.ok(posted.some((m) => m.type === "gen_driver_status" && m.status === "failed" && /workspace/.test(m.detail)), "no workspace is refused before dispatch");
});

test("start_optional_flow allowlist-maps the flow and host-gates on the generate offer (register #1)", async () => {
  const posted: any[] = [];
  let handler: ((message: any) => Promise<void>) | undefined;
  const panel = { webview: { cspSource: "", html: "", postMessage: (m: any) => posted.push(m), onDidReceiveMessage: (n: any) => { handler = n; } } };
  const vscode = { ViewColumn: { One: 1 }, workspace: { workspaceFolders: undefined }, window: { createWebviewPanel: () => panel } };
  createPanel(vscode, {}, { apiBaseUrl: "http://api.test", fetchImpl: async () => jsonResponse({}) as any, loopMode: "template" });

  // An unknown flow maps to no token -> refused (never reaches body.phase).
  await handler?.({ type: "start_optional_flow", flow: "bogus" });
  assert.ok(posted.some((m) => m.type === "optional_flow_status" && m.status === "failed" && /Unknown/.test(m.detail)), "unmapped flow is refused");

  // A valid flow that generate never offered -> the HOST re-checks the offer and refuses, even though a
  // crafted message could bypass the webview button gate. Mutation: drop the getOptionalNextPhases gate
  // -> an unoffered wiring run dispatches and this fails.
  posted.length = 0;
  await handler?.({ type: "start_optional_flow", flow: "wiring" });
  assert.ok(posted.some((m) => m.type === "optional_flow_status" && m.status === "failed" && /Run generate first/.test(m.detail)), "an unoffered flow is host-refused");
});
