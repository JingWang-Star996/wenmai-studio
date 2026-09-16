import assert from "node:assert/strict";
import test from "node:test";

import {
  ARTICLE_GUIDANCE_CHECKLIST_SCHEMA_VERSION,
  ArticleArchiveIntakeError,
  buildArticleGuidanceChecklist,
  buildLocalImportPackageDocument,
  parseLocalImportIntakeDeclaration,
} from "../app/article-archive-intake.ts";
import {
  IMPORT_PROFILE_OUTPUT_SCHEMA_VERSION,
  IMPORT_PROFILE_PROMPT_VERSION,
  buildImportWorkflowMetadata,
} from "../app/import-profile.ts";
import {
  ARTICLE_GUIDANCE_DECISION_SCHEMA_VERSION,
  verifyArticleGuidanceDecisionReceipt,
} from "../app/article-guidance-decision.ts";

const BODY_SHA = "a".repeat(64);

function bindings() {
  return {
    articleId: "article-test",
    projectId: "project-test",
    packageId: "package-test",
    branchId: "branch-test",
    revisionId: "revision-test",
    bodySha256: "a".repeat(64),
    compositionId: "composition-test",
    documentSha256: "b".repeat(64),
    compositionSha256: "c".repeat(64),
    packageLockVersion: 3,
    branchLockVersion: 7,
    workingCopyLockVersion: 11,
  };
}

test("旧五字段调用获得安全的轻建档默认声明，但不会伪造人工选择", () => {
  const declaration = parseLocalImportIntakeDeclaration(undefined);
  assert.equal(declaration.contentKind, "article");
  assert.equal(declaration.editorialStage, "unknown");
  assert.equal(declaration.declarationState, "policy_defaulted");
});

test("弱模型 intake 使用精确 schema，未知字段与伪造完成字段写前失败", () => {
  assert.throws(() => parseLocalImportIntakeDeclaration({
    schemaVersion: "wenmai-local-import-declaration/1.0.0",
    contentKind: "article",
    editorialStage: "draft",
    goal: "进入人工审校",
    audience: "普通读者",
    constraints: [],
    editorialComplete: true,
  }), (error) => error instanceof ArticleArchiveIntakeError && error.code === "UNKNOWN_INTAKE_FIELD");
  assert.throws(() => parseLocalImportIntakeDeclaration({
    schemaVersion: "wenmai-local-import-declaration/1.0.0",
    contentKind: "article",
    editorialStage: "draft",
    goal: "进入人工审校",
    audience: "普通读者",
  }), (error) => error instanceof ArticleArchiveIntakeError && error.code === "MISSING_INTAKE_FIELD");
});

test("Key 导入确定性建立来源、模块、顺序边和非完成边界", () => {
  const document = buildLocalImportPackageDocument({
    title: "测试文章",
    bodyText: "# 测试文章\n\n第一段。\n\n## 第二节\n\n第二段。",
    bodySha256: BODY_SHA,
    sourceName: "article.md",
    format: "markdown",
    commandId: "wmcmd-test",
    intake: parseLocalImportIntakeDeclaration(undefined),
  });
  assert.equal(document.sources.length, 1);
  assert.equal(document.sources[0].contentSha256, BODY_SHA);
  assert.equal(document.modules.length, 4);
  assert.equal(document.edges.length, 3);
  assert.ok(document.modules.every((module) => module.refs?.[0]?.refKey === document.sources[0].key));
  assert.equal(document.metadata.archiveIntake.policyProfile.selectionAuthority, "policy_default");
  assert.equal(document.metadata.archiveIntake.completionBoundary.publishReady, false);
});

test("模块拆分保留原文的前后空白与多重空行，渲染摘要不会漂移", () => {
  const bodyText = "\n# 标题\n\n\n第一段。\n\n\n\n第二段。\n";
  const document = buildLocalImportPackageDocument({
    title: "保真测试",
    bodyText,
    bodySha256: "9".repeat(64),
    sourceName: "roundtrip.md",
    format: "markdown",
    commandId: "cmd-roundtrip",
    intake: parseLocalImportIntakeDeclaration(undefined),
  });
  assert.equal(document.modules.map((module) => module.contentText).join("\n\n"), bodyText);
});

test("Markdown 围栏代码中的空行不拆模块，反引号与波浪线都逐字节往返", () => {
  const bodyText = "# 标题\n\n```js\nconst a = 1;\n\nconst b = 2;\n```\n\n~~~txt\n第一行\n\n第二行\n~~~\n\n结尾。";
  const document = buildLocalImportPackageDocument({
    title: "围栏保真",
    bodyText,
    bodySha256: "6".repeat(64),
    sourceName: "fences.md",
    format: "markdown",
    commandId: "cmd-fences",
    intake: parseLocalImportIntakeDeclaration(undefined),
  });
  assert.equal(document.modules.map((module) => module.contentText).join("\n\n"), bodyText);
  assert.equal(document.modules.length, 4);
  assert.equal(document.modules[1].kind, "code");
  assert.equal(document.modules[2].kind, "code");
  assert.match(document.modules[1].contentText, /const a = 1;\n\nconst b = 2;/u);
  assert.match(document.modules[2].contentText, /第一行\n\n第二行/u);
});

test("text 导入生成 text 模块，不把纯文本冒充 Markdown", () => {
  const document = buildLocalImportPackageDocument({
    title: "纯文本",
    bodyText: "第一段。\n\n第二段。",
    bodySha256: "5".repeat(64),
    sourceName: "plain.txt",
    format: "text",
    commandId: "cmd-text",
    intake: parseLocalImportIntakeDeclaration(undefined),
  });
  assert.ok(document.modules.every((module) => module.contentFormat === "text"));
});

test("新 Key 导入可证明轻建档读回，但仍等待人工分流且不能推出完成", async () => {
  const document = buildLocalImportPackageDocument({
    title: "测试文章",
    bodyText: "# 测试文章\n\n第一段。\n\n第二段。",
    bodySha256: BODY_SHA,
    sourceName: "article.md",
    format: "markdown",
    commandId: "wmcmd-test",
    intake: parseLocalImportIntakeDeclaration(undefined),
  });
  const checklist = await buildArticleGuidanceChecklist({
    document,
    packageStatus: "active",
    branchStatus: "active",
    workingCopyDirty: false,
    branchBridgeInSync: true,
    bindings: bindings(),
  });
  assert.equal(checklist.schemaVersion, ARTICLE_GUIDANCE_CHECKLIST_SCHEMA_VERSION);
  assert.match(checklist.checklistSha256, /^[a-f0-9]{64}$/u);
  assert.equal(checklist.archiveReady, true);
  assert.equal(checklist.archiveState, "archived_pending_human_triage");
  assert.equal(checklist.processingProfile, "light_archive");
  assert.equal(checklist.profileAuthority, "policy_default");
  assert.equal(checklist.editorialWorkReady, false);
  assert.equal(checklist.nextAction.checkId, "triage.profile.human_decision");
  assert.equal(checklist.completionBoundary.archiveRecordVerified, true);
  assert.equal(checklist.completionBoundary.editorialComplete, false);
  assert.equal(checklist.completionBoundary.publicAccessVerified, false);
  assert.ok(checklist.permissions.forbiddenActions.includes("declare_complete"));
});

test("历史正文单模块且无来源时明确标为 needs_archive_repair", async () => {
  const document = {
    schemaVersion: "wenmai-package-document-v1",
    title: "历史文章",
    rootModuleKey: "body",
    modules: [{
      key: "body",
      kind: "article_body",
      title: "历史文章",
      contentFormat: "markdown",
      contentText: "# 历史文章\n\n第一段。\n\n第二段。",
      metadata: {},
      refs: [],
    }],
    edges: [],
    assets: [],
    sources: [],
    metadata: {},
  };
  const checklist = await buildArticleGuidanceChecklist({
    document,
    packageStatus: "active",
    branchStatus: "active",
    workingCopyDirty: false,
    branchBridgeInSync: true,
    bindings: bindings(),
  });
  assert.equal(checklist.archiveReady, false);
  assert.equal(checklist.archiveState, "needs_archive_repair");
  assert.equal(checklist.nextAction.checkId, "archive.source.registered");
  assert.equal(checklist.checks.find((item) => item.id === "archive.graph.decomposed")?.status, "pending");
  assert.equal(checklist.checks.find((item) => item.id === "archive.graph.decomposed")?.responsibleActor, "coordinator");
  assert.ok(checklist.checks
    .filter((item) => item.phase === "archive" && item.status !== "passed")
    .every((item) => item.responsibleActor !== "agent"));
  assert.equal(checklist.workUnits[0].state, "needs_decomposition");
});

test("即使 Package metadata 声称 human full_production，也不能代替服务端人工决定回执", async () => {
  const document = buildLocalImportPackageDocument({
    title: "生产文章",
    bodyText: "# 生产文章\n\n正文。",
    bodySha256: BODY_SHA,
    sourceName: "article.md",
    format: "markdown",
    commandId: "wmcmd-test",
    intake: parseLocalImportIntakeDeclaration(undefined),
  });
  document.metadata.importWorkflow = buildImportWorkflowMetadata({
    selectedProfile: "full_production",
    source: { name: "article.md", format: "markdown", sourceSha256: BODY_SHA, bytes: 30 },
    recommendation: {
      schemaVersion: IMPORT_PROFILE_OUTPUT_SCHEMA_VERSION,
      status: "fallback",
      source: "rules_fallback",
      recommendedProfile: "full_production",
      confidence: 0.5,
      reasons: ["测试固定推荐"],
      missingSignals: ["none"],
      inputSha256: "d".repeat(64),
      sourceSha256: BODY_SHA,
      provider: null,
      model: null,
      promptVersion: IMPORT_PROFILE_PROMPT_VERSION,
      paidEgressPerformed: false,
      egressTextCharacters: 0,
      automaticRetry: false,
    },
  });
  const checklist = await buildArticleGuidanceChecklist({
    document,
    packageStatus: "active",
    branchStatus: "active",
    workingCopyDirty: false,
    branchBridgeInSync: true,
    bindings: bindings(),
  });
  assert.equal(checklist.profileAuthority, "policy_default");
  assert.equal(checklist.processingProfile, "light_archive");
  assert.equal(checklist.editorialWorkReady, false);
  assert.equal(checklist.archiveState, "archived_pending_human_triage");
  assert.equal(checklist.checks.find((item) => item.id === "triage.profile.human_decision")?.status, "human_required");
  assert.deepEqual(checklist.bindings.packageLockVersion, 3);
});

test("模块 metadata confirmed 不能自证 human_confirmed", async () => {
  const document = buildLocalImportPackageDocument({
    title: "自证确认",
    bodyText: "# 标题\n\n正文。",
    bodySha256: "4".repeat(64),
    sourceName: "confirmed.md",
    format: "markdown",
    commandId: "cmd-confirmed",
    intake: parseLocalImportIntakeDeclaration(undefined),
  });
  document.modules[0].metadata.confirmed = true;
  const checklist = await buildArticleGuidanceChecklist({
    document,
    packageStatus: "active",
    branchStatus: "active",
    workingCopyDirty: false,
    branchBridgeInSync: true,
    bindings: bindings(),
  });
  assert.equal(checklist.workUnits[0].state, "needs_human_review");
});

test("来源缺少 rights.basis 或 verificationStatus 时不能取得建档通过", async () => {
  const document = buildLocalImportPackageDocument({
    title: "权利边界缺失",
    bodyText: "# 标题\n\n正文。",
    bodySha256: "3".repeat(64),
    sourceName: "rights.md",
    format: "markdown",
    commandId: "cmd-rights",
    intake: parseLocalImportIntakeDeclaration(undefined),
  });
  delete document.sources[0].rights.verificationStatus;
  const checklist = await buildArticleGuidanceChecklist({
    document,
    packageStatus: "active",
    branchStatus: "active",
    workingCopyDirty: false,
    branchBridgeInSync: true,
    bindings: bindings(),
  });
  assert.equal(checklist.archiveReady, false);
  assert.equal(checklist.checks.find((item) => item.id === "archive.source.registered")?.status, "pending");
});

test("来源登记与模块 provenance 不能用两个不同资格的 SourceRef 拆票通过", async () => {
  const document = buildLocalImportPackageDocument({
    title: "拆票来源",
    bodyText: "# 标题\n\n正文。",
    bodySha256: "2".repeat(64),
    sourceName: "qualified.md",
    format: "markdown",
    commandId: "cmd-split-source",
    intake: parseLocalImportIntakeDeclaration(undefined),
  });
  document.sources.push({
    key: "source-unqualified",
    sourceKind: "markdown_file",
    canonicalRef: "unqualified.md",
    title: "unqualified.md",
    // 与合格 Source A 使用相同正文 SHA，仍不得借用 A 的 rights 合同。
    contentSha256: "2".repeat(64),
    excerpt: "无权利合同来源",
    metadata: {},
    rights: {},
  });
  for (const moduleItem of document.modules) {
    moduleItem.refs = [{ refKind: "source", refKey: "source-unqualified", relationType: "imported_from" }];
  }
  const checklist = await buildArticleGuidanceChecklist({
    document, packageStatus: "active", branchStatus: "active",
    workingCopyDirty: false, branchBridgeInSync: true, bindings: bindings(),
  });
  assert.equal(checklist.checks.find((item) => item.id === "archive.source.registered")?.status, "passed");
  assert.equal(checklist.checks.find((item) => item.id === "archive.module.provenance")?.status, "pending");
  assert.equal(checklist.checks.find((item) => item.id === "archive.module.provenance")?.responsibleActor, "coordinator");
  assert.equal(checklist.archiveReady, false);
});

test("伪造 selectedBy=human 的 metadata 不能绕过严格工作流与来源绑定", async () => {
  const document = buildLocalImportPackageDocument({
    title: "伪造人工决定",
    bodyText: "# 正文\n\n内容。",
    bodySha256: "8".repeat(64),
    sourceName: "forged.md",
    format: "markdown",
    commandId: "cmd-forged",
    intake: parseLocalImportIntakeDeclaration(undefined),
  });
  document.metadata.importWorkflow = {
    schemaVersion: "wenmai-import-workflow/1.0.0",
    selectedBy: "human",
    selectedProfile: "full_production",
    source: { sha256: "8".repeat(64) },
  };
  const checklist = await buildArticleGuidanceChecklist({
    document,
    packageStatus: "active",
    branchStatus: "active",
    workingCopyDirty: false,
    branchBridgeInSync: true,
  });
  assert.equal(checklist.profileAuthority, "policy_default");
  assert.equal(checklist.editorialWorkReady, false);
  assert.equal(checklist.checks.find((item) => item.id === "triage.profile.human_decision")?.status, "human_required");
});

test("纯空白正文不能取得建档通过", async () => {
  const document = buildLocalImportPackageDocument({
    title: "空白",
    bodyText: "   \n\n  ",
    bodySha256: "7".repeat(64),
    sourceName: "blank.txt",
    format: "text",
    commandId: "cmd-blank",
    intake: parseLocalImportIntakeDeclaration(undefined),
  });
  document.modules[0].contentText = "   \n\n  ";
  const checklist = await buildArticleGuidanceChecklist({
    document,
    packageStatus: "active",
    branchStatus: "active",
    workingCopyDirty: false,
    branchBridgeInSync: true,
  });
  assert.equal(checklist.archiveReady, false);
  assert.equal(checklist.checks.find((item) => item.id === "archive.content.nonempty")?.status, "blocked");
});

test("仅独立且完整绑定匹配的服务端人工回执可开启完整生产候选工位", async () => {
  const document = buildLocalImportPackageDocument({
    title: "人工分流",
    bodyText: "# 标题\n\n正文。",
    bodySha256: BODY_SHA,
    sourceName: "decision.md",
    format: "markdown",
    commandId: "cmd-decision",
    intake: parseLocalImportIntakeDeclaration(undefined),
  });
  const baseline = await buildArticleGuidanceChecklist({
    document, packageStatus: "active", branchStatus: "active",
    workingCopyDirty: false, branchBridgeInSync: true, bindings: bindings(),
  });
  const decisionBindings = { ...bindings(), baselineChecklistSha256: baseline.checklistSha256 };
  const receiptId = "guidance-decision-test";
  const actorId = "management:owner-test";
  const requestSha256 = "d".repeat(64);
  const responseJson = {
    data: {
      guidanceDecision: {
        schemaVersion: ARTICLE_GUIDANCE_DECISION_SCHEMA_VERSION,
        receiptId,
        actorId,
        requestSha256,
        selectedProfile: "full_production",
        decisionNote: "进入完整生产，但仍只允许候选 Patch",
        bindings: decisionBindings,
      },
    },
  };
  const verifiedDecision = verifyArticleGuidanceDecisionReceipt({
    receiptId, actorId, requestSha256, completedAt: "2026-08-26T00:00:00.000Z",
    responseJson, currentBindings: decisionBindings,
  });
  assert.ok(verifiedDecision);
  const checklist = await buildArticleGuidanceChecklist({
    document, packageStatus: "active", branchStatus: "active",
    workingCopyDirty: false, branchBridgeInSync: true, bindings: bindings(), verifiedDecision,
  });
  assert.equal(checklist.profileAuthority, "human");
  assert.equal(checklist.processingProfile, "full_production");
  assert.equal(checklist.archiveState, "guided_editorial_work_ready");
  assert.equal(checklist.editorialWorkReady, true);
  assert.equal(checklist.nextAction.checkId, "editorial.module.candidate");
  assert.equal(checklist.nextAction.actor, "agent");
  assert.equal(checklist.completionBoundary.editorialComplete, false);
});

test("旧人工回执在 Revision、Composition、document 或任一锁变化后失效", async () => {
  const currentBindings = {
    ...bindings(),
    baselineChecklistSha256: "e".repeat(64),
  };
  const receiptId = "guidance-decision-stale";
  const actorId = "management:owner-test";
  const requestSha256 = "f".repeat(64);
  const responseJson = {
    data: { guidanceDecision: {
      schemaVersion: ARTICLE_GUIDANCE_DECISION_SCHEMA_VERSION,
      receiptId, actorId, requestSha256,
      selectedProfile: "light_archive",
      decisionNote: "仅轻量建档",
      bindings: currentBindings,
    } },
  };
  for (const changed of [
    { revisionId: "revision-next" },
    { compositionId: "composition-next" },
    { documentSha256: "1".repeat(64) },
    { packageLockVersion: 4 },
    { branchLockVersion: 8 },
    { workingCopyLockVersion: 12 },
  ]) {
    assert.equal(verifyArticleGuidanceDecisionReceipt({
      receiptId, actorId, requestSha256, completedAt: "2026-08-26T00:00:00.000Z",
      responseJson, currentBindings: { ...currentBindings, ...changed },
    }), null);
  }
});
