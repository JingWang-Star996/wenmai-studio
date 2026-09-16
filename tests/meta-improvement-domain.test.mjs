import assert from "node:assert/strict";
import test from "node:test";

import {
  META_EXECUTION_SEED_PROMPT,
  META_GOVERNANCE_EXECUTOR_SEED_PROMPT,
  META_GOVERNANCE_REVIEWER_SEED_PROMPT,
  META_PROPOSER_SEED_PROMPT,
  META_REVIEWER_SEED_PROMPT,
  evaluateMetaImprovementAdoptability,
  scoreMetaImprovementSignals,
  transitionMetaSkillActivation,
  validateMetaExperimentBudget,
  validateMetaProviderPolicy,
} from "../app/meta-improvement.ts";

const sha = (character) => character.repeat(64);

function experimentSnapshot() {
  return {
    id: "experiment-1",
    state: "awaiting_human",
    decision: "pending",
    lockVersion: 4,
    baselineVersionId: "version-baseline",
    baselineContentSha256: sha("a"),
    candidateVersionId: "version-candidate",
    casesSha256: sha("b"),
    holdoutCasesSha256: sha("c"),
    providerPolicySha256: sha("d"),
    budgetSha256: sha("e"),
    evaluationContractSha256: sha("f"),
    frozenInputSha256: sha("1"),
  };
}

function cas(snapshot) {
  return {
    experimentId: snapshot.id,
    expectedState: snapshot.state,
    expectedLockVersion: snapshot.lockVersion,
    expectedCandidateVersionId: snapshot.candidateVersionId,
    baselineVersionId: snapshot.baselineVersionId,
    baselineContentSha256: snapshot.baselineContentSha256,
    casesSha256: snapshot.casesSha256,
    holdoutCasesSha256: snapshot.holdoutCasesSha256,
    providerPolicySha256: snapshot.providerPolicySha256,
    budgetSha256: snapshot.budgetSha256,
    evaluationContractSha256: snapshot.evaluationContractSha256,
    frozenInputSha256: snapshot.frozenInputSha256,
  };
}

test("元改进种子 Prompt 明确候选、人审和外部副作用边界", () => {
  assert.match(META_PROPOSER_SEED_PROMPT, /candidateOnly/);
  assert.match(META_PROPOSER_SEED_PROMPT, /不得.*采用/u);
  assert.match(META_EXECUTION_SEED_PROMPT, /externalSideEffects=false/);
  assert.match(META_REVIEWER_SEED_PROMPT, /advisoryOnly/);
  assert.match(META_REVIEWER_SEED_PROMPT, /不得输出 adopt/);
  assert.match(META_GOVERNANCE_EXECUTOR_SEED_PROMPT, /不可作为改进目标/u);
  assert.match(META_GOVERNANCE_EXECUTOR_SEED_PROMPT, /不得.*模拟/u);
  assert.match(META_GOVERNANCE_REVIEWER_SEED_PROMPT, /即使被测目标本身是 reviewer/u);
  assert.match(META_GOVERNANCE_REVIEWER_SEED_PROMPT, /不得输出 adopt/u);
});

test("provider 与预算合同拒绝同一 provider 互审以外的无效输入", () => {
  const validPolicy = {
    proposerProvider: "deepseek",
    proposerModelId: "deepseek-v4-pro",
    executionProvider: "deepseek",
    executionModelId: "deepseek-v4-pro",
    reviewerProvider: "qwen",
    reviewerModelId: "qwen3.7-plus",
    adapterVersion: "chat-completions-json/1",
  };
  assert.deepEqual(validateMetaProviderPolicy(validPolicy), []);
  assert.deepEqual(validateMetaProviderPolicy({
    ...validPolicy,
    proposerProvider: "openai",
    proposerModelId: "gpt-5.6-luna",
    executionProvider: "ollama",
    executionModelId: "qwen-local",
    reviewerProvider: "deepseek",
    reviewerModelId: "deepseek-v4-pro",
  }), []);
  assert.ok(validateMetaProviderPolicy({ ...validPolicy, reviewerModelId: "" }).includes("REVIEWER_MODEL_REQUIRED"));

  const now = new Date("2026-08-18T12:00:00.000Z");
  const budget = {
    maxInvocations: 8,
    maxInputTokens: 20_000,
    maxOutputTokens: 8_000,
    maxEstimatedCostCny: 20,
    maxCandidates: 1,
    maxRetriesPerInvocation: 0,
    deadlineAt: "2026-08-19T12:00:00.000Z",
  };
  assert.deepEqual(validateMetaExperimentBudget(budget, now), []);
  assert.ok(validateMetaExperimentBudget({ ...budget, maxRetriesPerInvocation: -1 }, now).includes("MAX_RETRIES_INVALID"));
});

test("adoptability 同时要求成对确定性证据、独立 reviewer、人类说明与无回归信号", () => {
  const experiment = experimentSnapshot();
  const signalScore = scoreMetaImprovementSignals([
    {
      id: "required-coverage",
      label: "必需信号覆盖",
      baseline: 0.5,
      candidate: 1,
      direction: "higher_is_better",
      weight: 2,
      minimumDelta: 0.1,
      maximumRegression: 0,
      critical: true,
    },
    {
      id: "forbidden-count",
      label: "禁止信号命中",
      baseline: 1,
      candidate: 0,
      direction: "lower_is_better",
      weight: 1,
      minimumDelta: 0,
      maximumRegression: 0,
      critical: true,
    },
  ]);
  const baseInput = {
    experiment,
    cas: cas(experiment),
    candidate: {
      id: "version-candidate",
      parentVersionId: "version-baseline",
      isCandidate: true,
      contentSha256: sha("2"),
    },
    providerPolicy: {
      proposerProvider: "deepseek",
      proposerModelId: "deepseek-v4-pro",
      executionProvider: "deepseek",
      executionModelId: "deepseek-v4-pro",
      reviewerProvider: "qwen",
      reviewerModelId: "qwen3.7-plus",
      adapterVersion: "chat-completions-json/1",
    },
    deterministicPairs: [{
      pairId: "pair-1",
      caseId: "case-1",
      contractSha256: experiment.evaluationContractSha256,
      baselineResult: "pass",
      baselineEvidenceSha256: sha("3"),
      candidateResult: "pass",
      candidateEvidenceSha256: sha("4"),
    }],
    reviewerEvaluation: {
      provider: "qwen",
      result: "pass",
      evidenceSha256: sha("5"),
      invocationId: "invocation-reviewer",
    },
    humanDecision: { actorId: "management:user", note: "冻结证据和留出用例均支持采用" },
    signalScore,
    minimumWeightedScore: 0.01,
  };

  const accepted = evaluateMetaImprovementAdoptability(baseInput);
  assert.equal(accepted.adoptable, true);
  assert.deepEqual(accepted.reasons, []);

  const sameProvider = evaluateMetaImprovementAdoptability({
    ...baseInput,
    reviewerEvaluation: { ...baseInput.reviewerEvaluation, provider: "deepseek" },
  });
  assert.equal(sameProvider.adoptable, false);
  assert.ok(sameProvider.reasons.includes("REVIEWER_PROVIDER_NOT_INDEPENDENT"));

  const noHuman = evaluateMetaImprovementAdoptability({ ...baseInput, humanDecision: null });
  assert.equal(noHuman.adoptable, false);
  assert.ok(noHuman.reasons.includes("HUMAN_REVIEWER_MISSING"));

  const unchangedFailure = evaluateMetaImprovementAdoptability({
    ...baseInput,
    signalScore: scoreMetaImprovementSignals([{
      id: "unchanged-failure",
      label: "基线与候选同样未通过",
      baseline: 0,
      candidate: 0,
      direction: "higher_is_better",
      weight: 1,
      minimumDelta: 0,
      maximumRegression: 0,
      critical: true,
    }]),
    minimumWeightedScore: 0,
  });
  assert.equal(unchangedFailure.adoptable, false);
  assert.ok(unchangedFailure.reasons.includes("SIGNAL_THRESHOLD_NOT_MET"));

  const compensatedRegression = evaluateMetaImprovementAdoptability({
    ...baseInput,
    signalScore: scoreMetaImprovementSignals([
      {
        id: "visible-regression",
        label: "可见用例发生回归",
        baseline: 1,
        candidate: 0,
        direction: "higher_is_better",
        weight: 1,
        minimumDelta: 0,
        maximumRegression: 0,
      },
      {
        id: "holdout-improvement",
        label: "留出用例改善",
        baseline: 0,
        candidate: 1,
        direction: "higher_is_better",
        weight: 2,
        minimumDelta: 0,
        maximumRegression: 0,
        critical: true,
      },
    ]),
    minimumWeightedScore: 0,
  });
  assert.equal(compensatedRegression.adoptable, false);
  assert.ok(compensatedRegression.reasons.includes("SIGNAL_THRESHOLD_NOT_MET"));
});

test("活动版本指针采用和回滚都使用 CAS，陈旧锁失败", () => {
  const snapshot = {
    skillKey: "meta.execution",
    activeVersionId: "version-baseline",
    lockVersion: 2,
    updatedAt: "2026-08-18T12:00:00.000Z",
    decisionExperimentId: "system-seed",
  };
  const expectation = {
    skillKey: "meta.execution",
    expectedActiveVersionId: "version-baseline",
    expectedLockVersion: 2,
  };
  const result = transitionMetaSkillActivation(snapshot, expectation, {
    decision: "adopt",
    targetVersion: { id: "version-candidate", skillKey: "meta.execution", status: "candidate" },
    experimentId: "experiment-1",
    humanActorId: "management:user",
    humanNote: "采用前已复核留出用例与独立互审证据",
    updatedAt: "2026-08-18T13:00:00.000Z",
    adoptability: { adoptable: true, reasons: [], checks: {} },
  });
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.next.activeVersionId, "version-candidate");
  assert.equal(result.ok && result.next.lockVersion, 3);

  const stale = transitionMetaSkillActivation(snapshot, { ...expectation, expectedLockVersion: 1 }, {
    decision: "rollback",
    targetVersion: { id: "version-old", skillKey: "meta.execution", status: "superseded" },
    experimentId: "experiment-1",
    humanActorId: "management:user",
    humanNote: "真实回归证据触发人工回滚到上一版本",
    updatedAt: "2026-08-18T14:00:00.000Z",
  });
  assert.equal(stale.ok, false);
  assert.ok(!stale.ok && stale.conflicts.includes("ACTIVATION_LOCK_CHANGED"));
});
