
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
          const img = document.createElement("img"); img.className = "partner-logo"; img.src = p.logo; img.alt = p.name;
          img.addEventListener("error", () => { a.textContent = p.name; });
          a.appendChild(img);
          a.addEventListener("click", () => vscode.postMessage({ type: "open_external", url: p.url }));
          row.appendChild(a);
        }
        root.appendChild(h); root.appendChild(row);
      }
      // Read-only list of past session summaries (host-served from .mpyhw/sessions).
      // Clicking a card reveals its session.jsonl via the host's open_path handler.
      function renderRecent(sessions) {
        const box = $("recent"); if (!box) return;
        box.innerHTML = "";
        const empty = $("recentEmpty");
        if (!sessions || !sessions.length) { empty.classList.remove("hidden"); return; }
        empty.classList.add("hidden");
        for (const s of sessions) {
          const card = document.createElement("button"); card.className = "recent-card"; card.type = "button";
          const title = document.createElement("span"); title.className = "recent-intent"; title.textContent = s.intent || s.id;
          const meta = document.createElement("span"); meta.className = "recent-meta";
          const when = s.date ? new Date(s.date).toLocaleString() : "";
          meta.textContent = s.finalPhase ? (when + " · " + s.finalPhase) : when;
          card.appendChild(title); card.appendChild(meta);
          card.addEventListener("click", () => vscode.postMessage({ type: "open_path", path: s.path }));
          box.appendChild(card);
        }
      }
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
        const diag = document.createElement("div"); diag.className = "gd-note"; diag.id = "scDiag";
        report.appendChild(diag);
        root.appendChild(report);
      }
