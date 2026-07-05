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

  assert.ok(document.querySelector('.tab[data-tab="gendriver"]'), "Driver tab present in the chrome");
  assert.ok(posted.some((m) => m.type === "request_gen_driver_config"), "config requested on load");

  post(dom, { type: "gen_driver_config", tabs: GEN_DRIVER_TABS });
  const root = document.getElementById("gendriver")!;
  assert.equal(root.querySelectorAll(".gd-tab").length, GEN_DRIVER_TABS.length, "one sub-tab per source tab");
  assert.equal(document.getElementById("gendriverEmpty")!.classList.contains("hidden"), true, "empty state hidden once rendered");
});

test("Generate driver posts start_gen_driver with the picked source type and value", async () => {
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
  const start = posted.find((m) => m.type === "start_gen_driver");
  assert.ok(start, "clicking Generate posts start_gen_driver");
  assert.equal(start.tabId, "chip");
  assert.equal(start.sourceType, "chip_model");
  assert.equal(start.values.chip_model, "SHT30");
});

test("the verification-settings tab is config only (Generate disabled)", async () => {
  const dom = await loadWebview();
  const { document } = dom.window;

  post(dom, { type: "gen_driver_config", tabs: GEN_DRIVER_TABS });
  (document.querySelector('.gd-tab[data-gdtab="verification"]') as HTMLButtonElement).click();
  const gen = document.querySelector("#gendriver .gd-gen") as HTMLButtonElement;
  assert.equal(gen.disabled, true, "verification tab has no source, so Generate is disabled");
});

test("gen_driver_status detail renders in the panel status line", async () => {
  const dom = await loadWebview();
  const { document } = dom.window;

  post(dom, { type: "gen_driver_config", tabs: GEN_DRIVER_TABS });
  post(dom, { type: "gen_driver_status", detail: "Received gen-driver request (mode=standalone)." });
  assert.match(document.getElementById("gendriver")!.textContent!, /mode=standalone/);
});
