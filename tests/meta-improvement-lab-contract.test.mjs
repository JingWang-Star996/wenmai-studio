import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const componentUrl = new URL("../app/MetaImprovementLab.tsx", import.meta.url);
const source = await readFile(componentUrl, "utf8");

test("元改进实验室只通过同源 managementFetch 调用固定 API", () => {
  assert.match(source, /import \{ managementFetch \} from "\.\/management-fetch"/);
  assert.match(source, /managementFetch\(`\/api\/improvement\/v1\?\$\{query\.toString\(\)\}`/);
  assert.match(source, /managementFetch\("\/api\/improvement\/v1"/);
  assert.doesNotMatch(source, /https?:\/\/(?:api\.)?(?:deepseek|dashscope|aliyun)/i);
  assert.doesNotMatch(source, /\bfetch\s*\(/);
});

test("组件不提供或持久化模型密钥", () => {
  assert.doesNotMatch(source, /localStorage|sessionStorage|indexedDB/i);
  assert.doesNotMatch(source, /type=["']password["']/i);
  assert.doesNotMatch(source, /name=["'][^"']*(?:key|token|secret)[^"']*["']/i);
  assert.match(source, /浏览器不会要求、接收或保存模型密钥/);
});

test("UI 明确区分 API 连通和元改进，并硬显示 Qwen 互审阻塞", () => {
  assert.match(source, /API 接通不等于元改进/);
  assert.match(source, /状态未读取/);
  assert.match(source, /providerStateKnown && providerId === "qwen" && !configured/);
  assert.match(source, /Qwen 未配置：独立互审门槛未满足/);
  assert.match(source, /仍可由已配置的 proposer 生成候选、由 execution provider 做确定性评估/);
  assert.match(source, /selectedExperiment\.proposerProvider !== selectedExperiment\.reviewerProvider/);
  assert.match(source, /selectedExperiment\.executionProvider !== selectedExperiment\.reviewerProvider/);
  assert.match(source, /independentReviewPassed/);
  assert.match(source, /adopt 保持禁用/);
  assert.match(source, /"deepseek", "qwen", "openai", "ollama"/u);
  assert.match(source, /服务端未启用/u);
  assert.match(source, /disabled=\{providerStateKnown && providerById\.get\(id\)\?\.enabled === false\}/u);
});

test("写入 envelope、未知结果恢复与六个允许动作保持显式", () => {
  assert.match(source, /JSON\.stringify\(\{ action, commandId: currentCommandId, payload \}\)/);
  assert.match(source, /pendingCommandIdsRef/);
  assert.match(source, /A transport failure has an unknown server outcome/);
  assert.match(source, /user retry replays this authoritative id/);
  assert.match(source, /pendingCommandIdsRef\.current\.delete\(requestKey\)/);
  for (const action of [
    "initialize_workspace",
    "test_provider",
    "create_experiment",
    "generate_candidates",
    "run_pairwise_evaluation",
    "decide_experiment",
  ]) {
    assert.match(source, new RegExp(`"${action}"`));
  }
  assert.match(source, /decision: "adopt" \| "reject" \| "rollback"/);
  assert.match(source, /IMPROVEMENT_NOT_INITIALIZED/);
  assert.match(source, /元改进工作区已显式初始化；尚未生成候选或修改任何活动版本/);
  assert.match(source, /初始化元改进工作区/);
});

test("实验创建冻结 provider 角色、预算和留出评估用例", () => {
  for (const field of [
    "targetSkillKey",
    "executionProvider",
    "proposerProvider",
    "reviewerProvider",
    "budgetCalls",
    "evaluationCases",
    "requiredSignals",
    "forbiddenSignals",
    "holdout",
  ]) {
    assert.match(source, new RegExp(`\\b${field}\\b`));
  }
  assert.match(source, /基线 SHA-256/);
  assert.match(source, /evaluationCases\.length < 2/);
  assert.match(source, /minimumBudgetCalls = 2 \+ draft\.evaluationCases\.length \* 2/);
  assert.match(source, /至少一个 holdout 用例/);
  assert.match(source, /候选生成前冻结/);
});

test("目标只能从服务端清单选择并自动冻结只读基线", () => {
  for (const field of ["targets", "skillKey", "label", "activeVersion", "activeSha256"]) {
    assert.match(source, new RegExp(`\\b${field}\\b`));
  }
  assert.match(source, /<select value=\{draft\.targetSkillKey\}/);
  assert.match(source, /baselineVersion: target\.activeVersion/);
  assert.match(source, /baselineSha256: target\.activeSha256/);
  assert.match(source, /value=\{draft\.baselineVersion\} readOnly aria-readonly="true"/);
  assert.match(source, /value=\{draft\.baselineSha256\} readOnly aria-readonly="true"/);
});

test("成对评估比较冻结基线与单个候选", () => {
  assert.match(source, /baselineVersionId: string/);
  assert.match(source, /candidateId: string/);
  assert.match(source, /candidateId: selectedCandidateId/);
  assert.doesNotMatch(source, /candidateIds:/);
  assert.match(source, /运行基线—候选成对评估/);
});

test("reviewer 后配置可只补互审并复用既有双臂证据", () => {
  assert.match(source, /reviewerOnlyNeeded/);
  assert.match(source, /humanEvidence\.reviewer === null/);
  assert.match(source, /\{ reviewerOnly: true \}/);
  assert.match(source, /补做独立互审/);
  assert.match(source, /不会重跑 execution arms/);
});

test("生成和确定性评估不被独立审查配置阻断，只有 adopt 需要互审", () => {
  assert.match(source, /providerById\.get\(selectedExperiment\?\.proposerProvider \?\? "deepseek"\)\?\.configured === true/);
  assert.match(source, /providerById\.get\(selectedExperiment\?\.executionProvider \?\? "deepseek"\)\?\.configured === true/);
  assert.match(source, /const canAdopt = Boolean\(selectedExperiment\)\s*&& adoptionIndependentGate/);
  assert.match(source, /selectedExperiment\?\.candidates\.length === 0/);
  assert.match(source, /selectedExperiment\?\.state === "candidate"/);
  assert.match(source, /evaluation\.candidateId === selectedCandidateId/);
  assert.match(source, /evaluation\.outcome === "candidate"/);
  assert.match(source, /evaluation\.independentReviewPassed/);
});

test("人工 adopt 必须先展示并回传完整证据包绑定", () => {
  for (const field of [
    "artifactPreview",
    "artifactSha256",
    "evidenceSha256",
    "literalChecks",
    "findings",
    "criticalRisks",
    "evidenceRefs",
    "evidenceBundleSha256",
    "activeVersionId",
    "lockVersion",
  ]) {
    assert.match(source, new RegExp(`\\b${field}\\b`));
  }
  assert.match(source, /humanEvidence\?\.complete === true/);
  assert.match(source, /humanEvidenceMatchesSelection/);
  assert.match(source, /expectedCandidateSha256: humanEvidence\.candidate\.contentSha256/);
  assert.match(source, /expectedEvidenceBundleSha256: humanEvidence\.evidenceBundleSha256/);
  assert.match(source, /expectedActiveVersionId: humanEvidence\.activation\.activeVersionId/);
  assert.match(source, /expectedActivationLockVersion: humanEvidence\.activation\.lockVersion/);
  assert.match(source, /holdout 内容仍被遮蔽/);
  assert.match(source, /完整 evidence bundle SHA-256/);
});
