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
      function renderDoctor(items) {
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
          if (it.ports && it.ports.length) { const p = document.createElement("div"); p.className = "doc-hint"; p.textContent = it.ports.join(sep()); body.appendChild(p); }
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
      $("doctorRecheck").addEventListener("click", () => vscode.postMessage({ type: "run_doctor_check", probe: true }));
