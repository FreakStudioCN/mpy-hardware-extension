
      // ----- ask_user (interactive prompt; pauses the agent until answered) -----
      // options: clickable choices. optionsRequiringText: the subset of those that
      // mean "I'll provide a value" — clicking one holds the choice and waits for the
      // user to type that value (a URL/number/path) instead of ending the turn empty.
      // Protocol approval_request: the single rich card (replaces ask/components/
      // plan/deploy). Items render as checkboxes (default selected), actions as
      // buttons; the chosen action + selected ids + text values ride back as a
      // ui_prompt_response, which the controller resolves into approval_response.
      function addApprovalPrompt(promptId, card) {
        finalizeThinking();
        clearPending();
        $("activityEmpty").classList.add("hidden");
        setTab("activity");
        card = card || {};
        const items = Array.isArray(card.items) ? card.items : [];
        // item_groups is contract-valid as either an array OR an object map; an object
        // form was being dropped here, hiding its items from the user. Normalize both.
        const groups = Array.isArray(card.item_groups) ? card.item_groups : Object.values(card.item_groups || {});
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
        const checks = [];
        const renderItem = (it) => {
          if (!it || typeof it !== "object") return;
          const row = document.createElement("label"); row.className = "ask-opt"; row.style.display = "block";
          const cb = document.createElement("input"); cb.type = "checkbox";
          cb.checked = it.selected !== false; cb.dataset.id = it.id == null ? "" : String(it.id);
          cb.disabled = it.selectable === false; checks.push(cb); row.appendChild(cb);
          const span = document.createElement("span");
          span.textContent = " " + (it.name == null ? "" : String(it.name)) + (it.subtitle ? " — " + String(it.subtitle) : "");
          row.appendChild(span); main.appendChild(row);
        };
        items.forEach(renderItem);
        groups.forEach((g) => (Array.isArray(g && g.items) ? g.items : []).forEach(renderItem));
        const textEls = {};
        textInputs.forEach((ti) => {
          if (!ti || typeof ti !== "object") return;
          const row = document.createElement("div"); row.className = "ask-row";
          const inp = document.createElement("input"); inp.className = "ask-input"; inp.type = "text";
          if (ti.placeholder) inp.placeholder = String(ti.placeholder);
          textEls[ti.id == null ? "" : String(ti.id)] = inp; row.appendChild(inp); main.appendChild(row);
        });
        const btnRow = document.createElement("div"); btnRow.className = "ask-options";
        let answered = false;
        const respond = (action) => {
          if (answered) return; answered = true;
          const selected_ids = checks.filter((c) => c.checked).map((c) => c.dataset.id).filter(Boolean);
          const text_values = {}; Object.keys(textEls).forEach((k) => { text_values[k] = textEls[k].value; });
          vscode.postMessage({ type: "ui_prompt_response", promptId, answer: action, selected_ids, text_values });
          btnRow.querySelectorAll("button").forEach((b) => { b.disabled = true; });
          checks.forEach((c) => { c.disabled = true; });
          setPending(tr("working"));
        };
        actions.forEach((a) => {
          const b = document.createElement("button"); b.className = "ask-opt" + (a && a.primary ? " primary" : "");
          b.textContent = (a && a.label != null) ? String(a.label) : String(a && a.value);
          b.addEventListener("click", () => respond((a && a.value != null) ? String(a.value) : "confirm"));
          btnRow.appendChild(b);
        });
        main.appendChild(btnRow); head.appendChild(main); wrap.appendChild(head); el.appendChild(wrap);
        $("activity").appendChild(el);
        $("activity").parentElement.scrollTop = $("activity").parentElement.scrollHeight;
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
        const proceedLabel = op === "delete" ? tr("fileop_delete") : tr("fileop_overwrite");
        const question = tr(op === "delete" ? "fileop_delete_q" : "fileop_overwrite_q", { p: path });
        const card = document.createElement("div");
        card.className = "ev fade-in";
        card.setAttribute("data-prompt-id", promptId);
        card.innerHTML = '<div class="ev-card ask"><div class="ev-head">' +
          '<div class="ev-ico skill">•</div>' +
          '<div class="ev-main"><div class="ev-label"><span class="kind">' + tr("kind_confirm") + '</span></div>' +
          '<div class="ev-sum fileop-q"></div>' +
          '<div class="ask-options">' +
            '<button class="ask-opt fileop-proceed" type="button"></button>' +
            '<button class="ask-opt fileop-ignore" type="button"></button>' +
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
        $("activity").parentElement.scrollTop = $("activity").parentElement.scrollHeight;
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
        const askScroll = () => { $("activity").parentElement.scrollTop = $("activity").parentElement.scrollHeight; };
        const askTyper = makeTypewriter(card.querySelector(".ask-q"), askScroll);
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
          b.addEventListener("click", () => pickOption(opt));
          optHost.appendChild(b);
        }
        if (send) send.addEventListener("click", submitText);
        if (input) input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); submitText(); } });
        $("activity").appendChild(card);
        $("activity").parentElement.scrollTop = $("activity").parentElement.scrollHeight;
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
          '<div class="ask-options"><button class="ask-opt comp-go" type="button">' + tr("comp_confirm") + '</button><button class="ask-opt comp-cancel" type="button">' + tr("cancel") + '</button></div>' +
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
        $("activity").parentElement.scrollTop = $("activity").parentElement.scrollHeight;
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
          '<div class="ask-row"><input class="ask-input plan-revise" type="text" placeholder="' + tr("plan_revise_ph") + '"><button class="ask-send plan-edit" type="button">' + tr("revise") + '</button></div>' +
          '<div class="ask-options"><button class="ask-opt plan-go" type="button">' + tr("confirm_generate") + '</button><button class="ask-opt plan-cancel" type="button">' + tr("cancel") + '</button></div>' +
          "</div></div></div>";
        // Model-written narrative (optional), rendered above the structured rows.
        const summaryEl = card.querySelector(".plan-summary");
        if (typeof plan.summary === "string" && plan.summary.trim()) {
          const planScroll = () => { $("activity").parentElement.scrollTop = $("activity").parentElement.scrollHeight; };
          const planTyper = makeTypewriter(summaryEl, planScroll); planTyper.feed(plan.summary.trim()); planTyper.end();
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
        $("activity").parentElement.scrollTop = $("activity").parentElement.scrollHeight;
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
          '<div class="deploy-actions"><button class="ask-opt deploy-go" type="button" disabled>' + tr("deploy") + '</button>' +
          '<div class="deploy-secondary"><button class="ask-opt deploy-rescan" type="button">' + tr("rescan") + '</button><button class="ask-opt deploy-cancel" type="button">' + tr("cancel") + '</button></div></div>' +
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
        currentDeployCard = {
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
        $("activity").appendChild(card);
        $("activity").parentElement.scrollTop = $("activity").parentElement.scrollHeight;
        vscode.postMessage({ type: "deploy_rescan" });
      }
