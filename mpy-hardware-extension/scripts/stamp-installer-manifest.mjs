import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Run after `npm run package`: hashes the freshly built VSIX and stamps that
// sha256 (+ the current package.json version) into the installer manifest's
// `components.extension` entry. The Rust core only ever verifies a download
// against the manifest value (blockless-installer/core/src/extensions.rs),
// so this is the one place that value is allowed to change — never by hand.

const vsixPath = join("build", "mpy-hardware-extension.vsix");
if (!existsSync(vsixPath)) {
  console.error(`${vsixPath} not found — run \`npm run package\` first.`);
  process.exit(1);
}

const manifestPath = join("..", "blockless-installer", "manifest", "installer.manifest.json");
if (!existsSync(manifestPath)) {
  console.error(`${manifestPath} not found.`);
  process.exit(1);
}

const sha256 = createHash("sha256").update(readFileSync(vsixPath)).digest("hex");
const { version } = JSON.parse(readFileSync("package.json", "utf8"));

const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const before = { ...manifest.components.extension };
manifest.components.extension.version = version;
manifest.components.extension.sha256 = sha256;

writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

console.log(`stamped ${manifestPath}:`);
console.log(`  version: ${before.version} -> ${manifest.components.extension.version}`);
console.log(`  sha256:  ${before.sha256} -> ${manifest.components.extension.sha256}`);
