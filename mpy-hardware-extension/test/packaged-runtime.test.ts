import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import Module from "node:module";
import { resolve } from "node:path";
import test from "node:test";

import { activate, parseRecipeImportUri } from "../src/extension/activate.ts";

const pkg = JSON.parse(readFileSync("package.json", "utf-8"));

test("packaged runtime uses API-backed pipeline instead of preview literals", () => {
  const runtime = readFileSync(pkg.main, "utf-8");

  assert.match(runtime, /\/v1\/packages\/resolve/);
  assert.doesNotMatch(runtime, /postPreviewSession/);
  assert.doesNotMatch(runtime, /preview_complete/);
  assert.doesNotMatch(runtime, /TEMP_C=30\.1 LED=ON/);
});

test("extension entry loads in a CommonJS host and exports activate", () => {
  // VS Code's extension host loads the entry via CommonJS require() and injects
  // the vscode API through require("vscode"). An ESM entry can't obtain it and
  // fails to activate. Load the real packaged entry the same way to catch that.
  const require = createRequire(import.meta.url);
  const loader = Module as unknown as { _load: (request: string, parent: unknown, isMain: boolean) => unknown };
  const original = loader._load;
  loader._load = (request, parent, isMain) =>
    request === "vscode"
      ? { commands: { registerCommand: () => ({}) }, window: {}, ViewColumn: { One: 1 } }
      : original(request, parent, isMain);
  try {
    const entry = require(resolve(pkg.main)) as { activate?: unknown; deactivate?: unknown };
    assert.equal(typeof entry.activate, "function");
    assert.equal(typeof entry.deactivate, "function");
  } finally {
    loader._load = original;
  }
});

test("website recipe URI payload parses into an extension import request", () => {
  // The website forwards the recommend response's `handoff` object verbatim as
  // `payload`. The live API shape has `starter_prompt` (NOT `prompt`) and no
  // `recipe_id`/`id` at all, so the parser must recover the idea from
  // `starter_prompt` — otherwise the plugin opens to a blank input box.
  const payload = encodeURIComponent(JSON.stringify({
    starter_prompt: "Build a MicroPython project for: a plant that yells when its soil is dry",
    board_slug: "ESP32_GENERIC_S3",
    capabilities: ["humidity_sensing", "audio_output"],
    source: "website",
  }));

  const parsed = parseRecipeImportUri({
    path: "/importRecipe",
    query: `source=website&payload=${payload}`,
  });

  assert.deepEqual(parsed, {
    recipe_id: "",
    prompt: "Build a MicroPython project for: a plant that yells when its soil is dry",
    source: "website",
  });
});

test("extension registers a URI handler that forwards website recipes to the webview", () => {
  const posted: any[] = [];
  const commands: string[] = [];
  let uriHandler: any;
  const view = {
    webview: {
      cspSource: "vscode-resource:",
      html: "",
      options: undefined as any,
      postMessage: (message: any) => posted.push(message),
      onDidReceiveMessage: () => {},
    },
  };
  const vscode = {
    commands: {
      registerCommand: () => ({}),
      executeCommand: (command: string) => commands.push(command),
    },
    window: {
      createOutputChannel: () => ({ appendLine: () => {}, dispose: () => {} }),
      registerWebviewViewProvider: (_id: string, provider: any) => {
        provider.resolveWebviewView(view);
        return {};
      },
      registerUriHandler: (handler: any) => {
        uriHandler = handler;
        return {};
      },
      showWarningMessage: async () => "Cancel",
    },
  };
  const context = { extensionUri: {}, globalStorageUri: { fsPath: "C:/tmp/blockless-test" }, subscriptions: [] as any[] };
  // Real handoff shape forwarded by the website (see /v1/web/recommend): the
  // idea rides in `starter_prompt`, there is no `recipe_id`, and the only query
  // param besides the payload is `source`.
  const payload = encodeURIComponent(JSON.stringify({
    starter_prompt: "Build a MicroPython project for: a desk light that turns red when I'm on a call",
    board_slug: "ESP32_GENERIC_S3",
    capabilities: ["digital_input", "rgb_output"],
    source: "website",
  }));

  activate(context, vscode);
  uriHandler.handleUri({ path: "/importRecipe", query: `source=website&payload=${payload}` });

  assert.deepEqual(commands, ["mpyhw.panel.focus"]);
  assert.deepEqual(posted.at(-1), {
    type: "recipe_imported",
    payload: { recipe_id: "", prompt: "Build a MicroPython project for: a desk light that turns red when I'm on a call", source: "website" },
  });
});
