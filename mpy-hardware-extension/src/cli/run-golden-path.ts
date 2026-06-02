import { mkdir, writeFile } from "node:fs/promises";

import { BoardClient } from "../core/board-client.ts";
import { PackageClient } from "../core/package-client.ts";
import { runPipeline } from "../core/pipeline.ts";

const intent = process.argv.slice(2).join(" ") || "turn on the LED when temperature is over 30";
const baseUrl = process.env.MPYHW_API_BASE ?? "http://127.0.0.1:8787";
const result = await runPipeline({
  intent,
  board_id: "esp32-s3-devkitc-1",
  packageClient: new PackageClient(baseUrl),
  boardClient: new BoardClient(baseUrl),
});

if (!result.ok) {
  console.error(result);
  process.exit(1);
}

await mkdir("tmp", { recursive: true });
await writeFile("tmp/main.py", result.files["main.py"], "utf-8");
await writeFile("tmp/manifest.json", result.files["manifest.json"], "utf-8");
console.log("Wrote tmp/main.py and tmp/manifest.json");
