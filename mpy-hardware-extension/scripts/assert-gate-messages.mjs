// assert-gate-messages.mjs — every gate error a model receives must be ACTIONABLE.
//
// Usage: node scripts/assert-gate-messages.mjs
//
// Why this exists: five separate phase stalls, each costing an hour-long hardware run to
// diagnose, were all the same defect — a gate stated a true condition without saying where it
// looked, what it saw, or which command produces the value. The model then either rewrote whole
// files blindly until the turn cap, or wrote the gate's own output file by hand so the phase
// would "pass". Every one of those messages was reproducible from a saved payload in seconds.
//
// It replays the fixtures in test/fixtures/gate-messages (real payloads from real stalls)
// through the real plugin validators, and grades each error against the defect shapes:
//
//   no destination   — says a value is required/missing without naming the field path it goes to
//   no producer      — says "must record X" without naming the script/flag that emits X
//   no both-sides    — asserts a mismatch without naming the differing key and both values
//   says absent      — claims a field is missing when the fixture HAS it in another shape
//
// What it does NOT do: prove a model can act on a message. A message can satisfy every check
// here and still read badly. A clean run means "no KNOWN defect shape", not "this works".
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const extRoot = resolve(here, "..");
const repoRoot = resolve(extRoot, "..");
const skillsDir = join(repoRoot, "third_party", "MicroPython_Skills");
const fixturesDir = join(extRoot, "test", "fixtures", "gate-messages");

// fixture suffix -> the validator that grades it, and how it is invoked.
const GATES = [
  {
    match: /^generate-/,
    script: join(skillsDir, "upy-generate-plugin", "scripts", "check_phase_complete_consistency.py"),
    args: (fixture) => ["--phase-complete", fixture, "--project-dir", fixturesDir],
  },
  {
    match: /^selecthw-/,
    script: join(skillsDir, "upy-select-hw-plugin", "scripts", "select_hw_manifest.py"),
    args: (fixture, compare) => [
      "--validate-phase-complete", "--input", fixture,
      ...(compare ? ["--compare-manifest", compare] : []),
    ],
  },
  {
    match: /^diagram-/,
    script: join(skillsDir, "upy-diagram-plugin", "scripts", "diagram_manifest.py"),
    args: (fixture) => ["--validate-phase-complete", "--input", fixture, "--artifact-root", fixturesDir],
  },
  {
    match: /^gendriver-/,
    script: join(skillsDir, "upy-gen-driver-plugin", "scripts", "validate_phase_complete.py"),
    args: (fixture) => ["--input", fixture, "--artifact-root", fixturesDir],
  },
];

const VAGUE = /\b(is required|must record|must include|is missing|must be|not found|failed)\b/i;
const NAMES_PATH = /[a-z_]+\.[a-z_]+|payload\.|checks\.|manifest_content\.|\[\]/;
const NAMES_PRODUCER = /\.py\b|--[a-z-]+|verbatim|copy/;
const BOTH_SIDES = /differs at|expected|actual|payload=|compare=|project=|valid values|accepted|but the|e\.g\./;
const COMPARISON = /\b(differ|mismatch|does not match|must match|too old|later than)\b/i;

// The fourth shape, and the one the three above could not see. "manifest_content.generate.
// behavior_spec is required" names its destination perfectly and still cost a full run: the
// field WAS there, written as a prose string where an object was wanted, so the model read
// "required" as "absent", kept the string, and rewrote the payload around it for 17 calls.
//
// Detecting it needs the payload, not just the message: a message may only claim a value is
// missing when it actually is. If the path it names resolves to something in the fixture, the
// message has to say what was found there.
const CLAIMS_ABSENT = /\b(is required|are required|requires|must be present|is missing|are missing|must record|must include|must expose)\b/i;
const SAYS_WHAT_IT_SAW = /\bit is (a|an|absent|empty)|\bgot\b|\bfound\b|\breceived\b|\binstead\b/i;
const DOTTED_PATH = /\b((?:payload|manifest_content|checks|file_manifest|generate|state|session_state)(?:\.[a-z_]+)+)/i;

/** The value a message's dotted path points at inside the fixture, or undefined. */
function valueAtPath(fixture, path) {
  const payload = fixture?.payload ?? fixture;
  for (const root of [payload, payload?.manifest_content, fixture]) {
    let cursor = root;
    for (const key of path.split(".")) {
      if (key === "payload" && cursor === payload) continue;
      if (cursor === null || typeof cursor !== "object") { cursor = undefined; break; }
      cursor = cursor[key];
    }
    if (cursor !== undefined) return cursor;
  }
  return undefined;
}

/** Which defect shapes does one error entry trip? Empty array = actionable. */
function faultsIn(entry, fixture) {
  const message = String(entry?.message ?? entry ?? "");
  const faults = [];
  const hasPath = NAMES_PATH.test(message)
    || ["field", "accepted_locations", "expected_entry", "gate"].some((k) => k in (entry ?? {}));
  const hasProducer = NAMES_PRODUCER.test(message) || "source" in (entry ?? {});
  if (VAGUE.test(message) && !hasPath) faults.push("no destination");
  if (/must record/i.test(message) && !hasProducer) faults.push("no producer");
  if (COMPARISON.test(message) && !BOTH_SIDES.test(message)) faults.push("no both-sides");
  const named = DOTTED_PATH.exec(message)?.[1];
  if (CLAIMS_ABSENT.test(message) && !SAYS_WHAT_IT_SAW.test(message) && named) {
    // The LEAF the message asks for, when it names a path and then a field inside it
    // ("checks.session_state_checkpoint.state must record protocol_version"). Checking only the
    // path called that message a liar while it was telling the plain truth: the state object is
    // there, protocol_version inside it is not.
    const leaf = /\b(?:must record|must include|must expose|requires)\s+([a-z_]+)\b/i.exec(message)?.[1];
    const target = leaf ? `${named}.${leaf}` : named;
    const present = valueAtPath(fixture, target);
    if (present !== undefined && present !== null) faults.push(`says absent, but ${target} holds a ${typeof present}`);
  }
  return faults;
}

function errorsFrom(stdout) {
  const text = String(stdout ?? "").trim();
  if (!text.startsWith("{")) return [];
  let parsed;
  try { parsed = JSON.parse(text); } catch { return []; }
  return (parsed.errors ?? []).map((e) => (typeof e === "object" && e !== null ? e : { message: String(e) }));
}

// Resolved per-OS, the same way baseline.mjs does it — the plugin validators need the project
// venv, not whichever python is first on PATH.
const isWin = process.platform === "win32";
const python = join(extRoot, ".venv", isWin ? "Scripts" : "bin", isWin ? "python.exe" : "python");
if (!existsSync(python)) {
  console.error(`gate-messages: venv python missing at ${python}`);
  process.exit(1);
}
if (!existsSync(skillsDir)) {
  console.error(`gate-messages: skills submodule missing at ${skillsDir}`);
  process.exit(1);
}

const fixtures = readdirSync(fixturesDir)
  .filter((n) => n.endsWith(".json") && !n.endsWith(".compare.json"))
  .sort();

let graded = 0;
const offenders = [];

for (const name of fixtures) {
  const gate = GATES.find((g) => g.match.test(name));
  if (!gate) {
    console.error(`gate-messages: no validator mapped for fixture ${name}`);
    process.exit(1);
  }
  const fixture = join(fixturesDir, name);
  const compare = join(fixturesDir, name.replace(/\.json$/, ".compare.json"));
  let stdout = "";
  try {
    stdout = execFileSync(python, [gate.script, ...gate.args(fixture, existsSync(compare) ? compare : null)], {
      cwd: fixturesDir, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    // A failing gate exits non-zero BY DESIGN — these fixtures are all real failures. The
    // stdout is still the report, so read it rather than treating the exit code as an error.
    stdout = String(err?.stdout ?? "");
    if (!stdout.trim().startsWith("{")) {
      console.error(`gate-messages: ${name} produced no JSON report`);
      console.error(String(err?.stderr ?? err).slice(0, 400));
      process.exit(1);
    }
  }
  const payload = JSON.parse(await readFile(fixture, "utf-8"));
  const errors = errorsFrom(stdout);
  if (errors.length === 0) {
    // The fixture must still FAIL its gate, or it has stopped testing anything.
    console.error(`gate-messages: fixture ${name} no longer fails its gate — it cannot grade messages`);
    process.exit(1);
  }
  for (const entry of errors) {
    graded += 1;
    const faults = faultsIn(entry, payload);
    if (faults.length > 0) {
      offenders.push({ fixture: name, code: entry.code ?? "(uncoded)", faults, message: String(entry.message ?? entry).slice(0, 130) });
    }
  }
}

if (offenders.length > 0) {
  console.error(`\nFAIL: ${offenders.length} of ${graded} gate messages are not actionable\n`);
  for (const o of offenders) {
    console.error(`  [${o.faults.join(", ")}] ${o.code}  (${o.fixture})`);
    console.error(`      ${o.message}`);
  }
  console.error("\nEach message must name the destination field, the command that produces the");
  console.error("value, and both sides of any comparison. See the fixtures' own history: every");
  console.error("one of these cost a full hardware run to diagnose.\n");
  process.exit(1);
}

console.log(`gate messages actionable: ${graded} graded across ${fixtures.length} fixtures`);
