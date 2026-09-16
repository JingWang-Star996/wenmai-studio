import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const text = async (path) => readFile(new URL(path, import.meta.url), "utf8");

test("auth route 只通过 HttpOnly cookie 返回 session，配对码不进入 URL 或持久化", async () => {
  const [route, auth, core, launcher, client, bindingClient] = await Promise.all([
    text("../app/api/auth/route.ts"),
    text("../app/management-auth.ts"),
    text("../app/management-auth-core.ts"),
    text("../scripts/run-vinext.mjs"),
    text("../app/ManagementSessionGate.tsx"),
    text("../app/management-browser-binding.ts"),
  ]);
  assert.match(route, /bootstrapManagementSession/);
  assert.match(route, /set-cookie/);
  assert.match(core, /HttpOnly/);
  assert.match(core, /SameSite=Strict/);
  assert.match(core, /const forwardedHost = request\.headers\.get\("x-forwarded-host"\)/);
  assert.match(core, /normalizedForwardedHost = new URL/);
  assert.match(core, /normalizedForwardedHost !== expected\.host\.toLowerCase\(\)/);
  assert.doesNotMatch(core, /temporary-auth-header-audit/);
  assert.match(auth, /token_sha256 TEXT NOT NULL UNIQUE/);
  assert.match(auth, /browser_binding_sha256 TEXT NOT NULL/);
  assert.match(auth, /pairing_sha256 TEXT NOT NULL UNIQUE/);
  assert.doesNotMatch(auth, /session_token TEXT|pairing_code TEXT|browser_binding_raw/i);
  assert.match(launcher, /createHash\("sha256"\)/);
  assert.match(launcher, /wenmai1\.\$\{pairingSelector\}\.\$\{pairingSecret\}/);
  assert.match(auth, /challengeIdFromPairingCode/);
  assert.match(launcher, /--hostname", canonicalHost/);
  assert.match(launcher, /const canonicalHost = "::1"/);
  assert.doesNotMatch(launcher, /[#?](?:pair|code|token)=/i);
  assert.doesNotMatch(client, /localStorage|sessionStorage|location\.hash|URLSearchParams/);
  assert.match(bindingClient, /new Uint8Array\(32\)/);
  assert.match(bindingClient, /window\.localStorage/);
  assert.doesNotMatch(bindingClient, /pairing|csrf|session[_-]?token/i);
});

test("所有管理写路由同批接入中央 session；Agent 与 Runner Bearer 保持独立", async () => {
  const routes = await Promise.all([
    "../app/api/editorial/route.ts",
    "../app/api/workspace/route.ts",
    "../app/api/lifecycle/route.ts",
    "../app/api/project-package/v1/route.ts",
    "../app/api/agent/v1/route.ts",
    "../app/api/runner/route.ts",
  ].map(text));
  for (const route of routes) assert.match(route, /requireManagementSession\(/);
  assert.match(routes[4], /authenticateClient\(db, request(?:, [^)]+)?\)/);
  assert.match(routes[4], /authorization\.startsWith\("Bearer "\)/);
  assert.match(routes[5], /authenticateRunner\(db, request, payload\)/);
  assert.match(routes[5], /x-wenmai-runner-token/);
});

test("正文与工作区敏感 GET 全部要求 management.read，发现层仍保持无正文同源读取", async () => {
  const protectedRoutes = await Promise.all([
    "../app/api/editorial/route.ts",
    "../app/api/workspace/route.ts",
    "../app/api/lifecycle/route.ts",
    "../app/api/project-package/v1/route.ts",
    "../app/api/runner/route.ts",
    "../app/api/version-text/route.ts",
  ].map(text));
  for (const route of protectedRoutes) {
    const getStart = route.indexOf("export async function GET");
    const postStart = route.indexOf("export async function POST", getStart);
    const getContract = route.slice(getStart, postStart < 0 ? undefined : postStart);
    assert.match(getContract, /requireManagementSession\(request, \{ scope: "management\.read" \}\)/);
  }

  const [agent, corpus, capabilities] = await Promise.all([
    text("../app/api/agent/v1/route.ts"),
    text("../app/api/corpus/v1/route.ts"),
    text("../app/api/capabilities/route.ts"),
  ]);
  const authorizeRead = agent.slice(agent.indexOf("async function authorizeRead"), agent.indexOf("async function tableExists"));
  assert.match(authorizeRead, /if \(sameOrigin\(request\)\)[\s\S]*requireManagementSession\(request, \{ scope: "management\.read" \}\)/);
  assert.match(authorizeRead, /authenticateClient\(db, request(?:, [^)]+)?\)/);
  assert.doesNotMatch(corpus, /requireManagementSession/);
  assert.doesNotMatch(capabilities, /requireManagementSession/);
  assert.doesNotMatch(corpus, /version-text\.generated/);
  assert.match(corpus, /bodyTextIncluded: false/);
});

test("浏览器写调用统一经过 managementFetch，CSRF 只保留在模块内存", async () => {
  const [fetcher, gate] = await Promise.all([
    text("../app/management-fetch.ts"),
    text("../app/ManagementSessionGate.tsx"),
  ]);
  assert.match(fetcher, /X-Wenmai-CSRF/);
  assert.match(fetcher, /X-Wenmai-Write/);
  assert.match(fetcher, /X-Wenmai-Browser-Binding/);
  assert.match(fetcher, /credentials: "same-origin"/);
  assert.match(fetcher, /target\.origin !== window\.location\.origin/);
  assert.match(fetcher, /input instanceof Request \? input\.method/);
  assert.doesNotMatch(fetcher, /localStorage|sessionStorage|document\.cookie/);
  assert.match(gate, /setManagementCsrfToken/);
  assert.match(gate, /clearManagementCsrfToken/);
  assert.match(fetcher, /response\.status === 401/);
  assert.match(fetcher, /subscribeManagementSessionInvalidation/);
  assert.match(gate, /subscribeManagementSessionInvalidation/);
  assert.match(fetcher, /isCsrfFailure/);
  assert.match(fetcher, /refreshCsrfFromCurrentSession/);
  assert.match(fetcher, /input instanceof Request \? input\.clone\(\) : input/);
  assert.match(fetcher, /Never retry more than once here/);
  assert.doesNotMatch(fetcher, /while\s*\([^)]*CSRF|for\s*\([^)]*CSRF/);
});

test("浏览器敏感 GET 也统一经过 managementFetch，401 会回到锁屏", async () => {
  const clients = await Promise.all([
    "../app/StudioShell.tsx",
    "../app/WorkbenchShell.tsx",
    "../app/DistributionHub.tsx",
    "../app/LifecycleConsole.tsx",
    "../app/ArticleProjectEditor.tsx",
    "../app/AgentConsole.tsx",
    "../app/ArticlePreview.tsx",
  ].map(text));
  const joined = clients.join("\n");
  for (const endpoint of ["editorial", "workspace", "lifecycle", "project-package/v1", "runner", "version-text", "agent/v1"]) {
    assert.match(joined, new RegExp(`managementFetch\\([\\s\\S]{0,80}/api/${endpoint.replace("/", "\\/")}`));
  }
});

test("0011 schema 只有 challenge/session 摘要和可审计事件", async () => {
  const [schema, migration, migrationJournal] = await Promise.all([
    text("../db/schema.ts"),
    text("../drizzle/0011_wealthy_whizzer.sql"),
    text("../drizzle/meta/_journal.json"),
  ]);
  for (const table of ["management_bootstrap_challenges", "management_sessions", "management_auth_events"]) {
    assert.match(schema, new RegExp(table));
    assert.match(migration, new RegExp("CREATE TABLE `" + table + "`"));
  }
  assert.match(schema, /tokenSha256: text\("token_sha256"\)/);
  assert.match(schema, /browserBindingSha256: text\("browser_binding_sha256"\)/);
  assert.match(schema, /pairingSha256: text\("pairing_sha256"\)/);
  assert.doesNotMatch(schema, /sessionToken: text|pairingCode: text/);
  assert.doesNotMatch(migration, /session_token|pairing_code/i);
  assert.match(migration, /browser_binding_sha256/);
  assert.match(migrationJournal, /0011_wealthy_whizzer/);
});

test("0013 只持久化可信设备公钥与恢复摘要，注册、恢复和注销共用中央认证边界", async () => {
  const [schema, migration, migrationJournal, auth, route, vite] = await Promise.all([
    text("../db/schema.ts"),
    text("../drizzle/0013_typical_slipstream.sql"),
    text("../drizzle/meta/_journal.json"),
    text("../app/management-auth.ts"),
    text("../app/api/auth/route.ts"),
    text("../vite.config.ts"),
  ]);
  for (const table of ["management_browser_devices", "management_device_challenges"]) {
    assert.match(schema, new RegExp(table));
    assert.match(migration, new RegExp("CREATE TABLE `" + table + "`"));
    assert.match(auth, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
  }
  assert.match(schema, /publicKeyJwkJson: text\("public_key_jwk_json"\)/);
  assert.match(schema, /publicKeySha256: text\("public_key_sha256"\)/);
  assert.match(schema, /nonceSha256: text\("nonce_sha256"\)/);
  assert.match(schema, /payloadSha256: text\("payload_sha256"\)/);
  assert.doesNotMatch(schema, /privateKey|private_key|pairingCode|pairing_code|signature: text|signingPayload: text/i);
  assert.doesNotMatch(migration, /private_key|pairing_code|`nonce`|`signature`|`signing_payload`/i);
  assert.match(migrationJournal, /0013_typical_slipstream/);
  assert.match(vite, /WENMAI_AUTH_BOOT_ID: process\.env\.WENMAI_AUTH_BOOT_ID/);

  for (const action of ["device.enroll", "device.begin", "device.complete"]) {
    assert.match(route, new RegExp(`action === "${action.replace(".", "\\.")}"`));
  }
  const enrollment = auth.slice(auth.indexOf("export async function enrollManagementBrowserDevice"), auth.indexOf("export async function beginTrustedManagementSession"));
  assert.match(enrollment, /requireManagementSession\(request, \{ mutation: true, scope: "management\.read" \}\)/);
  assert.match(enrollment, /verifyDeviceSignature/);
  assert.match(enrollment, /public_key_jwk_json/);
  assert.doesNotMatch(enrollment, /private_key|pairing_code/i);

  const begin = auth.slice(auth.indexOf("export async function beginTrustedManagementSession"), auth.indexOf("async function rejectDeviceChallenge"));
  assert.match(begin, /nonceSha256/);
  assert.match(begin, /payloadSha256/);
  assert.doesNotMatch(begin, /challenge\.status\s*=\s*'active'|challenge\.expires_at\s*>/,
    "可信设备恢复不得依赖短期人工配对窗口仍 active");

  const complete = auth.slice(auth.indexOf("export async function completeTrustedManagementSession"), auth.indexOf("async function sessionRowForRequest"));
  assert.match(complete, /verifyDeviceSignature/);
  assert.match(complete, /status = 'consumed', consumed_at = \?, consumed_session_id = \?/);
  assert.match(complete, /UPDATE management_bootstrap_challenges SET[\s\S]*status = 'consumed'/);
  assert.match(complete, /DEVICE_CHALLENGE_RACE_LOST/);
  assert.match(complete, /INSERT INTO management_auth_events[\s\S]*WHERE EXISTS[\s\S]*FROM management_sessions/);

  const logout = auth.slice(auth.indexOf("export async function revokeCurrentManagementSession"), auth.indexOf("export function managementActorId"));
  assert.match(logout, /UPDATE management_browser_devices SET[\s\S]*status = 'revoked'/);
  assert.match(logout, /UPDATE management_device_challenges SET status = 'expired'/);
});

test("配对成功审计只能随真实 session 插入，竞争失败不伪造 accepted", async () => {
  const auth = await text("../app/management-auth.ts");
  assert.match(auth, /INSERT INTO management_auth_events[\s\S]*WHERE EXISTS \([\s\S]*FROM management_sessions/);
  assert.match(auth, /PAIRING_RACE_LOST/);
});

test("端口绑定、挑战选择器、no-store 与 CSP 关闭本机重放和注销后缓存", async () => {
  const [auth, fetcher, versionText, worker] = await Promise.all([
    text("../app/management-auth.ts"),
    text("../app/management-fetch.ts"),
    text("../app/api/version-text/route.ts"),
    text("../worker/index.ts"),
  ]);
  assert.match(auth, /PAIRING_SELECTOR_INVALID/);
  assert.ok(auth.indexOf("challengeIdFromPairingCode(pairingCode)") < auth.indexOf("ensureManagementAuthSchema();", auth.indexOf("bootstrapManagementSession")));
  assert.match(auth, /MANAGEMENT_BROWSER_BINDING_REQUIRED/);
  assert.match(auth, /constantTimeTextEqual\(browserBindingSha256, String\(row\.browser_binding_sha256/);
  assert.match(fetcher, /redirect: "error"/);
  assert.match(versionText, /cache-control": "no-store, max-age=0"/);
  assert.match(worker, /connect-src 'self'/);
  assert.match(worker, /frame-ancestors 'none'/);
});

test("Agent 公开合同不再把同源和写意图标头冒充为管理授权", async () => {
  const [apiContract, systemPrompt, agentRoute, packageRoute] = await Promise.all([
    text("../public/agent/api/v1.json"),
    text("../public/agent/prompts/system.md"),
    text("../app/api/agent/v1/route.ts"),
    text("../app/api/project-package/v1/route.ts"),
  ]);
  const parsed = JSON.parse(apiContract);
  assert.equal(parsed.authentication.management.type, "browser_management_session");
  assert.equal(parsed.authentication.management.availableToStdioClient, false);
  assert.match(parsed.authentication.management.cookie, /HttpOnly/);
  assert.match(parsed.authentication.management.mutationHeaders.join("\n"), /X-Wenmai-CSRF/);
  assert.match(parsed.authentication.management.browserBindingHeader, /X-Wenmai-Browser-Binding/);
  assert.match(parsed.authentication.management.protectedBrowserReads.join("\n"), /version-text/);
  assert.deepEqual(parsed.authentication.management.metadataDiscoveryReads, ["/api/corpus/v1", "/api/capabilities"]);
  assert.doesNotMatch(apiContract, /same_origin_write_intent/);
  assert.match(systemPrompt, /X-Wenmai-CSRF/);
  assert.match(systemPrompt, /单独携带没有任何授权能力/);
  assert.match(agentRoute, /browser-only HttpOnly management session/);
  assert.match(packageRoute, /intent marker only; never authorization/);
});

test("0023 site.full_control 仅兑换受快照绑定的本机根会话", async () => {
  const [migration, auth, siteFullControl, route, scopeCatalog, consoleUi] = await Promise.all([
    text("../drizzle/0023_site_full_control_management_session.sql"),
    text("../app/management-auth.ts"),
    text("../app/site-full-control-auth.ts"),
    text("../app/api/auth/route.ts"),
    text("../app/management-scope-catalog.ts"),
    text("../app/AgentConsole.tsx"),
  ]);
  assert.match(migration, /credential_purpose/);
  assert.match(migration, /issued_by_source_client_id/);
  assert.match(migration, /exchange_generation/);
  assert.match(migration, /source_permission_snapshot_sha256/);
  assert.match(route, /site_full_control\.exchange/);
  assert.match(route, /exchangeSiteFullControlManagementSession/);
  assert.match(siteFullControl, /V4_ROOT_ACTION_IDS_JSON = '\["auth\.site_full_control\.exchange"\]'/);
  assert.match(siteFullControl, /V5_ROOT_ACTION_IDS_JSON = '\["auth\.site_full_control\.direct","auth\.site_full_control\.exchange"\]'/);
  assert.match(siteFullControl, /management_session_exchange/);
  assert.match(siteFullControl, /authorization/);
  assert.doesNotMatch(siteFullControl, /localStorage|sessionStorage|document\.cookie/);
  assert.match(siteFullControl, /source_key_exchanged/);
  assert.match(siteFullControl, /source_permission_snapshot_sha256/);
  assert.match(siteFullControl, /document\.schemaVersion !== \(isV5 \? 5 : 4\)/);
  assert.match(siteFullControl, /document\.credentialPurpose !== \(isV5 \? "site_full_control" : "management_session_exchange"\)/);
  assert.match(siteFullControl, /\(isV5 && document\.directAgentApi !== true\)/);
  assert.match(siteFullControl, /verifyDirectSiteFullControlKey/);
  assert.match(siteFullControl, /managementProjectionVersion/);
  assert.match(siteFullControl, /managementProjectionSha256/);
  assert.match(siteFullControl, /canonicalSiteFullControlManagementProjection/);
  assert.match(scopeCatalog, /scope: "release\.approve", authorityDomain: "release", siteFullControl: true, mutation: true/);
  assert.match(scopeCatalog, /scope: "release\.record", authorityDomain: "release", siteFullControl: true, mutation: true/);
  assert.match(scopeCatalog, /scope: "admin\.diagnostics", authorityDomain: "diagnostics", siteFullControl: true, mutation: true/);
  assert.match(scopeCatalog, /filter\(\(entry\) => entry\.siteFullControl\)/);
  assert.match(consoleUi, /managementProjectionVersion/);
  assert.match(consoleUi, /managementProjectionSha256/);
  assert.match(auth, /auth_basis === "site_full_control_key"/);
  assert.match(auth, /verifyActiveSiteFullControlSessionSource/);
  assert.match(auth, /source_key_invalid/);
  assert.match(auth, /TRUSTED_DEVICE_FORBIDDEN/);
});
