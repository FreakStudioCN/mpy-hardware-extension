// The extension half of the plugin-interface protocol. Both sides import the same
// contract (contracts/protocol_messages.json). The LLM emits 6 generic protocol
// "tools"; this maps each to the executor lane that runs it on the user's machine.
import protocol from "../../../contracts/protocol_messages.json" with { type: "json" };

export const PROTOCOL_VERSION: string = (protocol as any).protocol_version;

// The 6 tools we offer the model, with their input schemas (the message payloads).
export const PROTOCOL_TOOLS: Array<{ name: string; description: string; input_schema: any }> =
  ((protocol as any).llm_tools as string[]).map((name) => ({
    name,
    description: (protocol as any).messages[name]?.description ?? "",
    input_schema: (protocol as any).messages[name]?.payload_schema ?? { type: "object" },
  }));

export const PROTOCOL_TOOL_NAMES = new Set(PROTOCOL_TOOLS.map((t) => t.name));

// name -> "blocking" | "notify". Notify tools (status_update, phase_complete) are
// rendered and auto-acked; they never block on a user/device round-trip.
export const PROTOCOL_TOOL_KINDS: Record<string, "blocking" | "notify"> = (protocol as any).llm_tool_kinds;

export type ProtocolRoute = "device" | "fs" | "host" | "ui" | "notify";

const ROUTES: Record<string, ProtocolRoute> = {
  device_command: "device",
  file_operation: "fs",
  script_run: "host",
  approval_request: "ui",
  status_update: "notify",
  phase_complete: "notify",
};

export function routeForTool(name: string): ProtocolRoute | undefined {
  return ROUTES[name];
}
