# Upstream change requests (third_party/MicroPython_Skills is read-only here)

Collected during Phase A. Report these through the upstream flow; do not edit the submodule.

## 1. Analyze-format board definitions wanted (blocks more full profiles)
`upy-analyze-plugin/boards/` today ships 7 boards. To promote these to
`builtin_pin_layout` we need upstream definitions for: ESP32-S2, ESP32-C6,
Pico 2 (RPI_PICO2), Pico 2 W, LuatOS/合宙 ESP32-C3 core board, Waveshare Pico
series.

## 2. `check_mpy_imports.py` allowlist
If future confirmed-safe modules trip `MPY_IMPORT_UNSUPPORTED`, widen
`MPY_ALLOWED` upstream. Phase A's host-side fix (deterministic firmware/tools
removal) removes the only recurring false positive (subprocess in
scaffold-dropped host helpers) without touching the gate.

## 3. m5stack-core firmware mapping is wrong
`upy-analyze-plugin/boards/m5stack-core.json` declares
`firmware.board_name = "M5STACK_ATOM"` (and the ATOM download URL) for a board
titled "M5Stack Core (ESP32)". Core and Atom are different devices; the mapping
would flash wrong firmware. Until corrected upstream, m5stack-core stays out of
the full-profile catalog.

## 4. esp8266-nodemcu I2C default pins look swapped
`upy-analyze-plugin/boards/esp8266-nodemcu.json` declares
`default_bus_pins.i2c0 = {sda: 5, scl: 4}`. Both the Arduino-core NodeMCU
convention and MicroPython's documented ESP8266 default
(`machine.I2C(scl=Pin(5), sda=Pin(4))`) say the opposite (sda=4, scl=5), and
this is the only board file whose sda/scl pairing contradicts the other
sources. ESP8266 I2C is software-driven so either pairing works when code is
internally consistent, but the served profile `esp8266-nodemcu.json` currently
transcribes the upstream values verbatim — if upstream corrects the file, the
served profile must be updated to match.
