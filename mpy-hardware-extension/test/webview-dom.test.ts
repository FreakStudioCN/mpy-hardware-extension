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

async function loadWebview(): Promise<JSDOM> {
  const dom = new JSDOM(html, { runScripts: "dangerously" });
  await new Promise<void>((resolve) => {
    if (dom.window.document.readyState === "complete") resolve();
    else dom.window.addEventListener("load", () => resolve());
  });
  return dom;
}

function post(dom: JSDOM, data: unknown): void {
  dom.window.dispatchEvent(new dom.window.MessageEvent("message", { data }));
}

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

test("trace_event text is HTML-escaped, not injected as live markup (XSS guard)", async () => {
  const dom = await loadWebview();
  const { document } = dom.window;

  // "Generated ... done" routes through the markdown/innerHTML path (not the
  // textContent paths), which is where an escaping regression would be exploitable.
  post(dom, { type: "trace_event", event: { text: "Generated <script>alert(1)</script> done" } });

  const activity = document.getElementById("activity")!;
  assert.equal(activity.querySelectorAll("script").length, 0, "no <script> element injected from event text");
  assert.match(activity.innerHTML, /&lt;script&gt;/, "angle brackets escaped in rendered HTML");
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

test("working status names the live phase and drops the misleading 'idle' copy", async () => {
  const dom = await loadWebview();
  const { document } = dom.window;
  const status = document.getElementById("status")!;

  // Start a run the way the user does (intent + Generate click).
  (document.getElementById("intent") as HTMLTextAreaElement).value = "闪烁一个 LED";
  (document.getElementById("generate") as HTMLButtonElement).click();
  assert.equal(status.textContent, "thinking…", "seed status is the generic working label");

  // A known tool phase becomes the live status label immediately (no 1s wait).
  post(dom, { type: "trace_event", event: { text: "生成代码" } });
  assert.match(status.textContent!, /^生成代码… \d+s$/, "status names what the agent is doing");

  // The old 'nothing happening' copy that read as a hang is gone entirely.
  assert.doesNotMatch(html, /无新动作/, "the misleading idle copy was removed from the webview");

  post(dom, { type: "session_done", terminal: "generated" }); // clears the heartbeat interval
});

test("the working timer counts active work only — waiting for the user does not inflate it", async () => {
  const dom = await loadWebview();
  const { document } = dom.window;
  const status = document.getElementById("status")!;
  let now = 1000;
  dom.window.Date.now = () => now; // control the clock deterministically

  (document.getElementById("intent") as HTMLTextAreaElement).value = "读温度";
  (document.getElementById("generate") as HTMLButtonElement).click(); // segment starts at t=1000

  now = 6000; // 5s of real work
  post(dom, { type: "trace_event", event: { text: "生成代码" } });
  assert.equal(status.textContent, "生成代码… 5s");

  // Agent asks for a plan; the user dawdles 30s before answering — that gap must NOT count.
  post(dom, {
    type: "plan_needed",
    promptId: "plan-1",
    plan: { intent: "x", boardId: "b", capabilities: [], packages: [], wiring: [], logic: "x", estimate: 1 },
  });
  now = 36000; // 30s spent waiting on the user
  (document.querySelector(".plan-go") as HTMLButtonElement).click(); // resume; new segment at t=36000

  now = 38000; // 2s more real work
  post(dom, { type: "trace_event", event: { text: "检查代码" } });
  assert.equal(status.textContent, "检查代码… 7s", "5s + 2s active, not 37s wall-clock");

  post(dom, { type: "session_done", terminal: "generated" }); // clears the heartbeat interval
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
  assert.ok(activity.querySelector(".feed-pending"), "a pending spinner appears right after 确认生成");

  post(dom, { type: "code_delta", text: "import time\n", path: "main.py" });
  assert.equal(activity.querySelector(".feed-pending"), null, "pending spinner cleared once code streams");
});
