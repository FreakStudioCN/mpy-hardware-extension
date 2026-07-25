import assert from "node:assert/strict";
import test from "node:test";

import {
  CREDIT_OPERATIONS,
  buildCreditUsage,
  deriveCreditOperation,
  formatCreditUsage,
} from "../src/core/credit-usage.ts";
import { PHASE_ALIASES } from "../src/core/protocol-loop.ts";

test("builder keeps the counts, flags and tokens that make up a record", () => {
  const record = buildCreditUsage({
    session_id: "session-abc-1",
    anon_id: "machine-42",
    phase: "upy-generate-plugin",
    operation: "generate",
    device_count: 3,
    bom_count: 7,
    generated_file_count: 4,
    code_line_count: 210,
    wiring: true,
    diagram: false,
    cold_driver: true,
    retry_count: 2,
    duration_ms: 1500,
    error_code: "DRIVER_STATUS_UNSUPPORTED",
    remaining_quota: 46,
    credits_consumed: 2,
    charged: 3,
    model: "deepseek-v4-pro",
    input_tokens: 900,
    output_tokens: 120,
    cache_hit_tokens: 800,
  });

  assert.deepEqual(record, {
    session_id: "session-abc-1",
    anon_id: "machine-42",
    phase: "upy-generate-plugin",
    operation: "generate",
    device_count: 3,
    bom_count: 7,
    generated_file_count: 4,
    code_line_count: 210,
    wiring: true,
    diagram: false,
    cold_driver: true,
    retry_count: 2,
    duration_ms: 1500,
    error_code: "DRIVER_STATUS_UNSUPPORTED",
    remaining_quota: 46,
    credits_consumed: 2,
    charged: 3,
    model: "deepseek-v4-pro",
    input_tokens: 900,
    output_tokens: 120,
    cache_hit_tokens: 800,
  });
});

test("prompts, source code and paths cannot enter the record", () => {
  // BY CONSTRUCTION: the output is assembled key-by-key, so an unknown key has no way in,
  // and a declared string field only accepts a bare token — a path/sentence/code fragment
  // fails the whole-string match and is dropped rather than partially scrubbed.
  const record: Record<string, any> = buildCreditUsage({
    operation: "generate",
    // unknown keys — must not survive at all
    intent: "light a red LED when the temperature goes above 30C",
    prompt: "you are a hardware assistant",
    code: "import machine\nled = machine.Pin(2)",
    lines: ["Traceback (most recent call last):"],
    path: "/Users/erson/projects/main.py",
    // declared keys carrying non-token values — must be dropped, not truncated in
    phase: "/Users/erson/projects/main.py",
    error_code: "device timed out reading /dev/ttyUSB0",
    model: "C:\\Users\\erson\\models\\local.gguf",
    session_id: "session id with spaces",
  });

  assert.deepEqual(Object.keys(record), ["operation"], "only the enum survived");
  for (const key of ["intent", "prompt", "code", "lines", "path", "phase", "error_code", "model", "session_id"]) {
    assert.equal(key in record, false, `${key} must not be present`);
  }
  // Nothing anywhere in the serialized record can carry the secret text.
  const serialized = JSON.stringify(record);
  for (const secret of ["temperature", "machine.Pin", "Traceback", "/Users/erson", "ttyUSB0", "C:\\"]) {
    assert.equal(serialized.includes(secret), false, `${secret} leaked into the record`);
  }
});

test("counts are clamped to non-negative integers and bad numbers are dropped", () => {
  // A refund makes the balance delta negative; a record must never report negative
  // consumption, and a NaN/Infinity from a malformed server field must not become a count.
  const record: Record<string, any> = buildCreditUsage({
    operation: "llm_call",
    credits_consumed: -4,
    device_count: 2.7,
    input_tokens: Number.NaN,
    output_tokens: Number.POSITIVE_INFINITY,
    cache_hit_tokens: "800",
  });

  assert.equal(record.credits_consumed, 0);
  assert.equal(record.device_count, 2);
  assert.equal("input_tokens" in record, false);
  assert.equal("output_tokens" in record, false);
  assert.equal("cache_hit_tokens" in record, false, "a stringy number is not a count");
});

test("an unknown operation falls back to llm_call rather than inventing a bucket", () => {
  assert.equal(buildCreditUsage({ operation: "exfiltrate" }).operation, "llm_call");
  assert.equal(buildCreditUsage({}).operation, "llm_call");
  for (const op of CREDIT_OPERATIONS) {
    assert.equal(buildCreditUsage({ operation: op }).operation, op);
  }
});

test("server-only fields stay absent (not zero) until the server sends them", () => {
  // Slice A ships before the SSE enrichment: the four blocked fields must read as "unknown",
  // never as a real 0 that would poison the aggregate the team sizes the free quota from.
  const record: Record<string, any> = buildCreditUsage({ operation: "generate", credits_consumed: 1 });

  for (const key of ["model", "charged", "input_tokens", "output_tokens", "cache_hit_tokens"]) {
    assert.equal(key in record, false, `${key} must be absent, not 0`);
  }
  assert.equal(record.credits_consumed, 1);
});

test("every phase alias for one phase bills to the same operation", () => {
  // Aliases resolve first, or one generate phase would split across three buckets
  // depending on which token the model emitted.
  for (const alias of ["generate", "upy-generate", "upy-generate-plugin"]) {
    assert.equal(deriveCreditOperation(alias, PHASE_ALIASES), "generate");
  }
  assert.equal(deriveCreditOperation("deploy", PHASE_ALIASES), "deploy");
  assert.equal(deriveCreditOperation("gen-driver", PHASE_ALIASES), "gen_driver");
  assert.equal(deriveCreditOperation("wiring", PHASE_ALIASES), "wiring");
  assert.equal(deriveCreditOperation("diagram", PHASE_ALIASES), "diagram");
  // A canonical phase with no cost family of its own.
  assert.equal(deriveCreditOperation("analyze", PHASE_ALIASES), "phase");
  assert.equal(deriveCreditOperation("select-hw", PHASE_ALIASES), "phase");
  // No phase in flight at all.
  assert.equal(deriveCreditOperation(null, PHASE_ALIASES), "llm_call");
  assert.equal(deriveCreditOperation("   ", PHASE_ALIASES), "llm_call");
});

test("retry and supplement outrank the phase they run in", () => {
  // Otherwise a retried generate is indistinguishable from a first-try generate.
  assert.equal(deriveCreditOperation("generate", PHASE_ALIASES, { retry: true }), "retry");
  assert.equal(deriveCreditOperation("generate", PHASE_ALIASES, { supplement: true }), "supplement");
  assert.equal(deriveCreditOperation(null, PHASE_ALIASES, { retry: true }), "retry");
  // Retry wins over supplement — the re-issued turn is the thing that cost a credit.
  assert.equal(deriveCreditOperation("generate", PHASE_ALIASES, { retry: true, supplement: true }), "retry");
  assert.equal(deriveCreditOperation("generate", PHASE_ALIASES, { retry: false, supplement: false }), "generate");
});

test("the diagnostics line shows per-phase cost and the balance left after it", () => {
  const text = formatCreditUsage([
    buildCreditUsage({ operation: "phase", phase: "analyze", credits_consumed: 1, remaining_quota: 49 }),
    buildCreditUsage({ operation: "generate", phase: "upy-generate-plugin", credits_consumed: 1, charged: 3, remaining_quota: 46 }),
  ]);

  assert.equal(text, "analyze/phase credits=1 remaining=49; upy-generate-plugin/generate credits=3 remaining=46");
});

test("the diagnostics line prefers the authoritative charge over the balance delta", () => {
  // The balance delta is a best-effort estimate; once the server reports what it actually
  // deducted, that is the number the quota decision must be made on.
  const text = formatCreditUsage([buildCreditUsage({ operation: "generate", phase: "upy-generate-plugin", credits_consumed: 1, charged: 4 })]);

  assert.equal(text, "upy-generate-plugin/generate credits=4");
  assert.equal(formatCreditUsage([]), "");
});

test("the diagnostics line omits the cost it does not know instead of printing 0", () => {
  // A session's first turn has no balance baseline to diff and no server charge yet.
  // Mutation: default it to 0 -> a support report reads a free turn where the number is
  // simply missing, and the Activity line (which skips it) would disagree with the export.
  const text = formatCreditUsage([buildCreditUsage({ operation: "phase", phase: "analyze", remaining_quota: 49 })]);

  assert.equal(text, "analyze/phase remaining=49");
  assert.equal(text.includes("credits="), false);
});
