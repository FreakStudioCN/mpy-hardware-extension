
      // ----- Activity -----
      function isInternalActivity(text) {
        return /^ask_user:/.test(text) || /^Agent session /.test(text) || /^→\s*\w+/.test(text);
      }
      function classifyActivity(text) {
        if (/^→/.test(text)) return "tool";
        if (/fail|error|crash|exhaust/i.test(text)) return "error";
        if (/generated|finished|done|success|ready|complete/i.test(text)) return "result";
        if (/loaded skill|skill:/i.test(text)) return "skill";
        return "thinking";
      }
      const ICONS = { thinking: "•", skill: "•", tool: "•", result: "•", error: "•", note: "•" };
      let currentThink = null; // open thinking card's text node, or null
      let currentThinkCard = null; // the open thinking card element (live = spinner + heading), or null
      let terminalShown = false; // guards the once-per-session terminal line (session_done is posted twice on cancel: optimistic + loop-unwind)
      let currentCode = null;  // open streaming code card { pre, host, path }, or null
      let currentSummary = null; // open streaming reply card { card, sum, raw }, or null
      // In-feed "working" indicator. After a user action (confirm plan / answer) the
      // next visible event is the LLM's first token, which can be seconds away — an
      // empty feed reads as a hang. setPending drops an immediate spinner card; the
      // heartbeat ticks its label, and any real content clears it.
      let pendingCard = null, pendingLabel = "";
      function setPending(label) {
        // Arming the working spinner settles any open thinking card. Every other
        // transition already pairs the two (addSummary, the approval handlers,
        // session_done); this one appended its card and left the thinking card live, so
        // an uncategorized status line followed by a phase_start put two spinners on
        // screen at once.
        finalizeThinking();
        pendingLabel = label;
        if (!pendingCard) {
          $("activityEmpty").classList.add("hidden");
          pendingCard = document.createElement("div");
          pendingCard.className = "ev fade-in feed-pending";
          pendingCard.innerHTML = '<div class="ev-card"><div class="ev-head"><div class="ev-ico thinking"><span class="feed-spin"></span></div><div class="ev-main"><div class="ev-think pending-label"></div></div></div></div>';
          $("activity").appendChild(pendingCard);
        }
        pendingCard.querySelector(".pending-label").textContent = label;
      }
      function clearPending() { if (pendingCard) { pendingCard.remove(); pendingCard = null; } }
      // Settle the open thinking card: spinner -> dot, drop the "Thinking" heading. Called
      // whenever the thinking stream closes (a non-thinking event, code/summary, or reset).
      function finalizeThinking() {
        if (currentThinkCard) {
          const ico = currentThinkCard.querySelector(".ev-ico");
          if (ico) { ico.classList.remove("think-live"); ico.textContent = ICONS.thinking; }
          const head = currentThinkCard.querySelector(".think-head");
          if (head) head.remove();
        }
        currentThink = currentThinkCard = null;
      }
      function prefillImportedRecipe(payload) {
        const prompt = String((payload && (payload.prompt || payload.starter_prompt || payload.intent)) || "").trim();
        if (!prompt) return;
        $("intent").value = prompt;
        autosizeIntent();
        setTab("activity");
        clearPending();
        addActivity({ text: "Recipe imported from website. Review the prompt, then Generate." });
        $("intent").focus();
      }
      // Map a trace event to a working-spinner label: only a recognized tool name
      // yields a curated, localized phase string; anything else (including raw
      // prose in ev.text) falls back to the neutral label — chain-of-thought can't
      // leak through here.
      function phaseLabel(ev) {
        const key = ev && ev.toolName ? "tp_" + ev.toolName : "";
        return (key && tr(key) !== key) ? tr(key) : tr("working");
      }
      // Render a safe subset of markdown (headings, bullets, ordered lists, bold,
      // inline code, paragraphs). HTML is escaped first, so LLM output cannot
      // inject markup — the regexes only re-introduce our own tags.
      function escapeHtml(s) {
        return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      }
      function mdInline(s) {
        return s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
                .replace(/`([^`]+)`/g, "<code>$1</code>");
      }
      function renderMarkdown(src) {
        const out = []; let list = null;
        const close = () => { if (list) { out.push("</" + list + ">"); list = null; } };
        const open = (tag) => { if (list !== tag) { close(); out.push("<" + tag + ">"); list = tag; } };
        for (const raw of escapeHtml(src).split("\n")) {
          const t = raw.trim();
          if (!t) { close(); continue; }
          let m;
          if (m = t.match(/^#{1,6}\s+(.*)$/)) { close(); out.push('<div class="md-h">' + mdInline(m[1]) + "</div>"); continue; }
          if (m = t.match(/^\d+\.\s+(.*)$/)) { open("ol"); out.push("<li>" + mdInline(m[1]) + "</li>"); continue; }
          if (m = t.match(/^[-*](?!\*)\s*(.+)$/)) { open("ul"); out.push("<li>" + mdInline(m[1]) + "</li>"); continue; }
          close(); out.push("<div>" + mdInline(t) + "</div>");
        }
        close();
        return out.join("");
      }
      // Steady-rate typewriter. feed() appends text to reveal char-by-char into `el`
      // (plain text while typing); end() swaps in rendered markdown once the reveal
      // catches up. Streamed text (summary deltas, code deltas) and atomic text (a
      // question or plan written in one shot) all flow through it, so everything
      // types out at a uniform cadence. Without requestAnimationFrame (jsdom tests)
      // it renders the full text synchronously, so the DOM is complete at once.
      //   opts.cpms       — reveal rate in chars/ms (default 0.7 ≈ 700/s).
      //   opts.maxBacklog — when buffered-but-unshown text exceeds this many chars,
      //                     stop pacing and jump to the end. The text is already
      //                     here, so revealing a big block slowly would only add lag
      //                     (e.g. a whole file landing in one burst). Default: no cap.
      //   opts.settle     — committer for end(): default renders markdown; code
      //                     passes a plain-text settler so its #/* aren't parsed.
      function makeTypewriter(el, opts) {
        opts = opts || {};
        const animated = typeof requestAnimationFrame === "function";
        const CPMS = opts.cpms || 0.7; // chars per ms — faster than the model generates
        const maxBacklog = opts.maxBacklog || Infinity;
        const commit = opts.settle || ((node, text) => { node.innerHTML = renderMarkdown(text); });
        let target = "", shown = 0, raf = null, last = 0, ended = false, stopped = false;
        const settle = () => { commit(el, target); };
        function frame(ts) {
          if (stopped) { raf = null; return; }
          if (!last) { last = ts; raf = requestAnimationFrame(frame); return; }
          shown = Math.min(target.length, shown + Math.max(1, Math.round(CPMS * (ts - last))));
          if (target.length - shown > maxBacklog) shown = target.length; // burst: skip the wait
          last = ts;
          el.textContent = target.slice(0, shown);
          if (shown < target.length) { raf = requestAnimationFrame(frame); return; }
          raf = null; last = 0;
          if (ended) settle();
        }
        const pump = () => { if (animated && raf === null && shown < target.length) { last = 0; raf = requestAnimationFrame(frame); } };
        return {
          feed(t) {
            target += (t == null ? "" : String(t));
            if (!animated) { el.textContent = target; return; }
            pump();
          },
          end(finalText) {
            if (finalText != null) target = String(finalText);
            ended = true;
            if (!animated || shown >= target.length) { if (raf === null) settle(); }
            else pump();
          },
          // Halt the reveal without committing — used when the caller is about to
          // replace `el` (the code card swaps its <pre> for highlighted rows).
          stop() { stopped = true; },
        };
      }
      function addUserMessage(text) {
        $("activityEmpty").classList.add("hidden");
        const card = document.createElement("div");
        card.className = "ev fade-in";
        card.innerHTML = '<div class="ev-card"><div class="ev-head"><div class="ev-ico result">•</div><div class="ev-main"><div class="ev-label"><span class="kind">' + tr("kind_user") + '</span></div><div class="ev-sum"></div></div></div></div>';
        card.querySelector(".ev-sum").textContent = text;
        $("activity").appendChild(card);
      }
      // Open an empty result card with a typewriter bound to its prose element.
      function openSummaryCard() {
        $("activityEmpty").classList.add("hidden");
        const card = document.createElement("div");
        card.className = "ev fade-in";
        card.innerHTML = '<div class="ev-card"><div class="ev-head"><div class="ev-ico result">•</div><div class="ev-main"><div class="ev-label"><span class="kind">' + tr("kind_summary") + '</span></div><div class="ev-sum"></div></div></div></div>';
        $("activity").appendChild(card);
        return { card, tw: makeTypewriter(card.querySelector(".ev-sum")) };
      }
      // A token of the model's reply: feed the open card's typewriter, opening one
      // on the first token. The text types out char-by-char; addSummary() ends it.
      function streamSummaryDelta(text) {
        clearPending();
        finalizeThinking();
        if (!currentSummary) currentSummary = openSummaryCard();
        currentSummary.tw.feed(text);
      }
      // The agent's final reply. Ends the open card's typewriter (typing out any
      // remaining buffered text, then rendering markdown). A non-streamed path
      // (template loop) lands here with no open card and types the whole thing.
      function addSummary(text) {
        const t = (text == null ? "" : String(text)).trim();
        if (!t) { discardSummary(); return; }
        finalizeThinking(); clearPending();
        if (!currentSummary) currentSummary = openSummaryCard();
        currentSummary.tw.end(t);
        currentSummary = null;
      }
      // Drop the in-progress streamed reply: its turn called a tool, so the prose
      // was mid-process narration, not the final answer.
      function discardSummary() {
        if (currentSummary) { currentSummary.card.remove(); currentSummary = null; }
      }
      // Seal the in-progress streamed reply instead of dropping it: ask_user's
      // lead-in prose stays on screen (typewriter finishes, then renders markdown)
      // above the question card that follows.
      function sealSummary() {
        if (currentSummary) { currentSummary.tw.end(); currentSummary = null; }
      }
      function addActivity(ev, forcedKind) {
        const text = (ev && typeof ev.text === "string") ? ev.text : JSON.stringify(ev);
        if (!text) return;
        if (isInternalActivity(text)) return;
        clearPending();
        $("activityEmpty").classList.add("hidden");
        // forcedKind lets a discrete event (e.g. a user note) render as its own card
        // instead of being text-classified and coalesced into the open thinking stream.
        const kind = forcedKind || classifyActivity(text);
        // The agent streams thinking token-by-token (each delta is its own
        // trace_event). Coalesce consecutive thinking deltas into one growing
        // card instead of a new card per token.
        if (kind === "thinking") {
          if (currentThink) { currentThink.textContent += text; return; }
          // Only LIVE (spinner + "Thinking" heading) while a build is running — an
          // uncategorized line that lands after the session ends (e.g. "Session ended:
          // Stopped") must render static, or its spinner would never settle.
          const live = running;
          const card = document.createElement("div");
          card.className = "ev fade-in";
          const ico = live ? '<div class="ev-ico thinking think-live"><span class="feed-spin"></span></div>' : '<div class="ev-ico thinking">' + ICONS.thinking + "</div>";
          const head = live ? '<div class="ev-label think-head"><span class="kind">' + tr("kind_thinking") + "</span></div>" : "";
          card.innerHTML = '<div class="ev-card"><div class="ev-head">' + ico + '<div class="ev-main">' + head + '<div class="ev-think"></div></div></div></div>';
          currentThink = card.querySelector(".ev-think");
          currentThinkCard = live ? card : null; // only a live card needs finalizing
          currentThink.textContent = text;
          $("activity").appendChild(card);
          return;
        }
        finalizeThinking(); // any non-thinking event closes + settles the open stream
        const card = document.createElement("div");
        card.className = "ev fade-in";
        const ico = '<div class="ev-ico ' + kind + '">' + ICONS[kind] + "</div>";
        if (kind === "tool") {
          card.innerHTML = '<div class="ev-card"><div class="ev-head">' + ico + '<div class="ev-main"><div class="ev-label"><span class="kind">' + tr("kind_tool") + '</span><span class="ev-tool"></span></div></div></div></div>';
          card.querySelector(".ev-tool").textContent = text.replace(/^→\s*/, "");
        } else {
          const cls = kind === "error" ? " is-error" : "";
          const label = kind === "result" ? tr("kind_result") : kind === "skill" ? tr("kind_skill") : kind === "note" ? tr("kind_note") : tr("kind_error");
          card.innerHTML = '<div class="ev-card"><div class="ev-head">' + ico + '<div class="ev-main"><div class="ev-label"><span class="kind">' + label + '</span></div><div class="ev-sum' + cls + '"></div></div></div></div>';
          card.querySelector(".ev-sum").innerHTML = renderMarkdown(text);
        }
        $("activity").appendChild(card);
      }

      // One-click retry after a transport failure (llm_unreachable / interrupted
      // stream). The host kept the session state, so retry_session re-issues the
      // interrupted turn; the button disables itself so it can't double-fire.
      function addRetryCard() {
        const card = document.createElement("div");
        card.className = "ev fade-in";
        const btn = document.createElement("button");
        btn.className = "retry-session";
        btn.textContent = tr("retry_btn");
        btn.addEventListener("click", () => {
          btn.disabled = true;
          setTab("activity"); setRunning(true);
          vscode.postMessage({ type: "retry_session" });
        });
        card.appendChild(btn);
        $("activity").appendChild(card);
      }

      // Per-phase credit line (card #87). The backend streams a credits frame per turn, most
      // of them free, so a line per frame floods the feed. Instead we accumulate the frames of
      // one phase and emit ONE rolled-up line at the phase boundary — the same shape the
      // diagnostics export uses ("generate: 4 credits over 3 turns, N left"), off the SAME
      // events the quota bar consumes, so feed / bar / diagnostics never disagree.
      // Label: the specific operation (generate/deploy/gen_driver/...) when it has its own cost
      // family, else the canonical phase instead of the generic "phase" bucket token. Both are
      // WIRE tokens, so they go through the cl_* display table before being shown — the host
      // stamps the phase canonicalized (PHASE_ALIASES), and for scaffold/flash that canonical
      // form IS a plugin id (upy-scaffold-plugin), which must never reach the feed.
      // Cleared by clearConversation() on Restart — see the accumulator note there.
      // Host->webview frames are async: a stamped session_event already in flight when
      // the user hits Restart lands AFTER clearConversation() and would repopulate the
      // just-cleared credit accumulator. Each session_event carries the host run
      // `generation`; on Restart the webview DRAINS every stamped frame until the host
      // echoes the reset (session_reset), which by FIFO arrives after the last old-gen
      // frame and before the first new-gen one — so even the first frame of a session
      // whose generation the webview never saw is dropped, not folded in.
      let acceptGen = -1;         // stamped session_events with generation <= acceptGen are stale stragglers
      let drainingFrames = false; // Restart issued; drop stamped frames until the host confirms the reset
      function sessionEventIsStale(msg) {
        if (typeof msg.generation !== "number") return false; // unstamped (old host / balance fetch): unchanged
        if (drainingFrames) return true;                       // between Restart and the host's session_reset
        return msg.generation <= acceptGen;                    // a straggler from an already-closed session
      }
      function markSessionEventsStale() { drainingFrames = true; }
      function onSessionReset(generation) {
        if (typeof generation === "number") acceptGen = generation - 1;
        drainingFrames = false;
      }
      let creditAccum = null;
      function creditToken(usage) {
        return usage.operation && usage.operation !== "phase" ? usage.operation : (usage.phase || usage.operation);
      }
      // Same idiom as phaseLabel(): a curated, localized name when we have one, else the raw
      // token — a phase we have not named yet degrades to its identifier rather than to "".
      function creditLabel(token) {
        const key = "cl_" + token;
        return tr(key) !== key ? tr(key) : token;
      }
      // Fold one credits frame into the current phase's tally. A label change (a new phase, or a
      // retry/supplement turn that is its own cost line) flushes the prior tally first.
      function accumulateCreditUsage(usage, balance) {
        if (!usage) return;
        // Group by the WIRE token, not the display name: two tokens could share a display
        // string, and the name is resolved at flush so a locale switch mid-phase still renders
        // the line in the language the user is now reading.
        const token = creditToken(usage);
        if (creditAccum && creditAccum.token !== token) flushCreditUsage();
        if (!creditAccum) creditAccum = { token, turns: 0, credits: 0, known: 0, remaining: undefined };
        creditAccum.turns += 1;
        // Sum only known costs; a pre-baseline turn (no balance diff, no server charge) counts as
        // a turn but not as 0 credits.
        const spent = usage.charged != null ? usage.charged : usage.credits_consumed;
        if (spent != null) { creditAccum.credits += spent; creditAccum.known += 1; }
        const remaining = usage.remaining_quota != null ? usage.remaining_quota : balance;
        if (remaining != null) creditAccum.remaining = remaining;
      }
      // Emit the rolled-up line and reset. Idempotent: a second call (session_done posts twice on
      // cancel) is a no-op. Skipped when no turn had a known cost — a summary must not read a free
      // phase where every number was simply missing.
      function flushCreditUsage() {
        const g = creditAccum;
        creditAccum = null;
        if (!g || g.known === 0) return;
        const u = tr(g.turns === 1 ? "credit_turns_one" : "credit_turns_many");
        const cu = tr(g.credits === 1 ? "credit_one" : "credit_many");
        const line = tr("credit_line", { o: creditLabel(g.token), c: g.credits, t: g.turns, u, cu });
        // Append the balance clause ONLY when we have one: tr() substitutes with
        // String.split().join(), and join(undefined) falls back to "," — an absent {r}
        // would render a stray comma rather than nothing.
        const tail = g.remaining != null ? tr("credit_remaining", { r: g.remaining }) : "";
        addActivity({ text: line + tail }, "note");
      }
      // Drop the in-flight tally WITHOUT emitting it. Restart wipes the conversation this
      // tally belongs to, and the accumulator outlives the feed DOM — leaving it populated
      // folds the discarded session's credits into the next session's first line.
      function discardCreditUsage() {
        creditAccum = null;
      }

      // Fallback-save notice: no workspace was open, so the project went to the
      // extension's globalStorage dir. Show where, with a button that asks the host
      // to reveal it in the OS file manager (button → host action, like the doctor).
      function addSavedLocation(path) {
        if (!path) return;
        clearPending();
        $("activityEmpty").classList.add("hidden");
        finalizeThinking();
        const card = document.createElement("div");
        card.className = "ev fade-in";
        card.innerHTML = '<div class="ev-card"><div class="ev-head"><div class="ev-ico result">' + ICONS.result + '</div><div class="ev-main"><div class="ev-label"><span class="kind">' + tr("kind_result") + '</span></div><div class="ev-sum"></div></div></div></div>';
        card.querySelector(".ev-sum").textContent = tr("saved_location", { p: path });
        const btn = document.createElement("button");
        btn.className = "doc-fix";
        btn.textContent = tr("open_folder_btn");
        btn.addEventListener("click", () => vscode.postMessage({ type: "open_path", path }));
        card.querySelector(".ev-main").appendChild(btn);
        $("activity").appendChild(card);
      }
