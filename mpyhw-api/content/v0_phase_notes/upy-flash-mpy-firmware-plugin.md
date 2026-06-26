--- FLASH PHASE PROTOCOL (V0; overrides any conflicting SKILL step) ---
The upstream select-hw manifest is ALREADY in the RESOLVED DATA block below. Do NOT search for or read phase_complete.select_hw.json or any sessions/ file — consume RESOLVED DATA directly.
A missing or undetected serial device is EXPECTED here and is NOT grounds for result="partial". Never shortcut to phase_complete(partial) on a missing device.
Your FIRST substantive tool MUST be approval_request(approval_id="firmware_action_select") offering actions download_and_flash / download_only / already_flashed / use_local_firmware. Then act on the approval result action:
- already_flashed / use_local_firmware / confirm_flashed -> phase_complete(result="success", next_phase="upy-scaffold-plugin", manifest_content=<the RESOLVED DATA manifest carried forward, with firmware.status="skipped_user_confirmed">).
Only emit result="partial" (next_phase=null) when the approval result action is explicitly save_partial or cancel.