export const PROJECT_PHASES = [
  "pitch",
  "planning",
  "production",
  "packaging",
  "release",
  "operate",
  "retrospective",
] as const;

export const PROJECT_EXECUTION_STATES = [
  "proposed",
  "active",
  "blocked",
  "paused",
  "completed",
  "cancelled",
] as const;

export const SLICE_KINDS = ["full", "demo", "excerpt", "promo"] as const;
export const CONTRACT_STATES = ["draft", "approved", "superseded", "cancelled"] as const;
export const BUILD_STATES = ["planned", "built", "failed", "superseded"] as const;
export const BUILD_GATE_KINDS = ["compatibility", "fidelity"] as const;
export const GATE_RESULTS = ["pass", "fail", "inconclusive"] as const;
export const RELEASE_APPROVAL_STATES = ["draft", "approved", "rejected"] as const;
export const RELEASE_READINESS_STATES = ["draft", "artifact_validated", "ready_to_submit", "stale", "blocked"] as const;
export const RELEASE_SUBMISSION_STATES = [
  "not_submitted",
  "submitting",
  "submission_accepted",
  "submission_failed",
] as const;
export const RELEASE_DESTINATION_STATES = [
  "not_checked",
  "backend_verified",
  "not_found",
  "inconclusive",
] as const;
export const RELEASE_PUBLIC_STATES = [
  "not_checked",
  "public_verified",
  "not_public",
  "inconclusive",
] as const;
export const RELEASE_LIFECYCLE_STATES = ["active", "withdrawn", "superseded"] as const;
export const METRIC_VALIDATION_STATES = ["collected", "validated", "inconclusive"] as const;
export const METRIC_VALUE_KINDS = ["integer", "decimal"] as const;
export const METRIC_MISSING_POLICIES = ["unknown", "reject", "not_applicable"] as const;
export const METRIC_OBSERVATION_STATES = ["observed", "missing", "not_applicable"] as const;
export const RETROSPECTIVE_STATES = ["draft", "reviewed", "closed"] as const;
export const RULE_CANDIDATE_STATES = [
  "candidate",
  "testing",
  "verified",
  "adopted",
  "deferred",
  "rejected",
] as const;

export type ProjectPhase = (typeof PROJECT_PHASES)[number];
export type ProjectExecutionState = (typeof PROJECT_EXECUTION_STATES)[number];
export type SliceKind = (typeof SLICE_KINDS)[number];
export type ContractState = (typeof CONTRACT_STATES)[number];
export type BuildState = (typeof BUILD_STATES)[number];
export type BuildGateKind = (typeof BUILD_GATE_KINDS)[number];
export type GateResult = (typeof GATE_RESULTS)[number];
export type ReleaseApprovalState = (typeof RELEASE_APPROVAL_STATES)[number];
export type ReleaseReadinessState = (typeof RELEASE_READINESS_STATES)[number];
export type ReleaseSubmissionState = (typeof RELEASE_SUBMISSION_STATES)[number];
export type ReleaseDestinationState = (typeof RELEASE_DESTINATION_STATES)[number];
export type ReleasePublicState = (typeof RELEASE_PUBLIC_STATES)[number];
export type ReleaseLifecycleState = (typeof RELEASE_LIFECYCLE_STATES)[number];
export type MetricValidationState = (typeof METRIC_VALIDATION_STATES)[number];
export type MetricValueKind = (typeof METRIC_VALUE_KINDS)[number];
export type MetricMissingPolicy = (typeof METRIC_MISSING_POLICIES)[number];
export type MetricObservationState = (typeof METRIC_OBSERVATION_STATES)[number];
export type RetrospectiveState = (typeof RETROSPECTIVE_STATES)[number];
export type RuleCandidateState = (typeof RULE_CANDIDATE_STATES)[number];

export interface ArticleProjectRecord {
  id: string;
  articleId: string;
  title: string;
  intent: string;
  owner: string;
  phase: ProjectPhase;
  executionState: ProjectExecutionState;
  lockVersion: number;
  createdAt: string;
  updatedAt: string;
}

export interface PlatformTargetRecord {
  id: string;
  profileKey: string;
  platform: string;
  label: string;
  version: string;
  connectionMode: "manual";
  status: "active" | "superseded";
  profile: Record<string, unknown>;
  profileSha256: string;
  createdAt: string;
}

export interface AdaptationContractRecord {
  id: string;
  projectId: string;
  articleId: string;
  targetProfileId: string;
  targetProfileSha256: string;
  sourceRevisionId: string;
  sourceBodySha256: string;
  sliceKind: SliceKind;
  title: string;
  invariants: Record<string, unknown>;
  rules: Record<string, unknown>;
  contractSha256: string;
  status: ContractState;
  approvalNote: string;
  lockVersion: number;
  createdAt: string;
  updatedAt: string;
}

export type BuildInputCurrentness = "current" | "stale" | "legacy_unbound";

export interface ContentBuildInputBindingRecord {
  buildId: string;
  inputBindingSha256: string;
  packageId: string;
  branchId: string;
  branchLockVersion: number;
  revisionId: string;
  sourceBodySha256: string;
  compositionId: string;
  compositionSha256: string;
  sliceId: string;
  sliceSha256: string;
  publicationVersionId: string;
  publicationRegistrationSha256: string;
  coverRunId: string;
  coverRecipeId: string;
  coverRecipeVersion: string;
  coverRecipeSha256: string;
  coverReceiptId: string;
  coverReceiptSchemaVersion: string;
  coverReceipt: Record<string, unknown>;
  coverReceiptSha256: string;
  coverReceiptChainSha256: string;
  coverArtifactSha256: string;
  coverBaselineId: string;
  coverBaselineSha256: string;
  coverProfileSha256: string;
  currentness: BuildInputCurrentness;
  blockers: string[];
  createdAt: string;
}

export interface ContentBuildRecord {
  id: string;
  projectId: string;
  articleId: string;
  branchId: string;
  revisionId: string;
  sourceTitle: string;
  sourceBodySha256: string;
  targetProfileId: string;
  targetProfileSha256: string;
  adaptationContractId: string;
  contractSha256: string;
  sliceKind: SliceKind;
  state: BuildState;
  artifactRef: string;
  artifactSha256: string;
  artifactMediaType: string;
  artifactManifest: Record<string, unknown>;
  failureSummary: string;
  createdAt: string;
  builtAt: string | null;
  updatedAt: string;
  inputBinding?: ContentBuildInputBindingRecord | null;
  inputCurrentness?: BuildInputCurrentness;
  inputBlockers?: string[];
}

export interface BuildGateRunRecord {
  id: string;
  buildId: string;
  projectId: string;
  articleId: string;
  gateKind: BuildGateKind;
  result: GateResult;
  artifactSha256: string;
  targetProfileSha256: string;
  contractSha256: string;
  evidence: string[];
  details: Record<string, unknown>;
  inputSha256: string;
  createdAt: string;
}

export interface ContentReleaseRecord {
  id: string;
  projectId: string;
  articleId: string;
  buildId: string;
  buildArtifactSha256: string;
  targetProfileId: string;
  targetProfileSha256: string;
  approvalState: ReleaseApprovalState;
  readinessState: ReleaseReadinessState;
  readinessEvidenceSha256: string;
  readyAt: string | null;
  expiresAt: string | null;
  readinessBlockers?: string[];
  submissionState: ReleaseSubmissionState;
  destinationState: ReleaseDestinationState;
  publicState: ReleasePublicState;
  lifecycleState: ReleaseLifecycleState;
  remoteRecordId: string;
  destinationUrl: string;
  publicUrl: string;
  approvalNote: string;
  submissionEvidence: string[];
  destinationEvidence: string[];
  publicEvidence: string[];
  lockVersion: number;
  createdAt: string;
  updatedAt: string;
  buildInputCurrentness?: BuildInputCurrentness;
  buildInputBlockers?: string[];
}

export interface MetricSnapshotRecord {
  id: string;
  releaseId: string;
  projectId: string;
  articleId: string;
  sourceMode: "manual" | "export";
  sourceLabel: string;
  windowStart: string;
  windowEnd: string;
  capturedAt: string;
  metrics: Record<string, unknown>;
  evidenceRef: string;
  measurementSha256: string;
  definitionSetSha256: string | null;
  schemaState: "typed" | "legacy_untyped";
  validationState: MetricValidationState;
  validationNote: string;
  createdAt: string;
}

export interface MetricDefinitionRecord {
  id: string;
  definitionKey: string;
  version: string;
  label: string;
  description: string;
  valueKind: MetricValueKind;
  unit: string;
  missingPolicy: MetricMissingPolicy;
  constraints: Record<string, unknown>;
  scope: Record<string, unknown>;
  definitionSha256: string;
  status: "active" | "superseded";
  createdAt: string;
}

export interface MetricValueRecord {
  id: string;
  snapshotId: string;
  releaseId: string;
  projectId: string;
  articleId: string;
  definitionId: string;
  definitionSha256: string;
  observationState: MetricObservationState;
  value: unknown;
  valueSha256: string;
  createdAt: string;
}

export interface RetrospectiveRecord {
  id: string;
  projectId: string;
  articleId: string;
  releaseId: string | null;
  title: string;
  summary: string;
  evidenceRefs: string[];
  status: RetrospectiveState;
  lockVersion: number;
  createdAt: string;
  updatedAt: string;
}

export interface RuleCandidateRecord {
  id: string;
  projectId: string;
  articleId: string;
  retrospectiveId: string;
  title: string;
  ruleText: string;
  scope: string;
  counterexamples: string;
  owner: string;
  implementationTarget: string;
  regressionRef: string;
  evidenceRefs: string[];
  state: RuleCandidateState;
  lockVersion: number;
  createdAt: string;
  updatedAt: string;
}

export interface LifecycleEventRecord {
  id: string;
  articleId: string | null;
  eventType: string;
  subjectType: string;
  subjectId: string;
  payload: Record<string, unknown>;
  inputSha256: string;
  createdAt: string;
}

export interface LifecycleSnapshot {
  ok: boolean;
  storage: "d1-local" | "unavailable";
  articleId: string;
  projects: ArticleProjectRecord[];
  platformTargets: PlatformTargetRecord[];
  adaptationContracts: AdaptationContractRecord[];
  builds: ContentBuildRecord[];
  buildGates: BuildGateRunRecord[];
  releases: ContentReleaseRecord[];
  metricDefinitions: MetricDefinitionRecord[];
  metricSnapshots: MetricSnapshotRecord[];
  metricValues: MetricValueRecord[];
  retrospectives: RetrospectiveRecord[];
  ruleCandidates: RuleCandidateRecord[];
  events: LifecycleEventRecord[];
  error?: string;
}
