import assert from "node:assert/strict";
import test from "node:test";

import { createPanel, createViewProvider } from "../src/webview/panel.ts";

test("webview start_session runs API-backed pipeline and renders generated outputs", async () => {
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
    window: {
      createWebviewPanel: () => panel,
      showWarningMessage: async () => "Cancel",
    },
  };
  const fetchImpl = async (url: string, init?: RequestInit) => {
    requested.push(url);
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
    "http://api.test/v1/packages/resolve",
    "http://api.test/v1/packages/aht20_driver/1.0.0/driver-context",
    "http://api.test/v1/boards/esp32-s3-devkitc-1",
  ]);
  assert.deepEqual(posted.map((message) => message.type), ["trace_event", "manifest_updated", "code_updated", "trace_event", "session_done"]);
  assert.equal(posted.at(-1).terminal, "generated");
  assert.match(posted.find((message) => message.type === "code_updated").code, /MPYHW_READY/);
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
  // The LLM replies with plain text and no tool call (e.g. asking the user to
  // clarify). The loop must hand back after one turn, and the panel must forward
  // the awaiting_user terminal to the webview rather than spinning to max_turns.
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
  assert.equal(posted.at(-1).terminal, "awaiting_user");
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
