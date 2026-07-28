import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

import { JSDOM } from "jsdom";

import { createProtocolLoop } from "../src/core/protocol-build.ts";
import { runProtocolBuild } from "../src/core/protocol-loop.ts";
import { SessionController } from "../src/extension/session-controller.ts";
import {
  buildSessionSnapshot,
  readSessionSnapshot,
  writeSessionSnapshot,
  type SnapshotInput,
} from "../src/extension/session-snapshot.ts";

// A curated vendor board only pays off if the fields the flash phase needs — above all
// firmware.variant, which picks the Octal-SPIRAM firmware group off the shared
// ESP32_GENERIC_S3 page — survive every hop from the picker to the phase request body.
// The fixtures below are the REAL pinned Skill profiles, so a field renamed upstream
// shows up here instead of passing against an invented shape.
const SKILL_BOARDS = new URL("../../third_party/MicroPython_Skills/upy-analyze-plugin/boards/", import.meta.url);
const skillProfile = (boardId: string) => JSON.parse(readFileSync(new URL(`${boardId}.json`, SKILL_BOARDS), "utf-8"));

const VENDOR_BOARD_ID = "lilygo-t-watch-s3";
const profile = skillProfile(VENDOR_BOARD_ID);

// The board exactly as /v1/micropython/boards serves a curated vendor profile: appended to
// the official boards[], flagged by support_status, firmware copied verbatim.
const vendorBoard = {
  id: profile.id,
  official_id: null,
  display_name: profile.display_name,
  vendor: profile.vendor,
  port: profile.firmware.port,
  mcu: profile.mcu,
  chip_family: profile.chip_family,
  features: profile.features,
  firmware: profile.firmware,
  onboard_peripherals: profile.onboard_peripherals,
  download_slug: null,
  skill_board_id: profile.id,
  skill_profile_available: true,
  source_url: "",
  detail_url: profile.firmware.url,
  image_url: "",
  support_status: "skill_vendor_profile",
  local_board_id: null,
};

test("the vendor profile under test still declares the firmware fields the flash phase branches on", () => {
  assert.equal(profile.firmware.variant, "spiram-oct");
  assert.equal(profile.firmware.source, "micropython_latest");
  assert.equal(profile.firmware.board_name, "ESP32_GENERIC_S3");
  assert.equal(profile.firmware.flash_method, "esptool");
});

// --- the webview half: the real shipped picker, loaded the way the panel assembles it ---
const rawHtml = readFileSync(new URL("../src/webview/index.html", import.meta.url), "utf-8");
const webviewCss = readFileSync(new URL("../src/webview/webview.css", import.meta.url), "utf-8");
const compDir = new URL("../src/webview/components/", import.meta.url);
const compOrder: string[] = JSON.parse(readFileSync(new URL("manifest.json", compDir), "utf-8"));
const webviewJs = compOrder.map((f) => readFileSync(new URL(f, compDir), "utf-8")).join("");
const html = rawHtml.replace("/*__WEBVIEW_CSS__*/", () => webviewCss).replace("//__WEBVIEW_JS__", () => webviewJs);

// Every loaded window leaks the device-presence setInterval, which keeps node's event loop
// alive forever; close them all at the end (same reason as the webview DOM suite).
const openDoms: JSDOM[] = [];
const tempDirs: string[] = [];
after(() => {
  for (const d of openDoms) d.window.close();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

async function loadWebview(posted: any[]): Promise<JSDOM> {
  const dom = new JSDOM(html, {
    runScripts: "dangerously",
    beforeParse: (window) => {
      (window as any).acquireVsCodeApi = () => ({
        postMessage: (message: any) => posted.push(message),
        getState: () => null,
        setState: () => {},
      });
    },
  });
  await new Promise<void>((resolve) => {
    if (dom.window.document.readyState === "complete") resolve();
    else dom.window.addEventListener("load", () => resolve());
  });
  openDoms.push(dom);
  return dom;
}

// --- the host half: the controller wired to the SAME loop factory the panel builds ---
// (createProtocolLoop, not a hand-written stand-in, so the controller->loop->request-body
// mapping under test is production's.)
function sseTool(id: string, name: string, input: any) {
  return [
    `data: ${JSON.stringify({ type: "content_block_start", content_block: { type: "tool_use", id, name } })}`,
    `data: ${JSON.stringify({ type: "content_block_delta", delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } })}`,
    `data: ${JSON.stringify({ type: "content_block_stop" })}`,
    `data: ${JSON.stringify({ type: "message_stop" })}`,
    "",
  ].join("\n\n");
}

function controllerCapturing(bodies: any[]) {
  const fetchImpl = async (_url: any, init: any) => {
    bodies.push(JSON.parse(String(init.body)));
    return new Response(
      sseTool(`p${bodies.length}`, "phase_complete", { result: "success", next_phase: null, manifest_content: {} }),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    ) as any;
  };
  const loop = createProtocolLoop({ apiBaseUrl: "http://api.test", fetchImpl: fetchImpl as any, getAuthToken: async () => "token" });
  return new SessionController({ postMessage: () => {}, loop } as any);
}

test("picking a curated vendor board sends its whole firmware block to the phase request", async () => {
  const posted: any[] = [];
  const dom = await loadWebview(posted);
  const { document } = dom.window;

  dom.window.dispatchEvent(new dom.window.MessageEvent("message", {
    data: { type: "micropython_boards", source_url: "https://micropython.org/download/", boards: [vendorBoard] },
  }));
  (document.querySelector(`.board-card[data-board-id="${VENDOR_BOARD_ID}"]`) as HTMLButtonElement).click();
  (document.getElementById("intent") as HTMLTextAreaElement).value = "a watch face that shows the temperature";
  (document.getElementById("generate") as HTMLButtonElement).click();

  const start = posted.find((m) => m.type === "start_session");
  // No local overlay profile for a vendor board, so the board id stays "auto" and the whole
  // board object is what carries the hardware facts.
  assert.equal(start.boardId, "auto");
  assert.deepEqual(start.pre_selected_board.firmware, profile.firmware);

  const bodies: any[] = [];
  await controllerCapturing(bodies).start({
    intent: start.intent,
    boardId: start.boardId,
    preSelectedBoard: start.pre_selected_board,
    preferences: start.preferences,
  });

  const sent = bodies[0].context.pre_selected_board;
  assert.equal(sent.skill_board_id, VENDOR_BOARD_ID, "the phase can reload the full profile by id");
  assert.equal(sent.firmware.variant, "spiram-oct", "the Octal-SPIRAM variant reaches the request body");
  // Exact equality: the flash phase branches on source/file_type/flash_method too, so a
  // projection that keeps only url/port/board_name must fail here.
  assert.deepEqual(sent.firmware, profile.firmware);
  assert.equal(sent.support_status, "skill_vendor_profile");
  // The onboard peripherals ride along too: their driver package names and asset files are what
  // select-hw reuses instead of treating the built-in display/IMU as external parts.
  assert.deepEqual(sent.onboard_peripherals, profile.onboard_peripherals);
  // ...and nothing else is dropped either. The board object the picker chose is the one the
  // phase receives, field for field, so any narrowing of pre_selected_board fails here.
  assert.deepEqual(sent, vendorBoard);
});

test("a saved session restores the vendor board with its firmware variant intact", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vendor-board-snapshot-"));
  tempDirs.push(dir);
  const input: SnapshotInput = {
    traceId: "session-vendor",
    savedAt: "2026-07-27T09:00:00.000Z",
    currentPhase: "upy-flash-mpy-firmware-plugin",
    terminal: null,
    state: { manifest: { devices: [] }, phase: "upy-flash-mpy-firmware-plugin", intent: "watch face" },
    boardId: "auto",
    preSelectedBoard: vendorBoard,
    boardSelectionMode: undefined,
    preferences: { mode: "custom", locale: "en" },
    manifest: { devices: [] },
    diagram: null,
    optionalNextPhases: [],
    generatePhaseComplete: undefined,
    credits: null,
    diagnostics: { selected_board: profile.display_name, key_errors: "", recent_activity: "", last_command: "" },
    artifacts: [],
    git: null,
  };

  await writeSessionSnapshot(dir, buildSessionSnapshot(input));
  const restored = await readSessionSnapshot(dir);
  assert.ok(restored, "snapshot read back");
  const restoredBoard = restored!.board.pre_selected_board as any;
  assert.deepEqual(restoredBoard.firmware, profile.firmware, "the firmware block survives the JSON round trip");

  const bodies: any[] = [];
  const controller = controllerCapturing(bodies);
  assert.equal(controller.seedFromSnapshot({
    traceId: "session-vendor",
    state: restored!.state,
    boardId: restored!.board.board_id,
    preSelectedBoard: restoredBoard,
    preferences: restored!.preferences,
    currentPhase: restored!.stage.current_phase,
    manifest: restored!.manifest,
  }), true);
  await controller.startPhase({ phase: "upy-flash-mpy-firmware-plugin", envelope: "continue the flash phase" });

  const sent = bodies[0].context.pre_selected_board;
  assert.equal(sent.firmware.variant, "spiram-oct", "a restored session still flashes the Octal-SPIRAM firmware");
  assert.equal(sent.skill_board_id, VENDOR_BOARD_ID);
  assert.deepEqual(sent.firmware, profile.firmware);
  // The snapshot round trip is a separate JSON path from the picker, so pin the whole board
  // (onboard_peripherals included), not just firmware — nothing may be projected away here either.
  assert.deepEqual(sent, vendorBoard);
});

test("a phase manifest carries its runtime mip dependencies and onboard devices into the next phase unchanged", async () => {
  // The driver packages an onboard peripheral needs are a generate-manifest field, not a board
  // field: they ride the manifest from phase to phase. Use the real uPyPi install target from a
  // vendor profile so a renamed package field would show up as a diff here.
  const expanderBoard = skillProfile("waveshare-esp32-s3-touch-lcd-3-5");
  const expanderIndex = expanderBoard.onboard_peripherals.findIndex((p: any) => p.type === "io_expander");
  const expander = expanderBoard.onboard_peripherals[expanderIndex];
  const manifest = {
    board: { id: "waveshare-esp32-s3-touch-lcd-3-5", firmware: expanderBoard.firmware },
    devices: [
      {
        id: "io_expander",
        model: expander.model,
        // select-hw marks a reused onboard peripheral instead of treating it as an external part.
        physical_source: "board_onboard",
        // The ref select-hw actually writes is the object from peripheral_ref() (board id, index,
        // identity and the pins the peripheral already occupies), not the bare name.
        onboard_peripheral_ref: {
          board_id: expanderBoard.id,
          index: expanderIndex,
          name: expander.name,
          type: expander.type,
          model: expander.model,
          occupied_pins: expander.occupied_pins ?? {},
          always_used: Boolean(expander.always_used),
          verification: expander.verification ?? "",
          pin_evidence: expander.pin_evidence ?? "",
        },
        driver: expander.driver,
      },
    ],
    runtime_dependencies: { mip: [expander.driver.url] },
  };

  const bodies: any[] = [];
  const llmClient = {
    streamMessages: async (body: any) => {
      bodies.push(body);
      const first = bodies.length === 1;
      return (async function* () {
        yield {
          type: "tool_use_complete",
          id: `p${bodies.length}`,
          name: "phase_complete",
          input: first
            ? { result: "success", next_phase: "upy-deploy-plugin", manifest_content: manifest }
            : { result: "success", next_phase: null, manifest_content: manifest },
        };
        yield { type: "message_stop" };
      })();
    },
  };

  await runProtocolBuild({ intent: "touch UI", boardId: "auto", startPhase: "upy-generate-plugin" }, { llmClient } as any);

  assert.equal(bodies.length, 2, "the build advanced to the next phase");
  assert.deepEqual(bodies[1].manifest, manifest, "the manifest is handed on verbatim");
  assert.deepEqual(bodies[1].manifest.runtime_dependencies.mip, [expander.driver.url], "the mip install list is preserved");
  assert.equal(bodies[1].manifest.devices[0].physical_source, "board_onboard", "the onboard-reuse marker is preserved");
  assert.deepEqual(bodies[1].manifest.devices[0].driver, expander.driver, "the driver package metadata is preserved");
});
