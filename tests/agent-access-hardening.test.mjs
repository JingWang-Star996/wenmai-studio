import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [agentRoute, localAuth, localRoute, projectRoute, archiveIntake, consoleUi, managementGate, importClient, agentClient, invokeProfile, gateway, agentManifest, agentApiContract] = await Promise.all([
  readFile(new URL("../app/api/agent/v1/route.ts", import.meta.url), "utf8"),
  readFile(new URL("../app/local-import-auth.ts", import.meta.url), "utf8"),
  readFile(new URL("../app/api/local-import/v1/route.ts", import.meta.url), "utf8"),
  readFile(new URL("../app/api/project-package/v1/route.ts", import.meta.url), "utf8"),
  readFile(new URL("../app/article-archive-intake.ts", import.meta.url), "utf8"),
  readFile(new URL("../app/AgentConsole.tsx", import.meta.url), "utf8"),
  readFile(new URL("../app/ManagementSessionGate.tsx", import.meta.url), "utf8"),
  readFile(new URL("../scripts/import-wenmai-local.ps1", import.meta.url), "utf8"),
  readFile(new URL("../scripts/wenmai_agent_client.py", import.meta.url), "utf8"),
  readFile(new URL("../scripts/invoke-wenmai-agent-profile.ps1", import.meta.url), "utf8"),
  readFile(new URL("../scripts/wenmai-tailscale-agent-gateway.mjs", import.meta.url), "utf8"),
  readFile(new URL("../public/agent/manifest.json", import.meta.url), "utf8"),
  readFile(new URL("../public/agent/api/v1.json", import.meta.url), "utf8"),
]);
const parsedAgentApiContract = JSON.parse(agentApiContract);

test("本机建档 Key 复用 Agent 生命周期，但只能在精确回环和显式全库边界使用", () => {
  assert.match(agentRoute, /"article\.import\.new_root"/);
  assert.match(agentRoute, /IMPORT_SCOPE_EXCLUSIVE_REQUIRED/);
  assert.match(agentRoute, /SCOPE_SET_REQUIRED/);
  assert.doesNotMatch(agentRoute, /DEFAULT_CLIENT_SCOPES/);
  assert.match(agentRoute, /scopes\.length !== 1/);
  assert.match(agentRoute, /IMPORT_BOUNDARY_REQUIRED/);
  assert.match(agentRoute, /articleIds\.length !== 1 \|\| articleIds\[0\] !== "\*"/);
  assert.match(localAuth, /assertLocalImportTransport\(request, LOCAL_IMPORT_CANONICAL_ORIGIN\)/);
  assert.match(localAuth, /token_sha256 = \? LIMIT 1/);
  assert.match(localAuth, /LOCAL_IMPORT_SCOPE_DENIED/);
  assert.match(localAuth, /scopes\.length !== 1 \|\| scopes\[0\] !== LOCAL_IMPORT_AGENT_SCOPE/);
  assert.match(localAuth, /articleIds\.length !== 1 \|\| articleIds\[0\] !== "\*"/);
  assert.match(localAuth, /row\.status !== "active"/);
  assert.match(localAuth, /expiryTime <= Date\.now\(\)/);
  assert.match(localAuth, /UPDATE agent_clients SET last_seen_at = \? WHERE id = \? AND status = 'active' AND expires_at > \?/);
  assert.match(localAuth, /Number\(refreshed\.meta\.changes \?\? 0\) !== 1/);
  assert.match(localAuth, /Key 在认证期间失效/);
  assert.match(localRoute, /principal\.actorId/);
  assert.match(localRoute, /view === "health"/);
  assert.match(projectRoute, /createLocalImportProjectPackage\([\s\S]*actorId = "local-import-operator"/);
  assert.match(projectRoute, /"local_import_create_from_text",[\s\S]*actorId,[\s\S]*input\.commandId/);
});

test("本机建档脚本可从 DPAPI profile 读取 Key，但请求仍不发送本机路径", () => {
  assert.match(importClient, /ProfileName/);
  assert.match(importClient, /wenmai\.agent\.profile\.v1:\$ProfileName/);
  assert.match(importClient, /ProtectedData\]::Unprotect/);
  assert.match(importClient, /credential\.transport -cne 'local'/);
  assert.match(importClient, /authorizationKind = \$credentialKind/);
  assert.doesNotMatch(localRoute, /payload\.(?:path|filePath|localPath)/);
});

test("local-import intake 严格校验、兼容旧五字段，并绑定同一幂等建档请求", () => {
  assert.match(localRoute, /assertExactKeys\(body\.payload, \["title", "bodyText", "bodySha256", "sourceName", "format", "intake"\], "payload"\)/);
  assert.match(localRoute, /parseLocalImportIntakeDeclaration\(body\.payload\.intake\)/);
  assert.match(localRoute, /view === "contract"[\s\S]{0,240}localImportContractManifest\(\)/);
  assert.match(archiveIntake, /if \(value === undefined \|\| value === null\)[\s\S]{0,420}declarationState: "policy_defaulted"/);
  assert.match(archiveIntake, /const allowed = \["schemaVersion", "contentKind", "editorialStage", "goal", "audience", "constraints"\]/);
  assert.match(archiveIntake, /UNKNOWN_INTAKE_FIELD/);
  assert.match(archiveIntake, /declarationState: "agent_declared"/);
  assert.match(projectRoute, /const receiptPayload: JsonObject = \{[\s\S]{0,520}intake: input\.intake/,
    "intake 会改变建档 metadata，必须进入 command receipt 的 canonical request hash");
  assert.match(projectRoute, /buildLocalImportPackageDocument\(\{[\s\S]{0,360}intake: input\.intake/);

  const contract = parsedAgentApiContract.authentication.localImport;
  assert.deepEqual(contract.payload.legacyRequired, ["title", "bodyText", "bodySha256", "sourceName", "format"]);
  assert.equal(contract.payload.optionalStrictDeclaration, "intake: wenmai-local-import-declaration/1.0.0");
  assert.equal(contract.payload.unknownFieldsRejected, true);
  assert.equal(contract.payload.serverFilePathAccepted, false);
  assert.equal(contract.policyDefault, "light_archive_pending_human_triage");
});

test("local-import 只证明建档层，编辑、交付、提交、目的端与公开结果 Claim 不被提升", () => {
  assert.match(projectRoute, /archiveRecordVerified: guidanceChecklist\.archiveReady/);
  assert.match(projectRoute, /guidedAgentWorkReady: guidanceChecklist\.editorialWorkReady/);
  assert.match(projectRoute, /guidanceChecklist,/);
  const checklistBuilder = archiveIntake.slice(
    archiveIntake.indexOf("export async function buildArticleGuidanceChecklist"),
    archiveIntake.indexOf("export function articleArchiveIntakeContractManifest"),
  );
  assert.match(checklistBuilder, /Package document metadata is editable package state, not a server-side human decision receipt/);
  assert.match(checklistBuilder, /const processingProfile = verifiedDecision\?\.selectedProfile[\s\S]{0,160}policyLightArchive \? "light_archive" : "unselected"/);
  assert.match(checklistBuilder, /const profileAuthority = verifiedDecision \? "human" : policyLightArchive \? "policy_default" : "none"/);
  assert.match(checklistBuilder, /id: "triage\.profile\.human_decision"[\s\S]{0,180}status: verifiedDecision \? "passed" : "human_required"[\s\S]{0,180}responsibleActor: "human"/);
  assert.match(checklistBuilder, /metadataDeclaration:\$\{declaredWorkflow\.selectedProfile\}[\s\S]{0,120}humanDecisionReceipt:missing/);
  assert.match(checklistBuilder, /id: "editorial\.production\.entry"[\s\S]{0,220}status: verifiedDecision\?\.selectedProfile === "full_production" \? "passed" : "not_applicable"/);
  assert.match(checklistBuilder, /const editorialWorkReady = archiveReady && verifiedDecision\?\.selectedProfile === "full_production"/);
  assert.match(checklistBuilder, /id: "editorial\.module\.candidate"[\s\S]{0,220}responsibleActor: "agent"/);
  assert.match(checklistBuilder, /Package document metadata is editable package state[\s\S]*const verifiedDecision = input\.verifiedDecision \?\? null/,
    "human 权限只能来自调用方传入的服务端核验回执，不能来自 Package metadata/importWorkflow");
  assert.match(checklistBuilder, /completionBoundary: \{[\s\S]{0,420}archiveRecordVerified: archiveReady,[\s\S]{0,420}editorialComplete: false[\s\S]{0,420}artifactDelivered: false[\s\S]{0,420}submissionAccepted: false[\s\S]{0,420}destinationRecordVerified: false[\s\S]{0,420}publicAccessVerified: false[\s\S]{0,420}outcomeVerified: false/);
  assert.match(archiveIntake, /humanOnlyDecisions: \["processing_profile_confirmation", "editorial_approval", "external_publish_authorization"\]/);
  assert.match(archiveIntake, /agentWriteBoundary: "candidate_patch_only"/);

  const contract = parsedAgentApiContract.authentication.localImport;
  assert.deepEqual(contract.humanOnly, ["processing profile confirmation", "editorial approval", "external publish authorization"]);
  assert.deepEqual(contract.readback, [
    "active/clean/inSync identity", "archiveRecordVerified", "guidedAgentWorkReady",
    "guidanceChecklist", "checklistSha256", "nextAction",
  ]);
});

test("Key 签发可重放但回执无秘密，UI 关闭即清理且命令不嵌入 Key", () => {
  assert.match(agentRoute, /const issueCommandId = requiredText\(commandId, "commandId", 160\)/);
  assert.match(agentRoute, /delete persistedData\.token/);
  assert.match(agentRoute, /persistedData\.shownOnce = false/);
  assert.match(agentRoute, /secretRecoverable = false/);
  assert.match(consoleUi, /issueAttemptRef/);
  assert.match(consoleUi, /closeClientPanel/);
  assert.match(consoleUi, /setIssuedClient\(null\)/);
  assert.match(consoleUi, /save-wenmai-agent-profile\.ps1/);
  assert.match(consoleUi, /invoke-wenmai-agent-profile\.ps1/);
  assert.match(consoleUi, /先复制“保存到 DPAPI”命令[\s\S]*复制一次性 Key/);
  assert.match(consoleUi, /await navigator\.clipboard\.writeText\(issuedClient\.token\)/);
  assert.match(consoleUi, /setIssuedTokenVisible\(true\)/);
  assert.match(consoleUi, /disabled=\{issuedClient !== null\}/);
  assert.match(consoleUi, /disabled=\{busy !== "" \|\| issuedClient !== null\}/);
  assert.match(consoleUi, /if \(issuedClient\) \{[\s\S]*请先保存并验证当前一次性 Key/);
  assert.match(consoleUi, /const copyClientText = useCallback\(async/);
  assert.match(consoleUi, /await navigator\.clipboard\.writeText\(value\)/);
  assert.match(consoleUi, /setClientCopyFallback\(\{ label, value \}\)/);
  assert.match(consoleUi, /复制失败 · \{clientCopyFallback\.label\}/);
  assert.match(consoleUi, /buildPortableCollaborationAccessFile/);
  assert.match(consoleUi, /连接钥匙文件已生成；文件本身就是凭据/);
  assert.match(consoleUi, /URL\.revokeObjectURL\(url\)/);
  assert.doesNotMatch(consoleUi, /void navigator\.clipboard\.writeText\((?:saveProfileCommand|statusCommand|importCommand|value)\)/);
  assert.doesNotMatch(consoleUi, /void navigator\.clipboard\.writeText\(issuedClient\.token\)/);
  assert.doesNotMatch(consoleUi, /env:\s*\{\s*WENMAI_AGENT_TOKEN/);
  assert.doesNotMatch(consoleUi, /\$env:WENMAI_AGENT_TOKEN=.*issuedClient\.token/);
});

test("过期与本机默认地址固定，Tailscale 网关继续不转发建档路由", () => {
  assert.match(agentRoute, /new Date\(expiryTime\)\.toISOString\(\)/);
  assert.match(agentRoute, /effectiveStatus/);
  assert.match(consoleUi, /client\.effectiveStatus === "expired"/);
  assert.match(consoleUi, /const profileScriptRoot = "\.\\\\scripts"/);
  assert.match(consoleUi, /cwd: WENMAI_PROJECT_ROOT_PLACEHOLDER/);
  assert.match(consoleUi, /if \(replacementPreset === "local-operator"\) setClientTransport\("local"\)/);
  assert.match(consoleUi, /\(requiresLocalTransport && clientTransport !== "local"\)/);
  assert.match(consoleUi, /replacementProfileBase/);
  assert.match(consoleUi, /slice\(0, 18\)/);
  assert.match(consoleUi, /LocalImportStatus/);
  assert.match(agentClient, /DEFAULT_BASE_URL = "http:\/\/\[::1\]:3000"/);
  assert.match(agentManifest, /"defaultOrigin": "http:\/\/\[::1\]:3000"/);
  assert.doesNotMatch(gateway, /local-import\/v1|create_article_from_text/);
});

test("管理员目录 UI 以服务端 catalog 和精确 scope/action 快照签发", () => {
  assert.match(consoleUi, /type AgentClientPreset = [^;]*"permission-catalog"/);
  assert.match(consoleUi, /view=permission_catalog/);
  assert.doesNotMatch(consoleUi, /SUPER_ADMIN_SCOPES|ADMINISTRATOR_SCOPES/);
  assert.match(consoleUi, /catalogVersion: permissionCatalog!\.catalogVersion/);
  assert.match(consoleUi, /permissionPresetId: roleId === "content-steward" \? "task_admin" : selectedPermissionPresetId/);
  assert.match(consoleUi, /selectedPrivilegedScopes/);
  assert.match(consoleUi, /permissionCatalogError/);
  assert.match(consoleUi, /selectedPrivilegedArticleIds/);
  assert.match(consoleUi, /articleObjects/);
  assert.match(consoleUi, /articleObjectCount/);
  assert.match(consoleUi, /includeArticles=1/);
  assert.match(consoleUi, /canIssuePermission/);
  assert.match(consoleUi, /文脉管家与高级权限暂时不能签发，文章工作员仍可使用/);
  assert.match(consoleUi, /function derivedPermissionRole\(catalog: AgentPermissionCatalog \| null, scopes: string\[\]\)/);
  assert.match(consoleUi, /scopes\.every\(\(scope\) => catalogPermissions\(catalog\)\.find\(\(item\) => item\.scope === scope\)\?\.allowedRoles\.includes\("administrator"\)\)/);
  assert.match(consoleUi, /requestedPermissionRole = derivedPermissionRole\(permissionCatalog, requestedScopes\)/);
  assert.match(consoleUi, /role: requestedPermissionRole/);
  assert.match(consoleUi, /角色由已选权限自动确定/);
  assert.doesNotMatch(consoleUi, /name="privileged-role"/);
  assert.match(consoleUi, /articleScope: \{ mode: collaborationMode \? "selected_articles" : roleId \? "all_articles" : privilegedArticleScope, articleIds: payloadArticleIds \}/);
  assert.match(consoleUi, /roleId \? \["\*"\] : privilegedArticleScope === "all_articles" \? \["\*"\]/);
  assert.match(consoleUi, /全部文章（含以后新增）/);
  assert.match(consoleUi, /selectedPrivilegedArticlesAreCurrent/);
  assert.match(consoleUi, /const MAX_PRIVILEGED_ARTICLE_IDS = 200/);
  assert.match(consoleUi, /selectedPrivilegedArticleIds\.length <= MAX_PRIVILEGED_ARTICLE_IDS/);
  assert.match(consoleUi, /privilegedArticleScope === "selected_articles"/);
  assert.match(consoleUi, /aria-label="搜索指定文章"/);
  assert.match(consoleUi, /disabled=\{!selectedPrivilegedArticleIds\.includes\(article\.id\) && selectedPrivilegedArticleIds\.length >= MAX_PRIVILEGED_ARTICLE_IDS\}/);
  assert.match(consoleUi, /已选 \{selectedPrivilegedArticleIds\.length\}\/\{MAX_PRIVILEGED_ARTICLE_IDS\} 篇/);
  assert.match(consoleUi, /localImportAllArticles/);
  assert.match(consoleUi, /正式全文章边界：包括此 Key 签发后新增的文章/);
  assert.match(consoleUi, /全部文章建档范围/);
  assert.doesNotMatch(consoleUi, /历史全库边界|不会复制 <code>\*<\/code>/);
  assert.doesNotMatch(consoleUi, /permission-catalog-picker/);
  assert.match(consoleUi, /taskIds: collaborationMode === "editor" \? \[clientTaskId\] : \[\]/);
  assert.match(consoleUi, /function maxClientLifetimeForRole\(privilegedPreset: boolean, role: "administrator" \| "super_admin"\): AgentClientLifetimeDays \{\s*return privilegedPreset \? \(role === "super_admin" \? 7 : 30\) : 90;/);
  assert.match(consoleUi, /const maxClientLifetimeDays = collaborationShare\s*\? COLLABORATION_ACCESS_MAX_LIFETIME_DAYS\s*:\s*selectedRoleProfile\?\.maxLifetimeDays \?\? maxClientLifetimeForRole\(privilegedPreset, derivedRole\);\s*const clientLifetimeValid = Number\.isInteger\(clientLifetimeDays\) && clientLifetimeDays >= 1 && clientLifetimeDays <= maxClientLifetimeDays;/);
  assert.match(consoleUi, /aria-label="Agent token 有效期天数" type="number" min=\{1\} max=\{maxClientLifetimeDays\} step=\{1\}/);
  assert.match(consoleUi, /normalizeClientLifetimeDays\(current, maxClientLifetimeForRole\(true, derivedPermissionRole\(permissionCatalog, selectedPrivilegedScopes\)\)\)/);
  assert.match(consoleUi, /disabled=\{clientPreset === "local-operator" \|\| requiresLocalTransport\}/);
  assert.match(consoleUi, /client\.role === "super_admin" \|\| client\.role === "administrator"/);
  assert.ok(consoleUi.indexOf('client.role === "super_admin"') < consoleUi.indexOf('client.role === "administrator"'));
  assert.match(consoleUi, /消费能力不等于提交成功或公开/);
  assert.doesNotMatch(managementGate, /agent_key\.bootstrap|wenmai-super-admin-key|bootstrapWithAgentKey/);
  assert.match(managementGate, /site_full_control\.exchange/);
  assert.match(managementGate, /完整站内管理 Key/);
});

test("角色钥匙优先于单篇共享与高级目录，并保持连接卡与秘密分离", () => {
  assert.match(consoleUi, /<optgroup label="管理文脉（推荐）"><option value="role-steward">文脉管家 · 全库盘点与任务编排<\/option><option value="role-worker">文章工作员 · 执行任务并交候选<\/option><option value="local-operator">本机新文章建档员<\/option><\/optgroup><optgroup label="单篇临时共享">/);
  assert.match(consoleUi, /setClientPreset\("role-steward"\)/);
  assert.match(consoleUi, /setClientLifetimeDays\(7\)/);
  assert.match(consoleUi, /collaborationMode === "editor" \? \[clientTaskId\] : \[\]/);
  assert.match(consoleUi, /复制无秘密接入卡/);
  assert.match(consoleUi, /文件本身就是权限/);
  assert.match(consoleUi, /Tailscale 不是公网匿名链接/);
  assert.doesNotMatch(consoleUi, /buildCollaborationAccessCard\(\{[^}]*token/s);
});

test("日常角色固定全文章边界，高级兼容入口仍可选择对象范围", () => {
  assert.match(consoleUi, /!selectedRoleId && clientPreset !== "local-operator" && !siteFullControlSelected && <fieldset className="permission-article-scope">/);
  assert.match(consoleUi, /固定覆盖全部文章（含以后新增）/);
  assert.match(consoleUi, /privilegedPreset && typeof permissionCatalog\?\.articleObjectCount/);
  assert.match(consoleUi, /privilegedArticleScope === "selected_articles" && <select value=\{clientArticleId\}/);
  assert.match(agentRoute, /普通 Agent 必须指定 articleScope\.mode/);
  assert.match(agentRoute, /OBJECT_BOUNDARY_MISMATCH/, "普通 Agent 必须校验 nested/top-level 镜像");
  assert.match(agentRoute, /articleMode === "all_articles"[\s\S]{0,220}articleIds\.length !== 1 \|\| articleIds\[0\] !== "\*"/);
  assert.match(agentRoute, /articleMode === "selected_articles"[\s\S]{0,320}suppliedArticleIds\.some/);
  assert.doesNotMatch(consoleUi, /<details key=\{category\} open>/);
});

test("完整站内管理 Key 可直接调用，也可兑换根会话并在撤销时原子失效其派生会话", () => {
  assert.match(agentRoute, /const isSiteFullControl = scopes\.length === 1 && scopes\[0\] === "site\.full_control"/);
  assert.match(agentRoute, /credentialPurpose = isSiteFullControl \? "site_full_control" : "agent_api"/);
  assert.match(agentRoute, /SITE_FULL_CONTROL_CONTRACT_INVALID/);
  assert.match(agentRoute, /articleMode !== "all_articles"[\s\S]{0,220}articleIds\[0\] !== "\*"[\s\S]{0,160}taskIds\.length/);
  assert.match(agentRoute, /issued_by_source_client_id/);
  assert.match(agentRoute, /credentialPurpose: row\.credential_purpose === "management_session_exchange"[\s\S]{0,180}row\.credential_purpose === "site_full_control" \? "site_full_control" : "agent_api"/);
  assert.match(agentRoute, /assertActiveAgentClientLineage/);
  assert.doesNotMatch(agentRoute, /UPDATE agent_clients SET status = 'revoked'[\s\S]{0,360}issued_by_source_client_id/);
  assert.match(consoleUi, /siteFullControlSelected/);
  assert.match(consoleUi, /const root = preset\.scopes\.length === 1 && preset\.scopes\[0\] === "site\.full_control"/);
  assert.match(consoleUi, /Agent 站内全权（本机）/);
  assert.match(consoleUi, /credentialPurpose === "site_full_control"/);
  assert.match(consoleUi, /directAgentApi/);
});

test("弱模型默认预设不签发任务完成权", () => {
  const workerScopes = consoleUi.match(/clientPreset === "worker"\s*\? \[([^\]]+)\]/)?.[1] ?? "";
  const candidateScopes = consoleUi.match(/: \["task\.read", "task\.claim", "task\.progress"([^\]]+)\];/)?.[0] ?? "";
  assert.ok(workerScopes, "缺少普通 Worker scope 预设");
  assert.ok(candidateScopes, "缺少候选 Agent scope 预设");
  assert.doesNotMatch(workerScopes, /task\.complete/);
  assert.doesNotMatch(candidateScopes, /task\.complete/);
  assert.match(consoleUi, /普通 Worker 与候选 Agent 不签发 <code>task\.complete<\/code>/);
});

test("管理员与本机超级管理员桥都使用固定动作表，DPAPI 命令不携带 Key", () => {
  assert.match(invokeProfile, /ValidateSet\("ProfileStatus", "LocalImportStatus", "Status", "Worker", "Mcp", "AdminAction", "SuperAdminAction"\)/);
  assert.match(invokeProfile, /\$adminActions = @\("create_task", "update_task", "cancel_task"\)/);
  assert.match(invokeProfile, /\$superAdminActions = @\([\s\S]*?"decide_approval"[\s\S]*?"apply_patch"[\s\S]*?"create_publication_branch"[\s\S]*?"save_working_copy"[\s\S]*?"commit_revision"[\s\S]*?"attach_branch"[\s\S]*?"register_publication_version"[\s\S]*?"merge_revision"[\s\S]*?"consume_publish_capability"/);
  assert.match(invokeProfile, /SuperAdminAction requires a local DPAPI profile and exact http:\/\/\[::1\]:3000 transport/);
  assert.match(invokeProfile, /requestId = \$CommandId[\s\S]*command = if \(\$Mode -eq "SuperAdminAction"\) \{ "super_admin_action" \} else \{ "admin_action" \}[\s\S]*commandId = \$CommandId[\s\S]*payload = \$controlPayload/);
  assert.match(invokeProfile, /SetEnvironmentVariable\("WENMAI_AGENT_TOKEN"[\s\S]*SetEnvironmentVariable\("WENMAI_AGENT_TOKEN", \$null/);
  assert.doesNotMatch(consoleUi, /issuedClient\.token[^\n]*(?:AdminAction|SuperAdminAction|bridgeCommand|PayloadJson)/);
  assert.match(agentClient, /ADMIN_ACTIONS = frozenset\(\{"create_task", "update_task", "cancel_task"\}\)/);
  assert.match(agentClient, /if command == "admin_action"/);
  assert.match(agentClient, /if command == "super_admin_action"/);
  assert.match(agentClient, /SUPER_ADMIN_ACTION_ROUTES = \{[\s\S]*?"decide_approval"[\s\S]*?"apply_patch"[\s\S]*?"create_publication_branch"[\s\S]*?"save_working_copy"[\s\S]*?"commit_revision"[\s\S]*?"attach_branch"[\s\S]*?"register_publication_version"[\s\S]*?"merge_revision"[\s\S]*?"consume_publish_capability"/);
  assert.match(agentClient, /if self\.http\.origin != DEFAULT_BASE_URL/);
  assert.match(agentClient, /api_path not in ALLOWED_API_PATHS/);
  assert.match(consoleUi, /-Mode \$\{derivedRole === "super_admin" \? "SuperAdminAction" : "AdminAction"\} -Action/);
  for (const forbidden of ["issue_client", "revoke_client", "decide_approval", "merge_revision", "publish.capability.consume", "login", "external_publish"]) {
    assert.equal(agentClient.match(new RegExp(`ADMIN_ACTIONS[^\\n]*${forbidden.replaceAll(".", "\\.")}`)), null);
  }
  const contract = parsedAgentApiContract;
  assert.deepEqual(contract.authentication.privilegedAgentRoles.administrator.actions, ["create_task", "update_task", "cancel_task"]);
  assert.equal(contract.authentication.privilegedAgentRoles.superAdmin.actions.includes("merge_revision"), true);
  assert.equal(contract.authentication.privilegedAgentRoles.superAdmin.actions.includes("create_publication_branch"), true);
  assert.equal(contract.authentication.privilegedAgentRoles.superAdmin.actions.includes("attach_branch"), true);
  assert.equal(contract.authentication.privilegedAgentRoles.superAdmin.actions.includes("register_publication_version"), true);
  assert.equal(contract.authentication.privilegedAgentRoles.superAdmin.actions.includes("consume_publish_capability"), true);
  assert.equal(contract.authentication.privilegedAgentRoles.superAdmin.tailscaleAccepted, false);
  assert.deepEqual(contract.authentication.privilegedAgentRoles.keyIssueOrRevokeByAgent, {
    ordinaryAgent: false,
    siteFullControlRoot: true,
    requiredScopes: ["token.issue", "token.revoke"],
    transport: "exact [::1] loopback only",
  });
  assert.equal(contract.publishCapability.consumeAttestationFalseClaims.includes("publicAccessVerified"), true);
});
