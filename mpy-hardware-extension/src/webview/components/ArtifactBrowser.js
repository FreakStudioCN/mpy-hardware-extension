
      // ----- Code (streamed live into the activity feed) -----
      // No separate Code tab: codegen streams into the activity feed as a growing
      // block, then lands as a real .py file in the workspace (opened in the editor).
      function codeRowsInto(host, code) {
        host.innerHTML = "";
        highlightLines(code.replace(/\n$/, "")).forEach((toks, i) => {
          const row = document.createElement("div"); row.className = "code-row";
          const gut = document.createElement("div"); gut.className = "code-gut"; gut.textContent = String(i + 1);
          const src = document.createElement("div"); src.className = "code-src";
          toks.forEach((t) => { const s = document.createElement("span"); if (t.cls) s.className = t.cls; s.textContent = t.text; src.appendChild(s); });
          row.append(gut, src); host.appendChild(row);
        });
      }
      // Append a codegen token to the open code card, or open a new one (one card
      // per file — multi-file projects get a card each).
      function streamCodeDelta(text, path) {
        clearPending();
        const file = path || "main.py";
        const scroll = () => { const w = $("activity").parentElement; w.scrollTop = w.scrollHeight; };
        if (currentCode && currentCode.path === file) { currentCode.raw += text; currentCode.tw.feed(text); currentCode.card.__code = currentCode.raw; return; }
        finalizeThinking(); // a code stream closes any open thinking card
        $("activityEmpty").classList.add("hidden");
        const card = document.createElement("div");
        card.className = "ev fade-in";
        // Code card: filename + Copy header, then the code body (raw <pre> while
        // streaming, swapped for highlighted line-numbered rows on finalize).
        card.innerHTML = '<div class="ev-card code-card"><div class="code-card-head">' +
          '<span class="code-file"><svg width="13" height="13" viewBox="0 0 24 24" fill="none"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M14 3v5h5" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg><span class="code-name"></span></span>' +
          '<button class="code-copy" type="button">' + tr("copy") + '</button>' +
          '</div><div class="ev-code"><pre class="code-pre"></pre></div></div>';
        card.querySelector(".code-name").textContent = file;
        const pre = card.querySelector(".code-pre");
        // Reveal code through the typewriter like the summary, so it streams at a
        // smooth cadence instead of jumping in whatever chunks the upstream sends.
        // Faster than prose (code is dense + skimmed), and a burst cap so a whole
        // file landing at once doesn't drag. Settles as plain text — never markdown.
        const tw = makeTypewriter(pre, scroll, { cpms: 2, maxBacklog: 500, settle: (node, t) => { node.textContent = t; } });
        tw.feed(text);
        card.__code = text; // full source for the Copy button (survives finalize)
        const copyBtn = card.querySelector(".code-copy");
        copyBtn.addEventListener("click", () => {
          vscode.postMessage({ type: "copy_code", text: card.__code || "" });
          copyBtn.textContent = tr("copied"); copyBtn.classList.add("done");
          setTimeout(() => { copyBtn.textContent = tr("copy"); copyBtn.classList.remove("done"); }, 1500);
        });
        $("activity").appendChild(card);
        currentCode = { card, pre, tw, raw: text, path: file };
        scroll();
      }
      // Finalize the open code card: swap the raw stream for syntax-highlighted,
      // line-numbered rows. Handles a code_updated with no preceding deltas.
      function finalizeCode(code, path) {
        const file = path || "main.py";
        if (!currentCode || currentCode.path !== file) streamCodeDelta("", file);
        if (!currentCode) return;
        currentCode.tw.stop(); // halt any in-flight reveal; we're replacing the <pre>
        currentCode.card.__code = code; // Copy uses the finalized source
        const block = document.createElement("div");
        block.className = "code-block";
        codeRowsInto(block, code);
        currentCode.pre.replaceWith(block);
        currentCode = null;
      }

      // ----- Serial -----
      function serialClass(line) {
        if (/^MPY:|MicroPython|\[boot\]/.test(line)) return "boot";
        if (/\bi2c\b|0x[0-9a-f]{2}|SSD1306|AHT|found/i.test(line)) return "i2c";
        if (/alert|warn|>|threshold|ON\b/i.test(line)) return "alert";
        if (/ok|complete|ready|MPYHW_READY/i.test(line)) return "ok";
        return "";
      }
      function addSerial(lines) {
        $("serialEmpty").classList.add("hidden");
        $("serialFilled").classList.remove("hidden");
        $("serialHead").classList.add("live");
        const host = $("serial");
        (lines || []).forEach((line) => {
          const row = document.createElement("div"); row.className = "serial-line " + serialClass(line);
          const txt = document.createElement("span"); txt.className = "txt"; txt.textContent = line;
          row.appendChild(txt); host.appendChild(row);
        });
        host.parentElement.scrollTop = host.parentElement.scrollHeight;
        markNew("serial");
        // live pulse on the Serial tab
        const tabBtn = document.querySelector('.tab[data-tab="serial"]');
        if (tabBtn && !tabBtn.querySelector(".pulse")) { const p = document.createElement("span"); p.className = "pulse"; tabBtn.appendChild(p); }
      }
