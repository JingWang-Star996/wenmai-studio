import { createHash, randomBytes } from "node:crypto";

/**
 * A deterministic, local-only contract for exercising the coordinator ->
 * Codex custom-agent boundary. It deliberately contains no provider client,
 * filesystem write, browser, or network operation.
 */
export const CODEX_NATIVE_SMOKE_PACKET_SCHEMA = "wenmai.codex-native-smoke/1.0";
export const CODEX_NATIVE_SMOKE_RESULT_SCHEMA = "wenmai.codex-native-smoke-result/1.0";
export const CODEX_NATIVE_SMOKE_OUTPUT_SCHEMA = "uppercase-labels/1.0";
export const CODEX_NATIVE_SMOKE_PROFILE_ID = "wenmai_fast_worker";
export const CODEX_NATIVE_SMOKE_MODEL = "gpt-5.6-luna";
const MAX_TTL_MS = 10 * 60 * 1000;

const INPUT_ROWS = Object.freeze([
  Object.freeze({ id: "a", label: "alpha" }),
  Object.freeze({ id: "b", label: "beta" }),
] as const);
const OUTPUT_ROWS = Object.freeze([
  Object.freeze({ id: "a", labelUpper: "ALPHA" }),
  Object.freeze({ id: "b", labelUpper: "BETA" }),
] as const);
const OUTPUT_SCHEMA = Object.freeze({ schemaVersion: CODEX_NATIVE_SMOKE_OUTPUT_SCHEMA, fields: Object.freeze(["id", "labelUpper"] as const) });
const EXPECTED_OUTPUT = Object.freeze({ schemaVersion: CODEX_NATIVE_SMOKE_OUTPUT_SCHEMA, rows: OUTPUT_ROWS });
const ALLOWED_ACTIONS = Object.freeze(["read_frozen_input", "emit_strict_json"] as const);
const FORBIDDEN_ACTIONS = Object.freeze([
  "network",
  "browser",
  "filesystem_write",
  "secret_access",
  "publish",
  "completion_claim",
] as const);
const ROUTE_RECEIPT = Object.freeze({
  agent: CODEX_NATIVE_SMOKE_PROFILE_ID,
  configured_model: CODEX_NATIVE_SMOKE_MODEL,
  sandbox: "read-only",
} as const);

export type CodexNativeSmokePacketOptions = Readonly<{ now?: Date | number; nonce?: string; profileSha256: string; expiresAt?: Date | number }>;
export type CodexNativeSmokeValidationOptions = Readonly<{ now?: Date | number; expectedProfileSha256: string; hostObservation?: unknown; knownNonces?: ReadonlySet<string> }>;
export type CodexNativeSmokePacket = Readonly<Record<string, unknown>>;
export type CodexNativeSmokeResult = Readonly<Record<string, unknown>>;
export type CodexNativeSmokeEnvelope = Readonly<Record<string, unknown>>;

export function canonicalJson(value: unknown): string {
  return JSON.stringify(value);
}

export function sha256CanonicalJson(value: unknown): string {
  return sha256Utf8(canonicalJson(value));
}
export function sha256Utf8(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }

function exactKeys(value: unknown, keys: readonly string[], label: string): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  const actual = Object.keys(value);
  if (actual.length !== keys.length || actual.some((key, index) => key !== keys[index])) {
    throw new TypeError(`${label} fields must exactly match the required order`);
  }
}

function exactValue(value: unknown, expected: unknown, label: string): void {
  if (canonicalJson(value) !== canonicalJson(expected)) {
    throw new TypeError(`${label} does not match the frozen contract`);
  }
}

function nonEmptyWorkUnitId(workUnitId: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(workUnitId)) {
    throw new TypeError("workUnitId must be a non-empty stable identifier");
  }
}

function hash(value: unknown, label: string): void { if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) throw new TypeError(`${label} must be a SHA-256 hex digest`); }
function nonce(value: unknown): void { if (typeof value !== "string" || !/^[a-f0-9]{32,}$/u.test(value) || value.length % 2 !== 0) throw new TypeError("nonce must be at least 128-bit lowercase hex"); }
function nowMs(value: Date | number | undefined): number { const parsed = value instanceof Date ? value.getTime() : value ?? Date.now(); if (!Number.isFinite(parsed)) throw new TypeError("now must be valid"); return parsed; }
function timestamp(value: unknown, label: string): number { if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) throw new TypeError(`${label} must be a UTC ISO timestamp`); const parsed = Date.parse(value); if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) throw new TypeError(`${label} must be valid`); return parsed; }

export function createCodexNativeSmokePacket(workUnitId: string, options: CodexNativeSmokePacketOptions): CodexNativeSmokePacket {
  nonEmptyWorkUnitId(workUnitId);
  hash(options.profileSha256, "profileSha256");
  const issuedMs = nowMs(options.now);
  const expiresMs = options.expiresAt instanceof Date ? options.expiresAt.getTime() : options.expiresAt ?? issuedMs + MAX_TTL_MS;
  if (!Number.isFinite(expiresMs) || expiresMs <= issuedMs || expiresMs - issuedMs > MAX_TTL_MS) throw new TypeError("expiresAt must be after issuedAt and no more than 10 minutes later");
  const input = Object.freeze({ rows: INPUT_ROWS });
  return Object.freeze({
    schemaVersion: CODEX_NATIVE_SMOKE_PACKET_SCHEMA,
    workUnitId,
    runId: `run-${workUnitId}`,
    nonce: options.nonce ?? randomBytes(32).toString("hex"),
    issuedAt: new Date(issuedMs).toISOString(),
    expiresAt: new Date(expiresMs).toISOString(),
    phase: "intermediate_fast",
    mechanicalTask: "strict_schema_transform",
    risk: "low",
    dataSensitivity: "public",
    frozenInput: true,
    candidateOnly: true,
    contentMutationRequested: false,
    agentProfileId: CODEX_NATIVE_SMOKE_PROFILE_ID,
    profileSha256: options.profileSha256,
    requiredConfiguredModel: CODEX_NATIVE_SMOKE_MODEL,
    fallbackPolicy: "deny",
    toolPolicy: "none",
    allowedReads: Object.freeze([]),
    allowedWrites: Object.freeze([]),
    networkAllowed: false,
    browserAllowed: false,
    providerAllowed: false,
    d1Allowed: false,
    externalSideEffectsAllowed: false,
    input,
    inputSha256: sha256CanonicalJson(input),
    outputSchema: CODEX_NATIVE_SMOKE_OUTPUT_SCHEMA,
    outputSchemaSha256: sha256CanonicalJson(OUTPUT_SCHEMA),
    expectedOutputSha256: sha256CanonicalJson(EXPECTED_OUTPUT),
    allowedActions: ALLOWED_ACTIONS,
    forbiddenActions: FORBIDDEN_ACTIONS,
  });
}

export function createCodexNativeSmokeEnvelope(packet: CodexNativeSmokePacket, options: CodexNativeSmokeValidationOptions): CodexNativeSmokeEnvelope {
  validateCodexNativeSmokePacket(packet, options);
  return Object.freeze({ packet, packetSha256: sha256CanonicalJson(packet) });
}

export function validateCodexNativeSmokeEnvelope(envelope: unknown, options: CodexNativeSmokeValidationOptions): asserts envelope is CodexNativeSmokeEnvelope {
  exactKeys(envelope, ["packet", "packetSha256"], "envelope");
  validateCodexNativeSmokePacket(envelope.packet, options);
  exactValue(envelope.packetSha256, sha256CanonicalJson(envelope.packet), "envelope.packetSha256");
}

export function validateCodexNativeSmokePacket(packet: unknown, options: CodexNativeSmokeValidationOptions): asserts packet is CodexNativeSmokePacket {
  exactKeys(packet, [
    "schemaVersion", "workUnitId", "runId", "nonce", "issuedAt", "expiresAt", "phase", "mechanicalTask", "risk", "dataSensitivity", "frozenInput", "candidateOnly", "contentMutationRequested", "agentProfileId", "profileSha256", "requiredConfiguredModel", "fallbackPolicy", "toolPolicy", "allowedReads", "allowedWrites", "networkAllowed", "browserAllowed", "providerAllowed", "d1Allowed", "externalSideEffectsAllowed", "input", "inputSha256", "outputSchema", "outputSchemaSha256", "expectedOutputSha256", "allowedActions", "forbiddenActions",
  ], "packet");
  nonEmptyWorkUnitId(packet.workUnitId as string);
  exactValue(packet.runId, `run-${packet.workUnitId}`, "packet.runId"); nonce(packet.nonce);
  if (options.knownNonces?.has(packet.nonce as string)) throw new TypeError("packet nonce has already been observed");
  const issuedMs = timestamp(packet.issuedAt, "packet.issuedAt"); const expiresMs = timestamp(packet.expiresAt, "packet.expiresAt"); const current = nowMs(options.now);
  if (issuedMs > current || expiresMs <= current || expiresMs <= issuedMs || expiresMs - issuedMs > MAX_TTL_MS) throw new TypeError("packet time window is invalid, future, expired, or too long");
  exactValue(packet.schemaVersion, CODEX_NATIVE_SMOKE_PACKET_SCHEMA, "packet.schemaVersion");
  exactValue(packet.phase, "intermediate_fast", "packet.phase");
  exactValue(packet.mechanicalTask, "strict_schema_transform", "packet.mechanicalTask");
  exactValue(packet.risk, "low", "packet.risk");
  exactValue(packet.dataSensitivity, "public", "packet.dataSensitivity");
  exactValue(packet.frozenInput, true, "packet.frozenInput");
  exactValue(packet.candidateOnly, true, "packet.candidateOnly");
  exactValue(packet.contentMutationRequested, false, "packet.contentMutationRequested");
  exactValue(packet.agentProfileId, CODEX_NATIVE_SMOKE_PROFILE_ID, "packet.agentProfileId"); hash(packet.profileSha256, "packet.profileSha256"); hash(options.expectedProfileSha256, "expectedProfileSha256"); exactValue(packet.profileSha256, options.expectedProfileSha256, "packet.profileSha256"); exactValue(packet.requiredConfiguredModel, CODEX_NATIVE_SMOKE_MODEL, "packet.requiredConfiguredModel"); exactValue(packet.fallbackPolicy, "deny", "packet.fallbackPolicy"); exactValue(packet.toolPolicy, "none", "packet.toolPolicy"); exactValue(packet.allowedReads, [], "packet.allowedReads"); exactValue(packet.allowedWrites, [], "packet.allowedWrites"); exactValue(packet.networkAllowed, false, "packet.networkAllowed"); exactValue(packet.browserAllowed, false, "packet.browserAllowed"); exactValue(packet.providerAllowed, false, "packet.providerAllowed"); exactValue(packet.d1Allowed, false, "packet.d1Allowed"); exactValue(packet.externalSideEffectsAllowed, false, "packet.externalSideEffectsAllowed");
  exactKeys(packet.input, ["rows"], "packet.input");
  exactValue(packet.input.rows, INPUT_ROWS, "packet.input.rows");
  exactValue(packet.inputSha256, sha256CanonicalJson(packet.input), "packet.inputSha256");
  exactValue(packet.outputSchema, CODEX_NATIVE_SMOKE_OUTPUT_SCHEMA, "packet.outputSchema");
  exactValue(packet.outputSchemaSha256, sha256CanonicalJson(OUTPUT_SCHEMA), "packet.outputSchemaSha256");
  exactValue(packet.expectedOutputSha256, sha256CanonicalJson(EXPECTED_OUTPUT), "packet.expectedOutputSha256");
  exactValue(packet.allowedActions, ALLOWED_ACTIONS, "packet.allowedActions");
  exactValue(packet.forbiddenActions, FORBIDDEN_ACTIONS, "packet.forbiddenActions");
}

export function createCodexNativeSmokeResult(envelope: CodexNativeSmokeEnvelope, options: CodexNativeSmokeValidationOptions): CodexNativeSmokeResult {
  validateCodexNativeSmokeEnvelope(envelope, options);
  const packet = envelope.packet as CodexNativeSmokePacket;
  const output = EXPECTED_OUTPUT;
  return Object.freeze({
    schemaVersion: CODEX_NATIVE_SMOKE_RESULT_SCHEMA,
    workUnitId: packet.workUnitId,
    packetSha256: envelope.packetSha256,
    output,
    outputSha256: packet.expectedOutputSha256,
    result: "candidate_only",
    files_written: Object.freeze([]) as readonly [],
    tool_calls: Object.freeze([]),
    routeReceipt: ROUTE_RECEIPT,
    routeReceiptVerification: "profile_reported_not_host_attested",
  });
}

export function validateCodexNativeSmokeResult(envelope: unknown, result: unknown, options: CodexNativeSmokeValidationOptions): Readonly<Record<string, unknown>> {
  validateCodexNativeSmokeEnvelope(envelope, options);
  const packet = envelope.packet as CodexNativeSmokePacket;
  exactKeys(result, [
    "schemaVersion", "workUnitId", "packetSha256", "output", "outputSha256", "result", "files_written",
    "tool_calls", "routeReceipt", "routeReceiptVerification",
  ], "result");
  exactValue(result.schemaVersion, CODEX_NATIVE_SMOKE_RESULT_SCHEMA, "result.schemaVersion");
  exactValue(result.workUnitId, packet.workUnitId, "result.workUnitId");
  exactValue(result.packetSha256, envelope.packetSha256, "result.packetSha256");
  exactKeys(result.output, ["schemaVersion", "rows"], "result.output");
  exactValue(result.output.schemaVersion, CODEX_NATIVE_SMOKE_OUTPUT_SCHEMA, "result.output.schemaVersion");
  exactValue(result.output, EXPECTED_OUTPUT, "result.output");
  exactValue(result.outputSha256, packet.expectedOutputSha256, "result.outputSha256");
  exactValue(result.result, "candidate_only", "result.result");
  exactValue(result.files_written, [], "result.files_written");
  exactValue(result.tool_calls, [], "result.tool_calls");
  exactValue(result.routeReceipt, ROUTE_RECEIPT, "result.routeReceipt");
  exactValue(result.routeReceiptVerification, "profile_reported_not_host_attested", "result.routeReceiptVerification");
  return Object.freeze({
    packetSha256: result.packetSha256 as string,
    outputSha256: result.outputSha256 as string,
    result: "candidate_only", filesWritten: Object.freeze([]), actualModelVerification: "unverified", nonceUniquenessVerification: "unverified", toolUseVerification: "profile_reported_zero_not_host_attested", hostObservationProvided: options.hostObservation !== undefined,
  });
}
