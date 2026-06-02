import { routeForTool } from "./tool-registry.ts";

export async function dispatchTool(tool: { name: string; input: any }, executors: any) {
  const route = routeForTool(tool.name);
  if (!route) {
    return { ok: false, error_kind: "UnknownToolError", message: `Unknown tool: ${tool.name}` };
  }
  const executor = executors[route];
  if (!executor) {
    return { ok: false, error_kind: "executor_missing", message: `Missing executor: ${route}` };
  }
  return executor(tool.name, tool.input);
}
