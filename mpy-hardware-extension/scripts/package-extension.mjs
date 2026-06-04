import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

const pkg = JSON.parse(readFileSync("package.json", "utf-8"));
const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});

const required = ["publisher", "displayName", "description", "engines", "main", "activationEvents", "contributes"];
for (const field of required) {
  if (!pkg[field]) fail(`Missing extension package field: ${field}`);
}
if (!pkg.engines.vscode) {
  fail("Missing extension package field: engines.vscode");
}
if (!pkg.contributes.commands?.some((command) => command.command === "mpyhw.openPanel")) {
  fail("Missing mpyhw.openPanel command contribution");
}
if (!existsSync(pkg.main)) {
  fail(`Extension main entry does not exist: ${pkg.main}`);
}

const artifact = `build/${pkg.name}-${pkg.version}.vsix`;
mkdirSync(dirname(artifact), { recursive: true });

const manifest = `<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011">
  <Metadata>
    <Identity Id="${pkg.name}" Version="${pkg.version}" Language="en-US" Publisher="${pkg.publisher}" />
    <DisplayName>${pkg.displayName}</DisplayName>
    <Description xml:space="preserve">${pkg.description}</Description>
    <Tags>MicroPython,Hardware,VS Code</Tags>
    <Categories>Other</Categories>
  </Metadata>
  <Installation>
    <InstallationTarget Id="Microsoft.VisualStudio.Code" />
  </Installation>
  <Dependencies />
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />
  </Assets>
</PackageManifest>`;

const files = [
  { name: "[Content_Types].xml", data: contentTypes() },
  { name: "extension.vsixmanifest", data: manifest },
  { name: "extension/package.json", data: JSON.stringify({ ...pkg, scripts: undefined, private: undefined }, null, 2) },
  { name: `extension/${pkg.main.replace(/^\.\//, "")}`, data: readFileSync(pkg.main) },
  { name: "extension/media/icon.svg", data: readFileSync("media/icon.svg") },
  { name: "extension/python/shim/serve.py", data: readFileSync("python/shim/serve.py") },
  { name: "extension/python/shim/requirements.txt", data: readFileSync("python/shim/requirements.txt") },
  { name: "extension/src/webview/index.html", data: readFileSync("src/webview/index.html") },
  { name: "extension/docs/install.md", data: readFileSync("docs/install.md") },
  { name: "extension/docs/demo-checklist.md", data: readFileSync("docs/demo-checklist.md") },
  { name: "extension/docs/troubleshooting.md", data: readFileSync("docs/troubleshooting.md") },
  // Vendored upstream toolchain (the shim runs these host-side). They live in the
  // repo-root submodule, outside the extension dir, so bundle them under
  // extension/third_party where serve.py's scripts_root() finds them when packaged.
  ...collectUpstream(),
].map((file) => ({ name: file.name.replaceAll("\\", "/"), data: Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data) }));

writeFileSync(artifact, makeZip(files));
console.log(`Built ${artifact}`);

// Collect the vendored upstream scripts/schemas/templates the shim runs (validate,
// scaffold + its templates, download_drivers). Source = repo-root submodule
// (../third_party from the extension dir); destination mirrors it under
// extension/third_party so serve.py's scripts_root() resolves it in a packaged VSIX.
function collectUpstream() {
  const upstreamRoot = join("..", "third_party", "MicroPython_Skills");
  if (!existsSync(upstreamRoot)) {
    fail(`Upstream submodule not found at ${upstreamRoot} — run \`git submodule update --init --recursive\` before packaging.`);
  }
  const rels = [
    "upy-project-gen-toolchain-spec/scripts/validate_json.py",
    "upy-project-gen-toolchain-spec/project-manifest.schema.json",
    "upy-project-gen-toolchain-spec/wiring.schema.json",
    "upy-project-gen-toolchain-spec/diagram.schema.json",
    "upy-scaffold/scripts/init_scaffold.py",
    "upy-generate/scripts/download_drivers.py",
    "upy-wiring/scripts/render_wiring_local.py",
    "upy-diagram/scripts/render_diagram_local.py",
    ...walkDir(join(upstreamRoot, "upy-scaffold", "templates")).map((abs) => relative(upstreamRoot, abs).replaceAll("\\", "/")),
  ];
  return rels.map((rel) => ({
    name: `extension/third_party/MicroPython_Skills/${rel}`,
    data: readFileSync(join(upstreamRoot, rel)),
  }));
}

function walkDir(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walkDir(full));
    else out.push(full);
  }
  return out;
}

function contentTypes() {
  return `<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="json" ContentType="application/json" />
  <Default Extension="js" ContentType="application/javascript" />
  <Default Extension="cjs" ContentType="application/javascript" />
  <Default Extension="html" ContentType="text/html" />
  <Default Extension="svg" ContentType="image/svg+xml" />
  <Default Extension="py" ContentType="text/x-python" />
  <Default Extension="txt" ContentType="text/plain" />
  <Default Extension="md" ContentType="text/markdown" />
  <Default Extension="vsixmanifest" ContentType="text/xml" />
</Types>`;
}

function makeZip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name);
    const crc = crc32(file.data);
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(file.data.length, 18);
    local.writeUInt32LE(file.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    name.copy(local, 30);
    locals.push(local, file.data);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(file.data.length, 20);
    central.writeUInt32LE(file.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);
    centrals.push(central);
    offset += local.length + file.data.length;
  }
  const centralSize = centrals.reduce((sum, entry) => sum + entry.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, ...centrals, end]);
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 0xff];
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
