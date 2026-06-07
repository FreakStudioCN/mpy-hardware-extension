import canonicalToolContract from "../../../contracts/canonical_tools.json" with { type: "json" };

export const CANONICAL_TOOLS = canonicalToolContract.map((tool) => tool.name);

const ROUTES: Record<string, "local" | "api" | "shim" | "ui"> = {
  query_board_profile: "local",
  propose_manifest: "local",
  audit_code: "local",
  get_phase_profile: "local",
  generate_code: "local",
  read_workspace_file: "local",
  write_project_file: "local",
  search_packages: "api",
  resolve_package_candidates: "api",
  get_package_context: "api",
  scan_device: "shim",
  install_package: "shim",
  write_main_py: "shim",
  flash_and_run: "shim",
  read_serial_until: "shim",
  run_validate: "shim",
  run_scaffold: "shim",
  run_download_drivers: "shim",
  run_static_check: "shim",
  run_simulate: "shim",
  run_triage: "shim",
  run_hardware_sanity: "shim",
  run_extract_pdf: "shim",
  run_flash_device: "shim",
  render_wiring: "shim",
  render_diagram: "shim",
  ask_user: "ui",
};

export function routeForTool(name: string) {
  return ROUTES[name];
}
