
      // ----- Sipeed vision-module export (MaixPy) global tool: its OWN surface
      // (toolSipeedVision), never part of the build workflow. Stage A generates one task family
      // (YOLO detection over UART JSON Lines) into sipeed_vision/, so the form is deliberately
      // small: an optional MaixCAM model path and Generate. The HOST is the trust boundary — it
      // allowlists the task token and sanitizes the model path — and the run's own results land in
      // the Activity feed and the Artifacts tab like any other phase. -----
      // Every component is concatenated into ONE webview script, so top-level names are shared:
      // these use the svn* prefix because sv* already belongs to SaveVersionPanel (a redeclared
      // svStatusMsg would silently hijack that panel's status line).
      // Stage A's one pinned task token; the picker for the other families waits on the upstream
      // token list, so the webview never invents one.
      var SVN_VISION_TASK = "yolo_detection";
      var svnRunning = false;

      function svnStatusMsg(text) { const n = $("svnStatus"); if (n) n.textContent = text || ""; }

      // Opened from the global-tools bar: reset the surface to its idle state. No host round-trip —
      // there is nothing to load, and nothing is written until the user clicks Generate.
      function svnOnOpen() {
        svnSetRunning(false);
        svnStatusMsg("");
      }

      function svnSetRunning(on) {
        svnRunning = on;
        const btn = $("svnGenerate");
        if (btn) { btn.disabled = on; btn.textContent = tr(on ? "svn_generating" : "svn_generate"); }
      }

      function svnGenerate() {
        if (svnRunning) return; // the run owns the button until the host reports a terminal status
        svnSetRunning(true);
        svnStatusMsg(tr("svn_generating"));
        const model = $("svnModelPath");
        vscode.postMessage({
          type: "start_sipeed_vision",
          visionTaskType: SVN_VISION_TASK,
          modelPath: model ? model.value.trim() : "",
        });
        // Leave the tool surface for Activity, like the gen-driver run does. A tool surface hides
        // the feed AND the composer, so a run launched from behind it would show nothing — and an
        // overwrite confirm (a re-run over files the user has since edited) would render into the
        // hidden feed with no way to answer it, blocking the run forever.
        closeGlobalTool();
        setTab("activity");
      }

      // Terminal status from the host (done / partial / failed) plus a REASON code. The line is
      // localized here — the host never sends UI prose, so a zh session doesn't get an English
      // sentence. An unknown/absent reason falls back to the generic line for that status, so a
      // future host code degrades to a sensible message instead of rendering the raw token.
      // Always restores the button: a stuck "Generating…" would make the tool unusable for the
      // rest of the session.
      function onSipeedVisionStatus(msg) {
        svnSetRunning(false);
        const status = msg && msg.status;
        const reasonKey = "svn_reason_" + String((msg && msg.reason) || "");
        const reason = tr(reasonKey);
        if (reason !== reasonKey) { svnStatusMsg(reason); return; }
        svnStatusMsg(tr(status === "done" ? "svn_done" : status === "partial" ? "svn_partial" : "svn_failed"));
      }
