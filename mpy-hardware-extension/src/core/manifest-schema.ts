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
  // Wiring: the device-identity object { buses[], standalone[] } (upstream
  // wiring.schema). A legacy flat [{role,pin}] array is still accepted. The
  // gpios named in wiring must be allocated in pins — wiring mirrors pins, it
  // never introduces a pin of its own.
  const wiring = manifest?.wiring;
  if (wiring !== undefined && wiring !== null && !Array.isArray(wiring)) {
    if (typeof wiring !== "object") {
      errors.push({
        code: "wiring_shape_invalid",
        message: `wiring must be an object with buses[]/standalone[] (or a legacy [{role,pin}] array); got ${typeof wiring}.`,
      });
    } else {
      const allocated = new Set(
        pins && typeof pins === "object" && !Array.isArray(pins)
          ? (Object.values(pins).filter((v) => typeof v === "string") as string[])
          : [],
      );
      const wiringPins: string[] = [];
      if (wiring.buses !== undefined) {
        if (!Array.isArray(wiring.buses)) {
          errors.push({ code: "wiring_shape_invalid", message: `wiring.buses must be an array of buses; got ${typeof wiring.buses}.` });
        } else {
          for (const bus of wiring.buses) {
            for (const sig of bus?.signals ?? []) {
              if (typeof sig?.gpio === "string") wiringPins.push(sig.gpio);
            }
          }
        }
      }
      if (wiring.standalone !== undefined) {
        if (!Array.isArray(wiring.standalone)) {
          errors.push({ code: "wiring_shape_invalid", message: `wiring.standalone must be an array; got ${typeof wiring.standalone}.` });
        } else {
          for (const part of wiring.standalone) {
            if (typeof part?.pin === "string") wiringPins.push(part.pin);
          }
        }
      }
      if (allocated.size) {
        for (const gpio of wiringPins) {
          if (!allocated.has(gpio)) {
            errors.push({
              code: "wiring_pin_mismatch",
              message: `wiring references pin ${gpio} that is not allocated in pins; wiring must mirror pins.`,
            });
          }
        }
      }
    }
  }
  return errors.length ? { valid: false, errors } : { valid: true, errors: [] };
}
