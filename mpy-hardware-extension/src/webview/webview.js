
      const vscode = typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : { postMessage: (m) => console.log(m), getState: () => null, setState: () => {} };
      const $ = (id) => document.getElementById(id);

      // ----- i18n: the whole UI follows the user's input language -----
      // Detected once per session from the first request (zh if it contains CJK,
      // else en) and locked. The model already writes its prose (summary /
      // questions) in the same language, so chrome + prose stay consistent — no
      // more English labels around a Chinese summary (or vice-versa).
      function detectLocale(text) { return /[一-鿿]/.test(String(text == null ? "" : text)) ? "zh" : "en"; }
      let LOCALE = "en";
      // The session's language is detected once (from the first request) and locked.
      // A later same-session request in another language must not flip the chrome.
      // Restart (clearConversation) resets this so the next project re-detects.
      let localeLocked = false;
      const I18N = {
        en: {
          credits: "Credits", lowCredits: "Running low on credits today.",
          stub_badge: "Stub", stub_badge_tip: "This backend runs a stub LLM: it returns a fixed reply and never generates code. Restart the API without MPYHW_LLM_STUB=1 for real output.",
          tab_activity: "Activity", tab_serial: "Serial", tab_wiring: "Wiring", tab_diagram: "Diagram", tab_artifacts: "Artifacts", tab_doctor: "Env",
          empty_artifacts_h: "No artifacts yet", empty_artifacts_p: "Files generated this session — manifest, code, wiring, diagram, drivers, and logs — appear here to open and trace.",
          art_all_phases: "All", art_open: "Open in editor", art_reveal: "Reveal in file manager", view_artifacts: "View artifacts",
          empty_doctor_h: "Checking your setup…", empty_doctor_p: "Blockless verifies what's needed to flash code to a board: Python, device tools, a connected board, and MicroPython.",
          doc_recheck: "Re-check", doc_install: "Install dependencies", doc_installing: "Installing…",
          doc_link_python: "Download Python", doc_link_firmware: "Download MicroPython", doc_open: "Open",
          doc_python_ok: "Python ready", doc_python_missing: "Python not found",
          doc_deps_ok: "Device tools ready", doc_deps_missing: "Device tools not installed", doc_deps_blocked: "Install Python first",
          doc_device_ok: "Board connected", doc_device_none: "No board connected", doc_device_multiple: "Multiple boards connected", doc_device_error: "Couldn't read the device",
          doc_mpy_ok: "MicroPython detected", doc_mpy_missing: "Board has no MicroPython",
          doc_mpy_need_device: "Connect a board to check", doc_mpy_need_port: "Pick one board to check", doc_blocked_deps: "Waiting on device tools",
          doc_mpy_recheck: "Connected — Re-check to test MicroPython", doc_mpy_probe_failed: "Couldn't check the board",
          empty_diagram_h: "No diagram yet", empty_diagram_p: "When the project architecture is generated, its module layers and run flow appear here.",
          diagram_architecture: "Architecture", diagram_flow: "Run flow", diagram_deps: "Dependencies", diagram_dataflow: "Data flow",
          welcome_t1: "Where ideas", welcome_t2: "become hardware", welcome_sub: "Hi, welcome to Blockless. Describe the hardware you want in a sentence — I'll pick the board, wire it up, write the code, and flash it to run.", start_workflow: "Start Workflow",
          import_project: "Import Existing Project", import_project_tip: "Open an existing MicroPython project folder as the workspace", recent_sessions: "Recent Sessions", recent_sessions_tip: "Browse your recent Blockless sessions in this project", recent_empty_h: "No recent sessions", recent_empty_p: "Past Blockless sessions in this project will appear here.",
          empty_serial_h: "No output", empty_serial_p: "Device output streams here after flashing.",
          empty_wiring_h: "No wiring yet", empty_wiring_p: "After codegen, the hardware layout maps to friendly signals and pins here.",
          serial_monitor: "Serial monitor",
          intent_ph: "I want to build… (e.g. light a red LED when the temperature goes above 30°C)",
          note_ph: "Add a note to this build — applied at the next safe point",
          ready: "Ready", generate: "Generate", stop: "Stop", working: "Working…", stopping: "Stopping…",
          add_note: "Add note", add_note_tip: "Add a note to the running build (applied at the next safe point)",
          kind_thinking: "Thinking", kind_note: "Note", supplement_received: "queued: {s}", supplement_applied: "{d}: {r}",
          mode_beginner: "Beginner", mode_custom: "Custom", board_auto: "Recommend board", board_browse: "Browse boards", board_browse_tip: "Browse and pick a specific board", board_search_ph: "Search official MicroPython boards", board_vendor_all: "All vendors", board_port_all: "All ports", board_mcu_all: "All MCUs", board_feature_all: "All features", board_firmware: "Official firmware", board_builtin: "Pin layout", board_official_only: "Official only", board_none: "No matching boards", board_refresh: "Refresh", board_details_tip: "Open the official download page", board_firmware_fmt: "firmware:", board_cache_stale: "Cache stale {t}", board_cache_fetched: "Fetched {t}",
          new_session: "Restart", new_session_tip: "Restart the project - clears the current conversation",
          waiting_answer: "Waiting for your answer…", review_plan: "Review the plan…", cancelled: "Cancelled",
          deploying: "Deploying…", confirm_wiring: "Confirm wiring & connection…",
          replanning: "Re-planning with your changes…", generating_code: "Generating code…",
          tp_query_board_profile: "Detecting board…", tp_search_packages: "Finding drivers…",
          tp_get_package_context: "Reading driver docs…", tp_propose_manifest: "Planning wiring…",
          tp_generate_code: "Generating code…", tp_audit_code: "Checking code…",
          tp_install_package: "Installing packages…", tp_write_main_py: "Writing to device…",
          tp_flash_and_run: "Running on device…", tp_read_serial_until: "Reading serial output…",
          tp_get_phase_profile: "Reading phase profile…", tp_read_workspace_file: "Reading workspace file…",
          tp_write_project_file: "Writing project file…",
          tp_run_validate: "Validating against schema…", tp_run_scaffold: "Generating project skeleton…",
          tp_run_download_drivers: "Downloading drivers…",
          tp_run_static_check: "Checking code…", tp_run_simulate: "Running PC simulation…",
          tp_run_triage: "Running local triage…", tp_run_hardware_sanity: "Checking hardware…",
          tp_run_extract_pdf: "Extracting PDF…", tp_run_flash_device: "Flashing device…",
          tp_scan_device: "Scanning devices…",
          kind_user: "user", kind_summary: "summary", kind_question: "question", kind_plan: "plan", kind_deploy: "deploy",
          kind_tool: "tool", kind_result: "result", kind_skill: "skill", kind_error: "error",
          type_answer: "Type your answer…", send: "Send", sent: "Sent",
          plan_intro: "Confirm the hardware, then I’ll generate the code and wiring.",
          plan_board: "Board", plan_features: "Features", plan_packages: "Packages", plan_wiring: "Wiring",
          plan_revise_ph: "Change anything? e.g. swap the OLED for a TFT, add a buzzer…",
          revise: "Revise", confirm_generate: "Confirm & generate", cancel: "Cancel",
          kind_components: "components", comp_intro: "Here are the components I planned — confirm, and tick to add or remove:", comp_confirm: "Confirm components", comp_add_ph: "Missing a part? Add it here",
          cost_step: "This step ~{n} credits", cost_used: " · {n} used this session", cost_left: " · {n} left",
          deploy_intro: "Wire it up as shown below, plug in the board, then deploy.",
          detecting_board: "Detecting board…", deploy: "Deploy", rescan: "Rescan",
          no_board: "No board detected — connect one and click Rescan.", connected: "Connected: {p}",
          multiple_devices: "Multiple devices found — pick one:",
          copy: "Copy", copied: "Copied",
          device_selected: "Device selected: {p}", files_written: "Generated files written: {p}", files_write_failed: "Generated files not written: {e}",
          saved_location: "No folder open — your project was saved to {p}", open_folder_btn: "Reveal in file manager",
          session_ended: "Session ended: {t}", tool_failed: "Step failed: {e}",
          target_board: "Target board", led_note: "⚠ LED needs a current-limiting resistor (≈220–330Ω).",
          wiring_provisional: "Preview — pins not assigned yet",
          term_generated: "Done", term_success: "Done", term_cancelled: "Stopped",
          term_awaiting_user: "Waiting for your reply", term_max_turns: "Stopped (max turns)",
          term_stalled: "Build got stuck",
          session_stuck: "The build got stuck mid-way — this is usually transient. Click retry.",
          term_manifest_unresolved: "Couldn't finish the build",
          term_repair_exhausted: "Couldn't get it working", term_session_error: "Error",
          term_sse_stream_interrupted: "Connection dropped — send again to continue",
          term_llm_unreachable: "Can't reach the server — your progress is saved",
          retry_btn: "Retry", retrying: "Network unstable — retrying ({n}/{m})…",
          err_out_of_credits: "Out of credits — resets at midnight UTC",
          err_daily_cap_reached: "Daily limit reached — resets at midnight UTC",
          err_sign_in_required: "Sign in with GitHub to start",
          err_auth_provider_unavailable: "VS Code GitHub auth is unavailable",
          err_github_session_failed: "GitHub sign-in did not complete in VS Code",
          err_github_session_unavailable: "Sign in with GitHub to start",
          err_github_token_exchange_failed: "GitHub sign-in reached the API, but token exchange failed",
          err_github_token_exchange_unreachable: "Cannot reach the auth API",
          err_github_token_missing: "Auth API returned no session token",
        },
        zh: {
          credits: "额度", lowCredits: "今日额度快用完了。",
          stub_badge: "桩", stub_badge_tip: "当前后端跑的是桩 LLM：只返回固定回复、不会真正生成代码。重启 API 时去掉 MPYHW_LLM_STUB=1 才是真实输出。",
          tab_activity: "动态", tab_serial: "串口", tab_wiring: "接线", tab_diagram: "架构图", tab_artifacts: "产物", tab_doctor: "环境",
          empty_artifacts_h: "暂无产物", empty_artifacts_p: "本次会话生成的文件（清单、代码、接线、架构图、驱动和日志）会显示在这里，可打开和追溯。",
          art_all_phases: "全部", art_open: "在编辑器中打开", art_reveal: "在文件管理器中显示", view_artifacts: "查看产物",
          empty_doctor_h: "正在检查环境…", empty_doctor_p: "Blockless 会检查把代码烧进开发板所需的一切：Python、设备工具、已连接的开发板，以及 MicroPython。",
          doc_recheck: "重新检测", doc_install: "安装依赖", doc_installing: "正在安装…",
          doc_link_python: "下载 Python", doc_link_firmware: "下载 MicroPython", doc_open: "打开",
          doc_python_ok: "Python 就绪", doc_python_missing: "未找到 Python",
          doc_deps_ok: "设备工具就绪", doc_deps_missing: "设备工具未安装", doc_deps_blocked: "请先安装 Python",
          doc_device_ok: "已连接开发板", doc_device_none: "未检测到开发板", doc_device_multiple: "检测到多块开发板", doc_device_error: "无法读取设备",
          doc_mpy_ok: "已检测到 MicroPython", doc_mpy_missing: "开发板未刷 MicroPython",
          doc_mpy_need_device: "连接开发板后检测", doc_mpy_need_port: "请选择一块开发板检测", doc_blocked_deps: "等待设备工具就绪",
          doc_mpy_recheck: "已连接——点「重新检测」测试 MicroPython", doc_mpy_probe_failed: "无法检测开发板",
          empty_diagram_h: "暂无架构图", empty_diagram_p: "生成项目架构后，模块分层与运行流程会在这里展示。",
          diagram_architecture: "架构分层", diagram_flow: "运行流程", diagram_deps: "依赖关系", diagram_dataflow: "数据流",
          welcome_t1: "让想法", welcome_t2: "变成硬件", welcome_sub: "你好，欢迎来到 Blockless。用一句话描述你想做的硬件，我来选板子、接线、写代码、烧录运行。", start_workflow: "开始工作流",
          import_project: "导入已有项目", import_project_tip: "打开一个已有的 MicroPython 项目文件夹作为工作区", recent_sessions: "最近会话", recent_sessions_tip: "浏览本项目最近的 Blockless 会话", recent_empty_h: "暂无最近会话", recent_empty_p: "本项目过往的 Blockless 会话会显示在这里。",
          empty_serial_h: "暂无输出", empty_serial_p: "烧录后，设备输出会显示在这里。",
          empty_wiring_h: "暂无接线", empty_wiring_p: "生成代码后，硬件接线会在这里以信号和引脚的形式展示。",
          serial_monitor: "串口监视器",
          intent_ph: "我想做……（例如：温度超过 30°C 时点亮一颗红色 LED）",
          note_ph: "为当前构建添加备注 — 在下一个安全点应用",
          ready: "就绪", generate: "生成", stop: "停止", working: "处理中…", stopping: "正在停止…",
          add_note: "添加备注", add_note_tip: "为运行中的构建添加备注（在下一个安全点应用）",
          kind_thinking: "思考中", kind_note: "备注", supplement_received: "已排队：{s}", supplement_applied: "{d}：{r}",
          mode_beginner: "小白", mode_custom: "自定义", board_auto: "系统推荐板卡", board_browse: "浏览板卡", board_browse_tip: "浏览并选择具体板卡", board_search_ph: "搜索官方 MicroPython 板卡", board_vendor_all: "全部品牌", board_port_all: "全部 Port", board_mcu_all: "全部 MCU", board_feature_all: "全部特性", board_firmware: "官方固件", board_builtin: "内置引脚", board_official_only: "仅官方固件", board_none: "没有匹配板卡", board_details_tip: "打开官方下载页面", board_firmware_fmt: "固件:",
          new_session: "重新开始", new_session_tip: "重新开始项目——会清空当前对话",
          waiting_answer: "等待你的回答…", review_plan: "请确认方案…", cancelled: "已取消",
          deploying: "正在部署…", confirm_wiring: "确认接线与连接…",
          replanning: "正在按你的修改重新规划…", generating_code: "正在生成代码…",
          tp_query_board_profile: "正在检测开发板…", tp_search_packages: "正在查找驱动…",
          tp_get_package_context: "正在阅读驱动文档…", tp_propose_manifest: "正在规划接线…",
          tp_generate_code: "正在生成代码…", tp_audit_code: "正在校验代码…",
          tp_install_package: "正在安装依赖…", tp_write_main_py: "正在写入设备…",
          tp_flash_and_run: "正在设备上运行…", tp_read_serial_until: "正在读取串口输出…",
          tp_get_phase_profile: "正在读取阶段配置…", tp_read_workspace_file: "正在读取工作区文件…",
          tp_write_project_file: "正在写入项目文件…",
          tp_run_validate: "正在按 schema 校验…", tp_run_scaffold: "正在生成项目骨架…",
          tp_run_download_drivers: "正在下载驱动…",
          tp_run_static_check: "正在检查代码…", tp_run_simulate: "正在运行 PC 仿真…",
          tp_run_triage: "正在本地诊断…", tp_run_hardware_sanity: "正在检查硬件…",
          tp_run_extract_pdf: "正在提取 PDF…", tp_run_flash_device: "正在烧录设备…",
          tp_scan_device: "正在扫描设备…",
          kind_user: "你", kind_summary: "总结", kind_question: "问题", kind_plan: "方案", kind_deploy: "部署",
          kind_tool: "工具", kind_result: "结果", kind_skill: "技能", kind_error: "错误",
          type_answer: "输入你的回答…", send: "发送", sent: "已发送",
          plan_intro: "确认硬件后，我就开始生成代码和接线图。",
          plan_board: "开发板", plan_features: "功能", plan_packages: "驱动包", plan_wiring: "接线",
          plan_revise_ph: "需要改什么？例如：把 OLED 换成 TFT、加一个蜂鸣器…",
          revise: "修改", confirm_generate: "确认并生成", cancel: "取消",
          kind_components: "器件", comp_intro: "以下是我帮你规划的器件清单，请确认（可勾选增减）：", comp_confirm: "确认器件", comp_add_ph: "缺了器件，需要补充",
          cost_step: "本步预计 ~{n} 额度", cost_used: " · 本次会话已用 {n}", cost_left: " · 剩余 {n}",
          deploy_intro: "按下图接线，插上开发板，然后部署。",
          detecting_board: "正在检测开发板…", deploy: "部署", rescan: "重新扫描",
          no_board: "未检测到开发板——请连接后点击“重新扫描”。", connected: "已连接：{p}",
          multiple_devices: "发现多个设备——请选择一个：",
          copy: "复制", copied: "已复制",
          device_selected: "已选择设备：{p}", files_written: "已写入生成文件：{p}", files_write_failed: "生成文件写入失败：{e}",
          saved_location: "未打开文件夹——项目已保存到 {p}", open_folder_btn: "在文件管理器中打开",
          session_ended: "会话结束：{t}", tool_failed: "步骤失败：{e}",
          target_board: "目标开发板", led_note: "⚠ LED 需要串联一个限流电阻（约 220–330Ω）。",
          wiring_provisional: "预览 — 引脚尚未分配",
          term_generated: "完成", term_success: "完成", term_cancelled: "已停止",
          term_awaiting_user: "等待你的回复", term_max_turns: "已停止（达到回合上限）",
          term_stalled: "构建卡住了",
          session_stuck: "构建中途卡住了——通常是暂时性的，点击重试。",
          term_manifest_unresolved: "未能完成本次生成",
          term_repair_exhausted: "未能让它正常运行", term_session_error: "出错",
          term_sse_stream_interrupted: "连接中断 — 再次发送即可继续",
          term_llm_unreachable: "无法连接服务器 — 进度已保留",
          retry_btn: "重试", retrying: "网络不稳定，正在重试（{n}/{m}）…",
          err_out_of_credits: "额度已用完——UTC 午夜重置",
          err_daily_cap_reached: "今日额度已达上限——UTC 午夜重置",
          err_sign_in_required: "请用 GitHub 登录后开始",
          err_auth_provider_unavailable: "VS Code 的 GitHub 登录不可用",
          err_github_session_failed: "GitHub 登录未在 VS Code 中完成",
          err_github_session_unavailable: "请用 GitHub 登录后开始",
          err_github_token_exchange_failed: "GitHub 登录已到达 API，但令牌交换失败",
          err_github_token_exchange_unreachable: "无法连接鉴权 API",
          err_github_token_missing: "鉴权 API 未返回会话令牌",
        },
      };
      function tr(key, vars) {
        let s = (I18N[LOCALE] && I18N[LOCALE][key]) || I18N.en[key] || key;
        if (vars) for (const k in vars) s = s.split("{" + k + "}").join(vars[k]);
        return s;
      }
      function sep() { return LOCALE === "zh" ? "、" : ", "; }
      // Friendly capability names (the plan card's "Features" row). Unknown ids
      // fall back to the raw identifier; package names and pins stay as-is.
      const CAP_NAMES = {
        en: { temperature_sensing: "Temperature sensing", humidity_sensing: "Humidity sensing", digital_output: "Digital output", display_text: "Text display", touch_sensing: "Touch sensing", motion_sensing: "Motion sensing", analog_input: "Analog input", sound_output: "Sound output" },
        zh: { temperature_sensing: "温度感应", humidity_sensing: "湿度感应", digital_output: "数字输出", display_text: "文字显示", touch_sensing: "触摸感应", motion_sensing: "运动感应", analog_input: "模拟输入", sound_output: "声音输出" },
      };
      function capName(id) { const m = CAP_NAMES[LOCALE] || CAP_NAMES.en; return m[id] || CAP_NAMES.en[id] || id; }
      function applyStaticI18n() {
        document.querySelectorAll("[data-i18n]").forEach((el) => { el.textContent = tr(el.getAttribute("data-i18n")); });
        document.querySelectorAll("[data-i18n-ph]").forEach((el) => { el.setAttribute("placeholder", tr(el.getAttribute("data-i18n-ph"))); });
        document.querySelectorAll("[data-i18n-title]").forEach((el) => { el.setAttribute("title", tr(el.getAttribute("data-i18n-title"))); });
      }
      // Lock the UI language for the session (first intent). Re-skins the static
      // chrome and the idle status/button when the session isn't already running.
      function setLocale(loc) {
        if (loc === LOCALE) return;
        LOCALE = loc;
        applyStaticI18n();
        if (!running) $("generate").textContent = tr("generate");
      }

      // ----- device list (from API, never hardcoded) -----
      // Board selection happens in the conversation (the agent recommends and
      // confirms via ask_user), not a header dropdown. Start is gated only by
      // quota; the board is decided in chat.
      function updateGenerateEnabled() {
        // Two independent blocks: quotaExhausted follows the live balance (credits
        // events recompute it), while capBlockedUntil is the sticky daily-cap hold —
        // a capped user's balance is typically > 0, so a credits refresh must not
        // lift it. It expires on its own once the deadline (next UTC midnight)
        // passes; credits events are the natural re-check points.
        $("generate").disabled = (!running && (quotaExhausted || Date.now() < capBlockedUntil));
      }

      // ----- Python highlighter (ported from the design's highlight.js) -----
      const KW = new Set(["from","import","as","def","return","if","else","elif","while","for","in","not","and","or","class","with","try","except","finally","pass","break","continue","global","nonlocal","lambda","yield","raise","assert","del","is","await","async"]);
      const CONSTS = new Set(["None","True","False","self"]);
      const RE = /(#[^\n]*)|("""[\s\S]*?"""|'''[\s\S]*?''')|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|(\b\d[\d_]*\.?\d*\b)|([A-Za-z_][A-Za-z0-9_]*)(?=\s*\()|([A-Za-z_][A-Za-z0-9_]*)/g;
      function tokenize(code) {
        const out = []; let last = 0, m; RE.lastIndex = 0;
        while ((m = RE.exec(code)) !== null) {
          if (m.index > last) out.push({ text: code.slice(last, m.index), cls: "" });
          if (m[1]) out.push({ text: m[1], cls: "tok-comment" });
          else if (m[2] || m[3]) out.push({ text: m[2] || m[3], cls: "tok-string" });
          else if (m[4]) out.push({ text: m[4], cls: "tok-num" });
          else { const w = m[5] || m[6];
            const cls = KW.has(w) ? "tok-kw" : CONSTS.has(w) ? "tok-const" : (m[5] ? "tok-fn" : "");
            out.push({ text: w, cls }); }
          last = RE.lastIndex;
        }
        if (last < code.length) out.push({ text: code.slice(last), cls: "" });
        return out;
      }
      function highlightLines(code) {
        const lines = [[]];
        for (const t of tokenize(code)) {
          const parts = t.text.split("\n");
          for (let i = 0; i < parts.length; i++) {
            if (i > 0) lines.push([]);
            if (parts[i] !== "") lines[lines.length - 1].push({ text: parts[i], cls: t.cls });
          }
        }
        return lines;
      }

      // ----- tab state -----
      let activeTab = "activity";
      let running = false;
      let quotaExhausted = false;
      // Daily-cap hold (ms epoch): set when the server 402s with daily_cap_reached,
      // lifts at the next UTC midnight. The 402's resets_at never reaches this layer
      // (llm-client keeps only detail.error), but the cap resets at UTC midnight by
      // definition — the same deadline the server's resets_at carries — so derive it.
      let capBlockedUntil = 0;
      let selectedMode = "beginner";
      let officialBoards = [];
      let selectedOfficialBoard = null;
      let boardCacheFetchedAt = "";
      let boardCacheStale = false;
      let boardPage = 0;
      const BOARD_PAGE_SIZE = 6;

      function setMode(mode) {
        selectedMode = mode === "custom" ? "custom" : "beginner";
        document.querySelectorAll(".mode-chip").forEach((b) => b.classList.toggle("active", b.dataset.mode === selectedMode));
        vscode.setState({ ...(vscode.getState() || {}), mode: selectedMode }); // remember across panel reopens
      }
      function setBoardPickerVisible(visible) {
        $("boardPicker").classList.toggle("hidden", !visible);
      }
      // The board picker body (search + filters + list) is collapsed by default so
      // it doesn't bury the welcome; Start Workflow and the disclosure open it.
      function setBoardBodyExpanded(expanded) {
        $("boardPickerBody").hidden = !expanded;
        const more = $("boardMore");
        more.setAttribute("aria-expanded", expanded ? "true" : "false");
        more.classList.toggle("open", expanded);
      }
      function boardLabel(board) { return board.display_name || board.id || board.download_slug || ""; }
      function optionLabelAll(key) { return tr(key); }
      function setFilterOptions(id, values, allKey) {
        const el = $(id); if (!el) return;
        const current = el.value;
        el.innerHTML = '<option value="">' + esc(optionLabelAll(allKey)) + '</option>' + values.map((v) => '<option value="' + esc(v) + '">' + esc(v) + '</option>').join("");
        if (values.includes(current)) el.value = current;
      }
      function boardFiltersFromPayload(msg) {
        const filters = msg.filters || {};
        const uniq = (key, fallback) => (Array.isArray(filters[key]) && filters[key].length ? filters[key] : Array.from(new Set(officialBoards.flatMap((b) => { const v = fallback(b); return Array.isArray(v) ? v : [v]; }).filter(Boolean))).sort());
        return {
          vendor: uniq("vendor", (b) => b.vendor),
          port: uniq("port", (b) => b.port),
          mcu: uniq("mcu", (b) => b.mcu),
          feature: uniq("feature", (b) => b.features || []),
        };
      }
      function loadOfficialBoards(msg) {
        officialBoards = Array.isArray(msg.boards) ? msg.boards : [];
        const filters = boardFiltersFromPayload(msg);
        setFilterOptions("boardVendor", filters.vendor, "board_vendor_all");
        setFilterOptions("boardPort", filters.port, "board_port_all");
        setFilterOptions("boardMcu", filters.mcu, "board_mcu_all");
        setFilterOptions("boardFeature", filters.feature, "board_feature_all");
        boardCacheFetchedAt = msg.fetched_at || "";
        boardCacheStale = !!msg.stale;
        $("boardPicker").dataset.fetchedAt = boardCacheFetchedAt;
        $("boardPicker").dataset.sourceUrl = msg.source_url || "";
        $("boardPicker").dataset.stale = boardCacheStale ? "true" : "false";
        boardPage = 0;
        renderBoardPicker();
      }
      function renderBoardCacheStatus() {
        const el = $("boardCacheStatus");
        if (!el) return;
        el.textContent = boardCacheFetchedAt ? tr(boardCacheStale ? "board_cache_stale" : "board_cache_fetched", { t: boardCacheFetchedAt }) : "";
      }
      function currentBoardMatches(board) {
        const q = ($("boardSearch")?.value || "").trim().toLowerCase();
        const vendor = $("boardVendor")?.value || "";
        const port = $("boardPort")?.value || "";
        const mcu = $("boardMcu")?.value || "";
        const feature = $("boardFeature")?.value || "";
        const hay = [board.id, board.display_name, board.vendor, board.port, board.mcu, board.download_slug].concat(board.features || []).join(" ").toLowerCase();
        return (!q || hay.includes(q))
          && (!vendor || board.vendor === vendor)
          && (!port || board.port === port)
          && (!mcu || board.mcu === mcu)
          && (!feature || (board.features || []).includes(feature));
      }
      function filteredOfficialBoards() { return officialBoards.filter(currentBoardMatches); }
      // Board-selector doc §3 badges: firmware availability + the local-layout state
      // (derived from the canonical support_status; local_support is a view helper only).
      function boardBadges(board) {
        const badges = [];
        if (board.firmware) badges.push(tr("board_firmware"));
        badges.push(board.support_status === "builtin_pin_layout" ? tr("board_builtin") : tr("board_official_only"));
        return badges;
      }
      // The official download page for a board (board-selector doc §3 "Board details").
      function boardDetailUrl(board) { return board.detail_url || (board.firmware && board.firmware.url) || ""; }
      // ponytail: the API sends no firmware.format and firmware.url is a download *page*
      // (no file extension), so we map the port/family to its flashing format — the same
      // taxonomy the hardware-acceptance cards use (esp32→bin, rp2→uf2, stm32→dfu/hex).
      // A real backend firmware.format field would supersede this heuristic.
      var PORT_FIRMWARE_FORMAT = { esp32: "bin", esp8266: "bin", rp2: "uf2", samd: "uf2", stm32: "dfu/hex", nrf: "hex", mimxrt: "hex" };
      function firmwareFormat(board) { return board.firmware ? (PORT_FIRMWARE_FORMAT[board.port] || "") : ""; }
      function renderBoardPicker() {
        const list = $("boardList"); const status = $("boardStatus");
        if (!list || !status) return;
        renderBoardCacheStatus();
        const boards = filteredOfficialBoards();
        const maxPage = Math.max(0, Math.ceil(boards.length / BOARD_PAGE_SIZE) - 1);
        boardPage = Math.min(boardPage, maxPage);
        const start = boardPage * BOARD_PAGE_SIZE;
        const page = boards.slice(start, start + BOARD_PAGE_SIZE);
        list.innerHTML = page.map((board) => {
          const chosen = selectedOfficialBoard && selectedOfficialBoard.id === board.id;
          const badges = boardBadges(board).map((b) => '<span class="board-badge">' + esc(b) + '</span>').join("");
          const fmt = firmwareFormat(board);
          const meta = [board.vendor, board.port, board.mcu, (board.features || []).join("/"), fmt ? (tr("board_firmware_fmt") + " " + fmt) : ""].filter(Boolean).join(" | ");
          const url = boardDetailUrl(board);
          const detail = url ? '<button type="button" class="board-detail" data-detail-url="' + esc(url) + '" title="' + esc(tr("board_details_tip")) + '" aria-label="' + esc(tr("board_details_tip")) + '"><svg width="12" height="12" viewBox="0 0 24 24" fill="none"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14L21 3" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></button>' : "";
          return '<div class="board-row"><button type="button" class="board-card' + (chosen ? ' chosen' : '') + '" data-board-id="' + esc(board.id) + '"><div class="board-card-top"><span>' + esc(boardLabel(board)) + '</span><span class="board-badges">' + badges + '</span></div><div class="board-meta">' + esc(meta || board.download_slug) + '</div></button>' + detail + '</div>';
        }).join("");
        list.querySelectorAll(".board-card").forEach((btn) => btn.addEventListener("click", () => {
          selectedOfficialBoard = officialBoards.find((b) => b.id === btn.dataset.boardId) || null;
          $("boardAuto").classList.toggle("chosen", selectedOfficialBoard == null);
          renderBoardPicker();
        }));
        // Open the official download page; stop the click so it doesn't also select the card.
        list.querySelectorAll(".board-detail").forEach((a) => a.addEventListener("click", (e) => {
          e.stopPropagation();
          vscode.postMessage({ type: "open_external", url: a.dataset.detailUrl });
        }));
        const total = boards.length;
        status.textContent = total ? (String(start + 1) + "-" + String(start + page.length) + "/" + String(total)) : tr("board_none");
        $("boardPrev").disabled = boardPage <= 0;
        $("boardNext").disabled = boardPage >= maxPage;
      }
      function setTab(name) {
        activeTab = name;
        document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
        document.querySelectorAll(".view").forEach((v) => v.classList.toggle("hidden", v.dataset.view !== name));
        const tabBtn = document.querySelector('.tab[data-tab="' + name + '"]');
        const dot = tabBtn && tabBtn.querySelector(".newdot");
        if (dot) dot.remove();
      }
      function markNew(name) {
        if (activeTab === name) return;
        const tabBtn = document.querySelector('.tab[data-tab="' + name + '"]');
        if (tabBtn && !tabBtn.querySelector(".newdot") && !tabBtn.querySelector(".pulse")) {
          const d = document.createElement("span"); d.className = "newdot"; tabBtn.appendChild(d);
        }
      }
      document.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => setTab(t.dataset.tab)));
      // A global tool opens as a full-body surface over the workflow (stages + composer
      // hide), not inside the stage content area. Each global tool has its own surface;
      // opening one shows it and hides the others + the workflow.
      const GLOBAL_TOOL_HIDES = ["#globalTools", "#tabs", ".tabwrap", ".composer"];
      const GLOBAL_TOOL_SURFACES = ["toolGenDriver", "toolSupport", "toolRecent"];
      function openGlobalTool(id) {
        for (const sel of GLOBAL_TOOL_HIDES) document.querySelector(sel).classList.add("hidden");
        for (const t of GLOBAL_TOOL_SURFACES) $(t).classList.toggle("hidden", t !== id);
      }
      function closeGlobalTool() {
        for (const t of GLOBAL_TOOL_SURFACES) $(t).classList.add("hidden");
        for (const sel of GLOBAL_TOOL_HIDES) document.querySelector(sel).classList.remove("hidden");
      }
      $("genDriverOpen").addEventListener("click", () => openGlobalTool("toolGenDriver"));
      $("genDriverBack").addEventListener("click", closeGlobalTool);
      $("supportOpen").addEventListener("click", () => openGlobalTool("toolSupport"));
      $("supportBack").addEventListener("click", closeGlobalTool);
      // Home hero action: begin a build. The composer is always mounted, so "start"
      // just reveals the board picker and focuses the prompt (no session yet).
      // ponytail: the rest of the launch-area inventory (Device Tools=Day-7, Git
      // history / Save Version per spec 3.8) is still stubbed pending its own cards.
      $("startWorkflow").addEventListener("click", () => { setBoardPickerVisible(true); setBoardBodyExpanded(true); $("intent").focus(); });
      // Import Existing Project: host opens a folder picker then reloads on that
      // folder (no webview surface). Recent Sessions: read-only list of past session
      // summaries in a global-tool surface; the host serves them from .mpyhw/sessions.
      $("importProject").addEventListener("click", () => vscode.postMessage({ type: "import_project" }));
      $("recentSessions").addEventListener("click", () => { openGlobalTool("toolRecent"); vscode.postMessage({ type: "request_recent_sessions" }); });
      $("recentBack").addEventListener("click", closeGlobalTool);
      $("boardMore").addEventListener("click", () => setBoardBodyExpanded($("boardPickerBody").hidden));

      // ----- composer / working indicator -----
      // The single "AI is working" affordance is the in-feed spinner card
      // (setPending). It appears the moment a turn starts and re-arms on each tool
      // step (see trace_event), labelled with the current curated phase — never the
      // model's raw reasoning. There is no separate status bar.
      function setRunning(on) {
        running = on;
        if (on) terminalShown = false; // a fresh run (or retry) may end again
        const btn = $("generate");
        btn.textContent = on ? tr("stop") : tr("generate");
        btn.classList.toggle("stop", on);
        // The "add note" affordance is only meaningful while a build is running: it queues
        // a supplement for the next safe point (deliverables 07). Hidden otherwise. The
        // composer placeholder flips to a note hint too, so it doesn't read as "start a
        // build" while running.
        $("addNote").classList.toggle("hidden", !on);
        $("intent").placeholder = tr(on ? "note_ph" : "intent_ph");
        if (on) setPending(tr("working")); // immediate spinner; trace_event refines the label
        updateGenerateEnabled();
      }
      $("generate").addEventListener("click", () => {
        if (running) { vscode.postMessage({ type: "cancel_session" }); setPending(tr("stopping")); return; }
        const intent = $("intent").value.trim();
        if (!intent) return;
        document.querySelectorAll(".newdot").forEach((d) => d.remove());
        document.querySelectorAll(".tab .pulse").forEach((p) => p.remove());
        // Lock the session's UI language to the FIRST request's language before
        // anything renders, so chrome + the model's prose stay in one language. A
        // later same-session request in another language keeps the locked language
        // (the backend pins prose to the first message too); Restart re-detects.
        if (!localeLocked) { setLocale(detectLocale(intent)); localeLocked = true; }
        finalizeThinking();
        addUserMessage(intent);
        $("intent").value = "";
        $("intent").style.height = "auto";
        setTab("activity"); setBoardPickerVisible(false); setRunning(true);
        const preSelectedBoard = selectedOfficialBoard;
        const boardId = preSelectedBoard && preSelectedBoard.local_board_id ? preSelectedBoard.local_board_id : "auto";
        const msg = { type: "start_session", intent, boardId, pre_selected_board: preSelectedBoard || null, preferences: { mode: selectedMode } };
        if (!preSelectedBoard) msg.board_selection_mode = "recommend"; // board-selector doc §6 recommend path
        vscode.postMessage(msg);
      });
      // Add-note (mid-build supplement): queue the composer text as a supplement without
      // interrupting the run. The host applies it at the next safe point and echoes a
      // user_supplement_received into the feed. Cleared optimistically here.
      $("addNote").addEventListener("click", () => {
        if (!running) return;
        const text = $("intent").value.trim();
        if (!text) return;
        vscode.postMessage({ type: "user_supplement", text });
        $("intent").value = "";
        $("intent").style.height = "auto";
      });
      // Wipe every per-conversation surface back to its empty state. The host clears
      // its durable state in parallel (reset_session), so the next request is a
      // brand-new build, not a continuation. The locked UI language is left as-is —
      // the next intent re-locks it (setLocale is a no-op when unchanged).
      function clearConversation() {
        $("activity").innerHTML = "";
        $("activityEmpty").classList.remove("hidden");
        $("serial").innerHTML = "";
        $("serialFilled").classList.add("hidden");
        $("serialEmpty").classList.remove("hidden");
        $("serialHead").classList.remove("live");
        $("wiring").innerHTML = "";
        $("wiringEmpty").classList.remove("hidden");
        $("diagram").innerHTML = "";
        $("diagramEmpty").classList.remove("hidden");
        ARTIFACTS = []; artifactPhase = ""; artifactsLinkShown = false; drawArtifacts();
        finalizeThinking(); currentCode = null; currentSummary = null;
        currentDeployCard = null; pendingCard = null; pendingLabel = "";
        localeLocked = false; // next project re-detects its language (LOCALE left as-is until then)
        document.querySelectorAll(".newdot").forEach((d) => d.remove());
        document.querySelectorAll(".tab .pulse").forEach((p) => p.remove());
        setBoardPickerVisible(true);
        setTab("activity");
      }
      $("newSession").addEventListener("click", () => {
        vscode.postMessage({ type: "reset_session" });
        setRunning(false);
        clearConversation();
        $("intent").value = ""; $("intent").style.height = "auto";
      });
      const ta = $("intent");
      $("modeBeginner").addEventListener("click", () => setMode("beginner"));
      $("modeCustom").addEventListener("click", () => setMode("custom"));
      // restore the last-used mode across panel reopens (persisted in setMode)
      const savedMode = (vscode.getState() || {}).mode;
      if (savedMode) setMode(savedMode);
      $("boardAuto").addEventListener("click", () => { selectedOfficialBoard = null; $("boardAuto").classList.add("chosen"); renderBoardPicker(); });
      $("boardRefresh").addEventListener("click", () => vscode.postMessage({ type: "request_boards" }));
      ["boardSearch", "boardVendor", "boardPort", "boardMcu", "boardFeature"].forEach((id) => { const el = $(id); el.addEventListener("input", () => { boardPage = 0; renderBoardPicker(); }); el.addEventListener("change", () => { boardPage = 0; renderBoardPicker(); }); });
      $("boardPrev").addEventListener("click", () => { boardPage = Math.max(0, boardPage - 1); renderBoardPicker(); });
      $("boardNext").addEventListener("click", () => { boardPage += 1; renderBoardPicker(); });
      renderBoardPicker();
      ta.addEventListener("focus", () => $("composerBox").classList.add("focused"));
      ta.addEventListener("blur", () => $("composerBox").classList.remove("focused"));
      ta.addEventListener("input", () => { ta.style.height = "auto"; ta.style.height = Math.min(ta.scrollHeight, 120) + "px"; });

      // ----- Activity -----
      function isInternalActivity(text) {
        return /^ask_user:/.test(text) || /^Agent session /.test(text) || /^→\s*\w+/.test(text);
      }
      function classifyActivity(text) {
        if (/^→/.test(text)) return "tool";
        if (/fail|error|crash|exhaust/i.test(text)) return "error";
        if (/generated|finished|done|success|ready|complete/i.test(text)) return "result";
        if (/loaded skill|skill:/i.test(text)) return "skill";
        return "thinking";
      }
      const ICONS = { thinking: "•", skill: "•", tool: "•", result: "•", error: "•", note: "•" };
      let currentThink = null; // open thinking card's text node, or null
      let currentThinkCard = null; // the open thinking card element (live = spinner + heading), or null
      let terminalShown = false; // guards the once-per-session terminal line (session_done is posted twice on cancel: optimistic + loop-unwind)
      let currentCode = null;  // open streaming code card { pre, host, path }, or null
      let currentSummary = null; // open streaming reply card { card, sum, raw }, or null
      // In-feed "working" indicator. After a user action (confirm plan / answer) the
      // next visible event is the LLM's first token, which can be seconds away — an
      // empty feed reads as a hang. setPending drops an immediate spinner card; the
      // heartbeat ticks its label, and any real content clears it.
      let pendingCard = null, pendingLabel = "";
      function setPending(label) {
        pendingLabel = label;
        if (!pendingCard) {
          $("activityEmpty").classList.add("hidden");
          pendingCard = document.createElement("div");
          pendingCard.className = "ev fade-in feed-pending";
          pendingCard.innerHTML = '<div class="ev-card"><div class="ev-head"><div class="ev-ico thinking"><span class="feed-spin"></span></div><div class="ev-main"><div class="ev-think pending-label"></div></div></div></div>';
          $("activity").appendChild(pendingCard);
        }
        pendingCard.querySelector(".pending-label").textContent = label;
        const w = $("activity").parentElement; w.scrollTop = w.scrollHeight;
      }
      function clearPending() { if (pendingCard) { pendingCard.remove(); pendingCard = null; } }
      // Settle the open thinking card: spinner -> dot, drop the "Thinking" heading. Called
      // whenever the thinking stream closes (a non-thinking event, code/summary, or reset).
      function finalizeThinking() {
        if (currentThinkCard) {
          const ico = currentThinkCard.querySelector(".ev-ico");
          if (ico) { ico.classList.remove("think-live"); ico.textContent = ICONS.thinking; }
          const head = currentThinkCard.querySelector(".think-head");
          if (head) head.remove();
        }
        currentThink = currentThinkCard = null;
      }
      function prefillImportedRecipe(payload) {
        const prompt = String((payload && (payload.prompt || payload.starter_prompt || payload.intent)) || "").trim();
        if (!prompt) return;
        const input = $("intent");
        input.value = prompt;
        input.style.height = "auto";
        input.style.height = Math.min(input.scrollHeight, 120) + "px";
        setTab("activity");
        clearPending();
        addActivity({ text: "Recipe imported from website. Review the prompt, then Generate." });
        input.focus();
      }
      // Map a trace event to a working-spinner label: only a recognized tool name
      // yields a curated, localized phase string; anything else (including raw
      // prose in ev.text) falls back to the neutral label — chain-of-thought can't
      // leak through here.
      function phaseLabel(ev) {
        const key = ev && ev.toolName ? "tp_" + ev.toolName : "";
        return (key && tr(key) !== key) ? tr(key) : tr("working");
      }
      // Render a safe subset of markdown (headings, bullets, ordered lists, bold,
      // inline code, paragraphs). HTML is escaped first, so LLM output cannot
      // inject markup — the regexes only re-introduce our own tags.
      function escapeHtml(s) {
        return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      }
      function mdInline(s) {
        return s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
                .replace(/`([^`]+)`/g, "<code>$1</code>");
      }
      function renderMarkdown(src) {
        const out = []; let list = null;
        const close = () => { if (list) { out.push("</" + list + ">"); list = null; } };
        const open = (tag) => { if (list !== tag) { close(); out.push("<" + tag + ">"); list = tag; } };
        for (const raw of escapeHtml(src).split("\n")) {
          const t = raw.trim();
          if (!t) { close(); continue; }
          let m;
          if (m = t.match(/^#{1,6}\s+(.*)$/)) { close(); out.push('<div class="md-h">' + mdInline(m[1]) + "</div>"); continue; }
          if (m = t.match(/^\d+\.\s+(.*)$/)) { open("ol"); out.push("<li>" + mdInline(m[1]) + "</li>"); continue; }
          if (m = t.match(/^[-*](?!\*)\s*(.+)$/)) { open("ul"); out.push("<li>" + mdInline(m[1]) + "</li>"); continue; }
          close(); out.push("<div>" + mdInline(t) + "</div>");
        }
        close();
        return out.join("");
      }
      // Steady-rate typewriter. feed() appends text to reveal char-by-char into `el`
      // (plain text while typing); end() swaps in rendered markdown once the reveal
      // catches up. Streamed text (summary deltas, code deltas) and atomic text (a
      // question or plan written in one shot) all flow through it, so everything
      // types out at a uniform cadence. Without requestAnimationFrame (jsdom tests)
      // it renders the full text synchronously, so the DOM is complete at once.
      //   opts.cpms       — reveal rate in chars/ms (default 0.7 ≈ 700/s).
      //   opts.maxBacklog — when buffered-but-unshown text exceeds this many chars,
      //                     stop pacing and jump to the end. The text is already
      //                     here, so revealing a big block slowly would only add lag
      //                     (e.g. a whole file landing in one burst). Default: no cap.
      //   opts.settle     — committer for end(): default renders markdown; code
      //                     passes a plain-text settler so its #/* aren't parsed.
      function makeTypewriter(el, scroll, opts) {
        opts = opts || {};
        const animated = typeof requestAnimationFrame === "function";
        const CPMS = opts.cpms || 0.7; // chars per ms — faster than the model generates
        const maxBacklog = opts.maxBacklog || Infinity;
        const commit = opts.settle || ((node, text) => { node.innerHTML = renderMarkdown(text); });
        let target = "", shown = 0, raf = null, last = 0, ended = false, stopped = false;
        const settle = () => { commit(el, target); if (scroll) scroll(); };
        function frame(ts) {
          if (stopped) { raf = null; return; }
          if (!last) { last = ts; raf = requestAnimationFrame(frame); return; }
          shown = Math.min(target.length, shown + Math.max(1, Math.round(CPMS * (ts - last))));
          if (target.length - shown > maxBacklog) shown = target.length; // burst: skip the wait
          last = ts;
          el.textContent = target.slice(0, shown);
          if (scroll) scroll();
          if (shown < target.length) { raf = requestAnimationFrame(frame); return; }
          raf = null; last = 0;
          if (ended) settle();
        }
        const pump = () => { if (animated && raf === null && shown < target.length) { last = 0; raf = requestAnimationFrame(frame); } };
        return {
          feed(t) {
            target += (t == null ? "" : String(t));
            if (!animated) { el.textContent = target; if (scroll) scroll(); return; }
            pump();
          },
          end(finalText) {
            if (finalText != null) target = String(finalText);
            ended = true;
            if (!animated || shown >= target.length) { if (raf === null) settle(); }
            else pump();
          },
          // Halt the reveal without committing — used when the caller is about to
          // replace `el` (the code card swaps its <pre> for highlighted rows).
          stop() { stopped = true; },
        };
      }
      function addUserMessage(text) {
        $("activityEmpty").classList.add("hidden");
        const card = document.createElement("div");
        card.className = "ev fade-in";
        card.innerHTML = '<div class="ev-card"><div class="ev-head"><div class="ev-ico result">•</div><div class="ev-main"><div class="ev-label"><span class="kind">' + tr("kind_user") + '</span></div><div class="ev-sum"></div></div></div></div>';
        card.querySelector(".ev-sum").textContent = text;
        $("activity").appendChild(card);
        const w = $("activity").parentElement;
        w.scrollTop = w.scrollHeight;
      }
      // Open an empty result card with a typewriter bound to its prose element.
      function openSummaryCard() {
        $("activityEmpty").classList.add("hidden");
        const card = document.createElement("div");
        card.className = "ev fade-in";
        card.innerHTML = '<div class="ev-card"><div class="ev-head"><div class="ev-ico result">•</div><div class="ev-main"><div class="ev-label"><span class="kind">' + tr("kind_summary") + '</span></div><div class="ev-sum"></div></div></div></div>';
        $("activity").appendChild(card);
        const scroll = () => { const w = $("activity").parentElement; w.scrollTop = w.scrollHeight; };
        scroll();
        return { card, tw: makeTypewriter(card.querySelector(".ev-sum"), scroll) };
      }
      // A token of the model's reply: feed the open card's typewriter, opening one
      // on the first token. The text types out char-by-char; addSummary() ends it.
      function streamSummaryDelta(text) {
        clearPending();
        finalizeThinking();
        if (!currentSummary) currentSummary = openSummaryCard();
        currentSummary.tw.feed(text);
      }
      // The agent's final reply. Ends the open card's typewriter (typing out any
      // remaining buffered text, then rendering markdown). A non-streamed path
      // (template loop) lands here with no open card and types the whole thing.
      function addSummary(text) {
        const t = (text == null ? "" : String(text)).trim();
        if (!t) { discardSummary(); return; }
        finalizeThinking(); clearPending();
        if (!currentSummary) currentSummary = openSummaryCard();
        currentSummary.tw.end(t);
        currentSummary = null;
      }
      // Drop the in-progress streamed reply: its turn called a tool, so the prose
      // was mid-process narration, not the final answer.
      function discardSummary() {
        if (currentSummary) { currentSummary.card.remove(); currentSummary = null; }
      }
      // Seal the in-progress streamed reply instead of dropping it: ask_user's
      // lead-in prose stays on screen (typewriter finishes, then renders markdown)
      // above the question card that follows.
      function sealSummary() {
        if (currentSummary) { currentSummary.tw.end(); currentSummary = null; }
      }
      function addActivity(ev, forcedKind) {
        const text = (ev && typeof ev.text === "string") ? ev.text : JSON.stringify(ev);
        if (!text) return;
        if (isInternalActivity(text)) return;
        clearPending();
        $("activityEmpty").classList.add("hidden");
        // forcedKind lets a discrete event (e.g. a user note) render as its own card
        // instead of being text-classified and coalesced into the open thinking stream.
        const kind = forcedKind || classifyActivity(text);
        const scroll = () => { const w = $("activity").parentElement; w.scrollTop = w.scrollHeight; };
        // The agent streams thinking token-by-token (each delta is its own
        // trace_event). Coalesce consecutive thinking deltas into one growing
        // card instead of a new card per token.
        if (kind === "thinking") {
          if (currentThink) { currentThink.textContent += text; scroll(); return; }
          // Only LIVE (spinner + "Thinking" heading) while a build is running — an
          // uncategorized line that lands after the session ends (e.g. "Session ended:
          // Stopped") must render static, or its spinner would never settle.
          const live = running;
          const card = document.createElement("div");
          card.className = "ev fade-in";
          const ico = live ? '<div class="ev-ico thinking think-live"><span class="feed-spin"></span></div>' : '<div class="ev-ico thinking">' + ICONS.thinking + "</div>";
          const head = live ? '<div class="ev-label think-head"><span class="kind">' + tr("kind_thinking") + "</span></div>" : "";
          card.innerHTML = '<div class="ev-card"><div class="ev-head">' + ico + '<div class="ev-main">' + head + '<div class="ev-think"></div></div></div></div>';
          currentThink = card.querySelector(".ev-think");
          currentThinkCard = live ? card : null; // only a live card needs finalizing
          currentThink.textContent = text;
          $("activity").appendChild(card);
          scroll();
          return;
        }
        finalizeThinking(); // any non-thinking event closes + settles the open stream
        const card = document.createElement("div");
        card.className = "ev fade-in";
        const ico = '<div class="ev-ico ' + kind + '">' + ICONS[kind] + "</div>";
        if (kind === "tool") {
          card.innerHTML = '<div class="ev-card"><div class="ev-head">' + ico + '<div class="ev-main"><div class="ev-label"><span class="kind">' + tr("kind_tool") + '</span><span class="ev-tool"></span></div></div></div></div>';
          card.querySelector(".ev-tool").textContent = text.replace(/^→\s*/, "");
        } else {
          const cls = kind === "error" ? " is-error" : "";
          const label = kind === "result" ? tr("kind_result") : kind === "skill" ? tr("kind_skill") : kind === "note" ? tr("kind_note") : tr("kind_error");
          card.innerHTML = '<div class="ev-card"><div class="ev-head">' + ico + '<div class="ev-main"><div class="ev-label"><span class="kind">' + label + '</span></div><div class="ev-sum' + cls + '"></div></div></div></div>';
          card.querySelector(".ev-sum").innerHTML = renderMarkdown(text);
        }
        $("activity").appendChild(card);
        scroll();
      }

      // One-click retry after a transport failure (llm_unreachable / interrupted
      // stream). The host kept the session state, so retry_session re-issues the
      // interrupted turn; the button disables itself so it can't double-fire.
      function addRetryCard() {
        const card = document.createElement("div");
        card.className = "ev fade-in";
        const btn = document.createElement("button");
        btn.className = "retry-session";
        btn.textContent = tr("retry_btn");
        btn.addEventListener("click", () => {
          btn.disabled = true;
          setTab("activity"); setRunning(true);
          vscode.postMessage({ type: "retry_session" });
        });
        card.appendChild(btn);
        $("activity").appendChild(card);
        const w = $("activity").parentElement; w.scrollTop = w.scrollHeight;
      }

      // Fallback-save notice: no workspace was open, so the project went to the
      // extension's globalStorage dir. Show where, with a button that asks the host
      // to reveal it in the OS file manager (button → host action, like the doctor).
      function addSavedLocation(path) {
        if (!path) return;
        clearPending();
        $("activityEmpty").classList.add("hidden");
        finalizeThinking();
        const card = document.createElement("div");
        card.className = "ev fade-in";
        card.innerHTML = '<div class="ev-card"><div class="ev-head"><div class="ev-ico result">' + ICONS.result + '</div><div class="ev-main"><div class="ev-label"><span class="kind">' + tr("kind_result") + '</span></div><div class="ev-sum"></div></div></div></div>';
        card.querySelector(".ev-sum").textContent = tr("saved_location", { p: path });
        const btn = document.createElement("button");
        btn.className = "doc-fix";
        btn.textContent = tr("open_folder_btn");
        btn.addEventListener("click", () => vscode.postMessage({ type: "open_path", path }));
        card.querySelector(".ev-main").appendChild(btn);
        $("activity").appendChild(card);
        const w = $("activity").parentElement; w.scrollTop = w.scrollHeight;
      }

      // ----- ask_user (interactive prompt; pauses the agent until answered) -----
      // options: clickable choices. optionsRequiringText: the subset of those that
      // mean "I'll provide a value" — clicking one holds the choice and waits for the
      // user to type that value (a URL/number/path) instead of ending the turn empty.
      // Protocol approval_request: the single rich card (replaces ask/components/
      // plan/deploy). Items render as checkboxes (default selected), actions as
      // buttons; the chosen action + selected ids + text values ride back as a
      // ui_prompt_response, which the controller resolves into approval_response.
      function addApprovalPrompt(promptId, card) {
        finalizeThinking();
        clearPending();
        $("activityEmpty").classList.add("hidden");
        setTab("activity");
        card = card || {};
        const items = Array.isArray(card.items) ? card.items : [];
        // item_groups is contract-valid as either an array OR an object map; an object
        // form was being dropped here, hiding its items from the user. Normalize both.
        const groups = Array.isArray(card.item_groups) ? card.item_groups : Object.values(card.item_groups || {});
        const actions = (Array.isArray(card.actions) && card.actions.length) ? card.actions : [{ label: tr("send"), value: "confirm", primary: true }];
        const textInputs = Array.isArray(card.text_inputs) ? card.text_inputs : [];
        const el = document.createElement("div");
        el.className = "ev fade-in";
        const wrap = document.createElement("div"); wrap.className = "ev-card ask"; wrap.dataset.promptId = String(promptId);
        const head = document.createElement("div"); head.className = "ev-head";
        const main = document.createElement("div"); main.className = "ev-main";
        const label = document.createElement("div"); label.className = "ev-label";
        const kind = document.createElement("span"); kind.className = "kind";
        kind.textContent = card.header ? String(card.header) : tr("kind_question");
        label.appendChild(kind); main.appendChild(label);
        const q = document.createElement("div"); q.className = "ev-sum ask-q";
        q.textContent = card.question == null ? "" : String(card.question);
        main.appendChild(q);
        const checks = [];
        const renderItem = (it) => {
          if (!it || typeof it !== "object") return;
          const row = document.createElement("label"); row.className = "ask-opt"; row.style.display = "block";
          const cb = document.createElement("input"); cb.type = "checkbox";
          cb.checked = it.selected !== false; cb.dataset.id = it.id == null ? "" : String(it.id);
          cb.disabled = it.selectable === false; checks.push(cb); row.appendChild(cb);
          const span = document.createElement("span");
          span.textContent = " " + (it.name == null ? "" : String(it.name)) + (it.subtitle ? " — " + String(it.subtitle) : "");
          row.appendChild(span); main.appendChild(row);
        };
        items.forEach(renderItem);
        groups.forEach((g) => (Array.isArray(g && g.items) ? g.items : []).forEach(renderItem));
        const textEls = {};
        textInputs.forEach((ti) => {
          if (!ti || typeof ti !== "object") return;
          const row = document.createElement("div"); row.className = "ask-row";
          const inp = document.createElement("input"); inp.className = "ask-input"; inp.type = "text";
          if (ti.placeholder) inp.placeholder = String(ti.placeholder);
          textEls[ti.id == null ? "" : String(ti.id)] = inp; row.appendChild(inp); main.appendChild(row);
        });
        const btnRow = document.createElement("div"); btnRow.className = "ask-options";
        let answered = false;
        const respond = (action) => {
          if (answered) return; answered = true;
          const selected_ids = checks.filter((c) => c.checked).map((c) => c.dataset.id).filter(Boolean);
          const text_values = {}; Object.keys(textEls).forEach((k) => { text_values[k] = textEls[k].value; });
          vscode.postMessage({ type: "ui_prompt_response", promptId, answer: action, selected_ids, text_values });
          btnRow.querySelectorAll("button").forEach((b) => { b.disabled = true; });
          checks.forEach((c) => { c.disabled = true; });
          setPending(tr("working"));
        };
        actions.forEach((a) => {
          const b = document.createElement("button"); b.className = "ask-opt" + (a && a.primary ? " primary" : "");
          b.textContent = (a && a.label != null) ? String(a.label) : String(a && a.value);
          b.addEventListener("click", () => respond((a && a.value != null) ? String(a.value) : "confirm"));
          btnRow.appendChild(b);
        });
        main.appendChild(btnRow); head.appendChild(main); wrap.appendChild(head); el.appendChild(wrap);
        $("activity").appendChild(el);
        $("activity").parentElement.scrollTop = $("activity").parentElement.scrollHeight;
      }

      // status_update -> a timeline trace line.
      function addStatusUpdate(payload) {
        payload = payload || {};
        const text = payload.message == null ? "" : String(payload.message);
        if (text) addActivity({ type: "trace", text });
      }

      // phase_complete -> the summary + any artifacts (rendered functionally).
      function addPhaseComplete(payload) {
        payload = payload || {};
        if (payload.summary) addSummary(String(payload.summary));
        const arts = Array.isArray(payload.artifacts) ? payload.artifacts : [];
        arts.forEach((art) => {
          if (!art || typeof art !== "object") return;
          if (art.type === "markdown" && art.content) addSummary(String(art.content));
          else if (art.type === "table" && Array.isArray(art.rows)) {
            const header = Array.isArray(art.headers) ? art.headers.join(" | ") : "";
            const rows = art.rows.map((r) => (Array.isArray(r) ? r.join(" | ") : "")).join("\n");
            addSummary((art.title ? String(art.title) + "\n" : "") + (header ? header + "\n" : "") + rows);
          } else if (art.title) addSummary(String(art.title));
        });
      }

      function addAskPrompt(promptId, question, options, optionsRequiringText, textPlaceholder) {
        finalizeThinking();
        clearPending();
        $("activityEmpty").classList.add("hidden");
        setTab("activity");
        const opts = Array.isArray(options) ? options : [];
        const needsText = new Set((Array.isArray(optionsRequiringText) ? optionsRequiringText : []).map(String));
        // The free-text row is the only way to answer an open question, and it's where
        // a needs-text option's value goes — but for a pure either/or it only adds
        // height, so drop it (the model uses an option-less question for free text).
        const showInput = opts.length === 0 || needsText.size > 0;
        const card = document.createElement("div");
        card.className = "ev fade-in";
        card.innerHTML = '<div class="ev-card ask"><div class="ev-head">' +
          '<div class="ev-ico skill">•</div>' +
          '<div class="ev-main"><div class="ev-label"><span class="kind">' + tr("kind_question") + '</span></div>' +
          '<div class="ev-sum ask-q"></div>' +
          '<div class="ask-options"></div>' +
          (showInput ? '<div class="ask-row"><input class="ask-input" type="text" placeholder="' + tr("type_answer") + '"><button class="ask-send">' + tr("send") + '</button></div>' : '') +
          "</div></div></div>";
        const askScroll = () => { $("activity").parentElement.scrollTop = $("activity").parentElement.scrollHeight; };
        const askTyper = makeTypewriter(card.querySelector(".ask-q"), askScroll);
        askTyper.feed(question == null ? "" : String(question)); askTyper.end();
        const input = card.querySelector(".ask-input");
        const send = card.querySelector(".ask-send");
        // Model-authored placeholder set as a property (never via innerHTML) so it
        // can't break out of the attribute.
        if (input && typeof textPlaceholder === "string" && textPlaceholder.trim()) input.placeholder = textPlaceholder;
        let answered = false;
        // A needs-text option, once clicked, is held here until its value is typed.
        let pendingOption = null;
        const lock = (shownAnswer) => {
          answered = true;
          if (input) input.disabled = true;
          if (send) { send.disabled = true; send.textContent = tr("sent"); }
          card.querySelectorAll(".ask-opt").forEach((b) => { b.disabled = true; if (b.textContent === shownAnswer || b.textContent === pendingOption) b.classList.add("chosen"); });
          const a = document.createElement("div"); a.className = "ask-answer"; a.textContent = "• " + shownAnswer;
          card.querySelector(".ev-main").appendChild(a);
          setPending(tr("working"));
        };
        const sendAnswer = (answer, selectedOption) => {
          if (!answer || answered) return;
          vscode.postMessage({ type: "ui_prompt_response", promptId, answer, selectedOption });
          lock(answer);
        };
        // The text box submits either a free-form answer or the value for a held option.
        const submitText = () => {
          if (answered || !input) return;
          const text = String(input.value == null ? "" : input.value).trim();
          if (!text) { input.focus(); return; }
          if (pendingOption) sendAnswer(pendingOption + "\n" + text, pendingOption);
          else sendAnswer(text, null);
        };
        const pickOption = (opt) => {
          if (answered) return;
          const label = String(opt);
          if (needsText.has(label)) {
            // Hold the choice and wait for the required text — don't end the turn.
            pendingOption = label;
            card.querySelectorAll(".ask-opt").forEach((b) => b.classList.toggle("chosen", b.textContent === label));
            if (input) input.focus();
            return;
          }
          sendAnswer(label, label);
        };
        const optHost = card.querySelector(".ask-options");
        for (const opt of opts) {
          const b = document.createElement("button");
          b.className = "ask-opt"; b.type = "button"; b.textContent = String(opt);
          b.addEventListener("click", () => pickOption(opt));
          optHost.appendChild(b);
        }
        if (send) send.addEventListener("click", submitText);
        if (input) input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); submitText(); } });
        $("activity").appendChild(card);
        $("activity").parentElement.scrollTop = $("activity").parentElement.scrollHeight;
        if (input) setTimeout(() => input.focus(), 0);
      }

      // ----- component confirmation (deterministic multi-select, host-owned) -----
      // Renders the proposed devices[] as toggleable chips (all pre-selected). The
      // user unchecks to remove and/or types missing parts; Confirm posts the kept
      // device names + the free-text additions back to the host.
      function addComponentPrompt(promptId, devices) {
        finalizeThinking();
        clearPending();
        $("activityEmpty").classList.add("hidden");
        setTab("activity");
        devices = Array.isArray(devices) ? devices : [];
        const card = document.createElement("div");
        card.className = "ev fade-in";
        card.innerHTML = '<div class="ev-card ask"><div class="ev-head">' +
          '<div class="ev-ico skill">•</div>' +
          '<div class="ev-main"><div class="ev-label"><span class="kind">' + tr("kind_components") + '</span></div>' +
          '<div class="ev-sum">' + tr("comp_intro") + '</div>' +
          '<div class="ask-options comp-options"></div>' +
          '<div class="ask-row"><input class="ask-input comp-add" type="text" placeholder="' + tr("comp_add_ph") + '"></div>' +
          '<div class="ask-options"><button class="ask-opt comp-go" type="button">' + tr("comp_confirm") + '</button><button class="ask-opt comp-cancel" type="button">' + tr("cancel") + '</button></div>' +
          "</div></div></div>";
        const optHost = card.querySelector(".comp-options");
        const selected = new Set();
        for (const dev of devices) {
          const nm = String(dev && dev.name != null ? dev.name : dev);
          const iface = dev && dev.interface ? " · " + String(dev.interface) : "";
          selected.add(nm);
          const b = document.createElement("button");
          b.className = "ask-opt chosen"; b.type = "button"; b.textContent = "✓ " + nm + iface;
          b.addEventListener("click", () => {
            if (selected.has(nm)) { selected.delete(nm); b.classList.remove("chosen"); b.textContent = nm + iface; }
            else { selected.add(nm); b.classList.add("chosen"); b.textContent = "✓ " + nm + iface; }
          });
          optHost.appendChild(b);
        }
        const addInput = card.querySelector(".comp-add");
        let answered = false;
        const reply = (answer) => {
          if (answered) return;
          answered = true;
          vscode.postMessage({ type: "ui_prompt_response", promptId, answer, devices: Array.from(selected), feedback: addInput.value.trim() });
          card.querySelectorAll(".ask-opt").forEach((x) => { x.disabled = true; });
          addInput.disabled = true;
          if (answer === "confirm") setPending(tr("working"));
        };
        card.querySelector(".comp-go").addEventListener("click", () => reply("confirm"));
        card.querySelector(".comp-cancel").addEventListener("click", () => reply("cancel"));
        addInput.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); reply("confirm"); } });
        $("activity").appendChild(card);
        $("activity").parentElement.scrollTop = $("activity").parentElement.scrollHeight;
        setTimeout(() => addInput.focus(), 0);
      }

      // ----- build plan (confirmation gate before codegen spends credits) -----
      function addPlanPrompt(promptId, plan) {
        plan = plan || {};
        finalizeThinking();
        clearPending();
        $("activityEmpty").classList.add("hidden");
        setTab("activity");
        const card = document.createElement("div");
        card.className = "ev fade-in";
        card.innerHTML = '<div class="ev-card ask"><div class="ev-head">' +
          '<div class="ev-ico skill">•</div>' +
          '<div class="ev-main"><div class="ev-label"><span class="kind">' + tr("kind_plan") + '</span></div>' +
          '<div class="ev-sum">' + tr("plan_intro") + '</div>' +
          '<div class="ev-sum plan-summary"></div>' +
          '<ul class="plan-list"></ul>' +
          '<div class="plan-cost"></div>' +
          '<div class="ask-row"><input class="ask-input plan-revise" type="text" placeholder="' + tr("plan_revise_ph") + '"><button class="ask-send plan-edit" type="button">' + tr("revise") + '</button></div>' +
          '<div class="ask-options"><button class="ask-opt plan-go" type="button">' + tr("confirm_generate") + '</button><button class="ask-opt plan-cancel" type="button">' + tr("cancel") + '</button></div>' +
          "</div></div></div>";
        // Model-written narrative (optional), rendered above the structured rows.
        const summaryEl = card.querySelector(".plan-summary");
        if (typeof plan.summary === "string" && plan.summary.trim()) {
          const planScroll = () => { $("activity").parentElement.scrollTop = $("activity").parentElement.scrollHeight; };
          const planTyper = makeTypewriter(summaryEl, planScroll); planTyper.feed(plan.summary.trim()); planTyper.end();
        } else summaryEl.remove();
        const rows = [];
        if (plan.boardId) rows.push([tr("plan_board"), plan.boardId]);
        if (Array.isArray(plan.capabilities) && plan.capabilities.length) rows.push([tr("plan_features"), plan.capabilities.map(capName).join(sep())]);
        if (Array.isArray(plan.packages) && plan.packages.length) rows.push([tr("plan_packages"), plan.packages.join(sep())]);
        if (Array.isArray(plan.wiring) && plan.wiring.length) rows.push([tr("plan_wiring"), plan.wiring.map((w) => `${roleSignal(w.role)}→${w.pin}`).join(sep())]);
        const list = card.querySelector(".plan-list");
        for (const [label, value] of rows) {
          const li = document.createElement("li");
          const b = document.createElement("span"); b.className = "plan-k"; b.textContent = label + ": ";
          li.appendChild(b); li.appendChild(document.createTextNode(value));
          list.appendChild(li);
        }
        // Honest cost framing: this is the estimate for THIS build step only, shown
        // alongside what the session has already consumed and what's left — so "~N
        // credits" isn't misread as the whole session's cost.
        const remaining = parseInt($("qUsed").textContent, 10);
        const est = Number(plan.estimate) || 0;
        const used = (lastDailyGrant > 0 && Number.isFinite(remaining)) ? lastDailyGrant - remaining : null;
        let costText = tr("cost_step", { n: est });
        if (used != null) costText += tr("cost_used", { n: used });
        if (Number.isFinite(remaining)) costText += tr("cost_left", { n: remaining });
        card.querySelector(".plan-cost").textContent = costText;
        let answered = false;
        const reviseInput = card.querySelector(".plan-revise");
        const reply = (answer, feedback) => {
          if (answered) return;
          answered = true;
          vscode.postMessage({ type: "ui_prompt_response", promptId, answer, feedback });
          card.querySelectorAll(".ask-opt, .ask-send").forEach((b) => { b.disabled = true; });
          reviseInput.disabled = true;
          if (answer === "cancel") return; // session_done renders the terminal
          // Revise re-runs the agent to re-plan; confirm proceeds to codegen.
          setPending(answer === "revise" ? tr("replanning") : tr("generating_code"));
        };
        // Revise: send the user's free-text change request back so the agent re-plans
        // and the host re-shows an updated plan. Empty input is a no-op.
        const submitRevise = () => {
          const fb = reviseInput.value.trim();
          if (!fb) { reviseInput.focus(); return; }
          reply("revise", fb);
        };
        card.querySelector(".plan-go").addEventListener("click", () => reply("confirm"));
        card.querySelector(".plan-cancel").addEventListener("click", () => reply("cancel"));
        card.querySelector(".plan-edit").addEventListener("click", submitRevise);
        reviseInput.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); submitRevise(); } });
        $("activity").appendChild(card);
        $("activity").parentElement.scrollTop = $("activity").parentElement.scrollHeight;
      }

      // ----- deploy checkpoint (board connection + wiring, before install/flash) -----
      let currentDeployCard = null;
      function addDeployPrompt(promptId, manifest) {
        finalizeThinking();
        clearPending();
        $("activityEmpty").classList.add("hidden");
        setTab("activity");
        const card = document.createElement("div");
        card.className = "ev fade-in";
        card.innerHTML = '<div class="ev-card ask"><div class="ev-head">' +
          '<div class="ev-ico skill">•</div>' +
          '<div class="ev-main"><div class="ev-label"><span class="kind">' + tr("kind_deploy") + '</span></div>' +
          '<div class="ev-sum">' + tr("deploy_intro") + '</div>' +
          '<div class="deploy-wiring"></div>' +
          '<div class="deploy-status">' + tr("detecting_board") + '</div>' +
          '<div class="deploy-ports"></div>' +
          '<div class="deploy-actions"><button class="ask-opt deploy-go" type="button" disabled>' + tr("deploy") + '</button>' +
          '<div class="deploy-secondary"><button class="ask-opt deploy-rescan" type="button">' + tr("rescan") + '</button><button class="ask-opt deploy-cancel" type="button">' + tr("cancel") + '</button></div></div>' +
          "</div></div></div>";
        const wiring = wiringMarkup(manifest);
        if (wiring) card.querySelector(".deploy-wiring").innerHTML = wiring;
        const statusEl = card.querySelector(".deploy-status");
        const portsEl = card.querySelector(".deploy-ports");
        const goBtn = card.querySelector(".deploy-go");
        let answered = false;
        let selectedPort = null;
        const reply = (answer) => {
          if (answered) return;
          answered = true;
          // Carry the chosen port on the prompt response itself so the host sets it
          // before unblocking the agent — a separate select_device message races the
          // resolve and the first device tool can fire before the port lands.
          vscode.postMessage({ type: "ui_prompt_response", promptId, answer, port: answer === "confirm" ? selectedPort : null });
          card.querySelectorAll(".ask-opt").forEach((b) => { b.disabled = true; });
          currentDeployCard = null;
          if (answer === "confirm") setPending(tr("deploying")); // cancel: session_done renders the terminal
        };
        goBtn.addEventListener("click", () => reply("confirm"));
        card.querySelector(".deploy-cancel").addEventListener("click", () => reply("cancel"));
        card.querySelector(".deploy-rescan").addEventListener("click", () => { statusEl.textContent = tr("detecting_board"); vscode.postMessage({ type: "deploy_rescan" }); });
        // Updated by deploy_ports_updated: no board -> Deploy stays disabled; one
        // board -> auto-selected; several -> the user picks one before deploying.
        currentDeployCard = {
          setPorts: (ports) => {
            ports = Array.isArray(ports) ? ports : [];
            portsEl.innerHTML = "";
            if (!ports.length) {
              statusEl.textContent = tr("no_board");
              selectedPort = null; goBtn.disabled = true; return;
            }
            if (ports.length === 1) {
              selectedPort = ports[0];
              statusEl.textContent = tr("connected", { p: ports[0] });
            } else {
              statusEl.textContent = tr("multiple_devices");
              selectedPort = null;
              ports.forEach((p) => {
                const b = document.createElement("button");
                b.className = "ask-opt"; b.type = "button"; b.textContent = p;
                b.addEventListener("click", () => {
                  selectedPort = p;
                  portsEl.querySelectorAll(".ask-opt").forEach((x) => x.classList.remove("chosen"));
                  b.classList.add("chosen"); goBtn.disabled = false;
                });
                portsEl.appendChild(b);
              });
            }
            goBtn.disabled = selectedPort == null;
          },
        };
        $("activity").appendChild(card);
        $("activity").parentElement.scrollTop = $("activity").parentElement.scrollHeight;
        vscode.postMessage({ type: "deploy_rescan" });
      }

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
        // gen-driver / deploy verification marker (spec 8.3: surface verification results).
        if (/SELF_TEST_PASS\b/.test(line)) return "verify";
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

      // ----- credits -----
      let lastDailyGrant = 0;
      function setCredits(balance, dailyGrant) {
        if (dailyGrant > 0) lastDailyGrant = dailyGrant;
        $("qUsed").textContent = balance;
        const max = dailyGrant > 0 ? dailyGrant : balance;
        const pct = max > 0 ? Math.min(100, Math.round((balance / max) * 100)) : 0;
        $("qFill").style.width = pct + "%";
        const q = $("quota"); q.classList.remove("hidden", "low", "exhausted");
        if (balance <= 0) q.classList.add("exhausted");
        else if (balance <= Math.max(1, Math.round(max * 0.2))) q.classList.add("low");
        quotaExhausted = balance <= 0;
        updateGenerateEnabled();
      }

      // Show the STUB badge only when the backend reports stub mode; live/unknown
      // hides it. Surfacing this is what keeps a stub backend from reading as a hang.
      function setServerMode(mode) {
        $("modeBadge").classList.toggle("hidden", mode !== "stub");
      }

      // ----- host messages (protocol unchanged) -----
      // ----- Environment doctor -----
      // Turns each raw error_kind into an actionable, localized hint line so the user
      // never sees a bare machine code (python_not_found, device_unavailable, …).
      const DOC_HINTS = {
        en: {
          python_not_found: "Install Python 3.10+ and reopen VS Code.",
          shim_dependency_install_failed: "If it keeps failing, set a pip mirror in mpyhw.pipIndexUrl.",
          device_unavailable: "Check the USB cable and the serial driver (CP210x/CH340).",
          device_selection_required: "Unplug the extra boards, or pick one to use.",
          device_scan_failed: "Replug the board and click Re-check.",
          no_micropython: "Flash MicroPython with the link below, then re-check.",
        },
        zh: {
          python_not_found: "安装 Python 3.10+ 后重开 VS Code。",
          shim_dependency_install_failed: "若反复失败，可在 mpyhw.pipIndexUrl 设置 pip 镜像。",
          device_unavailable: "检查 USB 线和串口驱动（CP210x/CH340）。",
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

      // Home partner-logo area (section-06 doc): host-served logos as data URIs, click
      // opens the partner site externally. Text fallback if a logo fails to load.
      function renderPartners(partners) {
        const root = $("partners"); if (!root) return;
        root.innerHTML = "";
        if (!partners || !partners.length) return;
        const h = document.createElement("div"); h.className = "partners-h"; h.textContent = "Partners";
        const row = document.createElement("div"); row.className = "partners-row";
        for (const p of partners) {
          const a = document.createElement("button"); a.className = "partner"; a.type = "button"; a.title = "Open " + p.name + " website";
          const img = document.createElement("img"); img.className = "partner-logo"; img.src = p.logo; img.alt = p.name;
          img.addEventListener("error", () => { a.textContent = p.name; });
          a.appendChild(img);
          a.addEventListener("click", () => vscode.postMessage({ type: "open_external", url: p.url }));
          row.appendChild(a);
        }
        root.appendChild(h); root.appendChild(row);
      }
      // Read-only list of past session summaries (host-served from .mpyhw/sessions).
      // Clicking a card reveals its session.jsonl via the host's open_path handler.
      // Artifact Browser (spec 8.3): the session's artifacts, grouped by phase. The host
      // sends a RELATIVE-path index (never absolute paths); a row click asks the host to
      // open the file, which maps the relative path back to an absolute one — the trust
      // boundary lives in the host, not here.
      const BYTES_PER_KB = 1024;
      const SHA_DISPLAY_LEN = 8;
      let ARTIFACTS = [];
      let artifactPhase = ""; // "" = all phases
      let artifactsLinkShown = false; // one "View artifacts" jump per session
      // A one-time affordance in the Activity feed to jump to the Artifacts tab, so the user
      // can open/trace produced files straight from the timeline (card #36).
      function addArtifactsLink() {
        if (artifactsLinkShown) return;
        artifactsLinkShown = true;
        const card = document.createElement("div");
        card.className = "ev fade-in";
        card.innerHTML = '<div class="ev-card"><div class="ev-main"><div class="ev-label"><span class="kind">' + tr("kind_result") + '</span></div></div></div>';
        const btn = document.createElement("button");
        btn.className = "doc-fix";
        btn.textContent = tr("view_artifacts");
        btn.addEventListener("click", () => setTab("artifacts"));
        card.querySelector(".ev-main").appendChild(btn);
        $("activity").appendChild(card);
      }
      function renderArtifacts(list) {
        ARTIFACTS = Array.isArray(list) ? list : [];
        if (artifactPhase && !ARTIFACTS.some((a) => a.phase === artifactPhase)) artifactPhase = "";
        drawArtifacts();
      }
      function drawArtifacts() {
        const box = $("artifacts"); if (!box) return;
        box.innerHTML = "";
        $("artifactFilter").innerHTML = "";
        if (!ARTIFACTS.length) { $("artifactsEmpty").classList.remove("hidden"); return; }
        $("artifactsEmpty").classList.add("hidden");
        drawArtifactFilter();
        const rows = ARTIFACTS.filter((a) => !artifactPhase || a.phase === artifactPhase);
        for (const a of rows) box.appendChild(artifactRow(a));
      }
      function drawArtifactFilter() {
        const phases = [...new Set(ARTIFACTS.map((a) => a.phase).filter(Boolean))];
        if (phases.length < 2) return; // nothing to filter by
        const filter = $("artifactFilter");
        filter.appendChild(artifactChip(tr("art_all_phases"), ""));
        for (const p of phases) filter.appendChild(artifactChip(p, p));
      }
      function artifactChip(label, phase) {
        const chip = document.createElement("button");
        chip.className = "art-chip" + (artifactPhase === phase ? " active" : "");
        chip.type = "button";
        chip.textContent = label;
        chip.addEventListener("click", () => { artifactPhase = phase; drawArtifacts(); });
        return chip;
      }
      function artifactRow(a) {
        const row = document.createElement("button");
        row.className = "art-row";
        row.type = "button";
        row.title = tr(a.is_binary ? "art_reveal" : "art_open");
        // Inline preview for images (svg/png): the host attaches a webview-safe URI
        // (asWebviewUri) that loads under the CSP img-src; still no filesystem path here.
        if (a.webview_uri) {
          const thumb = document.createElement("img");
          thumb.className = "art-thumb"; thumb.src = a.webview_uri; thumb.alt = "";
          row.appendChild(thumb);
        }
        const kind = document.createElement("span"); kind.className = "art-kind"; kind.textContent = a.kind;
        const path = document.createElement("span"); path.className = "art-path"; path.textContent = a.relative_path;
        const meta = document.createElement("span"); meta.className = "art-meta"; meta.textContent = artifactMeta(a);
        row.append(kind, path, meta);
        row.addEventListener("click", () => vscode.postMessage({ type: "open_artifact", relative_path: a.relative_path }));
        return row;
      }
      function artifactMeta(a) {
        const parts = [];
        if (typeof a.size === "number") parts.push(formatBytes(a.size));
        if (a.sha256) parts.push(a.sha256.slice(0, SHA_DISPLAY_LEN));
        return parts.join(" · ");
      }
      function formatBytes(n) {
        if (n < BYTES_PER_KB) return n + " B";
        if (n < BYTES_PER_KB * BYTES_PER_KB) return (n / BYTES_PER_KB).toFixed(1) + " KB";
        return (n / (BYTES_PER_KB * BYTES_PER_KB)).toFixed(1) + " MB";
      }
      function renderRecent(sessions) {
        const box = $("recent"); if (!box) return;
        box.innerHTML = "";
        const empty = $("recentEmpty");
        if (!sessions || !sessions.length) { empty.classList.remove("hidden"); return; }
        empty.classList.add("hidden");
        for (const s of sessions) {
          const card = document.createElement("button"); card.className = "recent-card"; card.type = "button";
          const title = document.createElement("span"); title.className = "recent-intent"; title.textContent = s.intent || s.id;
          const meta = document.createElement("span"); meta.className = "recent-meta";
          const when = s.date ? new Date(s.date).toLocaleString() : "";
          meta.textContent = s.finalPhase ? (when + " · " + s.finalPhase) : when;
          card.appendChild(title); card.appendChild(meta);
          card.addEventListener("click", () => vscode.postMessage({ type: "open_path", path: s.path }));
          box.appendChild(card);
        }
      }
      function scButton(label, action) {
        const b = document.createElement("button"); b.className = "sc-btn"; b.type = "button"; b.textContent = label;
        b.addEventListener("click", action);
        return b;
      }
      // SupportContactPanel: render the host-served (locale-ordered) contacts + a report-issue
      // section. Contacts are config-driven; copy/mailto/openExternal go through the host.
      function renderSupport(msg) {
        const root = $("support"); if (!root) return;
        $("supportEmpty").classList.add("hidden");
        root.innerHTML = "";
        const list = document.createElement("div"); list.className = "sc-list";
        for (const c of msg.contacts || []) {
          const row = document.createElement("div"); row.className = "sc-row";
          const label = document.createElement("span"); label.className = "sc-label"; label.textContent = c.label;
          const val = document.createElement("span"); val.className = "sc-val"; val.textContent = c.value || c.url || "";
          row.appendChild(label); row.appendChild(val);
          if (c.copyable && c.value) row.appendChild(scButton("Copy", () => vscode.postMessage({ type: "copy_code", text: c.value })));
          if (c.url) row.appendChild(scButton("Open", () => vscode.postMessage({ type: "open_external", url: c.url })));
          list.appendChild(row);
        }
        root.appendChild(list);
        const report = document.createElement("div"); report.className = "sc-report";
        const h = document.createElement("div"); h.className = "sc-report-h"; h.textContent = "Report an issue";
        const note = document.createElement("p"); note.className = "gd-note";
        note.textContent = "Please include diagnostics: " + (msg.diagnosticsFields || []).join(", ") + ".";
        report.appendChild(h); report.appendChild(note);
        const issues = (msg.contacts || []).find((c) => c.id === "github_issues");
        if (issues && issues.url) report.appendChild(scButton("Open GitHub Issues", () => vscode.postMessage({ type: "open_external", url: issues.url })));
        report.appendChild(scButton("Copy diagnostics", () => vscode.postMessage({ type: "request_diagnostics" })));
        const diag = document.createElement("div"); diag.className = "gd-note"; diag.id = "scDiag";
        report.appendChild(diag);
        root.appendChild(report);
      }

      window.addEventListener("message", (event) => {
        const msg = event.data;
        if (msg.type === "recipe_imported") { prefillImportedRecipe(msg.payload); }
        if (msg.type === "doctor_results") { renderDoctor(msg.items); }
        if (msg.type === "gen_driver_config") { renderGenDriver(msg.tabs); }
        if (msg.type === "gen_driver_status") { setGenDriverStatus(msg.status, msg.detail); }
        if (msg.type === "gen_driver_file_picked") { setGenDriverFile(msg); }
        if (msg.type === "support_config") { renderSupport(msg); }
        if (msg.type === "partners_config") { renderPartners(msg.partners); }
        if (msg.type === "recent_sessions") { renderRecent(msg.sessions); }
        if (msg.type === "diagnostics") {
          vscode.postMessage({ type: "copy_code", text: msg.text });
          const n = $("scDiag"); if (n) n.textContent = "Diagnostics copied to clipboard.";
        }
        if (msg.type === "server_mode") { setServerMode(msg.mode); }
        if (msg.type === "micropython_boards") { loadOfficialBoards(msg); }
        if (msg.type === "session_event" && msg.event && msg.event.kind === "credits") {
          setCredits(msg.event.balance, msg.event.dailyGrant);
        }
        if (msg.type === "session_event" && msg.event && msg.event.kind === "saved_location") {
          addSavedLocation(msg.event.path);
        }
        if (msg.type === "trace_event" && running) {
          // A tool FAILURE carries the real reason (a device runtime error, a failed
          // driver install). Surface it as a durable feed line so the user sees WHY a
          // step broke, instead of a silent spinner that ends in a generic terminal
          // message. The loop may still retry/repair after this.
          if (msg.event && msg.event.isError && msg.event.text) {
            addActivity({ text: tr("tool_failed", { e: String(msg.event.text) }) });
          }
          // The agent's internal tool steps drive the single in-feed working
          // spinner — we show a curated, localized phase label (e.g. "Generating
          // code…"), never the model's raw reasoning (chain-of-thought is discarded
          // upstream before the tool fires). This refreshes the label and re-arms
          // the spinner in the gap between one card finishing and the next tool
          // starting — unless real content is currently streaming.
          if (!currentSummary && !currentCode) setPending(phaseLabel(msg.event));
        }
        if (msg.type === "summary_delta") { streamSummaryDelta(msg.text); }
        if (msg.type === "summary_discard") { discardSummary(); }
        if (msg.type === "summary_seal") { sealSummary(); }
        if (msg.type === "summary") { addSummary(msg.text); }
        if (msg.type === "ui_prompt_needed") { addAskPrompt(msg.promptId, msg.question, msg.options, msg.optionsRequiringText, msg.textPlaceholder); }
        if (msg.type === "components_needed") { addComponentPrompt(msg.promptId, msg.devices); }
        if (msg.type === "plan_needed") { addPlanPrompt(msg.promptId, msg.plan); }
        if (msg.type === "deploy_needed") { addDeployPrompt(msg.promptId, msg.manifest); }
        // Protocol (plugin-interface) renderers:
        if (msg.type === "approval_request") {
          // The webview's own per-card `answered` guard covers a same-card double
          // click; this guards the render itself — a re-delivered/duplicated
          // approval_request for a promptId already on screen must not stack a
          // second card the user could double-answer.
          if (document.querySelector(`[data-prompt-id="${msg.promptId}"]`)) {
            console.warn("duplicate approval_request ignored", msg.promptId);
          } else {
            addApprovalPrompt(msg.promptId, msg.card);
          }
        }
        if (msg.type === "status_update" && running) { addStatusUpdate(msg.payload); }
        if (msg.type === "phase_start") { setPending(tr("working")); }
        if (msg.type === "phase_complete") { addPhaseComplete(msg.payload); }
        if (msg.type === "deploy_ports_updated") { if (currentDeployCard) currentDeployCard.setPorts(msg.ports); }
        if (msg.type === "code_delta") { streamCodeDelta(msg.text, msg.path); }
        if (msg.type === "code_updated") { finalizeCode(msg.code, msg.path); }
        if (msg.type === "manifest_updated") { renderWiring(msg.manifest); }
        if (msg.type === "diagram_updated") { renderDiagram(msg.diagram); }
        if (msg.type === "artifacts_index") { renderArtifacts(msg.artifacts); }
        if (msg.type === "serial_output") { addSerial(msg.lines); }
        if (msg.type === "device_selected") { addActivity({ type: "trace", text: tr("device_selected", { p: msg.port }) }); }
        // A supplement line is an annotation, not a step: addActivity() clears the working
        // spinner, so re-arm it (with the same label) while the build is still running.
        if (msg.type === "user_supplement_received") { addActivity({ type: "trace", text: tr("supplement_received", { s: msg.summary }) }, "note"); if (running && pendingLabel) setPending(pendingLabel); }
        if (msg.type === "user_supplement_applied") { addActivity({ type: "trace", text: tr("supplement_applied", { d: msg.decision, r: msg.reason }) }, "note"); if (running && pendingLabel) setPending(pendingLabel); }
        if (msg.type === "files_written") { addActivity({ type: "trace", text: tr("files_written", { p: (msg.paths || []).join(", ") }) }); vscode.postMessage({ type: "request_artifacts" }); addArtifactsLink(); }
        if (msg.type === "files_write_failed") { addActivity({ type: "trace", text: tr("files_write_failed", { e: msg.error }) }); }
        if (msg.type === "session_error") {
          const errKey = "err_" + msg.error;
          const text = (I18N[LOCALE] && I18N[LOCALE][errKey]) || I18N.en[errKey] || msg.error;
          if (msg.error === "daily_cap_reached") {
            // Sticky until the cap resets: the next credits event recomputes
            // quotaExhausted from balance (typically still > 0 for a capped user),
            // so this independent deadline is what keeps Start disabled.
            const now = new Date();
            capBlockedUntil = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
          }
          if (msg.error === "out_of_credits" || msg.error === "daily_cap_reached") { quotaExhausted = true; $("quota").classList.add("exhausted"); updateGenerateEnabled(); }
          addActivity({ text });
        }
        if (msg.type === "session_done") {
          setRunning(false);
          finalizeThinking();
          currentCode = null;
          currentSummary = null;
          clearPending();
          // A still-open deploy card is now stale (its prompt was resolved by the
          // session ending); disable its buttons so clicks can't post stale replies.
          if (currentDeployCard) { document.querySelectorAll(".deploy-go, .deploy-rescan, .deploy-cancel").forEach((b) => { b.disabled = true; }); currentDeployCard = null; }
          // Same for a still-open approval card ([data-prompt-id] is stamped only on
          // approval cards): its prompt is resolved too, so a later click would post a
          // stale ui_prompt_response that the host can only log as a duplicate.
          document.querySelectorAll("[data-prompt-id] button, [data-prompt-id] input").forEach((b) => { b.disabled = true; });
          $("serialHead").classList.remove("live");
          document.querySelectorAll(".tab .pulse").forEach((p) => p.remove());
          const t = String(msg.terminal);
          // "complete" is the protocol's successful terminal (the whole pipeline ran);
          // "awaiting_user" is a clean hand-back, not an error.
          const ok = t === "generated" || t === "success" || t === "complete";
          const label = tr("term_" + t);
          const friendly = label === "term_" + t ? t : label;
          const isError = !ok && t !== "cancelled" && t !== "awaiting_user" && t !== "stalled";
          // session_done is posted twice on a cancel (optimistic + loop-unwind); render the
          // terminal line / retry card only once. The cleanup above is idempotent, so it may
          // run on both.
          if (terminalShown) return;
          terminalShown = true;
          // A stalled build gave up mid-way without reaching a phase boundary — unlike
          // awaiting_user (a clean hand-back), the user must SEE it stalled and get a
          // one-click way to try again, so it has its own lane before the generic line.
          if (t === "stalled") {
            addActivity({ text: tr("session_stuck") });
            addRetryCard();
          }
          // The status bar is gone; surface a terminal line in the feed for ends
          // that aren't self-evident from the result (errors and a cancelled run).
          // A successful finish needs none — the summary + code cards say it.
          if (isError || t === "cancelled") addActivity({ text: tr("session_ended", { t: friendly }) });
          // Transport failures keep the session state on the host, so the
          // interrupted turn can be re-issued verbatim — offer a one-click retry.
          if (t === "llm_unreachable" || t === "sse_stream_interrupted") addRetryCard();
        }
        if (msg.type === "connect_retry") {
          // The host is auto-retrying a dropped connection; keep the spinner honest
          // ("retrying 1/3") instead of leaving the user staring at silence.
          setPending(tr("retrying", { n: msg.attempt, m: msg.maxAttempts }));
        }
        if (msg.type === "session_busy") {
          // The host rejected this start because a prior run is still unwinding.
          // Clear the optimistic spinner so the UI can't hang; the user can retry.
          setRunning(false);
          clearPending();
        }
      });

      // Skin the static chrome for the initial (English) locale; the session's
      // first request re-skins it to the user's language via setLocale.
      applyStaticI18n();
      // Pull the real device list + credit balance from the extension host on load.
      vscode.postMessage({ type: "request_boards" });
      // Run the environment preflight on load so issues surface before the first deploy.
      vscode.postMessage({ type: "run_doctor_check" });
      // Load the gen-driver input tabs from the host (schema is the source of truth).
      vscode.postMessage({ type: "request_gen_driver_config" });
      // Load the support contacts + diagnostics fields (config is the source of truth).
      vscode.postMessage({ type: "request_support_config" });
      // Load the home partner logos (config-driven; host inlines them as data URIs).
      vscode.postMessage({ type: "request_partners" });
      // Pull the artifact index so the Artifacts tab is populated for a resumed session.
      vscode.postMessage({ type: "request_artifacts" });
