import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadProtocolFixtureFile, runProtocolFixture } from "../src/core/protocol-fixture.ts";

test("protocol fixture drives the plugin executor without backend, DB, or LLM", async () => {
  const result = await runProtocolFixture({
    intent: "make a temperature alarm",
    script: {
      analyze: [
        [
          {
            name: "approval_request",
            input: {
              approval_id: "device_confirm",
              question: "Confirm parts?",
              items: [{ id: "sht30", name: "SHT30", selected: true }],
              actions: [{ label: "Confirm", value: "confirm", primary: true }],
            },
          },
        ],
        [
          { name: "status_update", input: { level: "info", message: "Parts confirmed" } },
          {
            name: "phase_complete",
            input: {
              result: "success",
              summary: "Analysis complete",
              next_phase: "generate",
              manifest_content: { phase: "analyze", devices: [{ name: "SHT30" }] },
            },
          },
        ],
      ],
      generate: [
        [
          {
            name: "file_operation",
            input: {
              op_id: "write-main",
              op: "write",
              path: "firmware/main.py",
              content: "print('MPYHW_READY')\n",
            },
          },
          {
            name: "phase_complete",
            input: {
              result: "success",
              summary: "Code written",
              next_phase: null,
              manifest_content: { phase: "generate" },
            },
          },
        ],
      ],
    },
  });

  assert.equal(result.protocol.terminal, "complete");
  assert.deepEqual(result.protocol.phases, [
    { phase: "analyze", result: "success" },
    { phase: "generate", result: "success" },
  ]);
  assert.equal(result.files["firmware/main.py"], "print('MPYHW_READY')\n");
  assert.ok(result.events.some((event) => event.type === "status_update"));
  assert.ok(result.approvals.some((approval) => approval.approval_id === "device_confirm"));
});

test("protocol fixture can be loaded from a JSON file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mpyhw-protocol-fixture-"));
  const path = join(dir, "fixture.json");
  await writeFile(path, JSON.stringify({ intent: "x", script: { analyze: [] } }), "utf-8");

  const fixture = await loadProtocolFixtureFile(path);

  assert.equal(fixture.intent, "x");
  assert.deepEqual(fixture.script, { analyze: [] });
});
