
      // ----- Device Tools global tool (#54): device file browser + mip install -----
      // Every action posts to the host, which refuses it while a session run owns the
      // serial port (device_busy) and serializes the rest (spec §41). The UI only
      // reflects results — device-supplied names go in via textContent (no HTML).
      function dtCurrentPath() { const n = $("dtPath"); return n ? n.value.trim() : ""; }
      function dtJoin(dir, name) { return dir ? dir.replace(/\/+$/, "") + "/" + name : name; }
      // Navigate to an absolute device path and list it (auto-list — no List/Up buttons).
      function dtNavigate(path) {
        const abs = !path || path === "/" ? "/" : (path.charAt(0) === "/" ? path : "/" + path);
        const p = $("dtPath"); if (p) p.value = abs;
        dtListCurrent();
      }
      function dtCrumb(text, target) {
        const b = document.createElement("button"); b.type = "button"; b.className = "dt-crumb"; b.textContent = text;
        b.addEventListener("click", () => dtNavigate(target)); return b;
      }
      // Render the current path as clickable breadcrumbs: / › lib › drivers
      function dtRenderCrumbs(path) {
        const host = $("dtCrumbs"); if (!host) return;
        host.innerHTML = "";
        host.appendChild(dtCrumb("/", "/"));
        let prefix = "";
        for (const seg of (path || "").split("/").filter(Boolean)) {
          prefix += "/" + seg;
          host.appendChild(document.createTextNode(" › "));
          host.appendChild(dtCrumb(seg, prefix));
        }
      }
      function dtStatus(text) { const n = $("dtStatus"); if (n) n.textContent = text || ""; }
      function dtListCurrent() { dtStatus(tr("dt_working")); vscode.postMessage({ type: "device_tool_list", path: dtCurrentPath() }); }

      // How long a Delete stays armed ("Confirm?") before disarming.
      var DT_CONFIRM_MS = 3000;
      // One-shot delete nonces the host issued (path -> nonce). The first Delete click asks
      // the host to arm; the host replies with a nonce here; the confirm click echoes it so
      // the host can prove the two-step happened (a stale message carries no valid nonce).
      var dtDeleteNonces = {};
      // How often to re-check the device is still plugged in while the tab is open.
      var DT_POLL_MS = 2500;
      // Start "no device" (unknown) until a scan confirms one; the tab shows "plug in a
      // device" and reverts here when the board is unplugged.
      var dtNoDevice = true;

      function dtCheckDevice() { vscode.postMessage({ type: "device_presence" }); }
      // Set only by an explicit open of the Device Tools view (not the 2.5s poll): a model-issued
      // device op during a run mutates the device FS without going through the device_tool_* path
      // that self-refreshes, so the listing goes stale. Re-listing on open picks the change up
      // without an unplug/replug — and, being one-shot, does NOT make the poll re-list every tick.
      var dtRelistOnNextPresence = false;
      // While a run owns the port, opening the tool must not poll presence or re-list: the list
      // would be refused (device_busy) and a mid-run scan is unreliable. The listing is preserved
      // and refreshed by dtRefreshAfterRun on session_done.
      function dtOnOpen() { if (running) return; dtRelistOnNextPresence = true; dtCheckDevice(); }
      // A run just released the port. Only refresh if the tool is actually open (else the next
      // dtOnOpen handles it). Re-checks presence (shim.scan reconciles the cached port, so a board
      // that re-enumerated to a new port across the flash is healed, not left stale) and re-lists
      // the current path, so the browser recovers without an unplug/replug.
      function dtRefreshAfterRun() {
        dtSetBusy(null); // run released the port: re-enable controls + drop the busy banner now,
                         // not only when a later list result lands (PR #31 review, finding 2).
        const view = $("toolDeviceTools");
        if (!view || view.classList.contains("hidden")) return;
        dtRelistOnNextPresence = true;
        dtCheckDevice();
      }
      function dtShowNoDevice() {
        dtNoDevice = true;
        const entries = $("dtEntries"); if (entries) entries.innerHTML = "";
        const crumbs = $("dtCrumbs"); if (crumbs) crumbs.innerHTML = "";
        dtStatus("");
        const ui = $("dtDeviceUi"); if (ui) ui.classList.add("hidden"); // hide all controls (crumbs/add/mip)
        const nodev = $("dtNoDev"); if (nodev) nodev.classList.remove("hidden");
      }
      // Host reply to the presence poll: gone -> show the no-device state; came back -> list root.
      function onDevicePresent(present) {
        // Ignore presence entirely while a run owns the port: the board may reset/re-enumerate
        // mid-flash, so a transient absent must NOT wipe the listing to "no device". session_done
        // (dtRefreshAfterRun) is the safe point to re-check.
        if (running) return;
        if (!present) { dtShowNoDevice(); return; }
        const relist = dtRelistOnNextPresence; dtRelistOnNextPresence = false;
        if (dtNoDevice) { dtNoDevice = false; dtNavigate("/"); return; } // first detection lists root
        if (relist) dtListCurrent(); // re-opened with the board already present -> refresh current path
      }

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
        dtNoDevice = false;
        const ui = $("dtDeviceUi"); if (ui) ui.classList.remove("hidden"); // show controls again
        const nodev = $("dtNoDev"); if (nodev) nodev.classList.add("hidden");
        dtRenderCrumbs(path);
        const host = $("dtEntries"); if (!host) return;
        const pathInput = $("dtPath"); if (pathInput) pathInput.value = path;
        host.innerHTML = "";
        const list = Array.isArray(entries) ? entries : [];
        $("dtEmpty").classList.toggle("hidden", list.length > 0);
        // mpremote fs ls marks a directory with a trailing "/" (serve.py). Folders are
        // click-to-descend; files carry download/delete.
        for (const raw of list) {
          const isDir = raw.charAt(raw.length - 1) === "/";
          const name = isDir ? raw.slice(0, -1) : raw;
          const full = dtJoin(path, name);
          const row = document.createElement("div"); row.className = "dt-row" + (isDir ? " dt-dir" : "");
          if (isDir) {
            const nav = document.createElement("button"); nav.type = "button"; nav.className = "dt-name dt-navbtn"; nav.textContent = name + "/";
            nav.addEventListener("click", () => dtNavigate(full));
            row.appendChild(nav);
          } else {
            const label = document.createElement("span"); label.className = "dt-name"; label.textContent = name;
            const dl = dtActionButton(tr("dt_download"), () => { dtStatus(tr("dt_working")); vscode.postMessage({ type: "device_tool_download", path: full }); });
            // Destructive: the first click asks the host to ARM (it issues a one-shot nonce;
            // nothing is deleted yet); the confirm click echoes the nonce so the host can
            // enforce the two-step. Auto-disarms and drops the nonce after DT_CONFIRM_MS.
            const del = dtActionButton(tr("dt_delete"), () => {
              if (del.dataset.armed && dtDeleteNonces[full]) {
                dtStatus(tr("dt_working"));
                vscode.postMessage({ type: "device_tool_delete", path: full, nonce: dtDeleteNonces[full] });
                delete dtDeleteNonces[full];
                return;
              }
              del.dataset.armed = "1"; del.textContent = tr("dt_confirm_del");
              vscode.postMessage({ type: "device_tool_delete", path: full }); // bare = arm request
              setTimeout(() => { if (del.isConnected) { delete del.dataset.armed; del.textContent = tr("dt_delete"); } delete dtDeleteNonces[full]; }, DT_CONFIRM_MS);
            });
            del.classList.add("dt-del");
            row.append(label, dl, del);
          }
          host.appendChild(row);
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
      function onDeviceToolError(command, error) {
        dtSetBusy(null);
        // A command that failed because the board is gone -> revert to the no-device state
        // immediately (don't wait for the next poll), instead of a confusing error.
        if (/device_unavailable|no device|could not open|failed to access/i.test(String(error))) { dtShowNoDevice(); return; }
        dtStatus(tr("dt_err", { c: command, e: error }));
      }
      function onDeviceBusy(phase) { dtSetBusy(phase || tr("dt_busy_generic")); dtStatus(""); }
      // Host armed a delete: keep its one-shot nonce so the confirm click can echo it back.
      function onDeviceDeleteArmed(path, nonce) { dtDeleteNonces[path] = nonce; }

      // ----- Package browser: search standard sources + install onto the board -----
      // Auto = local catalog (graftsense already stripped host-side), uPyPI = live search
      // (name+url, resolved to metadata on select), MicroPython-lib = pending its backend,
      // GitHub = advanced raw-URL fallback only. All upstream strings go in via textContent.
      function dtPkgSel() { const n = $("dtPkgSource"); return n ? n.value : "auto"; }
      function dtPkgClear() {
        const r = $("dtPkgResults"); if (r) r.innerHTML = "";
        const d = $("dtPkgDetail"); if (d) { d.innerHTML = ""; d.classList.add("hidden"); }
      }
      function dtPkgSearch() {
        const source = dtPkgSel();
        dtPkgClear();
        if (source === "github") { // fallback is raw-URL only, not searchable
          const adv = $("dtPkgAdv"); if (adv) adv.open = true;
          const r = $("dtPkgResults"); if (r) r.textContent = tr("dt_pkg_github_hint");
          const u = $("dtMipUrl"); if (u) u.focus();
          return;
        }
        const query = ($("dtPkgQuery") ? $("dtPkgQuery").value : "").trim();
        const r = $("dtPkgResults"); if (r) r.textContent = tr("dt_pkg_searching");
        vscode.postMessage({ type: "package_search", source: source, query: query });
      }
      function dtPkgRow(pkg, onClick) {
        const row = document.createElement("button");
        row.type = "button"; row.className = "dt-pkg-row";
        const name = document.createElement("span"); name.className = "dt-pkg-name";
        name.textContent = pkg.name + (pkg.version ? " " + pkg.version : "");
        row.appendChild(name);
        if (pkg.description) { const d = document.createElement("span"); d.className = "dt-pkg-desc"; d.textContent = pkg.description; row.appendChild(d); }
        row.addEventListener("click", onClick);
        return row;
      }
      function onPackageSearchResult(source, results) {
        const host = $("dtPkgResults"); if (!host) return;
        host.innerHTML = "";
        const list = Array.isArray(results) ? results : [];
        if (!list.length) { host.textContent = tr("dt_pkg_none"); return; }
        for (const pkg of list) {
          // uPyPI search gives name+url only -> resolve on click; local hits are full records.
          const onClick = (source === "upypi")
            ? () => vscode.postMessage({ type: "package_resolve", url: pkg.url })
            : () => dtShowPkgDetail(pkg);
          host.appendChild(dtPkgRow(pkg, onClick));
        }
      }
      function onPackageSearchError() { const h = $("dtPkgResults"); if (h) h.textContent = tr("dt_pkg_err"); }
      function onPackageResolveResult(record) { if (record) dtShowPkgDetail(record); }
      function onPackageResolveError() { const h = $("dtPkgResults"); if (h) h.textContent = tr("dt_pkg_err"); }

      function dtDetailLine(label, value) {
        if (!value) return null;
        const line = document.createElement("div"); line.className = "dt-pkg-kv";
        const k = document.createElement("span"); k.className = "dt-pkg-k"; k.textContent = label;
        const v = document.createElement("span"); v.className = "dt-pkg-v"; v.textContent = value;
        line.append(k, v); return line;
      }
      // uPyPI/local records install from their package.json url; a bare micropython-lib name
      // installs by name. GitHub uses the advanced raw-URL input, not this path.
      function dtPkgInstallUrl(pkg) { return pkg.source === "micropython_lib" ? pkg.name : (pkg.package_json_url || pkg.name); }
      function dtShowPkgDetail(pkg) {
        const host = $("dtPkgDetail"); if (!host) return;
        host.innerHTML = ""; host.classList.remove("hidden");
        const title = document.createElement("div"); title.className = "dt-pkg-title";
        title.textContent = pkg.name + (pkg.version ? " " + pkg.version : "");
        host.appendChild(title);
        if (pkg.description) { const d = document.createElement("div"); d.className = "dt-pkg-desc"; d.textContent = pkg.description; host.appendChild(d); }
        const chips = pkg.chips && pkg.chips !== "all" ? pkg.chips : "";
        const fw = pkg.fw && pkg.fw !== "all" ? pkg.fw : "";
        const deps = Array.isArray(pkg.deps) && pkg.deps.length ? String(pkg.deps.length) : "";
        const url = dtPkgInstallUrl(pkg);
        for (const [label, value] of [["Author", pkg.author], ["License", pkg.license], ["Chips", chips], ["Firmware", fw], ["Depends", deps], ["Install", pkg.install_cmd || ("mpremote mip install " + url)]]) {
          const line = dtDetailLine(label, value); if (line) host.appendChild(line);
        }
        const install = dtActionButton(tr("dt_pkg_install"), () => {
          if (dtNoDevice) { dtStatus(tr("dt_nodev_h")); return; }
          dtStatus(tr("dt_installing"));
          vscode.postMessage({ type: "device_tool_mip", url: url, version: "" });
        });
        install.classList.add("dt-pkg-install");
        host.appendChild(install);
      }

      // Controls live in the DOM at load (the tool-view is hidden, not removed).
      if ($("dtPath")) {
        $("dtPath").addEventListener("keydown", (e) => { if (e.key === "Enter") dtListCurrent(); }); // fallback path entry
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
        if ($("dtPkgSearch")) $("dtPkgSearch").addEventListener("click", dtPkgSearch);
        if ($("dtPkgQuery")) $("dtPkgQuery").addEventListener("keydown", (e) => { if (e.key === "Enter") dtPkgSearch(); });
        if ($("dtPkgSource")) $("dtPkgSource").addEventListener("change", () => {
          dtPkgClear();
          if (dtPkgSel() === "github") { const adv = $("dtPkgAdv"); if (adv) adv.open = true; }
        });
        // Poll device presence only while the tab is open, so the file list reflects an
        // unplug within a couple of seconds (the scan is a host-side port list — no port open).
        setInterval(() => {
          const view = $("toolDeviceTools");
          // Skip while a run owns the port: scan is `mpremote connect list`, which would compete
          // with the run's own mpremote use, and an esp32-c6 re-enumerates on flash, so a transient
          // empty result would wrongly wipe the listing to "no device". Refresh on session_done.
          if (view && !view.classList.contains("hidden") && !running) dtCheckDevice();
        }, DT_POLL_MS);
      }
