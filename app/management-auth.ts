import { env } from "cloudflare:workers";
import {
  MANAGEMENT_BROWSER_BINDING_HEADER,
  MANAGEMENT_BROWSER_BINDING_PATTERN,
  MANAGEMENT_CANONICAL_ORIGIN,
  MANAGEMENT_PAIRING_MAX_ATTEMPTS,
  MANAGEMENT_SESSION_ABSOLUTE_SECONDS,
  MANAGEMENT_SESSION_COOKIE,
  MANAGEMENT_SESSION_IDLE_SECONDS,
  ManagementAuthError,
  assertCanonicalManagementTransport,
  constantTimeTextEqual,
  deriveCsrfToken,
  parseCookieHeader,
  randomToken,
  sha256Text,
} from "./management-auth-core";
import { MANAGEMENT_SCOPES as CATALOG_MANAGEMENT_SCOPES, type ManagementScope } from "./management-scope-catalog";
import { exchangeSiteFullControlKey, revokeDerivedSiteFullControlSessions, verifyActiveSiteFullControlSessionSource, verifyDirectSiteFullControlKey } from "./site-full-control-auth";

type D1Row = Record<string, string | number | null>;

type AuthBindings = {
  DB?: D1Database;
  WENMAI_AUTH_CANONICAL_ORIGIN?: string;
  WENMAI_AUTH_BOOT_ID?: string;
  WENMAI_AUTH_CHALLENGE_ID?: string;
  WENMAI_AUTH_PAIRING_SHA256?: string;
  WENMAI_AUTH_CHALLENGE_CREATED_AT?: string;
  WENMAI_AUTH_CHALLENGE_EXPIRES_AT?: string;
  WENMAI_AUTH_CSRF_HMAC_KEY?: string;
};

type ManagementDevicePublicJwk = {
  crv: "P-256";
  kty: "EC";
  x: string;
  y: string;
};

export type ManagementDeviceEnrollment = {
  deviceId: string;
  publicKeyJwk: Record<string, unknown>;
  publicKeySha256: string;
  signature: string;
};

export type ManagementDeviceCompletion = {
  deviceId: string;
  challengeId: string;
  nonce: string;
  signingPayload: string;
  signature: string;
};

const MANAGEMENT_DEVICE_CHALLENGE_SECONDS = 30;
const MANAGEMENT_DEVICE_MAX_ATTEMPTS = 3;
const MANAGEMENT_DEVICE_ID_PATTERN = /^management-device-[a-f0-9]{64}$/u;
const MANAGEMENT_DEVICE_CHALLENGE_ID_PATTERN = /^management-device-challenge-[0-9a-f-]{36}$/u;
const MANAGEMENT_BOOT_ID_PATTERN = /^management-boot-[A-Za-z0-9_-]{22}$/u;
const BASE64URL_256_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const BASE64URL_P256_SIGNATURE_PATTERN = /^[A-Za-z0-9_-]{86}$/u;

const LEGACY_MANAGEMENT_SCOPES = [
  "management.read",
  "editorial.write",
  "identity.decide",
  "workspace.branch.write",
  "workspace.revision.commit",
  "workspace.merge.apply",
  "capability.override",
  "lifecycle.write",
  "release.approve",
  "release.record",
  "rule.adopt",
  "package.write",
  "package.patch.decide",
  "token.issue",
  "token.revoke",
  "task.manage",
  "runner.manage",
  "admin.diagnostics",
] as const;
// Kept only as a compile-time migration guard while callers move to the catalog.
void LEGACY_MANAGEMENT_SCOPES;

export const MANAGEMENT_SCOPES = CATALOG_MANAGEMENT_SCOPES;
export type { ManagementScope } from "./management-scope-catalog";

export type ManagementPrincipal = {
  sessionId: string;
  principalId: string;
  scopes: string[];
  articleIds: string[];
  objectBoundary: Record<string, unknown>;
  absoluteExpiresAt: string;
  idleExpiresAt: string;
  csrfToken: string;
  authBasis: string;
  sourceClientId: string | null;
};

function runtimeBindings() {
  const workerBindings = env as unknown as AuthBindings;
  const processBindings = typeof process === "undefined" ? {} : process.env;
  const read = (name: keyof AuthBindings) => {
    const workerValue = workerBindings[name];
    if (typeof workerValue === "string" && workerValue) return workerValue;
    const processValue = processBindings[String(name)];
    return typeof processValue === "string" ? processValue : "";
  };
  return {
    db: workerBindings.DB,
    canonicalOrigin: read("WENMAI_AUTH_CANONICAL_ORIGIN") || MANAGEMENT_CANONICAL_ORIGIN,
    bootId: read("WENMAI_AUTH_BOOT_ID"),
    challengeId: read("WENMAI_AUTH_CHALLENGE_ID"),
    pairingSha256: read("WENMAI_AUTH_PAIRING_SHA256").toLowerCase(),
    challengeCreatedAt: read("WENMAI_AUTH_CHALLENGE_CREATED_AT"),
    challengeExpiresAt: read("WENMAI_AUTH_CHALLENGE_EXPIRES_AT"),
    csrfHmacKey: read("WENMAI_AUTH_CSRF_HMAC_KEY"),
  };
}

function database() {
  const db = runtimeBindings().db;
  if (!db) throw new ManagementAuthError("DB_UNAVAILABLE", "本地管理会话数据库尚未连接", 503);
  return db;
}

function isoNow() {
  return new Date().toISOString();
}

function isoAfter(seconds: number) {
  return new Date(Date.now() + seconds * 1000).toISOString();
}

function parseJson<T>(value: unknown, fallback: T) {
  try {
    return JSON.parse(String(value ?? "")) as T;
  } catch {
    return fallback;
  }
}

function normalizePairingCode(value: string) {
  return value.trim();
}

function challengeIdFromPairingCode(value: string) {
  const match = /^wenmai1\.([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{22})$/u.exec(normalizePairingCode(value));
  return match ? `management-challenge-${match[1]}` : "";
}

function canonicalPublicJwk(value: Record<string, unknown>) {
  const kty = value.kty;
  const crv = value.crv;
  const x = value.x;
  const y = value.y;
  if (
    kty !== "EC"
    || crv !== "P-256"
    || typeof x !== "string"
    || typeof y !== "string"
    || !BASE64URL_256_PATTERN.test(x)
    || !BASE64URL_256_PATTERN.test(y)
    || typeof value.d === "string"
  ) {
    throw new ManagementAuthError("DEVICE_PUBLIC_KEY_INVALID", "本机设备公钥不是有效的 P-256 公钥", 400);
  }
  return { crv: "P-256", kty: "EC", x, y } satisfies ManagementDevicePublicJwk;
}

function canonicalPublicJwkText(value: ManagementDevicePublicJwk) {
  return JSON.stringify({ crv: value.crv, kty: value.kty, x: value.x, y: value.y });
}

function decodeBase64Url(value: string) {
  try {
    const standard = value.replaceAll("-", "+").replaceAll("_", "/");
    const padded = standard.padEnd(Math.ceil(standard.length / 4) * 4, "=");
    const binary = atob(padded);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    throw new ManagementAuthError("DEVICE_SIGNATURE_INVALID", "本机设备签名格式无效", 400);
  }
}

async function verifyDeviceSignature(publicKeyJwk: ManagementDevicePublicJwk, message: string, signature: string) {
  if (!BASE64URL_P256_SIGNATURE_PATTERN.test(signature)) return false;
  const bytes = decodeBase64Url(signature);
  if (bytes.byteLength !== 64) return false;
  try {
    const publicKey = await crypto.subtle.importKey(
      "jwk",
      publicKeyJwk,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    return await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      publicKey,
      bytes,
      new TextEncoder().encode(message),
    );
  } catch {
    return false;
  }
}

async function browserBindingShaForRequest(request: Request) {
  const browserBinding = request.headers.get(MANAGEMENT_BROWSER_BINDING_HEADER) ?? "";
  if (!MANAGEMENT_BROWSER_BINDING_PATTERN.test(browserBinding)) {
    throw new ManagementAuthError("MANAGEMENT_BROWSER_BINDING_REQUIRED", "自动进入需要当前文脉端口的浏览器绑定", 401);
  }
  return sha256Text(browserBinding);
}

function deviceEnrollmentMessage(input: {
  origin: string;
  bootId: string;
  deviceId: string;
  publicKeySha256: string;
  browserBindingSha256: string;
}) {
  return [
    "wenmai-management-device-enroll/v1",
    `origin=${input.origin}`,
    `boot=${input.bootId}`,
    `device=${input.deviceId}`,
    `publicKey=${input.publicKeySha256}`,
    `binding=${input.browserBindingSha256}`,
  ].join("\n");
}

function deviceResumeMessage(input: {
  origin: string;
  bootId: string;
  challengeId: string;
  nonce: string;
  deviceId: string;
  browserBindingSha256: string;
}) {
  return [
    "wenmai-management-device-resume/v1",
    `origin=${input.origin}`,
    `boot=${input.bootId}`,
    `challenge=${input.challengeId}`,
    `nonce=${input.nonce}`,
    `device=${input.deviceId}`,
    `binding=${input.browserBindingSha256}`,
  ].join("\n");
}

function requireDeviceRuntime() {
  const bindings = runtimeBindings();
  if (
    !MANAGEMENT_BOOT_ID_PATTERN.test(bindings.bootId)
    || !bindings.challengeId
    || !bindings.pairingSha256
    || bindings.csrfHmacKey.length < 32
  ) {
    throw new ManagementAuthError("TRUSTED_DEVICE_UNAVAILABLE", "当前服务没有可用的本机设备恢复挑战，请使用启动器重新启动", 503);
  }
  return bindings;
}

function eventStatement(db: D1Database, input: {
  eventType: string;
  outcome: "accepted" | "rejected" | "expired" | "revoked";
  requestId: string;
  principalId?: string | null;
  sessionId?: string | null;
  details?: Record<string, unknown>;
}) {
  return db.prepare(`INSERT INTO management_auth_events
    (id, event_type, principal_id, session_id, outcome, request_id, details_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(
      `management-auth-event-${crypto.randomUUID()}`,
      input.eventType,
      input.principalId ?? null,
      input.sessionId ?? null,
      input.outcome,
      input.requestId,
      JSON.stringify(input.details ?? {}),
      isoNow(),
    );
}

export async function ensureManagementAuthSchema() {
  const db = database();
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS management_bootstrap_challenges (
      id TEXT PRIMARY KEY NOT NULL,
      pairing_sha256 TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','consumed','locked','expired')),
      attempts INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 5,
      expires_at TEXT NOT NULL,
      consumed_at TEXT,
      consumed_session_id TEXT,
      created_at TEXT NOT NULL
    )`),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_management_bootstrap_status_expiry ON management_bootstrap_challenges(status, expires_at)"),
    db.prepare(`CREATE TABLE IF NOT EXISTS management_sessions (
      id TEXT PRIMARY KEY NOT NULL,
      principal_id TEXT NOT NULL,
      token_sha256 TEXT NOT NULL UNIQUE,
      browser_binding_sha256 TEXT NOT NULL,
      trusted_device_id TEXT,
      auth_basis TEXT NOT NULL DEFAULT 'owner_pairing',
      authority_class TEXT NOT NULL DEFAULT 'owner',
      source_client_id TEXT,
      source_key_expires_at TEXT,
      source_exchange_generation INTEGER,
      source_permission_snapshot_sha256 TEXT,
      scopes_json TEXT NOT NULL DEFAULT '[]',
      article_ids_json TEXT NOT NULL DEFAULT '[]',
      object_boundary_json TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked','expired')),
      absolute_expires_at TEXT NOT NULL,
      idle_expires_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      revoked_at TEXT,
      revoke_reason TEXT NOT NULL DEFAULT ''
    )`),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_management_sessions_principal_status ON management_sessions(principal_id, status, absolute_expires_at)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_management_sessions_expiry ON management_sessions(status, idle_expires_at, absolute_expires_at)"),
    db.prepare(`CREATE TABLE IF NOT EXISTS management_browser_devices (
      id TEXT PRIMARY KEY NOT NULL,
      principal_id TEXT NOT NULL,
      public_key_jwk_json TEXT NOT NULL,
      public_key_sha256 TEXT NOT NULL UNIQUE,
      browser_binding_sha256 TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
      enrolled_session_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_used_at TEXT,
      revoked_at TEXT,
      revoke_reason TEXT NOT NULL DEFAULT ''
    )`),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_management_browser_devices_binding_status ON management_browser_devices(browser_binding_sha256, status, updated_at)"),
    db.prepare(`CREATE TABLE IF NOT EXISTS management_device_challenges (
      id TEXT PRIMARY KEY NOT NULL,
      boot_id TEXT NOT NULL,
      device_id TEXT NOT NULL,
      nonce_sha256 TEXT NOT NULL UNIQUE,
      payload_sha256 TEXT NOT NULL UNIQUE,
      browser_binding_sha256 TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','consumed','locked','expired')),
      attempts INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 3,
      issued_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      consumed_at TEXT,
      consumed_session_id TEXT,
      created_at TEXT NOT NULL
    )`),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_management_device_challenges_device_status ON management_device_challenges(device_id, status, expires_at)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_management_device_challenges_boot_status ON management_device_challenges(boot_id, status, expires_at)"),
    db.prepare(`CREATE TABLE IF NOT EXISTS management_auth_events (
      id TEXT PRIMARY KEY NOT NULL,
      event_type TEXT NOT NULL,
      principal_id TEXT,
      session_id TEXT,
      outcome TEXT NOT NULL CHECK (outcome IN ('accepted','rejected','expired','revoked')),
      request_id TEXT NOT NULL,
      details_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    )`),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_management_auth_events_created ON management_auth_events(created_at)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_management_auth_events_session ON management_auth_events(session_id, created_at)"),
  ]);
  const sessionColumns = await db.prepare("PRAGMA table_info(management_sessions)").all<D1Row>();
  if (!sessionColumns.results.some((column) => column.name === "browser_binding_sha256")) {
    try {
      await db.prepare("ALTER TABLE management_sessions ADD COLUMN browser_binding_sha256 TEXT NOT NULL DEFAULT ''").run();
    } catch (error) {
      const refreshedColumns = await db.prepare("PRAGMA table_info(management_sessions)").all<D1Row>();
      if (!refreshedColumns.results.some((column) => column.name === "browser_binding_sha256")) throw error;
    }
  }
  if (!sessionColumns.results.some((column) => column.name === "trusted_device_id")) {
    try {
      await db.prepare("ALTER TABLE management_sessions ADD COLUMN trusted_device_id TEXT").run();
    } catch (error) {
      const refreshedColumns = await db.prepare("PRAGMA table_info(management_sessions)").all<D1Row>();
      if (!refreshedColumns.results.some((column) => column.name === "trusted_device_id")) throw error;
    }
  }
  for (const [column, declaration] of [
    ["auth_basis", "TEXT NOT NULL DEFAULT 'owner_pairing'"],
    ["authority_class", "TEXT NOT NULL DEFAULT 'owner'"],
    ["source_client_id", "TEXT"],
    ["source_key_expires_at", "TEXT"],
    ["source_exchange_generation", "INTEGER"],
    ["source_permission_snapshot_sha256", "TEXT"],
  ] as const) {
    if (!sessionColumns.results.some((entry) => entry.name === column)) {
      try { await db.prepare(`ALTER TABLE management_sessions ADD COLUMN ${column} ${declaration}`).run(); }
      catch (error) {
        const refreshed = await db.prepare("PRAGMA table_info(management_sessions)").all<D1Row>();
        if (!refreshed.results.some((entry) => entry.name === column)) throw error;
      }
    }
  }
  await db.prepare("CREATE INDEX IF NOT EXISTS idx_management_sessions_trusted_device ON management_sessions(trusted_device_id, status, created_at)").run();
  await db.prepare("CREATE INDEX IF NOT EXISTS idx_management_sessions_source_client ON management_sessions(source_client_id, status, source_exchange_generation)").run();
  await seedRuntimeChallenge(db);
  return db;
}

async function seedRuntimeChallenge(db: D1Database) {
  const bindings = runtimeBindings();
  if (
    !bindings.challengeId
    || !/^[a-f0-9]{64}$/u.test(bindings.pairingSha256)
    || !bindings.challengeCreatedAt
    || !bindings.challengeExpiresAt
  ) return false;
  const createdTime = Date.parse(bindings.challengeCreatedAt);
  const expiryTime = Date.parse(bindings.challengeExpiresAt);
  if (!Number.isFinite(createdTime) || !Number.isFinite(expiryTime) || expiryTime <= createdTime) return false;
  await db.prepare(`INSERT OR IGNORE INTO management_bootstrap_challenges
    (id, pairing_sha256, status, attempts, max_attempts, expires_at, created_at)
    VALUES (?, ?, 'active', 0, ?, ?, ?)`)
    .bind(
      bindings.challengeId,
      bindings.pairingSha256,
      MANAGEMENT_PAIRING_MAX_ATTEMPTS,
      bindings.challengeExpiresAt,
      bindings.challengeCreatedAt,
    )
    .run();
  return true;
}

export function managementCanonicalOrigin() {
  return runtimeBindings().canonicalOrigin;
}

export function managementBootId() {
  const bootId = runtimeBindings().bootId;
  return MANAGEMENT_BOOT_ID_PATTERN.test(bootId) ? bootId : "";
}

export async function managementPairingStatus() {
  const db = await ensureManagementAuthSchema();
  const bindings = runtimeBindings();
  if (!bindings.challengeId) return { available: false, expiresAt: null, state: "unavailable" };
  const row = await db.prepare("SELECT status, attempts, max_attempts, expires_at FROM management_bootstrap_challenges WHERE id = ? LIMIT 1")
    .bind(bindings.challengeId).first<D1Row>();
  if (!row) return { available: false, expiresAt: null, state: "unavailable" };
  const expired = String(row.expires_at) <= isoNow();
  const locked = Number(row.attempts) >= Number(row.max_attempts) || row.status === "locked";
  const state = expired ? "expired" : locked ? "locked" : String(row.status);
  return {
    available: state === "active",
    expiresAt: String(row.expires_at),
    state,
    attemptsRemaining: Math.max(0, Number(row.max_attempts) - Number(row.attempts)),
  };
}

export async function bootstrapManagementSession(
  request: Request,
  pairingCode: string,
  browserBindingSha256: string,
  requestId: string,
) {
  const bindings = runtimeBindings();
  assertCanonicalManagementTransport(request, bindings.canonicalOrigin, { mutation: true });
  if (!bindings.challengeId || !bindings.pairingSha256 || bindings.csrfHmacKey.length < 32) {
    throw new ManagementAuthError("PAIRING_UNAVAILABLE", "当前服务没有可用的本机配对挑战，请用文脉启动器重新启动", 503);
  }
  const selectedChallengeId = challengeIdFromPairingCode(pairingCode);
  if (!selectedChallengeId || !constantTimeTextEqual(selectedChallengeId, bindings.challengeId)) {
    throw new ManagementAuthError("PAIRING_SELECTOR_INVALID", "配对码不属于当前启动的文脉服务", 401);
  }
  if (!/^[a-f0-9]{64}$/u.test(browserBindingSha256)) {
    throw new ManagementAuthError("BROWSER_BINDING_INVALID", "浏览器端口绑定摘要无效", 400);
  }
  const db = await ensureManagementAuthSchema();
  const challenge = await db.prepare("SELECT * FROM management_bootstrap_challenges WHERE id = ? LIMIT 1")
    .bind(bindings.challengeId).first<D1Row>();
  if (!challenge) throw new ManagementAuthError("PAIRING_UNAVAILABLE", "当前服务没有可用的本机配对挑战", 503);
  const now = isoNow();
  if (String(challenge.status) === "consumed") throw new ManagementAuthError("PAIRING_CONSUMED", "本次配对码已经使用，不能重放", 409);
  if (String(challenge.expires_at) <= now || String(challenge.status) === "expired") {
    await db.prepare("UPDATE management_bootstrap_challenges SET status = 'expired' WHERE id = ? AND status = 'active'")
      .bind(bindings.challengeId).run();
    throw new ManagementAuthError("PAIRING_EXPIRED", "本次配对码已经过期，请重新启动文脉", 410);
  }
  if (Number(challenge.attempts) >= Number(challenge.max_attempts) || String(challenge.status) === "locked") {
    throw new ManagementAuthError("PAIRING_LOCKED", "配对尝试次数已用完，请重新启动文脉", 429);
  }
  const suppliedSha256 = await sha256Text(normalizePairingCode(pairingCode));
  if (!constantTimeTextEqual(suppliedSha256, String(challenge.pairing_sha256))) {
    const failed = await db.batch([
      db.prepare(`UPDATE management_bootstrap_challenges SET
        attempts = attempts + 1,
        status = CASE WHEN attempts + 1 >= max_attempts THEN 'locked' ELSE status END
        WHERE id = ? AND status = 'active' AND expires_at > ? AND attempts < max_attempts`)
        .bind(bindings.challengeId, now),
      eventStatement(db, {
        eventType: "management.bootstrap",
        outcome: "rejected",
        requestId,
        details: { reason: "pairing_code_mismatch", challengeId: bindings.challengeId },
      }),
    ]);
    const locked = Number(failed[0].meta.changes ?? 0) === 1
      && Number(challenge.attempts) + 1 >= Number(challenge.max_attempts);
    throw new ManagementAuthError(
      locked ? "PAIRING_LOCKED" : "PAIRING_INVALID",
      locked ? "配对尝试次数已用完，请重新启动文脉" : "配对码不正确",
      locked ? 429 : 401,
    );
  }

  const sessionId = `management-session-${crypto.randomUUID()}`;
  const sessionToken = `wenmai_management_${randomToken(32)}`;
  const tokenSha256 = await sha256Text(sessionToken);
  const principalId = "local-owner";
  const scopes = [...MANAGEMENT_SCOPES];
  const articleIds = ["*"];
  const objectBoundary = { articles: ["*"], localOwner: true };
  const absoluteExpiresAt = isoAfter(MANAGEMENT_SESSION_ABSOLUTE_SECONDS);
  const idleExpiresAt = new Date(Math.min(
    Date.now() + MANAGEMENT_SESSION_IDLE_SECONDS * 1000,
    Date.parse(absoluteExpiresAt),
  )).toISOString();
  const results = await db.batch([
    db.prepare(`UPDATE management_bootstrap_challenges SET
      status = 'consumed', consumed_at = ?, consumed_session_id = ?
      WHERE id = ? AND pairing_sha256 = ? AND status = 'active'
        AND expires_at > ? AND attempts < max_attempts`)
      .bind(now, sessionId, bindings.challengeId, suppliedSha256, now),
    db.prepare(`INSERT INTO management_sessions
      (id, principal_id, token_sha256, browser_binding_sha256, scopes_json, article_ids_json, object_boundary_json,
       status, absolute_expires_at, idle_expires_at, last_seen_at, created_at)
      SELECT ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?
      WHERE EXISTS (
        SELECT 1 FROM management_bootstrap_challenges
        WHERE id = ? AND status = 'consumed' AND consumed_session_id = ? AND consumed_at = ?
      )`)
      .bind(
        sessionId,
        principalId,
        tokenSha256,
        browserBindingSha256,
        JSON.stringify(scopes),
        JSON.stringify(articleIds),
        JSON.stringify(objectBoundary),
        absoluteExpiresAt,
        idleExpiresAt,
        now,
        now,
        bindings.challengeId,
        sessionId,
        now,
      ),
    db.prepare(`INSERT INTO management_auth_events
      (id, event_type, principal_id, session_id, outcome, request_id, details_json, created_at)
      SELECT ?, 'management.bootstrap', ?, ?, 'accepted', ?, ?, ?
      WHERE EXISTS (
        SELECT 1 FROM management_sessions
        WHERE id = ? AND token_sha256 = ? AND status = 'active'
      )`)
      .bind(
        `management-auth-event-${crypto.randomUUID()}`,
        principalId,
        sessionId,
        requestId,
        JSON.stringify({ challengeId: bindings.challengeId }),
        now,
        sessionId,
        tokenSha256,
      ),
  ]);
  if (Number(results[0].meta.changes ?? 0) !== 1 || Number(results[1].meta.changes ?? 0) !== 1) {
    throw new ManagementAuthError("PAIRING_RACE_LOST", "本次配对码已由另一个请求使用", 409);
  }
  return {
    principal: {
      sessionId,
      principalId,
      scopes,
      articleIds,
      objectBoundary,
      absoluteExpiresAt,
      idleExpiresAt,
      csrfToken: await deriveCsrfToken(sessionToken, bindings.csrfHmacKey),
      authBasis: "owner_pairing",
      sourceClientId: null,
    } satisfies ManagementPrincipal,
    sessionToken,
  };
}

export async function enrollManagementBrowserDevice(
  request: Request,
  input: ManagementDeviceEnrollment,
  requestId: string,
) {
  const bindings = requireDeviceRuntime();
  const principal = await requireManagementSession(request, { mutation: true, scope: "management.read" });
  if (principal.authBasis === "site_full_control_key") {
    throw new ManagementAuthError("TRUSTED_DEVICE_FORBIDDEN", "此本机根会话不能登记可信设备", 403);
  }
  const browserBindingSha256 = await browserBindingShaForRequest(request);
  if (!MANAGEMENT_DEVICE_ID_PATTERN.test(input.deviceId)) {
    throw new ManagementAuthError("DEVICE_ID_INVALID", "本机设备标识无效", 400);
  }
  const publicKeyJwk = canonicalPublicJwk(input.publicKeyJwk);
  const publicKeyJwkJson = canonicalPublicJwkText(publicKeyJwk);
  const publicKeySha256 = await sha256Text(publicKeyJwkJson);
  if (
    !/^[a-f0-9]{64}$/u.test(input.publicKeySha256)
    || !constantTimeTextEqual(publicKeySha256, input.publicKeySha256)
    || !constantTimeTextEqual(input.deviceId, `management-device-${publicKeySha256}`)
  ) {
    throw new ManagementAuthError("DEVICE_PUBLIC_KEY_MISMATCH", "本机设备标识与公钥摘要不一致", 400);
  }
  const signingPayload = deviceEnrollmentMessage({
    origin: bindings.canonicalOrigin,
    bootId: bindings.bootId,
    deviceId: input.deviceId,
    publicKeySha256,
    browserBindingSha256,
  });
  if (!await verifyDeviceSignature(publicKeyJwk, signingPayload, input.signature)) {
    throw new ManagementAuthError("DEVICE_SIGNATURE_INVALID", "本机设备没有完成私钥持有证明", 401);
  }

  const db = await ensureManagementAuthSchema();
  const existing = await db.prepare("SELECT * FROM management_browser_devices WHERE id = ? LIMIT 1")
    .bind(input.deviceId).first<D1Row>();
  const linkedSession = await db.prepare("SELECT trusted_device_id FROM management_sessions WHERE id = ? AND status = 'active' LIMIT 1")
    .bind(principal.sessionId).first<D1Row>();
  if (
    existing
    && existing.status === "active"
    && constantTimeTextEqual(String(existing.public_key_sha256), publicKeySha256)
    && constantTimeTextEqual(String(existing.browser_binding_sha256), browserBindingSha256)
    && constantTimeTextEqual(String(linkedSession?.trusted_device_id ?? ""), input.deviceId)
  ) {
    return { deviceId: input.deviceId, publicKeySha256, enrolled: true, reused: true };
  }

  const now = isoNow();
  const eventId = `management-device-enroll-${principal.sessionId}-${publicKeySha256.slice(0, 16)}`;
  const results = await db.batch([
    db.prepare(`INSERT INTO management_browser_devices
      (id, principal_id, public_key_jwk_json, public_key_sha256, browser_binding_sha256,
       status, enrolled_session_id, created_at, updated_at, last_used_at, revoked_at, revoke_reason)
      VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, NULL, NULL, '')
      ON CONFLICT(id) DO UPDATE SET
        principal_id = excluded.principal_id,
        public_key_jwk_json = excluded.public_key_jwk_json,
        browser_binding_sha256 = excluded.browser_binding_sha256,
        status = 'active',
        enrolled_session_id = excluded.enrolled_session_id,
        updated_at = excluded.updated_at,
        revoked_at = NULL,
        revoke_reason = ''
      WHERE management_browser_devices.public_key_sha256 = excluded.public_key_sha256`)
      .bind(
        input.deviceId,
        principal.principalId,
        publicKeyJwkJson,
        publicKeySha256,
        browserBindingSha256,
        principal.sessionId,
        now,
        now,
      ),
    db.prepare(`UPDATE management_sessions SET trusted_device_id = ?
      WHERE id = ? AND status = 'active' AND browser_binding_sha256 = ?`)
      .bind(input.deviceId, principal.sessionId, browserBindingSha256),
    db.prepare(`INSERT OR IGNORE INTO management_auth_events
      (id, event_type, principal_id, session_id, outcome, request_id, details_json, created_at)
      SELECT ?, 'management.device.enroll', ?, ?, 'accepted', ?, ?, ?
      WHERE EXISTS (
        SELECT 1 FROM management_browser_devices
        WHERE id = ? AND public_key_sha256 = ? AND browser_binding_sha256 = ? AND status = 'active'
      ) AND EXISTS (
        SELECT 1 FROM management_sessions WHERE id = ? AND trusted_device_id = ? AND status = 'active'
      )`)
      .bind(
        eventId,
        principal.principalId,
        principal.sessionId,
        requestId,
        JSON.stringify({ bootId: bindings.bootId, deviceId: input.deviceId, publicKeySha256 }),
        now,
        input.deviceId,
        publicKeySha256,
        browserBindingSha256,
        principal.sessionId,
        input.deviceId,
      ),
  ]);
  if (Number(results[0].meta.changes ?? 0) !== 1 || Number(results[1].meta.changes ?? 0) !== 1) {
    throw new ManagementAuthError("DEVICE_ENROLLMENT_CONFLICT", "本机设备登记与当前管理会话发生冲突", 409);
  }
  return { deviceId: input.deviceId, publicKeySha256, enrolled: true, reused: false };
}

export async function beginTrustedManagementSession(request: Request, deviceId: string) {
  const bindings = requireDeviceRuntime();
  assertCanonicalManagementTransport(request, bindings.canonicalOrigin, { mutation: true });
  if (!MANAGEMENT_DEVICE_ID_PATTERN.test(deviceId)) {
    throw new ManagementAuthError("TRUSTED_DEVICE_NOT_AVAILABLE", "当前浏览器还没有可恢复的本机设备凭据", 401);
  }
  const browserBindingSha256 = await browserBindingShaForRequest(request);
  const db = await ensureManagementAuthSchema();
  const now = isoNow();
  const device = await db.prepare(`SELECT id FROM management_browser_devices
    WHERE id = ? AND browser_binding_sha256 = ? AND status = 'active' LIMIT 1`)
    .bind(deviceId, browserBindingSha256).first<D1Row>();
  if (!device) {
    throw new ManagementAuthError("TRUSTED_DEVICE_NOT_AVAILABLE", "当前浏览器还没有可恢复的本机设备凭据", 401);
  }

  const challengeId = `management-device-challenge-${crypto.randomUUID()}`;
  const nonce = randomToken(32);
  const issuedAt = now;
  const expiresAt = new Date(Date.parse(issuedAt) + MANAGEMENT_DEVICE_CHALLENGE_SECONDS * 1000).toISOString();
  const signingPayload = deviceResumeMessage({
    origin: bindings.canonicalOrigin,
    bootId: bindings.bootId,
    challengeId,
    nonce,
    deviceId,
    browserBindingSha256,
  });
  const nonceSha256 = await sha256Text(nonce);
  const payloadSha256 = await sha256Text(signingPayload);
  const results = await db.batch([
    db.prepare(`UPDATE management_device_challenges SET status = 'expired'
      WHERE device_id = ? AND boot_id = ? AND browser_binding_sha256 = ? AND status = 'active'`)
      .bind(deviceId, bindings.bootId, browserBindingSha256),
    db.prepare(`INSERT INTO management_device_challenges
      (id, boot_id, device_id, nonce_sha256, payload_sha256, browser_binding_sha256,
       status, attempts, max_attempts, issued_at, expires_at, created_at)
      SELECT ?, ?, ?, ?, ?, ?, 'active', 0, ?, ?, ?, ?
      WHERE EXISTS (
        SELECT 1 FROM management_browser_devices
        WHERE id = ? AND browser_binding_sha256 = ? AND status = 'active'
      ) AND EXISTS (
        SELECT 1 FROM management_bootstrap_challenges challenge
        WHERE challenge.id = ? AND (
          challenge.status <> 'consumed'
          OR EXISTS (
            SELECT 1 FROM management_sessions session
            WHERE session.id = challenge.consumed_session_id AND session.trusted_device_id = ?
          )
        )
      )`)
      .bind(
        challengeId,
        bindings.bootId,
        deviceId,
        nonceSha256,
        payloadSha256,
        browserBindingSha256,
        MANAGEMENT_DEVICE_MAX_ATTEMPTS,
        issuedAt,
        expiresAt,
        now,
        deviceId,
        browserBindingSha256,
        bindings.challengeId,
        deviceId,
      ),
  ]);
  if (Number(results[1].meta.changes ?? 0) !== 1) {
    throw new ManagementAuthError("TRUSTED_RESUME_RACE_LOST", "本机设备恢复窗口已被另一个请求更新", 409);
  }
  return {
    deviceId,
    challengeId,
    bootId: bindings.bootId,
    nonce,
    issuedAt,
    expiresAt,
    signingPayload,
  };
}

async function rejectDeviceChallenge(db: D1Database, challengeId: string, requestId: string, reason: string) {
  const now = isoNow();
  const results = await db.batch([
    db.prepare(`UPDATE management_device_challenges SET
      attempts = attempts + 1,
      status = CASE WHEN attempts + 1 >= max_attempts THEN 'locked' ELSE status END
      WHERE id = ? AND status = 'active' AND expires_at > ? AND attempts < max_attempts`)
      .bind(challengeId, now),
    eventStatement(db, {
      eventType: "management.device.resume",
      outcome: "rejected",
      requestId,
      details: { challengeId, reason },
    }),
  ]);
  return Number(results[0].meta.changes ?? 0) === 1;
}

export async function completeTrustedManagementSession(
  request: Request,
  input: ManagementDeviceCompletion,
  requestId: string,
) {
  const bindings = requireDeviceRuntime();
  assertCanonicalManagementTransport(request, bindings.canonicalOrigin, { mutation: true });
  if (
    !MANAGEMENT_DEVICE_ID_PATTERN.test(input.deviceId)
    || !MANAGEMENT_DEVICE_CHALLENGE_ID_PATTERN.test(input.challengeId)
    || !BASE64URL_256_PATTERN.test(input.nonce)
    || input.signingPayload.length > 1_024
    || !BASE64URL_P256_SIGNATURE_PATTERN.test(input.signature)
  ) {
    throw new ManagementAuthError("DEVICE_CHALLENGE_INVALID", "本机设备恢复响应格式无效", 400);
  }
  const browserBindingSha256 = await browserBindingShaForRequest(request);
  const db = await ensureManagementAuthSchema();
  const challenge = await db.prepare(`SELECT c.*, d.public_key_jwk_json, d.public_key_sha256, d.principal_id, d.status AS device_status
    FROM management_device_challenges c
    JOIN management_browser_devices d ON d.id = c.device_id
    WHERE c.id = ? AND c.device_id = ? LIMIT 1`)
    .bind(input.challengeId, input.deviceId).first<D1Row>();
  if (!challenge || challenge.device_status !== "active") {
    throw new ManagementAuthError("TRUSTED_DEVICE_NOT_AVAILABLE", "当前浏览器的本机设备凭据不可用", 401);
  }
  const now = isoNow();
  if (challenge.status === "consumed") {
    throw new ManagementAuthError("DEVICE_CHALLENGE_CONSUMED", "本机设备恢复响应已经使用，不能重放", 409);
  }
  if (String(challenge.expires_at) <= now || challenge.status === "expired") {
    await db.prepare("UPDATE management_device_challenges SET status = 'expired' WHERE id = ? AND status = 'active'")
      .bind(input.challengeId).run();
    throw new ManagementAuthError("DEVICE_CHALLENGE_EXPIRED", "本机设备恢复响应已过期，将改用人工配对", 410);
  }
  if (challenge.status === "locked" || Number(challenge.attempts) >= Number(challenge.max_attempts)) {
    throw new ManagementAuthError("DEVICE_CHALLENGE_LOCKED", "本机设备恢复尝试次数已用完，将改用人工配对", 429);
  }
  const expectedPayload = deviceResumeMessage({
    origin: bindings.canonicalOrigin,
    bootId: bindings.bootId,
    challengeId: input.challengeId,
    nonce: input.nonce,
    deviceId: input.deviceId,
    browserBindingSha256,
  });
  const nonceSha256 = await sha256Text(input.nonce);
  const payloadSha256 = await sha256Text(input.signingPayload);
  const payloadMatches = constantTimeTextEqual(expectedPayload, input.signingPayload)
    && constantTimeTextEqual(nonceSha256, String(challenge.nonce_sha256))
    && constantTimeTextEqual(payloadSha256, String(challenge.payload_sha256))
    && constantTimeTextEqual(String(challenge.boot_id), bindings.bootId)
    && constantTimeTextEqual(String(challenge.browser_binding_sha256), browserBindingSha256);
  let publicKeyJwk: ManagementDevicePublicJwk;
  try {
    publicKeyJwk = canonicalPublicJwk(JSON.parse(String(challenge.public_key_jwk_json)) as Record<string, unknown>);
  } catch {
    await rejectDeviceChallenge(db, input.challengeId, requestId, "stored_public_key_invalid");
    throw new ManagementAuthError("TRUSTED_DEVICE_NOT_AVAILABLE", "本机设备公钥记录无效", 401);
  }
  const signatureValid = payloadMatches
    && await verifyDeviceSignature(publicKeyJwk, expectedPayload, input.signature);
  if (!signatureValid) {
    await rejectDeviceChallenge(db, input.challengeId, requestId, "signature_or_payload_mismatch");
    throw new ManagementAuthError("DEVICE_SIGNATURE_INVALID", "本机设备签名或恢复上下文不匹配", 401);
  }

  const sessionId = `management-session-${crypto.randomUUID()}`;
  const sessionToken = `wenmai_management_${randomToken(32)}`;
  const tokenSha256 = await sha256Text(sessionToken);
  const principalId = String(challenge.principal_id);
  const scopes = [...MANAGEMENT_SCOPES];
  const articleIds = ["*"];
  const objectBoundary = { articles: ["*"], localOwner: true, authBasis: "trusted-device", trustedDeviceId: input.deviceId };
  const absoluteExpiresAt = isoAfter(MANAGEMENT_SESSION_ABSOLUTE_SECONDS);
  const idleExpiresAt = isoAfter(MANAGEMENT_SESSION_IDLE_SECONDS);
  const results = await db.batch([
    db.prepare(`UPDATE management_device_challenges SET
      status = 'consumed', consumed_at = ?, consumed_session_id = ?
      WHERE id = ? AND device_id = ? AND boot_id = ? AND nonce_sha256 = ? AND payload_sha256 = ?
        AND browser_binding_sha256 = ? AND status = 'active' AND expires_at > ? AND attempts < max_attempts
        AND EXISTS (
          SELECT 1 FROM management_bootstrap_challenges challenge
          WHERE challenge.id = ? AND (
            challenge.status <> 'consumed'
            OR EXISTS (
              SELECT 1 FROM management_sessions session
              WHERE session.id = challenge.consumed_session_id AND session.trusted_device_id = ?
            )
          )
        )`)
      .bind(
        now,
        sessionId,
        input.challengeId,
        input.deviceId,
        bindings.bootId,
        nonceSha256,
        payloadSha256,
        browserBindingSha256,
        now,
        bindings.challengeId,
        input.deviceId,
      ),
    db.prepare(`UPDATE management_bootstrap_challenges SET
      status = 'consumed', consumed_at = ?, consumed_session_id = ?
      WHERE id = ? AND status <> 'consumed'
        AND EXISTS (
          SELECT 1 FROM management_device_challenges
          WHERE id = ? AND status = 'consumed' AND consumed_session_id = ? AND consumed_at = ?
        )`)
      .bind(now, sessionId, bindings.challengeId, input.challengeId, sessionId, now),
    db.prepare(`INSERT INTO management_sessions
      (id, principal_id, token_sha256, browser_binding_sha256, trusted_device_id,
       auth_basis, authority_class, scopes_json, article_ids_json, object_boundary_json, status,
       absolute_expires_at, idle_expires_at, last_seen_at, created_at)
      SELECT ?, ?, ?, ?, ?, 'trusted_device', 'owner', ?, ?, ?, 'active', ?, ?, ?, ?
      WHERE EXISTS (
        SELECT 1 FROM management_device_challenges
        WHERE id = ? AND status = 'consumed' AND consumed_session_id = ? AND consumed_at = ?
      ) AND EXISTS (
        SELECT 1 FROM management_bootstrap_challenges challenge
        WHERE challenge.id = ? AND challenge.status = 'consumed' AND (
          (challenge.consumed_session_id = ? AND challenge.consumed_at = ?)
          OR EXISTS (
            SELECT 1 FROM management_sessions prior_session
            WHERE prior_session.id = challenge.consumed_session_id
              AND prior_session.trusted_device_id = ?
          )
        )
      ) AND EXISTS (
        SELECT 1 FROM management_browser_devices
        WHERE id = ? AND browser_binding_sha256 = ? AND status = 'active'
      )`)
      .bind(
        sessionId,
        principalId,
        tokenSha256,
        browserBindingSha256,
        input.deviceId,
        JSON.stringify(scopes),
        JSON.stringify(articleIds),
        JSON.stringify(objectBoundary),
        absoluteExpiresAt,
        idleExpiresAt,
        now,
        now,
        input.challengeId,
        sessionId,
        now,
        bindings.challengeId,
        sessionId,
        now,
        input.deviceId,
        input.deviceId,
        browserBindingSha256,
      ),
    db.prepare(`UPDATE management_browser_devices SET last_used_at = ?, updated_at = ?
      WHERE id = ? AND status = 'active' AND EXISTS (
        SELECT 1 FROM management_sessions WHERE id = ? AND trusted_device_id = ? AND status = 'active'
      )`)
      .bind(now, now, input.deviceId, sessionId, input.deviceId),
    db.prepare(`INSERT INTO management_auth_events
      (id, event_type, principal_id, session_id, outcome, request_id, details_json, created_at)
      SELECT ?, 'management.device.resume', ?, ?, 'accepted', ?, ?, ?
      WHERE EXISTS (
        SELECT 1 FROM management_sessions WHERE id = ? AND token_sha256 = ? AND status = 'active'
      )`)
      .bind(
        `management-auth-event-${crypto.randomUUID()}`,
        principalId,
        sessionId,
        requestId,
        JSON.stringify({ bootId: bindings.bootId, challengeId: input.challengeId, deviceId: input.deviceId }),
        now,
        sessionId,
        tokenSha256,
      ),
  ]);
  if (
    Number(results[0].meta.changes ?? 0) !== 1
    || Number(results[2].meta.changes ?? 0) !== 1
  ) {
    throw new ManagementAuthError("DEVICE_CHALLENGE_RACE_LOST", "本机设备恢复已由另一个请求完成或被人工配对取代", 409);
  }
  return {
    principal: {
      sessionId,
      principalId,
      scopes,
      articleIds,
      objectBoundary,
      absoluteExpiresAt,
      idleExpiresAt,
      csrfToken: await deriveCsrfToken(sessionToken, bindings.csrfHmacKey),
      authBasis: "trusted_device",
      sourceClientId: null,
    } satisfies ManagementPrincipal,
    sessionToken,
  };
}

async function sessionRowForRequest(request: Request) {
  const sessionToken = parseCookieHeader(request.headers.get("cookie")).get(MANAGEMENT_SESSION_COOKIE) ?? "";
  if (!sessionToken || sessionToken.length > 512) {
    throw new ManagementAuthError("MANAGEMENT_AUTH_REQUIRED", "需要先完成本机管理配对", 401);
  }
  const tokenSha256 = await sha256Text(sessionToken);
  const db = await ensureManagementAuthSchema();
  const row = await db.prepare("SELECT * FROM management_sessions WHERE token_sha256 = ? LIMIT 1")
    .bind(tokenSha256).first<D1Row>();
  if (!row || row.status !== "active") {
    throw new ManagementAuthError("MANAGEMENT_SESSION_INVALID", "管理会话无效或已经撤销", 401);
  }
  const now = isoNow();
  if (String(row.absolute_expires_at) <= now || String(row.idle_expires_at) <= now) {
    await db.prepare("UPDATE management_sessions SET status = 'expired' WHERE id = ? AND status = 'active'")
      .bind(row.id).run();
    throw new ManagementAuthError("MANAGEMENT_SESSION_EXPIRED", "管理会话已经过期，请重新配对", 401);
  }
  const browserBinding = request.headers.get(MANAGEMENT_BROWSER_BINDING_HEADER) ?? "";
  if (!MANAGEMENT_BROWSER_BINDING_PATTERN.test(browserBinding)) {
    throw new ManagementAuthError("MANAGEMENT_BROWSER_BINDING_REQUIRED", "管理会话缺少当前文脉端口的浏览器绑定", 401);
  }
  const browserBindingSha256 = await sha256Text(browserBinding);
  if (!constantTimeTextEqual(browserBindingSha256, String(row.browser_binding_sha256 ?? ""))) {
    throw new ManagementAuthError("MANAGEMENT_BROWSER_BINDING_INVALID", "管理会话不属于当前文脉浏览器端口", 401);
  }
  const rootLikeSession = row.auth_basis === "site_full_control_key"
    || row.authority_class === "site_management"
    || row.source_client_id != null
    || row.source_key_expires_at != null
    || row.source_exchange_generation != null
    || row.source_permission_snapshot_sha256 != null
    || String(row.principal_id ?? "").startsWith("agent-client:");
  if (rootLikeSession) {
    try {
      const source = await verifyActiveSiteFullControlSessionSource(db, {
        sourceClientId: String(row.source_client_id ?? ""),
        sourcePermissionSnapshotSha256: String(row.source_permission_snapshot_sha256 ?? ""),
        sourceExchangeGeneration: Number(row.source_exchange_generation),
      });
      const sourceClientId = source.id;
      const expectedScopes = source.managementScopes;
      const expectedObjectBoundary = { articles: ["*"], allArticles: true, includesFutureArticles: true, authBasis: "site_full_control_key", sourceClientId };
      const sessionScopes = parseJson<unknown>(row.scopes_json, null);
      const sessionArticleIds = parseJson<unknown>(row.article_ids_json, null);
      const sessionObjectBoundary = parseJson<unknown>(row.object_boundary_json, null);
      if (row.authority_class !== "site_management"
        || row.principal_id !== `agent-client:${sourceClientId}`
        || row.trusted_device_id !== null
        || row.source_client_id !== sourceClientId
        || row.source_key_expires_at !== source.expiresAt
        || String(row.absolute_expires_at) > source.expiresAt
        || String(row.idle_expires_at) > String(row.absolute_expires_at)
        || JSON.stringify(sessionScopes) !== JSON.stringify(expectedScopes)
        || JSON.stringify(sessionArticleIds) !== '["*"]'
        || JSON.stringify(sessionObjectBoundary) !== JSON.stringify(expectedObjectBoundary)) {
        throw new Error("site_full_control session projection mismatch");
      }
    } catch {
      await db.prepare("UPDATE management_sessions SET status = 'revoked', revoked_at = ?, revoke_reason = 'source_key_invalid' WHERE id = ? AND status = 'active'")
        .bind(isoNow(), row.id).run();
      throw new ManagementAuthError("MANAGEMENT_SESSION_INVALID", "管理会话无效或已经撤销", 401);
    }
  }
  return { db, row, sessionToken, now };
}

export async function exchangeSiteFullControlManagementSession(request: Request, body: Record<string, unknown>, requestId: string) {
  const bindings = runtimeBindings();
  if (!bindings.csrfHmacKey) throw new ManagementAuthError("AUTH_RUNTIME_UNAVAILABLE", "管理会话的本机运行密钥不可用", 503);
  return exchangeSiteFullControlKey({ request, body, requestId, db: await ensureManagementAuthSchema(), csrfHmacKey: bindings.csrfHmacKey, canonicalOrigin: bindings.canonicalOrigin });
}

export { revokeDerivedSiteFullControlSessions };

export async function requireManagementSession(
  request: Request,
  options: { mutation?: boolean; scope?: ManagementScope; articleId?: string } = {},
) {
  const bindings = runtimeBindings();
  // Direct v5 Bearer is deliberately a separate machine-only mode.  It is
  // never mixed with browser session cookies or CSRF credentials.
  if (request.headers.has("authorization")) {
    const key = await verifyDirectSiteFullControlKey({ request, db: database(), canonicalOrigin: bindings.canonicalOrigin });
    if (!options.scope || !key.managementScopes.includes(options.scope)) {
      throw new ManagementAuthError("MANAGEMENT_SCOPE_DENIED", "网站根 Key 未获签发当前管理 scope", 403);
    }
    return {
      sessionId: `direct:${key.id}`, principalId: `agent-client:${key.id}`, scopes: [...key.managementScopes], articleIds: ["*"],
      objectBoundary: { articles: ["*"], allArticles: true, includesFutureArticles: true, sourceClientId: key.id },
      absoluteExpiresAt: key.expiresAt, idleExpiresAt: key.expiresAt, csrfToken: "", authBasis: "site_full_control_key", sourceClientId: key.id,
    } satisfies ManagementPrincipal;
  }
  assertCanonicalManagementTransport(request, bindings.canonicalOrigin, { mutation: options.mutation });
  const { db, row, sessionToken, now } = await sessionRowForRequest(request);
  const scopes = parseJson<string[]>(row.scopes_json, []);
  const articleIds = parseJson<string[]>(row.article_ids_json, []);
  if (options.scope && !scopes.includes(options.scope)) {
    throw new ManagementAuthError("MANAGEMENT_SCOPE_DENIED", `管理会话缺少 ${options.scope} 权限`, 403);
  }
  if (options.articleId && !articleIds.includes("*") && !articleIds.includes(options.articleId)) {
    throw new ManagementAuthError("MANAGEMENT_OBJECT_DENIED", "管理会话不包含当前文章对象", 403);
  }
  const csrfToken = await deriveCsrfToken(sessionToken, bindings.csrfHmacKey);
  if (options.mutation) {
    const suppliedCsrf = request.headers.get("x-wenmai-csrf") ?? "";
    if (!suppliedCsrf || !constantTimeTextEqual(suppliedCsrf, csrfToken)) {
      throw new ManagementAuthError("CSRF_TOKEN_INVALID", "管理写入缺少当前会话的 CSRF 凭据", 403);
    }
  }
  const absoluteExpiryMs = Date.parse(String(row.absolute_expires_at));
  const sourceExpiryMs = row.auth_basis === "site_full_control_key"
    ? Date.parse(String(row.source_key_expires_at ?? ""))
    : Number.POSITIVE_INFINITY;
  const idleExpiresAt = new Date(Math.min(
    Date.now() + MANAGEMENT_SESSION_IDLE_SECONDS * 1000,
    absoluteExpiryMs,
    Number.isFinite(sourceExpiryMs) ? sourceExpiryMs : Number.POSITIVE_INFINITY,
  )).toISOString();
  const refreshed = await db.prepare(`UPDATE management_sessions SET last_seen_at = ?, idle_expires_at = ?
    WHERE id = ? AND status = 'active' AND absolute_expires_at > ? AND idle_expires_at > ?`)
    .bind(now, idleExpiresAt, row.id, now, now).run();
  if (Number(refreshed.meta.changes ?? 0) !== 1) {
    throw new ManagementAuthError("MANAGEMENT_SESSION_INVALID", "管理会话已经结束或在本次请求期间失效", 401);
  }
  return {
    sessionId: String(row.id),
    principalId: String(row.principal_id),
    scopes,
    articleIds,
    objectBoundary: parseJson<Record<string, unknown>>(row.object_boundary_json, {}),
    absoluteExpiresAt: String(row.absolute_expires_at),
    idleExpiresAt,
    csrfToken,
    authBasis: String(row.auth_basis ?? "owner_pairing"),
    sourceClientId: typeof row.source_client_id === "string" ? row.source_client_id : null,
  } satisfies ManagementPrincipal;
}

export async function optionalManagementSession(request: Request) {
  try {
    return await requireManagementSession(request, { scope: "management.read" });
  } catch (error) {
    if (error instanceof ManagementAuthError && error.code === "MANAGEMENT_AUTH_REQUIRED") return null;
    throw error;
  }
}

export async function revokeCurrentManagementSession(request: Request, requestId: string, reason = "user_logout") {
  const principal = await requireManagementSession(request, { mutation: true, scope: "management.read" });
  const db = database();
  const now = isoNow();
  const results = await db.batch([
    db.prepare(`UPDATE management_sessions SET status = 'revoked', revoked_at = ?, revoke_reason = ?
      WHERE id = ? AND status = 'active'`)
      .bind(now, reason, principal.sessionId),
    db.prepare(`UPDATE management_browser_devices SET
      status = 'revoked', revoked_at = ?, revoke_reason = ?, updated_at = ?
      WHERE id = (
        SELECT trusted_device_id FROM management_sessions WHERE id = ? LIMIT 1
      ) AND status = 'active'`)
      .bind(now, reason, now, principal.sessionId),
    db.prepare(`UPDATE management_device_challenges SET status = 'expired'
      WHERE device_id = (
        SELECT trusted_device_id FROM management_sessions WHERE id = ? LIMIT 1
      ) AND status = 'active'`)
      .bind(principal.sessionId),
    eventStatement(db, {
      eventType: "management.logout",
      outcome: "revoked",
      requestId,
      principalId: principal.principalId,
      sessionId: principal.sessionId,
      details: { reason },
    }),
  ]);
  if (Number(results[0].meta.changes ?? 0) !== 1) {
    throw new ManagementAuthError("MANAGEMENT_SESSION_INVALID", "管理会话已经结束", 401);
  }
  return principal;
}

export function managementActorId(principal: ManagementPrincipal) {
  return `management-session:${principal.sessionId}`;
}
