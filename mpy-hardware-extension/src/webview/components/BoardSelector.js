      let officialBoards = [];
      let selectedOfficialBoard = null;
      let boardCacheFetchedAt = "";
      let boardCacheStale = false;
      let boardPage = 0;
      const BOARD_PAGE_SIZE = 6;

      function setBoardPickerVisible(visible) {
        $("boardPicker").classList.toggle("hidden", !visible);
      }
      // The board picker body (search + filters + list) is collapsed by default so
      // it doesn't bury the welcome; Start Workflow and the disclosure open it.
      function setBoardBodyExpanded(expanded) {
        $("boardPickerBody").hidden = !expanded;
        const more = $("boardMore");
        more.setAttribute("aria-expanded", expanded ? "true" : "false");
        syncBoardChoice();
      }
      // The board choice is one axis (Recommend vs Browse). Reflect it in the segmented toggle + the
      // selected-board chip: Recommend is active until a specific board is picked or the list is open;
      // once a board is chosen the chip names it (with a clear-to-recommend affordance). Keeps the
      // current choice always visible instead of hidden inside a collapsed list.
      function syncBoardChoice() {
        const browsing = !$("boardPickerBody").hidden || selectedOfficialBoard != null;
        $("boardAuto").classList.toggle("active", !browsing);
        $("boardMore").classList.toggle("active", browsing);
        $("boardAuto").setAttribute("aria-pressed", browsing ? "false" : "true");
        $("boardMore").setAttribute("aria-pressed", browsing ? "true" : "false");
        const chip = $("boardSelected");
        if (!chip) return;
        if (selectedOfficialBoard) {
          $("boardSelectedName").textContent = boardLabel(selectedOfficialBoard);
          chip.classList.remove("hidden");
        } else {
          chip.classList.add("hidden");
        }
      }
      function clearBoardChoice() {
        selectedOfficialBoard = null;
        setBoardBodyExpanded(false);
        renderBoardPicker();
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
          renderBoardPicker();
          syncBoardChoice();
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
      $("boardAuto").addEventListener("click", clearBoardChoice);
      $("boardSelectedClear")?.addEventListener("click", clearBoardChoice);
      $("boardRefresh").addEventListener("click", () => vscode.postMessage({ type: "request_boards" }));
      ["boardSearch", "boardVendor", "boardPort", "boardMcu", "boardFeature"].forEach((id) => { const el = $(id); el.addEventListener("input", () => { boardPage = 0; renderBoardPicker(); }); el.addEventListener("change", () => { boardPage = 0; renderBoardPicker(); }); });
      $("boardPrev").addEventListener("click", () => { boardPage = Math.max(0, boardPage - 1); renderBoardPicker(); });
      $("boardNext").addEventListener("click", () => { boardPage += 1; renderBoardPicker(); });
      renderBoardPicker();
      syncBoardChoice();
