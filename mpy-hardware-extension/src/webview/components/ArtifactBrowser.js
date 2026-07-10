
      // ----- Artifact Browser (spec 8.3) -----
      // The session's artifacts, grouped by phase. The host sends a RELATIVE-path index
      // (never absolute paths); a row click asks the host to open the file, which maps the
      // relative path back to an absolute one — the trust boundary lives in the host, not here.
      const BYTES_PER_KB = 1024;
      const SHA_DISPLAY_LEN = 8;
      let ARTIFACTS = [];
      let artifactPhase = ""; // "" = all phases
      let artifactsLinkShown = false; // one "View artifacts" jump per session
      // A one-time affordance in the Activity feed to jump to the Artifacts tab, so the user
      // can open/trace produced files straight from the timeline (card #36).
      function addArtifactsLink() {
        if (artifactsLinkShown) return;
        artifactsLinkShown = true;
        const card = document.createElement("div");
        card.className = "ev fade-in";
        card.innerHTML = '<div class="ev-card"><div class="ev-main"><div class="ev-label"><span class="kind">' + tr("kind_result") + '</span></div></div></div>';
        const btn = document.createElement("button");
        btn.className = "doc-fix";
        btn.textContent = tr("view_artifacts");
        btn.addEventListener("click", () => setTab("artifacts"));
        card.querySelector(".ev-main").appendChild(btn);
        $("activity").appendChild(card);
      }
      function renderArtifacts(list) {
        ARTIFACTS = Array.isArray(list) ? list : [];
        if (artifactPhase && !ARTIFACTS.some((a) => a.phase === artifactPhase)) artifactPhase = "";
        drawArtifacts();
      }
      function drawArtifacts() {
        const box = $("artifacts"); if (!box) return;
        box.innerHTML = "";
        $("artifactFilter").innerHTML = "";
        if (!ARTIFACTS.length) { $("artifactsEmpty").classList.remove("hidden"); return; }
        $("artifactsEmpty").classList.add("hidden");
        drawArtifactFilter();
        const rows = ARTIFACTS.filter((a) => !artifactPhase || a.phase === artifactPhase);
        for (const a of rows) box.appendChild(artifactRow(a));
      }
      function drawArtifactFilter() {
        const phases = [...new Set(ARTIFACTS.map((a) => a.phase).filter(Boolean))];
        if (phases.length < 2) return; // nothing to filter by
        const filter = $("artifactFilter");
        filter.appendChild(artifactChip(tr("art_all_phases"), ""));
        for (const p of phases) filter.appendChild(artifactChip(p, p));
      }
      function artifactChip(label, phase) {
        const chip = document.createElement("button");
        chip.className = "art-chip" + (artifactPhase === phase ? " active" : "");
        chip.type = "button";
        chip.textContent = label;
        chip.addEventListener("click", () => { artifactPhase = phase; drawArtifacts(); });
        return chip;
      }
      function artifactRow(a) {
        const row = document.createElement("button");
        row.className = "art-row";
        row.type = "button";
        // Wiring and diagram have their own rendered tabs; a browser row for them jumps
        // there (reusing renderWiring/renderDiagram) instead of opening the raw JSON.
        const isTabKind = a.kind === "wiring" || a.kind === "diagram";
        row.title = tr(isTabKind ? "art_open_tab" : (a.is_binary ? "art_reveal" : "art_open"));
        // Inline preview for images (svg/png): the host attaches a webview-safe URI
        // (asWebviewUri) that loads under the CSP img-src; still no filesystem path here.
        if (a.webview_uri) {
          const thumb = document.createElement("img");
          thumb.className = "art-thumb"; thumb.src = a.webview_uri; thumb.alt = "";
          row.appendChild(thumb);
        }
        const kind = document.createElement("span"); kind.className = "art-kind"; kind.textContent = a.kind;
        const path = document.createElement("span"); path.className = "art-path"; path.textContent = a.relative_path;
        const meta = document.createElement("span"); meta.className = "art-meta"; meta.textContent = artifactMeta(a);
        row.append(kind, path, meta);
        // Distinguish files found on disk (a reopened project) from this session's output.
        if (a.origin === "disk") {
          const tag = document.createElement("span"); tag.className = "art-tag"; tag.textContent = tr("art_on_disk");
          row.append(tag);
        }
        row.addEventListener("click", () => {
          if (isTabKind) setTab(a.kind);
          else vscode.postMessage({ type: "open_artifact", relative_path: a.relative_path });
        });
        return row;
      }
      function artifactMeta(a) {
        // spec 8.3: show role, size, sha256, created_at (path is the row's main text).
        const parts = [];
        if (a.role) parts.push(a.role);
        if (typeof a.size === "number") parts.push(formatBytes(a.size));
        if (a.sha256) parts.push(a.sha256.slice(0, SHA_DISPLAY_LEN));
        if (a.created_at) parts.push(a.created_at.slice(0, 10)); // YYYY-MM-DD from the ISO stamp
        return parts.join(" · ");
      }
      function formatBytes(n) {
        if (n < BYTES_PER_KB) return n + " B";
        if (n < BYTES_PER_KB * BYTES_PER_KB) return (n / BYTES_PER_KB).toFixed(1) + " KB";
        return (n / (BYTES_PER_KB * BYTES_PER_KB)).toFixed(1) + " MB";
      }
