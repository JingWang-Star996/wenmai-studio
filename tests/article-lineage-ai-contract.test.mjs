import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  ARTICLE_LINEAGE_AI_MANIFEST,
  ARTICLE_LINEAGE_MODEL_ADAPTER_VERSION,
  ARTICLE_LINEAGE_REVIEW_0017_SQL,
  ARTICLE_LINEAGE_REVIEW_BUDGET_POLICY,
  ARTICLE_LINEAGE_REVIEW_RUNTIME_DDL,
  ArticleLineageModelContractError,
  buildArticleLineageReviewMessages,
  buildBoundedLineageDiffSummary,
  canonicalLineageJson,
  estimateArticleLineageReviewInputTokens,
  freezeArticleLineageReviewInput,
  parseArticleLineageReviewOutput,
  reserveArticleLineageReviewBudget,
  sha256LineageJson,
} from "../app/article-lineage-model.ts";
import {
  MODEL_GATEWAY_ADAPTER_VERSION,
  requestModelGatewayJson,
} from "../app/model-gateway.ts";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const SHA_C = "c".repeat(64);

function candidate(overrides = {}) {
  return {
    id: "lineage-candidate-rsi",
    status: "candidate",
    lockVersion: 3,
    inputSha256: SHA_A,
    proposedRelation: "same_root",
    sourceArticleId: "article-rsi-old",
    sourceRevisionId: "revision-rsi-old",
    sourceBodySha256: SHA_B,
    targetArticleId: "article-rsi-current",
    targetRevisionId: "revision-rsi-current",
    targetBodySha256: SHA_C,
    evidence: [{
      kind: "deterministic_similarity",
      score: 0.997,
      signals: { equalLines: 115, totalLines: 116, titleNormalized: true },
      ignoredFullBody: "不得进入冻结输入",
    }],
    ...overrides,
  };
}

function sourceRevision(overrides = {}) {
  return {
    articleId: "article-rsi-old",
    revisionId: "revision-rsi-old",
    bodySha256: SHA_B,
    title: "RSI 调研：旧标题",
    documentTitle: "RSI 调研：旧标题",
    bodyText: "# RSI 调研：旧标题\n\n共同正文\n共同结尾",
    ...overrides,
  };
}

function targetRevision(overrides = {}) {
  return {
    articleId: "article-rsi-current",
    revisionId: "revision-rsi-current",
    bodySha256: SHA_C,
    title: "RSI 火了：新标题",
    documentTitle: "RSI 火了：新标题",
    bodyText: "# RSI 火了：新标题\n\n共同正文\n共同结尾",
    ...overrides,
  };
}

function validOutput(overrides = {}) {
  return {
    relationRecommendation: "same_root",
    confidence: 0.96,
    reasons: ["正文结构和绝大多数行一致，只改动了首屏标题。"],
    differences: ["标题从调研描述改为面向发布的表达。"],
    risks: ["当前只提供有限差异摘要，仍需人工核对完整正文。"],
    nextStep: "human_confirm",
    ...overrides,
  };
}

test("manifest 把 DeepSeek 限定为 candidate-only，且适配器版本与真实 gateway 一致", () => {
  assert.equal(ARTICLE_LINEAGE_AI_MANIFEST.candidateOnly, true);
  assert.equal(ARTICLE_LINEAGE_AI_MANIFEST.mutatesArticleContent, false);
  assert.equal(ARTICLE_LINEAGE_AI_MANIFEST.mutatesIdentityDecision, false);
  assert.equal(ARTICLE_LINEAGE_AI_MANIFEST.automaticRetry, false);
  assert.deepEqual(ARTICLE_LINEAGE_AI_MANIFEST.allowedActions, ["prepare_review", "run_review"]);
  assert.deepEqual(ARTICLE_LINEAGE_AI_MANIFEST.allowedOutputFields, [
    "relationRecommendation", "confidence", "reasons", "differences", "risks", "nextStep",
  ]);
  assert.equal(ARTICLE_LINEAGE_MODEL_ADAPTER_VERSION, MODEL_GATEWAY_ADAPTER_VERSION);
});

test("prepare 只冻结 revision 摘要、SHA、相似信号和有界差异，不带全文或原始 evidence", async () => {
  const frozen = freezeArticleLineageReviewInput({
    candidate: candidate(),
    source: sourceRevision(),
    target: targetRevision(),
  });
  assert.equal(frozen.candidate.id, "lineage-candidate-rsi");
  assert.equal(frozen.source.bodySha256, SHA_B);
  assert.equal(frozen.target.bodySha256, SHA_C);
  assert.equal(frozen.similaritySignals.score, 0.997);
  assert.equal(frozen.similaritySignals.equalLines, 115);
  assert.equal("bodyText" in frozen.source, false);
  assert.doesNotMatch(canonicalLineageJson(frozen), /ignoredFullBody|不得进入冻结输入/u);
  assert.match(canonicalLineageJson(frozen.diffSummary), /旧标题/u);
  assert.match(canonicalLineageJson(frozen.diffSummary), /新标题/u);
  assert.equal((await sha256LineageJson(frozen)).length, 64);
  assert.ok(estimateArticleLineageReviewInputTokens(frozen) > 128);
});

test("revision/article/SHA 绑定漂移会在 prepare 阶段失败", () => {
  assert.throws(() => freezeArticleLineageReviewInput({
    candidate: candidate(),
    source: sourceRevision({ articleId: "wrong-owner" }),
    target: targetRevision(),
  }), (error) => error instanceof ArticleLineageModelContractError
    && error.code === "LINEAGE_REVIEW_REVISION_BINDING_CHANGED");
});

test("差异摘要固定限制 excerpt 数量与每行长度", () => {
  const longLines = Array.from({ length: 50 }, (_, index) => `${index}-${"字".repeat(600)}`);
  const summary = buildBoundedLineageDiffSummary(longLines.join("\n"), [...longLines].reverse().join("\n"));
  assert.ok(summary.sourceExcerpt.length <= 6);
  assert.ok(summary.targetExcerpt.length <= 6);
  assert.ok(summary.sourceExcerpt.every((line) => line.length <= 170));
  assert.equal(summary.excerptsTruncated, true);
  assert.ok(new TextEncoder().encode(canonicalLineageJson(summary)).byteLength < 8_192);
});

test("模型输出严格只接受六个字段、枚举、范围和有界数组", () => {
  assert.deepEqual(parseArticleLineageReviewOutput(validOutput()), validOutput());
  assert.throws(() => parseArticleLineageReviewOutput({ ...validOutput(), decision: "confirm" }),
    /严格 JSON Schema/u);
  assert.throws(() => parseArticleLineageReviewOutput(validOutput({ confidence: 1.1 })),
    /枚举或置信度/u);
  assert.throws(() => parseArticleLineageReviewOutput(validOutput({ reasons: [] })),
    /至少需要一项/u);
  assert.throws(() => parseArticleLineageReviewOutput(validOutput({ nextStep: "auto_apply" })),
    /枚举或置信度/u);
});

test("显式 token/费用预算在出网前按保守上限完整预留", () => {
  const reservation = reserveArticleLineageReviewBudget({
    estimatedInputTokens: 500,
    maxInputTokens: 600,
    maxOutputTokens: 128,
    maxCostCnyMicros: 1_112_000,
  });
  assert.equal(reservation.reservedCostCnyMicros, 1_112_000);
  assert.equal(reservation.actualProviderCostKnown, false);
  assert.equal(reservation.automaticRetry, false);
  assert.throws(() => reserveArticleLineageReviewBudget({
    estimatedInputTokens: 601,
    maxInputTokens: 600,
    maxOutputTokens: 128,
    maxCostCnyMicros: 2_000_000,
  }), /maxInputTokens/u);
  assert.throws(() => reserveArticleLineageReviewBudget({
    estimatedInputTokens: 500,
    maxInputTokens: 600,
    maxOutputTokens: 128,
    maxCostCnyMicros: 1_111_999,
  }), /maxCostCnyMicros/u);
  assert.equal(ARTICLE_LINEAGE_REVIEW_BUDGET_POLICY.maximumCostCnyMicros, 100_000_000);
});

test("假 DeepSeek provider 走固定 gateway、JSON object 模式并通过严格输出解析", async () => {
  const frozen = freezeArticleLineageReviewInput({
    candidate: candidate(),
    source: sourceRevision(),
    target: targetRevision(),
  });
  let dispatched = 0;
  const result = await requestModelGatewayJson({
    provider: "deepseek",
    env: { DEEPSEEK_API_KEY: "fake-contract-key", DEEPSEEK_MODEL: "deepseek-contract" },
    messages: buildArticleLineageReviewMessages(frozen),
    maxOutputTokens: 512,
    sampling: { temperature: 0, topP: 1 },
    fetchImpl: async (url, init) => {
      dispatched += 1;
      assert.equal(String(url), "https://api.deepseek.com/chat/completions");
      assert.equal(init?.redirect, "manual");
      const body = JSON.parse(String(init?.body));
      assert.equal(body.response_format.type, "json_object");
      assert.equal(body.stream, false);
      assert.equal(body.max_tokens, 512);
      assert.equal(body.temperature, 0);
      return new Response(JSON.stringify({
        id: "fake-lineage-review",
        choices: [{
          index: 0,
          finish_reason: "stop",
          message: { role: "assistant", content: JSON.stringify(validOutput()) },
        }],
        usage: { prompt_tokens: 240, completion_tokens: 88, total_tokens: 328 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  assert.equal(dispatched, 1);
  assert.deepEqual(parseArticleLineageReviewOutput(result.value), validOutput());
  assert.deepEqual(result.usage, { inputTokens: 240, outputTokens: 88, totalTokens: 328 });
});

test("0017 合同专门扩展 lineage_review，不借用 meta_experiment 伪装", () => {
  const sql = ARTICLE_LINEAGE_REVIEW_0017_SQL.join("\n");
  assert.match(sql, /ALTER TABLE model_invocations RENAME TO model_invocations_pre_0017/u);
  assert.match(sql, /purpose IN \('provider_probe','meta_experiment','lineage_review'\)/u);
  assert.match(sql, /lineage_candidate_id TEXT/u);
  assert.match(sql, /lineage_preparation_id TEXT/u);
  assert.match(sql, /purpose='lineage_review' AND role='reviewer' AND provider='deepseek'/u);
  assert.match(sql, /INSERT INTO model_invocations[\s\S]*FROM model_invocations_pre_0017/u);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS article_lineage_review_preparations/u);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS article_lineage_model_reviews/u);
  assert.match(ARTICLE_LINEAGE_REVIEW_RUNTIME_DDL.join("\n"), /candidate_only INTEGER NOT NULL DEFAULT 1 CHECK\(candidate_only=1\)/u);
});

test("正式 0017 migration 在后继 journal 链中仍与 Drizzle schema、runtime bootstrap 保持同一血缘合同", async () => {
  const [migration, schema, improvementRoute, lineageRoute, journalText] = await Promise.all([
    readFile(new URL("../drizzle/0017_amazing_annihilus.sql", import.meta.url), "utf8"),
    readFile(new URL("../db/schema.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/improvement/v1/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/article-lineage-ai/v1/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/meta/_journal.json", import.meta.url), "utf8"),
  ]);
  const journal = JSON.parse(journalText);
  const entry0017 = journal.entries.find((entry) => entry.tag === "0017_amazing_annihilus");
  assert.equal(entry0017?.idx, 17);
  assert.equal(journal.entries[entry0017.idx + 1]?.tag, "0018_publication_build_binding");
  assert.equal(journal.entries.at(-1)?.tag, "0028_release_control_v2_dom_binding");
  assert.equal(journal.entries.at(-1)?.idx, 28);
  assert.deepEqual(journal.entries.map((entry) => entry.idx), Array.from({ length: 29 }, (_unused, idx) => idx));
  assert.ok(entry0017.idx < journal.entries.at(-1).idx);

  assert.match(migration, /CREATE TABLE `article_lineage_review_preparations`/u);
  assert.match(migration, /CREATE TABLE `article_lineage_model_reviews`/u);
  assert.match(migration, /'provider_probe','meta_experiment','lineage_review'/u);
  assert.match(migration, /SELECT "id", "experiment_id", NULL, NULL, "command_id"/u);
  assert.match(migration, /idx_model_invocations_lineage_candidate/u);

  assert.match(schema, /export const articleLineageReviewPreparations = sqliteTable/u);
  assert.match(schema, /export const articleLineageModelReviews = sqliteTable/u);
  assert.match(schema, /lineageCandidateId: text\("lineage_candidate_id"\)/u);
  assert.match(schema, /lineagePreparationId: text\("lineage_preparation_id"\)/u);
  assert.match(schema, /purpose: text\("purpose", \{ enum: \["provider_probe", "meta_experiment", "lineage_review"\] \}\)/u);

  assert.match(improvementRoute, /lineage_candidate_id TEXT/u);
  assert.match(improvementRoute, /lineage_preparation_id TEXT/u);
  assert.match(improvementRoute, /idx_model_invocations_lineage_candidate/u);
  assert.match(lineageRoute, /requiredMigration: "0017_amazing_annihilus"/u);
  assert.match(lineageRoute, /schemaState: invocationSchemaReady \? "ready" : "upgrade_required"/u);
  assert.match(lineageRoute, /runReviewAvailable: invocationSchemaReady && provider\.ready/u);
});

test("route 使用管理鉴权、command receipt、双重 CAS 和先 checkpoint 后物化", async () => {
  const route = await readFile(new URL("../app/api/article-lineage-ai/v1/route.ts", import.meta.url), "utf8");
  assert.match(route, /requireManagementSession\(request, \{ scope: "management\.read" \}\)/u);
  assert.match(route, /requireManagementSession\(request, \{ mutation: true, scope: "identity\.decide" \}\)/u);
  assert.match(route, /article_lineage_ai\.v1\.\$\{action\}/u);
  assert.match(route, /payload\.candidateId/u);
  assert.match(route, /payload\.expectedCandidateLockVersion/u);
  assert.match(route, /payload\.inputSha/u);
  assert.match(route, /payload\.maxInputTokens/u);
  assert.match(route, /payload\.maxOutputTokens/u);
  assert.match(route, /payload\.maxCostCnyMicros/u);
  assert.match(route, /LINEAGE_REVIEW_SCHEMA_UPGRADE_REQUIRED/u);
  assert.match(route, /purpose, role, provider[\s\S]*'lineage_review', 'reviewer', 'deepseek'/u);
  assert.doesNotMatch(route, /'meta_experiment'[\s\S]{0,100}'reviewer'/u);
  const checkpoint = route.indexOf("// Paid provider output is durable");
  const strictParse = route.indexOf("output = parseArticleLineageReviewOutput", checkpoint);
  const materialize = route.indexOf("INSERT INTO article_lineage_model_reviews", checkpoint);
  assert.ok(checkpoint > 0 && strictParse > checkpoint && materialize > strictParse);
  assert.doesNotMatch(route, /UPDATE article_lineage_links/u);
  assert.doesNotMatch(route, /UPDATE article_revisions/u);
  assert.doesNotMatch(route, /UPDATE article_branches/u);
  assert.doesNotMatch(route, /UPDATE article_project_packages/u);
});
