import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const route = readFileSync(new URL("../app/api/agent/v1/route.ts", import.meta.url), "utf8");
const schema = readFileSync(new URL("../db/schema.ts", import.meta.url), "utf8");
const migration = readFileSync(new URL("../drizzle/0007_orange_pretty_boy.sql", import.meta.url), "utf8");
const branchMigration = readFileSync(new URL("../drizzle/0010_wide_silver_sable.sql", import.meta.url), "utf8");
const journal = JSON.parse(readFileSync(new URL("../drizzle/meta/_journal.json", import.meta.url), "utf8"));
const snapshot = JSON.parse(readFileSync(new URL("../drizzle/meta/0007_snapshot.json", import.meta.url), "utf8"));
const consoleUi = readFileSync(new URL("../app/AgentConsole.tsx", import.meta.url), "utf8");
const permissionCatalog = readFileSync(new URL("../app/agent-permission-catalog.ts", import.meta.url), "utf8");
const privilegedAgentAuth = readFileSync(new URL("../app/privileged-agent-auth.ts", import.meta.url), "utf8");
const profileSave = readFileSync(new URL("../scripts/save-wenmai-agent-profile.ps1", import.meta.url), "utf8");
const profileInvoke = readFileSync(new URL("../scripts/invoke-wenmai-agent-profile.ps1", import.meta.url), "utf8");
const discovery = JSON.parse(readFileSync(new URL("../public/.well-known/wenmai-agent.json", import.meta.url), "utf8"));
const mcpManifest = JSON.parse(readFileSync(new URL("../public/agent/mcp.json", import.meta.url), "utf8"));
const agentManifest = JSON.parse(readFileSync(new URL("../public/agent/manifest.json", import.meta.url), "utf8"));
const agentApiManifest = JSON.parse(readFileSync(new URL("../public/agent/api/v1.json", import.meta.url), "utf8"));
const taskPublicSchema = JSON.parse(readFileSync(new URL("../public/agent/schemas/task.schema.json", import.meta.url), "utf8"));
const contextPublicSchema = JSON.parse(readFileSync(new URL("../public/agent/schemas/context.schema.json", import.meta.url), "utf8"));
const guidanceChecklistPublicSchema = JSON.parse(readFileSync(new URL("../public/agent/schemas/article-guidance-checklist.schema.json", import.meta.url), "utf8"));
const agentSystemPrompt = readFileSync(new URL("../public/agent/prompts/system.md", import.meta.url), "utf8");

const controlTables = [
  "agent_clients",
  "agent_tasks",
  "agent_context_snapshots",
  "agent_task_attempts",
  "agent_task_leases",
  "agent_progress_events",
  "agent_task_artifacts",
  "agent_approval_requests",
  "graph_proposals",
];

const views = [
  "manifest", "health", "tasks", "task", "context", "events", "knowledge", "graph",
  "project_manifest", "project_packages", "project_branches", "project_package", "project_diagnostics", "project_slices",
];
const actions = [
  "issue_client", "revoke_client", "create_task", "update_task", "cancel_task",
  "claim", "heartbeat", "progress", "add_artifact", "await_human", "decide_approval",
  "propose_revision", "complete", "fail", "release", "create_graph_proposal", "decide_graph_proposal",
  "propose_package_patch",
];

test("Task、Attempt、Event、Artifact、Approval 与 Context 是独立持久对象", () => {
  for (const table of controlTables) {
    assert.ok(schema.includes(`"${table}"`), `Drizzle schema 缺少 ${table}`);
    assert.match(route, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`), `runtime bootstrap 缺少 ${table}`);
    assert.match(migration, new RegExp("CREATE TABLE `" + table + "`"), `0007 缺少 ${table}`);
  }
  assert.match(schema, /agent_tasks_state_check/);
  assert.match(schema, /agent_task_attempts_state_check/);
  assert.match(schema, /agent_progress_command/);
  assert.match(schema, /agent_approval_requests_status_check/);
  assert.match(schema, /graph_proposals_status_check/);
});

test("0007 是新库的纯新增迁移，现有 runtime-bootstrap 库边界被显式声明", () => {
  const agentEntry = journal.entries.find((entry) => entry.idx === 7);
  assert.equal(agentEntry?.tag, "0007_orange_pretty_boy");
  assert.ok((journal.entries.at(-1)?.idx ?? 0) >= 7, "后续迁移不应让 0007 Agent 控制面迁移失效");
  assert.equal(snapshot.version, "6");
  assert.doesNotMatch(migration, /\b(?:ALTER|DROP)\s+TABLE\b/i);
  assert.match(route, /migrationBoundary/);
  assert.match(route, /Existing runtime-bootstrap D1 databases must be structurally baselined/);
});

test("统一 envelope、GET view 与 POST action 合同完整", () => {
  assert.match(route, /ok: true, requestId: id, data/);
  assert.match(route, /ok: false,[\s\S]{0,80}requestId: id,[\s\S]{0,80}error:/);
  for (const view of views) assert.ok(route.includes(`"${view}"`), `缺少 GET view ${view}`);
  for (const action of actions) assert.ok(route.includes(`"${action}"`), `缺少 POST action ${action}`);
  assert.match(route, /export async function GET\(request: Request\)/);
  assert.match(route, /export async function POST\(request: Request\)/);
  assert.match(route, /clients: listedClients\.map\(\(client\) => parseClient\(client, permissionProfiles\.get\(String\(client\.id\)\) \?\? null\)\)/);
  assert.match(route, /serverTime/);
});

test("管理写与 Agent 写使用不同认证面，并执行 scope 与对象边界", () => {
  assert.match(route, /origin === url\.origin/);
  assert.match(route, /if \(fetchSite\) return \["same-origin", "none"\]\.includes\(fetchSite\)/,
    "管理页面读取 Agent 任务时不能因省略 Referer 而被误送到 Bearer 认证面");
  assert.match(route, /x-wenmai-write/);
  assert.match(route, /Authorization: Bearer <one-time-issued-token>/);
  assert.match(route, /token_sha256 = \?/);
  assert.match(route, /row\.status !== "active"/);
  assert.match(route, /AUTH_EXPIRED/);
  assert.match(route, /requireScope\(auth, scope\)/);
  assert.match(route, /auth\.articleIds\.includes\("\*"\)/);
  assert.match(route, /auth\.taskIds\.includes\(taskId\)/);
  assert.match(route, /OBJECT_BOUNDARY_REQUIRED/);
  assert.match(route, /status = 'revoked', revoked_at/);
});

test("Agent 客户端界面明确分离浏览器配对码，并支持长期凭据安全换发", () => {
  assert.match(consoleUi, /审批、合并、身份归并、删除与外部发布也不会随角色钥匙放行/);
  assert.match(consoleUi, /下载一个连接钥匙文件，目标 Agent 可直接使用/);
  assert.match(consoleUi, /文件本身就是权限/);
  assert.match(consoleUi, /下载连接钥匙文件/);
  assert.match(consoleUi, /wenmai-\$\{issuedCollaborationMode \?\? issuedRoleId \?\? "access"\}-\$\{issuedClient\.client\.id\.slice\(-12\)\}\.wenmai-agent\.json/);
  assert.match(consoleUi, /application\/vnd\.wenmai\.agent-access\+json/);
  assert.match(consoleUi, /buildPortableCollaborationAccessFile/);
  assert.match(consoleUi, /type="number" min=\{1\} max=\{maxClientLifetimeDays\} step=\{1\}/,
    "有效期必须允许在角色上限内自由填写整数天数");
  assert.match(consoleUi, /可填写 1–\{maxClientLifetimeDays\} 天/);
  assert.match(consoleUi, /function maxClientLifetimeForRole\(privilegedPreset: boolean, role: "administrator" \| "super_admin"\): AgentClientLifetimeDays/,
    "有效期上限必须只由当前预设与派生角色确定");
  assert.match(consoleUi, /const clientLifetimeValid = Number\.isInteger\(clientLifetimeDays\) && clientLifetimeDays >= 1 && clientLifetimeDays <= maxClientLifetimeDays/,
    "自由填写的有效期必须继续受同一角色上限约束");
  assert.match(consoleUi, /const applyPrivilegedScopes = useCallback\(\(nextScopes: string\[\]\) => \{[\s\S]{0,500}setClientLifetimeDays\(\(current\) => normalizeClientLifetimeDays\(current, nextMaximum\)\)/,
    "权限角色收紧有效期上限时，状态必须在同一交互中自动收敛");
  assert.match(consoleUi, /const normalizedScopes = nextScopes\.includes\("site\.full_control"\) \? \["site\.full_control"\] : nextScopes;[\s\S]{0,240}setSelectedPrivilegedScopes\(normalizedScopes\)/,
    "任何 scope 入口选中根权限时都必须规范化为独占，分类全选不得与已有 scope 并存");
  assert.match(consoleUi, /next === "permission-catalog"\) \{[\s\S]{0,200}setClientLifetimeDays\(\(current\) => normalizeClientLifetimeDays\(current, maxClientLifetimeForRole\(true, derivedPermissionRole\(permissionCatalog, selectedPrivilegedScopes\)\)\)\)/,
    "切换到权限目录模式时，状态必须在同一交互中自动收敛");
  assert.match(consoleUi, /next === "permission-catalog"\) \{[\s\S]{0,300}void loadPermissionCatalog\(privilegedArticleScope === "selected_articles"\)/,
    "切换到权限目录模式时必须按文章范围主动加载目录");
  assert.match(consoleUi, /const \[permissionCatalogLoading, setPermissionCatalogLoading\] = useState\(false\)/,
    "权限目录加载中必须有明确状态");
  assert.match(consoleUi, /正在加载角色权限目录；钥匙签发暂时禁用。/,
    "权限目录加载中必须显示可读提示");
  assert.match(consoleUi, /PERMISSION_CATALOG_TIMEOUT_MS = 10_000/,
    "权限目录请求必须有合理超时，避免挂起后静默空白");
  assert.match(consoleUi, /请求超过 10 秒未完成/,
    "权限目录超时必须显示可读错误");
  assert.match(consoleUi, /重新加载/, "权限目录失败后必须提供重试入口");
  assert.match(consoleUi, /privilegedIssuance && \(!permissionCatalog \|\| !selectedPrivilegedScopesAreIssuable/,
    "目录缺失时管理员 Key 签发必须继续 fail closed");
  assert.match(consoleUi, /权限组合不能签发：\{selectedScopeCombination\.message\}/,
    "权限组合冲突时必须在签发按钮附近显示稳定阻塞原因");
  assert.doesNotMatch(consoleUi, /useEffect\(\(\) => \{\s*setClientLifetimeDays/,
    "不得依赖 effect 在渲染后修正有效期状态");
  assert.match(consoleUi, /useState<AgentClientLifetimeDays>\(7\)/);
  assert.match(consoleUi, /一次性 Key 仅在本窗口显示；关闭、Esc 或完成都会立即清除/);
  assert.match(consoleUi, /复制一次性 Key/);
  assert.match(consoleUi, /本次 Key 已签发，已有一次性 Key 待保存；完成并清除后才能继续签发。/,
    "已有一次性 Key 时必须说明签发已完成且需先保存");
  assert.match(consoleUi, /\{issuedClient \? \(issuedPortableFile \? "连接钥匙待下载" : "已有一次性 Key 待保存"\) : issueClientButtonLabel\}/,
    "已有一次性 Key 时按钮不得伪装成可再次签发");
  assert.match(consoleUi, /const issuedClientResultRef = useRef<HTMLElement>\(null\)/,
    "签发结果区必须保有可访问的 DOM ref");
  assert.match(consoleUi, /if \(!issuedClient\) return;[\s\S]{0,240}result\.scrollIntoView\([\s\S]{0,160}result\.focus\(\{ preventScroll: true \}\)/,
    "签发结果出现时必须在 DOM effect 中滚动并聚焦");
  assert.match(consoleUi, /className="issued-agent-token" tabIndex=\{-1\} aria-labelledby="issued-agent-token-title" aria-live="polite"/,
    "签发结果区必须有明确可访问性状态");
  assert.match(consoleUi, /setIssuedTokenVisible\(false\);[\s\S]{0,120}await loadTasks\(\);/,
    "签发成功后不得自动显示一次性明文");
  assert.match(consoleUi, /closeClientPanel/);
  assert.match(consoleUi, /setIssuedClient\(null\)/);
  assert.match(consoleUi, /审批、合并、身份归并、删除与外部发布也不会随角色钥匙放行/);
  assert.match(consoleUi, /不能签发\/撤销 Key、签发发布票据、处理登录\/2FA 或点击外部发布；消费能力不等于提交成功或公开/);
  assert.match(consoleUi, /不能签发\/撤销 Key、登录\/2FA、签发发布能力或点击最终发布/);
  assert.match(consoleUi, /准备换发/);
  assert.match(consoleUi, /先签发并验证新 token，再撤销旧 token/);
  assert.match(route, /await sha256Text\(token\)/);
  assert.match(route, /shownOnce: true/);
});

test("v5 根 Key 直接 API 与可选兑换共用，旧 v4 仍隔离且不静默扩权", () => {
  assert.match(permissionCatalog, /auth\.site_full_control\.direct/);
  assert.match(permissionCatalog, /auth\.site_full_control\.exchange/);
  assert.match(consoleUi, /Agent 站内全权（本机）/);
  assert.match(consoleUi, /const issueClientButtonLabel = collaborationMode === "viewer"/);
  assert.match(consoleUi, /生成 \$\{clientLifetimeDays\} 天只读通行证/);
  assert.match(consoleUi, /生成 \$\{clientLifetimeDays\} 天任务协作通行证/);
  assert.match(consoleUi, /手工签发 \$\{clientLifetimeDays\} 天 Agent 站内全权 Key/);
  assert.match(consoleUi, /可直接 Agent API · 可选管理会话兑换/);
  assert.match(consoleUi, /旧版仅兑换，需换发/);
  assert.equal(agentManifest.privilegedRoles.siteFullControl.directAgentApi, true);
  assert.deepEqual(agentManifest.privilegedRoles.siteFullControl.actionIds, ["auth.site_full_control.direct", "auth.site_full_control.exchange"]);
  assert.equal(agentApiManifest.authentication.privilegedAgentRoles.siteFullControl.credentialPurpose, "site_full_control");
  assert.equal(agentApiManifest.authentication.privilegedAgentRoles.siteFullControl.directAgentApi, true);
  assert.match(privilegedAgentAuth, /row\.credential_purpose === "management_session_exchange"/);
  assert.match(privilegedAgentAuth, /SITE_FULL_CONTROL_EXCHANGE_REQUIRED/);
  assert.match(privilegedAgentAuth, /这是旧 v4 网站根 Key，只能兑换管理会话/);
  assert.match(privilegedAgentAuth, /row\.credential_purpose === "site_full_control"/);
  assert.match(privilegedAgentAuth, /SITE_FULL_CONTROL_DIRECT_SCOPE_REQUIRED/);
  assert.match(agentSystemPrompt, /旧 v4 根 Key 仅可兑换管理会话，必须换发，绝不静默扩权/);
  assert.match(agentSystemPrompt, /Agent API 成功不等于公开发布/);
});

test("Agent 客户端界面可生成 Tailscale 远程命令且不复用管理凭据", () => {
  assert.match(consoleUi, /DEFAULT_TAILSCALE_HOST = ""/);
  assert.match(consoleUi, /currentTailscaleHost/);
  assert.match(consoleUi, /本机页面不会猜测或保存旧机器名/);
  assert.match(consoleUi, /我的跨设备网络（Tailscale）/);
  assert.match(consoleUi, /TailscaleHost/);
  assert.match(consoleUi, /不接受 IP、端口或任意 URL/);
  assert.match(consoleUi, /save-wenmai-agent-profile\.ps1/);
  assert.match(consoleUi, /invoke-wenmai-agent-profile\.ps1/);
  assert.doesNotMatch(consoleUi, /env: \{ WENMAI_AGENT_TOKEN:/);
  assert.doesNotMatch(consoleUi, /\$env:WENMAI_AGENT_TOKEN='\$\{issuedClient\.token\}'/);
  assert.match(profileSave, /ProtectedData\]::Protect/);
  assert.match(profileSave, /DataProtectionScope\]::CurrentUser/);
  assert.match(profileInvoke, /ProtectedData\]::Unprotect/);
  assert.match(profileInvoke, /--trusted-tailscale-host/);
  assert.doesNotMatch(consoleUi, /WENMAI_MANAGEMENT|X-Wenmai-CSRF|Browser-Binding/);
});

test("Agent Key 签发回执幂等但绝不持久化一次性明文，过期时间规范为 UTC ISO", () => {
  assert.match(route, /const issueCommandId = requiredText\(commandId, "commandId", 160\)/);
  assert.match(route, /withReceipt\([\s\S]*action,[\s\S]*principal\.actorId,[\s\S]*issueClient\(db, payload/,
    "v5 签发回执必须仍绑定经认证的管理主体或 site.full_control 主体，不能脱离 actor 记账");
  assert.match(route, /if \(action === "issue_client"\)/);
  assert.match(route, /delete persistedData\.token/);
  assert.match(route, /secretRecoverable = false/);
  assert.match(route, /secret_unavailable_revoke_and_reissue/);
  assert.match(route, /const expiresAt = new Date\(expiryTime\)\.toISOString\(\)/);
  assert.match(route, /effectiveStatus/);
});

test("Package MCP 读取桥只接受 Agent Bearer，并在 SQL 层限界真实多分支对象", () => {
  assert.match(route, /"package\.read", "package\.patch\.propose"/);
  const projectReadGate = route.slice(
    route.indexOf('if (["project_manifest"'),
    route.indexOf('if (view === "health")'),
  );
  assert.match(projectReadGate, /authenticateClient\(db, request, "package\.read", "management\.read"\)/);
  assert.match(projectReadGate, /requireScope\(auth, "package\.read"\)/);
  assert.doesNotMatch(projectReadGate, /authorizeRead|requireManagementSession|sameOrigin/);

  const projectRead = route.slice(
    route.indexOf("function projectArticleBoundary"),
    route.indexOf("let corpusShaPromise"),
  );
  assert.match(projectRead, /projectArticleBoundary\(auth, "root"\)/);
  assert.match(projectRead, /sql: `\$\{prefix\}article_id IN/);
  assert.match(projectRead, /SELECT root\.\* FROM article_project_packages root[\s\S]{0,160}root\.id = \? AND \$\{boundary\.sql\}/);
  assert.match(projectRead, /JOIN article_branches branch ON branch\.id = state\.branch_id AND branch\.article_id = \?/);
  assert.match(projectRead, /WHERE state\.package_id = \? AND state\.branch_id = \?/);
  assert.match(projectRead, /requiredText\(url\.searchParams\.get\("branchId"\), "branchId"/);
  assert.match(projectRead, /PACKAGE_BRANCH_UNAVAILABLE/);
  assert.match(projectRead, /duplicateCompositionDocumentReturned: false/);
  assert.match(projectRead, /JOIN branch_working_copies article_copy/);
  assert.match(projectRead, /article_copy\.body_sha256 AS article_working_body_sha256/);
  assert.match(projectRead, /LEFT JOIN package_composition_materializations materialization/);
  assert.match(projectRead, /LEFT JOIN package_branch_composition_commits commit_ref/);
  for (const equality of [
    "Number(row.package_dirty) === 0",
    "String(row.package_document_sha256) === String(row.composition_document_sha256)",
    "String(row.article_working_body_sha256) === String(row.head_body_sha256)",
    "String(row.materialization_composition_sha256) === String(row.head_composition_sha256)",
    "String(row.materialization_body_sha256) === String(row.head_body_sha256)",
    "String(row.commit_composition_sha256) === String(row.head_composition_sha256)",
  ]) assert.ok(projectRead.includes(equality), `Agent Package readback inSync 缺少 ${equality}`);
  assert.match(route, /loadLatestVerifiedArticleGuidanceDecision/);

  assert.equal(agentApiManifest.authentication.projectReads.type, "agent_bearer_only");
  assert.equal(agentApiManifest.authentication.projectReads.requiredScope, "package.read");
  assert.equal(agentApiManifest.authentication.projectReads.managementCookieAccepted, false);
  assert.ok(agentApiManifest.getViews.project_branches);
  assert.equal(mcpManifest.packageTools.requiredReadScope, "package.read");
  assert.equal(mcpManifest.packageTools.managementCookieUsed, false);
  assert.equal(discovery.dataInterfaces.articleProjectPackages, "/api/agent/v1?view=project_manifest");
});

test("所有 Agent 写要求 commandId 并由 canonical SHA 的 CommandReceipt 去重", () => {
  assert.match(route, /requiredText\(commandId, "commandId", 160\)/);
  assert.match(route, /canonicalJson\(\{ action, actorId, payload \}\)/);
  assert.match(route, /requestSha256 = await sha256Text/);
  assert.match(route, /SELECT \* FROM command_receipts WHERE id = \?/);
  assert.match(route, /COMMAND_ID_REUSED/);
  assert.match(route, /status_code = 0/);
  assert.match(route, /COMMAND_IN_PROGRESS/);
  assert.doesNotMatch(route, /DELETE FROM command_receipts/);
});

test("claim 以条件写竞争，租约只存摘要，heartbeat 序号严格递增并能回收过期 attempt", () => {
  assert.match(route, /WHERE id = \? AND state = 'queued' AND active_attempt_id IS NULL/);
  assert.match(route, /lease_token_sha256/);
  assert.match(route, /deriveLeaseToken\(auth\.token, leaseId\)/);
  assert.match(route, /delete persistedLease\.leaseToken/);
  assert.match(route, /heartbeatSeq !== previousSeq \+ 1/);
  assert.match(route, /heartbeat_seq = \? AND heartbeat_at = \?/);
  assert.match(route, /lease\.expires_at <= \?/);
  assert.match(route, /eventType: "lease\.expired"/);
  assert.match(route, /state = 'queued', active_attempt_id = NULL, assigned_client_id = NULL/);
  assert.match(route, /contextSha256: String\(context\.context_sha256\)/);
});

test("冻结上下文绑定正文 revision、正文摘要、corpus digest、图谱与已采纳规则", () => {
  for (const marker of [
    "revisionId", "bodySha256", "bodyText", "corpusSchemaVersion", "corpusAlgorithmVersion",
    "corpusGeneratedAt", "corpusSha256", "graphSha256", "rulesSha256", "contextSha256",
  ]) assert.ok(route.includes(marker), `上下文冻结缺少 ${marker}`);
  assert.match(route, /current_context_snapshot_id/);
  assert.match(route, /source:\s*\{ articleId: task\.articleId, branchId, revisionId, documentTitle, bodySha256, bodyText \}/);
  assert.match(route, /generatedCorpusReadOnly: true/);
});

test("0010 Package Agent 上下文按目标 ArticleBranch 冻结且与其他分支推进隔离", () => {
  for (const table of ["package_branch_states", "package_branch_working_copies", "package_branch_composition_commits"]) {
    assert.match(branchMigration, new RegExp("CREATE TABLE `" + table + "`"), `0010 缺少 ${table}`);
    assert.ok(route.includes(`"${table}"`), `Agent Package 可用性门禁缺少 ${table}`);
  }
  assert.match(schema, /baseRevisionId: text\("base_revision_id"\)/);
  assert.match(schema, /baseBranchLockVersion: integer\("base_branch_lock_version"\)/);
  assert.match(schema, /branchStateLockVersion: integer\("branch_state_lock_version"\)/);
  assert.match(route, /JOIN package_branch_states state[\s\S]{0,160}state\.branch_id = \?/);
  assert.match(route, /JOIN package_branch_working_copies package_copy/);
  assert.match(route, /JOIN package_branch_composition_commits commit_ref/);
  assert.match(route, /package_id = \? AND branch_id = \? AND base_revision_id = \? AND base_branch_lock_version = \?/);
  assert.match(route, /packageBaseline: packageSnapshot \? \{/);
  for (const marker of [
    "branchId", "baseRevisionId", "baseBranchLockVersion", "compositionSha256",
    "diagnosisSummarySha256", "guidanceChecklistSha256",
  ]) {
    assert.ok(route.includes(marker), `Package context digest contract 缺少 ${marker}`);
  }
  assert.match(route, /guidanceChecklist = await buildVerifiedPackageGuidanceChecklist\(/);
  assert.match(route, /guidanceChecklist,[\s\S]{0,220}writeBoundary: \{ candidateOnly: true/);
  assert.match(route, /guidanceChecklistSha256: guidanceChecklist\.checklistSha256/);
  assert.match(route, /packageBaseline: packageSnapshot \? \{[\s\S]{0,700}guidanceChecklistSha256: packageSnapshot\.guidanceChecklistSha256/);

  const currentGuard = route.slice(
    route.indexOf("async function assertFrozenPackageContextCurrent"),
    route.indexOf("async function manifestData"),
  );
  assert.match(currentGuard, /expected\.baseBranchLockVersion !== snapshot\.baseBranchLockVersion/);
  assert.match(currentGuard, /expected\.baseRevisionId !== snapshot\.baseRevisionId/);
  assert.match(currentGuard, /expected\.guidanceChecklistSha256 !== snapshot\.guidanceChecklistSha256/);
  assert.doesNotMatch(currentGuard, /expected\.packageLockVersion|snapshot\.packageLockVersion/,
    "其他分支导致的 Package root lock 变化不能让目标分支上下文失效");

  const frozenSnapshot = route.slice(
    route.indexOf("async function loadFrozenPackageSnapshot"),
    route.indexOf("async function buildContextSnapshot"),
  );
  assert.match(frozenSnapshot, /branch_copy\.body_sha256 AS branch_copy_body_sha256/);
  assert.match(frozenSnapshot, /row\.branch_copy_body_sha256 === row\.head_body_sha256/);
  assert.match(frozenSnapshot, /const branchBridgeInSync =/);
  assert.match(frozenSnapshot, /branchBridgeInSync,/);
  assert.doesNotMatch(frozenSnapshot, /branchBridgeInSync: true/);
});

test("Package Patch 使用 branch CAS，旧 Package lock 只在当前 primary 分支兼容", () => {
  const proposal = route.slice(
    route.indexOf("async function proposePackagePatch"),
    route.indexOf("async function createGraphProposal"),
  );
  assert.match(proposal, /requiredText\(payload\.baseRevisionId, "baseRevisionId"/);
  assert.match(proposal, /payload\.expectedBranchLockVersion/);
  assert.match(proposal, /if \(!snapshot\.primaryBranch\)/);
  assert.match(proposal, /package\.primary_branch_id = state\.branch_id AND package\.lock_version = \?/);
  assert.match(proposal, /task\.target_branch_id = state\.branch_id/);
  assert.match(proposal, /task\.base_revision_id = state\.head_revision_id/);
  assert.match(proposal, /task\.base_branch_lock_version = state\.lock_version/);
  assert.match(proposal, /context\.branch_state_lock_version = state\.lock_version/);
  assert.match(proposal, /base_package_lock_version, base_branch_lock_version/);
  assert.match(proposal, /'candidate', 1, 'agent'/);
  assert.match(proposal, /JOIN article_revisions head[\s\S]*branch_copy\.body_sha256 = head\.body_sha256/);
  assert.match(proposal, /bridge\.article_body_sha256 = head\.body_sha256/);
  assert.doesNotMatch(proposal, /UPDATE package_branch_states|UPDATE article_branches|INSERT INTO article_revisions/);
});

test("Agent 公开 task/context/API schema 暴露分支与指导清单基线且保持 candidate-only", () => {
  for (const field of ["baseRevisionId", "baseBranchLockVersion"]) {
    assert.ok(taskPublicSchema.required.includes(field), `task schema 缺少 ${field}`);
    assert.ok(contextPublicSchema.required.includes(field), `context schema 缺少 ${field}`);
  }
  const packageBaselineSchema = contextPublicSchema.$defs.bundle.properties.packageBaseline.anyOf
    .find((entry) => entry.type === "object");
  const packageContextSchema = contextPublicSchema.$defs.bundle.properties.packageContext.anyOf
    .find((entry) => entry.type === "object");
  assert.ok(packageBaselineSchema.required.includes("guidanceChecklistSha256"));
  assert.ok(packageContextSchema.required.includes("guidanceChecklist"));
  assert.equal(packageContextSchema.properties.guidanceChecklist.$ref, "article-guidance-checklist.schema.json");
  assert.equal(taskPublicSchema.properties.permissionCeiling.properties.writeScope.enum.includes("package-patch"), true);
  assert.ok(agentApiManifest.agentActions.propose_package_patch);
  assert.ok(agentApiManifest.agentActions.propose_package_patch.payloadRequired.includes("expectedBranchLockVersion"));
  assert.match(agentApiManifest.agentActions.propose_package_patch.boundary, /candidateOnly=true/);
  assert.equal(mcpManifest.writeContract.packageContextBoundToTargetBranch, true);
  assert.equal(mcpManifest.boundaries.packagePatchApply, false);
});

test("guidanceChecklist 给小模型机器导航，但 Patch 决策与完成权仍归人和协调者", () => {
  assert.equal(agentManifest.schemas.articleGuidanceChecklist, "/agent/schemas/article-guidance-checklist.schema.json");
  assert.equal(guidanceChecklistPublicSchema.properties.schemaVersion.const, "wenmai-article-guidance-checklist/1.0.0");
  for (const field of [
    "checklistSha256", "archiveReady", "editorialWorkReady", "checks", "nextAction",
    "workUnits", "permissions", "completionBoundary", "bindings",
  ]) assert.ok(guidanceChecklistPublicSchema.required.includes(field), `guidance checklist schema 缺少 ${field}`);
  assert.equal(guidanceChecklistPublicSchema.$defs.workUnit.properties.allowedWrite.const, "candidate_patch_only");
  assert.equal(
    guidanceChecklistPublicSchema.$defs.permissions.properties.patchDecisionAuthority.const,
    "owner_or_authorized_coordinator_only",
  );
  assert.equal(guidanceChecklistPublicSchema.$defs.permissions.properties.completionAuthority.const, "coordinator_only");
  for (const claim of [
    "editorialComplete", "artifactDelivered", "submissionAccepted", "destinationRecordVerified",
    "publicAccessVerified", "outcomeVerified",
  ]) assert.equal(guidanceChecklistPublicSchema.$defs.completionBoundary.properties[claim].const, false, `${claim} 必须保持 false`);
  assert.match(agentSystemPrompt, /guidanceChecklist[^\n]*不是授权/);
  assert.match(agentSystemPrompt, /小模型不得自行调用 `complete`/);
  const bindingTypes = guidanceChecklistPublicSchema.properties.bindings.patternProperties["^.+$"].anyOf
    .map((entry) => entry.type).sort();
  assert.deepEqual(bindingTypes, ["boolean", "null", "number", "string"]);
});

test("Package Patch 公开合同冻结单个现有模块、限制相邻边并脱敏任务详情", () => {
  const createTask = route.slice(route.indexOf("async function createTask"), route.indexOf("async function updateTask"));
  const updateTask = route.slice(route.indexOf("async function updateTask"), route.indexOf("async function cancelTask"));
  const claimTask = route.slice(route.indexOf("async function claimTask"), route.indexOf("async function heartbeat"));
  const packagePatch = route.slice(route.indexOf("function packagePatchOperations"), route.indexOf("async function createGraphProposal"));
  const taskDetail = route.slice(route.indexOf('if (view === "task")'), route.indexOf('if (view === "context")'));

  assert.match(createTask, /requiredText\(payload\.targetModuleKey \?\? rawContextSpec\.targetModuleKey, "targetModuleKey", 120\)/);
  assert.match(createTask, /assertFrozenTargetModule\(packageSnapshot, requestedTargetModuleKey\)/);
  assert.match(createTask, /assertPackagePatchAgentGuidance\(packageSnapshot\.bundle\.guidanceChecklist, "create_task", "current"\)/);
  assert.match(updateTask, /PACKAGE_TARGET_MODULE_IMMUTABLE/);
  assert.match(claimTask, /permissionCeiling\.writeScope === "package-patch" && !auth\.scopes\.includes\("package\.patch\.propose"\)/);
  assert.match(claimTask, /CLIENT_SCOPE_INSUFFICIENT_FOR_TASK/);
  assert.match(claimTask, /assertPackagePatchAgentGuidance\(packageGuidanceFromContextRow\(context\), "claim", "frozen"\)/);
  assert.match(claimTask, /loadFrozenPackageSnapshot[\s\S]*assertPackagePatchAgentGuidance\(currentPackageSnapshot\?\.bundle\.guidanceChecklist, "claim", "current"\)[\s\S]*assertFrozenPackageContextCurrent\(db, task, context, currentPackageSnapshot\)/);
  assert.match(packagePatch, /new Set\(\["replace_module", "remove_module", "upsert_edge", "remove_edge"\]\)/);
  assert.match(packagePatch, /PACKAGE_PATCH_DOCUMENT_REPLACE_FORBIDDEN/);
  assert.match(packagePatch, /PACKAGE_PATCH_TARGET_SCOPE_VIOLATION/);
  assert.match(packagePatch, /operation\.moduleKey !== targetModuleKey \|\| replacementKey !== targetModuleKey/);
  assert.match(packagePatch, /sourceModuleKey !== targetModuleKey && targetEdgeModuleKey !== targetModuleKey/);
  assert.match(packagePatch, /remove_edge 只能删除冻结 Composition 中与 targetModuleKey 相连的边/);
  assert.match(packagePatch, /assertPackagePatchAgentGuidance\(packageGuidanceFromContextRow\(context\), "propose_package_patch", "frozen"\)/);
  assert.match(packagePatch, /loadFrozenPackageSnapshot[\s\S]*assertPackagePatchAgentGuidance\(currentPackageSnapshot\?\.bundle\.guidanceChecklist, "propose_package_patch", "current"\)[\s\S]*assertFrozenPackageContextCurrent\(db, guard\.task, context, currentPackageSnapshot\)/);

  assert.match(taskDetail, /bundle: undefined/);
  assert.match(taskDetail, /safePackageContextProjection\(row\)/);
  assert.match(taskDetail, /packagePatchProposals: packagePatches\.results\.map\(parsePackagePatchProposal\)/);
  assert.doesNotMatch(taskDetail, /contextSnapshots:[\s\S]{0,240}parseContext\(row\)\)\s*,/,
    "任务详情不能只调用 parseContext 后把隐藏 bundle 原样返回");

  const taskPackageRule = taskPublicSchema.allOf.find((entry) =>
    entry.if?.properties?.permissionCeiling?.properties?.writeScope?.const === "package-patch");
  assert.ok(taskPackageRule);
  assert.ok(taskPackageRule.then.properties.contextSpec.required.includes("targetModuleKey"));
  const packageBaselineSchema = contextPublicSchema.$defs.bundle.properties.packageBaseline.anyOf.find((entry) => entry.type === "object");
  const packageContextSchema = contextPublicSchema.$defs.bundle.properties.packageContext.anyOf.find((entry) => entry.type === "object");
  assert.ok(packageBaselineSchema.required.includes("targetModuleKey"));
  assert.deepEqual(packageContextSchema.properties.allowedPatchOperations.const,
    ["replace_module", "remove_module", "upsert_edge", "remove_edge"]);
  assert.equal(packageContextSchema.properties.patchTarget.properties.moduleScope.const, "single_existing_module");
  assert.equal(packageContextSchema.properties.patchTarget.properties.edgeScope.const, "incident_to_target_only");

  const publicPatch = agentApiManifest.agentActions.propose_package_patch;
  assert.equal(publicPatch.requiresClientScope, "package.patch.propose");
  assert.deepEqual(publicPatch.allowedOperations, ["replace_module", "remove_module", "upsert_edge", "remove_edge"]);
  assert.deepEqual(publicPatch.forbiddenOperations, ["replace_document", "add_module"]);
  assert.equal(agentApiManifest.getViews.task.contextSnapshotProjection.bundleReturned, false);
  assert.match(agentApiManifest.getViews.task.candidateReceipts, /packagePatchProposals/);
  assert.equal(mcpManifest.packageTools.candidatePatch.requiresClientScope, "package.patch.propose");
  assert.deepEqual(mcpManifest.packageTools.candidatePatch.allowedOperations,
    ["replace_module", "remove_module", "upsert_edge", "remove_edge"]);
  assert.equal(mcpManifest.packageTools.taskDetailProjection.frozenBundleReturned, false);
  assert.match(agentSystemPrompt, /`replace_document` 与 `add_module` 始终禁止/);
  assert.match(agentSystemPrompt, /冻结的既有 `targetModuleKey`/);

  for (const code of [
    "MISSING_FIELD", "TASK_PERMISSION_DENIED", "CLIENT_SCOPE_INSUFFICIENT_FOR_TASK", "PACKAGE_TARGET_MODULE_NOT_FOUND",
    "PACKAGE_TARGET_MODULE_CONTEXT_MISMATCH", "PACKAGE_TARGET_MODULE_IMMUTABLE",
    "PACKAGE_PATCH_DOCUMENT_REPLACE_FORBIDDEN", "PACKAGE_PATCH_TARGET_SCOPE_VIOLATION",
    "INVALID_PACKAGE_PATCH", "PACKAGE_PATCH_TOO_LARGE",
  ]) assert.ok(agentApiManifest.errorCodes.includes(code), `公开 API 合同缺少 ${code}`);
});

test("package-patch 三层门禁只接受 Agent 可修复的唯一下一步", () => {
  const gate = route.slice(
    route.indexOf("function assertPackagePatchAgentGuidance"),
    route.indexOf("async function deriveLeaseToken"),
  );
  assert.match(gate, /value\.schemaVersion !== ARTICLE_GUIDANCE_CHECKLIST_SCHEMA_VERSION/);
  assert.match(gate, /nextActor === "agent"/);
  assert.match(gate, /checkActor === "agent"/);
  assert.match(gate, /checkStatus === "pending"/);
  assert.match(gate, /onFailure === "repair_as_candidate"/);
  assert.match(gate, /nextAllowedActions\.includes\("propose_package_patch"\)/);
  for (const reason of ["blocked", "human_required", "coordinator_required", "propose_action_not_allowed"]) {
    assert.ok(gate.includes(`"${reason}"`), `指导门禁缺少稳定原因 ${reason}`);
  }
  assert.match(gate, /GUIDANCE_CHECKLIST_REQUIRED/);
  assert.match(gate, /GUIDANCE_CHECKLIST_OPEN/);
});

test("package-patch 完成权固定归协调者，小模型只能 progress + await_human", () => {
  const completion = route.slice(
    route.indexOf("async function completeTask"),
    route.indexOf("async function decideApproval"),
  );
  assert.match(completion, /permissionCeiling\.writeScope === "package-patch"/);
  assert.match(completion, /if \(packagePatchTask\)[\s\S]*COORDINATOR_COMPLETION_REQUIRED/);
  assert.match(completion, /completionAuthority: "coordinator_only"/);
  assert.match(completion, /allowedActions: \["progress", "await_human"\]/);
  assert.doesNotMatch(completion, /SELECT id FROM package_patch_proposals/);
  assert.match(completion, /targetState: "review"/);
  assert.match(completion, /technicalCandidateOnly: true, editorialApproved: false, releaseApproved: false/);
  const publicBoundary = agentApiManifest.agentActions.complete.packagePatchBoundary;
  assert.equal(publicBoundary.accepted, false);
  assert.equal(publicBoundary.errorCode, "COORDINATOR_COMPLETION_REQUIRED");
  assert.equal(publicBoundary.completionAuthority, "coordinator_only");
  assert.deepEqual(publicBoundary.allowedAgentActionsAfterCandidate, ["progress", "await_human"]);
  assert.equal(agentApiManifest.agentActions.complete.targetState, "review");
  assert.equal(agentManifest.safety.packagePatchCompleteAllowedForAgent, false);
  assert.equal(agentManifest.safety.packagePatchCompletionAuthority, "coordinator_only");
  assert.match(agentSystemPrompt, /COORDINATOR_COMPLETION_REQUIRED/);
  assert.match(agentApiManifest.agentActions.await_human.guidanceChecklistBoundary, /requests a human decision and never supplies that decision/);
  assert.ok(agentApiManifest.errorCodes.includes("COORDINATOR_COMPLETION_REQUIRED"));
});

test("动态 manifest 对弱模型暴露同一完成权边界，不再提示 package-patch 调用 complete", () => {
  const dynamicManifest = route.slice(
    route.indexOf("async function manifestData"),
    route.indexOf("export async function GET"),
  );
  assert.match(dynamicManifest, /packagePatchCompleteAccepted: false/);
  assert.match(dynamicManifest, /packagePatchCompletionAuthority: "coordinator_only"/);
  assert.match(dynamicManifest, /weakModelCompletionToolExposed: false/);
  assert.match(dynamicManifest, /candidateHandoff: "progress checkpoint followed by await_human or coordinator handoff"/);
  assert.match(dynamicManifest, /completionErrorCode: "COORDINATOR_COMPLETION_REQUIRED"/);
  assert.match(dynamicManifest, /call await_human or hand off to the coordinator; never call complete for package-patch/);
  assert.doesNotMatch(dynamicManifest, /request human decision or complete/);
});

test("进度事件 append-only，工件与人类请求保持独立状态机", () => {
  assert.doesNotMatch(route, /UPDATE agent_progress_events/);
  assert.doesNotMatch(route, /DELETE FROM agent_progress_events/);
  assert.match(route, /eventType: blocker \? "progress\.blocked" : "progress\.reported"/);
  assert.match(route, /INSERT INTO agent_task_artifacts/);
  assert.match(route, /MAX_INLINE_ARTIFACT_BYTES/);
  assert.match(route, /INSERT INTO agent_approval_requests/);
  assert.match(route, /targetState: "review"/);
  assert.match(route, /technicalCandidateOnly: true/);
  assert.match(route, /editorialApproved: false/);
  assert.match(route, /releaseApproved: false/);
});

test("Agent 权限天花板拒绝主分支、合并、审批、发布、规则采纳与源文件写入", () => {
  for (const denied of [
    "main.write", "main.merge", "editorial.approve", "release.approve", "external.submit",
    "rule.adopt", "source.write", "token.issue",
  ]) assert.ok(route.includes(`"${denied}"`), `缺少硬拒绝权限 ${denied}`);
  assert.match(route, /const branchWrite = writeScope === "agent-branch"/);
  assert.match(route, /directMainWrite: false/);
  assert.match(route, /externalSideEffects: false/);
  assert.match(route, /humanApprovalRequired: true/);
});

test("Agent 专属分支由 create_task 建立，propose_revision 只以 clean base=head 做 CAS", () => {
  assert.match(route, /writeScope === "agent-branch"/);
  assert.match(route, /name: `agent\/\$\{code\}`/);
  assert.match(route, /id: `agent-branch-\$\{taskId\}`/);
  assert.match(route, /event_type, subject_type, subject_id/);
  assert.match(route, /'agent\.branch_created'/);
  assert.match(route, /async function proposeRevision/);
  assert.match(route, /expectedHeadRevisionId/);
  assert.match(route, /copy\.base_revision_id = \?/);
  assert.match(route, /copy\.dirty = 0/);
  assert.match(route, /head_revision_id = \?/);
  assert.match(route, /author_kind = 'agent'/);
  assert.match(route, /directMainWrite: false/);
  assert.match(route, /mergePerformed: false/);
  assert.match(route, /mainWritten: false/);
});

test("knowledge 与 graph 只读 generated corpus，限制深度、条数且不返回正文全集", () => {
  assert.match(route, /Math\.min\(2, depth\)/);
  assert.match(route, /Math\.min\(100, limit\)/);
  assert.match(route, /summary: article\.summary\.slice\(0, 600\)/);
  assert.match(route, /bodyTextIncluded: false/);
  assert.match(route, /status IN \('candidate','confirmed'\)/);
  assert.match(route, /canonicalGraphMutated: false/);
  assert.match(route, /corpusRegenerationRequired/);
});

test("issue_client、create_task、claim 与 decide_approval 响应包含 UI/SDK 所需稳定字段", () => {
  assert.match(route, /data: \{ client: row \? parseClient\(row\) : null, token, shownOnce: true \}/);
  assert.match(route, /task: parseTask\(row\), contextSnapshot:/);
  assert.match(route, /lease: \{ id: leaseId, taskId, attemptId, expiresAt, heartbeatSeq: 0, leaseToken, shownOnce: true \}/);
  assert.match(route, /contextUrl:/);
  assert.match(route, /approvalRequest: updatedApproval \? parseApproval\(updatedApproval\) : null/);
});

test("Agent 创建任务冻结文章所有权、编辑模式与立场，调研任务不再隐式套用质疑体", () => {
  assert.match(consoleUi, /taskOwnerContract/);
  assert.match(consoleUi, /taskEditorialMode/);
  assert.match(consoleUi, /taskStance/);
  assert.match(consoleUi, /schemaVersion: "writing-contract\/1\.0"/);
  assert.match(consoleUi, /ownerContract: taskOwnerContract/);
  assert.match(consoleUi, /editorialMode: taskEditorialMode/);
  assert.match(consoleUi, /stance: taskStance/);
  assert.match(consoleUi, /titleJob: taskTitleJob\.trim\(\)/);
  assert.match(consoleUi, /openingJob: taskOpeningJob\.trim\(\)/);
  assert.match(consoleUi, /tensionBasis: taskTensionBasis\.trim\(\)/);
  assert.match(consoleUi, /writingContract \? \{ writingContract \} : \{\}/);
  assert.match(consoleUi, /调研盘点/);
  assert.match(consoleUi, /中性/);
});

test("MCP Host 有可发现合同与一次性本地配置，且不扩大 Agent 权限", () => {
  assert.equal(discovery.mcp, "/agent/mcp.json");
  assert.equal(mcpManifest.implementation.script, "scripts/wenmai_mcp_server.py");
  assert.equal(mcpManifest.transport.kind, "stdio");
  assert.equal(mcpManifest.writeContract.stableCommandIdRequired, true);
  assert.equal(mcpManifest.boundaries.mainBranchWrite, false);
  assert.equal(mcpManifest.boundaries.externalSubmission, false);
  assert.match(consoleUi, /href="\/agent\/mcp\.json"/);
  assert.match(consoleUi, /issuedClient\.client\.clientKind === "mcp"/);
  assert.match(profileInvoke, /wenmai_mcp_server\.py/);
  assert.match(consoleUi, /无秘密 MCP Host 配置/);
  assert.match(consoleUi, /clientPackageMode/);
  assert.match(consoleUi, /工程只读（推荐 · package\.read）/);
  assert.match(consoleUi, /scopes\.push\("package\.read"\)/);
  assert.match(consoleUi, /scopes\.push\("package\.patch\.propose"\)/);
});
