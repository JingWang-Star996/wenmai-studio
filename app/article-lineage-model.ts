export const ARTICLE_LINEAGE_AI_API_VERSION = "wenmai-article-lineage-ai-v1";
export const ARTICLE_LINEAGE_REVIEW_INPUT_SCHEMA_VERSION = "wenmai.article-lineage-review-input/1.0";
export const ARTICLE_LINEAGE_REVIEW_OUTPUT_SCHEMA_VERSION = "wenmai.article-lineage-review-output/1.0";
export const ARTICLE_LINEAGE_REVIEW_PROMPT_VERSION = "wenmai.article-lineage-reviewer/1.0";
export const ARTICLE_LINEAGE_REVIEW_DIFF_ALGORITHM = "bounded-line-window/1.0";
export const ARTICLE_LINEAGE_MODEL_ADAPTER_VERSION = "openai-chat-completions-json/2";

export const ARTICLE_LINEAGE_RELATION_RECOMMENDATIONS = Object.freeze([
  "same_root",
  "version_of",
  "adaptation_of",
  "split_from",
  "reference_only",
  "not_related",
  "inconclusive",
] as const);

export const ARTICLE_LINEAGE_REVIEW_NEXT_STEPS = Object.freeze([
  "human_confirm",
  "human_reject",
  "collect_more_evidence",
  "inspect_full_diff",
] as const);

export type ArticleLineageRelationRecommendation =
  (typeof ARTICLE_LINEAGE_RELATION_RECOMMENDATIONS)[number];
export type ArticleLineageReviewNextStep =
  (typeof ARTICLE_LINEAGE_REVIEW_NEXT_STEPS)[number];

export type ArticleLineageReviewOutput = Readonly<{
  relationRecommendation: ArticleLineageRelationRecommendation;
  confidence: number;
  reasons: readonly string[];
  differences: readonly string[];
  risks: readonly string[];
  nextStep: ArticleLineageReviewNextStep;
}>;

export const ARTICLE_LINEAGE_REVIEW_JSON_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: Object.freeze([
    "relationRecommendation",
    "confidence",
    "reasons",
    "differences",
    "risks",
    "nextStep",
  ]),
  properties: Object.freeze({
    relationRecommendation: Object.freeze({
      type: "string",
      enum: ARTICLE_LINEAGE_RELATION_RECOMMENDATIONS,
    }),
    confidence: Object.freeze({ type: "number", minimum: 0, maximum: 1 }),
    reasons: Object.freeze({
      type: "array",
      minItems: 1,
      maxItems: 6,
      items: Object.freeze({ type: "string", minLength: 1, maxLength: 400 }),
    }),
    differences: Object.freeze({
      type: "array",
      maxItems: 8,
      items: Object.freeze({ type: "string", minLength: 1, maxLength: 400 }),
    }),
    risks: Object.freeze({
      type: "array",
      maxItems: 6,
      items: Object.freeze({ type: "string", minLength: 1, maxLength: 400 }),
    }),
    nextStep: Object.freeze({ type: "string", enum: ARTICLE_LINEAGE_REVIEW_NEXT_STEPS }),
  }),
});

export const ARTICLE_LINEAGE_REVIEW_BUDGET_POLICY = Object.freeze({
  policyVersion: "wenmai.lineage-review-budget-ceiling/1.0",
  minimumOutputTokens: 128,
  maximumInputTokens: 64_000,
  maximumOutputTokens: 4_096,
  maximumCostCnyMicros: 100_000_000,
  recommendedOutputTokens: 1_024,
  // These are deliberately conservative local admission ceilings, not a claim
  // about current provider billing. A future pricing sync may lower them.
  inputCnyMicrosPerTokenCeiling: 1_000,
  outputCnyMicrosPerTokenCeiling: 4_000,
  automaticRetry: false,
});

export const ARTICLE_LINEAGE_REVIEW_RUNTIME_DDL = Object.freeze([
  `CREATE TABLE IF NOT EXISTS article_lineage_review_preparations (
    id TEXT PRIMARY KEY NOT NULL,
    candidate_id TEXT NOT NULL,
    candidate_lock_version INTEGER NOT NULL CHECK(candidate_lock_version >= 1),
    candidate_input_sha256 TEXT NOT NULL,
    source_revision_id TEXT NOT NULL,
    source_body_sha256 TEXT NOT NULL,
    target_revision_id TEXT NOT NULL,
    target_body_sha256 TEXT NOT NULL,
    frozen_input_json TEXT NOT NULL,
    input_sha256 TEXT NOT NULL,
    input_token_estimate INTEGER NOT NULL CHECK(input_token_estimate BETWEEN 1 AND 64000),
    budget_estimate_json TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'prepared' CHECK(state IN ('prepared','consumed','superseded')),
    lock_version INTEGER NOT NULL DEFAULT 1 CHECK(lock_version >= 1),
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK(length(candidate_input_sha256)=64 AND candidate_input_sha256 NOT GLOB '*[^0-9a-f]*'),
    CHECK(length(source_body_sha256)=64 AND source_body_sha256 NOT GLOB '*[^0-9a-f]*'),
    CHECK(length(target_body_sha256)=64 AND target_body_sha256 NOT GLOB '*[^0-9a-f]*'),
    CHECK(length(input_sha256)=64 AND input_sha256 NOT GLOB '*[^0-9a-f]*'),
    CHECK(json_valid(frozen_input_json) AND json_type(frozen_input_json)='object'
      AND length(CAST(frozen_input_json AS BLOB)) BETWEEN 2 AND 131072),
    CHECK(json_valid(budget_estimate_json) AND json_type(budget_estimate_json)='object'
      AND length(CAST(budget_estimate_json AS BLOB)) BETWEEN 2 AND 8192)
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_lineage_review_preparation_input
    ON article_lineage_review_preparations(candidate_id, input_sha256)`,
  `CREATE INDEX IF NOT EXISTS idx_lineage_review_preparation_state
    ON article_lineage_review_preparations(state, updated_at)`,
  `CREATE TABLE IF NOT EXISTS article_lineage_model_reviews (
    id TEXT PRIMARY KEY NOT NULL,
    preparation_id TEXT NOT NULL,
    candidate_id TEXT NOT NULL,
    candidate_lock_version INTEGER NOT NULL CHECK(candidate_lock_version >= 1),
    input_sha256 TEXT NOT NULL,
    invocation_id TEXT NOT NULL,
    provider TEXT NOT NULL CHECK(provider='deepseek'),
    model_id TEXT NOT NULL,
    output_schema_version TEXT NOT NULL,
    output_json TEXT NOT NULL,
    output_sha256 TEXT NOT NULL,
    relation_recommendation TEXT NOT NULL CHECK(relation_recommendation IN
      ('same_root','version_of','adaptation_of','split_from','reference_only','not_related','inconclusive')),
    confidence_micros INTEGER NOT NULL CHECK(confidence_micros BETWEEN 0 AND 1000000),
    candidate_only INTEGER NOT NULL DEFAULT 1 CHECK(candidate_only=1),
    state TEXT NOT NULL DEFAULT 'candidate' CHECK(state IN ('candidate','superseded')),
    max_input_tokens INTEGER NOT NULL CHECK(max_input_tokens BETWEEN 1 AND 64000),
    max_output_tokens INTEGER NOT NULL CHECK(max_output_tokens BETWEEN 128 AND 4096),
    max_cost_cny_micros INTEGER NOT NULL CHECK(max_cost_cny_micros BETWEEN 1 AND 100000000),
    reserved_cost_cny_micros INTEGER NOT NULL CHECK(reserved_cost_cny_micros >= 0),
    usage_json TEXT NOT NULL DEFAULT '{}',
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    CHECK(length(input_sha256)=64 AND input_sha256 NOT GLOB '*[^0-9a-f]*'),
    CHECK(length(output_sha256)=64 AND output_sha256 NOT GLOB '*[^0-9a-f]*'),
    CHECK(json_valid(output_json) AND json_type(output_json)='object'
      AND length(CAST(output_json AS BLOB)) BETWEEN 2 AND 32768),
    CHECK(json_valid(usage_json) AND json_type(usage_json)='object'
      AND length(CAST(usage_json AS BLOB)) BETWEEN 2 AND 8192)
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_lineage_model_reviews_invocation
    ON article_lineage_model_reviews(invocation_id)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_lineage_model_reviews_preparation
    ON article_lineage_model_reviews(preparation_id)`,
  `CREATE INDEX IF NOT EXISTS idx_lineage_model_reviews_candidate
    ON article_lineage_model_reviews(candidate_id, state, created_at)`,
]);

/**
 * Exact additive/rebuild requirement for migration 0017. SQLite cannot alter
 * the purpose CHECK in place, so model_invocations must be rebuilt while all
 * existing rows are copied verbatim. The new nullable linkage columns are
 * populated only for purpose=lineage_review.
 */
export const ARTICLE_LINEAGE_REVIEW_0017_SQL = Object.freeze([
  "ALTER TABLE model_invocations RENAME TO model_invocations_pre_0017",
  `CREATE TABLE model_invocations (
    id TEXT PRIMARY KEY NOT NULL,
    experiment_id TEXT,
    lineage_candidate_id TEXT,
    lineage_preparation_id TEXT,
    command_id TEXT NOT NULL,
    purpose TEXT NOT NULL CHECK(purpose IN ('provider_probe','meta_experiment','lineage_review')),
    role TEXT NOT NULL CHECK(role IN ('probe','proposer','execution','reviewer')),
    provider TEXT NOT NULL CHECK(provider IN ('deepseek','qwen')),
    model_id TEXT NOT NULL,
    adapter_version TEXT NOT NULL,
    prompt_version_id TEXT,
    provider_policy_sha256 TEXT,
    egress_manifest_sha256 TEXT NOT NULL,
    egress_approval_sha256 TEXT NOT NULL,
    request_sha256 TEXT NOT NULL,
    input_sha256 TEXT NOT NULL,
    response_sha256 TEXT,
    output_ref TEXT NOT NULL DEFAULT '',
    state TEXT NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','running','succeeded','failed','inconclusive','cancelled')),
    attempt INTEGER NOT NULL DEFAULT 1 CHECK(attempt >= 1),
    budget_reservation_json TEXT NOT NULL DEFAULT '{}',
    budget_reservation_sha256 TEXT NOT NULL,
    usage_json TEXT NOT NULL DEFAULT '{}',
    input_tokens INTEGER,
    output_tokens INTEGER,
    total_tokens INTEGER,
    estimated_cost_cny_micros INTEGER,
    latency_ms INTEGER,
    http_status INTEGER,
    finish_reason TEXT,
    provider_request_id TEXT,
    error_class TEXT,
    error_summary TEXT,
    created_at TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT,
    CHECK((purpose='provider_probe' AND role='probe')
      OR (purpose='meta_experiment' AND role IN ('proposer','execution','reviewer'))
      OR (purpose='lineage_review' AND role='reviewer' AND provider='deepseek')),
    CHECK(purpose='provider_probe'
      OR (purpose='meta_experiment' AND experiment_id IS NOT NULL AND prompt_version_id IS NOT NULL
        AND provider_policy_sha256 IS NOT NULL)
      OR (purpose='lineage_review' AND experiment_id IS NULL AND lineage_candidate_id IS NOT NULL
        AND lineage_preparation_id IS NOT NULL AND prompt_version_id IS NOT NULL
        AND provider_policy_sha256 IS NOT NULL)),
    CHECK((purpose='lineage_review' AND lineage_candidate_id IS NOT NULL AND lineage_preparation_id IS NOT NULL)
      OR (purpose<>'lineage_review' AND lineage_candidate_id IS NULL AND lineage_preparation_id IS NULL)),
    CHECK((input_tokens IS NULL OR input_tokens>=0) AND (output_tokens IS NULL OR output_tokens>=0)
      AND (total_tokens IS NULL OR total_tokens>=0)
      AND (estimated_cost_cny_micros IS NULL OR estimated_cost_cny_micros>=0)),
    CHECK((latency_ms IS NULL OR latency_ms>=0)
      AND (http_status IS NULL OR (http_status BETWEEN 100 AND 599)))
  )`,
  `INSERT INTO model_invocations (
    id, experiment_id, lineage_candidate_id, lineage_preparation_id, command_id, purpose, role,
    provider, model_id, adapter_version, prompt_version_id, provider_policy_sha256,
    egress_manifest_sha256, egress_approval_sha256, request_sha256, input_sha256,
    response_sha256, output_ref, state, attempt, budget_reservation_json,
    budget_reservation_sha256, usage_json, input_tokens, output_tokens, total_tokens,
    estimated_cost_cny_micros, latency_ms, http_status, finish_reason, provider_request_id,
    error_class, error_summary, created_at, started_at, finished_at)
  SELECT id, experiment_id, NULL, NULL, command_id, purpose, role, provider, model_id,
    adapter_version, prompt_version_id, provider_policy_sha256, egress_manifest_sha256,
    egress_approval_sha256, request_sha256, input_sha256, response_sha256, output_ref,
    state, attempt, budget_reservation_json, budget_reservation_sha256, usage_json,
    input_tokens, output_tokens, total_tokens, estimated_cost_cny_micros, latency_ms,
    http_status, finish_reason, provider_request_id, error_class, error_summary,
    created_at, started_at, finished_at
  FROM model_invocations_pre_0017`,
  "DROP TABLE model_invocations_pre_0017",
  "CREATE UNIQUE INDEX idx_model_invocations_command ON model_invocations(command_id)",
  "CREATE INDEX idx_model_invocations_experiment_role ON model_invocations(experiment_id, role, created_at)",
  "CREATE INDEX idx_model_invocations_purpose_state ON model_invocations(purpose, state, created_at)",
  "CREATE INDEX idx_model_invocations_provider_state ON model_invocations(provider, state, created_at)",
  "CREATE INDEX idx_model_invocations_lineage_candidate ON model_invocations(lineage_candidate_id, created_at)",
  ...ARTICLE_LINEAGE_REVIEW_RUNTIME_DDL,
]);

export const ARTICLE_LINEAGE_AI_MANIFEST = Object.freeze({
  apiVersion: ARTICLE_LINEAGE_AI_API_VERSION,
  reviewInputSchemaVersion: ARTICLE_LINEAGE_REVIEW_INPUT_SCHEMA_VERSION,
  reviewOutputSchemaVersion: ARTICLE_LINEAGE_REVIEW_OUTPUT_SCHEMA_VERSION,
  promptVersion: ARTICLE_LINEAGE_REVIEW_PROMPT_VERSION,
  adapterVersion: ARTICLE_LINEAGE_MODEL_ADAPTER_VERSION,
  provider: "deepseek",
  candidateOnly: true,
  mutatesArticleContent: false,
  mutatesIdentityDecision: false,
  automaticRetry: false,
  allowedActions: Object.freeze(["prepare_review", "run_review"]),
  allowedOutputFields: ARTICLE_LINEAGE_REVIEW_JSON_SCHEMA.required,
  budgetPolicy: ARTICLE_LINEAGE_REVIEW_BUDGET_POLICY,
});

type JsonObject = Record<string, unknown>;

export class ArticleLineageModelContractError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: JsonObject;

  constructor(code: string, message: string, status = 400, details?: JsonObject) {
    super(message);
    this.name = "ArticleLineageModelContractError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export type ArticleLineageCandidateSnapshot = Readonly<{
  id: string;
  status: string;
  lockVersion: number;
  inputSha256: string;
  proposedRelation: string;
  sourceArticleId: string;
  sourceRevisionId: string;
  sourceBodySha256: string;
  targetArticleId: string;
  targetRevisionId: string;
  targetBodySha256: string;
  evidence: unknown;
}>;

export type ArticleLineageRevisionSnapshot = Readonly<{
  articleId: string;
  revisionId: string;
  bodySha256: string;
  title: string;
  documentTitle: string;
  bodyText: string;
}>;

export type ArticleLineageFrozenReviewInput = Readonly<{
  schemaVersion: typeof ARTICLE_LINEAGE_REVIEW_INPUT_SCHEMA_VERSION;
  candidate: Readonly<{
    id: string;
    lockVersion: number;
    inputSha256: string;
    proposedRelation: string;
  }>;
  source: Readonly<{
    articleId: string;
    revisionId: string;
    bodySha256: string;
    title: string;
    documentTitle: string;
    charCount: number;
    lineCount: number;
  }>;
  target: Readonly<{
    articleId: string;
    revisionId: string;
    bodySha256: string;
    title: string;
    documentTitle: string;
    charCount: number;
    lineCount: number;
  }>;
  similaritySignals: Readonly<JsonObject>;
  diffSummary: Readonly<JsonObject>;
}>;

const SHA256_RE = /^[a-f0-9]{64}$/u;
const EXACT_OUTPUT_KEYS = Object.freeze([
  "confidence",
  "differences",
  "nextStep",
  "reasons",
  "relationRecommendation",
  "risks",
]);

function asObject(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : null;
}

function cleanBoundedText(value: unknown, maximum: number): string {
  return typeof value === "string" ? value.trim().replace(/\s+/gu, " ").slice(0, maximum) : "";
}

export function canonicalLineageJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalLineageJson).join(",")}]`;
  const object = value as JsonObject;
  return `{${Object.keys(object).sort().filter((key) => object[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${canonicalLineageJson(object[key])}`).join(",")}}`;
}

export async function sha256LineageJson(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalLineageJson(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (item) => item.toString(16).padStart(2, "0")).join("");
}

function assertSha(value: string, field: string): void {
  if (!SHA256_RE.test(value)) {
    throw new ArticleLineageModelContractError("LINEAGE_REVIEW_SHA_INVALID", `${field} 不是有效 SHA-256`);
  }
}

function sanitizeSignalValue(value: unknown, depth = 0): unknown {
  if (typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") return cleanBoundedText(value, 160);
  if (Array.isArray(value) && depth < 1) {
    return value.slice(0, 12).map((item) => sanitizeSignalValue(item, depth + 1))
      .filter((item) => item !== undefined);
  }
  const object = asObject(value);
  if (object && depth < 2) {
    return Object.fromEntries(Object.keys(object).sort().slice(0, 24)
      .map((key) => [cleanBoundedText(key, 80), sanitizeSignalValue(object[key], depth + 1)])
      .filter(([key, item]) => Boolean(key) && item !== undefined));
  }
  return undefined;
}

export function sanitizeLineageSimilaritySignals(evidence: unknown): Readonly<JsonObject> {
  const entries = Array.isArray(evidence) ? evidence : [];
  const deterministic = entries.map(asObject).find((item) => item?.kind === "deterministic_similarity");
  const signals = asObject(deterministic?.signals);
  const sanitized = sanitizeSignalValue(signals ?? {}, 0);
  const result = asObject(sanitized) ?? {};
  if (typeof deterministic?.score === "number" && Number.isFinite(deterministic.score)) {
    result.score = Math.max(0, Math.min(1, deterministic.score));
  }
  return Object.freeze(result);
}

function normalizedLines(body: string): string[] {
  return body.replace(/\r\n?/gu, "\n").split("\n");
}

function excerptLines(lines: readonly string[], start: number, end: number): string[] {
  if (end <= start) return [];
  const indexes = end - start <= 8
    ? Array.from({ length: end - start }, (_, index) => start + index)
    : [start, start + 1, start + 2, end - 3, end - 2, end - 1];
  return indexes.map((index) => `${index + 1}: ${cleanBoundedText(lines[index], 160)}`);
}

export function buildBoundedLineageDiffSummary(sourceBody: string, targetBody: string): Readonly<JsonObject> {
  const sourceLines = normalizedLines(sourceBody);
  const targetLines = normalizedLines(targetBody);
  const minimum = Math.min(sourceLines.length, targetLines.length);
  let prefix = 0;
  while (prefix < minimum && sourceLines[prefix] === targetLines[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < minimum - prefix
    && sourceLines[sourceLines.length - 1 - suffix] === targetLines[targetLines.length - 1 - suffix]) suffix += 1;
  const sourceEnd = sourceLines.length - suffix;
  const targetEnd = targetLines.length - suffix;
  const sourceExcerpt = excerptLines(sourceLines, prefix, sourceEnd);
  const targetExcerpt = excerptLines(targetLines, prefix, targetEnd);
  return Object.freeze({
    algorithmVersion: ARTICLE_LINEAGE_REVIEW_DIFF_ALGORITHM,
    identical: sourceBody === targetBody,
    sourceLineCount: sourceLines.length,
    targetLineCount: targetLines.length,
    sourceCharCount: sourceBody.length,
    targetCharCount: targetBody.length,
    commonPrefixLines: prefix,
    commonSuffixLines: suffix,
    sourceChangedRange: sourceEnd > prefix ? Object.freeze({ startLine: prefix + 1, endLine: sourceEnd }) : null,
    targetChangedRange: targetEnd > prefix ? Object.freeze({ startLine: prefix + 1, endLine: targetEnd }) : null,
    sourceChangedLineCount: Math.max(0, sourceEnd - prefix),
    targetChangedLineCount: Math.max(0, targetEnd - prefix),
    sourceExcerpt,
    targetExcerpt,
    excerptsTruncated: sourceEnd - prefix > sourceExcerpt.length || targetEnd - prefix > targetExcerpt.length,
  });
}

function verifyRevisionBinding(
  side: "source" | "target",
  candidate: ArticleLineageCandidateSnapshot,
  revision: ArticleLineageRevisionSnapshot,
): void {
  const articleId = side === "source" ? candidate.sourceArticleId : candidate.targetArticleId;
  const revisionId = side === "source" ? candidate.sourceRevisionId : candidate.targetRevisionId;
  const bodySha256 = side === "source" ? candidate.sourceBodySha256 : candidate.targetBodySha256;
  if (revision.articleId !== articleId || revision.revisionId !== revisionId || revision.bodySha256 !== bodySha256) {
    throw new ArticleLineageModelContractError(
      "LINEAGE_REVIEW_REVISION_BINDING_CHANGED",
      `${side} revision 不再匹配候选冻结值`,
      409,
      { side, articleId, revisionId },
    );
  }
}

export function freezeArticleLineageReviewInput(input: Readonly<{
  candidate: ArticleLineageCandidateSnapshot;
  source: ArticleLineageRevisionSnapshot;
  target: ArticleLineageRevisionSnapshot;
}>): ArticleLineageFrozenReviewInput {
  if (input.candidate.status !== "candidate" || !Number.isSafeInteger(input.candidate.lockVersion)
    || input.candidate.lockVersion < 1) {
    throw new ArticleLineageModelContractError(
      "LINEAGE_REVIEW_CANDIDATE_NOT_REVIEWABLE",
      "血缘候选不是可审阅状态",
      409,
    );
  }
  [input.candidate.inputSha256, input.candidate.sourceBodySha256, input.candidate.targetBodySha256,
    input.source.bodySha256, input.target.bodySha256].forEach((sha, index) => assertSha(sha, `sha[${index}]`));
  verifyRevisionBinding("source", input.candidate, input.source);
  verifyRevisionBinding("target", input.candidate, input.target);
  const sourceLines = normalizedLines(input.source.bodyText).length;
  const targetLines = normalizedLines(input.target.bodyText).length;
  return Object.freeze({
    schemaVersion: ARTICLE_LINEAGE_REVIEW_INPUT_SCHEMA_VERSION,
    candidate: Object.freeze({
      id: input.candidate.id,
      lockVersion: input.candidate.lockVersion,
      inputSha256: input.candidate.inputSha256,
      proposedRelation: cleanBoundedText(input.candidate.proposedRelation, 80),
    }),
    source: Object.freeze({
      articleId: input.source.articleId,
      revisionId: input.source.revisionId,
      bodySha256: input.source.bodySha256,
      title: cleanBoundedText(input.source.title, 240),
      documentTitle: cleanBoundedText(input.source.documentTitle, 240),
      charCount: input.source.bodyText.length,
      lineCount: sourceLines,
    }),
    target: Object.freeze({
      articleId: input.target.articleId,
      revisionId: input.target.revisionId,
      bodySha256: input.target.bodySha256,
      title: cleanBoundedText(input.target.title, 240),
      documentTitle: cleanBoundedText(input.target.documentTitle, 240),
      charCount: input.target.bodyText.length,
      lineCount: targetLines,
    }),
    similaritySignals: sanitizeLineageSimilaritySignals(input.candidate.evidence),
    diffSummary: buildBoundedLineageDiffSummary(input.source.bodyText, input.target.bodyText),
  });
}

function boundedStringArray(value: unknown, field: string, maximumItems: number): readonly string[] {
  if (!Array.isArray(value) || value.length > maximumItems) {
    throw new ArticleLineageModelContractError("LINEAGE_REVIEW_OUTPUT_INVALID", `${field} 不符合严格输出合同`, 502);
  }
  const result = value.map((item) => {
    if (typeof item !== "string" || item.trim().length < 1 || item.length > 400) {
      throw new ArticleLineageModelContractError("LINEAGE_REVIEW_OUTPUT_INVALID", `${field} 含有无效条目`, 502);
    }
    return item.trim();
  });
  return Object.freeze(result);
}

export function parseArticleLineageReviewOutput(value: unknown): ArticleLineageReviewOutput {
  const object = asObject(value);
  if (!object || Object.keys(object).sort().join("\n") !== EXACT_OUTPUT_KEYS.join("\n")) {
    throw new ArticleLineageModelContractError(
      "LINEAGE_REVIEW_OUTPUT_INVALID",
      "模型输出字段不符合严格 JSON Schema",
      502,
    );
  }
  const relationRecommendation = object.relationRecommendation;
  const nextStep = object.nextStep;
  const confidence = object.confidence;
  if (!ARTICLE_LINEAGE_RELATION_RECOMMENDATIONS.includes(relationRecommendation as ArticleLineageRelationRecommendation)
    || !ARTICLE_LINEAGE_REVIEW_NEXT_STEPS.includes(nextStep as ArticleLineageReviewNextStep)
    || typeof confidence !== "number" || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw new ArticleLineageModelContractError(
      "LINEAGE_REVIEW_OUTPUT_INVALID",
      "模型输出枚举或置信度不符合严格 JSON Schema",
      502,
    );
  }
  const reasons = boundedStringArray(object.reasons, "reasons", 6);
  if (reasons.length < 1) {
    throw new ArticleLineageModelContractError("LINEAGE_REVIEW_OUTPUT_INVALID", "reasons 至少需要一项", 502);
  }
  return Object.freeze({
    relationRecommendation: relationRecommendation as ArticleLineageRelationRecommendation,
    confidence,
    reasons,
    differences: boundedStringArray(object.differences, "differences", 8),
    risks: boundedStringArray(object.risks, "risks", 6),
    nextStep: nextStep as ArticleLineageReviewNextStep,
  });
}

export function buildArticleLineageReviewMessages(input: ArticleLineageFrozenReviewInput) {
  const system = [
    "你是文章血缘证据审阅器，只提出候选建议，不拥有确认、合并、归档、发布或修改正文的权限。",
    "只能依据给定的冻结摘要推断；没有全文时必须明确风险，不得编造缺失内容。",
    "返回 JSON 必须严格符合 outputSchema，不能增加任何字段。",
  ].join("\n");
  const user = canonicalLineageJson({
    task: "review_article_lineage_candidate",
    frozenInput: input,
    outputSchema: ARTICLE_LINEAGE_REVIEW_JSON_SCHEMA,
  });
  return Object.freeze([
    Object.freeze({ role: "system" as const, content: system }),
    Object.freeze({ role: "user" as const, content: user }),
  ]);
}

export function estimateArticleLineageReviewInputTokens(input: ArticleLineageFrozenReviewInput): number {
  const encoder = new TextEncoder();
  return 128 + buildArticleLineageReviewMessages(input).reduce((total, message) => (
    total + 32 + encoder.encode(message.role).byteLength + encoder.encode(message.content).byteLength
  ), 0);
}

export function reserveArticleLineageReviewBudget(input: Readonly<{
  estimatedInputTokens: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  maxCostCnyMicros: number;
}>) {
  const policy = ARTICLE_LINEAGE_REVIEW_BUDGET_POLICY;
  for (const [field, value] of Object.entries(input)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new ArticleLineageModelContractError("LINEAGE_REVIEW_BUDGET_INVALID", `${field} 必须是正整数`);
    }
  }
  if (input.maxInputTokens > policy.maximumInputTokens
    || input.maxOutputTokens < policy.minimumOutputTokens
    || input.maxOutputTokens > policy.maximumOutputTokens
    || input.maxCostCnyMicros > policy.maximumCostCnyMicros) {
    throw new ArticleLineageModelContractError("LINEAGE_REVIEW_BUDGET_INVALID", "显式预算超过本地安全上限");
  }
  if (input.estimatedInputTokens > input.maxInputTokens) {
    throw new ArticleLineageModelContractError(
      "LINEAGE_REVIEW_INPUT_BUDGET_EXCEEDED",
      "冻结输入超过显式 maxInputTokens",
      409,
      { estimatedInputTokens: input.estimatedInputTokens, maxInputTokens: input.maxInputTokens },
    );
  }
  const reservedCostCnyMicros = input.maxInputTokens * policy.inputCnyMicrosPerTokenCeiling
    + input.maxOutputTokens * policy.outputCnyMicrosPerTokenCeiling;
  if (!Number.isSafeInteger(reservedCostCnyMicros) || reservedCostCnyMicros > input.maxCostCnyMicros) {
    throw new ArticleLineageModelContractError(
      "LINEAGE_REVIEW_COST_BUDGET_EXCEEDED",
      "冻结 Token 预算按本地费用上限折算后超过显式 maxCostCnyMicros",
      409,
      { reservedCostCnyMicros, maxCostCnyMicros: input.maxCostCnyMicros },
    );
  }
  return Object.freeze({
    policyVersion: policy.policyVersion,
    estimatedInputTokens: input.estimatedInputTokens,
    maxInputTokens: input.maxInputTokens,
    maxOutputTokens: input.maxOutputTokens,
    maxCostCnyMicros: input.maxCostCnyMicros,
    reservedCostCnyMicros,
    inputCnyMicrosPerTokenCeiling: policy.inputCnyMicrosPerTokenCeiling,
    outputCnyMicrosPerTokenCeiling: policy.outputCnyMicrosPerTokenCeiling,
    actualProviderCostKnown: false,
    automaticRetry: false,
  });
}
