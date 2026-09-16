import {
  MANAGEMENT_CANONICAL_ORIGIN,
  assertCanonicalManagementTransport,
  constantTimeTextEqual,
  sha256Text,
} from "./management-auth-core.ts";

export const LOCAL_IMPORT_CANONICAL_ORIGIN = MANAGEMENT_CANONICAL_ORIGIN;
export const LOCAL_IMPORT_BOOT_HEADER = "x-wenmai-local-import-boot";

const BOOT_ID_PATTERN = /^local-import-boot-[A-Za-z0-9_-]{22}$/u;
const TOKEN_PATTERN = /^wenmai_local_import_[A-Za-z0-9_-]{43}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

export class LocalImportAuthError extends Error {
  code: string;
  status: number;
  details?: Record<string, unknown>;

  constructor(code: string, message: string, status = 400, details?: Record<string, unknown>) {
    super(message);
    this.name = "LocalImportAuthError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export type LocalImportRuntime = {
  canonicalOrigin: string;
  bootId: string;
  tokenSha256: string;
};

export function assertLocalImportTransport(
  request: Request,
  canonicalOrigin = LOCAL_IMPORT_CANONICAL_ORIGIN,
) {
  try {
    assertCanonicalManagementTransport(request, canonicalOrigin, { allowExactLoopbackForwarding: true });
  } catch (error) {
    const candidate = error as { code?: string; message?: string; status?: number; details?: Record<string, unknown> };
    const forwardingHeaders = Object.fromEntries([
      "forwarded",
      "x-forwarded-host",
      "x-forwarded-for",
      "x-forwarded-port",
      "x-forwarded-proto",
      "x-real-ip",
    ].flatMap((name) => {
      const value = request.headers.get(name);
      return value === null ? [] : [[name, value]];
    }));
    throw new LocalImportAuthError(
      candidate.code || "CANONICAL_LOOPBACK_REQUIRED",
      candidate.message || "本机导入接口只接受固定 IPv6 回环地址",
      candidate.status || 421,
      { ...candidate.details, forwardingHeaders },
    );
  }
  if (request.headers.has("cookie")) {
    throw new LocalImportAuthError("COOKIE_AUTH_FORBIDDEN", "本机导入接口不接受浏览器 Cookie", 403);
  }
  if (request.headers.has("origin") || request.headers.has("referer")) {
    throw new LocalImportAuthError("BROWSER_REQUEST_FORBIDDEN", "本机导入接口不接受浏览器来源请求", 403);
  }
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite && fetchSite !== "none") {
    throw new LocalImportAuthError("BROWSER_REQUEST_FORBIDDEN", "本机导入接口只接受本机命令行客户端", 403);
  }
}

export async function authenticateLocalImportRequest(
  request: Request,
  runtime: LocalImportRuntime,
) {
  assertLocalImportTransport(request, runtime.canonicalOrigin);
  if (!BOOT_ID_PATTERN.test(runtime.bootId) || !SHA256_PATTERN.test(runtime.tokenSha256)) {
    throw new LocalImportAuthError("LOCAL_IMPORT_RUNTIME_UNAVAILABLE", "本机导入凭据尚未初始化", 503);
  }
  const requestedBootId = request.headers.get(LOCAL_IMPORT_BOOT_HEADER) ?? "";
  if (!constantTimeTextEqual(requestedBootId, runtime.bootId)) {
    throw new LocalImportAuthError("LOCAL_IMPORT_BOOT_MISMATCH", "本机导入凭据已随服务重启轮换，请重新读取凭据后重试", 401);
  }
  const authorization = request.headers.get("authorization") ?? "";
  if (!authorization.startsWith("Bearer ")) {
    throw new LocalImportAuthError("LOCAL_IMPORT_AUTH_REQUIRED", "本机导入请求缺少 Bearer token", 401);
  }
  const token = authorization.slice(7).trim();
  if (!TOKEN_PATTERN.test(token)) {
    throw new LocalImportAuthError("LOCAL_IMPORT_AUTH_INVALID", "本机导入 token 无效", 401);
  }
  const tokenSha256 = await sha256Text(token);
  if (!constantTimeTextEqual(tokenSha256, runtime.tokenSha256)) {
    throw new LocalImportAuthError("LOCAL_IMPORT_AUTH_INVALID", "本机导入 token 无效", 401);
  }
  return { bootId: runtime.bootId };
}
