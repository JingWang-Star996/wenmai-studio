import type { ArticleRecord, CorpusClass, CorpusClassificationDecision, OpportunityRecord, SeriesSuggestion, TopicRecord } from "./types";

export type WorkStage =
  | "inbox"
  | "commission"
  | "research"
  | "draft"
  | "review"
  | "approved"
  | "distribution"
  | "maintain";

export type WorkspaceView =
  | "project"
  | "groups"
  | "desk"
  | "versions"
  | "pipeline"
  | "factory"
  | "agents"
  | "lifecycle"
  | "capabilities"
  | "library"
  | "shared-sources"
  | "evidence";

export interface WorkbenchVersion {
  id: string;
  name: string;
  path: string;
  pathAliases: string[];
  role: string;
  format: string;
  modifiedAt: string;
  textHash: string;
  charCount: number;
  excerpt: string;
  metrics: ArticleRecord["versions"][number]["metrics"];
  classification: CorpusClassificationDecision;
  storage?: "corpus" | "d1";
}

export interface WorkbenchArticle {
  id: string;
  title: string;
  canonicalTitle: string;
  kind: ArticleRecord["kind"];
  summary: string;
  tags: string[];
  platforms: string[];
  updatedAt: string;
  representativeVersionId: string;
  currentVersionId: string;
  versionCount: number;
  identityStatus: ArticleRecord["identityStatus"];
  identityConfidence: ArticleRecord["identityConfidence"];
  publicationState: string;
  evidenceHealth: string;
  editorialState: string;
  versions: WorkbenchVersion[];
  baseline: ArticleRecord["baseline"];
  classification: CorpusClassificationDecision;
}

export interface WorkbenchCorpus {
  schemaVersion: string;
  algorithmVersion: string;
  generatedAt: string;
  sourceRootLabel: string;
  stats: {
    sourceFiles: number;
    articleFamilies: number;
    contentFamilies: number;
    opportunityCount: number;
    topicCount: number;
    classificationCounts: Record<CorpusClass, number>;
    developmentTreeNodes: number;
    developmentTreeEdges: number;
    confirmedDevelopmentEdges: number;
    suggestedDevelopmentEdges: number;
  };
  classification: {
    schemaVersion: string;
    ruleVersion: string;
    classes: Array<{ class: CorpusClass; description: string }>;
    counts: Record<CorpusClass, number>;
    policy: Record<string, string>;
  };
  developmentTree: {
    schemaVersion: string;
    ruleVersion: string;
    relationTypes: Array<{ type: string; description: string }>;
    counts: { nodes: number; edges: number; confirmed: number; suggested: number; byRelationType: Record<string, number> };
    notes: string[];
  };
  articles: WorkbenchArticle[];
  articleRelations: WorkbenchArticleRelation[];
  topics: TopicRecord[];
  opportunities: OpportunityRecord[];
  seriesSuggestions: SeriesSuggestion[];
}

export interface WorkbenchArticleRelation {
  id: string;
  sourceArticleId: string;
  targetArticleId: string;
  relationType: string;
  status: "confirmed" | "suggested" | "rejected";
  confidence: string;
  basis: string;
  evidenceRefs: string[];
  sourceArtifactId: string;
  targetArtifactId: string;
}

/**
 * Browser-owned directory entry for an article created directly in the local
 * D1 workspace. The article body is deliberately excluded: localStorage is
 * only a restart-safe pointer catalogue, never a second document store.
 */
export interface LocalArticleDirectoryEntry {
  schemaVersion: "wenmai-local-article/1.0";
  articleId: string;
  projectId: string | null;
  packageId: string;
  title: string;
  branchId: string;
  revisionId: string;
  bodySha256: string;
  charCount: number;
  revisionCount?: number;
  branchCount?: number;
  activeBranchCount?: number;
  archivedBranchCount?: number;
  unmergedBranchCount?: number;
  dirtyWorkingCopyCount?: number;
  identityId?: string | null;
  canonicalArticleId?: string;
  identityRole?: string | null;
  catalogState?: "active" | "archived" | "hidden";
  legacyRootCount?: number;
  identityMemberCount?: number;
  pendingCandidateCount?: number;
  revisions?: LocalArticleRevisionPointer[];
  createdAt: string;
  updatedAt: string;
}

export interface LocalArticleRevisionPointer {
  id: string;
  branchId: string;
  sequence: number;
  title: string;
  documentTitle: string;
  annotation: string;
  bodySha256: string;
  charCount: number;
  authorKind: ArticleRevision["authorKind"];
  createdAt: string;
}

export type CapabilityKind = "skill" | "gate" | "workflow" | "template" | "checker";
export type CapabilityAvailability = "available" | "missing" | "unreadable";
export type CapabilityAdoption = "unassessed" | "candidate" | "tested" | "verified" | "adopted" | "deferred" | "rejected";
export type CapabilityDimension =
  | "commission"
  | "research"
  | "evidence"
  | "structure"
  | "drafting"
  | "language"
  | "visual"
  | "quality"
  | "packaging"
  | "publishing"
  | "review"
  | "orchestration";

export interface CapabilityMaterial {
  id: string;
  label: string;
  locator: string;
  kind: "local" | "url" | "document" | "script" | "template";
  relation: "explicit" | "inferred";
  exists: boolean | null;
}

export interface CapabilityRecord {
  id: string;
  name: string;
  description: string;
  kind: CapabilityKind;
  dimension: CapabilityDimension;
  stages: WorkStage[];
  availability: CapabilityAvailability;
  indexedAdoption: CapabilityAdoption;
  adoptionBasis: string;
  auditId?: string;
  maturityScope?: string;
  owner?: string | null;
  evidenceRefs?: string[];
  freshness?: string;
  canonicalEntry?: string;
  entryPath: string;
  root: string;
  gateInput: string[];
  gateOutput: string[];
  scripts: string[];
  materials: CapabilityMaterial[];
  tags: string[];
  sourceDigest: string;
}

export interface CapabilityGap {
  id: string;
  dimension: CapabilityDimension;
  label: string;
  severity: "high" | "medium" | "low";
  rationale: string;
  missingKinds: CapabilityKind[];
  nextAction: string;
}

export interface CapabilityIndex {
  schemaVersion: string;
  generatedAt: string;
  roots: Array<{ label: string; path: string; status: string }>;
  dimensions: Array<{ id: CapabilityDimension; label: string; question: string; order: number }>;
  stats: {
    capabilities: number;
    skills: number;
    gates: number;
    workflows: number;
    templates: number;
    explicitMaterialLinks: number;
    inferredMaterialLinks: number;
  };
  capabilities: CapabilityRecord[];
  gaps: CapabilityGap[];
  notes: string[];
}

export interface ArticleBranch {
  id: string;
  articleId: string;
  name: string;
  slug: string;
  color: string;
  status: "active" | "archived";
  headRevisionId: string;
  baseRevisionId: string;
  baseSourceVersionId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ArticleRevision {
  id: string;
  articleId: string;
  branchId: string;
  sequence: number;
  parentRevisionId: string | null;
  mergeParentRevisionId: string | null;
  sourceVersionId: string | null;
  title: string;
  documentTitle: string;
  annotation: string;
  bodyText?: string;
  bodySha256: string;
  authorKind: "user" | "agent" | "import";
  charCount: number;
  createdAt: string;
}

export interface WorkingCopy {
  branchId: string;
  articleId: string;
  baseRevisionId: string;
  title: string;
  annotation: string;
  bodyText: string;
  bodySha256: string;
  dirty: boolean;
  lockVersion: number;
  updatedAt: string;
}

export interface WorkItem {
  id: string;
  articleId: string | null;
  branchId: string | null;
  title: string;
  kind: string;
  stage: WorkStage;
  state: "open" | "blocked" | "done" | "cancelled";
  priority: "P0" | "P1" | "P2" | "P3";
  owner: string;
  nextAction: string;
  blocker: string;
  sourceCapabilityId: string | null;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface GateRun {
  id: string;
  runGroupId: string;
  articleId: string;
  branchId: string;
  revisionId: string | null;
  gateId: string;
  gateLabel: string;
  result: "pass" | "fail" | "inconclusive";
  inputSha256: string;
  evidence: string[];
  details: Record<string, string | number | boolean | null>;
  startedAt: string;
  completedAt: string;
}

export interface CapabilityOverride {
  capabilityId: string;
  adoptionStatus: CapabilityAdoption;
  notes: string;
  evidenceRef: string;
  regressionRef: string;
  favorite: boolean;
  updatedAt: string;
}

export interface ProductionRunStep {
  id: string;
  runId: string;
  stepId: string;
  position: number;
  title: string;
  actorKind: string;
  agentRole: string | null;
  dependsOn: string[];
  writeScope: "none" | "artifact-only" | "branch-working-copy";
  runnerAction: string | null;
  capabilityId: string | null;
  gateId: string | null;
  status: "pending" | "active" | "blocked" | "complete" | "skipped";
  evidence: string[];
  updatedAt: string;
}

export interface ProductionRun {
  id: string;
  recipeId: string;
  recipeVersion: string;
  recipeSha256: string;
  articleId: string;
  branchId: string;
  title: string;
  status: "planned" | "active" | "paused" | "complete" | "cancelled";
  currentStepId: string | null;
  createdAt: string;
  updatedAt: string;
  steps: ProductionRunStep[];
}

export interface WorkspaceEvent {
  id: string;
  eventType: string;
  subjectType: string;
  subjectId: string;
  articleId: string | null;
  payload: Record<string, unknown>;
  inputSha256: string;
  createdAt: string;
}

export interface MergeProposal {
  id: string;
  workItemId: string;
  articleId: string;
  sourceBranchId: string;
  targetBranchId: string;
  baseRevisionId: string;
  sourceHeadRevisionId: string;
  targetHeadRevisionId: string;
  baseSha256: string;
  sourceHeadSha256: string;
  targetHeadSha256: string;
  algorithmVersion: string;
  preview: Record<string, unknown>;
  previewSha256: string;
  resolvedDocumentTitle: string;
  resolvedBodyText: string;
  resolvedBodySha256: string;
  resolution: Record<string, unknown>;
  resolutionNote: string;
  unresolvedCount: number;
  status: "prepared" | "resolving" | "ready" | "stale" | "merged" | "cancelled";
  lockVersion: number;
  mergeRevisionId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceSnapshot {
  storage: "d1-local" | "unavailable";
  branches: ArticleBranch[];
  revisions: ArticleRevision[];
  workingCopies: WorkingCopy[];
  workItems: WorkItem[];
  gateRuns: GateRun[];
  capabilityOverrides: CapabilityOverride[];
  productionRuns: ProductionRun[];
  mergeProposals: MergeProposal[];
  events: WorkspaceEvent[];
  error?: string;
}

export interface FactoryRecipeStep {
  id: string;
  title: string;
  actorKind: "human" | "agent" | "script";
  agentRole?: string;
  dependsOn?: string[];
  parallelGroup?: string;
  writeScope?: "none" | "artifact-only" | "branch-working-copy";
  runnerAction?: "text-gates";
  capabilityId?: string;
  gateId?: string;
  input: string;
  output: string;
  completionClaim: string;
}

export interface RunnerRecord {
  id: string;
  label: string;
  capabilities: string[];
  status: "active" | "revoked";
  lastSeenAt: string | null;
  createdAt: string;
}

export interface AgentArtifactRecord {
  id: string;
  agentStepId: string;
  kind: string;
  title: string;
  contentRef: string;
  sha256: string;
  mediaType: string;
  sizeBytes: number;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface AgentStepRecord {
  id: string;
  agentRunId: string;
  recipeStepId: string;
  attempt: number;
  runnerAction: string;
  agentRole: string | null;
  state: "queued" | "leased" | "running" | "succeeded" | "failed" | "cancelled";
  assignedRunnerId: string | null;
  inputSha256: string;
  outputSha256: string | null;
  errorClass: string | null;
  errorSummary: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  updatedAt: string;
  artifacts: AgentArtifactRecord[];
}

export interface AgentRunRecord {
  id: string;
  productionRunId: string;
  productionStepId: string;
  recipeId: string;
  recipeVersion: string;
  recipeSha256: string;
  articleId: string;
  branchId: string;
  frozenRevisionId: string;
  inputSha256: string;
  permissions: Record<string, unknown>;
  state: "queued" | "running" | "awaiting_human" | "partial" | "succeeded" | "failed" | "cancelled";
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  lastHeartbeatAt: string | null;
  steps: AgentStepRecord[];
}

export interface RunnerSnapshot {
  runners: RunnerRecord[];
  agentRuns: AgentRunRecord[];
  error?: string;
}

export interface FactoryRecipe {
  id: string;
  version: string;
  title: string;
  summary: string;
  topology: "sequential" | "fork-join";
  selectionRule: string;
  steps: FactoryRecipeStep[];
}
