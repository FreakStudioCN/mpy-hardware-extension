import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { after } from "node:test";

import { JSDOM } from "jsdom";

import { GEN_DRIVER_TABS, materializeGenDriverTabs } from "../src/core/gen-driver-schema.ts";

// A session manifest carrying one cold-driver item — what the host materializes the
// current tab from.
const COLD_MANIFEST = {
  board_id: "esp32-devkit-v1", mcu: "ESP32", phase: "select-hw",
  devices: [{ device_id: "sht30_th", name: "SHT30", interface: "i2c", i2c_addresses: ["0x44"], driver: { source: "cold-driver", status: "cold_driver_required" } }],
};

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

// DeviceToolsPanel installs a lifetime setInterval (presence poll). In a real webview the
// page teardown kills it; here every loaded window leaks a live timer that keeps node's
// event loop alive, so `node --test` never exits. Track and close each window at the end.
const openDoms: JSDOM[] = [];
after(() => { for (const d of openDoms) d.window.close(); });

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
  openDoms.push(dom);
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
  // field values live under metadata (sample wire shape); the first source is primary
  assert.equal(start.sources[0].metadata.chip_model, "SHT30");
  // the interface select defaults to its first option (i2c), so it rides along
  assert.equal(start.sources[0].metadata.interface, "i2c");
  assert.equal(start.sources[0].primary, true);
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
  assert.equal(start.sources[0].sha256, "abc123", "the file's sha256 is hoisted to the source top level");
  assert.equal(start.sources[0].metadata.pdf_file.path, "/tmp/sht30.pdf");
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

test("the current tab renders a cold-driver picker; its source carries device_id + driver_status", async () => {
  const posted: any[] = [];
  const dom = await loadWebview(posted);
  const { document } = dom.window;

  post(dom, { type: "gen_driver_config", tabs: materializeGenDriverTabs(GEN_DRIVER_TABS, COLD_MANIFEST) });
  // the current tab is first, so it renders active
  const sel = document.querySelector("#gendriver select.gd-input[data-gdkey='device_id']") as HTMLSelectElement;
  assert.ok(sel, "the current tab renders a device picker built from the manifest");
  assert.equal(sel.options.length, 1);
  assert.equal(sel.options[0].value, "sht30_th");
  assert.match(sel.options[0].textContent!, /SHT30/);
  assert.match(document.getElementById("gendriver")!.textContent!, /1 cold-driver item/, "shows the manifest context");

  (document.querySelector("#gendriver .gd-add") as HTMLButtonElement).click();
  assert.equal(document.querySelectorAll("#gendriver .gd-source-row").length, 1);
  posted.length = 0;
  (document.querySelector("#gendriver .gd-gen") as HTMLButtonElement).click();
  (document.querySelector("#gendriver .gd-confirm .gd-gen") as HTMLButtonElement).click();
  const start = posted.find((m) => m.type === "start_gen_driver");
  assert.equal(start.sources[0].type, "current_cold_driver_item");
  assert.equal(start.sources[0].metadata.device_id, "sht30_th");
  assert.equal(start.sources[0].metadata.driver_status, "cold_driver_required");
});

test("the current tab shows an empty state and no Add when there is no cold-driver item", async () => {
  const dom = await loadWebview();
  const { document } = dom.window;

  post(dom, { type: "gen_driver_config", tabs: materializeGenDriverTabs(GEN_DRIVER_TABS, { devices: [] }) });
  assert.match(document.getElementById("gendriver")!.textContent!, /No missing driver in the current session/);
  assert.equal(document.querySelector("#gendriver .gd-add"), null, "no + Add source in the empty state");
});

test("the confirm card shows source sha256, preprocess script, expected paths, and the skip warning", async () => {
  const dom = await loadWebview();
  const { document } = dom.window;

  post(dom, { type: "gen_driver_config", tabs: GEN_DRIVER_TABS });
  (document.querySelector('.gd-tab[data-gdtab="pdf"]') as HTMLButtonElement).click();
  (document.querySelector("#gendriver .gd-file-btn") as HTMLButtonElement).click();
  post(dom, { type: "gen_driver_file_picked", key: "pdf_file", name: "sht30.pdf", path: "/tmp/sht30.pdf", size: 2048, sha256: "deadbeefcafe1234" });
  (document.querySelector("#gendriver .gd-add") as HTMLButtonElement).click();

  (document.querySelector('.gd-tab[data-gdtab="driver"]') as HTMLButtonElement).click();
  const did = document.querySelector("#gendriver [data-gdkey='driver_id']") as HTMLInputElement;
  did.value = "sht30"; did.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  (document.querySelector('.gd-tab[data-gdtab="verification"]') as HTMLButtonElement).click();
  const skip = document.querySelector("#gendriver [data-gdkey='skip_verification']") as HTMLInputElement;
  skip.checked = true; skip.dispatchEvent(new dom.window.Event("input", { bubbles: true }));

  (document.querySelector("#gendriver .gd-gen") as HTMLButtonElement).click();
  const card = document.querySelector("#gendriver .gd-confirm")!.textContent!;
  assert.match(card, /sha256 deadbeefcafe/, "shows the source sha256");
  assert.match(card, /extract_pdf\.py/, "shows the pdf preprocess script");
  assert.match(card, /firmware\/drivers\/sht30_driver\/sht30\.py/, "derives expected artifact paths from the driver id");
  assert.match(card, /Warning: hardware verification skipped/, "warns when verification is skipped");
});

test("a chip + test scenario yields a suggested marker that rides into verification", async () => {
  const posted: any[] = [];
  const dom = await loadWebview(posted);
  const { document } = dom.window;

  post(dom, { type: "gen_driver_config", tabs: GEN_DRIVER_TABS });
  (document.querySelector('.gd-tab[data-gdtab="chip"]') as HTMLButtonElement).click();
  (document.querySelector("#gendriver [data-gdkey='chip_model']") as HTMLInputElement).value = "SHT30";
  (document.querySelector("#gendriver .gd-add") as HTMLButtonElement).click();

  (document.querySelector('.gd-tab[data-gdtab="verification"]') as HTMLButtonElement).click();
  const ts = document.querySelector("#gendriver [data-gdkey='test_scenario']") as HTMLInputElement;
  ts.value = "temp_humidity_read_ok"; ts.dispatchEvent(new dom.window.Event("input", { bubbles: true }));

  posted.length = 0;
  (document.querySelector("#gendriver .gd-gen") as HTMLButtonElement).click();
  (document.querySelector("#gendriver .gd-confirm .gd-gen") as HTMLButtonElement).click();
  const start = posted.find((m) => m.type === "start_gen_driver");
  assert.equal(start.verification.marker, "SELF_TEST_PASS:SHT30:TEMP_HUMIDITY_READ_OK");
});
