// golden-path-matrix.mjs — the A6 self-verification harness for the plugin's golden path.
// Loops IDEAS x RUNS: for each cell, runs the real shipped path (idea -> real backend ->
// real DeepSeek -> createProtocolLoop -> real device-shim/serve.py -> generate) via the
// e2e:v0 CLI, then asserts the produced project's code shape via assert-code-shape.mjs.
// Prints a pass/fail matrix and exits non-zero if any cell failed.
//
// Costs real DeepSeek turns per cell (IDEAS.length * RUNS turns-worth of billable calls).
// NEVER parallelize matrix cells — the backend 429s under concurrent walkthroughs. Cells
// run strictly sequentially, one full e2e:v0 (which can take minutes) at a time.
//
// Usage:
//   MPYHW_DEV_JWT=<jwt> npm run golden-matrix            # full IDEAS x 5
//   MPYHW_DEV_JWT=<jwt> MATRIX_RUNS=1 npm run golden-matrix   # IDEAS x 1 smoke sweep
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const IDEAS = [
  "a temperature logger that prints readings every 5 seconds", // sensor
  "a scrolling text banner on an SSD1306 OLED", // display
  "a servo that sweeps back and forth continuously", // actuator
];
const RUNS = Number(process.env.MATRIX_RUNS ?? 5);

const extRoot = fileURLToPath(new URL("../", import.meta.url));
const jwt = process.env.MPYHW_DEV_JWT;
if (!jwt) {
  console.error("MPYHW_DEV_JWT not set — mint one first, e.g.:");
  console.error(`  cd mpyhw-api && python -c "from app.auth import mint_session; print(mint_session({'id':'e2e','login':'e2e','email':None}))"`);
  process.exit(2);
}

const logDir = join(extRoot, "tmp", "golden-matrix");
mkdirSync(logDir, { recursive: true });

function slug(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 40);
}

// Direct node invocation (not `npm run e2e:v0`) — npm.cmd on Windows can mangle argv
// quoting; spawning node directly against the CLI entrypoint is what the e2e SKILL
// recommends and sidesteps that entirely. Effect is identical to `npm run e2e:v0 -- "<idea>"`.
function runE2e(idea, logPath) {
  const result = spawnSync(
    process.execPath,
    ["--no-warnings", "--experimental-strip-types", "src/cli/e2e-protocol-v0.ts", idea],
    { cwd: extRoot, env: process.env, encoding: "utf-8" },
  );
  const combined = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  writeFileSync(logPath, combined, "utf-8");
  const match = combined.match(/^project:\s*(.+)$/m);
  const projectDir = match ? match[1].trim() : join(extRoot, "tmp", "e2e-v0");
  const passed = /E2E-V0-FULLSTACK:\s+PASS/.test(combined) && result.status === 0;
  return { passed, projectDir, exitCode: result.status };
}

function runCodeShape(projectDir, logPath) {
  const result = spawnSync(
    process.execPath,
    ["scripts/assert-code-shape.mjs", "--project-dir", projectDir],
    { cwd: extRoot, encoding: "utf-8" },
  );
  const combined = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  writeFileSync(logPath, combined, "utf-8");
  const failed = [];
  const failMatch = combined.match(/CODE-SHAPE:\s+FAIL\s+\(failed:\s*(.+)\)/);
  if (failMatch) failed.push(...failMatch[1].split(",").map((s) => s.trim()));
  return { passed: result.status === 0, failed };
}

const results = [];
let cellIndex = 0;
const totalCells = IDEAS.length * RUNS;

for (const idea of IDEAS) {
  for (let run = 1; run <= RUNS; run++) {
    cellIndex += 1;
    const tag = `${slug(idea)}-run${run}`;
    console.log(`\n########## [${cellIndex}/${totalCells}] ${idea}  (run ${run}/${RUNS}) ##########`);
    const start = Date.now();

    const e2eLog = join(logDir, `${tag}.e2e.log`);
    const e2e = runE2e(idea, e2eLog);
    console.log(`  e2e:v0 -> ${e2e.passed ? "PASS" : "FAIL"} (project: ${e2e.projectDir})`);

    let shape = { passed: false, failed: ["e2e:v0 did not PASS"] };
    if (e2e.passed) {
      const shapeLog = join(logDir, `${tag}.code-shape.log`);
      shape = runCodeShape(e2e.projectDir, shapeLog);
      console.log(`  code-shape -> ${shape.passed ? "PASS" : `FAIL (${shape.failed.join(", ")})`}`);
    }

    const durationMs = Date.now() - start;
    results.push({
      idea,
      run,
      e2ePass: e2e.passed,
      shapePass: shape.passed,
      pass: e2e.passed && shape.passed,
      reasons: shape.failed,
      durationMs,
    });
    console.log(`  duration: ${(durationMs / 1000).toFixed(1)}s`);
  }
}

// --- matrix table ---
console.log("\n\n=== GOLDEN PATH MATRIX ===");
const header = `${"idea".padEnd(45)} ${"run".padEnd(5)} ${"e2e".padEnd(6)} ${"shape".padEnd(6)} ${"secs".padEnd(7)} result`;
console.log(header);
console.log("-".repeat(header.length));
for (const r of results) {
  console.log(
    `${r.idea.slice(0, 44).padEnd(45)} ${String(r.run).padEnd(5)} ${(r.e2ePass ? "PASS" : "FAIL").padEnd(6)} ${(r.shapePass ? "PASS" : "FAIL").padEnd(6)} ${(r.durationMs / 1000).toFixed(1).padEnd(7)} ${r.pass ? "PASS" : `FAIL (${r.reasons.join("; ")})`}`,
  );
}
const passCount = results.filter((r) => r.pass).length;
console.log(`\n${passCount}/${results.length} cells passed.`);

const anyFail = results.some((r) => !r.pass);
console.log(`\nGOLDEN-MATRIX: ${anyFail ? "FAIL" : "PASS"}`);
process.exit(anyFail ? 1 : 0);
