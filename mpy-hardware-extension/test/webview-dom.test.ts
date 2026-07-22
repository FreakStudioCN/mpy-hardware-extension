import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { after } from "node:test";

import { JSDOM } from "jsdom";

// Loads the REAL shipped webview (index.html + its sibling webview.css + the
// webview/components/*.js, assembled the same way readWebviewHtml() does) into jsdom and
// drives it through window 'message' events, exactly as the extension host posts them.
// The script falls back to a mock vscode when acquireVsCodeApi is absent, so no
// production extraction is needed. This is the only coverage of the streaming code card /
// renderWiring (dual-shape) / the deploy checkpoint / setCredits / the HTML-escape guard.
const rawHtml = readFileSync(new URL("../src/webview/index.html", import.meta.url), "utf-8");
const webviewCss = readFileSync(new URL("../src/webview/webview.css", import.meta.url), "utf-8");
// Same assembly as readWebviewHtml(): concatenate the components in manifest (load) order.
// The result is byte-identical to the pre-split webview.js, so every assertion below is
// unchanged — only where the bytes come from moved.
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
  openDoms.push(dom);
  return dom;
}

function post(dom: JSDOM, data: unknown): void {
  dom.window.dispatchEvent(new dom.window.MessageEvent("message", { data }));
}


test("start screen selects an official MicroPython board and sends full pre_selected_board", async () => {
  const posted: any[] = [];
  const dom = await loadWebview(posted);
  const { document } = dom.window;

  assert.equal(document.getElementById("modeBeginner")!.getAttribute("aria-pressed"), "true");
  assert.equal(document.getElementById("modeCustom")!.getAttribute("aria-pressed"), "false");
  assert.equal(document.getElementById("boardAuto")!.getAttribute("aria-pressed"), "true");
  assert.equal(document.getElementById("boardMore")!.getAttribute("aria-pressed"), "false");

  post(dom, {
    type: "micropython_boards",
    source_url: "https://micropython.org/download/",
    fetched_at: "2026-06-20T00:07:34+00:00",
    boards: [
      {
        id: "esp32-s3-devkitc",
        official_id: "ESP32_GENERIC_S3",
        display_name: "ESP32-S3",
        vendor: "Espressif",
        port: "esp32",
        mcu: "esp32s3",
        features: ["BLE", "WiFi"],
        firmware: { url: "https://micropython.org/download/ESP32_GENERIC_S3/", board_name: "ESP32_GENERIC_S3" },
        download_slug: "ESP32_GENERIC_S3",
        source_url: "https://micropython.org/download/",
        support_status: "builtin_pin_layout",
        local_board_id: "esp32-s3-devkitc-1",
        skill_board_id: "esp32-s3-devkitc",
      },
      {
        id: "PYBD_SF2",
        display_name: "Pyboard D-series SF2",
        vendor: "George Robotics",
        port: "stm32",
        mcu: "stm32f722",
        features: [],
        firmware: { url: "https://micropython.org/download/PYBD_SF2/", board_name: "PYBD_SF2" },
        download_slug: "PYBD_SF2",
        source_url: "https://micropython.org/download/",
        support_status: "official_firmware_only",
      },
    ],
  });

  const search = document.getElementById("boardSearch") as HTMLInputElement;
  assert.ok(search, "board search input is present on the start screen");
  search.value = "esp32";
  search.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  assert.match(document.getElementById("boardPicker")!.textContent!, /ESP32-S3/);
  assert.doesNotMatch(document.getElementById("boardPicker")!.textContent!, /Pyboard D-series/);

  (document.getElementById("modeCustom") as HTMLButtonElement).click();
  assert.equal(document.getElementById("modeBeginner")!.getAttribute("aria-pressed"), "false");
  assert.equal(document.getElementById("modeCustom")!.getAttribute("aria-pressed"), "true");
  (document.querySelector('[data-board-id="esp32-s3-devkitc"]') as HTMLButtonElement).click();
  // Picking a board shows the selected chip (naming the choice) and flips the segmented toggle to Browse,
  // so the current choice is always visible instead of hidden in the collapsed list.
  assert.equal(document.getElementById("boardSelected")!.classList.contains("hidden"), false, "selected chip shown after picking");
  assert.match(document.getElementById("boardSelectedName")!.textContent!, /ESP32-S3/, "chip names the picked board");
  assert.equal(document.getElementById("boardMore")!.classList.contains("active"), true, "Browse segment active when a board is picked");
  assert.equal(document.getElementById("boardAuto")!.classList.contains("active"), false, "Recommend not active when a board is picked");
  assert.equal(document.getElementById("boardAuto")!.getAttribute("aria-pressed"), "false");
  assert.equal(document.getElementById("boardMore")!.getAttribute("aria-pressed"), "true");
  (document.getElementById("intent") as HTMLTextAreaElement).value = "做一个温度报警器";
  (document.getElementById("generate") as HTMLButtonElement).click();

  const start = posted.find((m) => m.type === "start_session");
  assert.equal(start.boardId, "esp32-s3-devkitc-1");
  assert.equal(start.preferences.mode, "custom");
  assert.equal(start.pre_selected_board.id, "esp32-s3-devkitc");
  assert.equal(start.pre_selected_board.official_id, "ESP32_GENERIC_S3");
  assert.equal(start.pre_selected_board.firmware.board_name, "ESP32_GENERIC_S3");
});

test("clearing the selected-board chip returns to the recommend choice", async () => {
  const posted: any[] = [];
  const dom = await loadWebview(posted);
  const { document } = dom.window;
  post(dom, {
    type: "micropython_boards",
    source_url: "https://micropython.org/download/",
    boards: [{ id: "esp32-s3-devkitc", official_id: "ESP32_GENERIC_S3", display_name: "ESP32-S3", vendor: "Espressif", port: "esp32", mcu: "esp32s3", features: [], firmware: { url: "u", board_name: "ESP32_GENERIC_S3" }, download_slug: "ESP32_GENERIC_S3", support_status: "builtin_pin_layout", local_board_id: "esp32-s3-devkitc-1", skill_board_id: "esp32-s3-devkitc" }],
  });
  (document.getElementById("boardMore") as HTMLButtonElement).click(); // open the browse panel
  assert.equal((document.getElementById("boardPickerBody") as HTMLElement).hidden, false, "browse panel open");
  (document.querySelector('[data-board-id="esp32-s3-devkitc"]') as HTMLButtonElement).click();
  assert.equal(document.getElementById("boardSelected")!.classList.contains("hidden"), false, "chip shown after picking");
  // The chip's ✕ (clear) returns to the recommend choice: chip hidden, Recommend active, browse panel
  // collapsed, and the start payload carries board_selection_mode recommend with no pre_selected_board.
  (document.getElementById("boardSelectedClear") as HTMLButtonElement).click();
  assert.equal(document.getElementById("boardSelected")!.classList.contains("hidden"), true, "chip hidden after clear");
  assert.equal(document.getElementById("boardAuto")!.classList.contains("active"), true, "Recommend segment active after clear");
  assert.equal(document.getElementById("boardAuto")!.getAttribute("aria-pressed"), "true");
  assert.equal(document.getElementById("boardMore")!.getAttribute("aria-pressed"), "false");
  assert.equal((document.getElementById("boardPickerBody") as HTMLElement).hidden, true, "browse panel collapsed after clear");
  (document.getElementById("intent") as HTMLTextAreaElement).value = "blink an led";
  (document.getElementById("generate") as HTMLButtonElement).click();
  const start = posted.find((m) => m.type === "start_session");
  assert.equal(start.pre_selected_board, null, "no board after clear");
  assert.equal(start.board_selection_mode, "recommend", "recommend after clear");
});

test("the last-used preference mode persists across panel reopens", async () => {
  // a shared vscode state store, so a reopen (second JSDOM load) sees the first session's setState
  const store: { state: any } = { state: null };
  const open = async (): Promise<JSDOM> => {
    const dom = new JSDOM(html, {
      runScripts: "dangerously",
      beforeParse: (window: any) => {
        window.acquireVsCodeApi = () => ({
          postMessage: () => {},
          getState: () => store.state,
          setState: (s: any) => { store.state = s; },
        });
      },
    });
    await new Promise<void>((resolve) => {
      if (dom.window.document.readyState === "complete") resolve();
      else dom.window.addEventListener("load", () => resolve());
    });
    openDoms.push(dom);
    return dom;
  };

  const first = await open();
  (first.window.document.getElementById("modeCustom") as HTMLButtonElement).click();
  assert.equal(store.state?.mode, "custom", "switching mode persists it to vscode state");

  const reopened = await open();
  const custom = reopened.window.document.getElementById("modeCustom") as HTMLElement;
  const beginner = reopened.window.document.getElementById("modeBeginner") as HTMLElement;
  assert.equal(custom.classList.contains("active"), true, "custom mode is restored active on reopen");
  assert.equal(beginner.classList.contains("active"), false, "beginner is no longer the active chip");
  assert.equal(custom.getAttribute("aria-pressed"), "true");
  assert.equal(beginner.getAttribute("aria-pressed"), "false");
});

test("preference and board groups expose localized accessible names", async () => {
  const dom = await loadWebview([]);
  const { document } = dom.window;
  assert.equal(document.querySelector(".mode-toggle")!.getAttribute("aria-label"), "Experience level");
  assert.equal(document.querySelector(".board-toggle")!.getAttribute("aria-label"), "Board selection");

  (document.getElementById("intent") as HTMLTextAreaElement).value = "\u6e29\u5ea6\u62a5\u8b66";
  (document.getElementById("generate") as HTMLButtonElement).click();
  assert.equal(document.querySelector(".mode-toggle")!.getAttribute("aria-label"), "\u4f53\u9a8c\u7ea7\u522b");
  assert.equal(document.querySelector(".board-toggle")!.getAttribute("aria-label"), "\u5f00\u53d1\u677f\u9009\u62e9");
});

test("board cards show the 3-way badges (firmware + local-layout state)", async () => {
  const dom = await loadWebview([]);
  const { document } = dom.window;
  post(dom, {
    type: "micropython_boards",
    source_url: "https://micropython.org/download/",
    fetched_at: "2026-06-20T00:07:34+00:00",
    boards: [
      { id: "esp32-s3-devkitc", official_id: "ESP32_GENERIC_S3", display_name: "ESP32-S3", vendor: "Espressif", port: "esp32", mcu: "esp32s3", features: ["WiFi"], firmware: { board_name: "ESP32_GENERIC_S3" }, support_status: "builtin_pin_layout", local_board_id: "esp32-s3-devkitc-1", skill_board_id: "esp32-s3-devkitc" },
      { id: "PYBD_SF2", display_name: "Pyboard D-series SF2", vendor: "George Robotics", port: "stm32", mcu: "stm32f722", features: [], firmware: { board_name: "PYBD_SF2" }, support_status: "official_firmware_only" },
    ],
  });
  const builtin = document.querySelector('.board-card[data-board-id="esp32-s3-devkitc"]')!.textContent!;
  const officialOnly = document.querySelector('.board-card[data-board-id="PYBD_SF2"]')!.textContent!;
  assert.match(builtin, /Official firmware/, "firmware badge shown");
  assert.match(builtin, /Pin layout/, "local-layout badge for a builtin_pin_layout board");
  assert.match(officialOnly, /Official firmware/, "firmware badge shown");
  assert.match(officialOnly, /Official only/, "official-only badge when no local layout");
  assert.doesNotMatch(officialOnly, /Pin layout/, "no local-layout badge without builtin_pin_layout");
});

test("board cards show a firmware format and a details link that opens the download page (not selecting the card)", async () => {
  const posted: any[] = [];
  const dom = await loadWebview(posted);
  const { document } = dom.window;
  post(dom, {
    type: "micropython_boards",
    boards: [
      { id: "esp32-s3-devkitc", display_name: "ESP32-S3", vendor: "Espressif", port: "esp32", mcu: "esp32s3", features: ["WiFi"], firmware: { url: "https://micropython.org/download/ESP32_GENERIC_S3/" }, support_status: "official_firmware_only" },
    ],
  });
  const row = document.querySelector('.board-row')!;
  assert.match(row.querySelector(".board-meta")!.textContent!, /firmware: bin/, "esp32 port → bin firmware format in the meta line");

  const link = row.querySelector(".board-detail") as HTMLButtonElement;
  assert.ok(link, "a details icon is rendered when a download URL exists");
  posted.length = 0;
  link.click();
  const ext = posted.find((m) => m.type === "open_external");
  assert.ok(ext, "clicking details opens the page externally");
  assert.match(ext.url, /micropython\.org\/download\/ESP32_GENERIC_S3/);
  // details click must NOT select the board (stopPropagation): stays on the recommend choice, so the
  // Recommend segment is active and the selected-board chip is hidden.
  assert.equal(document.getElementById("boardAuto")!.classList.contains("active"), true, "Recommend segment stays active");
  assert.equal(document.getElementById("boardSelected")!.classList.contains("hidden"), true, "no selected-board chip after a details click");
});

test("the recommend path sends board_selection_mode=recommend; selecting a board omits it", async () => {
  const recommend: any[] = [];
  const d1 = await loadWebview(recommend);
  (d1.window.document.getElementById("intent") as HTMLTextAreaElement).value = "blink an led";
  (d1.window.document.getElementById("generate") as HTMLButtonElement).click();
  const s1 = recommend.find((m) => m.type === "start_session");
  assert.equal(s1.pre_selected_board, null, "no board selected");
  assert.equal(s1.board_selection_mode, "recommend");

  const selected: any[] = [];
  const d2 = await loadWebview(selected);
  post(d2, { type: "micropython_boards", boards: [{ id: "esp32-s3-devkitc", official_id: "ESP32_GENERIC_S3", display_name: "ESP32-S3", vendor: "Espressif", port: "esp32", mcu: "esp32s3", features: [], firmware: { board_name: "X" }, support_status: "builtin_pin_layout", local_board_id: "esp32-s3-devkitc-1", skill_board_id: "esp32-s3-devkitc" }] });
  (d2.window.document.querySelector('.board-card[data-board-id="esp32-s3-devkitc"]') as HTMLButtonElement).click();
  (d2.window.document.getElementById("intent") as HTMLTextAreaElement).value = "temp sensor";
  (d2.window.document.getElementById("generate") as HTMLButtonElement).click();
  const s2 = selected.find((m) => m.type === "start_session");
  assert.ok(s2.pre_selected_board, "a board is selected");
  assert.equal(s2.board_selection_mode, undefined, "board_selection_mode omitted when a board is chosen");
});

test("the support panel opens from global tools and drives config-driven contacts", async () => {
  const posted: any[] = [];
  const dom = await loadWebview(posted);
  const { document } = dom.window;

  assert.ok(posted.some((m) => m.type === "request_support_config"), "requests support config on load");

  (document.querySelector("#globalTools #supportOpen") as HTMLButtonElement).click();
  assert.equal(document.getElementById("toolSupport")!.classList.contains("hidden"), false, "support surface shown");
  assert.equal(document.querySelector(".tabwrap")!.classList.contains("hidden"), true, "workflow hidden while the tool is open");

  post(dom, {
    type: "support_config",
    contacts: [
      { id: "wechat", label: "WeChat Contact", value: "wxinliliszdyyr", copyable: true },
      { id: "discord", label: "Discord Community", url: "https://discord.gg/EPRn28fJ2" },
      { id: "github_issues", label: "GitHub Issues", url: "https://github.com/FreakStudioCN/mpy-hardware-extension/issues" },
    ],
    diagnosticsFields: ["session_id", "submodule_commit"],
  });
  const support = document.getElementById("support")!;
  assert.match(support.textContent!, /WeChat Contact/);
  assert.match(support.textContent!, /Discord Community/);
  assert.match(support.textContent!, /Report an issue/);

  // copy the WeChat id via the host clipboard
  posted.length = 0;
  const wechatRow = [...support.querySelectorAll(".sc-row")].find((r) => r.textContent!.includes("WeChat"))!;
  (wechatRow.querySelector(".sc-btn") as HTMLButtonElement).click();
  const copy = posted.find((m) => m.type === "copy_support_contact");
  assert.ok(copy, "copy posts copy_support_contact (host looks up the value by id)");
  assert.equal(copy.contactId, "wechat");

  // the GitHub Issues contact row opens externally (its own Open — no redundant report-section button)
  posted.length = 0;
  const issuesRow = [...support.querySelectorAll(".sc-row")].find((r) => r.textContent!.includes("GitHub Issues"))!;
  (issuesRow.querySelector(".sc-btn") as HTMLButtonElement).click();
  const ext = posted.find((m) => m.type === "open_external");
  assert.ok(ext, "the GitHub Issues row posts open_external");
  assert.match(ext.url, /github\.com/);
  assert.ok(![...support.querySelectorAll("button")].some((b) => b.textContent === "Open GitHub Issues"), "no redundant Open GitHub Issues button in the report section");

  (document.getElementById("supportBack") as HTMLButtonElement).click();
  assert.equal(document.getElementById("toolSupport")!.classList.contains("hidden"), true, "Back closes the support surface");
});

test("the support issue form submits the typed report to the host", async () => {
  const posted: any[] = [];
  const dom = await loadWebview(posted);
  const { document } = dom.window;
  (document.querySelector("#globalTools #supportOpen") as HTMLButtonElement).click();
  post(dom, {
    type: "support_config",
    contacts: [{ id: "github_issues", label: "GitHub Issues", url: "https://github.com/x/y/issues" }],
    diagnosticsFields: ["session_id"],
    issueTypes: ["bug", "feature_request", "question", "other"],
  });
  const support = document.getElementById("support")!;
  assert.ok(support.querySelector(".sc-form")!.classList.contains("hidden"), "the form is collapsed by default");
  ([...support.querySelectorAll("button")].find((b) => b.textContent === "Report an issue") as HTMLButtonElement).click();
  assert.ok(!support.querySelector(".sc-form")!.classList.contains("hidden"), "clicking Report an issue reveals the form");
  (support.querySelector("#scIssueType") as HTMLSelectElement).value = "feature_request";
  (support.querySelector("#scIssueDesc") as HTMLTextAreaElement).value = "add a dark theme";
  (support.querySelector("#scIssueContact") as HTMLInputElement).value = "me@x.com";

  posted.length = 0;
  const submit = [...support.querySelectorAll(".sc-btn")].find((b) => b.textContent === "Submit issue report") as HTMLButtonElement;
  submit.click();
  const sent = posted.find((m) => m.type === "submit_issue_report");
  assert.ok(sent, "clicking Submit posts submit_issue_report");
  assert.equal(sent.issueType, "feature_request");
  assert.equal(sent.description, "add a dark theme");
  assert.equal(sent.contact, "me@x.com");
  assert.equal(sent.attachDiagnostics, true, "attach diagnostics defaults on");
});

test("Copy diagnostics requests a snapshot from the host and copies it", async () => {
  const posted: any[] = [];
  const dom = await loadWebview(posted);
  const { document } = dom.window;
  (document.querySelector("#globalTools #supportOpen") as HTMLButtonElement).click();
  post(dom, { type: "support_config", contacts: [], diagnosticsFields: ["session_id", "node"] });

  posted.length = 0;
  const diagBtn = [...document.querySelectorAll("#support .sc-btn")].find((b) => b.textContent === "Copy diagnostics") as HTMLButtonElement;
  diagBtn.click();
  assert.ok(posted.find((m) => m.type === "request_diagnostics"), "asks the host to gather diagnostics");

  posted.length = 0;
  post(dom, { type: "diagnostics", text: "toolchain_version: 1\nos: darwin arm64\nnode: v25", fields: { node: "v25" } });
  const copy = posted.find((m) => m.type === "copy_code");
  assert.ok(copy, "copies the returned diagnostics text");
  assert.match(copy.text, /toolchain_version/);
  assert.match(document.getElementById("scDiag")!.textContent!, /copied/i);
});

test("home partner logos render from config and open the site externally on click", async () => {
  const posted: any[] = [];
  const dom = await loadWebview(posted);
  const { document } = dom.window;

  assert.ok(posted.some((m) => m.type === "request_partners"), "requests partner config on load");

  post(dom, {
    type: "partners_config",
    partners: [
      { id: "wiznet", name: "WIZnet", url: "https://wiznet.io/", logo: "data:image/png;base64,AAAA" },
      { id: "cocube", name: "CoCube", url: "https://cocube.cn/cn/", logo: "data:image/png;base64,BBBB" },
    ],
  });
  const partners = document.getElementById("partners")!;
  assert.equal(partners.getAttribute("data-zone"), "partners", "partners is its own home-workbench zone");
  assert.equal(partners.querySelectorAll("button.partner").length, 2, "one button per partner");
  assert.equal(partners.querySelectorAll("img.partner-logo").length, 2, "each partner has a logo image");

  posted.length = 0;
  (partners.querySelector("button.partner") as HTMLButtonElement).click();
  const ext = posted.find((m) => m.type === "open_external");
  assert.ok(ext, "clicking a partner posts open_external");
  assert.match(ext.url, /wiznet\.io/);
});

test("partner with no resolved logo renders its name and still opens the site", async () => {
  // The host sends logo: null when readPartnerLogo can't resolve the asset (rather
  // than dropping the partner). The button must fall back to the partner name text —
  // not an empty/broken image — and still open the URL on click.
  const posted: any[] = [];
  const dom = await loadWebview(posted);
  const { document } = dom.window;

  post(dom, {
    type: "partners_config",
    partners: [{ id: "wiznet", name: "WIZnet", url: "https://wiznet.io/", logo: null }],
  });
  const partners = document.getElementById("partners")!;
  const button = partners.querySelector("button.partner") as HTMLButtonElement;
  assert.ok(button, "the partner still renders when its logo is null");
  assert.equal(partners.querySelectorAll("img.partner-logo").length, 0, "no image element when logo is null");
  assert.equal(button.textContent, "WIZnet", "falls back to the partner name text");

  posted.length = 0;
  button.click();
  const ext = posted.find((m) => m.type === "open_external");
  assert.ok(ext && /wiznet\.io/.test(ext.url), "clicking the text fallback still opens the site");
});

test("Import Existing Project posts import_project to the host", async () => {
  const posted: any[] = [];
  const dom = await loadWebview(posted);
  const { document } = dom.window;

  const btn = document.getElementById("importProject") as HTMLButtonElement;
  const startZone = document.querySelector('#activityEmpty [data-zone="start"]')!;
  assert.ok(startZone.contains(btn), "Import Existing Project is in the start zone");

  posted.length = 0;
  btn.click();
  assert.ok(posted.some((m) => m.type === "import_project"), "clicking posts import_project");
});

test("Recent Sessions opens the surface, lists host-served summaries, opens the jsonl on click", async () => {
  const posted: any[] = [];
  const dom = await loadWebview(posted);
  const { document } = dom.window;

  posted.length = 0;
  (document.getElementById("recentSessions") as HTMLButtonElement).click();
  assert.equal(document.getElementById("toolRecent")!.classList.contains("hidden"), false, "recent surface opens");
  assert.ok(posted.some((m) => m.type === "request_recent_sessions"), "requests recent sessions");

  post(dom, {
    type: "recent_sessions",
    sessions: [
      { id: "trace-a", date: "2026-07-07T10:00:00.000Z", intent: "blink an LED", finalPhase: "done", path: "/w/.mpyhw/sessions/trace-a/session.jsonl" },
      { id: "trace-b", date: "2026-07-06T09:00:00.000Z", intent: "read a sensor", finalPhase: "cancelled", path: "/w/.mpyhw/sessions/trace-b/session.jsonl" },
    ],
  });
  const cards = document.querySelectorAll("#recent .recent-card");
  assert.equal(cards.length, 2, "one card per session");
  assert.match((cards[0] as HTMLElement).textContent!, /blink an LED/, "shows the session intent");
  assert.equal(document.getElementById("recentEmpty")!.classList.contains("hidden"), true, "empty state hidden when sessions exist");

  posted.length = 0;
  (cards[0] as HTMLButtonElement).click();
  const open = posted.find((m) => m.type === "open_path");
  assert.ok(open, "clicking a session posts open_path");
  assert.match(open.path, /trace-a\/session\.jsonl$/, "opens that session's jsonl");
});

test("Recent Sessions shows the empty state when the host returns none", async () => {
  const dom = await loadWebview([]);
  const { document } = dom.window;
  (document.getElementById("recentSessions") as HTMLButtonElement).click();
  post(dom, { type: "recent_sessions", sessions: [] });
  assert.equal(document.getElementById("recentEmpty")!.classList.contains("hidden"), false, "empty state visible");
  assert.equal(document.querySelectorAll("#recent .recent-card").length, 0, "no cards rendered");
});

test("Start Workflow reveals the board picker and focuses the prompt", async () => {
  const dom = await loadWebview([]);
  const { document } = dom.window;

  // Start Workflow lives in the "start" home-workbench zone
  const startZone = document.querySelector('#activityEmpty [data-zone="start"]')!;
  assert.ok(startZone.contains(document.getElementById("startWorkflow")), "Start Workflow is inside the start zone");

  const body = document.getElementById("boardPickerBody") as HTMLElement;
  assert.equal(body.hidden, true, "board picker body is collapsed by default");

  document.getElementById("boardPicker")!.classList.add("hidden");
  (document.getElementById("startWorkflow") as HTMLButtonElement).click();

  assert.equal(document.getElementById("boardPicker")!.classList.contains("hidden"), false, "board picker shown");
  assert.equal(body.hidden, false, "Start Workflow expands the board picker body");
  assert.equal(document.getElementById("boardMore")!.getAttribute("aria-expanded"), "true", "disclosure marked expanded");
  assert.equal(document.activeElement, document.getElementById("intent"), "prompt is focused");
});

test("Browse boards disclosure toggles the board picker body", async () => {
  const dom = await loadWebview([]);
  const { document } = dom.window;
  const body = document.getElementById("boardPickerBody") as HTMLElement;
  const more = document.getElementById("boardMore") as HTMLButtonElement;

  assert.equal(body.hidden, true, "collapsed by default");
  more.click();
  assert.equal(body.hidden, false, "disclosure expands the body");
  assert.equal(more.getAttribute("aria-expanded"), "true", "aria-expanded reflects open");
  more.click();
  assert.equal(body.hidden, true, "disclosure collapses the body again");
  assert.equal(more.getAttribute("aria-expanded"), "false", "aria-expanded reflects closed");
});

test("board picker exposes refresh and stale cache state", async () => {
  const posted: any[] = [];
  const dom = await loadWebview(posted);
  const { document } = dom.window;

  const refresh = document.getElementById("boardRefresh") as HTMLButtonElement;
  assert.ok(refresh, "board refresh button is present");
  posted.length = 0;
  refresh.click();
  assert.ok(posted.some((m) => m.type === "request_boards"), "refresh asks the host for the official board catalog");

  post(dom, {
    type: "micropython_boards",
    source_url: "https://micropython.org/download/",
    fetched_at: "2026-06-20T00:07:34+00:00",
    stale: true,
    boards: [{ id: "ESP32_GENERIC_S3", display_name: "ESP32-S3", support_status: "official_firmware_only" }],
  });

  const cache = document.getElementById("boardCacheStatus")!;
  assert.match(cache.textContent!, /stale|cache/i, "stale official board cache is surfaced in the picker");
});

test("board picker collapses during a generated session and returns on Restart", async () => {
  const posted: any[] = [];
  const dom = await loadWebview(posted);
  const { document } = dom.window;

  const picker = document.getElementById("boardPicker")!;
  assert.equal(picker.classList.contains("hidden"), false, "start controls are visible before a session starts");

  (document.getElementById("intent") as HTMLTextAreaElement).value = "blink an led";
  (document.getElementById("generate") as HTMLButtonElement).click();
  assert.equal(picker.classList.contains("hidden"), true, "board picker should not occupy the active session UI");

  post(dom, { type: "session_done", terminal: "generated" });
  assert.equal(picker.classList.contains("hidden"), true, "finished sessions keep the focused composer until Restart");

  (document.getElementById("newSession") as HTMLButtonElement).click();
  assert.equal(picker.classList.contains("hidden"), false, "Restart restores the start controls for the next project");
});
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

test("manifest_updated names the board from mcu.board_name (the select-hw shape), not the placeholder", async () => {
  const dom = await loadWebview();
  const { document } = dom.window;

  // A real select-hw manifest carries the display name under mcu.board_name (with
  // mcu.mcu the chip token) — NOT mcu.board/mcu.model. Reading only board/model
  // degraded the header to the "Target board" placeholder.
  post(dom, {
    type: "manifest_updated",
    manifest: {
      schema_version: "1.0",
      mcu: { board_id: "esp32-c6-devkitc-1", board_name: "ESP32-C6-DevKitC-1", mcu: "ESP32-C6" },
      devices: [{ name: "Internal / On-board LED", type: "led", interface: "GPIO" }],
      wiring: { buses: [], standalone: [{ name: "Internal / On-board LED", pin: "8", type: "gpio_out" }] },
    },
  });

  const wiring = document.getElementById("wiring")!;
  assert.match(wiring.innerHTML, /ESP32-C6-DevKitC-1/, "the wiring header names the board from mcu.board_name");
  assert.doesNotMatch(wiring.innerHTML, /Target board/, "no placeholder when mcu.board_name is present");
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

test("a daily_cap_reached session_error shows the dedicated message and disables Start, like out_of_credits", async () => {
  const dom = await loadWebview();
  const { document } = dom.window;
  const generate = document.getElementById("generate") as HTMLButtonElement;

  post(dom, { type: "session_error", error: "daily_cap_reached" });

  assert.match(
    document.getElementById("activity")!.textContent!,
    /Daily limit reached — resets at midnight UTC/,
    "the dedicated daily-cap string is shown, not the raw error code",
  );
  assert.ok(document.getElementById("quota")!.classList.contains("exhausted"), "quota marked exhausted");
  assert.equal(generate.disabled, true, "the cap also means no more turns today -> Start disabled, same as out_of_credits");
});

test("the daily-cap disable is sticky: a later credits event with positive balance does NOT re-enable Start", async () => {
  // The cap binds on spend, not balance — a capped user's balance is typically > 0,
  // so the credits handler's quotaExhausted recompute (balance <= 0) must not lift
  // the block. Otherwise a panel reopen (which fires a fresh credits event) would
  // re-enable Start before UTC midnight and invite a duplicate 402 error card.
  const dom = await loadWebview();
  const { document } = dom.window;
  const generate = document.getElementById("generate") as HTMLButtonElement;

  post(dom, { type: "session_error", error: "daily_cap_reached" });
  assert.equal(generate.disabled, true, "capped -> Start disabled");

  post(dom, { type: "session_event", event: { kind: "credits", balance: 47, dailyGrant: 50 } });
  assert.equal(generate.disabled, true, "a positive-balance credits refresh must NOT re-enable Start before UTC midnight");
});

test("the daily-cap disable lifts once the UTC-midnight deadline has passed", async () => {
  const dom = await loadWebview();
  const { document } = dom.window;
  const generate = document.getElementById("generate") as HTMLButtonElement;

  post(dom, { type: "session_error", error: "daily_cap_reached" });
  post(dom, { type: "session_event", event: { kind: "credits", balance: 47, dailyGrant: 50 } });
  assert.equal(generate.disabled, true, "still blocked before the deadline");

  // Cross the deadline: 26h later is past the next UTC midnight from any start time.
  // Credits events are the natural refresh points where enablement is re-evaluated.
  const realNow = dom.window.Date.now();
  dom.window.Date.now = () => realNow + 26 * 3600 * 1000;
  post(dom, { type: "session_event", event: { kind: "credits", balance: 50, dailyGrant: 50 } });
  assert.equal(generate.disabled, false, "the block lifts naturally once resets_at (UTC midnight) has passed");
});

test("a saved_location event tells the user where the project went and offers a reveal button wired to the host", async () => {
  const posted: any[] = [];
  const dom = await loadWebview(posted);
  const { document } = dom.window;
  const activity = document.getElementById("activity")!;

  post(dom, { type: "session_event", event: { kind: "saved_location", path: "C:/gs/blockless-project" } });

  // The exact path is shown so a user with no folder open can still find the code.
  assert.match(activity.textContent!, /C:\/gs\/blockless-project/);
  // The reveal button asks the host to open it in the OS file manager.
  posted.length = 0;
  const btn = activity.querySelector(".doc-fix") as any;
  assert.ok(btn, "a reveal-in-file-manager button is offered");
  btn.click();
  // Built in the jsdom realm (different Array/Object prototype), so assert fields
  // individually rather than deepEqual against a host-realm literal.
  const open = posted.find((m) => m.type === "open_path");
  assert.ok(open, "clicking reveal posts an open_path message to the host");
  assert.equal(open.path, "C:/gs/blockless-project");
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

test("a failing tool's runtime_error trace_event shows the real reason in the feed, not just a silent spinner", async () => {
  const dom = await loadWebview();
  const { document } = dom.window;
  const activity = document.getElementById("activity")!;

  (document.getElementById("intent") as HTMLTextAreaElement).value = "x"; // en locale
  (document.getElementById("generate") as HTMLButtonElement).click();

  // The device install failed; the loop will retry, but the user must SEE why instead
  // of watching a blank spinner that ends in a generic "couldn't get it working".
  post(dom, { type: "trace_event", event: { isError: true, toolName: "install_package", text: "network: could not resolve host raw.githubusercontent.com" } });
  assert.match(activity.textContent!, /could not resolve host raw\.githubusercontent\.com/, "the real error reaches the feed");

  post(dom, { type: "session_done", terminal: "repair_exhausted" });
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
  // Running, so the composer placeholder is the (localized) note hint, not the build prompt.
  assert.equal((document.getElementById("intent") as HTMLTextAreaElement).placeholder, "为当前构建添加备注 — 在下一个安全点应用", "composer placeholder localized (note hint while running)");

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

test("an ask_user option that needs follow-up text focuses the input instead of ending the turn", async () => {
  const posted: any[] = [];
  const dom = await loadWebview(posted);
  const { document } = dom.window;

  // The model offers a real A/B choice, but option B means "I will paste a URL".
  post(dom, {
    type: "ui_prompt_needed",
    promptId: "p-need",
    question: "你倾向哪个方案？",
    options: ["方案A：内置 socket", "方案B：我提供 microflask 的 GitHub 地址"],
    optionsRequiringText: ["方案B：我提供 microflask 的 GitHub 地址"],
    textPlaceholder: "粘贴 microflask 的 GitHub 地址",
  });

  const card = document.querySelector(".ev-card.ask")!;
  const optB = [...card.querySelectorAll(".ask-opt")].find((b) => b.textContent!.includes("方案B")) as HTMLButtonElement;
  posted.length = 0;
  optB.click();

  // Clicking the needs-text option must NOT end the turn — it stays open for the URL.
  assert.equal(posted.length, 0, "no response posted yet — waiting for the required text");
  const input = card.querySelector(".ask-input") as HTMLInputElement;
  assert.equal(document.activeElement, input, "the text box is focused so the user can paste the address");
  assert.equal(input.placeholder, "粘贴 microflask 的 GitHub 地址", "placeholder guides what to paste");

  // Providing the text + Send finally submits, carrying BOTH the choice and the URL.
  input.value = "https://github.com/x/microflask";
  (card.querySelector(".ask-send") as HTMLButtonElement).click();
  const resp = posted.find((m) => m.type === "ui_prompt_response" && m.promptId === "p-need");
  assert.ok(resp, "the response is posted once the required text is provided");
  assert.match(resp.answer, /方案B/, "the chosen option is included in the answer");
  assert.match(resp.answer, /github\.com\/x\/microflask/, "the provided URL is included in the answer");
});

test("an ask_user option with no required text still submits on a single click", async () => {
  const posted: any[] = [];
  const dom = await loadWebview(posted);
  const { document } = dom.window;

  post(dom, {
    type: "ui_prompt_needed",
    promptId: "p-plain",
    question: "你倾向哪个方案？",
    options: ["方案A：内置 socket", "方案B：我提供地址"],
    optionsRequiringText: ["方案B：我提供地址"],
  });
  const card = document.querySelector(".ev-card.ask")!;
  posted.length = 0;
  ([...card.querySelectorAll(".ask-opt")].find((b) => b.textContent!.includes("方案A")) as HTMLButtonElement).click();

  const resp = posted.find((m) => m.type === "ui_prompt_response" && m.promptId === "p-plain");
  assert.ok(resp, "a plain (no-text) option submits immediately on click");
  assert.match(resp.answer, /方案A/);
});

test("an options-only ask_user card hides the free-text row; open and needs-text cards keep it", async () => {
  const dom = await loadWebview();
  const { document } = dom.window;
  const lastAsk = () => [...document.querySelectorAll(".ev-card.ask")].at(-1)!;

  // Pure either/or — there is nothing to type, so the input row is dropped (compact).
  post(dom, { type: "ui_prompt_needed", promptId: "p-opt", question: "选哪个？", options: ["A", "B"] });
  assert.equal(lastAsk().querySelector(".ask-row"), null, "options-only card has no free-text row");

  // An open question (no options) — the input row is the only way to answer.
  post(dom, { type: "ui_prompt_needed", promptId: "p-free", question: "用哪块板子？", options: [] });
  assert.ok(lastAsk().querySelector(".ask-row"), "open question keeps the input row");

  // Options where one needs follow-up text — the row stays so the text can be typed.
  post(dom, { type: "ui_prompt_needed", promptId: "p-mix", question: "选哪个？", options: ["A", "B"], optionsRequiringText: ["B"] });
  assert.ok(lastAsk().querySelector(".ask-row"), "needs-text card keeps the input row");
});

test("an llm_unreachable end renders a localized line with a Retry button that posts retry_session", async () => {
  // The transport-failure terminal: progress is saved server-side in the session
  // state, so the user must get a one-click way to re-issue the interrupted turn.
  const posted: any[] = [];
  const dom = await loadWebview(posted);
  const { document } = dom.window;
  const activity = document.getElementById("activity")!;

  (document.getElementById("intent") as HTMLTextAreaElement).value = "闪烁一个 LED";
  (document.getElementById("generate") as HTMLButtonElement).click();
  post(dom, { type: "session_done", terminal: "llm_unreachable" });

  assert.match(activity.textContent!, /无法连接服务器/, "a friendly localized line, not the raw terminal id");
  assert.doesNotMatch(activity.textContent!, /llm_unreachable/, "raw terminal id never reaches the user");
  const retry = activity.querySelector(".retry-session") as HTMLButtonElement;
  assert.ok(retry, "a Retry button renders with the failure line");
  retry.click();
  assert.ok(posted.some((m) => m.type === "retry_session"), "clicking Retry posts retry_session to the host");
  assert.equal(retry.disabled, true, "the button disables after the click so it can't double-fire");
});

test("an sse_stream_interrupted end offers the same Retry button", async () => {
  const posted: any[] = [];
  const dom = await loadWebview(posted);
  const { document } = dom.window;
  const activity = document.getElementById("activity")!;

  (document.getElementById("intent") as HTMLTextAreaElement).value = "blink an led";
  (document.getElementById("generate") as HTMLButtonElement).click();
  post(dom, { type: "session_done", terminal: "sse_stream_interrupted" });

  const retry = activity.querySelector(".retry-session") as HTMLButtonElement;
  assert.ok(retry, "interrupted streams are retryable too");
  retry.click();
  assert.ok(posted.some((m) => m.type === "retry_session"));
});

test("a stalled build says so and offers a retry — distinct from a clean awaiting_user hand-back", async () => {
  // "stalled" means the loop gave up mid-build (no phase boundary reached); it must
  // read as a visible, actionable stuck state — not the silent awaiting_user hand-back
  // a genuinely clean pause gets.
  const posted: any[] = [];
  const dom = await loadWebview(posted);
  const { document } = dom.window;
  const activity = document.getElementById("activity")!;

  (document.getElementById("intent") as HTMLTextAreaElement).value = "blink an led";
  (document.getElementById("generate") as HTMLButtonElement).click();
  post(dom, { type: "session_done", terminal: "stalled" });

  assert.match(activity.textContent!, /got stuck/i, "a visible stuck message is shown");
  const retry = activity.querySelector(".retry-session") as HTMLButtonElement;
  assert.ok(retry, "a retry card renders for a stalled build");
  retry.click();
  assert.ok(posted.some((m) => m.type === "retry_session"), "clicking retry posts retry_session to the host");
});

test("awaiting_user stays a clean, silent hand-back — no error line and no retry card (pinned behavior)", async () => {
  const dom = await loadWebview();
  const { document } = dom.window;
  const activity = document.getElementById("activity")!;

  post(dom, { type: "session_done", terminal: "awaiting_user" });

  assert.equal(activity.querySelector(".retry-session"), null, "no retry card for a clean hand-back");
  assert.equal(activity.innerHTML, "", "no terminal/error line rendered — awaiting_user stays silent");
});

test("connect_retry updates the working spinner so auto-retries are visible", async () => {
  const dom = await loadWebview();
  const { document } = dom.window;
  const activity = document.getElementById("activity")!;

  (document.getElementById("intent") as HTMLTextAreaElement).value = "闪烁一个 LED";
  (document.getElementById("generate") as HTMLButtonElement).click();
  post(dom, { type: "connect_retry", attempt: 1, maxAttempts: 3 });

  const label = activity.querySelector(".feed-pending .pending-label")!.textContent!;
  assert.match(label, /重试/, "the spinner says it's retrying, localized");
  assert.match(label, /1\/3/, "with the attempt count");

  post(dom, { type: "session_done", terminal: "generated" }); // ends the run
});

test("rapid double-click on an approval action posts exactly one ui_prompt_response", async () => {
  const posted: any[] = [];
  const dom = await loadWebview(posted);
  const { document } = dom.window;

  post(dom, {
    type: "approval_request",
    promptId: "appr-race",
    card: { header: "Confirm plan", question: "Proceed with this plan?", actions: [{ label: "Confirm", value: "confirm", primary: true }] },
  });

  const btn = document.querySelector(".ev-card.ask button.ask-opt") as HTMLButtonElement;
  assert.ok(btn, "approval action button renders");
  posted.length = 0;
  // Two clicks in the same tick, before any disabling/round-trip can land —
  // the classic double-click race on a single approval action.
  btn.click();
  btn.click();

  const responses = posted.filter((m) => m.type === "ui_prompt_response" && m.promptId === "appr-race");
  assert.equal(responses.length, 1, "only one ui_prompt_response posted despite the double-click");
});

test("a duplicate approval_request for an already-rendered promptId does not render a second card", async () => {
  const dom = await loadWebview();
  const { document } = dom.window;
  const activity = document.getElementById("activity")!;

  const card = { header: "Confirm plan", question: "Proceed with this plan?", actions: [{ label: "Confirm", value: "confirm", primary: true }] };
  post(dom, { type: "approval_request", promptId: "appr-dup", card });
  assert.equal(activity.querySelectorAll('[data-prompt-id="appr-dup"]').length, 1, "first approval_request renders one card");
  assert.equal(activity.querySelectorAll(".ev-card.ask").length, 1, "exactly one card so far");

  // The host re-delivers the same promptId (e.g. a retried/replayed message). This
  // must not render a second card for a prompt that's already on screen.
  post(dom, { type: "approval_request", promptId: "appr-dup", card });
  assert.equal(activity.querySelectorAll('[data-prompt-id="appr-dup"]').length, 1, "duplicate approval_request does not add a second card");
  assert.equal(activity.querySelectorAll(".ev-card.ask").length, 1, "still exactly one approval card total");
});

test("session_done disables a still-open approval card so stale clicks can't post", async () => {
  const posted: any[] = [];
  const dom = await loadWebview(posted);
  const { document } = dom.window;

  // An approval card is awaiting the user when the session ends (cancel/error/
  // clean hand-back). Its prompt was resolved on the host, so any later click is
  // stale — mirror the deploy-card pattern and disable its controls.
  post(dom, {
    type: "approval_request",
    promptId: "appr-stale",
    card: {
      question: "Proceed with this plan?",
      items: [{ id: "part-a", name: "Part A" }],
      actions: [{ label: "Confirm", value: "confirm", primary: true }, { label: "Cancel", value: "cancel" }],
    },
  });
  post(dom, { type: "session_done", terminal: "cancelled" });

  const card = document.querySelector('[data-prompt-id="appr-stale"]')!;
  const buttons = [...card.querySelectorAll("button")] as HTMLButtonElement[];
  assert.ok(buttons.length > 0, "the card has action buttons");
  assert.ok(buttons.every((b) => b.disabled), "every action button is disabled after session_done");
  const checks = [...card.querySelectorAll('input[type="checkbox"]')] as HTMLInputElement[];
  assert.ok(checks.length > 0, "the card has item checkboxes");
  assert.ok(checks.every((c) => c.disabled), "item checkboxes are disabled after session_done");

  posted.length = 0;
  buttons[0].click();
  assert.equal(posted.filter((m) => m.type === "ui_prompt_response").length, 0, "a stale click posts nothing");
});

test("the add-note button appears while running and posts a user_supplement", async () => {
  const posted: any[] = [];
  const dom = await loadWebview(posted);
  const { document } = dom.window;

  const addNote = document.getElementById("addNote") as HTMLButtonElement;
  assert.ok(addNote.classList.contains("hidden"), "add-note is hidden before a run starts");

  (document.getElementById("intent") as HTMLTextAreaElement).value = "blink an led";
  (document.getElementById("generate") as HTMLButtonElement).click();
  assert.equal(addNote.classList.contains("hidden"), false, "add-note shows once the run is live");

  posted.length = 0;
  const intent = document.getElementById("intent") as HTMLTextAreaElement;
  intent.value = "also add a buzzer";
  addNote.click();

  const supplement = posted.find((m) => m.type === "user_supplement");
  assert.ok(supplement, "clicking add-note posts a user_supplement");
  assert.equal(supplement.text, "also add a buzzer");
  assert.equal(intent.value, "", "the composer is cleared after queueing the note");
});

test("supplement received/applied events render into the activity feed", async () => {
  const dom = await loadWebview();
  const { document } = dom.window;

  post(dom, { type: "user_supplement_received", phase: "analyze", status: "queued", summary: "add a buzzer", received_at: "t" });
  post(dom, { type: "user_supplement_applied", phase: "upy-analyze-plugin", decision: "reroute", reason: "New hardware changes the device list." });

  const feed = (document.getElementById("activity") as HTMLElement).textContent ?? "";
  assert.ok(feed.includes("add a buzzer"), "the queued note summary is shown");
  assert.ok(feed.includes("New hardware changes the device list."), "the applied decision reason is shown");
  // Each supplement is its OWN card (kind=note), not coalesced into the open thinking stream.
  assert.equal(document.querySelectorAll(".ev-ico.note").length, 2, "received + applied each render as a dedicated note card");
});

test("queuing a note keeps the working spinner while the build is still running", async () => {
  const posted: any[] = [];
  const dom = await loadWebview(posted);
  const { document } = dom.window;

  (document.getElementById("intent") as HTMLTextAreaElement).value = "blink an led";
  (document.getElementById("generate") as HTMLButtonElement).click(); // running -> spinner armed
  assert.ok(document.querySelector(".feed-pending"), "the working spinner is present while running");

  post(dom, { type: "user_supplement_received", phase: "analyze", status: "queued", summary: "raise the threshold", received_at: "t" });

  assert.ok(document.querySelector(".feed-pending"), "the working spinner survives a queued note (addActivity cleared it, re-armed)");
});

test("a thinking card is live (spinner + heading) while streaming, then settles to a dot", async () => {
  const posted: any[] = [];
  const dom = await loadWebview(posted);
  const { document } = dom.window;

  (document.getElementById("intent") as HTMLTextAreaElement).value = "blink an led";
  (document.getElementById("generate") as HTMLButtonElement).click(); // running

  // A status line with no tool/result/error keyword classifies as "thinking".
  post(dom, { type: "status_update", payload: { message: "Analyzing requirements" } });
  assert.ok(document.querySelector(".ev-ico.think-live"), "while thinking the icon shows the live spinner");
  assert.ok(document.querySelector(".think-head"), "while thinking a heading is shown");

  // Any non-thinking event closes the stream and settles the card.
  post(dom, { type: "files_written", paths: ["main.py"] });
  assert.equal(document.querySelector(".ev-ico.think-live"), null, "the spinner is gone once thinking ends");
  assert.equal(document.querySelector(".think-head"), null, "the heading is gone once thinking ends");
});

test("the composer placeholder flips to a note hint while running, restores when idle", async () => {
  const posted: any[] = [];
  const dom = await loadWebview(posted);
  const { document } = dom.window;
  const intent = document.getElementById("intent") as HTMLTextAreaElement;
  const idle = intent.placeholder;

  intent.value = "blink an led";
  (document.getElementById("generate") as HTMLButtonElement).click();
  assert.match(intent.placeholder, /note/i, "while running the placeholder invites a note");
  assert.notEqual(intent.placeholder, idle, "it is not the build-intent placeholder while running");

  (document.getElementById("newSession") as HTMLButtonElement).click(); // Restart -> idle
  assert.equal(intent.placeholder, idle, "the build-intent placeholder is restored when idle");
});

test("stopping the session leaves no spinning thinking card", async () => {
  const posted: any[] = [];
  const dom = await loadWebview(posted);
  const { document } = dom.window;

  (document.getElementById("intent") as HTMLTextAreaElement).value = "blink an led";
  (document.getElementById("generate") as HTMLButtonElement).click(); // running
  post(dom, { type: "status_update", payload: { message: "Analyzing requirements" } });
  assert.ok(document.querySelector(".ev-ico.think-live"), "a live thinking card exists while running");

  // Stop: session_done settles the open card, and the terminal "Session ended" line
  // (which classifies as thinking) must render static, not as a new spinner.
  post(dom, { type: "session_done", terminal: "cancelled" });
  assert.equal(document.querySelector(".ev-ico.think-live"), null, "no spinning thinking card remains after stop");
  assert.equal(document.querySelector(".feed-pending"), null, "the working spinner is gone after stop");
});

// Every terminal the core can end a session on must have a user-facing string. The list is
// EXTRACTED from the core sources, never hardcoded here — a hardcoded copy would drift, and
// tr() falls back to returning the KEY when a string is missing, so a terminal that ships
// without one reaches the user as a raw internal token ("Session ended: failed"). That is
// exactly how term_failed shipped missing. zh is not checked: tr() falls back zh -> en, so
// en is the authority.
test("every terminal the core can emit has a user-facing string", async () => {
  const coreTerminals = new Set<string>();
  for (const file of ["protocol-loop.ts", "protocol-build.ts", "agent-loop.ts"]) {
    const src = readFileSync(new URL(`../src/core/${file}`, import.meta.url), "utf-8");
    for (const m of src.matchAll(/terminal:\s*"([a-z_]+)"/g)) coreTerminals.add(m[1]);
  }
  // shouldTerminate's reasons become a terminal verbatim (agent-loop: `terminal: terminal.reason`).
  const termination = readFileSync(new URL("../src/core/termination.ts", import.meta.url), "utf-8");
  for (const m of termination.matchAll(/reason:\s*"([a-z_]+)"/g)) coreTerminals.add(m[1]);

  // The hosts also end a session directly, bypassing the loop (preflight failure, cancel).
  // Only the LITERAL spellings are extractable here; `terminal: result.terminal` forwards the
  // core terminals already covered above. Not covered, and not coverable: template mode sends
  // an ARBITRARY backend error code (panel.ts `terminal: result.error ?? "pipeline_failed"`),
  // which is why message-bus keeps a raw-token fallback at all — it is the one path that can
  // still surface an unlocalized string, and no list can fix that.
  for (const file of ["../src/webview/panel.ts", "../src/extension/session-controller.ts"]) {
    const src = readFileSync(new URL(file, import.meta.url), "utf-8");
    for (const m of src.matchAll(/type:\s*"session_done",\s*terminal:\s*"([a-z_]+)"/g)) coreTerminals.add(m[1]);
  }

  // Guard the extraction itself: a broken regex would yield an empty set and pass vacuously.
  assert.ok(coreTerminals.size >= 10, `extraction found only ${coreTerminals.size} terminals — the regex broke`);

  const dom = await loadWebview([]);
  const tr = (dom.window as any).tr;
  const missing = [...coreTerminals].filter((t) => tr("term_" + t) === "term_" + t).sort();
  assert.deepEqual(missing, [], `terminals with no term_* string — they render as a raw token: ${missing.join(", ")}`);
});

test("an unknown next_phase renders its reason in the feed, not just a bare terminal", async () => {
  const posted: any[] = [];
  const dom = await loadWebview(posted);
  const { document } = dom.window;

  (document.getElementById("intent") as HTMLTextAreaElement).value = "blink an led";
  (document.getElementById("generate") as HTMLButtonElement).click();

  // The model asked to advance to a phase that isn't in PHASE_ALIASES: protocol-loop emits
  // phase_error and ends the run "failed". Both halves must reach the user — the reason line
  // AND a readable terminal — or the build looks like it died for no reason.
  post(dom, { type: "phase_error", error_kind: "unknown_next_phase", next_phase: "upy-verify-plugin" });
  post(dom, { type: "session_done", terminal: "failed" });

  const feed = (document.getElementById("activity") as HTMLElement).textContent ?? "";
  assert.match(feed, /upy-verify-plugin/, "the feed names the phase the build asked for");
  assert.doesNotMatch(feed, /Session ended: failed/, "the terminal line reads as English, not the raw token");
});

test("a phase_error lands as its own card, never glued onto the open thinking stream", async () => {
  const posted: any[] = [];
  const dom = await loadWebview(posted);
  const { document } = dom.window;

  (document.getElementById("intent") as HTMLTextAreaElement).value = "blink an led";
  (document.getElementById("generate") as HTMLButtonElement).click();

  // An open thinking card is the NORMAL state when a phase fault lands. classifyActivity()
  // keys off the words fail/error/crash/exhaust, and the phase_error wording carries none of
  // them (nor does its zh translation) — so without a forced kind the reason is appended to
  // the open card's text node, producing "Analyzing requirementsThe build asked...". Classifying
  // by wording is exactly the trap: a reworded string must not be able to break this.
  post(dom, { type: "status_update", payload: { message: "Analyzing requirements" } });
  post(dom, { type: "phase_error", error_kind: "unknown_next_phase", next_phase: "upy-verify-plugin" });

  const think = document.querySelector(".ev-think") as HTMLElement | null;
  assert.doesNotMatch(think?.textContent ?? "", /upy-verify-plugin/, "the reason is not concatenated onto the thinking card");
  const errorCards = [...document.querySelectorAll(".ev-sum.is-error")].map((n) => n.textContent ?? "");
  assert.ok(errorCards.some((t) => t.includes("upy-verify-plugin")), "the reason renders as its own error card");
});

test("a duplicate session_done renders exactly one terminal line", async () => {
  const posted: any[] = [];
  const dom = await loadWebview(posted);
  const { document } = dom.window;

  (document.getElementById("intent") as HTMLTextAreaElement).value = "blink an led";
  (document.getElementById("generate") as HTMLButtonElement).click();

  // Cancel posts session_done twice (optimistic in panel.ts + loop-unwind in the controller).
  post(dom, { type: "session_done", terminal: "cancelled" });
  post(dom, { type: "session_done", terminal: "cancelled" });

  const feed = (document.getElementById("activity") as HTMLElement).textContent ?? "";
  const count = (feed.match(/Session ended/g) || []).length;
  assert.equal(count, 1, "only one 'Session ended' line despite the duplicate session_done");
});

test("artifacts_index renders a phase-filterable list; a row click opens by relative path", async () => {
  const posted: any[] = [];
  const dom = await loadWebview(posted);
  const { document } = dom.window;

  assert.ok(document.querySelector('.tab[data-tab="artifacts"]'), "Artifacts tab present");

  post(dom, {
    type: "artifacts_index",
    artifacts: [
      { kind: "manifest", phase: "analyze", relative_path: "blockless-project/project-manifest.json", role: "project-manifest", size: 120, sha256: "abc12345def", created_at: "2026-07-09T00:00:00.000Z", mime: "application/json", is_binary: false },
      { kind: "code", phase: "generate", relative_path: "blockless-project/main.py", role: "code", size: 2048, sha256: "deadbeefcafe", created_at: "2026-07-09T00:00:00.000Z", mime: "text/x-python", is_binary: false },
      { kind: "log", phase: "", relative_path: ".mpyhw/sessions/s1/session.jsonl", role: "session-log", size: 50, sha256: "99990000", created_at: "2026-07-09T00:00:00.000Z", mime: "application/x-ndjson", is_binary: false },
    ],
  });

  const rowPaths = () => [...document.querySelectorAll("#artifacts .art-row .art-path")].map((n) => n.textContent);
  assert.equal(rowPaths().length, 3, "all artifacts listed");
  assert.ok(rowPaths().includes("blockless-project/main.py"));
  assert.ok(rowPaths().every((p) => !/^([A-Za-z]:|\/)/.test(p!)), "every display path is relative");
  assert.match((document.querySelector("#artifacts .art-row .art-meta") as HTMLElement).textContent ?? "", /B|KB/);

  // phase filter: All + analyze + generate; clicking "generate" narrows to that phase
  const chips = [...document.querySelectorAll("#artifactFilter .art-chip")] as HTMLButtonElement[];
  assert.ok(chips.length >= 3, "phase filter chips rendered");
  chips.find((c) => c.textContent === "generate")!.click();
  assert.deepEqual(rowPaths(), ["blockless-project/main.py"], "filtered to the generate phase");

  // clicking a row asks the host to open it by RELATIVE path (host owns the trust boundary)
  (document.querySelector("#artifacts .art-row") as HTMLButtonElement).click();
  const open = posted.find((m) => m.type === "open_artifact");
  assert.ok(open, "open_artifact posted");
  assert.equal(open.relative_path, "blockless-project/main.py");
});

test("files_written surfaces a 'View artifacts' jump from the Activity feed", async () => {
  const posted: any[] = [];
  const dom = await loadWebview(posted);
  const { document } = dom.window;

  post(dom, { type: "files_written", paths: ["/ws/blockless-project/main.py"] });

  assert.ok(posted.some((m) => m.type === "request_artifacts"), "files_written re-pulls the artifact index");
  const jump = ([...document.querySelectorAll("#activity button")] as HTMLButtonElement[])
    .find((b) => /View artifacts/.test(b.textContent ?? ""));
  assert.ok(jump, "'View artifacts' affordance present in the feed");
  jump!.click();
  assert.ok(
    !(document.querySelector('.view[data-view="artifacts"]') as HTMLElement).classList.contains("hidden"),
    "clicking it activates the Artifacts tab",
  );
});

test("an image artifact renders an inline preview thumbnail from its webview uri", async () => {
  const dom = await loadWebview();
  const { document } = dom.window;
  post(dom, {
    type: "artifacts_index",
    artifacts: [
      { kind: "diagram", phase: "generate", relative_path: "blockless-project/docs/diagram.png", role: "diagram", size: 900, sha256: "aa11bb22", created_at: "2026-07-09T00:00:00.000Z", mime: "image/png", is_binary: true, webview_uri: "https://vscode-resource.test/diagram.png" },
    ],
  });
  const img = document.querySelector("#artifacts .art-row img.art-thumb") as HTMLImageElement;
  assert.ok(img, "thumbnail rendered for the image artifact");
  assert.equal(img.getAttribute("src"), "https://vscode-resource.test/diagram.png");
});

test("a SELF_TEST_PASS serial line is highlighted as a verification result", async () => {
  const dom = await loadWebview();
  const { document } = dom.window;
  post(dom, { type: "serial_output", lines: ["boot ok", "SELF_TEST_PASS:AHT20:I2C_READ"] });
  const verify = document.querySelector("#serial .serial-line.verify");
  assert.ok(verify, "verification line got the verify class");
  assert.match((verify as HTMLElement).textContent ?? "", /SELF_TEST_PASS/);
});

test("a single-phase artifact index shows no phase-filter chips", async () => {
  const dom = await loadWebview();
  const { document } = dom.window;
  post(dom, {
    type: "artifacts_index",
    artifacts: [
      { kind: "code", phase: "generate", relative_path: "blockless-project/main.py", role: "code", size: 10, sha256: "aa", created_at: "2026-07-09T00:00:00.000Z", mime: "text/x-python", is_binary: false },
      { kind: "manifest", phase: "generate", relative_path: "blockless-project/manifest.json", role: "project-manifest", size: 20, sha256: "bb", created_at: "2026-07-09T00:00:00.000Z", mime: "application/json", is_binary: false },
    ],
  });
  assert.equal(document.querySelectorAll("#artifacts .art-row").length, 2, "rows still render");
  assert.equal(document.querySelectorAll("#artifactFilter .art-chip").length, 0, "no filter chips for a single phase");
});

test("wiring/diagram rows jump to their rendered tab instead of opening raw JSON", async () => {
  const posted: any[] = [];
  const dom = await loadWebview(posted);
  const { document } = dom.window;
  post(dom, {
    type: "artifacts_index",
    artifacts: [
      { kind: "wiring", phase: "generate", relative_path: "blockless-project/docs/wiring.json", role: "wiring", size: 30, sha256: "aa", created_at: "2026-07-09T00:00:00.000Z", mime: "application/json", is_binary: false },
    ],
  });
  const row = document.querySelector("#artifacts .art-row") as HTMLButtonElement;
  assert.ok(row, "wiring row present");
  row.click();
  assert.ok(!posted.some((m) => m.type === "open_artifact"), "wiring row does not post open_artifact");
  assert.ok(!(document.querySelector('.view[data-view="wiring"]') as HTMLElement).classList.contains("hidden"), "Wiring tab activated by the row");
});

test("artifact rows show role + created_at, and an 'on disk' tag for disk-origin files", async () => {
  const dom = await loadWebview();
  const { document } = dom.window;
  post(dom, {
    type: "artifacts_index",
    artifacts: [
      { kind: "manifest", phase: "", relative_path: "blockless-project/project-manifest.json", role: "project-manifest", size: 120, sha256: "abc12345de", created_at: "2026-07-09T12:00:00.000Z", mime: "application/json", is_binary: false, origin: "disk" },
    ],
  });
  const meta = (document.querySelector("#artifacts .art-row .art-meta") as HTMLElement).textContent ?? "";
  assert.match(meta, /project-manifest/, "role shown");
  assert.match(meta, /2026-07-09/, "created_at date shown");
  assert.ok(document.querySelector("#artifacts .art-row .art-tag"), "'on disk' tag present for disk origin");
});

test("phase_complete triggers an artifact refresh (request_artifacts)", async () => {
  const posted: any[] = [];
  const dom = await loadWebview(posted);
  post(dom, { type: "phase_complete", payload: { phase: "upy-analyze-plugin", artifacts: [] } });
  assert.ok(posted.some((m) => m.type === "request_artifacts"), "phase_complete asks the host to refresh artifacts");
});

test("support panel exposes log reveal/export buttons that post the right messages (#25)", async () => {
  const posted: any[] = [];
  const dom = await loadWebview(posted);
  const { document } = dom.window;

  post(dom, { type: "support_config", contacts: [], diagnosticsFields: ["os", "node"] });
  const btns = [...document.querySelectorAll("#support button")] as HTMLButtonElement[];
  const reveal = btns.find((b) => b.textContent === "Reveal logs folder");
  const exp = btns.find((b) => /full session log/i.test(b.textContent ?? ""));
  assert.ok(reveal && exp, "reveal + export buttons render in the support panel");
  // The export copy discloses it ships the whole transcript (privacy framing, #80).
  assert.match(document.getElementById("support")!.textContent!, /transcript/i, "export note says it's the full transcript");

  reveal!.click();
  exp!.click();
  assert.ok(posted.some((m) => m.type === "reveal_logs_folder"), "reveal posts reveal_logs_folder");
  assert.ok(posted.some((m) => m.type === "export_session_log"), "export posts export_session_log");

  post(dom, { type: "logs_status", text: "Session log exported." });
  assert.match((document.getElementById("scDiag") as HTMLElement).textContent ?? "", /exported/i, "logs_status updates the status line");
});

test("file_op_confirm_needed renders an in-panel card with the file path and posts a stable proceed/ignore (§4)", async () => {
  const posted: any[] = [];
  const dom = await loadWebview(posted);
  const { document } = dom.window;

  // Overwrite card -> click Overwrite -> posts the STABLE answer "proceed"
  post(dom, { type: "file_op_confirm_needed", promptId: "file-overwrite-1", op: "overwrite", path: "firmware/main.py" });
  const card = document.querySelector('[data-prompt-id="file-overwrite-1"]') as HTMLElement | null;
  assert.ok(card, "an in-panel card appears for the overwrite confirm");
  assert.match(card!.textContent ?? "", /firmware\/main\.py/, "the card shows the file path");
  const proceed = card!.querySelector(".fileop-proceed") as HTMLElement;
  const ignore = card!.querySelector(".fileop-ignore") as HTMLElement;
  assert.ok(proceed && ignore, "Overwrite and Ignore buttons render");
  proceed.click();
  const reply = posted.find((m) => m.type === "ui_prompt_response" && m.promptId === "file-overwrite-1");
  assert.ok(reply, "clicking Overwrite posts a ui_prompt_response");
  assert.equal(reply.answer, "proceed", "the answer is the STABLE value, not the localized button label");

  // Ignore on a delete card -> posts the stable "ignore"
  post(dom, { type: "file_op_confirm_needed", promptId: "file-delete-1", op: "delete", path: "firmware/old.py" });
  const del = document.querySelector('[data-prompt-id="file-delete-1"]') as HTMLElement;
  (del.querySelector(".fileop-ignore") as HTMLElement).click();
  const reply2 = posted.find((m) => m.type === "ui_prompt_response" && m.promptId === "file-delete-1");
  assert.equal(reply2.answer, "ignore", "clicking Ignore posts the stable 'ignore' answer");

  // Device delete is a DISTINCT, stronger card (safe-point §4 row 60 second confirmation): its copy
  // names the device path and the irreversibility, and the proceed label is "Erase", not "Delete".
  post(dom, { type: "file_op_confirm_needed", promptId: "file-device_delete-1", op: "device_delete", path: "device:blob.mpy" });
  const dev = document.querySelector('[data-prompt-id="file-device_delete-1"]') as HTMLElement;
  assert.match(dev.textContent ?? "", /permanently erases/i, "the device-delete card shows the stronger irreversible copy");
  assert.match(dev.textContent ?? "", /device:blob\.mpy/, "and names the device path");
  assert.match((dev.querySelector(".fileop-proceed") as HTMLElement).textContent ?? "", /Erase/i, "the proceed label is Erase");
  // Mutation: drop the device_delete entry from the op->key map in ApprovalCardHost -> it falls back
  // to the Overwrite card (label "Overwrite", generic copy) and these three assertions fail.
});

test("global tools: the scroll chevrons exist and stay hidden when the row fits", async () => {
  const dom = await loadWebview([]);
  const { document } = dom.window;
  // Guards the load path: a missing chevron id would throw in the arrow wiring and
  // blank the panel. JSDOM has no layout, so no overflow -> both chevrons hidden.
  assert.ok(document.getElementById("gtoolsLeft") && document.getElementById("gtoolsRight"), "both chevrons exist");
  assert.ok(document.getElementById("gtoolsLeft").classList.contains("hidden"), "no overflow -> left chevron hidden");
  assert.ok(document.getElementById("gtoolsRight").classList.contains("hidden"), "no overflow -> right chevron hidden");
});

test("device tools: clicking the Device Tools button shows its surface and hides the workflow", async () => {
  const dom = await loadWebview([]);
  const { document } = dom.window;
  document.getElementById("deviceToolsOpen").click();
  // the bug: toolDeviceTools was missing from GLOBAL_TOOL_SURFACES, so open hid the
  // whole workflow but never un-hid the surface -> a blank panel.
  assert.ok(!document.getElementById("toolDeviceTools").classList.contains("hidden"), "the Device Tools surface must be shown on open");
  assert.ok(document.getElementById("tabs").classList.contains("hidden"), "the workflow tabs hide behind a global tool");
  assert.ok(document.getElementById("toolSupport").classList.contains("hidden"), "the other global-tool surfaces stay hidden");
});

test("global tools: the open tool's circle is selected, switches without Back, and clears on Back", async () => {
  const dom = await loadWebview([]);
  const { document } = dom.window;
  document.getElementById("deviceToolsOpen").click();
  assert.ok(document.getElementById("deviceToolsOpen").classList.contains("active"), "the open tool is selected");
  assert.equal(document.getElementById("deviceToolsOpen").getAttribute("aria-current"), "true", "selection is exposed to screen readers");
  assert.ok(!document.getElementById("supportOpen").classList.contains("active"), "other tools are not selected");
  // the bar persists, so clicking another tool switches the surface + the selection
  document.getElementById("supportOpen").click();
  assert.ok(document.getElementById("supportOpen").classList.contains("active"), "switching moves the selection");
  assert.ok(!document.getElementById("deviceToolsOpen").classList.contains("active"), "the previous tool deselects");
  assert.equal(document.getElementById("deviceToolsOpen").getAttribute("aria-current"), null, "the previous tool drops aria-current");
  document.getElementById("supportBack").click();
  assert.ok(!document.getElementById("supportOpen").classList.contains("active"), "Back clears the selection");
  assert.equal(document.getElementById("supportOpen").getAttribute("aria-current"), null, "Back clears aria-current");
});

test("device tools: a list result renders device-file rows and hides the empty state", async () => {
  const dom = await loadWebview([]);
  const { document } = dom.window;
  post(dom, { type: "device_tool_result", command: "list", result: { path: "/", entries: ["boot.py", "lib"] } });
  const rows = document.querySelectorAll("#dtEntries .dt-row");
  assert.equal(rows.length, 2);
  assert.ok([...rows].some((r: any) => r.querySelector(".dt-name")?.textContent === "boot.py"));
  assert.ok(document.getElementById("dtEmpty").classList.contains("hidden"));
});

test("device tools: folders are click-to-descend, files carry actions, breadcrumbs jump up", async () => {
  const posted: any[] = [];
  const dom = await loadWebview(posted);
  const { document } = dom.window;
  post(dom, { type: "device_tool_result", command: "list", result: { path: "/", entries: ["lib/", "boot.py"] } });
  const dirBtn = [...document.querySelectorAll("#dtEntries .dt-navbtn")].find((b: any) => b.textContent === "lib/");
  assert.ok(dirBtn, "a folder (trailing /) renders as a click-to-descend button");
  const fileRow = [...document.querySelectorAll("#dtEntries .dt-row")].find((r: any) => r.querySelector(".dt-name")?.textContent === "boot.py");
  assert.ok((fileRow as any).querySelector(".dt-del"), "a file has a delete action; a folder does not");
  (dirBtn as any).click();
  assert.ok(posted.some((m) => m.type === "device_tool_list" && m.path === "/lib"), "clicking a folder lists it");
  post(dom, { type: "device_tool_result", command: "list", result: { path: "/lib", entries: [] } });
  const rootCrumb = [...document.querySelectorAll("#dtCrumbs .dt-crumb")].find((b: any) => b.textContent === "/");
  (rootCrumb as any).click();
  assert.ok(posted.some((m) => m.type === "device_tool_list" && m.path === "/"), "the root breadcrumb navigates to /");
});

test("device tools: shows a no-device state until a board is present, and reverts on unplug", async () => {
  const posted: any[] = [];
  const dom = await loadWebview(posted);
  const { document } = dom.window;
  post(dom, { type: "device_present", present: false });
  assert.ok(!document.getElementById("dtNoDev").classList.contains("hidden"), "the 'plug in a device' state shows with no board");
  assert.ok(document.getElementById("dtDeviceUi").classList.contains("hidden"), "all controls (add/manage, mip) hide with no board");
  post(dom, { type: "device_present", present: true });
  assert.ok(posted.some((m) => m.type === "device_tool_list" && m.path === "/"), "a connected board lists its root");
  post(dom, { type: "device_tool_result", command: "list", result: { path: "/", entries: ["boot.py"] } });
  assert.ok(document.getElementById("dtNoDev").classList.contains("hidden"), "no-device hidden while a board is present");
  assert.ok(!document.getElementById("dtDeviceUi").classList.contains("hidden"), "controls shown while a board is present");
  post(dom, { type: "device_present", present: false });
  assert.ok(!document.getElementById("dtNoDev").classList.contains("hidden"), "unplugging reverts to the no-device state");
  assert.ok(document.getElementById("dtDeviceUi").classList.contains("hidden"), "controls hide again on unplug");
  assert.equal(document.getElementById("dtEntries").children.length, 0, "the file list is cleared on unplug");
});

test("device tools: re-opening with the board already present refreshes the current path; a poll tick does not", async () => {
  const posted: any[] = [];
  const dom = await loadWebview(posted);
  const { document } = dom.window;
  // Board present -> first detection lists root, then descend into /lib so the current path is not root.
  post(dom, { type: "device_present", present: true });
  post(dom, { type: "device_tool_result", command: "list", result: { path: "/", entries: ["lib/"] } });
  ([...document.querySelectorAll("#dtEntries .dt-navbtn")].find((b: any) => b.textContent === "lib/") as any).click();
  post(dom, { type: "device_tool_result", command: "list", result: { path: "/lib", entries: [] } });

  // A bare poll tick (presence still true, no explicit open) must NOT re-list, else the 2.5s poll spams fs ls.
  const listsBeforeTick = posted.filter((m) => m.type === "device_tool_list").length;
  post(dom, { type: "device_present", present: true });
  assert.equal(posted.filter((m) => m.type === "device_tool_list").length, listsBeforeTick, "a poll tick with the board still present does not re-list");

  // Re-opening the tool refreshes the CURRENT path, so a model-issued device op done mid-run shows up
  // without an unplug/replug. Mutation: revert dtOnOpen->dtCheckDevice and this count stays flat.
  const libBefore = posted.filter((m) => m.type === "device_tool_list" && m.path === "/lib").length;
  document.getElementById("deviceToolsOpen").click(); // dtOnOpen: arms the one-shot relist + polls presence
  post(dom, { type: "device_present", present: true }); // host replies present
  assert.equal(posted.filter((m) => m.type === "device_tool_list" && m.path === "/lib").length, libBefore + 1, "re-open re-lists the current path");
});

test("device tools: a run in progress does not wipe the listing on a transient 'no device'", async () => {
  const posted: any[] = [];
  const dom = await loadWebview(posted);
  const { document } = dom.window;
  post(dom, { type: "device_present", present: true });
  post(dom, { type: "device_tool_result", command: "list", result: { path: "/", entries: ["boot.py"] } });
  assert.equal(document.querySelectorAll("#dtEntries .dt-row").length, 1, "listed before the run");
  assert.ok(document.getElementById("dtNoDev").classList.contains("hidden"), "device present before the run");

  // Start a run -> running = true (the port is owned).
  (document.getElementById("intent") as HTMLTextAreaElement).value = "blink an led";
  (document.getElementById("generate") as HTMLButtonElement).click();

  // A mid-run transient absence (an esp32-c6 re-enumerates on flash) must NOT wipe the listing.
  // Mutation: drop `if (running) return` from onDevicePresent and this shows the no-device state.
  post(dom, { type: "device_present", present: false });
  assert.ok(document.getElementById("dtNoDev").classList.contains("hidden"), "no-device state is NOT shown mid-run");
  assert.equal(document.querySelectorAll("#dtEntries .dt-row").length, 1, "the listing is preserved during the run");
});

test("device tools: session_done refreshes the current path when the tool is open", async () => {
  const posted: any[] = [];
  const dom = await loadWebview(posted);
  const { document } = dom.window;
  document.getElementById("deviceToolsOpen").click(); // open the tool so the post-run refresh acts
  post(dom, { type: "device_present", present: true });
  post(dom, { type: "device_tool_result", command: "list", result: { path: "/", entries: ["lib/"] } });
  ([...document.querySelectorAll("#dtEntries .dt-navbtn")].find((b: any) => b.textContent === "lib/") as any).click();
  post(dom, { type: "device_tool_result", command: "list", result: { path: "/lib", entries: [] } });

  // A device tool clicked mid-run got refused with device_busy -> controls disabled, banner shown.
  post(dom, { type: "device_busy", phase: "flash" });
  assert.ok(!document.getElementById("dtBusy").classList.contains("hidden"), "busy banner shown mid-run");
  assert.equal((document.getElementById("dtUpload") as any).disabled, true, "controls disabled mid-run");

  // Run ends -> dtRefreshAfterRun re-enables the controls (finding 2) AND re-checks presence; the
  // host's reply then re-lists the current path (finding 3). Mutation: remove the dtRefreshAfterRun()
  // call in session_done and both the re-enable and the re-list stop happening.
  const libBefore = posted.filter((m) => m.type === "device_tool_list" && m.path === "/lib").length;
  post(dom, { type: "session_done", terminal: "complete" });
  assert.ok(document.getElementById("dtBusy").classList.contains("hidden"), "busy banner cleared on session_done");
  assert.equal((document.getElementById("dtUpload") as any).disabled, false, "controls re-enabled on session_done");
  post(dom, { type: "device_present", present: true });
  assert.equal(posted.filter((m) => m.type === "device_tool_list" && m.path === "/lib").length, libBefore + 1, "session_done re-lists the current path");
});

test("device tools: a mutation's result stays visible; the auto-refresh does not clobber it", async () => {
  const dom = await loadWebview([]);
  const { document } = dom.window;
  // an mkdir success sets the status, then silently refreshes the listing
  post(dom, { type: "device_tool_result", command: "mkdir", result: { path: "/x" } });
  post(dom, { type: "device_tool_result", command: "list", result: { path: "/", entries: [] } });
  // A file-op result reports under the Board files section status (not the Packages one).
  assert.match(document.getElementById("dtFilesStatus").textContent, /mkdir done/i, "the done message survives the auto-refresh");
});

test("device tools: a mip install result reports under the Packages status, not Board files", async () => {
  const dom = await loadWebview([]);
  const { document } = dom.window;
  post(dom, { type: "device_tool_result", command: "mip_install", result: { url: "aioble" } });
  assert.match(document.getElementById("dtPkgStatus")!.textContent || "", /Installed/i, "install result lands in the Packages status (no card active)");
  assert.equal((document.getElementById("dtFilesStatus")!.textContent || "").trim(), "", "Board files status stays clear on a package install");
});

test("device tools: unplug clears a lingering Packages status (no stale message)", async () => {
  const dom = await loadWebview([]);
  const { document } = dom.window;
  post(dom, { type: "device_tool_result", command: "list", result: { path: "/", entries: [] } });
  post(dom, { type: "device_tool_result", command: "mip_install", result: { url: "aioble" } });
  assert.notEqual((document.getElementById("dtPkgStatus")!.textContent || "").trim(), "", "packages status is set after an install");
  post(dom, { type: "device_present", present: false }); // board unplugged
  assert.equal((document.getElementById("dtPkgStatus")!.textContent || "").trim(), "", "packages status is cleared when the device drops");
});

test("device tools: device_busy shows the busy banner naming the owning phase", async () => {
  const dom = await loadWebview([]);
  const { document } = dom.window;
  post(dom, { type: "device_busy", phase: "flash" });
  const banner = document.getElementById("dtBusy");
  assert.ok(!banner.classList.contains("hidden"));
  assert.match(banner.textContent, /flash/);
});

test("device tools: Install (mip) posts device_tool_mip with the url + version", async () => {
  const posted: any[] = [];
  const dom = await loadWebview(posted);
  const { document } = dom.window;
  document.getElementById("dtMipUrl").value = "github:org/repo/pkg";
  document.getElementById("dtMipVersion").value = "1.2.3";
  document.getElementById("dtMipInstall").click();
  const mip = posted.find((m) => m.type === "device_tool_mip");
  assert.ok(mip); assert.equal(mip.url, "github:org/repo/pkg"); assert.equal(mip.version, "1.2.3");
});

test("device tools: Delete is host-armed two-step — first click requests an arm (no nonce), second echoes the host nonce", async () => {
  const posted: any[] = [];
  const dom = await loadWebview(posted);
  const { document } = dom.window;
  post(dom, { type: "device_tool_result", command: "list", result: { path: "/lib", entries: ["x.py"] } });
  const row = [...document.querySelectorAll("#dtEntries .dt-row")].find((r: any) => r.querySelector(".dt-name")?.textContent === "x.py");
  const del = (row as any).querySelector(".dt-del");

  del.click(); // first click: an ARM request only (bare, no nonce) — the host won't delete on this
  const arm = posted.find((m) => m.type === "device_tool_delete");
  assert.ok(arm && arm.path === "/lib/x.py", "first click posts an arm request for the path");
  assert.equal(arm.nonce, undefined, "the arm request carries no nonce, so nothing can delete yet");
  assert.match(del.textContent, /Confirm/i, "the button arms with a confirm label");

  // Host replies with its one-shot nonce; the confirm click echoes it back.
  post(dom, { type: "device_tool_delete_armed", path: "/lib/x.py", nonce: "n-123" });
  del.click();
  const confirm = posted.filter((m) => m.type === "device_tool_delete").at(-1);
  assert.equal(confirm.nonce, "n-123", "the confirm click echoes the host nonce");
  assert.equal(confirm.path, "/lib/x.py");
});

test("support actions are recorded host-side, never rendered into the build feed", async () => {
  const posted: any[] = [];
  const dom = await loadWebview(posted);
  const { document } = dom.window;

  (document.getElementById("intent") as HTMLTextAreaElement).value = "blink an led";
  (document.getElementById("generate") as HTMLButtonElement).click(); // running -> spinner armed
  const activity = document.getElementById("activity")!;
  const before = activity.childElementCount;

  post(dom, { type: "support_feedback_opened", entry: "panel" });
  post(dom, { type: "support_diagnostics_exported", scope: "session" });

  // Support navigation is diagnostics/traceability, not build progress: it must add no feed card
  // and must not disturb the running spinner. Re-adding an addActivity handler for these fails this.
  assert.equal(activity.childElementCount, before, "support actions add no card to the build feed");
  assert.doesNotMatch(activity.textContent!, /Diagnostics exported|Support:/, "no support text leaks into the feed");
  assert.ok(document.querySelector(".feed-pending"), "the working spinner is untouched");
});

test("a wiring/diagram run's rendered image shows in its tab (svg preferred), else the tab stays derived", async () => {
  const posted: any[] = [];
  const dom = await loadWebview(posted);
  const { document } = dom.window;
  // artifacts_index rows carry kind + webview_uri for images (the host resolves them)
  post(dom, { type: "artifacts_index", artifacts: [
    { relative_path: "blockless-project/docs/wiring.png", kind: "wiring", webview_uri: "vscode-resource://wiring.png" },
    { relative_path: "blockless-project/docs/wiring.svg", kind: "wiring", webview_uri: "vscode-resource://wiring.svg" },
    { relative_path: "blockless-project/docs/architecture.svg", kind: "diagram", webview_uri: "vscode-resource://arch.svg" },
    { relative_path: "blockless-project/docs/flowchart.png", kind: "diagram", webview_uri: "vscode-resource://flow.png" },
    { relative_path: "blockless-project/docs/data_flow.png", kind: "diagram", webview_uri: "vscode-resource://data.png" },
    { relative_path: "blockless-project/main.py", kind: "code" },
  ] });
  const wImgs = [...document.querySelectorAll("#wiringRunImage img")] as HTMLImageElement[];
  assert.equal(wImgs.length, 1, "wiring's two formats dedup to one image");
  assert.equal(wImgs[0].src, "vscode-resource://wiring.svg", "svg is preferred over png");
  // a diagram run emits several distinct diagrams — all show, each in its own card
  const dImgs = [...document.querySelectorAll("#diagramRunImage img")] as HTMLImageElement[];
  assert.deepEqual(dImgs.map((i) => i.src).sort(), ["vscode-resource://arch.svg", "vscode-resource://data.png", "vscode-resource://flow.png"], "all three diagrams render");
  // each image is a clickable card that opens the full-size file. Mutation: drop the click handler -> no post.
  posted.length = 0;
  (document.querySelector("#diagramRunImage figure.of-fig") as HTMLElement).click();
  const open = posted.find((m) => m.type === "open_artifact");
  assert.ok(open && /docs\/(architecture|flowchart|data_flow)/.test(open.relative_path), "clicking a diagram card opens the full-size file");

  // A later index with no images (e.g. a local-only/partial run) hides the run image -> derived view stays.
  // Mutation: drop the message-bus route -> the first index never renders and this whole test fails.
  post(dom, { type: "artifacts_index", artifacts: [{ relative_path: "blockless-project/docs/wiring.md", kind: "wiring" }] });
  assert.ok(document.getElementById("wiringRunImage")!.classList.contains("hidden"), "no image -> the run-image slot hides");
});

test("optional-flow entries appear only for offered flows and dispatch start_optional_flow", async () => {
  const posted: any[] = [];
  const dom = await loadWebview(posted);
  const { document } = dom.window;
  // generate offered only the diagram flow
  post(dom, { type: "optional_flows", phases: [{ phase: "upy-diagram-plugin", reason: "arch" }] });
  assert.ok(document.getElementById("wiringEntry")!.classList.contains("hidden"), "wiring entry stays hidden (not offered)");
  const diagramEntry = document.getElementById("diagramEntry")!;
  assert.ok(!diagramEntry.classList.contains("hidden"), "diagram entry is shown (offered)");
  const btn = diagramEntry.querySelector("button.of-run") as HTMLButtonElement;
  assert.ok(btn, "the diagram run entry renders");
  // switch to the Diagram tab first, so the click's switch-back to Activity is actually verified
  (document.querySelector('.tab[data-tab="diagram"]') as HTMLButtonElement).click();
  btn.click();
  const start = posted.find((m) => m.type === "start_optional_flow");
  // Mutation: gate on nothing (always show) -> the wiring entry would also render.
  assert.ok(start && start.flow === "diagram", "clicking dispatches start_optional_flow for the offered flow");
  assert.equal(btn.disabled, true, "the button disables after dispatch");
  assert.match(btn.textContent!, /Generating/, "shows a working label after click");
  // Mutation: drop the setTab('activity') in the click handler -> Diagram stays active and this fails.
  assert.ok(document.querySelector('.tab[data-tab="activity"]')!.classList.contains("active"), "clicking switches to the Activity tab so the run streams into view");
});

test("a finished optional-flow run drops a jump card that switches to the tab", async () => {
  // When the host renders the run's image and posts optional_flow_done, Activity gets a card with a
  // View button that jumps to the Diagram/Wiring tab. Mutation: drop the setTab(flow) -> tab inactive.
  const dom = await loadWebview([]);
  const { document } = dom.window;
  post(dom, { type: "optional_flows", phases: [{ phase: "upy-diagram-plugin" }] });
  const trigger = document.getElementById("diagramEntry")!.querySelector("button.of-run") as HTMLButtonElement;
  trigger.click(); // sets it to the disabled "Generating…" state
  post(dom, { type: "optional_flow_done", flow: "diagram" });
  assert.equal(trigger.disabled, false, "the run's completion resets the trigger button");
  assert.equal(trigger.textContent, "Generate architecture diagram", "restores the trigger label");
  const view = [...document.getElementById("activity")!.querySelectorAll(".of-done button.of-run")].pop() as HTMLButtonElement;
  assert.ok(view && /View diagram/.test(view.textContent!), "a View diagram card renders in Activity");
  view.click();
  assert.ok(document.querySelector('.tab[data-tab="diagram"]')!.classList.contains("active"), "clicking the card jumps to the Diagram tab");
});

test("a #53 gen_driver_required message offers to build the driver; clicking dispatches the run", async () => {
  const posted: any[] = [];
  const dom = await loadWebview(posted);
  const { document } = dom.window;
  post(dom, { type: "gen_driver_required", blocks: [{ device: "SHT30", driver_id: "sht30", next_phase: "upy-gen-driver-plugin" }] });
  const card = document.querySelector("[data-gen-driver-offer]");
  assert.ok(card, "the offer card renders");
  assert.match(card!.textContent!, /SHT30/, "names the affected device");
  const btn = card!.querySelector("button") as HTMLButtonElement;
  btn.click();
  const start = posted.find((m) => m.type === "start_gen_driver");
  assert.ok(start, "clicking Build driver dispatches start_gen_driver (approval-first, never auto-start)");
  assert.ok(Array.isArray(start.sources) && start.sources.some((s: any) => s.type === "current_cold_driver_item"), "runs pipeline mode off the cold-driver source");
  assert.equal(btn.disabled, true, "the button disables after the click so it can't double-dispatch");
});

test("gen-driver Confirm & generate dispatches once and reveals the Activity run", async () => {
  // Repro of the reported blank: the confirm button gave no feedback and was multi-clickable on the
  // tool overlay while the run streamed to Activity behind it. It must dispatch, disable, and show Activity.
  const posted: any[] = [];
  const dom = await loadWebview(posted);
  const { document } = dom.window;
  post(dom, { type: "gen_driver_config", tabs: [
    { id: "chip", label: "Chip", sourceType: "chip_model", fields: [{ key: "chip_model", label: "Chip model", kind: "text", required: true }] },
  ] });
  const gd = document.getElementById("gendriver")!;
  (gd.querySelector("[data-gdkey='chip_model']") as HTMLInputElement).value = "SHT30";
  (gd.querySelector("button.gd-add") as HTMLButtonElement).click();            // + Add source
  (gd.querySelector(".gd-foot button.gd-gen") as HTMLButtonElement).click();   // Generate driver -> confirm card
  const confirm = document.querySelector("#gdStatus .gd-confirm button.gd-gen") as HTMLButtonElement;
  assert.ok(confirm, "the confirm card renders with a Confirm & generate button");
  (document.querySelector('.tab[data-tab="diagram"]') as HTMLButtonElement).click(); // move off Activity so the switch-back is verified
  confirm.click();
  const start = posted.find((m) => m.type === "start_gen_driver");
  assert.ok(start && Array.isArray(start.sources) && start.sources.length, "dispatches start_gen_driver with the assembled source");
  assert.equal(confirm.disabled, true, "confirm disables so a second click can't re-dispatch (the reported blank)");
  // Mutation: drop the setTab('activity') in the confirm handler -> Activity is not active and this fails.
  assert.ok(document.querySelector('.tab[data-tab="activity"]')!.classList.contains("active"), "switches to Activity so the run streams into view");
});

test("an approval card whose actions carry only `id` answers with the id, so Cancel cancels (not confirm)", async () => {
  // The wiring network-render card's actions carry `id`, not `value`. With the old value-only answer,
  // EVERY button (incl. Cancel) posted "confirm" -> the loop's cancel detection never fired (a Cancel
  // click silently approved). Mutation: revert ApprovalCardHost to `a.value` only -> answer is "confirm".
  const posted: any[] = [];
  const dom = await loadWebview(posted);
  const { document } = dom.window;
  post(dom, {
    type: "approval_request",
    promptId: "p1",
    card: {
      question: "SVG/PNG rendering uses mermaid.ink over the network. Render?",
      summary: "Local-only still produces JSON/Markdown/HTML and the pin table.",
      actions: [
        { id: "render_all", label: "Render all", primary: true },
        { id: "local_only", label: "Local only" },
        { id: "cancel", label: "Cancel" },
      ],
    },
  });
  const card = document.querySelector('.ev-card.ask[data-prompt-id="p1"]')!;
  assert.ok(card, "the approval card rendered");
  const cancelBtn = [...card.querySelectorAll(".ask-opt")].find((b) => b.textContent === "Cancel") as HTMLButtonElement;
  cancelBtn.click();
  const resp = posted.find((m) => m.type === "ui_prompt_response" && m.promptId === "p1");
  assert.ok(resp, "clicking an action posts ui_prompt_response");
  assert.equal(resp.answer, "cancel", "Cancel answers its id, not the confirm fallback");
});

test("gen-driver tab strip splits source-input tabs from config tabs", async () => {
  // The strip must group source tabs (sourceType !== null) apart from the config tabs
  // (Target driver / Verification, sourceType === null); one flat pill row made the config
  // tabs read as more sources. Mutation: render every tab in one strip -> only one group and
  // the config tabs land in the source group, failing the deepEqual assertions below.
  const dom = await loadWebview([]);
  const { document } = dom.window;
  post(dom, {
    type: "gen_driver_config",
    tabs: [
      { id: "pdf", label: "PDF datasheet", sourceType: "pdf", fields: [] },
      { id: "chip", label: "Chip/module model", sourceType: "chip_model", fields: [] },
      { id: "driver", label: "Target driver", sourceType: null, fields: [] },
      { id: "verification", label: "Verification settings", sourceType: null, fields: [] },
    ],
  });
  const groups = [...document.querySelectorAll("#gendriver .gd-tabgroup")];
  assert.equal(groups.length, 2, "one group for sources, one for config");
  assert.deepEqual(
    groups.map((g) => g.querySelector(".gd-tabgroup-label")!.textContent),
    ["Add a source", "Settings"],
  );
  const tabIds = (g: Element) => [...g.querySelectorAll(".gd-tab")].map((b) => (b as HTMLElement).dataset.gdtab);
  assert.deepEqual(tabIds(groups[0]), ["pdf", "chip"], "source tabs in the Add a source group");
  assert.deepEqual(tabIds(groups[1]), ["driver", "verification"], "config tabs in the Settings group");
});

test("Activity tab auto-scrolls to the latest when content is appended", async () => {
  // jsdom has no layout so scrollHeight is 0; fake a scroll extent and assert the observer pins
  // scrollTop to it on any append. Mutation: drop the MutationObserver -> scrollTop stays 0.
  const dom = await loadWebview([]);
  const { document } = dom.window;
  const list = document.getElementById("activity")!;
  // The scroll container is the .tabwrap ancestor (overflow-y:auto), NOT #activity's .view parent.
  const scroller = list.closest(".tabwrap") as HTMLElement;
  assert.ok(scroller, "activity lives inside the .tabwrap scroll container");
  Object.defineProperty(scroller, "scrollHeight", { configurable: true, value: 500 });
  scroller.scrollTop = 0;
  const card = document.createElement("div"); card.className = "ev-card"; card.textContent = "new activity";
  list.appendChild(card);
  await new Promise((r) => setTimeout(r, 0)); // MutationObserver callbacks fire on a microtask
  assert.equal(scroller.scrollTop, 500, "appending to the activity list scrolls .tabwrap to the bottom");
});

test("Activity auto-scroll sticks only when near the bottom (no yank if scrolled up)", async () => {
  // Industry-standard stick-to-bottom: a reader who scrolled up must not be yanked down by a stream.
  // Mutation: drop the `if (!stick) return` guard -> the scrolled-up case jumps to 500 and this fails.
  const dom = await loadWebview([]);
  const { document } = dom.window;
  const list = document.getElementById("activity")!;
  const scroller = list.closest(".tabwrap") as HTMLElement;
  Object.defineProperty(scroller, "scrollHeight", { configurable: true, value: 500 }); // clientHeight is 0 in jsdom, threshold 150 -> "at bottom" needs scrollTop >= 350
  const append = (t: string) => list.appendChild(Object.assign(document.createElement("div"), { className: "ev-card", textContent: t }));
  // scrolled up to read history -> a scroll event marks the reader "not at bottom"
  scroller.scrollTop = 0;
  scroller.dispatchEvent(new dom.window.Event("scroll"));
  append("streamed");
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(scroller.scrollTop, 0, "a scrolled-up reader is not yanked to the bottom");
  // scroll back near the bottom -> following resumes
  scroller.scrollTop = 400;
  scroller.dispatchEvent(new dom.window.Event("scroll"));
  append("more");
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(scroller.scrollTop, 500, "returning near the bottom re-enables follow");
});

test("returning to the Activity tab re-follows to the latest (no snap to top)", async () => {
  // Tabs share one .tabwrap scroller; showing a shorter view clamps scrollTop, so switching away
  // and back must re-scroll Activity to the bottom. Mutation: drop the setTab re-follow -> stays 0.
  const dom = await loadWebview([]);
  const { document } = dom.window;
  const tabwrap = document.querySelector(".tabwrap") as HTMLElement;
  Object.defineProperty(tabwrap, "scrollHeight", { configurable: true, value: 500 });
  (document.querySelector('.tab[data-tab="serial"]') as HTMLButtonElement).click();
  tabwrap.scrollTop = 0; // the clamp a shorter sibling view causes
  (document.querySelector('.tab[data-tab="activity"]') as HTMLButtonElement).click();
  assert.equal(tabwrap.scrollTop, 500, "returning to Activity scrolls .tabwrap to the bottom");
});


test("package browser: Search posts a package_search with the selected source and query", async () => {
  const posted: any[] = [];
  const dom = await loadWebview(posted);
  const { document } = dom.window;

  (document.getElementById("dtPkgSource") as HTMLSelectElement).value = "auto";
  (document.getElementById("dtPkgQuery") as HTMLInputElement).value = "temperature";
  (document.getElementById("dtPkgSearch") as HTMLButtonElement).click();

  const msg = posted.find((m) => m.type === "package_search");
  assert.ok(msg, "Search posts a package_search");
  assert.equal(msg.source, "auto");
  assert.equal(msg.query, "temperature");
});

test("package browser: an Auto merged list keys resolve on each result's own source", async () => {
  const posted: any[] = [];
  const dom = await loadWebview(posted);
  const { document } = dom.window;

  // A prior list clears the no-device guard so Install is enabled.
  post(dom, { type: "device_tool_result", command: "list", result: { path: "/", entries: [] } });
  // Auto returns a merged list: a full micropython-lib record + a name+url uPyPI hit.
  post(dom, { type: "package_search_result", source: "auto", results: [
    { name: "aioble", version: "0.6.0", source: "micropython_lib", description: "BLE", install_cmd: "mpremote mip install aioble" },
    { name: "bmp280", source: "upypi", url: "https://upypi.net/pkgs/bmp280/1.0.0" },
  ] });
  const rows = document.querySelectorAll("#dtPkgResults .dt-pkg-row");
  assert.equal(rows.length, 2, "both merged results render");

  // The micropython-lib row fills directly (no resolve) and installs by bare name.
  (rows[0] as HTMLButtonElement).click();
  assert.equal(posted.filter((m) => m.type === "package_resolve").length, 0, "a lib result does not resolve");
  (document.querySelector("#dtPkgResults .dt-pkg-detail:not(.hidden) .dt-pkg-install") as HTMLButtonElement).click();
  assert.equal(posted.find((m) => m.type === "device_tool_mip").url, "aioble", "lib installs by bare name");

  // The uPyPI row (name+url only) resolves on expand.
  (rows[1] as HTMLButtonElement).click();
  const resolve = posted.find((m) => m.type === "package_resolve");
  assert.ok(resolve && resolve.url === "https://upypi.net/pkgs/bmp280/1.0.0", "a uPyPI result resolves on expand");
});

test("package browser: results are an accordion (one open at a time, click again to close)", async () => {
  const dom = await loadWebview([]);
  const { document } = dom.window;
  post(dom, { type: "package_search_result", source: "micropython_lib", results: [
    { name: "aioble", version: "0.6.0", source: "micropython_lib", install_cmd: "mpremote mip install aioble" },
    { name: "urequests", version: "0.9.0", source: "micropython_lib", install_cmd: "mpremote mip install urequests" },
  ] });
  const rows = document.querySelectorAll("#dtPkgResults .dt-pkg-row");
  const bodies = document.querySelectorAll("#dtPkgResults .dt-pkg-detail");

  (rows[0] as HTMLButtonElement).click();
  assert.equal(bodies[0].classList.contains("hidden"), false, "first row expands");
  (rows[1] as HTMLButtonElement).click();
  assert.equal(bodies[0].classList.contains("hidden"), true, "opening the second collapses the first");
  assert.equal(bodies[1].classList.contains("hidden"), false, "second row expands");
  (rows[1] as HTMLButtonElement).click();
  assert.equal(bodies[1].classList.contains("hidden"), true, "clicking an open row closes it");
});

test("package browser: results paginate 10 per page", async () => {
  const dom = await loadWebview([]);
  const { document } = dom.window;
  const results = Array.from({ length: 12 }, (_, i) => ({ name: `pkg${String(i).padStart(2, "0")}`, source: "micropython_lib", install_cmd: "x" }));
  post(dom, { type: "package_search_result", source: "micropython_lib", results });

  assert.equal(document.querySelectorAll("#dtPkgResults .dt-pkg-row").length, 10, "first page shows 10 of 12");
  const pager = document.querySelector("#dtPkgResults .dt-pkg-pager")!;
  assert.ok(pager, "a pager appears when there are more than 10 results");
  const next = [...pager.querySelectorAll(".dt-pager-btn")].find((b: any) => b.textContent === "›") as HTMLButtonElement;
  next.click();
  assert.equal(document.querySelectorAll("#dtPkgResults .dt-pkg-row").length, 2, "next page shows the remaining 2");
});

test("package browser: each result row shows its source chip", async () => {
  const dom = await loadWebview([]);
  const { document } = dom.window;
  post(dom, { type: "package_search_result", source: "auto", results: [
    { name: "aioble", source: "micropython_lib", install_cmd: "x" },
    { name: "bmp280", source: "upypi", url: "u" },
  ] });
  const chips = [...document.querySelectorAll("#dtPkgResults .dt-pkg-src")].map((c: any) => c.textContent);
  assert.equal(chips.length, 2, "each row carries a source chip");
  assert.ok(chips.some((c: string) => /MicroPython-lib/i.test(c)), "a micropython-lib chip is shown");
  assert.ok(chips.some((c: string) => /uPyPI/i.test(c)), "a uPyPI chip is shown");
});

test("package browser: a card installs, shows Installed, then uninstalls", async () => {
  const posted: any[] = [];
  const dom = await loadWebview(posted);
  const { document } = dom.window;
  post(dom, { type: "device_tool_result", command: "list", result: { path: "/", entries: [] } }); // enable install
  post(dom, { type: "package_search_result", source: "micropython_lib", results: [
    { name: "aioble", version: "0.6.0", source: "micropython_lib", install_cmd: "mpremote mip install aioble" },
  ] });
  (document.querySelector("#dtPkgResults .dt-pkg-row") as HTMLButtonElement).click();
  const detail = document.querySelector("#dtPkgResults .dt-pkg-detail:not(.hidden)") as HTMLElement;
  const btn = detail.querySelector(".dt-pkg-install") as HTMLButtonElement;
  const status = detail.querySelector(".dt-pkg-cardstatus") as HTMLElement;

  // Install: shows the in-card progress bar and posts device_tool_mip.
  btn.click();
  assert.ok(posted.find((m) => m.type === "device_tool_mip"), "Install posts device_tool_mip");
  assert.ok(status.classList.contains("installing"), "the card shows the installing bar");

  // Result: bar clears, card shows Installed, button flips to Uninstall.
  post(dom, { type: "device_tool_result", command: "mip_install", result: { url: "aioble" } });
  assert.equal(status.classList.contains("installing"), false, "the bar clears on the result");
  assert.match(status.textContent || "", /Installed/i, "the card shows Installed");
  assert.equal(btn.dataset.installed, "1", "the button is now in the installed state");

  // Uninstall needs a confirm: the first click only arms ("Confirm?"), a second runs it.
  btn.click();
  assert.equal(posted.filter((m) => m.type === "device_tool_uninstall").length, 0, "first Uninstall click only arms");
  assert.match(btn.textContent || "", /Confirm/i, "the button shows a confirm prompt");
  btn.click();
  const un = posted.find((m) => m.type === "device_tool_uninstall");
  assert.ok(un && un.name === "aioble", "the confirm click posts device_tool_uninstall with the package name");
  post(dom, { type: "device_tool_result", command: "uninstall", result: { name: "aioble", removed: true } });
  assert.match(status.textContent || "", /Removed/i, "the card shows Removed");
  assert.equal(btn.dataset.installed, "", "the button is back to the install state");
});

test("package browser: an uninstall that removed nothing shows a truthful line, not 'Removed' (PR #45 review)", async () => {
  const posted: any[] = [];
  const dom = await loadWebview(posted);
  const { document } = dom.window;
  post(dom, { type: "device_tool_result", command: "list", result: { path: "/", entries: [] } });
  post(dom, { type: "package_search_result", source: "micropython_lib", results: [
    { name: "aioble", version: "0.6.0", source: "micropython_lib", install_cmd: "mpremote mip install aioble" },
  ] });
  (document.querySelector("#dtPkgResults .dt-pkg-row") as HTMLButtonElement).click();
  const detail = document.querySelector("#dtPkgResults .dt-pkg-detail:not(.hidden)") as HTMLElement;
  const btn = detail.querySelector(".dt-pkg-install") as HTMLButtonElement;
  const status = detail.querySelector(".dt-pkg-cardstatus") as HTMLElement;
  btn.click(); btn.click(); // arm + confirm the uninstall
  // The shim found nothing installed under that name (all paths absent): removed:false. The card
  // must NOT claim "Removed" -- that lies about what happened on the board.
  post(dom, { type: "device_tool_result", command: "uninstall", result: { name: "aioble", removed: false } });
  assert.doesNotMatch(status.textContent || "", /Removed/i, "removed:false must not render 'Removed'");
  assert.match(status.textContent || "", /Nothing to remove/i, "it shows a truthful 'nothing to remove' line");
});

test("package browser: a stale search ERROR does not wipe a newer query's results (PR #45 review)", async () => {
  const dom = await loadWebview([]);
  const { document } = dom.window;
  (document.getElementById("dtPkgSource") as HTMLSelectElement).value = "micropython_lib";
  const search = (q: string) => { (document.getElementById("dtPkgQuery") as HTMLInputElement).value = q; (document.getElementById("dtPkgSearch") as HTMLButtonElement).click(); };
  search("aaa");
  search("bbb"); // pending is now { query: "bbb" }
  post(dom, { type: "package_search_result", source: "micropython_lib", query: "bbb", results: [{ name: "bbbpkg", source: "micropython_lib", install_cmd: "x" }] });
  // The slower "aaa" FAILURE arrives after -> must be dropped, not blank out "bbb"'s results.
  post(dom, { type: "package_search_error", source: "micropython_lib", query: "aaa", error: "search_failed" });
  const names = [...document.querySelectorAll("#dtPkgResults .dt-pkg-name")].map((n: any) => n.textContent);
  assert.ok(names.some((n) => /bbbpkg/.test(n)), "the newer query's results survive the stale error");
});

test("package browser: a stale resolve ERROR for a collapsed row does not overwrite the open one (PR #45 review)", async () => {
  const dom = await loadWebview([]);
  const { document } = dom.window;
  post(dom, { type: "device_tool_result", command: "list", result: { path: "/", entries: [] } });
  post(dom, { type: "package_search_result", source: "upypi", results: [
    { name: "aaa", source: "upypi", url: "https://upypi.net/pkgs/aaa/1.0.0" },
    { name: "bbb", source: "upypi", url: "https://upypi.net/pkgs/bbb/1.0.0" },
  ] });
  const rows = document.querySelectorAll("#dtPkgResults .dt-pkg-row");
  (rows[0] as HTMLButtonElement).click(); // expand A -> resolve A
  (rows[1] as HTMLButtonElement).click(); // expand B -> resolve B (A collapses; pending = B's url)
  const bodyB = document.querySelectorAll("#dtPkgResults .dt-pkg-detail")[1] as HTMLElement;
  // A's resolve ERROR arrives late. With the url echoed it must be dropped, not stamp an error on B.
  post(dom, { type: "package_resolve_error", url: "https://upypi.net/pkgs/aaa/1.0.0", error: "resolve_failed" });
  assert.doesNotMatch(bodyB.textContent || "", /failed|error/i, "A's late error must not overwrite B's still-loading body");
  // B's own resolve then fills B correctly (proves B was never clobbered).
  post(dom, { type: "package_resolve_result", url: "https://upypi.net/pkgs/bbb/1.0.0", record: { name: "bbb", source: "upypi", install_cmd: "mip-BBB" } });
  assert.match(bodyB.textContent || "", /mip-BBB/, "B's own resolve fills B");
});

test("package browser: an unplug-during-install clears the in-flight guard so Install works after replug (PR #45 #2)", async () => {
  const posted: any[] = [];
  const dom = await loadWebview(posted);
  const { document } = dom.window;
  const installOnce = () => {
    post(dom, { type: "device_tool_result", command: "list", result: { path: "/", entries: [] } });
    post(dom, { type: "package_search_result", source: "micropython_lib", results: [
      { name: "aioble", version: "0.6.0", source: "micropython_lib", install_cmd: "mpremote mip install aioble" },
    ] });
    (document.querySelector("#dtPkgResults .dt-pkg-row") as HTMLButtonElement).click();
    (document.querySelector("#dtPkgResults .dt-pkg-detail:not(.hidden) .dt-pkg-install") as HTMLButtonElement).click();
  };
  installOnce();
  assert.equal(posted.filter((m) => m.type === "device_tool_mip").length, 1, "first install posted");
  // Board unplugged mid-install: the device-gone error returns before the normal in-flight clear,
  // so dtShowNoDevice must reset it, or every later Install/Uninstall silently no-ops.
  post(dom, { type: "device_tool_error", command: "mip_install", error: "device_unavailable" });
  installOnce();
  assert.equal(posted.filter((m) => m.type === "device_tool_mip").length, 2, "a new install proceeds after the device-gone error cleared the guard");
});

test("package browser: a late resolve for a re-collapsed row does not fill the wrong body (PR #45 #4)", async () => {
  const dom = await loadWebview([]);
  const { document } = dom.window;
  post(dom, { type: "device_tool_result", command: "list", result: { path: "/", entries: [] } });
  post(dom, { type: "package_search_result", source: "upypi", results: [
    { name: "aaa", source: "upypi", url: "https://upypi.net/pkgs/aaa/1.0.0" },
    { name: "bbb", source: "upypi", url: "https://upypi.net/pkgs/bbb/1.0.0" },
  ] });
  const rows = document.querySelectorAll("#dtPkgResults .dt-pkg-row");
  (rows[0] as HTMLButtonElement).click(); // expand A -> resolve A
  (rows[1] as HTMLButtonElement).click(); // expand B -> resolve B (A collapses; pending = B's url)
  const bodyB = document.querySelectorAll("#dtPkgResults .dt-pkg-detail")[1] as HTMLElement;
  // A's resolve arrives LATE (out of order). With the url echoed it must be dropped, not fill B.
  // (install_cmd is rendered into the body; description is only in the row head.)
  post(dom, { type: "package_resolve_result", url: "https://upypi.net/pkgs/aaa/1.0.0", record: { name: "aaa", source: "upypi", install_cmd: "mip-AAA" } });
  assert.doesNotMatch(bodyB.textContent || "", /mip-AAA/, "A's late resolve must not fill B (would install A under B)");
  // B's own resolve then fills B correctly.
  post(dom, { type: "package_resolve_result", url: "https://upypi.net/pkgs/bbb/1.0.0", record: { name: "bbb", source: "upypi", install_cmd: "mip-BBB" } });
  assert.match(bodyB.textContent || "", /mip-BBB/, "B's own resolve fills B");
});

test("package browser: a resolve error surfaces on the row instead of throwing (PR #45 review)", async () => {
  const dom = await loadWebview([]);
  const { document } = dom.window;
  post(dom, { type: "device_tool_result", command: "list", result: { path: "/", entries: [] } });
  post(dom, { type: "package_search_result", source: "upypi", results: [
    { name: "aaa", source: "upypi", url: "https://upypi.net/pkgs/aaa/1.0.0" },
  ] });
  (document.querySelector("#dtPkgResults .dt-pkg-row") as HTMLButtonElement).click(); // expand -> resolve pending
  const body = document.querySelector("#dtPkgResults .dt-pkg-detail") as HTMLElement;
  // The resolve fails: the handler must NOT throw (it referenced a renamed var) and must clear the
  // "Searching…" placeholder to an error, or the row is stuck forever.
  post(dom, { type: "package_resolve_error", error: "resolve_failed" });
  assert.ok((body.textContent || "").length > 0, "the row shows something (handler did not throw)");
  assert.doesNotMatch(body.textContent || "", /Searching|Loading/i, "the row is no longer stuck on the loading placeholder");
});

test("package browser: a stale search reply does not overwrite a newer query (PR #45 #6)", async () => {
  const dom = await loadWebview([]);
  const { document } = dom.window;
  (document.getElementById("dtPkgSource") as HTMLSelectElement).value = "micropython_lib";
  const search = (q: string) => { (document.getElementById("dtPkgQuery") as HTMLInputElement).value = q; (document.getElementById("dtPkgSearch") as HTMLButtonElement).click(); };
  search("aaa");
  search("bbb"); // pending is now { query: "bbb" }
  post(dom, { type: "package_search_result", source: "micropython_lib", query: "bbb", results: [{ name: "bbbpkg", source: "micropython_lib", install_cmd: "x" }] });
  // The slower "aaa" reply arrives after -> must be dropped, not overwrite "bbb".
  post(dom, { type: "package_search_result", source: "micropython_lib", query: "aaa", results: [{ name: "aaapkg", source: "micropython_lib", install_cmd: "x" }] });
  const names = [...document.querySelectorAll("#dtPkgResults .dt-pkg-name")].map((n: any) => n.textContent);
  assert.ok(names.some((n) => /bbbpkg/.test(n)), "the newer query's results are shown");
  assert.ok(!names.some((n) => /aaapkg/.test(n)), "the stale query's late reply was dropped");
});

test("package browser: a board swap between polls drops the prior board's installed rows (PR #45 #7)", async () => {
  const dom = await loadWebview([]);
  const { document } = dom.window;
  document.getElementById("deviceToolsOpen")!.click();
  post(dom, { type: "device_present", present: true, ports: ["COM3"] });          // board A on COM3
  post(dom, { type: "device_tool_result", command: "list_lib", result: { entries: ["aioble/"] } });
  assert.equal(document.querySelectorAll("#dtPkgInstalled .dt-row").length, 1, "board A's installed row shows");
  // Board B on a different port, never reporting zero between polls.
  post(dom, { type: "device_present", present: true, ports: ["COM7"] });
  assert.equal(document.querySelectorAll("#dtPkgInstalled .dt-row").length, 0, "A's installed rows cleared on the swap (no stale Uninstall row)");
});

test("installed view: an errored list_lib clears the installed set so search cards aren't mis-marked (PR #45 review)", async () => {
  const dom = await loadWebview([]);
  const { document } = dom.window;
  document.getElementById("deviceToolsOpen")!.click();
  post(dom, { type: "device_present", present: true, ports: ["COM3"] });
  post(dom, { type: "device_tool_result", command: "list_lib", result: { entries: ["aioble/"] } });
  assert.equal(document.querySelectorAll("#dtPkgInstalled .dt-row").length, 1, "aioble shows installed");
  // A later /lib listing fails (not a clean "empty board"): the prior installed set must be
  // dropped, else a search card for aioble mislabels its button as the installed state.
  post(dom, { type: "device_tool_error", command: "list_lib", error: "device_busy" });
  assert.equal(document.querySelectorAll("#dtPkgInstalled .dt-row").length, 0, "the errored listing clears the rows");
  post(dom, { type: "package_search_result", source: "micropython_lib", results: [
    { name: "aioble", version: "0.6.0", source: "micropython_lib", install_cmd: "mpremote mip install aioble" },
  ] });
  (document.querySelector("#dtPkgResults .dt-pkg-row") as HTMLButtonElement).click(); // expand to render its button
  const btn = document.querySelector("#dtPkgResults .dt-pkg-detail:not(.hidden) .dt-pkg-install") as HTMLButtonElement;
  assert.equal(btn.dataset.installed, "", "aioble's card is NOT marked installed after the errored listing");
});

test("installed view: a list_lib result does NOT repaint the Board files pane", async () => {
  const dom = await loadWebview([]);
  const { document } = dom.window;
  post(dom, { type: "device_tool_result", command: "list", result: { path: "/", entries: ["boot.py", "lib/"] } });
  const filesBefore = document.querySelectorAll("#dtEntries .dt-name").length;

  post(dom, { type: "device_tool_result", command: "list_lib", result: { entries: ["aioble/"] } });

  assert.equal(document.querySelectorAll("#dtEntries .dt-name").length, filesBefore, "Board files list is untouched by list_lib");
  assert.equal((document.getElementById("dtPath") as HTMLInputElement).value, "/", "the Board files path is unchanged");
  assert.equal(document.querySelectorAll("#dtPkgInstalled .dt-row").length, 1, "the installed view rendered the /lib entry");
});

test("installed view: toggle switches views and lists /lib", async () => {
  const posted: any[] = [];
  const dom = await loadWebview(posted);
  const { document } = dom.window;
  (document.getElementById("dtPkgModeInstalled") as HTMLButtonElement).click();
  assert.equal((document.getElementById("dtPkgSearchView") as HTMLElement).classList.contains("hidden"), true, "search view hidden");
  assert.equal((document.getElementById("dtPkgInstalledView") as HTMLElement).classList.contains("hidden"), false, "installed view shown");
  assert.equal(document.getElementById("dtPkgModeInstalled")!.getAttribute("aria-pressed"), "true");
  assert.ok(posted.find((m) => m.type === "device_tool_list_lib"), "switching to Installed lists /lib");
  (document.getElementById("dtPkgModeSearch") as HTMLButtonElement).click();
  assert.equal((document.getElementById("dtPkgSearchView") as HTMLElement).classList.contains("hidden"), false, "search view restored");
});

test("installed view: parses /lib entries (dir + .mpy/.py, deduped)", async () => {
  const dom = await loadWebview([]);
  const { document } = dom.window;
  post(dom, { type: "device_tool_result", command: "list_lib", result: { entries: ["aioble/", "urequests.mpy", "bmp280.py", "urequests.py"] } });
  const names = [...document.querySelectorAll("#dtPkgInstalled .dt-name")].map((n: any) => n.textContent);
  assert.deepEqual(names, ["aioble", "urequests", "bmp280"], "dir + module names, urequests deduped");
});

test("installed view: empty /lib shows the empty state; Uninstall posts + refreshes", async () => {
  const posted: any[] = [];
  const dom = await loadWebview(posted);
  const { document } = dom.window;
  post(dom, { type: "device_tool_result", command: "list", result: { path: "/", entries: [] } }); // clear no-device
  post(dom, { type: "device_tool_result", command: "list_lib", result: { entries: [] } });
  assert.equal(document.getElementById("dtPkgInstalledEmpty")!.classList.contains("hidden"), false, "empty state shown for empty /lib");

  post(dom, { type: "device_tool_result", command: "list_lib", result: { entries: ["aioble/"] } });
  const uninstallBtn = document.querySelector("#dtPkgInstalled .dt-row .dt-act") as HTMLButtonElement;
  uninstallBtn.click(); uninstallBtn.click(); // arm + confirm
  assert.ok(posted.find((m) => m.type === "device_tool_uninstall" && m.name === "aioble"), "Uninstall posts device_tool_uninstall after confirm");
  const before = posted.filter((m) => m.type === "device_tool_list_lib").length;
  post(dom, { type: "device_tool_result", command: "uninstall", result: { name: "aioble" } });
  assert.ok(posted.filter((m) => m.type === "device_tool_list_lib").length > before, "an uninstall refreshes the installed list");
});

test("installed view: a search result is marked Installed from the real /lib set", async () => {
  const dom = await loadWebview([]);
  const { document } = dom.window;
  post(dom, { type: "device_tool_result", command: "list_lib", result: { entries: ["aioble/"] } }); // seed the set
  post(dom, { type: "package_search_result", source: "micropython_lib", results: [
    { name: "aioble", version: "0.6.0", source: "micropython_lib", install_cmd: "mpremote mip install aioble" },
  ] });
  (document.querySelector("#dtPkgResults .dt-pkg-row") as HTMLButtonElement).click();
  const btn = document.querySelector("#dtPkgResults .dt-pkg-detail:not(.hidden) .dt-pkg-install") as HTMLButtonElement;
  assert.equal(btn.dataset.installed, "1", "an already-installed package shows as Uninstall in search results");
});

test("installed view: paginates 10 per page", async () => {
  const dom = await loadWebview([]);
  const { document } = dom.window;
  const entries = Array.from({ length: 12 }, (_, i) => `pkg${String(i).padStart(2, "0")}.py`);
  post(dom, { type: "device_tool_result", command: "list_lib", result: { entries } });
  assert.equal(document.querySelectorAll("#dtPkgInstalled .dt-row").length, 10, "first page shows 10 of 12");
  const next = [...document.querySelectorAll("#dtPkgInstalled .dt-pager-btn")].find((b: any) => b.textContent === "›") as HTMLButtonElement;
  next.click();
  assert.equal(document.querySelectorAll("#dtPkgInstalled .dt-row").length, 2, "next page shows the remaining 2");
});

test("installed view: a not-found /lib error shows the empty state, not an error", async () => {
  const dom = await loadWebview([]);
  const { document } = dom.window;
  // A fresh board has no /lib; the shim forwards the real message so the not-found branch fires.
  post(dom, { type: "device_tool_error", command: "list_lib", error: "mpremote_error: ls: /lib: No such file or directory." });
  assert.equal(document.getElementById("dtPkgInstalledEmpty")!.classList.contains("hidden"), false, "no /lib -> empty state");
  assert.equal((document.getElementById("dtPkgStatus")!.textContent || "").trim(), "", "no error surfaced for a missing /lib");
});

test("installed view: a real /lib read error surfaces a message", async () => {
  const dom = await loadWebview([]);
  const { document } = dom.window;
  post(dom, { type: "device_tool_error", command: "list_lib", error: "mpremote_error: some genuine failure" });
  assert.match(document.getElementById("dtPkgStatus")!.textContent || "", /Could not read/i, "a genuine error is surfaced");
});

test("packages: only one install runs at a time; the first card flips, not the second", async () => {
  const posted: any[] = [];
  const dom = await loadWebview(posted);
  const { document } = dom.window;
  post(dom, { type: "device_tool_result", command: "list", result: { path: "/", entries: [] } }); // enable install
  post(dom, { type: "package_search_result", source: "micropython_lib", results: [
    { name: "aioble", version: "0.6.0", source: "micropython_lib", install_cmd: "x" },
    { name: "urequests", version: "0.9.0", source: "micropython_lib", install_cmd: "y" },
  ] });
  const rows = document.querySelectorAll("#dtPkgResults .dt-pkg-row");

  (rows[0] as HTMLButtonElement).click();
  const btnA = document.querySelector("#dtPkgResults .dt-pkg-detail:not(.hidden) .dt-pkg-install") as HTMLButtonElement;
  btnA.click(); // install A -> in flight
  (rows[1] as HTMLButtonElement).click(); // expand B (collapses A but keeps btnA in the DOM)
  const btnB = document.querySelector("#dtPkgResults .dt-pkg-detail:not(.hidden) .dt-pkg-install") as HTMLButtonElement;
  btnB.click(); // ignored while A is pending

  assert.equal(posted.filter((m) => m.type === "device_tool_mip").length, 1, "a second install while one is pending is ignored");
  post(dom, { type: "device_tool_result", command: "mip_install", result: { url: "aioble" } });
  assert.equal(btnA.dataset.installed, "1", "the first card is marked installed by its own result");
  assert.equal(btnB.dataset.installed, "", "the second card is untouched");
});

test("package browser: a uPyPI result resolves lazily on click, then shows metadata", async () => {
  const posted: any[] = [];
  const dom = await loadWebview(posted);
  const { document } = dom.window;

  post(dom, { type: "device_tool_result", command: "list", result: { path: "/", entries: [] } }); // enable Install
  post(dom, { type: "package_search_result", source: "upypi", results: [
    { name: "bmp280", source: "upypi", url: "https://upypi.net/pkgs/bmp280/1.0.0" },
  ] });
  (document.querySelector("#dtPkgResults .dt-pkg-row") as HTMLButtonElement).click();

  const resolve = posted.find((m) => m.type === "package_resolve");
  assert.ok(resolve, "clicking a uPyPI hit posts package_resolve");
  assert.equal(resolve.url, "https://upypi.net/pkgs/bmp280/1.0.0");

  post(dom, { type: "package_resolve_result", record: {
    name: "bmp280", version: "1.0.0", source: "upypi", author: "leezisheng", license: "MIT",
    package_json_url: "https://upypi.net/pkgs/bmp280/1.0.0/package.json",
    install_cmd: "mpremote mip install https://upypi.net/pkgs/bmp280/1.0.0/package.json",
    urls: [["bmp280.py", "code/bmp280.py"]],
    deps: [["https://upypi.net/pkgs/ws61_driver/1.0.0", "latest"]],
  } });
  const detail = document.querySelector("#dtPkgResults .dt-pkg-detail:not(.hidden)") as HTMLElement;
  assert.match(detail.textContent || "", /leezisheng/, "author shown in detail");
  assert.match(detail.textContent || "", /MIT/, "license shown in detail");
  assert.match(detail.textContent || "", /bmp280\.py/, "url/file list shown in detail");
  assert.doesNotMatch(detail.textContent || "", /code\/bmp280\.py/, "shows the target name, not the raw source path");
  assert.match(detail.textContent || "", /ws61_driver/, "dependency name (not just count) shown in detail");
  assert.doesNotMatch(detail.textContent || "", /upypi\.net\/pkgs\/ws61_driver/, "shows the dep name, not the raw ref url");
  (detail.querySelector(".dt-pkg-install") as HTMLButtonElement).click();
  const mip = posted.find((m) => m.type === "device_tool_mip");
  assert.ok(mip && mip.url === "https://upypi.net/pkgs/bmp280/1.0.0/package.json", "a resolved uPyPI package installs by its package.json url");
});

test("package browser: micropython-lib detail links the repo and installs by name", async () => {
  const posted: any[] = [];
  const dom = await loadWebview(posted);
  const { document } = dom.window;

  post(dom, { type: "device_tool_result", command: "list", result: { path: "/", entries: [] } }); // clear no-device
  post(dom, { type: "package_search_result", source: "micropython_lib", results: [
    { name: "aioble", version: "0.6.0", source: "micropython_lib", description: "BLE",
      repo_url: "https://github.com/micropython/micropython-lib/tree/master/micropython/bluetooth/aioble",
      install_cmd: "mpremote mip install aioble" },
  ] });
  (document.querySelector("#dtPkgResults .dt-pkg-row") as HTMLButtonElement).click();
  const detail = document.querySelector("#dtPkgResults .dt-pkg-detail:not(.hidden)") as HTMLElement;
  assert.match(detail.textContent || "", /micropython-lib\/tree\/master/, "repo_url surfaced for micropython-lib");
  (detail.querySelector(".dt-pkg-install") as HTMLButtonElement).click();
  const mip = posted.find((m) => m.type === "device_tool_mip");
  assert.ok(mip && mip.url === "aioble", "micropython-lib installs by bare name");
});

test("package browser: MicroPython-lib searches by name; GitHub is not a search source", async () => {
  const posted: any[] = [];
  const dom = await loadWebview(posted);
  const { document } = dom.window;

  // A prior list clears the no-device guard so Install is enabled.
  post(dom, { type: "device_tool_result", command: "list", result: { path: "/", entries: [] } });
  (document.getElementById("dtPkgSource") as HTMLSelectElement).value = "micropython_lib";
  (document.getElementById("dtPkgQuery") as HTMLInputElement).value = "aioble";
  (document.getElementById("dtPkgSearch") as HTMLButtonElement).click();
  const libSearch = posted.find((m) => m.type === "package_search");
  assert.ok(libSearch && libSearch.source === "micropython_lib", "micropython-lib triggers a search");

  post(dom, { type: "package_search_result", source: "micropython_lib", results: [
    { name: "aioble", version: "0.6.0", source: "micropython_lib", description: "BLE", install_cmd: "mpremote mip install aioble" },
  ] });
  const rows = document.querySelectorAll("#dtPkgResults .dt-pkg-row");
  assert.equal(rows.length, 1, "lib result renders directly (no per-package resolve)");

  (rows[0] as HTMLButtonElement).click();
  (document.querySelector("#dtPkgResults .dt-pkg-detail:not(.hidden) .dt-pkg-install") as HTMLButtonElement).click();
  const mip = posted.find((m) => m.type === "device_tool_mip");
  assert.ok(mip && mip.url === "aioble", "micropython-lib installs by bare name");

  // GitHub is no longer a search source; the selector offers only the searchable ones.
  const sourceValues = [...(document.getElementById("dtPkgSource") as HTMLSelectElement).options].map((o) => o.value);
  assert.deepEqual(sourceValues, ["auto", "micropython_lib", "upypi"], "selector has no github option");
});
