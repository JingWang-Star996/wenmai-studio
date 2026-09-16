import assert from "node:assert/strict";
import test from "node:test";

import {
  PUBLISH_BATCH_CONFIRMATION_SCHEMA_VERSION,
  canonicalPublishCommandRequest,
  publishCapabilityBindings,
  safePublishConsumptionResponse,
  validatePublishBatchConfirmation,
} from "../app/publish-capability-core.ts";
import {
  EXECUTION_PACKET_SCHEMA_VERSION,
  MANDATORY_STOP_CONDITIONS,
  createFrozenExecutionPacket,
  issuePublishCapabilityTicket,
  sha256ExecutionText,
  verifyPublishCapabilityTicket,
} from "../app/release-execution-contract.ts";
import { createRuntimeAuthentication } from "../scripts/run-vinext.mjs";

const FIXED_NOW = new Date("2026-08-25T08:00:00.000Z");
const HMAC_SECRET = "A".repeat(43);

async function packet(suffix = "base") {
  return createFrozenExecutionPacket({
    schemaVersion: EXECUTION_PACKET_SCHEMA_VERSION,
    executor: { role: "browser_mechanical_executor", agentProfileId: "wenmai_publish_operator" },
    runId: `run-${suffix}`,
    articleId: `article-${suffix}`,
    attempt: 1,
    commandId: `packet-command-${suffix}`,
    contract: { revision: 1, sha256: "1".repeat(64) },
    platform: "bilibili",
    releaseId: `release-${suffix}`,
    buildId: `build-${suffix}`,
    artifact: {
      path: `E:\\releases\\${suffix}.docx`,
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
    createdAt: FIXED_NOW.toISOString(),
  });
}

function confirmation(executionPacket, overrides = {}) {
  return {
    schemaVersion: PUBLISH_BATCH_CONFIRMATION_SCHEMA_VERSION,
    decision: "publish_once_confirmed",
    confirmedAt: FIXED_NOW.toISOString(),
    executionPacketSha256: executionPacket.packetSha256,
    runId: executionPacket.runId,
    articleId: executionPacket.articleId,
    attempt: executionPacket.attempt,
    packetCommandId: executionPacket.commandId,
    platform: executionPacket.platform,
    releaseId: executionPacket.releaseId,
    buildId: executionPacket.buildId,
    artifactSha256: executionPacket.artifact.sha256,
    targetAccount: executionPacket.targetAccount,
    maxClicks: 1,
    ...overrides,
  };
}

test("当前批次显式确认精确绑定执行包，任一 article/release/artifact/account 偏差均拒绝", async () => {
  const executionPacket = await packet();
  const accepted = validatePublishBatchConfirmation(confirmation(executionPacket), executionPacket, { now: FIXED_NOW });
  assert.deepEqual(accepted, { ok: true, errors: [] });

  for (const override of [
    { articleId: "article-other" },
    { releaseId: "release-other" },
    { artifactSha256: "2".repeat(64) },
    { targetAccount: "other-account" },
    { maxClicks: 2 },
  ]) {
    const rejected = validatePublishBatchConfirmation(confirmation(executionPacket, override), executionPacket, { now: FIXED_NOW });
    assert.equal(rejected.ok, false);
  }
  const stale = validatePublishBatchConfirmation(
    confirmation(executionPacket, { confirmedAt: "2026-08-25T07:44:59.000Z" }),
    executionPacket,
    { now: FIXED_NOW },
  );
  assert.equal(stale.ok, false);
  assert.ok(stale.errors.includes("confirmation is no longer current"));
});

test("票据签发、绑定偏差与过期由 release execution contract 重新校验", async () => {
  const executionPacket = await packet("ticket");
  const ticket = await issuePublishCapabilityTicket(executionPacket, HMAC_SECRET, {
    now: FIXED_NOW,
    expiresAt: "2026-08-25T08:01:00.000Z",
  });
  const verified = await verifyPublishCapabilityTicket(ticket, executionPacket, HMAC_SECRET, { now: FIXED_NOW });
  assert.equal(verified.ok, true);
  assert.equal(verified.persistentConsumption?.mechanism, "d1_cas_insert_if_absent");
  assert.match(verified.nonceSha256, /^[a-f0-9]{64}$/u);

  const otherPacket = await packet("other");
  const mismatch = await verifyPublishCapabilityTicket(ticket, otherPacket, HMAC_SECRET, { now: FIXED_NOW });
  assert.equal(mismatch.ok, false);
  assert.ok(mismatch.errors.some((error) => error.includes("does not match the execution packet")));

  const expired = await verifyPublishCapabilityTicket(ticket, executionPacket, HMAC_SECRET, {
    now: new Date("2026-08-25T08:01:00.001Z"),
  });
  assert.equal(expired.ok, false);
  assert.ok(expired.errors.includes("ticket has expired"));
});

test("消费回执只证明授权已消费，绝不提升点击、提交、公开或完成 Claim", async () => {
  const executionPacket = await packet("safe-receipt");
  const response = safePublishConsumptionResponse({
    capabilityId: "publish-capability-12345678-1234-4123-8123-123456789abc",
    bindings: publishCapabilityBindings(executionPacket),
    issuedAt: "2026-08-25T07:59:00.000Z",
    expiresAt: "2026-08-25T08:05:00.000Z",
    consumedAt: FIXED_NOW.toISOString(),
    commandId: "consume-safe-receipt",
    requestSha256: "3".repeat(64),
  });
  assert.equal(response.attestation.state, "consumed");
  assert.equal(response.attestation.articleId, executionPacket.articleId);
  assert.equal(response.attestation.maxClicks, 1);
  assert.equal(response.receipt.authorizationConsumed, true);
  for (const field of [
    "externalActionPerformed",
    "publishClicked",
    "submissionAccepted",
    "destinationRecordVerified",
    "publicAccessVerified",
    "outcomeVerified",
    "completionDeclared",
  ]) {
    assert.equal(response.receipt[field], false, field);
  }
  const canonical = canonicalPublishCommandRequest({
    action: "consume",
    commandId: "consume-safe-receipt",
    payload: { capabilityId: response.capabilityId },
  });
  assert.equal(canonical, "{\"action\":\"consume\",\"commandId\":\"consume-safe-receipt\",\"payload\":{\"capabilityId\":\"publish-capability-12345678-1234-4123-8123-123456789abc\"}}");
});

test("启动器为每次 serving 启动覆盖生成独立 32-byte HMAC key，且不输出密钥", () => {
  const runs = [];
  for (let index = 0; index < 2; index += 1) {
    const environment = { WENMAI_PUBLISH_CAPABILITY_HMAC_KEY: "preexisting-value" };
    let output = "";
    createRuntimeAuthentication(environment, { write: (value) => { output += String(value); } }, {
      cwd: process.cwd(),
      platform: "win32",
      persistLocalImportCredentialImpl: () => ({ credentialPath: "memory-only" }),
    });
    assert.match(environment.WENMAI_PUBLISH_CAPABILITY_HMAC_KEY, /^[A-Za-z0-9_-]{43}$/u);
    assert.notEqual(environment.WENMAI_PUBLISH_CAPABILITY_HMAC_KEY, "preexisting-value");
    assert.equal(output.includes(environment.WENMAI_PUBLISH_CAPABILITY_HMAC_KEY), false);
    runs.push(environment.WENMAI_PUBLISH_CAPABILITY_HMAC_KEY);
  }
  assert.notEqual(runs[0], runs[1]);
});
