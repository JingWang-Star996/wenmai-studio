import type { ModelGatewayChatMessage } from "./model-gateway";
import { INFORMATION_COVER_REQUIRED_ARTIFACTS } from "./information-cover-workflow.ts";

export const IMPORT_PROCESSING_PROFILES = Object.freeze(["light_archive", "full_production"] as const);
export type ImportProcessingProfile = (typeof IMPORT_PROCESSING_PROFILES)[number];

export const IMPORT_PROFILE_PROMPT_VERSION = "wenmai-import-profile-recommendation/1.0.0";
export const IMPORT_PROFILE_OUTPUT_SCHEMA_VERSION = "wenmai-import-profile-output/1.0.0";
export const IMPORT_WORKFLOW_SCHEMA_VERSION = "wenmai-import-workflow/1.0.0";
export const IMPORT_PROFILE_MAX_MODEL_TEXT_CHARS = 24_000;

export type ImportSourceFormat = "markdown" | "text" | "wenmai";
export type ImportRecommendationSource = "llm" | "rules_fallback";
export type ImportRecommendationStatus = "completed" | "fallback";
export const IMPORT_PROFILE_MODEL_PROVIDERS = Object.freeze(["deepseek", "qwen", "openai", "ollama"] as const);
export type ImportProfileModelProvider = (typeof IMPORT_PROFILE_MODEL_PROVIDERS)[number];

export interface ImportProfileRequestInput {
  name: string;
  format: ImportSourceFormat;
  title: string;
  text: string;
  sourceSha256: string;
  bytes: number;
  headings: number;
  paragraphs: number;
  packageSignals?: {
    modules: number;
    sources: number;
    assets: number;
    hasWorkflowProfile: boolean;
  } | null;
}

export interface FrozenImportProfileInput {
  schemaVersion: "wenmai-import-profile-input/1.0.0";
  source: {
    name: string;
    format: ImportSourceFormat;
    title: string;
    sourceSha256: string;
    bytes: number;
  };
  observed: {
    characters: number;
    headings: number;
    paragraphs: number;
    urlCount: number;
    referenceSectionPresent: boolean;
    rawMaterialCuePresent: boolean;
    publicationCuePresent: boolean;
    packageSignals: ImportProfileRequestInput["packageSignals"];
  };
  contentSample: {
    strategy: "full" | "head_tail";
    characters: number;
    omittedCharacters: number;
    text: string;
  };
}

export interface ImportProfileRecommendation {
  schemaVersion: typeof IMPORT_PROFILE_OUTPUT_SCHEMA_VERSION;
  status: ImportRecommendationStatus;
  source: ImportRecommendationSource;
  recommendedProfile: ImportProcessingProfile;
  confidence: number;
  reasons: string[];
  missingSignals: string[];
  inputSha256: string;
  sourceSha256: string;
  provider: ImportProfileModelProvider | null;
  model: string | null;
  promptVersion: typeof IMPORT_PROFILE_PROMPT_VERSION;
  paidEgressPerformed: boolean;
  egressTextCharacters: number;
  automaticRetry: false;
  failureCode?: string;
}

export interface ImportWorkflowMetadata {
  schemaVersion: typeof IMPORT_WORKFLOW_SCHEMA_VERSION;
  selectedProfile: ImportProcessingProfile;
  selectedBy: "human";
  source: {
    name: string;
    format: ImportSourceFormat;
    sha256: string;
    bytes: number;
  };
  recommendation: ImportProfileRecommendation;
  completionBoundary: {
    archiveIdentityRequested: true;
    fullProductionRequested: boolean;
    publishReady: false;
    deliveryComplete: false;
    publicReleaseVerified: false;
  };
  workflowRecommendation: {
    recipeId: "evidence-led-longform-v1" | null;
    recipeVersion: "1.4.0" | null;
    humanStartRequired: true;
    coverCapabilityId: "skill:design-information-article-cover" | null;
  };
  plannedArtifacts: string[];
}

export class ImportProfileContractError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ImportProfileContractError";
    this.code = code;
  }
}

const SHA256_RE = /^[a-f0-9]{64}$/u;
const RAW_MATERIAL_CUE_RE = /(?:采访原文|访谈原文|录音整理|逐字稿|原始记录|素材|草稿|提纲|随手记|会议纪要|待补|待核|todo)/iu;
const PUBLICATION_CUE_RE = /(?:发布|投稿|读者|成稿|终稿|封面|导语|结语|参考资料|来源|编辑审校|交付|平台文案)/iu;
const REFERENCE_SECTION_RE = /(?:^|\n)#{1,6}\s*(?:参考资料|参考来源|资料来源|Sources?|References?)\s*$/imu;
const ALLOWED_MISSING_SIGNALS = new Set([
  "source_list",
  "fact_verification",
  "structure_completion",
  "final_copy_review",
  "publication_artifacts",
  "delivery_target",
  "none",
]);

function recordValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function cleanText(value: unknown, maximum: number) {
  return typeof value === "string" ? value.trim().replace(/\s+/gu, " ").slice(0, maximum) : "";
}

function finiteInteger(value: unknown, minimum: number, maximum: number) {
  return Number.isSafeInteger(value) && Number(value) >= minimum && Number(value) <= maximum
    ? Number(value)
    : null;
}

function assertSha(value: unknown, field: string) {
  const sha = cleanText(value, 64).toLowerCase();
  if (!SHA256_RE.test(sha)) throw new ImportProfileContractError("INVALID_SHA256", `${field} 必须是 64 位小写 SHA-256`);
  return sha;
}

function assertProfile(value: unknown): ImportProcessingProfile {
  if (value !== "light_archive" && value !== "full_production") {
    throw new ImportProfileContractError("INVALID_PROFILE", "处理预设必须是 light_archive 或 full_production");
  }
  return value;
}

function assertSourceFormat(value: unknown): ImportSourceFormat {
  if (value !== "markdown" && value !== "text" && value !== "wenmai") {
    throw new ImportProfileContractError("INVALID_SOURCE_FORMAT", "来源格式必须是 markdown、text 或 wenmai");
  }
  return value;
}

function boundedStringArray(value: unknown, field: string, maximumItems: number, maximumChars: number) {
  if (!Array.isArray(value) || value.length < 1 || value.length > maximumItems) {
    throw new ImportProfileContractError("INVALID_RECOMMENDATION", `${field} 必须包含 1 到 ${maximumItems} 项`);
  }
  const items = value.map((item) => cleanText(item, maximumChars + 1));
  if (items.some((item) => !item || item.length > maximumChars)) {
    throw new ImportProfileContractError("INVALID_RECOMMENDATION", `${field} 含有空值或超长文本`);
  }
  return items;
}

export function freezeImportProfileInput(value: ImportProfileRequestInput): FrozenImportProfileInput {
  const name = cleanText(value.name, 300);
  const title = cleanText(value.title, 300);
  const sourceSha256 = assertSha(value.sourceSha256, "sourceSha256");
  if (!name || !title) {
    throw new ImportProfileContractError("INVALID_INPUT", "导入推荐输入缺少文件名、标题或有效格式");
  }
  const format = assertSourceFormat(value.format);
  const bytes = finiteInteger(value.bytes, 0, 2_000_000);
  const headings = finiteInteger(value.headings, 0, 100_000);
  const paragraphs = finiteInteger(value.paragraphs, 0, 100_000);
  if (bytes === null || headings === null || paragraphs === null || typeof value.text !== "string") {
    throw new ImportProfileContractError("INVALID_INPUT", "导入推荐输入的文本统计无效");
  }
  const normalized = value.text.replace(/\r\n?/gu, "\n").trim();
  const sample = normalized.length <= IMPORT_PROFILE_MAX_MODEL_TEXT_CHARS
    ? normalized
    : `${normalized.slice(0, 16_000)}\n\n[中间内容已按固定规则省略]\n\n${normalized.slice(-8_000)}`;
  const packageSignals = value.packageSignals
    ? {
      modules: finiteInteger(value.packageSignals.modules, 0, 100_000) ?? 0,
      sources: finiteInteger(value.packageSignals.sources, 0, 100_000) ?? 0,
      assets: finiteInteger(value.packageSignals.assets, 0, 100_000) ?? 0,
      hasWorkflowProfile: value.packageSignals.hasWorkflowProfile === true,
    }
    : null;
  return {
    schemaVersion: "wenmai-import-profile-input/1.0.0",
    source: { name, format, title, sourceSha256, bytes },
    observed: {
      characters: normalized.length,
      headings,
      paragraphs,
      urlCount: (normalized.match(/https?:\/\/[^\s)\]]+/giu) ?? []).length,
      referenceSectionPresent: REFERENCE_SECTION_RE.test(normalized),
      rawMaterialCuePresent: RAW_MATERIAL_CUE_RE.test(`${title}\n${normalized.slice(0, 12_000)}`),
      publicationCuePresent: PUBLICATION_CUE_RE.test(`${title}\n${normalized.slice(0, 12_000)}`),
      packageSignals,
    },
    contentSample: {
      strategy: normalized.length <= IMPORT_PROFILE_MAX_MODEL_TEXT_CHARS ? "full" : "head_tail",
      characters: sample.length,
      omittedCharacters: Math.max(0, normalized.length - sample.length),
      text: sample,
    },
  };
}

export function buildImportProfileMessages(input: FrozenImportProfileInput): readonly ModelGatewayChatMessage[] {
  const system = [
    "你是文脉导入分流器。输入是一份冻结的导入摘要；动作只限判断处理成熟度，不判断文章身份归属。",
    "输出用于建议人工选择：原始素材、采访原文、逐字稿、零散笔记、探索稿或只需保存检索的内容，建议 light_archive（轻量建档）。",
    "值得进入事实核验、编辑成稿、DOCX、封面、平台文案与交付门禁的成熟或明确对外内容，才建议 full_production（完整生产）。",
    "完整生产只表示建议进入完整流程，不表示内容已完成、已批准或可发布。",
    "不得因篇幅长单独推荐完整生产；结合结构、来源、成熟度和对外交付信号。证据不足时保守推荐轻量建档，并在 missingSignals 说明缺口。",
    "只返回 JSON：recommendedProfile 为 light_archive 或 full_production；confidence 为 0 到 1；reasons 为 1 到 4 条简短中文理由；missingSignals 从 source_list、fact_verification、structure_completion、final_copy_review、publication_artifacts、delivery_target、none 中选择 1 到 6 项。",
  ].join("\n");
  const privacyPreservingSignals = {
    schemaVersion: "wenmai-import-profile-egress/1.0.0",
    privacyBoundary: {
      bodyIncluded: false,
      fileNameIncluded: false,
      titleIncluded: false,
      sourceShaIncluded: false,
    },
    source: {
      format: input.source.format,
      bytes: input.source.bytes,
    },
    observed: input.observed,
  };
  return Object.freeze([
    Object.freeze({ role: "system" as const, content: system }),
    Object.freeze({ role: "user" as const, content: JSON.stringify(privacyPreservingSignals) }),
  ]);
}

export function parseImportProfileModelOutput(
  value: unknown,
  binding: {
    inputSha256: string;
    sourceSha256: string;
    provider: ImportProfileModelProvider;
    model: string;
    egressTextCharacters: number;
  },
): ImportProfileRecommendation {
  const output = recordValue(value);
  if (!output) throw new ImportProfileContractError("INVALID_RECOMMENDATION", "模型推荐顶层必须是对象");
  const expectedKeys = ["confidence", "missingSignals", "reasons", "recommendedProfile"];
  const actualKeys = Object.keys(output).sort();
  if (actualKeys.length !== expectedKeys.length || actualKeys.some((key, index) => key !== expectedKeys[index])) {
    throw new ImportProfileContractError("INVALID_RECOMMENDATION", "模型推荐字段集合不符合冻结输出合同");
  }
  const recommendedProfile = assertProfile(output.recommendedProfile);
  const confidence = typeof output.confidence === "number" && Number.isFinite(output.confidence)
    ? output.confidence
    : Number.NaN;
  if (confidence < 0 || confidence > 1) {
    throw new ImportProfileContractError("INVALID_RECOMMENDATION", "模型推荐 confidence 必须在 0 到 1 之间");
  }
  const reasons = boundedStringArray(output.reasons, "reasons", 4, 180);
  const missingSignals = boundedStringArray(output.missingSignals, "missingSignals", 6, 40);
  if (missingSignals.some((item) => !ALLOWED_MISSING_SIGNALS.has(item))) {
    throw new ImportProfileContractError("INVALID_RECOMMENDATION", "模型推荐包含未知 missingSignals");
  }
  return {
    schemaVersion: IMPORT_PROFILE_OUTPUT_SCHEMA_VERSION,
    status: "completed",
    source: "llm",
    recommendedProfile,
    confidence: Math.round(confidence * 1000) / 1000,
    reasons,
    missingSignals,
    inputSha256: assertSha(binding.inputSha256, "inputSha256"),
    sourceSha256: assertSha(binding.sourceSha256, "sourceSha256"),
    provider: binding.provider,
    model: cleanText(binding.model, 128) || null,
    promptVersion: IMPORT_PROFILE_PROMPT_VERSION,
    paidEgressPerformed: true,
    egressTextCharacters: Math.max(0, Math.floor(binding.egressTextCharacters)),
    automaticRetry: false,
  };
}

export function fallbackImportProfileRecommendation(
  input: FrozenImportProfileInput,
  inputSha256: string,
  failureCode = "MODEL_RECOMMENDATION_UNAVAILABLE",
  attempt: {
    paidEgressPerformed?: boolean;
    provider?: ImportProfileModelProvider | null;
    model?: string | null;
    egressTextCharacters?: number;
  } = {},
): ImportProfileRecommendation {
  const fullSignals = [
    input.source.format === "wenmai" && (input.observed.packageSignals?.modules ?? 0) > 1,
    input.observed.referenceSectionPresent && input.observed.urlCount > 0,
    input.observed.publicationCuePresent && input.observed.headings >= 3 && input.observed.characters >= 2_500,
  ].filter(Boolean).length;
  const lightSignals = [
    input.observed.rawMaterialCuePresent,
    input.observed.characters < 1_200,
    input.observed.paragraphs < 4,
  ].filter(Boolean).length;
  const recommendedProfile: ImportProcessingProfile = fullSignals >= 2 && lightSignals === 0
    ? "full_production"
    : "light_archive";
  const reasons = recommendedProfile === "full_production"
    ? ["规则检测到结构、来源或对外交付信号，建议进入完整生产流程。", "这是模型不可用时的保守规则回退，仍需人工确认。"]
    : ["模型判断未完成，规则默认先保留正文、来源指纹和处理决定。", "轻量建档不声明成稿、交付或发布就绪，之后可在同一 Article 上升级。"];
  const missingSignals = [
    ...(!input.observed.referenceSectionPresent ? ["source_list"] : []),
    "fact_verification",
    ...(!input.observed.publicationCuePresent ? ["delivery_target"] : []),
    "final_copy_review",
  ].slice(0, 6);
  return {
    schemaVersion: IMPORT_PROFILE_OUTPUT_SCHEMA_VERSION,
    status: "fallback",
    source: "rules_fallback",
    recommendedProfile,
    confidence: recommendedProfile === "full_production" ? 0.56 : 0.5,
    reasons,
    missingSignals: missingSignals.length ? missingSignals : ["none"],
    inputSha256: assertSha(inputSha256, "inputSha256"),
    sourceSha256: input.source.sourceSha256,
    provider: attempt.provider ?? null,
    model: attempt.model ?? null,
    promptVersion: IMPORT_PROFILE_PROMPT_VERSION,
    paidEgressPerformed: attempt.paidEgressPerformed === true,
    egressTextCharacters: Math.max(0, Math.min(
      IMPORT_PROFILE_MAX_MODEL_TEXT_CHARS,
      Math.floor(attempt.egressTextCharacters ?? 0),
    )),
    automaticRetry: false,
    failureCode: cleanText(failureCode, 80) || "MODEL_RECOMMENDATION_UNAVAILABLE",
  };
}

export function buildImportWorkflowMetadata(input: {
  selectedProfile: ImportProcessingProfile;
  source: Pick<ImportProfileRequestInput, "name" | "format" | "sourceSha256" | "bytes">;
  recommendation: ImportProfileRecommendation;
}): ImportWorkflowMetadata {
  const selectedProfile = assertProfile(input.selectedProfile);
  const sourceSha256 = assertSha(input.source.sourceSha256, "source.sha256");
  if (sourceSha256 !== input.recommendation.sourceSha256) {
    throw new ImportProfileContractError("RECOMMENDATION_SOURCE_MISMATCH", "推荐结果没有绑定当前导入文件");
  }
  const fullProductionRequested = selectedProfile === "full_production";
  const format = assertSourceFormat(input.source.format);
  const sourceName = cleanText(input.source.name, 300);
  if (!sourceName) throw new ImportProfileContractError("INVALID_SOURCE_NAME", "来源文件名不能为空");
  return {
    schemaVersion: IMPORT_WORKFLOW_SCHEMA_VERSION,
    selectedProfile,
    selectedBy: "human",
    source: {
      name: sourceName,
      format,
      sha256: sourceSha256,
      bytes: finiteInteger(input.source.bytes, 0, 2_000_000) ?? 0,
    },
    recommendation: input.recommendation,
    completionBoundary: {
      archiveIdentityRequested: true,
      fullProductionRequested,
      publishReady: false,
      deliveryComplete: false,
      publicReleaseVerified: false,
    },
    workflowRecommendation: {
      recipeId: fullProductionRequested ? "evidence-led-longform-v1" : null,
      recipeVersion: fullProductionRequested ? "1.4.0" : null,
      humanStartRequired: true,
      coverCapabilityId: fullProductionRequested ? "skill:design-information-article-cover" : null,
    },
    plannedArtifacts: fullProductionRequested
      ? [
        "source_register",
        "fact_ledger",
        "final_article",
        "final_docx",
        ...INFORMATION_COVER_REQUIRED_ARTIFACTS,
        "platform_copy",
        "delivery_receipt",
      ]
      : ["source_snapshot", "article_identity", "revision", "package", "profile_decision"],
  };
}

export function parseImportWorkflowMetadata(value: unknown, expectedSourceSha256?: string): ImportWorkflowMetadata {
  const input = recordValue(value);
  const source = recordValue(input?.source);
  const recommendation = recordValue(input?.recommendation);
  if (!input || input.schemaVersion !== IMPORT_WORKFLOW_SCHEMA_VERSION || input.selectedBy !== "human" || !source || !recommendation) {
    throw new ImportProfileContractError("INVALID_IMPORT_WORKFLOW", "importWorkflow 不符合 wenmai-import-workflow/1.0.0");
  }
  const selectedProfile = assertProfile(input.selectedProfile);
  const sourceSha256 = assertSha(source.sha256, "importWorkflow.source.sha256");
  if (expectedSourceSha256 && sourceSha256 !== assertSha(expectedSourceSha256, "expectedSourceSha256")) {
    throw new ImportProfileContractError("IMPORT_WORKFLOW_SOURCE_MISMATCH", "处理预设没有绑定当前导入源 SHA-256");
  }
  if (recommendation.schemaVersion !== IMPORT_PROFILE_OUTPUT_SCHEMA_VERSION
    || recommendation.promptVersion !== IMPORT_PROFILE_PROMPT_VERSION) {
    throw new ImportProfileContractError("INVALID_IMPORT_WORKFLOW", "推荐 schemaVersion 或 promptVersion 无效");
  }
  const status = recommendation.status === "completed" ? "completed" : recommendation.status === "fallback" ? "fallback" : null;
  const recommendationSource = recommendation.source === "llm" ? "llm" : recommendation.source === "rules_fallback" ? "rules_fallback" : null;
  const provider = IMPORT_PROFILE_MODEL_PROVIDERS.includes(recommendation.provider as ImportProfileModelProvider)
    ? recommendation.provider as ImportProfileModelProvider
    : null;
  if (!status || !recommendationSource) throw new ImportProfileContractError("INVALID_IMPORT_WORKFLOW", "推荐状态或来源无效");
  const normalizedMissingSignals = boundedStringArray(recommendation.missingSignals, "recommendation.missingSignals", 6, 40);
  if (normalizedMissingSignals.some((item) => !ALLOWED_MISSING_SIGNALS.has(item))) {
    throw new ImportProfileContractError("INVALID_IMPORT_WORKFLOW", "推荐包含未知 missingSignals");
  }
  if ((recommendationSource === "llm" && (status !== "completed" || !provider))
    || (recommendationSource === "rules_fallback" && status !== "fallback")) {
    throw new ImportProfileContractError("INVALID_IMPORT_WORKFLOW", "推荐来源、状态与 provider 组合无效");
  }
  const normalizedRecommendation: ImportProfileRecommendation = {
    schemaVersion: IMPORT_PROFILE_OUTPUT_SCHEMA_VERSION,
    status,
    source: recommendationSource,
    recommendedProfile: assertProfile(recommendation.recommendedProfile),
    confidence: typeof recommendation.confidence === "number" && recommendation.confidence >= 0 && recommendation.confidence <= 1
      ? recommendation.confidence
      : 0,
    reasons: boundedStringArray(recommendation.reasons, "recommendation.reasons", 4, 180),
    missingSignals: normalizedMissingSignals,
    inputSha256: assertSha(recommendation.inputSha256, "recommendation.inputSha256"),
    sourceSha256: assertSha(recommendation.sourceSha256, "recommendation.sourceSha256"),
    provider,
    model: provider ? cleanText(recommendation.model, 128) || null : null,
    promptVersion: IMPORT_PROFILE_PROMPT_VERSION,
    paidEgressPerformed: recommendation.paidEgressPerformed === true,
    egressTextCharacters: finiteInteger(recommendation.egressTextCharacters, 0, IMPORT_PROFILE_MAX_MODEL_TEXT_CHARS) ?? 0,
    automaticRetry: false,
    ...(recommendation.failureCode ? { failureCode: cleanText(recommendation.failureCode, 80) } : {}),
  };
  if (normalizedRecommendation.sourceSha256 !== sourceSha256) {
    throw new ImportProfileContractError("RECOMMENDATION_SOURCE_MISMATCH", "推荐结果与 importWorkflow.source 不匹配");
  }
  return buildImportWorkflowMetadata({
    selectedProfile,
    source: {
      name: cleanText(source.name, 300),
      format: assertSourceFormat(source.format),
      sourceSha256,
      bytes: finiteInteger(source.bytes, 0, 2_000_000) ?? 0,
    },
    recommendation: normalizedRecommendation,
  });
}
