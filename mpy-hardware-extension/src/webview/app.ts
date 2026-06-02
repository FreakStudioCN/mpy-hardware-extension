export function creditsLabel(credits: { balance: number }) {
  return `${Math.max(0, credits.balance)} credits left`;
}

export function isStartDisabled(credits: { balance: number }) {
  return credits.balance <= 0;
}

export function applyHostMessage(message: any, state: { statusText: string; startDisabled: boolean }) {
  if (message.type === "session_event" && message.event?.kind === "credits") {
    state.statusText = creditsLabel(message.event);
    state.startDisabled = isStartDisabled(message.event);
  }
  return state;
}
