import assert from "node:assert/strict";
import test from "node:test";

import { SessionController } from "../src/extension/session-controller.ts";
import { micropythonLibDriver, micropythonLibManifest, thinOptionalRunManifest } from "./micropython-lib-manifest.ts";

// The host's manifest_updated chokepoint is the second place a MicroPython-lib package can
// lose its runtime mip dependency and its API evidence. Two branches have to preserve them:
// the wiring-derive branch (which shallow-copies the manifest to attach derived wiring) and
// the thin-manifest guard (an optional-flow run streams a manifest with no devices and must
// not overwrite the rich one). Nothing downstream re-derives these fields, so whatever the
// chokepoint drops is gone from the webview, the recorded artifact and every later phase.

// Run a scripted loop that emits `events` then finishes, capturing both the posted
// messages and the recorded artifacts.
function controllerWith(loop: any) {
  const posted: any[] = [];
  const recorded: any[] = [];
  const controller = new SessionController({
    postMessage: (m: any) => posted.push(m),
    recorderFactory: () => ({ record: async (e: any) => { recorded.push(e); } }),
    loop,
  });
  return { controller, posted, recorded };
}

const postedManifests = (posted: any[]) => posted.filter((m) => m.type === "manifest_updated").map((m) => m.manifest);
const recordedManifests = (recorded: any[]) => recorded.filter((e) => e.type === "artifact" && e.kind === "manifest").map((e) => e.manifest);

// The three fields the MicroPython-lib contract rides on. Asserted together so a
// regression names which one was dropped.
function assertCarriesEvidence(manifest: any, label: string) {
  const expected = micropythonLibManifest();
  assert.deepEqual(
    manifest?.generate?.runtime_dependencies,
    expected.generate.runtime_dependencies,
    `${label}: the mip runtime dependencies (incl. the micropython_lib entry) must survive`,
  );
  assert.deepEqual(manifest?.generate?.doc_evidence, expected.generate.doc_evidence, `${label}: the API doc evidence must survive`);
  assert.deepEqual(
    manifest?.devices?.find((d: any) => d.driver?.source === "micropython_lib")?.driver,
    micropythonLibDriver(),
    `${label}: the device's MicroPython-lib driver evidence must survive`,
  );
}

test("the wiring-derive branch preserves the mip dependencies and API evidence in both the posted manifest and the recorded artifact", async () => {
  // The generate manifest carries no renderable wiring, so the chokepoint takes the
  // shallow-copy-and-derive branch. Rebuilding the manifest from the fields the Wiring tab
  // happens to need would silently drop everything else on it.
  const { controller, posted, recorded } = controllerWith(async ({ onEvent }: any) => {
    onEvent({ type: "manifest_updated", manifest: micropythonLibManifest() });
    return { terminal: "generated" };
  });

  await controller.start({ intent: "ble beacon", boardId: "esp32-c3-devkitm-1" });

  const [postedManifest] = postedManifests(posted);
  assert.ok(postedManifest, "the chokepoint posts the manifest to the webview");
  assert.ok(Array.isArray(postedManifest.wiring?.buses), "this manifest took the derive branch (that is the branch under test)");
  assertCarriesEvidence(postedManifest, "posted manifest");
  assertCarriesEvidence(recordedManifests(recorded).at(-1), "recorded artifact");
});

test("a later thin optional-run manifest does not erase the mip dependencies and API evidence of the rich one", async () => {
  // A diagram/wiring optional run streams a manifest with no devices and none of the
  // generate evidence. Without the no-clobber guard it becomes latestManifest, and the
  // MicroPython-lib package the build is about disappears from the webview, from the deploy
  // checkpoint card and from every artifact recorded after it.
  const { controller, posted, recorded } = controllerWith(async ({ onEvent, intent }: any) => {
    onEvent({ type: "manifest_updated", manifest: intent === "diagram it" ? thinOptionalRunManifest() : micropythonLibManifest() });
    return { terminal: "generated" };
  });

  await controller.start({ intent: "ble beacon", boardId: "esp32-c3-devkitm-1" });
  // The panel's start_optional_flow path: startPhase runs with preserveManifest, so the
  // excursion sees the main flow's manifest exactly like production.
  await controller.startPhase({ phase: "upy-diagram-plugin", envelope: "diagram it" });

  const manifests = postedManifests(posted);
  assert.equal(manifests.length, 2, "both runs reached the chokepoint");
  assertCarriesEvidence(manifests[1], "manifest posted during the optional run");
  assert.equal(manifests[1].phase, "generate", "the thin optional-run manifest did not replace the rich one");
  assertCarriesEvidence(recordedManifests(recorded).at(-1), "artifact recorded during the optional run");
});

test("a later devices-bearing manifest still replaces the previous one (the guard is not first-wins)", async () => {
  // Boundary on the guard above: it must only reject manifests that would LOSE devices.
  // A normal phase-to-phase update carries devices and has to win, or the manifest would
  // freeze at the first phase that produced one.
  const updated = micropythonLibManifest();
  updated.devices.push({ name: "status_led", driver: { source: "none" } });
  const { controller, posted } = controllerWith(async ({ onEvent, intent }: any) => {
    onEvent({ type: "manifest_updated", manifest: intent === "add an led" ? updated : micropythonLibManifest() });
    return { terminal: "generated" };
  });

  await controller.start({ intent: "ble beacon", boardId: "esp32-c3-devkitm-1" });
  await controller.startPhase({ phase: "upy-generate-plugin", envelope: "add an led" });

  const manifests = postedManifests(posted);
  assert.equal(manifests[1].devices.length, 3, "the newer devices-bearing manifest wins");
  assertCarriesEvidence(manifests[1], "the newer manifest");
});
