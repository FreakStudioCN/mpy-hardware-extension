
      const vscode = typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : { postMessage: (m) => console.log(m), getState: () => null, setState: () => {} };
      const $ = (id) => document.getElementById(id);


      window.addEventListener("message", (event) => {
        const msg = event.data;
        if (msg.type === "recipe_imported") { prefillImportedRecipe(msg.payload); }
        if (msg.type === "doctor_results") { renderDoctor(msg.items); }
        if (msg.type === "gen_driver_config") { renderGenDriver(msg.tabs); }
        if (msg.type === "gen_driver_status") { setGenDriverStatus(msg.status, msg.detail); }
        if (msg.type === "gen_driver_required") { showDriverRequiredOffer(msg.blocks); }
        if (msg.type === "optional_flows") { setOptionalFlows(msg.phases); }
        if (msg.type === "optional_flow_status") { setOptionalFlowStatus(msg.flow, msg.status, msg.detail); }
        if (msg.type === "optional_flow_done") { addOptionalFlowDoneCard(msg.flow); }
        if (msg.type === "gen_driver_file_picked") { setGenDriverFile(msg); }
        if (msg.type === "support_config") { renderSupport(msg); }
        if (msg.type === "device_tool_result") { onDeviceToolResult(msg.command, msg.result); }
        if (msg.type === "device_tool_error") { onDeviceToolError(msg.command, msg.error); }
        if (msg.type === "device_tool_delete_armed") { onDeviceDeleteArmed(msg.path, msg.nonce); }
        if (msg.type === "device_tool_uninstall_armed") { onDeviceUninstallArmed(msg.name, msg.nonce); }
        if (msg.type === "package_search_result") { onPackageSearchResult(msg.source, msg.results, msg.query); }
        if (msg.type === "package_search_error") { onPackageSearchError(msg.source, msg.query); }
        if (msg.type === "package_resolve_result") { onPackageResolveResult(msg.record, msg.url); }
        if (msg.type === "package_resolve_error") { onPackageResolveError(msg.url); }
        if (msg.type === "device_busy") { onDeviceBusy(msg.phase); }
        if (msg.type === "device_present") { onDevicePresent(msg.present, msg.ports, msg.needsEnvSetup); }
        if (msg.type === "logs_status") { const n = $("scDiag"); if (n) n.textContent = msg.text; }
        if (msg.type === "partners_config") { renderPartners(msg.partners); }
        if (msg.type === "recent_sessions") { renderRecent(msg); }
        // Session restore rehydrates the feed (the inverse of clearConversation): clear, then replay the
        // DURABLE content from the transcript — the AI's summaries + an INERT "asked -> answered" line per
        // past prompt (never a live, clickable prompt) — then a terminal line. Transient trace/spinner is
        // not replayed (it isn't durable), so no live-run guard is touched.
        if (msg.type === "restore_reset") { clearConversation(); }
        // Rich feed replay (Stage 1): the host maps DURABLE transcript events to these ungated messages, so
        // the past run's narration re-renders on restore without touching the live-run gates. A user request
        // renders as its own card; a mapped line renders as a trace line, or an error line (kind:"error").
        // Restore never arms the spinner (the run is idle) — addActivity here must not setPending.
        if (msg.type === "restore_user") { addUserMessage(String(msg.text || "")); }
        if (msg.type === "restore_line") {
          if (msg.kind === "error") addActivity({ text: String(msg.text || "") }, "error");
          else addActivity({ type: "trace", text: String(msg.text || "") });
        }
        // A past prompt replays as its REAL card, rendered inert (Stage 2): the recorded prompt payload +
        // the answer it received. renderInertPrompt reuses the live renderer, disabled and answer-stamped.
        if (msg.type === "restore_prompt") { renderInertPrompt(msg.kind, msg.payload, msg.answer); }
        if (msg.type === "restore_done") {
          const t = String(msg.terminal || "");
          if (t) { const label = tr("term_" + t); addActivity({ text: tr("session_ended", { t: label === "term_" + t ? t : label }) }); }
        }
        if (msg.type === "diagnostics") {
          vscode.postMessage({ type: "copy_code", text: msg.text });
          const n = $("scDiag"); if (n) n.textContent = "Diagnostics copied to clipboard.";
        }
        if (msg.type === "server_mode") { setServerMode(msg.mode); }
        if (msg.type === "micropython_boards") { loadOfficialBoards(msg); }
        if (msg.type === "session_event" && msg.event && msg.event.kind === "credits") {
          setCredits(msg.event.balance, msg.event.dailyGrant);
        }
        if (msg.type === "session_event" && msg.event && msg.event.kind === "saved_location") {
          addSavedLocation(msg.event.path);
        }
        if (msg.type === "trace_event" && running) {
          // A tool FAILURE carries the real reason (a device runtime error, a failed
          // driver install). Surface it as a durable feed line so the user sees WHY a
          // step broke, instead of a silent spinner that ends in a generic terminal
          // message. The loop may still retry/repair after this.
          if (msg.event && msg.event.isError && msg.event.text) {
            addActivity({ text: tr("tool_failed", { e: String(msg.event.text) }) });
          }
          // The agent's internal tool steps drive the single in-feed working
          // spinner — we show a curated, localized phase label (e.g. "Generating
          // code…"), never the model's raw reasoning (chain-of-thought is discarded
          // upstream before the tool fires). This refreshes the label and re-arms
          // the spinner in the gap between one card finishing and the next tool
          // starting — unless real content is currently streaming.
          if (!currentSummary && !currentCode) setPending(phaseLabel(msg.event));
        }
        if (msg.type === "summary_delta") { streamSummaryDelta(msg.text); }
        if (msg.type === "summary_discard") { discardSummary(); }
        if (msg.type === "summary_seal") { sealSummary(); }
        if (msg.type === "summary") { addSummary(msg.text); }
        if (msg.type === "ui_prompt_needed") { addAskPrompt(msg.promptId, msg.question, msg.options, msg.optionsRequiringText, msg.textPlaceholder); }
        if (msg.type === "components_needed") { addComponentPrompt(msg.promptId, msg.devices); }
        if (msg.type === "plan_needed") { addPlanPrompt(msg.promptId, msg.plan); }
        if (msg.type === "deploy_needed") { addDeployPrompt(msg.promptId, msg.manifest); }
        if (msg.type === "file_op_confirm_needed") { addFileOpPrompt(msg.promptId, msg.op, msg.path); }
        // Protocol (plugin-interface) renderers:
        if (msg.type === "approval_request") {
          // The webview's own per-card `answered` guard covers a same-card double
          // click; this guards the render itself — a re-delivered/duplicated
          // approval_request for a promptId already on screen must not stack a
          // second card the user could double-answer.
          if (document.querySelector(`[data-prompt-id="${msg.promptId}"]`)) {
            console.warn("duplicate approval_request ignored", msg.promptId);
          } else {
            addApprovalPrompt(msg.promptId, msg.card);
          }
        }
        if (msg.type === "status_update" && running) { addStatusUpdate(msg.payload); }
        if (msg.type === "phase_start") { setPending(tr("working")); }
        if (msg.type === "phase_complete") { addPhaseComplete(msg.payload); vscode.postMessage({ type: "request_artifacts" }); }
        if (msg.type === "deploy_ports_updated") { if (currentDeployCard) currentDeployCard.setPorts(msg.ports); }
        if (msg.type === "code_delta") { streamCodeDelta(msg.text, msg.path); }
        if (msg.type === "code_updated") { finalizeCode(msg.code, msg.path); }
        if (msg.type === "manifest_updated") { renderWiring(msg.manifest); }
        if (msg.type === "diagram_updated") { renderDiagram(msg.diagram); }
        if (msg.type === "artifacts_index") { renderArtifacts(msg.artifacts); renderOptionalFlowImages(msg.artifacts); }
        if (msg.type === "serial_output") { addSerial(msg.lines); }
        if (msg.type === "device_selected") { addActivity({ type: "trace", text: tr("device_selected", { p: msg.port }) }); }
        // support_feedback_opened / support_diagnostics_exported are recorded host-side (session log +
        // recent_activity, surfaced in the diagnostics snapshot) for section 08 §6.3 / §8.1 traceability.
        // They are deliberately NOT rendered into the build feed: opening the support panel or copying a
        // contact is navigation, not build progress, and would just clutter the conversation.
        // A supplement line is an annotation, not a step: addActivity() clears the working
        // spinner, so re-arm it (with the same label) while the build is still running.
        if (msg.type === "user_supplement_received") { addActivity({ type: "trace", text: tr("supplement_received", { s: msg.summary }) }, "note"); if (running && pendingLabel) setPending(pendingLabel); }
        if (msg.type === "user_supplement_applied") { addActivity({ type: "trace", text: tr("supplement_applied", { d: msg.decision, r: msg.reason }) }, "note"); if (running && pendingLabel) setPending(pendingLabel); }
        if (msg.type === "files_written") { addActivity({ type: "trace", text: tr("files_written", { p: (msg.paths || []).join(", ") }) }); vscode.postMessage({ type: "request_artifacts" }); addArtifactsLink(); }
        if (msg.type === "files_write_failed") { addActivity({ type: "trace", text: tr("files_write_failed", { e: msg.error }) }); }
        // Save Version (#95) lives in its own tool surface (SaveVersionPanel), not the Activity feed.
        if (msg.type === "save_version_data") { onSaveVersionData(msg); }
        if (msg.type === "save_version_status") { onSaveVersionStatus(msg); }
        // Git History (#94): its own read-only surface (GitHistoryPanel), not the Activity feed.
        if (msg.type === "git_history_data") { onGitHistoryData(msg); }
        if (msg.type === "git_history_commit_data") { onGitHistoryCommitData(msg); }
        if (msg.type === "git_history_diff_data") { onGitHistoryDiffData(msg); }
        if (msg.type === "git_history_status") { onGitHistoryStatus(msg); }
        if (msg.type === "session_error") {
          const errKey = "err_" + msg.error;
          const text = (I18N[LOCALE] && I18N[LOCALE][errKey]) || I18N.en[errKey] || msg.error;
          if (msg.error === "daily_cap_reached") {
            // Sticky until the cap resets: the next credits event recomputes
            // quotaExhausted from balance (typically still > 0 for a capped user),
            // so this independent deadline is what keeps Start disabled.
            const now = new Date();
            capBlockedUntil = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
          }
          if (msg.error === "out_of_credits" || msg.error === "daily_cap_reached") { quotaExhausted = true; $("quota").classList.add("exhausted"); setQuotaWarn(true); updateGenerateEnabled(); }
          addActivity({ text });
        }
        if (msg.type === "session_done") {
          setRunning(false);
          finalizeThinking();
          currentCode = null;
          currentSummary = null;
          clearPending();
          // A still-open deploy card is now stale (its prompt was resolved by the
          // session ending); disable its buttons so clicks can't post stale replies.
          if (currentDeployCard) { document.querySelectorAll(".deploy-go, .deploy-rescan, .deploy-cancel").forEach((b) => { b.disabled = true; }); currentDeployCard = null; }
          // Same for a still-open approval card ([data-prompt-id] is stamped only on
          // approval cards): its prompt is resolved too, so a later click would post a
          // stale ui_prompt_response that the host can only log as a duplicate.
          document.querySelectorAll("[data-prompt-id] button, [data-prompt-id] input").forEach((b) => { b.disabled = true; });
          $("serialHead").classList.remove("live");
          document.querySelectorAll(".tab .pulse").forEach((p) => p.remove());
          // Re-enable Device Tools + re-list the current path now the run freed the port, so a
          // model-issued rm/cp/mkdir shows up without an unplug/replug. In the IDEMPOTENT section
          // (before the terminalShown guard) on purpose: a cancel posts session_done twice, and the
          // optimistic first post fires while the loop is still unwinding (the port not yet free),
          // so its re-list can be refused device_busy and re-strand the banner; the later unwind
          // post then heals it. Runs after setRunning(false) so the presence result is honored.
          dtRefreshAfterRun();
          const t = String(msg.terminal);
          // "complete" is the protocol's successful terminal (the whole pipeline ran);
          // "awaiting_user" is a clean hand-back, not an error.
          const ok = t === "generated" || t === "success" || t === "complete";
          const label = tr("term_" + t);
          const friendly = label === "term_" + t ? t : label;
          const isError = !ok && t !== "cancelled" && t !== "awaiting_user" && t !== "stalled";
          // session_done is posted twice on a cancel (optimistic + loop-unwind); render the
          // terminal line / retry card only once. The cleanup above is idempotent, so it may
          // run on both.
          if (terminalShown) return;
          terminalShown = true;
          // A stalled build gave up mid-way without reaching a phase boundary — unlike
          // awaiting_user (a clean hand-back), the user must SEE it stalled and get a
          // one-click way to try again, so it has its own lane before the generic line.
          if (t === "stalled") {
            addActivity({ text: tr("session_stuck") });
            addRetryCard();
          }
          // The status bar is gone; surface a terminal line in the feed for ends
          // that aren't self-evident from the result (errors and a cancelled run).
          // A successful finish needs none — the summary + code cards say it.
          if (isError || t === "cancelled") addActivity({ text: tr("session_ended", { t: friendly }) });
          // Transport failures keep the session state on the host, so the
          // interrupted turn can be re-issued verbatim — offer a one-click retry.
          if (t === "llm_unreachable" || t === "sse_stream_interrupted") addRetryCard();
        }
        if (msg.type === "phase_error") {
          // WHY the run is about to end "failed" — the terminal line alone can't say, because
          // "failed" is also what the model reports when it gives up on its own. Rendered as a
          // durable feed line before session_done arrives. An unrecognized error_kind still
          // gets named (phase_broke) rather than silently dropped.
          const text = msg.error_kind === "unknown_next_phase"
            ? tr("phase_unknown_next", { p: String(msg.next_phase) })
            : tr("phase_broke", { k: String(msg.error_kind) });
          // Forced "error", never text-classified: classifyActivity() keys off the words
          // fail/error/crash/exhaust, which this wording (and its zh translation) lacks, so it
          // would classify as thinking and be CONCATENATED into the open thinking card. A
          // discrete fault must be its own card and must not depend on how the string is worded.
          addActivity({ text: text }, "error");
        }
        if (msg.type === "connect_retry") {
          // The host is auto-retrying a dropped connection; keep the spinner honest
          // ("retrying 1/3") instead of leaving the user staring at silence.
          setPending(tr("retrying", { n: msg.attempt, m: msg.maxAttempts }));
        }
        if (msg.type === "session_busy") {
          // The host rejected this start because a prior run is still unwinding.
          // Clear the optimistic spinner so the UI can't hang; the user can retry.
          setRunning(false);
          clearPending();
        }
      });
