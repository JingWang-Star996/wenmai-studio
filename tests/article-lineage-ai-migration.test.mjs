import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const journal = JSON.parse(await readFile(path.join(root, "drizzle", "meta", "_journal.json"), "utf8"));
const migrationNames = (await readdir(path.join(root, "drizzle")))
  .filter((name) => /^\d{4}_.+\.sql$/u.test(name))
  .sort();
const migrationSql = new Map(await Promise.all(migrationNames.map(async (name) => [
  name,
  await readFile(path.join(root, "drizzle", name), "utf8"),
])));

function apply(db, names) {
  for (const name of names) {
    const sql = migrationSql.get(name);
    assert.ok(sql, `缺少迁移 ${name}`);
    for (const statement of sql.split("--> statement-breakpoint").map((value) => value.trim()).filter(Boolean)) {
      db.exec(statement);
    }
  }
}

function columns(db, table) {
  return new Set(db.prepare(`PRAGMA table_info('${table}')`).all().map((row) => row.name));
}

function indexes(db, table) {
  return new Map(db.prepare(`PRAGMA index_list('${table}')`).all().map((row) => [row.name, Number(row.unique)]));
}

function insertPre0017Invocation(db) {
  const sha = "a".repeat(64);
  db.prepare(`INSERT INTO model_invocations
    (id, command_id, purpose, role, provider, model_id, adapter_version,
     egress_manifest_sha256, egress_approval_sha256, request_sha256, input_sha256,
     response_sha256, output_ref, state, attempt, budget_reservation_json,
     budget_reservation_sha256, usage_json, input_tokens, output_tokens, total_tokens,
     estimated_cost_cny_micros, latency_ms, http_status, finish_reason,
     provider_request_id, created_at, started_at, finished_at)
    VALUES (?, ?, 'provider_probe', 'probe', 'deepseek', ?, ?, ?, ?, ?, ?, ?, ?,
      'succeeded', 1, ?, ?, ?, 20, 7, 27, 1000, 25, 200, 'stop', ?, ?, ?, ?)`)
    .run(
      "invocation-pre-0017", "command-pre-0017", "deepseek-v4-pro", "adapter-v2",
      sha, sha, sha, sha, sha, "probe-output", "{}", sha, "{\"totalTokens\":27}",
      "provider-request-pre-0017", "2026-08-18T00:00:00.000Z",
      "2026-08-18T00:00:00.000Z", "2026-08-18T00:00:01.000Z",
    );
  db.prepare(`INSERT INTO model_invocation_outputs
    (invocation_id, materialization_kind, response_json, response_sha256,
     usage_json, usage_sha256, materialization_state, materialization_ref,
     materialization_attempts, materialization_lock_version, created_at, updated_at, materialized_at)
    VALUES (?, 'probe', '{}', ?, '{}', ?, 'materialized', '', 0, 1, ?, ?, ?)`)
    .run("invocation-pre-0017", sha, sha, "2026-08-18T00:00:01.000Z",
      "2026-08-18T00:00:01.000Z", "2026-08-18T00:00:01.000Z");
}

test("fresh journal chain through 0028 preserves the 0017 lineage_review tables and indexes", () => {
  assert.ok(migrationNames.includes("0017_amazing_annihilus.sql"));
  assert.deepEqual(migrationNames, journal.entries.map((entry) => `${entry.tag}.sql`));
  assert.equal(migrationNames.at(-1), "0028_release_control_v2_dom_binding.sql");
  assert.equal(migrationNames.length, 29);
  const db = new DatabaseSync(":memory:");
  apply(db, migrationNames);
  assert.deepEqual([...columns(db, "model_invocations")].filter((name) => name.startsWith("lineage_")), [
    "lineage_candidate_id", "lineage_preparation_id",
  ]);
  assert.ok(columns(db, "article_lineage_review_preparations").has("frozen_input_json"));
  assert.ok(columns(db, "article_lineage_model_reviews").has("candidate_only"));
  assert.equal(indexes(db, "model_invocations").get("idx_model_invocations_lineage_candidate"), 0);
  assert.equal(indexes(db, "article_lineage_model_reviews").get("idx_lineage_model_reviews_invocation"), 1);
  assert.equal(indexes(db, "article_lineage_model_reviews").get("idx_lineage_model_reviews_preparation"), 1);
  assert.equal(indexes(db, "article_lineage_review_preparations").get("idx_lineage_review_preparation_input"), 1);
  assert.equal(db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
  db.close();
});

test("0017 preserves pre-existing invocation/checkpoint and nulls only new lineage bindings", () => {
  const db = new DatabaseSync(":memory:");
  const through0016 = migrationNames.filter((name) => Number(name.slice(0, 4)) <= 16);
  apply(db, through0016);
  insertPre0017Invocation(db);
  const before = { ...db.prepare(`SELECT command_id, purpose, role, provider, model_id, response_sha256,
    output_ref, state, input_tokens, output_tokens, total_tokens, finished_at
    FROM model_invocations WHERE id='invocation-pre-0017'`).get() };
  apply(db, ["0017_amazing_annihilus.sql"]);
  const after = db.prepare(`SELECT command_id, purpose, role, provider, model_id, response_sha256,
    output_ref, state, input_tokens, output_tokens, total_tokens, finished_at,
    lineage_candidate_id, lineage_preparation_id
    FROM model_invocations WHERE id='invocation-pre-0017'`).get();
  assert.deepEqual(Object.fromEntries(Object.entries(after).slice(0, 12)), before);
  assert.equal(after.lineage_candidate_id, null);
  assert.equal(after.lineage_preparation_id, null);
  assert.equal(db.prepare(`SELECT materialization_state FROM model_invocation_outputs
    WHERE invocation_id='invocation-pre-0017'`).get().materialization_state, "materialized");
  db.close();
});

test("0017 accepts only deepseek reviewer lineage invocations with complete bindings", () => {
  const db = new DatabaseSync(":memory:");
  apply(db, migrationNames);
  const sha = "b".repeat(64);
  const insert = db.prepare(`INSERT INTO model_invocations
    (id, experiment_id, lineage_candidate_id, lineage_preparation_id, command_id,
     purpose, role, provider, model_id, adapter_version, prompt_version_id,
     provider_policy_sha256, egress_manifest_sha256, egress_approval_sha256,
     request_sha256, input_sha256, budget_reservation_sha256, created_at)
    VALUES (?, NULL, ?, ?, ?, 'lineage_review', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  insert.run("lineage-invocation-ok", "candidate-1", "preparation-1", "lineage-command-ok",
    "reviewer", "deepseek", "deepseek-v4-pro", "adapter-v2", "lineage-prompt-v1",
    sha, sha, sha, sha, sha, sha, "2026-08-18T00:00:00.000Z");
  assert.equal(db.prepare("SELECT purpose FROM model_invocations WHERE id='lineage-invocation-ok'").get().purpose,
    "lineage_review");
  assert.throws(() => insert.run("lineage-invocation-qwen", "candidate-2", "preparation-2", "lineage-command-qwen",
    "reviewer", "qwen", "qwen3.7-plus", "adapter-v2", "lineage-prompt-v1",
    sha, sha, sha, sha, sha, sha, "2026-08-18T00:00:00.000Z"));
  assert.throws(() => insert.run("lineage-invocation-missing", null, "preparation-3", "lineage-command-missing",
    "reviewer", "deepseek", "deepseek-v4-pro", "adapter-v2", "lineage-prompt-v1",
    sha, sha, sha, sha, sha, sha, "2026-08-18T00:00:00.000Z"));
  db.close();
});

test("preparation/review checks retain candidate-only and explicit budget boundaries", () => {
  const db = new DatabaseSync(":memory:");
  apply(db, migrationNames);
  const sha = "c".repeat(64);
  db.prepare(`INSERT INTO article_lineage_review_preparations
    (id, candidate_id, candidate_lock_version, candidate_input_sha256,
     source_revision_id, source_body_sha256, target_revision_id, target_body_sha256,
     frozen_input_json, input_sha256, input_token_estimate, budget_estimate_json,
     created_by, created_at, updated_at)
    VALUES (?, ?, 1, ?, ?, ?, ?, ?, '{}', ?, 600, '{}', ?, ?, ?)`)
    .run("preparation-ok", "candidate-ok", sha, "source-revision", sha,
      "target-revision", sha, sha, "management-session:test",
      "2026-08-18T00:00:00.000Z", "2026-08-18T00:00:00.000Z");
  db.prepare(`INSERT INTO article_lineage_model_reviews
    (id, preparation_id, candidate_id, candidate_lock_version, input_sha256,
     invocation_id, provider, model_id, output_schema_version, output_json,
     output_sha256, relation_recommendation, confidence_micros, candidate_only,
     state, max_input_tokens, max_output_tokens, max_cost_cny_micros,
     reserved_cost_cny_micros, usage_json, created_by, created_at)
    VALUES (?, ?, ?, 1, ?, ?, 'deepseek', ?, ?, '{}', ?, 'same_root', 900000,
      1, 'candidate', 600, 512, 3000000, 2000000, '{}', ?, ?)`)
    .run("review-ok", "preparation-ok", "candidate-ok", sha, "invocation-review-ok",
      "deepseek-v4-pro", "lineage-output-v1", sha, "management-session:test",
      "2026-08-18T00:00:01.000Z");
  assert.equal(db.prepare("SELECT candidate_only,state FROM article_lineage_model_reviews").get().candidate_only, 1);
  assert.throws(() => db.prepare(`INSERT INTO article_lineage_model_reviews
    (id, preparation_id, candidate_id, candidate_lock_version, input_sha256,
     invocation_id, provider, model_id, output_schema_version, output_json,
     output_sha256, relation_recommendation, confidence_micros, candidate_only,
     state, max_input_tokens, max_output_tokens, max_cost_cny_micros,
     reserved_cost_cny_micros, usage_json, created_by, created_at)
    VALUES ('review-bad','preparation-bad','candidate-bad',1,?,'invocation-bad','deepseek',
      'deepseek-v4-pro','lineage-output-v1','{}',?,'same_root',900000,0,'candidate',
      600,512,3000000,2000000,'{}','actor','2026-08-18T00:00:01.000Z')`).run(sha, sha));
  db.close();
});
