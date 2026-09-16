import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const drizzleDir = path.join(root, "drizzle");
const migrationNames = (await readdir(drizzleDir)).filter((name) => /^\d{4}_.+\.sql$/u.test(name)).sort();
const migration0030 = "0030_project_groups.sql";
const migrationIndex = migrationNames.indexOf(migration0030);
const snapshot0029 = JSON.parse(await readFile(path.join(drizzleDir, "meta", "0029_snapshot.json"), "utf8"));
const snapshot0030 = JSON.parse(await readFile(path.join(drizzleDir, "meta", "0030_snapshot.json"), "utf8"));
const journal = JSON.parse(await readFile(path.join(drizzleDir, "meta", "_journal.json"), "utf8"));
const sha = "a".repeat(64);
const at = "2026-09-04T00:00:00.000Z";

async function statements(name) {
  return (await readFile(path.join(drizzleDir, name), "utf8"))
    .split("--> statement-breakpoint")
    .map((value) => value.trim())
    .filter(Boolean);
}

async function apply(db, names) {
  for (const name of names) for (const sql of await statements(name)) db.exec(sql);
}

function projectRow(id, articleId) {
  return [id, articleId, articleId, "", "owner", at, at];
}

test("0030 is the generated linear ProjectGroup migration and fresh SQLite remains valid", async () => {
  assert.match(migrationNames[migrationIndex + 1], /^0031_.+\.sql$/u);
  assert.equal(snapshot0030.prevId, snapshot0029.id);
  assert.equal(Object.keys(snapshot0030.tables).length, 101);
  assert.deepEqual(snapshot0030.tables.lifecycle_article_projects.indexes.idx_lifecycle_article_projects_id_article, {
    name: "idx_lifecycle_article_projects_id_article",
    columns: ["id", "article_id"],
    isUnique: true,
  });
  assert.equal(journal.entries.find((entry) => entry.tag === "0030_project_groups")?.idx, 30);

  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  await apply(db, migrationNames);
  assert.equal(db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  for (const table of ["project_groups", "project_group_members", "project_group_edges", "project_group_events", "project_group_command_receipts"]) {
    assert.equal(db.prepare("SELECT COUNT(*) count FROM sqlite_master WHERE type='table' AND name=?").get(table).count, 1);
  }
  assert.deepEqual(
    db.prepare("SELECT name FROM pragma_index_info('idx_lifecycle_article_projects_id_article') ORDER BY seqno").all().map((row) => row.name),
    ["id", "article_id"],
  );
  db.close();
});

test("0029 to 0030 upgrade preserves projects, enforces composite membership, and keeps evidence append-only", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  await apply(db, migrationNames.slice(0, migrationIndex));
  db.prepare("INSERT INTO lifecycle_article_projects(id,article_id,title,intent,owner,phase,execution_state,lock_version,created_at,updated_at) VALUES(?,?,?,?,?,'planning','active',1,?,?)")
    .run(...projectRow("project-a", "article-a"));
  await apply(db, [migration0030]);

  assert.equal(db.prepare("SELECT article_id FROM lifecycle_article_projects WHERE id='project-a'").get().article_id, "article-a");
  db.prepare("INSERT INTO project_groups(id,title,status,topology_sha256,lock_version,created_by,created_at,updated_at) VALUES('group-a','Group','active',?,1,'owner',?,?)")
    .run(sha, at, at);
  db.prepare("INSERT INTO project_group_members(id,group_id,article_id,article_project_id,created_at) VALUES('member-a','group-a','article-a','project-a',?)")
    .run(at);
  assert.throws(() => db.prepare("INSERT INTO project_group_members(id,group_id,article_id,article_project_id,created_at) VALUES('member-bad','group-a','article-b','project-a',?)").run(at));

  db.prepare("INSERT INTO project_group_events(id,group_id,event_type,actor_id,command_id,request_sha256,before_lock_version,after_lock_version,result_topology_sha256,details_json,created_at) VALUES('event-a','group-a','create_group','owner','command-a',?,0,1,?,'{}',?)")
    .run(sha, sha, at);
  db.prepare("INSERT INTO project_group_command_receipts(command_id,action,actor_id,request_sha256,mutation_readback_json,result_lock_version,topology_sha256,status,status_code,created_at,completed_at) VALUES('command-a','create_group','owner',?,'{}',1,?,'succeeded',200,?,?)")
    .run(sha, sha, at, at);
  assert.throws(() => db.exec("UPDATE project_group_events SET event_type='changed' WHERE id='event-a'"));
  assert.throws(() => db.exec("DELETE FROM project_group_events WHERE id='event-a'"));
  assert.throws(() => db.exec("UPDATE project_group_command_receipts SET status_code=201 WHERE command_id='command-a'"));
  assert.throws(() => db.exec("DELETE FROM project_group_command_receipts WHERE command_id='command-a'"));
  assert.equal(db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  db.close();
});
