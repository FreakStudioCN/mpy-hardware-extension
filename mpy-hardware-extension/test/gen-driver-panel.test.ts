import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { JSDOM } from "jsdom";

import { GEN_DRIVER_TABS } from "../src/core/gen-driver-schema.ts";

// Loads the real shipped webview (assembled like readWebviewHtml) into jsdom and drives
// the gen-driver panel through window 'message' events, same as the host posts them.
const rawHtml = readFileSync(new URL("../src/webview/index.html", import.meta.url), "utf-8");
const webviewCss = readFileSync(new URL("../src/webview/webview.css", import.meta.url), "utf-8");
const webviewJs = readFileSync(new URL("../src/webview/webview.js", import.meta.url), "utf-8");
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

test("Generate reviews the source, then Confirm posts start_gen_driver", async () => {
  const posted: any[] = [];
  const dom = await loadWebview(posted);
  const { document } = dom.window;

  post(dom, { type: "gen_driver_config", tabs: GEN_DRIVER_TABS });
  (document.querySelector('.gd-tab[data-gdtab="chip"]') as HTMLButtonElement).click();
  // chip tab renders its full field set from the schema (text inputs + an interface select)
  assert.ok(document.querySelector("#gendriver select.gd-input"), "the chip tab renders the interface select");
  const chipModel = document.querySelector("#gendriver [data-gdkey='chip_model']") as HTMLInputElement;
  assert.ok(chipModel, "the chip_model field is present");
  chipModel.value = "SHT30";

  posted.length = 0;
  (document.querySelector("#gendriver .gd-gen") as HTMLButtonElement).click();
  assert.ok(document.querySelector("#gendriver .gd-confirm"), "Generate shows a driver_source_confirm card");
  assert.equal(posted.some((m) => m.type === "start_gen_driver"), false, "nothing launched before Confirm");

  (document.querySelector("#gendriver .gd-confirm .gd-gen") as HTMLButtonElement).click();
  const start = posted.find((m) => m.type === "start_gen_driver");
  assert.ok(start, "Confirm posts start_gen_driver");
  assert.equal(start.tabId, "chip");
  assert.equal(start.sourceType, "chip_model");
  assert.equal(start.values.chip_model, "SHT30");
});

test("a missing required field blocks the confirm card and does not launch", async () => {
  const posted: any[] = [];
  const dom = await loadWebview(posted);
  const { document } = dom.window;

  post(dom, { type: "gen_driver_config", tabs: GEN_DRIVER_TABS });
  (document.querySelector('.gd-tab[data-gdtab="github"]') as HTMLButtonElement).click();
  posted.length = 0;
  (document.querySelector("#gendriver .gd-gen") as HTMLButtonElement).click(); // Repo URL left empty

  assert.equal(document.querySelector("#gendriver .gd-confirm"), null, "no confirm card when a required field is missing");
  assert.match(document.getElementById("gendriver")!.textContent!, /Fill required/);
  assert.equal(posted.some((m) => m.type === "start_gen_driver"), false, "not launched");
});

test("the global tools Generate Missing Hardware Driver button opens the Driver panel", async () => {
  const dom = await loadWebview();
  const { document } = dom.window;

  const btn = document.querySelector("#globalTools #genDriverOpen") as HTMLButtonElement;
  assert.match(btn.textContent!, /Generate Missing Hardware Driver/, "button carries the spec's full label");
  btn.click();
  assert.equal(
    document.querySelector('[data-view="gendriver"]')!.classList.contains("hidden"),
    false,
    "clicking the global-tools button reveals the Driver view",
  );
});

test("the verification-settings tab is config only (Generate disabled)", async () => {
  const dom = await loadWebview();
  const { document } = dom.window;

  post(dom, { type: "gen_driver_config", tabs: GEN_DRIVER_TABS });
  (document.querySelector('.gd-tab[data-gdtab="verification"]') as HTMLButtonElement).click();
  const gen = document.querySelector("#gendriver .gd-gen") as HTMLButtonElement;
  assert.equal(gen.disabled, true, "verification tab has no source, so Generate is disabled");
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

  posted.length = 0;
  (document.querySelector("#gendriver .gd-gen") as HTMLButtonElement).click(); // required file now set -> confirm
  (document.querySelector("#gendriver .gd-confirm .gd-gen") as HTMLButtonElement).click();
  const start = posted.find((m) => m.type === "start_gen_driver");
  assert.ok(start, "launch carries the picked file");
  assert.equal(start.values.pdf_file.sha256, "abc123");
  assert.equal(start.values.pdf_file.path, "/tmp/sht30.pdf");
});

test("gen_driver_status detail renders in the panel status line", async () => {
  const dom = await loadWebview();
  const { document } = dom.window;

  post(dom, { type: "gen_driver_config", tabs: GEN_DRIVER_TABS });
  post(dom, { type: "gen_driver_status", detail: "Received gen-driver request (mode=standalone)." });
  assert.match(document.getElementById("gendriver")!.textContent!, /mode=standalone/);
});
