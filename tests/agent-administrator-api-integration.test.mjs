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
const administratorScopes = [
  "task.read", "context.read", "knowledge.read", "graph.read", "package.read", "task.manage",
];
const superAdminScopes = [
  ...administratorScopes,
  "approval.decide", "graph.decide", "package.patch.decide", "package.patch.apply",
  "workspace.publication_branch.create", "package.branch.attach", "publication.version.register",
  "workspace.merge.prepare", "workspace.merge.resolve", "workspace.merge.apply",
  "publish.capability.consume",
];

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function agentToken() {
  return `wenmai_agent_${randomBytes(16).toString("hex")}_${randomBytes(16).toString("hex")}`;
}

function request(pathname, init = {}) {
  const headers = new Headers(init.headers);
  headers.set("host", "[::1]:3000");
  headers.set("x-forwarded-host", "[::1]:3000");
  return new MiniflareRequest(`${canonicalOrigin}${pathname}`, { redirect: "manual", ...init, headers });
}

async function json(response) {
  return { response, payload: await response.json() };
}

async function compiledAgentRouteModules() {
  const names = (await readdir(staticPath)).filter((name) => name.endsWith(".js"));
  const sources = await Promise.all(names.map(async (name) => ({
    name,
    contents: await readFile(path.join(staticPath, name), "utf8"),
  })));
  const route = sources.find((source) => source.name.startsWith("route-")
    && source.contents.includes("Wenmai Agent Control Plane"));
  assert.ok(route, "没有在 production build 中找到 Agent API 路由");
  const entry = `
    import * as agent from ${JSON.stringify(`./${route.name}`)};
    export default {
      async fetch(request) {
        const headers = new Headers(request.headers);
        headers.set("host", "[::1]:3000");
        const handler = agent[request.method];
        return handler
          ? handler(new Request(request, { headers }))
          : new Response("method not allowed", { status: 405 });
      }
    };
  `;
  return [
    { type: "ESModule", path: "agent-administrator-test-worker.mjs", contents: entry },
    ...sources.map((source) => ({ type: "ESModule", path: source.name, contents: source.contents })),
  ];
}

async function insertPrivilegedClient(db, { id, role, token, scopes, lifetimeDays }) {
  const createdAt = new Date(Date.now() - 1000).toISOString();
  const expiresAt = new Date(Date.parse(createdAt) + lifetimeDays * 24 * 60 * 60 * 1000).toISOString();
  await db.prepare(`INSERT INTO agent_clients
    (id, label, client_kind, role, token_sha256, scopes_json, article_ids_json, task_ids_json,
     status, expires_at, created_at)
    VALUES (?, ?, 'codex', ?, ?, ?, '["*"]', '[]', 'active', ?, ?)`)
    .bind(id, `${role} integration`, role, sha256(token), JSON.stringify(scopes), expiresAt, createdAt)
    .run();
}

function postAction(token, action, commandId, payload, extraHeaders = {}) {
  return request("/api/agent/v1", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...extraHeaders,
    },
    body: JSON.stringify({ action, ...(commandId ? { commandId } : {}), payload }),
  });
}

test("administrator Bearer 只经机器通道管理任务，并以真实 client actor 写回执", async (t) => {
  const corpus = JSON.parse(await readFile(path.join(projectRoot, "data", "corpus.generated.json"), "utf8"));
  const articleId = corpus.articles[0].id;
  const mf = new Miniflare({
    modules: await compiledAgentRouteModules(),
    compatibilityDate: "2026-05-15",
    compatibilityFlags: ["nodejs_compat"],
    publicUrl: canonicalOrigin,
    d1Databases: { DB: `agent-administrator-test-${randomUUID()}` },
    log: new NoOpLog(),
  });
  t.after(() => mf.dispose());

  const initialize = await json(await mf.dispatchFetch(request("/api/agent/v1?view=health")));
  assert.equal(initialize.response.status, 401);
  const db = await mf.getD1Database("DB");
  const administratorId = `agent-client-${randomUUID()}`;
  const administratorToken = agentToken();
  await insertPrivilegedClient(db, {
    id: administratorId,
    role: "administrator",
    token: administratorToken,
    scopes: administratorScopes,
    lifetimeDays: 1,
  });

  const invalidUpdate = await json(await mf.dispatchFetch(postAction(
    agentToken(),
    "update_task",
    `invalid-update-${randomUUID()}`,
    { taskId: `missing-task-${randomUUID()}`, expectedLockVersion: 1, title: "不得枚举不存在任务" },
  )));
  assert.equal(invalidUpdate.response.status, 401);
  assert.equal(invalidUpdate.payload.error.code, "PRIVILEGED_AUTH_INVALID");

  const missingTaskUpdate = await json(await mf.dispatchFetch(postAction(
    administratorToken,
    "update_task",
    `missing-update-${randomUUID()}`,
    { taskId: `missing-task-${randomUUID()}`, expectedLockVersion: 1, title: "已认证仍返回任务不存在" },
  )));
  assert.equal(missingTaskUpdate.response.status, 404);
  assert.equal(missingTaskUpdate.payload.error.code, "TASK_NOT_FOUND");

  const missingCommand = await json(await mf.dispatchFetch(postAction(
    administratorToken,
    "create_task",
    "",
    { articleId, objective: "缺少稳定 commandId 时不得写入" },
  )));
  assert.equal(missingCommand.response.status, 400);
  assert.equal(missingCommand.payload.error.code, "MISSING_FIELD");

  const mixedBrowserCredential = await json(await mf.dispatchFetch(postAction(
    administratorToken,
    "create_task",
    `admin-mixed-${randomUUID()}`,
    { articleId, objective: "混合认证不得写入" },
    { cookie: "wenmai_management=ambiguous" },
  )));
  assert.equal(mixedBrowserCredential.response.status, 403);
  assert.equal(mixedBrowserCredential.payload.error.code, "AMBIGUOUS_AUTH_FORBIDDEN");

  const browserOrigin = await json(await mf.dispatchFetch(postAction(
    administratorToken,
    "create_task",
    `admin-origin-${randomUUID()}`,
    { articleId, objective: "浏览器来源不得调用 Bearer 管理动作" },
    { origin: canonicalOrigin },
  )));
  assert.equal(browserOrigin.response.status, 403);
  assert.equal(browserOrigin.payload.error.code, "BROWSER_REQUEST_FORBIDDEN");

  const createCommandId = `admin-create-${randomUUID()}`;
  const created = await json(await mf.dispatchFetch(postAction(
    administratorToken,
    "create_task",
    createCommandId,
    { articleId, title: "管理员集成任务", objective: "验证管理员跨任务控制", state: "queued" },
    { "x-wenmai-agent-transport": "tailscale-gateway" },
  )));
  assert.equal(created.response.status, 201, JSON.stringify(created.payload));
  const taskId = created.payload.data.task.id;
  assert.equal(created.payload.data.task.createdBy, `agent-client:${administratorId}`);

  const replay = await json(await mf.dispatchFetch(postAction(
    administratorToken,
    "create_task",
    createCommandId,
    { articleId, title: "管理员集成任务", objective: "验证管理员跨任务控制", state: "queued" },
    { "x-wenmai-agent-transport": "tailscale-gateway" },
  )));
  assert.equal(replay.response.status, 201);
  assert.equal(replay.payload.data.task.id, taskId);

  const updated = await json(await mf.dispatchFetch(postAction(
    administratorToken,
    "update_task",
    `admin-update-${randomUUID()}`,
    { taskId, expectedLockVersion: created.payload.data.task.lockVersion, title: "管理员已更新任务" },
  )));
  assert.equal(updated.response.status, 200, JSON.stringify(updated.payload));
  const cancelled = await json(await mf.dispatchFetch(postAction(
    administratorToken,
    "cancel_task",
    `admin-cancel-${randomUUID()}`,
    { taskId, expectedLockVersion: updated.payload.data.task.lockVersion, note: "管理员集成验证完成" },
  )));
  assert.equal(cancelled.response.status, 200, JSON.stringify(cancelled.payload));
  assert.equal(cancelled.payload.data.task.state, "cancelled");

  const actorId = `agent-client:${administratorId}`;
  const receipt = await db.prepare("SELECT actor_id FROM command_receipts WHERE id = ?")
    .bind(createCommandId).first();
  assert.equal(receipt.actor_id, actorId);
  const eventActors = await db.prepare("SELECT actor_kind, actor_id FROM agent_progress_events WHERE task_id = ?")
    .bind(taskId).all();
  assert.ok(eventActors.results.length >= 3);
  assert.ok(eventActors.results.every((row) => row.actor_kind === "agent" && row.actor_id === actorId));

  for (const action of ["issue_client", "revoke_client", "decide_approval", "decide_graph_proposal"]) {
    const denied = await json(await mf.dispatchFetch(postAction(
      administratorToken,
      action,
      `admin-owner-only-${action}-${randomUUID()}`,
      {},
    )));
    assert.equal(denied.response.status, 403, `${action} 不得接受 administrator Bearer`);
    assert.equal(denied.payload.error.code, "PRIVILEGED_ROLE_DENIED");
  }

  const superAdminId = `agent-client-${randomUUID()}`;
  const superAdminToken = agentToken();
  await insertPrivilegedClient(db, {
    id: superAdminId,
    role: "super_admin",
    token: superAdminToken,
    scopes: superAdminScopes,
    lifetimeDays: 1,
  });
  const superAdminTaskManagement = await json(await mf.dispatchFetch(postAction(
    superAdminToken,
    "create_task",
    `super-admin-task-management-${randomUUID()}`,
    { articleId, objective: "超级管理员继承已授权的 task.manage" },
  )));
  assert.equal(superAdminTaskManagement.response.status, 201, JSON.stringify(superAdminTaskManagement.payload));
  assert.equal(superAdminTaskManagement.payload.data.task.createdBy, `agent-client:${superAdminId}`);
});
