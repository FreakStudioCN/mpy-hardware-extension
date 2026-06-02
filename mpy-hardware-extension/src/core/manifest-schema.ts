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
  if (board?.pin_capabilities && manifest.pins) {
    for (const [role, pin] of Object.entries(manifest.pins)) {
      const allowed = board.pin_capabilities[String(pin)] ?? [];
      if (!allowed.includes(role) && !(role === "led_anode" && allowed.includes("gpio_out"))) {
        errors.push({ code: "pin_role_not_allowed", message: `${role} on ${pin}` });
      }
    }
  }
  return errors.length ? { valid: false, errors } : { valid: true, errors: [] };
}
