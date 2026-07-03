// A no-board device simulator for the offline E2E demo.
//
// It implements the same surface runDeviceLoop() drives on a real DeviceShim
// (installPackage / writeMainPy / flashAndRun / serialReadUntil) so the demo can
// exercise the deploy stage with no hardware attached. It does NOT execute the
// generated MicroPython — it replays the firmware's own serial contract
// (`MPYHW_READY`, then `TEMP_C=<v> LED=<ON|OFF>`) over an illustrative sensor
// sweep, deciding LED state from the REAL threshold in the run's manifest logic.
// Every line is labelled as simulated. Flashing to a real board is the paid path.
type Logic = { threshold_c?: number; action?: string };

// Illustrative sensor readings (°C) — a test vector that crosses the threshold so
// the LED toggles both ways. Not measured data; clearly a simulation input.
const SWEEP_C = [22.5, 26.0, 29.5, 31.2, 33.8, 28.0];

export class DeviceSimulator {
  installed: string[] = [];
  mainPy = "";
  private logic: Logic;

  constructor(logic: Logic = {}) {
    this.logic = logic;
  }

  async installPackage(url: string, _version?: string): Promise<void> {
    this.installed.push(url);
  }

  async writeMainPy(content: string): Promise<void> {
    this.mainPy = content;
  }

  async flashAndRun(_path?: string): Promise<void> {
    // No-op: no board attached. On real hardware this soft-resets and runs main.py.
  }

  async serialReadUntil(_markers: string[]): Promise<{ ok: boolean; lines: string[] }> {
    return { ok: true, lines: this.simulateSerial() };
  }

  // Replays the firmware serial contract for the run's real threshold logic.
  simulateSerial(): string[] {
    const threshold = this.logic.threshold_c ?? 30;
    const lines = ["MPYHW_READY"];
    for (const tempC of SWEEP_C) {
      const on = tempC > threshold;
      lines.push(`TEMP_C=${tempC.toFixed(1)} LED=${on ? "ON" : "OFF"}`);
    }
    return lines;
  }
}
