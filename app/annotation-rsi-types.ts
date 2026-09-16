export const REQUIREMENT_STATUSES = ["draft", "accepted", "cancelled", "superseded"] as const;
export const REQUIREMENT_PRIORITIES = ["must", "should", "could"] as const;
export const ANNOTATION_SUBJECT_TYPES = ["article_revision", "publication_version", "build"] as const;
export const ANNOTATION_LABEL_KINDS = ["requirement_fit", "quality", "defect", "preference"] as const;
export const ANNOTATION_VERDICTS = ["pass", "fail", "inconclusive", "not_applicable"] as const;
export const ANNOTATION_SEVERITIES = ["info", "minor", "major", "critical"] as const;

export type RequirementStatus = typeof REQUIREMENT_STATUSES[number];
export type RequirementPriority = typeof REQUIREMENT_PRIORITIES[number];
export type AnnotationSubjectType = typeof ANNOTATION_SUBJECT_TYPES[number];
export type AnnotationLabelKind = typeof ANNOTATION_LABEL_KINDS[number];
export type AnnotationVerdict = typeof ANNOTATION_VERDICTS[number];
export type AnnotationSeverity = typeof ANNOTATION_SEVERITIES[number];

export interface RequirementDto {
  id: string;
  articleId: string;
  requirementKey: string;
  revision: number;
  supersedesRequirementId: string | null;
  packageId: string;
  branchId: string;
  baseRevisionId: string;
  baseBodySha256: string;
  title: string;
  /** Deliberately available in the requirements view; proposal-context omits it. */
  requirementText: string;
  acceptance: Record<string, unknown>;
  priority: RequirementPriority;
  inputSha256: string;
  status: RequirementStatus;
  lockVersion: number;
  createdByKind: "human" | "agent";
  creatorId: string;
  acceptedBy: string | null;
  createdAt: string;
  updatedAt: string;
  acceptedAt: string | null;
  cancelledAt: string | null;
  supersededAt: string | null;
}

export interface AnnotationDto {
  id: string;
  articleId: string;
  requirementId: string;
  subjectType: AnnotationSubjectType;
  subjectId: string;
  snapshotSha256: string;
  labelSchemaVersion: number;
  labelKind: AnnotationLabelKind;
  verdict: AnnotationVerdict;
  severity: AnnotationSeverity;
  note: string;
  details: Record<string, unknown>;
  evidenceRefs: string[];
  supersedesAnnotationId: string | null;
  humanActorId: string;
  createdAt: string;
  annotationSha256: string;
  inputSha256: string;
  commandId: string;
}

export interface TupleCursorPayload {
  v: 1;
  view: "requirements" | "annotations" | "proposal-context";
  articleId: string;
  filterSha256: string;
  createdAt: string;
  id: string;
}

export interface ProposalContextBlocker {
  code: "NO_ACCEPTED_REQUIREMENT" | "NO_ACTIVE_HUMAN_ANNOTATION" | "NO_REVIEWED_RETROSPECTIVE" | "NO_BOUND_REVIEWED_RETROSPECTIVE" | "ANNOTATION_EVIDENCE_INCOMPLETE" | "CONTEXT_SNAPSHOT_MISSING" | "SOURCE_DIGEST_STALE" | "ALREADY_HAS_RULE_CANDIDATE";
  detail: string;
}

export type ProposalTriggerKind = "new_task" | "task_terminal" | "review_due" | "external_ai_change";
export interface SourceBinding { kind: string; id: string; sha256: string; }

export interface ProposalContextItem {
  proposalId: string;
  triggerKind: ProposalTriggerKind;
  triggerKey: string;
  sourceRefs: string[];
  sourceDigest: string;
  observedAt: string;
  dueAt: string | null;
  recommendation: string;
  eligibleForRuleCandidate: boolean;
  blockers: ProposalContextBlocker[];
  humanNextAction: string;
  claims: string[];
  notClaims: string[];
  /** Present only for a human-reviewed external observation. */
  officialFact?: string;
  /** A local advisory inference, never an external fact. */
  inferredImpact?: string;
}

export interface RsiTaskInput {
  id: string;
  state: string;
  createdAt: string;
  finishedAt: string | null;
  currentContextSnapshotId: string | null;
  contextSha256: string | null;
  requirementIds: string[];
  annotationIds: string[];
  progressEvents: Array<{ id: string; eventType: string; inputSha256: string; createdAt: string }>;
}

export interface RsiRetrospectiveInput {
  id: string;
  articleId: string;
  projectId: string;
  releaseId: string | null;
  title: string;
  summary: string;
  state: "reviewed" | "closed" | string;
  evidenceRefs: string[];
  lockVersion: number;
  updatedAt: string;
  contentSha256?: string;
}

export interface RsiExternalObservationInput {
  id: string;
  observedAt: string;
  officialFact: string;
  inferredImpact?: string;
  humanReviewed: boolean;
  evidenceRefs: string[];
  canonicalSource: string;
  sourceVersion: string;
  publishedAt: string;
  contentSha256: string;
  eventInputSha256: string;
}

export interface RsiRuleCandidateInput { id: string; sourceDigest: string; }

export interface RsiProjectionInput {
  asOf: string;
  tasks: RsiTaskInput[];
  acceptedRequirements: Array<Pick<RequirementDto, "id" | "articleId" | "priority" | "status" | "createdAt" | "acceptedAt" | "inputSha256" | "lockVersion">>;
  activeAnnotations: AnnotationDto[];
  reviewedOrClosedRetrospectives: RsiRetrospectiveInput[];
  externalObservations: RsiExternalObservationInput[];
  existingRuleCandidates: RsiRuleCandidateInput[];
  requestedSourceSetSha256?: string;
}

export interface ProposalContextDto {
  advisoryOnly: true;
  bodyTextIncluded: false;
  autoCreateExperiment: false;
  autoAdopt: false;
  sourceRequirementIds: string[];
  sourceAnnotationIds: string[];
  sourceSetSha256: string;
  requirementSummary: Array<Record<string, unknown>>;
  annotationSummary: Array<Record<string, unknown>>;
  reviewedRetrospectiveIds: string[];
  eligibleForRuleCandidate: boolean;
  blockers: ProposalContextBlocker[];
  items: ProposalContextItem[];
  page: { nextCursor: null };
}

export interface AnnotationPageEnvelope<T> {
  items: T[];
  bodyTextIncluded: false;
  page: { limit: number; nextCursor: string | null };
}

/** Deliberately minimal global inbox projection. It never carries review content. */
export interface ProposalSummaryDto {
  schemaVersion: string;
  view: "proposal-summary";
  advisoryOnly: true;
  autoAdopt: false;
  pendingCount: number;
  eligibleCount: number;
  blockedCount: number;
  highestPriority: null | {
    articleId: string;
    proposalId: string;
    triggerKind: ProposalTriggerKind;
    dueAt: string | null;
    priority: RequirementPriority | null;
    eligibleForRuleCandidate: boolean;
    blockerCodes: ProposalContextBlocker["code"][];
  };
}
