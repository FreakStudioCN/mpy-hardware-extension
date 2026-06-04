// `board` is passed explicitly by callers that loaded the board profile out of
// band (the LLM-proposed manifest carries no `board`), falling back to an
// embedded manifest.board for the offline pipeline. Without it the
// pin-capability gate cannot run, so the real agent path must supply it.
export function validateManifest(manifest: any, board: any = manifest?.board): { valid: true; errors: [] } | { valid: false; errors: Array<{ code: string; message: string }> } {
  const errors: Array<{ code: string; message: string }> = [];
  for (const key of ["board_id", "capabilities", "packages", "driver_context_refs", "pins", "logic", "wiring"]) {
    if (!(key in manifest)) {
      errors.push({ code: "missing_field", message: key });
    }
  }
  const pins = manifest?.pins;
  if (pins !== undefined) {
    if (typeof pins !== "object" || pins === null || Array.isArray(pins)) {
      errors.push({
        code: "pins_shape_invalid",
        message: `pins must be an object mapping role -> pin string, e.g. {"i2c_sda":"GPIO5","led_anode":"GPIO2"}; got ${Array.isArray(pins) ? "array" : typeof pins}.`,
      });
    } else {
      for (const [role, pin] of Object.entries(pins)) {
        // The key is the ROLE and the value must be a pin string. A non-string
        // value means the model inverted or nested the map; name the shape
        // explicitly instead of interpolating "[object Object]".
        if (typeof pin !== "string") {
          errors.push({
            code: "pins_shape_invalid",
            message: `pins["${role}"] must be a pin string (role -> pin), e.g. "${role}":"GPIO5"; got ${typeof pin}. The key is the ROLE and the value is the board pin.`,
          });
          continue;
        }
        if (board?.pin_capabilities) {
          const allowed = board.pin_capabilities[pin] ?? [];
          const ok = allowed.includes(role) || (role === "led_anode" && allowed.includes("gpio_out"));
          if (!ok) {
            const recommended = board.pin_recommendations?.[role];
            const allowedPins = Object.keys(board.pin_capabilities).filter(
              (p) => board.pin_capabilities[p].includes(role) || (role === "led_anode" && board.pin_capabilities[p].includes("gpio_out")),
            );
            const hint = allowedPins.length
              ? `allowed pins for role "${role}": ${allowedPins.join(", ")}${recommended ? ` (recommended ${recommended})` : ""}`
              : `the board profile lists no pin that supports role "${role}"; this board cannot satisfy "${role}"`;
            errors.push({
              code: "pin_role_not_allowed",
              message: `pin ${pin} does not support role "${role}" (pin ${pin} supports: ${allowed.length ? allowed.join(", ") : "nothing"}); ${hint}.`,
            });
          }
        }
      }
    }
  }
  return errors.length ? { valid: false, errors } : { valid: true, errors: [] };
}
