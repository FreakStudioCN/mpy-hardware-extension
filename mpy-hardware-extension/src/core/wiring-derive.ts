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

export function deriveWiring(manifest: any): { buses: any[]; standalone: any[] } {
  const devices: any[] = Array.isArray(manifest?.devices) ? manifest.devices : [];
  const pinout: any[] = Array.isArray(manifest?.pinout) ? manifest.pinout : [];
  const buses: any[] = [];
  const standalone: any[] = [];
  const busByType = new Map<string, any>();

  const ensureBus = (type: string) => {
    let bus = busByType.get(type);
    if (!bus) {
      bus = { type, id: `${type.toUpperCase()}${busByType.size}`, signals: [], devices: [] };
      busByType.set(type, bus);
      buses.push(bus);
    }
    return bus;
  };

  // 1) Shared bus signals from the pinout (SDA/SCL/MOSI/...). Bus type comes from the
  //    owning device's interface when known, else inferred from the signal role.
  const ifaceByDevice = new Map(devices.map((d) => [String(d?.name ?? ""), String(d?.interface ?? "").toUpperCase()]));
  for (const entry of pinout) {
    const role = signalRoleFromPinName(entry?.pin_name);
    if (!role) continue;
    const iface = ifaceByDevice.get(String(entry?.device ?? "")) ?? "";
    const type = BUS_INTERFACES[iface] ?? busTypeForRole(role);
    const bus = ensureBus(type);
    const gpio = String(entry?.gpio ?? "");
    if (gpio && !bus.signals.some((s: any) => s.role === role && s.gpio === gpio)) {
      bus.signals.push({ role, gpio });
    }
  }

  // 2) One entry per device: bus devices carry their identity (name + I2C addr),
  //    standalone parts carry their single pin + GPIO type.
  for (const device of devices) {
    const iface = String(device?.interface ?? "").toUpperCase();
    const type = BUS_INTERFACES[iface];
    if (type) {
      const bus = ensureBus(type);
      const addr = Array.isArray(device?.i2c_addr) ? device.i2c_addr[0] : undefined;
      bus.devices.push({
        name: String(device?.name ?? "device"),
        type: String(device?.type ?? ""),
        ...(addr ? { addr: String(addr) } : {}),
      });
    } else {
      const entry = pinout.find((p) => String(p?.device ?? "") === String(device?.name ?? ""));
      const gpioType = iface === "PWM" ? "pwm" : iface === "ADC" ? "adc" : "gpio_out";
      standalone.push({ name: String(device?.name ?? "part"), pin: String(entry?.gpio ?? ""), type: gpioType });
    }
  }

  return { buses, standalone };
}
