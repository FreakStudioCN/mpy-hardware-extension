export function shouldTerminate(state: { turnSeq: number; repairRound: number; lastRuntimeMarker?: string; runtimeVerified?: boolean }) {
  if (state.runtimeVerified || state.lastRuntimeMarker?.includes("TEMP_C=")) {
    return { done: true, reason: "success" };
  }
  if (state.repairRound >= 3) {
    return { done: true, reason: "repair_exhausted" };
  }
  if (state.turnSeq >= 20) {
    return { done: true, reason: "max_turns" };
  }
  return { done: false, reason: undefined };
}
