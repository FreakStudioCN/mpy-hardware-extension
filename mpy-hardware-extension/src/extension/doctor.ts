// Environment preflight ("doctor") orchestration. Pure logic over injected probes so
// it unit-tests without a real Python/board: panel.ts binds the real device-shim probes
// (detectPython / venvReady / DeviceShim.scan / DeviceShim.probeMicroPython) and the
// webview renders the structured results. Emits i18n KEYS + raw error_kinds — the webview
// owns the human-readable text (and the error_kind → friendly-message map).

export type DoctorStatus = "ok" | "warn" | "error";

export interface DoctorResult {
  id: "python" | "deps" | "device" | "micropython";
  status: DoctorStatus;
  messageKey: string;
  detail?: string;
  errorKind?: string;
  action?: "install_deps";
  link?: string;
  ports?: string[];
}

export interface DoctorDeps {
  detectPython: () => { ok: boolean; version?: string };
  venvReady: () => boolean;
  scan: () => Promise<string[]>;
  probeMicroPython: (port: string) => Promise<boolean>;
  board?: string; // matched board slug, for the firmware download link
}

const PYTHON_DOWNLOAD = "https://www.python.org/downloads/";

function firmwareLink(board?: string): string {
  // micropython.org/download/<board>/ is the per-board firmware page; fall back to the
  // index when we don't have a matched board slug.
  return board ? `https://micropython.org/download/${board}/` : "https://micropython.org/download/";
}

export async function runDoctor(deps: DoctorDeps, opts: { probe?: boolean } = {}): Promise<DoctorResult[]> {
  const results: DoctorResult[] = [];

  const python = deps.detectPython();
  results.push(
    python.ok
      ? { id: "python", status: "ok", messageKey: "doc_python_ok", detail: python.version }
      : { id: "python", status: "error", messageKey: "doc_python_missing", errorKind: "python_not_found", link: PYTHON_DOWNLOAD },
  );

  const depsReady = python.ok && deps.venvReady();
  if (!python.ok) {
    // Installing deps needs Python, so don't offer the button — point at Python first.
    results.push({ id: "deps", status: "warn", messageKey: "doc_deps_blocked" });
  } else if (depsReady) {
    results.push({ id: "deps", status: "ok", messageKey: "doc_deps_ok" });
  } else {
    results.push({ id: "deps", status: "error", messageKey: "doc_deps_missing", errorKind: "shim_dependency_install_failed", action: "install_deps" });
  }

  // scan() and probeMicroPython() drive the shim, which lazily bootstraps the venv on
  // first touch — a slow/blocking install. Skip both until deps are confirmed ready.
  if (!depsReady) {
    results.push({ id: "device", status: "warn", messageKey: "doc_blocked_deps" });
    results.push({ id: "micropython", status: "warn", messageKey: "doc_blocked_deps" });
    return results;
  }

  // A failed scan (mpremote timeout, shim crash, driver fault) must still resolve with
  // items — otherwise the panel never posts results and the Environment tab spins forever.
  let ports: string[];
  try {
    ports = await deps.scan();
  } catch {
    results.push({ id: "device", status: "warn", messageKey: "doc_device_error", errorKind: "device_scan_failed" });
    results.push({ id: "micropython", status: "warn", messageKey: "doc_mpy_need_device" });
    return results;
  }
  if (ports.length === 0) {
    results.push({ id: "device", status: "warn", messageKey: "doc_device_none", errorKind: "device_unavailable" });
    results.push({ id: "micropython", status: "warn", messageKey: "doc_mpy_need_device" });
    return results;
  }
  if (ports.length > 1) {
    results.push({ id: "device", status: "warn", messageKey: "doc_device_multiple", errorKind: "device_selection_required", ports });
    results.push({ id: "micropython", status: "warn", messageKey: "doc_mpy_need_port" });
    return results;
  }

  results.push({ id: "device", status: "ok", messageKey: "doc_device_ok", detail: ports[0] });
  // The probe enters the board's raw REPL, which interrupts any running program. That's
  // too invasive to do automatically on every panel load, so it's opt-in (the Re-check
  // button) — a default run just reports the board is connected.
  if (!opts.probe) {
    results.push({ id: "micropython", status: "warn", messageKey: "doc_mpy_recheck" });
    return results;
  }
  let hasMpy: boolean;
  try {
    hasMpy = await deps.probeMicroPython(ports[0]);
  } catch {
    results.push({ id: "micropython", status: "warn", messageKey: "doc_mpy_probe_failed", errorKind: "no_micropython" });
    return results;
  }
  results.push(
    hasMpy
      ? { id: "micropython", status: "ok", messageKey: "doc_mpy_ok" }
      : { id: "micropython", status: "warn", messageKey: "doc_mpy_missing", errorKind: "no_micropython", link: firmwareLink(deps.board) },
  );

  return results;
}
