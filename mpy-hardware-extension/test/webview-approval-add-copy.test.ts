import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { after } from "node:test";

import { JSDOM } from "jsdom";

// Split out of webview-dom.test.ts (already far over the test-size budget): same
// real-webview assembly, scoped to the approval card's allow_add row wording.
//
// allow_add:true is NOT device-specific: upy-scaffold-plugin's scaffold_config card ships
// it for adding custom files/modules. The add row's "component" wording is only true for
// the device-list cards, so any other card must get the neutral copy — with the SAME
// added_items payload shape either way (it matches the reference host; consumers read
// item.name).
const rawHtml = readFileSync(new URL("../src/webview/index.html", import.meta.url), "utf-8");
const webviewCss = readFileSync(new URL("../src/webview/webview.css", import.meta.url), "utf-8");
const compDir = new URL("../src/webview/components/", import.meta.url);
const compOrder: string[] = JSON.parse(readFileSync(new URL("manifest.json", compDir), "utf-8"));
const webviewJs = compOrder.map((f) => readFileSync(new URL(f, compDir), "utf-8")).join("");
const html = rawHtml.replace("/*__WEBVIEW_CSS__*/", () => webviewCss).replace("//__WEBVIEW_JS__", () => webviewJs);

const openDoms: JSDOM[] = [];
after(() => { for (const d of openDoms) d.window.close(); });

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

function post(dom: JSDOM, data: unknown): void {
  dom.window.dispatchEvent(new dom.window.MessageEvent("message", { data }));
}

function allowAddCard(approval_id: string) {
  return {
    approval_id,
    question: "q",
    items: [{ id: "i1", name: "Item one", selected: true }],
    allow_add: true,
    actions: [{ label: "Confirm", value: "confirm", primary: true }],
  };
}

async function addRowPlaceholder(approval_id: string, promptId: string): Promise<string> {
  const posted: any[] = [];
  const dom = await loadWebview(posted);
  post(dom, { type: "approval_request", promptId, card: allowAddCard(approval_id) });
  const card = dom.window.document.querySelector(`[data-prompt-id="${promptId}"]`)!;
  const addInput = card.querySelector(".ask-input") as HTMLInputElement;
  assert.ok(addInput, "allow_add renders the add input");
  return addInput.placeholder;
}

test("device-list cards keep the component wording on the add row", async () => {
  assert.equal(await addRowPlaceholder("device_confirm", "p-copy-dev"), "Add a missing component…");
  assert.equal(await addRowPlaceholder("alternative_device", "p-copy-alt"), "Add a missing component…");
});

test("a non-device allow_add card (scaffold_config) gets neutral add copy", async () => {
  // Mutation guard: hardcoding tr("ask_add_ph") for every card makes this read "component"
  // and fail; the payload shape below stays byte-identical to the device cards'.
  assert.equal(await addRowPlaceholder("scaffold_config", "p-copy-scaffold"), "Add an item not listed…");
});

test("the neutral-copy card still posts the shared added_items shape", async () => {
  const posted: any[] = [];
  const dom = await loadWebview(posted);
  post(dom, { type: "approval_request", promptId: "p-copy-shape", card: allowAddCard("scaffold_config") });
  const card = dom.window.document.querySelector('[data-prompt-id="p-copy-shape"]')!;
  const addInput = card.querySelector(".ask-input") as HTMLInputElement;
  addInput.value = "firmware/lib/my_utils.py";
  posted.length = 0;
  (card.querySelector('button[data-answer="confirm"]') as HTMLButtonElement).click();
  const resp = posted.find((m) => m.type === "ui_prompt_response");
  assert.deepStrictEqual([...resp.added_items].map((i: any) => ({ ...i })), [
    { name: "firmware/lib/my_utils.py", type: "user_added", interface: "unknown", source: "user_specified" },
  ], "wording is card-aware, the payload contract is not");
});
