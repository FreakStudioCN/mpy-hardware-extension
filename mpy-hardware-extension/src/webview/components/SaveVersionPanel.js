
      // ----- Save Version global tool (#95): commit-to-git / session-snapshot with confirmation.
      // Its OWN surface (toolSaveVersion), NOT an Activity-feed card — a user utility with no agent
      // involvement, so it doesn't belong in the build feed. Open -> ask the host for the summary
      // (save_version_open -> save_version_data) -> user confirms here (save_version_commit /
      // save_version_snapshot -> save_version_status). Host enforces the git/snapshot + the busy
      // guard; the webview only renders + posts. -----
      var svBusy = false;    // an act is in flight (host round-trip): keep the buttons disabled
      var svMode = "commit"; // save method: "commit" | "snapshot"

      function svStatusMsg(text) { const n = $("svStatus"); if (n) n.textContent = text || ""; }
      function svSetButtons(disabled) { ["svCommit", "svSnapshot"].forEach((id) => { const b = $(id); if (b) b.disabled = disabled; }); }

      // When saving isn't possible right now (a build is running / no workspace / nothing to save),
      // replace the whole form with a full-view message (like Device Tools' "No device connected"),
      // so the user isn't offered a form that can't work.
      function svBlock(heading, sub) {
        const body = $("svBody"); if (body) body.classList.add("hidden");
        const bl = $("svBlocked"); if (bl) bl.classList.remove("hidden");
        const h = $("svBlockedH"); if (h) h.textContent = heading || "";
        const p = $("svBlockedP"); if (p) p.textContent = sub || "";
        svStatusMsg(""); // the full-view carries the message
      }
      function svUnblock() {
        const bl = $("svBlocked"); if (bl) bl.classList.add("hidden");
        const body = $("svBody"); if (body) body.classList.remove("hidden");
      }

      // Render the change list: a color-coded letter badge + the path. Device-supplied paths go in
      // via textContent (never HTML). Empty -> a centered icon empty state (svNoChanges), not a row.
      function svRenderFiles(files) {
        const host = $("svFiles"); if (!host) return;
        host.innerHTML = "";
        files = Array.isArray(files) ? files : [];
        const none = $("svNoChanges");
        if (none) none.classList.toggle("hidden", files.length > 0);
        host.classList.toggle("hidden", files.length === 0);
        if (!files.length) return;
        for (const f of files) {
          const row = document.createElement("div"); row.className = "ask-file";
          const badge = document.createElement("span"); badge.className = "ask-file-badge ask-file-badge-" + String(f && f.status);
          badge.textContent = f && f.badge ? String(f.badge) : "•";
          const path = document.createElement("span"); path.className = "ask-file-path"; path.textContent = (f && f.name != null) ? String(f.name) : "";
          row.appendChild(badge); row.appendChild(path); host.appendChild(row);
        }
      }

      // Segmented either/or (like Beginner/Custom): pick the save method and reveal its pane —
      // Commit shows the message box + Commit button; Snapshot shows just the Save button.
      function svSetMode(mode) {
        svMode = mode === "snapshot" ? "snapshot" : "commit";
        document.querySelectorAll("#svMode .mode-chip").forEach((b) => {
          const on = b.dataset.svmode === svMode;
          b.classList.toggle("active", on); b.setAttribute("aria-pressed", on ? "true" : "false");
        });
        const cp = $("svCommitPane"); if (cp) cp.classList.toggle("hidden", svMode !== "commit");
        const sp = $("svSnapshotPane"); if (sp) sp.classList.toggle("hidden", svMode !== "snapshot");
      }

      // Opened from the global-tools bar: clear the last render and ask the host for a fresh summary.
      function svOnOpen() {
        svBusy = false;
        svSetButtons(true); // re-enabled once the data lands
        svBlock(tr("sv_loading"), ""); // full-view "Reading changes…" until data or a blocking status
        vscode.postMessage({ type: "save_version_open" });
      }

      // The rest of the §3.6.3 summary the card must cover, all from host-local data. A short
      // always-shown session block + collapsible artifact/diagnostics sections. Every value goes
      // in via textContent (host/plugin strings are never HTML); empty sections hide themselves.
      function svKvRow(host, label, value) {
        if (!value) return;
        const row = document.createElement("div"); row.className = "sv-kv-row";
        const k = document.createElement("span"); k.className = "sv-kv-k"; k.textContent = label;
        const v = document.createElement("span"); v.className = "sv-kv-v"; v.textContent = String(value);
        row.appendChild(k); row.appendChild(v); host.appendChild(row);
      }
      function svRenderSession(d) {
        const s = (d && d.session) || {}; const host = $("svSession"); if (!host) return;
        host.innerHTML = "";
        svKvRow(host, tr("sv_kv_project"), s.intent);
        svKvRow(host, tr("sv_kv_phase"), s.phase);
        svKvRow(host, tr("sv_kv_board"), s.board);
        svKvRow(host, tr("sv_kv_mode"), s.mode);
        host.classList.toggle("hidden", host.childElementCount === 0);
      }
      function svRenderArtifacts(d) {
        const arts = Array.isArray(d && d.artifacts) ? d.artifacts : [];
        const total = (d && typeof d.artifactTotal === "number") ? d.artifactTotal : arts.length;
        const wrap = $("svArtifactsWrap"); const sum = $("svArtifactsSum"); const list = $("svArtifacts");
        if (!wrap || !sum || !list) return;
        wrap.classList.toggle("hidden", total === 0);
        sum.textContent = tr("sv_artifacts_n", { n: String(total) });
        list.innerHTML = "";
        for (const a of arts) {
          const row = document.createElement("div"); row.className = "sv-art";
          const kind = document.createElement("span"); kind.className = "sv-art-kind"; kind.textContent = (a && a.kind) ? String(a.kind) : "file";
          const path = document.createElement("span"); path.className = "sv-art-path"; path.textContent = (a && a.path != null) ? String(a.path) : "";
          row.appendChild(kind); row.appendChild(path);
          const ph = (a && a.phase) ? String(a.phase) : "";
          if (ph) { const p = document.createElement("span"); p.className = "sv-art-phase"; p.textContent = ph; row.appendChild(p); }
          list.appendChild(row);
        }
        if (total > arts.length) { const more = document.createElement("div"); more.className = "sv-art-more"; more.textContent = tr("sv_artifacts_more", { n: String(total - arts.length) }); list.appendChild(more); }
      }
      function svRenderDiag(d) {
        const g = (d && d.diagnostics) || {}; const wrap = $("svDiagWrap"); const host = $("svDiag"); if (!wrap || !host) return;
        host.innerHTML = "";
        svKvRow(host, tr("sv_diag_activity"), g.activity);
        svKvRow(host, tr("sv_diag_errors"), g.errors);
        svKvRow(host, tr("sv_diag_session"), g.session_id);
        wrap.classList.toggle("hidden", host.childElementCount === 0);
      }
      function svRenderSummary(d) { svRenderSession(d); svRenderArtifacts(d); svRenderDiag(d); }

      // Host reply with the summary: render the file list (color-coded letter badges), prefill the
      // proposed message, and gate the Commit method on a git repo (else force Snapshot). Device-
      // supplied paths go in via textContent (never HTML).
      function onSaveVersionData(d) {
        d = d || {};
        svUnblock(); // data means we can save -> show the form
        svStatusMsg("");
        const stage = $("svStage"); if (stage) stage.textContent = d.stage || "";
        const note = $("svNote"); if (note) { note.textContent = d.note || ""; note.classList.toggle("hidden", !d.note); }
        const msg = $("svMsg"); if (msg) msg.value = d.proposed || "";
        svRenderFiles(d.files);
        svRenderSummary(d);
        // Commit needs a git repo: disable that method + force Snapshot when there's none.
        const commitChip = $("svModeCommit"); if (commitChip) commitChip.disabled = !d.canCommit;
        svSetMode(d.canCommit ? svMode : "snapshot");
        svBusy = false; svSetButtons(false);
      }

      // Host reply after an act (or a pre-flight rejection): show the outcome. A success stays on
      // screen — the tool does NOT auto-close, so the user sees the commit hash / snapshot confirmation.
      function onSaveVersionStatus(s) {
        svBusy = false; svSetButtons(false);
        const status = s && s.status;
        // Can't-proceed states (from open, or a build that started mid-panel): no interactive form
        // makes sense, so take over the whole view with a full-view message.
        if (status === "busy") { svBlock(tr("sv_busy_h"), tr("sv_busy_p")); return; }
        if (status === "nothing_to_save") { svBlock(tr("sv_nothing_h"), tr("sv_nothing_p")); return; }
        if (status === "workspace_unavailable") { svBlock(tr("sv_noworkspace_h"), tr("sv_noworkspace_p")); return; }
        // Act results: keep the form and show an inline status. A commit refreshes the file list to
        // the post-commit truth the host re-read; snapshot leaves git untouched, so its list stays.
        svUnblock();
        if (status === "saved_commit" && s && s.files) svRenderFiles(s.files);
        const text = status === "saved_commit" ? tr("sv_saved_commit", { hash: String((s && s.hash) || "").slice(0, 8) })
          : status === "saved_snapshot" ? tr("sv_saved_snapshot")
          : status === "nothing_to_commit" ? tr("sv_nothing_to_commit")
          : tr("sv_failed", { e: String((s && s.error) || status) });
        svStatusMsg(text);
      }

      // Controls live in the DOM at load (the tool-view is hidden, not removed).
      if ($("svMode")) {
        $("svModeCommit").addEventListener("click", () => { if (!$("svModeCommit").disabled) svSetMode("commit"); });
        $("svModeSnapshot").addEventListener("click", () => svSetMode("snapshot"));
        $("svCommit").addEventListener("click", () => {
          if (svBusy) return;
          svBusy = true; svSetButtons(true); svStatusMsg(tr("sv_saving"));
          const msg = $("svMsg");
          vscode.postMessage({ type: "save_version_commit", message: msg ? msg.value : "" });
          if (msg) msg.value = ""; // clear the box on commit (the host falls back to the proposed message)
        });
        $("svSnapshot").addEventListener("click", () => {
          if (svBusy) return;
          svBusy = true; svSetButtons(true); svStatusMsg(tr("sv_saving"));
          vscode.postMessage({ type: "save_version_snapshot" });
        });
      }
