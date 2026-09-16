"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import MarkdownPreview from "./MarkdownPreview";
import { managementFetch } from "./management-fetch";
import type { ArticleGuidanceActor, ArticleGuidanceChecklist } from "./article-archive-intake";
import {
  buildImportWorkflowMetadata,
  fallbackImportProfileRecommendation,
  freezeImportProfileInput,
  type ImportProcessingProfile,
  type ImportProfileRecommendation,
} from "./import-profile";
import type {
  ArticleProjectPackageRecord,
  DiagnosticIssueRecord,
  DiagnosisRunRecord,
  PackageBranchBridgeRecord,
  PackageBranchCompositionCommitRecord,
  PackageBranchEntryRecord,
  PackageBranchMigrationAuditRecord,
  PackageBranchStateRecord,
  PackageBranchWorkingCopyRecord,
  PackageCompositionRecord,
  PackageDocument,
  PackageEdgeInput,
  PackageModuleInput,
  PackagePatchProposalRecord,
  PackageWorkingCopyRecord,
  SliceKind,
} from "./article-project-types";
import type { ArticleBranch, ArticleRevision, LocalArticleDirectoryEntry, WorkbenchArticle } from "./workbench-types";

type EditorMode = "structure" | "source" | "preview" | "build";
type MobilePanel = "outline" | "canvas" | "inspector" | "preview";

interface PackageListItem extends ArticleProjectPackageRecord {
  moduleCount?: number;
  sourceCount?: number;
  updatedAt: string;
}

interface PackageDetail {
  package: ArticleProjectPackageRecord;
  selectedBranchId: string;
  branchState: PackageBranchStateRecord;
  branchWorkingCopy: PackageBranchWorkingCopyRecord;
  branchCommit: PackageBranchCompositionCommitRecord | null;
  branchBridge: PackageBranchBridgeRecord;
  composition: PackageCompositionRecord;
  workingCopy: PackageBranchWorkingCopyRecord;
  guidanceChecklist: ArticleGuidanceChecklist;
  patchProposals?: PackagePatchProposalRecord[];
  diagnosisRuns?: DiagnosisRunRecord[];
  issues?: DiagnosticIssueRecord[];
}

interface PackageDetailPayload {
  package: ArticleProjectPackageRecord;
  selectedBranchId?: string;
  branchState?: PackageBranchStateRecord;
  branchWorkingCopy?: PackageBranchWorkingCopyRecord;
  branchCommit?: PackageBranchCompositionCommitRecord | null;
  branchBridge?: PackageBranchBridgeRecord;
  composition?: PackageCompositionRecord;
  workingCopy?: PackageWorkingCopyRecord;
  guidanceChecklist?: ArticleGuidanceChecklist;
}

interface PackageBranchCatalog {
  package: ArticleProjectPackageRecord;
  branchModel: {
    version: number | null;
    primaryBranchId: string | null;
    migrationState: PackageBranchMigrationAuditRecord["state"] | "uninitialized";
  };
  branches: PackageBranchEntryRecord[];
  migrationAudit: PackageBranchMigrationAuditRecord | null;
}

interface BranchMutationPayload {
  package: ArticleProjectPackageRecord;
  branchState?: PackageBranchStateRecord;
  branchWorkingCopy?: PackageBranchWorkingCopyRecord;
  workingCopy?: PackageWorkingCopyRecord;
  branchCommit?: PackageBranchCompositionCommitRecord | null;
  branchBridge?: PackageBranchBridgeRecord;
  composition?: PackageCompositionRecord;
  unchanged?: boolean;
}

interface SliceRecord {
  id: string;
  packageId: string;
  branchId?: string | null;
  compositionId: string;
  title: string;
  sliceKind: SliceKind;
  selector: Record<string, unknown>;
  resolvedManifest: Record<string, unknown>;
  sliceSha256: string;
  createdAt: string;
}

interface StagedImport {
  name: string;
  format: "markdown" | "text" | "wenmai";
  title: string;
  text: string;
  sha256: string;
  bytes: number;
  headings: number;
  paragraphs: number;
  document: PackageDocument | null;
  warnings: string[];
}

type ImportDestination = "candidate" | "new_article";
type ImportRecommendationState = {
  status: "idle" | "loading" | "ready" | "fallback" | "unavailable";
  recommendation: ImportProfileRecommendation | null;
};

const MARKDOWN_IMPORTER_KEY = "wenmai-browser-markdown-import";
const PACKAGE_IMPORTER_KEY = "wenmai-browser-package-import";
const BROWSER_IMPORTER_VERSION = "1.1.0";

const MODULE_KINDS = [
  ["heading", "标题"],
  ["paragraph", "段落"],
  ["list", "列表"],
  ["quote", "引用"],
  ["code", "代码"],
  ["image", "图片"],
  ["divider", "分隔"],
  ["raw", "原样块"],
] as const;

const RELATION_KINDS = [
  ["precedes", "顺序"],
  ["supports", "支持"],
  ["contrasts", "对照"],
  ["references", "引用"],
  ["variant_of", "变体"],
] as const;

const SLICE_PRESETS: Array<{ kind: SliceKind; title: string; note: string }> = [
  { kind: "full", title: "完整阅读版", note: "使用当前全部可见模块" },
  { kind: "demo", title: "Demo（试看版）", note: "保留开头与选中的代表模块" },
  { kind: "excerpt", title: "摘要切片", note: "使用当前选中的模块生成短版" },
  { kind: "promo", title: "宣传演示", note: "为封面、简介和传播文案准备的内容切片" },
  { kind: "custom", title: "自定义构建", note: "精确冻结当前模块选择" },
];

const GUIDANCE_ACTOR_LABELS: Record<ArticleGuidanceActor, string> = {
  deterministic_code: "确定性代码",
  agent: "Agent（智能体）",
  coordinator: "协调者",
  human: "人工",
};

function apiError(value: unknown, fallback: string) {
  if (!value || typeof value !== "object") return fallback;
  const object = value as { error?: string | { message?: string } };
  if (typeof object.error === "string") return object.error;
  return object.error?.message || fallback;
}

async function sha256Text(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function uid(prefix: string) {
  return `${prefix}-${crypto.randomUUID()}`;
}

function moduleText(module: PackageModuleInput) {
  if (typeof module.contentText === "string") return module.contentText;
  if (module.content) return JSON.stringify(module.content, null, 2);
  return "";
}

function moduleHidden(module: PackageModuleInput) {
  return module.metadata?.hidden === true;
}

function compileDocument(document: PackageDocument) {
  return document.modules
    .filter((module) => !moduleHidden(module))
    .map((module) => moduleText(module).trimEnd())
    .filter(Boolean)
    .join("\n\n")
    .trim();
}

function inferModuleKind(block: string): string {
  const text = block.trimStart();
  if (/^#{1,6}\s/.test(text)) return "heading";
  if (/^(?:[-*+] |\d+[.)] )/m.test(text)) return "list";
  if (/^>\s?/m.test(text)) return "quote";
  if (/^```/.test(text)) return "code";
  if (/^!\[[^\]]*\]\([^)]+\)/.test(text)) return "image";
  if (/^(?:---+|\*\*\*+)$/m.test(text)) return "divider";
  return "paragraph";
}

function titleFromBlock(block: string, kind: string, index: number) {
  const plain = block
    .replace(/^#{1,6}\s+/, "")
    .replace(/^>\s?/gm, "")
    .replace(/[`*_~[\]()]/g, "")
    .trim();
  if (kind === "heading") return plain.slice(0, 80) || `标题 ${index + 1}`;
  return plain.split(/\r?\n/, 1)[0].slice(0, 52) || `${MODULE_KINDS.find(([id]) => id === kind)?.[1] ?? "模块"} ${index + 1}`;
}

function documentFromMarkdown(
  title: string,
  markdown: string,
  source?: PackageDocument["sources"][number],
  options: { stableKeySeed?: string; importedAt?: string | null; parser?: string } = {},
): PackageDocument {
  const normalized = markdown.replace(/\r\n?/g, "\n").trim();
  const blocks = normalized ? normalized.split(/\n{2,}(?=\S)/) : ["# 新文章\n\n从这里开始写作。"];
  const modules: PackageModuleInput[] = blocks.map((block, index) => {
    const kind = inferModuleKind(block);
    return {
      key: options.stableKeySeed
        ? `module-${options.stableKeySeed.slice(0, 12)}-${String(index + 1).padStart(4, "0")}`
        : uid("module").slice(0, 25),
      kind,
      title: titleFromBlock(block, kind, index),
      contentFormat: "markdown",
      contentText: block.trim(),
      metadata: {
        role: index === 0 ? "opening" : "body",
        origin: "deterministic_import",
        confirmed: false,
        tags: [],
      },
      refs: source ? [{ refKind: "source", refKey: source.key, relationType: "imported_from" }] : [],
    };
  });
  return {
    schemaVersion: "wenmai-package-document-v1",
    title: title.trim() || "未命名文章工程",
    rootModuleKey: modules[0].key,
    modules,
    edges: modules.slice(1).map((module, index) => ({
      key: options.stableKeySeed
        ? `edge-${options.stableKeySeed.slice(0, 12)}-${String(index + 1).padStart(4, "0")}`
        : uid("edge").slice(0, 23),
      sourceModuleKey: modules[index].key,
      targetModuleKey: module.key,
      relationType: "precedes",
      ordinal: index,
    })),
    assets: [],
    sources: source ? [source] : [],
    metadata: {
      parser: options.parser ?? "wenmai-client-markdown/1.0",
      ...(options.importedAt === null ? {} : { importedAt: options.importedAt ?? new Date().toISOString() }),
      ...(options.stableKeySeed ? { sourceFingerprintSha256: options.stableKeySeed } : {}),
    },
  };
}

function candidateDocumentFromImport(staged: StagedImport): PackageDocument {
  const parser = staged.format === "wenmai" ? "wenmai-project-package/1.0" : "wenmai-client-markdown/1.0";
  const source = {
    key: `source-${staged.sha256.slice(0, 16)}`,
    sourceKind: staged.format === "wenmai" ? "wenmai_package" : staged.format === "text" ? "text_file" : "markdown_file",
    canonicalRef: staged.name,
    title: staged.name,
    contentSha256: staged.sha256,
    excerpt: staged.text.slice(0, 500),
    metadata: { parser, importerVersion: BROWSER_IMPORTER_VERSION, originalFormat: staged.format },
    rights: {
      basis: "user_supplied_local_file",
      verificationStatus: "unverified_declaration",
    },
  } satisfies PackageDocument["sources"][number];
  if (!staged.document) {
    return documentFromMarkdown(staged.title, staged.text, source, {
      stableKeySeed: staged.sha256,
      importedAt: null,
      parser,
    });
  }
  const document = cloneDocument(staged.document);
  return {
    ...document,
    title: staged.title.trim() || document.title,
    sources: [...document.sources.filter((item) => item.key !== source.key), source],
    metadata: {
      ...document.metadata,
      importParser: parser,
      sourceFingerprintSha256: staged.sha256,
      importerVersion: BROWSER_IMPORTER_VERSION,
    },
  };
}

function recommendationInputFromStaged(staged: StagedImport) {
  return {
    name: staged.name,
    format: staged.format,
    title: staged.title,
    text: staged.text,
    sourceSha256: staged.sha256,
    bytes: staged.bytes,
    headings: staged.headings,
    paragraphs: staged.paragraphs,
    packageSignals: staged.document ? {
      modules: staged.document.modules.length,
      sources: staged.document.sources.length,
      assets: staged.document.assets.length,
      hasWorkflowProfile: staged.document.metadata.importWorkflow !== undefined,
    } : null,
  } satisfies Parameters<typeof freezeImportProfileInput>[0];
}

function normalizeSequence(document: PackageDocument): PackageDocument {
  const semanticEdges = document.edges.filter((edge) => edge.relationType !== "precedes");
  const orderEdges: PackageEdgeInput[] = document.modules.slice(1).map((module, index) => ({
    key: `order-${document.modules[index].key}-${module.key}`.slice(0, 120),
    sourceModuleKey: document.modules[index].key,
    targetModuleKey: module.key,
    relationType: "precedes",
    ordinal: index,
  }));
  return { ...document, rootModuleKey: document.modules[0]?.key ?? "", edges: [...orderEdges, ...semanticEdges] };
}

function cloneDocument(document: PackageDocument): PackageDocument {
  return structuredClone(document);
}

function packageTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(date);
}

function downloadJson(fileName: string, value: unknown) {
  const blob = new Blob([JSON.stringify(value, null, 2)], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

export default function ArticleProjectEditor({
  article,
  activeBranch,
  revisions,
  onCreateBranch,
  onOpenSourceEditor,
  onLocalArticleImported,
  onWorkspaceChanged,
  notify,
}: {
  article: WorkbenchArticle;
  activeBranch?: ArticleBranch;
  revisions: ArticleRevision[];
  onCreateBranch: () => void;
  onOpenSourceEditor: () => void;
  onLocalArticleImported: (entry: LocalArticleDirectoryEntry) => void | Promise<void>;
  onWorkspaceChanged: (articleId: string) => void | Promise<void>;
  notify: (message: string) => void;
}) {
  const [packages, setPackages] = useState<PackageListItem[]>([]);
  const [selectedPackageId, setSelectedPackageId] = useState("");
  const [branchCatalog, setBranchCatalog] = useState<PackageBranchCatalog | null>(null);
  const [selectedBranchId, setSelectedBranchId] = useState("");
  const [detail, setDetail] = useState<PackageDetail | null>(null);
  const [documentState, setDocumentState] = useState<PackageDocument | null>(null);
  const [selectedModuleKey, setSelectedModuleKey] = useState("");
  const [selectedModuleKeys, setSelectedModuleKeys] = useState<string[]>([]);
  const [mode, setMode] = useState<EditorMode>("structure");
  const [mobilePanel, setMobilePanel] = useState<MobilePanel>("canvas");
  const [status, setStatus] = useState<"loading" | "ready" | "saving" | "error">("loading");
  const [error, setError] = useState("");
  const [dirty, setDirty] = useState(false);
  const [undoStack, setUndoStack] = useState<PackageDocument[]>([]);
  const [redoStack, setRedoStack] = useState<PackageDocument[]>([]);
  const [moduleQuery, setModuleQuery] = useState("");
  const [relationTarget, setRelationTarget] = useState("");
  const [relationKind, setRelationKind] = useState("supports");
  const [stagedImport, setStagedImport] = useState<StagedImport | null>(null);
  const [importDestination, setImportDestination] = useState<ImportDestination>("candidate");
  const [importProfile, setImportProfile] = useState<ImportProcessingProfile | null>(null);
  const [importRecommendation, setImportRecommendation] = useState<ImportRecommendationState>({ status: "idle", recommendation: null });
  const [importOpen, setImportOpen] = useState(false);
  const [commitOpen, setCommitOpen] = useState(false);
  const [commitTitle, setCommitTitle] = useState("");
  const [guidanceDecisionNote, setGuidanceDecisionNote] = useState("");
  const [sourceDraft, setSourceDraft] = useState("");
  const [slices, setSlices] = useState<SliceRecord[]>([]);
  const [issues, setIssues] = useState<DiagnosticIssueRecord[]>([]);
  const [diagnosisRuns, setDiagnosisRuns] = useState<DiagnosisRunRecord[]>([]);
  const [patches, setPatches] = useState<PackagePatchProposalRecord[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const importReturnFocusRef = useRef<HTMLElement | null>(null);
  const importWasOpenRef = useRef(false);
  const importRecommendationSequenceRef = useRef(0);
  const commitDialogRef = useRef<HTMLDialogElement>(null);
  const commitTitleRef = useRef<HTMLInputElement>(null);
  const commitReturnFocusRef = useRef<HTMLElement | null>(null);
  const activeBranchId = activeBranch?.id ?? "";

  const openFilePicker = useCallback(() => {
    importReturnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    fileInputRef.current?.click();
  }, []);

  const openCommitDialog = useCallback(() => {
    commitReturnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setCommitTitle(`工程修订 · ${new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date())}`);
    setCommitOpen(true);
  }, []);

  useEffect(() => {
    if (!commitOpen) return;
    const dialog = commitDialogRef.current;
    if (!dialog) return;
    if (!dialog.open) dialog.showModal();
    const frame = window.requestAnimationFrame(() => commitTitleRef.current?.focus());
    return () => {
      window.cancelAnimationFrame(frame);
      if (dialog.open) dialog.close();
      window.requestAnimationFrame(() => commitReturnFocusRef.current?.focus());
    };
  }, [commitOpen]);

  useEffect(() => {
    if (importOpen) {
      importWasOpenRef.current = true;
      return;
    }
    if (!importWasOpenRef.current) return;
    importWasOpenRef.current = false;
    window.requestAnimationFrame(() => importReturnFocusRef.current?.focus());
  }, [importOpen]);

  const selectedBranchEntry = useMemo(
    () => branchCatalog?.branches.find((branch) => branch.branchId === selectedBranchId) ?? null,
    [branchCatalog, selectedBranchId],
  );
  const migrationBlocked = branchCatalog?.branchModel.migrationState === "blocked"
    || branchCatalog?.migrationAudit?.state === "blocked";
  const branchHealthy = Boolean(
    detail
    && detail.selectedBranchId === selectedBranchId
    && detail.branchState.branchId === selectedBranchId
    && detail.branchState.status === "active"
    && detail.branchBridge.inSync,
  );
  const editorReadOnly = Boolean(migrationBlocked || (detail && !branchHealthy));
  const guidanceProfileDecisionRequired = Boolean(detail?.guidanceChecklist.checks.some(
    (check) => check.id === "triage.profile.human_decision" && check.status === "human_required",
  ));
  const guidanceProfileDecisionVisible = Boolean(
    detail?.guidanceChecklist.archiveReady
    && detail.guidanceChecklist.checks.some((check) => (
      check.id === "triage.profile.human_decision"
      && (check.status === "human_required" || check.status === "passed")
    )),
  );
  const selectedBranchIsPrimary = Boolean(selectedBranchId && selectedBranchId === branchCatalog?.branchModel.primaryBranchId);
  const branchHealthTone = migrationBlocked
    ? "blocked"
    : !selectedBranchEntry?.attached
      ? "detached"
      : branchHealthy
        ? "healthy"
        : "stale";
  const branchHealthLabel = migrationBlocked
    ? "迁移阻断 · 只读"
    : !selectedBranchEntry?.attached
      ? "尚未接入工程"
      : branchHealthy
        ? "接入健康"
      : "接入失步 · 只读";
  const importCandidateDisabledReason = !detail
    ? "当前文章还没有可写的 Package 与 ArticleBranch；请先解包当前分支，或明确选择建立独立新文章。"
    : migrationBlocked
      ? "当前工程的分支迁移审计被阻断，不能把候选绑定到一个未经确认的基线。"
      : editorReadOnly || !branchHealthy
        ? "当前文章分支与冻结内容版本不在同一健康基线，推荐导入已禁用。"
        : detail.package.status !== "active" || detail.branchState.status !== "active"
          ? "当前 Package 或 ArticleBranch 已归档，不能写入导入候选。"
          : status === "saving" || status === "loading"
            ? "当前工程正在保存或读取；完成后可重新打开导入面板。"
            : !detail.workingCopy.baseRevisionId
              ? "当前分支缺少可校验的修订基线，不能建立候选。"
              : "";

  const selectedModule = documentState?.modules.find((module) => module.key === selectedModuleKey) ?? documentState?.modules[0];
  const compiledMarkdown = useMemo(() => documentState ? compileDocument(documentState) : "", [documentState]);
  const documentImportWorkflow = documentState?.metadata.importWorkflow as {
    selectedProfile?: unknown;
    workflowRecommendation?: { recipeId?: unknown; coverCapabilityId?: unknown };
  } | undefined;
  const documentImportProfile = documentImportWorkflow?.selectedProfile === "light_archive"
    ? "light_archive"
    : documentImportWorkflow?.selectedProfile === "full_production"
      ? "full_production"
      : null;
  const filteredModules = useMemo(() => {
    const query = moduleQuery.trim().toLowerCase();
    if (!documentState) return [];
    if (!query) return documentState.modules;
    return documentState.modules.filter((module) => [module.title, module.kind, moduleText(module), String(module.metadata?.role ?? "")].join(" ").toLowerCase().includes(query));
  }, [documentState, moduleQuery]);

  const getData = useCallback(async <T,>(view: string, params: Record<string, string> = {}): Promise<T> => {
    const query = new URLSearchParams({ view, ...params });
    const response = await managementFetch(`/api/project-package/v1?${query}`, { cache: "no-store" });
    const payload = await response.json() as { ok?: boolean; data?: T; error?: unknown };
    if (!response.ok || payload.ok === false || !payload.data) throw new Error(apiError(payload, "文章工程接口不可用"));
    return payload.data;
  }, []);

  const postAction = useCallback(async <T,>(action: string, payload: Record<string, unknown>): Promise<T> => {
    const response = await managementFetch("/api/project-package/v1", {
      method: "POST",
      headers: { "content-type": "application/json", "X-Wenmai-Write": "1" },
      body: JSON.stringify({ action, commandId: `project-ui:${action}:${crypto.randomUUID()}`, payload }),
    });
    const result = await response.json() as { ok?: boolean; data?: T; error?: unknown };
    if (!response.ok || result.ok === false || !result.data) throw new Error(apiError(result, `${action} 失败`));
    return result.data;
  }, []);

  const requestImportProfile = useCallback(async (staged: StagedImport) => {
    const sequence = importRecommendationSequenceRef.current + 1;
    importRecommendationSequenceRef.current = sequence;
    setImportRecommendation({ status: "loading", recommendation: null });
    const input = recommendationInputFromStaged(staged);
    try {
      const result = await postAction<{
        recommendation: ImportProfileRecommendation;
        boundary: { recommendationOnly: boolean; humanConfirmationRequired: boolean; bodyDisclosedToModel: boolean };
      }>("recommend_import_profile", {
        name: input.name,
        format: input.format,
        title: input.title,
        text: input.text,
        sourceFingerprintSha256: input.sourceSha256,
        bytes: input.bytes,
        headings: input.headings,
        paragraphs: input.paragraphs,
        packageSignals: input.packageSignals,
      });
      if (importRecommendationSequenceRef.current !== sequence
        || result.recommendation.sourceSha256 !== staged.sha256) return;
      setImportRecommendation({
        status: result.recommendation.source === "llm" ? "ready" : "fallback",
        recommendation: result.recommendation,
      });
    } catch {
      const frozen = freezeImportProfileInput(input);
      const localInputSha256 = await sha256Text(JSON.stringify(frozen));
      if (importRecommendationSequenceRef.current !== sequence) return;
      setImportRecommendation({
        status: "unavailable",
        recommendation: fallbackImportProfileRecommendation(
          frozen,
          localInputSha256,
          "RECOMMENDATION_REQUEST_FAILED",
        ),
      });
    }
  }, [postAction]);

  const closeImport = useCallback(() => {
    importRecommendationSequenceRef.current += 1;
    setImportOpen(false);
    setStagedImport(null);
    setImportProfile(null);
    setImportRecommendation({ status: "idle", recommendation: null });
  }, []);

  const loadPackage = useCallback(async (packageId: string, requestedBranchId?: string) => {
    if (!packageId) return;
    setGuidanceDecisionNote("");
    setStatus("loading");
    setError("");
    setDetail(null);
    setDocumentState(null);
    setUndoStack([]);
    setRedoStack([]);
    setSelectedModuleKey("");
    setSelectedModuleKeys([]);
    setCommitOpen(false);
    try {
      const catalog = await getData<PackageBranchCatalog>("branches", { packageId });
      setBranchCatalog(catalog);
      const requested = requestedBranchId
        ? catalog.branches.find((branch) => branch.branchId === requestedBranchId)
        : null;
      const selected = requested
        ?? catalog.branches.find((branch) => branch.branchId === catalog.branchModel.primaryBranchId)
        ?? catalog.branches.find((branch) => branch.attached)
        ?? catalog.branches[0]
        ?? null;
      const branchId = selected?.branchId ?? "";
      setSelectedBranchId(branchId);
      if (!selected?.attached) {
        setDiagnosisRuns([]);
        setIssues([]);
        setPatches([]);
        setSlices([]);
        setDirty(false);
        setStatus("ready");
        return;
      }
      const packageData = await getData<PackageDetailPayload>("package", { packageId, branchId });
      const branchWorkingCopy = packageData.branchWorkingCopy
        ?? (packageData.workingCopy?.branchId === branchId && packageData.workingCopy.baseRevisionId
          ? packageData.workingCopy as PackageBranchWorkingCopyRecord
          : null);
      if (!packageData.composition || !packageData.branchState || !packageData.branchBridge || !branchWorkingCopy) {
        throw new Error("文章工程分支详情不完整；没有进入兼容单主线写入模式");
      }
      if (!packageData.guidanceChecklist) {
        throw new Error("文章工程响应缺少机器指导清单；已停止让 Agent 猜测下一步");
      }
      if (packageData.selectedBranchId && packageData.selectedBranchId !== branchId) {
        throw new Error("文章工程返回了另一条分支，已阻止跨分支编辑");
      }
      const normalized: PackageDetail = {
        package: packageData.package,
        selectedBranchId: branchId,
        branchState: packageData.branchState,
        branchWorkingCopy,
        branchCommit: packageData.branchCommit ?? null,
        branchBridge: packageData.branchBridge,
        composition: packageData.composition,
        workingCopy: branchWorkingCopy,
        guidanceChecklist: packageData.guidanceChecklist,
      };
      const [diagnosticData, patchData, sliceData] = await Promise.all([
        getData<{ diagnosisRuns?: DiagnosisRunRecord[]; issues?: DiagnosticIssueRecord[] }>("diagnostics", { packageId, branchId, compositionId: packageData.composition.id }).catch(() => ({} as { diagnosisRuns?: DiagnosisRunRecord[]; issues?: DiagnosticIssueRecord[] })),
        getData<{ patchProposals?: PackagePatchProposalRecord[]; patches?: PackagePatchProposalRecord[] }>("patches", { packageId, branchId }).catch(() => ({} as { patchProposals?: PackagePatchProposalRecord[]; patches?: PackagePatchProposalRecord[] })),
        getData<{ slices?: SliceRecord[] }>("slices", { packageId, branchId }).catch(() => ({} as { slices?: SliceRecord[] })),
      ]);
      setDetail(normalized);
      setDocumentState(cloneDocument(branchWorkingCopy.document));
      setSourceDraft(compileDocument(branchWorkingCopy.document));
      setDirty(false);
      setSelectedModuleKey(branchWorkingCopy.document.modules[0]?.key ?? "");
      setDiagnosisRuns(diagnosticData.diagnosisRuns ?? []);
      setIssues(diagnosticData.issues ?? []);
      setPatches((patchData.patchProposals ?? patchData.patches ?? []).filter((patch) => !patch.branchId || patch.branchId === branchId));
      setSlices((sliceData.slices ?? []).filter((slice) => !slice.branchId || slice.branchId === branchId));
      setStatus("ready");
    } catch (caught) {
      setStatus("error");
      setError(caught instanceof Error ? caught.message : "文章工程读取失败");
    }
  }, [getData]);

  const decideGuidanceProfile = useCallback(async (selectedProfile: "light_archive" | "full_production") => {
    if (!detail || !guidanceProfileDecisionVisible || editorReadOnly || status === "saving") return;
    const decisionNote = guidanceDecisionNote.trim();
    if (!decisionNote) return;
    setStatus("saving");
    setError("");
    try {
      await postAction("decide_guidance_profile", {
        packageId: detail.package.id,
        branchId: detail.selectedBranchId,
        expectedChecklistSha256: detail.guidanceChecklist.checklistSha256,
        expectedPackageLockVersion: detail.package.lockVersion,
        expectedBranchLockVersion: detail.branchState.lockVersion,
        expectedWorkingLockVersion: detail.workingCopy.lockVersion,
        selectedProfile,
        decisionNote,
      });
      setGuidanceDecisionNote("");
      await loadPackage(detail.package.id, detail.selectedBranchId);
    } catch (caught) {
      setStatus("error");
      setError(caught instanceof Error ? caught.message : "处理档位决定没有完成");
    }
  }, [detail, editorReadOnly, guidanceDecisionNote, guidanceProfileDecisionVisible, loadPackage, postAction, status]);

  const loadPackages = useCallback(async (preferredPackageId?: string, preferredBranchId?: string) => {
    setStatus("loading");
    try {
      const data = await getData<{ packages: PackageListItem[] }>("packages", { articleId: article.id, limit: "100" });
      setPackages(data.packages ?? []);
      const preferred = (preferredPackageId && data.packages?.some((item) => item.id === preferredPackageId) ? preferredPackageId : "")
        || data.packages?.find((item) => item.articleId === article.id)?.id
        || (selectedPackageId && data.packages?.some((item) => item.id === selectedPackageId) ? selectedPackageId : "")
        || data.packages?.[0]?.id
        || "";
      setSelectedPackageId(preferred);
      if (preferred) await loadPackage(preferred, preferredBranchId || selectedBranchId || activeBranchId);
      else setStatus("ready");
    } catch (caught) {
      setStatus("error");
      setError(caught instanceof Error ? caught.message : "文章工程目录读取失败");
    }
  }, [activeBranchId, article.id, getData, loadPackage, selectedBranchId, selectedPackageId]);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadPackages(), 0);
    return () => window.clearTimeout(timer);
  }, [article.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const mutateDocument = useCallback((updater: (document: PackageDocument) => PackageDocument) => {
    if (editorReadOnly) return;
    setDocumentState((current) => {
      if (!current) return current;
      const previous = cloneDocument(current);
      const next = normalizeSequence(updater(cloneDocument(current)));
      setUndoStack((stack) => [...stack.slice(-39), previous]);
      setRedoStack([]);
      setDirty(true);
      setSourceDraft(compileDocument(next));
      return next;
    });
  }, [editorReadOnly]);

  const undo = useCallback(() => {
    setUndoStack((stack) => {
      const previous = stack.at(-1);
      if (!previous || !documentState) return stack;
      setRedoStack((redo) => [cloneDocument(documentState), ...redo].slice(0, 40));
      setDocumentState(cloneDocument(previous));
      setSourceDraft(compileDocument(previous));
      setDirty(true);
      return stack.slice(0, -1);
    });
  }, [documentState]);

  const redo = useCallback(() => {
    setRedoStack((stack) => {
      const next = stack[0];
      if (!next || !documentState) return stack;
      setUndoStack((undoItems) => [...undoItems, cloneDocument(documentState)].slice(-40));
      setDocumentState(cloneDocument(next));
      setSourceDraft(compileDocument(next));
      setDirty(true);
      return stack.slice(1);
    });
  }, [documentState]);

  const save = useCallback(async () => {
    if (!detail || !documentState || status === "saving") return null;
    if (editorReadOnly || !detail.workingCopy.baseRevisionId) {
      setError(migrationBlocked
        ? "0010 分支迁移审计被阻断；当前工程只读，不能猜测写入目标"
        : "当前分支桥接不健康；请刷新或修复接入关系后再保存");
      return null;
    }
    setStatus("saving");
    setError("");
    try {
      const data = await postAction<BranchMutationPayload>("save_working_package", {
        packageId: detail.package.id,
        branchId: detail.selectedBranchId,
        expectedPackageLockVersion: detail.package.lockVersion,
        expectedBranchLockVersion: detail.branchState.lockVersion,
        expectedWorkingLockVersion: detail.workingCopy.lockVersion,
        expectedBaseCompositionId: detail.workingCopy.baseCompositionId,
        expectedBaseRevisionId: detail.workingCopy.baseRevisionId,
        document: documentState,
      });
      const workingCopy = data.branchWorkingCopy
        ?? (data.workingCopy?.branchId === detail.selectedBranchId && data.workingCopy.baseRevisionId
          ? data.workingCopy as PackageBranchWorkingCopyRecord
          : null);
      if (!workingCopy) throw new Error("保存响应缺少当前分支工作副本；浏览器缓冲仍保留");
      setDetail((current) => current ? {
        ...current,
        package: data.package,
        branchState: data.branchState ?? current.branchState,
        branchWorkingCopy: workingCopy,
        branchBridge: data.branchBridge ?? current.branchBridge,
        workingCopy,
      } : current);
      setDocumentState(cloneDocument(workingCopy.document));
      setSourceDraft(compileDocument(workingCopy.document));
      setDirty(false);
      setStatus("ready");
      notify(data.unchanged ? "工程内容没有变化" : "模块工程已保存到本地 D1");
      return { ...data, workingCopy };
    } catch (caught) {
      setStatus("error");
      setError(caught instanceof Error ? caught.message : "工程保存失败；当前浏览器缓冲仍保留");
      return null;
    }
  }, [detail, documentState, editorReadOnly, migrationBlocked, notify, postAction, status]);

  const switchBranch = useCallback(async (nextBranchId: string) => {
    if (!selectedPackageId || !nextBranchId || nextBranchId === selectedBranchId || status === "loading") return;
    if (dirty) {
      const saved = await save();
      if (!saved) {
        notify("当前分支未安全保存，已留在原分支");
        return;
      }
    }
    await loadPackage(selectedPackageId, nextBranchId);
  }, [dirty, loadPackage, notify, save, selectedBranchId, selectedPackageId, status]);

  const switchPackage = useCallback(async (nextPackageId: string) => {
    if (!nextPackageId || nextPackageId === selectedPackageId || status === "loading") return;
    if (dirty) {
      const saved = await save();
      if (!saved) {
        notify("当前分支未安全保存，已留在原工程包");
        return;
      }
    }
    setSelectedPackageId(nextPackageId);
    await loadPackage(nextPackageId, activeBranchId);
  }, [activeBranchId, dirty, loadPackage, notify, save, selectedPackageId, status]);

  const attachSelectedBranch = useCallback(async () => {
    if (!branchCatalog || !selectedBranchEntry || selectedBranchEntry.attached || migrationBlocked) return;
    if (selectedBranchEntry.articleWorkingDirty) {
      setError("该 ArticleBranch 的源码工作副本仍有未提交修改；请先在源码工位形成 clean head");
      return;
    }
    setStatus("saving");
    setError("");
    try {
      await postAction<BranchMutationPayload>("attach_branch", {
        packageId: branchCatalog.package.id,
        branchId: selectedBranchEntry.branchId,
        expectedBranchHeadRevisionId: selectedBranchEntry.headRevisionId,
        expectedBranchHeadBodySha256: selectedBranchEntry.headBodySha256,
        expectedBranchWorkingLockVersion: selectedBranchEntry.articleWorkingLockVersion,
      });
      await loadPackage(branchCatalog.package.id, selectedBranchEntry.branchId);
      notify("分支已接入文章工程；原 ArticleBranch 未被推进或改写");
    } catch (caught) {
      setStatus("error");
      setError(caught instanceof Error ? caught.message : "分支接入失败；没有猜测或覆盖现有基线");
    }
  }, [branchCatalog, loadPackage, migrationBlocked, notify, postAction, selectedBranchEntry]);

  useEffect(() => {
    if (!dirty || !detail || status === "saving" || editorReadOnly) return;
    const timer = window.setTimeout(() => void save(), 1400);
    return () => window.clearTimeout(timer);
  }, [detail, dirty, editorReadOnly, save, status]);

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void save();
      }
      if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
        event.preventDefault();
        if (editorReadOnly) return;
        openCommitDialog();
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        if (event.shiftKey) redo(); else undo();
      }
      if (event.altKey && ["ArrowUp", "ArrowDown"].includes(event.key) && selectedModuleKey) {
        event.preventDefault();
        const direction = event.key === "ArrowUp" ? -1 : 1;
        mutateDocument((current) => {
          const index = current.modules.findIndex((module) => module.key === selectedModuleKey);
          const target = index + direction;
          if (index < 0 || target < 0 || target >= current.modules.length) return current;
          const modules = [...current.modules];
          [modules[index], modules[target]] = [modules[target], modules[index]];
          return { ...current, modules };
        });
      }
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [editorReadOnly, mutateDocument, openCommitDialog, redo, save, selectedModuleKey, undo]);

  const ensureCurrentArticle = useCallback(async () => {
    if (!activeBranch) {
      onCreateBranch();
      return;
    }
    const revision = revisions.find((item) => item.id === activeBranch.headRevisionId);
    if (!revision) {
      setError("当前分支头修订不在工作区快照中，请先刷新或提交一条修订。");
      return;
    }
    setStatus("loading");
    try {
      const data = await postAction<{ package: ArticleProjectPackageRecord }>("ensure_from_revision", {
        articleId: article.id,
        branchId: activeBranch.id,
        revisionId: revision.id,
        expectedBodySha256: revision.bodySha256,
        title: article.title,
      });
      setSelectedPackageId(data.package.id);
      await loadPackages(data.package.id, activeBranch.id);
      notify("当前修订已经解包为可编辑文章工程；源稿保持只读");
    } catch (caught) {
      setStatus("error");
      setError(caught instanceof Error ? caught.message : "当前文章工程化失败");
    }
  }, [activeBranch, article.id, article.title, loadPackages, notify, onCreateBranch, postAction, revisions]);

  const stageFile = useCallback(async (file: File) => {
    setError("");
    if (file.size > 2_000_000) {
      setError("首版导入只接受 2 MB 以内的 Markdown、TXT 或文脉 JSON 工程包。");
      return;
    }
    const raw = await file.text();
    const hash = await sha256Text(raw);
    const lower = file.name.toLowerCase();
    const warnings: string[] = [];
    const format: StagedImport["format"] = lower.endsWith(".json") || lower.endsWith(".wenmai") ? "wenmai" : lower.endsWith(".txt") ? "text" : "markdown";
    let text = raw;
    let projectDocument: PackageDocument | null = null;
    if (format === "wenmai") {
      try {
        const parsed = JSON.parse(raw) as { document?: PackageDocument; project?: { document?: PackageDocument } } | PackageDocument;
        if ("schemaVersion" in parsed && parsed.schemaVersion === "wenmai-package-document-v1") {
          projectDocument = parsed as PackageDocument;
        } else {
          const envelope = parsed as { document?: PackageDocument; project?: { document?: PackageDocument } };
          projectDocument = envelope.document ?? envelope.project?.document ?? null;
        }
        if (!projectDocument || projectDocument.schemaVersion !== "wenmai-package-document-v1") throw new Error("工程包缺少 document");
        text = compileDocument(projectDocument);
      } catch {
        setError("这个 JSON 不是可识别的文脉文章工程包；尚未写入任何数据。");
        return;
      }
    }
    if (!text.trim()) warnings.push("文件没有可解析正文");
    if (/\0/.test(text)) warnings.push("检测到二进制空字符，请核对文件编码");
    const fallbackTitle = file.name.replace(/\.(?:md|markdown|txt|json|wenmai)$/i, "");
    const title = projectDocument?.title || text.match(/^#\s+(.+)$/m)?.[1]?.trim() || fallbackTitle || "导入文章";
    const staged: StagedImport = {
      name: file.name,
      format,
      title,
      text,
      sha256: hash,
      bytes: new TextEncoder().encode(raw).byteLength,
      headings: (text.match(/^#{1,6}\s+/gm) ?? []).length,
      paragraphs: text.split(/\n{2,}(?=\S)/).filter((item) => item.trim()).length,
      document: projectDocument,
      warnings,
    };
    setStagedImport(staged);
    setImportDestination("candidate");
    setImportProfile(null);
    setImportOpen(true);
    void requestImportProfile(staged);
  }, [requestImportProfile]);

  const confirmImport = useCallback(async () => {
    if (!stagedImport) return;
    if (!importProfile) {
      setError("请选择轻量建档或完整生产；LLM 推荐不会替你确认。");
      return;
    }
    setStatus("loading");
    try {
      let recommendation = importRecommendation.recommendation;
      if (!recommendation || recommendation.sourceSha256 !== stagedImport.sha256) {
        const frozen = freezeImportProfileInput(recommendationInputFromStaged(stagedImport));
        recommendation = fallbackImportProfileRecommendation(
          frozen,
          await sha256Text(JSON.stringify(frozen)),
          "RECOMMENDATION_PENDING_AT_CONFIRM",
        );
      }
      const importWorkflow = buildImportWorkflowMetadata({
        selectedProfile: importProfile,
        source: {
          name: stagedImport.name,
          format: stagedImport.format,
          sourceSha256: stagedImport.sha256,
          bytes: stagedImport.bytes,
        },
        recommendation,
      });
      const importedDocument = candidateDocumentFromImport(stagedImport);
      const candidateDocument: PackageDocument = {
        ...importedDocument,
        metadata: { ...importedDocument.metadata, importWorkflow },
      };
      const sourceKind = stagedImport.format === "wenmai"
        ? "wenmai_package"
        : stagedImport.format === "text"
          ? "text_file"
          : "markdown_file";
      const importerKey = stagedImport.format === "wenmai" ? PACKAGE_IMPORTER_KEY : MARKDOWN_IMPORTER_KEY;
      if (importDestination === "candidate") {
        if (!detail || importCandidateDisabledReason) {
          throw new Error(importCandidateDisabledReason || "当前工程没有可绑定导入候选的分支基线。");
        }
        const candidate = await postAction<{ reused?: boolean }>("create_import_candidate", {
          packageId: detail.package.id,
          branchId: detail.selectedBranchId,
          baseRevisionId: detail.workingCopy.baseRevisionId,
          expectedBranchLockVersion: detail.branchState.lockVersion,
          baseCompositionId: detail.composition.id,
          expectedBaseCompositionSha256: detail.composition.compositionSha256,
          sourceKind,
          sourceRef: stagedImport.name,
          sourceFingerprintSha256: stagedImport.sha256,
          importerKey,
          importerVersion: BROWSER_IMPORTER_VERSION,
          document: candidateDocument,
          title: `导入候选：${stagedImport.title}`,
          summary: "导入到当前文章与当前分支；只建立候选补丁，等待人工批准和应用，不推进修订或冻结内容版本。",
          evidence: [
            `source-file:${stagedImport.name}`,
            `sha256:${stagedImport.sha256}`,
            `parser:${candidateDocument.metadata.importParser ?? candidateDocument.metadata.parser ?? "unknown"}`,
            `selected-profile:${importProfile}`,
            `recommended-profile:${recommendation.recommendedProfile}`,
            `recommendation-source:${recommendation.source}`,
            `human-override:${String(importProfile !== recommendation.recommendedProfile)}`,
          ],
        });
        closeImport();
        await loadPackage(detail.package.id, detail.selectedBranchId);
        notify(candidate.reused
          ? "同一文件和处理预设的导入候选已经存在；已复用原候选，没有新建 Article，也没有自动应用"
          : `已建立${importProfile === "light_archive" ? "轻量建档" : "完整生产"}导入候选；没有新建 Article，也没有自动应用`);
        return;
      }

      const identity = stagedImport.sha256.slice(0, 32);
      const articleId = `local-article-import-${identity}`;
      const created = await postAction<{
        package: ArticleProjectPackageRecord;
        composition: PackageCompositionRecord;
        branchBridge: PackageBranchBridgeRecord | null;
      }>("create_from_text", {
        articleId,
        projectId: `local-project-import-${identity}`,
        title: stagedImport.title,
        bodyText: stagedImport.text,
        sourceFingerprintSha256: stagedImport.sha256,
        importWorkflow,
      });
      if (stagedImport.document) {
        await postAction("create_import_candidate", {
          packageId: created.package.id,
          expectedPackageLockVersion: created.package.lockVersion,
          baseCompositionId: created.composition.id,
          expectedBaseCompositionSha256: created.composition.compositionSha256,
          sourceKind,
          sourceRef: stagedImport.name,
          sourceFingerprintSha256: stagedImport.sha256,
          importerKey,
          importerVersion: BROWSER_IMPORTER_VERSION,
          document: candidateDocument,
          summary: "已按用户明确选择建立独立 Article；工程包结构另形成候选补丁，仍需人工检查和应用。",
          evidence: [
            `source-file:${stagedImport.name}`,
            `sha256:${stagedImport.sha256}`,
            `parser:${candidateDocument.metadata.importParser ?? candidateDocument.metadata.parser ?? "unknown"}`,
            `selected-profile:${importProfile}`,
            `recommended-profile:${recommendation.recommendedProfile}`,
            `recommendation-source:${recommendation.source}`,
            `human-override:${String(importProfile !== recommendation.recommendedProfile)}`,
          ],
        });
      }
      setPackages([created.package as PackageListItem]);
      setSelectedPackageId(created.package.id);
      await loadPackage(created.package.id, created.package.primaryBranchId ?? undefined);
      if (!created.package.primaryBranchId || !created.branchBridge?.headRevisionId || !created.branchBridge.headBodySha256) {
        throw new Error("文章工程已经写入，但创建回执缺少分支或修订身份；请刷新后从本地目录恢复，不要重复导入。");
      }
      await onLocalArticleImported({
        schemaVersion: "wenmai-local-article/1.0",
        articleId,
        projectId: created.package.projectId,
        packageId: created.package.id,
        title: created.composition.document.title || stagedImport.title,
        branchId: created.package.primaryBranchId,
        revisionId: created.branchBridge.headRevisionId,
        bodySha256: created.branchBridge.headBodySha256,
        charCount: stagedImport.text.replace(/\s/g, "").length,
        createdAt: created.package.createdAt,
        updatedAt: created.package.updatedAt,
      });
      closeImport();
      const profileLabel = importProfile === "light_archive" ? "轻量建档" : "完整生产";
      notify(stagedImport.document
        ? `已按你的明确选择建立独立新 Article，并记录${profileLabel}预设；工程包结构仅作为候选，尚未自动应用`
        : `已按你的明确选择建立独立新 Article，并记录${profileLabel}预设；原文件未被修改`);
    } catch (caught) {
      setStatus("error");
      setError(caught instanceof Error ? caught.message : "导入失败；尚未覆盖已有工程");
    }
  }, [closeImport, detail, importCandidateDisabledReason, importDestination, importProfile, importRecommendation.recommendation, loadPackage, notify, onLocalArticleImported, postAction, stagedImport]);

  const moveModule = useCallback((moduleKey: string, direction: -1 | 1) => {
    mutateDocument((current) => {
      const index = current.modules.findIndex((module) => module.key === moduleKey);
      const target = index + direction;
      if (index < 0 || target < 0 || target >= current.modules.length) return current;
      const modules = [...current.modules];
      [modules[index], modules[target]] = [modules[target], modules[index]];
      return { ...current, modules };
    });
  }, [mutateDocument]);

  const addModule = useCallback((kind = "paragraph", afterKey?: string) => {
    const newModule: PackageModuleInput = {
      key: uid("module").slice(0, 25),
      kind,
      title: kind === "heading" ? "新标题" : "新模块",
      contentFormat: "markdown",
      contentText: kind === "heading" ? "## 新标题" : "在这里填写内容。",
      metadata: { role: "body", origin: "user", confirmed: true, tags: [] },
      refs: [],
    };
    mutateDocument((current) => {
      const index = afterKey ? current.modules.findIndex((item) => item.key === afterKey) + 1 : current.modules.length;
      const modules = [...current.modules];
      modules.splice(Math.max(0, index), 0, newModule);
      return { ...current, modules };
    });
    setSelectedModuleKey(newModule.key);
  }, [mutateDocument]);

  const updateSelectedModule = useCallback((updates: Partial<PackageModuleInput>) => {
    if (!selectedModule) return;
    mutateDocument((current) => ({
      ...current,
      modules: current.modules.map((module) => module.key === selectedModule.key ? { ...module, ...updates } : module),
    }));
  }, [mutateDocument, selectedModule]);

  const duplicateSelected = useCallback(() => {
    if (!selectedModule) return;
    const copy = cloneDocument({ schemaVersion: "wenmai-package-document-v1", title: "", rootModuleKey: "", modules: [selectedModule], edges: [], assets: [], sources: [], metadata: {} }).modules[0];
    copy.id = undefined;
    copy.key = uid("module").slice(0, 25);
    copy.title = `${selectedModule.title} · 副本`;
    mutateDocument((current) => {
      const index = current.modules.findIndex((module) => module.key === selectedModule.key);
      const modules = [...current.modules];
      modules.splice(index + 1, 0, copy);
      return { ...current, modules };
    });
    setSelectedModuleKey(copy.key);
  }, [mutateDocument, selectedModule]);

  const deleteSelected = useCallback(() => {
    if (!selectedModule || !documentState || documentState.modules.length <= 1) return;
    const next = documentState.modules.find((module) => module.key !== selectedModule.key)?.key ?? "";
    mutateDocument((current) => {
      const modules = current.modules.filter((module) => module.key !== selectedModule.key);
      return {
        ...current,
        rootModuleKey: current.rootModuleKey === selectedModule.key ? (modules[0]?.key ?? "") : current.rootModuleKey,
        modules,
        edges: current.edges.filter((edge) => edge.sourceModuleKey !== selectedModule.key && edge.targetModuleKey !== selectedModule.key),
      };
    });
    setSelectedModuleKey(next);
  }, [documentState, mutateDocument, selectedModule]);

  const addRelation = useCallback(() => {
    if (!documentState || !selectedModule || !relationTarget || relationTarget === selectedModule.key) return;
    mutateDocument((current) => ({
      ...current,
      edges: [...current.edges.filter((edge) => !(edge.sourceModuleKey === selectedModule.key && edge.targetModuleKey === relationTarget && edge.relationType === relationKind)), {
        key: uid("edge").slice(0, 23),
        sourceModuleKey: selectedModule.key,
        targetModuleKey: relationTarget,
        relationType: relationKind,
        ordinal: current.edges.length,
      }],
    }));
    setRelationTarget("");
  }, [documentState, mutateDocument, relationKind, relationTarget, selectedModule]);

  const applySourceDraft = useCallback(() => {
    if (!documentState || editorReadOnly) return;
    const sourceTitle = sourceDraft.match(/^#\s+(.+)$/m)?.[1]?.trim() || documentState.title;
    const parsed = documentFromMarkdown(sourceTitle, sourceDraft, documentState.sources[0]);
    parsed.assets = documentState.assets;
    parsed.sources = documentState.sources;
    parsed.metadata = { ...documentState.metadata, reparsedAt: new Date().toISOString(), previousModuleCount: documentState.modules.length };
    setUndoStack((stack) => [...stack.slice(-39), cloneDocument(documentState)]);
    setRedoStack([]);
    setDocumentState(parsed);
    setSelectedModuleKey(parsed.modules[0]?.key ?? "");
    setDirty(true);
    notify(`源码已重新解包为 ${parsed.modules.length} 个模块；提交前仍可撤销`);
  }, [documentState, editorReadOnly, notify, sourceDraft]);

  const commit = useCallback(async () => {
    if (!detail || !documentState || !commitTitle.trim() || editorReadOnly || !detail.workingCopy.baseRevisionId) return;
    const saved = dirty
      ? await save()
      : { package: detail.package, branchState: detail.branchState, workingCopy: detail.workingCopy, unchanged: true };
    if (!saved) return;
    const current = saved.workingCopy;
    try {
      const data = await postAction<BranchMutationPayload>("commit", {
        packageId: detail.package.id,
        branchId: detail.selectedBranchId,
        expectedPackageLockVersion: saved.package.lockVersion,
        expectedBranchLockVersion: saved.branchState?.lockVersion ?? detail.branchState.lockVersion,
        expectedWorkingLockVersion: current.lockVersion,
        expectedBaseCompositionId: current.baseCompositionId,
        expectedBaseRevisionId: current.baseRevisionId,
        expectedDocumentSha256: current.documentSha256,
        compositionTitle: commitTitle,
      });
      const workingCopy = data.branchWorkingCopy
        ?? (data.workingCopy?.branchId === detail.selectedBranchId && data.workingCopy.baseRevisionId
          ? data.workingCopy as PackageBranchWorkingCopyRecord
          : null);
      if (!data.composition || !workingCopy) throw new Error("提交响应缺少当前分支的新冻结内容版本或工作副本");
      setCommitOpen(false);
      setCommitTitle("");
      setDetail((value) => value ? {
        ...value,
        package: data.package,
        branchState: data.branchState ?? value.branchState,
        branchWorkingCopy: workingCopy,
        branchCommit: data.branchCommit === undefined ? value.branchCommit : data.branchCommit,
        branchBridge: data.branchBridge ?? value.branchBridge,
        composition: data.composition!,
        workingCopy,
      } : value);
      setDocumentState(cloneDocument(workingCopy.document));
      setDirty(false);
      await onWorkspaceChanged(data.package.articleId);
      await loadPackage(data.package.id, detail.selectedBranchId);
      notify(data.unchanged ? "工程与基线一致，没有创建重复修订" : "模块图与阅读正文已冻结为同一不可变修订");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "提交失败；工程工作副本仍保留");
    }
  }, [commitTitle, detail, dirty, documentState, editorReadOnly, loadPackage, notify, onWorkspaceChanged, postAction, save]);

  const runDiagnostics = useCallback(async () => {
    if (!detail) return;
    try {
      const data = await postAction<{ diagnosisRun: DiagnosisRunRecord; issues: DiagnosticIssueRecord[] }>("run_builtin_diagnostics", {
        packageId: detail.package.id,
        branchId: detail.selectedBranchId,
        baseRevisionId: detail.workingCopy.baseRevisionId,
        expectedBranchLockVersion: detail.branchState.lockVersion,
        compositionId: detail.composition.id,
        expectedCompositionSha256: detail.composition.compositionSha256,
      });
      setDiagnosisRuns((current) => [data.diagnosisRun, ...current.filter((run) => run.id !== data.diagnosisRun.id)]);
      setIssues(data.issues);
      notify(data.issues.length ? `诊断定位了 ${data.issues.length} 个绑定当前基线的问题` : "当前基线没有命中内置确定性问题");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "诊断运行失败");
    }
  }, [detail, notify, postAction]);

  const createIssuePatch = useCallback(async (issue: DiagnosticIssueRecord) => {
    if (!detail || !issue.suggestedPatch.length) return;
    try {
      const data = await postAction<{ patchProposal: PackagePatchProposalRecord }>("create_patch", {
        packageId: detail.package.id,
        branchId: detail.selectedBranchId,
        baseRevisionId: detail.workingCopy.baseRevisionId,
        expectedBranchLockVersion: detail.branchState.lockVersion,
        baseCompositionId: detail.composition.id,
        expectedBaseCompositionSha256: detail.composition.compositionSha256,
        title: `修复：${issue.title}`,
        summary: issue.message,
        operations: issue.suggestedPatch,
        evidence: issue.evidence,
        diagnosticIssueIds: [issue.id],
      });
      setPatches((current) => [data.patchProposal, ...current]);
      notify("已生成候选修复；尚未修改当前工程");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "候选修复建立失败");
    }
  }, [detail, notify, postAction]);

  const decidePatch = useCallback(async (patch: PackagePatchProposalRecord, decision: "approved" | "rejected") => {
    try {
      const data = await postAction<{ patchProposal: PackagePatchProposalRecord }>("decide_patch", {
        patchProposalId: patch.id,
        expectedLockVersion: patch.lockVersion,
        decision,
        note: decision === "approved" ? "由内容所有者在文章工程中确认影响后批准" : "由内容所有者拒绝候选修复",
      });
      setPatches((current) => current.map((item) => item.id === patch.id ? data.patchProposal : item));
      notify(decision === "approved" ? "候选修复已批准，仍需单独应用" : "候选修复已拒绝");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "候选决定保存失败");
    }
  }, [notify, postAction]);

  const applyPatch = useCallback(async (patch: PackagePatchProposalRecord) => {
    if (!detail) return;
    try {
      const data = await postAction<BranchMutationPayload & { patchProposal: PackagePatchProposalRecord }>("apply_patch", {
        packageId: detail.package.id,
        branchId: detail.selectedBranchId,
        patchProposalId: patch.id,
        expectedPatchLockVersion: patch.lockVersion,
        expectedBranchLockVersion: detail.branchState.lockVersion,
        expectedHeadCompositionId: detail.branchState.headCompositionId,
        expectedHeadCompositionSha256: detail.branchState.headCompositionSha256,
        expectedHeadRevisionId: detail.branchState.headRevisionId,
      });
      const workingCopy = data.branchWorkingCopy
        ?? (data.workingCopy?.branchId === detail.selectedBranchId && data.workingCopy.baseRevisionId
          ? data.workingCopy as PackageBranchWorkingCopyRecord
          : null);
      if (!data.composition || !workingCopy) throw new Error("应用 Patch 的响应没有返回当前分支状态");
      setDetail((current) => current ? {
        ...current,
        package: data.package,
        branchState: data.branchState ?? current.branchState,
        branchWorkingCopy: workingCopy,
        branchCommit: data.branchCommit === undefined ? current.branchCommit : data.branchCommit,
        branchBridge: data.branchBridge ?? current.branchBridge,
        composition: data.composition!,
        workingCopy,
      } : current);
      setDocumentState(cloneDocument(workingCopy.document));
      setSourceDraft(compileDocument(workingCopy.document));
      setDirty(false);
      setPatches((current) => current.map((item) => item.id === patch.id ? data.patchProposal : item));
      notify("候选修复已通过 CAS（并发摘要检查）应用；请重新运行同一诊断验证结果");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "候选修复无法应用；可能已落后于当前基线");
    }
  }, [detail, notify, postAction]);

  const createSlice = useCallback(async (preset: (typeof SLICE_PRESETS)[number]) => {
    if (!detail || !documentState) return;
    const selected = selectedModuleKeys.length ? selectedModuleKeys : documentState.modules.filter((module) => !moduleHidden(module)).map((module) => module.key);
    try {
      const data = await postAction<{ slice: SliceRecord }>("create_slice", {
        packageId: detail.package.id,
        branchId: detail.selectedBranchId,
        baseRevisionId: detail.workingCopy.baseRevisionId,
        expectedBranchLockVersion: detail.branchState.lockVersion,
        compositionId: detail.composition.id,
        expectedCompositionSha256: detail.composition.compositionSha256,
        title: `${preset.title} · ${new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit" }).format(new Date())}`,
        sliceKind: preset.kind,
        moduleKeys: preset.kind === "full" ? undefined : selected,
        selector: { mode: preset.kind === "full" ? "all_visible" : "explicit_module_keys", selectedCount: selected.length },
      });
      setSlices((current) => [data.slice, ...current]);
      notify(`${preset.title}已绑定当前 Composition 摘要`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "切片构建失败");
    }
  }, [detail, documentState, notify, postAction, selectedModuleKeys]);

  const exportPackage = useCallback(async (slice?: SliceRecord) => {
    if (!detail) return;
    try {
      const data = await postAction<{ exportRun: Record<string, unknown>; manifest: Record<string, unknown> }>("create_export_manifest", {
        packageId: detail.package.id,
        branchId: detail.selectedBranchId,
        baseRevisionId: detail.workingCopy.baseRevisionId,
        expectedBranchLockVersion: detail.branchState.lockVersion,
        compositionId: detail.composition.id,
        expectedCompositionSha256: detail.composition.compositionSha256,
        sliceId: slice?.id,
        expectedSliceSha256: slice?.sliceSha256,
        exportKind: slice ? "slice_package" : "project_package",
        exporterKey: "wenmai-browser-json",
        exporterVersion: "1.0.0",
      });
      const artifact = {
        schemaVersion: "wenmai-project-package/1.0",
        manifest: data.manifest,
        package: detail.package,
        composition: detail.composition,
        document: detail.composition.document,
        workingDocument: documentState,
        slice: slice ?? null,
        generatedAt: new Date().toISOString(),
        boundary: { browserDownloadRequested: true, diskWriteVerified: false, releaseCreated: false },
      };
      downloadJson(`${detail.package.title.replace(/[\\/:*?"<>|]+/g, "-") || "article"}.${slice?.sliceKind ?? "project"}.wenmai.json`, artifact);
      notify("浏览器已发起工程包下载；这不等于磁盘回读验证或外部发布");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "工程包导出失败");
    }
  }, [detail, documentState, notify, postAction]);

  if (status === "loading" && !detail) return <section className="project-editor-loading"><span /><strong>正在读取文章工程</strong><p>正在读取模块图、不可变 Composition（已冻结的内容版本）和当前 WorkingCopy（可编辑工作副本）。</p></section>;

  if (!detail || !documentState) {
    if (selectedPackageId && branchCatalog && selectedBranchEntry) {
      return (
        <section className="article-project-editor project-branch-entry">
          <header className="project-toolbar">
            <div className="project-identity project-branch-identity">
              <label className="project-branch-select"><span>当前制作分支</span><select value={selectedBranchId} disabled={status === "loading" || status === "saving"} onChange={(event) => void switchBranch(event.target.value)}>{branchCatalog.branches.map((branch) => <option key={branch.branchId} value={branch.branchId}>{branch.name}{branch.branchId === branchCatalog.branchModel.primaryBranchId ? " · Primary" : ""}{branch.attached ? " · 已接入" : " · 未接入"}</option>)}</select></label>
              <div className="project-branch-meta"><span className={`project-branch-health ${branchHealthTone}`}>{branchHealthLabel}</span><small>{selectedBranchIsPrimary ? "Primary（默认入口）决定默认打开位置与发行镜像，不是唯一分支" : "独立制作分支 · 接入后拥有自己的冻结内容版本与工作副本"}</small></div>
              <label className="project-package-secondary"><span>工程包（二级项目）</span><select value={selectedPackageId} disabled={status === "loading" || status === "saving"} onChange={(event) => void switchPackage(event.target.value)}>{packages.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label>
            </div>
            <div className="project-branch-entry-summary"><span>ArticleBranch</span><b>{selectedBranchEntry.name}</b></div>
            <div className="project-save-state"><i className={branchHealthTone === "healthy" ? "ready" : "error"} /><span>{branchHealthLabel}</span></div>
              <div className="project-actions"><button onClick={onOpenSourceEditor}>检查源码工作副本</button></div>
          </header>
          <main className={`project-branch-entry-panel ${migrationBlocked ? "blocked" : ""}`}>
            <div className="project-branch-entry-copy">
              <span className="eyebrow">多分支文章工程 · 0010</span>
              <h1>{migrationBlocked ? "先处理迁移审计，才能编辑这份旧工程" : selectedBranchEntry.attached ? "已接入分支暂时无法读取" : "将这条分支接入文章工程"}</h1>
              <p>{migrationBlocked
                ? "迁移审计已阻断。你可以检查分支、基线和原因；在归属确认前，系统不会猜测旧内容版本应归哪条分支，也不会写入。"
                : selectedBranchEntry.attached
                  ? "目录显示该分支已接入，但分支详情、冻结内容版本、可编辑工作副本或桥接证据尚未完整读回。请重新读取；系统不会回退到旧单主线，也不会借用其他分支继续编辑。"
                  : "接入会从本分支当前无改动的分支头建立独立内容版本、工作副本和提交链。它不会创建新的文章分支，也不会推进或覆盖源码分支。"}</p>
              {error && <div className="project-error" role="alert"><strong>当前无法继续</strong><p>{error}</p></div>}
              <dl>
                <div><dt>分支</dt><dd>{selectedBranchEntry.name}</dd></div>
                <div><dt>分支头修订</dt><dd>{selectedBranchEntry.headRevisionId.slice(-12)}</dd></div>
                <div><dt>源码工作副本</dt><dd>{selectedBranchEntry.articleWorkingDirty ? "有未提交修改" : "Clean head"}</dd></div>
                <div><dt>迁移审计</dt><dd>{branchCatalog.branchModel.migrationState}</dd></div>
              </dl>
              <div className="project-entry-actions">
                {selectedBranchEntry.attached
                  ? <button className="primary-button" disabled={Boolean(migrationBlocked || status === "loading")} onClick={() => void loadPackage(branchCatalog.package.id, selectedBranchEntry.branchId)}>重新读取分支</button>
                  : <button className="primary-button" disabled={Boolean(migrationBlocked || selectedBranchEntry.articleWorkingDirty || status === "saving")} onClick={() => void attachSelectedBranch()}>{status === "saving" ? "正在接入…" : "接入这条分支"}</button>}
                <button onClick={onOpenSourceEditor}>{selectedBranchEntry.articleWorkingDirty ? "先处理源码工作副本" : "核对源码分支"}</button>
              </div>
              <p className="project-branch-primary-note">Primary（默认入口）只决定默认打开的分支与发行镜像。其他已接入分支各自保留模块图、可编辑工作副本、并发摘要锁和提交历史。</p>
            </div>
            <aside className="project-branch-audit-card">
              <span className="eyebrow">接入合同</span>
              <h2>按本分支基线接入</h2>
              <ol><li>校验文章分支头与正文摘要</li><li>校验源码工作副本没有未提交修改</li><li>冻结该分支自己的内容版本</li><li>建立分支工作副本与提交证据</li></ol>
              {branchCatalog.migrationAudit && <details><summary>查看迁移审计原因</summary><code>{branchCatalog.migrationAudit.reasonCode || "无阻断原因"}</code><pre>{JSON.stringify(branchCatalog.migrationAudit.detail, null, 2)}</pre></details>}
            </aside>
          </main>
          <footer className="project-statusbar"><span>Package {branchCatalog.package.id.slice(-8)}</span><span>Branch {selectedBranchEntry.branchId.slice(-8)}</span><span>Branch model v{branchCatalog.branchModel.version}</span><button onClick={onOpenSourceEditor}>打开旧版纯文本工位</button></footer>
        </section>
      );
    }
    return (
      <section className="project-onboarding">
        <div className="project-onboarding-copy">
          <span className="eyebrow">文章工程编辑器</span>
          <h1>先选一条文章基线，再开始制作</h1>
          <p>解包后，正文会成为有稳定身份的模块；你可以重排、标记、诊断、创建候选修复、提交修订、建立 Build（构建选择）并再次打包。历史源文件始终只读。</p>
          {error && <div className="project-error" role="alert"><strong>当前无法继续</strong><p>{error}</p></div>}
          <div className="project-entry-actions">
            <button className="primary-button" onClick={() => void ensureCurrentArticle()}>{activeBranch ? "解包当前分支开始制作" : "先选择基线并建立分支"}</button>
            <button onClick={openFilePicker}>导入文章到暂存区</button>
            <button onClick={onOpenSourceEditor}>改用纯文本源码</button>
          </div>
          <input ref={fileInputRef} className="visually-hidden" type="file" accept=".md,.markdown,.txt,.json,.wenmai" onChange={(event) => { const file = event.target.files?.[0]; if (file) void stageFile(file); event.currentTarget.value = ""; }} />
        </div>
        <div className="project-metaphor">
          <div><b>01</b><strong>输入</strong><span>历史文章、Markdown、TXT、工程包</span></div>
          <i />
          <div><b>02</b><strong>解包</strong><span>模块、关系、来源与诊断坐标</span></div>
          <i />
          <div><b>03</b><strong>制作</strong><span>重组模块、管理分支与修订、审查候选修复</span></div>
          <i />
          <div><b>04</b><strong>构建</strong><span>选择成品、Demo 和切片，再导出可逆工程包</span></div>
        </div>
        {packages.length > 0 && <section className="recent-projects"><span className="eyebrow">已有本地工程</span>{packages.slice(0, 8).map((item) => <button key={item.id} onClick={() => { setSelectedPackageId(item.id); void loadPackage(item.id); }}><strong>{item.title}</strong><span>{item.moduleCount ?? "—"} 个模块 · {packageTime(item.updatedAt)}</span></button>)}</section>}
        {importOpen && stagedImport && <ImportDialog
          staged={stagedImport}
          destination={importDestination}
          profile={importProfile}
          recommendationState={importRecommendation}
          candidateTarget={`${article.title} / ${selectedBranchEntry?.name ?? "尚无可写分支"}`}
          candidateDisabledReason={importCandidateDisabledReason}
          onDestination={setImportDestination}
          onProfile={setImportProfile}
          onTitle={(title) => setStagedImport((current) => current ? { ...current, title } : current)}
          onCancel={closeImport}
          onConfirm={() => void confirmImport()}
        />}
      </section>
    );
  }

  const selectedMetadata = selectedModule?.metadata ?? {};
  const relatedIssues = issues.filter((issue) => !issue.moduleId || issue.moduleId === selectedModule?.id);
  const visibleEdges = documentState.edges.filter((edge) => edge.relationType !== "precedes");

  return (
    <section className={`article-project-editor mobile-${mobilePanel}`}>
      <header className="project-toolbar">
        <div className="project-identity project-branch-identity">
          <label className="project-branch-select"><span>当前制作分支</span><select value={selectedBranchId} disabled={status === "loading" || status === "saving"} onChange={(event) => void switchBranch(event.target.value)}>{branchCatalog?.branches.map((branch) => <option key={branch.branchId} value={branch.branchId}>{branch.name}{branch.branchId === branchCatalog.branchModel.primaryBranchId ? " · Primary" : ""}{branch.attached ? " · 已接入" : " · 未接入"}</option>)}</select></label>
          <div className="project-branch-meta"><span className={`project-branch-health ${branchHealthTone}`}>{branchHealthLabel}</span><small>{selectedBranchIsPrimary ? "Primary（默认入口）决定默认打开分支与发行镜像；其他分支仍可独立制作" : `当前独立分支 · 内容版本 ${detail.composition.id.slice(-8)}`}</small></div>
          <label className="project-package-secondary"><span>工程包（二级项目）</span><select value={detail.package.id} disabled={status === "loading" || status === "saving"} onChange={(event) => void switchPackage(event.target.value)}>{packages.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label>
        </div>
        <div className="project-mode-switch" role="tablist" aria-label="切换文章工程工作模式">
          {([[
            "structure", "编辑模块"], ["source", "编辑源码"], ["preview", "查看成品"], ["build", "构建与诊断"]] as Array<[EditorMode, string]>).map(([id, label]) => <button key={id} role="tab" aria-selected={mode === id} className={mode === id ? "active" : ""} onClick={() => setMode(id)}>{label}</button>)}
        </div>
        <div className="project-save-state"><i className={dirty ? "dirty" : status} /><span>{status === "saving" ? "正在保存" : dirty ? "有未保存工程修改" : `已保存 · ${packageTime(detail.workingCopy.updatedAt)}`}</span></div>
        <div className="project-actions">
          <button onClick={openFilePicker}>导入到暂存区</button>
          <button disabled={editorReadOnly || !undoStack.length} onClick={undo}>撤销上一步</button>
          <button disabled={editorReadOnly || !redoStack.length} onClick={redo}>恢复已撤销操作</button>
          <button disabled={editorReadOnly || !dirty || status === "saving"} onClick={() => void save()}>保存工作副本</button>
          <button className="primary-button" disabled={editorReadOnly} onClick={openCommitDialog}>创建工程修订</button>
        </div>
        <input ref={fileInputRef} className="visually-hidden" type="file" accept=".md,.markdown,.txt,.json,.wenmai" onChange={(event) => { const file = event.target.files?.[0]; if (file) void stageFile(file); event.currentTarget.value = ""; }} />
      </header>

      {error && <div className="project-error project-error-strip" role="alert"><strong>这次工程操作未完成</strong><span>{error}</span><button onClick={() => setError("")}>关闭提示</button></div>}
      {editorReadOnly && <div className={`project-readonly-banner ${migrationBlocked ? "blocked" : "stale"}`} role="status"><strong>{migrationBlocked ? "迁移审计阻断：先只读核对" : "分支桥接失步：暂时只读"}</strong><span>{migrationBlocked ? "系统不会猜测旧内容版本的分支归属；请先处理迁移审计，再恢复写入。" : "文章分支、冻结内容版本或工作副本不在同一基线；刷新或修复接入关系后再写入。"}</span></div>}

      <details className={`project-guidance-panel ${detail.guidanceChecklist.archiveState}`} open={!detail.guidanceChecklist.archiveReady || guidanceProfileDecisionRequired}>
        <summary>
          <span><b>指导检查表</b><small>绑定 {detail.guidanceChecklist.checklistSha256.slice(0, 12)}</small></span>
          <strong>{!detail.guidanceChecklist.archiveReady ? "建档需要修复" : guidanceProfileDecisionRequired ? "轻建档已读回 · 待人工分流" : detail.guidanceChecklist.processingProfile === "full_production" ? "完整生产已获准" : "轻量建档已确认"}</strong>
          <em>{detail.guidanceChecklist.summary.passed} 通过 · {detail.guidanceChecklist.summary.pending} 待补 · {detail.guidanceChecklist.summary.humanRequired} 待人工</em>
        </summary>
        <div className="project-guidance-body">
          <header>
            <div><span className="eyebrow">下一步 · {GUIDANCE_ACTOR_LABELS[detail.guidanceChecklist.nextAction.actor]}</span><p>{detail.guidanceChecklist.nextAction.instruction}</p></div>
            <div>{!detail.guidanceChecklist.archiveReady && <button onClick={openFilePicker}>重新导入原文件</button>}<button onClick={() => setMode("build")}>查看诊断</button></div>
          </header>
          <div className="project-guidance-checks">
            {detail.guidanceChecklist.checks.map((check) => <article key={check.id} className={check.status}>
              <span>{check.status === "passed" ? "通过" : check.status === "human_required" ? "待人工" : check.status === "not_applicable" ? "未进入" : check.status === "blocked" ? "阻断" : "待补"}</span>
              <div><strong>{check.title}</strong><small>{check.id} · {GUIDANCE_ACTOR_LABELS[check.responsibleActor]}</small><p>{check.instruction}</p></div>
            </article>)}
          </div>
          {guidanceProfileDecisionVisible && <section className="project-guidance-triage" aria-labelledby="project-guidance-triage-title">
            <div>
              <span className="eyebrow">{guidanceProfileDecisionRequired ? "需要人工决定" : "当前人工档位"}</span>
              <strong id="project-guidance-triage-title">{guidanceProfileDecisionRequired ? "选择这篇文章的处理档位" : detail.guidanceChecklist.processingProfile === "full_production" ? "完整生产 · 可审计更改" : "轻量建档 · 可审计升级"}</strong>
              <p>这个决定只解锁后续处理档位，不代表编辑完成、工件已交付、平台已提交或内容已经公开。</p>
            </div>
            <label>
              <span>决定说明（必填）</span>
              <textarea
                value={guidanceDecisionNote}
                onChange={(event) => setGuidanceDecisionNote(event.target.value)}
                placeholder="写清选择该档位的理由、目标与边界"
                rows={3}
                disabled={editorReadOnly || status === "saving"}
              />
            </label>
            <div className="project-guidance-triage-actions">
              <button
                disabled={!guidanceDecisionNote.trim() || editorReadOnly || status === "saving"}
                onClick={() => void decideGuidanceProfile("light_archive")}
              >{detail.guidanceChecklist.profileAuthority === "human" ? "改为轻量建档" : "确认轻量建档"}</button>
              <button
                className="primary-button"
                disabled={!guidanceDecisionNote.trim() || editorReadOnly || status === "saving"}
                onClick={() => void decideGuidanceProfile("full_production")}
              >{detail.guidanceChecklist.profileAuthority === "human" ? "改为完整生产" : "确认进入完整生产"}</button>
            </div>
            <small>提交后以服务端返回的新检查表为准；工作台不会在本地推断决定已经生效。</small>
          </section>}
          <footer><span>Agent 只能逐模块处理并提交 candidate Patch（候选补丁）</span><span>建档不代表编辑完成、工件交付、平台提交或公开可见</span><span>最终完成仍由协调者依据证据判断</span></footer>
        </div>
      </details>

      <nav className="project-mobile-tabs" aria-label="切换移动端文章工程面板">{([['outline', '查看大纲'], ['canvas', '编辑模块'], ['inspector', '编辑属性'], ['preview', '查看成品']] as Array<[MobilePanel, string]>).map(([id, label]) => <button key={id} className={mobilePanel === id ? "active" : ""} onClick={() => { setMobilePanel(id); setMode(id === "preview" ? "preview" : "structure"); }}>{label}</button>)}</nav>

      <fieldset className="project-editor-workarea" disabled={editorReadOnly} aria-label={editorReadOnly ? "文章工程只读区域，需先恢复可写基线" : "文章工程编辑区域，可修改当前工作副本"}>
      {mode === "structure" && <div className="project-structure-layout">
        <aside className="project-outline-panel">
          <div className="project-panel-head"><div><span className="eyebrow">工程大纲</span><strong>{documentState.modules.length} 个模块</strong></div><button aria-label="新增段落模块" onClick={() => addModule("paragraph", selectedModule?.key)}>＋</button></div>
          <input value={moduleQuery} onChange={(event) => setModuleQuery(event.target.value)} placeholder="按标题、角色或正文筛选…" aria-label="按标题、角色或正文筛选工程模块" />
          <div className="project-module-list" role="tree" aria-label="文章模块大纲">
            {filteredModules.map((module, index) => <button key={module.key} role="treeitem" aria-selected={module.key === selectedModule?.key} className={`${module.key === selectedModule?.key ? "active" : ""} ${moduleHidden(module) ? "hidden" : ""}`} onClick={() => { setSelectedModuleKey(module.key); setMobilePanel("inspector"); }}><i>{String(documentState.modules.indexOf(module) + 1).padStart(2, "0")}</i><span><strong>{module.title}</strong><small>{MODULE_KINDS.find(([kind]) => kind === module.kind)?.[1] ?? module.kind} · {String(module.metadata?.role ?? "未定角色")}</small></span>{issues.some((issue) => issue.moduleId && issue.moduleId === module.id) && <em title="这个模块有诊断问题">!</em>}<b>{index < filteredModules.length - 1 ? "↓" : "·"}</b></button>)}
          </div>
          <footer><button onClick={() => addModule("heading", selectedModule?.key)}>＋ 标题</button><button onClick={() => addModule("paragraph", selectedModule?.key)}>＋ 段落</button></footer>
        </aside>

        <main className="project-canvas-panel">
          <div className="project-canvas-head"><div><span className="eyebrow">模块结构</span><h2>{documentState.title}</h2><p>纵向顺序就是阅读顺序；节点下方显示语义关系。选择模块后可在右侧修改它的属性和内容。</p></div><div><span>{visibleEdges.length} 条语义关系</span><span>{documentState.sources.length} 个来源</span><span>{issues.length} 个诊断问题</span></div></div>
          <div className="project-flow-canvas">
            {documentState.modules.map((module, index) => {
              const moduleIssues = issues.filter((issue) => issue.moduleId && issue.moduleId === module.id);
              const outgoing = visibleEdges.filter((edge) => edge.sourceModuleKey === module.key);
               return <div key={module.key} role="button" aria-pressed={module.key === selectedModule?.key} className={`project-flow-node ${module.key === selectedModule?.key ? "selected" : ""} ${moduleHidden(module) ? "is-hidden" : ""}`} onClick={() => setSelectedModuleKey(module.key)} tabIndex={0} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setSelectedModuleKey(module.key); } }}>
                <div className="node-flow-index"><span>{String(index + 1).padStart(2, "0")}</span>{index < documentState.modules.length - 1 && <i />}</div>
                <div className="node-body"><header><span>{MODULE_KINDS.find(([kind]) => kind === module.kind)?.[1] ?? module.kind}</span><em>{String(module.metadata?.role ?? "body")}</em>{module.metadata?.origin === "deterministic_import" && <small>自动解包</small>}</header><h3>{module.title}</h3><p>{moduleText(module).replace(/^#{1,6}\s+/, "").slice(0, 220) || "空模块"}</p><footer><div><button aria-label="上移模块" disabled={index === 0} onClick={(event) => { event.stopPropagation(); moveModule(module.key, -1); }}>↑</button><button aria-label="下移模块" disabled={index === documentState.modules.length - 1} onClick={(event) => { event.stopPropagation(); moveModule(module.key, 1); }}>↓</button></div><span>{module.refs?.length ?? 0} 个引用</span>{moduleIssues.length > 0 && <button className="node-issue" onClick={(event) => { event.stopPropagation(); setSelectedModuleKey(module.key); setMode("build"); }}>{moduleIssues.length} 个问题</button>}</footer>{outgoing.length > 0 && <div className="node-relations">{outgoing.map((edge) => <span key={edge.key}>{RELATION_KINDS.find(([kind]) => kind === edge.relationType)?.[1] ?? edge.relationType} → {documentState.modules.find((item) => item.key === edge.targetModuleKey)?.title ?? edge.targetModuleKey}</span>)}</div>}</div>
              </div>;
            })}
          </div>
        </main>

        <aside className="project-inspector-panel">
          {selectedModule ? <>
            <div className="project-panel-head"><div><span className="eyebrow">属性检查器</span><strong>{selectedModule.title}</strong></div><code>{selectedModule.key.slice(-8)}</code></div>
            <div className="project-module-key"><span>发送 Agent 任务时使用的 moduleKey</span><code>{selectedModule.key}</code><button type="button" onClick={() => void navigator.clipboard.writeText(selectedModule.key)}>复制 moduleKey</button></div>
            <label>模块类型<select value={selectedModule.kind} onChange={(event) => updateSelectedModule({ kind: event.target.value })}>{MODULE_KINDS.map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label>
            <label>制作角色<select value={String(selectedMetadata.role ?? "body")} onChange={(event) => updateSelectedModule({ metadata: { ...selectedMetadata, role: event.target.value } })}><option value="opening">开场 / Hook</option><option value="context">背景</option><option value="argument">论点</option><option value="evidence">证据</option><option value="example">案例</option><option value="transition">过渡</option><option value="body">正文</option><option value="conclusion">结尾</option><option value="cta">行动</option></select></label>
            <label>模块名称<input value={selectedModule.title} onChange={(event) => updateSelectedModule({ title: event.target.value })} /></label>
            <label className="module-content-field">模块内容<textarea value={moduleText(selectedModule)} onChange={(event) => updateSelectedModule({ contentText: event.target.value, contentFormat: "markdown" })} /></label>
            <label>标签<input value={Array.isArray(selectedMetadata.tags) ? selectedMetadata.tags.join("、") : ""} onChange={(event) => updateSelectedModule({ metadata: { ...selectedMetadata, tags: event.target.value.split(/[、,，]/).map((item) => item.trim()).filter(Boolean) } })} placeholder="观点、证据、待核对…" /></label>
            <div className="module-provenance"><span className="eyebrow">来源与审阅标记</span><dl><div><dt>来源</dt><dd>{String(selectedMetadata.origin ?? "user")}</dd></div><div><dt>标记</dt><dd>{selectedMetadata.confirmed === true ? "人工审阅标记（仅元数据）" : "尚未标记"}</dd></div><div><dt>引用</dt><dd>{selectedModule.refs?.length ?? 0} 条</dd></div></dl><button onClick={() => updateSelectedModule({ metadata: { ...selectedMetadata, confirmed: true, confirmedAt: new Date().toISOString() } })}>记录人工审阅标记</button><small>此标记不能代替服务端档位决定、批准 Patch 或完成回执。</small></div>
            <div className="module-relation-editor"><span className="eyebrow">增加语义关系</span><select value={relationKind} onChange={(event) => setRelationKind(event.target.value)}>{RELATION_KINDS.filter(([id]) => id !== "precedes").map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select><select value={relationTarget} onChange={(event) => setRelationTarget(event.target.value)}><option value="">选择目标模块</option>{documentState.modules.filter((module) => module.key !== selectedModule.key).map((module) => <option key={module.key} value={module.key}>{module.title}</option>)}</select><button disabled={!relationTarget} onClick={addRelation}>建立关系</button></div>
            <div className="module-actions"><button onClick={duplicateSelected}>复制模块</button><button onClick={() => updateSelectedModule({ metadata: { ...selectedMetadata, hidden: !moduleHidden(selectedModule) } })}>{moduleHidden(selectedModule) ? "恢复到成品" : "从成品隐藏"}</button><button className="danger" disabled={documentState.modules.length <= 1} onClick={deleteSelected}>删除模块</button></div>
            {relatedIssues.length > 0 && <div className="module-inline-issues"><span className="eyebrow">绑定问题</span>{relatedIssues.slice(0, 5).map((issue) => <button key={issue.id} onClick={() => setMode("build")}><b>{issue.severity}</b><span>{issue.title}</span></button>)}</div>}
          </> : <div className="project-empty-inspector"><strong>先选择一个模块</strong><p>随后可编辑它的内容角色、来源和关系，并查看与它绑定的诊断问题。</p></div>}
        </aside>
      </div>}

      {mode === "source" && <div className="project-source-mode"><header><div><span className="eyebrow">编辑 Markdown 源码</span><h2>这里显示当前工程编译出的 Markdown</h2><p>修改后选择“重新解包源码”，当前结构会替换为新的稳定模块；第一条 H1 同步为工程标题，提交前仍可撤销。</p></div><button className="primary-button" onClick={applySourceDraft}>重新解包并更新模块</button></header><div><textarea value={sourceDraft} onChange={(event) => setSourceDraft(event.target.value)} spellCheck aria-label="可编辑的文章工程 Markdown 源码" /><aside><MarkdownPreview markdown={sourceDraft} empty="当前源码没有可预览内容；请先输入 Markdown。" /></aside></div></div>}

      {mode === "preview" && <div className="project-preview-mode"><header><div><span className="eyebrow">读者看到的成品</span><h2>{documentState.title}</h2><p>这里仅显示当前可见模块的确定性编译结果；工程角色、来源和诊断信息不会写入文章。</p></div><dl><div><dt>可见模块</dt><dd>{documentState.modules.filter((module) => !moduleHidden(module)).length}</dd></div><div><dt>字数</dt><dd>{compiledMarkdown.replace(/\s/g, "").length.toLocaleString("zh-CN")}</dd></div><div><dt>未保存修改</dt><dd>{dirty ? "有" : "无"}</dd></div></dl></header><article><MarkdownPreview markdown={compiledMarkdown} empty="当前工程没有可见正文；请返回编辑模块或源码。" /></article></div>}

      {mode === "build" && <div className="project-build-mode">
        <section className="project-build-main"><header><div><span className="eyebrow">构建与切片</span><h2>从同一冻结内容版本生成不同阅读版本</h2><p>勾选要保留的模块，再建立绑定当前摘要的 Build（构建选择）。这个记录只保存模块选择，不会发布内容。</p></div><button onClick={() => void exportPackage()}>导出完整工程包</button></header><div className="slice-module-picker">{documentState.modules.map((module) => <label key={module.key} className={selectedModuleKeys.includes(module.key) ? "selected" : ""}><span className="sr-only">选择文章模块</span><input type="checkbox" aria-label={`选择模块：${module.title}`} checked={selectedModuleKeys.includes(module.key)} onChange={(event) => setSelectedModuleKeys((current) => event.target.checked ? [...current, module.key] : current.filter((key) => key !== module.key))} /><span><strong>{module.title}</strong><small>{module.kind} · {moduleHidden(module) ? "成品隐藏" : "可见"}</small></span></label>)}</div><div className="slice-presets">{SLICE_PRESETS.map((preset) => <article key={preset.kind}><span>{preset.kind}</span><h3>{preset.title}</h3><p>{preset.note}</p><button onClick={() => void createSlice(preset)}>按此方案建立构建选择</button></article>)}</div>{slices.length > 0 && <div className="slice-history"><span className="eyebrow">已冻结的构建选择</span>{slices.map((slice) => <div key={slice.id}><span><strong>{slice.title}</strong><small>{slice.sliceKind} · {slice.sliceSha256.slice(0, 10)}</small></span><button onClick={() => void exportPackage(slice)}>导出此构建版本</button></div>)}</div>}</section>
        <aside className="project-diagnostics"><header><div><span className="eyebrow">检查与候选修复</span><h2>{issues.length ? `${issues.length} 个绑定问题` : "尚未运行诊断"}</h2></div><button onClick={() => void runDiagnostics()}>检查当前基线</button></header>{dirty && <p className="diagnostic-stale-note">当前有未保存的工程修改；诊断只检查最近一次不可变内容版本，不会判断这些修改。</p>}{issues.map((issue) => <article key={issue.id} className={issue.severity}><header><b>{issue.severity === "error" ? "阻断" : issue.severity === "warning" ? "注意" : "建议"}</b><code>{issue.code}</code></header><h3>{issue.title}</h3><p>{issue.message}</p><small>{issue.moduleId ? `模块 ${issue.moduleId.slice(-8)}` : "全篇问题"}</small><div><button onClick={() => { const issueModule = documentState.modules.find((item) => item.id === issue.moduleId); if (issueModule) { setSelectedModuleKey(issueModule.key); setMode("structure"); } }}>定位到模块</button>{issue.suggestedPatch.length > 0 && <button onClick={() => void createIssuePatch(issue)}>创建候选修复</button>}</div></article>)}{!issues.length && <div className="diagnostic-empty"><strong>诊断不会直接改文章</strong><p>运行后会冻结当前内容版本，定位模块或关系，并把可自动处理的建议生成候选补丁；仍需你审查、批准并应用。</p></div>}{diagnosisRuns[0] && <footer>最近一次：{diagnosisRuns[0].algorithmVersion} · {packageTime(diagnosisRuns[0].createdAt)} · {diagnosisRuns[0].result}</footer>}
          {patches.length > 0 && <section className="patch-list"><span className="eyebrow">待审候选修复</span>{patches.map((patch) => <article key={patch.id}><header><strong>{patch.title}</strong><em>{patch.status}</em></header><p>{patch.summary || `${patch.operations.length} 个操作`}</p><div>{patch.status === "candidate" && <><button onClick={() => void decidePatch(patch, "approved")}>批准候选修复</button><button onClick={() => void decidePatch(patch, "rejected")}>拒绝候选修复</button></>}{patch.status === "approved" && <button className="primary-button" onClick={() => void applyPatch(patch)}>应用到当前工程</button>}</div></article>)}</section>}
        </aside>
      </div>}

      </fieldset>
      <footer className="project-statusbar"><span>工程包 Package {detail.package.id.slice(-8)}</span><span>分支 Branch {detail.selectedBranchId.slice(-8)}</span><span>内容版本 Composition {detail.composition.compositionSha256.slice(0, 10)}</span>{documentImportProfile && <span className={`project-profile ${documentImportProfile}`}>处理预设 {documentImportProfile === "light_archive" ? "轻量建档 · 尚未进入发布准备" : `完整生产 · 推荐 ${String(documentImportWorkflow?.workflowRecommendation?.recipeId ?? "证据驱动长文")} · 含信息型封面门禁`}</span>}<span>工作副本 WorkingCopy {detail.workingCopy.documentSha256.slice(0, 10)} · {documentState.sources.length} 个来源 · {documentState.assets.length} 个资产 · {documentState.edges.length} 条关系</span><button onClick={onOpenSourceEditor}>打开纯文本源码</button></footer>

      {commitOpen && <dialog ref={commitDialogRef} className="project-dialog" aria-labelledby="project-commit-title" onCancel={(event) => { event.preventDefault(); setCommitOpen(false); }}><header><div><span className="eyebrow">不可变工程检查点</span><h2 id="project-commit-title">同时冻结模块图和阅读正文</h2></div><button aria-label="关闭提交面板" onClick={() => setCommitOpen(false)}>×</button></header><dl><div><dt>分支</dt><dd>{selectedBranchEntry?.name ?? detail.selectedBranchId.slice(-8)}</dd></div><div><dt>模块</dt><dd>{documentState.modules.length}</dd></div><div><dt>关系</dt><dd>{documentState.edges.length}</dd></div><div><dt>当前正文</dt><dd>{compiledMarkdown.replace(/\s/g, "").length} 字</dd></div></dl><label>修订名称<input ref={commitTitleRef} value={commitTitle} onChange={(event) => setCommitTitle(event.target.value)} /></label><p>提交只推进当前文章分支与它自己的冻结内容版本；CAS（并发摘要检查）冲突不会覆盖其他窗口或其他分支。</p><footer><button onClick={() => setCommitOpen(false)}>继续编辑</button><button className="primary-button" disabled={editorReadOnly || !commitTitle.trim()} onClick={() => void commit()}>创建工程修订</button></footer></dialog>}

      {importOpen && stagedImport && <ImportDialog
        staged={stagedImport}
        destination={importDestination}
        profile={importProfile}
        recommendationState={importRecommendation}
        candidateTarget={`${article.title} / ${selectedBranchEntry?.name ?? detail.selectedBranchId.slice(-8)}`}
        candidateDisabledReason={importCandidateDisabledReason}
        onDestination={setImportDestination}
        onProfile={setImportProfile}
        onTitle={(title) => setStagedImport((current) => current ? { ...current, title } : current)}
        onCancel={closeImport}
        onConfirm={() => void confirmImport()}
      />}
    </section>
  );
}

function ImportDialog({
  staged,
  destination,
  profile,
  recommendationState,
  candidateTarget,
  candidateDisabledReason,
  onDestination,
  onProfile,
  onTitle,
  onCancel,
  onConfirm,
}: {
  staged: StagedImport;
  destination: ImportDestination;
  profile: ImportProcessingProfile | null;
  recommendationState: ImportRecommendationState;
  candidateTarget: string;
  candidateDisabledReason: string;
  onDestination: (destination: ImportDestination) => void;
  onProfile: (profile: ImportProcessingProfile) => void;
  onTitle: (title: string) => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (!dialog.open) dialog.showModal();
    const frame = window.requestAnimationFrame(() => titleRef.current?.focus());
    return () => {
      window.cancelAnimationFrame(frame);
      if (dialog.open) dialog.close();
    };
  }, []);
  const confirmDisabled = !staged.title.trim()
    || !staged.text.trim()
    || profile === null
    || staged.warnings.some((warning) => warning.includes("没有"))
    || (destination === "candidate" && Boolean(candidateDisabledReason));
  const recommendation = recommendationState.recommendation;
  const recommendationLabel = recommendation?.recommendedProfile === "full_production" ? "完整生产" : "轻量建档";
  const humanOverride = Boolean(profile && recommendation && profile !== recommendation.recommendedProfile);
  return (
    <dialog ref={dialogRef} className="project-dialog import-staging" aria-labelledby="project-import-title" onCancel={(event) => { event.preventDefault(); onCancel(); }}>
      <header>
      <div><span className="eyebrow">只读导入暂存</span><h2 id="project-import-title">先核对文件，再决定归属和处理预设</h2></div>
        <button aria-label="关闭导入暂存，不写入文件" onClick={onCancel}>×</button>
      </header>
      <div className="import-file-facts">
        <div><dt>文件</dt><dd>{staged.name}</dd></div><div><dt>格式</dt><dd>{staged.format}</dd></div>
        <div><dt>大小</dt><dd>{staged.bytes.toLocaleString("zh-CN")} B</dd></div>
        <div><dt>SHA-256</dt><dd><code>{staged.sha256.slice(0, 16)}</code></dd></div>
        <div><dt>标题</dt><dd>{staged.headings}</dd></div><div><dt>文本块</dt><dd>{staged.paragraphs}</dd></div>
      </div>
      <fieldset className="import-destination" aria-describedby="import-destination-help">
        <legend>1. 这份文件属于哪里</legend>
        <label htmlFor="import-destination-candidate" className={destination === "candidate" ? "selected recommended" : "recommended"}>
          <input id="import-destination-candidate" aria-label="作为当前文章和当前分支的候选 Patch 导入" type="radio" name="import-destination" value="candidate" checked={destination === "candidate"} disabled={Boolean(candidateDisabledReason)} onChange={() => onDestination("candidate")} />
          <span><strong>作为当前文章 / 当前分支的候选 Patch 导入 <em>推荐</em></strong><small>目标：{candidateTarget}</small><p>只创建可审查的候选 Patch；不会新建 Article，不会推进 Composition 或 Revision，也不会自动批准或应用。</p></span>
        </label>
        <label htmlFor="import-destination-new-article" className={destination === "new_article" ? "selected destructive" : "destructive"}>
          <input id="import-destination-new-article" aria-label="将文件建立为独立新文章" type="radio" name="import-destination" value="new_article" checked={destination === "new_article"} onChange={() => onDestination("new_article")} />
          <span><strong>建立独立新文章</strong><small>仅当它确实不是当前文章的版本、语料或中间稿时选择</small><p>会建立新的 Article、Branch、Revision 和 Package；同一文件重试按 SHA-256 复用身份，避免重复新根。</p></span>
        </label>
      </fieldset>
      {candidateDisabledReason && <p id="import-destination-help" className="import-candidate-disabled" role="status"><strong>当前不能使用推荐方式：</strong>{candidateDisabledReason}</p>}
      <label>工程名称（不改正文 H1）<input ref={titleRef} value={staged.title} onChange={(event) => onTitle(event.target.value)} /></label>
      <p className="import-boundary">工程名称只用于管理；读者看到的正文标题仍取预览中的第一条 H1。进入工程后可在源码模式同时修改两者。</p>

      <section className={`import-profile-recommendation ${recommendationState.status}`} role="status" aria-live="polite">
        {recommendationState.status === "loading" && <><strong>正在生成处理预设建议</strong><p>你可以现在手动选择；建议不会替你勾选或写入任何内容。</p></>}
        {recommendationState.status === "ready" && recommendation && <>
          <strong>处理建议：{recommendationLabel}</strong>
          <small>置信度 {Math.round(recommendation.confidence * 100)}% · 仍需你选择</small>
          <ul>{recommendation.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul>
        </>}
        {recommendationState.status === "fallback" && recommendation && <>
          <strong>模型判断未完成；可参考规则建议：{recommendationLabel}</strong>
          <p>{recommendation.reasons[0]}</p>
        </>}
        {recommendationState.status === "unavailable" && <>
          <strong>处理建议暂不可用</strong><p>请手动选择；仍可继续导入，界面不会把规则判断写成模型建议。</p>
        </>}
        <small>隐私边界：云端模型只接收格式、篇幅、结构和脱敏信号；不会接收正文、文件名、标题或 SHA。</small>
      </section>

      <fieldset className="import-destination import-profile" aria-describedby="import-profile-help">
        <legend>2. 选择处理预设（必须人工确认）</legend>
        <label htmlFor="import-profile-light" className={`${profile === "light_archive" ? "selected" : ""} ${recommendation?.recommendedProfile === "light_archive" ? "model-recommended" : ""}`.trim()}>
          <input id="import-profile-light" aria-label="选择轻量建档" type="radio" name="import-profile" value="light_archive" checked={profile === "light_archive"} onChange={() => onProfile("light_archive")} />
          <span><strong>轻量建档 {recommendation?.recommendedProfile === "light_archive" && <em>建议</em>}</strong><small>先形成可检索、可追溯、可继续制作的档案</small><p>保留正文、Article / Branch / Revision / Package 身份、来源 SHA 和处理决定；不生成封面、DOCX 或平台物料，也不表示可发布。</p></span>
        </label>
        <label htmlFor="import-profile-full" className={`${profile === "full_production" ? "selected" : ""} ${recommendation?.recommendedProfile === "full_production" ? "model-recommended" : ""}`.trim()}>
          <input id="import-profile-full" aria-label="选择完整生产" type="radio" name="import-profile" value="full_production" checked={profile === "full_production"} onChange={() => onProfile("full_production")} />
          <span><strong>完整生产 {recommendation?.recommendedProfile === "full_production" && <em>建议</em>}</strong><small>进入深加工和交付门禁，不等于已经完成</small><p>后续推荐“证据驱动长文 · 标准线”，进入事实核验、成稿、审校、信息型封面独立表达合同与缩略图/裁切/综合色偏/哈希门禁、DOCX、平台适配和交付流程；本次导入只记录请求，不自动启动、生成或发布。</p></span>
        </label>
      </fieldset>
      <p id="import-profile-help" className="import-boundary">
        {profile === null ? "请选择一种处理预设；推荐只是候选判断。" : humanOverride ? "你选择了与推荐不同的预设；将按人工选择执行，并记录覆盖证据。" : destination === "candidate" ? "处理预设只进入候选 Patch；批准并应用前，当前 Article 不会改变。" : "处理预设会写入新 Article 的首个不可变 Composition。"}
      </p>
      {staged.warnings.length > 0 && <div className="import-warnings"><strong>需要先核对</strong>{staged.warnings.map((warning) => <p key={warning}>{warning}</p>)}</div>}
      <div className="import-preview"><MarkdownPreview markdown={staged.text.slice(0, 12000)} empty="没有可预览正文。" /></div>
      <p className="import-boundary">确认前不会创建或修改 Article、Revision、Composition 或 Package；推荐请求只保留防重放回执，原文件仍留在原处。候选只是待审差异，尚未合入；只有选择“建立独立新文章”才会创建新的 Article 根。</p>
      <footer><button onClick={onCancel}>取消并保持不写入</button><button className="primary-button" disabled={confirmDisabled} onClick={onConfirm}>{destination === "candidate" ? "创建候选，不自动应用" : "确认建立独立新文章"}</button></footer>
    </dialog>
  );
}
