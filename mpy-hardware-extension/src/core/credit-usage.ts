// The ONE shared schema for per-phase credit consumption + project-complexity dimensions.
// Every surface reads this shape: the session JSONL (local diagnostics), the diagnostics
// export, the Activity per-phase line, and the enriched `credits_charged` cloud event.
//
// Privacy is BY CONSTRUCTION, not by redaction. The builder accepts counts, booleans, and
// bare identifier TOKENS only — a value carrying a path separator, whitespace, or any other
// prose character fails the token match and is DROPPED, never scrubbed-and-kept. So there is
// no field a prompt, a line of generated source, a serial log, or a filesystem path can ride
// in on. (`sanitizePayload` in telemetry.ts is a size guard, not a redactor — it would have
// happily forwarded any of those.)

// What a credit was spent on. The workflow-level view is the aggregate of a session's
// records (they share `session_id`), so there is no separate "workflow" operation.
export const CREDIT_OPERATIONS = [
  "llm_call", // a turn outside any phase
  "phase", // a canonical phase with no cost family of its own (analyze / select-hw / scaffold / flash)
  "retry", // the turn re-issued after a transport failure
  "supplement", // the turn that absorbed a user note queued mid-build
  "generate",
  "deploy",
  "gen_driver",
  "wiring",
  "diagram",
] as const;
export type CreditOperation = (typeof CREDIT_OPERATIONS)[number];

export type CreditUsageRecord = {
  // --- identity (4) ---
  session_id?: string;
  anon_id?: string;
  phase?: string;
  operation: CreditOperation;
  // --- complexity dimensions (7) ---
  device_count?: number;
  bom_count?: number; // populated once the Skill writes manifest.bom (Phase-2 field)
  generated_file_count?: number;
  code_line_count?: number;
  wiring?: boolean; // the wiring flow ran this session
  diagram?: boolean; // the diagram flow ran this session
  cold_driver?: boolean; // a device needed a driver built before generate could finish
  // --- effort / outcome (4) ---
  retry_count?: number;
  duration_ms?: number;
  error_code?: string;
  remaining_quota?: number; // the same balance the quota bar renders, from the same event
  // --- credit accounting (6) ---
  credits_consumed?: number; // best-effort, from the balance delta; never negative
  charged?: number; // authoritative server charge (present once the server sends it)
  model?: string;
  input_tokens?: number;
  output_tokens?: number;
  cache_hit_tokens?: number;
};

// The identifier shape every string field must match WHOLE. A path ("src/main.py",
// "C:\\Users\\me"), a sentence, or a code fragment all fail it, so they are dropped
// rather than partially scrubbed into the record.
const TOKEN = /^[A-Za-z0-9._-]{1,128}$/;

function token(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return TOKEN.test(trimmed) ? trimmed : undefined;
}

// A non-negative integer count. Rejects NaN/Infinity/negatives so a bad upstream number
// can never land in the aggregate as a spurious credit or a negative dimension.
function count(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.max(0, Math.trunc(value));
}

function flag(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function operation(value: unknown): CreditOperation {
  return (CREDIT_OPERATIONS as readonly string[]).includes(value as string)
    ? (value as CreditOperation)
    : "llm_call";
}

// Build a record from an arbitrary input bag. Pure. Unknown keys are dropped (the output is
// assembled key-by-key, never spread from the input), every value is coerced through the
// guards above, and any key whose value doesn't survive is omitted entirely — so an absent
// server field stays absent instead of becoming a misleading 0/"".
export function buildCreditUsage(input: Record<string, any>): CreditUsageRecord {
  const record: CreditUsageRecord = { operation: operation(input.operation) };
  const strings = { session_id: input.session_id, anon_id: input.anon_id, phase: input.phase, error_code: input.error_code, model: input.model };
  for (const [key, value] of Object.entries(strings)) {
    const t = token(value);
    if (t !== undefined) (record as any)[key] = t;
  }
  const counts = {
    device_count: input.device_count,
    bom_count: input.bom_count,
    generated_file_count: input.generated_file_count,
    code_line_count: input.code_line_count,
    retry_count: input.retry_count,
    duration_ms: input.duration_ms,
    remaining_quota: input.remaining_quota,
    credits_consumed: input.credits_consumed,
    charged: input.charged,
    input_tokens: input.input_tokens,
    output_tokens: input.output_tokens,
    cache_hit_tokens: input.cache_hit_tokens,
  };
  for (const [key, value] of Object.entries(counts)) {
    const n = count(value);
    if (n !== undefined) (record as any)[key] = n;
  }
  const flags = { wiring: input.wiring, diagram: input.diagram, cold_driver: input.cold_driver };
  for (const [key, value] of Object.entries(flags)) {
    const b = flag(value);
    if (b !== undefined) (record as any)[key] = b;
  }
  return record;
}

// Which operation a turn's credits belong to, from the phase in flight. Resolves the phase
// through the same alias table the protocol loop uses, so "generate", "upy-generate" and
// "upy-generate-plugin" all bill to `generate` — otherwise the aggregate would split one
// phase across three buckets depending on which token the model happened to emit.
const OPERATION_BY_PHASE: Record<string, CreditOperation> = {
  "upy-generate-plugin": "generate",
  "upy-deploy-plugin": "deploy",
  "upy-gen-driver-plugin": "gen_driver",
  "upy-wiring-plugin": "wiring",
  "upy-diagram-plugin": "diagram",
};

export function deriveCreditOperation(
  phase: string | null | undefined,
  aliases: Record<string, string>,
  context?: { retry?: boolean; supplement?: boolean },
): CreditOperation {
  // A retry re-issues the interrupted turn and a supplement turn folds in a queued note:
  // both are their own cost line, and both must outrank the phase they happen to run in
  // (otherwise a retried generate is indistinguishable from a first-try generate).
  if (context?.retry) return "retry";
  if (context?.supplement) return "supplement";
  const raw = typeof phase === "string" ? phase.trim() : "";
  if (!raw) return "llm_call";
  const canonical = aliases[raw] ?? raw;
  return OPERATION_BY_PHASE[canonical] ?? "phase";
}

// Roll up per phase/operation for the diagnostics export / support snapshot: total credits,
// how many turns produced them, and the balance left after the last one. One line per
// (phase, operation) instead of one per credits frame, so a phase that streamed a dozen
// mostly-free turns reads as "2 credits over 12 turns" rather than a wall of "credits=0".
// The JSONL/telemetry keep the full per-turn detail; this is the human summary. Same token
// discipline as the record — only already-guarded values are formatted.
export function formatCreditUsage(records: readonly CreditUsageRecord[]): string {
  const groups = new Map<string, { turns: number; credits: number; known: number; remaining: number | undefined }>();
  for (const r of records) {
    const key = `${r.phase ?? "-"}/${r.operation}`;
    const g = groups.get(key) ?? { turns: 0, credits: 0, known: 0, remaining: undefined };
    g.turns += 1;
    // Sum only known costs; a turn whose cost is unknown (a session's first turn has no
    // balance baseline and no server charge) counts as a turn but not as 0 credits.
    const spent = r.charged ?? r.credits_consumed;
    if (spent !== undefined) {
      g.credits += spent;
      g.known += 1;
    }
    if (r.remaining_quota !== undefined) g.remaining = r.remaining_quota;
    groups.set(key, g);
  }
  return Array.from(groups.entries())
    .map(([key, g]) => {
      const turns = `${g.turns} turn${g.turns === 1 ? "" : "s"}`;
      // Omit the credits figure when no turn in the group had a known cost — a support report
      // must not read a free group where every number was simply missing.
      const cost = g.known > 0 ? `${g.credits} credit${g.credits === 1 ? "" : "s"} over ${turns}` : turns;
      const tail = g.remaining !== undefined ? `, remaining ${g.remaining}` : "";
      return `${key}: ${cost}${tail}`;
    })
    .join("; ");
}
