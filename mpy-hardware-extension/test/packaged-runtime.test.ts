import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import Module from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { PARTNERS } from "../src/core/partner-config.ts";
import { activate, parseRecipeImportUri } from "../src/extension/activate.ts";
// @ts-expect-error — plain-JS build script, no type declarations.
import { vendorPluginSubset } from "../scripts/vendor-plugin-subset.mjs";

const UPSTREAM_ROOT = resolve("..", "third_party", "MicroPython_Skills");

// Run the REAL VSIX vendor step over the REAL submodule (its layout, .mpy files and all)
// into a throwaway dir and hand the caller the relative paths that landed.
function vendorIntoTempDir(assertOn: (destRoot: string, relPaths: string[]) => void) {
  assert.ok(existsSync(UPSTREAM_ROOT), `upstream submodule missing at ${UPSTREAM_ROOT} — run \`git submodule update --init --recursive\``);
  const destRoot = mkdtempSync(join(tmpdir(), "vsce-vendor-"));
  try {
    const vendored = vendorPluginSubset(UPSTREAM_ROOT, destRoot);
    assert.ok(vendored > 0, "the vendor step copied nothing — every assertion below would be vacuous");
    const relPaths = readdirSync(destRoot, { recursive: true, encoding: "utf-8" }).map((p) => p.replaceAll("\\", "/"));
    assertOn(destRoot, relPaths);
  } finally {
    rmSync(destRoot, { recursive: true, force: true });
  }
}

const pkg = JSON.parse(readFileSync("package.json", "utf-8"));

test("packaged runtime uses API-backed pipeline instead of preview literals", () => {
  const runtime = readFileSync(pkg.main, "utf-8");

  assert.match(runtime, /\/v1\/packages\/resolve/);
  assert.doesNotMatch(runtime, /postPreviewSession/);
  assert.doesNotMatch(runtime, /preview_complete/);
  assert.doesNotMatch(runtime, /TEMP_C=30\.1 LED=ON/);
});

test("packaged VSIX ships every partner logo asset", () => {
  // The home partner area renders empty in a shipped VSIX if the PNGs are excluded
  // (.vscodeignore's `src/**` without a `!src/webview/assets/**` negation). Assert
  // against the real file set vsce would package — NOT the .vscodeignore text — so
  // this fails if either the ignore rule OR the runtime asset location regresses.
  // vsce is a pinned devDependency; spawn its JS entry via node for Windows parity.
  const vsceBin = resolve("node_modules/@vscode/vsce/vsce");
  const listed = spawnSync(process.execPath, [vsceBin, "ls"], { encoding: "utf-8" });
  assert.equal(listed.status, 0, `vsce ls failed: ${listed.stderr || listed.stdout}`);

  const packaged = new Set(listed.stdout.split(/\r?\n/).map((line) => line.trim()));
  for (const partner of PARTNERS) {
    const path = `src/webview/assets/partners/${partner.file}`;
    assert.ok(packaged.has(path), `partner asset missing from the packaged VSIX: ${path}`);
  }
});

test("packaged VSIX ships the MicroPython-lib evidence knowledge and the mip install/verify scripts", () => {
  // Nothing else pins this subset. A one-line EXCLUDE_DIRS edit (adding "knowledge") or a
  // .json drop rule would strip the API-evidence index out of every VSIX and no test would
  // notice — generate would then have no evidence to justify MicroPython-lib API calls and
  // deploy no script to turn the manifest's mip dependencies into a real install. Assert
  // the real FILE SET the vendor step produces, not the ignore rules that produced it.
  vendorIntoTempDir((destRoot) => {
    for (const rel of [
      // Read at runtime by check_doc_evidence.py / the generate driver-API rules.
      "upy-generate-plugin/knowledge/micropython_official_library_index.json",
      "upy-generate-plugin/knowledge/mip_runtime_dependencies.pitfall.json",
      // Emits the mip runtime dependency instead of vendoring package source.
      "upy-generate-plugin/scripts/download_drivers.py",
      // The two evidence gates that block generate when API evidence is missing.
      "upy-generate-plugin/scripts/check_runtime_dependencies.py",
      "upy-generate-plugin/scripts/check_doc_evidence.py",
      // Deploy turns those dependencies into `mpremote mip install` + an import verify.
      "upy-deploy-plugin/scripts/install_mip_dependencies.py",
      // The legacy copy the host's script.run_download_drivers dispatch actually runs.
      "upy-generate/scripts/download_drivers.py",
    ]) {
      assert.ok(existsSync(join(destRoot, rel)), `missing from the vendored VSIX subset: ${rel}`);
    }
  });
});

test("the VSIX vendor step still drops prose, fixtures and the maintainer's local paths", () => {
  // The evidence-knowledge pin above must not be satisfiable by widening the subset to
  // "ship everything": the prose/fixture drops and the board-JSON local-path strip are
  // the other half of the contract (packaged size, and the maintainer local-path leak).
  vendorIntoTempDir((destRoot, relPaths) => {
    assert.ok(!relPaths.some((p) => p.endsWith(".md")), "heavy prose (SKILL.md/README) must stay out of the VSIX");
    assert.ok(!existsSync(join(destRoot, "upy-generate-plugin/test/smoke_tests.py")), "test fixtures must stay out of the VSIX");
    assert.ok(!existsSync(join(destRoot, "upy-generate-plugin/sample")), "sample fixtures must stay out of the VSIX");

    const boards = relPaths.filter((p) => p.includes("/boards/") && p.endsWith(".json"));
    assert.ok(boards.length > 0, "no board JSONs vendored — the local-path assertion below would be vacuous");
    for (const rel of boards) {
      // Upstream board JSONs bake the maintainer's Windows absolute paths (e.g. "G:\\...").
      assert.doesNotMatch(
        readFileSync(join(destRoot, rel), "utf-8"),
        /"[A-Za-z]:[\\/]/,
        `vendored board JSON still carries a maintainer local path: ${rel}`,
      );
    }
  });
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

test("the Blockless panel auto-opens on every startup only when mpyhw.autoOpenPanel is set", () => {
  // Installer-only + stateless: onStartupFinished wakes the extension, but the panel is focused
  // ONLY when the profile has mpyhw.autoOpenPanel:true (the installer writes it), and then on
  // EVERY startup — no first-run flag. Mutation A: drop revealPanelIfEnabled -> the enabled case
  // focuses nothing. Mutation B: reveal unconditionally -> the disabled case focuses the panel.
  // Mutation C: re-add a globalState first-run gate -> the second enabled startup stops focusing.
  const activateWith = (autoOpen: boolean, store: Map<string, unknown>) => {
    const commands: string[] = [];
    const vscode = {
      commands: { registerCommand: () => ({}), executeCommand: (c: string) => { commands.push(c); } },
      window: {
        createOutputChannel: () => ({ appendLine: () => {}, dispose: () => {} }),
        registerWebviewViewProvider: () => ({}),
        registerUriHandler: () => ({}),
      },
      workspace: {
        getConfiguration: (section: string) => ({ get: (k: string) => (section === "mpyhw" && k === "autoOpenPanel" ? autoOpen : undefined) }),
      },
    };
    const context = {
      extensionUri: {},
      globalStorageUri: { fsPath: "C:/tmp/blockless-autoopen" },
      subscriptions: [] as unknown[],
      globalState: { get: (k: string) => store.get(k), update: (k: string, v: unknown) => { store.set(k, v); } },
    };
    activate(context, vscode);
    return commands;
  };

  // Default / Marketplace user: the setting is off, so nothing opens.
  assert.deepEqual(activateWith(false, new Map()), [], "auto-open stays off unless the profile enables it");

  // Installer profile: the panel opens, and re-opens on the next startup even with a persistent
  // store present (proves it is setting-driven, not a one-time first-run flag).
  const shared = new Map<string, unknown>();
  assert.deepEqual(activateWith(true, shared), ["mpyhw.panel.focus"], "the opted-in profile opens the panel");
  assert.deepEqual(activateWith(true, shared), ["mpyhw.panel.focus"], "stateless: it re-opens on every startup");
});

test("a rejected panel.focus never escapes activate as an unhandled rejection", async () => {
  // Both call sites hand VS Code's executeCommand — a Thenable — to a synchronous try/catch
  // (revealPanelIfEnabled) or no try/catch at all (deliverRecipeImport). A REJECTING
  // executeCommand is the only mock shape that can catch a missing/removed .catch() guard;
  // the resolving mock used by the tests above cannot.
  const leaked: unknown[] = [];
  const onLeak = (reason: unknown) => leaked.push(reason);
  process.on("unhandledRejection", onLeak);

  let uriHandler: any;
  const vscode = {
    commands: {
      registerCommand: () => ({}),
      executeCommand: () => Promise.reject(new Error("no view")),
    },
    window: {
      createOutputChannel: () => ({ appendLine: () => {}, dispose: () => {} }),
      registerWebviewViewProvider: () => ({}),
      registerUriHandler: (handler: any) => {
        uriHandler = handler;
        return {};
      },
    },
    workspace: {
      getConfiguration: (section: string) => ({ get: (k: string) => (section === "mpyhw" && k === "autoOpenPanel" ? true : undefined) }),
    },
  };
  const context = { extensionUri: {}, subscriptions: [] as any[] };

  try {
    // (a) activate() must complete even though the reveal it triggers rejects.
    assert.doesNotThrow(() => activate(context, vscode));
    // Exercises the deliverRecipeImport call site (activate.ts:20), the second unguarded spot.
    uriHandler.handleUri({ path: "/importRecipe", query: "" });

    // Let both rejected Thenables settle before checking for a leak.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    assert.deepEqual(leaked, [], "a rejected panel.focus must never surface as an unhandled rejection");
  } finally {
    process.off("unhandledRejection", onLeak);
    for (const subscription of context.subscriptions) subscription?.dispose?.();
  }
});
