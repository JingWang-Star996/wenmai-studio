import { env } from "cloudflare:workers";
import { appendExecutionReceiptEvent, createInitialReceiptProjection, projectExecutionReceiptEvent, receiptBindingFromClickLease, validateClickLeaseClaims, validateExecutionReceiptEvent } from "../../../../release-control-v2.ts";
import { canonicalExecutionJson, sha256ExecutionJson, sha256ExecutionText, validateFrozenExecutionPacket, verifyExecutionRouteAttestation, type FrozenExecutionPacket } from "../../../../release-execution-contract.ts";
import { HostAuthError, hostExecutionEnabled, verifyHostRequest } from "../../../../release-control-v2-host-auth.ts";

export const runtime = "edge";
type Row = Record<string, string | number | null>;
type Json = Record<string, unknown>;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;
const SHA = /^[a-f0-9]{64}$/u;
const ACTIONS = new Set(["capability.consume", "receipt.append", "readback.append"]);
class ApiError extends Error { constructor(readonly code: string, readonly status = 400) { super(code); } }
function object(value: unknown): value is Json { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function exact(value: Json, keys: readonly string[], code: string) { if (Object.keys(value).length !== keys.length || Object.keys(value).some((key) => !keys.includes(key))) throw new ApiError(code); }
function text(value: unknown, label: string) { if (typeof value !== "string" || !ID.test(value)) throw new ApiError(`INVALID_${label}`); return value; }
function response(status: number, value: Json) { return Response.json(value, { status, headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" } }); }
function database() { const candidate = (env as unknown as { DB?: D1Database }).DB; if (!candidate) throw new ApiError("DB_UNAVAILABLE", 503); return candidate; }
function secret() { const value = (env as unknown as Record<string, unknown>).WENMAI_RELEASE_CONTROL_V2_HOST_HMAC_KEY; if (typeof value !== "string" || new TextEncoder().encode(value).byteLength < 32) throw new ApiError("HOST_SIGNING_KEY_UNAVAILABLE", 503); return value; }
function config() { return env as unknown as Record<string, unknown>; }
function metaChanges(value: unknown) { return object(value) && object(value.meta) && typeof value.meta.changes === "number" ? value.meta.changes : 0; }
function sanitized(code: string, extra: Json = {}) { return { externalEffect: "unknown", publishClicked: false, ...extra, code }; }

async function consume(db: D1Database, commandId: string, payload: Json, actor: string, requestSha: string) {
  exact(payload, ["capabilityId", "hostId", "executionPacket", "routeAttestation", "domContractSha256", "capabilityNonce"], "CONSUME_PAYLOAD_INVALID");
  const capabilityId = text(payload.capabilityId, "CAPABILITY_ID");
  const hostId = text(payload.hostId, "HOST_ID");
  if (typeof payload.capabilityNonce !== "string" || !/^[A-Za-z0-9_-]{32,192}$/u.test(payload.capabilityNonce)) throw new ApiError("CAPABILITY_NONCE_INVALID", 403);
  if (typeof payload.domContractSha256 !== "string" || !SHA.test(payload.domContractSha256)) throw new ApiError("DOM_CONTRACT_INVALID");
  const packet = payload.executionPacket;
  const attestation = payload.routeAttestation;
  const packetOk = await validateFrozenExecutionPacket(packet);
  if (!packetOk.ok || !object(packet)) throw new ApiError("PACKET_INVALID");
  if (packet.phase !== "publish_once") throw new ApiError("PACKET_PHASE_FORBIDDEN", 403);
  const attestationOk = await verifyExecutionRouteAttestation(attestation, packet as FrozenExecutionPacket, secret());
  if (!attestationOk.ok) throw new ApiError("ROUTE_ATTESTATION_INVALID", 403);
  const row = await db.prepare("SELECT * FROM release_publish_capabilities_v2 WHERE id = ?1").bind(capabilityId).first<Row>();
  if (!row || row.status !== "issued" || row.expires_at === null || Date.parse(String(row.expires_at)) <= Date.now()) throw new ApiError("CAPABILITY_NOT_CONSUMABLE", 409);
  let storedPacket: unknown;
  try { storedPacket = JSON.parse(String(row.execution_packet_json)); } catch { throw new ApiError("CAPABILITY_PACKET_STORED_INVALID", 409); }
  if (canonicalExecutionJson(storedPacket) !== canonicalExecutionJson(packet) || row.packet_sha256 !== packet.packetSha256 || row.packet_json_sha256 !== await sha256ExecutionJson(packet) || row.release_id !== packet.releaseId || row.build_id !== packet.buildId || row.article_id !== packet.articleId || row.run_id !== packet.runId || row.platform !== packet.platform || row.artifact_sha256 !== packet.artifact.sha256 || row.target_account !== packet.targetAccount || row.dom_contract_sha256 !== payload.domContractSha256 || row.nonce_sha256 !== await sha256ExecutionText(payload.capabilityNonce)) throw new ApiError("CAPABILITY_BINDING_MISMATCH", 409);
  const confirmation = await db.prepare("SELECT id,article_id,run_id,contract_sha256,state,expires_at FROM article_publish_confirmations WHERE id=?1").bind(row.confirmation_id).first<Row>();
  const confirmationItem = await db.prepare("SELECT release_id,build_id,platform,artifact_sha256,target_account,readiness_snapshot_sha256 FROM article_publish_confirmation_items WHERE confirmation_id=?1 AND release_id=?2").bind(row.confirmation_id, row.release_id).first<Row>();
  const readiness = await db.prepare("SELECT release_id,build_id,article_id,run_id,platform,artifact_sha256,target_account,dom_contract_sha256,snapshot_sha256,state,expires_at FROM release_readiness_snapshots WHERE snapshot_sha256=?1").bind(row.readiness_snapshot_sha256).first<Row>();
  if (!confirmation || confirmation.state !== "confirmed" || Date.parse(String(confirmation.expires_at)) <= Date.now() || confirmation.article_id !== row.article_id || confirmation.run_id !== row.run_id || confirmation.contract_sha256 !== packet.contract.sha256 || !confirmationItem || confirmationItem.release_id !== row.release_id || confirmationItem.build_id !== row.build_id || confirmationItem.platform !== row.platform || confirmationItem.artifact_sha256 !== row.artifact_sha256 || confirmationItem.target_account !== row.target_account || confirmationItem.readiness_snapshot_sha256 !== row.readiness_snapshot_sha256 || !readiness || readiness.state !== "ready_to_submit" || Date.parse(String(readiness.expires_at)) <= Date.now() || readiness.release_id !== row.release_id || readiness.build_id !== row.build_id || readiness.article_id !== row.article_id || readiness.run_id !== row.run_id || readiness.platform !== row.platform || readiness.artifact_sha256 !== row.artifact_sha256 || readiness.target_account !== row.target_account || readiness.dom_contract_sha256 !== row.dom_contract_sha256) throw new ApiError("CONFIRMATION_OR_READINESS_DRIFT", 409);
  const leaseId = `lease-${crypto.randomUUID()}`, receiptChainId = `chain-${crypto.randomUUID()}`;
  const leaseToken = crypto.randomUUID().replace(/-/gu, "") + crypto.randomUUID().replace(/-/gu, "");
  const leaseTokenSha = await sha256ExecutionText(leaseToken), now = new Date().toISOString();
  const lease = { schemaVersion: "wenmai.release-control/2.0", confirmationId: String(row.confirmation_id), capabilityId, articleId: String(row.article_id), runId: String(row.run_id), buildId: String(row.build_id), clickLeaseId: leaseId, receiptChainId, packetSha256: String(row.packet_sha256), releaseId: String(row.release_id), platform: String(row.platform), targetAccount: String(row.target_account), artifactSha256: String(row.artifact_sha256), readinessSnapshotSha256: String(row.readiness_snapshot_sha256), domContractSha256: String(row.dom_contract_sha256), hostId, maxClicks: 1, issuedAt: now, expiresAt: String(row.expires_at), nonce: crypto.randomUUID().replace(/-/gu, "") };
  const leaseCheck = validateClickLeaseClaims(lease);
  if (!leaseCheck.ok) throw new ApiError("LEASE_CONSTRUCTION_FAILED", 500);
  const event = await appendExecutionReceiptEvent(createInitialReceiptProjection(lease), { ...receiptBindingFromClickLease(lease), eventId: `evt-${crypto.randomUUID()}`, eventType: "capability_consumed", hostInvocationId: `consume-${commandId}`, observedAt: now, writeDisposition: "continue", recoveryMode: "none", claimPromotions: [], result: "not_applicable", evidenceRefs: [] });
  const results = await db.batch([
    db.prepare("UPDATE release_publish_capabilities_v2 SET status = 'consumed', consumed_at = ?2 WHERE id = ?1 AND status = 'issued' AND expires_at > ?2").bind(capabilityId, now),
    db.prepare("INSERT INTO publish_click_leases_v2 (id,capability_id,confirmation_id,article_id,run_id,build_id,release_id,platform,target_account,lease_token_sha256,receipt_chain_id,host_id,route_attestation_sha256,dom_contract_sha256,packet_sha256,artifact_sha256,readiness_snapshot_sha256,max_clicks,status,issued_at,expires_at) SELECT ?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,1,'active',?18,?19 WHERE EXISTS (SELECT 1 FROM release_publish_capabilities_v2 WHERE id=?2 AND status='consumed' AND consumed_at=?18)").bind(leaseId, capabilityId, row.confirmation_id, row.article_id, row.run_id, row.build_id, row.release_id, row.platform, row.target_account, leaseTokenSha, receiptChainId, hostId, await sha256ExecutionJson(attestation), row.dom_contract_sha256, row.packet_sha256, row.artifact_sha256, row.readiness_snapshot_sha256, now, row.expires_at),
    db.prepare("INSERT INTO publish_execution_receipt_events_v2 (id,receipt_chain_id,capability_id,lease_id,confirmation_id,article_id,run_id,build_id,release_id,platform,target_account,dom_contract_sha256,sequence,previous_event_sha256,event_sha256,event_type,host_id,host_invocation_id,packet_sha256,artifact_sha256,readiness_snapshot_sha256,result_json,evidence_json,write_disposition,recovery_mode,observed_at,created_at,server_sha256,signature_sha256) SELECT ?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,1,NULL,?13,'capability_consumed',?14,?15,?16,?17,?18,'{\"result\":\"not_applicable\"}','[]','continue','none',?19,?19,?20,?21 WHERE EXISTS (SELECT 1 FROM publish_click_leases_v2 WHERE id=?4)").bind(event.eventId, receiptChainId, capabilityId, leaseId, row.confirmation_id, row.article_id, row.run_id, row.build_id, row.release_id, row.platform, row.target_account, row.dom_contract_sha256, event.eventSha256, hostId, event.hostInvocationId, row.packet_sha256, row.artifact_sha256, row.readiness_snapshot_sha256, now, await sha256ExecutionJson(event), requestSha),
    db.prepare("INSERT INTO release_control_v2_command_receipts (command_id,command_type,actor_id,request_sha256,status,response_json,created_at,completed_at) VALUES (?1,'capability.consume',?2,?3,'succeeded',?4,?5,?5)").bind(commandId, actor, requestSha, JSON.stringify(sanitized("LEASE_ISSUED", { leaseId, receiptChainId })), now),
  ]);
  if (metaChanges(results[0]) !== 1 || metaChanges(results[1]) !== 1 || metaChanges(results[2]) !== 1) throw new ApiError("CAPABILITY_CONSUMPTION_NOT_PROVEN", 409);
  return sanitized("LEASE_ISSUED", { leaseId, receiptChainId, leaseToken, expiresAt: lease.expiresAt });
}

function leaseFromRow(row: Row) {
  const value = { schemaVersion: "wenmai.release-control/2.0" as const, confirmationId: String(row.confirmation_id), capabilityId: String(row.capability_id), articleId: String(row.article_id), runId: String(row.run_id), buildId: String(row.build_id), clickLeaseId: String(row.id), receiptChainId: String(row.receipt_chain_id), packetSha256: String(row.packet_sha256), releaseId: String(row.release_id), platform: String(row.platform), targetAccount: String(row.target_account), artifactSha256: String(row.artifact_sha256), readinessSnapshotSha256: String(row.readiness_snapshot_sha256), domContractSha256: String(row.dom_contract_sha256), hostId: String(row.host_id), maxClicks: 1 as const, issuedAt: String(row.issued_at), expiresAt: String(row.expires_at), nonce: "x".repeat(32) };
  if (!validateClickLeaseClaims(value).ok) throw new ApiError("LEASE_ROW_INVALID", 409);
  return value;
}
async function projection(db: D1Database, lease: ReturnType<typeof leaseFromRow>) {
  let result = createInitialReceiptProjection(lease);
  const rows = await db.prepare("SELECT * FROM publish_execution_receipt_events_v2 WHERE receipt_chain_id=?1 ORDER BY sequence ASC").bind(lease.receiptChainId).all<Row>();
  for (const row of rows.results ?? []) {
    const evidence = JSON.parse(String(row.evidence_json ?? "[]"));
    const stored = JSON.parse(String(row.result_json ?? "{}"));
    const event = { schemaVersion: "wenmai.release-control/2.0" as const, ...receiptBindingFromClickLease(lease), eventId: String(row.id), eventType: row.event_type, sequence: Number(row.sequence), expectedHeadSha256: row.previous_event_sha256, previousEventSha256: row.previous_event_sha256, hostInvocationId: String(row.host_invocation_id), observedAt: String(row.observed_at), writeDisposition: row.write_disposition, recoveryMode: row.recovery_mode, claimPromotions: [], result: object(stored) ? stored.result : "not_applicable", evidenceRefs: Array.isArray(evidence) ? evidence : [], eventSha256: String(row.event_sha256) };
    const validated = await validateExecutionReceiptEvent(event, result);
    if (!validated.ok) throw new ApiError("RECEIPT_HISTORY_INVALID", 409);
    result = projectExecutionReceiptEvent(result, event);
  }
  return result;
}
async function activeLease(db: D1Database, payload: Json) {
  const token = typeof payload.leaseToken === "string" ? payload.leaseToken : "";
  if (!/^[A-Fa-f0-9]{64}$/u.test(token)) throw new ApiError("LEASE_TOKEN_INVALID", 403);
  const row = await db.prepare("SELECT * FROM publish_click_leases_v2 WHERE lease_token_sha256=?1").bind(await sha256ExecutionText(token)).first<Row>();
  if (!row || Date.parse(String(row.expires_at)) <= Date.now()) throw new ApiError("LEASE_NOT_AVAILABLE", 409);
  return row;
}
async function appendReceipt(db: D1Database, commandId: string, payload: Json, actor: string, requestSha: string) {
  exact(payload, ["leaseToken", "event"], "RECEIPT_PAYLOAD_INVALID"); if (!object(payload.event)) throw new ApiError("RECEIPT_PAYLOAD_INVALID");
  const row = await activeLease(db, payload); if (row.status !== "active") throw new ApiError("LEASE_WRITE_FROZEN", 409);
  const lease = leaseFromRow(row), current = await projection(db, lease), event = payload.event;
  const checked = await validateExecutionReceiptEvent(event, current);
  if (!checked.ok) throw new ApiError("RECEIPT_HEAD_OR_BINDING_INVALID", 409);
  const expected = event as { eventId: string; eventSha256: string; eventType: string; hostInvocationId: string; observedAt: string; writeDisposition: string; recoveryMode: string; result: string; evidenceRefs: string[]; sequence: number; previousEventSha256: string | null };
  if (expected.eventType === "capability_consumed" || expected.eventType === "read_only_probe") throw new ApiError("RECEIPT_EVENT_TYPE_FORBIDDEN", 403);
  const now = new Date().toISOString(), unknown = expected.eventType === "result_unknown";
  const statements = [
    db.prepare("INSERT INTO publish_execution_receipt_events_v2 (id,receipt_chain_id,capability_id,lease_id,confirmation_id,article_id,run_id,build_id,release_id,platform,target_account,dom_contract_sha256,sequence,previous_event_sha256,event_sha256,event_type,host_id,host_invocation_id,packet_sha256,artifact_sha256,readiness_snapshot_sha256,result_json,evidence_json,write_disposition,recovery_mode,observed_at,created_at,server_sha256,signature_sha256) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22,?23,?24,?25,?26,?27,?28,?29)").bind(expected.eventId, lease.receiptChainId, lease.capabilityId, lease.clickLeaseId, lease.confirmationId, lease.articleId, lease.runId, lease.buildId, lease.releaseId, lease.platform, lease.targetAccount, lease.domContractSha256, expected.sequence, expected.previousEventSha256, expected.eventSha256, expected.eventType, lease.hostId, expected.hostInvocationId, lease.packetSha256, lease.artifactSha256, lease.readinessSnapshotSha256, JSON.stringify({ result: expected.result }), JSON.stringify(expected.evidenceRefs), expected.writeDisposition, expected.recoveryMode, expected.observedAt, now, await sha256ExecutionJson(event), requestSha),
    db.prepare("INSERT INTO release_control_v2_command_receipts (command_id,command_type,actor_id,request_sha256,status,response_json,created_at,completed_at) VALUES (?1,'receipt.append',?2,?3,'succeeded',?4,?5,?5)").bind(commandId, actor, requestSha, JSON.stringify(sanitized("RECEIPT_APPENDED", { eventType: expected.eventType })), now),
  ];
  if (unknown) statements.splice(1, 0, db.prepare("UPDATE publish_click_leases_v2 SET status='frozen' WHERE id=?1 AND status='active'").bind(lease.clickLeaseId), db.prepare("INSERT INTO release_external_action_freezes_v2 (release_id,reason,status,capability_id,lease_id,frozen_at) VALUES (?1,'result_unknown','frozen',?2,?3,?4) ON CONFLICT(release_id) DO UPDATE SET reason='result_unknown',status='frozen',capability_id=excluded.capability_id,lease_id=excluded.lease_id,frozen_at=excluded.frozen_at").bind(lease.releaseId, lease.capabilityId, lease.clickLeaseId, now));
  const results = await db.batch(statements);
  if (metaChanges(results[0]) !== 1 || (unknown && (metaChanges(results[1]) !== 1 || metaChanges(results[2]) !== 1))) throw new ApiError("RECEIPT_APPEND_NOT_PROVEN", 409);
  return sanitized(unknown ? "RESULT_UNKNOWN_FROZEN" : "RECEIPT_APPENDED", { eventType: expected.eventType, recoveryMode: unknown ? "probe_first" : "none" });
}
async function appendReadback(db: D1Database, commandId: string, payload: Json, actor: string, requestSha: string) {
  exact(payload, ["leaseToken", "event"], "READBACK_PAYLOAD_INVALID"); if (!object(payload.event)) throw new ApiError("READBACK_PAYLOAD_INVALID");
  const row = await activeLease(db, payload); if (row.status !== "frozen") throw new ApiError("READBACK_REQUIRES_FROZEN_LEASE", 409);
  const lease = leaseFromRow(row), current = await projection(db, lease), event = payload.event;
  const checked = await validateExecutionReceiptEvent(event, current);
  if (!checked.ok || event.eventType !== "read_only_probe") throw new ApiError("READBACK_HEAD_OR_BINDING_INVALID", 409);
  const item = event as { eventId: string; eventSha256: string; hostInvocationId: string; observedAt: string; sequence: number; previousEventSha256: string | null; evidenceRefs: string[]; writeDisposition: string; recoveryMode: string; result: string };
  const now = new Date().toISOString();
  const results = await db.batch([
    db.prepare("INSERT INTO publish_execution_receipt_events_v2 (id,receipt_chain_id,capability_id,lease_id,confirmation_id,article_id,run_id,build_id,release_id,platform,target_account,dom_contract_sha256,sequence,previous_event_sha256,event_sha256,event_type,host_id,host_invocation_id,packet_sha256,artifact_sha256,readiness_snapshot_sha256,result_json,evidence_json,write_disposition,recovery_mode,observed_at,created_at,server_sha256,signature_sha256) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,'read_only_probe',?16,?17,?18,?19,?20,?21,?22,?23,?24,?25,?26,?27,?28)").bind(item.eventId, lease.receiptChainId, lease.capabilityId, lease.clickLeaseId, lease.confirmationId, lease.articleId, lease.runId, lease.buildId, lease.releaseId, lease.platform, lease.targetAccount, lease.domContractSha256, item.sequence, item.previousEventSha256, item.eventSha256, lease.hostId, item.hostInvocationId, lease.packetSha256, lease.artifactSha256, lease.readinessSnapshotSha256, JSON.stringify({ result: item.result }), JSON.stringify(item.evidenceRefs), item.writeDisposition, item.recoveryMode, item.observedAt, now, await sha256ExecutionJson(event), requestSha),
    db.prepare("INSERT INTO release_authoritative_readbacks_v2 (id,release_id,capability_id,lease_id,confirmation_id,article_id,run_id,build_id,platform,target_account,dom_contract_sha256,host_id,receipt_chain_id,packet_sha256,artifact_sha256,readiness_snapshot_sha256,readback_kind,result,evidence_json,source_url,observed_at,evidence_sha256,response_sha256,created_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,'read_only_probe','inconclusive',?17,'',?18,?19,?20,?21)").bind(`readback-${crypto.randomUUID()}`, lease.releaseId, lease.capabilityId, lease.clickLeaseId, lease.confirmationId, lease.articleId, lease.runId, lease.buildId, lease.platform, lease.targetAccount, lease.domContractSha256, lease.hostId, lease.receiptChainId, lease.packetSha256, lease.artifactSha256, lease.readinessSnapshotSha256, JSON.stringify(item.evidenceRefs), item.observedAt, await sha256ExecutionJson(item.evidenceRefs), await sha256ExecutionJson({ externalEffect: "unknown", publishClicked: false }), now),
    db.prepare("INSERT INTO release_control_v2_command_receipts (command_id,command_type,actor_id,request_sha256,status,response_json,created_at,completed_at) VALUES (?1,'readback.append',?2,?3,'succeeded',?4,?5,?5)").bind(commandId, actor, requestSha, JSON.stringify(sanitized("READ_ONLY_PROBE_APPENDED")), now),
  ]); if (metaChanges(results[0]) !== 1 || metaChanges(results[1]) !== 1) throw new ApiError("READBACK_APPEND_NOT_PROVEN", 409);
  return sanitized("READ_ONLY_PROBE_APPENDED", { lifecyclePromotion: false });
}

export async function POST(request: Request) {
  const requestId = crypto.randomUUID();
  try {
    if (!hostExecutionEnabled(config())) throw new ApiError("HOST_EXECUTION_DISABLED", 403);
    if (request.method !== "POST") throw new ApiError("METHOD_NOT_ALLOWED", 405);
    const raw = await request.text(); if (new TextEncoder().encode(raw).byteLength > 256_000) throw new ApiError("REQUEST_TOO_LARGE", 413);
    const auth = await verifyHostRequest(request, raw, secret());
    const body: unknown = JSON.parse(raw); if (!object(body) || Object.keys(body).some((key) => !["action", "commandId", "payload"].includes(key))) throw new ApiError("COMMAND_SHAPE_INVALID");
    if (!ACTIONS.has(String(body.action)) || !ID.test(String(body.commandId)) || !object(body.payload)) throw new ApiError("COMMAND_SHAPE_INVALID");
    const db = database(), commandId = String(body.commandId), actor = `host:${auth.host}`;
    const old = await db.prepare("SELECT request_sha256,response_json,status FROM release_control_v2_command_receipts WHERE command_id=?1").bind(commandId).first<Row>();
    if (old) { if (old.request_sha256 !== auth.bodySha256) throw new ApiError("COMMAND_ID_REUSE_FORBIDDEN", 409); return response(409, { ok: false, requestId, ...sanitized("COMMAND_REPLAY_FORBIDDEN") }); }
    const data = body.action === "capability.consume" ? await consume(db, commandId, body.payload, actor, auth.bodySha256)
      : body.action === "receipt.append" ? await appendReceipt(db, commandId, body.payload, actor, auth.bodySha256)
        : await appendReadback(db, commandId, body.payload, actor, auth.bodySha256);
    return response(200, { ok: true, requestId, data });
  } catch (error) {
    const known = error instanceof ApiError ? error : error instanceof HostAuthError ? new ApiError(error.code, error.status) : new ApiError("HOST_INTERNAL_ERROR", 500);
    return response(known.status, { ok: false, requestId, error: sanitized(known.code) });
  }
}
