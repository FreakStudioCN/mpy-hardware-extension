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
    loadedSkills: [] as string[],
    skillBodies: {} as Record<string, string>,
    messages: [] as any[],
    lastRuntimeMarker: undefined as string | undefined,
    runtimeVerified: false,
    // Derived session context built up by tool executions. Lives on state so it
    // survives multi-turn continuation (a follow-up message reuses the same state).
    board: undefined as any,
    driverContexts: [] as any[],
  };
}
