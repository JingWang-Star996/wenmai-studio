import {
  canonicalExecutionJson,
  type FrozenExecutionPacket,
} from "./release-execution-contract.ts";

export const PUBLISH_BATCH_CONFIRMATION_SCHEMA_VERSION = "wenmai.publish-batch-confirmation/1.0";
export const PUBLISH_CAPABILITY_API_VERSION = "wenmai.publish-capability-api/1.0";

const MAX_CONFIRMATION_AGE_MS = 15 * 60_000;
const MAX_CLOCK_SKEW_MS = 5 * 60_000;

export type PublishBatchConfirmation = {
  schemaVersion: typeof PUBLISH_BATCH_CONFIRMATION_SCHEMA_VERSION;
  decision: "publish_once_confirmed";
  confirmedAt: string;
  executionPacketSha256: string;
  runId: string;
  articleId: string;
  attempt: number;
  packetCommandId: string;
  platform: string;
  releaseId: string;
  buildId: string;
  artifactSha256: string;
  targetAccount: string;
  maxClicks: 1;
};

export type PublishCapabilityBindings = {
  executionPacketSha256: string;
  runId: string;
  articleId: string;
  attempt: number;
  packetCommandId: string;
  contractRevision: number;
  contractSha256: string;
  platform: string;
  releaseId: string;
  buildId: string;
  artifactSha256: string;
  targetAccount: string;
  action: "publish";
  maxClicks: 1;
};

export type SafePublishConsumptionResponse = {
  schemaVersion: typeof PUBLISH_CAPABILITY_API_VERSION;
  capabilityId: string;
  attestation: PublishCapabilityBindings & {
    state: "consumed";
    singleUse: true;
    issuedAt: string;
    expiresAt: string;
    consumedAt: string;
    consumerRole: "super_admin";
  };
  receipt: {
    commandId: string;
    requestSha256: string;
    replayed: boolean;
    authorizationConsumed: true;
    externalActionPerformed: false;
    publishClicked: false;
    submissionAccepted: false;
    destinationRecordVerified: false;
    publicAccessVerified: false;
    outcomeVerified: false;
    completionDeclared: false;
  };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], label: string, errors: string[]) {
  const expectedSet = new Set(expected);
  for (const key of Object.keys(value)) {
    if (!expectedSet.has(key)) errors.push(`${label} contains unknown field: ${key}`);
  }
  for (const key of expected) {
    if (!(key in value)) errors.push(`${label} is missing field: ${key}`);
  }
}

function isIsoWithTimezone(value: unknown): value is string {
  return typeof value === "string"
    && /(?:Z|[+-]\d{2}:\d{2})$/iu.test(value)
    && Number.isFinite(Date.parse(value));
}

export function publishCapabilityBindings(packet: FrozenExecutionPacket): PublishCapabilityBindings {
  return {
    executionPacketSha256: packet.packetSha256,
    runId: packet.runId,
    articleId: packet.articleId,
    attempt: packet.attempt,
    packetCommandId: packet.commandId,
    contractRevision: packet.contract.revision,
    contractSha256: packet.contract.sha256,
    platform: packet.platform,
    releaseId: packet.releaseId,
    buildId: packet.buildId,
    artifactSha256: packet.artifact.sha256,
    targetAccount: packet.targetAccount,
    action: "publish",
    maxClicks: 1,
  };
}

export function validatePublishBatchConfirmation(
  value: unknown,
  packet: FrozenExecutionPacket,
  options: { now?: Date } = {},
) {
  const errors: string[] = [];
  if (!isRecord(value)) return { ok: false, errors: ["confirmation must be an object"] };
  exactKeys(value, [
    "schemaVersion", "decision", "confirmedAt", "executionPacketSha256", "runId", "articleId", "attempt",
    "packetCommandId", "platform", "releaseId", "buildId", "artifactSha256", "targetAccount", "maxClicks",
  ], "confirmation", errors);
  if (value.schemaVersion !== PUBLISH_BATCH_CONFIRMATION_SCHEMA_VERSION) {
    errors.push("confirmation schemaVersion is invalid");
  }
  if (value.decision !== "publish_once_confirmed") {
    errors.push("confirmation decision must be publish_once_confirmed");
  }
  if (value.maxClicks !== 1) errors.push("confirmation maxClicks must be exactly 1");
  if (!isIsoWithTimezone(value.confirmedAt)) {
    errors.push("confirmation confirmedAt must be an ISO timestamp with timezone");
  } else {
    const nowMs = (options.now ?? new Date()).getTime();
    const confirmedMs = Date.parse(value.confirmedAt);
    if (confirmedMs < nowMs - MAX_CONFIRMATION_AGE_MS) errors.push("confirmation is no longer current");
    if (confirmedMs > nowMs + MAX_CLOCK_SKEW_MS) errors.push("confirmation confirmedAt is too far in the future");
  }
  const expected = publishCapabilityBindings(packet);
  const bindings: Array<[string, unknown, unknown]> = [
    ["executionPacketSha256", value.executionPacketSha256, expected.executionPacketSha256],
    ["runId", value.runId, expected.runId],
    ["articleId", value.articleId, expected.articleId],
    ["attempt", value.attempt, expected.attempt],
    ["packetCommandId", value.packetCommandId, expected.packetCommandId],
    ["platform", value.platform, expected.platform],
    ["releaseId", value.releaseId, expected.releaseId],
    ["buildId", value.buildId, expected.buildId],
    ["artifactSha256", value.artifactSha256, expected.artifactSha256],
    ["targetAccount", value.targetAccount, expected.targetAccount],
  ];
  for (const [label, actual, expectedValue] of bindings) {
    if (actual !== expectedValue) errors.push(`confirmation ${label} does not match the execution packet`);
  }
  return { ok: errors.length === 0, errors };
}

export function canonicalPublishCommandRequest(value: {
  action: "issue" | "consume";
  commandId: string;
  payload: Record<string, unknown>;
}) {
  return canonicalExecutionJson(value);
}

export function safePublishConsumptionResponse(input: {
  capabilityId: string;
  bindings: PublishCapabilityBindings;
  issuedAt: string;
  expiresAt: string;
  consumedAt: string;
  commandId: string;
  requestSha256: string;
  replayed?: boolean;
}): SafePublishConsumptionResponse {
  return {
    schemaVersion: PUBLISH_CAPABILITY_API_VERSION,
    capabilityId: input.capabilityId,
    attestation: {
      state: "consumed",
      singleUse: true,
      ...input.bindings,
      issuedAt: input.issuedAt,
      expiresAt: input.expiresAt,
      consumedAt: input.consumedAt,
      consumerRole: "super_admin",
    },
    receipt: {
      commandId: input.commandId,
      requestSha256: input.requestSha256,
      replayed: input.replayed ?? false,
      authorizationConsumed: true,
      externalActionPerformed: false,
      publishClicked: false,
      submissionAccepted: false,
      destinationRecordVerified: false,
      publicAccessVerified: false,
      outcomeVerified: false,
      completionDeclared: false,
    },
  };
}
