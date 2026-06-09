"""Cross-process stdio JSON-RPC round-trip against the REAL serve.py loop.

Spawns serve.py's main() (via shim_fake_driver.py, which fakes only the mpremote
subprocess + pyserial boundary) and drives it over real stdin/stdout. This guards
the Python side of the contract that test_shim.py never touches: main()/_dispatch()/
_respond() newline framing, the JSON-RPC envelope, the -32601 unknown-method path,
and that one malformed line does not kill the loop.
"""
import json
import subprocess
import sys
from pathlib import Path

import pytest

SHIM_DIR = Path(__file__).resolve().parent


def _drive(*lines: str) -> list[dict]:
    """Feed raw stdin lines to a fresh serve.py process; return parsed responses."""
    proc = subprocess.Popen(
        [sys.executable, "shim_fake_driver.py"],
        cwd=SHIM_DIR,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
    )
    payload = "".join(line + "\n" for line in lines)
    out, err = proc.communicate(input=payload, timeout=15)
    assert proc.returncode == 0, f"shim exited {proc.returncode}; stderr={err!r}"
    return [json.loads(line) for line in out.splitlines() if line.strip()]


def _req(rid: int, method: str, params: dict | None = None) -> str:
    return json.dumps({"jsonrpc": "2.0", "id": rid, "method": method, "params": params or {}})


@pytest.mark.subprocess
def test_stdio_dispatches_real_methods_with_jsonrpc_envelope():
    responses = _drive(
        _req(1, "device.scan"),
        _req(2, "device.serial_read_until", {"port": "COM3", "markers": ["MPYHW_READY", "TEMP_C="]}),
    )

    by_id = {r["id"]: r for r in responses}
    # Full envelope on a result: jsonrpc + id + the real _dispatch response shape.
    assert by_id[1] == {"jsonrpc": "2.0", "id": 1, "result": {"status": "ok", "devices": [{"port": "COM3"}]}}
    # serial_read_until's markers cross the wire under the real param key + are matched.
    assert by_id[2]["result"] == {"ok": True, "lines": ["MPYHW_READY", "TEMP_C=31.2 LED=ON"]}


@pytest.mark.subprocess
def test_stdio_probe_micropython_rides_the_envelope():
    # The fake board echoes the marker on exec, so the probe confirms a live REPL
    # across the real _dispatch wiring (status + has_micropython in the result shape).
    responses = _drive(_req(1, "device.probe_micropython", {"port": "COM3"}))

    assert responses[0]["result"] == {"status": "ok", "has_micropython": True}


@pytest.mark.subprocess
def test_stdio_unknown_method_and_malformed_line_do_not_kill_the_loop():
    responses = _drive(
        _req(1, "device.totally_unknown"),
        "this is not json {",          # malformed: skipped silently, loop must survive
        _req(2, "device.scan"),         # answered only if the loop kept running
    )

    by_id = {r["id"]: r for r in responses}
    # Unknown method -> JSON-RPC method-not-found, not a crash and not a result.
    assert by_id[1]["error"]["code"] == -32601
    assert "result" not in by_id[1]
    # The loop recovered from the malformed line and answered the next request.
    assert by_id[2]["result"]["status"] == "ok"
    # The malformed line produced no response of its own (exactly two replies).
    assert len(responses) == 2
