// Derive a planned-architecture diagram { architecture: { layers[] }, flow[] }
// (the subset the webview Diagram tab renders) from a rich upstream
// project-manifest's devices[] + mcu. Deterministic and always-on, exactly like
// deriveWiring: the tab populates the moment the manifest has devices, instead of
// waiting for an LLM-authored docs/diagram.json that the pipeline never writes.
//
// This is a planned view (MCU -> devices -> entry + a generic init/scan/create/run
// flow), NOT real code modules. Data here is language-neutral (ids + identifiers);
// the webview localizes layer/flow labels the same way it localizes wiring labels.

// device.interface (uppercased) -> whether it sits on a shared bus. Anything not
// here is a direct-GPIO standalone part.
const BUS_INTERFACES: Record<string, boolean> = {
  I2C: true, SPI: true, UART: true, I2S: true, CAN: true, "1-WIRE": true, ONEWIRE: true,
};

function isI2c(iface: string): boolean {
  return iface === "I2C";
}

// Board/MCU display name: rich manifests carry it under mcu.board/mcu.model (no
// board_id); fall back to board_id for the legacy shape. Mirrors wiringMarkup.
function boardName(manifest: any): string {
  const mcu = manifest?.mcu;
  return String((mcu && (mcu.board || mcu.model)) || manifest?.board_id || "").trim();
}

export function deriveDiagram(manifest: any): { architecture: { layers: any[] }; flow: any[] } {
  const devices: any[] = Array.isArray(manifest?.devices) ? manifest.devices : [];
  // Empty guard (mirror deriveWiring's {buses:[],standalone:[]}): no devices means
  // nothing meaningful to show, so the tab correctly stays in its empty state.
  if (!devices.length) return { architecture: { layers: [] }, flow: [] };

  const driverModules = devices.map((d) => {
    const name = String(d?.name ?? "").trim() || "device";
    const iface = String(d?.interface ?? "").trim();
    const type = String(d?.type ?? "").trim();
    const mod: any = { name };
    if (iface) mod.role = iface;
    if (type) mod.path = type;
    return mod;
  });

  // Top -> bottom in the UI: entry on top, board at the bottom.
  const layers: any[] = [
    { id: "entry", modules: [{ name: "main.py" }] },
    { id: "driver", modules: driverModules },
  ];
  const board = boardName(manifest);
  if (board) layers.push({ id: "board", modules: [{ name: board, role: "MCU" }] });

  // Distinct bus interface tokens (e.g. "I2C", "SPI") in first-seen order.
  const busTokens: string[] = [];
  for (const d of devices) {
    const iface = String(d?.interface ?? "").toUpperCase();
    if (BUS_INTERFACES[iface]) {
      const token = String(d?.interface ?? "").trim();
      if (token && !busTokens.includes(token)) busTokens.push(token);
    }
  }
  const i2cNames = devices
    .filter((d) => isI2c(String(d?.interface ?? "").toUpperCase()))
    .map((d) => String(d?.name ?? "").trim())
    .filter(Boolean);
  const deviceNames = devices.map((d) => String(d?.name ?? "").trim()).filter(Boolean);

  const flow: any[] = [];
  if (busTokens.length) flow.push({ phase: "init", detail: busTokens.join(" · ") });
  if (i2cNames.length) flow.push({ phase: "scan", detail: i2cNames.join(", ") });
  flow.push({ phase: "create", detail: deviceNames.join(", ") });
  flow.push({ phase: "run" });

  return { architecture: { layers }, flow };
}
