export const PORTABLE_AGENT_ACCESS_FILE_SCHEMA_VERSION = "wenmai.agent-access-file/1" as const;
export const AGENT_ROLE_CONNECTION_CARD_SCHEMA_VERSION = "wenmai.role-grant/1" as const;

const DAY_MS = 24 * 60 * 60 * 1000;
const LOCAL_ORIGIN = "http://[::1]:3000";
const TAILSCALE_ORIGIN_PATTERN = /^https:\/\/(?=.{1,261}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.){2}ts\.net$/;
const AGENT_CLIENT_ID_PATTERN = /^agent-client-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const AGENT_TOKEN_PATTERN = /^wenmai_agent_[a-f0-9]{32}_[a-f0-9]{32}$/;

type PortableAgentRoleProfile = Readonly<{
  label: string;
  description: string;
  serverRole: "agent" | "administrator";
  permissionPresetId: string | null;
  scopes: readonly string[];
  actionIds: readonly string[];
  maxLifetimeDays: number;
  localOnly: boolean;
}>;

export const PORTABLE_AGENT_ROLE_PROFILES = Object.freeze({
  "content-steward": Object.freeze({
    label: "文脉管家",
    description: "跨全部文章盘点内容、读取工程，并创建、更新或取消受控 Agent 任务。",
    serverRole: "administrator",
    permissionPresetId: "task_admin",
    scopes: Object.freeze([
      "task.read", "context.read", "knowledge.read", "graph.read", "package.read", "shared_source.read", "task.manage",
    ]),
    actionIds: Object.freeze(["agent.v1.cancel_task", "agent.v1.create_task", "agent.v1.update_task"]),
    maxLifetimeDays: 7,
    localOnly: false,
  }),
  "article-worker": Object.freeze({
    label: "文章工作员",
    description: "跨全部文章领取既有任务，并在任务专属 Agent 分支提交候选正文或工程 Patch。",
    serverRole: "agent",
    permissionPresetId: null,
    scopes: Object.freeze([
      "task.read", "task.claim", "task.progress", "context.read", "knowledge.read", "graph.read", "artifact.create",
      "approval.request", "graph.propose", "branch.agent_write", "package.read", "package.patch.propose",
    ]),
    actionIds: Object.freeze([]),
    maxLifetimeDays: 7,
    localOnly: false,
  }),
  "local-registrar": Object.freeze({
    label: "本机新文章建档员",
    description: "只在文脉主机回环地址登记新的根文章；不能列举或读取既有正文、不能覆盖既有文章，仅可用精确文章 ID 与正文 SHA 读回建档状态元数据。",
    serverRole: "agent",
    permissionPresetId: null,
    scopes: Object.freeze(["article.import.new_root"]),
    actionIds: Object.freeze([]),
    maxLifetimeDays: 1,
    localOnly: true,
  }),
} satisfies Record<string, PortableAgentRoleProfile>);

export type PortableAgentRoleId = keyof typeof PORTABLE_AGENT_ROLE_PROFILES;

function sameStringSet(actual: readonly string[], expected: readonly string[]) {
  if (actual.length !== expected.length || new Set(actual).size !== actual.length) return false;
  const expectedSet = new Set(expected);
  return actual.every((value) => expectedSet.has(value));
}

function objectValue(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("角色连接卡结构无效。");
  return value as Record<string, unknown>;
}

function normalizedOrigin(value: string) {
  const origin = value.replace(/\/+$/, "").toLowerCase();
  if (origin === LOCAL_ORIGIN || TAILSCALE_ORIGIN_PATTERN.test(origin)) return origin;
  throw new Error("角色钥匙只允许文脉本机回环地址或精确 Tailscale HTTPS 地址。");
}

export function roleIdForClient(input: {
  role: string;
  scopes: readonly string[];
  articleIds: readonly string[];
  taskIds: readonly string[];
  permissionPresetId?: string | null;
  actionIds?: readonly string[];
}): PortableAgentRoleId | null {
  if (!sameStringSet(input.articleIds, ["*"]) || input.taskIds.length !== 0) return null;
  for (const [roleId, profile] of Object.entries(PORTABLE_AGENT_ROLE_PROFILES) as [PortableAgentRoleId, PortableAgentRoleProfile][]) {
    if (input.role === profile.serverRole
      && (input.permissionPresetId ?? null) === profile.permissionPresetId
      && sameStringSet(input.scopes, profile.scopes)
      && sameStringSet(input.actionIds ?? [], profile.actionIds)) return roleId;
  }
  return null;
}

export function buildAgentRoleConnectionCard(input: {
  roleId: PortableAgentRoleId;
  origin: string;
  label: string;
  clientId: string;
  clientKind: string;
  serverRole: string;
  permissionPresetId?: string | null;
  scopes: readonly string[];
  actionIds?: readonly string[];
  articleIds: readonly string[];
  taskIds: readonly string[];
  expiresAt: string;
  profileName?: string;
}): Record<string, unknown> {
  const profile = PORTABLE_AGENT_ROLE_PROFILES[input.roleId];
  const origin = normalizedOrigin(input.origin);
  if (!AGENT_CLIENT_ID_PATTERN.test(input.clientId)) throw new Error("角色钥匙客户端身份无效。");
  if (input.serverRole !== profile.serverRole || (input.permissionPresetId ?? null) !== profile.permissionPresetId) {
    throw new Error("角色钥匙的服务端角色或权限预设不匹配。");
  }
  if (!sameStringSet(input.scopes, profile.scopes) || !sameStringSet(input.actionIds ?? [], profile.actionIds)) {
    throw new Error("角色钥匙的 scope 或 action 快照不匹配。");
  }
  if (!sameStringSet(input.articleIds, ["*"]) || input.taskIds.length !== 0) {
    throw new Error("角色钥匙必须绑定全部文章且不能预绑任务。");
  }
  if (profile.localOnly && origin !== LOCAL_ORIGIN) throw new Error("本机新文章建档员不能通过远程地址签发。");
  const expiresAtMs = Date.parse(input.expiresAt);
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now() || expiresAtMs > Date.now() + profile.maxLifetimeDays * DAY_MS + 60_000) {
    throw new Error(`角色钥匙有效期必须在 ${profile.maxLifetimeDays} 天以内。`);
  }
  const tailscale = origin.startsWith("https://");
  return {
    schemaVersion: AGENT_ROLE_CONNECTION_CARD_SCHEMA_VERSION,
    label: input.label,
    origin,
    client: { id: input.clientId, kind: input.clientKind, profileName: input.profileName ?? null },
    endpoints: {
      discovery: `${origin}/.well-known/wenmai-agent.json`,
      api: `${origin}/api/agent/v1`,
      health: `${origin}/api/agent/v1?view=health`,
      mcpManifest: `${origin}/agent/mcp.json`,
      localImport: input.roleId === "local-registrar" ? `${origin}/api/local-import/v1` : null,
    },
    authentication: {
      header: "Authorization: Bearer <Role Grant>",
      credentialInUrl: false,
      note: "凭据仅通过 Authorization 请求头传递。",
    },
    networkPrerequisite: {
      transport: tailscale ? "tailscale-https" : "local-loopback",
      gatewayActivationImplied: false,
      note: tailscale
        ? "钥匙文件不负责开启网络；所有者仍须单独启用并验证文脉 Tailscale Agent 网关。"
        : "目标 Agent 必须能访问当前电脑上的文脉回环服务。",
    },
    grant: {
      roleId: input.roleId,
      serverRole: profile.serverRole,
      permissionPresetId: profile.permissionPresetId,
      articleScope: { mode: "all_articles", articleIds: ["*"], includesFutureArticles: true },
      taskIds: [],
      expiresAt: new Date(expiresAtMs).toISOString(),
    },
    allowedOperations: { scopes: [...profile.scopes].sort(), actionIds: [...profile.actionIds].sort() },
    ownerOnlyBoundary: {
      enforced: true,
      forbiddenCapabilities: [
        "token.issue", "token.revoke", "identity", "approval.decide", "merge.apply", "release.approve", "publish", "send", "delete", "secret",
      ],
      note: "角色钥匙不能签发或撤销 Key，不能登录、审批、合并、公开发布、发送、删除或读取秘密。",
    },
  };
}

export function buildPortableAgentRoleAccessFile(input: {
  connectionCard: Record<string, unknown>;
  token: string;
  exportedAt: string;
}): Record<string, unknown> {
  if (input.connectionCard.schemaVersion !== AGENT_ROLE_CONNECTION_CARD_SCHEMA_VERSION) {
    throw new Error("连接卡版本不支持角色钥匙导出。");
  }
  if (!AGENT_TOKEN_PATTERN.test(input.token)) throw new Error("一次性 Agent Key 格式无效。");
  const exportedAtMs = Date.parse(input.exportedAt);
  if (!Number.isFinite(exportedAtMs)) throw new Error("角色钥匙导出时间无效。");
  const client = objectValue(input.connectionCard.client);
  const authentication = objectValue(input.connectionCard.authentication);
  const network = objectValue(input.connectionCard.networkPrerequisite);
  const grant = objectValue(input.connectionCard.grant);
  const clientId = typeof client.id === "string" ? client.id : "";
  if (!AGENT_CLIENT_ID_PATTERN.test(clientId)) throw new Error("角色钥匙客户端身份无效。");
  if (authentication.credentialInUrl !== false || network.gatewayActivationImplied !== false) {
    throw new Error("角色钥匙秘密或网关边界无效。");
  }
  const expiresAtMs = typeof grant.expiresAt === "string" ? Date.parse(grant.expiresAt) : Number.NaN;
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= exportedAtMs) throw new Error("角色钥匙到期时间无效。");
  return {
    schemaVersion: PORTABLE_AGENT_ACCESS_FILE_SCHEMA_VERSION,
    kind: "portable-role-grant",
    secret: true,
    possessionIsAuthority: true,
    exportedAt: new Date(exportedAtMs).toISOString(),
    connectionCard: input.connectionCard,
    credential: { type: "bearer", header: "Authorization", scheme: "Bearer", token: input.token },
    handling: {
      recommendedUnixMode: "0600",
      serverStateAuthoritative: true,
      gatewayActivationImplied: false,
      revokeByClientId: clientId,
      note: "此文件本身就是权限。获得副本者在到期或撤销前拥有同等角色权限；不要放进仓库、同步盘、聊天或日志，丢失后立即按 clientId 撤销。",
    },
  };
}
