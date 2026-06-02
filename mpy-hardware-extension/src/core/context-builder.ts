const MAX_CONTEXT_CHARS = 2200;
const MAX_MARKER_CHARS = 400;

export function buildSystemContext(input: { state: any; content: any }) {
  const parts: string[] = [];
  for (const skill of input.content.foundationalSkills ?? []) {
    parts.push(`# ${skill.name}\n${skill.body}`);
  }
  for (const skillName of input.state.loadedSkills ?? []) {
    const body = input.content.taskSkills?.[skillName];
    if (body) parts.push(`# ${skillName}\n${body}`);
  }
  parts.push(`Board: ${JSON.stringify(input.content.boardProfile)}`);
  parts.push(`Package index: ${JSON.stringify(input.content.packageIndex)}`);
  parts.push(`Tools: ${(input.content.tools ?? []).map((tool: any) => tool.name).join(", ")}`);
  if (input.state.lastRuntimeMarker) {
    parts.push(`Runtime tail: ${String(input.state.lastRuntimeMarker).slice(-MAX_MARKER_CHARS)}`);
  }
  const text = parts.join("\n\n").slice(0, MAX_CONTEXT_CHARS);
  return [{ type: "text", text }];
}
