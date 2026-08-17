// The replayed-conversation window: how big the history is allowed to get, and what gets
// collapsed when it is too big. Split out of protocol-loop.ts because it is self-contained
// (pure functions over the message array) and the loop file had no room left to grow.

// Longest string field kept verbatim in the tool_use telemetry payload.
export const TELEMETRY_INPUT_STRING_BUDGET = 200;
// How much of an over-budget string still gets recorded, alongside its length and a digest.
// The digest is what answers "did the model rewrite the same body six times or evolve it?",
// which a bare "<2444 chars>" cannot: a stall triage could see six writes of main.py and not
// whether any of them changed. The head is where a generated file states its intent.
export const TELEMETRY_INPUT_HEAD_CHARS = 400;
// Fields that carry a FILE BODY rather than an identifier. Their head is never recorded:
// telemetry reaches session.jsonl and the consented cloud tool_dispatch payload unredacted,
// and firmware/conf.py is exactly where this product puts credentials -- a secret near the
// top of a generated file would be captured verbatim. The length and digest still answer
// what a stall triage asks (which file, how many times, did it change), so nothing needed
// for diagnosis is lost.
export const TELEMETRY_BODY_FIELDS = new Set(["content", "code", "stdin_content", "text"]);

export function digest(value: string): string {
  // FNV-1a, 32-bit. Not a security hash: it only has to differ when the body differs, without
  // pulling node:crypto into the core loop, which runs in the webview bundle too.
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

// Ceiling on the REPLAYED conversation, in characters. capToolOutput bounds one tool result
// at 80k chars; nothing bounded their sum, and the history is re-sent on every request, so a
// long phase walks into the model's context limit and takes a NON-retryable 400 that kills
// the run outright (measured: 264,708 tokens against a 262,144 ceiling on a scaffold phase,
// and 539,335 on a larger project). ~4 chars per token, so 480k chars is ~120k tokens, which
// leaves room for the system prompt, the tool schemas and the reply under every model we run.
export const HISTORY_MAX_CHARS = 480_000;
// Newest messages never shrink: the model is repairing against the LAST gate report, and the
// corrective message points at it. Only older results collapse.
export const HISTORY_KEEP_RECENT = 8;

// Marks a body this module already replaced. Re-collapsing an elided value nests the markers
// and eats 28 characters off the surviving head every pass, so after a dozen passes the block
// is nothing but markers and the digest describes the elision instead of the body.
const ELISION_PREFIX = "<elided ";

function elide(value: string): string {
  const elided = `${ELISION_PREFIX}${value.length} chars ${digest(value)}> ` + value.slice(0, TELEMETRY_INPUT_HEAD_CHARS);
  // The marker costs ~28 characters and the head keeps a full 400, so anything in
  // (400, ~428] comes out LONGER than it went in -- and boundHistory would then grow the
  // history it was called to shrink, one negative saving at a time. Nothing to win here.
  return elided.length < value.length ? elided : value;
}

function collapsible(value: unknown): value is string {
  return typeof value === "string" && value.length > TELEMETRY_INPUT_HEAD_CHARS && !value.startsWith(ELISION_PREFIX);
}

/** Characters this block contributes to the replayed request.
 *
 * All four block shapes count, not just the two that carry `content`/`text`: an assistant
 * turn's `tool_use` holds its payload under `input`, and a file_operation WRITE puts a whole
 * generated file body there. Measuring only content/text made the generate phase -- the one
 * that writes files, and the one this cap exists for -- look like it was using 520 characters
 * while the request going out was 614,027.
 */
export function blockTextLength(block: any): number {
  if (typeof block?.content === "string") return block.content.length;
  if (typeof block?.text === "string") return block.text.length;
  if (typeof block?.thinking === "string") return block.thinking.length;
  if (block?.input && typeof block.input === "object") return JSON.stringify(block.input).length;
  return 0;
}

export function historyChars(messages: any[]): number {
  let total = 0;
  for (const message of messages) {
    const content = message?.content;
    if (typeof content === "string") { total += content.length; continue; }
    if (Array.isArray(content)) for (const block of content) total += blockTextLength(block);
  }
  return total;
}

/** Collapse one block's bodies in place. Returns how many characters that saved. */
function collapseBlock(block: any): number {
  // A tool RESULT: the whole string is the body.
  if (block?.type === "tool_result" && collapsible(block.content)) {
    const before = block.content.length;
    block.content = elide(block.content);
    return before - block.content.length;
  }
  // A tool USE: only the body-bearing fields. The path, script and flags are the identity of
  // the call and stay verbatim, so the model still reads what it did, just not the file it
  // wrote -- which it does not need replayed back to it, because it wrote it.
  if (block?.type === "tool_use" && block.input && typeof block.input === "object") {
    let saved = 0;
    for (const key of Object.keys(block.input)) {
      if (!TELEMETRY_BODY_FIELDS.has(key)) continue;
      const value = block.input[key];
      if (!collapsible(value)) continue;
      block.input[key] = elide(value);
      saved += value.length - block.input[key].length;
    }
    return saved;
  }
  return 0;
}

/** Collapse the oldest tool bodies until the replayed history fits HISTORY_MAX_CHARS.
 *
 * Messages are never dropped and ids are never touched: an assistant `tool_use` must keep
 * its matching `tool_result`, and breaking that pairing makes the upstream reject the whole
 * conversation -- the same failure class as the empty-assistant turn. Only the BODY inside an
 * old block is replaced, with its length and digest, so the model can still see that a call
 * happened and what it was, just not the whole file body it carried.
 *
 * Returns false when the history is STILL over the cap once every collapsible message has
 * been collapsed -- the protected recent window alone can exceed it, since capToolOutput
 * bounds one result at 80k and a turn can carry several. The caller must not treat that as
 * success: the request goes out over budget and takes the same non-retryable 400 this cap
 * exists to prevent, and a silent return would make the next diagnosis start from "the cap
 * was in place, so this cannot be a size problem".
 */
export function boundHistory(messages: any[]): boolean {
  let total = historyChars(messages);
  if (total <= HISTORY_MAX_CHARS) return true;
  const collapsibleCount = Math.max(0, messages.length - HISTORY_KEEP_RECENT);
  for (let i = 0; i < collapsibleCount && total > HISTORY_MAX_CHARS; i += 1) {
    const content = messages[i]?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) total -= collapseBlock(block);
  }
  // Re-measure instead of trusting the running total. collapseBlock returns the RAW character
  // saving, while a tool_use is measured as its JSON -- where every quote and newline in the
  // body costs two characters -- so the running total runs low. Low is the safe direction for
  // the loop (it collapses slightly more than it had to), but the return value gates an alarm,
  // and an alarm that fires on a request that was actually within budget is worse than none.
  return historyChars(messages) <= HISTORY_MAX_CHARS;
}
