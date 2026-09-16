import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { resolvePersistStatePath } from "../scripts/persist-state-path.mjs";

test("持久状态只接受绝对根目录", () => {
  const root = path.resolve("build", "persist-state-fixture");
  assert.equal(resolvePersistStatePath(undefined), undefined);
  assert.equal(resolvePersistStatePath(root), root);
  assert.throws(() => resolvePersistStatePath("relative-state"), /绝对状态根目录/u);
  assert.throws(() => resolvePersistStatePath(path.join(root, "v3")), /末段不能/u);
});
