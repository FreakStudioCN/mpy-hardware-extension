import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import net from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { createLlmClient } from "../src/core/llm-client.ts";
import { databaseName, isTestScopedDatabase, TEST_DATABASE_HINT } from "./test-database.ts";
import { resolvePython } from "./venv-python.ts";

// Apex end-to-end: the REAL production LLM client (createLlmClient -> streamSseEvents)
// talks to a REAL spawned uvicorn process over real HTTP + SSE. Only the LLM upstream is
// stubbed (MPYHW_LLM_STUB=1). Unlike the both-ends-faked protocol-loop unit test, this
// exercises the genuine wiring that nothing else covers together: JWT auth decode, the
// credit pre-flight + daily grant, the server's _sse() framing, and the client SSE parser.
// It drives the client directly (not a build loop) so it asserts the transport contract
// itself, independent of which loop happens to consume it.
const here = dirname(fileURLToPath(import.meta.url));
const apiDir = join(here, "..", "..", "mpyhw-api");

// mpyhw-api's OWN venv, not the extension's: uvicorn and app.main are installed there, and this
// test spawns the real API. Falls back to PATH, and null skips the suite.
const python = resolvePython(apiDir);
function canImport(mod: string): boolean {
  return !!python && spawnSync(python, ["-c", `import ${mod}`], { cwd: apiDir, stdio: "ignore" }).status === 0;
}

// Skip locally when the API toolchain or a test Postgres isn't present; in CI this
// must run (set MPYHW_REQUIRE_CONTRACT_TESTS=1) so a missing dependency can't hide the
// gap. The spawned API requires a Postgres DATABASE_URL — there is no SQLite fallback.
//
// The TEST-specific variable wins. This suite writes real rows -- a user, a session, a daily
// credit grant -- and cleans none of them up, so which database it is handed matters. Preferring
// the generic DATABASE_URL meant an ambient one, which on a dev machine points at the dev
// database, beat the variable that exists precisely to say "use this one instead".
const dbUrl = process.env.MPYHW_TEST_DATABASE_URL || process.env.DATABASE_URL;
const dbName = databaseName(dbUrl);
const dbIsTestScoped = isTestScopedDatabase(dbName);
// MPYHW_REQUIRE_CONTRACT_TESTS means "a missing dependency must not hide the gap", so it turns a
// skip into a run. It does NOT mean "write anywhere": the name check is outside it, because the
// same flag also forces sse-contract and shim-roundtrip, so a developer can plausibly export it
// for one of those in a shell that happens to carry a dev DATABASE_URL. That is the accident this
// guard exists to prevent, and letting the flag waive it would reopen it silently. With the flag
// set and a wrong database, the suite RUNS and fails loudly on the assertion below rather than
// skipping quietly or writing. CI sets the flag with an mpyhw_test URL, so it is unaffected.
const insist = !!process.env.MPYHW_REQUIRE_CONTRACT_TESTS;
const ready = !!python && !!dbUrl && dbIsTestScoped && canImport("uvicorn") && canImport("app.main");
const skipReason = ready || insist
  ? false
  : (dbUrl && !dbIsTestScoped
    ? `refusing to write to ${dbName ?? "a DATABASE_URL with no readable database name"}: ${TEST_DATABASE_HINT}`
    : "python/uvicorn/app.main/DATABASE_URL not available");

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

test("real production LLM client streams a real spawned API over HTTP+SSE (auth + credits + framing)", { skip: skipReason, timeout: 40000 }, async () => {
  // Reached only when MPYHW_REQUIRE_CONTRACT_TESTS forced the run: without it a wrong database
  // has already skipped. Failing here is the point -- the flag says a missing prerequisite must
  // be loud, and the wrong database is a prerequisite like any other.
  assert.ok(
    dbUrl,
    `MPYHW_REQUIRE_CONTRACT_TESTS is set but no database URL is: ${TEST_DATABASE_HINT}`,
  );
  assert.ok(
    dbIsTestScoped,
    `refusing to write to ${dbName ?? "a DATABASE_URL whose database name cannot be read"}: ${TEST_DATABASE_HINT}`,
  );
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  // Stub only the LLM upstream; auth, credits, and sessions hit the real Postgres the
  // spawned API connects to via DATABASE_URL (MPYHW_TEST_DATABASE_URL first, then DATABASE_URL).
  const env = { ...process.env, MPYHW_LLM_STUB: "1", MPYHW_JWT_SECRET: "test-secret", ...(dbUrl ? { DATABASE_URL: dbUrl } : {}) };

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

    // Drive the production SSE client directly against the spawned API. tools:[] passes
    // the whitelist gate (the server offers the 6 protocol tools regardless); the stubbed
    // upstream replies text-only + a credits frame + message_stop.
    const client = createLlmClient({ apiBaseUrl: base, fetchImpl: fetch, getAuthToken: async () => token });
    const events: any[] = [];
    for await (const event of await client.streamMessages({
      messages: [{ role: "user", content: "blink an LED when it gets hot" }],
      boardId: "esp32-s3-devkitc-1",
      tools: [],
    })) {
      events.push(event);
    }

    // Auth + framing: the stub text streamed through and the stream closed cleanly.
    const text = events.filter((e) => e.type === "text_delta").map((e) => e.text).join("");
    assert.ok(text.length > 0, "stub text streamed through the real SSE transport");
    assert.ok(events.some((e) => e.type === "message_stop"), "stream terminates with message_stop");
    assert.ok(!events.some((e) => e.type === "stream_error"), "no error frame on a clean stream");

    // The credits event made the full round-trip: server meter -> _sse -> client parse.
    // A fresh user on a throwaway DB gets the full daily grant (the stub debits 0).
    const credits = events.find((e) => e.type === "credits");
    assert.ok(credits, "expected a credits event forwarded from the real API");
    assert.ok(credits.dailyGrant > 0, "daily grant should be positive");
    assert.equal(credits.remaining, credits.dailyGrant, "fresh user gets the full grant (stub debits 0)");
  } finally {
    server.kill();
  }
});
