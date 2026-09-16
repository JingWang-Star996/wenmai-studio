import { managementActorId, type ManagementPrincipal } from "./management-auth";
import { canonicalJson, requireArray, requireId, requireInteger, requireObject, requireSha256, requireString, sha256Text, sourceBindingsSha256 } from "./annotation-rsi";

type Obj = Record<string, unknown>;
type Row = Record<string, string | number | null>;
type Result = { status: number; data: Obj };

export type RsiLifecycleAction = "create_rule_candidate" | "approve_rule_candidate" | "run_due_check";
export const rsiLifecycleActions = new Set<RsiLifecycleAction>(["create_rule_candidate", "approve_rule_candidate", "run_due_check"]);
export const rsiHumanActions = new Set<RsiLifecycleAction>(["approve_rule_candidate"]);
export const rsiLifecycleViews = new Set(["rule-candidates", "baseline-revisions", "due-checks"]);

export class RsiLifecycleError extends Error {
  constructor(readonly code: string, readonly status = 400, message = code) { super(message); }
}

const now = () => new Date().toISOString();
const exact = (value: Obj, keys: string[], code: string) => {
  if (Object.keys(value).sort().join(",") !== [...keys].sort().join(",")) throw new RsiLifecycleError(code);
};
const actorId = (principal: ManagementPrincipal) => managementActorId(principal);
const human = (principal: ManagementPrincipal) => {
  if (principal.authBasis !== "owner_pairing" && principal.authBasis !== "trusted_device") throw new RsiLifecycleError("HUMAN_ACTION_AUTH_BASIS_DENIED", 403);
};
const receipt = (db: D1Database, commandId: string, action: string, actor: string, requestSha: string, data: Obj, status: number, at: string) =>
  db.prepare("INSERT INTO command_receipts (id,command_type,actor_id,request_sha256,response_json,status_code,created_at,completed_at) VALUES (?,?,?,?,?,?,?,?)")
    .bind(commandId, `annotation-rsi.v1.${action}`, actor, requestSha, canonicalJson(data), status, at, at);
const event = (db: D1Database, articleId: string, eventType: string, subjectType: string, subjectId: string, requestSha: string, at: string) =>
  db.prepare("INSERT INTO lifecycle_events (id,article_id,event_type,subject_type,subject_id,payload_json,input_sha256,created_at) VALUES (?,?,?,?,?,?,?,?)")
    .bind(`${eventType}:${crypto.randomUUID()}`, articleId, eventType, subjectType, subjectId, "{}", requestSha, at);

async function sourceBindings(db: D1Database, articleId: string, input: unknown) {
  const values = requireArray(input, "sourceBindings");
  if (values.length < 1 || values.length > 64) throw new RsiLifecycleError("RULE_SOURCE_LIMIT_EXCEEDED", 409);
  const bindings = values.map((value) => {
    const item = requireObject(value, "sourceBinding");
    exact(item, ["kind", "id", "sha256"], "RULE_SOURCE_KEYS_INVALID");
    const kind = requireString(item.kind, "sourceBinding.kind", 40);
    if (kind !== "accepted_requirement" && kind !== "human_annotation") throw new RsiLifecycleError("RULE_SOURCE_KIND_INVALID");
    return { kind, id: requireId(item.id, "sourceBinding.id"), sha256: requireSha256(item.sha256, "sourceBinding.sha256") };
  });
  const unique = new Set(bindings.map((item) => `${item.kind}:${item.id}`));
  if (unique.size !== bindings.length) throw new RsiLifecycleError("RULE_SOURCE_DUPLICATE");
  const checks = await db.batch(bindings.map((item) => item.kind === "accepted_requirement"
    ? db.prepare("SELECT input_sha256 sha FROM article_requirements WHERE id=? AND article_id=? AND status='accepted'").bind(item.id, articleId)
    : db.prepare("SELECT a.annotation_sha256 sha FROM human_annotations a WHERE a.id=? AND a.article_id=? AND NOT EXISTS(SELECT 1 FROM human_annotations n WHERE n.supersedes_annotation_id=a.id)").bind(item.id, articleId)));
  checks.forEach((result, index) => {
    if (String((result.results?.[0] as Row | undefined)?.sha ?? "") !== bindings[index].sha256) throw new RsiLifecycleError("RULE_SOURCE_STALE", 409);
  });
  return bindings.sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));
}

async function createCandidate(db: D1Database, payload: Obj, articleId: string, principal: ManagementPrincipal, commandId: string, requestSha: string): Promise<Result> {
  exact(payload, ["articleId", "projectId", "sourceBindings", "rule", "variantIds"], "RULE_CANDIDATE_KEYS_INVALID");
  const projectId = payload.projectId === null ? null : requireId(payload.projectId, "projectId");
  const variants = requireArray(payload.variantIds, "variantIds").map((value) => requireId(value, "variantId"));
  if (variants.length > 16 || new Set(variants).size !== variants.length) throw new RsiLifecycleError("RULE_VARIANT_LIMIT_EXCEEDED", 409);
  const rule = requireObject(payload.rule, "rule"), ruleJson = canonicalJson(rule);
  if (new TextEncoder().encode(ruleJson).byteLength > 32 * 1024) throw new RsiLifecycleError("RULE_JSON_TOO_LARGE", 413);
  const bindings = await sourceBindings(db, articleId, payload.sourceBindings);
  const sourceSetSha256 = await sourceBindingsSha256(bindings);
  const canonicalRuleSha256 = await sha256Text(ruleJson);
  const candidateSha256 = await sha256Text(canonicalJson({ articleId, projectId, variants: [...variants].sort(), sourceSetSha256, rule }));
  const id = `rsi-candidate:${(await sha256Text(`${commandId}:${requestSha}`)).slice(0, 48)}`, at = now(), actor = actorId(principal);
  const data = { id, articleId, projectId, sourceSetSha256, canonicalRuleSha256, candidateSha256, status: "candidate", lockVersion: 1, createdAt: at };
  await db.batch([
    db.prepare("INSERT INTO annotation_rsi_rule_candidates (id,article_id,project_id,variant_scope_json,source_bindings_json,source_set_sha256,canonical_rule_json,canonical_rule_sha256,candidate_sha256,status,created_by,created_at,lock_version) VALUES (?,?,?,?,?,?,?,?,?,'candidate',?,?,1)")
      .bind(id, articleId, projectId, canonicalJson([...variants].sort()), canonicalJson(bindings), sourceSetSha256, ruleJson, canonicalRuleSha256, candidateSha256, actor, at),
    event(db, articleId, "annotation_rsi.candidate_created", "rsi_rule_candidate", id, requestSha, at),
    receipt(db, commandId, "create_rule_candidate", actor, requestSha, data, 201, at),
  ]);
  return { status: 201, data };
}

async function approveCandidate(db: D1Database, payload: Obj, articleId: string, principal: ManagementPrincipal, commandId: string, requestSha: string): Promise<Result> {
  human(principal);
  exact(payload, ["articleId", "candidateId", "expectedCanonicalRuleSha256", "expectedCandidateSha256", "expectedLockVersion", "expectedSourceSetSha256", "expectedHeadRevisionId", "expectedHeadRevisionSha256", "note"], "RULE_APPROVAL_KEYS_INVALID");
  const candidateId = requireId(payload.candidateId, "candidateId"), expectedLock = requireInteger(payload.expectedLockVersion, "expectedLockVersion");
  const sourceSha = requireSha256(payload.expectedSourceSetSha256, "expectedSourceSetSha256"), ruleSha = requireSha256(payload.expectedCanonicalRuleSha256, "expectedCanonicalRuleSha256"), candidateSha = requireSha256(payload.expectedCandidateSha256, "expectedCandidateSha256");
  const note = requireString(payload.note, "note", 2000);
  const candidate = await db.prepare("SELECT * FROM annotation_rsi_rule_candidates WHERE id=? AND article_id=?").bind(candidateId, articleId).first<Row>();
  if (!candidate || candidate.status !== "candidate" || Number(candidate.lock_version) !== expectedLock || candidate.source_set_sha256 !== sourceSha || candidate.canonical_rule_sha256 !== ruleSha || candidate.candidate_sha256 !== candidateSha) throw new RsiLifecycleError("RULE_CANDIDATE_CAS_CONFLICT", 409);
  const head = await db.prepare("SELECT * FROM annotation_rsi_baseline_revisions WHERE article_id=? ORDER BY revision DESC LIMIT 1").bind(articleId).first<Row>();
  const expectedHeadId = payload.expectedHeadRevisionId === null ? null : requireId(payload.expectedHeadRevisionId, "expectedHeadRevisionId");
  const expectedHeadSha = payload.expectedHeadRevisionSha256 === null ? null : requireSha256(payload.expectedHeadRevisionSha256, "expectedHeadRevisionSha256");
  if ((head?.id ?? null) !== expectedHeadId || (head?.revision_sha256 ?? null) !== expectedHeadSha) throw new RsiLifecycleError("BASELINE_HEAD_CAS_CONFLICT", 409);
  const revision = Number(head?.revision ?? 0) + 1, at = now(), actor = actorId(principal);
  const revisionJson = canonicalJson({ candidateId, candidateSha256: candidateSha, sourceSetSha256: sourceSha, canonicalRuleSha256: ruleSha, rule: JSON.parse(String(candidate.canonical_rule_json)) });
  const revisionSha256 = await sha256Text(revisionJson), id = `rsi-baseline:${(await sha256Text(`${articleId}:${revision}:${revisionSha256}`)).slice(0, 48)}`;
  const data = { id, articleId, candidateId, revisionNumber: revision, revisionSha256, approvedAt: at };
  await db.batch([
    db.prepare("UPDATE annotation_rsi_rule_candidates SET status='approved',decided_by=?,decided_at=?,decision_note=?,lock_version=lock_version+1 WHERE id=? AND article_id=? AND status='candidate' AND lock_version=? AND candidate_sha256=?")
      .bind(actor, at, note, candidateId, articleId, expectedLock, candidateSha),
    db.prepare("INSERT INTO annotation_rsi_baseline_revisions (id,candidate_id,candidate_sha256,article_id,revision,parent_revision_id,parent_revision_sha256,revision_json,revision_sha256,approval_command_id,approval_actor_id,approval_principal_id,approval_auth_basis,approval_note,approved_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .bind(id, candidateId, candidateSha, articleId, revision, head?.id ?? null, head?.revision_sha256 ?? null, revisionJson, revisionSha256, commandId, actor, principal.principalId, principal.authBasis, note, at),
    event(db, articleId, "annotation_rsi.baseline_approved", "rsi_baseline", id, requestSha, at),
    receipt(db, commandId, "approve_rule_candidate", actor, requestSha, data, 201, at),
  ]);
  return { status: 201, data };
}

async function dueCheck(db: D1Database, payload: Obj, articleId: string, principal: ManagementPrincipal, commandId: string, requestSha: string): Promise<Result> {
  exact(payload, ["articleId", "projectId", "triggerKind"], "DUE_CHECK_KEYS_INVALID");
  const projectId = requireId(payload.projectId, "projectId"), triggerKind = requireString(payload.triggerKind, "triggerKind", 40);
  if (!["new_task", "task_terminal", "review_due", "external_ai_change"].includes(triggerKind)) throw new RsiLifecycleError("DUE_TRIGGER_INVALID");
  const [requirements, annotations, baseline] = await db.batch([
    db.prepare("SELECT id,input_sha256 sha FROM article_requirements WHERE article_id=? AND status='accepted' ORDER BY updated_at DESC LIMIT 32").bind(articleId),
    db.prepare("SELECT a.id,a.annotation_sha256 sha FROM human_annotations a WHERE a.article_id=? AND NOT EXISTS(SELECT 1 FROM human_annotations n WHERE n.supersedes_annotation_id=a.id) ORDER BY a.created_at DESC LIMIT 32").bind(articleId),
    db.prepare("SELECT id,revision_sha256 sha FROM annotation_rsi_baseline_revisions WHERE article_id=? ORDER BY revision DESC LIMIT 1").bind(articleId),
  ]);
  const sources = [...requirements.results.map((row) => ({ kind: "accepted_requirement", id: String((row as Row).id), sha256: String((row as Row).sha) })), ...annotations.results.map((row) => ({ kind: "human_annotation", id: String((row as Row).id), sha256: String((row as Row).sha) }))];
  const sourceSetSha256 = sources.length ? await sourceBindingsSha256(sources) : await sha256Text("[]");
  const at = now(), nextDueAt = new Date(Date.parse(at) + 7 * 86400000).toISOString(), id = `rsi-due:${crypto.randomUUID()}`, actor = actorId(principal);
  const summary = { acceptedRequirementCount: requirements.results.length, activeAnnotationCount: annotations.results.length, baselineId: (baseline.results[0] as Row | undefined)?.id ?? null };
  const data = { id, articleId, projectId, triggerKind, lastCheckedAt: at, nextDueAt, sourceSetSha256, sourceSummary: summary };
  await db.batch([
    db.prepare("INSERT INTO annotation_rsi_due_checks (id,article_id,project_id,trigger_kind,last_checked_at,next_due_at,source_set_sha256,source_summary_json) VALUES (?,?,?,?,?,?,?,?)")
      .bind(id, articleId, projectId, triggerKind, at, nextDueAt, sourceSetSha256, canonicalJson(summary)),
    receipt(db, commandId, "run_due_check", actor, requestSha, data, 200, at),
  ]);
  return { status: 200, data };
}

export async function handleRsiLifecycleAction(db: D1Database, action: RsiLifecycleAction, payload: Obj, articleId: string, principal: ManagementPrincipal, commandId: string, requestSha: string) {
  if (action === "create_rule_candidate") return createCandidate(db, payload, articleId, principal, commandId, requestSha);
  if (action === "approve_rule_candidate") return approveCandidate(db, payload, articleId, principal, commandId, requestSha);
  return dueCheck(db, payload, articleId, principal, commandId, requestSha);
}

export async function readRsiLifecycle(db: D1Database, view: string, articleId: string): Promise<Obj> {
  if (view === "rule-candidates") {
    const rows = await db.prepare("SELECT * FROM annotation_rsi_rule_candidates WHERE article_id=? ORDER BY created_at DESC,id LIMIT 32").bind(articleId).all<Row>();
    return { articleId, view, items: rows.results.map((row) => ({ id: row.id, projectId: row.project_id, sourceSetSha256: row.source_set_sha256, canonicalRuleSha256: row.canonical_rule_sha256, candidateSha256: row.candidate_sha256, status: row.status, lockVersion: row.lock_version, createdAt: row.created_at })) };
  }
  if (view === "baseline-revisions") {
    const rows = await db.prepare("SELECT * FROM annotation_rsi_baseline_revisions WHERE article_id=? ORDER BY revision DESC LIMIT 16").bind(articleId).all<Row>();
    return { articleId, view, immutable: true, items: rows.results.map((row) => ({ id: row.id, candidateId: row.candidate_id, revisionNumber: row.revision, revisionSha256: row.revision_sha256, approvedAt: row.approved_at })) };
  }
  const rows = await db.prepare("SELECT * FROM annotation_rsi_due_checks WHERE article_id=? ORDER BY last_checked_at DESC,id LIMIT 32").bind(articleId).all<Row>();
  return { articleId, view, items: rows.results.map((row) => ({ id: row.id, projectId: row.project_id, triggerKind: row.trigger_kind, lastCheckedAt: row.last_checked_at, nextDueAt: row.next_due_at, sourceSetSha256: row.source_set_sha256, sourceSummary: JSON.parse(String(row.source_summary_json)) })) };
}
