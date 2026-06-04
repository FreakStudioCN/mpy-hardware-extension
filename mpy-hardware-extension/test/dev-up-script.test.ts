import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const script = resolve("..", "mpyhw-api", "scripts", "dev-up.ps1");

test("dev-up script validates env, database, Docker, and API startup", () => {
  const body = readFileSync(script, "utf-8");

  assert.match(body, /param\s*\(/);
  assert.match(body, /\$EnvFile/);
  assert.match(body, /\$PlanOnly/);
  assert.match(body, /DATABASE_URL is required/);
  assert.match(body, /DEEPSEEK_API_KEY/);
  assert.match(body, /docker info/);
  assert.match(body, /postgres:16/);
  assert.match(body, /\$ApiHost = "127\.0\.0\.1"/);
  assert.match(body, /\$ApiPort = 8787/);
  assert.match(body, /python -m uvicorn app\.main:app --host \$ApiHost --port \$ApiPort/);
});
