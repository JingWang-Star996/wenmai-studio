"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ArticleBranch, WorkbenchArticle } from "./workbench-types";
import { ArticleQuickLink } from "./ArticlePreview";
import MetaImprovementLab from "./MetaImprovementLab";
import { managementFetch } from "./management-fetch";
import type { AgentPermission, AgentPermissionArticleObject, AgentPermissionCatalog } from "./agent-types";
import { validatePermissionScopeCombination } from "./agent-permission-catalog";
import {
  COLLABORATION_ACCESS_MAX_LIFETIME_DAYS,
  COLLABORATION_ACCESS_PROFILES,
  buildCollaborationAccessCard,
  buildPortableCollaborationAccessFile,
  type CollaborationAccessMode,
} from "./collaboration-access";
import {
  PORTABLE_AGENT_ROLE_PROFILES,
  buildAgentRoleConnectionCard,
  buildPortableAgentRoleAccessFile,
  roleIdForClient,
  type PortableAgentRoleId,
} from "./portable-agent-access";

type AgentTaskState = "draft" | "queued" | "claimed" | "running" | "awaiting_human" | "blocked" | "review" | "succeeded" | "failed" | "cancelled";

const BRANCH_WRITABLE_CLASSES = new Set(["published_article", "platform_build", "import_artifact", "draft_or_intermediate"]);

const DEFAULT_TAILSCALE_HOST = "";
const WENMAI_PROFILE_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,31}$/;
const TAILSCALE_HOST_PATTERN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.){2}ts\.net$/;
const WENMAI_PROJECT_ROOT_PLACEHOLDER = "<文脉工程绝对路径>";
const WINDOWS_POWERSHELL = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
const MAX_PRIVILEGED_ARTICLE_IDS = 200;
const PERMISSION_CATALOG_TIMEOUT_MS = 10_000;

type AgentClientLifetimeDays = number;
type AgentClientPreset = "role-steward" | "role-worker" | "local-operator" | "share-viewer" | "share-editor" | "observer" | "worker" | "candidate" | "permission-catalog";
type PrivilegedArticleScope = "all_articles" | "selected_articles";

const STEWARD_SCOPES = [...PORTABLE_AGENT_ROLE_PROFILES["content-steward"].scopes];
const ARTICLE_WORKER_SCOPES = [...PORTABLE_AGENT_ROLE_PROFILES["article-worker"].scopes];

function portableRoleIdForPreset(preset: AgentClientPreset): PortableAgentRoleId | null {
  if (preset === "role-steward") return "content-steward";
  if (preset === "role-worker") return "article-worker";
  if (preset === "local-operator") return "local-registrar";
  return null;
}

function collaborationModeForPreset(preset: AgentClientPreset): CollaborationAccessMode | null {
  if (preset === "share-viewer") return "viewer";
  if (preset === "share-editor") return "editor";
  return null;
}

interface AgentProgressEvent {
  id: string;
  cursor: number;
  taskId: string;
  attemptId: string | null;
  eventType: string;
  phase: string;
  progressPercent: number | null;
  currentAction: string;
  nextAction: string;
  blocker: string;
  message: string;
  evidence: unknown[];
  createdAt: string;
}

interface AgentTask {
  id: string;
  workItemId: string | null;
  articleId: string;
  projectId: string | null;
  targetBranchId: string | null;
  currentContextSnapshotId: string | null;
  activeAttemptId: string | null;
  assignedClientId: string | null;
  title: string;
  objective: string;
  instructionsMd: string;
  acceptance: unknown[];
  contextSpec: Record<string, unknown>;
  permissionCeiling: Record<string, unknown>;
  priority: "P0" | "P1" | "P2" | "P3";
  state: AgentTaskState;
  lockVersion: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
  cancelledAt: string | null;
  latestEvent?: AgentProgressEvent | null;
}

function currentTailscaleHost() {
  if (typeof window === "undefined") return DEFAULT_TAILSCALE_HOST;
  const hostname = window.location.hostname.trim().toLowerCase();
  return TAILSCALE_HOST_PATTERN.test(hostname) ? hostname : DEFAULT_TAILSCALE_HOST;
}

function agentBranchTaskIsShareable(task: AgentTask, branches: ArticleBranch[]) {
  const permission = task.permissionCeiling;
  const allow = Array.isArray(permission.allow) ? permission.allow.map(String) : [];
  const deny = Array.isArray(permission.deny) ? permission.deny.map(String) : [];
  const requiredAllows = ["article.read", "task.progress", "artifact.create", "branch.agent_write"];
  const requiredDenies = ["main.write", "main.merge", "editorial.approve", "release.approve", "external.submit", "rule.adopt", "source.write", "token.issue"];
  const code = task.id.replace(/^agent-task-/, "").replaceAll("-", "").slice(0, 12);
  const branchId = `agent-branch-${task.id}`;
  const branch = branches.find((item) => item.id === branchId);
  return !["succeeded", "failed", "cancelled"].includes(task.state)
    && permission.writeScope === "agent-branch"
    && permission.branchWrite === true
    && requiredAllows.every((scope) => allow.includes(scope))
    && requiredDenies.every((scope) => deny.includes(scope))
    && permission.externalSideEffects === false
    && permission.humanApprovalRequired === true
    && task.targetBranchId === branchId
    && branch?.articleId === task.articleId
    && branch.status === "active"
    && branch.name === `agent/${code}`
    && branch.slug === `agent-${code}`;
}

interface AgentClient {
  id: string;
  label: string;
  clientKind: "codex" | "mcp" | "custom";
  role: "agent" | "administrator" | "super_admin";
  scopes: string[];
  articleIds: string[];
  taskIds: string[];
  status: "active" | "revoked";
  effectiveStatus: "active" | "expired" | "revoked";
  expiresAt: string;
  lastSeenAt: string | null;
  createdAt: string;
  revokedAt: string | null;
  credentialPurpose?: "agent_api" | "management_session_exchange" | "site_full_control";
  issuedBySourceClientId?: string | null;
  permissionProfile?: { presetId?: string; catalogVersion?: string; catalogSha256?: string; profileVersion?: string; actionIds?: string[]; snapshotSha256?: string; schemaVersion?: number; directAgentApi?: boolean; managementProjectionVersion?: string; managementScopes?: string[]; managementProjectionSha256?: string } | null;
  collaborationAccessMode?: CollaborationAccessMode | null;
}

interface AgentContextSnapshot {
  id: string;
  taskId: string;
  articleId: string;
  branchId: string | null;
  revisionId: string;
  bodySha256: string;
  corpusSchemaVersion: string;
  corpusAlgorithmVersion: string;
  corpusGeneratedAt: string;
  corpusSha256: string;
  graphSha256: string;
  rulesSha256: string;
  contextSha256: string;
  packageBaseline?: Record<string, unknown> | null;
  guidanceChecklist?: Record<string, unknown> | null;
  createdAt: string;
}

interface AgentAttempt {
  id: string;
  taskId: string;
  clientId: string;
  attempt: number;
  contextSnapshotId: string;
  state: string;
  lastHeartbeatAt: string | null;
  startedAt: string;
  finishedAt: string | null;
  errorClass: string | null;
  errorSummary: string | null;
}

interface AgentArtifact {
  id: string;
  taskId: string;
  attemptId: string;
  kind: string;
  title: string;
  contentRef: string;
  sha256: string;
  mediaType: string;
  sizeBytes: number;
  payload: Record<string, unknown>;
  contextSha256: string;
  createdAt: string;
}

interface AgentApproval {
  id: string;
  taskId: string;
  attemptId: string;
  kind: string;
  title: string;
  question: string;
  options: string[];
  status: "pending" | "approved" | "rejected";
  requestedByClientId: string;
  decisionNote: string;
  lockVersion: number;
  createdAt: string;
  decidedAt: string | null;
}

interface GraphProposal {
  id: string;
  taskId: string;
  attemptId: string;
  articleId: string;
  proposalKind: string;
  sourceId: string | null;
  targetId: string | null;
  relationType: string;
  label: string;
  payload: Record<string, unknown>;
  evidence: string[];
  contextSha256: string;
  inputSha256: string;
  status: "candidate" | "confirmed" | "rejected";
  lockVersion: number;
  createdByClientId: string;
  createdAt: string;
  reviewedAt: string | null;
  reviewedBy: string | null;
  reviewNote: string;
}

interface PackagePatchReceipt {
  id: string;
  packageId: string;
  branchId: string | null;
  baseRevisionId: string | null;
  taskId: string | null;
  attemptId: string | null;
  contextSha256: string | null;
  title: string;
  summary: string;
  operations: unknown[];
  patchSha256: string;
  evidence: string[];
  diagnosticIssueIds: string[];
  status: "candidate" | "approved" | "rejected" | "applied";
  lockVersion: number;
  createdAt: string;
  reviewedAt: string | null;
  appliedAt: string | null;
}

interface TaskDetail {
  task: AgentTask;
  contextSnapshots: AgentContextSnapshot[];
  attempts: AgentAttempt[];
  events: AgentProgressEvent[];
  artifacts: AgentArtifact[];
  approvalRequests: AgentApproval[];
  graphProposals: GraphProposal[];
  packagePatchProposals: PackagePatchReceipt[];
}

type ApiEnvelope<T> = { ok: true; requestId: string; data: T } | { ok: false; requestId: string; error: { code: string; message: string; details?: unknown } };

const STATE_LABELS: Record<AgentTaskState, string> = {
  draft: "草稿",
  queued: "待领取",
  claimed: "已领取",
  running: "执行中",
  awaiting_human: "等我决定",
  blocked: "被阻塞",
  review: "待验收",
  succeeded: "已完成",
  failed: "失败",
  cancelled: "已取消",
};

const BOARD_COLUMNS: Array<{ id: string; label: string; states: AgentTaskState[] }> = [
  { id: "queue", label: "待开始", states: ["draft", "queued"] },
  { id: "active", label: "正在工作", states: ["claimed", "running"] },
  { id: "human", label: "需要我", states: ["awaiting_human", "blocked", "review"] },
  { id: "done", label: "已结束", states: ["succeeded", "failed", "cancelled"] },
];

function timeLabel(value: string | null) {
  if (!value) return "尚无";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(date);
}

function commandId(prefix: string) {
  return `${prefix}-${crypto.randomUUID()}`;
}

function short(value: string) {
  return value ? value.slice(0, 10) : "未绑定";
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function catalogPermissions(catalog: AgentPermissionCatalog | null) {
  return catalog?.permissions ?? catalog?.scopes ?? [];
}

function catalogArticleObjects(catalog: AgentPermissionCatalog | null): AgentPermissionArticleObject[] {
  return catalog?.articleObjects ?? [];
}

function canIssuePermission(permission: AgentPermission) {
  return permission.delegable && permission.newIssuance === true;
}

function derivedPermissionRole(catalog: AgentPermissionCatalog | null, scopes: string[]) {
  return scopes.every((scope) => catalogPermissions(catalog).find((item) => item.scope === scope)?.allowedRoles.includes("administrator")) ? "administrator" : "super_admin";
}

function maxClientLifetimeForRole(privilegedPreset: boolean, role: "administrator" | "super_admin"): AgentClientLifetimeDays {
  return privilegedPreset ? (role === "super_admin" ? 7 : 30) : 90;
}

function normalizeClientLifetimeDays(current: AgentClientLifetimeDays, maximum: AgentClientLifetimeDays): AgentClientLifetimeDays {
  if (!Number.isInteger(current) || current < 1) return 1;
  return current > maximum ? maximum : current;
}

function presetIdOf(preset: { id?: string; presetId?: string }) { return preset.id ?? preset.presetId ?? ""; }

async function readEnvelope<T>(response: Response): Promise<T> {
  const payload = await response.json() as ApiEnvelope<T>;
  if (!response.ok || !payload.ok) {
    const message = payload.ok ? `HTTP ${response.status}` : payload.error.message;
    throw new Error(message);
  }
  return payload.data;
}

export default function AgentConsole({
  articles,
  selectedArticle,
  branches,
  onOpenArticle,
  notify,
  onRsiChanged,
}: {
  articles: WorkbenchArticle[];
  selectedArticle: WorkbenchArticle;
  branches: ArticleBranch[];
  onOpenArticle: (articleId: string) => void;
  notify: (message: string) => void;
  onRsiChanged?: () => void;
}) {
  const [agentSurface, setAgentSurface] = useState<"tasks" | "improvement">("tasks");
  const [tasks, setTasks] = useState<AgentTask[]>([]);
  const [pollGeneration, setPollGeneration] = useState(0);
  const [clients, setClients] = useState<AgentClient[]>([]);
  const [selectedTaskId, setSelectedTaskId] = useState("");
  const [detail, setDetail] = useState<TaskDetail | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState("");
  const [composerOpen, setComposerOpen] = useState(false);
  const [clientPanelOpen, setClientPanelOpen] = useState(false);
  const [taskTitle, setTaskTitle] = useState("");
  const [taskObjective, setTaskObjective] = useState("");
  const [taskInstructions, setTaskInstructions] = useState("");
  const [taskAcceptance, setTaskAcceptance] = useState("");
  const [taskArticleId, setTaskArticleId] = useState(selectedArticle.id);
  const [taskBranchId, setTaskBranchId] = useState(branches[0]?.id ?? "");
  const [taskTargetModuleKey, setTaskTargetModuleKey] = useState("");
  const [taskPriority, setTaskPriority] = useState<"P0" | "P1" | "P2" | "P3">("P2");
  const [taskWriteScope, setTaskWriteScope] = useState<"artifact-only" | "agent-branch" | "graph-proposal" | "package-patch">("artifact-only");
  const [taskOwnerContract, setTaskOwnerContract] = useState<"public_explanation" | "experience_method">("public_explanation");
  const [taskEditorialMode, setTaskEditorialMode] = useState<"not_applicable" | "research_survey" | "mechanism_explanation" | "case_analysis" | "how_to">("not_applicable");
  const [taskStance, setTaskStance] = useState<"neutral" | "exploratory" | "critical" | "advocacy">("neutral");
  const [taskTitleJob, setTaskTitleJob] = useState("");
  const [taskOpeningJob, setTaskOpeningJob] = useState("");
  const [taskTensionBasis, setTaskTensionBasis] = useState("");
  const [clientLabel, setClientLabel] = useState("我的 Codex Agent");
  const [clientKind, setClientKind] = useState<"codex" | "mcp" | "custom">("codex");
  const [clientPreset, setClientPreset] = useState<AgentClientPreset>("role-steward");
  const [permissionCatalog, setPermissionCatalog] = useState<AgentPermissionCatalog | null>(null);
  const [permissionCatalogLoading, setPermissionCatalogLoading] = useState(false);
  const [permissionCatalogError, setPermissionCatalogError] = useState("");
  const [selectedPrivilegedScopes, setSelectedPrivilegedScopes] = useState<string[]>([]);
  const [selectedPrivilegedArticleIds, setSelectedPrivilegedArticleIds] = useState<string[]>([]);
  const [privilegedArticleScope, setPrivilegedArticleScope] = useState<PrivilegedArticleScope>("all_articles");
  const [privilegedArticleSearch, setPrivilegedArticleSearch] = useState("");
  const [selectedPermissionPresetId, setSelectedPermissionPresetId] = useState("custom");
  const [catalogConfirmedVersion, setCatalogConfirmedVersion] = useState("");
  const [catalogConfirmedSha256, setCatalogConfirmedSha256] = useState("");
  const [clientArticleId, setClientArticleId] = useState(selectedArticle.id);
  const [clientTaskId, setClientTaskId] = useState("");
  const [clientPackageMode, setClientPackageMode] = useState<"read" | "read-patch" | "none">("read");
  const [clientLifetimeDays, setClientLifetimeDays] = useState<AgentClientLifetimeDays>(7);
  const [clientTransport, setClientTransport] = useState<"local" | "tailscale">("local");
  const [clientTailscaleHost, setClientTailscaleHost] = useState(currentTailscaleHost);
  const [clientProfileName, setClientProfileName] = useState("codex-feishu");
  const [issuedClient, setIssuedClient] = useState<{ client: AgentClient; token: string; exportedAt: string; origin: string; roleId: PortableAgentRoleId | null } | null>(null);
  const [issuedTokenVisible, setIssuedTokenVisible] = useState(false);
  const [clientCopyFallback, setClientCopyFallback] = useState<{ label: string; value: string } | null>(null);
  const [decisionNote, setDecisionNote] = useState("");
  const [busy, setBusy] = useState("");
  const composerDialogRef = useRef<HTMLDialogElement>(null);
  const composerInitialFocusRef = useRef<HTMLInputElement>(null);
  const composerReturnFocusRef = useRef<HTMLElement | null>(null);
  const clientDialogRef = useRef<HTMLDialogElement>(null);
  const clientInitialFocusRef = useRef<HTMLInputElement>(null);
  const clientReturnFocusRef = useRef<HTMLElement | null>(null);
  const issuedClientResultRef = useRef<HTMLElement>(null);
  const taskSurfaceHeadingRef = useRef<HTMLHeadingElement>(null);
  const improvementSurfaceHeadingRef = useRef<HTMLHeadingElement>(null);
  const issueAttemptRef = useRef<{ signature: string; commandId: string } | null>(null);
  const permissionCatalogVersionRef = useRef("");
  const permissionCatalogLoadIdRef = useRef(0);
  const surfaceFocusInitializedRef = useRef(false);
  const tasksRef = useRef<AgentTask[]>([]);
  const rsiObservedStatesRef = useRef(new Map<string, AgentTaskState>());
  const rsiSummaryCatchupRef = useRef(false);
  const selectedTaskIdRef = useRef("");
  const branchWritableArticles = useMemo(() => articles.filter((article) => BRANCH_WRITABLE_CLASSES.has(article.classification.class)), [articles]);
  const taskTargets = taskWriteScope === "agent-branch" ? branchWritableArticles : articles;
  const shareableTasks = useMemo(() => tasks.filter((task) => task.articleId === clientArticleId && agentBranchTaskIsShareable(task, branches)), [branches, clientArticleId, tasks]);

  const openComposer = useCallback(() => {
    composerReturnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setComposerOpen(true);
  }, []);

  const openClientPanel = useCallback(() => {
    clientReturnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setIssuedClient(null);
    setIssuedTokenVisible(false);
    setClientCopyFallback(null);
    setClientPreset("role-steward");
    setPrivilegedArticleScope("all_articles");
    setClientArticleId("*");
    setClientTaskId("");
    setClientLifetimeDays(7);
    setClientTailscaleHost(currentTailscaleHost());
    setClientPanelOpen(true);
  }, []);

  const loadPermissionCatalog = useCallback(async (includeArticles = false) => {
    const loadId = ++permissionCatalogLoadIdRef.current;
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), PERMISSION_CATALOG_TIMEOUT_MS);
    setPermissionCatalogLoading(true);
    setPermissionCatalog(null);
    setPermissionCatalogError("");
    try {
      const data = await managementFetch(`/api/agent/v1?view=permission_catalog${includeArticles ? "&includeArticles=1" : ""}`, { cache: "no-store", signal: controller.signal }).then((response) => readEnvelope<{ catalog: AgentPermissionCatalog }>(response));
      if (loadId !== permissionCatalogLoadIdRef.current) return;
      const previousCatalogVersion = permissionCatalogVersionRef.current;
      const articleIds = new Set(catalogArticleObjects(data.catalog).map((article) => article.id));
      setPermissionCatalog(data.catalog);
      permissionCatalogVersionRef.current = data.catalog.catalogVersion;
      setPermissionCatalogError("");
      setCatalogConfirmedVersion((current) => previousCatalogVersion && (previousCatalogVersion !== data.catalog.catalogVersion || catalogConfirmedSha256 !== data.catalog.catalogSha256) ? "" : current);
      setCatalogConfirmedSha256(data.catalog.catalogSha256 ?? "");
      if (includeArticles) setSelectedPrivilegedArticleIds((current) => {
        const available = current.filter((id) => articleIds.has(id));
        if (available.length) return available.slice(0, MAX_PRIVILEGED_ARTICLE_IDS);
        return articleIds.has(selectedArticle.id) ? [selectedArticle.id] : [];
      });
    } catch (caught) {
      if (loadId !== permissionCatalogLoadIdRef.current) return;
      setPermissionCatalog(null);
      permissionCatalogVersionRef.current = "";
      setCatalogConfirmedVersion("");
      setCatalogConfirmedSha256("");
      setSelectedPrivilegedArticleIds([]);
      setPermissionCatalogError(caught instanceof DOMException && caught.name === "AbortError" ? "请求超过 10 秒未完成" : caught instanceof Error ? caught.message : "权限目录不可用");
    } finally {
      window.clearTimeout(timeoutId);
      if (loadId === permissionCatalogLoadIdRef.current) setPermissionCatalogLoading(false);
    }
  }, [catalogConfirmedSha256, selectedArticle.id]);

  const closeClientPanel = useCallback(() => {
    setIssuedClient(null);
    setIssuedTokenVisible(false);
    setClientCopyFallback(null);
    setClientPanelOpen(false);
  }, []);

  useEffect(() => {
    if (!composerOpen) return;
    const dialog = composerDialogRef.current;
    if (!dialog) return;
    if (!dialog.open) dialog.showModal();
    const frame = window.requestAnimationFrame(() => composerInitialFocusRef.current?.focus());
    return () => {
      window.cancelAnimationFrame(frame);
      if (dialog.open) dialog.close();
      window.requestAnimationFrame(() => composerReturnFocusRef.current?.focus());
    };
  }, [composerOpen]);

  useEffect(() => {
    if (!clientPanelOpen) return;
    const catalogTimer = window.setTimeout(() => void loadPermissionCatalog(), 0);
    const dialog = clientDialogRef.current;
    if (!dialog) return;
    if (!dialog.open) dialog.showModal();
    const frame = window.requestAnimationFrame(() => clientInitialFocusRef.current?.focus());
    return () => {
      window.clearTimeout(catalogTimer);
      window.cancelAnimationFrame(frame);
      if (dialog.open) dialog.close();
      window.requestAnimationFrame(() => clientReturnFocusRef.current?.focus());
    };
  }, [clientPanelOpen, loadPermissionCatalog]);

  useEffect(() => {
    if (!issuedClient) return;
    const result = issuedClientResultRef.current;
    if (!result) return;
    result.scrollIntoView({ behavior: "smooth", block: "nearest" });
    result.focus({ preventScroll: true });
  }, [issuedClient]);

  useEffect(() => {
    if (!surfaceFocusInitializedRef.current) {
      surfaceFocusInitializedRef.current = true;
      return;
    }
    const frame = window.requestAnimationFrame(() => {
      const target = agentSurface === "improvement" ? improvementSurfaceHeadingRef.current : taskSurfaceHeadingRef.current;
      target?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [agentSurface]);

  const loadTasks = useCallback(async (quiet = false) => {
    try {
      const [taskData, healthData] = await Promise.all([
        managementFetch("/api/agent/v1?view=tasks", { cache: "no-store" }).then((response) => readEnvelope<{ tasks: AgentTask[] }>(response)),
        managementFetch("/api/agent/v1?view=health", { cache: "no-store" }).then((response) => readEnvelope<{ clients?: AgentClient[] }>(response)),
      ]);
      const terminal = new Set<AgentTaskState>(["succeeded", "failed", "cancelled"]);
      const changed = taskData.tasks.some((task) => !terminal.has(rsiObservedStatesRef.current.get(task.id) ?? task.state) && terminal.has(task.state));
      const catchUp = !rsiSummaryCatchupRef.current;
      rsiSummaryCatchupRef.current = true;
      rsiObservedStatesRef.current = new Map(taskData.tasks.map((task) => [task.id, task.state]));
      tasksRef.current = taskData.tasks;
      if (catchUp || changed) onRsiChanged?.();
      if (!taskData.tasks.some((task) => task.id === selectedTaskIdRef.current)) selectedTaskIdRef.current = taskData.tasks[0]?.id ?? "";
      setTasks(taskData.tasks);
      setClients(healthData.clients ?? []);
      setSelectedTaskId((current) => taskData.tasks.some((task) => task.id === current) ? current : taskData.tasks[0]?.id ?? "");
      setState("ready");
      setError("");
    } catch (caught) {
      if (!quiet) setState("error");
      setError(caught instanceof Error ? caught.message : "Agent 控制平面不可用");
    }
  }, [onRsiChanged]);

  const loadDetail = useCallback(async (taskId: string, quiet = false) => {
    if (!taskId) {
      setDetail(null);
      return;
    }
    try {
      const data = await managementFetch(`/api/agent/v1?view=task&id=${encodeURIComponent(taskId)}`, { cache: "no-store" }).then((response) => readEnvelope<TaskDetail>(response));
      if (selectedTaskIdRef.current !== taskId) return;
      setDetail(data);
      if (!quiet) setError("");
    } catch (caught) {
      if (!quiet) setError(caught instanceof Error ? caught.message : "任务详情不可用");
    }
  }, []);

  useEffect(() => { tasksRef.current = tasks; }, [tasks]);
  useEffect(() => { selectedTaskIdRef.current = selectedTaskId; }, [selectedTaskId]);
  useEffect(() => {
    const backoffMs = [3000, 6000, 12000, 24000, 60000];
    const isTerminal = (task: AgentTask) => ["succeeded", "failed", "cancelled"].includes(task.state);
    let timer: number | undefined; let cancelled = false; let attempt = 0;
    const canPoll = () => document.visibilityState === "visible" && tasksRef.current.some((task) => !isTerminal(task));
    const poll = async () => {
      if (cancelled || !canPoll()) return;
      const selected = selectedTaskIdRef.current;
      await Promise.all([loadTasks(true), selected ? loadDetail(selected, true) : Promise.resolve()]);
      if (cancelled || !canPoll()) return;
      attempt = Math.min(attempt + 1, backoffMs.length - 1);
      timer = window.setTimeout(() => void poll(), backoffMs[attempt]);
    };
    const start = () => { if (!canPoll()) return; attempt = 0; void poll(); };
    const onVisibilityChange = () => { if (timer) window.clearTimeout(timer); if (document.visibilityState === "visible") start(); };
    const bootstrapTimer = window.setTimeout(() => { void loadTasks().finally(start); }, 0);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => { cancelled = true; window.clearTimeout(bootstrapTimer); if (timer) window.clearTimeout(timer); document.removeEventListener("visibilitychange", onVisibilityChange); };
  }, [loadDetail, loadTasks, pollGeneration]);

  const post = useCallback(async <T,>(action: string, payload: Record<string, unknown>, needsCommand = true, explicitCommandId?: string) => {
    const response = await managementFetch("/api/agent/v1", {
      method: "POST",
      headers: { "content-type": "application/json", "X-Wenmai-Write": "1" },
      body: JSON.stringify({ action, ...(needsCommand ? { commandId: explicitCommandId ?? commandId(action) } : {}), payload }),
    });
    return readEnvelope<T>(response);
  }, []);

  const createTask = useCallback(async () => {
    const targetModuleKey = taskTargetModuleKey.trim();
    if (!taskTitle.trim() || !taskObjective.trim() || !taskArticleId) return;
    if (taskWriteScope === "package-patch" && (!taskBranchId || !targetModuleKey)) return;
    const scopes = ["corpus.read", "graph.read", "article.read", "task.progress"];
    if (taskWriteScope !== "graph-proposal") scopes.push("artifact.create");
    if (taskWriteScope === "agent-branch") scopes.push("branch.agent_write");
    if (taskWriteScope === "graph-proposal") scopes.push("graph.propose");
    if (taskWriteScope === "package-patch") scopes.push("package.patch.propose");
    const writingContract = taskEditorialMode === "not_applicable" ? null : {
      schemaVersion: "writing-contract/1.0",
      ownerContract: taskOwnerContract,
      editorialMode: taskEditorialMode,
      stance: taskStance,
      titleJob: taskTitleJob.trim(),
      openingJob: taskOpeningJob.trim(),
      tensionBasis: taskTensionBasis.trim(),
    };
    setBusy("create-task");
    try {
      const data = await post<{ task: AgentTask }>("create_task", {
        articleId: taskArticleId,
        baseBranchId: taskBranchId || null,
        targetBranchId: taskWriteScope === "package-patch" ? taskBranchId : null,
        ...(taskWriteScope === "package-patch" ? { targetModuleKey } : {}),
        writeScope: taskWriteScope,
        title: taskTitle,
        objective: taskObjective,
        instructionsMd: taskInstructions,
        acceptance: taskAcceptance.split(/\r?\n/).map((line) => line.trim()).filter(Boolean),
        priority: taskPriority,
        contextSpec: {
          includeArticle: true,
          includeGraph: true,
          graphDepth: 1,
          includeAdoptedRules: true,
          ...(taskWriteScope === "package-patch" ? { targetModuleKey } : {}),
          ...(writingContract ? { writingContract } : {}),
        },
        permissionCeiling: { allow: scopes, writeScope: taskWriteScope, deny: ["main.merge", "editorial.approve", "release.approve", "external.submit", "rule.adopt", "source.write", "token.issue"] },
      });
      setComposerOpen(false);
      setTaskTitle("");
      setTaskObjective("");
      setTaskInstructions("");
      setTaskAcceptance("");
      setTaskTargetModuleKey("");
      setTaskEditorialMode("not_applicable");
      setTaskStance("neutral");
      setTaskTitleJob("");
      setTaskOpeningJob("");
      setTaskTensionBasis("");
      await loadTasks();
      setSelectedTaskId(data.task.id);
      selectedTaskIdRef.current = data.task.id;
      setPollGeneration((generation) => generation + 1);
      notify("Agent 任务已创建并进入任务池；上下文快照与权限上限已经冻结");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Agent 任务创建失败");
    } finally {
      setBusy("");
    }
  }, [loadTasks, notify, post, taskAcceptance, taskArticleId, taskBranchId, taskEditorialMode, taskInstructions, taskObjective, taskOpeningJob, taskOwnerContract, taskPriority, taskStance, taskTargetModuleKey, taskTensionBasis, taskTitle, taskTitleJob, taskWriteScope]);

  const issueClient = useCallback(async () => {
    const collaborationMode = collaborationModeForPreset(clientPreset);
    const roleId = portableRoleIdForPreset(clientPreset);
    const roleProfile = roleId ? PORTABLE_AGENT_ROLE_PROFILES[roleId] : null;
    const fixedRoleScopes = roleId === "content-steward" ? STEWARD_SCOPES : roleId === "article-worker" ? ARTICLE_WORKER_SCOPES : roleId === "local-registrar" ? ["article.import.new_root"] : null;
    const privilegedRolePreset = clientPreset === "permission-catalog" || roleId === "content-steward";
    const requestedScopes = fixedRoleScopes ?? selectedPrivilegedScopes;
    const catalogArticleIds = new Set(catalogArticleObjects(permissionCatalog).map((article) => article.id));
    const selectedArticleIdsAreCurrent = privilegedArticleScope === "all_articles" || (selectedPrivilegedArticleIds.length > 0 && selectedPrivilegedArticleIds.every((id) => id !== "*" && catalogArticleIds.has(id)));
    const selectedScopesAreIssuable = requestedScopes.length > 0 && requestedScopes.every((scope) => canIssuePermission(catalogPermissions(permissionCatalog).find((item) => item.scope === scope) ?? { delegable: false, newIssuance: false } as AgentPermission));
    const scopeCombination = validatePermissionScopeCombination(requestedScopes);
    const requestedPermissionRole = derivedPermissionRole(permissionCatalog, requestedScopes);
    const maximumLifetimeDays = collaborationMode
      ? COLLABORATION_ACCESS_MAX_LIFETIME_DAYS
      : roleProfile
        ? roleProfile.maxLifetimeDays
        : maxClientLifetimeForRole(clientPreset === "permission-catalog", requestedPermissionRole);
    if (!Number.isInteger(clientLifetimeDays) || clientLifetimeDays < 1 || clientLifetimeDays > maximumLifetimeDays) {
      setError(`有效期必须是 1 到 ${maximumLifetimeDays} 天之间的整数。`);
      return;
    }
    if (privilegedRolePreset && (!permissionCatalog || !permissionCatalog.catalogSha256 || !selectedScopesAreIssuable || !scopeCombination.valid
      || (clientPreset === "permission-catalog" && (permissionCatalog.catalogVersion !== catalogConfirmedVersion || permissionCatalog.catalogSha256 !== catalogConfirmedSha256 || !selectedArticleIdsAreCurrent)))) {
      setError("权限目录、可签发 scope 或文章边界已变化；请刷新目录后重新确认具体勾选。");
      return;
    }
    setBusy("issue-client");
    try {
      const scopes = collaborationMode
        ? [...COLLABORATION_ACCESS_PROFILES[collaborationMode].scopes]
        : fixedRoleScopes
          ? [...fixedRoleScopes]
          : clientPreset === "permission-catalog"
        ? [...selectedPrivilegedScopes].sort()
        : clientPreset === "observer"
        ? ["task.read", "context.read", "knowledge.read", "graph.read", "package.read"]
        : clientPreset === "worker"
          ? ["task.read", "task.claim", "task.progress", "context.read", "knowledge.read", "graph.read", "artifact.create", "approval.request", "package.read"]
          : clientPreset === "local-operator"
            ? ["article.import.new_root"]
            : ["task.read", "task.claim", "task.progress", "context.read", "knowledge.read", "graph.read", "artifact.create", "approval.request", "graph.propose", "branch.agent_write"];
      if (clientPreset === "candidate" && clientPackageMode !== "none") scopes.push("package.read");
      if (clientPreset === "candidate" && clientPackageMode === "read-patch") scopes.push("package.patch.propose");
      const payloadArticleIds = collaborationMode ? [clientArticleId] : roleId ? ["*"] : privilegedArticleScope === "all_articles" ? ["*"] : clientPreset === "permission-catalog" ? [...selectedPrivilegedArticleIds].sort() : [clientArticleId];
      const payload = {
        label: clientLabel,
        clientKind,
        scopes,
        ...(roleId !== "local-registrar" ? {
          articleScope: { mode: collaborationMode ? "selected_articles" : roleId ? "all_articles" : privilegedArticleScope, articleIds: payloadArticleIds },
        } : {}),
        ...(privilegedRolePreset ? {
          catalogVersion: permissionCatalog!.catalogVersion,
          catalogSha256: permissionCatalog!.catalogSha256,
          confirmedActionIds: [...new Set(requestedScopes.flatMap((scope) => (catalogPermissions(permissionCatalog).find((item) => item.scope === scope)?.actions ?? []).map((action) => action.actionId)))].sort(),
          permissionPresetId: roleId === "content-steward" ? "task_admin" : selectedPermissionPresetId,
          role: requestedPermissionRole,
        } : {}),
        articleIds: payloadArticleIds,
        taskIds: collaborationMode === "editor" ? [clientTaskId] : [],
        expiresAt: new Date(Date.now() + clientLifetimeDays * 24 * 60 * 60 * 1000).toISOString(),
      };
      const signature = JSON.stringify(payload);
      if (!issueAttemptRef.current || issueAttemptRef.current.signature !== signature) {
        issueAttemptRef.current = { signature, commandId: commandId("issue-client") };
      }
      const data = await post<{ client: AgentClient; token?: string | null; shownOnce: boolean; recovery?: string }>(
        "issue_client",
        payload,
        true,
        issueAttemptRef.current.commandId,
      );
      issueAttemptRef.current = null;
      if (!data.token || !data.shownOnce) {
        setIssuedClient(null);
        setIssuedTokenVisible(false);
        await loadTasks();
        setError("这次签发已由服务器执行，但一次性明文 Key 无法重放。请在列表中撤销该客户端后重新签发。");
        return;
      }
      const origin = clientTransport === "tailscale" ? `https://${clientTailscaleHost.trim().toLowerCase()}` : "http://[::1]:3000";
      setIssuedClient({ client: data.client, token: data.token, exportedAt: new Date().toISOString(), origin, roleId });
      setIssuedTokenVisible(false);
      await loadTasks();
      notify(collaborationMode || roleId ? "连接钥匙已生成；下载单个文件交给目标 Agent 即可" : "Agent 客户端凭据已签发；明文 token 只显示这一次");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "凭据签发失败");
    } finally {
      setBusy("");
    }
  }, [catalogConfirmedSha256, catalogConfirmedVersion, clientArticleId, clientKind, clientLabel, clientLifetimeDays, clientPackageMode, clientPreset, clientTailscaleHost, clientTaskId, clientTransport, loadTasks, notify, permissionCatalog, post, privilegedArticleScope, selectedPermissionPresetId, selectedPrivilegedArticleIds, selectedPrivilegedScopes]);

  const copyIssuedToken = useCallback(async () => {
    if (!issuedClient) return;
    try {
      if (!navigator.clipboard?.writeText) throw new Error("clipboard unavailable");
      await navigator.clipboard.writeText(issuedClient.token);
      setIssuedTokenVisible(false);
      setClientCopyFallback(null);
      notify(issuedClient.client.collaborationAccessMode || issuedClient.roleId ? "一次性 Key 已复制；只放入目标 Agent 的秘密输入，不要放进连接卡、URL 或聊天记录" : "一次性 Agent Key 已复制；只粘贴到 DPAPI 脚本的隐藏输入");
    } catch {
      setIssuedTokenVisible(true);
      notify(issuedClient.client.collaborationAccessMode || issuedClient.roleId ? "浏览器未允许复制；已显示一次性 Key，请手动放入目标 Agent 的秘密输入" : "浏览器未允许复制；已显示一次性 Key，请手动选择后粘贴到隐藏输入");
    }
  }, [issuedClient, notify]);

  const copyClientText = useCallback(async (value: string, label: string, successMessage: string) => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error("clipboard unavailable");
      await navigator.clipboard.writeText(value);
      setClientCopyFallback(null);
      notify(successMessage);
    } catch {
      setClientCopyFallback({ label, value });
      notify(`浏览器未允许复制；已显示${label}，请手动全选复制`);
    }
  }, [notify]);

  const applyPrivilegedScopes = useCallback((nextScopes: string[]) => {
    const normalizedScopes = nextScopes.includes("site.full_control") ? ["site.full_control"] : nextScopes;
    const nextRole = derivedPermissionRole(permissionCatalog, normalizedScopes);
    const nextMaximum = maxClientLifetimeForRole(true, nextRole);
    setSelectedPrivilegedScopes(normalizedScopes);
    setClientLifetimeDays((current) => normalizeClientLifetimeDays(current, nextMaximum));
    if (permissionCatalog?.catalogSha256) {
      setCatalogConfirmedVersion(permissionCatalog.catalogVersion);
      setCatalogConfirmedSha256(permissionCatalog.catalogSha256);
    }
  }, [permissionCatalog]);

  const prepareClientReplacement = useCallback((client: AgentClient) => {
    if (issuedClient) {
      notify("请先保存并验证当前一次性 Key，或完成并关闭当前签发流程，再准备换发");
      return;
    }
    const existingRoleId = roleIdForClient({
      role: client.role,
      scopes: client.scopes,
      articleIds: client.articleIds,
      taskIds: client.taskIds,
      permissionPresetId: client.permissionProfile?.presetId ?? null,
      actionIds: client.permissionProfile?.actionIds ?? [],
    });
    const replacementPreset: AgentClientPreset = client.collaborationAccessMode === "viewer"
      ? "share-viewer"
      : client.collaborationAccessMode === "editor"
        ? "share-editor"
        : existingRoleId === "content-steward"
          ? "role-steward"
          : existingRoleId === "article-worker"
            ? "role-worker"
            : existingRoleId === "local-registrar"
              ? "local-operator"
        : client.role === "super_admin" || client.role === "administrator"
      ? "permission-catalog"
        : client.scopes.includes("article.import.new_root")
          ? "local-operator"
          : client.scopes.includes("branch.agent_write") || client.scopes.includes("graph.propose") || client.scopes.includes("package.patch.propose")
            ? "candidate"
            : client.scopes.includes("task.claim")
              ? "worker"
              : "observer";
    const replacementProfileBase = (clientProfileName.trim().toLowerCase().replace(/-next-[a-f0-9]{8}$/u, "") || "wenmai").slice(0, 18).replace(/[._-]+$/u, "") || "wenmai";
    setClientLabel(`${client.label}（换发）`);
    setClientKind(client.clientKind);
    setClientPreset(replacementPreset);
    if (replacementPreset === "local-operator") setClientTransport("local");
    if (replacementPreset !== "local-operator") setPrivilegedArticleScope(client.articleIds.includes("*") ? "all_articles" : "selected_articles");
    if (replacementPreset === "permission-catalog") {
      const metadata = client.permissionProfile;
      if (!metadata?.catalogVersion || !metadata.actionIds) {
        setError("这是旧版权限档案，缺少精确 action 快照；不能静默换发，请在目录中重新选择权限。");
        applyPrivilegedScopes([]);
        setSelectedPrivilegedArticleIds([]);
        setSelectedPermissionPresetId("custom");
        setCatalogConfirmedVersion("");
        setCatalogConfirmedSha256("");
      } else {
        applyPrivilegedScopes([...client.scopes]);
        setSelectedPrivilegedArticleIds(client.articleIds.filter((id) => id !== "*"));
        if (!client.articleIds.includes("*")) void loadPermissionCatalog(true);
        setSelectedPermissionPresetId(metadata.presetId ?? "custom");
        setCatalogConfirmedVersion("");
        setCatalogConfirmedSha256("");
      }
    }
    setClientArticleId(client.articleIds[0] ?? selectedArticle.id);
    setClientTaskId(client.taskIds[0] ?? "");
    setClientPackageMode(client.scopes.includes("package.patch.propose") ? "read-patch" : client.scopes.includes("package.read") ? "read" : "none");
    setClientLifetimeDays(client.collaborationAccessMode === "editor" || existingRoleId === "local-registrar" ? 1 : client.collaborationAccessMode === "viewer" || existingRoleId === "content-steward" || existingRoleId === "article-worker" ? 7 : client.role === "super_admin" ? 7 : 30);
    setClientProfileName(`${replacementProfileBase}-next-${crypto.randomUUID().slice(0, 8)}`);
    clientInitialFocusRef.current?.focus();
    notify("已带入旧客户端边界；先签发并验证新 token，再撤销旧 token");
  }, [applyPrivilegedScopes, clientProfileName, issuedClient, loadPermissionCatalog, notify, selectedArticle.id]);

  const revokeClient = useCallback(async (clientId: string) => {
    setBusy(`revoke:${clientId}`);
    try {
      await post("revoke_client", { clientId, note: "由内容所有者在 Agent 中心撤销" });
      if (issuedClient?.client.id === clientId) {
        setIssuedClient(null);
        setIssuedTokenVisible(false);
      }
      await loadTasks();
      notify("客户端已撤销；旧 token 不能继续领取或写入任务");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "撤销失败");
    } finally {
      setBusy("");
    }
  }, [issuedClient, loadTasks, notify, post]);

  const cancelTask = useCallback(async (task: AgentTask) => {
    setBusy(`cancel:${task.id}`);
    try {
      await post("cancel_task", { taskId: task.id, expectedLockVersion: task.lockVersion, note: decisionNote || "由内容所有者取消" });
      await loadTasks();
      await loadDetail(task.id);
      notify("任务已取消；后续 Agent 写回将被拒绝");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "取消任务失败");
    } finally {
      setBusy("");
    }
  }, [decisionNote, loadDetail, loadTasks, notify, post]);

  const decideApproval = useCallback(async (approval: AgentApproval, decision: "approved" | "rejected") => {
    if (!decisionNote.trim()) return;
    setBusy(`approval:${approval.id}`);
    try {
      await post("decide_approval", { approvalRequestId: approval.id, decision, expectedLockVersion: approval.lockVersion, note: decisionNote });
      await loadDetail(approval.taskId);
      await loadTasks(true);
      setDecisionNote("");
      notify(decision === "approved" ? "已批准这项 Agent 请求；不等于文章或发行批准" : "已拒绝这项 Agent 请求");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "审批失败");
    } finally {
      setBusy("");
    }
  }, [decisionNote, loadDetail, loadTasks, notify, post]);

  const decideGraph = useCallback(async (proposal: GraphProposal, decision: "confirmed" | "rejected") => {
    if (!decisionNote.trim()) return;
    setBusy(`graph:${proposal.id}`);
    try {
      await post("decide_graph_proposal", { graphProposalId: proposal.id, decision, expectedLockVersion: proposal.lockVersion, note: decisionNote });
      await loadDetail(proposal.taskId);
      setDecisionNote("");
      notify(decision === "confirmed" ? "已接受为待再生成候选；canonical 图谱尚未改变" : "图谱提案已拒绝");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "图谱决定保存失败");
    } finally {
      setBusy("");
    }
  }, [decisionNote, loadDetail, notify, post]);

  const selectedTask = tasks.find((task) => task.id === selectedTaskId) ?? tasks[0];
  const articleById = useMemo(() => new Map(articles.map((article) => [article.id, article])), [articles]);
  const pendingApprovals = detail?.approvalRequests.filter((item) => item.status === "pending") ?? [];
  const pendingGraph = detail?.graphProposals.filter((item) => item.status === "candidate") ?? [];
  const packagePatchProposals = detail?.packagePatchProposals ?? [];
  const activeClients = clients.filter((client) => client.effectiveStatus === "active");
  const currentContext = detail?.contextSnapshots.find((context) => context.id === selectedTask?.currentContextSnapshotId)
    ?? detail?.contextSnapshots[0];
  const currentPackageBaseline = recordValue(currentContext?.packageBaseline);
  const currentGuidanceChecklist = recordValue(currentContext?.guidanceChecklist);
  const currentGuidanceSummary = recordValue(currentGuidanceChecklist?.summary);
  const currentGuidanceNextAction = recordValue(currentGuidanceChecklist?.nextAction);
  const latestDetailEvent = detail?.events[0];
  const effectivePermissions = Array.isArray(selectedTask?.permissionCeiling.allow)
    ? selectedTask.permissionCeiling.allow
    : Array.isArray(selectedTask?.permissionCeiling.scopes)
      ? selectedTask.permissionCeiling.scopes
      : [];
  const tailscaleHost = clientTailscaleHost.trim().toLowerCase();
  const profileName = clientProfileName.trim().toLowerCase();
  const profileNameValid = WENMAI_PROFILE_NAME_PATTERN.test(profileName);
  const tailscaleHostValid = TAILSCALE_HOST_PATTERN.test(tailscaleHost);
  const collaborationMode = collaborationModeForPreset(clientPreset);
  const collaborationShare = collaborationMode !== null;
  const privilegedPreset = clientPreset === "permission-catalog";
  const selectedRoleId = portableRoleIdForPreset(clientPreset);
  const selectedRoleProfile = selectedRoleId ? PORTABLE_AGENT_ROLE_PROFILES[selectedRoleId] : null;
  const portableFilePreset = collaborationShare || selectedRoleId !== null;
  const issuancePrivilegedScopes = selectedRoleId === "content-steward" ? STEWARD_SCOPES : selectedPrivilegedScopes;
  const privilegedIssuance = privilegedPreset || selectedRoleId === "content-steward";
  const issuablePermissions = catalogPermissions(permissionCatalog).filter(canIssuePermission);
  const selectedPermissions = issuablePermissions.filter((item) => issuancePrivilegedScopes.includes(item.scope));
  const siteFullControlSelected = privilegedPreset && selectedPrivilegedScopes.length === 1 && selectedPrivilegedScopes[0] === "site.full_control";
  const selectedPrivilegedScopesAreIssuable = issuancePrivilegedScopes.length > 0 && selectedPermissions.length === issuancePrivilegedScopes.length;
  const selectedScopeCombination = validatePermissionScopeCombination(issuancePrivilegedScopes);
  const permissionArticleObjects = catalogArticleObjects(permissionCatalog);
  const permissionArticleIds = new Set(permissionArticleObjects.map((article) => article.id));
  const selectedPrivilegedArticlesAreCurrent = privilegedArticleScope === "all_articles" || (selectedPrivilegedArticleIds.length > 0 && selectedPrivilegedArticleIds.length <= MAX_PRIVILEGED_ARTICLE_IDS && selectedPrivilegedArticleIds.every((id) => id !== "*" && permissionArticleIds.has(id)));
  const derivedRole = derivedPermissionRole(permissionCatalog, issuancePrivilegedScopes);
  const requiresLocalTransport = selectedRoleProfile?.localOnly === true || selectedPermissions.some((item) => item.localOnly || item.transport === "local" || item.transport === "local_only");
  const selectedActionIds = selectedPermissions.flatMap((item) => item.actions.map((action) => action.actionId));
  const maxClientLifetimeDays = collaborationShare
    ? COLLABORATION_ACCESS_MAX_LIFETIME_DAYS
    : selectedRoleProfile?.maxLifetimeDays ?? maxClientLifetimeForRole(privilegedPreset, derivedRole);
  const clientLifetimeValid = Number.isInteger(clientLifetimeDays) && clientLifetimeDays >= 1 && clientLifetimeDays <= maxClientLifetimeDays;
  const privilegedCatalogConfirmed = Boolean(permissionCatalog?.catalogSha256)
    && permissionCatalog?.catalogVersion === catalogConfirmedVersion
    && permissionCatalog?.catalogSha256 === catalogConfirmedSha256;
  const collaborationTaskValid = collaborationMode !== "editor" || shareableTasks.some((task) => task.id === clientTaskId);
  const clientIssueDisabled = issuedClient !== null || !clientLabel.trim() || (!portableFilePreset && !profileNameValid) || !clientLifetimeValid
    || (!selectedRoleId && clientPreset !== "local-operator" && privilegedArticleScope === "selected_articles" && !clientArticleId)
    || (collaborationShare && (!clientArticleId || !collaborationTaskValid))
    || (clientTransport === "tailscale" && !tailscaleHostValid)
    || (requiresLocalTransport && clientTransport !== "local")
    || (privilegedIssuance && (!permissionCatalog || !selectedPrivilegedScopesAreIssuable || !selectedScopeCombination.valid
      || (privilegedPreset && (!privilegedCatalogConfirmed || !selectedPrivilegedArticlesAreCurrent))))
    || busy !== "";
  const issueClientButtonLabel = collaborationMode === "viewer"
    ? `生成 ${clientLifetimeDays} 天只读通行证`
    : collaborationMode === "editor"
      ? `生成 ${clientLifetimeDays} 天任务协作通行证`
      : selectedRoleId === "content-steward"
        ? `生成 ${clientLifetimeDays} 天文脉管家钥匙`
        : selectedRoleId === "article-worker"
          ? `生成 ${clientLifetimeDays} 天文章工作员钥匙`
          : selectedRoleId === "local-registrar"
            ? "生成 1 天本机建档钥匙"
      : siteFullControlSelected
        ? `手工签发 ${clientLifetimeDays} 天 Agent 站内全权 Key`
        : `签发 ${clientLifetimeDays} 天直接 Agent Key`;
  const visiblePermissionPresets = permissionCatalog?.presets.filter((preset) => presetIdOf(preset) !== "all_delegable_internal") ?? [];
  const profileScriptRoot = ".\\scripts";
  const profileSaveScript = `${profileScriptRoot}\\save-wenmai-agent-profile.ps1`;
  const profileInvokeScript = `${profileScriptRoot}\\invoke-wenmai-agent-profile.ps1`;
  const profileImportScript = `${profileScriptRoot}\\import-wenmai-local.ps1`;
  const profileTransportArgs = clientTransport === "tailscale"
    ? `-Transport tailscale -TailscaleHost '${tailscaleHost}'`
    : "-Transport local";
  const saveProfileCommand = issuedClient ? `& '${profileSaveScript}' -ProfileName '${profileName}' ${profileTransportArgs} -ClientId '${issuedClient.client.id}' -ExpiresAt '${issuedClient.client.expiresAt}'` : "";
  const statusCommand = issuedClient ? `& '${profileInvokeScript}' -ProfileName '${profileName}' -Mode ${clientPreset === "local-operator" ? "LocalImportStatus" : "Status"}` : "";
  const bridgeCommand = issuedClient ? privilegedPreset
    ? `& '${profileInvokeScript}' -ProfileName '${profileName}' -Mode ${derivedRole === "super_admin" ? "SuperAdminAction" : "AdminAction"} -Action '<目录已勾选 action>' -CommandId '<stable-command-id>' -PayloadJson '<bounded-json-object>'`
    : `& '${profileInvokeScript}' -ProfileName '${profileName}' -Mode Worker` : "";
  const profileImportCommand = issuedClient && clientPreset === "local-operator" ? `& '${profileImportScript}' -ProfileName '${profileName}' -SourcePath 'C:\\path\\article.md' -Title '文章标题' -ReceiptPath 'C:\\path\\wenmai-import-receipt.json'` : "";
  const mcpConfig = issuedClient ? JSON.stringify({
    mcpServers: {
      wenmai: {
        command: WINDOWS_POWERSHELL,
        cwd: WENMAI_PROJECT_ROOT_PLACEHOLDER,
        args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", profileInvokeScript, "-ProfileName", profileName, "-Mode", "Mcp"],
      },
    },
  }, null, 2) : "";
  const collaborationOrigin = issuedClient?.origin ?? (clientTransport === "tailscale" ? `https://${tailscaleHost}` : "http://[::1]:3000");
  const issuedCollaborationMode = issuedClient?.client.collaborationAccessMode ?? null;
  const collaborationAccessCard = issuedClient && issuedCollaborationMode ? buildCollaborationAccessCard({
    origin: collaborationOrigin,
    label: issuedClient.client.label,
    clientId: issuedClient.client.id,
    clientKind: issuedClient.client.clientKind,
    mode: issuedCollaborationMode,
    article: {
      id: issuedClient.client.articleIds[0],
      label: articleById.get(issuedClient.client.articleIds[0])?.title ?? issuedClient.client.articleIds[0],
    },
    taskId: issuedClient.client.taskIds[0] ?? null,
    expiresAt: issuedClient.client.expiresAt,
  }) : null;
  const collaborationAccessCardJson = collaborationAccessCard ? JSON.stringify(collaborationAccessCard, null, 2) : "";
  const portableCollaborationAccessFile = issuedClient && collaborationAccessCard ? buildPortableCollaborationAccessFile({
    connectionCard: collaborationAccessCard,
    token: issuedClient.token,
    exportedAt: issuedClient.exportedAt,
  }) : null;
  const portableCollaborationAccessFileJson = portableCollaborationAccessFile ? JSON.stringify(portableCollaborationAccessFile, null, 2) : "";
  const issuedRoleId = issuedClient?.roleId ?? null;
  const roleConnectionCard = issuedClient && issuedRoleId ? buildAgentRoleConnectionCard({
    roleId: issuedRoleId,
    origin: issuedClient.origin,
    label: issuedClient.client.label,
    clientId: issuedClient.client.id,
    clientKind: issuedClient.client.clientKind,
    serverRole: issuedClient.client.role,
    permissionPresetId: issuedClient.client.permissionProfile?.presetId ?? null,
    scopes: issuedClient.client.scopes,
    actionIds: issuedClient.client.permissionProfile?.actionIds ?? [],
    articleIds: issuedClient.client.articleIds,
    taskIds: issuedClient.client.taskIds,
    expiresAt: issuedClient.client.expiresAt,
  }) : null;
  const portableRoleAccessFile = issuedClient && roleConnectionCard ? buildPortableAgentRoleAccessFile({
    connectionCard: roleConnectionCard,
    token: issuedClient.token,
    exportedAt: issuedClient.exportedAt,
  }) : null;
  const portableRoleAccessFileJson = portableRoleAccessFile ? JSON.stringify(portableRoleAccessFile, null, 2) : "";
  const portableAccessFileJson = portableCollaborationAccessFileJson || portableRoleAccessFileJson;
  const portableAccessCardJson = collaborationAccessCardJson || (roleConnectionCard ? JSON.stringify(roleConnectionCard, null, 2) : "");
  const portableAccessFileName = issuedClient
    ? `wenmai-${issuedCollaborationMode ?? issuedRoleId ?? "access"}-${issuedClient.client.id.slice(-12)}.wenmai-agent.json`
    : "wenmai-access.wenmai-agent.json";
  const portableStatusCommand = issuedClient && (issuedCollaborationMode || issuedRoleId)
    ? `python -B scripts/wenmai_agent_client.py --access-file '.\\${portableAccessFileName}' status`
    : "";
  const portableMcpCommand = issuedClient && (issuedCollaborationMode || (issuedRoleId && issuedRoleId !== "local-registrar"))
    ? `python -B scripts/wenmai_mcp_server.py --access-file '.\\${portableAccessFileName}'`
    : "";
  const importCommand = issuedClient && issuedRoleId === "local-registrar"
    ? `& '${profileImportScript}' -AccessFile '.\\${portableAccessFileName}' -SourcePath 'C:\\path\\article.md' -Title '文章标题' -ReceiptPath 'C:\\path\\wenmai-import-receipt.json'`
    : profileImportCommand;
  const issuedPortableFile = Boolean(issuedCollaborationMode || issuedRoleId);
  const downloadPortableAccessFile = () => {
    if (!portableAccessFileJson || !issuedClient) return;
    const blob = new Blob([`${portableAccessFileJson}\n`], { type: "application/vnd.wenmai.agent-access+json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    try {
      anchor.href = url;
      anchor.download = portableAccessFileName;
      anchor.rel = "noopener";
      document.body.appendChild(anchor);
      anchor.click();
      setIssuedTokenVisible(false);
      setClientCopyFallback(null);
      notify("连接钥匙文件已生成；文件本身就是凭据，请像 SSH 私钥一样交付和保管");
    } finally {
      anchor.remove();
      URL.revokeObjectURL(url);
    }
  };
  const changeClientPreset = (next: AgentClientPreset) => {
    setClientPreset(next);
    if (next === "role-steward" || next === "role-worker") {
      setPrivilegedArticleScope("all_articles");
      setClientArticleId("*");
      setClientTaskId("");
      setClientLifetimeDays(7);
      return;
    }
    if (next === "share-viewer" || next === "share-editor") {
      const targetArticleId = clientArticleId === "*" ? selectedArticle.id : clientArticleId;
      setPrivilegedArticleScope("selected_articles");
      setClientArticleId(targetArticleId);
      setClientLifetimeDays(next === "share-editor" ? 1 : 7);
      setClientTaskId(next === "share-editor" ? tasks.find((task) => task.articleId === targetArticleId && agentBranchTaskIsShareable(task, branches))?.id ?? "" : "");
      return;
    }
    if (next === "permission-catalog") {
      setClientLifetimeDays((current) => normalizeClientLifetimeDays(current, maxClientLifetimeForRole(true, derivedPermissionRole(permissionCatalog, selectedPrivilegedScopes))));
      void loadPermissionCatalog(privilegedArticleScope === "selected_articles");
    }
    if (next === "local-operator") {
      setClientTransport("local");
      setClientArticleId("*");
      setPrivilegedArticleScope("all_articles");
      setClientLifetimeDays(1);
    } else if (clientArticleId === "*") {
      setClientArticleId(selectedArticle.id);
    }
  };

  if (agentSurface === "improvement") {
    return <div className="view-page agent-console meta-improvement-surface">
      <header className="page-heading"><div><span className="eyebrow">Agent 中心 · 元改进层</span><h1 ref={improvementSurfaceHeadingRef} tabIndex={-1}>把改进方法作为可版本化、可对照、可回滚的实验对象</h1><p>模型只能提交候选和独立评议；冻结用例、确定性信号、独立互审、人工决定与活动版本指针共同决定是否采纳候选。</p></div><div className="agent-header-actions"><button type="button" onClick={() => setAgentSurface("tasks")}>返回任务控制面</button></div></header>
      <MetaImprovementLab articleId={selectedArticle.id} notify={notify} />
    </div>;
  }

  return <div className="view-page agent-console">
    <header className="page-heading"><div><span className="eyebrow">Agent（智能体）中心</span><h1 ref={taskSurfaceHeadingRef} tabIndex={-1}>创建可验收的 Agent（智能体）任务，不必每次重写长提示</h1><p>先冻结目标、验收、正文、语料身份、限界子图、已采纳规则和权限，再让智能体返回阶段、当前动作、下一步、阻塞、候选工件或人工决定请求。创建任务不等于公开发布。</p></div><div className="agent-header-actions"><button type="button" onClick={() => setAgentSurface("improvement")}>元改进实验</button><button onClick={openClientPanel}>权限与钥匙 · {activeClients.length}</button><button className="primary-button" onClick={openComposer}>＋ 创建 Agent 任务</button></div></header>
    {error && <div className="operation-error" role="alert"><span>{error}</span><button onClick={() => setError("")}>关闭</button></div>}
    <section className="agent-health-strip"><article><span>控制平面</span><strong>{state === "ready" ? "可用" : state === "loading" ? "连接中" : "异常"}</strong><small>任务和事件持久化到本地 D1 数据库</small></article><article><span>有效 Key</span><strong>{activeClients.length}</strong><small>{activeClients.filter((client) => client.lastSeenAt).length} 个曾经连通；不等于执行器在线</small></article><article><span>执行中</span><strong>{tasks.filter((task) => ["claimed", "running"].includes(task.state)).length}</strong><small>{tasks.filter((task) => task.state === "blocked").length} 个阻塞</small></article><article><span>需要我</span><strong>{tasks.filter((task) => ["awaiting_human", "review"].includes(task.state)).length}</strong><small>Agent 不能替你批准自己</small></article></section>

    <div className="agent-control-layout"><main className="agent-board">{BOARD_COLUMNS.map((column) => {
      const columnTasks = tasks.filter((task) => column.states.includes(task.state));
      return <section key={column.id} className={`agent-board-column ${column.id}`}><header><strong>{column.label}</strong><span>{columnTasks.length}</span></header><div>{columnTasks.map((task) => {
        const latest = task.latestEvent;
        const taskArticle = articleById.get(task.articleId);
        return <article key={task.id} className={`agent-task-card ${task.id === selectedTask?.id ? "active" : ""}`}><button className="agent-task-select" onClick={() => setSelectedTaskId(task.id)}><div className="agent-task-meta"><span>{task.priority}</span><em>{STATE_LABELS[task.state]}</em></div><strong>{task.title}</strong><p>{task.objective}</p><div className="agent-progress"><i style={{ width: `${latest?.progressPercent ?? (task.state === "succeeded" ? 100 : 0)}%` }} /></div>{latest && <div className="agent-latest"><span>{latest.currentAction || latest.message || "已更新状态"}</span><time>{timeLabel(latest.createdAt)}</time></div>}{task.state === "blocked" && <mark>{latest?.blocker || "等待处理阻塞"}</mark>}</button><ArticleQuickLink articleId={task.articleId} className="agent-task-preview">预览：{taskArticle?.title ?? task.articleId}</ArticleQuickLink></article>;
      })}{!columnTasks.length && <div className="agent-column-empty">没有任务</div>}</div></section>;
    })}</main>

    <aside className="agent-inspector">{selectedTask && detail ? <><header><div><span className="eyebrow">{STATE_LABELS[selectedTask.state]} · {selectedTask.priority}</span><h2>{selectedTask.title}</h2></div><div className="agent-article-actions"><ArticleQuickLink articleId={selectedTask.articleId}>预览文章</ArticleQuickLink><button onClick={() => onOpenArticle(selectedTask.articleId)}>进入工位</button></div></header><p className="agent-objective">{selectedTask.objective}</p><dl className="agent-task-facts"><div><dt>文章</dt><dd><ArticleQuickLink articleId={selectedTask.articleId}>{articleById.get(selectedTask.articleId)?.title ?? selectedTask.articleId}</ArticleQuickLink></dd></div><div><dt>上下文</dt><dd>{short(currentContext?.contextSha256 ?? "")}</dd></div>{currentPackageBaseline && <div><dt>目标模块</dt><dd><code>{String(currentPackageBaseline.targetModuleKey ?? "未绑定")}</code></dd></div>}<div><dt>权限</dt><dd>{effectivePermissions.length} 项</dd></div><div><dt>最近更新</dt><dd>{timeLabel(selectedTask.updatedAt)}</dd></div></dl>
      {currentGuidanceChecklist && <section className={`agent-guidance-summary ${String(currentGuidanceChecklist.archiveState ?? "unknown")}`}><span className="eyebrow">冻结指导检查表 · {short(String(currentGuidanceChecklist.checklistSha256 ?? ""))}</span><strong>{currentGuidanceChecklist.archiveReady === true ? "轻建档已读回" : "建档仍有缺口"}</strong><p>{String(currentGuidanceNextAction?.instruction ?? "没有可读的下一步，停止并交给协调者。")}</p><small>{Number(currentGuidanceSummary?.passed ?? 0)} 通过 · {Number(currentGuidanceSummary?.pending ?? 0)} 待补 · {Number(currentGuidanceSummary?.humanRequired ?? 0)} 待人工；Agent 只能提交 candidate Patch。</small></section>}
      {(pendingApprovals.length > 0 || pendingGraph.length > 0) && <section className="human-decision-box"><span className="eyebrow">需要我决定</span><label>决定说明<input value={decisionNote} onChange={(event) => setDecisionNote(event.target.value)} placeholder="写清理由，决定才可提交" /></label>{pendingApprovals.map((approval) => <article key={approval.id}><strong>{approval.title || approval.kind}</strong><p>{approval.question}</p><small>Agent 提供的选项：{approval.options.join(" / ") || "无"}</small><div><button disabled={!decisionNote.trim() || busy !== ""} onClick={() => void decideApproval(approval, "rejected")}>拒绝</button><button className="primary-button" disabled={!decisionNote.trim() || busy !== ""} onClick={() => void decideApproval(approval, "approved")}>批准请求</button></div></article>)}{pendingGraph.map((proposal) => <article key={proposal.id}><strong>图谱提案 · {proposal.relationType || proposal.proposalKind}</strong><p>{proposal.sourceId ?? "新节点"} → {proposal.targetId ?? proposal.label}</p><small>{proposal.label || proposal.evidence.join("；")}</small><div><button disabled={!decisionNote.trim() || busy !== ""} onClick={() => void decideGraph(proposal, "rejected")}>拒绝关系</button><button className="primary-button" disabled={!decisionNote.trim() || busy !== ""} onClick={() => void decideGraph(proposal, "confirmed")}>接受为待再生成候选</button></div></article>)}</section>}
      <section className="agent-live-state"><span className="eyebrow">实时进度</span>{latestDetailEvent ? <><div className="agent-progress large"><i style={{ width: `${latestDetailEvent.progressPercent ?? 0}%` }} /></div><strong>{latestDetailEvent.progressPercent ?? 0}% · {latestDetailEvent.phase || "未命名阶段"}</strong><dl><div><dt>正在做</dt><dd>{latestDetailEvent.currentAction || "未报告"}</dd></div><div><dt>下一步</dt><dd>{latestDetailEvent.nextAction || "未报告"}</dd></div><div><dt>阻塞</dt><dd>{latestDetailEvent.blocker || "无"}</dd></div></dl></> : <p>Agent 尚未写入进度事件。</p>}</section>
      <details open className="agent-timeline"><summary>事件时间线 <span>{detail.events.length}</span></summary><div>{detail.events.slice(0, 60).reverse().map((event) => <article key={event.id}><i /><div><strong>{event.eventType} · {event.phase || "未分阶段"}</strong><p>{event.message || event.currentAction || "状态已更新"}</p>{event.nextAction && <small>下一步：{event.nextAction}</small>}{event.blocker && <mark>{event.blocker}</mark>}</div><time>{event.progressPercent ?? "—"}%<br />{timeLabel(event.createdAt)}</time></article>)}</div></details>
      <details className="agent-artifacts"><summary>工件与证据 <span>{detail.artifacts.length}</span></summary><div>{detail.artifacts.map((artifact) => <article key={artifact.id}><span>{artifact.kind}</span><strong>{artifact.title}</strong><code>{artifact.contentRef}</code><small>{artifact.mediaType} · {artifact.sizeBytes.toLocaleString("zh-CN")} B · {short(artifact.sha256)}</small><button onClick={() => void navigator.clipboard.writeText(JSON.stringify(artifact.payload, null, 2))}>复制工件元数据</button></article>)}{!detail.artifacts.length && <p>还没有工件。</p>}</div></details>
      <details className="agent-artifacts"><summary>Package Patch 候选 <span>{packagePatchProposals.length}</span></summary><div>{packagePatchProposals.map((patch) => <article key={patch.id}><span>{patch.status}</span><strong>{patch.title}</strong><code>{patch.id}</code><small>{patch.operations.length} 个操作 · {short(patch.patchSha256)} · {timeLabel(patch.createdAt)}</small>{patch.summary && <p>{patch.summary}</p>}<button onClick={() => void navigator.clipboard.writeText(JSON.stringify({ id: patch.id, packageId: patch.packageId, branchId: patch.branchId, baseRevisionId: patch.baseRevisionId, contextSha256: patch.contextSha256, patchSha256: patch.patchSha256, status: patch.status, operationCount: patch.operations.length, evidence: patch.evidence, diagnosticIssueIds: patch.diagnosticIssueIds }, null, 2))}>复制候选回执</button></article>)}{!packagePatchProposals.length && <p>这项任务还没有提交候选 Package Patch。</p>}</div></details>
      <details className="agent-context"><summary>冻结上下文与权限</summary><div>{detail.contextSnapshots.slice(0, 3).map((context) => <article key={context.id}><strong>{short(context.contextSha256)}{context.id === currentContext?.id ? " · 当前" : ""}</strong><p>正文 {short(context.bodySha256)} · 修订 {short(context.revisionId ?? "")}</p><small>Corpus {context.corpusSchemaVersion} / {context.corpusAlgorithmVersion}<br />{timeLabel(context.createdAt)}</small></article>)}<pre>{JSON.stringify(selectedTask.permissionCeiling, null, 2)}</pre></div></details>
      {!(["succeeded", "failed", "cancelled"].includes(selectedTask.state)) && <div className="agent-danger-zone"><label>取消原因<input value={decisionNote} onChange={(event) => setDecisionNote(event.target.value)} /></label><button disabled={busy !== ""} onClick={() => void cancelTask(selectedTask)}>取消任务并拒绝后续写回</button></div>}
    </> : <div className="agent-inspector-empty"><strong>{tasks.length ? "正在读取任务详情" : "还没有 Agent 任务"}</strong><p>{tasks.length ? "任务事件会自动刷新。" : "创建任务后，系统会把文章、知识图谱、验收和权限冻结成上下文快照；兼容的 Agent 执行器领取后，只能返回候选和回执，不能代替人工批准、合并或公开发布。"}</p>{!tasks.length && <button className="primary-button" onClick={openComposer}>创建第一项任务</button>}</div>}</aside></div>

    {composerOpen && <dialog ref={composerDialogRef} className="agent-modal" aria-labelledby="agent-task-title" onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); setComposerOpen(false); } }} onCancel={(event) => { event.preventDefault(); setComposerOpen(false); }}>
      <header><div><span className="eyebrow">创建 Agent 任务</span><h2 id="agent-task-title">先把意图写成可验收合同</h2></div><button aria-label="关闭" onClick={() => setComposerOpen(false)}>×</button></header>
      <div className="agent-task-form">
        <label>绑定资料对象<select value={taskArticleId} onChange={(event) => { setTaskArticleId(event.target.value); setTaskBranchId(""); setTaskTargetModuleKey(""); }}>{taskTargets.map((article) => <option key={article.id} value={article.id}>{article.title} · {article.classification.class}</option>)}</select></label>
        <div className="agent-baseline-preview"><span>当前选择</span><ArticleQuickLink articleId={taskArticleId}>预览全文与版本</ArticleQuickLink></div>
        <label>分支基线<select value={taskBranchId} onChange={(event) => { setTaskBranchId(event.target.value); setTaskTargetModuleKey(""); }}><option value="">使用代表源版本</option>{branches.filter((branch) => branch.articleId === taskArticleId).map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}</select></label>
        <label>优先级<select value={taskPriority} onChange={(event) => setTaskPriority(event.target.value as typeof taskPriority)}><option>P0</option><option>P1</option><option>P2</option><option>P3</option></select></label>
        <label>写入上限<select value={taskWriteScope} onChange={(event) => { const nextScope = event.target.value as typeof taskWriteScope; setTaskWriteScope(nextScope); setTaskTargetModuleKey(""); if (nextScope === "agent-branch" && !branchWritableArticles.some((article) => article.id === taskArticleId)) { setTaskArticleId(branchWritableArticles[0]?.id ?? ""); setTaskBranchId(""); } }}><option value="artifact-only">只交独立工件</option><option value="package-patch">按模块提交 Package Patch 候选</option><option value="agent-branch">建立并只写 Agent 专属分支</option><option value="graph-proposal">只提交图谱候选</option></select></label>
        <p className="wide agent-form-boundary">{taskWriteScope === "package-patch" ? "必须选择已接入的 ArticleBranch。系统会冻结 Package、Revision、Composition、模块图、诊断与指导清单；Agent 一次只处理一个 moduleKey，只能提交 candidate Patch。清单阻断或待人工时必须停下请求人处理。" : taskWriteScope === "agent-branch" ? "系统只列出正式文章、平台成品、导入稿和创作草稿；Agent 会从所选基线建立 agent/<task> 专属分支，只能追加候选修订，不能写 main 或自行合并。" : taskWriteScope === "graph-proposal" ? "可选择文章、来源、研究或能力资料；图谱写回只形成候选覆盖层，接受后仍需重新生成与校验 canonical 图谱。" : "可选择资料库中的任意对象作为上下文；Agent 只能交结构化工件，不会修改正文或图谱。"}</p>
        {taskWriteScope === "package-patch" && <label className="wide">目标 moduleKey<input value={taskTargetModuleKey} onChange={(event) => setTaskTargetModuleKey(event.target.value)} placeholder="从文章工程节点复制精确 moduleKey" spellCheck={false} /><small>服务端会确认该模块属于冻结 Composition；Patch 不能整篇替换，也不能修改其他模块。</small></label>}
        <label className="wide">文章编辑模式<select value={taskEditorialMode} onChange={(event) => setTaskEditorialMode(event.target.value as typeof taskEditorialMode)}><option value="not_applicable">非文章任务</option><option value="research_survey">调研盘点</option><option value="mechanism_explanation">机制解释</option><option value="case_analysis">案例分析</option><option value="how_to">行动教程</option></select></label>
        {taskEditorialMode !== "not_applicable" && <>
          <label>问题所有权<select value={taskOwnerContract} onChange={(event) => setTaskOwnerContract(event.target.value as typeof taskOwnerContract)}><option value="public_explanation">公共解释</option><option value="experience_method">经历方法</option></select></label>
          <label>表达立场<select value={taskStance} onChange={(event) => setTaskStance(event.target.value as typeof taskStance)}><option value="neutral">中性</option><option value="exploratory">探索</option><option value="critical">批判</option><option value="advocacy">倡议</option></select></label>
          <label className="wide">标题任务<input value={taskTitleJob} onChange={(event) => setTaskTitleJob(event.target.value)} placeholder="对象、范围与读者点开后得到什么" /></label>
          <label className="wide">首屏任务<input value={taskOpeningJob} onChange={(event) => setTaskOpeningJob(event.target.value)} placeholder="前约 350 字必须交付的口径、进展、边界或困境" /></label>
          <label className="wide">质疑 / 反差依据<input value={taskTensionBasis} onChange={(event) => setTaskTensionBasis(event.target.value)} placeholder="没有真实依据时留空；不能为了点击力虚构对立" /></label>
        </>}
        <label className="wide">任务标题<input ref={composerInitialFocusRef} value={taskTitle} onChange={(event) => setTaskTitle(event.target.value)} placeholder="例如：为这篇文章补一份证据缺口报告" /></label>
        <label className="wide">目标 / 完成后发生什么<textarea value={taskObjective} onChange={(event) => setTaskObjective(event.target.value)} placeholder="用结果描述，不要只写‘研究一下’。" /></label>
        <label className="wide">补充说明<textarea value={taskInstructions} onChange={(event) => setTaskInstructions(event.target.value)} placeholder="范围、非目标、偏好、已知限制；常规知识由上下文 API 提供。" /></label>
        <label className="wide">验收条件（每行一条）<textarea value={taskAcceptance} onChange={(event) => setTaskAcceptance(event.target.value)} placeholder={"所有结论绑定来源\n交付一个结构化工件\n不改 main，不发布"} /></label>
      </div>
      <footer><span>系统会附带当前正文、语料身份、限界子图、已采纳规则与权限；Package Patch 任务还会冻结指导清单和唯一目标模块。创建后只进入 Agent 任务池，不会批准、合并或公开发布内容。</span><button onClick={() => setComposerOpen(false)}>取消</button><button className="primary-button" disabled={!taskTitle.trim() || !taskObjective.trim() || (taskWriteScope === "package-patch" && (!taskBranchId || !taskTargetModuleKey.trim())) || busy !== ""} onClick={() => void createTask()}>{busy === "create-task" ? "正在冻结上下文…" : "创建任务"}</button></footer>
    </dialog>}

    {clientPanelOpen && <dialog ref={clientDialogRef} className="agent-modal agent-client-modal" aria-labelledby="agent-client-title" onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); closeClientPanel(); } }} onCancel={(event) => { event.preventDefault(); closeClientPanel(); }}>
      <header><div><span className="eyebrow">给 Agent 一把文脉钥匙</span><h2 id="agent-client-title">选工作角色，下载一个文件，随时撤销</h2></div><button aria-label="关闭并清除一次性 Key" onClick={closeClientPanel}>×</button></header>
      <nav className="agent-machine-links" aria-label="Agent 机器接口"><a href="/.well-known/wenmai-agent.json" target="_blank" rel="noreferrer">发现文件</a><a href="/agent/manifest.json" target="_blank" rel="noreferrer">能力清单</a><a href="/agent/api/v1.json" target="_blank" rel="noreferrer">API 合同</a><a href="/agent/mcp.json" target="_blank" rel="noreferrer">MCP 配置</a><a href="/agent/prompts/system.md" target="_blank" rel="noreferrer">系统提示</a></nav>
      <section className="agent-auth-separation">
        <strong>默认像连 Wi-Fi：生成一个连接钥匙文件，交给目标 Agent</strong>
        <p>日常入口按职责授权整个文脉，不要求逐篇勾选：文脉管家负责全库盘点与任务编排，文章工作员负责领取任务并提交候选，本机建档员只注册新根文章。连接钥匙文件同时包含地址、权限说明和 Bearer 凭据，拿到副本的人在到期或撤销前拥有同等权限，所以要像 SSH 私钥一样保管。</p>
        <p>文脉源码开发与升级不使用 HTTP Key，而走本机 Git/worktree、测试和代码审查；审批、合并、身份归并、删除与外部发布也不会随角色钥匙放行。</p>
      </section>
      <fieldset className="client-issuer" disabled={issuedClient !== null}>
        <label>名称<input ref={clientInitialFocusRef} value={clientLabel} onChange={(event) => setClientLabel(event.target.value)} /></label>
        <label>类型<select value={clientKind} onChange={(event) => setClientKind(event.target.value as typeof clientKind)}><option value="codex">Codex</option><option value="mcp">MCP Host</option><option value="custom">自定义 Agent</option></select></label>
        <label>工作角色<select value={clientPreset} onChange={(event) => changeClientPreset(event.target.value as AgentClientPreset)}><optgroup label="管理文脉（推荐）"><option value="role-steward">文脉管家 · 全库盘点与任务编排</option><option value="role-worker">文章工作员 · 执行任务并交候选</option><option value="local-operator">本机新文章建档员</option></optgroup><optgroup label="单篇临时共享"><option value="share-viewer">只读一篇文章</option><option value="share-editor">协作一项文章任务</option></optgroup><optgroup label="高级与兼容"><option value="observer">旧版只读观察者</option><option value="worker">旧版普通任务 Worker</option><option value="candidate">旧版候选写入 Agent</option><option value="permission-catalog">高级权限目录 · 自定义</option></optgroup></select></label>
        {!collaborationShare && !selectedRoleId && clientPreset !== "local-operator" && !siteFullControlSelected && <fieldset className="permission-article-scope"><legend>文章范围</legend><label><input type="radio" checked={privilegedArticleScope === "all_articles"} onChange={() => setPrivilegedArticleScope("all_articles")} />全部文章（含以后新增）</label><label><input type="radio" checked={privilegedArticleScope === "selected_articles"} onChange={() => { setPrivilegedArticleScope("selected_articles"); if (privilegedPreset) void loadPermissionCatalog(true); }} />指定文章{privilegedPreset && typeof permissionCatalog?.articleObjectCount === "number" ? `（${permissionCatalog.articleObjectCount}）` : ""}</label></fieldset>}
        {privilegedIssuance && permissionCatalogLoading && <p className="operation-status" role="status">正在加载角色权限目录；钥匙签发暂时禁用。</p>}
        {privilegedIssuance && permissionCatalogError && <p className="operation-error" role="alert">权限目录加载失败：{permissionCatalogError}。文脉管家与高级权限暂时不能签发，文章工作员仍可使用。</p>}
        {privilegedIssuance && permissionCatalogError && <button type="button" onClick={() => void loadPermissionCatalog(privilegedPreset && privilegedArticleScope === "selected_articles")}>重新加载</button>}
        {privilegedPreset && permissionCatalog && <section className="permission-control-panel">
          <header><strong>一把 Key，按你的范围签发</strong><button type="button" onClick={() => void loadPermissionCatalog(privilegedArticleScope === "selected_articles")}>刷新</button></header>
          <p>目录 <code>{permissionCatalog.catalogVersion}</code>。登录、密码、验证码和 2FA 是身份仪式，不是权限选项；最终外部发布仍须消费当前批次的一次性授权。</p>
          {permissionCatalog.humanCeremonies?.length ? <small>{permissionCatalog.humanCeremonies.join("；")}</small> : null}
          <div className="permission-preset-row">{visiblePermissionPresets.map((preset) => {
            const presetPermissions = preset.scopes.map((scope) => catalogPermissions(permissionCatalog).find((item) => item.scope === scope));
            const presetIssuable = presetPermissions.every((permission) => permission !== undefined && canIssuePermission(permission));
            const root = preset.scopes.length === 1 && preset.scopes[0] === "site.full_control";
            return <button type="button" key={presetIdOf(preset)} aria-pressed={selectedPermissionPresetId === presetIdOf(preset)} className={selectedPermissionPresetId === presetIdOf(preset) ? "active" : ""} disabled={!presetIssuable} title={!presetIssuable ? "该预设包含当前不能新签发的权限。" : preset.description} onClick={() => { applyPrivilegedScopes([...preset.scopes]); setSelectedPermissionPresetId(presetIdOf(preset)); if (root) { setPrivilegedArticleScope("all_articles"); setSelectedPrivilegedArticleIds([]); setClientTransport("local"); } }}>{root ? "Agent 站内全权（本机）" : preset.label ?? presetIdOf(preset)}</button>;
          })}<button type="button" onClick={() => { applyPrivilegedScopes([]); setSelectedPermissionPresetId("custom"); }}>全部清除</button></div>
          <p>角色由已选权限自动确定：<strong>{derivedRole === "super_admin" ? "超级管理员" : "管理员"}</strong>。</p>
          {/* 每个权限 checkbox 都嵌在对应的可见 label 内；该规则无法静态推断 map 回调。 */}
          {/* eslint-disable-next-line jsx-a11y/label-has-associated-control */}
          <div className="permission-category-list compact">{Object.entries(issuablePermissions.filter((item) => item.scope !== "site.full_control").reduce<Record<string, AgentPermission[]>>((groups, item) => { const category = item.category ?? "可委派权限"; (groups[category] ??= []).push(item); return groups; }, {})).map(([category, entries]) => <details key={category}><summary>{category}（{entries.length}）</summary><div className="permission-group-actions"><button type="button" disabled={siteFullControlSelected} onClick={() => applyPrivilegedScopes([...new Set([...selectedPrivilegedScopes, ...entries.map((item) => item.scope)])])}>全部选择</button><button type="button" onClick={() => applyPrivilegedScopes(selectedPrivilegedScopes.filter((scope) => !entries.some((item) => item.scope === scope)))}>全部清除</button></div>{entries.map((item) => <label key={item.scope}><input type="checkbox" checked={selectedPrivilegedScopes.includes(item.scope)} disabled={siteFullControlSelected} onChange={() => { const nextScopes = selectedPrivilegedScopes.includes(item.scope) ? selectedPrivilegedScopes.filter((scope) => scope !== item.scope) : [...selectedPrivilegedScopes, item.scope]; applyPrivilegedScopes(nextScopes); setSelectedPermissionPresetId("custom"); }} /><span><strong>{item.label}</strong><small>{item.description ?? item.scope} · {item.actions.length} 个动作</small></span></label>)}</details>)}</div>
          {privilegedArticleScope === "selected_articles" && <div className="permission-article-picker compact"><input aria-label="搜索指定文章" value={privilegedArticleSearch} onChange={(event) => setPrivilegedArticleSearch(event.target.value)} placeholder="搜索文章" /><small>已选 {selectedPrivilegedArticleIds.length}/{MAX_PRIVILEGED_ARTICLE_IDS} 篇</small><div className="permission-article-scroll">{permissionArticleObjects.filter((article) => `${article.label ?? ""} ${article.id}`.toLowerCase().includes(privilegedArticleSearch.toLowerCase())).slice(0, MAX_PRIVILEGED_ARTICLE_IDS).map((article) => <label key={article.id}><input type="checkbox" checked={selectedPrivilegedArticleIds.includes(article.id)} disabled={!selectedPrivilegedArticleIds.includes(article.id) && selectedPrivilegedArticleIds.length >= MAX_PRIVILEGED_ARTICLE_IDS} onChange={() => setSelectedPrivilegedArticleIds((current) => current.includes(article.id) ? current.filter((id) => id !== article.id) : [...current, article.id])} /><span>{article.label ?? article.id}</span></label>)}</div></div>}
          <p className="permission-issue-summary">签发摘要：<strong>{derivedRole}</strong> · {selectedPrivilegedScopes.length} 项权限 · {selectedActionIds.length} 个动作 · {requiresLocalTransport ? "仅本机 [::1]" : "本机或受信 Tailscale"} · {siteFullControlSelected ? "可直接 Agent API · 可选管理会话兑换 · 固定全部文章（含以后新增）、taskIds=[]" : privilegedArticleScope === "all_articles" ? "全部文章（含以后新增）" : `指定 ${selectedPrivilegedArticleIds.length} 篇文章`}</p>
        </section>}
        <label>有效期（天）<input aria-label="Agent token 有效期天数" type="number" min={1} max={maxClientLifetimeDays} step={1} value={clientLifetimeDays} onChange={(event) => setClientLifetimeDays(Number(event.target.value))} /><small>可填写 1–{maxClientLifetimeDays} 天。{selectedRoleProfile ? `${selectedRoleProfile.label}默认按短期角色钥匙使用；到期或撤销后文件立即失效。` : collaborationShare ? "共享默认 7 天；到期或撤销后立即失效。" : privilegedPreset ? (derivedRole === "super_admin" ? "Agent 站内全权最长 7 天，且仅本机。" : "管理员最长 30 天。") : "到期后必须由所有者重新签发。"}</small></label>
        {!portableFilePreset && <label>本机档案名<input aria-label="Windows DPAPI Agent profile 名称" value={clientProfileName} onChange={(event) => setClientProfileName(event.target.value.toLowerCase())} spellCheck={false} /><small>Agent 以后只引用档案名，不把明文 Key 写进命令或配置。</small></label>}
        <label>连接方式<select aria-label="Agent 连接方式" value={clientTransport} disabled={clientPreset === "local-operator" || requiresLocalTransport} onChange={(event) => setClientTransport(event.target.value as typeof clientTransport)}><option value="local">仅这台电脑</option><option value="tailscale">我的跨设备网络（Tailscale）</option></select><small>{requiresLocalTransport ? "所选角色要求精确 [::1] 本机传输。" : portableFilePreset ? "连接方式只改变目标地址，不扩大角色权限；Tailscale 不是公网匿名链接。" : "连接方式不会改变 Key 的 scope。"}</small></label>
        {clientTransport === "tailscale" && <label className="client-boundary">Tailscale 主机名<input aria-label="Tailscale MagicDNS 主机名" placeholder="机器名.tailnet.ts.net" value={clientTailscaleHost} onChange={(event) => setClientTailscaleHost(event.target.value)} spellCheck={false} /><small>文脉只会自动采用当前页面已经使用的 <code>*.ts.net</code> 主机名；本机页面不会猜测或保存旧机器名。只接受精确的 <code>机器名.tailnet.ts.net</code>，不接受 IP、端口或任意 URL；目标设备须已加入同一 tailnet。首次启用需在管理员 PowerShell 运行现有 <code>scripts/enable-wenmai-tailscale-agent.ps1</code>；这不是公网匿名链接。</small></label>}
        {selectedRoleId === "content-steward" ? <p className="client-boundary"><strong>文脉管家：</strong>固定覆盖全部文章（含以后新增），可以盘点知识与工程、创建/更新/取消任务，并通过 MCP 管理工作流；不能直接改 main、接受去重归并、审批、合并、删除或发布。</p> : selectedRoleId === "article-worker" ? <p className="client-boundary"><strong>文章工作员：</strong>固定覆盖全部文章，但只能领取已建立的任务并在任务专属 Agent 分支提交候选正文、工件或 Package Patch；不能自己创建权限、采用候选、合并或发布。</p> : selectedRoleId === "local-registrar" ? <p className="client-boundary"><strong>本机新文章建档员：</strong>固定 <code>article.import.new_root</code>，只可在精确 <code>[::1]</code> 注册新根文章；不能列举或读取既有正文、覆盖或归并既有文章，仅可凭精确文章 ID 与正文 SHA 读回建档状态元数据。</p> : collaborationMode ? <div className="client-boundary"><label>共享文章<select aria-label="共享文章" value={clientArticleId} onChange={(event) => { const articleId = event.target.value; setClientArticleId(articleId); if (collaborationMode === "editor") setClientTaskId(tasks.find((task) => task.articleId === articleId && agentBranchTaskIsShareable(task, branches))?.id ?? ""); }}>{articles.map((article) => <option key={article.id} value={article.id}>{article.title}</option>)}</select></label>{collaborationMode === "editor" && <label>协作任务<select aria-label="共享协作任务" value={clientTaskId} onChange={(event) => setClientTaskId(event.target.value)}><option value="">请选择一项 Agent Branch 任务</option>{shareableTasks.map((task) => <option key={task.id} value={task.id}>{task.title} · {STATE_LABELS[task.state]}</option>)}</select></label>}<small>{collaborationMode === "viewer" ? "只允许读取这一篇文章；本地文章按活动 Package 的当前主分支实时读取，不能领取任务、写入、审批、合并或发布。" : shareableTasks.length ? "只允许在所选任务的 Agent 分支提交候选；不能改 main、合并、审批决定或发布。" : "当前文章没有可共享的有效 Agent Branch 任务。请先创建“建立并只写 Agent 专属分支”的任务；通行证本身不会创建任务或发布内容。"}</small></div> : siteFullControlSelected ? <p className="client-boundary" role="alert"><strong>Agent 站内全权（本机）：</strong>同一 v5 Key 可直接供 Codex、QwenPaw 或 MCP 使用，也可选兑换本机管理会话；固定 <code>site.full_control</code>、全部文章、<code>taskIds=[]</code>、精确 <code>[::1]</code> 且最长 7 天。不含登录、密码、验证码、2FA 或账号切换；不替代当前批次发布能力票据签发/消费或最终公开点击，Agent API 成功不等于公开发布。</p> : privilegedPreset ? <p className="client-boundary">所选权限以目录的 scope + action 快照和文章范围签发。全部文章范围包括以后新增文章；这些直接 Agent Key 不能签发/撤销 Key、登录/2FA、签发发布能力或点击最终发布。</p> : <label className="client-boundary">文章与工程权限边界{privilegedArticleScope === "selected_articles" && <select value={clientArticleId} onChange={(event) => setClientArticleId(event.target.value)}>{articles.map((article) => <option key={article.id} value={article.id}>{article.title}</option>)}</select>}{clientPreset === "candidate" && <select aria-label="文章工程 scope" value={clientPackageMode} onChange={(event) => setClientPackageMode(event.target.value as typeof clientPackageMode)}><option value="read">工程只读（推荐 · package.read）</option><option value="read-patch">工程只读＋Patch 候选</option><option value="none">不访问文章工程</option></select>}<small>普通 Worker 与候选 Agent 不签发 <code>task.complete</code>。</small></label>}
        {privilegedPreset && !selectedScopeCombination.valid && selectedScopeCombination.message && <p className="operation-error" role="alert">权限组合不能签发：{selectedScopeCombination.message}</p>}
        {issuedClient && <p className="client-boundary" role="status">{issuedPortableFile ? "本次连接钥匙已生成；下载单个文件即可交付。" : "本次 Key 已签发，已有一次性 Key 待保存；完成并清除后才能继续签发。"}</p>}
        <button className="primary-button" disabled={clientIssueDisabled} title={clientIssueDisabled && !issuedClient ? "请检查名称、有效期、角色、连接方式与必要的权限目录状态。" : undefined} onClick={() => void issueClient()}>{issuedClient ? (issuedPortableFile ? "连接钥匙待下载" : "已有一次性 Key 待保存") : issueClientButtonLabel}</button>
      </fieldset>
      {issuedClient && <section ref={issuedClientResultRef} className="issued-agent-token" tabIndex={-1} aria-labelledby="issued-agent-token-title" aria-live="polite">
        <strong id="issued-agent-token-title">{issuedPortableFile ? "下载一个连接钥匙文件，目标 Agent 可直接使用" : "一次性 Key 仅在本窗口显示；关闭、Esc 或完成都会立即清除"}</strong>
        <p>{issuedPortableFile ? "文件本身就是权限：不要放进仓库、同步盘、聊天、普通附件或日志。丢失时立即在下面撤销；到期或撤销后，所有文件副本都会失效。高级用法仍可把无秘密连接卡与 Key 分开交付。" : <>先复制“保存到 DPAPI”命令并在 PowerShell 运行；看到隐藏输入提示后，再回到这里复制一次性 Key 并粘贴。命令本身不含秘密。保存后 Agent 只引用档案名 <code>{profileName}</code>。</>}</p>
        {issuedClient.origin.startsWith("https://") && issuedPortableFile && <p>文件只记录 Tailscale 地址，不会自动开启网关；必须先由所有者在文脉主机启用并读回验证 Agent 网关。</p>}
        <div className="issued-token-actions">
          {issuedPortableFile ? <button className="primary-button" onClick={downloadPortableAccessFile}>下载连接钥匙文件</button> : <button onClick={() => void copyClientText(saveProfileCommand, "DPAPI 档案保存命令", "DPAPI 档案保存命令已复制；先运行它，出现隐藏输入后再复制 Key")}>复制保存命令</button>}
          {issuedPortableFile && <button onClick={() => void copyClientText(portableAccessCardJson, "无秘密连接卡", "无秘密连接卡已复制；若采用分开交付，再单独传递 Key")}>复制无秘密接入卡</button>}
          <button onClick={() => void copyIssuedToken()}>{issuedPortableFile ? "高级：复制单独 Key" : "复制一次性 Key"}</button>
          <button onClick={() => setIssuedTokenVisible((visible) => !visible)}>{issuedTokenVisible ? "隐藏一次性 Key" : "手动显示 Key"}</button>
          {issuedPortableFile && <button onClick={() => void copyClientText(portableStatusCommand, "钥匙连通测试命令", "钥匙连通测试命令已复制")}>复制连通测试</button>}
          {!issuedPortableFile && <button onClick={() => void copyClientText(statusCommand, "档案连通测试命令", "档案连通测试命令已复制")}>复制连通测试</button>}
        </div>
        {clientCopyFallback && <label className="issued-token-fallback">复制失败 · {clientCopyFallback.label}<textarea readOnly value={clientCopyFallback.value} spellCheck={false} onFocus={(event) => event.currentTarget.select()} onClick={(event) => event.currentTarget.select()} /></label>}
        {issuedTokenVisible && <label className="issued-token-fallback">一次性 Agent Key<textarea readOnly value={issuedClient.token} spellCheck={false} onFocus={(event) => event.currentTarget.select()} onClick={(event) => event.currentTarget.select()} /></label>}
        <pre>{issuedPortableFile ? portableAccessCardJson : saveProfileCommand}</pre>
        {issuedPortableFile ? <details><summary>目标 Agent 的无秘密启动命令</summary><p>把下载后的文件放在目标 Agent 可读、其他用户不可读的位置；命令只引用文件路径，不展开 Bearer。文脉管家可通过 MCP 使用创建、更新和取消任务工具。</p><pre>{portableStatusCommand}{portableMcpCommand ? `\n${portableMcpCommand}` : ""}</pre><button onClick={() => void copyClientText(portableMcpCommand || portableStatusCommand, portableMcpCommand ? "MCP 启动命令" : "连通测试命令", "无秘密启动命令已复制")}>复制启动命令</button></details> : <details><summary>{privilegedPreset ? "无秘密目录动作桥接模板" : issuedClient.client.clientKind === "mcp" ? "无秘密 MCP Host 配置" : "无秘密 NDJSON 桥接命令"}</summary><p>配置只引用 Windows DPAPI 档案；桥接只接受目录签发快照中的固定动作，写动作必须使用稳定 commandId。不能签发/撤销 Key、签发发布票据、处理登录/2FA 或点击外部发布；消费能力不等于提交成功或公开。</p><pre>{privilegedPreset ? bridgeCommand : issuedClient.client.clientKind === "mcp" ? mcpConfig : bridgeCommand}</pre><button onClick={() => { const isMcp = !privilegedPreset && issuedClient.client.clientKind === "mcp"; void copyClientText(isMcp ? mcpConfig : bridgeCommand, isMcp ? "无秘密 MCP 配置" : privilegedPreset ? "无秘密目录动作桥接模板" : "无秘密桥接命令", isMcp ? "无秘密 MCP 配置已复制" : privilegedPreset ? "无秘密目录动作模板已复制" : "无秘密桥接命令已复制"); }}>{!privilegedPreset && issuedClient.client.clientKind === "mcp" ? "复制 MCP 配置" : privilegedPreset ? "复制目录动作模板" : "复制桥接命令"}</button></details>}
        {importCommand && <details><summary>本机新文章建档命令模板</summary><p>替换本机源文件、标题与回执路径；服务端仍只接收正文和 SHA，不接收本机路径。</p><pre>{importCommand}</pre><button onClick={() => void copyClientText(importCommand, "本机建档命令模板", "本机建档命令模板已复制")}>复制建档模板</button></details>}
      </section>}
      {issuedClient && <p className="client-boundary">一次性 Key 处理完成前，列表中的换发与撤销操作会保持锁定，避免新 Key 永久丢失。</p>}
      <div className="agent-client-list">{clients.map((client) => {
        const localImportAllArticles = client.scopes.includes("article.import.new_root");
        const projection = client.permissionProfile;
        const roleAccessId = roleIdForClient({ role: client.role, scopes: client.scopes, articleIds: client.articleIds, taskIds: client.taskIds, permissionPresetId: projection?.presetId ?? null, actionIds: projection?.actionIds ?? [] });
        const legacyV4 = client.credentialPurpose === "management_session_exchange" || projection?.schemaVersion === 4;
        const siteFullControl = client.credentialPurpose === "site_full_control" || (client.scopes.length === 1 && client.scopes[0] === "site.full_control" && projection?.schemaVersion === 5);
        const shareMode = client.collaborationAccessMode ?? null;
        return <article key={client.id} className={client.effectiveStatus}>
          <div><strong>{client.label}</strong><small>{roleAccessId ? PORTABLE_AGENT_ROLE_PROFILES[roleAccessId].label : shareMode === "viewer" ? "文章只读通行证" : shareMode === "editor" ? "任务协作通行证" : legacyV4 ? "旧版仅兑换，需换发" : siteFullControl ? "Agent 站内全权（本机）" : client.role === "super_admin" ? "超级管理员" : client.role === "administrator" ? "管理员" : "普通 Agent"} · {client.clientKind} · {client.scopes.length} 项 scope · {client.articleIds.includes("*") ? <mark className="all-articles-boundary">全部文章（含以后新增）</mark> : `${client.articleIds.length} 个文章边界`}</small></div>
          <dl><div><dt>Key</dt><dd>{legacyV4 ? "旧版仅兑换，需换发" : client.effectiveStatus === "active" ? "有效" : client.effectiveStatus === "expired" ? "已过期" : "已撤销"}</dd></div><div><dt>最近连通</dt><dd>{timeLabel(client.lastSeenAt)}</dd></div><div><dt>到期</dt><dd>{timeLabel(client.expiresAt)}</dd></div></dl>
          <details><summary>权限快照与对象边界</summary>
            {shareMode ? <><p>{shareMode === "viewer" ? "仅可读取这一篇文章。" : "仅可在这一项任务的 Agent 分支提交候选；不能改 main、合并或发布。"}</p><p>scopes：<code>{client.scopes.join(", ")}</code></p></> : <>{client.articleIds.includes("*") && <p className="all-articles-boundary">{localImportAllArticles ? "全部文章建档范围。" : "正式全文章边界：包括此 Key 签发后新增的文章。换发时仍需重新确认。"}</p>}{legacyV4 ? <p>旧 v4 根 Key 仅可兑换管理会话，不会静默扩权；请换发 v5 Key。</p> : siteFullControl && <p>v5 Key 可直接 Agent API，也可选兑换本机管理会话；来源：{client.issuedBySourceClientId ?? "所有者管理会话"}。</p>}<p>scopes：<code>{client.scopes.join(", ") || "legacy"}</code></p><p>actionIds：<code>{projection?.actionIds?.join(", ") || "legacy（不可静默换发）"}</code></p><p>预设：{projection?.presetId ?? "legacy"} · catalog：{projection?.catalogVersion ?? "legacy"} · profile：{projection?.profileVersion ?? projection?.schemaVersion ?? "legacy"} · snapshot：{short(projection?.snapshotSha256 ?? "")}</p>{(legacyV4 || siteFullControl) && <p>管理投影：{projection?.managementProjectionVersion ?? "legacy（需换发）"} · {projection?.managementScopes?.length ?? 0} 项 · hash：{short(projection?.managementProjectionSha256 ?? "")}<br />scopes：<code>{projection?.managementScopes?.join(", ") || "legacy（需换发）"}</code></p>}</>}
            <p>articleIds：<code>{client.articleIds.join(", ")}</code> · taskIds：<code>{client.taskIds.join(", ") || "[]"}</code></p>
          </details>
          {client.status === "active" && <div className="agent-client-actions"><button disabled={busy !== "" || issuedClient !== null} onClick={() => prepareClientReplacement(client)}>{roleAccessId ? "换发角色钥匙" : shareMode ? "换发通行证" : legacyV4 ? "换发 v5 Key" : client.effectiveStatus === "expired" ? "换发新 Key" : "准备换发"}</button><button disabled={busy !== "" || issuedClient !== null} onClick={() => void revokeClient(client.id)}>{client.effectiveStatus === "expired" ? "清理过期记录" : roleAccessId ? "撤销角色钥匙" : shareMode ? "停止共享" : "撤销 Key"}</button></div>}
        </article>;
      })}{!clients.length && <p>尚未生成角色钥匙、共享通行证或高级 Agent Key。</p>}</div>
      <footer><span>角色钥匙解决全库盘点、任务编排、候选生产和本机建档；重复身份的最终归并、工作流批量建立新根、源码升级、审批、合并和外部发布仍走各自的受控流程。API 成功不等于正文已采用或内容已公开。</span><button onClick={closeClientPanel}>完成并清除一次性 Key</button></footer>
    </dialog>}
  </div>;
}
