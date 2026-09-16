export const MANAGEMENT_CANONICAL_ORIGIN = "http://[::1]:3000";
export const MANAGEMENT_SESSION_COOKIE = "wenmai_management_session";
export const MANAGEMENT_SESSION_ABSOLUTE_SECONDS = 8 * 60 * 60;
export const MANAGEMENT_SESSION_IDLE_SECONDS = 30 * 60;
export const MANAGEMENT_PAIRING_MAX_ATTEMPTS = 5;
export const MANAGEMENT_BROWSER_BINDING_HEADER = "x-wenmai-browser-binding";
export const MANAGEMENT_BROWSER_BINDING_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export class ManagementAuthError extends Error {
  code: string;
  status: number;
  details?: Record<string, unknown>;

  constructor(code: string, message: string, status = 400, details?: Record<string, unknown>) {
    super(message);
    this.name = "ManagementAuthError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export function randomToken(byteLength = 32) {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

export async function sha256Text(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function constantTimeTextEqual(left: string, right: string) {
  const length = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let index = 0; index < length; index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}

export function parseCookieHeader(header: string | null) {
  const cookies = new Map<string, string>();
  if (!header) return cookies;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator <= 0) continue;
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (!key) continue;
    try {
      cookies.set(key, decodeURIComponent(value));
    } catch {
      cookies.set(key, value);
    }
  }
  return cookies;
}

export function managementSessionCookie(token: string, maxAgeSeconds = MANAGEMENT_SESSION_ABSOLUTE_SECONDS) {
  return [
    `${MANAGEMENT_SESSION_COOKIE}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`,
  ].join("; ");
}

export function clearManagementSessionCookie() {
  return `${MANAGEMENT_SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
}

export function assertCanonicalManagementTransport(
  request: Request,
  canonicalOrigin = MANAGEMENT_CANONICAL_ORIGIN,
  options: { mutation?: boolean; allowExactLoopbackForwarding?: boolean } = {},
) {
  const expected = new URL(canonicalOrigin);
  const actual = new URL(request.url);
  if (actual.origin !== expected.origin) {
    throw new ManagementAuthError("CANONICAL_ORIGIN_REQUIRED", "管理接口只接受文脉固定的本机回环地址", 421);
  }
  const host = request.headers.get("host");
  if (host && host.toLowerCase() !== expected.host.toLowerCase()) {
    throw new ManagementAuthError("CANONICAL_HOST_REQUIRED", "请求 Host 与文脉固定回环地址不一致", 421);
  }
  // The Cloudflare Vite adapter mirrors the already-validated raw Host into
  // X-Forwarded-Host before dispatching to Miniflare. Accept only that single,
  // exact redundant value. A real proxy chain or alternate identity remains
  // forbidden, including a mirror without the canonical raw Host.
  const forwardedHost = request.headers.get("x-forwarded-host");
  let normalizedForwardedHost: string | null = null;
  if (forwardedHost !== null) {
    try {
      normalizedForwardedHost = new URL(`${expected.protocol}//${forwardedHost}`).host.toLowerCase();
    } catch {
      normalizedForwardedHost = null;
    }
  }
  if (forwardedHost !== null && (
    !host
    || host.toLowerCase() !== expected.host.toLowerCase()
    || normalizedForwardedHost !== expected.host.toLowerCase()
  )) {
    throw new ManagementAuthError("FORWARDED_REQUEST_FORBIDDEN", "本地管理接口不接受代理转发身份", 421);
  }
  const exactLoopbackForwarding = options.allowExactLoopbackForwarding === true
    && request.headers.get("forwarded") === null
    && normalizedForwardedHost === expected.host.toLowerCase()
    && request.headers.get("x-forwarded-for") === "::1"
    && request.headers.get("x-forwarded-port") === (expected.port || "80")
    && request.headers.get("x-forwarded-proto") === expected.protocol.slice(0, -1)
    && [null, "::1"].includes(request.headers.get("x-real-ip"));
  const proxyIdentityHeaders = [
    "forwarded",
    "x-forwarded-for",
    "x-forwarded-port",
    "x-forwarded-proto",
    "x-real-ip",
  ];
  if (proxyIdentityHeaders.some((header) => request.headers.has(header)) && !exactLoopbackForwarding) {
    throw new ManagementAuthError("FORWARDED_REQUEST_FORBIDDEN", "本地管理接口不接受代理转发身份", 421);
  }
  if (!options.mutation) return;
  const origin = request.headers.get("origin");
  if (origin !== expected.origin) {
    throw new ManagementAuthError("ORIGIN_MISMATCH", "管理写入只接受当前文脉页面的同源请求", 403);
  }
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite && !["same-origin", "none"].includes(fetchSite)) {
    throw new ManagementAuthError("CROSS_SITE_REQUEST_FORBIDDEN", "跨站管理请求已被拒绝", 403);
  }
}

export async function deriveCsrfToken(sessionToken: string, hmacKey: string) {
  if (hmacKey.length < 32) {
    throw new ManagementAuthError("AUTH_RUNTIME_UNAVAILABLE", "管理会话的本机运行密钥不可用", 503);
  }
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(hmacKey),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`wenmai-management-csrf/v1\n${sessionToken}`),
  );
  return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
