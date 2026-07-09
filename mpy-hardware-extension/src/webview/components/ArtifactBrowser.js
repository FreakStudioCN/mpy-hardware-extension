
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
        // Resolve the board name the same way buildPlan does (agent-backed-loop.ts):
        // rich upstream manifests carry the board under mcu.board/mcu.model (no
        // board_id), so reading only board_id silently degraded to the "Target board"
        // placeholder and dropped the actual MCU from the diagram.
        const mcu = manifest && manifest.mcu;
        const boardName = (mcu && (mcu.board || mcu.model)) || (manifest && manifest.board_id) || tr("target_board");
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
