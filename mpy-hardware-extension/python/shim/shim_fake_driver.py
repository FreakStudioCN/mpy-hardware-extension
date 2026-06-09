"""Test driver: run the REAL serve.py stdin/stdout JSON-RPC loop with a Shim
whose hardware boundary (mpremote subprocess + pyserial) is faked.

Spawned by test/shim-roundtrip.test.ts to exercise the genuine cross-process
contract (newline framing, _dispatch routing, param keys, response shapes)
without needing mpremote, a serial port, or a real board.
"""
import subprocess
import sys

from serve import Shim, main


def _fake_runner(command, **_kwargs):
    # serve.py shells out to mpremote via subprocess.run; return canned output
    # shaped like the real CLI so _dispatch/parse_scan_output behave normally.
    if command and command[0] == sys.executable:
        # An upstream toolchain script run ([python, script, *args]). Echo the
        # command so the round-trip can assert the resolved script path + args
        # threaded across the boundary, without executing the real script.
        return subprocess.CompletedProcess(command, 0, " ".join(command), "")
    if "list" in command:
        stdout = "COM3 303A:1001 MicroPython\n"
    elif "exec" in command:
        # A live MicroPython REPL echoes whatever the exec'd print emits.
        stdout = "mpy-ok\r\n"
    else:
        stdout = ""
    return subprocess.CompletedProcess(command, 0, stdout, "")


class _FakeSerial:
    def __init__(self, *_args, **_kwargs):
        self._lines = [b"MPYHW_READY\n", b"TEMP_C=31.2 LED=ON\n"]

    def __enter__(self):
        return self

    def __exit__(self, *_exc):
        return False

    def readline(self):
        return self._lines.pop(0) if self._lines else b""


if __name__ == "__main__":
    main(Shim(runner=_fake_runner, serial_factory=_FakeSerial))
