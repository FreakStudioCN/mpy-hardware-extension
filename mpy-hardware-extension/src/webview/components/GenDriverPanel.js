
      // ----- gen-driver panel (Generate Missing Hardware Driver) -----
      // Input tabs come from the host (GEN_DRIVER_TABS in gen-driver-schema.ts), so the
      // schema stays the single source of truth; this only renders and posts back.
      let gdTab = null;
      // Assembled sources[] (Ruili's normalized contract: canonical input is a list, not
      // one source). Lives in JS because renderGenDriver rebuilds the DOM on tab switch.
      let gdSources = [];
      // Config-tab values by tab id ("driver" -> driver_request, "verification"), kept in
      // JS across tab switches; the tabs' inputs are non-source config, not sources[].
      const gdConfig = { driver: {}, verification: {} };
      function renderGenDriver(tabs) {
        const root = $("gendriver");
        if (!root || !Array.isArray(tabs) || !tabs.length) return;
        $("gendriverEmpty").classList.add("hidden");
        if (!gdTab || !tabs.some((t) => t.id === gdTab)) gdTab = tabs[0].id;
        root.innerHTML = "";
        // Split the tab strip into a source-input group (sourceType !== null) and a config group
        // (Target driver / Verification settings, sourceType === null). One flat pill row made the
        // config tabs read as just more sources; grouping under labels separates the two intents.
        const sourceTabs = tabs.filter((t) => t.sourceType !== null);
        const configTabs = tabs.filter((t) => t.sourceType === null);
        if (sourceTabs.length) root.appendChild(gdTabGroup("Add a source", sourceTabs, tabs));
        if (configTabs.length) root.appendChild(gdTabGroup("Settings", configTabs, tabs));
        root.appendChild(gdBody(tabs.find((t) => t.id === gdTab), tabs));
        root.appendChild(gdFooter(tabs));
      }
      function gdTabButton(t, tabs) {
        const b = document.createElement("button");
        b.className = "gd-tab" + (t.id === gdTab ? " active" : "");
        b.textContent = t.label; b.dataset.gdtab = t.id;
        b.addEventListener("click", () => { gdTab = t.id; renderGenDriver(tabs); });
        return b;
      }
      function gdTabGroup(label, groupTabs, tabs) {
        const group = document.createElement("div"); group.className = "gd-tabgroup";
        const lbl = document.createElement("div"); lbl.className = "gd-tabgroup-label"; lbl.textContent = label;
        const strip = document.createElement("div"); strip.className = "gd-tabs";
        for (const t of groupTabs) strip.appendChild(gdTabButton(t, tabs));
        group.appendChild(lbl); group.appendChild(strip);
        return group;
      }
      function gdFileField(field, tabId) {
        // The host owns the file dialog; the picked value (name/path/size/sha256) comes
        // back via gen_driver_file_picked and is stashed in a hidden input as JSON.
        const wrap = document.createElement("div"); wrap.className = "gd-field";
        const lbl = document.createElement("span"); lbl.className = "gd-flabel";
        lbl.textContent = field.label + (field.required ? " *" : "");
        const row = document.createElement("div"); row.className = "gd-filerow";
        const btn = document.createElement("button"); btn.type = "button"; btn.className = "gd-file-btn"; btn.textContent = "Choose file";
        const name = document.createElement("span"); name.className = "gd-filename"; name.textContent = "No file selected";
        const hidden = document.createElement("input"); hidden.type = "hidden"; hidden.className = "gd-input";
        hidden.dataset.gdkey = field.key; hidden.dataset.gdkind = "file";
        btn.addEventListener("click", () => vscode.postMessage({ type: "pick_gen_driver_file", tabId, key: field.key, accept: field.accept }));
        row.appendChild(btn); row.appendChild(name);
        wrap.appendChild(lbl); wrap.appendChild(row); wrap.appendChild(hidden);
        return wrap;
      }
      // "info" kind: read-only display lines (device context / empty-state note). No input,
      // so gdCollect skips it (no data-gdkey).
      function gdInfoField(field) {
        const box = document.createElement("div"); box.className = "gd-note gd-info";
        for (const line of field.lines || []) { const p = document.createElement("div"); p.textContent = line; box.appendChild(p); }
        return box;
      }
      function gdField(field, tabId) {
        if (field.kind === "file") return gdFileField(field, tabId);
        if (field.kind === "info") return gdInfoField(field);
        const wrap = document.createElement("label"); wrap.className = "gd-field";
        const lbl = document.createElement("span"); lbl.className = "gd-flabel";
        lbl.textContent = field.label + (field.required ? " *" : "");
        let control;
        if (field.kind === "textarea") {
          control = document.createElement("textarea");
        } else if (field.kind === "checkbox") {
          control = document.createElement("input"); control.type = "checkbox";
        } else if (field.kind === "select") {
          control = document.createElement("select");
          for (const opt of field.options || []) {
            const o = document.createElement("option");
            o.value = typeof opt === "string" ? opt : opt.value;
            o.textContent = typeof opt === "string" ? opt : opt.label;
            control.appendChild(o);
          }
        } else {
          control = document.createElement("input"); control.type = "text";
          if (field.placeholder) control.placeholder = field.placeholder;
        }
        control.className = "gd-input"; control.dataset.gdkey = field.key;
        // checkbox reads better with the control before its label
        if (field.kind === "checkbox") { wrap.classList.add("gd-check"); wrap.appendChild(control); wrap.appendChild(lbl); }
        else { wrap.appendChild(lbl); wrap.appendChild(control); }
        return wrap;
      }
      function gdCollect(root) {
        const values = {};
        root.querySelectorAll("[data-gdkey]").forEach((el) => {
          if (el.dataset.gdkind === "file") { values[el.dataset.gdkey] = el.value ? JSON.parse(el.value) : ""; return; }
          values[el.dataset.gdkey] = el.type === "checkbox" ? el.checked : el.value.trim();
        });
        return values;
      }
      function gdRequiredMissing(active, values) {
        return active.fields.filter((f) => f.required && !values[f.key]).map((f) => f.label);
      }
      // Build a source object from the active tab's values (client mirror of
      // buildSourceFromFields): { type, artifact_path, sha256, primary, metadata }. Field
      // values go in metadata; a picked file hoists its sha256 and records name/path/size/
      // uploaded_at. artifact_path is null until dispatch stages the file (#52).
      function gdBuildSource(active, values, primary) {
        const metadata = {};
        let sha256 = null;
        for (const f of active.fields) {
          if (f.kind === "info") continue;
          const v = values[f.key];
          if (v === undefined || v === "" || v === false) continue;
          if (f.kind === "file" && v && v.sha256) { sha256 = v.sha256; metadata[f.key] = { name: v.name, path: v.path, size: v.size, uploaded_at: v.uploaded_at || null }; }
          else metadata[f.key] = v;
        }
        if (active.sourceType === "current_cold_driver_item") metadata.driver_status = "cold_driver_required";
        return { type: active.sourceType, artifact_path: null, sha256, primary: Boolean(primary), metadata };
      }
      function gdSourceLabel(src) {
        const meta = src.metadata || {};
        const bits = [];
        for (const k in meta) {
          if (k === "driver_status") continue;
          const v = meta[k]; if (!v) continue;
          bits.push(v && v.name ? v.name : v);
        }
        return src.type + (bits.length ? " — " + bits.slice(0, 2).join(", ") : "") + (src.primary ? " (primary)" : "");
      }
      // Add the active source tab's input to the sources[] list (validated), then
      // re-render so the tab clears and the footer list updates.
      function gdAddSource(active, body, tabs) {
        const values = gdCollect(body);
        const missing = gdRequiredMissing(active, values);
        const err = body.querySelector(".gd-add-status");
        if (missing.length) {
          if (err) { err.className = "gd-add-status gd-failed"; err.textContent = "Fill required: " + missing.join(", "); }
          return;
        }
        gdSources.push(gdBuildSource(active, values, gdSources.length === 0));
        renderGenDriver(tabs);
      }
      function gdPrefill(body, values) {
        body.querySelectorAll("[data-gdkey]").forEach((el) => {
          const v = values[el.dataset.gdkey];
          if (v === undefined) return;
          if (el.type === "checkbox") el.checked = Boolean(v); else el.value = v;
        });
      }
      // Map the flat driver tab values to the driver_request shape (Jul-6 doc §2.1).
      function gdBuildDriverRequest(v) {
        const dr = {};
        for (const k of ["driver_id", "chip_model", "module_model", "vendor", "interface"]) if (v[k]) dr[k] = v[k];
        if (v.i2c_addresses) dr.i2c_addresses = String(v.i2c_addresses).split(/[,\s]+/).filter(Boolean);
        if (v.board_id || v.mcu) dr.target_board = Object.assign({}, v.board_id ? { board_id: v.board_id } : {}, v.mcu ? { mcu: v.mcu } : {});
        return dr;
      }
      // P0 default: hardware_required; the skip toggle flips it to skipped. Only the sample's
      // verification fields ride the wire (required/policy/port/marker/max_rounds); test_scenario
      // and wiring_confirmed are UI-only (marker suggestion + confirm-card display).
      function gdBuildVerification(v) {
        const skip = v.skip_verification === true;
        const out = { required: !skip, policy: skip ? "skipped" : "hardware_required" };
        if (v.port) out.port = v.port;
        if (v.board) out.board = v.board;
        if (v.marker) out.marker = v.marker;
        if (v.max_rounds) { const n = Number(v.max_rounds); if (n) out.max_rounds = n; }
        return out;
      }
      // Suggested marker when the user gave a chip + scenario but no explicit marker
      // (contract: SELF_TEST_PASS:<CHIP>:<SCENARIO>).
      function gdSuggestMarker(chip, scenario) {
        if (!chip || !scenario) return "";
        return "SELF_TEST_PASS:" + String(chip).toUpperCase() + ":" + String(scenario).toUpperCase();
      }
      // Preprocess script the plugin runs per source type (SKILL.md), shown on the confirm card.
      function gdPreprocessScript(type) {
        if (type === "pdf") return "extract_pdf.py";
        if (type === "arduino_source") return "convert_arduino.py";
        if (type === "github_url") return "fetch_github.py";
        return null;
      }
      // Gate (Ruili): >=1 source OR a driver_request with a chip/id.
      function gdGateOpen() {
        const dr = gdBuildDriverRequest(gdConfig.driver || {});
        return gdSources.length > 0 || Boolean(dr.chip_model || dr.driver_id);
      }
      function gdUpdateGate() {
        const gen = $("gendriver") && $("gendriver").querySelector(".gd-foot .gd-gen");
        if (gen) gen.disabled = !gdGateOpen();
      }
      function gdBody(active, tabs) {
        const body = document.createElement("div"); body.className = "gd-body";
        // The current tab is materialized host-side (device picker + context, or an
        // empty-state info line); every other tab renders its static fields.
        for (const field of active.fields || []) body.appendChild(gdField(field, active.id));
        if (active.sourceType !== null) {
          // source tab: add its input to sources[] — but not the current tab's empty state
          if (!active.noItems) {
            const add = document.createElement("button"); add.className = "gd-add"; add.type = "button"; add.textContent = "+ Add source";
            add.addEventListener("click", () => gdAddSource(active, body, tabs));
            body.appendChild(add);
            const err = document.createElement("div"); err.className = "gd-add-status"; body.appendChild(err);
          }
        } else if (gdConfig[active.id]) {
          // config tab (driver_request / verification): persist across tab switches, refresh the gate
          gdPrefill(body, gdConfig[active.id]);
          body.addEventListener("input", () => { gdConfig[active.id] = gdCollect(body); gdUpdateGate(); });
        }
        return body;
      }
      // Persistent footer: assembled sources[] list + a gated Generate + status line.
      function gdFooter(tabs) {
        const foot = document.createElement("div"); foot.className = "gd-foot";
        const list = document.createElement("div"); list.className = "gd-sources";
        if (!gdSources.length) {
          const empty = document.createElement("p"); empty.className = "gd-note"; empty.textContent = "No sources added yet.";
          list.appendChild(empty);
        } else {
          gdSources.forEach((src, i) => {
            const row = document.createElement("div"); row.className = "gd-source-row";
            const label = document.createElement("span"); label.className = "gd-source-label"; label.textContent = gdSourceLabel(src);
            const rm = document.createElement("button"); rm.className = "gd-source-rm"; rm.type = "button"; rm.textContent = "✕"; rm.title = "Remove source";
            rm.addEventListener("click", () => {
              gdSources.splice(i, 1);
              // Removing the primary must promote the new first source; otherwise the list is left
              // with every source primary:false and the launched payload has no primary at all.
              gdSources.forEach((s, idx) => { s.primary = idx === 0; });
              renderGenDriver(tabs);
            });
            row.appendChild(label); row.appendChild(rm); list.appendChild(row);
          });
        }
        foot.appendChild(list);
        const gen = document.createElement("button"); gen.className = "gd-gen"; gen.textContent = "Generate driver";
        gen.disabled = !gdGateOpen(); // gate: >=1 source OR a driver_request
        const status = document.createElement("div"); status.className = "gd-status"; status.id = "gdStatus";
        gen.addEventListener("click", () => gdReview(status));
        foot.appendChild(gen); foot.appendChild(status);
        return foot;
      }
      // Expected artifact paths derived from the driver id (naming convention, sample
      // expected_output). The plugin produces the real files at run time (#52).
      function gdExpectedPaths(driverId) {
        if (!driverId) return null;
        const dir = "firmware/drivers/" + driverId + "_driver";
        return dir + "/" + driverId + ".py, " + dir + "/test_" + driverId + ".py";
      }
      // The §9.3 confirm lines — all input-derivable. The target is labelled "requested"
      // (never claimed as the generated driver_spec, which is a run artifact / #52).
      function gdConfirmLines(driverRequest, verification) {
        const firstMeta = (gdSources[0] && gdSources[0].metadata) || {};
        const chip = driverRequest.chip_model || driverRequest.driver_id || firstMeta.chip_model || "";
        const iface = driverRequest.interface || firstMeta.interface || "";
        const lines = [];
        if (chip) lines.push("Requested driver: " + chip + (iface ? " (" + iface + ")" : ""));
        gdSources.forEach((s) => {
          const script = gdPreprocessScript(s.type);
          const tail = [s.primary ? "primary" : "auxiliary", s.sha256 ? "sha256 " + String(s.sha256).slice(0, 12) : null, script ? "runs " + script : null].filter(Boolean).join(", ");
          lines.push("Source " + gdSourceLabel(s) + (tail ? " — " + tail : ""));
        });
        const paths = gdExpectedPaths(driverRequest.driver_id);
        lines.push("Expected artifacts: " + (paths || "TBD (set a driver id)"));
        lines.push("Verify: " + verification.policy + (verification.port ? " on " + verification.port : "") + (verification.max_rounds ? ", up to " + verification.max_rounds + " round(s)" : "") + (verification.marker ? ", marker " + verification.marker : ""));
        if (verification.policy === "skipped") lines.push("Warning: hardware verification skipped — the driver will be unverified.");
        return lines;
      }
      // driver_source_confirm: a UI-local pre-start confirm (NOT a plugin approval_request,
      // which happens after start_phase). Summarizes the §9.3 content and requires an explicit
      // confirm before launching.
      function gdReview(statusEl) {
        if (!gdGateOpen()) return;
        statusEl.className = "gd-status"; statusEl.innerHTML = "";
        const driverRequest = gdBuildDriverRequest(gdConfig.driver || {});
        const verification = gdBuildVerification(gdConfig.verification || {});
        // A marker the user got only from the chip + scenario suggestion still rides the wire.
        if (!verification.marker) {
          const chip = driverRequest.chip_model || driverRequest.driver_id || ((gdSources[0] || {}).metadata || {}).chip_model;
          const suggested = gdSuggestMarker(chip, (gdConfig.verification || {}).test_scenario);
          if (suggested) verification.marker = suggested;
        }
        const card = document.createElement("div"); card.className = "gd-confirm";
        const h = document.createElement("div"); h.className = "gd-confirm-h"; h.textContent = "Confirm driver sources";
        card.appendChild(h);
        const bodyEl = document.createElement("div"); bodyEl.className = "gd-confirm-body";
        for (const line of gdConfirmLines(driverRequest, verification)) { const row = document.createElement("div"); row.textContent = line; bodyEl.appendChild(row); }
        card.appendChild(bodyEl);
        const confirm = document.createElement("button"); confirm.className = "gd-gen"; confirm.textContent = "Confirm & generate";
        confirm.addEventListener("click", () => {
          vscode.postMessage({ type: "start_gen_driver", sources: gdSources, driverRequest, verification });
          confirm.disabled = true; confirm.textContent = "Generating…";
          // Leave the gen-driver tool surface and show Activity, or the run streams behind the overlay
          // and the click looks like it did nothing.
          closeGlobalTool();
          setTab("activity");
        });
        card.appendChild(confirm);
        statusEl.appendChild(card);
      }
      function setGenDriverStatus(status, detail) {
        const el = $("gdStatus"); if (!el) return;
        el.className = "gd-status" + (status ? " gd-" + status : "");
        el.textContent = detail || (status ? "Driver status: " + status : "");
      }
      function setGenDriverFile(file) {
        const root = $("gendriver"); if (!root) return;
        const hidden = root.querySelector("[data-gdkey='" + file.key + "'][data-gdkind='file']");
        if (!hidden) return;
        hidden.value = JSON.stringify({ name: file.name, path: file.path, size: file.size, sha256: file.sha256, uploaded_at: file.uploaded_at || null });
        const label = hidden.parentElement.querySelector(".gd-filename");
        if (label) label.textContent = file.name;
      }
      // #53: generate blocked because a device has no ready driver. OFFER to build it first (never
      // auto-start) — clicking dispatches a pipeline gen-driver run off the cold-driver source.
      function showDriverRequiredOffer(blocks) {
        const host = $("activity"); if (!host || !Array.isArray(blocks) || !blocks.length) return;
        const devices = blocks.map((b) => (b && (b.device || b.driver_id)) || "").filter(Boolean).join(", ");
        const card = document.createElement("div"); card.className = "ev-card gd-required"; card.dataset.genDriverOffer = "1";
        const head = document.createElement("div"); head.className = "gd-required-head";
        head.textContent = "A driver must be built before generating" + (devices ? ": " + devices : "");
        const btn = document.createElement("button"); btn.className = "gd-required-run"; btn.textContent = "Build driver";
        btn.addEventListener("click", () => {
          vscode.postMessage({ type: "start_gen_driver", sources: [{ type: "current_cold_driver_item", metadata: { driver_status: "cold_driver_required" } }] });
          btn.disabled = true; head.textContent = "Building driver…";
        });
        card.appendChild(head); card.appendChild(btn);
        host.appendChild(card);
      }

