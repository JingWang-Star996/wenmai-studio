import type {
  BuildGateRunRecord,
  ContentBuildRecord,
  ContentReleaseRecord,
  LifecycleSnapshot,
  PlatformTargetRecord,
} from "./lifecycle-types";

export const VIDEO_RELEASE_WORKFLOW = {
  id: "video.manual-platform-release.v1",
  version: "1.0.0",
  profileKeys: ["xiaohongshu.video", "zhihu.video"],
  actionConfirmationTtlMinutes: 15,
  layers: [
    { id: "preparation", label: "核对上传与发布包", claim: "artifact_validated", evidence: "输入冻结视频工件；逐项确认上传及转码完成、封面已保存、元数据与声明匹配" },
    { id: "acceptance", label: "记录平台接受信号", claim: "submission_accepted", evidence: "单次提交后读取平台明确接受信号与远端记录 ID；不推出后台或公开访问" },
    { id: "backend", label: "核验后台记录", claim: "destination_record_verified", evidence: "在作者后台找到同一视频并记录审核 / 发布状态；不推出公开可播放" },
    { id: "public_playback", label: "核验公开播放", claim: "public_access_and_playback_verified", evidence: "独立非作者会话打开同一公开视频并实际开始播放；不推出效果已核验" },
  ],
  steps: [
    { id: "upload_transcode", label: "上传 / 转码", evidence: "进度 100%，平台上传与转码均明确完成" },
    { id: "cover", label: "封面", evidence: "封面已保存，预览与裁切已核对" },
    { id: "metadata", label: "标题 / 简介 / 话题 / 声明", evidence: "按目标画像逐项核对，不猜 unknown 限制" },
    { id: "release", label: "Release 草稿", evidence: "只建立本地记录并绑定当前工件摘要" },
    { id: "approval", label: "人工批准", evidence: "内容所有者批准当前 Release 与双门禁" },
    { id: "single_submit", label: "单次提交", evidence: "短时现场授权后只执行一次外部提交" },
    { id: "platform_acceptance", label: "平台接受", evidence: "可见接受信号、远端 ID 与操作证据" },
    { id: "backend_status", label: "后台状态", evidence: "作者后台确认同一远端视频及其状态" },
    { id: "public_playback", label: "公开可播放", evidence: "非作者会话访问同一 URL 并实际启动播放" },
  ],
} as const;

export type VideoPlatform = "xiaohongshu" | "zhihu";
export type VideoWorkflowStepId = (typeof VIDEO_RELEASE_WORKFLOW.steps)[number]["id"];
export type VideoWorkflowStepState = "complete" | "current" | "pending" | "blocked";

export type VideoEditorObservation = {
  observedAt: string;
  editorUrl: string;
  editorVisible: boolean;
  uploadProgressPercent: number | null;
  uploadComplete: boolean;
  transcodeComplete: boolean;
  coverSaved: boolean;
  coverPreviewVisible: boolean;
  coverCropSafe: boolean;
  coverSource: "video_frame" | "uploaded_image" | "platform_generated";
  coverRatio: string;
  titlePresent: boolean;
  descriptionPresent: boolean;
  titleCount: number | null;
  descriptionCount: number | null;
  topicsReviewed: boolean;
  disclosuresReviewed: boolean;
  publishingSettingsReviewed: boolean;
  videoMarkSelected: boolean;
  originalVideoSettingReviewed: boolean;
  metadataMatchesFrozenBuild: boolean;
  previewPlaybackPass: boolean;
  contentFidelityPass: boolean;
  compatibilityEvidence: string[];
  fidelityEvidence: string[];
};

export type VideoFlowProjection = {
  target: PlatformTargetRecord;
  build: ContentBuildRecord;
  release: ContentReleaseRecord | null;
  compatibilityGate: BuildGateRunRecord | null;
  fidelityGate: BuildGateRunRecord | null;
  steps: Array<{
    id: VideoWorkflowStepId;
    label: string;
    evidence: string;
    state: VideoWorkflowStepState;
  }>;
};

const SHA256_RE = /^[a-f0-9]{64}$/;
const PLACEHOLDER_EVIDENCE = /(?:^|[\s:/._-])(todo|tbd|pending|unknown|placeholder|待补|待定|未知)(?:$|[\s:/._-])/i;

function uniqueEvidence(values: string[]) {
  return [...new Set(values.map((item) => item.trim()).filter(Boolean))];
}

function hasTimezone(value: string) {
  return /(?:Z|[+-]\d{2}:\d{2})$/i.test(value) && Number.isFinite(Date.parse(value));
}

export function isVideoTarget(target: PlatformTargetRecord | null | undefined): target is PlatformTargetRecord {
  return Boolean(target
    && (target.platform === "xiaohongshu" || target.platform === "zhihu")
    && VIDEO_RELEASE_WORKFLOW.profileKeys.includes(target.profileKey as (typeof VIDEO_RELEASE_WORKFLOW.profileKeys)[number])
    && target.profile?.mediaKind === "video");
}

export function videoEditorUrlMatches(platform: string, value: string) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")) return false;
    if (platform === "xiaohongshu") {
      return url.hostname === "creator.xiaohongshu.com"
        && url.pathname === "/publish/publish"
        && url.searchParams.get("target") === "video";
    }
    if (platform === "zhihu") return url.hostname === "www.zhihu.com" && /^\/upload-video\/?$/.test(url.pathname);
    return false;
  } catch {
    return false;
  }
}

export function videoDestinationUrlMatches(platform: string, value: string) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")) return false;
    if (platform === "xiaohongshu") return url.hostname === "creator.xiaohongshu.com";
    if (platform === "zhihu") return url.hostname === "www.zhihu.com" || url.hostname === "creator.zhihu.com";
    return false;
  } catch {
    return false;
  }
}

export function videoPublicUrlMatches(platform: string, value: string, remoteRecordId: string) {
  if (!remoteRecordId.trim() || PLACEHOLDER_EVIDENCE.test(remoteRecordId)) return false;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")) return false;
    if (platform === "xiaohongshu") {
      if (url.hostname !== "www.xiaohongshu.com") return false;
      const match = url.pathname.match(/^\/(?:explore|discovery\/item)\/([^/]+)\/?$/);
      return match?.[1] === remoteRecordId;
    }
    if (platform === "zhihu") {
      if (url.hostname !== "www.zhihu.com" || !/^\d+$/.test(remoteRecordId)) return false;
      return url.pathname.match(/^\/(?:pin|zvideo)\/(\d+)\/?$/)?.[1] === remoteRecordId;
    }
    return false;
  } catch {
    return false;
  }
}

export function validateVideoEditorObservation(
  target: PlatformTargetRecord,
  build: ContentBuildRecord,
  observation: VideoEditorObservation,
) {
  const errors: string[] = [];
  const compatibilityEvidence = uniqueEvidence(observation.compatibilityEvidence);
  const fidelityEvidence = uniqueEvidence(observation.fidelityEvidence);
  if (!isVideoTarget(target) || build.targetProfileId !== target.id || build.targetProfileSha256 !== target.profileSha256) {
    errors.push("必须选择绑定当前 xiaohongshu.video 或 zhihu.video 画像的 Build。");
  }
  if (build.state !== "built" || !SHA256_RE.test(build.artifactSha256)) errors.push("必须选择已绑定 SHA-256 的 built 视频工件。");
  if (!observation.editorVisible) errors.push("必须真实看到已登录的视频发布页。");
  if (!hasTimezone(observation.observedAt)) errors.push("发布页观察时间必须是带时区的 ISO 时间。");
  if (!videoEditorUrlMatches(target.platform, observation.editorUrl)) errors.push("发布页 URL 与当前视频 PlatformTarget 不匹配。");
  if (observation.uploadProgressPercent !== 100 || !observation.uploadComplete || !observation.transcodeComplete) {
    errors.push("上传进度、平台接收与转码必须全部明确完成；仅选中文件或进度不足不能放行。");
  }
  if (!observation.coverSaved || !observation.coverPreviewVisible || !observation.coverCropSafe) {
    errors.push("封面必须已保存，并通过可见预览与裁切核对。");
  }
  if (!observation.coverSource || !observation.coverRatio.trim()) errors.push("必须记录封面来源与实际比例；未知时不能猜测放行。");
  if (target.platform === "xiaohongshu") {
    if (!Number.isSafeInteger(observation.titleCount) || Number(observation.titleCount) < 0 || Number(observation.titleCount) > 20) {
      errors.push("小红书标题可见计数必须是 0 到 20 的整数。");
    }
    if (!Number.isSafeInteger(observation.descriptionCount) || Number(observation.descriptionCount) < 0 || Number(observation.descriptionCount) > 1000) {
      errors.push("小红书简介 / 正文可见计数必须是 0 到 1000 的整数。");
    }
    if (!["原始", "3:4", "4:3", "1:1"].includes(observation.coverRatio)) errors.push("小红书封面比例必须来自本次页面可见的原始、3:4、4:3 或 1:1。");
  }
  if (target.platform === "zhihu") {
    if (!observation.titlePresent || !observation.descriptionPresent) errors.push("知乎标题与介绍都是必填项。");
    if (!observation.videoMarkSelected) errors.push("知乎必填的视频标记尚未选择。");
  }
  if (!observation.topicsReviewed) errors.push("必须核对话题字段；平台未提供时也要明确记录不适用，不能借其他字段推断。");
  if (!observation.disclosuresReviewed || !observation.originalVideoSettingReviewed) errors.push("必须按内容事实核对声明、原创视频与来源设置。");
  if (!observation.publishingSettingsReviewed) errors.push("必须核对可见范围、定时、专栏 / 合集、评论或同步设置。");
  if (!observation.metadataMatchesFrozenBuild) errors.push("标题、简介、话题和声明必须匹配冻结 Build。");
  if (!observation.previewPlaybackPass) errors.push("提交前必须确认平台预览能够播放且声音 / 画面正常。");
  if (!observation.contentFidelityPass) errors.push("必须确认视频、封面与元数据没有改变冻结内容合同。");
  if (!compatibilityEvidence.length || compatibilityEvidence.some((item) => PLACEHOLDER_EVIDENCE.test(item))) {
    errors.push("上传、转码与封面门禁至少需要一条非占位证据。");
  }
  if (!fidelityEvidence.length || fidelityEvidence.some((item) => PLACEHOLDER_EVIDENCE.test(item))) {
    errors.push("内容还原门禁至少需要一条非占位证据。");
  }
  return { ok: errors.length === 0, errors };
}

export function makeVideoGatePayloads(
  target: PlatformTargetRecord,
  build: ContentBuildRecord,
  observation: VideoEditorObservation,
) {
  const validation = validateVideoEditorObservation(target, build, observation);
  if (!validation.ok) throw new Error(validation.errors.join("\n"));
  const sharedDetails = {
    workflowId: VIDEO_RELEASE_WORKFLOW.id,
    workflowVersion: VIDEO_RELEASE_WORKFLOW.version,
    platform: target.platform,
    profileKey: target.profileKey,
    targetProfileSha256: build.targetProfileSha256,
    contractSha256: build.contractSha256,
    observedAt: observation.observedAt,
    editorUrl: observation.editorUrl,
    visibleEditorObserved: true,
    upload: {
      progressPercent: observation.uploadProgressPercent,
      uploadComplete: true,
      transcodeComplete: true,
    },
    cover: {
      saved: true,
      previewVisible: true,
      cropSafe: true,
      source: observation.coverSource,
      ratio: observation.coverRatio,
    },
    metadata: {
      titlePresent: observation.titlePresent,
      descriptionPresent: observation.descriptionPresent,
      titleCount: observation.titleCount,
      descriptionCount: observation.descriptionCount,
      topicsReviewed: true,
      disclosuresReviewed: true,
      publishingSettingsReviewed: true,
      videoMarkSelected: observation.videoMarkSelected,
      originalVideoSettingReviewed: true,
      matchesFrozenBuild: true,
    },
    previewPlaybackPass: true,
    externalSubmissionPerformed: false,
  };
  return [
    {
      buildId: build.id,
      gateKind: "compatibility" as const,
      result: "pass" as const,
      artifactSha256: build.artifactSha256,
      evidence: uniqueEvidence(observation.compatibilityEvidence),
      details: { ...sharedDetails, normalPlatformPreviewPass: true },
    },
    {
      buildId: build.id,
      gateKind: "fidelity" as const,
      result: "pass" as const,
      artifactSha256: build.artifactSha256,
      evidence: uniqueEvidence(observation.fidelityEvidence),
      details: { ...sharedDetails, contentFidelityPass: true },
    },
  ];
}

function latestBoundGate(snapshot: LifecycleSnapshot, build: ContentBuildRecord, gateKind: "compatibility" | "fidelity") {
  return snapshot.buildGates
    .filter((gate) => gate.buildId === build.id
      && gate.gateKind === gateKind
      && gate.artifactSha256 === build.artifactSha256
      && gate.targetProfileSha256 === build.targetProfileSha256
      && gate.contractSha256 === build.contractSha256)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0] ?? null;
}

export function projectVideoReleaseFlows(snapshot: LifecycleSnapshot): VideoFlowProjection[] {
  const targets = new Map(snapshot.platformTargets.filter(isVideoTarget).map((target) => [target.id, target]));
  return snapshot.builds
    .filter((build) => targets.has(build.targetProfileId))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .map((build) => {
      const target = targets.get(build.targetProfileId)!;
      const compatibilityGate = latestBoundGate(snapshot, build, "compatibility");
      const fidelityGate = latestBoundGate(snapshot, build, "fidelity");
      const release = snapshot.releases
        .filter((item) => item.buildId === build.id)
        .sort((left, right) => Number(right.lifecycleState === "active") - Number(left.lifecycleState === "active")
          || right.updatedAt.localeCompare(left.updatedAt))[0] ?? null;
      const preparationComplete = compatibilityGate?.result === "pass" && fidelityGate?.result === "pass";
      const complete: Record<VideoWorkflowStepId, boolean> = {
        upload_transcode: preparationComplete,
        cover: preparationComplete,
        metadata: preparationComplete,
        release: Boolean(release),
        approval: release?.approvalState === "approved",
        single_submit: Boolean(release && release.submissionState !== "not_submitted"),
        platform_acceptance: release?.submissionState === "submission_accepted",
        backend_status: release?.destinationState === "backend_verified",
        public_playback: release?.publicState === "public_verified",
      };
      const blocked = build.state === "failed" || build.state === "superseded"
        || release?.approvalState === "rejected" || (release ? release.lifecycleState !== "active" : false);
      let currentAssigned = false;
      const steps = VIDEO_RELEASE_WORKFLOW.steps.map((step) => {
        let state: VideoWorkflowStepState = "pending";
        if (complete[step.id]) state = "complete";
        else if (blocked) state = "blocked";
        else if (!currentAssigned) {
          state = "current";
          currentAssigned = true;
        }
        return { ...step, state };
      });
      return { target, build, release, compatibilityGate, fidelityGate, steps };
    });
}
