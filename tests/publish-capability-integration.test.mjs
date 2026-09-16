import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test from "node:test";

import { Miniflare, NoOpLog, Request as MiniflareRequest } from "miniflare";

import { ADMINISTRATOR_SCOPES, SUPER_ADMIN_SCOPES } from "../app/agent-role-contract.ts";
import {
  PUBLISH_BATCH_CONFIRMATION_SCHEMA_VERSION,
} from "../app/publish-capability-core.ts";
import {
  EXECUTION_PACKET_SCHEMA_VERSION,
  MANDATORY_STOP_CONDITIONS,
  canonicalExecutionJson,
  createFrozenExecutionPacket,
  sha256ExecutionText,
} from "../app/release-execution-contract.ts";

const projectRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const serverPath = path.join(projectRoot, "dist", "server");
const staticPath = path.join(serverPath, "_next", "static");
const canonicalOrigin = "http://[::1]:3000";

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function request(pathname, init = {}) {
  const headers = new Headers(init.headers);
  headers.set("host", "[::1]:3000");
  if (!headers.has("x-forwarded-host")) headers.set("x-forwarded-host", "[::1]:3000");
  return new MiniflareRequest(`${canonicalOrigin}${pathname}`, {
    redirect: "manual",
    ...init,
    headers,
  });
}

async function json(response) {
  const payload = await response.json();
  return { response, payload };
}

let compiledModulesPromise;
async function compiledRouteModules() {
  if (compiledModulesPromise) return compiledModulesPromise;
  compiledModulesPromise = (async () => {
    const names = (await readdir(staticPath)).filter((name) => name.endsWith(".js"));
    const sources = await Promise.all(names.map(async (name) => ({
      name,
      contents: await readFile(path.join(staticPath, name), "utf8"),
    })));
    const route = (marker) => {
      const match = sources.find((source) => source.name.startsWith("route-") && source.contents.includes(marker));
      assert.ok(match, `没有在 production build 中找到 ${marker} 路由`);
      return `./${match.name}`;
    };
    const authRoute = route("PAIRING_CODE_REQUIRED");
    const capabilityRoute = route("PUBLISH_CAPABILITY_RUNTIME_UNAVAILABLE");
    const entry = `
      import * as auth from ${JSON.stringify(authRoute)};
      import * as capability from ${JSON.stringify(capabilityRoute)};
      export default {
        async fetch(request) {
          const pathname = new URL(request.url).pathname;
          const route = pathname === "/api/auth" ? auth
            : pathname === "/api/publish-capability/v1" ? capability
              : null;
          const handler = route?.[request.method];
          const headers = new Headers(request.headers);
          headers.set("host", "[::1]:3000");
          const routeRequest = new Request(request, { headers });
          return handler ? handler(routeRequest) : new Response("not found", { status: 404 });
        }
      };
    `;
    return [
      { type: "ESModule", path: "publish-capability-test-worker.mjs", contents: entry },
      ...sources.map((source) => ({ type: "ESModule", path: source.name, contents: source.contents })),
    ];
  })();
  return compiledModulesPromise;
}

async function createHarness({ includeHmac = true } = {}) {
  const pairingSelector = randomBytes(16).toString("base64url");
  const pairingSecret = randomBytes(16).toString("base64url");
  const pairingCode = `wenmai1.${pairingSelector}.${pairingSecret}`;
  const browserBinding = randomBytes(32).toString("base64url");
  const publishHmacSecret = includeHmac ? randomBytes(32).toString("base64url") : "";
  const createdAt = new Date();
  const expiresAt = new Date(createdAt.getTime() + 5 * 60_000);
  const mf = new Miniflare({
    modules: await compiledRouteModules(),
    compatibilityDate: "2026-05-15",
    compatibilityFlags: ["nodejs_compat"],
    publicUrl: canonicalOrigin,
    d1Databases: { DB: `publish-capability-test-${randomUUID()}` },
    bindings: {
      WENMAI_AUTH_CANONICAL_ORIGIN: canonicalOrigin,
      WENMAI_AUTH_BOOT_ID: `management-boot-${randomBytes(16).toString("base64url")}`,
      WENMAI_AUTH_CHALLENGE_ID: `management-challenge-${pairingSelector}`,
      WENMAI_AUTH_PAIRING_SHA256: sha256(pairingCode),
      WENMAI_AUTH_CHALLENGE_CREATED_AT: createdAt.toISOString(),
      WENMAI_AUTH_CHALLENGE_EXPIRES_AT: expiresAt.toISOString(),
      WENMAI_AUTH_CSRF_HMAC_KEY: randomBytes(32).toString("base64url"),
      ...(includeHmac ? { WENMAI_PUBLISH_CAPABILITY_HMAC_KEY: publishHmacSecret } : {}),
    },
    log: new NoOpLog(),
  });
  return { mf, pairingCode, browserBinding, browserBindingSha256: sha256(browserBinding), publishHmacSecret };
}

async function bootstrap(harness) {
  const initialized = await json(await harness.mf.dispatchFetch(request("/api/auth")));
  assert.equal(initialized.response.status, 200, JSON.stringify(initialized.payload));
  const paired = await json(await harness.mf.dispatchFetch(request("/api/auth", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: canonicalOrigin,
      "sec-fetch-site": "same-origin",
      "X-Wenmai-Browser-Binding": harness.browserBinding,
    },
    body: JSON.stringify({
      action: "bootstrap",
      pairingCode: harness.pairingCode,
      browserBindingSha256: harness.browserBindingSha256,
    }),
  })));
  assert.equal(paired.response.status, 201, JSON.stringify(paired.payload));
  return {
    cookie: (paired.response.headers.get("set-cookie") ?? "").split(";", 1)[0],
    csrf: paired.payload.data.csrfToken,
  };
}

async function executionPacket(suffix) {
  return createFrozenExecutionPacket({
    schemaVersion: EXECUTION_PACKET_SCHEMA_VERSION,
    executor: { role: "browser_mechanical_executor", agentProfileId: "wenmai_publish_operator" },
    runId: `publish-run-${suffix}`,
    articleId: "article-publish-capability-test",
    attempt: 1,
    commandId: `packet-command-${suffix}`,
    contract: { revision: 7, sha256: sha256(`contract-${suffix}`) },
    platform: "bilibili",
    releaseId: `release-${suffix}`,
    buildId: `build-${suffix}`,
    artifact: {
      path: `E:\\release-artifacts\\${suffix}.docx`,
      sha256: await sha256ExecutionText(`artifact-${suffix}`),
    },
    targetAccount: "owner-account",
    allowedHosts: ["member.bilibili.com"],
    allowedPathPrefixes: ["/platform/upload/text/edit"],
    phase: "publish_once",
    allowedActions: [
      "verify_bound_context",
      "verify_final_state",
      "click_publish_once",
      "observe_submission_result",
      "capture_evidence",
    ],
    stopConditions: [...MANDATORY_STOP_CONDITIONS],
    createdAt: new Date().toISOString(),
  });
}

function confirmation(packet, overrides = {}) {
  return {
    schemaVersion: PUBLISH_BATCH_CONFIRMATION_SCHEMA_VERSION,
    decision: "publish_once_confirmed",
    confirmedAt: new Date().toISOString(),
    executionPacketSha256: packet.packetSha256,
    runId: packet.runId,
    articleId: packet.articleId,
    attempt: packet.attempt,
    packetCommandId: packet.commandId,
    platform: packet.platform,
    releaseId: packet.releaseId,
    buildId: packet.buildId,
    artifactSha256: packet.artifact.sha256,
    targetAccount: packet.targetAccount,
    maxClicks: 1,
    ...overrides,
  };
}

async function issue(harness, session, packet, commandId, options = {}) {
  const body = {
    action: "issue",
    commandId,
    payload: {
      executionPacket: packet,
      confirmation: options.confirmation ?? confirmation(packet, options.confirmationOverrides),
      expiresAt: options.expiresAt ?? new Date(Date.now() + 5 * 60_000).toISOString(),
    },
  };
  return json(await harness.mf.dispatchFetch(request("/api/publish-capability/v1", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: session.cookie,
      origin: canonicalOrigin,
      "sec-fetch-site": "same-origin",
      "X-Wenmai-Browser-Binding": harness.browserBinding,
      "X-Wenmai-CSRF": session.csrf,
      "X-Wenmai-Write": "1",
      ...(options.authorization ? { authorization: options.authorization } : {}),
    },
    body: JSON.stringify(body),
  })));
}

async function consume(harness, token, capabilityId, commandId, extraHeaders = {}) {
  return json(await harness.mf.dispatchFetch(request("/api/publish-capability/v1", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
      "sec-fetch-site": "none",
      ...extraHeaders,
    },
    body: JSON.stringify({ action: "consume", commandId, payload: { capabilityId } }),
  })));
}

function agentToken() {
  return `wenmai_agent_${randomBytes(16).toString("hex")}_${randomBytes(16).toString("hex")}`;
}

async function seedPrivilegedClients(db, articleIds = ["article-publish-capability-test"], actionIds = ["publish-capability.v1.consume"], clientSuffix = "default") {
  await db.prepare(`CREATE TABLE IF NOT EXISTS agent_clients (
    id TEXT PRIMARY KEY NOT NULL,
    label TEXT NOT NULL,
    client_kind TEXT NOT NULL DEFAULT 'codex',
    role TEXT NOT NULL DEFAULT 'agent',
    token_sha256 TEXT NOT NULL UNIQUE,
    scopes_json TEXT NOT NULL DEFAULT '[]',
    article_ids_json TEXT NOT NULL DEFAULT '[]',
    task_ids_json TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'active',
    expires_at TEXT NOT NULL,
    last_seen_at TEXT,
    created_at TEXT NOT NULL,
    revoked_at TEXT
  )`).run();
  const superToken = agentToken();
  const administratorToken = agentToken();
  const expiresAt = new Date(Date.now() + 60 * 60_000).toISOString();
  const createdAt = new Date().toISOString();
  const scopes = [...SUPER_ADMIN_SCOPES].sort();
  const exactArticleIds = [...articleIds].sort();
  const exactActionIds = [...actionIds].sort();
  const snapshot = {
    schemaVersion: 3,
    catalogVersion: "test-catalog-v3",
    catalogSha256: sha256("test-catalog-v3"),
    presetId: "test-publish-capability",
    role: "super_admin",
    scopes,
    actionIds: exactActionIds,
    objectBoundary: { schemaVersion: "wenmai.agent-object-boundary/article-set-v1", articleIds: exactArticleIds, wildcard: false },
    taskIds: [],
    issuedAt: createdAt,
    expiresAt,
  };
  const snapshotJson = canonicalExecutionJson(snapshot);
  const snapshotSha256 = sha256(snapshotJson);
  await db.prepare(`CREATE TABLE IF NOT EXISTS agent_client_permission_snapshots (
    client_id TEXT PRIMARY KEY NOT NULL,
    schema_version INTEGER NOT NULL,
    catalog_version TEXT NOT NULL,
    preset_id TEXT NOT NULL,
    role TEXT NOT NULL,
    scopes_json TEXT NOT NULL,
    action_ids_json TEXT NOT NULL,
    article_ids_json TEXT NOT NULL,
    task_ids_json TEXT NOT NULL,
    snapshot_json TEXT NOT NULL,
    snapshot_sha256 TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`).run();
  await db.batch([
    db.prepare(`INSERT INTO agent_clients
      (id, label, role, token_sha256, scopes_json, article_ids_json, task_ids_json, status, expires_at, created_at)
      VALUES (?, 'test super admin', 'super_admin', ?, ?, ?, '[]', 'active', ?, ?)`)
      .bind(`agent-super-admin-test-${clientSuffix}`, sha256(superToken), JSON.stringify(scopes), JSON.stringify(exactArticleIds), expiresAt, createdAt),
    db.prepare(`INSERT INTO agent_clients
      (id, label, role, token_sha256, scopes_json, article_ids_json, task_ids_json, status, expires_at, created_at)
      VALUES (?, 'test administrator', 'administrator', ?, ?, '["*"]', '[]', 'active', ?, ?)`)
      .bind(`agent-administrator-test-${clientSuffix}`, sha256(administratorToken), JSON.stringify(ADMINISTRATOR_SCOPES), expiresAt, createdAt),
    db.prepare(`INSERT INTO agent_client_permission_snapshots
      (client_id, schema_version, catalog_version, preset_id, role, scopes_json, action_ids_json,
       article_ids_json, task_ids_json, snapshot_json, snapshot_sha256, created_at)
      VALUES (?, 3, ?, ?, 'super_admin', ?, ?, ?, '[]', ?, ?, ?)`)
      .bind(`agent-super-admin-test-${clientSuffix}`, snapshot.catalogVersion, snapshot.presetId, JSON.stringify(scopes), JSON.stringify(exactActionIds), JSON.stringify(exactArticleIds), snapshotJson, snapshotSha256, createdAt),
  ]);
  return { superToken, administratorToken };
}

test("真实 D1 路由：owner 签发、严格绑定、过期、角色/传输拒绝与并发单消费", async (context) => {
  const harness = await createHarness();
  context.after(() => harness.mf.dispose());
  const session = await bootstrap(harness);
  const db = await harness.mf.getD1Database("DB");
  const { superToken, administratorToken } = await seedPrivilegedClients(db);

  const issuedPacket = await executionPacket("issued");
  const issuedConfirmation = confirmation(issuedPacket);
  const issuedExpiresAt = new Date(Date.now() + 5 * 60_000).toISOString();
  const issued = await issue(harness, session, issuedPacket, "issue-command-issued", {
    confirmation: issuedConfirmation,
    expiresAt: issuedExpiresAt,
  });
  assert.equal(issued.response.status, 201, JSON.stringify(issued.payload));
  assert.equal(issued.payload.data.state, "issued");
  assert.equal(issued.payload.data.handling.agentInput, "capabilityId_only");
  assert.equal(issued.payload.data.ticket, undefined);
  assert.equal(issued.payload.data.executionPacket, undefined);
  assert.equal(issued.payload.data.nonce, undefined);
  assert.equal(issued.payload.data.receipt.replayed, false);

  const issuedReplay = await issue(harness, session, issuedPacket, "issue-command-issued", {
    confirmation: issuedConfirmation,
    expiresAt: issuedExpiresAt,
  });
  assert.equal(issuedReplay.response.status, 201, JSON.stringify(issuedReplay.payload));
  assert.equal(issuedReplay.payload.data.capabilityId, issued.payload.data.capabilityId);
  assert.equal(issuedReplay.payload.data.receipt.replayed, true);
  assert.equal(issuedReplay.response.headers.get("x-wenmai-command-replayed"), "1");

  const stored = await db.prepare("SELECT * FROM publish_capabilities WHERE id = ?")
    .bind(issued.payload.data.capabilityId).first();
  assert.equal(stored.execution_packet_sha256, issuedPacket.packetSha256);
  assert.equal(stored.article_id, issuedPacket.articleId);
  assert.equal(JSON.parse(stored.packet_json).artifact.path, issuedPacket.artifact.path);
  assert.equal(JSON.parse(stored.ticket_json).claims.articleId, issuedPacket.articleId);
  assert.equal(JSON.parse(stored.ticket_json).claims.nonce.length >= 32, true);
  assert.match(stored.nonce_sha256, /^[a-f0-9]{64}$/u);
  assert.equal(String(stored.ticket_json).includes(harness.publishHmacSecret), false);

  const mismatchPacket = await executionPacket("confirm-mismatch");
  const confirmationMismatch = await issue(harness, session, mismatchPacket, "issue-command-confirm-mismatch", {
    confirmationOverrides: { artifactSha256: "f".repeat(64) },
  });
  assert.equal(confirmationMismatch.response.status, 422);
  assert.equal(confirmationMismatch.payload.error.code, "PUBLISH_CONFIRMATION_INVALID");

  const articleDriftConfirmation = await issue(harness, session, await executionPacket("article-confirm-mismatch"), "issue-command-article-confirm-mismatch", {
    confirmationOverrides: { articleId: "article-other" },
  });
  assert.equal(articleDriftConfirmation.response.status, 422);
  assert.equal(articleDriftConfirmation.payload.error.code, "PUBLISH_CONFIRMATION_INVALID");

  const missingArticlePacket = { ...await executionPacket("missing-article") };
  delete missingArticlePacket.articleId;
  delete missingArticlePacket.packetSha256;
  missingArticlePacket.packetSha256 = await sha256ExecutionText(canonicalExecutionJson(missingArticlePacket));
  const missingArticleIssue = await issue(harness, session, missingArticlePacket, "issue-command-missing-article");
  assert.equal(missingArticleIssue.response.status, 422);
  assert.equal(missingArticleIssue.payload.error.code, "PUBLISH_PACKET_INVALID");
  assert.ok(missingArticleIssue.payload.error.details.errors.some((error) => error.includes("articleId")));

  const roleDenied = await consume(
    harness,
    administratorToken,
    issued.payload.data.capabilityId,
    "consume-command-administrator-denied",
  );
  assert.equal(roleDenied.response.status, 403);
  assert.equal(roleDenied.payload.error.code, "PRIVILEGED_ROLE_DENIED");

  const tailscaleDenied = await consume(
    harness,
    superToken,
    issued.payload.data.capabilityId,
    "consume-command-tailscale-denied",
    { "x-wenmai-agent-transport": "tailscale-gateway" },
  );
  assert.equal(tailscaleDenied.response.status, 421);
  assert.equal(tailscaleDenied.payload.error.code, "PRIVILEGED_TRANSPORT_REQUIRED");

  const mixedDenied = await consume(
    harness,
    superToken,
    issued.payload.data.capabilityId,
    "consume-command-mixed-denied",
    { cookie: session.cookie },
  );
  assert.equal(mixedDenied.response.status, 403);
  assert.equal(mixedDenied.payload.error.code, "AMBIGUOUS_AUTH_FORBIDDEN");

  const browserDenied = await consume(
    harness,
    superToken,
    issued.payload.data.capabilityId,
    "consume-command-browser-denied",
    { origin: canonicalOrigin, "sec-fetch-site": "same-origin" },
  );
  assert.equal(browserDenied.response.status, 403);
  assert.equal(browserDenied.payload.error.code, "BROWSER_REQUEST_FORBIDDEN");

  const { superToken: wrongArticleToken } = await seedPrivilegedClients(db, ["article-other"], ["publish-capability.v1.consume"], "wrong-article");
  const wrongArticleKey = await consume(harness, wrongArticleToken, issued.payload.data.capabilityId, "consume-command-article-boundary");
  assert.equal(wrongArticleKey.response.status, 403);
  assert.equal(wrongArticleKey.payload.error.code, "PRIVILEGED_OBJECT_DENIED");

  const { superToken: noActionToken } = await seedPrivilegedClients(db, [issuedPacket.articleId], [], "missing-action");
  const noActionKey = await consume(harness, noActionToken, issued.payload.data.capabilityId, "consume-command-action-snapshot");
  assert.equal(noActionKey.response.status, 403);
  assert.equal(noActionKey.payload.error.code, "PRIVILEGED_ACTION_DENIED");

  const tamperedPacket = await executionPacket("stored-mismatch");
  const tamperedIssue = await issue(harness, session, tamperedPacket, "issue-command-stored-mismatch");
  assert.equal(tamperedIssue.response.status, 201, JSON.stringify(tamperedIssue.payload));
  await db.prepare("UPDATE publish_capabilities SET target_account = 'tampered-account' WHERE id = ?")
    .bind(tamperedIssue.payload.data.capabilityId).run();
  const storedMismatch = await consume(
    harness,
    superToken,
    tamperedIssue.payload.data.capabilityId,
    "consume-command-stored-mismatch",
  );
  assert.equal(storedMismatch.response.status, 409, JSON.stringify(storedMismatch.payload));
  assert.equal(storedMismatch.payload.error.code, "PUBLISH_CAPABILITY_STORAGE_MISMATCH");

  const legacyPacket = await executionPacket("legacy-row");
  const legacyIssue = await issue(harness, session, legacyPacket, "issue-command-legacy-row");
  assert.equal(legacyIssue.response.status, 201, JSON.stringify(legacyIssue.payload));
  await db.prepare("UPDATE publish_capabilities SET article_id = NULL WHERE id = ?")
    .bind(legacyIssue.payload.data.capabilityId).run();
  const legacyConsume = await consume(harness, superToken, legacyIssue.payload.data.capabilityId, "consume-command-legacy-row");
  assert.equal(legacyConsume.response.status, 403);
  assert.equal(legacyConsume.payload.error.code, "PRIVILEGED_OBJECT_DENIED");

  const expiryPacket = await executionPacket("expiry");
  const expiring = await issue(harness, session, expiryPacket, "issue-command-expiry", {
    expiresAt: new Date(Date.now() + 1_500).toISOString(),
  });
  assert.equal(expiring.response.status, 201, JSON.stringify(expiring.payload));
  await new Promise((resolve) => setTimeout(resolve, 1_700));
  const expired = await consume(harness, superToken, expiring.payload.data.capabilityId, "consume-command-expired");
  assert.equal(expired.response.status, 410);
  assert.equal(expired.payload.error.code, "PUBLISH_CAPABILITY_EXPIRED");

  const concurrentPacket = await executionPacket("concurrent");
  const concurrentIssue = await issue(harness, session, concurrentPacket, "issue-command-concurrent");
  assert.equal(concurrentIssue.response.status, 201, JSON.stringify(concurrentIssue.payload));
  const capabilityId = concurrentIssue.payload.data.capabilityId;
  const attempts = await Promise.all([
    consume(harness, superToken, capabilityId, "consume-command-concurrent-a"),
    consume(harness, superToken, capabilityId, "consume-command-concurrent-b"),
  ]);
  const statuses = attempts.map((attempt) => attempt.response.status).sort((left, right) => left - right);
  assert.deepEqual(statuses, [200, 409]);
  const winner = attempts.find((attempt) => attempt.response.status === 200);
  const loser = attempts.find((attempt) => attempt.response.status === 409);
  assert.ok(winner);
  assert.ok(loser);
  assert.equal(loser.payload.error.code, "PUBLISH_CAPABILITY_ALREADY_CONSUMED");
  assert.equal(winner.payload.data.attestation.state, "consumed");
  assert.equal(winner.payload.data.attestation.articleId, concurrentPacket.articleId);
  assert.equal(winner.payload.data.attestation.maxClicks, 1);
  assert.ok(Date.parse(winner.payload.data.attestation.expiresAt) > Date.parse(winner.payload.data.attestation.issuedAt));
  for (const field of [
    "externalActionPerformed",
    "publishClicked",
    "submissionAccepted",
    "destinationRecordVerified",
    "publicAccessVerified",
    "outcomeVerified",
    "completionDeclared",
  ]) {
    assert.equal(winner.payload.data.receipt[field], false, field);
  }
  const nonce = JSON.parse((await db.prepare("SELECT ticket_json FROM publish_capabilities WHERE id = ?")
    .bind(capabilityId).first()).ticket_json).claims.nonce;
  assert.equal(JSON.stringify(winner.payload).includes(nonce), false);
  assert.equal(winner.payload.data.ticket, undefined);
  assert.equal(winner.payload.data.executionPacket, undefined);

  const winningCommandId = winner.payload.data.receipt.commandId;
  const exactReplay = await consume(harness, superToken, capabilityId, winningCommandId);
  assert.equal(exactReplay.response.status, 200, JSON.stringify(exactReplay.payload));
  assert.equal(exactReplay.payload.data.receipt.replayed, true);
  assert.equal(exactReplay.response.headers.get("x-wenmai-command-replayed"), "1");

  await db.prepare("UPDATE publish_capabilities SET expires_at = '2026-01-01T00:00:00.000Z' WHERE id = ?")
    .bind(capabilityId).run();
  const secondCommandAfterExpiry = await consume(
    harness,
    superToken,
    capabilityId,
    "consume-command-after-consumed-expiry",
  );
  assert.equal(secondCommandAfterExpiry.response.status, 409);
  assert.equal(secondCommandAfterExpiry.payload.error.code, "PUBLISH_CAPABILITY_ALREADY_CONSUMED");

  const consumptionCount = await db.prepare(`SELECT COUNT(*) AS count FROM publish_capability_consumptions
    WHERE capability_id = ?`).bind(capabilityId).first();
  assert.equal(Number(consumptionCount.count), 1);
  const consumedCapability = await db.prepare("SELECT status, consumed_at FROM publish_capabilities WHERE id = ?")
    .bind(capabilityId).first();
  assert.equal(consumedCapability.status, "consumed");
  assert.ok(consumedCapability.consumed_at);
});

test("site.full_control 派生根会话的签发拒绝保持为显式路由合同", async () => {
  const source = await readFile(path.join(projectRoot, "app", "api", "publish-capability", "v1", "route.ts"), "utf8");
  assert.match(source, /principal\.authBasis === "site_full_control_key"/u);
  assert.match(source, /PUBLISH_CAPABILITY_ISSUE_OWNER_OR_TRUSTED_SESSION_REQUIRED/u);
  assert.match(source, /owner 或可信设备管理会话完成当前批次确认/u);
});

test("HMAC binding 缺失时 owner 已认证请求仍 fail closed，且 Agent Key 不能 issue", async (context) => {
  const harness = await createHarness({ includeHmac: false });
  context.after(() => harness.mf.dispose());
  const session = await bootstrap(harness);
  const packet = await executionPacket("missing-hmac");
  const unavailable = await issue(harness, session, packet, "issue-command-missing-hmac");
  assert.equal(unavailable.response.status, 503);
  assert.equal(unavailable.payload.error.code, "PUBLISH_CAPABILITY_RUNTIME_UNAVAILABLE");

  const bearerDenied = await issue(harness, session, packet, "issue-command-key-denied", {
    authorization: `Bearer ${agentToken()}`,
  });
  assert.equal(bearerDenied.response.status, 403);
  assert.equal(bearerDenied.payload.error.code, "PUBLISH_CAPABILITY_ISSUE_MANAGEMENT_ONLY");
});
