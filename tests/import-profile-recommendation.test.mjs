import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  buildImportProfileMessages,
  buildImportWorkflowMetadata,
  fallbackImportProfileRecommendation,
  freezeImportProfileInput,
  parseImportProfileModelOutput,
  parseImportWorkflowMetadata,
} from "../app/import-profile.ts";

const sourceSha = "a".repeat(64);
const inputSha = "b".repeat(64);
const lightArchiveSmokeText = readFileSync(new URL("./light-archive-smoke.md", import.meta.url), "utf8");

function input(overrides = {}) {
  return {
    name: "未公开采访原文.md",
    format: "markdown",
    title: "一份内部采访素材",
    text: lightArchiveSmokeText,
    sourceSha256: sourceSha,
    bytes: 180,
    headings: 1,
    paragraphs: 3,
    packageSignals: null,
    ...overrides,
  };
}

function modelOutput(profile) {
  return {
    recommendedProfile: profile,
    confidence: profile === "light_archive" ? 0.81 : 0.74,
    reasons: [profile === "light_archive" ? "内容仍是原始采访素材。" : "内容具有完整结构与对外交付信号。"],
    missingSignals: profile === "light_archive" ? ["fact_verification"] : ["publication_artifacts"],
  };
}

test("冻结推荐输入绑定来源 SHA，并用固定 head-tail 上限处理长正文", () => {
  const longText = `# 标题\n\n${"正文".repeat(20_000)}`;
  const frozen = freezeImportProfileInput(input({ text: longText, bytes: 80_000, paragraphs: 20 }));
  assert.equal(frozen.source.sourceSha256, sourceSha);
  assert.equal(frozen.contentSample.strategy, "head_tail");
  assert.ok(frozen.contentSample.characters <= 24_040);
  assert.ok(frozen.contentSample.omittedCharacters > 0);
});

test("模型出网消息只含脱敏结构信号，不含正文、文件名、标题或 SHA", () => {
  const frozen = freezeImportProfileInput(input());
  const messages = buildImportProfileMessages(frozen);
  const userPayload = messages.find((message) => message.role === "user")?.content ?? "";
  assert.doesNotMatch(userPayload, /未公开采访原文/);
  assert.doesNotMatch(userPayload, /内部采访素材/);
  assert.doesNotMatch(userPayload, /未经事实核验/);
  assert.doesNotMatch(userPayload, new RegExp(sourceSha));
  const parsed = JSON.parse(userPayload);
  assert.equal(parsed.privacyBoundary.bodyIncluded, false);
  assert.equal(parsed.privacyBoundary.fileNameIncluded, false);
  assert.equal(parsed.privacyBoundary.titleIncluded, false);
  assert.equal(parsed.privacyBoundary.sourceShaIncluded, false);
});

test("严格解析轻量与完整两种 LLM 推荐，并拒绝额外字段或越界置信度", () => {
  for (const provider of ["deepseek", "qwen", "openai", "ollama"]) {
    const recommendation = parseImportProfileModelOutput(modelOutput("light_archive"), {
      inputSha256: inputSha,
      sourceSha256: sourceSha,
      provider,
      model: `${provider}-test-model`,
      egressTextCharacters: 0,
    });
    assert.equal(recommendation.recommendedProfile, "light_archive");
    assert.equal(recommendation.provider, provider);
    assert.equal(recommendation.source, "llm");
    assert.equal(recommendation.paidEgressPerformed, true);
    assert.equal(recommendation.automaticRetry, false);
  }
  assert.throws(() => parseImportProfileModelOutput({ ...modelOutput("light_archive"), autoApply: true }, {
    inputSha256: inputSha, sourceSha256: sourceSha, provider: "deepseek", model: "deepseek-v4-pro", egressTextCharacters: 0,
  }), /字段集合/);
  assert.throws(() => parseImportProfileModelOutput({ ...modelOutput("full_production"), confidence: 1.2 }, {
    inputSha256: inputSha, sourceSha256: sourceSha, provider: "deepseek", model: "deepseek-v4-pro", egressTextCharacters: 0,
  }), /confidence/);
});

test("模型不可用时规则回退不阻断，并保守区分原始素材与结构化工程包", () => {
  const lightFrozen = freezeImportProfileInput(input());
  const light = fallbackImportProfileRecommendation(lightFrozen, inputSha, "MODEL_REQUEST_TIMEOUT");
  assert.equal(light.recommendedProfile, "light_archive");
  assert.equal(light.source, "rules_fallback");
  assert.equal(light.paidEgressPerformed, false);

  const fullFrozen = freezeImportProfileInput(input({
    format: "wenmai",
    title: "准备发布的正式文章",
    text: `# 正式文章\n\n## 背景\n\n${"完整正文".repeat(700)}\n\n## 结语\n\n正文。\n\n## 参考资料\n\nhttps://example.com/source`,
    bytes: 4_000,
    headings: 4,
    paragraphs: 8,
    packageSignals: { modules: 8, sources: 3, assets: 1, hasWorkflowProfile: false },
  }));
  const full = fallbackImportProfileRecommendation(fullFrozen, inputSha, "MODEL_PROVIDER_NOT_CONFIGURED");
  assert.equal(full.recommendedProfile, "full_production");
});

test("人工选择与推荐分别留痕，轻量和完整都不得被写成发布完成", () => {
  const frozen = freezeImportProfileInput(input());
  const recommendation = fallbackImportProfileRecommendation(frozen, inputSha);
  const workflow = buildImportWorkflowMetadata({
    selectedProfile: "full_production",
    source: { name: input().name, format: "markdown", sourceSha256: sourceSha, bytes: 180 },
    recommendation,
  });
  assert.equal(workflow.selectedBy, "human");
  assert.equal(workflow.selectedProfile, "full_production");
  assert.equal(workflow.recommendation.recommendedProfile, "light_archive");
  assert.equal(workflow.workflowRecommendation.recipeId, "evidence-led-longform-v1");
  assert.equal(workflow.workflowRecommendation.recipeVersion, "1.4.0");
  assert.equal(workflow.workflowRecommendation.humanStartRequired, true);
  assert.equal(workflow.workflowRecommendation.coverCapabilityId, "skill:design-information-article-cover");
  assert.equal(workflow.completionBoundary.fullProductionRequested, true);
  assert.equal(workflow.completionBoundary.publishReady, false);
  assert.equal(workflow.completionBoundary.deliveryComplete, false);
  assert.equal(workflow.completionBoundary.publicReleaseVerified, false);
  assert.ok(workflow.plannedArtifacts.includes("fact_ledger"));
  assert.ok(workflow.plannedArtifacts.includes("cover_copy_contract"));
  assert.ok(workflow.plannedArtifacts.includes("cover_render_gate_report"));
  assert.ok(workflow.plannedArtifacts.includes("cover_human_decision"));
});

test("服务端规范化保留人工选择，并拒绝推荐或工作流错绑另一来源 SHA", () => {
  const frozen = freezeImportProfileInput(input());
  const recommendation = fallbackImportProfileRecommendation(frozen, inputSha);
  const workflow = buildImportWorkflowMetadata({
    selectedProfile: "light_archive",
    source: { name: input().name, format: "markdown", sourceSha256: sourceSha, bytes: 180 },
    recommendation,
  });
  const parsed = parseImportWorkflowMetadata(workflow, sourceSha);
  assert.equal(parsed.selectedProfile, "light_archive");
  assert.equal(parsed.workflowRecommendation.recipeId, null);
  assert.equal(parsed.workflowRecommendation.coverCapabilityId, null);
  assert.throws(() => parseImportWorkflowMetadata(workflow, "c".repeat(64)), /没有绑定当前导入源/);
});
