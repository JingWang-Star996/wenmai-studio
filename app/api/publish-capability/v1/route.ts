import { env } from "cloudflare:workers";
import { LocalImportAuthError } from "../../../local-import-auth-core";
import { ManagementAuthError } from "../../../management-auth-core";
import { managementActorId, requireManagementSession } from "../../../management-auth";
import {
  PUBLISH_CAPABILITY_API_VERSION,
  canonicalPublishCommandRequest,
  publishCapabilityBindings,
  safePublishConsumptionResponse,
  validatePublishBatchConfirmation,
} from "../../../publish-capability-core";
import { authenticatePrivilegedAgent } from "../../../privileged-agent-auth";
import {
  ReleaseExecutionContractError,
  canonicalExecutionJson,
  issuePublishCapabilityTicket,
  sha256ExecutionText,
  validateFrozenExecutionPacket,
  verifyPublishCapabilityTicket,
  type FrozenExecutionPacket,
  type PublishCapabilityTicket,
} from "../../../release-execution-contract";

type D1Row = Record<string, string | number | null>;
type JsonObject = Record<string, unknown>;
type PublishAction = "issue" | "consume";

type PublishRuntimeBindings = {
  DB?: D1Database;
  WENMAI_PUBLISH_CAPABILITY_HMAC_KEY?: string;
};

const ROUTE_MARKER = "Wenmai Publish Capability Control Plane";
const MAX_BODY_BYTES = 512_000;
const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;
const CAPABILITY_ID_RE = /^publish-capability-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const HMAC_KEY_RE = /^[A-Za-z0-9_-]{43}$/u;

class PublishCapabilityApiError extends Error {
  code: string;
  status: number;
  details?: JsonObject;

  constructor(code: string, message: string, status = 400, details?: JsonObject) {
    super(message);
    this.name = "PublishCapabilityApiError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function requestId() {
  return `publish-capability-request-${crypto.randomUUID()}`;
}

function responseHeaders(replayed = false) {
  return {
    "cache-control": "private, no-store, max-age=0",
    "content-type": "application/json; charset=utf-8",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-wenmai-command-replayed": replayed ? "1" : "0",
  };
}

function jsonSuccess(id: string, data: JsonObject, status = 200, replayed = false) {
  return Response.json({ ok: true, requestId: id, data }, {
    status,
    headers: responseHeaders(replayed),
  });
}

function errorShape(error: unknown) {
  if (
    error instanceof PublishCapabilityApiError
    || error instanceof ManagementAuthError
    || error instanceof LocalImportAuthError
  ) {
    return {
      code: error.code,
      message: error.message,
      status: error.status,
      details: error.details,
    };
  }
  if (error instanceof ReleaseExecutionContractError) {
    return {
      code: "PUBLISH_CAPABILITY_CONTRACT_INVALID",
      message: "一次性发布票据未通过执行合同校验",
      status: 422,
      details: { errors: error.errors },
    };
  }
  return {
    code: "PUBLISH_CAPABILITY_INTERNAL_ERROR",
    message: "一次性发布票据服务处理失败",
    status: 500,
    details: undefined,
  };
}

function jsonError(id: string, error: unknown) {
  const normalized = errorShape(error);
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
    headers: responseHeaders(Boolean(normalized.details?.replayed)),
  });
}

function runtimeBindings() {
  const workerBindings = env as unknown as PublishRuntimeBindings;
  const processBindings = typeof process === "undefined" ? {} : process.env;
  const workerSecret = workerBindings.WENMAI_PUBLISH_CAPABILITY_HMAC_KEY;
  const processSecret = processBindings.WENMAI_PUBLISH_CAPABILITY_HMAC_KEY;
  return {
    db: workerBindings.DB,
    hmacSecret: typeof workerSecret === "string" && workerSecret
      ? workerSecret
      : typeof processSecret === "string" ? processSecret : "",
  };
}

function database() {
  const db = runtimeBindings().db;
  if (!db) throw new PublishCapabilityApiError("DB_UNAVAILABLE", "一次性发布票据数据库尚未连接", 503);
  return db;
}

function hmacSecret() {
  const secret = runtimeBindings().hmacSecret;
  if (!HMAC_KEY_RE.test(secret)) {
    throw new PublishCapabilityApiError(
      "PUBLISH_CAPABILITY_RUNTIME_UNAVAILABLE",
      "一次性发布票据运行密钥尚未初始化，请用文脉启动器重新启动",
      503,
    );
  }
  return secret;
}

function isRecord(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: JsonObject, expected: readonly string[], label: string) {
  const expectedSet = new Set(expected);
  for (const key of Object.keys(value)) {
    if (!expectedSet.has(key)) {
      throw new PublishCapabilityApiError("PUBLISH_REQUEST_INVALID", `${label} 包含未知字段：${key}`);
    }
  }
  for (const key of expected) {
    if (!(key in value)) {
      throw new PublishCapabilityApiError("PUBLISH_REQUEST_INVALID", `${label} 缺少字段：${key}`);
    }
  }
}

async function parseRequest(request: Request) {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    throw new PublishCapabilityApiError("CONTENT_TYPE_REQUIRED", "一次性发布票据接口只接受 application/json", 415);
  }
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    throw new PublishCapabilityApiError("REQUEST_TOO_LARGE", "一次性发布票据请求过大", 413);
  }
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength === 0) throw new PublishCapabilityApiError("REQUEST_BODY_REQUIRED", "请求正文不能为空");
  if (bytes.byteLength > MAX_BODY_BYTES) {
    throw new PublishCapabilityApiError("REQUEST_TOO_LARGE", "一次性发布票据请求过大", 413);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new PublishCapabilityApiError("REQUEST_JSON_INVALID", "请求正文不是有效 UTF-8 JSON");
  }
  if (!isRecord(parsed)) throw new PublishCapabilityApiError("PUBLISH_REQUEST_INVALID", "请求正文必须是 JSON 对象");
  exactKeys(parsed, ["action", "commandId", "payload"], "请求");
  if (parsed.action !== "issue" && parsed.action !== "consume") {
    throw new PublishCapabilityApiError("PUBLISH_ACTION_INVALID", "action 只能是 issue 或 consume");
  }
  if (typeof parsed.commandId !== "string" || !SAFE_ID_RE.test(parsed.commandId)) {
    throw new PublishCapabilityApiError("PUBLISH_COMMAND_ID_INVALID", "commandId 格式无效");
  }
  if (!isRecord(parsed.payload)) throw new PublishCapabilityApiError("PUBLISH_PAYLOAD_INVALID", "payload 必须是 JSON 对象");
  return {
    action: parsed.action as PublishAction,
    commandId: parsed.commandId,
    payload: parsed.payload,
  };
}

async function ensurePublishCapabilitySchema(db: D1Database) {
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS publish_capability_receipts (
      command_id TEXT PRIMARY KEY NOT NULL,
      command_type TEXT NOT NULL CHECK (command_type IN ('publish-capability.issue','publish-capability.consume')),
      actor_id TEXT NOT NULL,
      request_sha256 TEXT NOT NULL,
      response_json TEXT NOT NULL DEFAULT '{}',
      status_code INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      completed_at TEXT
    )`),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_publish_capability_receipts_actor_created ON publish_capability_receipts(actor_id, created_at)"),
    db.prepare(`CREATE TABLE IF NOT EXISTS publish_capabilities (
      id TEXT PRIMARY KEY NOT NULL,
      schema_version TEXT NOT NULL,
      issue_command_id TEXT NOT NULL UNIQUE,
      issue_request_sha256 TEXT NOT NULL,
      execution_packet_sha256 TEXT NOT NULL UNIQUE,
      nonce_sha256 TEXT NOT NULL UNIQUE,
      ticket_sha256 TEXT NOT NULL,
      packet_json_sha256 TEXT NOT NULL,
      confirmation_sha256 TEXT NOT NULL,
      packet_json TEXT NOT NULL,
      ticket_json TEXT NOT NULL,
      confirmation_json TEXT NOT NULL,
      run_id TEXT NOT NULL,
      article_id TEXT,
      attempt INTEGER NOT NULL,
      packet_command_id TEXT NOT NULL,
      contract_revision INTEGER NOT NULL,
      contract_sha256 TEXT NOT NULL,
      platform TEXT NOT NULL,
      release_id TEXT NOT NULL,
      build_id TEXT NOT NULL,
      artifact_sha256 TEXT NOT NULL,
      target_account TEXT NOT NULL,
      action TEXT NOT NULL CHECK (action = 'publish'),
      max_clicks INTEGER NOT NULL CHECK (max_clicks = 1),
      issuer_actor_id TEXT NOT NULL,
      issuer_principal_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'issued' CHECK (status IN ('issued','consumed')),
      issued_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      consumed_at TEXT,
      created_at TEXT NOT NULL
    )`),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_publish_capabilities_status_expiry ON publish_capabilities(status, expires_at)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_publish_capabilities_release ON publish_capabilities(run_id, platform, release_id, build_id)"),
    db.prepare(`CREATE TABLE IF NOT EXISTS publish_capability_consumptions (
      id TEXT PRIMARY KEY NOT NULL,
      capability_id TEXT NOT NULL UNIQUE,
      nonce_sha256 TEXT NOT NULL UNIQUE,
      consumer_actor_id TEXT NOT NULL,
      consumer_client_id TEXT NOT NULL,
      command_id TEXT NOT NULL UNIQUE,
      request_sha256 TEXT NOT NULL,
      consumed_at TEXT NOT NULL
    )`),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_publish_capability_consumptions_consumer ON publish_capability_consumptions(consumer_client_id, consumed_at)"),
  ]);
}

function parseStoredJson(value: unknown, label: string) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(value ?? ""));
  } catch {
    throw new PublishCapabilityApiError("PUBLISH_CAPABILITY_STORAGE_INVALID", `${label} 的服务端记录已损坏`, 409);
  }
  return parsed;
}

function withReplayFlag(value: JsonObject, replayed: boolean) {
  if (isRecord(value.receipt)) {
    return { ...value, receipt: { ...value.receipt, replayed } };
  }
  return { ...value, replayed };
}

function replayData(value: JsonObject) {
  return withReplayFlag(value, true);
}

function parseStoredResponse(value: unknown) {
  const parsed = parseStoredJson(value, "命令回执");
  if (!isRecord(parsed)) {
    throw new PublishCapabilityApiError("PUBLISH_RECEIPT_INVALID", "命令回执不是 JSON 对象", 503);
  }
  return parsed;
}

async function inspectCommandReceipt(
  db: D1Database,
  commandId: string,
  commandType: string,
  actorId: string,
  requestSha256: string,
) {
  const row = await db.prepare("SELECT * FROM publish_capability_receipts WHERE command_id = ? LIMIT 1")
    .bind(commandId).first<D1Row>();
  if (!row) return null;
  if (row.command_type !== commandType || row.actor_id !== actorId || row.request_sha256 !== requestSha256) {
    throw new PublishCapabilityApiError(
      "PUBLISH_COMMAND_ID_CONFLICT",
      "同一 commandId 已绑定另一动作、身份或请求摘要",
      409,
    );
  }
  const status = Number(row.status_code);
  if (status <= 0) return null;
  const response = parseStoredResponse(row.response_json);
  if (status >= 400) {
    const storedError = isRecord(response.error) ? response.error : {};
    throw new PublishCapabilityApiError(
      typeof storedError.code === "string" ? storedError.code : "PUBLISH_COMMAND_REJECTED",
      typeof storedError.message === "string" ? storedError.message : "命令先前已被拒绝",
      status,
      { ...(isRecord(storedError.details) ? storedError.details : {}), replayed: true },
    );
  }
  return { status, data: replayData(response), replayed: true };
}

async function finalizeConflictReceipt(
  db: D1Database,
  input: {
    commandId: string;
    commandType: string;
    actorId: string;
    requestSha256: string;
    code: string;
    message: string;
    details?: JsonObject;
    now: string;
  },
) {
  const response = {
    error: {
      code: input.code,
      message: input.message,
      ...(input.details ? { details: input.details } : {}),
    },
  };
  await db.prepare(`UPDATE publish_capability_receipts
    SET response_json = ?, status_code = 409, completed_at = ?
    WHERE command_id = ? AND command_type = ? AND actor_id = ? AND request_sha256 = ? AND status_code = 0`)
    .bind(
      canonicalExecutionJson(response),
      input.now,
      input.commandId,
      input.commandType,
      input.actorId,
      input.requestSha256,
    ).run();
}

function issueResponse(input: {
  capabilityId: string;
  packet: FrozenExecutionPacket;
  issuedAt: string;
  expiresAt: string;
  commandId: string;
  requestSha256: string;
}) {
  return {
    schemaVersion: PUBLISH_CAPABILITY_API_VERSION,
    capabilityId: input.capabilityId,
    state: "issued",
    bindings: publishCapabilityBindings(input.packet),
    issuedAt: input.issuedAt,
    expiresAt: input.expiresAt,
    handling: {
      ticketStoredServerSide: true,
      executionPacketStoredServerSide: true,
      agentInput: "capabilityId_only",
      modelInputAllowed: false,
    },
    receipt: {
      commandId: input.commandId,
      requestSha256: input.requestSha256,
      replayed: false,
    },
  } satisfies JsonObject;
}

async function issueCapability(
  db: D1Database,
  request: Request,
  commandId: string,
  payload: JsonObject,
) {
  if (request.headers.has("authorization")) {
    throw new PublishCapabilityApiError(
      "PUBLISH_CAPABILITY_ISSUE_MANAGEMENT_ONLY",
      "Agent Key 不能签发一次性发布票据",
      403,
    );
  }
  const principal = await requireManagementSession(request, { mutation: true, scope: "release.approve" });
  if (principal.authBasis === "site_full_control_key") {
    throw new PublishCapabilityApiError(
      "PUBLISH_CAPABILITY_ISSUE_OWNER_OR_TRUSTED_SESSION_REQUIRED",
      "由 site.full_control Key 派生的根会话不能签发一次性发布票据；请使用 owner 或可信设备管理会话完成当前批次确认",
      403,
    );
  }
  const actorId = managementActorId(principal);
  const secret = hmacSecret();
  exactKeys(payload, ["executionPacket", "confirmation", "expiresAt"], "issue payload");
  const canonicalRequest = canonicalPublishCommandRequest({ action: "issue", commandId, payload });
  const requestSha256 = await sha256ExecutionText(canonicalRequest);
  const commandType = "publish-capability.issue";
  const replay = await inspectCommandReceipt(db, commandId, commandType, actorId, requestSha256);
  if (replay) return replay;
  if (!isRecord(payload.executionPacket)) {
    throw new PublishCapabilityApiError("PUBLISH_PACKET_INVALID", "executionPacket 必须是冻结执行包对象");
  }
  const packetValidation = await validateFrozenExecutionPacket(payload.executionPacket);
  if (!packetValidation.ok) {
    throw new PublishCapabilityApiError(
      "PUBLISH_PACKET_INVALID",
      "executionPacket 未通过冻结执行包校验",
      422,
      { errors: packetValidation.errors },
    );
  }
  const packet = payload.executionPacket as FrozenExecutionPacket;
  if (packet.phase !== "publish_once") {
    throw new PublishCapabilityApiError("PUBLISH_PACKET_PHASE_INVALID", "只有 publish_once 执行包可以签发票据", 422);
  }
  const nowDate = new Date();
  const confirmationValidation = validatePublishBatchConfirmation(payload.confirmation, packet, { now: nowDate });
  if (!confirmationValidation.ok) {
    throw new PublishCapabilityApiError(
      "PUBLISH_CONFIRMATION_INVALID",
      "当前批次的显式发布确认与执行包不一致",
      422,
      { errors: confirmationValidation.errors },
    );
  }
  if (typeof payload.expiresAt !== "string") {
    throw new PublishCapabilityApiError("PUBLISH_EXPIRY_INVALID", "expiresAt 必须是带时区的 ISO 时间");
  }
  const ticket = await issuePublishCapabilityTicket(packet, secret, {
    expiresAt: payload.expiresAt,
    now: nowDate,
  });
  const verification = await verifyPublishCapabilityTicket(ticket, packet, secret, { now: nowDate });
  if (!verification.ok || !verification.nonceSha256 || !verification.persistentConsumption) {
    throw new PublishCapabilityApiError(
      "PUBLISH_TICKET_SELF_VERIFICATION_FAILED",
      "新签发票据未通过服务端回验",
      503,
    );
  }
  const capabilityId = `publish-capability-${crypto.randomUUID()}`;
  const packetJson = canonicalExecutionJson(packet);
  const ticketJson = canonicalExecutionJson(ticket);
  const confirmationJson = canonicalExecutionJson(payload.confirmation);
  const packetJsonSha256 = await sha256ExecutionText(packetJson);
  const ticketSha256 = await sha256ExecutionText(ticketJson);
  const confirmationSha256 = await sha256ExecutionText(confirmationJson);
  const bindings = publishCapabilityBindings(packet);
  const issuedAt = ticket.claims.issuedAt;
  const expiresAt = ticket.claims.expiresAt;
  const now = nowDate.toISOString();
  const response = issueResponse({ capabilityId, packet, issuedAt, expiresAt, commandId, requestSha256 });
  const results = await db.batch([
    db.prepare(`INSERT OR IGNORE INTO publish_capability_receipts
      (command_id, command_type, actor_id, request_sha256, response_json, status_code, created_at)
      VALUES (?, ?, ?, ?, '{}', 0, ?)`)
      .bind(commandId, commandType, actorId, requestSha256, now),
    db.prepare(`INSERT OR IGNORE INTO publish_capabilities
      (id, schema_version, issue_command_id, issue_request_sha256, execution_packet_sha256, nonce_sha256,
       ticket_sha256, packet_json_sha256, confirmation_sha256, packet_json, ticket_json, confirmation_json,
       run_id, article_id, attempt, packet_command_id, contract_revision, contract_sha256, platform, release_id, build_id,
       artifact_sha256, target_account, action, max_clicks, issuer_actor_id, issuer_principal_id,
       status, issued_at, expires_at, created_at)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'publish', 1, ?, ?,
        'issued', ?, ?, ?
      WHERE EXISTS (
        SELECT 1 FROM publish_capability_receipts
        WHERE command_id = ? AND command_type = ? AND actor_id = ? AND request_sha256 = ? AND status_code = 0
      )`)
      .bind(
        capabilityId,
        ticket.schemaVersion,
        commandId,
        requestSha256,
        bindings.executionPacketSha256,
        verification.nonceSha256,
        ticketSha256,
        packetJsonSha256,
        confirmationSha256,
        packetJson,
        ticketJson,
        confirmationJson,
        bindings.runId,
        bindings.articleId,
        bindings.attempt,
        bindings.packetCommandId,
        bindings.contractRevision,
        bindings.contractSha256,
        bindings.platform,
        bindings.releaseId,
        bindings.buildId,
        bindings.artifactSha256,
        bindings.targetAccount,
        actorId,
        principal.principalId,
        issuedAt,
        expiresAt,
        now,
        commandId,
        commandType,
        actorId,
        requestSha256,
      ),
    db.prepare(`UPDATE publish_capability_receipts SET response_json = ?, status_code = 201, completed_at = ?
      WHERE command_id = ? AND command_type = ? AND actor_id = ? AND request_sha256 = ? AND status_code = 0
        AND EXISTS (
          SELECT 1 FROM publish_capabilities
          WHERE issue_command_id = ? AND issue_request_sha256 = ? AND issuer_actor_id = ?
        )`)
      .bind(
        canonicalExecutionJson(response),
        now,
        commandId,
        commandType,
        actorId,
        requestSha256,
        commandId,
        requestSha256,
        actorId,
      ),
  ]);
  const completed = await inspectCommandReceipt(db, commandId, commandType, actorId, requestSha256);
  if (completed) {
    const replayed = Number(results[0].meta.changes ?? 0) === 0;
    return { ...completed, data: withReplayFlag(completed.data, replayed), replayed };
  }
  const conflictingCapability = await db.prepare(`SELECT issue_command_id FROM publish_capabilities
    WHERE execution_packet_sha256 = ? LIMIT 1`)
    .bind(packet.packetSha256).first<D1Row>();
  if (conflictingCapability) {
    await finalizeConflictReceipt(db, {
      commandId,
      commandType,
      actorId,
      requestSha256,
      code: "PUBLISH_CAPABILITY_ALREADY_ISSUED",
      message: "当前冻结执行包已经签发过一次性票据；如需重新授权必须生成新的执行包与明确确认",
      details: { existingIssueCommandId: String(conflictingCapability.issue_command_id) },
      now,
    });
    throw new PublishCapabilityApiError(
      "PUBLISH_CAPABILITY_ALREADY_ISSUED",
      "当前冻结执行包已经签发过一次性票据；如需重新授权必须生成新的执行包与明确确认",
      409,
    );
  }
  throw new PublishCapabilityApiError("PUBLISH_CAPABILITY_ISSUE_RACE", "票据签发未形成可读回执", 503);
}

function storedBindingMismatch(row: D1Row, packet: FrozenExecutionPacket, ticket: PublishCapabilityTicket) {
  const bindings = publishCapabilityBindings(packet);
  const checks: Array<[unknown, unknown]> = [
    [row.execution_packet_sha256, bindings.executionPacketSha256],
    [row.run_id, bindings.runId],
    [row.article_id, bindings.articleId],
    [Number(row.attempt), bindings.attempt],
    [row.packet_command_id, bindings.packetCommandId],
    [Number(row.contract_revision), bindings.contractRevision],
    [row.contract_sha256, bindings.contractSha256],
    [row.platform, bindings.platform],
    [row.release_id, bindings.releaseId],
    [row.build_id, bindings.buildId],
    [row.artifact_sha256, bindings.artifactSha256],
    [row.target_account, bindings.targetAccount],
    [row.action, "publish"],
    [Number(row.max_clicks), 1],
    [row.issued_at, ticket.claims.issuedAt],
    [row.expires_at, ticket.claims.expiresAt],
  ];
  return checks.some(([actual, expected]) => actual !== expected);
}

async function verifiedStoredCapability(db: D1Database, capabilityId: string, secret: string, nowDate: Date) {
  const row = await db.prepare("SELECT * FROM publish_capabilities WHERE id = ? LIMIT 1")
    .bind(capabilityId).first<D1Row>();
  if (!row) throw new PublishCapabilityApiError("PUBLISH_CAPABILITY_NOT_FOUND", "一次性发布能力不存在", 404);
  const packetUnknown = parseStoredJson(row.packet_json, "冻结执行包");
  if (!isRecord(packetUnknown)) {
    throw new PublishCapabilityApiError("PUBLISH_CAPABILITY_STORAGE_INVALID", "服务端冻结执行包不是对象", 409);
  }
  const packetValidation = await validateFrozenExecutionPacket(packetUnknown);
  if (!packetValidation.ok) {
    throw new PublishCapabilityApiError(
      "PUBLISH_CAPABILITY_STORAGE_INVALID",
      "服务端冻结执行包未通过完整性校验",
      409,
      { errors: packetValidation.errors },
    );
  }
  const packet = packetUnknown as FrozenExecutionPacket;
  const ticketUnknown = parseStoredJson(row.ticket_json, "发布票据");
  const verification = await verifyPublishCapabilityTicket(ticketUnknown, packet, secret, { now: nowDate });
  if (!verification.ok || !verification.nonceSha256 || !verification.persistentConsumption) {
    const expired = verification.errors.some((error) => error.includes("expired"));
    throw new PublishCapabilityApiError(
      expired ? "PUBLISH_CAPABILITY_EXPIRED" : "PUBLISH_CAPABILITY_VERIFICATION_FAILED",
      expired ? "一次性发布能力已经过期" : "一次性发布能力的签名或执行绑定无效",
      expired ? 410 : 409,
      { errors: verification.errors },
    );
  }
  const ticket = ticketUnknown as PublishCapabilityTicket;
  const packetJson = canonicalExecutionJson(packet);
  const ticketJson = canonicalExecutionJson(ticket);
  const [packetJsonSha256, ticketSha256] = await Promise.all([
    sha256ExecutionText(packetJson),
    sha256ExecutionText(ticketJson),
  ]);
  if (
    packetJson !== row.packet_json
    || ticketJson !== row.ticket_json
    || packetJsonSha256 !== row.packet_json_sha256
    || ticketSha256 !== row.ticket_sha256
    || verification.nonceSha256 !== row.nonce_sha256
    || storedBindingMismatch(row, packet, ticket)
  ) {
    throw new PublishCapabilityApiError(
      "PUBLISH_CAPABILITY_STORAGE_MISMATCH",
      "一次性发布能力与服务端签发记录不一致",
      409,
    );
  }
  return { row, packet, ticket, nonceSha256: verification.nonceSha256 };
}

async function consumeCapability(
  db: D1Database,
  request: Request,
  commandId: string,
  payload: JsonObject,
) {
  exactKeys(payload, ["capabilityId"], "consume payload");
  if (typeof payload.capabilityId !== "string" || !CAPABILITY_ID_RE.test(payload.capabilityId)) {
    throw new PublishCapabilityApiError("PUBLISH_CAPABILITY_ID_INVALID", "capabilityId 格式无效");
  }
  const capabilityBinding = await db.prepare("SELECT article_id FROM publish_capabilities WHERE id = ? LIMIT 1")
    .bind(payload.capabilityId).first<D1Row>();
  const articleId = typeof capabilityBinding?.article_id === "string" && SAFE_ID_RE.test(capabilityBinding.article_id)
    ? capabilityBinding.article_id : "__missing_article_binding__";
  const principal = await authenticatePrivilegedAgent(
    request,
    db,
    "publish.capability.consume",
    {
      allowedRoles: ["super_admin"],
      localOnly: true,
      articleId,
      agentActionId: "publish-capability.v1.consume",
    },
  );
  if (principal.profileVersion !== "permission_snapshot_v3" || principal.articleIds.includes("*")) {
    throw new PublishCapabilityApiError(
      "PUBLISH_CAPABILITY_AGENT_BINDING_REQUIRED",
      "消费发布能力必须使用包含精确文章与动作快照的 v3 Agent Key",
      403,
    );
  }
  const secret = hmacSecret();
  const actorId = principal.actorId;
  const commandType = "publish-capability.consume";
  const canonicalRequest = canonicalPublishCommandRequest({ action: "consume", commandId, payload });
  const requestSha256 = await sha256ExecutionText(canonicalRequest);
  const replay = await inspectCommandReceipt(db, commandId, commandType, actorId, requestSha256);
  if (replay) return replay;
  const nowDate = new Date();
  const now = nowDate.toISOString();
  const priorConsumption = await db.prepare(`SELECT consumed_at FROM publish_capability_consumptions
    WHERE capability_id = ? LIMIT 1`)
    .bind(payload.capabilityId).first<D1Row>();
  if (priorConsumption) {
    await db.prepare(`INSERT OR IGNORE INTO publish_capability_receipts
      (command_id, command_type, actor_id, request_sha256, response_json, status_code, created_at)
      VALUES (?, ?, ?, ?, '{}', 0, ?)`)
      .bind(commandId, commandType, actorId, requestSha256, now).run();
    await inspectCommandReceipt(db, commandId, commandType, actorId, requestSha256);
    await finalizeConflictReceipt(db, {
      commandId,
      commandType,
      actorId,
      requestSha256,
      code: "PUBLISH_CAPABILITY_ALREADY_CONSUMED",
      message: "该票据已由另一条命令消费，本次没有再次授权；原消费记录仍保留。票据消费不证明平台已接受提交或内容公开可见；请核对消费回执并执行 read_only_probe，禁止再次点击。",
      details: { consumedAt: String(priorConsumption.consumed_at) },
      now,
    });
    throw new PublishCapabilityApiError(
      "PUBLISH_CAPABILITY_ALREADY_CONSUMED",
      "该票据已由另一条命令消费，本次没有再次授权；原消费记录仍保留。票据消费不证明平台已接受提交或内容公开可见；请核对消费回执并执行 read_only_probe，禁止再次点击。",
      409,
      { consumedAt: String(priorConsumption.consumed_at) },
    );
  }
  const capability = await verifiedStoredCapability(db, payload.capabilityId, secret, nowDate);
  const bindings = publishCapabilityBindings(capability.packet);
  const proposedResponse = safePublishConsumptionResponse({
    capabilityId: payload.capabilityId,
    bindings,
    issuedAt: capability.ticket.claims.issuedAt,
    expiresAt: capability.ticket.claims.expiresAt,
    consumedAt: now,
    commandId,
    requestSha256,
  });
  const consumptionId = `publish-capability-consumption-${crypto.randomUUID()}`;
  const results = await db.batch([
    db.prepare(`INSERT OR IGNORE INTO publish_capability_receipts
      (command_id, command_type, actor_id, request_sha256, response_json, status_code, created_at)
      VALUES (?, ?, ?, ?, '{}', 0, ?)`)
      .bind(commandId, commandType, actorId, requestSha256, now),
    db.prepare(`INSERT OR IGNORE INTO publish_capability_consumptions
      (id, capability_id, nonce_sha256, consumer_actor_id, consumer_client_id, command_id, request_sha256, consumed_at)
      SELECT ?, capability.id, capability.nonce_sha256, ?, ?, ?, ?, ?
      FROM publish_capabilities capability
      WHERE capability.id = ?
        AND capability.status = 'issued'
        AND capability.expires_at > ?
        AND capability.nonce_sha256 = ?
        AND capability.execution_packet_sha256 = ?
        AND capability.article_id = ?
        AND capability.ticket_sha256 = ?
        AND capability.action = 'publish'
        AND capability.max_clicks = 1
        AND EXISTS (
          SELECT 1 FROM publish_capability_receipts receipt
          WHERE receipt.command_id = ? AND receipt.command_type = ? AND receipt.actor_id = ?
            AND receipt.request_sha256 = ? AND receipt.status_code = 0
        )`)
      .bind(
        consumptionId,
        actorId,
        principal.clientId,
        commandId,
        requestSha256,
        now,
        payload.capabilityId,
        now,
        capability.nonceSha256,
        bindings.executionPacketSha256,
        bindings.articleId,
        String(capability.row.ticket_sha256),
        commandId,
        commandType,
        actorId,
        requestSha256,
      ),
    db.prepare(`UPDATE publish_capabilities SET status = 'consumed', consumed_at = ?
      WHERE id = ? AND status = 'issued' AND nonce_sha256 = ?
        AND EXISTS (
          SELECT 1 FROM publish_capability_consumptions consumption
          WHERE consumption.capability_id = publish_capabilities.id
            AND consumption.nonce_sha256 = publish_capabilities.nonce_sha256
            AND consumption.command_id = ? AND consumption.request_sha256 = ?
        )`)
      .bind(now, payload.capabilityId, capability.nonceSha256, commandId, requestSha256),
    db.prepare(`UPDATE publish_capability_receipts SET response_json = ?, status_code = 200, completed_at = ?
      WHERE command_id = ? AND command_type = ? AND actor_id = ? AND request_sha256 = ? AND status_code = 0
        AND EXISTS (
          SELECT 1 FROM publish_capability_consumptions
          WHERE capability_id = ? AND nonce_sha256 = ? AND command_id = ?
            AND consumer_actor_id = ? AND request_sha256 = ?
        )`)
      .bind(
        canonicalExecutionJson(proposedResponse),
        now,
        commandId,
        commandType,
        actorId,
        requestSha256,
        payload.capabilityId,
        capability.nonceSha256,
        commandId,
        actorId,
        requestSha256,
      ),
  ]);
  const completed = await inspectCommandReceipt(db, commandId, commandType, actorId, requestSha256);
  if (completed) {
    const replayed = Number(results[0].meta.changes ?? 0) === 0;
    return { ...completed, data: withReplayFlag(completed.data, replayed), replayed };
  }
  const existingConsumption = await db.prepare(`SELECT * FROM publish_capability_consumptions
    WHERE capability_id = ? OR nonce_sha256 = ? LIMIT 1`)
    .bind(payload.capabilityId, capability.nonceSha256).first<D1Row>();
  if (existingConsumption) {
    await finalizeConflictReceipt(db, {
      commandId,
      commandType,
      actorId,
      requestSha256,
      code: "PUBLISH_CAPABILITY_ALREADY_CONSUMED",
      message: "该票据已由另一条命令消费，本次没有再次授权；原消费记录仍保留。票据消费不证明平台已接受提交或内容公开可见；请核对消费回执并执行 read_only_probe，禁止再次点击。",
      details: { consumedAt: String(existingConsumption.consumed_at) },
      now,
    });
    throw new PublishCapabilityApiError(
      "PUBLISH_CAPABILITY_ALREADY_CONSUMED",
      "该票据已由另一条命令消费，本次没有再次授权；原消费记录仍保留。票据消费不证明平台已接受提交或内容公开可见；请核对消费回执并执行 read_only_probe，禁止再次点击。",
      409,
      { consumedAt: String(existingConsumption.consumed_at) },
    );
  }
  throw new PublishCapabilityApiError(
    "PUBLISH_CAPABILITY_CAS_FAILED",
    "一次性发布能力未通过服务端单次消费 CAS",
    409,
  );
}

export async function POST(request: Request) {
  const id = requestId();
  try {
    const input = await parseRequest(request);
    const db = database();
    await ensurePublishCapabilitySchema(db);
    const result = input.action === "issue"
      ? await issueCapability(db, request, input.commandId, input.payload)
      : await consumeCapability(db, request, input.commandId, input.payload);
    return jsonSuccess(id, result.data, result.status, result.replayed);
  } catch (error) {
    return jsonError(id, error);
  }
}

// Kept as a production-bundle marker for the D1 integration harness.
void ROUTE_MARKER;
