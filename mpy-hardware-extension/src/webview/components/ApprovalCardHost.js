
      // ----- ask_user (interactive prompt; pauses the agent until answered) -----
      // options: clickable choices. optionsRequiringText: the subset of those that
      // mean "I'll provide a value" — clicking one holds the choice and waits for the
      // user to type that value (a URL/number/path) instead of ending the turn empty.
      // Protocol approval_request: the single rich card (replaces ask/components/
      // plan/deploy). Items render as checkboxes (default selected), actions as
      // buttons; the chosen action + selected ids + text values ride back as a
      // ui_prompt_response, which the controller resolves into approval_response.
      // Fallback group headers when a card carries no authored label (real scaffold
      // cards do carry one). Keys resolve via tr() (shared.js en+zh).
      const GROUP_LABEL_KEYS = { scheduler_mode: "group_scheduler_mode", extra_modules: "group_extra_modules" };
      // The ESP32 flash-confirm card gets a live serial-port picker (the baud picker is disabled
      // below -- see the note there).
      const FLASH_CONFIRM_ID = "esp32_flash_confirm";
      const FLASH_ACTION = "flash_now";
      // BAUD PICKER GATED ON RUILI: the flash plugin does not yet honor a user-chosen baud -- its
      // flasher (third_party/MicroPython_Skills .../esp32_flash.py) reads baud only from
      // install.baud (built from the download page), and nothing threads approval_response.baud
      // into it. Shipping the dropdown would let the user pick a baud the flash silently ignores.
      // Re-enable this const + the picker block + the msg.baud send below once ruili's plugin
      // consumes approval_response.baud (or esp32_flash.py gains a --baud override).
      // const FLASH_BAUDS = ["460800", "115200", "230400", "921600"];

      // A scalar summary/detail value: render an http(s) URL as a real clickable link
      // (http/https only — never an arbitrary scheme, so no javascript:/data: href),
      // otherwise plain text. Long values wrap via CSS (overflow-wrap) so a URL like
      // firmware_page doesn't clip at a narrow panel width.
      function renderScalarValue(text) {
        if (/^https?:\/\/\S+$/i.test(text)) {
          const a = document.createElement("a"); a.className = "ask-link";
          a.setAttribute("href", text); a.setAttribute("target", "_blank"); a.setAttribute("rel", "noreferrer");
          a.textContent = text; return a;
        }
        return document.createTextNode(text);
      }

      // Card body: the flash/scaffold cards carry their detail in summary/steps/guidance/
      // links, which the renderer used to drop — leaving the flash confirm card as just
      // three buttons. Render them with textContent/anchors only, never innerHTML.
      function renderApprovalBody(main, card) {
        const summary = card.summary;
        if (summary && typeof summary === "object" && !Array.isArray(summary)) {
          const kv = document.createElement("div"); kv.className = "ask-kv";
          Object.keys(summary).forEach((k) => {
            const v = summary[k];
            if (v == null || typeof v === "object") return; // scalar values only
            const row = document.createElement("div"); row.className = "ask-kv-row";
            const kEl = document.createElement("span"); kEl.className = "ask-kv-k"; kEl.textContent = String(k) + ": ";
            row.appendChild(kEl); row.appendChild(renderScalarValue(String(v)));
            kv.appendChild(row);
          });
          if (kv.children.length) main.appendChild(kv);
        } else if (typeof summary === "string" && summary.trim()) {
          const p = document.createElement("div"); p.className = "ev-sum"; p.textContent = summary.trim(); main.appendChild(p);
        }
        const steps = Array.isArray(card.steps) ? card.steps : [];
        if (steps.length) {
          const ol = document.createElement("ol"); ol.className = "ask-steps";
          steps.forEach((s) => { if (s == null || typeof s === "object") return; const li = document.createElement("li"); li.textContent = String(s); ol.appendChild(li); });
          if (ol.children.length) main.appendChild(ol);
        }
        // guidance is an OBJECT per the protocol (02-protocol.md): {tool, steps[], normal_range,
        // diagram_ref} -- render each present field. A plain-string guidance is still honored for
        // back-compat. Before, only the string form rendered, so an object card (the contract
        // shape) showed no safety/troubleshooting detail at all.
        if (typeof card.guidance === "string" && card.guidance.trim()) {
          const g = document.createElement("div"); g.className = "ask-guidance"; g.textContent = card.guidance.trim(); main.appendChild(g);
        } else if (card.guidance && typeof card.guidance === "object" && !Array.isArray(card.guidance)) {
          renderGuidanceObject(card.guidance, main);
        }
        const links = Array.isArray(card.links) ? card.links : [];
        if (links.length) {
          const box = document.createElement("div"); box.className = "ask-links";
          links.forEach((l) => {
            if (!l) return;
            const href = typeof l === "string" ? l : (l.url || l.href);
            // http/https only, same as renderScalarValue -- a card's links come from the same
            // untrusted producer, so a `javascript:`/`data:` href must NOT become a live anchor.
            if (!href || !/^https?:\/\/\S+$/i.test(String(href))) return;
            const a = document.createElement("a"); a.className = "ask-link";
            a.setAttribute("href", String(href)); a.setAttribute("target", "_blank"); a.setAttribute("rel", "noreferrer");
            a.textContent = String((l && l.label) || (l && l.title) || href);
            box.appendChild(a);
          });
          if (box.children.length) main.appendChild(box);
        }
      }

      // Render the object form of `guidance` ({tool, steps[], normal_range, diagram_ref}). Each
      // field is optional; scalars render as a labeled line, steps as an ordered list. Nothing is
      // appended if every field is empty.
      function renderGuidanceObject(g, main) {
        const box = document.createElement("div"); box.className = "ask-guidance";
        const line = (labelKey, value) => {
          if (value == null || typeof value === "object") return;
          const text = String(value).trim(); if (!text) return;
          const row = document.createElement("div"); row.className = "ask-guidance-row";
          const k = document.createElement("span"); k.className = "ask-guidance-k"; k.textContent = tr(labelKey) + ": ";
          row.appendChild(k); row.appendChild(document.createTextNode(text)); box.appendChild(row);
        };
        line("guidance_tool", g.tool);
        const steps = Array.isArray(g.steps) ? g.steps : [];
        if (steps.length) {
          const label = document.createElement("div"); label.className = "ask-guidance-k"; label.textContent = tr("guidance_steps") + ":"; box.appendChild(label);
          const ol = document.createElement("ol"); ol.className = "ask-steps";
          steps.forEach((s) => { if (s == null || typeof s === "object") return; const li = document.createElement("li"); li.textContent = String(s); ol.appendChild(li); });
          if (ol.children.length) box.appendChild(ol); else box.removeChild(label);
        }
        line("guidance_normal_range", g.normal_range);
        line("guidance_diagram", g.diagram_ref);
        if (box.children.length) main.appendChild(box);
      }

      // Render one item_groups section: a header + its items. multi_select:false renders
      // radios sharing one name (native mutual exclusion); otherwise checkboxes. renderItem
      // is passed in so every input still lands in the card's shared checks[] array.
      function renderApprovalGroup(group, items, main, promptId, renderItem) {
        const gid = group.id == null ? "" : String(group.id);
        // An item belongs to this group two ways: declared INLINE in group.items, OR listed flat in
        // card.items with .group === gid (those are already excluded from the flat pass). Merge both
        // and dedup by id so an item present in BOTH forms renders exactly once. Before, inline items
        // SHADOWED the flat ones, so a flat item pointing at an inline-items group rendered nowhere
        // while the headless loop still counted it (protocol-loop dedups the same way now).
        // A keyless group (gid == "") must NOT vacuum up every ungrouped item (it.group == null also
        // stringifies to ""), so its flat set is empty -- it's honored only via inline items.
        const inline = Array.isArray(group.items) ? group.items : [];
        const flat = gid ? items.filter((it) => it && String(it.group == null ? "" : it.group) === gid) : [];
        const seen = new Set();
        const groupItems = [];
        for (const it of [...inline, ...flat]) {
          const key = it && it.id != null ? String(it.id) : null;
          if (key != null) { if (seen.has(key)) continue; seen.add(key); }
          groupItems.push(it);
        }
        if (!groupItems.length) return;
        const single = group.multi_select === false;
        const section = document.createElement("div"); section.className = "ask-group";
        const h = document.createElement("div"); h.className = "ask-group-h";
        const labelKey = Object.prototype.hasOwnProperty.call(GROUP_LABEL_KEYS, gid) ? GROUP_LABEL_KEYS[gid] : "";
        h.textContent = group.label != null ? String(group.label) : tr(labelKey);
        if (h.textContent) section.appendChild(h);
        const radioName = single ? "apr-" + String(promptId) + "-" + gid : null;
        const pairs = groupItems.map((it) => ({ it, inp: renderItem(it, section, radioName) })).filter((p) => p.inp);
        // Single-choice: exactly ONE radio checked. renderItem defaults selected:undefined
        // to checked, which for radios would leave several checked at once (checkedness is
        // set while each radio is detached, so browsers don't auto-uncheck group mates).
        // Force the first explicitly-selected item (else the first) and clear the rest —
        // matching the headless one-per-group rule (protocol-loop.ts).
        if (single && pairs.length) {
          const chosen = pairs.find((p) => p.it && p.it.selected === true) || pairs[0];
          pairs.forEach((p) => { p.inp.checked = (p === chosen); });
        }
        main.appendChild(section);
      }

      // True only while a restored session's past prompts are being re-rendered as INERT cards (Stage 2).
      // The renderers are reused verbatim so the cards look exactly like they did live; this flag suppresses
      // ONLY their render-time host side effects (device rescans / owning currentDeployCard), which must not
      // fire for a historical, non-interactive card. It is false during every live run, so live behavior is
      // provably unchanged. finalizeInertCard then disables the card and shows the answer it got.
      let replaying = false;

      function addApprovalPrompt(promptId, card) {
        finalizeThinking();
        clearPending();
        $("activityEmpty").classList.add("hidden");
        setTab("activity");
        card = card || {};
        const items = Array.isArray(card.items) ? card.items : [];
        const actions = (Array.isArray(card.actions) && card.actions.length) ? card.actions : [{ label: tr("send"), value: "confirm", primary: true }];
        const textInputs = Array.isArray(card.text_inputs) ? card.text_inputs : [];
        const el = document.createElement("div");
        el.className = "ev fade-in";
        const wrap = document.createElement("div"); wrap.className = "ev-card ask"; wrap.dataset.promptId = String(promptId);
        const head = document.createElement("div"); head.className = "ev-head";
        const main = document.createElement("div"); main.className = "ev-main";
        const label = document.createElement("div"); label.className = "ev-label";
        const kind = document.createElement("span"); kind.className = "kind";
        kind.textContent = card.header ? String(card.header) : tr("kind_question");
        label.appendChild(kind); main.appendChild(label);
        const q = document.createElement("div"); q.className = "ev-sum ask-q";
        q.textContent = card.question == null ? "" : String(card.question);
        main.appendChild(q);
        renderApprovalBody(main, card);
        const checks = [];
        // A single-choice group (multi_select:false) renders radios sharing one name for
        // native mutual exclusion; multi-select and ungrouped items stay checkboxes. Every
        // input lands in checks[] so the selected_ids computation stays uniform.
        const renderItem = (it, host, radioName) => {
          if (!it || typeof it !== "object") return null;
          const row = document.createElement("label"); row.className = "ask-opt"; row.style.display = "block";
          const inp = document.createElement("input"); inp.type = radioName ? "radio" : "checkbox";
          if (radioName) inp.name = radioName;
          inp.checked = it.selected !== false; inp.dataset.id = it.id == null ? "" : String(it.id);
          inp.disabled = it.selectable === false; checks.push(inp); row.appendChild(inp);
          const span = document.createElement("span");
          span.textContent = " " + (it.name == null ? "" : String(it.name)) + (it.subtitle ? " — " + String(it.subtitle) : "");
          row.appendChild(span); host.appendChild(row); return inp;
        };
        // item_groups is contract-valid as an array OR an object map (keyed by group id).
        // Normalize to {id,label,multi_select,items}, preserving the key as the id.
        // Array form uses group_id/group_header (spec 02-protocol.md); object form is keyed
        // by group id. Normalize both to {id,label,multi_select,items}.
        const groupList = Array.isArray(card.item_groups)
          ? card.item_groups.map((g) => ({ id: g && (g.group_id != null ? g.group_id : g.id), label: g && (g.group_header != null ? g.group_header : g.label), multi_select: g && g.multi_select, items: g && g.items }))
          : Object.keys(card.item_groups || {}).map((id) => { const m = card.item_groups[id] || {}; return { id, label: m.label, multi_select: m.multi_select, items: m.items }; });
        const groupIds = new Set(groupList.map((g) => String(g.id == null ? "" : g.id)).filter(Boolean));
        // Ungrouped items (and any whose group has no matching entry) render flat, as before.
        items.filter((it) => !it || it.group == null || !groupIds.has(String(it.group))).forEach((it) => renderItem(it, main, null));
        groupList.forEach((g) => renderApprovalGroup(g, items, main, promptId, renderItem));
        const textEls = {};
        textInputs.forEach((ti) => {
          if (!ti || typeof ti !== "object") return;
          const row = document.createElement("div"); row.className = "ask-row";
          const inp = document.createElement("input"); inp.className = "ask-input"; inp.type = "text";
          if (ti.placeholder) inp.placeholder = String(ti.placeholder);
          // Prefilled-but-editable value (e.g. Save Version's proposed commit message):
          // without this, a card can only offer ghost placeholder text, never a real default.
          if (ti.value != null) inp.value = String(ti.value);
          textEls[ti.id == null ? "" : String(ti.id)] = inp; row.appendChild(inp); main.appendChild(row);
        });
        // esp32_flash_confirm: a live serial-port + baud picker. The Skill card carries the
        // firmware path + esptool commands in summary/steps (rendered above); the port list
        // is scanned host-side (deploy_rescan -> deploy_ports_updated, routed to
        // currentDeployCard — only one card is ever active). Any other card gets no picker,
        // so the body render alone still fixes the "only three buttons" symptom.
        const isFlashConfirm = card.approval_id === FLASH_CONFIRM_ID;
        let selectedPort = null;
        // let selectedBaud = FLASH_BAUDS[0]; // baud picker gated on ruili (see FLASH_BAUDS note)
        let flashBtn = null;
        let flashPortsEl = null, flashStatusEl = null;
        const setFlashPorts = (ports) => {
          ports = Array.isArray(ports) ? ports : [];
          flashPortsEl.innerHTML = "";
          if (!ports.length) { flashStatusEl.textContent = tr("no_board"); selectedPort = null; if (flashBtn) flashBtn.disabled = true; return; }
          if (ports.length === 1) { selectedPort = ports[0]; flashStatusEl.textContent = tr("connected", { p: ports[0] }); }
          else {
            flashStatusEl.textContent = tr("multiple_devices"); selectedPort = null;
            ports.forEach((p) => {
              const b = document.createElement("button"); b.className = "ask-opt"; b.type = "button"; b.textContent = p;
              b.addEventListener("click", () => { selectedPort = p; flashPortsEl.querySelectorAll(".ask-opt").forEach((x) => x.classList.remove("chosen")); b.classList.add("chosen"); if (flashBtn) flashBtn.disabled = false; });
              flashPortsEl.appendChild(b);
            });
          }
          if (flashBtn) flashBtn.disabled = selectedPort == null;
        };
        if (isFlashConfirm) {
          const pick = document.createElement("div"); pick.className = "flash-pick";
          flashStatusEl = document.createElement("div"); flashStatusEl.className = "flash-status"; flashStatusEl.textContent = tr("detecting_board"); pick.appendChild(flashStatusEl);
          flashPortsEl = document.createElement("div"); flashPortsEl.className = "flash-ports"; pick.appendChild(flashPortsEl);
          // BAUD PICKER GATED ON RUILI (see FLASH_BAUDS note above): the flash ignores a chosen
          // baud today, so the dropdown is disabled rather than misleading the user. Restore this
          // block once the plugin consumes approval_response.baud.
          // const baudRow = document.createElement("label"); baudRow.className = "flash-baud"; baudRow.textContent = tr("flash_baud") + " ";
          // const sel = document.createElement("select");
          // FLASH_BAUDS.forEach((rate) => { const o = document.createElement("option"); o.value = rate; o.textContent = rate; sel.appendChild(o); });
          // sel.addEventListener("change", () => { selectedBaud = sel.value; });
          // baudRow.appendChild(sel); pick.appendChild(baudRow);
          const rescan = document.createElement("button"); rescan.className = "ask-opt flash-rescan"; rescan.type = "button"; rescan.textContent = tr("rescan");
          rescan.addEventListener("click", () => { flashStatusEl.textContent = tr("detecting_board"); vscode.postMessage({ type: "deploy_rescan" }); });
          pick.appendChild(rescan);
          main.appendChild(pick);
          if (!replaying) currentDeployCard = { setPorts: setFlashPorts }; // an inert historical card never owns port updates
        }
        const btnRow = document.createElement("div"); btnRow.className = "ask-options";
        let answered = false;
        const respond = (action) => {
          if (answered) return; answered = true;
          const selected_ids = checks.filter((c) => c.checked).map((c) => c.dataset.id).filter(Boolean);
          const text_values = {}; Object.keys(textEls).forEach((k) => { text_values[k] = textEls[k].value; });
          const msg = { type: "ui_prompt_response", promptId, answer: action, selected_ids, text_values };
          // Ride the chosen port so the host sets it before the agent's flash tool runs (same
          // no-race rationale as the deploy card's port passthrough). Baud is NOT sent: the picker
          // is gated on ruili (see FLASH_BAUDS note); restore `msg.baud = Number(selectedBaud)`
          // here when the plugin consumes it.
          if (isFlashConfirm && action === FLASH_ACTION && selectedPort) { msg.serial_port = selectedPort; }
          vscode.postMessage(msg);
          // Disable every button in the card (actions + the flash picker's rescan/port
          // buttons), not just the action row, so nothing stays clickable after answering.
          wrap.querySelectorAll("button").forEach((b) => { b.disabled = true; });
          checks.forEach((c) => { c.disabled = true; });
          currentDeployCard = null;
          setPending(tr("working"));
        };
        actions.forEach((a) => {
          // Action key is `value`, but some cards (e.g. wiring network-render) carry only `id`.
          // Falling back id->"confirm" here keeps Cancel answering "cancel" instead of "confirm"
          // (which would invert the choice — a Cancel click silently approving). See protocol-loop's
          // headless branch for the matching fallback.
          const answer = (a && a.value != null) ? String(a.value) : (a && a.id != null) ? String(a.id) : "confirm";
          const b = document.createElement("button"); b.className = "ask-opt" + (a && a.primary ? " primary" : "");
          b.textContent = (a && a.label != null) ? String(a.label) : answer;
          b.dataset.answer = answer; // so an inert restore can highlight the button that was chosen
          // Gate Start Flashing on a chosen port; setFlashPorts enables it once one is picked.
          if (isFlashConfirm && answer === FLASH_ACTION) { flashBtn = b; b.disabled = true; }
          b.addEventListener("click", () => respond(answer));
          btnRow.appendChild(b);
        });
        main.appendChild(btnRow); head.appendChild(main); wrap.appendChild(head); el.appendChild(wrap);
        $("activity").appendChild(el);
        // Kick off the initial port scan for the flash picker (mirrors addDeployPrompt). Skipped on replay:
        // a restored historical card must not trigger a live device scan.
        if (isFlashConfirm && !replaying) vscode.postMessage({ type: "deploy_rescan" });
      }

      // status_update -> a timeline trace line.
      function addStatusUpdate(payload) {
        payload = payload || {};
        const text = payload.message == null ? "" : String(payload.message);
        if (text) addActivity({ type: "trace", text });
      }

      // phase_complete -> the summary + any artifacts (rendered functionally).
      function addPhaseComplete(payload) {
        payload = payload || {};
        if (payload.summary) addSummary(String(payload.summary));
        const arts = Array.isArray(payload.artifacts) ? payload.artifacts : [];
        arts.forEach((art) => {
          if (!art || typeof art !== "object") return;
          if (art.type === "markdown" && art.content) addSummary(String(art.content));
          else if (art.type === "table" && Array.isArray(art.rows)) {
            const header = Array.isArray(art.headers) ? art.headers.join(" | ") : "";
            const rows = art.rows.map((r) => (Array.isArray(r) ? r.join(" | ") : "")).join("\n");
            addSummary((art.title ? String(art.title) + "\n" : "") + (header ? header + "\n" : "") + rows);
          } else if (art.title) addSummary(String(art.title));
        });
      }

      // Destructive-file confirm card (deliverables 07 §4): host-initiated (file_op_confirm_needed),
      // shows the file path with Overwrite/Delete vs Ignore. Posts a STABLE answer ("proceed"/
      // "ignore") decoupled from the localized labels, like the deploy/components gates. The
      // card is stamped data-prompt-id so session_done disables its buttons.
      function addFileOpPrompt(promptId, op, path) {
        finalizeThinking();
        clearPending();
        $("activityEmpty").classList.add("hidden");
        setTab("activity");
        const proceedKey = { overwrite: "fileop_overwrite", delete: "fileop_delete", device_delete: "fileop_device_delete" }[op] || "fileop_overwrite";
        const questionKey = { overwrite: "fileop_overwrite_q", delete: "fileop_delete_q", device_delete: "fileop_device_delete_q" }[op] || "fileop_overwrite_q";
        const proceedLabel = tr(proceedKey);
        const question = tr(questionKey, { p: path });
        const card = document.createElement("div");
        card.className = "ev fade-in";
        card.setAttribute("data-prompt-id", promptId);
        card.innerHTML = '<div class="ev-card ask"><div class="ev-head">' +
          '<div class="ev-ico skill">•</div>' +
          '<div class="ev-main"><div class="ev-label"><span class="kind">' + tr("kind_confirm") + '</span></div>' +
          '<div class="ev-sum fileop-q"></div>' +
          '<div class="ask-options">' +
            '<button class="ask-opt fileop-proceed" type="button" data-answer="proceed"></button>' +
            '<button class="ask-opt fileop-ignore" type="button" data-answer="ignore"></button>' +
          '</div></div></div></div>';
        // textContent for the question (carries the file path) and the labels — never innerHTML.
        card.querySelector(".fileop-q").textContent = question;
        const proceedBtn = card.querySelector(".fileop-proceed");
        const ignoreBtn = card.querySelector(".fileop-ignore");
        proceedBtn.textContent = proceedLabel;
        ignoreBtn.textContent = tr("fileop_ignore");
        let answered = false;
        const reply = (answer, btn) => {
          if (answered) return;
          answered = true;
          vscode.postMessage({ type: "ui_prompt_response", promptId, answer });
          card.querySelectorAll(".ask-opt").forEach((b) => { b.disabled = true; });
          btn.classList.add("chosen");
          setPending(tr("working"));
        };
        proceedBtn.addEventListener("click", () => reply("proceed", proceedBtn));
        ignoreBtn.addEventListener("click", () => reply("ignore", ignoreBtn));
        $("activity").appendChild(card);
      }

      function addAskPrompt(promptId, question, options, optionsRequiringText, textPlaceholder) {
        finalizeThinking();
        clearPending();
        $("activityEmpty").classList.add("hidden");
        setTab("activity");
        const opts = Array.isArray(options) ? options : [];
        const needsText = new Set((Array.isArray(optionsRequiringText) ? optionsRequiringText : []).map(String));
        // The free-text row is the only way to answer an open question, and it's where
        // a needs-text option's value goes — but for a pure either/or it only adds
        // height, so drop it (the model uses an option-less question for free text).
        const showInput = opts.length === 0 || needsText.size > 0;
        const card = document.createElement("div");
        card.className = "ev fade-in";
        card.innerHTML = '<div class="ev-card ask"><div class="ev-head">' +
          '<div class="ev-ico skill">•</div>' +
          '<div class="ev-main"><div class="ev-label"><span class="kind">' + tr("kind_question") + '</span></div>' +
          '<div class="ev-sum ask-q"></div>' +
          '<div class="ask-options"></div>' +
          (showInput ? '<div class="ask-row"><input class="ask-input" type="text" placeholder="' + tr("type_answer") + '"><button class="ask-send">' + tr("send") + '</button></div>' : '') +
          "</div></div></div>";
        const askTyper = makeTypewriter(card.querySelector(".ask-q"));
        askTyper.feed(question == null ? "" : String(question)); askTyper.end();
        const input = card.querySelector(".ask-input");
        const send = card.querySelector(".ask-send");
        // Model-authored placeholder set as a property (never via innerHTML) so it
        // can't break out of the attribute.
        if (input && typeof textPlaceholder === "string" && textPlaceholder.trim()) input.placeholder = textPlaceholder;
        let answered = false;
        // A needs-text option, once clicked, is held here until its value is typed.
        let pendingOption = null;
        const lock = (shownAnswer) => {
          answered = true;
          if (input) input.disabled = true;
          if (send) { send.disabled = true; send.textContent = tr("sent"); }
          card.querySelectorAll(".ask-opt").forEach((b) => { b.disabled = true; if (b.textContent === shownAnswer || b.textContent === pendingOption) b.classList.add("chosen"); });
          const a = document.createElement("div"); a.className = "ask-answer"; a.textContent = "• " + shownAnswer;
          card.querySelector(".ev-main").appendChild(a);
          setPending(tr("working"));
        };
        const sendAnswer = (answer, selectedOption) => {
          if (!answer || answered) return;
          vscode.postMessage({ type: "ui_prompt_response", promptId, answer, selectedOption });
          lock(answer);
        };
        // The text box submits either a free-form answer or the value for a held option.
        const submitText = () => {
          if (answered || !input) return;
          const text = String(input.value == null ? "" : input.value).trim();
          if (!text) { input.focus(); return; }
          if (pendingOption) sendAnswer(pendingOption + "\n" + text, pendingOption);
          else sendAnswer(text, null);
        };
        const pickOption = (opt) => {
          if (answered) return;
          const label = String(opt);
          if (needsText.has(label)) {
            // Hold the choice and wait for the required text — don't end the turn.
            pendingOption = label;
            card.querySelectorAll(".ask-opt").forEach((b) => b.classList.toggle("chosen", b.textContent === label));
            if (input) input.focus();
            return;
          }
          sendAnswer(label, label);
        };
        const optHost = card.querySelector(".ask-options");
        for (const opt of opts) {
          const b = document.createElement("button");
          b.className = "ask-opt"; b.type = "button"; b.textContent = String(opt);
          b.dataset.answer = String(opt); // so an inert restore can highlight the chosen option
          b.addEventListener("click", () => pickOption(opt));
          optHost.appendChild(b);
        }
        if (send) send.addEventListener("click", submitText);
        if (input) input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); submitText(); } });
        $("activity").appendChild(card);
        if (input) setTimeout(() => input.focus(), 0);
      }

      // ----- component confirmation (deterministic multi-select, host-owned) -----
      // Renders the proposed devices[] as toggleable chips (all pre-selected). The
      // user unchecks to remove and/or types missing parts; Confirm posts the kept
      // device names + the free-text additions back to the host.
      function addComponentPrompt(promptId, devices) {
        finalizeThinking();
        clearPending();
        $("activityEmpty").classList.add("hidden");
        setTab("activity");
        devices = Array.isArray(devices) ? devices : [];
        const card = document.createElement("div");
        card.className = "ev fade-in";
        card.innerHTML = '<div class="ev-card ask"><div class="ev-head">' +
          '<div class="ev-ico skill">•</div>' +
          '<div class="ev-main"><div class="ev-label"><span class="kind">' + tr("kind_components") + '</span></div>' +
          '<div class="ev-sum">' + tr("comp_intro") + '</div>' +
          '<div class="ask-options comp-options"></div>' +
          '<div class="ask-row"><input class="ask-input comp-add" type="text" placeholder="' + tr("comp_add_ph") + '"></div>' +
          '<div class="ask-options"><button class="ask-opt comp-go" type="button" data-answer="confirm">' + tr("comp_confirm") + '</button><button class="ask-opt comp-cancel" type="button" data-answer="cancel">' + tr("cancel") + '</button></div>' +
          "</div></div></div>";
        const optHost = card.querySelector(".comp-options");
        const selected = new Set();
        for (const dev of devices) {
          const nm = String(dev && dev.name != null ? dev.name : dev);
          const iface = dev && dev.interface ? " · " + String(dev.interface) : "";
          selected.add(nm);
          const b = document.createElement("button");
          b.className = "ask-opt chosen"; b.type = "button"; b.textContent = "✓ " + nm + iface;
          b.addEventListener("click", () => {
            if (selected.has(nm)) { selected.delete(nm); b.classList.remove("chosen"); b.textContent = nm + iface; }
            else { selected.add(nm); b.classList.add("chosen"); b.textContent = "✓ " + nm + iface; }
          });
          optHost.appendChild(b);
        }
        const addInput = card.querySelector(".comp-add");
        let answered = false;
        const reply = (answer) => {
          if (answered) return;
          answered = true;
          vscode.postMessage({ type: "ui_prompt_response", promptId, answer, devices: Array.from(selected), feedback: addInput.value.trim() });
          card.querySelectorAll(".ask-opt").forEach((x) => { x.disabled = true; });
          addInput.disabled = true;
          if (answer === "confirm") setPending(tr("working"));
        };
        card.querySelector(".comp-go").addEventListener("click", () => reply("confirm"));
        card.querySelector(".comp-cancel").addEventListener("click", () => reply("cancel"));
        addInput.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); reply("confirm"); } });
        $("activity").appendChild(card);
        setTimeout(() => addInput.focus(), 0);
      }

      // ----- build plan (confirmation gate before codegen spends credits) -----
      function addPlanPrompt(promptId, plan) {
        plan = plan || {};
        finalizeThinking();
        clearPending();
        $("activityEmpty").classList.add("hidden");
        setTab("activity");
        const card = document.createElement("div");
        card.className = "ev fade-in";
        card.innerHTML = '<div class="ev-card ask"><div class="ev-head">' +
          '<div class="ev-ico skill">•</div>' +
          '<div class="ev-main"><div class="ev-label"><span class="kind">' + tr("kind_plan") + '</span></div>' +
          '<div class="ev-sum">' + tr("plan_intro") + '</div>' +
          '<div class="ev-sum plan-summary"></div>' +
          '<ul class="plan-list"></ul>' +
          '<div class="plan-cost"></div>' +
          '<div class="ask-row"><input class="ask-input plan-revise" type="text" placeholder="' + tr("plan_revise_ph") + '"><button class="ask-send plan-edit" type="button" data-answer="revise">' + tr("revise") + '</button></div>' +
          '<div class="ask-options"><button class="ask-opt plan-go" type="button" data-answer="confirm">' + tr("confirm_generate") + '</button><button class="ask-opt plan-cancel" type="button" data-answer="cancel">' + tr("cancel") + '</button></div>' +
          "</div></div></div>";
        // Model-written narrative (optional), rendered above the structured rows.
        const summaryEl = card.querySelector(".plan-summary");
        if (typeof plan.summary === "string" && plan.summary.trim()) {
          const planTyper = makeTypewriter(summaryEl); planTyper.feed(plan.summary.trim()); planTyper.end();
        } else summaryEl.remove();
        const rows = [];
        if (plan.boardId) rows.push([tr("plan_board"), plan.boardId]);
        if (Array.isArray(plan.capabilities) && plan.capabilities.length) rows.push([tr("plan_features"), plan.capabilities.map(capName).join(sep())]);
        if (Array.isArray(plan.packages) && plan.packages.length) rows.push([tr("plan_packages"), plan.packages.join(sep())]);
        if (Array.isArray(plan.wiring) && plan.wiring.length) rows.push([tr("plan_wiring"), plan.wiring.map((w) => `${roleSignal(w.role)}→${w.pin}`).join(sep())]);
        const list = card.querySelector(".plan-list");
        for (const [label, value] of rows) {
          const li = document.createElement("li");
          const b = document.createElement("span"); b.className = "plan-k"; b.textContent = label + ": ";
          li.appendChild(b); li.appendChild(document.createTextNode(value));
          list.appendChild(li);
        }
        // Honest cost framing: this is the estimate for THIS build step only, shown
        // alongside what the session has already consumed and what's left — so "~N
        // credits" isn't misread as the whole session's cost.
        const remaining = parseInt($("qUsed").textContent, 10);
        const est = Number(plan.estimate) || 0;
        const used = (lastDailyGrant > 0 && Number.isFinite(remaining)) ? lastDailyGrant - remaining : null;
        let costText = tr("cost_step", { n: est });
        if (used != null) costText += tr("cost_used", { n: used });
        if (Number.isFinite(remaining)) costText += tr("cost_left", { n: remaining });
        card.querySelector(".plan-cost").textContent = costText;
        let answered = false;
        const reviseInput = card.querySelector(".plan-revise");
        const reply = (answer, feedback) => {
          if (answered) return;
          answered = true;
          vscode.postMessage({ type: "ui_prompt_response", promptId, answer, feedback });
          card.querySelectorAll(".ask-opt, .ask-send").forEach((b) => { b.disabled = true; });
          reviseInput.disabled = true;
          if (answer === "cancel") return; // session_done renders the terminal
          // Revise re-runs the agent to re-plan; confirm proceeds to codegen.
          setPending(answer === "revise" ? tr("replanning") : tr("generating_code"));
        };
        // Revise: send the user's free-text change request back so the agent re-plans
        // and the host re-shows an updated plan. Empty input is a no-op.
        const submitRevise = () => {
          const fb = reviseInput.value.trim();
          if (!fb) { reviseInput.focus(); return; }
          reply("revise", fb);
        };
        card.querySelector(".plan-go").addEventListener("click", () => reply("confirm"));
        card.querySelector(".plan-cancel").addEventListener("click", () => reply("cancel"));
        card.querySelector(".plan-edit").addEventListener("click", submitRevise);
        reviseInput.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); submitRevise(); } });
        $("activity").appendChild(card);
      }

      // ----- deploy checkpoint (board connection + wiring, before install/flash) -----
      let currentDeployCard = null;
      function addDeployPrompt(promptId, manifest) {
        finalizeThinking();
        clearPending();
        $("activityEmpty").classList.add("hidden");
        setTab("activity");
        const card = document.createElement("div");
        card.className = "ev fade-in";
        card.innerHTML = '<div class="ev-card ask"><div class="ev-head">' +
          '<div class="ev-ico skill">•</div>' +
          '<div class="ev-main"><div class="ev-label"><span class="kind">' + tr("kind_deploy") + '</span></div>' +
          '<div class="ev-sum">' + tr("deploy_intro") + '</div>' +
          '<div class="deploy-wiring"></div>' +
          '<div class="deploy-status">' + tr("detecting_board") + '</div>' +
          '<div class="deploy-ports"></div>' +
          '<div class="deploy-actions"><button class="ask-opt deploy-go" type="button" data-answer="confirm" disabled>' + tr("deploy") + '</button>' +
          '<div class="deploy-secondary"><button class="ask-opt deploy-rescan" type="button">' + tr("rescan") + '</button><button class="ask-opt deploy-cancel" type="button" data-answer="cancel">' + tr("cancel") + '</button></div></div>' +
          "</div></div></div>";
        const wiring = wiringMarkup(manifest);
        if (wiring) card.querySelector(".deploy-wiring").innerHTML = wiring;
        const statusEl = card.querySelector(".deploy-status");
        const portsEl = card.querySelector(".deploy-ports");
        const goBtn = card.querySelector(".deploy-go");
        let answered = false;
        let selectedPort = null;
        const reply = (answer) => {
          if (answered) return;
          answered = true;
          // Carry the chosen port on the prompt response itself so the host sets it
          // before unblocking the agent — a separate select_device message races the
          // resolve and the first device tool can fire before the port lands.
          vscode.postMessage({ type: "ui_prompt_response", promptId, answer, port: answer === "confirm" ? selectedPort : null });
          card.querySelectorAll(".ask-opt").forEach((b) => { b.disabled = true; });
          currentDeployCard = null;
          if (answer === "confirm") setPending(tr("deploying")); // cancel: session_done renders the terminal
        };
        goBtn.addEventListener("click", () => reply("confirm"));
        card.querySelector(".deploy-cancel").addEventListener("click", () => reply("cancel"));
        card.querySelector(".deploy-rescan").addEventListener("click", () => { statusEl.textContent = tr("detecting_board"); vscode.postMessage({ type: "deploy_rescan" }); });
        // Updated by deploy_ports_updated: no board -> Deploy stays disabled; one
        // board -> auto-selected; several -> the user picks one before deploying.
        const deployController = {
          setPorts: (ports) => {
            ports = Array.isArray(ports) ? ports : [];
            portsEl.innerHTML = "";
            if (!ports.length) {
              statusEl.textContent = tr("no_board");
              selectedPort = null; goBtn.disabled = true; return;
            }
            if (ports.length === 1) {
              selectedPort = ports[0];
              statusEl.textContent = tr("connected", { p: ports[0] });
            } else {
              statusEl.textContent = tr("multiple_devices");
              selectedPort = null;
              ports.forEach((p) => {
                const b = document.createElement("button");
                b.className = "ask-opt"; b.type = "button"; b.textContent = p;
                b.addEventListener("click", () => {
                  selectedPort = p;
                  portsEl.querySelectorAll(".ask-opt").forEach((x) => x.classList.remove("chosen"));
                  b.classList.add("chosen"); goBtn.disabled = false;
                });
                portsEl.appendChild(b);
              });
            }
            goBtn.disabled = selectedPort == null;
          },
        };
        if (!replaying) currentDeployCard = deployController; // an inert historical card never owns port updates
        $("activity").appendChild(card);
        if (!replaying) vscode.postMessage({ type: "deploy_rescan" }); // no live device scan for a restored card
      }

      // ----- Stage 2: replay a past prompt as its REAL card, rendered INERT -----
      // Reuse the exact live renderer (so the historical card looks identical), then disable every control and
      // show the answer it received. `replaying` suppresses the renderers' device-scan side effects above.
      const INERT_RENDERERS = {
        ui_prompt: (p) => addAskPrompt(p.promptId, p.question, p.options, p.optionsRequiringText, p.textPlaceholder),
        plan_proposed: (p) => addPlanPrompt(p.promptId, p.plan),
        deploy_proposed: (p) => addDeployPrompt(p.promptId, p.manifest),
        components_proposed: (p) => addComponentPrompt(p.promptId, p.devices),
        approval_requested: (p) => addApprovalPrompt(p.promptId, p.card),
        file_op_proposed: (p) => addFileOpPrompt(p.promptId, p.op, p.path),
      };
      // Neutralize the card the renderer just appended: disable every input/button, then SHOW what was chosen
      // by highlighting the button that was clicked (accent .chosen, kept bright while the rest dim). A button
      // carries its answer value in data-answer; an option button also matches by its own label. Only when no
      // button matches (a free-text answer) do we fall back to a "• answer" line.
      function finalizeInertCard(answer) {
        const card = $("activity").lastElementChild;
        if (!card) return;
        card.classList.add("restore-inert");
        card.querySelectorAll("input, button, select, textarea").forEach((el) => { el.disabled = true; });
        const ans = answer == null ? "" : String(answer);
        if (!ans) return;
        let chosen = null;
        card.querySelectorAll("button").forEach((b) => {
          if (chosen) return;
          if (b.dataset.answer === ans || (b.textContent || "").trim() === ans) chosen = b;
        });
        if (chosen) { chosen.classList.add("chosen"); return; }
        const a = document.createElement("div"); a.className = "ask-answer restore-answer";
        a.textContent = "• " + ans; // free-text (or otherwise unmatched) answer: show it as a line
        (card.querySelector(".ev-main") || card).appendChild(a);
      }
      function renderInertPrompt(kind, payload, answer) {
        const render = Object.prototype.hasOwnProperty.call(INERT_RENDERERS, kind) ? INERT_RENDERERS[kind] : null;
        if (!render) { addActivity({ text: String(answer || "") }, "note"); return; } // unknown type: fall back to a note line
        replaying = true;
        try { render(payload || {}); finalizeInertCard(answer); }
        finally { replaying = false; }
      }
