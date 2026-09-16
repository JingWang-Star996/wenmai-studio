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
const migrations = new Map(await Promise.all(migrationNames.map(async (name) => [
  name,
  await readFile(path.join(root, "drizzle", name), "utf8"),
])));
const migration0024 = migrationNames.find((name) => name.startsWith("0024_"));
const migration0024Index = migrationNames.indexOf(migration0024);
const migrationNamesThrough0024 = migrationNames.slice(0, migration0024Index + 1);
const sha = (letter) => letter.repeat(64);

function apply(db, names) {
  for (const name of names) {
    const sql = migrations.get(name);
    assert.ok(sql, `缺少迁移 ${name}`);
    for (const statement of sql.split("--> statement-breakpoint").map((part) => part.trim()).filter(Boolean)) db.exec(statement);
  }
}

function tableIndexes(db, table) {
  return new Map(db.prepare(`PRAGMA index_list('${table}')`).all().map((row) => [row.name, Number(row.unique)]));
}

function insert0023Fixture(db) {
  const now = "2026-08-28T00:00:00.000Z";
  db.prepare(`INSERT INTO meta_skill_versions
    (id,skill_key,version,role,prompt_text,prompt_sha256,contract_sha256,content_sha256,
     created_by_kind,created_by_provider,is_candidate,status,lock_version,created_at)
    VALUES ('skill-deepseek','skill.fixture','1.0.0','proposer','fixture',?,?,?,
      'model','deepseek',1,'candidate',1,?)`).run(sha("a"), sha("b"), sha("c"), now);
  db.prepare(`INSERT INTO meta_skill_versions
    (id,skill_key,version,role,prompt_text,prompt_sha256,contract_sha256,content_sha256,
     created_by_kind,created_by_provider,is_candidate,status,lock_version,created_at)
    VALUES ('skill-qwen','skill.fixture','1.0.1','reviewer','fixture',?,?,?,
      'model','qwen',1,'candidate',1,?)`).run(sha("d"), sha("e"), sha("f"), now);
  for (const provider of ["deepseek", "qwen"]) {
    db.prepare(`INSERT INTO model_invocations
      (id,command_id,purpose,role,provider,model_id,adapter_version,egress_manifest_sha256,
       egress_approval_sha256,request_sha256,input_sha256,budget_reservation_sha256,created_at)
      VALUES (?,?,?,?,?,'fixture-model','adapter-v2',?,?,?,?,?,?)`)
      .run(`invocation-${provider}`, `command-${provider}`, "provider_probe", "probe", provider,
        sha("1"), sha("2"), sha("3"), sha("4"), sha("5"), now);
  }
  db.prepare(`INSERT INTO meta_improvement_evaluations
    (id,experiment_id,pair_id,case_id,arm,evaluator_kind,evaluator_key,provider,model_id,
     result,contract_sha256,input_sha256,output_sha256,signals_sha256,evidence_sha256,created_at)
    VALUES ('evaluation-deepseek','experiment-fixture','pair-fixture','case-fixture','pair',
      'model','reviewer','deepseek','fixture-model','pass',?,?,?,?,?,?)`)
    .run(sha("6"), sha("7"), sha("8"), sha("9"), sha("a"), now);
}

function insertProbe(db, provider, id) {
  const now = "2026-08-28T00:00:00.000Z";
  db.prepare(`INSERT INTO model_invocations
    (id,command_id,purpose,role,provider,model_id,adapter_version,egress_manifest_sha256,
     egress_approval_sha256,request_sha256,input_sha256,budget_reservation_sha256,created_at)
    VALUES (?,?,?,?,?,'contract-model','adapter-v2',?,?,?,?,?,?)`)
    .run(id, `command-${id}`, "provider_probe", "probe", provider,
      sha("1"), sha("2"), sha("3"), sha("4"), sha("5"), now);
}

test("0024 是 0000-0024 fresh 链的唯一新账本项，并附带 snapshot", async () => {
  assert.equal(migration0024Index, 24);
  assert.equal(migrationNamesThrough0024.at(-1), migration0024);
  assert.deepEqual(migrationNames, journal.entries.map((entry) => `${entry.tag}.sql`));
  assert.equal(journal.entries.filter((entry) => entry.tag === migration0024.slice(0, -4)).length, 1);
  assert.ok(migration0024);
  assert.ok(await readFile(path.join(root, "drizzle", "meta", "0024_snapshot.json"), "utf8"));
  const db = new DatabaseSync(":memory:");
  apply(db, migrationNamesThrough0024);
  assert.equal(db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  db.close();
});

test("0024 保存 0023 的 DeepSeek/Qwen 行、所有索引和 partial unique index", () => {
  const db = new DatabaseSync(":memory:");
  apply(db, migrationNamesThrough0024.slice(0, -1));
  insert0023Fixture(db);
  const before = {
    versions: db.prepare("SELECT id,created_by_provider,content_sha256 FROM meta_skill_versions ORDER BY id").all(),
    invocations: db.prepare("SELECT id,provider,model_id,request_sha256 FROM model_invocations ORDER BY id").all(),
    evaluations: db.prepare("SELECT id,provider,model_id,result FROM meta_improvement_evaluations ORDER BY id").all(),
  };
  apply(db, [migration0024]);
  const after = {
    versions: db.prepare("SELECT id,created_by_provider,content_sha256 FROM meta_skill_versions ORDER BY id").all(),
    invocations: db.prepare("SELECT id,provider,model_id,request_sha256 FROM model_invocations ORDER BY id").all(),
    evaluations: db.prepare("SELECT id,provider,model_id,result FROM meta_improvement_evaluations ORDER BY id").all(),
  };
  assert.deepEqual(after, before);
  assert.equal(tableIndexes(db, "meta_skill_versions").get("idx_meta_skill_versions_active_key"), 1);
  assert.equal(tableIndexes(db, "model_invocations").get("idx_model_invocations_command"), 1);
  assert.equal(tableIndexes(db, "model_invocations").get("idx_model_invocations_lineage_candidate"), 0);
  assert.equal(tableIndexes(db, "meta_improvement_evaluations").get("idx_meta_improvement_evaluations_identity"), 1);
  assert.equal(db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  db.close();
});

test("0024 允许四个 provider，拒绝 unknown，并保留 lineage_review 只能 deepseek", () => {
  const db = new DatabaseSync(":memory:");
  apply(db, migrationNames);
  for (const provider of ["deepseek", "qwen", "openai", "ollama"]) insertProbe(db, provider, `probe-${provider}`);
  assert.throws(() => insertProbe(db, "unknown", "probe-unknown"));
  const lineage = db.prepare(`INSERT INTO model_invocations
    (id,lineage_candidate_id,lineage_preparation_id,command_id,purpose,role,provider,model_id,
     adapter_version,prompt_version_id,provider_policy_sha256,egress_manifest_sha256,
     egress_approval_sha256,request_sha256,input_sha256,budget_reservation_sha256,created_at)
    VALUES (?,? ,? ,? ,'lineage_review','reviewer',? ,'lineage-model','adapter-v2','prompt',?,?,?,?,?,?,?)`);
  lineage.run("lineage-deepseek", "candidate", "preparation", "lineage-command-deepseek", "deepseek",
    sha("1"), sha("2"), sha("3"), sha("4"), sha("5"), sha("6"), "2026-08-28T00:00:00.000Z");
  for (const provider of ["openai", "ollama"]) {
    assert.throws(() => lineage.run(`lineage-${provider}`, "candidate", "preparation", `lineage-command-${provider}`, provider,
      sha("1"), sha("2"), sha("3"), sha("4"), sha("5"), sha("6"), "2026-08-28T00:00:00.000Z"));
  }
  db.close();
});

test("0024 在迁移账本中只登记一次，等价重放不丢失既有行", () => {
  const db = new DatabaseSync(":memory:");
  apply(db, migrationNames.filter((name) => name !== migration0024));
  insertProbe(db, "deepseek", "replay-deepseek");
  apply(db, [migration0024]);
  assert.equal(journal.entries.filter((entry) => entry.tag === migration0024.slice(0, -4)).length, 1);
  apply(db, [migration0024]);
  assert.equal(db.prepare("SELECT provider FROM model_invocations WHERE id='replay-deepseek'").get().provider, "deepseek");
  db.close();
});
