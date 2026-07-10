import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { JSDOM } from "jsdom";

import { GEN_DRIVER_TABS } from "../src/core/gen-driver-schema.ts";

// Loads the real shipped webview (assembled like readWebviewHtml) into jsdom and drives
// the gen-driver panel through window 'message' events, same as the host posts them. The
// webview JS is concatenated from webview/components/*.js in manifest (load) order —
// byte-identical to the pre-split webview.js, so the assertions below are unchanged.
const rawHtml = readFileSync(new URL("../src/webview/index.html", import.meta.url), "utf-8");
const webviewCss = readFileSync(new URL("../src/webview/webview.css", import.meta.url), "utf-8");
const compDir = new URL("../src/webview/components/", import.meta.url);
const compOrder: string[] = JSON.parse(readFileSync(new URL("manifest.json", compDir), "utf-8"));
const webviewJs = compOrder.map((f) => readFileSync(new URL(f, compDir), "utf-8")).join("");
const html = rawHtml.replace("/*__WEBVIEW_CSS__*/", () => webviewCss).replace("//__WEBVIEW_JS__", () => webviewJs);

async function loadWebview(posted?: any[]): Promise<JSDOM> {
  const dom = new JSDOM(html, {
    runScripts: "dangerously",
    beforeParse: posted
      ? (window) => {
          (window as any).acquireVsCodeApi = () => ({
            postMessage: (m: any) => posted.push(m),
            getState: () => null,
            setState: () => {},
          });
        }
      : undefined,
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

test("the Driver tab requests gen-driver config on load and renders the source tabs from the host", async () => {
  const posted: any[] = [];
  const dom = await loadWebview(posted);
  const { document } = dom.window;

  assert.equal(document.querySelector('.tab[data-tab="gendriver"]'), null, "gen-driver is a global tool, not a workflow tab");
  assert.ok(document.querySelector("#globalTools #genDriverOpen"), "gen-driver entry lives in the global tools area");
  assert.ok(posted.some((m) => m.type === "request_gen_driver_config"), "config requested on load");

  post(dom, { type: "gen_driver_config", tabs: GEN_DRIVER_TABS });
  const root = document.getElementById("gendriver")!;
  assert.equal(root.querySelectorAll(".gd-tab").length, GEN_DRIVER_TABS.length, "one sub-tab per source tab");
  assert.equal(document.getElementById("gendriverEmpty")!.classList.contains("hidden"), true, "empty state hidden once rendered");
});

test("adding sources builds the list, then Generate + Confirm posts sources[]", async () => {
  const posted: any[] = [];
  const dom = await loadWebview(posted);
  const { document } = dom.window;

  post(dom, { type: "gen_driver_config", tabs: GEN_DRIVER_TABS });
  (document.querySelector('.gd-tab[data-gdtab="chip"]') as HTMLButtonElement).click();
  assert.ok(document.querySelector("#gendriver select.gd-input"), "the chip tab renders the interface select");
  (document.querySelector("#gendriver [data-gdkey='chip_model']") as HTMLInputElement).value = "SHT30";

  // Generate is gated until at least one source is added
  assert.equal((document.querySelector("#gendriver .gd-gen") as HTMLButtonElement).disabled, true, "Generate disabled with no sources");
  (document.querySelector("#gendriver .gd-add") as HTMLButtonElement).click();
  assert.equal(document.querySelectorAll("#gendriver .gd-source-row").length, 1, "the source is added to the list");
  assert.equal((document.querySelector("#gendriver .gd-gen") as HTMLButtonElement).disabled, false, "Generate enabled once a source exists");

  posted.length = 0;
  (document.querySelector("#gendriver .gd-gen") as HTMLButtonElement).click();
  assert.ok(document.querySelector("#gendriver .gd-confirm"), "Generate shows the confirm card");
  assert.equal(posted.some((m) => m.type === "start_gen_driver"), false, "nothing launched before Confirm");

  (document.querySelector("#gendriver .gd-confirm .gd-gen") as HTMLButtonElement).click();
  const start = posted.find((m) => m.type === "start_gen_driver");
  assert.ok(start, "Confirm posts start_gen_driver");
  assert.equal(start.sources.length, 1);
  assert.equal(start.sources[0].type, "chip_model");
  assert.equal(start.sources[0].chip_model, "SHT30");
  // the interface select defaults to its first option (i2c), so it rides along
  assert.equal(start.sources[0].interface, "i2c");
  assert.equal(start.verification.policy, "hardware_required");
});

test("Add source blocks on a missing required field and does not add to the list", async () => {
  const dom = await loadWebview();
  const { document } = dom.window;

  post(dom, { type: "gen_driver_config", tabs: GEN_DRIVER_TABS });
  (document.querySelector('.gd-tab[data-gdtab="github"]') as HTMLButtonElement).click();
  (document.querySelector("#gendriver .gd-add") as HTMLButtonElement).click(); // Repo URL left empty

  assert.equal(document.querySelectorAll("#gendriver .gd-source-row").length, 0, "nothing added when a required field is missing");
  assert.match(document.querySelector("#gendriver .gd-add-status")!.textContent!, /Fill required/);
  assert.equal((document.querySelector("#gendriver .gd-gen") as HTMLButtonElement).disabled, true, "Generate stays disabled");
});

test("the global tools button opens the driver as a full-body surface, and Back returns", async () => {
  const dom = await loadWebview();
  const { document } = dom.window;

  const btn = document.querySelector("#globalTools #genDriverOpen") as HTMLButtonElement;
  assert.match(btn.textContent!, /Generate Missing Hardware Driver/, "button carries the spec's full label");

  btn.click();
  assert.equal(document.getElementById("toolGenDriver")!.classList.contains("hidden"), false, "tool surface is shown");
  assert.equal(document.querySelector(".tabwrap")!.classList.contains("hidden"), true, "workflow stage area is hidden");
  assert.equal(document.querySelector(".composer")!.classList.contains("hidden"), true, "composer is hidden");

  (document.getElementById("genDriverBack") as HTMLButtonElement).click();
  assert.equal(document.getElementById("toolGenDriver")!.classList.contains("hidden"), true, "Back closes the tool");
  assert.equal(document.querySelector(".tabwrap")!.classList.contains("hidden"), false, "workflow is restored");
});

test("the verification tab is config only (no Add source) and Generate is gated", async () => {
  const dom = await loadWebview();
  const { document } = dom.window;

  post(dom, { type: "gen_driver_config", tabs: GEN_DRIVER_TABS });
  (document.querySelector('.gd-tab[data-gdtab="verification"]') as HTMLButtonElement).click();
  assert.equal(document.querySelector("#gendriver .gd-add"), null, "verification tab has no + Add source (it is not a source)");
  assert.equal((document.querySelector("#gendriver .gd-gen") as HTMLButtonElement).disabled, true, "Generate disabled with no sources added");
});

test("a file-source tab picks a file through the host and carries its metadata to launch", async () => {
  const posted: any[] = [];
  const dom = await loadWebview(posted);
  const { document } = dom.window;

  post(dom, { type: "gen_driver_config", tabs: GEN_DRIVER_TABS });
  (document.querySelector('.gd-tab[data-gdtab="pdf"]') as HTMLButtonElement).click();

  // Choosing a file is a host round-trip: the panel asks, the host answers.
  posted.length = 0;
  (document.querySelector("#gendriver .gd-file-btn") as HTMLButtonElement).click();
  const ask = posted.find((m) => m.type === "pick_gen_driver_file");
  assert.ok(ask, "the Choose file button asks the host to open a dialog");
  assert.equal(ask.tabId, "pdf");
  assert.equal(ask.key, "pdf_file");

  const file = { name: "sht30.pdf", path: "/tmp/sht30.pdf", size: 2048, sha256: "abc123" };
  post(dom, { type: "gen_driver_file_picked", key: "pdf_file", ...file });
  assert.match(document.querySelector("#gendriver .gd-filename")!.textContent!, /sht30\.pdf/);

  (document.querySelector("#gendriver .gd-add") as HTMLButtonElement).click(); // add the pdf source
  assert.equal(document.querySelectorAll("#gendriver .gd-source-row").length, 1, "the pdf source is added");

  posted.length = 0;
  (document.querySelector("#gendriver .gd-gen") as HTMLButtonElement).click();
  (document.querySelector("#gendriver .gd-confirm .gd-gen") as HTMLButtonElement).click();
  const start = posted.find((m) => m.type === "start_gen_driver");
  assert.ok(start, "launch carries the picked file in sources[]");
  assert.equal(start.sources[0].type, "pdf");
  assert.equal(start.sources[0].pdf_file.sha256, "abc123");
  assert.equal(start.sources[0].pdf_file.path, "/tmp/sht30.pdf");
});

test("gen_driver_status detail renders in the panel status line", async () => {
  const dom = await loadWebview();
  const { document } = dom.window;

  post(dom, { type: "gen_driver_config", tabs: GEN_DRIVER_TABS });
  post(dom, { type: "gen_driver_status", detail: "Received gen-driver request (mode=standalone)." });
  assert.match(document.getElementById("gendriver")!.textContent!, /mode=standalone/);
});

test("a driver_request alone (no sources) enables Generate and is posted", async () => {
  const posted: any[] = [];
  const dom = await loadWebview(posted);
  const { document } = dom.window;

  post(dom, { type: "gen_driver_config", tabs: GEN_DRIVER_TABS });
  (document.querySelector('.gd-tab[data-gdtab="driver"]') as HTMLButtonElement).click();
  assert.equal(document.querySelector("#gendriver .gd-add"), null, "target-driver tab is config, no Add source");

  const chip = document.querySelector("#gendriver [data-gdkey='chip_model']") as HTMLInputElement;
  chip.value = "BMP390";
  chip.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  const addrs = document.querySelector("#gendriver [data-gdkey='i2c_addresses']") as HTMLInputElement;
  addrs.value = "0x76, 0x77";
  addrs.dispatchEvent(new dom.window.Event("input", { bubbles: true }));

  assert.equal((document.querySelector("#gendriver .gd-gen") as HTMLButtonElement).disabled, false, "driver_request opens the gate even with no sources");

  posted.length = 0;
  (document.querySelector("#gendriver .gd-gen") as HTMLButtonElement).click();
  (document.querySelector("#gendriver .gd-confirm .gd-gen") as HTMLButtonElement).click();
  const start = posted.find((m) => m.type === "start_gen_driver");
  assert.ok(start, "posts start_gen_driver");
  assert.equal(start.sources.length, 0);
  assert.equal(start.driverRequest.chip_model, "BMP390");
  assert.equal(start.driverRequest.i2c_addresses.length, 2);
  assert.equal(start.driverRequest.i2c_addresses[0], "0x76");
  assert.equal(start.verification.policy, "hardware_required");
});

test("the skip-verification toggle sets policy=skipped in the payload", async () => {
  const posted: any[] = [];
  const dom = await loadWebview(posted);
  const { document } = dom.window;

  post(dom, { type: "gen_driver_config", tabs: GEN_DRIVER_TABS });
  (document.querySelector('.gd-tab[data-gdtab="chip"]') as HTMLButtonElement).click();
  (document.querySelector("#gendriver [data-gdkey='chip_model']") as HTMLInputElement).value = "SHT30";
  (document.querySelector("#gendriver .gd-add") as HTMLButtonElement).click();

  (document.querySelector('.gd-tab[data-gdtab="verification"]') as HTMLButtonElement).click();
  const skip = document.querySelector("#gendriver [data-gdkey='skip_verification']") as HTMLInputElement;
  skip.checked = true;
  skip.dispatchEvent(new dom.window.Event("input", { bubbles: true }));

  posted.length = 0;
  (document.querySelector("#gendriver .gd-gen") as HTMLButtonElement).click();
  (document.querySelector("#gendriver .gd-confirm .gd-gen") as HTMLButtonElement).click();
  const start = posted.find((m) => m.type === "start_gen_driver");
  assert.ok(start, "posts start_gen_driver");
  assert.equal(start.verification.policy, "skipped");
  assert.equal(start.verification.required, false);
});
