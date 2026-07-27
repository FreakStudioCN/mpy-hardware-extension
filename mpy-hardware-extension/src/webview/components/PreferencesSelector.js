      function setMode(mode) {
        selectedMode = mode === "custom" ? "custom" : "beginner";
        // Scope to the experience-level chips ([data-mode]): the Save Version panel reuses .mode-chip
        // for its own save-method toggle (data-svmode, no data-mode), and a bare .mode-chip sweep
        // would strip its active/aria state on every setMode (incl. the load-time restore).
        document.querySelectorAll(".mode-chip[data-mode]").forEach((b) => {
          const selected = b.dataset.mode === selectedMode;
          b.classList.toggle("active", selected);
          b.setAttribute("aria-pressed", selected ? "true" : "false");
        });
        vscode.setState({ ...(vscode.getState() || {}), mode: selectedMode }); // remember across panel reopens
      }
      $("modeBeginner").addEventListener("click", () => setMode("beginner"));
      $("modeCustom").addEventListener("click", () => setMode("custom"));
      // restore the last-used mode across panel reopens (persisted in setMode)
      const savedMode = (vscode.getState() || {}).mode;
      if (savedMode) setMode(savedMode);
