import type {
  BuildGateRunRecord,
  ContentBuildRecord,
  ContentReleaseRecord,
  LifecycleSnapshot,
  PlatformTargetRecord,
} from "./lifecycle-types";

export const MAIMAI_RELEASE_WORKFLOW = {
  id: "maimai.manual-community-post.v1",
  version: "1.0.0",
  profileKey: "maimai.community-post",
  editorUrl: "https://maimai.cn/community/home/friend",
  actionConfirmationTtlMinutes: 15,
  steps: [
    { id: "build", label: "核对冻结 Build", evidence: "输入当前工件、画像与合同摘要；确认三者一致" },
    { id: "compatibility", label: "核对可见编辑器", evidence: "读取计数器、图片预览与发布设置；未知限制保持 unknown" },
    { id: "fidelity", label: "核对内容还原", evidence: "逐项确认标题、正文、tag 与冻结工件一致" },
    { id: "release", label: "建立 Release 草稿", evidence: "只建立本地发布记录，不提交外部平台" },
    { id: "approval", label: "等待人工批准", evidence: "内容所有者批准当前摘要；Agent 不可代为批准" },
    { id: "external_click", label: "执行单次外部点击", evidence: "取得现场确认后才在可见页面单击一次；结果不明时停止并只读探测" },
    { id: "submission", label: "记录平台接受", evidence: "读取编辑器清空、动态出现与远端 ID；不推出后台或公开访问" },
    { id: "destination", label: "核验后台记录", evidence: "作者会话核对同一远端记录；不推出公开访问" },
    { id: "public", label: "核验公开访问", evidence: "非作者独立会话访问同一链接；不推出效果已核验" },
  ],
} as const;

export type MaimaiWorkflowStepId = (typeof MAIMAI_RELEASE_WORKFLOW.steps)[number]["id"];
export type MaimaiWorkflowStepState = "complete" | "current" | "pending" | "blocked";

export type MaimaiEditorObservation = {
  observedAt: string;
  editorUrl: string;
  editorVisible: boolean;
  titleCount: number | null;
  bodyCount: number | null;
  imageCount: number | null;
  imagePlacement: "bottom_attachments_only";
  bottomAttachmentPreviewVisible: boolean;
  attachmentPreviewCropSafe: boolean;
  aiAssistedCreationSelected: boolean;
  realNameCommentsOnlyDisabled: boolean;
  nicknameWatermarkDisabled: boolean;
  titleAndBodyMatchFrozenBuild: boolean;
  inlineTopicsMatchFrozenBody: boolean;
  normalReadingPass: boolean;
  contentFidelityPass: boolean;
  compatibilityEvidence: string[];
  fidelityEvidence: string[];
};

export type MaimaiEditorObservationValidation = {
  ok: boolean;
  errors: string[];
};

export type MaimaiFlowProjection = {
  target: PlatformTargetRecord;
  build: ContentBuildRecord;
  release: ContentReleaseRecord | null;
  compatibilityGate: BuildGateRunRecord | null;
  fidelityGate: BuildGateRunRecord | null;
  steps: Array<{
    id: MaimaiWorkflowStepId;
    label: string;
    evidence: string;
    state: MaimaiWorkflowStepState;
  }>;
};

const PLACEHOLDER_EVIDENCE = /(?:^|[\s:/._-])(todo|tbd|pending|unknown|placeholder|待补|待定|未知)(?:$|[\s:/._-])/i;

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function optionalInteger(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function uniqueEvidence(values: string[]) {
  return [...new Set(values.map((item) => item.trim()).filter(Boolean))];
}

function hasTimezone(value: string) {
  return /(?:Z|[+-]\d{2}:\d{2})$/i.test(value) && Number.isFinite(Date.parse(value));
}

export function isMaimaiTarget(target: PlatformTargetRecord | null | undefined) {
  return target?.platform === "maimai";
}

export function isMaimaiHttpsUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "https:"
      && !url.username
      && !url.password
      && (!url.port || url.port === "443")
      && (url.hostname === "maimai.cn" || url.hostname.endsWith(".maimai.cn"));
  } catch {
    return false;
  }
}

export function maimaiRecordUrlMatches(value: string, remoteRecordId: string) {
  if (!isMaimaiHttpsUrl(value) || !/^\d+$/.test(remoteRecordId)) return false;
  const url = new URL(value);
  const pathMatch = url.pathname.match(/^\/community\/feed-detail\/(\d+)\/?$/);
  const pathId = pathMatch?.[1] ?? "";
  const queryId = url.searchParams.get("fid") ?? "";
  return pathId === remoteRecordId && (!queryId || queryId === remoteRecordId);
}

export function maimaiManifestFacts(build: ContentBuildRecord) {
  const manifest = objectValue(build.artifactManifest);
  return {
    titleCount: optionalInteger(manifest.titleVisibleCharacters),
    bodyCount: optionalInteger(manifest.bodyVisibleUtf16),
    imageCount: optionalInteger(manifest.imageCount),
    imagePlacement: typeof manifest.imagePlacement === "string" ? manifest.imagePlacement : "",
    aiDeclaration: typeof manifest.aiDeclaration === "string" ? manifest.aiDeclaration : "",
  };
}

export function latestBoundGate(
  snapshot: LifecycleSnapshot,
  build: ContentBuildRecord,
  gateKind: "compatibility" | "fidelity",
) {
  return snapshot.buildGates
    .filter((gate) => gate.buildId === build.id
      && gate.gateKind === gateKind
      && gate.artifactSha256 === build.artifactSha256
      && gate.targetProfileSha256 === build.targetProfileSha256
      && gate.contractSha256 === build.contractSha256)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0] ?? null;
}

export function validateMaimaiEditorObservation(
  build: ContentBuildRecord,
  observation: MaimaiEditorObservation,
): MaimaiEditorObservationValidation {
  const errors: string[] = [];
  const facts = maimaiManifestFacts(build);
  const compatibilityEvidence = uniqueEvidence(observation.compatibilityEvidence);
  const fidelityEvidence = uniqueEvidence(observation.fidelityEvidence);
  if (build.state !== "built" || !/^[a-f0-9]{64}$/.test(build.artifactSha256)) errors.push("必须选择已绑定 SHA-256 的 built 工件。");
  if (!observation.editorVisible) errors.push("必须真实看到已登录的脉脉发布编辑器。");
  if (!hasTimezone(observation.observedAt)) errors.push("编辑器观察时间必须是带时区的 ISO 时间。");
  if (!isMaimaiHttpsUrl(observation.editorUrl)) errors.push("编辑器地址必须是 maimai.cn 的 HTTPS 页面。");
  if (!Number.isSafeInteger(observation.titleCount) || Number(observation.titleCount) < 0 || Number(observation.titleCount) > 20) {
    errors.push("标题可见计数必须是 0 到 20 的整数。");
  }
  if (!Number.isSafeInteger(observation.bodyCount) || Number(observation.bodyCount) < 1 || Number(observation.bodyCount) > 1000) {
    errors.push("正文可见计数必须是 1 到 1000 的整数，且包含正文内 tag。");
  }
  if (!Number.isSafeInteger(observation.imageCount) || Number(observation.imageCount) < 0 || Number(observation.imageCount) > 9) {
    errors.push("图片可见数量必须是 0 到 9 的整数。");
  }
  if (facts.titleCount !== null && observation.titleCount !== facts.titleCount) errors.push("标题计数与冻结 Build 不一致。");
  if (facts.bodyCount !== null && observation.bodyCount !== facts.bodyCount) errors.push("正文计数与冻结 Build 不一致。");
  if (facts.imageCount !== null && observation.imageCount !== facts.imageCount) errors.push("图片数量与冻结 Build 不一致。");
  if (Number(observation.imageCount) > 0) {
    if (observation.imagePlacement !== "bottom_attachments_only") errors.push("图片必须位于正文底部附件区。");
    if (!observation.bottomAttachmentPreviewVisible) errors.push("必须看到正文底部图片预览。");
    if (!observation.attachmentPreviewCropSafe) errors.push("必须确认预览裁切没有损坏关键信息。");
  }
  if (!observation.aiAssistedCreationSelected) errors.push("必须选择“含AI辅助创作”。");
  if (!observation.realNameCommentsOnlyDisabled) errors.push("本流程要求“仅限实名评论”保持关闭。");
  if (!observation.nicknameWatermarkDisabled) errors.push("本流程要求昵称水印保持关闭。");
  if (!observation.titleAndBodyMatchFrozenBuild) errors.push("必须逐项核对标题与正文仍匹配冻结 Build。");
  if (!observation.inlineTopicsMatchFrozenBody) errors.push("必须确认 tag 已直接写在正文中且与冻结正文一致。");
  if (!observation.normalReadingPass) errors.push("必须确认编辑器中的正常阅读与渲染通过。");
  if (!observation.contentFidelityPass) errors.push("必须确认核心论点、事实边界与证据含义没有丢失。");
  if (!compatibilityEvidence.length || compatibilityEvidence.some((item) => PLACEHOLDER_EVIDENCE.test(item))) {
    errors.push("兼容性门禁至少需要一条非占位证据。");
  }
  if (!fidelityEvidence.length || fidelityEvidence.some((item) => PLACEHOLDER_EVIDENCE.test(item))) {
    errors.push("内容还原门禁至少需要一条非占位证据。");
  }
  return { ok: errors.length === 0, errors };
}

export function makeMaimaiGatePayloads(build: ContentBuildRecord, observation: MaimaiEditorObservation) {
  const validation = validateMaimaiEditorObservation(build, observation);
  if (!validation.ok) throw new Error(validation.errors.join("\n"));
  const compatibilityEvidence = uniqueEvidence(observation.compatibilityEvidence);
  const fidelityEvidence = uniqueEvidence(observation.fidelityEvidence);
  const sharedDetails = {
    workflowId: MAIMAI_RELEASE_WORKFLOW.id,
    workflowVersion: MAIMAI_RELEASE_WORKFLOW.version,
    platform: "maimai",
    profileKey: MAIMAI_RELEASE_WORKFLOW.profileKey,
    observedAt: observation.observedAt,
    visibleEditorObserved: true,
    editorUrl: observation.editorUrl,
    platformVisibleCounters: {
      title: { count: observation.titleCount, limit: 20 },
      bodyIncludingInlineTags: { count: observation.bodyCount, limit: 1000 },
    },
    titleAndBodyMatchFrozenBuild: true,
    inlineTopicsMatchFrozenBody: true,
    aiAssistedCreationSelected: true,
    settings: {
      realNameCommentsOnly: false,
      nicknameWatermark: false,
    },
    images: {
      count: observation.imageCount,
      placement: observation.imagePlacement,
      bottomPreviewObserved: Number(observation.imageCount) === 0 || observation.bottomAttachmentPreviewVisible,
      cropSafe: Number(observation.imageCount) === 0 || observation.attachmentPreviewCropSafe,
    },
    targetProfileSha256: build.targetProfileSha256,
    contractSha256: build.contractSha256,
    externalSubmissionPerformed: false,
  };
  return [
    {
      buildId: build.id,
      gateKind: "compatibility" as const,
      result: "pass" as const,
      artifactSha256: build.artifactSha256,
      evidence: compatibilityEvidence,
      details: { ...sharedDetails, normalReadingPass: true },
    },
    {
      buildId: build.id,
      gateKind: "fidelity" as const,
      result: "pass" as const,
      artifactSha256: build.artifactSha256,
      evidence: fidelityEvidence,
      details: { ...sharedDetails, contentFidelityPass: true },
    },
  ];
}

export function projectMaimaiReleaseFlows(snapshot: LifecycleSnapshot): MaimaiFlowProjection[] {
  const targets = new Map(snapshot.platformTargets.filter(isMaimaiTarget).map((target) => [target.id, target]));
  return snapshot.builds
    .filter((build) => targets.has(build.targetProfileId))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .map((build) => {
      const target = targets.get(build.targetProfileId)!;
      const compatibilityGate = latestBoundGate(snapshot, build, "compatibility");
      const fidelityGate = latestBoundGate(snapshot, build, "fidelity");
      const releases = snapshot.releases
        .filter((item) => item.buildId === build.id)
        .sort((left, right) => Number(right.lifecycleState === "active") - Number(left.lifecycleState === "active")
          || right.updatedAt.localeCompare(left.updatedAt));
      const release = releases[0] ?? null;
      const complete: Record<MaimaiWorkflowStepId, boolean> = {
        build: build.state === "built",
        compatibility: compatibilityGate?.result === "pass",
        fidelity: fidelityGate?.result === "pass",
        release: Boolean(release),
        approval: release?.approvalState === "approved",
        external_click: Boolean(release && release.submissionState !== "not_submitted"),
        submission: release?.submissionState === "submission_accepted",
        destination: release?.destinationState === "backend_verified",
        public: release?.publicState === "public_verified",
      };
      let currentAssigned = false;
      const blocked = build.state === "failed" || build.state === "superseded" || release?.approvalState === "rejected" || release?.lifecycleState !== (release ? "active" : undefined);
      const steps = MAIMAI_RELEASE_WORKFLOW.steps.map((step) => {
        let state: MaimaiWorkflowStepState = "pending";
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
