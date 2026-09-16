import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  ADMINISTRATOR_LEGACY_SCOPES,
  ADMINISTRATOR_SCOPES,
  AGENT_ROLE_CONTRACTS,
  SUPER_ADMIN_LEGACY_SCOPES,
  SUPER_ADMIN_PRE_SHARED_SOURCE_SCOPES,
  SUPER_ADMIN_SCOPES,
  administratorProfileVersion,
  classifyAgentPrivilegeProfile,
  superAdminProfileVersion,
  validateAgentPrivilegeIssuance,
} from "../app/agent-role-contract.ts";
import {
  AGENT_PERMISSION_CATALOG,
  AGENT_PERMISSION_CATALOG_VERSION,
  AGENT_PERMISSION_PRESETS,
  HIGH_RISK_NEW_ISSUANCE_AUTHORIZED,
  HISTORICAL_PRIVILEGE_PROFILES,
  validatePermissionScopeCombination,
} from "../app/agent-permission-catalog.ts";

const route = readFileSync(new URL("../app/api/agent/v1/route.ts", import.meta.url), "utf8");

test("管理员与超级管理员角色合同使用精确 scope、全库文章和无 Worker 任务绑定", () => {
  assert.deepEqual([...ADMINISTRATOR_LEGACY_SCOPES], [
    "task.read", "context.read", "knowledge.read", "graph.read", "package.read", "task.manage",
  ]);
  assert.deepEqual([...ADMINISTRATOR_SCOPES], [...ADMINISTRATOR_LEGACY_SCOPES, "shared_source.read"]);
  assert.deepEqual([...SUPER_ADMIN_LEGACY_SCOPES], [
    ...ADMINISTRATOR_LEGACY_SCOPES,
    "approval.decide", "graph.decide", "package.patch.decide", "package.patch.apply",
    "workspace.publication_branch.create", "package.branch.attach", "publication.version.register",
    "workspace.merge.prepare", "workspace.merge.resolve", "workspace.merge.apply",
    "publish.capability.consume",
  ]);
  assert.deepEqual([...SUPER_ADMIN_PRE_SHARED_SOURCE_SCOPES], [
    ...SUPER_ADMIN_LEGACY_SCOPES,
    "workspace.branch.write", "package.working_copy.save", "package.revision.commit",
  ]);
  assert.deepEqual([...SUPER_ADMIN_SCOPES], [
    ...SUPER_ADMIN_PRE_SHARED_SOURCE_SCOPES, "shared_source.read",
  ]);
  assert.deepEqual([...AGENT_ROLE_CONTRACTS.administrator.articleIds], ["*"]);
  assert.deepEqual([...AGENT_ROLE_CONTRACTS.administrator.taskIds], []);
  assert.deepEqual([...AGENT_ROLE_CONTRACTS.super_admin.articleIds], ["*"]);
  assert.deepEqual([...AGENT_ROLE_CONTRACTS.super_admin.taskIds], []);
  assert.equal(AGENT_ROLE_CONTRACTS.administrator.maxLifetimeMs, 30 * 24 * 60 * 60 * 1000);
  assert.equal(AGENT_ROLE_CONTRACTS.super_admin.maxLifetimeMs, 7 * 24 * 60 * 60 * 1000);
});

test("角色分类只接受完整 scope 集和精确对象边界", () => {
  assert.equal(classifyAgentPrivilegeProfile(ADMINISTRATOR_LEGACY_SCOPES, ["*"], []), "administrator");
  assert.equal(classifyAgentPrivilegeProfile(ADMINISTRATOR_SCOPES, ["*"], []), "administrator");
  assert.equal(classifyAgentPrivilegeProfile(SUPER_ADMIN_LEGACY_SCOPES, ["*"], []), "super_admin");
  assert.equal(classifyAgentPrivilegeProfile(SUPER_ADMIN_PRE_SHARED_SOURCE_SCOPES, ["*"], []), "super_admin");
  assert.equal(classifyAgentPrivilegeProfile(SUPER_ADMIN_SCOPES, ["*"], []), "super_admin");
  assert.equal(classifyAgentPrivilegeProfile(ADMINISTRATOR_SCOPES, ["article-1"], []), null);
  assert.equal(classifyAgentPrivilegeProfile(ADMINISTRATOR_SCOPES, ["*"], ["*"]), null);
  assert.equal(classifyAgentPrivilegeProfile([...ADMINISTRATOR_SCOPES, "task.claim"], ["*"], []), null);
});

test("历史无快照角色档案保留识别，但不会从角色名补齐共享来源权限", () => {
  assert.equal(administratorProfileVersion(ADMINISTRATOR_LEGACY_SCOPES), "administrator_v1");
  assert.equal(administratorProfileVersion(ADMINISTRATOR_SCOPES), "administrator_v2");
  assert.equal(superAdminProfileVersion(SUPER_ADMIN_LEGACY_SCOPES), "super_admin_internal_v1");
  assert.equal(superAdminProfileVersion(SUPER_ADMIN_PRE_SHARED_SOURCE_SCOPES), "super_admin_internal_v2");
  assert.equal(superAdminProfileVersion(SUPER_ADMIN_SCOPES), "super_admin_internal_v3");
  for (const legacy of [ADMINISTRATOR_LEGACY_SCOPES, SUPER_ADMIN_LEGACY_SCOPES, SUPER_ADMIN_PRE_SHARED_SOURCE_SCOPES]) {
    assert.equal(legacy.includes("shared_source.read"), false);
  }
  assert.equal(ADMINISTRATOR_SCOPES.includes("shared_source.read"), true);
  assert.equal(SUPER_ADMIN_SCOPES.includes("shared_source.read"), true);
  assert.deepEqual(HISTORICAL_PRIVILEGE_PROFILES.administrator_v1, [...ADMINISTRATOR_LEGACY_SCOPES]);
  assert.deepEqual(HISTORICAL_PRIVILEGE_PROFILES.super_admin_internal_v1, [...SUPER_ADMIN_LEGACY_SCOPES]);
  assert.deepEqual(HISTORICAL_PRIVILEGE_PROFILES.super_admin_internal_v2, [...SUPER_ADMIN_PRE_SHARED_SOURCE_SCOPES]);
});

test("高权限角色拒绝 Worker 或候选 scope 混用，并执行角色 TTL", () => {
  const nowMs = Date.parse("2026-08-25T00:00:00.000Z");
  const administrator = validateAgentPrivilegeIssuance({
    role: "administrator",
    scopes: ADMINISTRATOR_SCOPES,
    articleIds: ["*"],
    taskIds: [],
    expiresAtMs: nowMs + 30 * 24 * 60 * 60 * 1000,
    nowMs,
  });
  assert.deepEqual(administrator.errors, []);
  const tooLong = validateAgentPrivilegeIssuance({
    role: "super_admin",
    scopes: SUPER_ADMIN_SCOPES,
    articleIds: ["*"],
    taskIds: [],
    expiresAtMs: nowMs + 8 * 24 * 60 * 60 * 1000,
    nowMs,
  });
  assert.ok(tooLong.errors.some((error) => error.includes("7 days")));
  const mixed = validateAgentPrivilegeIssuance({
    role: "super_admin",
    scopes: [...SUPER_ADMIN_SCOPES, "branch.agent_write"],
    articleIds: ["*"],
    taskIds: [],
    expiresAtMs: nowMs + 24 * 60 * 60 * 1000,
    nowMs,
  });
  assert.ok(mixed.errors.some((error) => error.includes("cannot mix worker")));
});

test("管理员与本机超级管理员只按精确角色合同激活", () => {
  const safeScopeBlock = route.match(/const SAFE_CLIENT_SCOPES = new Set\(\[([\s\S]*?)\]\);/)?.[1] ?? "";
  assert.match(safeScopeBlock, /\.\.\.ADMINISTRATOR_SCOPES/);
  assert.match(safeScopeBlock, /\.\.\.SUPER_ADMIN_SCOPES/);
  assert.match(route, /role TEXT NOT NULL DEFAULT 'agent'/);
  assert.match(route, /role: String\(row\.role \?\? "agent"\)/);
  assert.match(route, /requireManagementOrPrivilegedAgent\(request, db/);
  assert.match(route, /agentScope: "task\.manage"/);
  assert.match(route, /allowedRoles: \["administrator", "super_admin"\]/);
  assert.match(route, /decide_approval: "approval\.decide"/);
  assert.match(route, /decide_graph_proposal: "graph\.decide"/);
  assert.match(route, /allowedRoles: \["super_admin"\]/);
  assert.match(route, /localOnly: true/);
  assert.match(route, /principal\.kind === "agent"[\s\S]*?requiredText\(commandId, "commandId", 160\)/);
  assert.match(route, /withReceipt\(db, action, principal\.actorId, effectiveCommandId/);
  assert.match(route, /actorKind: actor\.kind === "agent" \? "agent" : "user", actorId: actor\.actorId/);
});

test("Key 签发撤销只开放给 owner 或 v5 根权限，内部裁决执行权限谱系隔离", () => {
  assert.match(route, /const managementScope = action === "issue_client" \? "token\.issue"[\s\S]*?"token\.revoke"/);
  assert.match(route, /requireManagementOrPrivilegedAgent\(request, db, \{[\s\S]{0,220}agentScope: "site\.full_control"[\s\S]{0,120}localOnly: true/);
  assert.match(route, /if \(action === "issue_client"\)[\s\S]*?issueClient\(db, payload/);
  assert.match(route, /if \(action === "revoke_client"\) return revokeClient/);
  assert.match(route, /const PRIVILEGED_DECISION_ACTION_SCOPES = \{[\s\S]*?approval\.decide[\s\S]*?graph\.decide/);
  assert.match(route, /return decideApproval\(db, payload, effectiveCommandId, inputSha256, principal\)/);
  assert.match(route, /return decideGraphProposal\(db, payload, effectiveCommandId, inputSha256, principal\)/);
  assert.match(route, /SELF_APPROVAL_FORBIDDEN/);
  assert.match(route, /sameAgentAuthorityLineage\(db, String\(approval\.requested_by_client_id\), decisionAuthorityClientId\)/);
  assert.match(route, /sameAgentAuthorityLineage\(db, String\(proposal\.created_by_client_id\), decisionAuthorityClientId\)/);
});

test("权限目录把任务分支边界和发布能力消费路由固定为可审计事实", () => {
  const catalog = readFileSync(new URL("../app/agent-permission-catalog.ts", import.meta.url), "utf8");
  assert.match(catalog, /task\.manage[\s\S]*?create_task[\s\S]*?任务专属 Agent 分支、Revision 或 WorkingCopy；不能改主分支、发布分支或代替人工决定/);
  assert.match(catalog, /publish\.capability\.consume[\s\S]*?publish-capability-v1[\s\S]*?publish-capability\.v1\.consume[\s\S]*?"consume"/);
  assert.match(catalog, /canonicalAgentPermissionCatalog[\s\S]*?agentPermissionCatalogSha256[\s\S]*?actionIdsForPermissionScopes/);
});

test("2026-09-10.1 根权限与内部高风险勾选开放，发布票据仍保持批次隔离", () => {
  const highRiskScopes = [
    "package.working_copy.save", "package.revision.commit", "approval.decide", "graph.decide", "package.patch.decide",
    "package.patch.apply", "workspace.merge.prepare", "workspace.merge.resolve", "workspace.merge.apply", "publish.capability.consume",
  ];
  assert.equal(AGENT_PERMISSION_CATALOG_VERSION, "2026-09-10.1");
  assert.equal(HIGH_RISK_NEW_ISSUANCE_AUTHORIZED, true);
  for (const scope of highRiskScopes) {
    const entry = AGENT_PERMISSION_CATALOG.find((item) => item.scope === scope);
    assert.ok(entry, scope);
    assert.equal(entry.risk, "high_risk", scope);
    assert.deepEqual(entry.allowedRoles, ["super_admin"], scope);
    assert.equal(entry.transport, "local", scope);
    assert.equal(entry.localOnly, true, scope);
    const publicationTicket = scope === "publish.capability.consume";
    assert.equal(entry.delegable, !publicationTicket, scope);
    assert.equal(entry.newIssuance, !publicationTicket, scope);
  }
  const allInternal = AGENT_PERMISSION_PRESETS.all_delegable_internal;
  assert.equal(allInternal.label, "Agent 文章工作全权（直接使用）");
  assert.ok(allInternal.scopes.includes("workspace.branch.write"));
  assert.ok(allInternal.scopes.includes("shared_source.read"));
  assert.ok(highRiskScopes.every((scope) => !allInternal.scopes.includes(scope)));
  for (const presetId of ["package_revision_operator", "internal_candidate_reviewer", "package_patch_applier", "merge_preparer", "merge_resolver", "merge_applier", "publish_ticket_consumer"]) {
    const preset = AGENT_PERMISSION_PRESETS[presetId];
    assert.ok(preset.label && preset.description, presetId);
    assert.ok(preset.scopes.some((scope) => highRiskScopes.includes(scope)), presetId);
  }
});

test("高风险 scope 组合门禁返回稳定冲突信息，保留权限仍不可委派", () => {
  const publish = validatePermissionScopeCombination(["publish.capability.consume", "workspace.branch.write"]);
  assert.deepEqual(publish, { valid: false, code: "PERMISSION_SCOPE_COMBINATION_CONFLICT", conflicts: ["publish.capability.consume"], message: "消费发布能力票据不能与任何其他可变更 scope 同时签发。" });
  const patch = validatePermissionScopeCombination(["package.patch.decide", "package.patch.apply"]);
  assert.equal(patch.valid, false); assert.deepEqual(patch.conflicts, ["package.patch.decide", "package.patch.apply"]);
  const merge = validatePermissionScopeCombination(["workspace.merge.prepare", "workspace.merge.apply"]);
  assert.equal(merge.valid, false); assert.deepEqual(merge.conflicts, ["workspace.merge.prepare", "workspace.merge.apply"]);
  assert.deepEqual(validatePermissionScopeCombination(["task.read", "workspace.merge.prepare"]), { valid: true, code: null, conflicts: [], message: null });
  for (const entry of AGENT_PERMISSION_CATALOG.filter((item) => item.risk === "reserved")) {
    assert.equal(entry.delegable, false, entry.scope); assert.equal(entry.newIssuance, false, entry.scope);
  }
});

test("v3 签发与认证保持普通路径和冻结快照边界", () => {
  const privilegedAuth = readFileSync(new URL("../app/privileged-agent-auth.ts", import.meta.url), "utf8");
  assert.match(route, /if \(!requestedRole \|\| requestedRole === "agent"\)/);
  assert.match(route, /PRIVILEGED_ROLE_REQUIRED/);
  assert.match(route, /issueOrdinaryClient/);
  assert.match(route, /DUPLICATE_SCOPE/);
  assert.match(route, /Array\.isArray\(payload\.scopes\)[\s\S]*cleanText\(scope, 240\)[\s\S]*DUPLICATE_SCOPE[\s\S]*stringArray\(payload\.scopes, "scopes", 30\)/);
  assert.match(route, /!entry\.delegable \|\| !entry\.newIssuance/);
  assert.match(route, /IMPORT_SCOPE_EXCLUSIVE_REQUIRED/);
  assert.match(route, /function insertAgentClientStatement[\s\S]*?INSERT INTO agent_clients/);
  assert.match(route, /parent\.status = 'active'[\s\S]*?parent\.expires_at >= \?/,
    "派生签发必须在写入时重验父 Key 状态与期限");
  assert.match(route, /authenticatePrivilegedAgent\(request, db, requiredScope, siteRoot \?/);
  assert.match(privilegedAuth, /permission_snapshot_v3/);
  assert.match(privilegedAuth, /administratorProfileVersion\(scopes\) !== null/);
  assert.match(privilegedAuth, /if \(!scopes\.includes\(requiredScope\)\)/);
  assert.match(route, /wenmai\.agent-object-boundary\/articles-v2/);
  assert.match(route, /articleMode === "all_articles"/);
  assert.match(route, /articleMode === "selected_articles"/);
  assert.match(privilegedAuth, /wenmai\.agent-object-boundary\/articles-v2/);
  assert.match(privilegedAuth, /article-set-v1/);
  assert.match(privilegedAuth, /旧 v3 specific 快照不能使用通配文章边界/);
  assert.match(privilegedAuth, /issuedAt: String\(row\.created_at\), expiresAt/);
  assert.match(privilegedAuth, /snapshotCanonical !== canonicalJson\(snapshotDocument\)/);
  assert.doesNotMatch(privilegedAuth, /profile\.catalogVersion !== AGENT_PERMISSION_CATALOG_VERSION/);
});

test("普通 Agent 安全集合不得签发 shared_source.read，排除特权管理和工作区写入", () => {
  const ordinaryBlock = route.match(/const ORDINARY_CLIENT_SCOPES = new Set\(\[([\s\S]*?)\]\);/)?.[1] ?? "";
  assert.match(ordinaryBlock, /"task\.read"/);
  assert.match(ordinaryBlock, /"package\.read"/);
  assert.doesNotMatch(ordinaryBlock, /"shared_source\.read"/);
  assert.doesNotMatch(ordinaryBlock, /"task\.manage"/);
  assert.doesNotMatch(ordinaryBlock, /"workspace\.branch\.write"/);
});
