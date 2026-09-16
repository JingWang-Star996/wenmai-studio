import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const migration = await readFile(path.join(root, "drizzle", "0016_small_scorpion.sql"), "utf8");

function freshDatabase() {
  const db = new DatabaseSync(":memory:");
  for (const statement of migration.split("--> statement-breakpoint").map((value) => value.trim()).filter(Boolean)) {
    db.exec(statement);
  }
  return db;
}

test("0016 applies to a fresh SQLite database with all identity indexes", () => {
  const db = freshDatabase();
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((row) => row.name);
  assert.deepEqual(tables, ["article_identities", "article_identity_members", "article_identity_operations", "article_lineage_links"]);
  const indexes = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all().map((row) => row.name));
  for (const name of [
    "idx_article_identities_canonical_article", "idx_article_identity_members_object",
    "idx_article_lineage_links_relation", "idx_article_identity_operations_command",
    "idx_article_identity_operations_sentinel",
  ]) assert.ok(indexes.has(name), `缺少 ${name}`);
  db.close();
});
test("0016 allows a candidate without identity but rejects invalid digests and states", () => {
  const db = freshDatabase();
  const sha = "a".repeat(64);
  db.prepare(`INSERT INTO article_identity_operations
    (id, operation_kind, status, command_id, actor_id, plan_json, plan_sha256,
     preconditions_json, preconditions_sha256, inverse_json, sentinel, planned_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    "op-1", "candidate_scan", "applied", "command-1", "management-session:test", "{}", sha,
    "{}", sha, "{}", "sentinel-1", "2026-08-18T00:00:00Z", "2026-08-18T00:00:00Z",
  );
  db.prepare(`INSERT INTO article_lineage_links
    (id, identity_id, relation_type, source_kind, source_id, source_article_id, source_revision_id, source_body_sha256,
     target_kind, target_id, target_article_id, target_revision_id, target_body_sha256, status,
     evidence_json, input_sha256, operation_id, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    "link-1", null, "same_work", "revision", "rev-a", "article-a", "rev-a", sha,
    "revision", "rev-b", "article-b", "rev-b", sha, "candidate", "[]", sha, "op-1",
    "2026-08-18T00:00:00Z", "2026-08-18T00:00:00Z",
  );
  assert.equal(db.prepare("SELECT identity_id, status FROM article_lineage_links").get().identity_id, null);
  assert.throws(() => db.prepare(`INSERT INTO article_identity_operations
    (id, operation_kind, status, command_id, actor_id, plan_json, plan_sha256,
     preconditions_json, preconditions_sha256, inverse_json, sentinel, planned_at, updated_at)
    VALUES ('bad','delete','planned','bad-command','actor','{}','bad','{}',?,'{}','bad-sentinel',?,?)`)
    .run(sha, "2026-08-18T00:00:00Z", "2026-08-18T00:00:00Z"));
  db.close();
});
