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
          device_tools: "Device Tools", dt_sec_files: "Board files", dt_sec_packages: "Packages", dt_path_ph: "/", dt_newname_ph: "new-folder", dt_mip_url_ph: "github:org/repo/pkg", dt_mip_version_ph: "version",
          dt_actions: "Add or manage", dt_upload: "Upload", dt_mkdir: "New folder", dt_mip_install: "Install (mip)", dt_download: "Download", dt_delete: "Delete", dt_confirm_del: "Confirm?",
          dt_empty_h: "Empty folder", dt_empty_p: "Nothing here on the connected board.",
          dt_pkg_sum: "Install a package", dt_pkg_src_auto: "Auto", dt_pkg_src_lib: "MicroPython-lib", dt_pkg_src_upypi: "uPyPI", dt_pkg_src_github: "GitHub fallback",
          dt_pkg_query_ph: "search packages", dt_pkg_search: "Search", dt_pkg_adv: "Advanced: raw mip / GitHub URL", dt_pkg_install: "Install",
          dt_pkg_searching: "Searching…", dt_pkg_none: "No packages found.", dt_pkg_err: "Search failed. The package source may be unreachable.",
          dt_pkg_github_hint: "GitHub is a fallback: paste a github: or mip URL under Advanced below.",
          dt_nodev_h: "No device connected", dt_nodev_p: "Plug in a MicroPython board to browse its files.",
          dt_busy: "Device busy: {p} is using the serial port.", dt_busy_generic: "a running task", dt_working: "Working…", dt_installing: "Installing… (fetches on your computer then copies to the board — up to 2 min)", dt_ok: "{c} done.", dt_err: "{c} failed: {e}",
          empty_artifacts_h: "No artifacts yet", empty_artifacts_p: "Files this build produced appear here to open and trace. Wiring and diagram open in their own tabs.",
          art_all_phases: "All", art_open: "Open in editor", art_reveal: "Reveal in file manager", art_open_tab: "Open in its tab", art_on_disk: "on disk", view_artifacts: "View artifacts",
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
          of_gen_wiring: "Generate wiring diagram", of_gen_diagram: "Generate architecture diagram", of_generating: "Generating…",
          of_img_wiring: "Generated wiring", of_img_diagram: "Generated diagram",
          of_ready_wiring: "Wiring diagram ready", of_ready_diagram: "Architecture diagram ready", of_view_wiring: "View wiring", of_view_diagram: "View diagram", of_open_full: "Open full size in the editor",
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
          mode_group: "Experience level", board_group: "Board selection", mode_beginner: "Beginner", mode_custom: "Custom", board_auto: "Recommend board", board_browse: "Browse boards", board_browse_tip: "Browse and pick a specific board", board_use_recommend: "Use recommend instead", board_search_ph: "Search official MicroPython boards", board_vendor_all: "All vendors", board_port_all: "All ports", board_mcu_all: "All MCUs", board_feature_all: "All features", board_firmware: "Official firmware", board_builtin: "Pin layout", board_official_only: "Official only", board_none: "No matching boards", board_refresh: "Refresh", board_details_tip: "Open the official download page", board_firmware_fmt: "firmware:", board_cache_stale: "Cache stale {t}", board_cache_fetched: "Fetched {t}",
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
          kind_confirm: "confirm",
          fileop_overwrite: "Overwrite", fileop_delete: "Delete", fileop_ignore: "Ignore",
          fileop_device_delete: "Erase",
          fileop_overwrite_q: "This will overwrite an existing file: {p}. Overwrite it, or keep the current file?",
          fileop_delete_q: "This will delete an existing file: {p}. Delete it, or keep it?",
          fileop_device_delete_q: "This permanently erases {p} on the device and cannot be undone. Confirm the deletion?",
          session_ended: "Session ended: {t}", tool_failed: "Step failed: {e}",
          target_board: "Target board", led_note: "⚠ LED needs a current-limiting resistor (≈220–330Ω).",
          wiring_provisional: "Preview — pins not assigned yet",
          term_generated: "Done", term_success: "Done", term_cancelled: "Stopped", term_complete: "Done",
          term_awaiting_user: "Waiting for your reply", term_max_turns: "Stopped (max turns)",
          term_stalled: "Build got stuck",
          // A terminal with no string here renders as its raw internal token ("Session ended:
          // failed") — tr() returns the key it can't find. webview-dom.test.ts extracts every
          // terminal from the core sources and fails if any lacks a string; keep them in step.
          term_failed: "The build failed", term_incomplete: "Stopped (too many phases)",
          // Why a build failed. phase_unknown_next means the model asked to advance to a phase
          // that isn't in PHASE_ALIASES; phase_broke names any other phase_error kind rather
          // than letting a new one vanish silently, the way phase_error used to.
          phase_unknown_next: "The build asked for a step that doesn't exist: {p}",
          phase_broke: "A step broke: {k}",
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
          device_tools: "设备工具", dt_sec_files: "开发板文件", dt_sec_packages: "软件包", dt_path_ph: "/", dt_newname_ph: "新建文件夹", dt_mip_url_ph: "github:org/repo/pkg", dt_mip_version_ph: "版本",
          dt_actions: "添加或管理", dt_upload: "上传", dt_mkdir: "新建文件夹", dt_mip_install: "安装 (mip)", dt_download: "下载", dt_delete: "删除", dt_confirm_del: "确认？",
          dt_empty_h: "空文件夹", dt_empty_p: "已连接开发板上这里没有文件。",
          dt_pkg_sum: "安装包", dt_pkg_src_auto: "自动", dt_pkg_src_lib: "MicroPython-lib", dt_pkg_src_upypi: "uPyPI", dt_pkg_src_github: "GitHub 备选",
          dt_pkg_query_ph: "搜索包", dt_pkg_search: "搜索", dt_pkg_adv: "高级：原始 mip / GitHub 链接", dt_pkg_install: "安装",
          dt_pkg_searching: "搜索中…", dt_pkg_none: "未找到包。", dt_pkg_err: "搜索失败，包来源可能无法访问。",
          dt_pkg_github_hint: "GitHub 为备选来源：请在下方高级处粘贴 github: 或 mip 链接。",
          dt_nodev_h: "未连接设备", dt_nodev_p: "插入 MicroPython 开发板以浏览其文件。",
          dt_busy: "设备忙：{p} 正在占用串口。", dt_busy_generic: "正在运行的任务", dt_working: "处理中…", dt_installing: "安装中…（先在电脑上下载再复制到开发板，最长约 2 分钟）", dt_ok: "{c} 完成。", dt_err: "{c} 失败：{e}",
          empty_artifacts_h: "暂无产物", empty_artifacts_p: "本次构建生成的文件会显示在这里，可打开和追溯。接线和架构图请在各自的标签页中查看。",
          art_all_phases: "全部", art_open: "在编辑器中打开", art_reveal: "在文件管理器中显示", art_open_tab: "在对应标签页打开", art_on_disk: "磁盘", view_artifacts: "查看产物",
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
          of_gen_wiring: "生成接线图", of_gen_diagram: "生成架构图", of_generating: "生成中…",
          of_img_wiring: "生成的接线图", of_img_diagram: "生成的架构图",
          of_ready_wiring: "接线图已生成", of_ready_diagram: "架构图已生成", of_view_wiring: "查看接线图", of_view_diagram: "查看架构图", of_open_full: "在编辑器中查看大图",
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
          mode_group: "\u4f53\u9a8c\u7ea7\u522b", board_group: "\u5f00\u53d1\u677f\u9009\u62e9", mode_beginner: "小白", mode_custom: "自定义", board_auto: "系统推荐板卡", board_browse: "浏览板卡", board_browse_tip: "浏览并选择具体板卡", board_use_recommend: "改用系统推荐", board_search_ph: "搜索官方 MicroPython 板卡", board_vendor_all: "全部品牌", board_port_all: "全部 Port", board_mcu_all: "全部 MCU", board_feature_all: "全部特性", board_firmware: "官方固件", board_builtin: "内置引脚", board_official_only: "仅官方固件", board_none: "没有匹配板卡", board_details_tip: "打开官方下载页面", board_firmware_fmt: "固件:",
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
          kind_confirm: "确认",
          fileop_overwrite: "覆盖", fileop_delete: "删除", fileop_ignore: "忽略",
          fileop_device_delete: "擦除",
          fileop_overwrite_q: "这将覆盖已存在的文件：{p}。是覆盖，还是保留当前文件？",
          fileop_delete_q: "这将删除已存在的文件：{p}。是删除，还是保留？",
          fileop_device_delete_q: "这将永久擦除设备上的 {p}，且无法恢复。确认删除？",
          session_ended: "会话结束：{t}", tool_failed: "步骤失败：{e}",
          target_board: "目标开发板", led_note: "⚠ LED 需要串联一个限流电阻（约 220–330Ω）。",
          wiring_provisional: "预览 — 引脚尚未分配",
          term_generated: "完成", term_success: "完成", term_cancelled: "已停止", term_complete: "完成",
          term_awaiting_user: "等待你的回复", term_max_turns: "已停止（达到回合上限）",
          term_stalled: "构建卡住了",
          term_failed: "构建失败", term_incomplete: "已停止（阶段过多）",
          phase_unknown_next: "构建请求了一个不存在的步骤：{p}",
          phase_broke: "某个步骤出错：{k}",
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
        document.querySelectorAll("[data-i18n-aria]").forEach((el) => { el.setAttribute("aria-label", tr(el.getAttribute("data-i18n-aria"))); });
      }
      // Lock the UI language for the session (first intent). Re-skins the static
      // chrome and the idle status/button when the session isn't already running.
      function setLocale(loc) {
        if (loc === LOCALE) return;
        LOCALE = loc;
        applyStaticI18n();
        if (!running) $("generate").textContent = tr("generate");
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

      let running = false;
      let quotaExhausted = false;
      // Daily-cap hold (ms epoch): set when the server 402s with daily_cap_reached,
      // lifts at the next UTC midnight. The 402's resets_at never reaches this layer
      // (llm-client keeps only detail.error), but the cap resets at UTC midnight by
      // definition — the same deadline the server's resets_at carries — so derive it.
      let capBlockedUntil = 0;
      let selectedMode = "beginner";
