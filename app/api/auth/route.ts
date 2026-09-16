import {
  ManagementAuthError,
  clearManagementSessionCookie,
  managementSessionCookie,
} from "../../management-auth-core";
import {
  beginTrustedManagementSession,
  bootstrapManagementSession,
  completeTrustedManagementSession,
  enrollManagementBrowserDevice,
  exchangeSiteFullControlManagementSession,
  managementBootId,
  managementCanonicalOrigin,
  managementPairingStatus,
  optionalManagementSession,
  revokeCurrentManagementSession,
} from "../../management-auth";

const MAX_REQUEST_BYTES = 4_096;

function requestId() {
  return `auth-request-${crypto.randomUUID()}`;
}

function securityHeaders() {
  return {
    "cache-control": "no-store, max-age=0",
    pragma: "no-cache",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "cross-origin-resource-policy": "same-origin",
  };
}

function jsonSuccess(id: string, data: Record<string, unknown>, status = 200, extraHeaders?: HeadersInit) {
  return Response.json({ ok: true, requestId: id, data }, {
    status,
    headers: { ...securityHeaders(), ...Object.fromEntries(new Headers(extraHeaders).entries()) },
  });
}

function jsonError(id: string, error: unknown, clearCookie = false) {
  const authError = error instanceof ManagementAuthError
    ? error
    : new ManagementAuthError("INTERNAL_ERROR", "本机管理会话处理失败", 500);
  const headers = new Headers(securityHeaders());
  if (clearCookie) headers.set("set-cookie", clearManagementSessionCookie());
  return Response.json({
    ok: false,
    requestId: id,
    error: {
      code: authError.code,
      message: authError.message,
      ...(authError.details ? { details: authError.details } : {}),
    },
  }, { status: authError.status, headers });
}

async function parseBody(request: Request) {
  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.includes("application/json")) {
    throw new ManagementAuthError("UNSUPPORTED_MEDIA_TYPE", "管理会话请求的内容类型无效；尚未创建或变更会话。请使用 application/json 后重试。", 415);
  }
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES) {
    throw new ManagementAuthError("PAYLOAD_TOO_LARGE", "管理会话请求超过 4 KB；尚未创建或变更会话。请缩小请求后重试。", 413);
  }
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_REQUEST_BYTES) {
    throw new ManagementAuthError("PAYLOAD_TOO_LARGE", "管理会话请求超过 4 KB；尚未创建或变更会话。请缩小请求后重试。", 413);
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ManagementAuthError("INVALID_JSON", "管理会话请求不是有效 JSON；尚未创建或变更会话。请检查请求正文后重试。");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ManagementAuthError("INVALID_BODY", "管理会话请求正文不是 JSON 对象；尚未创建或变更会话。请按对象格式提交后重试。");
  }
  return value as Record<string, unknown>;
}

function publicSession(principal: Awaited<ReturnType<typeof optionalManagementSession>>) {
  if (!principal) return null;
  return {
    principalId: principal.principalId,
    scopes: principal.scopes,
    articleIds: principal.articleIds,
    absoluteExpiresAt: principal.absoluteExpiresAt,
    idleExpiresAt: principal.idleExpiresAt,
    authBasis: principal.authBasis,
    sourceClientId: principal.sourceClientId,
  };
}

export async function GET(request: Request) {
  const id = requestId();
  try {
    const [principal, pairing] = await Promise.all([
      optionalManagementSession(request),
      managementPairingStatus(),
    ]);
    return jsonSuccess(id, {
      authenticated: Boolean(principal),
      canonicalOrigin: managementCanonicalOrigin(),
      bootId: managementBootId(),
      pairing,
      session: publicSession(principal),
      ...(principal ? { csrfToken: principal.csrfToken } : {}),
    }, 200, principal ? undefined : { "set-cookie": clearManagementSessionCookie() });
  } catch (error) {
    return jsonError(id, error, true);
  }
}

export async function POST(request: Request) {
  const id = requestId();
  try {
    const body = await parseBody(request);
    const action = typeof body.action === "string" ? body.action : "";
    if (action === "site_full_control.exchange") {
      const result = await exchangeSiteFullControlManagementSession(request, body, id);
      return jsonSuccess(id, {
        authenticated: true,
        canonicalOrigin: managementCanonicalOrigin(),
        session: publicSession(result.principal),
        csrfToken: result.principal.csrfToken,
      }, 201, { "set-cookie": managementSessionCookie(result.sessionToken, result.maxAgeSeconds) });
    }
    if (action === "bootstrap") {
      const pairingCode = typeof body.pairingCode === "string" ? body.pairingCode : "";
      if (!pairingCode || pairingCode.length > 128) {
        throw new ManagementAuthError("PAIRING_CODE_REQUIRED", "管理会话缺少有效的一次性配对码；尚未创建会话。请输入启动窗口显示的配对码后重试。");
      }
      const browserBindingSha256 = typeof body.browserBindingSha256 === "string"
        ? body.browserBindingSha256.toLowerCase()
        : "";
      const result = await bootstrapManagementSession(request, pairingCode, browserBindingSha256, id);
      return jsonSuccess(id, {
        authenticated: true,
        canonicalOrigin: managementCanonicalOrigin(),
        bootId: managementBootId(),
        session: publicSession(result.principal),
        csrfToken: result.principal.csrfToken,
      }, 201, { "set-cookie": managementSessionCookie(result.sessionToken) });
    }
    if (action === "device.enroll") {
      const publicKeyJwk = body.publicKeyJwk && typeof body.publicKeyJwk === "object" && !Array.isArray(body.publicKeyJwk)
        ? body.publicKeyJwk as Record<string, unknown>
        : {};
      const result = await enrollManagementBrowserDevice(request, {
        deviceId: typeof body.deviceId === "string" ? body.deviceId : "",
        publicKeyJwk,
        publicKeySha256: typeof body.publicKeySha256 === "string" ? body.publicKeySha256.toLowerCase() : "",
        signature: typeof body.signature === "string" ? body.signature : "",
      }, id);
      return jsonSuccess(id, result);
    }
    if (action === "device.begin") {
      const result = await beginTrustedManagementSession(
        request,
        typeof body.deviceId === "string" ? body.deviceId : "",
      );
      return jsonSuccess(id, result);
    }
    if (action === "device.complete") {
      const result = await completeTrustedManagementSession(request, {
        deviceId: typeof body.deviceId === "string" ? body.deviceId : "",
        challengeId: typeof body.challengeId === "string" ? body.challengeId : "",
        nonce: typeof body.nonce === "string" ? body.nonce : "",
        signingPayload: typeof body.signingPayload === "string" ? body.signingPayload : "",
        signature: typeof body.signature === "string" ? body.signature : "",
      }, id);
      return jsonSuccess(id, {
        authenticated: true,
        canonicalOrigin: managementCanonicalOrigin(),
        bootId: managementBootId(),
        session: publicSession(result.principal),
        csrfToken: result.principal.csrfToken,
        automatic: true,
      }, 201, { "set-cookie": managementSessionCookie(result.sessionToken) });
    }
    if (action === "logout") {
      await revokeCurrentManagementSession(request, id);
      return jsonSuccess(id, { authenticated: false }, 200, { "set-cookie": clearManagementSessionCookie() });
    }
    throw new ManagementAuthError("UNKNOWN_ACTION", "管理会话动作未被识别；现有会话未被变更。请检查 action 后重试。", 404);
  } catch (error) {
    return jsonError(id, error, error instanceof ManagementAuthError && error.status === 401);
  }
}

export async function OPTIONS() {
  return new Response(null, {
    status: 405,
    headers: { ...securityHeaders(), allow: "GET, POST" },
  });
}
