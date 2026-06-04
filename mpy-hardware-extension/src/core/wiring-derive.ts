// Derive the device-identity wiring object { buses[], standalone[] } (the upstream
// wiring.schema subset the webview renders) from a rich upstream project-manifest's
// devices[] + pinout[]. The invariant that kills the phantom-card bug: ONE physical
// device = exactly ONE entry (a bus device or a standalone part) — never a per-pin
// row that splits one part across cards.

// device.interface -> bus type. Anything not here is a direct-GPIO standalone part.
const BUS_INTERFACES: Record<string, string> = {
  I2C: "i2c", SPI: "spi", UART: "uart", I2S: "i2s", CAN: "can", "1-WIRE": "onewire", ONEWIRE: "onewire",
};
// Bus signal roles we can recognise inside a pinout pin_name (e.g. "I2C0 SDA").
const SIGNAL_ROLES = ["SDA", "SCL", "MOSI", "MISO", "SCK", "CS", "TX", "RX", "DQ"];

function signalRoleFromPinName(pinName: any): string | null {
  const up = String(pinName ?? "").toUpperCase();
  for (const role of SIGNAL_ROLES) if (up.includes(role)) return role;
  return null;
}

function busTypeForRole(role: string): string {
  if (role === "SDA" || role === "SCL") return "i2c";
  if (role === "MOSI" || role === "MISO" || role === "SCK" || role === "CS") return "spi";
  if (role === "TX" || role === "RX") return "uart";
  if (role === "DQ") return "onewire";
  return "i2c";
}

// Bus identity token inside a pinout pin_name, e.g. "I2C0 SDA" -> "I2C0", "SPI1 MOSI"
// -> "SPI1". This is what separates two physical buses of the same type (I2C0 vs
// I2C1). A bare role ("SDA") or a standalone pin ("GP2") has no token -> null.
function busTokenFromPinName(pinName: any): string | null {
  const m = String(pinName ?? "").toUpperCase().match(/\b(I2C|SPI|UART|I2S|CAN)\s*(\d+)/);
  return m ? `${m[1]}${m[2]}` : null;
}

export function deriveWiring(manifest: any): { buses: any[]; standalone: any[] } {
  const devices: any[] = Array.isArray(manifest?.devices) ? manifest.devices : [];
  const pinout: any[] = Array.isArray(manifest?.pinout) ? manifest.pinout : [];
  const buses: any[] = [];
  const standalone: any[] = [];
  const busByKey = new Map<string, any>();
  // Per-type counter so a synthetic (token-less) bus id starts at 0 for each type
  // (the sole SPI bus is SPI0, not "SPI<global-index>").
  const typeCount: Record<string, number> = {};

  const ifaceByDevice = new Map(devices.map((d) => [String(d?.name ?? ""), String(d?.interface ?? "").toUpperCase()]));
  const pinsForDevice = (name: string) => pinout.filter((p) => String(p?.device ?? "") === name);

  // A bus is keyed by its real pin_name token (I2C0) when present, else collapsed to
  // one synthetic bus per type. ensureBus assigns a stable id the same way.
  const ensureBus = (key: string, type: string) => {
    let bus = busByKey.get(key);
    if (!bus) {
      const id = /\d/.test(key) ? key.toUpperCase() : `${type.toUpperCase()}${typeCount[type] = typeCount[type] ?? 0}`;
      bus = { type, id, signals: [], devices: [] };
      busByKey.set(key, bus);
      buses.push(bus);
    }
    return bus;
  };

  // Bus key+type a device belongs to: the token from its own pinout rows when known,
  // else the type itself. Shared by the signal pass and the device pass so they agree.
  const busKeyForDevice = (name: string, type: string) => {
    for (const row of pinsForDevice(name)) {
      const token = busTokenFromPinName(row?.pin_name);
      if (token) return token;
    }
    return type;
  };

  // 1) Shared bus signals from the pinout (SDA/SCL/MOSI/...). A KNOWN standalone
  //    device never contributes a signal (its pin_name may coincidentally contain a
  //    role substring); only bus devices (or unknown owners) do.
  for (const entry of pinout) {
    const role = signalRoleFromPinName(entry?.pin_name);
    if (!role) continue;
    const owner = String(entry?.device ?? "");
    const iface = ifaceByDevice.get(owner);
    if (iface !== undefined && BUS_INTERFACES[iface] === undefined) continue; // known standalone part
    const type = (iface && BUS_INTERFACES[iface]) ?? busTypeForRole(role);
    const token = busTokenFromPinName(entry?.pin_name);
    const bus = ensureBus(token ?? type, type);
    const gpio = String(entry?.gpio ?? "");
    if (gpio && !bus.signals.some((s: any) => s.role === role && s.gpio === gpio)) {
      bus.signals.push({ role, gpio });
    }
  }

  // 2) One entry per device: bus devices carry their identity (name + I2C addr) on
  //    their bus; standalone parts carry ALL their pins + a GPIO type.
  for (const device of devices) {
    const name = String(device?.name ?? "");
    const iface = String(device?.interface ?? "").toUpperCase();
    const type = BUS_INTERFACES[iface];
    if (type) {
      const bus = ensureBus(busKeyForDevice(name, type), type);
      const addr = Array.isArray(device?.i2c_addr) ? device.i2c_addr[0] : undefined;
      bus.devices.push({
        name: name || "device",
        type: String(device?.type ?? ""),
        ...(addr ? { addr: String(addr) } : {}),
      });
    } else {
      const gpios = pinsForDevice(name).map((p) => String(p?.gpio ?? "")).filter(Boolean);
      const gpioType = iface === "PWM" ? "pwm" : iface === "ADC" ? "adc" : "gpio_out";
      const entry: any = { name: name || "part", pin: gpios[0] ?? "", type: gpioType };
      // Multi-pin parts (HX711, stepper, RGB LED) keep every pin so none is dropped;
      // single-pin parts stay { name, pin, type } for the common case.
      if (gpios.length > 1) entry.pins = pinsForDevice(name).filter((p) => p?.gpio).map((p) => ({ name: String(p?.pin_name ?? ""), gpio: String(p?.gpio ?? "") }));
      standalone.push(entry);
    }
  }

  return { buses, standalone };
}
