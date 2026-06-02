export const CANONICAL_TOOLS = [
  "query_board_profile",
  "search_packages",
  "resolve_package_candidates",
  "get_package_context",
  "propose_manifest",
  "generate_code",
  "audit_code",
  "load_skill",
  "ask_user",
  "scan_device",
  "install_package",
  "flash_and_run",
  "read_serial_until",
  "write_main_py",
] as const;

const ROUTES: Record<string, "local" | "api" | "shim" | "ui"> = {
  query_board_profile: "local",
  propose_manifest: "local",
  audit_code: "local",
  load_skill: "local",
  generate_code: "local",
  search_packages: "api",
  resolve_package_candidates: "api",
  get_package_context: "api",
  scan_device: "shim",
  install_package: "shim",
  write_main_py: "shim",
  flash_and_run: "shim",
  read_serial_until: "shim",
  ask_user: "ui",
};

export function routeForTool(name: string) {
  return ROUTES[name];
}
