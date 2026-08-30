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

const EXCERPT_CHARS = 70;

const excerpt = (line: string): string => line.slice(0, EXCERPT_CHARS);

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
  const lines = captured.split(/\r?\n/).map((l: string) => l.trim()).filter(Boolean);
  // No reboot line means no slice point, so the whole capture is treated as firmware output.
  const rebootAt = lines.findIndex((l: string) => l.includes("soft reboot"));
  return lines.slice(rebootAt + 1).filter((l: string) => !MPREMOTE_BANNER.test(l));
}

const raisedLine = (lines: string[]): string | undefined =>
  lines.find((l) => TRACEBACK_HEADER.test(l) || TRACEBACK_FRAME.test(l));

/** Classify post-reboot output against the name this run built. */
export function classifyFirmwareEvidence(lines: string[], builtName: string | null): FirmwareEvidence {
  const owned = builtName ? lines.find((l) => l.includes(builtName)) : undefined;
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
