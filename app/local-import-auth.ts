import { env } from "cloudflare:workers";
import {
  LOCAL_IMPORT_CANONICAL_ORIGIN,
  LocalImportAuthError,
  assertLocalImportTransport,
  authenticateLocalImportRequest,
  type LocalImportRuntime,
} from "./local-import-auth-core";
import { sha256Text } from "./management-auth-core";

type LocalImportBindings = {
  DB?: D1Database;
  WENMAI_LOCAL_IMPORT_CANONICAL_ORIGIN?: string;
  WENMAI_LOCAL_IMPORT_BOOT_ID?: string;
  WENMAI_LOCAL_IMPORT_TOKEN_SHA256?: string;
};

function runtimeBindings(): LocalImportRuntime {
  const workerBindings = env as unknown as LocalImportBindings;
  const processBindings = typeof process === "undefined" ? {} : process.env;
  const read = (name: keyof LocalImportBindings) => {
    const workerValue = workerBindings[name];
    if (typeof workerValue === "string" && workerValue) return workerValue;
    const processValue = processBindings[String(name)];
    return typeof processValue === "string" ? processValue : "";
  };
  return {
    canonicalOrigin: read("WENMAI_LOCAL_IMPORT_CANONICAL_ORIGIN") || LOCAL_IMPORT_CANONICAL_ORIGIN,
    bootId: read("WENMAI_LOCAL_IMPORT_BOOT_ID"),
    tokenSha256: read("WENMAI_LOCAL_IMPORT_TOKEN_SHA256").toLowerCase(),
  };
}

type LocalImportPrincipal = {
  actorId: string;
  authKind: "boot-operator" | "agent-key";
  bootId: string | null;
};

const AGENT_KEY_PATTERN = /^wenmai_agent_[a-f0-9]{32}_[a-f0-9]{32}$/u;
const LOCAL_IMPORT_AGENT_SCOPE = "article.import.new_root";

function parseStringArray(value: unknown) {
  try {
    const parsed = JSON.parse(String(value ?? "[]"));
    return Array.isArray(parsed) && parsed.every((item) => typeof item === "string") ? parsed : [];
  } catch {
    return [];
  }
}

async function authenticatePersistentAgentKey(request: Request, token: string): Promise<LocalImportPrincipal> {
  assertLocalImportTransport(request, LOCAL_IMPORT_CANONICAL_ORIGIN);
  if (!AGENT_KEY_PATTERN.test(token)) {
    throw new LocalImportAuthError("LOCAL_IMPORT_AUTH_INVALID", "本机操作员 Key 无效", 401);
  }
  const bindings = env as unknown as LocalImportBindings;
  if (!bindings.DB) {
    throw new LocalImportAuthError("LOCAL_IMPORT_STORAGE_UNAVAILABLE", "本机操作员 Key 存储尚未连接", 503);
  }
  const tokenSha256 = await sha256Text(token);
  const row = await bindings.DB.prepare("SELECT * FROM agent_clients WHERE token_sha256 = ? LIMIT 1")
    .bind(tokenSha256).first<Record<string, string | number | null>>();
  if (!row || row.status !== "active") {
    throw new LocalImportAuthError("LOCAL_IMPORT_AUTH_INVALID", "本机操作员 Key 无效或已撤销", 401);
  }
  const expiryTime = Date.parse(String(row.expires_at));
  if (!Number.isFinite(expiryTime) || expiryTime <= Date.now()) {
    throw new LocalImportAuthError("LOCAL_IMPORT_AUTH_EXPIRED", "本机操作员 Key 已过期", 401);
  }
  const scopes = parseStringArray(row.scopes_json);
  if (scopes.length !== 1 || scopes[0] !== LOCAL_IMPORT_AGENT_SCOPE) {
    throw new LocalImportAuthError("LOCAL_IMPORT_SCOPE_DENIED", `本机操作员 Key 必须只包含 ${LOCAL_IMPORT_AGENT_SCOPE} 权限`, 403);
  }
  const articleIds = parseStringArray(row.article_ids_json);
  if (articleIds.length !== 1 || articleIds[0] !== "*") {
    throw new LocalImportAuthError("LOCAL_IMPORT_OBJECT_SCOPE_DENIED", "新建根文章需要显式全库对象边界", 403);
  }
  if (parseStringArray(row.task_ids_json).length !== 0) {
    throw new LocalImportAuthError("LOCAL_IMPORT_TASK_SCOPE_DENIED", "本机操作员 Key 不能绑定 Agent 任务", 403);
  }
  const actorId = String(row.id);
  const authenticatedAt = new Date().toISOString();
  const refreshed = await bindings.DB.prepare("UPDATE agent_clients SET last_seen_at = ? WHERE id = ? AND status = 'active' AND expires_at > ?")
    .bind(authenticatedAt, actorId, authenticatedAt).run();
  if (Number(refreshed.meta.changes ?? 0) !== 1) {
    throw new LocalImportAuthError("LOCAL_IMPORT_AUTH_INVALID", "本机操作员 Key 在认证期间失效", 401);
  }
  return { actorId, authKind: "agent-key", bootId: null };
}

export async function requireLocalImportOperator(request: Request): Promise<LocalImportPrincipal> {
  const authorization = request.headers.get("authorization") ?? "";
  const token = authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
  if (token.startsWith("wenmai_agent_")) {
    return authenticatePersistentAgentKey(request, token);
  }
  const operator = await authenticateLocalImportRequest(request, runtimeBindings());
  return { actorId: "local-import-operator", authKind: "boot-operator", bootId: operator.bootId };
}
