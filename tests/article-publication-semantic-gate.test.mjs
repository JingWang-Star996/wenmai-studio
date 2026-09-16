import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  ARTICLE_PUBLICATION_SEMANTIC_GATE_SCHEMA_VERSION,
  semanticGateReadState,
  semanticGateContractSha256,
  sha256Text,
  validatePlatformCanonicalContractBinding,
  validateArticlePublicationSemanticGate,
} from "../app/article-publication-semantic-gate.ts";
import {
  BILIBILI_ARTICLE_PLATFORM_TARGET,
  MAIMAI_PLATFORM_TARGET,
  XIAOHONGSHU_ARTICLE_PLATFORM_TARGET,
  ZHIHU_ARTICLE_PLATFORM_TARGET,
} from "../app/platform-target-contracts.ts";

const registrationRoute = readFileSync(new URL("../app/api/project-package/v1/route.ts", import.meta.url), "utf8");
const lifecycleRoute = readFileSync(new URL("../app/api/lifecycle/route.ts", import.meta.url), "utf8");

const primaryThesis = "平台适配应先保住读者可复述的正面主命题，再说明证据与责任边界。";
const body = `作者小林在编辑现场发现：读者先遇到的问题，是术语没有解释。\n\n本文把‘语义连续性’解释为平台正文保留作者入口、问题来源、首个术语解释与阅读路线。\n\n阅读路线：先看入口，再核对证据边界，最后判断责任边界。\n\n${primaryThesis}\n\n核心主张是适配不能只过格式。证据边界是仅以当前正文精确引文判断。责任边界是协调者记录冷读，不表示服务端认证身份。`;
const sha = await sha256Text(body);
const lead = [
  ["author_entry", "作者小林在编辑现场发现"], ["problem_origin", "读者先遇到的问题，是术语没有解释"],
  ["first_term_explanation", "本文把‘语义连续性’解释为平台正文保留作者入口、问题来源、首个术语解释与阅读路线"], ["reading_route", "阅读路线：先看入口，再核对证据边界，最后判断责任边界"],
];
const tail = [["core_proposition", "核心主张是适配不能只过格式"], ["evidence_boundary", "证据边界是仅以当前正文精确引文判断"], ["responsibility_boundary", "责任边界是协调者记录冷读，不表示服务端认证身份"]];
async function gate(overrides = {}) {
  const items = [...lead, ...tail].map(([id, evidenceQuote]) => ({ id, evidenceQuote, evidenceRef: `body:${id}`, region: lead.some(([leadId]) => leadId === id) ? "lead" : "body" }));
  const primaryThesisSha256 = await sha256Text(primaryThesis);
  return {
    schemaVersion: ARTICLE_PUBLICATION_SEMANTIC_GATE_SCHEMA_VERSION, bodySha256: sha, primaryThesis, primaryThesisSha256, primaryThesisEvidenceQuote: primaryThesis, primaryThesisRegion: "lead", contract: { items }, contractSha256: await semanticGateContractSha256(items, primaryThesis),
    independentReaderEvidence: { recordedBy: "coordinator_recorded", snapshotSha256: sha, reviewerId: "reader-1", reviewedAt: "2026-09-16T00:00:00.000Z", verdict: "pass", answers: Object.fromEntries([...lead.map(([id]) => [id, `读者回答 ${id}`]), ["primary_thesis", "读者能复述文章先保住正面主命题"], ["boundary_relation", "读者理解边界约束主命题而不能替代它"]]) },
    ...overrides,
  };
}

test("完整精确证据与通过的冷读回执可通过", async () => {
  const result = await validateArticlePublicationSemanticGate(await gate(), body, sha);
  assert.equal(result.valid, true, result.errors.join("\n"));
});

test("技术密集正文漏任何四项、正文外引文、hash stale 与 inconclusive 都失败关闭", async () => {
  const missing = await gate(); missing.contract.items = missing.contract.items.filter((item) => item.id !== "reading_route");
  assert.equal((await validateArticlePublicationSemanticGate(missing, body, sha)).valid, false);
  const absent = await gate(); absent.contract.items[0].evidenceQuote = "不在正文的引文"; absent.contractSha256 = await semanticGateContractSha256(absent.contract.items);
  assert.equal((await validateArticlePublicationSemanticGate(absent, body, sha)).valid, false);
  const stale = await gate({ bodySha256: "b".repeat(64) }); assert.equal((await validateArticlePublicationSemanticGate(stale, body, sha)).valid, false);
  const inconclusive = await gate(); inconclusive.independentReaderEvidence.verdict = "inconclusive"; assert.equal((await validateArticlePublicationSemanticGate(inconclusive, body, sha)).valid, false);
  const tokenOnly = await gate(); tokenOnly.contract.items[0].evidenceQuote = "作者小林"; tokenOnly.contractSha256 = await semanticGateContractSha256(tokenOnly.contract.items, primaryThesis);
  assert.match((await validateArticlePublicationSemanticGate(tokenOnly, body, sha)).errors.join("；"), /引文过短|evidenceQuote 过短/u);
  const trivialAnswer = await gate(); trivialAnswer.independentReaderEvidence.answers.author_entry = "知道了";
  assert.match((await validateArticlePublicationSemanticGate(trivialAnswer, body, sha)).errors.join("；"), /回答过短/u);
  const unchangedHashAfterBodyChange = await gate(); const changedBody = `${body}\n\n正文后来改动。`;
  assert.match((await validateArticlePublicationSemanticGate(unchangedHashAfterBodyChange, changedBody, sha)).errors.join("；"), /当前正文实算 SHA-256|snapshotSha256/u);
});

test("正面主命题与核心命题必须在 lead 中优先于边界，且冷读不能漏两项", async () => {
  const paddedBody = `${"填".repeat(801)}${body}`;
  assert.match((await validateArticlePublicationSemanticGate(await gate(), paddedBody, sha)).errors.join("；"), /primaryThesis.*前 800 字/u);
  const whitespaceThesis = await gate({ primaryThesis: ` ${primaryThesis}`, primaryThesisEvidenceQuote: ` ${primaryThesis}`, primaryThesisSha256: await sha256Text(` ${primaryThesis}`) });
  assert.match((await validateArticlePublicationSemanticGate(whitespaceThesis, body, sha)).errors.join("；"), /不得包含首尾空白/u);
  const boundaryFirstBody = body.replace("核心主张是适配不能只过格式。证据边界", "证据边界").replace("责任边界是协调者记录冷读，不表示服务端认证身份。", "责任边界是协调者记录冷读，不表示服务端认证身份。核心主张是适配不能只过格式。");
  assert.match((await validateArticlePublicationSemanticGate(await gate(), boundaryFirstBody, sha)).errors.join("；"), /边界不能替代主命题/u);
  const thesisAfterCoreBody = body.replace(`${primaryThesis}\n\n核心主张是适配不能只过格式。`, `核心主张是适配不能只过格式。\n\n${primaryThesis}`);
  assert.match((await validateArticlePublicationSemanticGate(await gate(), thesisAfterCoreBody, sha)).errors.join("；"), /primaryThesis 的正文位置不得晚于 core_proposition/u);
  const missingAnswers = await gate(); delete missingAnswers.independentReaderEvidence.answers.primary_thesis; delete missingAnswers.independentReaderEvidence.answers.boundary_relation;
  assert.match((await validateArticlePublicationSemanticGate(missingAnswers, body, sha)).errors.join("；"), /primary_thesis[\s\S]*boundary_relation/u);
});

test("历史缺 gate 或旧 schema 可读但不能用于新登记或构建", async () => {
  const result = await validateArticlePublicationSemanticGate(undefined, body, sha);
  assert.equal(result.state, "semantic_gate_missing"); assert.equal(result.valid, false);
  assert.equal(semanticGateReadState(undefined), "semantic_gate_missing");
  assert.equal(semanticGateReadState(await gate()), "unverified");
  const legacy = await gate({ schemaVersion: "wenmai.article-publication-semantic-gate/1.1.0" });
  assert.match((await validateArticlePublicationSemanticGate(legacy, body, sha)).errors.join("；"), /schemaVersion 无效/u);
  assert.equal(semanticGateReadState(legacy), "unverified");
});

test("platform 必须绑定 canonical contract 与 primary thesis hash，注册与建构路由均有实接线", async () => {
  const complete = await gate();
  assert.match(validatePlatformCanonicalContractBinding(complete, complete.contractSha256, complete.primaryThesisSha256).join("；"), /缺少 canonicalContractSha256/u);
  complete.canonicalContractSha256 = complete.contractSha256;
  assert.match(validatePlatformCanonicalContractBinding(complete, complete.contractSha256, complete.primaryThesisSha256).join("；"), /缺少 canonicalPrimaryThesisSha256/u);
  complete.canonicalPrimaryThesisSha256 = complete.primaryThesisSha256;
  assert.deepEqual(validatePlatformCanonicalContractBinding(complete, complete.contractSha256, complete.primaryThesisSha256), []);
  const platformB = await gate({ primaryThesis: "平台版 B 另有一条不同的正面主命题。", primaryThesisEvidenceQuote: "平台版 B 另有一条不同的正面主命题。", primaryThesisSha256: await sha256Text("平台版 B 另有一条不同的正面主命题。") });
  platformB.canonicalContractSha256 = complete.contractSha256;
  platformB.canonicalPrimaryThesisSha256 = complete.primaryThesisSha256;
  assert.match(validatePlatformCanonicalContractBinding(platformB, complete.contractSha256, complete.primaryThesisSha256).join("；"), /primaryThesisSha256 必须精确等于/u);
  assert.match(validatePlatformCanonicalContractBinding(complete, "b".repeat(64), complete.primaryThesisSha256).join("；"), /未精确绑定/u);
  assert.match(validatePlatformCanonicalContractBinding(complete, complete.contractSha256, "b".repeat(64)).join("；"), /primary thesis/u);
  assert.match(registrationRoute, /validateArticlePublicationSemanticGate\([\s\S]*?publicationVersion\.semanticGate/u);
  assert.match(registrationRoute, /validatePlatformCanonicalContractBinding\(publicationVersion\.semanticGate/u);
  assert.match(registrationRoute, /publicationVersionSemanticGate:[\s\S]*?requiredForNewRegistration: true[\s\S]*?revalidatedByCreateBuild: true/u);
  assert.match(lifecycleRoute, /validateArticlePublicationSemanticGate\([\s\S]*?publicationVersion\.semanticGate/u);
  assert.match(lifecycleRoute, /validatePlatformCanonicalContractBinding\([\s\S]*?publicationVersion\.semanticGate/u);
});

test("四个平台 Target 都把语义连续性列为独立必检项", () => {
  for (const target of [
    BILIBILI_ARTICLE_PLATFORM_TARGET,
    XIAOHONGSHU_ARTICLE_PLATFORM_TARGET,
    ZHIHU_ARTICLE_PLATFORM_TARGET,
    MAIMAI_PLATFORM_TARGET,
  ]) {
    assert.ok(target.profile.validationScope.includes("hash_bound_platform_semantic_continuity_gate"));
    assert.equal(target.profile.rules.semanticContinuity.enabled, true);
    assert.match(target.profile.rules.semanticContinuity.text, /技术、格式或字数检查通过不能替代/u);
  }
});
