"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { managementFetch } from "./management-fetch";

export type ImprovementProviderId = "deepseek" | "qwen" | "openai" | "ollama";

export type ImprovementExperimentState =
  | "draft"
  | "generating"
  | "candidate"
  | "evaluating"
  | "review"
  | "adopted"
  | "rejected"
  | "rolled_back"
  | "blocked"
  | "failed";

export interface ProviderConnectionTest {
  provider: ImprovementProviderId;
  model: string;
  result: "pass" | "fail" | "inconclusive";
  markerMatched: boolean;
  latencyMs: number | null;
  testedAt: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  } | null;
  errorCode?: string | null;
}

export interface ImprovementProviderStatus {
  id: ImprovementProviderId;
  label: string;
  configured: boolean;
  enabled: boolean;
  status: "disabled" | "not_configured" | "ready" | "degraded" | "unavailable";
  defaultModel: string | null;
  allowedModels: string[];
  lastTest?: ProviderConnectionTest | null;
}

export interface ImprovementEvaluationCase {
  id: string;
  input: string;
  requiredSignals: string[];
  forbiddenSignals: string[];
  holdout: boolean;
  redacted?: boolean;
}

export interface ImprovementCandidate {
  id: string;
  provider: ImprovementProviderId;
  model: string;
  title: string;
  summary: string;
  candidateSha256: string;
  parentVersionId: string | null;
  status: "candidate" | "selected" | "rejected" | "adopted";
  createdAt: string;
}

export interface HumanEvidenceLiteralCheck {
  kind: "required" | "forbidden";
  literal: string;
  passed: boolean;
}

export interface HumanEvidenceArm {
  result: string;
  artifactPreview: string;
  artifactSha256: string;
  evidenceSha256: string;
  literalChecks: HumanEvidenceLiteralCheck[];
}

export interface HumanEvidenceCase {
  caseId: string;
  pairId: string;
  holdout: boolean;
  inputPreview: string;
  requiredSignals: string[];
  forbiddenSignals: string[];
  baseline: HumanEvidenceArm;
  candidate: HumanEvidenceArm;
}

export interface HumanAdoptionEvidence {
  schemaVersion: string;
  experimentId: string;
  evidenceBundleSha256: string;
  candidate: {
    id: string;
    parentVersionId: string | null;
    contentSha256: string;
  };
  activation: {
    skillKey: string;
    activeVersionId: string;
    lockVersion: number;
  };
  coverage: {
    requiredCases: number;
    pairedCases: number;
    holdoutCases: number;
    complete: boolean;
  };
  signalSummary: {
    passed: boolean;
    weightedScore: number;
    totalWeight: number;
    failedSignals: string[];
    criticalRegressions: string[];
  };
  cases: HumanEvidenceCase[];
  reviewer: {
    provider: string;
    model: string;
    result: string;
    preferredArm: string;
    findings: string[];
    criticalRisks: string[];
    evidenceRefs: string[];
    evidenceSha256: string;
  } | null;
  complete: boolean;
}

export interface PairwiseEvaluation {
  id: string;
  baselineVersionId: string;
  candidateId: string;
  evaluatorProviders: ImprovementProviderId[];
  outcome: "baseline" | "candidate" | "tie" | "inconclusive";
  winnerCandidateId: string | null;
  independentReviewPassed: boolean;
  summary: string;
  createdAt: string;
}

export interface MetaImprovementTarget {
  skillKey: string;
  label: string;
  activeVersion: string;
  activeSha256: string;
}

export interface MetaImprovementExperiment {
  id: string;
  articleId: string | null;
  targetSkillKey: string;
  baselineVersion: string;
  baselineSha256: string;
  objective: string;
  failureEvidenceRefs: string[];
  executionProvider: ImprovementProviderId;
  proposerProvider: ImprovementProviderId;
  reviewerProvider: ImprovementProviderId;
  budgetCalls: number;
  usedCalls: number;
  evaluationCases: ImprovementEvaluationCase[];
  state: ImprovementExperimentState;
  lockVersion: number;
  candidates: ImprovementCandidate[];
  evaluations: PairwiseEvaluation[];
  humanEvidence: HumanAdoptionEvidence | null;
  selectedCandidateId: string | null;
  decisionNote: string;
  createdAt: string;
  updatedAt: string;
}

export interface MetaImprovementPolicy {
  browserKeyEntryAllowed: false;
  keyMaterialReturned: false;
  apiConnectionIsMetaImprovement: false;
  independentReviewRequired: true;
  minimumIndependentProviders: number;
  hardBudgetDimensions: string[];
  estimatedCostBudgetEnforced: false;
}

export interface MetaImprovementDashboard {
  schemaVersion: string;
  providers: ImprovementProviderStatus[];
  policy: MetaImprovementPolicy;
  targets: MetaImprovementTarget[];
  experiments: MetaImprovementExperiment[];
}

type ApiEnvelope<T> =
  | { ok: true; requestId: string; data: T }
  | { ok: false; requestId: string; error: { code: string; message: string; details?: unknown } };

class ImprovementRequestError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ImprovementRequestError";
    this.code = code;
  }
}

export interface MetaImprovementLabProps {
  articleId?: string;
  initialTargetSkillKey?: string;
  initialBaselineVersion?: string;
  initialBaselineSha256?: string;
  notify?: (message: string) => void;
  className?: string;
}

type ExperimentDraft = {
  targetSkillKey: string;
  baselineVersion: string;
  baselineSha256: string;
  objective: string;
  failureEvidenceRefs: string;
  executionProvider: ImprovementProviderId;
  proposerProvider: ImprovementProviderId;
  reviewerProvider: ImprovementProviderId;
  budgetCalls: number;
  evaluationCases: ImprovementEvaluationCase[];
};

type ExperimentMutationData = { experiment: MetaImprovementExperiment };
type ProviderTestMutationData = { test: ProviderConnectionTest; provider: ImprovementProviderStatus };

const PROVIDER_IDS: ImprovementProviderId[] = ["deepseek", "qwen", "openai", "ollama"];
const EMPTY_PROVIDER_STATUSES: ImprovementProviderStatus[] = [];
const SHA256_RE = /^[a-f0-9]{64}$/;
const STATE_LABELS: Record<ImprovementExperimentState, string> = {
  draft: "草稿",
  generating: "生成候选中",
  candidate: "候选待评估",
  evaluating: "成对评估中",
  review: "等待人工决定",
  adopted: "已采纳",
  rejected: "已拒绝",
  rolled_back: "已回滚",
  blocked: "已阻塞",
  failed: "运行失败",
};

function emptyEvaluationCase(index: number, holdout = false): ImprovementEvaluationCase {
  return {
    id: `case-${index}`,
    input: "",
    requiredSignals: [],
    forbiddenSignals: [],
    holdout,
  };
}

function initialDraft(props: MetaImprovementLabProps): ExperimentDraft {
  return {
    targetSkillKey: props.initialTargetSkillKey ?? "",
    baselineVersion: props.initialBaselineVersion ?? "",
    baselineSha256: props.initialBaselineSha256 ?? "",
    objective: "",
    failureEvidenceRefs: "",
    executionProvider: "deepseek",
    proposerProvider: "deepseek",
    reviewerProvider: "qwen",
    budgetCalls: 6,
    evaluationCases: [emptyEvaluationCase(1), emptyEvaluationCase(2, true)],
  };
}

function lines(value: string) {
  return value.split(/\r?\n/u).map((item) => item.trim()).filter(Boolean);
}

function timeLabel(value: string | null | undefined) {
  if (!value) return "尚无";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(date);
}

function shortHash(value: string) {
  return value ? value.slice(0, 12) : "未绑定";
}

function commandId(action: string) {
  return `improvement:${action}:${crypto.randomUUID()}`;
}

async function readEnvelope<T>(response: Response): Promise<T> {
  let payload: ApiEnvelope<T>;
  try {
    payload = await response.json() as ApiEnvelope<T>;
  } catch {
    throw new Error(`改进实验 API 返回了不可解析的响应（HTTP ${response.status}）`);
  }
  if (!response.ok || !payload.ok) {
    if (payload.ok) throw new ImprovementRequestError(`HTTP_${response.status}`, `HTTP ${response.status}`);
    throw new ImprovementRequestError(payload.error.code, payload.error.message);
  }
  return payload.data;
}

function providerLabel(provider: ImprovementProviderStatus | undefined, id: ImprovementProviderId) {
  return provider?.label || (id === "deepseek" ? "DeepSeek" : id === "qwen" ? "Qwen" : id === "openai" ? "OpenAI" : "Ollama（本地网络）");
}

export default function MetaImprovementLab(props: MetaImprovementLabProps) {
  const {
    articleId,
    notify,
    className = "",
  } = props;
  const [dashboard, setDashboard] = useState<MetaImprovementDashboard | null>(null);
  const [selectedExperimentId, setSelectedExperimentId] = useState("");
  const [draft, setDraft] = useState<ExperimentDraft>(() => initialDraft(props));
  const [selectedCandidateId, setSelectedCandidateId] = useState("");
  const [decisionNote, setDecisionNote] = useState("");
  const [ephemeralTests, setEphemeralTests] = useState<Partial<Record<ImprovementProviderId, ProviderConnectionTest>>>({});
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [errorCode, setErrorCode] = useState("");
  const selectedExperimentIdRef = useRef("");
  const pendingCommandIdsRef = useRef(new Map<string, string>());

  const selectExperimentSnapshot = useCallback((experiment: MetaImprovementExperiment | null) => {
    const nextId = experiment?.id ?? "";
    selectedExperimentIdRef.current = nextId;
    setSelectedExperimentId(nextId);
    setSelectedCandidateId(experiment?.selectedCandidateId ?? experiment?.candidates[0]?.id ?? "");
    setDecisionNote("");
  }, []);

  const loadDashboard = useCallback(async (quiet = false) => {
    if (!quiet) setState("loading");
    try {
      const query = new URLSearchParams({ view: "status" });
      if (articleId) query.set("articleId", articleId);
      const response = await managementFetch(`/api/improvement/v1?${query.toString()}`, { cache: "no-store" });
      const data = await readEnvelope<MetaImprovementDashboard>(response);
      setDashboard(data);
      setDraft((current) => {
        const target = data.targets.find((item) => item.skillKey === current.targetSkillKey) ?? data.targets[0];
        return target
          ? {
              ...current,
              targetSkillKey: target.skillKey,
              baselineVersion: target.activeVersion,
              baselineSha256: target.activeSha256,
            }
          : current;
      });
      const selected = data.experiments.find((item) => item.id === selectedExperimentIdRef.current)
        ?? data.experiments[0]
        ?? null;
      selectExperimentSnapshot(selected);
      setState("ready");
      setError("");
      setErrorCode("");
    } catch (caught) {
      if (!quiet) setState("error");
      setError(caught instanceof Error ? caught.message : "元改进控制面不可用");
      setErrorCode(caught instanceof ImprovementRequestError ? caught.code : "");
    }
  }, [articleId, selectExperimentSnapshot]);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadDashboard(), 0);
    return () => window.clearTimeout(timer);
  }, [loadDashboard]);

  const providers = dashboard?.providers ?? EMPTY_PROVIDER_STATUSES;
  const targets = dashboard?.targets ?? [];
  const providerStateKnown = dashboard !== null;
  const providerById = useMemo(
    () => new Map(providers.map((provider) => [provider.id, provider])),
    [providers],
  );
  const selectedExperiment = dashboard?.experiments.find((item) => item.id === selectedExperimentId) ?? null;
  const configuredProviders = providers.filter((provider) => provider.configured && provider.enabled);
  const deepseekConfigured = providerById.get("deepseek")?.configured === true;
  const qwenConfigured = providerById.get("qwen")?.configured === true;
  const independentProviderFloor = dashboard?.policy.minimumIndependentProviders ?? 2;
  const providerFloorMet = configuredProviders.length >= independentProviderFloor;
  const selectedTarget = targets.find((target) => target.skillKey === draft.targetSkillKey);
  const minimumBudgetCalls = 2 + draft.evaluationCases.length * 2;

  const adoptionIndependentGate = selectedExperiment
    ? providerById.get(selectedExperiment.proposerProvider)?.configured === true
      && providerById.get(selectedExperiment.reviewerProvider)?.configured === true
      && selectedExperiment.proposerProvider !== selectedExperiment.reviewerProvider
      && selectedExperiment.executionProvider !== selectedExperiment.reviewerProvider
      && providerFloorMet
    : false;

  const latestIndependentEvaluation = selectedExperiment?.evaluations
    .slice()
    .reverse()
    .find((evaluation) => evaluation.candidateId === selectedCandidateId
      && evaluation.outcome === "candidate"
      && evaluation.independentReviewPassed) ?? null;
  const humanEvidence = selectedExperiment?.humanEvidence ?? null;
  const humanEvidenceMatchesSelection = Boolean(humanEvidence)
    && humanEvidence?.candidate.id === selectedCandidateId
    && SHA256_RE.test(humanEvidence?.candidate.contentSha256 ?? "")
    && SHA256_RE.test(humanEvidence?.evidenceBundleSha256 ?? "");

  const postAction = useCallback(async <T,>(action: string, payload: Record<string, unknown>) => {
    const requestKey = `${action}:${JSON.stringify(payload)}`;
    const existingCommandId = pendingCommandIdsRef.current.get(requestKey);
    const currentCommandId = existingCommandId ?? commandId(action);
    pendingCommandIdsRef.current.set(requestKey, currentCommandId);
    // A transport failure has an unknown server outcome. Because deletion only
    // happens after an HTTP response, a user retry replays this authoritative id.
    const response = await managementFetch("/api/improvement/v1", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action, commandId: currentCommandId, payload }),
    });
    try {
      return await readEnvelope<T>(response);
    } finally {
      // Any HTTP response is a definite command outcome, including a typed
      // error. Only then may a later intentional attempt receive a new id.
      pendingCommandIdsRef.current.delete(requestKey);
    }
  }, []);

  const initializeWorkspace = useCallback(async () => {
    setBusy("initialize_workspace");
    setError("");
    setErrorCode("");
    try {
      await postAction<{ initialized: true }>("initialize_workspace", {});
      await loadDashboard();
      notify?.("元改进工作区已显式初始化；尚未生成候选或修改任何活动版本");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "初始化元改进工作区失败");
      setErrorCode(caught instanceof ImprovementRequestError ? caught.code : "");
    } finally {
      setBusy("");
    }
  }, [loadDashboard, notify, postAction]);

  const testProvider = useCallback(async (providerId: ImprovementProviderId) => {
    const provider = providerById.get(providerId);
    if (!provider?.configured || !provider.enabled) return;
    setBusy(`test:${providerId}`);
    setError("");
    try {
      const data = await postAction<ProviderTestMutationData>("test_provider", { provider: providerId });
      setEphemeralTests((current) => ({ ...current, [providerId]: data.test }));
      await loadDashboard(true);
      notify?.(`${providerLabel(provider, providerId)} 安全连通测试：${data.test.result}`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "模型连通测试失败");
    } finally {
      setBusy("");
    }
  }, [loadDashboard, notify, postAction, providerById]);

  const updateEvaluationCase = useCallback((index: number, patch: Partial<ImprovementEvaluationCase>) => {
    setDraft((current) => ({
      ...current,
      evaluationCases: current.evaluationCases.map((item, itemIndex) => itemIndex === index ? { ...item, ...patch } : item),
    }));
  }, []);

  const selectTarget = useCallback((skillKey: string) => {
    const target = dashboard?.targets.find((item) => item.skillKey === skillKey);
    if (!target) return;
    setDraft((current) => ({
      ...current,
      targetSkillKey: target.skillKey,
      baselineVersion: target.activeVersion,
      baselineSha256: target.activeSha256,
    }));
  }, [dashboard?.targets]);

  const draftProblems = useMemo(() => {
    const problems: string[] = [];
    if (!selectedTarget) problems.push("服务端登记的目标 Skill");
    if (selectedTarget && draft.baselineVersion !== selectedTarget.activeVersion) problems.push("当前激活基线版本");
    if (selectedTarget && draft.baselineSha256.toLowerCase() !== selectedTarget.activeSha256.toLowerCase()) problems.push("当前激活基线 SHA-256");
    if (!SHA256_RE.test(draft.baselineSha256.trim().toLowerCase())) problems.push("64 位基线 SHA-256");
    if (!draft.objective.trim()) problems.push("改进目标");
    if (!Number.isInteger(draft.budgetCalls) || draft.budgetCalls < minimumBudgetCalls || draft.budgetCalls > 30) problems.push(`${minimumBudgetCalls} 到 30 次调用预算`);
    if (draft.evaluationCases.length < 2) problems.push("至少两个评估用例");
    if (!draft.evaluationCases.some((item) => item.holdout)) problems.push("至少一个 holdout 用例");
    const caseIds = new Set<string>();
    for (const item of draft.evaluationCases) {
      if (!item.id.trim() || caseIds.has(item.id.trim()) || !item.input.trim() || item.requiredSignals.length === 0) {
        problems.push("用例需要唯一 ID、输入和至少一个必需信号");
        break;
      }
      caseIds.add(item.id.trim());
    }
    return problems;
  }, [draft, minimumBudgetCalls, selectedTarget]);

  const createExperiment = useCallback(async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (draftProblems.length) return;
    setBusy("create");
    setError("");
    try {
      const data = await postAction<ExperimentMutationData>("create_experiment", {
        articleId: articleId ?? null,
        targetSkillKey: draft.targetSkillKey.trim(),
        baselineVersion: draft.baselineVersion.trim(),
        baselineSha256: draft.baselineSha256.trim().toLowerCase(),
        objective: draft.objective.trim(),
        failureEvidenceRefs: lines(draft.failureEvidenceRefs),
        executionProvider: draft.executionProvider,
        proposerProvider: draft.proposerProvider,
        reviewerProvider: draft.reviewerProvider,
        budgetCalls: draft.budgetCalls,
        evaluationCases: draft.evaluationCases.map((item) => ({
          id: item.id.trim(),
          input: item.input.trim(),
          requiredSignals: item.requiredSignals,
          forbiddenSignals: item.forbiddenSignals,
          holdout: item.holdout,
        })),
      });
      selectExperimentSnapshot(data.experiment);
      setDraft((current) => ({
        ...initialDraft({ initialTargetSkillKey: current.targetSkillKey }),
        targetSkillKey: current.targetSkillKey,
        baselineVersion: current.baselineVersion,
        baselineSha256: current.baselineSha256,
      }));
      await loadDashboard(true);
      notify?.("改进实验草稿已建立；尚未生成候选，也没有改变任何 Skill");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "创建改进实验失败");
    } finally {
      setBusy("");
    }
  }, [articleId, draft, draftProblems, loadDashboard, notify, postAction, selectExperimentSnapshot]);

  const mutateExperiment = useCallback(async (
    action: "generate_candidates" | "run_pairwise_evaluation" | "decide_experiment",
    payload: Record<string, unknown>,
    successMessage: string,
  ) => {
    if (!selectedExperiment) return;
    setBusy(action);
    setError("");
    try {
      const data = await postAction<ExperimentMutationData>(action, {
        experimentId: selectedExperiment.id,
        expectedLockVersion: selectedExperiment.lockVersion,
        ...payload,
      });
      selectExperimentSnapshot(data.experiment);
      await loadDashboard(true);
      notify?.(successMessage);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "改进实验操作失败");
    } finally {
      setBusy("");
    }
  }, [loadDashboard, notify, postAction, selectExperimentSnapshot, selectedExperiment]);

  const generateCandidates = useCallback(() => mutateExperiment(
    "generate_candidates",
    {},
    "候选生成已完成；结果仍只是候选，尚未通过互审或人工采纳",
  ), [mutateExperiment]);

  const runPairwiseEvaluation = useCallback((reviewerOnly = false) => {
    if (!selectedCandidateId) return Promise.resolve();
    return mutateExperiment(
      "run_pairwise_evaluation",
      { candidateId: selectedCandidateId, ...(reviewerOnly ? { reviewerOnly: true } : {}) },
      reviewerOnly
        ? "独立互审已补做；既有基线—候选双臂证据未重新执行"
        : "基线—候选成对评估已完成；请核对留出用例证据与独立互审标记",
    );
  }, [mutateExperiment, selectedCandidateId]);

  const decide = useCallback((decision: "adopt" | "reject" | "rollback") => {
    if (decisionNote.trim().length < 8) return Promise.resolve();
    const candidateId = decision === "adopt" ? selectedCandidateId : null;
    if (decision === "adopt" && (!humanEvidence?.complete || !humanEvidenceMatchesSelection)) {
      return Promise.resolve();
    }
    return mutateExperiment(
      "decide_experiment",
      {
        decision,
        candidateId,
        note: decisionNote.trim(),
        ...(decision === "adopt" && humanEvidence
          ? {
              expectedCandidateSha256: humanEvidence.candidate.contentSha256,
              expectedEvidenceBundleSha256: humanEvidence.evidenceBundleSha256,
              expectedActiveVersionId: humanEvidence.activation.activeVersionId,
              expectedActivationLockVersion: humanEvidence.activation.lockVersion,
            }
          : {}),
      },
      decision === "adopt"
        ? "候选已由人工采纳；请继续核对真实 Skill 落地和回归证据"
        : decision === "rollback"
          ? "回滚决定已记录；请核对目标版本是否真实恢复"
          : "实验已由人工拒绝",
    );
  }, [decisionNote, humanEvidence, humanEvidenceMatchesSelection, mutateExperiment, selectedCandidateId]);

  const canGenerate = Boolean(selectedExperiment)
    && providerById.get(selectedExperiment?.proposerProvider ?? "deepseek")?.configured === true
    && providerById.get(selectedExperiment?.proposerProvider ?? "deepseek")?.enabled === true
    && ["draft", "blocked", "failed"].includes(selectedExperiment?.state ?? "")
    && selectedExperiment?.candidates.length === 0
    && !busy;
  const canEvaluate = Boolean(selectedExperiment)
    && providerById.get(selectedExperiment?.executionProvider ?? "deepseek")?.configured === true
    && providerById.get(selectedExperiment?.executionProvider ?? "deepseek")?.enabled === true
    && Boolean(selectedCandidateId)
    && selectedExperiment?.state === "candidate"
    && !busy;
  const reviewerOnlyNeeded = Boolean(selectedExperiment)
    && selectedExperiment?.state === "review"
    && humanEvidence?.coverage.complete === true
    && humanEvidence.reviewer === null;
  const canResumeReviewer = reviewerOnlyNeeded
    && providerById.get(selectedExperiment?.reviewerProvider ?? "qwen")?.configured === true
    && providerById.get(selectedExperiment?.reviewerProvider ?? "qwen")?.enabled === true
    && Boolean(selectedCandidateId)
    && !busy;
  const canAdopt = Boolean(selectedExperiment)
    && adoptionIndependentGate
    && Boolean(selectedCandidateId)
    && Boolean(latestIndependentEvaluation)
    && humanEvidence?.complete === true
    && humanEvidence.signalSummary.passed
    && humanEvidenceMatchesSelection
    && selectedExperiment?.state === "review"
    && decisionNote.trim().length >= 8
    && !busy;
  const canReject = Boolean(selectedExperiment)
    && ["draft", "generating", "candidate", "evaluating", "review", "blocked", "failed"].includes(selectedExperiment?.state ?? "")
    && decisionNote.trim().length >= 8
    && !busy;
  const canRollback = selectedExperiment?.state === "adopted" && decisionNote.trim().length >= 8 && !busy;

  return <section className={`meta-improvement-lab ${className}`.trim()} aria-labelledby="meta-improvement-title">
    <header className="meta-improvement-header">
      <div>
        <span className="eyebrow">Human-gated Meta Improvement</span>
        <h2 id="meta-improvement-title">元改进实验室</h2>
        <p>围绕一个冻结的 Skill 基线，记录失败证据、模型候选、留出用例、独立互审和人工决定。</p>
      </div>
      <button type="button" disabled={state === "loading" || Boolean(busy)} onClick={() => void loadDashboard()}>刷新状态</button>
    </header>

    <aside className="meta-improvement-truth" role="note">
      <strong>API 接通不等于元改进。</strong>
      <p>连通测试只证明服务端可以调用 provider，不证明候选有效，更不证明元改进已经成立。只有冻结目标与基线、生成候选、完成留出用例对照、取得独立 provider 互审，并由人工决定采纳，才形成受控的元改进证据。</p>
      <p>浏览器不会要求、接收或保存模型密钥；所有 provider 调用必须经同源管理 API 在服务端完成。</p>
    </aside>

    {error && <div className="meta-improvement-error" role="alert"><strong>本次操作未成功</strong><p>{error}</p><p>现有实验、冻结基线和已记录证据不会因此自动采纳或回滚。请先核对错误详情与当前状态，再刷新或执行页面提供的恢复操作。</p>{errorCode === "IMPROVEMENT_NOT_INITIALIZED" && <button type="button" disabled={Boolean(busy)} onClick={() => void initializeWorkspace()}>{busy === "initialize_workspace" ? "正在初始化……" : "初始化元改进工作区"}</button>}</div>}
    {state === "loading" && <p className="meta-improvement-loading" role="status">正在读取模型与实验状态……</p>}

    <section className="meta-provider-section" aria-labelledby="meta-provider-title">
      <header><div><span className="eyebrow">01 · Server-side providers</span><h2 id="meta-provider-title">安全连通与互审门槛</h2></div><p>测试使用服务端固定短提示，不发送文章或实验正文。</p></header>
      <div className="meta-provider-grid">
        {PROVIDER_IDS.map((providerId) => {
          const provider = providerById.get(providerId);
          const test = ephemeralTests[providerId] ?? provider?.lastTest ?? null;
          const configured = provider?.configured === true;
          const enabled = provider?.enabled === true;
          const statusLabel = !providerStateKnown ? "状态未读取" : !enabled ? "服务端未启用" : configured ? "服务端已配置" : "未配置";
          return <article key={providerId} className={`meta-provider-card ${!providerStateKnown ? "unknown" : enabled && configured ? "configured" : "not-configured"}`}>
            <header><div><strong>{providerLabel(provider, providerId)}</strong><span>{statusLabel}</span></div><em>{provider?.defaultModel || (providerStateKnown ? "没有可用模型" : "等待服务端状态")}</em></header>
            <p>{!providerStateKnown ? "尚未取得服务端状态；此处不会据此推断密钥是否存在。" : !enabled ? "兼容代码已部署，但服务端 feature flag 未开启；当前不会写入或发起外部请求。" : configured ? "密钥只存在于服务端 binding；浏览器只能发起固定连通测试。" : "服务端没有报告可用凭据，当前不会发起外部请求。"}</p>
            {providerStateKnown && providerId === "qwen" && !configured && <strong className="meta-provider-blocker">Qwen 未配置：独立互审门槛未满足。仍可由已配置的 proposer 生成候选、由 execution provider 做确定性评估，但独立互审与 adopt 保持禁用。</strong>}
            {test && <dl className="meta-provider-test-result"><div><dt>最近测试</dt><dd>{test.result}</dd></div><div><dt>marker</dt><dd>{test.markerMatched ? "匹配" : "未匹配"}</dd></div><div><dt>耗时</dt><dd>{test.latencyMs === null ? "未知" : `${test.latencyMs} ms`}</dd></div><div><dt>时间</dt><dd>{timeLabel(test.testedAt)}</dd></div></dl>}
            <button type="button" disabled={!configured || !enabled || Boolean(busy)} onClick={() => void testProvider(providerId)}>{busy === `test:${providerId}` ? "测试中……" : "运行安全连通测试"}</button>
          </article>;
        })}
      </div>
      <div className={`meta-independent-gate ${!providerStateKnown ? "unknown" : deepseekConfigured && qwenConfigured && providerFloorMet ? "pass" : "blocked"}`}>
        <strong>{!providerStateKnown ? "独立互审状态尚未读取" : deepseekConfigured && qwenConfigured && providerFloorMet ? "独立互审门槛已具备" : "独立互审门槛未满足"}</strong>
        <span>需要 DeepSeek 与 Qwen 均在服务端配置，且提案者和审查者不能是同一 provider。连接成功仍不代表实验通过。</span>
      </div>
    </section>

    <section className="meta-experiment-create" aria-labelledby="meta-create-title">
      <header><div><span className="eyebrow">02 · Freeze the contract</span><h2 id="meta-create-title">建立改进实验</h2></div><p>创建只冻结合同，不调用模型，也不会修改目标 Skill。</p></header>
      <form onSubmit={createExperiment}>
        <div className="meta-experiment-fields">
          <label><span>目标 Skill</span><select value={draft.targetSkillKey} onChange={(event) => selectTarget(event.target.value)} disabled={!targets.length}><option value="" disabled>{targets.length ? "选择服务端登记目标" : "服务端尚未返回目标"}</option>{targets.map((target) => <option key={target.skillKey} value={target.skillKey}>{target.label} · {target.skillKey}</option>)}</select></label>
          <label><span>当前激活基线版本</span><input value={draft.baselineVersion} readOnly aria-readonly="true" placeholder="由服务端目标自动绑定" /></label>
          <label className="wide"><span>当前激活基线 SHA-256</span><input value={draft.baselineSha256} readOnly aria-readonly="true" spellCheck={false} placeholder="由服务端目标自动绑定" /></label>
          <label className="wide"><span>改进目标</span><textarea value={draft.objective} onChange={(event) => setDraft((current) => ({ ...current, objective: event.target.value }))} rows={3} placeholder="说明要改进的是改进流程中的哪一项能力，以及怎样才算更好" /></label>
          <label className="wide"><span>失败证据引用（每行一项）</span><textarea value={draft.failureEvidenceRefs} onChange={(event) => setDraft((current) => ({ ...current, failureEvidenceRefs: event.target.value }))} rows={3} placeholder="工件路径、事件 ID、报告锚点或可验证引用" /></label>
          <label><span>执行 provider</span><select value={draft.executionProvider} onChange={(event) => setDraft((current) => ({ ...current, executionProvider: event.target.value as ImprovementProviderId }))}>{PROVIDER_IDS.map((id) => <option key={id} value={id} disabled={providerStateKnown && providerById.get(id)?.enabled === false}>{providerLabel(providerById.get(id), id)}{providerStateKnown && providerById.get(id)?.enabled === false ? " · 服务端未启用" : providerStateKnown && !providerById.get(id)?.configured ? " · 未配置" : ""}</option>)}</select></label>
          <label><span>候选提案者</span><select value={draft.proposerProvider} onChange={(event) => setDraft((current) => ({ ...current, proposerProvider: event.target.value as ImprovementProviderId }))}>{PROVIDER_IDS.map((id) => <option key={id} value={id} disabled={providerStateKnown && providerById.get(id)?.enabled === false}>{providerLabel(providerById.get(id), id)}{providerStateKnown && providerById.get(id)?.enabled === false ? " · 服务端未启用" : providerStateKnown && !providerById.get(id)?.configured ? " · 未配置" : ""}</option>)}</select></label>
          <label><span>独立审查者</span><select value={draft.reviewerProvider} onChange={(event) => setDraft((current) => ({ ...current, reviewerProvider: event.target.value as ImprovementProviderId }))}>{PROVIDER_IDS.map((id) => <option key={id} value={id} disabled={providerStateKnown && providerById.get(id)?.enabled === false}>{providerLabel(providerById.get(id), id)}{providerStateKnown && providerById.get(id)?.enabled === false ? " · 服务端未启用" : providerStateKnown && !providerById.get(id)?.configured ? " · 未配置" : ""}</option>)}</select></label>
          <label><span>调用预算</span><input type="number" min={minimumBudgetCalls} max={30} value={draft.budgetCalls} onChange={(event) => setDraft((current) => ({ ...current, budgetCalls: Number(event.target.value) }))} /></label>
        </div>
        <p className="meta-form-hint">调用次数与输入/输出 token 预留是硬门槛；人民币成本尚未接实时价目，不作为硬上限。</p>

        <fieldset className="meta-evaluation-cases">
          <legend>留出评估用例</legend>
          <p>默认至少包含一个可见测试和一个 holdout；这些输入与信号在候选生成前冻结，模型不能通过改写用例来让自己通过。</p>
          {draft.evaluationCases.map((item, index) => <article key={`${index}-${item.id}`} className="meta-evaluation-case">
            <header><strong>用例 {index + 1}{item.holdout ? " · holdout" : " · visible"}</strong><button type="button" disabled={draft.evaluationCases.length <= 2} onClick={() => setDraft((current) => ({ ...current, evaluationCases: current.evaluationCases.filter((_, itemIndex) => itemIndex !== index) }))}>移除</button></header>
            <label><span>唯一 ID</span><input value={item.id} onChange={(event) => updateEvaluationCase(index, { id: event.target.value })} /></label>
            <label className="meta-holdout-toggle"><input type="checkbox" checked={item.holdout} onChange={(event) => updateEvaluationCase(index, { holdout: event.target.checked })} /><span>作为未向提案者公开的 holdout 用例</span></label>
            <label className="wide"><span>输入</span><textarea value={item.input} onChange={(event) => updateEvaluationCase(index, { input: event.target.value })} rows={3} /></label>
            <label><span>必需信号（每行一项）</span><textarea value={item.requiredSignals.join("\n")} onChange={(event) => updateEvaluationCase(index, { requiredSignals: lines(event.target.value) })} rows={3} /></label>
            <label><span>禁止信号（每行一项）</span><textarea value={item.forbiddenSignals.join("\n")} onChange={(event) => updateEvaluationCase(index, { forbiddenSignals: lines(event.target.value) })} rows={3} /></label>
          </article>)}
          <button type="button" onClick={() => setDraft((current) => {
            const evaluationCases = [...current.evaluationCases, emptyEvaluationCase(current.evaluationCases.length + 1)];
            return { ...current, evaluationCases, budgetCalls: Math.max(current.budgetCalls, 2 + evaluationCases.length * 2) };
          })}>添加留出用例</button>
        </fieldset>

        {(draft.proposerProvider === draft.reviewerProvider || draft.executionProvider === draft.reviewerProvider) && <p className="meta-form-blocker" role="alert">审查者与提案者或执行者相同：仍可创建实验、生成候选和做确定性评估，但不能形成独立互审，adopt 将保持禁用。</p>}
        {providerStateKnown && !qwenConfigured && <p className="meta-form-warning">可以先建立实验草稿；已配置的提案者仍可生成候选，已配置的执行 provider 仍可做确定性评估。Qwen 配置完成并通过独立互审前，adopt 保持禁用。</p>}
        {draftProblems.length > 0 && <p className="meta-form-hint">还需填写：{draftProblems.join("、")}</p>}
        <button className="primary-button" type="submit" disabled={draftProblems.length > 0 || Boolean(busy)}>{busy === "create" ? "正在建立……" : "只建立实验草稿"}</button>
      </form>
    </section>

    <section className="meta-experiment-workbench" aria-labelledby="meta-workbench-title">
      <header><div><span className="eyebrow">03 · Propose, compare, decide</span><h2 id="meta-workbench-title">生成候选、成对评估、人工决定</h2></div><p>模型输出始终停在候选层；只有当前管理会话中的人可以执行 adopt、reject 或 rollback。</p></header>
      <div className="meta-experiment-layout">
        <nav className="meta-experiment-list" aria-label="改进实验列表">
          {(dashboard?.experiments ?? []).map((experiment) => <button type="button" key={experiment.id} className={experiment.id === selectedExperimentId ? "active" : ""} onClick={() => selectExperimentSnapshot(experiment)}><strong>{experiment.targetSkillKey}</strong><span>{STATE_LABELS[experiment.state]}</span><small>{experiment.baselineVersion} · {experiment.usedCalls}/{experiment.budgetCalls} calls</small></button>)}
          {state === "ready" && !dashboard?.experiments.length && <p>还没有改进实验。</p>}
        </nav>

        {selectedExperiment ? <main className="meta-experiment-detail">
          <header><div><span className="eyebrow">{STATE_LABELS[selectedExperiment.state]} · lock {selectedExperiment.lockVersion}</span><h3>{selectedExperiment.targetSkillKey}</h3><p>{selectedExperiment.objective}</p></div><code>{shortHash(selectedExperiment.baselineSha256)}</code></header>
          <dl className="meta-experiment-facts"><div><dt>执行</dt><dd>{selectedExperiment.executionProvider}</dd></div><div><dt>提案</dt><dd>{selectedExperiment.proposerProvider}</dd></div><div><dt>审查</dt><dd>{selectedExperiment.reviewerProvider}</dd></div><div><dt>用例</dt><dd>{selectedExperiment.evaluationCases.length}</dd></div><div><dt>调用</dt><dd>{selectedExperiment.usedCalls} / {selectedExperiment.budgetCalls}</dd></div><div><dt>更新</dt><dd>{timeLabel(selectedExperiment.updatedAt)}</dd></div></dl>

          {!adoptionIndependentGate && <div className="meta-experiment-blocker" role="alert"><strong>人工 adopt 被互审门槛阻塞</strong><p>生成只要求 proposer 可用，确定性评估只要求 execution provider 可用；但 adopt 要求提案者与审查者不同、二者均在服务端配置，并达到至少 {independentProviderFloor} 个独立 provider。</p></div>}

          <section className="meta-candidate-actions"><button type="button" className="primary-button" disabled={!canGenerate} onClick={() => void generateCandidates()}>{busy === "generate_candidates" ? "正在生成……" : "生成受限候选"}</button><span>候选只能修改冻结目标的声明式内容，不能写入 main、运行 Shell、合并版本或采纳规则。</span></section>

          <section className="meta-candidates" aria-labelledby="meta-candidates-title">
            <header><h4 id="meta-candidates-title">候选</h4><span>选择一个候选，与实验冻结的基线进行成对评估；同一候选也是可能的人工采纳对象。</span></header>
            {selectedExperiment.candidates.map((candidate) => <article key={candidate.id} className="meta-candidate-card">
              <header><div><strong>{candidate.title}</strong><span>{candidate.provider} · {candidate.model}</span></div><code>{shortHash(candidate.candidateSha256)}</code></header>
              <p>{candidate.summary}</p>
              <small>内容 {candidate.candidateSha256} · parent {candidate.parentVersionId ?? "未绑定"}</small>
              <div className="meta-candidate-selectors"><label><input type="radio" name={`evaluation-candidate-${selectedExperiment.id}`} checked={selectedCandidateId === candidate.id} onChange={() => setSelectedCandidateId(candidate.id)} />选择为基线对照候选</label></div>
            </article>)}
            {!selectedExperiment.candidates.length && <p>尚无候选。生成只要求实验指定的 proposer 已在服务端配置。</p>}
            <button type="button" disabled={!canEvaluate} onClick={() => void runPairwiseEvaluation()}>{busy === "run_pairwise_evaluation" && !reviewerOnlyNeeded ? "评估中……" : "运行基线—候选成对评估"}</button>
            {reviewerOnlyNeeded && <button type="button" disabled={!canResumeReviewer} onClick={() => void runPairwiseEvaluation(true)}>{busy === "run_pairwise_evaluation" ? "正在补做互审……" : "补做独立互审"}</button>}
            {reviewerOnlyNeeded && !canResumeReviewer && <p className="meta-form-hint">既有双臂证据已保留；配置实验冻结的 reviewer provider 后，只补一次互审，不会重跑 execution arms。</p>}
          </section>

          <section className="meta-evaluations" aria-labelledby="meta-evaluations-title">
            <header><h4 id="meta-evaluations-title">评估证据</h4><span>只接受冻结用例与独立审查者绑定的结果。</span></header>
            {selectedExperiment.evaluations.map((evaluation) => <article key={evaluation.id} className={evaluation.independentReviewPassed ? "pass" : "inconclusive"}><strong>{evaluation.independentReviewPassed ? "独立互审通过" : "互审证据不足"}</strong><p>{evaluation.summary}</p><small>基线 {evaluation.baselineVersionId} ↔ 候选 {evaluation.candidateId} · {evaluation.evaluatorProviders.join(" + ")} · {evaluation.outcome} · {timeLabel(evaluation.createdAt)}</small></article>)}
            {!selectedExperiment.evaluations.length && <p>还没有成对评估。</p>}
            {selectedExperiment.evaluationCases.some((item) => item.redacted) && <p className="meta-form-hint">holdout 内容仍被遮蔽；只有所有冻结用例的双臂评估都完成后才会进入人工证据包。</p>}
            {humanEvidence && <details className="meta-human-evidence" open>
              <summary><strong>人工采纳证据包 · {humanEvidence.complete ? "完整" : "不完整"}</strong> · <code>{shortHash(humanEvidence.evidenceBundleSha256)}</code></summary>
              <dl className="meta-experiment-facts">
                <div><dt>候选内容 SHA</dt><dd><code>{humanEvidence.candidate.contentSha256}</code></dd></div>
                <div><dt>候选 parent</dt><dd>{humanEvidence.candidate.parentVersionId ?? "未绑定"}</dd></div>
                <div><dt>活动版本</dt><dd>{humanEvidence.activation.activeVersionId}</dd></div>
                <div><dt>activation lock</dt><dd>{humanEvidence.activation.lockVersion}</dd></div>
                <div><dt>覆盖</dt><dd>{humanEvidence.coverage.pairedCases}/{humanEvidence.coverage.requiredCases}，holdout {humanEvidence.coverage.holdoutCases}</dd></div>
                <div><dt>信号</dt><dd>{humanEvidence.signalSummary.passed ? "通过" : "未通过"} · {humanEvidence.signalSummary.weightedScore.toFixed(3)}</dd></div>
              </dl>
              {(humanEvidence.signalSummary.failedSignals.length > 0 || humanEvidence.signalSummary.criticalRegressions.length > 0) && <p role="alert">失败信号：{humanEvidence.signalSummary.failedSignals.join("、") || "无"}；关键回归：{humanEvidence.signalSummary.criticalRegressions.join("、") || "无"}</p>}
              {humanEvidence.reviewer ? <section aria-label="独立审查证据">
                <h5>独立审查</h5>
                <p>{humanEvidence.reviewer.provider} · {humanEvidence.reviewer.model} · {humanEvidence.reviewer.result} · preferred arm {humanEvidence.reviewer.preferredArm}</p>
                <p><strong>Findings：</strong>{humanEvidence.reviewer.findings.join("；") || "审查者未提供文字 findings"}</p>
                <p><strong>Critical risks：</strong>{humanEvidence.reviewer.criticalRisks.join("；") || "无"}</p>
                <p><strong>Evidence refs：</strong>{humanEvidence.reviewer.evidenceRefs.join("；") || "无"}</p>
                <small>review evidence SHA-256：{humanEvidence.reviewer.evidenceSha256}</small>
              </section> : <p role="alert">缺少独立 reviewer 证据，不能采纳。</p>}
              <div className="meta-human-evidence-cases">
                {humanEvidence.cases.map((caseItem) => <article key={caseItem.caseId} className="meta-evaluation-case">
                  <header><strong>{caseItem.caseId} · {caseItem.holdout ? "holdout" : "visible"}</strong><code>{caseItem.pairId}</code></header>
                  <p><strong>输入预览：</strong>{caseItem.inputPreview}</p>
                  <p><strong>必需字面量：</strong>{caseItem.requiredSignals.join("、") || "无"}</p>
                  <p><strong>禁止字面量：</strong>{caseItem.forbiddenSignals.join("、") || "无"}</p>
                  {(["baseline", "candidate"] as const).map((armName) => {
                    const arm = caseItem[armName];
                    return <section key={armName} aria-label={`${caseItem.caseId} ${armName} 工件`}>
                      <h5>{armName} · {arm.result}</h5>
                      <pre>{arm.artifactPreview}</pre>
                      <small>artifact SHA-256：{arm.artifactSha256}<br />evidence SHA-256：{arm.evidenceSha256}</small>
                      <ul>{arm.literalChecks.map((check, index) => <li key={`${check.kind}-${index}`}>{check.passed ? "✓" : "✗"} {check.kind === "required" ? "必需" : "禁止"}：{check.literal}</li>)}</ul>
                    </section>;
                  })}
                </article>)}
              </div>
              <p><small>完整 evidence bundle SHA-256：{humanEvidence.evidenceBundleSha256}</small></p>
            </details>}
          </section>

          <section className="meta-human-decision" aria-labelledby="meta-decision-title">
            <header><h4 id="meta-decision-title">人工决定</h4><span>API 连通、候选内容和模型评分都不能替代这一步。</span></header>
            <label><span>决定说明</span><textarea value={decisionNote} onChange={(event) => setDecisionNote(event.target.value)} rows={3} placeholder="说明采用、拒绝或回滚的证据与边界" /></label>
            <div className="meta-decision-actions"><button type="button" className="primary-button" disabled={!canAdopt} onClick={() => void decide("adopt")}>人工 adopt</button><button type="button" disabled={!canReject} onClick={() => void decide("reject")}>人工 reject</button><button type="button" className="danger-button" disabled={!canRollback} onClick={() => void decide("rollback")}>人工 rollback</button></div>
            {!latestIndependentEvaluation && selectedExperiment.state !== "adopted" && <p className="meta-form-hint">adopt 保持禁用，直到所选候选在基线—候选评估中胜出，并明确记录 `independentReviewPassed=true`。</p>}
            {latestIndependentEvaluation && (!humanEvidence?.complete || !humanEvidenceMatchesSelection) && selectedExperiment.state !== "adopted" && <p className="meta-form-hint">adopt 保持禁用：请先读取与所选候选、活动版本和 activation lock 绑定的完整证据包。</p>}
            {decisionNote.trim().length > 0 && decisionNote.trim().length < 8 && <p className="meta-form-hint">决定说明至少需要 8 个字符。</p>}
          </section>
        </main> : <main className="meta-experiment-empty"><strong>选择一个实验</strong><p>先建立草稿，再生成候选并进行成对评估。</p></main>}
      </div>
    </section>
  </section>;
}
