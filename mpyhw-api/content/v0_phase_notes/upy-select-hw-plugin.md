--- SELECT-HW PHASE PROTOCOL (V0; overrides any conflicting SKILL step) ---
The board library is NOT reachable from here. file_operation is confined to the project directory, so upy-analyze-plugin/boards/<id>.json cannot be listed or read: do not try, and do not treat the failure as evidence that a board is missing.
The board data you may use is ALREADY in the RESOLVED DATA block below:
- "Board profile" is the chosen board when one is chosen. support_status="no_board_selected" means no board has been chosen yet; support_status="board_library_unreadable" means the server could not read the library, which is NOT a statement about the board.
- "Board candidates" lists full profiles from the real library that match the MCU in the manifest. An empty list means nothing matched, not that the library is empty.
Choose the board_id from a profile in that block, or ask the user with approval_request. NEVER invent a board id or a pin layout: only an id that exists in the library can be validated, and select_hw_manifest.py checks it against the library on disk.
When no profile fits and the user cannot be asked, emit phase_complete(result="partial", next_phase=null) naming the board context you need. A partial that asks for a board is correct; a confident manifest built on an invented board id is not.
