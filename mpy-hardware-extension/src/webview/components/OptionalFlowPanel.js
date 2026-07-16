
      // ----- Wiring (maps internal manifest → friendly component cards) -----
      const ROLE_MAP = {
        i2c_sda:    { signal: "Data (SDA)",   comp: "i2c", kind: "signal" },
        i2c_scl:    { signal: "Clock (SCL)",  comp: "i2c", kind: "signal" },
        i2c_power:  { signal: "Power 3V3",    comp: "i2c", kind: "power" },
        i2c_gnd:    { signal: "Ground",       comp: "i2c", kind: "ground" },
        led_anode:  { signal: "Anode (+)",    comp: "led", kind: "signal" },
        led_cathode:{ signal: "Cathode (–)",  comp: "led", kind: "ground" },
        button:     { signal: "Switch leg",   comp: "btn", kind: "signal" },
        button_gnd: { signal: "Ground",       comp: "btn", kind: "ground" },
      };
      const COMPONENTS = {
        i2c: { name: "I²C Sensor", part: "I²C bus device" },
        led: { name: "Status LED", part: "5mm + current-limit resistor" },
        btn: { name: "Button", part: "Momentary tactile" },
        other: { name: "Peripheral", part: "" },
      };
      function humanize(role) { return role.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()); }
      function classifyRole(role) {
        if (/gnd|ground|cathode/i.test(role)) return "ground";
        if (/3v3|vcc|vbus|vsys|power|5v/i.test(role)) return "power";
        return "signal";
      }
      // Friendly labels for bus connection pins in the rich (LLM) wiring shape.
      const BUS_SIGNAL = { sda: "Data (SDA)", scl: "Clock (SCL)", mosi: "Data (MOSI)", miso: "Data (MISO)",
        sck: "Clock (SCK)", cs: "Chip select (CS)", tx: "TX", rx: "RX", power: "Power 3V3", vcc: "Power 3V3", gnd: "Ground" };
      // zh overrides for the wiring diagram; en uses the maps above (pins like GPIO5
      // and bus names like I2C stay as identifiers in both languages).
      const ROLE_SIGNAL_ZH = { i2c_sda: "数据 (SDA)", i2c_scl: "时钟 (SCL)", i2c_power: "电源 3V3", i2c_gnd: "地 (GND)", led_anode: "正极 (+)", led_cathode: "负极 (–)", button: "开关引脚", button_gnd: "地 (GND)" };
      const COMPONENTS_ZH = { i2c: { name: "I²C 传感器", part: "I²C 总线设备" }, led: { name: "状态 LED", part: "5mm + 限流电阻" }, btn: { name: "按钮", part: "轻触按键" }, other: { name: "外设", part: "" } };
      const BUS_SIGNAL_ZH = { sda: "数据 (SDA)", scl: "时钟 (SCL)", mosi: "数据 (MOSI)", miso: "数据 (MISO)", sck: "时钟 (SCK)", cs: "片选 (CS)", tx: "TX", rx: "RX", power: "电源 3V3", vcc: "电源 3V3", gnd: "地 (GND)" };
      function roleSignal(role) { if (LOCALE === "zh" && ROLE_SIGNAL_ZH[role]) return ROLE_SIGNAL_ZH[role]; const m = ROLE_MAP[role]; return m ? m.signal : humanize(role); }
      function compInfo(key) { const base = COMPONENTS[key] || COMPONENTS.other; if (LOCALE === "zh") { const z = COMPONENTS_ZH[key] || COMPONENTS_ZH.other; return { name: z.name || base.name, part: z.part != null ? z.part : base.part }; } return base; }
      function busSignal(k) { const key = String(k).toLowerCase(); if (LOCALE === "zh" && BUS_SIGNAL_ZH[key]) return BUS_SIGNAL_ZH[key]; return BUS_SIGNAL[key] || humanize(k); }
      function componentCount(n) { return LOCALE === "zh" ? (n + " 个元件") : (n + " component" + (n > 1 ? "s" : "")); }
      function busWord(busLabel, kind) { const w = kind === "device" ? (LOCALE === "zh" ? "设备" : "device") : (LOCALE === "zh" ? "总线" : "bus"); return busLabel + (LOCALE === "zh" ? " " : " ") + w; }
      // Friendly pin-row labels for standalone GPIO parts (upstream wiring.standalone[].type).
      const STANDALONE_SIGNAL = { gpio_out: "Output", gpio_in: "Input", gpio_in_pullup: "Input (pull-up)", pwm: "PWM", adc: "Analog (ADC)" };
      const STANDALONE_SIGNAL_ZH = { gpio_out: "输出", gpio_in: "输入", gpio_in_pullup: "输入 (上拉)", pwm: "PWM", adc: "模拟 (ADC)" };
      function standaloneSignal(type) { const t = String(type == null ? "" : type).toLowerCase(); if (LOCALE === "zh" && STANDALONE_SIGNAL_ZH[t]) return STANDALONE_SIGNAL_ZH[t]; return STANDALONE_SIGNAL[t] || humanize(t); }
      // Diagram tab: localize the derived architecture layer ids and run-flow phases
      // (same client-side i18n pattern as the wiring labels above). The derived
      // diagram carries only neutral ids/phases; an explicit label/action (e.g. from
      // an LLM-authored diagram.json) always wins. Module names / mcu / interface
      // tokens are identifiers and stay untranslated.
      const LAYER_LABEL = { entry: "Entry", driver: "Driver", board: "Board", lib: "Library", task: "Task", host: "Host", test: "Test" };
      const LAYER_LABEL_ZH = { entry: "入口层", driver: "驱动层", board: "板级层", lib: "基础库", task: "任务层", host: "主机层", test: "测试层" };
      const FLOW_PHASE = { boot: "Boot", init: "Initialize bus", scan: "Scan devices", create: "Create drivers", assembly: "Assemble", run: "Run loop", shutdown: "Shutdown" };
      const FLOW_PHASE_ZH = { boot: "启动", init: "初始化总线", scan: "扫描器件", create: "创建驱动", assembly: "装配", run: "运行循环", shutdown: "关闭" };
      function layerLabel(layer) { if (layer && layer.label) return layer.label; const id = layer && layer.id; const map = LOCALE === "zh" ? LAYER_LABEL_ZH : LAYER_LABEL; return (id && map[id]) || id || ""; }
      function flowAction(step) { if (step && step.action) return step.action; const phase = step && step.phase; const map = LOCALE === "zh" ? FLOW_PHASE_ZH : FLOW_PHASE; return (phase && map[phase]) || phase || ""; }
      // The contract emits a device-identity object { buses[], standalone[] }
      // (upstream wiring.schema): one card per device on a bus, one per
      // standalone GPIO part — device identity is first-class, so there is no
      // role-bucketing and no global chip stamp. A legacy flat [{role,pin}]
      // array and the older bus-keyed object are still rendered for back-compat.
      function buildComponents(manifest) {
        const wiring = manifest && manifest.wiring;
        if (Array.isArray(wiring)) {
          const byComp = {};
          for (const w of wiring) {
            const map = ROLE_MAP[w.role] || { comp: "other", kind: classifyRole(w.role) };
            (byComp[map.comp] = byComp[map.comp] || []).push({ signal: roleSignal(w.role), kind: map.kind, pin: w.pin });
          }
          return Object.keys(byComp).map((k) => ({ key: k, ...compInfo(k), pins: byComp[k] }));
        }
        if (wiring && typeof wiring === "object" && (Array.isArray(wiring.buses) || Array.isArray(wiring.standalone))) {
          const comps = [];
          for (const bus of wiring.buses || []) {
            const busLabel = String((bus && (bus.type || bus.id)) || "bus").toUpperCase();
            const pins = (Array.isArray(bus && bus.signals) ? bus.signals : []).map((s) => ({
              signal: busSignal(s && s.role), kind: classifyRole(String((s && s.role) || "")), pin: String((s && s.gpio) || ""),
            }));
            const devices = Array.isArray(bus && bus.devices) ? bus.devices : [];
            if (devices.length) {
              for (const d of devices) {
                const addr = d && d.addr;
                comps.push({ key: "bus", driver: "", name: (d && d.name) || busWord(busLabel, "device"), part: busLabel + (addr ? " · " + addr : ""), pins });
              }
            } else {
              comps.push({ key: "bus", driver: "", name: busWord(busLabel, "bus"), part: "", pins });
            }
          }
          for (const part of wiring.standalone || []) {
            const type = String((part && part.type) || "gpio_out");
            const kind = classifyRole(type);
            // Multi-pin parts (HX711, stepper, RGB LED) carry pins[]; label each row
            // by its pin_name, falling back to the friendly type signal. Single-pin
            // parts keep one row from part.pin.
            const pinList = Array.isArray(part && part.pins) && part.pins.length
              ? part.pins.map((pp) => ({ signal: (pp && pp.name) || standaloneSignal(type), kind, pin: String((pp && pp.gpio) || "") }))
              : [{ signal: standaloneSignal(type), kind, pin: String((part && part.pin) || "") }];
            comps.push({
              key: "other", driver: "",
              name: (part && part.name) || compInfo("other").name,
              part: (part && part.external_components) || "",
              pins: pinList,
            });
          }
          return comps;
        }
        if (wiring && typeof wiring === "object") {
          const comps = [];
          for (const [bus, spec] of Object.entries(wiring)) {
            if (!spec || typeof spec !== "object") continue;
            const pins = [];
            for (const [k, v] of Object.entries(spec)) {
              if (k === "devices" || v == null || typeof v === "object") continue;
              pins.push({ signal: busSignal(k), kind: classifyRole(k), pin: String(v) });
            }
            const busLabel = bus.toUpperCase();
            const devices = Array.isArray(spec.devices) ? spec.devices : [];
            if (devices.length) {
              for (const d of devices) {
                comps.push({ key: bus, name: (d && d.label) || busWord(busLabel, "device"), part: (d && d.address) ? (busLabel + " · " + d.address) : busWord(busLabel, "bus"), pins });
              }
            } else {
              comps.push({ key: bus, name: busWord(busLabel, "bus"), part: "", pins });
            }
          }
          return comps;
        }
        return [];
      }
      function driverFor(comp, manifest) {
        // Device-identity cards carry their own label (or none); never fall back
        // to stamping the first global driver ref onto every card.
        if (comp.driver !== undefined) return comp.driver;
        const refs = (manifest && manifest.driver_context_refs) || [];
        if (comp.key === "led") return LOCALE === "zh" ? "GPIO 输出" : "GPIO out";
        const ref = refs.find((r) => !/machine_pin_led/.test(r));
        return ref ? ref.split("@")[0] : "";
      }
      // Build the wiring diagram HTML from a manifest ("" if none). Shared by the
      // Wiring tab and the deploy checkpoint card so both show the same diagram.
      function wiringMarkup(manifest) {
        let comps;
        try { comps = buildComponents(manifest); }
        catch (e) { console.error("wiringMarkup: unrecognized manifest.wiring shape", e); comps = []; }
        if (!comps.length) return "";
        const mcu = manifest && manifest.mcu;
        // Resolve the board display name across manifest shapes: select-hw+ manifests carry
        // it under mcu.board_name (mcu.mcu is the chip-token fallback); older/simple shapes
        // use mcu.board/mcu.model or a top-level board_id. Reading only board/model degraded
        // real manifests to the "Target board" placeholder and dropped the MCU from the view.
        const boardName = (mcu && (mcu.board || mcu.board_name || mcu.model || mcu.mcu)) || (manifest && manifest.board_id) || tr("target_board");
        let html = '<div class="wiring"><div class="wire-board">' +
          "<span><b>" + esc(boardName) + "</b> · " + componentCount(comps.length) + "</span></div>";
        for (const c of comps) {
          const drv = driverFor(c, manifest);
          html += '<div class="comp-card fade-in"><div class="comp-top">' +
            '<div class="comp-ico"><svg width="16" height="16" viewBox="0 0 24 24" fill="none"><rect x="6" y="6" width="12" height="12" rx="2" stroke="currentColor" stroke-width="2"/></svg></div>' +
            '<div class="comp-meta"><div class="comp-name">' + esc(c.name) + '</div><div class="comp-part">' + esc(c.part) + "</div></div>" +
            (drv ? '<div class="comp-driver">' + esc(drv) + "</div>" : "") + "</div><div class=\"comp-pins\">";
          for (const p of c.pins) {
            const badgeCls = "pin-badge" + (p.kind === "power" ? " power" : p.kind === "ground" ? " ground" : "");
            html += '<div class="pin-row"><span class="pin-dot ' + p.kind + '"></span>' +
              '<span class="pin-sig">' + esc(p.signal) + '</span><span class="' + badgeCls + '">' + esc(p.pin) + "</span></div>";
          }
          html += "</div></div>";
        }
        if (comps.some((c) => c.key === "led")) html += '<div class="wire-note">' + tr("led_note") + '</div>';
        html += "</div>";
        return html;
      }
      function renderWiring(manifest) {
        const html = wiringMarkup(manifest);
        const host = $("wiring");
        if (!html) { $("wiringEmpty").classList.remove("hidden"); host.innerHTML = ""; return; }
        $("wiringEmpty").classList.add("hidden");
        // Before the select-hw turn assigns pins, the manifest carries derived bus/interface
        // topology but no pinout[]; flag the diagram as a preview so it doesn't read as final.
        const pinout = manifest && manifest.pinout;
        const provisional = !Array.isArray(pinout) || pinout.length === 0;
        host.innerHTML = (provisional ? '<div class="wire-provisional">' + tr("wiring_provisional") + "</div>" : "") + html;
        markNew("wiring");
      }
      function esc(s) { return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;"); }

      // ----- Diagram tab (renders upstream diagram.json architecture + run flow) -----
      // An LLM-authored diagram.json edge ({from,to}) -> "from -> to (meta)" <li>.
      // Skipped silently when both endpoints are missing so a malformed row can't
      // render an orphan arrow.
      function edgeRow(from, to, meta) {
        if (!from && !to) return "";
        return '<li><span class="diagram-edge-node">' + esc(from || "?") + '</span> &rarr; <span class="diagram-edge-node">' + esc(to || "?") + "</span>"
          + (meta ? ' <span class="diagram-detail">' + esc(meta) + "</span>" : "") + "</li>";
      }
      function diagramMarkup(diagram) {
        if (!diagram || typeof diagram !== "object") return "";
        const arch = diagram.architecture || {};
        const layers = Array.isArray(arch.layers) ? arch.layers : [];
        // cross_layer_deps + data_flow only exist in the rich LLM-authored diagram.json
        // (the upy-diagram skill); the manifest-derived diagram omits them.
        const deps = Array.isArray(arch.cross_layer_deps) ? arch.cross_layer_deps : [];
        const dataFlow = Array.isArray(diagram.data_flow) ? diagram.data_flow : [];
        const flow = Array.isArray(diagram.flow) ? diagram.flow : [];
        if (!layers.length && !flow.length && !deps.length && !dataFlow.length) return "";
        let html = "";
        if (layers.length) {
          html += '<div class="diagram-section"><h4 class="diagram-h">' + esc(tr("diagram_architecture")) + "</h4>";
          for (const layer of layers) {
            const mods = Array.isArray(layer.modules) ? layer.modules : [];
            html += '<div class="diagram-layer"><div class="diagram-layer-name">' + esc(layerLabel(layer)) + "</div><div class=\"diagram-modules\">";
            for (const m of mods) {
              html += '<span class="diagram-module" title="' + esc(m.path || "") + '">' + esc(m.name || "")
                + (m.role ? ' <span class="diagram-role">' + esc(m.role) + "</span>" : "") + "</span>";
            }
            html += "</div></div>";
          }
          html += "</div>";
        }
        if (deps.length) {
          html += '<div class="diagram-section"><h4 class="diagram-h">' + esc(tr("diagram_deps")) + '</h4><ul class="diagram-edges">';
          for (const d of deps) html += edgeRow(d && d.from, d && d.to, d && d.label);
          html += "</ul></div>";
        }
        if (flow.length) {
          html += '<div class="diagram-section"><h4 class="diagram-h">' + esc(tr("diagram_flow")) + '</h4><ol class="diagram-flow">';
          for (const step of flow) {
            html += "<li>" + esc(flowAction(step))
              + (step.detail ? ' — <span class="diagram-detail">' + esc(step.detail) + "</span>" : "") + "</li>";
          }
          html += "</ol></div>";
        }
        if (dataFlow.length) {
          html += '<div class="diagram-section"><h4 class="diagram-h">' + esc(tr("diagram_dataflow")) + '</h4><ul class="diagram-edges">';
          for (const f of dataFlow) {
            const meta = [f && f.data, f && f.rate].filter(Boolean).join(" · ");
            html += edgeRow(f && f.from, f && f.to, meta);
          }
          html += "</ul></div>";
        }
        return html;
      }
      function renderDiagram(diagram) {
        const html = diagramMarkup(diagram);
        const host = $("diagram");
        if (!html) { $("diagramEmpty").classList.remove("hidden"); host.innerHTML = ""; return; }
        $("diagramEmpty").classList.add("hidden");
        host.innerHTML = html;
        markNew("diagram");
      }

      // The optional wiring/diagram RUN entries. Shown only for the flows generate offered
      // (optional_next_phases); the host re-checks the offer too, so this is convenience, not the gate.
      var OPTIONAL_FLOW_BY_TOKEN = {
        "upy-wiring-plugin": { flow: "wiring", entry: "wiringEntry", label: LOCALE === "zh" ? "生成接线图" : "Generate wiring diagram" },
        "upy-diagram-plugin": { flow: "diagram", entry: "diagramEntry", label: LOCALE === "zh" ? "生成架构图" : "Generate architecture diagram" },
      };
      function setOptionalFlows(phases) {
        var offered = {};
        (Array.isArray(phases) ? phases : []).forEach(function (p) { if (p && p.phase) offered[p.phase] = true; });
        Object.keys(OPTIONAL_FLOW_BY_TOKEN).forEach(function (token) {
          var cfg = OPTIONAL_FLOW_BY_TOKEN[token];
          var el = $(cfg.entry); if (!el) return;
          el.innerHTML = "";
          if (!offered[token]) { el.classList.add("hidden"); return; }
          el.classList.remove("hidden");
          var btn = document.createElement("button"); btn.className = "of-run"; btn.textContent = cfg.label; btn.dataset.flow = cfg.flow; btn.dataset.label = cfg.label;
          btn.addEventListener("click", function () {
            vscode.postMessage({ type: "start_optional_flow", flow: cfg.flow });
            btn.disabled = true;
            btn.textContent = LOCALE === "zh" ? "生成中…" : "Generating…";
            setTab("activity"); // the run streams its approvals + progress into the Activity timeline
          });
          el.appendChild(btn);
        });
      }
      // Render a wiring/diagram RUN's authored image (the mermaid-rendered svg/png) in its tab, above the
      // derived preview. The host already attaches a webview-safe `webview_uri` to image artifacts and tags
      // their kind (wiring/diagram) in the artifacts_index — so pick the best image and show it. Falls back
      // to nothing (the derived view stays) when the run produced no image (local-only/partial run).
      function optionalFlowRunImage(artifacts, kind) {
        var imgs = (Array.isArray(artifacts) ? artifacts : []).filter(function (a) { return a && a.kind === kind && a.webview_uri; });
        var svg = imgs.filter(function (a) { return /\.svg$/i.test(a.relative_path || ""); });
        var png = imgs.filter(function (a) { return /\.png$/i.test(a.relative_path || ""); });
        return svg[0] || png[0] || imgs[0] || null;
      }
      function renderOptionalFlowRunImage(containerId, artifacts, kind, label) {
        var el = $(containerId); if (!el) return;
        var art = optionalFlowRunImage(artifacts, kind);
        el.innerHTML = "";
        if (!art) { el.classList.add("hidden"); return; }
        el.classList.remove("hidden");
        var cap = document.createElement("div"); cap.className = "of-run-cap"; cap.textContent = label;
        var img = document.createElement("img"); img.className = "of-run-img"; img.src = art.webview_uri; img.alt = label; // .src, not innerHTML -> no injection
        el.appendChild(cap); el.appendChild(img);
      }
      function renderOptionalFlowImages(artifacts) {
        // labels computed at call-time so the locale is current (LOCALE is "en" at script load).
        renderOptionalFlowRunImage("wiringRunImage", artifacts, "wiring", LOCALE === "zh" ? "生成的接线图" : "Generated wiring");
        renderOptionalFlowRunImage("diagramRunImage", artifacts, "diagram", LOCALE === "zh" ? "生成的架构图" : "Generated diagram");
      }
      function setOptionalFlowStatus(flow, status, detail) {
        var entry = flow === "wiring" ? $("wiringEntry") : flow === "diagram" ? $("diagramEntry") : null;
        if (!entry) return;
        var note = entry.querySelector(".of-note");
        if (!note) { note = document.createElement("div"); note.className = "of-note"; entry.appendChild(note); }
        note.textContent = detail || (status ? "Status: " + status : "");
        var btn = entry.querySelector("button.of-run");
        if (btn && status === "failed") { btn.disabled = false; btn.textContent = btn.dataset.label || btn.textContent; } // restore the label so the user can retry
      }
