
      // ----- Git History global tool (spec 3.6.3): READ-ONLY commit timeline + per-file diffs +
      // uncommitted changes. Its OWN surface (toolGitHistory). Open -> ask the host
      // (git_history_open -> git_history_data); expand a commit (git_history_commit ->
      // git_history_commit_data, lazy — no N git calls at open); view a file's diff
      // (git_history_diff -> git_history_diff_data). The HOST is the trust boundary (hash/path are
      // validated there); the webview only renders + posts, and every host/git string goes in via
      // textContent, never innerHTML. -----
      var GH_DIFF_LINE_MAX = 2000;   // cap a huge patch so it can't lock the webview; show "+N more"
      var ghCommitFileHosts = {};    // hash -> the <div> holding that commit's file rows (lazy fill)
      var ghCommitLoaded = {};       // hash -> true once its file list has been fetched

      function ghStatusMsg(text) { const n = $("ghStatus"); if (n) n.textContent = text || ""; }
      function ghBlock(heading, sub) {
        const body = $("ghBody"); if (body) body.classList.add("hidden");
        const bl = $("ghBlocked"); if (bl) bl.classList.remove("hidden");
        const h = $("ghBlockedH"); if (h) h.textContent = heading || "";
        const p = $("ghBlockedP"); if (p) p.textContent = sub || "";
        ghStatusMsg("");
      }
      function ghUnblock() {
        const bl = $("ghBlocked"); if (bl) bl.classList.add("hidden");
        const body = $("ghBody"); if (body) body.classList.remove("hidden");
      }

      // Opened from the global-tools bar: reset the render and ask the host for the timeline.
      function ghOnOpen() {
        ghCommitFileHosts = {}; ghCommitLoaded = {};
        const diff = $("ghDiffWrap"); if (diff) diff.classList.add("hidden");
        ghBlock(tr("gh_loading"), "");
        vscode.postMessage({ type: "git_history_open" });
      }

      // Map a git status letter to the badge color kind (reuses the Save Version badge CSS classes).
      function ghStatusKind(letter) {
        return letter === "A" ? "added" : letter === "D" ? "deleted" : letter === "R" ? "renamed"
          : letter === "M" ? "modified" : (letter === "U" || letter === "?") ? "new" : "changed";
      }
      // A color-coded letter badge + path row. textContent only (git-supplied paths are never HTML).
      function ghFileRow(status, path, onClick) {
        const row = document.createElement("div"); row.className = "ask-file gh-file";
        const badge = document.createElement("span"); badge.className = "ask-file-badge ask-file-badge-" + ghStatusKind(status);
        badge.textContent = status || "•";
        const name = document.createElement("span"); name.className = "ask-file-path"; name.textContent = path == null ? "" : String(path);
        row.appendChild(badge); row.appendChild(name);
        if (onClick) { row.classList.add("gh-clickable"); row.addEventListener("click", onClick); }
        return row;
      }

      // Uncommitted section: the working-tree changes (status --porcelain, parsed host-side). An
      // untracked file (badge U) has no `diff HEAD` output, so it is shown but not diff-clickable.
      function ghRenderUncommitted(d) {
        const host = $("ghUncommitted"); if (!host) return;
        host.innerHTML = "";
        const files = (d && d.uncommitted && Array.isArray(d.uncommitted.files)) ? d.uncommitted.files : [];
        const total = (d && d.uncommitted && typeof d.uncommitted.fileTotal === "number") ? d.uncommitted.fileTotal : files.length;
        const clean = $("ghClean"); if (clean) clean.classList.toggle("hidden", total > 0);
        host.classList.toggle("hidden", total === 0);
        for (const f of files) {
          const untracked = f && f.badge === "U";
          host.appendChild(ghFileRow(f && f.badge, f && f.name, untracked ? null : () => ghRequestDiff(undefined, f && f.name)));
        }
        ghAppendMore(host, total, files.length);
      }
      function ghAppendMore(host, total, shown) {
        if (total > shown) { const more = document.createElement("div"); more.className = "sv-art-more"; more.textContent = tr("sv_artifacts_more", { n: String(total - shown) }); host.appendChild(more); }
      }

      // YYYY-MM-DD from the ISO-8601 %aI author date.
      function ghShortDate(iso) { const s = iso ? String(iso) : ""; return s.length >= 10 ? s.slice(0, 10) : s; }

      // The commit timeline. Each row expands (lazily fetching its file list) into per-file rows,
      // each of which opens that file's diff.
      function ghRenderCommits(d) {
        const host = $("ghCommits"); if (!host) return;
        host.innerHTML = "";
        const commits = (d && Array.isArray(d.commits)) ? d.commits : [];
        const total = (d && typeof d.commitTotal === "number") ? d.commitTotal : commits.length;
        const none = $("ghNoCommits"); if (none) none.classList.toggle("hidden", total > 0);
        host.classList.toggle("hidden", total === 0);
        for (const c of commits) host.appendChild(ghCommitRow(c));
      }
      function ghCommitRow(c) {
        const hash = (c && c.hash) ? String(c.hash) : "";
        const wrap = document.createElement("div"); wrap.className = "gh-commit";
        const head = document.createElement("div"); head.className = "gh-commit-head gh-clickable";
        const subject = document.createElement("span"); subject.className = "gh-commit-subject"; subject.textContent = (c && c.subject) || "";
        const meta = document.createElement("span"); meta.className = "gh-commit-meta";
        meta.textContent = [(c && c.shortHash) || "", (c && c.author) || "", ghShortDate(c && c.date)].filter(Boolean).join("  ·  ");
        head.appendChild(subject); head.appendChild(meta);
        // Phase/artifact association from the session snapshot saved at this commit (latest-save-only).
        const assoc = c && c.snapshot;
        if (assoc) {
          const parts = [];
          if (assoc.phase) parts.push(tr("gh_assoc_phase", { p: String(assoc.phase) }));
          if (typeof assoc.artifact_total === "number" && assoc.artifact_total > 0) parts.push(tr("gh_assoc_artifacts", { n: String(assoc.artifact_total) }));
          if (parts.length) { const chip = document.createElement("span"); chip.className = "gh-commit-assoc"; chip.textContent = parts.join("  ·  "); head.appendChild(chip); }
        }
        const files = document.createElement("div"); files.className = "gh-commit-files hidden";
        ghCommitFileHosts[hash] = files;
        head.addEventListener("click", () => ghToggleCommit(hash, files));
        wrap.appendChild(head); wrap.appendChild(files);
        return wrap;
      }
      function ghToggleCommit(hash, filesEl) {
        const willShow = filesEl.classList.contains("hidden");
        filesEl.classList.toggle("hidden", !willShow);
        if (willShow && !ghCommitLoaded[hash]) {
          filesEl.textContent = tr("gh_loading");
          vscode.postMessage({ type: "git_history_commit", hash });
        }
      }
      function onGitHistoryCommitData(m) {
        const hash = (m && m.hash) ? String(m.hash) : "";
        const host = ghCommitFileHosts[hash]; if (!host) return;
        ghCommitLoaded[hash] = true;
        host.innerHTML = "";
        const files = (m && Array.isArray(m.files)) ? m.files : [];
        if (!files.length) { host.textContent = tr("gh_no_files"); return; }
        for (const f of files) host.appendChild(ghFileRow(f && f.status, f && f.path, () => ghRequestDiff(hash, f && f.path)));
      }

      // Ask the host for one file's patch. hash present => that commit's diff; absent => the
      // uncommitted working-tree diff (git_history_diff with no hash).
      function ghRequestDiff(hash, path) {
        if (!path) return;
        const wrap = $("ghDiffWrap"); if (wrap) wrap.classList.remove("hidden");
        const head = $("ghDiffHead"); if (head) head.textContent = (hash ? String(hash).slice(0, 8) : tr("gh_working")) + "  " + String(path);
        const body = $("ghDiff"); if (body) body.textContent = tr("gh_loading");
        const msg = { type: "git_history_diff", path: String(path) };
        if (hash) msg.hash = hash;
        vscode.postMessage(msg);
      }

      // WI-5 diff renderer: classify each patch line by its leading char, one div per line via
      // textContent (never HTML), capped so a huge patch can't lock the webview.
      function ghDiffLineClass(line) {
        if (line.indexOf("@@") === 0) return "gh-diff-hunk";
        if (line.indexOf("diff ") === 0 || line.indexOf("index ") === 0 || line.indexOf("--- ") === 0 || line.indexOf("+++ ") === 0) return "gh-diff-meta";
        if (line.charAt(0) === "+") return "gh-diff-add";
        if (line.charAt(0) === "-") return "gh-diff-del";
        return "gh-diff-ctx";
      }
      function onGitHistoryDiffData(m) {
        const body = $("ghDiff"); if (!body) return;
        body.innerHTML = "";
        const text = (m && typeof m.diff === "string") ? m.diff : "";
        if (!text) { body.textContent = tr("gh_no_diff"); return; }
        const lines = text.split("\n");
        const shown = Math.min(lines.length, GH_DIFF_LINE_MAX);
        for (let i = 0; i < shown; i++) {
          const div = document.createElement("div"); div.className = "gh-diff-line " + ghDiffLineClass(lines[i]);
          div.textContent = lines[i];
          body.appendChild(div);
        }
        ghAppendMore(body, lines.length, shown);
      }

      // Version summary line: branch + commit count (the "version summary" the spec asks for).
      function ghRenderSummary(d) {
        const host = $("ghSummary"); if (!host) return;
        const parts = [];
        if (d && d.branch) parts.push(tr("gh_branch", { b: String(d.branch) }));
        if (d && typeof d.commitTotal === "number") parts.push(tr("gh_commit_count", { n: String(d.commitTotal) }));
        host.textContent = parts.join("  ·  ");
        host.classList.toggle("hidden", parts.length === 0);
      }

      // Host reply with the timeline. No repo -> never offer git init (spec :343): show the
      // not-a-repo note (the saved-snapshot list is layered in by WI-3).
      function onGitHistoryData(d) {
        d = d || {};
        if (!d.repoPresent) { ghBlock(tr("gh_no_repo_h"), d.note || tr("gh_no_repo_p")); return; }
        ghUnblock();
        ghStatusMsg("");
        const diff = $("ghDiffWrap"); if (diff) diff.classList.add("hidden");
        ghRenderSummary(d);
        ghRenderUncommitted(d);
        ghRenderCommits(d);
      }
      function onGitHistoryStatus(s) {
        const status = s && s.status;
        if (status === "workspace_unavailable") { ghBlock(tr("gh_noworkspace_h"), tr("gh_noworkspace_p")); return; }
        if (status === "git_unavailable") { ghBlock(tr("gh_gitunavail_h"), tr("gh_gitunavail_p")); return; }
        if (status === "invalid_request") { ghStatusMsg(tr("gh_invalid")); return; }
      }
