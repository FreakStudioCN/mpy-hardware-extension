import { readFile } from "node:fs/promises";

import { runProtocolBuild, type ProtocolResult } from "./protocol-loop.ts";

type FixtureTool = {
  id?: string;
  name: string;
  input?: any;
  invalidInput?: string;
};

export type ProtocolFixture = {
  intent: string;
  startPhase?: string;
  startManifest?: any;
  script: Record<string, FixtureTool[][]>;
};

export type ProtocolFixtureResult = {
  protocol: ProtocolResult;
  files: Record<string, string>;
  events: any[];
  approvals: any[];
  deviceCalls: Array<{ action: string; payload: any }>;
  scriptRuns: Array<{ interpreter: string; script: string; args: string[] }>;
};

export async function loadProtocolFixtureFile(path: string): Promise<ProtocolFixture> {
  const fixture = JSON.parse(await readFile(path, "utf-8"));
  if (!fixture || typeof fixture !== "object") throw new Error("fixture must be a JSON object");
  if (typeof fixture.intent !== "string") throw new Error("fixture.intent must be a string");
  if (!fixture.script || typeof fixture.script !== "object" || Array.isArray(fixture.script)) {
    throw new Error("fixture.script must be an object keyed by phase");
  }
  return fixture as ProtocolFixture;
}

function scriptedLlm(script: Record<string, FixtureTool[][]>) {
  const idx: Record<string, number> = {};
  return {
    streamMessages: async (body: any) => {
      const phase = String(body.phase ?? "analyze");
      const turns = script[phase] ?? [];
      const turnIndex = idx[phase] ?? 0;
      idx[phase] = turnIndex + 1;
      const tools = turns[turnIndex] ?? [];
      return (async function* () {
        for (let i = 0; i < tools.length; i++) {
          const tool = tools[i];
          yield {
            type: "tool_use_complete",
            id: tool.id ?? `${phase}-${turnIndex}-${i}`,
            name: tool.name,
            input: tool.input ?? {},
            invalidInput: tool.invalidInput,
          };
        }
        yield { type: "message_stop" };
      })();
    },
  };
}

export async function runProtocolFixture(fixture: ProtocolFixture): Promise<ProtocolFixtureResult> {
  const files: Record<string, string> = {};
  const events: any[] = [];
  const approvals: any[] = [];
  const deviceCalls: Array<{ action: string; payload: any }> = [];
  const scriptRuns: Array<{ interpreter: string; script: string; args: string[] }> = [];

  const protocol = await runProtocolBuild(
    {
      intent: fixture.intent,
      startPhase: fixture.startPhase,
      startManifest: fixture.startManifest,
      onEvent: (event) => events.push(event),
      confirmApproval: async (card) => {
        approvals.push(card);
        const selectedIds = [
          ...((card.items ?? []).map((item: any) => item?.id)),
          ...((card.item_groups ?? []).flatMap((group: any) => (group?.items ?? []).map((item: any) => item?.id))),
        ].filter(Boolean);
        const action = card.actions?.find((item: any) => item?.primary)?.value ?? "confirm";
        return { action, selected_ids: selectedIds, added_items: [], text_values: {}, notes: "" };
      },
    },
    {
      llmClient: scriptedLlm(fixture.script),
      writeFile: async (path, content) => {
        files[path] = content;
        return { ok: true, path };
      },
      readFile: async (path) => (
        Object.prototype.hasOwnProperty.call(files, path)
          ? { ok: true, content: files[path] }
          : { ok: false, error_kind: "not_found" }
      ),
      listFiles: async (path) => {
        const prefix = path ? `${path.replace(/\/$/, "")}/` : "";
        const entries = Object.keys(files)
          .filter((name) => name.startsWith(prefix))
          .map((name) => name.slice(prefix.length).split("/")[0])
          .filter((name, i, arr) => name && arr.indexOf(name) === i);
        return { ok: true, entries };
      },
      runScript: async (interpreter, script, args) => {
        scriptRuns.push({ interpreter, script, args });
        return { ok: true, stdout: "", stderr: "", exit_code: 0 };
      },
      device: async (action, payload) => {
        deviceCalls.push({ action, payload });
        return { ok: true, stdout: action === "stream" ? "MPYHW_READY\n" : "" };
      },
    },
  );

  return { protocol, files, events, approvals, deviceCalls, scriptRuns };
}
