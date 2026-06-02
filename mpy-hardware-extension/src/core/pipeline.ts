import { extractCapabilities } from "./capabilities.ts";
import { auditCode } from "./audit-code.ts";
import { generateMainPy } from "./codegen.ts";
import { buildManifest } from "./manifest-builder.ts";
import { validateManifest } from "./manifest-schema.ts";

export async function runPipeline(input: { intent: string; board_id: string; packageClient: any; boardClient: any }) {
  const capabilities = extractCapabilities(input.intent);
  let resolution;
  try {
    resolution = await input.packageClient.resolve({ intent: input.intent, capabilities, board_id: input.board_id });
  } catch (error: any) {
    return { ok: false, error: error.code ?? "resolve_failed" };
  }
  if (!resolution.selected) {
    return { ok: false, error: "package_not_found" };
  }
  let context;
  try {
    context = await input.packageClient.getPackageContext(resolution.selected.name, resolution.selected.version);
  } catch (error: any) {
    return { ok: false, error: error.code ?? "driver_context_missing" };
  }
  let board;
  try {
    board = await input.boardClient.getBoardProfile(input.board_id);
  } catch (error: any) {
    return { ok: false, error: error.code ?? "board_profile_failed" };
  }
  const contexts = [context];
  if (capabilities.includes("digital_output") && context.package.name !== "machine_pin_led") {
    contexts.push({
      package: { name: "machine_pin_led", version: "builtin" },
      import_names: ["machine"],
      constructors: ["Pin(pin, Pin.OUT)"],
      read_properties: [],
      bus: ["gpio"],
      pin_roles: ["led_anode"],
      install: { builtin: true },
    });
  }
  const manifest = buildManifest({
    board,
    capabilities,
    packages: contexts.map((ctx) => ({ name: ctx.package.name, version: ctx.package.version })),
    driverContexts: contexts,
    logic: { threshold_c: 30, action: "led_on_above_threshold" },
  });
  const validation = validateManifest(manifest);
  if (!validation.valid) {
    return { ok: false, error: validation.errors[0].code };
  }
  const generated = generateMainPy({ manifest, driverContexts: contexts });
  if (!generated.ok) {
    return { ok: false, error: generated.error };
  }
  const audit = auditCode(generated.code, { board, driverContexts: contexts });
  if (!audit.ok) {
    return { ok: false, error: "audit_failed", detail: audit.disallowed_imports };
  }
  return {
    ok: true,
    manifest,
    package_json_url: context.install.url,
    files: {
      "main.py": generated.code,
      "manifest.json": JSON.stringify(stripBoard(manifest), null, 2),
    },
  };
}

export async function runDeviceLoop(pipeline: any, shim: any) {
  if (!pipeline.ok) {
    throw new Error("pipeline_not_ok");
  }
  await shim.installPackage(pipeline.package_json_url);
  await shim.writeMainPy(pipeline.files["main.py"]);
  await shim.flashAndRun("main.py");
  const lines = await shim.serialReadUntil(["MPYHW_READY", "TEMP_C="]);
  return { lines };
}

function stripBoard(manifest: any) {
  const copy = { ...manifest };
  delete copy.board;
  return copy;
}
