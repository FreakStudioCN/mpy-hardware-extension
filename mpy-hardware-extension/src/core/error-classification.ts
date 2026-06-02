export function classifyError(input: string) {
  const text = input.toLowerCase();
  if (text.includes("importerror") || text.includes("no module named")) {
    return result("package_import_error", "IMPORT_ERROR", "Install the selected package or choose another driver context.");
  }
  if (text.includes("errno 19") || text.includes("enodev")) {
    return result("i2c_device_not_found", "I2C_ENODEV", "Check SDA/SCL wiring, power, and sensor address.");
  }
  if (text.includes("permission denied") || text.includes("access is denied") || text.includes("busy")) {
    return result("port_busy", "SERIAL_PORT_BUSY", "Close other serial tools and retry.");
  }
  if (text.includes("no serial ports") || text.includes("port not found")) {
    return result("device_not_found", "SERIAL_DEVICE_NOT_FOUND", "Connect the board and install the USB serial driver.");
  }
  if (text.includes("network") && text.includes("install")) {
    return result("package_install_network", "PACKAGE_INSTALL_NETWORK", "Check network access or install the package manually.");
  }
  if (text.includes("manifest") && text.includes("validation")) {
    return result("manifest_invalid", "MANIFEST_INVALID", "Regenerate the manifest with valid board pins and package context.");
  }
  return result("unknown_error", "UNKNOWN", "Review the trace and retry with a smaller hardware goal.");
}

function result(category: string, diagnostic_code: string, next_action: string) {
  return { category, diagnostic_code, next_action };
}
