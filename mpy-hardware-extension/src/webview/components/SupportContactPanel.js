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
          if (c.copyable && c.value) row.appendChild(scButton("Copy", () => vscode.postMessage({ type: "copy_support_contact", contactId: c.id })));
          if (c.url) row.appendChild(scButton("Open", () => vscode.postMessage({ type: "open_external", url: c.url })));
          list.appendChild(row);
        }
        root.appendChild(list);
        const report = document.createElement("div"); report.className = "sc-report";
        // "Report an issue" toggles the form; collapsed by default to keep the panel tidy.
        const toggle = document.createElement("button"); toggle.className = "sc-report-toggle"; toggle.type = "button";
        toggle.textContent = "Report an issue"; toggle.setAttribute("aria-expanded", "false");
        report.appendChild(toggle);
        // Issue form (section 08 §6.3): pick a type, describe it, optionally leave contact. The
        // "Attach diagnostics" checkbox bundles the snapshot, so no manual field list is needed.
        // Submit hands the fields to the host, which validates and opens a prefilled issue URL.
        const form = document.createElement("div"); form.className = "sc-form hidden";
        const typeSel = document.createElement("select"); typeSel.className = "sc-type"; typeSel.id = "scIssueType";
        for (const t of msg.issueTypes || []) {
          const o = document.createElement("option"); o.value = t;
          o.textContent = t.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase()); // "feature_request" -> "Feature request"
          typeSel.appendChild(o);
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
        form.appendChild(typeSel); form.appendChild(desc); form.appendChild(contact); form.appendChild(attachWrap); form.appendChild(submit);
        toggle.addEventListener("click", () => {
          const open = !form.classList.toggle("hidden");
          toggle.setAttribute("aria-expanded", String(open));
          if (open) desc.focus();
        });
        report.appendChild(form);
        // GitHub Issues already has its own Open in the contact list above, so no button here.
        report.appendChild(scButton("Copy diagnostics", () => vscode.postMessage({ type: "request_diagnostics" })));
        // Local session logs (raw .jsonl transcript per run) for Skill debugging.
        report.appendChild(scButton("Reveal logs folder", () => vscode.postMessage({ type: "reveal_logs_folder" })));
        report.appendChild(scButton("Export full session log", () => vscode.postMessage({ type: "export_session_log" })));
        const logNote = document.createElement("p"); logNote.className = "gd-note";
        logNote.textContent = "Export includes the complete session transcript. Review before sharing.";
        report.appendChild(logNote);
        const diag = document.createElement("div"); diag.className = "gd-note"; diag.id = "scDiag";
        report.appendChild(diag);
        root.appendChild(report);
      }
