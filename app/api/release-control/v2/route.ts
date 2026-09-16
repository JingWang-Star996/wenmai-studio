import { env } from "cloudflare:workers";
import { ManagementAuthError } from "../../../management-auth-core";
import {
  managementActorId,
  requireManagementSession,
  type ManagementPrincipal,
} from "../../../management-auth";
import {
  createArticlePublishConfirmation,
  createReleaseReadinessSnapshot,
  REQUIRED_PLATFORMS,
  verifyArticlePublishConfirmation,
  verifyReleaseReadinessSnapshot,
  type ConfirmationItem,
  type Platform,
  type ReleaseFacts,
} from "../../../release-control-v2";
import {
  MANDATORY_STOP_CONDITIONS,
  PUBLISH_ONCE_ACTIONS,
  canonicalExecutionJson,
  createFrozenExecutionPacket,
  sha256ExecutionJson,
  sha256ExecutionText,
} from "../../../release-execution-contract";
import { requireCurrentReleaseControlFacts } from "../../lifecycle/route";

type Row = Record<string, unknown>;
type Obj = Record<string, unknown>;
type Action = "readiness.record" | "confirmation.create" | "capabilities.issue";
type Command = { action: Action; commandId: string; payload: Obj };
type Bindings = {
  DB?: D1Database;
  WENMAI_RELEASE_CONTROL_V2_ENABLED?: string;
  WENMAI_PUBLISH_OPERATOR_HOST_ROUTE_VERIFIED?: string;
};
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u,
  SHA = /^[a-f0-9]{64}$/u,
  MAX = 512000;
const CONTRACT =
  "36df7d05245e629b1da423a2b8cedb64053444b92299990b70cba0a2532f621f";
const ACTIONS: ReadonlySet<string> = new Set([
  "readiness.record",
  "confirmation.create",
  "capabilities.issue",
]);
export const runtime = "edge";
class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}
function object(value: unknown): value is Obj {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function now() {
  return new Date().toISOString();
}
function id(prefix: string) {
  return `${prefix}-${crypto.randomUUID()}`;
}
function bindings() {
  const e = env as Bindings,
    p = typeof process === "undefined" ? {} : process.env;
  return {
    db: e.DB,
    enabled:
      (e.WENMAI_RELEASE_CONTROL_V2_ENABLED ??
        p.WENMAI_RELEASE_CONTROL_V2_ENABLED) === "true",
    hostVerified:
      (e.WENMAI_PUBLISH_OPERATOR_HOST_ROUTE_VERIFIED ??
        p.WENMAI_PUBLISH_OPERATOR_HOST_ROUTE_VERIFIED) === "true",
  };
}
function database() {
  const d = bindings().db;
  if (!d)
    throw new ApiError(
      "DB_UNAVAILABLE",
      "Release Control V2 数据库不可用",
      503,
    );
  return d;
}
function headers(replayed = false) {
  return {
    "cache-control": "private, no-store, max-age=0",
    "x-content-type-options": "nosniff",
    "x-wenmai-command-replayed": replayed ? "1" : "0",
  };
}
function ok(requestId: string, data: Obj, replayed = false) {
  return Response.json(
    { ok: true, requestId, data },
    { headers: headers(replayed) },
  );
}
function fail(requestId: string, error: unknown) {
  const x =
    error instanceof ApiError || error instanceof ManagementAuthError
      ? error
      : new ApiError(
          "RELEASE_CONTROL_V2_INTERNAL_ERROR",
          "Release Control V2 服务处理失败",
          500,
        );
  return Response.json(
    { ok: false, requestId, error: { code: x.code, message: x.message } },
    { status: x.status, headers: headers() },
  );
}
function exact(value: Obj, keys: readonly string[], label: string) {
  if (
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !(key in value))
  )
    throw new ApiError("REQUEST_INVALID", `${label} 字段必须精确匹配`);
}
function required(value: unknown, label: string) {
  if (typeof value !== "string" || !value)
    throw new ApiError("REQUEST_INVALID", `${label} 无效`);
  return value;
}
function account(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim() === value &&
    value.length > 0 &&
    !value.includes("*") &&
    ![...value].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 31 || codePoint === 127;
    })
  );
}
function asPlatform(value: string): Platform {
  if (!(REQUIRED_PLATFORMS as readonly string[]).includes(value))
    throw new ApiError("RELEASE_FACTS_INVALID", "Release 平台无效", 409);
  return value as Platform;
}
function facts(
  value: Awaited<ReturnType<typeof requireCurrentReleaseControlFacts>>,
): ReleaseFacts {
  return {
    articleId: value.articleId,
    runId: value.runId,
    releaseId: value.releaseId,
    buildId: value.buildId,
    platform: asPlatform(value.platform),
    artifactSha256: value.artifactSha256,
    publicationVersionSha256: value.publicationVersionSha256,
    profileSha256: value.profileSha256,
    contractSha256: value.contractSha256,
  };
}
async function digest(value: unknown) {
  const encoded = new TextEncoder().encode(JSON.stringify(value));
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", encoded));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
async function parse(request: Request): Promise<Command> {
  if (
    !(request.headers.get("content-type") ?? "")
      .toLowerCase()
      .startsWith("application/json")
  )
    throw new ApiError("CONTENT_TYPE_REQUIRED", "只接受 UTF-8 JSON", 415);
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (!bytes.length || bytes.length > MAX)
    throw new ApiError(
      "REQUEST_INVALID",
      "请求正文无效",
      bytes.length > MAX ? 413 : 400,
    );
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new ApiError("REQUEST_JSON_INVALID", "请求不是有效 UTF-8 JSON");
  }
  if (!object(value)) throw new ApiError("REQUEST_INVALID", "请求必须为对象");
  exact(value, ["action", "commandId", "payload"], "envelope");
  if (typeof value.action !== "string" || !ACTIONS.has(value.action))
    throw new ApiError("ACTION_INVALID", "不支持的控制动作");
  if (
    typeof value.commandId !== "string" ||
    !ID.test(value.commandId) ||
    !object(value.payload)
  )
    throw new ApiError("REQUEST_INVALID", "commandId 或 payload 无效");
  return {
    action: value.action as Action,
    commandId: value.commandId,
    payload: value.payload,
  };
}

const TABLES = [
  "CREATE TABLE IF NOT EXISTS release_control_v2_command_receipts(command_id TEXT PRIMARY KEY NOT NULL,command_type TEXT NOT NULL,actor_id TEXT NOT NULL,request_sha256 TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'received' CHECK(status IN ('received','succeeded','rejected','failed')),response_json TEXT NOT NULL DEFAULT '{}',created_at TEXT NOT NULL,completed_at TEXT)",
  "CREATE TABLE IF NOT EXISTS release_readiness_snapshots(id TEXT PRIMARY KEY NOT NULL,article_id TEXT NOT NULL,run_id TEXT NOT NULL,release_id TEXT NOT NULL,build_id TEXT NOT NULL,platform TEXT NOT NULL CHECK(platform IN ('xiaohongshu','maimai','zhihu','bilibili')),artifact_sha256 TEXT NOT NULL,target_account TEXT NOT NULL,publication_version_sha256 TEXT NOT NULL,profile_sha256 TEXT NOT NULL,contract_sha256 TEXT NOT NULL,prepare_receipt_head_sha256 TEXT NOT NULL,dom_contract_sha256 TEXT NOT NULL,snapshot_sha256 TEXT NOT NULL UNIQUE,state TEXT NOT NULL DEFAULT 'ready_to_submit' CHECK(state IN ('ready_to_submit','stale','revoked')),created_at TEXT NOT NULL,expires_at TEXT NOT NULL CHECK(expires_at>created_at),stale_reason TEXT,revoked_at TEXT)",
  "CREATE TABLE IF NOT EXISTS article_publish_confirmations(id TEXT PRIMARY KEY NOT NULL,article_id TEXT NOT NULL,run_id TEXT NOT NULL,contract_sha256 TEXT NOT NULL,owner_session_id TEXT NOT NULL,item_set_sha256 TEXT NOT NULL,confirmation_sha256 TEXT NOT NULL UNIQUE,state TEXT NOT NULL DEFAULT 'confirmed' CHECK(state IN ('confirmed','expired','revoked','consumed')),confirmed_at TEXT NOT NULL,expires_at TEXT NOT NULL CHECK(expires_at>confirmed_at),revoked_at TEXT,created_at TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS article_publish_confirmation_items(id TEXT PRIMARY KEY NOT NULL,confirmation_id TEXT NOT NULL,platform TEXT NOT NULL CHECK(platform IN ('xiaohongshu','maimai','zhihu','bilibili')),release_id TEXT NOT NULL,build_id TEXT NOT NULL,artifact_sha256 TEXT NOT NULL,target_account TEXT NOT NULL,readiness_snapshot_sha256 TEXT NOT NULL,created_at TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS release_publish_capabilities_v2(id TEXT PRIMARY KEY NOT NULL,confirmation_id TEXT NOT NULL,article_id TEXT NOT NULL,run_id TEXT NOT NULL,build_id TEXT NOT NULL,release_id TEXT NOT NULL,platform TEXT NOT NULL CHECK(platform IN ('xiaohongshu','maimai','zhihu','bilibili')),execution_packet_json TEXT NOT NULL,packet_json_sha256 TEXT NOT NULL UNIQUE,packet_sha256 TEXT NOT NULL UNIQUE,artifact_sha256 TEXT NOT NULL,readiness_snapshot_sha256 TEXT NOT NULL,dom_contract_sha256 TEXT NOT NULL,target_account TEXT NOT NULL,nonce_sha256 TEXT NOT NULL UNIQUE,max_clicks INTEGER NOT NULL DEFAULT 1 CHECK(max_clicks=1),status TEXT NOT NULL DEFAULT 'issued' CHECK(status IN ('issued','leased','consumed','expired','revoked','frozen')),issued_at TEXT NOT NULL,expires_at TEXT NOT NULL CHECK(expires_at>issued_at),consumed_at TEXT)",
  "CREATE TABLE IF NOT EXISTS publish_click_leases_v2(id TEXT PRIMARY KEY NOT NULL,capability_id TEXT NOT NULL,confirmation_id TEXT NOT NULL,article_id TEXT NOT NULL,run_id TEXT NOT NULL,build_id TEXT NOT NULL,release_id TEXT NOT NULL,platform TEXT NOT NULL CHECK(platform IN ('xiaohongshu','maimai','zhihu','bilibili')),target_account TEXT NOT NULL,lease_token_sha256 TEXT NOT NULL UNIQUE,receipt_chain_id TEXT NOT NULL UNIQUE,host_id TEXT NOT NULL,route_attestation_sha256 TEXT NOT NULL,dom_contract_sha256 TEXT NOT NULL,packet_sha256 TEXT NOT NULL,artifact_sha256 TEXT NOT NULL,readiness_snapshot_sha256 TEXT NOT NULL,max_clicks INTEGER NOT NULL DEFAULT 1 CHECK(max_clicks=1),status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','consumed','expired','revoked','frozen')),issued_at TEXT NOT NULL,expires_at TEXT NOT NULL CHECK(expires_at>issued_at),consumed_at TEXT,revoked_at TEXT)",
  "CREATE TABLE IF NOT EXISTS release_external_action_freezes_v2(release_id TEXT PRIMARY KEY NOT NULL,reason TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'frozen' CHECK(status IN ('frozen','cleared')),capability_id TEXT,lease_id TEXT,frozen_at TEXT NOT NULL,cleared_at TEXT,cleared_by TEXT)",
  "CREATE TABLE IF NOT EXISTS publish_execution_receipt_events_v2(id TEXT PRIMARY KEY NOT NULL,receipt_chain_id TEXT NOT NULL,capability_id TEXT NOT NULL,lease_id TEXT NOT NULL,confirmation_id TEXT NOT NULL,article_id TEXT NOT NULL,run_id TEXT NOT NULL,build_id TEXT NOT NULL,release_id TEXT NOT NULL,platform TEXT NOT NULL CHECK(platform IN ('xiaohongshu','maimai','zhihu','bilibili')),target_account TEXT NOT NULL,dom_contract_sha256 TEXT NOT NULL,sequence INTEGER NOT NULL,previous_event_sha256 TEXT,event_sha256 TEXT NOT NULL UNIQUE,event_type TEXT NOT NULL CHECK(event_type IN ('capability_consumed','click_invocation_started','click_invoked','click_not_invoked','result_unknown','read_only_probe')),host_id TEXT NOT NULL,host_invocation_id TEXT NOT NULL UNIQUE,packet_sha256 TEXT NOT NULL,artifact_sha256 TEXT NOT NULL,readiness_snapshot_sha256 TEXT NOT NULL,result_json TEXT NOT NULL DEFAULT '{}',evidence_json TEXT NOT NULL DEFAULT '{}',write_disposition TEXT NOT NULL CHECK(write_disposition IN ('continue','freeze_writes','stop_writes')),recovery_mode TEXT NOT NULL CHECK(recovery_mode IN ('none','probe_first')),observed_at TEXT NOT NULL,created_at TEXT NOT NULL,server_sha256 TEXT NOT NULL,signature_sha256 TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS release_authoritative_readbacks_v2(id TEXT PRIMARY KEY NOT NULL,release_id TEXT NOT NULL,capability_id TEXT,lease_id TEXT,confirmation_id TEXT NOT NULL,article_id TEXT NOT NULL,run_id TEXT NOT NULL,build_id TEXT NOT NULL,platform TEXT NOT NULL CHECK(platform IN ('xiaohongshu','maimai','zhihu','bilibili')),target_account TEXT NOT NULL,dom_contract_sha256 TEXT NOT NULL,host_id TEXT NOT NULL,receipt_chain_id TEXT,packet_sha256 TEXT NOT NULL,artifact_sha256 TEXT NOT NULL,readiness_snapshot_sha256 TEXT NOT NULL,readback_kind TEXT NOT NULL CHECK(readback_kind IN ('submission','destination_record','public_access','outcome','read_only_probe')),result TEXT NOT NULL CHECK(result IN ('verified','not_found','not_public','inconclusive','failed')),evidence_json TEXT NOT NULL DEFAULT '{}',source_url TEXT NOT NULL DEFAULT '',observed_at TEXT NOT NULL,evidence_sha256 TEXT NOT NULL,response_sha256 TEXT NOT NULL,created_at TEXT NOT NULL)",
];
const INDEXES = [
  "CREATE INDEX IF NOT EXISTS idx_release_control_v2_command_receipts_actor_created ON release_control_v2_command_receipts(actor_id,created_at)",
  "CREATE INDEX IF NOT EXISTS idx_release_readiness_snapshots_release_state_expiry ON release_readiness_snapshots(release_id,state,expires_at)",
  "CREATE INDEX IF NOT EXISTS idx_article_publish_confirmations_article_state_expiry ON article_publish_confirmations(article_id,state,expires_at)",
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_confirmation_items_confirmation_platform ON article_publish_confirmation_items(confirmation_id,platform)",
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_confirmation_items_confirmation_release ON article_publish_confirmation_items(confirmation_id,release_id)",
  "CREATE INDEX IF NOT EXISTS idx_confirmation_items_release ON article_publish_confirmation_items(release_id,platform)",
  "CREATE INDEX IF NOT EXISTS idx_release_publish_capabilities_v2_confirmation_release ON release_publish_capabilities_v2(confirmation_id,release_id)",
  "CREATE INDEX IF NOT EXISTS idx_release_publish_capabilities_v2_status_expiry ON release_publish_capabilities_v2(status,expires_at)",
  "CREATE UNIQUE INDEX IF NOT EXISTS publish_click_leases_v2_capability_id_unique ON publish_click_leases_v2(capability_id)",
  "CREATE INDEX IF NOT EXISTS idx_publish_click_leases_v2_status_expiry ON publish_click_leases_v2(status,expires_at)",
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_receipt_events_v2_chain_sequence ON publish_execution_receipt_events_v2(receipt_chain_id,sequence)",
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_receipt_events_v2_capability_sequence ON publish_execution_receipt_events_v2(capability_id,sequence)",
  "CREATE INDEX IF NOT EXISTS idx_receipt_events_v2_capability_created ON publish_execution_receipt_events_v2(capability_id,created_at)",
  "CREATE INDEX IF NOT EXISTS idx_release_authoritative_readbacks_v2_release_kind_observed ON release_authoritative_readbacks_v2(release_id,readback_kind,observed_at)",
];
const TRIGGERS = [
  "CREATE TRIGGER IF NOT EXISTS publish_execution_receipt_events_v2_no_update BEFORE UPDATE ON publish_execution_receipt_events_v2 BEGIN SELECT RAISE(ABORT, 'publish_execution_receipt_events_v2 is append-only'); END",
  "CREATE TRIGGER IF NOT EXISTS publish_execution_receipt_events_v2_no_delete BEFORE DELETE ON publish_execution_receipt_events_v2 BEGIN SELECT RAISE(ABORT, 'publish_execution_receipt_events_v2 is append-only'); END",
  "CREATE TRIGGER IF NOT EXISTS release_authoritative_readbacks_v2_no_update BEFORE UPDATE ON release_authoritative_readbacks_v2 BEGIN SELECT RAISE(ABORT, 'release_authoritative_readbacks_v2 is append-only'); END",
  "CREATE TRIGGER IF NOT EXISTS release_authoritative_readbacks_v2_no_delete BEFORE DELETE ON release_authoritative_readbacks_v2 BEGIN SELECT RAISE(ABORT, 'release_authoritative_readbacks_v2 is append-only'); END",
];
export async function ensureReleaseControlV2Schema(db: D1Database) {
  await db.batch(
    [...TABLES, ...INDEXES, ...TRIGGERS].map((sql) => db.prepare(sql)),
  );
}
function safe(rows: readonly Row[] | undefined) {
  return (rows ?? []).map((row) =>
    Object.fromEntries(
      Object.entries(row).filter(
        ([key]) => !/(packet_json|nonce|token|hmac|signature)/iu.test(key),
      ),
    ),
  );
}
async function management(
  request: Request,
  scope: "management.read" | "release.record" | "release.approve",
  mutation: boolean,
  articleId?: string,
) {
  return requireManagementSession(request, { scope, mutation, articleId });
}
function boundary(principal: ManagementPrincipal, articleId: string) {
  if (
    !principal.articleIds.includes("*") &&
    !principal.articleIds.includes(articleId)
  )
    throw new ApiError(
      "MANAGEMENT_OBJECT_DENIED",
      "管理会话不包含当前文章对象",
      403,
    );
}
function owner(principal: ManagementPrincipal) {
  if (
    principal.authBasis === "site_full_control_key" ||
    !principal.scopes.includes("release.approve")
  )
    throw new ApiError(
      "OWNER_SESSION_REQUIRED",
      "此动作要求 owner/可信设备管理会话",
      403,
    );
}
async function replay(
  db: D1Database,
  command: Command,
  actor: string,
  requestSha: string,
) {
  const row = await db
    .prepare(
      "SELECT * FROM release_control_v2_command_receipts WHERE command_id=?",
    )
    .bind(command.commandId)
    .first<Row>();
  if (!row) return null;
  if (
    row.command_type !== command.action ||
    row.actor_id !== actor ||
    row.request_sha256 !== requestSha
  )
    throw new ApiError("COMMAND_ID_CONFLICT", "commandId 已绑定不同命令", 409);
  if (command.action === "capabilities.issue")
    throw new ApiError(
      "SECRET_ALREADY_DELIVERED",
      "能力秘密只在首次成功响应中交付",
      409,
    );
  if (row.status !== "succeeded")
    throw new ApiError("COMMAND_IN_PROGRESS", "命令尚未完成", 409);
  try {
    const stored: unknown = JSON.parse(String(row.response_json));
    if (!object(stored) || !object(stored.data)) throw new Error();
    return stored.data;
  } catch {
    throw new ApiError("COMMAND_RECEIPT_INVALID", "命令回执不可安全回放", 503);
  }
}
function receipt(
  db: D1Database,
  command: Command,
  actor: string,
  requestSha: string,
  data: Obj,
) {
  return db
    .prepare(
      "INSERT INTO release_control_v2_command_receipts(command_id,command_type,actor_id,request_sha256,status,response_json,created_at,completed_at) VALUES(?,?,?,?,?,?,?,?)",
    )
    .bind(
      command.commandId,
      command.action,
      actor,
      requestSha,
      "succeeded",
      JSON.stringify({ data }),
      now(),
      now(),
    );
}
async function getData(db: D1Database, articleId: string) {
  const [
    snapshots,
    confirmations,
    capabilities,
    leases,
    freezes,
    readbacks,
    items,
    heads,
    releases,
  ] = await Promise.all([
    db
      .prepare(
        "SELECT * FROM release_readiness_snapshots WHERE article_id=? ORDER BY created_at DESC LIMIT 300",
      )
      .bind(articleId)
      .all<Row>(),
    db
      .prepare(
        "SELECT * FROM article_publish_confirmations WHERE article_id=? ORDER BY created_at DESC LIMIT 300",
      )
      .bind(articleId)
      .all<Row>(),
    db
      .prepare(
        "SELECT * FROM release_publish_capabilities_v2 WHERE article_id=? ORDER BY issued_at DESC LIMIT 300",
      )
      .bind(articleId)
      .all<Row>(),
    db
      .prepare(
        "SELECT * FROM publish_click_leases_v2 WHERE article_id=? ORDER BY issued_at DESC LIMIT 300",
      )
      .bind(articleId)
      .all<Row>(),
    db
      .prepare(
        "SELECT * FROM release_external_action_freezes_v2 WHERE release_id IN (SELECT id FROM lifecycle_releases WHERE article_id=?) ORDER BY frozen_at DESC LIMIT 300",
      )
      .bind(articleId)
      .all<Row>(),
    db
      .prepare(
        "SELECT * FROM release_authoritative_readbacks_v2 WHERE article_id=? ORDER BY created_at DESC LIMIT 300",
      )
      .bind(articleId)
      .all<Row>(),
    db
      .prepare(
        "SELECT * FROM article_publish_confirmation_items WHERE confirmation_id IN (SELECT id FROM article_publish_confirmations WHERE article_id=?) ORDER BY created_at DESC LIMIT 300",
      )
      .bind(articleId)
      .all<Row>(),
    db
      .prepare(
        "SELECT e.* FROM publish_execution_receipt_events_v2 e JOIN (SELECT receipt_chain_id,MAX(sequence) AS sequence FROM publish_execution_receipt_events_v2 WHERE article_id=? GROUP BY receipt_chain_id) h ON h.receipt_chain_id=e.receipt_chain_id AND h.sequence=e.sequence",
      )
      .bind(articleId)
      .all<Row>(),
    db
      .prepare(
        "SELECT id FROM lifecycle_releases WHERE article_id=? ORDER BY created_at DESC LIMIT 300",
      )
      .bind(articleId)
      .all<Row>(),
  ]);
  const releaseCandidates = await Promise.all(
    (releases.results ?? []).map(async (row) => {
      try {
        return {
          ...facts(await requireCurrentReleaseControlFacts(db, String(row.id))),
          eligible: true,
          blockers: [],
        };
      } catch {
        return {
          releaseId: String(row.id),
          eligible: false,
          blockers: ["release_currentness_required"],
        };
      }
    }),
  );
  return {
    articleId,
    gates: {
      controlPlaneEnabled: bindings().enabled,
      hostRouteVerified: bindings().hostVerified,
      browserPublishOnceHardBlocked: true,
      externalPublicationExecuted: false,
    },
    releaseCandidates,
    readinessSnapshots: safe(snapshots.results),
    confirmations: safe(confirmations.results),
    confirmationItems: safe(items.results),
    capabilities: safe(capabilities.results),
    leases: safe(leases.results),
    freezes: safe(freezes.results),
    readbacks: safe(readbacks.results),
    receiptHeads: safe(heads.results),
  };
}
export async function GET(request: Request) {
  const requestId = id("rcv2-request");
  try {
    const articleId = new URL(request.url).searchParams.get("articleId") ?? "";
    if (!ID.test(articleId))
      throw new ApiError("ARTICLE_ID_INVALID", "articleId 无效");
    await management(request, "management.read", false, articleId);
    const db = database();
    await ensureReleaseControlV2Schema(db);
    return ok(requestId, await getData(db, articleId));
  } catch (error) {
    return fail(requestId, error);
  }
}
async function readiness(
  db: D1Database,
  command: Command,
  principal: ManagementPrincipal,
  actor: string,
  requestSha: string,
) {
  exact(
    command.payload,
    [
      "releaseId",
      "targetAccount",
      "prepareReceiptHeadSha256",
      "domContractSha256",
    ],
    "readiness payload",
  );
  const releaseId = required(command.payload.releaseId, "releaseId"),
    target = command.payload.targetAccount,
    prepare = required(
      command.payload.prepareReceiptHeadSha256,
      "prepareReceiptHeadSha256",
    ),
    dom = required(command.payload.domContractSha256, "domContractSha256");
  if (!account(target) || !SHA.test(prepare) || !SHA.test(dom))
    throw new ApiError("READINESS_PAYLOAD_INVALID", "目标账号或摘要无效", 422);
  const current = facts(await requireCurrentReleaseControlFacts(db, releaseId));
  boundary(principal, current.articleId);
  const createdAt = now();
  const snapshot = await createReleaseReadinessSnapshot({
    ...current,
    targetAccount: target,
    prepareReceiptHeadSha256: prepare,
    domContractSha256: dom,
    createdAt,
    expiresAt: new Date(Date.now() + 900000).toISOString(),
  });
  const data = { readinessSnapshot: snapshot };
  try {
    await db.batch([
      db
        .prepare(
          "UPDATE release_readiness_snapshots SET state='stale',stale_reason='superseded_by_new_snapshot' WHERE release_id=? AND state='ready_to_submit'",
        )
        .bind(snapshot.releaseId),
      db
        .prepare(
          "INSERT INTO release_readiness_snapshots(id,article_id,run_id,release_id,build_id,platform,artifact_sha256,target_account,publication_version_sha256,profile_sha256,contract_sha256,prepare_receipt_head_sha256,dom_contract_sha256,snapshot_sha256,state,created_at,expires_at,stale_reason,revoked_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        )
        .bind(
          id("readiness"),
          snapshot.articleId,
          snapshot.runId,
          snapshot.releaseId,
          snapshot.buildId,
          snapshot.platform,
          snapshot.artifactSha256,
          snapshot.targetAccount,
          snapshot.publicationVersionSha256,
          snapshot.profileSha256,
          snapshot.contractSha256,
          snapshot.prepareReceiptHeadSha256,
          snapshot.domContractSha256,
          snapshot.snapshotSha256,
          snapshot.state,
          snapshot.createdAt,
          snapshot.expiresAt,
          null,
          null,
        ),
      receipt(db, command, actor, requestSha, data),
    ]);
  } catch {
    const prior = await replay(db, command, actor, requestSha);
    if (prior) return prior;
    throw new ApiError("COMMAND_WRITE_UNCONFIRMED", "快照写入结果未确认", 503);
  }
  return data;
}
async function confirmation(
  db: D1Database,
  command: Command,
  principal: ManagementPrincipal,
  actor: string,
  requestSha: string,
) {
  exact(
    command.payload,
    [
      "articleId",
      "decision",
      "acknowledgement",
      "readinessSnapshotIds",
      "contractSha256",
    ],
    "confirmation payload",
  );
  const articleId = required(command.payload.articleId, "articleId");
  boundary(principal, articleId);
  owner(principal);
  const ids = command.payload.readinessSnapshotIds;
  if (
    command.payload.decision !== "publish_once_confirmed" ||
    !account(command.payload.acknowledgement) ||
    command.payload.contractSha256 !== CONTRACT ||
    !Array.isArray(ids) ||
    ids.length !== 4 ||
    new Set(ids).size !== 4 ||
    !ids.every((value) => typeof value === "string" && ID.test(value))
  )
    throw new ApiError("CONFIRMATION_INVALID", "确认合同无效", 422);
  const rows = await Promise.all(
    ids.map((snapshotId) =>
      db
        .prepare(
          "SELECT * FROM release_readiness_snapshots WHERE id=? AND article_id=? AND state='ready_to_submit' AND expires_at>?",
        )
        .bind(snapshotId, articleId, now())
        .first<Row>(),
    ),
  );
  if (rows.some((row) => !row))
    throw new ApiError(
      "READINESS_SET_INVALID",
      "快照不是当前文章的可用快照",
      409,
    );
  const snapshots = rows as Row[];
  const seen = new Set(snapshots.map((row) => String(row.platform)));
  if (seen.size !== 4 || REQUIRED_PLATFORMS.some((value) => !seen.has(value)))
    throw new ApiError("READINESS_SET_INVALID", "必须是四个平台快照", 409);
  if (new Set(snapshots.map((row) => String(row.run_id))).size !== 1)
    throw new ApiError(
      "READINESS_RUN_MISMATCH",
      "四个平台快照必须属于同一 run",
      409,
    );
  const items: ConfirmationItem[] = [];
  for (const row of snapshots) {
    const current = facts(
      await requireCurrentReleaseControlFacts(db, String(row.release_id)),
    );
    if (current.articleId !== articleId || current.runId !== String(row.run_id))
      throw new ApiError("RELEASE_FACTS_DRIFTED", "Release 已漂移", 409);
    const snapshot = {
      schemaVersion: "wenmai.release-control/2.0",
      state: "ready_to_submit",
      articleId: String(row.article_id),
      runId: String(row.run_id),
      releaseId: String(row.release_id),
      buildId: String(row.build_id),
      platform: String(row.platform),
      artifactSha256: String(row.artifact_sha256),
      targetAccount: String(row.target_account),
      publicationVersionSha256: String(row.publication_version_sha256),
      profileSha256: String(row.profile_sha256),
      contractSha256: String(row.contract_sha256),
      prepareReceiptHeadSha256: String(row.prepare_receipt_head_sha256),
      domContractSha256: String(row.dom_contract_sha256),
      createdAt: String(row.created_at),
      expiresAt: String(row.expires_at),
      snapshotSha256: String(row.snapshot_sha256),
    };
    if (!(await verifyReleaseReadinessSnapshot(snapshot, current)).ok)
      throw new ApiError(
        "READINESS_SNAPSHOT_INVALID",
        "快照已过期或与当前 Release 不一致",
        409,
      );
    items.push({
      platform: current.platform,
      releaseId: current.releaseId,
      buildId: current.buildId,
      artifactSha256: current.artifactSha256,
      targetAccount: snapshot.targetAccount,
      readinessSnapshotSha256: snapshot.snapshotSha256,
    });
  }
  const result = await createArticlePublishConfirmation({
    confirmationId: id("confirmation"),
    ownerSessionId: principal.sessionId,
    articleId,
    runId: String(snapshots[0].run_id),
    contractSha256: CONTRACT,
    confirmedAt: now(),
    expiresAt: new Date(Date.now() + 900000).toISOString(),
    items,
  });
  const data = {
    confirmation: result,
    noCapabilityIssued: true,
    noExternalAction: true,
  };
  try {
    await db.batch([
      db
        .prepare(
          "UPDATE article_publish_confirmations SET state='revoked',revoked_at=? WHERE article_id=? AND state='confirmed' AND NOT EXISTS (SELECT 1 FROM release_publish_capabilities_v2 c WHERE c.confirmation_id=article_publish_confirmations.id)",
        )
        .bind(now(), articleId),
      db
        .prepare(
          "INSERT INTO article_publish_confirmations(id,article_id,run_id,contract_sha256,owner_session_id,item_set_sha256,confirmation_sha256,state,confirmed_at,expires_at,revoked_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
        )
        .bind(
          result.confirmationId,
          result.articleId,
          result.runId,
          result.contractSha256,
          result.ownerSessionId,
          result.setSha256,
          result.setSha256,
          "confirmed",
          result.confirmedAt,
          result.expiresAt,
          null,
          now(),
        ),
      ...result.items.map((item) =>
        db
          .prepare(
            "INSERT INTO article_publish_confirmation_items(id,confirmation_id,platform,release_id,build_id,artifact_sha256,target_account,readiness_snapshot_sha256,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
          )
          .bind(
            id("confirmation-item"),
            result.confirmationId,
            item.platform,
            item.releaseId,
            item.buildId,
            item.artifactSha256,
            item.targetAccount,
            item.readinessSnapshotSha256,
            now(),
          ),
      ),
      receipt(db, command, actor, requestSha, data),
    ]);
  } catch {
    const prior = await replay(db, command, actor, requestSha);
    if (prior) return prior;
    throw new ApiError("COMMAND_WRITE_UNCONFIRMED", "确认写入结果未确认", 503);
  }
  return data;
}
type CapabilityMaterial = {
  capabilityId: string;
  nonce: string;
  packet: Awaited<ReturnType<typeof createFrozenExecutionPacket>>;
  item: ConfirmationItem;
  snapshot: Row;
  expiresAt: string;
};
function earliestExpiry(values: readonly string[]) {
  const value = Math.min(...values.map((entry) => Date.parse(entry)));
  if (!Number.isFinite(value))
    throw new ApiError(
      "CAPABILITY_EXPIRY_INVALID",
      "确认或快照到期时间无效",
      409,
    );
  return new Date(Math.min(value, Date.now() + 600_000)).toISOString();
}
function profilePacketInputs(
  current: Awaited<ReturnType<typeof requireCurrentReleaseControlFacts>>,
) {
  const profile = current.target.profile;
  const hosts = profile.allowedHosts,
    paths = profile.allowedPathPrefixes;
  if (
    !Array.isArray(hosts) ||
    !Array.isArray(paths) ||
    !hosts.every(
      (value) =>
        typeof value === "string" &&
        value === value.toLowerCase() &&
        !value.includes("*") &&
        !value.includes("://"),
    ) ||
    !paths.every(
      (value) =>
        typeof value === "string" &&
        value.startsWith("/") &&
        !value.includes("*"),
    )
  )
    throw new ApiError(
      "TARGET_EXECUTION_PROFILE_INVALID",
      "目标执行域名或路径白名单未显式满足合同",
      409,
    );
  if (
    typeof current.build.artifactRef !== "string" ||
    !current.build.artifactRef
  )
    throw new ApiError(
      "ARTIFACT_REFERENCE_INVALID",
      "当前 Build 缺少可冻结制品路径",
      409,
    );
  return {
    hosts: [...hosts],
    paths: [...paths],
    artifactRef: current.build.artifactRef,
  };
}
async function issueCapabilities(
  db: D1Database,
  command: Command,
  principal: ManagementPrincipal,
  actor: string,
  requestSha: string,
) {
  exact(
    command.payload,
    ["articleId", "confirmationId"],
    "capabilities.issue payload",
  );
  const articleId = required(command.payload.articleId, "articleId"),
    confirmationId = required(command.payload.confirmationId, "confirmationId");
  boundary(principal, articleId);
  owner(principal);
  const confirmationRow = await db
    .prepare(
      "SELECT * FROM article_publish_confirmations WHERE id=? AND article_id=? AND state='confirmed' AND expires_at>?",
    )
    .bind(confirmationId, articleId, now())
    .first<Row>();
  if (
    !confirmationRow ||
    String(confirmationRow.owner_session_id) !== principal.sessionId ||
    String(confirmationRow.contract_sha256) !== CONTRACT
  )
    throw new ApiError(
      "CONFIRMATION_NOT_ISSUABLE",
      "确认不是当前 owner、文章或有效合同",
      409,
    );
  const existing = await db
    .prepare(
      "SELECT id FROM release_publish_capabilities_v2 WHERE confirmation_id=? LIMIT 1",
    )
    .bind(confirmationId)
    .first<Row>();
  if (existing)
    throw new ApiError("CAPABILITY_ALREADY_ISSUED", "该确认已签发能力", 409);
  const itemRows = await db
    .prepare(
      "SELECT * FROM article_publish_confirmation_items WHERE confirmation_id=? ORDER BY platform ASC",
    )
    .bind(confirmationId)
    .all<Row>();
  const items = itemRows.results ?? [];
  if (
    items.length !== 4 ||
    new Set(items.map((item) => String(item.platform))).size !== 4 ||
    REQUIRED_PLATFORMS.some(
      (platform) => !items.some((item) => item.platform === platform),
    ) ||
    items.some(
      (item) => String(item.release_id) === "" || String(item.build_id) === "",
    )
  )
    throw new ApiError(
      "CONFIRMATION_ITEMS_INVALID",
      "确认必须完整且恰好绑定四个平台",
      409,
    );
  const persistedItems: ConfirmationItem[] = items.map((item) => ({
    platform: asPlatform(String(item.platform)),
    releaseId: String(item.release_id),
    buildId: String(item.build_id),
    artifactSha256: String(item.artifact_sha256),
    targetAccount: String(item.target_account),
    readinessSnapshotSha256: String(item.readiness_snapshot_sha256),
  }));
  const persistedConfirmation = {
    schemaVersion: "wenmai.release-control/2.0",
    confirmationId: String(confirmationRow.id),
    ownerSessionId: String(confirmationRow.owner_session_id),
    articleId: String(confirmationRow.article_id),
    runId: String(confirmationRow.run_id),
    contractSha256: String(confirmationRow.contract_sha256),
    confirmedAt: String(confirmationRow.confirmed_at),
    expiresAt: String(confirmationRow.expires_at),
    items: [...persistedItems].sort((left, right) =>
      left.platform.localeCompare(right.platform),
    ),
    setSha256: String(confirmationRow.item_set_sha256),
  };
  const confirmationValidation = await verifyArticlePublishConfirmation(
    persistedConfirmation,
    {
      articleId,
      runId: String(confirmationRow.run_id),
      contractSha256: CONTRACT,
      items: persistedItems,
    },
  );
  if (
    !confirmationValidation.ok ||
    String(confirmationRow.confirmation_sha256) !==
      String(confirmationRow.item_set_sha256)
  )
    throw new ApiError(
      "CONFIRMATION_BINDING_INVALID",
      "确认摘要或确认项绑定已漂移",
      409,
    );
  if (
    new Set(items.map((item) => String(item.article_id ?? articleId))).size !==
      1 ||
    String(confirmationRow.run_id) === ""
  )
    throw new ApiError(
      "CONFIRMATION_SCOPE_INVALID",
      "确认文章或 run 绑定无效",
      409,
    );
  const material: CapabilityMaterial[] = [];
  for (const itemRow of items) {
    const item: ConfirmationItem = {
      platform: asPlatform(String(itemRow.platform)),
      releaseId: String(itemRow.release_id),
      buildId: String(itemRow.build_id),
      artifactSha256: String(itemRow.artifact_sha256),
      targetAccount: String(itemRow.target_account),
      readinessSnapshotSha256: String(itemRow.readiness_snapshot_sha256),
    };
    const snapshot = await db
      .prepare(
        "SELECT * FROM release_readiness_snapshots WHERE snapshot_sha256=? AND release_id=? AND state='ready_to_submit' AND expires_at>?",
      )
      .bind(item.readinessSnapshotSha256, item.releaseId, now())
      .first<Row>();
    if (!snapshot)
      throw new ApiError(
        "READINESS_SNAPSHOT_DRIFTED",
        "确认项的 readiness 快照不再可用",
        409,
      );
    const currentRaw = await requireCurrentReleaseControlFacts(
        db,
        item.releaseId,
      ),
      current = facts(currentRaw);
    if (
      current.articleId !== articleId ||
      current.runId !== String(confirmationRow.run_id) ||
      current.platform !== item.platform ||
      current.buildId !== item.buildId ||
      current.artifactSha256 !== item.artifactSha256 ||
      String(snapshot.target_account) !== item.targetAccount ||
      String(snapshot.run_id) !== current.runId ||
      String(snapshot.build_id) !== item.buildId ||
      String(snapshot.artifact_sha256) !== item.artifactSha256 ||
      String(snapshot.platform) !== item.platform
    )
      throw new ApiError(
        "RELEASE_FACTS_DRIFTED",
        "确认项与当前 Release facts 已漂移",
        409,
      );
    const freeze = await db
      .prepare(
        "SELECT release_id FROM release_external_action_freezes_v2 WHERE release_id=? AND status='frozen' LIMIT 1",
      )
      .bind(item.releaseId)
      .first<Row>();
    if (freeze)
      throw new ApiError("RELEASE_FROZEN", "Release 已冻结，禁止签发", 409);
    const priorCapability = await db
      .prepare(
        "SELECT id FROM release_publish_capabilities_v2 WHERE release_id=? AND status NOT IN ('expired','revoked') LIMIT 1",
      )
      .bind(item.releaseId)
      .first<Row>();
    if (priorCapability)
      throw new ApiError(
        "RELEASE_CAPABILITY_ALREADY_EXISTS",
        "Release 已绑定未撤销的一次性能力",
        409,
      );
    const snap = {
      schemaVersion: "wenmai.release-control/2.0",
      state: "ready_to_submit",
      articleId: String(snapshot.article_id),
      runId: String(snapshot.run_id),
      releaseId: String(snapshot.release_id),
      buildId: String(snapshot.build_id),
      platform: String(snapshot.platform),
      artifactSha256: String(snapshot.artifact_sha256),
      targetAccount: String(snapshot.target_account),
      publicationVersionSha256: String(snapshot.publication_version_sha256),
      profileSha256: String(snapshot.profile_sha256),
      contractSha256: String(snapshot.contract_sha256),
      prepareReceiptHeadSha256: String(snapshot.prepare_receipt_head_sha256),
      domContractSha256: String(snapshot.dom_contract_sha256),
      createdAt: String(snapshot.created_at),
      expiresAt: String(snapshot.expires_at),
      snapshotSha256: String(snapshot.snapshot_sha256),
    };
    if (!(await verifyReleaseReadinessSnapshot(snap, current)).ok)
      throw new ApiError(
        "READINESS_SNAPSHOT_DRIFTED",
        "readiness 快照校验失败",
        409,
      );
    const config = profilePacketInputs(currentRaw),
      issuedAt = now(),
      expiresAt = earliestExpiry([
        String(confirmationRow.expires_at),
        String(snapshot.expires_at),
      ]),
      capabilityId = id("capability"),
      nonce =
        crypto.randomUUID().replace(/-/gu, "") +
        crypto.randomUUID().replace(/-/gu, "");
    const packet = await createFrozenExecutionPacket({
      schemaVersion: "wenmai.release-execution-packet/2.0",
      executor: {
        role: "browser_mechanical_executor",
        agentProfileId: "wenmai_publish_operator",
      },
      runId: current.runId,
      articleId,
      attempt: 1,
      commandId: command.commandId,
      contract: { revision: 1, sha256: CONTRACT },
      platform: current.platform,
      releaseId: current.releaseId,
      buildId: current.buildId,
      artifact: { path: config.artifactRef, sha256: current.artifactSha256 },
      targetAccount: item.targetAccount,
      allowedHosts: config.hosts,
      allowedPathPrefixes: config.paths,
      phase: "publish_once",
      allowedActions: [...PUBLISH_ONCE_ACTIONS],
      stopConditions: [...MANDATORY_STOP_CONDITIONS],
      createdAt: issuedAt,
    });
    material.push({ capabilityId, nonce, packet, item, snapshot, expiresAt });
  }
  const response = {
    capabilities: material.map(
      ({ capabilityId, nonce, packet, expiresAt, item, snapshot }) => ({
        capabilityId,
        nonce,
        executionPacket: packet,
        confirmationId,
        articleId,
        runId: String(confirmationRow.run_id),
        releaseId: item.releaseId,
        buildId: item.buildId,
        platform: item.platform,
        targetAccount: item.targetAccount,
        artifactSha256: item.artifactSha256,
        readinessSnapshotSha256: item.readinessSnapshotSha256,
        domContractSha256: String(snapshot.dom_contract_sha256),
        contractSha256: CONTRACT,
        issuedAt: packet.createdAt,
        expiresAt,
        maxClicks: 1,
      }),
    ),
    externalActionExecuted: false,
    claims: {
      submission_accepted: false,
      destination_record_verified: false,
      public_access_verified: false,
      outcome_verified: "unknown",
    },
  };
  const receiptData = {
    capabilityIds: material.map((entry) => entry.capabilityId),
    platforms: material.map((entry) => entry.item.platform),
    expiresAt: material[0]?.expiresAt,
    secretDelivered: true,
    externalActionExecuted: false,
  };
  try {
    const inserts = await Promise.all(
      material.map(async (entry) =>
        db
          .prepare(
            "INSERT INTO release_publish_capabilities_v2(id,confirmation_id,article_id,run_id,build_id,release_id,platform,execution_packet_json,packet_json_sha256,packet_sha256,artifact_sha256,readiness_snapshot_sha256,dom_contract_sha256,target_account,nonce_sha256,max_clicks,status,issued_at,expires_at,consumed_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'issued',?,?,NULL)",
          )
          .bind(
            entry.capabilityId,
            confirmationId,
            articleId,
            String(confirmationRow.run_id),
            entry.item.buildId,
            entry.item.releaseId,
            entry.item.platform,
            canonicalExecutionJson(entry.packet),
            await sha256ExecutionJson(entry.packet),
            entry.packet.packetSha256,
            entry.item.artifactSha256,
            entry.item.readinessSnapshotSha256,
            String(entry.snapshot.dom_contract_sha256),
            entry.item.targetAccount,
            await sha256ExecutionText(entry.nonce),
            1,
            entry.packet.createdAt,
            entry.expiresAt,
          ),
      ),
    );
    await db.batch([
      ...inserts,
      receipt(db, command, actor, requestSha, receiptData),
    ]);
  } catch {
    const written = await db
      .prepare(
        "SELECT id FROM release_publish_capabilities_v2 WHERE confirmation_id=? LIMIT 1",
      )
      .bind(confirmationId)
      .first<Row>();
    if (written)
      throw new ApiError(
        "CAPABILITY_ALREADY_ISSUED",
        "能力写入冲突或已存在，拒绝重签",
        409,
      );
    throw new ApiError(
      "COMMAND_WRITE_UNCONFIRMED",
      "能力签发写入结果未确认",
      503,
    );
  }
  return response;
}
export async function POST(request: Request) {
  const requestId = id("rcv2-request");
  try {
    const command = await parse(request);
    const db = database();
    await ensureReleaseControlV2Schema(db);
    if (!bindings().enabled)
      throw new ApiError(
        "CONTROL_PLANE_DISABLED",
        "Release Control V2 写入未启用",
        503,
      );
    const principal = await management(
      request,
      command.action === "readiness.record"
        ? "release.record"
        : "release.approve",
      true,
    );
    const actor = managementActorId(principal),
      requestSha = await digest(command),
      prior = await replay(db, command, actor, requestSha);
    if (prior) return ok(requestId, prior, true);
    return ok(
      requestId,
      command.action === "readiness.record"
        ? await readiness(db, command, principal, actor, requestSha)
        : command.action === "confirmation.create"
          ? await confirmation(db, command, principal, actor, requestSha)
          : await issueCapabilities(db, command, principal, actor, requestSha),
    );
  } catch (error) {
    return fail(requestId, error);
  }
}
