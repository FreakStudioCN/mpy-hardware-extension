import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createPanel, createViewProvider, isSnapshotSelfPath, parseGitStatusRow } from "../src/webview/panel.ts";
import { gitCommit, gitHasStagedChanges } from "../src/extension/project-git.ts";
import { buildSessionSnapshot, writeSessionSnapshot } from "../src/extension/session-snapshot.ts";

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

test("flash serial_port repoints the shim only on a flash_now answer, not on cancel", async () => {
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
    scan: async () => ["COM3", "COM9"],
    setPort: (port: string | null) => selectedPorts.push(port),
  };
  const vscode = {
    ViewColumn: { One: 1 },
    window: { createWebviewPanel: () => panel, showWarningMessage: async () => "Cancel" },
  };

  createPanel(vscode, {}, { apiBaseUrl: "http://api.test", fetchImpl: async () => { throw new Error("no network expected"); }, shim });
  // A cancelled flash card can still carry serial_port; it must NOT repoint the shim.
  await handler?.({ type: "ui_prompt_response", promptId: "flash-1", answer: "cancel", serial_port: "COM3" });
  await handler?.({ type: "ui_prompt_response", promptId: "flash-2", answer: "flash_now", serial_port: "COM9" });

  assert.deepEqual(selectedPorts, ["COM9"]);
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

test("device tools uninstall is host-armed: a bare message only arms; the echoed nonce uninstalls once; a replay can't re-run (PR #45 review, checklist #1)", async () => {
  const ws = mkdtempSync(join(tmpdir(), "mpyhw-ws-"));
  try {
    const posted: any[] = [];
    let handler: ((message: any) => Promise<void>) | undefined;
    const panel = { webview: { cspSource: "", html: "", postMessage: (m: any) => posted.push(m), onDidReceiveMessage: (n: any) => { handler = n; } } };
    const vscode = { ViewColumn: { One: 1 }, workspace: { workspaceFolders: [{ uri: { fsPath: ws } }] }, window: { createWebviewPanel: () => panel } };
    const uninstalled: string[] = [];
    const shim = { uninstallPackage: async (name: string) => { uninstalled.push(name); return true; } };
    const fetchImpl = (async () => { throw new Error("no api"); }) as unknown as typeof fetch;
    createPanel(vscode, {}, { shim, apiBaseUrl: "http://api.test", fetchImpl, loopMode: "template" });

    // 1) Bare uninstall = arm only (the stale/duplicate/crafted case): nothing removed; host issues a nonce.
    await handler!({ type: "device_tool_uninstall", name: "aioble" });
    assert.equal(uninstalled.length, 0, "a bare uninstall does not remove — it only arms");
    const armed = posted.find((m) => m.type === "device_tool_uninstall_armed" && m.name === "aioble");
    assert.ok(armed && armed.nonce, "host posts an arm carrying a one-shot nonce");

    // 2) A message with the WRONG nonce still only re-arms, never uninstalls.
    await handler!({ type: "device_tool_uninstall", name: "aioble", nonce: "not-the-nonce" });
    assert.equal(uninstalled.length, 0, "a mismatched nonce cannot uninstall");

    // 3) Echo the current nonce -> the uninstall happens exactly once. (Step 2 re-armed; use the latest.)
    const latest = posted.filter((m) => m.type === "device_tool_uninstall_armed").at(-1);
    await handler!({ type: "device_tool_uninstall", name: "aioble", nonce: latest.nonce });
    assert.deepEqual(uninstalled, ["aioble"], "the confirm with the host nonce uninstalls exactly once");

    // 4) Replay the consumed nonce -> no second uninstall (re-arms instead).
    await handler!({ type: "device_tool_uninstall", name: "aioble", nonce: latest.nonce });
    assert.deepEqual(uninstalled, ["aioble"], "a replayed nonce cannot uninstall again");

    // 5) A nonce armed for a DIFFERENT package cannot uninstall this one.
    await handler!({ type: "device_tool_uninstall", name: "umqtt" }); // arm umqtt
    const umqttArm = posted.filter((m) => m.type === "device_tool_uninstall_armed" && m.name === "umqtt").at(-1);
    await handler!({ type: "device_tool_uninstall", name: "aioble", nonce: umqttArm.nonce });
    assert.deepEqual(uninstalled, ["aioble"], "a nonce armed for umqtt cannot uninstall aioble");
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

test("device_presence: a fresh install (ABSENT venv) offers environment setup, without touching the shim", async () => {
  const posted: any[] = [];
  let handler: ((message: any) => Promise<void>) | undefined;
  const panel = { webview: { cspSource: "", html: "", postMessage: (m: any) => posted.push(m), onDidReceiveMessage: (n: any) => { handler = n; } } };
  const vscode = { ViewColumn: { One: 1 }, workspace: { workspaceFolders: [] }, window: { createWebviewPanel: () => panel } };
  let scanned = 0;
  const shim = { scan: async () => { scanned++; return ["/dev/ttyX"]; }, setPort: () => {}, kill: () => {} };
  // A real first run: the venv was NEVER set up (venvExists false). The presence poll used to
  // bootstrap it via shim.scan(); gating the poll dropped that, so an absent venv must surface a
  // "set up environment" affordance instead of hiding the board forever.
  createPanel(vscode, {}, { shim, venvReady: () => false, venvExists: () => false, apiBaseUrl: "http://api.test", loopMode: "template" });

  await handler!({ type: "device_presence" });

  assert.equal(scanned, 0, "a not-ready venv must not trigger shim.scan()");
  const msg = posted.filter((m) => m.type === "device_present").pop();
  assert.equal(msg?.present, false);
  assert.equal(msg?.needsEnvSetup, true, "an ABSENT venv surfaces the set-up-environment affordance");
});

test("device_presence: a present-but-broken venv stays silent (no env-setup affordance; the Doctor recovers it)", async () => {
  const posted: any[] = [];
  let handler: ((message: any) => Promise<void>) | undefined;
  const panel = { webview: { cspSource: "", html: "", postMessage: (m: any) => posted.push(m), onDidReceiveMessage: (n: any) => { handler = n; } } };
  const vscode = { ViewColumn: { One: 1 }, workspace: { workspaceFolders: [] }, window: { createWebviewPanel: () => panel } };
  let scanned = 0;
  const shim = { scan: async () => { scanned++; return ["/dev/ttyX"]; }, setPort: () => {}, kill: () => {} };
  // The venv EXISTS but its imports are broken (venvReady false, venvExists true): don't nag with a
  // setup affordance -- that's the Doctor Re-check's job. Just report no device, don't scan.
  createPanel(vscode, {}, { shim, venvReady: () => false, venvExists: () => true, apiBaseUrl: "http://api.test", loopMode: "template" });

  await handler!({ type: "device_presence" });

  assert.equal(scanned, 0, "a broken venv must not trigger shim.scan() either");
  const msg = posted.filter((m) => m.type === "device_present").pop();
  assert.equal(msg?.present, false);
  assert.equal(msg?.needsEnvSetup, false, "a broken (present) venv stays silent — recovery is the Doctor's job");
});

test("device_presence: a broken venv probes once per backoff window, not on every 2.5s tick", async () => {
  const posted: any[] = [];
  let handler: ((message: any) => Promise<void>) | undefined;
  const panel = { webview: { cspSource: "", html: "", postMessage: (m: any) => posted.push(m), onDidReceiveMessage: (n: any) => { handler = n; } } };
  const vscode = { ViewColumn: { One: 1 }, workspace: { workspaceFolders: [] }, window: { createWebviewPanel: () => panel } };
  let scanned = 0;
  let probes = 0;
  const shim = { scan: async () => { scanned++; return ["/dev/ttyX"]; }, setPort: () => {}, kill: () => {} };
  // venvReadyFn is a SYNCHRONOUS python spawn on the extension host: a broken venv returning
  // false must not re-spawn it on every poll tick (that repeatedly blocks the host). The poll
  // backs off between not-ready probes; three immediate ticks land inside one window.
  createPanel(vscode, {}, { shim, venvReady: () => { probes++; return false; }, venvExists: () => true, apiBaseUrl: "http://api.test", loopMode: "template" });

  await handler!({ type: "device_presence" });
  await handler!({ type: "device_presence" });
  await handler!({ type: "device_presence" });

  assert.equal(probes, 1, "a not-ready probe backs off instead of re-spawning python per tick");
  assert.equal(scanned, 0, "the shim is never scanned while the venv is not ready");
  const msg = posted.filter((m) => m.type === "device_present").pop();
  assert.equal(msg?.present, false, "backed-off ticks still answer the poll (as no-device)");
});

test("device_presence scans and reports the device once the venv is ready", async () => {
  const posted: any[] = [];
  let handler: ((message: any) => Promise<void>) | undefined;
  const panel = { webview: { cspSource: "", html: "", postMessage: (m: any) => posted.push(m), onDidReceiveMessage: (n: any) => { handler = n; } } };
  const vscode = { ViewColumn: { One: 1 }, workspace: { workspaceFolders: [] }, window: { createWebviewPanel: () => panel } };
  let scanned = 0;
  const shim = { scan: async () => { scanned++; return ["/dev/ttyX"]; }, setPort: () => {}, kill: () => {} };
  createPanel(vscode, {}, { shim, venvReady: () => true, apiBaseUrl: "http://api.test", loopMode: "template" });

  await handler!({ type: "device_presence" });

  assert.equal(scanned, 1, "a ready venv scans normally");
  assert.equal(posted.filter((m) => m.type === "device_present").pop()?.present, true);
});

test("device_presence probes venvReady once then memoizes it on the hot poll path", async () => {
  const posted: any[] = [];
  let handler: ((message: any) => Promise<void>) | undefined;
  const panel = { webview: { cspSource: "", html: "", postMessage: (m: any) => posted.push(m), onDidReceiveMessage: (n: any) => { handler = n; } } };
  const vscode = { ViewColumn: { One: 1 }, workspace: { workspaceFolders: [] }, window: { createWebviewPanel: () => panel } };
  let probes = 0;
  let scanned = 0;
  const shim = { scan: async () => { scanned++; return ["/dev/ttyX"]; }, setPort: () => {}, kill: () => {} };
  createPanel(vscode, {}, { shim, venvReady: () => { probes++; return true; }, apiBaseUrl: "http://api.test", loopMode: "template" });

  // The poll fires every 2.5s; venvReady() is a synchronous multi-import python spawn, so
  // once it confirms ready the hot path must not re-probe it.
  await handler!({ type: "device_presence" });
  await handler!({ type: "device_presence" });
  await handler!({ type: "device_presence" });

  assert.equal(probes, 1, "venvReady is probed once, then the confirmed-ready result is memoized");
  assert.equal(scanned, 3, "every tick still scans for presence");
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

test("package browser host: mergePackages invariants hold over generated hit lists (property test)", async () => {
  // Hand-rolled property test (no fast-check dep): drive the Auto merge with many random lib/uPyPI
  // hit lists and assert the invariants example tests can't span -- a killed rank()/dedup/cap/sort
  // currently fails only a single hand-picked fixture.
  const norm = (n: string) => String(n || "").toLowerCase().replace(/[-_]/g, "_");
  const POOL = ["aio", "aioble", "a-b", "a_b", "AIO", "bmp280", "bmp-280", "umqtt", "zzz", "Zzz", "req"];
  let rngState = 0x2545f491; // fixed seed -> deterministic run (no Math.random)
  const rnd = () => { rngState = (rngState * 1103515245 + 12345) & 0x7fffffff; return rngState / 0x7fffffff; };
  const pick = () => POOL[Math.floor(rnd() * POOL.length)];
  const sampleNames = () => Array.from({ length: Math.floor(rnd() * 6) }, pick);

  let curLib: any[] = [], curUpypi: any[] = [];
  const { getHandler, posted } = packageSearchPanel(async (url: string) => {
    if (url.includes("/upypi/search")) return jsonResponse({ results: curUpypi });
    if (url.includes("/micropython-lib/search")) return jsonResponse({ results: curLib });
    throw new Error(`unexpected ${url}`);
  });

  const QUERIES = ["a", "bmp", "z", ""];
  for (let i = 0; i < 60; i++) {
    curLib = sampleNames().map((name) => ({ name, version: "1", source: "micropython_lib" }));
    curUpypi = sampleNames().map((name) => ({ name, url: "u" })); // uPyPI shape: name+url; host tags source
    const query = QUERIES[i % QUERIES.length];
    posted.length = 0;
    await getHandler()({ type: "package_search", source: "auto", query });
    const out: any[] = posted.find((m) => m.type === "package_search_result").results;
    const keys = out.map((r) => norm(r.name));

    // (a) dedup: no two outputs share a normalized name.
    assert.equal(new Set(keys).size, keys.length, `iter ${i} (q=${query}): outputs deduped by normalized name`);
    // (b) a name present in BOTH sources keeps the micropython_lib record.
    const libKeys = new Set(curLib.map((h) => norm(h.name)));
    const upypiKeys = new Set(curUpypi.map((h) => norm(h.name)));
    for (const r of out) {
      if (libKeys.has(norm(r.name)) && upypiKeys.has(norm(r.name))) {
        assert.equal(r.source, "micropython_lib", `iter ${i}: a name in both sources keeps the lib record`);
      }
    }
    // (c) capped at AUTO_RESULT_LIMIT.
    assert.ok(out.length <= 30, `iter ${i}: capped at 30`);
    // (d) deterministic: identical inputs reproduce the same order.
    posted.length = 0;
    await getHandler()({ type: "package_search", source: "auto", query });
    assert.deepEqual(posted.find((m) => m.type === "package_search_result").results.map((r: any) => norm(r.name)), keys, `iter ${i}: order is deterministic`);
    // (e) prefix matches sort before non-prefix (non-empty query).
    if (query) {
      let seenNonPrefix = false;
      for (const r of out) {
        if (r.name.toLowerCase().startsWith(query)) assert.ok(!seenNonPrefix, `iter ${i}: a prefix match must not follow a non-prefix one`);
        else seenNonPrefix = true;
      }
    }
  }

  // (c) explicit cap: the random pool is too small to ever exceed 30, so force it -- 50 distinct
  // names must return exactly AUTO_RESULT_LIMIT (30).
  curLib = Array.from({ length: 50 }, (_, k) => ({ name: `pkg${String(k).padStart(2, "0")}`, version: "1", source: "micropython_lib" }));
  curUpypi = [];
  posted.length = 0;
  await getHandler()({ type: "package_search", source: "auto", query: "pkg" });
  assert.equal(posted.find((m) => m.type === "package_search_result").results.length, 30, "50 distinct names cap to AUTO_RESULT_LIMIT (30)");
});

test("package browser host: a non-string micropython-lib name is coerced, not crashing the merge (PR #45 minor)", async () => {
  // libHits reach mergePackages un-tagged (unlike tagUpypi'd uPyPI hits); a non-string name must
  // be coerced on the survivor, or the sort's toLowerCase() throws. Reverting the String() coerce
  // makes this throw instead of returning "42".
  const { getHandler, posted } = packageSearchPanel(async (url: string) => {
    if (url.includes("/micropython-lib/search")) return jsonResponse({ results: [{ name: 42, version: 1, source: "micropython_lib" }] });
    if (url.includes("/upypi/search")) return jsonResponse({ results: [] });
    throw new Error(`unexpected ${url}`);
  });
  await getHandler()({ type: "package_search", source: "auto", query: "4" });
  const res = posted.find((m) => m.type === "package_search_result");
  assert.ok(res, "the merge did not throw on a non-string lib name");
  assert.equal(res.results[0].name, "42", "the lib name is coerced to a string");
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

  const err = posted.find((m) => m.type === "package_search_error");
  assert.ok(err, "a 502 degrades to package_search_error");
  // The error must echo source+query so the webview can drop a stale failure the same way it
  // drops a stale result (PR #45 review: error responses were uncorrelated).
  assert.equal(err.source, "upypi", "the error echoes its source for correlation");
  assert.equal(err.query, "x", "the error echoes its query for correlation");
});

test("package browser host: a resolve failure echoes the url for correlation (PR #45 review)", async () => {
  const { getHandler, posted } = packageSearchPanel(async () => jsonResponse({ detail: { error: "upstream_unavailable" } }, 502));

  await getHandler()({ type: "package_resolve", url: "https://upypi.net/pkgs/aaa/1.0.0" });

  const err = posted.find((m) => m.type === "package_resolve_error");
  assert.ok(err, "a failed resolve posts package_resolve_error");
  assert.equal(err.url, "https://upypi.net/pkgs/aaa/1.0.0", "the error echoes the url so a stale one is dropped");
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

// ----- Welcome-page project entry: session import vs folder open (#88 slice 1) -----

test("open_project_folder opens a FOLDER picker then vscode.openFolder (the folder-open action, now its own entry)", async () => {
  const ws = mkdtempSync(join(tmpdir(), "mpyhw-ws-"));
  try {
    let handler: any; const opened: any[] = []; let dialogOpts: any;
    const panel = { webview: { cspSource: "", html: "", postMessage: () => {}, onDidReceiveMessage: (n: any) => { handler = n; } } };
    const vscode = {
      ViewColumn: { One: 1 }, workspace: { workspaceFolders: [{ uri: { fsPath: ws } }] },
      window: { createWebviewPanel: () => panel, showOpenDialog: async (o: any) => { dialogOpts = o; return [{ fsPath: join(ws, "picked") }]; } },
      commands: { executeCommand: async (cmd: string, arg: any) => { opened.push({ cmd, path: arg?.fsPath }); } },
    };
    createPanel(vscode, {}, { apiBaseUrl: "http://api.test", fetchImpl: async () => jsonResponse({}) as any });
    await handler({ type: "open_project_folder" });
    assert.equal(dialogOpts?.canSelectFolders, true, "picks a FOLDER");
    assert.equal(dialogOpts?.canSelectFiles, false, "not a file picker");
    assert.deepEqual(opened, [{ cmd: "vscode.openFolder", path: join(ws, "picked") }], "opens the picked folder as the workspace");
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test("import_session picks a session folder and RESTORES from it, but never vscode.openFolder (the reported bug)", async () => {
  const ws = mkdtempSync(join(tmpdir(), "mpyhw-ws-"));
  try {
    let handler: any; let dialogOpts: any; const commands: string[] = []; const infos: string[] = [];
    const panel = { webview: { cspSource: "", html: "", postMessage: () => {}, onDidReceiveMessage: (n: any) => { handler = n; } } };
    const vscode = {
      ViewColumn: { One: 1 }, workspace: { workspaceFolders: [{ uri: { fsPath: ws } }] },
      window: {
        createWebviewPanel: () => panel,
        showOpenDialog: async (o: any) => { dialogOpts = o; return [{ fsPath: ws }]; }, // pick a folder that has no snapshot
        showInformationMessage: async (m: string) => { infos.push(m); }, showErrorMessage: async () => {},
      },
      commands: { executeCommand: async (cmd: string) => { commands.push(cmd); } },
    };
    createPanel(vscode, {}, { apiBaseUrl: "http://api.test", fetchImpl: async () => jsonResponse({}) as any });
    await handler({ type: "import_session" });
    assert.equal(dialogOpts?.canSelectFolders, true, "prompts for a session FOLDER");
    // The core of the fix: Import restores; it must NOT open the folder as the workspace (that was the bug).
    assert.ok(!commands.includes("vscode.openFolder"), "import_session does NOT vscode.openFolder");
    // The picked folder has no snapshot -> it routes to restore, which degrades with an informative notice.
    assert.ok(infos.some((m) => /no saved snapshot|predates/i.test(m)), "routes to restore (no snapshot here -> informs), not folder-open");
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

function restorePanel(ws: string) {
  const posted: any[] = []; const infos: string[] = []; const errors: string[] = [];
  let handler: ((m: any) => Promise<void>) | undefined;
  const panel = { webview: { cspSource: "", html: "", postMessage: (m: any) => posted.push(m), onDidReceiveMessage: (n: any) => { handler = n; } } };
  const vscode = {
    ViewColumn: { One: 1 }, workspace: { workspaceFolders: [{ uri: { fsPath: ws } }] },
    window: { createWebviewPanel: () => panel, showInformationMessage: async (m: string) => { infos.push(m); }, showErrorMessage: async (m: string) => { errors.push(m); } },
  };
  createPanel(vscode, {}, { apiBaseUrl: "http://api.test", fetchImpl: async () => jsonResponse({}) as any });
  return { handler: handler!, posted, infos, errors };
}

test("restore_session rehydrates the tabs from a saved snapshot (wiring/diagram/sha-verified code) and confirms", async () => {
  const ws = mkdtempSync(join(tmpdir(), "mpyhw-restore-"));
  try {
    const { handler, posted, infos } = restorePanel(ws);
    const sid = "sess-1";
    mkdirSync(join(ws, "blockless-project"), { recursive: true });
    const codeBytes = Buffer.from("print('restored')\n");
    writeFileSync(join(ws, "blockless-project", "main.py"), codeBytes);
    const snap = buildSessionSnapshot({
      traceId: sid, savedAt: "2026-07-23T00:00:00.000Z", currentPhase: "generate", terminal: "complete",
      state: { manifest: { devices: [] }, phase: "generate", intent: "blink red" },
      boardId: "esp32", preSelectedBoard: { id: "esp32", display_name: "ESP32" }, boardSelectionMode: "recommend",
      preferences: { mode: "beginner", locale: "en", existing_hardware: "none" },
      manifest: { devices: [{ pin: 1 }] }, diagram: { nodes: ["led"] }, credits: null, diagnostics: {},
      artifacts: [{ relative_path: "blockless-project/main.py", kind: "code", role: "", phase: "generate", size: codeBytes.length, sha256: createHash("sha256").update(codeBytes).digest("hex"), created_at: "2026-07-23T00:00:00.000Z" }],
      git: null,
    });
    await writeSessionSnapshot(join(ws, ".mpyhw", "sessions", sid), snap);
    posted.length = 0; infos.length = 0;
    await handler({ type: "restore_session", id: sid });
    assert.ok(posted.some((m) => m.type === "manifest_updated"), "wiring/manifest replayed");
    assert.ok(posted.some((m) => m.type === "diagram_updated"), "diagram replayed");
    const code = posted.find((m) => m.type === "code_updated");
    assert.ok(code && /restored/.test(code.code), "code content replayed from disk after sha256 verify");
    // D1: the artifacts tab is rehydrated from the restored session's tree (the file on disk).
    assert.ok(posted.some((m) => m.type === "artifacts_index" && (m.artifacts || []).some((a: any) => /main\.py/.test(a.relative_path))), "artifacts tab rehydrated for the restored session");
    assert.ok(infos.some((m) => /Restored/.test(m)), "a restore confirmation is shown");
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test("restore_session skips a code file whose on-disk sha256 no longer matches the snapshot (no stale replay)", async () => {
  const ws = mkdtempSync(join(tmpdir(), "mpyhw-restore-"));
  try {
    const { handler, posted } = restorePanel(ws);
    const sid = "sess-2";
    mkdirSync(join(ws, "blockless-project"), { recursive: true });
    writeFileSync(join(ws, "blockless-project", "main.py"), "print('CHANGED since save')\n"); // on-disk content differs
    const snap = buildSessionSnapshot({
      traceId: sid, savedAt: "2026-07-23T00:00:00.000Z", currentPhase: "generate", terminal: null,
      state: { manifest: {}, phase: "generate", intent: "x" }, boardId: "esp32", preSelectedBoard: null, boardSelectionMode: undefined,
      preferences: undefined, manifest: {}, diagram: null, credits: null, diagnostics: {},
      artifacts: [{ relative_path: "blockless-project/main.py", kind: "code", role: "", phase: "generate", size: 10, sha256: "0".repeat(64), created_at: "2026-07-23T00:00:00.000Z" }],
      git: null,
    });
    await writeSessionSnapshot(join(ws, ".mpyhw", "sessions", sid), snap);
    posted.length = 0;
    await handler({ type: "restore_session", id: sid });
    assert.ok(!posted.some((m) => m.type === "code_updated"), "a changed-on-disk file is NOT replayed (sha mismatch)");
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test("restore_session on a session with NO snapshot degrades (informs, no rehydration)", async () => {
  const ws = mkdtempSync(join(tmpdir(), "mpyhw-restore-"));
  try {
    const { handler, posted, infos } = restorePanel(ws);
    await handler({ type: "restore_session", id: "never-saved" });
    assert.ok(infos.some((m) => /no saved snapshot|predates/i.test(m)), "informs there is nothing to restore");
    assert.ok(!posted.some((m) => m.type === "manifest_updated" || m.type === "code_updated"), "no rehydration for a snapshot-less session");
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test("restore_session refetches the LIVE credit balance (the snapshot's credits are advisory)", async () => {
  const ws = mkdtempSync(join(tmpdir(), "mpyhw-restore-"));
  try {
    const posted: any[] = []; let handler: any;
    const panel = { webview: { cspSource: "", html: "", postMessage: (m: any) => posted.push(m), onDidReceiveMessage: (n: any) => { handler = n; } } };
    const vscode = {
      ViewColumn: { One: 1 }, workspace: { workspaceFolders: [{ uri: { fsPath: ws } }] },
      window: { createWebviewPanel: () => panel, showInformationMessage: async () => {}, showErrorMessage: async () => {} },
      authentication: { getSession: async () => ({ accessToken: "gho-token" }) },
    };
    const fetchImpl = (async (url: string) => {
      if (url === "http://api.test/v1/auth/github") return jsonResponse({ token: "jwt-123" });
      if (url === "http://api.test/v1/credits") return jsonResponse({ balance: 42, daily_grant: 100, resets_at: "2026-07-08T00:00:00.000Z" });
      return jsonResponse({});
    }) as unknown as typeof fetch;
    createPanel(vscode, {}, { apiBaseUrl: "http://api.test", fetchImpl });
    const sid = "sess-cred";
    const snap = buildSessionSnapshot({
      traceId: sid, savedAt: "2026-07-23T00:00:00.000Z", currentPhase: null, terminal: null,
      state: { manifest: {}, phase: "generate", intent: "x" }, boardId: "esp32", preSelectedBoard: null, boardSelectionMode: undefined,
      preferences: undefined, manifest: {}, diagram: null,
      credits: { balance: 1, dailyGrant: 1, resetsAt: "stale", capturedAt: "stale" }, diagnostics: {}, artifacts: [], git: null,
    });
    await writeSessionSnapshot(join(ws, ".mpyhw", "sessions", sid), snap);
    posted.length = 0;
    await handler({ type: "restore_session", id: sid });
    const credits = posted.find((m) => m.type === "session_event" && m.event?.kind === "credits");
    assert.ok(credits, "restore refetches credits");
    assert.equal(credits.event.balance, 42, "shows the LIVE balance (42), not the snapshot's advisory 1");
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

// ----- Save Version (#95) real-git panel tests -----
// Drive a template-mode session so the controller has state + the project folder is a real
// git repo (ensureProjectGitRepo runs on start_session). Reuses the file's jsonResponse/
// aht20Context/board fixtures.
async function startTemplateSession(ws: string) {
  const posted: any[] = [];
  let handler: ((message: any) => Promise<void>) | undefined;
  const panel = { webview: { cspSource: "vscode-resource:", html: "", postMessage: (m: any) => posted.push(m), onDidReceiveMessage: (n: any) => { handler = n; } } };
  const vscode = {
    ViewColumn: { One: 1 },
    workspace: { workspaceFolders: [{ uri: { fsPath: ws } }] },
    window: { createWebviewPanel: () => panel, showWarningMessage: async () => "Cancel" },
  };
  const fetchImpl = (async (url: string) => {
    if (url === "http://api.test/v1/tools") return jsonResponse({ tools: [] });
    if (url === "http://api.test/v1/skills") return jsonResponse({ toolchain_version: "1", skills: [] });
    if (url === "http://api.test/v1/packages/resolve") return jsonResponse({ selected: { name: "aht20_driver", version: "1.0.0" }, candidates: [], needs_user_choice: false, questions: [] });
    if (url === "http://api.test/v1/packages/aht20_driver/1.0.0/driver-context") return jsonResponse(aht20Context());
    if (url === "http://api.test/v1/boards/esp32-s3-devkitc-1") return jsonResponse(board());
    throw new Error(`unexpected URL ${url}`);
  }) as unknown as typeof fetch;
  createPanel(vscode, {}, { apiBaseUrl: "http://api.test", fetchImpl, loopMode: "template" });
  await handler!({ type: "start_session", intent: "超过30度亮红灯", boardId: "esp32-s3-devkitc-1" });
  return { handler: handler!, posted, projectFolder: join(ws, "blockless-project") };
}

test("parseGitStatusRow maps every porcelain XY to a kind + letter, with the XY code stripped", () => {
  const cases: Array<[string, string, string, string]> = [
    ["?? .flake8", ".flake8", "new", "U"],
    [" M main.py", "main.py", "modified", "M"],
    ["M  staged.py", "staged.py", "modified", "M"],
    ["MM both.py", "both.py", "modified", "M"],
    ["A  added.py", "added.py", "added", "A"],
    ["AM addmod.py", "addmod.py", "added", "A"],   // A checked before M
    [" D gone.py", "gone.py", "deleted", "D"],
    ["R  old.py -> new.py", "old.py -> new.py", "renamed", "R"],
    ["T  typed.py", "typed.py", "changed", "•"], // typechange -> fallback bullet
  ];
  for (const [line, name, status, badge] of cases) {
    const row = parseGitStatusRow(line, 0);
    assert.equal(row.name, name, `path for "${line}"`);
    assert.equal(row.status, status, `status for "${line}"`);
    assert.equal(row.badge, badge, `badge for "${line}"`);
    assert.ok(!/^[ ?ADMRTC]{2}\s/.test(row.name), `no XY code left in "${row.name}"`);
  }
});

test("parseGitStatusRow flags STAGED rows by the index (first) column", () => {
  assert.equal(parseGitStatusRow("M  staged.py", 0).staged, true, "index-column M = staged");
  assert.equal(parseGitStatusRow("A  added.py", 0).staged, true, "index-column A = staged");
  assert.equal(parseGitStatusRow("MM both.py", 0).staged, true, "staged + reworktree change is staged");
  assert.equal(parseGitStatusRow(" M main.py", 0).staged, false, "worktree-only modification is not staged");
  assert.equal(parseGitStatusRow("?? new.py", 0).staged, false, "untracked is not staged");
});

function findSnapshot(ws: string): any | null {
  const base = join(ws, ".mpyhw", "sessions");
  if (!existsSync(base)) return null;
  for (const id of readdirSync(base)) {
    const p = join(base, id, "checkpoints", "snapshot.json");
    if (existsSync(p)) return JSON.parse(readFileSync(p, "utf-8"));
  }
  return null;
}

test("save_version_open posts the summary with parsed file rows (status kind + letter, clean path)", async () => {
  const ws = mkdtempSync(join(tmpdir(), "mpyhw-sv-"));
  try {
    const { handler, posted, projectFolder } = await startTemplateSession(ws);
    writeFileSync(join(projectFolder, "extra.txt"), "change");
    posted.length = 0;
    await handler({ type: "save_version_open" });
    const data = posted.find((m) => m.type === "save_version_data");
    assert.ok(data, "opening posts save_version_data");
    assert.equal(data.canCommit, true, "a git repo can commit");
    const f = (data.files as any[]).find((it) => it.name === "extra.txt");
    assert.ok(f && f.status === "new" && f.badge === "U", "an untracked file parses to status 'new' + badge 'U'");
    assert.ok(!(data.files as any[]).some((it) => String(it.name).startsWith("?? ")), "no path carries the raw XY porcelain code");
    // The card must cover more than files (§3.6.3): the host also sends the resume/session
    // state, the phase-associated artifacts (list + true total), and the diagnostics — all local.
    // Assert the exact subfield keys the webview reads, not just container shape — a host-side
    // rename would otherwise render an empty row while both tests stay green (contract drift).
    assert.ok(data.session && "intent" in data.session && "phase" in data.session && "board" in data.session && "mode" in data.session, "session carries the fields the panel renders");
    assert.ok(Array.isArray(data.artifacts) && typeof data.artifactTotal === "number", "payload carries the artifact list + total");
    assert.ok(data.diagnostics && "activity" in data.diagnostics && "errors" in data.diagnostics && "session_id" in data.diagnostics, "diagnostics carries the fields the panel renders");
    // Opening alone writes nothing — no commit, no snapshot.
    assert.equal(findSnapshot(ws), null, "opening the panel writes no snapshot");
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test("save_version_open: a CJK filename shows as raw UTF-8, not octal-escaped (core.quotepath=false)", async () => {
  const ws = mkdtempSync(join(tmpdir(), "mpyhw-sv-"));
  try {
    const { handler, posted, projectFolder } = await startTemplateSession(ws);
    writeFileSync(join(projectFolder, "温度.py"), "x"); // untracked CJK-named file (the primary audience)
    posted.length = 0;
    await handler({ type: "save_version_open" });
    const names = ((posted.find((m) => m.type === "save_version_data")!.files) as any[]).map((f) => f.name);
    assert.ok(names.includes("温度.py"), "the CJK filename is raw UTF-8, not git's octal-escaped form");
    assert.ok(!names.some((n) => /\\\d{3}/.test(n)), "no path carries backslash-octal escapes");
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test("save_version_commit commits in a git repo and posts the real new HEAD hash + user message", async () => {
  const ws = mkdtempSync(join(tmpdir(), "mpyhw-sv-"));
  try {
    const { handler, posted, projectFolder } = await startTemplateSession(ws);
    writeFileSync(join(projectFolder, "extra.txt"), "guaranteed change");
    posted.length = 0;
    await handler({ type: "save_version_commit", message: "test: save version" });
    const head = execFileSync("git", ["-C", projectFolder, "rev-parse", "HEAD"], { windowsHide: true }).toString().trim();
    const status = posted.find((m) => m.type === "save_version_status");
    assert.equal(status?.status, "saved_commit");
    assert.equal(status?.hash, head, "the posted hash is the real new HEAD (kills a fake/fixed-hash return)");
    assert.equal(findSnapshot(ws)?.git?.commit_hash, head, "one save = one restorable point: the snapshot records the commit hash");
    const subject = execFileSync("git", ["-C", projectFolder, "log", "-1", "--format=%s"], { windowsHide: true }).toString().trim();
    assert.equal(subject, "test: save version", "git committed the user-edited message (kills dropping message)");
    // Post-commit refresh: an add -A commit cleaned the tree, so the status carries an empty list
    // (no longer showing the just-committed extra.txt as pending).
    assert.deepEqual(status?.files, [], "the saved_commit status refreshes the file list to the clean post-commit tree");
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test("save_version: two concurrent commit acts are serialized — only one commit lands (in-flight guard)", async () => {
  const ws = mkdtempSync(join(tmpdir(), "mpyhw-sv-"));
  try {
    const { handler, posted, projectFolder } = await startTemplateSession(ws);
    writeFileSync(join(projectFolder, "extra.txt"), "change");
    posted.length = 0;
    // Two acts fired together (e.g. a double-click that beat the webview's own disable): saveInFlight
    // lets exactly one through; the second returns early with no commit.
    await Promise.all([handler({ type: "save_version_commit", message: "one" }), handler({ type: "save_version_commit", message: "two" })]);
    assert.equal(execFileSync("git", ["-C", projectFolder, "rev-list", "--count", "HEAD"], { windowsHide: true }).toString().trim(), "1", "only one commit landed despite two concurrent acts");
    assert.equal(posted.filter((m) => m.type === "save_version_status" && m.status === "saved_commit").length, 1, "exactly one saved_commit status");
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test("save_version_commit: a build running at commit time aborts as busy, no commit (TOCTOU re-check)", async () => {
  const ws = mkdtempSync(join(tmpdir(), "mpyhw-sv-"));
  try {
    const posted: any[] = [];
    let handler: ((message: any) => Promise<void>) | undefined;
    const panel = { webview: { cspSource: "vscode-resource:", html: "", postMessage: (m: any) => posted.push(m), onDidReceiveMessage: (n: any) => { handler = n; } } };
    const vscode = { ViewColumn: { One: 1 }, workspace: { workspaceFolders: [{ uri: { fsPath: ws } }] }, window: { createWebviewPanel: () => panel, showWarningMessage: async () => "Cancel" } };
    let gate: (() => void) | null = null;
    let holdBoard = false; // block the SECOND build at its per-build board fetch so it stays running
    const fetchImpl = (async (url: string) => {
      if (url === "http://api.test/v1/tools") return jsonResponse({ tools: [] });
      if (url === "http://api.test/v1/skills") return jsonResponse({ toolchain_version: "1", skills: [] });
      if (url === "http://api.test/v1/packages/resolve") return jsonResponse({ selected: { name: "aht20_driver", version: "1.0.0" }, candidates: [], needs_user_choice: false, questions: [] });
      if (url === "http://api.test/v1/packages/aht20_driver/1.0.0/driver-context") return jsonResponse(aht20Context());
      if (url === "http://api.test/v1/boards/esp32-s3-devkitc-1") { if (holdBoard) await new Promise<void>((r) => { gate = r; }); return jsonResponse(board()); }
      throw new Error(`unexpected URL ${url}`);
    }) as unknown as typeof fetch;
    createPanel(vscode, {}, { apiBaseUrl: "http://api.test", fetchImpl, loopMode: "template" });
    await handler!({ type: "start_session", intent: "超过30度亮红灯", boardId: "esp32-s3-devkitc-1" });
    const projectFolder = join(ws, "blockless-project");
    writeFileSync(join(projectFolder, "extra.txt"), "change");
    posted.length = 0;

    holdBoard = true;
    const build2 = handler!({ type: "start_session", intent: "second", boardId: "esp32-s3-devkitc-1" }); // starts a run that hangs at the board fetch
    for (let i = 0; i < 200 && !gate; i++) await new Promise((r) => setTimeout(r, 5)); // wait until the run is blocked (isRunning true)
    await handler!({ type: "save_version_commit", message: "should NOT commit" });

    assert.equal(posted.find((m) => m.type === "save_version_status")?.status, "busy", "a run active at act time aborts the save as busy");
    let log = "";
    try { log = execFileSync("git", ["-C", projectFolder, "log", "--format=%s"], { windowsHide: true }).toString(); } catch { log = ""; }
    assert.ok(!/should NOT commit/.test(log), "no commit landed while a build was running");

    (gate as any)?.(); await build2.catch(() => {}); // unblock the held run
    await new Promise((r) => setTimeout(r, 200)); // let build2's trailing recorder writes drain before rmSync
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test("save_version_commit respects staging: commits only staged fileA, leaves fileB uncommitted", async () => {
  const ws = mkdtempSync(join(tmpdir(), "mpyhw-sv-"));
  try {
    const { handler, posted, projectFolder } = await startTemplateSession(ws);
    execFileSync("git", ["-C", projectFolder, "add", "-A"], { windowsHide: true });
    execFileSync("git", ["-C", projectFolder, "commit", "-m", "base"], { windowsHide: true });
    writeFileSync(join(projectFolder, "fileA.txt"), "A");
    writeFileSync(join(projectFolder, "fileB.txt"), "B");
    execFileSync("git", ["-C", projectFolder, "add", "fileA.txt"], { windowsHide: true }); // stage A only
    posted.length = 0;
    await handler({ type: "save_version_commit", message: "test: staged only" });
    const committed = execFileSync("git", ["-C", projectFolder, "show", "--name-only", "--pretty=format:", "HEAD"], { windowsHide: true }).toString();
    assert.match(committed, /fileA\.txt/, "the staged file is committed");
    assert.doesNotMatch(committed, /fileB\.txt/, "the unstaged file is NOT committed (kills an add -A mutation)");
    assert.match(execFileSync("git", ["-C", projectFolder, "status", "--porcelain"], { windowsHide: true }).toString(), /fileB\.txt/, "fileB remains uncommitted");
    // Post-commit refresh: a staged-only commit leaves fileB behind, so the refreshed list shows it
    // (not an empty list, and not the committed fileA).
    const status = posted.find((m) => m.type === "save_version_status");
    assert.ok((status?.files as any[]).some((f) => f.name === "fileB.txt"), "the refreshed list shows the remaining unstaged file");
    assert.ok(!(status?.files as any[]).some((f) => f.name === "fileA.txt"), "the committed file is gone from the list");
    // The saved_commit refresh carries the FULL summary, not just rows: after the staged-only commit,
    // fileB is now unstaged so the NEXT click would add -A — the mode note must flip and the total ride along.
    assert.equal(status?.commitMode, "all", "post-commit mode reflects the remaining unstaged files (next click is add -A)");
    assert.equal(status?.fileTotal, 1, "post-commit fileTotal is sent (the display cap needs the real count)");
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test("save_version_snapshot in a non-git project writes a snapshot.json covering the session-restore schema", async () => {
  const ws = mkdtempSync(join(tmpdir(), "mpyhw-sv-"));
  try {
    const { handler, posted, projectFolder } = await startTemplateSession(ws);
    rmSync(join(projectFolder, ".git"), { recursive: true, force: true }); // non-git project
    posted.length = 0;
    await handler({ type: "save_version_snapshot" });
    assert.equal(posted.find((m) => m.type === "save_version_status")?.status, "saved_snapshot");
    const snap = findSnapshot(ws);
    assert.ok(snap, "snapshot.json written");
    for (const key of ["schema", "stage", "state", "board", "preferences", "manifest", "artifacts", "restore"]) {
      assert.ok(key in snap, `snapshot has ${key} (a dropped field fails the session-restore contract)`);
    }
    assert.equal(snap.git, null, "no commit → git linkage null");
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test("save_version_commit on a clean git repo surfaces nothing_to_commit (auditable, no throw)", async () => {
  const ws = mkdtempSync(join(tmpdir(), "mpyhw-sv-"));
  try {
    const { handler, posted, projectFolder } = await startTemplateSession(ws);
    execFileSync("git", ["-C", projectFolder, "add", "-A"], { windowsHide: true });
    execFileSync("git", ["-C", projectFolder, "commit", "-m", "commit everything"], { windowsHide: true }); // tree now clean
    posted.length = 0;
    await handler({ type: "save_version_commit", message: "nothing here" });
    assert.equal(posted.find((m) => m.type === "save_version_status")?.status, "nothing_to_commit");
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test("save_version_commit with an empty message falls back to the deterministic blockless: template (sink test)", async () => {
  const ws = mkdtempSync(join(tmpdir(), "mpyhw-sv-"));
  try {
    const { handler, posted, projectFolder } = await startTemplateSession(ws);
    writeFileSync(join(projectFolder, "extra.txt"), "guaranteed change");
    posted.length = 0;
    // The webview can post an empty box (the user cleared it). The host must fill in the §C
    // template, never pass "" to `git commit -m` (which git rejects) or drop the message.
    await handler({ type: "save_version_commit", message: "" });
    assert.equal(posted.find((m) => m.type === "save_version_status")?.status, "saved_commit", "an empty message still commits — the host fills in the template");
    const subject = execFileSync("git", ["-C", projectFolder, "log", "-1", "--format=%s"], { windowsHide: true }).toString().trim();
    assert.match(subject, /^blockless: /, "the empty message fell back to the deterministic blockless: template");
    assert.notEqual(subject, "", "the fallback never lets git commit an empty subject");
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test("a build cannot start while a Save Version act is in flight (add -A must not race the build's writes)", async () => {
  const ws = mkdtempSync(join(tmpdir(), "mpyhw-sv-"));
  try {
    const { handler, posted, projectFolder } = await startTemplateSession(ws);
    writeFileSync(join(projectFolder, "extra.txt"), "change");
    posted.length = 0;
    // Fire the commit WITHOUT awaiting: doSaveVersionCommit sets saveInFlight synchronously, up to
    // its first git await, so the act is genuinely in flight when start_session runs next.
    const commitP = handler({ type: "save_version_commit", message: "in flight" });
    await handler({ type: "start_session", intent: "second", boardId: "esp32-s3-devkitc-1" });
    assert.ok(posted.some((m) => m.type === "session_busy"), "start_session is refused session_busy while a save is in flight");
    await commitP;
    assert.equal(posted.find((m) => m.type === "save_version_status")?.status, "saved_commit", "the in-flight save itself still completes");
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test("save_version_snapshot never lists its own checkpoints/snapshot.json in artifacts[] (no stale-sha self-reference for session restore)", async () => {
  const ws = mkdtempSync(join(tmpdir(), "mpyhw-sv-"));
  try {
    const { handler, projectFolder } = await startTemplateSession(ws);
    rmSync(join(projectFolder, ".git"), { recursive: true, force: true }); // snapshot path (non-git)
    await handler({ type: "save_version_snapshot" }); // save #1 writes checkpoints/snapshot.json + re-scans
    await handler({ type: "save_version_snapshot" }); // save #2's index now contains the prior snapshot.json
    const snap = findSnapshot(ws);
    assert.ok(snap, "snapshot written");
    assert.ok(
      !(snap.artifacts as any[]).some((a) => String(a.relative_path).replace(/\\/g, "/").endsWith("checkpoints/snapshot.json")),
      "the snapshot never references itself — else replay would verify the file against a sha it's about to overwrite",
    );
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test("gitHasStagedChanges throws on a real git failure instead of misreporting 'staged' (exit-code taxonomy)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mpyhw-nogit-"));
  try {
    // Not a git repo: `git diff --cached --quiet` fails with a usage/repo error (exit != 1). The old
    // catch-all returned true here → gitCommit would skip `add -A` and commit an empty index while
    // the tree is dirty. Only exit 1 means "staged changes exist"; any other failure must surface.
    await assert.rejects(gitHasStagedChanges(dir), "a non-repo git failure surfaces, is not misread as staged");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("retry_session is refused while a Save Version act is in flight (sibling entry point — fix the class, not just start_session)", async () => {
  const ws = mkdtempSync(join(tmpdir(), "mpyhw-sv-"));
  try {
    const { handler, posted, projectFolder } = await startTemplateSession(ws);
    writeFileSync(join(projectFolder, "extra.txt"), "change");
    posted.length = 0;
    // saveInFlight is set synchronously by the commit act; retry_session's sync guard must see it.
    const commitP = handler({ type: "save_version_commit", message: "in flight" });
    await handler({ type: "retry_session" });
    assert.ok(posted.some((m) => m.type === "session_busy"), "retry_session is refused session_busy while a save is in flight");
    await commitP;
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test("beginRun refuses a parked build that finds a save in flight at dequeue (TOCTOU recheck after the queue is acquired)", async () => {
  const ws = mkdtempSync(join(tmpdir(), "mpyhw-sv-"));
  try {
    const posted: any[] = [];
    let handler: ((message: any) => Promise<void>) | undefined;
    const panel = { webview: { cspSource: "", html: "", postMessage: (m: any) => posted.push(m), onDidReceiveMessage: (n: any) => { handler = n; } } };
    const vscode = { ViewColumn: { One: 1 }, workspace: { workspaceFolders: [{ uri: { fsPath: ws } }] }, window: { createWebviewPanel: () => panel, showWarningMessage: async () => "Cancel" } };
    // A gated device tool: listDir holds the run-ownership queue until we release it, so a build can
    // be parked at beginRun's acquire (isRunning still false) — the exact window the recheck closes.
    let reachedList: () => void = () => {};
    const listReached = new Promise<void>((res) => { reachedList = res; });
    let releaseList: () => void = () => {};
    const listGate = new Promise<void>((res) => { releaseList = res; });
    const shim = { scan: async () => ["/dev/ttyX"], setPort: () => {}, kill: () => {}, listDir: async () => { reachedList(); await listGate; return ["boot.py"]; } };
    const fetchImpl = (async (url: string) => {
      if (url === "http://api.test/v1/tools") return jsonResponse({ tools: [] });
      if (url === "http://api.test/v1/skills") return jsonResponse({ toolchain_version: "1", skills: [] });
      if (url === "http://api.test/v1/packages/resolve") return jsonResponse({ selected: { name: "aht20_driver", version: "1.0.0" }, candidates: [], needs_user_choice: false, questions: [] });
      if (url === "http://api.test/v1/packages/aht20_driver/1.0.0/driver-context") return jsonResponse(aht20Context());
      if (url === "http://api.test/v1/boards/esp32-s3-devkitc-1") return jsonResponse(board());
      throw new Error(`unexpected URL ${url}`);
    }) as unknown as typeof fetch;
    createPanel(vscode, {}, { shim, apiBaseUrl: "http://api.test", fetchImpl, loopMode: "template" });
    await handler!({ type: "start_session", intent: "超过30度亮红灯", boardId: "esp32-s3-devkitc-1" }); // completes: repo + state
    const projectFolder = join(ws, "blockless-project");
    writeFileSync(join(projectFolder, "extra.txt"), "change");
    posted.length = 0;

    const deviceP = handler!({ type: "device_tool_list", path: "/" }); // occupy the queue
    await listReached; // the device tool now HOLDS the queue
    // retry_session has no pre-acquire subprocess, so it parks at beginRun's acquire via microtasks
    // while saveInFlight is still false (passes the synchronous guard).
    const build = handler!({ type: "retry_session" });
    // Now a save begins: saveInFlight is set synchronously; its gitCommit is a subprocess (IO), so it
    // cannot clear across the microtask hop that resolves the parked acquire.
    const saveP = handler!({ type: "save_version_commit", message: "in flight" });
    releaseList(); // free the queue -> the parked build's beginRun rechecks saveInFlight (still true) -> busy
    await Promise.all([deviceP, build, saveP]);

    assert.ok(posted.some((m) => m.type === "session_busy"), "the parked build is refused when a save is found in flight at dequeue");
    assert.equal(posted.find((m) => m.type === "save_version_status")?.status, "saved_commit", "the save that won the race still completes");
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test("isSnapshotSelfPath matches only the session snapshot, segment-anchored (no false match on a lookalike user file)", () => {
  assert.equal(isSnapshotSelfPath(".mpyhw/sessions/abc123/checkpoints/snapshot.json"), true, "the real session snapshot path matches");
  assert.equal(isSnapshotSelfPath("checkpoints/snapshot.json"), true, "a bare root-relative snapshot path matches");
  assert.equal(isSnapshotSelfPath(".mpyhw\\sessions\\abc\\checkpoints\\snapshot.json"), true, "a Windows-separator path matches after normalization");
  assert.equal(isSnapshotSelfPath("mycheckpoints/snapshot.json"), false, "a lookalike segment is NOT dropped (segment-anchored, not bare endsWith)");
  assert.equal(isSnapshotSelfPath("checkpoints/snapshot.json.bak"), false, "a different filename is not matched");
  assert.equal(isSnapshotSelfPath("src/checkpoints/snapshot.jsonl"), false, "a different extension is not matched");
});

test("REPRO PR#47 blocker 2: snapshot artifacts[] reflects confirm time, not panel-open time", async () => {
  const ws = mkdtempSync(join(tmpdir(), "mpyhw-sv-"));
  try {
    const { handler, projectFolder } = await startTemplateSession(ws);
    rmSync(join(projectFolder, ".git"), { recursive: true, force: true }); // snapshot path (non-git)
    await handler({ type: "save_version_open" }); // artifactIndex refreshed HERE (panel-open)
    // An artifact appears while the confirmation panel sits open:
    const sessionsBase = join(ws, ".mpyhw", "sessions");
    const sid = readdirSync(sessionsBase)[0];
    writeFileSync(join(sessionsBase, sid, "post-open.py"), "# created between open and confirm");
    await handler({ type: "save_version_snapshot" });
    const snap = findSnapshot(ws);
    assert.ok(snap, "snapshot written");
    assert.ok(
      (snap.artifacts as any[]).some((a) => String(a.relative_path).includes("post-open.py")),
      "artifacts[] must reflect the tree at CONFIRM time (refreshArtifacts at act time), not the stale panel-open index",
    );
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test("REPRO PR#47 blocker 3: a >4MiB artifact (firmware .bin) carries a real 64-char sha256 in the integrity-checked artifacts[]", async () => {
  const ws = mkdtempSync(join(tmpdir(), "mpyhw-sv-"));
  try {
    const { handler, projectFolder } = await startTemplateSession(ws);
    rmSync(join(projectFolder, ".git"), { recursive: true, force: true }); // snapshot path (non-git)
    const sessionsBase = join(ws, ".mpyhw", "sessions");
    const sid = readdirSync(sessionsBase)[0];
    const bytes = Buffer.alloc(5 * 1024 * 1024, 1); // over the display 4MiB hash cap
    writeFileSync(join(sessionsBase, sid, "firmware.bin"), bytes);
    await handler({ type: "save_version_snapshot" });
    const snap = findSnapshot(ws);
    const fw = (snap.artifacts as any[]).find((a) => String(a.relative_path).includes("firmware.bin"));
    assert.ok(fw, "firmware artifact listed");
    // Assert the digest VALUE, not just its length: it must be the real sha256 of the file CONTENT
    // (computed fresh at snapshot time), so hashing the wrong file or the display-only cap's "" both fail.
    assert.equal(fw.sha256, createHash("sha256").update(bytes).digest("hex"), "the persisted digest is the sha256 of the firmware content, not the display-only empty string or a stale/wrong value");
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test("save_version_open reports commit mode + per-file staged flags: staged-only when the index has staged changes", async () => {
  const ws = mkdtempSync(join(tmpdir(), "mpyhw-sv-"));
  try {
    const { handler, posted, projectFolder } = await startTemplateSession(ws);
    execFileSync("git", ["-C", projectFolder, "add", "-A"], { windowsHide: true });
    execFileSync("git", ["-C", projectFolder, "commit", "-m", "base"], { windowsHide: true });
    writeFileSync(join(projectFolder, "fileA.txt"), "A");
    writeFileSync(join(projectFolder, "fileB.txt"), "B");
    execFileSync("git", ["-C", projectFolder, "add", "fileA.txt"], { windowsHide: true }); // stage A only
    posted.length = 0;
    await handler({ type: "save_version_open" });
    const data = posted.find((m) => m.type === "save_version_data");
    assert.equal(data.commitMode, "staged", "a staged file present -> the commit takes staged only");
    assert.equal((data.files as any[]).find((f) => f.name === "fileA.txt")?.staged, true, "fileA is flagged staged");
    assert.equal((data.files as any[]).find((f) => f.name === "fileB.txt")?.staged, false, "fileB (untracked) is not staged");
    assert.equal(data.fileTotal, (data.files as any[]).length, "fileTotal matches the count when under the display cap");
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test("save_version_open reports commit mode 'all' when nothing is staged (add -A path)", async () => {
  const ws = mkdtempSync(join(tmpdir(), "mpyhw-sv-"));
  try {
    const { handler, posted, projectFolder } = await startTemplateSession(ws);
    writeFileSync(join(projectFolder, "extra.txt"), "x"); // untracked, unstaged
    posted.length = 0;
    await handler({ type: "save_version_open" });
    assert.equal(posted.find((m) => m.type === "save_version_data")?.commitMode, "all", "no staged changes -> commit is add -A (all)");
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test("gitCommit surfaces an actionable error when .git/index.lock is stranded (not the raw git message)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mpyhw-lock-"));
  try {
    execFileSync("git", ["-C", dir, "init"], { windowsHide: true });
    writeFileSync(join(dir, "f.txt"), "x");
    writeFileSync(join(dir, ".git", "index.lock"), ""); // an interrupted git left this behind
    await assert.rejects(gitCommit(dir, "test: save"), /index is locked/i, "a stranded index.lock yields an actionable, self-explaining error");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("save_version: a second act while one is in flight reports in_flight (not a silent drop)", async () => {
  const ws = mkdtempSync(join(tmpdir(), "mpyhw-sv-"));
  try {
    const { handler, posted, projectFolder } = await startTemplateSession(ws);
    writeFileSync(join(projectFolder, "extra.txt"), "change");
    posted.length = 0;
    // Two acts fired together (e.g. a re-opened panel re-enabled the buttons and the user double-clicked):
    // saveInFlight lets one through; the second must post in_flight so the click isn't dropped silently.
    await Promise.all([handler({ type: "save_version_commit", message: "one" }), handler({ type: "save_version_commit", message: "two" })]);
    assert.equal(posted.filter((m) => m.type === "save_version_status" && m.status === "saved_commit").length, 1, "exactly one commit lands");
    assert.ok(posted.some((m) => m.type === "save_version_status" && m.status === "in_flight"), "the dropped second act reports in_flight");
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test("start_gen_driver refused while a save is in flight posts its OWN status (button un-sticks), not bare session_busy", async () => {
  const ws = mkdtempSync(join(tmpdir(), "mpyhw-sv-"));
  try {
    const { handler, posted, projectFolder } = await startTemplateSession(ws);
    writeFileSync(join(projectFolder, "extra.txt"), "change");
    posted.length = 0;
    // saveInFlight is set synchronously by the commit act; the gen-driver entry must refuse with a
    // gen_driver_status (message-bus restores the "Generating…" button only on that, never on
    // session_busy) — else the trigger button stays stuck.
    const commitP = handler({ type: "save_version_commit", message: "in flight" });
    await handler({ type: "start_gen_driver", sources: [{ type: "chip_model", metadata: { chip_model: "SHT30" } }] });
    assert.ok(posted.some((m) => m.type === "gen_driver_status" && m.status === "failed"), "gen-driver refused with its own status so the button restores");
    assert.ok(!posted.some((m) => m.type === "session_busy"), "no bare session_busy for a gen-driver refusal (would leave the button stuck)");
    await commitP;
    assert.equal(posted.find((m) => m.type === "save_version_status")?.status, "saved_commit", "the in-flight save still completes");
  } finally { rmSync(ws, { recursive: true, force: true }); }
});
