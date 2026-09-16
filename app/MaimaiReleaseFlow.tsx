"use client";

import { useEffect, useMemo, useState } from "react";

import { postLifecycleMutation } from "./lifecycle-client";
import type { ContentReleaseRecord, LifecycleSnapshot } from "./lifecycle-types";
import {
  MAIMAI_RELEASE_WORKFLOW,
  maimaiManifestFacts,
  makeMaimaiGatePayloads,
  projectMaimaiReleaseFlows,
  validateMaimaiEditorObservation,
  type MaimaiEditorObservation,
} from "./maimai-release-workflow";

type MaimaiReleaseFlowProps = {
  snapshot: LifecycleSnapshot;
  reload: () => Promise<void>;
  notify: (message: string) => void;
  openAdvanced: () => void;
};

type CheckKey =
  | "editorVisible"
  | "bottomAttachmentPreviewVisible"
  | "attachmentPreviewCropSafe"
  | "aiAssistedCreationSelected"
  | "realNameCommentsOnlyDisabled"
  | "nicknameWatermarkDisabled"
  | "titleAndBodyMatchFrozenBuild"
  | "inlineTopicsMatchFrozenBody"
  | "normalReadingPass"
  | "contentFidelityPass";

const INITIAL_CHECKS: Record<CheckKey, boolean> = {
  editorVisible: false,
  bottomAttachmentPreviewVisible: false,
  attachmentPreviewCropSafe: false,
  aiAssistedCreationSelected: false,
  realNameCommentsOnlyDisabled: false,
  nicknameWatermarkDisabled: false,
  titleAndBodyMatchFrozenBuild: false,
  inlineTopicsMatchFrozenBody: false,
  normalReadingPass: false,
  contentFidelityPass: false,
};

function lines(value: string) {
  return [...new Set(value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean))];
}

function short(value: string) {
  return value ? value.slice(0, 10) : "—";
}

function releaseUpdatePayload(release: ContentReleaseRecord, operation: string, extra: Record<string, unknown>) {
  return { operation, releaseId: release.id, expectedLockVersion: release.lockVersion, ...extra };
}

export default function MaimaiReleaseFlow({ snapshot, reload, notify, openAdvanced }: MaimaiReleaseFlowProps) {
  const flows = useMemo(() => projectMaimaiReleaseFlows(snapshot), [snapshot]);
  const [selectedBuildId, setSelectedBuildId] = useState("");
  const selected = flows.find((flow) => flow.build.id === selectedBuildId) ?? flows[0];
  const selectedBuild = selected?.build;
  const selectedRelease = selected?.release;
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [editorUrl, setEditorUrl] = useState(MAIMAI_RELEASE_WORKFLOW.editorUrl);
  const [observedAt, setObservedAt] = useState(() => new Date().toISOString());
  const [titleCount, setTitleCount] = useState("");
  const [bodyCount, setBodyCount] = useState("");
  const [imageCount, setImageCount] = useState("");
  const [checks, setChecks] = useState(INITIAL_CHECKS);
  const [compatibilityEvidence, setCompatibilityEvidence] = useState("");
  const [fidelityEvidence, setFidelityEvidence] = useState("");
  const [approvalNote, setApprovalNote] = useState("");
  const [approvalConfirmed, setApprovalConfirmed] = useState(false);
  const [submitNote, setSubmitNote] = useState("");
  const [actionConfirmed, setActionConfirmed] = useState(false);
  const [remoteRecordId, setRemoteRecordId] = useState("");
  const [submissionEvidence, setSubmissionEvidence] = useState("");
  const [oneClickObserved, setOneClickObserved] = useState(false);
  const [composerClearedObserved, setComposerClearedObserved] = useState(false);
  const [feedItemObserved, setFeedItemObserved] = useState(false);
  const [platformFailureObserved, setPlatformFailureObserved] = useState(false);
  const [destinationUrl, setDestinationUrl] = useState("");
  const [destinationEvidence, setDestinationEvidence] = useState("");
  const [backendRecordObserved, setBackendRecordObserved] = useState(false);
  const [publicUrl, setPublicUrl] = useState("");
  const [publicEvidence, setPublicEvidence] = useState("");
  const [independentProbeObserved, setIndependentProbeObserved] = useState(false);

  useEffect(() => {
    if (!selectedBuild) return;
    const facts = maimaiManifestFacts(selectedBuild);
    const timer = window.setTimeout(() => {
      setSelectedBuildId(selectedBuild.id);
      setTitleCount(facts.titleCount === null ? "" : String(facts.titleCount));
      setBodyCount(facts.bodyCount === null ? "" : String(facts.bodyCount));
      setImageCount(facts.imageCount === null ? "" : String(facts.imageCount));
      setObservedAt(new Date().toISOString());
      setChecks(INITIAL_CHECKS);
      setCompatibilityEvidence("");
      setFidelityEvidence("");
      setApprovalNote("");
      setApprovalConfirmed(false);
      setSubmitNote("");
      setActionConfirmed(false);
      setRemoteRecordId("");
      setSubmissionEvidence("");
      setOneClickObserved(false);
      setComposerClearedObserved(false);
      setFeedItemObserved(false);
      setPlatformFailureObserved(false);
      setDestinationUrl("");
      setDestinationEvidence("");
      setBackendRecordObserved(false);
      setPublicUrl("");
      setPublicEvidence("");
      setIndependentProbeObserved(false);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [selectedBuild]);

  useEffect(() => {
    if (!selectedRelease) return;
    const timer = window.setTimeout(() => {
      setApprovalNote("");
      setApprovalConfirmed(false);
      setSubmitNote("");
      setActionConfirmed(false);
      setSubmissionEvidence("");
      setOneClickObserved(false);
      setComposerClearedObserved(false);
      setFeedItemObserved(false);
      setPlatformFailureObserved(false);
      setDestinationEvidence("");
      setBackendRecordObserved(false);
      setPublicEvidence("");
      setIndependentProbeObserved(false);
      setRemoteRecordId(selectedRelease.remoteRecordId);
      setDestinationUrl(selectedRelease.destinationUrl || selectedRelease.publicUrl);
      setPublicUrl(selectedRelease.publicUrl || selectedRelease.destinationUrl);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [selectedRelease]);

  const mutate = async (key: string, action: string, payload: Record<string, unknown>, message: string) => {
    setBusy(key);
    setError("");
    try {
      const response = await postLifecycleMutation(action, payload);
      const result = await response.json() as { ok?: boolean; error?: string };
      if (!response.ok || result.ok === false) throw new Error(result.error || "脉脉发布流记录失败");
      await reload();
      notify(message);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "脉脉发布流记录失败");
    } finally {
      setBusy("");
    }
  };

  if (!flows.length) {
    const hasTarget = snapshot.platformTargets.some((target) => target.platform === "maimai");
    return <section className="maimai-flow maimai-flow-empty">
      <header><div><span className="eyebrow">脉脉发布流</span><h2>先为当前文章准备一个脉脉 Build</h2></div><code>{MAIMAI_RELEASE_WORKFLOW.version}</code></header>
      <p>{hasTarget ? "脉脉画像已登记。下一步是建立适配合同、冻结 Build 并登记已有工件摘要；这些动作不会向脉脉提交内容。" : "当前没有可用的 maimai.community-post 平台画像；需先登记目标规则，才能建立 Build。"}</p>
      <button className="primary-button" onClick={openAdvanced}>打开高级构建记录</button>
    </section>;
  }

  const flow = selected;
  const release = flow.release;
  const facts = maimaiManifestFacts(flow.build);
  const observation: MaimaiEditorObservation = {
    observedAt,
    editorUrl,
    editorVisible: checks.editorVisible,
    titleCount: titleCount.trim() === "" ? null : Number(titleCount),
    bodyCount: bodyCount.trim() === "" ? null : Number(bodyCount),
    imageCount: imageCount.trim() === "" ? null : Number(imageCount),
    imagePlacement: "bottom_attachments_only",
    bottomAttachmentPreviewVisible: checks.bottomAttachmentPreviewVisible,
    attachmentPreviewCropSafe: checks.attachmentPreviewCropSafe,
    aiAssistedCreationSelected: checks.aiAssistedCreationSelected,
    realNameCommentsOnlyDisabled: checks.realNameCommentsOnlyDisabled,
    nicknameWatermarkDisabled: checks.nicknameWatermarkDisabled,
    titleAndBodyMatchFrozenBuild: checks.titleAndBodyMatchFrozenBuild,
    inlineTopicsMatchFrozenBody: checks.inlineTopicsMatchFrozenBody,
    normalReadingPass: checks.normalReadingPass,
    contentFidelityPass: checks.contentFidelityPass,
    compatibilityEvidence: lines(compatibilityEvidence),
    fidelityEvidence: lines(fidelityEvidence),
  };
  const editorValidation = validateMaimaiEditorObservation(flow.build, observation);
  const compatibilityPassed = flow.compatibilityGate?.result === "pass";
  const fidelityPassed = flow.fidelityGate?.result === "pass";
  const setCheck = (key: CheckKey, value: boolean) => setChecks((current) => ({ ...current, [key]: value }));

  const recordEditorGates = async () => {
    let payloads: ReturnType<typeof makeMaimaiGatePayloads>;
    try {
      payloads = makeMaimaiGatePayloads(flow.build, observation);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "真实编辑器证据不完整");
      return;
    }
    setBusy("editor-gates");
    setError("");
    try {
      for (const payload of payloads) {
        const alreadyPassed = payload.gateKind === "compatibility" ? compatibilityPassed : fidelityPassed;
        if (alreadyPassed) continue;
        const response = await postLifecycleMutation("record_build_gate", payload);
        const result = await response.json() as { ok?: boolean; error?: string };
        if (!response.ok || result.ok === false) throw new Error(result.error || `${payload.gateKind} 门禁记录失败`);
      }
      await reload();
      notify("脉脉真实编辑器双门禁已绑定当前 Build；尚未创建或提交 Release");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "脉脉编辑器门禁记录失败");
    } finally {
      setBusy("");
    }
  };

  const recordSubmission = (targetState: "submission_accepted" | "submission_failed") => {
    if (!release) return;
    const evidence = lines(submissionEvidence);
    const details = {
      workflowId: MAIMAI_RELEASE_WORKFLOW.id,
      workflowVersion: MAIMAI_RELEASE_WORKFLOW.version,
      externalClickPerformed: oneClickObserved,
      singleClickCount: oneClickObserved ? 1 : 0,
      platformAcceptedObserved: targetState === "submission_accepted" && feedItemObserved,
      composerClearedObserved,
      feedItemObserved,
      platformFailureObserved: targetState === "submission_failed" && platformFailureObserved,
      failureObservedAt: targetState === "submission_failed" ? new Date().toISOString() : undefined,
      failureKind: targetState === "submission_failed" ? "visible_platform_error" : undefined,
      failureEvidenceRef: targetState === "submission_failed" ? (evidence[0] ?? "") : undefined,
    };
    void mutate("submission", "update_release", releaseUpdatePayload(release, "record_submission", {
      targetState,
      remoteRecordId: targetState === "submission_accepted" ? remoteRecordId : "",
      evidence,
      details,
    }), targetState === "submission_accepted" ? "已记录平台接受提交；后台记录与公开页面仍需分别核验" : "已记录平台明确失败；未把超时或跳转推断为结果");
  };

  return <section className="maimai-flow" aria-busy={busy !== ""}>
    <header className="maimai-flow-heading"><div><span className="eyebrow">脉脉发布流 · 手工可见页面</span><h2>处理当前 Build 的提交、后台记录和公开页面证据</h2><p>文脉只记录门禁、批准和已观察到的回执；不会登录脉脉、点击“发动态”或在结果不明时自动重试。</p></div><label>选择 Build<select value={flow.build.id} onChange={(event) => setSelectedBuildId(event.target.value)}>{flows.map((item) => <option key={item.build.id} value={item.build.id}>{item.build.sourceTitle || short(item.build.id)} · {item.release?.publicState ?? item.build.state}</option>)}</select></label></header>

    {error && <div className="operation-error" role="alert"><span>{error}</span><button onClick={() => setError("")}>关闭</button></div>}

    <div className="maimai-flow-binding"><span>BUILD <code>{short(flow.build.id)}</code></span><span>ARTIFACT <code>{short(flow.build.artifactSha256)}</code></span><span>TARGET <code>{short(flow.build.targetProfileSha256)}</code></span><span>CONTRACT <code>{short(flow.build.contractSha256)}</code></span></div>
    <div className="maimai-step-rail" role="list" aria-label="脉脉发布步骤">{flow.steps.map((step, index) => <article key={step.id} className={step.state} role="listitem" aria-current={step.state === "current" ? "step" : undefined}><span>{String(index + 1).padStart(2, "0")}</span><strong>{step.label}</strong><small>{step.evidence}</small><em>{step.state === "complete" ? "已完成" : step.state === "current" ? "当前" : step.state === "blocked" ? "已阻断" : "等待"}</em></article>)}</div>

    {!compatibilityPassed || !fidelityPassed ? <div className="maimai-stage-card">
      <header><div><span className="eyebrow">01 · 当前 Build 的编辑器门禁</span><h3>读取发布页后，记录兼容性和内容还原证据</h3></div><em>{facts.titleCount ?? "?"}/20 · {facts.bodyCount ?? "?"}/1000 · {facts.imageCount ?? "?"}/9 图</em></header>
      <p className="maimai-stage-boundary">本地 manifest 只给出本次 Build 的预期值。请在已登录的脉脉编辑器核对计数器、图片预览和设置，再把可复查证据写入此处；未观察到的限制保持 unknown。</p>
      <div className="maimai-editor-fields"><label className="wide">编辑器 URL<input value={editorUrl} onChange={(event) => setEditorUrl(event.target.value)} /></label><label>观察时间<input value={observedAt} onChange={(event) => setObservedAt(event.target.value)} /></label><label>标题可见计数<input type="number" min="0" max="20" value={titleCount} onChange={(event) => setTitleCount(event.target.value)} /></label><label>正文可见计数<input type="number" min="1" max="1000" value={bodyCount} onChange={(event) => setBodyCount(event.target.value)} /></label><label>图片可见数量<input type="number" min="0" max="9" value={imageCount} onChange={(event) => setImageCount(event.target.value)} /></label></div>
      <div className="maimai-check-grid">{([
        ["editorVisible", "已看到登录后的发布编辑器"],
        ["titleAndBodyMatchFrozenBuild", "标题与正文匹配冻结 Build"],
        ["inlineTopicsMatchFrozenBody", "tag 已在正文内且内容一致"],
        ["bottomAttachmentPreviewVisible", "已看到正文底部图片预览"],
        ["attachmentPreviewCropSafe", "预览裁切未损坏关键信息"],
        ["aiAssistedCreationSelected", "已选“含AI辅助创作”"],
        ["realNameCommentsOnlyDisabled", "“仅限实名评论”保持关闭"],
        ["nicknameWatermarkDisabled", "昵称水印保持关闭"],
        ["normalReadingPass", "正常阅读与渲染通过"],
        ["contentFidelityPass", "核心内容还原通过"],
      ] as Array<[CheckKey, string]>).map(([key, label]) => <label key={key}><input type="checkbox" checked={checks[key]} onChange={(event) => setCheck(key, event.target.checked)} /><span>{label}</span></label>)}</div>
      <div className="maimai-evidence-grid"><label>兼容性证据（每行一条）<textarea value={compatibilityEvidence} onChange={(event) => setCompatibilityEvidence(event.target.value)} placeholder="截图、可见状态或检查记录的稳定引用" /></label><label>内容还原证据（每行一条）<textarea value={fidelityEvidence} onChange={(event) => setFidelityEvidence(event.target.value)} placeholder="标题、正文、tag 与冻结工件的核对证据" /></label></div>
      {!editorValidation.ok && <ul className="maimai-validation-list">{editorValidation.errors.map((item) => <li key={item}>{item}</li>)}</ul>}
      <button className="primary-button" disabled={!editorValidation.ok || busy !== ""} onClick={() => void recordEditorGates()}>{busy === "editor-gates" ? "正在绑定双门禁…" : "记录真实编辑器双门禁"}</button>
    </div> : !release ? <div className="maimai-stage-card compact"><header><div><span className="eyebrow">02 · Release 草稿</span><h3>双门禁已通过</h3></div><em>未批准 · 未提交</em></header><p>建立草稿只冻结本地发布对象，不会触发脉脉请求。</p><button className="primary-button" disabled={busy !== ""} onClick={() => void mutate("create-release", "create_release", { buildId: flow.build.id }, "脉脉 Release 草稿已创建；仍未批准或提交")}>建立 Release 草稿</button></div> : <>
      {release.approvalState === "draft" && <div className="maimai-stage-card compact"><header><div><span className="eyebrow">03 · 人工批准</span><h3>批准只对当前摘要生效</h3></div><em>lock {release.lockVersion}</em></header><label>批准说明<input value={approvalNote} onChange={(event) => setApprovalNote(event.target.value)} placeholder="批准者、范围、依据与当前 Build" /></label><label className="maimai-risk-confirm"><input type="checkbox" checked={approvalConfirmed} onChange={(event) => setApprovalConfirmed(event.target.checked)} /><span>我确认批准当前脉脉 Release；这一步仍不会点击或提交脉脉。</span></label><button className="primary-button" disabled={!approvalConfirmed || !approvalNote.trim() || busy !== ""} onClick={() => void mutate("approve", "update_release", releaseUpdatePayload(release, "decide_approval", { targetState: "approved", note: approvalNote, approvalBinding: { workflowId: MAIMAI_RELEASE_WORKFLOW.id, workflowVersion: MAIMAI_RELEASE_WORKFLOW.version, confirmed: true, confirmedAt: new Date().toISOString(), authorityRole: "content_owner", releaseId: release.id, buildId: flow.build.id, buildArtifactSha256: release.buildArtifactSha256, targetProfileSha256: release.targetProfileSha256, contractSha256: flow.build.contractSha256, compatibilityGateId: flow.compatibilityGate?.id, fidelityGateId: flow.fidelityGate?.id } }), "脉脉 Release 已批准；仍未开始提交")}>批准当前 Release</button></div>}

      {release.approvalState === "approved" && ["not_submitted", "submission_failed"].includes(release.submissionState) && <div className="maimai-stage-card action-stop"><header><div><span className="eyebrow">04 · 现场批准停点</span><h3>下一步才允许一次外部点击</h3></div><em>文脉不点击</em></header><p>请先在可见脉脉页面完成最后核对。确认后，文脉只把 Release 记为 submitting；真正的“发动态”仍需在外部页面单击一次。明确失败后的再次尝试也必须重新勾选并形成新确认。</p><label>现场说明<input value={submitNote} onChange={(event) => setSubmitNote(event.target.value)} placeholder="当前页面、账号、Build 与最终检查" /></label><label className="maimai-risk-confirm"><input type="checkbox" checked={actionConfirmed} onChange={(event) => setActionConfirmed(event.target.checked)} /><span>我现在确认：只对这个 Release 的本次尝试授权一次“发动态”点击，外部结果不明时禁止重试。</span></label><button className="primary-button" disabled={!actionConfirmed || !submitNote.trim() || busy !== ""} onClick={() => void mutate("prepare-submit", "update_release", releaseUpdatePayload(release, "start_submission", { note: submitNote, actionConfirmation: { workflowId: MAIMAI_RELEASE_WORKFLOW.id, workflowVersion: MAIMAI_RELEASE_WORKFLOW.version, confirmed: true, confirmedAt: new Date().toISOString(), authorityRole: "content_owner", releaseId: release.id, buildId: flow.build.id, buildArtifactSha256: release.buildArtifactSha256, targetProfileSha256: release.targetProfileSha256, contractSha256: flow.build.contractSha256, compatibilityGateId: flow.compatibilityGate?.id, fidelityGateId: flow.fidelityGate?.id, singleExternalClickAuthorized: true, externalClickWillBePerformedSeparately: true } }), "已到外部单击停点；文脉没有发送脉脉请求")}>记录现场确认，进入外部单击停点</button></div>}

      {release.submissionState === "submitting" && <div className="maimai-stage-card"><header><div><span className="eyebrow">05 · 外部动作结果</span><h3>只记录已观察到的结果</h3></div><em>结果不明时保持 submitting</em></header><p className="maimai-stage-boundary">若点击后的结果不明确，不要重试；先查询好友动态或详情页。文脉不会把超时、页面跳转或猜测写成平台接受或明确失败。</p><div className="maimai-editor-fields"><label>远端动态 ID<input inputMode="numeric" pattern="[0-9]+" value={remoteRecordId} onChange={(event) => setRemoteRecordId(event.target.value)} /></label><label className="wide">提交证据（每行一条）<textarea value={submissionEvidence} onChange={(event) => setSubmissionEvidence(event.target.value)} /></label></div><div className="maimai-check-grid"><label><input type="checkbox" checked={oneClickObserved} onChange={(event) => setOneClickObserved(event.target.checked)} /><span>已确认只点击一次</span></label><label><input type="checkbox" checked={composerClearedObserved} onChange={(event) => setComposerClearedObserved(event.target.checked)} /><span>提交后编辑器已清空</span></label><label><input type="checkbox" checked={feedItemObserved} onChange={(event) => setFeedItemObserved(event.target.checked)} /><span>好友动态首位出现同一内容</span></label><label><input type="checkbox" checked={platformFailureObserved} onChange={(event) => setPlatformFailureObserved(event.target.checked)} /><span>已看到平台明确错误或拒绝（非超时、跳转或猜测）</span></label></div><div className="maimai-action-row"><button className="primary-button" disabled={!/^\d+$/.test(remoteRecordId) || !lines(submissionEvidence).length || !oneClickObserved || !composerClearedObserved || !feedItemObserved || busy !== ""} onClick={() => recordSubmission("submission_accepted")}>记录平台接受</button><button disabled={!lines(submissionEvidence).length || !oneClickObserved || !platformFailureObserved || busy !== ""} onClick={() => recordSubmission("submission_failed")}>记录明确失败</button><span>结果不明：不写状态，不重试，先探测目标记录。</span></div></div>}

      {release.submissionState === "submission_accepted" && release.destinationState !== "backend_verified" && <div className="maimai-stage-card compact"><header><div><span className="eyebrow">06 · 作者后台核验</span><h3>先确认同一远端记录</h3></div><em>{release.remoteRecordId}</em></header><label>详情 / 后台 URL<input value={destinationUrl} onChange={(event) => setDestinationUrl(event.target.value)} /></label><label>后台证据（每行一条）<textarea value={destinationEvidence} onChange={(event) => setDestinationEvidence(event.target.value)} /></label><label className="maimai-risk-confirm"><input type="checkbox" checked={backendRecordObserved} onChange={(event) => setBackendRecordObserved(event.target.checked)} /><span>作者会话已看到同一远端 ID、完整内容、配图与 AI 声明。</span></label><div className="maimai-action-row"><button className="primary-button" disabled={!backendRecordObserved || !destinationUrl.trim() || !lines(destinationEvidence).length || busy !== ""} onClick={() => void mutate("destination", "update_release", releaseUpdatePayload(release, "record_destination", { targetState: "backend_verified", destinationUrl, evidence: lines(destinationEvidence), details: { workflowId: MAIMAI_RELEASE_WORKFLOW.id, workflowVersion: MAIMAI_RELEASE_WORKFLOW.version, backendRecordObserved: true, authorSessionObserved: true, sameRemoteRecordConfirmed: true, remoteRecordId: release.remoteRecordId } }), "脉脉后台记录已核验；公开访问仍未自动成立")}>记录后台已找到</button><button disabled={!lines(destinationEvidence).length || busy !== ""} onClick={() => void mutate("destination-inconclusive", "update_release", releaseUpdatePayload(release, "record_destination", { targetState: "inconclusive", evidence: lines(destinationEvidence), details: { workflowId: MAIMAI_RELEASE_WORKFLOW.id, workflowVersion: MAIMAI_RELEASE_WORKFLOW.version } }), "脉脉后台核验证据不足")}>证据不足</button></div></div>}

      {release.submissionState === "submission_accepted" && release.destinationState === "backend_verified" && release.publicState !== "public_verified" && <div className="maimai-stage-card compact"><header><div><span className="eyebrow">07 · 独立公开核验</span><h3>切换到非作者会话</h3></div><em>不得复用作者登录态</em></header><label>公开 URL<input value={publicUrl} onChange={(event) => setPublicUrl(event.target.value)} /></label><label>公开证据（每行一条）<textarea value={publicEvidence} onChange={(event) => setPublicEvidence(event.target.value)} /></label><label className="maimai-risk-confirm"><input type="checkbox" checked={independentProbeObserved} onChange={(event) => setIndependentProbeObserved(event.target.checked)} /><span>已在独立非作者会话访问同一远端 ID，并看到作者、标题、正文、配图与 AI 声明。</span></label><div className="maimai-action-row"><button className="primary-button" disabled={!independentProbeObserved || !publicUrl.trim() || !lines(publicEvidence).length || busy !== ""} onClick={() => void mutate("public", "update_release", releaseUpdatePayload(release, "record_public", { targetState: "public_verified", publicUrl, evidence: lines(publicEvidence), details: { workflowId: MAIMAI_RELEASE_WORKFLOW.id, workflowVersion: MAIMAI_RELEASE_WORKFLOW.version, independentAudienceProbeObserved: true, probeMode: "independent_non_author_session", sameRemoteRecordConfirmed: true, remoteRecordId: release.remoteRecordId } }), "脉脉公开页面已由独立会话核验")}>记录公开可见</button><button disabled={!independentProbeObserved || !lines(publicEvidence).length || busy !== ""} onClick={() => void mutate("public-not-visible", "update_release", releaseUpdatePayload(release, "record_public", { targetState: "not_public", evidence: lines(publicEvidence), details: { workflowId: MAIMAI_RELEASE_WORKFLOW.id, workflowVersion: MAIMAI_RELEASE_WORKFLOW.version, independentAudienceProbeObserved: true, probeMode: "independent_non_author_session", sameRemoteRecordConfirmed: true, remoteRecordId: release.remoteRecordId } }), "已记录脉脉当前不公开")}>记录当前不公开</button></div></div>}

      {release.publicState === "public_verified" && <div className="maimai-stage-card maimai-flow-complete"><header><div><span className="eyebrow">发布证据链已闭环</span><h3>平台接受、后台记录和公开页面均已核验</h3></div><em>{release.remoteRecordId}</em></header><div><span>平台接受提交 <strong>{release.submissionEvidence.length} 条证据</strong></span><span>后台记录已核验 <strong>{release.destinationEvidence.length} 条证据</strong></span><span>公开页面已核验 <strong>{release.publicEvidence.length} 条证据</strong></span></div>{release.publicUrl && <a href={release.publicUrl} target="_blank" rel="noreferrer">打开已核验的脉脉动态</a>}<p>证据链闭环不等于效果已核验；曝光、阅读和互动仍需在指定观察期内另建指标快照。</p></div>}
    </>}
  </section>;
}
