import { env } from "cloudflare:workers";
import {
  ARTICLE_LINEAGE_AI_MANIFEST,
  ARTICLE_LINEAGE_REVIEW_BUDGET_POLICY,
  ARTICLE_LINEAGE_REVIEW_JSON_SCHEMA,
  ARTICLE_LINEAGE_REVIEW_OUTPUT_SCHEMA_VERSION,
  ARTICLE_LINEAGE_REVIEW_PROMPT_VERSION,
  ARTICLE_LINEAGE_REVIEW_RUNTIME_DDL,
  ArticleLineageModelContractError,
  buildArticleLineageReviewMessages,
  canonicalLineageJson,
  estimateArticleLineageReviewInputTokens,
  freezeArticleLineageReviewInput,
  parseArticleLineageReviewOutput,
  reserveArticleLineageReviewBudget,
  sha256LineageJson,
  type ArticleLineageCandidateSnapshot,
  type ArticleLineageFrozenReviewInput,
  type ArticleLineageRevisionSnapshot,
} from "../../../article-lineage-model";
import { ManagementAuthError } from "../../../management-auth-core";
import { managementActorId, requireManagementSession } from "../../../management-auth";
import {
  blockModelInvocationOutput,
  checkpointModelInvocationOutput,
  markModelInvocationOutputMaterialized,
  ModelInvocationCheckpointError,
} from "../../../model-invocation-checkpoint";
import {
  MODEL_GATEWAY_ADAPTER_VERSION,
  ModelGatewayError,
  getModelGatewayProviderStatus,
  requestModelGatewayJson,
  toModelGatewaySafeError,
  type ModelGatewayServerEnv,
} from "../../../model-gateway";

export const runtime = "edge";

type D1Row = Record<string, string | number | null>;
type JsonObject = Record<string, unknown>;
type MutationResult = { status?: number; data: JsonObject };

const MAX_REQUEST_BYTES = 512_000;
const MAX_REVIEWS = 200;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u;
const SHA256_RE = /^[a-f0-9]{64}$/u;
const ACTIONS = new Set(["prepare_review", "run_review"]);
const VIEWS = new Set(["manifest", "status", "reviews"]);

class ArticleLineageAiApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: JsonObject;

  constructor(code: string, message: string, status = 400, details?: JsonObject) {
    super(message);
    this.name = "ArticleLineageAiApiError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function requestId() {
  return `req-${crypto.randomUUID()}`;
}

function isoNow() {
  return new Date().toISOString();
}

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function cleanText(value: unknown, maximum = 240) {
  return typeof value === "string" ? value.trim().replace(/\s+/gu, " ").slice(0, maximum) : "";
}

function requiredText(value: unknown, field: string, maximum = 240) {
  const result = cleanText(value, maximum + 1);
  if (!result) throw new ArticleLineageAiApiError("MISSING_FIELD", `缺少 ${field}`, 400, { field });
  if (result.length > maximum) {
    throw new ArticleLineageAiApiError("FIELD_TOO_LARGE", `${field} 超过长度限制`, 413, { field, maximum });
  }
  return result;
}

function requiredId(value: unknown, field: string) {
  const result = requiredText(value, field, 200);
  if (!ID_RE.test(result)) throw new ArticleLineageAiApiError("INVALID_ID", `${field} 格式无效`, 400, { field });
  return result;
}

function requiredSha(value: unknown, field: string) {
  const result = requiredText(value, field, 64).toLowerCase();
  if (!SHA256_RE.test(result)) {
    throw new ArticleLineageAiApiError("INVALID_SHA256", `${field} 必须是 64 位小写 SHA-256`, 400, { field });
  }
  return result;
}

function requiredInteger(value: unknown, field: string, minimum: number, maximum: number) {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new ArticleLineageAiApiError("INVALID_INTEGER", `${field} 必须在 ${minimum} 到 ${maximum} 之间`, 400, {
      field,
      minimum,
      maximum,
    });
  }
  return Number(value);
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string") return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function database() {
  if (!env.DB) throw new ArticleLineageAiApiError("DB_UNAVAILABLE", "文章血缘审阅数据库尚未连接", 503);
  return env.DB;
}

function runtimeEnv(): ModelGatewayServerEnv {
  return {
    DEEPSEEK_API_KEY: (env as unknown as Record<string, unknown>).DEEPSEEK_API_KEY,
    DEEPSEEK_MODEL: (env as unknown as Record<string, unknown>).DEEPSEEK_MODEL,
  };
}

function normalizeError(error: unknown): ArticleLineageAiApiError {
  if (error instanceof ArticleLineageAiApiError) return error;
  if (error instanceof ArticleLineageModelContractError) {
    return new ArticleLineageAiApiError(error.code, error.message, error.status, error.details);
  }
  if (error instanceof ModelInvocationCheckpointError) {
    return new ArticleLineageAiApiError(
      "LINEAGE_REVIEW_RESPONSE_PERSISTENCE_UNKNOWN",
      "Provider 已返回，但本地 checkpoint/物化状态未知；禁止自动重试",
      500,
      { checkpointCode: error.code, outcomeUnknown: true, automaticRetry: false },
    );
  }
  if (error instanceof ModelGatewayError) {
    const safe = toModelGatewaySafeError(error);
    return new ArticleLineageAiApiError(safe.code, safe.message, safe.status, {
      provider: safe.provider ?? "deepseek",
      retryable: false,
      automaticRetry: false,
      ...(safe.upstreamStatus ? { upstreamStatus: safe.upstreamStatus } : {}),
    });
  }
  return new ArticleLineageAiApiError("INTERNAL_ERROR", "文章血缘候选审阅处理失败", 500);
}

function jsonSuccess(id: string, data: JsonObject, status = 200) {
  return Response.json({ ok: true, requestId: id, data }, {
    status,
    headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" },
  });
}

function jsonError(id: string, error: unknown) {
  if (error instanceof ManagementAuthError) {
    return Response.json({ ok: false, requestId: id, error: { code: error.code, message: error.message } }, {
      status: error.status,
      headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" },
    });
  }
  const normalized = normalizeError(error);
  return Response.json({
    ok: false,
    requestId: id,
    error: {
      code: normalized.code,
      message: normalized.message,
      ...(normalized.details ? { details: normalized.details } : {}),
    },
  }, {
    status: normalized.status,
    headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" },
  });
}

let schemaBootstrap: Promise<void> | null = null;

async function ensureRuntimeSchema() {
  const db = database();
  if (!schemaBootstrap) {
    schemaBootstrap = db.batch(ARTICLE_LINEAGE_REVIEW_RUNTIME_DDL.map((statement) => db.prepare(statement)))
      .then(() => undefined)
      .catch((error) => {
        schemaBootstrap = null;
        throw error;
      });
  }
  await schemaBootstrap;
  return db;
}

async function lineageInvocationSchemaReady(db: D1Database) {
  const row = await db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='model_invocations' LIMIT 1")
    .first<D1Row>();
  const sql = typeof row?.sql === "string" ? row.sql.toLowerCase() : "";
  return sql.includes("lineage_review")
    && sql.includes("lineage_candidate_id")
    && sql.includes("lineage_preparation_id");
}

async function parseMutationBody(request: Request) {
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > MAX_REQUEST_BYTES) {
    throw new ArticleLineageAiApiError("REQUEST_TOO_LARGE", "文章血缘审阅请求过大", 413);
  }
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    throw new ArticleLineageAiApiError("INVALID_JSON", "请求正文不是有效 JSON");
  }
  if (!isObject(body)) throw new ArticleLineageAiApiError("INVALID_JSON", "请求正文必须是 JSON 对象");
  const action = requiredText(body.action, "action", 80);
  if (!ACTIONS.has(action)) throw new ArticleLineageAiApiError("UNKNOWN_ACTION", `未知血缘审阅动作：${action}`, 404);
  const commandId = requiredId(body.commandId, "commandId");
  if (!isObject(body.payload)) throw new ArticleLineageAiApiError("INVALID_PAYLOAD", "payload 必须是 JSON 对象");
  return { action, commandId, payload: body.payload };
}

async function inspectReceipt(
  db: D1Database,
  commandId: string,
  commandType: string,
  actorId: string,
  requestSha256: string,
) {
  const row = await db.prepare("SELECT * FROM command_receipts WHERE id=? LIMIT 1").bind(commandId).first<D1Row>();
  if (!row) return null;
  if (row.command_type !== commandType || row.actor_id !== actorId || row.request_sha256 !== requestSha256) {
    throw new ArticleLineageAiApiError("COMMAND_ID_REUSED", "同一 commandId 已绑定不同动作、身份或请求摘要", 409);
  }
  if (Number(row.status_code) === 0) {
    throw new ArticleLineageAiApiError(
      "COMMAND_IN_PROGRESS",
      "同一命令仍在处理或需要人工恢复审计；禁止自动重发付费请求",
      409,
      { automaticRetry: false },
    );
  }
  const saved = parseJson<{ data?: JsonObject; error?: { code?: string; message?: string; details?: JsonObject } }>(
    row.response_json,
    {},
  );
  if (Number(row.status_code) >= 400) {
    throw new ArticleLineageAiApiError(
      cleanText(saved.error?.code, 120) || "COMMAND_FAILED",
      cleanText(saved.error?.message, 2_000) || "该幂等命令此前已经失败",
      Number(row.status_code),
      saved.error?.details,
    );
  }
  return { status: Number(row.status_code), data: saved.data ?? {} };
}

async function withReceipt(
  db: D1Database,
  action: string,
  actorId: string,
  commandId: string,
  payload: JsonObject,
  handler: (requestSha256: string) => Promise<MutationResult>,
) {
  const commandType = `article_lineage_ai.v1.${action}`;
  const requestSha256 = await sha256LineageJson({ action, actorId, payload });
  const replay = await inspectReceipt(db, commandId, commandType, actorId, requestSha256);
  if (replay) return replay;
  try {
    await db.prepare(`INSERT INTO command_receipts
      (id, command_type, actor_id, request_sha256, response_json, status_code)
      VALUES (?, ?, ?, ?, '{}', 0)`).bind(commandId, commandType, actorId, requestSha256).run();
  } catch {
    const raced = await inspectReceipt(db, commandId, commandType, actorId, requestSha256);
    if (raced) return raced;
    throw new ArticleLineageAiApiError("COMMAND_IN_PROGRESS", "命令领取发生竞争，请人工检查后再决定", 409, {
      automaticRetry: false,
    });
  }
  try {
    const result = await handler(requestSha256);
    const status = result.status ?? 200;
    await db.prepare(`UPDATE command_receipts SET response_json=?, status_code=?, completed_at=?
      WHERE id=? AND command_type=? AND actor_id=? AND request_sha256=? AND status_code=0`)
      .bind(canonicalLineageJson({ data: result.data }), status, isoNow(), commandId, commandType, actorId, requestSha256)
      .run();
    return { status, data: result.data };
  } catch (error) {
    const failure = normalizeError(error);
    await db.prepare(`UPDATE command_receipts SET response_json=?, status_code=?, completed_at=?
      WHERE id=? AND command_type=? AND actor_id=? AND request_sha256=? AND status_code=0`)
      .bind(canonicalLineageJson({
        error: { code: failure.code, message: failure.message, details: failure.details },
      }), failure.status, isoNow(), commandId, commandType, actorId, requestSha256).run();
    throw failure;
  }
}

function rowText(row: D1Row, key: string) {
  return typeof row[key] === "string" ? String(row[key]) : "";
}

function candidateSnapshot(row: D1Row): ArticleLineageCandidateSnapshot {
  return {
    id: rowText(row, "id"),
    status: rowText(row, "status"),
    lockVersion: Number(row.lock_version),
    inputSha256: rowText(row, "input_sha256"),
    proposedRelation: rowText(row, "relation_type"),
    sourceArticleId: rowText(row, "source_article_id"),
    sourceRevisionId: rowText(row, "source_revision_id"),
    sourceBodySha256: rowText(row, "source_body_sha256"),
    targetArticleId: rowText(row, "target_article_id"),
    targetRevisionId: rowText(row, "target_revision_id"),
    targetBodySha256: rowText(row, "target_body_sha256"),
    evidence: parseJson(row.evidence_json, []),
  };
}

function revisionSnapshot(row: D1Row): ArticleLineageRevisionSnapshot {
  return {
    articleId: rowText(row, "article_id"),
    revisionId: rowText(row, "id"),
    bodySha256: rowText(row, "body_sha256"),
    title: rowText(row, "title"),
    documentTitle: rowText(row, "document_title"),
    bodyText: rowText(row, "body_text"),
  };
}

async function loadFrozenReviewInput(db: D1Database, candidateId: string, expectedLockVersion: number) {
  const candidateRow = await db.prepare("SELECT * FROM article_lineage_links WHERE id=? LIMIT 1")
    .bind(candidateId).first<D1Row>();
  if (!candidateRow) throw new ArticleLineageAiApiError("LINEAGE_CANDIDATE_NOT_FOUND", "没有找到血缘候选", 404, { candidateId });
  if (candidateRow.status !== "candidate" || Number(candidateRow.lock_version) !== expectedLockVersion) {
    throw new ArticleLineageAiApiError("LINEAGE_CANDIDATE_CHANGED", "血缘候选状态或 lockVersion 已变化", 409, {
      candidateId,
      currentStatus: candidateRow.status,
      currentLockVersion: Number(candidateRow.lock_version),
    });
  }
  const candidate = candidateSnapshot(candidateRow);
  if (!candidate.sourceRevisionId || !candidate.targetRevisionId) {
    throw new ArticleLineageAiApiError("LINEAGE_CANDIDATE_REVISIONS_MISSING", "候选没有绑定两端不可变 revision", 409);
  }
  const rows = await db.batch([
    db.prepare("SELECT * FROM article_revisions WHERE id=? LIMIT 1").bind(candidate.sourceRevisionId),
    db.prepare("SELECT * FROM article_revisions WHERE id=? LIMIT 1").bind(candidate.targetRevisionId),
  ]);
  const sourceRow = rows[0].results?.[0] as D1Row | undefined;
  const targetRow = rows[1].results?.[0] as D1Row | undefined;
  if (!sourceRow || !targetRow) {
    throw new ArticleLineageAiApiError("LINEAGE_CANDIDATE_REVISIONS_MISSING", "候选绑定的 revision 不完整", 409);
  }
  return freezeArticleLineageReviewInput({
    candidate,
    source: revisionSnapshot(sourceRow),
    target: revisionSnapshot(targetRow),
  });
}

async function prepareReview(db: D1Database, payload: JsonObject, actorId: string) {
  const candidateId = requiredId(payload.candidateId, "candidateId");
  const expectedCandidateLockVersion = requiredInteger(
    payload.expectedCandidateLockVersion,
    "expectedCandidateLockVersion",
    1,
    1_000_000_000,
  );
  const frozenInput = await loadFrozenReviewInput(db, candidateId, expectedCandidateLockVersion);
  const inputSha = await sha256LineageJson(frozenInput);
  const inputTokenEstimate = estimateArticleLineageReviewInputTokens(frozenInput);
  if (inputTokenEstimate > ARTICLE_LINEAGE_REVIEW_BUDGET_POLICY.maximumInputTokens) {
    throw new ArticleLineageAiApiError("LINEAGE_REVIEW_INPUT_TOO_LARGE", "冻结摘要超过审阅输入硬上限", 413, {
      inputTokenEstimate,
      maximumInputTokens: ARTICLE_LINEAGE_REVIEW_BUDGET_POLICY.maximumInputTokens,
    });
  }
  const recommendedMaxOutputTokens = ARTICLE_LINEAGE_REVIEW_BUDGET_POLICY.recommendedOutputTokens;
  const recommendedMaxCostCnyMicros = inputTokenEstimate
    * ARTICLE_LINEAGE_REVIEW_BUDGET_POLICY.inputCnyMicrosPerTokenCeiling
    + recommendedMaxOutputTokens * ARTICLE_LINEAGE_REVIEW_BUDGET_POLICY.outputCnyMicrosPerTokenCeiling;
  const budgetEstimate = reserveArticleLineageReviewBudget({
    estimatedInputTokens: inputTokenEstimate,
    maxInputTokens: inputTokenEstimate,
    maxOutputTokens: recommendedMaxOutputTokens,
    maxCostCnyMicros: recommendedMaxCostCnyMicros,
  });
  const preparationId = `lineage-review-preparation-${inputSha}`;
  const now = isoNow();
  await db.prepare(`INSERT INTO article_lineage_review_preparations
    (id, candidate_id, candidate_lock_version, candidate_input_sha256,
     source_revision_id, source_body_sha256, target_revision_id, target_body_sha256,
     frozen_input_json, input_sha256, input_token_estimate, budget_estimate_json,
     state, lock_version, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'prepared', 1, ?, ?, ?)
    ON CONFLICT(candidate_id, input_sha256) DO NOTHING`)
    .bind(preparationId, candidateId, expectedCandidateLockVersion, frozenInput.candidate.inputSha256,
      frozenInput.source.revisionId, frozenInput.source.bodySha256,
      frozenInput.target.revisionId, frozenInput.target.bodySha256,
      canonicalLineageJson(frozenInput), inputSha, inputTokenEstimate,
      canonicalLineageJson(budgetEstimate), actorId, now, now).run();
  const saved = await db.prepare(`SELECT id, state, lock_version FROM article_lineage_review_preparations
    WHERE candidate_id=? AND input_sha256=? LIMIT 1`).bind(candidateId, inputSha).first<D1Row>();
  if (!saved) throw new ArticleLineageAiApiError("LINEAGE_REVIEW_PREPARATION_NOT_WRITTEN", "冻结审阅输入未能持久化", 500);
  return {
    status: 201,
    data: {
      preparationId: String(saved.id),
      candidateId,
      expectedCandidateLockVersion,
      inputSha,
      inputTokenEstimate,
      budgetEstimate,
      frozenInput,
      state: saved.state,
      lockVersion: Number(saved.lock_version),
      paidEgressPerformed: false,
      candidateOnly: true,
    },
  };
}

async function assertRunStillAllowed(
  db: D1Database,
  preparation: D1Row,
  expectedCandidateLockVersion: number,
  inputSha: string,
) {
  const row = await db.prepare(`SELECT candidate.status candidate_status, candidate.lock_version candidate_lock_version,
      candidate.input_sha256 candidate_input_sha256, candidate.source_revision_id, candidate.source_body_sha256,
      candidate.target_revision_id, candidate.target_body_sha256,
      source.body_sha256 current_source_body_sha256, target.body_sha256 current_target_body_sha256,
      prep.state preparation_state, prep.lock_version preparation_lock_version
    FROM article_lineage_review_preparations prep
    JOIN article_lineage_links candidate ON candidate.id=prep.candidate_id
    LEFT JOIN article_revisions source ON source.id=prep.source_revision_id
    LEFT JOIN article_revisions target ON target.id=prep.target_revision_id
    WHERE prep.id=? AND prep.input_sha256=? LIMIT 1`)
    .bind(preparation.id, inputSha).first<D1Row>();
  const conflicts = [
    !row ? "PREPARATION_NOT_FOUND" : null,
    row && row.candidate_status !== "candidate" ? "CANDIDATE_DECIDED" : null,
    row && Number(row.candidate_lock_version) !== expectedCandidateLockVersion ? "CANDIDATE_LOCK_CHANGED" : null,
    row && row.candidate_input_sha256 !== preparation.candidate_input_sha256 ? "CANDIDATE_INPUT_CHANGED" : null,
    row && row.source_revision_id !== preparation.source_revision_id ? "SOURCE_REVISION_CHANGED" : null,
    row && row.target_revision_id !== preparation.target_revision_id ? "TARGET_REVISION_CHANGED" : null,
    row && row.source_body_sha256 !== preparation.source_body_sha256 ? "SOURCE_SHA_BINDING_CHANGED" : null,
    row && row.target_body_sha256 !== preparation.target_body_sha256 ? "TARGET_SHA_BINDING_CHANGED" : null,
    row && row.current_source_body_sha256 !== preparation.source_body_sha256 ? "SOURCE_REVISION_MISSING" : null,
    row && row.current_target_body_sha256 !== preparation.target_body_sha256 ? "TARGET_REVISION_MISSING" : null,
    row && row.preparation_state !== "prepared" ? "PREPARATION_ALREADY_CONSUMED" : null,
  ].filter((item): item is string => item !== null);
  if (conflicts.length > 0) {
    throw new ArticleLineageAiApiError(
      "LINEAGE_REVIEW_EGRESS_GUARD_REJECTED",
      "候选、revision 或冻结准备已变化，拒绝模型出网或物化",
      409,
      { conflicts, automaticRetry: false },
    );
  }
}

async function markInvocationBlocked(db: D1Database, invocationId: string, code: string, message: string) {
  const now = isoNow();
  await db.prepare(`UPDATE model_invocations SET state='inconclusive', error_class=?, error_summary=?,
    finished_at=COALESCE(finished_at, ?) WHERE id=? AND state IN ('running','succeeded')`)
    .bind(code, message.slice(0, 512), now, invocationId).run();
  await blockModelInvocationOutput(db, {
    invocationId,
    errorClass: code,
    errorSummary: message,
    now,
  });
}

async function runReview(
  db: D1Database,
  payload: JsonObject,
  actorId: string,
  commandId: string,
  receiptRequestSha256: string,
) {
  const candidateId = requiredId(payload.candidateId, "candidateId");
  const expectedCandidateLockVersion = requiredInteger(
    payload.expectedCandidateLockVersion,
    "expectedCandidateLockVersion",
    1,
    1_000_000_000,
  );
  const inputSha = requiredSha(payload.inputSha, "inputSha");
  const maxInputTokens = requiredInteger(
    payload.maxInputTokens,
    "maxInputTokens",
    1,
    ARTICLE_LINEAGE_REVIEW_BUDGET_POLICY.maximumInputTokens,
  );
  const maxOutputTokens = requiredInteger(
    payload.maxOutputTokens,
    "maxOutputTokens",
    ARTICLE_LINEAGE_REVIEW_BUDGET_POLICY.minimumOutputTokens,
    ARTICLE_LINEAGE_REVIEW_BUDGET_POLICY.maximumOutputTokens,
  );
  const maxCostCnyMicros = requiredInteger(
    payload.maxCostCnyMicros,
    "maxCostCnyMicros",
    1,
    ARTICLE_LINEAGE_REVIEW_BUDGET_POLICY.maximumCostCnyMicros,
  );
  if (!(await lineageInvocationSchemaReady(db))) {
    throw new ArticleLineageAiApiError(
      "LINEAGE_REVIEW_SCHEMA_UPGRADE_REQUIRED",
      "0017 模型调用血缘扩展尚未安装；prepare 可用，付费 run 已关闭",
      503,
      { requiredMigration: "0017_amazing_annihilus", paidEgressPerformed: false },
    );
  }
  const preparation = await db.prepare(`SELECT * FROM article_lineage_review_preparations
    WHERE candidate_id=? AND input_sha256=? LIMIT 1`).bind(candidateId, inputSha).first<D1Row>();
  if (!preparation) {
    throw new ArticleLineageAiApiError("LINEAGE_REVIEW_PREPARATION_NOT_FOUND", "没有找到匹配 inputSha 的冻结准备", 404);
  }
  if (Number(preparation.candidate_lock_version) !== expectedCandidateLockVersion) {
    throw new ArticleLineageAiApiError("LINEAGE_CANDIDATE_CHANGED", "冻结准备的 candidate lockVersion 不匹配", 409);
  }
  const existingReview = await db.prepare("SELECT id FROM article_lineage_model_reviews WHERE preparation_id=? LIMIT 1")
    .bind(preparation.id).first<D1Row>();
  if (existingReview) {
    throw new ArticleLineageAiApiError("LINEAGE_REVIEW_ALREADY_EXISTS", "该冻结输入已有候选审阅，本次未调用模型。现有 review 已保留；请打开返回的 reviewId 查看，不要重复付费运行。", 409, {
      reviewId: existingReview.id,
      automaticRetry: false,
    });
  }
  const frozenInput = parseJson<ArticleLineageFrozenReviewInput>(preparation.frozen_input_json, null as never);
  if (!frozenInput || await sha256LineageJson(frozenInput) !== inputSha) {
    throw new ArticleLineageAiApiError("LINEAGE_REVIEW_INPUT_DIGEST_CONFLICT", "冻结输入摘要与持久化内容不一致", 409);
  }
  const inputTokenEstimate = estimateArticleLineageReviewInputTokens(frozenInput);
  if (inputTokenEstimate !== Number(preparation.input_token_estimate)) {
    throw new ArticleLineageAiApiError("LINEAGE_REVIEW_INPUT_ESTIMATE_DRIFT", "冻结输入 Token 估算版本发生漂移", 409);
  }
  const budgetReservation = reserveArticleLineageReviewBudget({
    estimatedInputTokens: inputTokenEstimate,
    maxInputTokens,
    maxOutputTokens,
    maxCostCnyMicros,
  });
  await assertRunStillAllowed(db, preparation, expectedCandidateLockVersion, inputSha);

  const providerStatus = getModelGatewayProviderStatus("deepseek", runtimeEnv());
  if (!providerStatus.ready) {
    throw new ArticleLineageAiApiError("MODEL_PROVIDER_NOT_CONFIGURED", "DeepSeek 尚未就绪，本次未出网也未产生费用；候选与冻结准备仍保留。完成服务端配置后先刷新状态，只有 inputSha 和 lockVersion 仍一致时才可沿用原准备。", 503, {
      provider: "deepseek",
      configured: providerStatus.configured,
      paidEgressPerformed: false,
    });
  }
  const messages = buildArticleLineageReviewMessages(frozenInput);
  const providerPolicy = {
    provider: "deepseek",
    model: providerStatus.model,
    adapterVersion: MODEL_GATEWAY_ADAPTER_VERSION,
    promptVersion: ARTICLE_LINEAGE_REVIEW_PROMPT_VERSION,
    outputSchema: ARTICLE_LINEAGE_REVIEW_JSON_SCHEMA,
    candidateOnly: true,
    automaticRetry: false,
    budgetReservation,
  };
  const providerPolicySha256 = await sha256LineageJson(providerPolicy);
  const requestSha256 = await sha256LineageJson({
    provider: "deepseek",
    model: providerStatus.model,
    adapterVersion: MODEL_GATEWAY_ADAPTER_VERSION,
    messages,
    responseFormat: "json_object",
    sampling: { temperature: 0, topP: 1 },
    maxOutputTokens,
  });
  const egressManifestSha256 = await sha256LineageJson({
    candidateId,
    preparationId: preparation.id,
    expectedCandidateLockVersion,
    inputSha,
    fields: ["candidate", "revision_sha", "titles", "similarity_signals", "bounded_diff_summary"],
    fullBodiesIncluded: false,
  });
  const egressApprovalSha256 = await sha256LineageJson({
    commandId,
    receiptRequestSha256,
    maxInputTokens,
    maxOutputTokens,
    maxCostCnyMicros,
    automaticRetry: false,
  });
  const invocationId = `model-invocation-${crypto.randomUUID()}`;
  const invocationCommandId = `lineage-review:${commandId}`;
  const startedAt = isoNow();
  const reservationJson = canonicalLineageJson(budgetReservation);
  const reservationSha256 = await sha256LineageJson(budgetReservation);
  await db.prepare(`INSERT INTO model_invocations
    (id, experiment_id, lineage_candidate_id, lineage_preparation_id, command_id,
     purpose, role, provider, model_id, adapter_version, prompt_version_id,
     provider_policy_sha256, egress_manifest_sha256, egress_approval_sha256,
     request_sha256, input_sha256, response_sha256, output_ref, state, attempt,
     budget_reservation_json, budget_reservation_sha256, usage_json,
     estimated_cost_cny_micros, created_at, started_at)
    VALUES (?, NULL, ?, ?, ?, 'lineage_review', 'reviewer', 'deepseek', ?, ?, ?, ?, ?, ?, ?, ?,
      NULL, '', 'running', 1, ?, ?, '{}', ?, ?, ?)`)
    .bind(invocationId, candidateId, preparation.id, invocationCommandId,
      providerStatus.model, MODEL_GATEWAY_ADAPTER_VERSION, ARTICLE_LINEAGE_REVIEW_PROMPT_VERSION,
      providerPolicySha256, egressManifestSha256, egressApprovalSha256,
      requestSha256, inputSha, reservationJson, reservationSha256,
      budgetReservation.reservedCostCnyMicros, startedAt, startedAt).run();
  try {
    await assertRunStillAllowed(db, preparation, expectedCandidateLockVersion, inputSha);
  } catch (error) {
    const failure = normalizeError(error);
    await db.prepare(`UPDATE model_invocations SET state='cancelled', error_class=?, error_summary=?, finished_at=?
      WHERE id=? AND state='running'`).bind(failure.code, failure.message, isoNow(), invocationId).run();
    throw failure;
  }

  const networkStarted = Date.now();
  let result;
  try {
    result = await requestModelGatewayJson({
      provider: "deepseek",
      env: runtimeEnv(),
      messages,
      maxOutputTokens,
      sampling: { temperature: 0, topP: 1 },
      timeoutMs: 120_000,
    });
  } catch (error) {
    const safe = toModelGatewaySafeError(error);
    await db.prepare(`UPDATE model_invocations SET state='failed', latency_ms=?, http_status=?,
      error_class=?, error_summary=?, finished_at=? WHERE id=? AND state='running'`)
      .bind(Math.max(0, Date.now() - networkStarted), safe.upstreamStatus ?? null,
        safe.code, safe.message, isoNow(), invocationId).run();
    throw new ArticleLineageAiApiError(safe.code, safe.message, safe.status, {
      provider: "deepseek",
      retryable: false,
      automaticRetry: false,
      ...(safe.upstreamStatus ? { upstreamStatus: safe.upstreamStatus } : {}),
    });
  }

  const rawResponseJson = canonicalLineageJson(result.value);
  const responseSha256 = await sha256LineageJson(result.value);
  const usageJson = canonicalLineageJson(result.usage ?? {});
  const usageSha256 = await sha256LineageJson(result.usage ?? {});
  const finishedAt = isoNow();
  try {
    // Paid provider output is durable before strict parsing or candidate materialization.
    await checkpointModelInvocationOutput(db, {
      invocationId,
      materializationKind: "review",
      responseJson: rawResponseJson,
      responseSha256,
      usageJson,
      usageSha256,
      now: finishedAt,
    });
    const updated = await db.prepare(`UPDATE model_invocations SET state='succeeded', response_sha256=?,
      usage_json=?, input_tokens=?, output_tokens=?, total_tokens=?, latency_ms=?, http_status=200,
      finish_reason=?, provider_request_id=?, finished_at=? WHERE id=? AND state='running'`)
      .bind(responseSha256, usageJson, result.usage?.inputTokens ?? null,
        result.usage?.outputTokens ?? null, result.usage?.totalTokens ?? null,
        Math.max(0, Date.now() - networkStarted), result.finishReason, result.requestId,
        finishedAt, invocationId).run();
    if (Number(updated.meta.changes ?? 0) !== 1) {
      throw new ModelInvocationCheckpointError(
        "CHECKPOINT_MATERIALIZATION_CONFLICT",
        "响应已 checkpoint，但 invocation 状态未能确认",
      );
    }
  } catch (error) {
    try {
      const checkpointCode = error instanceof ModelInvocationCheckpointError
        ? error.code : "PERSISTENCE_AFTER_SUCCESS_UNKNOWN";
      await db.prepare(`UPDATE model_invocations SET error_class=?, error_summary=?, finished_at=?
        WHERE id=?`).bind(checkpointCode,
        "Provider 已返回，但本地 checkpoint/调用状态未知；禁止自动重试", finishedAt, invocationId).run();
    } catch {
      // Preserve the original persistence uncertainty without another egress.
    }
    throw error;
  }

  try {
    await assertRunStillAllowed(db, preparation, expectedCandidateLockVersion, inputSha);
  } catch (error) {
    await markInvocationBlocked(db, invocationId, "LINEAGE_CANDIDATE_CHANGED_AFTER_EGRESS",
      "Provider 响应已 checkpoint，但候选或 revision 已变化；响应禁止物化");
    throw error;
  }
  if ((result.usage?.inputTokens ?? 0) > maxInputTokens || (result.usage?.outputTokens ?? 0) > maxOutputTokens) {
    await markInvocationBlocked(db, invocationId, "LINEAGE_REVIEW_REPORTED_USAGE_EXCEEDED",
      "Provider 报告的 Token 用量超过显式预算");
    throw new ArticleLineageAiApiError(
      "LINEAGE_REVIEW_REPORTED_USAGE_EXCEEDED",
      "Provider 响应已 checkpoint，但报告用量超过显式预算；响应禁止物化",
      409,
      { automaticRetry: false },
    );
  }
  let output;
  try {
    output = parseArticleLineageReviewOutput(result.value);
  } catch (error) {
    await markInvocationBlocked(db, invocationId, "LINEAGE_REVIEW_OUTPUT_INVALID",
      "Provider 响应已 checkpoint，但严格 JSON Schema 校验失败");
    throw error;
  }
  const reviewId = `lineage-review-${crypto.randomUUID()}`;
  const outputJson = canonicalLineageJson(output);
  const outputSha256 = await sha256LineageJson(output);
  const createdAt = isoNow();
  const materialization = await db.batch([
    db.prepare(`INSERT INTO article_lineage_model_reviews
      (id, preparation_id, candidate_id, candidate_lock_version, input_sha256, invocation_id,
       provider, model_id, output_schema_version, output_json, output_sha256,
       relation_recommendation, confidence_micros, candidate_only, state,
       max_input_tokens, max_output_tokens, max_cost_cny_micros, reserved_cost_cny_micros,
       usage_json, created_by, created_at)
      SELECT ?, ?, ?, ?, ?, ?, 'deepseek', ?, ?, ?, ?, ?, ?, 1, 'candidate', ?, ?, ?, ?, ?, ?, ?
      WHERE EXISTS(SELECT 1 FROM article_lineage_links
        WHERE id=? AND status='candidate' AND lock_version=? AND input_sha256=?)
      AND EXISTS(SELECT 1 FROM article_lineage_review_preparations
        WHERE id=? AND state='prepared' AND input_sha256=? AND candidate_lock_version=?)
      AND NOT EXISTS(SELECT 1 FROM article_lineage_model_reviews WHERE preparation_id=?)`)
      .bind(reviewId, preparation.id, candidateId, expectedCandidateLockVersion, inputSha, invocationId,
        result.model, ARTICLE_LINEAGE_REVIEW_OUTPUT_SCHEMA_VERSION, outputJson, outputSha256,
        output.relationRecommendation, Math.round(output.confidence * 1_000_000),
        maxInputTokens, maxOutputTokens, maxCostCnyMicros, budgetReservation.reservedCostCnyMicros,
        usageJson, actorId, createdAt,
        candidateId, expectedCandidateLockVersion, preparation.candidate_input_sha256,
        preparation.id, inputSha, expectedCandidateLockVersion, preparation.id),
    db.prepare(`UPDATE article_lineage_review_preparations SET state='consumed',
      lock_version=lock_version+1, updated_at=? WHERE id=? AND state='prepared'
      AND EXISTS(SELECT 1 FROM article_lineage_model_reviews WHERE id=? AND preparation_id=?)`)
      .bind(createdAt, preparation.id, reviewId, preparation.id),
  ]);
  if (Number(materialization[0].meta.changes ?? 0) !== 1 || Number(materialization[1].meta.changes ?? 0) !== 1) {
    await markInvocationBlocked(db, invocationId, "LINEAGE_REVIEW_MATERIALIZATION_CAS_FAILED",
      "响应已 checkpoint，但 candidate/preparation CAS 不再成立");
    throw new ArticleLineageAiApiError(
      "LINEAGE_REVIEW_MATERIALIZATION_CAS_FAILED",
      "Provider 响应已 checkpoint，但候选物化 CAS 失败",
      409,
      { automaticRetry: false },
    );
  }
  try {
    await markModelInvocationOutputMaterialized(db, { invocationId, materializationRef: reviewId, now: isoNow() });
    await db.prepare("UPDATE model_invocations SET output_ref=? WHERE id=? AND state='succeeded'")
      .bind(reviewId, invocationId).run();
  } catch (error) {
    throw normalizeError(error);
  }
  return {
    data: {
      reviewId,
      preparationId: preparation.id,
      candidateId,
      inputSha,
      invocationId,
      state: "candidate",
      candidateOnly: true,
      output,
      outputSha256,
      provider: "deepseek",
      model: result.model,
      usage: result.usage ?? {},
      budgetReservation,
      responseCheckpointed: true,
      articleMutated: false,
      identityDecisionMutated: false,
      automaticRetry: false,
    },
  };
}

function boundedLimit(url: URL, fallback = 50) {
  const value = Number(url.searchParams.get("limit") ?? fallback);
  if (!Number.isInteger(value) || value < 1 || value > MAX_REVIEWS) {
    throw new ArticleLineageAiApiError("INVALID_LIMIT", `limit 必须在 1 到 ${MAX_REVIEWS} 之间`);
  }
  return value;
}

async function manifestView(db: D1Database) {
  return {
    ...ARTICLE_LINEAGE_AI_MANIFEST,
    invocationSchemaReady: await lineageInvocationSchemaReady(db),
    requiredMigration: "0017_amazing_annihilus",
  };
}

async function statusView(db: D1Database) {
  const provider = getModelGatewayProviderStatus("deepseek", runtimeEnv());
  const invocationSchemaReady = await lineageInvocationSchemaReady(db);
  const counts = await db.batch([
    db.prepare("SELECT COUNT(*) count FROM article_lineage_review_preparations WHERE state='prepared'"),
    db.prepare("SELECT COUNT(*) count FROM article_lineage_model_reviews WHERE state='candidate'"),
    db.prepare("SELECT COUNT(*) count FROM model_invocation_outputs WHERE materialization_kind='review' AND materialization_state='checkpointed'"),
  ]);
  const countAt = (index: number) => Number((counts[index].results?.[0] as D1Row | undefined)?.count ?? 0);
  return {
    apiVersion: ARTICLE_LINEAGE_AI_MANIFEST.apiVersion,
    candidateOnly: true,
    requiredMigration: "0017_amazing_annihilus",
    invocationSchemaReady,
    schemaState: invocationSchemaReady ? "ready" : "upgrade_required",
    prepareReviewAvailable: true,
    runReviewAvailable: invocationSchemaReady && provider.ready,
    provider: {
      provider: provider.provider,
      configured: provider.configured,
      ready: provider.ready,
      model: provider.model,
      baseUrl: provider.baseUrl,
      ...(provider.error ? { error: provider.error } : {}),
    },
    counts: {
      prepared: countAt(0),
      candidateReviews: countAt(1),
      checkpointedAwaitingMaterialization: countAt(2),
    },
    paidNetworkProbePerformed: false,
  };
}

async function reviewsView(db: D1Database, url: URL) {
  const limit = boundedLimit(url);
  const candidateId = cleanText(url.searchParams.get("candidateId"), 200);
  if (candidateId && !ID_RE.test(candidateId)) throw new ArticleLineageAiApiError("INVALID_ID", "candidateId 格式无效");
  const query = candidateId
    ? db.prepare(`SELECT * FROM article_lineage_model_reviews WHERE candidate_id=?
        ORDER BY created_at DESC, id DESC LIMIT ?`).bind(candidateId, limit)
    : db.prepare("SELECT * FROM article_lineage_model_reviews ORDER BY created_at DESC, id DESC LIMIT ?").bind(limit);
  const rows = await query.all<D1Row>();
  const reviews = rows.results.map((row) => {
    try {
      const output = parseArticleLineageReviewOutput(parseJson(row.output_json, null));
      return {
        id: row.id,
        preparationId: row.preparation_id,
        candidateId: row.candidate_id,
        candidateLockVersion: Number(row.candidate_lock_version),
        inputSha: row.input_sha256,
        invocationId: row.invocation_id,
        provider: row.provider,
        model: row.model_id,
        state: row.state,
        candidateOnly: Boolean(row.candidate_only),
        output,
        outputSha256: row.output_sha256,
        usage: parseJson(row.usage_json, {}),
        budget: {
          maxInputTokens: Number(row.max_input_tokens),
          maxOutputTokens: Number(row.max_output_tokens),
          maxCostCnyMicros: Number(row.max_cost_cny_micros),
          reservedCostCnyMicros: Number(row.reserved_cost_cny_micros),
        },
        createdAt: row.created_at,
      };
    } catch {
      return {
        id: row.id,
        candidateId: row.candidate_id,
        state: "invalid_stored_output",
        candidateOnly: true,
        output: null,
        outputSha256: row.output_sha256,
        createdAt: row.created_at,
      };
    }
  });
  return { reviews, limit, candidateId: candidateId || null };
}

async function handleGet(db: D1Database, url: URL) {
  const view = cleanText(url.searchParams.get("view") ?? "manifest", 80);
  if (!VIEWS.has(view)) throw new ArticleLineageAiApiError("UNKNOWN_VIEW", `未知血缘审阅视图：${view}`, 404);
  if (view === "manifest") return manifestView(db);
  if (view === "status") return statusView(db);
  return reviewsView(db, url);
}

export async function GET(request: Request) {
  const id = requestId();
  try {
    await requireManagementSession(request, { scope: "management.read" });
    const db = await ensureRuntimeSchema();
    return jsonSuccess(id, await handleGet(db, new URL(request.url)) as JsonObject);
  } catch (error) {
    return jsonError(id, error);
  }
}

export async function POST(request: Request) {
  const id = requestId();
  try {
    const principal = await requireManagementSession(request, { mutation: true, scope: "identity.decide" });
    const { action, commandId, payload } = await parseMutationBody(request);
    const db = await ensureRuntimeSchema();
    const actorId = managementActorId(principal);
    const result = await withReceipt(db, action, actorId, commandId, payload, async (receiptRequestSha256) => {
      if (action === "prepare_review") return prepareReview(db, payload, actorId);
      if (action === "run_review") {
        return runReview(db, payload, actorId, commandId, receiptRequestSha256);
      }
      throw new ArticleLineageAiApiError("UNKNOWN_ACTION", `未知血缘审阅动作：${action}`, 404);
    });
    return jsonSuccess(id, result.data, result.status);
  } catch (error) {
    return jsonError(id, error);
  }
}
