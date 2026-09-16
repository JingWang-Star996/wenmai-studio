"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { managementFetch } from "./management-fetch";

const REQUIRED_PLATFORMS = ["xiaohongshu", "maimai", "zhihu", "bilibili"] as const;
const PLATFORM_LABELS: Record<string, string> = { xiaohongshu: "小红书", maimai: "脉脉", zhihu: "知乎", bilibili: "哔哩哔哩" };
const CONTRACT_SHA256 = "36df7d05245e629b1da423a2b8cedb64053444b92299990b70cba0a2532f621f";
const SHA256 = /^[a-f0-9]{64}$/;
const ACKNOWLEDGEMENT = "我已逐项核对本篇文章在小红书、脉脉、知乎、哔哩哔哩的本地准备证据、目标账号和工件摘要；我确认这只是四个平台的一次性发布授权申请，不代表平台已接受提交、后台记录、公开可见或实际效果，也不会在此页面点击发布。";

type Item = Record<string, unknown>;
type ControlData = { articleId: string; gates?: Item; releaseCandidates?: Item[]; readinessSnapshots?: Item[]; confirmations?: Item[]; confirmationItems?: Item[]; capabilities?: Item[]; leases?: Item[]; receiptHeads?: Item[]; freezes?: Item[]; readbacks?: Item[] };
type ControlResponse = { ok?: boolean; error?: string | { message?: string }; data?: ControlData };

function camel(key: string): string { return key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase()); }
function normalize(value: Item): Item { return Object.fromEntries(Object.entries(value).map(([key, item]) => [camel(key), Array.isArray(item) ? item.map((child) => child && typeof child === "object" ? normalize(child as Item) : child) : item && typeof item === "object" ? normalize(item as Item) : item])); }
function list(value: unknown): Item[] { return Array.isArray(value) ? value.filter((x): x is Item => Boolean(x) && typeof x === "object").map(normalize) : []; }
function text(value: unknown, fallback = "未提供"): string { return typeof value === "string" && value.trim() ? value : fallback; }
function idOf(item: Item): string { return text(item.readinessSnapshotId ?? item.snapshotId ?? item.id, ""); }
function snapshotSha(item: Item): string { return text(item.snapshotSha256 ?? item.readinessSnapshotSha256, "未提供"); }
function short(value: unknown): string { const raw = text(value); return raw.length > 18 ? `${raw.slice(0, 10)}…${raw.slice(-6)}` : raw; }
function time(value: unknown): string { const raw = text(value, ""); if (!raw) return "未提供"; const date = new Date(raw); return Number.isNaN(date.getTime()) ? raw : new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(date); }
function expired(item: Item): boolean { const value = item.expiresAt; return typeof value === "string" && !Number.isNaN(Date.parse(value)) && Date.parse(value) <= Date.now(); }
function errorText(value: ControlResponse["error"]): string { return typeof value === "string" ? value : value?.message || "发布授权状态不可用"; }
function commandId(): string { return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `release-control-ui-${Date.now()}-${Math.random().toString(16).slice(2)}`; }

export default function ReleaseControlV2Panel({ articleId }: { articleId: string }) {
  const [data, setData] = useState<ControlData | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState("");
  const [savingReleaseId, setSavingReleaseId] = useState("");
  const [drafts, setDrafts] = useState<Record<string, { targetAccount: string; prepareReceiptHeadSha256: string; domContractSha256: string }>>({});
  const [acknowledged, setAcknowledged] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const refresh = useCallback(async () => {
    setState("loading");
    try {
      const response = await managementFetch(`/api/release-control/v2?articleId=${encodeURIComponent(articleId)}`, { cache: "no-store" });
      const payload = await response.json() as ControlResponse;
      if (!response.ok || payload.ok !== true || !payload.data) throw new Error(errorText(payload.error));
      setData(payload.data); setState("ready"); setError("");
    } catch (caught) { setState("error"); setError(caught instanceof Error ? caught.message : "发布授权状态不可用"); }
  }, [articleId]);

  useEffect(() => { const timer = window.setTimeout(() => void refresh(), 0); return () => window.clearTimeout(timer); }, [refresh]);
  const snapshots = useMemo(() => list(data?.readinessSnapshots), [data]);
  const releases = useMemo(() => list(data?.releaseCandidates), [data]);
  const confirmable = useMemo(() => {
    const ready = snapshots.filter((snapshot) => snapshot.state === "ready_to_submit" && !expired(snapshot));
    if (ready.length !== 4) return null;
    const platforms = ready.map((snapshot) => text(snapshot.platform, ""));
    return REQUIRED_PLATFORMS.every((platform) => platforms.filter((value) => value === platform).length === 1) && platforms.every((platform) => REQUIRED_PLATFORMS.includes(platform as typeof REQUIRED_PLATFORMS[number])) ? [...ready].sort((a, b) => text(a.platform).localeCompare(text(b.platform))) : null;
  }, [snapshots]);

  const post = useCallback(async (action: "readiness.record" | "confirmation.create", payload: Item) => {
    const response = await managementFetch("/api/release-control/v2", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action, commandId: commandId(), payload }) });
    const result = await response.json() as ControlResponse;
    if (!response.ok || result.ok !== true) throw new Error(errorText(result.error));
    await refresh();
  }, [refresh]);

  const recordReadiness = useCallback(async (release: Item) => {
    const releaseId = text(release.releaseId, ""); const draft = drafts[releaseId] ?? { targetAccount: "", prepareReceiptHeadSha256: "", domContractSha256: "" };
    if (!draft.targetAccount.trim() || !SHA256.test(draft.prepareReceiptHeadSha256) || !SHA256.test(draft.domContractSha256)) { setError("请填写目标账号，并输入两项完整的 64 位小写 SHA-256 摘要。"); return; }
    setSavingReleaseId(releaseId); setError("");
    try { await post("readiness.record", { releaseId, targetAccount: draft.targetAccount.trim(), prepareReceiptHeadSha256: draft.prepareReceiptHeadSha256, domContractSha256: draft.domContractSha256 }); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "记录本地准备证据失败；未自动重试。"); } finally { setSavingReleaseId(""); }
  }, [drafts, post]);

  const createConfirmation = useCallback(async () => {
    if (!confirmable || !acknowledged) return;
    setConfirming(true); setError("");
    try { await post("confirmation.create", { articleId, decision: "publish_once_confirmed", acknowledgement: ACKNOWLEDGEMENT, readinessSnapshotIds: confirmable.map(idOf), contractSha256: CONTRACT_SHA256 }); setAcknowledged(false); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "创建一次性发布授权失败；未自动重试。"); } finally { setConfirming(false); }
  }, [acknowledged, articleId, confirmable, post]);

  if (state === "loading" && !data) return <section className="release-control-v2-panel" aria-busy="true">正在读取发布授权状态…</section>;
  const gates = data?.gates ?? {};
  return <section className="release-control-v2-panel" aria-labelledby="release-control-v2-title">
    <header><div><span className="eyebrow">Release Control V2</span><h2 id="release-control-v2-title">发布授权</h2></div><button type="button" onClick={() => void refresh()} disabled={state === "loading"}>{state === "loading" ? "读取中…" : "刷新状态"}</button></header>
    <div className="release-control-layers"><article><strong>本地准备</strong><span>登记构建、账号与准备回执摘要；不会提交平台。</span></article><article><strong>一次性授权</strong><span>仅在四个平台准备齐全后，由你主动确认。</span></article><article><strong>外部结果</strong><span>平台接受、后台、公开与效果仍需独立读回。</span></article></div>
    <p className="release-control-gates">控制面：{gates.controlPlaneEnabled === true ? "已启用" : "未启用"}；宿主路由：{gates.hostRouteVerified === true ? "已验收" : "未验收"}；外部发布执行：{gates.externalPublicationExecuted === true ? "接口报告已发生（仍需读回）" : "尚无执行记录"}。</p>
    {gates.browserPublishOnceHardBlocked === true && <p className="release-control-lock" role="status">本机发布宿主尚未验收，最终点击仍被锁定。</p>}
    <p className="boundary-note">确认或 capability_consumed 都不等于 submission_accepted、destination_record_verified、public_access_verified 或 outcome_verified。本页没有 capability consume、签发、DOM 点击或外部发布按钮。</p>
    {error && <p className="release-control-error" role="alert">{error}</p>}
    <section className="release-control-snapshots"><header><div><span className="eyebrow">当前文章发行与准备证据</span><h3>准备状态</h3></div><span>{releases.length} 条候选 · {snapshots.length} 份快照</span></header>
      {releases.map((release) => { const releaseId = text(release.releaseId, ""); const related = snapshots.filter((snapshot) => text(snapshot.releaseId, "") === releaseId); const latestSnapshot = related[0]; const draft = drafts[releaseId] ?? { targetAccount: "", prepareReceiptHeadSha256: "", domContractSha256: "" }; const hasReady = related.some((snapshot) => snapshot.state === "ready_to_submit" && !expired(snapshot)); const eligible = release.eligible === true; const blockers = Array.isArray(release.blockers) ? release.blockers.filter((item): item is string => typeof item === "string" && item.trim()) : []; return <article className="release-control-release" key={releaseId || `${text(release.buildId)}-${text(release.platform)}`}><div className="release-control-release-summary"><strong>{text(release.label, PLATFORM_LABELS[text(release.platform)] || text(release.platform))}</strong><span>release {short(release.releaseId)} · build {short(release.buildId)}</span><small>工件 {short(release.artifactSha256)} · readiness {text(release.readinessState)}</small>{latestSnapshot ? <><small>账号 {text(latestSnapshot.targetAccount)} · 快照 {short(snapshotSha(latestSnapshot))} · {latestSnapshot.state === "ready_to_submit" && !expired(latestSnapshot) ? "ready_to_submit" : "已过期或漂移"}</small><small>到期 {time(latestSnapshot.expiresAt)} · receipt head {short(latestSnapshot.prepareReceiptHeadSha256)}</small></> : <small>尚无准备快照。</small>}{!eligible && <small className="field-warning">当前不可记录：{blockers.length ? blockers.join("；") : "服务端未提供可写条件"}</small>}</div>
        {!hasReady && <details><summary>补充本地准备证据</summary><div className="release-control-form"><label>目标账号<input disabled={!eligible} aria-label={`${PLATFORM_LABELS[text(release.platform)] || "平台"}目标账号`} value={draft.targetAccount} onChange={(event) => setDrafts((current) => ({ ...current, [releaseId]: { ...draft, targetAccount: event.target.value } }))} /></label><label>准备回执头 SHA-256<input disabled={!eligible} aria-label="准备回执头 SHA-256" value={draft.prepareReceiptHeadSha256} onChange={(event) => setDrafts((current) => ({ ...current, [releaseId]: { ...draft, prepareReceiptHeadSha256: event.target.value.trim() } }))} /></label><label>DOM 合同 SHA-256<input disabled={!eligible} aria-label="DOM 合同 SHA-256" value={draft.domContractSha256} onChange={(event) => setDrafts((current) => ({ ...current, [releaseId]: { ...draft, domContractSha256: event.target.value.trim() } }))} /></label><button type="button" className="primary-button" disabled={!eligible || savingReleaseId === releaseId} onClick={() => void recordReadiness(release)}>{savingReleaseId === releaseId ? "正在记录…" : "记录本地准备证据"}</button><small>只登记本地准备证据，不提交平台。</small></div></details>}</article>; })}
      {!releases.length && <p>服务端未返回当前文章的发行候选；刷新只会重新读取，不会自动创建或提交。</p>}
    </section>
    {confirmable && <section className="release-control-confirmation"><span className="eyebrow">四平台集中确认</span><h3>确认前逐项核对</h3><p>四个平台各一条未过期 ready_to_submit 快照，且平台集合严格为小红书、脉脉、知乎、哔哩哔哩。</p><ul>{confirmable.map((snapshot) => <li key={idOf(snapshot)}><strong>{PLATFORM_LABELS[text(snapshot.platform)]}</strong><span>账号：{text(snapshot.targetAccount)}</span><span>工件：{short(snapshot.artifactSha256)}</span><span>快照：{short(snapshotSha(snapshot))}</span></li>)}</ul><label className="release-control-ack"><input type="checkbox" aria-label="确认四个平台的一次性发布授权说明" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} /><span>{ACKNOWLEDGEMENT}</span></label><button type="button" className="primary-button" disabled={!acknowledged || confirming} onClick={() => void createConfirmation()}>{confirming ? "正在创建确认…" : "确认本篇四个平台的一次性发布授权"}</button></section>}
    {!confirmable && <p className="boundary-note">集中确认区会在且仅在四个平台各有一条未过期 ready_to_submit 快照时显示；快照漂移或过期后不会自动重试或继续授权。</p>}
    <section className="release-control-readback"><span className="eyebrow">只读状态</span><h3>确认、能力、租约与回执读回</h3><p>确认 {list(data?.confirmations).length} 条；能力 {list(data?.capabilities).length} 条；租约 {list(data?.leases).length} 条；回执头 {list(data?.receiptHeads).length} 条；冻结 {list(data?.freezes).length} 条；外部读回 {list(data?.readbacks).length} 条。</p>{list(data?.confirmations).map((confirmation) => <article key={text(confirmation.confirmationId, JSON.stringify(confirmation))}><strong>确认 {short(confirmation.confirmationId)}</strong><span>到期：{time(confirmation.expiresAt)}</span><span>四项：{list(confirmation.items).length || list(data?.confirmationItems).filter((item) => text(item.confirmationId, "") === text(confirmation.confirmationId, "")).length}</span></article>)}{list(data?.capabilities).map((capability) => <article key={text(capability.id, JSON.stringify(capability))}><strong>能力 {short(capability.id)}</strong><span>状态：{text(capability.status)}</span><span>到期：{time(capability.expiresAt)}</span></article>)}{list(data?.leases).map((lease) => <article key={text(lease.id, JSON.stringify(lease))}><strong>租约 {short(lease.id)}</strong><span>状态：{text(lease.status)}</span><span>到期：{time(lease.expiresAt)}</span></article>)}{list(data?.receiptHeads).map((head) => <article key={text(head.receiptChainId, JSON.stringify(head))}><strong>回执链 {short(head.receiptChainId)}</strong><span>序号：{text(head.sequence)}</span><span>头摘要：{short(head.eventSha256)}</span></article>)}{list(data?.freezes).map((freeze) => <article key={text(freeze.releaseId, JSON.stringify(freeze))}><strong>冻结 release {short(freeze.releaseId)}</strong><span>状态：{text(freeze.status)}</span><span>原因：{text(freeze.reason)}</span></article>)}{list(data?.readbacks).map((readback) => <article key={text(readback.id, JSON.stringify(readback))}><strong>外部读回 {short(readback.id)}</strong><span>{text(readback.readbackKind)}：{text(readback.result)}</span><span>时间：{time(readback.observedAt)}</span></article>)}</section>
  </section>;
}
