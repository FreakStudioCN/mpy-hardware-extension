import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

import { withVenvOnPath } from "./venv-path.mjs";

// One-command baseline: build, typecheck, TS tests, Python shim tests, and every
// plugin smoke suite, each as a captured subprocess with its own timeout. It only
// wraps the existing test commands, it does not replace any test logic.
//
// stdin is ignored for every step so a child that reads stdin (the plugin smoke
// harness does) gets EOF instead of blocking on the terminal. Cross-platform:
// the venv python path is resolved per-OS and npm is run through the shell only
// on Windows.

const isWin = process.platform === "win32";
const venvBin = resolve(".venv", isWin ? "Scripts" : "bin");
const venvPython = join(venvBin, isWin ? "python.exe" : "python");
const skillsDir = resolve("..", "third_party", "MicroPython_Skills");

const STEP_TIMEOUT_MS = 300_000; // build / typecheck / TS tests / shim pytest
const SMOKE_TIMEOUT_MS = 120_000; // per plugin smoke suite
const OUTPUT_TAIL_LINES = 25;

function version(cmd, args, useShell) {
  const r = spawnSync(cmd, args, { encoding: "utf-8", shell: useShell });
  if (r.error || r.status !== 0) return "not found";
  return (r.stdout || r.stderr || "").trim().split("\n")[0] || "not found";
}

function printEnv() {
  console.log("baseline environment:");
  console.log(`  node     ${process.version}`);
  console.log(`  npm      ${version("npm", ["--version"], isWin)}`);
  console.log(`  platform ${process.platform} ${process.arch}`);
  if (existsSync(venvPython)) {
    console.log(`  python   ${version(venvPython, ["--version"], false)}`);
    const mp = version(venvPython, ["-c", "import importlib.metadata as m; print(m.version('mpremote'))"], false);
    console.log(`  mpremote ${mp}`);
  } else {
    console.log(`  venv     MISSING at ${venvPython} (python steps will fail)`);
  }
  console.log("");
}

function tail(label, text) {
  if (!text || !text.trim()) return `  ${label}: (empty)`;
  const lines = text.trimEnd().split("\n").slice(-OUTPUT_TAIL_LINES);
  return `  ${label}:\n    ${lines.join("\n    ")}`;
}

const failures = [];

function runStep(name, cmd, args, opts) {
  const cwd = opts.cwd ?? process.cwd();
  const timeout = opts.timeout ?? STEP_TIMEOUT_MS;
  const start = Date.now();
  const r = spawnSync(cmd, args, {
    cwd,
    shell: opts.shell ?? false,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf-8",
    env: opts.env ?? process.env,
    timeout,
  });
  const seconds = ((Date.now() - start) / 1000).toFixed(1);
  const timedOut = r.error?.code === "ETIMEDOUT";
  if (!timedOut && r.status === 0) {
    console.log(`PASS ${name} (${seconds}s)`);
    return;
  }
  failures.push(name);
  console.error(`\nFAIL ${name}`);
  console.error(`  command:  ${[cmd, ...args].join(" ")}`);
  console.error(`  cwd:      ${cwd}`);
  console.error(`  duration: ${seconds}s`);
  console.error(`  exit:     ${timedOut ? `timed out after ${timeout} ms` : r.status}`);
  console.error(tail("stdout", r.stdout));
  console.error(tail("stderr", r.stderr));
  console.error("");
}

function discoverPluginSmoke() {
  if (!existsSync(skillsDir)) {
    failures.push("smoke (skills submodule missing)");
    console.error(`\nFAIL smoke: skills submodule not found at ${skillsDir}\n  run: git submodule update --init --recursive\n`);
    return [];
  }
  return readdirSync(skillsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && /^upy-.*-plugin$/.test(e.name))
    .map((e) => e.name)
    .filter((name) => existsSync(join(skillsDir, name, "test", "smoke_tests.py")))
    .sort();
}

printEnv();

runStep("build", "npm", ["run", "build"], { shell: isWin });
runStep("typecheck", "npm", ["run", "typecheck"], { shell: isWin });
// Run the TS tests with the venv bin first on PATH so the shim roundtrip's bare `python`
// resolves to the project venv, not a system python earlier on PATH (Windows: 3.9 vs 3.12).
const testEnv = existsSync(venvBin) ? withVenvOnPath(process.env, venvBin) : process.env;
runStep("test", "npm", ["test"], { shell: isWin, env: testEnv });

if (existsSync(venvPython)) {
  runStep("shim pytest", venvPython, ["-m", "pytest", "python/shim", "-q"], {});
  // Replays saved payloads from real phase stalls through the real validators and fails if any
  // gate error stops being actionable. Five stalls, each costing an hour-long hardware run,
  // were all one defect: a message stating a condition without naming where to act. Four
  // seconds here is the cheapest place to catch the sixth.
  // The absence of the assets means two different things and they cannot share an outcome. The
  // runner is also executed against synthetic fixtures that carry no scripts/ or test/ tree, and
  // a step cannot demand files the caller never claimed to have -- but in a REAL checkout a
  // missing gate script is a deleted gate script, and skipping it green unwires the very
  // regression check this step exists to be. An earlier version announced the skip and claimed
  // that was enough; it is not, because nothing reads the announcement. Nothing else runs this
  // check either: CI runs npm test and npm run test:v0, never baseline.
  //
  // `scripts/baseline.mjs` tells the two apart. It is always present in a real checkout, because
  // `npm run baseline` IS `node scripts/baseline.mjs`, and never present in the synthetic fixture,
  // which writes only a package.json. So the fixture still skips and the repo now fails, which is
  // how the venv and skills-submodule guards below and above already behave.
  const gateScript = resolve("scripts", "assert-gate-messages.mjs");
  const gateFixtures = resolve("test", "fixtures", "gate-messages");
  if (existsSync(gateScript) && existsSync(gateFixtures)) {
    runStep("gate messages", "node", ["scripts/assert-gate-messages.mjs"], { shell: isWin });
  } else if (existsSync(resolve("scripts", "baseline.mjs"))) {
    console.log("FAIL gate messages (assets missing from a real checkout — deleted or renamed?)");
    failures.push("gate messages (assets missing)");
  } else {
    console.log("SKIP gate messages (no scripts/assert-gate-messages.mjs + test/fixtures/gate-messages here)");
  }
  for (const plugin of discoverPluginSmoke()) {
    runStep(`smoke:${plugin}`, venvPython, ["test/smoke_tests.py"], {
      cwd: join(skillsDir, plugin),
      timeout: SMOKE_TIMEOUT_MS,
    });
  }
} else {
  failures.push("python steps (venv missing)");
}

console.log("");
if (failures.length) {
  console.error(`BASELINE FAILED: ${failures.join(", ")}`);
  process.exit(1);
}
console.log("BASELINE PASSED");
process.exit(0);
