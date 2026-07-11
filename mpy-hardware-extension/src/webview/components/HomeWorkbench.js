      // ----- device list (from API, never hardcoded) -----
      // Board selection happens in the conversation (the agent recommends and
      // confirms via ask_user), not a header dropdown. Start is gated only by
      // quota; the board is decided in chat.
      function updateGenerateEnabled() {
        // Two independent blocks: quotaExhausted follows the live balance (credits
        // events recompute it), while capBlockedUntil is the sticky daily-cap hold —
        // a capped user's balance is typically > 0, so a credits refresh must not
        // lift it. It expires on its own once the deadline (next UTC midnight)
        // passes; credits events are the natural re-check points.
        $("generate").disabled = (!running && (quotaExhausted || Date.now() < capBlockedUntil));
      }
      // ----- tab state -----
      let activeTab = "activity";
      function setTab(name) {
        activeTab = name;
        document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
        document.querySelectorAll(".view").forEach((v) => v.classList.toggle("hidden", v.dataset.view !== name));
        const tabBtn = document.querySelector('.tab[data-tab="' + name + '"]');
        const dot = tabBtn && tabBtn.querySelector(".newdot");
        if (dot) dot.remove();
      }
      function markNew(name) {
        if (activeTab === name) return;
        const tabBtn = document.querySelector('.tab[data-tab="' + name + '"]');
        if (tabBtn && !tabBtn.querySelector(".newdot") && !tabBtn.querySelector(".pulse")) {
          const d = document.createElement("span"); d.className = "newdot"; tabBtn.appendChild(d);
        }
      }
      document.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => setTab(t.dataset.tab)));
      // A global tool opens as a full-body surface over the workflow (stages + composer
      // hide), not inside the stage content area. Each global tool has its own surface;
      // opening one shows it and hides the others + the workflow.
      // The global-tools bar stays visible when a tool opens (switch tools without
      // going Back); only the workflow surfaces below it hide.
      const GLOBAL_TOOL_HIDES = ["#tabs", ".tabwrap", ".composer"];
      const GLOBAL_TOOL_SURFACES = ["toolGenDriver", "toolSupport", "toolRecent", "toolDeviceTools"];
      // Mark the bar circle whose data-tool matches the open surface as selected (a
      // tool opened from the home area, e.g. toolRecent, matches no circle — none active).
      function setActiveGtool(id) {
        document.querySelectorAll(".gtool-btn").forEach((b) => {
          const on = b.dataset.tool === id;
          b.classList.toggle("active", on);
          if (on) b.setAttribute("aria-current", "true"); else b.removeAttribute("aria-current");
        });
      }
      function openGlobalTool(id) {
        for (const sel of GLOBAL_TOOL_HIDES) document.querySelector(sel).classList.add("hidden");
        for (const t of GLOBAL_TOOL_SURFACES) $(t).classList.toggle("hidden", t !== id);
        setActiveGtool(id);
      }
      function closeGlobalTool() {
        for (const t of GLOBAL_TOOL_SURFACES) $(t).classList.add("hidden");
        for (const sel of GLOBAL_TOOL_HIDES) document.querySelector(sel).classList.remove("hidden");
        setActiveGtool(null);
      }
      $("genDriverOpen").addEventListener("click", () => openGlobalTool("toolGenDriver"));
      $("genDriverBack").addEventListener("click", closeGlobalTool);
      $("supportOpen").addEventListener("click", () => openGlobalTool("toolSupport"));
      $("supportBack").addEventListener("click", closeGlobalTool);
      // Device Tools global tool (#54): open the surface and check for a device — it lists
      // the root if one is connected, else shows the "plug in a device" state.
      $("deviceToolsOpen").addEventListener("click", () => { openGlobalTool("toolDeviceTools"); dtCheckDevice(); });
      $("deviceToolsBack").addEventListener("click", closeGlobalTool);
      // Global-tools overflow: any number of circle tools fit — the row scrolls and the
      // chevrons show only when it clips (recomputed on scroll/resize).
      const gtoolsTrack = $("globalTools");
      const gtoolLeft = $("gtoolsLeft"), gtoolRight = $("gtoolsRight");
      const GTOOL_SCROLL_FRACTION = 0.7; // fraction of the visible width one arrow click moves
      function updateGtoolArrows() {
        const clip = gtoolsTrack.scrollWidth - gtoolsTrack.clientWidth;
        const overflow = clip > 1;
        gtoolLeft.classList.toggle("hidden", !overflow || gtoolsTrack.scrollLeft <= 0);
        gtoolRight.classList.toggle("hidden", !overflow || gtoolsTrack.scrollLeft >= clip - 1);
      }
      const reduceMotion = !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
      const scrollGtools = (dir) => gtoolsTrack.scrollBy({ left: dir * gtoolsTrack.clientWidth * GTOOL_SCROLL_FRACTION, behavior: reduceMotion ? "auto" : "smooth" });
      gtoolLeft.addEventListener("click", () => scrollGtools(-1));
      gtoolRight.addEventListener("click", () => scrollGtools(1));
      gtoolsTrack.addEventListener("scroll", updateGtoolArrows);
      // A pill expanding (hover or the selected tool) widens the row without a scroll/
      // resize event, so re-check when its expand/collapse transition settles.
      gtoolsTrack.addEventListener("transitionend", updateGtoolArrows);
      window.addEventListener("resize", updateGtoolArrows);
      updateGtoolArrows();
      // Home hero action: begin a build. The composer is always mounted, so "start"
      // just reveals the board picker and focuses the prompt (no session yet).
      // ponytail: Git history / Save Version (spec 3.8) are still stubbed global tools
      // pending their own cards.
      $("startWorkflow").addEventListener("click", () => { setBoardPickerVisible(true); setBoardBodyExpanded(true); $("intent").focus(); });
      // Import Existing Project: host opens a folder picker then reloads on that
      // folder (no webview surface). Recent Sessions: read-only list of past session
      // summaries in a global-tool surface; the host serves them from .mpyhw/sessions.
      $("importProject").addEventListener("click", () => vscode.postMessage({ type: "import_project" }));
      $("recentSessions").addEventListener("click", () => { openGlobalTool("toolRecent"); vscode.postMessage({ type: "request_recent_sessions" }); });
      $("recentBack").addEventListener("click", closeGlobalTool);
      $("boardMore").addEventListener("click", () => setBoardBodyExpanded($("boardPickerBody").hidden));

      // ----- composer / working indicator -----
      // The single "AI is working" affordance is the in-feed spinner card
      // (setPending). It appears the moment a turn starts and re-arms on each tool
      // step (see trace_event), labelled with the current curated phase — never the
      // model's raw reasoning. There is no separate status bar.
      function setRunning(on) {
        running = on;
        if (on) terminalShown = false; // a fresh run (or retry) may end again
        const btn = $("generate");
        btn.textContent = on ? tr("stop") : tr("generate");
        btn.classList.toggle("stop", on);
        // The "add note" affordance is only meaningful while a build is running: it queues
        // a supplement for the next safe point (deliverables 07). Hidden otherwise. The
        // composer placeholder flips to a note hint too, so it doesn't read as "start a
        // build" while running.
        $("addNote").classList.toggle("hidden", !on);
        $("intent").placeholder = tr(on ? "note_ph" : "intent_ph");
        if (on) setPending(tr("working")); // immediate spinner; trace_event refines the label
        updateGenerateEnabled();
      }
      $("generate").addEventListener("click", () => {
        if (running) { vscode.postMessage({ type: "cancel_session" }); setPending(tr("stopping")); return; }
        const intent = $("intent").value.trim();
        if (!intent) return;
        document.querySelectorAll(".newdot").forEach((d) => d.remove());
        document.querySelectorAll(".tab .pulse").forEach((p) => p.remove());
        // Lock the session's UI language to the FIRST request's language before
        // anything renders, so chrome + the model's prose stay in one language. A
        // later same-session request in another language keeps the locked language
        // (the backend pins prose to the first message too); Restart re-detects.
        if (!localeLocked) { setLocale(detectLocale(intent)); localeLocked = true; }
        finalizeThinking();
        addUserMessage(intent);
        $("intent").value = "";
        $("intent").style.height = "auto";
        setTab("activity"); setBoardPickerVisible(false); setRunning(true);
        const preSelectedBoard = selectedOfficialBoard;
        const boardId = preSelectedBoard && preSelectedBoard.local_board_id ? preSelectedBoard.local_board_id : "auto";
        const msg = { type: "start_session", intent, boardId, pre_selected_board: preSelectedBoard || null, preferences: { mode: selectedMode } };
        if (!preSelectedBoard) msg.board_selection_mode = "recommend"; // board-selector doc §6 recommend path
        vscode.postMessage(msg);
      });
      // Add-note (mid-build supplement): queue the composer text as a supplement without
      // interrupting the run. The host applies it at the next safe point and echoes a
      // user_supplement_received into the feed. Cleared optimistically here.
      $("addNote").addEventListener("click", () => {
        if (!running) return;
        const text = $("intent").value.trim();
        if (!text) return;
        vscode.postMessage({ type: "user_supplement", text });
        $("intent").value = "";
        $("intent").style.height = "auto";
      });
      // Wipe every per-conversation surface back to its empty state. The host clears
      // its durable state in parallel (reset_session), so the next request is a
      // brand-new build, not a continuation. The locked UI language is left as-is —
      // the next intent re-locks it (setLocale is a no-op when unchanged).
      function clearConversation() {
        $("activity").innerHTML = "";
        $("activityEmpty").classList.remove("hidden");
        $("serial").innerHTML = "";
        $("serialFilled").classList.add("hidden");
        $("serialEmpty").classList.remove("hidden");
        $("serialHead").classList.remove("live");
        $("wiring").innerHTML = "";
        $("wiringEmpty").classList.remove("hidden");
        $("diagram").innerHTML = "";
        $("diagramEmpty").classList.remove("hidden");
        ARTIFACTS = []; artifactPhase = ""; artifactsLinkShown = false; drawArtifacts();
        finalizeThinking(); currentCode = null; currentSummary = null;
        currentDeployCard = null; pendingCard = null; pendingLabel = "";
        localeLocked = false; // next project re-detects its language (LOCALE left as-is until then)
        document.querySelectorAll(".newdot").forEach((d) => d.remove());
        document.querySelectorAll(".tab .pulse").forEach((p) => p.remove());
        setBoardPickerVisible(true);
        setTab("activity");
      }
      $("newSession").addEventListener("click", () => {
        vscode.postMessage({ type: "reset_session" });
        setRunning(false);
        clearConversation();
        $("intent").value = ""; $("intent").style.height = "auto";
      });
      const ta = $("intent");
      ta.addEventListener("focus", () => $("composerBox").classList.add("focused"));
      ta.addEventListener("blur", () => $("composerBox").classList.remove("focused"));
      ta.addEventListener("input", () => { ta.style.height = "auto"; ta.style.height = Math.min(ta.scrollHeight, 120) + "px"; });

      // ----- credits -----
      let lastDailyGrant = 0;
      function setCredits(balance, dailyGrant) {
        if (dailyGrant > 0) lastDailyGrant = dailyGrant;
        $("qUsed").textContent = balance;
        const max = dailyGrant > 0 ? dailyGrant : balance;
        const pct = max > 0 ? Math.min(100, Math.round((balance / max) * 100)) : 0;
        $("qFill").style.width = pct + "%";
        const q = $("quota"); q.classList.remove("hidden", "low", "exhausted");
        if (balance <= 0) q.classList.add("exhausted");
        else if (balance <= Math.max(1, Math.round(max * 0.2))) q.classList.add("low");
        quotaExhausted = balance <= 0;
        updateGenerateEnabled();
      }

      // Show the STUB badge only when the backend reports stub mode; live/unknown
      // hides it. Surfacing this is what keeps a stub backend from reading as a hang.
      function setServerMode(mode) {
        $("modeBadge").classList.toggle("hidden", mode !== "stub");
      }

      // Home partner-logo area (section-06 doc): host-served logos as data URIs, click
      // opens the partner site externally. Text fallback if a logo fails to load.
      function renderPartners(partners) {
        const root = $("partners"); if (!root) return;
        root.innerHTML = "";
        if (!partners || !partners.length) return;
        const h = document.createElement("div"); h.className = "partners-h"; h.textContent = "Partners";
        const row = document.createElement("div"); row.className = "partners-row";
        for (const p of partners) {
          const a = document.createElement("button"); a.className = "partner"; a.type = "button"; a.title = "Open " + p.name + " website";
          const img = document.createElement("img"); img.className = "partner-logo"; img.src = p.logo; img.alt = p.name;
          img.addEventListener("error", () => { a.textContent = p.name; });
          a.appendChild(img);
          a.addEventListener("click", () => vscode.postMessage({ type: "open_external", url: p.url }));
          row.appendChild(a);
        }
        root.appendChild(h); root.appendChild(row);
      }
      // Read-only list of past session summaries (host-served from .mpyhw/sessions).
      // Clicking a card reveals its session.jsonl via the host's open_path handler.
      function renderRecent(sessions) {
        const box = $("recent"); if (!box) return;
        box.innerHTML = "";
        const empty = $("recentEmpty");
        if (!sessions || !sessions.length) { empty.classList.remove("hidden"); return; }
        empty.classList.add("hidden");
        for (const s of sessions) {
          const card = document.createElement("button"); card.className = "recent-card"; card.type = "button";
          const title = document.createElement("span"); title.className = "recent-intent"; title.textContent = s.intent || s.id;
          const meta = document.createElement("span"); meta.className = "recent-meta";
          const when = s.date ? new Date(s.date).toLocaleString() : "";
          meta.textContent = s.finalPhase ? (when + " · " + s.finalPhase) : when;
          card.appendChild(title); card.appendChild(meta);
          card.addEventListener("click", () => vscode.postMessage({ type: "open_path", path: s.path }));
          box.appendChild(card);
        }
      }
