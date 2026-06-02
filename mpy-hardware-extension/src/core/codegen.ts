export function generateMainPy(input: { manifest: any; driverContexts: any[] }): { ok: true; code: string } | { ok: false; error: string } {
  const sensor = input.driverContexts.find((context) => context.bus?.includes("i2c") && context.read_properties?.includes("temperature"));
  const led = input.driverContexts.find((context) => context.package?.name === "machine_pin_led" || context.bus?.includes("gpio"));
  if (!sensor || !led) {
    return { ok: false, error: "driver_context_not_generatable" };
  }
  const importName = sensor.import_names?.[0];
  const constructor = sensor.constructors?.[0];
  if (!importName || constructor !== "AHT20(i2c)") {
    return { ok: false, error: "driver_context_not_generatable" };
  }
  const threshold = input.manifest.logic?.threshold_c ?? 30;
  const sda = pinNumber(input.manifest.pins.i2c_sda);
  const scl = pinNumber(input.manifest.pins.i2c_scl);
  const ledPin = pinNumber(input.manifest.pins.led_anode);
  // A pin the board could not allocate (e.g. no led_default recommendation)
  // would otherwise emit `Pin(, Pin.OUT)` — invalid MicroPython. Fail loudly.
  if (!sda || !scl || !ledPin) {
    return { ok: false, error: "manifest_pin_missing" };
  }
  return {
    ok: true,
    code: [
      "from machine import Pin, I2C",
      "import time",
      `import ${importName}`,
      "",
      `i2c = I2C(0, sda=Pin(${sda}), scl=Pin(${scl}))`,
      `sensor = ${importName}.AHT20(i2c)`,
      `led = Pin(${ledPin}, Pin.OUT)`,
      `threshold_c = ${threshold}`,
      "print('MPYHW_READY')",
      "while True:",
      "    temp_c = sensor.temperature",
      "    led.value(1 if temp_c > threshold_c else 0)",
      "    print('TEMP_C={:.1f} LED={}'.format(temp_c, 'ON' if temp_c > threshold_c else 'OFF'))",
      "    time.sleep(1)",
      "",
    ].join("\n"),
  };
}

function pinNumber(pin: string): string {
  return String(pin ?? "").replace(/^GPIO/i, "");
}
