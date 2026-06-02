import canonicalToolContract from "../../../contracts/canonical_tools.json" with { type: "json" };

export const CANONICAL_TOOLS = canonicalToolContract.map((tool) => tool.name);

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
