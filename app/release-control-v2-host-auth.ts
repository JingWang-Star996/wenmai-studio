import { canonicalExecutionJson, sha256ExecutionText } from "./release-execution-contract.ts";

const MAX_SKEW_MS = 60_000;
const HEX = /^[a-f0-9]{64}$/u;
const NONCE = /^[A-Za-z0-9_-]{32,192}$/u;

export class HostAuthError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, status = 401) { super(code); this.code = code; this.status = status; }
}

function bytesToHex(bytes: Uint8Array) { return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join(""); }
function hexToBytes(value: string) {
  if (!HEX.test(value)) return null;
  const bytes = new Uint8Array(32);
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  return bytes;
}
async function key(secret: string, usages: KeyUsage[]) {
  if (new TextEncoder().encode(secret).byteLength < 32) throw new HostAuthError("HOST_SIGNING_KEY_UNAVAILABLE", 503);
  return crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, usages);
}
export function hostExecutionEnabled(env: Record<string, unknown>) {
  return env.WENMAI_RELEASE_CONTROL_V2_ENABLED === "true" && env.WENMAI_PUBLISH_OPERATOR_HOST_ROUTE_VERIFIED === "true";
}
export function rejectBrowserRequest(request: Request) {
  return Boolean(request.headers.get("cookie") || request.headers.get("authorization")
    || request.headers.get("sec-fetch-site") || request.headers.get("sec-fetch-mode") || request.headers.get("sec-fetch-dest"));
}
export function hostCanonicalRequest(method: string, pathname: string, host: string, timestamp: string, nonce: string, bodySha256: string) {
  return canonicalExecutionJson({ bodySha256, host: host.toLowerCase(), method: method.toUpperCase(), nonce, pathname, timestamp });
}
export async function verifyHostRequest(request: Request, rawBody: string, secret: string, now = Date.now()) {
  if (rejectBrowserRequest(request)) throw new HostAuthError("BROWSER_OR_SESSION_AUTH_FORBIDDEN", 403);
  const timestamp = request.headers.get("x-wenmai-host-timestamp") ?? "";
  const nonce = request.headers.get("x-wenmai-host-nonce") ?? "";
  const suppliedBodySha = request.headers.get("x-wenmai-host-body-sha256") ?? "";
  const signature = request.headers.get("x-wenmai-host-signature") ?? "";
  const host = request.headers.get("host") ?? "";
  const parsed = Date.parse(timestamp);
  if (!Number.isFinite(parsed) || Math.abs(now - parsed) > MAX_SKEW_MS || !NONCE.test(nonce) || !HEX.test(suppliedBodySha) || !host) throw new HostAuthError("HOST_SIGNATURE_HEADERS_INVALID");
  const actualBodySha = await sha256ExecutionText(rawBody);
  if (actualBodySha !== suppliedBodySha) throw new HostAuthError("HOST_BODY_DIGEST_MISMATCH");
  const bytes = hexToBytes(signature);
  if (!bytes) throw new HostAuthError("HOST_SIGNATURE_INVALID");
  const payload = hostCanonicalRequest(request.method, new URL(request.url).pathname, host, timestamp, nonce, actualBodySha);
  const valid = await crypto.subtle.verify("HMAC", await key(secret, ["verify"]), bytes, new TextEncoder().encode(payload));
  if (!valid) throw new HostAuthError("HOST_SIGNATURE_INVALID");
  return { bodySha256: actualBodySha, host, nonce, timestamp };
}

export async function signHostRequest(fields: { method: string; pathname: string; host: string; timestamp: string; nonce: string; bodySha256: string }, secret: string) {
  const signature = await crypto.subtle.sign("HMAC", await key(secret, ["sign"]), new TextEncoder().encode(hostCanonicalRequest(fields.method, fields.pathname, fields.host, fields.timestamp, fields.nonce, fields.bodySha256)));
  return bytesToHex(new Uint8Array(signature));
}
