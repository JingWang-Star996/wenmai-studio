export const EXECUTION_PACKET_SCHEMA_VERSION = "wenmai.release-execution-packet/2.0";
export const EXECUTION_RECEIPT_SCHEMA_VERSION = "wenmai.release-execution-receipt/2.1";
export const PUBLISH_CAPABILITY_SCHEMA_VERSION = "wenmai.publish-capability/1.0";
export const ROUTE_ATTESTATION_SCHEMA_VERSION = "wenmai.execution-route-attestation/1.0";
export const WENMAI_PUBLISH_OPERATOR_PROFILE_ID = "wenmai_publish_operator";

export const EXECUTION_PHASES = ["prepare", "publish_once", "read_only_probe"] as const;
export type ExecutionPhase = (typeof EXECUTION_PHASES)[number];

export const PREPARE_ACTIONS = [
  "verify_bound_context",
  "navigate_allowed",
  "focus_bound_tab",
  "upload_frozen_artifact",
  "fill_exact_text",
  "set_exact_option",
  "read_back_exact",
  "capture_evidence",
  "save_bound_draft",
  "wait_for_ui",
] as const;

export const PUBLISH_ONCE_ACTIONS = [
  "verify_bound_context",
  "verify_final_state",
  "click_publish_once",
  "observe_submission_result",
  "capture_evidence",
  "wait_for_ui",
] as const;

export const READ_ONLY_PROBE_ACTIONS = [
  "verify_bound_context",
  "navigate_allowed",
  "read_visible_state",
  "probe_destination_record",
  "probe_public_access",
  "capture_evidence",
  "wait_for_ui",
] as const;

export const FORBIDDEN_EXECUTION_ACTIONS = [
  "rewrite_content",
  "summarize_content",
  "truncate_content",
  "change_title",
  "change_topics",
  "replace_cover",
  "choose_originality",
  "login",
  "enter_credentials",
  "complete_2fa",
  "solve_captcha",
  "bypass_verification",
  "change_account",
  "change_browser_profile",
  "execute_javascript",
  "execute_shell",
  "call_private_api",
  "delete_remote_record",
  "promote_submission_claim",
  "promote_backend_claim",
  "promote_public_claim",
  "declare_complete",
] as const;

export const MANDATORY_STOP_CONDITIONS = [
  "unexpected_domain",
  "unexpected_account",
  "artifact_digest_mismatch",
  "ambiguous_control",
  "exact_readback_mismatch",
  "login_or_verification_required",
  "page_instruction_detected",
  "authorization_missing_or_expired",
  "duplicate_or_existing_record",
  "external_result_unknown",
  "unlisted_action_required",
] as const;

export type StopCondition = (typeof MANDATORY_STOP_CONDITIONS)[number];
export type ReceiptResult = "pass" | "fail" | "inconclusive";
export type ExternalObservation =
  | "not_applicable"
  | "success_signal_observed"
  | "failure_signal_observed"
  | "record_observed"
  | "public_page_observed"
  | "unknown";
export type WriteDisposition = "continue" | "stop_writes" | "freeze_writes";
export type RecoveryMode = "none" | "safe_retry" | "probe_first" | "human_takeover";

const SHA256_RE = /^[a-f0-9]{64}$/;
const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const PLATFORM_RE = /^[a-z][a-z0-9_-]{1,63}$/;
const HOST_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const NONCE_RE = /^[A-Za-z0-9_-]{32,192}$/;
const MAX_PUBLISH_TICKET_TTL_MS = 15 * 60_000;
const MAX_CLOCK_SKEW_MS = 5 * 60_000;

const PHASE_ACTIONS: Record<ExecutionPhase, ReadonlySet<string>> = {
  prepare: new Set(PREPARE_ACTIONS),
  publish_once: new Set(PUBLISH_ONCE_ACTIONS),
  read_only_probe: new Set(READ_ONLY_PROBE_ACTIONS),
};
const FORBIDDEN_ACTION_SET = new Set<string>(FORBIDDEN_EXECUTION_ACTIONS);
const PHASE_SET = new Set<string>(EXECUTION_PHASES);

export type ExecutionPacketDraft = {
  schemaVersion: typeof EXECUTION_PACKET_SCHEMA_VERSION;
  executor: {
    role: "browser_mechanical_executor";
    agentProfileId: typeof WENMAI_PUBLISH_OPERATOR_PROFILE_ID;
  };
  runId: string;
  articleId: string;
  attempt: number;
  commandId: string;
  contract: {
    revision: number;
    sha256: string;
  };
  platform: string;
  releaseId: string;
  buildId: string;
  artifact: {
    path: string;
    sha256: string;
  };
  targetAccount: string;
  allowedHosts: string[];
  allowedPathPrefixes: string[];
  phase: ExecutionPhase;
  allowedActions: string[];
  stopConditions: StopCondition[];
  createdAt: string;
};

export type FrozenExecutionPacket = ExecutionPacketDraft & {
  packetSha256: string;
};

export type PublishCapabilityClaims = {
  schemaVersion: typeof PUBLISH_CAPABILITY_SCHEMA_VERSION;
  executionPacketSha256: string;
  runId: string;
  articleId: string;
  attempt: number;
  commandId: string;
  contractRevision: number;
  contractSha256: string;
  platform: string;
  releaseId: string;
  buildId: string;
  artifactSha256: string;
  targetAccount: string;
  action: "publish";
  maxClicks: 1;
  issuedAt: string;
  expiresAt: string;
  nonce: string;
};

export type PublishCapabilityTicket = {
  schemaVersion: typeof PUBLISH_CAPABILITY_SCHEMA_VERSION;
  claims: PublishCapabilityClaims;
  signature: string;
};

export type PublishCapabilityVerification = {
  ok: boolean;
  errors: string[];
  nonceSha256: string | null;
  persistentConsumption: null | {
    required: true;
    mechanism: "d1_cas_insert_if_absent";
    nonceSha256: string;
    expected: "absent";
    next: "consumed";
  };
};

export type ExecutionStateSnapshot = {
  url: string;
  account: string;
  checkpoint: string;
};

export const ROUTE_RECEIPT_CIRCUIT_STATES = [
  "closed", "open", "half_open", "disabled", "not_applicable", "unknown",
] as const;
export type RouteReceiptCircuitState = (typeof ROUTE_RECEIPT_CIRCUIT_STATES)[number];
const ROUTE_RECEIPT_CIRCUIT_STATE_SET = new Set<string>(ROUTE_RECEIPT_CIRCUIT_STATES);

/** Route evidence is recorded separately; a model name never grants permission. */
export type ExecutionRouteReceipt = {
  schemaVersion: typeof ROUTE_ATTESTATION_SCHEMA_VERSION;
  routeDecisionId: string;
  workUnitId: string;
  agentProfileId: typeof WENMAI_PUBLISH_OPERATOR_PROFILE_ID;
  agentType: string;
  configuredModel: string;
  circuitState: RouteReceiptCircuitState;
  issuedAt: string;
  expiresAt: string;
  nonce: string;
  packetSha256: string;
};

export type ExecutionRouteAttestation = {
  schemaVersion: typeof ROUTE_ATTESTATION_SCHEMA_VERSION;
  claims: ExecutionRouteReceipt;
  signature: string;
};

export type ExecutionReceiptInput = {
  receiptId: string;
  action: string;
  before: ExecutionStateSnapshot;
  after: ExecutionStateSnapshot;
  result: ReceiptResult;
  externalObservation: ExternalObservation;
  publishClicked: boolean;
  writeDisposition: WriteDisposition;
  recoveryMode: RecoveryMode;
  stopReason: StopCondition | null;
  evidenceRefs: string[];
  claimPromotions: string[];
  routeAttestation: ExecutionRouteAttestation;
  observedAt: string;
};

export type ExecutionReceipt = ExecutionReceiptInput & {
  schemaVersion: typeof EXECUTION_RECEIPT_SCHEMA_VERSION;
  packetSha256: string;
  runId: string;
  attempt: number;
  commandId: string;
  platform: string;
  releaseId: string;
  buildId: string;
  artifactSha256: string;
  phase: ExecutionPhase;
  sequence: number;
  previousReceiptSha256: string | null;
  publishClicksTotal: number;
  receiptSha256: string;
};

export type ContractValidation = {
  ok: boolean;
  errors: string[];
};

export class ReleaseExecutionContractError extends Error {
  readonly errors: string[];

  constructor(errors: string[]) {
    super(errors.join("; "));
    this.name = "ReleaseExecutionContractError";
    this.errors = [...errors];
  }
}

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
    && /(?:Z|[+-]\d{2}:\d{2})$/i.test(value)
    && Number.isFinite(Date.parse(value));
}

function duplicateValues(values: readonly string[]) {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return [...duplicates];
}

function validAbsoluteArtifactPath(value: unknown): value is string {
  if (typeof value !== "string" || !value.trim() || /[\0\r\n]/.test(value)) return false;
  const absolute = /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("/");
  if (!absolute) return false;
  return !value.split(/[\\/]+/).some((segment) => segment === "..");
}

function validAllowedHost(value: unknown): value is string {
  return typeof value === "string"
    && value === value.toLowerCase()
    && HOST_RE.test(value)
    && !value.includes("*")
    && !value.includes(":");
}

function validAllowedPathPrefix(value: unknown): value is string {
  return typeof value === "string"
    && value.startsWith("/")
    && !value.includes("\\")
    && !value.includes("?")
    && !value.includes("#")
    && !value.includes("*")
    && !value.split("/").some((segment) => segment === "..");
}

export function canonicalExecutionJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("canonical JSON does not allow non-finite numbers");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalExecutionJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => {
      const child = value[key];
      if (child === undefined) throw new TypeError(`canonical JSON does not allow undefined: ${key}`);
      return `${JSON.stringify(key)}:${canonicalExecutionJson(child)}`;
    }).join(",")}}`;
  }
  throw new TypeError(`canonical JSON does not allow ${typeof value}`);
}

function bytesToHex(bytes: Uint8Array) {
  return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(value: string) {
  if (!/^[a-f0-9]+$/.test(value) || value.length % 2 !== 0) return null;
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < value.length; index += 2) {
    bytes[index / 2] = Number.parseInt(value.slice(index, index + 2), 16);
  }
  return bytes;
}

export async function sha256ExecutionText(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return bytesToHex(new Uint8Array(digest));
}

export async function sha256ExecutionJson(value: unknown) {
  return sha256ExecutionText(canonicalExecutionJson(value));
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export function validateExecutionPacketDraft(value: unknown): ContractValidation {
  const errors: string[] = [];
  if (!isRecord(value)) return { ok: false, errors: ["execution packet must be an object"] };
  exactKeys(value, [
    "schemaVersion", "executor", "runId", "articleId", "attempt", "commandId", "contract", "platform",
    "releaseId", "buildId", "artifact", "targetAccount", "allowedHosts", "allowedPathPrefixes",
    "phase", "allowedActions", "stopConditions", "createdAt",
  ], "execution packet", errors);

  if (value.schemaVersion !== EXECUTION_PACKET_SCHEMA_VERSION) errors.push("execution packet schemaVersion is invalid");
  if (!isRecord(value.executor)) {
    errors.push("executor must be an object");
  } else {
    exactKeys(value.executor, ["role", "agentProfileId"], "executor", errors);
    if (value.executor.role !== "browser_mechanical_executor") errors.push("executor role must be browser_mechanical_executor");
    if (value.executor.agentProfileId !== WENMAI_PUBLISH_OPERATOR_PROFILE_ID) errors.push("executor agentProfileId must be wenmai_publish_operator");
  }
  for (const [label, item] of [["runId", value.runId], ["articleId", value.articleId], ["commandId", value.commandId], ["releaseId", value.releaseId], ["buildId", value.buildId]] as const) {
    if (typeof item !== "string" || !SAFE_ID_RE.test(item)) errors.push(`${label} is invalid`);
  }
  if (!Number.isSafeInteger(value.attempt) || Number(value.attempt) < 1) errors.push("attempt must be a positive integer");
  if (!isRecord(value.contract)) {
    errors.push("contract must be an object");
  } else {
    exactKeys(value.contract, ["revision", "sha256"], "contract", errors);
    if (!Number.isSafeInteger(value.contract.revision) || Number(value.contract.revision) < 1) errors.push("contract revision must be a positive integer");
    if (typeof value.contract.sha256 !== "string" || !SHA256_RE.test(value.contract.sha256)) errors.push("contract sha256 is invalid");
  }
  if (typeof value.platform !== "string" || !PLATFORM_RE.test(value.platform)) errors.push("platform is invalid");
  if (!isRecord(value.artifact)) {
    errors.push("artifact must be an object");
  } else {
    exactKeys(value.artifact, ["path", "sha256"], "artifact", errors);
    if (!validAbsoluteArtifactPath(value.artifact.path)) errors.push("artifact path must be an absolute path without parent traversal");
    if (typeof value.artifact.sha256 !== "string" || !SHA256_RE.test(value.artifact.sha256)) errors.push("artifact sha256 is invalid");
  }
  if (typeof value.targetAccount !== "string" || !value.targetAccount.trim() || value.targetAccount !== value.targetAccount.trim()) {
    errors.push("targetAccount must be a non-empty exact value");
  }
  if (!Array.isArray(value.allowedHosts) || value.allowedHosts.length === 0 || !value.allowedHosts.every(validAllowedHost)) {
    errors.push("allowedHosts must contain exact lowercase hosts without schemes, ports, or wildcards");
  } else if (duplicateValues(value.allowedHosts).length) {
    errors.push("allowedHosts must not contain duplicates");
  }
  if (!Array.isArray(value.allowedPathPrefixes) || value.allowedPathPrefixes.length === 0 || !value.allowedPathPrefixes.every(validAllowedPathPrefix)) {
    errors.push("allowedPathPrefixes must contain absolute safe path prefixes");
  } else if (duplicateValues(value.allowedPathPrefixes).length) {
    errors.push("allowedPathPrefixes must not contain duplicates");
  }
  const phase = typeof value.phase === "string" && PHASE_SET.has(value.phase) ? value.phase as ExecutionPhase : null;
  if (!phase) errors.push("phase is invalid");
  const actions = Array.isArray(value.allowedActions) && value.allowedActions.every((item) => typeof item === "string")
    ? value.allowedActions as string[]
    : null;
  if (!actions || actions.length === 0) {
    errors.push("allowedActions must be a non-empty string array");
  } else {
    const duplicates = duplicateValues(actions);
    if (duplicates.length) errors.push(`allowedActions contains duplicates: ${duplicates.join(",")}`);
    for (const action of actions) {
      if (FORBIDDEN_ACTION_SET.has(action)) errors.push(`allowedActions contains forbidden action: ${action}`);
      if (phase && !PHASE_ACTIONS[phase].has(action)) errors.push(`action ${action} is not allowed during ${phase}`);
    }
    if (phase === "prepare") {
      for (const required of ["verify_bound_context", "read_back_exact", "capture_evidence"]) {
        if (!actions.includes(required)) errors.push(`prepare requires action: ${required}`);
      }
    }
    if (phase === "publish_once") {
      for (const required of ["verify_bound_context", "verify_final_state", "click_publish_once", "observe_submission_result", "capture_evidence"]) {
        if (!actions.includes(required)) errors.push(`publish_once requires action: ${required}`);
      }
      if (actions.filter((action) => action === "click_publish_once").length !== 1) {
        errors.push("publish_once must authorize exactly one click_publish_once action");
      }
    }
    if (phase === "read_only_probe") {
      for (const required of ["verify_bound_context", "capture_evidence"]) {
        if (!actions.includes(required)) errors.push(`read_only_probe requires action: ${required}`);
      }
      if (!actions.some((action) => action === "probe_destination_record" || action === "probe_public_access")) {
        errors.push("read_only_probe requires at least one probe action");
      }
    }
  }
  const stopConditions = Array.isArray(value.stopConditions) && value.stopConditions.every((item) => typeof item === "string")
    ? value.stopConditions as string[]
    : null;
  if (!stopConditions) {
    errors.push("stopConditions must be a string array");
  } else {
    if (duplicateValues(stopConditions).length) errors.push("stopConditions must not contain duplicates");
    for (const required of MANDATORY_STOP_CONDITIONS) {
      if (!stopConditions.includes(required)) errors.push(`stopConditions is missing mandatory condition: ${required}`);
    }
    for (const condition of stopConditions) {
      if (!(MANDATORY_STOP_CONDITIONS as readonly string[]).includes(condition)) errors.push(`stopConditions contains unknown condition: ${condition}`);
    }
  }
  if (!isIsoWithTimezone(value.createdAt)) errors.push("createdAt must be an ISO timestamp with timezone");
  return { ok: errors.length === 0, errors };
}

export async function createFrozenExecutionPacket(draft: ExecutionPacketDraft): Promise<FrozenExecutionPacket> {
  const cloned = cloneJson(draft);
  const validation = validateExecutionPacketDraft(cloned);
  if (!validation.ok) throw new ReleaseExecutionContractError(validation.errors);
  const packetSha256 = await sha256ExecutionJson(cloned);
  return deepFreeze({ ...cloned, packetSha256 });
}

export async function validateFrozenExecutionPacket(value: unknown): Promise<ContractValidation> {
  if (!isRecord(value)) return { ok: false, errors: ["frozen execution packet must be an object"] };
  const errors: string[] = [];
  exactKeys(value, [
    "schemaVersion", "executor", "runId", "articleId", "attempt", "commandId", "contract", "platform",
    "releaseId", "buildId", "artifact", "targetAccount", "allowedHosts", "allowedPathPrefixes",
    "phase", "allowedActions", "stopConditions", "createdAt", "packetSha256",
  ], "frozen execution packet", errors);
  const { packetSha256, ...draft } = value;
  const draftValidation = validateExecutionPacketDraft(draft);
  errors.push(...draftValidation.errors);
  if (typeof packetSha256 !== "string" || !SHA256_RE.test(packetSha256)) {
    errors.push("packetSha256 is invalid");
  } else {
    try {
      const expected = await sha256ExecutionJson(draft);
      if (expected !== packetSha256) errors.push("packetSha256 does not bind the current packet");
    } catch (error) {
      errors.push(`packet canonicalization failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { ok: errors.length === 0, errors };
}

function pathMatchesPrefix(pathname: string, prefix: string) {
  if (prefix === "/") return true;
  if (prefix.endsWith("/")) return pathname.startsWith(prefix);
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

export function isExecutionUrlAllowed(packet: Pick<FrozenExecutionPacket, "allowedHosts" | "allowedPathPrefixes">, value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "https:"
      && !url.username
      && !url.password
      && (!url.port || url.port === "443")
      && packet.allowedHosts.includes(url.hostname.toLowerCase())
      && packet.allowedPathPrefixes.some((prefix) => pathMatchesPrefix(url.pathname, prefix));
  } catch {
    return false;
  }
}

function secretBytes(secret: string | Uint8Array) {
  const bytes = typeof secret === "string" ? new TextEncoder().encode(secret) : new Uint8Array(secret);
  if (bytes.byteLength < 32) throw new Error("publish capability HMAC secret must contain at least 32 bytes");
  return bytes;
}

async function importHmacKey(secret: string | Uint8Array, usages: KeyUsage[]) {
  const bytes = secretBytes(secret);
  const raw = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  return crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, usages);
}

function randomNonce() {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
}

function validateTicketTime(issuedAt: string, expiresAt: string, nowMs: number, errors: string[]) {
  if (!isIsoWithTimezone(issuedAt)) errors.push("ticket issuedAt must be an ISO timestamp with timezone");
  if (!isIsoWithTimezone(expiresAt)) errors.push("ticket expiresAt must be an ISO timestamp with timezone");
  if (!isIsoWithTimezone(issuedAt) || !isIsoWithTimezone(expiresAt)) return;
  const issuedMs = Date.parse(issuedAt);
  const expiresMs = Date.parse(expiresAt);
  if (expiresMs <= issuedMs) errors.push("ticket expiresAt must be later than issuedAt");
  if (expiresMs - issuedMs > MAX_PUBLISH_TICKET_TTL_MS) errors.push("ticket lifetime exceeds 15 minutes");
  if (issuedMs > nowMs + MAX_CLOCK_SKEW_MS) errors.push("ticket issuedAt is too far in the future");
  if (nowMs >= expiresMs) errors.push("ticket has expired");
}

export async function issuePublishCapabilityTicket(
  packet: FrozenExecutionPacket,
  secret: string | Uint8Array,
  options: { expiresAt: string; nonce?: string; now?: Date } ,
): Promise<PublishCapabilityTicket> {
  const packetValidation = await validateFrozenExecutionPacket(packet);
  if (!packetValidation.ok) throw new ReleaseExecutionContractError(packetValidation.errors);
  if (packet.phase !== "publish_once") throw new ReleaseExecutionContractError(["publish capability may only be issued for publish_once"]);
  const now = options.now ?? new Date();
  const issuedAt = now.toISOString();
  const nonce = options.nonce ?? randomNonce();
  const timeErrors: string[] = [];
  validateTicketTime(issuedAt, options.expiresAt, now.getTime(), timeErrors);
  if (!NONCE_RE.test(nonce)) timeErrors.push("ticket nonce is invalid");
  if (timeErrors.length) throw new ReleaseExecutionContractError(timeErrors);
  const claims: PublishCapabilityClaims = {
    schemaVersion: PUBLISH_CAPABILITY_SCHEMA_VERSION,
    executionPacketSha256: packet.packetSha256,
    runId: packet.runId,
    articleId: packet.articleId,
    attempt: packet.attempt,
    commandId: packet.commandId,
    contractRevision: packet.contract.revision,
    contractSha256: packet.contract.sha256,
    platform: packet.platform,
    releaseId: packet.releaseId,
    buildId: packet.buildId,
    artifactSha256: packet.artifact.sha256,
    targetAccount: packet.targetAccount,
    action: "publish",
    maxClicks: 1,
    issuedAt,
    expiresAt: options.expiresAt,
    nonce,
  };
  const key = await importHmacKey(secret, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(canonicalExecutionJson(claims)));
  return deepFreeze({
    schemaVersion: PUBLISH_CAPABILITY_SCHEMA_VERSION,
    claims,
    signature: bytesToHex(new Uint8Array(signature)),
  });
}

export async function verifyPublishCapabilityTicket(
  ticket: unknown,
  packet: FrozenExecutionPacket,
  secret: string | Uint8Array,
  options: { now?: Date } = {},
): Promise<PublishCapabilityVerification> {
  const errors: string[] = [];
  const packetValidation = await validateFrozenExecutionPacket(packet);
  errors.push(...packetValidation.errors.map((error) => `packet: ${error}`));
  if (packet.phase !== "publish_once") errors.push("publish capability is only valid for publish_once");
  if (!isRecord(ticket)) {
    return { ok: false, errors: [...errors, "ticket must be an object"], nonceSha256: null, persistentConsumption: null };
  }
  exactKeys(ticket, ["schemaVersion", "claims", "signature"], "ticket", errors);
  if (ticket.schemaVersion !== PUBLISH_CAPABILITY_SCHEMA_VERSION) errors.push("ticket schemaVersion is invalid");
  const claims = isRecord(ticket.claims) ? ticket.claims : null;
  if (!claims) {
    errors.push("ticket claims must be an object");
  } else {
    exactKeys(claims, [
      "schemaVersion", "executionPacketSha256", "runId", "articleId", "attempt", "commandId", "contractRevision",
      "contractSha256", "platform", "releaseId", "buildId", "artifactSha256", "targetAccount",
      "action", "maxClicks", "issuedAt", "expiresAt", "nonce",
    ], "ticket claims", errors);
    if (claims.schemaVersion !== PUBLISH_CAPABILITY_SCHEMA_VERSION) errors.push("ticket claims schemaVersion is invalid");
    if (claims.action !== "publish") errors.push("ticket action must be publish");
    if (claims.maxClicks !== 1) errors.push("ticket maxClicks must be exactly 1");
    if (typeof claims.nonce !== "string" || !NONCE_RE.test(claims.nonce)) errors.push("ticket nonce is invalid");
    validateTicketTime(String(claims.issuedAt ?? ""), String(claims.expiresAt ?? ""), (options.now ?? new Date()).getTime(), errors);
    const bindings: Array<[string, unknown, unknown]> = [
      ["executionPacketSha256", claims.executionPacketSha256, packet.packetSha256],
      ["runId", claims.runId, packet.runId],
      ["articleId", claims.articleId, packet.articleId],
      ["attempt", claims.attempt, packet.attempt],
      ["commandId", claims.commandId, packet.commandId],
      ["contractRevision", claims.contractRevision, packet.contract.revision],
      ["contractSha256", claims.contractSha256, packet.contract.sha256],
      ["platform", claims.platform, packet.platform],
      ["releaseId", claims.releaseId, packet.releaseId],
      ["buildId", claims.buildId, packet.buildId],
      ["artifactSha256", claims.artifactSha256, packet.artifact.sha256],
      ["targetAccount", claims.targetAccount, packet.targetAccount],
    ];
    for (const [label, actual, expected] of bindings) {
      if (actual !== expected) errors.push(`ticket ${label} does not match the execution packet`);
    }
  }
  const signature = typeof ticket.signature === "string" ? hexToBytes(ticket.signature) : null;
  if (!signature || signature.byteLength !== 32) {
    errors.push("ticket signature is invalid");
  } else if (claims) {
    try {
      const key = await importHmacKey(secret, ["verify"]);
      const signatureBuffer = signature.buffer.slice(signature.byteOffset, signature.byteOffset + signature.byteLength);
      const valid = await crypto.subtle.verify("HMAC", key, signatureBuffer, new TextEncoder().encode(canonicalExecutionJson(claims)));
      if (!valid) errors.push("ticket signature verification failed");
    } catch (error) {
      errors.push(`ticket signature verification failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const ok = errors.length === 0;
  const nonceSha256 = ok && claims ? await sha256ExecutionText(String(claims.nonce)) : null;
  return {
    ok,
    errors,
    nonceSha256,
    // This module deliberately cannot claim one-time consumption. The caller must
    // atomically insert this digest in D1 and proceed only when the row was absent.
    persistentConsumption: ok && nonceSha256 ? {
      required: true,
      mechanism: "d1_cas_insert_if_absent",
      nonceSha256,
      expected: "absent",
      next: "consumed",
    } : null,
  };
}

function receiptCore(receipt: Record<string, unknown>) {
  const core = { ...receipt };
  delete core.receiptSha256;
  return core;
}

function validSnapshot(value: unknown, label: string, errors: string[]) {
  if (!isRecord(value)) {
    errors.push(`${label} must be an object`);
    return;
  }
  exactKeys(value, ["url", "account", "checkpoint"], label, errors);
  if (typeof value.url !== "string" || !value.url) errors.push(`${label}.url is required`);
  if (typeof value.account !== "string" || !value.account) errors.push(`${label}.account is required`);
  if (typeof value.checkpoint !== "string" || !value.checkpoint.trim()) errors.push(`${label}.checkpoint is required`);
}

function validateRouteAttestationClaims(value: unknown, packet: FrozenExecutionPacket, now: Date, errors: string[]) {
  if (!isRecord(value)) {
    errors.push("route attestation claims must be an object");
    return;
  }
  exactKeys(value, [
    "schemaVersion", "routeDecisionId", "workUnitId", "agentProfileId", "agentType", "configuredModel",
    "circuitState", "issuedAt", "expiresAt", "nonce", "packetSha256",
  ], "route attestation claims", errors);
  if (value.schemaVersion !== ROUTE_ATTESTATION_SCHEMA_VERSION) errors.push("route attestation claims schemaVersion is invalid");
  for (const [label, item] of [["routeDecisionId", value.routeDecisionId], ["workUnitId", value.workUnitId], ["agentProfileId", value.agentProfileId], ["agentType", value.agentType], ["configuredModel", value.configuredModel]] as const) {
    if (typeof item !== "string" || !SAFE_ID_RE.test(item)) errors.push(`route attestation ${label} is invalid`);
  }
  if (value.agentProfileId !== packet.executor.agentProfileId) errors.push("route attestation agentProfileId does not match the execution packet");
  if (value.packetSha256 !== packet.packetSha256) errors.push("route attestation packetSha256 does not match the execution packet");
  if (typeof value.circuitState !== "string" || !ROUTE_RECEIPT_CIRCUIT_STATE_SET.has(value.circuitState)) {
    errors.push("route attestation circuitState is invalid");
  }
  if (typeof value.nonce !== "string" || !NONCE_RE.test(value.nonce)) errors.push("route attestation nonce is invalid");
  validateTicketTime(String(value.issuedAt ?? ""), String(value.expiresAt ?? ""), now.getTime(), errors);
}

export async function issueExecutionRouteAttestation(
  packet: FrozenExecutionPacket,
  secret: string | Uint8Array,
  options: {
    routeDecisionId: string;
    workUnitId: string;
    agentType: string;
    configuredModel: string;
    circuitState: RouteReceiptCircuitState;
    expiresAt: string;
    nonce?: string;
    now?: Date;
  },
): Promise<ExecutionRouteAttestation> {
  const packetValidation = await validateFrozenExecutionPacket(packet);
  if (!packetValidation.ok) throw new ReleaseExecutionContractError(packetValidation.errors);
  const now = options.now ?? new Date();
  const claims: ExecutionRouteReceipt = {
    schemaVersion: ROUTE_ATTESTATION_SCHEMA_VERSION,
    routeDecisionId: options.routeDecisionId,
    workUnitId: options.workUnitId,
    agentProfileId: packet.executor.agentProfileId,
    agentType: options.agentType,
    configuredModel: options.configuredModel,
    circuitState: options.circuitState,
    issuedAt: now.toISOString(),
    expiresAt: options.expiresAt,
    nonce: options.nonce ?? randomNonce(),
    packetSha256: packet.packetSha256,
  };
  const errors: string[] = [];
  validateRouteAttestationClaims(claims, packet, now, errors);
  if (errors.length) throw new ReleaseExecutionContractError(errors);
  const key = await importHmacKey(secret, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(canonicalExecutionJson(claims)));
  return deepFreeze({
    schemaVersion: ROUTE_ATTESTATION_SCHEMA_VERSION,
    claims,
    signature: bytesToHex(new Uint8Array(signature)),
  });
}

export async function verifyExecutionRouteAttestation(
  value: unknown,
  packet: FrozenExecutionPacket,
  secret: string | Uint8Array,
  options: { now?: Date } = {},
): Promise<ContractValidation> {
  const errors: string[] = [];
  const packetValidation = await validateFrozenExecutionPacket(packet);
  errors.push(...packetValidation.errors.map((error) => `packet: ${error}`));
  if (!isRecord(value)) return { ok: false, errors: ["route attestation must be an object"] };
  exactKeys(value, ["schemaVersion", "claims", "signature"], "route attestation", errors);
  if (value.schemaVersion !== ROUTE_ATTESTATION_SCHEMA_VERSION) errors.push("route attestation schemaVersion is invalid");
  const claims = isRecord(value.claims) ? value.claims : null;
  if (!claims) errors.push("route attestation claims must be an object");
  else validateRouteAttestationClaims(claims, packet, options.now ?? new Date(), errors);
  const signature = typeof value.signature === "string" ? hexToBytes(value.signature) : null;
  if (!signature || signature.byteLength !== 32) errors.push("route attestation signature is invalid");
  else if (claims) {
    try {
      const key = await importHmacKey(secret, ["verify"]);
      const raw = signature.buffer.slice(signature.byteOffset, signature.byteOffset + signature.byteLength);
      const valid = await crypto.subtle.verify("HMAC", key, raw, new TextEncoder().encode(canonicalExecutionJson(claims)));
      if (!valid) errors.push("route attestation signature verification failed");
    } catch {
      errors.push("route attestation key is unavailable");
    }
  }
  return { ok: errors.length === 0, errors };
}

export async function validateExecutionReceipt(
  value: unknown,
  packet: FrozenExecutionPacket,
  previousReceipt: ExecutionReceipt | null = null,
  options: { routeAttestationSecret?: string | Uint8Array; now?: Date } = {},
): Promise<ContractValidation> {
  const errors: string[] = [];
  const packetValidation = await validateFrozenExecutionPacket(packet);
  errors.push(...packetValidation.errors.map((error) => `packet: ${error}`));
  if (!isRecord(value)) return { ok: false, errors: [...errors, "execution receipt must be an object"] };
  exactKeys(value, [
    "schemaVersion", "receiptId", "packetSha256", "runId", "attempt", "commandId", "platform",
    "releaseId", "buildId", "artifactSha256", "phase", "sequence", "previousReceiptSha256",
    "action", "before", "after", "result", "externalObservation", "publishClicked",
    "publishClicksTotal", "writeDisposition", "recoveryMode", "stopReason", "evidenceRefs",
    "claimPromotions", "routeAttestation", "observedAt", "receiptSha256",
  ], "execution receipt", errors);
  if (value.schemaVersion !== EXECUTION_RECEIPT_SCHEMA_VERSION) errors.push("execution receipt schemaVersion is invalid");
  if (typeof value.receiptId !== "string" || !SAFE_ID_RE.test(value.receiptId)) errors.push("receiptId is invalid");
  const bindings: Array<[string, unknown, unknown]> = [
    ["packetSha256", value.packetSha256, packet.packetSha256],
    ["runId", value.runId, packet.runId],
    ["attempt", value.attempt, packet.attempt],
    ["commandId", value.commandId, packet.commandId],
    ["platform", value.platform, packet.platform],
    ["releaseId", value.releaseId, packet.releaseId],
    ["buildId", value.buildId, packet.buildId],
    ["artifactSha256", value.artifactSha256, packet.artifact.sha256],
    ["phase", value.phase, packet.phase],
  ];
  for (const [label, actual, expected] of bindings) {
    if (actual !== expected) errors.push(`receipt ${label} does not match the execution packet`);
  }
  if (!Number.isSafeInteger(value.sequence) || Number(value.sequence) < 1) errors.push("receipt sequence must be a positive integer");
  if (previousReceipt) {
    if (value.sequence !== previousReceipt.sequence + 1) errors.push("receipt sequence does not extend the previous receipt");
    if (value.previousReceiptSha256 !== previousReceipt.receiptSha256) errors.push("previousReceiptSha256 does not match the previous receipt");
    if (previousReceipt.packetSha256 !== packet.packetSha256) errors.push("previous receipt belongs to another packet");
    const previousExpected = await sha256ExecutionJson(receiptCore(previousReceipt as unknown as Record<string, unknown>));
    if (previousExpected !== previousReceipt.receiptSha256) errors.push("previous receipt digest is invalid");
  } else {
    if (value.sequence !== 1) errors.push("the first receipt sequence must be 1");
    if (value.previousReceiptSha256 !== null) errors.push("the first receipt previousReceiptSha256 must be null");
  }
  validSnapshot(value.before, "before", errors);
  validSnapshot(value.after, "after", errors);
  if (!options.routeAttestationSecret) {
    errors.push("route attestation key is unavailable");
  } else {
    const attestationValidation = await verifyExecutionRouteAttestation(value.routeAttestation, packet, options.routeAttestationSecret, { now: options.now });
    errors.push(...attestationValidation.errors.map((error) => `routeAttestation: ${error}`));
  }
  if (previousReceipt && isRecord(value.routeAttestation)
    && canonicalExecutionJson(value.routeAttestation) !== canonicalExecutionJson(previousReceipt.routeAttestation)) {
    errors.push("routeAttestation must not change in the receipt chain");
  }
  const before = isRecord(value.before) ? value.before : null;
  const after = isRecord(value.after) ? value.after : null;
  if (before && typeof before.url === "string" && !isExecutionUrlAllowed(packet, before.url)) errors.push("before.url is outside the packet allowlist");
  const afterUrlAllowed = Boolean(after && typeof after.url === "string" && isExecutionUrlAllowed(packet, after.url));
  if (!afterUrlAllowed && value.stopReason !== "unexpected_domain") errors.push("an after.url outside the allowlist requires unexpected_domain stopReason");
  if (before && before.account !== packet.targetAccount) errors.push("before.account does not match targetAccount");
  if (after && after.account !== packet.targetAccount && value.stopReason !== "unexpected_account") {
    errors.push("an unexpected after.account requires unexpected_account stopReason");
  }
  if (typeof value.action !== "string" || !packet.allowedActions.includes(value.action)) errors.push("receipt action is not authorized by the packet");
  if (typeof value.action === "string" && FORBIDDEN_ACTION_SET.has(value.action)) errors.push(`receipt contains forbidden action: ${value.action}`);
  if (!(["pass", "fail", "inconclusive"] as const).includes(value.result as ReceiptResult)) errors.push("receipt result is invalid");
  if (!(["not_applicable", "success_signal_observed", "failure_signal_observed", "record_observed", "public_page_observed", "unknown"] as const).includes(value.externalObservation as ExternalObservation)) {
    errors.push("externalObservation is invalid");
  }
  if (typeof value.publishClicked !== "boolean") errors.push("publishClicked must be boolean");
  const priorClicks = previousReceipt?.publishClicksTotal ?? 0;
  const expectedClicks = priorClicks + (value.publishClicked === true ? 1 : 0);
  if (!Number.isSafeInteger(value.publishClicksTotal) || value.publishClicksTotal !== expectedClicks) {
    errors.push("publishClicksTotal does not match the append-only click history");
  }
  if (Number(value.publishClicksTotal) > 1) errors.push("publish_once permits at most one publish click across the receipt chain");
  if (packet.phase !== "publish_once" && value.publishClicked !== false) errors.push(`${packet.phase} receipts must keep publishClicked=false`);
  if (packet.phase !== "publish_once" && Number(value.publishClicksTotal) !== 0) errors.push(`${packet.phase} receipts must keep publishClicksTotal=0`);
  if (value.publishClicked === true && value.action !== "click_publish_once") errors.push("only click_publish_once may set publishClicked=true");
  if (value.action === "click_publish_once" && value.result === "pass" && value.publishClicked !== true) {
    errors.push("a passing click_publish_once receipt must set publishClicked=true");
  }
  if (!(["continue", "stop_writes", "freeze_writes"] as const).includes(value.writeDisposition as WriteDisposition)) errors.push("writeDisposition is invalid");
  if (!(["none", "safe_retry", "probe_first", "human_takeover"] as const).includes(value.recoveryMode as RecoveryMode)) errors.push("recoveryMode is invalid");
  if (value.publishClicked === true && value.externalObservation !== "unknown" && value.writeDisposition !== "stop_writes") {
    errors.push("a completed publish click must stop further writes");
  }
  if (value.externalObservation === "unknown") {
    if (value.result !== "inconclusive") errors.push("unknown external result must be inconclusive");
    if (value.writeDisposition !== "freeze_writes") errors.push("unknown external result must freeze_writes");
    if (value.recoveryMode !== "probe_first") errors.push("unknown external result must use probe_first recovery");
    if (value.stopReason !== "external_result_unknown") errors.push("unknown external result requires external_result_unknown stopReason");
  }
  if (value.stopReason !== null && (!packet.stopConditions.includes(value.stopReason as StopCondition))) {
    errors.push("stopReason is not authorized by the packet stop conditions");
  }
  if (!Array.isArray(value.evidenceRefs) || value.evidenceRefs.length === 0
    || !value.evidenceRefs.every((item) => typeof item === "string" && item.trim() === item && item.length > 0)) {
    errors.push("evidenceRefs must contain at least one non-empty stable reference");
  } else if (duplicateValues(value.evidenceRefs as string[]).length) {
    errors.push("evidenceRefs must not contain duplicates");
  }
  if (!Array.isArray(value.claimPromotions)) {
    errors.push("claimPromotions must be an array");
  } else if (value.claimPromotions.length !== 0) {
    errors.push("browser mechanical executor cannot promote submission, backend, public, complete, or any other claim");
  }
  if (!isIsoWithTimezone(value.observedAt)) errors.push("observedAt must be an ISO timestamp with timezone");
  if (typeof value.receiptSha256 !== "string" || !SHA256_RE.test(value.receiptSha256)) {
    errors.push("receiptSha256 is invalid");
  } else {
    try {
      const expected = await sha256ExecutionJson(receiptCore(value));
      if (expected !== value.receiptSha256) errors.push("receiptSha256 does not bind the current receipt");
    } catch (error) {
      errors.push(`receipt canonicalization failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { ok: errors.length === 0, errors };
}

export async function createExecutionReceipt(
  packet: FrozenExecutionPacket,
  input: ExecutionReceiptInput,
  previousReceipt: ExecutionReceipt | null = null,
  options: { routeAttestationSecret: string | Uint8Array; now?: Date },
): Promise<ExecutionReceipt> {
  const packetValidation = await validateFrozenExecutionPacket(packet);
  if (!packetValidation.ok) throw new ReleaseExecutionContractError(packetValidation.errors);
  const core = {
    schemaVersion: EXECUTION_RECEIPT_SCHEMA_VERSION,
    receiptId: input.receiptId,
    packetSha256: packet.packetSha256,
    runId: packet.runId,
    attempt: packet.attempt,
    commandId: packet.commandId,
    platform: packet.platform,
    releaseId: packet.releaseId,
    buildId: packet.buildId,
    artifactSha256: packet.artifact.sha256,
    phase: packet.phase,
    sequence: (previousReceipt?.sequence ?? 0) + 1,
    previousReceiptSha256: previousReceipt?.receiptSha256 ?? null,
    action: input.action,
    before: cloneJson(input.before),
    after: cloneJson(input.after),
    result: input.result,
    externalObservation: input.externalObservation,
    publishClicked: input.publishClicked,
    publishClicksTotal: (previousReceipt?.publishClicksTotal ?? 0) + (input.publishClicked ? 1 : 0),
    writeDisposition: input.writeDisposition,
    recoveryMode: input.recoveryMode,
    stopReason: input.stopReason,
    evidenceRefs: [...input.evidenceRefs],
    claimPromotions: [...input.claimPromotions],
    routeAttestation: cloneJson(input.routeAttestation),
    observedAt: input.observedAt,
  };
  const receipt = { ...core, receiptSha256: await sha256ExecutionJson(core) } as ExecutionReceipt;
  const validation = await validateExecutionReceipt(receipt, packet, previousReceipt, options);
  if (!validation.ok) throw new ReleaseExecutionContractError(validation.errors);
  return deepFreeze(receipt);
}
