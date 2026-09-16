import test from "node:test";
import assert from "node:assert/strict";

import {
  PORTABLE_AGENT_ROLE_PROFILES,
  buildAgentRoleConnectionCard,
  buildPortableAgentRoleAccessFile,
  roleIdForClient,
} from "../app/portable-agent-access.ts";

const token = `wenmai_agent_${"a".repeat(32)}_${"b".repeat(32)}`;
const clientId = "agent-client-12345678-1234-4abc-8def-123456789abc";

function card(roleId, overrides = {}) {
  const profile = PORTABLE_AGENT_ROLE_PROFILES[roleId];
  return buildAgentRoleConnectionCard({
    roleId,
    origin: roleId === "local-registrar" ? "http://[::1]:3000" : "https://wenmai.personal.ts.net",
    label: profile.label,
    clientId,
    clientKind: "codex",
    serverRole: profile.serverRole,
    permissionPresetId: profile.permissionPresetId,
    scopes: profile.scopes,
    actionIds: profile.actionIds,
    articleIds: ["*"],
    taskIds: [],
    expiresAt: new Date(Date.now() + profile.maxLifetimeDays * 24 * 60 * 60 * 1000 - 120_000).toISOString(),
    ...overrides,
  });
}

test("三个日常角色都固定为全文章边界且不预绑任务", () => {
  for (const roleId of ["content-steward", "article-worker", "local-registrar"]) {
    const connectionCard = card(roleId);
    assert.equal(connectionCard.schemaVersion, "wenmai.role-grant/1");
    assert.equal(connectionCard.grant.roleId, roleId);
    assert.deepEqual(connectionCard.grant.articleScope, { mode: "all_articles", articleIds: ["*"], includesFutureArticles: true });
    assert.deepEqual(connectionCard.grant.taskIds, []);
    assert.equal(connectionCard.authentication.credentialInUrl, false);
    assert.equal(connectionCard.networkPrerequisite.gatewayActivationImplied, false);
  }
});

test("文脉管家只有任务编排动作，文章工作员只有候选范围", () => {
  const steward = card("content-steward");
  assert.deepEqual(steward.allowedOperations.actionIds, ["agent.v1.cancel_task", "agent.v1.create_task", "agent.v1.update_task"]);
  assert.ok(steward.allowedOperations.scopes.includes("task.manage"));
  assert.ok(!steward.allowedOperations.scopes.includes("branch.agent_write"));

  const worker = card("article-worker");
  assert.deepEqual(worker.allowedOperations.actionIds, []);
  assert.ok(worker.allowedOperations.scopes.includes("branch.agent_write"));
  assert.ok(worker.allowedOperations.scopes.includes("package.patch.propose"));
  assert.ok(!worker.allowedOperations.scopes.includes("task.manage"));
});

test("本机建档员不能被写成远程角色或混入额外 scope", () => {
  assert.throws(() => card("local-registrar", { origin: "https://wenmai.personal.ts.net" }), /不能通过远程地址/);
  assert.throws(() => card("local-registrar", { scopes: ["article.import.new_root", "task.read"] }), /scope 或 action/);
});

test("角色连接卡可封装为持有即授权的单一秘密文件", () => {
  const connectionCard = card("content-steward");
  const accessFile = buildPortableAgentRoleAccessFile({ connectionCard, token, exportedAt: new Date().toISOString() });
  assert.equal(accessFile.schemaVersion, "wenmai.agent-access-file/1");
  assert.equal(accessFile.kind, "portable-role-grant");
  assert.equal(accessFile.secret, true);
  assert.equal(accessFile.possessionIsAuthority, true);
  assert.equal(accessFile.credential.token, token);
  assert.equal(accessFile.handling.revokeByClientId, clientId);
  assert.doesNotMatch(JSON.stringify(connectionCard), /wenmai_agent_/);
});

test("服务端客户端快照只能识别精确固定角色", () => {
  const profile = PORTABLE_AGENT_ROLE_PROFILES["content-steward"];
  assert.equal(roleIdForClient({ role: profile.serverRole, scopes: profile.scopes, articleIds: ["*"], taskIds: [], permissionPresetId: profile.permissionPresetId, actionIds: profile.actionIds }), "content-steward");
  assert.equal(roleIdForClient({ role: profile.serverRole, scopes: [...profile.scopes, "branch.agent_write"], articleIds: ["*"], taskIds: [], permissionPresetId: profile.permissionPresetId, actionIds: profile.actionIds }), null);
  assert.equal(roleIdForClient({ role: profile.serverRole, scopes: profile.scopes, articleIds: ["article-1"], taskIds: [], permissionPresetId: profile.permissionPresetId, actionIds: profile.actionIds }), null);
  assert.equal(roleIdForClient({ role: profile.serverRole, scopes: profile.scopes, articleIds: ["*"], taskIds: [], permissionPresetId: profile.permissionPresetId, actionIds: [] }), null);
});
