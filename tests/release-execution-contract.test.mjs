import assert from "node:assert/strict";
import test from "node:test";

import {
  EXECUTION_PACKET_SCHEMA_VERSION,
  MANDATORY_STOP_CONDITIONS,
  ReleaseExecutionContractError,
  createExecutionReceipt,
  createFrozenExecutionPacket,
  issueExecutionRouteAttestation,
  sha256ExecutionText,
  verifyExecutionRouteAttestation,
  validateExecutionReceipt,
} from "../app/release-execution-contract.ts";

const NOW = "2026-08-28T08:00:00.000Z";
const ROUTE_ATTESTATION_SECRET = "R".repeat(43);

async function packet(phase, allowedActions, suffix = "") {
  return createFrozenExecutionPacket({
    schemaVersion: EXECUTION_PACKET_SCHEMA_VERSION,
    executor: { role: "browser_mechanical_executor", agentProfileId: "wenmai_publish_operator" },
    runId: `run-${phase}${suffix}`, articleId: `article-${phase}${suffix}`, attempt: 1, commandId: `command-${phase}${suffix}`,
    contract: { revision: 1, sha256: "a".repeat(64) }, platform: "bilibili", releaseId: `release-${phase}${suffix}`,
    buildId: `build-${phase}${suffix}`, artifact: { path: "E:\\release\\article.docx", sha256: await sha256ExecutionText(`${phase}${suffix}`) },
    targetAccount: "owner-account", allowedHosts: ["member.bilibili.com"],
    allowedPathPrefixes: ["/platform/upload/text/edit"], phase, allowedActions,
    stopConditions: [...MANDATORY_STOP_CONDITIONS], createdAt: NOW,
  });
}

function snapshot(checkpoint) {
  return { url: "https://member.bilibili.com/platform/upload/text/edit", account: "owner-account", checkpoint };
}

async function routeAttestation(executionPacket, overrides = {}) {
  return issueExecutionRouteAttestation(executionPacket, ROUTE_ATTESTATION_SECRET, {
    routeDecisionId: "route-decision-1",
    workUnitId: "work-unit-1",
    agentType: "terra_worker",
    configuredModel: "gpt-5.6-terra",
    circuitState: "open",
    expiresAt: "2026-08-28T08:05:00.000Z",
    nonce: "r".repeat(32),
    now: new Date(NOW),
    ...overrides,
  });
}

test("publish_once 与 read_only_probe 的授权动作互斥", async () => {
  await assert.rejects(
    () => packet("read_only_probe", ["verify_bound_context", "probe_destination_record", "capture_evidence", "click_publish_once"]),
    (error) => error instanceof ReleaseExecutionContractError
      && error.errors.some((item) => item.includes("not allowed during read_only_probe")),
  );
  await assert.rejects(
    () => packet("publish_once", ["verify_bound_context", "verify_final_state", "click_publish_once", "observe_submission_result", "capture_evidence", "probe_public_access"]),
    (error) => error instanceof ReleaseExecutionContractError
      && error.errors.some((item) => item.includes("not allowed during publish_once")),
  );
});

test("未知发布结果冻结写入并强制 probe-first，且执行者不能提升 Claim", async () => {
  const publish = await packet("publish_once", [
    "verify_bound_context", "verify_final_state", "click_publish_once", "observe_submission_result", "capture_evidence",
  ]);
  const receipt = await createExecutionReceipt(publish, {
    receiptId: "receipt-unknown", action: "click_publish_once", before: snapshot("before"), after: snapshot("after"),
    result: "inconclusive", externalObservation: "unknown", publishClicked: true,
    writeDisposition: "freeze_writes", recoveryMode: "probe_first", stopReason: "external_result_unknown",
    evidenceRefs: ["evidence:click:unknown"], claimPromotions: [], routeAttestation: await routeAttestation(publish), observedAt: NOW,
  }, null, { routeAttestationSecret: ROUTE_ATTESTATION_SECRET, now: new Date(NOW) });
  assert.equal(receipt.publishClicksTotal, 1);
  assert.deepEqual(await validateExecutionReceipt(receipt, publish, null, { routeAttestationSecret: ROUTE_ATTESTATION_SECRET, now: new Date(NOW) }), { ok: true, errors: [] });

  const invalidClaim = { ...receipt, claimPromotions: ["submission_accepted"] };
  invalidClaim.receiptSha256 = await sha256ExecutionText("not-a-valid-receipt-digest");
  const claimCheck = await validateExecutionReceipt(invalidClaim, publish, null, { routeAttestationSecret: ROUTE_ATTESTATION_SECRET, now: new Date(NOW) });
  assert.equal(claimCheck.ok, false);
  assert.ok(claimCheck.errors.includes("browser mechanical executor cannot promote submission, backend, public, complete, or any other claim"));

  const invalidUnknown = { ...receipt, writeDisposition: "continue", receiptSha256: receipt.receiptSha256 };
  const unknownCheck = await validateExecutionReceipt(invalidUnknown, publish, null, { routeAttestationSecret: ROUTE_ATTESTATION_SECRET, now: new Date(NOW) });
  assert.equal(unknownCheck.ok, false);
  assert.ok(unknownCheck.errors.includes("unknown external result must freeze_writes"));
});

test("单次点击按回执链累计，第二次点击不能被接受", async () => {
  const publish = await packet("publish_once", [
    "verify_bound_context", "verify_final_state", "click_publish_once", "observe_submission_result", "capture_evidence",
  ]);
  const first = await createExecutionReceipt(publish, {
    receiptId: "receipt-first", action: "click_publish_once", before: snapshot("before"), after: snapshot("after"),
    result: "pass", externalObservation: "success_signal_observed", publishClicked: true,
    writeDisposition: "stop_writes", recoveryMode: "none", stopReason: null,
    evidenceRefs: ["evidence:click:accepted"], claimPromotions: [], routeAttestation: await routeAttestation(publish), observedAt: NOW,
  }, null, { routeAttestationSecret: ROUTE_ATTESTATION_SECRET, now: new Date(NOW) });
  await assert.rejects(
    async () => createExecutionReceipt(publish, {
      receiptId: "receipt-second", action: "click_publish_once", before: snapshot("before-2"), after: snapshot("after-2"),
      result: "pass", externalObservation: "success_signal_observed", publishClicked: true,
      writeDisposition: "stop_writes", recoveryMode: "none", stopReason: null,
      evidenceRefs: ["evidence:click:second"], claimPromotions: [], routeAttestation: await routeAttestation(publish), observedAt: NOW,
    }, first, { routeAttestationSecret: ROUTE_ATTESTATION_SECRET, now: new Date(NOW) }),
    (error) => error instanceof ReleaseExecutionContractError
      && error.errors.some((item) => item.includes("at most one publish click")),
  );
});

test("Terra 路由回执可以被记录，但模型名本身不决定 packet 授权", async () => {
  const terraPacket = await packet("read_only_probe", ["verify_bound_context", "probe_destination_record", "capture_evidence"]);
  assert.equal(terraPacket.executor.agentProfileId, "wenmai_publish_operator");
  assert.equal("modelClass" in terraPacket.executor, false);
  const receipt = await createExecutionReceipt(terraPacket, {
    receiptId: "receipt-terra", action: "probe_destination_record", before: snapshot("before"), after: snapshot("after"),
    result: "pass", externalObservation: "record_observed", publishClicked: false,
    writeDisposition: "continue", recoveryMode: "none", stopReason: null,
    evidenceRefs: ["evidence:probe:record"], claimPromotions: [], routeAttestation: await routeAttestation(terraPacket), observedAt: NOW,
  }, null, { routeAttestationSecret: ROUTE_ATTESTATION_SECRET, now: new Date(NOW) });
  assert.equal(receipt.routeAttestation.claims.configuredModel, "gpt-5.6-terra");

  const arbitraryModel = { ...receipt, routeAttestation: await routeAttestation(terraPacket, { configuredModel: "anything-safe" }) };
  const arbitraryCheck = await validateExecutionReceipt(arbitraryModel, terraPacket, null, { routeAttestationSecret: ROUTE_ATTESTATION_SECRET, now: new Date(NOW) });
  assert.equal(arbitraryCheck.ok, false, "篡改模型会破坏 digest；模型名称不是权限字段");
  assert.ok(arbitraryCheck.errors.includes("receiptSha256 does not bind the current receipt"));
});

test("缺少可信签发材料与回执链静默换路由均被拒绝", async () => {
  const probe = await packet("read_only_probe", ["verify_bound_context", "probe_public_access", "capture_evidence"]);
  await assert.rejects(
    async () => createExecutionReceipt(probe, {
      receiptId: "receipt-unverified", action: "probe_public_access", before: snapshot("before"), after: snapshot("after"),
      result: "inconclusive", externalObservation: "unknown", publishClicked: false,
      writeDisposition: "freeze_writes", recoveryMode: "probe_first", stopReason: "external_result_unknown",
      evidenceRefs: ["evidence:probe:unverified"], claimPromotions: [], routeAttestation: await routeAttestation(probe), observedAt: NOW,
    }, null, { routeAttestationSecret: "wrong-route-attestation-secret-value-123456789" , now: new Date(NOW) }),
    (error) => error instanceof ReleaseExecutionContractError
      && error.errors.some((item) => item.includes("route attestation signature verification failed")),
  );
  const first = await createExecutionReceipt(probe, {
    receiptId: "receipt-route-first", action: "probe_public_access", before: snapshot("before"), after: snapshot("after"),
    result: "inconclusive", externalObservation: "unknown", publishClicked: false,
    writeDisposition: "freeze_writes", recoveryMode: "probe_first", stopReason: "external_result_unknown",
    evidenceRefs: ["evidence:probe:first"], claimPromotions: [], routeAttestation: await routeAttestation(probe), observedAt: NOW,
  }, null, { routeAttestationSecret: ROUTE_ATTESTATION_SECRET, now: new Date(NOW) });
  await assert.rejects(
    async () => createExecutionReceipt(probe, {
      receiptId: "receipt-route-second", action: "probe_public_access", before: snapshot("before-2"), after: snapshot("after-2"),
      result: "inconclusive", externalObservation: "unknown", publishClicked: false,
      writeDisposition: "freeze_writes", recoveryMode: "probe_first", stopReason: "external_result_unknown",
      evidenceRefs: ["evidence:probe:second"], claimPromotions: [], routeAttestation: await routeAttestation(probe, { configuredModel: "gpt-5.3-spark" }), observedAt: NOW,
    }, first, { routeAttestationSecret: ROUTE_ATTESTATION_SECRET, now: new Date(NOW) }),
    (error) => error instanceof ReleaseExecutionContractError
      && error.errors.includes("routeAttestation must not change in the receipt chain"),
  );
});

test("路由证明对缺 key、过期、packet/profile/模型篡改均 fail-closed", async () => {
  const probe = await packet("read_only_probe", ["verify_bound_context", "probe_destination_record", "capture_evidence"]);
  const attestation = await routeAttestation(probe);
  const missingKey = await verifyExecutionRouteAttestation(attestation, probe, undefined, { now: new Date(NOW) });
  assert.equal(missingKey.ok, false);
  assert.ok(missingKey.errors.includes("route attestation key is unavailable"));

  const expired = await verifyExecutionRouteAttestation(attestation, probe, ROUTE_ATTESTATION_SECRET, {
    now: new Date("2026-08-28T08:05:00.001Z"),
  });
  assert.equal(expired.ok, false);
  assert.ok(expired.errors.includes("ticket has expired"));

  const otherPacket = await packet("read_only_probe", ["verify_bound_context", "probe_destination_record", "capture_evidence"], "other");
  const packetMismatch = await verifyExecutionRouteAttestation(attestation, otherPacket, ROUTE_ATTESTATION_SECRET, { now: new Date(NOW) });
  assert.equal(packetMismatch.ok, false);
  assert.ok(packetMismatch.errors.some((item) => item.includes("packetSha256 does not match")));

  const profileTamper = { ...attestation, claims: { ...attestation.claims, agentProfileId: "other_profile" } };
  const profileCheck = await verifyExecutionRouteAttestation(profileTamper, probe, ROUTE_ATTESTATION_SECRET, { now: new Date(NOW) });
  assert.equal(profileCheck.ok, false);
  assert.ok(profileCheck.errors.some((item) => item.includes("agentProfileId does not match")));
  assert.ok(profileCheck.errors.includes("route attestation signature verification failed"));

  const modelTamper = { ...attestation, claims: { ...attestation.claims, configuredModel: "gpt-5.3-spark" } };
  const modelCheck = await verifyExecutionRouteAttestation(modelTamper, probe, ROUTE_ATTESTATION_SECRET, { now: new Date(NOW) });
  assert.equal(modelCheck.ok, false);
  assert.ok(modelCheck.errors.includes("route attestation signature verification failed"));
});
