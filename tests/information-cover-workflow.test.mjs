import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { FACTORY_RECIPES } from "../app/factory-recipes.ts";
import {
  INFORMATION_COVER_BASELINE_ID,
  INFORMATION_COVER_CAPABILITY_ID,
  INFORMATION_COVER_EVIDENCE_RECEIPT_SCHEMA_VERSION,
  INFORMATION_COVER_PROFILE,
  INFORMATION_COVER_PROFILE_SHA256,
  INFORMATION_COVER_PROFILE_SCHEMA_VERSION,
  INFORMATION_COVER_RECIPE_STEP_IDS,
  INFORMATION_COVER_RECIPE_STEPS,
  INFORMATION_COVER_REQUIRED_ARTIFACTS,
  INFORMATION_COVER_RULE_IDS,
  LEGACY_INFORMATION_COVER_BASELINE_IDS,
  canonicalInformationCoverProfileJson,
  computeInformationCoverProfileSha256,
  informationCoverBaselineCompatibility,
  informationCoverPackageReady,
  isCurrentInformationCoverBaseline,
  normalizeInformationCoverEvidenceReceipt,
  validateInformationCoverEvidenceReceipt,
} from "../app/information-cover-workflow.ts";

const workflowSource = await readFile(new URL("../app/information-cover-workflow.ts", import.meta.url), "utf8");
const recipeSource = await readFile(new URL("../app/factory-recipes.ts", import.meta.url), "utf8");
const importSource = await readFile(new URL("../app/import-profile.ts", import.meta.url), "utf8");
const editorSource = await readFile(new URL("../app/ArticleProjectEditor.tsx", import.meta.url), "utf8");
const workspaceSource = await readFile(new URL("../app/api/workspace/route.ts", import.meta.url), "utf8");
const workbenchSource = await readFile(new URL("../app/WorkbenchShell.tsx", import.meta.url), "utf8");

const BODY_SHA256 = "a".repeat(64);
const BASELINE_SHA256 = "b".repeat(64);
const ARTIFACT_SHA256 = "c".repeat(64);

function makeReceipt(stepId = "cover-human-acceptance") {
  return {
    schemaVersion: INFORMATION_COVER_EVIDENCE_RECEIPT_SCHEMA_VERSION,
    receiptId: `receipt-${stepId}`,
    issuedAt: "2026-08-21T09:00:00+08:00",
    capabilityId: INFORMATION_COVER_CAPABILITY_ID,
    profileSchemaVersion: INFORMATION_COVER_PROFILE_SCHEMA_VERSION,
    stepId,
    ruleIds: [...INFORMATION_COVER_RULE_IDS],
    baseline: { id: INFORMATION_COVER_BASELINE_ID, sha256: BASELINE_SHA256, status: "current" },
    bindings: {
      articleBodySha256: BODY_SHA256,
      inputSha256: "d".repeat(64),
      baselineSha256: BASELINE_SHA256,
      artifactSha256: ARTIFACT_SHA256,
    },
    state: {
      designMode: "redesign",
      baselineStatus: "current",
      changeControlStatus: "approved",
      artifactState: "artifact_delivered",
      stale: false,
    },
    semantic: {
      typeSignal: "行业事件复盘",
      subtitle: "阿里出售灵犀之后，游戏业务怎样重排",
      coreQuote: "出售不是句号，而是组织选择的显影剂",
    },
    seriesContext: {
      isSeries: true,
      motherEvent: "阿里出售灵犀互娱",
      seriesAnchor: "大厂收缩后的游戏业务重排",
    },
    composition: {
      textAxis: "center",
      backgroundMode: "artistic_scenic_montage",
      montageElements: ["ali", "lingxi", "game-logo"],
    },
    assetRights: [
      { assetId: "ali", sourceRef: "asset://ali-shape", rightsBasis: "original abstraction", reuseStatus: "original", evidenceRef: "rights://ali", publicVisibilityOnly: false },
      { assetId: "lingxi", sourceRef: "asset://lingxi-wordmark", rightsBasis: "licensed press asset", reuseStatus: "licensed", evidenceRef: "rights://lingxi", publicVisibilityOnly: false },
      { assetId: "game-logo", sourceRef: "asset://game-logo", rightsBasis: "permission record", reuseStatus: "permission_granted", evidenceRef: "rights://game-logo", publicVisibilityOnly: false },
    ],
    thumbnails: [
      { widthPx: 120, sha256: "e".repeat(64), artifactSha256: ARTIFACT_SHA256 },
      { widthPx: 220, sha256: "f".repeat(64), artifactSha256: ARTIFACT_SHA256 },
    ],
    artifact: { kind: "cover_png", uri: "artifact://cover.png", sha256: ARTIFACT_SHA256, delivered: true },
    approval: { status: "approved", approvedBy: "content-owner", approvedAt: "2026-08-21T09:10:00+08:00", artifactSha256: ARTIFACT_SHA256 },
  };
}

test("文脉信息型封面 profile 绑定唯一 Skill 所有者与用户新增视觉合同", () => {
  assert.equal(INFORMATION_COVER_CAPABILITY_ID, "skill:design-information-article-cover");
  assert.equal(INFORMATION_COVER_BASELINE_ID, "information-knowledge-cover-v2");
  assert.equal(INFORMATION_COVER_PROFILE.schemaVersion, "wenmai.information-cover-profile/2.0.0");
  assert.equal(INFORMATION_COVER_PROFILE.baselineId, INFORMATION_COVER_BASELINE_ID);
  assert.deepEqual(INFORMATION_COVER_PROFILE.ruleIds, INFORMATION_COVER_RULE_IDS);
  assert.equal(INFORMATION_COVER_PROFILE.copyContract.independentExpressionRequired, true);
  assert.equal(INFORMATION_COVER_PROFILE.copyContract.visibleThemeCategoryRequired, true);
  assert.deepEqual(INFORMATION_COVER_PROFILE.copyContract.visibleCopyRoles, ["main_title", "subtitle", "core_quote"]);
  assert.equal(INFORMATION_COVER_PROFILE.copyContract.subtitleAndCoreQuoteMustBeSeparate, true);
  assert.equal(INFORMATION_COVER_PROFILE.seriesContract.motherEventAnchorRequired, true);
  assert.equal(INFORMATION_COVER_PROFILE.seriesContract.seriesAnchorRequired, true);
  assert.equal(INFORMATION_COVER_PROFILE.compositionContract.textAxis, "center");
  assert.equal(INFORMATION_COVER_PROFILE.compositionContract.backgroundMode, "artistic_scenic");
  assert.equal(INFORMATION_COVER_PROFILE.compositionContract.montageMode, "artistic_scenic_montage");
  assert.equal(INFORMATION_COVER_PROFILE.compositionContract.eventElementCollage.requiredWhenArticleHasKeyEvent, true);
  assert.equal(INFORMATION_COVER_PROFILE.rightsContract.publicVisibilityDoesNotGrantReuseRights, true);
  assert.match(workflowSource, /skill:design-information-article-cover/);
  assert.match(workflowSource, /independentExpressionRequired: true/);
  assert.match(workflowSource, /visibleThemeCategoryRequired: true/);
  assert.match(workflowSource, /type_signal/);
  assert.match(workflowSource, /subtitleAndCoreQuoteMustBeSeparate/);
  assert.match(workflowSource, /motherEventAnchorRequired/);
  assert.match(workflowSource, /seriesAnchorRequired/);
  assert.match(workflowSource, /textAxis: "center"/);
  assert.match(workflowSource, /backgroundMode: "artistic_scenic"/);
  assert.match(workflowSource, /montageMode: "artistic_scenic_montage"/);
  assert.match(workflowSource, /photorealistic_fine_linework/);
  assert.match(workflowSource, /cad_drawing/);
  assert.match(workflowSource, /flowchart/);
  assert.match(workflowSource, /eventElementCollage/);
  assert.match(workflowSource, /publicVisibilityDoesNotGrantReuseRights: true/);
  assert.match(workflowSource, /perAssetRightsRequired: true/);
});

test("旧 baseline 只允许显式历史读取，新工位与新 Build 默认失败关闭", () => {
  assert.deepEqual(LEGACY_INFORMATION_COVER_BASELINE_IDS, ["information-cover-v2-centered-scenic-montage"]);
  assert.equal(isCurrentInformationCoverBaseline(INFORMATION_COVER_BASELINE_ID), true);
  assert.equal(informationCoverBaselineCompatibility(INFORMATION_COVER_BASELINE_ID), "current");

  const legacyReceipt = makeReceipt();
  legacyReceipt.baseline.id = LEGACY_INFORMATION_COVER_BASELINE_IDS[0];
  const normalized = normalizeInformationCoverEvidenceReceipt(legacyReceipt);
  assert.ok(normalized, "旧回执必须仍可被历史详情页规范化读取");
  assert.equal(informationCoverBaselineCompatibility(normalized.baseline.id), "legacy_read_only");

  const currentCompletion = validateInformationCoverEvidenceReceipt(legacyReceipt);
  assert.equal(currentCompletion.valid, false);
  assert.equal(currentCompletion.baselineCompatibility, "legacy_read_only");
  assert.ok(currentCompletion.errors.some((error) => error.includes("仅供历史读取")));

  const historicalRead = validateInformationCoverEvidenceReceipt(legacyReceipt, {
    allowLegacyBaselineForHistoricalRead: true,
  });
  assert.equal(historicalRead.valid, true, historicalRead.errors.join("；"));
  assert.equal(historicalRead.baselineCompatibility, "legacy_read_only");

  const unknownReceipt = makeReceipt();
  unknownReceipt.baseline.id = "information-cover-unknown";
  assert.equal(validateInformationCoverEvidenceReceipt(unknownReceipt, {
    allowLegacyBaselineForHistoricalRead: true,
  }).valid, false);
});

test("封面 Profile canonical JSON 与固定 SHA 可供 Build 绑定规则当前性", async () => {
  assert.match(INFORMATION_COVER_PROFILE_SHA256, /^[a-f0-9]{64}$/);
  assert.equal(await computeInformationCoverProfileSha256(), INFORMATION_COVER_PROFILE_SHA256);
  assert.equal(JSON.parse(canonicalInformationCoverProfileJson()).baselineId, INFORMATION_COVER_BASELINE_ID);
});

test("封面验收覆盖冷读、布局、缩略图、裁切、色偏、相邻封面和哈希", () => {
  assert.equal(INFORMATION_COVER_PROFILE.copyContract.coldReaders, 2);
  assert.deepEqual(INFORMATION_COVER_PROFILE.validationContract.thumbnailWidthsPx, [120, 220]);
  assert.equal(INFORMATION_COVER_PROFILE.validationContract.thumbnailWidthPx, 220);
  assert.equal(INFORMATION_COVER_PROFILE.validationContract.cropExercisePercentEachSide, 15);
  assert.equal(INFORMATION_COVER_PROFILE.validationContract.adjacentCoverMinimum, 6);
  assert.ok(INFORMATION_COVER_REQUIRED_ARTIFACTS.includes("cover_copy_gate_report"));
  assert.ok(INFORMATION_COVER_REQUIRED_ARTIFACTS.includes("cover_layout_report"));
  assert.ok(INFORMATION_COVER_REQUIRED_ARTIFACTS.includes("cover_render_gate_report"));
  assert.ok(INFORMATION_COVER_REQUIRED_ARTIFACTS.includes("cover_human_decision"));
  assert.ok(INFORMATION_COVER_REQUIRED_ARTIFACTS.includes("cover_thumbnail_120_qa"));
  assert.ok(INFORMATION_COVER_REQUIRED_ARTIFACTS.includes("cover_thumbnail_220_qa"));
  assert.ok(INFORMATION_COVER_REQUIRED_ARTIFACTS.includes("cover_per_asset_rights_ledger"));
  assert.ok(INFORMATION_COVER_REQUIRED_ARTIFACTS.includes("cover_artifact_delivery_receipt"));
  assert.match(workflowSource, /coldReaders: 2/);
  assert.match(workflowSource, /deterministicTextLayout: true/);
  assert.match(workflowSource, /thumbnailWidthsPx: \[120, 220\]/);
  assert.match(workflowSource, /cropExercisePercentEachSide: 15/);
  assert.match(workflowSource, /neutralColorCastReview: true/);
  assert.match(workflowSource, /adjacentCoverMinimum: 6/);
  assert.match(workflowSource, /not_available_with_reason/);
  assert.match(workflowSource, /sha256BindingRequired: true/);
  assert.match(workflowSource, /humanAcceptanceRequired: true/);
  assert.match(workflowSource, /cover_human_decision/);
});

test("默认新文章完整生产路线实际插入封面步骤且平台包被人工签发阻断", () => {
  const recipe = FACTORY_RECIPES.find((item) => item.id === "evidence-led-longform-v1");
  assert.ok(recipe);
  assert.equal(recipe.version, "1.4.0");
  assert.deepEqual(INFORMATION_COVER_RECIPE_STEPS.map((step) => step.id), INFORMATION_COVER_RECIPE_STEP_IDS);
  const ids = recipe.steps.map((step) => step.id);
  assert.ok(ids.indexOf("human-review") < ids.indexOf("cover-copy-contract"));
  assert.ok(ids.indexOf("cover-human-acceptance") < ids.indexOf("package"));
  assert.equal(recipe.steps.find((step) => step.id === "cover-copy-contract")?.capabilityId, INFORMATION_COVER_CAPABILITY_ID);
  assert.equal(recipe.steps.find((step) => step.id === "cover-human-acceptance")?.actorKind, "human");
  assert.equal(recipe.steps.find((step) => step.id === "cover-human-acceptance")?.capabilityId, INFORMATION_COVER_CAPABILITY_ID);
  assert.deepEqual(recipe.steps.find((step) => step.id === "package")?.dependsOn, INFORMATION_COVER_RECIPE_STEP_IDS);
  assert.match(recipeSource, /INFORMATION_COVER_RECIPE_STEPS/);
  assert.match(recipeSource, /version: "1\.4\.0"/);
  assert.match(recipeSource, /新建对外知识文章或导入选择完整生产时的默认路线/);
  assert.match(recipeSource, /四个封面工位真实 complete/);
  assert.ok(recipeSource.indexOf("...INFORMATION_COVER_RECIPE_STEPS") < recipeSource.indexOf('id: "package"'));
  assert.match(workflowSource, /id: "cover-copy-contract"/);
  assert.match(workflowSource, /id: "cover-visual-plan"/);
  assert.match(workflowSource, /id: "cover-render-gates"/);
  assert.match(workflowSource, /id: "cover-human-acceptance"/);
  assert.match(workflowSource, /不得声称封面已生成/);
  assert.match(workflowSource, /不代表已上传或已发布/);
});

test("所有 Agent 工位显式声明最小写入范围，正文初稿只写工作分支", () => {
  const allowedScopes = new Set(["artifact-only", "branch-working-copy"]);

  for (const recipe of FACTORY_RECIPES) {
    for (const step of recipe.steps.filter((item) => item.actorKind === "agent")) {
      assert.ok(
        allowedScopes.has(step.writeScope),
        `${recipe.id}/${step.id} 必须显式声明受限 writeScope`,
      );
    }
  }

  const recipe = FACTORY_RECIPES.find((item) => item.id === "evidence-led-longform-v1");
  assert.ok(recipe);
  assert.equal(recipe.steps.find((step) => step.id === "draft")?.writeScope, "branch-working-copy");
});

test("完整生产导入只推荐并计划封面门禁，不自动启动或发布", () => {
  assert.match(importSource, /workflowRecommendation/);
  assert.match(importSource, /recipeId: fullProductionRequested \? "evidence-led-longform-v1" : null/);
  assert.match(importSource, /humanStartRequired: true/);
  assert.match(importSource, /INFORMATION_COVER_REQUIRED_ARTIFACTS/);
  assert.match(editorSource, /含信息型封面门禁/);
  assert.match(editorSource, /本次导入只记录请求，不自动启动、生成或发布/);
});

test("v2 结构化回执规范化后可让四个封面工位逐站通过", () => {
  let expectedInputSha256 = BODY_SHA256;
  for (const stepId of INFORMATION_COVER_RECIPE_STEP_IDS) {
    const receipt = makeReceipt(stepId);
    receipt.bindings.inputSha256 = expectedInputSha256;
    const raw = JSON.stringify(receipt);
    const normalized = normalizeInformationCoverEvidenceReceipt(raw);
    assert.ok(normalized);
    assert.equal(normalized.stepId, stepId);
    const result = validateInformationCoverEvidenceReceipt(raw, {
      expectedStepId: stepId,
      expectedArticleBodySha256: BODY_SHA256,
      expectedInputSha256,
    });
    assert.equal(result.valid, true, result.errors.join("；"));
    expectedInputSha256 = receipt.artifact.sha256;
  }
});

test("自由文本、缺字段、错哈希、stale 与未批准回执全部失败关闭", () => {
  assert.equal(validateInformationCoverEvidenceReceipt("工件已完成").valid, false);

  const missingApproval = makeReceipt();
  delete missingApproval.approval;
  const missingResult = validateInformationCoverEvidenceReceipt(missingApproval);
  assert.equal(missingResult.valid, false);
  assert.ok(missingResult.errors.some((error) => error.includes("批准") || error.includes("approval")));

  const mismatchedHash = makeReceipt();
  mismatchedHash.bindings.artifactSha256 = "9".repeat(64);
  const mismatchResult = validateInformationCoverEvidenceReceipt(mismatchedHash);
  assert.equal(mismatchResult.valid, false);
  assert.ok(mismatchResult.errors.some((error) => error.includes("artifact SHA-256")));

  const stale = makeReceipt();
  stale.state.stale = true;
  assert.equal(validateInformationCoverEvidenceReceipt(stale).valid, false);
  assert.equal(validateInformationCoverEvidenceReceipt(makeReceipt(), { expectedArticleBodySha256: "8".repeat(64) }).valid, false);
  assert.equal(validateInformationCoverEvidenceReceipt(makeReceipt(), { expectedInputSha256: "8".repeat(64) }).valid, false);

  const unapproved = makeReceipt();
  unapproved.approval.status = "pending";
  assert.equal(validateInformationCoverEvidenceReceipt(unapproved).valid, false);
});

test("公开可见不能替代逐资产复用权，rights unknown 必须阻断", () => {
  const unknownRights = makeReceipt("cover-visual-plan");
  unknownRights.assetRights[1].reuseStatus = "unknown";
  unknownRights.assetRights[1].publicVisibilityOnly = true;
  const result = validateInformationCoverEvidenceReceipt(unknownRights, {
    expectedStepId: "cover-visual-plan",
    expectedArticleBodySha256: BODY_SHA256,
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.includes("复用权未知")));
  assert.ok(result.errors.some((error) => error.includes("公开可见")));
});

test("Package 只接受四个封面工位真实 complete，skipped 不能绕过", () => {
  const completeSteps = INFORMATION_COVER_RECIPE_STEP_IDS.map((stepId) => ({ stepId, status: "complete" }));
  assert.equal(informationCoverPackageReady(completeSteps), true);
  assert.equal(informationCoverPackageReady(completeSteps.map((step, index) => index === 1 ? { ...step, status: "skipped" } : step)), false);
  assert.equal(informationCoverPackageReady(completeSteps.slice(1)), false);
  assert.match(workspaceSource, /信息型知识封面 v2 的四个工位禁止 skipped/);
  assert.match(workspaceSource, /informationCoverPackageReady/);
  assert.match(workspaceSource, /coverStepsInRun\.length === 0/);
  assert.match(workspaceSource, /position > \?[\s\S]*'cover-human-acceptance', 'package'/);
});

test("workspace 只给当前封面能力 Agent 开放结构化外部回执完成入口", () => {
  assert.match(workspaceSource, /validateInformationCoverEvidenceReceipt\(evidenceNote/);
  assert.match(workspaceSource, /expectedArticleBodySha256: String\(currentBinding\.head_body_sha256\)/);
  assert.match(workspaceSource, /expectedInputSha256/);
  assert.match(workspaceSource, /上游封面工位 \$\{upstreamStepId\} 的回执已 stale/);
  assert.match(workspaceSource, /revision\.body_sha256 = \?/);
  assert.match(workspaceSource, /正文分支头在封面回执核验后发生变化/);
  assert.match(workspaceSource, /String\(step\.actor_kind\) !== "human" && !externalArtifactReceiptVerified/);
  assert.match(workspaceSource, /evidenceNote = JSON\.stringify\(validation\.receipt\)/);
  assert.match(workbenchSource, /核验外部封面工件完成/);
  assert.match(workbenchSource, /粘贴 wenmai\.information-cover-evidence-receipt\/2\.0\.0 结构化 JSON 回执/);
  assert.match(workbenchSource, /!isCoverStep[^\n]+尚无执行器；不能手工冒充完成/);
});
