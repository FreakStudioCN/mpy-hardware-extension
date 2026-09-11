import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyFirmwareEvidence,
  classifyFirmwareReport,
  describeFirmwareEvidence,
  postRebootLines,
  renderTerminalLine,
} from "../src/cli/firmware-evidence.ts";

// Both captures below are verbatim from real hardware runs on a Pico 2, not composed for the
// test. The point of using real text is that the two cases are genuinely hard to tell apart:
// neither one contains the name of the build the run produced, and the old check keyed on
// exactly that absence.

// A blink run that WORKED. The boot line names the build, so this is the easy case and the one
// that must not regress.
// The "^D\b\b" prefix is byte-for-byte what the archive holds (5e 44 08 08): the terminal echoed
// the Ctrl-D as the two ordinary characters "^D", then erased them with two backspaces. Earlier
// fixtures here transcribed the "^D" but dropped the backspaces, which is why they could not
// reproduce the misclassification below.
const RAN_CAPTURE = [
  "^D\b\bConnected to MicroPython at /dev/cu.usbmodem101",
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
  "^D\b\bConnected to MicroPython at /dev/cu.usbmodem101",
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

test("a name that is a substring of the previous build's name does not prove this build ran", () => {
  // The stale-device case the module exists to catch: run 2 built "blink", the board still boots
  // run 1's "onboard_led_blink". A substring test called that "ran".
  const stale = ["MPY: soft reboot", "[t=1ms] onboard_led_blink booting", "MPYHW_READY"].join("\n");
  const lines = postRebootLines({ final_reset_excerpt: stale });
  assert.equal(classifyFirmwareEvidence(lines, "blink").kind, "foreign");
  assert.equal(classifyFirmwareEvidence(lines, "onboard_led_blink").kind, "ran");
});

test("the interpreter banner never proves a build ran", () => {
  // "Raspberry Pi Pico2 with RP2350" is MicroPython naming the BOARD after a crash.
  const lines = postRebootLines({ final_reset_excerpt: CRASHED_CAPTURE });
  assert.equal(classifyFirmwareEvidence(lines, "Pico2").kind, "crashed");
  assert.equal(classifyFirmwareEvidence(lines, "RP2350").kind, "crashed");
});

test("the banner is still recognised when the echoed Ctrl-D precedes it", () => {
  // The case above passes only because its banner is clean. Real captures carry the echoed
  // keystroke ahead of it, which defeats the anchored match and leaves mpremote's greeting standing
  // as the sole "firmware" line -- a capture proving nothing then reads as a board running someone
  // else's build. Mutation: drop the backspace handling in renderTerminalLine and this returns
  // "foreign".
  const bannerOnly = ["^D\b\bConnected to MicroPython at /dev/cu.usbmodem101",
                      "Use Ctrl-] or Ctrl-x to exit this shell"].join("\r\n");
  assert.equal(classifyFirmwareEvidence(postRebootLines({ serial_excerpt: bannerOnly }), DHT11_NAME).kind, "absent");
});

test("a foreign build is quoted by its firmware output, not by mpremote's greeting", () => {
  // Verbatim from an archived run whose board was genuinely running an older build: no reboot line
  // and no traceback, so every line is kept and the FIRST one is what gets quoted. With the echo
  // unhandled that first line is the greeting, so the report cited tooling chatter as its proof of
  // a different build. The verdict was right by luck; the evidence shown was not.
  const capture = ["^D\b\bConnected to MicroPython at /dev/cu.usbserial-0001",
                   "Use Ctrl-] or Ctrl-x to exit this shell",
                   "TEMP=29.0C HUM=72.0%",
                   "TEMP=29.0C HUM=72.0%"].join("\r\n");
  const evidence = classifyFirmwareEvidence(postRebootLines({ serial_excerpt: capture }), DHT11_NAME);

  assert.equal(evidence.kind, "foreign");
  assert.match(describeFirmwareEvidence(evidence, DHT11_NAME), /DIFFERENT build: "TEMP=29\.0C/);
  assert.doesNotMatch(describeFirmwareEvidence(evidence, DHT11_NAME), /Connected to MicroPython/);
});

test("a rendered line is what the terminal showed, not the bytes that produced it", () => {
  // Asserted directly because the end-to-end cases cannot isolate it: a traceback carries several
  // lines matching several patterns, so debris on any one of them is masked by the others.
  assert.equal(renderTerminalLine("^D\b\bConnected to MicroPython"), "Connected to MicroPython");
  assert.equal(renderTerminalLine("\x1b[0mTraceback (most recent call last):"), "Traceback (most recent call last):");
  assert.equal(renderTerminalLine("\x1b[2K\x1b[0G  File \"main.py\", line 13"), 'File "main.py", line 13');
  // A backspace with nothing to erase is a no-op, not a crash and not a swallowed character.
  assert.equal(renderTerminalLine("\b\bMPY: soft reboot"), "MPY: soft reboot");
  // Framing noise a UART emits as the port opens (a NUL, a bell, a bare ESC) blinds an anchor
  // exactly like the echoed keystroke does, and is invisible in a report that prints the line.
  assert.equal(renderTerminalLine("\x00\x07MPY: soft reboot"), "MPY: soft reboot");
  // Text with nothing to render is dropped by the caller's filter rather than kept as a blank line.
  assert.equal(renderTerminalLine("^D\b\b"), "");
});

test("a CSI sequence is stripped for every parameter form, not just the digits SGR uses", () => {
  // A colon-delimited parameter is valid ECMA-48 (ITU-T T.416 truecolour). Against a digits-only
  // parameter class it matches NOTHING rather than matching partially, because no final byte
  // follows, so the whole sequence survives as printable debris at the start of the line -- the
  // exact blindness this normalisation exists to remove. Mutation: narrow the class back to
  // [0-9;?] and only this case fails.
  assert.equal(renderTerminalLine("\x1b[38:2:255:0:0mConnected to MicroPython"), "Connected to MicroPython");
  // The forms that already worked must keep working.
  assert.equal(renderTerminalLine("\x1b[1;31mMPY: soft reboot"), "MPY: soft reboot");
  assert.equal(renderTerminalLine("\x1b[?25lMPY: soft reboot"), "MPY: soft reboot");
  assert.equal(renderTerminalLine("\x1b[0 qMPY: soft reboot"), "MPY: soft reboot");
  // A CHARACTERISATION of a known limit, not a contract. Only CSI is handled, so an OSC payload
  // survives with its ESC stripped. If this assertion ever fails because OSC is now being
  // stripped, that is an improvement: update the expectation, do not restore the old behaviour.
  // It is here so the limit stays visible rather than becoming an accident nobody remembers
  // choosing. No archived capture holds an ESC byte of any kind.
  assert.equal(renderTerminalLine("\x1b]0;title\x07MPY: soft reboot"), "]0;titleMPY: soft reboot");
});

test("a traceback is found even when every line carries terminal debris", () => {
  // The traceback and exception patterns are anchored exactly like the banner one, so they share
  // its blind spot. Debris on the header alone proves nothing -- the File frame would still match
  // and carry the verdict -- so this puts it on both, leaving no unobstructed anchor.
  // Mutation: drop the ANSI_ESCAPE replace and this returns "foreign".
  const capture = ["MPY: soft reboot",
                   "\x1b[0mTraceback (most recent call last):",
                   '\x1b[0m  File "main.py", line 13, in <module>',
                   "ImportError: no module named 'lib.logger'"].join("\r\n");
  const evidence = classifyFirmwareEvidence(postRebootLines({ final_reset_excerpt: capture }), DHT11_NAME);

  assert.equal(evidence.kind, "crashed");
  assert.match(describeFirmwareEvidence(evidence, DHT11_NAME), /RAISED on startup.*ImportError/);
});

test("a bare carriage return ends a line rather than splicing two together", () => {
  // Stripping \r instead of splitting on it would weld the traceback onto the previous line and
  // push its anchor off the start, reproducing the same class of miss one layer down.
  const capture = "MPY: soft reboot\r[boot] starting\rTraceback (most recent call last):\rValueError: bad pin";
  const evidence = classifyFirmwareEvidence(postRebootLines({ final_reset_excerpt: capture }), DHT11_NAME);

  assert.equal(evidence.kind, "crashed");
  assert.match(describeFirmwareEvidence(evidence, DHT11_NAME), /ValueError: bad pin/);
});

// capture_repl.py --reset-first sends Ctrl-C before Ctrl-D (it has to: Ctrl-D only reboots an IDLE
// REPL, and a successful deploy leaves the board running its app). So a final-reset capture now
// opens with a traceback WE caused, and --reset-first is mandatory for a success deploy, making
// this every deploy rather than an edge case.
const INTERRUPT_TRACEBACK = [
  "^D\b\bConnected to MicroPython at /dev/cu.usbmodem101",
  "Use Ctrl-] or Ctrl-x to exit this shell",
  "^C",
  "Traceback (most recent call last):",
  '  File "main.py", line 41, in <module>',
  "KeyboardInterrupt: ",
];

test("the Ctrl-C we send to reboot the board is not read as a startup crash", () => {
  // The board here is one capture_repl.py's own observed_fresh_boot() docstring describes: "Some
  // boards do not show SOFT_REBOOT_MARKER even though the firmware restarted during the capture."
  // With no reboot line there is no slice point, so before the interrupt slice the whole traceback
  // reached the verdict and a healthy deploy was reported as "the firmware RAISED on startup:
  // KeyboardInterrupt". Mutation: drop INTERRUPT_EXCEPTION from the slice and this returns
  // "crashed".
  const capture = [...INTERRUPT_TRACEBACK, "MPYHW_READY"].join("\r\n");
  const evidence = classifyFirmwareEvidence(postRebootLines({ final_reset_excerpt: capture }), DHT11_NAME);

  assert.equal(evidence.kind, "absent");
  assert.doesNotMatch(describeFirmwareEvidence(evidence, DHT11_NAME), /RAISED on startup/);
});

test("a real crash after our interrupt still reads as a crash", () => {
  // The interrupt must not become a blanket amnesty: firmware that raises on the restart AFTER the
  // Ctrl-C is the case this module exists to catch, and its traceback sits past the slice point.
  const capture = [...INTERRUPT_TRACEBACK,
                   "Traceback (most recent call last):",
                   '  File "main.py", line 13, in <module>',
                   "ValueError: bad pin"].join("\r\n");
  const evidence = classifyFirmwareEvidence(postRebootLines({ final_reset_excerpt: capture }), DHT11_NAME);

  assert.equal(evidence.kind, "crashed");
  assert.match(describeFirmwareEvidence(evidence, DHT11_NAME), /RAISED on startup.*ValueError: bad pin/);
});

test("on a board that does print the reboot line, the reboot is still the slice point", () => {
  // The two slice points are taken whichever sits LATER, and the difference is everything the OLD
  // app emits between the Ctrl-C and the reboot -- here its own dying traceback, which belongs to
  // the build being replaced and is not evidence about the restarted board at all. Mutation: slice
  // at the interrupt unconditionally and that pre-reboot traceback survives, turning a capture that
  // proves nothing into "the firmware RAISED on startup: OSError".
  const capture = [...INTERRUPT_TRACEBACK,
                   "Traceback (most recent call last):",
                   '  File "main.py", line 9, in <module>',
                   "OSError: [Errno 5] EIO",
                   "MPY: soft reboot",
                   "MPYHW_READY"].join("\r\n");
  const evidence = classifyFirmwareEvidence(postRebootLines({ final_reset_excerpt: capture }), DHT11_NAME);

  assert.equal(evidence.kind, "absent");
  assert.doesNotMatch(describeFirmwareEvidence(evidence, DHT11_NAME), /OSError/);
});

test("a scaffold boot marker never stands in as evidence of which build ran", () => {
  // MPYHW_READY and "starting scheduler" are printed verbatim by templates/firmware/main_*.py.tmpl,
  // so every build emits them and neither can identify one. They are also capture_repl.py's default
  // --stop-pattern, and a stop match ENDS the capture, so a capture whose last line is the marker is
  // the ordinary shape -- and it was reported as `the board is running a DIFFERENT build:
  // "MPYHW_READY"`. Mutation: drop SCAFFOLD_BOOT_MARKER from the filter and this returns "foreign".
  for (const marker of ["MPYHW_READY", "starting scheduler"]) {
    const evidence = classifyFirmwareEvidence(
      postRebootLines({ final_reset_excerpt: `MPY: soft reboot\r\n${marker}` }), DHT11_NAME);

    assert.equal(evidence.kind, "absent", marker);
  }
});

test("a build's own line is still its output when it merely starts like a boot marker", () => {
  // The marker filter is whole-line for this reason: "starting scheduler" is the scaffold's, but
  // "starting scheduler for pump" is the firmware talking about itself.
  const capture = `MPY: soft reboot\r\nstarting scheduler for ${DHT11_NAME}`;
  const evidence = classifyFirmwareEvidence(postRebootLines({ final_reset_excerpt: capture }), DHT11_NAME);

  assert.equal(evidence.kind, "ran");
});

// From here down: both captures are populated, modelled on the real run that started this fix.
// A single-capture fixture cannot express either failure mode below -- the join that loses the
// capture boundary is exactly what these are here to catch.

// The new app's real output: never names the build, so the old join's two failure modes had
// nothing else in the lines to fall back on.
const SENSOR_INIT_FAILURE_LINES = [
  "Sensor init failed: AHT20 init failed: [Errno 19] ENODEV",
  "Display init failed: SSD1306 init failed: [Errno 19] ENODEV",
];

// The serial capture: the OLD app dying to our own Ctrl-C, then the reboot, then the NEW app's
// real (unnamed) output.
const SERIAL_WITH_OWN_INTERRUPT = [
  "^C",
  "Traceback (most recent call last):",
  '  File "main.py", line 41, in <module>',
  "KeyboardInterrupt: ",
  "MPY: soft reboot",
  ...SENSOR_INIT_FAILURE_LINES,
].join("\r\n");

// A healthy serial capture: it DOES print the reboot line, unlike INTERRUPT_TRACEBACK's board
// (used for the final-reset side below), which has none.
const SERIAL_SENSOR_ONLY = ["MPY: soft reboot", ...SENSOR_INIT_FAILURE_LINES].join("\r\n");

test("a false crash: the serial capture's own interrupt does not amnesty the final reset's", () => {
  // Pre-fix, the joined findIndex finds BOTH markers inside the serial capture (its own interrupt,
  // then its own reboot), so the final reset's routine Ctrl-C traceback is never sliced away and
  // reaches the verdict as a crash. Mutation: revert to the joined single-slice form and this
  // returns "crashed".
  const finalReset = [...INTERRUPT_TRACEBACK, "MPYHW_READY"].join("\r\n");
  const lines = postRebootLines({ serial_excerpt: SERIAL_WITH_OWN_INTERRUPT, final_reset_excerpt: finalReset });
  const evidence = classifyFirmwareEvidence(lines, DHT11_NAME);

  assert.equal(evidence.kind, "foreign");
  assert.match(describeFirmwareEvidence(evidence, DHT11_NAME), /DIFFERENT build: "Sensor init failed/);
  assert.doesNotMatch(describeFirmwareEvidence(evidence, DHT11_NAME), /RAISED on startup/);
});

test("real output is not swallowed by an interrupt in a later capture", () => {
  // Pre-fix, the joined interruptAt lands inside the final reset capture (the serial capture has no
  // interrupt of its own), which is LATER than the reboot line, so the slice discards the serial
  // capture's real output entirely. Mutation: revert to the joined single-slice form and this
  // returns "absent".
  const finalReset = [...INTERRUPT_TRACEBACK].join("\r\n");
  const lines = postRebootLines({ serial_excerpt: SERIAL_SENSOR_ONLY, final_reset_excerpt: finalReset });
  const evidence = classifyFirmwareEvidence(lines, DHT11_NAME);

  assert.equal(evidence.kind, "foreign");
  assert.match(describeFirmwareEvidence(evidence, DHT11_NAME), /DIFFERENT build: "Sensor init failed/);
});

test("a genuine crash in the final-reset capture still reads as a crash", () => {
  // Guards the flatMap wiring: the per-capture slice must stop at the final reset's OWN interrupt,
  // not swallow the real traceback that follows it.
  const finalReset = [...INTERRUPT_TRACEBACK,
                      "Traceback (most recent call last):",
                      '  File "main.py", line 13, in <module>',
                      "ValueError: bad pin"].join("\r\n");
  const lines = postRebootLines({ serial_excerpt: SERIAL_SENSOR_ONLY, final_reset_excerpt: finalReset });
  const evidence = classifyFirmwareEvidence(lines, DHT11_NAME);

  assert.equal(evidence.kind, "crashed");
  assert.match(describeFirmwareEvidence(evidence, DHT11_NAME), /RAISED on startup.*ValueError: bad pin/);
});

test("a genuine crash in the serial capture still reads as a crash", () => {
  // Guards against the fix over-slicing the first capture: the final reset's routine interrupt must
  // not reach backwards and hide a real startup crash that already happened in the serial capture.
  const serial = [
    "^C",
    "Traceback (most recent call last):",
    '  File "main.py", line 41, in <module>',
    "KeyboardInterrupt: ",
    "MPY: soft reboot",
    "Traceback (most recent call last):",
    '  File "main.py", line 9, in <module>',
    "OSError: [Errno 5] EIO",
  ].join("\r\n");
  const finalReset = [...INTERRUPT_TRACEBACK].join("\r\n");
  const lines = postRebootLines({ serial_excerpt: serial, final_reset_excerpt: finalReset });
  const evidence = classifyFirmwareEvidence(lines, DHT11_NAME);

  assert.equal(evidence.kind, "crashed");
  assert.match(describeFirmwareEvidence(evidence, DHT11_NAME), /RAISED on startup.*OSError: \[Errno 5\] EIO/);
});

test("a build that names itself across the pair still reads as ran", () => {
  const serial = ["MPY: soft reboot", `[t=1ms] ${DHT11_NAME} booting`].join("\r\n");
  const finalReset = [...INTERRUPT_TRACEBACK, "MPYHW_READY"].join("\r\n");
  const lines = postRebootLines({ serial_excerpt: serial, final_reset_excerpt: finalReset });
  const evidence = classifyFirmwareEvidence(lines, DHT11_NAME);

  assert.equal(evidence.kind, "ran");
});

test("a later final-reset crash overrides an earlier owned boot line", () => {
  const serial = ["MPY: soft reboot", `[t=1ms] ${DHT11_NAME} booting`].join("\r\n");
  const finalReset = [...INTERRUPT_TRACEBACK,
                      "Traceback (most recent call last):",
                      '  File "main.py", line 13, in <module>',
                      "ValueError: bad pin"].join("\r\n");

  assert.equal(classifyFirmwareReport({ serial_excerpt: serial, final_reset_excerpt: finalReset }, DHT11_NAME).kind,
               "crashed");
});

test("a later owned boot line overrides an earlier crash", () => {
  const finalReset = ["MPY: soft reboot", `[t=2ms] ${DHT11_NAME} booting`].join("\r\n");

  assert.equal(classifyFirmwareReport({ serial_excerpt: CRASHED_CAPTURE, final_reset_excerpt: finalReset }, DHT11_NAME).kind,
               "ran");
});

// Isolated from the two-capture wiring above: these pin the findIndex (first-match) contract
// itself, one marker at a time, inside a single capture. Per scope's review focus, a drift to
// findLastIndex for either marker would let a SECOND marker amnesty a genuine crash that already
// happened before it.

test("a genuine crash between two interrupts still reads as a crash", () => {
  // Mutation: switch interruptAt to findLastIndex and this returns "absent" -- the second
  // interrupt becomes the slice point and swallows the crash sitting between the two.
  const capture = [...INTERRUPT_TRACEBACK,
                   "MPY: soft reboot",
                   "Traceback (most recent call last):",
                   '  File "main.py", line 13, in <module>',
                   "ValueError: bad pin",
                   "^C",
                   "Traceback (most recent call last):",
                   '  File "main.py", line 41, in <module>',
                   "KeyboardInterrupt: "].join("\r\n");
  const evidence = classifyFirmwareEvidence(postRebootLines({ final_reset_excerpt: capture }), DHT11_NAME);

  assert.equal(evidence.kind, "crashed");
  assert.match(describeFirmwareEvidence(evidence, DHT11_NAME), /RAISED on startup.*ValueError: bad pin/);
});

test("a genuine crash between two reboots still reads as a crash", () => {
  // Mutation: switch rebootAt to findLastIndex and this returns "absent" -- the second reboot
  // becomes the slice point and swallows the crash sitting between the two.
  const capture = ["MPY: soft reboot",
                   "Traceback (most recent call last):",
                   '  File "main.py", line 13, in <module>',
                   "ValueError: bad pin",
                   "MPY: soft reboot",
                   "MPYHW_READY"].join("\r\n");
  const evidence = classifyFirmwareEvidence(postRebootLines({ final_reset_excerpt: capture }), DHT11_NAME);

  assert.equal(evidence.kind, "crashed");
  assert.match(describeFirmwareEvidence(evidence, DHT11_NAME), /RAISED on startup.*ValueError: bad pin/);
});

test("a serial crash with no marker of its own still reads as a crash beside a marked final reset", () => {
  // The serial capture has neither a reboot line nor an interrupt of its own, so its whole
  // traceback is kept by the per-capture slice. On the old joined slice, the final reset's reboot
  // marker was the ONLY one found, landing past the serial capture's lines in the joined array and
  // discarding this traceback along with it, down to "absent". Fail-closed direction: pinned here
  // rather than left uncovered.
  const serial = [
    "Traceback (most recent call last):",
    '  File "main.py", line 9, in <module>',
    "ValueError: bad pin",
  ].join("\r\n");
  const finalReset = ["MPY: soft reboot", "MPYHW_READY"].join("\r\n");
  const lines = postRebootLines({ serial_excerpt: serial, final_reset_excerpt: finalReset });
  const evidence = classifyFirmwareEvidence(lines, DHT11_NAME);

  assert.equal(evidence.kind, "crashed");
  assert.match(describeFirmwareEvidence(evidence, DHT11_NAME), /RAISED on startup.*ValueError: bad pin/);
});
