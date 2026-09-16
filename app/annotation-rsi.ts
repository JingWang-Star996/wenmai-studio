import type { AnnotationDto, ProposalContextBlocker, ProposalContextDto, ProposalContextItem, RequirementStatus, RsiProjectionInput, SourceBinding, TupleCursorPayload } from "./annotation-rsi-types";

export const ANNOTATION_RSI_SCHEMA_VERSION = "wenmai.annotation-rsi/1.0";
export const RSI_DERIVED_LIMITS = {
  bindingEdges: 64,
  sourceRefs: 64,
  sourceRefUtf8Bytes: 64 * 1024,
  encodedProposalBytes: 256 * 1024,
  items: 32,
  variants: 16,
} as const;
const ID_PATTERN = /^[A-Za-z0-9._:-]+$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const ISO_UTC_PATTERN = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/u;
const CURSOR_VIEWS = new Set(["requirements", "annotations", "proposal-context"]);
const MAX_ID_BYTES = 160;
const MAX_STRING_BYTES = 16_000;
const MAX_CURSOR_BYTES = 2_048;
type JsonObject = Record<string, unknown>;

export async function sha256Text(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export class AnnotationRsiValidationError extends TypeError {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}
function bytes(value: string) { return new TextEncoder().encode(value).byteLength; }
function fail(code: string, message: string): never { throw new AnnotationRsiValidationError(code, message); }

export function requireObject(value: unknown, field = "value"): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("JSON_OBJECT_REQUIRED", `${field} must be a JSON object`);
  return value as JsonObject;
}
export function requireArray(value: unknown, field = "value"): unknown[] {
  if (!Array.isArray(value)) fail("JSON_ARRAY_REQUIRED", `${field} must be a JSON array`);
  return value;
}
export function requireString(value: unknown, field = "value", maximumBytes = MAX_STRING_BYTES): string {
  if (typeof value !== "string" || !value.trim()) fail("NON_EMPTY_STRING_REQUIRED", `${field} must be a non-empty string`);
  if (bytes(value) > maximumBytes) fail("UTF8_BYTE_LIMIT_EXCEEDED", `${field} exceeds maximum UTF-8 bytes`);
  return value;
}
export function requireId(value: unknown, field = "id", maximumBytes = MAX_ID_BYTES): string {
  const id = requireString(value, field, maximumBytes);
  if (!ID_PATTERN.test(id)) fail("IDENTIFIER_INVALID", `${field} must be an identifier`);
  return id;
}
export function requireSha256(value: unknown, field = "sha256"): string {
  const digest = requireString(value, field, 64);
  if (!SHA256_PATTERN.test(digest)) fail("SHA256_INVALID", `${field} must be a lowercase SHA-256 hex digest`);
  return digest;
}
export function requireInteger(value: unknown, field = "value", minimum = 1, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) fail("POSITIVE_INTEGER_REQUIRED", `${field} must be an integer in range`);
  return value;
}
function requireUtcIso(value: unknown, field = "createdAt"): string {
  const timestamp = requireString(value, field, 40);
  if (!ISO_UTC_PATTERN.test(timestamp) || Number.isNaN(Date.parse(timestamp)) || new Date(timestamp).toISOString() !== timestamp) fail("UTC_ISO_REQUIRED", `${field} must be canonical ISO UTC`);
  return timestamp;
}
export const requirementTransition = (from: RequirementStatus, to: RequirementStatus) =>
  (from === "draft" && (to === "accepted" || to === "cancelled")) || (from === "accepted" && to === "superseded");
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = requireObject(value);
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
}
export async function annotationSha256(annotation: Pick<AnnotationDto, "articleId" | "requirementId" | "subjectType" | "subjectId" | "snapshotSha256" | "labelSchemaVersion" | "labelKind" | "verdict" | "severity" | "note" | "details" | "evidenceRefs" | "supersedesAnnotationId" | "humanActorId" | "createdAt">) {
  return sha256Text(canonicalJson(annotation));
}
/** Legacy ID-only compatibility helper for existing callers/tests; production projections use sourceBindingsSha256. */
export async function sourceSetSha256(input: { requirementIds: readonly string[]; annotationIds: readonly string[]; retrospectiveIds: readonly string[] }) {
  const normalized = (kind: string, ids: readonly string[]) => [...new Set(ids.map((id) => requireId(id)))].sort().map((id) => `${kind}:${id}`);
  return sha256Text(canonicalJson([...normalized("requirement", input.requirementIds), ...normalized("annotation", input.annotationIds), ...normalized("retrospective", input.retrospectiveIds)]));
}
export async function sourceBindingsSha256(bindings: readonly SourceBinding[]) {
  const unique = new Map<string, { kind: string; id: string; sha256: string }>();
  for (const binding of bindings) {
    const normalized = { kind: requireId(binding.kind, "binding.kind"), id: requireId(binding.id, "binding.id"), sha256: requireSha256(binding.sha256, "binding.sha256") };
    const key = `${normalized.kind}\u0000${normalized.id}`;
    const previous = unique.get(key);
    if (previous && previous.sha256 !== normalized.sha256) fail("SOURCE_BINDING_CONFLICT", `conflicting source binding for ${normalized.kind}:${normalized.id}`);
    unique.set(key, normalized);
  }
  const normalized = [...unique.values()].sort((left, right) => left.kind.localeCompare(right.kind) || left.id.localeCompare(right.id) || left.sha256.localeCompare(right.sha256));
  return sha256Text(canonicalJson(normalized));
}
export async function retrospectiveSha256(retrospective: { id: string; articleId: string; projectId: string; releaseId: string | null; title: string; summary: string; evidenceRefs: string[]; state: string; lockVersion: number; updatedAt: string; contentSha256?: string }) {
  return sha256Text(canonicalJson({ id: retrospective.id, articleId: retrospective.articleId, projectId: retrospective.projectId, releaseId: retrospective.releaseId, title: retrospective.title, summary: retrospective.summary, evidenceRefs: [...retrospective.evidenceRefs].sort(), status: retrospective.state, lockVersion: retrospective.lockVersion, updatedAt: retrospective.updatedAt, contentSha256: retrospective.contentSha256 ?? null }));
}
function encodeBase64Url(value: string) {
  let binary = "";
  for (const byte of new TextEncoder().encode(value)) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}
function decodeBase64Url(value: string) {
  if (!/^[A-Za-z0-9_-]{1,2048}$/u.test(value)) fail("CURSOR_MALFORMED", "cursor is malformed");
  try {
    const padded = value.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - (value.length % 4)) % 4);
    const binary = atob(padded);
    return new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(binary, (character) => character.charCodeAt(0)));
  } catch { fail("CURSOR_MALFORMED", "cursor is malformed"); }
}
function validateCursor(value: unknown): TupleCursorPayload {
  const object = requireObject(value, "cursor");
  if (Object.keys(object).sort().join(",") !== "articleId,createdAt,filterSha256,id,v,view") fail("CURSOR_KEYS_INVALID", "cursor keys are invalid");
  const view = requireString(object.view, "view", 32);
  if (!CURSOR_VIEWS.has(view)) fail("CURSOR_VIEW_INVALID", "cursor view is invalid");
  return { v: requireInteger(object.v, "v", 1, 1) as 1, view: view as TupleCursorPayload["view"], articleId: requireId(object.articleId, "articleId"), filterSha256: requireSha256(object.filterSha256, "filterSha256"), createdAt: requireUtcIso(object.createdAt), id: requireId(object.id) };
}
export function encodeTupleCursor(payload: TupleCursorPayload) { return encodeBase64Url(canonicalJson(validateCursor(payload))); }
export function decodeTupleCursor(cursor: unknown, binding: Pick<TupleCursorPayload, "view" | "articleId" | "filterSha256">): TupleCursorPayload {
  const encoded = requireString(cursor, "cursor", MAX_CURSOR_BYTES);
  let value: unknown;
  try { value = JSON.parse(decodeBase64Url(encoded)); } catch { fail("CURSOR_MALFORMED", "cursor is malformed"); }
  const payload = validateCursor(value);
  if (payload.view !== binding.view || payload.articleId !== requireId(binding.articleId, "articleId") || payload.filterSha256 !== requireSha256(binding.filterSha256, "filterSha256")) fail("CURSOR_BINDING_MISMATCH", "cursor binding mismatch");
  return payload;
}
function summary(object: JsonObject, keys: string[]) { return Object.fromEntries(keys.filter((key) => key in object).map((key) => [key, object[key]])); }
export async function advisoryProposalContext(input: Record<string, unknown>): Promise<ProposalContextDto> {
  const requirements = requireArray(input.requirements ?? [], "requirements").map((value) => requireObject(value, "requirement"));
  const annotations = requireArray(input.annotations ?? [], "annotations").map((value) => requireObject(value, "annotation"));
  const retrospectives = requireArray(input.reviewedRetrospectives ?? [], "reviewedRetrospective").map((value) => requireObject(value, "reviewedRetrospective"));
  const supersededIds = new Set(annotations.flatMap((annotation) => typeof annotation.supersedesAnnotationId === "string" ? [annotation.supersedesAnnotationId] : []));
  const accepted = requirements.filter((requirement) => requirement.status === "accepted");
  const acceptedIds = new Set(accepted.map((requirement) => String(requirement.id)));
  const activeHuman = annotations.filter((annotation) => !supersededIds.has(String(annotation.id)) && acceptedIds.has(String(annotation.requirementId)) && typeof annotation.humanActorId === "string" && annotation.humanActorId.length > 0);
  const incompleteEvidence = activeHuman.some((annotation) => { try { requireSha256(annotation.snapshotSha256, "snapshotSha256"); requireArray(annotation.evidenceRefs, "evidenceRefs"); return false; } catch { return true; } });
  const requirementIds = accepted.map((requirement) => requireId(requirement.id));
  const annotationIds = activeHuman.map((annotation) => requireId(annotation.id));
  const retrospectiveIds = retrospectives.map((retrospective) => requireId(retrospective.id));
  const legacyBindings: SourceBinding[] = [
    ...await Promise.all(accepted.map(async (requirement) => ({ kind: "requirement", id: requireId(requirement.id), sha256: typeof requirement.inputSha256 === "string" ? requireSha256(requirement.inputSha256, "inputSha256") : await sha256Text(canonicalJson(requirement)) }))),
    ...await Promise.all(activeHuman.map(async (annotation) => ({ kind: "annotation", id: requireId(annotation.id), sha256: typeof annotation.annotationSha256 === "string" ? requireSha256(annotation.annotationSha256, "annotationSha256") : await sha256Text(canonicalJson(annotation)) }))),
    ...await Promise.all(retrospectives.map(async (retrospective) => ({ kind: "retrospective", id: requireId(retrospective.id), sha256: typeof retrospective.articleId === "string" && typeof retrospective.projectId === "string" && (typeof retrospective.releaseId === "string" || retrospective.releaseId === null) && typeof retrospective.title === "string" && typeof retrospective.summary === "string" && Array.isArray(retrospective.evidenceRefs) && typeof retrospective.state === "string" && typeof retrospective.lockVersion === "number" && typeof retrospective.updatedAt === "string" ? await retrospectiveSha256({ id: requireId(retrospective.id), articleId: retrospective.articleId, projectId: retrospective.projectId, releaseId: retrospective.releaseId, title: retrospective.title, summary: retrospective.summary, evidenceRefs: retrospective.evidenceRefs.filter((item): item is string => typeof item === "string"), state: retrospective.state, lockVersion: retrospective.lockVersion, updatedAt: retrospective.updatedAt, ...(typeof retrospective.contentSha256 === "string" ? { contentSha256: retrospective.contentSha256 } : {}) }) : await sha256Text(canonicalJson(retrospective)) }))),
  ];
  const digest = await sourceBindingsSha256(legacyBindings);
  const blockers: ProposalContextBlocker[] = [];
  if (!accepted.length) blockers.push({ code: "NO_ACCEPTED_REQUIREMENT", detail: "No accepted requirement." });
  if (!activeHuman.length) blockers.push({ code: "NO_ACTIVE_HUMAN_ANNOTATION", detail: "No active human annotation." });
  if (!retrospectives.length) blockers.push({ code: "NO_REVIEWED_RETROSPECTIVE", detail: "No reviewed retrospective." });
  if (incompleteEvidence) blockers.push({ code: "ANNOTATION_EVIDENCE_INCOMPLETE", detail: "Annotation evidence incomplete." });
  if (input.sourceSetSha256 !== undefined && requireSha256(input.sourceSetSha256, "sourceSetSha256") !== digest) blockers.push({ code: "SOURCE_DIGEST_STALE", detail: "Source digest stale." });
  return { advisoryOnly: true, bodyTextIncluded: false, autoCreateExperiment: false, autoAdopt: false, sourceRequirementIds: [...new Set(requirementIds)].sort(), sourceAnnotationIds: [...new Set(annotationIds)].sort(), sourceSetSha256: digest, requirementSummary: accepted.map((value) => summary(value, ["id", "articleId", "priority", "status", "createdAt"])), annotationSummary: activeHuman.map((value) => summary(value, ["id", "requirementId", "subjectType", "subjectId", "labelKind", "verdict", "severity", "snapshotSha256", "createdAt"])), reviewedRetrospectiveIds: [...new Set(retrospectiveIds)].sort(), eligibleForRuleCandidate: blockers.length === 0, blockers, items: [], page: { nextCursor: null } };
}

const TERMINAL_TASK_STATES = new Set(["succeeded", "failed", "cancelled"]);
const ACTIVE_TASK_STATES = new Set(["draft", "queued", "claimed", "running", "awaiting_human", "blocked", "review"]);
const DAY_MS = 24 * 60 * 60 * 1000;
const advisoryClaims = ["This is a deterministic local-fact advisory projection."];
const advisoryNotClaims = ["This does not prove adoption.", "This does not prove publication.", "This does not prove business effect."];

function projectionTime(value: string, field: string) { return Date.parse(requireUtcIso(value, field)); }
function isDue(when: string, asOf: number) { return asOf - projectionTime(when, "event time") >= DAY_MS; }
function distinctSorted(values: string[]) { return [...new Set(values)].sort(); }
function refsBind(refs: readonly string[], ids: readonly string[]) {
  return ids.some((id) => refs.includes(id) || refs.includes(`task:${id}`) || refs.includes(`annotation:${id}`) || refs.includes(`trigger:${id}`));
}
function typedRef(kind: string, id: string) { return `${kind}:${id}`; }
function staleBlocker(): ProposalContextBlocker { return { code: "SOURCE_DIGEST_STALE", detail: "Requested source digest does not match this projection." }; }

/** Pure, deterministic projection. `asOf` is mandatory so this never reads the clock. */
export async function buildRsiProposalContext(input: RsiProjectionInput): Promise<ProposalContextDto> {
  const asOf = projectionTime(input.asOf, "asOf");
  const requirements = input.acceptedRequirements.filter((requirement) => requirement.status === "accepted");
  const annotations = input.activeAnnotations;
  const retrospectives = input.reviewedOrClosedRetrospectives.filter((item) => item.state === "reviewed" || item.state === "closed");
  const requirementBindings: SourceBinding[] = requirements.map((item) => ({ kind: "requirement", id: item.id, sha256: item.inputSha256 }));
  const annotationBindings: SourceBinding[] = annotations.map((item) => ({ kind: "annotation", id: item.id, sha256: item.annotationSha256 }));
  const retrospectiveBindings: SourceBinding[] = await Promise.all(retrospectives.map(async (item) => ({ kind: "retrospective", id: item.id, sha256: await retrospectiveSha256(item) })));
  const taskBindingFor = async (task: RsiProjectionInput["tasks"][number]): Promise<SourceBinding> => ({ kind: "task", id: task.id, sha256: await sha256Text(canonicalJson({ state: task.state, createdAt: task.createdAt, finishedAt: task.finishedAt, currentContextSnapshotId: task.currentContextSnapshotId, contextSha256: task.contextSha256, progressEvents: [...task.progressEvents].sort((a, b) => a.id.localeCompare(b.id)) })) });
  const externalBindingFor = async (observation: RsiProjectionInput["externalObservations"][number]): Promise<SourceBinding> => ({ kind: "external", id: observation.id, sha256: await sha256Text(canonicalJson({ canonicalSource: observation.canonicalSource, sourceVersion: observation.sourceVersion, publishedAt: observation.publishedAt, contentSha256: observation.contentSha256, eventInputSha256: observation.eventInputSha256 })) });
  const taskBindings = await Promise.all(input.tasks.map(taskBindingFor));
  const externalBindings = await Promise.all(input.externalObservations.map(externalBindingFor));
  const requirementById = new Map(requirements.map((requirement) => [requirement.id, requirement]));
  const requirementBindingById = new Map(requirementBindings.map((binding) => [binding.id, binding]));
  const annotationById = new Map(annotations.map((annotation) => [annotation.id, annotation]));
  const annotationBindingById = new Map(annotationBindings.map((binding) => [binding.id, binding]));
  const retrospectiveBindingById = new Map(retrospectiveBindings.map((binding) => [binding.id, binding]));
  const taskBindingById = new Map(taskBindings.map((binding) => [binding.id, binding]));
  const externalBindingById = new Map(externalBindings.map((binding) => [binding.id, binding]));
  const annotationsByRequirementId = new Map<string, AnnotationDto[]>();
  for (const annotation of annotations) annotationsByRequirementId.set(annotation.requirementId, [...(annotationsByRequirementId.get(annotation.requirementId) ?? []), annotation]);
  const retrospectivesByEvidenceRef = new Map<string, RsiProjectionInput["reviewedOrClosedRetrospectives"]>();
  for (const retrospective of retrospectives) for (const ref of retrospective.evidenceRefs) retrospectivesByEvidenceRef.set(ref, [...(retrospectivesByEvidenceRef.get(ref) ?? []), retrospective]);
  const uniqueBindings = (values: SourceBinding[]) => [...new Map(values.map((binding) => [`${binding.kind}\u0000${binding.id}`, binding])).values()];
  const externalBindingsFor = (observation: RsiProjectionInput["externalObservations"][number]) => {
    const linkedRequirements = new Set<string>();
    const linkedAnnotations = new Set<string>();
    for (const ref of observation.evidenceRefs) {
      if (requirementById.has(ref)) linkedRequirements.add(ref);
      if (annotationById.has(ref)) linkedAnnotations.add(ref);
      if (ref.startsWith("requirement:") && requirementById.has(ref.slice("requirement:".length))) linkedRequirements.add(ref.slice("requirement:".length));
      if (ref.startsWith("annotation:") && annotationById.has(ref.slice("annotation:".length))) linkedAnnotations.add(ref.slice("annotation:".length));
    }
    for (const annotationId of linkedAnnotations) {
      const annotation = annotationById.get(annotationId);
      if (annotation && requirementById.has(annotation.requirementId)) linkedRequirements.add(annotation.requirementId);
    }
    for (const requirementId of linkedRequirements) for (const annotation of annotationsByRequirementId.get(requirementId) ?? []) linkedAnnotations.add(annotation.id);
    return uniqueBindings([
      externalBindingById.get(observation.id)!,
      ...[...linkedRequirements].map((id) => requirementBindingById.get(id)).filter((binding): binding is SourceBinding => Boolean(binding)),
      ...[...linkedAnnotations].map((id) => annotationBindingById.get(id)).filter((binding): binding is SourceBinding => Boolean(binding)),
    ]);
  };
  const allBindings = [...requirementBindings, ...annotationBindings, ...retrospectiveBindings, ...taskBindings, ...externalBindings];
  const sourceSetDigest = await sourceBindingsSha256(allBindings);
  const stale = input.requestedSourceSetSha256 !== undefined && requireSha256(input.requestedSourceSetSha256, "requestedSourceSetSha256") !== sourceSetDigest;
  const candidates = new Set(input.existingRuleCandidates.map((item) => item.sourceDigest));
  const items: ProposalContextItem[] = [];
  let derivedBindingEdges = 0;
  let derivedSourceRefs = 0;
  let derivedSourceRefUtf8Bytes = 0;
  const projectionLimit = (): never => fail("RSI_CONTEXT_LIMIT_EXCEEDED", "derived proposal exceeds the complete projection limit");
  const taskEdgeFloor = input.tasks.reduce((sum, task) => sum + 1 + task.requirementIds.length + task.annotationIds.length + task.progressEvents.length, 0);
  const externalInitialBindings = new Map(input.externalObservations.filter((observation) => observation.humanReviewed).map((observation) => [observation.id, externalBindingsFor(observation)]));
  const externalEdgeFloor = [...externalInitialBindings.values()].reduce((sum, bindings) => sum + bindings.length, 0);
  if (taskEdgeFloor + externalEdgeFloor > RSI_DERIVED_LIMITS.bindingEdges) projectionLimit();
  const make = async (kind: ProposalContextItem["triggerKind"], key: string, observedAt: string, dueAt: string | null, refs: string[], initialBindings: SourceBinding[], recommendation: string, action: string, contextMissing = false, officialFact?: string, inferredImpact?: string) => {
    const callerRefs = distinctSorted(refs);
    const blockers: ProposalContextBlocker[] = [];
    const relatedRequirementIds = new Set(initialBindings.filter((binding) => binding.kind === "requirement").map((binding) => binding.id));
    const relatedAnnotationById = new Map<string, AnnotationDto>();
    for (const binding of initialBindings) if (binding.kind === "annotation") {
      const annotation = annotationById.get(binding.id);
      if (annotation) relatedAnnotationById.set(annotation.id, annotation);
    }
    for (const requirementId of relatedRequirementIds) for (const annotation of annotationsByRequirementId.get(requirementId) ?? []) relatedAnnotationById.set(annotation.id, annotation);
    const relatedAnnotations = [...relatedAnnotationById.values()];
    if (!requirements.length) blockers.push({ code: "NO_ACCEPTED_REQUIREMENT", detail: "No accepted requirement is available." });
    if (!relatedAnnotations.length) blockers.push({ code: "NO_ACTIVE_HUMAN_ANNOTATION", detail: "No active annotation is bound to this proposal." });
    if (contextMissing) blockers.push({ code: "CONTEXT_SNAPSHOT_MISSING", detail: "The active task has no current context snapshot." });
    if (relatedAnnotations.some((annotation) => !annotation.evidenceRefs.length)) blockers.push({ code: "ANNOTATION_EVIDENCE_INCOMPLETE", detail: "A bound annotation has no evidence references." });
    const bindingIds = [...callerRefs, ...relatedAnnotations.map((annotation) => annotation.id), key];
    const candidateRetrospectiveRefs = new Set<string>();
    for (const id of bindingIds) for (const ref of [id, `task:${id}`, `annotation:${id}`, `trigger:${id}`]) candidateRetrospectiveRefs.add(ref);
    const boundRetrospectiveById = new Map<string, RsiProjectionInput["reviewedOrClosedRetrospectives"][number]>();
    for (const ref of candidateRetrospectiveRefs) for (const retrospective of retrospectivesByEvidenceRef.get(ref) ?? []) boundRetrospectiveById.set(retrospective.id, retrospective);
    const boundRetrospectives = [...boundRetrospectiveById.values()];
    if (!retrospectives.length) blockers.push({ code: "NO_REVIEWED_RETROSPECTIVE", detail: "No reviewed or closed retrospective is available." });
    else if (!boundRetrospectives.length) blockers.push({ code: "NO_BOUND_REVIEWED_RETROSPECTIVE", detail: "No reviewed or closed retrospective is evidence-bound to this trigger." });
    const bindings = uniqueBindings([...initialBindings, ...relatedAnnotations.map((annotation) => annotationBindingById.get(annotation.id)!), ...boundRetrospectives.map((retrospective) => retrospectiveBindingById.get(retrospective.id)!)]);
    derivedBindingEdges += bindings.length;
    if (derivedBindingEdges > RSI_DERIVED_LIMITS.bindingEdges) projectionLimit();
    const sourceRefs = distinctSorted([...callerRefs, ...bindings.map((binding) => typedRef(binding.kind, binding.id))]);
    derivedSourceRefs += sourceRefs.length;
    derivedSourceRefUtf8Bytes += sourceRefs.reduce((sum, ref) => sum + bytes(ref), 0);
    if (derivedSourceRefs > RSI_DERIVED_LIMITS.sourceRefs || derivedSourceRefUtf8Bytes > RSI_DERIVED_LIMITS.sourceRefUtf8Bytes) projectionLimit();
    const sourceDigest = await sourceBindingsSha256(bindings);
    if (candidates.has(sourceDigest)) blockers.push({ code: "ALREADY_HAS_RULE_CANDIDATE", detail: "A rule candidate already uses this source digest." });
    if (stale) blockers.push(staleBlocker());
    const proposalId = `rsi:${(await sha256Text(canonicalJson({ v: 1, triggerKind: kind, triggerKey: key, sourceDigest }))).slice(0, 32)}`;
    if (items.length >= RSI_DERIVED_LIMITS.items) projectionLimit();
    items.push({ proposalId, triggerKind: kind, triggerKey: key, sourceRefs, sourceDigest, observedAt, dueAt, recommendation, eligibleForRuleCandidate: blockers.length === 0, blockers, humanNextAction: action, claims: advisoryClaims, notClaims: advisoryNotClaims, ...(officialFact === undefined ? {} : { officialFact }), ...(inferredImpact === undefined ? {} : { inferredImpact }) });
  };
  for (const task of input.tasks) {
    const taskBindingsForItem: SourceBinding[] = [taskBindingById.get(task.id)!, ...task.requirementIds.map((id) => requirementBindingById.get(id)).filter((binding): binding is SourceBinding => Boolean(binding)), ...task.annotationIds.map((id) => annotationBindingById.get(id)).filter((binding): binding is SourceBinding => Boolean(binding)), ...task.progressEvents.map((event) => ({ kind: "event", id: event.id, sha256: event.inputSha256 }))];
    const refs = distinctSorted([typedRef("task", task.id), ...(task.currentContextSnapshotId ? [typedRef("context", task.currentContextSnapshotId)] : []), ...task.requirementIds.map((id) => typedRef("requirement", id)), ...task.annotationIds.map((id) => typedRef("annotation", id)), ...task.progressEvents.map((event) => typedRef("event", event.id))]);
    if (ACTIVE_TASK_STATES.has(task.state)) await make("new_task", task.id, task.createdAt, null, refs, taskBindingsForItem, "Review task context and record a human annotation before considering a rule candidate.", "A human should assess the task and attach evidence-backed annotation.", !task.currentContextSnapshotId || !task.contextSha256);
    if (TERMINAL_TASK_STATES.has(task.state) && task.finishedAt) {
      await make("task_terminal", task.id, task.finishedAt, null, refs, taskBindingsForItem, "Review the real terminal outcome and bind a retrospective to its evidence.", "A human should review the terminal task outcome and retrospective evidence.");
      const dueAt = new Date(projectionTime(task.finishedAt, "finishedAt") + DAY_MS).toISOString();
      const bound = retrospectives.some((retrospective) => refsBind(retrospective.evidenceRefs, [task.id, typedRef("task", task.id), `task-retrospective:${task.id}`]));
      if (isDue(task.finishedAt, asOf) && !bound) await make("review_due", `task-retrospective:${task.id}`, task.finishedAt, dueAt, refs, taskBindingsForItem, "Bind a reviewed or closed retrospective to the terminal task evidence.", "A human should attach retrospective evidence to this terminal task.");
    }
  }
  for (const requirement of requirements) {
    const acceptedAt = requirement.acceptedAt ?? requirement.createdAt;
    const hasAnnotation = (annotationsByRequirementId.get(requirement.id) ?? []).length > 0;
    if (isDue(acceptedAt, asOf) && !hasAnnotation) await make("review_due", `requirement:${requirement.id}`, acceptedAt, new Date(projectionTime(acceptedAt, "acceptedAt") + DAY_MS).toISOString(), [typedRef("requirement", requirement.id)], [requirementBindingById.get(requirement.id)!], "Create an evidence-backed human annotation for the accepted requirement.", "A human should annotate the accepted requirement with evidence.");
  }
  for (const observation of input.externalObservations) if (observation.humanReviewed) await make("external_ai_change", observation.id, observation.observedAt, null, [typedRef("external", observation.id), ...observation.evidenceRefs.map((ref) => typedRef("evidence", ref))], externalInitialBindings.get(observation.id)!, "Review the imported official fact and decide whether any local annotation needs updating.", "A human should verify local relevance before any rule proposal.", false, observation.officialFact, observation.inferredImpact);
  items.sort((left, right) => left.triggerKind.localeCompare(right.triggerKind) || left.triggerKey.localeCompare(right.triggerKey) || left.proposalId.localeCompare(right.proposalId));
  if (items.length > RSI_DERIVED_LIMITS.items) items.splice(RSI_DERIVED_LIMITS.items);
  const sourceRequirementIds = distinctSorted(requirements.map((item) => item.id));
  const sourceAnnotationIds = distinctSorted(annotations.map((item) => item.id));
  const reviewedRetrospectiveIds = distinctSorted(retrospectives.map((item) => item.id));
  const proposal: ProposalContextDto = { advisoryOnly: true, bodyTextIncluded: false, autoCreateExperiment: false, autoAdopt: false, sourceRequirementIds, sourceAnnotationIds, sourceSetSha256: sourceSetDigest, requirementSummary: requirements.map((item) => ({ id: item.id, articleId: item.articleId, priority: item.priority, status: item.status, createdAt: item.createdAt })), annotationSummary: annotations.map((item) => ({ id: item.id, requirementId: item.requirementId, subjectType: item.subjectType, subjectId: item.subjectId, labelKind: item.labelKind, verdict: item.verdict, severity: item.severity, snapshotSha256: item.snapshotSha256, createdAt: item.createdAt })), reviewedRetrospectiveIds, eligibleForRuleCandidate: !stale && items.some((item) => item.eligibleForRuleCandidate), blockers: stale ? [staleBlocker()] : [], items, page: { nextCursor: null } };
  if (bytes(JSON.stringify(proposal)) > RSI_DERIVED_LIMITS.encodedProposalBytes) projectionLimit();
  return proposal;
}
