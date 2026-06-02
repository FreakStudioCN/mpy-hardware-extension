const SERIAL_TAIL_LIMIT = 20;

export function normalizeObservation(toolName: string, output: any) {
  const observation: any = {
    tool: toolName,
    ok: output?.ok !== false,
    output: { ...output },
    truncated: false,
  };
  if (output?.error_kind) {
    observation.error_kind = output.error_kind;
  }
  if (Array.isArray(output?.lines) && output.lines.length > SERIAL_TAIL_LIMIT) {
    observation.output.lines = output.lines.slice(-SERIAL_TAIL_LIMIT);
    observation.truncated = true;
  }
  return observation;
}

export function toToolResultBlock(toolUseId: string, observation: any) {
  return {
    type: "tool_result",
    tool_use_id: toolUseId,
    content: JSON.stringify(observation),
  };
}
