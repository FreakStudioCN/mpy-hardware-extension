export function createSessionState(input: { traceId: string; intent: string; boardId: string }) {
  return {
    traceId: input.traceId,
    intent: input.intent,
    boardId: input.boardId,
    turnSeq: 0,
    repairRound: 0,
    loadedSkills: [] as string[],
    messages: [] as any[],
    lastRuntimeMarker: undefined as string | undefined,
  };
}
