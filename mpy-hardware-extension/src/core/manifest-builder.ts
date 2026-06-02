export function buildManifest(input: {
  board: any;
  capabilities: string[];
  packages: Array<{ name: string; version: string }>;
  driverContexts: any[];
  logic: Record<string, unknown>;
}) {
  const pins: Record<string, string> = {};
  const wiring: Array<{ role: string; pin: string }> = [];
  for (const context of input.driverContexts) {
    for (const role of context.pin_roles ?? []) {
      const pin = role === "led_anode"
        ? input.board.pin_recommendations.led_anode ?? input.board.pin_recommendations.led_default
        : input.board.pin_recommendations[role];
      if (pin) {
        pins[role] = pin;
        wiring.push({ role, pin });
      }
    }
  }
  return {
    board_id: input.board.board_id,
    capabilities: input.capabilities,
    packages: input.packages,
    driver_context_refs: input.driverContexts.map((context) => `${context.package.name}@${context.package.version}`),
    pins,
    logic: input.logic,
    wiring,
    board: input.board,
  };
}
