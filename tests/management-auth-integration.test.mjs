import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID, webcrypto } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { Miniflare, NoOpLog, Request as MiniflareRequest } from "miniflare";

const projectRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const serverPath = path.join(projectRoot, "dist", "server");
const staticPath = path.join(serverPath, "_next", "static");
const canonicalOrigin = "http://[::1]:3000";

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function base64Url(value) {
  return Buffer.from(value).toString("base64url");
}

async function createTrustedDevice() {
  const keyPair = await webcrypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign", "verify"],
  );
  assert.equal(keyPair.privateKey.extractable, false);
  const exported = await webcrypto.subtle.exportKey("jwk", keyPair.publicKey);
  const publicKeyJwk = { crv: "P-256", kty: "EC", x: exported.x, y: exported.y };
  const publicKeySha256 = sha256(JSON.stringify(publicKeyJwk));
  return {
    deviceId: `management-device-${publicKeySha256}`,
    keyPair,
    publicKeyJwk,
    publicKeySha256,
  };
}

async function signDeviceMessage(device, message) {
  const signature = await webcrypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    device.keyPair.privateKey,
    new TextEncoder().encode(message),
  );
  return base64Url(signature);
}

function enrollmentMessage(harness, device) {
  return [
    "wenmai-management-device-enroll/v1",
    `origin=${canonicalOrigin}`,
    `boot=${harness.bootId}`,
    `device=${device.deviceId}`,
    `publicKey=${device.publicKeySha256}`,
    `binding=${harness.browserBindingSha256}`,
  ].join("\n");
}

function cookieFrom(response) {
  return (response.headers.get("set-cookie") ?? "").split(";", 1)[0];
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
  const raw = await response.text();
  let payload;
  try { payload = JSON.parse(raw); } catch {
    throw new Error(`Expected JSON from ${response.url || "unknown URL"} (${response.status}), received: ${raw.slice(0, 240)}`);
  }
  return { response, payload };
}

async function compiledRouteModules() {
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
  const editorialRoute = route("持久化自检");
  const agentRoute = route("Wenmai Agent Control Plane");
  const localImportRoute = route("LOCAL_IMPORT_SCOPE_DENIED");
  const projectPackageRoute = route("GUIDANCE_CHECKLIST_CAS_CONFLICT");
  const versionTextRoute = route("版本正文读取失败");
  const entry = `
    import * as auth from ${JSON.stringify(authRoute)};
    import * as editorial from ${JSON.stringify(editorialRoute)};
    import * as agent from ${JSON.stringify(agentRoute)};
    import * as localImport from ${JSON.stringify(localImportRoute)};
    import * as projectPackage from ${JSON.stringify(projectPackageRoute)};
    import * as versionText from ${JSON.stringify(versionTextRoute)};
    export default {
      async fetch(request) {
        const pathname = new URL(request.url).pathname;
        const route = pathname === "/api/auth" ? auth
          : pathname === "/api/editorial" ? editorial
            : pathname === "/api/agent/v1" ? agent
              : pathname === "/api/local-import/v1" ? localImport
                : pathname === "/api/project-package/v1" ? projectPackage
                : pathname === "/api/version-text" ? versionText
                : null;
        const handler = route?.[request.method];
        const headers = new Headers(request.headers);
        // The direct Miniflare harness uses an internal dispatch host. Restore
        // the canonical raw Host that the real Cloudflare Vite adapter carries
        // alongside its X-Forwarded-Host mirror.
        headers.set("host", "[::1]:3000");
        const routeRequest = new Request(request, { headers });
        return handler ? handler(routeRequest) : new Response("not found", { status: 404 });
      }
    };
  `;
  return [
    { type: "ESModule", path: "management-auth-test-worker.mjs", contents: entry },
    ...sources.map((source) => ({
      type: "ESModule",
      path: source.name,
      contents: source.contents,
    })),
  ];
}

async function createAuthHarness({
  d1Persist = false,
  databaseId = `management-auth-test-${randomUUID()}`,
  browserBinding = randomBytes(32).toString("base64url"),
  pairingExpired = false,
} = {}) {
  const pairingSelector = randomBytes(16).toString("base64url");
  const pairingSecret = randomBytes(16).toString("base64url");
  const pairingCode = `wenmai1.${pairingSelector}.${pairingSecret}`;
  const browserBindingSha256 = sha256(browserBinding);
  const bootId = `management-boot-${randomBytes(16).toString("base64url")}`;
  const createdAt = new Date(Date.now() - (pairingExpired ? 10 * 60 * 1000 : 0));
  const expiresAt = new Date(createdAt.getTime() + 5 * 60 * 1000);
  const mf = new Miniflare({
    modules: await compiledRouteModules(),
    compatibilityDate: "2026-05-15",
    compatibilityFlags: ["nodejs_compat"],
    publicUrl: canonicalOrigin,
    d1Databases: { DB: databaseId },
    d1Persist,
    bindings: {
      WENMAI_AUTH_CANONICAL_ORIGIN: canonicalOrigin,
      WENMAI_AUTH_BOOT_ID: bootId,
      WENMAI_AUTH_CHALLENGE_ID: `management-challenge-${pairingSelector}`,
      WENMAI_AUTH_PAIRING_SHA256: sha256(pairingCode),
      WENMAI_AUTH_CHALLENGE_CREATED_AT: createdAt.toISOString(),
      WENMAI_AUTH_CHALLENGE_EXPIRES_AT: expiresAt.toISOString(),
      WENMAI_AUTH_CSRF_HMAC_KEY: randomBytes(32).toString("base64url"),
    },
    log: new NoOpLog(),
  });
  return {
    mf,
    databaseId,
    d1Persist,
    pairingCode,
    pairingSelector,
    browserBinding,
    browserBindingSha256,
    bindingHeader: { "X-Wenmai-Browser-Binding": browserBinding },
    bootId,
  };
}

async function authPost(harness, body, {
  binding = harness.browserBinding,
  cookie = "",
  csrf = "",
  origin = canonicalOrigin,
} = {}) {
  const headers = {
    "content-type": "application/json",
    origin,
    "sec-fetch-site": "same-origin",
    ...(binding ? { "X-Wenmai-Browser-Binding": binding } : {}),
    ...(cookie ? { cookie } : {}),
    ...(csrf ? { "X-Wenmai-CSRF": csrf, "X-Wenmai-Write": "1" } : {}),
  };
  return json(await harness.mf.dispatchFetch(request("/api/auth", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  })));
}

async function initializeHarness(harness) {
  const result = await json(await harness.mf.dispatchFetch(request("/api/auth")));
  assert.equal(result.response.status, 200, JSON.stringify(result.payload));
  assert.equal(result.payload.data.bootId, harness.bootId);
  return result;
}

async function bootstrapHarness(harness) {
  const result = await authPost(harness, {
    action: "bootstrap",
    pairingCode: harness.pairingCode,
    browserBindingSha256: harness.browserBindingSha256,
  });
  assert.equal(result.response.status, 201, JSON.stringify(result.payload));
  return {
    ...result,
    cookie: cookieFrom(result.response),
    csrf: result.payload.data.csrfToken,
  };
}

async function enrollmentRequest(harness, device, overrides = {}) {
  const signature = await signDeviceMessage(device, enrollmentMessage(harness, device));
  return {
    action: "device.enroll",
    deviceId: device.deviceId,
    publicKeyJwk: device.publicKeyJwk,
    publicKeySha256: device.publicKeySha256,
    signature,
    ...overrides,
  };
}

async function enrollHarnessDevice(harness, session, device) {
  const result = await authPost(
    harness,
    await enrollmentRequest(harness, device),
    { cookie: session.cookie, csrf: session.csrf },
  );
  assert.equal(result.response.status, 200, JSON.stringify(result.payload));
  assert.equal(result.payload.data.enrolled, true);
  return result;
}

async function beginDeviceRecovery(harness, device) {
  return authPost(harness, { action: "device.begin", deviceId: device.deviceId });
}

async function completeDeviceRecovery(harness, device, begin, {
  binding = harness.browserBinding,
  nonce = begin.payload.data.nonce,
  signingPayload = begin.payload.data.signingPayload,
  signature,
} = {}) {
  const resolvedSignature = signature ?? await signDeviceMessage(device, signingPayload);
  return authPost(harness, {
    action: "device.complete",
    deviceId: device.deviceId,
    challengeId: begin.payload.data.challengeId,
    nonce,
    signingPayload,
    signature: resolvedSignature,
  }, { binding });
}

test("真实路由工件 + 内存 D1 拒绝敏感 GET、伪造写、CSRF 缺失、配对重放和已注销会话，并保留 Agent Bearer", async (context) => {
  const textData = JSON.parse(await readFile(path.join(projectRoot, "data", "version-text.generated.json"), "utf8"));
  const versionId = Object.keys(textData.versions)[0];
  assert.ok(versionId, "正文索引至少需要一个版本");
  const pairingSelector = randomBytes(16).toString("base64url");
  const pairingSecret = randomBytes(16).toString("base64url");
  const pairingCode = `wenmai1.${pairingSelector}.${pairingSecret}`;
  const browserBinding = randomBytes(32).toString("base64url");
  const browserBindingSha256 = createHash("sha256").update(browserBinding, "utf8").digest("hex");
  const bindingHeader = { "X-Wenmai-Browser-Binding": browserBinding };
  const createdAt = new Date();
  const expiresAt = new Date(createdAt.getTime() + 5 * 60 * 1000);
  const mf = new Miniflare({
    modules: await compiledRouteModules(),
    compatibilityDate: "2026-05-15",
    compatibilityFlags: ["nodejs_compat"],
    publicUrl: canonicalOrigin,
    d1Databases: { DB: `management-auth-test-${randomUUID()}` },
    d1Persist: false,
    bindings: {
      WENMAI_AUTH_CANONICAL_ORIGIN: canonicalOrigin,
      WENMAI_AUTH_CHALLENGE_ID: `management-challenge-${pairingSelector}`,
      WENMAI_AUTH_PAIRING_SHA256: createHash("sha256").update(pairingCode, "utf8").digest("hex"),
      WENMAI_AUTH_CHALLENGE_CREATED_AT: createdAt.toISOString(),
      WENMAI_AUTH_CHALLENGE_EXPIRES_AT: expiresAt.toISOString(),
      WENMAI_AUTH_CSRF_HMAC_KEY: randomBytes(32).toString("base64url"),
    },
    log: new NoOpLog(),
  });
  context.after(() => mf.dispose());

  const initial = await json(await mf.dispatchFetch(request("/api/auth", {
    headers: { "x-forwarded-host": "[::1]:3000" },
  })));
  assert.equal(initial.response.status, 200, JSON.stringify(initial.payload));
  assert.equal(initial.payload.data.authenticated, false);
  assert.equal(initial.payload.data.pairing.available, true);

  for (const headers of [
    { "x-forwarded-host": "attacker.example" },
    { "x-forwarded-host": "[::1]:3000, attacker.example" },
    { "x-forwarded-host": "[::1]:3000", "x-forwarded-for": "203.0.113.10" },
    { "x-forwarded-host": "[::1]:3000", "x-forwarded-proto": "http" },
    { "x-forwarded-host": "[::1]:3000", forwarded: "for=203.0.113.10" },
  ]) {
    const proxyAttack = await json(await mf.dispatchFetch(request("/api/auth", { headers })));
    assert.equal(proxyAttack.response.status, 421, JSON.stringify(proxyAttack.payload));
    assert.equal(proxyAttack.payload.error.code, "FORWARDED_REQUEST_FORBIDDEN");
  }

  const wrongSelector = randomBytes(16).toString("base64url");
  const selectorAttack = await json(await mf.dispatchFetch(request("/api/auth", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: canonicalOrigin,
      "sec-fetch-site": "same-origin",
    },
    body: JSON.stringify({
      action: "bootstrap",
      pairingCode: `wenmai1.${wrongSelector}.${pairingSecret}`,
      browserBindingSha256,
    }),
  })));
  assert.equal(selectorAttack.response.status, 401);
  assert.equal(selectorAttack.payload.error.code, "PAIRING_SELECTOR_INVALID");
  const afterSelectorAttack = await json(await mf.dispatchFetch(request("/api/auth")));
  assert.equal(afterSelectorAttack.payload.data.pairing.attemptsRemaining, 5);

  const unauthenticatedRead = await json(await mf.dispatchFetch(request("/api/editorial")));
  assert.equal(unauthenticatedRead.response.status, 401);
  assert.equal(unauthenticatedRead.payload.code, "MANAGEMENT_AUTH_REQUIRED");

  const unauthenticatedVersion = await json(await mf.dispatchFetch(request(`/api/version-text?id=${encodeURIComponent(versionId)}`)));
  assert.equal(unauthenticatedVersion.response.status, 401);
  assert.equal(unauthenticatedVersion.payload.code, "MANAGEMENT_AUTH_REQUIRED");

  const forged = await json(await mf.dispatchFetch(request("/api/editorial", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: canonicalOrigin,
      "sec-fetch-site": "same-origin",
      "X-Wenmai-Write": "1",
    },
    body: JSON.stringify({ action: "storage_probe" }),
  })));
  assert.equal(forged.response.status, 401);
  assert.equal(forged.payload.code, "MANAGEMENT_AUTH_REQUIRED");

  const paired = await json(await mf.dispatchFetch(request("/api/auth", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: canonicalOrigin,
      "sec-fetch-site": "same-origin",
    },
    body: JSON.stringify({ action: "bootstrap", pairingCode, browserBindingSha256 }),
  })));
  assert.equal(paired.response.status, 201);
  assert.equal(paired.payload.data.authenticated, true);
  assert.match(paired.payload.data.csrfToken, /^[a-f0-9]{64}$/);
  const setCookie = paired.response.headers.get("set-cookie") ?? "";
  assert.match(setCookie, /wenmai_management_session=/);
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Strict/);
  const cookie = setCookie.split(";", 1)[0];

  const stolenCookie = await json(await mf.dispatchFetch(request("/api/auth", {
    headers: { cookie },
  })));
  assert.equal(stolenCookie.response.status, 401);
  assert.equal(stolenCookie.payload.error.code, "MANAGEMENT_BROWSER_BINDING_REQUIRED");
  assert.equal(stolenCookie.payload.data?.csrfToken, undefined);

  const wrongPortBinding = await json(await mf.dispatchFetch(request("/api/editorial", {
    headers: { cookie, "X-Wenmai-Browser-Binding": randomBytes(32).toString("base64url") },
  })));
  assert.equal(wrongPortBinding.response.status, 401);
  assert.equal(wrongPortBinding.payload.code, "MANAGEMENT_BROWSER_BINDING_INVALID");

  const authenticatedRead = await json(await mf.dispatchFetch(request("/api/editorial", {
    headers: { cookie, ...bindingHeader },
  })));
  assert.equal(authenticatedRead.response.status, 200);
  assert.equal(authenticatedRead.payload.storage, "d1-local");

  const authenticatedVersion = await json(await mf.dispatchFetch(request(`/api/version-text?id=${encodeURIComponent(versionId)}`, {
    headers: { cookie, ...bindingHeader },
  })));
  assert.equal(authenticatedVersion.response.status, 200);
  assert.equal(authenticatedVersion.payload.versions[versionId].textHash, textData.versions[versionId]);
  assert.ok(authenticatedVersion.payload.versions[versionId].text.length > 0);

  const issueCommandId = `management-auth-issue-${randomUUID()}`;
  const issuePayload = {
    label: "management auth integration Agent",
    clientKind: "custom",
    scopes: ["task.read"],
    articleScope: { mode: "selected_articles", articleIds: ["article-integration-boundary"] },
    articleIds: ["article-integration-boundary"],
    taskIds: [],
  };
  const issueHeaders = {
    "content-type": "application/json",
    cookie,
    ...bindingHeader,
    origin: canonicalOrigin,
    "sec-fetch-site": "same-origin",
    "X-Wenmai-CSRF": paired.payload.data.csrfToken,
    "X-Wenmai-Write": "1",
  };
  const issueBody = JSON.stringify({ action: "issue_client", commandId: issueCommandId, payload: issuePayload });
  const issuedAgent = await json(await mf.dispatchFetch(request("/api/agent/v1", {
    method: "POST",
    headers: issueHeaders,
    body: issueBody,
  })));
  assert.equal(issuedAgent.response.status, 201);
  const agentToken = issuedAgent.payload.data.token;
  assert.match(agentToken, /^wenmai_agent_/);

  const replayedIssue = await json(await mf.dispatchFetch(request("/api/agent/v1", {
    method: "POST",
    headers: issueHeaders,
    body: issueBody,
  })));
  assert.equal(replayedIssue.response.status, 201);
  assert.equal(replayedIssue.payload.data.client.id, issuedAgent.payload.data.client.id);
  assert.equal(replayedIssue.payload.data.token, undefined);
  assert.equal(replayedIssue.payload.data.shownOnce, false);
  assert.equal(replayedIssue.payload.data.secretRecoverable, false);
  assert.equal(replayedIssue.payload.data.recovery, "secret_unavailable_revoke_and_reissue");
  const agentDb = await mf.getD1Database("DB");
  const issuedClientCount = await agentDb.prepare("SELECT COUNT(*) AS count FROM agent_clients WHERE label = ?")
    .bind(issuePayload.label).first();
  assert.equal(issuedClientCount.count, 1);
  const issueReceipt = await agentDb.prepare("SELECT response_json FROM command_receipts WHERE id = ?")
    .bind(issueCommandId).first();
  assert.ok(issueReceipt);
  assert.equal(String(issueReceipt.response_json).includes(agentToken), false);
  assert.equal(String(issueReceipt.response_json).includes("wenmai_agent_"), false);

  const nonCanonicalExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000).toUTCString();
  const canonicalIssue = await json(await mf.dispatchFetch(request("/api/agent/v1", {
    method: "POST",
    headers: issueHeaders,
    body: JSON.stringify({
      action: "issue_client",
      commandId: `management-auth-canonical-expiry-${randomUUID()}`,
      payload: { ...issuePayload, label: "canonical expiry Agent", expiresAt: nonCanonicalExpiry },
    }),
  })));
  assert.equal(canonicalIssue.response.status, 201, JSON.stringify(canonicalIssue.payload));
  assert.equal(canonicalIssue.payload.data.client.expiresAt, new Date(Date.parse(nonCanonicalExpiry)).toISOString());

  const bearerRead = await json(await mf.dispatchFetch(request("/api/agent/v1?view=health", {
    headers: { authorization: `Bearer ${agentToken}` },
  })));
  assert.equal(bearerRead.response.status, 200);
  assert.equal(bearerRead.payload.data.counts.activeClients, 1);
  assert.equal(bearerRead.payload.data.clients.length, 1);

  const deniedImport = await json(await mf.dispatchFetch(request("/api/local-import/v1?articleId=missing&bodySha256=" + "0".repeat(64), {
    headers: { authorization: `Bearer ${agentToken}` },
  })));
  assert.equal(deniedImport.response.status, 403);
  assert.equal(deniedImport.payload.error.code, "LOCAL_IMPORT_SCOPE_DENIED");

  const mixedLocalOperatorIssue = await json(await mf.dispatchFetch(request("/api/agent/v1", {
    method: "POST",
    headers: issueHeaders,
    body: JSON.stringify({
      action: "issue_client",
      commandId: `management-auth-mixed-local-operator-${randomUUID()}`,
      payload: {
        label: "invalid mixed local import operator",
        clientKind: "codex",
        scopes: ["article.import.new_root", "task.read"],
        articleIds: ["*"],
        taskIds: [],
      },
    }),
  })));
  assert.equal(mixedLocalOperatorIssue.response.status, 400);
  assert.equal(mixedLocalOperatorIssue.payload.error.code, "IMPORT_SCOPE_EXCLUSIVE_REQUIRED");

  const localOperatorIssueCommandId = `management-auth-local-operator-${randomUUID()}`;
  const localOperatorIssue = await json(await mf.dispatchFetch(request("/api/agent/v1", {
    method: "POST",
    headers: issueHeaders,
    body: JSON.stringify({
      action: "issue_client",
      commandId: localOperatorIssueCommandId,
      payload: {
        label: "local import integration operator",
        clientKind: "codex",
        scopes: ["article.import.new_root"],
        articleIds: ["*"],
        taskIds: [],
      },
    }),
  })));
  assert.equal(localOperatorIssue.response.status, 201);
  const localOperatorToken = localOperatorIssue.payload.data.token;
  const localOperatorClientId = localOperatorIssue.payload.data.client.id;
  const localOperatorHealth = await json(await mf.dispatchFetch(request("/api/local-import/v1?view=health", {
    headers: { authorization: `Bearer ${localOperatorToken}` },
  })));
  assert.equal(localOperatorHealth.response.status, 200);
  assert.equal(localOperatorHealth.payload.data.authorized, true);
  assert.equal(localOperatorHealth.payload.data.actorId, localOperatorClientId);
  assert.equal(localOperatorHealth.payload.data.secretReturned, false);
  const deniedAgentHealth = await json(await mf.dispatchFetch(request("/api/agent/v1?view=health", {
    headers: { authorization: `Bearer ${localOperatorToken}` },
  })));
  assert.equal(deniedAgentHealth.response.status, 403);
  assert.equal(deniedAgentHealth.payload.error.code, "SCOPE_DENIED");
  const importBodySuffix = randomUUID();
  const importBodyText = `# 本机 Agent Key 建档集成测试\n\n${importBodySuffix}`;
  const importRawBodyText = `\uFEFF# 本机 Agent Key 建档集成测试\r\n\r\n${importBodySuffix}`;
  const importBodySha256 = sha256(importBodyText);
  const importCommandId = `local-import-${localOperatorClientId}-${importBodySha256}`;
  const importIntake = {
    schemaVersion: "wenmai-local-import-declaration/1.0.0",
    contentKind: "article",
    editorialStage: "draft",
    goal: "验证 Key 导入后的建档与指导清单读回",
    audience: "文脉维护者",
    constraints: ["不提升编辑或发布 Claim"],
  };
  const importPayload = {
    title: "  本机   Agent \t Key 建档集成测试  ",
    bodyText: importRawBodyText,
    bodySha256: importBodySha256,
    sourceName: "  agent-key   import.md  ",
    format: "markdown",
    intake: importIntake,
  };
  const unsafeSourceName = await json(await mf.dispatchFetch(request("/api/local-import/v1", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${localOperatorToken}`,
    },
    body: JSON.stringify({
      action: "create_article_from_text",
      commandId: `local-import-unsafe-source-${randomUUID()}`,
      payload: { ...importPayload, sourceName: "agent..key.md" },
    }),
  })));
  assert.equal(unsafeSourceName.response.status, 400);
  assert.equal(unsafeSourceName.payload.error.code, "SOURCE_NAME_ONLY");
  const unsafeTitle = await json(await mf.dispatchFetch(request("/api/local-import/v1", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${localOperatorToken}`,
    },
    body: JSON.stringify({
      action: "create_article_from_text",
      commandId: `local-import-unsafe-title-${randomUUID()}`,
      payload: { ...importPayload, title: "不允许\u0000的标题" },
    }),
  })));
  assert.equal(unsafeTitle.response.status, 400);
  assert.equal(unsafeTitle.payload.error.code, "INVALID_FIELD");
  const importSchemaBeforeValidWrite = await agentDb.prepare(`SELECT COUNT(*) AS count FROM sqlite_master
    WHERE type = 'table' AND name = 'article_project_packages'`).first();
  assert.equal(importSchemaBeforeValidWrite.count, 0, "写前失败甚至不得初始化 Package 存储");
  const imported = await json(await mf.dispatchFetch(request("/api/local-import/v1", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${localOperatorToken}`,
    },
    body: JSON.stringify({
      action: "create_article_from_text",
      commandId: importCommandId,
      payload: importPayload,
    }),
  })));
  assert.equal(imported.response.status, 201, JSON.stringify(imported.payload));
  assert.equal(imported.payload.data.bodySha256, importBodySha256);
  assert.equal(imported.payload.data.title, "本机 Agent Key 建档集成测试");
  assert.equal(imported.payload.data.bodySha256Basis, "canonical_utf8_text_after_bom_removal_and_newline_normalization");
  assert.equal(imported.payload.data.originalFileBytesVerified, false);
  assert.equal(imported.payload.data.storageProjectionVerified, true);
  assert.equal(imported.payload.data.commandReplay, false);
  assert.equal(imported.payload.data.readbackFresh, true);
  assert.equal(imported.payload.data.workingCopyDirty, false);
  assert.equal(imported.payload.data.branchBridgeInSync, true);
  assert.equal(imported.payload.data.archiveRecordVerified, true);
  assert.equal(imported.payload.data.guidedAgentWorkReady, false);
  assert.equal(imported.payload.data.guidanceChecklist.archiveState, "archived_pending_human_triage");
  assert.equal(imported.payload.data.guidanceChecklist.profileAuthority, "policy_default");
  assert.equal(imported.payload.data.guidanceChecklist.nextAction.checkId, "triage.profile.human_decision");
  assert.equal(imported.payload.data.guidanceChecklist.completionBoundary.editorialComplete, false);
  assert.equal(imported.payload.data.guidanceChecklist.completionBoundary.publicAccessVerified, false);
  assert.equal(imported.payload.data.sourceName, "agent-key import.md");
  assert.equal(imported.payload.data.guidanceChecklist.bindings.bodySha256, importBodySha256);
  assert.equal(imported.payload.data.format, importPayload.format);
  assert.equal(imported.payload.data.intake.declarationState, "agent_declared");
  assert.equal(imported.payload.data.guidanceChecklist.bindings.projectId, imported.payload.data.projectId);
  assert.equal(imported.payload.data.guidanceChecklist.bindings.packageLockVersion, 1);
  assert.equal(imported.payload.data.guidanceChecklist.bindings.branchLockVersion, 1);
  assert.equal(imported.payload.data.guidanceChecklist.bindings.workingCopyLockVersion, 1);
  const sameCommandReplay = await json(await mf.dispatchFetch(request("/api/local-import/v1", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${localOperatorToken}`,
    },
    body: JSON.stringify({ action: "create_article_from_text", commandId: importCommandId, payload: importPayload }),
  })));
  assert.equal(sameCommandReplay.response.status, 201, JSON.stringify(sameCommandReplay.payload));
  assert.equal(sameCommandReplay.payload.data.commandReplay, true);
  assert.equal(sameCommandReplay.payload.data.readbackFresh, true);
  assert.equal(sameCommandReplay.payload.data.storageProjectionVerified, true);
  assert.equal(sameCommandReplay.payload.data.documentSha256, imported.payload.data.documentSha256);
  assert.equal(sameCommandReplay.payload.data.guidanceChecklist.checklistSha256, imported.payload.data.guidanceChecklist.checklistSha256);
  const reusedUnderNewCommand = await json(await mf.dispatchFetch(request("/api/local-import/v1", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${localOperatorToken}`,
    },
    body: JSON.stringify({
      action: "create_article_from_text",
      commandId: `local-import-reuse-${randomUUID()}`,
      payload: importPayload,
    }),
  })));
  assert.equal(reusedUnderNewCommand.response.status, 200, JSON.stringify(reusedUnderNewCommand.payload));
  assert.equal(reusedUnderNewCommand.payload.data.created, false);
  assert.equal(reusedUnderNewCommand.payload.data.reused, true);
  assert.equal(reusedUnderNewCommand.payload.data.sourceName, "agent-key import.md");
  assert.equal(reusedUnderNewCommand.payload.data.commandReplay, false);
  assert.equal(reusedUnderNewCommand.payload.data.format, importPayload.format);
  assert.deepEqual(reusedUnderNewCommand.payload.data.intake, imported.payload.data.intake);
  assert.equal(reusedUnderNewCommand.payload.data.documentSha256, imported.payload.data.documentSha256);
  const declarationConflict = await json(await mf.dispatchFetch(request("/api/local-import/v1", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${localOperatorToken}`,
    },
    body: JSON.stringify({
      action: "create_article_from_text",
      commandId: `local-import-conflict-${randomUUID()}`,
      payload: {
        ...importPayload,
        intake: { ...importIntake, goal: "试图以新声明覆盖已建档根" },
      },
    }),
  })));
  assert.equal(declarationConflict.response.status, 409, JSON.stringify(declarationConflict.payload));
  assert.equal(declarationConflict.payload.error.code, "LOCAL_IMPORT_DECLARATION_CONFLICT");
  assert.deepEqual(declarationConflict.payload.error.details.changedFields, ["intake"]);
  const importedReadback = await json(await mf.dispatchFetch(request(`/api/local-import/v1?articleId=${encodeURIComponent(imported.payload.data.articleId)}&bodySha256=${importBodySha256}`, {
    headers: { authorization: `Bearer ${localOperatorToken}` },
  })));
  assert.equal(importedReadback.response.status, 200);
  assert.equal(importedReadback.payload.data.documentSha256, imported.payload.data.documentSha256);
  assert.equal(importedReadback.payload.data.guidanceChecklist.checklistSha256, imported.payload.data.guidanceChecklist.checklistSha256);
  assert.deepEqual(importedReadback.payload.data.intake, imported.payload.data.intake);
  const [sourceCount, moduleCount, edgeCount, moduleRefCount] = await Promise.all([
    agentDb.prepare("SELECT COUNT(*) AS count FROM package_source_refs WHERE package_id = ?").bind(imported.payload.data.packageId).first(),
    agentDb.prepare("SELECT COUNT(*) AS count FROM package_modules WHERE package_id = ?").bind(imported.payload.data.packageId).first(),
    agentDb.prepare("SELECT COUNT(*) AS count FROM package_composition_edges WHERE package_id = ? AND composition_id = ?").bind(imported.payload.data.packageId, imported.payload.data.compositionId).first(),
    agentDb.prepare("SELECT COUNT(*) AS count FROM package_module_revision_refs WHERE package_id = ? AND ref_kind = 'source'").bind(imported.payload.data.packageId).first(),
  ]);
  assert.equal(sourceCount.count, 1);
  assert.equal(moduleCount.count, 2);
  assert.equal(edgeCount.count, 1);
  assert.equal(moduleRefCount.count, 2);

  const guidancePayload = {
    packageId: imported.payload.data.packageId,
    branchId: imported.payload.data.branchId,
    expectedChecklistSha256: imported.payload.data.guidanceChecklist.checklistSha256,
    expectedPackageLockVersion: imported.payload.data.guidanceChecklist.bindings.packageLockVersion,
    expectedBranchLockVersion: imported.payload.data.guidanceChecklist.bindings.branchLockVersion,
    expectedWorkingLockVersion: imported.payload.data.guidanceChecklist.bindings.workingCopyLockVersion,
    selectedProfile: "full_production",
    decisionNote: "人工确认进入完整生产；小模型仍只提交单模块候选 Patch。",
  };
  const bearerCannotDecide = await json(await mf.dispatchFetch(request("/api/project-package/v1", {
    method: "POST",
    headers: {
      "content-type": "application/json", authorization: `Bearer ${localOperatorToken}`,
      origin: canonicalOrigin, "sec-fetch-site": "same-origin", "X-Wenmai-Write": "1",
    },
    body: JSON.stringify({
      action: "decide_guidance_profile",
      commandId: `guidance-bearer-denied-${randomUUID()}`,
      payload: guidancePayload,
    }),
  })));
  assert.equal(bearerCannotDecide.response.status, 403);
  assert.equal(bearerCannotDecide.payload.error.code, "AMBIGUOUS_AUTH_FORBIDDEN");

  const staleGuidance = await json(await mf.dispatchFetch(request("/api/project-package/v1", {
    method: "POST",
    headers: issueHeaders,
    body: JSON.stringify({
      action: "decide_guidance_profile",
      commandId: `guidance-stale-${randomUUID()}`,
      payload: { ...guidancePayload, expectedWorkingLockVersion: guidancePayload.expectedWorkingLockVersion + 1 },
    }),
  })));
  assert.equal(staleGuidance.response.status, 409, JSON.stringify(staleGuidance.payload));
  assert.equal(staleGuidance.payload.error.code, "GUIDANCE_WORKING_CAS_CONFLICT");

  const lightGuidanceCommandId = `guidance-light-${randomUUID()}`;
  const lightGuidance = await json(await mf.dispatchFetch(request("/api/project-package/v1", {
    method: "POST",
    headers: issueHeaders,
    body: JSON.stringify({
      action: "decide_guidance_profile",
      commandId: lightGuidanceCommandId,
      payload: { ...guidancePayload, selectedProfile: "light_archive", decisionNote: "人工确认仅做轻量建档。" },
    }),
  })));
  assert.equal(lightGuidance.response.status, 201, JSON.stringify(lightGuidance.payload));
  assert.equal(lightGuidance.payload.data.guidanceChecklist.archiveState, "light_archive_ready");
  assert.equal(lightGuidance.payload.data.guidanceChecklist.editorialWorkReady, false);

  const guidanceCommandId = `guidance-decide-${randomUUID()}`;
  const fullGuidancePayload = {
    ...guidancePayload,
    expectedChecklistSha256: lightGuidance.payload.data.guidanceChecklist.checklistSha256,
  };
  const guidanceDecision = await json(await mf.dispatchFetch(request("/api/project-package/v1", {
    method: "POST",
    headers: issueHeaders,
    body: JSON.stringify({ action: "decide_guidance_profile", commandId: guidanceCommandId, payload: fullGuidancePayload }),
  })));
  assert.equal(guidanceDecision.response.status, 201, JSON.stringify(guidanceDecision.payload));
  assert.equal(guidanceDecision.payload.data.guidanceDecision.selectedProfile, "full_production");
  assert.equal(guidanceDecision.payload.data.guidanceDecision.supersedesReceiptId, lightGuidanceCommandId);
  assert.equal(guidanceDecision.payload.data.previousDecision.receiptId, lightGuidanceCommandId);
  assert.equal(guidanceDecision.payload.data.guidanceChecklist.profileAuthority, "human");
  assert.equal(guidanceDecision.payload.data.guidanceChecklist.archiveState, "guided_editorial_work_ready");
  assert.equal(guidanceDecision.payload.data.guidanceChecklist.editorialWorkReady, true);
  assert.equal(guidanceDecision.payload.data.guidanceChecklist.nextAction.checkId, "editorial.module.candidate");
  assert.equal(guidanceDecision.payload.data.guidanceChecklist.nextAction.actor, "agent");
  assert.equal(guidanceDecision.payload.data.guidanceChecklist.completionBoundary.editorialComplete, false);
  assert.deepEqual(guidanceDecision.payload.data.boundary, {
    bodyChanged: false, compositionChanged: false, locksChanged: false,
    editorialComplete: false, artifactDelivered: false, published: false,
  });
  const staleSupersede = await json(await mf.dispatchFetch(request("/api/project-package/v1", {
    method: "POST",
    headers: issueHeaders,
    body: JSON.stringify({
      action: "decide_guidance_profile",
      commandId: `guidance-stale-final-${randomUUID()}`,
      payload: fullGuidancePayload,
    }),
  })));
  assert.equal(staleSupersede.response.status, 409, JSON.stringify(staleSupersede.payload));
  assert.equal(staleSupersede.payload.error.code, "GUIDANCE_CHECKLIST_CAS_CONFLICT");
  const guidanceReceipt = await agentDb.prepare(`SELECT actor_id, request_sha256, response_json, status_code, completed_at
    FROM command_receipts WHERE id = ?`).bind(guidanceCommandId).first();
  assert.equal(guidanceReceipt.status_code, 201);
  assert.match(guidanceReceipt.actor_id, /^management-session:/u);
  assert.match(guidanceReceipt.request_sha256, /^[a-f0-9]{64}$/u);
  assert.ok(guidanceReceipt.completed_at);
  const storedGuidance = JSON.parse(guidanceReceipt.response_json).data.guidanceDecision;
  assert.equal(storedGuidance.actorId, guidanceReceipt.actor_id);
  assert.equal(storedGuidance.requestSha256, guidanceReceipt.request_sha256);
  assert.equal(storedGuidance.bindings.revisionId, imported.payload.data.revisionId);
  assert.equal(storedGuidance.bindings.compositionId, imported.payload.data.compositionId);
  assert.equal(storedGuidance.bindings.documentSha256, imported.payload.data.documentSha256);
  assert.equal(storedGuidance.bindings.baselineChecklistSha256, imported.payload.data.guidanceChecklist.checklistSha256);

  const guidedLocalReadback = await json(await mf.dispatchFetch(request(`/api/local-import/v1?articleId=${encodeURIComponent(imported.payload.data.articleId)}&bodySha256=${importBodySha256}`, {
    headers: { authorization: `Bearer ${localOperatorToken}` },
  })));
  assert.equal(guidedLocalReadback.response.status, 200);
  assert.equal(guidedLocalReadback.payload.data.guidanceChecklist.checklistSha256, guidanceDecision.payload.data.guidanceChecklist.checklistSha256);
  assert.equal(guidedLocalReadback.payload.data.guidanceChecklist.profileAuthority, "human");
  assert.equal(guidedLocalReadback.payload.data.guidedAgentWorkReady, true);
  const guidedManagementReadback = await json(await mf.dispatchFetch(request(`/api/project-package/v1?view=package&packageId=${encodeURIComponent(imported.payload.data.packageId)}&branchId=${encodeURIComponent(imported.payload.data.branchId)}`, {
    headers: { cookie, ...bindingHeader, origin: canonicalOrigin, "sec-fetch-site": "same-origin" },
  })));
  assert.equal(guidedManagementReadback.response.status, 200, JSON.stringify(guidedManagementReadback.payload));
  assert.equal(guidedManagementReadback.payload.data.guidanceChecklist.checklistSha256, guidanceDecision.payload.data.guidanceChecklist.checklistSha256);
  assert.equal(guidedManagementReadback.payload.data.guidanceChecklist.profileAuthority, "human");

  const packageReaderIssue = await json(await mf.dispatchFetch(request("/api/agent/v1", {
    method: "POST",
    headers: issueHeaders,
    body: JSON.stringify({
      action: "issue_client",
      commandId: `management-auth-package-reader-${randomUUID()}`,
      payload: {
        label: "local import package reader",
        clientKind: "mcp",
        scopes: ["package.read"],
        articleScope: { mode: "selected_articles", articleIds: [imported.payload.data.articleId] },
        articleIds: [imported.payload.data.articleId],
        taskIds: [],
      },
    }),
  })));
  assert.equal(packageReaderIssue.response.status, 201, JSON.stringify(packageReaderIssue.payload));
  const packageReaderToken = packageReaderIssue.payload.data.token;
  const readAgentPackage = async () => json(await mf.dispatchFetch(request(`/api/agent/v1?view=project_package&packageId=${encodeURIComponent(imported.payload.data.packageId)}&branchId=${encodeURIComponent(imported.payload.data.branchId)}`, {
    headers: { authorization: `Bearer ${packageReaderToken}` },
  })));
  const readManagementPackage = async () => json(await mf.dispatchFetch(request(`/api/project-package/v1?view=package&packageId=${encodeURIComponent(imported.payload.data.packageId)}&branchId=${encodeURIComponent(imported.payload.data.branchId)}`, {
    headers: { cookie, ...bindingHeader, origin: canonicalOrigin, "sec-fetch-site": "same-origin" },
  })));
  const agentPackageReadback = await readAgentPackage();
  assert.equal(agentPackageReadback.response.status, 200, JSON.stringify(agentPackageReadback.payload));
  assert.equal(agentPackageReadback.payload.data.guidanceChecklist.completionBoundary.editorialComplete, false);
  assert.equal(
    agentPackageReadback.payload.data.guidanceChecklist.checklistSha256,
    guidedManagementReadback.payload.data.guidanceChecklist.checklistSha256,
    "同一 clean Package snapshot 的管理/Agent 指导清单 SHA 必须同源",
  );
  assert.equal(agentPackageReadback.payload.data.boundary.inSync, true);
  assert.equal(guidedManagementReadback.payload.data.branchBridge.inSync, true);

  const projectionDrifts = [
    {
      label: "article working dirty",
      table: "branch_working_copies", column: "dirty",
      where: "branch_id = ? AND article_id = ?",
      bindings: [imported.payload.data.branchId, imported.payload.data.articleId], driftValue: 1,
    },
    {
      label: "article working base revision",
      table: "branch_working_copies", column: "base_revision_id",
      where: "branch_id = ? AND article_id = ?",
      bindings: [imported.payload.data.branchId, imported.payload.data.articleId], driftValue: `drift-revision-${randomUUID()}`,
    },
    {
      label: "article working body hash",
      table: "branch_working_copies", column: "body_sha256",
      where: "branch_id = ? AND article_id = ?",
      bindings: [imported.payload.data.branchId, imported.payload.data.articleId], driftValue: sha256(`article-body-drift-${randomUUID()}`),
    },
    {
      label: "package working dirty",
      table: "package_branch_working_copies", column: "dirty",
      where: "package_id = ? AND branch_id = ?",
      bindings: [imported.payload.data.packageId, imported.payload.data.branchId], driftValue: 1,
    },
    {
      label: "package working base composition",
      table: "package_branch_working_copies", column: "base_composition_id",
      where: "package_id = ? AND branch_id = ?",
      bindings: [imported.payload.data.packageId, imported.payload.data.branchId], driftValue: `drift-composition-${randomUUID()}`,
    },
    {
      label: "package working document hash",
      table: "package_branch_working_copies", column: "document_sha256",
      where: "package_id = ? AND branch_id = ?",
      bindings: [imported.payload.data.packageId, imported.payload.data.branchId], driftValue: sha256(`package-document-drift-${randomUUID()}`),
    },
    {
      label: "materialization composition identity",
      table: "package_composition_materializations", column: "composition_id",
      where: "package_id = ? AND branch_id = ? AND article_revision_id = ?",
      bindings: [imported.payload.data.packageId, imported.payload.data.branchId, imported.payload.data.revisionId],
      driftValue: `drift-materialization-composition-${randomUUID()}`,
    },
    {
      label: "materialization composition hash",
      table: "package_composition_materializations", column: "composition_sha256",
      where: "package_id = ? AND branch_id = ? AND article_revision_id = ?",
      bindings: [imported.payload.data.packageId, imported.payload.data.branchId, imported.payload.data.revisionId],
      driftValue: sha256(`materialization-composition-drift-${randomUUID()}`),
    },
    {
      label: "materialization body hash",
      table: "package_composition_materializations", column: "article_body_sha256",
      where: "package_id = ? AND branch_id = ? AND article_revision_id = ?",
      bindings: [imported.payload.data.packageId, imported.payload.data.branchId, imported.payload.data.revisionId],
      driftValue: sha256(`materialization-body-drift-${randomUUID()}`),
    },
    {
      label: "branch commit composition identity",
      table: "package_branch_composition_commits", column: "composition_id",
      where: "package_id = ? AND branch_id = ? AND article_revision_id = ?",
      bindings: [imported.payload.data.packageId, imported.payload.data.branchId, imported.payload.data.revisionId],
      driftValue: `drift-commit-composition-${randomUUID()}`,
    },
    {
      label: "branch commit composition hash",
      table: "package_branch_composition_commits", column: "composition_sha256",
      where: "package_id = ? AND branch_id = ? AND article_revision_id = ?",
      bindings: [imported.payload.data.packageId, imported.payload.data.branchId, imported.payload.data.revisionId],
      driftValue: sha256(`commit-composition-drift-${randomUUID()}`),
    },
  ];
  for (const drift of projectionDrifts) {
    const original = await agentDb.prepare(`SELECT ${drift.column} AS value FROM ${drift.table} WHERE ${drift.where} LIMIT 1`)
      .bind(...drift.bindings).first();
    assert.ok(original, `${drift.label}: 缺少待测基线行`);
    const changed = await agentDb.prepare(`UPDATE ${drift.table} SET ${drift.column} = ? WHERE ${drift.where}`)
      .bind(drift.driftValue, ...drift.bindings).run();
    assert.equal(changed.meta.changes, 1, `${drift.label}: 未能注入单一漂移`);
    let managementDrift;
    let agentDrift;
    try {
      [managementDrift, agentDrift] = await Promise.all([readManagementPackage(), readAgentPackage()]);
    } finally {
      const restored = await agentDb.prepare(`UPDATE ${drift.table} SET ${drift.column} = ? WHERE ${drift.where}`)
        .bind(original.value, ...drift.bindings).run();
      assert.equal(restored.meta.changes, 1, `${drift.label}: 未能恢复测试基线`);
    }
    assert.equal(managementDrift.response.status, 200, `${drift.label}: 管理投影应可读并返回 blocked 清单`);
    assert.equal(agentDrift.response.status, 200, `${drift.label}: Agent 投影应可读并返回 blocked 清单`);
    const managementChecklist = managementDrift.payload.data.guidanceChecklist;
    const agentChecklist = agentDrift.payload.data.guidanceChecklist;
    assert.equal(managementDrift.payload.data.branchBridge.inSync, false, `${drift.label}: 管理投影未阻断`);
    assert.equal(agentDrift.payload.data.boundary.inSync, false, `${drift.label}: Agent 投影未阻断`);
    assert.equal(managementChecklist.archiveReady, false, `${drift.label}: 管理清单不得 archiveReady`);
    assert.equal(agentChecklist.archiveReady, false, `${drift.label}: Agent 清单不得 archiveReady`);
    assert.equal(managementChecklist.checks.find((check) => check.id === "archive.revision.readback")?.status, "blocked");
    assert.equal(agentChecklist.checks.find((check) => check.id === "archive.revision.readback")?.status, "blocked");
    assert.equal(agentChecklist.checklistSha256, managementChecklist.checklistSha256,
      `${drift.label}: 管理/Agent 清单 SHA 必须由同一事实投影生成`);
  }
  const importReceipt = await agentDb.prepare("SELECT actor_id, response_json FROM command_receipts WHERE id = ?")
    .bind(importCommandId).first();
  assert.equal(importReceipt.actor_id, localOperatorClientId);
  assert.equal(String(importReceipt.response_json).includes(localOperatorToken), false);

  const driftSha256 = "0".repeat(64);
  await agentDb.prepare(`UPDATE package_branch_working_copies SET document_sha256 = ?
    WHERE package_id = ? AND branch_id = ?`)
    .bind(driftSha256, imported.payload.data.packageId, imported.payload.data.branchId).run();
  const replayAfterStorageDrift = await json(await mf.dispatchFetch(request("/api/local-import/v1", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${localOperatorToken}`,
    },
    body: JSON.stringify({ action: "create_article_from_text", commandId: importCommandId, payload: importPayload }),
  })));
  assert.equal(replayAfterStorageDrift.response.status, 409, JSON.stringify(replayAfterStorageDrift.payload));
  assert.equal(replayAfterStorageDrift.payload.error.code, "LOCAL_IMPORT_RECORD_INCOMPLETE");
  assert.ok(replayAfterStorageDrift.payload.error.details.issues.includes("BRANCH_WORKING_DOCUMENT_SHA_INVALID"));
  assert.equal(replayAfterStorageDrift.payload.data?.archiveRecordVerified, undefined, "replay 不得返回旧 clean snapshot");
  const managementAfterStorageDrift = await json(await mf.dispatchFetch(request(`/api/project-package/v1?view=package&packageId=${encodeURIComponent(imported.payload.data.packageId)}&branchId=${encodeURIComponent(imported.payload.data.branchId)}`, {
    headers: { cookie, ...bindingHeader, origin: canonicalOrigin, "sec-fetch-site": "same-origin" },
  })));
  assert.equal(managementAfterStorageDrift.response.status, 200, JSON.stringify(managementAfterStorageDrift.payload));
  assert.equal(managementAfterStorageDrift.payload.data.branchBridge.inSync, false);
  assert.equal(managementAfterStorageDrift.payload.data.guidanceChecklist.archiveReady, false);
  assert.equal(managementAfterStorageDrift.payload.data.guidanceChecklist.checks
    .find((check) => check.id === "archive.revision.readback").status, "blocked");
  assert.equal(managementAfterStorageDrift.payload.data.workingCopy.documentSha256, driftSha256);
  await agentDb.prepare(`UPDATE package_branch_working_copies SET document_sha256 = ?
    WHERE package_id = ? AND branch_id = ?`)
    .bind(imported.payload.data.documentSha256, imported.payload.data.packageId, imported.payload.data.branchId).run();

  await agentDb.prepare(`UPDATE package_module_revisions SET content_sha256 = ? WHERE id = (
      SELECT module_revision_id FROM package_composition_nodes
      WHERE package_id = ? AND composition_id = ? ORDER BY ordinal ASC LIMIT 1
    )`).bind(driftSha256, imported.payload.data.packageId, imported.payload.data.compositionId).run();
  const graphDriftReadback = await json(await mf.dispatchFetch(request(`/api/local-import/v1?articleId=${encodeURIComponent(imported.payload.data.articleId)}&bodySha256=${importBodySha256}`, {
    headers: { authorization: `Bearer ${localOperatorToken}` },
  })));
  assert.equal(graphDriftReadback.response.status, 409, JSON.stringify(graphDriftReadback.payload));
  assert.equal(graphDriftReadback.payload.error.code, "LOCAL_IMPORT_RECORD_INCOMPLETE");
  assert.ok(graphDriftReadback.payload.error.details.issues
    .some((issue) => issue.startsWith("REVISION_CONTENT_SHA_MISMATCH:")));

  const replay = await json(await mf.dispatchFetch(request("/api/auth", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: canonicalOrigin,
      "sec-fetch-site": "same-origin",
    },
    body: JSON.stringify({ action: "bootstrap", pairingCode, browserBindingSha256 }),
  })));
  assert.equal(replay.response.status, 409);
  assert.equal(replay.payload.error.code, "PAIRING_CONSUMED");

  for (const csrf of ["", "0".repeat(64)]) {
    const denied = await json(await mf.dispatchFetch(request("/api/editorial", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie,
        ...bindingHeader,
        origin: canonicalOrigin,
        "sec-fetch-site": "same-origin",
        "X-Wenmai-Write": "1",
        ...(csrf ? { "X-Wenmai-CSRF": csrf } : {}),
      },
      body: JSON.stringify({ action: "storage_probe" }),
    })));
    assert.equal(denied.response.status, 403);
    assert.equal(denied.payload.code, "CSRF_TOKEN_INVALID");
  }

  const accepted = await json(await mf.dispatchFetch(request("/api/editorial", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie,
      ...bindingHeader,
      origin: canonicalOrigin,
      "sec-fetch-site": "same-origin",
      "X-Wenmai-CSRF": paired.payload.data.csrfToken,
      "X-Wenmai-Write": "1",
    },
    body: JSON.stringify({ action: "storage_probe" }),
  })));
  assert.equal(accepted.response.status, 200);
  assert.equal(accepted.payload.writable, true);

  const logout = await json(await mf.dispatchFetch(request("/api/auth", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie,
      ...bindingHeader,
      origin: canonicalOrigin,
      "sec-fetch-site": "same-origin",
      "X-Wenmai-CSRF": paired.payload.data.csrfToken,
      "X-Wenmai-Write": "1",
    },
    body: JSON.stringify({ action: "logout" }),
  })));
  assert.equal(logout.response.status, 200);
  assert.match(logout.response.headers.get("set-cookie") ?? "", /Max-Age=0/);

  const revoked = await json(await mf.dispatchFetch(request("/api/editorial", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie,
      ...bindingHeader,
      origin: canonicalOrigin,
      "sec-fetch-site": "same-origin",
      "X-Wenmai-CSRF": paired.payload.data.csrfToken,
      "X-Wenmai-Write": "1",
    },
    body: JSON.stringify({ action: "storage_probe" }),
  })));
  assert.equal(revoked.response.status, 401);
  assert.equal(revoked.payload.code, "MANAGEMENT_SESSION_INVALID");
});

test("已认证会话以 CSRF + P-256 持有证明登记设备，D1 只保留公钥与摘要", async (context) => {
  const harness = await createAuthHarness();
  context.after(() => harness.mf.dispose());
  await initializeHarness(harness);
  const device = await createTrustedDevice();
  const enrollment = await enrollmentRequest(harness, device);

  const unauthenticated = await authPost(harness, enrollment);
  assert.equal(unauthenticated.response.status, 401);
  assert.equal(unauthenticated.payload.error.code, "MANAGEMENT_AUTH_REQUIRED");

  const session = await bootstrapHarness(harness);
  const missingCsrf = await authPost(harness, enrollment, { cookie: session.cookie });
  assert.equal(missingCsrf.response.status, 403);
  assert.equal(missingCsrf.payload.error.code, "CSRF_TOKEN_INVALID");

  const invalidSignature = `${enrollment.signature[0] === "A" ? "B" : "A"}${enrollment.signature.slice(1)}`;
  const rejectedProof = await authPost(
    harness,
    { ...enrollment, signature: invalidSignature },
    { cookie: session.cookie, csrf: session.csrf },
  );
  assert.equal(rejectedProof.response.status, 401);
  assert.equal(rejectedProof.payload.error.code, "DEVICE_SIGNATURE_INVALID");

  const db = await harness.mf.getD1Database("DB");
  assert.equal((await db.prepare("SELECT COUNT(*) AS count FROM management_browser_devices").first()).count, 0);

  const enrolled = await enrollHarnessDevice(harness, session, device);
  assert.equal(enrolled.payload.data.reused, false);
  const reused = await enrollHarnessDevice(harness, session, device);
  assert.equal(reused.payload.data.reused, true);

  const storedDevice = await db.prepare("SELECT * FROM management_browser_devices WHERE id = ?")
    .bind(device.deviceId).first();
  assert.equal(storedDevice.public_key_sha256, device.publicKeySha256);
  assert.equal(storedDevice.browser_binding_sha256, harness.browserBindingSha256);
  assert.equal(storedDevice.status, "active");
  assert.deepEqual(JSON.parse(storedDevice.public_key_jwk_json), device.publicKeyJwk);
  assert.equal("d" in JSON.parse(storedDevice.public_key_jwk_json), false, "D1 不得接收或保存私钥字段");

  const challengeColumns = (await db.prepare("PRAGMA table_info(management_device_challenges)").all())
    .results.map((column) => column.name);
  assert.ok(challengeColumns.includes("nonce_sha256"));
  assert.ok(challengeColumns.includes("payload_sha256"));
  for (const forbidden of ["nonce", "signing_payload", "signature", "private_key", "pairing_code"]) {
    assert.equal(challengeColumns.includes(forbidden), false, `D1 challenge 不得包含 ${forbidden} 原文字段`);
  }
});

test("可信设备跨启动恢复：人工窗口可过期、上下文篡改失败、active 人工码被消费、重放并发收敛且注销撤销", async (context) => {
  const persistenceRoot = await mkdtemp(path.join(os.tmpdir(), "wenmai-management-device-test-"));
  const databaseId = `management-auth-device-${randomUUID()}`;
  const sharedBinding = randomBytes(32).toString("base64url");
  const device = await createTrustedDevice();
  let harness = null;
  context.after(async () => {
    if (harness) await harness.mf.dispose();
    await rm(persistenceRoot, { recursive: true, force: true });
  });

  harness = await createAuthHarness({ d1Persist: persistenceRoot, databaseId, browserBinding: sharedBinding });
  await initializeHarness(harness);
  const initialSession = await bootstrapHarness(harness);
  await enrollHarnessDevice(harness, initialSession, device);
  await harness.mf.dispose();
  harness = null;

  // A trusted device is independent from the short manual-code window. The
  // next boot may already have an expired fallback code and still recover.
  harness = await createAuthHarness({
    d1Persist: persistenceRoot,
    databaseId,
    browserBinding: sharedBinding,
    pairingExpired: true,
  });
  const expiredBoot = await initializeHarness(harness);
  assert.equal(expiredBoot.payload.data.pairing.available, false);
  assert.equal(expiredBoot.payload.data.pairing.state, "expired");

  const begin = await beginDeviceRecovery(harness, device);
  assert.equal(begin.response.status, 200, JSON.stringify(begin.payload));
  assert.equal(begin.payload.data.bootId, harness.bootId);
  assert.equal(begin.payload.data.deviceId, device.deviceId);
  assert.ok(Date.parse(begin.payload.data.expiresAt) - Date.parse(begin.payload.data.issuedAt) <= 30_000);

  const db = await harness.mf.getD1Database("DB");
  const storedChallenge = await db.prepare("SELECT * FROM management_device_challenges WHERE id = ?")
    .bind(begin.payload.data.challengeId).first();
  assert.equal(storedChallenge.nonce_sha256, sha256(begin.payload.data.nonce));
  assert.equal(storedChallenge.payload_sha256, sha256(begin.payload.data.signingPayload));
  assert.notEqual(storedChallenge.nonce_sha256, begin.payload.data.nonce);
  assert.notEqual(storedChallenge.payload_sha256, begin.payload.data.signingPayload);
  assert.doesNotMatch(JSON.stringify(storedChallenge), new RegExp(begin.payload.data.nonce));

  const tamperedPayload = `${begin.payload.data.signingPayload}\ntampered=true`;
  const payloadTamper = await completeDeviceRecovery(harness, device, begin, {
    signingPayload: tamperedPayload,
    signature: await signDeviceMessage(device, tamperedPayload),
  });
  assert.equal(payloadTamper.response.status, 401);
  assert.equal(payloadTamper.payload.error.code, "DEVICE_SIGNATURE_INVALID");

  const wrongBinding = randomBytes(32).toString("base64url");
  const bindingTamper = await completeDeviceRecovery(harness, device, begin, { binding: wrongBinding });
  assert.equal(bindingTamper.response.status, 401);
  assert.equal(bindingTamper.payload.error.code, "DEVICE_SIGNATURE_INVALID");

  const recovered = await completeDeviceRecovery(harness, device, begin);
  assert.equal(recovered.response.status, 201, JSON.stringify(recovered.payload));
  assert.equal(recovered.payload.data.authenticated, true);
  assert.equal(recovered.payload.data.automatic, true);
  const recoveredCookie = cookieFrom(recovered.response);
  assert.match(recoveredCookie, /^wenmai_management_session=/);

  const sequentialReplay = await completeDeviceRecovery(harness, device, begin);
  assert.equal(sequentialReplay.response.status, 409);
  assert.equal(sequentialReplay.payload.error.code, "DEVICE_CHALLENGE_CONSUMED");
  await harness.mf.dispose();
  harness = null;

  // With an active fallback challenge, successful trusted recovery consumes
  // that startup code in the same acceptance batch.
  harness = await createAuthHarness({ d1Persist: persistenceRoot, databaseId, browserBinding: sharedBinding });
  const activeBoot = await initializeHarness(harness);
  assert.equal(activeBoot.payload.data.pairing.available, true);
  const concurrentBegin = await beginDeviceRecovery(harness, device);
  assert.equal(concurrentBegin.response.status, 200, JSON.stringify(concurrentBegin.payload));
  const replaySignature = await signDeviceMessage(device, concurrentBegin.payload.data.signingPayload);
  const attempts = await Promise.all([
    completeDeviceRecovery(harness, device, concurrentBegin, { signature: replaySignature }),
    completeDeviceRecovery(harness, device, concurrentBegin, { signature: replaySignature }),
  ]);
  const statuses = attempts.map((attempt) => attempt.response.status).sort((left, right) => left - right);
  assert.deepEqual(statuses, [201, 409]);
  const winner = attempts.find((attempt) => attempt.response.status === 201);
  const loser = attempts.find((attempt) => attempt.response.status === 409);
  assert.ok(winner);
  assert.ok(["DEVICE_CHALLENGE_CONSUMED", "DEVICE_CHALLENGE_RACE_LOST"].includes(loser.payload.error.code));

  const liveDb = await harness.mf.getD1Database("DB");
  const consumedChallenge = await liveDb.prepare("SELECT * FROM management_device_challenges WHERE id = ?")
    .bind(concurrentBegin.payload.data.challengeId).first();
  assert.equal(consumedChallenge.status, "consumed");
  const acceptedEventRows = await liveDb.prepare(`SELECT details_json FROM management_auth_events
    WHERE event_type = 'management.device.resume' AND outcome = 'accepted'`).all();
  const acceptedEvents = acceptedEventRows.results.filter((row) => {
    try {
      return JSON.parse(String(row.details_json)).challengeId === concurrentBegin.payload.data.challengeId;
    } catch {
      return false;
    }
  });
  assert.equal(acceptedEvents.length, 1);
  const winningSessions = await liveDb.prepare("SELECT COUNT(*) AS count FROM management_sessions WHERE id = ? AND status = 'active'")
    .bind(consumedChallenge.consumed_session_id).first();
  assert.equal(winningSessions.count, 1);
  const startupChallenge = await liveDb.prepare("SELECT * FROM management_bootstrap_challenges WHERE id = ?")
    .bind(`management-challenge-${harness.pairingSelector}`).first();
  assert.equal(startupChallenge.status, "consumed");
  assert.equal(startupChallenge.consumed_session_id, consumedChallenge.consumed_session_id);

  const manualAfterAutomatic = await authPost(harness, {
    action: "bootstrap",
    pairingCode: harness.pairingCode,
    browserBindingSha256: harness.browserBindingSha256,
  });
  assert.equal(manualAfterAutomatic.response.status, 409);
  assert.equal(manualAfterAutomatic.payload.error.code, "PAIRING_CONSUMED");

  const winnerCookie = cookieFrom(winner.response);
  const logout = await authPost(
    harness,
    { action: "logout" },
    { cookie: winnerCookie, csrf: winner.payload.data.csrfToken },
  );
  assert.equal(logout.response.status, 200, JSON.stringify(logout.payload));
  assert.match(logout.response.headers.get("set-cookie") ?? "", /Max-Age=0/);
  const revokedDevice = await liveDb.prepare("SELECT status, revoke_reason FROM management_browser_devices WHERE id = ?")
    .bind(device.deviceId).first();
  assert.equal(revokedDevice.status, "revoked");
  assert.equal(revokedDevice.revoke_reason, "user_logout");
  await harness.mf.dispose();
  harness = null;

  // Revocation forces the explicit fallback, but does not consume the fresh
  // manual code for this later boot.
  harness = await createAuthHarness({ d1Persist: persistenceRoot, databaseId, browserBinding: sharedBinding });
  const fallbackBoot = await initializeHarness(harness);
  assert.equal(fallbackBoot.payload.data.pairing.available, true);
  const revokedBegin = await beginDeviceRecovery(harness, device);
  assert.equal(revokedBegin.response.status, 401);
  assert.equal(revokedBegin.payload.error.code, "TRUSTED_DEVICE_NOT_AVAILABLE");
  const fallbackSession = await bootstrapHarness(harness);
  assert.match(fallbackSession.cookie, /^wenmai_management_session=/);
});
