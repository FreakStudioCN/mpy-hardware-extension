export function quotaLabel(quota: { used: number; limit: number }) {
  return `${Math.max(0, quota.limit - quota.used)} sessions remaining`;
}

export function isStartDisabled(quota: { used: number; limit: number }) {
  return quota.used >= quota.limit;
}

export function applyHostMessage(message: any, state: { statusText: string; startDisabled: boolean }) {
  if (message.type === "session_event" && message.event?.kind === "quota") {
    state.statusText = quotaLabel(message.event);
    state.startDisabled = isStartDisabled(message.event);
  }
  return state;
}
