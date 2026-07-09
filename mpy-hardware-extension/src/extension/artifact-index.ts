// The Artifact Browser's data model (spec §8.3). A session produces artifacts on disk
// (generated project files under blockless-project/, session logs under .mpyhw/sessions/);
// the browser needs a structured, openable index with per-artifact metadata AND relative
// display paths — the P0 rule (§4.2) is that paths shown to the UI must be relative, never
// hardcoded Windows drive paths. This module is pure: fs access (stat/hash) and the clock
// are injected, so it unit-tests without a real filesystem or VS Code, and the relative-path
// guarantee is asserted directly.

export type ArtifactKind =
  | "manifest" | "code" | "wiring" | "diagram" | "driver" | "log" | "diagnostics";

// One artifact row. `relative_path` is what the webview shows and echoes back on open;
// `absolute_path` is host-only (never sent as the display path) and is what actually opens.
export interface Artifact {
  kind: ArtifactKind;
  phase: string;          // producing phase, or "" when not phase-scoped
  relative_path: string;  // root-relative, POSIX "/", never a drive letter or leading "/"
  absolute_path: string;  // host-only, used to open/reveal
  role: string;           // e.g. project-manifest, firmware-driver, session-log
  size: number;           // bytes (0 if unknown)
  sha256: string;         // hex digest, or "" if unreadable
  created_at: string;     // ISO 8601, from the injected clock
  mime: string;
  is_binary: boolean;
  origin: "session" | "disk"; // produced by the live session vs found on disk (reopen)
}

// The raw on-disk descriptor the host collects before metadata/relativization.
export interface ArtifactSource {
  absolute_path: string;
  kind: ArtifactKind;
  phase?: string;
  role?: string;
  origin?: "session" | "disk";
}

export interface StatLike { size: number; mtimeMs: number; }

// Injected IO so the module stays pure and deterministic under test.
export interface ArtifactIndexDeps {
  stat: (absolutePath: string) => StatLike | null;   // null = missing/unreadable → skipped
  hash: (absolutePath: string) => string | null;     // sha256 hex, or null if unreadable
  isoFromMs: (ms: number) => string;                 // e.g. (ms) => new Date(ms).toISOString()
}

const MIME_BY_EXT: Record<string, string> = {
  json: "application/json", jsonl: "application/x-ndjson", py: "text/x-python",
  md: "text/markdown", txt: "text/plain", log: "text/plain", html: "text/html",
  svg: "image/svg+xml", png: "image/png", bin: "application/octet-stream",
  uf2: "application/octet-stream",
};
// Extensions we open/preview as raw bytes rather than text. svg is XML text, so not binary.
const BINARY_EXT = new Set(["png", "bin", "uf2"]);

function toPosix(p: string): string {
  return p.replace(/\\/g, "/");
}

function extensionOf(relativePath: string): string {
  const base = relativePath.slice(relativePath.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}

// Root-relative display path. Strips the root prefix when the artifact is under it, then
// strips any residual drive letter / leading slash so the result is ALWAYS relative and
// never leaks `C:\...` or `/abs/...` to the UI. Idempotent for already-relative input.
export function toRelativeDisplayPath(root: string, absolutePath: string): string {
  const r = toPosix(root).replace(/\/+$/, "");
  const a = toPosix(absolutePath);
  let rel = a;
  if (r && (a === r || a.startsWith(r + "/"))) {
    rel = a.slice(r.length);
  }
  return rel.replace(/^[A-Za-z]:/, "").replace(/^\/+/, "");
}

function roleFor(source: ArtifactSource, relativePath: string): string {
  if (source.role) return source.role;
  const base = relativePath.slice(relativePath.lastIndexOf("/") + 1);
  if (base === "project-manifest.json" || base === "manifest.json") return "project-manifest";
  if (relativePath.includes("firmware/drivers/")) return "firmware-driver";
  if (relativePath.includes("firmware/")) return "firmware";
  if (base === "session.jsonl" || relativePath.includes("/sessions/")) return "session-log";
  return source.kind;
}

// Classify a produced file path into an artifact kind, so the host can turn its raw
// list of written paths (persistedPaths) into typed sources without the caller repeating
// this. Firmware code is a driver artifact; wiring/diagram JSON are their own kinds;
// manifests are manifest; session logs are log; everything else defaults to code.
export function classifyArtifactKind(absolutePath: string): ArtifactKind {
  const p = toPosix(absolutePath);
  const base = p.slice(p.lastIndexOf("/") + 1);
  if (base === "project-manifest.json" || base === "manifest.json") return "manifest";
  if (base === "wiring.json") return "wiring";
  if (base === "diagram.json") return "diagram";
  if (base === "session.jsonl" || p.includes("/sessions/")) return "log";
  if (p.includes("/firmware/")) return "driver";
  return "code";
}

// Build the structured, deduped artifact index from on-disk sources. Missing files
// (stat === null) are skipped so a stale record never surfaces a broken row. Output
// order follows first-seen input order.
export function buildArtifactIndex(
  sources: ArtifactSource[],
  root: string,
  deps: ArtifactIndexDeps,
): Artifact[] {
  const out: Artifact[] = [];
  const seen = new Set<string>();
  for (const source of sources) {
    const abs = toPosix(source.absolute_path);
    if (!abs || seen.has(abs)) continue;
    const stat = deps.stat(source.absolute_path);
    if (!stat) continue; // missing on disk — don't index a row that can't open
    seen.add(abs);
    const relative_path = toRelativeDisplayPath(root, source.absolute_path);
    const ext = extensionOf(relative_path);
    out.push({
      kind: source.kind,
      phase: source.phase ?? "",
      relative_path,
      absolute_path: source.absolute_path,
      role: roleFor(source, relative_path),
      size: stat.size,
      sha256: deps.hash(source.absolute_path) ?? "",
      created_at: deps.isoFromMs(stat.mtimeMs),
      mime: MIME_BY_EXT[ext] ?? "application/octet-stream",
      is_binary: BINARY_EXT.has(ext),
      origin: source.origin ?? "session",
    });
  }
  return out;
}

export type ArtifactOpenAction = "preview" | "open" | "editor" | "reveal";

// How the host should open an artifact, decided by mime/binary. Pure so the routing is
// unit-tested without spawning VS Code commands: markdown -> native markdown preview;
// png/svg/html -> native viewer (vscode.open picks image preview / editor); other text
// (code, json, log, jsonl) -> text editor; binary (bin/uf2) -> reveal in the file manager.
export function artifactOpenAction(mime: string, isBinary: boolean): ArtifactOpenAction {
  if (mime === "text/markdown") return "preview";
  if (mime === "image/png" || mime === "image/svg+xml" || mime === "text/html") return "open";
  return isBinary ? "reveal" : "editor";
}

// Trust boundary: the webview only ever knows relative paths and echoes one back on open.
// Resolve it to an absolute path ONLY if it exactly matches an indexed artifact — this
// rejects traversal (`../`), absolute paths, drive letters, and any out-of-index path,
// so a compromised/buggy webview can never open an arbitrary file.
export function resolveArtifactPath(index: Artifact[], relativePath: string): string | null {
  if (typeof relativePath !== "string" || !relativePath) return null;
  const norm = toPosix(relativePath).replace(/^\/+/, "");
  const hit = index.find((a) => a.relative_path === norm);
  return hit ? hit.absolute_path : null;
}
