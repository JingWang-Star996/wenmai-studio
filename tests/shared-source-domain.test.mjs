import assert from "node:assert/strict";
import test from "node:test";
import { currentBindings, evaluateSharedSourceRead, parseSharedSourcePage } from "../app/shared-source-read-model.ts";

test("metadata 权限默认拒绝且只接受当前 attach", () => {
  const base = { sourceStatus: "active", binding: { action: "attach" }, rights: { decision: "allow", valid_from: "2026-01-01T00:00:00.000Z", valid_until: null, allowed_uses_json: '["metadata"]', restrictions_json: "[]" }, access: { capability: "metadata", result: "granted", observed_at: "2026-01-01T00:00:00.000Z", valid_until: "2027-01-01T00:00:00.000Z", authz_fingerprint_sha256: "x" }, expectedFingerprint: "x", now: "2026-09-01T00:00:00.000Z" };
  assert.equal(evaluateSharedSourceRead(base).allowed, true); assert.equal(evaluateSharedSourceRead({ ...base, sourceStatus: "tombstoned" }).allowed, false); assert.equal(evaluateSharedSourceRead({ ...base, binding: { action: "tombstone" } }).allowed, false);
});
test("分页有界，绑定按目标槽取最新记录", () => {
  assert.equal(parseSharedSourcePage("100", null).limit, 100); assert.throws(() => parseSharedSourcePage("101", null));
  assert.deepEqual(currentBindings([{ package_id: "p", project_group_id: null, target_key: "k", generation: 1, created_at: "a" }, { package_id: "p", project_group_id: null, target_key: "k", generation: 2, created_at: "b" }]).map((row) => row.generation), [2]);
});
