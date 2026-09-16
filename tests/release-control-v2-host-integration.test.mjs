import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test from "node:test";

import { Miniflare, NoOpLog, Request as MiniflareRequest } from "miniflare";

import {
  EXECUTION_PACKET_SCHEMA_VERSION,
  MANDATORY_STOP_CONDITIONS,
  PUBLISH_ONCE_ACTIONS,
  canonicalExecutionJson,
  createFrozenExecutionPacket,
  issueExecutionRouteAttestation,
  sha256ExecutionJson,
  sha256ExecutionText,
} from "../app/release-execution-contract.ts";
import {
  appendExecutionReceiptEvent,
  createInitialReceiptProjection,
  receiptBindingFromClickLease,
} from "../app/release-control-v2.ts";
import { signHostRequest } from "../app/release-control-v2-host-auth.ts";

const projectRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const serverPath = path.join(projectRoot, "dist", "server");
const staticPath = path.join(serverPath, "_next", "static");
const canonicalOrigin = "http://[::1]:3000";
const host = "[::1]:3000";

function sha256(value) { return createHash("sha256").update(value, "utf8").digest("hex"); }
function request(pathname, init = {}) {
  const headers = new Headers(init.headers);
  headers.set("host", host);
  return new MiniflareRequest(`${canonicalOrigin}${pathname}`, { redirect: "manual", ...init, headers });
}
async function json(response) { return { response, payload: await response.json() }; }

let modulesPromise;
async function compiledHostModules() {
  if (modulesPromise) return modulesPromise;
  modulesPromise = (async () => {
    const sources = await Promise.all((await readdir(staticPath)).filter((name) => name.endsWith(".js")).map(async (name) => ({ name, contents: await readFile(path.join(staticPath, name), "utf8") })));
    const route = sources.find((source) => source.name.startsWith("route-") && source.contents.includes("HOST_EXECUTION_DISABLED"));
    assert.ok(route, "没有在 production build 中找到 release-control v2 host 路由");
    return [
      { type: "ESModule", path: "release-control-v2-host-test-worker.mjs", contents: `import * as hostRoute from ${JSON.stringify(`./${route.name}`)}; export default { async fetch(request) { const url = new URL(request.url); const handler = url.pathname === '/api/release-control/v2/host' ? hostRoute[request.method] : null; const headers = new Headers(request.headers); if (headers.get('sec-fetch-mode') === 'cors') headers.delete('sec-fetch-mode'); if (url.searchParams.has('test-headers')) return Response.json(Object.fromEntries(headers)); return handler ? handler(new Request(request, { headers })) : new Response('not found', { status: 404 }); } };` },
      ...sources.map((source) => ({ type: "ESModule", path: source.name, contents: source.contents })),
    ];
  })();
  return modulesPromise;
}

async function harness() {
  const hmac = randomBytes(48).toString("base64url");
  const mf = new Miniflare({
    modules: await compiledHostModules(), compatibilityDate: "2026-05-15", compatibilityFlags: ["nodejs_compat"], publicUrl: canonicalOrigin,
    d1Databases: { DB: `release-control-v2-host-test-${randomUUID()}` },
    bindings: { WENMAI_RELEASE_CONTROL_V2_ENABLED: "true", WENMAI_PUBLISH_OPERATOR_HOST_ROUTE_VERIFIED: "true", WENMAI_RELEASE_CONTROL_V2_HOST_HMAC_KEY: hmac }, log: new NoOpLog(),
  });
  const db = await mf.getD1Database("DB");
  const schema = await readFile(path.join(projectRoot, "drizzle", "0027_release_control_v2.sql"), "utf8");
  for (const statement of schema.split("--> statement-breakpoint").map((part) => part.trim()).filter(Boolean)) await db.prepare(statement).run();
  const observedHeaders = await (await mf.dispatchFetch(request("/api/release-control/v2/host?test-headers"))).json();
  return { mf, db, hmac, host: observedHeaders.host };
}

async function signedPost(h, body, headers = {}) {
  const raw = JSON.stringify(body), timestamp = new Date().toISOString(), nonce = randomBytes(24).toString("base64url");
  const bodySha256 = await sha256ExecutionText(raw);
  const signature = await signHostRequest({ method: "POST", pathname: "/api/release-control/v2/host", host: h.host, timestamp, nonce, bodySha256 }, h.hmac);
  return json(await h.mf.dispatchFetch(request("/api/release-control/v2/host", {
    method: "POST", headers: { "content-type": "application/json", "sec-fetch-site": "", "sec-fetch-mode": "", "sec-fetch-dest": "", "x-wenmai-host-timestamp": timestamp, "x-wenmai-host-nonce": nonce, "x-wenmai-host-body-sha256": bodySha256, "x-wenmai-host-signature": signature, ...headers }, body: raw,
  })));
}

async function packet(suffix) {
  return createFrozenExecutionPacket({
    schemaVersion: EXECUTION_PACKET_SCHEMA_VERSION, executor: { role: "browser_mechanical_executor", agentProfileId: "wenmai_publish_operator" },
    runId: `run-${suffix}`, articleId: `article-${suffix}`, attempt: 1, commandId: `packet-${suffix}`, contract: { revision: 1, sha256: sha256(`contract-${suffix}`) },
    platform: "bilibili", releaseId: `release-${suffix}`, buildId: `build-${suffix}`, artifact: { path: `E:\\artifacts\\${suffix}.docx`, sha256: await sha256ExecutionText(`artifact-${suffix}`) },
    targetAccount: "owner-account", allowedHosts: ["member.bilibili.com"], allowedPathPrefixes: ["/platform/upload/text/edit"], phase: "publish_once", allowedActions: [...PUBLISH_ONCE_ACTIONS], stopConditions: [...MANDATORY_STOP_CONDITIONS], createdAt: new Date().toISOString(),
  });
}

async function seed(h, suffix = "one") {
  const executionPacket = await packet(suffix), now = new Date(), expiresAt = new Date(now.getTime() + 240_000).toISOString();
  const confirmationId = `confirmation-${suffix}`, capabilityId = `capability-${suffix}`, nonce = randomBytes(32).toString("base64url"), domContractSha256 = sha256(`dom-${suffix}`), readinessSnapshotSha256 = sha256(`readiness-${suffix}`);
  const attestation = await issueExecutionRouteAttestation(executionPacket, h.hmac, { routeDecisionId: `route-${suffix}`, workUnitId: `work-${suffix}`, agentType: "wenmai_publish_operator", configuredModel: "gpt-5.6-terra", circuitState: "open", expiresAt });
  const packetJsonSha256 = await sha256ExecutionJson(executionPacket);
  await h.db.batch([
    h.db.prepare("INSERT INTO article_publish_confirmations (id,article_id,run_id,contract_sha256,owner_session_id,item_set_sha256,confirmation_sha256,state,confirmed_at,expires_at,created_at) VALUES (?1,?2,?3,?4,'owner',?5,?6,'confirmed',?7,?8,?7)").bind(confirmationId, executionPacket.articleId, executionPacket.runId, executionPacket.contract.sha256, sha256(`items-${suffix}`), sha256(`confirmation-${suffix}`), now.toISOString(), expiresAt),
    h.db.prepare("INSERT INTO article_publish_confirmation_items (id,confirmation_id,platform,release_id,build_id,artifact_sha256,target_account,readiness_snapshot_sha256,created_at) VALUES (?1,?2,'bilibili',?3,?4,?5,?6,?7,?8)").bind(`item-${suffix}`, confirmationId, executionPacket.releaseId, executionPacket.buildId, executionPacket.artifact.sha256, executionPacket.targetAccount, readinessSnapshotSha256, now.toISOString()),
    h.db.prepare("INSERT INTO release_readiness_snapshots (id,article_id,run_id,release_id,build_id,platform,artifact_sha256,target_account,publication_version_sha256,profile_sha256,contract_sha256,prepare_receipt_head_sha256,dom_contract_sha256,snapshot_sha256,state,created_at,expires_at) VALUES (?1,?2,?3,?4,?5,'bilibili',?6,?7,?8,?9,?10,?11,?12,?13,'ready_to_submit',?14,?15)").bind(`readiness-${suffix}`, executionPacket.articleId, executionPacket.runId, executionPacket.releaseId, executionPacket.buildId, executionPacket.artifact.sha256, executionPacket.targetAccount, sha256(`version-${suffix}`), sha256(`profile-${suffix}`), executionPacket.contract.sha256, sha256(`prepare-${suffix}`), domContractSha256, readinessSnapshotSha256, now.toISOString(), expiresAt),
    h.db.prepare("INSERT INTO release_publish_capabilities_v2 (id,confirmation_id,article_id,run_id,build_id,release_id,platform,execution_packet_json,packet_json_sha256,packet_sha256,artifact_sha256,readiness_snapshot_sha256,dom_contract_sha256,target_account,nonce_sha256,max_clicks,status,issued_at,expires_at) VALUES (?1,?2,?3,?4,?5,?6,'bilibili',?7,?8,?9,?10,?11,?12,?13,?14,1,'issued',?15,?16)").bind(capabilityId, confirmationId, executionPacket.articleId, executionPacket.runId, executionPacket.buildId, executionPacket.releaseId, canonicalExecutionJson(executionPacket), packetJsonSha256, executionPacket.packetSha256, executionPacket.artifact.sha256, readinessSnapshotSha256, domContractSha256, executionPacket.targetAccount, await sha256ExecutionText(nonce), now.toISOString(), expiresAt),
  ]);
  return { executionPacket, attestation, confirmationId, capabilityId, nonce, domContractSha256, readinessSnapshotSha256, expiresAt };
}

function consumeBody(seed, commandId) { return { action: "capability.consume", commandId, payload: { capabilityId: seed.capabilityId, hostId: "host-test", executionPacket: seed.executionPacket, routeAttestation: seed.attestation, domContractSha256: seed.domContractSha256, capabilityNonce: seed.nonce } }; }
function receiptInput(lease, eventType, suffix) { return { ...receiptBindingFromClickLease(lease), eventId: `event-${suffix}`, eventType, hostInvocationId: `invocation-${suffix}`, observedAt: new Date().toISOString(), writeDisposition: eventType === "result_unknown" ? "freeze_writes" : eventType === "read_only_probe" ? "stop_writes" : "continue", recoveryMode: eventType === "result_unknown" || eventType === "read_only_probe" ? "probe_first" : "none", claimPromotions: [], result: eventType === "result_unknown" ? "unknown" : eventType === "read_only_probe" ? "probe" : "not_applicable", evidenceRefs: eventType === "read_only_probe" ? ["probe-evidence"] : [] }; }

test("production host route 在临时 Miniflare D1 中 CAS 一次消费且不持久化秘密", async (context) => {
  const h = await harness(); context.after(() => h.mf.dispose()); const seeded = await seed(h, "consume");
  const attempts = await Promise.all([signedPost(h, consumeBody(seeded, "consume-a")), signedPost(h, consumeBody(seeded, "consume-b"))]);
  assert.deepEqual(attempts.map((item) => item.response.status).sort(), [200, 409]);
  const winner = attempts.find((item) => item.response.status === 200); assert.ok(winner);
  const leaseToken = winner.payload.data.leaseToken; assert.match(leaseToken, /^[A-Fa-f0-9]{64}$/u);
  const counts = await h.db.prepare("SELECT (SELECT COUNT(*) FROM publish_click_leases_v2 WHERE capability_id=?1) leases,(SELECT COUNT(*) FROM publish_execution_receipt_events_v2 WHERE capability_id=?1 AND sequence=1) events").bind(seeded.capabilityId).first();
  assert.deepEqual({ leases: Number(counts.leases), events: Number(counts.events) }, { leases: 1, events: 1 });
  const durable = await h.db.prepare("SELECT execution_packet_json,nonce_sha256 FROM release_publish_capabilities_v2 WHERE id=?1").bind(seeded.capabilityId).first();
  const receipt = await h.db.prepare("SELECT response_json FROM release_control_v2_command_receipts WHERE command_id='consume-a' OR command_id='consume-b'").all();
  assert.equal(JSON.stringify({ durable, receipt }).includes(seeded.nonce), false);
  assert.equal(JSON.stringify({ durable, receipt }).includes(leaseToken), false);
  const badNonce = await signedPost(h, { ...consumeBody(seeded, "consume-bad-nonce"), payload: { ...consumeBody(seeded, "x").payload, capabilityNonce: "x".repeat(32) } });
  assert.equal(badNonce.response.status, 409); assert.equal(badNonce.payload.error.code, "CAPABILITY_NOT_CONSUMABLE");
  const extra = await signedPost(h, { ...consumeBody(seeded, "consume-extra"), extra: true }); assert.equal(extra.response.status, 400); assert.equal(extra.payload.error.code, "COMMAND_SHAPE_INVALID");
  const browser = await signedPost(h, consumeBody(seeded, "consume-browser"), { "sec-fetch-site": "same-origin" }); assert.equal(browser.response.status, 403); assert.equal(browser.payload.error.code, "BROWSER_OR_SESSION_AUTH_FORBIDDEN");
});

test("结果不明冻结写入，仅允许只读探测并且不提升生命周期或公开声明", async (context) => {
  const h = await harness(); context.after(() => h.mf.dispose()); const seeded = await seed(h, "freeze");
  const consumed = await signedPost(h, consumeBody(seeded, "consume-freeze")); assert.equal(consumed.response.status, 200, JSON.stringify(consumed.payload));
  const lease = { schemaVersion: "wenmai.release-control/2.0", confirmationId: seeded.confirmationId, capabilityId: seeded.capabilityId, articleId: seeded.executionPacket.articleId, runId: seeded.executionPacket.runId, buildId: seeded.executionPacket.buildId, clickLeaseId: consumed.payload.data.leaseId, receiptChainId: consumed.payload.data.receiptChainId, packetSha256: seeded.executionPacket.packetSha256, releaseId: seeded.executionPacket.releaseId, platform: "bilibili", targetAccount: seeded.executionPacket.targetAccount, artifactSha256: seeded.executionPacket.artifact.sha256, readinessSnapshotSha256: seeded.readinessSnapshotSha256, domContractSha256: seeded.domContractSha256, hostId: "host-test", maxClicks: 1, issuedAt: new Date().toISOString(), expiresAt: seeded.expiresAt, nonce: "x".repeat(32) };
  let projection = createInitialReceiptProjection(lease);
  const consumedEvent = await h.db.prepare("SELECT event_sha256,observed_at,host_invocation_id,id FROM publish_execution_receipt_events_v2 WHERE capability_id=?1 AND sequence=1").bind(seeded.capabilityId).first();
  projection = { ...projection, sequence: 1, headSha256: consumedEvent.event_sha256, hostInvocationIds: [consumedEvent.host_invocation_id], capabilityConsumed: true };
  const started = await appendExecutionReceiptEvent(projection, receiptInput(lease, "click_invocation_started", "started"));
  const startedResponse = await signedPost(h, { action: "receipt.append", commandId: "receipt-started", payload: { leaseToken: consumed.payload.data.leaseToken, event: started } }); assert.equal(startedResponse.response.status, 200, JSON.stringify(startedResponse.payload));
  projection = { ...projection, sequence: started.sequence, headSha256: started.eventSha256, hostInvocationIds: [...projection.hostInvocationIds, started.hostInvocationId], invocationStarted: true };
  const unknown = await appendExecutionReceiptEvent(projection, receiptInput(lease, "result_unknown", "unknown"));
  const unknownResponse = await signedPost(h, { action: "receipt.append", commandId: "receipt-unknown", payload: { leaseToken: consumed.payload.data.leaseToken, event: unknown } }); assert.equal(unknownResponse.response.status, 200, JSON.stringify(unknownResponse.payload)); assert.equal(unknownResponse.payload.data.code, "RESULT_UNKNOWN_FROZEN");
  const frozen = await h.db.prepare("SELECT status FROM publish_click_leases_v2 WHERE id=?1").bind(lease.clickLeaseId).first(); const freeze = await h.db.prepare("SELECT status,reason FROM release_external_action_freezes_v2 WHERE release_id=?1").bind(lease.releaseId).first(); assert.deepEqual(frozen, { status: "frozen" }); assert.deepEqual(freeze, { status: "frozen", reason: "result_unknown" });
  const rejected = await signedPost(h, { action: "receipt.append", commandId: "receipt-after-frozen", payload: { leaseToken: consumed.payload.data.leaseToken, event: unknown } }); assert.equal(rejected.response.status, 409); assert.equal(rejected.payload.error.code, "LEASE_WRITE_FROZEN");
  projection = { ...projection, sequence: unknown.sequence, headSha256: unknown.eventSha256, hostInvocationIds: [...projection.hostInvocationIds, unknown.hostInvocationId], terminalResult: "unknown", clickAttempts: 1, probeOnly: true };
  const probe = await appendExecutionReceiptEvent(projection, receiptInput(lease, "read_only_probe", "probe"));
  const probed = await signedPost(h, { action: "readback.append", commandId: "readback-probe", payload: { leaseToken: consumed.payload.data.leaseToken, event: probe } }); assert.equal(probed.response.status, 200, JSON.stringify(probed.payload)); assert.equal(probed.payload.data.lifecyclePromotion, false);
  const readback = await h.db.prepare("SELECT readback_kind,result FROM release_authoritative_readbacks_v2 WHERE lease_id=?1").bind(lease.clickLeaseId).all(); assert.deepEqual(readback.results, [{ readback_kind: "read_only_probe", result: "inconclusive" }]);
  const claims = await h.db.prepare("SELECT event_type,result_json FROM publish_execution_receipt_events_v2 WHERE lease_id=?1 ORDER BY sequence").bind(lease.clickLeaseId).all(); assert.equal(JSON.stringify(claims.results).includes("public_access"), false);
});
