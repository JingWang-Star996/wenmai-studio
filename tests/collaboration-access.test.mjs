import assert from "node:assert/strict";
import test from "node:test";

const access = await import("../app/collaboration-access.ts");

test("scope 必须精确对应 viewer 或 editor", () => {
  assert.equal(access.collaborationAccessModeForScopes(["article.read"]), "viewer");
  assert.equal(access.collaborationAccessModeForScopes([
    "article.read", "task.read", "task.claim", "task.progress", "context.read",
    "artifact.create", "approval.request", "branch.agent_write",
  ]), "editor");
  assert.equal(access.collaborationAccessModeForScopes(["article.read", "article.read"]), null);
  assert.equal(access.collaborationAccessModeForScopes(["article.read", "task.read"]), null);
});

test("viewer 与 editor 的资源、任务和 TTL 约束", () => {
  const nowMs = 1_700_000_000_000;
  assert.deepEqual(access.validateCollaborationGrantShape({
    mode: "viewer", articleIds: ["article-1"], taskIds: [], expiresAtMs: nowMs + 1, nowMs,
  }), { valid: true, code: null, message: null });
  assert.equal(access.validateCollaborationGrantShape({
    mode: "viewer", articleIds: ["article-1"], taskIds: ["task-1"], expiresAtMs: nowMs + 1, nowMs,
  }).code, "VIEWER_TASK_FORBIDDEN");
  assert.deepEqual(access.validateCollaborationGrantShape({
    mode: "editor", articleIds: ["article-1"], taskIds: ["task-1"], expiresAtMs: nowMs + 30 * 86_400_000, nowMs,
  }), { valid: true, code: null, message: null });
  assert.equal(access.validateCollaborationGrantShape({
    mode: "editor", articleIds: ["*"], taskIds: ["task-1"], expiresAtMs: nowMs + 1, nowMs,
  }).code, "ARTICLE_SCOPE_INVALID");
  assert.equal(access.validateCollaborationGrantShape({
    mode: "editor", articleIds: ["article-1"], taskIds: [], expiresAtMs: nowMs + 1, nowMs,
  }).code, "EDITOR_TASK_REQUIRED");
  assert.equal(access.validateCollaborationGrantShape({
    mode: "viewer", articleIds: ["article-1"], taskIds: [], expiresAtMs: nowMs, nowMs,
  }).code, "EXPIRY_NOT_FUTURE");
  assert.equal(access.validateCollaborationGrantShape({
    mode: "viewer", articleIds: ["article-1"], taskIds: [], expiresAtMs: nowMs + 30 * 86_400_000 + 1, nowMs,
  }).code, "EXPIRY_TOO_LONG");
});

test("连接卡提供无凭据的固定端点和 owner-only 边界", () => {
  const card = access.buildCollaborationAccessCard({
    origin: "https://wenmai.example/",
    label: "文章协作连接",
    clientId: "client-1",
    clientKind: "custom",
    mode: "editor",
    article: { id: "article/a", label: "示例文章" },
    taskId: "task-1",
    expiresAt: "2030-01-01T00:00:00.000Z",
  });
  assert.equal(card.schemaVersion, "wenmai.share-grant/1");
  assert.equal(card.origin, "https://wenmai.example");
  assert.deepEqual(card.endpoints, {
    discovery: "https://wenmai.example/.well-known/wenmai-agent.json",
    api: "https://wenmai.example/api/agent/v1",
    health: "https://wenmai.example/api/agent/v1?view=health",
    articleList: "https://wenmai.example/api/agent/v1?view=articles",
    articleDetail: "https://wenmai.example/api/agent/v1?view=article&articleId=article%2Fa",
  });
  assert.equal(card.authentication.credentialInUrl, false);
  assert.equal(card.authentication.header, "Authorization: Bearer <Share Grant>");
  assert.equal(card.networkPrerequisite.transport, "local-loopback");
  assert.equal(card.networkPrerequisite.gatewayActivationImplied, false);
  assert.equal(card.grant.mode, "editor");
  assert.equal(card.grant.resource.revisionPolicy, "authoritative-current");
  assert.deepEqual(card.ownerOnlyBoundary.forbiddenCapabilities.includes("publish"), true);
  const serialized = JSON.stringify(card).toLowerCase();
  assert.doesNotMatch(serialized, /wenmai_agent_/);
  assert.doesNotMatch(serialized, /"(?:token|secret)"\s*:/);
});

test("便携连接钥匙文件把一次性 Bearer 与无秘密连接卡封装成可撤销 capability", () => {
  const clientId = "agent-client-11111111-2222-4333-8444-555555555555";
  const token = `wenmai_agent_${"a".repeat(32)}_${"b".repeat(32)}`;
  const card = access.buildCollaborationAccessCard({
    origin: "https://wenmai.example-tailnet.ts.net",
    label: "只读文章钥匙",
    clientId,
    clientKind: "custom",
    mode: "viewer",
    article: { id: "article-1", label: "示例文章" },
    expiresAt: "2030-01-08T00:00:00.000Z",
  });
  const file = access.buildPortableCollaborationAccessFile({
    connectionCard: card,
    token,
    exportedAt: "2030-01-01T00:00:00.000Z",
  });

  assert.deepEqual(Object.keys(file).sort(), [
    "connectionCard", "credential", "exportedAt", "handling", "kind",
    "possessionIsAuthority", "schemaVersion", "secret",
  ]);
  assert.equal(file.schemaVersion, "wenmai.agent-access-file/1");
  assert.equal(file.kind, "portable-share-grant");
  assert.equal(file.secret, true);
  assert.equal(file.possessionIsAuthority, true);
  assert.equal(file.connectionCard, card);
  assert.deepEqual(file.credential, {
    type: "bearer", header: "Authorization", scheme: "Bearer", token,
  });
  assert.equal(file.handling.recommendedUnixMode, "0600");
  assert.equal(file.handling.serverStateAuthoritative, true);
  assert.equal(file.handling.gatewayActivationImplied, false);
  assert.equal(file.handling.revokeByClientId, clientId);
  assert.doesNotMatch(JSON.stringify(file), /cookie|csrf|password/i);

  assert.throws(() => access.buildPortableCollaborationAccessFile({
    connectionCard: card,
    token: "not-a-key",
    exportedAt: "2030-01-01T00:00:00.000Z",
  }), /Key 格式无效/);
  assert.throws(() => access.buildPortableCollaborationAccessFile({
    connectionCard: { ...card, networkPrerequisite: { ...card.networkPrerequisite, gatewayActivationImplied: true } },
    token,
    exportedAt: "2030-01-01T00:00:00.000Z",
  }), /网关边界无效/);
});
