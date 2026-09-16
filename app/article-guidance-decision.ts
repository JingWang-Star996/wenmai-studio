export const ARTICLE_GUIDANCE_DECISION_SCHEMA_VERSION = "wenmai-article-guidance-decision/1.0.0" as const;

export const ARTICLE_GUIDANCE_PROFILES = ["light_archive", "full_production"] as const;

export type ArticleGuidanceProfile = (typeof ARTICLE_GUIDANCE_PROFILES)[number];

export interface ArticleGuidanceDecisionBindings {
  articleId: string;
  projectId: string | null;
  packageId: string;
  branchId: string;
  revisionId: string;
  bodySha256: string;
  compositionId: string;
  compositionSha256: string;
  documentSha256: string;
  packageLockVersion: number;
  branchLockVersion: number;
  workingCopyLockVersion: number;
  baselineChecklistSha256: string;
}

export interface VerifiedArticleGuidanceDecision {
  schemaVersion: typeof ARTICLE_GUIDANCE_DECISION_SCHEMA_VERSION;
  receiptId: string;
  actorId: string;
  requestSha256: string;
  selectedProfile: ArticleGuidanceProfile;
  decisionNote: string;
  decidedAt: string;
  bindings: ArticleGuidanceDecisionBindings;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function exactString(value: unknown) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function exactSha256(value: unknown) {
  const text = exactString(value);
  return text && /^[a-f0-9]{64}$/u.test(text) ? text : null;
}

function exactPositiveInteger(value: unknown) {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 ? value : null;
}

/**
 * Parse a completed command receipt payload and prove that every immutable/CAS
 * binding still equals the caller's current Package snapshot. Package metadata
 * is deliberately not an input to this verifier.
 */
export function verifyArticleGuidanceDecisionReceipt(input: {
  receiptId: unknown;
  actorId: unknown;
  requestSha256: unknown;
  completedAt: unknown;
  responseJson: unknown;
  currentBindings: ArticleGuidanceDecisionBindings;
}): VerifiedArticleGuidanceDecision | null {
  const receiptId = exactString(input.receiptId);
  const actorId = exactString(input.actorId);
  const requestSha256 = exactSha256(input.requestSha256);
  const completedAt = exactString(input.completedAt);
  const response = isObject(input.responseJson) ? input.responseJson : null;
  const data = response && isObject(response.data) ? response.data : null;
  const decision = data && isObject(data.guidanceDecision) ? data.guidanceDecision : null;
  const bindings = decision && isObject(decision.bindings) ? decision.bindings : null;
  if (!receiptId || !actorId || !requestSha256 || !completedAt || !decision || !bindings) return null;
  if (decision.schemaVersion !== ARTICLE_GUIDANCE_DECISION_SCHEMA_VERSION
    || decision.receiptId !== receiptId
    || decision.actorId !== actorId
    || decision.requestSha256 !== requestSha256
    // The database command_receipts.completed_at column is the sole trusted
    // decision time. A response payload must not self-assert another time.
    || Object.hasOwn(decision, "decidedAt")
    || !ARTICLE_GUIDANCE_PROFILES.includes(decision.selectedProfile as ArticleGuidanceProfile)
    || typeof decision.decisionNote !== "string"
    || !decision.decisionNote.trim()) return null;

  const parsedBindings: ArticleGuidanceDecisionBindings = {
    articleId: exactString(bindings.articleId) ?? "",
    projectId: bindings.projectId === null ? null : exactString(bindings.projectId),
    packageId: exactString(bindings.packageId) ?? "",
    branchId: exactString(bindings.branchId) ?? "",
    revisionId: exactString(bindings.revisionId) ?? "",
    bodySha256: exactSha256(bindings.bodySha256) ?? "",
    compositionId: exactString(bindings.compositionId) ?? "",
    compositionSha256: exactSha256(bindings.compositionSha256) ?? "",
    documentSha256: exactSha256(bindings.documentSha256) ?? "",
    packageLockVersion: exactPositiveInteger(bindings.packageLockVersion) ?? 0,
    branchLockVersion: exactPositiveInteger(bindings.branchLockVersion) ?? 0,
    workingCopyLockVersion: exactPositiveInteger(bindings.workingCopyLockVersion) ?? 0,
    baselineChecklistSha256: exactSha256(bindings.baselineChecklistSha256) ?? "",
  };
  for (const key of Object.keys(input.currentBindings) as Array<keyof ArticleGuidanceDecisionBindings>) {
    if (parsedBindings[key] !== input.currentBindings[key]) return null;
  }
  return {
    schemaVersion: ARTICLE_GUIDANCE_DECISION_SCHEMA_VERSION,
    receiptId,
    actorId,
    requestSha256,
    selectedProfile: decision.selectedProfile as ArticleGuidanceProfile,
    decisionNote: decision.decisionNote.trim(),
    decidedAt: completedAt,
    bindings: parsedBindings,
  };
}

/** Read only successful, completed receipts; malformed or stale rows are ignored. */
export async function loadLatestVerifiedArticleGuidanceDecision(
  db: D1Database,
  currentBindings: ArticleGuidanceDecisionBindings,
): Promise<VerifiedArticleGuidanceDecision | null> {
  const rows = await db.prepare(`SELECT id, actor_id, request_sha256, response_json, completed_at
    FROM command_receipts
    WHERE command_type = 'project_package.v1.decide_guidance_profile'
      AND status_code BETWEEN 200 AND 299 AND completed_at IS NOT NULL
      AND json_extract(response_json, '$.data.guidanceDecision.bindings.packageId') = ?
      AND json_extract(response_json, '$.data.guidanceDecision.bindings.branchId') = ?
    ORDER BY completed_at DESC, rowid DESC LIMIT 50`)
    .bind(currentBindings.packageId, currentBindings.branchId)
    .all<Record<string, string | number | null>>();
  for (const row of rows.results) {
    let responseJson: unknown = null;
    try {
      responseJson = typeof row.response_json === "string" ? JSON.parse(row.response_json) : null;
    } catch {
      responseJson = null;
    }
    const verified = verifyArticleGuidanceDecisionReceipt({
      receiptId: row.id,
      actorId: row.actor_id,
      requestSha256: row.request_sha256,
      completedAt: row.completed_at,
      responseJson,
      currentBindings,
    });
    if (verified) return verified;
  }
  return null;
}
