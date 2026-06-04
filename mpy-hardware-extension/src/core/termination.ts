export function shouldTerminate(state: { turnSeq: number; repairRound: number; noProgressStreak?: number; lastRuntimeMarker?: string; runtimeVerified?: boolean; phase?: string }) {
  if (state.runtimeVerified) {
    return { done: true, reason: "success" };
  }
  // The phase-driven build reached its terminal phase (e.g. a PC-only build that
  // finished without flashing to a device): end cleanly instead of waiting for a
  // runtime marker that never comes.
  if (state.phase === "complete") {
    return { done: true, reason: "complete" };
  }
  if (state.repairRound >= 3) {
    return { done: true, reason: "repair_exhausted" };
  }
  // Repeated non-runtime failures (e.g. propose_manifest manifest_invalid) that
  // make no progress: stop with a clear reason instead of grinding to max_turns.
  if ((state.noProgressStreak ?? 0) >= 4) {
    return { done: true, reason: "manifest_unresolved" };
  }
  if (state.turnSeq >= 20) {
    return { done: true, reason: "max_turns" };
  }
  return { done: false, reason: undefined };
}
