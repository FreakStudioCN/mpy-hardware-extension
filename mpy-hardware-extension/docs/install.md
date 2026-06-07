# Install

## Requirements

- Windows or macOS with VS Code.
- Python 3.10 or newer on PATH or configured in the extension.
- `mpremote` and `pyserial` installed in the extension-managed Python environment.
- For the demo: ESP32-S3 DevKitC-1 with MicroPython firmware.

## Local Development Check

```powershell
npm test
npm run typecheck
npm run smoke:extension
```

`npm run package` writes `build/mpy-hardware-extension-0.2.0.vsix`.
