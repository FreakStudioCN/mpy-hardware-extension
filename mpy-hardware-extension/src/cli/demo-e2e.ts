// Offline end-to-end demo of the six-stage "sentence -> running hardware" flow.
//
//   npm run demo:e2e "温度超过30度就点亮LED"
//
// Runs the real deterministic pipeline (capability analysis -> package/board
// resolution -> MicroPython codegen -> static audit) against a static catalog
// snapshot with no backend, no API keys and no board, then replays the firmware's
// serial contract through a labelled device simulator. Every artifact shown is
// produced by the real pipeline; only the final device stage is simulated (see
// device-simulator.ts). Live LLM codegen and real flashing run against production.
import { mkdir, writeFile } from "node:fs/promises";
import { extractCapabilities } from "../core/capabilities.ts";
import { runPipeline } from "../core/pipeline.ts";
import { OfflinePackageClient, OfflineBoardClient, resolve } from "../demo/offline-catalog.ts";
import { DeviceSimulator } from "../demo/device-simulator.ts";

const C = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
};

const intent = process.argv.slice(2).join(" ") || "温度超过30度就点亮LED";
const boardId = process.env.MPYHW_DEMO_BOARD || "esp32-s3-devkitc-1";

function stage(n: number, title: string, skill: string) {
  console.log("\n" + C.cyan(`━━ 阶段 ${n} · ${title} `) + C.dim(`(${skill})`));
}
function ok(msg: string) {
  console.log(C.green("  ✔ ") + msg);
}

console.log(C.bold("\nBlockless · 一句话造硬件 — 离线端到端演示"));
console.log(C.dim("  无后端 · 无 API key · 无硬件，全流程真实管线\n"));
console.log(C.bold("  输入: ") + C.yellow(`“${intent}”`));
console.log(C.dim(`  目标板卡: ${boardId}`));

// Stage 1 — analyze
stage(1, "分析需求", "upy-analyze-plugin");
const capabilities = extractCapabilities(intent);
ok(`识别能力: ${capabilities.map((c) => C.bold(c)).join(", ") || "(无)"}`);

// Stage 2 — select hardware
stage(2, "选择硬件与器件", "upy-select-hw-plugin");
const resolution = resolve({ intent, capabilities, board_id: boardId });
if (!resolution.selected) {
  console.log(C.red("  ✘ 没有匹配的器件包，退出。"));
  process.exit(1);
}
const sel: any = resolution.selected;
const board: any = await new OfflineBoardClient().getBoardProfile(boardId);
ok(`主器件: ${C.bold(sel.name)}@${sel.version} ` + C.dim(`(${sel.support_level}, ${sel.reason})`));
ok(`候选池: ${resolution.candidates.length} 个，Top3: ` + resolution.candidates.slice(0, 3).map((c: any) => c.name).join(", "));
ok(`板卡: ${C.bold(board.display_name)} · ${board.manufacturer}`);

// Stages 3-5 — firmware / scaffold / generate all come out of the deterministic pipeline
const result = await runPipeline({
  intent,
  board_id: boardId,
  packageClient: new OfflinePackageClient(),
  boardClient: new OfflineBoardClient(),
});
if (!result.ok || !result.files) {
  if (result.error === "driver_context_missing" || result.error === "package_not_found") {
    console.log(
      C.yellow(`\n  ○ 该需求解析到的器件不在离线快照内 (${result.error})。`) +
        C.dim("\n    离线 demo 覆盖确定性 golden path；完整器件库 + 实时 LLM 生成走生产后端。\n"),
    );
    process.exit(0);
  }
  console.log(C.red(`  ✘ 管线失败: ${result.error}${result.detail ? " " + JSON.stringify(result.detail) : ""}`));
  process.exit(1);
}

stage(3, "烧录 MicroPython 固件", "upy-flash-mpy-firmware-plugin");
ok(`固件目标: ${C.bold(board.display_name)} ` + C.dim("(端口按 ESP32 分支处理)"));

stage(4, "生成工程骨架", "upy-scaffold-plugin");
ok("工程骨架就绪: " + Object.keys(result.files).map((f) => C.bold(f)).join(", "));
ok(`依赖包: ${C.dim(result.package_json_url ?? "builtin")}`);

stage(5, "生成代码", "upy-generate-plugin");
ok(`控制逻辑: ${C.bold(JSON.stringify(result.manifest?.logic))}`);
ok("静态审计通过 " + C.dim("(无越权 import，引脚在板卡能力范围内)"));
console.log(C.dim("\n  ── 生成的 main.py ──────────────────────────────"));
console.log(
  result.files["main.py"]
    .split("\n")
    .map((l) => "  " + C.green("│ ") + l)
    .join("\n"),
);
console.log(C.dim("  ────────────────────────────────────────────────"));

// Stage 6 — deploy (simulated device)
stage(6, "部署到设备", "upy-deploy-plugin");
const device = new DeviceSimulator(result.manifest?.logic ?? {});
await device.installPackage(result.package_json_url ?? "builtin");
await device.writeMainPy(result.files["main.py"]);
await device.flashAndRun("main.py");
const serial = await device.serialReadUntil(["MPYHW_READY", "TEMP_C="]);
ok("安装依赖 → 上传 main.py → 软复位 " + C.dim("(设备模拟器，无实物板卡)"));
console.log(C.dim("\n  ── 串口输出 (模拟传感器扫描) ───────────────────"));
for (const line of serial.lines) {
  const lit = line.includes("LED=ON");
  console.log("  " + C.green("│ ") + (lit ? C.yellow(line + "  ●") : C.dim(line)));
}
console.log(C.dim("  ────────────────────────────────────────────────"));

// Persist artifacts
const outDir = "tmp/demo";
await mkdir(outDir, { recursive: true });
await writeFile(`${outDir}/main.py`, result.files["main.py"], "utf-8");
await writeFile(`${outDir}/manifest.json`, result.files["manifest.json"], "utf-8");
await writeFile(`${outDir}/serial.log`, serial.lines.join("\n") + "\n", "utf-8");

console.log(C.green("\n✔ 完成") + C.dim(`  一句话 → 运行中的硬件逻辑。产物写入 ${outDir}/ (main.py, manifest.json, serial.log)`));
console.log(
  C.dim("  离线跑的是确定性 golden path；任意需求的实时 LLM 生成、真机烧录、retry/checkpoint/autofix 走生产后端。\n"),
);
