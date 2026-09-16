import { MANAGEMENT_BROWSER_BINDING_HEADER, MANAGEMENT_BROWSER_BINDING_PATTERN, MANAGEMENT_CANONICAL_ORIGIN, MANAGEMENT_SESSION_ABSOLUTE_SECONDS, ManagementAuthError, constantTimeTextEqual, deriveCsrfToken, randomToken, sha256Text } from "./management-auth-core";
import { AGENT_PERMISSION_CATALOG_VERSION, agentPermissionCatalogSha256 } from "./agent-permission-catalog";
import { canonicalSiteFullControlManagementProjection, canonicalSiteFullControlV4ManagementProjection } from "./management-scope-catalog";
import { canonicalPermissionSnapshotJson, hasExactJsonKeys, isLowercaseSha256, isPlainJsonRecord } from "./permission-snapshot-canonical";

type D1Row = Record<string, string | number | null>;
const KEY_PATTERN = /^wenmai_agent_[a-f0-9]{32}_[a-f0-9]{32}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const EXCHANGE_COMMAND_ID_PATTERN = /^site-full-control-exchange:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const AGENT_CLIENT_ID_PATTERN = /^agent-client-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const AGENT_LINEAGE_CLIENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;
const SITE_FULL_CONTROL_MAX_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
const ROOT_SCOPES_JSON = '["site.full_control"]';
const V4_ROOT_ACTION_IDS_JSON = '["auth.site_full_control.exchange"]';
const V5_ROOT_ACTION_IDS_JSON = '["auth.site_full_control.direct","auth.site_full_control.exchange"]';
const ROOT_ARTICLE_IDS_JSON = '["*"]';
const ROOT_TASK_IDS_JSON = "[]";
const V4_ROOT_SNAPSHOT_KEYS = [
  "schemaVersion", "catalogVersion", "catalogSha256", "presetId", "role", "scopes", "actionIds",
  "credentialPurpose", "issuedBySourceClientId", "objectBoundary", "taskIds", "issuedAt", "expiresAt",
  "managementProjectionVersion", "managementScopes", "managementProjectionSha256",
] as const;
const V5_ROOT_SNAPSHOT_KEYS = [
  ...V4_ROOT_SNAPSHOT_KEYS,
  "directAgentApi",
] as const;
const ROOT_BOUNDARY_KEYS = ["schemaVersion", "mode", "articleIds", "includesFutureArticles"] as const;
const MAX_AUTHORITY_LINEAGE_DEPTH = 32;

export type SiteFullControlExchange = { sessionToken: string; maxAgeSeconds: number; principal: { sessionId: string; principalId: string; scopes: string[]; articleIds: string[]; objectBoundary: Record<string, unknown>; absoluteExpiresAt: string; idleExpiresAt: string; csrfToken: string; authBasis: "site_full_control_key"; sourceClientId: string } };

function deny(): never { throw new ManagementAuthError("SITE_FULL_CONTROL_AUTH_INVALID", "本机管理凭据无效", 401); }
function bearer(request: Request) {
  const value = request.headers.get("authorization") ?? "";
  const token = value.startsWith("Bearer ") ? value.slice(7).trim() : "";
  if (!KEY_PATTERN.test(token)) deny();
  return token;
}

export function assertSiteFullControlDirectTransport(request: Request, canonicalOrigin = MANAGEMENT_CANONICAL_ORIGIN) {
  const actual = new URL(request.url);
  if (actual.origin !== canonicalOrigin || request.headers.get("host")?.toLowerCase() !== "[::1]:3000") deny();
  if (request.headers.has("cookie") || request.headers.has("origin") || request.headers.has("referer") || request.headers.has("forwarded")
    || request.headers.has("x-forwarded-host") || request.headers.has("x-forwarded-for") || request.headers.has("x-forwarded-port")
    || request.headers.has("x-forwarded-proto") || request.headers.has("x-real-ip") || request.headers.has("x-wenmai-agent-transport")
    || request.headers.has("x-tailscale-user-login") || request.headers.has("x-tailscale-user-name")) deny();
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite && fetchSite !== "none") deny();
}

export function assertSiteFullControlExchangeRequest(request: Request, body: Record<string, unknown>, canonicalOrigin = MANAGEMENT_CANONICAL_ORIGIN) {
  const actual = new URL(request.url);
  if (actual.origin !== canonicalOrigin || request.headers.get("host")?.toLowerCase() !== "[::1]:3000") deny();
  const forwardedHost = request.headers.get("x-forwarded-host");
  if (forwardedHost !== null && forwardedHost.toLowerCase() !== "[::1]:3000") deny();
  if (request.headers.has("cookie") || request.headers.has("referer") || request.headers.has("forwarded") || request.headers.has("x-forwarded-for") || request.headers.has("x-forwarded-port") || request.headers.has("x-forwarded-proto") || request.headers.has("x-real-ip") || request.headers.has("x-tailscale-user-login") || request.headers.has("x-tailscale-user-name")) deny();
  if (request.headers.get("origin") !== canonicalOrigin || request.headers.get("sec-fetch-site") !== "same-origin") deny();
  if (!request.headers.get("accept")?.toLowerCase().includes("application/json") || !request.headers.get("content-type")?.toLowerCase().includes("application/json")) deny();
  if (Object.keys(body).length !== 3 || body.action !== "site_full_control.exchange" || typeof body.browserBindingSha256 !== "string" || typeof body.exchangeCommandId !== "string" || !SHA256_PATTERN.test(body.browserBindingSha256) || !EXCHANGE_COMMAND_ID_PATTERN.test(body.exchangeCommandId)) deny();
  const header = request.headers.get(MANAGEMENT_BROWSER_BINDING_HEADER) ?? "";
  if (!MANAGEMENT_BROWSER_BINDING_PATTERN.test(header)) deny();
}

export async function revokeDerivedSiteFullControlSessions(db: D1Database, sourceClientId: string, reason: string, now = new Date().toISOString()) {
  return db.prepare("UPDATE management_sessions SET status = 'revoked', revoked_at = ?, revoke_reason = ? WHERE auth_basis = 'site_full_control_key' AND source_client_id = ? AND status = 'active'").bind(now, reason, sourceClientId).run();
}

type VerifiedSiteFullControlKey = {
  id: string;
  createdAt: string;
  expiresAt: string;
  expiresMs: number;
  issuedBySourceClientId: string | null;
  exchangeGeneration: number;
  snapshotJson: string;
  snapshotSha256: string;
  snapshotCatalogVersion: string;
  snapshotCatalogSha256: string;
  managementScopes: string[];
  managementProjectionVersion: string;
  managementProjectionSha256: string;
  credentialPurpose: "management_session_exchange" | "site_full_control";
  authorityLineageId: string;
};

type AgentLineageRow = {
  id: string;
  status: string;
  expires_at: string;
  credential_purpose: string;
  issued_by_source_client_id: string | null;
};

function exactStringArray(value: unknown, expected: readonly string[]) {
  return Array.isArray(value)
    && value.length === expected.length
    && value.every((item, index) => item === expected[index]);
}

function canonicalIso(value: unknown) {
  if (typeof value !== "string") return null;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value ? { value, time } : null;
}

async function verifiedSiteFullControlKey(
  db: D1Database,
  lookup: { tokenSha256: string } | { clientId: string },
  nowMs: number,
  verifyLineage = true,
): Promise<VerifiedSiteFullControlKey> {
  let row: D1Row | null = null;
  try {
    row = await db.prepare(`SELECT
      client.id AS client_id,
      client.status AS client_status,
      client.role AS client_role,
      client.scopes_json AS client_scopes_json,
      client.article_ids_json AS client_article_ids_json,
      client.task_ids_json AS client_task_ids_json,
      client.credential_purpose AS client_credential_purpose,
      client.issued_by_source_client_id AS client_issued_by_source_client_id,
      client.exchange_generation AS client_exchange_generation,
      client.created_at AS client_created_at,
      client.expires_at AS client_expires_at,
      snapshot.client_id AS snapshot_client_id,
      snapshot.schema_version AS snapshot_schema_version,
      snapshot.catalog_version AS snapshot_catalog_version,
      snapshot.preset_id AS snapshot_preset_id,
      snapshot.role AS snapshot_role,
      snapshot.scopes_json AS snapshot_scopes_json,
      snapshot.action_ids_json AS snapshot_action_ids_json,
      snapshot.article_ids_json AS snapshot_article_ids_json,
      snapshot.task_ids_json AS snapshot_task_ids_json,
      snapshot.snapshot_json AS snapshot_json,
      snapshot.snapshot_sha256 AS snapshot_sha256,
      snapshot.created_at AS snapshot_created_at
    FROM agent_clients client
    INNER JOIN agent_client_permission_snapshots snapshot ON snapshot.client_id = client.id
    WHERE ${"tokenSha256" in lookup ? "client.token_sha256" : "client.id"} = ? LIMIT 1`)
      .bind("tokenSha256" in lookup ? lookup.tokenSha256 : lookup.clientId).first<D1Row>();
  } catch {
    deny();
  }
  if (!row) deny();

  const id = String(row.client_id ?? "");
  const created = canonicalIso(row.client_created_at);
  const expires = canonicalIso(row.client_expires_at);
  const issuer = row.client_issued_by_source_client_id === null ? null : String(row.client_issued_by_source_client_id ?? "");
  const generation = Number(row.client_exchange_generation);
  const snapshotJson = String(row.snapshot_json ?? "");
  const snapshotSha256 = String(row.snapshot_sha256 ?? "");
  const isV5 = row.client_credential_purpose === "site_full_control";
  const actionIdsJson = isV5 ? V5_ROOT_ACTION_IDS_JSON : V4_ROOT_ACTION_IDS_JSON;
  if (!AGENT_CLIENT_ID_PATTERN.test(id)
    || row.client_status !== "active"
    || row.client_role !== "super_admin"
    || row.client_scopes_json !== ROOT_SCOPES_JSON
    || row.client_article_ids_json !== ROOT_ARTICLE_IDS_JSON
    || row.client_task_ids_json !== ROOT_TASK_IDS_JSON
    || (row.client_credential_purpose !== "management_session_exchange" && !isV5)
    || (issuer !== null && !AGENT_CLIENT_ID_PATTERN.test(issuer))
    || !Number.isSafeInteger(generation) || generation < 0
    || !created || !expires || created.time > nowMs || expires.time <= nowMs
    || expires.time <= created.time || expires.time - created.time > SITE_FULL_CONTROL_MAX_LIFETIME_MS
    || row.snapshot_client_id !== id
    || Number(row.snapshot_schema_version) !== 3
    || row.snapshot_preset_id !== "site_full_control"
    || row.snapshot_role !== "super_admin"
    || row.snapshot_scopes_json !== ROOT_SCOPES_JSON
    || row.snapshot_action_ids_json !== actionIdsJson
    || row.snapshot_article_ids_json !== ROOT_ARTICLE_IDS_JSON
    || row.snapshot_task_ids_json !== ROOT_TASK_IDS_JSON
    || row.snapshot_created_at !== created.value
    || !SHA256_PATTERN.test(snapshotSha256)) deny();

  let document: unknown;
  try { document = JSON.parse(snapshotJson); } catch { deny(); }
  if (!isPlainJsonRecord(document) || !hasExactJsonKeys(document, isV5 ? V5_ROOT_SNAPSHOT_KEYS : V4_ROOT_SNAPSHOT_KEYS)) deny();
  const boundary = document.objectBoundary;
  if (!isPlainJsonRecord(boundary) || !hasExactJsonKeys(boundary, ROOT_BOUNDARY_KEYS)) deny();
  // The table keeps its outer v3 discriminator. v4 is exchange-only; v5
  // signs the additional direct action and therefore never upgrades v4.
  const projection = isV5
    ? canonicalSiteFullControlManagementProjection()
    : canonicalSiteFullControlV4ManagementProjection();
  const projectionSha256 = await sha256Text(canonicalPermissionSnapshotJson(projection));
  if (document.schemaVersion !== (isV5 ? 5 : 4)
    || typeof document.catalogVersion !== "string" || document.catalogVersion.length < 1 || document.catalogVersion.length > 80
    || typeof document.catalogSha256 !== "string" || !SHA256_PATTERN.test(document.catalogSha256)
    || document.presetId !== "site_full_control"
    || document.role !== "super_admin"
    || !exactStringArray(document.scopes, ["site.full_control"])
    || !exactStringArray(document.actionIds, isV5 ? ["auth.site_full_control.direct", "auth.site_full_control.exchange"] : ["auth.site_full_control.exchange"])
    || document.credentialPurpose !== (isV5 ? "site_full_control" : "management_session_exchange")
    || (isV5 && document.directAgentApi !== true)
    || document.issuedBySourceClientId !== issuer
    || document.issuedAt !== created.value
    || document.expiresAt !== expires.value
    || !exactStringArray(document.taskIds, [])
    || document.managementProjectionVersion !== projection.managementProjectionVersion
    || !exactStringArray(document.managementScopes, projection.managementScopes)
    || !isLowercaseSha256(document.managementProjectionSha256)
    || !constantTimeTextEqual(document.managementProjectionSha256, projectionSha256)
    || boundary.schemaVersion !== "wenmai.agent-object-boundary/articles-v2"
    || boundary.mode !== "all_articles"
    || !exactStringArray(boundary.articleIds, ["*"])
    || boundary.includesFutureArticles !== true
    || row.snapshot_catalog_version !== document.catalogVersion) deny();

  if (isV5) {
    const currentCatalogSha256 = await agentPermissionCatalogSha256();
    if (document.catalogVersion !== AGENT_PERMISSION_CATALOG_VERSION
      || !constantTimeTextEqual(String(document.catalogSha256), currentCatalogSha256)) deny();
  }

  let canonical: string;
  try { canonical = canonicalPermissionSnapshotJson(document); } catch { deny(); }
  if (canonical !== snapshotJson || !constantTimeTextEqual(await sha256Text(canonical), snapshotSha256)) deny();
  const authorityLineageId = verifyLineage
    ? await assertActiveAgentClientLineage(db, id, nowMs)
    : id;
  return {
    id,
    createdAt: created.value,
    expiresAt: expires.value,
    expiresMs: expires.time,
    issuedBySourceClientId: issuer,
    exchangeGeneration: generation,
    snapshotJson,
    snapshotSha256,
    snapshotCatalogVersion: String(row.snapshot_catalog_version),
    snapshotCatalogSha256: String(document.catalogSha256),
    managementScopes: [...projection.managementScopes],
    managementProjectionVersion: projection.managementProjectionVersion,
    managementProjectionSha256: projectionSha256,
    credentialPurpose: isV5 ? "site_full_control" : "management_session_exchange",
    authorityLineageId,
  };
}

async function lineageRow(db: D1Database, clientId: string) {
  if (!AGENT_LINEAGE_CLIENT_ID_PATTERN.test(clientId)) deny();
  let row: AgentLineageRow | null = null;
  try {
    row = await db.prepare(`SELECT id,status,expires_at,credential_purpose,issued_by_source_client_id
      FROM agent_clients WHERE id = ? LIMIT 1`).bind(clientId).first<AgentLineageRow>();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/no such column:\s*(?:credential_purpose|issued_by_source_client_id)/iu.test(message)) deny();
    // Pre-0023 databases cannot contain a persisted parent reference. Keep
    // their frozen v3 clients usable as rootless agent_api credentials until
    // the atomic 0025 bootstrap/migration runs; never infer a privileged root.
    const legacy = await db.prepare(`SELECT id,status,expires_at
      FROM agent_clients WHERE id = ? LIMIT 1`).bind(clientId).first<Pick<AgentLineageRow, "id" | "status" | "expires_at">>();
    row = legacy ? { ...legacy, credential_purpose: "agent_api", issued_by_source_client_id: null } : null;
  }
  if (!row || row.id !== clientId) deny();
  return row;
}

async function resolveAgentAuthorityLineage(
  db: D1Database,
  clientId: string,
  options: { requireActive: boolean; nowMs: number },
) {
  const seen = new Set<string>();
  let currentId = clientId;
  for (let depth = 0; depth < MAX_AUTHORITY_LINEAGE_DEPTH; depth += 1) {
    if (seen.has(currentId)) deny();
    seen.add(currentId);
    const row = await lineageRow(db, currentId);
    const expiry = Date.parse(row.expires_at);
    if (options.requireActive && (row.status !== "active" || !Number.isFinite(expiry) || expiry <= options.nowMs)) deny();
    const parentId = row.issued_by_source_client_id;
    if (parentId === null) return { rootClientId: currentId, clientIds: [...seen] };
    if (!AGENT_LINEAGE_CLIENT_ID_PATTERN.test(parentId) || parentId === currentId) deny();
    const parent = await lineageRow(db, parentId);
    if (parent.credential_purpose !== "site_full_control" && parent.credential_purpose !== "management_session_exchange") deny();
    if (options.requireActive) {
      // A parent root is not merely an active row: its immutable signed root
      // snapshot must still validate under its own v4/v5 contract.
      await verifiedSiteFullControlKey(db, { clientId: parentId }, options.nowMs, false);
    }
    currentId = parentId;
  }
  deny();
}

/** Every presentation of a derived Key revalidates its complete authority chain. */
export async function assertActiveAgentClientLineage(db: D1Database, clientId: string, nowMs = Date.now()) {
  return (await resolveAgentAuthorityLineage(db, clientId, { requireActive: true, nowMs })).rootClientId;
}

/** Structural comparison for self-approval gates; missing/cyclic lineage fails closed. */
export async function sameAgentAuthorityLineage(db: D1Database, firstClientId: string, secondClientId: string) {
  const nowMs = Date.now();
  const [first, second] = await Promise.all([
    resolveAgentAuthorityLineage(db, firstClientId, { requireActive: false, nowMs }),
    resolveAgentAuthorityLineage(db, secondClientId, { requireActive: false, nowMs }),
  ]);
  return first.rootClientId === second.rootClientId;
}

export async function verifyActiveSiteFullControlSessionSource(
  db: D1Database,
  input: { sourceClientId: string; sourcePermissionSnapshotSha256: string; sourceExchangeGeneration: number; nowMs?: number },
) {
  if (!AGENT_CLIENT_ID_PATTERN.test(input.sourceClientId)
    || !SHA256_PATTERN.test(input.sourcePermissionSnapshotSha256)
    || !Number.isSafeInteger(input.sourceExchangeGeneration)
    || input.sourceExchangeGeneration < 1) deny();
  const source = await verifiedSiteFullControlKey(db, { clientId: input.sourceClientId }, input.nowMs ?? Date.now());
  if (!constantTimeTextEqual(source.snapshotSha256, input.sourcePermissionSnapshotSha256)
    || source.exchangeGeneration !== input.sourceExchangeGeneration) deny();
  return source;
}

/** Verify only a newly-issued v5 root Key for machine-to-machine direct use. */
export async function verifyDirectSiteFullControlKey(input: { request: Request; db: D1Database; canonicalOrigin?: string }) {
  assertSiteFullControlDirectTransport(input.request, input.canonicalOrigin ?? MANAGEMENT_CANONICAL_ORIGIN);
  const tokenSha256 = await sha256Text(bearer(input.request));
  const key = await verifiedSiteFullControlKey(input.db, { tokenSha256 }, Date.now());
  if (key.credentialPurpose !== "site_full_control") deny();
  return key;
}

export async function exchangeSiteFullControlKey(input: { request: Request; body: Record<string, unknown>; requestId: string; db: D1Database; csrfHmacKey: string; canonicalOrigin?: string }): Promise<SiteFullControlExchange> {
  const origin = input.canonicalOrigin ?? MANAGEMENT_CANONICAL_ORIGIN;
  assertSiteFullControlExchangeRequest(input.request, input.body, origin);
  const bindingSha256 = await sha256Text(input.request.headers.get(MANAGEMENT_BROWSER_BINDING_HEADER) ?? "");
  if (!constantTimeTextEqual(bindingSha256, String(input.body.browserBindingSha256).toLowerCase())) deny();
  const exchangeCommandSha256 = await sha256Text(String(input.body.exchangeCommandId));
  const tokenSha256 = await sha256Text(bearer(input.request));
  const now = new Date();
  const key = await verifiedSiteFullControlKey(input.db, { tokenSha256 }, now.getTime());
  const expiresAt = key.expiresAt;
  const expiresMs = key.expiresMs;
  const sessionId = `management-session-${crypto.randomUUID()}`;
  const sessionToken = `wenmai_management_${randomToken(32)}`;
  const sessionSha256 = await sha256Text(sessionToken);
  const generation = key.exchangeGeneration + 1;
  const seconds = Math.max(1, Math.min(MANAGEMENT_SESSION_ABSOLUTE_SECONDS, Math.floor((expiresMs - now.getTime()) / 1000)));
  const nowText = now.toISOString(); const absoluteExpiresAt = new Date(now.getTime() + seconds * 1000).toISOString(); const idleExpiresAt = new Date(now.getTime() + Math.min(seconds, 30 * 60) * 1000).toISOString();
  const scoped = [...key.managementScopes];
  const objectBoundary = { articles: ["*"], allArticles: true, includesFutureArticles: true, authBasis: "site_full_control_key", sourceClientId: key.id };
  const cas = await input.db.prepare(`UPDATE agent_clients SET exchange_generation = exchange_generation + 1, last_seen_at = ?
      WHERE id = ? AND token_sha256 = ? AND status = 'active' AND role = 'super_admin'
        AND scopes_json = ? AND article_ids_json = ? AND task_ids_json = ?
        AND credential_purpose IN ('management_session_exchange','site_full_control') AND issued_by_source_client_id IS ?
        AND created_at = ? AND expires_at = ? AND expires_at > ? AND exchange_generation = ?
        AND NOT EXISTS (
          SELECT 1 FROM management_auth_events WHERE event_type = 'site_full_control.exchange'
            AND json_extract(details_json, '$.sourceClientId') = ?
            AND json_extract(details_json, '$.exchangeCommandSha256') = ?
        )
        AND EXISTS (
          SELECT 1 FROM agent_client_permission_snapshots snapshot
          WHERE snapshot.client_id = agent_clients.id AND snapshot.schema_version = 3
            AND snapshot.catalog_version = ? AND snapshot.preset_id = 'site_full_control'
            AND snapshot.role = 'super_admin' AND snapshot.scopes_json = ?
            AND snapshot.action_ids_json = ? AND snapshot.article_ids_json = ?
            AND snapshot.task_ids_json = ? AND snapshot.snapshot_json = ?
            AND snapshot.snapshot_sha256 = ? AND snapshot.created_at = ?
        )`).bind(
    nowText, key.id, tokenSha256, ROOT_SCOPES_JSON, ROOT_ARTICLE_IDS_JSON, ROOT_TASK_IDS_JSON,
    key.issuedBySourceClientId, key.createdAt, key.expiresAt, nowText, key.exchangeGeneration,
    key.id, exchangeCommandSha256, key.snapshotCatalogVersion, ROOT_SCOPES_JSON, key.credentialPurpose === "site_full_control" ? V5_ROOT_ACTION_IDS_JSON : V4_ROOT_ACTION_IDS_JSON,
    ROOT_ARTICLE_IDS_JSON, ROOT_TASK_IDS_JSON, key.snapshotJson, key.snapshotSha256, key.createdAt,
  ).run();
  if (Number(cas.meta.changes ?? 0) !== 1) deny();
  const results = await input.db.batch([
    input.db.prepare("UPDATE management_sessions SET status = 'revoked', revoked_at = ?, revoke_reason = 'source_key_exchanged' WHERE auth_basis = 'site_full_control_key' AND source_client_id = ? AND status = 'active' AND EXISTS (SELECT 1 FROM agent_clients WHERE id = ? AND exchange_generation = ? AND status = 'active')").bind(nowText, key.id, key.id, generation),
    input.db.prepare("INSERT INTO management_sessions (id,principal_id,token_sha256,browser_binding_sha256,scopes_json,article_ids_json,object_boundary_json,status,absolute_expires_at,idle_expires_at,last_seen_at,created_at,auth_basis,authority_class,source_client_id,source_key_expires_at,source_exchange_generation,source_permission_snapshot_sha256) SELECT ?,?,?,?,?,?,?, 'active',?,?,?,?, 'site_full_control_key','site_management',?,?,?,? WHERE EXISTS (SELECT 1 FROM agent_clients WHERE id = ? AND exchange_generation = ? AND status = 'active')").bind(sessionId, `agent-client:${key.id}`, sessionSha256, bindingSha256, JSON.stringify(scoped), ROOT_ARTICLE_IDS_JSON, JSON.stringify(objectBoundary), absoluteExpiresAt, idleExpiresAt, nowText, nowText, key.id, expiresAt, generation, key.snapshotSha256, key.id, generation),
    input.db.prepare("INSERT INTO management_auth_events (id,event_type,principal_id,session_id,outcome,request_id,details_json,created_at) SELECT ?, 'site_full_control.exchange', ?, ?, 'accepted', ?, ?, ? WHERE EXISTS (SELECT 1 FROM management_sessions WHERE id = ? AND source_exchange_generation = ? AND source_permission_snapshot_sha256 = ? AND status = 'active')").bind(`management-auth-event-${crypto.randomUUID()}`, `agent-client:${key.id}`, sessionId, input.requestId, JSON.stringify({ sourceClientId: key.id, exchangeGeneration: generation, exchangeCommandSha256, permissionSnapshotSha256: key.snapshotSha256 }), nowText, sessionId, generation, key.snapshotSha256),
  ]);
  if (Number(results[1].meta.changes ?? 0) !== 1 || Number(results[2].meta.changes ?? 0) !== 1) deny();
  const csrfToken = await deriveCsrfToken(sessionToken, input.csrfHmacKey);
  return { sessionToken, maxAgeSeconds: seconds, principal: { sessionId, principalId: `agent-client:${key.id}`, scopes: scoped, articleIds: ["*"], objectBoundary, absoluteExpiresAt, idleExpiresAt, csrfToken, authBasis: "site_full_control_key", sourceClientId: key.id } };
}
