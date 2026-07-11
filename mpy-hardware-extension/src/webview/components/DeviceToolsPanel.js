
      // ----- Device Tools global tool (#54): device file browser + mip install -----
      // Every action posts to the host, which refuses it while a session run owns the
      // serial port (device_busy) and serializes the rest (spec §41). The UI only
      // reflects results — device-supplied names go in via textContent (no HTML).
      function dtCurrentPath() { const n = $("dtPath"); return n ? n.value.trim() : ""; }
      function dtJoin(dir, name) { return dir ? dir.replace(/\/+$/, "") + "/" + name : name; }
      function dtParent(dir) { return dir.replace(/\/+$/, "").split("/").slice(0, -1).join("/"); }
      function dtStatus(text) { const n = $("dtStatus"); if (n) n.textContent = text || ""; }
      function dtListCurrent() { dtStatus(tr("dt_working")); vscode.postMessage({ type: "device_tool_list", path: dtCurrentPath() }); }

      // How long a Delete stays armed ("Confirm?") before disarming.
      var DT_CONFIRM_MS = 3000;

      // phase set => a session run owns the port; null hides the banner. While busy, disable
      // the controls too so a click can't queue a command that will just be refused.
      function dtSetBusy(phase) {
        const banner = $("dtBusy"); if (!banner) return;
        const busy = !!phase;
        document.querySelectorAll("#toolDeviceTools .dt-act, #toolDeviceTools .dt-input").forEach((el) => { el.disabled = busy; });
        if (!busy) { banner.classList.add("hidden"); return; }
        banner.textContent = tr("dt_busy", { p: phase });
        banner.classList.remove("hidden");
      }

      function dtActionButton(text, onClick) {
        const b = document.createElement("button"); b.type = "button"; b.className = "dt-act"; b.textContent = text;
        b.addEventListener("click", onClick); return b;
      }

      function dtRenderEntries(path, entries) {
        dtSetBusy(null);
        const host = $("dtEntries"); if (!host) return;
        const pathInput = $("dtPath"); if (pathInput) pathInput.value = path;
        host.innerHTML = "";
        const list = Array.isArray(entries) ? entries : [];
        $("dtEmpty").classList.toggle("hidden", list.length > 0);
        for (const name of list) {
          const row = document.createElement("div"); row.className = "dt-row";
          const label = document.createElement("span"); label.className = "dt-name"; label.textContent = name;
          const full = dtJoin(path, name);
          const dl = dtActionButton(tr("dt_download"), () => { dtStatus(tr("dt_working")); vscode.postMessage({ type: "device_tool_download", path: full }); });
          // Destructive: arm on the first click, delete on the second (auto-disarms).
          const del = dtActionButton(tr("dt_delete"), () => {
            if (del.dataset.armed) { dtStatus(tr("dt_working")); vscode.postMessage({ type: "device_tool_delete", path: full }); return; }
            del.dataset.armed = "1"; del.textContent = tr("dt_confirm_del");
            setTimeout(() => { if (del.isConnected) { delete del.dataset.armed; del.textContent = tr("dt_delete"); } }, DT_CONFIRM_MS);
          });
          del.classList.add("dt-del");
          row.append(label, dl, del); host.appendChild(row);
        }
      }

      // A post-mutation refresh re-lists the files WITHOUT touching the status, so the
      // "done"/"failed" message stays visible; a user-initiated List shows "Working…"
      // and clears it on the result.
      var dtSilentList = false;
      function dtRefreshSilently() { dtSilentList = true; vscode.postMessage({ type: "device_tool_list", path: dtCurrentPath() }); }

      function onDeviceToolResult(command, result) {
        dtSetBusy(null);
        if (command === "list") {
          dtRenderEntries((result && result.path) || "", result && result.entries);
          if (dtSilentList) dtSilentList = false; else dtStatus("");
          return;
        }
        dtStatus(tr("dt_ok", { c: command }));
        dtRefreshSilently(); // refresh the listing after any mutation, keeping the status
      }
      function onDeviceToolError(command, error) { dtSetBusy(null); dtStatus(tr("dt_err", { c: command, e: error })); }
      function onDeviceBusy(phase) { dtSetBusy(phase || tr("dt_busy_generic")); dtStatus(""); }

      // Controls live in the DOM at load (the tool-view is hidden, not removed).
      if ($("dtList")) {
        $("dtList").addEventListener("click", dtListCurrent);
        $("dtUp").addEventListener("click", () => { const p = $("dtPath"); if (p) p.value = dtParent(dtCurrentPath()); dtListCurrent(); });
        $("dtMkdir").addEventListener("click", () => {
          const name = $("dtNewName").value.trim(); if (!name) return;
          $("dtNewName").value = "";
          dtStatus(tr("dt_working"));
          vscode.postMessage({ type: "device_tool_mkdir", path: dtJoin(dtCurrentPath(), name) });
        });
        $("dtUpload").addEventListener("click", () => { dtStatus(tr("dt_working")); vscode.postMessage({ type: "device_tool_upload", dir: dtCurrentPath() }); });
        $("dtMipInstall").addEventListener("click", () => {
          const url = $("dtMipUrl").value.trim(); if (!url) return;
          dtStatus(tr("dt_installing")); // mip fetches on the host then copies to the board — can take a while
          vscode.postMessage({ type: "device_tool_mip", url, version: $("dtMipVersion").value.trim() });
        });
      }
