export function shouldTerminate(state: { turnSeq: number; repairRound: number; noProgressStreak?: number; lastRuntimeMarker?: string; runtimeVerified?: boolean; phase?: string; deployDeclined?: boolean }) {
  if (state.runtimeVerified) {
    return { done: true, reason: "success" };
  }
  // The phase-driven build reached its terminal phase (e.g. a PC-only build that
  // finished without flashing to a device): end cleanly instead of waiting for a
  // runtime marker that never comes.
  if (state.phase === "complete") {
    return { done: true, reason: "complete" };
  }
  // The user declined the deploy gate (or no board is connected). The code is
  // generated; flashing was a deliberate skip, not a failure. End cleanly as
  // "generated" rather than letting the model thrash toward manifest_unresolved.
  if (state.deployDeclined) {
    return { done: true, reason: "generated" };
  }
  if (state.repairRound >= 3) {
    return { done: true, reason: "repair_exhausted" };
  }
  // Repeated non-runtime failures (e.g. propose_manifest manifest_invalid) that
  // make no progress: stop with a clear reason instead of grinding to max_turns.
  if ((state.noProgressStreak ?? 0) >= 4) {
    return { done: true, reason: "manifest_unresolved" };
  }
  // Hard backstop against a runaway loop. Sized for the rich multi-file project
  // build (scaffold -> download_drivers -> N writes -> generate -> validate ->
  // static_check -> simulate -> render -> deploy -> read, plus repair rounds),
  // which legitimately exceeds the old single-main.py budget. repair_exhausted
  // and the no-progress streak above are the real early-exit signals.
  if (state.turnSeq >= 40) {
    return { done: true, reason: "max_turns" };
  }
  return { done: false, reason: undefined };
}
