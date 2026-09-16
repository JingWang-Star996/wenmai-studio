import type { FactoryRecipeStep } from "./workbench-types";

export const INFORMATION_COVER_CAPABILITY_ID = "skill:design-information-article-cover";
export const INFORMATION_COVER_PROFILE_SCHEMA_VERSION = "wenmai.information-cover-profile/2.0.0";
export const INFORMATION_COVER_EVIDENCE_RECEIPT_SCHEMA_VERSION = "wenmai.information-cover-evidence-receipt/2.0.0";
export const INFORMATION_COVER_BASELINE_ID = "information-knowledge-cover-v2";
export const LEGACY_INFORMATION_COVER_BASELINE_IDS = Object.freeze([
  "information-cover-v2-centered-scenic-montage",
] as const);

export type InformationCoverBaselineCompatibility = "current" | "legacy_read_only" | "unknown";

export const INFORMATION_COVER_RULE_IDS = Object.freeze([
  "ICV2-TYPE-SIGNAL",
  "ICV2-SEPARATE-SUBTITLE-CORE-QUOTE",
  "ICV2-MOTHER-EVENT-SERIES-ANCHORS",
  "ICV2-CENTERED-TEXT-AXIS",
  "ICV2-ARTISTIC-SCENIC-MONTAGE",
  "ICV2-DOMAIN-VISUAL-SIGNAL",
  "ICV2-PER-ASSET-REUSE-RIGHTS",
  "ICV2-THUMBNAIL-120-220",
  "ICV2-REDESIGN-BASELINE-CHANGE-CONTROL",
  "ICV2-ARTIFACT-DELIVERED",
] as const);

export const INFORMATION_COVER_RECIPE_STEP_IDS = Object.freeze([
  "cover-copy-contract",
  "cover-visual-plan",
  "cover-render-gates",
  "cover-human-acceptance",
] as const);

export type InformationCoverRecipeStepId = typeof INFORMATION_COVER_RECIPE_STEP_IDS[number];

const INFORMATION_COVER_STEP_ID_SET = new Set<string>(INFORMATION_COVER_RECIPE_STEP_IDS);
const VISUAL_RECEIPT_STEPS = new Set<string>([
  "cover-visual-plan",
  "cover-render-gates",
  "cover-human-acceptance",
]);
const RENDER_RECEIPT_STEPS = new Set<string>([
  "cover-render-gates",
  "cover-human-acceptance",
]);
const CLEARED_REUSE_STATES = new Set(["original", "licensed", "permission_granted", "public_domain"]);
const SHA256_RE = /^[a-f0-9]{64}$/;

export interface InformationCoverEvidenceReceipt {
  schemaVersion: string;
  receiptId: string;
  issuedAt: string;
  capabilityId: string;
  profileSchemaVersion: string;
  stepId: string;
  ruleIds: string[];
  baseline: { id: string; sha256: string; status: string };
  bindings: {
    articleBodySha256: string;
    inputSha256: string;
    baselineSha256: string;
    artifactSha256: string;
  };
  state: {
    designMode: string;
    baselineStatus: string;
    changeControlStatus: string;
    artifactState: string;
    stale: boolean | null;
  };
  semantic: { typeSignal: string; subtitle: string; coreQuote: string };
  seriesContext: { isSeries: boolean | null; motherEvent: string; seriesAnchor: string };
  composition: { textAxis: string; backgroundMode: string; montageElements: string[] };
  assetRights: Array<{
    assetId: string;
    sourceRef: string;
    rightsBasis: string;
    reuseStatus: string;
    evidenceRef: string;
    publicVisibilityOnly: boolean | null;
  }>;
  thumbnails: Array<{ widthPx: number | null; sha256: string; artifactSha256: string }>;
  artifact: { kind: string; uri: string; sha256: string; delivered: boolean | null };
  approval: { status: string; approvedBy: string; approvedAt: string; artifactSha256: string };
}

export interface InformationCoverReceiptValidationOptions {
  expectedStepId?: string;
  expectedArticleBodySha256?: string;
  expectedInputSha256?: string;
  /**
   * 仅供历史详情页、迁移审计或导出旧记录使用。新工位完成、新 Build 与
   * Release 门禁不得设置此选项；默认仍只接受当前 canonical baseline。
   */
  allowLegacyBaselineForHistoricalRead?: boolean;
}

export interface InformationCoverReceiptValidationResult {
  valid: boolean;
  errors: string[];
  receipt: InformationCoverEvidenceReceipt | null;
  baselineCompatibility: InformationCoverBaselineCompatibility;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function normalizedText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizedHash(value: unknown): string {
  return normalizedText(value).toLowerCase();
}

function normalizedBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function normalizedStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(normalizedText).filter(Boolean);
}

function parseReceiptInput(input: unknown): Record<string, unknown> | null {
  if (typeof input === "string") {
    try {
      const parsed = JSON.parse(input) as unknown;
      return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? record(parsed) : null;
    } catch {
      return null;
    }
  }
  return input !== null && typeof input === "object" && !Array.isArray(input) ? record(input) : null;
}

export function normalizeInformationCoverEvidenceReceipt(input: unknown): InformationCoverEvidenceReceipt | null {
  const source = parseReceiptInput(input);
  if (!source) return null;
  const baseline = record(source.baseline);
  const bindings = record(source.bindings);
  const state = record(source.state);
  const semantic = record(source.semantic);
  const seriesContext = record(source.seriesContext);
  const composition = record(source.composition);
  const artifact = record(source.artifact);
  const approval = record(source.approval);
  const assetRights = Array.isArray(source.assetRights) ? source.assetRights.map((value) => {
    const asset = record(value);
    return {
      assetId: normalizedText(asset.assetId),
      sourceRef: normalizedText(asset.sourceRef),
      rightsBasis: normalizedText(asset.rightsBasis),
      reuseStatus: normalizedText(asset.reuseStatus).toLowerCase(),
      evidenceRef: normalizedText(asset.evidenceRef),
      publicVisibilityOnly: normalizedBoolean(asset.publicVisibilityOnly),
    };
  }) : [];
  const thumbnails = Array.isArray(source.thumbnails) ? source.thumbnails.map((value) => {
    const thumbnail = record(value);
    return {
      widthPx: typeof thumbnail.widthPx === "number" && Number.isSafeInteger(thumbnail.widthPx) ? thumbnail.widthPx : null,
      sha256: normalizedHash(thumbnail.sha256),
      artifactSha256: normalizedHash(thumbnail.artifactSha256),
    };
  }) : [];

  return {
    schemaVersion: normalizedText(source.schemaVersion),
    receiptId: normalizedText(source.receiptId),
    issuedAt: normalizedText(source.issuedAt),
    capabilityId: normalizedText(source.capabilityId),
    profileSchemaVersion: normalizedText(source.profileSchemaVersion),
    stepId: normalizedText(source.stepId),
    ruleIds: normalizedStringArray(source.ruleIds),
    baseline: {
      id: normalizedText(baseline.id),
      sha256: normalizedHash(baseline.sha256),
      status: normalizedText(baseline.status).toLowerCase(),
    },
    bindings: {
      articleBodySha256: normalizedHash(bindings.articleBodySha256),
      inputSha256: normalizedHash(bindings.inputSha256),
      baselineSha256: normalizedHash(bindings.baselineSha256),
      artifactSha256: normalizedHash(bindings.artifactSha256),
    },
    state: {
      designMode: normalizedText(state.designMode).toLowerCase(),
      baselineStatus: normalizedText(state.baselineStatus).toLowerCase(),
      changeControlStatus: normalizedText(state.changeControlStatus).toLowerCase(),
      artifactState: normalizedText(state.artifactState).toLowerCase(),
      stale: normalizedBoolean(state.stale),
    },
    semantic: {
      typeSignal: normalizedText(semantic.typeSignal),
      subtitle: normalizedText(semantic.subtitle),
      coreQuote: normalizedText(semantic.coreQuote),
    },
    seriesContext: {
      isSeries: normalizedBoolean(seriesContext.isSeries),
      motherEvent: normalizedText(seriesContext.motherEvent),
      seriesAnchor: normalizedText(seriesContext.seriesAnchor),
    },
    composition: {
      textAxis: normalizedText(composition.textAxis).toLowerCase(),
      backgroundMode: normalizedText(composition.backgroundMode).toLowerCase(),
      montageElements: normalizedStringArray(composition.montageElements),
    },
    assetRights,
    thumbnails,
    artifact: {
      kind: normalizedText(artifact.kind),
      uri: normalizedText(artifact.uri),
      sha256: normalizedHash(artifact.sha256),
      delivered: normalizedBoolean(artifact.delivered),
    },
    approval: {
      status: normalizedText(approval.status).toLowerCase(),
      approvedBy: normalizedText(approval.approvedBy),
      approvedAt: normalizedText(approval.approvedAt),
      artifactSha256: normalizedHash(approval.artifactSha256),
    },
  };
}

function validTimestamp(value: string): boolean {
  return Boolean(value) && Number.isFinite(Date.parse(value));
}

function requireSha256(errors: string[], value: string, label: string) {
  if (!SHA256_RE.test(value)) errors.push(`${label}必须是 64 位小写 SHA-256`);
}

export function informationCoverBaselineCompatibility(value: unknown): InformationCoverBaselineCompatibility {
  const baselineId = normalizedText(value);
  if (baselineId === INFORMATION_COVER_BASELINE_ID) return "current";
  if ((LEGACY_INFORMATION_COVER_BASELINE_IDS as readonly string[]).includes(baselineId)) return "legacy_read_only";
  return "unknown";
}

export function isCurrentInformationCoverBaseline(value: unknown): boolean {
  return informationCoverBaselineCompatibility(value) === "current";
}

export function validateInformationCoverEvidenceReceipt(
  input: unknown,
  options: InformationCoverReceiptValidationOptions = {},
): InformationCoverReceiptValidationResult {
  const receipt = normalizeInformationCoverEvidenceReceipt(input);
  if (!receipt) {
    return {
      valid: false,
      errors: ["回执必须是结构化 JSON 对象"],
      receipt: null,
      baselineCompatibility: "unknown",
    };
  }
  const errors: string[] = [];
  const baselineCompatibility = informationCoverBaselineCompatibility(receipt.baseline.id);

  if (receipt.schemaVersion !== INFORMATION_COVER_EVIDENCE_RECEIPT_SCHEMA_VERSION) errors.push("回执 schemaVersion 不是当前 v2");
  if (!receipt.receiptId) errors.push("缺少 receiptId");
  if (!validTimestamp(receipt.issuedAt)) errors.push("缺少有效 issuedAt");
  if (receipt.capabilityId !== INFORMATION_COVER_CAPABILITY_ID) errors.push("capabilityId 与信息型封面能力不匹配");
  if (receipt.profileSchemaVersion !== INFORMATION_COVER_PROFILE_SCHEMA_VERSION) errors.push("profileSchemaVersion 已过期或不匹配");
  if (!isInformationCoverRecipeStep(receipt.stepId)) errors.push("stepId 不是四个信息型封面工位之一");
  if (options.expectedStepId && receipt.stepId !== options.expectedStepId) errors.push("stepId 与当前工位不匹配");
  for (const ruleId of INFORMATION_COVER_RULE_IDS) {
    if (!receipt.ruleIds.includes(ruleId)) errors.push(`缺少当前规则 ${ruleId}`);
  }
  if (new Set(receipt.ruleIds).size !== receipt.ruleIds.length) errors.push("ruleIds 不能重复");

  if (baselineCompatibility === "legacy_read_only" && !options.allowLegacyBaselineForHistoricalRead) {
    errors.push("baseline.id 是仅供历史读取的旧基线，不能完成新工位或创建新 Build");
  } else if (baselineCompatibility === "unknown") {
    errors.push("baseline.id 不是当前 information-knowledge-cover-v2 基线，也不在历史兼容清单中");
  }
  if (receipt.baseline.status !== "current") errors.push("baseline.status 必须是 current");
  requireSha256(errors, receipt.baseline.sha256, "baseline.sha256");
  requireSha256(errors, receipt.bindings.baselineSha256, "bindings.baselineSha256");
  requireSha256(errors, receipt.bindings.articleBodySha256, "bindings.articleBodySha256");
  requireSha256(errors, receipt.bindings.inputSha256, "bindings.inputSha256");
  requireSha256(errors, receipt.bindings.artifactSha256, "bindings.artifactSha256");
  if (receipt.baseline.sha256 !== receipt.bindings.baselineSha256) errors.push("baseline SHA-256 绑定不一致");
  if (options.expectedArticleBodySha256
    && receipt.bindings.articleBodySha256 !== options.expectedArticleBodySha256.toLowerCase()) {
    errors.push("正文 SHA-256 与当前干净分支头不一致，回执已 stale");
  }
  if (options.expectedInputSha256
    && receipt.bindings.inputSha256 !== options.expectedInputSha256.toLowerCase()) {
    errors.push("input SHA-256 与当前上游工件不一致，回执已 stale");
  }

  if (!new Set(["redesign", "baseline_revision"]).has(receipt.state.designMode)) errors.push("designMode 必须是 redesign 或 baseline_revision");
  if (receipt.state.baselineStatus !== "current") errors.push("baselineStatus 必须是 current");
  if (receipt.state.changeControlStatus !== "approved") errors.push("changeControlStatus 未批准");
  if (receipt.state.artifactState !== "artifact_delivered") errors.push("artifactState 必须是 artifact_delivered");
  if (receipt.state.stale !== false) errors.push("stale 必须显式为 false");

  if (!receipt.semantic.typeSignal) errors.push("缺少可见 type_signal");
  if (!receipt.semantic.subtitle) errors.push("缺少独立副标题");
  if (!receipt.semantic.coreQuote) errors.push("缺少独立全文金句抽象");
  if (receipt.semantic.subtitle && receipt.semantic.subtitle === receipt.semantic.coreQuote) errors.push("副标题与全文金句必须分开");
  if (receipt.seriesContext.isSeries === null) errors.push("isSeries 必须显式为布尔值");
  if (receipt.seriesContext.isSeries === true && !receipt.seriesContext.motherEvent) errors.push("系列封面缺少母事件锚点");
  if (receipt.seriesContext.isSeries === true && !receipt.seriesContext.seriesAnchor) errors.push("系列封面缺少系列锚点");

  if (!receipt.artifact.kind) errors.push("缺少 artifact.kind");
  if (!receipt.artifact.uri) errors.push("缺少 artifact.uri");
  requireSha256(errors, receipt.artifact.sha256, "artifact.sha256");
  if (receipt.artifact.delivered !== true) errors.push("artifact.delivered 必须显式为 true");
  if (receipt.artifact.sha256 !== receipt.bindings.artifactSha256) errors.push("artifact SHA-256 与 bindings 不一致");

  if (receipt.approval.status !== "approved") errors.push("回执未批准");
  if (!receipt.approval.approvedBy) errors.push("缺少 approval.approvedBy");
  if (!validTimestamp(receipt.approval.approvedAt)) errors.push("缺少有效 approval.approvedAt");
  requireSha256(errors, receipt.approval.artifactSha256, "approval.artifactSha256");
  if (receipt.approval.artifactSha256 !== receipt.artifact.sha256) errors.push("批准决定未绑定当前工件 SHA-256");

  if (VISUAL_RECEIPT_STEPS.has(receipt.stepId)) {
    if (receipt.composition.textAxis !== "center") errors.push("文字轴必须整体居中");
    if (receipt.composition.backgroundMode !== "artistic_scenic_montage") errors.push("背景必须是艺术化场景拼图");
    if (!receipt.composition.montageElements.length) errors.push("艺术化场景拼图缺少关键元素");
    const rightsByAsset = new Map<string, InformationCoverEvidenceReceipt["assetRights"][number]>();
    for (const asset of receipt.assetRights) {
      if (!asset.assetId) errors.push("逐资产 rights 缺少 assetId");
      if (asset.assetId && rightsByAsset.has(asset.assetId)) errors.push(`资产 ${asset.assetId} 的 rights 记录重复`);
      if (asset.assetId) rightsByAsset.set(asset.assetId, asset);
      if (!asset.sourceRef) errors.push(`资产 ${asset.assetId || "(unknown)"} 缺少 sourceRef`);
      if (!asset.rightsBasis) errors.push(`资产 ${asset.assetId || "(unknown)"} 缺少 rightsBasis`);
      if (!CLEARED_REUSE_STATES.has(asset.reuseStatus)) errors.push(`资产 ${asset.assetId || "(unknown)"} 的复用权未知或未清除`);
      if (!asset.evidenceRef) errors.push(`资产 ${asset.assetId || "(unknown)"} 缺少 rights evidenceRef`);
      if (asset.publicVisibilityOnly !== false) errors.push(`资产 ${asset.assetId || "(unknown)"} 不能只凭公开可见判定可复用`);
    }
    for (const assetId of receipt.composition.montageElements) {
      if (!rightsByAsset.has(assetId)) errors.push(`拼图元素 ${assetId} 缺少逐资产 rights 记录`);
    }
  }

  if (RENDER_RECEIPT_STEPS.has(receipt.stepId)) {
    for (const widthPx of [120, 220]) {
      const thumbnail = receipt.thumbnails.find((item) => item.widthPx === widthPx);
      if (!thumbnail) {
        errors.push(`缺少 ${widthPx}px 缩略图回执`);
        continue;
      }
      requireSha256(errors, thumbnail.sha256, `${widthPx}px thumbnail.sha256`);
      requireSha256(errors, thumbnail.artifactSha256, `${widthPx}px thumbnail.artifactSha256`);
      if (thumbnail.artifactSha256 !== receipt.artifact.sha256) errors.push(`${widthPx}px 缩略图未绑定当前工件 SHA-256`);
    }
  }

  return { valid: errors.length === 0, errors, receipt, baselineCompatibility };
}

export function isInformationCoverRecipeStep(stepId: string): stepId is InformationCoverRecipeStepId {
  return INFORMATION_COVER_STEP_ID_SET.has(stepId);
}

export function informationCoverPackageReady(steps: Array<{ stepId: string; status: string }>): boolean {
  const statusByStep = new Map(steps.map((step) => [step.stepId, step.status]));
  return INFORMATION_COVER_RECIPE_STEP_IDS.every((stepId) => statusByStep.get(stepId) === "complete");
}

export const INFORMATION_COVER_PROFILE = Object.freeze({
  schemaVersion: INFORMATION_COVER_PROFILE_SCHEMA_VERSION,
  baselineId: INFORMATION_COVER_BASELINE_ID,
  ruleIds: INFORMATION_COVER_RULE_IDS,
  ownerCapabilityId: INFORMATION_COVER_CAPABILITY_ID,
  applicability: "knowledge_article",
  copyContract: {
    independentExpressionRequired: true,
    visibleThemeCategoryRequired: true,
    requiredSemanticSignals: ["type_signal", "article_subject", "reader_payoff"],
    visibleCopyRoles: ["main_title", "subtitle", "core_quote"],
    subtitleAndCoreQuoteMustBeSeparate: true,
    typeSignalMustBeVisibleAtThumbnail: true,
    coldReaders: 2,
    bodyHiddenFromColdReaders: true,
  },
  seriesContract: {
    motherEventRequiredWhenSeries: true,
    motherEventAnchorRequired: true,
    seriesAnchorRequired: true,
    backgroundAssetRoles: ["mother_event_party", "product_or_game", "industry_context"],
  },
  compositionContract: {
    textAxis: "center",
    centerAxisRequired: true,
    readingOrder: ["type_signal", "main_title", "subtitle", "core_quote"],
    backgroundMode: "artistic_scenic",
    montageMode: "artistic_scenic_montage",
    titleLegibilityPriority: true,
    forbiddenBackgroundModes: [
      "photorealistic_fine_linework",
      "cad_drawing",
      "flowchart",
      "dense_interface",
    ],
    eventElementCollage: {
      requiredWhenArticleHasKeyEvent: true,
      roles: ["event_parties", "transaction_or_action", "industry_or_product_signifier"],
    },
  },
  domainSignalContract: {
    visuallyRecognizableRequired: true,
    titleTextAloneCannotSatisfy: true,
    abstractOnlyForbiddenForDomains: ["game", "film", "product"],
    gameCueKinds: [
      "map_or_battlefield",
      "unit_or_character",
      "equipment_or_item",
      "gameplay_action",
      "game_interface_grammar",
      "faction_or_class",
    ],
    gameAbstractOnlyBlockers: [
      "abstract_light_trail",
      "generic_network_nodes",
      "geometric_structure_only",
      "atmosphere_only",
    ],
    isolatedThumbnailReadersMustIdentifyDomain: 2,
  },
  rightsContract: {
    perAssetRightsRequired: true,
    publicVisibilityDoesNotGrantReuseRights: true,
    publicVisibilityOnlyBlocksReuse: true,
    unknownReuseStatusBlocks: true,
    noFalseOfficialAffiliation: true,
  },
  validationContract: {
    copyBeforeVisual: true,
    deterministicTextLayout: true,
    thumbnailWidthsPx: [120, 220],
    thumbnailWidthPx: 220,
    cropExercisePercentEachSide: 15,
    neutralColorCastReview: true,
    adjacentCoverMinimum: 6,
    adjacentCoverUnavailablePolicy: "not_available_with_reason",
    sha256BindingRequired: true,
    humanAcceptanceRequired: true,
    failClosedOn: ["missing_field", "invalid_or_mismatched_sha256", "stale", "rights_unknown", "not_approved"],
  },
  redesignContract: {
    allowedModes: ["redesign", "baseline_revision"],
    visualOnlyMustBindApprovedBaseline: true,
  },
  baselineContract: {
    baselineId: INFORMATION_COVER_BASELINE_ID,
    statusRequired: "current",
    sha256BindingRequired: true,
  },
  changeControlContract: {
    approvalRequired: true,
    affectedEvidenceBecomesStaleAfterInputOrRuleChange: true,
  },
  deliveryContract: {
    terminalArtifactState: "artifact_delivered",
    publicationIsSeparate: true,
  },
} as const);

function canonicalInformationCoverValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalInformationCoverValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalInformationCoverValue(child)]));
  }
  return value;
}

export function canonicalInformationCoverProfileJson(): string {
  return JSON.stringify(canonicalInformationCoverValue(INFORMATION_COVER_PROFILE));
}

export async function computeInformationCoverProfileSha256(): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonicalInformationCoverProfileJson()),
  );
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * 当前 Profile 的确定性摘要。测试会用 computeInformationCoverProfileSha256 重算，
 * 任何 baseline、规则或门禁变化都必须同步更新此值，从而让旧 Build 派生 stale。
 */
export const INFORMATION_COVER_PROFILE_SHA256 = "df34a572f77af5f0fa048a2e9546a356127c9f7f1c3d28d8c0fe719f75a61120";

export const INFORMATION_COVER_REQUIRED_ARTIFACTS = Object.freeze([
  "cover_v2_baseline",
  "cover_v2_change_control",
  "cover_copy_contract",
  "cover_type_signal",
  "cover_subtitle",
  "cover_core_quote",
  "cover_mother_event_and_series_anchors",
  "cover_domain_signal_contract",
  "cover_copy_gate_report",
  "cover_visual_contract",
  "cover_visual_plan_report",
  "cover_per_asset_rights_ledger",
  "cover_layout_report",
  "cover_render_gate_report",
  "cover_thumbnail_120_qa",
  "cover_thumbnail_220_qa",
  "cover_crop_qa",
  "cover_neutral_color_qa",
  "cover_adjacent_comparison_qa_or_not_available",
  "cover_human_decision",
  "cover_artifact_delivery_receipt",
  "cover",
] as const);

export const INFORMATION_COVER_RECIPE_STEPS: FactoryRecipeStep[] = [
  {
    id: "cover-copy-contract",
    title: "锁定封面 v2 表达合同",
    actorKind: "agent",
    agentRole: "cover-editor",
    writeScope: "artifact-only",
    capabilityId: INFORMATION_COVER_CAPABILITY_ID,
    input: "已批准正文 SHA-256、文章类型、读者、平台、母事件、系列锚点与候选标题",
    output: "可见 type_signal、主标题、彼此分开的副标题与全文金句抽象、完整 visible_text、两名未读正文冷读记录与 v2 copy gate 报告",
    completionClaim: "输入正文与文案候选后，结构化回执绑定当前正文、v2 基线、规则集与已交付 copy 工件，approved 且 stale=false；只证明文案工件已交付，不得声称封面已生成",
  },
  {
    id: "cover-visual-plan",
    title: "建立居中轴与场景拼图方案",
    actorKind: "agent",
    agentRole: "cover-director",
    dependsOn: ["cover-copy-contract"],
    writeScope: "artifact-only",
    capabilityId: INFORMATION_COVER_CAPABILITY_ID,
    input: "已锁定 v2 copy 合同、母事件、系列锚点、题材识别目标、品牌/产品/游戏元素及逐资产复用权证据",
    output: "整体居中轴、艺术化场景拼图、题材信号合同、母事件与系列背景锚点、主动省略和逐资产 rights ledger",
    completionClaim: "输入已锁定文案与权利证据后，结构化回执绑定当前 copy 工件与题材线索；游戏文章只有抽象光轨、几何结构或纯气氛时阻断；公开可见不等于可复用，rights unknown、写实细线稿、CAD、流程图或密集界面均阻断",
  },
  {
    id: "cover-render-gates",
    title: "生成并运行 120/220 缩略图与封面门禁",
    actorKind: "agent",
    agentRole: "cover-producer",
    dependsOn: ["cover-visual-plan"],
    writeScope: "artifact-only",
    capabilityId: INFORMATION_COVER_CAPABILITY_ID,
    input: "当前 v2 copy/visual 合同、rights ledger、change control、目标画布和授权资产清单",
    output: "确定性叠字封面、layout/render 报告、120px 与 220px 缩略图、题材识别冷读、15% 裁切、综合色偏、相邻至少六张对照或 not_available 说明及全部 SHA-256",
    completionClaim: "结构化回执把 120/220 缩略图、题材识别复述、报告、逐资产 rights 与同一最终工件 SHA-256 绑定；自动通过不替代传播、审美或版权判断",
  },
  {
    id: "cover-human-acceptance",
    title: "人工签发并确认封面工件已交付",
    actorKind: "human",
    dependsOn: ["cover-render-gates"],
    writeScope: "none",
    capabilityId: INFORMATION_COVER_CAPABILITY_ID,
    gateId: "human:information-cover-acceptance-v2",
    input: "原图、120/220px 缩略图、裁切图、综合色偏对照、相邻封面对比、逐资产 rights、全部报告和当前工件 SHA-256",
    output: "approved/rejected 决定、change control 与 artifact_delivered 回执；批准决定绑定当前工件 SHA-256",
    completionClaim: "只有 v2 结构化回执 approved、artifact_delivered、stale=false 且所有哈希仍匹配，四个封面工位才算真实 complete；不代表已上传或已发布",
  },
];
