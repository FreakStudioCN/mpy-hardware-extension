import { readdirSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const files = [...walk("src"), ...walk("test")].filter((file) => file.endsWith(".ts"));
for (const file of files) {
  const result = spawnSync(process.execPath, ["--no-warnings", "--experimental-strip-types", "--check", file], { stdio: "inherit" });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      yield* walk(path);
    } else {
      yield path;
    }
  }
}
