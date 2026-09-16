export const COLLABORATION_ACCESS_SCHEMA_VERSION = "wenmai.share-grant/1";
export const PORTABLE_COLLABORATION_ACCESS_FILE_SCHEMA_VERSION = "wenmai.agent-access-file/1";
export const COLLABORATION_ACCESS_MAX_LIFETIME_DAYS = 30;

export type CollaborationAccessMode = "viewer" | "editor";

type CollaborationAccessProfile = {
  scopes: readonly string[];
  requiresTask: boolean;
  label: string;
  description: string;
};

export const COLLABORATION_ACCESS_PROFILES: Record<CollaborationAccessMode, CollaborationAccessProfile> = {
  viewer: {
    scopes: ["article.read"],
    requiresTask: false,
    label: "文章只读协作",
    description: "仅可查看被授权的一篇文章，不可领取任务或写入内容。",
  },
  editor: {
    scopes: [
      "article.read",
      "task.read",
      "task.claim",
      "task.progress",
      "context.read",
      "artifact.create",
      "approval.request",
      "branch.agent_write",
    ],
    requiresTask: true,
    label: "文章任务协作",
    description: "仅可在被授权文章的一项任务内读取上下文、推进任务并提交候选工件。",
  },
};

const DAY_MS = 24 * 60 * 60 * 1000;

function sameScopeSet(actual: readonly string[], expected: readonly string[]) {
  if (actual.length !== expected.length || new Set(actual).size !== actual.length) return false;
  const expectedSet = new Set(expected);
  return actual.every((scope) => expectedSet.has(scope));
}

function isConcreteId(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 && value !== "*";
}

function invalid(code: string, message: string) {
  return { valid: false, code, message };
}

export function collaborationAccessModeForScopes(scopes: readonly string[]): CollaborationAccessMode | null {
  for (const mode of ["viewer", "editor"] as const) {
    if (sameScopeSet(scopes, COLLABORATION_ACCESS_PROFILES[mode].scopes)) return mode;
  }
  return null;
}

export function validateCollaborationGrantShape(input: {
  mode: CollaborationAccessMode;
  articleIds: readonly string[];
  taskIds: readonly string[];
  expiresAtMs: number;
  nowMs?: number;
}): { valid: boolean; code: string | null; message: string | null } {
  if (input.articleIds.length !== 1 || !isConcreteId(input.articleIds[0])) {
    return invalid("ARTICLE_SCOPE_INVALID", "Share Grant 必须且只能绑定一个非空的具体文章 ID。");
  }
  if (input.mode === "viewer") {
    if (input.taskIds.length !== 0) return invalid("VIEWER_TASK_FORBIDDEN", "只读 Share Grant 不得绑定任务。");
  } else if (input.mode === "editor") {
    if (input.taskIds.length !== 1 || !isConcreteId(input.taskIds[0])) {
      return invalid("EDITOR_TASK_REQUIRED", "编辑 Share Grant 必须且只能绑定一个非空的具体任务 ID。");
    }
  } else {
    return invalid("MODE_INVALID", "Share Grant 模式必须为 viewer 或 editor。");
  }

  const nowMs = input.nowMs ?? Date.now();
  if (!Number.isFinite(input.expiresAtMs) || input.expiresAtMs <= nowMs) {
    return invalid("EXPIRY_NOT_FUTURE", "Share Grant 到期时间必须在当前时间之后。");
  }
  if (input.expiresAtMs > nowMs + COLLABORATION_ACCESS_MAX_LIFETIME_DAYS * DAY_MS) {
    return invalid("EXPIRY_TOO_LONG", "Share Grant 最长有效期为 30 天。");
  }
  return { valid: true, code: null, message: null };
}

export function buildCollaborationAccessCard(input: {
  origin: string;
  label: string;
  clientId: string;
  clientKind: string;
  mode: CollaborationAccessMode;
  article: { id: string; label?: string };
  taskId?: string | null;
  expiresAt: string;
  profileName?: string;
}): Record<string, unknown> {
  const origin = input.origin.replace(/\/+$/, "");
  const tailscaleTransport = /^https:\/\/[^/]+\.ts\.net$/i.test(origin);
  const articleId = encodeURIComponent(input.article.id);
  const apiPath = "/api/agent/v1";
  const discoveryPath = "/.well-known/wenmai-agent.json";
  const articleListPath = `${apiPath}?view=articles`;
  const articleDetailPath = `${apiPath}?view=article&articleId=${articleId}`;
  const profile = COLLABORATION_ACCESS_PROFILES[input.mode];

  return {
    schemaVersion: COLLABORATION_ACCESS_SCHEMA_VERSION,
    label: input.label,
    origin,
    client: { id: input.clientId, kind: input.clientKind, profileName: input.profileName ?? null },
    endpoints: {
      discovery: `${origin}${discoveryPath}`,
      api: `${origin}${apiPath}`,
      health: `${origin}${apiPath}?view=health`,
      articleList: `${origin}${articleListPath}`,
      articleDetail: `${origin}${articleDetailPath}`,
    },
    authentication: {
      header: "Authorization: Bearer <Share Grant>",
      credentialInUrl: false,
      note: "凭据仅通过 Authorization 请求头传递。",
    },
    networkPrerequisite: {
      transport: tailscaleTransport ? "tailscale-https" : "local-loopback",
      gatewayActivationImplied: false,
      note: tailscaleTransport
        ? "连接卡只描述地址；所有者仍须单独启用并验证文脉 Tailscale Agent 网关。"
        : "连接卡只描述本机回环地址；目标 Agent 必须能访问这台机器上的文脉服务。",
    },
    grant: {
      mode: input.mode,
      resource: { type: "article", id: input.article.id, label: input.article.label ?? null, revisionPolicy: "authoritative-current" },
      taskId: input.taskId ?? null,
      expiresAt: input.expiresAt,
    },
    allowedOperations: {
      scopes: [...profile.scopes],
      requiresTask: profile.requiresTask,
    },
    ownerOnlyBoundary: {
      enforced: true,
      forbiddenCapabilities: [
        "token", "runner", "identity", "approval.decide", "merge", "release", "publish", "send", "delete", "account", "secret",
      ],
      note: "Share Grant 不授予令牌签发、执行器、身份、审批决定、合并、发布、发送、删除、账号或秘密访问能力。",
    },
  };
}

function objectValue(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("连接卡结构无效。");
  return value as Record<string, unknown>;
}

export function buildPortableCollaborationAccessFile(input: {
  connectionCard: Record<string, unknown>;
  token: string;
  exportedAt: string;
}): Record<string, unknown> {
  if (input.connectionCard.schemaVersion !== COLLABORATION_ACCESS_SCHEMA_VERSION) {
    throw new Error("连接卡版本不支持便携文件导出。");
  }
  if (!/^wenmai_agent_[a-f0-9]{32}_[a-f0-9]{32}$/.test(input.token)) {
    throw new Error("一次性 Agent Key 格式无效。");
  }
  const exportedAtMs = Date.parse(input.exportedAt);
  if (!Number.isFinite(exportedAtMs)) throw new Error("便携文件导出时间无效。");

  const client = objectValue(input.connectionCard.client);
  const authentication = objectValue(input.connectionCard.authentication);
  const networkPrerequisite = objectValue(input.connectionCard.networkPrerequisite);
  const grant = objectValue(input.connectionCard.grant);
  const clientId = typeof client.id === "string" ? client.id : "";
  if (!/^agent-client-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(clientId)) {
    throw new Error("连接卡客户端身份无效。");
  }
  if (authentication.credentialInUrl !== false || networkPrerequisite.gatewayActivationImplied !== false) {
    throw new Error("连接卡秘密或网关边界无效。");
  }
  const expiresAt = typeof grant.expiresAt === "string" ? grant.expiresAt : "";
  const expiresAtMs = Date.parse(expiresAt);
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= exportedAtMs) {
    throw new Error("连接卡到期时间无效。");
  }

  return {
    schemaVersion: PORTABLE_COLLABORATION_ACCESS_FILE_SCHEMA_VERSION,
    kind: "portable-share-grant",
    secret: true,
    possessionIsAuthority: true,
    exportedAt: new Date(exportedAtMs).toISOString(),
    connectionCard: input.connectionCard,
    credential: {
      type: "bearer",
      header: "Authorization",
      scheme: "Bearer",
      token: input.token,
    },
    handling: {
      recommendedUnixMode: "0600",
      serverStateAuthoritative: true,
      gatewayActivationImplied: false,
      revokeByClientId: clientId,
      note: "此文件本身就是凭据。获得副本者在到期或撤销前拥有同等权限；请像 SSH 私钥一样保管，丢失后立即按 clientId 撤销。",
    },
  };
}
