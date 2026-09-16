import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const helper = readFileSync(new URL("../app/privileged-agent-auth.ts", import.meta.url), "utf8");
const workspace = readFileSync(new URL("../app/api/workspace/route.ts", import.meta.url), "utf8");
const projectPackage = readFileSync(new URL("../app/api/project-package/v1/route.ts", import.meta.url), "utf8");
const catalog = readFileSync(new URL("../app/agent-permission-catalog.ts", import.meta.url), "utf8");
const gateway = readFileSync(new URL("../scripts/wenmai-tailscale-agent-gateway.mjs", import.meta.url), "utf8");

test("高权限认证每次重验精确角色合同、TTL 和机器凭据边界", () => {
  assert.match(helper, /AGENT_ROLE_CONTRACTS\[role\]/);
  assert.match(helper, /administratorProfileVersion\(scopes\) !== null/);
  assert.match(helper, /superAdminProfileVersion\(scopes\) !== null/);
  assert.match(helper, /if \(!scopes\.includes\(requiredScope\)\)/);
  assert.match(helper, /exactStringSet\(articleIds, contract\.articleIds\)/);
  assert.match(helper, /exactStringSet\(taskIds, contract\.taskIds\)/);
  assert.match(helper, /expiryTime - createdTime > contract\.maxLifetimeMs/);
  assert.match(helper, /row\.status !== "active"/);
  assert.match(helper, /expires_at > \?/);
  assert.match(helper, /request\.headers\.has\("cookie"\)/);
  assert.match(helper, /request\.headers\.has\("origin"\) \|\| request\.headers\.has\("referer"\)/);
  assert.match(helper, /actorId: `agent-client:\$\{clientId\}`/);
});

test("超级管理员只走精确 IPv6 回环，管理员可使用受信网关标记", () => {
  assert.match(helper, /transport !== null && transport !== "tailscale-gateway"/);
  assert.match(helper, /transport === "tailscale-gateway" && \(role === "super_admin" \|\| localOnly\)/);
  assert.match(helper, /assertLocalImportTransport\(request\)/);
  assert.match(helper, /"PRIVILEGED_TRANSPORT_REQUIRED"/);
});

test("工作区只在目录和明确 handler 同时存在时接入 Agent 权限与回执", () => {
  assert.match(workspace, /agentActionAuthorization\("workspace", action\)/);
  assert.match(workspace, /agentActionId: agentAuthorization\?\.actionId/);
  assert.match(workspace, /agentScope: agentAuthorization\?\.scope/);
  assert.match(workspace, /localOnly: agentAuthorization\?\.localOnly/);
  assert.match(workspace, /allowedRoles: agentAuthorization\?\.allowedRoles/);
  assert.match(workspace, /save_working_copy[\s\S]*?managementScope: "workspace\.branch\.write"/);
  assert.match(workspace, /commit_revision[\s\S]*?managementScope: "workspace\.branch\.write"/);
  assert.match(workspace, /managementScope: privilegedAction\.managementScope/);
  assert.match(workspace, /COMMAND_ID_RE\.test\(commandId\)/);
  assert.match(workspace, /withAgentWorkspaceReceipt\(db, action, actorId, agentCommandId, payload, invoke\)/);
  assert.match(workspace, /commitRevision\(db, payload, agentRequest \? "agent" : "user"\)/);
  assert.match(workspace, /createPublicationBranch\(db, payload, actorId\)/);
  assert.match(workspace, /workspace\.create_publication_branch/);
  assert.match(workspace, /PublicationVersion canonical 基线已变化或不是 clean primary head/);
  const publicationBranch = workspace.match(/async function createPublicationBranch\([\s\S]*?\n}\n\nasync function commitRevision/)?.[0] ?? "";
  assert.match(publicationBranch, /const eventPayload = canonicalJson\(\{\s*commandId,\s*actorId,/);
  assert.match(publicationBranch, /INSERT INTO workspace_events[\s\S]*?SELECT \?, 'publication\.branch_created'/);
  assert.match(publicationBranch, /UPDATE command_receipts SET response_json = \?, status_code = 201, completed_at = CURRENT_TIMESTAMP\s*WHERE id = \? AND command_type = \? AND actor_id = \? AND request_sha256 = \? AND status_code = 0/);
  assert.match(workspace, /prepareMerge\(db, payload, actorId\)/);
  assert.match(workspace, /saveMergeResolution\(db, payload, actorId, agentRequest\)/);
  assert.match(workspace, /mergeRevision\(db, payload, actorId, agentRequest\)/);
  assert.match(workspace, /owner-only 工作区动作不能携带 Agent Bearer Key/);
  assert.match(workspace, /else \{[\s\S]*requireManagementSession\(request, \{ mutation: true, scope: "workspace\.branch\.write" \}\)/);
});

test("Package 仅将目录精确动作映射到可调用 handler", () => {
  assert.match(projectPackage, /agentActionAuthorization\("project-package", action\)/);
  assert.match(projectPackage, /agentActionId: agentAuthorization\?\.actionId/);
  assert.match(projectPackage, /agentScope: agentAuthorization\?\.scope/);
  assert.match(projectPackage, /save_working_package[\s\S]*?managementScope: "package\.write"/);
  assert.match(projectPackage, /commit[\s\S]*?managementScope: "package\.write"/);
  assert.match(projectPackage, /managementScope: privilegedAction\.managementScope/);
  assert.match(projectPackage, /if \(principal\.kind === "management"\) assertManagementWrite\(request\)/);
  assert.match(projectPackage, /withReceipt\(db, action, actorId, commandId, payload/);
  assert.match(projectPackage, /commitWorkingPackage\(db, payload, inputSha256, agentRequest \? "agent" : "user"\)/);
  assert.match(projectPackage, /owner-only 文章工程动作不能携带 Agent Bearer Key/);
  assert.match(projectPackage, /else \{[\s\S]*requireManagementSession\(request, \{ mutation: true, scope: "package\.write" \}\)/);
});

test("目录把工作区和 Package 写动作冻结为精确 route/action 绑定", () => {
  for (const actionId of [
    "workspace.save_working_copy", "workspace.commit_revision",
    "project-package.save_working_package", "project-package.commit",
  ]) assert.match(catalog, new RegExp(actionId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(catalog, /agentActionAuthorization\(routeId: string, wireAction: string\)/);
});

test("Tailscale 网关只额外放行任务 create/update/cancel 并强制覆盖传输标记", () => {
  const remoteBlock = gateway.match(/const REMOTE_ADMINISTRATOR_ACTIONS = new Set\(\[([\s\S]*?)\]\);/)?.[1] ?? "";
  assert.match(remoteBlock, /"create_task"/);
  assert.match(remoteBlock, /"update_task"/);
  assert.match(remoteBlock, /"cancel_task"/);
  for (const forbidden of ["issue_client", "revoke_client", "decide_approval", "decide_graph_proposal"]) {
    assert.doesNotMatch(remoteBlock, new RegExp(`"${forbidden}"`));
  }
  assert.match(gateway, /"x-wenmai-agent-transport": "tailscale-gateway"/);
  assert.match(gateway, /COMMAND_ID_REQUIRED/);
  assert.match(gateway, /assertRemoteAdministratorMachineRequest\(request\)/);
  assert.match(gateway, /url\.pathname !== WENMAI_AGENT_PATH && !isMetadataPath/);
});
