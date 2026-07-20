// The driver.source values the Skill's manifest schema recognizes
// (upy-project-gen-toolchain-spec/project-manifest.schema.json). Anything the package
// browser turns into a manifest driver.source MUST be one of these. "graftsense" is
// deliberately absent from the schema/validators/pipeline and must never be emitted.
export type DriverSource =
  | "builtin_runtime"
  | "micropython_lib"
  | "upypi"
  | "awesome-micropython"
  | "github"
  | "cold-driver"
  | "none";

const SANCTIONED: ReadonlySet<string> = new Set<DriverSource>([
  "builtin_runtime",
  "micropython_lib",
  "upypi",
  "awesome-micropython",
  "github",
  "cold-driver",
  "none",
]);

// Map a browsed catalog record's `source` (a provenance tag that may be "graftsense" or
// "curated") to a sanctioned manifest driver.source. Hard invariant: this never returns
// "graftsense" -- a browsed graftsense record is re-routed to its GitHub repo when it
// has one, otherwise to uPyPI (the standard installable source).
// ponytail: curated/unknown default to "upypi"; Phase 2/3 may refine per-record once
// live micropython-lib/uPyPI resolution lands. The ceiling is the coarse default, not
// the graftsense guarantee, which is exact.
export function normalizeDriverSource(catalogSource: string | undefined, repositoryUrl?: string): DriverSource {
  const source = (catalogSource ?? "").toLowerCase();
  if (source === "graftsense") {
    return repositoryUrl ? "github" : "upypi";
  }
  if (SANCTIONED.has(source)) {
    return source as DriverSource;
  }
  return "upypi";
}
