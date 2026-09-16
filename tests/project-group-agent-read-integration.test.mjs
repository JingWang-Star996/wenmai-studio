import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Miniflare, NoOpLog, Request as MiniflareRequest } from "miniflare";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const origin = "http://[::1]:3000";
const sha = (value) => createHash("sha256").update(value).digest("hex");
const request = (pathname, init = {}) => {
  const headers = new Headers(init.headers);
  headers.set("host", "[::1]:3000");
  headers.set("x-forwarded-host", "[::1]:3000");
  return new MiniflareRequest(`${origin}${pathname}`, { redirect: "manual", ...init, headers });
};

async function compiled() {
  const base = path.join(root, "dist", "server", "_next", "static");
  const sources = await Promise.all((await readdir(base))
    .filter((name) => name.endsWith(".js"))
    .map(async (name) => ({ name, contents: await readFile(path.join(base, name), "utf8"), modified: await stat(path.join(base, name)) })));
  const route = sources.find((source) => source.name.startsWith("route-") && source.contents.includes("Wenmai Agent Control Plane"));
  assert.ok(route, "production build 缺少 Agent API 路由");
  const sourceModified = await stat(path.join(root, "app", "api", "agent", "v1", "route.ts"));
  assert.ok(route.modified.mtimeMs >= sourceModified.mtimeMs, "FRESH_BUILD_REQUIRED: Agent API production route 早于源文件");
  return [
    {
      type: "ESModule",
      path: "pg-agent-test.mjs",
      contents: `import * as agent from ${JSON.stringify(`./${route.name}`)}; export default { fetch(r) { const h=new Headers(r.headers); h.set('host','[::1]:3000'); return agent[r.method](new Request(r,{headers:h})); } };`,
    },
    ...sources.map((source) => ({ type: "ESModule", path: source.name, contents: source.contents })),
  ];
}

async function body(response) { return { response, payload: await response.json() }; }

async function migrate0030(db) {
  const names = (await readdir(path.join(root, "drizzle")))
    .filter((name) => /^\d{4}_.+\.sql$/u.test(name) && Number(name.slice(0, 4)) <= 30)
    .sort();
  for (const name of names) {
    const sql = await readFile(path.join(root, "drizzle", name), "utf8");
    for (const statement of sql.split("--> statement-breakpoint").map((value) => value.trim()).filter(Boolean)) {
      await db.prepare(statement).run();
    }
  }
}

async function seedClient(db, token, articleIds, scopes = ["package.read"]) {
  const id = `client-${randomUUID()}`;
  const now = new Date().toISOString();
  const expiry = new Date(Date.now() + 86_400_000).toISOString();
  await db.prepare("INSERT INTO agent_clients(id,label,client_kind,role,token_sha256,scopes_json,article_ids_json,task_ids_json,status,expires_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)")
    .bind(id, "test", "codex", "agent", sha(token), JSON.stringify(scopes), JSON.stringify(articleIds), "[]", "active", expiry, now).run();
  return id;
}

async function seedManagementSession(db, token, browserBinding) {
  const now = "2026-09-04T00:00:00.000Z";
  await db.prepare("INSERT INTO management_sessions(id,principal_id,token_sha256,browser_binding_sha256,scopes_json,article_ids_json,object_boundary_json,status,absolute_expires_at,idle_expires_at,last_seen_at,created_at,revoke_reason) VALUES('project-group-valid-management','owner',?,?,?,?,?,'active',?,?,?,?, '')")
    .bind(sha(token), sha(browserBinding), '["management.read"]', '["*"]', "{}", "2099-01-01T00:00:00.000Z", "2099-01-01T00:00:00.000Z", now, now).run();
}

async function seedGroup(db, id, members) {
  const now = "2026-09-04T00:00:00.000Z";
  const topology = {
    schemaVersion: "wenmai.project-group-topology/1",
    groupId: id,
    members: [...members].sort((left, right) => left.articleId.localeCompare(right.articleId)),
    edges: members.length > 1 ? [{ sourceArticleId: members[0].articleId, targetArticleId: members[1].articleId, relationType: "precedes" }] : [],
  };
  for (const member of members) {
    await db.prepare("INSERT INTO lifecycle_article_projects(id,article_id,title,intent,owner,phase,execution_state,lock_version,created_at,updated_at) VALUES(?,?,?,?,?,'planning','active',1,?,?)")
      .bind(member.articleProjectId, member.articleId, member.articleId, "", "owner", now, now).run();
  }
  await db.prepare("INSERT INTO project_groups(id,title,status,topology_sha256,lock_version,created_by,created_at,updated_at) VALUES(?,?,'active',?,1,'owner',?,?)")
    .bind(id, `${id} title`, sha(JSON.stringify(topology)), now, now).run();
  for (const member of members) {
    await db.prepare("INSERT INTO project_group_members(id,group_id,article_id,article_project_id,created_at) VALUES(?,?,?,?,?)")
      .bind(`member-${id}-${member.articleId}`, id, member.articleId, member.articleProjectId, now).run();
  }
  for (const edge of topology.edges) {
    await db.prepare("INSERT INTO project_group_edges(id,group_id,source_article_id,target_article_id,relation_type,created_at) VALUES(?,?,?,?,?,?)")
      .bind(`edge-${id}`, id, edge.sourceArticleId, edge.targetArticleId, edge.relationType, now).run();
  }
}

function get(token, query, headers = {}) {
  return request(`/api/agent/v1?${query}`, { headers: { authorization: `Bearer ${token}`, ...headers } });
}

test("Agent ProjectGroup 读取是有界摘要/完整详情，并严格执行空组与完整成员 scope", async (t) => {
  const mf = new Miniflare({
    modules: await compiled(),
    compatibilityDate: "2026-05-15",
    compatibilityFlags: ["nodejs_compat"],
    publicUrl: origin,
    d1Databases: { DB: `pg-agent-${randomUUID()}` },
    log: new NoOpLog(),
  });
  t.after(() => mf.dispose());
  const db = await mf.getD1Database("DB");
  await migrate0030(db);
  const boot = await body(await mf.dispatchFetch(request("/api/agent/v1?view=health")));
  assert.equal(boot.response.status, 401);

  const star = `token-${randomBytes(12).toString("hex")}`;
  const full = `token-${randomBytes(12).toString("hex")}`;
  const partial = `token-${randomBytes(12).toString("hex")}`;
  const none = `token-${randomBytes(12).toString("hex")}`;
  const starClientId = await seedClient(db, star, ["*"]);
  await seedClient(db, full, ["article-a", "article-b"]);
  await seedClient(db, partial, ["article-a"]);
  await seedClient(db, none, ["article-a"], []);

  await seedGroup(db, "group-full", [
    { articleId: "article-a", articleProjectId: "project-a" },
    { articleId: "article-b", articleProjectId: "project-b" },
  ]);
  await seedGroup(db, "group-empty", []);
  await seedGroup(db, "group-overflow", Array.from({ length: 257 }, (_, index) => ({
    articleId: `overflow-article-${String(index).padStart(3, "0")}`,
    articleProjectId: `overflow-project-${String(index).padStart(3, "0")}`,
  })));

  const businessSnapshotSql = "SELECT (SELECT COUNT(*) FROM project_groups) groups_count,(SELECT COUNT(*) FROM project_group_members) members_count,(SELECT COUNT(*) FROM project_group_edges) edges_count,(SELECT COUNT(*) FROM project_group_events) events_count,(SELECT COUNT(*) FROM project_group_command_receipts) receipts_count";
  const businessBefore = await db.prepare(businessSnapshotSql).first();
  const lastSeenBefore = await db.prepare("SELECT last_seen_at FROM agent_clients WHERE id=?").bind(starClientId).first();

  const starList = await body(await mf.dispatchFetch(get(star, "view=project_groups")));
  assert.equal(starList.response.status, 200, JSON.stringify(starList.payload));
  assert.deepEqual(starList.payload.data.groups.map((entry) => entry.group.id), ["group-empty", "group-full", "group-overflow"]);
  for (const entry of starList.payload.data.groups) {
    assert.deepEqual(Object.keys(entry).sort(), ["detailRequiredForTopology", "edgeCount", "group", "memberCount", "storedTopologySha256"].sort());
    assert.equal(entry.detailRequiredForTopology, true);
    for (const forbidden of ["members", "edges", "topology", "integrityStatus", "recomputedTopologySha256"]) {
      assert.equal(forbidden in entry, false);
    }
  }
  const fullSummary = starList.payload.data.groups.find((entry) => entry.group.id === "group-full");
  assert.equal(fullSummary.memberCount, 2);
  assert.equal(fullSummary.edgeCount, 1);
  assert.match(fullSummary.storedTopologySha256, /^[a-f0-9]{64}$/u);

  const fullList = await body(await mf.dispatchFetch(get(full, "view=project_groups")));
  assert.deepEqual(fullList.payload.data.groups.map((entry) => entry.group.id), ["group-full"]);
  const partialList = await body(await mf.dispatchFetch(get(partial, "view=project_groups")));
  assert.equal(partialList.response.status, 200);
  assert.deepEqual(partialList.payload.data.groups, []);

  for (const token of [star, full]) {
    const detail = await body(await mf.dispatchFetch(get(token, "view=project_group&groupId=group-full")));
    assert.equal(detail.response.status, 200, JSON.stringify(detail.payload));
    assert.equal(detail.payload.data.readOnly, true);
    assert.equal(detail.payload.data.integrityStatus, "valid");
    assert.equal(detail.payload.data.members.length, 2);
  }
  const emptyStar = await body(await mf.dispatchFetch(get(star, "view=project_group&groupId=group-empty")));
  assert.equal(emptyStar.response.status, 200, JSON.stringify(emptyStar.payload));
  assert.deepEqual(emptyStar.payload.data.members, []);
  const emptyRestricted = await body(await mf.dispatchFetch(get(full, "view=project_group&groupId=group-empty")));
  assert.equal(emptyRestricted.response.status, 403);
  assert.equal(emptyRestricted.payload.error.code, "OBJECT_SCOPE_DENIED");
  assert.doesNotMatch(JSON.stringify(emptyRestricted.payload), /group-empty|group-empty title|topologySha/i);

  const detailPartial = await body(await mf.dispatchFetch(get(partial, "view=project_group&groupId=group-full")));
  assert.equal(detailPartial.response.status, 403);
  assert.equal(detailPartial.payload.error.code, "OBJECT_SCOPE_DENIED");
  assert.doesNotMatch(JSON.stringify(detailPartial.payload), /group-full title|topologySha/i);
  const filterDenied = await body(await mf.dispatchFetch(get(partial, "view=project_groups&articleId=article-b")));
  assert.equal(filterDenied.response.status, 403);
  assert.equal(filterDenied.payload.error.code, "OBJECT_SCOPE_DENIED");

  const overflow = await body(await mf.dispatchFetch(get(star, "view=project_group&groupId=group-overflow")));
  assert.equal(overflow.response.status, 409, JSON.stringify(overflow.payload));
  assert.equal(overflow.payload.error.code, "PROJECT_GROUP_READ_LIMIT_EXCEEDED");
  assert.equal(overflow.payload.data, undefined);

  const noScope = await body(await mf.dispatchFetch(get(none, "view=project_groups")));
  assert.equal(noScope.response.status, 403);
  assert.equal(noScope.payload.error.code, "SCOPE_DENIED");
  const managementToken = randomBytes(24).toString("base64url");
  const managementBinding = randomBytes(32).toString("base64url");
  await seedManagementSession(db, managementToken, managementBinding);
  const noBearer = await body(await mf.dispatchFetch(request("/api/agent/v1?view=project_groups", {
    headers: {
      cookie: "wenmai_management_session=" + managementToken,
      origin,
      "X-Wenmai-Browser-Binding": managementBinding,
    },
  })));
  assert.equal(noBearer.response.status, 401);
  assert.equal(noBearer.payload.error.code, "AUTH_REQUIRED");
  const bearerWithCookie = await body(await mf.dispatchFetch(get(star, "view=project_groups", { cookie: "management=ignored", origin })));
  assert.equal(bearerWithCookie.response.status, 200);
  assert.equal(bearerWithCookie.payload.data.readOnly, true);

  assert.deepEqual(await db.prepare(businessSnapshotSql).first(), businessBefore);
  const lastSeenAfter = await db.prepare("SELECT last_seen_at FROM agent_clients WHERE id=?").bind(starClientId).first();
  assert.notEqual(lastSeenAfter.last_seen_at, lastSeenBefore.last_seen_at);
});
