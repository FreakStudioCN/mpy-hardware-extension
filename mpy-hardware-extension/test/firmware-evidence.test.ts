import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyFirmwareEvidence,
  describeFirmwareEvidence,
  postRebootLines,
} from "../src/cli/firmware-evidence.ts";

// Both captures below are verbatim from real hardware runs on a Pico 2, not composed for the
// test. The point of using real text is that the two cases are genuinely hard to tell apart:
// neither one contains the name of the build the run produced, and the old check keyed on
// exactly that absence.

// A blink run that WORKED. The boot line names the build, so this is the easy case and the one
// that must not regress.
const RAN_CAPTURE = [
  "^DConnected to MicroPython at /dev/cu.usbmodem101",
  "Use Ctrl-] or Ctrl-x to exit this shell",
  "",
  "MPY: soft reboot",
  "[t=40616244ms] Onboard LED blink booting",
  "[t=40616294ms] onboard LED driver ready on pin 25",
  "[t=40616336ms] blink task created (interval 1000 ms)",
  "MPYHW_READY",
].join("\n");

// A blink run whose freshly uploaded main.py died on its first log call. The file on the device
// was later confirmed byte-identical to the one the run had just uploaded, so this IS our build,
// and the summary reported "STALE DEVICE: nothing this run built reached the board".
const CRASHED_CAPTURE = [
  "^DConnected to MicroPython at /dev/cu.usbmodem101",
  "Use Ctrl-] or Ctrl-x to exit this shell",
  "",
  "MPY: soft reboot",
  "[t=29922ms] [fatal] main.py startup failed",
  "Traceback (most recent call last):",
  '  File "main.py", line 66, in <module>',
  '  File "main.py", line 45, in _main',
  '  File "main.py", line 25, in _log_info',
  "TypeError: format string didn't convert all arguments",
  "MicroPython v1.28.0 on 2026-04-06; Raspberry Pi Pico2 with RP2350",
  'Type "help()" for more information.',
  ">>>",
].join("\n");

const BLINK_NAME = "Onboard LED blink";
// A real project name from a DHT11 run. Pairing it with the blink capture above reproduces the
// case this check exists for: the run built a DHT11 logger, the deploy never uploaded, and the
// board is still booting the blink firmware from an earlier series. Both halves are real; the
// pairing is what the archive no longer holds an example of.
const DHT11_NAME = "DHT11 temperature and humidity logger";

test("a startup crash is reported as a crash, not as a foreign build", () => {
  const lines = postRebootLines({ final_reset_excerpt: CRASHED_CAPTURE });
  const evidence = classifyFirmwareEvidence(lines, BLINK_NAME);

  assert.equal(evidence.kind, "crashed");
  // The runtime's exception, not the "[fatal]" line, which is wording the generator chose and is
  // absent entirely when main.py carries no try/except.
  assert.match(describeFirmwareEvidence(evidence, BLINK_NAME), /RAISED on startup.*TypeError/);
  assert.doesNotMatch(describeFirmwareEvidence(evidence, BLINK_NAME), /DIFFERENT build/);
});

test("a genuinely foreign build is still called stale", () => {
  const lines = postRebootLines({ final_reset_excerpt: RAN_CAPTURE });
  const evidence = classifyFirmwareEvidence(lines, DHT11_NAME);

  assert.equal(evidence.kind, "foreign");
  assert.match(describeFirmwareEvidence(evidence, DHT11_NAME), /DIFFERENT build/);
});

test("a boot line naming the build this run produced still proves it ran", () => {
  const lines = postRebootLines({ final_reset_excerpt: RAN_CAPTURE });
  const evidence = classifyFirmwareEvidence(lines, BLINK_NAME);

  assert.equal(evidence.kind, "ran");
  assert.match(describeFirmwareEvidence(evidence, BLINK_NAME), /^yes — "\[t=40616244ms\] Onboard LED blink booting"/);
});

test("a crash is recognised with no conf.py to name the build", () => {
  // builtProjectName() returns null when the run never got as far as writing conf.py. Knowing the
  // firmware raised does not depend on knowing its name, and the old check went silent here.
  const lines = postRebootLines({ final_reset_excerpt: CRASHED_CAPTURE });
  assert.equal(classifyFirmwareEvidence(lines, null).kind, "crashed");
});

test("unnamed output with no crash and no name to match against claims nothing", () => {
  const lines = postRebootLines({ final_reset_excerpt: RAN_CAPTURE });
  assert.equal(classifyFirmwareEvidence(lines, null).kind, "absent");
});

test("an empty capture is absent, not a crash and not foreign", () => {
  assert.equal(classifyFirmwareEvidence(postRebootLines({}), BLINK_NAME).kind, "absent");
  assert.equal(classifyFirmwareEvidence(postRebootLines({ serial_excerpt: "" }), BLINK_NAME).kind, "absent");
});

test("both captures are read, not just the serial one", () => {
  // A deploy that runs one capture puts its only proof in final_reset_excerpt.
  const fromReset = postRebootLines({ serial_excerpt: "", final_reset_excerpt: RAN_CAPTURE });
  assert.equal(classifyFirmwareEvidence(fromReset, BLINK_NAME).kind, "ran");
  const fromNested = postRebootLines({ final_reset: { output: RAN_CAPTURE } });
  assert.equal(classifyFirmwareEvidence(fromNested, BLINK_NAME).kind, "ran");
});

test("mpremote's own banner is never mistaken for firmware output", () => {
  const bannerOnly = ["Connected to MicroPython at /dev/cu.usbmodem101",
                      "Use Ctrl-] or Ctrl-x to exit this shell"].join("\n");
  assert.equal(classifyFirmwareEvidence(postRebootLines({ serial_excerpt: bannerOnly }), DHT11_NAME).kind, "absent");
});
