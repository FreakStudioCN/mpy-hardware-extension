import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { JSDOM } from "jsdom";

// Loads the REAL shipped webview (the inline <script> in index.html) into jsdom
// and drives it through window 'message' events, exactly as the extension host
// posts them. The script falls back to a mock vscode when acquireVsCodeApi is
// absent, so no production extraction is needed. This is the only coverage of
// the streaming code card / renderWiring (dual-shape) / the deploy checkpoint /
// setCredits / the HTML-escape guard.
const html = readFileSync(new URL("../src/webview/index.html", import.meta.url), "utf-8");

async function loadWebview(posted?: any[]): Promise<JSDOM> {
  const dom = new JSDOM(html, {
    runScripts: "dangerously",
    beforeParse: posted ? (window) => {
      (window as any).acquireVsCodeApi = () => ({
        postMessage: (message: any) => posted.push(message),
        getState: () => null,
        setState: () => {},
      });
    } : undefined,
  });
  await new Promise<void>((resolve) => {
    if (dom.window.document.readyState === "complete") resolve();
    else dom.window.addEventListener("load", () => resolve());
  });
  return dom;
}

function post(dom: JSDOM, data: unknown): void {
  dom.window.dispatchEvent(new dom.window.MessageEvent("message", { data }));
}

test("the Doctor tab requests a check on load and renders results as localized status cards", async () => {
  const posted: any[] = [];
  const dom = await loadWebview(posted);
  const { document } = dom.window;

  // The tab + its container ship in the chrome, empty until results arrive.
  assert.ok(document.querySelector('.tab[data-tab="doctor"]'), "Doctor tab button present");
  const view = document.getElementById("doctor")!;
  assert.ok(view, "Doctor view container present");
  assert.equal(document.getElementById("doctorEmpty")!.classList.contains("hidden"), false);
  // The check is kicked off on load, alongside the board fetch.
  assert.ok(posted.some((m) => m.type === "run_doctor_check"), "a doctor check is requested on load");

  post(dom, {
    type: "doctor_results",
    items: [
      { id: "python", status: "ok", messageKey: "doc_python_ok", detail: "Python 3.12.1" },
      { id: "deps", status: "ok", messageKey: "doc_deps_ok" },
      { id: "device", status: "warn", messageKey: "doc_device_none", errorKind: "device_unavailable" },
      { id: "micropython", status: "warn", messageKey: "doc_mpy_need_device" },
    ],
  });

  assert.equal(document.getElementById("doctorEmpty")!.classList.contains("hidden"), true, "empty state hidden once results render");
  assert.equal(view.querySelectorAll(".doc-row").length, 4, "one row per check");
  assert.match(view.textContent!, /Python ready/, "ok headline localized from messageKey");
  assert.match(view.textContent!, /Python 3\.12\.1/, "version detail shown");
  assert.ok(view.querySelector(".doc-row.doc-ok"), "ok status styled");
  assert.ok(view.querySelector(".doc-row.doc-warn"), "warn status styled");
});

test("a failing Doctor check offers an install button and guide links wired to the host (no raw error_kind)", async () => {
  const posted: any[] = [];
  const dom = await loadWebview(posted);
  const { document } = dom.window;
  const view = document.getElementById("doctor")!;

  post(dom, {
    type: "doctor_results",
    items: [
      { id: "python", status: "error", messageKey: "doc_python_missing", errorKind: "python_not_found", link: "https://www.python.org/downloads/" },
      { id: "deps", status: "error", messageKey: "doc_deps_missing", errorKind: "shim_dependency_install_failed", action: "install_deps" },
      { id: "micropython", status: "warn", messageKey: "doc_mpy_missing", errorKind: "no_micropython", link: "https://micropython.org/download/ESP32_GENERIC/" },
    ],
  });

  // Human headline, never the raw machine error_kind.
  assert.match(view.textContent!, /Python not found/);
  assert.doesNotMatch(view.textContent!, /python_not_found/, "raw error_kind never shown to the user");
  assert.ok(
    [...view.querySelectorAll("a.doc-link")].some((a) => /python\.org/.test(a.getAttribute("href") || "")),
    "a Python download link is offered",
  );

  // Deps missing → an Install button that asks the host to install.
  posted.length = 0;
  const fix = view.querySelector(".doc-fix") as any;
  assert.ok(fix, "an install button is offered for the missing deps");
  fix.click();
  assert.ok(
    posted.some((m) => m.type === "doctor_action" && m.action === "install_deps"),
    "clicking Install asks the host to install deps",
  );

  // Firmware guide link for a board with no MicroPython.
  assert.ok(
    [...view.querySelectorAll("a.doc-link")].some((a) => /micropython\.org\/download/.test(a.getAttribute("href") || "")),
    "a firmware download link is offered",
  );
});

test("code streams into the activity feed and finalizes as highlighted MicroPython (no Code tab)", async () => {
  const dom = await loadWebview();
  const { document } = dom.window;
  const activity = document.getElementById("activity")!;

  // Live tokens append to a growing code card in the activity feed.
  post(dom, { type: "code_delta", text: "import time\n", path: "main.py" });
  post(dom, { type: "code_delta", text: "print('MPYHW_READY')\n", path: "main.py" });
  assert.match(activity.textContent!, /MPYHW_READY/, "streamed code shows live in the activity feed");

  // code_updated finalizes that card into highlighted, line-numbered rows.
  post(dom, { type: "code_updated", code: "import time\nprint('MPYHW_READY')\n", path: "main.py" });
  assert.ok(activity.querySelector(".code-block"), "finalized code rendered as a code block");
  assert.ok(activity.querySelector(".tok-kw"), "python keywords highlighted");
  assert.match(activity.textContent!, /MPYHW_READY/);

  // The Code tab is gone — code lives in the activity feed and the real workspace file.
  assert.equal(document.querySelector('.tab[data-tab="code"]'), null, "no Code tab button");
  assert.equal(document.getElementById("code"), null, "no Code tab container");
});

test("deploy_needed shows a checkpoint card with the wiring diagram and a disabled Deploy until a board is found", async () => {
  const dom = await loadWebview();
  const { document } = dom.window;

  post(dom, { type: "deploy_needed", promptId: "deploy-1", manifest: { board_id: "esp32-s3-devkitc-1", wiring: [{ role: "led_anode", pin: "GPIO2" }] } });
  const activity = document.getElementById("activity")!;
  assert.match(activity.innerHTML, /GPIO2/, "deploy card renders the wiring diagram");
  const deployBtn = activity.querySelector(".deploy-go") as any;
  assert.ok(deployBtn, "deploy button present");
  assert.equal(deployBtn.disabled, true, "Deploy disabled until a board is detected");

  // No board -> stays disabled with a connect prompt.
  post(dom, { type: "deploy_ports_updated", ports: [] });
  assert.equal(deployBtn.disabled, true, "still disabled with no board");

  // One board -> auto-selected, Deploy enabled.
  post(dom, { type: "deploy_ports_updated", ports: ["COM7"] });
  assert.equal(deployBtn.disabled, false, "Deploy enabled once a single board is connected");
  assert.match(activity.textContent!, /COM7/, "connection status shows the detected port");
});

test("multi-device deploy card groups device chips above the actions and gates Deploy on a pick", async () => {
  const dom = await loadWebview();
  const { document } = dom.window;
  const activity = document.getElementById("activity")!;

  post(dom, { type: "deploy_needed", promptId: "deploy-m", manifest: { board_id: "esp32-s3-devkitc-1", wiring: [{ role: "led_anode", pin: "GPIO2" }] } });
  post(dom, { type: "deploy_ports_updated", ports: ["COM3", "COM4"] });

  // One chip per device, in their own selection group (distinct from the actions).
  const ports = activity.querySelector(".deploy-ports")!;
  const chips = ports.querySelectorAll(".ask-opt");
  assert.equal(chips.length, 2, "one chip per device");
  assert.match(ports.textContent!, /COM3/);
  assert.match(ports.textContent!, /COM4/);

  // Actions live in the structured footer: a primary Deploy over a secondary row.
  const deployBtn = activity.querySelector(".deploy-actions .deploy-go") as any;
  assert.ok(deployBtn, "Deploy is the primary action inside .deploy-actions");
  assert.ok(activity.querySelector(".deploy-secondary .deploy-rescan"), "Rescan in the secondary row");
  assert.ok(activity.querySelector(".deploy-secondary .deploy-cancel"), "Cancel in the secondary row");

  // Deploy is gated until a device is picked.
  assert.equal(deployBtn.disabled, true, "Deploy disabled while no device is picked");
  (chips[0] as HTMLButtonElement).click();
  assert.ok((chips[0] as HTMLElement).classList.contains("chosen"), "picked chip is marked chosen");
  assert.equal(deployBtn.disabled, false, "Deploy enabled once a device is picked");
});

test("manifest_updated renders wiring from the flat [{role,pin}] shape", async () => {
  const dom = await loadWebview();
  const { document } = dom.window;

  post(dom, {
    type: "manifest_updated",
    manifest: {
      board_id: "esp32-s3-devkitc-1",
      wiring: [
        { role: "i2c_sda", pin: "GPIO5" },
        { role: "i2c_scl", pin: "GPIO6" },
        { role: "led_anode", pin: "GPIO2" },
      ],
    },
  });

  const wiring = document.getElementById("wiring")!;
  assert.ok(document.getElementById("wiringEmpty")!.classList.contains("hidden"));
  assert.match(wiring.innerHTML, /Data \(SDA\)/);
  assert.match(wiring.innerHTML, /GPIO5/);
  assert.match(wiring.innerHTML, /GPIO2/);
});

test("manifest_updated renders the rich bus-keyed shape with named devices (dual-shape mapper)", async () => {
  const dom = await loadWebview();
  const { document } = dom.window;

  post(dom, {
    type: "manifest_updated",
    manifest: {
      board_id: "esp32-s3-devkitc-1",
      wiring: { i2c: { sda: "GPIO5", scl: "GPIO6", devices: [{ address: "0x38", label: "AHT20" }] } },
    },
  });

  const wiring = document.getElementById("wiring")!;
  assert.match(wiring.innerHTML, /AHT20/);
  assert.match(wiring.innerHTML, /Data \(SDA\)/);
  assert.match(wiring.innerHTML, /GPIO5/);
});

test("manifest_updated renders the upstream device-identity shape (buses[]/standalone[]) with no phantom card and no global chip stamp", async () => {
  const dom = await loadWebview();
  const { document } = dom.window;

  // A single ssd1306 OLED on I2C plus a standalone LED. The old flat model
  // turned this into a phantom "Peripheral · ssd1306 · Gpio Out" card; the
  // device-identity shape must render exactly two correctly-attributed cards.
  post(dom, {
    type: "manifest_updated",
    manifest: {
      board_id: "esp32-s3-devkitc-1",
      driver_context_refs: ["ssd1306@1.0.0"],
      pins: { i2c_sda: "GPIO5", i2c_scl: "GPIO6", gpio_out: "GPIO2" },
      wiring: {
        buses: [
          {
            type: "i2c",
            id: "I2C0",
            signals: [{ role: "SDA", gpio: "GPIO5" }, { role: "SCL", gpio: "GPIO6" }],
            devices: [{ name: "SSD1306 OLED", type: "display", addr: "0x3C" }],
          },
        ],
        standalone: [{ name: "Status LED", pin: "GPIO2", type: "gpio_out", external_components: "220Ω series resistor" }],
      },
    },
  });

  const wiring = document.getElementById("wiring")!;
  // Exactly two cards: the OLED and the LED — no phantom third component.
  assert.equal(wiring.querySelectorAll(".comp-card").length, 2);
  assert.doesNotMatch(wiring.innerHTML, /Peripheral/);
  // The OLED renders by its own identity + I2C address + bus signals.
  assert.match(wiring.innerHTML, /SSD1306 OLED/);
  assert.match(wiring.innerHTML, /0x3C/);
  assert.match(wiring.innerHTML, /Data \(SDA\)/);
  assert.match(wiring.innerHTML, /GPIO5/);
  // The LED is its own card with its pin + external component note.
  assert.match(wiring.innerHTML, /Status LED/);
  assert.match(wiring.innerHTML, /GPIO2/);
  assert.match(wiring.innerHTML, /220Ω series resistor/);
  // The chip label appears once (the OLED's own name), never stamped globally
  // onto the LED card.
  assert.equal((wiring.innerHTML.match(/ssd1306/gi) || []).length, 1);
});

test("manifest_updated shows the real board from a rich manifest's mcu (not the 'Target board' placeholder)", async () => {
  const dom = await loadWebview();
  const { document } = dom.window;

  // The exact shape agent-backed-loop emits for a rich upstream manifest:
  // { ...manifest, wiring } — the board lives under mcu.board/mcu.model and there
  // is NO board_id. Reading only board_id used to degrade to the placeholder and
  // drop the MCU from the diagram entirely.
  post(dom, {
    type: "manifest_updated",
    manifest: {
      schema_version: "1.0",
      mcu: { model: "ESP32-S3", board: "esp32-s3-devkitc-1" },
      devices: [{ name: "SSD1306 OLED", type: "display", interface: "I2C", i2c_addr: ["0x3C"] }],
      wiring: {
        buses: [
          {
            type: "i2c",
            id: "I2C0",
            signals: [{ role: "SDA", gpio: "GPIO5" }, { role: "SCL", gpio: "GPIO6" }],
            devices: [{ name: "SSD1306 OLED", type: "display", addr: "0x3C" }],
          },
        ],
        standalone: [],
      },
    },
  });

  const wiring = document.getElementById("wiring")!;
  assert.match(wiring.innerHTML, /esp32-s3-devkitc-1/, "the wiring card header names the actual board");
  assert.doesNotMatch(wiring.innerHTML, /Target board/, "no generic placeholder when the board is known");
});

test("manifest_updated renders every pin of a multi-pin standalone part (no dropped pins)", async () => {
  const dom = await loadWebview();
  const { document } = dom.window;

  // An HX711 load-cell ADC wired to two GPIOs must show BOTH pins on its one card.
  post(dom, {
    type: "manifest_updated",
    manifest: {
      board_id: "esp32-s3-devkitc-1",
      wiring: {
        buses: [],
        standalone: [{ name: "HX711", type: "gpio_out", pin: "GPIO4", pins: [{ name: "DT", gpio: "GPIO4" }, { name: "SCK", gpio: "GPIO5" }] }],
      },
    },
  });

  const wiring = document.getElementById("wiring")!;
  assert.equal(wiring.querySelectorAll(".comp-card").length, 1, "one card for the part");
  assert.equal(wiring.querySelectorAll(".pin-row").length, 2, "both pins rendered");
  assert.match(wiring.innerHTML, /GPIO4/);
  assert.match(wiring.innerHTML, /GPIO5/);
});

test("diagram module path with a double-quote cannot break out of the title attribute", async () => {
  const dom = await loadWebview();
  const { document } = dom.window;

  // The diagram JSON is agent/LLM-authored; a quote in a module path must be
  // escaped, not break out of title="..." and inject attributes.
  post(dom, {
    type: "diagram_updated",
    diagram: {
      architecture: { layers: [{ id: "x", label: "L", modules: [{ name: "m", path: 'a" onmouseover="alert(1)' }] }] },
      flow: [],
    },
  });

  const mod = document.querySelector(".diagram-module") as any;
  assert.ok(mod, "module rendered");
  // The raw quote+handler text is preserved verbatim as the title value (escaped),
  // and no stray onmouseover attribute leaked onto the element.
  assert.equal(mod.getAttribute("title"), 'a" onmouseover="alert(1)');
  assert.equal(mod.hasAttribute("onmouseover"), false, "no attribute breakout");
  assert.match(document.getElementById("diagram")!.innerHTML, /&quot;/, "quote is HTML-escaped in the markup");
});

test("diagram_updated renders the architecture layers + run flow in the Diagram tab", async () => {
  const dom = await loadWebview();
  const { document } = dom.window;

  // Empty until a diagram arrives.
  assert.equal(document.querySelector('.tab[data-tab="diagram"]') != null, true, "Diagram tab exists");
  assert.equal(document.getElementById("diagramEmpty")!.classList.contains("hidden"), false);

  post(dom, {
    type: "diagram_updated",
    diagram: {
      architecture: {
        layers: [
          { id: "task", label: "Task Layer", modules: [{ name: "tasks.sensor_task", path: "firmware/tasks/sensor_task.py", role: "read + format" }] },
          { id: "driver", label: "Driver Layer", modules: [{ name: "drivers.aht20_driver", path: "firmware/drivers/aht20_driver/__init__.py" }] },
        ],
      },
      flow: [
        { seq: 1, phase: "boot", action: "boot", detail: "WDT + sleep(3)" },
        { seq: 2, phase: "run", action: "loop", detail: "read -> display" },
      ],
    },
  });

  const diagram = document.getElementById("diagram")!;
  assert.equal(document.getElementById("diagramEmpty")!.classList.contains("hidden"), true, "empty state hidden once rendered");
  assert.match(diagram.innerHTML, /Task Layer/);
  assert.match(diagram.innerHTML, /tasks\.sensor_task/);
  assert.match(diagram.innerHTML, /Driver Layer/);
  assert.match(diagram.innerHTML, /drivers\.aht20_driver/);
  // Run-flow steps render in order.
  assert.match(diagram.innerHTML, /boot/);
  assert.match(diagram.innerHTML, /read -&gt; display/);
});

test("diagram_updated renders cross_layer_deps + data_flow from an LLM-authored diagram.json", async () => {
  const dom = await loadWebview();
  const { document } = dom.window;

  post(dom, {
    type: "diagram_updated",
    diagram: {
      architecture: {
        layers: [{ id: "entry", label: "Entry Layer", modules: [{ name: "main", path: "firmware/main.py" }] }],
        cross_layer_deps: [{ from: "main", to: "drivers.aht20_driver", label: "inject" }],
      },
      flow: [{ seq: 1, phase: "run", action: "loop", detail: "read -> display" }],
      data_flow: [{ from: "tasks.sensor_task", to: "tasks.display_task", data: "temp reading", channel: "shared_dict", rate: "1Hz" }],
    },
  });

  const diagram = document.getElementById("diagram")!;
  // Dependencies section: heading + edge endpoints + label.
  assert.match(diagram.innerHTML, /Dependencies/);
  assert.match(diagram.innerHTML, /drivers\.aht20_driver/);
  assert.match(diagram.innerHTML, /inject/);
  // Data-flow section: heading + endpoints + "data · rate" meta.
  assert.match(diagram.innerHTML, /Data flow/);
  assert.match(diagram.innerHTML, /tasks\.sensor_task/);
  assert.match(diagram.innerHTML, /temp reading · 1Hz/);
});

test("diagram_updated with an empty diagram keeps the empty state (no throw)", async () => {
  const dom = await loadWebview();
  const { document } = dom.window;
  post(dom, { type: "diagram_updated", diagram: { architecture: { layers: [] }, flow: [] } });
  assert.equal(document.getElementById("diagramEmpty")!.classList.contains("hidden"), false);
});

// The manifest-derived diagram (deriveDiagram) carries only neutral layer ids and
// flow phases; the webview localizes them, while device names / mcu / interface
// tokens stay as identifiers.
const DERIVED_DIAGRAM = {
  architecture: {
    layers: [
      { id: "entry", modules: [{ name: "main.py" }] },
      { id: "driver", modules: [{ name: "SSD1306 OLED", role: "I2C", path: "display" }, { name: "AHT20", role: "I2C", path: "temperature_sensor" }] },
      { id: "board", modules: [{ name: "ESP32-C3", role: "MCU" }] },
    ],
  },
  flow: [
    { phase: "init", detail: "I2C" },
    { phase: "scan", detail: "SSD1306 OLED, AHT20" },
    { phase: "create", detail: "SSD1306 OLED, AHT20" },
    { phase: "run" },
  ],
};

test("derived diagram (neutral ids/phases) renders localized English labels + raw identifiers", async () => {
  const dom = await loadWebview();
  const { document } = dom.window;

  post(dom, { type: "diagram_updated", diagram: DERIVED_DIAGRAM });

  const diagram = document.getElementById("diagram")!;
  assert.equal(document.getElementById("diagramEmpty")!.classList.contains("hidden"), true);
  // Layer ids -> English labels.
  for (const label of ["Entry", "Driver", "Board"]) assert.match(diagram.innerHTML, new RegExp(label));
  // Flow phases -> English actions.
  for (const action of ["Initialize bus", "Scan devices", "Create drivers", "Run loop"]) assert.match(diagram.innerHTML, new RegExp(action));
  // Identifiers are not translated.
  assert.match(diagram.innerHTML, /SSD1306 OLED/);
  assert.match(diagram.innerHTML, /ESP32-C3/);
});

test("derived diagram renders Chinese labels once the session locale is zh", async () => {
  const dom = await loadWebview();
  const { document } = dom.window;

  // Flip the UI language the same way a real session does: submit a Chinese intent.
  (document.getElementById("intent") as any).value = "用 OLED 显示温度";
  (document.getElementById("generate") as any).click();

  post(dom, { type: "diagram_updated", diagram: DERIVED_DIAGRAM });

  const diagram = document.getElementById("diagram")!;
  for (const label of ["入口层", "驱动层", "板级层"]) assert.match(diagram.innerHTML, new RegExp(label));
  for (const action of ["初始化总线", "扫描器件", "创建驱动", "运行循环"]) assert.match(diagram.innerHTML, new RegExp(action));
  // Identifiers stay untranslated even in zh.
  assert.match(diagram.innerHTML, /SSD1306 OLED/);
});

test("credits message updates the quota label and gates Start", async () => {
  const dom = await loadWebview();
  const { document } = dom.window;
  const generate = document.getElementById("generate") as HTMLButtonElement;

  post(dom, { type: "session_event", event: { kind: "credits", balance: 47, dailyGrant: 50 } });
  assert.equal(document.getElementById("qUsed")!.textContent, "47");
  assert.equal(generate.disabled, false, "credits available -> Start enabled");

  post(dom, { type: "session_event", event: { kind: "credits", balance: 0, dailyGrant: 50 } });
  assert.equal(document.getElementById("qUsed")!.textContent, "0");
  assert.ok(document.getElementById("quota")!.classList.contains("exhausted"));
  assert.equal(generate.disabled, true, "out of credits -> Start disabled");
});

test("a stub server_mode reveals the STUB badge so a stub backend can't be mistaken for a hang", async () => {
  const dom = await loadWebview();
  const { document } = dom.window;
  const badge = document.getElementById("modeBadge")!;

  // Hidden by default — most sessions talk to a live backend.
  assert.ok(badge.classList.contains("hidden"), "badge hidden before any server_mode");

  // A stub backend reveals the badge, with the localized label + a tooltip that
  // explains how to get real output.
  post(dom, { type: "server_mode", mode: "stub" });
  assert.equal(badge.classList.contains("hidden"), false, "stub mode reveals the badge");
  assert.equal(badge.textContent, "Stub");
  assert.match(badge.getAttribute("title")!, /fixed reply|MPYHW_LLM_STUB/);

  // Switching back to live hides it again.
  post(dom, { type: "server_mode", mode: "live" });
  assert.ok(badge.classList.contains("hidden"), "live mode hides the badge");
});

test("summary text is HTML-escaped, not injected as live markup (XSS guard)", async () => {
  const dom = await loadWebview();
  const { document } = dom.window;

  // The model's final reply renders through the markdown/innerHTML path — the place
  // an escaping regression would be exploitable. (Mid-process narration is suppressed.)
  post(dom, { type: "summary", text: "Generated <script>alert(1)</script> done" });

  const activity = document.getElementById("activity")!;
  assert.equal(activity.querySelectorAll("script").length, 0, "no <script> element injected from summary text");
  assert.match(activity.innerHTML, /&lt;script&gt;/, "angle brackets escaped in rendered HTML");
});

test("trace_event drives one working spinner — raw reasoning never leaks; a known tool step shows a curated phase label", async () => {
  const dom = await loadWebview();
  const { document } = dom.window;
  const activity = document.getElementById("activity")!;

  (document.getElementById("intent") as HTMLTextAreaElement).value = "x"; // no CJK -> en locale
  (document.getElementById("generate") as HTMLButtonElement).click();
  const label = () => activity.querySelector(".feed-pending .pending-label")!.textContent;

  // A trace_event WITHOUT a tool name (raw model narration) must not surface its
  // text — the single spinner card stays on the neutral working label.
  post(dom, { type: "trace_event", event: { text: "让我换个思路，先读板子资料。" } });
  assert.equal(label(), "Working…", "neutral working label, never the raw reasoning");
  assert.doesNotMatch(activity.textContent!, /换个思路|读板子/, "raw chain-of-thought never reaches the DOM");

  // A trace_event WITH a recognized tool name shows the curated, localized phase —
  // reusing the same single spinner card, not a new one.
  post(dom, { type: "trace_event", event: { text: "Generating code", toolName: "generate_code" } });
  assert.equal(activity.querySelectorAll(".feed-pending").length, 1, "still a single spinner card");
  assert.equal(label(), "Generating code…", "label follows the tool phase");
  assert.doesNotMatch(label()!, /\d+s/, "no per-second timer leaks");

  post(dom, { type: "session_done", terminal: "generated" }); // ends the run
});

test("Restart is available mid-run and wipes the feed and every tab back to its empty state", async () => {
  const posted: any[] = [];
  const dom = await loadWebview(posted);
  const { document } = dom.window;
  const activity = document.getElementById("activity")!;
  posted.length = 0;

  // Build up some conversation surface: a reply card in the feed + a rendered
  // wiring view (its empty placeholder hidden).
  post(dom, { type: "summary", text: "Done — wired the OLED." });
  post(dom, { type: "manifest_updated", manifest: { board_id: "esp32-s3-devkitc-1", wiring: [{ role: "i2c_sda", pin: "GPIO5" }] } });
  assert.ok(activity.querySelector(".ev-card"), "a reply card is present before reset");
  assert.equal(document.getElementById("wiringEmpty")!.classList.contains("hidden"), true, "wiring empty hidden once a manifest rendered");

  (document.getElementById("intent") as HTMLTextAreaElement).value = "next project";
  (document.getElementById("generate") as HTMLButtonElement).click();
  const restart = document.getElementById("newSession") as HTMLButtonElement;
  assert.equal(restart.textContent?.trim(), "Restart");
  assert.equal(restart.disabled, false, "restart stays clickable while a session is running");

  posted.length = 0;
  restart.click();

  assert.equal(posted[0]?.type, "reset_session", "host state reset is requested");
  assert.equal(activity.innerHTML, "", "the feed is wiped");
  assert.equal(document.getElementById("activityEmpty")!.classList.contains("hidden"), false, "activity empty state restored");
  assert.equal(document.getElementById("wiring")!.innerHTML, "", "wiring view wiped");
  assert.equal(document.getElementById("wiringEmpty")!.classList.contains("hidden"), false, "wiring empty state restored");
  assert.equal((document.getElementById("generate") as HTMLButtonElement).textContent, "Generate", "running state is cleared locally");
});

test("a session_busy message clears the local running state so the UI can't hang", async () => {
  const dom = await loadWebview();
  const { document } = dom.window;
  (document.getElementById("intent") as HTMLTextAreaElement).value = "x";
  (document.getElementById("generate") as HTMLButtonElement).click();
  assert.equal((document.getElementById("generate") as HTMLButtonElement).textContent, "Stop", "running after generate");

  post(dom, { type: "session_busy" });
  assert.equal((document.getElementById("generate") as HTMLButtonElement).textContent, "Generate", "session_busy clears the running spinner");
});

test("a summary message renders exactly one final result card", async () => {
  const dom = await loadWebview();
  const { document } = dom.window;
  const activity = document.getElementById("activity")!;

  post(dom, { type: "summary", text: "已生成代码：用 ssd1306 驱动 OLED 显示温度。" });

  const cards = activity.querySelectorAll(".ev-card");
  assert.equal(cards.length, 1, "one result card");
  assert.match(activity.textContent!, /已生成代码/);
});

test("the model's reply streams token-by-token into one card, finalized as rendered markdown", async () => {
  const dom = await loadWebview();
  const { document } = dom.window;
  const activity = document.getElementById("activity")!;

  // Live tokens append to a single growing reply card (plain text while streaming).
  post(dom, { type: "summary_delta", text: "用 **" });
  post(dom, { type: "summary_delta", text: "ssd1306** 显示温度。" });
  assert.equal(activity.querySelectorAll(".ev-card").length, 1, "one growing reply card");
  assert.match(activity.textContent!, /用 \*\*ssd1306\*\* 显示温度。/, "raw text shown while streaming");

  // The final summary finalizes that SAME card with rendered markdown — no duplicate.
  post(dom, { type: "summary", text: "用 **ssd1306** 显示温度。" });
  assert.equal(activity.querySelectorAll(".ev-card").length, 1, "still one card after finalize");
  assert.ok(activity.querySelector(".ev-sum strong"), "markdown bolded after finalize");
  assert.doesNotMatch(activity.textContent!, /\*\*/, "raw asterisks gone after finalize");
});

test("streamed narration is discarded when its turn calls a tool, leaving no card", async () => {
  const dom = await loadWebview();
  const { document } = dom.window;
  const activity = document.getElementById("activity")!;

  // Narration streams in, then its turn calls a tool -> the host sends summary_discard.
  post(dom, { type: "summary_delta", text: "让我先读板子资料。" });
  assert.equal(activity.querySelectorAll(".ev-card").length, 1, "narration shows live");
  post(dom, { type: "summary_discard" });
  assert.equal(activity.querySelectorAll(".ev-card").length, 0, "discarded narration leaves no card");

  // The real, tool-free reply then streams into a fresh card and finalizes.
  post(dom, { type: "summary_delta", text: "完成。" });
  post(dom, { type: "summary", text: "完成。" });
  assert.equal(activity.querySelectorAll(".ev-card").length, 1, "only the final reply remains");
  assert.match(activity.textContent!, /完成。/);
});

test("ask_user lead-in is sealed (kept), and the question card lands below it", async () => {
  const dom = await loadWebview();
  const { document } = dom.window;
  const activity = document.getElementById("activity")!;

  // Lead-in streams in, then its turn calls ask_user -> the host sends summary_seal.
  post(dom, { type: "summary_delta", text: "我可以帮你做 **温度显示**。" });
  post(dom, { type: "summary_seal" });
  assert.equal(activity.querySelectorAll(".ev-card").length, 1, "sealed lead-in stays as a card");
  assert.ok(activity.querySelector(".ev-sum strong"), "sealed lead-in renders markdown");

  // The question card then lands below the kept lead-in — both visible.
  post(dom, { type: "ui_prompt_needed", promptId: "p-seal", question: "用哪块板子？", options: [] });
  assert.equal(activity.querySelectorAll(".ev-card").length, 2, "lead-in and question both present");
  assert.match(activity.textContent!, /我可以帮你做/, "lead-in survives");
  assert.equal(document.querySelector(".ask-q")!.textContent, "用哪块板子？");
});

test("with animation available, question text reveals progressively then finishes as markdown", async () => {
  const dom = await loadWebview();
  const { document } = dom.window;
  // jsdom has no requestAnimationFrame, so the typewriter renders instantly there.
  // Inject a controllable one and drive frames by hand to observe the typed reveal.
  const cbs: Array<(t: number) => void> = [];
  let now = 0;
  (dom.window as any).requestAnimationFrame = (cb: (t: number) => void) => { cbs.push(cb); return cbs.length; };
  const flush = (ms: number) => { now += ms; for (const cb of cbs.splice(0)) cb(now); };

  const question = "一二三四五六七八九十甲乙丙丁戊己庚辛壬癸子丑寅卯辰巳午未申酉戌亥"; // 32 chars, no markdown
  post(dom, { type: "ui_prompt_needed", promptId: "p-anim", question, options: [] });
  const ask = document.querySelector(".ask-q")!;
  assert.equal(ask.textContent, "", "nothing typed before the first frame runs");

  flush(16); // baseline frame establishes the clock
  flush(16); // reveals a first slice
  const mid = ask.textContent || "";
  assert.ok(mid.length > 0 && mid.length < question.length, "partially revealed mid-animation");

  for (let i = 0; i < 50 && cbs.length; i++) flush(50); // drain to completion
  assert.match(ask.innerHTML, /一二三四五六七八九十甲乙丙丁戊己庚辛壬癸/, "fully revealed and rendered when done");
});

test("with animation available, streamed code reveals progressively then finalizes as rows", async () => {
  const dom = await loadWebview();
  const { document } = dom.window;
  const activity = document.getElementById("activity")!;
  const cbs: Array<(t: number) => void> = [];
  let now = 0;
  (dom.window as any).requestAnimationFrame = (cb: (t: number) => void) => { cbs.push(cb); return cbs.length; };
  const flush = (ms: number) => { now += ms; for (const cb of cbs.splice(0)) cb(now); };

  // ~199 chars: more than one frame's reveal (code paces at ~2 chars/ms), under the 500 cap.
  const code = Array.from({ length: 8 }, (_, i) => `print('streamed line ${i}')`).join("\n");
  post(dom, { type: "code_delta", text: code, path: "main.py" });
  const pre = activity.querySelector(".code-pre")!;
  assert.equal(pre.textContent, "", "nothing revealed before the first frame runs");

  flush(16); // baseline frame establishes the clock
  flush(16); // reveals a first slice
  const mid = pre.textContent || "";
  assert.ok(mid.length > 0 && mid.length < code.length, "code partially revealed mid-stream");

  for (let i = 0; i < 50 && cbs.length; i++) flush(50); // drain the reveal
  assert.equal(pre.textContent, code, "fully revealed as plain text — code is never markdown-rendered");

  // code_updated then swaps the streaming <pre> for highlighted, line-numbered rows.
  post(dom, { type: "code_updated", code, path: "main.py" });
  assert.ok(activity.querySelector(".code-block"), "finalized as a code block");
  assert.equal(activity.querySelector(".code-pre"), null, "the streaming <pre> was replaced");
});

test("a code burst larger than the cap reveals at once instead of crawling", async () => {
  const dom = await loadWebview();
  const { document } = dom.window;
  const activity = document.getElementById("activity")!;
  const cbs: Array<(t: number) => void> = [];
  let now = 0;
  (dom.window as any).requestAnimationFrame = (cb: (t: number) => void) => { cbs.push(cb); return cbs.length; };
  const flush = (ms: number) => { now += ms; for (const cb of cbs.splice(0)) cb(now); };

  // A whole file landing in one chunk: well over the 500-char burst cap.
  const big = Array.from({ length: 80 }, (_, i) => `x_${i} = ${i} * 1000  # padding to exceed the burst cap`).join("\n");
  assert.ok(big.length > 1500, "fixture exceeds the cap");
  post(dom, { type: "code_delta", text: big, path: "main.py" });
  const pre = activity.querySelector(".code-pre")!;

  flush(16); // baseline establishes the clock
  flush(16); // one paced step, then the backlog cap jumps straight to the end
  assert.equal(pre.textContent, big, "burst skipped the slow crawl and showed at once");
});

test("ask_user trace is not rendered beside the interactive question card", async () => {
  const dom = await loadWebview();
  const { document } = dom.window;
  const question = "你想做一个什么样的温度计？";

  post(dom, { type: "trace_event", event: { text: `ask_user: ${question}` } });
  post(dom, { type: "ui_prompt_needed", promptId: "p1", question, options: [] });

  const activityText = document.getElementById("activity")!.textContent!;
  assert.equal((activityText.match(new RegExp(question, "g")) ?? []).length, 1);
  assert.doesNotMatch(activityText, /ask_user/);
});

test("ask_user question renders markdown (bold labels + numbered list, no literal asterisks)", async () => {
  const dom = await loadWebview();
  const { document } = dom.window;

  // The agent writes clarifying questions in markdown (bold labels, numbered
  // lists). The question card must render it, not show raw ** and a run-on line.
  post(dom, {
    type: "ui_prompt_needed",
    promptId: "p-md",
    question: "你想做哪一种？\n1. **屏幕聊天机** — 带屏幕\n2. **语音机器人** — 带麦克风",
    options: [],
  });

  const ask = document.querySelector(".ask-q")!;
  assert.ok(ask.querySelector("strong"), "bold label rendered as <strong>");
  assert.ok(ask.querySelector("li"), "numbered item rendered as a list item");
  assert.doesNotMatch(ask.innerHTML, /\*\*/, "no literal ** asterisks remain");
});

test("plan prompt renders user-facing selection details without string-indexed logic", async () => {
  const dom = await loadWebview();
  const { document } = dom.window;

  post(dom, {
    type: "plan_needed",
    promptId: "plan-1",
    plan: {
      intent: "Read AHT20 sensor temperature and humidity every 2 seconds, display on SSD1306 OLED.",
      boardId: "esp32-s3-devkitc-1",
      capabilities: ["temperature_sensing", "humidity_sensing", "display_text"],
      packages: ["aht20_driver", "ssd1306"],
      wiring: [{ role: "i2c_sda", pin: "GPIO5" }, { role: "i2c_scl", pin: "GPIO6" }],
      logic: "Read AHT20 sensor temperature and humidity every 2 seconds, display on SSD1306 OLED.",
      estimate: 4,
    },
  });

  const activityText = document.getElementById("activity")!.textContent!;
  assert.match(activityText, /esp32-s3-devkitc-1/);
  assert.match(activityText, /aht20_driver/);
  assert.match(activityText, /ssd1306/);
  assert.doesNotMatch(activityText, /0=R/);
  assert.doesNotMatch(activityText, /Read AHT20 sensor temperature and humidity/);
});

test("the working spinner follows the phase in the session's language — neutral until a known tool step, raw reasoning never leaks", async () => {
  const dom = await loadWebview();
  const { document } = dom.window;
  const activity = document.getElementById("activity")!;

  // A Chinese request locks the UI to Chinese, so every label is the Chinese one.
  (document.getElementById("intent") as HTMLTextAreaElement).value = "闪烁一个 LED";
  (document.getElementById("generate") as HTMLButtonElement).click();
  const label = () => activity.querySelector(".feed-pending .pending-label")!.textContent;
  assert.equal(label(), "处理中…", "the spinner starts on the neutral working label, localized");

  // A trace without a tool name (raw narration) stays neutral and never leaks its text.
  post(dom, { type: "trace_event", event: { text: "让我先读板子资料" } });
  assert.equal(label(), "处理中…", "raw narration keeps the neutral label");
  assert.doesNotMatch(activity.textContent!, /读板子资料/, "raw chain-of-thought never reaches the DOM");

  // A recognized tool step shows the curated, localized phase — no timer.
  post(dom, { type: "trace_event", event: { text: "Generating code", toolName: "generate_code" } });
  assert.equal(label(), "正在生成代码…", "the label follows the tool phase, localized");
  assert.doesNotMatch(label()!, /\d+s/, "no per-second timer");

  // The old 'nothing happening' copy that read as a hang is gone entirely.
  assert.doesNotMatch(html, /无新动作/, "the misleading idle copy was removed from the webview");

  post(dom, { type: "session_done", terminal: "generated" }); // ends the run
});

test("a Chinese request skins the whole UI in Chinese — no English labels around a Chinese summary", async () => {
  const dom = await loadWebview();
  const { document } = dom.window;

  // The session's language is detected from the request and locked. Static chrome
  // re-skins immediately.
  (document.getElementById("intent") as HTMLTextAreaElement).value = "做一个温度计";
  (document.getElementById("generate") as HTMLButtonElement).click();
  assert.equal(document.querySelector('.tab[data-tab="activity"]')!.textContent, "动态", "tabs localized");
  assert.equal((document.getElementById("intent") as HTMLTextAreaElement).placeholder, "我想做……（例如：温度超过 30°C 时点亮一颗红色 LED）", "composer placeholder localized");

  // The plan card (the reported mix) is fully Chinese: labels + friendly feature
  // names, while package ids and pins stay as identifiers.
  post(dom, {
    type: "plan_needed",
    promptId: "plan-zh",
    plan: { boardId: "rpi-pico-w", summary: "用 SSD1306 显示温度。", capabilities: ["display_text", "digital_output"], packages: ["ssd1306"], wiring: [{ role: "i2c_sda", pin: "GPIO5" }], estimate: 3 },
  });
  const activity = document.getElementById("activity")!.textContent!;
  assert.match(activity, /开发板/, "Board label localized");
  assert.match(activity, /功能/, "Features label localized");
  assert.match(activity, /驱动包/, "Packages label localized");
  assert.match(activity, /文字显示/, "capability display_text shown as a friendly Chinese name");
  assert.match(activity, /确认并生成/, "Confirm & generate localized");
  assert.match(activity, /本步预计/, "cost line localized");
  assert.match(activity, /ssd1306/, "package id kept as identifier");
  assert.match(activity, /GPIO5/, "pin kept as identifier");
  assert.doesNotMatch(activity, /Confirm & generate|Features|Packages|This step/, "no English chrome leaks into the Chinese plan card");
});

test("an English request keeps the chrome in English (no Chinese leaks)", async () => {
  const dom = await loadWebview();
  const { document } = dom.window;

  (document.getElementById("intent") as HTMLTextAreaElement).value = "build a thermometer";
  (document.getElementById("generate") as HTMLButtonElement).click();
  assert.equal(document.querySelector('.tab[data-tab="activity"]')!.textContent, "Activity", "tabs stay English");

  post(dom, {
    type: "plan_needed",
    promptId: "plan-en",
    plan: { boardId: "rpi-pico-w", capabilities: ["display_text"], packages: ["ssd1306"], wiring: [{ role: "i2c_sda", pin: "GPIO5" }], estimate: 3 },
  });
  const activity = document.getElementById("activity")!.textContent!;
  assert.match(activity, /Board/, "English Board label");
  assert.match(activity, /Text display/, "capability display_text shown as a friendly English name");
  assert.match(activity, /Confirm & generate/, "English confirm button");
  assert.doesNotMatch(activity, /[一-鿿]/, "no Chinese chrome in an English session");
});

test("the session locale locks at the first request — a later same-session request in another language does not flip the chrome", async () => {
  const dom = await loadWebview();
  const { document } = dom.window;

  // Turn 1: Chinese → the whole chrome localizes to Chinese.
  (document.getElementById("intent") as HTMLTextAreaElement).value = "做一个温度计";
  (document.getElementById("generate") as HTMLButtonElement).click();
  assert.equal(document.querySelector('.tab[data-tab="activity"]')!.textContent, "动态", "turn 1 localizes to Chinese");

  // The run ends; the user continues the SAME conversation (no Restart) with an
  // English follow-up. The session language is already locked, so the chrome must
  // stay Chinese — flipping it would leave the turn-1 Chinese cards beside English chrome.
  post(dom, { type: "session_done", terminal: "generated" });
  (document.getElementById("intent") as HTMLTextAreaElement).value = "make it blink faster";
  (document.getElementById("generate") as HTMLButtonElement).click();
  assert.equal(document.querySelector('.tab[data-tab="activity"]')!.textContent, "动态", "chrome stays Chinese for the follow-up");
});

test("Restart unlocks the session locale — a fresh project in another language re-detects", async () => {
  const dom = await loadWebview();
  const { document } = dom.window;

  (document.getElementById("intent") as HTMLTextAreaElement).value = "做一个温度计";
  (document.getElementById("generate") as HTMLButtonElement).click();
  assert.equal(document.querySelector('.tab[data-tab="activity"]')!.textContent, "动态", "first project is Chinese");

  // Restart clears the conversation; the next project is brand-new and may use a
  // different language, so detection runs again.
  (document.getElementById("newSession") as HTMLButtonElement).click();
  (document.getElementById("intent") as HTMLTextAreaElement).value = "build a thermometer";
  (document.getElementById("generate") as HTMLButtonElement).click();
  assert.equal(document.querySelector('.tab[data-tab="activity"]')!.textContent, "Activity", "new English project re-detects to English");
});

test("code card shows a filename header + Copy button and finalizes with line-numbered rows", async () => {
  const dom = await loadWebview();
  const { document } = dom.window;
  const activity = document.getElementById("activity")!;

  post(dom, { type: "code_delta", text: "from machine import Pin\n", path: "main.py" });
  const head = activity.querySelector(".code-card-head");
  assert.ok(head, "streaming code card has a header row");
  assert.match(head!.textContent!, /main\.py/, "header shows the filename");
  assert.ok(activity.querySelector(".code-copy"), "Copy button present");

  post(dom, { type: "code_updated", code: "from machine import Pin\nled = Pin(2)\n", path: "main.py" });
  assert.ok(activity.querySelector(".code-block"), "finalized as a code block");
  assert.ok(activity.querySelector(".tok-kw"), "keywords highlighted");
  assert.ok(activity.querySelector(".code-gut"), "line-number gutter present after finalize");
});

test("the Copy button hands the full code to the host", async () => {
  const dom = await loadWebview();
  const { document } = dom.window;
  const activity = document.getElementById("activity")!;
  const posted: any[] = [];
  // The webview's fallback vscode shim posts via console.log; intercept it so we
  // can assert the copy round-trip (the only inbound channel the host listens on).
  (dom.window as any).console.log = (m: any) => posted.push(m);

  post(dom, { type: "code_delta", text: "import time\n", path: "main.py" });
  post(dom, { type: "code_delta", text: "print('hi')\n", path: "main.py" });
  (activity.querySelector(".code-copy") as any).click();

  const copy = posted.find((m) => m && m.type === "copy_code");
  assert.ok(copy, "clicking Copy posts a copy_code message to the host");
  assert.match(copy.text, /import time\nprint\('hi'\)/, "copy carries the full streamed code");
});

test("confirming the build plan shows an immediate in-feed spinner that clears when code streams", async () => {
  const dom = await loadWebview();
  const { document } = dom.window;
  const activity = document.getElementById("activity")!;

  post(dom, {
    type: "plan_needed",
    promptId: "plan-1",
    plan: { boardId: "esp32-s3-devkitc-1", capabilities: [], packages: [], wiring: [], estimate: 4 },
  });
  (activity.querySelector(".plan-go") as HTMLButtonElement).click();
  assert.ok(activity.querySelector(".feed-pending"), "a pending spinner appears right after Confirm & generate");

  post(dom, { type: "code_delta", text: "import time\n", path: "main.py" });
  assert.equal(activity.querySelector(".feed-pending"), null, "pending spinner cleared once code streams");
});

test("plan card shows the model's summary and a revise box that posts feedback to the host", async () => {
  const dom = await loadWebview();
  const { document } = dom.window;
  const activity = document.getElementById("activity")!;
  const posted: any[] = [];
  // The fallback vscode shim posts via console.log (see the Copy test).
  (dom.window as any).console.log = (m: any) => posted.push(m);

  post(dom, {
    type: "plan_needed",
    promptId: "plan-7",
    plan: {
      boardId: "esp32-s3-devkitc-1",
      summary: "用 **SSD1306** OLED 显示温度，MPR121 做触摸。",
      capabilities: ["display_text"],
      packages: ["ssd1306"],
      wiring: [{ role: "i2c_sda", pin: "GPIO5" }],
      estimate: 4,
    },
  });

  // Narrative summary renders (markdown bolded) above the structured rows.
  const summaryEl = activity.querySelector(".plan-summary")!;
  assert.ok(summaryEl, "plan summary rendered");
  assert.ok(summaryEl.querySelector("strong"), "summary markdown bolded");

  // Typing a change + Revise posts a revise response carrying the feedback.
  const input = activity.querySelector(".plan-revise") as any;
  input.value = "把 OLED 换成 TFT";
  (activity.querySelector(".plan-edit") as HTMLButtonElement).click();

  const revise = posted.find((m) => m && m.type === "ui_prompt_response" && m.answer === "revise");
  assert.ok(revise, "Revise posts a revise response");
  assert.equal(revise.feedback, "把 OLED 换成 TFT");
});

test("component card renders devices as pre-ticked toggle chips; unticking one and confirming posts the kept set + additions", async () => {
  const dom = await loadWebview();
  const { document } = dom.window;
  const activity = document.getElementById("activity")!;
  const posted: any[] = [];
  (dom.window as any).console.log = (m: any) => posted.push(m);

  post(dom, {
    type: "components_needed",
    promptId: "comp-1",
    devices: [
      { name: "SSD1306 OLED 128x64", interface: "I2C" },
      { name: "WS2812 RGB LED", interface: "GPIO" },
    ],
  });

  // One toggle chip per device, all pre-selected (multi-select, not single-pick).
  const opts = [...activity.querySelectorAll(".comp-options .ask-opt")] as HTMLButtonElement[];
  assert.equal(opts.length, 2, "one chip per device");
  assert.ok(opts.every((o) => o.classList.contains("chosen")), "devices start ticked");
  assert.match(activity.textContent!, /SSD1306 OLED 128x64/);
  assert.match(activity.textContent!, /WS2812 RGB LED/);

  // Untick the LED (remove), type a missing part, confirm.
  const led = opts.find((o) => o.textContent!.includes("WS2812"))!;
  led.click();
  assert.ok(!led.classList.contains("chosen"), "clicking a ticked chip unticks it");
  (activity.querySelector(".comp-add") as HTMLInputElement).value = "加一个 DHT22 温湿度传感器";
  (activity.querySelector(".comp-go") as HTMLButtonElement).click();

  const confirm = posted.find((m) => m && m.type === "ui_prompt_response" && m.promptId === "comp-1");
  assert.ok(confirm, "Confirm posts a response");
  assert.equal(confirm.answer, "confirm");
  // Spread into a test-realm array: the webview builds it in the jsdom realm, whose
  // Array.prototype differs, so a direct deepStrictEqual would fail on prototype.
  assert.deepEqual([...confirm.devices], ["SSD1306 OLED 128x64"], "only the kept device names are sent");
  assert.equal(confirm.feedback, "加一个 DHT22 温湿度传感器");
});
