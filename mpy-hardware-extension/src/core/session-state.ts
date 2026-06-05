export function createSessionState(input: { traceId: string; intent: string; boardId: string }) {
  return {
    traceId: input.traceId,
    intent: input.intent,
    boardId: input.boardId,
    turnSeq: 0,
    repairRound: 0,
    // Consecutive non-runtime tool failures (e.g. manifest_invalid). Reset on any
    // success; a streak terminates the loop as manifest_unresolved so repeated
    // validation failures fail fast instead of grinding to max_turns.
    noProgressStreak: 0,
    textOnlyTurns: 0,
    // Times the loop has nudged the model onward after it handed back mid-build
    // (a manifest exists but no code is generated yet). Bounded so a model that
    // keeps narrating without acting eventually hands back instead of looping.
    stallNudges: 0,
    loadedSkills: [] as string[],
    skillBodies: {} as Record<string, string>,
    messages: [] as any[],
    lastRuntimeMarker: undefined as string | undefined,
    runtimeVerified: false,
    // The user declined the deploy gate (or no board). Ends the loop cleanly as
    // "generated" instead of thrashing on deploy-tool retries. Reset per request.
    deployDeclined: false,
    // The user confirmed the component list at the one-shot gate in propose_manifest.
    // Persists across continuation so a follow-up message doesn't re-prompt.
    componentsConfirmed: false,
    // Derived session context built up by tool executions. Lives on state so it
    // survives multi-turn continuation (a follow-up message reuses the same state).
    board: undefined as any,
    driverContexts: [] as any[],
    // Absolute project directory the upstream toolchain scripts operate on. Set by
    // the phase-driven loop (B2, from project_name); until then the executors fall
    // back to deps.projectRoot (the workspace root).
    projectDir: undefined as string | undefined,
    // Upstream build phase (analyze -> select-hw -> scaffold -> generate -> deploy
    // -> ... -> complete). Mirrors the proposed manifest's `phase` field; drives the
    // termination `complete` check. Survives continuation like the rest of the
    // derived context.
    phase: "analyze" as string,
    // The latest proposed upstream project-manifest (rich shape). Lives on state so
    // later phases build on it and the device/script steps can read it.
    manifest: undefined as any,
  };
}
