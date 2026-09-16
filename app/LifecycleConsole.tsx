"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { managementFetch } from "./management-fetch";
import { postLifecycleMutation } from "./lifecycle-client";

import type {
  AdaptationContractRecord,
  BuildGateKind,
  ContentBuildRecord,
  ContentReleaseRecord,
  LifecycleSnapshot,
  ProjectExecutionState,
  ProjectPhase,
  RetrospectiveRecord,
  RuleCandidateRecord,
  SliceKind,
} from "./lifecycle-types";

const PHASES: Array<{ id: ProjectPhase; label: string; output: string }> = [
  { id: "pitch", label: "立项", output: "受众、承诺、范围、成功指标" },
  { id: "planning", label: "策划", output: "材料、结构、风险、制作路线" },
  { id: "production", label: "写作实现", output: "可运行的主线修订" },
  { id: "packaging", label: "表达包装", output: "标题、措辞、视觉、宣发物料" },
  { id: "release", label: "构建发行", output: "适配合同、构建工件、门禁、发行记录" },
  { id: "operate", label: "数据运营", output: "指标快照与解释口径" },
  { id: "retrospective", label: "复盘规则", output: "复盘、规则候选与回归入口" },
];

const EXECUTION_LABELS: Record<ProjectExecutionState, string> = {
  proposed: "待启动",
  active: "推进中",
  blocked: "受阻",
  paused: "暂停",
  completed: "已收束",
  cancelled: "已取消",
};

const SLICE_LABELS: Record<SliceKind, string> = {
  full: "完整版",
  demo: "Demo / 试玩版",
  excerpt: "切片 / 摘要版",
  promo: "广告演示 / 宣发版",
};

const STRICT_BUILD_TEXT_KEYS = [
  "packageId",
  "expectedCompositionId",
  "expectedCompositionSha256",
  "sliceId",
  "expectedSliceSha256",
  "publicationVersionId",
  "expectedPublicationRegistrationSha256",
  "coverRunId",
  "expectedCoverReceiptId",
  "expectedCoverReceiptSha256",
  "expectedCoverArtifactSha256",
  "expectedCoverProfileSha256",
] as const;

function strictBuildInput(value: string): Record<string, unknown> | null {
  if (!value.trim()) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const input = parsed as Record<string, unknown>;
    if (!Number.isSafeInteger(input.expectedBranchLockVersion)
      || Number(input.expectedBranchLockVersion) < 1
      || STRICT_BUILD_TEXT_KEYS.some((key) => typeof input[key] !== "string" || !String(input[key]).trim())) {
      return null;
    }
    for (const key of STRICT_BUILD_TEXT_KEYS.filter((item) => item.endsWith("Sha256"))) {
      if (!/^[a-f0-9]{64}$/.test(String(input[key]))) return null;
    }
    return input;
  } catch {
    return null;
  }
}

const EMPTY_SNAPSHOT = (articleId: string): LifecycleSnapshot => ({
  ok: false,
  storage: "unavailable",
  articleId,
  projects: [],
  platformTargets: [],
  adaptationContracts: [],
  builds: [],
  buildGates: [],
  releases: [],
  metricDefinitions: [],
  metricSnapshots: [],
  metricValues: [],
  retrospectives: [],
  ruleCandidates: [],
  events: [],
});

type LifecyclePanel = "project" | "ports" | "releases" | "analytics";

interface LifecycleConsoleProps {
  article: { id: string; title: string };
  branch?: { id: string; name: string; headRevisionId: string };
  workingCopy?: {
    baseRevisionId: string;
    title: string;
    bodySha256: string;
    dirty: boolean;
  };
  notify?: (message: string) => void;
  onOpenMaimaiFlow?: () => void;
  onOpenVideoFlow?: () => void;
}

function shortHash(value: string) {
  return value ? value.slice(0, 10) : "无摘要";
}

function splitLines(value: string) {
  return value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
}

function toIso(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

function dateTimeInput(offsetDays = 0) {
  const date = new Date(Date.now() + offsetDays * 86_400_000);
  const shifted = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return shifted.toISOString().slice(0, 16);
}

function latestGate(snapshot: LifecycleSnapshot, buildId: string, kind: BuildGateKind) {
  return snapshot.buildGates.find((gate) => gate.buildId === buildId && gate.gateKind === kind);
}

function phaseNeighbor(phase: ProjectPhase, direction: -1 | 1) {
  const index = PHASES.findIndex((item) => item.id === phase);
  return PHASES[index + direction]?.id;
}

export default function LifecycleConsole({ article, branch, workingCopy, notify, onOpenMaimaiFlow, onOpenVideoFlow }: LifecycleConsoleProps) {
  const [snapshot, setSnapshot] = useState<LifecycleSnapshot>(() => EMPTY_SNAPSHOT(article.id));
  const [loadState, setLoadState] = useState<"loading" | "ready" | "unavailable">("loading");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [panel, setPanel] = useState<LifecyclePanel>("project");
  const [projectTitle, setProjectTitle] = useState(article.title);
  const [projectIntent, setProjectIntent] = useState("");
  const [projectOwner, setProjectOwner] = useState("我");
  const [transitionNote, setTransitionNote] = useState("进入下一制作阶段");
  const [targetProfileId, setTargetProfileId] = useState("");
  const [sliceKind, setSliceKind] = useState<SliceKind>("full");
  const [contractTitle, setContractTitle] = useState("");
  const [invariantText, setInvariantText] = useState("核心论点、事实边界、证据含义与作者责任不变");
  const [adaptationRules, setAdaptationRules] = useState("允许重写标题、导语、段落节奏和平台引导；删减必须记录理由");
  const [customTargetOpen, setCustomTargetOpen] = useState(false);
  const [customPlatform, setCustomPlatform] = useState("custom");
  const [customTargetLabel, setCustomTargetLabel] = useState("");
  const [customProfileKey, setCustomProfileKey] = useState("");
  const [customTargetVersion, setCustomTargetVersion] = useState("manual-1.0.0");
  const [selectedBuildId, setSelectedBuildId] = useState("");
  const [artifactRef, setArtifactRef] = useState("");
  const [artifactSha256, setArtifactSha256] = useState("");
  const [artifactMediaType, setArtifactMediaType] = useState("text/markdown");
  const [buildFailureSummary, setBuildFailureSummary] = useState("");
  const [strictBuildInputJson, setStrictBuildInputJson] = useState("");
  const [gateEvidence, setGateEvidence] = useState("");
  const [selectedReleaseId, setSelectedReleaseId] = useState("");
  const [releaseNote, setReleaseNote] = useState("");
  const [releaseEvidence, setReleaseEvidence] = useState("");
  const [remoteRecordId, setRemoteRecordId] = useState("");
  const [releaseUrl, setReleaseUrl] = useState("");
  const [metricReleaseId, setMetricReleaseId] = useState("");
  const [metricSource, setMetricSource] = useState("平台后台手工抄录");
  const [metricEvidence, setMetricEvidence] = useState("");
  const [windowStart, setWindowStart] = useState(() => dateTimeInput(-7));
  const [windowEnd, setWindowEnd] = useState(() => dateTimeInput(-1));
  const [capturedAt, setCapturedAt] = useState(() => dateTimeInput(0));
  const [metricViews, setMetricViews] = useState("");
  const [metricReads, setMetricReads] = useState("");
  const [metricCompletion, setMetricCompletion] = useState("");
  const [metricSaves, setMetricSaves] = useState("");
  const [metricComments, setMetricComments] = useState("");
  const [retroReleaseId, setRetroReleaseId] = useState("");
  const [retroTitle, setRetroTitle] = useState("");
  const [retroSummary, setRetroSummary] = useState("");
  const [retroEvidence, setRetroEvidence] = useState("");
  const [editingRetroId, setEditingRetroId] = useState("");
  const [ruleRetroId, setRuleRetroId] = useState("");
  const [ruleTitle, setRuleTitle] = useState("");
  const [ruleText, setRuleText] = useState("");
  const [ruleScope, setRuleScope] = useState("");
  const [ruleCounterexamples, setRuleCounterexamples] = useState("");
  const [ruleImplementation, setRuleImplementation] = useState("");
  const [ruleRegression, setRuleRegression] = useState("");
  const [ruleEvidence, setRuleEvidence] = useState("");
  const [editingRuleId, setEditingRuleId] = useState("");

  const project = snapshot.projects[0];
  const activeTargets = snapshot.platformTargets.filter((target) => target.status === "active" && target.profile.enabled !== false);
  const selectedBuild = snapshot.builds.find((build) => build.id === selectedBuildId) ?? snapshot.builds[0];
  const selectedRelease = snapshot.releases.find((release) => release.id === selectedReleaseId) ?? snapshot.releases[0];
  const selectedBuildTarget = selectedBuild ? snapshot.platformTargets.find((target) => target.id === selectedBuild.targetProfileId) : undefined;
  const selectedReleaseTarget = selectedRelease ? snapshot.platformTargets.find((target) => target.id === selectedRelease.targetProfileId) : undefined;
  const selectedBuildIsMaimai = selectedBuildTarget?.platform === "maimai";
  const selectedReleaseIsMaimai = selectedReleaseTarget?.platform === "maimai";
  const selectedBuildIsVideo = selectedBuildTarget?.profileKey.endsWith(".video") && selectedBuildTarget.profile.mediaKind === "video";
  const selectedReleaseIsVideo = selectedReleaseTarget?.profileKey.endsWith(".video") && selectedReleaseTarget.profile.mediaKind === "video";
  const cleanBaseline = Boolean(branch && workingCopy && !workingCopy.dirty
    && branch.headRevisionId === workingCopy.baseRevisionId);
  const strictBuildPayload = useMemo(() => strictBuildInput(strictBuildInputJson), [strictBuildInputJson]);
  const releaseEvidenceReady = splitLines(releaseEvidence).length > 0;
  const releaseNoteReady = releaseNote.trim().length > 0;
  const metricValuesReady = [metricViews, metricReads, metricCompletion, metricSaves, metricComments]
    .some((value) => value.trim() !== "" && Number.isFinite(Number(value)));

  const load = useCallback(async () => {
    setLoadState("loading");
    try {
      const response = await managementFetch(`/api/lifecycle?articleId=${encodeURIComponent(article.id)}`, { cache: "no-store" });
      const payload = await response.json() as LifecycleSnapshot;
      if (!response.ok) throw new Error(payload.error || "生命周期数据不可用");
      setSnapshot(payload);
      const loadedProject = payload.projects[0];
      if (loadedProject) {
        setProjectTitle(loadedProject.title);
        setProjectIntent(loadedProject.intent);
        setProjectOwner(loadedProject.owner);
      }
      const activeTarget = payload.platformTargets.find((target) => target.status === "active");
      setTargetProfileId((current) => payload.platformTargets.some((target) => target.id === current && target.status === "active")
        ? current : activeTarget?.id ?? "");
      setSelectedBuildId((current) => payload.builds.some((build) => build.id === current) ? current : payload.builds[0]?.id ?? "");
      setSelectedReleaseId((current) => payload.releases.some((release) => release.id === current) ? current : payload.releases[0]?.id ?? "");
      setMetricReleaseId((current) => payload.releases.some((release) => release.id === current) ? current : payload.releases[0]?.id ?? "");
      setRetroReleaseId((current) => payload.releases.some((release) => release.id === current) ? current : payload.releases[0]?.id ?? "");
      const eligibleRetro = payload.retrospectives.find((item) => ["reviewed", "closed"].includes(item.status));
      setRuleRetroId((current) => payload.retrospectives.some((retro) => retro.id === current && ["reviewed", "closed"].includes(retro.status))
        ? current : eligibleRetro?.id ?? "");
      setLoadState("ready");
    } catch (cause) {
      setSnapshot(EMPTY_SNAPSHOT(article.id));
      setLoadState("unavailable");
      setError(cause instanceof Error ? cause.message : "生命周期数据不可用");
    }
  }, [article.id]);

  const post = useCallback(async (action: string, payload: Record<string, unknown>, success: string) => {
    setBusy(action);
    setError("");
    try {
      const response = await postLifecycleMutation(action, payload);
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error || "操作失败");
      await load();
      notify?.(success);
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "操作失败");
      return false;
    } finally {
      setBusy("");
    }
  }, [load, notify]);

  useEffect(() => {
    const timer = window.setTimeout(() => { void load(); }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const counts = useMemo(() => ({
    targets: activeTargets.length,
    contracts: snapshot.adaptationContracts.filter((item) => item.status === "approved").length,
    builds: snapshot.builds.filter((item) => item.state === "built").length,
    publicReleases: snapshot.releases.filter((item) => item.publicState === "public_verified").length,
  }), [activeTargets.length, snapshot]);

  const createProject = () => post("create_project", {
    articleId: article.id,
    title: projectTitle,
    intent: projectIntent,
    owner: projectOwner,
  }, "文章项目已立项");

  const transitionPhase = (targetPhase: ProjectPhase) => project && post("transition_project_phase", {
    projectId: project.id,
    targetPhase,
    expectedLockVersion: project.lockVersion,
    note: transitionNote,
  }, `已进入${PHASES.find((item) => item.id === targetPhase)?.label ?? targetPhase}`);

  const transitionExecution = (targetState: ProjectExecutionState) => project && post("transition_project_execution", {
    projectId: project.id,
    targetState,
    expectedLockVersion: project.lockVersion,
    note: transitionNote,
  }, `项目执行状态已更新为${EXECUTION_LABELS[targetState]}`);

  const createContract = () => {
    if (!project || !branch || !workingCopy) return;
    void post("create_adaptation_contract", {
      projectId: project.id,
      targetProfileId,
      sourceRevisionId: workingCopy.baseRevisionId,
      sourceBodySha256: workingCopy.bodySha256,
      sliceKind,
      title: contractTitle || `${article.title} · ${SLICE_LABELS[sliceKind]}移植合同`,
      invariants: { mustPreserve: invariantText, acceptanceOwner: project.owner },
      rules: { adaptationRule: adaptationRules, branchId: branch.id },
    }, "适配合同草稿已冻结");
  };

  const approveContract = (contract: AdaptationContractRecord, targetState: "approved" | "cancelled" | "superseded") => post(
    "transition_adaptation_contract",
    {
      contractId: contract.id,
      targetState,
      expectedLockVersion: contract.lockVersion,
      note: transitionNote || (targetState === "approved" ? "人工审阅后批准" : "取消本次适配"),
    },
    targetState === "approved" ? "适配合同已批准" : targetState === "superseded" ? "适配合同已替代" : "适配合同已取消",
  );

  const createBuild = (contract: AdaptationContractRecord) => {
    if (!project || !branch || !workingCopy || !strictBuildPayload) {
      setError("请先粘贴由 publication_versions、slice 与封面终态回读共同形成的严格构建输入 JSON");
      return;
    }
    void post("create_build", {
      projectId: project.id,
      contractId: contract.id,
      packageId: strictBuildPayload.packageId,
      branchId: branch.id,
      expectedBranchLockVersion: strictBuildPayload.expectedBranchLockVersion,
      expectedRevisionId: workingCopy.baseRevisionId,
      expectedBodySha256: workingCopy.bodySha256,
      expectedCompositionId: strictBuildPayload.expectedCompositionId,
      expectedCompositionSha256: strictBuildPayload.expectedCompositionSha256,
      sliceId: strictBuildPayload.sliceId,
      expectedSliceSha256: strictBuildPayload.expectedSliceSha256,
      publicationVersionId: strictBuildPayload.publicationVersionId,
      expectedPublicationRegistrationSha256: strictBuildPayload.expectedPublicationRegistrationSha256,
      coverRunId: strictBuildPayload.coverRunId,
      expectedCoverReceiptId: strictBuildPayload.expectedCoverReceiptId,
      expectedCoverReceiptSha256: strictBuildPayload.expectedCoverReceiptSha256,
      expectedCoverArtifactSha256: strictBuildPayload.expectedCoverArtifactSha256,
      expectedCoverProfileSha256: strictBuildPayload.expectedCoverProfileSha256,
      expectedContractSha256: contract.contractSha256,
      expectedTargetProfileSha256: contract.targetProfileSha256,
    }, "构建输入已冻结；尚未登记制品");
  };

  const recordBuild = (build: ContentBuildRecord) => post("record_build_result", {
    buildId: build.id,
    targetState: "built",
    artifactRef,
    artifactSha256,
    artifactMediaType,
    artifactManifest: {
      recordMode: "manual",
      sourceRevisionId: build.revisionId,
      sliceKind: build.sliceKind,
      note: "系统只登记现有工件与摘要，不在本动作中生成文件。",
    },
  }, "构建工件已登记；兼容性与内容还原尚未检查");

  const recordGate = (build: ContentBuildRecord, gateKind: BuildGateKind, result: "pass" | "fail" | "inconclusive") => post(
    "record_build_gate",
    {
      buildId: build.id,
      gateKind,
      result,
      artifactSha256: build.artifactSha256,
      evidence: splitLines(gateEvidence),
      details: { assessmentMode: "manual", note: gateEvidence },
    },
    `${gateKind === "compatibility" ? "兼容性" : "内容还原"}门禁已记录为 ${result}`,
  );

  const releaseUpdate = (release: ContentReleaseRecord, operation: string, extra: Record<string, unknown>, success: string) => post(
    "update_release",
    { operation, releaseId: release.id, expectedLockVersion: release.lockVersion, ...extra },
    success,
  );

  const createMetric = () => {
    const rawInputs: Record<string, string> = {
      "raw.views": metricViews,
      "raw.reads": metricReads,
      "raw.completionRate": metricCompletion,
      "raw.saves": metricSaves,
      "raw.comments": metricComments,
    };
    const invalidInput = Object.entries(rawInputs).find(([key, input]) => {
      if (!input.trim()) return false;
      const value = Number(input);
      if (!Number.isFinite(value) || value < 0) return true;
      if (key === "raw.completionRate") return value > 1;
      return !Number.isSafeInteger(value);
    });
    if (invalidInput) {
      setError(`${invalidInput[0]} 不符合冻结定义：计数必须是非负整数，完成率必须在 0 到 1 之间`);
      return;
    }
    const measurements = snapshot.metricDefinitions
      .filter((definition) => definition.status === "active")
      .map((definition) => {
        const input = rawInputs[definition.definitionKey] ?? "";
        const observed = input.trim() !== "" && Number.isFinite(Number(input));
        return {
          definitionId: definition.id,
          definitionSha256: definition.definitionSha256,
          observationState: observed ? "observed" : "missing",
          value: observed ? Number(input) : null,
        };
      });
    void post("record_metric_snapshot", {
      releaseId: metricReleaseId,
      sourceMode: "manual",
      sourceLabel: metricSource,
      windowStart: toIso(windowStart),
      windowEnd: toIso(windowEnd),
      capturedAt: toIso(capturedAt),
      measurements,
      evidenceRef: metricEvidence,
    }, "不可变指标快照已记录");
  };

  const saveRetrospective = () => {
    if (!project) return;
    const editing = snapshot.retrospectives.find((item) => item.id === editingRetroId);
    const action = editing ? "update_retrospective" : "create_retrospective";
    const payload = editing ? {
      retrospectiveId: editing.id,
      expectedLockVersion: editing.lockVersion,
      title: retroTitle,
      summary: retroSummary,
      evidenceRefs: splitLines(retroEvidence),
    } : {
      projectId: project.id,
      releaseId: retroReleaseId || null,
      title: retroTitle,
      summary: retroSummary,
      evidenceRefs: splitLines(retroEvidence),
    };
    void post(action, payload, editing ? "复盘草稿已更新" : "复盘草稿已建立").then((ok) => {
      if (ok) setEditingRetroId("");
    });
  };

  const transitionRetrospective = (retro: RetrospectiveRecord, targetState: "reviewed" | "closed") => post(
    "transition_retrospective",
    { retrospectiveId: retro.id, targetState, expectedLockVersion: retro.lockVersion, note: transitionNote },
    targetState === "reviewed" ? "复盘已评审" : "复盘已关闭",
  );

  const saveRule = () => {
    const editing = snapshot.ruleCandidates.find((item) => item.id === editingRuleId);
    const fields = {
      title: ruleTitle,
      ruleText,
      scope: ruleScope,
      counterexamples: ruleCounterexamples,
      owner: project?.owner ?? "我",
      implementationTarget: ruleImplementation,
      regressionRef: ruleRegression,
      evidenceRefs: splitLines(ruleEvidence),
    };
    const action = editing ? "update_rule_candidate" : "create_rule_candidate";
    const payload = editing
      ? { ruleCandidateId: editing.id, expectedLockVersion: editing.lockVersion, ...fields }
      : { retrospectiveId: ruleRetroId, ...fields };
    void post(action, payload, editing ? "规则候选已更新" : "规则候选已建立；尚未 adopted").then((ok) => {
      if (ok) setEditingRuleId("");
    });
  };

  const transitionRule = (rule: RuleCandidateRecord, targetState: RuleCandidateRecord["state"]) => post(
    "transition_rule_candidate",
    { ruleCandidateId: rule.id, targetState, expectedLockVersion: rule.lockVersion, note: transitionNote },
    `规则候选已进入 ${targetState}`,
  );

  const renderProject = () => (
    <div className="lifecycle-columns">
      <section className="lifecycle-card project-brief">
        <header><div><span className="eyebrow">ArticleProject</span><h2>立项书与制作坐标</h2></div><em>{project ? `lock ${project.lockVersion}` : "未立项"}</em></header>
        <label>项目名<input value={projectTitle} onChange={(event) => setProjectTitle(event.target.value)} /></label>
        <label>价值承诺 / 为什么值得做<textarea value={projectIntent} onChange={(event) => setProjectIntent(event.target.value)} placeholder="目标读者、要解决的问题、读完后能带走什么、哪些内容不做" /></label>
        <label>制作人 / Owner<input value={projectOwner} onChange={(event) => setProjectOwner(event.target.value)} /></label>
        {!project ? <button className="primary-button" disabled={busy !== "" || !projectTitle.trim()} onClick={createProject}>建立 ArticleProject</button> : <button disabled={busy !== ""} onClick={() => void post("update_project", { projectId: project.id, expectedLockVersion: project.lockVersion, title: projectTitle, intent: projectIntent, owner: projectOwner }, "立项书已保存")}>保存立项书</button>}
        <small>ArticleProject 是文章生产身份；它不是正文分支，也不是某个平台稿。</small>
      </section>
      <section className="lifecycle-card execution-control">
        <header><div><span className="eyebrow">双状态机</span><h2>阶段 ≠ 执行健康</h2></div><em>{project ? EXECUTION_LABELS[project.executionState] : "等待立项"}</em></header>
        <label>本次变化说明<input value={transitionNote} onChange={(event) => setTransitionNote(event.target.value)} /></label>
        {project && <>
          <div className="phase-actions"><button disabled={!phaseNeighbor(project.phase, -1) || busy !== ""} onClick={() => { const target = phaseNeighbor(project.phase, -1); if (target) void transitionPhase(target); }}>退回上一阶段</button><button className="primary-button" disabled={!phaseNeighbor(project.phase, 1) || busy !== ""} onClick={() => { const target = phaseNeighbor(project.phase, 1); if (target) void transitionPhase(target); }}>推进下一阶段</button></div>
          <div className="execution-actions">
            {project.executionState === "proposed" && <button onClick={() => void transitionExecution("active")}>启动制作</button>}
            {project.executionState === "active" && <><button onClick={() => void transitionExecution("blocked")}>记录阻塞</button><button onClick={() => void transitionExecution("paused")}>暂停</button></>}
            {["blocked", "paused", "completed"].includes(project.executionState) && <button onClick={() => void transitionExecution("active")}>恢复推进</button>}
            {project.phase === "retrospective" && project.executionState === "active" && <button onClick={() => void transitionExecution("completed")}>收束项目</button>}
          </div>
        </>}
        <p className="boundary-note">推进阶段只改变制作坐标，不会自动生成稿件、Build、平台回执或公开页面。</p>
      </section>
    </div>
  );

  const renderPorts = () => (
    <div className="port-workspace">
      <section className="target-shelf lifecycle-card">
        <header><div><span className="eyebrow">PlatformTarget</span><h2>目标环境画像</h2></div><button onClick={() => setCustomTargetOpen((value) => !value)}>＋ 自定义平台</button></header>
        <div className="target-grid">{activeTargets.map((target) => <button key={target.id} className={targetProfileId === target.id ? "active" : ""} onClick={() => setTargetProfileId(target.id)}><span>{target.platform.slice(0, 2).toUpperCase()}</span><strong>{target.label}</strong><small>{target.version}</small><em>手工 · 未连接</em><code>{shortHash(target.profileSha256)}</code></button>)}</div>
        {customTargetOpen && <div className="inline-form target-form"><label>平台 key<input value={customPlatform} onChange={(event) => setCustomPlatform(event.target.value)} /></label><label>显示名<input value={customTargetLabel} onChange={(event) => setCustomTargetLabel(event.target.value)} /></label><label>Profile key<input value={customProfileKey} onChange={(event) => setCustomProfileKey(event.target.value)} placeholder="newsletter.article" /></label><label>版本<input value={customTargetVersion} onChange={(event) => setCustomTargetVersion(event.target.value)} /></label><button className="primary-button" onClick={() => void post("create_platform_target", { profileKey: customProfileKey, platform: customPlatform, label: customTargetLabel, version: customTargetVersion, profile: { deliveryMode: "manual", connectionStatus: "not_connected", note: "由内容所有者建立的人工目标画像" } }, "新平台画像已发布为活动版本")}>保存画像版本</button></div>}
        <p className="boundary-note">这里管理的是“移植目标和验收合同”。当前七个默认画像均为 manual / not_connected；页面不会因此获得平台账号或发布 API。</p>
      </section>
      <section className="lifecycle-card contract-composer">
        <header><div><span className="eyebrow">AdaptationContract</span><h2>冻结本次移植标准</h2></div><em>{cleanBaseline ? "干净修订可用" : "先提交干净修订"}</em></header>
        <div className="inline-form"><label>目标<select value={targetProfileId} onChange={(event) => setTargetProfileId(event.target.value)}>{activeTargets.map((target) => <option key={target.id} value={target.id}>{target.label} · {target.version}</option>)}</select></label><label>切片<select value={sliceKind} onChange={(event) => setSliceKind(event.target.value as SliceKind)}>{Object.entries(SLICE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label className="wide">合同标题<input value={contractTitle} onChange={(event) => setContractTitle(event.target.value)} placeholder={`${article.title} · 移植合同`} /></label><label className="wide">不可丢失的内容<textarea value={invariantText} onChange={(event) => setInvariantText(event.target.value)} /></label><label className="wide">允许的改写 / 省略<textarea value={adaptationRules} onChange={(event) => setAdaptationRules(event.target.value)} /></label><label className="wide">合同与构建状态说明<input value={transitionNote} onChange={(event) => setTransitionNote(event.target.value)} placeholder="批准、取消、替代或失败的原因与依据" /></label><button className="primary-button" disabled={!project || !targetProfileId || !cleanBaseline || busy !== ""} onClick={createContract}>建立合同草稿</button></div>
        <label className="wide">严格构建输入（粘贴当前回读 JSON）<textarea value={strictBuildInputJson} onChange={(event) => setStrictBuildInputJson(event.target.value)} placeholder='{"packageId":"…","expectedBranchLockVersion":1,"expectedCompositionId":"…","expectedCompositionSha256":"…","sliceId":"…","expectedSliceSha256":"…","publicationVersionId":"…","expectedPublicationRegistrationSha256":"…","coverRunId":"…","expectedCoverReceiptId":"…","expectedCoverReceiptSha256":"…","expectedCoverArtifactSha256":"…","expectedCoverProfileSha256":"78d99ac5bd44d5d55d8c91d0ec40cd8f42651eca4d0366765554358f4b12af74"}' /></label>
        <small>{strictBuildPayload ? "输入结构有效；服务端仍会在同批 SQL 中复核所有对象是否仍为当前版本。" : "输入必须来自当前 publication_versions、slice 与封面终态回读；旧四字段构建方式已停用。"}</small>
      </section>
      <section className="contract-build-board">
        {snapshot.adaptationContracts.map((contract) => {
          const target = snapshot.platformTargets.find((item) => item.id === contract.targetProfileId);
          const contractBuilds = snapshot.builds.filter((build) => build.adaptationContractId === contract.id);
          return <article key={contract.id} className={`contract-card ${contract.status}`}><header><div><span>{target?.label ?? "未知目标"} · {SLICE_LABELS[contract.sliceKind]}</span><strong>{contract.title}</strong></div><em>{contract.status}</em></header><dl><div><dt>源修订</dt><dd>{shortHash(contract.sourceRevisionId)}</dd></div><div><dt>正文</dt><dd>{shortHash(contract.sourceBodySha256)}</dd></div><div><dt>画像</dt><dd>{shortHash(contract.targetProfileSha256)}</dd></div><div><dt>合同</dt><dd>{shortHash(contract.contractSha256)}</dd></div></dl><p>{String(contract.invariants.mustPreserve ?? "未记录内容不变量")}</p><div className="card-actions">{contract.status === "draft" && <><button className="primary-button" disabled={!transitionNote.trim()} onClick={() => void approveContract(contract, "approved")}>人工批准合同</button><button disabled={!transitionNote.trim()} onClick={() => void approveContract(contract, "cancelled")}>取消</button></>}{contract.status === "approved" && <><button className="primary-button" disabled={!cleanBaseline || !strictBuildPayload || project?.executionState !== "active"} onClick={() => createBuild(contract)}>冻结新构建工件</button><button disabled={!transitionNote.trim()} onClick={() => void approveContract(contract, "superseded")}>由新合同替代</button><button disabled={!transitionNote.trim()} onClick={() => void approveContract(contract, "cancelled")}>取消合同</button></>}</div>{contractBuilds.map((build) => <button key={build.id} className="build-chip" onClick={() => { setSelectedBuildId(build.id); setPanel("ports"); }}><span>{build.state}</span><strong>{SLICE_LABELS[build.sliceKind]}</strong><code>{shortHash(build.artifactSha256 || build.sourceBodySha256)}</code></button>)}</article>;
        })}
        {!snapshot.adaptationContracts.length && <div className="empty-factory"><strong>还没有移植合同</strong><p>先选择目标画像和切片类型，再把当前干净修订、内容不变量与允许改写规则冻结在一起。</p></div>}
      </section>
      {selectedBuild && <section className="lifecycle-card build-inspector">
        <header><div><span className="eyebrow">ContentBuild</span><h2>{SLICE_LABELS[selectedBuild.sliceKind]} · {selectedBuild.state}</h2></div><select value={selectedBuild.id} onChange={(event) => setSelectedBuildId(event.target.value)}>{snapshot.builds.map((build) => <option key={build.id} value={build.id}>{build.state} · {SLICE_LABELS[build.sliceKind]} · {shortHash(build.id)}</option>)}</select></header>
        <div className="build-coordinate"><span>REV {shortHash(selectedBuild.revisionId)}</span><span>BODY {shortHash(selectedBuild.sourceBodySha256)}</span><span>TARGET {shortHash(selectedBuild.targetProfileSha256)}</span><span>CONTRACT {shortHash(selectedBuild.contractSha256)}</span></div>
        {selectedBuild.state === "planned" && <div className="inline-form artifact-form"><label className="wide">工件路径 / 引用<input value={artifactRef} onChange={(event) => setArtifactRef(event.target.value)} placeholder="发布包、Markdown 或导出文件的本地引用" /></label><label className="wide">工件 SHA-256<input value={artifactSha256} onChange={(event) => setArtifactSha256(event.target.value.toLowerCase())} /></label><label>媒体类型<input value={artifactMediaType} onChange={(event) => setArtifactMediaType(event.target.value)} /></label><button className="primary-button" disabled={!artifactRef || !/^[a-f0-9]{64}$/.test(artifactSha256)} onClick={() => void recordBuild(selectedBuild)}>登记构建完成的制品</button><label className="wide">构建失败摘要<textarea value={buildFailureSummary} onChange={(event) => setBuildFailureSummary(event.target.value)} placeholder="无法生成目标工件时，记录失败原因与恢复入口" /></label><button disabled={!buildFailureSummary.trim()} onClick={() => void post("record_build_result", { buildId: selectedBuild.id, targetState: "failed", failureSummary: buildFailureSummary }, "构建失败已记录；没有生成制品")}>记录构建失败</button><small className="wide">这一步只登记已有工件；它不生成文件，也不代表在目标平台正常阅读。</small></div>}
        {selectedBuild.state === "built" && selectedBuildIsMaimai && <div className="maimai-advanced-redirect"><strong>脉脉构建工件使用专属发布流</strong><p>真实编辑器计数器、图片裁切、AI 声明、现场批准和独立公开核验不能用通用手工门禁代替。</p><button className="primary-button" onClick={onOpenMaimaiFlow}>打开脉脉发布流</button></div>}
        {selectedBuild.state === "built" && selectedBuildIsVideo && <div className="maimai-advanced-redirect"><strong>视频构建工件使用专属证据流</strong><p>上传 / 转码完成、封面、元数据、声明、单次提交和公开视频播放不能用通用手工门禁代替。</p><button className="primary-button" onClick={onOpenVideoFlow}>打开视频发布流</button></div>}
        {selectedBuild.state === "built" && !selectedBuildIsMaimai && !selectedBuildIsVideo && <div className="gate-dual"><label className="gate-evidence">本次检查证据（每行一条）<textarea value={gateEvidence} onChange={(event) => setGateEvidence(event.target.value)} /></label>{(["compatibility", "fidelity"] as BuildGateKind[]).map((kind) => { const latest = latestGate(snapshot, selectedBuild.id, kind); const evidenceMissing = splitLines(gateEvidence).length === 0; return <article key={kind} className={`port-gate ${latest?.result ?? "unknown"}`}><span>{kind === "compatibility" ? "目标兼容性" : "内容还原度"}</span><strong>{latest?.result ?? "尚未检查"}</strong><p>{kind === "compatibility" ? "能否正常导入、渲染、阅读和完成平台流程。" : "删改后是否仍履行核心论点、事实边界与证据含义。"}</p><div><button disabled={evidenceMissing} onClick={() => void recordGate(selectedBuild, kind, "pass")}>通过</button><button disabled={evidenceMissing} onClick={() => void recordGate(selectedBuild, kind, "inconclusive")}>证据不足</button><button disabled={evidenceMissing} onClick={() => void recordGate(selectedBuild, kind, "fail")}>失败</button></div></article>; })}<button className="primary-button release-from-build" disabled={latestGate(snapshot, selectedBuild.id, "compatibility")?.result !== "pass" || latestGate(snapshot, selectedBuild.id, "fidelity")?.result !== "pass"} onClick={() => void post("create_release", { buildId: selectedBuild.id }, "发行草稿已创建；尚未批准或提交")}>从通过双门禁的构建工件建立发行记录</button></div>}
        {selectedBuild.state !== "superseded" && <button className="build-supersede" disabled={!transitionNote.trim()} onClick={() => void post("supersede_build", { buildId: selectedBuild.id, note: transitionNote }, "构建工件已标记为被后续版本替代")}>标记构建工件已被替代</button>}
      </section>}
    </div>
  );

  const renderReleases = () => (
    <div className="release-workspace">
      <section className="claim-legend lifecycle-card"><span className="eyebrow">发行核验层级</span><h2>为当前发行记录分别登记每一层证据</h2><div><span>构建制品</span><i>→</i><span>人工批准</span><i>→</i><span>提交进行中</span><i>→</i><span>平台已接受提交</span><i>→</i><span>后台记录已核验</span><i>→</i><span>公开页面已核验</span></div><p>每一层只证明已经观察到的对象；缺少证据时不能跳层，当前 API 也不会代替你向平台补发请求。</p></section>
      <div className="release-list">{snapshot.releases.map((release) => { const build = snapshot.builds.find((item) => item.id === release.buildId); const target = snapshot.platformTargets.find((item) => item.id === release.targetProfileId); return <button key={release.id} className={selectedRelease?.id === release.id ? "active" : ""} onClick={() => setSelectedReleaseId(release.id)}><div><strong>{target?.label ?? "未知平台"} · {build ? SLICE_LABELS[build.sliceKind] : "构建工件"}</strong><code>{shortHash(release.buildArtifactSha256)}</code></div><span>{release.approvalState}</span><span>{release.readinessState}</span><span>{release.submissionState}</span><span>{release.destinationState}</span><span>{release.publicState}</span></button>; })}{!snapshot.releases.length && <div className="empty-factory"><strong>还没有发行记录</strong><p>构建工件的“目标兼容性”和“内容还原度”都通过后，才能建立发行草稿。</p></div>}</div>
      {selectedRelease && selectedReleaseIsMaimai && <section className="lifecycle-card maimai-advanced-redirect"><strong>这条脉脉发行记录需要在专属发布流中补证据</strong><p>请在可见编辑器、现场确认、同一远端 ID、作者后台和非作者公开页中逐项观察；通用控制台不提供这些按钮，避免绕过门禁。</p><div className="release-axes"><article><span>批准</span><strong>{selectedRelease.approvalState}</strong></article><article><span>平台接受</span><strong>{selectedRelease.submissionState}</strong></article><article><span>后台记录</span><strong>{selectedRelease.destinationState}</strong></article><article><span>公开页面</span><strong>{selectedRelease.publicState}</strong></article></div><button className="primary-button" onClick={onOpenMaimaiFlow}>打开脉脉发布流</button></section>}
      {selectedRelease && selectedReleaseIsVideo && <section className="lifecycle-card maimai-advanced-redirect"><strong>这条视频发行记录需要在专属发布流中补证据</strong><p>请逐项观察上传 / 转码、封面、声明、一次提交、作者后台和非作者公开播放；通用控制台不提供发布按钮，避免绕过门禁。</p><div className="release-axes"><article><span>批准</span><strong>{selectedRelease.approvalState}</strong></article><article><span>平台接受</span><strong>{selectedRelease.submissionState}</strong></article><article><span>后台记录</span><strong>{selectedRelease.destinationState}</strong></article><article><span>公开页面</span><strong>{selectedRelease.publicState}</strong></article></div><button className="primary-button" onClick={onOpenVideoFlow}>打开视频发布流</button></section>}
      {selectedRelease && !selectedReleaseIsMaimai && !selectedReleaseIsVideo && <section className="lifecycle-card release-control"><header><div><span className="eyebrow">发行记录控制</span><h2>{selectedRelease.lifecycleState} · 锁版本 {selectedRelease.lockVersion}</h2></div><code>{shortHash(selectedRelease.buildArtifactSha256)}</code></header><div className="release-axes"><article><span>批准</span><strong>{selectedRelease.approvalState}</strong></article><article><span>提交</span><strong>{selectedRelease.submissionState}</strong></article><article><span>后台</span><strong>{selectedRelease.destinationState}</strong></article><article><span>公开</span><strong>{selectedRelease.publicState}</strong></article></div><label>操作说明<input value={releaseNote} onChange={(event) => setReleaseNote(event.target.value)} placeholder="谁做了什么、依据是什么" /></label><label>证据（每行一条）<textarea value={releaseEvidence} onChange={(event) => setReleaseEvidence(event.target.value)} /></label><label>平台回执 / 远端记录 ID<input value={remoteRecordId} onChange={(event) => setRemoteRecordId(event.target.value)} /></label><label>后台或公开 URL<input value={releaseUrl} onChange={(event) => setReleaseUrl(event.target.value)} /></label><div className="release-actions">{selectedRelease.approvalState === "draft" && <><button className="primary-button" disabled={!releaseNoteReady} onClick={() => void releaseUpdate(selectedRelease, "decide_approval", { targetState: "approved", note: releaseNote }, "发行记录已人工批准；仍未提交")}>批准</button><button disabled={!releaseNoteReady} onClick={() => void releaseUpdate(selectedRelease, "decide_approval", { targetState: "rejected", note: releaseNote }, "发行记录已拒绝")}>拒绝</button></>}{selectedRelease.approvalState === "approved" && ["not_submitted", "submission_failed"].includes(selectedRelease.submissionState) && <button className="primary-button" disabled={!releaseNoteReady} onClick={() => void releaseUpdate(selectedRelease, "start_submission", { note: releaseNote }, "已记录人工提交开始；当前接口没有发送外部请求")}>开始人工提交</button>}{selectedRelease.submissionState === "submitting" && <><button className="primary-button" disabled={!releaseEvidenceReady || !remoteRecordId.trim()} onClick={() => void releaseUpdate(selectedRelease, "record_submission", { targetState: "submission_accepted", remoteRecordId, evidence: splitLines(releaseEvidence) }, "已记录平台接受回执")}>记录平台接受</button><button disabled={!releaseEvidenceReady} onClick={() => void releaseUpdate(selectedRelease, "record_submission", { targetState: "submission_failed", evidence: splitLines(releaseEvidence) }, "已记录提交失败")}>记录失败</button></>}{selectedRelease.submissionState === "submission_accepted" && <><button disabled={!releaseEvidenceReady || !releaseUrl.trim()} onClick={() => void releaseUpdate(selectedRelease, "record_destination", { targetState: "backend_verified", destinationUrl: releaseUrl, evidence: splitLines(releaseEvidence) }, "后台记录已独立核验")}>后台已找到</button><button disabled={!releaseEvidenceReady} onClick={() => void releaseUpdate(selectedRelease, "record_destination", { targetState: "not_found", evidence: splitLines(releaseEvidence) }, "已记录后台未找到")}>后台未找到</button><button disabled={!releaseEvidenceReady} onClick={() => void releaseUpdate(selectedRelease, "record_destination", { targetState: "inconclusive", evidence: splitLines(releaseEvidence) }, "后台核验证据不足")}>后台证据不足</button><button disabled={!releaseEvidenceReady || !releaseUrl.trim()} onClick={() => void releaseUpdate(selectedRelease, "record_public", { targetState: "public_verified", publicUrl: releaseUrl, evidence: splitLines(releaseEvidence) }, "公开页面已独立核验")}>公开可见</button><button disabled={!releaseEvidenceReady} onClick={() => void releaseUpdate(selectedRelease, "record_public", { targetState: "not_public", evidence: splitLines(releaseEvidence) }, "已记录当前不公开")}>当前不公开</button><button disabled={!releaseEvidenceReady} onClick={() => void releaseUpdate(selectedRelease, "record_public", { targetState: "inconclusive", evidence: splitLines(releaseEvidence) }, "公开核验证据不足")}>公开证据不足</button></>}{selectedRelease.lifecycleState === "active" && <button disabled={!releaseNoteReady} onClick={() => void releaseUpdate(selectedRelease, "transition_lifecycle", { targetState: "withdrawn", note: releaseNote }, "发行记录已标记撤回")}>撤回记录</button>}</div><p className="boundary-note">“记录平台接受”只接受你提供的回执与证据；“后台核验”和“公开核验”是两项独立核验。</p></section>}
      {selectedRelease && !selectedReleaseIsMaimai && !selectedReleaseIsVideo && <section className="lifecycle-card release-readiness"><span className="eyebrow">独立提交就绪</span><h3>{selectedRelease.readinessState}</h3><p>{selectedRelease.readinessBlockers?.length ? `当前已失效：${selectedRelease.readinessBlockers.join("、")}` : "批准与提交就绪分离；尚未提交，当前接口没有发送外部请求。"}</p>{selectedRelease.approvalState === "approved" && selectedRelease.submissionState === "not_submitted" && <button className="primary-button" disabled={selectedRelease.readinessState === "blocked" || Boolean(selectedRelease.readinessBlockers?.length)} onClick={() => void releaseUpdate(selectedRelease, "mark_ready", {}, "Release 已标记 ready_to_submit；尚未提交，当前接口没有发送外部请求")}>标记提交就绪</button>}</section>}
    </div>
  );

  const renderAnalytics = () => (
    <div className="analytics-workspace">
      <section className="lifecycle-card metric-form"><header><div><span className="eyebrow">指标快照</span><h2>冻结一次指标观察</h2></div><em>{snapshot.metricSnapshots.length} 个快照</em></header><div className="metric-definition-strip">{snapshot.metricDefinitions.filter((definition) => definition.status === "active").map((definition) => <span key={definition.id}><strong>{definition.label}</strong><small>v{definition.version} · {definition.unit} · 缺失={definition.missingPolicy}</small></span>)}</div><div className="inline-form"><label>发行记录<select value={metricReleaseId} onChange={(event) => setMetricReleaseId(event.target.value)}>{snapshot.releases.filter((item) => item.submissionState === "submission_accepted").map((release) => <option key={release.id} value={release.id}>{shortHash(release.id)} · {release.publicState}</option>)}</select></label><label>来源<input value={metricSource} onChange={(event) => setMetricSource(event.target.value)} /></label><label>窗口开始<input type="datetime-local" value={windowStart} onChange={(event) => setWindowStart(event.target.value)} /></label><label>窗口结束<input type="datetime-local" value={windowEnd} onChange={(event) => setWindowEnd(event.target.value)} /></label><label>采集时间<input type="datetime-local" value={capturedAt} onChange={(event) => setCapturedAt(event.target.value)} /></label><label>曝光量<input type="number" min="0" step="1" value={metricViews} onChange={(event) => setMetricViews(event.target.value)} /></label><label>有效阅读量<input type="number" min="0" step="1" value={metricReads} onChange={(event) => setMetricReads(event.target.value)} /></label><label>完成率<input type="number" min="0" max="1" step="0.01" value={metricCompletion} onChange={(event) => setMetricCompletion(event.target.value)} /></label><label>收藏<input type="number" min="0" step="1" value={metricSaves} onChange={(event) => setMetricSaves(event.target.value)} /></label><label>评论<input type="number" min="0" step="1" value={metricComments} onChange={(event) => setMetricComments(event.target.value)} /></label><label className="wide">证据引用<input value={metricEvidence} onChange={(event) => setMetricEvidence(event.target.value)} placeholder="截图、导出文件或后台记录的本地引用" /></label><button className="primary-button" disabled={!metricReleaseId || !metricEvidence || !metricValuesReady || snapshot.metricDefinitions.filter((definition) => definition.status === "active").length === 0} onClick={createMetric}>记录不可变快照</button><small className="wide">空字段会按定义显式标记为缺失。这里冻结来源平台的原始值、单位、缺失策略和定义版本；不做跨平台归一化，也不声称不同平台同名指标可直接比较。</small></div></section>
      <section className="metric-timeline">{snapshot.metricSnapshots.map((metric) => {
        const typedValues = snapshot.metricValues.filter((value) => value.snapshotId === metric.id);
        return <article key={metric.id}><header><strong>{metric.sourceLabel}</strong><em>{metric.validationState}</em></header><div>{typedValues.length > 0 ? typedValues.map((value) => { const definition = snapshot.metricDefinitions.find((item) => item.id === value.definitionId); return <span key={value.id}><small>{definition?.label ?? value.definitionId} · {definition?.unit ?? "未知单位"}</small><b>{value.observationState === "observed" ? String(value.value) : value.observationState}</b></span>; }) : Object.entries(metric.metrics).map(([key, value]) => <span key={key}><small>{key} · 旧版未类型化</small><b>{String(value)}</b></span>)}</div><code>{metric.schemaState === "typed" ? `DEF ${shortHash(metric.definitionSetSha256 ?? "")}` : "LEGACY UNTYPED"} · DATA {shortHash(metric.measurementSha256)}</code>{metric.validationState !== "validated" && <div className="metric-actions"><button disabled={!transitionNote.trim() || metric.schemaState !== "typed"} onClick={() => void post("validate_metric_snapshot", { metricSnapshotId: metric.id, expectedState: metric.validationState, targetState: "validated", note: transitionNote }, "指标快照已由人工确认可用于本次复盘")}>确认用于本次复盘</button>{metric.validationState !== "inconclusive" && <button disabled={!transitionNote.trim() || metric.schemaState !== "typed"} onClick={() => void post("validate_metric_snapshot", { metricSnapshotId: metric.id, expectedState: metric.validationState, targetState: "inconclusive", note: transitionNote }, "指标快照已标为证据不足")}>证据不足</button>}</div>}</article>;
      })}</section>
      <section className="lifecycle-card retro-form"><header><div><span className="eyebrow">复盘记录</span><h2>{editingRetroId ? "编辑复盘草稿" : "从指标回到制作判断"}</h2></div><em>{project?.phase ?? "未立项"}</em></header><div className="inline-form"><label>关联发行记录<select value={retroReleaseId} disabled={Boolean(editingRetroId)} onChange={(event) => setRetroReleaseId(event.target.value)}><option value="">不限定发行记录</option>{snapshot.releases.map((release) => <option key={release.id} value={release.id}>{shortHash(release.id)}</option>)}</select></label><label className="wide">复盘标题<input value={retroTitle} onChange={(event) => setRetroTitle(event.target.value)} /></label><label className="wide">结论与反事实<textarea value={retroSummary} onChange={(event) => setRetroSummary(event.target.value)} placeholder="哪些判断得到支持，哪些没有；下一次会改什么；还缺什么证据" /></label><label className="wide">证据引用（每行一条）<textarea value={retroEvidence} onChange={(event) => setRetroEvidence(event.target.value)} /></label><label className="wide">评审 / 规则状态说明<input value={transitionNote} onChange={(event) => setTransitionNote(event.target.value)} placeholder="本次状态变化的判断、依据与下一步" /></label><button className="primary-button" disabled={!project || !["operate", "retrospective"].includes(project.phase) || !retroTitle.trim()} onClick={() => void saveRetrospective()}>{editingRetroId ? "保存复盘草稿" : "建立复盘草稿"}</button>{editingRetroId && <button onClick={() => setEditingRetroId("")}>取消编辑</button>}</div></section>
      <section className="retro-rule-grid">
        <div>{snapshot.retrospectives.map((retro) => <article key={retro.id} className="retro-card"><header><strong>{retro.title}</strong><em>{retro.status}</em></header><p>{retro.summary || "尚未填写总结"}</p><span>{retro.evidenceRefs.length} 条证据 · 锁版本 {retro.lockVersion}</span>{retro.status === "draft" && <div><button onClick={() => { setEditingRetroId(retro.id); setRetroReleaseId(retro.releaseId ?? ""); setRetroTitle(retro.title); setRetroSummary(retro.summary); setRetroEvidence(retro.evidenceRefs.join("\n")); }}>编辑草稿</button><button disabled={project?.phase !== "retrospective" || !retro.summary || retro.evidenceRefs.length === 0 || !transitionNote.trim()} onClick={() => void transitionRetrospective(retro, "reviewed")}>提交评审</button></div>}{retro.status === "reviewed" && <button disabled={project?.phase !== "retrospective" || !transitionNote.trim()} onClick={() => void transitionRetrospective(retro, "closed")}>关闭复盘</button>}</article>)}</div>
        <section className="lifecycle-card rule-form"><span className="eyebrow">RuleCandidate</span><h2>{editingRuleId ? "补齐规则证据合同" : "经验不能直接变成规则"}</h2><label>来源复盘<select value={ruleRetroId} disabled={Boolean(editingRuleId)} onChange={(event) => setRuleRetroId(event.target.value)}>{snapshot.retrospectives.filter((item) => ["reviewed", "closed"].includes(item.status)).map((retro) => <option key={retro.id} value={retro.id}>{retro.title}</option>)}</select></label><label>规则标题<input value={ruleTitle} onChange={(event) => setRuleTitle(event.target.value)} /></label><label>可执行规则<textarea value={ruleText} onChange={(event) => setRuleText(event.target.value)} /></label><label>适用范围<textarea value={ruleScope} onChange={(event) => setRuleScope(event.target.value)} /></label><label>反例 / 不适用<textarea value={ruleCounterexamples} onChange={(event) => setRuleCounterexamples(event.target.value)} /></label><label>实施位置<input value={ruleImplementation} onChange={(event) => setRuleImplementation(event.target.value)} placeholder="Skill、门禁、规范或工作流" /></label><label>回归入口<input value={ruleRegression} onChange={(event) => setRuleRegression(event.target.value)} /></label><label>规则证据（每行一条）<textarea value={ruleEvidence} onChange={(event) => setRuleEvidence(event.target.value)} /></label><button className="primary-button" disabled={!ruleRetroId || !ruleText.trim()} onClick={() => void saveRule()}>{editingRuleId ? "保存规则候选" : "建立 candidate"}</button>{editingRuleId && <button onClick={() => setEditingRuleId("")}>取消编辑</button>}</section>
      </section>
      <section className="rule-list">{snapshot.ruleCandidates.map((rule) => { const evidenceContractReady = Boolean(rule.scope && rule.counterexamples && rule.owner && rule.implementationTarget && rule.regressionRef && rule.evidenceRefs.length); const canEdit = !["adopted", "rejected"].includes(rule.state); return <article key={rule.id}><header><strong>{rule.title}</strong><em>{rule.state}</em></header><p>{rule.ruleText}</p><small>{rule.scope || "尚未限定范围"} · {rule.evidenceRefs.length} 条证据</small><div>{canEdit && <button onClick={() => { setEditingRuleId(rule.id); setRuleRetroId(rule.retrospectiveId); setRuleTitle(rule.title); setRuleText(rule.ruleText); setRuleScope(rule.scope); setRuleCounterexamples(rule.counterexamples); setRuleImplementation(rule.implementationTarget); setRuleRegression(rule.regressionRef); setRuleEvidence(rule.evidenceRefs.join("\n")); }}>编辑合同</button>}{["candidate", "deferred"].includes(rule.state) && <button disabled={!transitionNote.trim()} onClick={() => void transitionRule(rule, "testing")}>{rule.state === "deferred" ? "恢复测试" : "进入测试"}</button>}{rule.state === "testing" && <button disabled={!transitionNote.trim() || !evidenceContractReady} onClick={() => void transitionRule(rule, "verified")}>标记验证</button>}{rule.state === "verified" && <><button disabled={!transitionNote.trim() || !evidenceContractReady} onClick={() => void transitionRule(rule, "adopted")}>采用</button><button disabled={!transitionNote.trim()} onClick={() => void transitionRule(rule, "testing")}>退回测试</button></>}{["candidate", "testing", "verified"].includes(rule.state) && <button disabled={!transitionNote.trim()} onClick={() => void transitionRule(rule, "deferred")}>暂缓</button>}{canEdit && <button disabled={!transitionNote.trim()} onClick={() => void transitionRule(rule, "rejected")}>不采用</button>}</div></article>; })}</section>
    </div>
  );

  return (
    <div className="view-page lifecycle-page">
      <header className="page-heading lifecycle-heading"><div><span className="eyebrow">游戏制作式内容工厂</span><h1>一条内容主线，多种平台工件，逐层核验发行结果</h1><p>立项与制作阶段管理“为什么做、做到哪”；分支与修订管理正文；平台画像、适配合同和构建工件管理平台版本；发行记录、指标与复盘各自保留证据。</p></div><div className="lifecycle-health"><span className={loadState}>{loadState === "ready" ? "本地 D1 数据库已连接" : loadState === "loading" ? "正在恢复" : "不可用"}</span><strong>{project ? EXECUTION_LABELS[project.executionState] : "未立项"}</strong></div></header>
      {error && <div className="operation-error lifecycle-error"><span>{error}</span><button onClick={() => setError("")}>关闭</button></div>}
      <section className="phase-rail">{PHASES.map((phase, index) => { const currentIndex = project ? PHASES.findIndex((item) => item.id === project.phase) : -1; return <article key={phase.id} className={index === currentIndex ? "current" : index < currentIndex ? "done" : ""}><span>{String(index + 1).padStart(2, "0")}</span><div><strong>{phase.label}</strong><small>{phase.output}</small></div></article>; })}</section>
      <section className="producer-scoreboard"><article><span>平台目标</span><strong>{counts.targets}</strong><small>均为手工画像，未连接</small></article><article><span>已批准合同</span><strong>{counts.contracts}</strong><small>版本化移植标准</small></article><article><span>已登记制品</span><strong>{counts.builds}</strong><small>不等于双门禁通过</small></article><article><span>公开核验</span><strong>{counts.publicReleases}</strong><small>只计有独立证据的公开页面</small></article></section>
      <nav className="lifecycle-tabs" aria-label="内容生产分区"><button className={panel === "project" ? "active" : ""} onClick={() => setPanel("project")}>项目制作</button><button className={panel === "ports" ? "active" : ""} onClick={() => setPanel("ports")}>平台移植与构建</button><button className={panel === "releases" ? "active" : ""} onClick={() => setPanel("releases")}>发行证据</button><button className={panel === "analytics" ? "active" : ""} onClick={() => setPanel("analytics")}>数据与复盘</button></nav>
      {panel === "project" && renderProject()}
      {panel === "ports" && renderPorts()}
      {panel === "releases" && renderReleases()}
      {panel === "analytics" && renderAnalytics()}
      <footer className="lifecycle-boundary"><strong>当前实现边界</strong><p>系统已能管理 ArticleProject、平台画像、适配合同、Build、双轴门禁、分层 Release、指标快照、复盘和规则候选；当前没有平台凭据、自动提交连接器或自动拉数接口。手工登记必须绑定当前摘要与证据，未知外部结果不会被写成成功。</p></footer>
    </div>
  );
}
