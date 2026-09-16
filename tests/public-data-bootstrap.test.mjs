import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { bootstrapPublicData, PUBLIC_DATA_MAPPINGS } from "../scripts/bootstrap-public-data.mjs";

const projectRoot = path.resolve(import.meta.dirname, "..");
const privateMarkers = [
  "Codex" + "index",
  String.fromCharCode(73, 71, 71),
  "jing" + "wang",
  "@" + "ig" + "g.com",
];

async function withFixture(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), "wenmai-public-data-"));
  try {
    await mkdir(path.join(root, "data"), { recursive: true });
    for (const mapping of PUBLIC_DATA_MAPPINGS) {
      const source = await readFile(path.join(projectRoot, mapping.source), "utf8");
      await writeFile(path.join(root, mapping.source), source, "utf8");
    }
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("bootstrap creates safe generated datasets in an empty clone", async () => {
  await withFixture(async (root) => {
    const result = await bootstrapPublicData(root);
    assert.deepEqual(result.map((item) => item.status), ["created", "created", "created"]);
    for (const mapping of PUBLIC_DATA_MAPPINGS) {
      const generated = JSON.parse(await readFile(path.join(root, mapping.target), "utf8"));
      assert.equal(typeof generated.schemaVersion, "string");
      const serialized = JSON.stringify(generated).toLowerCase();
      for (const marker of privateMarkers) assert.ok(!serialized.includes(marker.toLowerCase()));
    }
  });
});

test("bootstrap never overwrites an existing generated dataset", async () => {
  await withFixture(async (root) => {
    const target = path.join(root, PUBLIC_DATA_MAPPINGS[0].target);
    const sentinel = "{\"privateLocalData\":true}\n";
    await writeFile(target, sentinel, "utf8");
    const result = await bootstrapPublicData(root);
    assert.equal(result[0].status, "kept");
    assert.equal(await readFile(target, "utf8"), sentinel);
  });
});
