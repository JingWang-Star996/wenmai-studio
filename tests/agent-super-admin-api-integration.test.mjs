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
    { type: "ESModule", path: "agent-super-admin-test-worker.mjs", contents: entry },
    ...sources.map((source) => ({ type: "ESModule", path: source.name, contents: source.contents })),
  ];
}

async function insertPrivilegedClient(db, { id, role, token, scopes, lifetimeDays = 1 }) {
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

async function insertPendingCompletion(db, { taskId, attemptId, approvalId, articleId, requesterId }) {
  const now = new Date().toISOString();
  await db.batch([
    db.prepare(`INSERT INTO agent_tasks
      (id, article_id, active_attempt_id, assigned_client_id, title, objective, state, lock_version,
       created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, '超级管理员审批集成任务', '验证独立审批与真实 actor', 'review', 1, ?, ?, ?)`)
      .bind(taskId, articleId, attemptId, requesterId, requesterId, now, now),
    db.prepare(`INSERT INTO agent_task_attempts
      (id, task_id, attempt, client_id, context_snapshot_id, state, started_at)
      VALUES (?, ?, 1, ?, ?, 'awaiting_human', ?)`)
      .bind(attemptId, taskId, requesterId, `context-${taskId}`, now),
    db.prepare(`INSERT INTO agent_approval_requests
      (id, task_id, attempt_id, kind, title, question, options_json, status,
       requested_by_client_id, decision_note, lock_version, created_at)
      VALUES (?, ?, ?, 'task_completion', '验收候选', '是否接受技术结果', '["接受","退回"]',
        'pending', ?, '', 1, ?)`)
      .bind(approvalId, taskId, attemptId, requesterId, now),
  ]);
}

async function insertGraphProposal(db, { id, taskId, attemptId, articleId, creatorId }) {
  const now = new Date().toISOString();
  await db.prepare(`INSERT INTO graph_proposals
    (id, task_id, attempt_id, article_id, proposal_kind, label, payload_json, evidence_json,
     context_sha256, input_sha256, status, lock_version, created_by_client_id, created_at)
    VALUES (?, ?, ?, ?, 'node', '集成测试候选', '{}', '["integration-evidence"]', ?, ?,
      'candidate', 1, ?, ?)`)
    .bind(id, taskId, attemptId, articleId, "1".repeat(64), "2".repeat(64), creatorId, now)
    .run();
}

test("本机 super_admin 以细粒度 scope 决定内部候选，拒绝 Tailscale、自批与普通管理员", async (t) => {
  const corpus = JSON.parse(await readFile(path.join(projectRoot, "data", "corpus.generated.json"), "utf8"));
  const articleId = corpus.articles[0].id;
  const mf = new Miniflare({
    modules: await compiledAgentRouteModules(),
    compatibilityDate: "2026-05-15",
    compatibilityFlags: ["nodejs_compat"],
    publicUrl: canonicalOrigin,
    d1Databases: { DB: `agent-super-admin-test-${randomUUID()}` },
    log: new NoOpLog(),
  });
  t.after(() => mf.dispose());

  const initialize = await json(await mf.dispatchFetch(request("/api/agent/v1?view=health")));
  assert.equal(initialize.response.status, 401);
  const db = await mf.getD1Database("DB");

  const superAdminId = `agent-client-${randomUUID()}`;
  const superAdminToken = agentToken();
  const administratorId = `agent-client-${randomUUID()}`;
  const administratorToken = agentToken();
  const workerId = `agent-client-${randomUUID()}`;
  await insertPrivilegedClient(db, {
    id: superAdminId,
    role: "super_admin",
    token: superAdminToken,
    scopes: superAdminScopes,
  });
  await insertPrivilegedClient(db, {
    id: administratorId,
    role: "administrator",
    token: administratorToken,
    scopes: administratorScopes,
  });
  await insertPrivilegedClient(db, {
    id: workerId,
    role: "agent",
    token: agentToken(),
    scopes: ["task.read"],
  });

  const missingCommand = await json(await mf.dispatchFetch(postAction(
    superAdminToken,
    "decide_approval",
    "",
    { approvalRequestId: "approval-missing-command", expectedLockVersion: 1, decision: "approved" },
  )));
  assert.equal(missingCommand.response.status, 400);
  assert.equal(missingCommand.payload.error.code, "MISSING_FIELD");

  const taskId = `agent-task-${randomUUID()}`;
  const attemptId = `agent-attempt-${randomUUID()}`;
  const approvalId = `agent-approval-${randomUUID()}`;
  await insertPendingCompletion(db, { taskId, attemptId, approvalId, articleId, requesterId: workerId });

  const administratorDenied = await json(await mf.dispatchFetch(postAction(
    administratorToken,
    "decide_approval",
    `administrator-decision-${randomUUID()}`,
    { approvalRequestId: approvalId, expectedLockVersion: 1, decision: "approved", note: "不得生效" },
  )));
  assert.equal(administratorDenied.response.status, 403);
  assert.equal(administratorDenied.payload.error.code, "PRIVILEGED_ROLE_DENIED");

  const tailscaleDenied = await json(await mf.dispatchFetch(postAction(
    superAdminToken,
    "decide_approval",
    `tailscale-super-admin-${randomUUID()}`,
    { approvalRequestId: approvalId, expectedLockVersion: 1, decision: "approved", note: "不得生效" },
    { "x-wenmai-agent-transport": "tailscale-gateway" },
  )));
  assert.equal(tailscaleDenied.response.status, 421);
  assert.equal(tailscaleDenied.payload.error.code, "PRIVILEGED_TRANSPORT_REQUIRED");

  const approvalCommandId = `super-admin-approval-${randomUUID()}`;
  const approved = await json(await mf.dispatchFetch(postAction(
    superAdminToken,
    "decide_approval",
    approvalCommandId,
    { approvalRequestId: approvalId, expectedLockVersion: 1, decision: "approved", note: "独立技术验收通过" },
  )));
  assert.equal(approved.response.status, 200, JSON.stringify(approved.payload));
  assert.equal(approved.payload.data.task.state, "succeeded");
  assert.equal(approved.payload.data.boundary.editorialApproved, false);
  assert.equal(approved.payload.data.boundary.releaseApproved, false);
  assert.equal(approved.payload.data.boundary.publicAccessVerified, false);
  assert.equal(approved.payload.data.boundary.overallComplete, false);

  const replay = await json(await mf.dispatchFetch(postAction(
    superAdminToken,
    "decide_approval",
    approvalCommandId,
    { approvalRequestId: approvalId, expectedLockVersion: 1, decision: "approved", note: "独立技术验收通过" },
  )));
  assert.equal(replay.response.status, 200);
  assert.equal(replay.payload.data.task.id, taskId);

  const actorId = `agent-client:${superAdminId}`;
  const approvalRow = await db.prepare("SELECT decided_by FROM agent_approval_requests WHERE id = ?")
    .bind(approvalId).first();
  assert.equal(approvalRow.decided_by, actorId);
  const receiptRow = await db.prepare("SELECT actor_id FROM command_receipts WHERE id = ?")
    .bind(approvalCommandId).first();
  assert.equal(receiptRow.actor_id, actorId);
  const approvalEvent = await db.prepare(`SELECT actor_kind, actor_id FROM agent_progress_events
    WHERE task_id = ? AND event_type = 'approval.decided' LIMIT 1`).bind(taskId).first();
  assert.deepEqual(approvalEvent, { actor_kind: "agent", actor_id: actorId });

  const selfTaskId = `agent-task-${randomUUID()}`;
  const selfAttemptId = `agent-attempt-${randomUUID()}`;
  const selfApprovalId = `agent-approval-${randomUUID()}`;
  await insertPendingCompletion(db, {
    taskId: selfTaskId,
    attemptId: selfAttemptId,
    approvalId: selfApprovalId,
    articleId,
    requesterId: superAdminId,
  });
  const selfApproval = await json(await mf.dispatchFetch(postAction(
    superAdminToken,
    "decide_approval",
    `self-approval-${randomUUID()}`,
    { approvalRequestId: selfApprovalId, expectedLockVersion: 1, decision: "approved", note: "不得自批" },
  )));
  assert.equal(selfApproval.response.status, 403);
  assert.equal(selfApproval.payload.error.code, "SELF_APPROVAL_FORBIDDEN");

  const graphId = `graph-proposal-${randomUUID()}`;
  await insertGraphProposal(db, { id: graphId, taskId, attemptId, articleId, creatorId: workerId });
  const graphCommandId = `super-admin-graph-${randomUUID()}`;
  const graphDecision = await json(await mf.dispatchFetch(postAction(
    superAdminToken,
    "decide_graph_proposal",
    graphCommandId,
    { graphProposalId: graphId, expectedLockVersion: 1, decision: "confirmed", note: "证据匹配" },
  )));
  assert.equal(graphDecision.response.status, 200, JSON.stringify(graphDecision.payload));
  assert.equal(graphDecision.payload.data.graphProposal.status, "confirmed");
  assert.equal(graphDecision.payload.data.canonicalGraphMutated, false);
  assert.equal(graphDecision.payload.data.boundary.overallComplete, false);
  const graphRow = await db.prepare("SELECT reviewed_by FROM graph_proposals WHERE id = ?").bind(graphId).first();
  assert.equal(graphRow.reviewed_by, actorId);
  const graphReceipt = await db.prepare("SELECT actor_id FROM command_receipts WHERE id = ?")
    .bind(graphCommandId).first();
  assert.equal(graphReceipt.actor_id, actorId);

  const selfGraphId = `graph-proposal-${randomUUID()}`;
  await insertGraphProposal(db, { id: selfGraphId, taskId, attemptId, articleId, creatorId: superAdminId });
  const selfGraph = await json(await mf.dispatchFetch(postAction(
    superAdminToken,
    "decide_graph_proposal",
    `self-graph-${randomUUID()}`,
    { graphProposalId: selfGraphId, expectedLockVersion: 1, decision: "rejected", note: "不得自决" },
  )));
  assert.equal(selfGraph.response.status, 403);
  assert.equal(selfGraph.payload.error.code, "SELF_APPROVAL_FORBIDDEN");

  const created = await json(await mf.dispatchFetch(postAction(
    superAdminToken,
    "create_task",
    `super-admin-task-${randomUUID()}`,
    { articleId, objective: "验证超级管理员继承 task.manage", state: "queued" },
  )));
  assert.equal(created.response.status, 201, JSON.stringify(created.payload));
  assert.equal(created.payload.data.task.createdBy, actorId);

  const issueDenied = await json(await mf.dispatchFetch(postAction(
    superAdminToken,
    "issue_client",
    `super-admin-cannot-issue-${randomUUID()}`,
    {},
  )));
  assert.equal(issueDenied.response.status, 403);
  assert.equal(issueDenied.payload.error.code, "PRIVILEGED_SCOPE_DENIED");
});
