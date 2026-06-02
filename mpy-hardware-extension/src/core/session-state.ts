export function createSessionState(input: { traceId: string; intent: string; boardId: string }) {
  return {
    traceId: input.traceId,
    intent: input.intent,
    boardId: input.boardId,
    turnSeq: 0,
    repairRound: 0,
    textOnlyTurns: 0,
    loadedSkills: [] as string[],
    messages: [] as any[],
    lastRuntimeMarker: undefined as string | undefined,
    // Derived session context built up by tool executions. Lives on state so it
    // survives multi-turn continuation (a follow-up message reuses the same state).
    board: undefined as any,
    driverContexts: [] as any[],
  };
}
