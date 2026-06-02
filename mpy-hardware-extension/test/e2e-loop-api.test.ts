import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { createAgentBackedLoop } from "../src/core/agent-backed-loop.ts";

// Apex end-to-end: the REAL agent loop talks to a REAL spawned uvicorn process over
// real HTTP + SSE. Only the LLM upstream is stubbed (MPYHW_LLM_STUB=1). Unlike the
// both-ends-faked unit loop test, this exercises the genuine wiring that nothing else
// covers together: JWT auth decode, the credit pre-flight + daily grant, the server's
// _sse() framing, the client SSE parser, and the loop consuming it to a terminal state.
const here = dirname(fileURLToPath(import.meta.url));
const apiDir = join(here, "..", "..", "mpyhw-api");

function resolvePython(): string | null {
  for (const candidate of ["python", "python3"]) {
    try {
      if (spawnSync(candidate, ["--version"], { stdio: "ignore" }).status === 0) return candidate;
    } catch { /* try next */ }
  }
  return null;
}

const python = resolvePython();
function canImport(mod: string): boolean {
  return !!python && spawnSync(python, ["-c", `import ${mod}`], { cwd: apiDir, stdio: "ignore" }).status === 0;
}

// Skip locally when the API toolchain isn't present; in CI this must run (set
// MPYHW_REQUIRE_CONTRACT_TESTS=1) so a missing dependency can't hide the gap.
const ready = !!python && canImport("uvicorn") && canImport("app.main");
const skipReason = ready ? false : (process.env.MPYHW_REQUIRE_CONTRACT_TESTS ? false : "python/uvicorn/app.main not available");

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

async function waitForHealth(base: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/v1/health`);
      if (res.ok) return;
    } catch { /* server not up yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("spawned API never became healthy");
}

test("real agent loop drives a real spawned API over HTTP+SSE (auth + credits + stream)", { skip: skipReason, timeout: 40000 }, async () => {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const dbPath = join(mkdtempSync(join(tmpdir(), "mpyhw-e2e-")), "credits.db");
  const env = { ...process.env, MPYHW_LLM_STUB: "1", MPYHW_JWT_SECRET: "test-secret", MPYHW_CREDIT_DB: dbPath };

  const server = spawn(python!, ["-m", "uvicorn", "app.main:app", "--port", String(port), "--log-level", "warning"], { cwd: apiDir, env });
  const serverErr: string[] = [];
  server.stderr.on("data", (d: Buffer) => serverErr.push(d.toString()));

  try {
    try {
      await waitForHealth(base, 25000);
    } catch (e) {
      throw new Error(`${(e as Error).message}; server stderr: ${serverErr.join("")}`);
    }

    // Mint a session JWT with the SAME secret via the production mint_session.
    const minted = spawnSync(
      python!,
      ["-c", "from app.auth import mint_session; print(mint_session({'id':'e2e','login':'e2e','email':None}))"],
      { cwd: apiDir, env, encoding: "utf-8" },
    );
    const token = minted.stdout.trim();
    assert.ok(token, `failed to mint token: ${minted.stderr}`);

    const events: any[] = [];
    const loop = createAgentBackedLoop({ apiBaseUrl: base, getAuthToken: async () => token });
    const result = await loop({
      intent: "blink an LED when it gets hot",
      boardId: "esp32-s3-devkitc-1",
      onEvent: (e) => events.push(e),
    });

    // Stub turn is text-only (no tool calls) -> the loop hands control back to the user.
    assert.equal(result.terminal, "awaiting_user");

    // The credits event made the full round-trip: server meter -> _sse -> client parse
    // -> loop -> UI. A fresh user on a throwaway DB gets the full daily grant.
    const credits = events.find((e) => e.kind === "credits");
    assert.ok(credits, "expected a credits event forwarded from the real API");
    assert.ok(credits.dailyGrant > 0, "daily grant should be positive");
    assert.equal(credits.balance, credits.dailyGrant, "fresh user gets the full grant (stub debits 0)");
  } finally {
    server.kill();
  }
});
