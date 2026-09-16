import { ManagementAuthError } from "./management-auth-core";
import {
  AGENT_ROLE_CONTRACTS,
  administratorProfileVersion,
  isAgentPrivilegeRole,
  superAdminProfileVersion,
  type AgentPrivilegeRole,
} from "./agent-role-contract";
import {
  managementActorId,
  requireManagementSession,
  type ManagementPrincipal,
  type ManagementScope,
} from "./management-auth";
import { assertLocalImportTransport } from "./local-import-auth-core";
import { assertActiveAgentClientLineage, verifyDirectSiteFullControlKey } from "./site-full-control-auth";

type D1Row = Record<string, string | number | null>;

export type PrivilegedAgentRole = AgentPrivilegeRole;

export type PrivilegedAgentPrincipal = {
  kind: "agent";
  actorId: string;
  clientId: string;
  role: PrivilegedAgentRole;
  scopes: string[];
  articleIds: string[];
  taskIds: string[];
  sourceExpiresAt?: string;
  authorityLineageId?: string;
  profileVersion: "permission_snapshot_v3" | "site_full_control_v5" | "administrator_v1" | "administrator_v2" | "super_admin_internal_v1" | "super_admin_internal_v2" | "super_admin_internal_v3";
  permissionProfile?: { schemaVersion: 3 | 4 | 5; catalogVersion: string; catalogSha256?: string; presetId: string; actionIds: string[]; snapshotSha256: string; directAgentApi?: true; managementProjectionVersion?: string; managementScopes?: string[]; managementProjectionSha256?: string };
};

export type ManagementControlPrincipal = {
  kind: "management";
  actorId: string;
  clientId: null;
  role: "owner";
  scopes: string[];
  articleIds: string[];
  taskIds: string[];
  management: ManagementPrincipal;
};

export type ControlPrincipal = ManagementControlPrincipal | PrivilegedAgentPrincipal;

export type PrivilegedAgentOptions = {
  articleId?: string;
  localOnly?: boolean;
  allowedRoles?: readonly PrivilegedAgentRole[];
  agentActionId?: string;
  /** Direct root credentials are accepted only at an explicit management call site. */
  managementScope?: ManagementScope;
};

export type ManagementOrPrivilegedAgentOptions = PrivilegedAgentOptions & {
  managementScope: ManagementScope;
  agentScope: string;
};

const AGENT_KEY_PATTERN = /^wenmai_agent_[a-f0-9]{32}_[a-f0-9]{32}$/u;
function parseStringArray(value: unknown, field: string) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(value ?? "[]"));
  } catch {
    throw new ManagementAuthError("PRIVILEGED_PROFILE_INVALID", `高权限 Agent 的 ${field} 不是有效 JSON`, 403);
  }
  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) {
    throw new ManagementAuthError("PRIVILEGED_PROFILE_INVALID", `高权限 Agent 的 ${field} 必须是字符串数组`, 403);
  }
  const values = parsed as string[];
  if (values.some((item) => !item || item.trim() !== item) || new Set(values).size !== values.length) {
    throw new ManagementAuthError("PRIVILEGED_PROFILE_INVALID", `高权限 Agent 的 ${field} 包含空值、空白或重复项`, 403);
  }
  return values;
}

function bearerToken(request: Request) {
  const authorization = request.headers.get("authorization") ?? "";
  if (!authorization.startsWith("Bearer ")) {
    throw new ManagementAuthError("PRIVILEGED_AUTH_REQUIRED", "高权限 Agent 请求缺少 Bearer Key", 401);
  }
  const token = authorization.slice(7).trim();
  if (!AGENT_KEY_PATTERN.test(token)) {
    throw new ManagementAuthError("PRIVILEGED_AUTH_INVALID", "高权限 Agent Key 无效", 401);
  }
  return token;
}

function assertMachineCredentialBoundary(request: Request) {
  if (request.headers.has("cookie")) {
    throw new ManagementAuthError("AMBIGUOUS_AUTH_FORBIDDEN", "高权限 Agent 请求不能同时携带浏览器 Cookie", 403);
  }
  if (request.headers.has("origin") || request.headers.has("referer")) {
    throw new ManagementAuthError("BROWSER_REQUEST_FORBIDDEN", "高权限 Agent Key 不能从浏览器页面调用", 403);
  }
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite && fetchSite !== "none") {
    throw new ManagementAuthError("BROWSER_REQUEST_FORBIDDEN", "高权限 Agent Key 只接受机器客户端请求", 403);
  }
}

async function sha256Text(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") { const item = value as Record<string, unknown>; return `{${Object.keys(item).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(item[key])}`).join(",")}}`; }
  return JSON.stringify(value);
}

function exactRole(value: unknown): PrivilegedAgentRole {
  if (!isAgentPrivilegeRole(value)) {
    throw new ManagementAuthError("PRIVILEGED_ROLE_DENIED", "Agent Key 不是管理员或超级管理员角色", 403);
  }
  return value;
}

function exactStringSet(actual: readonly string[], expected: readonly string[]) {
  if (actual.length !== expected.length || new Set(actual).size !== actual.length) return false;
  const actualSet = new Set(actual);
  return expected.every((value) => actualSet.has(value));
}

function assertExactRoleContract(
  role: PrivilegedAgentRole,
  scopes: string[],
  articleIds: string[],
  taskIds: string[],
  createdAt: unknown,
  expiresAt: unknown,
  nowMs: number,
  articleId?: string,
) {
  const contract = AGENT_ROLE_CONTRACTS[role];
  const validScopes = role === "super_admin"
    ? superAdminProfileVersion(scopes) !== null
    : administratorProfileVersion(scopes) !== null;
  if (!validScopes) {
    throw new ManagementAuthError(
      "PRIVILEGED_PROFILE_INVALID",
      `高权限 Agent 的 scopes 必须精确等于 ${role} 角色合同`,
      403,
    );
  }
  if (!exactStringSet(articleIds, contract.articleIds) || !exactStringSet(taskIds, contract.taskIds)) {
    throw new ManagementAuthError(
      "PRIVILEGED_OBJECT_BOUNDARY_INVALID",
      `高权限 Agent 的对象边界必须精确等于 ${role} 角色合同`,
      403,
    );
  }
  const createdTime = Date.parse(String(createdAt ?? ""));
  const expiryTime = Date.parse(String(expiresAt ?? ""));
  if (
    !Number.isFinite(createdTime)
    || !Number.isFinite(expiryTime)
    || createdTime > nowMs
    || expiryTime <= createdTime
    || expiryTime - createdTime > contract.maxLifetimeMs
  ) {
    throw new ManagementAuthError(
      "PRIVILEGED_TTL_INVALID",
      `高权限 Agent Key 不符合 ${role} 角色的有效期合同`,
      403,
    );
  }
  if (articleId && !articleIds.includes("*") && !articleIds.includes(articleId)) {
    throw new ManagementAuthError("PRIVILEGED_OBJECT_DENIED", "高权限 Agent Key 不包含当前文章对象", 403);
  }
}

function assertPrivilegedTransport(request: Request, role: PrivilegedAgentRole, localOnly: boolean) {
  const transport = request.headers.get("x-wenmai-agent-transport");
  if (transport !== null && transport !== "tailscale-gateway") {
    throw new ManagementAuthError("PRIVILEGED_TRANSPORT_REQUIRED", "高权限 Agent 请求使用了未授权的传输通道", 421);
  }
  if (transport === "tailscale-gateway" && (role === "super_admin" || localOnly)) {
    throw new ManagementAuthError(
      "PRIVILEGED_TRANSPORT_REQUIRED",
      "超级管理员 Key 只能由文脉主机的精确 IPv6 回环通道使用",
      421,
    );
  }
  try {
    assertLocalImportTransport(request);
  } catch (error) {
    if (error instanceof ManagementAuthError) throw error;
    const candidate = error as { code?: string; message?: string; status?: number; details?: Record<string, unknown> };
    throw new ManagementAuthError(
      candidate.code || "PRIVILEGED_TRANSPORT_REQUIRED",
      candidate.message || "高权限 Agent 请求必须经由文脉本机通道",
      candidate.status || 421,
      candidate.details,
    );
  }
}

export async function authenticatePrivilegedAgent(
  request: Request,
  db: D1Database,
  requiredScope: string,
  options: PrivilegedAgentOptions = {},
): Promise<PrivilegedAgentPrincipal> {
  assertMachineCredentialBoundary(request);
  const token = bearerToken(request);
  const tokenSha256 = await sha256Text(token);
  const row = await db.prepare("SELECT * FROM agent_clients WHERE token_sha256 = ? LIMIT 1")
    .bind(tokenSha256)
    .first<D1Row>();
  if (!row || row.status !== "active") {
    throw new ManagementAuthError("PRIVILEGED_AUTH_INVALID", "高权限 Agent Key 无效或已经撤销", 401);
  }
  if (row.credential_purpose === "site_full_control") {
    if (!options.managementScope) {
      throw new ManagementAuthError("SITE_FULL_CONTROL_DIRECT_SCOPE_REQUIRED", "网站根完整控制 Key 只能在明确管理 scope 的调用点使用", 403);
    }
    const root = await verifyDirectSiteFullControlKey({ request, db });
    if (!root.managementScopes.includes(options.managementScope)) {
      throw new ManagementAuthError("MANAGEMENT_SCOPE_DENIED", `网站根 Key 缺少 ${options.managementScope} 管理权限`, 403);
    }
    return {
      kind: "agent",
      actorId: `agent-client:${root.id}`,
      clientId: root.id,
      role: "super_admin",
      scopes: ["site.full_control"],
      articleIds: ["*"],
      taskIds: [],
      sourceExpiresAt: root.expiresAt,
      authorityLineageId: root.authorityLineageId,
      profileVersion: "site_full_control_v5",
      permissionProfile: {
        schemaVersion: 5,
        catalogVersion: root.snapshotCatalogVersion,
        catalogSha256: root.snapshotCatalogSha256,
        presetId: "site_full_control",
        actionIds: ["auth.site_full_control.direct", "auth.site_full_control.exchange"],
        snapshotSha256: root.snapshotSha256,
        directAgentApi: true,
        managementProjectionVersion: root.managementProjectionVersion,
        managementScopes: [...root.managementScopes],
        managementProjectionSha256: root.managementProjectionSha256,
      },
    };
  }
  if (row.credential_purpose === "management_session_exchange") {
    throw new ManagementAuthError("SITE_FULL_CONTROL_EXCHANGE_REQUIRED", "这是旧 v4 网站根 Key，只能兑换管理会话；请换发 v5 Agent 站内全权（本机）Key。", 401);
  }
  const nowMs = Date.now();
  const expiresAt = String(row.expires_at ?? "");
  const expiryTime = Date.parse(expiresAt);
  if (!Number.isFinite(expiryTime) || expiryTime <= nowMs) {
    throw new ManagementAuthError("PRIVILEGED_AUTH_EXPIRED", "高权限 Agent Key 已过期", 401);
  }

  const role = exactRole(row.role);
  const scopes = parseStringArray(row.scopes_json, "scopes");
  const articleIds = parseStringArray(row.article_ids_json, "articleIds");
  const taskIds = parseStringArray(row.task_ids_json, "taskIds");
  const allowedRoles = options.allowedRoles ?? ["administrator", "super_admin"];
  if (!allowedRoles.includes(role)) {
    throw new ManagementAuthError("PRIVILEGED_ROLE_DENIED", "当前高权限 Agent 角色不能执行这个动作", 403);
  }
  let snapshot: D1Row | null = null;
  try {
    snapshot = await db.prepare("SELECT * FROM agent_client_permission_snapshots WHERE client_id = ? LIMIT 1").bind(row.id).first<D1Row>();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/no such table:\s*agent_client_permission_snapshots/i.test(message)) throw error;
    // Some pre-v3 local databases have legacy clients but no snapshot table.
    // Treat only this precise schema-absence error as the historical path.
  }
  let permissionProfile: PrivilegedAgentPrincipal["permissionProfile"];
  if (snapshot) {
    const snapshotScopes = parseStringArray(snapshot.scopes_json, "snapshot scopes");
    const snapshotArticles = parseStringArray(snapshot.article_ids_json, "snapshot articleIds");
    const snapshotTasks = parseStringArray(snapshot.task_ids_json, "snapshot taskIds");
    const actionIds = parseStringArray(snapshot.action_ids_json, "snapshot actionIds");
    let snapshotDocument: unknown;
    try { snapshotDocument = JSON.parse(String(snapshot.snapshot_json)); } catch { throw new ManagementAuthError("PRIVILEGED_SNAPSHOT_INVALID", "v3 Agent 权限快照不是有效 JSON", 403); }
    const catalogSha256 = typeof (snapshotDocument as Record<string, unknown> | null)?.catalogSha256 === "string" ? String((snapshotDocument as Record<string, unknown>).catalogSha256) : null;
    const snapshotBoundary = (snapshotDocument as Record<string, unknown> | null)?.objectBoundary;
    const isV2Boundary = Boolean(snapshotBoundary && typeof snapshotBoundary === "object" && !Array.isArray(snapshotBoundary)
      && (snapshotBoundary as Record<string, unknown>).schemaVersion === "wenmai.agent-object-boundary/articles-v2");
    const boundary = isV2Boundary ? snapshotBoundary as Record<string, unknown> : { schemaVersion: "wenmai.agent-object-boundary/article-set-v1", articleIds: snapshotArticles, wildcard: false };
    const profile = { schemaVersion: 3, catalogVersion: String(snapshot.catalog_version), ...(catalogSha256 ? { catalogSha256 } : {}), presetId: String(snapshot.preset_id), role, scopes: snapshotScopes, actionIds, objectBoundary: boundary, taskIds: snapshotTasks, issuedAt: String(row.created_at), expiresAt };
    const credentialPurpose = row.credential_purpose === "management_session_exchange" ? "management_session_exchange" : "agent_api";
    const issuedBySourceClientId = row.issued_by_source_client_id ? String(row.issued_by_source_client_id) : null;
    const currentProfile = {
      schemaVersion: 3,
      catalogVersion: profile.catalogVersion,
      ...(catalogSha256 ? { catalogSha256 } : {}),
      presetId: profile.presetId,
      role,
      scopes: snapshotScopes,
      actionIds,
      credentialPurpose,
      issuedBySourceClientId,
      objectBoundary: boundary,
      taskIds: snapshotTasks,
      issuedAt: String(row.created_at),
      expiresAt,
    };
    // v3.0 snapshots predate the explicit object-boundary/timestamp fields.
    // Keep their signed, canonical payload valid; never enrich it from a later
    // catalog or infer action IDs that were not originally signed.
    const legacyV3Profile = { schemaVersion: 3, catalogVersion: profile.catalogVersion, presetId: profile.presetId, role, scopes: snapshotScopes, actionIds, articleIds: snapshotArticles, taskIds: snapshotTasks };
    const snapshotCanonical = String(snapshot.snapshot_json);
    const signedProfile = snapshotCanonical === canonicalJson(currentProfile)
      ? currentProfile
      : snapshotCanonical === canonicalJson(profile)
        ? profile
        : snapshotCanonical === canonicalJson(legacyV3Profile)
          ? legacyV3Profile
          : null;
    if (Number(snapshot.schema_version) !== 3
      || String(row.scopes_json) !== canonicalJson(snapshotScopes) || String(row.article_ids_json) !== canonicalJson(snapshotArticles) || String(row.task_ids_json) !== canonicalJson(snapshotTasks)
      || String(snapshot.scopes_json) !== canonicalJson(snapshotScopes) || String(snapshot.action_ids_json) !== canonicalJson(actionIds)
      || String(snapshot.article_ids_json) !== canonicalJson(snapshotArticles) || String(snapshot.task_ids_json) !== canonicalJson(snapshotTasks)
      || snapshotScopes.some((value, index) => value !== [...snapshotScopes].sort()[index]) || actionIds.some((value, index) => value !== [...actionIds].sort()[index]) || snapshotArticles.some((value, index) => value !== [...snapshotArticles].sort()[index])
      || !snapshotArticles.length || snapshotTasks.length !== 0
      || !exactStringSet(scopes, snapshotScopes) || !exactStringSet(articleIds, snapshotArticles) || !exactStringSet(taskIds, snapshotTasks)
      || String(snapshot.role) !== role || String(snapshot.catalog_version) !== profile.catalogVersion || String(snapshot.preset_id) !== profile.presetId
      || (catalogSha256 !== null && !/^[a-f0-9]{64}$/u.test(catalogSha256))
      || !signedProfile || snapshotCanonical !== canonicalJson(snapshotDocument) || await sha256Text(canonicalJson(signedProfile)) !== String(snapshot.snapshot_sha256)) {
      throw new ManagementAuthError("PRIVILEGED_SNAPSHOT_INVALID", "v3 Agent 权限快照已篡改、过期或与客户端不一致", 403);
    }
    if (isV2Boundary) {
      const mode = boundary.mode;
      const boundaryIds = boundary.articleIds;
      if ((mode !== "all_articles" && mode !== "selected_articles") || !Array.isArray(boundaryIds) || !boundaryIds.every((item) => typeof item === "string")
        || typeof boundary.includesFutureArticles !== "boolean" || boundary.includesFutureArticles !== (mode === "all_articles")
        || (mode === "all_articles" && (boundaryIds.length !== 1 || boundaryIds[0] !== "*" || canonicalJson(boundaryIds) !== canonicalJson(snapshotArticles)))
        || (mode === "selected_articles" && (boundaryIds.length < 1 || boundaryIds.length > 200 || boundaryIds.includes("*") || canonicalJson(boundaryIds) !== canonicalJson(snapshotArticles)))) {
        throw new ManagementAuthError("PRIVILEGED_SNAPSHOT_INVALID", "v3 Agent 文章边界无效", 403);
      }
    } else if (snapshotArticles.includes("*")) {
      throw new ManagementAuthError("PRIVILEGED_SNAPSHOT_INVALID", "旧 v3 specific 快照不能使用通配文章边界", 403);
    }
    if (options.agentActionId && !actionIds.includes(options.agentActionId)) throw new ManagementAuthError("PRIVILEGED_ACTION_DENIED", "v3 Agent Key 未获签发当前动作", 403);
    if (options.articleId && !articleIds.includes("*") && !articleIds.includes(options.articleId)) throw new ManagementAuthError("PRIVILEGED_OBJECT_DENIED", "v3 Agent Key 不包含当前文章对象", 403);
    permissionProfile = { schemaVersion: 3, catalogVersion: profile.catalogVersion, ...(catalogSha256 ? { catalogSha256 } : {}), presetId: profile.presetId, actionIds, snapshotSha256: String(snapshot.snapshot_sha256) };
  } else {
    // No snapshot means a frozen historical profile only; never reinterpret it through a later catalog.
    assertExactRoleContract(role, scopes, articleIds, taskIds, row.created_at, expiresAt, nowMs, options.articleId);
  }
  if (!scopes.includes(requiredScope)) {
    throw new ManagementAuthError("PRIVILEGED_SCOPE_DENIED", `高权限 Agent Key 缺少 ${requiredScope} 权限`, 403);
  }
  assertPrivilegedTransport(request, role, options.localOnly === true);
  const authorityLineageId = await assertActiveAgentClientLineage(db, String(row.id), nowMs);

  const now = new Date().toISOString();
  const refreshed = await db.prepare(`UPDATE agent_clients SET last_seen_at = ?
    WHERE id = ? AND status = 'active' AND expires_at > ?`)
    .bind(now, row.id, now)
    .run();
  if (Number(refreshed.meta.changes ?? 0) !== 1) {
    throw new ManagementAuthError("PRIVILEGED_AUTH_INVALID", "高权限 Agent Key 在认证期间失效", 401);
  }

  const clientId = String(row.id);
  return {
    kind: "agent",
    actorId: `agent-client:${clientId}`,
    clientId,
    role,
    scopes,
    articleIds,
    taskIds,
    authorityLineageId,
    profileVersion: permissionProfile
      ? "permission_snapshot_v3"
      : role === "super_admin"
        ? superAdminProfileVersion(scopes)!
        : administratorProfileVersion(scopes)!,
    permissionProfile,
  };
}

export async function requireManagementOrPrivilegedAgent(
  request: Request,
  db: D1Database,
  options: ManagementOrPrivilegedAgentOptions,
): Promise<ControlPrincipal> {
  if (request.headers.has("authorization")) {
    return authenticatePrivilegedAgent(request, db, options.agentScope, options);
  }
  const management = await requireManagementSession(request, {
    mutation: true,
    scope: options.managementScope,
    articleId: options.articleId,
  });
  return {
    kind: "management",
    actorId: managementActorId(management),
    clientId: null,
    role: "owner",
    scopes: [...management.scopes],
    articleIds: [...management.articleIds],
    taskIds: [],
    management,
  };
}
