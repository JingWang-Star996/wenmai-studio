import { env } from "cloudflare:workers";
import corpusData from "../../../../data/corpus.generated.json";
import { ManagementAuthError } from "../../../management-auth-core";
import { managementActorId, requireManagementSession } from "../../../management-auth";

export const runtime = "edge";

type D1Row = Record<string, string | number | null>;
type JsonObject = Record<string, unknown>;
type MutationResult = { status?: number; data: JsonObject };

const API_VERSION = "wenmai-article-identity-v1";
const MAX_REQUEST_BYTES = 512_000;
const MAX_LIMIT = 200;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u;
const SHA256_RE = /^[a-f0-9]{64}$/u;
const ACTIONS = new Set([
  "scan_candidates",
  "plan_consolidation",
  "apply_consolidation",
  "plan_source_owner_repair",
  "apply_source_owner_repair",
  "supersede_stale_operation",
  "rollback_operation",
]);
const VIEWS = new Set(["catalog", "identity", "candidates", "integrity", "operation", "source_owner_mismatches"]);

const corpus = corpusData as unknown as {
  schemaVersion: string;
  algorithmVersion: string;
  generatedAt: string;
  articles: Array<{
    id: string;
    title: string;
    versions: Array<{ id: string; textHash?: string; contentHash?: string }>;
  }>;
};

class ArticleIdentityApiError extends Error {
  status: number;
  code: string;
  details?: JsonObject;

  constructor(code: string, message: string, status = 400, details?: JsonObject) {
    super(message);
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function responseId() {
  return `req-${crypto.randomUUID()}`;
}

function jsonSuccess(id: string, data: JsonObject, status = 200) {
  return Response.json({ ok: true, requestId: id, data }, {
    status,
    headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" },
  });
}

function jsonError(id: string, error: unknown) {
  const apiError = error instanceof ArticleIdentityApiError || error instanceof ManagementAuthError
    ? new ArticleIdentityApiError(error.code, error.message, error.status, error.details)
    : new ArticleIdentityApiError("INTERNAL_ERROR", "文章身份中台处理失败", 500);
  return Response.json({
    ok: false,
    requestId: id,
    error: { code: apiError.code, message: apiError.message, ...(apiError.details ? { details: apiError.details } : {}) },
  }, {
    status: apiError.status,
    headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" },
  });
}

function database() {
  if (!env.DB) throw new ArticleIdentityApiError("DB_UNAVAILABLE", "本地文章身份数据库尚未连接", 503);
  return env.DB;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (isObject(value)) {
    return Object.fromEntries(Object.keys(value).sort().filter((key) => value[key] !== undefined)
      .map((key) => [key, canonicalValue(value[key])]));
  }
  return value === undefined ? null : value;
}

function canonicalJson(value: unknown) {
  return JSON.stringify(canonicalValue(value));
}

async function sha256Text(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (item) => item.toString(16).padStart(2, "0")).join("");
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string" || !value) return fallback;
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

function cleanText(value: unknown, maximum = 240) {
  if (typeof value !== "string") return "";
  return value.trim().replace(/\s+/gu, " ").slice(0, maximum);
}

function requiredText(value: unknown, field: string, maximum = 240) {
  const result = cleanText(value, maximum + 1);
  if (!result) throw new ArticleIdentityApiError("MISSING_FIELD", `缺少 ${field}`, 400, { field });
  if (result.length > maximum) throw new ArticleIdentityApiError("FIELD_TOO_LARGE", `${field} 超过长度限制`, 413, { field, maximum });
  return result;
}

function requiredId(value: unknown, field: string) {
  const result = requiredText(value, field, 200);
  if (!ID_RE.test(result)) throw new ArticleIdentityApiError("INVALID_ID", `${field} 格式无效`, 400, { field });
  return result;
}

function requiredSha(value: unknown, field: string) {
  const result = requiredText(value, field, 64).toLowerCase();
  if (!SHA256_RE.test(result)) throw new ArticleIdentityApiError("INVALID_SHA256", `${field} 必须是 64 位小写 SHA-256`, 400, { field });
  return result;
}

function stringArray(value: unknown, field: string, maximum = 30) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > maximum) {
    throw new ArticleIdentityApiError("INVALID_FIELD", `${field} 必须是最多 ${maximum} 项的数组`, 400, { field });
  }
  return value.map((item, index) => requiredText(item, `${field}[${index}]`, 500));
}

function isoNow() {
  return new Date().toISOString();
}

async function parseMutationBody(request: Request) {
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > MAX_REQUEST_BYTES) {
    throw new ArticleIdentityApiError("REQUEST_TOO_LARGE", "文章身份请求过大", 413);
  }
  let body: unknown;
  try { body = JSON.parse(raw); } catch { throw new ArticleIdentityApiError("INVALID_JSON", "请求正文不是有效 JSON"); }
  if (!isObject(body)) throw new ArticleIdentityApiError("INVALID_JSON", "请求正文必须是 JSON 对象");
  const action = requiredText(body.action, "action", 80);
  if (!ACTIONS.has(action)) throw new ArticleIdentityApiError("UNKNOWN_ACTION", `未知文章身份动作：${action}`, 404);
  const commandId = requiredId(body.commandId, "commandId");
  if (!isObject(body.payload)) throw new ArticleIdentityApiError("INVALID_PAYLOAD", "payload 必须是 JSON 对象");
  return { action, commandId, payload: body.payload };
}

const RUNTIME_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS command_receipts (
    id TEXT PRIMARY KEY NOT NULL, command_type TEXT NOT NULL, actor_id TEXT NOT NULL,
    request_sha256 TEXT NOT NULL, response_json TEXT NOT NULL DEFAULT '{}',
    status_code INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, completed_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS article_identities (
    id TEXT PRIMARY KEY NOT NULL, canonical_article_id TEXT NOT NULL, title TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','archived')),
    visibility TEXT NOT NULL DEFAULT 'primary' CHECK(visibility IN ('primary','hidden')),
    lock_version INTEGER NOT NULL DEFAULT 1 CHECK(lock_version >= 1), created_by TEXT NOT NULL,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS article_identity_members (
    id TEXT PRIMARY KEY NOT NULL, identity_id TEXT NOT NULL, object_kind TEXT NOT NULL
      CHECK(object_kind IN ('article','branch','revision','package','corpus_article','corpus_version','artifact')),
    object_id TEXT NOT NULL, article_id TEXT, revision_id TEXT, body_sha256 TEXT,
    role TEXT NOT NULL CHECK(role IN ('canonical','legacy_root','branch','revision','adaptation','source','auxiliary','owner_repair')),
    state TEXT NOT NULL DEFAULT 'active' CHECK(state IN ('active','superseded','archived')),
    hidden_from_primary INTEGER NOT NULL DEFAULT 0, evidence_json TEXT NOT NULL DEFAULT '[]',
    input_sha256 TEXT NOT NULL, operation_id TEXT NOT NULL, lock_version INTEGER NOT NULL DEFAULT 1 CHECK(lock_version >= 1),
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    CHECK(body_sha256 IS NULL OR (length(body_sha256)=64 AND body_sha256 NOT GLOB '*[^0-9a-f]*')),
    CHECK(length(input_sha256)=64 AND input_sha256 NOT GLOB '*[^0-9a-f]*')
  )`,
  `CREATE TABLE IF NOT EXISTS article_lineage_links (
    id TEXT PRIMARY KEY NOT NULL, identity_id TEXT, relation_type TEXT NOT NULL,
    source_kind TEXT NOT NULL, source_id TEXT NOT NULL, source_article_id TEXT, source_revision_id TEXT,
    source_body_sha256 TEXT, target_kind TEXT NOT NULL, target_id TEXT NOT NULL, target_article_id TEXT,
    target_revision_id TEXT, target_body_sha256 TEXT,
    status TEXT NOT NULL DEFAULT 'candidate' CHECK(status IN ('candidate','confirmed','rejected','superseded')),
    evidence_json TEXT NOT NULL DEFAULT '[]', input_sha256 TEXT NOT NULL, operation_id TEXT NOT NULL,
    decided_by TEXT, decided_at TEXT, lock_version INTEGER NOT NULL DEFAULT 1 CHECK(lock_version >= 1),
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    CHECK(source_body_sha256 IS NULL OR (length(source_body_sha256)=64 AND source_body_sha256 NOT GLOB '*[^0-9a-f]*')),
    CHECK(target_body_sha256 IS NULL OR (length(target_body_sha256)=64 AND target_body_sha256 NOT GLOB '*[^0-9a-f]*')),
    CHECK(length(input_sha256)=64 AND input_sha256 NOT GLOB '*[^0-9a-f]*')
  )`,
  `CREATE TABLE IF NOT EXISTS article_identity_operations (
    id TEXT PRIMARY KEY NOT NULL, operation_kind TEXT NOT NULL
      CHECK(operation_kind IN ('candidate_scan','consolidation','source_owner_repair','candidate_decision')),
    status TEXT NOT NULL DEFAULT 'planned' CHECK(status IN ('planned','applied','rolled_back')),
    identity_id TEXT, command_id TEXT NOT NULL, actor_id TEXT NOT NULL, applied_by TEXT, rolled_back_by TEXT,
    plan_json TEXT NOT NULL, plan_sha256 TEXT NOT NULL, preconditions_json TEXT NOT NULL,
    preconditions_sha256 TEXT NOT NULL, inverse_json TEXT NOT NULL, result_json TEXT NOT NULL DEFAULT '{}',
    sentinel TEXT NOT NULL, lock_version INTEGER NOT NULL DEFAULT 1 CHECK(lock_version >= 1),
    planned_at TEXT NOT NULL, applied_at TEXT, rolled_back_at TEXT, updated_at TEXT NOT NULL,
    CHECK(length(plan_sha256)=64 AND plan_sha256 NOT GLOB '*[^0-9a-f]*'),
    CHECK(length(preconditions_sha256)=64 AND preconditions_sha256 NOT GLOB '*[^0-9a-f]*')
  )`,
];

const RUNTIME_INDEXES = [
  "CREATE INDEX IF NOT EXISTS idx_command_receipts_actor_created ON command_receipts(actor_id, created_at)",
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_article_identities_canonical_article ON article_identities(canonical_article_id)",
  "CREATE INDEX IF NOT EXISTS idx_article_identities_status_updated ON article_identities(status, updated_at)",
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_article_identity_members_object ON article_identity_members(object_kind, object_id)",
  "CREATE INDEX IF NOT EXISTS idx_article_identity_members_identity_state ON article_identity_members(identity_id, state, object_kind)",
  "CREATE INDEX IF NOT EXISTS idx_article_identity_members_article ON article_identity_members(article_id, state)",
  "CREATE INDEX IF NOT EXISTS idx_article_identity_members_operation ON article_identity_members(operation_id)",
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_article_lineage_links_relation ON article_lineage_links(relation_type, source_kind, source_id, target_kind, target_id)",
  "CREATE INDEX IF NOT EXISTS idx_article_lineage_links_identity_status ON article_lineage_links(identity_id, status, updated_at)",
  "CREATE INDEX IF NOT EXISTS idx_article_lineage_links_operation ON article_lineage_links(operation_id)",
  "CREATE INDEX IF NOT EXISTS idx_article_lineage_links_articles ON article_lineage_links(source_article_id, target_article_id)",
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_article_identity_operations_command ON article_identity_operations(command_id)",
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_article_identity_operations_sentinel ON article_identity_operations(sentinel)",
  "CREATE INDEX IF NOT EXISTS idx_article_identity_operations_identity_status ON article_identity_operations(identity_id, status, updated_at)",
];

let schemaBootstrap: Promise<void> | null = null;

async function ensureArticleIdentitySchema() {
  const db = database();
  if (!schemaBootstrap) {
    schemaBootstrap = (async () => {
      await db.batch(RUNTIME_SCHEMA.map((statement) => db.prepare(statement)));
      await db.batch(RUNTIME_INDEXES.map((statement) => db.prepare(statement)));
    })().catch((error) => { schemaBootstrap = null; throw error; });
  }
  await schemaBootstrap;
  return db;
}

async function inspectReceipt(db: D1Database, commandId: string, commandType: string, actorId: string, requestSha256: string) {
  const row = await db.prepare("SELECT * FROM command_receipts WHERE id = ? LIMIT 1").bind(commandId).first<D1Row>();
  if (!row) return null;
  if (row.command_type !== commandType || row.actor_id !== actorId || row.request_sha256 !== requestSha256) {
    throw new ArticleIdentityApiError("COMMAND_ID_REUSED", "同一 commandId 已绑定不同动作、身份或请求摘要", 409);
  }
  if (Number(row.status_code) === 0) throw new ArticleIdentityApiError("COMMAND_IN_PROGRESS", "同一命令仍在处理或需要恢复审计", 409);
  const saved = parseJson<{ data?: JsonObject; error?: { code?: string; message?: string; details?: JsonObject } }>(row.response_json, {});
  if (Number(row.status_code) >= 400) {
    throw new ArticleIdentityApiError(cleanText(saved.error?.code, 120) || "COMMAND_FAILED",
      cleanText(saved.error?.message, 2_000) || "该幂等命令此前已经失败", Number(row.status_code), saved.error?.details);
  }
  return { status: Number(row.status_code), data: saved.data ?? {} };
}

async function withReceipt(
  db: D1Database,
  action: string,
  actorId: string,
  commandId: string,
  payload: JsonObject,
  handler: (inputSha256: string) => Promise<MutationResult>,
) {
  const commandType = `article_identity.v1.${action}`;
  const requestSha256 = await sha256Text(canonicalJson({ action, actorId, payload }));
  const replay = await inspectReceipt(db, commandId, commandType, actorId, requestSha256);
  if (replay) return replay;
  try {
    await db.prepare(`INSERT INTO command_receipts
      (id, command_type, actor_id, request_sha256, response_json, status_code)
      VALUES (?, ?, ?, ?, '{}', 0)`).bind(commandId, commandType, actorId, requestSha256).run();
  } catch {
    const raced = await inspectReceipt(db, commandId, commandType, actorId, requestSha256);
    if (raced) return raced;
    throw new ArticleIdentityApiError("COMMAND_IN_PROGRESS", "命令领取发生竞争，请稍后重试", 409);
  }
  try {
    const result = await handler(requestSha256);
    const status = result.status ?? 200;
    await db.prepare(`UPDATE command_receipts SET response_json = ?, status_code = ?, completed_at = ?
      WHERE id = ? AND command_type = ? AND actor_id = ? AND request_sha256 = ? AND status_code = 0`)
      .bind(canonicalJson({ data: result.data }), status, isoNow(), commandId, commandType, actorId, requestSha256).run();
    return { status, data: result.data };
  } catch (error) {
    const failure = error instanceof ArticleIdentityApiError
      ? error : new ArticleIdentityApiError("INTERNAL_ERROR", "文章身份中台处理失败", 500);
    await db.prepare(`UPDATE command_receipts SET response_json = ?, status_code = ?, completed_at = ?
      WHERE id = ? AND command_type = ? AND actor_id = ? AND request_sha256 = ? AND status_code = 0`)
      .bind(canonicalJson({ error: { code: failure.code, message: failure.message, details: failure.details } }),
        failure.status, isoNow(), commandId, commandType, actorId, requestSha256).run();
    throw failure;
  }
}

function boundedLimit(url: URL, fallback = 50) {
  const value = Number(url.searchParams.get("limit") ?? fallback);
  if (!Number.isInteger(value) || value < 1 || value > MAX_LIMIT) {
    throw new ArticleIdentityApiError("INVALID_LIMIT", `limit 必须在 1 到 ${MAX_LIMIT} 之间`);
  }
  return value;
}

async function catalogView(db: D1Database, url: URL) {
  const limit = boundedLimit(url, 100);
  const rows = await db.prepare(`WITH article_ids AS (
      SELECT article_id FROM article_revisions
      UNION SELECT article_id FROM article_branches
      UNION SELECT article_id FROM article_project_packages
    )
    SELECT ids.article_id,
      COALESCE((SELECT title FROM article_revisions r WHERE r.article_id=ids.article_id ORDER BY r.created_at DESC, r.sequence DESC LIMIT 1), ids.article_id) title,
      (SELECT id FROM article_project_packages p WHERE p.article_id=ids.article_id ORDER BY (p.status='active') DESC, p.updated_at DESC, p.id LIMIT 1) package_id,
      (SELECT status FROM article_project_packages p WHERE p.article_id=ids.article_id ORDER BY (p.status='active') DESC, p.updated_at DESC, p.id LIMIT 1) package_status,
      COALESCE(
        (SELECT primary_branch_id FROM article_project_packages p WHERE p.article_id=ids.article_id AND p.primary_branch_id IS NOT NULL ORDER BY (p.status='active') DESC, p.updated_at DESC LIMIT 1),
        (SELECT id FROM article_branches b WHERE b.article_id=ids.article_id ORDER BY (b.status='active') DESC, b.updated_at DESC, b.id LIMIT 1)
      ) primary_branch_id,
      COALESCE(
        (SELECT b.head_revision_id FROM article_project_packages p JOIN article_branches b ON b.id=p.primary_branch_id
          WHERE p.article_id=ids.article_id ORDER BY (p.status='active') DESC, p.updated_at DESC LIMIT 1),
        (SELECT head_revision_id FROM article_branches b WHERE b.article_id=ids.article_id ORDER BY (b.status='active') DESC, b.updated_at DESC, b.id LIMIT 1)
      ) head_revision_id,
      COALESCE(
        (SELECT r.body_sha256 FROM article_project_packages p JOIN article_branches b ON b.id=p.primary_branch_id
          JOIN article_revisions r ON r.id=b.head_revision_id WHERE p.article_id=ids.article_id
          ORDER BY (p.status='active') DESC, p.updated_at DESC LIMIT 1),
        (SELECT r.body_sha256 FROM article_branches b JOIN article_revisions r ON r.id=b.head_revision_id
          WHERE b.article_id=ids.article_id ORDER BY (b.status='active') DESC, b.updated_at DESC, b.id LIMIT 1)
      ) head_body_sha256,
      (SELECT COUNT(*) FROM article_revisions r WHERE r.article_id=ids.article_id) revision_count,
      (SELECT COUNT(*) FROM article_branches b WHERE b.article_id=ids.article_id) branch_count,
      (SELECT COUNT(*) FROM article_branches b WHERE b.article_id=ids.article_id AND b.status='active') active_branch_count,
      (SELECT COUNT(*) FROM article_branches b WHERE b.article_id=ids.article_id AND b.status='archived') archived_branch_count,
      (SELECT COUNT(*) FROM branch_working_copies w WHERE w.article_id=ids.article_id AND w.dirty=1) dirty_working_count,
      (SELECT COUNT(*) FROM article_project_packages p WHERE p.article_id=ids.article_id AND p.status='active') active_package_count,
      (SELECT COUNT(*) FROM article_project_packages p WHERE p.article_id=ids.article_id AND p.status='archived') archived_package_count,
      MAX(0, (SELECT COUNT(*) FROM article_branches b WHERE b.article_id=ids.article_id AND b.status='active') - 1)
        + (SELECT COUNT(*) FROM merge_proposals mp WHERE mp.article_id=ids.article_id AND mp.status IN ('prepared','resolving','ready')) unmerged_count,
      (SELECT COUNT(*) FROM article_lineage_links l WHERE l.status='candidate' AND (l.source_article_id=ids.article_id OR l.target_article_id=ids.article_id)) pending_candidate_count,
      COALESCE((SELECT MIN(created_at) FROM article_revisions r WHERE r.article_id=ids.article_id),
        (SELECT MIN(created_at) FROM article_branches b WHERE b.article_id=ids.article_id),
        (SELECT MIN(created_at) FROM article_project_packages p WHERE p.article_id=ids.article_id)) created_at,
      MAX(COALESCE((SELECT MAX(created_at) FROM article_revisions r WHERE r.article_id=ids.article_id),''),
        COALESCE((SELECT MAX(updated_at) FROM article_branches b WHERE b.article_id=ids.article_id),''),
        COALESCE((SELECT MAX(updated_at) FROM article_project_packages p WHERE p.article_id=ids.article_id),'')) updated_at,
      i.id identity_id, i.canonical_article_id, i.status identity_status, i.visibility identity_visibility,
      m.role member_role, m.state member_state, m.hidden_from_primary,
      (SELECT COUNT(*) FROM article_identity_members im WHERE im.identity_id=i.id AND im.role='legacy_root' AND im.state<>'archived') legacy_root_count,
      (SELECT COUNT(*) FROM article_identity_members im WHERE im.identity_id=i.id AND im.state<>'archived') identity_member_count
    FROM article_ids ids
    LEFT JOIN article_identity_members m ON m.object_kind='article' AND m.object_id=ids.article_id AND m.state<>'archived'
    LEFT JOIN article_identities i ON i.id=m.identity_id
    ORDER BY title COLLATE NOCASE, ids.article_id LIMIT ?`).bind(limit).all<D1Row>();
  const articleIds = rows.results.map((row) => String(row.article_id));
  const revisionRows = articleIds.length
    ? await db.prepare(`SELECT id, article_id, title, document_title, sequence, branch_id, body_sha256,
        length(body_text) char_count, created_at, annotation, author_kind
        FROM article_revisions WHERE article_id IN (${articleIds.map(() => "?").join(",")})
        ORDER BY article_id, created_at, sequence, id`).bind(...articleIds).all<D1Row>()
    : { results: [] as D1Row[] };
  const revisionsByArticle = new Map<string, JsonObject[]>();
  for (const revision of revisionRows.results) {
    const articleId = String(revision.article_id);
    const values = revisionsByArticle.get(articleId) ?? [];
    values.push({
      id: String(revision.id), title: String(revision.title), documentTitle: String(revision.document_title),
      sequence: Number(revision.sequence), branchId: String(revision.branch_id), bodySha256: String(revision.body_sha256),
      charCount: Number(revision.char_count), createdAt: String(revision.created_at), annotation: String(revision.annotation),
      authorKind: String(revision.author_kind),
    });
    revisionsByArticle.set(articleId, values);
  }
  const localArticles = rows.results.map((row) => {
    const activeBranchCount = Number(row.active_branch_count);
    const activePackageCount = Number(row.active_package_count);
    const overlayHidden = Number(row.hidden_from_primary ?? 0) === 1 || row.identity_visibility === "hidden";
    const hasArchived = Number(row.archived_branch_count) > 0 || Number(row.archived_package_count) > 0;
    const catalogState = overlayHidden ? "hidden" : (activeBranchCount > 0 || activePackageCount > 0 ? "active" : (hasArchived ? "archived" : "hidden"));
    const canonicalArticleId = row.canonical_article_id === null ? String(row.article_id) : String(row.canonical_article_id);
    return {
      articleId: String(row.article_id), title: String(row.title),
      packageId: row.package_id === null ? null : String(row.package_id),
      packageStatus: row.package_status === null ? null : String(row.package_status),
      primaryBranchId: row.primary_branch_id === null ? null : String(row.primary_branch_id),
      headRevisionId: row.head_revision_id === null ? null : String(row.head_revision_id),
      headBodySha256: row.head_body_sha256 === null ? null : String(row.head_body_sha256),
      revisionCount: Number(row.revision_count), branchCount: Number(row.branch_count), activeBranchCount,
      archivedBranchCount: Number(row.archived_branch_count), unmergedBranchCount: Number(row.unmerged_count),
      dirtyWorkingCopyCount: Number(row.dirty_working_count),
      identityId: row.identity_id === null ? null : String(row.identity_id), canonicalArticleId,
      identityRole: row.member_role === null ? null : String(row.member_role), catalogState,
      legacyRootCount: Number(row.legacy_root_count ?? 0), identityMemberCount: Number(row.identity_member_count ?? 0),
      pendingCandidateCount: Number(row.pending_candidate_count), createdAt: row.created_at === null ? null : String(row.created_at),
      updatedAt: row.updated_at === null ? null : String(row.updated_at),
      revisions: revisionsByArticle.get(String(row.article_id)) ?? [],
      canonicalRedirect: canonicalArticleId === String(row.article_id) ? null : { articleId: canonicalArticleId },
    };
  });
  const [identityRows, candidateRows] = await Promise.all([
    db.prepare(`SELECT i.*,
      (SELECT COUNT(*) FROM article_identity_members m WHERE m.identity_id=i.id AND m.state<>'archived') member_count,
      (SELECT COUNT(*) FROM article_identity_members m WHERE m.identity_id=i.id AND m.role='legacy_root' AND m.state<>'archived') legacy_root_count,
      (SELECT COUNT(*) FROM article_lineage_links l WHERE l.identity_id=i.id AND l.status='candidate') candidate_count,
      (SELECT COUNT(*) FROM article_lineage_links l WHERE l.identity_id=i.id AND l.status='confirmed') confirmed_link_count
      FROM article_identities i ORDER BY i.updated_at DESC, i.id`).all<D1Row>(),
    db.prepare("SELECT * FROM article_lineage_links WHERE status='candidate' ORDER BY created_at DESC, id DESC LIMIT ?").bind(limit).all<D1Row>(),
  ]);
  const identities = [] as JsonObject[];
  for (const identity of identityRows.results) {
    const members = await db.prepare(`SELECT id, object_kind, object_id, article_id, revision_id, body_sha256,
      role, state, hidden_from_primary, lock_version, created_at, updated_at
      FROM article_identity_members WHERE identity_id=? ORDER BY object_kind, object_id`).bind(identity.id).all<D1Row>();
    identities.push({
      id: String(identity.id), canonicalArticleId: String(identity.canonical_article_id), title: String(identity.title),
      status: String(identity.status), lockVersion: Number(identity.lock_version), members: members.results,
      counts: { memberCount: Number(identity.member_count), legacyRootCount: Number(identity.legacy_root_count),
        candidateCount: Number(identity.candidate_count), confirmedLinkCount: Number(identity.confirmed_link_count) },
    });
  }
  const candidates = candidateRows.results.map((row) => {
    const evidence = parseJson<Array<JsonObject>>(row.evidence_json, []);
    const deterministic = evidence.find((item) => item.kind === "deterministic_similarity") ?? {};
    return {
      id: String(row.id), sourceArticleId: row.source_article_id, sourceRevisionId: row.source_revision_id,
      sourceBodySha256: row.source_body_sha256, targetArticleId: row.target_article_id,
      targetRevisionId: row.target_revision_id, targetBodySha256: row.target_body_sha256,
      proposedRelation: String(row.relation_type), state: String(row.status),
      score: typeof deterministic.score === "number" ? deterministic.score : null,
      signals: isObject(deterministic.signals) ? deterministic.signals : {}, evidence,
      lockVersion: Number(row.lock_version),
    };
  });
  return {
    apiVersion: API_VERSION, localArticles, identities, candidates,
    counts: {
      localArticles: localArticles.length, active: localArticles.filter((item) => item.catalogState === "active").length,
      archived: localArticles.filter((item) => item.catalogState === "archived").length,
      hidden: localArticles.filter((item) => item.catalogState === "hidden").length,
      identities: identities.length, pendingCandidates: candidates.length,
    },
    limit,
  };
}

async function identityView(db: D1Database, url: URL) {
  const requested = requiredId(url.searchParams.get("identityId") ?? url.searchParams.get("articleId"), "identityId/articleId");
  const identity = await db.prepare("SELECT * FROM article_identities WHERE id=? OR canonical_article_id=? LIMIT 1")
    .bind(requested, requested).first<D1Row>();
  if (!identity) throw new ArticleIdentityApiError("IDENTITY_NOT_FOUND", "没有找到文章身份", 404, { requested });
  const [members, links, operations] = await Promise.all([
    db.prepare("SELECT * FROM article_identity_members WHERE identity_id=? ORDER BY object_kind, object_id").bind(identity.id).all<D1Row>(),
    db.prepare("SELECT * FROM article_lineage_links WHERE identity_id=? ORDER BY created_at, id").bind(identity.id).all<D1Row>(),
    db.prepare("SELECT * FROM article_identity_operations WHERE identity_id=? ORDER BY planned_at DESC, id DESC").bind(identity.id).all<D1Row>(),
  ]);
  return { identity, members: members.results, links: links.results, operations: operations.results.map(parseOperationRow) };
}

async function candidatesView(db: D1Database, url: URL) {
  const limit = boundedLimit(url);
  const articleId = cleanText(url.searchParams.get("articleId"), 200);
  const query = articleId
    ? db.prepare(`SELECT * FROM article_lineage_links WHERE status='candidate'
        AND (source_article_id=? OR target_article_id=?) ORDER BY created_at DESC, id DESC LIMIT ?`).bind(articleId, articleId, limit)
    : db.prepare("SELECT * FROM article_lineage_links WHERE status='candidate' ORDER BY created_at DESC, id DESC LIMIT ?").bind(limit);
  const rows = await query.all<D1Row>();
  return { candidates: rows.results.map((row) => ({ ...row, evidence: parseJson(row.evidence_json, []) })), limit };
}

async function integrityView(db: D1Database) {
  const [checks, plannedRows, terminalCandidateRows, appliedRows] = await Promise.all([
    db.batch([
      db.prepare(`SELECT COUNT(*) count FROM article_identity_members m
        LEFT JOIN article_identities i ON i.id=m.identity_id WHERE i.id IS NULL`),
      db.prepare(`SELECT COUNT(*) count FROM article_lineage_links l
        LEFT JOIN article_identities i ON i.id=l.identity_id
        WHERE l.identity_id IS NOT NULL AND i.id IS NULL`),
      db.prepare(`SELECT COUNT(*) count FROM article_revisions r
        LEFT JOIN article_branches b ON b.id=r.branch_id
        WHERE b.id IS NULL OR b.article_id<>r.article_id`),
      db.prepare(`SELECT COUNT(*) count FROM branch_working_copies w
        LEFT JOIN article_branches b ON b.id=w.branch_id
        WHERE b.id IS NULL OR b.article_id<>w.article_id OR b.head_revision_id<>w.base_revision_id`),
      db.prepare(`SELECT COUNT(*) count FROM package_branch_states s
        JOIN article_project_packages p ON p.id=s.package_id
        JOIN article_branches b ON b.id=s.branch_id
        WHERE p.article_id<>b.article_id OR (p.status='archived' AND s.status='active')`),
    ]),
    db.prepare(`SELECT * FROM article_identity_operations
      WHERE operation_kind='consolidation' AND status='planned' ORDER BY planned_at, id`).all<D1Row>(),
    db.prepare(`SELECT * FROM article_lineage_links
      WHERE status IN ('confirmed','superseded') ORDER BY updated_at DESC, id`).all<D1Row>(),
    db.prepare(`SELECT * FROM article_identity_operations
      WHERE operation_kind='consolidation' AND status='applied' ORDER BY applied_at DESC, id`).all<D1Row>(),
  ]);
  const names = ["orphanMembers", "orphanLinks", "revisionBranchMismatches", "workingCopyMismatches", "packageStateMismatches"];
  const results = Object.fromEntries(checks.map((result, index) => [names[index], Number((result.results?.[0] as D1Row | undefined)?.count ?? 0)]));
  const terminalCandidates = new Map(terminalCandidateRows.results.map((row) => [String(row.id), row]));
  const appliedByCandidate = new Map<string, D1Row>();
  for (const row of appliedRows.results) {
    const candidateId = cleanText(parseJson<JsonObject>(row.plan_json, {}).candidateId, 200);
    if (candidateId && !appliedByCandidate.has(candidateId)) appliedByCandidate.set(candidateId, row);
  }
  const stalePlannedOperations = plannedRows.results.flatMap((row) => {
    const plan = parseJson<JsonObject>(row.plan_json, {});
    const preconditions = parseJson<JsonObject>(row.preconditions_json, {});
    const candidateId = cleanText(plan.candidateId, 200);
    if (!candidateId) return [];
    const candidatePrecondition = isObject(preconditions.candidate) ? preconditions.candidate : {};
    const terminalCandidate = terminalCandidates.get(candidateId) ?? null;
    const candidateProof = terminalCandidate !== null
      && String(terminalCandidate.input_sha256) === String(candidatePrecondition.inputSha256 ?? "")
      ? terminalCandidate : null;
    const appliedProof = appliedByCandidate.get(candidateId) ?? null;
    if (!candidateProof && !appliedProof) return [];
    return [{
      operationId: String(row.id),
      planSha256: String(row.plan_sha256),
      preconditionsSha256: String(row.preconditions_sha256),
      lockVersion: Number(row.lock_version),
      candidateId,
      plannedAt: String(row.planned_at),
      terminalProof: {
        candidate: candidateProof ? {
          status: String(candidateProof.status),
          inputSha256: String(candidateProof.input_sha256),
          lockVersion: Number(candidateProof.lock_version),
          decidedAt: candidateProof.decided_at === null ? null : String(candidateProof.decided_at),
          operationId: String(candidateProof.operation_id),
        } : null,
        appliedOperation: appliedProof ? {
          operationId: String(appliedProof.id),
          planSha256: String(appliedProof.plan_sha256),
          appliedAt: appliedProof.applied_at === null ? null : String(appliedProof.applied_at),
          lockVersion: Number(appliedProof.lock_version),
        } : null,
      },
      recommendedAction: "supersede_stale_operation",
    }];
  });
  return {
    result: Object.values(results).every((value) => value === 0) ? "pass" : "fail",
    checks: results,
    stalePlannedOperations,
    stalePlannedOperationCount: stalePlannedOperations.length,
  };
}

async function operationView(db: D1Database, url: URL) {
  const operationId = requiredId(url.searchParams.get("operationId"), "operationId");
  const operation = await db.prepare("SELECT * FROM article_identity_operations WHERE id=? LIMIT 1").bind(operationId).first<D1Row>();
  if (!operation) throw new ArticleIdentityApiError("OPERATION_NOT_FOUND", "没有找到文章身份操作", 404, { operationId });
  return { operation: parseOperationRow(operation) };
}

function parseOperationRow(operation: D1Row) {
  const result = parseJson<JsonObject>(operation.result_json, {});
  const effectiveStatus = operation.status === "rolled_back" && result.terminalDisposition === "superseded"
    ? "superseded" : String(operation.status);
  return {
    ...operation,
    effectiveStatus,
    plan: parseJson(operation.plan_json, {}),
    preconditions: parseJson(operation.preconditions_json, {}),
    inverse: parseJson(operation.inverse_json, {}),
    result,
  };
}

function corpusOwnerMatches(versionId: string) {
  const matches: Array<{ articleId: string; articleTitle: string; versionId: string; textHash: string; contentHash: string }> = [];
  for (const article of corpus.articles) {
    for (const version of article.versions ?? []) {
      if (version.id === versionId) matches.push({
        articleId: article.id,
        articleTitle: article.title,
        versionId,
        textHash: String(version.textHash ?? ""),
        contentHash: String(version.contentHash ?? ""),
      });
    }
  }
  return matches;
}

async function sourceOwnerMismatchesView(db: D1Database) {
  const rows = await db.prepare(`SELECT
      b.id source_branch_id, b.article_id source_article_id, b.status branch_status,
      b.head_revision_id, b.base_revision_id, b.base_source_version_id source_version_id,
      b.created_at branch_created_at, b.updated_at branch_updated_at,
      r.id source_revision_id, r.source_version_id revision_source_version_id,
      r.body_sha256 source_body_sha256, r.created_at revision_created_at,
      w.branch_id working_branch_id, w.base_revision_id working_base_revision_id,
      w.body_sha256 working_body_sha256, w.dirty working_dirty,
      w.lock_version working_lock_version, w.updated_at working_updated_at,
      p.id package_id, p.status package_status, p.lock_version package_lock_version,
      ps.status package_branch_status, ps.head_revision_id package_head_revision_id,
      ps.lock_version package_branch_lock_version, ps.updated_at package_branch_updated_at
    FROM article_branches b
    LEFT JOIN article_revisions r ON r.id=b.head_revision_id
    LEFT JOIN branch_working_copies w ON w.branch_id=b.id
    LEFT JOIN article_project_packages p ON p.primary_branch_id=b.id
    LEFT JOIN package_branch_states ps ON ps.branch_id=b.id
    WHERE b.status='active' AND b.base_source_version_id IS NOT NULL
    ORDER BY b.updated_at DESC, b.id`).all<D1Row>();
  const mismatches: JsonObject[] = [];
  let unresolvedOwnerCount = 0;
  let shaMismatchCount = 0;
  for (const row of rows.results) {
    const sourceVersionId = String(row.source_version_id);
    const ownerMatches = corpusOwnerMatches(sourceVersionId);
    if (ownerMatches.length !== 1) {
      unresolvedOwnerCount += 1;
      continue;
    }
    const owner = ownerMatches[0];
    if (String(row.source_article_id) === owner.articleId) continue;
    const sourceBodySha256 = row.source_body_sha256 === null ? null : String(row.source_body_sha256);
    const bodyShaMatchesOwnerTextHash = sourceBodySha256 !== null && sourceBodySha256 === owner.textHash;
    if (!bodyShaMatchesOwnerTextHash) shaMismatchCount += 1;
    mismatches.push({
      sourceBranchId: String(row.source_branch_id),
      sourceArticleId: String(row.source_article_id),
      sourceRevisionId: row.source_revision_id === null ? null : String(row.source_revision_id),
      sourceVersionId,
      sourceBodySha256,
      currentOwnerArticleId: owner.articleId,
      currentOwnerTitle: owner.articleTitle,
      evidence: {
        kind: "corpus_unique_source_owner",
        corpusSchemaVersion: corpus.schemaVersion,
        corpusAlgorithmVersion: corpus.algorithmVersion,
        corpusGeneratedAt: corpus.generatedAt,
        ownerCount: 1,
        ownerTextHash: owner.textHash,
        ownerContentHash: owner.contentHash,
        bodyShaMatchesOwnerTextHash,
        branchBaseSourceMatchesRevisionSource: row.revision_source_version_id === null
          ? false : String(row.revision_source_version_id) === sourceVersionId,
        repairAuthority: "read_only_detection_only",
      },
      lock: {
        branchStatus: String(row.branch_status),
        branchHeadRevisionId: String(row.head_revision_id),
        branchBaseRevisionId: String(row.base_revision_id),
        branchCreatedAt: String(row.branch_created_at),
        branchUpdatedAt: String(row.branch_updated_at),
        workingCopyPresent: row.working_branch_id !== null,
        workingCopyBaseRevisionId: row.working_base_revision_id === null ? null : String(row.working_base_revision_id),
        workingCopyBodySha256: row.working_body_sha256 === null ? null : String(row.working_body_sha256),
        workingCopyDirty: row.working_dirty === null ? null : Number(row.working_dirty) === 1,
        workingCopyLockVersion: row.working_lock_version === null ? null : Number(row.working_lock_version),
        workingCopyUpdatedAt: row.working_updated_at === null ? null : String(row.working_updated_at),
        packageId: row.package_id === null ? null : String(row.package_id),
        packageStatus: row.package_status === null ? null : String(row.package_status),
        packageLockVersion: row.package_lock_version === null ? null : Number(row.package_lock_version),
        packageBranchStatus: row.package_branch_status === null ? null : String(row.package_branch_status),
        packageHeadRevisionId: row.package_head_revision_id === null ? null : String(row.package_head_revision_id),
        packageBranchLockVersion: row.package_branch_lock_version === null ? null : Number(row.package_branch_lock_version),
        packageBranchUpdatedAt: row.package_branch_updated_at === null ? null : String(row.package_branch_updated_at),
      },
    });
  }
  return {
    sourceOwnerMismatches: mismatches,
    counts: {
      scannedActiveSourceBranches: rows.results.length,
      mismatchCount: mismatches.length,
      unresolvedOwnerCount,
      shaMismatchCount,
    },
    autoRepairAttempted: false,
  };
}

async function handleGet(db: D1Database, url: URL) {
  const view = cleanText(url.searchParams.get("view") ?? "catalog", 80);
  if (!VIEWS.has(view)) throw new ArticleIdentityApiError("UNKNOWN_VIEW", `未知文章身份视图：${view}`, 404);
  if (view === "catalog") return catalogView(db, url);
  if (view === "identity") return identityView(db, url);
  if (view === "candidates") return candidatesView(db, url);
  if (view === "integrity") return integrityView(db);
  if (view === "source_owner_mismatches") return sourceOwnerMismatchesView(db);
  return operationView(db, url);
}

type RevisionSample = {
  id: string;
  articleId: string;
  branchId: string;
  title: string;
  bodyText: string;
  bodySha256: string;
  createdAt: string;
  isRoot: boolean;
  isHead: boolean;
};

function normalizedLines(body: string) {
  return body.replace(/\r\n?/gu, "\n").split("\n")
    .map((line) => line.trim().replace(/\s+/gu, " "))
    .filter(Boolean);
}

function lineSimilarity(left: string, right: string) {
  const a = normalizedLines(left);
  const b = normalizedLines(right);
  const counts = new Map<string, number>();
  for (const line of a) counts.set(line, (counts.get(line) ?? 0) + 1);
  let common = 0;
  for (const line of b) {
    const count = counts.get(line) ?? 0;
    if (count > 0) { common += 1; counts.set(line, count - 1); }
  }
  return Math.max(a.length, b.length) === 0 ? 1 : common / Math.max(a.length, b.length);
}

function normalizedBody(body: string) {
  return body.toLowerCase().replace(/^---[\s\S]*?---/u, "").replace(/[^\p{L}\p{N}]+/gu, "").slice(0, 120_000);
}

function shingles(body: string, width = 5) {
  const value = normalizedBody(body);
  const set = new Set<string>();
  for (let index = 0; index <= value.length - width; index += 1) set.add(value.slice(index, index + width));
  return set;
}

function shingleSimilarity(left: string, right: string) {
  const a = shingles(left);
  const b = shingles(right);
  if (a.size === 0 && b.size === 0) return 1;
  let common = 0;
  for (const value of a) if (b.has(value)) common += 1;
  return common / Math.max(1, a.size + b.size - common);
}

function titleSimilarity(left: string, right: string) {
  const a = new Set(normalizedBody(left).split(""));
  const b = new Set(normalizedBody(right).split(""));
  if (a.size === 0 && b.size === 0) return 1;
  let common = 0;
  for (const value of a) if (b.has(value)) common += 1;
  return (2 * common) / Math.max(1, a.size + b.size);
}

async function articleImpact(db: D1Database, articleId: string, branchIds: string[], revisionIds: string[]) {
  const branchPlaceholders = branchIds.length ? branchIds.map(() => "?").join(",") : "''";
  const revisionPlaceholders = revisionIds.length ? revisionIds.map(() => "?").join(",") : "''";
  const binds = [...branchIds, ...revisionIds];
  const row = await db.prepare(`SELECT
      (SELECT COUNT(*) FROM lifecycle_article_projects WHERE article_id=?) lifecycle_projects,
      (SELECT COUNT(*) FROM lifecycle_builds WHERE article_id=? OR branch_id IN (${branchPlaceholders}) OR revision_id IN (${revisionPlaceholders})) builds,
      (SELECT COUNT(*) FROM lifecycle_releases WHERE article_id=?) releases,
      (SELECT COUNT(*) FROM package_slices s JOIN article_project_packages p ON p.id=s.package_id
        WHERE p.article_id=? OR s.branch_id IN (${branchPlaceholders}) OR s.base_revision_id IN (${revisionPlaceholders})) slices,
      (SELECT COUNT(*) FROM agent_tasks WHERE article_id=? OR target_branch_id IN (${branchPlaceholders}) OR base_revision_id IN (${revisionPlaceholders})) agent_tasks,
      (SELECT COUNT(*) FROM production_runs WHERE article_id=? OR branch_id IN (${branchPlaceholders})) production_runs`)
    .bind(
      articleId,
      articleId, ...binds,
      articleId,
      articleId, ...binds,
      articleId, ...binds,
      articleId, ...branchIds,
    ).first<D1Row>();
  const impact = {
    lifecycleProjects: Number(row?.lifecycle_projects ?? 0), builds: Number(row?.builds ?? 0),
    releases: Number(row?.releases ?? 0), slices: Number(row?.slices ?? 0),
    agentTasks: Number(row?.agent_tasks ?? 0), productionRuns: Number(row?.production_runs ?? 0),
  };
  return { ...impact, total: Object.values(impact).reduce((sum, value) => sum + value, 0) };
}

async function localArticleSamples(db: D1Database, requestedArticleIds: string[]) {
  const revisionRows = requestedArticleIds.length
    ? await db.prepare(`SELECT r.*, CASE WHEN r.parent_revision_id IS NULL THEN 1 ELSE 0 END is_root,
        CASE WHEN EXISTS(SELECT 1 FROM article_branches b WHERE b.id=r.branch_id AND b.head_revision_id=r.id) THEN 1 ELSE 0 END is_head
        FROM article_revisions r WHERE r.article_id IN (${requestedArticleIds.map(() => "?").join(",")})
        ORDER BY r.article_id, r.created_at, r.sequence`).bind(...requestedArticleIds).all<D1Row>()
    : await db.prepare(`SELECT r.*, CASE WHEN r.parent_revision_id IS NULL THEN 1 ELSE 0 END is_root,
        CASE WHEN EXISTS(SELECT 1 FROM article_branches b WHERE b.id=r.branch_id AND b.head_revision_id=r.id) THEN 1 ELSE 0 END is_head
        FROM article_revisions r ORDER BY r.article_id, r.created_at, r.sequence`).all<D1Row>();
  const grouped = new Map<string, RevisionSample[]>();
  for (const row of revisionRows.results) {
    const sample = {
      id: String(row.id), articleId: String(row.article_id), branchId: String(row.branch_id), title: String(row.title),
      bodyText: String(row.body_text), bodySha256: String(row.body_sha256), createdAt: String(row.created_at),
      isRoot: Number(row.is_root) === 1, isHead: Number(row.is_head) === 1,
    } satisfies RevisionSample;
    const values = grouped.get(sample.articleId) ?? [];
    values.push(sample);
    grouped.set(sample.articleId, values);
  }
  return grouped;
}

async function scanCandidates(db: D1Database, payload: JsonObject, actorId: string, commandId: string, inputSha256: string) {
  const requestedArticleIds = stringArray(payload.articleIds, "articleIds", 100).map((value) => requiredId(value, "articleIds[]"));
  const thresholdValue = payload.threshold === undefined ? 0.86 : Number(payload.threshold);
  if (!Number.isFinite(thresholdValue) || thresholdValue < 0.5 || thresholdValue > 1) {
    throw new ArticleIdentityApiError("INVALID_THRESHOLD", "threshold 必须在 0.5 到 1 之间");
  }
  const groups = await localArticleSamples(db, requestedArticleIds);
  const articleIds = [...groups.keys()].sort();
  const impacts = new Map<string, Awaited<ReturnType<typeof articleImpact>>>();
  for (const [articleId, samples] of groups) {
    impacts.set(articleId, await articleImpact(db, articleId,
      [...new Set(samples.map((sample) => sample.branchId))], samples.map((sample) => sample.id)));
  }
  const candidates: Array<{
    source: RevisionSample;
    target: RevisionSample;
    proposedRelation: "same_work" | "superseded_by";
    score: number;
    signals: JsonObject;
    sourceImpact: Awaited<ReturnType<typeof articleImpact>>;
    targetImpact: Awaited<ReturnType<typeof articleImpact>>;
  }> = [];
  for (let leftIndex = 0; leftIndex < articleIds.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < articleIds.length; rightIndex += 1) {
      const leftArticle = articleIds[leftIndex];
      const rightArticle = articleIds[rightIndex];
      const leftSamples = (groups.get(leftArticle) ?? []).filter((sample) => sample.isHead || sample.isRoot);
      const rightSamples = (groups.get(rightArticle) ?? []).filter((sample) => sample.isHead || sample.isRoot);
      let best: { left: RevisionSample; right: RevisionSample; score: number; line: number; shingle: number; title: number } | null = null;
      for (const left of leftSamples) for (const right of rightSamples) {
        const line = lineSimilarity(left.bodyText, right.bodyText);
        const shingle = shingleSimilarity(left.bodyText, right.bodyText);
        const title = titleSimilarity(left.title, right.title);
        const score = Number((line * 0.7 + shingle * 0.25 + title * 0.05).toFixed(6));
        if (!best || score > best.score) best = { left, right, score, line, shingle, title };
      }
      if (!best || best.score < thresholdValue) continue;
      const leftImpact = impacts.get(leftArticle)!;
      const rightImpact = impacts.get(rightArticle)!;
      let source = best.left;
      let target = best.right;
      let sourceImpact = leftImpact;
      let targetImpact = rightImpact;
      if (leftImpact.total > rightImpact.total || (leftImpact.total === rightImpact.total && best.left.createdAt > best.right.createdAt)) {
        source = best.right; target = best.left; sourceImpact = rightImpact; targetImpact = leftImpact;
      }
      candidates.push({
        source, target,
        proposedRelation: targetImpact.total > sourceImpact.total ? "superseded_by" : "same_work",
        score: best.score,
        signals: {
          algorithmVersion: "wenmai-local-line-similarity-v1", lineSimilarity: Number(best.line.toFixed(6)),
          shingleSimilarity: Number(best.shingle.toFixed(6)), titleSimilarity: Number(best.title.toFixed(6)),
          comparedRevisionRoles: { source: source.isRoot ? "root" : "head", target: target.isRoot ? "root" : "head" },
        },
        sourceImpact, targetImpact,
      });
    }
  }
  const operationId = `identity-op-${crypto.randomUUID()}`;
  const now = isoNow();
  const plan = {
    apiVersion: API_VERSION, operationKind: "candidate_scan", requestedArticleIds,
    threshold: thresholdValue, algorithmVersion: "wenmai-local-line-similarity-v1",
    corpusSnapshot: { schemaVersion: corpus.schemaVersion, algorithmVersion: corpus.algorithmVersion, generatedAt: corpus.generatedAt },
  };
  const preconditions = { comparedArticles: articleIds.length, comparedHeadOrRootRevisions: [...groups.values()].flat().filter((item) => item.isHead || item.isRoot).length };
  const inverse = { action: "rollback_operation", candidateLinks: candidates.length };
  const planSha256 = await sha256Text(canonicalJson(plan));
  const preconditionsSha256 = await sha256Text(canonicalJson(preconditions));
  const sentinel = await sha256Text(canonicalJson({ operationId, inputSha256, planSha256 }));
  const statements: D1PreparedStatement[] = [
    db.prepare(`INSERT INTO article_identity_operations
      (id, operation_kind, status, identity_id, command_id, actor_id, applied_by,
       plan_json, plan_sha256, preconditions_json, preconditions_sha256, inverse_json, result_json,
       sentinel, lock_version, planned_at, applied_at, updated_at)
      VALUES (?, 'candidate_scan', 'applied', NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`)
      .bind(operationId, commandId, actorId, actorId, canonicalJson(plan), planSha256,
        canonicalJson(preconditions), preconditionsSha256, canonicalJson(inverse),
        canonicalJson({ candidateCount: candidates.length }), sentinel, now, now, now),
  ];
  for (const candidate of candidates) {
    const linkId = `lineage-${crypto.randomUUID()}`;
    const evidence = [{
      kind: "deterministic_similarity", score: candidate.score, signals: candidate.signals,
      sourceImpact: candidate.sourceImpact, targetImpact: candidate.targetImpact,
      note: "候选只用于人工复核；相似度不会自动确认身份或执行清理",
    }];
    const linkInputSha = await sha256Text(canonicalJson({
      sourceRevisionId: candidate.source.id, sourceBodySha256: candidate.source.bodySha256,
      targetRevisionId: candidate.target.id, targetBodySha256: candidate.target.bodySha256,
      proposedRelation: candidate.proposedRelation, evidence,
    }));
    statements.push(db.prepare(`INSERT OR IGNORE INTO article_lineage_links
      (id, identity_id, relation_type, source_kind, source_id, source_article_id, source_revision_id, source_body_sha256,
       target_kind, target_id, target_article_id, target_revision_id, target_body_sha256,
       status, evidence_json, input_sha256, operation_id, lock_version, created_at, updated_at)
      VALUES (?, NULL, ?, 'revision', ?, ?, ?, ?, 'revision', ?, ?, ?, ?, 'candidate', ?, ?, ?, 1, ?, ?)`)
      .bind(linkId, candidate.proposedRelation, candidate.source.id, candidate.source.articleId, candidate.source.id,
        candidate.source.bodySha256, candidate.target.id, candidate.target.articleId, candidate.target.id,
        candidate.target.bodySha256, canonicalJson(evidence), linkInputSha, operationId, now, now));
  }
  const results = await db.batch(statements);
  const inserted = results.slice(1).reduce((sum, result) => sum + Number(result.meta.changes ?? 0), 0);
  return {
    status: 201,
    data: {
      operationId, operationKind: "candidate_scan", planSha256, candidateCount: candidates.length,
      insertedCandidateCount: inserted,
      candidates: candidates.map((candidate) => ({
        sourceArticleId: candidate.source.articleId, sourceRevisionId: candidate.source.id,
        sourceBodySha256: candidate.source.bodySha256, targetArticleId: candidate.target.articleId,
        targetRevisionId: candidate.target.id, targetBodySha256: candidate.target.bodySha256,
        proposedRelation: candidate.proposedRelation, score: candidate.score, signals: candidate.signals,
        sourceImpact: candidate.sourceImpact, targetImpact: candidate.targetImpact,
      })),
      autoApplied: false,
    },
  };
}

async function requiredRow(db: D1Database, sql: string, binds: unknown[], code: string, message: string, details: JsonObject) {
  const row = await db.prepare(sql).bind(...binds).first<D1Row>();
  if (!row) throw new ArticleIdentityApiError(code, message, 409, details);
  return row;
}

async function insertPlannedOperation(db: D1Database, input: {
  operationKind: "consolidation" | "source_owner_repair";
  commandId: string;
  actorId: string;
  identityId: string;
  plan: JsonObject;
  preconditions: JsonObject;
  inverse: JsonObject;
  inputSha256: string;
}) {
  const operationId = `identity-op-${crypto.randomUUID()}`;
  const now = isoNow();
  const planSha256 = await sha256Text(canonicalJson(input.plan));
  const preconditionsSha256 = await sha256Text(canonicalJson(input.preconditions));
  const sentinel = await sha256Text(canonicalJson({ operationId, inputSha256: input.inputSha256, planSha256, preconditionsSha256 }));
  await db.prepare(`INSERT INTO article_identity_operations
    (id, operation_kind, status, identity_id, command_id, actor_id, plan_json, plan_sha256,
     preconditions_json, preconditions_sha256, inverse_json, result_json, sentinel, lock_version, planned_at, updated_at)
    VALUES (?, ?, 'planned', ?, ?, ?, ?, ?, ?, ?, ?, '{}', ?, 1, ?, ?)`)
    .bind(operationId, input.operationKind, input.identityId, input.commandId, input.actorId,
      canonicalJson(input.plan), planSha256, canonicalJson(input.preconditions), preconditionsSha256,
      canonicalJson(input.inverse), sentinel, now, now).run();
  return { operationId, planSha256, preconditionsSha256, sentinel, plannedAt: now };
}

function consolidationFrozenKey(plan: JsonObject, preconditions: JsonObject) {
  const canonical = isObject(plan.canonical) ? plan.canonical : {};
  const legacy = isObject(plan.legacy) ? plan.legacy : {};
  return canonicalJson({
    candidateId: plan.candidateId,
    canonical: {
      articleId: canonical.articleId, packageId: canonical.packageId, branchId: canonical.branchId,
      revisionId: canonical.revisionId, bodySha256: canonical.bodySha256,
    },
    legacy: {
      articleId: legacy.articleId, packageId: legacy.packageId, branchId: legacy.branchId,
      revisionId: legacy.revisionId, bodySha256: legacy.bodySha256,
    },
    preconditions,
  });
}

async function planConsolidation(db: D1Database, payload: JsonObject, actorId: string, commandId: string, inputSha256: string) {
  const candidateId = requiredId(payload.candidateId, "candidateId");
  const canonicalArticleId = requiredId(payload.canonicalArticleId, "canonicalArticleId");
  const legacyArticleId = requiredId(payload.legacyArticleId, "legacyArticleId");
  if (canonicalArticleId === legacyArticleId) throw new ArticleIdentityApiError("SAME_ARTICLE", "canonical 与 legacy 不能是同一 Article");
  const canonicalPackageId = requiredId(payload.canonicalPackageId, "canonicalPackageId");
  const legacyPackageId = requiredId(payload.legacyPackageId, "legacyPackageId");
  const canonicalBranchId = requiredId(payload.canonicalBranchId, "canonicalBranchId");
  const legacyBranchId = requiredId(payload.legacyBranchId, "legacyBranchId");
  const canonicalRevisionId = requiredId(payload.canonicalRevisionId, "canonicalRevisionId");
  const legacyRevisionId = requiredId(payload.legacyRevisionId, "legacyRevisionId");
  const expectedCanonicalBodySha256 = requiredSha(payload.expectedCanonicalBodySha256, "expectedCanonicalBodySha256");
  const expectedLegacyBodySha256 = requiredSha(payload.expectedLegacyBodySha256, "expectedLegacyBodySha256");
  const evidence = stringArray(payload.evidence, "evidence", 30);

  const candidate = await requiredRow(db, `SELECT * FROM article_lineage_links WHERE id=? AND status='candidate'
      AND ((source_article_id=? AND target_article_id=?) OR (source_article_id=? AND target_article_id=?))
      AND ((source_revision_id=? AND target_revision_id=?) OR (source_revision_id=? AND target_revision_id=?)) LIMIT 1`,
    [candidateId, legacyArticleId, canonicalArticleId, canonicalArticleId, legacyArticleId,
      legacyRevisionId, canonicalRevisionId, canonicalRevisionId, legacyRevisionId],
    "CANDIDATE_MISMATCH", "候选与本次 canonical/legacy 修订不一致", { candidateId });
  const canonicalPackage = await requiredRow(db,
    "SELECT * FROM article_project_packages WHERE id=? AND article_id=? AND status='active' LIMIT 1",
    [canonicalPackageId, canonicalArticleId], "CANONICAL_PACKAGE_MISMATCH", "canonical Package 不可用", { canonicalPackageId });
  const legacyPackage = await requiredRow(db,
    "SELECT * FROM article_project_packages WHERE id=? AND article_id=? AND status='active' LIMIT 1",
    [legacyPackageId, legacyArticleId], "LEGACY_PACKAGE_MISMATCH", "legacy Package 不可用", { legacyPackageId });
  const canonicalBranch = await requiredRow(db,
    "SELECT * FROM article_branches WHERE id=? AND article_id=? AND status='active' LIMIT 1",
    [canonicalBranchId, canonicalArticleId], "CANONICAL_BRANCH_MISMATCH", "canonical Branch 不可用", { canonicalBranchId });
  const legacyBranch = await requiredRow(db,
    "SELECT * FROM article_branches WHERE id=? AND article_id=? AND status='active' LIMIT 1",
    [legacyBranchId, legacyArticleId], "LEGACY_BRANCH_MISMATCH", "legacy Branch 不可用", { legacyBranchId });
  const canonicalRevision = await requiredRow(db,
    "SELECT * FROM article_revisions WHERE id=? AND article_id=? AND body_sha256=? LIMIT 1",
    [canonicalRevisionId, canonicalArticleId, expectedCanonicalBodySha256],
    "CANONICAL_REVISION_MISMATCH", "canonical Revision 或正文摘要已变化", { canonicalRevisionId });
  await requiredRow(db,
    "SELECT * FROM article_revisions WHERE id=? AND article_id=? AND branch_id=? AND body_sha256=? LIMIT 1",
    [legacyRevisionId, legacyArticleId, legacyBranchId, expectedLegacyBodySha256],
    "LEGACY_REVISION_MISMATCH", "legacy Revision 或正文摘要已变化", { legacyRevisionId });
  if (String(legacyBranch.head_revision_id) !== legacyRevisionId) {
    throw new ArticleIdentityApiError("LEGACY_HEAD_CHANGED", "legacy Branch head 已变化，不能沿用旧候选", 409);
  }
  const legacyState = await requiredRow(db,
    "SELECT * FROM package_branch_states WHERE package_id=? AND branch_id=? AND status='active' AND head_revision_id=? LIMIT 1",
    [legacyPackageId, legacyBranchId, legacyRevisionId], "LEGACY_PACKAGE_STATE_MISMATCH", "legacy Package Branch 状态不可用", { legacyPackageId, legacyBranchId });
  const canonicalImpact = await articleImpact(db, canonicalArticleId, [canonicalBranchId], [canonicalRevisionId, String(canonicalBranch.head_revision_id)]);
  const legacyImpact = await articleImpact(db, legacyArticleId, [legacyBranchId], [legacyRevisionId]);
  if (legacyImpact.total !== 0) {
    throw new ArticleIdentityApiError("LEGACY_HAS_DOWNSTREAM", "legacy Article 已有发布、Agent 或生产下游，不能执行低风险收拢", 409, { legacyImpact });
  }
  const existingIdentity = await db.prepare("SELECT * FROM article_identities WHERE canonical_article_id=? LIMIT 1")
    .bind(canonicalArticleId).first<D1Row>();
  const conflictingMembers = await db.prepare(`SELECT object_kind, object_id, identity_id FROM article_identity_members
    WHERE (object_kind='article' AND object_id IN (?,?)) AND identity_id<>? AND state<>'archived'`)
    .bind(canonicalArticleId, legacyArticleId, existingIdentity?.id ?? "").all<D1Row>();
  if (conflictingMembers.results.length) {
    throw new ArticleIdentityApiError("IDENTITY_CONFLICT", "Article 已属于另一个活跃身份，必须先解决冲突", 409,
      { conflicts: conflictingMembers.results });
  }
  const identityId = existingIdentity ? String(existingIdentity.id) : `identity-${crypto.randomUUID()}`;
  const identityWasCreated = !existingIdentity;
  const title = cleanText(payload.title, 500) || String(canonicalRevision.title);
  const plan: JsonObject = {
    apiVersion: API_VERSION, operationKind: "consolidation", candidateId, identityId, identityWasCreated,
    canonical: { articleId: canonicalArticleId, packageId: canonicalPackageId, branchId: canonicalBranchId,
      revisionId: canonicalRevisionId, bodySha256: expectedCanonicalBodySha256 },
    legacy: { articleId: legacyArticleId, packageId: legacyPackageId, branchId: legacyBranchId,
      revisionId: legacyRevisionId, bodySha256: expectedLegacyBodySha256 },
    title, evidence,
  };
  const preconditions: JsonObject = {
    candidate: { id: candidateId, inputSha256: candidate.input_sha256, lockVersion: Number(candidate.lock_version), status: candidate.status },
    canonicalPackage: { id: canonicalPackageId, lockVersion: Number(canonicalPackage.lock_version), status: canonicalPackage.status },
    canonicalBranch: { id: canonicalBranchId, headRevisionId: canonicalBranch.head_revision_id, updatedAt: canonicalBranch.updated_at },
    legacyPackage: { id: legacyPackageId, lockVersion: Number(legacyPackage.lock_version), status: legacyPackage.status },
    legacyBranch: { id: legacyBranchId, headRevisionId: legacyBranch.head_revision_id, updatedAt: legacyBranch.updated_at },
    legacyPackageState: { packageId: legacyPackageId, branchId: legacyBranchId,
      lockVersion: Number(legacyState.lock_version), headRevisionId: legacyState.head_revision_id, status: legacyState.status },
    canonicalImpact, legacyImpact,
  };
  const inverse: JsonObject = {
    legacyPackageStatus: legacyPackage.status, legacyBranchStatus: legacyBranch.status,
    legacyPackageStateStatus: legacyState.status, identityWasCreated,
    rollbackRequires: "no new downstream and exact post-apply CAS",
  };
  const frozenKey = consolidationFrozenKey(plan, preconditions);
  const plannedRows = await db.prepare(`SELECT * FROM article_identity_operations
    WHERE operation_kind='consolidation' AND status='planned' ORDER BY planned_at, id`).all<D1Row>();
  const reusable = plannedRows.results.find((row) => {
    const existingPlan = parseJson<JsonObject>(row.plan_json, {});
    if (existingPlan.candidateId !== candidateId) return false;
    const existingPreconditions = parseJson<JsonObject>(row.preconditions_json, {});
    return consolidationFrozenKey(existingPlan, existingPreconditions) === frozenKey;
  });
  if (reusable) {
    return {
      data: {
        operationId: String(reusable.id), operationKind: "consolidation", identityId: String(reusable.identity_id),
        identityWasCreated: parseJson<JsonObject>(reusable.plan_json, {}).identityWasCreated === true,
        planSha256: String(reusable.plan_sha256), preconditionsSha256: String(reusable.preconditions_sha256),
        sentinel: String(reusable.sentinel), plannedAt: String(reusable.planned_at),
        plan: parseJson(reusable.plan_json, {}), preconditions: parseJson(reusable.preconditions_json, {}),
        reusedPlan: true, autoApplied: false,
      },
    };
  }
  const operation = await insertPlannedOperation(db, {
    operationKind: "consolidation", commandId, actorId, identityId, plan, preconditions, inverse, inputSha256,
  });
  return { status: 201, data: { ...operation, operationKind: "consolidation", identityId, identityWasCreated,
    plan, preconditions, reusedPlan: false, autoApplied: false } };
}

function operationPayload(row: D1Row) {
  return {
    plan: parseJson<JsonObject>(row.plan_json, {}),
    preconditions: parseJson<JsonObject>(row.preconditions_json, {}),
    inverse: parseJson<JsonObject>(row.inverse_json, {}),
  };
}

async function applyConsolidation(db: D1Database, payload: JsonObject, actorId: string) {
  const operationId = requiredId(payload.operationId, "operationId");
  const expectedPlanSha256 = requiredSha(payload.expectedPlanSha256, "expectedPlanSha256");
  const operation = await requiredRow(db,
    "SELECT * FROM article_identity_operations WHERE id=? AND operation_kind='consolidation' LIMIT 1",
    [operationId], "OPERATION_NOT_FOUND", "没有找到 consolidation 计划", { operationId });
  if (operation.status !== "planned" || operation.plan_sha256 !== expectedPlanSha256) {
    throw new ArticleIdentityApiError("OPERATION_STALE", "本次请求未应用 consolidation 计划：计划状态或摘要已变化。现有操作记录仍保留；请刷新文章身份状态，按当前数据重新生成并核对计划，不要重复应用旧摘要。", 409,
      { operationId, status: operation.status });
  }
  const { plan, preconditions } = operationPayload(operation);
  const canonical = plan.canonical as JsonObject;
  const legacy = plan.legacy as JsonObject;
  const candidate = preconditions.candidate as JsonObject;
  const legacyPackage = preconditions.legacyPackage as JsonObject;
  const legacyBranch = preconditions.legacyBranch as JsonObject;
  const legacyState = preconditions.legacyPackageState as JsonObject;
  const identityId = requiredId(plan.identityId, "plan.identityId");
  const identityWasCreated = plan.identityWasCreated === true;
  const now = isoNow();
  const evidenceJson = canonicalJson([
    ...(Array.isArray(plan.evidence) ? plan.evidence : []),
    { kind: "confirmed_consolidation", candidateId: plan.candidateId, planSha256: expectedPlanSha256 },
  ]);
  const otherPlannedRows = await db.prepare(`SELECT * FROM article_identity_operations
    WHERE operation_kind='consolidation' AND status='planned' AND id<>? ORDER BY planned_at, id`)
    .bind(operationId).all<D1Row>();
  const otherPlanned = otherPlannedRows.results.filter((row) => {
    const otherPlan = parseJson<JsonObject>(row.plan_json, {});
    return otherPlan.candidateId === plan.candidateId;
  });
  const result = {
    identityId, canonicalArticleId: canonical.articleId, legacyArticleId: legacy.articleId,
    archivedPackageId: legacy.packageId, archivedBranchId: legacy.branchId,
    preservedCanonicalRevisionId: canonical.revisionId, preservedLegacyRevisionId: legacy.revisionId,
    publicationReferencesMutated: false,
    supersededPlannedOperationIds: otherPlanned.map((row) => String(row.id)),
  };
  const guard = `id=? AND operation_kind='consolidation' AND status='planned' AND plan_sha256=?
    AND EXISTS(SELECT 1 FROM article_lineage_links WHERE id=? AND status='candidate' AND lock_version=? AND input_sha256=?)
    AND EXISTS(SELECT 1 FROM article_project_packages WHERE id=? AND article_id=? AND status='active' AND lock_version=?)
    AND EXISTS(SELECT 1 FROM article_branches WHERE id=? AND article_id=? AND status='active' AND head_revision_id=? AND updated_at=?)
    AND EXISTS(SELECT 1 FROM package_branch_states WHERE package_id=? AND branch_id=? AND status='active' AND head_revision_id=? AND lock_version=?)
    AND EXISTS(SELECT 1 FROM article_revisions WHERE id=? AND article_id=? AND body_sha256=?)
    AND EXISTS(SELECT 1 FROM article_revisions WHERE id=? AND article_id=? AND body_sha256=?)
    AND NOT EXISTS(SELECT 1 FROM lifecycle_article_projects WHERE article_id=?)
    AND NOT EXISTS(SELECT 1 FROM lifecycle_builds WHERE article_id=? OR branch_id=? OR revision_id=?)
    AND NOT EXISTS(SELECT 1 FROM lifecycle_releases WHERE article_id=?)`;
  const guardBinds = [operationId, expectedPlanSha256, plan.candidateId, candidate.lockVersion, candidate.inputSha256,
    legacy.packageId, legacy.articleId, legacyPackage.lockVersion,
    legacy.branchId, legacy.articleId, legacy.revisionId, legacyBranch.updatedAt,
    legacy.packageId, legacy.branchId, legacy.revisionId, legacyState.lockVersion,
    legacy.revisionId, legacy.articleId, legacy.bodySha256,
    canonical.revisionId, canonical.articleId, canonical.bodySha256,
    legacy.articleId, legacy.articleId, legacy.branchId, legacy.revisionId, legacy.articleId];
  const markApplied = db.prepare(`UPDATE article_identity_operations SET status='applied', applied_by=?,
      applied_at=?, updated_at=?, lock_version=lock_version+1, result_json=? WHERE ${guard}`)
    .bind(actorId, now, now, canonicalJson(result), ...guardBinds);
  const operationGuard = "EXISTS(SELECT 1 FROM article_identity_operations WHERE id=? AND status='applied' AND applied_at=? AND plan_sha256=?)";
  const statements: D1PreparedStatement[] = [markApplied];
  if (identityWasCreated) {
    statements.push(db.prepare(`INSERT INTO article_identities
      (id, canonical_article_id, title, status, visibility, lock_version, created_by, created_at, updated_at)
      SELECT ?, ?, ?, 'active', 'primary', 1, ?, ?, ? WHERE ${operationGuard}`)
      .bind(identityId, canonical.articleId, plan.title, actorId, now, now, operationId, now, expectedPlanSha256));
  }
  const memberSpecs = [
    ["article", canonical.articleId, canonical.articleId, null, null, "canonical", "active", 0],
    ["article", legacy.articleId, legacy.articleId, null, legacy.bodySha256, "legacy_root", "superseded", 1],
    ["revision", canonical.revisionId, canonical.articleId, canonical.revisionId, canonical.bodySha256, "revision", "active", 0],
    ["revision", legacy.revisionId, legacy.articleId, legacy.revisionId, legacy.bodySha256, "revision", "superseded", 1],
    ["package", canonical.packageId, canonical.articleId, null, null, "canonical", "active", 0],
    ["package", legacy.packageId, legacy.articleId, null, null, "legacy_root", "superseded", 1],
  ] as const;
  for (const [kind, objectId, articleId, revisionId, bodySha, role, state, hidden] of memberSpecs) {
    statements.push(db.prepare(`INSERT OR IGNORE INTO article_identity_members
      (id, identity_id, object_kind, object_id, article_id, revision_id, body_sha256, role, state,
       hidden_from_primary, evidence_json, input_sha256, operation_id, lock_version, created_at, updated_at)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ? WHERE ${operationGuard}`)
      .bind(`identity-member-${crypto.randomUUID()}`, identityId, kind, objectId, articleId, revisionId, bodySha,
        role, state, hidden, evidenceJson, operation.preconditions_sha256, operationId, now, now,
        operationId, now, expectedPlanSha256));
  }
  const confirmedLinks = [
    ["derived_from", canonical.revisionId, canonical.articleId, canonical.bodySha256, legacy.revisionId, legacy.articleId, legacy.bodySha256],
    ["superseded_by", legacy.revisionId, legacy.articleId, legacy.bodySha256, canonical.revisionId, canonical.articleId, canonical.bodySha256],
  ] as const;
  for (const [relation, sourceId, sourceArticleId, sourceSha, targetId, targetArticleId, targetSha] of confirmedLinks) {
    statements.push(db.prepare(`INSERT OR IGNORE INTO article_lineage_links
      (id, identity_id, relation_type, source_kind, source_id, source_article_id, source_revision_id, source_body_sha256,
       target_kind, target_id, target_article_id, target_revision_id, target_body_sha256, status, evidence_json,
       input_sha256, operation_id, decided_by, decided_at, lock_version, created_at, updated_at)
      SELECT ?, ?, ?, 'revision', ?, ?, ?, ?, 'revision', ?, ?, ?, ?, 'confirmed', ?, ?, ?, ?, ?, 1, ?, ?
      WHERE ${operationGuard}`)
      .bind(`lineage-${crypto.randomUUID()}`, identityId, relation, sourceId, sourceArticleId, sourceId, sourceSha,
        targetId, targetArticleId, targetId, targetSha, evidenceJson, operation.preconditions_sha256,
        operationId, actorId, now, now, now, operationId, now, expectedPlanSha256));
  }
  statements.push(
    db.prepare(`UPDATE article_lineage_links SET identity_id=?, status='confirmed', decided_by=?, decided_at=?,
      lock_version=lock_version+1, updated_at=? WHERE id=? AND status='candidate' AND ${operationGuard}`)
      .bind(identityId, actorId, now, now, plan.candidateId, operationId, now, expectedPlanSha256),
    db.prepare(`UPDATE article_project_packages SET status='archived', lock_version=lock_version+1, updated_at=?
      WHERE id=? AND status='active' AND lock_version=? AND ${operationGuard}`)
      .bind(now, legacy.packageId, legacyPackage.lockVersion, operationId, now, expectedPlanSha256),
    db.prepare(`UPDATE article_branches SET status='archived', updated_at=?
      WHERE id=? AND status='active' AND head_revision_id=? AND updated_at=? AND ${operationGuard}`)
      .bind(now, legacy.branchId, legacy.revisionId, legacyBranch.updatedAt, operationId, now, expectedPlanSha256),
    db.prepare(`UPDATE package_branch_states SET status='archived', lock_version=lock_version+1, updated_at=?
      WHERE package_id=? AND branch_id=? AND status='active' AND head_revision_id=? AND lock_version=? AND ${operationGuard}`)
      .bind(now, legacy.packageId, legacy.branchId, legacy.revisionId, legacyState.lockVersion, operationId, now, expectedPlanSha256),
  );
  for (const stale of otherPlanned) {
    const supersession = {
      terminalDisposition: "superseded",
      storageStatus: "rolled_back",
      candidateId: plan.candidateId,
      supersededByOperationId: operationId,
      supersededAt: now,
      evidence: [{
        kind: "same_candidate_applied",
        appliedOperationId: operationId,
        appliedPlanSha256: expectedPlanSha256,
        note: "历史 planned 操作未执行、未删除；因同一 candidate 已被当前操作应用而终止",
      }],
    };
    statements.push(db.prepare(`UPDATE article_identity_operations SET status='rolled_back', rolled_back_by=?,
      rolled_back_at=?, updated_at=?, lock_version=lock_version+1, result_json=?
      WHERE id=? AND operation_kind='consolidation' AND status='planned' AND plan_sha256=? AND ${operationGuard}`)
      .bind(actorId, now, now, canonicalJson(supersession), stale.id, stale.plan_sha256,
        operationId, now, expectedPlanSha256));
  }
  const applied = await db.batch(statements);
  if (Number(applied[0].meta.changes ?? 0) !== 1) {
    throw new ArticleIdentityApiError("PRECONDITION_FAILED", "本次 consolidation 未执行清理；两端 Revision 未被本请求改写，现有 Package、Branch 和计划记录仍保留。请刷新候选与锁版本，重新生成计划后再确认。", 409,
      { operationId });
  }
  return { data: { operationId, operationKind: "consolidation", status: "applied", appliedAt: now, result } };
}

function corpusVersionOwner(versionId: string) {
  const matches = corpusOwnerMatches(versionId);
  if (matches.length !== 1) {
    throw new ArticleIdentityApiError("SOURCE_OWNER_NOT_UNIQUE", "source Version 无法解析到唯一 corpus Article owner", 409,
      { versionId, ownerCount: matches.length });
  }
  return matches[0];
}

async function branchDownstream(db: D1Database, branchId: string, revisionId: string) {
  const checks = await db.batch([
    db.prepare("SELECT COUNT(*) count FROM lifecycle_builds WHERE branch_id=? OR revision_id=?").bind(branchId, revisionId),
    db.prepare("SELECT COUNT(*) count FROM package_branch_states WHERE branch_id=?").bind(branchId),
    db.prepare("SELECT COUNT(*) count FROM package_branch_working_copies WHERE branch_id=?").bind(branchId),
    db.prepare("SELECT COUNT(*) count FROM package_branch_composition_commits WHERE branch_id=? OR article_revision_id=?").bind(branchId, revisionId),
    db.prepare("SELECT COUNT(*) count FROM package_slices WHERE branch_id=? OR base_revision_id=?").bind(branchId, revisionId),
    db.prepare("SELECT COUNT(*) count FROM package_diagnosis_runs WHERE branch_id=? OR base_revision_id=?").bind(branchId, revisionId),
    db.prepare("SELECT COUNT(*) count FROM package_import_runs WHERE branch_id=? OR base_revision_id=?").bind(branchId, revisionId),
    db.prepare("SELECT COUNT(*) count FROM package_export_runs WHERE branch_id=? OR base_revision_id=?").bind(branchId, revisionId),
    db.prepare("SELECT COUNT(*) count FROM agent_tasks WHERE target_branch_id=? OR base_revision_id=?").bind(branchId, revisionId),
    db.prepare("SELECT COUNT(*) count FROM production_runs WHERE branch_id=?").bind(branchId),
    db.prepare("SELECT COUNT(*) count FROM agent_runs WHERE branch_id=? OR frozen_revision_id=?").bind(branchId, revisionId),
    db.prepare(`SELECT COUNT(*) count FROM merge_proposals WHERE source_branch_id=? OR target_branch_id=?
      OR base_revision_id=? OR source_head_revision_id=? OR target_head_revision_id=? OR merge_revision_id=?`)
      .bind(branchId, branchId, revisionId, revisionId, revisionId, revisionId),
    db.prepare("SELECT COUNT(*) count FROM gate_runs WHERE branch_id=? OR revision_id=?").bind(branchId, revisionId),
  ]);
  const names = ["lifecycleBuilds", "packageStates", "packageWorking", "packageCommits", "packageSlices",
    "diagnosisRuns", "importRuns", "exportRuns", "agentTasks", "productionRuns", "agentRuns", "mergeProposals", "gateRuns"];
  const counts = Object.fromEntries(checks.map((result, index) => [names[index], Number((result.results?.[0] as D1Row | undefined)?.count ?? 0)]));
  return { ...counts, total: Object.values(counts).reduce((sum, value) => sum + value, 0) };
}

async function planSourceOwnerRepair(db: D1Database, payload: JsonObject, actorId: string, commandId: string, inputSha256: string) {
  const sourceBranchId = requiredId(payload.sourceBranchId, "sourceBranchId");
  const sourceRevisionId = requiredId(payload.sourceRevisionId, "sourceRevisionId");
  const expectedSourceArticleId = requiredId(payload.expectedSourceArticleId, "expectedSourceArticleId");
  const targetArticleId = requiredId(payload.targetArticleId, "targetArticleId");
  const sourceVersionId = requiredId(payload.sourceVersionId, "sourceVersionId");
  const expectedBodySha256 = requiredSha(payload.expectedBodySha256, "expectedBodySha256");
  const evidence = stringArray(payload.evidence, "evidence", 30);
  if (expectedSourceArticleId === targetArticleId) {
    throw new ArticleIdentityApiError("OWNER_ALREADY_MATCHES", "源 Branch 已经属于目标 Article，无需修复");
  }
  const owner = corpusVersionOwner(sourceVersionId);
  if (owner.articleId !== targetArticleId || owner.textHash !== expectedBodySha256) {
    throw new ArticleIdentityApiError("SOURCE_OWNER_EVIDENCE_MISMATCH", "corpus owner 或 textHash 与修复请求不一致", 409,
      { owner, targetArticleId, expectedBodySha256 });
  }
  const sourceBranch = await requiredRow(db,
    `SELECT * FROM article_branches WHERE id=? AND article_id=? AND status='active'
      AND head_revision_id=? AND base_source_version_id=? LIMIT 1`,
    [sourceBranchId, expectedSourceArticleId, sourceRevisionId, sourceVersionId],
    "SOURCE_BRANCH_MISMATCH", "待修复 Branch 已变化或 source Version 不一致", { sourceBranchId });
  const sourceRevision = await requiredRow(db,
    `SELECT * FROM article_revisions WHERE id=? AND article_id=? AND branch_id=? AND source_version_id=?
      AND body_sha256=? LIMIT 1`,
    [sourceRevisionId, expectedSourceArticleId, sourceBranchId, sourceVersionId, expectedBodySha256],
    "SOURCE_REVISION_MISMATCH", "待修复 Revision 或正文摘要已变化", { sourceRevisionId });
  const workingCopy = await requiredRow(db,
    `SELECT * FROM branch_working_copies WHERE branch_id=? AND article_id=? AND base_revision_id=?
      AND body_sha256=? AND dirty=0 LIMIT 1`,
    [sourceBranchId, expectedSourceArticleId, sourceRevisionId, expectedBodySha256],
    "WORKING_COPY_NOT_CLEAN", "source-owner 修复只允许 clean Working Copy", { sourceBranchId });
  const downstream = await branchDownstream(db, sourceBranchId, sourceRevisionId);
  if (downstream.total !== 0) {
    throw new ArticleIdentityApiError("SOURCE_BRANCH_HAS_DOWNSTREAM", "待修复 Branch 已有下游，不能复制归档", 409, { downstream });
  }
  const oldWorkItems = await db.prepare(`SELECT * FROM work_items WHERE branch_id=? AND state IN ('open','blocked')
    ORDER BY created_at, id`).bind(sourceBranchId).all<D1Row>();
  const existingIdentity = await db.prepare("SELECT * FROM article_identities WHERE canonical_article_id=? LIMIT 1")
    .bind(targetArticleId).first<D1Row>();
  const identityId = existingIdentity ? String(existingIdentity.id) : `identity-${crypto.randomUUID()}`;
  const identityWasCreated = !existingIdentity;
  const newBranchId = `branch-${crypto.randomUUID()}`;
  const newRevisionId = `revision-${crypto.randomUUID()}`;
  const newWorkItemId = `work-${crypto.randomUUID()}`;
  const firstWork = oldWorkItems.results[0];
  const newWorkItem = {
    id: newWorkItemId,
    title: firstWork ? String(firstWork.title) : `继续推进：${sourceRevision.title}`,
    kind: firstWork ? String(firstWork.kind) : "article",
    stage: firstWork ? String(firstWork.stage) : "inbox",
    priority: firstWork ? String(firstWork.priority) : "P2",
    owner: firstWork ? String(firstWork.owner) : "我",
    nextAction: firstWork ? String(firstWork.next_action) : "从修复后的 source owner 分支继续写作",
    blocker: firstWork ? String(firstWork.blocker) : "",
    sourceCapabilityId: firstWork?.source_capability_id ?? null,
    sortOrder: firstWork ? Number(firstWork.sort_order) : 0,
  };
  const plan: JsonObject = {
    apiVersion: API_VERSION, operationKind: "source_owner_repair", identityId, identityWasCreated,
    source: { articleId: expectedSourceArticleId, branchId: sourceBranchId, revisionId: sourceRevisionId,
      sourceVersionId, bodySha256: expectedBodySha256 },
    target: { articleId: targetArticleId, articleTitle: owner.articleTitle, branchId: newBranchId,
      revisionId: newRevisionId, workItemId: newWorkItemId },
    evidence: [...evidence, `corpus:${sourceVersionId}->${targetArticleId}`, `textHash:${owner.textHash}`],
  };
  const preconditions: JsonObject = {
    corpus: { schemaVersion: corpus.schemaVersion, algorithmVersion: corpus.algorithmVersion, generatedAt: corpus.generatedAt,
      sourceVersionId, ownerArticleId: owner.articleId, textHash: owner.textHash },
    sourceBranch: { id: sourceBranchId, articleId: sourceBranch.article_id, headRevisionId: sourceBranch.head_revision_id,
      baseRevisionId: sourceBranch.base_revision_id, baseSourceVersionId: sourceBranch.base_source_version_id,
      status: sourceBranch.status, updatedAt: sourceBranch.updated_at },
    sourceRevision: { id: sourceRevisionId, bodySha256: sourceRevision.body_sha256, sourceVersionId: sourceRevision.source_version_id },
    workingCopy: { branchId: sourceBranchId, baseRevisionId: workingCopy.base_revision_id,
      bodySha256: workingCopy.body_sha256, dirty: Number(workingCopy.dirty), lockVersion: Number(workingCopy.lock_version),
      updatedAt: workingCopy.updated_at },
    downstream,
    oldWorkItems: oldWorkItems.results.map((row) => ({ id: row.id, state: row.state, updatedAt: row.updated_at })),
  };
  const inverse: JsonObject = {
    sourceBranchStatus: sourceBranch.status,
    oldWorkItems: oldWorkItems.results.map((row) => ({ id: row.id, state: row.state, updatedAt: row.updated_at })),
    newBranchId, newRevisionId, newWorkItemId, identityWasCreated,
    rollbackRequires: "new branch remains clean, unchanged, and has no downstream",
  };
  const operation = await insertPlannedOperation(db, {
    operationKind: "source_owner_repair", commandId, actorId, identityId, plan, preconditions,
    inverse: { ...inverse, newWorkItem }, inputSha256,
  });
  return { status: 201, data: { ...operation, operationKind: "source_owner_repair", identityId, plan, preconditions, autoApplied: false } };
}

async function applySourceOwnerRepair(db: D1Database, payload: JsonObject, actorId: string) {
  const operationId = requiredId(payload.operationId, "operationId");
  const expectedPlanSha256 = requiredSha(payload.expectedPlanSha256, "expectedPlanSha256");
  const operation = await requiredRow(db,
    "SELECT * FROM article_identity_operations WHERE id=? AND operation_kind='source_owner_repair' LIMIT 1",
    [operationId], "OPERATION_NOT_FOUND", "没有找到 source-owner repair 计划", { operationId });
  if (operation.status !== "planned" || operation.plan_sha256 !== expectedPlanSha256) {
    throw new ArticleIdentityApiError("OPERATION_STALE", "source-owner repair 计划不是可执行状态或摘要不匹配", 409,
      { operationId, status: operation.status });
  }
  const { plan, preconditions, inverse } = operationPayload(operation);
  const source = plan.source as JsonObject;
  const target = plan.target as JsonObject;
  const sourceBranch = preconditions.sourceBranch as JsonObject;
  const working = preconditions.workingCopy as JsonObject;
  const identityId = requiredId(plan.identityId, "plan.identityId");
  const identityWasCreated = plan.identityWasCreated === true;
  const oldWorkItems = Array.isArray(preconditions.oldWorkItems) ? preconditions.oldWorkItems.filter(isObject) : [];
  const newWorkItem = (inverse.newWorkItem ?? {}) as JsonObject;
  const owner = corpusVersionOwner(requiredId(source.sourceVersionId, "plan.source.sourceVersionId"));
  if (owner.articleId !== target.articleId || owner.textHash !== source.bodySha256) {
    throw new ArticleIdentityApiError("CORPUS_SNAPSHOT_CHANGED", "当前 corpus owner/textHash 已不再匹配计划", 409, { owner });
  }
  const now = isoNow();
  const workGuards = oldWorkItems.map(() => "AND EXISTS(SELECT 1 FROM work_items WHERE id=? AND branch_id=? AND state=? AND updated_at=?)").join("\n");
  const workGuardBinds = oldWorkItems.flatMap((item) => [item.id, source.branchId, item.state, item.updatedAt]);
  const guard = `id=? AND operation_kind='source_owner_repair' AND status='planned' AND plan_sha256=?
    AND EXISTS(SELECT 1 FROM article_branches WHERE id=? AND article_id=? AND status='active'
      AND head_revision_id=? AND base_source_version_id=? AND updated_at=?)
    AND EXISTS(SELECT 1 FROM article_revisions WHERE id=? AND article_id=? AND branch_id=?
      AND source_version_id=? AND body_sha256=?)
    AND EXISTS(SELECT 1 FROM branch_working_copies WHERE branch_id=? AND article_id=? AND base_revision_id=?
      AND body_sha256=? AND dirty=0 AND lock_version=? AND updated_at=?)
    AND NOT EXISTS(SELECT 1 FROM package_branch_states WHERE branch_id=?)
    AND NOT EXISTS(SELECT 1 FROM lifecycle_builds WHERE branch_id=? OR revision_id=?)
    AND NOT EXISTS(SELECT 1 FROM agent_tasks WHERE target_branch_id=? OR base_revision_id=?)
    AND NOT EXISTS(SELECT 1 FROM merge_proposals WHERE source_branch_id=? OR target_branch_id=?
      OR source_head_revision_id=? OR target_head_revision_id=? OR merge_revision_id=?)
    ${workGuards}`;
  const guardBinds = [operationId, expectedPlanSha256,
    source.branchId, source.articleId, source.revisionId, source.sourceVersionId, sourceBranch.updatedAt,
    source.revisionId, source.articleId, source.branchId, source.sourceVersionId, source.bodySha256,
    source.branchId, source.articleId, source.revisionId, source.bodySha256, working.lockVersion, working.updatedAt,
    source.branchId, source.branchId, source.revisionId, source.branchId, source.revisionId,
    source.branchId, source.branchId, source.revisionId, source.revisionId, source.revisionId,
    ...workGuardBinds];
  const result = {
    identityId, sourceArticleId: source.articleId, targetArticleId: target.articleId,
    archivedSourceBranchId: source.branchId, newBranchId: target.branchId,
    sourceRevisionId: source.revisionId, newRevisionId: target.revisionId,
    immutableSourceRevisionPreserved: true,
  };
  const statements: D1PreparedStatement[] = [
    db.prepare(`UPDATE article_identity_operations SET status='applied', applied_by=?, applied_at=?, updated_at=?,
      lock_version=lock_version+1, result_json=? WHERE ${guard}`)
      .bind(actorId, now, now, canonicalJson(result), ...guardBinds),
  ];
  const operationGuard = "EXISTS(SELECT 1 FROM article_identity_operations WHERE id=? AND status='applied' AND applied_at=? AND plan_sha256=?)";
  if (identityWasCreated) {
    statements.push(db.prepare(`INSERT INTO article_identities
      (id, canonical_article_id, title, status, visibility, lock_version, created_by, created_at, updated_at)
      SELECT ?, ?, ?, 'active', 'primary', 1, ?, ?, ? WHERE ${operationGuard}`)
      .bind(identityId, target.articleId, owner.articleTitle, actorId, now, now, operationId, now, expectedPlanSha256));
  }
  statements.push(
    db.prepare(`INSERT INTO article_revisions
      (id, article_id, branch_id, sequence, parent_revision_id, merge_parent_revision_id, source_version_id,
       title, document_title, annotation, body_text, body_sha256, author_kind, created_at)
      SELECT ?, ?, ?, 1, NULL, NULL, ?, title, document_title,
        annotation || CASE WHEN annotation='' THEN '' ELSE '；' END || 'source-owner repaired; original revision preserved',
        body_text, body_sha256, 'import', ? FROM article_revisions
      WHERE id=? AND article_id=? AND body_sha256=? AND ${operationGuard}`)
      .bind(target.revisionId, target.articleId, target.branchId, source.sourceVersionId, now,
        source.revisionId, source.articleId, source.bodySha256, operationId, now, expectedPlanSha256),
    db.prepare(`INSERT INTO article_branches
      (id, article_id, name, slug, color, status, head_revision_id, base_revision_id, base_source_version_id, created_at, updated_at)
      SELECT ?, ?, 'owner-repair', ?, 'blue', 'active', ?, ?, ?, ?, ? WHERE ${operationGuard}`)
      .bind(target.branchId, target.articleId, `owner-repair-${String(target.branchId).slice(-8)}`,
        target.revisionId, target.revisionId, source.sourceVersionId, now, now, operationId, now, expectedPlanSha256),
    db.prepare(`INSERT INTO branch_working_copies
      (branch_id, article_id, base_revision_id, title, annotation, body_text, body_sha256, dirty, lock_version, updated_at)
      SELECT ?, ?, ?, title, annotation, body_text, body_sha256, 0, 1, ? FROM article_revisions
      WHERE id=? AND article_id=? AND body_sha256=? AND ${operationGuard}`)
      .bind(target.branchId, target.articleId, target.revisionId, now,
        target.revisionId, target.articleId, source.bodySha256, operationId, now, expectedPlanSha256),
    db.prepare(`INSERT INTO work_items
      (id, article_id, branch_id, title, kind, stage, state, priority, owner, next_action, blocker,
       source_capability_id, sort_order, created_at, updated_at)
      SELECT ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ? WHERE ${operationGuard}`)
      .bind(target.workItemId, target.articleId, target.branchId, newWorkItem.title, newWorkItem.kind, newWorkItem.stage,
        newWorkItem.priority, newWorkItem.owner, newWorkItem.nextAction, newWorkItem.blocker,
        newWorkItem.sourceCapabilityId ?? null, newWorkItem.sortOrder, now, now, operationId, now, expectedPlanSha256),
    db.prepare(`UPDATE article_branches SET status='archived', updated_at=?
      WHERE id=? AND article_id=? AND status='active' AND head_revision_id=? AND updated_at=? AND ${operationGuard}`)
      .bind(now, source.branchId, source.articleId, source.revisionId, sourceBranch.updatedAt, operationId, now, expectedPlanSha256),
  );
  for (const item of oldWorkItems) {
    statements.push(db.prepare(`UPDATE work_items SET state='cancelled', blocker='source-owner repaired; original task preserved', updated_at=?
      WHERE id=? AND branch_id=? AND state=? AND updated_at=? AND ${operationGuard}`)
      .bind(now, item.id, source.branchId, item.state, item.updatedAt, operationId, now, expectedPlanSha256));
  }
  const evidenceJson = canonicalJson(plan.evidence ?? []);
  const memberSpecs = [
    ["article", target.articleId, target.articleId, null, null, "canonical", "active", 0],
    ["branch", source.branchId, source.articleId, null, source.bodySha256, "owner_repair", "superseded", 1],
    ["revision", source.revisionId, source.articleId, source.revisionId, source.bodySha256, "owner_repair", "superseded", 1],
    ["branch", target.branchId, target.articleId, null, source.bodySha256, "branch", "active", 0],
    ["revision", target.revisionId, target.articleId, target.revisionId, source.bodySha256, "revision", "active", 0],
  ] as const;
  for (const [kind, objectId, articleId, revisionId, bodySha, role, state, hidden] of memberSpecs) {
    statements.push(db.prepare(`INSERT OR IGNORE INTO article_identity_members
      (id, identity_id, object_kind, object_id, article_id, revision_id, body_sha256, role, state,
       hidden_from_primary, evidence_json, input_sha256, operation_id, lock_version, created_at, updated_at)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ? WHERE ${operationGuard}`)
      .bind(`identity-member-${crypto.randomUUID()}`, identityId, kind, objectId, articleId, revisionId, bodySha,
        role, state, hidden, evidenceJson, operation.preconditions_sha256, operationId, now, now,
        operationId, now, expectedPlanSha256));
  }
  statements.push(
    db.prepare(`INSERT INTO article_lineage_links
      (id, identity_id, relation_type, source_kind, source_id, source_article_id, source_revision_id, source_body_sha256,
       target_kind, target_id, target_article_id, target_revision_id, target_body_sha256, status, evidence_json,
       input_sha256, operation_id, decided_by, decided_at, lock_version, created_at, updated_at)
      SELECT ?, ?, 'owner_repair', 'revision', ?, ?, ?, ?, 'revision', ?, ?, ?, ?, 'confirmed', ?, ?, ?, ?, ?, 1, ?, ?
      WHERE ${operationGuard}`)
      .bind(`lineage-${crypto.randomUUID()}`, identityId, source.revisionId, source.articleId, source.revisionId,
        source.bodySha256, target.revisionId, target.articleId, target.revisionId, source.bodySha256,
        evidenceJson, operation.preconditions_sha256, operationId, actorId, now, now, now,
        operationId, now, expectedPlanSha256),
    db.prepare(`INSERT INTO workspace_events
      (id, event_type, subject_type, subject_id, article_id, payload_json, input_sha256, created_at)
      SELECT ?, 'article.identity.owner_repaired', 'branch', ?, ?, ?, ?, ? WHERE ${operationGuard}`)
      .bind(`workspace-event-${crypto.randomUUID()}`, target.branchId, target.articleId,
        canonicalJson(result), operation.preconditions_sha256, now, operationId, now, expectedPlanSha256),
  );
  const applied = await db.batch(statements);
  if (Number(applied[0].meta.changes ?? 0) !== 1) {
    throw new ArticleIdentityApiError("PRECONDITION_FAILED", "source-owner repair 的 CAS/sentinel 前置条件已变化，未执行任何迁移", 409,
      { operationId });
  }
  return { data: { operationId, operationKind: "source_owner_repair", status: "applied", appliedAt: now, result } };
}

async function supersedeStaleOperation(db: D1Database, payload: JsonObject, actorId: string) {
  const operationId = requiredId(payload.operationId, "operationId");
  const expectedPlanSha256 = requiredSha(payload.expectedPlanSha256, "expectedPlanSha256");
  const expectedLockVersion = Number(payload.expectedLockVersion);
  if (!Number.isInteger(expectedLockVersion) || expectedLockVersion < 1) {
    throw new ArticleIdentityApiError("INVALID_LOCK_VERSION", "expectedLockVersion 必须是正整数");
  }
  const evidence = stringArray(payload.evidence, "evidence", 30);
  if (evidence.length === 0) {
    throw new ArticleIdentityApiError("EVIDENCE_REQUIRED", "收口 stale planned operation 至少需要一条人工审计说明");
  }
  const operation = await requiredRow(db,
    `SELECT * FROM article_identity_operations WHERE id=? AND operation_kind='consolidation'
      AND status='planned' AND plan_sha256=? AND lock_version=? LIMIT 1`,
    [operationId, expectedPlanSha256, expectedLockVersion],
    "STALE_OPERATION_NOT_AVAILABLE", "目标不是具有匹配摘要与锁版本的 planned consolidation", { operationId });
  const { plan, preconditions } = operationPayload(operation);
  const candidateId = requiredId(plan.candidateId, "operation.plan.candidateId");
  const candidatePrecondition = isObject(preconditions.candidate) ? preconditions.candidate : {};
  const candidate = await db.prepare("SELECT * FROM article_lineage_links WHERE id=? LIMIT 1")
    .bind(candidateId).first<D1Row>();
  const candidateIsTerminal = candidate !== null
    && ["confirmed", "superseded"].includes(String(candidate.status))
    && String(candidate.input_sha256) === String(candidatePrecondition.inputSha256 ?? "");
  const appliedRows = await db.prepare(`SELECT * FROM article_identity_operations
    WHERE id<>? AND operation_kind='consolidation' AND status='applied' ORDER BY applied_at DESC, id`)
    .bind(operationId).all<D1Row>();
  const appliedProof = appliedRows.results.find((row) => parseJson<JsonObject>(row.plan_json, {}).candidateId === candidateId) ?? null;
  if (!candidateIsTerminal && !appliedProof) {
    throw new ArticleIdentityApiError("SUPERSESSION_NOT_PROVEN",
      "只有 candidate 已 confirmed/superseded，或同 candidate 已有 applied consolidation，才能收口 planned 操作", 409,
      { operationId, candidateId, candidateStatus: candidate?.status ?? null });
  }
  const now = isoNow();
  const proof = candidateIsTerminal ? {
    kind: "terminal_candidate",
    candidateId,
    candidateStatus: candidate!.status,
    candidateInputSha256: candidate!.input_sha256,
    candidateLockVersion: Number(candidate!.lock_version),
  } : {
    kind: "same_candidate_applied",
    candidateId,
    appliedOperationId: appliedProof!.id,
    appliedPlanSha256: appliedProof!.plan_sha256,
    appliedAt: appliedProof!.applied_at,
  };
  const result = {
    terminalDisposition: "superseded",
    storageStatus: "rolled_back",
    candidateId,
    supersededAt: now,
    supersededByOperationId: appliedProof?.id ?? null,
    proof,
    evidence,
    note: "操作计划与摘要完整保留；该动作不 apply、不删除、不改写 Article/Branch/Revision",
  };
  const proofClause = candidateIsTerminal
    ? `EXISTS(SELECT 1 FROM article_lineage_links WHERE id=? AND status=? AND input_sha256=? AND lock_version=?)`
    : `EXISTS(SELECT 1 FROM article_identity_operations WHERE id=? AND status='applied' AND plan_sha256=?)`;
  const proofBinds = candidateIsTerminal
    ? [candidateId, candidate!.status, candidate!.input_sha256, candidate!.lock_version]
    : [appliedProof!.id, appliedProof!.plan_sha256];
  const changed = await db.prepare(`UPDATE article_identity_operations SET status='rolled_back', rolled_back_by=?,
    rolled_back_at=?, updated_at=?, lock_version=lock_version+1, result_json=?
    WHERE id=? AND operation_kind='consolidation' AND status='planned' AND plan_sha256=? AND lock_version=?
      AND ${proofClause}`)
    .bind(actorId, now, now, canonicalJson(result), operationId, expectedPlanSha256, expectedLockVersion, ...proofBinds).run();
  if (Number(changed.meta.changes ?? 0) !== 1) {
    throw new ArticleIdentityApiError("SUPERSESSION_CAS_FAILED", "planned operation 或证明坐标已变化，未执行收口", 409,
      { operationId, expectedLockVersion });
  }
  return {
    data: {
      operationId,
      operationKind: "consolidation",
      status: "superseded",
      storageStatus: "rolled_back",
      effectiveStatus: "superseded",
      lockVersion: expectedLockVersion + 1,
      result,
      autoApplied: false,
      deleted: false,
    },
  };
}

async function rollbackCandidateScan(db: D1Database, operation: D1Row, actorId: string, expectedPlanSha256: string) {
  const operationId = String(operation.id);
  const now = isoNow();
  const results = await db.batch([
    db.prepare(`UPDATE article_identity_operations SET status='rolled_back', rolled_back_by=?, rolled_back_at=?,
      updated_at=?, lock_version=lock_version+1 WHERE id=? AND operation_kind='candidate_scan' AND status='applied'
      AND plan_sha256=? AND NOT EXISTS(
        SELECT 1 FROM article_lineage_links WHERE operation_id=? AND status<>'candidate'
      )`).bind(actorId, now, now, operationId, expectedPlanSha256, operationId),
    db.prepare(`UPDATE article_lineage_links SET status='superseded', lock_version=lock_version+1, updated_at=?
      WHERE operation_id=? AND status='candidate' AND EXISTS(
        SELECT 1 FROM article_identity_operations WHERE id=? AND status='rolled_back' AND rolled_back_at=?
      )`).bind(now, operationId, operationId, now),
  ]);
  if (Number(results[0].meta.changes ?? 0) !== 1) {
    throw new ArticleIdentityApiError("ROLLBACK_BLOCKED", "候选已被决定或计划已变化，scan rollback fail-closed", 409, { operationId });
  }
  return { data: { operationId, operationKind: "candidate_scan", status: "rolled_back", rolledBackAt: now } };
}

async function rollbackConsolidation(db: D1Database, operation: D1Row, actorId: string, expectedPlanSha256: string) {
  const operationId = String(operation.id);
  const { plan, preconditions } = operationPayload(operation);
  const legacy = plan.legacy as JsonObject;
  const legacyPackage = preconditions.legacyPackage as JsonObject;
  const legacyState = preconditions.legacyPackageState as JsonObject;
  const identityWasCreated = plan.identityWasCreated === true;
  const appliedAt = requiredText(operation.applied_at, "operation.appliedAt", 80);
  const now = isoNow();
  const legacyImpact = await articleImpact(db, requiredId(legacy.articleId, "plan.legacy.articleId"),
    [requiredId(legacy.branchId, "plan.legacy.branchId")], [requiredId(legacy.revisionId, "plan.legacy.revisionId")]);
  if (legacyImpact.total !== 0) {
    throw new ArticleIdentityApiError("ROLLBACK_HAS_NEW_DOWNSTREAM", "legacy Article 在 apply 后出现新下游，拒绝回滚", 409, { legacyImpact });
  }
  const guard = `id=? AND operation_kind='consolidation' AND status='applied' AND plan_sha256=? AND applied_at=?
    AND EXISTS(SELECT 1 FROM article_project_packages WHERE id=? AND status='archived' AND lock_version=?)
    AND EXISTS(SELECT 1 FROM article_branches WHERE id=? AND status='archived' AND head_revision_id=? AND updated_at=?)
    AND EXISTS(SELECT 1 FROM package_branch_states WHERE package_id=? AND branch_id=? AND status='archived'
      AND head_revision_id=? AND lock_version=?)
    AND NOT EXISTS(SELECT 1 FROM lifecycle_article_projects WHERE article_id=?)
    AND NOT EXISTS(SELECT 1 FROM lifecycle_builds WHERE article_id=? OR branch_id=? OR revision_id=?)
    AND NOT EXISTS(SELECT 1 FROM lifecycle_releases WHERE article_id=?)`;
  const guardBinds = [operationId, expectedPlanSha256, appliedAt,
    legacy.packageId, Number(legacyPackage.lockVersion) + 1,
    legacy.branchId, legacy.revisionId, appliedAt,
    legacy.packageId, legacy.branchId, legacy.revisionId, Number(legacyState.lockVersion) + 1,
    legacy.articleId, legacy.articleId, legacy.branchId, legacy.revisionId, legacy.articleId];
  const operationGuard = "EXISTS(SELECT 1 FROM article_identity_operations WHERE id=? AND status='rolled_back' AND rolled_back_at=?)";
  const statements: D1PreparedStatement[] = [
    db.prepare(`UPDATE article_identity_operations SET status='rolled_back', rolled_back_by=?, rolled_back_at=?,
      updated_at=?, lock_version=lock_version+1 WHERE ${guard}`).bind(actorId, now, now, ...guardBinds),
    db.prepare(`UPDATE article_project_packages SET status='active', lock_version=lock_version+1, updated_at=?
      WHERE id=? AND status='archived' AND lock_version=? AND ${operationGuard}`)
      .bind(now, legacy.packageId, Number(legacyPackage.lockVersion) + 1, operationId, now),
    db.prepare(`UPDATE article_branches SET status='active', updated_at=?
      WHERE id=? AND status='archived' AND head_revision_id=? AND updated_at=? AND ${operationGuard}`)
      .bind(now, legacy.branchId, legacy.revisionId, appliedAt, operationId, now),
    db.prepare(`UPDATE package_branch_states SET status='active', lock_version=lock_version+1, updated_at=?
      WHERE package_id=? AND branch_id=? AND status='archived' AND lock_version=? AND ${operationGuard}`)
      .bind(now, legacy.packageId, legacy.branchId, Number(legacyState.lockVersion) + 1, operationId, now),
    db.prepare(`UPDATE article_identity_members SET state='archived', hidden_from_primary=1,
      lock_version=lock_version+1, updated_at=? WHERE operation_id=? AND state<>'archived' AND ${operationGuard}`)
      .bind(now, operationId, operationId, now),
    db.prepare(`UPDATE article_lineage_links SET status='superseded', lock_version=lock_version+1, updated_at=?
      WHERE operation_id=? AND status='confirmed' AND ${operationGuard}`)
      .bind(now, operationId, operationId, now),
    db.prepare(`UPDATE article_lineage_links SET identity_id=NULL, status='candidate', decided_by=NULL, decided_at=NULL,
      lock_version=lock_version+1, updated_at=? WHERE id=? AND operation_id<>? AND status='confirmed' AND ${operationGuard}`)
      .bind(now, plan.candidateId, operationId, operationId, now),
  ];
  if (identityWasCreated) {
    statements.push(db.prepare(`UPDATE article_identities SET status='archived', visibility='hidden',
      lock_version=lock_version+1, updated_at=? WHERE id=? AND lock_version=1
      AND NOT EXISTS(SELECT 1 FROM article_identity_members WHERE identity_id=? AND operation_id<>? AND state<>'archived')
      AND ${operationGuard}`)
      .bind(now, plan.identityId, plan.identityId, operationId, operationId, now));
  }
  const results = await db.batch(statements);
  if (Number(results[0].meta.changes ?? 0) !== 1) {
    throw new ArticleIdentityApiError("ROLLBACK_BLOCKED", "consolidation 的逆操作 CAS/sentinel 不再成立，拒绝部分回滚", 409,
      { operationId });
  }
  return { data: { operationId, operationKind: "consolidation", status: "rolled_back", rolledBackAt: now,
    restored: { legacyPackageId: legacy.packageId, legacyBranchId: legacy.branchId },
    canonicalMutated: false } };
}

async function rollbackSourceOwnerRepair(db: D1Database, operation: D1Row, actorId: string, expectedPlanSha256: string) {
  const operationId = String(operation.id);
  const { plan, preconditions } = operationPayload(operation);
  const source = plan.source as JsonObject;
  const target = plan.target as JsonObject;
  const oldWorkItems = Array.isArray(preconditions.oldWorkItems) ? preconditions.oldWorkItems.filter(isObject) : [];
  const appliedAt = requiredText(operation.applied_at, "operation.appliedAt", 80);
  const newDownstream = await branchDownstream(db, requiredId(target.branchId, "target.branchId"), requiredId(target.revisionId, "target.revisionId"));
  if (newDownstream.total !== 0) {
    throw new ArticleIdentityApiError("ROLLBACK_HAS_NEW_DOWNSTREAM", "修复后的新 Branch 已产生下游，拒绝回滚", 409, { newDownstream });
  }
  const now = isoNow();
  const workGuards = oldWorkItems.map(() => "AND EXISTS(SELECT 1 FROM work_items WHERE id=? AND branch_id=? AND state='cancelled' AND updated_at=?)").join("\n");
  const workGuardBinds = oldWorkItems.flatMap((item) => [item.id, source.branchId, appliedAt]);
  const guard = `id=? AND operation_kind='source_owner_repair' AND status='applied' AND plan_sha256=? AND applied_at=?
    AND EXISTS(SELECT 1 FROM article_branches WHERE id=? AND article_id=? AND status='archived' AND head_revision_id=? AND updated_at=?)
    AND EXISTS(SELECT 1 FROM article_branches WHERE id=? AND article_id=? AND status='active' AND head_revision_id=? AND updated_at=?)
    AND EXISTS(SELECT 1 FROM branch_working_copies WHERE branch_id=? AND article_id=? AND base_revision_id=?
      AND body_sha256=? AND dirty=0 AND lock_version=1 AND updated_at=?)
    AND EXISTS(SELECT 1 FROM work_items WHERE id=? AND branch_id=? AND state='open' AND updated_at=?)
    ${workGuards}`;
  const guardBinds = [operationId, expectedPlanSha256, appliedAt,
    source.branchId, source.articleId, source.revisionId, appliedAt,
    target.branchId, target.articleId, target.revisionId, appliedAt,
    target.branchId, target.articleId, target.revisionId, source.bodySha256, appliedAt,
    target.workItemId, target.branchId, appliedAt, ...workGuardBinds];
  const operationGuard = "EXISTS(SELECT 1 FROM article_identity_operations WHERE id=? AND status='rolled_back' AND rolled_back_at=?)";
  const statements: D1PreparedStatement[] = [
    db.prepare(`UPDATE article_identity_operations SET status='rolled_back', rolled_back_by=?, rolled_back_at=?,
      updated_at=?, lock_version=lock_version+1 WHERE ${guard}`).bind(actorId, now, now, ...guardBinds),
    db.prepare(`UPDATE article_branches SET status='active', updated_at=? WHERE id=? AND status='archived'
      AND head_revision_id=? AND updated_at=? AND ${operationGuard}`)
      .bind(now, source.branchId, source.revisionId, appliedAt, operationId, now),
    db.prepare(`UPDATE article_branches SET status='archived', updated_at=? WHERE id=? AND status='active'
      AND head_revision_id=? AND updated_at=? AND ${operationGuard}`)
      .bind(now, target.branchId, target.revisionId, appliedAt, operationId, now),
    db.prepare(`UPDATE work_items SET state='cancelled', blocker='source-owner repair rolled back; copied history retained', updated_at=?
      WHERE id=? AND branch_id=? AND state='open' AND updated_at=? AND ${operationGuard}`)
      .bind(now, target.workItemId, target.branchId, appliedAt, operationId, now),
    db.prepare(`UPDATE article_identity_members SET state='archived', hidden_from_primary=1,
      lock_version=lock_version+1, updated_at=? WHERE operation_id=? AND state<>'archived' AND ${operationGuard}`)
      .bind(now, operationId, operationId, now),
    db.prepare(`UPDATE article_lineage_links SET status='superseded', lock_version=lock_version+1, updated_at=?
      WHERE operation_id=? AND status='confirmed' AND ${operationGuard}`)
      .bind(now, operationId, operationId, now),
  ];
  for (const item of oldWorkItems) {
    statements.push(db.prepare(`UPDATE work_items SET state=?, blocker='', updated_at=?
      WHERE id=? AND branch_id=? AND state='cancelled' AND updated_at=? AND ${operationGuard}`)
      .bind(item.state, now, item.id, source.branchId, appliedAt, operationId, now));
  }
  if (plan.identityWasCreated === true) {
    statements.push(db.prepare(`UPDATE article_identities SET status='archived', visibility='hidden', lock_version=lock_version+1,
      updated_at=? WHERE id=? AND lock_version=1
      AND NOT EXISTS(SELECT 1 FROM article_identity_members WHERE identity_id=? AND operation_id<>? AND state<>'archived')
      AND ${operationGuard}`)
      .bind(now, plan.identityId, plan.identityId, operationId, operationId, now));
  }
  statements.push(db.prepare(`INSERT INTO workspace_events
    (id, event_type, subject_type, subject_id, article_id, payload_json, input_sha256, created_at)
    SELECT ?, 'article.identity.owner_repair_rolled_back', 'branch', ?, ?, ?, ?, ? WHERE ${operationGuard}`)
    .bind(`workspace-event-${crypto.randomUUID()}`, target.branchId, target.articleId,
      canonicalJson({ operationId, retainedRevisionId: target.revisionId, retainedBranchId: target.branchId }),
      operation.preconditions_sha256, now, operationId, now));
  const results = await db.batch(statements);
  if (Number(results[0].meta.changes ?? 0) !== 1) {
    throw new ArticleIdentityApiError("ROLLBACK_BLOCKED", "source-owner repair 的逆操作 CAS/sentinel 不再成立，拒绝部分回滚", 409,
      { operationId });
  }
  return { data: { operationId, operationKind: "source_owner_repair", status: "rolled_back", rolledBackAt: now,
    restoredSourceBranchId: source.branchId, archivedCopiedBranchId: target.branchId,
    retainedImmutableRevisionId: target.revisionId } };
}

async function rollbackOperation(db: D1Database, payload: JsonObject, actorId: string) {
  const operationId = requiredId(payload.operationId, "operationId");
  const expectedPlanSha256 = requiredSha(payload.expectedPlanSha256, "expectedPlanSha256");
  const operation = await requiredRow(db, "SELECT * FROM article_identity_operations WHERE id=? LIMIT 1", [operationId],
    "OPERATION_NOT_FOUND", "没有找到可回滚的文章身份操作", { operationId });
  if (operation.status !== "applied" || operation.plan_sha256 !== expectedPlanSha256) {
    throw new ArticleIdentityApiError("ROLLBACK_NOT_AVAILABLE", "操作不是 applied 状态或计划摘要不匹配", 409,
      { operationId, status: operation.status });
  }
  if (operation.operation_kind === "candidate_scan") return rollbackCandidateScan(db, operation, actorId, expectedPlanSha256);
  if (operation.operation_kind === "consolidation") return rollbackConsolidation(db, operation, actorId, expectedPlanSha256);
  if (operation.operation_kind === "source_owner_repair") return rollbackSourceOwnerRepair(db, operation, actorId, expectedPlanSha256);
  throw new ArticleIdentityApiError("ROLLBACK_NOT_SUPPORTED", "该操作类型没有已验证的逆操作", 409,
    { operationKind: operation.operation_kind });
}

export async function GET(request: Request) {
  const id = responseId();
  try {
    await requireManagementSession(request, { scope: "management.read" });
    const db = await ensureArticleIdentitySchema();
    return jsonSuccess(id, await handleGet(db, new URL(request.url)) as JsonObject);
  } catch (error) {
    return jsonError(id, error);
  }
}

export async function POST(request: Request) {
  const id = responseId();
  try {
    const principal = await requireManagementSession(request, { mutation: true, scope: "identity.decide" });
    const { action, commandId, payload } = await parseMutationBody(request);
    const db = await ensureArticleIdentitySchema();
    const actorId = managementActorId(principal);
    const result = await withReceipt(db, action, actorId, commandId, payload, async (inputSha256) => {
      if (action === "scan_candidates") return scanCandidates(db, payload, actorId, commandId, inputSha256);
      if (action === "plan_consolidation") return planConsolidation(db, payload, actorId, commandId, inputSha256);
      if (action === "apply_consolidation") return applyConsolidation(db, payload, actorId);
      if (action === "plan_source_owner_repair") return planSourceOwnerRepair(db, payload, actorId, commandId, inputSha256);
      if (action === "apply_source_owner_repair") return applySourceOwnerRepair(db, payload, actorId);
      if (action === "supersede_stale_operation") return supersedeStaleOperation(db, payload, actorId);
      if (action === "rollback_operation") return rollbackOperation(db, payload, actorId);
      throw new ArticleIdentityApiError("UNKNOWN_ACTION", `未知文章身份动作：${action}`, 404);
    });
    return jsonSuccess(id, result.data, result.status);
  } catch (error) {
    return jsonError(id, error);
  }
}
