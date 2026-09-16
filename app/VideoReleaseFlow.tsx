"use client";

import { useEffect, useMemo, useState } from "react";

import { postLifecycleMutation } from "./lifecycle-client";
import type { ContentReleaseRecord, LifecycleSnapshot } from "./lifecycle-types";
import {
  VIDEO_RELEASE_WORKFLOW,
  makeVideoGatePayloads,
  projectVideoReleaseFlows,
  validateVideoEditorObservation,
  type VideoEditorObservation,
} from "./video-release-workflow";

type Props = {
  snapshot: LifecycleSnapshot;
  reload: () => Promise<void>;
  notify: (message: string) => void;
  openAdvanced: () => void;
};

type CheckKey =
  | "editorVisible"
  | "uploadComplete"
  | "transcodeComplete"
  | "coverSaved"
  | "coverPreviewVisible"
  | "coverCropSafe"
  | "titlePresent"
  | "descriptionPresent"
  | "topicsReviewed"
  | "disclosuresReviewed"
  | "publishingSettingsReviewed"
  | "videoMarkSelected"
  | "originalVideoSettingReviewed"
  | "metadataMatchesFrozenBuild"
  | "previewPlaybackPass"
  | "contentFidelityPass";

const INITIAL_CHECKS: Record<CheckKey, boolean> = Object.fromEntries([
  "editorVisible", "uploadComplete", "transcodeComplete", "coverSaved", "coverPreviewVisible", "coverCropSafe",
  "titlePresent", "descriptionPresent", "topicsReviewed", "disclosuresReviewed", "publishingSettingsReviewed",
  "videoMarkSelected", "originalVideoSettingReviewed", "metadataMatchesFrozenBuild", "previewPlaybackPass", "contentFidelityPass",
].map((key) => [key, false])) as Record<CheckKey, boolean>;

function lines(value: string) {
  return [...new Set(value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean))];
}

function short(value: string) {
  return value ? value.slice(0, 10) : "—";
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function releaseUpdatePayload(release: ContentReleaseRecord, operation: string, extra: Record<string, unknown>) {
  return { operation, releaseId: release.id, expectedLockVersion: release.lockVersion, ...extra };
}

export default function VideoReleaseFlow({ snapshot, reload, notify, openAdvanced }: Props) {
  const flows = useMemo(() => projectVideoReleaseFlows(snapshot), [snapshot]);
  const [selectedBuildId, setSelectedBuildId] = useState("");
  const selected = flows.find((flow) => flow.build.id === selectedBuildId) ?? flows[0];
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [observedAt, setObservedAt] = useState(() => new Date().toISOString());
  const [editorUrl, setEditorUrl] = useState("");
  const [uploadProgress, setUploadProgress] = useState("100");
  const [coverSource, setCoverSource] = useState<VideoEditorObservation["coverSource"]>("uploaded_image");
  const [coverRatio, setCoverRatio] = useState("");
  const [titleCount, setTitleCount] = useState("");
  const [descriptionCount, setDescriptionCount] = useState("");
  const [checks, setChecks] = useState(INITIAL_CHECKS);
  const [compatibilityEvidence, setCompatibilityEvidence] = useState("");
  const [fidelityEvidence, setFidelityEvidence] = useState("");
  const [approvalNote, setApprovalNote] = useState("");
  const [approvalConfirmed, setApprovalConfirmed] = useState(false);
  const [submitNote, setSubmitNote] = useState("");
  const [actionConfirmed, setActionConfirmed] = useState(false);
  const [remoteRecordId, setRemoteRecordId] = useState("");
  const [submissionEvidence, setSubmissionEvidence] = useState("");
  const [oneSubmitObserved, setOneSubmitObserved] = useState(false);
  const [acceptanceObserved, setAcceptanceObserved] = useState(false);
  const [platformFailureObserved, setPlatformFailureObserved] = useState(false);
  const [destinationUrl, setDestinationUrl] = useState("");
  const [destinationEvidence, setDestinationEvidence] = useState("");
  const [backendStatus, setBackendStatus] = useState("");
  const [backendRecordObserved, setBackendRecordObserved] = useState(false);
  const [publicUrl, setPublicUrl] = useState("");
  const [publicEvidence, setPublicEvidence] = useState("");
  const [independentProbeObserved, setIndependentProbeObserved] = useState(false);
  const [playbackStartedObserved, setPlaybackStartedObserved] = useState(false);

  const resetExternalChecks = () => {
    setApprovalNote("");
    setApprovalConfirmed(false);
    setSubmitNote("");
    setActionConfirmed(false);
    setSubmissionEvidence("");
    setOneSubmitObserved(false);
    setAcceptanceObserved(false);
    setPlatformFailureObserved(false);
    setDestinationEvidence("");
    setBackendStatus("");
    setBackendRecordObserved(false);
    setPublicEvidence("");
    setIndependentProbeObserved(false);
    setPlaybackStartedObserved(false);
  };

  useEffect(() => {
    if (!selected) return;
    const profile = objectValue(selected.target.profile);
    const timer = window.setTimeout(() => {
      setSelectedBuildId(selected.build.id);
      setObservedAt(new Date().toISOString());
      setEditorUrl(typeof profile.uploadEntry === "string" ? profile.uploadEntry : "");
      setUploadProgress("100");
      setCoverSource("uploaded_image");
      setCoverRatio(selected.target.platform === "xiaohongshu" ? "3:4" : "unknown-observed-value-required");
      setTitleCount("");
      setDescriptionCount("");
      setChecks(INITIAL_CHECKS);
      setCompatibilityEvidence("");
      setFidelityEvidence("");
      setRemoteRecordId("");
      setDestinationUrl("");
      setPublicUrl("");
      resetExternalChecks();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [selected]);

  useEffect(() => {
    if (!selected?.release) return;
    const release = selected.release;
    const timer = window.setTimeout(() => {
      resetExternalChecks();
      setRemoteRecordId(release.remoteRecordId);
      setDestinationUrl(release.destinationUrl || "");
      setPublicUrl(release.publicUrl || "");
    }, 0);
    return () => window.clearTimeout(timer);
  }, [selected?.release]);

  const mutate = async (key: string, action: string, payload: Record<string, unknown>, message: string) => {
    setBusy(key);
    setError("");
    try {
      const response = await postLifecycleMutation(action, payload);
      const result = await response.json() as { ok?: boolean; error?: string };
      if (!response.ok || result.ok === false) throw new Error(result.error || "视频发布流记录失败");
      await reload();
      notify(message);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "视频发布流记录失败");
    } finally {
      setBusy("");
    }
  };

  if (!flows.length) {
    const hasTarget = snapshot.platformTargets.some((target) => ["xiaohongshu.video", "zhihu.video"].includes(target.profileKey));
    return <section className="maimai-flow maimai-flow-empty">
      <header><div><span className="eyebrow">视频发布流</span><h2>先为当前内容准备视频 Build</h2></div><code>{VIDEO_RELEASE_WORKFLOW.version}</code></header>
      <p>{hasTarget ? "视频画像已登记。请建立适配合同、冻结 Build 并登记已有视频工件摘要；这些操作不会向平台上传或提交。" : "当前没有可用的 xiaohongshu.video 或 zhihu.video 平台画像；需先登记目标规则，才能建立视频 Build。"}</p>
      <button className="primary-button" onClick={openAdvanced}>打开高级构建记录</button>
    </section>;
  }

  const flow = selected;
  const release = flow.release;
  const observation: VideoEditorObservation = {
    observedAt,
    editorUrl,
    editorVisible: checks.editorVisible,
    uploadProgressPercent: uploadProgress.trim() === "" ? null : Number(uploadProgress),
    uploadComplete: checks.uploadComplete,
    transcodeComplete: checks.transcodeComplete,
    coverSaved: checks.coverSaved,
    coverPreviewVisible: checks.coverPreviewVisible,
    coverCropSafe: checks.coverCropSafe,
    coverSource,
    coverRatio,
    titlePresent: checks.titlePresent,
    descriptionPresent: checks.descriptionPresent,
    titleCount: titleCount.trim() === "" ? null : Number(titleCount),
    descriptionCount: descriptionCount.trim() === "" ? null : Number(descriptionCount),
    topicsReviewed: checks.topicsReviewed,
    disclosuresReviewed: checks.disclosuresReviewed,
    publishingSettingsReviewed: checks.publishingSettingsReviewed,
    videoMarkSelected: checks.videoMarkSelected,
    originalVideoSettingReviewed: checks.originalVideoSettingReviewed,
    metadataMatchesFrozenBuild: checks.metadataMatchesFrozenBuild,
    previewPlaybackPass: checks.previewPlaybackPass,
    contentFidelityPass: checks.contentFidelityPass,
    compatibilityEvidence: lines(compatibilityEvidence),
    fidelityEvidence: lines(fidelityEvidence),
  };
  const validation = validateVideoEditorObservation(flow.target, flow.build, observation);
  const compatibilityPassed = flow.compatibilityGate?.result === "pass";
  const fidelityPassed = flow.fidelityGate?.result === "pass";
  const setCheck = (key: CheckKey, value: boolean) => setChecks((current) => ({ ...current, [key]: value }));

  const recordEditorGates = async () => {
    let payloads: ReturnType<typeof makeVideoGatePayloads>;
    try {
      payloads = makeVideoGatePayloads(flow.target, flow.build, observation);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "视频发布页证据不完整");
      return;
    }
    for (const payload of payloads) {
      const alreadyPassed = payload.gateKind === "compatibility" ? compatibilityPassed : fidelityPassed;
      if (!alreadyPassed) await mutate(`gate-${payload.gateKind}`, "record_build_gate", payload, `${payload.gateKind} 视频门禁已绑定当前 Build`);
    }
  };

  const workflowBinding = {
    workflowId: VIDEO_RELEASE_WORKFLOW.id,
    workflowVersion: VIDEO_RELEASE_WORKFLOW.version,
    confirmed: true,
    confirmedAt: new Date().toISOString(),
    authorityRole: "content_owner",
    releaseId: release?.id,
    buildId: flow.build.id,
    buildArtifactSha256: flow.build.artifactSha256,
    targetProfileSha256: flow.build.targetProfileSha256,
    contractSha256: flow.build.contractSha256,
    compatibilityGateId: flow.compatibilityGate?.id,
    fidelityGateId: flow.fidelityGate?.id,
  };

  const recordSubmission = (targetState: "submission_accepted" | "submission_failed") => {
    if (!release) return;
    const evidence = lines(submissionEvidence);
    void mutate("submission", "update_release", releaseUpdatePayload(release, "record_submission", {
      targetState,
      remoteRecordId: targetState === "submission_accepted" ? remoteRecordId : "",
      evidence,
      details: {
        workflowId: VIDEO_RELEASE_WORKFLOW.id,
        workflowVersion: VIDEO_RELEASE_WORKFLOW.version,
        externalSubmitPerformed: true,
        singleSubmitCount: 1,
        platformAcceptedObserved: targetState === "submission_accepted" && acceptanceObserved,
        platformFailureObserved: targetState === "submission_failed" && platformFailureObserved,
        failureObservedAt: targetState === "submission_failed" ? new Date().toISOString() : undefined,
        failureKind: targetState === "submission_failed" ? "visible_platform_error" : undefined,
        failureEvidenceRef: targetState === "submission_failed" ? evidence[0] : undefined,
      },
    }), targetState === "submission_accepted" ? "已记录平台接受提交；后台记录与公开页面仍需分别核验" : "已记录平台明确失败；结果不明时保留 submitting 并先做只读探测");
  };

  return <section className="maimai-flow video-release-flow" aria-busy={busy !== ""}>
    <header className="maimai-flow-heading"><div><span className="eyebrow">视频发布流 · {flow.target.label}</span><h2>为当前视频分别登记提交、后台记录、公开播放和效果证据</h2><p>文脉不会登录平台或点击发布。结果不明时保持当前状态，先只读探测后台记录与公开页，不会自动重试。</p></div><label>选择 Build<select value={flow.build.id} onChange={(event) => setSelectedBuildId(event.target.value)}>{flows.map((item) => <option key={item.build.id} value={item.build.id}>{item.target.label} · {item.build.sourceTitle || short(item.build.id)} · {item.release?.publicState ?? item.build.state}</option>)}</select></label></header>
    {error && <div className="operation-error" role="alert"><span>{error}</span><button onClick={() => setError("")}>关闭</button></div>}
    <div className="maimai-flow-binding"><span>BUILD <code>{short(flow.build.id)}</code></span><span>ARTIFACT <code>{short(flow.build.artifactSha256)}</code></span><span>TARGET <code>{short(flow.build.targetProfileSha256)}</code></span><span>CONTRACT <code>{short(flow.build.contractSha256)}</code></span></div>
    <div className="video-evidence-layers" aria-label="视频发布四层证据">{VIDEO_RELEASE_WORKFLOW.layers.map((layer, index) => <article key={layer.id}><span>0{index + 1}</span><strong>{layer.label}</strong><code>{layer.claim}</code><p>{layer.evidence}</p></article>)}</div>
    <div className="maimai-step-rail" role="list" aria-label="视频发布步骤">{flow.steps.map((step, index) => <article key={step.id} className={step.state} role="listitem" aria-current={step.state === "current" ? "step" : undefined}><span>{String(index + 1).padStart(2, "0")}</span><strong>{step.label}</strong><small>{step.evidence}</small><em>{step.state === "complete" ? "已完成" : step.state === "current" ? "当前" : step.state === "blocked" ? "已阻断" : "等待"}</em></article>)}</div>

    {!compatibilityPassed || !fidelityPassed ? <div className="maimai-stage-card">
       <header><div><span className="eyebrow">01 · 当前 Build 的上传页门禁</span><h3>核对上传、转码、封面和元数据，再记录可复查证据</h3></div><em>{flow.target.profileKey}</em></header>
       <p className="maimai-stage-boundary">页面未显示的硬限制保持 unknown；unknown 不是零限制，不能凭经验放行，也不能由本地预检替代现场页面。</p>
      <div className="maimai-editor-fields"><label className="wide">上传页 URL<input value={editorUrl} onChange={(event) => setEditorUrl(event.target.value)} /></label><label>观察时间<input value={observedAt} onChange={(event) => setObservedAt(event.target.value)} /></label><label>上传进度<input type="number" min="0" max="100" value={uploadProgress} onChange={(event) => setUploadProgress(event.target.value)} /></label><label>封面来源<select value={coverSource} onChange={(event) => setCoverSource(event.target.value as VideoEditorObservation["coverSource"])}><option value="uploaded_image">上传图片</option><option value="video_frame">视频帧</option><option value="platform_generated">平台生成</option></select></label><label>封面比例<input value={coverRatio} onChange={(event) => setCoverRatio(event.target.value)} /></label><label>标题可见计数<input type="number" min="0" value={titleCount} onChange={(event) => setTitleCount(event.target.value)} placeholder={flow.target.platform === "zhihu" ? "unknown / 可留空" : "0-20"} /></label><label>简介可见计数<input type="number" min="0" value={descriptionCount} onChange={(event) => setDescriptionCount(event.target.value)} placeholder={flow.target.platform === "zhihu" ? "unknown / 可留空" : "0-1000"} /></label></div>
      <div className="maimai-check-grid">{([
        ["editorVisible", "已看到登录后的真实视频发布页"], ["uploadComplete", "上传进度达到 100 且明确成功"], ["transcodeComplete", "平台转码 / 处理明确完成"],
        ["coverSaved", "封面已经保存"], ["coverPreviewVisible", "已看到封面预览"], ["coverCropSafe", "裁切未损坏关键信息"],
        ["titlePresent", "标题字段已按平台要求填写"], ["descriptionPresent", "简介 / 介绍已按平台要求填写"], ["topicsReviewed", "话题字段已核对或明确不适用"],
        ["disclosuresReviewed", "声明按内容事实核对"], ["publishingSettingsReviewed", "可见范围 / 定时 / 专栏等已核对"], ["videoMarkSelected", "知乎必填视频标记已选择（小红书不要求）"],
        ["originalVideoSettingReviewed", "原创视频 / 来源设置已核对"], ["metadataMatchesFrozenBuild", "封面与元数据匹配冻结 Build"], ["previewPlaybackPass", "提交前预览播放正常"], ["contentFidelityPass", "内容还原门禁通过"],
      ] as Array<[CheckKey, string]>).map(([key, label]) => <label key={key}><input type="checkbox" checked={checks[key]} onChange={(event) => setCheck(key, event.target.checked)} /><span>{label}</span></label>)}</div>
      <div className="maimai-evidence-grid"><label>上传 / 转码 / 封面证据（每行一条）<textarea value={compatibilityEvidence} onChange={(event) => setCompatibilityEvidence(event.target.value)} /></label><label>视频 / 元数据还原证据（每行一条）<textarea value={fidelityEvidence} onChange={(event) => setFidelityEvidence(event.target.value)} /></label></div>
      {!validation.ok && <ul className="maimai-validation-list">{validation.errors.map((item) => <li key={item}>{item}</li>)}</ul>}
      <button className="primary-button" disabled={!validation.ok || busy !== ""} onClick={() => void recordEditorGates()}>{busy.startsWith("gate-") ? "正在绑定门禁…" : "记录视频发布页双门禁"}</button>
    </div> : !release ? <div className="maimai-stage-card compact"><header><div><span className="eyebrow">02 · Release 草稿</span><h3>发布包门禁已通过</h3></div><em>未批准 · 未提交</em></header><p>建立草稿只冻结本地对象，不会向平台发送请求。</p><button className="primary-button" disabled={busy !== ""} onClick={() => void mutate("create-release", "create_release", { buildId: flow.build.id }, "视频 Release 草稿已创建；仍未批准或提交")}>建立 Release 草稿</button></div> : <>
      {release.approvalState === "draft" && <div className="maimai-stage-card compact"><header><div><span className="eyebrow">03 · 人工批准</span><h3>批准只绑定当前摘要与双门禁</h3></div><em>lock {release.lockVersion}</em></header><label>批准说明<input value={approvalNote} onChange={(event) => setApprovalNote(event.target.value)} /></label><label className="maimai-risk-confirm"><input type="checkbox" checked={approvalConfirmed} onChange={(event) => setApprovalConfirmed(event.target.checked)} /><span>我确认批准当前视频 Release；这一步仍不会提交平台。</span></label><button className="primary-button" disabled={!approvalConfirmed || !approvalNote.trim() || busy !== ""} onClick={() => void mutate("approve", "update_release", releaseUpdatePayload(release, "decide_approval", { targetState: "approved", note: approvalNote, approvalBinding: workflowBinding }), "视频 Release 已批准；仍未开始提交")}>批准当前 Release</button></div>}
      {release.approvalState === "approved" && ["not_submitted", "submission_failed"].includes(release.submissionState) && <div className="maimai-stage-card action-stop"><header><div><span className="eyebrow">04 · 单次提交停点</span><h3>下一步才允许一次外部提交</h3></div><em>文脉不点击</em></header><p>外部结果不明确时不得再次提交；先探测后台与公开页。明确失败后再次尝试也必须形成新的现场确认。</p><label>现场说明<input value={submitNote} onChange={(event) => setSubmitNote(event.target.value)} /></label><label className="maimai-risk-confirm"><input type="checkbox" checked={actionConfirmed} onChange={(event) => setActionConfirmed(event.target.checked)} /><span>只对当前 Release 的本次尝试授权一次外部“发布视频”提交。</span></label><button className="primary-button" disabled={!actionConfirmed || !submitNote.trim() || busy !== ""} onClick={() => void mutate("prepare-submit", "update_release", releaseUpdatePayload(release, "start_submission", { note: submitNote, actionConfirmation: { ...workflowBinding, singleExternalSubmitAuthorized: true, externalSubmitWillBePerformedSeparately: true } }), "已到外部单次提交停点；文脉没有发送平台请求")}>记录现场确认</button></div>}
      {release.submissionState === "submitting" && <div className="maimai-stage-card"><header><div><span className="eyebrow">05 · 平台接受</span><h3>只记录明确观察到的结果</h3></div><em>结果不明保持 submitting</em></header><div className="maimai-editor-fields"><label>远端视频 ID<input value={remoteRecordId} onChange={(event) => setRemoteRecordId(event.target.value)} /></label><label className="wide">提交证据（每行一条）<textarea value={submissionEvidence} onChange={(event) => setSubmissionEvidence(event.target.value)} /></label></div><div className="maimai-check-grid"><label><input type="checkbox" checked={oneSubmitObserved} onChange={(event) => setOneSubmitObserved(event.target.checked)} /><span>已确认只提交一次</span></label><label><input type="checkbox" checked={acceptanceObserved} onChange={(event) => setAcceptanceObserved(event.target.checked)} /><span>已看到平台明确接受信号</span></label><label><input type="checkbox" checked={platformFailureObserved} onChange={(event) => setPlatformFailureObserved(event.target.checked)} /><span>已看到平台明确错误 / 拒绝</span></label></div><div className="maimai-action-row"><button className="primary-button" disabled={!remoteRecordId.trim() || !lines(submissionEvidence).length || !oneSubmitObserved || !acceptanceObserved || busy !== ""} onClick={() => recordSubmission("submission_accepted")}>记录平台接受</button><button disabled={!lines(submissionEvidence).length || !oneSubmitObserved || !platformFailureObserved || busy !== ""} onClick={() => recordSubmission("submission_failed")}>记录明确失败</button><span>超时、跳转或猜测：不写结果，不重试。</span></div></div>}
      {release.submissionState === "submission_accepted" && release.destinationState !== "backend_verified" && <div className="maimai-stage-card compact"><header><div><span className="eyebrow">06 · 作者后台状态</span><h3>确认同一远端视频</h3></div><em>{release.remoteRecordId}</em></header><label>后台 URL<input value={destinationUrl} onChange={(event) => setDestinationUrl(event.target.value)} /></label><label>后台状态<input value={backendStatus} onChange={(event) => setBackendStatus(event.target.value)} placeholder={flow.target.platform === "xiaohongshu" ? "已发布 / 审核中 / 未通过" : "页面实际显示的状态"} /></label><label>后台证据（每行一条）<textarea value={destinationEvidence} onChange={(event) => setDestinationEvidence(event.target.value)} /></label><label className="maimai-risk-confirm"><input type="checkbox" checked={backendRecordObserved} onChange={(event) => setBackendRecordObserved(event.target.checked)} /><span>作者会话已看到同一远端 ID、视频信息与当前状态。</span></label><div className="maimai-action-row"><button className="primary-button" disabled={!backendRecordObserved || !backendStatus.trim() || !destinationUrl.trim() || !lines(destinationEvidence).length || busy !== ""} onClick={() => void mutate("destination", "update_release", releaseUpdatePayload(release, "record_destination", { targetState: "backend_verified", destinationUrl, evidence: lines(destinationEvidence), details: { workflowId: VIDEO_RELEASE_WORKFLOW.id, workflowVersion: VIDEO_RELEASE_WORKFLOW.version, backendRecordObserved: true, creatorSessionObserved: true, sameRemoteRecordConfirmed: true, remoteRecordId: release.remoteRecordId, backendStatus } }), "视频后台记录已核验；公开播放仍未成立")}>记录后台状态</button><button disabled={!lines(destinationEvidence).length || busy !== ""} onClick={() => void mutate("destination-inconclusive", "update_release", releaseUpdatePayload(release, "record_destination", { targetState: "inconclusive", evidence: lines(destinationEvidence), details: { workflowId: VIDEO_RELEASE_WORKFLOW.id, workflowVersion: VIDEO_RELEASE_WORKFLOW.version } }), "视频后台核验证据不足")}>证据不足</button></div></div>}
      {release.destinationState === "backend_verified" && release.publicState !== "public_verified" && <div className="maimai-stage-card compact"><header><div><span className="eyebrow">07 · 独立公开播放</span><h3>可访问还不够，必须真的开始播放</h3></div><em>非作者会话</em></header><label>公开 URL<input value={publicUrl} onChange={(event) => setPublicUrl(event.target.value)} placeholder={flow.target.platform === "zhihu" ? "https://www.zhihu.com/pin/{id} 或 /zvideo/{id}" : "https://www.xiaohongshu.com/explore/{id}"} /></label><label>公开播放证据（每行一条）<textarea value={publicEvidence} onChange={(event) => setPublicEvidence(event.target.value)} /></label><label className="maimai-risk-confirm"><input type="checkbox" checked={independentProbeObserved} onChange={(event) => setIndependentProbeObserved(event.target.checked)} /><span>独立非作者会话已打开同一公开视频。</span></label><label className="maimai-risk-confirm"><input type="checkbox" checked={playbackStartedObserved} onChange={(event) => setPlaybackStartedObserved(event.target.checked)} /><span>已实际启动播放，并观察到画面 / 声音继续输出。</span></label><div className="maimai-action-row"><button className="primary-button" disabled={!independentProbeObserved || !playbackStartedObserved || !publicUrl.trim() || !lines(publicEvidence).length || busy !== ""} onClick={() => void mutate("public", "update_release", releaseUpdatePayload(release, "record_public", { targetState: "public_verified", publicUrl, evidence: lines(publicEvidence), details: { workflowId: VIDEO_RELEASE_WORKFLOW.id, workflowVersion: VIDEO_RELEASE_WORKFLOW.version, independentAudienceProbeObserved: true, probeMode: "independent_non_author_session", sameRemoteRecordConfirmed: true, remoteRecordId: release.remoteRecordId, publicPageLoadedObserved: true, playbackStartedObserved: true, continuedAudioVideoObserved: true } }), "公开视频已由独立会话确认可访问且可播放")}>记录公开可播放</button><button disabled={!independentProbeObserved || !lines(publicEvidence).length || busy !== ""} onClick={() => void mutate("public-not-visible", "update_release", releaseUpdatePayload(release, "record_public", { targetState: "not_public", evidence: lines(publicEvidence), details: { workflowId: VIDEO_RELEASE_WORKFLOW.id, workflowVersion: VIDEO_RELEASE_WORKFLOW.version, independentAudienceProbeObserved: true, probeMode: "independent_non_author_session", sameRemoteRecordConfirmed: true, remoteRecordId: release.remoteRecordId } }), "已记录当前不公开或不可播放")}>记录当前不可用</button></div></div>}
       {release.publicState === "public_verified" && <div className="maimai-stage-card maimai-flow-complete"><header><div><span className="eyebrow">视频发布证据链已闭环</span><h3>平台接受、后台记录和公开播放均已核验</h3></div><em>{release.remoteRecordId}</em></header><div><span>平台接受提交 <strong>{release.submissionEvidence.length} 条</strong></span><span>后台记录已核验 <strong>{release.destinationEvidence.length} 条</strong></span><span>公开页面已核验 <strong>{release.publicEvidence.length} 条</strong></span></div>{release.publicUrl && <a href={release.publicUrl} target="_blank" rel="noreferrer">打开已核验的视频</a>}<p>发布证据链闭环不等于效果已核验；播放量、完播率或业务效果仍需在指定观察期内另建指标证据。</p></div>}
    </>}
  </section>;
}
