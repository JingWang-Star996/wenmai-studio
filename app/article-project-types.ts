export const PACKAGE_STATUSES = ["active", "archived"] as const;
export const MODULE_CONTENT_FORMATS = ["markdown", "text", "json"] as const;
export const MODULE_AUTHOR_KINDS = ["user", "agent", "import", "system"] as const;
export const SLICE_KINDS = ["full", "demo", "excerpt", "promo", "custom"] as const;
export const PATCH_STATES = ["candidate", "approved", "rejected", "applied", "stale", "cancelled"] as const;
export const DIAGNOSIS_RESULTS = ["pass", "fail", "inconclusive"] as const;
export const ISSUE_SEVERITIES = ["error", "warning", "info"] as const;
export const IMPORT_STATES = ["candidate_ready", "applied", "failed", "cancelled"] as const;
export const EXPORT_STATES = ["manifest_ready", "verified", "failed", "cancelled"] as const;

export type PackageStatus = (typeof PACKAGE_STATUSES)[number];
export type ModuleContentFormat = (typeof MODULE_CONTENT_FORMATS)[number];
export type ModuleAuthorKind = (typeof MODULE_AUTHOR_KINDS)[number];
export type SliceKind = (typeof SLICE_KINDS)[number];
export type PatchState = (typeof PATCH_STATES)[number];
export type DiagnosisResult = (typeof DIAGNOSIS_RESULTS)[number];
export type IssueSeverity = (typeof ISSUE_SEVERITIES)[number];
export type ImportState = (typeof IMPORT_STATES)[number];
export type ExportState = (typeof EXPORT_STATES)[number];

export interface PackageAssetInput {
  id?: string;
  key: string;
  kind: string;
  title: string;
  contentRef: string;
  mediaType: string;
  sha256: string;
  sizeBytes: number;
  metadata?: Record<string, unknown>;
  rights?: Record<string, unknown>;
}

export interface PackageSourceRefInput {
  id?: string;
  key: string;
  sourceKind: string;
  canonicalRef: string;
  title: string;
  capturedAt?: string | null;
  contentSha256?: string | null;
  excerpt?: string;
  metadata?: Record<string, unknown>;
  rights?: Record<string, unknown>;
}

export interface PackageModuleRefInput {
  refKind: "asset" | "source";
  refKey: string;
  relationType: string;
  anchor?: Record<string, unknown>;
}

export interface PackageModuleInput {
  id?: string;
  key: string;
  kind: string;
  title: string;
  contentFormat?: ModuleContentFormat;
  contentText?: string;
  content?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  refs?: PackageModuleRefInput[];
}

export interface PackageEdgeInput {
  id?: string;
  key: string;
  sourceModuleKey: string;
  targetModuleKey: string;
  relationType: string;
  ordinal?: number;
  condition?: Record<string, unknown>;
}

export interface PackageDocument {
  schemaVersion: "wenmai-package-document-v1";
  title: string;
  rootModuleKey: string;
  modules: PackageModuleInput[];
  edges: PackageEdgeInput[];
  assets: PackageAssetInput[];
  sources: PackageSourceRefInput[];
  metadata: Record<string, unknown>;
}

export type PackagePatchOperation =
  | { op: "replace_document"; document: PackageDocument }
  | { op: "replace_module"; moduleKey: string; module: PackageModuleInput }
  | { op: "add_module"; module: PackageModuleInput }
  | { op: "remove_module"; moduleKey: string }
  | { op: "upsert_edge"; edge: PackageEdgeInput }
  | { op: "remove_edge"; edgeKey: string };

export interface ArticleProjectPackageRecord {
  id: string;
  projectId: string | null;
  articleId: string;
  title: string;
  schemaVersion: string;
  branchModelVersion: number | null;
  primaryBranchId: string | null;
  mainCompositionId: string;
  mainCompositionSha256: string;
  status: PackageStatus;
  lockVersion: number;
  createdAt: string;
  updatedAt: string;
}

export interface PackageBranchStateRecord {
  packageId: string;
  branchId: string;
  headCompositionId: string;
  headCompositionSha256: string;
  headRevisionId: string;
  status: "active" | "archived";
  lockVersion: number;
  createdAt: string;
  updatedAt: string;
}

export interface PackageBranchWorkingCopyRecord extends Omit<PackageWorkingCopyRecord, "branchId" | "baseRevisionId"> {
  branchId: string;
  baseRevisionId: string;
}

export interface PackageBranchCompositionCommitRecord {
  id: string;
  packageId: string;
  branchId: string;
  parentCompositionId: string | null;
  compositionId: string;
  compositionSha256: string;
  previousRevisionId: string | null;
  articleRevisionId: string;
  sourceKind: "attach" | "commit" | "patch" | "import" | "system";
  sourcePatchId: string | null;
  createdByKind: ModuleAuthorKind;
  createdAt: string;
}

export interface PackageBranchMigrationAuditRecord {
  packageId: string;
  state: "legacy_unbound" | "migrated_clean" | "migrated_dirty" | "blocked";
  reasonCode: string;
  detail: Record<string, unknown>;
  sourceSchemaVersion: string;
  createdAt: string;
  updatedAt: string;
}

export interface PackageBranchEntryRecord {
  branchId: string;
  name: string;
  slug: string;
  articleStatus: "active" | "archived";
  headRevisionId: string;
  headBodySha256: string;
  articleWorkingDirty: boolean;
  articleWorkingLockVersion: number;
  attached: boolean;
  branchState: PackageBranchStateRecord | null;
  packageWorking: Omit<PackageBranchWorkingCopyRecord, "document"> | null;
}

export interface PackageWorkingCopyRecord {
  packageId: string;
  branchId: string | null;
  baseCompositionId: string;
  baseRevisionId: string | null;
  document: PackageDocument;
  documentSha256: string;
  dirty: boolean;
  lockVersion: number;
  updatedAt: string;
}

export interface PackageCompositionRecord {
  id: string;
  packageId: string;
  parentCompositionId: string | null;
  title: string;
  schemaVersion: string;
  rootModuleId: string;
  document: PackageDocument;
  documentSha256: string;
  manifest: Record<string, unknown>;
  compositionSha256: string;
  sourceArticleRevisionId: string | null;
  authorKind: ModuleAuthorKind;
  sourcePatchId: string | null;
  createdAt: string;
}

export interface PackageCompositionMaterializationRecord {
  id: string;
  packageId: string;
  branchId: string;
  compositionId: string;
  compositionSha256: string;
  articleRevisionId: string;
  articleBodySha256: string;
  rendererKey: string;
  rendererVersion: string;
  createdByKind: ModuleAuthorKind;
  createdAt: string;
}

export interface PackageBranchBridgeRecord {
  packageId: string;
  branchId: string;
  branchName: string;
  branchSlug: string;
  branchStatus: "active" | "archived";
  headRevisionId: string;
  headBodySha256: string;
  workingBaseRevisionId: string;
  workingCopyDirty: boolean;
  workingCopyLockVersion: number;
  packageBaseRevisionId: string | null;
  materialization: PackageCompositionMaterializationRecord | null;
  inSync: boolean;
}

export interface PackageModuleRecord {
  id: string;
  packageId: string;
  moduleKey: string;
  moduleKind: string;
  schemaKey: string;
  schemaVersion: string;
  createdAt: string;
}

export interface PackageModuleRevisionRecord {
  id: string;
  packageId: string;
  moduleId: string;
  parentRevisionId: string | null;
  title: string;
  contentFormat: ModuleContentFormat;
  contentText?: string;
  content?: Record<string, unknown>;
  contentSha256: string;
  metadata: Record<string, unknown>;
  revisionSha256: string;
  authorKind: ModuleAuthorKind;
  sourcePatchId: string | null;
  createdAt: string;
}

export interface PackageCompositionNodeRecord {
  id: string;
  packageId: string;
  compositionId: string;
  moduleId: string;
  moduleRevisionId: string;
  nodeKey: string;
  slot: string;
  ordinal: number;
  required: boolean;
  config: Record<string, unknown>;
}

export interface PackageCompositionEdgeRecord {
  id: string;
  packageId: string;
  compositionId: string;
  edgeKey: string;
  sourceNodeId: string;
  targetNodeId: string;
  relationType: string;
  ordinal: number;
  condition: Record<string, unknown>;
  edgeSha256: string;
}

export interface PackageAssetRecord extends Omit<PackageAssetInput, "id"> {
  id: string;
  packageId: string;
  createdAt: string;
}

export interface PackageSourceRefRecord extends Omit<PackageSourceRefInput, "id"> {
  id: string;
  packageId: string;
  refSha256: string;
  createdAt: string;
}

export interface PackageSliceRecord {
  id: string;
  packageId: string;
  branchId: string | null;
  baseRevisionId: string | null;
  baseBranchLockVersion: number | null;
  compositionId: string;
  compositionSha256: string;
  title: string;
  sliceKind: SliceKind;
  selector: Record<string, unknown>;
  resolvedManifest: Record<string, unknown>;
  sliceSha256: string;
  createdByKind: ModuleAuthorKind;
  createdAt: string;
}

export interface PackagePatchProposalRecord {
  id: string;
  packageId: string;
  baseCompositionId: string;
  baseCompositionSha256: string;
  branchId: string | null;
  baseRevisionId: string | null;
  basePackageLockVersion: number | null;
  baseBranchLockVersion: number | null;
  taskId: string | null;
  attemptId: string | null;
  contextSha256: string | null;
  title: string;
  summary: string;
  operations: PackagePatchOperation[];
  patchSha256: string;
  evidence: string[];
  diagnosticIssueIds: string[];
  status: PatchState;
  lockVersion: number;
  createdByKind: "user" | "agent" | "import" | "diagnostic";
  createdById: string;
  decisionNote: string;
  appliedCompositionId: string | null;
  createdAt: string;
  reviewedAt: string | null;
  appliedAt: string | null;
}

export interface DiagnosisRunRecord {
  id: string;
  packageId: string;
  branchId: string | null;
  baseRevisionId: string | null;
  baseBranchLockVersion: number | null;
  compositionId: string;
  compositionSha256: string;
  algorithmVersion: string;
  result: DiagnosisResult;
  issueCount: number;
  errorCount: number;
  warningCount: number;
  inputSha256: string;
  summarySha256: string;
  createdAt: string;
}

export interface DiagnosticIssueRecord {
  id: string;
  diagnosisRunId: string;
  packageId: string;
  branchId: string | null;
  compositionId: string;
  moduleId: string | null;
  nodeId: string | null;
  edgeId: string | null;
  code: string;
  severity: IssueSeverity;
  title: string;
  message: string;
  evidence: string[];
  suggestedPatch: PackagePatchOperation[];
  issueSha256: string;
  createdAt: string;
}

export interface PackageImportRunRecord {
  id: string;
  packageId: string;
  branchId: string | null;
  baseRevisionId: string | null;
  baseBranchLockVersion: number | null;
  baseCompositionId: string;
  baseCompositionSha256: string;
  sourceKind: string;
  sourceRef: string;
  sourceFingerprintSha256: string;
  importerKey: string;
  importerVersion: string;
  manifest: Record<string, unknown>;
  manifestSha256: string;
  patchProposalId: string;
  state: ImportState;
  lockVersion: number;
  errorSummary: string;
  createdAt: string;
  finishedAt: string | null;
}

export interface PackageExportRunRecord {
  id: string;
  packageId: string;
  branchId: string | null;
  baseRevisionId: string | null;
  baseBranchLockVersion: number | null;
  compositionId: string;
  compositionSha256: string;
  sliceId: string | null;
  sliceSha256: string | null;
  exportKind: string;
  exporterKey: string;
  exporterVersion: string;
  manifest: Record<string, unknown>;
  manifestSha256: string;
  artifactRef: string;
  artifactSha256: string;
  artifactMediaType: string;
  state: ExportState;
  lockVersion: number;
  failureSummary: string;
  createdAt: string;
  verifiedAt: string | null;
}
