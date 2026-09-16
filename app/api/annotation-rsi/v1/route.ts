import { env } from "cloudflare:workers";
import { ManagementAuthError } from "../../../management-auth-core";
import { managementActorId, requireManagementSession, type ManagementPrincipal } from "../../../management-auth";
import { ANNOTATION_RSI_SCHEMA_VERSION, AnnotationRsiValidationError, RSI_DERIVED_LIMITS, buildRsiProposalContext, annotationSha256, canonicalJson, decodeTupleCursor, encodeTupleCursor, requireArray, requireId, requireInteger, requireObject, requireSha256, requireString, sha256Text } from "../../../annotation-rsi";
import { ANNOTATION_LABEL_KINDS, ANNOTATION_SEVERITIES, ANNOTATION_SUBJECT_TYPES, ANNOTATION_VERDICTS, type ProposalSummaryDto } from "../../../annotation-rsi-types";
import { RsiLifecycleError, handleRsiLifecycleAction, readRsiLifecycle, rsiHumanActions, rsiLifecycleActions, rsiLifecycleViews, type RsiLifecycleAction } from "../../../annotation-rsi-lifecycle";

type Obj = Record<string, unknown>;
type Row = Record<string, string | number | null>;
type BaseAction = "initialize_workspace" | "create_requirement" | "accept_requirement" | "supersede_requirement" | "create_human_annotation" | "record_external_ai_observation";
type Action = BaseAction | RsiLifecycleAction;
const actions = new Set<Action>(["initialize_workspace", "create_requirement", "accept_requirement", "supersede_requirement", "create_human_annotation", "record_external_ai_observation", ...rsiLifecycleActions]);
const humanActions = new Set<Action>(["accept_requirement", "supersede_requirement", "create_human_annotation", "record_external_ai_observation", ...rsiHumanActions]);
class ApiError extends Error { constructor(readonly code: string, readonly status = 400, message = code) { super(message); } }
const database = () => { if (!env.DB) throw new ApiError("DB_UNAVAILABLE", 503); return env.DB; };
const timestamp = () => new Date().toISOString();
const error = (value: unknown) => value instanceof ApiError || value instanceof ManagementAuthError || value instanceof RsiLifecycleError ? value : value instanceof AnnotationRsiValidationError ? new ApiError(value.code, value.code === "RSI_CONTEXT_LIMIT_EXCEEDED" ? 409 : 400, value.message) : new ApiError("INTERNAL_ERROR", 500);
const reply = (requestId: string, status: number, data?: Obj, failure?: ApiError | ManagementAuthError | RsiLifecycleError) => Response.json(failure ? { ok: false, requestId, error: { code: failure.code, message: failure.message } } : { ok: true, requestId, data }, { status });
const stableId = async (kind: string, commandId: string, sha: string) => `${kind}:${(await sha256Text(`${kind}:${commandId}:${sha}`)).slice(0, 48)}`;
function exact(object: Obj, keys: string[], name: string) { if (Object.keys(object).sort().join(",") !== keys.sort().join(",")) throw new ApiError(`${name}_KEYS_INVALID`); }
function enumValue<T extends readonly string[]>(value: unknown, values: T, field: string): T[number] { const result = requireString(value, field, 64); if (!values.includes(result)) throw new ApiError("ENUM_INVALID"); return result as T[number]; }
function human(principal: ManagementPrincipal) { if (principal.authBasis !== "owner_pairing" && principal.authBasis !== "trusted_device") throw new ApiError("HUMAN_ACTION_AUTH_BASIS_DENIED", 403); }
async function ready(db: D1Database) {
  const names = ["article_requirements", "human_annotations", "command_receipts", "lifecycle_events", "annotation_rsi_rule_candidates", "annotation_rsi_baseline_revisions", "annotation_rsi_due_checks"];
  const found = await db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name IN (${names.map(() => "?").join(",")})`).bind(...names).all<Row>();
  if (found.results.length !== names.length) throw new ApiError("ANNOTATION_RSI_NOT_INITIALIZED", 409);
  return db;
}
async function parse(request: Request) {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) throw new ApiError("UNSUPPORTED_MEDIA_TYPE", 415);
  const raw = await request.text(); if (new TextEncoder().encode(raw).byteLength > 122880) throw new ApiError("PAYLOAD_TOO_LARGE", 413);
  let json: unknown; try { json = JSON.parse(raw); } catch { throw new ApiError("INVALID_JSON"); }
  const top = requireObject(json, "body"); exact(top, ["action", "commandId", "payload"], "BODY");
  const action = requireString(top.action, "action", 64) as Action; if (!actions.has(action)) throw new ApiError("ACTION_UNSUPPORTED");
  const payload = requireObject(top.payload, "payload");
  return { action, commandId: requireId(top.commandId, "commandId"), payload, articleId: requireId(payload.articleId, "articleId") };
}
function event(db: D1Database, articleId: string, type: string, subjectType: string, subjectId: string, id: string, sha: string, at: string) {
  return db.prepare("INSERT INTO lifecycle_events (id,article_id,event_type,subject_type,subject_id,payload_json,input_sha256,created_at) VALUES (?,?,?,?,?,?,?,?)").bind(id, articleId, type, subjectType, subjectId, "{}", sha, at);
}
function receipt(db: D1Database, id: string, type: string, actor: string, requestSha: string, data: Obj, status: number, at: string) {
  return db.prepare("INSERT INTO command_receipts (id,command_type,actor_id,request_sha256,response_json,status_code,created_at,completed_at) VALUES (?,?,?,?,?,?,?,?)").bind(id, type, actor, requestSha, JSON.stringify(data), status, at, at);
}
async function previous(db: D1Database, id: string, type: string, actor: string, requestSha: string) {
  const row = await db.prepare("SELECT command_type,actor_id,request_sha256,response_json,status_code FROM command_receipts WHERE id=?").bind(id).first<Row>();
  if (!row) return null;
  if (row.command_type !== type || row.actor_id !== actor || row.request_sha256 !== requestSha) throw new ApiError("COMMAND_ID_REUSED", 409);
  return { status: Number(row.status_code), data: JSON.parse(String(row.response_json)) as Obj };
}
async function requirementBase(db: D1Database, payload: Obj, articleId: string) {
  const packageId = requireId(payload.packageId, "packageId"), branchId = requireId(payload.branchId, "branchId"), baseRevisionId = requireId(payload.baseRevisionId, "baseRevisionId"), baseBodySha256 = requireSha256(payload.baseBodySha256, "baseBodySha256");
  const row = await db.prepare("SELECT b.head_revision_id,r.body_sha256 FROM article_project_packages p JOIN package_branch_states b ON b.package_id=p.id JOIN article_revisions r ON r.id=b.head_revision_id AND r.article_id=p.article_id AND r.branch_id=b.branch_id WHERE p.id=? AND p.article_id=? AND p.status='active' AND b.branch_id=? AND b.status='active'").bind(packageId, articleId, branchId).first<Row>();
  if (!row || row.head_revision_id !== baseRevisionId || row.body_sha256 !== baseBodySha256) throw new ApiError("REQUIREMENT_INPUT_INVALID", 409);
  return { packageId, branchId, baseRevisionId, baseBodySha256 };
}
async function createRequirement(db: D1Database, payload: Obj, articleId: string, principal: ManagementPrincipal, commandId: string, requestSha: string) {
  exact(payload, ["acceptance", "articleId", "baseBodySha256", "baseRevisionId", "branchId", "packageId", "priority", "requirementKey", "requirementText", "supersedesRequirementId", "title"], "CREATE_REQUIREMENT");
  const base = await requirementBase(db, payload, articleId), requirementKey = requireId(payload.requirementKey, "requirementKey"), supersedes = payload.supersedesRequirementId === null ? null : requireId(payload.supersedesRequirementId, "supersedesRequirementId");
  let revision = 1;
  let oldSnapshot: { revision: number; status: string } | null = null;
  if (supersedes) {
    const old = await db.prepare("SELECT article_id,requirement_key,revision,status FROM article_requirements WHERE id=?").bind(supersedes).first<Row>();
    if (!old || old.article_id !== articleId || old.requirement_key !== requirementKey || !["draft", "accepted"].includes(String(old.status))) throw new ApiError("REQUIREMENT_SUPERSESSION_INVALID", 409);
    oldSnapshot = { revision: Number(old.revision), status: String(old.status) };
    revision = oldSnapshot.revision + 1;
  }
  const title = requireString(payload.title, "title", 1000), requirementText = requireString(payload.requirementText, "requirementText", 16000), acceptance = requireObject(payload.acceptance, "acceptance"), priority = enumValue(payload.priority, ["must", "should", "could"] as const, "priority"), at = timestamp(), id = await stableId("requirement", commandId, requestSha);
  const createdByKind = principal.authBasis === "site_full_control_key" ? "agent" : "human";
  const data = { id, articleId, requirementKey, revision, status: "draft", lockVersion: 1, inputSha256: requestSha };
  const supersedesGuard = oldSnapshot
    ? "EXISTS(SELECT 1 FROM article_requirements old WHERE old.id=? AND old.article_id=? AND old.requirement_key=? AND old.revision=? AND old.status=?)"
    : "1=1";
  const insert = db.prepare(`INSERT INTO article_requirements (id,article_id,requirement_key,revision,supersedes_requirement_id,package_id,branch_id,base_revision_id,base_body_sha256,title,requirement_text,acceptance_json,priority,input_sha256,status,lock_version,created_by_kind,created_by,create_command_id,last_command_id,created_at,updated_at)
    SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,'draft',1,?,?,?,?,?,?
    WHERE EXISTS(
      SELECT 1 FROM article_project_packages p
      JOIN package_branch_states b ON b.package_id=p.id
      JOIN article_revisions r ON r.id=b.head_revision_id AND r.article_id=p.article_id AND r.branch_id=b.branch_id
      WHERE p.id=? AND p.article_id=? AND p.status='active' AND b.branch_id=? AND b.status='active' AND b.head_revision_id=? AND r.body_sha256=?
    ) AND ${supersedesGuard}`)
    .bind(id, articleId, requirementKey, revision, supersedes, base.packageId, base.branchId, base.baseRevisionId, base.baseBodySha256, title, requirementText, canonicalJson(acceptance), priority, requestSha, createdByKind, principal.principalId, commandId, commandId, at, at, base.packageId, articleId, base.branchId, base.baseRevisionId, base.baseBodySha256, ...(oldSnapshot ? [supersedes, articleId, requirementKey, oldSnapshot.revision, oldSnapshot.status] : []));
  const result = await db.batch([
    insert,
    db.prepare("SELECT CASE WHEN EXISTS(SELECT 1 FROM article_requirements WHERE id=? AND article_id=? AND input_sha256=? AND create_command_id=?) THEN 1 ELSE json('annotation-rsi-cas-conflict') END").bind(id, articleId, requestSha, commandId),
    event(db, articleId, "requirement.created", "article_requirement", id, await stableId("event", commandId, requestSha), requestSha, at),
    receipt(db, commandId, "annotation-rsi.v1.create_requirement", managementActorId(principal), requestSha, data, 201, at),
  ]);
  if (result.length !== 4) throw new ApiError("BATCH_INCOMPLETE", 500);
  return { status: 201, data };
}
async function accept(db: D1Database, payload: Obj, articleId: string, principal: ManagementPrincipal, commandId: string, requestSha: string) {
  human(principal);
  exact(payload, ["articleId", "expectedInputSha256", "expectedLockVersion", "expectedStatus", "note", "requirementId"], "ACCEPT_REQUIREMENT");
  const id = requireId(payload.requirementId, "requirementId");
  const lock = requireInteger(payload.expectedLockVersion, "expectedLockVersion");
  const sha = requireSha256(payload.expectedInputSha256, "expectedInputSha256");
  requireString(payload.note, "note", 16000);
  if (payload.expectedStatus !== "draft") throw new ApiError("REQUIREMENT_CAS_EXPECTATION_INVALID");
  const at = timestamp(), data = { id, articleId, status: "accepted", lockVersion: lock + 1 };
  await db.batch([
    db.prepare("UPDATE article_requirements SET status='accepted',lock_version=lock_version+1,last_command_id=?,updated_at=?,accepted_by=?,accepted_at=? WHERE id=? AND article_id=? AND status='draft' AND lock_version=? AND input_sha256=?").bind(commandId, at, principal.principalId, at, id, articleId, lock, sha),
    db.prepare("SELECT CASE WHEN EXISTS(SELECT 1 FROM article_requirements WHERE id=? AND article_id=? AND status='accepted' AND lock_version=? AND last_command_id=?) THEN 1 ELSE json('annotation-rsi-cas-conflict') END").bind(id, articleId, lock + 1, commandId),
    event(db, articleId, "requirement.accepted", "article_requirement", id, await stableId("event", commandId, requestSha), requestSha, at),
    receipt(db, commandId, "annotation-rsi.v1.accept_requirement", managementActorId(principal), requestSha, data, 200, at),
  ]);
  return { status: 200, data };
}
async function supersede(db: D1Database, payload: Obj, articleId: string, principal: ManagementPrincipal, commandId: string, requestSha: string) {
  human(principal); exact(payload, ["articleId", "note", "oldExpectedInputSha256", "oldExpectedLockVersion", "oldExpectedStatus", "oldRequirementId", "replacementExpectedInputSha256", "replacementExpectedLockVersion", "replacementExpectedStatus", "replacementRequirementId"], "SUPERSEDE_REQUIREMENT");
  const oldId = requireId(payload.oldRequirementId, "oldRequirementId"), replacementId = requireId(payload.replacementRequirementId, "replacementRequirementId"), oldLock = requireInteger(payload.oldExpectedLockVersion, "oldExpectedLockVersion"), newLock = requireInteger(payload.replacementExpectedLockVersion, "replacementExpectedLockVersion"), oldSha = requireSha256(payload.oldExpectedInputSha256, "oldExpectedInputSha256"), newSha = requireSha256(payload.replacementExpectedInputSha256, "replacementExpectedInputSha256");
  requireString(payload.note, "note", 16000);
  if (payload.oldExpectedStatus !== "accepted" || payload.replacementExpectedStatus !== "draft") throw new ApiError("REQUIREMENT_CAS_EXPECTATION_INVALID");
  const relation = await db.prepare("SELECT o.id FROM article_requirements o JOIN article_requirements n ON n.id=? WHERE o.id=? AND o.article_id=? AND n.article_id=o.article_id AND n.requirement_key=o.requirement_key AND n.revision=o.revision+1 AND n.supersedes_requirement_id=o.id").bind(replacementId, oldId, articleId).first(); if (!relation) throw new ApiError("REQUIREMENT_SUPERSESSION_INVALID", 409);
  const at = timestamp(), data = { oldRequirementId: oldId, replacementRequirementId: replacementId, articleId, oldStatus: "superseded", replacementStatus: "accepted" };
  const result = await db.batch([
    db.prepare("UPDATE article_requirements AS o SET status='superseded',lock_version=lock_version+1,last_command_id=?,updated_at=?,superseded_at=? WHERE id=? AND article_id=? AND status='accepted' AND lock_version=? AND input_sha256=? AND EXISTS(SELECT 1 FROM article_requirements n WHERE n.id=? AND n.article_id=o.article_id AND n.requirement_key=o.requirement_key AND n.revision=o.revision+1 AND n.supersedes_requirement_id=o.id AND n.status='draft' AND n.lock_version=? AND n.input_sha256=?)").bind(commandId, at, at, oldId, articleId, oldLock, oldSha, replacementId, newLock, newSha),
    db.prepare("SELECT CASE WHEN EXISTS(SELECT 1 FROM article_requirements WHERE id=? AND article_id=? AND status='superseded' AND lock_version=? AND last_command_id=? AND superseded_at=?) THEN 1 ELSE json('annotation-rsi-cas-conflict') END").bind(oldId, articleId, oldLock + 1, commandId, at),
    db.prepare("UPDATE article_requirements AS n SET status='accepted',lock_version=lock_version+1,last_command_id=?,updated_at=?,accepted_by=?,accepted_at=? WHERE id=? AND article_id=? AND status='draft' AND lock_version=? AND input_sha256=? AND supersedes_requirement_id=? AND EXISTS(SELECT 1 FROM article_requirements o WHERE o.id=n.supersedes_requirement_id AND o.article_id=n.article_id AND o.status='superseded' AND o.lock_version=? AND o.last_command_id=?)").bind(commandId, at, principal.principalId, at, replacementId, articleId, newLock, newSha, oldId, oldLock + 1, commandId),
    db.prepare("SELECT CASE WHEN (SELECT COUNT(*) FROM article_requirements WHERE article_id=? AND ((id=? AND status='superseded' AND lock_version=? AND last_command_id=?) OR (id=? AND status='accepted' AND lock_version=? AND last_command_id=?)))=2 THEN 1 ELSE json('annotation-rsi-cas-conflict') END").bind(articleId, oldId, oldLock + 1, commandId, replacementId, newLock + 1, commandId),
    event(db, articleId, "requirement.superseded", "article_requirement", oldId, await stableId("event", commandId, requestSha), requestSha, at),
    receipt(db, commandId, "annotation-rsi.v1.supersede_requirement", managementActorId(principal), requestSha, data, 200, at),
  ]);
  if (result.length !== 6) throw new ApiError("BATCH_INCOMPLETE", 500);
  return { status: 200, data };
}
async function annotation(db: D1Database, payload: Obj, articleId: string, principal: ManagementPrincipal, commandId: string, requestSha: string) {
  human(principal); exact(payload, ["articleId", "details", "evidenceRefs", "labelKind", "labelSchemaVersion", "note", "requirementId", "severity", "snapshotSha256", "subjectId", "subjectType", "supersedesAnnotationId", "verdict"], "CREATE_HUMAN_ANNOTATION");
  const requirementId = requireId(payload.requirementId, "requirementId"), subjectType = enumValue(payload.subjectType, ANNOTATION_SUBJECT_TYPES, "subjectType"), subjectId = requireId(payload.subjectId, "subjectId"), snapshotSha256 = requireSha256(payload.snapshotSha256, "snapshotSha256"), labelSchemaVersion = requireInteger(payload.labelSchemaVersion, "labelSchemaVersion"), labelKind = enumValue(payload.labelKind, ANNOTATION_LABEL_KINDS, "labelKind"), verdict = enumValue(payload.verdict, ANNOTATION_VERDICTS, "verdict"), severity = enumValue(payload.severity, ANNOTATION_SEVERITIES, "severity"), note = typeof payload.note === "string" ? payload.note : "", details = requireObject(payload.details, "details"), evidenceRefs = requireArray(payload.evidenceRefs, "evidenceRefs").map((value) => requireString(value, "evidenceRef", 512));
  if (new TextEncoder().encode(note).byteLength > 16000) throw new ApiError("UTF8_BYTE_LIMIT_EXCEEDED");
  if ((verdict === "fail" || severity === "critical") && !note) throw new ApiError("ANNOTATION_NOTE_REQUIRED"); if (severity === "critical" && evidenceRefs.length === 0) throw new ApiError("ANNOTATION_EVIDENCE_REQUIRED");
  if (!await db.prepare("SELECT id FROM article_requirements WHERE id=? AND article_id=? AND status='accepted'").bind(requirementId, articleId).first()) throw new ApiError("REQUIREMENT_NOT_ACCEPTED", 409);
  const table = subjectType === "article_revision" ? "article_revisions" : subjectType === "publication_version" ? "article_publication_versions" : "lifecycle_builds", digest = subjectType === "article_revision" ? "body_sha256" : subjectType === "publication_version" ? "registration_sha256" : "artifact_sha256";
  const source = await db.prepare(`SELECT ${digest} digest${subjectType === "build" ? ",state" : ""} FROM ${table} WHERE id=? AND article_id=?`).bind(subjectId, articleId).first<Row>(); if (!source || source.digest !== snapshotSha256 || (subjectType === "build" && source.state !== "built")) throw new ApiError("SUBJECT_SNAPSHOT_MISMATCH", 409);
  const supersedes = payload.supersedesAnnotationId === null ? null : requireId(payload.supersedesAnnotationId, "supersedesAnnotationId"); if (supersedes && !await db.prepare("SELECT id FROM human_annotations WHERE id=? AND requirement_id=? AND subject_type=? AND subject_id=? AND snapshot_sha256=? AND NOT EXISTS(SELECT 1 FROM human_annotations c WHERE c.supersedes_annotation_id=human_annotations.id)").bind(supersedes, requirementId, subjectType, subjectId, snapshotSha256).first()) throw new ApiError("ANNOTATION_SUPERSESSION_INVALID", 409);
  const at = timestamp(), id = await stableId("annotation", commandId, requestSha), binding = { articleId, requirementId, subjectType, subjectId, snapshotSha256, labelSchemaVersion, labelKind, verdict, severity, note, details, evidenceRefs, supersedesAnnotationId: supersedes, humanActorId: principal.principalId, createdAt: at }, annotationSha = await annotationSha256(binding), data = { id, articleId, requirementId, subjectType, subjectId, snapshotSha256, annotationSha256: annotationSha, inputSha256: requestSha, commandId, status: "created" };
  const activeSupersedeGuard = supersedes === null
    ? "1=1"
    : "EXISTS(SELECT 1 FROM human_annotations old WHERE old.id=? AND old.requirement_id=? AND old.subject_type=? AND old.subject_id=? AND old.snapshot_sha256=? AND NOT EXISTS(SELECT 1 FROM human_annotations child WHERE child.supersedes_annotation_id=old.id))";
  const subjectGuard = `${digest}=?${subjectType === "build" ? " AND state='built'" : ""}`;
  await db.batch([
    db.prepare(`INSERT INTO human_annotations (id,article_id,requirement_id,subject_type,subject_id,snapshot_sha256,label_schema_version,label_kind,verdict,severity,note,details_json,evidence_refs_json,annotation_sha256,supersedes_annotation_id,input_sha256,human_actor_id,command_id,created_at) SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM article_requirements WHERE id=? AND article_id=? AND status='accepted') AND EXISTS(SELECT 1 FROM ${table} WHERE id=? AND article_id=? AND ${subjectGuard}) AND ${activeSupersedeGuard}`).bind(id, articleId, requirementId, subjectType, subjectId, snapshotSha256, labelSchemaVersion, labelKind, verdict, severity, note, canonicalJson(details), canonicalJson(evidenceRefs), annotationSha, supersedes, requestSha, principal.principalId, commandId, at, requirementId, articleId, subjectId, articleId, snapshotSha256, ...(supersedes === null ? [] : [supersedes, requirementId, subjectType, subjectId, snapshotSha256])),
    db.prepare("SELECT CASE WHEN EXISTS(SELECT 1 FROM human_annotations WHERE id=? AND command_id=? AND article_id=? AND input_sha256=?) THEN 1 ELSE json('annotation-rsi-cas-conflict') END").bind(id, commandId, articleId, requestSha),
    event(db, articleId, "annotation.created", "human_annotation", id, await stableId("event", commandId, requestSha), requestSha, at),
    receipt(db, commandId, "annotation-rsi.v1.create_human_annotation", managementActorId(principal), requestSha, data, 201, at),
  ]);
  return { status: 201, data };
}
function reqDto(r: Row) { return { id: r.id, articleId: r.article_id, requirementKey: r.requirement_key, revision: r.revision, supersedesRequirementId: r.supersedes_requirement_id, packageId: r.package_id, branchId: r.branch_id, baseRevisionId: r.base_revision_id, baseBodySha256: r.base_body_sha256, title: r.title, requirementText: r.requirement_text, acceptance: JSON.parse(String(r.acceptance_json)), priority: r.priority, inputSha256: r.input_sha256, status: r.status, lockVersion: r.lock_version, createdByKind: r.created_by_kind, creatorId: r.created_by, acceptedBy: r.accepted_by, createdAt: r.created_at, updatedAt: r.updated_at, acceptedAt: r.accepted_at, supersededAt: r.superseded_at, cancelledAt: r.cancelled_at }; }
function annDto(r: Row) { return { id: r.id, articleId: r.article_id, requirementId: r.requirement_id, subjectType: r.subject_type, subjectId: r.subject_id, snapshotSha256: r.snapshot_sha256, labelSchemaVersion: r.label_schema_version, labelKind: r.label_kind, verdict: r.verdict, severity: r.severity, note: r.note, details: JSON.parse(String(r.details_json)), evidenceRefs: JSON.parse(String(r.evidence_refs_json)), annotationSha256: r.annotation_sha256, inputSha256: r.input_sha256, commandId: r.command_id, supersedesAnnotationId: r.supersedes_annotation_id, humanActorId: r.human_actor_id, createdAt: r.created_at }; }
async function list(db: D1Database, view: "requirements" | "annotations", articleId: string, url: URL) {
  const limit = requireInteger(Number(url.searchParams.get("limit") ?? 24), "limit", 1, 100), filterSha256 = await sha256Text(canonicalJson({ view, articleId })), cursor = url.searchParams.get("cursor") ? decodeTupleCursor(url.searchParams.get("cursor"), { view, articleId, filterSha256 }) : null, alias = view === "requirements" ? "r" : "a", from = view === "requirements" ? "article_requirements r" : "human_annotations a JOIN article_requirements r ON r.id=a.requirement_id", rows = await db.prepare(`SELECT ${alias}.* FROM ${from} WHERE r.article_id=? ${cursor ? `AND (${alias}.created_at<? OR (${alias}.created_at=? AND ${alias}.id<?))` : ""} ORDER BY ${alias}.created_at DESC,${alias}.id DESC LIMIT ?`).bind(articleId, ...(cursor ? [cursor.createdAt, cursor.createdAt, cursor.id] : []), limit + 1).all<Row>(), items = rows.results.slice(0, limit), last = items.at(-1);
  return { schemaVersion: ANNOTATION_RSI_SCHEMA_VERSION, articleId, view, bodyTextIncluded: false, items: items.map(view === "requirements" ? reqDto : annDto), page: { limit, nextCursor: rows.results.length > limit && last ? encodeTupleCursor({ v: 1, view, articleId, filterSha256, createdAt: String(last.created_at), id: String(last.id) }) : null } };
}
const RSI_CONTEXT_LIMITS = { requirements: 512, annotations: 2048, retrospectives: 512, tasks: 512, progressEvents: 4096, externalObservations: 512, ruleCandidates: 1024 } as const;
const RSI_SUMMARY_LIMITS = { requirements: 256, annotations: 768, retrospectives: 256, tasks: 256, progressEvents: 1536, externalObservations: 256, ruleCandidates: 512 } as const;
type ContextReadLabel = keyof typeof RSI_CONTEXT_LIMITS;
function boundedStatement(db: D1Database, label: ContextReadLabel, sql: string, bindings: unknown[]) {
  const limit = RSI_CONTEXT_LIMITS[label];
  return db.prepare(`${sql} LIMIT ?`).bind(...bindings, limit + 1);
}
function completeRows(label: ContextReadLabel, result: D1Result<Row>) {
  const rows = result.results;
  if (rows.length > RSI_CONTEXT_LIMITS[label]) throw new ApiError("RSI_CONTEXT_LIMIT_EXCEEDED", 409, `${label} exceeds the complete projection limit`);
  return rows;
}
async function context(db: D1Database, articleId: string, url: URL) {
  const asOf = url.searchParams.get("asOf") ?? timestamp();
  const asOfDate = new Date(asOf);
  if (!Number.isFinite(asOfDate.getTime()) || asOfDate.toISOString() !== asOf) throw new ApiError("AS_OF_INVALID");
  const reads = [
    { label: "requirements" as const, statement: boundedStatement(db, "requirements", "SELECT id,article_id,priority,status,created_at,accepted_at,input_sha256,lock_version,base_revision_id,base_body_sha256 FROM article_requirements WHERE article_id=? AND status='accepted' ORDER BY id", [articleId]) },
    { label: "annotations" as const, statement: boundedStatement(db, "annotations", "SELECT a.* FROM human_annotations a JOIN article_requirements r ON r.id=a.requirement_id WHERE a.article_id=? AND r.article_id=? AND r.status='accepted' AND NOT EXISTS(SELECT 1 FROM human_annotations c WHERE c.supersedes_annotation_id=a.id) ORDER BY a.id", [articleId, articleId]) },
    { label: "retrospectives" as const, statement: boundedStatement(db, "retrospectives", "SELECT * FROM lifecycle_retrospectives WHERE article_id=? AND status IN ('reviewed','closed') ORDER BY id", [articleId]) },
    { label: "tasks" as const, statement: boundedStatement(db, "tasks", "SELECT t.id,t.state,t.created_at,t.finished_at,t.base_revision_id,t.current_context_snapshot_id,c.revision_id,c.body_sha256,c.context_sha256 FROM agent_tasks t LEFT JOIN agent_context_snapshots c ON c.id=t.current_context_snapshot_id AND c.task_id=t.id AND c.article_id=t.article_id WHERE t.article_id=? ORDER BY t.id", [articleId]) },
    { label: "progressEvents" as const, statement: boundedStatement(db, "progressEvents", "SELECT e.id,e.task_id,e.event_type,e.input_sha256,e.created_at FROM agent_progress_events e JOIN agent_tasks t ON t.id=e.task_id WHERE t.article_id=? ORDER BY e.task_id,e.created_at,e.id", [articleId]) },
    { label: "externalObservations" as const, statement: boundedStatement(db, "externalObservations", "SELECT id,payload_json,input_sha256,created_at FROM lifecycle_events WHERE article_id=? AND event_type='external_ai_change.recorded' ORDER BY id", [articleId]) },
    { label: "ruleCandidates" as const, statement: boundedStatement(db, "ruleCandidates", "SELECT id,state,evidence_refs_json FROM lifecycle_rule_candidates WHERE article_id=? AND state<>'rejected' ORDER BY id", [articleId]) },
  ] as const;
  const results = await db.batch<Row>(reads.map((read) => read.statement));
  const requirements = completeRows("requirements", results[0]);
  const annotations = completeRows("annotations", results[1]);
  const reviews = completeRows("retrospectives", results[2]);
  const taskRows = completeRows("tasks", results[3]);
  const progressRows = completeRows("progressEvents", results[4]);
  const events = completeRows("externalObservations", results[5]);
  const candidateRows = completeRows("ruleCandidates", results[6]);
  const tasks = taskRows.map((task) => {
    const boundRequirements = requirements.filter((requirement) => requirement.base_revision_id === task.revision_id && requirement.base_body_sha256 === task.body_sha256);
    return {
      id: String(task.id), state: String(task.state), createdAt: String(task.created_at), finishedAt: task.finished_at ? String(task.finished_at) : null,
      currentContextSnapshotId: task.current_context_snapshot_id ? String(task.current_context_snapshot_id) : null,
      contextSha256: task.context_sha256 ? String(task.context_sha256) : null,
      requirementIds: boundRequirements.map((requirement) => String(requirement.id)),
      annotationIds: annotations.filter((annotation) => boundRequirements.some((requirement) => requirement.id === annotation.requirement_id)).map((annotation) => String(annotation.id)),
      progressEvents: progressRows.filter((eventRow) => eventRow.task_id === task.id).map((eventRow) => ({ id: String(eventRow.id), eventType: String(eventRow.event_type), inputSha256: String(eventRow.input_sha256), createdAt: String(eventRow.created_at) })),
    };
  });
  const externalObservations = events.map((eventRow) => ({ ...JSON.parse(String(eventRow.payload_json)), id: String(eventRow.id), observedAt: String(eventRow.created_at), eventInputSha256: String(eventRow.input_sha256) }));
  const candidates = candidateRows.flatMap((candidateRow) => { const digest = JSON.parse(String(candidateRow.evidence_refs_json)).find((value: unknown) => typeof value === "string" && /^source-digest:[a-f0-9]{64}$/u.test(value)); return digest ? [{ id: String(candidateRow.id), sourceDigest: String(digest).slice(14) }] : []; });
  const proposal = await buildRsiProposalContext({ asOf, tasks, acceptedRequirements: requirements.map((requirement) => ({ id: String(requirement.id), articleId: String(requirement.article_id), priority: requirement.priority as "must", status: "accepted", createdAt: String(requirement.created_at), acceptedAt: requirement.accepted_at ? String(requirement.accepted_at) : null, inputSha256: String(requirement.input_sha256), lockVersion: Number(requirement.lock_version) })), activeAnnotations: annotations.map(annDto), reviewedOrClosedRetrospectives: reviews.map((review) => ({ id: String(review.id), articleId: String(review.article_id), projectId: String(review.project_id), releaseId: review.release_id ? String(review.release_id) : null, title: String(review.title), summary: String(review.summary), state: String(review.status), evidenceRefs: JSON.parse(String(review.evidence_refs_json)), lockVersion: Number(review.lock_version), updatedAt: String(review.updated_at) })), externalObservations, existingRuleCandidates: candidates, requestedSourceSetSha256: url.searchParams.get("sourceSetSha256") ?? undefined });
  if (new TextEncoder().encode(JSON.stringify(proposal)).byteLength > RSI_DERIVED_LIMITS.encodedProposalBytes) throw new ApiError("RSI_CONTEXT_LIMIT_EXCEEDED", 409, "encoded proposal exceeds the complete projection limit");
  return { schemaVersion: ANNOTATION_RSI_SCHEMA_VERSION, articleId, view: "proposal-context", ...proposal };
}
type SummaryLabel = keyof typeof RSI_SUMMARY_LIMITS;
function summaryRead(db: D1Database, label: SummaryLabel, sql: string) { return db.prepare(`${sql} LIMIT ?`).bind(RSI_SUMMARY_LIMITS[label] + 1); }
function summaryRows(label: SummaryLabel, result: D1Result<Row>) { if (result.results.length > RSI_SUMMARY_LIMITS[label]) throw new ApiError("RSI_CONTEXT_LIMIT_EXCEEDED", 409, `${label} exceeds complete summary limit`); return result.results; }
async function proposalSummary(db: D1Database, url: URL): Promise<ProposalSummaryDto> {
  const asOf = url.searchParams.get("asOf") ?? timestamp(), date = new Date(asOf); if (!Number.isFinite(date.getTime()) || date.toISOString() !== asOf) throw new ApiError("AS_OF_INVALID");
  const reads = [
    ["requirements", "SELECT id,article_id,priority,status,created_at,accepted_at,input_sha256,lock_version,base_revision_id,base_body_sha256 FROM article_requirements WHERE status='accepted' ORDER BY article_id,id"],
    ["annotations", "SELECT a.id,a.article_id,a.requirement_id,a.subject_type,a.subject_id,a.snapshot_sha256,a.label_schema_version,a.label_kind,a.verdict,a.severity,a.note,a.details_json,a.evidence_refs_json,a.annotation_sha256,a.input_sha256,a.command_id,a.supersedes_annotation_id,a.human_actor_id,a.created_at FROM human_annotations a JOIN article_requirements r ON r.id=a.requirement_id AND r.article_id=a.article_id WHERE r.status='accepted' AND NOT EXISTS(SELECT 1 FROM human_annotations c WHERE c.supersedes_annotation_id=a.id AND c.article_id=a.article_id) ORDER BY a.article_id,a.id"],
    ["retrospectives", "SELECT * FROM lifecycle_retrospectives WHERE status IN ('reviewed','closed') ORDER BY article_id,id"],
    ["tasks", "SELECT t.id,t.article_id,t.state,t.created_at,t.finished_at,t.base_revision_id,t.current_context_snapshot_id,c.revision_id,c.body_sha256,c.context_sha256 FROM agent_tasks t LEFT JOIN agent_context_snapshots c ON c.id=t.current_context_snapshot_id AND c.task_id=t.id AND c.article_id=t.article_id ORDER BY t.article_id,t.id"],
    ["progressEvents", "SELECT e.id,e.task_id,t.article_id,e.event_type,e.input_sha256,e.created_at FROM agent_progress_events e JOIN agent_tasks t ON t.id=e.task_id ORDER BY t.article_id,e.task_id,e.created_at,e.id"],
    ["externalObservations", "SELECT id,article_id,payload_json,input_sha256,created_at FROM lifecycle_events WHERE event_type='external_ai_change.recorded' ORDER BY article_id,id"],
    ["ruleCandidates", "SELECT id,article_id,state,evidence_refs_json FROM lifecycle_rule_candidates WHERE state<>'rejected' ORDER BY article_id,id"],
  ] as const;
  const result = await db.batch<Row>(reads.map(([label, sql]) => summaryRead(db, label, sql)));
  const [requirements, annotations, reviews, tasks, progress, externals, candidates] = reads.map(([label], index) => summaryRows(label, result[index]));
  const articleIds = [...new Set([...requirements, ...annotations, ...reviews, ...tasks, ...externals, ...candidates].map((row) => String(row.article_id)))].sort();
  const items: NonNullable<ProposalSummaryDto["highestPriority"]>[] = [];
  for (const articleId of articleIds) {
    const rs = requirements.filter((row) => row.article_id === articleId), as = annotations.filter((row) => row.article_id === articleId);
    const ts = tasks.filter((row) => row.article_id === articleId).map((task) => { const bound = rs.filter((r) => r.base_revision_id === task.revision_id && r.base_body_sha256 === task.body_sha256); return { id: String(task.id), state: String(task.state), createdAt: String(task.created_at), finishedAt: task.finished_at ? String(task.finished_at) : null, currentContextSnapshotId: task.current_context_snapshot_id ? String(task.current_context_snapshot_id) : null, contextSha256: task.context_sha256 ? String(task.context_sha256) : null, requirementIds: bound.map((r) => String(r.id)), annotationIds: as.filter((a) => bound.some((r) => r.id === a.requirement_id)).map((a) => String(a.id)), progressEvents: progress.filter((p) => p.article_id === articleId && p.task_id === task.id).map((p) => ({ id: String(p.id), eventType: String(p.event_type), inputSha256: String(p.input_sha256), createdAt: String(p.created_at) })) }; });
    const projection = await buildRsiProposalContext({ asOf, tasks: ts, acceptedRequirements: rs.map((r) => ({ id: String(r.id), articleId, priority: r.priority as "must", status: "accepted", createdAt: String(r.created_at), acceptedAt: r.accepted_at ? String(r.accepted_at) : null, inputSha256: String(r.input_sha256), lockVersion: Number(r.lock_version) })), activeAnnotations: as.map(annDto), reviewedOrClosedRetrospectives: reviews.filter((r) => r.article_id === articleId).map((r) => ({ id: String(r.id), articleId, projectId: String(r.project_id), releaseId: r.release_id ? String(r.release_id) : null, title: String(r.title), summary: String(r.summary), state: String(r.status), evidenceRefs: JSON.parse(String(r.evidence_refs_json)), lockVersion: Number(r.lock_version), updatedAt: String(r.updated_at) })), externalObservations: externals.filter((r) => r.article_id === articleId).map((r) => ({ ...JSON.parse(String(r.payload_json)), id: String(r.id), observedAt: String(r.created_at), eventInputSha256: String(r.input_sha256) })), existingRuleCandidates: candidates.filter((r) => r.article_id === articleId).flatMap((r) => { const d = JSON.parse(String(r.evidence_refs_json)).find((v: unknown) => typeof v === "string" && /^source-digest:[a-f0-9]{64}$/u.test(v)); return d ? [{ id: String(r.id), sourceDigest: String(d).slice(14) }] : []; }) });
    const priority = new Map(rs.map((r) => [String(r.id), r.priority])); for (const item of projection.items) { const ps = item.sourceRefs.map((ref) => priority.get(ref.replace(/^requirement:/u, ""))).filter((v): v is "must" | "should" | "could" => v === "must" || v === "should" || v === "could"); items.push({ articleId, proposalId: item.proposalId, triggerKind: item.triggerKind, dueAt: item.dueAt, priority: ps.includes("must") ? "must" : ps.includes("should") ? "should" : ps.includes("could") ? "could" : null, eligibleForRuleCandidate: item.eligibleForRuleCandidate, blockerCodes: item.blockers.map((b) => b.code) }); }
  }
  const rank = { must: 0, should: 1, could: 2, null: 3 } as const; items.sort((a, b) => rank[a.priority ?? "null"] - rank[b.priority ?? "null"] || Number(b.eligibleForRuleCandidate) - Number(a.eligibleForRuleCandidate) || (a.dueAt ?? "9999-12-31T23:59:59.999Z").localeCompare(b.dueAt ?? "9999-12-31T23:59:59.999Z") || a.articleId.localeCompare(b.articleId) || a.proposalId.localeCompare(b.proposalId));
  const pendingCount = items.length, eligibleCount = items.filter((item) => item.eligibleForRuleCandidate).length; return { schemaVersion: ANNOTATION_RSI_SCHEMA_VERSION, view: "proposal-summary", advisoryOnly: true, autoAdopt: false, pendingCount, eligibleCount, blockedCount: pendingCount - eligibleCount, highestPriority: items[0] ?? null };
}
async function initializeWorkspace(db: D1Database, articleId: string, commandId: string, actor: string, requestSha: string) {
  const data = { articleId, schemaReady: true, schemaVersion: ANNOTATION_RSI_SCHEMA_VERSION };
  await db.batch([receipt(db, commandId, "annotation-rsi.v1.initialize_workspace", actor, requestSha, data, 200, timestamp())]);
  return { status: 200, data };
}
async function recordExternalObservation(db: D1Database, payload: Obj, articleId: string, principal: ManagementPrincipal, commandId: string, requestSha: string) {
  human(principal);
  exact(payload, ["articleId", "canonicalSource", "sourceVersion", "publishedAt", "contentSha256", "officialFact", "inferredImpact", "evidenceRefs"], "RECORD_EXTERNAL_AI_OBSERVATION");
  const raw = requireString(payload.canonicalSource, "canonicalSource", 2048); let source: URL;
  try { source = new URL(raw); } catch { throw new ApiError("EXTERNAL_SOURCE_INVALID"); }
  const trusted = ["openai.com", "anthropic.com", "deepmind.google", "ai.google.dev", "microsoft.com", "cloudflare.com", "vercel.com", "nextjs.org", "chromium.org", "sqlite.org", "ollama.com", "qwenlm.ai", "deepseek.com"];
  if (source.protocol !== "https:" || source.username || source.password || source.search || source.hash || !trusted.some((domain) => source.hostname === domain || source.hostname.endsWith(`.${domain}`))) throw new ApiError("EXTERNAL_SOURCE_INVALID");
  source.hostname = source.hostname.toLowerCase(); const canonicalSource = source.toString();
  const sourceVersion = requireString(payload.sourceVersion, "sourceVersion", 512), publishedAt = requireString(payload.publishedAt, "publishedAt", 40);
  const publishedDate = new Date(publishedAt);
  if (!Number.isFinite(publishedDate.getTime()) || publishedDate.toISOString() !== publishedAt || publishedDate.getTime() > Date.now()) throw new ApiError("EXTERNAL_PUBLISHED_AT_INVALID");
  const contentSha256 = requireSha256(payload.contentSha256, "contentSha256"), officialFact = requireString(payload.officialFact, "officialFact", 4000);
  if (typeof payload.inferredImpact !== "string" || new TextEncoder().encode(payload.inferredImpact).byteLength > 4000) throw new ApiError("EXTERNAL_INFERRED_IMPACT_INVALID");
  const evidenceRefs = requireArray(payload.evidenceRefs, "evidenceRefs"); if (evidenceRefs.length < 1 || evidenceRefs.length > 20) throw new ApiError("EXTERNAL_EVIDENCE_INVALID");
  const evidence = evidenceRefs.map((value) => requireString(value, "evidenceRef", 512)); const natural = { articleId, canonicalSource, sourceVersion, publishedAt };
  const id = `external-ai:${(await sha256Text(canonicalJson(natural))).slice(0, 48)}`, at = timestamp();
  const eventPayload = { schemaVersion: ANNOTATION_RSI_SCHEMA_VERSION, articleId, canonicalSource, sourceVersion, publishedAt, contentSha256, officialFact, inferredImpact: payload.inferredImpact, evidenceRefs: evidence, humanReviewed: true };
  const inputSha256 = await sha256Text(canonicalJson(eventPayload));
  const data = { id, articleId, eventType: "external_ai_change.recorded", sourceVersion, contentSha256, present: true, contentMatched: true };
  await db.batch([
    db.prepare("INSERT INTO lifecycle_events (id,article_id,event_type,subject_type,subject_id,payload_json,input_sha256,created_at) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING").bind(id, articleId, "external_ai_change.recorded", "external_ai_observation", id, canonicalJson(eventPayload), inputSha256, at),
    db.prepare("SELECT CASE WHEN EXISTS(SELECT 1 FROM lifecycle_events WHERE id=? AND article_id=? AND event_type='external_ai_change.recorded' AND subject_type='external_ai_observation' AND subject_id=? AND input_sha256=?) THEN 1 ELSE json('external-observation-conflict') END").bind(id, articleId, id, inputSha256),
    receipt(db, commandId, "annotation-rsi.v1.record_external_ai_observation", managementActorId(principal), requestSha, data, 200, at),
  ]);
  return { status: 200, data };
}
export async function GET(request: Request) {
  const requestId = `annotation-rsi:${crypto.randomUUID()}`;
  try {
    const url = new URL(request.url), view = requireString(url.searchParams.get("view"), "view", 32);
    if (view === "proposal-summary") {
      const principal = await requireManagementSession(request, { scope: "management.read", articleId: "*" });
      if (!principal.articleIds.includes("*")) throw new ApiError("MANAGEMENT_OBJECT_DENIED", 403);
      return reply(requestId, 200, await proposalSummary(await ready(database()), url));
    }
    const articleId = requireId(url.searchParams.get("articleId"), "articleId");
    await requireManagementSession(request, { scope: "management.read", articleId });
    const db = await ready(database());
    if (view === "requirements" || view === "annotations") return reply(requestId, 200, await list(db, view, articleId, url));
    if (view === "proposal-context") return reply(requestId, 200, await context(db, articleId, url));
    if (rsiLifecycleViews.has(view)) return reply(requestId, 200, await readRsiLifecycle(db, view, articleId));
    if (view === "command") {
      const commandId = requireId(url.searchParams.get("commandId"), "commandId");
      const row = await db.prepare("SELECT c.id,c.command_type,c.actor_id,c.request_sha256,c.response_json,c.status_code,c.created_at,c.completed_at FROM command_receipts c WHERE c.id=? AND c.command_type LIKE 'annotation-rsi.v1.%' AND json_extract(c.response_json,'$.articleId')=?").bind(commandId, articleId).first<Row>();
      if (!row) throw new ApiError("COMMAND_NOT_FOUND", 404);
      return reply(requestId, 200, { schemaVersion: ANNOTATION_RSI_SCHEMA_VERSION, articleId, view, commandId: row.id, commandType: row.command_type, actorId: row.actor_id, requestSha256: row.request_sha256, statusCode: row.status_code, createdAt: row.created_at, completedAt: row.completed_at, data: JSON.parse(String(row.response_json)) });
    }
    throw new ApiError("VIEW_UNSUPPORTED");
  } catch (caught) { const typed = error(caught); return reply(requestId, typed.status, undefined, typed); }
}
export async function POST(request: Request) {
  const requestId = `annotation-rsi:${crypto.randomUUID()}`;
  let reconciliation: { db: D1Database; id: string; type: string; actor: string; requestSha: string; action: Action } | null = null;
  try {
    const command = await parse(request), principal = await requireManagementSession(request, { mutation: true, scope: "lifecycle.write", articleId: command.articleId });
    if (humanActions.has(command.action)) human(principal);
    const db = await ready(database()), actor = managementActorId(principal), type = `annotation-rsi.v1.${command.action}`;
    const requestSha = await sha256Text(canonicalJson({ action: command.action, actor, articleId: command.articleId, payload: command.payload }));
    reconciliation = { db, id: command.commandId, type, actor, requestSha, action: command.action };
    const replay = await previous(db, command.commandId, type, actor, requestSha);
    if (replay) return reply(requestId, replay.status, replay.data);
    if (command.action === "initialize_workspace") exact(command.payload, ["articleId"], "INITIALIZE_WORKSPACE");
    const result = command.action === "initialize_workspace"
      ? await initializeWorkspace(db, command.articleId, command.commandId, actor, requestSha)
      : command.action === "create_requirement" ? await createRequirement(db, command.payload, command.articleId, principal, command.commandId, requestSha)
        : command.action === "accept_requirement" ? await accept(db, command.payload, command.articleId, principal, command.commandId, requestSha)
          : command.action === "supersede_requirement" ? await supersede(db, command.payload, command.articleId, principal, command.commandId, requestSha)
            : command.action === "record_external_ai_observation" ? await recordExternalObservation(db, command.payload, command.articleId, principal, command.commandId, requestSha)
              : rsiLifecycleActions.has(command.action as RsiLifecycleAction) ? await handleRsiLifecycleAction(db, command.action as RsiLifecycleAction, command.payload, command.articleId, principal, command.commandId, requestSha)
                : await annotation(db, command.payload, command.articleId, principal, command.commandId, requestSha);
    return reply(requestId, result.status, result.data);
  } catch (caught) {
    if (reconciliation && !(caught instanceof ApiError) && !(caught instanceof ManagementAuthError) && !(caught instanceof AnnotationRsiValidationError) && !(caught instanceof RsiLifecycleError)) {
      try {
        const replay = await previous(reconciliation.db, reconciliation.id, reconciliation.type, reconciliation.actor, reconciliation.requestSha);
        if (replay) return reply(requestId, replay.status, replay.data);
      } catch (reconcileCaught) {
        const reconcileMessage = reconcileCaught instanceof Error ? reconcileCaught.message : "";
        if (reconcileCaught instanceof ApiError || reconcileCaught instanceof ManagementAuthError || reconcileCaught instanceof AnnotationRsiValidationError || reconcileCaught instanceof RsiLifecycleError) {
          const typed = error(reconcileCaught);
          return reply(requestId, typed.status, undefined, typed);
        }
        const typed = /db_unavailable|network|unavailable/i.test(reconcileMessage) ? new ApiError("DB_UNAVAILABLE", 503) : new ApiError("INTERNAL_ERROR", 500);
        return reply(requestId, typed.status, undefined, typed);
      }
      const message = caught instanceof Error ? caught.message : "";
      if (/db_unavailable|network|unavailable/i.test(message)) return reply(requestId, 503, undefined, new ApiError("DB_UNAVAILABLE", 503));
      const knownUniqueConflict = reconciliation.action === "create_human_annotation"
        ? /unique constraint failed: human_annotations\.(?:command_id|supersedes_annotation_id)/i.test(message)
        : reconciliation.action === "record_external_ai_observation"
          ? /unique constraint failed: lifecycle_events\.id/i.test(message)
          : /unique constraint failed: article_requirements\.(?:article_id|create_command_id|supersedes_requirement_id)/i.test(message);
      if (/malformed json|annotation-rsi-cas-conflict|external-observation-conflict/i.test(message) || knownUniqueConflict) {
        const code = reconciliation.action === "create_human_annotation"
          ? "ANNOTATION_CAS_CONFLICT"
          : reconciliation.action === "record_external_ai_observation"
            ? "EXTERNAL_OBSERVATION_CONFLICT"
            : reconciliation.action === "initialize_workspace"
              ? "INITIALIZATION_CONFLICT"
              : "REQUIREMENT_CAS_CONFLICT";
        return reply(requestId, 409, undefined, new ApiError(code, 409));
      }
      return reply(requestId, 500, undefined, new ApiError("INTERNAL_ERROR", 500));
    }
    const typed = error(caught);
    return reply(requestId, typed.status, undefined, typed);
  }
}
