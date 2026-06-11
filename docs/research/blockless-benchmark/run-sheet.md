# Benchmark Run Sheet

## Run Identity

- Run id:
- Date:
- Tester:
- System:
- System version or URL:
- Task id:
- Prompt:

## Hardware Inventory

| Kind | Name | Version or variant | Notes |
| --- | --- | --- | --- |
| Board |  |  |  |
| Module |  |  |  |
| Module |  |  |  |
| Cable/power |  |  |  |

## Preregistration

- Preregistration file:
- Hardware frozen before first system run: yes / no
- Systems planned before first run:
- Systems actually run:
- Deviations from preregistration:
- Access/payment/account blockers:

## Starting Condition

- Tester experience: beginner / intermediate / expert
- Prior project state:
- Network available: yes / no
- Fresh install or existing workspace:

## Procedure

1. Enter the task prompt exactly as written unless the tested system requires a different input form.
2. Record every prompt, click, generated artifact, manual edit, and manual wiring change.
3. Do not silently fix generated code, package versions, wiring, or pins. Count each intervention.
4. Attempt install, flash, and run on real hardware when the system supports it.
5. Save install logs, flash logs, serial logs, run logs, screenshots, and video.
6. If the first run fails, allow the system to repair. Record whether it used logs and hardware context.
7. For recipe tasks, hand the produced artifact to a second tester and record whether they can rerun it.

## Counts

- Prompts:
- Manual docs searches:
- Manual code edits:
- Manual wiring changes:
- Install attempts:
- Flash attempts:
- Repair attempts:

## Failure Labels

Check all that apply:

- [ ] intent_misread
- [ ] board_mismatch
- [ ] module_mismatch
- [ ] pin_invalid
- [ ] wiring_unknown
- [ ] wiring_wrong
- [ ] driver_missing
- [ ] driver_api_wrong
- [ ] package_version
- [ ] install_failure
- [ ] flash_failure
- [ ] runtime_exception
- [ ] behavior_wrong
- [ ] log_unhelpful
- [ ] repair_wrong
- [ ] recipe_incomplete
- [ ] not_reproducible
- [ ] unknown

## Evidence Files

- Prompt log:
- Generated code:
- Wiring artifact:
- Install log:
- Flash log:
- Serial log:
- Run log:
- Screenshots or video:
- Recipe artifact:

## Artifact Audit

This section prevents project pages, dashboards, code bundles, tutorials, and
recipes from being treated as equivalent.

- Primary output type: verified_recipe / project / tutorial / code_bundle / firmware_binary / dashboard / simulation / yaml_config / iot_cloud_template / node_red_flow / device_cloud_project / ide_project / platformio_project / arduino_project / app_lab_project / esp_idf_project / vendor_tutorial / edge_ai_model_bundle / device_fleet_project / connectivity_project / guide / unknown
- Machine readable: yes / no
- What exactly does the second tester receive?

Preserved context:

- [ ] Board profile, exact variant, MCU/runtime constraints
- [ ] Module variants, protocols, voltage/current requirements
- [ ] Pin assignments and conflict checks
- [ ] Wiring diagram/profile or wiring photo
- [ ] Code files
- [ ] Package/library names and versions
- [ ] Install, flash, and run methods
- [ ] Install/flash/serial/run logs
- [ ] Repair history and known failure hints
- [ ] Endpoint manifest, payload schema, auth/retry behavior
- [ ] Compatibility matrix and known incompatible variants
- [ ] Rerun history

Artifact notes:

## Scoring

Use 0 to 10 for each category. Penalize manual hidden work.

| Category | Score | Notes |
| --- | ---: | --- |
| Intent understanding |  |  |
| Board/module/pin/package selection |  |  |
| Wiring correctness |  |  |
| Dependency/package handling |  |  |
| Flash and run |  |  |
| Log capture and interpretation |  |  |
| Repair quality |  |  |
| Recipe/package completeness |  |  |
| Second-user reproducibility |  |  |
| Penalties, 0 to -30 |  |  |
| Total, 0 to 100 |  |  |

## Result

- Status: pass / partial / fail / blocked
- Physical behavior verified: yes / no
- Second-user rerun verified: yes / no

Summary:

## Claim Impact

Which Blockless claims does this support?

Which Blockless claims does this weaken?

What would need to be true before this result can be used in a pitch deck?
