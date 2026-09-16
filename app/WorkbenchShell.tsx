"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import MarkdownPreview, { outlineFromMarkdown } from "./MarkdownPreview";
import AgentConsole from "./AgentConsole";
import { ArticlePreviewProvider, ArticleQuickLink } from "./ArticlePreview";
import ArticleProjectEditor from "./ArticleProjectEditor";
import DistributionHub from "./DistributionHub";
import VersionDag from "./VersionDag";
import HumanReviewPanel, { type ReviewTarget } from "./HumanReviewPanel";
import ProjectGroupPanel from "./ProjectGroupPanel";
import {
  INFORMATION_COVER_CAPABILITY_ID,
  isInformationCoverRecipeStep,
} from "./information-cover-workflow";
import { diffBlocks, diffSummary } from "./studio-utils";
import { managementFetch } from "./management-fetch";
import SharedSourcePanel from "./SharedSourcePanel";
import type {
  ArticleRevision,
  CapabilityAdoption,
  CapabilityIndex,
  CapabilityRecord,
  FactoryRecipe,
  GateRun,
  LocalArticleDirectoryEntry,
  RunnerSnapshot,
  WorkItem,
  WorkStage,
  WorkbenchArticle,
  WorkbenchCorpus,
  WorkspaceEvent,
  WorkingCopy,
  WorkspaceSnapshot,
  WorkspaceView,
} from "./workbench-types";

const NAV_ITEMS: Array<{ id: WorkspaceView; label: string; mark: string; hint: string }> = [
  { id: "project", label: "文章工程", mark: "编", hint: "查看结构并继续制作" },
  { id: "groups", label: "项目组图", mark: "组", hint: "整理文章归组与开发顺序" },
  { id: "desk", label: "写作工位", mark: "写", hint: "编辑当前正文" },
  { id: "versions", label: "版本与分支", mark: "支", hint: "比较、分支与合并" },
  { id: "pipeline", label: "任务看板", mark: "流", hint: "安排下一步与处理阻塞" },
  { id: "factory", label: "制作路线", mark: "厂", hint: "查看工位与运行证据" },
  { id: "agents", label: "Agent 任务", mark: "智", hint: "查看任务、进度与审批" },
  { id: "lifecycle", label: "平台适配与发行", mark: "版", hint: "准备构建工件、提交与复盘" },
  { id: "capabilities", label: "能力目录", mark: "能", hint: "查找能力、门禁与缺口" },
  { id: "library", label: "内容资料库", mark: "库", hint: "查找文章、选题与系列" },
  { id: "shared-sources", label: "共享来源", mark: "源", hint: "查看本地来源登记与证据" },
  { id: "evidence", label: "证据与检查", mark: "证", hint: "确认状态、来源与边界" },
];

const STAGES: Array<{ id: WorkStage; label: string; short: string; deliverable: string }> = [
  { id: "inbox", label: "选题收集", short: "创", deliverable: "问题、灵感与机会信号" },
  { id: "commission", label: "明确立项", short: "立", deliverable: "受众、价值承诺、范围与成功指标" },
  { id: "research", label: "策划准备", short: "策", deliverable: "材料账本、结构方案与制作路线" },
  { id: "draft", label: "撰写正文", short: "写", deliverable: "可继续编辑的正文工作副本" },
  { id: "review", label: "审校与包装", short: "包", deliverable: "措辞、标题、视觉与宣发物料" },
  { id: "approved", label: "建立构建基线", short: "构", deliverable: "修订、分支、门禁与可追溯构建工件" },
  { id: "distribution", label: "提交与发行", short: "发", deliverable: "平台适配、提交与可见性证据" },
  { id: "maintain", label: "观察与复盘", short: "数", deliverable: "指标快照、结论与规则候选" },
];

const ADOPTION_LABELS: Record<CapabilityAdoption, string> = {
  unassessed: "未审计",
  candidate: "候选",
  tested: "已测试",
  verified: "已验证",
  adopted: "已采用",
  deferred: "暂缓",
  rejected: "不采用",
};

const EMPTY_WORKSPACE: WorkspaceSnapshot = {
  storage: "unavailable",
  branches: [],
  revisions: [],
  workingCopies: [],
  workItems: [],
  gateRuns: [],
  capabilityOverrides: [],
  productionRuns: [],
  mergeProposals: [],
  events: [],
};

const EMPTY_RUNNERS: RunnerSnapshot = {
  runners: [],
  agentRuns: [],
};
type RsiSummary = { pendingCount: number; eligibleCount: number; blockedCount: number };

const LOCAL_ARTICLE_DIRECTORY_KEY = "wenmai:local-article-directory";

type IdentityCatalogArticle = {
  articleId: string;
  title: string;
  packageId: string | null;
  packageStatus: string | null;
  primaryBranchId: string | null;
  headRevisionId: string | null;
  headBodySha256: string | null;
  revisionCount: number;
  branchCount: number;
  activeBranchCount: number;
  archivedBranchCount: number;
  unmergedBranchCount: number;
  dirtyWorkingCopyCount: number;
  identityId: string | null;
  canonicalArticleId: string;
  identityRole: string | null;
  catalogState: "active" | "archived" | "hidden";
  legacyRootCount: number;
  identityMemberCount: number;
  pendingCandidateCount: number;
  createdAt: string | null;
  updatedAt: string | null;
  revisions: NonNullable<LocalArticleDirectoryEntry["revisions"]>;
  canonicalRedirect: { articleId: string } | null;
};

type IdentityCandidate = {
  id: string;
  sourceArticleId: string;
  sourceRevisionId: string;
  sourceBodySha256: string;
  targetArticleId: string;
  targetRevisionId: string;
  targetBodySha256: string;
  proposedRelation: string;
  state: string;
  score: number | null;
  signals: Record<string, unknown>;
  evidence: Array<Record<string, unknown>>;
  lockVersion: number;
};

type IdentityCatalog = {
  localArticles: IdentityCatalogArticle[];
  identities: Array<{ id: string; canonicalArticleId: string; title: string; status: string; lockVersion: number; counts: { memberCount: number; legacyRootCount: number; candidateCount: number; confirmedLinkCount: number } }>;
  candidates: IdentityCandidate[];
  counts: { localArticles: number; active: number; archived: number; hidden: number; identities: number; pendingCandidates: number };
};

type IdentityPlan = {
  operationId: string;
  planSha256: string;
  candidateId: string;
  canonicalArticleId: string;
  legacyArticleId: string;
};

type SourceOwnerMismatch = {
  sourceBranchId: string;
  sourceArticleId: string;
  sourceRevisionId: string;
  sourceVersionId: string;
  sourceBodySha256: string;
  currentOwnerArticleId: string;
  currentOwnerTitle: string;
  evidence: {
    kind: string;
    corpusSchemaVersion: string;
    corpusAlgorithmVersion: string;
    corpusGeneratedAt: string;
    ownerCount: number;
    ownerTextHash: string;
    bodyShaMatchesOwnerTextHash: boolean;
    branchBaseSourceMatchesRevisionSource: boolean;
    repairAuthority: string;
  };
  lock: {
    branchStatus: string;
    branchHeadRevisionId: string;
    workingCopyPresent: boolean;
    workingCopyBaseRevisionId: string | null;
    workingCopyBodySha256: string | null;
    workingCopyDirty: boolean | null;
    workingCopyLockVersion: number | null;
    packageId: string | null;
    packageStatus: string | null;
  };
};

type SourceOwnerPlan = {
  operationId: string;
  planSha256: string;
  mismatch: SourceOwnerMismatch;
};

type LineageAiStatus = {
  candidateOnly: true;
  invocationSchemaReady: boolean;
  provider: {
    provider: string;
    configured: boolean;
    ready: boolean;
    model: string;
    baseUrl: string;
    error?: string;
  };
  counts: {
    prepared: number;
    candidateReviews: number;
    checkpointedAwaitingMaterialization: number;
  };
  paidNetworkProbePerformed: boolean;
};

type LineageAiPreparation = {
  preparationId: string;
  candidateId: string;
  expectedCandidateLockVersion: number;
  inputSha: string;
  inputTokenEstimate: number;
  budgetEstimate: {
    maxInputTokens: number;
    maxOutputTokens: number;
    maxCostCnyMicros: number;
    reservedCostCnyMicros: number;
    actualProviderCostKnown: boolean;
    automaticRetry: boolean;
  };
  runCommandId: string;
};

type LineageAiReview = {
  id: string;
  candidateId: string;
  state: string;
  candidateOnly: boolean;
  model?: string;
  output: null | {
    relationRecommendation: string;
    confidence: number;
    reasons: string[];
    differences: string[];
    risks: string[];
    nextStep: string;
  };
  createdAt: string;
};

type StaleIdentityOperation = {
  operationId: string;
  planSha256: string;
  preconditionsSha256: string;
  lockVersion: number;
  candidateId: string;
  plannedAt: string;
  terminalProof: {
    candidate: null | { status: string; inputSha256: string; lockVersion: number; decidedAt: string | null; operationId: string };
    appliedOperation: null | { operationId: string; planSha256: string; appliedAt: string | null; lockVersion: number };
  };
  recommendedAction: "supersede_stale_operation";
};

function localArticleFromDirectory(entry: LocalArticleDirectoryEntry): WorkbenchArticle {
  const classification = {
    class: "draft_or_intermediate" as const,
    basis: "浏览器导入回执已绑定本地 Article / Package / Branch / Revision",
    confidence: "high" as const,
    ruleVersion: "wenmai-local-article/1.1",
    evidenceRefs: [`package:${entry.packageId}`, `revision:${entry.revisionId}`, `sha256:${entry.bodySha256}`],
  };
  const revisions = (entry.revisions ?? []).map((revision) => ({
    id: revision.id,
    name: `r${revision.sequence} · ${revision.documentTitle || revision.title}`,
    path: `d1://${entry.articleId}/${revision.branchId}/${revision.id}`,
    pathAliases: [],
    role: revision.sequence === Math.max(...(entry.revisions ?? []).map((item) => item.sequence)) ? "当前修订" : "历史修订",
    format: "markdown",
    modifiedAt: revision.createdAt,
    textHash: revision.bodySha256,
    charCount: revision.charCount,
    excerpt: revision.annotation,
    metrics: {
      charCount: revision.charCount,
      paragraphCount: 0,
      sentenceCount: 0,
      headingCount: 0,
      averageSentenceLength: 0,
      averageParagraphLength: 0,
      longSentenceRatio: 0,
      urlCount: 0,
      numberMarkerCount: 0,
      quoteCount: 0,
      evidenceMarkerCount: 0,
      exampleMarkerCount: 0,
      abstractShellCount: 0,
      scores: {},
    },
    classification,
    storage: "d1" as const,
  })).sort((left, right) => right.modifiedAt.localeCompare(left.modifiedAt));
  const currentVersionId = revisions.some((revision) => revision.id === entry.revisionId)
    ? entry.revisionId
    : revisions[0]?.id ?? entry.revisionId;
  return {
    id: entry.articleId,
    title: entry.title,
    canonicalTitle: entry.title,
    kind: "文章",
    summary: "通过文章工程导入的本地 D1 文章；正文与历史以当前 Branch / Revision 为准。",
    tags: ["本地文章工程"],
    platforms: [],
    updatedAt: entry.updatedAt,
    representativeVersionId: currentVersionId,
    currentVersionId,
    versionCount: entry.revisionCount ?? revisions.length,
    identityStatus: "bound-explicit",
    identityConfidence: "高",
    publicationState: "未发布",
    evidenceHealth: "D1 创建回执",
    editorialState: "创作中",
    versions: revisions,
    baseline: {
      algorithmVersion: "wenmai-local-article/1.0",
      profileVersion: "not-computed",
      sampleScope: "本地 D1 文章工程不进入只读 corpus 画像",
      sampleSize: 0,
      raw: {},
      portfolioPercentile: {},
      explanation: "本地文章目录只保存恢复工程所需的身份指针，不伪造 corpus 结构分数。",
    },
    classification,
  };
}

function parseLocalArticleDirectory(value: string | null): LocalArticleDirectoryEntry[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is LocalArticleDirectoryEntry => {
      if (!entry || typeof entry !== "object") return false;
      const item = entry as Partial<LocalArticleDirectoryEntry>;
      return item.schemaVersion === "wenmai-local-article/1.0"
        && typeof item.articleId === "string" && item.articleId.startsWith("local-article-")
        && typeof item.packageId === "string" && item.packageId.startsWith("pkg-")
        && typeof item.branchId === "string" && item.branchId.startsWith("branch-")
        && typeof item.revisionId === "string" && item.revisionId.startsWith("revision-")
        && typeof item.title === "string" && item.title.trim().length > 0
        && typeof item.bodySha256 === "string" && /^[a-f0-9]{64}$/.test(item.bodySha256)
        && typeof item.charCount === "number" && Number.isFinite(item.charCount)
        && typeof item.createdAt === "string" && typeof item.updatedAt === "string";
    });
  } catch {
    return [];
  }
}

function formatTime(value: string, includeTime = true) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value || "时间未知";
  return new Intl.DateTimeFormat("zh-CN", includeTime
    ? { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }
    : { year: "numeric", month: "short", day: "numeric" }).format(date);
}

function shortHash(value: string) {
  return value ? value.slice(0, 10) : "无摘要";
}

function compactLength(value: string) {
  return value.replace(/\s/g, "").length;
}

type LibraryBucket = "已发布文章" | "平台成品" | "创作草稿" | "来源素材" | "研究与质检" | "能力与工具" | "证据与目录";

const LIBRARY_BUCKETS: LibraryBucket[] = ["已发布文章", "平台成品", "创作草稿", "来源素材", "研究与质检", "能力与工具", "证据与目录"];

// `view=library` 是只读语料索引，不是 WorkbenchArticle。尤其不能把它的
// `versionCount` 误当成可读取的 `versions`，也不能从索引记录推导 D1 身份。
type LibrarySlimItem = {
  id: string;
  title: string;
  canonicalTitle?: string;
  kind: string;
  summary?: string;
  tags: string[];
  platforms: string[];
  updatedAt: string;
  versionCount: number;
  editorialState?: string;
  publicationState?: string;
  classification: WorkbenchArticle["classification"];
  bucket?: string;
};

type LibrarySlimResponse = {
  items: LibrarySlimItem[];
  total: number;
  facets: Record<string, Record<string, number>>;
  page: number;
  hasMore: boolean;
  nextCursor: string | null;
};

const CORPUS_CLASS_LABELS: Record<WorkbenchArticle["classification"]["class"], string> = {
  published_article: "已发布文章",
  platform_build: "平台构建",
  import_artifact: "平台导入件",
  draft_or_intermediate: "创作草稿 / 中间稿",
  source_material: "来源素材",
  research_governance: "研究与治理",
  test_or_qa: "测试 / QA",
  skill_summary_or_capability: "Skill / 能力工件",
  tool: "创作工具",
  evidence: "证据",
  manifest_or_metadata: "Manifest / 元数据",
  catalog_only: "仅目录记录",
};

function libraryBucket(article: Pick<LibrarySlimItem, "classification" | "bucket">): LibraryBucket {
  if (article.bucket && LIBRARY_BUCKETS.includes(article.bucket as LibraryBucket)) return article.bucket as LibraryBucket;
  const className = article.classification.class;
  if (className === "published_article") return "已发布文章";
  if (["platform_build", "import_artifact"].includes(className)) return "平台成品";
  if (className === "draft_or_intermediate") return "创作草稿";
  if (className === "source_material") return "来源素材";
  if (["research_governance", "test_or_qa"].includes(className)) return "研究与质检";
  if (["skill_summary_or_capability", "tool"].includes(className)) return "能力与工具";
  return "证据与目录";
}

function queueBucketForArticle(article: WorkbenchArticle): "正式文章" | "创作中" {
  return ["published_article", "platform_build", "import_artifact"].includes(article.classification.class) ? "正式文章" : "创作中";
}

interface LineageNode {
  id: string;
  nodeType: string;
  label: string;
  classification?: WorkbenchArticle["classification"];
  sha256?: string;
  sourcePath?: string;
}

interface LineageEdge {
  id: string;
  relationType: string;
  source: string;
  target: string;
  status: "confirmed" | "suggested" | "rejected";
  basis: string;
  evidenceRefs: string[];
}

interface LineageSnapshot {
  seed: string;
  depth: number;
  nodes: LineageNode[];
  edges: LineageEdge[];
  evidence: Array<{ id: string; kind: string; sourcePath: string; locator: string | null; claim: string }>;
  truncated: boolean;
}

function gateRunIsStale(run: GateRun, copy: WorkingCopy | undefined) {
  if (!copy || run.branchId !== copy.branchId || run.revisionId !== copy.baseRevisionId) return true;
  const boundBodySha = typeof run.details.bodySha256 === "string" ? run.details.bodySha256 : "";
  const boundTitle = typeof run.details.documentTitle === "string" ? run.details.documentTitle : "";
  const boundRevisionId = typeof run.details.revisionId === "string" ? run.details.revisionId : "";
  return !boundBodySha || !boundTitle || !boundRevisionId
    || boundBodySha !== copy.bodySha256
    || boundTitle !== copy.title
    || boundRevisionId !== copy.baseRevisionId;
}

function nodeLabel(nodeId: string, article: WorkbenchArticle, revisions: ArticleRevision[]) {
  const [kind, id] = nodeId.split(":", 2);
  if (kind === "source") return article.versions.find((item) => item.id === id)?.name ?? id;
  if (kind === "revision") return revisions.find((item) => item.id === id)?.title ?? id;
  return id;
}

function workspaceEventSummary(event: WorkspaceEvent) {
  const labels: Record<string, string> = {
    "branch.created": "建立了工作分支",
    "revision.committed": "提交了不可变修订",
    "revision.merged": "合并了两个分支的修订",
    "working_copy.saved": "保存了工作副本",
    "work_item.created": "建立了工作项",
    "work_item.updated": "更新了工作项",
    "gate.completed": "完成了门禁检查",
    "capability.decision": "保存了能力成熟度决定",
    "production_run.created": "启动了生产运行",
    "production_step.updated": "更新了生产工位",
    "agent.task.created": "创建了 Agent 任务",
    "agent.progress": "Agent 汇报了进度",
    "agent.artifact.created": "Agent 提交了工件",
  };
  const payload = event.payload;
  const subjectLabels: Record<string, string> = {
    branch: "分支",
    revision: "修订",
    working_copy: "工作副本",
    work_item: "工作项",
    gate_run: "门禁检查",
    capability: "能力入口",
    production_run: "生产运行",
    production_step: "生产工位",
    agent_task: "Agent 任务",
    agent_artifact: "Agent 工件",
  };
  const from = typeof payload.from === "string" ? payload.from : typeof payload.previousState === "string" ? payload.previousState : "";
  const to = typeof payload.to === "string" ? payload.to : typeof payload.state === "string" ? payload.state : typeof payload.targetState === "string" ? payload.targetState : "";
  const actor = typeof payload.actor === "string" ? payload.actor : typeof payload.createdBy === "string" ? payload.createdBy : "本地系统或操作者";
  const transition = from && to ? `状态从“${from}”变为“${to}”` : to ? `当前状态为“${to}”` : "已记录这次操作";
  return {
    title: labels[event.eventType] ?? `记录了 ${event.eventType}`,
    summary: `${actor}操作了${subjectLabels[event.subjectType] ?? event.subjectType}；${transition}。`,
  };
}

function RevisionPreviewDialog({ revision, onClose }: { revision: ArticleRevision; onClose: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (typeof dialog.showModal === "function" && !dialog.open) dialog.showModal();
    else dialog.setAttribute("open", "");
    closeRef.current?.focus();
    return () => {
      if (dialog.open && typeof dialog.close === "function") dialog.close();
    };
  }, []);

  return <dialog ref={dialogRef} className="revision-preview-dialog" aria-modal="true" aria-labelledby="revision-preview-title" onCancel={(event) => { event.preventDefault(); onClose(); }}>
    <header><div><span className="eyebrow">工作区修订 · #{revision.sequence}</span><h2 id="revision-preview-title">{revision.title}</h2><p>{revision.documentTitle} · {revision.charCount.toLocaleString("zh-CN")} 字 · {formatTime(revision.createdAt)}</p></div><button ref={closeRef} aria-label="关闭修订预览" onClick={onClose}>×</button></header>
    <main><MarkdownPreview markdown={revision.bodyText ?? ""} empty="这个修订没有可显示的正文。" /></main>
    <footer><span>只读快览 · {shortHash(revision.bodySha256)} · 不会改动工作副本</span><button onClick={onClose}>关闭</button></footer>
  </dialog>;
}

export default function WorkbenchShell({
  corpus,
  capabilities,
  recipes,
}: {
  corpus: WorkbenchCorpus;
  capabilities: CapabilityIndex;
  recipes: FactoryRecipe[];
}) {
  const articleRelations = corpus.articleRelations;
  const [localArticleDirectory, setLocalArticleDirectory] = useState<LocalArticleDirectoryEntry[]>([]);
  const [identityCatalog, setIdentityCatalog] = useState<IdentityCatalog | null>(null);
  const [identityCatalogState, setIdentityCatalogState] = useState<"loading" | "ready" | "unavailable">("loading");
  const [identityPlan, setIdentityPlan] = useState<IdentityPlan | null>(null);
  const [sourceOwnerMismatches, setSourceOwnerMismatches] = useState<SourceOwnerMismatch[]>([]);
  const [sourceOwnerPlan, setSourceOwnerPlan] = useState<SourceOwnerPlan | null>(null);
  const [lineageAiStatus, setLineageAiStatus] = useState<LineageAiStatus | null>(null);
  const [lineageAiPreparation, setLineageAiPreparation] = useState<LineageAiPreparation | null>(null);
  const [lineageAiReviews, setLineageAiReviews] = useState<LineageAiReview[]>([]);
  const [staleIdentityOperations, setStaleIdentityOperations] = useState<StaleIdentityOperation[]>([]);
  const [lineageAiState, setLineageAiState] = useState<"idle" | "preparing" | "running">("idle");
  const [lineageAiMessage, setLineageAiMessage] = useState("");
  const [identityActionState, setIdentityActionState] = useState<"idle" | "scanning" | "planning" | "applying">("idle");
  const [identityActionError, setIdentityActionError] = useState("");
  const [workspaceRestored, setWorkspaceRestored] = useState(false);
  const localArticles = useMemo(() => localArticleDirectory.map(localArticleFromDirectory), [localArticleDirectory]);
  const workspaceArticles = useMemo(() => [
    ...localArticles,
    ...corpus.articles.filter((article) => !localArticles.some((local) => local.id === article.id)),
  ], [corpus.articles, localArticles]);
  const confirmedImportMembers = useMemo(() => new Set(articleRelations
    .filter((relation) => relation.status === "confirmed" && relation.relationType === "import_artifact_of")
    .map((relation) => relation.sourceArticleId)), [articleRelations]);
  const articleWorks = useMemo(() => workspaceArticles.filter((article) =>
    ["published_article", "platform_build", "import_artifact", "draft_or_intermediate"].includes(article.classification.class)
      && !confirmedImportMembers.has(article.id)), [confirmedImportMembers, workspaceArticles]);
  const corpusArticleById = useMemo(() => new Map(workspaceArticles.map((article) => [article.id, article])), [workspaceArticles]);
  const articleRelationsByArticle = useMemo(() => {
    const result = new Map<string, typeof articleRelations>();
    for (const relation of articleRelations) {
      result.set(relation.sourceArticleId, [...(result.get(relation.sourceArticleId) ?? []), relation]);
      result.set(relation.targetArticleId, [...(result.get(relation.targetArticleId) ?? []), relation]);
    }
    return result;
  }, [articleRelations]);
  const pendingArticleRelations = useMemo(() => articleRelations
    .filter((relation) => relation.status === "suggested"
      && corpusArticleById.has(relation.sourceArticleId)
      && corpusArticleById.has(relation.targetArticleId))
    .slice(0, 60), [articleRelations, corpusArticleById]);
  const initialArticle = articleWorks.find((article) => article.versionCount > 1) ?? articleWorks[0] ?? workspaceArticles[0];
  const [view, setView] = useState<WorkspaceView>("project");
  const [rsiSummary, setRsiSummary] = useState<RsiSummary | null>(null);
  const [rsiSummaryUnavailable, setRsiSummaryUnavailable] = useState(false);
  const [selectedArticleId, setSelectedArticleId] = useState(initialArticle?.id ?? "");
  const [articleNavigation, setArticleNavigation] = useState<{ articleId: string; destination: WorkspaceView; requestId: string } | null>(null);
  const [selectedBranchId, setSelectedBranchId] = useState("");
  const [workspace, setWorkspace] = useState<WorkspaceSnapshot>(EMPTY_WORKSPACE);
  const [workspaceState, setWorkspaceState] = useState<"loading" | "ready" | "unavailable">("loading");
  const [articleQuery, setArticleQuery] = useState("");
  const [queueBucket, setQueueBucket] = useState<"all" | "正式文章" | "创作中">("all");
  const [queuePlatform, setQueuePlatform] = useState("all");
  const [queueTag, setQueueTag] = useState("all");
  const [libraryBucketFilter, setLibraryBucketFilter] = useState<"all" | LibraryBucket>("all");
  const [libraryKind, setLibraryKind] = useState("all");
  const [libraryState, setLibraryState] = useState("all");
  const [libraryPlatform, setLibraryPlatform] = useState("all");
  const [libraryMode, setLibraryMode] = useState<"shelves" | "lineage">("shelves");
  const [libraryPageState, setLibraryPageState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [libraryCurrentCursor, setLibraryCurrentCursor] = useState<string | null>(null);
  const [libraryCursorHistory, setLibraryCursorHistory] = useState<Array<string | null>>([]);
  const [libraryRemotePage, setLibraryRemotePage] = useState<LibrarySlimResponse | null>(null);
  const [libraryRemoteError, setLibraryRemoteError] = useState("");
  const [lineageSeed, setLineageSeed] = useState(initialArticle?.id ?? "");
  const [lineageDepth, setLineageDepth] = useState(2);
  const [lineageStatusFilter, setLineageStatusFilter] = useState<"all" | "confirmed" | "suggested">("all");
  const [lineageRelationFilter, setLineageRelationFilter] = useState("all");
  const [lineageSnapshot, setLineageSnapshot] = useState<LineageSnapshot | null>(null);
  const [lineageState, setLineageState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [lineageError, setLineageError] = useState("");
  const [toast, setToast] = useState("");
  const [operationError, setOperationError] = useState("");
  const [editorBranchId, setEditorBranchId] = useState("");
  const [documentTitle, setDocumentTitle] = useState("");
  const [bodyText, setBodyText] = useState("");
  const [workingNote, setWorkingNote] = useState("");
  const [saveState, setSaveState] = useState<"idle" | "dirty" | "saving" | "saved" | "error">("idle");
  const [editorMode, setEditorMode] = useState<"write" | "split" | "preview">("split");
  const [branchPanelOpen, setBranchPanelOpen] = useState(false);
  const [branchName, setBranchName] = useState("main");
  const [branchBase, setBranchBase] = useState("");
  const [branchAnnotation, setBranchAnnotation] = useState("");
  const [commitOpen, setCommitOpen] = useState(false);
  const [revisionTitle, setRevisionTitle] = useState("");
  const [revisionAnnotation, setRevisionAnnotation] = useState("");
  const [selectedNodeId, setSelectedNodeId] = useState("");
  const [revisionPreviewId, setRevisionPreviewId] = useState("");
  const [diffLeftId, setDiffLeftId] = useState("");
  const [diffRightId, setDiffRightId] = useState("");
  const [diffResult, setDiffResult] = useState<ReturnType<typeof diffBlocks>>([]);
  const [diffLoading, setDiffLoading] = useState(false);
  const [mergeSourceBranchId, setMergeSourceBranchId] = useState("");
  const [mergeTargetBranchId, setMergeTargetBranchId] = useState("");
  const [selectedMergeProposalId, setSelectedMergeProposalId] = useState("");
  const [mergeResolutionTitle, setMergeResolutionTitle] = useState("");
  const [mergeResolutionBody, setMergeResolutionBody] = useState("");
  const [mergeResolutionNote, setMergeResolutionNote] = useState("");
  const [mergeConfirmed, setMergeConfirmed] = useState(false);
  const [mergeResolutionDirty, setMergeResolutionDirty] = useState(false);
  const [mergeRevisionTitle, setMergeRevisionTitle] = useState("合并修订");
  const [workFilter, setWorkFilter] = useState<"all" | "article">("all");
  const [newWorkOpen, setNewWorkOpen] = useState(false);
  const [newWorkTitle, setNewWorkTitle] = useState("");
  const [newWorkStage, setNewWorkStage] = useState<WorkStage>("inbox");
  const [capabilityQuery, setCapabilityQuery] = useState("");
  const [capabilityKind, setCapabilityKind] = useState("all");
  const [capabilityDimension, setCapabilityDimension] = useState("all");
  const [capabilityMaturity, setCapabilityMaturity] = useState("all");
  const [capabilityView, setCapabilityView] = useState<"table" | "flow">("flow");
  const [selectedCapabilityId, setSelectedCapabilityId] = useState(capabilities.capabilities[0]?.id ?? "");
  const [capStatus, setCapStatus] = useState<CapabilityAdoption>("unassessed");
  const [capNotes, setCapNotes] = useState("");
  const [capEvidence, setCapEvidence] = useState("");
  const [capRegression, setCapRegression] = useState("");
  const [capFavorite, setCapFavorite] = useState(false);
  const [selectedRecipeId, setSelectedRecipeId] = useState(recipes[0]?.id ?? "");
  const [stepEvidence, setStepEvidence] = useState<Record<string, string>>({});
  const [storageProbe, setStorageProbe] = useState<"idle" | "running" | "pass" | "fail">("idle");
  const [evidenceView, setEvidenceView] = useState<"guide" | "events" | "gates" | "sources">("guide");
  const [runnerSnapshot, setRunnerSnapshot] = useState<RunnerSnapshot>(EMPTY_RUNNERS);
  const [runnerState, setRunnerState] = useState<"loading" | "ready" | "unavailable">("loading");
  const [runnerLabel, setRunnerLabel] = useState("本机文字门禁 Runner");
  const [issuedRunner, setIssuedRunner] = useState<{ runnerId: string; token: string } | null>(null);
  const editorRef = useRef({ title: "", body: "", note: "" });
  const sourceTextCache = useRef(new Map<string, string>());
  const libraryAbortRef = useRef<AbortController | null>(null);
  const libraryRequestEpochRef = useRef(0);
  const rsiSummaryAbortRef = useRef<AbortController | null>(null);
  const rsiSummaryRequestEpochRef = useRef(0);

  const selectedArticle = workspaceArticles.find((article) => article.id === selectedArticleId) ?? initialArticle;
  const activeBranch = workspace.branches.find((branch) => branch.id === selectedBranchId) ?? workspace.branches[0];
  const activeCopy = workspace.workingCopies.find((copy) => copy.branchId === activeBranch?.id);
  const articleRevisions = useMemo(() => workspace.revisions.filter((revision) => revision.articleId === selectedArticle?.id), [selectedArticle?.id, workspace.revisions]);
  const previewRevision = articleRevisions.find((revision) => revision.id === revisionPreviewId);
  const reviewTarget = useMemo<ReviewTarget>(() => {
    const identity = identityCatalog?.localArticles.find((item) => item.articleId === selectedArticle?.id && item.catalogState === "active");
    const projectBindings = [...new Set(localArticleDirectory
      .filter((item) => item.articleId === selectedArticle?.id && item.packageId === identity?.packageId && item.projectId)
      .map((item) => item.projectId!))];
    const revision = articleRevisions.find((item) => item.id === activeBranch?.headRevisionId);
    if (!identity || identity.packageStatus !== "active" || !identity.packageId || !selectedArticle || !activeBranch || activeBranch.status !== "active" || activeBranch.articleId !== selectedArticle.id || !revision || revision.id !== activeBranch.headRevisionId || revision.articleId !== selectedArticle.id || revision.branchId !== activeBranch.id || revision.bodySha256 !== activeBranch.headBodySha256) return null;
    return { articleId: selectedArticle.id, projectId: projectBindings.length === 1 ? projectBindings[0] : null, packageId: identity.packageId, branchId: activeBranch.id, revisionId: revision.id, bodySha256: revision.bodySha256, dirtyWorkingCopy: Boolean(activeCopy?.dirty) };
  }, [activeBranch, activeCopy?.dirty, articleRevisions, identityCatalog?.localArticles, localArticleDirectory, selectedArticle]);
  const activeGateRuns = workspace.gateRuns.filter((run) => run.branchId === activeBranch?.id);
  const activeWorkItems = workspace.workItems.filter((item) => item.articleId === selectedArticle?.id && item.state !== "cancelled");
  const selectedMergeProposal = workspace.mergeProposals.find((proposal) => proposal.id === selectedMergeProposalId)
    ?? workspace.mergeProposals.find((proposal) => !["merged", "cancelled"].includes(proposal.status))
    ?? workspace.mergeProposals[0];

  const showToast = useCallback((message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(""), 2800);
  }, []);
  const refreshRsiSummary = useCallback(async () => {
    rsiSummaryAbortRef.current?.abort();
    const controller = new AbortController();
    rsiSummaryAbortRef.current = controller;
    const requestEpoch = ++rsiSummaryRequestEpochRef.current;
    try {
      const response = await managementFetch("/api/annotation-rsi/v1?view=proposal-summary", { cache: "no-store", signal: controller.signal });
      const payload = await response.json() as { ok?: boolean; data?: RsiSummary };
      if (!response.ok || payload.ok === false || !payload.data) throw new Error("待审状态暂不可用");
      if (requestEpoch !== rsiSummaryRequestEpochRef.current || controller.signal.aborted) return;
      setRsiSummary(payload.data);
      setRsiSummaryUnavailable(false);
    } catch {
      if (requestEpoch !== rsiSummaryRequestEpochRef.current || controller.signal.aborted) return;
      setRsiSummary(null);
      setRsiSummaryUnavailable(true);
    }
  }, []);
  useEffect(() => {
    const initialRefresh = window.setTimeout(() => void refreshRsiSummary(), 0);
    return () => {
      window.clearTimeout(initialRefresh);
      rsiSummaryAbortRef.current?.abort();
    };
  }, [refreshRsiSummary]);

  const loadLibraryPage = useCallback(async (cursor: string | null, cursorHistory: Array<string | null>, requestedPage: number) => {
    libraryAbortRef.current?.abort();
    const controller = new AbortController();
    libraryAbortRef.current = controller;
    const requestEpoch = ++libraryRequestEpochRef.current;
    setLibraryPageState("loading"); setLibraryRemoteError("");
    try {
      const query = new URLSearchParams({ view: "library", limit: "24", q: articleQuery, bucket: libraryBucketFilter, kind: libraryKind, state: libraryState, platform: libraryPlatform });
      if (cursor) query.set("cursor", cursor);
      const response = await managementFetch(`/api/corpus/v1?${query}`, { cache: "no-store", signal: controller.signal });
      const payload = await response.json() as { data?: LibrarySlimResponse; error?: { message?: string } };
      if (!response.ok || !payload.data) throw new Error(payload.error?.message || "资料库读取失败");
      if (requestEpoch !== libraryRequestEpochRef.current || controller.signal.aborted) return;
      setLibraryRemotePage({
        ...payload.data,
        items: payload.data.items.slice(0, 24), // 替换页而非叠加完整卡片，守住 DOM / 按钮预算。
        page: payload.data.page || requestedPage,
      });
      setLibraryCurrentCursor(cursor);
      setLibraryCursorHistory(cursorHistory);
      setLibraryPageState("ready");
    } catch (error) {
      if (requestEpoch !== libraryRequestEpochRef.current || controller.signal.aborted) return;
      setLibraryPageState("error"); setLibraryRemoteError(error instanceof Error ? error.message : "资料库读取失败");
    }
  }, [articleQuery, libraryBucketFilter, libraryKind, libraryPlatform, libraryState]);

  useEffect(() => {
    if (view !== "library" || libraryMode !== "shelves" || libraryPageState !== "idle") return;
    const timer = window.setTimeout(() => void loadLibraryPage(null, [], 1), 0); // 首次进入才请求；正文仍由阅读器按需加载。
    return () => window.clearTimeout(timer);
  }, [libraryMode, libraryPageState, loadLibraryPage, view]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      libraryAbortRef.current?.abort(); ++libraryRequestEpochRef.current;
      setLibraryPageState("idle"); setLibraryCurrentCursor(null); setLibraryCursorHistory([]); setLibraryRemotePage(null);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [articleQuery, libraryBucketFilter, libraryKind, libraryPlatform, libraryState]);

  const loadLineage = useCallback(async () => {
    if (!lineageSeed) return;
    setLineageState("loading");
    setLineageError("");
    try {
      const query = new URLSearchParams({
        view: "lineage",
        seed: lineageSeed,
        depth: String(lineageDepth),
        limit: "180",
        status: lineageStatusFilter,
      });
      if (lineageRelationFilter !== "all") query.set("relationType", lineageRelationFilter);
      const response = await fetch(`/api/corpus/v1?${query}`, { cache: "no-store" });
      const payload = await response.json() as { ok?: boolean; data?: LineageSnapshot; error?: { message?: string } };
      if (!response.ok || payload.ok === false || !payload.data) throw new Error(payload.error?.message || "开发树读取失败");
      setLineageSnapshot(payload.data);
      setLineageState("ready");
    } catch (caught) {
      setLineageState("error");
      setLineageError(caught instanceof Error ? caught.message : "开发树读取失败");
    }
  }, [lineageDepth, lineageRelationFilter, lineageSeed, lineageStatusFilter]);

  useEffect(() => {
    if (libraryMode !== "lineage" || !lineageSeed) return;
    const timer = window.setTimeout(() => void loadLineage(), 0);
    return () => window.clearTimeout(timer);
  }, [libraryMode, lineageSeed, loadLineage]);

  const postWorkspace = useCallback(async (action: string, payload: Record<string, unknown> = {}) => {
    setOperationError("");
    const response = await managementFetch("/api/workspace", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action, ...payload }),
    });
    const result = await response.json() as Record<string, unknown>;
    if (!response.ok) {
      const message = typeof result.error === "string" ? result.error : "操作失败";
      setOperationError(message);
      throw new Error(message);
    }
    return result;
  }, []);

  const loadRunnerState = useCallback(async (articleId: string) => {
    if (!articleId) return;
    setRunnerState("loading");
    try {
      const response = await managementFetch(`/api/runner?articleId=${encodeURIComponent(articleId)}`, { cache: "no-store" });
      const payload = await response.json() as RunnerSnapshot;
      if (!response.ok) throw new Error(payload.error || "Runner 控制面不可用");
      setRunnerSnapshot(payload);
      setRunnerState("ready");
    } catch (error) {
      setRunnerSnapshot(EMPTY_RUNNERS);
      setRunnerState("unavailable");
      setOperationError(error instanceof Error ? error.message : "Runner 控制面不可用");
    }
  }, []);

  const postRunner = useCallback(async (action: string, payload: Record<string, unknown> = {}) => {
    setOperationError("");
    const response = await managementFetch("/api/runner", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action, ...payload }),
    });
    const result = await response.json() as Record<string, unknown>;
    if (!response.ok) {
      const message = typeof result.error === "string" ? result.error : "Runner 操作失败";
      setOperationError(message);
      throw new Error(message);
    }
    return result;
  }, []);

  const loadWorkspace = useCallback(async (articleId: string, preferredBranchId?: string) => {
    if (!articleId) return;
    setWorkspaceState("loading");
    try {
      const response = await managementFetch(`/api/workspace?articleId=${encodeURIComponent(articleId)}`, { cache: "no-store" });
      const payload = await response.json() as WorkspaceSnapshot;
      if (!response.ok) throw new Error(payload.error || "工作区不可用");
      setWorkspace(payload);
      setWorkspaceState("ready");
      void loadRunnerState(articleId);
      setSelectedBranchId((current) => {
        const desired = preferredBranchId || current;
        return payload.branches.some((branch) => branch.id === desired) ? desired : payload.branches[0]?.id ?? "";
      });
    } catch (error) {
      setWorkspace(EMPTY_WORKSPACE);
      setWorkspaceState("unavailable");
      setOperationError(error instanceof Error ? error.message : "工作区不可用");
    }
  }, [loadRunnerState]);

  const rememberLocalArticle = useCallback(async (entry: LocalArticleDirectoryEntry) => {
    setLocalArticleDirectory((current) => {
      const next = [entry, ...current.filter((item) => item.articleId !== entry.articleId)]
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
        .slice(0, 100);
      window.localStorage.setItem(LOCAL_ARTICLE_DIRECTORY_KEY, JSON.stringify(next));
      return next;
    });
    window.localStorage.setItem("wenmai:last-article", entry.articleId);
    window.localStorage.setItem(`wenmai:branch:${entry.articleId}`, entry.branchId);
    setSelectedArticleId(entry.articleId);
    setSelectedBranchId(entry.branchId);
    setView("project");
    await loadWorkspace(entry.articleId, entry.branchId);
  }, [loadWorkspace]);

  const discoverLocalArticles = useCallback(async () => {
    setIdentityCatalogState("loading");
    try {
      const [response, ownerResponse, integrityResponse, lineageAiResponse, lineageReviewResponse] = await Promise.all([
        managementFetch("/api/article-identity/v1?view=catalog&limit=200", { cache: "no-store" }),
        managementFetch("/api/article-identity/v1?view=source_owner_mismatches", { cache: "no-store" }),
        managementFetch("/api/article-identity/v1?view=integrity", { cache: "no-store" }),
        managementFetch("/api/article-lineage-ai/v1?view=status", { cache: "no-store" }),
        managementFetch("/api/article-lineage-ai/v1?view=reviews&limit=50", { cache: "no-store" }),
      ]);
      const payload = await response.json() as { ok?: boolean; data?: IdentityCatalog; error?: { message?: string } };
      if (!response.ok || payload.ok === false || !payload.data || !Array.isArray(payload.data.localArticles)) {
        throw new Error(payload.error?.message || "文章身份目录不可用");
      }
      const ownerPayload = await ownerResponse.json() as {
        ok?: boolean;
        data?: { sourceOwnerMismatches?: SourceOwnerMismatch[] };
        error?: { message?: string };
      };
      setSourceOwnerMismatches(ownerResponse.ok && ownerPayload.ok !== false && Array.isArray(ownerPayload.data?.sourceOwnerMismatches)
        ? ownerPayload.data.sourceOwnerMismatches
        : []);
      if (!ownerResponse.ok || ownerPayload.ok === false) {
        setIdentityActionError(ownerPayload.error?.message || "语料归属扫描暂不可用");
      }
      const integrityPayload = await integrityResponse.json() as {
        ok?: boolean;
        data?: { stalePlannedOperations?: StaleIdentityOperation[] };
      };
      setStaleIdentityOperations(integrityResponse.ok && integrityPayload.ok !== false
        && Array.isArray(integrityPayload.data?.stalePlannedOperations)
        ? integrityPayload.data.stalePlannedOperations : []);
      const lineageAiPayload = await lineageAiResponse.json() as {
        ok?: boolean;
        data?: LineageAiStatus;
      };
      setLineageAiStatus(lineageAiResponse.ok && lineageAiPayload.ok !== false && lineageAiPayload.data
        ? lineageAiPayload.data
        : null);
      const lineageReviewPayload = await lineageReviewResponse.json() as {
        ok?: boolean;
        data?: { reviews?: LineageAiReview[] };
      };
      setLineageAiReviews(lineageReviewResponse.ok && lineageReviewPayload.ok !== false
        && Array.isArray(lineageReviewPayload.data?.reviews) ? lineageReviewPayload.data.reviews : []);
      const catalog = payload.data;
      setIdentityCatalog(catalog);
      setIdentityCatalogState("ready");
      const discovered = catalog.localArticles
        .filter((item) => item.catalogState === "active"
          && item.articleId.startsWith("local-article-")
          && item.packageStatus === "active"
          && item.packageId && item.primaryBranchId && item.headRevisionId && item.headBodySha256)
        .map((item): LocalArticleDirectoryEntry => ({
          schemaVersion: "wenmai-local-article/1.0",
          articleId: item.articleId,
          projectId: null,
          packageId: item.packageId!,
          title: item.title,
          branchId: item.primaryBranchId!,
          revisionId: item.headRevisionId!,
          bodySha256: item.headBodySha256!,
          charCount: item.revisions.find((revision) => revision.id === item.headRevisionId)?.charCount ?? 0,
          revisionCount: item.revisionCount,
          branchCount: item.branchCount,
          activeBranchCount: item.activeBranchCount,
          archivedBranchCount: item.archivedBranchCount,
          unmergedBranchCount: item.unmergedBranchCount,
          dirtyWorkingCopyCount: item.dirtyWorkingCopyCount,
          identityId: item.identityId,
          canonicalArticleId: item.canonicalArticleId,
          identityRole: item.identityRole,
          catalogState: item.catalogState,
          legacyRootCount: item.legacyRootCount,
          identityMemberCount: item.identityMemberCount,
          pendingCandidateCount: item.pendingCandidateCount,
          revisions: item.revisions,
          createdAt: item.createdAt ?? item.updatedAt ?? new Date(0).toISOString(),
          updatedAt: item.updatedAt ?? item.createdAt ?? new Date(0).toISOString(),
        }));
      setLocalArticleDirectory((current) => {
        // Identity discovery proves the Article/Package pair but does not return
        // an ArticleProject. Preserve only a previously recorded matching pair;
        // it must never be inferred from an RSI queue item.
        const projectByArticlePackage = new Map(current
          .filter((entry) => entry.projectId)
          .map((entry) => [`${entry.articleId}\u0000${entry.packageId}`, entry.projectId!]));
        const next = discovered.map((entry) => ({
          ...entry,
          projectId: projectByArticlePackage.get(`${entry.articleId}\u0000${entry.packageId}`) ?? null,
        }))
          .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
          .slice(0, 100);
        window.localStorage.setItem(LOCAL_ARTICLE_DIRECTORY_KEY, JSON.stringify(next));
        return next;
      });
      const activeArticleIds = new Set(discovered.map((entry) => entry.articleId));
      const catalogByArticleId = new Map(catalog.localArticles.map((entry) => [entry.articleId, entry]));
      setSelectedArticleId((current) => {
        if (!current.startsWith("local-article-") || activeArticleIds.has(current)) return current;
        const redirect = catalogByArticleId.get(current)?.canonicalRedirect?.articleId;
        return redirect && activeArticleIds.has(redirect) ? redirect : discovered[0]?.articleId ?? current;
      });
    } catch {
      // The cached pointer directory remains usable when D1 discovery is temporarily unavailable.
      setSourceOwnerMismatches([]);
      setLineageAiStatus(null);
      setLineageAiReviews([]);
      setStaleIdentityOperations([]);
      setIdentityCatalogState("unavailable");
    }
  }, []);

  const postIdentityAction = useCallback(async (action: string, payload: Record<string, unknown>) => {
    const response = await managementFetch("/api/article-identity/v1", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action, commandId: `identity-ui:${crypto.randomUUID()}`, payload }),
    });
    const result = await response.json() as { ok?: boolean; data?: Record<string, unknown>; error?: { message?: string } };
    if (!response.ok || result.ok === false || !result.data) {
      throw new Error(result.error?.message || `文章身份操作失败（HTTP ${response.status}）`);
    }
    return result.data;
  }, []);

  const postLineageAiAction = useCallback(async (
    action: "prepare_review" | "run_review",
    payload: Record<string, unknown>,
    commandId = `lineage-ai-ui:${crypto.randomUUID()}`,
  ) => {
    const response = await managementFetch("/api/article-lineage-ai/v1", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action, commandId, payload }),
    });
    const result = await response.json() as { ok?: boolean; data?: Record<string, unknown>; error?: { message?: string } };
    if (!response.ok || result.ok === false || !result.data) {
      throw new Error(result.error?.message || `DeepSeek 候选审阅失败（HTTP ${response.status}）`);
    }
    return result.data;
  }, []);

  const prepareLineageAiReview = useCallback(async (candidate: IdentityCandidate) => {
    if (lineageAiState !== "idle") return;
    setLineageAiState("preparing");
    setLineageAiMessage("");
    setLineageAiPreparation(null);
    try {
      const data = await postLineageAiAction("prepare_review", {
        candidateId: candidate.id,
        expectedCandidateLockVersion: candidate.lockVersion,
      });
      const budget = data.budgetEstimate as LineageAiPreparation["budgetEstimate"] | undefined;
      const preparationId = String(data.preparationId ?? "");
      const inputSha = String(data.inputSha ?? "");
      if (!preparationId || !/^[a-f0-9]{64}$/.test(inputSha) || !budget) {
        throw new Error("DeepSeek 审阅准备回执不完整");
      }
      setLineageAiPreparation({
        preparationId,
        candidateId: candidate.id,
        expectedCandidateLockVersion: candidate.lockVersion,
        inputSha,
        inputTokenEstimate: Number(data.inputTokenEstimate ?? 0),
        budgetEstimate: budget,
        runCommandId: `lineage-ai-run:${crypto.randomUUID()}`,
      });
      setLineageAiMessage("候选输入已冻结在本地；尚未调用模型，也尚未产生费用。");
    } catch (error) {
      setLineageAiMessage(error instanceof Error ? error.message : "DeepSeek 审阅准备失败");
    } finally {
      setLineageAiState("idle");
    }
  }, [lineageAiState, postLineageAiAction]);

  const runLineageAiReview = useCallback(async () => {
    if (!lineageAiPreparation || lineageAiState !== "idle") return;
    const budget = lineageAiPreparation.budgetEstimate;
    const maxYuan = budget.maxCostCnyMicros / 1_000_000;
    if (!window.confirm(`确认把这组候选的有界差异摘要发送给 DeepSeek 审阅？\n\n模型只会给出候选建议，不会合并、归档或修改正文。\n本次本地费用硬上限：¥${maxYuan.toFixed(2)}；实际供应商费用尚不可从当前网关确认。`)) return;
    setLineageAiState("running");
    setLineageAiMessage("");
    try {
      const data = await postLineageAiAction("run_review", {
        candidateId: lineageAiPreparation.candidateId,
        expectedCandidateLockVersion: lineageAiPreparation.expectedCandidateLockVersion,
        inputSha: lineageAiPreparation.inputSha,
        maxInputTokens: budget.maxInputTokens,
        maxOutputTokens: budget.maxOutputTokens,
        maxCostCnyMicros: budget.maxCostCnyMicros,
      }, lineageAiPreparation.runCommandId);
      const output = data.output as LineageAiReview["output"];
      setLineageAiMessage(output
        ? `DeepSeek 候选建议：${output.relationRecommendation} · 置信度 ${(output.confidence * 100).toFixed(0)}% · 下一步 ${output.nextStep}`
        : "DeepSeek 已返回候选记录，但这次响应没有可显示的建议。");
      setLineageAiPreparation(null);
      await discoverLocalArticles();
    } catch (error) {
      setLineageAiMessage(error instanceof Error ? error.message : "DeepSeek 候选审阅失败；系统不会自动重试");
    } finally {
      setLineageAiState("idle");
    }
  }, [discoverLocalArticles, lineageAiPreparation, lineageAiState, postLineageAiAction]);

  const scanIdentityCandidates = useCallback(async () => {
    if (!identityCatalog || identityActionState !== "idle") return;
    setIdentityActionState("scanning");
    setIdentityActionError("");
    setIdentityPlan(null);
    try {
      const articleIds = identityCatalog.localArticles
        .filter((article) => article.catalogState === "active")
        .map((article) => article.articleId);
      const result = await postIdentityAction("scan_candidates", { articleIds, threshold: 0.86 });
      await discoverLocalArticles();
      showToast(`相似关系扫描找到 ${Number(result.insertedCandidateCount ?? 0)} 个待确认候选。`);
    } catch (error) {
      setIdentityActionError(error instanceof Error ? error.message : "相似性扫描失败");
    } finally {
      setIdentityActionState("idle");
    }
  }, [discoverLocalArticles, identityActionState, identityCatalog, postIdentityAction, showToast]);

  const planIdentityCandidate = useCallback(async (candidate: IdentityCandidate) => {
    if (!identityCatalog || identityActionState !== "idle") return;
    const legacy = identityCatalog.localArticles.find((article) => article.articleId === candidate.sourceArticleId);
    const canonical = identityCatalog.localArticles.find((article) => article.articleId === candidate.targetArticleId);
    if (!legacy?.packageId || !legacy.primaryBranchId || !canonical?.packageId || !canonical.primaryBranchId) {
      setIdentityActionError("候选两端缺少可审计的 Package / Branch，不能生成清理计划");
      return;
    }
    setIdentityActionState("planning");
    setIdentityActionError("");
    try {
      const data = await postIdentityAction("plan_consolidation", {
        candidateId: candidate.id,
        canonicalArticleId: canonical.articleId,
        legacyArticleId: legacy.articleId,
        canonicalPackageId: canonical.packageId,
        legacyPackageId: legacy.packageId,
        canonicalBranchId: canonical.primaryBranchId,
        legacyBranchId: legacy.primaryBranchId,
        canonicalRevisionId: candidate.targetRevisionId,
        legacyRevisionId: candidate.sourceRevisionId,
        expectedCanonicalBodySha256: candidate.targetBodySha256,
        expectedLegacyBodySha256: candidate.sourceBodySha256,
        title: canonical.title,
        evidence: [
          "human-reviewed:article-identity-console",
          `deterministic-score:${candidate.score ?? "unknown"}`,
          `candidate-lock:${candidate.lockVersion}`,
        ],
      });
      const operationId = String(data.operationId ?? "");
      const planSha256 = String(data.planSha256 ?? "");
      if (!operationId || !/^[a-f0-9]{64}$/.test(planSha256)) throw new Error("整理计划回执缺少 operationId 或 planSha256");
      setIdentityPlan({ operationId, planSha256, candidateId: candidate.id,
        canonicalArticleId: canonical.articleId, legacyArticleId: legacy.articleId });
      showToast("已生成可回滚的整理计划；文章列表尚未改变。");
    } catch (error) {
      setIdentityActionError(error instanceof Error ? error.message : "整理计划生成失败");
    } finally {
      setIdentityActionState("idle");
    }
  }, [identityActionState, identityCatalog, postIdentityAction, showToast]);

  const applyIdentityPlan = useCallback(async () => {
    if (!identityPlan || identityActionState !== "idle") return;
    const canonical = identityCatalog?.localArticles.find((article) => article.articleId === identityPlan.canonicalArticleId);
    const legacy = identityCatalog?.localArticles.find((article) => article.articleId === identityPlan.legacyArticleId);
    if (!window.confirm(`确认把“${legacy?.title ?? identityPlan.legacyArticleId}”转为“${canonical?.title ?? identityPlan.canonicalArticleId}”的可追溯旧根？\n\n旧 Revision 会保留，旧 Package/Branch 会归档，不会改写任何发布记录。`)) return;
    setIdentityActionState("applying");
    setIdentityActionError("");
    try {
      await postIdentityAction("apply_consolidation", {
        operationId: identityPlan.operationId,
        expectedPlanSha256: identityPlan.planSha256,
      });
      setIdentityPlan(null);
      await discoverLocalArticles();
      showToast("已整理文章身份：旧根已转入审计，当前根与发布记录未改动。");
    } catch (error) {
      setIdentityActionError(error instanceof Error ? error.message : "整理计划应用失败");
    } finally {
      setIdentityActionState("idle");
    }
  }, [discoverLocalArticles, identityActionState, identityCatalog, identityPlan, postIdentityAction, showToast]);

  const planSourceOwnerRepair = useCallback(async (mismatch: SourceOwnerMismatch) => {
    if (identityActionState !== "idle") return;
    setIdentityActionState("planning");
    setIdentityActionError("");
    setSourceOwnerPlan(null);
    try {
      const data = await postIdentityAction("plan_source_owner_repair", {
        sourceBranchId: mismatch.sourceBranchId,
        sourceRevisionId: mismatch.sourceRevisionId,
        expectedSourceArticleId: mismatch.sourceArticleId,
        targetArticleId: mismatch.currentOwnerArticleId,
        sourceVersionId: mismatch.sourceVersionId,
        expectedBodySha256: mismatch.sourceBodySha256,
        evidence: [
          "human-reviewed:source-owner-console",
          `corpus-owner:${mismatch.sourceVersionId}->${mismatch.currentOwnerArticleId}`,
          `body-sha:${mismatch.sourceBodySha256}`,
          `working-copy-lock:${mismatch.lock.workingCopyLockVersion ?? "missing"}`,
        ],
      });
      const operationId = String(data.operationId ?? "");
      const planSha256 = String(data.planSha256 ?? "");
      if (!operationId || !/^[a-f0-9]{64}$/.test(planSha256)) {
        throw new Error("归属修复计划回执缺少 operationId 或 planSha256");
      }
      setSourceOwnerPlan({ operationId, planSha256, mismatch });
      showToast("语料归属修复计划已冻结；尚未移动 Branch 或 Revision。");
    } catch (error) {
      setIdentityActionError(error instanceof Error ? error.message : "语料归属修复计划生成失败");
    } finally {
      setIdentityActionState("idle");
    }
  }, [identityActionState, postIdentityAction, showToast]);

  const applySourceOwnerRepair = useCallback(async () => {
    if (!sourceOwnerPlan || identityActionState !== "idle") return;
    const mismatch = sourceOwnerPlan.mismatch;
    if (!window.confirm(`确认修复这条语料归属？\n\n当前：${mismatch.sourceArticleId}\n正确归属：${mismatch.currentOwnerTitle}\n\n原 Revision 会原样保留；系统会在正确 Article 下复制一条不可变 Revision 与 clean Branch，再归档错绑 Branch。`)) return;
    setIdentityActionState("applying");
    setIdentityActionError("");
    try {
      await postIdentityAction("apply_source_owner_repair", {
        operationId: sourceOwnerPlan.operationId,
        expectedPlanSha256: sourceOwnerPlan.planSha256,
      });
      setSourceOwnerPlan(null);
      await discoverLocalArticles();
      showToast("已修复语料归属：原 Revision 已保留，错绑 Branch 已归档。");
    } catch (error) {
      setIdentityActionError(error instanceof Error ? error.message : "语料归属修复应用失败");
    } finally {
      setIdentityActionState("idle");
    }
  }, [discoverLocalArticles, identityActionState, postIdentityAction, showToast, sourceOwnerPlan]);

  const supersedeStaleIdentityOperation = useCallback(async (operation: StaleIdentityOperation) => {
    if (identityActionState !== "idle") return;
    if (!window.confirm(`确认把这条已被后续事实取代的整理计划标为“已替代”？\n\n计划、摘要与审计行会完整保留；不会再次合并、归档或删除任何文章。\n${operation.operationId}`)) return;
    setIdentityActionState("applying");
    setIdentityActionError("");
    try {
      await postIdentityAction("supersede_stale_operation", {
        operationId: operation.operationId,
        expectedPlanSha256: operation.planSha256,
        expectedLockVersion: operation.lockVersion,
        evidence: [
          "human-reviewed:identity-integrity-console",
          `candidate:${operation.candidateId}`,
          operation.terminalProof.appliedOperation
            ? `applied-operation:${operation.terminalProof.appliedOperation.operationId}`
            : `terminal-candidate:${operation.terminalProof.candidate?.status ?? "unknown"}`,
        ],
      });
      await discoverLocalArticles();
      showToast("已将陈旧整理计划标为“已替代”；历史计划与摘要仍完整保留。");
    } catch (error) {
      setIdentityActionError(error instanceof Error ? error.message : "陈旧计划收口失败");
    } finally {
      setIdentityActionState("idle");
    }
  }, [discoverLocalArticles, identityActionState, postIdentityAction, showToast]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const restoredLocalArticles = parseLocalArticleDirectory(window.localStorage.getItem(LOCAL_ARTICLE_DIRECTORY_KEY));
      setLocalArticleDirectory(restoredLocalArticles);
      const storedArticle = window.localStorage.getItem("wenmai:last-article");
      const storedView = window.localStorage.getItem("wenmai:last-view") as WorkspaceView | null;
      if (storedArticle && (
        corpus.articles.some((article) => article.id === storedArticle)
        || restoredLocalArticles.some((article) => article.articleId === storedArticle)
      )) setSelectedArticleId(storedArticle);
      if (storedView && NAV_ITEMS.some((item) => item.id === storedView)) setView(storedView === "desk" ? "project" : storedView);
      setWorkspaceRestored(true);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [corpus.articles]);

  useEffect(() => {
    const timer = window.setTimeout(() => void discoverLocalArticles(), 0);
    return () => window.clearTimeout(timer);
  }, [discoverLocalArticles]);

  useEffect(() => {
    if (!workspaceRestored || !selectedArticleId) return;
    window.localStorage.setItem("wenmai:last-article", selectedArticleId);
    const timer = window.setTimeout(() => {
      setEditorBranchId("");
      setSelectedNodeId("");
      setDiffResult([]);
      void loadWorkspace(selectedArticleId, window.localStorage.getItem(`wenmai:branch:${selectedArticleId}`) ?? undefined);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [loadWorkspace, selectedArticleId, workspaceRestored]);

  useEffect(() => {
    if (!workspaceRestored) return;
    window.localStorage.setItem("wenmai:last-view", view);
  }, [view, workspaceRestored]);

  useEffect(() => {
    if (!activeBranch || !activeCopy) return;
    window.localStorage.setItem(`wenmai:branch:${activeBranch.articleId}`, activeBranch.id);
    if (editorBranchId === activeBranch.id) return;
    const timer = window.setTimeout(() => {
      setEditorBranchId(activeBranch.id);
      setDocumentTitle(activeCopy.title);
      setBodyText(activeCopy.bodyText);
      setWorkingNote(activeCopy.annotation);
      setSaveState("saved");
      editorRef.current = { title: activeCopy.title, body: activeCopy.bodyText, note: activeCopy.annotation };
    }, 0);
    return () => window.clearTimeout(timer);
  }, [activeBranch, activeCopy, editorBranchId]);

  useEffect(() => {
    editorRef.current = { title: documentTitle, body: bodyText, note: workingNote };
  }, [bodyText, documentTitle, workingNote]);

  useEffect(() => {
    if (!selectedMergeProposal) return;
    const timer = window.setTimeout(() => {
      setSelectedMergeProposalId(selectedMergeProposal.id);
      setMergeResolutionTitle(selectedMergeProposal.resolvedDocumentTitle);
      setMergeResolutionBody(selectedMergeProposal.resolvedBodyText);
      setMergeResolutionNote(selectedMergeProposal.resolutionNote);
      setMergeConfirmed(selectedMergeProposal.status === "ready");
      setMergeResolutionDirty(false);
      setMergeRevisionTitle(`合并 · ${workspace.branches.find((branch) => branch.id === selectedMergeProposal.sourceBranchId)?.name ?? "来源"}`);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [selectedMergeProposal, workspace.branches]);

  const saveWorkingCopy = useCallback(async (): Promise<WorkingCopy | null> => {
    if (!activeCopy || !activeBranch) return null;
    const snapshot = { ...editorRef.current };
    const signature = JSON.stringify(snapshot);
    setSaveState("saving");
    try {
      const result = await postWorkspace("save_working_copy", {
        branchId: activeBranch.id,
        baseRevisionId: activeCopy.baseRevisionId,
        lockVersion: activeCopy.lockVersion,
        title: snapshot.title,
        annotation: snapshot.note,
        bodyText: snapshot.body,
      }) as { workingCopy?: WorkingCopy };
      if (!result.workingCopy) throw new Error("保存回执缺少工作副本");
      setWorkspace((current) => ({
        ...current,
        workingCopies: [result.workingCopy!, ...current.workingCopies.filter((copy) => copy.branchId !== result.workingCopy!.branchId)],
      }));
      const currentSignature = JSON.stringify(editorRef.current);
      setSaveState(currentSignature === signature ? "saved" : "dirty");
      return result.workingCopy;
    } catch {
      setSaveState("error");
      return null;
    }
  }, [activeBranch, activeCopy, postWorkspace]);

  useEffect(() => {
    if (saveState !== "dirty" || !activeCopy) return;
    const timer = window.setTimeout(() => void saveWorkingCopy(), 1200);
    return () => window.clearTimeout(timer);
  }, [activeCopy, bodyText, documentTitle, saveState, saveWorkingCopy, workingNote]);

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void saveWorkingCopy();
      }
      if ((event.ctrlKey || event.metaKey) && event.key === "Enter" && activeCopy) {
        event.preventDefault();
        setCommitOpen(true);
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [activeCopy, saveWorkingCopy]);

  const markEditorDirty = useCallback(() => setSaveState((current) => current === "saving" ? "saving" : "dirty"), []);

  const switchBranch = useCallback(async (branchId: string) => {
    if (branchId === activeBranch?.id) return;
    if (["dirty", "error", "saving"].includes(saveState)) {
      const saved = await saveWorkingCopy();
      if (!saved) {
        setOperationError("当前工作副本尚未安全保存；已留在原分支。请重试保存，避免编辑缓冲从界面消失。");
        return;
      }
    }
    setSelectedBranchId(branchId);
    setEditorBranchId("");
  }, [activeBranch?.id, saveState, saveWorkingCopy]);

  const requestArticleSelection = useCallback((articleId: string, destination: WorkspaceView = "project") => {
    if (!articleId) return;
    setArticleNavigation({ articleId, destination, requestId: crypto.randomUUID() });
  }, []);

  useEffect(() => {
    if (!articleNavigation) return;
    let cancelled = false;
    const request = articleNavigation;
    const navigate = async () => {
      if (request.articleId !== selectedArticleId && activeCopy && ["dirty", "error", "saving"].includes(saveState)) {
        const saved = await saveWorkingCopy();
        if (!saved) {
          if (!cancelled) {
            setOperationError("当前文章尚未安全保存；已取消切换。你可以重试保存后再打开另一篇文章。");
            setArticleNavigation((current) => current?.requestId === request.requestId ? null : current);
          }
          return;
        }
      }
      if (cancelled) return;
      setSelectedArticleId(request.articleId);
      setView(request.destination);
      setArticleNavigation((current) => current?.requestId === request.requestId ? null : current);
    };
    void navigate();
    return () => { cancelled = true; };
  }, [activeCopy, articleNavigation, saveState, saveWorkingCopy, selectedArticleId]);

  const openBranchPanel = useCallback((base?: string) => {
    if (!selectedArticle) return;
    const defaultBase = base || (selectedNodeId.startsWith("source:") || selectedNodeId.startsWith("revision:")
      ? selectedNodeId
      : `source:${selectedArticle.representativeVersionId}`);
    setBranchBase(defaultBase);
    setBranchName(workspace.branches.length ? `探索-${workspace.branches.length + 1}` : "main");
    setBranchAnnotation("");
    setBranchPanelOpen(true);
  }, [selectedArticle, selectedNodeId, workspace.branches.length]);

  const createBranch = useCallback(async () => {
    if (!selectedArticleId || !branchBase) return;
    const [kind, id] = branchBase.split(":", 2);
    const result = await postWorkspace("create_branch", {
      articleId: selectedArticleId,
      name: branchName,
      annotation: branchAnnotation,
      ...(kind === "revision" ? { baseRevisionId: id } : { baseSourceVersionId: id }),
    });
    const branchId = String(result.branchId ?? "");
    setBranchPanelOpen(false);
    setEditorBranchId("");
    await loadWorkspace(selectedArticleId, branchId);
    showToast(`已建立分支“${branchName}”；源文件仍为只读。`);
  }, [branchAnnotation, branchBase, branchName, loadWorkspace, postWorkspace, selectedArticleId, showToast]);

  const commitRevision = useCallback(async () => {
    if (!activeBranch || !activeCopy || !revisionTitle.trim()) return;
    const savedCopy = ["dirty", "error", "saving"].includes(saveState) ? await saveWorkingCopy() : activeCopy;
    if (!savedCopy) return;
    await postWorkspace("commit_revision", {
      branchId: activeBranch.id,
      baseRevisionId: savedCopy.baseRevisionId,
      lockVersion: savedCopy.lockVersion,
      bodySha256: savedCopy.bodySha256,
      revisionTitle,
      annotation: revisionAnnotation,
    });
    setCommitOpen(false);
    setRevisionTitle("");
    setRevisionAnnotation("");
    setSaveState("saved");
    await loadWorkspace(activeBranch.articleId, activeBranch.id);
    showToast("已提交不可变修订；工作副本仍留在当前分支，可继续编辑。");
  }, [activeBranch, activeCopy, loadWorkspace, postWorkspace, revisionAnnotation, revisionTitle, saveState, saveWorkingCopy, showToast]);

  const runGates = useCallback(async () => {
    if (!activeBranch || !activeCopy) return;
    const savedCopy = ["dirty", "error", "saving"].includes(saveState) ? await saveWorkingCopy() : activeCopy;
    if (!savedCopy) return;
    await postWorkspace("run_builtin_gates", { branchId: activeBranch.id, bodySha256: savedCopy.bodySha256 });
    await loadWorkspace(activeBranch.articleId, activeBranch.id);
    showToast("已对当前正文摘要运行 4 项内置文本门禁。");
  }, [activeBranch, activeCopy, loadWorkspace, postWorkspace, saveState, saveWorkingCopy, showToast]);

  const sourceText = useCallback(async (versionId: string) => {
    const cached = sourceTextCache.current.get(versionId);
    if (cached !== undefined) return cached;
    const response = await managementFetch(`/api/version-text?id=${encodeURIComponent(versionId)}`);
    const payload = await response.json() as { versions?: Record<string, { text: string }> };
    if (!response.ok || !payload.versions?.[versionId]) throw new Error("源版本正文读取失败");
    const text = payload.versions[versionId].text;
    sourceTextCache.current.set(versionId, text);
    return text;
  }, []);

  const textForNode = useCallback(async (nodeId: string) => {
    const [kind, id] = nodeId.split(":", 2);
    if (kind === "source") return sourceText(id);
    if (kind === "revision") return articleRevisions.find((revision) => revision.id === id)?.bodyText ?? "";
    return "";
  }, [articleRevisions, sourceText]);

  const compareNodes = useCallback(async () => {
    if (!diffLeftId || !diffRightId || diffLeftId === diffRightId) return;
    setDiffLoading(true);
    try {
      const [left, right] = await Promise.all([textForNode(diffLeftId), textForNode(diffRightId)]);
      setDiffResult(diffBlocks(left, right));
    } catch (error) {
      setOperationError(error instanceof Error ? error.message : "差异读取失败");
    } finally {
      setDiffLoading(false);
    }
  }, [diffLeftId, diffRightId, textForNode]);

  const prepareMerge = useCallback(async () => {
    const activeBranches = workspace.branches.filter((branch) => branch.status === "active");
    const sourceBranchId = mergeSourceBranchId || activeBranches[0]?.id;
    const targetBranchId = mergeTargetBranchId || activeBranches.find((branch) => branch.id !== sourceBranchId)?.id;
    if (!sourceBranchId || !targetBranchId || sourceBranchId === targetBranchId) return;
    const sourceBranch = activeBranches.find((branch) => branch.id === sourceBranchId);
    const targetBranch = activeBranches.find((branch) => branch.id === targetBranchId);
    const sourceCopy = workspace.workingCopies.find((copy) => copy.branchId === sourceBranchId);
    const targetCopy = workspace.workingCopies.find((copy) => copy.branchId === targetBranchId);
    if (!sourceBranch || !targetBranch || !sourceCopy || !targetCopy) {
      throw new Error("合并坐标不完整；请重新载入分支与工作副本");
    }
    const result = await postWorkspace("prepare_merge", {
      commandId: `workspace-prepare-merge:${crypto.randomUUID()}`,
      articleId: selectedArticleId,
      sourceBranchId,
      targetBranchId,
      expectedSourceHeadRevisionId: sourceBranch.headRevisionId,
      expectedTargetHeadRevisionId: targetBranch.headRevisionId,
      expectedSourceCopyLockVersion: sourceCopy.lockVersion,
      expectedTargetCopyLockVersion: targetCopy.lockVersion,
    }) as { proposal?: { id?: string } };
    await loadWorkspace(selectedArticleId, targetBranchId);
    if (result.proposal?.id) setSelectedMergeProposalId(result.proposal.id);
    setView("versions");
    showToast("三方基线已冻结；请在合并工位检查并确认完整解决稿。");
  }, [loadWorkspace, mergeSourceBranchId, mergeTargetBranchId, postWorkspace, selectedArticleId, showToast, workspace.branches, workspace.workingCopies]);

  const saveMergeResolution = useCallback(async () => {
    if (!selectedMergeProposal) return;
    const sourceCopy = workspace.workingCopies.find((copy) => copy.branchId === selectedMergeProposal.sourceBranchId);
    const targetCopy = workspace.workingCopies.find((copy) => copy.branchId === selectedMergeProposal.targetBranchId);
    if (!sourceCopy || !targetCopy) throw new Error("合并工作副本不完整；请重新载入");
    await postWorkspace("save_merge_resolution", {
      commandId: `workspace-save-merge-resolution:${crypto.randomUUID()}`,
      proposalId: selectedMergeProposal.id,
      expectedLockVersion: selectedMergeProposal.lockVersion,
      expectedPreviewSha256: selectedMergeProposal.previewSha256,
      expectedSourceHeadRevisionId: selectedMergeProposal.sourceHeadRevisionId,
      expectedTargetHeadRevisionId: selectedMergeProposal.targetHeadRevisionId,
      expectedSourceCopyLockVersion: sourceCopy.lockVersion,
      expectedTargetCopyLockVersion: targetCopy.lockVersion,
      resolvedDocumentTitle: mergeResolutionTitle,
      resolvedBodyText: mergeResolutionBody,
      resolutionNote: mergeResolutionNote,
      confirmResolved: mergeConfirmed,
    });
    await loadWorkspace(selectedArticleId, selectedMergeProposal.targetBranchId);
    setMergeResolutionDirty(false);
    showToast(mergeConfirmed ? "完整解决稿已确认，现在可以创建双父修订。" : "解决稿已保存，仍等待确认。");
  }, [loadWorkspace, mergeConfirmed, mergeResolutionBody, mergeResolutionNote, mergeResolutionTitle, postWorkspace, selectedArticleId, selectedMergeProposal, showToast, workspace.workingCopies]);

  const commitMergeRevision = useCallback(async () => {
    if (!selectedMergeProposal || selectedMergeProposal.status !== "ready" || mergeResolutionDirty) return;
    const targetCopy = workspace.workingCopies.find((copy) => copy.branchId === selectedMergeProposal.targetBranchId);
    if (!targetCopy) throw new Error("目标分支工作副本不存在");
    const result = await postWorkspace("merge_revision", {
      commandId: `workspace-merge:${crypto.randomUUID()}`,
      proposalId: selectedMergeProposal.id,
      expectedProposalLockVersion: selectedMergeProposal.lockVersion,
      expectedTargetCopyLockVersion: targetCopy.lockVersion,
      expectedResolutionSha256: selectedMergeProposal.resolvedBodySha256,
      revisionTitle: mergeRevisionTitle,
      annotation: mergeResolutionNote,
    });
    const revisionId = String(result.revisionId ?? "");
    await loadWorkspace(selectedArticleId, selectedMergeProposal.targetBranchId);
    if (revisionId) setSelectedNodeId(`revision:${revisionId}`);
    showToast("已创建双父修订；来源分支未改动，目标分支需要重新运行门禁。");
  }, [loadWorkspace, mergeResolutionDirty, mergeResolutionNote, mergeRevisionTitle, postWorkspace, selectedArticleId, selectedMergeProposal, showToast, workspace.workingCopies]);

  const updateWorkItem = useCallback(async (item: WorkItem, updates: Record<string, unknown>) => {
    await postWorkspace("update_work_item", { id: item.id, ...updates });
    await loadWorkspace(selectedArticleId, activeBranch?.id);
  }, [activeBranch?.id, loadWorkspace, postWorkspace, selectedArticleId]);

  const moveWorkItem = useCallback(async (item: WorkItem, direction: -1 | 1) => {
    const index = STAGES.findIndex((stage) => stage.id === item.stage);
    const next = STAGES[index + direction];
    if (next) await updateWorkItem(item, { stage: next.id });
  }, [updateWorkItem]);

  const createWorkItem = useCallback(async (options?: { title?: string; stage?: WorkStage; sourceCapabilityId?: string; nextAction?: string }) => {
    const title = options?.title || newWorkTitle;
    if (!title.trim()) return;
    await postWorkspace("create_work_item", {
      title,
      stage: options?.stage || newWorkStage,
      articleId: selectedArticleId,
      branchId: activeBranch?.id,
      sourceCapabilityId: options?.sourceCapabilityId,
      nextAction: options?.nextAction || "明确验收、下一动作和所需证据",
    });
    setNewWorkTitle("");
    setNewWorkOpen(false);
    await loadWorkspace(selectedArticleId, activeBranch?.id);
    showToast("工作项已加入任务看板。");
  }, [activeBranch?.id, loadWorkspace, newWorkStage, newWorkTitle, postWorkspace, selectedArticleId, showToast]);

  const filteredCapabilities = useMemo(() => {
    const query = capabilityQuery.trim().toLowerCase();
    return capabilities.capabilities.filter((capability) => {
      if (capabilityKind !== "all" && capability.kind !== capabilityKind) return false;
      if (capabilityDimension !== "all" && capability.dimension !== capabilityDimension) return false;
      const effectiveMaturity = workspace.capabilityOverrides.find((item) => item.capabilityId === capability.id)?.adoptionStatus ?? capability.indexedAdoption;
      if (capabilityMaturity !== "all" && effectiveMaturity !== capabilityMaturity) return false;
      if (!query) return true;
      return [capability.name, capability.description, capability.id, capability.dimension, ...capability.tags].join(" ").toLowerCase().includes(query);
    });
  }, [capabilities.capabilities, capabilityDimension, capabilityKind, capabilityMaturity, capabilityQuery, workspace.capabilityOverrides]);

  const selectedCapability = filteredCapabilities.find((item) => item.id === selectedCapabilityId) ?? filteredCapabilities[0];
  useEffect(() => {
    if (!selectedCapability) return;
    const override = workspace.capabilityOverrides.find((item) => item.capabilityId === selectedCapability.id);
    const timer = window.setTimeout(() => {
      setCapStatus(override?.adoptionStatus ?? selectedCapability.indexedAdoption);
      setCapNotes(override?.notes ?? selectedCapability.adoptionBasis);
      setCapEvidence(override?.evidenceRef ?? selectedCapability.evidenceRefs?.join("\n") ?? "");
      setCapRegression(override?.regressionRef ?? "");
      setCapFavorite(override?.favorite ?? false);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [selectedCapability, workspace.capabilityOverrides]);

  const effectiveAdoption = useCallback((capability: CapabilityRecord) => {
    return workspace.capabilityOverrides.find((item) => item.capabilityId === capability.id)?.adoptionStatus ?? capability.indexedAdoption;
  }, [workspace.capabilityOverrides]);

  const saveCapabilityDecision = useCallback(async () => {
    if (!selectedCapability) return;
    await postWorkspace("update_capability", {
      capabilityId: selectedCapability.id,
      adoptionStatus: capStatus,
      notes: capNotes,
      evidenceRef: capEvidence,
      regressionRef: capRegression,
      favorite: capFavorite,
    });
    await loadWorkspace(selectedArticleId, activeBranch?.id);
    showToast("已保存能力成熟度决定；入口索引未被改写。");
  }, [activeBranch?.id, capEvidence, capFavorite, capNotes, capRegression, capStatus, loadWorkspace, postWorkspace, selectedArticleId, selectedCapability, showToast]);

  const createProductionRun = useCallback(async () => {
    if (!activeBranch || !selectedArticle) return;
    await postWorkspace("create_production_run", {
      recipeId: selectedRecipeId,
      articleId: selectedArticle.id,
      branchId: activeBranch.id,
    });
    await loadWorkspace(selectedArticle.id, activeBranch.id);
    showToast("已创建制作路线实例；它只记录工位，不表示 Agent 已执行。");
  }, [activeBranch, loadWorkspace, postWorkspace, selectedArticle, selectedRecipeId, showToast]);

  const updateProductionStep = useCallback(async (runId: string, stepId: string, status: string) => {
    const key = `${runId}:${stepId}`;
    const evidenceNote = stepEvidence[key] ?? "";
    if (["complete", "skipped"].includes(status) && evidenceNote.trim().length < 4) {
      setOperationError("完成或跳过工位前，请留下至少 4 个字的工件证据或理由");
      return;
    }
    await postWorkspace("update_production_step", { runId, stepId, status, evidenceNote });
    setStepEvidence((current) => ({ ...current, [key]: "" }));
    await loadWorkspace(selectedArticleId, activeBranch?.id);
  }, [activeBranch?.id, loadWorkspace, postWorkspace, selectedArticleId, stepEvidence]);

  const issueRunner = useCallback(async () => {
    const result = await postRunner("issue_runner_token", { label: runnerLabel, capabilities: ["text-gates"] });
    const runnerId = String(result.runnerId ?? "");
    const token = String(result.token ?? "");
    if (!runnerId || !token) throw new Error("Runner 回执缺少一次性凭据");
    setIssuedRunner({ runnerId, token });
    await loadRunnerState(selectedArticleId);
    showToast("已签发 Runner 凭据；token 只会在当前页面显示一次。");
  }, [loadRunnerState, postRunner, runnerLabel, selectedArticleId, showToast]);

  const revokeRunner = useCallback(async (runnerId: string) => {
    await postRunner("revoke_runner", { runnerId });
    if (issuedRunner?.runnerId === runnerId) setIssuedRunner(null);
    await loadRunnerState(selectedArticleId);
    showToast("已撤销 Runner；旧 token 不再有效。");
  }, [issuedRunner?.runnerId, loadRunnerState, postRunner, selectedArticleId, showToast]);

  const queueRunnerStep = useCallback(async (productionRunId: string, productionStepId: string) => {
    await postRunner("queue_agent_step", { productionRunId, productionStepId });
    await loadRunnerState(selectedArticleId);
    showToast("已冻结工位输入、权限与配方摘要，并排入 Runner 队列。");
  }, [loadRunnerState, postRunner, selectedArticleId, showToast]);

  const runnerCommand = issuedRunner
    ? `$env:WENMAI_RUNNER_TOKEN='${issuedRunner.token}'\npython -B '.\\scripts\\factory_runner.py' --base-url 'http://[::1]:3000' --runner-id '${issuedRunner.runnerId}' --once\nRemove-Item Env:WENMAI_RUNNER_TOKEN`
    : "";

  const runStorageProbe = useCallback(async () => {
    setStorageProbe("running");
    try {
      await postWorkspace("storage_probe");
      setStorageProbe("pass");
      showToast("D1 写入、锁冲突、原子提交与工厂依赖检查通过；探针记录已清理。");
    } catch {
      setStorageProbe("fail");
    }
  }, [postWorkspace, showToast]);

  const filteredArticles = useMemo(() => {
    const query = articleQuery.trim().toLowerCase();
    return articleWorks.filter((article) => {
      if (queueBucket !== "all" && queueBucketForArticle(article) !== queueBucket) return false;
      if (queuePlatform !== "all" && !article.platforms.includes(queuePlatform)) return false;
      if (queueTag !== "all" && !article.tags.includes(queueTag)) return false;
      if (!query) return true;
      return [article.title, article.summary, ...article.tags, ...article.platforms, ...article.versions.map((version) => version.name)].join(" ").toLowerCase().includes(query);
    });
  }, [articleQuery, articleWorks, queueBucket, queuePlatform, queueTag]);

  const libraryArticles = useMemo((): Array<WorkbenchArticle | LibrarySlimItem> => {
    if (libraryRemotePage) return libraryRemotePage.items;
    const query = articleQuery.trim().toLowerCase();
    return workspaceArticles.filter((article) => {
      if (libraryBucketFilter !== "all" && libraryBucket(article) !== libraryBucketFilter) return false;
      if (libraryKind !== "all" && article.kind !== libraryKind) return false;
      if (libraryState !== "all" && article.editorialState !== libraryState) return false;
      if (libraryPlatform !== "all" && !article.platforms.includes(libraryPlatform)) return false;
      if (!query) return true;
      return [article.title, article.summary, article.kind, article.editorialState, ...article.tags, ...article.platforms, ...article.versions.map((version) => version.name)].join(" ").toLowerCase().includes(query);
    });
  }, [articleQuery, libraryBucketFilter, libraryKind, libraryPlatform, libraryRemotePage, libraryState, workspaceArticles]);

  const libraryGroups = useMemo(() => LIBRARY_BUCKETS.filter((bucket) => libraryBucketFilter === "all" || bucket === libraryBucketFilter).map((bucket) => ({
    bucket,
    articles: libraryArticles.filter((article) => libraryBucket(article) === bucket),
  })).filter((group) => group.articles.length > 0), [libraryArticles, libraryBucketFilter]);
  const trustedLocalProjectArticleIds = useMemo(() => new Set([
    ...localArticleDirectory.map((entry) => entry.articleId),
    ...(identityCatalog?.localArticles ?? []).map((entry) => entry.articleId),
  ]), [identityCatalog, localArticleDirectory]);

  const selectedSourceVersions = selectedArticle?.versions;
  const revisionOptions = useMemo(() => [
    ...(selectedSourceVersions?.map((version) => ({ id: `source:${version.id}`, label: `源稿 · ${version.name}` })) ?? []),
    ...articleRevisions.map((revision) => ({ id: `revision:${revision.id}`, label: `${workspace.branches.find((branch) => branch.id === revision.branchId)?.name ?? "分支"} · ${revision.title}` })),
  ], [articleRevisions, selectedSourceVersions, workspace.branches]);

  useEffect(() => {
    if (!revisionOptions.length) return;
    const timer = window.setTimeout(() => {
      setDiffLeftId((current) => revisionOptions.some((item) => item.id === current) ? current : revisionOptions[0].id);
      setDiffRightId((current) => revisionOptions.some((item) => item.id === current) ? current : revisionOptions.at(-1)!.id);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [revisionOptions]);

  if (!selectedArticle) return <main className="empty-app">没有可继续编辑的文章。请先从资料库选择一篇文章。</main>;

  const renderBranchPanel = () => (
    <section className="inline-drawer branch-builder" aria-label="建立工作分支">
      <div className="section-heading">
        <div><span className="eyebrow">新建工作分支</span><h3>先选定要继续修改的版本</h3></div>
        <button className="quiet-button" onClick={() => setBranchPanelOpen(false)}>关闭</button>
      </div>
      <label>分支名称<input value={branchName} onChange={(event) => setBranchName(event.target.value)} placeholder="例如：main / 结构试写 / 事实更新" /></label>
      <fieldset className="base-picker">
        <legend>选择基线，确认这条分支从哪里开始</legend>
        {selectedArticle.versions.map((version) => (
          <div key={version.id} className={`base-option-row ${branchBase === `source:${version.id}` ? "selected" : ""}`}>
            <label>
              <input type="radio" name="branch-base" value={`source:${version.id}`} checked={branchBase === `source:${version.id}`} onChange={(event) => setBranchBase(event.target.value)} />
              <span className="visually-hidden">选择源版本</span>
              <span><strong>{version.name}</strong><small>{version.role} · {formatTime(version.modifiedAt)} · {version.charCount.toLocaleString("zh-CN")} 字</small></span>
            </label>
            <ArticleQuickLink articleId={selectedArticle.id} versionId={version.id}>预览全文</ArticleQuickLink>
          </div>
        ))}
        {articleRevisions.map((revision) => (
          <div key={revision.id} className={`base-option-row ${branchBase === `revision:${revision.id}` ? "selected" : ""}`}>
            <label>
              <input type="radio" name="branch-base" value={`revision:${revision.id}`} checked={branchBase === `revision:${revision.id}`} onChange={(event) => setBranchBase(event.target.value)} />
              <span className="visually-hidden">选择工作区修订</span>
              <span><strong>{revision.title}</strong><small>工作区修订 · {formatTime(revision.createdAt)} · {shortHash(revision.bodySha256)}</small></span>
            </label>
            <button className="revision-inline-preview" onClick={() => setRevisionPreviewId(revision.id)}>预览修订</button>
          </div>
        ))}
      </fieldset>
      <label>这条分支要解决什么<textarea value={branchAnnotation} onChange={(event) => setBranchAnnotation(event.target.value)} placeholder="例如：保留原论点，尝试一个更直接的开头。" /></label>
      <div className="drawer-actions">
        <span>正文会复制到 D1；历史源文件仍保持原样。</span>
        <button className="primary-button" disabled={!branchName.trim() || !branchBase} onClick={() => void createBranch()}>创建工作分支</button>
      </div>
    </section>
  );

  const renderEditor = () => {
    if (workspaceState === "loading") return <div className="workspace-loading">正在读取这篇文章的工作区…</div>;
    if (workspaceState === "unavailable") return <div className="workspace-error"><strong>暂时无法读取文章工作区</strong><p>{operationError}</p><button onClick={() => void loadWorkspace(selectedArticle.id)}>重新读取</button></div>;
    if (!activeBranch || !activeCopy) {
      return (
        <section className="empty-workspace">
          <span className="eyebrow">这篇文章还没有工作分支</span>
          <h2><ArticleQuickLink articleId={selectedArticle.id}>{selectedArticle.title}</ArticleQuickLink></h2>
          <p>下面 {selectedArticle.versionCount} 个版本都是只读历史源稿。选定一个基线后，会在 D1 创建可编辑的工作副本和可追溯分支。</p>
          <div className="source-stack">
            {selectedArticle.versions.map((version) => (
              <div key={version.id} className="source-option-row">
                <button className="source-option-select" onClick={() => openBranchPanel(`source:${version.id}`)}>
                  <span><strong>{version.name}</strong><small>{version.role} · {formatTime(version.modifiedAt)}</small></span>
                  <em>{version.charCount.toLocaleString("zh-CN")} 字</em>
                </button>
                <ArticleQuickLink articleId={selectedArticle.id} versionId={version.id} className="source-option-preview">预览全文</ArticleQuickLink>
              </div>
            ))}
          </div>
          <button className="primary-button" onClick={() => openBranchPanel()}>选择基线并创建工作分支</button>
          {branchPanelOpen && renderBranchPanel()}
        </section>
      );
    }
    const outline = outlineFromMarkdown(bodyText);
    const saveLabel = saveState === "saving" ? "正在保存到 D1…" : saveState === "dirty" ? "正文有未保存修改" : saveState === "error" ? "保存失败；正文仍保留在编辑器中" : `已保存 · ${formatTime(activeCopy.updatedAt)}`;
    return (
      <section className="editor-workspace">
        <div className="branch-strip">
          <div className="branch-tabs" role="tablist" aria-label="工作分支">
            {workspace.branches.map((branch) => (
              <button key={branch.id} role="tab" aria-selected={branch.id === activeBranch.id} className={branch.id === activeBranch.id ? "active" : ""} onClick={() => void switchBranch(branch.id)}>
                <span className="branch-dot" />{branch.name}
              </button>
            ))}
          </div>
          <button className="new-branch-button" onClick={() => openBranchPanel(`revision:${activeBranch.headRevisionId}`)}>＋ 新建分支</button>
        </div>
        {branchPanelOpen && renderBranchPanel()}
        <header className="editor-toolbar">
          <div className="document-title-field">
            <span>文章标题</span>
            <input value={documentTitle} onChange={(event) => { setDocumentTitle(event.target.value); markEditorDirty(); }} aria-label="文章标题" />
          </div>
          <div className="editor-mode-switch" role="group" aria-label="编辑显示模式">
            {(["write", "split", "preview"] as const).map((mode) => <button key={mode} className={editorMode === mode ? "active" : ""} onClick={() => setEditorMode(mode)}>{mode === "write" ? "写作" : mode === "split" ? "分栏" : "预览"}</button>)}
          </div>
          <div className={`save-indicator ${saveState}`}><i />{saveLabel}</div>
          <button className="quiet-button" onClick={() => void saveWorkingCopy()}>保存工作副本</button>
          <button className="primary-button" onClick={() => { setCommitOpen(true); setRevisionTitle(`修订 · ${new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date())}`); }}>提交修订</button>
        </header>
        <div className={`editor-body mode-${editorMode}`}>
          {editorMode !== "preview" && (
            <div className="writing-pane">
              <textarea
                className="markdown-editor"
                value={bodyText}
                onChange={(event) => { setBodyText(event.target.value); markEditorDirty(); }}
                spellCheck
                aria-label="Markdown 正文编辑器"
                placeholder="在这里继续写正文。可使用 Markdown 的标题、列表、引用和链接。"
              />
            </div>
          )}
          {editorMode !== "write" && <div className="preview-pane"><MarkdownPreview markdown={bodyText} /></div>}
        </div>
        <footer className="editor-footer">
          <label className="working-note">本轮修改说明<input value={workingNote} onChange={(event) => { setWorkingNote(event.target.value); markEditorDirty(); }} placeholder="写下这轮要解决的问题；它不会替代提交注释" /></label>
          <div className="editor-metrics"><span>{compactLength(bodyText).toLocaleString("zh-CN")} 字</span><span>{outline.length} 个标题</span><span>基线 {shortHash(activeCopy.bodySha256)}</span></div>
        </footer>
        {commitOpen && (
          <section className="commit-panel">
            <div><span className="eyebrow">提交修订</span><h3>为这一版留下可回看的记录</h3></div>
            <label>修订标题<input value={revisionTitle} onChange={(event) => setRevisionTitle(event.target.value)} placeholder="例如：把开头改成读者问题" /></label>
            <label>修订说明<textarea value={revisionAnnotation} onChange={(event) => setRevisionAnnotation(event.target.value)} placeholder="写清这次改了什么、保留了什么，以及下一步。" /></label>
            <div className="drawer-actions"><button className="quiet-button" onClick={() => setCommitOpen(false)}>取消</button><button className="primary-button" disabled={!revisionTitle.trim()} onClick={() => void commitRevision()}>提交修订</button></div>
          </section>
        )}
      </section>
    );
  };

  const renderDesk = () => {
    const latestRuns = activeGateRuns.slice(0, 4);
    const nextItem = activeWorkItems.find((item) => item.state === "blocked") ?? activeWorkItems.find((item) => item.state === "open");
    return (
      <div className="desk-layout">
        <aside className="desk-context">
          <div className="context-title"><span className="eyebrow">文章队列</span><strong>选择要继续处理的文章</strong></div>
          <input className="article-filter" value={articleQuery} onChange={(event) => setArticleQuery(event.target.value)} placeholder="搜索标题、标签或版本…" />
          <div className="queue-filters" role="group" aria-label="文章队列分类">
            {([['all', '全部'], ['正式文章', '正式'], ['创作中', '创作中']] as const).map(([value, label]) => <button key={value} className={queueBucket === value ? "active" : ""} onClick={() => setQueueBucket(value)}>{label}</button>)}
          </div>
          <div className="queue-select-filters">
            <label><span>平台</span><select value={queuePlatform} onChange={(event) => setQueuePlatform(event.target.value)}><option value="all">全部平台</option>{[...new Set(articleWorks.flatMap((article) => article.platforms))].sort().map((platform) => <option key={platform} value={platform}>{platform}</option>)}</select></label>
            <label><span>标签</span><select value={queueTag} onChange={(event) => setQueueTag(event.target.value)}><option value="all">全部标签</option>{[...new Set(articleWorks.flatMap((article) => article.tags))].sort().map((tag) => <option key={tag} value={tag}>{tag}</option>)}</select></label>
          </div>
          <div className="article-queue">
            {filteredArticles.slice(0, 40).map((article) => (
              <article key={article.id} className={article.id === selectedArticle.id ? "active" : ""}>
                <button className="article-queue-select" onClick={() => requestArticleSelection(article.id, "project")}><strong>{article.title}</strong><span>{queueBucketForArticle(article)} · {CORPUS_CLASS_LABELS[article.classification.class]} · {article.versionCount} 个语料版本{articleRelationsByArticle.get(article.id)?.some((relation) => relation.status === "suggested") ? " · 有待整理关系" : ""} · {formatTime(article.updatedAt, false)}</span></button>
                <ArticleQuickLink articleId={article.id} className="article-queue-preview" aria-label={`预览 ${article.title}`}>阅</ArticleQuickLink>
              </article>
            ))}
            {!filteredArticles.length && <div className="queue-empty"><strong>没有符合当前筛选的文章</strong><span>请更换分类，或清空搜索词后再试。</span></div>}
          </div>
          <div className="context-foot"><span>{articleWorks.length} 个文章候选</span><button onClick={() => setView("library")}>打开资料库</button></div>
        </aside>
        <main className="desk-editor">{renderEditor()}</main>
        <aside className="desk-inspector">
          <section>
            <span className="eyebrow">当前坐标</span>
            <h3>{activeBranch ? activeBranch.name : "未建立工作分支"}</h3>
            <dl className="compact-facts">
              <div><dt>文章</dt><dd><ArticleQuickLink articleId={selectedArticle.id}>{selectedArticle.title}</ArticleQuickLink></dd></div>
              <div><dt>源版本</dt><dd>{selectedArticle.versionCount}</dd></div>
              <div><dt>工作修订</dt><dd>{articleRevisions.length}</dd></div>
              <div><dt>身份</dt><dd>{selectedArticle.identityStatus === "confirmed" ? "已确认" : "候选"} · {selectedArticle.identityConfidence}信号</dd></div>
            </dl>
          </section>
          <section className="next-action-block">
            <span className="eyebrow">下一动作</span>
            {nextItem ? <><h3>{nextItem.title}</h3><p>{nextItem.nextAction || "补充下一动作与验收证据。"}</p><button onClick={() => setView("pipeline")}>{nextItem.state === "blocked" ? "查看阻塞" : "打开工作项"}</button></> : <><h3>还没有文章工作项</h3><p>建立分支时会自动创建一张写作任务卡，也可以手动加入看板。</p><button onClick={() => setNewWorkOpen(true)}>建立工作项</button></>}
          </section>
          <section className="gate-rail">
            <div className="section-heading"><div><span className="eyebrow">当前输入门禁</span><h3>{latestRuns.length ? "最近检查" : "尚未运行"}</h3></div>{activeCopy && <button onClick={() => void runGates()}>运行 4 项</button>}</div>
            {latestRuns.map((run) => {
              const stale = gateRunIsStale(run, activeCopy);
              return <div key={run.id} className={`gate-result ${run.result} ${stale ? "stale" : ""}`}><i /><span><strong>{run.gateLabel}</strong><small>{stale ? "当时结果，当前输入已变化" : run.evidence[0]}</small></span><em>{stale ? "过期" : run.result === "pass" ? "通过" : run.result === "fail" ? "失败" : "待判断"}</em></div>;
            })}
            <p className="boundary-note">自动通过只表示这条规则对同一摘要成立；不表示已获人工批准，也不表示可以发布。</p>
          </section>
          <section className="outline-rail">
            <span className="eyebrow">正文结构</span>
            {outlineFromMarkdown(bodyText).slice(0, 12).map((item) => <div key={`${item.line}-${item.title}`} style={{ paddingLeft: (item.level - 1) * 10 }}>{item.title}</div>)}
            {!outlineFromMarkdown(bodyText).length && <p>当前工作副本还没有 Markdown 标题。</p>}
          </section>
        </aside>
      </div>
    );
  };

  const renderVersions = () => {
    const selectedRevision = selectedNodeId.startsWith("revision:") ? articleRevisions.find((item) => `revision:${item.id}` === selectedNodeId) : undefined;
    const selectedSource = selectedNodeId.startsWith("source:") ? selectedArticle.versions.find((item) => `source:${item.id}` === selectedNodeId) : undefined;
    const summary = diffSummary(diffResult);
    const activeBranches = workspace.branches.filter((branch) => branch.status === "active");
    const mergeSource = mergeSourceBranchId || activeBranches[0]?.id || "";
    const mergeTarget = mergeTargetBranchId || activeBranches.find((branch) => branch.id !== mergeSource)?.id || "";
    const mergeBaseRevision = selectedMergeProposal ? articleRevisions.find((revision) => revision.id === selectedMergeProposal.baseRevisionId) : undefined;
    const mergeSourceRevision = selectedMergeProposal ? articleRevisions.find((revision) => revision.id === selectedMergeProposal.sourceHeadRevisionId) : undefined;
    const mergeTargetRevision = selectedMergeProposal ? articleRevisions.find((revision) => revision.id === selectedMergeProposal.targetHeadRevisionId) : undefined;
    return (
      <div className="view-page version-page">
        <header className="page-heading">
          <div><span className="eyebrow">版本与分支</span><h1><ArticleQuickLink articleId={selectedArticle.id}>{selectedArticle.title}</ArticleQuickLink></h1><p>先查看标题、说明、时间和来源关系；只有在比较或预览时才读取正文。</p></div>
          <div className="heading-actions"><button onClick={() => setView("project")}>回到文章工程</button><button className="primary-button" onClick={() => openBranchPanel()}>新建分支</button></div>
        </header>
        {branchPanelOpen && renderBranchPanel()}
        <VersionDag article={selectedArticle} branches={workspace.branches} revisions={articleRevisions} selectedNodeId={selectedNodeId} onSelect={setSelectedNodeId} />
        {activeBranches.length >= 2 && <section className="new-work-form merge-prep"><div><span className="eyebrow">分支汇合</span><strong>先比较，再建立人工解决任务</strong><p>这里不会自动拼接正文；确认解决稿之前不会产生双父修订。</p></div><label>来源分支<select value={mergeSource} onChange={(event) => setMergeSourceBranchId(event.target.value)}>{activeBranches.map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}</select></label><label>目标分支<select value={mergeTarget} onChange={(event) => setMergeTargetBranchId(event.target.value)}>{activeBranches.filter((branch) => branch.id !== mergeSource).map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}</select></label><button className="primary-button" disabled={!mergeTarget || mergeTarget === mergeSource} onClick={() => void prepareMerge()}>准备合并</button></section>}
        {workspace.mergeProposals.length > 0 && <section className="merge-workbench">
          <header><div><span className="eyebrow">人工三方合并</span><h2>解决稿 → 双父修订</h2><p>系统冻结 Base、来源头和目标头；你负责确认完整正文。合并只移动目标分支，不改来源分支，也不会触发发布。</p></div><select value={selectedMergeProposal?.id ?? ""} onChange={(event) => setSelectedMergeProposalId(event.target.value)}>{workspace.mergeProposals.map((proposal) => <option key={proposal.id} value={proposal.id}>{proposal.status} · {workspace.branches.find((branch) => branch.id === proposal.sourceBranchId)?.name ?? "来源"} → {workspace.branches.find((branch) => branch.id === proposal.targetBranchId)?.name ?? "目标"}</option>)}</select></header>
          {selectedMergeProposal && <>
            <div className="merge-coordinates"><article><span>BASE</span><strong>{mergeBaseRevision?.title ?? selectedMergeProposal.baseRevisionId}</strong><code>{shortHash(selectedMergeProposal.baseSha256)}</code></article><article><span>SOURCE</span><strong>{mergeSourceRevision?.title ?? selectedMergeProposal.sourceHeadRevisionId}</strong><code>{shortHash(selectedMergeProposal.sourceHeadSha256)}</code></article><article><span>TARGET</span><strong>{mergeTargetRevision?.title ?? selectedMergeProposal.targetHeadRevisionId}</strong><code>{shortHash(selectedMergeProposal.targetHeadSha256)}</code></article><article className={`merge-status ${selectedMergeProposal.status}`}><span>PROPOSAL</span><strong>{selectedMergeProposal.status}</strong><code>lock {selectedMergeProposal.lockVersion}</code></article></div>
            {selectedMergeProposal.status === "merged" ? <div className="merge-complete"><strong>双父修订已经创建</strong><p>{selectedMergeProposal.mergeRevisionId}。旧门禁仍保留为历史，但对新修订一律过期。</p></div> : <div className="merge-editor-grid"><label>解决稿标题<input value={mergeResolutionTitle} onChange={(event) => { setMergeResolutionTitle(event.target.value); setMergeConfirmed(false); setMergeResolutionDirty(true); }} /></label><label>取舍说明<input value={mergeResolutionNote} onChange={(event) => { setMergeResolutionNote(event.target.value); setMergeConfirmed(false); setMergeResolutionDirty(true); }} placeholder="说明采用了哪边、手工改了什么" /></label><label className="merge-body">完整解决稿<textarea value={mergeResolutionBody} onChange={(event) => { setMergeResolutionBody(event.target.value); setMergeConfirmed(false); setMergeResolutionDirty(true); }} /></label><div className="merge-actions"><label className="check-label"><input type="checkbox" checked={mergeConfirmed} onChange={(event) => { setMergeConfirmed(event.target.checked); setMergeResolutionDirty(true); }} />我已经检查完整解决稿，冲突计数可归零</label><button className={mergeResolutionDirty ? "primary-button" : ""} onClick={() => void saveMergeResolution()}>{mergeResolutionDirty ? "保存并绑定解决稿" : "解决稿已保存"}</button><label>双父修订标题<input value={mergeRevisionTitle} onChange={(event) => setMergeRevisionTitle(event.target.value)} /></label><button className="primary-button" disabled={selectedMergeProposal.status !== "ready" || mergeConfirmed !== true || mergeResolutionDirty} onClick={() => void commitMergeRevision()}>创建双父修订</button><small>{mergeResolutionDirty ? "当前有尚未保存的解决稿；先保存，系统才会用新的服务端摘要启用合并。" : "保存后提案锁会递增；若任一分支头或目标工作副本变化，合并会整体回滚并要求重载。"}</small></div></div>}
          </>}
        </section>}
        <div className="version-lower-grid">
          <section className="node-inspector">
            <span className="eyebrow">节点说明</span>
            {!selectedRevision && !selectedSource && <p>选择图上的节点，查看它的注释和可执行动作。</p>}
            {selectedSource && <><h2>{selectedSource.name}</h2><p>{selectedSource.role} · {formatTime(selectedSource.modifiedAt)} · {selectedSource.charCount.toLocaleString("zh-CN")} 字</p><code>{selectedSource.path}</code><div className="node-actions"><ArticleQuickLink articleId={selectedArticle.id} versionId={selectedSource.id}>预览源稿</ArticleQuickLink><button onClick={() => { setDiffLeftId(`source:${selectedSource.id}`); }}>设为左版</button><button onClick={() => { setDiffRightId(`source:${selectedSource.id}`); }}>设为右版</button><button className="primary-button" onClick={() => openBranchPanel(`source:${selectedSource.id}`)}>从这里分支</button></div></>}
            {selectedRevision && <><h2>{selectedRevision.title}</h2><p>{selectedRevision.annotation || "没有额外注释"}</p><dl className="compact-facts"><div><dt>文章标题</dt><dd>{selectedRevision.documentTitle}</dd></div><div><dt>提交时间</dt><dd>{formatTime(selectedRevision.createdAt)}</dd></div><div><dt>正文</dt><dd>{selectedRevision.charCount.toLocaleString("zh-CN")} 字</dd></div><div><dt>摘要</dt><dd>{shortHash(selectedRevision.bodySha256)}</dd></div></dl><div className="node-actions"><button onClick={() => setRevisionPreviewId(selectedRevision.id)}>预览修订</button><button onClick={() => setDiffLeftId(`revision:${selectedRevision.id}`)}>设为左版</button><button onClick={() => setDiffRightId(`revision:${selectedRevision.id}`)}>设为右版</button><button className="primary-button" onClick={() => openBranchPanel(`revision:${selectedRevision.id}`)}>从这里分支</button></div></>}
          </section>
          <section className="diff-workbench">
            <div className="section-heading"><div><span className="eyebrow">任意两版比较</span><h2>差异工作台</h2></div>{diffResult.length > 0 && <span>{summary.added} 新增 · {summary.removed} 删除 · {summary.same} 相同</span>}</div>
            <div className="diff-selectors">
              <label>左版<select value={diffLeftId} onChange={(event) => setDiffLeftId(event.target.value)}>{revisionOptions.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
              <span>→</span>
              <label>右版<select value={diffRightId} onChange={(event) => setDiffRightId(event.target.value)}>{revisionOptions.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
              <button className="primary-button" disabled={diffLoading || diffLeftId === diffRightId} onClick={() => void compareNodes()}>{diffLoading ? "正在读取正文…" : "比较"}</button>
            </div>
            <div className="diff-labels"><span>{nodeLabel(diffLeftId, selectedArticle, articleRevisions)}</span><span>{nodeLabel(diffRightId, selectedArticle, articleRevisions)}</span></div>
            <div className="diff-stream">
              {!diffResult.length && <div className="diff-empty">选择两版并点击比较；长文正文按需读取，不塞进首页。</div>}
              {diffResult.map((operation, index) => <div key={`${operation.kind}-${index}`} className={`diff-operation ${operation.kind}`}><span>{operation.kind === "added" ? "+" : operation.kind === "removed" ? "−" : "＝"}</span><pre>{operation.text}</pre></div>)}
            </div>
          </section>
        </div>
      </div>
    );
  };

  const renderPipeline = () => {
    const items = workspace.workItems.filter((item) => item.state !== "cancelled" && (workFilter === "all" || item.articleId === selectedArticle.id));
    const inProgress = items.filter((item) => item.state === "open" && ["research", "draft", "review"].includes(item.stage)).length;
    return (
      <div className="view-page pipeline-page">
        <header className="page-heading"><div><span className="eyebrow">文章制作进度</span><h1>为“{selectedArticle.title}”安排下一步</h1><p>按选题、策划、写作、审校、构建、提交与复盘推进。open（进行中）、blocked（阻断）和 done（已完成）只反映任务状态，不等同于文章阶段或发布结果。</p></div><div className="heading-actions"><select value={workFilter} onChange={(event) => setWorkFilter(event.target.value as "all" | "article")}><option value="all">全部工作项</option><option value="article">只看当前文章</option></select><button className="primary-button" onClick={() => setNewWorkOpen(true)}>＋ 创建工作项</button></div></header>
        {inProgress > 3 && <div className="wip-warning"><strong>WIP 提醒：当前有 {inProgress} 个执行中的研究/写作/审阅项。</strong><span>这不是硬阻断；先说明哪些可以收束，避免同时开太多线。</span></div>}
        {newWorkOpen && <section className="new-work-form"><label>工作项标题<input value={newWorkTitle} onChange={(event) => setNewWorkTitle(event.target.value)} placeholder="一个可以验收的动作" /></label><label>起始阶段<select value={newWorkStage} onChange={(event) => setNewWorkStage(event.target.value as WorkStage)}>{STAGES.map((stage) => <option key={stage.id} value={stage.id}>{stage.label}</option>)}</select></label><button onClick={() => setNewWorkOpen(false)}>取消</button><button className="primary-button" disabled={!newWorkTitle.trim()} onClick={() => void createWorkItem()}>加入看板</button></section>}
        <div className="kanban-board">
          {STAGES.map((stage, stageIndex) => {
            const stageItems = items.filter((item) => item.stage === stage.id);
            return <section key={stage.id} className="kanban-lane"><header><span>{stage.short}</span><strong>{stage.label}<small>{stage.deliverable}</small></strong><em>{stageItems.length}</em></header><div className="lane-items">{stageItems.map((item) => <article key={item.id} className={`work-card ${item.state}`}><div className="work-card-top"><span className={`priority ${item.priority.toLowerCase()}`}>{item.priority}</span><em>{item.state === "blocked" ? "阻塞" : item.state === "done" ? "完成" : "进行"}</em></div><h3>{item.title}</h3><p>{item.nextAction || "尚未填写下一动作"}</p>{item.blocker && <div className="blocker">阻塞：{item.blocker}</div>}<footer><button aria-label="移到上一阶段" disabled={stageIndex === 0} onClick={() => void moveWorkItem(item, -1)}>←</button><button onClick={() => { const reason = window.prompt("写下明确阻塞原因；取消则不改变状态", item.blocker); if (reason?.trim()) void updateWorkItem(item, { state: "blocked", blocker: reason.trim() }); }}>{item.state === "blocked" ? "改阻塞" : "阻塞"}</button>{item.state === "blocked" && <button onClick={() => void updateWorkItem(item, { state: "open", blocker: "" })}>解除</button>}<button onClick={() => void updateWorkItem(item, { state: item.state === "done" ? "open" : "done" })}>{item.state === "done" ? "重开" : "完成"}</button><button aria-label="移到下一阶段" disabled={stageIndex === STAGES.length - 1} onClick={() => void moveWorkItem(item, 1)}>→</button></footer></article>)}</div></section>;
          })}
        </div>
      </div>
    );
  };

  const renderFactory = () => {
    const recipe = recipes.find((item) => item.id === selectedRecipeId) ?? recipes[0];
    const runs = workspace.productionRuns.filter((run) => run.articleId === selectedArticle.id);
    const articleAgentRuns = runnerSnapshot.agentRuns.filter((run) => run.articleId === selectedArticle.id);
    return (
      <div className="view-page factory-page">
        <header className="page-heading">
          <div><span className="eyebrow">制作路线</span><h1>为“{selectedArticle.title}”安排可追溯的制作步骤</h1><p>本地 Runner（执行器）只执行已登记的文字门禁动作；运行成功只说明对应工件合同完成，不表示文章已获批或已发布。</p></div>
          {activeBranch && <button className="primary-button" onClick={() => void createProductionRun()}>在“{activeBranch.name}”启动路线</button>}
        </header>
        <section className="runner-console">
          <div className="runner-console-intro">
            <div><span className="eyebrow">本地执行控制面</span><h2>允许列表执行器</h2><p>凭据只显示一次；执行器不能接收任意命令、路径或网络副作用。目前首个真实适配器是确定性文字门禁，不是大模型 Agent（智能体）。</p></div>
            <span className={`runner-health ${runnerState}`}>{runnerState === "ready" ? `${runnerSnapshot.runners.filter((item) => item.status === "active").length} 个有效 Runner` : runnerState === "loading" ? "正在读取" : "不可用"}</span>
          </div>
          <div className="runner-console-grid">
            <section className="runner-issue">
              <label>Runner 名称<input value={runnerLabel} onChange={(event) => setRunnerLabel(event.target.value)} /></label>
              <button className="primary-button small" onClick={() => void issueRunner()}>签发一次性凭据</button>
              {issuedRunner && <div className="runner-secret"><strong>只在本页显示一次</strong><p>Runner ID：<code>{issuedRunner.runnerId}</code></p><pre>{runnerCommand}</pre><button onClick={() => { void navigator.clipboard.writeText(runnerCommand); showToast("Runner 启动命令已复制"); }}>复制 PowerShell 启动命令</button></div>}
            </section>
            <section className="runner-registry"><span className="eyebrow">执行器登记</span>{runnerSnapshot.runners.map((runner) => <article key={runner.id}><div><strong>{runner.label}</strong><small>{runner.capabilities.join("、")} · {runner.lastSeenAt ? `最近心跳 ${formatTime(runner.lastSeenAt)}` : "尚未领取任务"}</small></div><span>{runner.status === "active" ? "有效" : "已撤销"}</span>{runner.status === "active" && <button onClick={() => void revokeRunner(runner.id)}>撤销</button>}</article>)}{!runnerSnapshot.runners.length && <p>尚未登记 Runner。</p>}</section>
            <section className="agent-run-log"><span className="eyebrow">AgentRun / ScriptRun</span>{articleAgentRuns.slice(0, 12).map((agentRun) => <article key={agentRun.id}><header><strong>{agentRun.steps[0]?.runnerAction ?? agentRun.recipeId}</strong><em>{agentRun.state}</em></header><p>输入 {shortHash(agentRun.inputSha256)} · 分支 {workspace.branches.find((branch) => branch.id === agentRun.branchId)?.name ?? agentRun.branchId}</p>{agentRun.steps.map((step) => <div key={step.id}><span>attempt {step.attempt} · {step.state}{step.assignedRunnerId ? ` · ${step.assignedRunnerId}` : ""}</span>{step.errorSummary && <small>{step.errorSummary}</small>}{step.artifacts.map((artifact) => <button key={artifact.id} onClick={() => void navigator.clipboard.writeText(JSON.stringify(artifact.payload, null, 2))}><strong>{artifact.title}</strong><small>{shortHash(artifact.sha256)} · 复制 JSON 工件</small></button>)}</div>)}</article>)}{!articleAgentRuns.length && <p>当前文章还没有排队或完成的执行器运行。</p>}</section>
          </div>
        </section>
        <div className="factory-grid">
          <aside className="recipe-list">{recipes.map((item) => <button key={item.id} className={item.id === recipe.id ? "active" : ""} onClick={() => setSelectedRecipeId(item.id)}><strong>{item.title}</strong><span>{item.steps.length} 个工位 · {item.topology === "fork-join" ? "并行汇合" : "顺序"}</span><p>{item.summary}</p></button>)}</aside>
          <main className="recipe-canvas"><div className="section-heading"><div><span className="eyebrow">配方 {recipe.version} · {recipe.topology === "fork-join" ? "fork/join" : "sequential"}</span><h2>{recipe.title}</h2><p>{recipe.selectionRule}</p></div><span>{activeBranch ? `绑定分支：${activeBranch.name}` : "先建立工作分支"}</span></div><div className="recipe-rail">{recipe.steps.map((step, index) => <article key={step.id} className="recipe-step"><div className="step-index">{String(index + 1).padStart(2, "0")}</div><div><span className={`actor ${step.actorKind}`}>{step.actorKind === "human" ? "人" : step.actorKind === "agent" ? `Agent${step.agentRole ? ` · ${step.agentRole}` : ""}` : "脚本"}</span>{step.parallelGroup && <small>并行组：{step.parallelGroup}</small>}<h3>{step.title}</h3><dl><div><dt>依赖</dt><dd>{step.dependsOn?.join("、") || (index ? "上一工位" : "无")}</dd></div><div><dt>写入范围</dt><dd>{step.writeScope === "branch-working-copy" ? "当前分支工作副本" : step.writeScope === "artifact-only" ? "独立工件" : "不写正文"}</dd></div><div><dt>输入</dt><dd>{step.input}</dd></div><div><dt>输出</dt><dd>{step.output}</dd></div><div><dt>完成声明</dt><dd>{step.completionClaim}</dd></div>{step.runnerAction && <div><dt>Runner</dt><dd>{step.runnerAction}</dd></div>}</dl>{step.capabilityId && <button className="text-link" onClick={() => { setSelectedCapabilityId(step.capabilityId!); setView("capabilities"); }}>查看能力入口 →</button>}</div></article>)}</div></main>
          <aside className="run-stack"><span className="eyebrow">生产运行</span>{!runs.length && <div className="run-empty"><strong>还没有运行实例</strong><p>启动后，每个工位都有独立状态和证据；技术完成不会自动签发文章批准。</p></div>}{runs.map((run) => <section key={run.id} className="production-run"><header><div><strong>{run.title}</strong><span>{formatTime(run.createdAt)} · 配方 {run.recipeVersion} · {shortHash(run.recipeSha256)}</span></div><em>{run.status}</em></header><div className="run-steps">{run.steps.map((step) => { const key = `${run.id}:${step.stepId}`; const activeAgentRun = articleAgentRuns.find((item) => item.productionRunId === run.id && item.productionStepId === step.stepId && ["queued", "running"].includes(item.state)); const isCoverStep = isInformationCoverRecipeStep(step.stepId) && (step.capabilityId === INFORMATION_COVER_CAPABILITY_ID || run.recipeId === "evidence-led-longform-v1"); return <div key={step.id} className={`run-step ${step.status}`}><div className="run-step-line"><i /><span><strong>{step.title}</strong><small>{step.agentRole || step.actorKind} · {step.status} · {step.writeScope === "branch-working-copy" ? "唯一正文写入" : step.writeScope === "artifact-only" ? "仅工件" : "只读"}</small></span></div>{step.dependsOn.length > 0 && <p>依赖：{step.dependsOn.join("、")}</p>}{step.evidence.length > 0 && <p>{step.evidence.at(-1)}</p>}{isCoverStep ? <textarea value={stepEvidence[key] ?? ""} onChange={(event) => setStepEvidence((current) => ({ ...current, [key]: event.target.value }))} placeholder="粘贴 wenmai.information-cover-evidence-receipt/2.0.0 结构化 JSON 回执" /> : <input value={stepEvidence[key] ?? ""} onChange={(event) => setStepEvidence((current) => ({ ...current, [key]: event.target.value }))} placeholder="工件路径、摘要或人工决定" />}<div><button onClick={() => void updateProductionStep(run.id, step.stepId, "blocked")}>阻塞</button>{isCoverStep ? <span className="executor-missing">封面 v2 四工位禁止跳过</span> : <button onClick={() => void updateProductionStep(run.id, step.stepId, "skipped")}>带理由跳过</button>}{step.actorKind === "human" && <button className="primary-button small" onClick={() => void updateProductionStep(run.id, step.stepId, "complete")}>人工完成</button>}{step.actorKind === "agent" && isCoverStep && <button className="primary-button small" disabled={step.status !== "active"} onClick={() => void updateProductionStep(run.id, step.stepId, "complete")}>核验外部封面工件完成</button>}{step.runnerAction && <button className="primary-button small" disabled={step.status !== "active" || Boolean(activeAgentRun)} onClick={() => void queueRunnerStep(run.id, step.stepId)}>{activeAgentRun ? `${activeAgentRun.state} · attempt ${activeAgentRun.steps.at(-1)?.attempt ?? 1}` : "排入本地 Runner"}</button>}{step.actorKind !== "human" && !step.runnerAction && !isCoverStep && <span className="executor-missing">尚无执行器；不能手工冒充完成</span>}</div></div>; })}</div></section>)}</aside>
        </div>
      </div>
    );
  };

  const renderCapabilities = () => {
    const selectedOverrideStatus = selectedCapability ? effectiveAdoption(selectedCapability) : "unassessed";
    return (
      <div className="view-page capability-page">
        <header className="page-heading"><div><span className="eyebrow">能力目录</span><h1>按制作阶段查找可用的能力与缺口</h1><p>{capabilities.stats.capabilities} 个元素来自本地入口索引。阶段图只按关键词和目录关系导航，不表示当前文章已经使用这些能力，也不表示它们之间存在真实依赖。</p></div><div className="view-switch" role="group" aria-label="能力目录视图"><button className={capabilityView === "flow" ? "active" : ""} onClick={() => setCapabilityView("flow")}>按阶段查看</button><button className={capabilityView === "table" ? "active" : ""} onClick={() => setCapabilityView("table")}>查看元素表</button></div></header>
        <div className="discovery-toolbar" aria-label="能力筛选">
          <label><span>搜索</span><input value={capabilityQuery} onChange={(event) => setCapabilityQuery(event.target.value)} placeholder="名称、用途、标签或 ID" /></label>
          <label><span>类型</span><select value={capabilityKind} onChange={(event) => setCapabilityKind(event.target.value)}><option value="all">全部类型</option><option value="skill">Skill</option><option value="gate">门禁</option><option value="checker">检查器</option><option value="workflow">工作流</option><option value="template">模板</option></select></label>
          <label><span>创作维度</span><select value={capabilityDimension} onChange={(event) => setCapabilityDimension(event.target.value)}><option value="all">全部维度</option>{capabilities.dimensions.map((dimension) => <option key={dimension.id} value={dimension.id}>{dimension.label}</option>)}</select></label>
          <label><span>成熟度</span><select value={capabilityMaturity} onChange={(event) => setCapabilityMaturity(event.target.value)}><option value="all">全部成熟度</option>{Object.entries(ADOPTION_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          <button className="clear-filter" onClick={() => { setCapabilityQuery(""); setCapabilityKind("all"); setCapabilityDimension("all"); setCapabilityMaturity("all"); }}>清空筛选</button>
          <output>{filteredCapabilities.length} / {capabilities.stats.capabilities}</output>
        </div>
        <div className="capability-layout">
          <main className={capabilityView === "flow" ? "capability-flow-map" : "periodic-table"}>
            {capabilityView === "table" ? capabilities.dimensions.map((dimension) => {
              const elements = filteredCapabilities.filter((item) => item.dimension === dimension.id);
              const gap = capabilities.gaps.find((item) => item.dimension === dimension.id);
              return <section key={dimension.id} className={`dimension-group gap-${gap?.severity ?? "low"}`}><header><span>{String(dimension.order + 1).padStart(2, "0")}</span><div><strong>{dimension.label}</strong><small>{dimension.question}</small></div></header><div className="element-grid">{elements.map((capability) => { const adoption = effectiveAdoption(capability); return <button key={capability.id} className={`capability-element ${capability.id === selectedCapability?.id ? "selected" : ""} adoption-${adoption}`} onClick={() => setSelectedCapabilityId(capability.id)}><span className="element-kind">{capability.kind === "skill" ? "SK" : capability.kind === "gate" ? "GT" : capability.kind === "checker" ? "CK" : capability.kind === "workflow" ? "WF" : "TP"}</span><strong>{capability.name}</strong><small>{ADOPTION_LABELS[adoption]}</small>{capability.availability === "available" && <i title="入口可找到" />}</button>; })}{!elements.length && <div className="empty-element"><span>当前索引未发现入口</span><button onClick={() => void createWorkItem({ title: `补齐“${dimension.label}”创作能力`, stage: "commission", sourceCapabilityId: `gap:${dimension.id}`, nextAction: gap?.nextAction })}>创建补全任务</button></div>}</div>{gap && <footer><span className={`severity ${gap.severity}`}>{gap.severity === "high" ? "高缺口" : gap.severity === "medium" ? "待补全" : "需审计"}</span><p>{gap.rationale}</p><button onClick={() => void createWorkItem({ title: `审计“${dimension.label}”能力覆盖`, stage: "commission", sourceCapabilityId: gap.id, nextAction: gap.nextAction })}>转为工作项</button></footer>}</section>;
            }) : <div className="capability-flow-view">
              <nav className="capability-flow-overview" aria-label="八阶段能力全景">
                {STAGES.map((stage, index) => {
                  const stageCapabilities = filteredCapabilities.filter((capability) => capability.stages.includes(stage.id));
                  const adopted = stageCapabilities.filter((capability) => ["verified", "adopted"].includes(effectiveAdoption(capability))).length;
                  return <button key={stage.id} type="button" onClick={() => document.getElementById(`capability-stage-${stage.id}`)?.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "start" })}><span>{String(index + 1).padStart(2, "0")}</span><strong>{stage.label}</strong><small>{stageCapabilities.length} 项 · {adopted} 已验证</small>{index < STAGES.length - 1 && <i aria-hidden="true">→</i>}</button>;
                })}
              </nav>
              <div className="capability-flow-rail">
                <aside className="flow-inference-note"><strong>索引推断视图</strong><span>上方全景始终显示全部 8 个阶段；下方展开入口与缺口。当前文章真实走到哪一步，请看“创作工厂”的生产运行。</span><button onClick={() => setView("factory")}>打开真实运行 →</button></aside>
                {STAGES.map((stage, index) => {
                  const stageCapabilities = filteredCapabilities.filter((capability) => capability.stages.includes(stage.id));
                  const adopted = stageCapabilities.filter((capability) => ["verified", "adopted"].includes(effectiveAdoption(capability))).length;
                  return <section id={`capability-stage-${stage.id}`} key={stage.id} className="flow-stage"><header><span>{stage.short}</span><div><strong>{stage.label}</strong><small>{stage.deliverable}</small></div><em>{stageCapabilities.length}</em></header><div className="flow-stage-elements">{stageCapabilities.slice(0, 10).map((capability) => <button key={capability.id} className={capability.id === selectedCapability?.id ? "selected" : ""} onClick={() => setSelectedCapabilityId(capability.id)}><i>{capability.kind === "skill" ? "SK" : capability.kind === "gate" ? "GT" : capability.kind === "checker" ? "CK" : capability.kind === "workflow" ? "WF" : "TP"}</i><span><strong>{capability.name}</strong><small>{ADOPTION_LABELS[effectiveAdoption(capability)]}</small></span></button>)}{stageCapabilities.length > 10 && <button className="flow-more" onClick={() => { setCapabilityView("table"); setCapabilityDimension("all"); }}>＋ {stageCapabilities.length - 10} 个</button>}{!stageCapabilities.length && <div className="flow-gap"><strong>当前筛选未命中</strong><button onClick={() => void createWorkItem({ title: `补齐“${stage.label}”环节能力`, stage: "commission", nextAction: `确认${stage.deliverable}所需 Skill、模板与门禁` })}>建立补全任务</button></div>}</div><footer><span>{adopted} 个已验证/采用</span>{index < STAGES.length - 1 && <i aria-hidden="true">→</i>}</footer></section>;
                })}
              </div>
            </div>}
          </main>
          <aside className="capability-inspector">
            {selectedCapability ? <>
              <div className="capability-symbol"><span>{selectedCapability.kind.slice(0, 2).toUpperCase()}</span><em>{capabilities.dimensions.find((item) => item.id === selectedCapability.dimension)?.label}</em></div>
              <h2>{selectedCapability.name}</h2><code>{selectedCapability.id}</code><p>{selectedCapability.description}</p>
              <dl className="compact-facts"><div><dt>入口</dt><dd>{selectedCapability.availability === "available" ? "可找到" : selectedCapability.availability}</dd></div><div><dt>索引成熟度</dt><dd>{ADOPTION_LABELS[selectedCapability.indexedAdoption]}</dd></div><div><dt>当前决定</dt><dd>{ADOPTION_LABELS[selectedOverrideStatus]}</dd></div><div><dt>来源新鲜度</dt><dd>{selectedCapability.freshness ?? "未审计"}</dd></div></dl>
              {selectedCapability.maturityScope && <div className="scope-contract"><strong>成熟度只在这个范围成立</strong><p>{selectedCapability.maturityScope}</p></div>}
              <section><span className="eyebrow">入口与脚本</span><button className="path-copy" onClick={() => { void navigator.clipboard.writeText(selectedCapability.entryPath); showToast("入口路径已复制"); }}><code>{selectedCapability.entryPath}</code><span>复制</span></button>{selectedCapability.scripts.slice(0, 8).map((script) => <button key={script} className="path-copy compact" onClick={() => void navigator.clipboard.writeText(script)}><code>{script}</code><span>复制</span></button>)}</section>
              <section><span className="eyebrow">输入 / 输出合同</span><ul>{selectedCapability.gateInput.map((item) => <li key={item}>输入：{item}</li>)}{selectedCapability.gateOutput.map((item) => <li key={item}>输出：{item}</li>)}</ul></section>
              <section><span className="eyebrow">原素材关联</span><div className="material-list">{selectedCapability.materials.slice(0, 20).map((material) => material.kind === "url" ? <a key={material.id} href={material.locator} target="_blank" rel="noreferrer"><span>{material.label}</span><em>{material.relation === "explicit" ? "显式" : "推断"}</em></a> : <button key={material.id} onClick={() => { void navigator.clipboard.writeText(material.locator); showToast("材料路径已复制"); }}><span>{material.label}</span><em>{material.relation === "explicit" ? "显式" : "推断"}{material.exists === false ? " · 失联" : ""}</em></button>)}</div>{!selectedCapability.materials.length && <p>入口文件没有被当前索引解析出材料关系。</p>}</section>
              <section className="maturity-editor"><span className="eyebrow">人工成熟度决定</span><label>状态<select value={capStatus} onChange={(event) => setCapStatus(event.target.value as CapabilityAdoption)}>{Object.entries(ADOPTION_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label>范围与理由<textarea value={capNotes} onChange={(event) => setCapNotes(event.target.value)} /></label><label>任务/测试证据<input value={capEvidence} onChange={(event) => setCapEvidence(event.target.value)} placeholder="路径、运行 ID 或报告" /></label><label>回归入口<input value={capRegression} onChange={(event) => setCapRegression(event.target.value)} placeholder="adopted 必填" /></label><label className="check-label"><input type="checkbox" checked={capFavorite} onChange={(event) => setCapFavorite(event.target.checked)} />固定到常用能力</label><button className="primary-button" onClick={() => void saveCapabilityDecision()}>保存决定</button><small>tested / verified / adopted 必须有证据；adopted 还必须有回归入口。</small></section>
            </> : <p>选择一个能力元素查看详情。</p>}
          </aside>
        </div>
      </div>
    );
  };

  const renderLineage = () => {
    const nodes = lineageSnapshot?.nodes ?? [];
    const edges = lineageSnapshot?.edges ?? [];
    const nodeById = new Map(nodes.map((node) => [node.id, node]));
    const evidenceById = new Map((lineageSnapshot?.evidence ?? []).map((item) => [item.id, item]));
    const seedArticle = corpus.articles.find((article) => article.id === lineageSeed);
    const rootNode = nodeById.get(lineageSeed);
    const membershipEdges = edges.filter((edge) => edge.relationType === "artifact_of" && edge.target === lineageSeed);
    const artifactNodes = membershipEdges.map((edge) => nodeById.get(edge.source)).filter((node): node is LineageNode => Boolean(node));
    const relationEdges = edges.filter((edge) => edge.relationType !== "artifact_of");
    return <div className="lineage-browser">
      <div className="lineage-toolbar">
        <label><span>文章身份</span><select value={lineageSeed} onChange={(event) => setLineageSeed(event.target.value)}>{corpus.articles.map((article) => <option key={article.id} value={article.id}>{article.title} · {CORPUS_CLASS_LABELS[article.classification.class]}</option>)}</select></label>
        <label><span>证据状态</span><select value={lineageStatusFilter} onChange={(event) => setLineageStatusFilter(event.target.value as typeof lineageStatusFilter)}><option value="all">全部状态</option><option value="confirmed">已确认关系</option><option value="suggested">待确认关系</option></select></label>
        <label><span>关系类型</span><select value={lineageRelationFilter} onChange={(event) => setLineageRelationFilter(event.target.value)}><option value="all">全部关系</option>{corpus.developmentTree.relationTypes.map((item) => <option key={item.type} value={item.type}>{item.type}</option>)}</select></label>
        <label><span>展开层级</span><select value={lineageDepth} onChange={(event) => setLineageDepth(Number(event.target.value))}><option value={1}>1 层</option><option value={2}>2 层</option><option value={3}>3 层</option></select></label>
        <button onClick={() => void loadLineage()}>重新读取</button>
      </div>
      {lineageError && <div className="operation-error" role="alert"><span>{lineageError}</span><button onClick={() => setLineageError("")}>关闭</button></div>}
      <section className="lineage-summary"><div><span className="eyebrow">Development Tree</span><h2>从文章身份追到制品、来源、QA、包与发布证据</h2><p>实线关系来自哈希计算或精确 manifest；虚线关系仍待人工确认。目录名和时间顺序不会自动变成事实。</p></div><dl><div><dt>全库节点</dt><dd>{corpus.developmentTree.counts.nodes}</dd></div><div><dt>全库关系</dt><dd>{corpus.developmentTree.counts.edges}</dd></div><div><dt>已确认</dt><dd>{corpus.developmentTree.counts.confirmed}</dd></div><div><dt>待确认</dt><dd>{corpus.developmentTree.counts.suggested}</dd></div></dl></section>
      <p className="lineage-filter-note">筛选关系或证据状态时，文章到制品的 <code>artifact_of</code> 归属桥始终保留，避免局部树失去入口；筛选只作用于制品之后的关系。</p>
      {lineageState === "loading" && <div className="lineage-loading">正在按当前证据条件展开局部开发树…</div>}
      {lineageState !== "loading" && rootNode && <div className="lineage-canvas">
        <section className="lineage-root-node"><span>文章身份</span><h3>{rootNode.label}</h3><p>{seedArticle ? CORPUS_CLASS_LABELS[seedArticle.classification.class] : rootNode.classification ? CORPUS_CLASS_LABELS[rootNode.classification.class] : "未分类"}</p>{seedArticle && <div><ArticleQuickLink articleId={seedArticle.id}>预览文章</ArticleQuickLink>{["published_article", "platform_build", "import_artifact", "draft_or_intermediate"].includes(seedArticle.classification.class) && <button onClick={() => requestArticleSelection(seedArticle.id, "project")}>打开工程</button>}</div>}<small>{rootNode.id}</small></section>
        <div className="lineage-main-trunk"><i /><span>{membershipEdges.length} 个版本制品</span></div>
        <div className="lineage-artifact-branches">{artifactNodes.map((artifact) => {
          const artifactRelations = relationEdges.filter((edge) => edge.source === artifact.id || edge.target === artifact.id);
          return <article key={artifact.id} className="lineage-artifact-node"><header><span>{artifact.classification ? CORPUS_CLASS_LABELS[artifact.classification.class] : "Artifact"}</span><strong>{artifact.label}</strong><code>{artifact.sha256?.slice(0, 12) ?? artifact.id}</code></header><div className="lineage-relations">{artifactRelations.slice(0, 16).map((edge) => {
            const otherId = edge.source === artifact.id ? edge.target : edge.source;
            const other = nodeById.get(otherId);
            const evidence = edge.evidenceRefs.map((id) => evidenceById.get(id)).filter(Boolean);
            return <details key={edge.id} className={edge.status}><summary><i /><span><em>{edge.relationType}</em><strong>{other?.label ?? otherId}</strong></span><mark>{edge.status === "confirmed" ? "已确认" : "待确认"}</mark></summary><div><p>{edge.source === artifact.id ? "本制品 → 关联对象" : "关联对象 → 本制品"} · {edge.basis}</p>{evidence.map((item) => <small key={item?.id}>{item?.claim}<br />{item?.sourcePath}{item?.locator ? `#${item.locator}` : ""}</small>)}</div></details>;
          })}{!artifactRelations.length && <p>当前展开层级没有更多已索引关系。</p>}</div></article>;
        })}{!artifactNodes.length && <div className="lineage-empty"><strong>当前筛选没有展开出制品</strong><p>切回“全部关系”，或把展开层级提高到 2–3 层。文章身份与制品的 `artifact_of` 必须存在，才可形成可走通的开发树。</p></div>}</div>
        {lineageSnapshot?.truncated && <p className="lineage-truncated">局部图达到读取上限；请缩小关系类型或降低展开层级。</p>}
      </div>}
    </div>;
  };

  const renderLibrary = () => (
    <div className="view-page library-page library-v2">
      <header className="page-heading"><div><span className="eyebrow">内容图书馆</span><h1>按用途归档，也能沿开发树追到每一个制品</h1><p>{libraryRemotePage ? `共 ${libraryRemotePage.total} 项；本页最多24项，当前第 ${libraryRemotePage.page} 页。` : `${libraryArticles.length} 个当前结果按 12 类证据规则投影为 7 个书架；分类与关系都保留依据，不覆盖源文件。`}</p></div><div className="view-switch" role="group" aria-label="资料库视图"><button className={libraryMode === "shelves" ? "active" : ""} onClick={() => setLibraryMode("shelves")}>分类书架</button><button className={libraryMode === "lineage" ? "active" : ""} onClick={() => setLibraryMode("lineage")}>开发树</button></div></header>
      {libraryMode === "shelves" && <div className="library-page-status" aria-live="polite">{libraryPageState === "loading" && "正在按页读取资料库…"}{libraryPageState === "error" && <span role="alert">{libraryRemoteError}</span>}</div>}
      {libraryMode === "shelves" && <>
      <div className="discovery-toolbar library-toolbar" aria-label="资料库筛选">
        <label className="wide-search"><span>搜索</span><input value={articleQuery} onChange={(event) => setArticleQuery(event.target.value)} placeholder="标题、标签、平台、版本名或摘要" /></label>
        <label><span>资料分区</span><select value={libraryBucketFilter} onChange={(event) => setLibraryBucketFilter(event.target.value as "all" | LibraryBucket)}><option value="all">全部分区</option>{LIBRARY_BUCKETS.map((bucket) => <option key={bucket} value={bucket}>{bucket}</option>)}</select></label>
        <label><span>资产类型</span><select value={libraryKind} onChange={(event) => setLibraryKind(event.target.value)}><option value="all">全部类型</option>{[...new Set(workspaceArticles.map((article) => article.kind))].map((kind) => <option key={kind} value={kind}>{kind}</option>)}</select></label>
        <label><span>创作状态</span><select value={libraryState} onChange={(event) => setLibraryState(event.target.value)}><option value="all">全部状态</option>{[...new Set(workspaceArticles.map((article) => article.editorialState))].map((state) => <option key={state} value={state}>{state}</option>)}</select></label>
        <label><span>平台</span><select value={libraryPlatform} onChange={(event) => setLibraryPlatform(event.target.value)}><option value="all">全部平台</option>{[...new Set(workspaceArticles.flatMap((article) => article.platforms))].sort().map((platform) => <option key={platform} value={platform}>{platform}</option>)}</select></label>
        <button className="clear-filter" onClick={() => { setArticleQuery(""); setLibraryBucketFilter("all"); setLibraryKind("all"); setLibraryState("all"); setLibraryPlatform("all"); }}>清空筛选</button>
      </div>
      <section className="identity-cleanup-console" aria-labelledby="identity-cleanup-heading">
        <header><div><span className="eyebrow">文章身份与分支卫生</span><h2 id="identity-cleanup-heading">把相似稿、旧根、修订和未合入分支分开管理</h2></div><div className="identity-cleanup-actions"><span>{identityCatalogState === "loading" ? "正在读取 D1 身份目录…" : identityCatalogState === "unavailable" ? "身份目录暂不可用" : `${identityCatalog?.counts.active ?? 0} 个活动根 · ${identityCatalog?.counts.hidden ?? 0} 个隐藏旧根 · ${identityCatalog?.counts.pendingCandidates ?? 0} 个待确认`}</span><button disabled={identityCatalogState !== "ready" || identityActionState !== "idle"} onClick={() => void scanIdentityCandidates()}>{identityActionState === "scanning" ? "扫描中…" : "重新扫描相似文章"}</button></div></header>
        <p>语料版本是只读文件证据；D1（本地数据库）中的修订记录写作历史；只有存在多条活动分支或合并提案时，才算“未合入”。相似度只生成候选，确认前不会归档、合并或改变发布记录。</p>
        <aside className={`lineage-ai-status ${lineageAiStatus?.provider.ready && lineageAiStatus.invocationSchemaReady ? "ready" : "not-ready"}`}>
          <div><span>DeepSeek 血缘审阅</span><strong>{lineageAiStatus?.provider.ready ? `${lineageAiStatus.provider.model} 已配置` : "服务端尚未就绪"}</strong></div>
          <p>{lineageAiStatus?.invocationSchemaReady ? "只审阅冻结的候选与有界差异摘要；输出永远只是候选，不会自动合并、归档或修改正文。" : "模型审阅迁移尚未就绪；相似扫描与人工计划仍可正常使用。"}</p>
          <dl><div><dt>已准备</dt><dd>{lineageAiStatus?.counts.prepared ?? 0}</dd></div><div><dt>模型候选</dt><dd>{lineageAiStatus?.counts.candidateReviews ?? 0}</dd></div><div><dt>自动付费探针</dt><dd>{lineageAiStatus?.paidNetworkProbePerformed ? "已运行" : "未运行"}</dd></div></dl>
        </aside>
        {lineageAiMessage && <div className="lineage-ai-message" role="status"><span>{lineageAiMessage}</span><button onClick={() => setLineageAiMessage("")}>关闭</button></div>}
        {lineageAiPreparation && <article className="lineage-ai-preparation"><div><strong>本地输入已冻结，尚未出网</strong><span>{lineageAiPreparation.inputTokenEstimate.toLocaleString("zh-CN")} 估算 Token · 费用硬上限 ¥{(lineageAiPreparation.budgetEstimate.maxCostCnyMicros / 1_000_000).toFixed(2)}</span><code>{lineageAiPreparation.inputSha.slice(0, 16)}</code></div><button disabled={lineageAiState !== "idle" || !lineageAiStatus?.provider.ready || !lineageAiStatus?.invocationSchemaReady} onClick={() => void runLineageAiReview()}>{lineageAiState === "running" ? "审阅中…" : "确认预算并调用 DeepSeek"}</button></article>}
        {identityActionError && <div className="identity-cleanup-error" role="alert"><span>{identityActionError}</span><button onClick={() => setIdentityActionError("")}>关闭</button></div>}
        {staleIdentityOperations.length > 0 && <div className="stale-identity-operation-list" aria-label="已失效的整理计划">
          {staleIdentityOperations.map((operation) => <article key={operation.operationId}><div><strong>发现已被后续事实取代的整理计划</strong><span>{operation.terminalProof.appliedOperation ? `同一候选已由 ${operation.terminalProof.appliedOperation.operationId} 应用` : `候选已进入 ${operation.terminalProof.candidate?.status ?? "终态"}`}</span><code>{operation.operationId} · {operation.planSha256.slice(0, 16)}</code></div><button disabled={identityActionState !== "idle"} onClick={() => void supersedeStaleIdentityOperation(operation)}>保留审计并标为已替代</button></article>)}
        </div>}
        {identityPlan && <article className="identity-plan-ready"><div><strong>可回滚整理计划已冻结</strong><span>{identityPlan.legacyArticleId} → {identityPlan.canonicalArticleId}</span><code>{identityPlan.planSha256.slice(0, 16)}</code></div><button disabled={identityActionState !== "idle"} onClick={() => void applyIdentityPlan()}>{identityActionState === "applying" ? "应用中…" : "检查并应用计划"}</button></article>}
        {sourceOwnerPlan && <article className="identity-plan-ready source-owner-plan"><div><strong>语料归属修复计划已冻结</strong><span>{sourceOwnerPlan.mismatch.sourceArticleId} → {sourceOwnerPlan.mismatch.currentOwnerArticleId}</span><code>{sourceOwnerPlan.planSha256.slice(0, 16)}</code></div><button disabled={identityActionState !== "idle"} onClick={() => void applySourceOwnerRepair()}>{identityActionState === "applying" ? "修复中…" : "检查并修复归属"}</button></article>}
        {sourceOwnerMismatches.length > 0 && <div className="source-owner-mismatch-list" aria-label="语料归属错误">
          {sourceOwnerMismatches.map((mismatch) => <article key={mismatch.sourceBranchId}>
            <div><span>语料归属错绑</span><em>{mismatch.evidence.bodyShaMatchesOwnerTextHash && mismatch.evidence.branchBaseSourceMatchesRevisionSource ? "精确哈希证据" : "需要人工复核"}</em></div>
            <h3><code>{mismatch.sourceArticleId}</code><i>→</i><strong>{mismatch.currentOwnerTitle}</strong></h3>
            <p>Branch 绑定了 <code>{mismatch.sourceVersionId}</code>，但当前 Article 不是该源版本的唯一 owner。正文 SHA 与语料 textHash {mismatch.evidence.bodyShaMatchesOwnerTextHash ? "完全一致" : "不一致"}；工作副本{mismatch.lock.workingCopyDirty ? "仍有未保存修改" : "已清洁"}。</p>
            <dl><div><dt>错误 Branch</dt><dd>{mismatch.sourceBranchId}</dd></div><div><dt>正确 Article</dt><dd>{mismatch.currentOwnerArticleId}</dd></div><div><dt>Revision</dt><dd>{mismatch.sourceRevisionId}</dd></div></dl>
            <button disabled={identityActionState !== "idle" || Boolean(sourceOwnerPlan) || !mismatch.evidence.bodyShaMatchesOwnerTextHash || mismatch.lock.workingCopyDirty === true} onClick={() => void planSourceOwnerRepair(mismatch)}>生成可回滚归属修复计划</button>
          </article>)}
        </div>}
        <div className="identity-root-grid">
          {(identityCatalog?.localArticles ?? []).filter((article) => article.catalogState === "active").slice(0, 12).map((article) => <article key={article.articleId}><div><strong>{article.title}</strong><em>{article.identityRole === "canonical" ? "当前根" : article.identityRole === "legacy_root" ? "旧根" : "未归组"}</em></div><dl><div><dt>Revision</dt><dd>{article.revisionCount}</dd></div><div><dt>Branch</dt><dd>{article.activeBranchCount} 活动 / {article.archivedBranchCount} 归档</dd></div><div><dt>未合入</dt><dd>{article.unmergedBranchCount}</dd></div><div><dt>工作副本</dt><dd>{article.dirtyWorkingCopyCount ? `${article.dirtyWorkingCopyCount} 个未保存` : "已清洁"}</dd></div></dl></article>)}
        </div>
        {(identityCatalog?.candidates.length ?? 0) > 0 && <div className="identity-candidate-list">{identityCatalog!.candidates.map((candidate) => {
          const source = identityCatalog!.localArticles.find((article) => article.articleId === candidate.sourceArticleId);
          const target = identityCatalog!.localArticles.find((article) => article.articleId === candidate.targetArticleId);
          const modelReview = lineageAiReviews.find((review) => review.candidateId === candidate.id && review.output);
          return <article key={candidate.id}><div><span>{candidate.proposedRelation}</span><em>{candidate.score === null ? "未评分" : `${(candidate.score * 100).toFixed(1)}%`}</em></div><h3>{source?.title ?? candidate.sourceArticleId}<i>→</i>{target?.title ?? candidate.targetArticleId}</h3><p>两端 Revision 与正文 SHA 已冻结；需要先生成计划，再单独确认应用。</p>{modelReview?.output && <blockquote><strong>DeepSeek 候选：{modelReview.output.relationRecommendation} · {(modelReview.output.confidence * 100).toFixed(0)}%</strong><span>{modelReview.output.reasons[0] ?? "没有补充理由"}</span><em>下一步：{modelReview.output.nextStep}</em></blockquote>}<div className="identity-candidate-actions"><button disabled={identityActionState !== "idle" || Boolean(identityPlan)} onClick={() => void planIdentityCandidate(candidate)}>生成可回滚整理计划</button><button disabled={lineageAiState !== "idle" || Boolean(lineageAiPreparation) || Boolean(modelReview) || !lineageAiStatus?.provider.ready || !lineageAiStatus?.invocationSchemaReady} onClick={() => void prepareLineageAiReview(candidate)}>{lineageAiState === "preparing" ? "冻结中…" : modelReview ? "已有模型候选" : "准备 DeepSeek 审阅"}</button></div></article>;
        })}</div>}
      </section>
      {pendingArticleRelations.length > 0 && <section className="lineage-candidate-queue" aria-labelledby="lineage-candidate-heading">
        <header><div><span className="eyebrow">待整理 · 相似与血缘候选</span><h2 id="lineage-candidate-heading">{pendingArticleRelations.length} 组关系需要看证据，不会自动合并</h2></div><p>这里集中展示跨 Article 的候选关系。相似度、目录邻近和模型结论都只能提出候选；确认前不会改变主书架、分支或发布记录。</p></header>
        <div>{pendingArticleRelations.slice(0, 18).map((relation) => {
          const source = corpusArticleById.get(relation.sourceArticleId);
          const target = corpusArticleById.get(relation.targetArticleId);
          if (!source || !target) return null;
          return <article key={relation.id}><div><span>{relation.relationType}</span><em>{relation.confidence === "high" ? "高信号" : relation.confidence === "medium" ? "中信号" : "低信号"}</em></div><h3><ArticleQuickLink articleId={source.id}>{source.title}</ArticleQuickLink><i>→</i><ArticleQuickLink articleId={target.id}>{target.title}</ArticleQuickLink></h3><p>{relation.basis} · {relation.evidenceRefs.length} 条证据引用</p><button onClick={() => { setLineageSeed(source.id); setLibraryMode("lineage"); }}>查看局部开发树</button></article>;
        })}</div>
      </section>}
      <div className="library-overview">{LIBRARY_BUCKETS.map((bucket) => <button key={bucket} className={libraryBucketFilter === bucket ? "active" : ""} aria-pressed={libraryBucketFilter === bucket} onClick={() => { setLibraryBucketFilter((current) => current === bucket ? "all" : bucket); setLibraryKind("all"); setLibraryState("all"); setLibraryPlatform("all"); }}><strong>{libraryRemotePage?.facets.bucket?.[bucket] ?? workspaceArticles.filter((article) => libraryBucket(article) === bucket).length}</strong><span>{bucket}</span><em>{libraryBucketFilter === bucket ? "正在筛选" : "查看这一类"}</em></button>)}</div>
      <div className="library-group-stack">
        {libraryGroups.map((group) => <section key={group.bucket} id={`library-${group.bucket}`} className="library-group"><header><div><span className="eyebrow">{group.bucket}</span><h2>{group.articles.length} 项</h2></div><p>{group.bucket === "已发布文章" ? "只有精确制品绑定与发布状态证据才能进入；公开可见仍单独记录。" : group.bucket === "平台成品" ? "面向平台的构建与导入件，但尚不能据此声称已经发布。" : group.bucket === "创作草稿" ? "工作稿、候选稿和中间稿；适合继续建立文章工程。" : group.bucket === "来源素材" ? "采访、论文与原始输入，默认只读。" : group.bucket === "研究与质检" ? "调研、治理、测试和 QA，不与对外文章混放。" : group.bucket === "能力与工具" ? "Skill、门禁总结、提示词和生产工具。" : "manifest、发布证据与仍未绑定的目录记录。"}</p></header><div className="library-shelf">{group.articles.map((article) => { const canOpenProject = trustedLocalProjectArticleIds.has(article.id); return <article key={article.id} className={article.id === selectedArticle.id ? "active" : ""}><div className="library-card-kind"><span>{CORPUS_CLASS_LABELS[article.classification.class]}</span><em>{article.classification.confidence === "high" ? "高证据" : article.classification.confidence === "medium" ? "中证据" : "低证据"}</em></div><h3>{article.title}</h3><p>{article.summary || "当前索引没有摘要。"}</p><div className="library-tags">{article.tags.slice(0, 5).map((tag) => <span key={tag}>{tag}</span>)}</div><dl><div><dt>版本</dt><dd>{article.versionCount}</dd></div><div><dt>平台</dt><dd>{article.platforms.join("、") || "未记录"}</dd></div><div><dt>依据</dt><dd title={article.classification.basis}>{article.classification.basis}</dd></div></dl><div className="library-card-actions"><ArticleQuickLink articleId={article.id}>预览全文</ArticleQuickLink><button disabled={!canOpenProject} title={canOpenProject ? "" : "只读语料，尚未建立本地文章工程"} onClick={() => canOpenProject && requestArticleSelection(article.id, "project")}>打开工程</button>{!canOpenProject && <span>只读语料，尚未建立本地文章工程</span>}<button onClick={() => { setLineageSeed(article.id); setLibraryMode("lineage"); }}>查看开发树</button></div></article>; })}</div></section>)}
        {!libraryGroups.length && libraryPageState !== "loading" && <section className="library-empty"><strong>没有符合条件的资料</strong><p>清空一个筛选项，或换用更宽的关键词。</p></section>}
        {libraryCursorHistory.length > 0 && <button className="library-load-more" disabled={libraryPageState === "loading"} onClick={() => void loadLibraryPage(libraryCursorHistory[libraryCursorHistory.length - 1] ?? null, libraryCursorHistory.slice(0, -1), Math.max(1, (libraryRemotePage?.page ?? 1) - 1))}>上一页</button>}
        {libraryRemotePage?.hasMore && libraryRemotePage.nextCursor && <button className="library-load-more" disabled={libraryPageState === "loading"} onClick={() => void loadLibraryPage(libraryRemotePage.nextCursor, [...libraryCursorHistory, libraryCurrentCursor], (libraryRemotePage.page ?? 1) + 1)}>下一页（替换当前 24 项）</button>}
        {libraryRemotePage && libraryRemotePage.page > 1 && <button className="library-load-more" disabled={libraryPageState === "loading"} onClick={() => void loadLibraryPage(null, [], 1)}>回第一页</button>}
      </div>
      <aside className="library-insights"><section><span className="eyebrow">选题候选</span>{corpus.opportunities.length ? corpus.opportunities.slice(0, 8).map((opportunity) => { const relatedArticles = opportunity.relatedArticleIds.map((articleId) => corpusArticleById.get(articleId)).filter((article): article is WorkbenchArticle => Boolean(article)).slice(0, 4); return <article key={opportunity.id}><strong>{opportunity.title}</strong><p>{opportunity.rationale}</p>{relatedArticles.length > 0 && <div className="insight-article-links"><span>形成这个判断的已有文章</span>{relatedArticles.map((article) => <ArticleQuickLink key={article.id} articleId={article.id}>{article.title}</ArticleQuickLink>)}</div>}<button onClick={() => void createWorkItem({ title: opportunity.title, stage: "commission", nextAction: opportunity.nextAction })}>建立委托任务</button></article>; }) : <p>按需加载/暂无已载入建议。</p>}</section><section><span className="eyebrow">系列构想</span>{corpus.seriesSuggestions.length ? corpus.seriesSuggestions.slice(0, 6).map((series) => { const seriesArticles = series.articleIds.map((articleId) => corpusArticleById.get(articleId)).filter((article): article is WorkbenchArticle => Boolean(article)).slice(0, 6); return <article key={series.id}><strong>{series.title}</strong><p>规则命中 {series.existingTitles.length} 个已有题名；仍需人工确认系列主线。</p>{seriesArticles.length > 0 && <div className="insight-article-links"><span>系列中的真实文章</span>{seriesArticles.map((article) => <ArticleQuickLink key={article.id} articleId={article.id}>{article.title}</ArticleQuickLink>)}</div>}</article>; }) : <p>按需加载/暂无已载入建议。</p>}</section></aside>
      </>}
      {libraryMode === "lineage" && renderLineage()}
    </div>
  );

  const renderEvidence = () => {
    const currentRuns = workspace.gateRuns.filter((run) => run.articleId === selectedArticle.id);
    const currentFreshRuns = currentRuns.filter((run) => !gateRunIsStale(run, activeCopy));
    return <div className="view-page evidence-page evidence-v2">
      <header className="page-heading"><div><span className="eyebrow">证据与检查</span><h1>确认这篇文章现在有哪些依据</h1><p>先处理存储与当前输入检查，再按需查看变更记录和数据来源；每类证据只说明它能支持的事实。</p></div><button className="primary-button" disabled={storageProbe === "running"} onClick={() => void runStorageProbe()}>{storageProbe === "running" ? "正在检查并清理…" : storageProbe === "pass" ? "D1 读写检查已通过" : "检查本地存储"}</button></header>
      <nav className="evidence-tabs" aria-label="证据与检查分区">{([['guide', '下一步'], ['events', '变更记录'], ['gates', '检查结果'], ['sources', '数据来源']] as const).map(([id, label]) => <button key={id} className={evidenceView === id ? "active" : ""} onClick={() => setEvidenceView(id)}>{label}</button>)}</nav>
      {evidenceView === "guide" && <div className="evidence-guide">
        <section className="health-strip"><article><span>本地工作区</span><strong>{workspaceState === "ready" ? "已连接" : workspaceState === "loading" ? "检查中" : "不可用"}</strong><p>{workspace.branches.length} 条分支 · {workspace.workItems.length} 个工作项</p></article><article><span>历史语料索引</span><strong>{formatTime(corpus.generatedAt)}</strong><p>{corpus.stats.sourceFiles} 个源文件 · 只读</p></article><article><span>能力索引</span><strong>{capabilities.stats.capabilities} 个元素</strong><p>{formatTime(capabilities.generatedAt)} · 可找到不等于已采用</p></article><article><span>当前文章检查</span><strong>{currentFreshRuns.length} 项对当前输入有效</strong><p>{currentRuns.length - currentFreshRuns.length} 项因正文或基线变化已过期</p></article></section>
        <section className="evidence-actions"><header><span className="eyebrow">从这里开始</span><h2>选择要确认的对象和证据</h2></header><div><button onClick={() => void runStorageProbe()}><strong>保存或刷新出现异常</strong><span>检查 D1 读写与冲突恢复；不会替代正文或发布检查。</span><em>检查存储 →</em></button><button onClick={() => setEvidenceView("gates")}><strong>检查这篇文章能否进入下一步</strong><span>查看绑定当前标题、正文摘要和修订的检查结果。</span><em>查看检查结果 →</em></button><button onClick={() => setEvidenceView("events")}><strong>查看谁在什么时候改了什么</strong><span>按时间查看分支、修订、工作项、门禁和 Agent 事件。</span><em>查看变更 →</em></button><button onClick={() => setEvidenceView("sources")}><strong>追溯一个状态的来源</strong><span>查看只读索引、D1 决定和推断关系的优先级。</span><em>查看数据来源 →</em></button></div></section>
        <section className="evidence-boundary"><strong>证据边界</strong><p>文件存在只能证明工件存在；检查通过只能证明规则对同一输入成立。人工批准、平台已接受提交、后台记录已核验和公开页面已核验，始终是不同层级的证据。</p></section>
      </div>}
      {evidenceView === "events" && <section className="evidence-panel"><header><div><span className="eyebrow">变更记录</span><h2>当前文章最近发生了什么</h2></div><span>{workspace.events.length} 条已载入事件</span></header><div className="event-log readable">{workspace.events.slice(0, 100).map((event) => { const readable = workspaceEventSummary(event); return <article key={event.id}><i /><div><strong>{readable.title}</strong><p>{readable.summary}</p><details><summary>技术详情</summary><small>{event.eventType} · {event.subjectType}:{event.subjectId}<br />{JSON.stringify(event.payload)}</small></details></div><span>{formatTime(event.createdAt)}<br />输入 {shortHash(event.inputSha256)}</span></article>; })}{!workspace.events.length && <p>这篇文章还没有工作区事件。</p>}</div></section>}
      {evidenceView === "gates" && <section className="evidence-panel"><header><div><span className="eyebrow">检查结果</span><h2>结果按“当前有效 / 已过期”分开</h2></div>{activeCopy && <button className="primary-button small" onClick={() => void runGates()}>对当前输入运行 4 项</button>}</header><div className="gate-audit-list">{currentRuns.slice(0, 60).map((run: GateRun) => { const stale = gateRunIsStale(run, activeCopy); return <article key={run.id} className={`gate-audit ${run.result} ${stale ? "stale" : ""}`}><div><span>{stale ? "历史结果" : "当前输入"}</span><strong>{run.gateLabel}</strong><p>{run.evidence.join(" ") || "没有证据说明。"}</p></div><dl><div><dt>判断</dt><dd>{stale ? "已过期" : run.result === "pass" ? "通过" : run.result === "fail" ? "失败" : "证据不足"}</dd></div><div><dt>输入</dt><dd>{shortHash(run.inputSha256)}</dd></div><div><dt>时间</dt><dd>{formatTime(run.completedAt)}</dd></div></dl></article>; })}{!currentRuns.length && <div className="evidence-empty"><strong>当前文章还没有检查记录</strong><p>先建立工作分支，再运行门禁。运行结果不会替代人工审阅。</p></div>}</div></section>}
      {evidenceView === "sources" && <div className="source-plane-grid"><section><span className="plane-number">01</span><h2>历史语料</h2><strong>系统观察到的原文件与正文 Blob</strong><p>可用于阅读、建立基线和追溯路径；网站不会覆盖它们。</p><dl><div><dt>版本</dt><dd>{corpus.schemaVersion}</dd></div><div><dt>生成</dt><dd>{formatTime(corpus.generatedAt)}</dd></div><div><dt>能证明</dt><dd>文件、哈希与索引时刻</dd></div><div><dt>不能证明</dt><dd>人工确认的身份或发布事实</dd></div></dl><button onClick={() => setView("library")}>打开内容图书馆</button></section><section><span className="plane-number">02</span><h2>能力目录</h2><strong>Skill、门禁、工作流、模板与检查器</strong><p>索引只回答入口能否找到；成熟度需要真实任务、证据和回归。</p><dl><div><dt>版本</dt><dd>{capabilities.schemaVersion}</dd></div><div><dt>元素</dt><dd>{capabilities.stats.capabilities}</dd></div><div><dt>能证明</dt><dd>入口、链接与索引关系</dd></div><div><dt>不能证明</dt><dd>已经适用于当前文章</dd></div></dl><button onClick={() => setView("capabilities")}>打开阶段能力目录</button></section><section><span className="plane-number">03</span><h2>D1 工作区</h2><strong>当前分支、修订、任务、决定与事件</strong><p>这是唯一可写平面；写入使用命令、摘要与并发检查。</p><dl><div><dt>状态</dt><dd>{workspaceState === "ready" ? "已连接" : "不可用"}</dd></div><div><dt>当前文章</dt><dd><ArticleQuickLink articleId={selectedArticle.id}>{selectedArticle.title}</ArticleQuickLink></dd></div><div><dt>能证明</dt><dd>本地状态变化和输入绑定</dd></div><div><dt>不能证明</dt><dd>外部平台或公众实际结果</dd></div></dl><button onClick={() => void runStorageProbe()}>检查写入与恢复</button></section><section className="source-roots"><span className="eyebrow">能力索引根</span>{capabilities.roots.map((root) => <div key={root.path} className="root-record"><strong>{root.label}</strong><code>{root.path}</code><em>{root.status}</em></div>)}<details><summary>查看索引说明</summary><div className="boundary-list">{capabilities.notes.map((note) => <p key={note}>{note}</p>)}</div></details></section></div>}
    </div>;
  };

  return (
    <ArticlePreviewProvider articles={workspaceArticles} canOpenWorkspace={(article) => articleWorks.some((candidate) => candidate.id === article.id)} onOpenWorkspace={(articleId) => requestArticleSelection(articleId, "project")}>
    <div className="factory-shell">
      <aside className="factory-sidebar">
        <div className="factory-brand"><span>文</span><div><strong>文脉</strong><small>文章工程台</small></div></div>
        <span className="mobile-nav-hint" aria-hidden="true">左右滑动 · 12 个工作区</span>
        <nav aria-label="主要工作区">{NAV_ITEMS.map((item) => <button key={item.id} className={view === item.id ? "active" : ""} onClick={() => setView(item.id)}><span>{item.mark}</span><div><strong>{item.label}</strong><small>{item.hint}</small></div></button>)}</nav>
        <button className="rsi-summary-badge" onClick={() => setView("project")}>{rsiSummary ? `待审 ${rsiSummary.pendingCount}` : rsiSummaryUnavailable ? "待审状态暂不可用" : "正在读取待审状态"}</button>
        <div className="sidebar-current"><span className="eyebrow">当前文章</span><ArticleQuickLink articleId={selectedArticle.id}><strong>{selectedArticle.title}</strong></ArticleQuickLink><small>{activeBranch ? `${activeBranch.name} · ${saveState === "dirty" ? "未保存" : "已保存"}` : "还没有工作分支"}</small></div>
        <div className="sidebar-storage"><i className={workspaceState} /><span>{workspaceState === "ready" ? "本地 D1 已连接" : workspaceState === "loading" ? "正在恢复工作区" : "D1 不可用"}</span></div>
      </aside>
      <div className="factory-main">
        <header className="global-bar">
          <div className="global-context"><span>{NAV_ITEMS.find((item) => item.id === view)?.label}</span><i>/</i><ArticleQuickLink articleId={selectedArticle.id}><strong>{selectedArticle.title}</strong></ArticleQuickLink></div>
          <div className="global-actions"><button onClick={() => setView("versions")}>{workspace.branches.length} 条分支</button><button onClick={() => setView("pipeline")}>{activeWorkItems.filter((item) => item.state !== "done").length} 个待办</button><button className="write-now" onClick={() => setView("project")}>继续制作</button></div>
        </header>
        {operationError && <div className="operation-error" role="alert"><span>{operationError}</span><button onClick={() => setOperationError("")}>关闭</button></div>}
        {view === "project" && <div className="article-project-view">{branchPanelOpen && renderBranchPanel()}<ArticleProjectEditor key={selectedArticle.id} article={selectedArticle} activeBranch={activeBranch} revisions={articleRevisions} onCreateBranch={() => openBranchPanel()} onOpenSourceEditor={() => setView("desk")} onWorkspaceChanged={(articleId) => loadWorkspace(articleId, activeBranch?.id)} onLocalArticleImported={rememberLocalArticle} notify={showToast} /><HumanReviewPanel target={reviewTarget} notify={showToast} onRsiChanged={refreshRsiSummary} /></div>}
        {view === "groups" && <ProjectGroupPanel articles={workspaceArticles} selectedArticleId={selectedArticle.id} notify={showToast} />}
        {view === "desk" && renderDesk()}
        {view === "versions" && renderVersions()}
        {view === "pipeline" && renderPipeline()}
        {view === "factory" && renderFactory()}
        {view === "agents" && <AgentConsole articles={workspaceArticles} selectedArticle={selectedArticle} branches={workspace.branches} onOpenArticle={(articleId) => requestArticleSelection(articleId, "project")} notify={showToast} onRsiChanged={refreshRsiSummary} />}
        {view === "lifecycle" && <DistributionHub key={selectedArticle.id} article={{ id: selectedArticle.id, title: selectedArticle.title }} branch={activeBranch ? { id: activeBranch.id, name: activeBranch.name, headRevisionId: activeBranch.headRevisionId } : undefined} workingCopy={activeCopy ? { baseRevisionId: activeCopy.baseRevisionId, title: activeCopy.title, bodySha256: activeCopy.bodySha256, dirty: activeCopy.dirty } : undefined} capabilities={capabilities} notify={showToast} />}
        {view === "capabilities" && renderCapabilities()}
        {view === "library" && renderLibrary()}
        {view === "shared-sources" && <SharedSourcePanel />}
        {view === "evidence" && renderEvidence()}
      </div>
      {previewRevision && <RevisionPreviewDialog revision={previewRevision} onClose={() => setRevisionPreviewId("")} />}
      {toast && <div className="factory-toast" role="status">{toast}</div>}
    </div>
    </ArticlePreviewProvider>
  );
}
