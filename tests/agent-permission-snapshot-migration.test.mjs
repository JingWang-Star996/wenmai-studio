import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const migration = await readFile(path.join(root, "drizzle", "0019_agent_permission_snapshot.sql"), "utf8");
const migration0023 = await readFile(path.join(root, "drizzle", "0023_site_full_control_management_session.sql"), "utf8");

const administratorScopes = ["task.read", "context.read", "knowledge.read", "graph.read", "package.read", "task.manage"];
const superAdminV1Scopes = [...administratorScopes, "approval.decide", "graph.decide", "package.patch.decide", "package.patch.apply", "workspace.publication_branch.create", "package.branch.attach", "publication.version.register", "workspace.merge.prepare", "workspace.merge.resolve", "workspace.merge.apply", "publish.capability.consume"];
const superAdminV2Scopes = [...superAdminV1Scopes, "workspace.branch.write", "package.working_copy.save", "package.revision.commit"];

const legacyAgentClientsSql = `CREATE TABLE agent_clients (
  id text PRIMARY KEY NOT NULL,
  label text NOT NULL,
  client_kind text DEFAULT 'custom' NOT NULL,
  token_sha256 text NOT NULL,
  scopes_json text DEFAULT '[]' NOT NULL,
  article_ids_json text DEFAULT '[]' NOT NULL,
  task_ids_json text DEFAULT '[]' NOT NULL,
  status text DEFAULT 'active' NOT NULL,
  expires_at text NOT NULL,
  last_seen_at text,
  created_at text NOT NULL,
  revoked_at text,
  CONSTRAINT agent_clients_status_check CHECK(status IN ('active','revoked'))
);
CREATE UNIQUE INDEX idx_agent_clients_token_sha256 ON agent_clients (token_sha256);
CREATE INDEX idx_agent_clients_status_expiry ON agent_clients (status, expires_at);`;

function fresh0018Database() {
  const db = new DatabaseSync(":memory:");
  db.exec(legacyAgentClientsSql);
  const insert = db.prepare(`INSERT INTO agent_clients
    (id, label, client_kind, token_sha256, scopes_json, article_ids_json, task_ids_json, status, expires_at, last_seen_at, created_at, revoked_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  insert.run("active-client", "active client", "codex", "a".repeat(64), '["task.read"]', '["article-a"]', '["task-a"]', "active", "2026-09-01T00:00:00.000Z", "2026-08-25T11:00:00.000Z", "2026-08-25T10:00:00.000Z", null);
  insert.run("revoked-client", "revoked client", "mcp", "b".repeat(64), '["task.manage"]', '["article-b"]', '["task-b"]', "revoked", "2026-09-02T00:00:00.000Z", null, "2026-08-24T10:00:00.000Z", "2026-08-25T12:00:00.000Z");
  return db;
}

function applyMigration(db) {
  for (const statement of migration.split("--> statement-breakpoint").map((value) => value.trim()).filter(Boolean)) db.exec(statement);
}

function apply0023Migration(db) {
  for (const statement of migration0023.split("--> statement-breakpoint").map((value) => value.trim()).filter(Boolean)) db.exec(statement);
}

function insertClient(db, { id, scopes, articleIds = ["*"], taskIds = [] }) {
  db.prepare(`INSERT INTO agent_clients
    (id, label, client_kind, token_sha256, scopes_json, article_ids_json, task_ids_json, status, expires_at, last_seen_at, created_at, revoked_at)
    VALUES (?, ?, 'codex', ?, ?, ?, ?, 'active', '2026-09-01T00:00:00.000Z', NULL, '2026-08-25T10:00:00.000Z', NULL)`)
    .run(id, `${id} label`, id.padEnd(64, "x"), JSON.stringify(scopes), JSON.stringify(articleIds), JSON.stringify(taskIds));
}

function roles(db) {
  return Object.fromEntries(db.prepare("SELECT id, role FROM agent_clients ORDER BY id").all().map((row) => [row.id, row.role]));
}

test("0019 从精确 0018 agent_clients 形状升级，保留旧字段并把角色安全设为 agent", () => {
  const db = fresh0018Database();
  applyMigration(db);

  const rows = db.prepare(`SELECT id, label, client_kind, role, token_sha256, scopes_json, article_ids_json, task_ids_json,
    status, expires_at, last_seen_at, created_at, revoked_at FROM agent_clients ORDER BY id`).all().map((row) => ({ ...row }));
  assert.deepEqual(rows, [
    { id: "active-client", label: "active client", client_kind: "codex", role: "agent", token_sha256: "a".repeat(64), scopes_json: '["task.read"]', article_ids_json: '["article-a"]', task_ids_json: '["task-a"]', status: "active", expires_at: "2026-09-01T00:00:00.000Z", last_seen_at: "2026-08-25T11:00:00.000Z", created_at: "2026-08-25T10:00:00.000Z", revoked_at: null },
    { id: "revoked-client", label: "revoked client", client_kind: "mcp", role: "agent", token_sha256: "b".repeat(64), scopes_json: '["task.manage"]', article_ids_json: '["article-b"]', task_ids_json: '["task-b"]', status: "revoked", expires_at: "2026-09-02T00:00:00.000Z", last_seen_at: null, created_at: "2026-08-24T10:00:00.000Z", revoked_at: "2026-08-25T12:00:00.000Z" },
  ]);

  const indexes = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'agent_clients'").all().map((row) => row.name));
  assert.ok(indexes.has("idx_agent_clients_token_sha256"));
  assert.ok(indexes.has("idx_agent_clients_status_expiry"));
  assert.throws(() => db.exec("INSERT INTO agent_clients (id,label,client_kind,role,token_sha256,scopes_json,article_ids_json,task_ids_json,status,expires_at,created_at) VALUES ('bad-role','bad','custom','owner','c','[]','[]','[]','active','2026-09-03T00:00:00.000Z','2026-08-25T10:00:00.000Z')"));
  assert.throws(() => db.exec("INSERT INTO agent_clients (id,label,client_kind,role,token_sha256,scopes_json,article_ids_json,task_ids_json,status,expires_at,created_at) VALUES ('bad-status','bad','custom','agent','d','[]','[]','[]','pending','2026-09-03T00:00:00.000Z','2026-08-25T10:00:00.000Z')"));

  const snapshotColumns = new Set(db.prepare("PRAGMA table_info(agent_client_permission_snapshots)").all().map((row) => row.name));
  for (const column of ["client_id", "schema_version", "catalog_version", "preset_id", "role", "scopes_json", "action_ids_json", "article_ids_json", "task_ids_json", "snapshot_json", "snapshot_sha256", "created_at"]) assert.ok(snapshotColumns.has(column));
  assert.throws(() => db.exec("INSERT INTO agent_client_permission_snapshots (client_id,schema_version,catalog_version,preset_id,role,scopes_json,action_ids_json,article_ids_json,task_ids_json,snapshot_json,snapshot_sha256,created_at) VALUES ('bad-snapshot',2,'catalog','preset','administrator','[]','[]','[]','[]','{}','e','2026-08-25T10:00:00.000Z')"));
  applyMigration(db);
  assert.deepEqual(roles(db), { "active-client": "agent", "revoked-client": "agent" });
  db.close();
});

test("0019 无 snapshot 时仅按 exact administrator、v1/v2 super_admin 合同恢复角色", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(legacyAgentClientsSql);
  insertClient(db, { id: "administrator", scopes: administratorScopes });
  insertClient(db, { id: "super-v1", scopes: superAdminV1Scopes });
  insertClient(db, { id: "super-v2", scopes: superAdminV2Scopes });
  insertClient(db, { id: "extra-scope", scopes: [...administratorScopes, "task.claim"] });
  insertClient(db, { id: "duplicate-scope", scopes: [...administratorScopes.slice(0, -1), "task.read", "task.read"] });
  insertClient(db, { id: "missing-scope", scopes: administratorScopes.slice(0, -1) });
  insertClient(db, { id: "wrong-object", scopes: administratorScopes, articleIds: ["article-a"] });
  applyMigration(db);
  assert.deepEqual(roles(db), {
    administrator: "administrator", "duplicate-scope": "agent", "extra-scope": "agent", "missing-scope": "agent",
    "super-v1": "super_admin", "super-v2": "super_admin", "wrong-object": "agent",
  });
  db.close();
});

test("0019 对已有 v3 snapshot 表仅恢复精确镜像的合法角色", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(legacyAgentClientsSql);
  db.exec(`CREATE TABLE agent_client_permission_snapshots (
    client_id text PRIMARY KEY NOT NULL, schema_version integer NOT NULL, catalog_version text NOT NULL, preset_id text NOT NULL,
    role text NOT NULL, scopes_json text NOT NULL, action_ids_json text NOT NULL, article_ids_json text NOT NULL,
    task_ids_json text NOT NULL, snapshot_json text NOT NULL, snapshot_sha256 text NOT NULL, created_at text NOT NULL,
    CONSTRAINT snapshot_schema_check CHECK(schema_version = 3)
  )`);
  insertClient(db, { id: "v3-good", scopes: ["task.read"], articleIds: ["article-a"] });
  insertClient(db, { id: "v3-mirror-bad", scopes: ["task.read"], articleIds: ["article-b"] });
  insertClient(db, { id: "v3-role-bad", scopes: ["task.read"], articleIds: ["article-c"] });
  const insertSnapshot = db.prepare(`INSERT INTO agent_client_permission_snapshots
    (client_id,schema_version,catalog_version,preset_id,role,scopes_json,action_ids_json,article_ids_json,task_ids_json,snapshot_json,snapshot_sha256,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
  insertSnapshot.run("v3-good", 3, "catalog", "preset", "administrator", '["task.read"]', "[]", '["article-a"]', "[]", "{}", "a".repeat(64), "2026-08-25T10:00:00.000Z");
  insertSnapshot.run("v3-mirror-bad", 3, "catalog", "preset", "super_admin", '["task.manage"]', "[]", '["article-b"]', "[]", "{}", "b".repeat(64), "2026-08-25T10:00:00.000Z");
  insertSnapshot.run("v3-role-bad", 3, "catalog", "preset", "owner", '["task.read"]', "[]", '["article-c"]', "[]", "{}", "c".repeat(64), "2026-08-25T10:00:00.000Z");
  applyMigration(db);
  assert.deepEqual(roles(db), { "v3-good": "administrator", "v3-mirror-bad": "agent", "v3-role-bad": "agent" });
  db.close();
});

test("0019 兼容 runtime-bootstrap 已有 role 列，但不盲信旧角色", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE agent_clients (
    id text PRIMARY KEY NOT NULL, label text NOT NULL, client_kind text DEFAULT 'custom' NOT NULL,
    role text DEFAULT 'agent' NOT NULL, token_sha256 text NOT NULL, scopes_json text DEFAULT '[]' NOT NULL,
    article_ids_json text DEFAULT '[]' NOT NULL, task_ids_json text DEFAULT '[]' NOT NULL,
    status text DEFAULT 'active' NOT NULL, expires_at text NOT NULL, last_seen_at text, created_at text NOT NULL, revoked_at text,
    CONSTRAINT agent_clients_role_check CHECK(role IN ('agent','administrator','super_admin')),
    CONSTRAINT agent_clients_status_check CHECK(status IN ('active','revoked'))
  ); CREATE UNIQUE INDEX idx_agent_clients_token_sha256 ON agent_clients (token_sha256);
  CREATE INDEX idx_agent_clients_status_expiry ON agent_clients (status, expires_at);`);
  const insert = db.prepare(`INSERT INTO agent_clients
    (id,label,client_kind,role,token_sha256,scopes_json,article_ids_json,task_ids_json,status,expires_at,last_seen_at,created_at,revoked_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  insert.run("bootstrap-v1", "bootstrap v1", "mcp", "super_admin", "a".repeat(64), JSON.stringify(superAdminV1Scopes), '["*"]', "[]", "active", "2026-09-01T00:00:00.000Z", "2026-08-25T11:00:00.000Z", "2026-08-25T10:00:00.000Z", null);
  insert.run("bootstrap-forged", "bootstrap forged", "codex", "super_admin", "b".repeat(64), JSON.stringify([...superAdminV1Scopes, "task.claim"]), '["*"]', "[]", "active", "2026-09-02T00:00:00.000Z", null, "2026-08-24T10:00:00.000Z", null);
  const preserved = db.prepare(`SELECT id,label,client_kind,token_sha256,scopes_json,article_ids_json,task_ids_json,
    status,expires_at,last_seen_at,created_at,revoked_at FROM agent_clients WHERE id='bootstrap-v1'`).get();
  applyMigration(db);
  assert.equal(roles(db)["bootstrap-v1"], "super_admin");
  assert.equal(roles(db)["bootstrap-forged"], "agent");
  assert.deepEqual(db.prepare(`SELECT id,label,client_kind,token_sha256,scopes_json,article_ids_json,task_ids_json,
    status,expires_at,last_seen_at,created_at,revoked_at FROM agent_clients WHERE id='bootstrap-v1'`).get(), preserved);
  db.close();
});

test("0023 为 v3 Key 与管理会话添加兑换来源列，不重写既有权限快照", () => {
  const db = fresh0018Database();
  applyMigration(db);
  db.exec(`CREATE TABLE management_sessions (
    id text PRIMARY KEY NOT NULL, principal_id text NOT NULL, token_sha256 text NOT NULL,
    browser_binding_sha256 text NOT NULL, scopes_json text NOT NULL, article_ids_json text NOT NULL,
    object_boundary_json text NOT NULL, status text NOT NULL, absolute_expires_at text NOT NULL,
    idle_expires_at text NOT NULL, last_seen_at text NOT NULL, created_at text NOT NULL,
    revoked_at text, revoke_reason text
  ); INSERT INTO management_sessions
    (id,principal_id,token_sha256,browser_binding_sha256,scopes_json,article_ids_json,object_boundary_json,status,absolute_expires_at,idle_expires_at,last_seen_at,created_at)
    VALUES ('session-before-0023','principal','t','b','["management.read"]','["*"]','{}','active','2026-09-01T00:00:00.000Z','2026-08-28T00:00:00.000Z','2026-08-27T00:00:00.000Z','2026-08-27T00:00:00.000Z');`);
  apply0023Migration(db);
  const clientColumns = new Set(db.prepare("PRAGMA table_info(agent_clients)").all().map((row) => row.name));
  for (const column of ["credential_purpose", "issued_by_source_client_id", "exchange_generation"]) assert.ok(clientColumns.has(column));
  const sessionColumns = new Set(db.prepare("PRAGMA table_info(management_sessions)").all().map((row) => row.name));
  for (const column of ["auth_basis", "authority_class", "source_client_id", "source_key_expires_at", "source_exchange_generation", "source_permission_snapshot_sha256"]) assert.ok(sessionColumns.has(column));
  assert.deepEqual(
    { ...db.prepare("SELECT auth_basis,authority_class,source_client_id,source_permission_snapshot_sha256 FROM management_sessions WHERE id='session-before-0023'").get() },
    { auth_basis: "owner_pairing", authority_class: "owner", source_client_id: null, source_permission_snapshot_sha256: null },
  );
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM agent_client_permission_snapshots").get().count, 0);
  db.close();
});
