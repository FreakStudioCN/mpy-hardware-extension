import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test from "node:test";

import { checkpointSegment, createCheckpointQueue, snapshotCheckpoint } from "../src/cli/checkpoint.ts";

const quiet = () => {};

async function project(files: Record<string, string>): Promise<string> {
  // A sibling directory of the project, so the staging path the snapshot uses lands inside the
  // temp root rather than beside the real repo.
  const root = await mkdtemp(join(tmpdir(), "checkpoint-test-"));
  const dir = join(root, "project");
  for (const [rel, body] of Object.entries(files)) {
    const full = join(dir, rel);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, body, "utf-8");
  }
  await mkdir(dir, { recursive: true });
  return dir;
}

// basename, NOT split("/"). On win32 join yields backslashes, so splitting on "/" returns the whole
// path, includes() is always false, and every negative assertion built on this helper would pass
// without testing anything.
const exists = async (path: string): Promise<boolean> => {
  try {
    return (await readdir(dirname(path))).includes(basename(path));
  } catch {
    return false;  // the parent does not exist, so neither does the child
  }
};

test("a snapshot copies the tree into its phase slot and leaves .mpyhw out of it", async () => {
  const dir = await project({
    "firmware/main.py": "print('v1')",
    ".mpyhw/sessions/x/session.jsonl": "{}\n",
  });

  await snapshotCheckpoint(dir, "upy-scaffold-plugin", quiet, quiet);

  const saved = join(dir, ".mpyhw", "checkpoints", "upy-scaffold-plugin");
  assert.equal(await readFile(join(saved, "firmware/main.py"), "utf-8"), "print('v1')");
  // Copying .mpyhw in would nest the run's own history one level deeper on every phase.
  assert.equal(await exists(join(saved, ".mpyhw")), false, ".mpyhw must not be copied into the checkpoint");
});

// The destructive half: dest is handed to a recursive rm and then a rename. `..` is a traversal
// with no separator in it, so the character class alone passes it through untouched, and dest then
// resolves to .mpyhw itself -- taking the session log and every other checkpoint with it.
test("a traversal phase cannot escape the checkpoints directory", async () => {
  const dir = await project({
    "firmware/main.py": "print('v1')",
    ".mpyhw/sessions/x/session.jsonl": "{}\n",
    ".mpyhw/checkpoints/analyze/marker.txt": "earlier phase",
  });

  for (const evil of ["..", ".", "../..", "../../../victim"]) {
    await snapshotCheckpoint(dir, evil, quiet, quiet);
  }

  // Nothing above the checkpoints directory was touched.
  assert.equal(await readFile(join(dir, ".mpyhw", "sessions", "x", "session.jsonl"), "utf-8"), "{}\n");
  assert.equal(
    await readFile(join(dir, ".mpyhw", "checkpoints", "analyze", "marker.txt"), "utf-8"),
    "earlier phase",
    "an earlier phase's checkpoint must survive a traversal attempt",
  );
  // And the project itself is still there — the rename could otherwise move a staged copy over it.
  assert.equal(await readFile(join(dir, "firmware", "main.py"), "utf-8"), "print('v1')");
});

test("every checkpoint lands as a single directory under checkpoints/", async () => {
  const dir = await project({ "firmware/main.py": "print('v1')" });

  await snapshotCheckpoint(dir, "../escape", quiet, quiet);

  const slots = await readdir(join(dir, ".mpyhw", "checkpoints"));
  assert.equal(slots.length, 1);
  // The property is "one path component that resolves to itself", not "the name contains no dots".
  // `../escape` becomes `.._escape`, which is an ordinary directory name -- ugly, and harmless.
  // What must never appear is a separator, or a name that IS a traversal (`.` or `..`).
  assert.ok(!slots[0].includes("/") && !slots[0].includes("\\"), `slot name spans directories: ${slots[0]}`);
  assert.ok(!/^\.+$/.test(slots[0]), `slot name is a traversal: ${slots[0]}`);
});

test("a canonical phase name is used verbatim", () => {
  assert.equal(checkpointSegment("upy-deploy-plugin"), "upy-deploy-plugin");
  assert.equal(checkpointSegment("select-hw"), "select-hw");
  assert.equal(checkpointSegment(".."), "_");
  assert.equal(checkpointSegment("."), "_");
  assert.equal(checkpointSegment("a/../b"), "a_.._b");
});

// The reason the queue takes the phase as an argument rather than reading a mutable `current`.
// A queued copy runs after the one before it settles, which is exactly when the next phase has
// already started -- so a lazily-read phase filed the snapshot under the wrong name.
test("each queued snapshot keeps the phase it was queued with", async () => {
  const dir = await project({ "firmware/main.py": "print('v1')" });
  const queue = createCheckpointQueue(dir, quiet, quiet);

  queue.snapshot("upy-scaffold-plugin");
  // Queued back to back: the second is still waiting while the first copies, which is the race.
  queue.snapshot("upy-generate-plugin");
  await queue.drain();

  const slots = (await readdir(join(dir, ".mpyhw", "checkpoints"))).sort();
  assert.deepEqual(slots, ["upy-generate-plugin", "upy-scaffold-plugin"]);
});

// The whole point of draining: the run used to exit while the last copy was mid-flight, leaving
// the staging directory behind and the checkpoint the next resume wanted never renamed into place.
test("drain waits for the snapshots queued before it", async () => {
  const dir = await project({ "firmware/main.py": "print('v1')" });
  const queue = createCheckpointQueue(dir, quiet, quiet);

  queue.snapshot("upy-deploy-plugin");
  await queue.drain();

  assert.equal(
    await readFile(join(dir, ".mpyhw", "checkpoints", "upy-deploy-plugin", "firmware/main.py"), "utf-8"),
    "print('v1')",
    "the checkpoint must be complete once drain resolves",
  );
});

// Best-effort means best-effort: this is diagnostic scaffolding and must never fail the run it is
// observing. Both the function and the queue swallow, so a passing run cannot be turned into a
// failing one by a checkpoint that could not be written.
test("a snapshot of a project that does not exist reports and resolves", async () => {
  const warnings: string[] = [];
  await snapshotCheckpoint(join(tmpdir(), "checkpoint-test-absent-project"), "analyze", quiet, (m) => warnings.push(m));
  assert.equal(warnings.length, 1, "the failure has to be said out loud");
  assert.match(warnings[0], /not saved/);

  const queue = createCheckpointQueue(join(tmpdir(), "checkpoint-test-absent-project"), quiet, quiet);
  queue.snapshot("analyze");
  await queue.drain();  // must not reject
});

test("an empty phase is a no-op rather than a checkpoint named nothing", async () => {
  const dir = await project({ "firmware/main.py": "print('v1')" });
  await snapshotCheckpoint(dir, "", quiet, quiet);
  assert.equal(await exists(join(dir, ".mpyhw")), false, "an empty phase must not create a checkpoint tree");
});
