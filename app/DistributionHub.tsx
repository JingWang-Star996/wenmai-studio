"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArticleQuickLink } from "./ArticlePreview";
import LifecycleConsole from "./LifecycleConsole";
import ModelRoutingPanel from "./ModelRoutingPanel";
import ReleaseControlV2Panel from "./ReleaseControlV2Panel";
import MaimaiReleaseFlow from "./MaimaiReleaseFlow";
import VideoReleaseFlow from "./VideoReleaseFlow";
import { platformCapabilitiesForTarget, platformTargetContentKind } from "./platform-capability-filter";
import type { CapabilityIndex } from "./workbench-types";
import type { ContentReleaseRecord, LifecycleSnapshot, PlatformTargetRecord } from "./lifecycle-types";
import { managementFetch } from "./management-fetch";
import { postLifecycleMutation } from "./lifecycle-client";

type HubPanel = "platforms" | "flow" | "authorization" | "routing" | "advanced";

const EMPTY_SNAPSHOT: LifecycleSnapshot = {
  ok: false,
  storage: "unavailable",
  articleId: "",
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
};

const CONNECTION_LABELS: Record<string, string> = {
  unknown: "未核对",
  not_connected: "未连接",
  needs_login: "需要登录",
  login_confirmed: "已人工确认登录",
};

const RULE_LABELS: Array<[string, string]> = [
  ["title", "标题规则"],
  ["intro", "简介 / 导语规则"],
  ["cover", "封面规则"],
  ["body", "正文与格式规则"],
  ["topics", "标签 / 话题规则"],
  ["disclosure", "声明与署名规则"],
];

type PlatformRuleDraft = { enabled: boolean; text: string };

function cleanObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function platformConstraintFacts(profileValue: unknown): Array<{ label: string; value: string }> {
  const profile = cleanObject(profileValue);
  const constraints = cleanObject(profile.constraints);
  const title = cleanObject(constraints.title);
  const body = cleanObject(constraints.body);
  const description = cleanObject(constraints.description);
  const images = cleanObject(constraints.images);
  const video = cleanObject(constraints.video);
  const cover = cleanObject(constraints.cover);
  const topics = cleanObject(constraints.topics);
  const aiAssistance = cleanObject(constraints.aiAssistance);
  const facts: Array<{ label: string; value: string }> = [];
  const unknown = (value: unknown) => cleanObject(value).status === "unknown";
  if (profile.mediaKind === "video") {
    facts.push({ label: "内容类型", value: "视频（与 article 画像独立）" });
    if (typeof video.maxDurationDisplay === "string") facts.push({ label: "视频时长", value: `最长 ${video.maxDurationDisplay}` });
    if (typeof video.maxFileSizeDisplay === "string") facts.push({ label: "文件大小", value: `最大 ${video.maxFileSizeDisplay}；字节换算 ${unknown(video.maxFileSizeBytes) ? "unknown" : "已冻结"}` });
    if (Array.isArray(video.recommendedContainers)) facts.push({ label: "推荐格式", value: video.recommendedContainers.join(" / ") });
    if (unknown(video.acceptedContainers)) facts.push({ label: "完整格式白名单", value: "unknown（本次页面未显示）" });
    const maxResolution = cleanObject(video.maxOutputResolution);
    if (typeof maxResolution.label === "string") facts.push({ label: "输出分辨率", value: `${maxResolution.label}${video.oversizedResolutionBehavior === "transcode_to_1080p" ? "；超出会转码到 1080P" : ""}` });
    else if (unknown(video.maxOutputResolution)) facts.push({ label: "输出分辨率", value: "unknown（本次页面未显示）" });
    if (Array.isArray(cover.cropRatios)) facts.push({ label: "封面比例", value: cover.cropRatios.join(" / ") });
    else if (unknown(cover.cropRatios)) facts.push({ label: "封面比例", value: "unknown（本次页面未显示）" });
    if (title.required === true) facts.push({ label: "标题", value: typeof title.maxCharacters === "number" ? `必填；最多 ${title.maxCharacters} 字符` : "必填；字数上限 unknown" });
    else if (typeof title.maxCharacters === "number") facts.push({ label: "标题", value: `最多 ${title.maxCharacters} 字符；是否必填 unknown` });
    if (description.required === true) facts.push({ label: "简介 / 介绍", value: typeof description.maxCharacters === "number" ? `必填；最多 ${description.maxCharacters} 字符` : "必填；字数上限 unknown" });
    else if (typeof description.maxCharacters === "number") facts.push({ label: "简介 / 正文", value: `最多 ${description.maxCharacters} 字符；是否必填 unknown` });
    if (unknown(topics.hardLimit)) facts.push({ label: "话题上限", value: "unknown（不从其他字段推断）" });
    return facts;
  }
  if (typeof title.maxCharacters === "number") {
    facts.push({ label: "标题", value: `${title.required === false ? "可选；" : ""}最多 ${title.maxCharacters} 字符` });
  }
  if (typeof body.maxCharacters === "number") {
    facts.push({ label: "正文上限", value: `${body.maxCharacters} 字符${body.includesInlineTopics === true ? "（含正文内 tag）" : ""}` });
  }
  if (typeof images.maxCount === "number") facts.push({ label: "图片数量", value: `最多 ${images.maxCount} 张` });
  if (images.placement === "bottom_attachments_only") {
    facts.push({ label: "图片位置", value: images.inlineSupported === false ? "仅正文底部附件；不支持内插图" : "正文底部附件" });
  }
  if (topics.placement === "inline_body") facts.push({ label: "tag", value: "直接写进正文" });
  if (aiAssistance.required === true) {
    const label = typeof aiAssistance.selectionLabel === "string" ? aiAssistance.selectionLabel : "AI 辅助声明";
    facts.push({ label: "创作声明", value: `必须选择“${label}”` });
  }
  return facts;
}

function readRuleDraft(value: unknown): PlatformRuleDraft {
  if (typeof value === "string") return { enabled: Boolean(value.trim()), text: value };
  const record = cleanObject(value);
  const text = typeof record.text === "string" ? record.text : "";
  return { enabled: record.enabled === true || (record.enabled !== false && Boolean(text.trim())), text };
}

function ruleIsActive(value: unknown) {
  const draft = readRuleDraft(value);
  return draft.enabled && Boolean(draft.text.trim());
}

function displayTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(date);
}

function versionStamp() {
  const date = new Date();
  const two = (value: number) => String(value).padStart(2, "0");
  return `manual-${date.getFullYear()}${two(date.getMonth() + 1)}${two(date.getDate())}-${two(date.getHours())}${two(date.getMinutes())}${two(date.getSeconds())}`;
}

function releaseStage(release: ContentReleaseRecord) {
  if (release.publicState === "public_verified") return "公开页面已核验";
  if (release.destinationState === "backend_verified") return "后台记录已核验";
  if (release.submissionState === "submission_accepted") return "平台已接受提交";
  if (release.submissionState === "submitting") return "提交中";
  if (release.approvalState === "approved") return "已批准待提交";
  if (release.approvalState === "rejected") return "已拒绝";
  return "发行草稿";
}

export default function DistributionHub({
  article,
  branch,
  workingCopy,
  capabilities,
  notify,
}: {
  article: { id: string; title: string };
  branch?: { id: string; name: string; headRevisionId: string };
  workingCopy?: { baseRevisionId: string; title: string; bodySha256: string; dirty: boolean };
  capabilities: CapabilityIndex;
  notify: (message: string) => void;
}) {
  const [panel, setPanel] = useState<HubPanel>("platforms");
  const [snapshot, setSnapshot] = useState<LifecycleSnapshot>({ ...EMPTY_SNAPSHOT, articleId: article.id });
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState("");
  const [selectedTargetId, setSelectedTargetId] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [connectionStatus, setConnectionStatus] = useState("unknown");
  const [loginEvidence, setLoginEvidence] = useState("");
  const [selectedSkillIds, setSelectedSkillIds] = useState<string[]>([]);
  const [rules, setRules] = useState<Record<string, PlatformRuleDraft>>({});
  const [skillQuery, setSkillQuery] = useState("");
  const [impactAcknowledged, setImpactAcknowledged] = useState(false);
  const [saving, setSaving] = useState(false);
  const [newPlatformOpen, setNewPlatformOpen] = useState(false);
  const [newPlatformError, setNewPlatformError] = useState("");
  const [newPlatformKey, setNewPlatformKey] = useState("");
  const [newPlatformLabel, setNewPlatformLabel] = useState("");
  const [newProfileKey, setNewProfileKey] = useState("");
  const [newPlatformVersion, setNewPlatformVersion] = useState(() => versionStamp());
  const newPlatformTriggerRef = useRef<HTMLButtonElement>(null);
  const newPlatformKeyRef = useRef<HTMLInputElement>(null);
  const newPlatformDialogRef = useRef<HTMLElement>(null);

  const closeNewPlatform = useCallback(() => {
    setNewPlatformOpen(false);
    setNewPlatformError("");
    window.requestAnimationFrame(() => newPlatformTriggerRef.current?.focus());
  }, []);

  useEffect(() => {
    if (!newPlatformOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeNewPlatform();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = Array.from(newPlatformDialogRef.current?.querySelectorAll<HTMLElement>("button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href]") ?? []);
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable.at(-1)!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    window.requestAnimationFrame(() => newPlatformKeyRef.current?.focus());
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [closeNewPlatform, newPlatformOpen]);

  const load = useCallback(async () => {
    try {
      const response = await managementFetch(`/api/lifecycle?articleId=${encodeURIComponent(article.id)}`, { cache: "no-store" });
      const payload = await response.json() as LifecycleSnapshot;
      if (!response.ok || !payload.ok) throw new Error(payload.error || "适配发行数据不可用");
      setSnapshot(payload);
      setState("ready");
      setError("");
    } catch (caught) {
      setState("error");
      setError(caught instanceof Error ? caught.message : "适配发行数据不可用");
    }
  }, [article.id]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const targets = useMemo(() => snapshot.platformTargets.filter((target) => target.status === "active"), [snapshot.platformTargets]);
  const selectedTarget = targets.find((target) => target.id === selectedTargetId) ?? targets[0];
  const selectedConstraintFacts = useMemo(() => platformConstraintFacts(selectedTarget?.profile), [selectedTarget]);
  const selectedProfile = useMemo(() => cleanObject(selectedTarget?.profile), [selectedTarget]);
  const selectedProfileNote = typeof selectedProfile.note === "string" ? selectedProfile.note.trim() : "";
  const selectedEvidenceRefs = strings(selectedProfile.evidenceRefs);

  useEffect(() => {
    if (!selectedTarget) return;
    const profile = cleanObject(selectedTarget.profile);
    const profileRules = cleanObject(profile.rules);
    const timer = window.setTimeout(() => {
      setSelectedTargetId(selectedTarget.id);
      setEnabled(profile.enabled !== false);
      setConnectionStatus(typeof profile.connectionStatus === "string" ? profile.connectionStatus : "unknown");
      setLoginEvidence(typeof profile.loginEvidence === "string" ? profile.loginEvidence : "");
      setSelectedSkillIds(strings(profile.skillIds));
      setRules(Object.fromEntries(RULE_LABELS.map(([key]) => [key, readRuleDraft(profileRules[key])])));
      setSkillQuery("");
      setImpactAcknowledged(false);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [selectedTarget]);

  const platformCapabilities = useMemo(() => {
    if (!selectedTarget) return { direct: [], generic: [] };
    return platformCapabilitiesForTarget(capabilities.capabilities, selectedTarget, selectedSkillIds, skillQuery);
  }, [capabilities.capabilities, selectedSkillIds, selectedTarget, skillQuery]);

  const selectedTargetImpact = useMemo(() => {
    if (!selectedTarget) return { contracts: 0, builds: 0, releases: 0, total: 0 };
    const contracts = snapshot.adaptationContracts.filter((contract) => contract.targetProfileId === selectedTarget.id).length;
    const builds = snapshot.builds.filter((build) => build.targetProfileId === selectedTarget.id).length;
    const releases = snapshot.releases.filter((release) => release.targetProfileId === selectedTarget.id).length;
    return { contracts, builds, releases, total: contracts + builds + releases };
  }, [selectedTarget, snapshot.adaptationContracts, snapshot.builds, snapshot.releases]);

  const post = useCallback(async (action: string, payload: Record<string, unknown>) => {
    const response = await postLifecycleMutation(action, payload);
    const result = await response.json() as { ok?: boolean; error?: string; platformTarget?: PlatformTargetRecord | null };
    if (!response.ok || result.ok === false) throw new Error(result.error || "平台画像保存失败");
    return result;
  }, []);

  const saveProfile = useCallback(async () => {
    if (!selectedTarget) return;
    if (selectedTargetImpact.total > 0 && !impactAcknowledged) {
      setError("请先确认版本影响：历史记录会保留，但后续发行必须用新画像重建适配合同与构建工件。");
      return;
    }
    setSaving(true);
    setError("");
    try {
      const result = await post("create_platform_target", {
        profileKey: selectedTarget.profileKey,
        platform: selectedTarget.platform,
        label: selectedTarget.label,
        version: versionStamp(),
        profile: {
          ...cleanObject(selectedTarget.profile),
          deliveryMode: "manual",
          enabled,
          connectionStatus,
          loginEvidence,
          skillIds: selectedSkillIds,
          rules,
          note: selectedProfileNote || "由内容所有者维护的本地平台画像；登录状态是人工记录，不代表 API 探针。",
        },
      });
      await load();
      if (result.platformTarget) setSelectedTargetId(result.platformTarget.id);
      notify("平台画像已保存为新版本；旧规则仍保留用于追溯");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "平台画像保存失败");
    } finally {
      setSaving(false);
    }
  }, [connectionStatus, enabled, impactAcknowledged, load, loginEvidence, notify, post, rules, selectedProfileNote, selectedSkillIds, selectedTarget, selectedTargetImpact.total]);

  const createPlatform = useCallback(async () => {
    if (!newPlatformKey.trim() || !newPlatformLabel.trim() || !newProfileKey.trim() || !newPlatformVersion.trim()) {
      setNewPlatformError("请补齐平台 key、显示名、Profile key 和版本。");
      return;
    }
    setSaving(true);
    setNewPlatformError("");
    try {
      const result = await post("create_platform_target", {
        profileKey: newProfileKey.trim(),
        platform: newPlatformKey.trim(),
        label: newPlatformLabel.trim(),
        version: newPlatformVersion.trim(),
        profile: {
          deliveryMode: "manual",
          enabled: true,
          connectionStatus: "not_connected",
          loginEvidence: "",
          skillIds: [],
          rules: {},
          note: "由内容所有者登记的新平台画像；尚未确认登录或连接。",
        },
      });
      await load();
      if (result.platformTarget) setSelectedTargetId(result.platformTarget.id);
      closeNewPlatform();
      setNewPlatformKey("");
      setNewPlatformLabel("");
      setNewProfileKey("");
      setNewPlatformVersion(versionStamp());
      notify("新平台已登记；请继续补充登录状态、Skill 与移植规则");
    } catch (caught) {
      setNewPlatformError(caught instanceof Error ? caught.message : "新平台登记失败");
    } finally {
      setSaving(false);
    }
  }, [closeNewPlatform, load, newPlatformKey, newPlatformLabel, newPlatformVersion, newProfileKey, notify, post]);

  const flowNodes = useMemo(() => {
    const latestGate = (buildId: string, kind: "compatibility" | "fidelity") => snapshot.buildGates.find((gate) => gate.buildId === buildId && gate.gateKind === kind);
    return [
      { id: "targets", label: "平台画像", count: targets.filter((target) => cleanObject(target.profile).enabled !== false).length, note: "可用于新移植的目标规则" },
      { id: "contracts", label: "适配合同", count: snapshot.adaptationContracts.filter((item) => item.status === "approved").length, note: "已绑定源修订和目标画像的标准" },
      { id: "builds", label: "构建工件", count: snapshot.builds.filter((item) => item.state === "built").length, note: "已登记摘要、可回溯的目标文件" },
      { id: "compatibility", label: "兼容检查", count: snapshot.builds.filter((build) => latestGate(build.id, "compatibility")?.result === "pass").length, note: "已有证据表明可在目标页导入、渲染和阅读" },
      { id: "fidelity", label: "还原检查", count: snapshot.builds.filter((build) => latestGate(build.id, "fidelity")?.result === "pass").length, note: "已有证据表明核心内容与事实边界仍在" },
      { id: "approval", label: "人工批准", count: snapshot.releases.filter((item) => item.approvalState === "approved").length, note: "已允许开始一次人工提交" },
      { id: "submission", label: "平台已接受提交", count: snapshot.releases.filter((item) => item.submissionState === "submission_accepted").length, note: "已保存平台明确接受的回执" },
      { id: "public", label: "公开页面已核验", count: snapshot.releases.filter((item) => item.publicState === "public_verified").length, note: "独立会话已打开同一公开对象" },
      { id: "metrics", label: "指标与复盘", count: snapshot.metricSnapshots.length + snapshot.retrospectives.filter((item) => item.status !== "draft").length, note: "已有指标快照或评审记录；不自动证明效果" },
    ];
  }, [snapshot, targets]);

  if (state === "loading") return <div className="distribution-loading">正在读取平台画像与发布流程…</div>;

  return <div className="view-page distribution-hub">
    <header className="page-heading"><div><span className="eyebrow">适配发行</span><h1>为当前内容选择平台画像，再逐层登记发布证据</h1><p>先核对目标平台的登录记录、规则和可用能力；每条发行记录再分别登记构建工件、门禁、批准、平台接受、后台记录、公开页面与效果证据。</p></div><div className="distribution-summary"><strong>{targets.length}</strong><span>个平台画像</span><i /> <strong>{snapshot.releases.length}</strong><span>条发行记录</span></div></header>
    {error && <div className="operation-error" role="alert"><span>{error}</span><button onClick={() => setError("")}>关闭</button></div>}
    <nav className="distribution-tabs" aria-label="适配发行分区"><button type="button" className={panel === "platforms" ? "active" : ""} onClick={() => setPanel("platforms")}>平台与规则</button><button type="button" className={panel === "flow" ? "active" : ""} onClick={() => setPanel("flow")}>发布流程检查</button><button type="button" className={panel === "authorization" ? "active" : ""} onClick={() => setPanel("authorization")}>发布授权</button><button type="button" className={panel === "routing" ? "active" : ""} onClick={() => setPanel("routing")}>模型路由</button><button type="button" className={panel === "advanced" ? "active" : ""} onClick={() => setPanel("advanced")}>高级构建记录</button></nav>

    {panel === "platforms" && <div className="platform-registry-layout">
      <section className="platform-registry"><header><div><span className="eyebrow">平台登记表</span><h2>当前内容可选的平台画像</h2></div><div className="platform-registry-actions"><span>登录状态仅是人工记录</span><button ref={newPlatformTriggerRef} onClick={() => { setNewPlatformError(""); setNewPlatformOpen(true); }}>＋ 登记平台</button></div></header><div className="platform-registry-list">{targets.map((target) => {
        const profile = cleanObject(target.profile);
        const targetRules = cleanObject(profile.rules);
        const skillIds = strings(profile.skillIds);
        const relatedContracts = snapshot.adaptationContracts.filter((contract) => contract.targetProfileId === target.id);
        const relatedBuilds = snapshot.builds.filter((build) => build.targetProfileId === target.id);
        return <button key={target.id} className={`${selectedTarget?.id === target.id ? "active" : ""} ${profile.enabled === false ? "disabled" : ""}`} onClick={() => setSelectedTargetId(target.id)}><div className="platform-monogram">{target.label.slice(0, 2)}</div><div><span><strong>{target.label}</strong><em>{profile.enabled === false ? "已停用" : "已启用"}</em></span><p>{CONNECTION_LABELS[String(profile.connectionStatus ?? "unknown")] ?? String(profile.connectionStatus)}</p><small>{skillIds.length} 个本地 Skill（能力包） · {Object.values(targetRules).filter(ruleIsActive).length} 组已启用规则 · {relatedContracts.length} 份合同 · {relatedBuilds.length} 个构建工件</small></div><code>{target.version}</code></button>;
      })}</div><p className="boundary-note">“已人工确认登录”只说明曾在指定浏览器和时间核对账号；它不证明 API 已连接，也不能替代本次提交后的后台记录或公开页面核验。</p></section>

      {selectedTarget && <aside className="platform-editor">
        <header><div><span className="eyebrow">编辑平台画像</span><h2>{selectedTarget.label}</h2></div><code>{selectedTarget.profileSha256.slice(0, 10)}</code></header>
        <div className="platform-toggle"><div><strong>允许用此画像创建新的发行记录</strong><span>停用只阻止新的合同、构建工件和发行记录；历史记录会保留，且不会删除已取得的证据。</span></div><button type="button" role="switch" aria-label={`在发行工作流中${enabled ? "停用" : "启用"}${selectedTarget.label}`} aria-checked={enabled} className={enabled ? "on" : ""} onClick={() => setEnabled((value) => !value)}><i /></button></div>
        <label>账号 / 连接状态<select value={connectionStatus} onChange={(event) => setConnectionStatus(event.target.value)}><option value="unknown">未核对</option><option value="not_connected">未连接</option><option value="needs_login">需要登录</option><option value="login_confirmed">已人工确认登录</option></select></label>
        <label>状态证据或备注<textarea value={loginEvidence} onChange={(event) => setLoginEvidence(event.target.value)} placeholder="例如：2026-08-17 在本机 Chrome 打开创作后台；仅为人工核对，不代表 API 已连接。" /></label>
        {connectionStatus === "login_confirmed" && !loginEvidence.trim() && <p className="field-warning">“已人工确认登录”必须补充核对时间与环境，保存时会由服务端复核。</p>}
        {selectedConstraintFacts.length > 0 && <section className="platform-constraint-summary"><span className="eyebrow">本次移植要遵守的约束</span><p>这些值来自当前画像摘要。提交前仍要读取真实发布页的计数器、裁切和设置；本地预检不能替代现场观察。</p><dl>{selectedConstraintFacts.map((fact) => <div key={fact.label}><dt>{fact.label}</dt><dd>{fact.value}</dd></div>)}</dl></section>}
        {platformTargetContentKind(selectedTarget) === "video" && (selectedProfileNote || selectedEvidenceRefs.length > 0) && <section className="platform-constraint-summary platform-evidence-summary"><span className="eyebrow">实测证据边界</span>{selectedProfileNote && <p>{selectedProfileNote}</p>}{selectedEvidenceRefs.length > 0 && <dl><div><dt>证据引用</dt><dd>{selectedEvidenceRefs.join(" · ")}</dd></div></dl>}</section>}
        <section className="platform-rule-editor"><span className="eyebrow">六类移植规则 · 逐条启停</span><p className="platform-rule-boundary">在这里说明当前平台要怎样改写、检查或保留内容。保存会创建新画像版本；不会运行自动检查、提交内容或证明适配已经完成。</p>{RULE_LABELS.map(([key, label]) => {
          const draft = rules[key] ?? { enabled: false, text: "" };
          return <div key={key} className={`platform-rule-card ${draft.enabled ? "enabled" : "disabled"}`}><header><strong>{label}</strong><button type="button" role="switch" aria-label={`${draft.enabled ? "停用" : "启用"}${label}`} aria-checked={draft.enabled} className={draft.enabled ? "on" : ""} onClick={() => setRules((current) => ({ ...current, [key]: { ...draft, enabled: !draft.enabled } }))}><i /></button></header><textarea disabled={!draft.enabled} value={draft.text} onChange={(event) => setRules((current) => ({ ...current, [key]: { ...draft, text: event.target.value } }))} placeholder={`记录${selectedTarget.label}的${label}；启用后作为当前平台标准。`} /><small>{draft.enabled ? (draft.text.trim() ? "已启用并会保存到平台画像" : "已启用，尚待补充标准") : "已停用；保留原文但不作为当前标准"}</small></div>;
        })}</section>
        <section className="platform-skill-picker"><span className="eyebrow">本地 Skill（能力包）</span><p>平台专用能力与通用发行能力分开显示；跨平台专用项和明显无关工具不会进入候选。可找到不代表已经验证。</p><label className="platform-skill-search"><span>搜索候选</span><input value={skillQuery} onChange={(event) => setSkillQuery(event.target.value)} placeholder="名称、用途、标签或 ID" /></label><div className="platform-skill-groups">{([
          { id: "direct", label: "平台直接命中", note: `名称或说明直接提到 ${selectedTarget.label}`, items: platformCapabilities.direct },
          { id: "generic", label: "通用发行能力", note: platformTargetContentKind(selectedTarget) === "video" ? "视频理解、取帧、转码、封面准备与视频发布" : "写作、中文审校、封面、排版、包装与发布", items: platformCapabilities.generic },
        ] as const).map((group) => <section key={group.id} className="platform-skill-group"><header><div><strong>{group.label}</strong><small>{group.note}</small></div><span>{group.items.length}</span></header><div>{group.items.map((capability) => <label key={capability.id} className={selectedSkillIds.includes(capability.id) ? "selected" : ""}><input type="checkbox" aria-label={`将 ${capability.name} 关联到 ${selectedTarget.label}`} checked={selectedSkillIds.includes(capability.id)} onChange={(event) => setSelectedSkillIds((current) => event.target.checked ? [...new Set([...current, capability.id])] : current.filter((id) => id !== capability.id))} /><span><strong>{capability.name}</strong><small>{capability.indexedAdoption} · {capability.availability}</small></span></label>)}{!group.items.length && <p>{skillQuery.trim() ? "这个分组没有匹配搜索的能力。" : "当前索引没有高相关候选。"}</p>}</div></section>)}</div></section>
        {selectedTargetImpact.total > 0 && <label className="profile-impact-confirm"><input type="checkbox" aria-label="确认平台画像版本影响" checked={impactAcknowledged} onChange={(event) => setImpactAcknowledged(event.target.checked)} /><span><strong>确认建立新画像版本</strong><small>旧版本绑定 {selectedTargetImpact.contracts} 份合同、{selectedTargetImpact.builds} 个构建工件、{selectedTargetImpact.releases} 条发行记录；历史仍可追溯，但新发行需重新建立合同与构建工件。</small></span></label>}
        <button className="primary-button platform-save" disabled={saving || (connectionStatus === "login_confirmed" && !loginEvidence.trim()) || (selectedTargetImpact.total > 0 && !impactAcknowledged)} onClick={() => void saveProfile()}>{saving ? "正在保存新版本…" : "保存平台画像新版本"}</button>
      </aside>}
    </div>}

    {newPlatformOpen && <div className="distribution-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) closeNewPlatform(); }}>
      <section ref={newPlatformDialogRef} className="distribution-dialog" role="dialog" aria-modal="true" aria-labelledby="new-platform-title">
        <header><div><span className="eyebrow">登记发行环境</span><h2 id="new-platform-title">先建立一个尚未连接的平台画像</h2></div><button aria-label="关闭" onClick={closeNewPlatform}>×</button></header>
        <p>登记不会登录平台，也不会授予发布权限。保存后再补充账号状态、平台规则和可用 Skill。</p>
        {newPlatformError && <div className="distribution-dialog-error" role="alert">{newPlatformError}</div>}
        <div>
          <label>平台 key<input ref={newPlatformKeyRef} value={newPlatformKey} onChange={(event) => setNewPlatformKey(event.target.value)} placeholder="例如 xiaohongshu" /></label>
          <label>显示名<input value={newPlatformLabel} onChange={(event) => setNewPlatformLabel(event.target.value)} placeholder="例如 小红书" /></label>
          <label>Profile key<input value={newProfileKey} onChange={(event) => setNewProfileKey(event.target.value)} placeholder="例如 xiaohongshu.long-article" /></label>
          <label>版本<input value={newPlatformVersion} onChange={(event) => setNewPlatformVersion(event.target.value)} /></label>
        </div>
        <footer><button onClick={closeNewPlatform}>取消</button><button className="primary-button" disabled={saving} onClick={() => void createPlatform()}>{saving ? "正在登记…" : "登记平台"}</button></footer>
      </section>
    </div>}

    {panel === "flow" && <div className="release-flow-view"><section className="release-flow-map" aria-label="发布证据分层图">{flowNodes.map((node, index) => <article key={node.id}><span>{String(index + 1).padStart(2, "0")}</span><strong>{node.label}</strong><em>{node.count}</em><p>{node.note}</p>{index < flowNodes.length - 1 && <i aria-hidden="true">→</i>}</article>)}</section><VideoReleaseFlow snapshot={snapshot} reload={load} notify={notify} openAdvanced={() => setPanel("advanced")} /><MaimaiReleaseFlow snapshot={snapshot} reload={load} notify={notify} openAdvanced={() => setPanel("advanced")} /><section className="release-checklist"><header><div><span className="eyebrow">发行证据路径</span><h2>查看每条发行记录缺哪一层证据</h2></div><span>{snapshot.releases.length} 条记录</span></header>{snapshot.releases.map((release) => {
        const target = snapshot.platformTargets.find((item) => item.id === release.targetProfileId);
        const build = snapshot.builds.find((item) => item.id === release.buildId);
        const stage = releaseStage(release);
        const axes = [release.approvalState, release.submissionState, release.destinationState, release.publicState];
        const laneAxes = [
          { label: "构建工件", reached: build?.state === "built" },
          { label: "批准", reached: release.approvalState === "approved" },
          { label: "平台接受", reached: release.submissionState === "submission_accepted" },
          { label: "后台记录", reached: release.destinationState === "backend_verified" },
          { label: "公开页面", reached: release.publicState === "public_verified" },
          { label: "效果数据", reached: snapshot.metricSnapshots.some((metric) => metric.releaseId === release.id) },
        ];
        return <article key={release.id} className="release-lane"><div className="release-lane-title"><span>{target?.label ?? "未找到冻结画像"}</span><ArticleQuickLink articleId={article.id}><strong>{build?.sourceTitle || article.title}</strong></ArticleQuickLink><small>{target ? `${target.version} · ${target.profileSha256.slice(0, 8)} · ` : ""}{build?.sliceKind ?? "build"} · {displayTime(release.updatedAt)}</small></div><div className="release-lane-track">{laneAxes.map((axis) => <span key={axis.label} className={axis.reached ? "reached" : ""}><i /><em>{axis.label}</em></span>)}</div><div className="release-lane-state"><strong>{stage}</strong><p>{axes.join(" · ")}</p>{release.publicUrl && <a href={release.publicUrl} target="_blank" rel="noreferrer">打开公开页面</a>}<button onClick={() => setPanel("advanced")}>处理记录</button></div></article>;
      })}{!snapshot.releases.length && <div className="release-empty"><strong>还没有发行记录</strong><p>先在高级模式中为当前文章建立项目、适配合同和通过双门禁的构建工件。流程图会自动汇总已有证据。</p><button className="primary-button" onClick={() => setPanel("advanced")}>开始第一次发行</button></div>}</section></div>}

    {panel === "routing" && <ModelRoutingPanel />}

    {panel === "authorization" && <ReleaseControlV2Panel articleId={article.id} />}

    {panel === "advanced" && <div className="advanced-lifecycle"><div className="advanced-context"><strong>高级模式</strong><p>这里保留项目、合同、构建工件、发行记录、指标和复盘的完整状态。日常查看优先使用“平台与规则”和“发布流程检查”。</p><button onClick={() => setPanel("flow")}>返回流程检查</button></div><LifecycleConsole key={article.id} article={article} branch={branch} workingCopy={workingCopy} onOpenMaimaiFlow={() => setPanel("flow")} onOpenVideoFlow={() => setPanel("flow")} notify={(message) => { notify(message); void load(); }} /></div>}
  </div>;
}
