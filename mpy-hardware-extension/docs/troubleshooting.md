# Troubleshooting

## No Device

Use `.\scripts\smoke-hardware.ps1 -Port COM3` with the correct port. If no port is listed, install the USB serial driver and reconnect the board.

## I2C Device Not Found

Check AHT20 power, GPIO5 SDA, GPIO6 SCL, and common ground. Confirm the sensor uses 3.3V logic.

## Package Install Failed

Check network access. The generated manifest includes the `package_json_url` used by `mpremote mip install`.

## Port Busy

Close Thonny, serial monitors, and other VS Code windows that may hold the same COM port.
