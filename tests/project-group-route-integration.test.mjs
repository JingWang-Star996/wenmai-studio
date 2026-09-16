import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Miniflare, NoOpLog, Request as MiniflareRequest } from "miniflare";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const origin = "http://[::1]:3000";
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

async function compiledModules() {
  const staticPath = path.join(root, "dist", "server", "_next", "static");
  const names = await readdir(staticPath);
  const sources = await Promise.all(names.filter((name) => name.endsWith(".js")).map(async (name) => ({
    name,
    contents: await readFile(path.join(staticPath, name), "utf8"),
    modified: (await stat(path.join(staticPath, name))).mtimeMs,
  })));
  const route = (marker) => {
    const match = sources.find((source) => source.name.startsWith("route-") && source.contents.includes(marker));
    assert.ok(match, `production build 缺少 ${marker}`);
    return match;
  };
  const api = route("PROJECT_GROUP_NOT_INITIALIZED");
  const auth = route("PAIRING_CODE_REQUIRED");
  const newestSource = Math.max(...await Promise.all([
    "app/api/project-group/v1/route.ts",
    "app/project-group-model.ts",
    "drizzle/0030_project_groups.sql",
    "package.json",
  ].map(async (file) => (await stat(path.join(root, file))).mtimeMs)));
  assert.ok(api.modified >= newestSource, "production build 早于 ProjectGroup 源码或迁移");
  const entry = `import * as auth from ${JSON.stringify(`./${auth.name}`)};
import * as api from ${JSON.stringify(`./${api.name}`)};
export default { async fetch(request) {
  const pathname = new URL(request.url).pathname;
  const mod = pathname === "/api/auth" ? auth : pathname === "/api/project-group/v1" ? api : null;
  const handler = mod?.[request.method];
  const headers = new Headers(request.headers);
  headers.set("host", "[::1]:3000");
  return handler ? handler(new Request(request, { headers })) : new Response("not found", { status: 404 });
}};`;
  return [
    { type: "ESModule", path: "project-group-test-worker.mjs", contents: entry },
    ...sources.map((source) => ({ type: "ESModule", path: source.name, contents: source.contents })),
  ];
}

function request(pathname, init = {}) {
  const headers = new Headers(init.headers);
  headers.set("host", "[::1]:3000");
  headers.set("x-forwarded-host", "[::1]:3000");
  return new MiniflareRequest(`${origin}${pathname}`, { redirect: "manual", ...init, headers });
}

async function createHarness() {
  const selector = randomBytes(16).toString("base64url");
  const pairingCode = `wenmai1.${selector}.${randomBytes(16).toString("base64url")}`;
  const browserBinding = randomBytes(32).toString("base64url");
  const now = new Date();
  const mf = new Miniflare({
    modules: await compiledModules(),
    compatibilityDate: "2026-05-15",
    compatibilityFlags: ["nodejs_compat"],
    publicUrl: origin,
    d1Databases: { DB: `project-group-${randomUUID()}` },
    log: new NoOpLog(),
    bindings: {
      WENMAI_AUTH_CANONICAL_ORIGIN: origin,
      WENMAI_AUTH_BOOT_ID: `boot-${selector}`,
      WENMAI_AUTH_CHALLENGE_ID: `management-challenge-${selector}`,
      WENMAI_AUTH_PAIRING_SHA256: sha256(pairingCode),
      WENMAI_AUTH_CHALLENGE_CREATED_AT: now.toISOString(),
      WENMAI_AUTH_CHALLENGE_EXPIRES_AT: new Date(now.getTime() + 300_000).toISOString(),
      WENMAI_AUTH_CSRF_HMAC_KEY: randomBytes(32).toString("base64url"),
    },
  });
  return { mf, pairingCode, browserBinding };
}

async function migrate(mf, through = 30) {
  const db = await mf.getD1Database("DB");
  const names = (await readdir(path.join(root, "drizzle")))
    .filter((name) => /^\d{4}_.+\.sql$/u.test(name) && Number(name.slice(0, 4)) <= through)
    .sort();
  for (const name of names) {
    const sql = await readFile(path.join(root, "drizzle", name), "utf8");
    for (const statement of sql.split("--> statement-breakpoint").map((value) => value.trim()).filter(Boolean)) {
      await db.prepare(statement).run();
    }
  }
  return db;
}

async function ownerSession(harness) {
  const bindingHeaders = { "X-Wenmai-Browser-Binding": harness.browserBinding };
  await harness.mf.dispatchFetch(request("/api/auth", { headers: bindingHeaders }));
  const response = await harness.mf.dispatchFetch(request("/api/auth", {
    method: "POST",
    headers: {
      ...bindingHeaders,
      "content-type": "application/json",
      origin,
      "sec-fetch-site": "same-origin",
    },
    body: JSON.stringify({
      action: "bootstrap",
      pairingCode: harness.pairingCode,
      browserBindingSha256: sha256(harness.browserBinding),
    }),
  }));
  const body = await response.json();
  assert.equal(response.status, 201, JSON.stringify(body));
  return { cookie: response.headers.get("set-cookie").split(";", 1)[0], csrf: body.data.csrfToken };
}

async function post(harness, session, action, commandId, payload, extraHeaders = {}) {
  const response = await harness.mf.dispatchFetch(request("/api/project-group/v1", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin,
      "sec-fetch-site": "same-origin",
      cookie: session.cookie,
      "X-Wenmai-CSRF": session.csrf,
      "X-Wenmai-Browser-Binding": harness.browserBinding,
      "X-Wenmai-Write": "1",
      ...extraHeaders,
    },
    body: JSON.stringify({ action, commandId, payload }),
  }));
  return { response, body: await response.json() };
}

async function get(harness, session, query) {
  const response = await harness.mf.dispatchFetch(request(`/api/project-group/v1?${query}`, {
    headers: {
      cookie: session.cookie,
      "X-Wenmai-Browser-Binding": harness.browserBinding,
    },
  }));
  return { response, body: await response.json() };
}

async function seedProjects(db) {
  const at = "2026-09-04T00:00:00.000Z";
  for (const suffix of ["a", "b", "c", "d"]) {
    await db.prepare("INSERT INTO lifecycle_article_projects(id,article_id,title,intent,owner,phase,execution_state,lock_version,created_at,updated_at) VALUES(?,?,?,?,?,'planning','active',1,?,?)")
      .bind(`project-${suffix}`, `article-${suffix}`, `Article ${suffix}`, "", "owner", at, at)
      .run();
  }
}

function expectError(result, status, code) {
  assert.equal(result.response.status, status, JSON.stringify(result.body));
  assert.equal(result.body.error.code, code, JSON.stringify(result.body));
}

test("0029-only schema fails closed with 503 and does not create ProjectGroup tables", async () => {
  const harness = await createHarness();
  try {
    const db = await migrate(harness.mf, 29);
    const session = await ownerSession(harness);
    const read = await get(harness, session, "view=list");
    expectError(read, 503, "PROJECT_GROUP_NOT_INITIALIZED");
    const write = await post(harness, session, "create_group", "group.unready", {
      groupId: "group-unready",
      title: "Unready",
      expectedLockVersion: 1,
    });
    expectError(write, 503, "PROJECT_GROUP_NOT_INITIALIZED");
    assert.equal((await db.prepare("SELECT COUNT(*) count FROM sqlite_master WHERE name LIKE 'project_group%'").first()).count, 0);
  } finally {
    await harness.mf.dispose();
  }
});

test("production route preserves CAS, receipts, domain readback, DAG, FK rollback and append-only evidence", async () => {
  const harness = await createHarness();
  try {
    const db = await migrate(harness.mf);
    const session = await ownerSession(harness);
    await seedProjects(db);

    const createPayload = { groupId: "group-main", title: "Main group", expectedLockVersion: 1 };
    const created = await post(harness, session, "create_group", "group.create", createPayload);
    assert.equal(created.response.status, 200, JSON.stringify(created.body));
    assert.equal(created.body.data.group.lockVersion, 1);
    assert.equal(created.body.data.replayed, false);
    assert.deepEqual(
      await db.prepare("SELECT before_lock_version,after_lock_version FROM project_group_events WHERE command_id='group.create'").first(),
      { before_lock_version: 0, after_lock_version: 1 },
    );

    const countsBeforeReplay = await db.prepare("SELECT (SELECT COUNT(*) FROM project_groups) groups,(SELECT COUNT(*) FROM project_group_events) events,(SELECT COUNT(*) FROM project_group_command_receipts) receipts").first();
    const replay = await post(harness, session, "create_group", "group.create", createPayload);
    assert.equal(replay.response.status, 200, JSON.stringify(replay.body));
    assert.equal(replay.body.data.replayed, true);
    assert.deepEqual(await db.prepare("SELECT (SELECT COUNT(*) FROM project_groups) groups,(SELECT COUNT(*) FROM project_group_events) events,(SELECT COUNT(*) FROM project_group_command_receipts) receipts").first(), countsBeforeReplay);
    expectError(await post(harness, session, "create_group", "group.create", { ...createPayload, title: "Changed" }), 409, "COMMAND_ID_REUSED");

    let lock = 1;
    for (const suffix of ["a", "b", "c"]) {
      const result = await post(harness, session, "add_member", `member.${suffix}`, {
        groupId: "group-main",
        expectedLockVersion: lock,
        articleId: `article-${suffix}`,
        articleProjectId: `project-${suffix}`,
      });
      assert.equal(result.response.status, 200, JSON.stringify(result.body));
      lock += 1;
      assert.equal(result.body.data.group.lockVersion, lock);
      assert.ok(result.body.data.topology.members.some((member) => member.articleId === `article-${suffix}`));
    }

    const beforeBadMember = await db.prepare("SELECT (SELECT lock_version FROM project_groups WHERE id='group-main') lock_version,(SELECT COUNT(*) FROM project_group_members WHERE group_id='group-main') members,(SELECT COUNT(*) FROM project_group_events WHERE group_id='group-main') events,(SELECT COUNT(*) FROM project_group_command_receipts) receipts").first();
    const badMember = await post(harness, session, "add_member", "member.bad-fk", {
      groupId: "group-main",
      expectedLockVersion: lock,
      articleId: "article-not-owned",
      articleProjectId: "project-d",
    });
    assert.equal(badMember.response.status, 500, JSON.stringify(badMember.body));
    assert.equal(badMember.body.error.code, "INTERNAL_ERROR");
    assert.deepEqual(await db.prepare("SELECT (SELECT lock_version FROM project_groups WHERE id='group-main') lock_version,(SELECT COUNT(*) FROM project_group_members WHERE group_id='group-main') members,(SELECT COUNT(*) FROM project_group_events WHERE group_id='group-main') events,(SELECT COUNT(*) FROM project_group_command_receipts) receipts").first(), beforeBadMember);

    for (const [sourceArticleId, targetArticleId] of [["article-a", "article-b"], ["article-b", "article-c"]]) {
      const result = await post(harness, session, "add_edge", `edge.${sourceArticleId}.${targetArticleId}`, {
        groupId: "group-main",
        expectedLockVersion: lock,
        sourceArticleId,
        targetArticleId,
      });
      assert.equal(result.response.status, 200, JSON.stringify(result.body));
      lock += 1;
      assert.equal(result.body.data.group.lockVersion, lock);
    }

    expectError(await post(harness, session, "add_edge", "edge.cycle", {
      groupId: "group-main",
      expectedLockVersion: lock,
      sourceArticleId: "article-c",
      targetArticleId: "article-a",
    }), 409, "CYCLE_REJECTED");
    expectError(await post(harness, session, "add_edge", "edge.cross-group", {
      groupId: "group-main",
      expectedLockVersion: lock,
      sourceArticleId: "article-a",
      targetArticleId: "article-d",
    }), 409, "CROSS_GROUP_EDGE");
    expectError(await post(harness, session, "update_group", "group.stale", {
      groupId: "group-main",
      title: "Stale",
      expectedLockVersion: lock - 1,
    }), 409, "LOCK_CONFLICT");
    assert.equal((await db.prepare("SELECT lock_version FROM project_groups WHERE id='group-main'").first()).lock_version, lock);

    expectError(await post(harness, session, "remove_member", "member.with-edge", {
      groupId: "group-main",
      expectedLockVersion: lock,
      articleId: "article-b",
    }), 409, "MEMBER_HAS_EDGES");

    for (const [sourceArticleId, targetArticleId] of [["article-a", "article-b"], ["article-b", "article-c"]]) {
      const result = await post(harness, session, "remove_edge", `edge.remove.${sourceArticleId}.${targetArticleId}`, {
        groupId: "group-main",
        expectedLockVersion: lock,
        sourceArticleId,
        targetArticleId,
      });
      assert.equal(result.response.status, 200, JSON.stringify(result.body));
      lock += 1;
      assert.equal(result.body.data.group.lockVersion, lock);
      assert.ok(!result.body.data.topology.edges.some((edge) => edge.sourceArticleId === sourceArticleId && edge.targetArticleId === targetArticleId));
    }
    const removed = await post(harness, session, "remove_member", "member.remove.b", {
      groupId: "group-main",
      expectedLockVersion: lock,
      articleId: "article-b",
    });
    assert.equal(removed.response.status, 200, JSON.stringify(removed.body));
    lock += 1;
    assert.equal(removed.body.data.group.lockVersion, lock);
    assert.ok(!removed.body.data.topology.members.some((member) => member.articleId === "article-b"));

    const detail = await get(harness, session, "view=detail&groupId=group-main");
    assert.equal(detail.response.status, 200, JSON.stringify(detail.body));
    assert.equal(detail.body.data.integrityStatus, "valid");
    assert.equal(detail.body.data.group.lockVersion, lock);
    assert.equal(detail.body.data.storedTopologySha256, detail.body.data.recomputedTopologySha256);
    const byArticle = await get(harness, session, "view=by-article&articleId=article-a");
    assert.equal(byArticle.response.status, 200, JSON.stringify(byArticle.body));
    assert.equal(byArticle.body.data.groups.length, 1);

    const concurrentPayload = { groupId: "group-concurrent", title: "Concurrent", expectedLockVersion: 1 };
    const [left, right] = await Promise.all([
      post(harness, session, "create_group", "group.concurrent", concurrentPayload),
      post(harness, session, "create_group", "group.concurrent", concurrentPayload),
    ]);
    assert.deepEqual([left.response.status, right.response.status], [200, 200]);
    assert.deepEqual([left.body.data.replayed, right.body.data.replayed].sort(), [false, true]);
    assert.equal((await db.prepare("SELECT COUNT(*) count FROM project_groups WHERE id='group-concurrent'").first()).count, 1);
    assert.equal((await db.prepare("SELECT COUNT(*) count FROM project_group_events WHERE command_id='group.concurrent'").first()).count, 1);
    assert.equal((await db.prepare("SELECT COUNT(*) count FROM project_group_command_receipts WHERE command_id='group.concurrent'").first()).count, 1);

    await assert.rejects(db.prepare("UPDATE project_group_events SET event_type='changed' WHERE command_id='group.create'").run());
    await assert.rejects(db.prepare("DELETE FROM project_group_events WHERE command_id='group.create'").run());
    await assert.rejects(db.prepare("UPDATE project_group_command_receipts SET status_code=201 WHERE command_id='group.create'").run());
    await assert.rejects(db.prepare("DELETE FROM project_group_command_receipts WHERE command_id='group.create'").run());

    await db.prepare("DROP TRIGGER project_group_events_no_update").run();
    expectError(await get(harness, session, "view=list"), 503, "PROJECT_GROUP_NOT_INITIALIZED");
  } finally {
    await harness.mf.dispose();
  }
});
