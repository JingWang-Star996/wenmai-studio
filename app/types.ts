export type Confidence = "高" | "中" | "低";
export type CorpusClass =
  | "published_article"
  | "draft_or_intermediate"
  | "platform_build"
  | "import_artifact"
  | "test_or_qa"
  | "skill_summary_or_capability"
  | "research_governance"
  | "tool"
  | "source_material"
  | "manifest_or_metadata"
  | "evidence"
  | "catalog_only";

export interface CorpusClassificationDecision {
  class: CorpusClass;
  basis: string;
  confidence: "high" | "medium" | "low";
  ruleVersion: string;
  evidenceRefs: string[];
}

export interface VersionMetrics {
  charCount: number;
  paragraphCount: number;
  sentenceCount: number;
  headingCount: number;
  averageSentenceLength: number;
  averageParagraphLength: number;
  longSentenceRatio: number;
  urlCount: number;
  numberMarkerCount: number;
  quoteCount: number;
  evidenceMarkerCount: number;
  exampleMarkerCount: number;
  abstractShellCount: number;
  scores: Record<string, number>;
}

export interface ArticleVersion {
  id: string;
  artifactId: string;
  name: string;
  path: string;
  pathAliases: string[];
  format: string;
  kind: string;
  role: string;
  platforms: string[];
  modifiedAt: string;
  sizeBytes: number;
  contentHash: string;
  textHash: string;
  charCount: number;
  excerpt: string;
  text?: string;
  textTruncated: boolean;
  metrics: VersionMetrics;
  metadataFiles: string[];
  metadata: Record<string, string | number | boolean>;
  metadataBindings: MetadataBinding[];
  classification: CorpusClassificationDecision;
}

export interface MetadataBinding {
  path: string;
  fields: Record<string, string | number | boolean>;
  bindingBasis: string[];
}

export interface PublicationEvidenceEvent {
  id: string;
  state: string;
  reportedState: string;
  sourcePath: string;
  bindingBasis: string[];
  bindingStrength: "strong" | "weak";
  qualifiesForRollup: boolean;
  observedAt: string | null;
  verificationMethod: string | null;
  url: string | null;
  explanation: string;
}

export interface PublicationVariant {
  id: string;
  versionId: string;
  platform: string;
  state: string;
  evidence: PublicationEvidenceEvent[];
  conflict: boolean;
}

export interface ArticleVariant {
  id: string;
  platform: string;
  versionIds: string[];
  representativeVersionId: string;
  pointerStatus: "suggested" | "confirmed";
}

export interface ArtifactRecord {
  id: string;
  sha256: string;
  textHash: string;
  pathAliases: string[];
  articleIds: string[];
  formats: string[];
  classification: CorpusClassificationDecision;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  type: string;
  weight: number;
  confidence: Confidence;
  status: "suggested" | "confirmed" | "rejected";
  algorithmVersion: string;
  createdBy: string;
  evidence: string[];
}

export interface ArticleRecord {
  id: string;
  title: string;
  canonicalTitle: string;
  kind: "文章" | "来源材料" | "创作工具" | "研究与治理";
  observedKinds: string[];
  status: string;
  editorialState: string;
  publicationState: string;
  gateState: string;
  evidenceHealth: string;
  publicationEvidence: string[];
  publicationVariants: PublicationVariant[];
  stateRuleVersion: string;
  stateInputDigest: string;
  identityConfidence: Confidence;
  identityStatus: "candidate" | "bound-explicit" | "confirmed";
  identityRuleVersion: string;
  identityInputDigest: string;
  identityBasis: string[];
  summary: string;
  tags: string[];
  entities: string[];
  platforms: string[];
  createdAt: string;
  updatedAt: string;
  versionCount: number;
  currentVersionId: string;
  representativeVersionId: string;
  charCount: number;
  stages: string[];
  versions: ArticleVersion[];
  variants: ArticleVariant[];
  classification: CorpusClassificationDecision;
  baseline: {
    algorithmVersion: string;
    profileVersion: string;
    sampleScope: string;
    sampleSize: number;
    raw: Record<string, number>;
    portfolioPercentile: Record<string, number>;
    explanation: string;
  };
  relations: GraphEdge[];
}

export interface TopicRecord {
  id: string;
  label: string;
  articleIds: string[];
  evidenceObjectIds: string[];
  articleCount: number;
  contentObjectCount: number;
  publishedCount: number;
  stages: string[];
  missingStages: string[];
  opportunityScore: number;
  lastUpdatedAt: string;
  signalStrength: Confidence;
}

export interface OpportunityRecord {
  id: string;
  type: string;
  title: string;
  score: number;
  scoreKind: "heuristic_order";
  scoreBreakdown: Record<string, number | null>;
  signalStrength: Confidence;
  rationale: string;
  evidence: string[];
  nextAction: string;
  whyNow: string;
  blockers: string[];
  relatedArticleIds: string[];
  relatedTopics: string[];
}

export interface SeriesSuggestion {
  id: string;
  title: string;
  topic: string;
  status: string;
  signalStrength: Confidence;
  articleIds: string[];
  existingTitles: string[];
  coveredStages: string[];
  missingStages: string[];
  nextArticle: string;
}

export interface GraphNode {
  id: string;
  label: string;
  type: "article" | "topic";
  size: number;
  status: string;
}

export interface CorpusData {
  schemaVersion: string;
  algorithmVersion: string;
  generatedAt: string;
  sourceRootLabel: string;
  stats: {
    sourceFiles: number;
    articleFamilies: number;
    contentFamilies: number;
    totalCharactersAcrossVersions: number;
    metadataFiles: number;
    unboundMetadataFiles: number;
    artifacts: number;
    previousBaselineArtifacts: number;
    currentArtifacts: number;
    addedArtifactsSinceBaseline: number;
    removedArtifactsSinceBaseline: number;
    artifactIdentityConflicts: number;
    relationEdges: number;
    workRelationEdges: number;
    topicCount: number;
    opportunityCount: number;
    extensionCounts: Record<string, number>;
    kindCounts: Record<string, number>;
    statusCounts: Record<string, number>;
    publicationStateCounts: Record<string, number>;
    classificationCounts: Record<CorpusClass, number>;
    developmentTreeNodes: number;
    developmentTreeEdges: number;
    confirmedDevelopmentEdges: number;
    suggestedDevelopmentEdges: number;
  };
  baselineDefinitions: Array<{ key: string; description: string }>;
  classification: {
    schemaVersion: string;
    ruleVersion: string;
    classes: Array<{ class: CorpusClass; description: string }>;
    objectCoverage: Record<string, number>;
    counts: Record<CorpusClass, number>;
    evidence: Array<{ id: string; kind: string; strength: string; sourcePath: string; locator: string | null; sha256: string | null; claim: string }>;
    policy: Record<string, string>;
  };
  artifactBaselineDelta: {
    basis: string;
    previousBaseline: number;
    current: number;
    added: number;
    removed: number;
    addedArtifactIds: string[];
    removedArtifactIds: string[];
  };
  developmentTree: {
    schemaVersion: string;
    ruleVersion: string;
    relationTypes: Array<{ type: string; description: string }>;
    nodes: Array<{ id: string; nodeType: string; label: string; classification?: CorpusClassificationDecision; [key: string]: unknown }>;
    edges: Array<{ id: string; relationType: string; source: string; target: string; status: "confirmed" | "suggested" | "rejected"; basis: string; confidence: string; ruleVersion: string; evidenceRefs: string[] }>;
    counts: { nodes: number; edges: number; confirmed: number; suggested: number; byRelationType: Record<string, number> };
    notes: string[];
  };
  articles: ArticleRecord[];
  artifacts: ArtifactRecord[];
  topics: TopicRecord[];
  opportunities: OpportunityRecord[];
  seriesSuggestions: SeriesSuggestion[];
  graph: { nodes: GraphNode[]; edges: GraphEdge[] };
  metadataCatalog: Array<{ path: string; fields: Record<string, unknown>; associationStatus: "bound" | "unbound"; linkedPaths: string[]; classification: CorpusClassificationDecision }>;
  analysisNotes: string[];
}

export interface EditorialItem {
  id: string;
  kind: "topic" | "series";
  title: string;
  status: string;
  summary: string;
  rationale: string;
  confidence: string;
  linkedArticleIds: string[];
  nextAction: string;
  sourceOpportunityId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ArticleOverride {
  articleId: string;
  editorialState: string;
  gateState: string;
  evidenceHealth: string;
  favorite: boolean;
  notes: string;
  seriesId: string | null;
  updatedAt: string;
}

export interface EditorialDecision {
  id: string;
  subjectType: "article" | "opportunity" | "identity";
  subjectId: string;
  decisionType: string;
  value: Record<string, unknown>;
  notes: string;
  ruleVersion: string;
  inputSha256: string;
  createdAt: string;
}

export type StudioView =
  | "dashboard"
  | "library"
  | "compare"
  | "baseline"
  | "graph"
  | "topics"
  | "series"
  | "rules";
