import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  VIDEO_PLATFORM_TARGETS,
  XIAOHONGSHU_VIDEO_PLATFORM_TARGET,
  ZHIHU_VIDEO_PLATFORM_TARGET,
} from "../app/platform-target-contracts.ts";
import { platformCapabilitiesForTarget, platformTargetContentKind } from "../app/platform-capability-filter.ts";
import {
  VIDEO_RELEASE_WORKFLOW,
  makeVideoGatePayloads,
  projectVideoReleaseFlows,
  validateVideoEditorObservation,
  videoEditorUrlMatches,
  videoPublicUrlMatches,
} from "../app/video-release-workflow.ts";

const route = readFileSync(new URL("../app/api/lifecycle/route.ts", import.meta.url), "utf8");
const distributionUi = readFileSync(new URL("../app/DistributionHub.tsx", import.meta.url), "utf8");
const advancedUi = readFileSync(new URL("../app/LifecycleConsole.tsx", import.meta.url), "utf8");
const videoUi = readFileSync(new URL("../app/VideoReleaseFlow.tsx", import.meta.url), "utf8");
const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");

const sha = (character) => character.repeat(64);

function target(constant) {
  return {
    ...constant,
    connectionMode: "manual",
    status: "active",
    profileSha256: sha(constant.platform === "xiaohongshu" ? "b" : "c"),
    createdAt: "2000-01-01T00:00:00.000Z",
  };
}

function build(videoTarget) {
  return {
    id: `content-build-${videoTarget.platform}-1`, projectId: "project-1", articleId: "article-1", branchId: "branch-1",
    revisionId: "revision-1", sourceTitle: "公开视频合成示例", sourceBodySha256: sha("a"), targetProfileId: videoTarget.id,
    targetProfileSha256: videoTarget.profileSha256, adaptationContractId: "contract-1", contractSha256: sha("d"),
    sliceKind: "full", state: "built", artifactRef: "video.mp4", artifactSha256: sha("e"), artifactMediaType: "video/mp4",
    artifactManifest: {}, failureSummary: "", createdAt: "2000-01-01T00:00:00.000Z", builtAt: "2000-01-01T00:01:00.000Z",
    updatedAt: "2000-01-01T00:01:00.000Z",
  };
}

function observation(platform, extra = {}) {
  return {
    observedAt: "2000-01-01T00:02:00.000Z",
    editorUrl: platform === "xiaohongshu"
      ? "https://creator.xiaohongshu.com/publish/publish?from=menu&target=video"
      : "https://www.zhihu.com/upload-video",
    editorVisible: true, uploadProgressPercent: 100, uploadComplete: true, transcodeComplete: true,
    coverSaved: true, coverPreviewVisible: true, coverCropSafe: true, coverSource: "uploaded_image",
    coverRatio: platform === "xiaohongshu" ? "3:4" : "observed-custom-ratio",
    titlePresent: true, descriptionPresent: true, titleCount: platform === "xiaohongshu" ? 12 : null,
    descriptionCount: platform === "xiaohongshu" ? 300 : null, topicsReviewed: true, disclosuresReviewed: true,
    publishingSettingsReviewed: true, videoMarkSelected: platform === "zhihu", originalVideoSettingReviewed: true,
    metadataMatchesFrozenBuild: true, previewPlaybackPass: true, contentFidelityPass: true,
    compatibilityEvidence: ["fixture:upload-complete"], fidelityEvidence: ["fixture:metadata-match"],
    ...extra,
  };
}

function capability(id, name, description) {
  return {
    id, name, description, kind: "skill", dimension: "publishing", stages: ["distribution"], availability: "available",
    indexedAdoption: "unassessed", adoptionBasis: "", entryPath: "", root: "", gateInput: [], gateOutput: [], scripts: [],
    materials: [], tags: [], sourceDigest: sha("f"),
  };
}

test("小红书与知乎视频作为独立目标加入种子，不覆盖 article 目标", () => {
  assert.deepEqual(VIDEO_PLATFORM_TARGETS.map((item) => item.profileKey), ["xiaohongshu.video", "zhihu.video"]);
  assert.equal(XIAOHONGSHU_VIDEO_PLATFORM_TARGET.id, "target-xiaohongshu-video-manual-v4");
  assert.equal(ZHIHU_VIDEO_PLATFORM_TARGET.id, "target-zhihu-video-manual-v4");
  assert.equal(XIAOHONGSHU_VIDEO_PLATFORM_TARGET.version, "manual-1.2.1");
  assert.equal(ZHIHU_VIDEO_PLATFORM_TARGET.version, "manual-1.2.1");
  assert.deepEqual(XIAOHONGSHU_VIDEO_PLATFORM_TARGET.supersedesIds, ["target-xiaohongshu-video-manual-v1", "target-xiaohongshu-video-manual-v2", "target-xiaohongshu-video-manual-v3"]);
  assert.deepEqual(ZHIHU_VIDEO_PLATFORM_TARGET.supersedesIds, ["target-zhihu-video-manual-v1", "target-zhihu-video-manual-v2", "target-zhihu-video-manual-v3"]);
  assert.match(route, /\.\.\.ARTICLE_PLATFORM_TARGETS[\s\S]*\.\.\.VIDEO_PLATFORM_TARGETS/);
  assert.match(route, /profileKey === "xiaohongshu\.video"[\s\S]*profileKey === "zhihu\.video"/);
  assert.match(route, /supersedesIds[\s\S]*status = 'superseded'/);
});

test("实测 Profile 冻结页面明示限制，未显示的硬限制保持 unknown", () => {
  const xhs = XIAOHONGSHU_VIDEO_PLATFORM_TARGET.profile;
  assert.equal(xhs.constraints.video.maxDurationSeconds, 14_400);
  assert.equal(xhs.constraints.video.maxFileSizeDisplay, "20 GB");
  assert.equal(xhs.constraints.video.maxFileSizeBytes.status, "unknown");
  assert.deepEqual(xhs.constraints.video.recommendedContainers, ["mp4", "mov"]);
  assert.deepEqual(xhs.constraints.cover.cropRatios, ["原始", "3:4", "4:3", "1:1"]);
  assert.ok(xhs.constraints.disclosures.contentTypeOptions.includes("内容包含营销广告"));
  assert.equal(xhs.constraints.title.maxCharacters, 20);
  assert.equal(xhs.constraints.description.maxCharacters, 1000);
  assert.equal(xhs.observedThisRun.uploadedVideoDurationDisplay, "");
  assert.equal(xhs.observedThisRun.coverEvaluation, "not_checked");
  assert.equal(xhs.observedThisRun.pkCoverEnabled, false);
  assert.equal(xhs.observedThisRun.backendStatusObserved, "not_checked");
  assert.equal(xhs.observedThisRun.independentPublicPlayback.verified, false);
  assert.deepEqual(xhs.observedThisRun.independentPublicPlayback.currentTimeRangeSeconds, []);
  assert.deepEqual(xhs.evidenceRefs, ["contract:video-manual-preflight"]);

  const zhihu = ZHIHU_VIDEO_PLATFORM_TARGET.profile;
  assert.equal(zhihu.constraints.video.maxOutputResolution.label, "1080P");
  assert.equal(zhihu.constraints.video.oversizedResolutionBehavior, "transcode_to_1080p");
  assert.equal(zhihu.constraints.title.maxCharacters.status, "unknown");
  assert.equal(zhihu.constraints.description.maxCharacters.status, "unknown");
  assert.equal(zhihu.constraints.cover.acceptedExtensions.status, "unknown");
  assert.equal(zhihu.constraints.disclosures.videoMarkRequired, true);
  assert.equal(zhihu.observedThisRun.uploadedFileSizeDisplay, "");
  assert.deepEqual(zhihu.observedThisRun.publicRouteKinds, ["pin", "zvideo"]);
  assert.equal(zhihu.observedThisRun.publicRouteKindObservedThisRun, "not_checked");
  assert.equal(zhihu.observedThisRun.backendStatusObserved, "not_checked");
  assert.equal(zhihu.observedThisRun.independentPublicPlayback.verified, false);
  assert.deepEqual(zhihu.observedThisRun.independentPublicPlayback.currentTimeRangeSeconds, []);
  assert.deepEqual(zhihu.evidenceRefs, ["contract:video-manual-preflight"]);
});

test("Skill 候选按 mediaKind 隔离：视频看到视频能力，文章不混入视频能力", () => {
  const xhsVideo = target(XIAOHONGSHU_VIDEO_PLATFORM_TARGET);
  const xhsArticle = { ...xhsVideo, id: "article-target", profileKey: "xiaohongshu.article", profile: { mediaKind: "article" } };
  const articleSkill = capability("skill:xhs-article", "publish-xiaohongshu-long-article", "Publish a Xiaohongshu long article");
  const videoSkill = capability("skill:video", "analyze-video-knowledge-graph", "Analyze video frames and playback evidence");
  const capabilities = [articleSkill, videoSkill];
  const forVideo = platformCapabilitiesForTarget(capabilities, xhsVideo);
  const forArticle = platformCapabilitiesForTarget(capabilities, xhsArticle);
  assert.equal(platformTargetContentKind(xhsVideo), "video");
  assert.deepEqual([...forVideo.direct, ...forVideo.generic].map((item) => item.id), ["skill:video"]);
  assert.deepEqual([...forArticle.direct, ...forArticle.generic].map((item) => item.id), ["skill:xhs-article"]);
});

test("视频上传页双门禁接受完整小红书与知乎观察，并生成当前摘要绑定", () => {
  for (const constant of [XIAOHONGSHU_VIDEO_PLATFORM_TARGET, ZHIHU_VIDEO_PLATFORM_TARGET]) {
    const currentTarget = target(constant);
    const currentBuild = build(currentTarget);
    const currentObservation = observation(currentTarget.platform);
    assert.deepEqual(validateVideoEditorObservation(currentTarget, currentBuild, currentObservation), { ok: true, errors: [] });
    const payloads = makeVideoGatePayloads(currentTarget, currentBuild, currentObservation);
    assert.deepEqual(payloads.map((item) => item.gateKind), ["compatibility", "fidelity"]);
    assert.equal(payloads[0].details.upload.progressPercent, 100);
    assert.equal(payloads[0].details.externalSubmissionPerformed, false);
    assert.equal(payloads[0].details.targetProfileSha256, currentBuild.targetProfileSha256);
  }
});

test("上传不足、转码未完成、封面未保存、知乎必填项缺失与占位证据全部 fail closed", () => {
  const zhihu = target(ZHIHU_VIDEO_PLATFORM_TARGET);
  const result = validateVideoEditorObservation(zhihu, build(zhihu), observation("zhihu", {
    uploadProgressPercent: 99, transcodeComplete: false, coverSaved: false, titlePresent: false, descriptionPresent: false,
    videoMarkSelected: false, publicSettingsReviewed: false, compatibilityEvidence: ["pending"], fidelityEvidence: [],
  }));
  assert.equal(result.ok, false);
  for (const expected of ["上传进度", "封面", "标题与介绍", "视频标记", "非占位证据"]) {
    assert.match(result.errors.join("\n"), new RegExp(expected));
  }
});

test("编辑页与公开视频 URL 精确绑定平台和远端 ID", () => {
  assert.equal(videoEditorUrlMatches("xiaohongshu", "https://creator.xiaohongshu.com/publish/publish?target=video"), true);
  assert.equal(videoEditorUrlMatches("xiaohongshu", "https://creator.xiaohongshu.com/publish/publish?target=article"), false);
  assert.equal(videoEditorUrlMatches("zhihu", "https://www.zhihu.com/upload-video"), true);
  assert.equal(videoPublicUrlMatches("zhihu", "https://www.zhihu.com/pin/12345", "12345"), true);
  assert.equal(videoPublicUrlMatches("zhihu", "https://www.zhihu.com/zvideo/12345", "12345"), true);
  assert.equal(videoPublicUrlMatches("zhihu", "https://www.zhihu.com/pin/999", "12345"), false);
  assert.equal(videoPublicUrlMatches("zhihu", "https://www.zhihu.com/zvideo/999", "12345"), false);
  assert.equal(videoPublicUrlMatches("xiaohongshu", "https://www.xiaohongshu.com/explore/abc12345", "abc12345"), true);
  assert.equal(videoPublicUrlMatches("xiaohongshu", "https://evil.example/explore/abc12345", "abc12345"), false);
});

test("四层工作流不把 submitting 或 public URL 文字冒充完成", () => {
  assert.deepEqual(VIDEO_RELEASE_WORKFLOW.layers.map((item) => item.id), ["preparation", "acceptance", "backend", "public_playback"]);
  assert.deepEqual(VIDEO_RELEASE_WORKFLOW.steps.map((item) => item.id), [
    "upload_transcode", "cover", "metadata", "release", "approval", "single_submit", "platform_acceptance", "backend_status", "public_playback",
  ]);
  const currentTarget = target(XIAOHONGSHU_VIDEO_PLATFORM_TARGET);
  const currentBuild = build(currentTarget);
  const gate = (kind) => ({
    id: `gate-${kind}`, buildId: currentBuild.id, projectId: "project-1", articleId: "article-1", gateKind: kind, result: "pass",
    artifactSha256: currentBuild.artifactSha256, targetProfileSha256: currentBuild.targetProfileSha256,
    contractSha256: currentBuild.contractSha256, evidence: ["real"], details: {}, inputSha256: sha("f"),
    createdAt: kind === "compatibility" ? "2000-01-01T00:02:00.000Z" : "2000-01-01T00:03:00.000Z",
  });
  const release = {
    id: "release-1", projectId: "project-1", articleId: "article-1", buildId: currentBuild.id,
    buildArtifactSha256: currentBuild.artifactSha256, targetProfileId: currentTarget.id, targetProfileSha256: currentTarget.profileSha256,
    approvalState: "approved", submissionState: "submitting", destinationState: "not_checked", publicState: "not_checked",
    lifecycleState: "active", remoteRecordId: "", destinationUrl: "", publicUrl: "", approvalNote: "", submissionEvidence: [],
    destinationEvidence: [], publicEvidence: [], lockVersion: 3, createdAt: "2000-01-01T00:04:00.000Z", updatedAt: "2000-01-01T00:04:00.000Z",
  };
  const projection = projectVideoReleaseFlows({
    ok: true, storage: "d1-local", articleId: "article-1", projects: [], platformTargets: [currentTarget], adaptationContracts: [],
    builds: [currentBuild], buildGates: [gate("compatibility"), gate("fidelity")], releases: [release], metricDefinitions: [],
    metricSnapshots: [], metricValues: [], retrospectives: [], ruleCandidates: [], events: [],
  })[0];
  const states = Object.fromEntries(projection.steps.map((item) => [item.id, item.state]));
  assert.equal(states.single_submit, "complete");
  assert.equal(states.platform_acceptance, "current");
  assert.equal(states.backend_status, "pending");
  assert.equal(states.public_playback, "pending");
  assert.match(videoUi, /文脉不会登录平台或点击发布。结果不明时保持当前状态，先只读探测后台记录与公开页，不会自动重试。/);
  assert.match(videoUi, /已记录平台接受提交；后台记录与公开页面仍需分别核验/);
  assert.match(videoUi, /视频后台记录已核验；公开播放仍未成立/);
  assert.match(videoUi, /发布证据链闭环不等于效果已核验；播放量、完播率或业务效果仍需在指定观察期内另建指标证据。/);
});

test("服务端与专属 UI 阻止通用控制台绕过单次提交和公开播放门禁", () => {
  assert.match(route, /function isVideoTargetRow[\s\S]*videoTargetPlatform/);
  assert.match(route, /requireCurrentVideoStructuredGates/);
  assert.match(route, /singleSubmitCount[\s\S]*!== 1/);
  assert.match(route, /row\.destination_state !== "backend_verified"/);
  assert.match(route, /playbackStartedObserved[\s\S]*continuedAudioVideoObserved/);
  assert.match(videoUi, /可访问还不够，必须真的开始播放/);
  assert.match(videoUi, /结果不明保持 submitting/);
  assert.match(distributionUi, /<VideoReleaseFlow/);
  assert.match(distributionUi, /实测证据边界/);
  assert.match(distributionUi, /note: selectedProfileNote/);
  assert.match(advancedUi, /selectedBuildIsVideo[\s\S]*打开视频发布流/);
  assert.match(advancedUi, /selectedReleaseIsVideo[\s\S]*避免绕过/);
  assert.match(readme, /发布准备不等于提交接受/);
  assert.match(readme, /目标记录核验或公开可见/);
});
