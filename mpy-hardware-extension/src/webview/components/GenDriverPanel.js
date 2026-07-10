
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
        const strip = document.createElement("div"); strip.className = "gd-tabs";
        for (const t of tabs) {
          const b = document.createElement("button");
          b.className = "gd-tab" + (t.id === gdTab ? " active" : "");
          b.textContent = t.label; b.dataset.gdtab = t.id;
          b.addEventListener("click", () => { gdTab = t.id; renderGenDriver(tabs); });
          strip.appendChild(b);
        }
        root.appendChild(strip);
        root.appendChild(gdBody(tabs.find((t) => t.id === gdTab), tabs));
        root.appendChild(gdFooter(tabs));
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
      function gdField(field, tabId) {
        if (field.kind === "file") return gdFileField(field, tabId);
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
            const o = document.createElement("option"); o.value = opt; o.textContent = opt; control.appendChild(o);
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
      // buildSourceFromFields): { type, ...non-empty fields }.
      function gdBuildSource(active, values) {
        const src = { type: active.sourceType };
        for (const f of active.fields) {
          const v = values[f.key];
          if (v !== undefined && v !== "" && v !== false) src[f.key] = v;
        }
        return src;
      }
      function gdSourceLabel(src) {
        const bits = [];
        for (const k in src) {
          if (k === "type") continue;
          const v = src[k]; if (!v) continue;
          bits.push(v && v.name ? v.name : v);
        }
        return src.type + (bits.length ? " — " + bits.slice(0, 2).join(", ") : "");
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
        gdSources.push(gdBuildSource(active, values));
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
      // P0 default: hardware_required; the skip toggle flips it to skipped.
      function gdBuildVerification(v) {
        const skip = v.skip_verification === true;
        const out = { required: !skip, policy: skip ? "skipped" : "hardware_required" };
        if (v.port) out.port = v.port;
        if (v.board) out.board = v.board;
        if (v.max_rounds) { const n = Number(v.max_rounds); if (n) out.max_rounds = n; }
        return out;
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
        if (!active.fields || active.fields.length === 0) {
          const note = document.createElement("p"); note.className = "gd-note";
          note.textContent = "Uses the current project's missing driver.";
          body.appendChild(note);
        } else {
          for (const field of active.fields) body.appendChild(gdField(field, active.id));
        }
        if (active.sourceType !== null) {
          // source tab: add its input to sources[]
          const add = document.createElement("button"); add.className = "gd-add"; add.type = "button"; add.textContent = "+ Add source";
          add.addEventListener("click", () => gdAddSource(active, body, tabs));
          body.appendChild(add);
          const err = document.createElement("div"); err.className = "gd-add-status"; body.appendChild(err);
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
            rm.addEventListener("click", () => { gdSources.splice(i, 1); renderGenDriver(tabs); });
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
      // driver_source_confirm: summarize the assembled sources[] and require an explicit
      // confirm before launching.
      function gdReview(statusEl) {
        if (!gdGateOpen()) return;
        statusEl.className = "gd-status"; statusEl.innerHTML = "";
        const driverRequest = gdBuildDriverRequest(gdConfig.driver || {});
        const verification = gdBuildVerification(gdConfig.verification || {});
        const card = document.createElement("div"); card.className = "gd-confirm";
        const h = document.createElement("div"); h.className = "gd-confirm-h"; h.textContent = "Confirm driver sources";
        const parts = [];
        if (gdSources.length) parts.push("sources: " + gdSources.map(gdSourceLabel).join(", "));
        if (driverRequest.driver_id || driverRequest.chip_model) parts.push("target: " + (driverRequest.driver_id || driverRequest.chip_model));
        parts.push("verify: " + verification.policy);
        const summary = document.createElement("div"); summary.className = "gd-confirm-body"; summary.textContent = parts.join("  |  ");
        const confirm = document.createElement("button"); confirm.className = "gd-gen"; confirm.textContent = "Confirm & generate";
        confirm.addEventListener("click", () => vscode.postMessage({
          type: "start_gen_driver",
          sources: gdSources,
          driverRequest,
          verification,
        }));
        card.appendChild(h); card.appendChild(summary); card.appendChild(confirm);
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
        hidden.value = JSON.stringify({ name: file.name, path: file.path, size: file.size, sha256: file.sha256 });
        const label = hidden.parentElement.querySelector(".gd-filename");
        if (label) label.textContent = file.name;
      }

