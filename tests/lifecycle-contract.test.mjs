import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const route = readFileSync(new URL("../app/api/lifecycle/route.ts", import.meta.url), "utf8");
const schema = readFileSync(new URL("../db/schema.ts", import.meta.url), "utf8");
const types = readFileSync(new URL("../app/lifecycle-types.ts", import.meta.url), "utf8");
const consoleUi = readFileSync(new URL("../app/LifecycleConsole.tsx", import.meta.url), "utf8");
const lifecycleClient = readFileSync(new URL("../app/lifecycle-client.ts", import.meta.url), "utf8");
const platformContracts = readFileSync(new URL("../app/platform-target-contracts.ts", import.meta.url), "utf8");
const lifecycleMigration = readFileSync(new URL("../drizzle/0006_cooing_clint_barton.sql", import.meta.url), "utf8");
const integrityMigration = readFileSync(new URL("../drizzle/0012_hesitant_lorna_dane.sql", import.meta.url), "utf8");
const migrationJournal = JSON.parse(readFileSync(new URL("../drizzle/meta/_journal.json", import.meta.url), "utf8"));

const lifecycleTables = [
  "lifecycle_article_projects",
  "lifecycle_platform_targets",
  "lifecycle_adaptation_contracts",
  "lifecycle_builds",
  "lifecycle_build_gate_runs",
  "lifecycle_releases",
  "lifecycle_metric_snapshots",
  "lifecycle_metric_definitions",
  "lifecycle_metric_values",
  "lifecycle_retrospectives",
  "lifecycle_rule_candidates",
  "lifecycle_events",
];

test("运行时与 Drizzle 都声明全部生命周期表", () => {
  for (const table of lifecycleTables) {
    assert.match(route, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`));
    assert.ok(schema.includes(`"${table}"`), `Drizzle 缺少 ${table}`);
  }
});

test("面向新库的版本化迁移包含生命周期、Runner 与合并新增表", () => {
  for (const table of lifecycleTables.filter((table) => !["lifecycle_metric_definitions", "lifecycle_metric_values"].includes(table))) {
    assert.match(lifecycleMigration, new RegExp("CREATE TABLE `" + table + "`"));
  }
  for (const table of ["runner_registry", "agent_runs", "agent_steps", "agent_artifacts", "runner_leases", "command_receipts", "merge_proposals"]) {
    assert.match(lifecycleMigration, new RegExp("CREATE TABLE `" + table + "`"));
  }
  const lifecycleEntry = migrationJournal.entries.find((entry) => entry.idx === 6);
  assert.equal(lifecycleEntry?.tag, "0006_cooing_clint_barton");
  assert.ok((migrationJournal.entries.at(-1)?.idx ?? 0) >= 6, "后续迁移不应让 0006 生命周期迁移失效");
});

test("0012 迁移补齐合并唯一 tuple 与版本化原始指标", () => {
  const integrityEntry = migrationJournal.entries.find((entry) => entry.tag === "0012_hesitant_lorna_dane");
  assert.equal(integrityEntry?.idx, 12);
  assert.ok((migrationJournal.entries.at(-1)?.idx ?? 0) >= 12, "后续迁移不应让 0012 完整性合同失效");
  for (const table of ["lifecycle_metric_definitions", "lifecycle_metric_values"]) {
    assert.match(integrityMigration, new RegExp("CREATE TABLE `" + table + "`"));
  }
  assert.match(integrityMigration, /definition_set_sha256/);
  assert.match(integrityMigration, /idx_merge_proposals_active_heads/);
  assert.match(integrityMigration, /ROW_NUMBER\(\) OVER/);
  assert.match(integrityMigration, /merge\.migration_staled_duplicate/);
  for (const key of ["raw.views", "raw.reads", "raw.completionRate", "raw.saves", "raw.comments"]) {
    assert.ok(integrityMigration.includes(key), `0012 缺少 ${key}`);
  }
});

test("所有写操作先执行同源校验，并有统一成功/失败合同", () => {
  const post = route.slice(route.indexOf("export async function POST"));
  assert.ok(post.indexOf("assertSameOrigin(request)") < post.indexOf("ensureLifecycleSchema()"));
  assert.match(route, /ok: true/);
  assert.match(post, /ok: false/);
  assert.match(route, /case "create_project"/);
  assert.match(route, /case "create_build"/);
  assert.match(route, /case "update_release"/);
  assert.match(route, /case "record_metric_snapshot"/);
  assert.match(route, /case "transition_rule_candidate"/);
});

test("Lifecycle Project 可受控采用同文章 active Package 的既有 project_id", () => {
  const createProject = route.slice(
    route.indexOf("async function createProject"),
    route.indexOf("async function updateProject"),
  );
  assert.match(createProject, /const packageId = cleanText\(payload\.packageId, 120\)/);
  assert.match(createProject, /FROM article_project_packages WHERE id = \? LIMIT 1/);
  assert.match(createProject, /packageBinding\.article_id !== articleId/);
  assert.match(createProject, /packageBinding\.status !== "active"/);
  assert.match(createProject, /Number\(packageBinding\.branch_model_version\) !== 2/);
  assert.match(createProject, /id = String\(packageBinding\.project_id\)/);
  assert.match(createProject, /SELECT project_id, article_id[\s\S]*status = 'active' AND branch_model_version = 2/);
  assert.match(createProject, /package_bound_project_identity_created/);
});

test("每个 lifecycle 写动作都绑定管理身份、canonical request SHA 与可重放回执", () => {
  assert.match(route, /managementActorId\(managementPrincipal\)/);
  assert.match(route, /digest\(\{ action, actorId, payload \}\)/);
  assert.match(route, /commandType = `lifecycle\.\$\{action\}`/);
  assert.match(route, /INSERT OR IGNORE INTO command_receipts/);
  assert.match(route, /COMMAND_ID_REUSED/);
  assert.match(route, /COMMAND_IN_PROGRESS/);
  assert.match(route, /return await executeLifecycleCommand/);
  assert.match(route, /x-wenmai-request-sha256/);
  assert.match(route, /x-wenmai-replayed/);
  assert.match(lifecycleClient, /uncertainLifecycleCommands/);
  assert.match(lifecycleClient, /JSON\.stringify\(\{ action, commandId, payload \}\)/);
  assert.match(lifecycleClient, /postLifecycleMutation/);
});

test("指标值绑定不可变定义、单位、缺失策略和 raw-only 边界", () => {
  for (const marker of [
    "MetricDefinitionRecord", "MetricValueRecord", "definitionSetSha256", "schemaState",
    "definitionSha256", "observationState", "missingPolicy",
  ]) assert.ok(types.includes(marker), `指标类型缺少 ${marker}`);
  assert.match(route, /parseTypedMetricMeasurements/);
  assert.match(route, /computedDefinitionSetSha256/);
  assert.match(route, /computedMeasurementSha256/);
  assert.match(route, /crossPlatformComparable: false/);
  assert.match(route, /normalizationApplied: false/);
  assert.match(route, /旧版未类型化指标快照不能被确认/);
});

test("Build 只冻结干净分支头并绑定四类不可变输入", () => {
  assert.match(route, /w\.dirty = 0/);
  assert.match(route, /w\.base_revision_id = b\.head_revision_id/);
  assert.match(route, /w\.title = r\.document_title/);
  assert.match(route, /source_body_sha256/);
  assert.match(route, /target_profile_sha256/);
  assert.match(route, /contract_sha256/);
  assert.match(route, /revision_id/);
});

test("built、两类门禁、提交、后台与公开状态彼此分离", () => {
  assert.match(types, /BUILD_GATE_KINDS = \["compatibility", "fidelity"\]/);
  assert.match(types, /RELEASE_SUBMISSION_STATES/);
  assert.match(types, /RELEASE_DESTINATION_STATES/);
  assert.match(types, /RELEASE_PUBLIC_STATES/);
  assert.match(route, /compatibilityPassed: false/);
  assert.match(route, /fidelityPassed: false/);
  assert.match(route, /backendVerified: false/);
  assert.match(route, /publiclyVerified: false/);
  assert.match(route, /p\.execution_state = 'active'/);
  assert.match(route, /t\.status = 'active'/);
  assert.match(route, /c\.status = 'approved'/);
});

test("默认平台画像明确为人工、未连接", () => {
  const platformSource = `${route}\n${platformContracts}`;
  for (const platform of ["xiaohongshu", "bilibili", "zhihu", "maimai", "website"]) assert.ok(platformSource.includes(platform));
  assert.match(route, /deliveryMode: "manual"/);
  assert.match(route, /connectionStatus: "not_connected"/);
  assert.match(route, /不表示平台账号、发布 API 或数据接口已经连接/);
});

test("规则采纳要求范围、反例、负责人、实现、回归与证据", () => {
  for (const field of ["scope", "counterexamples", "owner", "implementationTarget", "regressionRef", "evidenceRefs"]) {
    assert.ok(route.includes(field), `规则证据合同缺少 ${field}`);
  }
  assert.match(route, /evidence_contract_satisfied/);
});

test("生命周期 UI 覆盖项目、移植、Build、发行与数据复盘的可写主链", () => {
  for (const action of [
    "create_project", "create_adaptation_contract", "create_build", "record_build_result",
    "record_build_gate", "create_release", "update_release", "record_metric_snapshot",
    "create_retrospective", "update_retrospective", "create_rule_candidate", "update_rule_candidate",
  ]) assert.ok(consoleUi.includes(`"${action}"`), `UI 缺少 ${action}`);
  assert.match(consoleUi, /full/);
  assert.match(consoleUi, /demo/);
  assert.match(consoleUi, /excerpt/);
  assert.match(consoleUi, /promo/);
  assert.match(consoleUi, /能否正常导入、渲染、阅读和完成平台流程。/);
  assert.match(consoleUi, /删改后是否仍履行核心论点、事实边界与证据含义。/);
  assert.match(consoleUi, /每一层只证明已经观察到的对象；缺少证据时不能跳层，当前 API 也不会代替你向平台补发请求。/);
  assert.match(consoleUi, /v\{definition\.version\}/);
  assert.match(consoleUi, /缺失=\{definition\.missingPolicy\}/);
  assert.match(consoleUi, /不做跨平台归一化/);
  assert.match(consoleUi, /旧版未类型化/);
  assert.doesNotMatch(consoleUi, /还没有版本化 MetricDefinition、单位和缺失值策略/);
});

test("复盘与规则候选在 UI 中可以补齐证据后再晋级", () => {
  assert.match(consoleUi, /editingRetroId/);
  assert.match(consoleUi, /saveRetrospective/);
  assert.match(consoleUi, /editingRuleId/);
  assert.match(consoleUi, /ruleEvidence/);
  assert.match(consoleUi, /saveRule/);
  assert.match(consoleUi, /evidenceContractReady/);
});

test("UI 暴露失败、证据不足、替代与恢复路径，不只允许登记成功", () => {
  for (const marker of [
    "supersede_build", "构建失败摘要", "由新合同替代", "not_found", "not_public",
    "inconclusive", "后台证据不足", "公开证据不足", "恢复测试", "退回测试", "rejected",
  ]) assert.ok(consoleUi.includes(marker), `UI 缺少负向或恢复路径：${marker}`);
});

test("Release readiness 是独立、可读回且不会由批准自动提升的状态", () => {
  const readinessMigration = readFileSync(new URL("../drizzle/0026_release_readiness.sql", import.meta.url), "utf8");
  for (const marker of ["RELEASE_READINESS_STATES", "artifact_validated", "ready_to_submit", "readinessEvidenceSha256", "readinessBlockers"]) {
    assert.ok(types.includes(marker), `readiness 类型缺少 ${marker}`);
  }
  assert.match(route, /async function markReleaseReady/);
  assert.match(route, /case "mark_ready": return markReleaseReady/);
  assert.match(route, /readiness_state = 'ready_to_submit'/);
  assert.match(route, /approval_state = 'approved' AND submission_state = 'not_submitted'/);
  assert.match(route, /readiness_evidence_sha256/);
  assert.match(route, /readiness_expired/);
  assert.match(route, /externalRequestSentByThisApi: false/);
  assert.match(route, /startReleaseSubmission[\s\S]*readiness_state = 'ready_to_submit'/);
  assert.match(readinessMigration, /ALTER TABLE `lifecycle_releases` ADD COLUMN `readiness_state`/);
  assert.doesNotMatch(readinessMigration, /DROP TABLE `lifecycle_releases`/);
  assert.ok(consoleUi.includes("mark_ready"), "UI 缺少显式标记提交就绪操作");
  assert.ok(consoleUi.includes("尚未提交"), "UI 必须提示尚未提交");
});
