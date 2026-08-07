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
        // The tabs share one .tabwrap scroller; showing a shorter sibling view clamps its scrollTop,
        // so returning to Activity would land at the top. Re-follow to the latest on return.
        if (name === "activity") {
          const tw = document.querySelector(".tabwrap");
          if (tw) tw.scrollTop = tw.scrollHeight;
        }
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
      const GLOBAL_TOOL_SURFACES = ["toolGenDriver", "toolSupport", "toolRecent", "toolDeviceTools", "toolSaveVersion", "toolGitHistory", "toolSipeedVision"];
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
      // Re-request the config on open (not just once at load): a manifest produced later in
      // the session must refresh the current-missing-driver tab's cold-driver picker.
      $("genDriverOpen").addEventListener("click", () => { openGlobalTool("toolGenDriver"); vscode.postMessage({ type: "request_gen_driver_config" }); });
      $("genDriverBack").addEventListener("click", closeGlobalTool);
      $("supportOpen").addEventListener("click", () => { openGlobalTool("toolSupport"); vscode.postMessage({ type: "open_support_panel" }); });
      $("supportBack").addEventListener("click", closeGlobalTool);
      // Device Tools global tool (#54): open the surface and check for a device — it lists
      // the root if one is connected, else shows the "plug in a device" state.
      $("deviceToolsOpen").addEventListener("click", () => { openGlobalTool("toolDeviceTools"); dtOnOpen(); });
      $("deviceToolsBack").addEventListener("click", closeGlobalTool);
      // Save Version (#95): its own global-tool surface (a git commit or session snapshot with
      // confirmation) — a user utility with no agent involvement, so it does NOT go in the Activity
      // feed. Open the surface and ask the host for the save summary.
      $("saveVersionOpen").addEventListener("click", () => { openGlobalTool("toolSaveVersion"); svOnOpen(); });
      $("saveVersionBack").addEventListener("click", closeGlobalTool);
      // Git History (#94): its own read-only surface — open it and ask the host for the timeline.
      $("gitHistoryOpen").addEventListener("click", () => { openGlobalTool("toolGitHistory"); ghOnOpen(); });
      $("gitHistoryBack").addEventListener("click", closeGlobalTool);
      // Sipeed vision export: a standalone tool surface. Opening it re-applies the CURRENT state
      // (svnOnOpen re-syncs the running lock) rather than clearing the form — the typed model path and
      // the last status line persist across close/reopen. No host round-trip and nothing written until
      // the user clicks Generate.
      $("sipeedVisionOpen").addEventListener("click", () => { openGlobalTool("toolSipeedVision"); svnOnOpen(); });
      $("sipeedVisionBack").addEventListener("click", closeGlobalTool);
      $("svnGenerate").addEventListener("click", svnGenerate);
      // Global tools: hover/focus floats the tool's name as a chip and blurs the rest of the row;
      // a click opens the tool and collapses the chip back to the small icon, which stays selected.
      const gtoolsTrack = $("globalTools");
      const gtoolsWrap = gtoolsTrack.closest(".gtools-wrap");
      const gtoolBtns = [...gtoolsTrack.querySelectorAll(".gtool-btn")];
      // Float side by MEASURED position, re-derived at lift time (NOT DOM index): .gtools has
      // flex-wrap, so a fixed first-half/second-half split by index puts the chip of the last button
      // on a wrapped row off the panel edge. A pill whose centre is left of the row midpoint opens its
      // chip right, otherwise left, so it always grows toward the centre — correct after a resize or a
      // re-wrap because it is measured each hover, not fixed once at init.
      const gtoolFloatSide = (btn) => {
        const wrapRect = gtoolsWrap.getBoundingClientRect();
        const btnRect = btn.getBoundingClientRect();
        const centre = btnRect.left + btnRect.width / 2;
        return centre <= wrapRect.left + wrapRect.width / 2 ? "exp-right" : "exp-left";
      };
      const liftGtool = (btn, on) => {
        gtoolsWrap.classList.toggle("gt-floating", on);
        if (on) { btn.classList.remove("exp-left", "exp-right"); btn.classList.add(gtoolFloatSide(btn)); }
        gtoolBtns.forEach((b) => b.classList.toggle("gt-lifted", on && b === btn));
      };
      gtoolBtns.forEach((btn) => {
        btn.addEventListener("mouseenter", () => liftGtool(btn, true));
        btn.addEventListener("mouseleave", () => liftGtool(btn, false));
        btn.addEventListener("focus", () => liftGtool(btn, true));
        btn.addEventListener("blur", () => liftGtool(btn, false));
        // The open handlers (wired above) already mark the tool active; here just collapse the chip
        // and clear the blur so the open tool sits as a small accent icon.
        btn.addEventListener("click", () => liftGtool(btn, false));
      });
      // Home hero action: begin a build. The composer is always mounted, so "start"
      // just reveals the board picker and focuses the prompt (no session yet).
      // Save Version (#95) and Git History (#94) are wired above as their own global-tool surfaces.
      $("startWorkflow").addEventListener("click", () => { setBoardPickerVisible(true); setBoardBodyExpanded(true); $("intent").focus(); });
      // Two axes, no longer conflated in one flat row: Open Folder is workspace selection (opens a
      // local FOLDER as the workspace); Recent Sessions is the session-lifecycle entry (a read-only
      // per-folder list from .mpyhw/sessions). The folder-picker restore (import_session) is NOT a
      // top-level button anymore -- it lives inside the Recent panel as "Restore from folder…", since
      // it and a Recent card both just restore a saved session.
      $("openFolder").addEventListener("click", () => vscode.postMessage({ type: "open_project_folder" }));
      $("recentSessions").addEventListener("click", () => { openGlobalTool("toolRecent"); vscode.postMessage({ type: "request_recent_sessions" }); });
      $("recentRestoreFolder").addEventListener("click", () => vscode.postMessage({ type: "import_session" }));
      $("recentBack").addEventListener("click", closeGlobalTool);
      // Request credits (#97): a contact entry, not a payment portal. The host builds the prefilled
      // mailto (gating on GitHub sign-in) and opens it via openExternal. The button lives inside the
      // quota bar, so it's only visible once credits are shown.
      $("requestCredits").addEventListener("click", () => vscode.postMessage({ type: "request_credits_email" }));
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
        // Experience mode is start-time only; hide it during a run (the board chooser above
        // already hides via setBoardPickerVisible). Textarea + Generate stay for notes.
        $("modeToggle").classList.toggle("hidden", on);
        $("intent").placeholder = tr(on ? "note_ph" : "intent_ph");
        if (on) setPending(tr("working")); // immediate spinner; trace_event refines the label
        updateGenerateEnabled();
      }
      $("generate").addEventListener("click", () => {
        if (running) { vscode.postMessage({ type: "cancel_session" }); setPending(tr("stopping")); return; }
        const intent = $("intent").value.trim();
        if (!intent) return;
        // Read the board choice BEFORE the wipe below: clearConversation() calls clearBoardChoice(),
        // so a board picked while reading a replayed session would be dropped without a trace.
        const preSelectedBoard = selectedOfficialBoard;
        // A view-only replay leaves a PAST session's feed on screen, but this build gets its own fresh
        // session dir (the replay seeds no traceId). Leaving that history above the new run would show
        // two unrelated sessions as one conversation, and a later Save Version would cover only the
        // new half of what the user can see. Wipe the replay first. clearConversation() clears the flag
        // itself, so this fires once per replay and a normal follow-up request still appends.
        if (viewOnlyReplay) clearConversation();
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
      // Serial monitor (Start/Stop on the Serial tab): a live REPL/stdout stream the
      // host holds open independently of any build session. serialMonitorRunning
      // mirrors the host's serial_monitor_status; serialMonitorBusy covers the gap
      // between clicking and the host's reply so a double-click can't send two starts.
      // serialMonitorBusyAction tracks WHICH request is in flight so the transient
      // label matches the click (a Stop click must not show "Starting…").
      let serialMonitorRunning = false;
      let serialMonitorBusy = false;
      let serialMonitorBusyAction = null;
      function setSerialMonitorButton() {
        const btn = $("serialMonitorToggle");
        if (!btn) return;
        btn.disabled = serialMonitorBusy;
        btn.textContent = serialMonitorBusy
          ? tr(serialMonitorBusyAction === "stop" ? "serial_monitor_stopping" : "serial_monitor_starting")
          : tr(serialMonitorRunning ? "serial_monitor_stop" : "serial_monitor_start");
        btn.classList.toggle("live", serialMonitorRunning);
      }
      function onSerialMonitorStatus(msg) {
        serialMonitorBusy = false;
        serialMonitorBusyAction = null;
        serialMonitorRunning = !!msg.running;
        const btn = $("serialMonitorToggle");
        if (btn) {
          const errKey = msg.error === "device_busy" ? "serial_monitor_err_device_busy"
            : msg.error === "monitor_ended" ? "serial_monitor_err_ended"
            : "serial_monitor_err_generic";
          btn.title = (!msg.running && msg.error) ? tr(errKey, { e: String(msg.error) }) : "";
        }
        setSerialMonitorButton();
      }
      const serialMonitorToggle = $("serialMonitorToggle");
      if (serialMonitorToggle) {
        serialMonitorToggle.addEventListener("click", () => {
          if (serialMonitorBusy) return;
          serialMonitorBusyAction = serialMonitorRunning ? "stop" : "start";
          serialMonitorBusy = true;
          setSerialMonitorButton();
          vscode.postMessage({ type: serialMonitorRunning ? "serial_monitor_stop" : "serial_monitor_start" });
        });
      }
      // Wipe every per-conversation surface back to its empty state. The host clears
      // its durable state in parallel (reset_session), so the next request is a
      // brand-new build, not a continuation. The locked UI language is left as-is —
      // the next intent re-locks it (setLocale is a no-op when unchanged).
      //
      // True while the feed shows a READ-ONLY replay of a past session (a Recent Sessions card with no
      // saved snapshot). The set lives in the restore_reset handler; every wipe path clears it below, so
      // the flag can never outlive the feed it describes.
      let viewOnlyReplay = false;
      function clearConversation() {
        $("activity").innerHTML = "";
        $("activityEmpty").classList.remove("hidden");
        $("serial").innerHTML = "";
        resetSerialLineCount();
        $("serialFilled").classList.add("hidden");
        $("serialEmpty").classList.remove("hidden");
        $("serialHead").classList.remove("live");
        // A conversation reset does not stop the real monitor (the device connection
        // outlives the chat) — only clear a stuck in-flight click, never the live flag.
        serialMonitorBusy = false;
        serialMonitorBusyAction = null;
        setSerialMonitorButton();
        $("wiring").innerHTML = "";
        $("wiringEmpty").classList.remove("hidden");
        $("diagram").innerHTML = "";
        $("diagramEmpty").classList.remove("hidden");
        ARTIFACTS = []; artifactPhase = ""; artifactsLinkShown = false; drawArtifacts();
        // Restart reaches neither of the credit accumulator's flush points: reset_session
        // posts no session_done back, and an aborted run's own session_done is dropped by
        // the host's generation guard. Dropped, not flushed — the tally belongs to the
        // conversation being wiped, so emitting it into the fresh feed would be wrong too.
        discardCreditUsage();
        // Same bleed, protocol level: a stamped session_event still in flight for the
        // session being wiped must not repopulate a fresh accumulator. Start draining
        // stamped frames now; the host's session_reset echo ends the drain.
        markSessionEventsStale();
        finalizeThinking(); currentCode = null; currentSummary = null;
        currentDeployCard = null; pendingCard = null; pendingLabel = "";
        localeLocked = false; // next project re-detects its language (LOCALE left as-is until then)
        viewOnlyReplay = false; // the replayed feed is gone, so nothing on screen is read-only any more
        document.querySelectorAll(".newdot").forEach((d) => d.remove());
        document.querySelectorAll(".tab .pulse").forEach((p) => p.remove());
        setBoardPickerVisible(true);
        clearBoardChoice();
        setTab("activity");
      }
      $("newSession").addEventListener("click", () => {
        vscode.postMessage({ type: "reset_session" });
        setRunning(false);
        clearConversation();
        $("intent").value = ""; $("intent").style.height = "auto";
      });
      // Grow the intent box to fit its content up to a cap, and only show a scrollbar past the cap
      // (the default is overflow:hidden so a wrapping placeholder never triggers one). Shared by the
      // input handler and prefillImportedRecipe so both writers size the box the same way.
      const INTENT_MAX_HEIGHT = 120;
      function autosizeIntent() {
        const el = $("intent");
        el.style.height = "auto";
        el.style.height = Math.min(el.scrollHeight, INTENT_MAX_HEIGHT) + "px";
        el.style.overflowY = el.scrollHeight > INTENT_MAX_HEIGHT ? "auto" : "hidden";
      }
      const ta = $("intent");
      ta.addEventListener("focus", () => $("composerBox").classList.add("focused"));
      ta.addEventListener("blur", () => $("composerBox").classList.remove("focused"));
      ta.addEventListener("input", autosizeIntent);

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
        setQuotaWarn(quotaExhausted);
        updateGenerateEnabled();
      }

      // #qWarn is one node shared by both warning states; the CSS only recolored it,
      // so a fully-consumed quota still read "nearly exhausted". Swap the i18n key
      // (attribute + text) so the copy matches the real balance and re-renders on a
      // later locale lock. Called from setCredits and the out_of_credits path.
      function setQuotaWarn(exhausted) {
        const w = $("qWarn"); if (!w) return;
        const key = exhausted ? "creditsExhausted" : "lowCredits";
        w.setAttribute("data-i18n", key);
        w.textContent = tr(key);
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
          if (p.logo) {
            const img = document.createElement("img"); img.className = "partner-logo"; img.src = p.logo; img.alt = p.name;
            img.addEventListener("error", () => { a.textContent = p.name; });
            a.appendChild(img);
          } else {
            a.textContent = p.name;
          }
          a.addEventListener("click", () => vscode.postMessage({ type: "open_external", url: p.url }));
          row.appendChild(a);
        }
        root.appendChild(h); root.appendChild(row);
      }
      // List of past session summaries (host-served from .mpyhw/sessions). Clicking a card RESTORES that
      // session (board/wiring/diagram/code) via the host; a session with no snapshot degrades gracefully.
      function renderRecent(msg) {
        msg = msg || {};
        const sessions = Array.isArray(msg.sessions) ? msg.sessions : [];
        // Make the per-folder scope visible: name the folder (or the no-folder fallback) so an empty
        // list reads as "nothing in THIS folder yet", not lost data.
        const scope = $("recentScope");
        if (scope) scope.textContent = msg.usingFallback ? tr("recent_scope_global") : (msg.folder ? tr("recent_scope", { f: String(msg.folder) }) : "");
        const box = $("recent"); if (!box) return;
        box.innerHTML = "";
        const empty = $("recentEmpty");
        if (!sessions.length) { empty.classList.remove("hidden"); return; }
        empty.classList.add("hidden");
        for (const s of sessions) {
          const card = document.createElement("button"); card.className = "recent-card"; card.type = "button";
          const title = document.createElement("span"); title.className = "recent-intent"; title.textContent = s.intent || s.id;
          const meta = document.createElement("span"); meta.className = "recent-meta";
          const when = s.date ? new Date(s.date).toLocaleString() : "";
          meta.textContent = s.finalPhase ? (when + " · " + s.finalPhase) : when;
          card.appendChild(title); card.appendChild(meta);
          // A session with a saved snapshot is resumable/re-savable; a pre-Save-Version one has no
          // snapshot, so it is view-only — mark it, but it still restores (read-only) below.
          if (!s.restorable) {
            const tag = document.createElement("span"); tag.className = "recent-viewonly"; tag.textContent = tr("recent_view_only");
            card.appendChild(tag);
          }
          // Both a restorable and a view-only session go through restore_session — the host branches
          // on snapshot presence and, for a view-only one, replays the transcript read-only instead of
          // rehydrating from a snapshot (it can't be resumed/re-saved). Close the Recent surface first
          // so the rehydrated feed/tabs (which render on the home workbench beneath it) are actually
          // visible — otherwise the click looks like it did nothing until Back.
          card.addEventListener("click", () => { closeGlobalTool(); vscode.postMessage({ type: "restore_session", id: s.id }); });
          box.appendChild(card);
        }
      }
