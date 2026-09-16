import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test from "node:test";

import { Miniflare, NoOpLog, Request as MiniflareRequest } from "miniflare";

const projectRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const staticPath = path.join(projectRoot, "dist", "server", "_next", "static");
const canonicalOrigin = "http://[::1]:3000";

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

// Keep byte-for-byte parity with the production canonicalJson implementation.
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function request(pathname, init = {}) {
  const headers = new Headers(init.headers);
  headers.set("host", "[::1]:3000");
  if (!headers.has("x-forwarded-host")) headers.set("x-forwarded-host", "[::1]:3000");
  return new MiniflareRequest(`${canonicalOrigin}${pathname}`, { redirect: "manual", ...init, headers });
}

async function json(response) {
  const raw = await response.text();
  try { return { response, payload: JSON.parse(raw) }; } catch { throw new Error(`Expected JSON (${response.status}): ${raw.slice(0, 240)}`); }
}

function cookieFrom(response) {
  return (response.headers.get("set-cookie") ?? "").split(";", 1)[0];
}

async function compiledRouteModules() {
  const names = (await readdir(staticPath)).filter((name) => name.endsWith(".js"));
  const sources = await Promise.all(names.map(async (name) => ({ name, contents: await readFile(path.join(staticPath, name), "utf8") })));
  const findRoute = (marker) => {
    const source = sources.find((item) => item.name.startsWith("route-") && item.contents.includes(marker));
    assert.ok(source, `production bundle missing route marker: ${marker}`);
    return `./${source.name}`;
  };
  const auth = findRoute("PAIRING_CODE_REQUIRED");
  const agent = findRoute("Wenmai Agent Control Plane");
  return [
    { type: "ESModule", path: "agent-permission-snapshot-worker.mjs", contents: `
      import * as auth from ${JSON.stringify(auth)};
      import * as agent from ${JSON.stringify(agent)};
      export default { async fetch(request) {
        const route = new URL(request.url).pathname === "/api/auth" ? auth
          : new URL(request.url).pathname === "/api/agent/v1" ? agent : null;
        const headers = new Headers(request.headers); headers.set("host", "[::1]:3000");
        const routedRequest = new Request(request, { headers });
        return route?.[request.method] ? route[request.method](routedRequest) : new Response("not found", { status: 404 });
      } };
    ` },
    ...sources.map((source) => ({ type: "ESModule", path: source.name, contents: source.contents })),
  ];
}

async function createHarness() {
  const selector = randomBytes(16).toString("base64url");
  const secret = randomBytes(16).toString("base64url");
  const pairingCode = `wenmai1.${selector}.${secret}`;
  const browserBinding = randomBytes(32).toString("base64url");
  const bootId = `snapshot-test-${randomUUID()}`;
  const createdAt = new Date();
  const mf = new Miniflare({
    modules: await compiledRouteModules(), compatibilityDate: "2026-05-15", compatibilityFlags: ["nodejs_compat"],
    publicUrl: canonicalOrigin, d1Databases: { DB: `agent-permission-snapshot-${randomUUID()}` }, d1Persist: false,
    bindings: {
      WENMAI_AUTH_CANONICAL_ORIGIN: canonicalOrigin, WENMAI_AUTH_BOOT_ID: bootId,
      WENMAI_AUTH_CHALLENGE_ID: `management-challenge-${selector}`, WENMAI_AUTH_PAIRING_SHA256: sha256(pairingCode),
      WENMAI_AUTH_CHALLENGE_CREATED_AT: createdAt.toISOString(), WENMAI_AUTH_CHALLENGE_EXPIRES_AT: new Date(createdAt.getTime() + 300000).toISOString(),
      WENMAI_AUTH_CSRF_HMAC_KEY: randomBytes(32).toString("base64url"),
    }, log: new NoOpLog(),
  });
  return { mf, pairingCode, browserBinding, browserBindingSha256: sha256(browserBinding), bootId };
}

async function ownerSession(harness) {
  const initial = await json(await harness.mf.dispatchFetch(request("/api/auth")));
  assert.equal(initial.response.status, 200);
  const result = await json(await harness.mf.dispatchFetch(request("/api/auth", {
    method: "POST", headers: { "content-type": "application/json", origin: canonicalOrigin, "sec-fetch-site": "same-origin", "X-Wenmai-Browser-Binding": harness.browserBinding },
    body: JSON.stringify({ action: "bootstrap", pairingCode: harness.pairingCode, browserBindingSha256: harness.browserBindingSha256 }),
  })));
  assert.equal(result.response.status, 201, JSON.stringify(result.payload));
  return { cookie: cookieFrom(result.response), csrf: result.payload.data.csrfToken };
}

function ownerHeaders(harness, session) {
  return { "content-type": "application/json", cookie: session.cookie, origin: canonicalOrigin, "sec-fetch-site": "same-origin", "X-Wenmai-Browser-Binding": harness.browserBinding, "X-Wenmai-CSRF": session.csrf, "X-Wenmai-Write": "1" };
}

async function issue(harness, session, payload) {
  return json(await harness.mf.dispatchFetch(request("/api/agent/v1", { method: "POST", headers: ownerHeaders(harness, session), body: JSON.stringify({ action: "issue_client", commandId: `snapshot-test-${randomUUID()}`, payload }) })));
}

async function revoke(harness, session, clientId) {
  return json(await harness.mf.dispatchFetch(request("/api/agent/v1", {
    method: "POST",
    headers: ownerHeaders(harness, session),
    body: JSON.stringify({
      action: "revoke_client",
      commandId: `snapshot-test-revoke-${randomUUID()}`,
      payload: { clientId, note: "share grant integration regression" },
    }),
  })));
}

function bearerHeaders(token) {
  return { authorization: `Bearer ${token}` };
}

async function insertLiveD1Article(db, { articleId, suffix = randomUUID() }) {
  const packageId = `share-package-${suffix}`;
  const branchId = `share-branch-${suffix}`;
  const firstRevisionId = `share-revision-one-${suffix}`;
  const secondRevisionId = `share-revision-two-${suffix}`;
  const firstBody = `D1 live article one ${suffix}`;
  const secondBody = `D1 live article two ${suffix}`;
  const now = new Date().toISOString();
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS article_project_packages (
      id TEXT PRIMARY KEY NOT NULL, project_id TEXT, article_id TEXT NOT NULL, title TEXT NOT NULL,
      schema_version TEXT NOT NULL DEFAULT 'wenmai-package-v1', branch_model_version INTEGER, primary_branch_id TEXT,
      main_composition_id TEXT NOT NULL, main_composition_sha256 TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active', lock_version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    )`),
    db.prepare(`INSERT INTO article_project_packages
      (id, article_id, title, schema_version, branch_model_version, primary_branch_id, main_composition_id, main_composition_sha256, status, lock_version, created_at, updated_at)
      VALUES (?, ?, ?, 'wenmai-package-v1', 2, ?, ?, ?, 'active', 1, ?, ?)`)
      .bind(packageId, articleId, `D1 share ${suffix}`, branchId, `composition-${suffix}`, sha256(`composition-${suffix}`), now, now),
    db.prepare(`INSERT INTO article_revisions
      (id, article_id, branch_id, sequence, parent_revision_id, title, document_title, body_text, body_sha256, author_kind, created_at)
      VALUES (?, ?, ?, 1, NULL, ?, ?, ?, ?, 'user', ?)`)
      .bind(firstRevisionId, articleId, branchId, `D1 share ${suffix}`, `D1 share ${suffix}`, firstBody, sha256(firstBody), now),
    db.prepare(`INSERT INTO article_branches
      (id, article_id, name, slug, status, head_revision_id, base_revision_id, created_at, updated_at)
      VALUES (?, ?, 'main', ?, 'active', ?, ?, ?, ?)`)
      .bind(branchId, articleId, `share-${suffix}`, firstRevisionId, firstRevisionId, now, now),
  ]);
  return { packageId, branchId, firstRevisionId, secondRevisionId, firstBody, secondBody, now };
}

async function advanceLiveD1Article(db, live) {
  await db.batch([
    db.prepare(`INSERT INTO article_revisions
      (id, article_id, branch_id, sequence, parent_revision_id, title, document_title, body_text, body_sha256, author_kind, created_at)
      SELECT ?, article_id, id, 2, ?, 'D1 live revision two', 'D1 live revision two', ?, ?, 'user', ?
      FROM article_branches WHERE id = ?`)
      .bind(live.secondRevisionId, live.firstRevisionId, live.secondBody, sha256(live.secondBody), live.now, live.branchId),
    db.prepare("UPDATE article_branches SET head_revision_id = ?, updated_at = ? WHERE id = ?")
      .bind(live.secondRevisionId, live.now, live.branchId),
  ]);
}

async function insertShareTask(db, { taskId, articleId, targetBranchId = null, permissionCeiling, state = "queued" }) {
  const now = new Date().toISOString();
  await db.prepare(`INSERT INTO agent_tasks
    (id, article_id, target_branch_id, title, objective, instructions_md, acceptance_json, context_spec_json, permission_ceiling_json, priority, state, lock_version, created_by, created_at, updated_at)
    VALUES (?, ?, ?, 'share editor task', 'share editor task', '', '[]', '{}', ?, 'P2', ?, 1, 'user', ?, ?)`)
    .bind(taskId, articleId, targetBranchId, JSON.stringify(permissionCeiling), state, now, now).run();
}

async function health(harness, token) {
  return json(await harness.mf.dispatchFetch(request("/api/agent/v1?view=health", { headers: { authorization: `Bearer ${token}` } })));
}

async function exchangeSiteFullControl(harness, token, commandId = `site-full-control-exchange:${randomUUID()}`) {
  return json(await harness.mf.dispatchFetch(request("/api/auth", {
    method: "POST",
    headers: {
      accept: "application/json",
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      origin: canonicalOrigin,
      "sec-fetch-site": "same-origin",
      "X-Wenmai-Browser-Binding": harness.browserBinding,
    },
    body: JSON.stringify({ action: "site_full_control.exchange", browserBindingSha256: harness.browserBindingSha256, exchangeCommandId: commandId }),
  })));
}

test("资源级 viewer 通行证只读精确文章，拒绝 scope 漂移并在撤销后失效", async (context) => {
  const harness = await createHarness();
  context.after(() => harness.mf.dispose());
  const session = await ownerSession(harness);
  const catalog = await json(await harness.mf.dispatchFetch(request("/api/agent/v1?view=permission_catalog&includeArticles=1", {
    headers: { cookie: session.cookie, "X-Wenmai-Browser-Binding": harness.browserBinding },
  })));
  assert.equal(catalog.response.status, 200, JSON.stringify(catalog.payload));
  const articleId = catalog.payload.data.catalog.articleObjects[0]?.id;
  assert.ok(articleId, "permission_catalog must expose an existing shareable article");

  const granted = await issue(harness, session, {
    label: "resource share viewer",
    clientKind: "custom",
    scopes: ["article.read"],
    articleScope: { mode: "selected_articles", articleIds: [articleId] },
    articleIds: [articleId],
    taskIds: [],
  });
  assert.equal(granted.response.status, 201, JSON.stringify(granted.payload));
  const { client, token } = granted.payload.data;
  assert.deepEqual(client.scopes, ["article.read"]);
  assert.deepEqual(client.articleIds, [articleId]);
  assert.deepEqual(client.taskIds, []);

  const list = await json(await harness.mf.dispatchFetch(request("/api/agent/v1?view=articles", {
    headers: { authorization: `Bearer ${token}` },
  })));
  assert.equal(list.response.status, 200, JSON.stringify(list.payload));
  assert.deepEqual(list.payload.data.articles.map((article) => article.id), [articleId]);
  assert.equal("bodyText" in list.payload.data.articles[0], false, "article list must remain summary-only");

  const detail = await json(await harness.mf.dispatchFetch(request(`/api/agent/v1?view=article&articleId=${encodeURIComponent(articleId)}`, {
    headers: { authorization: `Bearer ${token}` },
  })));
  assert.equal(detail.response.status, 200, JSON.stringify(detail.payload));
  assert.equal(detail.payload.data.article.id, articleId);
  assert.equal(sha256(detail.payload.data.article.bodyText), detail.payload.data.article.bodySha256);

  const outOfScope = await json(await harness.mf.dispatchFetch(request("/api/agent/v1?view=article&articleId=article-outside-share-grant", {
    headers: { authorization: `Bearer ${token}` },
  })));
  assert.equal(outOfScope.response.status, 404, JSON.stringify(outOfScope.payload));
  assert.equal(outOfScope.payload.error.code, "SHARED_ARTICLE_NOT_FOUND");

  const db = await harness.mf.getD1Database("DB");
  await db.prepare("UPDATE agent_clients SET scopes_json = ? WHERE id = ?").bind('["article.read","task.read"]', client.id).run();
  const drifted = await json(await harness.mf.dispatchFetch(request("/api/agent/v1?view=articles", {
    headers: { authorization: `Bearer ${token}` },
  })));
  assert.equal(drifted.response.status, 403, JSON.stringify(drifted.payload));
  assert.equal(drifted.payload.error.code, "SHARE_SCOPE_INVALID");

  await db.prepare("UPDATE agent_clients SET scopes_json = ? WHERE id = ?").bind('["article.read"]', client.id).run();
  const revoked = await revoke(harness, session, client.id);
  assert.equal(revoked.response.status, 200, JSON.stringify(revoked.payload));
  const afterRevoke = await json(await harness.mf.dispatchFetch(request("/api/agent/v1?view=articles", {
    headers: { authorization: `Bearer ${token}` },
  })));
  assert.equal(afterRevoke.response.status, 401, JSON.stringify(afterRevoke.payload));
  assert.equal(afterRevoke.payload.error.code, "AUTH_INVALID");

  const createdTask = await json(await harness.mf.dispatchFetch(request("/api/agent/v1", {
    method: "POST",
    headers: ownerHeaders(harness, session),
    body: JSON.stringify({
      action: "create_task",
      commandId: `snapshot-share-task-${randomUUID()}`,
      payload: {
        articleId,
        title: "资源级 editor 通行证回归",
        objective: "验证 editor 只能绑定当前文章的一项未终结任务。",
        instructionsMd: "只向任务专属 Agent 分支提交候选。",
        acceptance: ["任务终结后通行证拒绝访问"],
        contextSpec: { graphDepth: 1, body: "current" },
        writeScope: "agent-branch",
        permissionCeiling: { allow: ["article.read", "task.progress", "artifact.create", "branch.agent_write"] },
        priority: "P2",
      },
    }),
  })));
  assert.equal(createdTask.response.status, 201, JSON.stringify(createdTask.payload));
  const editorTaskId = createdTask.payload.data.task.id;
  const editorGrant = await issue(harness, session, {
    label: "resource share editor",
    clientKind: "custom",
    scopes: ["article.read", "task.read", "task.claim", "task.progress", "context.read", "artifact.create", "approval.request", "branch.agent_write"],
    articleScope: { mode: "selected_articles", articleIds: [articleId] },
    articleIds: [articleId],
    taskIds: [editorTaskId],
  });
  assert.equal(editorGrant.response.status, 201, JSON.stringify(editorGrant.payload));
  assert.equal(editorGrant.payload.data.client.collaborationAccessMode, "editor");
  const editorRead = await json(await harness.mf.dispatchFetch(request("/api/agent/v1?view=articles", {
    headers: { authorization: `Bearer ${editorGrant.payload.data.token}` },
  })));
  assert.equal(editorRead.response.status, 200, JSON.stringify(editorRead.payload));
  await db.prepare("UPDATE agent_tasks SET state = 'succeeded' WHERE id = ?").bind(editorTaskId).run();
  const terminalTaskRead = await json(await harness.mf.dispatchFetch(request("/api/agent/v1?view=articles", {
    headers: { authorization: `Bearer ${editorGrant.payload.data.token}` },
  })));
  assert.equal(terminalTaskRead.response.status, 403, JSON.stringify(terminalTaskRead.payload));
  assert.equal(terminalTaskRead.payload.error.code, "SHARE_TASK_INVALID");
});

test("viewer health 是可用于 discovery 前置鉴权的最小当前身份投影", async (context) => {
  const harness = await createHarness();
  context.after(() => harness.mf.dispose());
  const session = await ownerSession(harness);
  const catalog = await json(await harness.mf.dispatchFetch(request("/api/agent/v1?view=permission_catalog&includeArticles=1", {
    headers: { cookie: session.cookie, "X-Wenmai-Browser-Binding": harness.browserBinding },
  })));
  const articleId = catalog.payload.data.catalog.articleObjects[0]?.id;
  assert.ok(articleId);
  const granted = await issue(harness, session, {
    label: "viewer minimal health", clientKind: "custom", scopes: ["article.read"],
    articleScope: { mode: "selected_articles", articleIds: [articleId] }, articleIds: [articleId], taskIds: [],
  });
  assert.equal(granted.response.status, 201, JSON.stringify(granted.payload));
  const healthResponse = await json(await harness.mf.dispatchFetch(request("/api/agent/v1?view=health", {
    headers: bearerHeaders(granted.payload.data.token),
  })));
  assert.equal(healthResponse.response.status, 200, JSON.stringify(healthResponse.payload));
  assert.equal(healthResponse.payload.data.minimal, true);
  assert.equal(healthResponse.payload.data.clients.length, 1);
  assert.equal(healthResponse.payload.data.clients[0].id, granted.payload.data.client.id);
  assert.equal("counts" in healthResponse.payload.data, false);
});

test("viewer 优先读取 D1 当前主分支，随 head 更新且不回退 corpus", async (context) => {
  const harness = await createHarness();
  context.after(() => harness.mf.dispose());
  const session = await ownerSession(harness);
  const schemaReady = await json(await harness.mf.dispatchFetch(request("/api/agent/v1?view=permission_catalog&includeArticles=1", {
    headers: { cookie: session.cookie, "X-Wenmai-Browser-Binding": harness.browserBinding },
  })));
  assert.equal(schemaReady.response.status, 200, JSON.stringify(schemaReady.payload));
  const db = await harness.mf.getD1Database("DB");
  const articleId = schemaReady.payload.data.catalog.articleObjects[0]?.id;
  assert.ok(articleId, "fixture needs a corpus article ID so D1 priority is observable");
  const live = await insertLiveD1Article(db, { articleId });
  const granted = await issue(harness, session, {
    label: "D1 live viewer", clientKind: "custom", scopes: ["article.read"],
    articleScope: { mode: "selected_articles", articleIds: [articleId] }, articleIds: [articleId], taskIds: [],
  });
  assert.equal(granted.response.status, 201, JSON.stringify(granted.payload));
  const first = await json(await harness.mf.dispatchFetch(request(`/api/agent/v1?view=article&articleId=${articleId}`, {
    headers: bearerHeaders(granted.payload.data.token),
  })));
  assert.equal(first.response.status, 200, JSON.stringify(first.payload));
  assert.equal(first.payload.data.article.source.kind, "d1");
  assert.equal(first.payload.data.article.bodyText, live.firstBody);
  assert.equal(first.payload.data.article.bodySha256, sha256(live.firstBody));

  await advanceLiveD1Article(db, live);
  const advanced = await json(await harness.mf.dispatchFetch(request(`/api/agent/v1?view=article&articleId=${articleId}`, {
    headers: bearerHeaders(granted.payload.data.token),
  })));
  assert.equal(advanced.response.status, 200, JSON.stringify(advanced.payload));
  assert.equal(advanced.payload.data.article.source.kind, "d1");
  assert.equal(advanced.payload.data.article.revisionId, live.secondRevisionId);
  assert.equal(advanced.payload.data.article.bodyText, live.secondBody);
  assert.equal(advanced.payload.data.article.bodySha256, sha256(live.secondBody));

  await db.prepare("UPDATE article_project_packages SET status = 'archived' WHERE id = ?").bind(live.packageId).run();
  const inactive = await json(await harness.mf.dispatchFetch(request(`/api/agent/v1?view=article&articleId=${articleId}`, {
    headers: bearerHeaders(granted.payload.data.token),
  })));
  assert.equal(inactive.response.status, 409, JSON.stringify(inactive.payload));
  assert.equal(inactive.payload.error.code, "SHARED_ARTICLE_SOURCE_AMBIGUOUS", "inactive D1 package must not fall back to the same-ID corpus record");
  await db.prepare("UPDATE article_project_packages SET status = 'active' WHERE id = ?").bind(live.packageId).run();

  await db.prepare("UPDATE article_revisions SET body_sha256 = ? WHERE id = ?").bind("0".repeat(64), live.secondRevisionId).run();
  const hashMismatch = await json(await harness.mf.dispatchFetch(request(`/api/agent/v1?view=article&articleId=${articleId}`, {
    headers: bearerHeaders(granted.payload.data.token),
  })));
  assert.equal(hashMismatch.response.status, 409, JSON.stringify(hashMismatch.payload));
  assert.equal(hashMismatch.payload.error.code, "SHARED_ARTICLE_SOURCE_INVALID");
  await db.prepare("UPDATE article_revisions SET body_sha256 = ? WHERE id = ?").bind(sha256(live.secondBody), live.secondRevisionId).run();

  await db.prepare("UPDATE article_project_packages SET id = ? WHERE id = ?").bind(`${live.packageId}-duplicate`, live.packageId).run();
  await db.prepare(`INSERT INTO article_project_packages
    (id, article_id, title, schema_version, branch_model_version, primary_branch_id, main_composition_id, main_composition_sha256, status, lock_version, created_at, updated_at)
    VALUES (?, ?, 'ambiguous share package', 'wenmai-package-v1', 2, ?, 'composition-duplicate', ?, 'active', 1, ?, ?)`)
    .bind(live.packageId, articleId, live.branchId, sha256("composition-duplicate"), live.now, live.now).run();
  const ambiguous = await issue(harness, session, {
    label: "ambiguous D1 viewer", clientKind: "custom", scopes: ["article.read"],
    articleScope: { mode: "selected_articles", articleIds: [articleId] }, articleIds: [articleId], taskIds: [],
  });
  assert.equal(ambiguous.response.status, 409, JSON.stringify(ambiguous.payload));
});

test("editor Share Grant 仅绑定当前有效 Agent Branch 任务，并在运行时重验", async (context) => {
  const harness = await createHarness();
  context.after(() => harness.mf.dispose());
  const session = await ownerSession(harness);
  const catalog = await json(await harness.mf.dispatchFetch(request("/api/agent/v1?view=permission_catalog&includeArticles=1", {
    headers: { cookie: session.cookie, "X-Wenmai-Browser-Binding": harness.browserBinding },
  })));
  const articleId = catalog.payload.data.catalog.articleObjects[0]?.id;
  assert.ok(articleId);
  const db = await harness.mf.getD1Database("DB");
  const editorScopes = ["article.read", "task.read", "task.claim", "task.progress", "context.read", "artifact.create", "approval.request", "branch.agent_write"];
  const issueEditor = async (taskId) => issue(harness, session, {
    label: `editor ${taskId}`, clientKind: "custom", scopes: editorScopes,
    articleScope: { mode: "selected_articles", articleIds: [articleId] }, articleIds: [articleId], taskIds: [taskId],
  });

  for (const [writeScope, allow] of [["artifact-only", []], ["graph-proposal", []], ["agent-branch", []]]) {
    const taskId = `share-invalid-${writeScope}-${randomUUID()}`;
    await insertShareTask(db, { taskId, articleId, permissionCeiling: { writeScope, allow } });
    const rejected = await issueEditor(taskId);
    assert.equal(rejected.response.status, 400, JSON.stringify(rejected.payload));
    assert.equal(rejected.payload.error.code, "SHARE_TASK_INVALID");
  }

  const createdTask = await json(await harness.mf.dispatchFetch(request("/api/agent/v1", {
    method: "POST",
    headers: ownerHeaders(harness, session),
    body: JSON.stringify({
      action: "create_task",
      commandId: `share-valid-create-${randomUUID()}`,
      payload: {
        articleId,
        title: "valid shared Agent Branch task",
        objective: "verify resource share task binding",
        writeScope: "agent-branch",
        permissionCeiling: { allow: ["article.read", "task.progress", "artifact.create", "branch.agent_write"] },
        priority: "P2",
      },
    }),
  })));
  assert.equal(createdTask.response.status, 201, JSON.stringify(createdTask.payload));
  const validTaskId = createdTask.payload.data.task.id;
  const validBranchId = createdTask.payload.data.agentBranch.id;
  const granted = await issueEditor(validTaskId);
  assert.equal(granted.response.status, 201, JSON.stringify(granted.payload));
  const token = granted.payload.data.token;
  const assertRuntimeRejected = async () => {
    const response = await json(await harness.mf.dispatchFetch(request("/api/agent/v1?view=health", { headers: bearerHeaders(token) })));
    assert.equal(response.response.status, 403, JSON.stringify(response.payload));
    assert.equal(response.payload.error.code, "SHARE_TASK_INVALID");
  };
  await db.prepare("UPDATE agent_tasks SET target_branch_id = ? WHERE id = ?").bind("wrong-agent-branch", validTaskId).run();
  await assertRuntimeRejected();
  await db.prepare("UPDATE agent_tasks SET target_branch_id = ? WHERE id = ?").bind(validBranchId, validTaskId).run();
  const validContextId = (await db.prepare("SELECT current_context_snapshot_id AS id FROM agent_tasks WHERE id = ?").bind(validTaskId).first()).id;
  assert.ok(validContextId);
  await db.prepare("UPDATE agent_context_snapshots SET branch_id = ? WHERE id = ?").bind("wrong-context-branch", validContextId).run();
  await assertRuntimeRejected();
  await db.prepare("UPDATE agent_context_snapshots SET branch_id = ? WHERE id = ?").bind(validBranchId, validContextId).run();
  await db.prepare("UPDATE article_branches SET name = 'tampered branch name' WHERE id = ?").bind(validBranchId).run();
  await assertRuntimeRejected();
  await db.prepare("UPDATE article_branches SET name = ? WHERE id = ?").bind(`agent/${validTaskId.replace(/^agent-task-/, "").replaceAll("-", "").slice(0, 12)}`, validBranchId).run();
  await db.prepare("UPDATE article_branches SET slug = 'tampered-branch-slug' WHERE id = ?").bind(validBranchId).run();
  await assertRuntimeRejected();
  await db.prepare("UPDATE article_branches SET slug = ? WHERE id = ?").bind(`agent-${validTaskId.replace(/^agent-task-/, "").replaceAll("-", "").slice(0, 12)}`, validBranchId).run();
  await db.prepare("UPDATE article_branches SET article_id = 'wrong-branch-article' WHERE id = ?").bind(validBranchId).run();
  await assertRuntimeRejected();
  await db.prepare("UPDATE article_branches SET article_id = ? WHERE id = ?").bind(articleId, validBranchId).run();
  await db.prepare("UPDATE article_branches SET status = 'archived' WHERE id = ?").bind(validBranchId).run();
  await assertRuntimeRejected();
  await db.prepare("UPDATE article_branches SET status = 'active' WHERE id = ?").bind(validBranchId).run();
  await db.prepare("UPDATE agent_tasks SET permission_ceiling_json = ? WHERE id = ?").bind('{"writeScope":"artifact-only","allow":[]}', validTaskId).run();
  await assertRuntimeRejected();
  await db.prepare("UPDATE agent_tasks SET permission_ceiling_json = ?, state = 'succeeded' WHERE id = ?")
    .bind('{"writeScope":"agent-branch","allow":["branch.agent_write"]}', validTaskId).run();
  await assertRuntimeRejected();
});

test("agent_clients 自举 schema 在全新与旧表升级时提供根 Key 凭据列", async (context) => {
  const fresh = await createHarness();
  context.after(() => fresh.mf.dispose());
  const freshSession = await ownerSession(fresh);
  const freshIssue = await issue(fresh, freshSession, { label: "fresh schema", clientKind: "custom", scopes: ["task.read"], articleScope: { mode: "all_articles", articleIds: ["*"] }, articleIds: ["*"], taskIds: [] });
  assert.equal(freshIssue.response.status, 201, JSON.stringify(freshIssue.payload));
  const freshDb = await fresh.mf.getD1Database("DB");
  const freshColumns = await freshDb.prepare("PRAGMA table_info(agent_clients)").all();
  for (const name of ["credential_purpose", "issued_by_source_client_id", "exchange_generation"]) assert.ok(freshColumns.results.some((column) => column.name === name), `fresh ${name}`);
  const freshMaster = await freshDb.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'agent_clients'").first();
  assert.match(String(freshMaster.sql), /site_full_control/);
  assert.match(String(freshMaster.sql), /issued_by_source_client_id IS NULL OR issued_by_source_client_id <> id/);
  const freshIndexes = await freshDb.prepare("PRAGMA index_list(agent_clients)").all();
  for (const name of ["idx_agent_clients_token_sha256", "idx_agent_clients_status_expiry", "idx_agent_clients_management_exchange", "idx_agent_clients_source_client"]) {
    assert.ok(freshIndexes.results.some((index) => index.name === name), `fresh ${name}`);
  }
  const freshSql = String(freshMaster.sql);
  const freshRepeat = await issue(fresh, freshSession, { label: "fresh schema repeat", clientKind: "custom", scopes: ["task.read"], articleScope: { mode: "all_articles", articleIds: ["*"] }, articleIds: ["*"], taskIds: [] });
  assert.equal(freshRepeat.response.status, 201, JSON.stringify(freshRepeat.payload));
  assert.equal(String((await freshDb.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'agent_clients'").first()).sql), freshSql);

  const upgraded = await createHarness();
  context.after(() => upgraded.mf.dispose());
  const upgradedDb = await upgraded.mf.getD1Database("DB");
  await upgradedDb.prepare("CREATE TABLE agent_clients (id TEXT PRIMARY KEY NOT NULL, label TEXT NOT NULL, client_kind TEXT NOT NULL DEFAULT 'custom', role TEXT NOT NULL DEFAULT 'agent', token_sha256 TEXT NOT NULL, scopes_json TEXT NOT NULL DEFAULT '[]', article_ids_json TEXT NOT NULL DEFAULT '[]', task_ids_json TEXT NOT NULL DEFAULT '[]', credential_purpose TEXT NOT NULL DEFAULT 'agent_api' CHECK (credential_purpose IN ('agent_api','management_session_exchange')), issued_by_source_client_id TEXT, exchange_generation INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'active', expires_at TEXT NOT NULL, last_seen_at TEXT, created_at TEXT NOT NULL, revoked_at TEXT)").run();
  await upgradedDb.batch([
    upgradedDb.prepare("INSERT INTO agent_clients (id,label,client_kind,role,token_sha256,scopes_json,article_ids_json,task_ids_json,credential_purpose,status,expires_at,created_at) VALUES ('legacy-parent','legacy parent','custom','agent','legacy-token-parent','[]','[]','[]','agent_api','active','2099-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')"),
    upgradedDb.prepare("INSERT INTO agent_clients (id,label,client_kind,role,token_sha256,scopes_json,article_ids_json,task_ids_json,credential_purpose,issued_by_source_client_id,exchange_generation,status,expires_at,created_at) VALUES ('legacy-child','legacy child','mcp','agent','legacy-token-child','[\"task.read\"]','[\"article-a\"]','[]','management_session_exchange','legacy-parent',2,'active','2099-01-02T00:00:00.000Z','2026-01-02T00:00:00.000Z')"),
  ]);
  const upgradedSession = await ownerSession(upgraded);
  const upgradedIssue = await issue(upgraded, upgradedSession, { label: "upgraded schema", clientKind: "custom", scopes: ["task.read"], articleScope: { mode: "all_articles", articleIds: ["*"] }, articleIds: ["*"], taskIds: [] });
  assert.equal(upgradedIssue.response.status, 201, JSON.stringify(upgradedIssue.payload));
  const upgradedColumns = await upgradedDb.prepare("PRAGMA table_info(agent_clients)").all();
  for (const name of ["credential_purpose", "issued_by_source_client_id", "exchange_generation"]) assert.ok(upgradedColumns.results.some((column) => column.name === name), `upgraded ${name}`);
  const legacyRows = await upgradedDb.prepare("SELECT id,label,client_kind,role,scopes_json,article_ids_json,task_ids_json,credential_purpose,issued_by_source_client_id,exchange_generation,status,expires_at,created_at FROM agent_clients WHERE id IN ('legacy-parent','legacy-child') ORDER BY id").all();
  assert.deepEqual(legacyRows.results.map((row) => [row.id, row.label, row.client_kind, row.role, row.scopes_json, row.article_ids_json, row.task_ids_json, row.credential_purpose, row.issued_by_source_client_id, row.exchange_generation, row.status, row.expires_at, row.created_at]), [
    ["legacy-child", "legacy child", "mcp", "agent", '["task.read"]', '["article-a"]', "[]", "management_session_exchange", "legacy-parent", 2, "active", "2099-01-02T00:00:00.000Z", "2026-01-02T00:00:00.000Z"],
    ["legacy-parent", "legacy parent", "custom", "agent", "[]", "[]", "[]", "agent_api", null, 0, "active", "2099-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z"],
  ]);
  const upgradedIndexes = await upgradedDb.prepare("PRAGMA index_list(agent_clients)").all();
  for (const name of ["idx_agent_clients_token_sha256", "idx_agent_clients_status_expiry", "idx_agent_clients_management_exchange", "idx_agent_clients_source_client"]) {
    assert.ok(upgradedIndexes.results.some((index) => index.name === name), `upgraded ${name}`);
  }
  const upgradedMaster = await upgradedDb.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'agent_clients'").first();
  assert.match(String(upgradedMaster.sql), /agent_clients_credential_purpose_check/);
  assert.match(String(upgradedMaster.sql), /'site_full_control'/);
  assert.match(String(upgradedMaster.sql), /agent_clients_lineage_not_self_check/);

  const orphaned = await createHarness();
  context.after(() => orphaned.mf.dispose());
  const orphanedDb = await orphaned.mf.getD1Database("DB");
  await orphanedDb.prepare("CREATE TABLE agent_clients (id TEXT PRIMARY KEY NOT NULL, label TEXT NOT NULL, client_kind TEXT NOT NULL DEFAULT 'custom', role TEXT NOT NULL DEFAULT 'agent', token_sha256 TEXT NOT NULL, scopes_json TEXT NOT NULL DEFAULT '[]', article_ids_json TEXT NOT NULL DEFAULT '[]', task_ids_json TEXT NOT NULL DEFAULT '[]', credential_purpose TEXT NOT NULL DEFAULT 'agent_api' CHECK (credential_purpose IN ('agent_api','management_session_exchange')), issued_by_source_client_id TEXT, exchange_generation INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'active', expires_at TEXT NOT NULL, last_seen_at TEXT, created_at TEXT NOT NULL, revoked_at TEXT)").run();
  await orphanedDb.prepare("INSERT INTO agent_clients (id,label,client_kind,role,token_sha256,scopes_json,article_ids_json,task_ids_json,credential_purpose,issued_by_source_client_id,status,expires_at,created_at) VALUES ('orphaned-legacy','orphaned legacy','custom','agent','legacy-token-orphan','[]','[]','[]','management_session_exchange','missing-parent','active','2099-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')").run();
  const orphanedSession = await ownerSession(orphaned);
  const orphanedIssue = await issue(orphaned, orphanedSession, { label: "must not migrate orphan", clientKind: "custom", scopes: ["task.read"], articleScope: { mode: "all_articles", articleIds: ["*"] }, articleIds: ["*"], taskIds: [] });
  assert.equal(orphanedIssue.response.status, 500);
  assert.equal((await orphanedDb.prepare("SELECT COUNT(*) AS count FROM agent_clients").first()).count, 1);
  assert.doesNotMatch(String((await orphanedDb.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'agent_clients'").first()).sql), /site_full_control/);
});

test("production bundle 的 v3 权限快照签发、篡改拒绝与目录漂移兼容", async (context) => {
  const harness = await createHarness();
  context.after(() => harness.mf.dispose());
  const session = await ownerSession(harness);

  const ordinary = await issue(harness, session, { label: "ordinary snapshot control", clientKind: "custom", scopes: ["task.read"], articleScope: { mode: "selected_articles", articleIds: ["article-pre-signable-but-not-yet-present"] }, articleIds: ["article-pre-signable-but-not-yet-present"], taskIds: [] });
  assert.equal(ordinary.response.status, 201, JSON.stringify(ordinary.payload));
  assert.equal(ordinary.payload.data.client.permissionProfile, null);
  const ordinaryHealth = await health(harness, ordinary.payload.data.token);
  assert.equal(ordinaryHealth.response.status, 200, JSON.stringify(ordinaryHealth.payload));
  assert.equal(ordinaryHealth.payload.data.clients[0].permissionProfile, null);

  const ordinaryAllArticles = await issue(harness, session, { label: "ordinary all articles", clientKind: "custom", scopes: ["task.read"], articleScope: { mode: "all_articles", articleIds: ["*"] }, articleIds: ["*"], taskIds: [] });
  assert.equal(ordinaryAllArticles.response.status, 201, JSON.stringify(ordinaryAllArticles.payload));
  assert.deepEqual(ordinaryAllArticles.payload.data.client.articleIds, ["*"]);
  const ordinaryAllHealth = await health(harness, ordinaryAllArticles.payload.data.token);
  assert.equal(ordinaryAllHealth.response.status, 200, JSON.stringify(ordinaryAllHealth.payload));
  const ordinaryMissingMode = await issue(harness, session, { label: "ordinary missing mode", clientKind: "custom", scopes: ["task.read"], articleIds: ["article-pre-signable-but-not-yet-present"], taskIds: [] });
  assert.equal(ordinaryMissingMode.response.status, 400); assert.equal(ordinaryMissingMode.payload.error.code, "OBJECT_BOUNDARY_REQUIRED");
  const ordinaryMismatchedMirror = await issue(harness, session, { label: "ordinary mismatched mirror", clientKind: "custom", scopes: ["task.read"], articleScope: { mode: "selected_articles", articleIds: ["article-one"] }, articleIds: ["article-two"], taskIds: [] });
  assert.equal(ordinaryMismatchedMirror.response.status, 400); assert.equal(ordinaryMismatchedMirror.payload.error.code, "OBJECT_BOUNDARY_MISMATCH");
  const ordinaryWhitespaceWildcard = await issue(harness, session, { label: "ordinary whitespace wildcard", clientKind: "custom", scopes: ["task.read"], articleScope: { mode: "all_articles", articleIds: [" * "] }, articleIds: [" * "], taskIds: [] });
  assert.equal(ordinaryWhitespaceWildcard.response.status, 400); assert.equal(ordinaryWhitespaceWildcard.payload.error.code, "OBJECT_BOUNDARY_REQUIRED");

  const catalogResponse = await json(await harness.mf.dispatchFetch(request("/api/agent/v1?view=permission_catalog", { headers: { cookie: session.cookie, "X-Wenmai-Browser-Binding": harness.browserBinding } })));
  assert.equal(catalogResponse.response.status, 200, JSON.stringify(catalogResponse.payload));
  assert.equal(typeof catalogResponse.payload.data.catalog.articleObjectCount, "number");
  assert.equal("articleObjects" in catalogResponse.payload.data.catalog, false, "all_articles default must not enumerate the article catalog");
  const catalogWithArticlesResponse = await json(await harness.mf.dispatchFetch(request("/api/agent/v1?view=permission_catalog&includeArticles=1", { headers: { cookie: session.cookie, "X-Wenmai-Browser-Binding": harness.browserBinding } })));
  assert.equal(catalogWithArticlesResponse.response.status, 200, JSON.stringify(catalogWithArticlesResponse.payload));
  const catalog = catalogWithArticlesResponse.payload.data.catalog;
  const articleId = catalog.articleObjects[0]?.id;
  assert.ok(articleId, "permission_catalog must expose an existing article object");
  const preset = catalog.presets.find((item) => item.presetId === "read_admin") ?? catalog.presets.find((item) => item.presetId === "task_admin");
  assert.ok(preset, "permission_catalog must expose read_admin or task_admin");
  const actionIdsFor = (scopes) => [...new Set(scopes.flatMap((scope) => (catalog.scopes.find((item) => item.scope === scope)?.actions ?? []).map((action) => action.actionId)))].sort();
  const validPayload = { label: "v3 snapshot admin", clientKind: "custom", role: "administrator", permissionPresetId: preset.presetId, catalogVersion: catalog.catalogVersion, catalogSha256: catalog.catalogSha256, scopes: preset.scopes, confirmedActionIds: actionIdsFor(preset.scopes), articleScope: { mode: "selected_articles" }, articleIds: [articleId], taskIds: [] };
  const v3 = await issue(harness, session, validPayload);
  assert.equal(v3.response.status, 201, JSON.stringify(v3.payload));
  const profile = v3.payload.data.client.permissionProfile;
  assert.deepEqual(Object.keys(profile).sort(), ["actionIds", "articleIds", "catalogSha256", "catalogVersion", "presetId", "schemaVersion", "snapshotSha256"]);
  assert.equal(profile.schemaVersion, 3); assert.equal(profile.catalogVersion, catalog.catalogVersion); assert.equal(profile.catalogSha256, catalog.catalogSha256); assert.equal(profile.presetId, preset.presetId);
  assert.deepEqual(profile.articleIds, [articleId]); assert.equal(profile.articleIds.includes("*"), false);
  assert.ok(profile.actionIds.length >= 0); assert.match(profile.snapshotSha256, /^[a-f0-9]{64}$/);
  const v3Health = await health(harness, v3.payload.data.token);
  assert.equal(v3Health.response.status, 200, JSON.stringify(v3Health.payload));
  assert.deepEqual(v3Health.payload.data.clients[0].permissionProfile, profile);

  const allArticles = await issue(harness, session, { ...validPayload, label: "v3 all articles admin", articleScope: { mode: "all_articles" }, articleIds: ["*"] });
  assert.equal(allArticles.response.status, 201, JSON.stringify(allArticles.payload));
  assert.deepEqual(allArticles.payload.data.client.permissionProfile.articleIds, ["*"]);
  const allArticlesHealth = await health(harness, allArticles.payload.data.token);
  assert.equal(allArticlesHealth.response.status, 200, JSON.stringify(allArticlesHealth.payload));

  const missingArticleMode = await issue(harness, session, { ...validPayload, label: "missing article mode", articleScope: undefined });
  assert.equal(missingArticleMode.response.status, 400); assert.equal(missingArticleMode.payload.error.code, "OBJECT_BOUNDARY_REQUIRED");
  const wildcardSelected = await issue(harness, session, { ...validPayload, label: "wildcard selected", articleIds: ["*"] });
  assert.equal(wildcardSelected.response.status, 400); assert.equal(wildcardSelected.payload.error.code, "OBJECT_BOUNDARY_REQUIRED");
  const concreteAll = await issue(harness, session, { ...validPayload, label: "concrete all", articleScope: { mode: "all_articles" }, articleIds: [articleId] });
  assert.equal(concreteAll.response.status, 400); assert.equal(concreteAll.payload.error.code, "OBJECT_BOUNDARY_REQUIRED");
  const mismatchedMirror = await issue(harness, session, { ...validPayload, label: "mismatched mirror", articleScope: { mode: "selected_articles", articleIds: ["different-article"] } });
  assert.equal(mismatchedMirror.response.status, 400); assert.equal(mismatchedMirror.payload.error.code, "OBJECT_BOUNDARY_MISMATCH");

  const siteFullControl = catalog.scopes.find((scope) => scope.scope === "site.full_control");
  assert.ok(siteFullControl, "catalog must expose the root management Key scope");
  assert.equal(siteFullControl.newIssuance, true);
  assert.equal(siteFullControl.delegable, true);
  assert.equal(siteFullControl.localOnly, true);
  assert.deepEqual(siteFullControl.actions.map((action) => action.actionId), ["auth.site_full_control.direct", "auth.site_full_control.exchange"]);
  const highRiskScopes = catalog.scopes.filter((scope) => scope.risk === "high_risk" && scope.scope !== "site.full_control");
  assert.equal(highRiskScopes.length, 10, "catalog must retain all ten staged high-risk scopes");
  for (const highRiskScope of highRiskScopes) {
    const isPublishConsumer = highRiskScope.scope === "publish.capability.consume";
    assert.equal(highRiskScope.newIssuance, !isPublishConsumer, highRiskScope.scope);
    assert.equal(highRiskScope.delegable, !isPublishConsumer, highRiskScope.scope);
  }
  const publishConsumer = highRiskScopes.find((scope) => scope.scope === "publish.capability.consume");
  assert.ok(publishConsumer);
  const invalidScope = await issue(harness, session, { ...validPayload, label: "invalid publish ticket consumer", permissionPresetId: "custom", role: "super_admin", scopes: [publishConsumer.scope], confirmedActionIds: actionIdsFor([publishConsumer.scope]) });
  assert.equal(invalidScope.response.status, 400); assert.equal(invalidScope.payload.error.code, "INVALID_SCOPE");
  const duplicate = await issue(harness, session, { ...validPayload, label: "duplicate scope", permissionPresetId: "custom", scopes: ["task.read", "task.read"] });
  assert.equal(duplicate.response.status, 400); assert.equal(duplicate.payload.error.code, "DUPLICATE_SCOPE");
  const stale = await issue(harness, session, { ...validPayload, label: "stale catalog", catalogVersion: "obsolete-catalog-version" });
  assert.equal(stale.response.status, 409); assert.equal(stale.payload.error.code, "PERMISSION_CATALOG_STALE");
  const wrongDigest = await issue(harness, session, { ...validPayload, label: "wrong digest", catalogSha256: "0".repeat(64) });
  assert.equal(wrongDigest.response.status, 409); assert.equal(wrongDigest.payload.error.code, "PERMISSION_CATALOG_STALE");
  const duplicateAction = await issue(harness, session, { ...validPayload, label: "duplicate action", confirmedActionIds: ["agent.v1.create_task", "agent.v1.create_task"] });
  assert.equal(duplicateAction.response.status, 400); assert.equal(duplicateAction.payload.error.code, "CONFIRMED_ACTIONS_INVALID");
  const wrongAction = await issue(harness, session, { ...validPayload, label: "wrong action", confirmedActionIds: ["agent.v1.create_task"] });
  assert.equal(wrongAction.response.status, 409); assert.equal(wrongAction.payload.error.code, "CONFIRMED_ACTIONS_MISMATCH");
  const readOnlyPreset = catalog.presets.find((item) => item.presetId === "read_admin");
  assert.ok(readOnlyPreset);
  const emptyActions = await issue(harness, session, { ...validPayload, label: "empty action read only", permissionPresetId: "read_admin", scopes: readOnlyPreset.scopes, confirmedActionIds: [] });
  assert.equal(emptyActions.response.status, 201, JSON.stringify(emptyActions.payload));
  const taskPreset = catalog.presets.find((item) => item.presetId === "task_admin");
  assert.ok(taskPreset);
  const controlledActions = await issue(harness, session, { ...validPayload, label: "controlled actions", permissionPresetId: "task_admin", scopes: taskPreset.scopes, confirmedActionIds: actionIdsFor(taskPreset.scopes) });
  assert.equal(controlledActions.response.status, 201, JSON.stringify(controlledActions.payload));

  const db = await harness.mf.getD1Database("DB");
  const allClientId = allArticles.payload.data.client.id;
  const allSnapshot = await db.prepare("SELECT * FROM agent_client_permission_snapshots WHERE client_id = ?").bind(allClientId).first();
  assert.ok(allSnapshot);
  const malformedFutureBoundary = JSON.parse(allSnapshot.snapshot_json);
  malformedFutureBoundary.objectBoundary.includesFutureArticles = "true";
  const malformedFutureJson = canonicalJson(malformedFutureBoundary);
  await db.prepare("UPDATE agent_client_permission_snapshots SET snapshot_json = ?, snapshot_sha256 = ? WHERE client_id = ?")
    .bind(malformedFutureJson, sha256(malformedFutureJson), allClientId).run();
  const malformedFutureHealth = await health(harness, allArticles.payload.data.token);
  assert.equal(malformedFutureHealth.response.status, 403); assert.equal(malformedFutureHealth.payload.error.code, "PRIVILEGED_SNAPSHOT_INVALID");

  const v3ClientId = v3.payload.data.client.id;
  const original = await db.prepare("SELECT * FROM agent_client_permission_snapshots WHERE client_id = ?").bind(v3ClientId).first();
  assert.ok(original, "v3 issuance must persist a snapshot in the temporary D1 database");
  await db.prepare("UPDATE agent_client_permission_snapshots SET snapshot_json = ? WHERE client_id = ?").bind("{}", v3ClientId).run();
  const tamperedJson = await health(harness, v3.payload.data.token);
  assert.equal(tamperedJson.response.status, 403); assert.equal(tamperedJson.payload.error.code, "PRIVILEGED_SNAPSHOT_INVALID");
  await db.prepare("UPDATE agent_client_permission_snapshots SET snapshot_json = ?, snapshot_sha256 = ? WHERE client_id = ?").bind(original.snapshot_json, original.snapshot_sha256, v3ClientId).run();
  await db.prepare("UPDATE agent_client_permission_snapshots SET snapshot_sha256 = ? WHERE client_id = ?").bind("0".repeat(64), v3ClientId).run();
  const tamperedHash = await health(harness, v3.payload.data.token);
  assert.equal(tamperedHash.response.status, 403); assert.equal(tamperedHash.payload.error.code, "PRIVILEGED_SNAPSHOT_INVALID");

  const drift = await issue(harness, session, { ...validPayload, label: "catalog drift v3" });
  assert.equal(drift.response.status, 201, JSON.stringify(drift.payload));
  const driftClientId = drift.payload.data.client.id;
  const driftRow = await db.prepare("SELECT * FROM agent_client_permission_snapshots WHERE client_id = ?").bind(driftClientId).first();
  assert.ok(driftRow);
  const oldCatalogVersion = `${catalog.catalogVersion}-historical`;
  const priorSnapshot = JSON.parse(driftRow.snapshot_json);
  const { catalogSha256: removedDigest, ...oldSnapshotBase } = priorSnapshot;
  assert.match(removedDigest, /^[a-f0-9]{64}$/);
  const oldSnapshot = { ...oldSnapshotBase, catalogVersion: oldCatalogVersion };
  const oldSnapshotJson = canonicalJson(oldSnapshot);
  const oldSnapshotSha256 = sha256(oldSnapshotJson);
  // Do not consult or recompute action IDs from today's catalog: the old signed JSON is authoritative.
  await db.prepare("UPDATE agent_client_permission_snapshots SET catalog_version = ?, snapshot_json = ?, snapshot_sha256 = ? WHERE client_id = ?")
    .bind(oldCatalogVersion, oldSnapshotJson, oldSnapshotSha256, driftClientId).run();
  const driftHealth = await health(harness, drift.payload.data.token);
  assert.equal(driftHealth.response.status, 200, JSON.stringify(driftHealth.payload));
  const driftProfile = driftHealth.payload.data.clients[0].permissionProfile;
  assert.equal(driftProfile.catalogVersion, oldCatalogVersion);
  assert.deepEqual(driftProfile.actionIds, JSON.parse(driftRow.action_ids_json));
  assert.equal(driftProfile.snapshotSha256, oldSnapshotSha256);
});

test("site.full_control v5 直接使用或兑换绑定不可变快照，v4 保持仅兑换且派生会话可撤销", async (context) => {
  const harness = await createHarness();
  context.after(() => harness.mf.dispose());
  const owner = await ownerSession(harness);
  const catalogResult = await json(await harness.mf.dispatchFetch(request("/api/agent/v1?view=permission_catalog", {
    headers: { cookie: owner.cookie, "X-Wenmai-Browser-Binding": harness.browserBinding },
  })));
  assert.equal(catalogResult.response.status, 200, JSON.stringify(catalogResult.payload));
  const catalog = catalogResult.payload.data.catalog;
  const rootPreset = catalog.presets.find((item) => item.presetId === "site_full_control");
  assert.ok(rootPreset);
  const rootPayload = {
    label: "temporary root exchange test",
    clientKind: "codex",
    role: "super_admin",
    permissionPresetId: "site_full_control",
    catalogVersion: catalog.catalogVersion,
    catalogSha256: catalog.catalogSha256,
    scopes: ["site.full_control"],
    confirmedActionIds: ["auth.site_full_control.direct", "auth.site_full_control.exchange"],
    articleScope: { mode: "all_articles", articleIds: ["*"] },
    articleIds: ["*"],
    taskIds: [],
  };
  const root = await issue(harness, owner, rootPayload);
  assert.equal(root.response.status, 201, JSON.stringify(root.payload));
  assert.equal(root.payload.data.client.credentialPurpose, "site_full_control");
  const rootId = root.payload.data.client.id;
  const rootToken = root.payload.data.token;
  const db = await harness.mf.getD1Database("DB");
  const originalSnapshot = await db.prepare("SELECT * FROM agent_client_permission_snapshots WHERE client_id = ?").bind(rootId).first();
  assert.ok(originalSnapshot);
  const originalRootDocument = JSON.parse(originalSnapshot.snapshot_json);
  assert.equal(originalSnapshot.schema_version, 3, "不迁移外层快照表版本");
  assert.equal(originalRootDocument.schemaVersion, 5, "新根 Key 使用严格 v5 文档");
  assert.equal(originalRootDocument.credentialPurpose, "site_full_control");
  assert.equal(originalRootDocument.directAgentApi, true);
  assert.deepEqual(originalRootDocument.actionIds, ["auth.site_full_control.direct", "auth.site_full_control.exchange"]);
  assert.equal(originalRootDocument.managementProjectionVersion, "wenmai.site-full-control-management-projection/v5");
  assert.match(originalRootDocument.managementProjectionSha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(originalRootDocument.managementScopes.slice(-3), ["task.manage", "runner.manage", "admin.diagnostics"]);
  for (const scope of ["release.approve", "release.record", "admin.diagnostics"]) assert.ok(originalRootDocument.managementScopes.includes(scope), scope);

  const exchanged = await exchangeSiteFullControl(harness, rootToken);
  assert.equal(exchanged.response.status, 201, JSON.stringify(exchanged.payload));
  assert.equal(exchanged.payload.data.session.authBasis, "site_full_control_key");
  assert.equal(exchanged.payload.data.session.sourceClientId, rootId);
  let rootCookie = cookieFrom(exchanged.response);
  const rootSession = { cookie: rootCookie, csrf: exchanged.payload.data.csrfToken };
  const sessionRow = await db.prepare("SELECT * FROM management_sessions WHERE source_client_id = ? AND status = 'active'").bind(rootId).first();
  assert.equal(sessionRow.source_permission_snapshot_sha256, originalSnapshot.snapshot_sha256);
  assert.deepEqual(JSON.parse(sessionRow.scopes_json), originalRootDocument.managementScopes, "派生会话只使用已验证根快照投影");

  const rootIssued = await issue(harness, rootSession, { ...rootPayload, label: "root session issued child" });
  assert.equal(rootIssued.response.status, 201, JSON.stringify(rootIssued.payload));
  assert.equal(rootIssued.payload.data.client.issuedBySourceClientId, rootId, "根会话可完整管理站内 Key，并保留来源链");
  const rootRevokedChild = await json(await harness.mf.dispatchFetch(request("/api/agent/v1", {
    method: "POST",
    headers: ownerHeaders(harness, rootSession),
    body: JSON.stringify({ action: "revoke_client", commandId: `root-session-revoke-${randomUUID()}`, payload: { clientId: rootIssued.payload.data.client.id, note: "root session lifecycle verification" } }),
  })));
  assert.equal(rootRevokedChild.response.status, 200, JSON.stringify(rootRevokedChild.payload));
  assert.equal((await db.prepare("SELECT status FROM agent_clients WHERE id = ?").bind(rootIssued.payload.data.client.id).first()).status, "revoked");

  const replayCommandId = `site-full-control-exchange:${randomUUID()}`;
  const replayFirst = await exchangeSiteFullControl(harness, rootToken, replayCommandId);
  assert.equal(replayFirst.response.status, 201, JSON.stringify(replayFirst.payload));
  rootCookie = cookieFrom(replayFirst.response);
  const replaySecond = await exchangeSiteFullControl(harness, rootToken, replayCommandId);
  assert.equal(replaySecond.response.status, 401);
  assert.equal(replaySecond.payload.error.code, "SITE_FULL_CONTROL_AUTH_INVALID");

  const concurrentCommandId = `site-full-control-exchange:${randomUUID()}`;
  const concurrent = await Promise.all([
    exchangeSiteFullControl(harness, rootToken, concurrentCommandId),
    exchangeSiteFullControl(harness, rootToken, concurrentCommandId),
  ]);
  assert.deepEqual(concurrent.map((item) => item.response.status).sort(), [201, 401]);
  rootCookie = cookieFrom(concurrent.find((item) => item.response.status === 201).response);
  assert.equal((await db.prepare("SELECT COUNT(*) AS count FROM management_sessions WHERE source_client_id = ? AND status = 'active'").bind(rootId).first()).count, 1);

  const historical = await issue(harness, owner, { ...rootPayload, label: "historical v4 exchange-only root" });
  assert.equal(historical.response.status, 201, JSON.stringify(historical.payload));
  const historicalId = historical.payload.data.client.id;
  const historicalSnapshot = await db.prepare("SELECT * FROM agent_client_permission_snapshots WHERE client_id = ?").bind(historicalId).first();
  const historicalDocument = JSON.parse(historicalSnapshot.snapshot_json);
  delete historicalDocument.directAgentApi;
  historicalDocument.schemaVersion = 4;
  historicalDocument.credentialPurpose = "management_session_exchange";
  historicalDocument.actionIds = ["auth.site_full_control.exchange"];
  historicalDocument.managementProjectionVersion = "wenmai.site-full-control-management-projection/v4";
  historicalDocument.managementProjectionSha256 = sha256(canonicalJson({
    managementProjectionVersion: historicalDocument.managementProjectionVersion,
    managementScopes: historicalDocument.managementScopes,
  }));
  historicalDocument.catalogVersion = `${historicalDocument.catalogVersion}-historical`;
  historicalDocument.catalogSha256 = "1".repeat(64);
  const historicalJson = canonicalJson(historicalDocument);
  const historicalSha = sha256(historicalJson);
  await db.prepare("UPDATE agent_client_permission_snapshots SET catalog_version = ?, action_ids_json = ?, snapshot_json = ?, snapshot_sha256 = ? WHERE client_id = ?")
    .bind(historicalDocument.catalogVersion, '["auth.site_full_control.exchange"]', historicalJson, historicalSha, historicalId).run();
  await db.prepare("UPDATE agent_clients SET credential_purpose = 'management_session_exchange' WHERE id = ?").bind(historicalId).run();
  const historicalExchange = await exchangeSiteFullControl(harness, historical.payload.data.token);
  assert.equal(historicalExchange.response.status, 201, JSON.stringify(historicalExchange.payload));

  const missing = await issue(harness, owner, { ...rootPayload, label: "missing snapshot root" });
  assert.equal(missing.response.status, 201);
  await db.prepare("DELETE FROM agent_client_permission_snapshots WHERE client_id = ?").bind(missing.payload.data.client.id).run();
  const missingExchange = await exchangeSiteFullControl(harness, missing.payload.data.token);
  assert.equal(missingExchange.response.status, 401);
  assert.equal(missingExchange.payload.error.code, "SITE_FULL_CONTROL_AUTH_INVALID");

  const malformed = await issue(harness, owner, { ...rootPayload, label: "malformed snapshot root" });
  assert.equal(malformed.response.status, 201);
  await db.prepare("UPDATE agent_client_permission_snapshots SET snapshot_json = ? WHERE client_id = ?")
    .bind("{}", malformed.payload.data.client.id).run();
  const malformedExchange = await exchangeSiteFullControl(harness, malformed.payload.data.token);
  assert.equal(malformedExchange.response.status, 401);

  const ordinary = await issue(harness, owner, {
    label: "ordinary row root spoof",
    clientKind: "custom",
    scopes: ["task.read"],
    articleScope: { mode: "all_articles", articleIds: ["*"] },
    articleIds: ["*"],
    taskIds: [],
  });
  assert.equal(ordinary.response.status, 201);
  await db.prepare("UPDATE agent_clients SET role = 'super_admin', scopes_json = ?, credential_purpose = 'management_session_exchange' WHERE id = ?")
    .bind('["site.full_control"]', ordinary.payload.data.client.id).run();
  const spoofExchange = await exchangeSiteFullControl(harness, ordinary.payload.data.token);
  assert.equal(spoofExchange.response.status, 401);

  const activeRootSession = await db.prepare("SELECT id FROM management_sessions WHERE source_client_id = ? AND status = 'active'").bind(rootId).first();
  assert.ok(activeRootSession);
  const projectionDrift = { ...originalRootDocument, managementScopes: [...originalRootDocument.managementScopes, "unknown.canary"] };
  const projectionDriftJson = canonicalJson(projectionDrift);
  await db.prepare("UPDATE agent_client_permission_snapshots SET snapshot_json = ?, snapshot_sha256 = ? WHERE client_id = ?")
    .bind(projectionDriftJson, sha256(projectionDriftJson), rootId).run();
  const invalidatedSession = await json(await harness.mf.dispatchFetch(request("/api/auth", {
    headers: { cookie: rootCookie, "X-Wenmai-Browser-Binding": harness.browserBinding },
  })));
  assert.equal(invalidatedSession.response.status, 401);
  assert.equal(invalidatedSession.payload.error.code, "MANAGEMENT_SESSION_INVALID");
  const revokedSession = await db.prepare("SELECT status, revoke_reason FROM management_sessions WHERE id = ?").bind(activeRootSession.id).first();
  assert.equal(revokedSession.status, "revoked");
  assert.equal(revokedSession.revoke_reason, "source_key_invalid");

  const revokeCommandId = `snapshot-test-revoke-${randomUUID()}`;
  const revokeReason = "temporary root verification complete";
  const revokedRoot = await json(await harness.mf.dispatchFetch(request("/api/agent/v1", {
    method: "POST",
    headers: ownerHeaders(harness, owner),
    body: JSON.stringify({ action: "revoke_client", commandId: revokeCommandId, payload: { clientId: rootId, note: revokeReason } }),
  })));
  assert.equal(revokedRoot.response.status, 200, JSON.stringify(revokedRoot.payload));
  const lifecycleEvent = await db.prepare("SELECT principal_id, session_id, outcome, details_json FROM management_auth_events WHERE event_type = 'agent_key.lifecycle.revoked' AND request_id = ?").bind(revokeCommandId).first();
  assert.match(lifecycleEvent.principal_id, /^management-session:/);
  assert.equal(lifecycleEvent.session_id, lifecycleEvent.principal_id.slice("management-session:".length));
  assert.equal(lifecycleEvent.outcome, "revoked");
  const lifecycleDetails = JSON.parse(lifecycleEvent.details_json);
  assert.deepEqual({ ...lifecycleDetails, revokedClientIds: undefined }, {
    commandId: revokeCommandId,
    inputSha256: lifecycleDetails.inputSha256,
    issuedBySourceClientId: null,
    reason: revokeReason,
    targetClientId: rootId,
    targetRole: "super_admin",
    revokedClientIds: undefined,
  });
  assert.ok(lifecycleDetails.revokedClientIds.includes(rootId));
  assert.match(lifecycleDetails.inputSha256, /^[a-f0-9]{64}$/);
});
