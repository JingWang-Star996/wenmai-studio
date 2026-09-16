export type SharedSourceRow = Record<string, string | number | null>;

export const SHARED_SOURCE_SCHEMA_VERSION = "wenmai-shared-source-read-v1";
export const SHARED_SOURCE_TABLES = ["shared_sources", "shared_source_versions", "shared_source_rights_assertions", "shared_source_access_snapshots", "shared_source_bindings", "shared_source_events"] as const;
const SHARED_SOURCE_TRIGGERS = ["shared_sources_no_delete", "shared_sources_update_guard", "shared_source_versions_no_update", "shared_source_versions_no_delete", "shared_source_versions_source_active", "shared_source_rights_assertions_no_update", "shared_source_rights_assertions_no_delete", "shared_source_rights_assertions_chain_guard", "shared_source_access_snapshots_no_update", "shared_source_access_snapshots_no_delete", "shared_source_access_snapshots_source_active", "shared_source_bindings_no_update", "shared_source_bindings_no_delete", "shared_source_bindings_chain_guard", "shared_source_bindings_tombstone_guard", "shared_source_events_no_update", "shared_source_events_no_delete", "shared_source_events_binding_source_guard"] as const;

export class SharedSourceReadError extends Error {
  code: string; status: number; details?: Record<string, unknown>;
  constructor(code: string, message: string, status = 400, details?: Record<string, unknown>) { super(message); this.code = code; this.status = status; this.details = details; }
}
const text = (value: unknown) => value === null || value === undefined ? null : String(value);
const activeAt = (from: unknown, until: unknown, now: string) => Boolean(text(from) && text(from)! <= now && (!text(until) || text(until)! > now));

export function latestAppendOnly<T extends SharedSourceRow>(rows: T[], generationField?: string): T | null {
  return rows.slice().sort((a, b) => Number(b[generationField ?? "__none"] ?? 0) - Number(a[generationField ?? "__none"] ?? 0) || String(b.created_at ?? "").localeCompare(String(a.created_at ?? "")) || String(b.id ?? "").localeCompare(String(a.id ?? "")))[0] ?? null;
}
export function latestMetadataAccessSnapshot(rows: SharedSourceRow[]) {
  return rows.filter((row) => row.capability === "metadata").sort((a, b) => String(b.observed_at ?? "").localeCompare(String(a.observed_at ?? "")) || String(b.created_at ?? "").localeCompare(String(a.created_at ?? "")) || String(b.id ?? "").localeCompare(String(a.id ?? "")))[0] ?? null;
}
export function latestRightsAssertion(rows: SharedSourceRow[]) {
  if (!rows.length) return { row: null, valid: true };
  const byId = new Map(rows.map((row) => [String(row.id), row])); const superseded = new Set(rows.map((row) => text(row.supersedes_assertion_id)).filter((id): id is string => Boolean(id)));
  if ([...superseded].some((id) => !byId.has(id))) return { row: null, valid: false };
  const leaves = rows.filter((row) => !superseded.has(String(row.id))); if (leaves.length !== 1) return { row: null, valid: false };
  const seen = new Set<string>(); let current: SharedSourceRow | undefined = leaves[0];
  while (current) { const id = String(current.id); if (seen.has(id)) return { row: null, valid: false }; seen.add(id); current = text(current.supersedes_assertion_id) ? byId.get(String(current.supersedes_assertion_id)) : undefined; }
  return { row: leaves[0], valid: seen.size === rows.length };
}

type AgentAuth = { id: string; role: string; articleIds: string[]; taskIds: string[]; scopes: string[]; expiresAt: string; permissionSnapshotSha256: string | null; authorityLineageId?: string | null; credentialPurpose?: string | null };
export function canonicalAuthzFingerprint(auth: AgentAuth) { return JSON.stringify({ articleIds: [...new Set(auth.articleIds)].sort(), authorityLineageId: auth.authorityLineageId ?? null, clientId: auth.id, credentialPurpose: auth.credentialPurpose ?? null, expiresAt: auth.expiresAt, permissionSnapshotSha256: auth.permissionSnapshotSha256, role: auth.role, scopes: [...new Set(auth.scopes)].sort(), taskIds: [...new Set(auth.taskIds)].sort() }); }
export async function authzFingerprintSha256(auth: AgentAuth) { const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalAuthzFingerprint(auth))); return [...new Uint8Array(digest)].map((item) => item.toString(16).padStart(2, "0")).join(""); }
function permitsMetadata(row: SharedSourceRow | null) { try { const uses = JSON.parse(String(row?.allowed_uses_json)); const restrictions = JSON.parse(String(row?.restrictions_json)); return Array.isArray(uses) && Array.isArray(restrictions) && uses.includes("metadata") && !restrictions.includes("metadata") && !restrictions.includes("all"); } catch { return false; } }
export function evaluateSharedSourceRead(input: { sourceStatus: unknown; binding: SharedSourceRow | null; rights: SharedSourceRow | null; access: SharedSourceRow | null; now: string; expectedFingerprint: string }) {
  if (input.sourceStatus !== "active") return { allowed: false, reason: "source_not_active" };
  if (!input.binding || input.binding.action !== "attach") return { allowed: false, reason: "binding_not_attached" };
  if (!input.rights || input.rights.decision !== "allow" || !activeAt(input.rights.valid_from, input.rights.valid_until, input.now) || !permitsMetadata(input.rights)) return { allowed: false, reason: "rights_not_allowed" };
  if (!input.access || input.access.capability !== "metadata" || input.access.result !== "granted" || !activeAt(input.access.observed_at, input.access.valid_until, input.now) || String(input.access.authz_fingerprint_sha256) !== input.expectedFingerprint) return { allowed: false, reason: "access_not_granted" };
  return { allowed: true, reason: "allowed" };
}

export async function requireSharedSourceReadiness(db: D1Database) {
  const expected = [...SHARED_SOURCE_TABLES, ...SHARED_SOURCE_TRIGGERS, "package_source_refs"];
  const rows = await db.prepare(`SELECT name, type FROM sqlite_master WHERE name IN (${expected.map(() => "?").join(",")})`).bind(...expected).all<SharedSourceRow>();
  const types = new Map(rows.results.map((row) => [String(row.name), String(row.type)]));
  const missingTables = [...SHARED_SOURCE_TABLES, "package_source_refs"].filter((name) => types.get(name) !== "table"); const missingTriggers = SHARED_SOURCE_TRIGGERS.filter((name) => types.get(name) !== "trigger");
  if (missingTables.length || missingTriggers.length) throw new SharedSourceReadError("SHARED_SOURCE_NOT_INITIALIZED", "共享来源元数据存储尚未完成初始化", 503, { missingTables, missingTriggers });
  return { legacyPackageSourceRefsAvailable: true };
}

function metadata(raw: unknown) { try { const value = JSON.parse(String(raw ?? "{}")); if (!value || typeof value !== "object" || Array.isArray(value)) return {}; return Object.fromEntries(Object.entries(value as Record<string, unknown>).flatMap(([key, item]) => ["title", "language", "documentType", "mediaKind", "classification", "tags"].includes(key) && (typeof item === "string" || Array.isArray(item)) ? [[key, item]] : [])); } catch { return {}; } }
function publicSource(source: SharedSourceRow, version: SharedSourceRow | null, rights: SharedSourceRow | null, access: SharedSourceRow | null, bindings: SharedSourceRow[], includeRefs: boolean) {
  return { id: String(source.id), sourceKey: String(source.source_key), origin: String(source.origin_kind), status: String(source.status), version: version ? { id: String(version.id), versionNo: Number(version.version_no), contentSha256: text(version.content_sha256), snapshotSha256: String(version.snapshot_sha256), metadata: metadata(version.metadata_json), capturedAt: String(version.captured_at) } : null, rights: rights ? { decision: String(rights.decision), validUntil: text(rights.valid_until), evidenceSha256: String(rights.evidence_sha256) } : { decision: "unknown" }, access: access ? { result: String(access.result), capability: String(access.capability), observedAt: String(access.observed_at), validUntil: text(access.valid_until) } : { result: "unknown" }, bindings: bindings.map((row) => ({ id: String(row.id), target: row.package_id ? { kind: "package", id: includeRefs ? String(row.package_id) : "authorized" } : { kind: "project_group", id: includeRefs ? String(row.project_group_id) : "authorized" }, targetKey: String(row.target_key), generation: Number(row.generation) })), evidenceAt: String(source.updated_at) };
}

export type SharedSourcePage = { limit: number; cursor?: string };
type Cursor = { updatedAt: string; id: string };
export function parseSharedSourcePage(limitRaw: string | null, cursorRaw: string | null): SharedSourcePage { const limit = limitRaw === null ? 50 : Number(limitRaw); if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new SharedSourceReadError("INVALID_LIMIT", "limit 必须是 1 到 100 的整数", 400); if (cursorRaw) decodeCursor(cursorRaw); return { limit, ...(cursorRaw ? { cursor: cursorRaw } : {}) }; }
function decodeCursor(value: string): Cursor { try { const parsed = JSON.parse(atob(value.replaceAll("-", "+").replaceAll("_", "/"))) as Cursor; if (!parsed || typeof parsed.updatedAt !== "string" || typeof parsed.id !== "string") throw new Error(); return parsed; } catch { throw new SharedSourceReadError("INVALID_CURSOR", "cursor 无效", 400); } }
function encodeCursor(value: Cursor) { return btoa(JSON.stringify(value)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", ""); }
export function currentBindings(rows: SharedSourceRow[]) { const current = new Map<string, SharedSourceRow>(); for (const row of rows) { const key = `${row.package_id ? `package:${row.package_id}` : `project_group:${row.project_group_id}`}:${row.target_key}`; const prior = current.get(key); if (!prior || Number(row.generation) > Number(prior.generation) || Number(row.generation) === Number(prior.generation) && String(row.created_at) > String(prior.created_at)) current.set(key, row); } return [...current.values()]; }
async function rowsForSources(db: D1Database, sources: SharedSourceRow[]) {
  const ids = sources.map((row) => String(row.id)); if (!ids.length) return { versions: [], rights: [], access: [], bindings: [] }; const clause = `source_id IN (${ids.map(() => "?").join(",")})`; const rows = await db.batch<SharedSourceRow>([db.prepare(`SELECT * FROM shared_source_versions WHERE ${clause}`).bind(...ids), db.prepare(`SELECT * FROM shared_source_rights_assertions WHERE ${clause}`).bind(...ids), db.prepare(`SELECT * FROM shared_source_access_snapshots WHERE ${clause}`).bind(...ids), db.prepare("SELECT * FROM shared_source_bindings")]); return { versions: rows[0].results, rights: rows[1].results, access: rows[2].results, bindings: rows[3].results };
}
async function sourcePage(db: D1Database, page?: SharedSourcePage, sourceId?: string) {
  const cursor = page?.cursor ? decodeCursor(page.cursor) : null; const result = sourceId ? await db.prepare("SELECT * FROM shared_sources WHERE id = ? LIMIT 1").bind(sourceId).all<SharedSourceRow>() : await db.prepare(`SELECT * FROM shared_sources ${cursor ? "WHERE updated_at < ? OR (updated_at = ? AND id > ?)" : ""} ORDER BY updated_at DESC, id ASC LIMIT ?`).bind(...(cursor ? [cursor.updatedAt, cursor.updatedAt, cursor.id, (page?.limit ?? 50) + 1] : [(page?.limit ?? 50) + 1])).all<SharedSourceRow>(); const sources = sourceId ? result.results : result.results.slice(0, page?.limit ?? 50); const tail = sources.at(-1); return { sources, hasMore: !sourceId && result.results.length > sources.length, nextCursor: !sourceId && result.results.length > sources.length && tail ? encodeCursor({ updatedAt: String(tail.updated_at), id: String(tail.id) }) : null };
}
function project(sources: SharedSourceRow[], data: Awaited<ReturnType<typeof rowsForSources>>, auth?: { id: string; fingerprint: string; now: string; scopes: string[]; packageIds: Set<string>; allArticles: boolean }) {
  return sources.flatMap((source) => { const version = latestAppendOnly(data.versions.filter((row) => row.source_id === source.id), "version_no"); if (!version) return []; const rightsState = latestRightsAssertion(data.rights.filter((row) => row.source_id === source.id && row.version_id === version.id)); const bindings = currentBindings(data.bindings).filter((row) => row.source_id === source.id && row.version_id === version.id && row.action === "attach"); const access = auth ? latestMetadataAccessSnapshot(data.access.filter((row) => row.source_id === source.id && row.version_id === version.id && row.subject_kind === "agent_client" && row.subject_ref === auth.id)) : latestMetadataAccessSnapshot(data.access.filter((row) => row.source_id === source.id && row.version_id === version.id)); const allowed = auth ? bindings.filter((binding) => Boolean(binding.package_id) && auth.scopes.includes("package.read") && (auth.allArticles || auth.packageIds.has(String(binding.package_id))) && rightsState.valid && evaluateSharedSourceRead({ sourceStatus: source.status, binding, rights: rightsState.row, access, now: auth.now, expectedFingerprint: auth.fingerprint }).allowed) : bindings; return !auth || allowed.length ? [publicSource(source, version, rightsState.row, access, allowed, !auth)] : []; });
}
export async function sharedSourceManagementProjection(db: D1Database, sourceId?: string, page?: SharedSourcePage) { await requireSharedSourceReadiness(db); const pageData = await sourcePage(db, page, sourceId); if (sourceId && !pageData.sources.length) throw new SharedSourceReadError("SHARED_SOURCE_NOT_FOUND", "共享来源不存在", 404); const sources = project(pageData.sources, await rowsForSources(db, pageData.sources)); return { schemaVersion: SHARED_SOURCE_SCHEMA_VERSION, readOnly: true, currentCapability: "metadata_projection_only", connector: { state: "unconfigured" }, sources, page: { limit: page?.limit ?? 50, hasMore: pageData.hasMore, nextCursor: pageData.nextCursor } }; }
export async function sharedSourceAgentProjection(db: D1Database, auth: AgentAuth, sourceId?: string, page?: SharedSourcePage) {
  await requireSharedSourceReadiness(db); const pageData = await sourcePage(db, page, sourceId); const allArticles = auth.articleIds.includes("*");
  const packageIds = allArticles ? new Set<string>() : auth.articleIds.length ? new Set((await db.prepare(`SELECT id FROM article_project_packages WHERE article_id IN (${auth.articleIds.map(() => "?").join(",")})`).bind(...auth.articleIds).all<SharedSourceRow>()).results.map((row) => String(row.id))) : new Set<string>();
  const sources = project(pageData.sources, await rowsForSources(db, pageData.sources), { id: auth.id, fingerprint: await authzFingerprintSha256(auth), now: new Date().toISOString(), scopes: auth.scopes, packageIds, allArticles }); if (sourceId && !sources.length) throw new SharedSourceReadError("SHARED_SOURCE_NOT_FOUND", "共享来源不存在或不在 Agent 可读边界内", 404); return { schemaVersion: SHARED_SOURCE_SCHEMA_VERSION, readOnly: true, scopeFiltered: true, currentCapability: "metadata_projection_only", sources, page: { limit: page?.limit ?? 50, hasMore: false, nextCursor: null } };
}
