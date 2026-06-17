import { loadProtocolFixtureFile, runProtocolFixture } from "../core/protocol-fixture.ts";

const fixturePath = process.argv[2] ?? "test/fixtures/protocol-smoke.json";
const fixture = await loadProtocolFixtureFile(fixturePath);
const result = await runProtocolFixture(fixture);

const phaseText = result.protocol.phases
  .map((phase) => `${phase.phase}:${phase.result ?? "stalled"}`)
  .join(" -> ");
const filePaths = Object.keys(result.files).sort();

console.log(`terminal=${result.protocol.terminal}`);
console.log(`phases=${phaseText || "(none)"}`);
console.log(`files=${filePaths.length ? filePaths.join(",") : "(none)"}`);
console.log(`approvals=${result.approvals.length}`);
console.log(`device_calls=${result.deviceCalls.map((call) => call.action).join(",") || "(none)"}`);
console.log(`script_runs=${result.scriptRuns.map((run) => run.script).join(",") || "(none)"}`);

if (result.protocol.terminal !== "complete") {
  process.exitCode = 1;
}
