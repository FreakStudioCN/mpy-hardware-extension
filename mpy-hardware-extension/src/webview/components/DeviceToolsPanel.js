
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
      function dtFilesStatus(text) { const n = $("dtFilesStatus"); if (n) n.textContent = text || ""; }
      function dtPkgStatus(text) { const n = $("dtPkgStatus"); if (n) n.textContent = text || ""; }
      function dtListCurrent() { dtFilesStatus(tr("dt_working")); vscode.postMessage({ type: "device_tool_list", path: dtCurrentPath() }); }

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
        const inst = $("dtPkgInstalled"); if (inst) inst.innerHTML = "";
        dtInstalledSet = new Set(); // drop a stale installed set so it can't mislabel after a different board replugs
        // Reset the in-flight guard here (not only in the success branch): the device-gone error
        // path returns before onDeviceToolError's clear, so without this an unplug-during-install
        // sticks dtInstallInFlight=true and every later Install/Uninstall silently no-ops.
        if (dtActiveInstall) { dtActiveInstall.status.classList.remove("installing"); dtActiveInstall = null; }
        dtInstallInFlight = false;
        dtFilesStatus(""); dtPkgStatus(""); // clear BOTH so a stale "Installing…" can't survive an unplug/replug
        const ui = $("dtDeviceUi"); if (ui) ui.classList.add("hidden"); // hide all controls (crumbs/add/mip)
        const nodev = $("dtNoDev"); if (nodev) nodev.classList.remove("hidden");
      }
      // Host reply to the presence poll: gone -> show the no-device state; came back -> list root.
      function onDevicePresent(present, ports) {
        // Ignore presence entirely while a run owns the port: the board may reset/re-enumerate
        // mid-flash, so a transient absent must NOT wipe the listing to "no device". session_done
        // (dtRefreshAfterRun) is the safe point to re-check.
        if (running) return;
        if (!present) { dtLastPortSig = ""; dtShowNoDevice(); return; }
        const sig = Array.isArray(ports) ? ports.slice().sort().join("|") : "";
        // A board SWAP between polls (ports changed while never reporting zero) must drop the prior
        // board's installed state, or Uninstall would delete a same-named module off the new board.
        // (Port identity: a same-port A->B swap is indistinguishable; catches the common COM3->COM7.)
        const swapped = !!dtLastPortSig && !!sig && sig !== dtLastPortSig;
        dtLastPortSig = sig;
        const relist = dtRelistOnNextPresence || swapped; dtRelistOnNextPresence = false;
        if (dtNoDevice) { dtNoDevice = false; dtNavigate("/"); dtRefreshInstalled(); return; } // first detection lists root + seeds the installed set
        if (relist) {
          // A swap must drop the prior board's installed state immediately (set + rendered rows),
          // so no stale Uninstall row can be actioned before the new board's list_lib lands.
          if (swapped) { dtInstalledSet = new Set(); dtInstalledNamesAll = []; const inst = $("dtPkgInstalled"); if (inst) inst.innerHTML = ""; }
          dtListCurrent(); dtRefreshInstalled(); // refresh files AND the installed set for the (new) board
        }
      }

      // phase set => a session run owns the port; null hides the banner. While busy, disable
      // the controls too so a click can't queue a command that will just be refused.
      function dtSetBusy(phase) {
        const banner = $("dtBusy"); if (!banner) return;
        const busy = !!phase;
        document.querySelectorAll("#toolDeviceTools .dt-act, #toolDeviceTools .dt-input, #toolDeviceTools .dt-pkg-seg").forEach((el) => { el.disabled = busy; });
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
            const dl = dtActionButton(tr("dt_download"), () => { dtFilesStatus(tr("dt_working")); vscode.postMessage({ type: "device_tool_download", path: full }); });
            // Destructive: the first click asks the host to ARM (it issues a one-shot nonce;
            // nothing is deleted yet); the confirm click echoes the nonce so the host can
            // enforce the two-step. Auto-disarms and drops the nonce after DT_CONFIRM_MS.
            const del = dtActionButton(tr("dt_delete"), () => {
              if (del.dataset.armed && dtDeleteNonces[full]) {
                dtFilesStatus(tr("dt_working"));
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

      var DT_INSTALL_CMDS = { mip_install: true, uninstall: true };
      function onDeviceToolResult(command, result) {
        dtSetBusy(null);
        if (command === "list") {
          dtRenderEntries((result && result.path) || "", result && result.entries);
          if (dtSilentList) dtSilentList = false; else dtFilesStatus("");
          return;
        }
        if (command === "list_lib") { onInstalledList(result && result.entries); return; }
        if (DT_INSTALL_CMDS[command]) { dtFinishInstall(command); dtRefreshSilently(); dtRefreshInstalled(); return; } // /lib changed
        dtFilesStatus(tr("dt_ok", { c: command }));
        dtRefreshSilently(); // refresh the listing after any mutation, keeping the status
      }
      // An install/uninstall result updates the card that started it: clear the bar, show the
      // outcome, and flip its button (Install <-> Uninstall). No card (Advanced-box install)
      // falls back to the Packages section status.
      function dtFinishInstall(command) {
        const ctx = dtActiveInstall; dtActiveInstall = null; dtInstallInFlight = false;
        const installed = command === "mip_install";
        if (!ctx) { dtPkgStatus(tr(installed ? "dt_pkg_installed" : "dt_pkg_removed")); return; }
        ctx.status.classList.remove("installing");
        ctx.status.textContent = tr(installed ? "dt_pkg_installed" : "dt_pkg_removed");
        dtSetInstallButton(ctx.btn, installed);
      }
      function onDeviceToolError(command, error) {
        dtSetBusy(null);
        // A command that failed because the board is gone -> revert to the no-device state
        // immediately (don't wait for the next poll), instead of a confusing error.
        if (/device_unavailable|no device|could not open|failed to access/i.test(String(error))) { dtShowNoDevice(); return; }
        if (command === "list_lib") { onInstalledError(error); return; }
        if (DT_INSTALL_CMDS[command]) {
          const ctx = dtActiveInstall; dtActiveInstall = null; dtInstallInFlight = false;
          // Restore the button to the UNCHANGED state (a failed uninstall is still installed, a
          // failed install still not) so it doesn't stick at "Confirm?" and silently re-arm.
          if (ctx) { ctx.status.classList.remove("installing"); ctx.status.textContent = tr("dt_err", { c: command, e: error }); dtSetInstallButton(ctx.btn, command === "uninstall"); }
          else dtPkgStatus(tr("dt_err", { c: command, e: error }));
          return;
        }
        dtFilesStatus(tr("dt_err", { c: command, e: error }));
      }
      function onDeviceBusy(phase) {
        dtSetBusy(phase || tr("dt_busy_generic")); dtFilesStatus(""); dtPkgStatus("");
        if (dtActiveInstall) { dtActiveInstall.status.classList.remove("installing"); dtActiveInstall.status.textContent = ""; dtActiveInstall = null; }
        dtInstallInFlight = false;
      }
      // Host armed a delete: keep its one-shot nonce so the confirm click can echo it back.
      function onDeviceDeleteArmed(path, nonce) { dtDeleteNonces[path] = nonce; }

      // ----- Package browser: search standard sources + install onto the board -----
      // Auto = live micropython-lib + uPyPI merged (host-side), uPyPI = live search (name+url,
      // resolved to metadata on expand), MicroPython-lib = official index (full records). The
      // raw GitHub/mip URL lives only in the Advanced box. Each result carries its own `source`,
      // so the accordion resolves uPyPI hits and fills lib hits directly. Upstream strings go
      // in via textContent.
      function dtPkgSel() { const n = $("dtPkgSource"); return n ? n.value : "auto"; }
      function dtPkgClear() {
        const r = $("dtPkgResults"); if (r) r.innerHTML = "";
      }
      function dtPkgSearch() {
        const source = dtPkgSel();
        dtPkgClear();
        const query = ($("dtPkgQuery") ? $("dtPkgQuery").value : "").trim();
        const r = $("dtPkgResults"); if (r) r.textContent = tr("dt_pkg_searching");
        dtPendingSearch = { query: query, source: source }; // correlate the reply (drop a stale one)
        vscode.postMessage({ type: "package_search", source: source, query: query });
      }
      // Results are an accordion (one row open at a time), paginated at DT_PKG_PAGE_SIZE per page.
      var DT_PKG_PAGE_SIZE = 10;
      var dtExpandedBody = null;       // the currently expanded item's detail body
      var dtPendingResolve = null;     // { body, url } of the uPyPI item awaiting its package.json resolve
      var dtPendingSearch = null;      // { query, source } of the in-flight search (drop stale replies)
      var dtLastPortSig = "";          // sorted port signature of the present board (detect a swap)
      var dtActiveInstall = null; // { status, btn } of the card whose install/uninstall is running
      var dtInstallInFlight = false; // one install/uninstall at a time (device is serialized) so a
                                     // second click can't overwrite dtActiveInstall and flip the wrong card
      var dtPkgResultsAll = [];        // full result set; one page slice is rendered at a time
      var dtPkgPage = 0;

      function onPackageSearchResult(source, results, query) {
        // Drop a stale reply: a slower older query/source must not overwrite the newer one the
        // input now shows (uncorrelated responses race, e.g. "bmp" landing after "aio").
        const p = dtPendingSearch;
        if (p && ((query != null && query !== p.query) || (source != null && source !== p.source))) return;
        dtPkgResultsAll = Array.isArray(results) ? results : [];
        dtPkgPage = 0;
        dtRenderPkgPage();
      }
      function dtRenderPkgPage() {
        const host = $("dtPkgResults"); if (!host) return;
        host.innerHTML = ""; dtExpandedBody = null; dtPendingResolve = null; dtActiveInstall = null; // a page change collapses all
        if (!dtPkgResultsAll.length) { host.textContent = tr("dt_pkg_none"); return; }
        const pages = Math.ceil(dtPkgResultsAll.length / DT_PKG_PAGE_SIZE);
        dtPkgPage = Math.min(Math.max(dtPkgPage, 0), pages - 1);
        const start = dtPkgPage * DT_PKG_PAGE_SIZE;
        for (const pkg of dtPkgResultsAll.slice(start, start + DT_PKG_PAGE_SIZE)) host.appendChild(dtPkgItem(pkg));
        if (pages > 1) host.appendChild(dtPager(dtPkgPage, pages, (p) => { dtPkgPage = p; dtRenderPkgPage(); }));
      }
      // Shared prev/next pager: goTo(newPage) re-renders. Used by search results + installed.
      function dtPager(page, pages, goTo) {
        const pager = document.createElement("div"); pager.className = "dt-pkg-pager";
        const prev = document.createElement("button"); prev.type = "button"; prev.className = "dt-pager-btn"; prev.textContent = "‹";
        prev.disabled = page === 0;
        prev.addEventListener("click", () => goTo(page - 1));
        const label = document.createElement("span"); label.className = "dt-pkg-page"; label.textContent = tr("dt_pkg_page", { n: page + 1, t: pages });
        const next = document.createElement("button"); next.type = "button"; next.className = "dt-pager-btn"; next.textContent = "›";
        next.disabled = page >= pages - 1;
        next.addEventListener("click", () => goTo(page + 1));
        pager.append(prev, label, next);
        return pager;
      }
      function onPackageSearchError() { const h = $("dtPkgResults"); if (h) { h.innerHTML = ""; h.textContent = tr("dt_pkg_err"); } }

      // ----- Installed packages view: the real installed set, read from the board's /lib -----
      var dtPkgMode = "search";
      var dtInstalledSet = new Set(); // normalized names installed on the board
      function dtPkgNorm(name) { return String(name || "").toLowerCase().replace(/[-_]/g, "_"); }
      function dtRefreshInstalled() { vscode.postMessage({ type: "device_tool_list_lib" }); }
      function dtPkgSetMode(mode) {
        dtPkgMode = mode;
        const sv = $("dtPkgSearchView"), iv = $("dtPkgInstalledView");
        if (sv) sv.classList.toggle("hidden", mode !== "search");
        if (iv) iv.classList.toggle("hidden", mode !== "installed");
        for (const [id, m] of [["dtPkgModeSearch", "search"], ["dtPkgModeInstalled", "installed"]]) {
          const b = $(id); if (b) { b.classList.toggle("active", mode === m); b.setAttribute("aria-pressed", String(mode === m)); }
        }
        if (mode === "installed") { dtInstalledPage = 0; dtRefreshInstalled(); } // a fresh switch starts at page 1
      }
      // A /lib entry -> installed package name: strip the trailing "/" (dir) or a .py/.mpy suffix.
      function dtInstalledName(raw) {
        return raw.charAt(raw.length - 1) === "/" ? raw.slice(0, -1) : raw.replace(/\.(mpy|py)$/, "");
      }
      var dtInstalledNamesAll = [];
      var dtInstalledPage = 0;
      function onInstalledList(entries) {
        const seen = new Set(), names = [];
        for (const raw of (Array.isArray(entries) ? entries : [])) {
          const name = dtInstalledName(raw); if (!name) continue;
          const key = dtPkgNorm(name);
          if (!seen.has(key)) { seen.add(key); names.push(name); } // dedup <name>.py + <name>.mpy
        }
        dtInstalledSet = seen;
        dtInstalledNamesAll = names;
        dtRenderInstalledPage(); // keeps the current page (clamped) so an uninstall doesn't bounce to page 1
      }
      function dtRenderInstalledPage() {
        const host = $("dtPkgInstalled"); if (!host) return;
        host.innerHTML = "";
        const empty = $("dtPkgInstalledEmpty"); if (empty) empty.classList.toggle("hidden", dtInstalledNamesAll.length > 0);
        if (!dtInstalledNamesAll.length) return;
        const pages = Math.ceil(dtInstalledNamesAll.length / DT_PKG_PAGE_SIZE);
        dtInstalledPage = Math.min(Math.max(dtInstalledPage, 0), pages - 1);
        const start = dtInstalledPage * DT_PKG_PAGE_SIZE;
        for (const name of dtInstalledNamesAll.slice(start, start + DT_PKG_PAGE_SIZE)) host.appendChild(dtInstalledRow(name));
        if (pages > 1) host.appendChild(dtPager(dtInstalledPage, pages, (p) => { dtInstalledPage = p; dtRenderInstalledPage(); }));
      }
      function dtInstalledRow(name) {
        const row = document.createElement("div"); row.className = "dt-row";
        const label = document.createElement("span"); label.className = "dt-name"; label.textContent = name;
        const status = document.createElement("span"); status.className = "dt-pkg-cardstatus";
        const btn = dtActionButton(tr("dt_pkg_uninstall"), () => {
          if (dtNoDevice) { status.className = "dt-pkg-cardstatus"; status.textContent = tr("dt_nodev_h"); return; }
          if (dtInstallInFlight) return;
          dtConfirmUninstall(btn, () => dtRunUninstall(name, btn, status));
        });
        btn.classList.add("dt-del");
        row.append(label, status, btn);
        return row;
      }
      function onInstalledError(error) {
        const host = $("dtPkgInstalled"); if (host) host.innerHTML = "";
        // A fresh board has no /lib yet -> treat "not found" as empty; else surface an error.
        if (/no such file|enoent|does not exist|package_not_found/i.test(String(error))) {
          dtInstalledSet = new Set();
          const empty = $("dtPkgInstalledEmpty"); if (empty) empty.classList.remove("hidden");
        } else { dtPkgStatus(tr("dt_pkg_installed_err")); }
      }

      function dtSourceLabel(source) {
        if (source === "micropython_lib") return tr("dt_pkg_src_lib");
        if (source === "upypi") return tr("dt_pkg_src_upypi");
        return "";
      }
      function dtPkgItem(pkg) {
        const item = document.createElement("div"); item.className = "dt-pkg-item";
        const head = document.createElement("button"); head.type = "button"; head.className = "dt-pkg-row"; head.setAttribute("aria-expanded", "false");
        const top = document.createElement("div"); top.className = "dt-pkg-top";
        const name = document.createElement("span"); name.className = "dt-pkg-name"; name.textContent = pkg.name + (pkg.version ? " " + pkg.version : "");
        top.appendChild(name);
        const srcLabel = dtSourceLabel(pkg.source);
        if (srcLabel) { const chip = document.createElement("span"); chip.className = "dt-pkg-src"; chip.textContent = srcLabel; top.appendChild(chip); }
        head.appendChild(top);
        if (pkg.description) { const d = document.createElement("span"); d.className = "dt-pkg-desc"; d.textContent = pkg.description; head.appendChild(d); }
        const body = document.createElement("div"); body.className = "dt-pkg-detail hidden"; body._head = head;
        head.addEventListener("click", () => dtToggleItem(head, body, pkg));
        item.append(head, body);
        return item;
      }
      function dtToggleItem(head, body, pkg) {
        const willOpen = body.classList.contains("hidden");
        if (dtExpandedBody && dtExpandedBody !== body) { // accordion: collapse the other open one
          dtExpandedBody.classList.add("hidden");
          if (dtExpandedBody._head) dtExpandedBody._head.setAttribute("aria-expanded", "false");
        }
        if (!willOpen) { body.classList.add("hidden"); head.setAttribute("aria-expanded", "false"); dtExpandedBody = null; return; }
        body.classList.remove("hidden"); head.setAttribute("aria-expanded", "true"); dtExpandedBody = body;
        if (body.dataset.filled) return;
        if (pkg.source === "upypi") { // uPyPI hits are name+url only -> resolve for the metadata
          // Correlate the resolve by url: a fast double-expand repoints dtPendingResolve, and the
          // host echoes the url back so a late reply for the collapsed row is dropped, not filled
          // into the wrong body (which would install A's package under B's button).
          body.textContent = tr("dt_pkg_searching");
          dtPendingResolve = { body: body, url: pkg.url };
          vscode.postMessage({ type: "package_resolve", url: pkg.url });
        } else {
          dtFillDetail(body, pkg); body.dataset.filled = "1";
        }
      }
      function onPackageResolveResult(record, url) {
        const pending = dtPendingResolve;
        // Drop a late resolve whose url doesn't match the row still awaiting one.
        if (!pending || !record || (url != null && url !== pending.url)) return;
        dtPendingResolve = null;
        dtFillDetail(pending.body, record); pending.body.dataset.filled = "1";
      }
      function onPackageResolveError() {
        const pending = dtPendingResolve; dtPendingResolve = null;
        if (pending) pending.body.textContent = tr("dt_pkg_err");
      }

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
      // A dep is a string or a [ref, version] pair; a uPyPI ref is a /pkgs/<name>/<ver> url.
      function dtDepName(dep) {
        const ref = Array.isArray(dep) ? dep[0] : dep;
        if (typeof ref !== "string") return "";
        const match = ref.match(/\/pkgs\/([^\/]+)/);
        return match ? match[1] : ref;
      }
      // A url entry is a string or a [targetName, sourcePath] pair; show the on-device target.
      function dtUrlName(entry) { const t = Array.isArray(entry) ? entry[0] : entry; return typeof t === "string" ? t : ""; }
      function dtJoinNames(list, pick) {
        return (Array.isArray(list) ? list : []).map(pick).filter(Boolean).join(", ");
      }
      // Fill an accordion item's body with the package detail: a metadata grid, the install
      // command as a mono line, and the Install button. The row header already shows name+version.
      function dtFillDetail(host, pkg) {
        host.innerHTML = "";
        const chips = pkg.chips && pkg.chips !== "all" ? pkg.chips : "";
        const fw = pkg.fw && pkg.fw !== "all" ? pkg.fw : "";
        const deps = dtJoinNames(pkg.deps, dtDepName);
        const files = dtJoinNames(pkg.urls, dtUrlName);
        const url = dtPkgInstallUrl(pkg);
        const meta = document.createElement("div"); meta.className = "dt-pkg-meta";
        for (const [label, value] of [["Author", pkg.author], ["License", pkg.license], ["Chips", chips], ["Firmware", fw], ["Depends", deps], ["Files", files], ["Repo", pkg.repo_url]]) {
          const line = dtDetailLine(label, value); if (line) meta.appendChild(line);
        }
        if (meta.childNodes.length) host.appendChild(meta);
        const cmd = document.createElement("div"); cmd.className = "dt-pkg-cmd";
        cmd.textContent = pkg.install_cmd || ("mpremote mip install " + url);
        host.appendChild(cmd);
        const status = document.createElement("div"); status.className = "dt-pkg-cardstatus";
        const install = dtActionButton("", () => dtDoInstall(pkg, install, status, url));
        install.classList.add("dt-pkg-install");
        // Real installed state (from the board's /lib), not optimistic. Caveat: package name
        // vs on-device module name can diverge for multi-module packages; a false "Install" is
        // the safe failure mode (mip install is idempotent).
        dtSetInstallButton(install, dtInstalledSet.has(dtPkgNorm(pkg.name)));
        host.append(install, status);
      }
      // Install <-> Uninstall button state.
      function dtSetInstallButton(btn, installed) {
        btn.dataset.installed = installed ? "1" : "";
        btn.textContent = installed ? tr("dt_pkg_uninstall") : tr("dt_pkg_install");
        btn.classList.toggle("dt-pkg-installed", installed);
      }
      // Kick off an install (or uninstall, if the card is already installed): show the busy
      // bar in the card and post to the host; the result flips the button (dtFinishInstall).
      function dtDoInstall(pkg, btn, status, url) {
        if (dtNoDevice) { status.className = "dt-pkg-cardstatus"; status.textContent = tr("dt_nodev_h"); return; }
        if (dtInstallInFlight) return;
        if (btn.dataset.installed === "1") { dtConfirmUninstall(btn, () => dtRunUninstall(pkg.name, btn, status)); return; }
        dtInstallInFlight = true; dtActiveInstall = { status: status, btn: btn };
        status.className = "dt-pkg-cardstatus installing"; status.textContent = tr("dt_installing");
        vscode.postMessage({ type: "device_tool_mip", url: url, version: "" });
      }
      // Uninstall is a destructive /lib delete -> two-click confirm (mirrors the file-delete button):
      // the first click arms ("Confirm?"), a second within DT_CONFIRM_MS runs it; else it disarms.
      function dtConfirmUninstall(btn, run) {
        if (btn.dataset.armed) { delete btn.dataset.armed; run(); return; }
        btn.dataset.armed = "1"; const orig = btn.textContent; btn.textContent = tr("dt_confirm_del");
        setTimeout(() => { if (btn.isConnected && btn.dataset.armed) { delete btn.dataset.armed; btn.textContent = orig; } }, DT_CONFIRM_MS);
      }
      function dtRunUninstall(name, btn, status) {
        dtInstallInFlight = true; dtActiveInstall = { status: status, btn: btn };
        status.className = "dt-pkg-cardstatus installing"; status.textContent = tr("dt_pkg_uninstalling");
        vscode.postMessage({ type: "device_tool_uninstall", name: name });
      }

      // Controls live in the DOM at load (the tool-view is hidden, not removed).
      if ($("dtPath")) {
        $("dtPath").addEventListener("keydown", (e) => { if (e.key === "Enter") dtListCurrent(); }); // fallback path entry
        $("dtMkdir").addEventListener("click", () => {
          const name = $("dtNewName").value.trim(); if (!name) return;
          $("dtNewName").value = "";
          dtFilesStatus(tr("dt_working"));
          vscode.postMessage({ type: "device_tool_mkdir", path: dtJoin(dtCurrentPath(), name) });
        });
        $("dtUpload").addEventListener("click", () => { dtFilesStatus(tr("dt_working")); vscode.postMessage({ type: "device_tool_upload", dir: dtCurrentPath() }); });
        $("dtMipInstall").addEventListener("click", () => {
          const url = $("dtMipUrl").value.trim(); if (!url) return;
          if (dtInstallInFlight) return;
          dtInstallInFlight = true;
          dtPkgStatus(tr("dt_installing")); // mip fetches on the host then copies to the board — can take a while
          vscode.postMessage({ type: "device_tool_mip", url, version: $("dtMipVersion").value.trim() });
        });
        if ($("dtPkgSearch")) $("dtPkgSearch").addEventListener("click", dtPkgSearch);
        if ($("dtPkgQuery")) $("dtPkgQuery").addEventListener("keydown", (e) => { if (e.key === "Enter") dtPkgSearch(); });
        if ($("dtPkgSource")) $("dtPkgSource").addEventListener("change", dtPkgClear);
        if ($("dtPkgModeSearch")) $("dtPkgModeSearch").addEventListener("click", () => dtPkgSetMode("search"));
        if ($("dtPkgModeInstalled")) $("dtPkgModeInstalled").addEventListener("click", () => dtPkgSetMode("installed"));
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
