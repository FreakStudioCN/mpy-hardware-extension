      function setMode(mode) {
        selectedMode = mode === "custom" ? "custom" : "beginner";
        document.querySelectorAll(".mode-chip").forEach((b) => b.classList.toggle("active", b.dataset.mode === selectedMode));
        vscode.setState({ ...(vscode.getState() || {}), mode: selectedMode }); // remember across panel reopens
      }
      $("modeBeginner").addEventListener("click", () => setMode("beginner"));
      $("modeCustom").addEventListener("click", () => setMode("custom"));
      // restore the last-used mode across panel reopens (persisted in setMode)
      const savedMode = (vscode.getState() || {}).mode;
      if (savedMode) setMode(savedMode);
