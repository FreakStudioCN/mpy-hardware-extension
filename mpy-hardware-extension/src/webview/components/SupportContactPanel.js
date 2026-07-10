      function scButton(label, action) {
        const b = document.createElement("button"); b.className = "sc-btn"; b.type = "button"; b.textContent = label;
        b.addEventListener("click", action);
        return b;
      }
      // SupportContactPanel: render the host-served (locale-ordered) contacts + a report-issue
      // section. Contacts are config-driven; copy/mailto/openExternal go through the host.
      function renderSupport(msg) {
        const root = $("support"); if (!root) return;
        $("supportEmpty").classList.add("hidden");
        root.innerHTML = "";
        const list = document.createElement("div"); list.className = "sc-list";
        for (const c of msg.contacts || []) {
          const row = document.createElement("div"); row.className = "sc-row";
          const label = document.createElement("span"); label.className = "sc-label"; label.textContent = c.label;
          const val = document.createElement("span"); val.className = "sc-val"; val.textContent = c.value || c.url || "";
          row.appendChild(label); row.appendChild(val);
          if (c.copyable && c.value) row.appendChild(scButton("Copy", () => vscode.postMessage({ type: "copy_code", text: c.value })));
          if (c.url) row.appendChild(scButton("Open", () => vscode.postMessage({ type: "open_external", url: c.url })));
          list.appendChild(row);
        }
        root.appendChild(list);
        const report = document.createElement("div"); report.className = "sc-report";
        const h = document.createElement("div"); h.className = "sc-report-h"; h.textContent = "Report an issue";
        const note = document.createElement("p"); note.className = "gd-note";
        note.textContent = "Please include diagnostics: " + (msg.diagnosticsFields || []).join(", ") + ".";
        report.appendChild(h); report.appendChild(note);
        const issues = (msg.contacts || []).find((c) => c.id === "github_issues");
        if (issues && issues.url) report.appendChild(scButton("Open GitHub Issues", () => vscode.postMessage({ type: "open_external", url: issues.url })));
        report.appendChild(scButton("Copy diagnostics", () => vscode.postMessage({ type: "request_diagnostics" })));
        // Local session logs (raw .jsonl transcript per run) for Skill debugging.
        report.appendChild(scButton("Reveal logs folder", () => vscode.postMessage({ type: "reveal_logs_folder" })));
        report.appendChild(scButton("Export session log", () => vscode.postMessage({ type: "export_session_log" })));
        const diag = document.createElement("div"); diag.className = "gd-note"; diag.id = "scDiag";
        report.appendChild(diag);
        root.appendChild(report);
      }
