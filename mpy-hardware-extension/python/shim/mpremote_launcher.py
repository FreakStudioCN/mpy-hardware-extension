"""Run mpremote with a settle delay for boards that RESET when the port is opened.

Why this exists. A USB-serial bridge (CP210x, CH340, FTDI) drives the ESP32 auto-reset
circuit, so opening the port reboots the chip. mpremote opens the port and immediately
writes `\\r\\x03` then `\\r\\x01` (transport_serial.py enter_raw_repl). Those bytes land while
the ROM bootloader is still running, so the board comes up in the FRIENDLY repl, mpremote
never sees "raw REPL; CTRL-B to exit", and every call fails with "could not enter raw repl".
Measured on an ESP32-WROOM-32 behind a CP2102: the reply to ctrl-C was the ROM log
("mode:DIO, clock div:2 ... entry 0x400805a8"), and the banner arrived after ctrl-A.

mpremote already knows about this hazard, but guards its fix with `os.name == "nt"` and
applies it only to Silicon Labs boards, so macOS and Linux get nothing.

The delay is gated on the USB vendor id: a native-USB board (Pico, ESP32-S3 native) does not
reset on open and must not pay a second and a half on every one of the dozens of mpremote
calls a deploy makes.
"""
import sys
import time

import serial
import serial.tools.list_ports

# USB-serial bridges wired to the auto-reset circuit on common dev boards.
# 10c4 Silicon Labs CP210x, 1a86 WCH CH340/CH341, 0403 FTDI, 067b Prolific PL2303.
RESET_ON_OPEN_VIDS = frozenset({0x10C4, 0x1A86, 0x0403, 0x067B})
# Long enough for the ESP32 ROM bootloader plus MicroPython boot to reach the prompt.
# Measured boot to banner is about 0.5s on the WROOM-32; 1.5s leaves margin for boot.py.
BOOT_SETTLE_SECONDS = 1.5


def resets_on_open(device, ports):
    """True when `device` is behind a USB bridge that reboots the board on port open.

    `ports` is a list of pyserial ListPortInfo (injectable, so this is testable with no
    hardware). An unknown device gets False: a needless delay on every call is worse than
    one failed connect on a board we have not seen.
    """
    for port in ports:
        if getattr(port, "device", None) != device:
            continue
        return getattr(port, "vid", None) in RESET_ON_OPEN_VIDS
    return False


def target_device(argv):
    """The port mpremote was told to use, or None for `connect auto` / no connect."""
    for index, arg in enumerate(argv):
        if arg != "connect" or index + 1 >= len(argv):
            continue
        device = argv[index + 1]
        if device.startswith("port:"):
            device = device[len("port:"):]
        return None if device in ("auto", "list") else device
    return None


def install_settle(device):
    if not resets_on_open(device, list(serial.tools.list_ports.comports())):
        return False
    original_open = serial.Serial.open

    def open_then_settle(self):
        original_open(self)
        time.sleep(BOOT_SETTLE_SECONDS)
        try:
            self.reset_input_buffer()  # drop the ROM log and the friendly banner
        except OSError:
            pass  # a port that cannot flush still gets the settle, which is the point

    serial.Serial.open = open_then_settle
    return True


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    device = target_device(argv)
    if device:
        install_settle(device)
    from mpremote.main import main as mpremote_main

    sys.argv = ["mpremote", *argv]
    return mpremote_main()


if __name__ == "__main__":
    sys.exit(main())
