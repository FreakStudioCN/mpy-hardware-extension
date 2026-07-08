// The §6 reroute / absorb / reconfirm classifier (deliverables 07). A pure function
// over the supplement text + attachments: it returns the RECOMMENDED handling from the
// spec table. The stateful caller (SessionController) applies the "reconfirm if code
// already exists" nuance via `reconfirmIfCode`, since only it knows whether code was
// generated. For P0, reroute/reconfirm are flag-and-surface (no auto-jump); absorb folds
// the text into the next phase's context.
//
// ponytail: keyword/regex heuristic, not semantic. Ceiling — a note that spans two
// categories takes the first rule that fires (order below is most-specific first).
// Upgrade path (P1/P2, spec §2): the full user_supplement protocol lets the Skill classify.

export type SupplementDecision = "absorb" | "reroute" | "reconfirm";

// A file/link the user attached with a supplement (e.g. a datasheet PDF). Kept minimal
// for P0; the spec calls this ArtifactRef.
export interface SupplementAttachment {
  kind: string;
  ref: string;
}

export interface SupplementRoute {
  decision: SupplementDecision;
  // The Skill a reroute points at (spec §6), else null for absorb.
  target: string | null;
  reason: string;
  // The caller flips the decision to "reconfirm" when code already exists (spec §6:
  // change pin -> reconfirm if code exists; change wiring/diagram format -> reconfirm
  // rerun if already generated).
  reconfirmIfCode: boolean;
}

// Reroute targets — Skill names, matching the spec table and protocol PHASE_ALIASES.
const ANALYZE = "upy-analyze-plugin";
const SELECT_HW = "upy-select-hw-plugin";
const GEN_DRIVER = "upy-gen-driver-plugin";

const DRIVER_RE = /\b(datasheet|arduino|c\+\+|reference code|register map|part number|chip model|module model)\b|github\.com/i;
// Output-format change must be tested BEFORE the pin/wiring rule, since it also contains
// "wiring" — "change the wiring diagram format" is a format tweak, not a pin change.
const FORMAT_RE = /\b(wiring|diagram)\b[^.]*\b(format|layout|style|svg|png|orientation)\b|\b(format|layout|style)\b[^.]*\b(wiring|diagram)\b/i;
const ADD_HW_RE = /\b(add|also|another|include|extra)\b[^.]*\b(sensor|led|button|display|oled|screen|motor|servo|relay|buzzer|module|hardware|component|rgb)\b/i;
// Also catch a swap phrased as "... instead" (no explicit replace/swap verb). The
// component-noun list here deliberately omits board/mcu terms so "use an esp32 board
// instead" falls through to the board rule (select-hw), not analyze.
const REPLACE_HW_RE = /\b(replace|swap)\b[^.]*\b(sensor|module|hardware|component|device|part)\b|\b(sensor|module|component|device|part|led|display|oled|screen|motor|servo|relay|buzzer)\b[^.]*\binstead\b/i;
const BOARD_RE = /\b(board|mcu|microcontroller|esp32|esp8266|rp2040|pico|stm32|nrf52)\b/i;
const PIN_RE = /\b(pin|gpio|wire|wiring|rewire|solder|breadboard|connector)\b/i;
const LOGIC_RE = /\b(threshold|logic|interval|cycle|period|delay|state machine|debounce|frequency|timeout|condition|trigger)\b/i;
// Failure words are matched with their common inflections (fail/failed/failure,
// crash/crashed, error/errors) — a bare \bfail\b misses "failed", the most common phrasing.
const DEPLOY_RE = /\b(deploy|upload|flash)(?:ed|ing|s)?\b[^.]*\b(fail(?:ed|ing|ure|s)?|errors?|not work(?:ing)?|broke(?:n)?|crash(?:ed|ing|es)?)\b|\b(fail(?:ed|ing|ure|s)?|errors?|crash(?:ed|ing|es)?|broke(?:n)?)\b[^.]*\b(deploy|upload|flash)(?:ed|ing|s)?\b/i;

function route(decision: SupplementDecision, target: string | null, reason: string, reconfirmIfCode: boolean): SupplementRoute {
  return { decision, target, reason, reconfirmIfCode };
}

function isDriverMaterial(text: string, attachments: SupplementAttachment[]): boolean {
  const hasPdf = attachments.some((a) => a.kind === "pdf" || /\.pdf(\b|$)/i.test(a.ref ?? ""));
  return hasPdf || DRIVER_RE.test(text);
}

// Map a user supplement to its recommended handling (spec §6, first match wins).
export function classifySupplement(text: string, attachments: SupplementAttachment[] = []): SupplementRoute {
  const t = text ?? "";
  if (isDriverMaterial(t, attachments)) return route("reroute", GEN_DRIVER, "Driver material (datasheet / reference code / model) needs missing-driver generation.", false);
  if (FORMAT_RE.test(t)) return route("absorb", null, "Output-format change: fold in; reconfirm a rerun if the artifact already exists.", true);
  if (ADD_HW_RE.test(t)) return route("reroute", ANALYZE, "New functional hardware changes the requirement and device list.", false);
  if (REPLACE_HW_RE.test(t)) return route("reroute", ANALYZE, "Replacing hardware may change pins, drivers, and board capability.", false);
  // Deploy-failure feedback (deploy/upload/flash + a failure word) is tested BEFORE the
  // board rule: "upload failed on my esp32 board" is deploy feedback, not a board change,
  // so a bare board mention must not reroute the user back to hardware selection.
  if (DEPLOY_RE.test(t)) return route("absorb", null, "Deploy feedback folds into the deploy fix / autofix step.", false);
  if (BOARD_RE.test(t)) return route("reroute", SELECT_HW, "Board / MCU change affects capability, firmware, and pin plan.", false);
  if (PIN_RE.test(t)) return route("reroute", SELECT_HW, "Pin / wiring change affects the pin plan; reconfirm if code already exists.", true);
  if (LOGIC_RE.test(t)) return route("absorb", null, "Logic / threshold / timing change folds into the generated code.", false);
  return route("absorb", null, "General supplement folded into the next phase context.", false);
}
