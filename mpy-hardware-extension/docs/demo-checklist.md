# Demo Checklist

- Board: ESP32-S3 DevKitC-1.
- Firmware: MicroPython 1.21 or newer.
- Wiring: AHT20 VIN to 3V3, GND to GND, SDA to GPIO5, SCL to GPIO6, LED anode to GPIO2 through a resistor, LED cathode to GND.
- UI: open `mpyhw.openPanel`, select device, enter `超过30度亮红灯`, start session.
- Expected artifacts: `main.py` and `manifest.json`.
- Expected serial markers: `MPYHW_READY`, `TEMP_C=`, `LED=`.
- Expected behavior: LED turns on when temperature is above threshold.
- Common classifications: `package_import_error`, `i2c_device_not_found`, `port_busy`, `device_not_found`, `package_install_network`, `manifest_invalid`.
