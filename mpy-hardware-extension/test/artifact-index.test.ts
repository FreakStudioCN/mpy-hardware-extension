import assert from "node:assert/strict";
import test from "node:test";

import { resolve } from "node:path";

import { artifactOpenAction, buildArtifactIndex, classifyArtifactKind, resolveArtifactPath, resolveContainedArtifactPath, toRelativeDisplayPath } from "../src/extension/artifact-index.ts";
import type { ArtifactSource } from "../src/extension/artifact-index.ts";

// Deterministic injected IO: every path "exists" with a fixed size/mtime and a
// path-derived hash, so the pure index logic is asserted without touching disk.
const deps = {
  stat: (p: string) => ({ size: p.length, mtimeMs: 1_700_000_000_000 }),
  hash: (p: string) => `sha-${p.length}`,
  isoFromMs: (ms: number) => new Date(ms).toISOString(),
};

test("toRelativeDisplayPath strips the root and never leaks a drive letter or leading slash", () => {
  assert.equal(toRelativeDisplayPath("/ws", "/ws/blockless-project/main.py"), "blockless-project/main.py");
  // Windows shapes: backslash root + drive-letter path must come out relative and clean.
  assert.equal(toRelativeDisplayPath("C:\\ws", "C:\\ws\\blockless-project\\main.py"), "blockless-project/main.py");
  // An artifact not under the root still must not surface a drive letter or absolute path.
  const outside = toRelativeDisplayPath("/ws", "C:/other/thing.bin");
  assert.doesNotMatch(outside, /^[A-Za-z]:/);
  assert.doesNotMatch(outside, /^\//);
});

test("buildArtifactIndex covers every kind with relative paths and full metadata", () => {
  const root = "/ws";
  const sources: ArtifactSource[] = [
    { absolute_path: "/ws/blockless-project/project-manifest.json", kind: "manifest", phase: "analyze" },
    { absolute_path: "/ws/blockless-project/main.py", kind: "code", phase: "generate" },
    { absolute_path: "/ws/blockless-project/docs/wiring.json", kind: "wiring", phase: "generate" },
    { absolute_path: "/ws/blockless-project/docs/diagram.json", kind: "diagram", phase: "generate" },
    { absolute_path: "/ws/blockless-project/firmware/drivers/aht20/__init__.py", kind: "driver", phase: "gen-driver" },
    { absolute_path: "/ws/.mpyhw/sessions/s-1/session.jsonl", kind: "log", phase: "" },
    { absolute_path: "/ws/blockless-project/diagnostics.json", kind: "diagnostics", phase: "" },
  ];

  const index = buildArtifactIndex(sources, root, deps);

  assert.equal(index.length, sources.length, "one row per source");
  const kinds = new Set(index.map((a) => a.kind));
  for (const k of ["manifest", "code", "wiring", "diagram", "driver", "log", "diagnostics"]) {
    assert.ok(kinds.has(k as any), `kind ${k} present`);
  }
  // No display path may leak a drive letter or an absolute path — the P0 rule (§4.2).
  for (const a of index) {
    assert.doesNotMatch(a.relative_path, /^[A-Za-z]:/, `relative_path clean: ${a.relative_path}`);
    assert.doesNotMatch(a.relative_path, /^\//, `relative_path relative: ${a.relative_path}`);
    assert.ok(a.absolute_path.length > 0, "absolute_path retained host-side");
    assert.equal(typeof a.size, "number");
    assert.equal(a.created_at, "2023-11-14T22:13:20.000Z");
    assert.ok(a.sha256.startsWith("sha-"), "sha256 computed");
    assert.equal(a.origin, "session", "sources without an origin default to session");
  }

  const manifest = index.find((a) => a.kind === "manifest")!;
  assert.equal(manifest.relative_path, "blockless-project/project-manifest.json");
  assert.equal(manifest.role, "project-manifest");
  assert.equal(manifest.mime, "application/json");
  assert.equal(manifest.is_binary, false);

  const log = index.find((a) => a.kind === "log")!;
  assert.equal(log.relative_path, ".mpyhw/sessions/s-1/session.jsonl");
  assert.equal(log.role, "session-log");
});

test("buildArtifactIndex skips missing files and dedupes by absolute path", () => {
  const sources: ArtifactSource[] = [
    { absolute_path: "/ws/a.py", kind: "code" },
    { absolute_path: "/ws/a.py", kind: "code" }, // duplicate
    { absolute_path: "/ws/gone.py", kind: "code" }, // missing on disk
  ];
  const missingAware = { ...deps, stat: (p: string) => (p.endsWith("gone.py") ? null : { size: 1, mtimeMs: 0 }) };
  const index = buildArtifactIndex(sources, "/ws", missingAware);
  assert.equal(index.length, 1, "deduped and missing-skipped");
});

test("png/bin are flagged binary; svg/md/py are text", () => {
  const sources: ArtifactSource[] = [
    { absolute_path: "/ws/p.png", kind: "diagram" },
    { absolute_path: "/ws/f.bin", kind: "driver" },
    { absolute_path: "/ws/d.svg", kind: "diagram" },
    { absolute_path: "/ws/r.md", kind: "code" },
  ];
  const index = buildArtifactIndex(sources, "/ws", deps);
  const by = (name: string) => index.find((a) => a.relative_path === name)!;
  assert.equal(by("p.png").is_binary, true);
  assert.equal(by("f.bin").is_binary, true);
  assert.equal(by("d.svg").is_binary, false);
  assert.equal(by("d.svg").mime, "image/svg+xml");
  assert.equal(by("r.md").is_binary, false);
  assert.equal(by("r.md").mime, "text/markdown");
});

test("origin marks disk-sourced artifacts distinctly from session ones", () => {
  const index = buildArtifactIndex(
    [
      { absolute_path: "/ws/a.py", kind: "code" },                   // no origin -> session
      { absolute_path: "/ws/b.py", kind: "code", origin: "disk" },
    ],
    "/ws",
    deps,
  );
  assert.equal(index.find((a) => a.relative_path === "a.py")!.origin, "session");
  assert.equal(index.find((a) => a.relative_path === "b.py")!.origin, "disk");
});

test("classifyArtifactKind maps produced paths to kinds", () => {
  assert.equal(classifyArtifactKind("/ws/blockless-project/project-manifest.json"), "manifest");
  assert.equal(classifyArtifactKind("/ws/blockless-project/docs/wiring.json"), "wiring");
  assert.equal(classifyArtifactKind("/ws/blockless-project/docs/diagram.json"), "diagram");
  assert.equal(classifyArtifactKind("/ws/blockless-project/firmware/drivers/aht20/__init__.py"), "driver");
  assert.equal(classifyArtifactKind("/ws/.mpyhw/sessions/s-1/session.jsonl"), "log");
  assert.equal(classifyArtifactKind("/ws/blockless-project/main.py"), "code");
  // Windows backslash path classifies the same
  assert.equal(classifyArtifactKind("C:\\ws\\blockless-project\\firmware\\drivers\\x.py"), "driver");
});

test("artifactOpenAction routes by mime: preview / native open / editor / reveal", () => {
  assert.equal(artifactOpenAction("text/markdown", false), "preview");
  assert.equal(artifactOpenAction("image/png", true), "open");
  assert.equal(artifactOpenAction("image/svg+xml", false), "open");
  assert.equal(artifactOpenAction("text/html", false), "open");
  assert.equal(artifactOpenAction("text/x-python", false), "editor");
  assert.equal(artifactOpenAction("application/json", false), "editor");
  assert.equal(artifactOpenAction("application/x-ndjson", false), "editor");
  assert.equal(artifactOpenAction("application/octet-stream", true), "reveal");
});

test("resolveArtifactPath opens only in-index paths (trust boundary)", () => {
  const index = buildArtifactIndex(
    [{ absolute_path: "/ws/blockless-project/main.py", kind: "code" }],
    "/ws",
    deps,
  );
  // in-index relative path resolves to the host absolute path
  assert.equal(resolveArtifactPath(index, "blockless-project/main.py"), "/ws/blockless-project/main.py");
  // leading slash tolerated (normalized) but still must match an entry
  assert.equal(resolveArtifactPath(index, "/blockless-project/main.py"), "/ws/blockless-project/main.py");
  // everything hostile / out-of-index is refused
  for (const bad of ["../../etc/passwd", "/etc/passwd", "C:/Windows/x", "blockless-project/other.py", "", "..\\..\\x"]) {
    assert.equal(resolveArtifactPath(index, bad), null, `refused: ${bad}`);
  }
});

test("buildArtifactIndex uses the source-provided role over the path heuristic", () => {
  const index = buildArtifactIndex(
    [{ absolute_path: "/ws/blockless-project/main.py", kind: "code", role: "firmware" }],
    "/ws",
    deps,
  );
  assert.equal(index[0].role, "firmware", "Skill-provided role wins over the roleFor() heuristic");
});

test("classifyArtifactKind tags session checkpoints as their own kind", () => {
  assert.equal(classifyArtifactKind("/ws/.mpyhw/sessions/s-1/checkpoints/analyze.json"), "checkpoint");
  // still a log for the session trace itself
  assert.equal(classifyArtifactKind("/ws/.mpyhw/sessions/s-1/session.jsonl"), "log");
});

test("resolveContainedArtifactPath refuses absolute + `..`-escaping phase paths (#28 F1)", () => {
  const base = resolve("/ws/blockless-project");
  // Everything that exists is "on disk"; the containment check must gate what resolves.
  const exists = () => true;
  // A normal in-base relative path resolves under the base.
  assert.equal(resolveContainedArtifactPath([base], "main.py", exists), resolve(base, "main.py"));
  assert.equal(resolveContainedArtifactPath([base], "firmware/drivers/aht20.py", exists), resolve(base, "firmware/drivers/aht20.py"));
  // Hostile declarations are refused even though the target "exists".
  for (const bad of ["../../etc/passwd", "../outside.py", "/etc/passwd", "C:\\Windows\\x", ""]) {
    assert.equal(resolveContainedArtifactPath([base], bad, exists), null, `refused: ${JSON.stringify(bad)}`);
  }
  // A non-existent (but contained) path still resolves to null — nothing to index.
  assert.equal(resolveContainedArtifactPath([base], "gone.py", () => false), null);
  // Tries bases in order; skips a base the path escapes, honors the next that contains it.
  const other = resolve("/other");
  assert.equal(
    resolveContainedArtifactPath([base, other], "x.py", (p) => p === resolve(other, "x.py")),
    resolve(other, "x.py"),
    "falls through to a later base that contains the file",
  );
});
