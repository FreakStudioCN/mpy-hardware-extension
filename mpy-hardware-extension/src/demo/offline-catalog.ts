// Offline, network-free package/board catalog for the E2E demo (`npm run demo:e2e`).
//
// It serves the same data the production mpyhw-api serves, from a static snapshot
// under demo/fixtures/ (built by demo/build-fixtures.py, which imports the real
// PackageStore). The ranking below is a faithful port of the stable resolve logic
// in mpyhw-api/app/package_store.py (`_ranked` / `resolve` and the weight helpers);
// demo/fixtures/resolve-golden.json captures the Python output for the demo intents
// so test/offline-ranking.test.ts can prove this port matches the source of truth.
//
// Only the golden temperature/LED path is exercised offline. Live LLM codegen for
// arbitrary intents, real firmware flashing and retry/checkpoint/autofix run against
// the production backend (createProtocolLoop), not this snapshot.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "demo", "fixtures");

type Record = {
  name: string;
  version: string;
  source: string;
  package_json_url: string;
  description?: string;
  capabilities: string[];
  chips?: string;
  fw?: string;
  support_level: string;
  confidence?: number;
};

type Hit = Record & { score: number; reason: string };

// Stripped before crossing the (simulated) API boundary — mirrors INTERNAL_FIELDS
// in package_store.py so a public hit carries no ranking score / confidence.
const INTERNAL_FIELDS = new Set([
  "score_base",
  "reason_rules",
  "driver_context_ref",
  "evidence_refs",
  "driver_context",
  "bus",
  "confidence",
]);

let _catalog: Record[] | undefined;
function catalog(): Record[] {
  if (!_catalog) _catalog = JSON.parse(readFileSync(join(FIXTURES, "catalog.json"), "utf-8"));
  return _catalog!;
}

// --- ranking helpers (ports of package_store.py module functions) ---

function supportWeight(level: string): number {
  return { verified: 4.0, generatable: 3.0, installable: 2.0, discoverable: 1.0, experimental: 0.0 }[level] ?? 0.0;
}

function primaryResolutionCapabilities(capabilities: string[]): string[] {
  const sensing = capabilities.filter((c) => c === "temperature_sensing" || c === "humidity_sensing");
  return sensing.length ? sensing : capabilities;
}

function boardFamily(boardId: string): string {
  const value = (boardId || "").toLowerCase();
  for (const family of ["esp32", "rp2040", "pico"]) {
    if (value.includes(family)) return family === "pico" ? "rp2040" : family;
  }
  return "";
}

function boardMatchWeight(chips: string | undefined, family: string): number {
  const chipText = String(chips ?? "all").toLowerCase();
  if (!family || chipText === "" || chipText === "all") return 0.0;
  if (chipText.includes(family)) return 2.0;
  return -5.0;
}

const STOP_WORDS = new Set(["the", "and", "when", "with", "over", "turn", "on", "off", "read", "show", "is"]);

function toHit(record: Record): Hit {
  return {
    name: record.name,
    version: record.version,
    source: record.source,
    package_json_url: record.package_json_url,
    description: record.description,
    capabilities: record.capabilities,
    chips: record.chips ?? "all",
    fw: record.fw ?? "all",
    support_level: record.support_level,
    confidence: record.confidence ?? 0.0,
    score: 0.0,
    reason: "",
  };
}

function publicHit(hit: Hit): Partial<Hit> {
  const out: any = {};
  for (const [key, value] of Object.entries(hit)) {
    if (!INTERNAL_FIELDS.has(key)) out[key] = value;
  }
  return out;
}

// Sort by (-score, -confidence, name) — same total order as the Python tie-break.
function rankSort(a: Hit, b: Hit): number {
  if (b.score !== a.score) return b.score - a.score;
  const ac = a.confidence ?? 0;
  const bc = b.confidence ?? 0;
  if (bc !== ac) return bc - ac;
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

function ranked(query: string, capabilities: string[], limit = 10, family = ""): Hit[] {
  const caps = capabilities || [];
  const terms = new Set(
    query
      .toLowerCase()
      .replace(/_/g, " ")
      .split(/\s+/)
      .filter((term) => term.length >= 3 && !STOP_WORDS.has(term)),
  );
  const hits: Hit[] = [];
  for (const record of catalog()) {
    let score = 0.0;
    const recordCaps = new Set(record.capabilities ?? []);
    const intersection = caps.filter((c) => recordCaps.has(c));
    score += 10.0 * intersection.length;
    if (caps.length && intersection.length === 0) continue;
    score += supportWeight(record.support_level);
    score += record.confidence ?? 0.0;
    if (family) score += boardMatchWeight(record.chips, family);
    const haystack = [record.name, record.description ?? "", [...recordCaps].join(" ")].join(" ").toLowerCase();
    let termHits = 0;
    for (const term of terms) if (term && haystack.includes(term)) termHits += 1;
    score += 0.25 * termHits;
    if (score > 0 || (!query && !caps.length)) {
      const hit = toHit(record);
      hit.score = score;
      hit.reason = score ? "capability_match" : "listed";
      hits.push(hit);
    }
  }
  return hits.sort(rankSort).slice(0, limit);
}

export function resolve(request: { intent: string; capabilities: string[]; board_id: string }) {
  const primary = primaryResolutionCapabilities(request.capabilities);
  const candidates = ranked(request.intent, primary, 10);
  const family = boardFamily(request.board_id);
  for (const candidate of candidates) {
    candidate.score += boardMatchWeight(candidate.chips, family);
    const chipText = String(candidate.chips ?? "all").toLowerCase();
    if (family && chipText !== "" && chipText !== "all" && chipText.includes(family)) {
      candidate.reason = "board_family_match";
    }
  }
  candidates.sort(rankSort);
  const selected = candidates[0] ?? null;
  return {
    candidates: candidates.map(publicHit),
    selected: selected ? publicHit(selected) : null,
    needs_user_choice: selected === null,
    questions: selected ? [] : ["No package candidate matched the requested capabilities."],
  };
}

// --- offline clients: duck-typed to what runPipeline() expects ---

export class OfflinePackageClient {
  resolve(request: { intent: string; capabilities: string[]; board_id: string }) {
    return Promise.resolve(resolve(request));
  }

  getPackageContext(name: string, version: string) {
    const safe = `${name}@${version}`.replace(/\//g, "_");
    try {
      return Promise.resolve(JSON.parse(readFileSync(join(FIXTURES, "driver-contexts", `${safe}.json`), "utf-8")));
    } catch {
      return Promise.reject(Object.assign(new Error("driver_context_missing"), { code: "driver_context_missing" }));
    }
  }
}

export class OfflineBoardClient {
  getBoardProfile(boardId: string) {
    try {
      return Promise.resolve(JSON.parse(readFileSync(join(FIXTURES, "boards", `${boardId}.json`), "utf-8")));
    } catch {
      return Promise.reject(Object.assign(new Error("board_not_found"), { code: "board_not_found" }));
    }
  }
}
