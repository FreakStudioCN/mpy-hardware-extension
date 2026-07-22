
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

      // Render the change list: a color-coded letter badge + the path. Device-supplied paths go in
      // via textContent (never HTML). Empty -> a "no changes" line.
      function svRenderFiles(files) {
        const host = $("svFiles"); if (!host) return;
        host.innerHTML = "";
        files = Array.isArray(files) ? files : [];
        if (!files.length) { const e = document.createElement("div"); e.className = "sv-empty"; e.textContent = tr("sv_no_changes"); host.appendChild(e); return; }
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
        const files = $("svFiles"); if (files) files.innerHTML = "";
        const stage = $("svStage"); if (stage) stage.textContent = "";
        const note = $("svNote"); if (note) { note.textContent = ""; note.classList.add("hidden"); }
        const msg = $("svMsg"); if (msg) msg.value = "";
        svStatusMsg(tr("sv_loading"));
        svSetButtons(true); // re-enabled once the data lands
        vscode.postMessage({ type: "save_version_open" });
      }

      // Host reply with the summary: render the file list (color-coded letter badges), prefill the
      // proposed message, and gate the Commit method on a git repo (else force Snapshot). Device-
      // supplied paths go in via textContent (never HTML).
      function onSaveVersionData(d) {
        d = d || {};
        svStatusMsg("");
        const stage = $("svStage"); if (stage) stage.textContent = d.stage || "";
        const note = $("svNote"); if (note) { note.textContent = d.note || ""; note.classList.toggle("hidden", !d.note); }
        const msg = $("svMsg"); if (msg) msg.value = d.proposed || "";
        svRenderFiles(d.files);
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
        // A commit changed the tree — refresh the list to the post-commit truth the host re-read
        // (empty after add -A, or the remaining unstaged files), so it no longer shows the
        // just-committed files as pending. Snapshot leaves git untouched, so its list stays.
        if (status === "saved_commit" && s && s.files) svRenderFiles(s.files);
        const text = status === "saved_commit" ? tr("sv_saved_commit", { hash: String((s && s.hash) || "").slice(0, 8) })
          : status === "saved_snapshot" ? tr("sv_saved_snapshot")
          : status === "nothing_to_commit" ? tr("sv_nothing_to_commit")
          : status === "nothing_to_save" ? tr("sv_nothing")
          : status === "busy" ? tr("sv_busy")
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
          vscode.postMessage({ type: "save_version_commit", message: ($("svMsg") ? $("svMsg").value : "") });
        });
        $("svSnapshot").addEventListener("click", () => {
          if (svBusy) return;
          svBusy = true; svSetButtons(true); svStatusMsg(tr("sv_saving"));
          vscode.postMessage({ type: "save_version_snapshot" });
        });
      }
