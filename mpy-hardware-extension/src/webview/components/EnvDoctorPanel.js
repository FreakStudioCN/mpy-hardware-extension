      // ----- host messages (protocol unchanged) -----
      // ----- Environment doctor -----
      // Turns each raw error_kind into an actionable, localized hint line so the user
      // never sees a bare machine code (python_not_found, device_unavailable, …).
      const DOC_HINTS = {
        en: {
          python_not_found: "Install Python 3.10+ and reopen VS Code.",
          shim_dependency_install_failed: "If it keeps failing, set a pip mirror in mpyhw.pipIndexUrl.",
          device_unavailable: "Check the USB cable and the serial driver (CP210x/CH340). If the board is new, flash MicroPython firmware first.",
          device_selection_required: "Unplug the extra boards, or pick one to use.",
          device_scan_failed: "Replug the board and click Re-check.",
          no_micropython: "Flash MicroPython with the link below, then re-check.",
        },
        zh: {
          python_not_found: "安装 Python 3.10+ 后重开 VS Code。",
          shim_dependency_install_failed: "若反复失败，可在 mpyhw.pipIndexUrl 设置 pip 镜像。",
          device_unavailable: "检查 USB 线和串口驱动（CP210x/CH340）。若是新板，请先刷入 MicroPython 固件。",
          device_selection_required: "拔掉多余开发板，或选择一块使用。",
          device_scan_failed: "重新插拔开发板后点「重新检测」。",
          no_micropython: "用下面的链接刷好 MicroPython，然后重新检测。",
        },
      };
      function docHint(kind) { const m = DOC_HINTS[LOCALE] || DOC_HINTS.en; return m[kind] || DOC_HINTS.en[kind] || ""; }
      const DOC_ICON = { ok: "✓", warn: "⚠", error: "✗" };
      // The port the user just clicked in the Env selector, awaiting the host's
      // device_selected confirmation (message-bus.js) before triggering a re-check. The
      // NEXT device_selected resolves this pick — even when it carries a different port
      // than the one clicked (the clicked port can vanish and get reassigned by the host).
      // A pick that never gets a device_selected at all (session_error, a cancelled
      // QuickPick) is a known ceiling documented in message-bus.js, not fixed here.
      let pendingEnvPick = null;
      // Builds the clickable port list. selectedPort, when given, marks the port currently in
      // use and stays enabled so the user can switch to another. A click posts select_device
      // and waits for the host's device_selected before re-checking — the host sets the port
      // asynchronously, so re-checking right after the click would race it. The deploy/flash
      // confirmation cards reach the same shim.setPort by their own reply, never this message.
      function buildPortSelector(ports, selectedPort) {
        const p = document.createElement("div"); p.className = "doc-ports";
        ports.forEach((port) => {
          const b = document.createElement("button");
          b.className = port === selectedPort ? "ask-opt chosen" : "ask-opt";
          b.type = "button"; b.textContent = port;
          b.addEventListener("click", () => {
            pendingEnvPick = port;
            p.querySelectorAll(".ask-opt").forEach((x) => { x.disabled = true; });
            b.classList.add("chosen");
            vscode.postMessage({ type: "select_device", port });
          });
          p.appendChild(b);
        });
        return p;
      }
      function renderDoctor(items) {
        // Results are in — stop the Re-check refresh icon spinning. Cleared before the shape
        // guard so a malformed payload can't strand the spin.
        $("doctorRecheck").classList.remove("spinning");
        if (!Array.isArray(items)) return;
        const view = $("doctor");
        view.innerHTML = "";
        for (const it of items) {
          const row = document.createElement("div");
          row.className = "doc-row doc-" + (it.status || "warn");
          const ico = document.createElement("span");
          ico.className = "doc-ico";
          ico.textContent = DOC_ICON[it.status] || "•";
          row.appendChild(ico);
          const body = document.createElement("div");
          body.className = "doc-body";
          const msg = document.createElement("div");
          msg.className = "doc-msg";
          msg.textContent = tr(it.messageKey) + (it.detail ? " · " + it.detail : "");
          body.appendChild(msg);
          const hintText = it.errorKind ? docHint(it.errorKind) : "";
          if (hintText) { const h = document.createElement("div"); h.className = "doc-hint"; h.textContent = hintText; body.appendChild(h); }
          const okWithPorts = it.status === "ok" && it.ports && it.ports.length && it.selectedPort;
          if (it.ports && it.ports.length && it.errorKind === "device_selection_required") {
            body.appendChild(buildPortSelector(it.ports, null));
          } else if (it.ports && it.ports.length && !okWithPorts) {
            // Defensive fallback: a future errorKind carrying ports still gets a readable
            // (non-clickable) list instead of silently dropping it. The connected-with-ports
            // case is handled by the "change board" action below, not here.
            const p = document.createElement("div"); p.className = "doc-hint"; p.textContent = it.ports.join(sep()); body.appendChild(p);
          }
          if (okWithPorts) {
            // Connected, but several ports are present: a "change board" button reveals the
            // selector (current port marked, the others clickable) so the user can switch
            // without unplugging. Lives in the body (below the connected line) so it can't
            // collide with the row heading. One-shot: it removes itself once the selector shows.
            const change = document.createElement("button");
            change.className = "doc-change"; change.type = "button"; change.textContent = tr("doc_change_board");
            change.addEventListener("click", () => {
              change.remove();
              body.appendChild(buildPortSelector(it.ports, it.selectedPort));
            });
            body.appendChild(change);
          }
          row.appendChild(body);
          const actions = document.createElement("div");
          actions.className = "doc-actions";
          if (it.action === "install_deps") {
            const btn = document.createElement("button");
            btn.className = "doc-fix";
            btn.textContent = tr("doc_install");
            btn.addEventListener("click", () => {
              btn.disabled = true; btn.textContent = tr("doc_installing");
              vscode.postMessage({ type: "doctor_action", action: "install_deps" });
            });
            actions.appendChild(btn);
          }
          if (it.link) {
            const a = document.createElement("a");
            a.className = "doc-link";
            a.setAttribute("href", it.link);
            a.setAttribute("target", "_blank");
            a.textContent = tr(it.id === "python" ? "doc_link_python" : it.id === "micropython" ? "doc_link_firmware" : "doc_open");
            actions.appendChild(a);
          }
          if (actions.children.length) row.appendChild(actions);
          view.appendChild(row);
        }
        $("doctorEmpty").classList.toggle("hidden", items.length > 0);
      }
      // Re-check is the explicit opt-in for the invasive MicroPython probe (it enters the
      // board's REPL); the on-load check stays non-invasive and skips it.
      $("doctorRecheck").addEventListener("click", () => {
        // Spin the refresh icon until the fresh results land (renderDoctor clears it). The
        // doctor always resolves with items, so the spin can't get stuck on a normal run.
        $("doctorRecheck").classList.add("spinning");
        vscode.postMessage({ type: "run_doctor_check", probe: true });
      });
