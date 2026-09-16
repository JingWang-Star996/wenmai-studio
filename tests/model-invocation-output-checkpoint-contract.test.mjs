import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

const [schema, migration, journalText, previousSnapshotText, snapshotText] = await Promise.all([
  read("../db/schema.ts"),
  read("../drizzle/0015_strong_maximus.sql"),
  read("../drizzle/meta/_journal.json"),
  read("../drizzle/meta/0014_snapshot.json"),
  read("../drizzle/meta/0015_snapshot.json"),
]);
const journal = JSON.parse(journalText);
const previousSnapshot = JSON.parse(previousSnapshotText);
const snapshot = JSON.parse(snapshotText);

test("0015 is the registered additive successor of 0014", () => {
  const entry = journal.entries.find((item) => item.tag === "0015_strong_maximus");
  assert.deepEqual(entry, {
    idx: 15,
    version: "6",
    when: entry?.when,
    tag: "0015_strong_maximus",
    breakpoints: true,
  });
  assert.equal(journal.entries[entry.idx - 1]?.tag, "0014_left_rattler");
  assert.equal(snapshot.prevId, previousSnapshot.id);
  assert.ok(snapshot.tables.model_invocation_outputs);
  assert.deepEqual(
    [...migration.matchAll(/CREATE TABLE `([^`]+)`/gu)].map((match) => match[1]),
    ["model_invocation_outputs"],
  );
  assert.equal((migration.match(/CREATE (?:UNIQUE )?INDEX/gu) ?? []).length, 1);
  assert.doesNotMatch(migration, /\b(?:ALTER|DROP|DELETE|UPDATE|INSERT)\b/iu);
});

test("checkpoint schema uniquely binds one bounded structured response to one invocation", () => {
  assert.match(schema, /export const modelInvocationOutputs = sqliteTable\(/u);
  assert.match(migration, /`invocation_id` text PRIMARY KEY NOT NULL/u);
  for (const column of [
    "materialization_kind",
    "response_json",
    "response_sha256",
    "usage_json",
    "usage_sha256",
    "materialization_state",
    "materialization_ref",
    "materialization_lease_owner",
    "materialization_lease_expires_at",
    "materialization_attempts",
    "materialization_lock_version",
    "last_error_class",
    "last_error_summary",
    "created_at",
    "updated_at",
    "materialized_at",
  ]) assert.match(migration, new RegExp("`" + column + "`", "u"));

  assert.match(migration, /json_valid\("model_invocation_outputs"\."response_json"\)/u);
  assert.match(migration, /json_type\("model_invocation_outputs"\."response_json"\) = 'object'/u);
  assert.match(migration, /AS BLOB\)\) BETWEEN 2 AND 262144/u);
  assert.match(migration, /json_valid\("model_invocation_outputs"\."usage_json"\)/u);
  assert.match(migration, /AS BLOB\)\) BETWEEN 2 AND 8192/u);
  assert.match(migration, /response_sha256"\) = 64/u);
  assert.match(migration, /usage_sha256"\) = 64/u);
});

test("materialization recovery is an explicit leased CAS state machine", () => {
  assert.match(migration, /IN \('checkpointed','materializing','materialized','blocked'\)/u);
  assert.match(migration, /materialization_attempts" >= 0/u);
  assert.match(migration, /materialization_lock_version" >= 1/u);
  assert.match(migration, /materialization_state" = 'materializing'[\s\S]*materialization_lease_owner" IS NOT NULL[\s\S]*materialization_lease_expires_at" IS NOT NULL/u);
  assert.match(migration, /materialization_state" = 'materialized'[\s\S]*materialized_at" IS NOT NULL/u);
  assert.match(migration, /idx_model_invocation_outputs_state_updated/u);
});

test("server-only checkpoint shape has no credential persistence surface", () => {
  const tableDefinition = migration.match(/CREATE TABLE `model_invocation_outputs` \([\s\S]*?\n\);/u)?.[0] ?? "";
  assert.ok(tableDefinition);
  assert.doesNotMatch(tableDefinition, /api[_-]?key|authorization|bearer|credential|secret|request_headers?/iu);
});
