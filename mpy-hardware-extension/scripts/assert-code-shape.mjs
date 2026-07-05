// assert-code-shape.mjs — verifies a produced MicroPython project (the output of a
// golden-path run through analyze -> ... -> upy-generate-plugin) matches the expected
// generate-phase code shape. Exits non-zero and prints a reason list on any failure.
//
// Usage: node scripts/assert-code-shape.mjs --project-dir <dir>
//
// Five checks (each PASS/FAIL, all must pass):
//   1. tree            — firmware/main.py, firmware/conf.py, generate_plan.json exist;
//                         firmware/tools/ absent.
//                         (The task brief says "firmware/conf/"; the real generate-phase
//                         contract — see check_conf_contract.py — is a FILE firmware/conf.py,
//                         not a directory. Asserting the real shape, not the shorthand.)
//   2. scheduler API   — firmware/**/*.py must never call `.register(` (the retired/legacy
//                         scheduler API — see esp32_timer_scheduler_api.pitfall.json). When
//                         the project is in "timer" scheduler mode (generate_plan.json
//                         scheduler_mode === "timer", or firmware/lib/scheduler/timer_sched.py
//                         is present), firmware/**/*.py must also call `add_task(` somewhere.
//                         Async/thread-mode projects don't use this scheduler API at all
//                         (they use asyncio.create_task/_thread), so add_task( is not
//                         required for them — only the register( ban is universal.
//   3. imports         — check_mpy_imports.py via the ~/.mpyhw/venv python; require ok:true.
//   4. gates           — run_quality_gates.py --project-dir <dir>; require JSON
//                         ok === true && structured_errors.length === 0. The gate COUNT is
//                         never hardcoded — only `ok` is asserted, so upstream can add/remove
//                         checks without this script going stale.
//   5. manifest        — every path/mock_path/adapter_path/files[] entry found anywhere in
//                         generate_plan.json must exist on disk under the project dir.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function argValue(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const projectDirArg = argValue("--project-dir");
if (!projectDirArg) {
  console.error("usage: assert-code-shape.mjs --project-dir <dir>");
  process.exit(2);
}
const projectDir = resolve(process.cwd(), projectDirArg);

const GEN_SCRIPTS = fileURLToPath(
  new URL("../../third_party/MicroPython_Skills/upy-generate-plugin/scripts/", import.meta.url),
);
const venvPython = join(
  homedir(),
  ".mpyhw",
  "venv",
  process.platform === "win32" ? "Scripts" : "bin",
  process.platform === "win32" ? "python.exe" : "python",
);

async function walkPyFiles(dir) {
  const out = [];
  const walk = async (d) => {
    let entries;
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join(d, e.name);
      if (e.isDirectory()) await walk(full);
      else if (e.name.endsWith(".py")) out.push(full);
    }
  };
  await walk(dir);
  return out;
}

function runPython(scriptPath, args) {
  try {
    const stdout = execFileSync(venvPython, [scriptPath, ...args], { encoding: "utf-8" });
    return { code: 0, stdout };
  } catch (error) {
    return { code: error.status ?? 1, stdout: error.stdout?.toString?.() ?? "" };
  }
}

function parseJsonStdout(stdout, label) {
  try {
    return JSON.parse(stdout);
  } catch {
    throw new Error(`${label}: could not parse JSON output:\n${stdout.slice(0, 2000)}`);
  }
}

// --- Check 1: tree ---
async function checkTree() {
  const reasons = [];
  const required = [
    ["firmware/main.py", "file"],
    ["firmware/conf.py", "file"],
    ["generate_plan.json", "file"],
  ];
  for (const [rel, kind] of required) {
    const full = join(projectDir, rel);
    if (!existsSync(full)) reasons.push(`missing required ${kind}: ${rel}`);
  }
  if (existsSync(join(projectDir, "firmware", "tools"))) {
    reasons.push("firmware/tools/ must be absent (generate's cleanup step did not run, or did not remove it)");
  }
  return { name: "tree", ok: reasons.length === 0, reasons };
}

// --- Check 2: scheduler API ---
async function checkSchedulerApi() {
  const reasons = [];
  const firmwareDir = join(projectDir, "firmware");
  const pyFiles = await walkPyFiles(firmwareDir);
  let hasRegisterCall = false;
  let hasAddTask = false;
  const registerHits = [];
  for (const file of pyFiles) {
    const content = await readFile(file, "utf-8").catch(() => "");
    if (/\.register\(/.test(content)) {
      hasRegisterCall = true;
      registerHits.push(relative(projectDir, file));
    }
    if (/\badd_task\(/.test(content)) hasAddTask = true;
  }
  if (hasRegisterCall) {
    reasons.push(`legacy/retired scheduler API '.register(' found in: ${registerHits.join(", ")} (scaffold scheduler only implements add_task(); see esp32_timer_scheduler_api.pitfall.json)`);
  }
  let planScheduleMode;
  try {
    const plan = JSON.parse(await readFile(join(projectDir, "generate_plan.json"), "utf-8"));
    planScheduleMode = plan.scheduler_mode;
  } catch {
    // generate_plan.json missing/invalid is reported by checkTree/checkManifest.
  }
  const timerSchedPresent = existsSync(join(firmwareDir, "lib", "scheduler", "timer_sched.py"));
  const isTimerMode = planScheduleMode === "timer" || timerSchedPresent;
  if (isTimerMode && !hasAddTask) {
    reasons.push("timer scheduler mode but no firmware/**/*.py calls add_task( — main.py and timer_sched.py have drifted apart");
  }
  return { name: "scheduler API", ok: reasons.length === 0, reasons };
}

// --- Check 3: imports ---
function checkMpyImports() {
  const { stdout } = runPython(join(GEN_SCRIPTS, "check_mpy_imports.py"), ["--project-dir", projectDir]);
  let payload;
  try {
    payload = parseJsonStdout(stdout, "check_mpy_imports.py");
  } catch (error) {
    return { name: "imports", ok: false, reasons: [error.message] };
  }
  if (payload.ok === true) return { name: "imports", ok: true, reasons: [] };
  const reasons = (payload.errors ?? []).map((e) => `${e.code ?? "IMPORT_ERROR"}: ${e.message ?? JSON.stringify(e)}`);
  return { name: "imports", ok: false, reasons: reasons.length ? reasons : ["check_mpy_imports.py reported ok:false"] };
}

// --- Check 4: gates ---
function checkQualityGates() {
  const { stdout } = runPython(join(GEN_SCRIPTS, "run_quality_gates.py"), ["--project-dir", projectDir]);
  let payload;
  try {
    payload = parseJsonStdout(stdout, "run_quality_gates.py");
  } catch (error) {
    return { name: "gates", ok: false, reasons: [error.message] };
  }
  // Never assert a hardcoded gate count — only ok === true && no structured errors, so
  // upstream can add/remove individual gates without this script going stale.
  const structuredErrors = payload.structured_errors ?? [];
  const ok = payload.ok === true && structuredErrors.length === 0;
  const reasons = structuredErrors.map((e) => `${e.code}: ${e.message}${e.phase_step ? ` (gate: ${e.phase_step})` : ""}`);
  return { name: "gates", ok, reasons: ok ? [] : (reasons.length ? reasons : [`run_quality_gates.py reported ok:${payload.ok}`]) };
}

// --- Check 5: manifest ---
function collectPlannedPaths(node, out) {
  if (Array.isArray(node)) {
    for (const item of node) collectPlannedPaths(item, out);
    return;
  }
  if (node && typeof node === "object") {
    for (const [key, value] of Object.entries(node)) {
      if ((key === "path" || key === "mock_path" || key === "adapter_path") && typeof value === "string") {
        out.push(value);
      } else if (key === "files" && Array.isArray(value)) {
        for (const v of value) if (typeof v === "string") out.push(v);
      } else {
        collectPlannedPaths(value, out);
      }
    }
  }
}

async function checkManifest() {
  const planPath = join(projectDir, "generate_plan.json");
  if (!existsSync(planPath)) {
    return { name: "manifest", ok: false, reasons: ["generate_plan.json missing — cannot check manifest paths"] };
  }
  let plan;
  try {
    plan = JSON.parse(await readFile(planPath, "utf-8"));
  } catch (error) {
    return { name: "manifest", ok: false, reasons: [`generate_plan.json is not valid JSON: ${error.message}`] };
  }
  const paths = [];
  collectPlannedPaths(plan, paths);
  const reasons = [];
  const seen = new Set();
  for (const p of paths) {
    if (seen.has(p)) continue;
    seen.add(p);
    if (p.includes("..") || /^[a-zA-Z]:/.test(p) || p.startsWith("/") || p.startsWith("\\")) {
      reasons.push(`manifest path escapes project dir: ${p}`);
      continue;
    }
    if (!existsSync(join(projectDir, p))) reasons.push(`manifest declares ${p} but it does not exist on disk`);
  }
  return { name: "manifest", ok: reasons.length === 0, reasons };
}

async function main() {
  if (!existsSync(projectDir)) {
    console.error(`project dir does not exist: ${projectDir}`);
    process.exit(2);
  }
  if (!existsSync(venvPython)) {
    console.error(`venv python not found at ${venvPython} — bootstrap it first (run e2e:v0 once, or see HANDOFF).`);
    process.exit(2);
  }

  const checks = [
    await checkTree(),
    await checkSchedulerApi(),
    checkMpyImports(),
    checkQualityGates(),
    await checkManifest(),
  ];

  console.log(`\n=== assert-code-shape: ${projectDir} ===`);
  for (const check of checks) {
    console.log(`[${check.ok ? "PASS" : "FAIL"}] ${check.name}`);
    for (const reason of check.reasons) console.log(`    - ${reason}`);
  }

  const allOk = checks.every((c) => c.ok);
  const failed = checks.filter((c) => !c.ok).map((c) => c.name);
  console.log(`\nCODE-SHAPE: ${allOk ? "PASS" : "FAIL"}${allOk ? "" : ` (failed: ${failed.join(", ")})`}`);
  // Machine-readable line for callers (golden-path-matrix.mjs) to parse without re-running.
  console.log(`CODE-SHAPE-JSON: ${JSON.stringify({ ok: allOk, checks })}`);
  process.exit(allOk ? 0 : 1);
}

main();
