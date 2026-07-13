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
        // Issue form (section 08 §6.3): pick a type, describe it, optionally leave contact.
        // Submit hands the fields to the host, which validates and opens a prefilled issue URL.
        const form = document.createElement("div"); form.className = "sc-form";
        const typeSel = document.createElement("select"); typeSel.className = "sc-type"; typeSel.id = "scIssueType";
        for (const t of msg.issueTypes || []) {
          const o = document.createElement("option"); o.value = t; o.textContent = t; typeSel.appendChild(o);
        }
        const desc = document.createElement("textarea"); desc.className = "sc-desc"; desc.id = "scIssueDesc"; desc.placeholder = "Describe the issue";
        const contact = document.createElement("input"); contact.className = "sc-contact"; contact.id = "scIssueContact"; contact.type = "text"; contact.placeholder = "Contact (optional)";
        const attachWrap = document.createElement("label"); attachWrap.className = "sc-attach";
        const attach = document.createElement("input"); attach.type = "checkbox"; attach.id = "scIssueAttach"; attach.checked = true;
        attachWrap.appendChild(attach); attachWrap.appendChild(document.createTextNode(" Attach diagnostics"));
        const submit = scButton("Submit issue report", () => vscode.postMessage({
          type: "submit_issue_report",
          issueType: typeSel.value,
          description: desc.value,
          contact: contact.value,
          attachDiagnostics: attach.checked,
        }));
        form.appendChild(typeSel); form.appendChild(desc); form.appendChild(attachWrap); form.appendChild(contact); form.appendChild(submit);
        report.appendChild(form);
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
