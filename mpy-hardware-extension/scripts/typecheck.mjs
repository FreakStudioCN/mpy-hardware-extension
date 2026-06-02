import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const tsc = process.platform === "win32"
  ? join("node_modules", ".bin", "tsc.cmd")
  : join("node_modules", ".bin", "tsc");

if (!existsSync(tsc)) {
  console.error("TypeScript compiler not installed. Run npm install.");
  process.exit(1);
}

const result = spawnSync(tsc, ["--noEmit", "--project", "tsconfig.typecheck.json"], { stdio: "inherit", shell: process.platform === "win32" });
process.exit(result.status ?? 1);
