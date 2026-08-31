// What the serial capture proves about the firmware the board actually ran.
//
// A boot line naming the build this run produced proves it ran. Output naming a DIFFERENT build
// proves a stale device: a deploy that fails before uploading leaves the previous firmware
// booting exactly like a success, and a DHT11 run was once reported "firmware ran: yes" on the
// strength of blink output left over from an earlier series.
//
// Between those two sits the case that cost a whole session. Firmware that RAISES before it can
// print its name leaves a traceback and nothing else, so the name can never appear -- and reading
// that absence as "a different build" turns our own crash into an accusation that the upload
// never landed. Measured: a Pico 2 blink run uploaded a main.py whose first log call died with
// TypeError, and the summary said "STALE DEVICE: nothing this run built reached the board" while
// the file on the device was byte-identical to the one just uploaded. The two readings send you
// at opposite bugs, so a crash has to be its own answer rather than a weak kind of foreign.
export type FirmwareEvidence =
  | { kind: "ran"; line: string }
  | { kind: "crashed"; line: string }
  | { kind: "foreign"; line: string }
  | { kind: "absent" };

export const MPREMOTE_BANNER = /^(MPY:|Connected to MicroPython|Use Ctrl-)/;

// The scaffold prints these two from templates/firmware/main_*.py.tmpl -- "Deploy capture waits for
// this exact line after hardware init" -- so EVERY build emits them, verbatim and identical. They
// prove the board booted; they cannot prove WHICH build booted, and one standing alone as the only
// post-reboot line was reported as `the board is running a DIFFERENT build: "MPYHW_READY"`. They
// are also capture_repl.py's default --stop-pattern, and a stop-pattern match ENDS the capture, so
// a capture ending on one with nothing after it is the ordinary shape, not a rare one.
// Whole-line, so a build's own "starting scheduler for pump" still counts as its output.
const SCAFFOLD_BOOT_MARKER = /^(MPYHW_READY|starting scheduler)$/;

// A capture holds raw terminal bytes, not the text a human read back off the terminal. mpremote's
// own keystrokes echo into it: the archive records "^D\b\bConnected to MicroPython", where the
// terminal printed the Ctrl-D as the two ordinary characters "^D" and then erased them with two
// backspaces. Every pattern in this file is anchored at the start of the line, which is what makes
// them precise, and an anchor cannot see past that debris -- so the banner filter missed mpremote's
// own greeting, and a capture holding nothing but tooling chatter was reported as a DIFFERENT build.
//
// The backspaces have to be APPLIED, not merely dropped: the "^D" is literal text (bytes 5e 44),
// so deleting the control bytes alone still leaves "^DConnected..." and the anchor still misses.
// Normalising here rather than at each pattern fixes the traceback and exception anchors too, which
// carry the identical blind spot.
// CSI only, with ECMA-48's full parameter-byte range rather than the digits and semicolons SGR
// happens to use: a colon-delimited parameter (ITU-T T.416 truecolour, "\x1b[38:2:255:0:0m") is
// valid and would otherwise match NOTHING, since no final byte follows, leaving "[38:2:255:0:0m"
// as printable debris at the start of the line -- exactly the blindness this function exists to
// remove. Other escape forms (OSC, two-character) are deliberately NOT handled: no ESC byte at all
// appears anywhere in the archived captures, so anything past CSI would be speculative.
const ANSI_ESCAPE = /\x1b\[[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]/g;
// Everything C0 except tab and \n; \n and \r are consumed by the line split in postRebootLines,
// so neither reaches here and only tab is a deliberate survivor.
const CONTROL_BYTES = /[\x00-\x08\x0b-\x1f\x7f]/g;

/** One capture line as the terminal rendered it: CSI sequences gone, backspaces applied.
 *
 * Other escape forms degrade rather than vanish: the ESC byte is stripped as a control byte and
 * the payload stays, so an OSC title would leave "]0;title". Worded that way because "escapes
 * gone" would overstate what this does.
 *
 * One place this is deliberately NOT terminal rendering: a bare \r arrives here already split into
 * a separate line (see postRebootLines), because on a serial link \r alone is a line terminator.
 * A terminal would instead return the cursor and let the next text OVERWRITE this line, so text a
 * terminal never showed can survive as its own line. The cost is real but bounded -- an in-place
 * progress line would surface both its states, and if the overwritten half named the build, that
 * half could carry a "ran" verdict. Left as-is because no producer on this path emits a bare \r
 * for in-place updates (MicroPython's REPL terminates with \r\n), and because the alternative
 * loses genuine \r-terminated device lines, which this path does see.
 */
export function renderTerminalLine(raw: string): string {
  const rendered: string[] = [];
  for (const ch of raw.replace(ANSI_ESCAPE, "")) {
    if (ch === "\b") rendered.pop();
    else rendered.push(ch);
  }
  return rendered.join("").replace(CONTROL_BYTES, "").trim();
}

// The runtime's own traceback, not anything our codegen prints. A generated main.py picks its own
// wording for the fatal line it logs -- one run said "[fatal] main.py startup failed" -- so keying
// on that would recognise only the crashes we happen to have seen already. These two come from
// MicroPython itself and hold for any generated tree.
const TRACEBACK_HEADER = /^Traceback \(most recent call last\)/;
const TRACEBACK_FRAME = /^\s*File "[^"]+\.py", line \d+/;
// Which line to show for a crash. The first post-reboot line is whatever the firmware logged on
// its way down, which is generated wording and is absent entirely when main.py has no try/except;
// the exception line is the runtime's and is the thing a reader needs.
const EXCEPTION_LINE = /^[A-Za-z_][A-Za-z0-9_.]*(Error|Exception|Interrupt|Exit)\b/;

// capture_repl.py --reset-first sends Ctrl-C BEFORE Ctrl-D, and has to: Ctrl-D only reboots an IDLE
// REPL, and a successful deploy leaves the board running its app, which swallows it. That interrupt
// raises out of the running main.py, so a final-reset capture opens with a traceback WE caused --
// and its frames name main.py exactly like a startup crash's do, which is why frames cannot tell
// the two apart. The scanner forgives it on its own side (deploy_result.py's
// all_tracebacks_recovered_after_interrupt); this is the same rule on ours, keyed on the exception
// the interrupt raises, which is the one thing the two cases do NOT share. --reset-first is
// mandatory for a success deploy (deploy_result.py's final_reset_not_reset_first), so this is every
// deploy, not an edge case.
const INTERRUPT_EXCEPTION = /^KeyboardInterrupt\b/;

const EXCERPT_CHARS = 70;

const excerpt = (line: string): string => line.slice(0, EXCERPT_CHARS);

// The interpreter's own banner names the BOARD ("Raspberry Pi Pico2 with RP2350"), not the build.
const RUNTIME_BANNER = /^MicroPython v\d/;

// Whole-name match on a firmware line. A bare substring test read "blink" as proven by the
// previous build's "onboard_led_blink booting" -- the stale device this module exists to catch --
// and "main" as proven by a traceback frame's `File "main.py"`.
function namesBuild(line: string, name: string): boolean {
  if (RUNTIME_BANNER.test(line) || TRACEBACK_HEADER.test(line) || TRACEBACK_FRAME.test(line)) return false;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^A-Za-z0-9_])${escaped}([^A-Za-z0-9_]|$)`).test(line);
}

/**
 * Every capture line after the soft reboot, with mpremote's own chatter dropped.
 *
 * Reads BOTH captures, not just the serial one. The final reset is by contract the LAST device
 * operation, so a deploy that runs one capture puts its only proof in final_reset_excerpt and
 * leaves serial_excerpt empty -- and two runs were reported "firmware ran: NOT OBSERVED" while
 * their final reset held "MPY: soft reboot" and the boot line.
 */
export function postRebootLines(report: any): string[] {
  const captured = [report?.serial_excerpt, report?.final_reset_excerpt,
                    report?.final_reset?.output_excerpt, report?.final_reset?.output]
    .map((v: unknown) => (typeof v === "string" ? v : ""))
    .filter(Boolean)
    .join("\n");
  // A bare \r ends a line too. Stripping it instead would splice two rendered lines into one and
  // push a "Traceback (most recent call last):" off the start of its line, re-creating against the
  // traceback anchor exactly the blind spot renderTerminalLine exists to close.
  const lines = captured.split(/\r\n|[\r\n]/).map(renderTerminalLine).filter(Boolean);
  // No reboot line means no slice point, so the whole capture is treated as firmware output.
  const rebootAt = lines.findIndex((l: string) => l.includes("soft reboot"));
  // Not every board prints "MPY: soft reboot" -- capture_repl.py's own observed_fresh_boot()
  // docstring says so -- and without that line the Ctrl-C traceback has nothing to be sliced away
  // by, so it reached the verdict as "the firmware RAISED on startup: KeyboardInterrupt". The
  // interrupt's own exception line is the fallback slice point. Whichever marker sits LATER is
  // where firmware output really starts, so a genuine crash after the reboot is still kept.
  const interruptAt = lines.findIndex((l: string) => INTERRUPT_EXCEPTION.test(l));
  return lines
    .slice(Math.max(rebootAt, interruptAt) + 1)
    .filter((l: string) => !MPREMOTE_BANNER.test(l) && !SCAFFOLD_BOOT_MARKER.test(l));
}

const raisedLine = (lines: string[]): string | undefined =>
  lines.find((l) => TRACEBACK_HEADER.test(l) || TRACEBACK_FRAME.test(l));

/** Classify post-reboot output against the name this run built. */
export function classifyFirmwareEvidence(lines: string[], builtName: string | null): FirmwareEvidence {
  const owned = builtName ? lines.find((l) => namesBuild(l, builtName)) : undefined;
  if (owned) return { kind: "ran", line: excerpt(owned) };
  if (!lines.length) return { kind: "absent" };

  // Order matters, and it is the whole fix. A crash is checked BEFORE a foreign build, because
  // firmware that raised before printing its name produces exactly the "no name matched" evidence
  // that would otherwise be read as a stale device. Only one of those two readings can be right.
  if (raisedLine(lines)) {
    // Knowing the firmware raised does not require knowing its name, so this holds even when
    // there is no conf.py to read.
    return { kind: "crashed", line: excerpt(lines.find((l) => EXCEPTION_LINE.test(l)) ?? lines[0]) };
  }

  // With no name to compare against, output from an unknown build is not evidence of anything.
  if (!builtName) return { kind: "absent" };
  return { kind: "foreign", line: excerpt(lines[0]) };
}

/** The "firmware ran during deploy:" line. */
export function describeFirmwareEvidence(evidence: FirmwareEvidence, builtName: string | null): string {
  switch (evidence.kind) {
    case "ran":
      return `yes — "${evidence.line}"`;
    case "crashed":
      return `NO — the firmware on the board RAISED on startup: "${evidence.line}"`;
    case "foreign":
      return `NO — the board is running a DIFFERENT build: "${evidence.line}" (this run built "${builtName}")`;
    case "absent":
      return "NOT OBSERVED (no serial evidence in deploy_result.json)";
  }
}
