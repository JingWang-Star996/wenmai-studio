/** Pure, fail-closed release-control bindings; deliberately no I/O. */
import { canonicalExecutionJson, sha256ExecutionJson } from "./release-execution-contract.ts";
export const RELEASE_CONTROL_V2_SCHEMA = "wenmai.release-control/2.0";
export const REQUIRED_PLATFORMS = ["xiaohongshu", "maimai", "zhihu", "bilibili"] as const;
export type Platform = (typeof REQUIRED_PLATFORMS)[number];
const P = new Set<string>(REQUIRED_PLATFORMS), SHA = /^[a-f0-9]{64}$/, ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/, NONCE = /^[A-Za-z0-9_-]{32,192}$/;
const CONFIRM_MS = 900000, LEASE_MS = 300000;
export type Validation = {
    ok: boolean;
    errors: string[];
};
export class ReleaseControlV2Error extends Error {
    readonly errors: string[];
    constructor(e: string[]) { super(e.join("; ")); this.errors = [...e]; }
}
export type ReleaseFacts = {
    articleId: string;
    runId: string;
    releaseId: string;
    buildId: string;
    platform: Platform;
    artifactSha256: string;
    targetAccount: string;
    publicationVersionSha256: string;
    profileSha256: string;
    contractSha256: string;
    prepareReceiptHeadSha256: string;
    domContractSha256: string;
};
export type ReleaseReadinessSnapshot = ReleaseFacts & {
    schemaVersion: typeof RELEASE_CONTROL_V2_SCHEMA;
    state: "ready_to_submit";
    createdAt: string;
    expiresAt: string;
    snapshotSha256: string;
};
export type ConfirmationItem = {
    platform: Platform;
    releaseId: string;
    buildId: string;
    artifactSha256: string;
    targetAccount: string;
    readinessSnapshotSha256: string;
};
export type ArticlePublishConfirmation = {
    schemaVersion: typeof RELEASE_CONTROL_V2_SCHEMA;
    confirmationId: string;
    ownerSessionId: string;
    articleId: string;
    runId: string;
    contractSha256: string;
    confirmedAt: string;
    expiresAt: string;
    items: ConfirmationItem[];
    setSha256: string;
};
export type ClickLeaseClaims = {
    schemaVersion: typeof RELEASE_CONTROL_V2_SCHEMA;
    confirmationId: string;
    capabilityId: string;
    articleId: string;
    runId: string;
    buildId: string;
    clickLeaseId: string;
    receiptChainId: string;
    packetSha256: string;
    releaseId: string;
    platform: Platform;
    targetAccount: string;
    artifactSha256: string;
    readinessSnapshotSha256: string;
    domContractSha256: string;
    hostId: string;
    maxClicks: 1;
    issuedAt: string;
    expiresAt: string;
    nonce: string;
};
export const RECEIPT_EVENTS = ["capability_consumed", "click_invocation_started", "click_invoked", "click_not_invoked", "result_unknown", "read_only_probe"] as const;
export type ReceiptEventType = (typeof RECEIPT_EVENTS)[number];
export type ReceiptBinding = Pick<ClickLeaseClaims, "receiptChainId" | "confirmationId" | "capabilityId" | "clickLeaseId" | "articleId" | "runId" | "releaseId" | "platform" | "artifactSha256" | "packetSha256" | "domContractSha256" | "hostId">;
export type ExecutionReceiptEvent = ReceiptBinding & {
    schemaVersion: typeof RELEASE_CONTROL_V2_SCHEMA;
    eventId: string;
    eventType: ReceiptEventType;
    sequence: number;
    expectedHeadSha256: string | null;
    previousEventSha256: string | null;
    hostInvocationId: string;
    observedAt: string;
    writeDisposition: "continue" | "freeze_writes" | "stop_writes";
    recoveryMode: "none" | "probe_first";
    claimPromotions: [
    ];
    result: "not_applicable" | "invoked" | "not_invoked" | "unknown" | "probe";
    evidenceRefs: string[];
    eventSha256: string;
};
export type ReceiptProjection = {
    binding: ReceiptBinding;
    sequence: number;
    headSha256: string | null;
    hostInvocationIds: readonly string[];
    capabilityConsumed: boolean;
    invocationStarted: boolean;
    clickAttempts: number;
    terminalResult: "invoked" | "not_invoked" | "unknown" | null;
    probeOnly: boolean;
};
const bindKeys = ["receiptChainId", "confirmationId", "capabilityId", "clickLeaseId", "articleId", "runId", "releaseId", "platform", "artifactSha256", "packetSha256", "domContractSha256", "hostId"] as const;
const confKeys = ["schemaVersion", "confirmationId", "ownerSessionId", "articleId", "runId", "contractSha256", "confirmedAt", "expiresAt", "items", "setSha256"] as const;
const leaseKeys = ["schemaVersion", "confirmationId", "capabilityId", "articleId", "runId", "buildId", "clickLeaseId", "receiptChainId", "packetSha256", "releaseId", "platform", "targetAccount", "artifactSha256", "readinessSnapshotSha256", "domContractSha256", "hostId", "maxClicks", "issuedAt", "expiresAt", "nonce"] as const;
const eventKeys = ["schemaVersion", "eventId", "eventType", "sequence", "expectedHeadSha256", "previousEventSha256", "hostInvocationId", "observedAt", "writeDisposition", "recoveryMode", "claimPromotions", "result", "evidenceRefs", ...bindKeys, "eventSha256"] as const;
function rec(x: unknown): x is Record<string, unknown> { return !!x && typeof x === "object" && !Array.isArray(x); }
function exact(x: Record<string, unknown>, ks: readonly string[], n: string, e: string[]) { const s = new Set(ks); for (const k of Object.keys(x))
    if (!s.has(k))
        e.push(`${n} contains unknown field: ${k}`); for (const k of ks)
    if (!(k in x))
        e.push(`${n} is missing field: ${k}`); }
function id(x: unknown): x is string { return typeof x === "string" && ID.test(x); }
function dig(x: unknown): x is string { return typeof x === "string" && SHA.test(x); }
function date(x: unknown): x is string { return typeof x === "string" && /(?:Z|[+-]\d\d:\d\d)$/.test(x) && Number.isFinite(Date.parse(x)); }
function ttl(a: string, b: string, n: number) { return Date.parse(b) > Date.parse(a) && Date.parse(b) - Date.parse(a) <= n; }
function acct(x: unknown): x is string { return typeof x === "string" && x.trim() === x && x.length > 0 && ![...x].some((character) => { const codePoint = character.codePointAt(0) ?? 0; return codePoint <= 31 || codePoint === 127; }) && !x.includes("*"); }
function core<T extends Record<string, unknown>>(x: T, k: string) { return Object.fromEntries(Object.entries(x).filter(([key]) => key !== k)); }
export function validateReleaseReadinessSnapshot(x: unknown, current?: ReleaseFacts, now = new Date()): Validation { const e: string[] = []; if (!rec(x))
    return { ok: false, errors: ["readiness snapshot must be an object"] }; exact(x, ["schemaVersion", "state", "articleId", "runId", "releaseId", "buildId", "platform", "artifactSha256", "targetAccount", "publicationVersionSha256", "profileSha256", "contractSha256", "prepareReceiptHeadSha256", "domContractSha256", "createdAt", "expiresAt", "snapshotSha256"], "readiness snapshot", e); if (x.schemaVersion !== RELEASE_CONTROL_V2_SCHEMA || x.state !== "ready_to_submit")
    e.push("readiness schemaVersion or state is invalid"); for (const k of ["articleId", "runId", "releaseId", "buildId"] as const)
    if (!id(x[k]))
        e.push(`${k} is invalid`); if (!P.has(x.platform as string) || !acct(x.targetAccount))
    e.push("readiness platform or targetAccount is invalid"); for (const k of ["artifactSha256", "publicationVersionSha256", "profileSha256", "contractSha256", "prepareReceiptHeadSha256", "domContractSha256"] as const)
    if (!dig(x[k]))
        e.push(`${k} is invalid`); if (!date(x.createdAt) || !date(x.expiresAt) || Date.parse(x.expiresAt) <= Date.parse(x.createdAt) || Date.parse(x.expiresAt) <= now.getTime())
    e.push("snapshot timestamps are invalid"); if (!dig(x.snapshotSha256))
    e.push("snapshotSha256 is invalid"); if (current)
    for (const k of Object.keys(current) as (keyof ReleaseFacts)[])
        if (x[k] !== current[k])
            e.push(`current fact drifted: ${k}`); return { ok: !e.length, errors: e }; }
export async function createReleaseReadinessSnapshot(input: Omit<ReleaseReadinessSnapshot, "schemaVersion" | "state" | "snapshotSha256">): Promise<ReleaseReadinessSnapshot> { const v = { schemaVersion: RELEASE_CONTROL_V2_SCHEMA as const, state: "ready_to_submit" as const, ...input }; const c = validateReleaseReadinessSnapshot({ ...v, snapshotSha256: "0".repeat(64) }, undefined, new Date(input.createdAt)); if (!c.ok)
    throw new ReleaseControlV2Error(c.errors); return Object.freeze({ ...v, snapshotSha256: await sha256ExecutionJson(v) }); }
export async function verifyReleaseReadinessSnapshot(x: unknown, current?: ReleaseFacts, now?: Date): Promise<Validation> { const c = validateReleaseReadinessSnapshot(x, current, now); if (!c.ok || !rec(x))
    return c; return x.snapshotSha256 === await sha256ExecutionJson(core(x, "snapshotSha256")) ? c : { ok: false, errors: [...c.errors, "snapshotSha256 does not bind snapshot"] }; }
function validItems(xs: unknown, e: string[]) { if (!Array.isArray(xs) || xs.length !== 4) {
    e.push("confirmation must contain exactly four items");
    return;
} const seen = new Set<string>(); for (const x of xs) {
    if (!rec(x)) {
        e.push("confirmation item must be an object");
        continue;
    }
    exact(x, ["platform", "releaseId", "buildId", "artifactSha256", "targetAccount", "readinessSnapshotSha256"], "confirmation item", e);
    if (!P.has(x.platform as string) || seen.has(x.platform as string))
        e.push("confirmation platforms must be unique required platforms");
    seen.add(x.platform as string);
    for (const k of ["releaseId", "buildId"] as const)
        if (!id(x[k]))
            e.push(`${k} is invalid`);
    for (const k of ["artifactSha256", "readinessSnapshotSha256"] as const)
        if (!dig(x[k]))
            e.push(`${k} is invalid`);
    if (!acct(x.targetAccount))
        e.push("targetAccount is invalid");
} for (const p of REQUIRED_PLATFORMS)
    if (!seen.has(p))
        e.push(`confirmation is missing platform: ${p}`); }
export async function createArticlePublishConfirmation(input: Omit<ArticlePublishConfirmation, "schemaVersion" | "items" | "setSha256"> & {
    items: readonly ConfirmationItem[];
}): Promise<ArticlePublishConfirmation> { const e: string[] = []; validItems(input.items, e); if (!id(input.confirmationId) || !id(input.ownerSessionId) || !id(input.articleId) || !id(input.runId) || !dig(input.contractSha256) || !date(input.confirmedAt) || !date(input.expiresAt) || !ttl(input.confirmedAt, input.expiresAt, CONFIRM_MS))
    e.push("confirmation core or 15-minute TTL is invalid"); if (e.length)
    throw new ReleaseControlV2Error(e); const items = [...input.items].sort((a, b) => a.platform.localeCompare(b.platform)); const v = { schemaVersion: RELEASE_CONTROL_V2_SCHEMA as const, ...input, items }; return Object.freeze({ ...v, setSha256: await sha256ExecutionJson(v) }); }
export async function verifyArticlePublishConfirmation(x: unknown, current?: {
    articleId: string;
    runId: string;
    contractSha256: string;
    items: readonly ConfirmationItem[];
}, now = new Date()): Promise<Validation> { const e: string[] = []; if (!rec(x))
    return { ok: false, errors: ["confirmation must be an object"] }; exact(x, confKeys, "confirmation", e); validItems(x.items, e); if (x.schemaVersion !== RELEASE_CONTROL_V2_SCHEMA || !id(x.confirmationId) || !id(x.ownerSessionId) || !id(x.articleId) || !id(x.runId) || !dig(x.contractSha256) || !date(x.confirmedAt) || !date(x.expiresAt) || !ttl(x.confirmedAt, x.expiresAt, CONFIRM_MS) || Date.parse(x.expiresAt) <= now.getTime())
    e.push("confirmation core or TTL is invalid"); const sorted = Array.isArray(x.items) ? [...x.items].sort((a, b) => (a as ConfirmationItem).platform.localeCompare((b as ConfirmationItem).platform)) : []; if (canonicalExecutionJson(x.items) !== canonicalExecutionJson(sorted))
    e.push("confirmation items must use stable platform sorting"); if (!dig(x.setSha256) || x.setSha256 !== await sha256ExecutionJson(core(x, "setSha256")))
    e.push("setSha256 does not bind complete confirmation core"); if (current && (x.articleId !== current.articleId || x.runId !== current.runId || x.contractSha256 !== current.contractSha256 || canonicalExecutionJson(sorted) !== canonicalExecutionJson([...current.items].sort((a, b) => a.platform.localeCompare(b.platform)))))
    e.push("current confirmation facts drifted"); return { ok: !e.length, errors: e }; }
export function validateClickLeaseClaims(x: unknown, now = new Date()): Validation { const e: string[] = []; if (!rec(x))
    return { ok: false, errors: ["click lease must be an object"] }; exact(x, leaseKeys, "click lease", e); if (x.schemaVersion !== RELEASE_CONTROL_V2_SCHEMA)
    e.push("click lease schemaVersion is invalid"); for (const k of ["confirmationId", "capabilityId", "articleId", "runId", "buildId", "clickLeaseId", "receiptChainId", "releaseId", "hostId"] as const)
    if (!id(x[k]) || x[k] === "*")
        e.push(`${k} is invalid`); for (const k of ["packetSha256", "artifactSha256", "readinessSnapshotSha256", "domContractSha256"] as const)
    if (!dig(x[k]))
        e.push(`${k} is invalid`); if (!P.has(x.platform as string) || !acct(x.targetAccount) || x.maxClicks !== 1 || typeof x.nonce !== "string" || !NONCE.test(x.nonce) || !date(x.issuedAt) || !date(x.expiresAt) || !ttl(x.issuedAt, x.expiresAt, LEASE_MS) || Date.parse(x.expiresAt) <= now.getTime())
    e.push("click lease binding or short TTL is invalid"); return { ok: !e.length, errors: e }; }
export function receiptBindingFromClickLease(lease: ClickLeaseClaims): ReceiptBinding { return Object.freeze({ receiptChainId: lease.receiptChainId, confirmationId: lease.confirmationId, capabilityId: lease.capabilityId, clickLeaseId: lease.clickLeaseId, articleId: lease.articleId, runId: lease.runId, releaseId: lease.releaseId, platform: lease.platform, artifactSha256: lease.artifactSha256, packetSha256: lease.packetSha256, domContractSha256: lease.domContractSha256, hostId: lease.hostId }); }
export function createInitialReceiptProjection(lease: ClickLeaseClaims): ReceiptProjection { return Object.freeze({ binding: receiptBindingFromClickLease(lease), sequence: 0, headSha256: null, hostInvocationIds: [], capabilityConsumed: false, invocationStarted: false, clickAttempts: 0, terminalResult: null, probeOnly: false }); }
function shape(x: Record<string, unknown>, e: string[]) { const m: Record<string, [
    string,
    string,
    string
]> = { capability_consumed: ["continue", "none", "not_applicable"], click_invocation_started: ["continue", "none", "not_applicable"], click_invoked: ["stop_writes", "none", "invoked"], click_not_invoked: ["stop_writes", "none", "not_invoked"], result_unknown: ["freeze_writes", "probe_first", "unknown"], read_only_probe: ["stop_writes", "probe_first", "probe"] }; const y = m[x.eventType as string]; if (!y || x.writeDisposition !== y[0] || x.recoveryMode !== y[1] || x.result !== y[2])
    e.push("receipt event disposition, recovery mode, or result is invalid"); if (!Array.isArray(x.evidenceRefs) || !x.evidenceRefs.every(id))
    e.push("evidenceRefs must be safe identifiers"); }
function legal(t: unknown, p: ReceiptProjection, e: string[]) { if (p.sequence === 0 && t !== "capability_consumed")
    e.push("capability_consumed must be the first event"); if (p.sequence > 0 && t === "capability_consumed")
    e.push("capability_consumed may occur only once and first"); if (t === "click_invocation_started" && (!p.capabilityConsumed || p.invocationStarted || p.terminalResult))
    e.push("click invocation cannot start in current receipt state"); if (["click_invoked", "click_not_invoked", "result_unknown"].includes(t as string) && (!p.invocationStarted || p.terminalResult || p.clickAttempts !== 0 || p.probeOnly))
    e.push("click result is not legal in current receipt state"); if (t === "read_only_probe" && (p.terminalResult !== "unknown" || !p.probeOnly))
    e.push("read_only_probe is allowed only after result_unknown"); }
export async function appendExecutionReceiptEvent(p: ReceiptProjection, input: Omit<ExecutionReceiptEvent, "schemaVersion" | "sequence" | "expectedHeadSha256" | "previousEventSha256" | "eventSha256">): Promise<ExecutionReceiptEvent> { const v = { ...input, schemaVersion: RELEASE_CONTROL_V2_SCHEMA as const, sequence: p.sequence + 1, expectedHeadSha256: p.headSha256, previousEventSha256: p.headSha256 }; const event = { ...v, eventSha256: await sha256ExecutionJson(v) }; const c = await validateExecutionReceiptEvent(event, p); if (!c.ok)
    throw new ReleaseControlV2Error(c.errors); return Object.freeze(event); }
export async function validateExecutionReceiptEvent(x: unknown, p: ReceiptProjection): Promise<Validation> { const e: string[] = []; if (!rec(x))
    return { ok: false, errors: ["receipt event must be an object"] }; exact(x, eventKeys, "receipt event", e); if (x.schemaVersion !== RELEASE_CONTROL_V2_SCHEMA || !id(x.eventId) || !id(x.hostInvocationId) || !(RECEIPT_EVENTS as readonly string[]).includes(x.eventType as string) || !date(x.observedAt) || !Number.isSafeInteger(x.sequence) || Number(x.sequence) < 1)
    e.push("receipt event identity is invalid"); if (x.sequence !== p.sequence + 1 || x.expectedHeadSha256 !== p.headSha256 || x.previousEventSha256 !== p.headSha256)
    e.push("receipt event does not extend expected head and sequence"); if (p.hostInvocationIds.includes(x.hostInvocationId as string))
    e.push("hostInvocationId must be single-use"); for (const k of bindKeys)
    if (x[k] !== p.binding[k])
        e.push(`receipt binding drifted: ${k}`); legal(x.eventType, p, e); if (!Array.isArray(x.claimPromotions) || x.claimPromotions.length)
    e.push("receipt event cannot promote claims"); shape(x, e); if (!dig(x.eventSha256) || x.eventSha256 !== await sha256ExecutionJson(core(x, "eventSha256")))
    e.push("eventSha256 does not bind event"); return { ok: !e.length, errors: e }; }
export function projectExecutionReceiptEvent(p: ReceiptProjection, e: ExecutionReceiptEvent): ReceiptProjection { const r = e.eventType === "click_invoked" ? "invoked" : e.eventType === "click_not_invoked" ? "not_invoked" : e.eventType === "result_unknown" ? "unknown" : p.terminalResult; const clickAttemptIncrement = (["click_invoked", "click_not_invoked", "result_unknown"] as string[]).includes(e.eventType) ? 1 : 0; return { ...p, sequence: e.sequence, headSha256: e.eventSha256, hostInvocationIds: [...p.hostInvocationIds, e.hostInvocationId], capabilityConsumed: p.capabilityConsumed || e.eventType === "capability_consumed", invocationStarted: p.invocationStarted || e.eventType === "click_invocation_started", clickAttempts: p.clickAttempts + clickAttemptIncrement, terminalResult: r, probeOnly: p.probeOnly || e.eventType === "result_unknown" }; }
