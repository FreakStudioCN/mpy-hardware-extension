import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const devUp = resolve("..", "mpyhw-api", "scripts", "dev-up.ps1");
const daemon = resolve("..", "mpyhw-api", "scripts", "api-daemon.ps1");

test("dev-up script validates env + database, then delegates API startup to the daemon", () => {
  const body = readFileSync(devUp, "utf-8");

  assert.match(body, /param\s*\(/);
  assert.match(body, /\$EnvFile/);
  assert.match(body, /\$PlanOnly/);
  assert.match(body, /DATABASE_URL is required/);
  assert.match(body, /DEEPSEEK_API_KEY/);
  assert.match(body, /docker info/);
  assert.match(body, /postgres:16/);
  // The API is no longer a foreground uvicorn child: dev-up brings up Postgres then hands
  // off to the detached daemon so the backend survives VS Code closing.
  assert.match(body, /api-daemon\.ps1/);
  assert.match(body, /&\s*\$daemon\s+start/);
  assert.doesNotMatch(body, /python -m uvicorn/);
});

test("api-daemon script runs uvicorn detached on 8787, manages lifecycle, and forwards stub mode", () => {
  const body = readFileSync(daemon, "utf-8");

  // Lifecycle actions the README + dev-up skill drive.
  assert.match(body, /ValidateSet\('start','stop','restart','status','logs','worker'\)/);
  // Detached launch via WMI so the child is not parented to VS Code.
  assert.match(body, /Win32_Process/);
  assert.match(body, /uvicorn/);
  assert.match(body, /app\.main:app/);
  assert.match(body, /\$port = 8787/);
  assert.match(body, /RedirectStandardError \$log/);
  // Stub mode is forwarded into the detached process (which does not inherit shell env).
  assert.match(body, /\[switch\]\$Stub/);
  assert.match(body, /MPYHW_LLM_STUB/);
});
