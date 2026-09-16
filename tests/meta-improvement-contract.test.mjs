import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

const [route, schema, migration, vite, gitignore, consoleSource] = await Promise.all([
  read("../app/api/improvement/v1/route.ts"),
  read("../db/schema.ts"),
  read("../drizzle/0014_left_rattler.sql"),
  read("../vite.config.ts"),
  read("../.gitignore"),
  read("../app/AgentConsole.tsx"),
]);

test("元改进 API 只暴露固定 dashboard 与六个管理动作", () => {
  assert.match(route, /export async function GET\(request: Request\)/u);
  assert.match(route, /url\.searchParams\.get\("view"\) !== "status"/u);
  assert.match(route, /export async function POST\(request: Request\)/u);
  for (const action of [
    "initialize_workspace",
    "test_provider",
    "create_experiment",
    "generate_candidates",
    "run_pairwise_evaluation",
    "decide_experiment",
  ]) {
    assert.match(route, new RegExp(`${action}:|action === "${action}"`, "u"));
  }
  assert.match(route, /Response\.json\(\{ ok: true, requestId: id, data \}/u);
  assert.match(route, /ok: false,[\s\S]*requestId: id,[\s\S]*error:/u);
});

test("所有读取与写入都复用本机管理会话、scope、同源和 CSRF 门禁", () => {
  assert.match(route, /requireManagementSession\(request, \{ scope: "management\.read" \}\)/u);
  assert.match(route, /requireManagementSession\(request, \{[\s\S]*mutation: true,[\s\S]*scope: ACTION_SCOPES\[action\]/u);
  assert.match(route, /test_provider: "admin\.diagnostics"/u);
  assert.match(route, /create_experiment: "task\.manage"/u);
  assert.match(route, /generate_candidates: "task\.manage"/u);
  assert.match(route, /run_pairwise_evaluation: "task\.manage"/u);
  assert.match(route, /decide_experiment: "rule\.adopt"/u);
  assert.doesNotMatch(route, /Access-Control-Allow-Origin/iu);
  assert.match(route, /const db = await requireImprovementSchemaReady\(\)/u);
  assert.match(route, /action === "initialize_workspace"[\s\S]*\? await ensureImprovementSchema\(\)[\s\S]*: await requireImprovementSchemaReady\(\)/u);
  assert.match(route, /IMPROVEMENT_NOT_INITIALIZED/u);
});

test("commandId、幂等回执与失败冻结合同保持显式", () => {
  assert.match(route, /COMMAND_ID_RE = \/\^\[A-Za-z0-9\._:-\]\{1,160\}\$\//u);
  assert.match(route, /CREATE TABLE IF NOT EXISTS command_receipts/u);
  assert.match(route, /COMMAND_ID_REUSED/u);
  assert.match(route, /COMMAND_IN_PROGRESS/u);
  assert.match(route, /status_code = 0/u);
  assert.match(route, /automaticRetry: false/u);
  assert.match(route, /model\.network_failure_frozen/u);
});

test("实验冻结基线、留出用例、provider、预算与评估合同", () => {
  assert.match(route, /BASELINE_STALE/u);
  assert.match(route, /cases\.length \* 2/u);
  assert.match(route, /cases\.length < 2 \|\| !cases\.some\(\(item\) => item\.holdout\)/u);
  for (const field of [
    "cases_sha256",
    "holdout_cases_sha256",
    "provider_policy_sha256",
    "budget_sha256",
    "evaluation_contract_sha256",
    "frozen_input_sha256",
  ]) {
    assert.match(route, new RegExp(field, "u"));
  }
  assert.match(route, /developmentCases: cases\.filter\(\(item\) => !item\.holdout\)/u);
  assert.match(route, /rowNullableText\(row, "candidate_version_id"\) !== null/u);
  assert.match(route, /row\.input_tokens === null \? reservedInput/u);
  assert.match(route, /row\.output_tokens === null \? reservedOutput/u);
  assert.match(route, /estimatedCostBudgetEnforced: false/u);
});

test("付费模型响应先 checkpoint，预算预留覆盖 UTF-8，持久化未知不伪报 provider 失败", () => {
  assert.match(route, /conservativeInputTokenReservation\(messages\)/u);
  assert.match(route, /CREATE TABLE IF NOT EXISTS model_invocation_outputs/u);
  assert.match(route, /checkpointModelInvocationOutput\(input\.db/u);
  assert.match(route, /MODEL_RESPONSE_PERSISTENCE_UNKNOWN/u);
  assert.match(route, /outcomeUnknown: true/u);
  assert.match(route, /markModelInvocationOutputMaterialized/u);
  assert.match(route, /EXPERIMENT_BUDGET_BREACHED/u);
});

test("v2 评测冻结不可改进的治理 harness，并以不透明 arm 执行真实 target prompt", () => {
  assert.match(route, /EVALUATION_PROTOCOL_VERSION = "wenmai\.meta-evaluation-protocol\/2\.0"/u);
  assert.match(route, /EXECUTION_SCHEMA_VERSION = "wenmai\.meta-execution\/2\.0"/u);
  assert.match(route, /BLIND_REVIEWER_KEY = "provider-neutral-blind-review\/v2"/u);
  assert.match(route, /META_IMPROVEMENT_GOVERNANCE_SEEDS/u);
  assert.match(route, /"meta\.governance-executor"/u);
  assert.match(route, /"meta\.governance-reviewer"/u);
  assert.match(route, /rowNumber\(row \?\? \{\}, "seed_count"\) !== 5/u);
  assert.match(route, /evaluationProtocolVersion: EVALUATION_PROTOCOL_VERSION/u);
  assert.match(route, /adapterVersion: MODEL_GATEWAY_ADAPTER_VERSION/u);
  assert.match(route, /sampling: \{ \.\.\.FROZEN_MODEL_SAMPLING \}/u);
  assert.match(route, /maxOutputTokens: \{ \.\.\.FROZEN_MAX_OUTPUT_TOKENS \}/u);
  assert.match(route, /failureEvidenceRefs: contract\.failureEvidenceRefs/u);
  assert.match(route, /\{ role: "system", content: rowText\(armVersion, "prompt_text"\) \}[\s\S]*\{ role: "system", content: governanceExecutorSystem \}/u);
  assert.match(route, /content: canonicalJson\(\{[\s\S]*armToken,[\s\S]*inputSha256: caseInputSha256,[\s\S]*caseInput:/u);
  assert.match(route, /value\.armToken !== expected\.armToken/u);
  assert.match(route, /promptVersionId: rowText\(governanceReviewer, "id"\)/u);
  assert.match(route, /sampling: input\.frozenInvocation\.sampling/u);
  assert.match(route, /targetPromptSha256: input\.targetPromptSha256/u);
  assert.match(route, /governancePromptSha256: input\.governancePromptSha256/u);
  assert.match(route, /opaqueBindingSha256: input\.opaqueBindingSha256/u);
});

test("每次付费 egress 都复核 pending 状态与冻结 baseline activation，并隔离 reject 后在途响应", () => {
  assert.match(route, /baselineActivation: \{[\s\S]*skillKey: targetSkillKey,[\s\S]*activeVersionId: rowText\(activeTarget, "id"\),[\s\S]*lockVersion: rowNumber\(activeTarget, "activation_lock_version"\)/u);
  assert.match(route, /async function assertFrozenBaselineActivation\(/u);
  assert.match(route, /"FROZEN_BASELINE_STALE"/u);
  assert.match(route, /async function paidEgressConflicts\(/u);
  assert.match(route, /rowText\(row, "state"\) !== input\.egressExpectation\.expectedState/u);
  assert.match(route, /rowText\(row, "decision"\) !== "pending"/u);
  assert.match(route, /rowText\(row, "guard_active_version_id"\) !== frozen\.activeVersionId/u);
  assert.match(route, /rowNumber\(row, "guard_activation_lock_version"\) !== frozen\.lockVersion/u);
  assert.match(route, /await assertPaidEgressAllowed\(input, "before_dispatch", inputSha256\)/u);
  assert.match(route, /await assertPaidEgressAllowed\(input, "after_checkpoint", inputSha256, invocationId\)/u);
  assert.match(route, /model\.response_ignored_after_experiment_change/u);
  assert.match(route, /responseCheckpointed: phase === "after_checkpoint"/u);
  assert.match(route, /blockModelInvocationOutput\(input\.db/u);
});

test("基线—候选双臂、独立 reviewer 与人工采纳 CAS 都是硬门禁", () => {
  assert.match(route, /for \(const arm of \["baseline", "candidate"\] as const\)/u);
  assert.match(route, /baselineVersionId: rowText\(row, "baseline_version_id"\)/u);
  assert.match(route, /candidateId,/u);
  assert.doesNotMatch(route, /candidateIds:/u);
  assert.match(route, /baselineResult: "pass"/u);
  assert.match(route, /candidateResult: "pass"/u);
  assert.match(route, /\? "candidate"[\s\S]*\? "baseline" : "inconclusive"/u);
  assert.match(route, /requiredSignals/u);
  assert.match(route, /forbiddenSignals/u);
  assert.match(route, /rowText\(review!, "provider"\) !== policy\.proposerProvider/u);
  assert.match(route, /rowText\(review!, "provider"\) !== policy\.executionProvider/u);
  assert.match(route, /evaluateMetaImprovementAdoptability\(/u);
  assert.match(route, /note\.length < 8/u);
  assert.match(route, /transitionMetaSkillActivation\(/u);
  assert.match(route, /ACTIVATION_CAS_CONFLICT/u);
  assert.match(route, /active_version_id = \? AND lock_version = \?/u);
});

test("人工采纳绑定服务端规范化证据包与活动版本 CAS", () => {
  assert.match(route, /HUMAN_EVIDENCE_SCHEMA_VERSION = "wenmai\.human-adoption-evidence\/1\.0"/u);
  assert.match(route, /async function humanAdoptionEvidenceBundle\(/u);
  assert.match(route, /artifactPreview: boundedArtifactPreview\(baselineArtifact\)/u);
  assert.match(route, /artifactSha256: await hashJson\(candidateArtifact\)/u);
  assert.match(route, /literalChecks: literalChecksForDashboard/u);
  assert.match(route, /findings: boundedEvidenceItems/u);
  assert.match(route, /criticalRisks: boundedEvidenceItems/u);
  assert.match(route, /evidenceRefs: boundedEvidenceItems/u);
  assert.match(route, /evidenceBundleSha256: await hashJson\(bundle\)/u);
  assert.match(route, /expectedCandidateSha256/u);
  assert.match(route, /expectedEvidenceBundleSha256/u);
  assert.match(route, /expectedActiveVersionId/u);
  assert.match(route, /expectedActivationLockVersion/u);
  assert.match(route, /HUMAN_EVIDENCE_STALE/u);
  assert.match(route, /item\.holdout && !evaluationComplete/u);
  assert.match(route, /humanEvidence: evaluationComplete \? humanEvidence : null/u);
});

test("领域状态经过显式 UI 映射，API 连通不会伪装成元改进", () => {
  for (const mapping of [
    ["candidate_ready", "candidate"],
    ["awaiting_human", "review"],
    ["failed", "failed"],
  ]) {
    assert.match(route, new RegExp(`state === "${mapping[0]}"\\) return "${mapping[1]}"`, "u"));
  }
  assert.match(route, /\["blocked", "cancelled"\]\.includes\(state\)\) return "blocked"/u);
  assert.match(route, /state === "completed" && decision === "adopt"\) return "adopted"/u);
  assert.match(route, /state === "completed" && decision === "rollback"\) return "rolled_back"/u);
  assert.match(route, /apiConnectionIsMetaImprovement: false/u);
  assert.match(route, /independentReviewRequired: true/u);
});

test("扩展 provider 默认由服务端 fail-closed 门禁拦截", () => {
  assert.match(route, /META_IMPROVEMENT_EXTENDED_PROVIDERS_ENABLED/u);
  assert.match(route, /META_IMPROVEMENT_EXTENDED_PROVIDER_DISABLED/u);
  assert.match(route, /assertMetaProviderEnabled\(proposerProvider\)/u);
  assert.match(route, /assertMetaProviderEnabled\(input\.provider\)/u);
});

test("六张元改进表与 0014 迁移保持纯新增", () => {
  const tableNames = [
    "meta_skill_versions",
    "meta_skill_activations",
    "meta_improvement_experiments",
    "model_invocations",
    "meta_improvement_evaluations",
    "meta_improvement_events",
  ];
  for (const tableName of tableNames) {
    assert.match(migration, new RegExp("CREATE TABLE `" + tableName + "`", "u"));
  }
  assert.doesNotMatch(migration, /\b(?:ALTER|DROP|DELETE|UPDATE|INSERT)\b/iu);
  assert.equal((migration.match(/CREATE TABLE/gu) ?? []).length, 6);
  assert.equal((migration.match(/CREATE (?:UNIQUE )?INDEX/gu) ?? []).length, 18);
  for (const exportName of [
    "metaSkillVersions",
    "metaSkillActivations",
    "metaImprovementExperiments",
    "modelInvocations",
    "metaImprovementEvaluations",
    "metaImprovementEvents",
  ]) {
    assert.match(schema, new RegExp(`export const ${exportName} = sqliteTable`, "u"));
  }
  assert.match(schema, /idx_meta_skill_activations_active_version/u);
  assert.match(schema, /idx_meta_skill_versions_active_key/u);
});

test("API key 仅注入本地 dev Worker，浏览器与构建产物合同不接收 key", () => {
  assert.match(vite, /const localModelBindings = command === "serve"/u);
  assert.match(vite, /process\.env\.DEEPSEEK_API_KEY/u);
  assert.match(vite, /process\.env\.DASHSCOPE_API_KEY/u);
  assert.doesNotMatch(vite, /QWEN_API_KEY/u);
  assert.match(gitignore, /^\.env\*$/mu);
  assert.match(gitignore, /^\/\.dev\.vars\*$/mu);
  assert.match(gitignore, /^\/\.backups\/$/mu);
  assert.match(consoleSource, /<MetaImprovementLab/u);
  assert.doesNotMatch(consoleSource, /DEEPSEEK_API_KEY|DASHSCOPE_API_KEY|QWEN_API_KEY/u);
});
  assert.match(route, /initialize_workspace: "rule\.adopt"/u);
