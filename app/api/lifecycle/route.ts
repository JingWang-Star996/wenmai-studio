import { env } from "cloudflare:workers";
import { ManagementAuthError } from "../../management-auth-core";
import { managementActorId, requireManagementSession } from "../../management-auth";
import type { ReleaseFacts } from "../../release-control-v2";
import { ARTICLE_PLATFORM_TARGETS, MAIMAI_PLATFORM_TARGET, VIDEO_PLATFORM_TARGETS } from "../../platform-target-contracts";
import { validateArticlePublicationSemanticGate, validatePlatformCanonicalContractBinding } from "../../article-publication-semantic-gate";
import { FACTORY_RECIPES } from "../../factory-recipes";
import {
  INFORMATION_COVER_BASELINE_ID,
  INFORMATION_COVER_PROFILE_SHA256,
  INFORMATION_COVER_RECIPE_STEP_IDS,
  validateInformationCoverEvidenceReceipt,
  type InformationCoverEvidenceReceipt,
} from "../../information-cover-workflow";
import {
  MAIMAI_RELEASE_WORKFLOW,
  isMaimaiHttpsUrl,
  maimaiRecordUrlMatches,
} from "../../maimai-release-workflow";
import {
  VIDEO_RELEASE_WORKFLOW,
  videoDestinationUrlMatches,
  videoEditorUrlMatches,
  videoPublicUrlMatches,
  type VideoPlatform,
} from "../../video-release-workflow";

import {
  BUILD_GATE_KINDS,
  BUILD_STATES,
  CONTRACT_STATES,
  GATE_RESULTS,
  METRIC_VALIDATION_STATES,
  METRIC_MISSING_POLICIES,
  METRIC_OBSERVATION_STATES,
  METRIC_VALUE_KINDS,
  PROJECT_EXECUTION_STATES,
  PROJECT_PHASES,
  RELEASE_APPROVAL_STATES,
  RELEASE_READINESS_STATES,
  RELEASE_DESTINATION_STATES,
  RELEASE_LIFECYCLE_STATES,
  RELEASE_PUBLIC_STATES,
  RELEASE_SUBMISSION_STATES,
  RETROSPECTIVE_STATES,
  RULE_CANDIDATE_STATES,
  SLICE_KINDS,
  type AdaptationContractRecord,
  type ArticleProjectRecord,
  type BuildGateRunRecord,
  type BuildInputCurrentness,
  type ContentBuildRecord,
  type ContentBuildInputBindingRecord,
  type ContentReleaseRecord,
  type LifecycleEventRecord,
  type MetricDefinitionRecord,
  type MetricSnapshotRecord,
  type MetricValueRecord,
  type PlatformTargetRecord,
  type RetrospectiveRecord,
  type RuleCandidateRecord,
} from "../../lifecycle-types";

type D1Row = Record<string, string | number | null>;
type BoundValue = string | number | null;

const SHA256_RE = /^[a-f0-9]{64}$/;
const COMMAND_ID_RE = /^[A-Za-z0-9._:-]{1,160}$/;
const JSON_BYTE_LIMIT = 80_000;
const phaseSet = new Set<string>(PROJECT_PHASES);
const executionSet = new Set<string>(PROJECT_EXECUTION_STATES);
const sliceSet = new Set<string>(SLICE_KINDS);
const contractStateSet = new Set<string>(CONTRACT_STATES);
const buildStateSet = new Set<string>(BUILD_STATES);
const gateKindSet = new Set<string>(BUILD_GATE_KINDS);
const gateResultSet = new Set<string>(GATE_RESULTS);
const releaseApprovalSet = new Set<string>(RELEASE_APPROVAL_STATES);
const releaseReadinessSet = new Set<string>(RELEASE_READINESS_STATES);
const releaseSubmissionSet = new Set<string>(RELEASE_SUBMISSION_STATES);
const releaseDestinationSet = new Set<string>(RELEASE_DESTINATION_STATES);
const releasePublicSet = new Set<string>(RELEASE_PUBLIC_STATES);
const releaseLifecycleSet = new Set<string>(RELEASE_LIFECYCLE_STATES);
const metricValidationSet = new Set<string>(METRIC_VALIDATION_STATES);
const metricValueKindSet = new Set<string>(METRIC_VALUE_KINDS);
const metricMissingPolicySet = new Set<string>(METRIC_MISSING_POLICIES);
const metricObservationSet = new Set<string>(METRIC_OBSERVATION_STATES);
const retrospectiveStateSet = new Set<string>(RETROSPECTIVE_STATES);
const ruleStateSet = new Set<string>(RULE_CANDIDATE_STATES);

const PROJECT_PHASE_TRANSITIONS: Record<string, Set<string>> = {
  pitch: new Set(["planning"]),
  planning: new Set(["pitch", "production"]),
  production: new Set(["planning", "packaging"]),
  packaging: new Set(["production", "release"]),
  release: new Set(["packaging", "operate"]),
  operate: new Set(["release", "retrospective"]),
  retrospective: new Set(["operate"]),
};

const PROJECT_EXECUTION_TRANSITIONS: Record<string, Set<string>> = {
  proposed: new Set(["active", "cancelled"]),
  active: new Set(["blocked", "paused", "completed", "cancelled"]),
  blocked: new Set(["active", "paused", "cancelled"]),
  paused: new Set(["active", "cancelled"]),
  completed: new Set(["active"]),
  cancelled: new Set(),
};

const CONTRACT_TRANSITIONS: Record<string, Set<string>> = {
  draft: new Set(["approved", "cancelled"]),
  approved: new Set(["superseded", "cancelled"]),
  superseded: new Set(),
  cancelled: new Set(),
};

const RETROSPECTIVE_TRANSITIONS: Record<string, Set<string>> = {
  draft: new Set(["reviewed"]),
  reviewed: new Set(["closed"]),
  closed: new Set(),
};

const RULE_TRANSITIONS: Record<string, Set<string>> = {
  candidate: new Set(["testing", "deferred", "rejected"]),
  testing: new Set(["verified", "deferred", "rejected"]),
  verified: new Set(["adopted", "testing", "deferred", "rejected"]),
  adopted: new Set(),
  deferred: new Set(["testing", "rejected"]),
  rejected: new Set(),
};

type DefaultPlatformTarget = {
  id: string;
  supersedesIds?: readonly string[];
  profileKey: string;
  platform: string;
  label: string;
  version: string;
  profile?: Record<string, unknown>;
};

const DEFAULT_PLATFORM_TARGETS: readonly DefaultPlatformTarget[] = [
  ...ARTICLE_PLATFORM_TARGETS,
  { id: "target-website-manual-v1", profileKey: "website.article", platform: "website", label: "自有网站", version: "manual-1.0.0" },
  ...VIDEO_PLATFORM_TARGETS,
  MAIMAI_PLATFORM_TARGET,
];

const DEFAULT_RAW_METRIC_DEFINITIONS = [
  {
    id: "metric-definition-raw-views-v1",
    definitionKey: "raw.views",
    version: "1.0.0",
    label: "曝光 / Views",
    description: "来源平台后台显示的原始曝光值；只在同一来源口径下解释，不证明跨平台等价。",
    valueKind: "integer",
    unit: "count",
    missingPolicy: "unknown",
    constraints: { minimum: 0 },
  },
  {
    id: "metric-definition-raw-reads-v1",
    definitionKey: "raw.reads",
    version: "1.0.0",
    label: "有效阅读 / Reads",
    description: "来源平台后台显示的原始有效阅读值；不同平台可能采用不同判定，不直接横向比较。",
    valueKind: "integer",
    unit: "count",
    missingPolicy: "unknown",
    constraints: { minimum: 0 },
  },
  {
    id: "metric-definition-raw-completion-rate-v1",
    definitionKey: "raw.completionRate",
    version: "1.0.0",
    label: "完成率",
    description: "来源平台给出的原始完成率，使用 0 到 1 的比例；不推断各平台分母相同。",
    valueKind: "decimal",
    unit: "ratio_0_1",
    missingPolicy: "unknown",
    constraints: { minimum: 0, maximum: 1 },
  },
  {
    id: "metric-definition-raw-saves-v1",
    definitionKey: "raw.saves",
    version: "1.0.0",
    label: "收藏 / Saves",
    description: "来源平台后台显示的原始收藏值；只冻结观察，不声称平台行为语义完全相同。",
    valueKind: "integer",
    unit: "count",
    missingPolicy: "unknown",
    constraints: { minimum: 0 },
  },
  {
    id: "metric-definition-raw-comments-v1",
    definitionKey: "raw.comments",
    version: "1.0.0",
    label: "评论 / Comments",
    description: "来源平台后台显示的原始评论值；只冻结观察，不含互动质量判断。",
    valueKind: "integer",
    unit: "count",
    missingPolicy: "unknown",
    constraints: { minimum: 0 },
  },
] as const;

const RAW_METRIC_SCOPE = {
  kind: "source_platform_raw",
  crossPlatformComparable: false,
  normalizationApplied: false,
  note: "定义只冻结来源平台原始口径；比较前仍需核对平台、字段和统计窗口。",
} as const;

class LifecycleApiError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

function database() {
  if (!env.DB) throw new LifecycleApiError("本地生命周期数据库尚未连接", 503);
  return env.DB;
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalValue(child)]));
  }
  return value;
}

function canonicalJson(value: unknown) {
  return JSON.stringify(canonicalValue(value));
}

async function sha256Text(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function digest(value: unknown) {
  return sha256Text(canonicalJson(value));
}

function isoNow() {
  return new Date().toISOString();
}

function cleanText(value: unknown, maximum: number, preserveWhitespace = false) {
  if (typeof value !== "string") return "";
  const text = preserveWhitespace ? value.replace(/\r\n?/g, "\n") : value.trim();
  if (text.length > maximum) throw new LifecycleApiError(`输入超过 ${maximum.toLocaleString("zh-CN")} 个字符`);
  return text;
}

function requiredText(value: unknown, label: string, maximum: number, preserveWhitespace = false) {
  const text = cleanText(value, maximum, preserveWhitespace);
  if (!text) throw new LifecycleApiError(`缺少${label}`);
  return text;
}

function requiredSha(value: unknown, label: string) {
  const text = requiredText(value, label, 64).toLowerCase();
  if (!SHA256_RE.test(text)) throw new LifecycleApiError(`${label}必须是小写 SHA-256`);
  return text;
}

function requiredPositiveInteger(value: unknown, label: string) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) throw new LifecycleApiError(`${label}必须是正整数`);
  return number;
}

function jsonObject(value: unknown, label: string, allowEmpty = true): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new LifecycleApiError(`${label}必须是 JSON 对象`);
  const object = value as Record<string, unknown>;
  if (!allowEmpty && Object.keys(object).length === 0) throw new LifecycleApiError(`${label}不能为空`);
  if (new TextEncoder().encode(canonicalJson(object)).byteLength > JSON_BYTE_LIMIT) {
    throw new LifecycleApiError(`${label}超过 ${JSON_BYTE_LIMIT.toLocaleString("zh-CN")} 字节`);
  }
  return object;
}

function stringArray(value: unknown, label: string, required = false, maximum = 100) {
  if (!Array.isArray(value)) {
    if (required) throw new LifecycleApiError(`${label}必须是非空字符串数组`);
    return [];
  }
  const items = [...new Set(value.map((item) => cleanText(item, 1000)).filter(Boolean))].slice(0, maximum);
  if (required && items.length === 0) throw new LifecycleApiError(`${label}至少需要一条记录`);
  return items;
}

function requiredIso(value: unknown, label: string) {
  const text = requiredText(value, label, 80);
  const timestamp = Date.parse(text);
  if (!Number.isFinite(timestamp)) throw new LifecycleApiError(`${label}不是有效时间`);
  return new Date(timestamp).toISOString();
}

function requiredHttpUrl(value: unknown, label: string) {
  const text = requiredText(value, label, 2000);
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new LifecycleApiError(`${label}必须是完整 URL`);
  }
  if (!new Set(["http:", "https:"]).has(url.protocol)) throw new LifecycleApiError(`${label}只允许 http 或 https`);
  return url.toString();
}

function parseJson<T>(value: unknown, fallback: T): T {
  try {
    return JSON.parse(String(value ?? "")) as T;
  } catch {
    return fallback;
  }
}

function platformTargetEnabled(row: D1Row) {
  const profile = parseJson<Record<string, unknown>>(row.profile_json, {});
  return profile.enabled !== false;
}

function isMaimaiTargetRow(row: D1Row | null) {
  return Boolean(row && row.platform === "maimai");
}

function videoTargetPlatform(row: D1Row | null): VideoPlatform | null {
  if (!row) return null;
  const profile = parseJson<Record<string, unknown>>(row.profile_json, {});
  if (profile.mediaKind !== "video") return null;
  if (row.platform === "xiaohongshu" && row.profile_key === "xiaohongshu.video") return "xiaohongshu";
  if (row.platform === "zhihu" && row.profile_key === "zhihu.video") return "zhihu";
  return null;
}

function isVideoTargetRow(row: D1Row | null) {
  return videoTargetPlatform(row) !== null;
}

const MAIMAI_REMOTE_ID_RE = /^\d+$/;
const MAIMAI_PLACEHOLDER_EVIDENCE = /(?:^|[\s:/._-])(todo|tbd|pending|unknown|placeholder|待补|待定|未知)(?:$|[\s:/._-])/i;

function requiredBoolean(value: unknown, label: string, expected: boolean) {
  if (value !== expected) throw new LifecycleApiError(`${label}必须明确为 ${String(expected)}`);
  return expected;
}

function requiredNonNegativeInteger(value: unknown, label: string, maximum: number) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0 || number > maximum) {
    throw new LifecycleApiError(`${label}必须是 0 到 ${maximum} 的整数`);
  }
  return number;
}

function requireMaimaiWorkflowIdentity(details: Record<string, unknown>, label: string) {
  if (details.workflowId !== MAIMAI_RELEASE_WORKFLOW.id || details.workflowVersion !== MAIMAI_RELEASE_WORKFLOW.version) {
    throw new LifecycleApiError(`${label}未绑定当前脉脉发布流版本`);
  }
}

function requiredMaimaiUrl(value: unknown, label: string) {
  const url = requiredHttpUrl(value, label);
  if (!isMaimaiHttpsUrl(url)) throw new LifecycleApiError(`${label}必须是 maimai.cn 的 HTTPS 页面`);
  return url;
}

function requiredMaimaiRecordUrl(value: unknown, label: string, remoteRecordId: string) {
  const url = requiredMaimaiUrl(value, label);
  if (!maimaiRecordUrlMatches(url, remoteRecordId)) {
    throw new LifecycleApiError(`${label}的 /community/feed-detail/{id} 与远端记录 ID 不一致`);
  }
  return url;
}

function requiredMaimaiRemoteRecordId(value: string) {
  if (!MAIMAI_REMOTE_ID_RE.test(value)) throw new LifecycleApiError("脉脉远端动态 ID 必须是纯数字");
  return value;
}

function requireMaimaiGateDetails(row: D1Row, gateKind: string, details: Record<string, unknown>) {
  requireMaimaiWorkflowIdentity(details, "脉脉编辑器门禁");
  if (details.platform !== "maimai" || details.profileKey !== MAIMAI_RELEASE_WORKFLOW.profileKey) {
    throw new LifecycleApiError("脉脉编辑器门禁的平台身份不匹配");
  }
  if (details.targetProfileSha256 !== row.target_profile_sha256 || details.contractSha256 !== row.contract_sha256) {
    throw new LifecycleApiError("脉脉编辑器门禁未绑定当前画像或适配合同摘要", 409);
  }
  requiredBoolean(details.visibleEditorObserved, "visibleEditorObserved", true);
  requiredMaimaiUrl(details.editorUrl, "脉脉编辑器地址");
  requiredIso(details.observedAt, "脉脉编辑器观察时间");
  requiredBoolean(details.externalSubmissionPerformed, "externalSubmissionPerformed", false);
  requiredBoolean(details.aiAssistedCreationSelected, "aiAssistedCreationSelected", true);
  requiredBoolean(details.titleAndBodyMatchFrozenBuild, "titleAndBodyMatchFrozenBuild", true);
  requiredBoolean(details.inlineTopicsMatchFrozenBody, "inlineTopicsMatchFrozenBody", true);

  const counters = jsonObject(details.platformVisibleCounters, "脉脉可见计数器", false);
  const titleCounter = jsonObject(counters.title, "脉脉标题计数器", false);
  const bodyCounter = jsonObject(counters.bodyIncludingInlineTags, "脉脉正文计数器", false);
  if (requiredPositiveInteger(titleCounter.limit, "脉脉标题上限") !== 20) throw new LifecycleApiError("脉脉标题计数器上限必须是 20");
  if (requiredPositiveInteger(bodyCounter.limit, "脉脉正文上限") !== 1000) throw new LifecycleApiError("脉脉正文计数器上限必须是 1000");
  const titleCount = requiredNonNegativeInteger(titleCounter.count, "脉脉标题可见计数", 20);
  const bodyCount = requiredNonNegativeInteger(bodyCounter.count, "脉脉正文可见计数", 1000);
  if (bodyCount < 1) throw new LifecycleApiError("脉脉正文不能为空");

  const manifest = parseJson<Record<string, unknown>>(row.artifact_manifest_json, {});
  if (Number.isSafeInteger(manifest.titleVisibleCharacters) && Number(manifest.titleVisibleCharacters) !== titleCount) {
    throw new LifecycleApiError("脉脉标题计数与冻结 Build 不一致", 409);
  }
  if (Number.isSafeInteger(manifest.bodyVisibleUtf16) && Number(manifest.bodyVisibleUtf16) !== bodyCount) {
    throw new LifecycleApiError("脉脉正文计数与冻结 Build 不一致", 409);
  }

  const images = jsonObject(details.images, "脉脉图片预览", false);
  const imageCount = requiredNonNegativeInteger(images.count, "脉脉图片数量", 9);
  if (Number.isSafeInteger(manifest.imageCount) && Number(manifest.imageCount) !== imageCount) {
    throw new LifecycleApiError("脉脉图片数量与冻结 Build 不一致", 409);
  }
  if (images.placement !== "bottom_attachments_only") throw new LifecycleApiError("脉脉图片必须是正文底部附件");
  if (imageCount > 0) {
    requiredBoolean(images.bottomPreviewObserved, "bottomPreviewObserved", true);
    requiredBoolean(images.cropSafe, "cropSafe", true);
  }

  const settings = jsonObject(details.settings, "脉脉发布设置", false);
  requiredBoolean(settings.realNameCommentsOnly, "realNameCommentsOnly", false);
  requiredBoolean(settings.nicknameWatermark, "nicknameWatermark", false);
  if (gateKind === "compatibility") requiredBoolean(details.normalReadingPass, "normalReadingPass", true);
  if (gateKind === "fidelity") requiredBoolean(details.contentFidelityPass, "contentFidelityPass", true);
}

type MaimaiBoundGates = { compatibility: D1Row; fidelity: D1Row };

async function requireCurrentMaimaiStructuredGates(
  db: D1Database,
  build: D1Row,
  target: D1Row | null,
): Promise<MaimaiBoundGates | null> {
  if (!isMaimaiTargetRow(target)) return null;
  const rows = {} as MaimaiBoundGates;
  for (const gateKind of ["compatibility", "fidelity"] as const) {
    const gate = await db.prepare(`SELECT * FROM lifecycle_build_gate_runs
      WHERE build_id = ? AND gate_kind = ? AND artifact_sha256 = ?
        AND target_profile_sha256 = ? AND contract_sha256 = ?
      ORDER BY rowid DESC LIMIT 1`)
      .bind(build.id, gateKind, build.artifact_sha256, build.target_profile_sha256, build.contract_sha256)
      .first<D1Row>();
    if (!gate || gate.result !== "pass") throw new LifecycleApiError(`脉脉当前 ${gateKind} 门禁尚未通过`, 409);
    requireMaimaiGateDetails(build, gateKind, parseJson<Record<string, unknown>>(gate.details_json, {}));
    rows[gateKind] = gate;
  }
  return rows;
}

function requireMaimaiApprovalBinding(row: D1Row, build: D1Row, gates: MaimaiBoundGates, value: unknown) {
  const binding = jsonObject(value, "脉脉批准绑定", false);
  requireMaimaiWorkflowIdentity(binding, "脉脉批准绑定");
  requiredBoolean(binding.confirmed, "脉脉批准确认", true);
  requiredIso(binding.confirmedAt, "脉脉批准时间");
  if (binding.authorityRole !== "content_owner") throw new LifecycleApiError("脉脉 Release 必须由内容所有者批准");
  if (binding.releaseId !== row.id
    || binding.buildId !== row.build_id
    || binding.buildArtifactSha256 !== row.build_artifact_sha256
    || binding.targetProfileSha256 !== row.target_profile_sha256
    || binding.contractSha256 !== build.contract_sha256
    || binding.compatibilityGateId !== gates.compatibility.id
    || binding.fidelityGateId !== gates.fidelity.id) {
    throw new LifecycleApiError("脉脉批准未绑定当前 Release、Build、摘要或最新双门禁", 409);
  }
  return binding;
}

function requireMaimaiActionConfirmation(row: D1Row, build: D1Row, gates: MaimaiBoundGates, value: unknown) {
  const confirmation = jsonObject(value, "脉脉现场确认", false);
  requireMaimaiWorkflowIdentity(confirmation, "脉脉现场确认");
  requiredBoolean(confirmation.confirmed, "脉脉现场确认", true);
  requiredBoolean(confirmation.singleExternalClickAuthorized, "singleExternalClickAuthorized", true);
  requiredBoolean(confirmation.externalClickWillBePerformedSeparately, "externalClickWillBePerformedSeparately", true);
  if (confirmation.authorityRole !== "content_owner") throw new LifecycleApiError("脉脉最终点击必须由内容所有者现场确认");
  if (confirmation.releaseId !== row.id
    || confirmation.buildId !== row.build_id
    || confirmation.buildArtifactSha256 !== row.build_artifact_sha256
    || confirmation.targetProfileSha256 !== row.target_profile_sha256
    || confirmation.contractSha256 !== build.contract_sha256
    || confirmation.compatibilityGateId !== gates.compatibility.id
    || confirmation.fidelityGateId !== gates.fidelity.id) {
    throw new LifecycleApiError("脉脉现场确认未绑定当前 Release、Build、摘要或最新双门禁", 409);
  }
  const confirmedAt = requiredIso(confirmation.confirmedAt, "脉脉现场确认时间");
  const age = Date.now() - Date.parse(confirmedAt);
  if (age < -5 * 60_000 || age > MAIMAI_RELEASE_WORKFLOW.actionConfirmationTtlMinutes * 60_000) {
    throw new LifecycleApiError(`脉脉现场确认必须在 ${MAIMAI_RELEASE_WORKFLOW.actionConfirmationTtlMinutes} 分钟内完成`);
  }
  if (Date.parse(confirmedAt) < Date.parse(String(row.updated_at))) {
    throw new LifecycleApiError("这次脉脉现场确认早于 Release 的最新状态，未被采用。Release、Build 和门禁记录仍保留，API 未执行外部点击；请刷新最新状态后重新确认。若外部点击已经发生，只做只读核验，不得再次点击。", 409);
  }
  return confirmation;
}

function requireMaimaiSubmissionDetails(targetState: string, details: Record<string, unknown>) {
  requireMaimaiWorkflowIdentity(details, "脉脉提交结果");
  requiredBoolean(details.externalClickPerformed, "externalClickPerformed", true);
  if (requiredPositiveInteger(details.singleClickCount, "singleClickCount") !== 1) throw new LifecycleApiError("脉脉最终发布只能记录一次外部点击");
  if (targetState === "submission_accepted") {
    requiredBoolean(details.platformAcceptedObserved, "platformAcceptedObserved", true);
    requiredBoolean(details.composerClearedObserved, "composerClearedObserved", true);
    requiredBoolean(details.feedItemObserved, "feedItemObserved", true);
  } else {
    requiredBoolean(details.platformFailureObserved, "platformFailureObserved", true);
    requiredIso(details.failureObservedAt, "脉脉明确失败观察时间");
    if (details.failureKind !== "visible_platform_error") throw new LifecycleApiError("脉脉明确失败必须来自可见平台错误或拒绝");
    const evidenceRef = requiredText(details.failureEvidenceRef, "脉脉明确失败证据引用", 2000);
    if (MAIMAI_PLACEHOLDER_EVIDENCE.test(evidenceRef)) throw new LifecycleApiError("脉脉明确失败证据不能是占位文本");
  }
}

function requireMaimaiDestinationDetails(targetState: string, remoteRecordId: string, details: Record<string, unknown>) {
  requireMaimaiWorkflowIdentity(details, "脉脉后台核验");
  if (targetState === "backend_verified") {
    requiredBoolean(details.backendRecordObserved, "backendRecordObserved", true);
    requiredBoolean(details.authorSessionObserved, "authorSessionObserved", true);
    requiredBoolean(details.sameRemoteRecordConfirmed, "sameRemoteRecordConfirmed", true);
    if (details.remoteRecordId !== remoteRecordId) throw new LifecycleApiError("脉脉后台核验的远端 ID 不一致", 409);
  }
}

function requireMaimaiPublicDetails(targetState: string, remoteRecordId: string, details: Record<string, unknown>) {
  requireMaimaiWorkflowIdentity(details, "脉脉公开核验");
  if (["public_verified", "not_public"].includes(targetState)) {
    requiredBoolean(details.independentAudienceProbeObserved, "independentAudienceProbeObserved", true);
    if (details.probeMode !== "independent_non_author_session") throw new LifecycleApiError("脉脉公开核验必须来自独立非作者会话");
    requiredBoolean(details.sameRemoteRecordConfirmed, "sameRemoteRecordConfirmed", true);
    if (details.remoteRecordId !== remoteRecordId) throw new LifecycleApiError("脉脉公开核验的远端 ID 不一致", 409);
  }
}

type VideoBoundGates = { compatibility: D1Row; fidelity: D1Row };

function requireVideoWorkflowIdentity(details: Record<string, unknown>, label: string) {
  if (details.workflowId !== VIDEO_RELEASE_WORKFLOW.id || details.workflowVersion !== VIDEO_RELEASE_WORKFLOW.version) {
    throw new LifecycleApiError(`${label}未绑定当前视频发布流版本`);
  }
}

function requiredNonPlaceholderText(value: unknown, label: string, maximum = 2000) {
  const text = requiredText(value, label, maximum);
  if (MAIMAI_PLACEHOLDER_EVIDENCE.test(text)) throw new LifecycleApiError(`${label}不能是占位文本`);
  return text;
}

function requiredVideoRemoteRecordId(platform: VideoPlatform, value: string) {
  if (MAIMAI_PLACEHOLDER_EVIDENCE.test(value)) throw new LifecycleApiError("视频远端记录 ID 不能是占位文本");
  if (platform === "zhihu" && !/^\d+$/.test(value)) throw new LifecycleApiError("知乎视频远端 ID 必须是纯数字");
  if (platform === "xiaohongshu" && !/^[A-Za-z0-9_-]{8,128}$/.test(value)) {
    throw new LifecycleApiError("小红书视频远端 ID 格式无效");
  }
  return value;
}

function requireVideoGateDetails(row: D1Row, target: D1Row, gateKind: string, details: Record<string, unknown>) {
  const platform = videoTargetPlatform(target);
  if (!platform) throw new LifecycleApiError("视频门禁未绑定规范视频画像", 409);
  requireVideoWorkflowIdentity(details, "视频发布页门禁");
  if (details.platform !== platform || details.profileKey !== target.profile_key) throw new LifecycleApiError("视频门禁的平台身份不匹配");
  if (details.targetProfileSha256 !== row.target_profile_sha256 || details.contractSha256 !== row.contract_sha256) {
    throw new LifecycleApiError("视频门禁未绑定当前画像或适配合同摘要", 409);
  }
  requiredBoolean(details.visibleEditorObserved, "visibleEditorObserved", true);
  const editorUrl = requiredHttpUrl(details.editorUrl, "视频发布页地址");
  if (!videoEditorUrlMatches(platform, editorUrl)) throw new LifecycleApiError("视频发布页地址与目标平台不匹配");
  requiredIso(details.observedAt, "视频发布页观察时间");
  requiredBoolean(details.externalSubmissionPerformed, "externalSubmissionPerformed", false);

  const upload = jsonObject(details.upload, "视频上传状态", false);
  if (requiredNonNegativeInteger(upload.progressPercent, "视频上传进度", 100) !== 100) throw new LifecycleApiError("视频上传进度必须达到 100");
  requiredBoolean(upload.uploadComplete, "uploadComplete", true);
  requiredBoolean(upload.transcodeComplete, "transcodeComplete", true);

  const cover = jsonObject(details.cover, "视频封面", false);
  requiredBoolean(cover.saved, "cover.saved", true);
  requiredBoolean(cover.previewVisible, "cover.previewVisible", true);
  requiredBoolean(cover.cropSafe, "cover.cropSafe", true);
  requiredNonPlaceholderText(cover.source, "视频封面来源", 80);
  const coverRatio = requiredNonPlaceholderText(cover.ratio, "视频封面比例", 80);
  if (platform === "xiaohongshu" && !["原始", "3:4", "4:3", "1:1"].includes(coverRatio)) {
    throw new LifecycleApiError("小红书封面比例必须是本次可见页面支持的原始、3:4、4:3 或 1:1");
  }

  const metadata = jsonObject(details.metadata, "视频元数据", false);
  requiredBoolean(metadata.topicsReviewed, "topicsReviewed", true);
  requiredBoolean(metadata.disclosuresReviewed, "disclosuresReviewed", true);
  requiredBoolean(metadata.publishingSettingsReviewed, "publishingSettingsReviewed", true);
  requiredBoolean(metadata.originalVideoSettingReviewed, "originalVideoSettingReviewed", true);
  requiredBoolean(metadata.matchesFrozenBuild, "metadata.matchesFrozenBuild", true);
  if (platform === "xiaohongshu") {
    requiredNonNegativeInteger(metadata.titleCount, "小红书标题可见计数", 20);
    requiredNonNegativeInteger(metadata.descriptionCount, "小红书简介可见计数", 1000);
  } else {
    requiredBoolean(metadata.titlePresent, "知乎标题已填写", true);
    requiredBoolean(metadata.descriptionPresent, "知乎介绍已填写", true);
    requiredBoolean(metadata.videoMarkSelected, "知乎视频标记已选择", true);
  }
  requiredBoolean(details.previewPlaybackPass, "previewPlaybackPass", true);
  if (gateKind === "compatibility") requiredBoolean(details.normalPlatformPreviewPass, "normalPlatformPreviewPass", true);
  if (gateKind === "fidelity") requiredBoolean(details.contentFidelityPass, "contentFidelityPass", true);
}

async function requireCurrentVideoStructuredGates(db: D1Database, build: D1Row, target: D1Row | null): Promise<VideoBoundGates | null> {
  if (!isVideoTargetRow(target)) return null;
  const rows = {} as VideoBoundGates;
  for (const gateKind of ["compatibility", "fidelity"] as const) {
    const gate = await db.prepare(`SELECT * FROM lifecycle_build_gate_runs
      WHERE build_id = ? AND gate_kind = ? AND artifact_sha256 = ?
        AND target_profile_sha256 = ? AND contract_sha256 = ?
      ORDER BY rowid DESC LIMIT 1`)
      .bind(build.id, gateKind, build.artifact_sha256, build.target_profile_sha256, build.contract_sha256)
      .first<D1Row>();
    if (!gate || gate.result !== "pass") throw new LifecycleApiError(`视频当前 ${gateKind} 门禁尚未通过`, 409);
    requireVideoGateDetails(build, target!, gateKind, parseJson<Record<string, unknown>>(gate.details_json, {}));
    rows[gateKind] = gate;
  }
  return rows;
}

function requireVideoApprovalBinding(row: D1Row, build: D1Row, gates: VideoBoundGates, value: unknown) {
  const binding = jsonObject(value, "视频批准绑定", false);
  requireVideoWorkflowIdentity(binding, "视频批准绑定");
  requiredBoolean(binding.confirmed, "视频批准确认", true);
  requiredIso(binding.confirmedAt, "视频批准时间");
  if (binding.authorityRole !== "content_owner") throw new LifecycleApiError("视频 Release 必须由内容所有者批准");
  if (binding.releaseId !== row.id || binding.buildId !== row.build_id
    || binding.buildArtifactSha256 !== row.build_artifact_sha256
    || binding.targetProfileSha256 !== row.target_profile_sha256
    || binding.contractSha256 !== build.contract_sha256
    || binding.compatibilityGateId !== gates.compatibility.id
    || binding.fidelityGateId !== gates.fidelity.id) {
    throw new LifecycleApiError("视频批准未绑定当前 Release、Build、摘要或最新双门禁", 409);
  }
  return binding;
}

function requireVideoActionConfirmation(row: D1Row, build: D1Row, gates: VideoBoundGates, value: unknown) {
  const confirmation = jsonObject(value, "视频现场确认", false);
  requireVideoWorkflowIdentity(confirmation, "视频现场确认");
  requiredBoolean(confirmation.confirmed, "视频现场确认", true);
  requiredBoolean(confirmation.singleExternalSubmitAuthorized, "singleExternalSubmitAuthorized", true);
  requiredBoolean(confirmation.externalSubmitWillBePerformedSeparately, "externalSubmitWillBePerformedSeparately", true);
  if (confirmation.authorityRole !== "content_owner") throw new LifecycleApiError("视频最终提交必须由内容所有者现场确认");
  if (confirmation.releaseId !== row.id || confirmation.buildId !== row.build_id
    || confirmation.buildArtifactSha256 !== row.build_artifact_sha256
    || confirmation.targetProfileSha256 !== row.target_profile_sha256
    || confirmation.contractSha256 !== build.contract_sha256
    || confirmation.compatibilityGateId !== gates.compatibility.id
    || confirmation.fidelityGateId !== gates.fidelity.id) {
    throw new LifecycleApiError("视频现场确认未绑定当前 Release、Build、摘要或最新双门禁", 409);
  }
  const confirmedAt = requiredIso(confirmation.confirmedAt, "视频现场确认时间");
  const age = Date.now() - Date.parse(confirmedAt);
  if (age < -5 * 60_000 || age > VIDEO_RELEASE_WORKFLOW.actionConfirmationTtlMinutes * 60_000) {
    throw new LifecycleApiError(`视频现场确认必须在 ${VIDEO_RELEASE_WORKFLOW.actionConfirmationTtlMinutes} 分钟内完成`);
  }
  if (Date.parse(confirmedAt) < Date.parse(String(row.updated_at))) {
    throw new LifecycleApiError("这次视频现场确认早于 Release 的最新状态，未被采用。Release、Build 和门禁记录仍保留，API 未执行外部提交；请刷新后重新确认。若外部提交已经发生，只读核验平台状态，不得再次提交。", 409);
  }
  return confirmation;
}

function requireVideoSubmissionDetails(targetState: string, details: Record<string, unknown>) {
  requireVideoWorkflowIdentity(details, "视频提交结果");
  requiredBoolean(details.externalSubmitPerformed, "externalSubmitPerformed", true);
  if (requiredPositiveInteger(details.singleSubmitCount, "singleSubmitCount") !== 1) throw new LifecycleApiError("视频发布只能记录一次外部提交");
  if (targetState === "submission_accepted") requiredBoolean(details.platformAcceptedObserved, "platformAcceptedObserved", true);
  else {
    requiredBoolean(details.platformFailureObserved, "platformFailureObserved", true);
    requiredIso(details.failureObservedAt, "视频明确失败观察时间");
    if (details.failureKind !== "visible_platform_error") throw new LifecycleApiError("视频明确失败必须来自可见平台错误或拒绝");
    requiredNonPlaceholderText(details.failureEvidenceRef, "视频明确失败证据引用");
  }
}

function requireVideoDestinationDetails(targetState: string, remoteRecordId: string, details: Record<string, unknown>) {
  requireVideoWorkflowIdentity(details, "视频后台核验");
  if (targetState === "backend_verified") {
    requiredBoolean(details.backendRecordObserved, "backendRecordObserved", true);
    requiredBoolean(details.creatorSessionObserved, "creatorSessionObserved", true);
    requiredBoolean(details.sameRemoteRecordConfirmed, "sameRemoteRecordConfirmed", true);
    if (details.remoteRecordId !== remoteRecordId) throw new LifecycleApiError("视频后台核验的远端 ID 不一致", 409);
    requiredNonPlaceholderText(details.backendStatus, "视频后台状态", 160);
  }
}

function requireVideoPublicDetails(targetState: string, remoteRecordId: string, details: Record<string, unknown>) {
  requireVideoWorkflowIdentity(details, "公开视频核验");
  if (["public_verified", "not_public"].includes(targetState)) {
    requiredBoolean(details.independentAudienceProbeObserved, "independentAudienceProbeObserved", true);
    if (details.probeMode !== "independent_non_author_session") throw new LifecycleApiError("公开视频核验必须来自独立非作者会话");
    requiredBoolean(details.sameRemoteRecordConfirmed, "sameRemoteRecordConfirmed", true);
    if (details.remoteRecordId !== remoteRecordId) throw new LifecycleApiError("公开视频核验的远端 ID 不一致", 409);
  }
  if (targetState === "public_verified") {
    requiredBoolean(details.publicPageLoadedObserved, "publicPageLoadedObserved", true);
    requiredBoolean(details.playbackStartedObserved, "playbackStartedObserved", true);
    requiredBoolean(details.continuedAudioVideoObserved, "continuedAudioVideoObserved", true);
  }
}

function assertSameOrigin(request: Request) {
  const url = new URL(request.url);
  const origin = request.headers.get("origin");
  const fetchSite = request.headers.get("sec-fetch-site");
  if (origin !== url.origin || (fetchSite && !["same-origin", "none"].includes(fetchSite))) {
    throw new LifecycleApiError("生命周期管理写入只接受当前站点的同源请求", 403);
  }
}

async function ensureLifecycleSchema() {
  const db = database();
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS lifecycle_article_projects (
      id TEXT PRIMARY KEY NOT NULL,
      article_id TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      intent TEXT NOT NULL DEFAULT '',
      owner TEXT NOT NULL DEFAULT '我',
      phase TEXT NOT NULL DEFAULT 'pitch' CHECK (phase IN ('pitch','planning','production','packaging','release','operate','retrospective')),
      execution_state TEXT NOT NULL DEFAULT 'proposed' CHECK (execution_state IN ('proposed','active','blocked','paused','completed','cancelled')),
      lock_version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_lifecycle_projects_article_state ON lifecycle_article_projects(article_id, execution_state, updated_at)"),
    db.prepare(`CREATE TABLE IF NOT EXISTS lifecycle_platform_targets (
      id TEXT PRIMARY KEY NOT NULL,
      profile_key TEXT NOT NULL,
      platform TEXT NOT NULL,
      label TEXT NOT NULL,
      version TEXT NOT NULL,
      connection_mode TEXT NOT NULL DEFAULT 'manual' CHECK (connection_mode = 'manual'),
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','superseded')),
      profile_json TEXT NOT NULL DEFAULT '{}',
      profile_sha256 TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(profile_key, version)
    )`),
    db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_lifecycle_targets_active_key ON lifecycle_platform_targets(profile_key) WHERE status = 'active'"),
    db.prepare(`CREATE TABLE IF NOT EXISTS lifecycle_adaptation_contracts (
      id TEXT PRIMARY KEY NOT NULL,
      project_id TEXT NOT NULL,
      article_id TEXT NOT NULL,
      target_profile_id TEXT NOT NULL,
      target_profile_sha256 TEXT NOT NULL,
      source_revision_id TEXT NOT NULL,
      source_body_sha256 TEXT NOT NULL,
      slice_kind TEXT NOT NULL CHECK (slice_kind IN ('full','demo','excerpt','promo')),
      title TEXT NOT NULL,
      invariants_json TEXT NOT NULL DEFAULT '{}',
      rules_json TEXT NOT NULL DEFAULT '{}',
      contract_sha256 TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','superseded','cancelled')),
      approval_note TEXT NOT NULL DEFAULT '',
      lock_version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_lifecycle_contracts_article_status ON lifecycle_adaptation_contracts(article_id, status, updated_at)"),
    db.prepare(`CREATE TABLE IF NOT EXISTS lifecycle_builds (
      id TEXT PRIMARY KEY NOT NULL,
      project_id TEXT NOT NULL,
      article_id TEXT NOT NULL,
      branch_id TEXT NOT NULL,
      revision_id TEXT NOT NULL,
      source_title TEXT NOT NULL,
      source_body_sha256 TEXT NOT NULL,
      target_profile_id TEXT NOT NULL,
      target_profile_sha256 TEXT NOT NULL,
      adaptation_contract_id TEXT NOT NULL,
      contract_sha256 TEXT NOT NULL,
      slice_kind TEXT NOT NULL CHECK (slice_kind IN ('full','demo','excerpt','promo')),
      state TEXT NOT NULL DEFAULT 'planned' CHECK (state IN ('planned','built','failed','superseded')),
      artifact_ref TEXT NOT NULL DEFAULT '',
      artifact_sha256 TEXT NOT NULL DEFAULT '',
      artifact_media_type TEXT NOT NULL DEFAULT '',
      artifact_manifest_json TEXT NOT NULL DEFAULT '{}',
      failure_summary TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      built_at TEXT,
      updated_at TEXT NOT NULL
    )`),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_lifecycle_builds_article_state ON lifecycle_builds(article_id, state, updated_at)"),
    db.prepare(`CREATE TABLE IF NOT EXISTS lifecycle_build_input_bindings (
      build_id TEXT PRIMARY KEY NOT NULL,
      input_binding_sha256 TEXT NOT NULL,
      package_id TEXT NOT NULL,
      branch_id TEXT NOT NULL,
      branch_lock_version INTEGER NOT NULL CHECK (branch_lock_version >= 1),
      revision_id TEXT NOT NULL,
      source_body_sha256 TEXT NOT NULL,
      composition_id TEXT NOT NULL,
      composition_sha256 TEXT NOT NULL,
      slice_id TEXT NOT NULL,
      slice_sha256 TEXT NOT NULL,
      publication_version_id TEXT NOT NULL,
      publication_registration_sha256 TEXT NOT NULL,
      cover_run_id TEXT NOT NULL,
      cover_recipe_id TEXT NOT NULL,
      cover_recipe_version TEXT NOT NULL,
      cover_recipe_sha256 TEXT NOT NULL,
      cover_receipt_id TEXT NOT NULL,
      cover_receipt_schema_version TEXT NOT NULL,
      cover_receipt_json TEXT NOT NULL CHECK (json_valid(cover_receipt_json) AND json_type(cover_receipt_json) = 'object'),
      cover_receipt_sha256 TEXT NOT NULL,
      cover_receipt_chain_json TEXT NOT NULL CHECK (json_valid(cover_receipt_chain_json) AND json_type(cover_receipt_chain_json) = 'array'),
      cover_receipt_chain_sha256 TEXT NOT NULL,
      cover_artifact_sha256 TEXT NOT NULL,
      cover_baseline_id TEXT NOT NULL,
      cover_baseline_sha256 TEXT NOT NULL,
      cover_profile_sha256 TEXT NOT NULL,
      created_at TEXT NOT NULL,
      CHECK (
        length(input_binding_sha256) = 64
        AND length(source_body_sha256) = 64
        AND length(composition_sha256) = 64
        AND length(slice_sha256) = 64
        AND length(publication_registration_sha256) = 64
        AND length(cover_recipe_sha256) = 64
        AND length(cover_receipt_sha256) = 64
        AND length(cover_receipt_chain_sha256) = 64
        AND length(cover_artifact_sha256) = 64
        AND length(cover_baseline_sha256) = 64
        AND length(cover_profile_sha256) = 64
      )
    )`),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_lifecycle_build_input_package_branch ON lifecycle_build_input_bindings(package_id, branch_id, created_at)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_lifecycle_build_input_cover_receipt ON lifecycle_build_input_bindings(cover_run_id, cover_receipt_id)"),
    db.prepare(`CREATE TABLE IF NOT EXISTS lifecycle_build_gate_runs (
      id TEXT PRIMARY KEY NOT NULL,
      build_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      article_id TEXT NOT NULL,
      gate_kind TEXT NOT NULL CHECK (gate_kind IN ('compatibility','fidelity')),
      result TEXT NOT NULL CHECK (result IN ('pass','fail','inconclusive')),
      artifact_sha256 TEXT NOT NULL,
      target_profile_sha256 TEXT NOT NULL,
      contract_sha256 TEXT NOT NULL,
      evidence_json TEXT NOT NULL DEFAULT '[]',
      details_json TEXT NOT NULL DEFAULT '{}',
      input_sha256 TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_lifecycle_gates_build_kind ON lifecycle_build_gate_runs(build_id, gate_kind, created_at)"),
    db.prepare(`CREATE TABLE IF NOT EXISTS lifecycle_releases (
      id TEXT PRIMARY KEY NOT NULL,
      project_id TEXT NOT NULL,
      article_id TEXT NOT NULL,
      build_id TEXT NOT NULL,
      build_artifact_sha256 TEXT NOT NULL,
      target_profile_id TEXT NOT NULL,
      target_profile_sha256 TEXT NOT NULL,
      approval_state TEXT NOT NULL DEFAULT 'draft' CHECK (approval_state IN ('draft','approved','rejected')),
      readiness_state TEXT NOT NULL DEFAULT 'draft' CHECK (readiness_state IN ('draft','artifact_validated','ready_to_submit','stale','blocked')),
      readiness_evidence_sha256 TEXT NOT NULL DEFAULT '',
      ready_at TEXT,
      expires_at TEXT,
      submission_state TEXT NOT NULL DEFAULT 'not_submitted' CHECK (submission_state IN ('not_submitted','submitting','submission_accepted','submission_failed')),
      destination_state TEXT NOT NULL DEFAULT 'not_checked' CHECK (destination_state IN ('not_checked','backend_verified','not_found','inconclusive')),
      public_state TEXT NOT NULL DEFAULT 'not_checked' CHECK (public_state IN ('not_checked','public_verified','not_public','inconclusive')),
      lifecycle_state TEXT NOT NULL DEFAULT 'active' CHECK (lifecycle_state IN ('active','withdrawn','superseded')),
      remote_record_id TEXT NOT NULL DEFAULT '',
      destination_url TEXT NOT NULL DEFAULT '',
      public_url TEXT NOT NULL DEFAULT '',
      approval_note TEXT NOT NULL DEFAULT '',
      submission_evidence_json TEXT NOT NULL DEFAULT '[]',
      destination_evidence_json TEXT NOT NULL DEFAULT '[]',
      public_evidence_json TEXT NOT NULL DEFAULT '[]',
      lock_version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_lifecycle_releases_article_state ON lifecycle_releases(article_id, lifecycle_state, updated_at)"),
    db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_lifecycle_releases_active_build ON lifecycle_releases(build_id) WHERE lifecycle_state = 'active'"),
    db.prepare(`CREATE TABLE IF NOT EXISTS lifecycle_metric_snapshots (
      id TEXT PRIMARY KEY NOT NULL,
      release_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      article_id TEXT NOT NULL,
      source_mode TEXT NOT NULL CHECK (source_mode IN ('manual','export')),
      source_label TEXT NOT NULL,
      window_start TEXT NOT NULL,
      window_end TEXT NOT NULL,
      captured_at TEXT NOT NULL,
      metrics_json TEXT NOT NULL,
      evidence_ref TEXT NOT NULL,
      measurement_sha256 TEXT NOT NULL,
      definition_set_sha256 TEXT,
      validation_state TEXT NOT NULL DEFAULT 'collected' CHECK (validation_state IN ('collected','validated','inconclusive')),
      validation_note TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    )`),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_lifecycle_metrics_release_time ON lifecycle_metric_snapshots(release_id, captured_at)"),
    db.prepare(`CREATE TABLE IF NOT EXISTS lifecycle_metric_definitions (
      id TEXT PRIMARY KEY NOT NULL,
      definition_key TEXT NOT NULL,
      version TEXT NOT NULL,
      label TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      value_kind TEXT NOT NULL CHECK (value_kind IN ('integer','decimal')),
      unit TEXT NOT NULL,
      missing_policy TEXT NOT NULL DEFAULT 'unknown' CHECK (missing_policy IN ('unknown','reject','not_applicable')),
      constraints_json TEXT NOT NULL DEFAULT '{}',
      scope_json TEXT NOT NULL DEFAULT '{}',
      definition_sha256 TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','superseded')),
      created_at TEXT NOT NULL,
      UNIQUE(definition_key, version),
      UNIQUE(definition_sha256)
    )`),
    db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_lifecycle_metric_definitions_active_key ON lifecycle_metric_definitions(definition_key) WHERE status = 'active'"),
    db.prepare(`CREATE TABLE IF NOT EXISTS lifecycle_metric_values (
      id TEXT PRIMARY KEY NOT NULL,
      snapshot_id TEXT NOT NULL,
      release_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      article_id TEXT NOT NULL,
      definition_id TEXT NOT NULL,
      definition_sha256 TEXT NOT NULL,
      observation_state TEXT NOT NULL CHECK (observation_state IN ('observed','missing','not_applicable')),
      value_json TEXT NOT NULL DEFAULT 'null',
      value_sha256 TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(snapshot_id, definition_id)
    )`),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_lifecycle_metric_values_article_snapshot ON lifecycle_metric_values(article_id, snapshot_id)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_lifecycle_metric_values_definition ON lifecycle_metric_values(definition_id, created_at)"),
    db.prepare(`CREATE TABLE IF NOT EXISTS lifecycle_retrospectives (
      id TEXT PRIMARY KEY NOT NULL,
      project_id TEXT NOT NULL,
      article_id TEXT NOT NULL,
      release_id TEXT,
      title TEXT NOT NULL,
      summary TEXT NOT NULL DEFAULT '',
      evidence_refs_json TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','reviewed','closed')),
      lock_version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_lifecycle_retrospectives_article_status ON lifecycle_retrospectives(article_id, status, updated_at)"),
    db.prepare(`CREATE TABLE IF NOT EXISTS lifecycle_rule_candidates (
      id TEXT PRIMARY KEY NOT NULL,
      project_id TEXT NOT NULL,
      article_id TEXT NOT NULL,
      retrospective_id TEXT NOT NULL,
      title TEXT NOT NULL,
      rule_text TEXT NOT NULL,
      scope TEXT NOT NULL DEFAULT '',
      counterexamples TEXT NOT NULL DEFAULT '',
      owner TEXT NOT NULL DEFAULT '',
      implementation_target TEXT NOT NULL DEFAULT '',
      regression_ref TEXT NOT NULL DEFAULT '',
      evidence_refs_json TEXT NOT NULL DEFAULT '[]',
      state TEXT NOT NULL DEFAULT 'candidate' CHECK (state IN ('candidate','testing','verified','adopted','deferred','rejected')),
      lock_version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_lifecycle_rules_article_state ON lifecycle_rule_candidates(article_id, state, updated_at)"),
    db.prepare(`CREATE TABLE IF NOT EXISTS lifecycle_events (
      id TEXT PRIMARY KEY NOT NULL,
      article_id TEXT,
      event_type TEXT NOT NULL,
      subject_type TEXT NOT NULL,
      subject_id TEXT NOT NULL,
      payload_json TEXT NOT NULL DEFAULT '{}',
      input_sha256 TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_lifecycle_events_article_created ON lifecycle_events(article_id, created_at)"),
    db.prepare(`CREATE TABLE IF NOT EXISTS command_receipts (
      id TEXT PRIMARY KEY NOT NULL,
      command_type TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      request_sha256 TEXT NOT NULL,
      response_json TEXT NOT NULL DEFAULT '{}',
      status_code INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      completed_at TEXT
    )`),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_command_receipts_actor_created ON command_receipts(actor_id, created_at)"),
  ]);

  const metricColumns = await db.prepare("PRAGMA table_info(lifecycle_metric_snapshots)").all<D1Row>();
  if (!metricColumns.results.some((column) => column.name === "definition_set_sha256")) {
    await db.prepare("ALTER TABLE lifecycle_metric_snapshots ADD COLUMN definition_set_sha256 TEXT").run();
  }

  const createdAt = isoNow();
  const seedStatements = [];
  for (const target of DEFAULT_PLATFORM_TARGETS) {
    const genericProfile = {
      deliveryMode: "manual",
      connectionStatus: "not_connected",
      sliceKinds: [...SLICE_KINDS],
      validationScope: ["manual_import_or_upload", "normal_reading_and_rendering", "content_fidelity"],
      note: "该画像只描述人工适配与验收合同，不表示平台账号、发布 API 或数据接口已经连接。",
    };
    const profile = target.profile ?? genericProfile;
    for (const supersededId of target.supersedesIds ?? []) {
      seedStatements.push(db.prepare(`UPDATE lifecycle_platform_targets
        SET status = 'superseded'
        WHERE id = ? AND profile_key = ? AND status = 'active'`)
        .bind(supersededId, target.profileKey));
    }
    seedStatements.push(db.prepare(`INSERT OR IGNORE INTO lifecycle_platform_targets
      (id, profile_key, platform, label, version, connection_mode, status, profile_json, profile_sha256, created_at)
      VALUES (?, ?, ?, ?, ?, 'manual', 'active', ?, ?, ?)`)
      .bind(target.id, target.profileKey, target.platform, target.label, target.version, canonicalJson(profile), await digest(profile), createdAt));
  }
  for (const definition of DEFAULT_RAW_METRIC_DEFINITIONS) {
    const definitionCore = {
      definitionKey: definition.definitionKey,
      version: definition.version,
      label: definition.label,
      description: definition.description,
      valueKind: definition.valueKind,
      unit: definition.unit,
      missingPolicy: definition.missingPolicy,
      constraints: definition.constraints,
      scope: RAW_METRIC_SCOPE,
    };
    seedStatements.push(db.prepare(`INSERT OR IGNORE INTO lifecycle_metric_definitions
      (id, definition_key, version, label, description, value_kind, unit, missing_policy,
       constraints_json, scope_json, definition_sha256, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)`)
      .bind(
        definition.id,
        definition.definitionKey,
        definition.version,
        definition.label,
        definition.description,
        definition.valueKind,
        definition.unit,
        definition.missingPolicy,
        canonicalJson(definition.constraints),
        canonicalJson(RAW_METRIC_SCOPE),
        await digest(definitionCore),
        createdAt,
      ));
  }
  await db.batch(seedStatements);
  // CREATE TABLE IF NOT EXISTS cannot add columns to pre-readiness databases.
  const releaseColumns = await db.prepare("PRAGMA table_info(lifecycle_releases)").all<D1Row>();
  const existingReleaseColumns = new Set((releaseColumns.results ?? []).map((column) => String(column.name)));
  const readinessColumns: Array<[string, string]> = [
    ["readiness_state", "TEXT NOT NULL DEFAULT 'draft'"],
    ["readiness_evidence_sha256", "TEXT NOT NULL DEFAULT ''"],
    ["ready_at", "TEXT"],
    ["expires_at", "TEXT"],
  ];
  const additions = readinessColumns.filter(([name]) => !existingReleaseColumns.has(name));
  if (additions.length) {
    await db.batch(additions.map(([name, definition]) => db.prepare(`ALTER TABLE lifecycle_releases ADD COLUMN ${name} ${definition}`)));
  }
  await db.prepare("CREATE INDEX IF NOT EXISTS idx_lifecycle_releases_readiness_expiry ON lifecycle_releases(readiness_state, expires_at)").run();
  return db;
}

async function ensureWorkspaceRevisionTables(db: D1Database) {
  const rows = await db.prepare(`SELECT name FROM sqlite_master
    WHERE type = 'table' AND name IN ('article_branches','article_revisions','branch_working_copies')`).all<D1Row>();
  if (rows.results.length !== 3) {
    throw new LifecycleApiError("请先打开一次工作台，初始化分支、修订和工作副本", 503);
  }
}

const BUILD_INPUT_TABLES = [
  "article_project_packages",
  "package_branch_states",
  "package_branch_working_copies",
  "package_compositions",
  "package_composition_materializations",
  "package_slices",
  "article_publication_versions",
  "production_runs",
  "production_run_steps",
] as const;

async function ensureBuildInputTables(db: D1Database) {
  const placeholders = BUILD_INPUT_TABLES.map(() => "?").join(",");
  const rows = await db.prepare(`SELECT name FROM sqlite_master
    WHERE type = 'table' AND name IN (${placeholders})`).bind(...BUILD_INPUT_TABLES).all<D1Row>();
  if (rows.results.length !== BUILD_INPUT_TABLES.length) {
    throw new LifecycleApiError("请先初始化文章工程、PublicationVersion 与生产运行表，再冻结 Build 输入", 503);
  }
}

async function currentInformationCoverRecipeIdentity() {
  const recipe = FACTORY_RECIPES.find((item) => item.id === "evidence-led-longform-v1");
  if (!recipe) throw new LifecycleApiError("当前完整文章生产 recipe 不存在", 503);
  return {
    id: recipe.id,
    version: recipe.version,
    sha256: await sha256Text(JSON.stringify(recipe)),
  };
}

type CurrentCoverReceiptChain = {
  run: D1Row;
  receipts: InformationCoverEvidenceReceipt[];
  receiptChainJson: string;
  receiptChainSha256: string;
  finalReceipt: InformationCoverEvidenceReceipt;
  finalReceiptJson: string;
  finalReceiptSha256: string;
  finalEvidenceText: string;
  evidenceTexts: string[];
  recipe: { id: string; version: string; sha256: string };
};

async function readCurrentCoverReceiptChain(
  db: D1Database,
  input: { coverRunId: string; articleId: string; branchId: string; bodySha256: string },
): Promise<CurrentCoverReceiptChain> {
  const recipe = await currentInformationCoverRecipeIdentity();
  const [run, stepRows] = await Promise.all([
    db.prepare("SELECT * FROM production_runs WHERE id = ? LIMIT 1").bind(input.coverRunId).first<D1Row>(),
    db.prepare(`SELECT * FROM production_run_steps WHERE run_id = ?
      AND step_id IN ('cover-copy-contract','cover-visual-plan','cover-render-gates','cover-human-acceptance')
      ORDER BY position`).bind(input.coverRunId).all<D1Row>(),
  ]);
  if (!run || run.article_id !== input.articleId || run.branch_id !== input.branchId) {
    throw new LifecycleApiError("封面生产运行不存在或不属于当前 Article/分支", 409);
  }
  if (run.recipe_id !== recipe.id || run.recipe_version !== recipe.version || run.recipe_sha256 !== recipe.sha256) {
    throw new LifecycleApiError("封面生产运行未绑定当前完整生产 recipe，回执已 stale", 409);
  }
  const byStep = new Map(stepRows.results.map((row) => [String(row.step_id), row]));
  let expectedInputSha256 = input.bodySha256;
  const receipts: InformationCoverEvidenceReceipt[] = [];
  const evidenceTexts: string[] = [];
  let finalEvidenceText = "";
  for (const stepId of INFORMATION_COVER_RECIPE_STEP_IDS) {
    const step = byStep.get(stepId);
    const evidenceText = step ? parseJson<string[]>(step.evidence_json, []).at(-1) : null;
    if (!step || step.status !== "complete" || !evidenceText) {
      throw new LifecycleApiError(`封面工位 ${stepId} 未以结构化回执完成`, 409);
    }
    const validation = validateInformationCoverEvidenceReceipt(evidenceText, {
      expectedStepId: stepId,
      expectedArticleBodySha256: input.bodySha256,
      expectedInputSha256,
    });
    if (!validation.valid || !validation.receipt) {
      throw new LifecycleApiError(`封面工位 ${stepId} 回执已 stale：${validation.errors.join("；")}`, 409);
    }
    receipts.push(validation.receipt);
    evidenceTexts.push(evidenceText);
    expectedInputSha256 = validation.receipt.artifact.sha256;
    finalEvidenceText = evidenceText;
  }
  const finalReceipt = receipts.at(-1);
  if (!finalReceipt) throw new LifecycleApiError("缺少终态封面回执", 409);
  const receiptChainJson = canonicalJson(evidenceTexts);
  const normalizedReceiptChainJson = canonicalJson(receipts);
  const finalReceiptJson = canonicalJson(finalReceipt);
  return {
    run,
    receipts,
    receiptChainJson,
    receiptChainSha256: await sha256Text(normalizedReceiptChainJson),
    finalReceipt,
    finalReceiptJson,
    finalReceiptSha256: await sha256Text(finalReceiptJson),
    finalEvidenceText,
    evidenceTexts,
    recipe,
  };
}

function parseBuildInputBinding(
  row: D1Row,
  currentness: BuildInputCurrentness,
  blockers: string[],
): ContentBuildInputBindingRecord {
  return {
    buildId: String(row.build_id),
    inputBindingSha256: String(row.input_binding_sha256),
    packageId: String(row.package_id),
    branchId: String(row.branch_id),
    branchLockVersion: Number(row.branch_lock_version),
    revisionId: String(row.revision_id),
    sourceBodySha256: String(row.source_body_sha256),
    compositionId: String(row.composition_id),
    compositionSha256: String(row.composition_sha256),
    sliceId: String(row.slice_id),
    sliceSha256: String(row.slice_sha256),
    publicationVersionId: String(row.publication_version_id),
    publicationRegistrationSha256: String(row.publication_registration_sha256),
    coverRunId: String(row.cover_run_id),
    coverRecipeId: String(row.cover_recipe_id),
    coverRecipeVersion: String(row.cover_recipe_version),
    coverRecipeSha256: String(row.cover_recipe_sha256),
    coverReceiptId: String(row.cover_receipt_id),
    coverReceiptSchemaVersion: String(row.cover_receipt_schema_version),
    coverReceipt: parseJson<Record<string, unknown>>(row.cover_receipt_json, {}),
    coverReceiptSha256: String(row.cover_receipt_sha256),
    coverReceiptChainSha256: String(row.cover_receipt_chain_sha256),
    coverArtifactSha256: String(row.cover_artifact_sha256),
    coverBaselineId: String(row.cover_baseline_id),
    coverBaselineSha256: String(row.cover_baseline_sha256),
    coverProfileSha256: String(row.cover_profile_sha256),
    currentness,
    blockers,
    createdAt: String(row.created_at),
  };
}

async function evaluateBuildInputBinding(db: D1Database, buildId: string) {
  const binding = await db.prepare("SELECT * FROM lifecycle_build_input_bindings WHERE build_id = ? LIMIT 1")
    .bind(buildId).first<D1Row>();
  if (!binding) return null;
    const current = await db.prepare(`SELECT
      build.article_id AS build_article_id,
      build.project_id AS build_project_id,
      build.target_profile_id AS build_target_profile_id,
      build.target_profile_sha256 AS build_target_profile_sha256,
      build.adaptation_contract_id AS build_contract_id,
      build.contract_sha256 AS build_contract_sha256,
      build.revision_id AS build_revision_id,
      build.source_body_sha256 AS build_source_body_sha256,
      project.execution_state AS current_project_execution_state,
      adaptation.id AS current_contract_id,
      adaptation.status AS current_contract_status,
      adaptation.contract_sha256 AS current_contract_sha256,
      adaptation.project_id AS current_contract_project_id,
      adaptation.article_id AS current_contract_article_id,
      adaptation.target_profile_id AS current_contract_target_profile_id,
      adaptation.target_profile_sha256 AS current_contract_target_profile_sha256,
      adaptation.source_revision_id AS current_contract_source_revision_id,
      adaptation.source_body_sha256 AS current_contract_source_body_sha256,
      root.article_id AS package_article_id,
      root.status AS package_status,
      root.branch_model_version AS package_branch_model_version,
      root.primary_branch_id AS package_primary_branch_id,
      root.main_composition_id AS package_main_composition_id,
      root.main_composition_sha256 AS package_main_composition_sha256,
      state.head_composition_id AS current_composition_id,
      state.head_composition_sha256 AS current_composition_sha256,
      state.head_revision_id AS current_revision_id,
      state.lock_version AS current_branch_lock_version,
      state.status AS current_branch_status,
      package_copy.base_composition_id AS package_copy_composition_id,
      package_copy.base_revision_id AS package_copy_revision_id,
      package_copy.dirty AS package_copy_dirty,
      branch.head_revision_id AS article_head_revision_id,
      branch.status AS article_branch_status,
      revision.body_sha256 AS current_body_sha256,
      article_copy.base_revision_id AS article_copy_revision_id,
      article_copy.body_sha256 AS article_copy_body_sha256,
      article_copy.dirty AS article_copy_dirty,
      composition.composition_sha256 AS current_stored_composition_sha256,
      materialization.article_revision_id AS materialized_revision_id,
      materialization.article_body_sha256 AS materialized_body_sha256,
      slice.id AS current_slice_id,
      slice.slice_sha256 AS current_slice_sha256,
      slice.base_branch_lock_version AS current_slice_branch_lock_version,
      version.id AS current_publication_version_id,
      version.registration_sha256 AS current_publication_registration_sha256,
      version.target_profile_id AS current_publication_target_profile_id,
      version.target_profile_key AS current_publication_target_profile_key,
      version.target_profile_sha256 AS current_publication_target_profile_sha256,
      version.baseline_version_id AS current_baseline_version_id,
      version.baseline_branch_id AS current_baseline_branch_id,
      version.baseline_revision_id AS current_baseline_revision_id,
      version.baseline_body_sha256 AS current_baseline_body_sha256,
      version.baseline_composition_id AS current_baseline_composition_id,
      version.baseline_composition_sha256 AS current_baseline_composition_sha256,
      canonical.id AS current_canonical_version_id,
      canonical.branch_id AS current_canonical_branch_id,
      canonical.branch_lock_version AS current_canonical_branch_lock_version,
      canonical.revision_id AS current_canonical_revision_id,
      canonical.body_sha256 AS current_canonical_body_sha256,
      canonical.composition_id AS current_canonical_composition_id,
      canonical.composition_sha256 AS current_canonical_composition_sha256,
      canonical_state.status AS current_canonical_branch_state_status,
      canonical_state.lock_version AS current_canonical_state_lock_version,
      canonical_state.head_revision_id AS current_canonical_state_revision_id,
      canonical_state.head_composition_id AS current_canonical_state_composition_id,
      canonical_state.head_composition_sha256 AS current_canonical_state_composition_sha256,
      canonical_package_copy.dirty AS current_canonical_package_copy_dirty,
      canonical_package_copy.base_revision_id AS current_canonical_package_copy_revision_id,
      canonical_package_copy.base_composition_id AS current_canonical_package_copy_composition_id,
      canonical_branch.status AS current_canonical_article_branch_status,
      canonical_branch.head_revision_id AS current_canonical_article_head_revision_id,
      canonical_revision.body_sha256 AS current_canonical_head_body_sha256,
      canonical_article_copy.dirty AS current_canonical_article_copy_dirty,
      canonical_article_copy.base_revision_id AS current_canonical_article_copy_revision_id,
      canonical_article_copy.body_sha256 AS current_canonical_article_copy_body_sha256,
      canonical_composition.composition_sha256 AS current_canonical_stored_composition_sha256,
      canonical_materialization.article_revision_id AS current_canonical_materialized_revision_id,
      canonical_materialization.article_body_sha256 AS current_canonical_materialized_body_sha256,
      target.id AS current_target_id,
      target.profile_key AS current_target_profile_key,
      target.profile_sha256 AS current_target_sha256,
      target.status AS current_target_status,
      target.connection_mode AS current_target_connection_mode,
      COALESCE(json_extract(target.profile_json, '$.enabled'), 1) AS current_target_enabled
    FROM lifecycle_builds build
    LEFT JOIN lifecycle_article_projects project
      ON project.id = build.project_id AND project.article_id = build.article_id
    LEFT JOIN lifecycle_adaptation_contracts adaptation
      ON adaptation.id = build.adaptation_contract_id
    LEFT JOIN article_project_packages root ON root.id = ?
    LEFT JOIN package_branch_states state ON state.package_id = root.id AND state.branch_id = ?
    LEFT JOIN package_branch_working_copies package_copy
      ON package_copy.package_id = root.id AND package_copy.branch_id = state.branch_id
    LEFT JOIN article_branches branch ON branch.id = state.branch_id AND branch.article_id = root.article_id
    LEFT JOIN article_revisions revision
      ON revision.id = branch.head_revision_id AND revision.branch_id = branch.id AND revision.article_id = root.article_id
    LEFT JOIN branch_working_copies article_copy
      ON article_copy.branch_id = branch.id AND article_copy.article_id = root.article_id
    LEFT JOIN package_compositions composition
      ON composition.id = state.head_composition_id AND composition.package_id = root.id
    LEFT JOIN package_composition_materializations materialization
      ON materialization.package_id = root.id AND materialization.branch_id = state.branch_id
      AND materialization.composition_id = state.head_composition_id
      AND materialization.article_revision_id = state.head_revision_id
    LEFT JOIN package_slices slice ON slice.id = ? AND slice.package_id = root.id
    LEFT JOIN article_publication_versions version
      ON version.id = ? AND version.package_id = root.id AND version.state = 'active'
    LEFT JOIN article_publication_versions canonical
      ON canonical.id = version.baseline_version_id AND canonical.package_id = root.id
      AND canonical.role = 'canonical_baseline' AND canonical.state = 'active'
    LEFT JOIN package_branch_states canonical_state
      ON canonical_state.package_id = root.id AND canonical_state.branch_id = canonical.branch_id
    LEFT JOIN package_branch_working_copies canonical_package_copy
      ON canonical_package_copy.package_id = root.id
      AND canonical_package_copy.branch_id = canonical_state.branch_id
    LEFT JOIN article_branches canonical_branch
      ON canonical_branch.id = canonical.branch_id AND canonical_branch.article_id = root.article_id
    LEFT JOIN article_revisions canonical_revision
      ON canonical_revision.id = canonical_branch.head_revision_id
      AND canonical_revision.branch_id = canonical_branch.id
      AND canonical_revision.article_id = root.article_id
    LEFT JOIN branch_working_copies canonical_article_copy
      ON canonical_article_copy.branch_id = canonical_branch.id
      AND canonical_article_copy.article_id = root.article_id
    LEFT JOIN package_compositions canonical_composition
      ON canonical_composition.id = canonical_state.head_composition_id
      AND canonical_composition.package_id = root.id
    LEFT JOIN package_composition_materializations canonical_materialization
      ON canonical_materialization.package_id = root.id
      AND canonical_materialization.branch_id = canonical_state.branch_id
      AND canonical_materialization.composition_id = canonical_state.head_composition_id
      AND canonical_materialization.article_revision_id = canonical_state.head_revision_id
    LEFT JOIN lifecycle_platform_targets target ON target.id = build.target_profile_id
    WHERE build.id = ? LIMIT 1`)
    .bind(binding.package_id, binding.branch_id, binding.slice_id, binding.publication_version_id, buildId)
    .first<D1Row>();
  const blockers: string[] = [];
  if (!current
    || current.build_article_id !== current.package_article_id
    || current.package_status !== "active"
    || Number(current.package_branch_model_version ?? 0) !== 2) blockers.push("package_article_changed");
  if (!current
    || current.current_project_execution_state !== "active"
    || current.current_contract_id !== current.build_contract_id
    || current.current_contract_status !== "approved"
    || current.current_contract_sha256 !== current.build_contract_sha256
    || current.current_contract_project_id !== current.build_project_id
    || current.current_contract_article_id !== current.build_article_id
    || current.current_contract_target_profile_id !== current.build_target_profile_id
    || current.current_contract_target_profile_sha256 !== current.build_target_profile_sha256
    || current.current_contract_source_revision_id !== current.build_revision_id
    || current.current_contract_source_body_sha256 !== current.build_source_body_sha256) {
    blockers.push("adaptation_contract_changed");
  }
  if (!current
    || current.current_branch_status !== "active"
    || Number(current.current_branch_lock_version ?? 0) !== Number(binding.branch_lock_version)
    || current.current_composition_id !== binding.composition_id
    || current.current_composition_sha256 !== binding.composition_sha256
    || current.current_revision_id !== binding.revision_id) blockers.push("package_branch_head_changed");
  if (!current
    || Number(current.package_copy_dirty ?? 1) !== 0
    || current.package_copy_composition_id !== binding.composition_id
    || current.package_copy_revision_id !== binding.revision_id) blockers.push("package_working_copy_changed");
  if (!current
    || current.article_branch_status !== "active"
    || current.article_head_revision_id !== binding.revision_id
    || current.current_body_sha256 !== binding.source_body_sha256
    || Number(current.article_copy_dirty ?? 1) !== 0
    || current.article_copy_revision_id !== binding.revision_id
    || current.article_copy_body_sha256 !== binding.source_body_sha256) blockers.push("article_revision_changed");
  if (!current
    || current.current_stored_composition_sha256 !== binding.composition_sha256
    || current.materialized_revision_id !== binding.revision_id
    || current.materialized_body_sha256 !== binding.source_body_sha256) blockers.push("composition_materialization_changed");
  if (!current
    || current.current_slice_id !== binding.slice_id
    || current.current_slice_sha256 !== binding.slice_sha256
    || Number(current.current_slice_branch_lock_version ?? 0) !== Number(binding.branch_lock_version)) blockers.push("slice_changed");
  if (!current
    || current.current_publication_version_id !== binding.publication_version_id
    || current.current_publication_registration_sha256 !== binding.publication_registration_sha256
    || current.current_publication_target_profile_id !== current.build_target_profile_id
    || current.current_publication_target_profile_key !== current.current_target_profile_key
    || current.current_publication_target_profile_sha256 !== current.build_target_profile_sha256) {
    blockers.push("publication_version_changed");
  }
  if (!current
    || current.current_baseline_version_id !== current.current_canonical_version_id
    || current.current_baseline_branch_id !== current.current_canonical_branch_id
    || current.current_baseline_revision_id !== current.current_canonical_revision_id
    || current.current_baseline_body_sha256 !== current.current_canonical_body_sha256
    || current.current_baseline_composition_id !== current.current_canonical_composition_id
    || current.current_baseline_composition_sha256 !== current.current_canonical_composition_sha256
    || current.current_canonical_branch_id !== current.package_primary_branch_id
    || current.current_canonical_branch_state_status !== "active"
    || Number(current.current_canonical_state_lock_version ?? 0)
      !== Number(current.current_canonical_branch_lock_version ?? -1)
    || current.current_canonical_state_revision_id !== current.current_canonical_revision_id
    || current.current_canonical_state_composition_id !== current.current_canonical_composition_id
    || current.current_canonical_state_composition_sha256 !== current.current_canonical_composition_sha256
    || Number(current.current_canonical_package_copy_dirty ?? 1) !== 0
    || current.current_canonical_package_copy_revision_id !== current.current_canonical_revision_id
    || current.current_canonical_package_copy_composition_id !== current.current_canonical_composition_id
    || current.current_canonical_article_branch_status !== "active"
    || current.current_canonical_article_head_revision_id !== current.current_canonical_revision_id
    || current.current_canonical_head_body_sha256 !== current.current_canonical_body_sha256
    || Number(current.current_canonical_article_copy_dirty ?? 1) !== 0
    || current.current_canonical_article_copy_revision_id !== current.current_canonical_revision_id
    || current.current_canonical_article_copy_body_sha256 !== current.current_canonical_body_sha256
    || current.current_canonical_composition_id !== current.package_main_composition_id
    || current.current_canonical_composition_sha256 !== current.package_main_composition_sha256
    || current.current_canonical_stored_composition_sha256 !== current.current_canonical_composition_sha256
    || current.current_canonical_materialized_revision_id !== current.current_canonical_revision_id
    || current.current_canonical_materialized_body_sha256 !== current.current_canonical_body_sha256) {
    blockers.push("canonical_baseline_changed");
  }
  if (!current
    || current.current_target_id !== current.build_target_profile_id
    || current.current_target_status !== "active"
    || current.current_target_connection_mode !== "manual"
    || Number(current.current_target_enabled ?? 0) === 0
    || current.current_target_sha256 !== current.build_target_profile_sha256) blockers.push("target_profile_changed");
  if (binding.cover_baseline_id !== INFORMATION_COVER_BASELINE_ID
    || binding.cover_profile_sha256 !== INFORMATION_COVER_PROFILE_SHA256) blockers.push("cover_profile_changed");
  try {
    const chain = await readCurrentCoverReceiptChain(db, {
      coverRunId: String(binding.cover_run_id),
      articleId: String(current?.build_article_id ?? ""),
      branchId: String(binding.branch_id),
      bodySha256: String(binding.source_body_sha256),
    });
    if (chain.recipe.id !== binding.cover_recipe_id
      || chain.recipe.version !== binding.cover_recipe_version
      || chain.recipe.sha256 !== binding.cover_recipe_sha256) blockers.push("cover_recipe_changed");
    if (chain.receiptChainSha256 !== binding.cover_receipt_chain_sha256
      || chain.finalReceipt.receiptId !== binding.cover_receipt_id
      || chain.finalReceiptSha256 !== binding.cover_receipt_sha256
      || chain.finalReceipt.artifact.sha256 !== binding.cover_artifact_sha256
      || chain.finalReceipt.baseline.id !== binding.cover_baseline_id
      || chain.finalReceipt.baseline.sha256 !== binding.cover_baseline_sha256) blockers.push("cover_receipt_changed");
  } catch {
    blockers.push("cover_receipt_chain_stale");
  }
  return parseBuildInputBinding(binding, blockers.length === 0 ? "current" : "stale", [...new Set(blockers)]);
}

async function requireCurrentBuildInputBinding(db: D1Database, buildId: string) {
  const binding = await evaluateBuildInputBinding(db, buildId);
  if (!binding) throw new LifecycleApiError("Build 缺少 0018 输入绑定；历史 Build 只读，必须重新 Build", 409);
  if (binding.currentness !== "current") {
    throw new LifecycleApiError(`Build 输入已 stale：${binding.blockers.join("、")}`, 409);
  }
  return binding;
}

/**
 * Read-only boundary shared by Release Control V2.  Keep this alongside the
 * lifecycle predicates: the management plane must not reimplement a weaker
 * version of lifecycle readiness.
 */
export async function requireCurrentReleaseControlFacts(db: D1Database, releaseId: string): Promise<ReleaseFacts> {
  const release = await rowById(db, "lifecycle_releases", releaseId);
  if (!release) throw new LifecycleApiError("Release 不存在", 404);
  if (release.approval_state !== "approved" || release.readiness_state !== "ready_to_submit"
    || release.submission_state !== "not_submitted" || release.lifecycle_state !== "active"
    || !SHA256_RE.test(String(release.readiness_evidence_sha256 ?? ""))
    || !release.expires_at || Date.parse(String(release.expires_at)) <= Date.now()) {
    throw new LifecycleApiError("Release 当前状态不允许建立发布控制快照", 409);
  }
  const build = await rowById(db, "lifecycle_builds", String(release.build_id));
  const target = await rowById(db, "lifecycle_platform_targets", String(release.target_profile_id));
  const contract = build ? await rowById(db, "lifecycle_adaptation_contracts", String(build.adaptation_contract_id)) : null;
  if (!build || build.state !== "built" || !SHA256_RE.test(String(build.artifact_sha256 ?? ""))
    || build.artifact_sha256 !== release.build_artifact_sha256 || build.target_profile_sha256 !== release.target_profile_sha256
    || !target || target.status !== "active" || target.connection_mode !== "manual"
    || (() => {
      try {
        const profile = JSON.parse(String(target.profile_json ?? "{}")) as Record<string, unknown>;
        return profile.enabled !== undefined && profile.enabled !== true;
      } catch { return true; }
    })()
    || !contract || contract.status !== "approved" || contract.contract_sha256 !== build.contract_sha256
    || contract.project_id !== build.project_id || contract.article_id !== build.article_id) {
    throw new LifecycleApiError("Release 的 Build、目标或适配合同已漂移", 409);
  }
  const binding = await requireCurrentBuildInputBinding(db, String(build.id));
  const gates = await db.prepare(`SELECT gate_kind, result FROM lifecycle_build_gate_runs
    WHERE build_id = ? AND artifact_sha256 = ? AND target_profile_sha256 = ? AND contract_sha256 = ?
    ORDER BY rowid DESC`).bind(build.id, build.artifact_sha256, build.target_profile_sha256, build.contract_sha256).all<D1Row>();
  for (const kind of ["compatibility", "fidelity"]) {
    const latest = (gates.results ?? []).find((gate) => gate.gate_kind === kind);
    if (!latest || latest.result !== "pass") throw new LifecycleApiError(`Release 缺少当前 ${kind} pass 门禁`, 409);
  }
  return {
    articleId: String(release.article_id), runId: String(release.project_id), releaseId: String(release.id),
    buildId: String(build.id), platform: String(target.platform), artifactSha256: String(build.artifact_sha256),
    publicationVersionSha256: binding.publicationRegistrationSha256, profileSha256: String(target.profile_sha256),
    contractSha256: String(build.contract_sha256), lifecycle: parseRelease(release), build: parseBuild(build),
    target: parseTarget(target), adaptationContract: parseContract(contract), buildInput: binding,
  };
}

function currentBuildInputSql(buildRef: "lifecycle_builds" | "b") {
  return `EXISTS (
    SELECT 1
    FROM lifecycle_build_input_bindings binding
    JOIN article_project_packages root ON root.id = binding.package_id AND root.article_id = ${buildRef}.article_id
    JOIN lifecycle_article_projects project
      ON project.id = ${buildRef}.project_id AND project.article_id = ${buildRef}.article_id
    JOIN lifecycle_adaptation_contracts adaptation
      ON adaptation.id = ${buildRef}.adaptation_contract_id
      AND adaptation.project_id = ${buildRef}.project_id
      AND adaptation.article_id = ${buildRef}.article_id
    JOIN package_branch_states state
      ON state.package_id = binding.package_id AND state.branch_id = binding.branch_id
    JOIN package_branch_working_copies package_copy
      ON package_copy.package_id = state.package_id AND package_copy.branch_id = state.branch_id
    JOIN article_branches branch
      ON branch.id = binding.branch_id AND branch.article_id = ${buildRef}.article_id
    JOIN article_revisions revision
      ON revision.id = branch.head_revision_id AND revision.branch_id = branch.id AND revision.article_id = ${buildRef}.article_id
    JOIN branch_working_copies article_copy
      ON article_copy.branch_id = branch.id AND article_copy.article_id = ${buildRef}.article_id
    JOIN package_compositions composition
      ON composition.id = state.head_composition_id AND composition.package_id = root.id
    JOIN package_composition_materializations materialization
      ON materialization.package_id = root.id AND materialization.branch_id = state.branch_id
      AND materialization.composition_id = state.head_composition_id
      AND materialization.article_revision_id = state.head_revision_id
    JOIN package_slices slice ON slice.id = binding.slice_id AND slice.package_id = root.id AND slice.branch_id = state.branch_id
    JOIN article_publication_versions version
      ON version.id = binding.publication_version_id AND version.package_id = root.id
      AND version.branch_id = state.branch_id AND version.state = 'active'
    JOIN article_publication_versions canonical
      ON canonical.id = version.baseline_version_id AND canonical.package_id = root.id
      AND canonical.role = 'canonical_baseline' AND canonical.state = 'active'
    JOIN package_branch_states canonical_state
      ON canonical_state.package_id = root.id AND canonical_state.branch_id = canonical.branch_id
    JOIN package_branch_working_copies canonical_package_copy
      ON canonical_package_copy.package_id = root.id
      AND canonical_package_copy.branch_id = canonical_state.branch_id
    JOIN article_branches canonical_branch
      ON canonical_branch.id = canonical.branch_id AND canonical_branch.article_id = root.article_id
    JOIN article_revisions canonical_revision
      ON canonical_revision.id = canonical_branch.head_revision_id
      AND canonical_revision.branch_id = canonical_branch.id
      AND canonical_revision.article_id = root.article_id
    JOIN branch_working_copies canonical_article_copy
      ON canonical_article_copy.branch_id = canonical_branch.id
      AND canonical_article_copy.article_id = root.article_id
    JOIN package_compositions canonical_composition
      ON canonical_composition.id = canonical_state.head_composition_id
      AND canonical_composition.package_id = root.id
    JOIN package_composition_materializations canonical_materialization
      ON canonical_materialization.package_id = root.id
      AND canonical_materialization.branch_id = canonical_state.branch_id
      AND canonical_materialization.composition_id = canonical_state.head_composition_id
      AND canonical_materialization.article_revision_id = canonical_state.head_revision_id
    JOIN lifecycle_platform_targets target
      ON target.id = ${buildRef}.target_profile_id AND target.status = 'active'
    JOIN production_runs cover_run
      ON cover_run.id = binding.cover_run_id AND cover_run.article_id = ${buildRef}.article_id
      AND cover_run.branch_id = binding.branch_id
    JOIN production_run_steps cover_copy
      ON cover_copy.run_id = cover_run.id AND cover_copy.step_id = 'cover-copy-contract'
    JOIN production_run_steps cover_visual
      ON cover_visual.run_id = cover_run.id AND cover_visual.step_id = 'cover-visual-plan'
    JOIN production_run_steps cover_render
      ON cover_render.run_id = cover_run.id AND cover_render.step_id = 'cover-render-gates'
    JOIN production_run_steps cover_acceptance
      ON cover_acceptance.run_id = cover_run.id AND cover_acceptance.step_id = 'cover-human-acceptance'
    WHERE binding.build_id = ${buildRef}.id
      AND binding.branch_id = ${buildRef}.branch_id
      AND binding.revision_id = ${buildRef}.revision_id
      AND binding.source_body_sha256 = ${buildRef}.source_body_sha256
      AND binding.cover_baseline_id = '${INFORMATION_COVER_BASELINE_ID}'
      AND binding.cover_profile_sha256 = '${INFORMATION_COVER_PROFILE_SHA256}'
      AND binding.cover_recipe_id = 'evidence-led-longform-v1'
      AND binding.cover_recipe_version = '1.4.0'
      AND root.status = 'active' AND root.branch_model_version = 2
      AND project.execution_state = 'active'
      AND adaptation.status = 'approved'
      AND adaptation.contract_sha256 = ${buildRef}.contract_sha256
      AND adaptation.target_profile_id = ${buildRef}.target_profile_id
      AND adaptation.target_profile_sha256 = ${buildRef}.target_profile_sha256
      AND adaptation.source_revision_id = ${buildRef}.revision_id
      AND adaptation.source_body_sha256 = ${buildRef}.source_body_sha256
      AND state.status = 'active' AND state.lock_version = binding.branch_lock_version
      AND state.head_revision_id = binding.revision_id
      AND state.head_composition_id = binding.composition_id
      AND state.head_composition_sha256 = binding.composition_sha256
      AND package_copy.dirty = 0 AND package_copy.base_revision_id = binding.revision_id
      AND package_copy.base_composition_id = binding.composition_id
      AND branch.status = 'active' AND branch.head_revision_id = binding.revision_id
      AND revision.body_sha256 = binding.source_body_sha256
      AND article_copy.dirty = 0 AND article_copy.base_revision_id = binding.revision_id
      AND article_copy.body_sha256 = binding.source_body_sha256
      AND composition.composition_sha256 = binding.composition_sha256
      AND materialization.composition_sha256 = binding.composition_sha256
      AND materialization.article_body_sha256 = binding.source_body_sha256
      AND slice.slice_sha256 = binding.slice_sha256
      AND slice.base_branch_lock_version = binding.branch_lock_version
      AND slice.base_revision_id = binding.revision_id
      AND slice.composition_id = binding.composition_id
      AND slice.composition_sha256 = binding.composition_sha256
      AND version.registration_sha256 = binding.publication_registration_sha256
      AND version.target_profile_id = ${buildRef}.target_profile_id
      AND version.target_profile_key = target.profile_key
      AND version.target_profile_sha256 = ${buildRef}.target_profile_sha256
      AND version.baseline_branch_id = canonical.branch_id
      AND version.baseline_revision_id = canonical.revision_id
      AND version.baseline_body_sha256 = canonical.body_sha256
      AND version.baseline_composition_id = canonical.composition_id
      AND version.baseline_composition_sha256 = canonical.composition_sha256
      AND canonical.branch_id = root.primary_branch_id
      AND canonical_state.status = 'active'
      AND canonical_state.lock_version = canonical.branch_lock_version
      AND canonical_state.head_revision_id = canonical.revision_id
      AND canonical_state.head_composition_id = canonical.composition_id
      AND canonical_state.head_composition_sha256 = canonical.composition_sha256
      AND canonical_package_copy.dirty = 0
      AND canonical_package_copy.base_revision_id = canonical.revision_id
      AND canonical_package_copy.base_composition_id = canonical.composition_id
      AND canonical_branch.status = 'active'
      AND canonical_branch.head_revision_id = canonical.revision_id
      AND canonical_revision.body_sha256 = canonical.body_sha256
      AND canonical_article_copy.dirty = 0
      AND canonical_article_copy.base_revision_id = canonical.revision_id
      AND canonical_article_copy.body_sha256 = canonical.body_sha256
      AND canonical.composition_id = root.main_composition_id
      AND canonical.composition_sha256 = root.main_composition_sha256
      AND canonical_composition.composition_sha256 = canonical.composition_sha256
      AND canonical_materialization.composition_sha256 = canonical.composition_sha256
      AND canonical_materialization.article_body_sha256 = canonical.body_sha256
      AND target.profile_sha256 = ${buildRef}.target_profile_sha256
      AND target.connection_mode = 'manual'
      AND COALESCE(json_extract(target.profile_json, '$.enabled'), 1) != 0
      AND cover_run.recipe_id = binding.cover_recipe_id
      AND cover_run.recipe_version = binding.cover_recipe_version
      AND cover_run.recipe_sha256 = binding.cover_recipe_sha256
      AND cover_copy.status = 'complete'
      AND cover_visual.status = 'complete'
      AND cover_render.status = 'complete'
      AND cover_acceptance.status = 'complete'
      AND json_array(
        json_extract(cover_copy.evidence_json, '$[#-1]'),
        json_extract(cover_visual.evidence_json, '$[#-1]'),
        json_extract(cover_render.evidence_json, '$[#-1]'),
        json_extract(cover_acceptance.evidence_json, '$[#-1]')
      ) = binding.cover_receipt_chain_json
  )`;
}

function eventFromRow(
  db: D1Database,
  event: { articleId: string | null; eventType: string; subjectType: string; subjectId: string; payload: Record<string, unknown> },
  inputSha256: string,
  table: string,
  where: string,
  bindings: BoundValue[],
  createdAt: string,
) {
  const allowedTables = new Set([
    "lifecycle_article_projects",
    "lifecycle_platform_targets",
    "lifecycle_adaptation_contracts",
    "lifecycle_builds",
    "lifecycle_build_input_bindings",
    "lifecycle_build_gate_runs",
    "lifecycle_releases",
    "lifecycle_metric_snapshots",
    "lifecycle_retrospectives",
    "lifecycle_rule_candidates",
  ]);
  if (!allowedTables.has(table)) throw new LifecycleApiError("内部事件表不受允许", 500);
  return db.prepare(`INSERT INTO lifecycle_events
    (id, article_id, event_type, subject_type, subject_id, payload_json, input_sha256, created_at)
    SELECT ?, ?, ?, ?, ?, ?, ?, ? FROM ${table} WHERE ${where} LIMIT 1`)
    .bind(
      `lifecycle-event-${crypto.randomUUID()}`,
      event.articleId,
      event.eventType,
      event.subjectType,
      event.subjectId,
      canonicalJson(event.payload),
      inputSha256,
      createdAt,
      ...bindings,
    );
}

function assertMutation(results: Array<{ meta: { changes?: number } }>, mutationIndex: number, eventIndex: number, conflictMessage: string) {
  if (Number(results[mutationIndex]?.meta.changes ?? 0) !== 1) throw new LifecycleApiError(conflictMessage, 409);
  if (Number(results[eventIndex]?.meta.changes ?? 0) !== 1) throw new LifecycleApiError("状态已经写入，但审计事件未绑定；停止继续推进", 503);
}

function parseProject(row: D1Row): ArticleProjectRecord {
  return {
    id: String(row.id), articleId: String(row.article_id), title: String(row.title), intent: String(row.intent ?? ""),
    owner: String(row.owner), phase: String(row.phase) as ArticleProjectRecord["phase"],
    executionState: String(row.execution_state) as ArticleProjectRecord["executionState"], lockVersion: Number(row.lock_version),
    createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  };
}

function parseTarget(row: D1Row): PlatformTargetRecord {
  return {
    id: String(row.id), profileKey: String(row.profile_key), platform: String(row.platform), label: String(row.label),
    version: String(row.version), connectionMode: "manual", status: String(row.status) as PlatformTargetRecord["status"],
    profile: parseJson<Record<string, unknown>>(row.profile_json, {}), profileSha256: String(row.profile_sha256), createdAt: String(row.created_at),
  };
}

function parseContract(row: D1Row): AdaptationContractRecord {
  return {
    id: String(row.id), projectId: String(row.project_id), articleId: String(row.article_id),
    targetProfileId: String(row.target_profile_id), targetProfileSha256: String(row.target_profile_sha256),
    sourceRevisionId: String(row.source_revision_id), sourceBodySha256: String(row.source_body_sha256),
    sliceKind: String(row.slice_kind) as AdaptationContractRecord["sliceKind"], title: String(row.title),
    invariants: parseJson<Record<string, unknown>>(row.invariants_json, {}), rules: parseJson<Record<string, unknown>>(row.rules_json, {}),
    contractSha256: String(row.contract_sha256), status: String(row.status) as AdaptationContractRecord["status"],
    approvalNote: String(row.approval_note ?? ""), lockVersion: Number(row.lock_version),
    createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  };
}

function parseBuild(row: D1Row): ContentBuildRecord {
  return {
    id: String(row.id), projectId: String(row.project_id), articleId: String(row.article_id), branchId: String(row.branch_id),
    revisionId: String(row.revision_id), sourceTitle: String(row.source_title), sourceBodySha256: String(row.source_body_sha256),
    targetProfileId: String(row.target_profile_id), targetProfileSha256: String(row.target_profile_sha256),
    adaptationContractId: String(row.adaptation_contract_id), contractSha256: String(row.contract_sha256),
    sliceKind: String(row.slice_kind) as ContentBuildRecord["sliceKind"], state: String(row.state) as ContentBuildRecord["state"],
    artifactRef: String(row.artifact_ref ?? ""), artifactSha256: String(row.artifact_sha256 ?? ""),
    artifactMediaType: String(row.artifact_media_type ?? ""), artifactManifest: parseJson<Record<string, unknown>>(row.artifact_manifest_json, {}),
    failureSummary: String(row.failure_summary ?? ""), createdAt: String(row.created_at),
    builtAt: row.built_at ? String(row.built_at) : null, updatedAt: String(row.updated_at),
  };
}

function parseBuildGate(row: D1Row): BuildGateRunRecord {
  return {
    id: String(row.id), buildId: String(row.build_id), projectId: String(row.project_id), articleId: String(row.article_id),
    gateKind: String(row.gate_kind) as BuildGateRunRecord["gateKind"], result: String(row.result) as BuildGateRunRecord["result"],
    artifactSha256: String(row.artifact_sha256), targetProfileSha256: String(row.target_profile_sha256),
    contractSha256: String(row.contract_sha256), evidence: parseJson<string[]>(row.evidence_json, []),
    details: parseJson<Record<string, unknown>>(row.details_json, {}), inputSha256: String(row.input_sha256), createdAt: String(row.created_at),
  };
}

function parseRelease(row: D1Row): ContentReleaseRecord {
  return {
    id: String(row.id), projectId: String(row.project_id), articleId: String(row.article_id), buildId: String(row.build_id),
    buildArtifactSha256: String(row.build_artifact_sha256), targetProfileId: String(row.target_profile_id),
    targetProfileSha256: String(row.target_profile_sha256), approvalState: String(row.approval_state) as ContentReleaseRecord["approvalState"],
    readinessState: String(row.readiness_state ?? "draft") as ContentReleaseRecord["readinessState"],
    readinessEvidenceSha256: String(row.readiness_evidence_sha256 ?? ""),
    readyAt: row.ready_at ? String(row.ready_at) : null, expiresAt: row.expires_at ? String(row.expires_at) : null,
    submissionState: String(row.submission_state) as ContentReleaseRecord["submissionState"],
    destinationState: String(row.destination_state) as ContentReleaseRecord["destinationState"],
    publicState: String(row.public_state) as ContentReleaseRecord["publicState"],
    lifecycleState: String(row.lifecycle_state) as ContentReleaseRecord["lifecycleState"], remoteRecordId: String(row.remote_record_id ?? ""),
    destinationUrl: String(row.destination_url ?? ""), publicUrl: String(row.public_url ?? ""), approvalNote: String(row.approval_note ?? ""),
    submissionEvidence: parseJson<string[]>(row.submission_evidence_json, []),
    destinationEvidence: parseJson<string[]>(row.destination_evidence_json, []), publicEvidence: parseJson<string[]>(row.public_evidence_json, []),
    lockVersion: Number(row.lock_version), createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  };
}

async function evaluateReleaseReadiness(
  db: D1Database,
  release: ContentReleaseRecord,
  input: { currentness: BuildInputCurrentness; blockers: string[] },
) {
  const blockers = [...input.blockers];
  const build = await rowById(db, "lifecycle_builds", release.buildId);
  if (!build || build.state !== "built" || build.artifact_sha256 !== release.buildArtifactSha256) blockers.push("build_or_artifact_changed");
  const gates = await db.prepare(`SELECT gate_kind, result FROM lifecycle_build_gate_runs
    WHERE build_id = ? AND artifact_sha256 = ? AND target_profile_sha256 = ?
      AND contract_sha256 = (SELECT contract_sha256 FROM lifecycle_builds WHERE id = ?)
    ORDER BY rowid DESC`).bind(release.buildId, release.buildArtifactSha256, release.targetProfileSha256, release.buildId).all<D1Row>();
  for (const kind of ["compatibility", "fidelity"]) {
    const latest = (gates.results ?? []).find((gate) => gate.gate_kind === kind);
    if (!latest || latest.result !== "pass") blockers.push(`${kind}_gate_not_current_pass`);
  }
  if (release.readinessState === "ready_to_submit" && !SHA256_RE.test(release.readinessEvidenceSha256)) blockers.push("readiness_evidence_missing");
  if (release.expiresAt && Date.parse(release.expiresAt) <= Date.now()) blockers.push("readiness_expired");
  const uniqueBlockers = [...new Set(blockers)];
  const effectiveState = uniqueBlockers.length && ["artifact_validated", "ready_to_submit", "stale"].includes(release.readinessState)
    ? "stale"
    : release.readinessState;
  return { readinessState: effectiveState as ContentReleaseRecord["readinessState"], readinessBlockers: uniqueBlockers };
}

function parseMetric(row: D1Row): MetricSnapshotRecord {
  const definitionSetSha256 = row.definition_set_sha256 ? String(row.definition_set_sha256) : null;
  return {
    id: String(row.id), releaseId: String(row.release_id), projectId: String(row.project_id), articleId: String(row.article_id),
    sourceMode: String(row.source_mode) as MetricSnapshotRecord["sourceMode"], sourceLabel: String(row.source_label),
    windowStart: String(row.window_start), windowEnd: String(row.window_end), capturedAt: String(row.captured_at),
    metrics: parseJson<Record<string, unknown>>(row.metrics_json, {}), evidenceRef: String(row.evidence_ref),
    measurementSha256: String(row.measurement_sha256), definitionSetSha256,
    schemaState: definitionSetSha256 ? "typed" : "legacy_untyped",
    validationState: String(row.validation_state) as MetricSnapshotRecord["validationState"],
    validationNote: String(row.validation_note ?? ""), createdAt: String(row.created_at),
  };
}

function parseMetricDefinition(row: D1Row): MetricDefinitionRecord {
  return {
    id: String(row.id), definitionKey: String(row.definition_key), version: String(row.version), label: String(row.label),
    description: String(row.description ?? ""), valueKind: String(row.value_kind) as MetricDefinitionRecord["valueKind"],
    unit: String(row.unit), missingPolicy: String(row.missing_policy) as MetricDefinitionRecord["missingPolicy"],
    constraints: parseJson<Record<string, unknown>>(row.constraints_json, {}), scope: parseJson<Record<string, unknown>>(row.scope_json, {}),
    definitionSha256: String(row.definition_sha256), status: String(row.status) as MetricDefinitionRecord["status"],
    createdAt: String(row.created_at),
  };
}

function parseMetricValue(row: D1Row): MetricValueRecord {
  return {
    id: String(row.id), snapshotId: String(row.snapshot_id), releaseId: String(row.release_id),
    projectId: String(row.project_id), articleId: String(row.article_id), definitionId: String(row.definition_id),
    definitionSha256: String(row.definition_sha256), observationState: String(row.observation_state) as MetricValueRecord["observationState"],
    value: parseJson<unknown>(row.value_json, null), valueSha256: String(row.value_sha256), createdAt: String(row.created_at),
  };
}

function parseRetrospective(row: D1Row): RetrospectiveRecord {
  return {
    id: String(row.id), projectId: String(row.project_id), articleId: String(row.article_id),
    releaseId: row.release_id ? String(row.release_id) : null, title: String(row.title), summary: String(row.summary ?? ""),
    evidenceRefs: parseJson<string[]>(row.evidence_refs_json, []), status: String(row.status) as RetrospectiveRecord["status"],
    lockVersion: Number(row.lock_version), createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  };
}

function parseRule(row: D1Row): RuleCandidateRecord {
  return {
    id: String(row.id), projectId: String(row.project_id), articleId: String(row.article_id), retrospectiveId: String(row.retrospective_id),
    title: String(row.title), ruleText: String(row.rule_text), scope: String(row.scope ?? ""),
    counterexamples: String(row.counterexamples ?? ""), owner: String(row.owner ?? ""),
    implementationTarget: String(row.implementation_target ?? ""), regressionRef: String(row.regression_ref ?? ""),
    evidenceRefs: parseJson<string[]>(row.evidence_refs_json, []), state: String(row.state) as RuleCandidateRecord["state"],
    lockVersion: Number(row.lock_version), createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  };
}

function parseEvent(row: D1Row): LifecycleEventRecord {
  return {
    id: String(row.id), articleId: row.article_id ? String(row.article_id) : null, eventType: String(row.event_type),
    subjectType: String(row.subject_type), subjectId: String(row.subject_id),
    payload: parseJson<Record<string, unknown>>(row.payload_json, {}), inputSha256: String(row.input_sha256), createdAt: String(row.created_at),
  };
}

async function rowById(db: D1Database, table: string, id: string) {
  const allowed = new Set([
    "lifecycle_article_projects", "lifecycle_platform_targets", "lifecycle_adaptation_contracts", "lifecycle_builds",
    "lifecycle_build_gate_runs", "lifecycle_releases", "lifecycle_metric_snapshots", "lifecycle_metric_definitions",
    "lifecycle_metric_values", "lifecycle_retrospectives", "lifecycle_rule_candidates",
  ]);
  if (!allowed.has(table)) throw new LifecycleApiError("内部查询表不受允许", 500);
  return db.prepare(`SELECT * FROM ${table} WHERE id = ? LIMIT 1`).bind(id).first<D1Row>();
}

export async function GET(request: Request) {
  try {
    await requireManagementSession(request, { scope: "management.read" })
      .catch((error: unknown) => {
        if (error instanceof ManagementAuthError) throw new LifecycleApiError(error.message, error.status);
        throw error;
      });
    const articleId = requiredText(new URL(request.url).searchParams.get("articleId"), "文章 ID", 120);
    const db = await ensureLifecycleSchema();
    const [projects, targets, contracts, builds, gates, releases, metricDefinitions, metrics, metricValues, retrospectives, rules, events] = await db.batch([
      db.prepare("SELECT * FROM lifecycle_article_projects WHERE article_id = ? ORDER BY updated_at DESC").bind(articleId),
      db.prepare("SELECT * FROM lifecycle_platform_targets ORDER BY profile_key, created_at DESC"),
      db.prepare("SELECT * FROM lifecycle_adaptation_contracts WHERE article_id = ? ORDER BY updated_at DESC").bind(articleId),
      db.prepare("SELECT * FROM lifecycle_builds WHERE article_id = ? ORDER BY created_at DESC LIMIT 300").bind(articleId),
      db.prepare("SELECT * FROM lifecycle_build_gate_runs WHERE article_id = ? ORDER BY created_at DESC LIMIT 1000").bind(articleId),
      db.prepare("SELECT * FROM lifecycle_releases WHERE article_id = ? ORDER BY created_at DESC LIMIT 300").bind(articleId),
      db.prepare("SELECT * FROM lifecycle_metric_definitions ORDER BY definition_key, created_at DESC"),
      db.prepare("SELECT * FROM lifecycle_metric_snapshots WHERE article_id = ? ORDER BY captured_at DESC LIMIT 1000").bind(articleId),
      db.prepare("SELECT * FROM lifecycle_metric_values WHERE article_id = ? ORDER BY created_at DESC LIMIT 5000").bind(articleId),
      db.prepare("SELECT * FROM lifecycle_retrospectives WHERE article_id = ? ORDER BY updated_at DESC LIMIT 300").bind(articleId),
      db.prepare("SELECT * FROM lifecycle_rule_candidates WHERE article_id = ? ORDER BY updated_at DESC LIMIT 500").bind(articleId),
      db.prepare("SELECT * FROM lifecycle_events WHERE article_id = ? OR article_id IS NULL ORDER BY created_at DESC LIMIT 1500").bind(articleId),
    ]);
    const parsedBuilds = await Promise.all((builds.results as D1Row[]).map(async (row) => {
      const inputBinding = await evaluateBuildInputBinding(db, String(row.id));
      return {
        ...parseBuild(row),
        inputBinding,
        inputCurrentness: inputBinding?.currentness ?? "legacy_unbound",
        inputBlockers: inputBinding?.blockers ?? ["legacy_build_unbound"],
      };
    }));
    const buildCurrentness = new Map(parsedBuilds.map((build) => [build.id, {
      currentness: build.inputCurrentness ?? "legacy_unbound",
      blockers: build.inputBlockers ?? [],
    }]));
    return Response.json({
      ok: true,
      storage: "d1-local",
      articleId,
      projects: (projects.results as D1Row[]).map(parseProject),
      platformTargets: (targets.results as D1Row[]).map(parseTarget),
      adaptationContracts: (contracts.results as D1Row[]).map(parseContract),
      builds: parsedBuilds,
      buildGates: (gates.results as D1Row[]).map(parseBuildGate),
      releases: await Promise.all((releases.results as D1Row[]).map(async (row) => {
        const release = parseRelease(row);
        const input = buildCurrentness.get(release.buildId) ?? { currentness: "legacy_unbound" as const, blockers: ["legacy_build_unbound"] };
        const readiness = await evaluateReleaseReadiness(db, release, input);
        return { ...release, ...readiness, buildInputCurrentness: input.currentness, buildInputBlockers: input.blockers };
      })),
      metricDefinitions: (metricDefinitions.results as D1Row[]).map(parseMetricDefinition),
      metricSnapshots: (metrics.results as D1Row[]).map(parseMetric),
      metricValues: (metricValues.results as D1Row[]).map(parseMetricValue),
      retrospectives: (retrospectives.results as D1Row[]).map(parseRetrospective),
      ruleCandidates: (rules.results as D1Row[]).map(parseRule),
      events: (events.results as D1Row[]).map(parseEvent),
    });
  } catch (error) {
    const status = error instanceof LifecycleApiError ? error.status : 503;
    return Response.json({
      ok: false,
      storage: "unavailable", articleId: "", projects: [], platformTargets: [], adaptationContracts: [], builds: [],
      buildGates: [], releases: [], metricDefinitions: [], metricSnapshots: [], metricValues: [], retrospectives: [], ruleCandidates: [], events: [],
      error: error instanceof Error ? error.message : "生命周期快照不可用",
    }, { status });
  }
}

async function createProject(db: D1Database, payload: Record<string, unknown>) {
  const articleId = requiredText(payload.articleId, "文章 ID", 120);
  const title = requiredText(payload.title, "项目标题", 240);
  const intent = cleanText(payload.intent, 4000);
  const owner = cleanText(payload.owner, 120) || "我";
  const packageId = cleanText(payload.packageId, 120);
  let packageBinding: D1Row | null = null;
  let id = `article-project-${crypto.randomUUID()}`;
  if (packageId) {
    packageBinding = await db.prepare(`SELECT id, project_id, article_id, status, branch_model_version
      FROM article_project_packages WHERE id = ? LIMIT 1`).bind(packageId).first<D1Row>();
    if (!packageBinding
      || packageBinding.article_id !== articleId
      || packageBinding.status !== "active"
      || Number(packageBinding.branch_model_version) !== 2
      || !packageBinding.project_id) {
      throw new LifecycleApiError("Package 不存在、文章不匹配、不是 active branch-model-v2，或没有可采用的 Project 身份", 409);
    }
    id = String(packageBinding.project_id);
  }
  const existing = await db.prepare(`SELECT id, article_id FROM lifecycle_article_projects
    WHERE article_id = ? OR id = ? LIMIT 1`).bind(articleId, id).first<D1Row>();
  if (existing) {
    throw new LifecycleApiError(
      existing.article_id === articleId
        ? "这篇文章已经有 ArticleProject；请更新原项目而不是复制身份"
        : "Package Project 身份已经被另一篇文章占用",
      409,
    );
  }
  const now = isoNow();
  const inputSha256 = await digest({
    action: "create_project", articleId, title, intent, owner,
    packageId: packageBinding ? packageId : null,
    packageProjectId: packageBinding ? id : null,
  });
  const projectInsert = packageBinding
    ? db.prepare(`INSERT INTO lifecycle_article_projects
        (id, article_id, title, intent, owner, phase, execution_state, lock_version, created_at, updated_at)
      SELECT project_id, article_id, ?, ?, ?, 'pitch', 'proposed', 1, ?, ?
      FROM article_project_packages
      WHERE id = ? AND project_id = ? AND article_id = ? AND status = 'active' AND branch_model_version = 2`)
      .bind(title, intent, owner, now, now, packageId, id, articleId)
    : db.prepare(`INSERT INTO lifecycle_article_projects
        (id, article_id, title, intent, owner, phase, execution_state, lock_version, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'pitch', 'proposed', 1, ?, ?)`)
      .bind(id, articleId, title, intent, owner, now, now);
  const results = await db.batch([
    projectInsert,
    eventFromRow(db, {
      articleId, eventType: "article_project.created", subjectType: "article_project", subjectId: id,
      payload: {
        phase: "pitch", executionState: "proposed",
        claim: packageBinding ? "package_bound_project_identity_created" : "project_identity_created",
        packageId: packageBinding ? packageId : null,
        packageProjectId: packageBinding ? id : null,
      },
    }, inputSha256, "lifecycle_article_projects", "id = ? AND lock_version = 1", [id], now),
  ]);
  assertMutation(results, 0, 1, "项目身份创建冲突");
  const row = await rowById(db, "lifecycle_article_projects", id);
  return Response.json({ ok: true, project: row ? parseProject(row) : null }, { status: 201 });
}

async function updateProject(db: D1Database, payload: Record<string, unknown>) {
  const projectId = requiredText(payload.projectId, "项目 ID", 120);
  const expectedLockVersion = requiredPositiveInteger(payload.expectedLockVersion, "expectedLockVersion");
  const row = await rowById(db, "lifecycle_article_projects", projectId);
  if (!row) throw new LifecycleApiError("ArticleProject 不存在", 404);
  const title = cleanText(payload.title, 240) || String(row.title);
  const intent = typeof payload.intent === "string" ? cleanText(payload.intent, 4000) : String(row.intent ?? "");
  const owner = cleanText(payload.owner, 120) || String(row.owner);
  const now = isoNow();
  const nextLock = expectedLockVersion + 1;
  const inputSha256 = await digest({ action: "update_project", projectId, expectedLockVersion, title, intent, owner });
  const results = await db.batch([
    db.prepare(`UPDATE lifecycle_article_projects SET title = ?, intent = ?, owner = ?,
      lock_version = lock_version + 1, updated_at = ? WHERE id = ? AND lock_version = ? AND execution_state <> 'cancelled'`)
      .bind(title, intent, owner, now, projectId, expectedLockVersion),
    eventFromRow(db, {
      articleId: String(row.article_id), eventType: "article_project.metadata_updated", subjectType: "article_project", subjectId: projectId,
      payload: { expectedLockVersion, nextLockVersion: nextLock },
    }, inputSha256, "lifecycle_article_projects", "id = ? AND lock_version = ? AND updated_at = ?", [projectId, nextLock, now], now),
  ]);
  assertMutation(results, 0, 1, "项目已变化、已取消或锁版本过期");
  const updated = await rowById(db, "lifecycle_article_projects", projectId);
  return Response.json({ ok: true, project: updated ? parseProject(updated) : null });
}

async function transitionProjectPhase(db: D1Database, payload: Record<string, unknown>) {
  const projectId = requiredText(payload.projectId, "项目 ID", 120);
  const targetPhase = requiredText(payload.targetPhase, "目标阶段", 40);
  if (!phaseSet.has(targetPhase)) throw new LifecycleApiError("项目阶段非法");
  const expectedLockVersion = requiredPositiveInteger(payload.expectedLockVersion, "expectedLockVersion");
  const note = requiredText(payload.note, "阶段变化说明", 2000);
  const row = await rowById(db, "lifecycle_article_projects", projectId);
  if (!row) throw new LifecycleApiError("ArticleProject 不存在", 404);
  const currentPhase = String(row.phase);
  if (!PROJECT_PHASE_TRANSITIONS[currentPhase]?.has(targetPhase)) {
    throw new LifecycleApiError(`不允许从 ${currentPhase} 直接进入 ${targetPhase}`, 409);
  }
  if (["cancelled", "completed"].includes(String(row.execution_state))) {
    throw new LifecycleApiError("已完成或取消的项目不能改变阶段；先显式恢复执行状态", 409);
  }
  const now = isoNow();
  const nextLock = expectedLockVersion + 1;
  const inputSha256 = await digest({ action: "transition_project_phase", projectId, currentPhase, targetPhase, expectedLockVersion, note });
  const results = await db.batch([
    db.prepare(`UPDATE lifecycle_article_projects SET phase = ?, lock_version = lock_version + 1, updated_at = ?
      WHERE id = ? AND phase = ? AND lock_version = ? AND execution_state NOT IN ('completed','cancelled')`)
      .bind(targetPhase, now, projectId, currentPhase, expectedLockVersion),
    eventFromRow(db, {
      articleId: String(row.article_id), eventType: "article_project.phase_changed", subjectType: "article_project", subjectId: projectId,
      payload: { from: currentPhase, to: targetPhase, note },
    }, inputSha256, "lifecycle_article_projects", "id = ? AND phase = ? AND lock_version = ? AND updated_at = ?", [projectId, targetPhase, nextLock, now], now),
  ]);
  assertMutation(results, 0, 1, "项目阶段或锁版本已变化");
  const updated = await rowById(db, "lifecycle_article_projects", projectId);
  return Response.json({ ok: true, project: updated ? parseProject(updated) : null });
}

async function transitionProjectExecution(db: D1Database, payload: Record<string, unknown>) {
  const projectId = requiredText(payload.projectId, "项目 ID", 120);
  const targetState = requiredText(payload.targetState, "目标执行状态", 40);
  if (!executionSet.has(targetState)) throw new LifecycleApiError("项目执行状态非法");
  const expectedLockVersion = requiredPositiveInteger(payload.expectedLockVersion, "expectedLockVersion");
  const note = requiredText(payload.note, "执行状态说明", 2000);
  const row = await rowById(db, "lifecycle_article_projects", projectId);
  if (!row) throw new LifecycleApiError("ArticleProject 不存在", 404);
  const currentState = String(row.execution_state);
  if (!PROJECT_EXECUTION_TRANSITIONS[currentState]?.has(targetState)) {
    throw new LifecycleApiError(`不允许从 ${currentState} 直接进入 ${targetState}`, 409);
  }
  if (targetState === "completed" && String(row.phase) !== "retrospective") {
    throw new LifecycleApiError("项目只有进入 retrospective 阶段后才能标记 completed", 409);
  }
  const now = isoNow();
  const nextLock = expectedLockVersion + 1;
  const inputSha256 = await digest({ action: "transition_project_execution", projectId, currentState, targetState, expectedLockVersion, note });
  const results = await db.batch([
    db.prepare(`UPDATE lifecycle_article_projects SET execution_state = ?, lock_version = lock_version + 1, updated_at = ?
      WHERE id = ? AND execution_state = ? AND lock_version = ?`)
      .bind(targetState, now, projectId, currentState, expectedLockVersion),
    eventFromRow(db, {
      articleId: String(row.article_id), eventType: "article_project.execution_changed", subjectType: "article_project", subjectId: projectId,
      payload: { from: currentState, to: targetState, note },
    }, inputSha256, "lifecycle_article_projects", "id = ? AND execution_state = ? AND lock_version = ? AND updated_at = ?", [projectId, targetState, nextLock, now], now),
  ]);
  assertMutation(results, 0, 1, "项目执行状态或锁版本已变化");
  const updated = await rowById(db, "lifecycle_article_projects", projectId);
  return Response.json({ ok: true, project: updated ? parseProject(updated) : null });
}

async function createPlatformTarget(db: D1Database, payload: Record<string, unknown>) {
  const profileKey = requiredText(payload.profileKey, "目标画像 key", 120).toLowerCase();
  const platform = requiredText(payload.platform, "平台标识", 80).toLowerCase();
  if (platform === "maimai" && profileKey !== MAIMAI_RELEASE_WORKFLOW.profileKey) {
    throw new LifecycleApiError(`脉脉目标必须使用规范 profileKey ${MAIMAI_RELEASE_WORKFLOW.profileKey}`);
  }
  if (profileKey === MAIMAI_RELEASE_WORKFLOW.profileKey && platform !== "maimai") {
    throw new LifecycleApiError("maimai.community-post 只能绑定 maimai 平台");
  }
  const videoProfilePlatform = profileKey === "xiaohongshu.video" ? "xiaohongshu"
    : profileKey === "zhihu.video" ? "zhihu" : null;
  if (videoProfilePlatform && platform !== videoProfilePlatform) {
    throw new LifecycleApiError(`${profileKey} 只能绑定 ${videoProfilePlatform} 平台`);
  }
  const label = requiredText(payload.label, "平台名称", 160);
  const version = requiredText(payload.version, "画像版本", 80);
  const suppliedProfile = jsonObject(payload.profile, "平台画像", false);
  if (videoProfilePlatform && suppliedProfile.mediaKind !== "video") {
    throw new LifecycleApiError(`${profileKey} 必须保留 mediaKind=video`);
  }
  const connectionStatus = cleanText(suppliedProfile.connectionStatus, 40) || "unknown";
  if (!["unknown", "not_connected", "needs_login", "login_confirmed"].includes(connectionStatus)) {
    throw new LifecycleApiError("人工平台画像的连接状态只能是 unknown、not_connected、needs_login 或 login_confirmed");
  }
  const loginEvidence = cleanText(suppliedProfile.loginEvidence, 4000, true);
  if (connectionStatus === "login_confirmed" && !loginEvidence) {
    throw new LifecycleApiError("人工确认已登录时必须填写核对时间、环境或证据说明");
  }
  const profile = {
    ...suppliedProfile,
    enabled: suppliedProfile.enabled !== false,
    deliveryMode: "manual",
    connectionStatus,
    loginEvidence,
  };
  const profileJson = canonicalJson(profile);
  const profileSha256 = await sha256Text(profileJson);
  const existing = await db.prepare("SELECT id FROM lifecycle_platform_targets WHERE profile_key = ? AND version = ? LIMIT 1")
    .bind(profileKey, version).first<D1Row>();
  if (existing) throw new LifecycleApiError("同一 profileKey/version 已存在；平台画像必须发布新版本", 409);
  const id = `platform-target-${crypto.randomUUID()}`;
  const now = isoNow();
  const inputSha256 = await digest({ action: "create_platform_target", profileKey, platform, label, version, profileSha256, connectionMode: "manual" });
  const results = await db.batch([
    db.prepare("UPDATE lifecycle_platform_targets SET status = 'superseded' WHERE profile_key = ? AND status = 'active'").bind(profileKey),
    db.prepare(`INSERT INTO lifecycle_platform_targets
      (id, profile_key, platform, label, version, connection_mode, status, profile_json, profile_sha256, created_at)
      VALUES (?, ?, ?, ?, ?, 'manual', 'active', ?, ?, ?)`)
      .bind(id, profileKey, platform, label, version, profileJson, profileSha256, now),
    eventFromRow(db, {
      articleId: null, eventType: "platform_target.version_created", subjectType: "platform_target", subjectId: id,
      payload: { profileKey, platform, version, profileSha256, connectionMode: "manual", connectionStatus, enabled: profile.enabled },
    }, inputSha256, "lifecycle_platform_targets", "id = ? AND status = 'active' AND profile_sha256 = ?", [id, profileSha256], now),
  ]);
  assertMutation(results, 1, 2, "平台画像版本创建冲突");
  const row = await rowById(db, "lifecycle_platform_targets", id);
  return Response.json({ ok: true, platformTarget: row ? parseTarget(row) : null }, { status: 201 });
}

async function createAdaptationContract(db: D1Database, payload: Record<string, unknown>) {
  await ensureWorkspaceRevisionTables(db);
  const projectId = requiredText(payload.projectId, "项目 ID", 120);
  const targetProfileId = requiredText(payload.targetProfileId, "平台画像 ID", 120);
  const sourceRevisionId = requiredText(payload.sourceRevisionId, "源修订 ID", 120);
  const sourceBodySha256 = requiredSha(payload.sourceBodySha256, "源正文摘要");
  const sliceKind = requiredText(payload.sliceKind, "切片类型", 20);
  if (!sliceSet.has(sliceKind)) throw new LifecycleApiError("切片类型必须是 full、demo、excerpt 或 promo");
  const title = requiredText(payload.title, "适配合同标题", 240);
  const invariants = jsonObject(payload.invariants, "核心内容不变量", false);
  const rules = jsonObject(payload.rules, "允许改写与省略规则", false);
  const [project, target, revision] = await Promise.all([
    rowById(db, "lifecycle_article_projects", projectId),
    rowById(db, "lifecycle_platform_targets", targetProfileId),
    db.prepare("SELECT * FROM article_revisions WHERE id = ? LIMIT 1").bind(sourceRevisionId).first<D1Row>(),
  ]);
  if (!project) throw new LifecycleApiError("ArticleProject 不存在", 404);
  if (String(project.execution_state) === "cancelled") throw new LifecycleApiError("已取消项目不能创建适配合同", 409);
  if (!target || String(target.status) !== "active" || String(target.connection_mode) !== "manual" || !platformTargetEnabled(target)) {
    throw new LifecycleApiError("平台画像不存在、已停用、已被替代或不是 manual 合同", 409);
  }
  if (!revision || revision.article_id !== project.article_id || revision.body_sha256 !== sourceBodySha256) {
    throw new LifecycleApiError("源修订不属于该文章，或正文摘要已经不匹配", 409);
  }
  const contractCore = {
    projectId, articleId: String(project.article_id), targetProfileId, targetProfileSha256: String(target.profile_sha256),
    sourceRevisionId, sourceBodySha256, sliceKind, title, invariants, rules,
  };
  const contractSha256 = await digest(contractCore);
  const id = `adaptation-contract-${crypto.randomUUID()}`;
  const now = isoNow();
  const inputSha256 = await digest({ action: "create_adaptation_contract", contractSha256 });
  const results = await db.batch([
    db.prepare(`INSERT INTO lifecycle_adaptation_contracts
      (id, project_id, article_id, target_profile_id, target_profile_sha256, source_revision_id, source_body_sha256,
       slice_kind, title, invariants_json, rules_json, contract_sha256, status, approval_note, lock_version, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', '', 1, ?, ?)`)
      .bind(id, projectId, project.article_id, targetProfileId, target.profile_sha256, sourceRevisionId, sourceBodySha256,
        sliceKind, title, canonicalJson(invariants), canonicalJson(rules), contractSha256, now, now),
    eventFromRow(db, {
      articleId: String(project.article_id), eventType: "adaptation_contract.created", subjectType: "adaptation_contract", subjectId: id,
      payload: { contractSha256, sliceKind, targetProfileId, sourceRevisionId, status: "draft" },
    }, inputSha256, "lifecycle_adaptation_contracts", "id = ? AND contract_sha256 = ? AND status = 'draft'", [id, contractSha256], now),
  ]);
  assertMutation(results, 0, 1, "适配合同创建冲突");
  const row = await rowById(db, "lifecycle_adaptation_contracts", id);
  return Response.json({ ok: true, adaptationContract: row ? parseContract(row) : null }, { status: 201 });
}

async function transitionAdaptationContract(db: D1Database, payload: Record<string, unknown>) {
  const contractId = requiredText(payload.contractId, "适配合同 ID", 120);
  const targetState = requiredText(payload.targetState, "合同目标状态", 40);
  if (!contractStateSet.has(targetState)) throw new LifecycleApiError("合同状态非法");
  const expectedLockVersion = requiredPositiveInteger(payload.expectedLockVersion, "expectedLockVersion");
  const note = requiredText(payload.note, "合同决定说明", 2000);
  const row = await rowById(db, "lifecycle_adaptation_contracts", contractId);
  if (!row) throw new LifecycleApiError("适配合同不存在", 404);
  const currentState = String(row.status);
  if (!CONTRACT_TRANSITIONS[currentState]?.has(targetState)) {
    throw new LifecycleApiError(`不允许从 ${currentState} 直接进入 ${targetState}`, 409);
  }
  if (targetState === "approved") {
    await ensureWorkspaceRevisionTables(db);
    const [target, revision, project] = await Promise.all([
      rowById(db, "lifecycle_platform_targets", String(row.target_profile_id)),
      db.prepare("SELECT * FROM article_revisions WHERE id = ? LIMIT 1").bind(row.source_revision_id).first<D1Row>(),
      rowById(db, "lifecycle_article_projects", String(row.project_id)),
    ]);
    if (!target || target.status !== "active" || target.profile_sha256 !== row.target_profile_sha256 || !platformTargetEnabled(target)) {
      throw new LifecycleApiError("平台画像已停用或发生变化；请启用目标并基于新画像建立新合同", 409);
    }
    if (!revision || revision.body_sha256 !== row.source_body_sha256 || revision.article_id !== row.article_id) {
      throw new LifecycleApiError("合同绑定的源修订或正文摘要已失效", 409);
    }
    if (!project || project.execution_state === "cancelled") throw new LifecycleApiError("项目不存在或已经取消", 409);
  }
  const now = isoNow();
  const nextLock = expectedLockVersion + 1;
  const inputSha256 = await digest({ action: "transition_adaptation_contract", contractId, currentState, targetState, expectedLockVersion, note, contractSha256: row.contract_sha256 });
  const results = await db.batch([
    db.prepare(`UPDATE lifecycle_adaptation_contracts SET status = ?, approval_note = ?, lock_version = lock_version + 1, updated_at = ?
      WHERE id = ? AND status = ? AND lock_version = ?`)
      .bind(targetState, note, now, contractId, currentState, expectedLockVersion),
    eventFromRow(db, {
      articleId: String(row.article_id), eventType: "adaptation_contract.state_changed", subjectType: "adaptation_contract", subjectId: contractId,
      payload: { from: currentState, to: targetState, note, contractSha256: String(row.contract_sha256) },
    }, inputSha256, "lifecycle_adaptation_contracts", "id = ? AND status = ? AND lock_version = ? AND updated_at = ?", [contractId, targetState, nextLock, now], now),
  ]);
  assertMutation(results, 0, 1, "合同状态或锁版本已变化");
  const updated = await rowById(db, "lifecycle_adaptation_contracts", contractId);
  return Response.json({ ok: true, adaptationContract: updated ? parseContract(updated) : null });
}

async function createBuild(db: D1Database, payload: Record<string, unknown>) {
  await ensureWorkspaceRevisionTables(db);
  await ensureBuildInputTables(db);
  const projectId = requiredText(payload.projectId, "项目 ID", 120);
  const contractId = requiredText(payload.contractId, "适配合同 ID", 120);
  const packageId = requiredText(payload.packageId, "Package ID", 160);
  const branchId = requiredText(payload.branchId, "分支 ID", 120);
  const expectedBranchLockVersion = requiredPositiveInteger(payload.expectedBranchLockVersion, "expectedBranchLockVersion");
  const expectedRevisionId = requiredText(payload.expectedRevisionId, "预期修订 ID", 120);
  const expectedBodySha256 = requiredSha(payload.expectedBodySha256, "预期正文摘要");
  const expectedCompositionId = requiredText(payload.expectedCompositionId, "预期 Composition ID", 160);
  const expectedCompositionSha256 = requiredSha(payload.expectedCompositionSha256, "预期 Composition 摘要");
  const sliceId = requiredText(payload.sliceId, "Slice ID", 160);
  const expectedSliceSha256 = requiredSha(payload.expectedSliceSha256, "预期 Slice 摘要");
  const publicationVersionId = requiredText(payload.publicationVersionId, "PublicationVersion ID", 160);
  const expectedPublicationRegistrationSha256 = requiredSha(
    payload.expectedPublicationRegistrationSha256,
    "预期 PublicationVersion 注册摘要",
  );
  const coverRunId = requiredText(payload.coverRunId, "封面生产运行 ID", 160);
  const expectedCoverReceiptId = requiredText(payload.expectedCoverReceiptId, "预期封面回执 ID", 200);
  const expectedCoverReceiptSha256 = requiredSha(payload.expectedCoverReceiptSha256, "预期封面回执摘要");
  const expectedCoverArtifactSha256 = requiredSha(payload.expectedCoverArtifactSha256, "预期封面工件摘要");
  const expectedCoverProfileSha256 = requiredSha(payload.expectedCoverProfileSha256, "预期封面 Profile 摘要");
  const expectedContractSha256 = requiredSha(payload.expectedContractSha256, "预期合同摘要");
  const expectedTargetProfileSha256 = requiredSha(payload.expectedTargetProfileSha256, "预期平台画像摘要");
  if (expectedCoverProfileSha256 !== INFORMATION_COVER_PROFILE_SHA256) {
    throw new LifecycleApiError("封面 Profile 摘要不是当前 information-knowledge-cover-v2", 409);
  }
  const [project, contract] = await Promise.all([
    rowById(db, "lifecycle_article_projects", projectId),
    rowById(db, "lifecycle_adaptation_contracts", contractId),
  ]);
  if (!project) throw new LifecycleApiError("ArticleProject 不存在", 404);
  if (!contract || contract.project_id !== projectId) throw new LifecycleApiError("适配合同不存在或不属于该项目", 404);
  if (contract.status !== "approved"
    || contract.contract_sha256 !== expectedContractSha256
    || contract.target_profile_sha256 !== expectedTargetProfileSha256
    || contract.source_revision_id !== expectedRevisionId
    || contract.source_body_sha256 !== expectedBodySha256) {
    throw new LifecycleApiError("适配合同、目标画像或源 Revision 已变化", 409);
  }

  const source = await db.prepare(`SELECT
      root.article_id AS package_article_id,
      root.project_id AS package_project_id,
      root.status AS package_status,
      root.branch_model_version AS branch_model_version,
      root.primary_branch_id AS package_primary_branch_id,
      root.main_composition_id AS package_main_composition_id,
      root.main_composition_sha256 AS package_main_composition_sha256,
      state.head_composition_id,
      state.head_composition_sha256,
      state.head_revision_id,
      state.lock_version AS branch_lock_version,
      state.status AS branch_state_status,
      package_copy.base_composition_id AS package_copy_composition_id,
      package_copy.base_revision_id AS package_copy_revision_id,
      package_copy.dirty AS package_copy_dirty,
      branch.head_revision_id AS article_head_revision_id,
      branch.status AS article_branch_status,
      revision.body_sha256 AS body_sha256,
      revision.body_text AS body_text,
      article_copy.base_revision_id AS article_copy_revision_id,
      article_copy.body_sha256 AS article_copy_body_sha256,
      article_copy.dirty AS article_copy_dirty,
      composition.composition_sha256 AS stored_composition_sha256,
      materialization.article_revision_id AS materialized_revision_id,
      materialization.article_body_sha256 AS materialized_body_sha256,
      slice.id AS slice_id,
      slice.slice_sha256,
      slice.slice_kind,
      slice.base_revision_id AS slice_revision_id,
      slice.base_branch_lock_version AS slice_branch_lock_version,
      slice.composition_id AS slice_composition_id,
      slice.composition_sha256 AS slice_composition_sha256,
      version.id AS publication_version_id,
      version.role AS publication_role,
      version.registration_sha256 AS publication_registration_sha256,
      version.publication_version_json AS publication_version_json,
      version.target_profile_id AS publication_target_profile_id,
      version.target_profile_sha256 AS publication_target_profile_sha256,
      version.baseline_version_id,
      version.baseline_branch_id,
      version.baseline_revision_id,
      version.baseline_body_sha256,
      version.baseline_composition_id,
      version.baseline_composition_sha256,
      canonical.id AS canonical_version_id,
      canonical.publication_version_json AS canonical_publication_version_json,
      canonical.branch_id AS canonical_branch_id,
      canonical.branch_lock_version AS canonical_branch_lock_version,
      canonical.revision_id AS canonical_revision_id,
      canonical.body_sha256 AS canonical_body_sha256,
      canonical.composition_id AS canonical_composition_id,
      canonical.composition_sha256 AS canonical_composition_sha256,
      canonical_state.status AS canonical_branch_state_status,
      canonical_state.lock_version AS canonical_state_lock_version,
      canonical_state.head_revision_id AS canonical_state_revision_id,
      canonical_state.head_composition_id AS canonical_state_composition_id,
      canonical_state.head_composition_sha256 AS canonical_state_composition_sha256,
      canonical_package_copy.dirty AS canonical_package_copy_dirty,
      canonical_package_copy.base_revision_id AS canonical_package_copy_revision_id,
      canonical_package_copy.base_composition_id AS canonical_package_copy_composition_id,
      canonical_branch.status AS canonical_article_branch_status,
      canonical_branch.head_revision_id AS canonical_article_head_revision_id,
      canonical_revision.body_sha256 AS canonical_head_body_sha256,
      canonical_revision.body_text AS canonical_body_text,
      canonical_article_copy.dirty AS canonical_article_copy_dirty,
      canonical_article_copy.base_revision_id AS canonical_article_copy_revision_id,
      canonical_article_copy.body_sha256 AS canonical_article_copy_body_sha256,
      canonical_composition.composition_sha256 AS canonical_stored_composition_sha256,
      canonical_materialization.article_revision_id AS canonical_materialized_revision_id,
      canonical_materialization.article_body_sha256 AS canonical_materialized_body_sha256
    FROM article_project_packages root
    LEFT JOIN package_branch_states state ON state.package_id = root.id AND state.branch_id = ?
    LEFT JOIN package_branch_working_copies package_copy
      ON package_copy.package_id = root.id AND package_copy.branch_id = state.branch_id
    LEFT JOIN article_branches branch ON branch.id = state.branch_id AND branch.article_id = root.article_id
    LEFT JOIN article_revisions revision
      ON revision.id = state.head_revision_id AND revision.branch_id = branch.id AND revision.article_id = root.article_id
    LEFT JOIN branch_working_copies article_copy
      ON article_copy.branch_id = branch.id AND article_copy.article_id = root.article_id
    LEFT JOIN package_compositions composition
      ON composition.id = state.head_composition_id AND composition.package_id = root.id
    LEFT JOIN package_composition_materializations materialization
      ON materialization.package_id = root.id AND materialization.branch_id = state.branch_id
      AND materialization.composition_id = state.head_composition_id
      AND materialization.article_revision_id = state.head_revision_id
    LEFT JOIN package_slices slice ON slice.id = ? AND slice.package_id = root.id AND slice.branch_id = state.branch_id
    LEFT JOIN article_publication_versions version
      ON version.id = ? AND version.package_id = root.id AND version.branch_id = state.branch_id AND version.state = 'active'
    LEFT JOIN article_publication_versions canonical
      ON canonical.id = version.baseline_version_id AND canonical.package_id = root.id
      AND canonical.role = 'canonical_baseline' AND canonical.state = 'active'
    LEFT JOIN package_branch_states canonical_state
      ON canonical_state.package_id = root.id AND canonical_state.branch_id = canonical.branch_id
    LEFT JOIN package_branch_working_copies canonical_package_copy
      ON canonical_package_copy.package_id = root.id
      AND canonical_package_copy.branch_id = canonical_state.branch_id
    LEFT JOIN article_branches canonical_branch
      ON canonical_branch.id = canonical.branch_id AND canonical_branch.article_id = root.article_id
    LEFT JOIN article_revisions canonical_revision
      ON canonical_revision.id = canonical_branch.head_revision_id
      AND canonical_revision.branch_id = canonical_branch.id
      AND canonical_revision.article_id = root.article_id
    LEFT JOIN branch_working_copies canonical_article_copy
      ON canonical_article_copy.branch_id = canonical_branch.id
      AND canonical_article_copy.article_id = root.article_id
    LEFT JOIN package_compositions canonical_composition
      ON canonical_composition.id = canonical_state.head_composition_id
      AND canonical_composition.package_id = root.id
    LEFT JOIN package_composition_materializations canonical_materialization
      ON canonical_materialization.package_id = root.id
      AND canonical_materialization.branch_id = canonical_state.branch_id
      AND canonical_materialization.composition_id = canonical_state.head_composition_id
      AND canonical_materialization.article_revision_id = canonical_state.head_revision_id
    WHERE root.id = ? LIMIT 1`)
    .bind(branchId, sliceId, publicationVersionId, packageId).first<D1Row>();
  if (!source
    || source.package_article_id !== project.article_id
    || (source.package_project_id !== null && source.package_project_id !== projectId)
    || source.package_status !== "active"
    || Number(source.branch_model_version) !== 2
    || source.branch_state_status !== "active"
    || Number(source.branch_lock_version) !== expectedBranchLockVersion
    || source.head_revision_id !== expectedRevisionId
    || source.body_sha256 !== expectedBodySha256
    || source.head_composition_id !== expectedCompositionId
    || source.head_composition_sha256 !== expectedCompositionSha256) {
    throw new LifecycleApiError("Package、分支头、Revision、正文或 Composition 已变化", 409);
  }
  const publicationVersion = parseJson<Record<string, unknown>>(source.publication_version_json, {});
  const semanticGate = await validateArticlePublicationSemanticGate(
    publicationVersion.semanticGate,
    String(source.body_text ?? ""),
    expectedBodySha256,
  );
  if (!semanticGate.valid) {
    throw new LifecycleApiError(`PublicationVersion 语义连续性门禁未通过：${semanticGate.errors.join("；")}`, 409);
  }
  const canonicalVersion = parseJson<Record<string, unknown>>(source.canonical_publication_version_json, {});
  const canonicalGate = await validateArticlePublicationSemanticGate(
    canonicalVersion.semanticGate,
    String(source.canonical_body_text ?? ""),
    String(source.canonical_body_sha256 ?? ""),
  );
  if (!canonicalGate.valid) {
    throw new LifecycleApiError(`canonical semantic gate 已变化或不能复验：${canonicalGate.errors.join("；")}`, 409);
  }
  const canonicalGateRecord = canonicalVersion.semanticGate !== null && typeof canonicalVersion.semanticGate === "object"
    && !Array.isArray(canonicalVersion.semanticGate) ? canonicalVersion.semanticGate as Record<string, unknown> : {};
  const bindingErrors = validatePlatformCanonicalContractBinding(
    publicationVersion.semanticGate,
    String(canonicalGateRecord.contractSha256 ?? "").toLowerCase(),
    String(canonicalGateRecord.primaryThesisSha256 ?? "").toLowerCase(),
  );
  if (bindingErrors.length) {
    throw new LifecycleApiError(`platform/canonical semantic contract 绑定无效：${bindingErrors.join("；")}`, 409);
  }
  if (Number(source.package_copy_dirty ?? 1) !== 0
    || source.package_copy_composition_id !== expectedCompositionId
    || source.package_copy_revision_id !== expectedRevisionId
    || source.article_branch_status !== "active"
    || source.article_head_revision_id !== expectedRevisionId
    || Number(source.article_copy_dirty ?? 1) !== 0
    || source.article_copy_revision_id !== expectedRevisionId
    || source.article_copy_body_sha256 !== expectedBodySha256
    || source.stored_composition_sha256 !== expectedCompositionSha256
    || source.materialized_revision_id !== expectedRevisionId
    || source.materialized_body_sha256 !== expectedBodySha256) {
    throw new LifecycleApiError("Package/Article 工作副本或 Composition materialization 不是当前干净分支头", 409);
  }
  if (source.slice_id !== sliceId
    || source.slice_sha256 !== expectedSliceSha256
    || source.slice_revision_id !== expectedRevisionId
    || Number(source.slice_branch_lock_version) !== expectedBranchLockVersion
    || source.slice_composition_id !== expectedCompositionId
    || source.slice_composition_sha256 !== expectedCompositionSha256
    || source.slice_kind !== contract.slice_kind) {
    throw new LifecycleApiError("Slice 未精确冻结当前 Branch/Revision/Composition 或 kind 不匹配", 409);
  }
  if (source.publication_version_id !== publicationVersionId
    || source.publication_role !== "platform_variant"
    || source.publication_registration_sha256 !== expectedPublicationRegistrationSha256
    || source.publication_target_profile_id !== contract.target_profile_id
    || source.publication_target_profile_sha256 !== expectedTargetProfileSha256
    || source.baseline_version_id !== source.canonical_version_id
    || !source.canonical_version_id
    || source.baseline_branch_id !== source.canonical_branch_id
    || source.baseline_revision_id !== source.canonical_revision_id
    || source.baseline_body_sha256 !== source.canonical_body_sha256
    || source.baseline_composition_id !== source.canonical_composition_id
    || source.baseline_composition_sha256 !== source.canonical_composition_sha256
    || source.canonical_branch_id !== source.package_primary_branch_id
    || source.canonical_branch_state_status !== "active"
    || Number(source.canonical_state_lock_version ?? 0)
      !== Number(source.canonical_branch_lock_version ?? -1)
    || source.canonical_state_revision_id !== source.canonical_revision_id
    || source.canonical_state_composition_id !== source.canonical_composition_id
    || source.canonical_state_composition_sha256 !== source.canonical_composition_sha256
    || Number(source.canonical_package_copy_dirty ?? 1) !== 0
    || source.canonical_package_copy_revision_id !== source.canonical_revision_id
    || source.canonical_package_copy_composition_id !== source.canonical_composition_id
    || source.canonical_article_branch_status !== "active"
    || source.canonical_article_head_revision_id !== source.canonical_revision_id
    || source.canonical_head_body_sha256 !== source.canonical_body_sha256
    || Number(source.canonical_article_copy_dirty ?? 1) !== 0
    || source.canonical_article_copy_revision_id !== source.canonical_revision_id
    || source.canonical_article_copy_body_sha256 !== source.canonical_body_sha256
    || source.canonical_composition_id !== source.package_main_composition_id
    || source.canonical_composition_sha256 !== source.package_main_composition_sha256
    || source.canonical_stored_composition_sha256 !== source.canonical_composition_sha256
    || source.canonical_materialized_revision_id !== source.canonical_revision_id
    || source.canonical_materialized_body_sha256 !== source.canonical_body_sha256) {
    throw new LifecycleApiError("PublicationVersion 未绑定当前平台目标或 canonical baseline", 409);
  }

  const cover = await readCurrentCoverReceiptChain(db, {
    coverRunId,
    articleId: String(project.article_id),
    branchId,
    bodySha256: expectedBodySha256,
  });
  if (cover.finalReceipt.receiptId !== expectedCoverReceiptId
    || cover.finalReceiptSha256 !== expectedCoverReceiptSha256
    || cover.finalReceipt.artifact.sha256 !== expectedCoverArtifactSha256
    || cover.finalReceipt.baseline.id !== INFORMATION_COVER_BASELINE_ID) {
    throw new LifecycleApiError("终态封面回执、工件摘要或 canonical baseline 已变化", 409);
  }
  const bindingIdentity = {
    schemaVersion: "wenmai.lifecycle-build-input-binding/1.0.0",
    packageId,
    branchId,
    branchLockVersion: expectedBranchLockVersion,
    revisionId: expectedRevisionId,
    sourceBodySha256: expectedBodySha256,
    compositionId: expectedCompositionId,
    compositionSha256: expectedCompositionSha256,
    sliceId,
    sliceSha256: expectedSliceSha256,
    publicationVersionId,
    publicationRegistrationSha256: expectedPublicationRegistrationSha256,
    coverRunId,
    coverRecipeId: cover.recipe.id,
    coverRecipeVersion: cover.recipe.version,
    coverRecipeSha256: cover.recipe.sha256,
    coverReceiptId: cover.finalReceipt.receiptId,
    coverReceiptSchemaVersion: cover.finalReceipt.schemaVersion,
    coverReceiptSha256: cover.finalReceiptSha256,
    coverReceiptChainSha256: cover.receiptChainSha256,
    coverArtifactSha256: cover.finalReceipt.artifact.sha256,
    coverBaselineId: cover.finalReceipt.baseline.id,
    coverBaselineSha256: cover.finalReceipt.baseline.sha256,
    coverProfileSha256: INFORMATION_COVER_PROFILE_SHA256,
    targetProfileSha256: expectedTargetProfileSha256,
    contractSha256: expectedContractSha256,
  };
  const inputBindingSha256 = await digest(bindingIdentity);
  const id = `content-build-${crypto.randomUUID()}`;
  const now = isoNow();
  const inputSha256 = await digest({ action: "create_build", projectId, contractId, buildId: id, inputBindingSha256 });
  const coverStepGuard = INFORMATION_COVER_RECIPE_STEP_IDS.map(() => `AND EXISTS (
    SELECT 1 FROM production_run_steps cover_step
    WHERE cover_step.run_id = ? AND cover_step.step_id = ? AND cover_step.status = 'complete'
      AND json_extract(cover_step.evidence_json, '$[#-1]') = ?
  )`).join("\n");
  const coverStepBindings = INFORMATION_COVER_RECIPE_STEP_IDS.flatMap((stepId, index) => [
    coverRunId,
    stepId,
    cover.evidenceTexts[index],
  ]);
  const buildInsert = db.prepare(`INSERT INTO lifecycle_builds
    (id, project_id, article_id, branch_id, revision_id, source_title, source_body_sha256,
     target_profile_id, target_profile_sha256, adaptation_contract_id, contract_sha256, slice_kind,
     state, created_at, updated_at)
    SELECT ?, p.id, p.article_id, b.id, r.id, r.document_title, r.body_sha256,
      t.id, t.profile_sha256, c.id, c.contract_sha256, c.slice_kind, 'planned', ?, ?
    FROM lifecycle_article_projects p
    JOIN lifecycle_adaptation_contracts c ON c.project_id = p.id AND c.article_id = p.article_id
    JOIN lifecycle_platform_targets t ON t.id = c.target_profile_id
    JOIN article_branches b ON b.article_id = p.article_id
    JOIN branch_working_copies w ON w.branch_id = b.id AND w.article_id = p.article_id
    JOIN article_revisions r ON r.id = b.head_revision_id AND r.branch_id = b.id AND r.article_id = p.article_id
    WHERE p.id = ? AND p.execution_state = 'active' AND p.phase IN ('production','packaging','release','operate')
      AND c.id = ? AND c.status = 'approved' AND c.contract_sha256 = ?
      AND c.source_revision_id = ? AND c.source_body_sha256 = ?
      AND t.status = 'active' AND t.connection_mode = 'manual' AND t.profile_sha256 = ?
      AND COALESCE(json_extract(t.profile_json, '$.enabled'), 1) != 0
      AND b.id = ? AND b.status = 'active' AND b.head_revision_id = ?
      AND w.dirty = 0 AND w.base_revision_id = b.head_revision_id
      AND w.body_sha256 = r.body_sha256 AND w.body_sha256 = ? AND w.title = r.document_title
      AND EXISTS (SELECT 1 FROM article_project_packages root
        JOIN package_branch_states state ON state.package_id = root.id AND state.branch_id = ?
        JOIN package_branch_working_copies package_copy
          ON package_copy.package_id = root.id AND package_copy.branch_id = state.branch_id
        JOIN package_composition_materializations materialization
          ON materialization.package_id = root.id AND materialization.branch_id = state.branch_id
          AND materialization.composition_id = state.head_composition_id
          AND materialization.article_revision_id = state.head_revision_id
        JOIN package_slices slice ON slice.id = ? AND slice.package_id = root.id AND slice.branch_id = state.branch_id
        JOIN article_publication_versions version
          ON version.id = ? AND version.package_id = root.id AND version.branch_id = state.branch_id AND version.state = 'active'
        JOIN article_publication_versions canonical
          ON canonical.id = version.baseline_version_id AND canonical.package_id = root.id
          AND canonical.role = 'canonical_baseline' AND canonical.state = 'active'
        JOIN package_branch_states canonical_state
          ON canonical_state.package_id = root.id AND canonical_state.branch_id = canonical.branch_id
        JOIN package_branch_working_copies canonical_package_copy
          ON canonical_package_copy.package_id = root.id
          AND canonical_package_copy.branch_id = canonical_state.branch_id
        JOIN article_branches canonical_branch
          ON canonical_branch.id = canonical.branch_id AND canonical_branch.article_id = root.article_id
        JOIN article_revisions canonical_revision
          ON canonical_revision.id = canonical_branch.head_revision_id
          AND canonical_revision.branch_id = canonical_branch.id
          AND canonical_revision.article_id = root.article_id
        JOIN branch_working_copies canonical_article_copy
          ON canonical_article_copy.branch_id = canonical_branch.id
          AND canonical_article_copy.article_id = root.article_id
        JOIN package_compositions canonical_composition
          ON canonical_composition.id = canonical_state.head_composition_id
          AND canonical_composition.package_id = root.id
        JOIN package_composition_materializations canonical_materialization
          ON canonical_materialization.package_id = root.id
          AND canonical_materialization.branch_id = canonical_state.branch_id
          AND canonical_materialization.composition_id = canonical_state.head_composition_id
          AND canonical_materialization.article_revision_id = canonical_state.head_revision_id
        WHERE root.id = ? AND root.article_id = p.article_id
          AND root.status = 'active' AND root.branch_model_version = 2
          AND state.status = 'active' AND state.lock_version = ?
          AND state.head_revision_id = ? AND state.head_composition_id = ? AND state.head_composition_sha256 = ?
          AND package_copy.dirty = 0 AND package_copy.base_revision_id = state.head_revision_id
          AND package_copy.base_composition_id = state.head_composition_id
          AND materialization.composition_sha256 = state.head_composition_sha256
          AND materialization.article_body_sha256 = ?
          AND slice.slice_sha256 = ? AND slice.base_branch_lock_version = state.lock_version
          AND slice.base_revision_id = state.head_revision_id
          AND slice.composition_id = state.head_composition_id
          AND slice.composition_sha256 = state.head_composition_sha256
          AND version.role = 'platform_variant' AND version.registration_sha256 = ?
          AND version.target_profile_id = t.id AND version.target_profile_key = t.profile_key
          AND version.target_profile_sha256 = t.profile_sha256
          AND version.baseline_branch_id = canonical.branch_id
          AND version.baseline_revision_id = canonical.revision_id
          AND version.baseline_body_sha256 = canonical.body_sha256
          AND version.baseline_composition_id = canonical.composition_id
          AND version.baseline_composition_sha256 = canonical.composition_sha256
          AND canonical.branch_id = root.primary_branch_id
          AND canonical.composition_id = root.main_composition_id
          AND canonical.composition_sha256 = root.main_composition_sha256
          AND canonical_state.status = 'active'
          AND canonical_state.lock_version = canonical.branch_lock_version
          AND canonical_state.head_revision_id = canonical.revision_id
          AND canonical_state.head_composition_id = canonical.composition_id
          AND canonical_state.head_composition_sha256 = canonical.composition_sha256
          AND canonical_package_copy.dirty = 0
          AND canonical_package_copy.base_revision_id = canonical.revision_id
          AND canonical_package_copy.base_composition_id = canonical.composition_id
          AND canonical_branch.status = 'active'
          AND canonical_branch.head_revision_id = canonical.revision_id
          AND canonical_revision.body_sha256 = canonical.body_sha256
          AND canonical_article_copy.dirty = 0
          AND canonical_article_copy.base_revision_id = canonical.revision_id
          AND canonical_article_copy.body_sha256 = canonical.body_sha256
          AND canonical_composition.composition_sha256 = canonical.composition_sha256
          AND canonical_materialization.composition_sha256 = canonical.composition_sha256
          AND canonical_materialization.article_body_sha256 = canonical.body_sha256)
      AND EXISTS (SELECT 1 FROM production_runs cover_run WHERE cover_run.id = ?
        AND cover_run.article_id = p.article_id AND cover_run.branch_id = b.id
        AND cover_run.recipe_id = ? AND cover_run.recipe_version = ? AND cover_run.recipe_sha256 = ?)
      ${coverStepGuard}
    LIMIT 1`).bind(
      id, now, now, projectId, contractId, expectedContractSha256,
      expectedRevisionId, expectedBodySha256, expectedTargetProfileSha256,
      branchId, expectedRevisionId, expectedBodySha256,
      branchId, sliceId, publicationVersionId, packageId, expectedBranchLockVersion,
      expectedRevisionId, expectedCompositionId, expectedCompositionSha256, expectedBodySha256,
      expectedSliceSha256, expectedPublicationRegistrationSha256,
      coverRunId, cover.recipe.id, cover.recipe.version, cover.recipe.sha256,
      ...coverStepBindings,
    );
  const bindingInsert = db.prepare(`INSERT INTO lifecycle_build_input_bindings
    (build_id, input_binding_sha256, package_id, branch_id, branch_lock_version,
     revision_id, source_body_sha256, composition_id, composition_sha256, slice_id, slice_sha256,
     publication_version_id, publication_registration_sha256,
     cover_run_id, cover_recipe_id, cover_recipe_version, cover_recipe_sha256,
     cover_receipt_id, cover_receipt_schema_version, cover_receipt_json, cover_receipt_sha256,
     cover_receipt_chain_json, cover_receipt_chain_sha256, cover_artifact_sha256,
     cover_baseline_id, cover_baseline_sha256, cover_profile_sha256, created_at)
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    FROM lifecycle_builds WHERE id = ? AND state = 'planned' AND revision_id = ? AND source_body_sha256 = ?`).bind(
      id, inputBindingSha256, packageId, branchId, expectedBranchLockVersion,
      expectedRevisionId, expectedBodySha256, expectedCompositionId, expectedCompositionSha256,
      sliceId, expectedSliceSha256, publicationVersionId, expectedPublicationRegistrationSha256,
      coverRunId, cover.recipe.id, cover.recipe.version, cover.recipe.sha256,
      cover.finalReceipt.receiptId, cover.finalReceipt.schemaVersion, cover.finalReceiptJson, cover.finalReceiptSha256,
      cover.receiptChainJson, cover.receiptChainSha256, cover.finalReceipt.artifact.sha256,
      cover.finalReceipt.baseline.id, cover.finalReceipt.baseline.sha256, INFORMATION_COVER_PROFILE_SHA256, now,
      id, expectedRevisionId, expectedBodySha256,
    );
  const results = await db.batch([
    buildInsert,
    bindingInsert,
    eventFromRow(db, {
      articleId: String(project.article_id),
      eventType: "build.inputs_frozen",
      subjectType: "build",
      subjectId: id,
      payload: {
        claim: "composition_slice_cover_and_publication_inputs_frozen",
        inputBindingSha256,
        compositionId: expectedCompositionId,
        sliceId,
        publicationVersionId,
        coverReceiptId: cover.finalReceipt.receiptId,
        coverArtifactSha256: cover.finalReceipt.artifact.sha256,
        artifactCreated: false,
      },
    }, inputSha256, "lifecycle_build_input_bindings",
    "build_id = ? AND input_binding_sha256 = ?", [id, inputBindingSha256], now),
  ]);
  if (Number(results[0]?.meta.changes ?? 0) !== 1
    || Number(results[1]?.meta.changes ?? 0) !== 1
    || Number(results[2]?.meta.changes ?? 0) !== 1) {
    throw new LifecycleApiError("无法冻结 Build：Composition、Slice、PublicationVersion、封面回执或项目合同已变化", 409);
  }
  const row = await rowById(db, "lifecycle_builds", id);
  const inputBinding = await evaluateBuildInputBinding(db, id);
  return Response.json({
    ok: true,
    build: row ? {
      ...parseBuild(row),
      inputBinding,
      inputCurrentness: inputBinding?.currentness ?? "legacy_unbound",
      inputBlockers: inputBinding?.blockers ?? ["legacy_build_unbound"],
    } : null,
  }, { status: 201 });
}

async function recordBuildResult(db: D1Database, payload: Record<string, unknown>) {
  const buildId = requiredText(payload.buildId, "Build ID", 120);
  const targetState = requiredText(payload.targetState, "Build 结果状态", 40);
  if (!buildStateSet.has(targetState) || !["built", "failed"].includes(targetState)) {
    throw new LifecycleApiError("Build 结果只能记录为 built 或 failed");
  }
  const row = await rowById(db, "lifecycle_builds", buildId);
  if (!row) throw new LifecycleApiError("Build 不存在", 404);
  const now = isoNow();

  if (targetState === "built") {
    const inputBinding = await requireCurrentBuildInputBinding(db, buildId);
    const artifactRef = requiredText(payload.artifactRef, "制品引用", 1000);
    const artifactSha256 = requiredSha(payload.artifactSha256, "制品摘要");
    const artifactMediaType = requiredText(payload.artifactMediaType, "制品媒体类型", 160);
    const manifest = jsonObject(payload.artifactManifest, "制品清单", false);
    const inputSha256 = await digest({
      action: "record_build_result",
      buildId,
      targetState,
      artifactRef,
      artifactSha256,
      artifactMediaType,
      manifest,
      frozen: {
        inputBindingSha256: inputBinding.inputBindingSha256,
        revisionId: row.revision_id,
        sourceBodySha256: row.source_body_sha256,
        targetProfileSha256: row.target_profile_sha256,
        contractSha256: row.contract_sha256,
      },
    });
    const results = await db.batch([
      db.prepare(`UPDATE lifecycle_builds SET state = 'built', artifact_ref = ?, artifact_sha256 = ?,
        artifact_media_type = ?, artifact_manifest_json = ?, failure_summary = '', built_at = ?, updated_at = ?
        WHERE id = ? AND state = 'planned' AND revision_id = ? AND source_body_sha256 = ?
          AND target_profile_sha256 = ? AND contract_sha256 = ?
          AND ${currentBuildInputSql("lifecycle_builds")}`)
        .bind(
          artifactRef,
          artifactSha256,
          artifactMediaType,
          canonicalJson(manifest),
          now,
          now,
          buildId,
          row.revision_id,
          row.source_body_sha256,
          row.target_profile_sha256,
          row.contract_sha256,
        ),
      eventFromRow(db, {
        articleId: String(row.article_id),
        eventType: "build.artifact_created",
        subjectType: "build",
        subjectId: buildId,
        payload: {
          state: "built",
          artifactSha256,
          artifactMediaType,
          compatibilityPassed: false,
          fidelityPassed: false,
          releaseCreated: false,
        },
      }, inputSha256, "lifecycle_builds", "id = ? AND state = 'built' AND artifact_sha256 = ? AND updated_at = ?", [buildId, artifactSha256, now], now),
    ]);
    assertMutation(results, 0, 1, "Build 已被另一结果完成或冻结输入已变化");
  } else {
    const failureSummary = requiredText(payload.failureSummary, "失败摘要", 4000);
    const inputSha256 = await digest({ action: "record_build_result", buildId, targetState, failureSummary });
    const results = await db.batch([
      db.prepare(`UPDATE lifecycle_builds SET state = 'failed', failure_summary = ?, updated_at = ?
        WHERE id = ? AND state = 'planned'`).bind(failureSummary, now, buildId),
      eventFromRow(db, {
        articleId: String(row.article_id), eventType: "build.failed", subjectType: "build", subjectId: buildId,
        payload: { state: "failed", failureSummary, artifactCreated: false },
      }, inputSha256, "lifecycle_builds", "id = ? AND state = 'failed' AND updated_at = ?", [buildId, now], now),
    ]);
    assertMutation(results, 0, 1, "Build 已被另一结果完成");
  }

  const updated = await rowById(db, "lifecycle_builds", buildId);
  return Response.json({ ok: true, build: updated ? parseBuild(updated) : null });
}

async function supersedeBuild(db: D1Database, payload: Record<string, unknown>) {
  const buildId = requiredText(payload.buildId, "Build ID", 120);
  const note = requiredText(payload.note, "替代说明", 2000);
  const row = await rowById(db, "lifecycle_builds", buildId);
  if (!row) throw new LifecycleApiError("Build 不存在", 404);
  if (String(row.state) === "superseded") throw new LifecycleApiError("Build 已经被替代", 409);
  const now = isoNow();
  const inputSha256 = await digest({ action: "supersede_build", buildId, previousState: row.state, note });
  const results = await db.batch([
    db.prepare("UPDATE lifecycle_builds SET state = 'superseded', updated_at = ? WHERE id = ? AND state = ?")
      .bind(now, buildId, row.state),
    eventFromRow(db, {
      articleId: String(row.article_id), eventType: "build.superseded", subjectType: "build", subjectId: buildId,
      payload: { from: String(row.state), to: "superseded", note },
    }, inputSha256, "lifecycle_builds", "id = ? AND state = 'superseded' AND updated_at = ?", [buildId, now], now),
  ]);
  assertMutation(results, 0, 1, "Build 状态已变化");
  const updated = await rowById(db, "lifecycle_builds", buildId);
  return Response.json({ ok: true, build: updated ? parseBuild(updated) : null });
}

async function recordBuildGate(db: D1Database, payload: Record<string, unknown>) {
  const buildId = requiredText(payload.buildId, "Build ID", 120);
  const gateKind = requiredText(payload.gateKind, "门禁类型", 40);
  if (!gateKindSet.has(gateKind)) throw new LifecycleApiError("门禁类型只能是 compatibility 或 fidelity");
  const result = requiredText(payload.result, "门禁结果", 40);
  if (!gateResultSet.has(result)) throw new LifecycleApiError("门禁结果只能是 pass、fail 或 inconclusive");
  const artifactSha256 = requiredSha(payload.artifactSha256, "门禁制品摘要");
  const evidence = stringArray(payload.evidence, "门禁证据", true, 50);
  const details = jsonObject(payload.details, "门禁详情", false);
  const row = await rowById(db, "lifecycle_builds", buildId);
  if (!row) throw new LifecycleApiError("Build 不存在", 404);
  if (row.state !== "built" || row.artifact_sha256 !== artifactSha256) {
    throw new LifecycleApiError("门禁只能检查当前 built 制品，且制品摘要必须精确匹配", 409);
  }
  const inputBinding = await requireCurrentBuildInputBinding(db, buildId);
  const target = await rowById(db, "lifecycle_platform_targets", String(row.target_profile_id));
  if (isMaimaiTargetRow(target) && result === "pass") requireMaimaiGateDetails(row, gateKind, details);
  if (isVideoTargetRow(target) && result === "pass") requireVideoGateDetails(row, target!, gateKind, details);
  const id = `build-gate-${crypto.randomUUID()}`;
  const now = isoNow();
  const inputSha256 = await digest({
    action: "record_build_gate",
    buildId,
    gateKind,
    result,
    artifactSha256,
    targetProfileSha256: row.target_profile_sha256,
    contractSha256: row.contract_sha256,
    inputBindingSha256: inputBinding.inputBindingSha256,
    evidence,
    details,
  });
  const results = await db.batch([
    db.prepare(`INSERT INTO lifecycle_build_gate_runs
      (id, build_id, project_id, article_id, gate_kind, result, artifact_sha256,
       target_profile_sha256, contract_sha256, evidence_json, details_json, input_sha256, created_at)
      SELECT ?, id, project_id, article_id, ?, ?, artifact_sha256, target_profile_sha256,
        contract_sha256, ?, ?, ?, ? FROM lifecycle_builds
      WHERE id = ? AND state = 'built' AND artifact_sha256 = ? AND target_profile_sha256 = ? AND contract_sha256 = ?
        AND ${currentBuildInputSql("lifecycle_builds")}`)
      .bind(
        id,
        gateKind,
        result,
        canonicalJson(evidence),
        canonicalJson(details),
        inputSha256,
        now,
        buildId,
        artifactSha256,
        row.target_profile_sha256,
        row.contract_sha256,
      ),
    eventFromRow(db, {
      articleId: String(row.article_id), eventType: `build_gate.${gateKind}_recorded`, subjectType: "build_gate", subjectId: id,
      payload: { buildId, gateKind, result, artifactSha256, inputSha256 },
    }, inputSha256, "lifecycle_build_gate_runs", "id = ? AND input_sha256 = ?", [id, inputSha256], now),
  ]);
  assertMutation(results, 0, 1, "Build 或制品摘要已变化，门禁结果未记录");
  const gate = await rowById(db, "lifecycle_build_gate_runs", id);
  return Response.json({ ok: true, buildGate: gate ? parseBuildGate(gate) : null }, { status: 201 });
}

async function createRelease(db: D1Database, payload: Record<string, unknown>) {
  const buildId = requiredText(payload.buildId, "Build ID", 120);
  const row = await rowById(db, "lifecycle_builds", buildId);
  if (!row) throw new LifecycleApiError("Build 不存在", 404);
  if (row.state !== "built" || !SHA256_RE.test(String(row.artifact_sha256))) {
    throw new LifecycleApiError("只有已经生成且绑定摘要的 built 制品可以建立 Release", 409);
  }
  const inputBinding = await requireCurrentBuildInputBinding(db, buildId);
  const target = await rowById(db, "lifecycle_platform_targets", String(row.target_profile_id));
  await requireCurrentMaimaiStructuredGates(db, row, target);
  await requireCurrentVideoStructuredGates(db, row, target);
  const id = `content-release-${crypto.randomUUID()}`;
  const now = isoNow();
  const inputSha256 = await digest({
    action: "create_release",
    buildId,
    buildArtifactSha256: row.artifact_sha256,
    targetProfileSha256: row.target_profile_sha256,
    inputBindingSha256: inputBinding.inputBindingSha256,
    compatibilityRequired: "latest_pass",
    fidelityRequired: "latest_pass",
  });
  const latestPassingGate = (kind: string) => `(
    SELECT g.result FROM lifecycle_build_gate_runs g
    WHERE g.build_id = b.id AND g.gate_kind = '${kind}'
      AND g.artifact_sha256 = b.artifact_sha256
      AND g.target_profile_sha256 = b.target_profile_sha256
      AND g.contract_sha256 = b.contract_sha256
    ORDER BY g.rowid DESC LIMIT 1
  ) = 'pass'`;
  const results = await db.batch([
    db.prepare(`INSERT INTO lifecycle_releases
      (id, project_id, article_id, build_id, build_artifact_sha256, target_profile_id,
       target_profile_sha256, approval_state, readiness_state, submission_state, destination_state, public_state,
       lifecycle_state, lock_version, created_at, updated_at)
      SELECT ?, b.project_id, b.article_id, b.id, b.artifact_sha256, b.target_profile_id,
        b.target_profile_sha256, 'draft', 'artifact_validated', 'not_submitted', 'not_checked', 'not_checked', 'active', 1, ?, ?
      FROM lifecycle_builds b
      WHERE b.id = ? AND b.state = 'built' AND b.artifact_sha256 = ?
        AND EXISTS (SELECT 1 FROM lifecycle_article_projects p
          WHERE p.id = b.project_id AND p.article_id = b.article_id AND p.execution_state = 'active')
        AND EXISTS (SELECT 1 FROM lifecycle_platform_targets t
          WHERE t.id = b.target_profile_id AND t.status = 'active' AND t.connection_mode = 'manual'
            AND COALESCE(json_extract(t.profile_json, '$.enabled'), 1) != 0
            AND t.profile_sha256 = b.target_profile_sha256)
        AND EXISTS (SELECT 1 FROM lifecycle_adaptation_contracts c
          WHERE c.id = b.adaptation_contract_id AND c.project_id = b.project_id AND c.article_id = b.article_id
            AND c.status = 'approved' AND c.contract_sha256 = b.contract_sha256
            AND c.target_profile_id = b.target_profile_id AND c.target_profile_sha256 = b.target_profile_sha256
             AND c.source_revision_id = b.revision_id AND c.source_body_sha256 = b.source_body_sha256)
        AND ${currentBuildInputSql("b")}
        AND ${latestPassingGate("compatibility")}
        AND ${latestPassingGate("fidelity")}
        AND NOT EXISTS (SELECT 1 FROM lifecycle_releases r WHERE r.build_id = b.id AND r.lifecycle_state = 'active')
      LIMIT 1`)
      .bind(id, now, now, buildId, row.artifact_sha256),
    eventFromRow(db, {
      articleId: String(row.article_id), eventType: "release.draft_created", subjectType: "release", subjectId: id,
      payload: {
        buildId,
        buildArtifactSha256: String(row.artifact_sha256),
        approvalState: "draft",
        readinessState: "artifact_validated",
        submissionState: "not_submitted",
        destinationState: "not_checked",
        publicState: "not_checked",
        claim: "release_record_created_only",
      },
    }, inputSha256, "lifecycle_releases", "id = ? AND approval_state = 'draft' AND submission_state = 'not_submitted'", [id], now),
  ]);
  assertMutation(results, 0, 1, "Release 未创建：Build 输入必须 current，项目、画像、合同仍有效且两类最新门禁通过，或该 Build 已有活动 Release");
  const release = await rowById(db, "lifecycle_releases", id);
  return Response.json({ ok: true, release: release ? parseRelease(release) : null }, { status: 201 });
}

async function decideReleaseApproval(db: D1Database, payload: Record<string, unknown>) {
  const releaseId = requiredText(payload.releaseId, "Release ID", 120);
  const targetState = requiredText(payload.targetState, "审批结果", 40);
  if (!releaseApprovalSet.has(targetState) || !["approved", "rejected"].includes(targetState)) {
    throw new LifecycleApiError("审批结果只能是 approved 或 rejected");
  }
  const expectedLockVersion = requiredPositiveInteger(payload.expectedLockVersion, "expectedLockVersion");
  const note = requiredText(payload.note, "审批说明", 4000);
  const row = await rowById(db, "lifecycle_releases", releaseId);
  if (!row) throw new LifecycleApiError("Release 不存在", 404);
  if (row.approval_state !== "draft") throw new LifecycleApiError("Release 已经完成审批决定", 409);
  const target = await rowById(db, "lifecycle_platform_targets", String(row.target_profile_id));
  const build = await rowById(db, "lifecycle_builds", String(row.build_id));
  if (!build) throw new LifecycleApiError("Release 绑定的 Build 不存在", 409);
  const inputBinding = targetState === "approved"
    ? await requireCurrentBuildInputBinding(db, String(row.build_id))
    : null;
  const maimaiGates = await requireCurrentMaimaiStructuredGates(db, build, target);
  const videoGates = await requireCurrentVideoStructuredGates(db, build, target);
  const approvalBinding = isMaimaiTargetRow(target) && targetState === "approved"
    ? requireMaimaiApprovalBinding(row, build, maimaiGates!, payload.approvalBinding)
    : isVideoTargetRow(target) && targetState === "approved"
      ? requireVideoApprovalBinding(row, build, videoGates!, payload.approvalBinding)
      : null;
  const now = isoNow();
  const nextLock = expectedLockVersion + 1;
  const inputSha256 = await digest({
    action: "decide_release_approval",
    releaseId,
    targetState,
    expectedLockVersion,
    note,
    buildArtifactSha256: row.build_artifact_sha256,
    inputBindingSha256: inputBinding?.inputBindingSha256 ?? null,
    approvalBinding,
  });
  const gateGuard = targetState === "approved"
    ? `AND (SELECT result FROM lifecycle_build_gate_runs
        WHERE build_id = lifecycle_releases.build_id AND gate_kind = 'compatibility'
          AND artifact_sha256 = lifecycle_releases.build_artifact_sha256
          AND target_profile_sha256 = lifecycle_releases.target_profile_sha256
          AND contract_sha256 = (SELECT contract_sha256 FROM lifecycle_builds WHERE id = lifecycle_releases.build_id)
        ORDER BY rowid DESC LIMIT 1) = 'pass'
       AND (SELECT result FROM lifecycle_build_gate_runs
        WHERE build_id = lifecycle_releases.build_id AND gate_kind = 'fidelity'
          AND artifact_sha256 = lifecycle_releases.build_artifact_sha256
          AND target_profile_sha256 = lifecycle_releases.target_profile_sha256
          AND contract_sha256 = (SELECT contract_sha256 FROM lifecycle_builds WHERE id = lifecycle_releases.build_id)
        ORDER BY rowid DESC LIMIT 1) = 'pass'
       AND EXISTS (SELECT 1 FROM lifecycle_builds b
         JOIN lifecycle_article_projects p ON p.id = b.project_id AND p.article_id = b.article_id
         JOIN lifecycle_platform_targets t ON t.id = b.target_profile_id
         JOIN lifecycle_adaptation_contracts c ON c.id = b.adaptation_contract_id
         WHERE b.id = lifecycle_releases.build_id AND b.state = 'built'
           AND b.artifact_sha256 = lifecycle_releases.build_artifact_sha256
           AND p.execution_state = 'active'
           AND t.status = 'active' AND t.connection_mode = 'manual' AND t.profile_sha256 = b.target_profile_sha256
           AND COALESCE(json_extract(t.profile_json, '$.enabled'), 1) != 0
           AND c.status = 'approved' AND c.project_id = b.project_id AND c.article_id = b.article_id
           AND c.contract_sha256 = b.contract_sha256 AND c.target_profile_id = b.target_profile_id
           AND c.target_profile_sha256 = b.target_profile_sha256
            AND c.source_revision_id = b.revision_id AND c.source_body_sha256 = b.source_body_sha256
            AND ${currentBuildInputSql("b")})`
    : "";
  const results = await db.batch([
    db.prepare(`UPDATE lifecycle_releases SET approval_state = ?, approval_note = ?,
      lock_version = lock_version + 1, updated_at = ?
      WHERE id = ? AND approval_state = 'draft' AND lifecycle_state = 'active' AND lock_version = ? ${gateGuard}`)
      .bind(targetState, note, now, releaseId, expectedLockVersion),
    eventFromRow(db, {
      articleId: String(row.article_id), eventType: "release.approval_decided", subjectType: "release", subjectId: releaseId,
      payload: { from: "draft", to: targetState, note, buildArtifactSha256: String(row.build_artifact_sha256), approvalBinding },
    }, inputSha256, "lifecycle_releases", "id = ? AND approval_state = ? AND lock_version = ? AND updated_at = ?", [releaseId, targetState, nextLock, now], now),
  ]);
  assertMutation(results, 0, 1, "Release 状态或锁版本已变化；批准还要求 Build 输入 current、项目/画像/合同有效且两类最新门禁通过");
  const updated = await rowById(db, "lifecycle_releases", releaseId);
  return Response.json({ ok: true, release: updated ? parseRelease(updated) : null });
}

async function markReleaseReady(db: D1Database, payload: Record<string, unknown>) {
  const releaseId = requiredText(payload.releaseId, "Release ID", 120);
  const expectedLockVersion = requiredPositiveInteger(payload.expectedLockVersion, "expectedLockVersion");
  const row = await rowById(db, "lifecycle_releases", releaseId);
  if (!row) throw new LifecycleApiError("Release 不存在", 404);
  if (!releaseReadinessSet.has(String(row.readiness_state ?? "draft"))) throw new LifecycleApiError("Release readiness 状态无效", 409);
  if (row.approval_state !== "approved" || row.submission_state !== "not_submitted") {
    throw new LifecycleApiError("只有已批准且尚未提交的 Release 才能明确标记为 ready_to_submit", 409);
  }
  const build = await rowById(db, "lifecycle_builds", String(row.build_id));
  if (!build) throw new LifecycleApiError("Release 绑定的 Build 不存在", 409);
  const inputBinding = await requireCurrentBuildInputBinding(db, String(row.build_id));
  const target = await rowById(db, "lifecycle_platform_targets", String(row.target_profile_id));
  await requireCurrentMaimaiStructuredGates(db, build, target);
  await requireCurrentVideoStructuredGates(db, build, target);
  const readyAt = isoNow();
  const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
  const readinessEvidenceSha256 = await digest({
    releaseId, buildId: row.build_id, buildArtifactSha256: row.build_artifact_sha256,
    targetProfileSha256: row.target_profile_sha256, contractSha256: build.contract_sha256,
    inputBindingSha256: inputBinding.inputBindingSha256, approvalState: row.approval_state,
    submissionState: row.submission_state, readyAt, expiresAt, compatibilityRequired: "latest_pass", fidelityRequired: "latest_pass",
  });
  const inputSha256 = await digest({ action: "mark_release_ready", releaseId, expectedLockVersion, readinessEvidenceSha256, readyAt, expiresAt });
  const results = await db.batch([
    db.prepare(`UPDATE lifecycle_releases SET readiness_state = 'ready_to_submit', readiness_evidence_sha256 = ?,
      ready_at = ?, expires_at = ?, lock_version = lock_version + 1, updated_at = ?
      WHERE id = ? AND approval_state = 'approved' AND submission_state = 'not_submitted'
        AND readiness_state IN ('artifact_validated','ready_to_submit','stale') AND lifecycle_state = 'active' AND lock_version = ?
        AND (SELECT result FROM lifecycle_build_gate_runs WHERE build_id = lifecycle_releases.build_id AND gate_kind = 'compatibility'
          AND artifact_sha256 = lifecycle_releases.build_artifact_sha256 AND target_profile_sha256 = lifecycle_releases.target_profile_sha256
          AND contract_sha256 = (SELECT contract_sha256 FROM lifecycle_builds WHERE id = lifecycle_releases.build_id) ORDER BY rowid DESC LIMIT 1) = 'pass'
        AND (SELECT result FROM lifecycle_build_gate_runs WHERE build_id = lifecycle_releases.build_id AND gate_kind = 'fidelity'
          AND artifact_sha256 = lifecycle_releases.build_artifact_sha256 AND target_profile_sha256 = lifecycle_releases.target_profile_sha256
          AND contract_sha256 = (SELECT contract_sha256 FROM lifecycle_builds WHERE id = lifecycle_releases.build_id) ORDER BY rowid DESC LIMIT 1) = 'pass'
        AND EXISTS (SELECT 1 FROM lifecycle_builds b JOIN lifecycle_article_projects p ON p.id = b.project_id AND p.article_id = b.article_id
          JOIN lifecycle_platform_targets t ON t.id = b.target_profile_id JOIN lifecycle_adaptation_contracts c ON c.id = b.adaptation_contract_id
          WHERE b.id = lifecycle_releases.build_id AND b.state = 'built' AND b.artifact_sha256 = lifecycle_releases.build_artifact_sha256
            AND p.execution_state = 'active' AND t.status = 'active' AND t.connection_mode = 'manual' AND t.profile_sha256 = b.target_profile_sha256
            AND COALESCE(json_extract(t.profile_json, '$.enabled'), 1) != 0 AND c.status = 'approved' AND c.project_id = b.project_id AND c.article_id = b.article_id
            AND c.contract_sha256 = b.contract_sha256 AND c.target_profile_id = b.target_profile_id AND c.target_profile_sha256 = b.target_profile_sha256
            AND c.source_revision_id = b.revision_id AND c.source_body_sha256 = b.source_body_sha256 AND ${currentBuildInputSql("b")})`)
      .bind(readinessEvidenceSha256, readyAt, expiresAt, readyAt, releaseId, expectedLockVersion),
    eventFromRow(db, { articleId: String(row.article_id), eventType: "release.readiness_marked", subjectType: "release", subjectId: releaseId,
      payload: { from: String(row.readiness_state ?? "draft"), to: "ready_to_submit", readinessEvidenceSha256, readyAt, expiresAt, claim: "ready_to_submit_only_not_external_submission" },
    }, inputSha256, "lifecycle_releases", "id = ? AND readiness_state = 'ready_to_submit' AND lock_version = ? AND updated_at = ?", [releaseId, expectedLockVersion + 1, readyAt], readyAt),
  ]);
  assertMutation(results, 0, 1, "Release 已变更，或 Build/画像/合同/输入绑定/双门禁不再 current；未标记 ready_to_submit");
  const updated = await rowById(db, "lifecycle_releases", releaseId);
  return Response.json({ ok: true, release: updated ? parseRelease(updated) : null });
}

async function startReleaseSubmission(db: D1Database, payload: Record<string, unknown>) {
  const releaseId = requiredText(payload.releaseId, "Release ID", 120);
  const expectedLockVersion = requiredPositiveInteger(payload.expectedLockVersion, "expectedLockVersion");
  const note = requiredText(payload.note, "开始提交说明", 2000);
  const row = await rowById(db, "lifecycle_releases", releaseId);
  if (!row) throw new LifecycleApiError("Release 不存在", 404);
  const currentState = String(row.submission_state);
  if (!releaseSubmissionSet.has(currentState) || !["not_submitted", "submission_failed"].includes(currentState)) {
    throw new LifecycleApiError("只有未提交或提交失败的 Release 可以重新开始人工提交", 409);
  }
  const target = await rowById(db, "lifecycle_platform_targets", String(row.target_profile_id));
  const maimaiTarget = isMaimaiTargetRow(target);
  const videoTarget = isVideoTargetRow(target);
  const build = await rowById(db, "lifecycle_builds", String(row.build_id));
  if (!build) throw new LifecycleApiError("Release 绑定的 Build 不存在", 409);
  const inputBinding = await requireCurrentBuildInputBinding(db, String(row.build_id));
  const maimaiGates = await requireCurrentMaimaiStructuredGates(db, build, target);
  const videoGates = await requireCurrentVideoStructuredGates(db, build, target);
  const actionConfirmation = maimaiTarget ? requireMaimaiActionConfirmation(row, build, maimaiGates!, payload.actionConfirmation)
    : videoTarget ? requireVideoActionConfirmation(row, build, videoGates!, payload.actionConfirmation) : null;
  if (maimaiTarget || videoTarget) {
    const profile = parseJson<Record<string, unknown>>(target?.profile_json, {});
    if (profile.connectionStatus !== "login_confirmed" || !cleanText(profile.loginEvidence, 4000)) {
      throw new LifecycleApiError(`${maimaiTarget ? "脉脉" : "视频平台"}最终提交前必须有当前画像的可见登录证据`, 409);
    }
  }
  const now = isoNow();
  const nextLock = expectedLockVersion + 1;
  const inputSha256 = await digest({
    action: "start_release_submission",
    releaseId,
    expectedLockVersion,
    note,
    deliveryMode: "manual",
    previousSubmissionState: currentState,
    inputBindingSha256: inputBinding.inputBindingSha256,
    actionConfirmation,
  });
  const results = await db.batch([
    db.prepare(`UPDATE lifecycle_releases SET submission_state = 'submitting',
      lock_version = lock_version + 1, updated_at = ?
      WHERE id = ? AND approval_state = 'approved' AND readiness_state = 'ready_to_submit'
        AND length(readiness_evidence_sha256) = 64 AND expires_at IS NOT NULL AND expires_at > ? AND submission_state = ?
        AND lifecycle_state = 'active' AND lock_version = ?
        AND (SELECT result FROM lifecycle_build_gate_runs
          WHERE build_id = lifecycle_releases.build_id AND gate_kind = 'compatibility'
            AND artifact_sha256 = lifecycle_releases.build_artifact_sha256
            AND target_profile_sha256 = lifecycle_releases.target_profile_sha256
            AND contract_sha256 = (SELECT contract_sha256 FROM lifecycle_builds WHERE id = lifecycle_releases.build_id)
          ORDER BY rowid DESC LIMIT 1) = 'pass'
        AND (SELECT result FROM lifecycle_build_gate_runs
          WHERE build_id = lifecycle_releases.build_id AND gate_kind = 'fidelity'
            AND artifact_sha256 = lifecycle_releases.build_artifact_sha256
            AND target_profile_sha256 = lifecycle_releases.target_profile_sha256
            AND contract_sha256 = (SELECT contract_sha256 FROM lifecycle_builds WHERE id = lifecycle_releases.build_id)
          ORDER BY rowid DESC LIMIT 1) = 'pass'
        AND EXISTS (SELECT 1 FROM lifecycle_builds b
          JOIN lifecycle_article_projects p ON p.id = b.project_id AND p.article_id = b.article_id
          JOIN lifecycle_platform_targets t ON t.id = b.target_profile_id
          JOIN lifecycle_adaptation_contracts c ON c.id = b.adaptation_contract_id
          WHERE b.id = lifecycle_releases.build_id AND b.state = 'built'
            AND b.artifact_sha256 = lifecycle_releases.build_artifact_sha256
            AND p.execution_state = 'active'
            AND t.status = 'active' AND t.connection_mode = 'manual' AND t.profile_sha256 = b.target_profile_sha256
            AND COALESCE(json_extract(t.profile_json, '$.enabled'), 1) != 0
            AND c.status = 'approved' AND c.project_id = b.project_id AND c.article_id = b.article_id
            AND c.contract_sha256 = b.contract_sha256 AND c.target_profile_id = b.target_profile_id
            AND c.target_profile_sha256 = b.target_profile_sha256
            AND c.source_revision_id = b.revision_id AND c.source_body_sha256 = b.source_body_sha256
            AND ${currentBuildInputSql("b")})`)
      .bind(now, releaseId, now, currentState, expectedLockVersion),
    eventFromRow(db, {
      articleId: String(row.article_id), eventType: "release.manual_submission_started", subjectType: "release", subjectId: releaseId,
      payload: { from: currentState, to: "submitting", note, deliveryMode: "manual", externalRequestSentByThisApi: false, actionConfirmation },
    }, inputSha256, "lifecycle_releases", "id = ? AND submission_state = 'submitting' AND lock_version = ? AND updated_at = ?", [releaseId, nextLock, now], now),
  ]);
  assertMutation(results, 0, 1, "Release 状态、锁版本、Build 输入、项目/画像/合同或最新门禁已经变化");
  const updated = await rowById(db, "lifecycle_releases", releaseId);
  return Response.json({ ok: true, release: updated ? parseRelease(updated) : null });
}

async function recordReleaseSubmission(db: D1Database, payload: Record<string, unknown>) {
  const releaseId = requiredText(payload.releaseId, "Release ID", 120);
  const targetState = requiredText(payload.targetState, "提交结果", 40);
  if (!releaseSubmissionSet.has(targetState) || !["submission_accepted", "submission_failed"].includes(targetState)) {
    throw new LifecycleApiError("提交结果只能是 submission_accepted 或 submission_failed");
  }
  const expectedLockVersion = requiredPositiveInteger(payload.expectedLockVersion, "expectedLockVersion");
  const evidence = stringArray(payload.evidence, "提交证据", true, 50);
  const remoteRecordId = targetState === "submission_accepted"
    ? requiredText(payload.remoteRecordId, "平台回执或远端记录 ID", 500)
    : cleanText(payload.remoteRecordId, 500);
  const row = await rowById(db, "lifecycle_releases", releaseId);
  if (!row) throw new LifecycleApiError("Release 不存在", 404);
  const target = await rowById(db, "lifecycle_platform_targets", String(row.target_profile_id));
  const details = payload.details ? jsonObject(payload.details, "提交详情") : {};
  if (isMaimaiTargetRow(target)) {
    requireMaimaiSubmissionDetails(targetState, details);
    if (targetState === "submission_accepted") requiredMaimaiRemoteRecordId(remoteRecordId);
  }
  const videoPlatform = videoTargetPlatform(target);
  if (videoPlatform) {
    requireVideoSubmissionDetails(targetState, details);
    if (targetState === "submission_accepted") requiredVideoRemoteRecordId(videoPlatform, remoteRecordId);
  }
  const now = isoNow();
  const nextLock = expectedLockVersion + 1;
  const inputSha256 = await digest({ action: "record_release_submission", releaseId, targetState, remoteRecordId, evidence, details, expectedLockVersion });
  const results = await db.batch([
    db.prepare(`UPDATE lifecycle_releases SET submission_state = ?, remote_record_id = ?,
      submission_evidence_json = ?, lock_version = lock_version + 1, updated_at = ?
      WHERE id = ? AND approval_state = 'approved' AND submission_state = 'submitting'
        AND lifecycle_state = 'active' AND lock_version = ?`)
      .bind(targetState, remoteRecordId, canonicalJson(evidence), now, releaseId, expectedLockVersion),
    eventFromRow(db, {
      articleId: String(row.article_id), eventType: "release.submission_recorded", subjectType: "release", subjectId: releaseId,
      payload: {
        from: "submitting",
        to: targetState,
        remoteRecordId,
        evidenceCount: evidence.length,
        backendVerified: false,
        publiclyVerified: false,
        details,
      },
    }, inputSha256, "lifecycle_releases", "id = ? AND submission_state = ? AND lock_version = ? AND updated_at = ?", [releaseId, targetState, nextLock, now], now),
  ]);
  assertMutation(results, 0, 1, "Release 提交状态或锁版本已经变化");
  const updated = await rowById(db, "lifecycle_releases", releaseId);
  return Response.json({ ok: true, release: updated ? parseRelease(updated) : null });
}

async function recordReleaseDestination(db: D1Database, payload: Record<string, unknown>) {
  const releaseId = requiredText(payload.releaseId, "Release ID", 120);
  const targetState = requiredText(payload.targetState, "后台核验结果", 40);
  if (!releaseDestinationSet.has(targetState) || targetState === "not_checked") {
    throw new LifecycleApiError("后台核验结果只能是 backend_verified、not_found 或 inconclusive");
  }
  const expectedLockVersion = requiredPositiveInteger(payload.expectedLockVersion, "expectedLockVersion");
  const evidence = stringArray(payload.evidence, "后台核验证据", true, 50);
  const destinationUrl = targetState === "backend_verified"
    ? requiredHttpUrl(payload.destinationUrl, "后台记录地址")
    : cleanText(payload.destinationUrl, 2000);
  const row = await rowById(db, "lifecycle_releases", releaseId);
  if (!row) throw new LifecycleApiError("Release 不存在", 404);
  const target = await rowById(db, "lifecycle_platform_targets", String(row.target_profile_id));
  const maimaiTarget = isMaimaiTargetRow(target);
  const videoPlatform = videoTargetPlatform(target);
  const details = payload.details ? jsonObject(payload.details, "后台核验详情") : {};
  const frozenRemoteRecordId = String(row.remote_record_id ?? "");
  if (maimaiTarget) {
    requireMaimaiDestinationDetails(targetState, frozenRemoteRecordId, details);
    if (targetState === "backend_verified") requiredMaimaiRecordUrl(destinationUrl, "脉脉后台记录地址", frozenRemoteRecordId);
  }
  if (videoPlatform) {
    requireVideoDestinationDetails(targetState, frozenRemoteRecordId, details);
    if (targetState === "backend_verified" && !videoDestinationUrlMatches(videoPlatform, destinationUrl)) {
      throw new LifecycleApiError("视频后台记录地址与当前平台不匹配");
    }
  }
  const currentState = String(row.destination_state);
  const now = isoNow();
  const nextLock = expectedLockVersion + 1;
  const inputSha256 = await digest({ action: "record_release_destination", releaseId, targetState, destinationUrl, evidence, details, expectedLockVersion });
  const results = await db.batch([
    db.prepare(`UPDATE lifecycle_releases SET destination_state = ?, destination_url = ?,
      destination_evidence_json = ?, lock_version = lock_version + 1, updated_at = ?
      WHERE id = ? AND submission_state = 'submission_accepted' AND lifecycle_state = 'active' AND lock_version = ?`)
      .bind(targetState, destinationUrl, canonicalJson(evidence), now, releaseId, expectedLockVersion),
    eventFromRow(db, {
      articleId: String(row.article_id), eventType: "release.destination_verified", subjectType: "release", subjectId: releaseId,
      payload: { from: currentState, to: targetState, destinationUrl, evidenceCount: evidence.length, publicStateUnchanged: String(row.public_state), details },
    }, inputSha256, "lifecycle_releases", "id = ? AND destination_state = ? AND lock_version = ? AND updated_at = ?", [releaseId, targetState, nextLock, now], now),
  ]);
  assertMutation(results, 0, 1, "Release 尚未被平台接受，或核验状态/锁版本已经变化");
  const updated = await rowById(db, "lifecycle_releases", releaseId);
  return Response.json({ ok: true, release: updated ? parseRelease(updated) : null });
}

async function recordReleasePublic(db: D1Database, payload: Record<string, unknown>) {
  const releaseId = requiredText(payload.releaseId, "Release ID", 120);
  const targetState = requiredText(payload.targetState, "公开核验结果", 40);
  if (!releasePublicSet.has(targetState) || targetState === "not_checked") {
    throw new LifecycleApiError("公开核验结果只能是 public_verified、not_public 或 inconclusive");
  }
  const expectedLockVersion = requiredPositiveInteger(payload.expectedLockVersion, "expectedLockVersion");
  const evidence = stringArray(payload.evidence, "公开核验证据", true, 50);
  const publicUrl = targetState === "public_verified"
    ? requiredHttpUrl(payload.publicUrl, "公开页面地址")
    : cleanText(payload.publicUrl, 2000);
  const row = await rowById(db, "lifecycle_releases", releaseId);
  if (!row) throw new LifecycleApiError("Release 不存在", 404);
  const target = await rowById(db, "lifecycle_platform_targets", String(row.target_profile_id));
  const maimaiTarget = isMaimaiTargetRow(target);
  const videoPlatform = videoTargetPlatform(target);
  const details = payload.details ? jsonObject(payload.details, "公开核验详情") : {};
  const frozenRemoteRecordId = String(row.remote_record_id ?? "");
  if (maimaiTarget) {
    requireMaimaiPublicDetails(targetState, frozenRemoteRecordId, details);
    if (["public_verified", "not_public"].includes(targetState) && row.destination_state !== "backend_verified") {
      throw new LifecycleApiError("脉脉公开核验前必须先核验同一后台记录", 409);
    }
    if (targetState === "public_verified") requiredMaimaiRecordUrl(publicUrl, "脉脉公开页面地址", frozenRemoteRecordId);
  }
  if (videoPlatform) {
    requireVideoPublicDetails(targetState, frozenRemoteRecordId, details);
    if (["public_verified", "not_public"].includes(targetState) && row.destination_state !== "backend_verified") {
      throw new LifecycleApiError("公开视频核验前必须先核验同一后台记录", 409);
    }
    if (targetState === "public_verified" && !videoPublicUrlMatches(videoPlatform, publicUrl, frozenRemoteRecordId)) {
      throw new LifecycleApiError("公开视频 URL 与平台及远端记录 ID 不一致");
    }
  }
  const currentState = String(row.public_state);
  const now = isoNow();
  const nextLock = expectedLockVersion + 1;
  const inputSha256 = await digest({ action: "record_release_public", releaseId, targetState, publicUrl, evidence, details, expectedLockVersion });
  const results = await db.batch([
    db.prepare(`UPDATE lifecycle_releases SET public_state = ?, public_url = ?,
      public_evidence_json = ?, lock_version = lock_version + 1, updated_at = ?
      WHERE id = ? AND submission_state = 'submission_accepted' AND lifecycle_state = 'active' AND lock_version = ?`)
      .bind(targetState, publicUrl, canonicalJson(evidence), now, releaseId, expectedLockVersion),
    eventFromRow(db, {
      articleId: String(row.article_id), eventType: "release.public_visibility_verified", subjectType: "release", subjectId: releaseId,
      payload: { from: currentState, to: targetState, publicUrl, evidenceCount: evidence.length, destinationStateUnchanged: String(row.destination_state), details },
    }, inputSha256, "lifecycle_releases", "id = ? AND public_state = ? AND lock_version = ? AND updated_at = ?", [releaseId, targetState, nextLock, now], now),
  ]);
  assertMutation(results, 0, 1, "Release 尚未被平台接受，或公开状态/锁版本已经变化");
  const updated = await rowById(db, "lifecycle_releases", releaseId);
  return Response.json({ ok: true, release: updated ? parseRelease(updated) : null });
}

async function transitionReleaseLifecycle(db: D1Database, payload: Record<string, unknown>) {
  const releaseId = requiredText(payload.releaseId, "Release ID", 120);
  const targetState = requiredText(payload.targetState, "Release 生命周期状态", 40);
  if (!releaseLifecycleSet.has(targetState) || !["withdrawn", "superseded"].includes(targetState)) {
    throw new LifecycleApiError("活动 Release 只能转为 withdrawn 或 superseded");
  }
  const expectedLockVersion = requiredPositiveInteger(payload.expectedLockVersion, "expectedLockVersion");
  const note = requiredText(payload.note, "生命周期变更说明", 2000);
  const row = await rowById(db, "lifecycle_releases", releaseId);
  if (!row) throw new LifecycleApiError("Release 不存在", 404);
  const now = isoNow();
  const nextLock = expectedLockVersion + 1;
  const inputSha256 = await digest({ action: "transition_release_lifecycle", releaseId, targetState, expectedLockVersion, note });
  const results = await db.batch([
    db.prepare(`UPDATE lifecycle_releases SET lifecycle_state = ?, lock_version = lock_version + 1, updated_at = ?
      WHERE id = ? AND lifecycle_state = 'active' AND lock_version = ?`)
      .bind(targetState, now, releaseId, expectedLockVersion),
    eventFromRow(db, {
      articleId: String(row.article_id), eventType: "release.lifecycle_changed", subjectType: "release", subjectId: releaseId,
      payload: { from: "active", to: targetState, note },
    }, inputSha256, "lifecycle_releases", "id = ? AND lifecycle_state = ? AND lock_version = ? AND updated_at = ?", [releaseId, targetState, nextLock, now], now),
  ]);
  assertMutation(results, 0, 1, "Release 生命周期状态或锁版本已经变化");
  const updated = await rowById(db, "lifecycle_releases", releaseId);
  return Response.json({ ok: true, release: updated ? parseRelease(updated) : null });
}

type TypedMetricMeasurement = {
  definition: D1Row;
  definitionId: string;
  definitionKey: string;
  definitionSha256: string;
  observationState: MetricValueRecord["observationState"];
  value: number | null;
  valueSha256: string;
};

function metricDefinitionCore(row: D1Row) {
  return {
    definitionKey: String(row.definition_key),
    version: String(row.version),
    label: String(row.label),
    description: String(row.description ?? ""),
    valueKind: String(row.value_kind),
    unit: String(row.unit),
    missingPolicy: String(row.missing_policy),
    constraints: parseJson<Record<string, unknown>>(row.constraints_json, {}),
    scope: parseJson<Record<string, unknown>>(row.scope_json, {}),
  };
}

function assertMetricValue(
  definition: D1Row,
  observationState: string,
  value: unknown,
): number | null {
  if (!metricValueKindSet.has(String(definition.value_kind))) {
    throw new LifecycleApiError(`指标定义 ${String(definition.definition_key)} 的数值类型不受支持`, 409);
  }
  if (!metricMissingPolicySet.has(String(definition.missing_policy))) {
    throw new LifecycleApiError(`指标定义 ${String(definition.definition_key)} 的缺失策略不受支持`, 409);
  }
  if (!metricObservationSet.has(observationState)) throw new LifecycleApiError("指标 observationState 非法");
  if (observationState !== "observed") {
    if (value !== null && value !== undefined) throw new LifecycleApiError("缺失或不适用的指标值必须为 null");
    if (definition.missing_policy === "reject") {
      throw new LifecycleApiError(`指标 ${String(definition.definition_key)} 不允许缺失`, 409);
    }
    if (observationState === "not_applicable" && definition.missing_policy !== "not_applicable") {
      throw new LifecycleApiError(`指标 ${String(definition.definition_key)} 未声明 not_applicable 策略`, 409);
    }
    return null;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) throw new LifecycleApiError("已观察指标必须是有限数值");
  if (definition.value_kind === "integer" && !Number.isSafeInteger(value)) {
    throw new LifecycleApiError(`指标 ${String(definition.definition_key)} 必须是安全整数`);
  }
  const constraints = parseJson<Record<string, unknown>>(definition.constraints_json, {});
  const minimum = typeof constraints.minimum === "number" ? constraints.minimum : null;
  const maximum = typeof constraints.maximum === "number" ? constraints.maximum : null;
  if (minimum !== null && value < minimum) throw new LifecycleApiError(`指标 ${String(definition.definition_key)} 不能小于 ${minimum}`);
  if (maximum !== null && value > maximum) throw new LifecycleApiError(`指标 ${String(definition.definition_key)} 不能大于 ${maximum}`);
  return value;
}

async function parseTypedMetricMeasurements(db: D1Database, value: unknown) {
  if (!Array.isArray(value) || value.length === 0) throw new LifecycleApiError("measurements 必须是非空数组");
  if (value.length > 100) throw new LifecycleApiError("measurements 不能超过 100 项");
  const active = await db.prepare("SELECT * FROM lifecycle_metric_definitions WHERE status = 'active' ORDER BY definition_key").all<D1Row>();
  const definitions = active.results as D1Row[];
  if (definitions.length === 0) throw new LifecycleApiError("当前没有可用的 MetricDefinition", 503);
  const definitionById = new Map(definitions.map((row) => [String(row.id), row]));
  const seen = new Set<string>();
  const measurements: TypedMetricMeasurement[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new LifecycleApiError("measurement 必须是 JSON 对象");
    const input = item as Record<string, unknown>;
    const definitionId = requiredText(input.definitionId, "definitionId", 160);
    if (seen.has(definitionId)) throw new LifecycleApiError(`指标定义重复：${definitionId}`);
    seen.add(definitionId);
    const definition = definitionById.get(definitionId);
    if (!definition) throw new LifecycleApiError(`指标定义不存在、已停用或不属于当前定义集：${definitionId}`, 409);
    const definitionSha256 = requiredSha(input.definitionSha256, "definitionSha256");
    const computedDefinitionSha256 = await digest(metricDefinitionCore(definition));
    if (computedDefinitionSha256 !== String(definition.definition_sha256)) {
      throw new LifecycleApiError(`指标定义 ${String(definition.definition_key)} 的内容与冻结摘要不一致`, 409);
    }
    if (definitionSha256 !== computedDefinitionSha256) {
      throw new LifecycleApiError(`指标定义 ${String(definition.definition_key)} 已换版，请重新载入`, 409);
    }
    const scope = parseJson<Record<string, unknown>>(definition.scope_json, {});
    if (scope.crossPlatformComparable !== false || scope.normalizationApplied !== false) {
      throw new LifecycleApiError(`指标定义 ${String(definition.definition_key)} 不是未经归一化的原始平台口径`, 409);
    }
    const observationState = requiredText(input.observationState, "observationState", 40);
    const metricValue = assertMetricValue(definition, observationState, input.value);
    const valueSha256 = await digest({ definitionId, definitionSha256, observationState, value: metricValue });
    measurements.push({
      definition,
      definitionId,
      definitionKey: String(definition.definition_key),
      definitionSha256,
      observationState: observationState as MetricValueRecord["observationState"],
      value: metricValue,
      valueSha256,
    });
  }
  const missingDefinitions = definitions.filter((row) => !seen.has(String(row.id)));
  if (missingDefinitions.length > 0 || seen.size !== definitions.length) {
    throw new LifecycleApiError(`必须显式提交完整指标定义集；缺少 ${missingDefinitions.map((row) => String(row.definition_key)).join("、") || "未知定义"}`, 409);
  }
  if (!measurements.some((measurement) => measurement.observationState === "observed")) {
    throw new LifecycleApiError("每个指标快照至少需要一个 observed 数值");
  }
  return measurements.sort((left, right) => left.definitionKey.localeCompare(right.definitionKey));
}

async function recordMetricSnapshot(db: D1Database, payload: Record<string, unknown>) {
  const releaseId = requiredText(payload.releaseId, "Release ID", 120);
  const sourceMode = requiredText(payload.sourceMode, "指标来源模式", 40);
  if (!new Set(["manual", "export"]).has(sourceMode)) throw new LifecycleApiError("指标来源只能是 manual 或 export");
  const sourceLabel = requiredText(payload.sourceLabel, "指标来源说明", 500);
  const windowStart = requiredIso(payload.windowStart, "统计窗口开始时间");
  const windowEnd = requiredIso(payload.windowEnd, "统计窗口结束时间");
  const capturedAt = requiredIso(payload.capturedAt, "采集时间");
  if (Date.parse(windowStart) >= Date.parse(windowEnd)) throw new LifecycleApiError("统计窗口结束时间必须晚于开始时间");
  if (Date.parse(capturedAt) < Date.parse(windowEnd)) throw new LifecycleApiError("采集时间不能早于统计窗口结束时间");
  const measurements = await parseTypedMetricMeasurements(db, payload.measurements);
  const evidenceRef = requiredText(payload.evidenceRef, "指标证据引用", 2000);
  const release = await rowById(db, "lifecycle_releases", releaseId);
  if (!release) throw new LifecycleApiError("Release 不存在", 404);
  if (release.submission_state !== "submission_accepted") {
    throw new LifecycleApiError("只有已经记录平台接受回执的 Release 可以采集平台指标", 409);
  }
  const definitionSetSha256 = await digest(measurements.map((measurement) => ({
    definitionId: measurement.definitionId,
    definitionSha256: measurement.definitionSha256,
  })));
  const typedValues = measurements.map((measurement) => ({
    definitionId: measurement.definitionId,
    definitionKey: measurement.definitionKey,
    definitionSha256: measurement.definitionSha256,
    observationState: measurement.observationState,
    value: measurement.value,
    valueSha256: measurement.valueSha256,
  }));
  const metrics = Object.fromEntries(measurements.map((measurement) => [measurement.definitionKey, measurement.value]));
  const measurementCore = {
    releaseId,
    buildId: String(release.build_id),
    buildArtifactSha256: String(release.build_artifact_sha256),
    sourceMode,
    sourceLabel,
    windowStart,
    windowEnd,
    capturedAt,
    definitionSetSha256,
    measurements: typedValues,
    evidenceRef,
  };
  const measurementSha256 = await digest(measurementCore);
  const id = `metric-snapshot-${crypto.randomUUID()}`;
  const now = isoNow();
  const inputSha256 = await digest({ action: "record_metric_snapshot", measurementSha256 });
  const valueStatements = measurements.map((measurement) => db.prepare(`INSERT INTO lifecycle_metric_values
      (id, snapshot_id, release_id, project_id, article_id, definition_id, definition_sha256,
       observation_state, value_json, value_sha256, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(
      `metric-value-${crypto.randomUUID()}`,
      id,
      releaseId,
      String(release.project_id),
      String(release.article_id),
      measurement.definitionId,
      measurement.definitionSha256,
      measurement.observationState,
      canonicalJson(measurement.value),
      measurement.valueSha256,
      now,
    ));
  const results = await db.batch([
    db.prepare(`INSERT INTO lifecycle_metric_snapshots
      (id, release_id, project_id, article_id, source_mode, source_label, window_start,
       window_end, captured_at, metrics_json, evidence_ref, measurement_sha256, definition_set_sha256,
       validation_state, validation_note, created_at)
      SELECT ?, id, project_id, article_id, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'collected', '', ?
      FROM lifecycle_releases
      WHERE id = ? AND submission_state = 'submission_accepted'`)
      .bind(
        id,
        sourceMode,
        sourceLabel,
        windowStart,
        windowEnd,
        capturedAt,
        canonicalJson(metrics),
        evidenceRef,
        measurementSha256,
        definitionSetSha256,
        now,
        releaseId,
      ),
    ...valueStatements,
    eventFromRow(db, {
      articleId: String(release.article_id), eventType: "metric_snapshot.collected", subjectType: "metric_snapshot", subjectId: id,
      payload: {
        releaseId,
        measurementSha256,
        definitionSetSha256,
        sourceMode,
        validationState: "collected",
        crossPlatformComparable: false,
        normalizationApplied: false,
        claim: "immutable_typed_raw_measurement_recorded",
      },
    }, inputSha256, "lifecycle_metric_snapshots", "id = ? AND measurement_sha256 = ?", [id, measurementSha256], now),
  ]);
  assertMutation(results, 0, results.length - 1, "Release 状态已经变化，指标快照未记录");
  for (let index = 1; index <= measurements.length; index += 1) {
    if (Number(results[index]?.meta.changes ?? 0) !== 1) throw new LifecycleApiError("指标值没有与快照原子绑定；停止继续推进", 503);
  }
  const snapshot = await rowById(db, "lifecycle_metric_snapshots", id);
  const values = await db.prepare("SELECT * FROM lifecycle_metric_values WHERE snapshot_id = ? ORDER BY definition_id").bind(id).all<D1Row>();
  return Response.json({
    ok: true,
    metricSnapshot: snapshot ? parseMetric(snapshot) : null,
    metricValues: (values.results as D1Row[]).map(parseMetricValue),
  }, { status: 201 });
}

async function validateMetricSnapshot(db: D1Database, payload: Record<string, unknown>) {
  const metricSnapshotId = requiredText(payload.metricSnapshotId, "指标快照 ID", 120);
  const expectedState = requiredText(payload.expectedState, "预期验证状态", 40);
  if (!metricValidationSet.has(expectedState) || !["collected", "inconclusive"].includes(expectedState)) {
    throw new LifecycleApiError("预期验证状态只能是 collected 或 inconclusive");
  }
  const targetState = requiredText(payload.targetState, "目标验证状态", 40);
  if (!metricValidationSet.has(targetState) || !["validated", "inconclusive"].includes(targetState)) {
    throw new LifecycleApiError("目标验证状态只能是 validated 或 inconclusive");
  }
  const note = requiredText(payload.note, "指标验证说明", 4000);
  const row = await rowById(db, "lifecycle_metric_snapshots", metricSnapshotId);
  if (!row) throw new LifecycleApiError("指标快照不存在", 404);
  const definitionSetSha256 = row.definition_set_sha256 ? String(row.definition_set_sha256) : "";
  if (!SHA256_RE.test(definitionSetSha256)) {
    throw new LifecycleApiError("旧版未类型化指标快照不能被确认；请按版本化 MetricDefinition 重新采集", 409);
  }
  const valuesResult = await db.prepare("SELECT * FROM lifecycle_metric_values WHERE snapshot_id = ? ORDER BY definition_id")
    .bind(metricSnapshotId).all<D1Row>();
  const valueRows = valuesResult.results as D1Row[];
  if (valueRows.length === 0) throw new LifecycleApiError("指标快照缺少版本化 MetricValue", 409);
  const release = await rowById(db, "lifecycle_releases", String(row.release_id));
  if (!release) throw new LifecycleApiError("指标快照关联的 Release 不存在", 409);
  const seenDefinitions = new Set<string>();
  const typedValues: Array<{
    definitionId: string;
    definitionKey: string;
    definitionSha256: string;
    observationState: string;
    value: number | null;
    valueSha256: string;
  }> = [];
  for (const valueRow of valueRows) {
    const definitionId = String(valueRow.definition_id);
    if (seenDefinitions.has(definitionId)) throw new LifecycleApiError("指标快照包含重复 MetricDefinition", 409);
    seenDefinitions.add(definitionId);
    const definition = await rowById(db, "lifecycle_metric_definitions", definitionId);
    if (!definition) throw new LifecycleApiError(`指标定义不存在：${definitionId}`, 409);
    const computedDefinitionSha256 = await digest(metricDefinitionCore(definition));
    if (computedDefinitionSha256 !== String(definition.definition_sha256)
      || computedDefinitionSha256 !== String(valueRow.definition_sha256)) {
      throw new LifecycleApiError(`指标定义 ${String(definition.definition_key)} 与快照冻结摘要不一致`, 409);
    }
    const observationState = String(valueRow.observation_state);
    const parsedValue = parseJson<unknown>(valueRow.value_json, Symbol.for("invalid-metric-json"));
    if (typeof parsedValue === "symbol") throw new LifecycleApiError("MetricValue 的 value_json 已损坏", 409);
    const validatedValue = assertMetricValue(definition, observationState, parsedValue);
    const computedValueSha256 = await digest({
      definitionId,
      definitionSha256: computedDefinitionSha256,
      observationState,
      value: validatedValue,
    });
    if (computedValueSha256 !== String(valueRow.value_sha256)) throw new LifecycleApiError("MetricValue 内容与冻结摘要不一致", 409);
    typedValues.push({
      definitionId,
      definitionKey: String(definition.definition_key),
      definitionSha256: computedDefinitionSha256,
      observationState,
      value: validatedValue,
      valueSha256: computedValueSha256,
    });
  }
  typedValues.sort((left, right) => left.definitionKey.localeCompare(right.definitionKey));
  if (!typedValues.some((measurement) => measurement.observationState === "observed")) {
    throw new LifecycleApiError("指标快照没有任何 observed 数值", 409);
  }
  const computedDefinitionSetSha256 = await digest(typedValues.map((measurement) => ({
    definitionId: measurement.definitionId,
    definitionSha256: measurement.definitionSha256,
  })));
  if (computedDefinitionSetSha256 !== definitionSetSha256) throw new LifecycleApiError("MetricDefinition 集合与快照冻结摘要不一致", 409);
  const computedMeasurementSha256 = await digest({
    releaseId: String(row.release_id),
    buildId: String(release.build_id),
    buildArtifactSha256: String(release.build_artifact_sha256),
    sourceMode: String(row.source_mode),
    sourceLabel: String(row.source_label),
    windowStart: String(row.window_start),
    windowEnd: String(row.window_end),
    capturedAt: String(row.captured_at),
    definitionSetSha256,
    measurements: typedValues,
    evidenceRef: String(row.evidence_ref),
  });
  if (computedMeasurementSha256 !== String(row.measurement_sha256)) {
    throw new LifecycleApiError("指标快照内容与 measurement SHA-256 不一致", 409);
  }
  const now = isoNow();
  const inputSha256 = await digest({
    action: "validate_metric_snapshot",
    metricSnapshotId,
    expectedState,
    targetState,
    note,
    measurementSha256: computedMeasurementSha256,
    definitionSetSha256,
  });
  const results = await db.batch([
    db.prepare(`UPDATE lifecycle_metric_snapshots SET validation_state = ?, validation_note = ?
      WHERE id = ? AND validation_state = ? AND measurement_sha256 = ? AND definition_set_sha256 = ?`)
      .bind(targetState, note, metricSnapshotId, expectedState, computedMeasurementSha256, definitionSetSha256),
    eventFromRow(db, {
      articleId: String(row.article_id), eventType: "metric_snapshot.validated", subjectType: "metric_snapshot", subjectId: metricSnapshotId,
      payload: {
        from: expectedState,
        to: targetState,
        note,
        measurementSha256: computedMeasurementSha256,
        definitionSetSha256,
        crossPlatformComparable: false,
        normalizationApplied: false,
      },
    }, inputSha256, "lifecycle_metric_snapshots", "id = ? AND validation_state = ? AND measurement_sha256 = ? AND definition_set_sha256 = ?", [metricSnapshotId, targetState, computedMeasurementSha256, definitionSetSha256], now),
  ]);
  assertMutation(results, 0, 1, "指标快照验证状态已经变化");
  const updated = await rowById(db, "lifecycle_metric_snapshots", metricSnapshotId);
  return Response.json({ ok: true, metricSnapshot: updated ? parseMetric(updated) : null });
}

async function createRetrospective(db: D1Database, payload: Record<string, unknown>) {
  const projectId = requiredText(payload.projectId, "项目 ID", 120);
  const releaseId = cleanText(payload.releaseId, 120) || null;
  const title = requiredText(payload.title, "复盘标题", 240);
  const summary = cleanText(payload.summary, 12_000, true);
  const evidenceRefs = stringArray(payload.evidenceRefs, "复盘证据引用", false, 100);
  const project = await rowById(db, "lifecycle_article_projects", projectId);
  if (!project) throw new LifecycleApiError("ArticleProject 不存在", 404);
  if (!["operate", "retrospective"].includes(String(project.phase))) {
    throw new LifecycleApiError("项目进入 operate 阶段后才能建立复盘", 409);
  }
  if (releaseId) {
    const release = await rowById(db, "lifecycle_releases", releaseId);
    if (!release || release.project_id !== projectId || release.article_id !== project.article_id) {
      throw new LifecycleApiError("关联 Release 不存在或不属于该项目", 409);
    }
  }
  const id = `retrospective-${crypto.randomUUID()}`;
  const now = isoNow();
  const inputSha256 = await digest({ action: "create_retrospective", projectId, releaseId, title, summary, evidenceRefs });
  const results = await db.batch([
    db.prepare(`INSERT INTO lifecycle_retrospectives
      (id, project_id, article_id, release_id, title, summary, evidence_refs_json, status, lock_version, created_at, updated_at)
      SELECT ?, id, article_id, ?, ?, ?, ?, 'draft', 1, ?, ? FROM lifecycle_article_projects
      WHERE id = ? AND phase IN ('operate','retrospective') AND execution_state <> 'cancelled'`)
      .bind(id, releaseId, title, summary, canonicalJson(evidenceRefs), now, now, projectId),
    eventFromRow(db, {
      articleId: String(project.article_id), eventType: "retrospective.created", subjectType: "retrospective", subjectId: id,
      payload: { projectId, releaseId, status: "draft", evidenceCount: evidenceRefs.length },
    }, inputSha256, "lifecycle_retrospectives", "id = ? AND status = 'draft'", [id], now),
  ]);
  assertMutation(results, 0, 1, "项目状态已经变化，复盘未创建");
  const retrospective = await rowById(db, "lifecycle_retrospectives", id);
  return Response.json({ ok: true, retrospective: retrospective ? parseRetrospective(retrospective) : null }, { status: 201 });
}

async function updateRetrospective(db: D1Database, payload: Record<string, unknown>) {
  const retrospectiveId = requiredText(payload.retrospectiveId, "复盘 ID", 120);
  const expectedLockVersion = requiredPositiveInteger(payload.expectedLockVersion, "expectedLockVersion");
  const row = await rowById(db, "lifecycle_retrospectives", retrospectiveId);
  if (!row) throw new LifecycleApiError("复盘不存在", 404);
  const title = cleanText(payload.title, 240) || String(row.title);
  const summary = typeof payload.summary === "string" ? cleanText(payload.summary, 12_000, true) : String(row.summary ?? "");
  const evidenceRefs = payload.evidenceRefs === undefined
    ? parseJson<string[]>(row.evidence_refs_json, [])
    : stringArray(payload.evidenceRefs, "复盘证据引用", false, 100);
  const now = isoNow();
  const nextLock = expectedLockVersion + 1;
  const inputSha256 = await digest({ action: "update_retrospective", retrospectiveId, expectedLockVersion, title, summary, evidenceRefs });
  const results = await db.batch([
    db.prepare(`UPDATE lifecycle_retrospectives SET title = ?, summary = ?, evidence_refs_json = ?,
      lock_version = lock_version + 1, updated_at = ? WHERE id = ? AND status = 'draft' AND lock_version = ?`)
      .bind(title, summary, canonicalJson(evidenceRefs), now, retrospectiveId, expectedLockVersion),
    eventFromRow(db, {
      articleId: String(row.article_id), eventType: "retrospective.updated", subjectType: "retrospective", subjectId: retrospectiveId,
      payload: { expectedLockVersion, nextLockVersion: nextLock, evidenceCount: evidenceRefs.length },
    }, inputSha256, "lifecycle_retrospectives", "id = ? AND status = 'draft' AND lock_version = ? AND updated_at = ?", [retrospectiveId, nextLock, now], now),
  ]);
  assertMutation(results, 0, 1, "复盘已不再是草稿，或锁版本已经变化");
  const updated = await rowById(db, "lifecycle_retrospectives", retrospectiveId);
  return Response.json({ ok: true, retrospective: updated ? parseRetrospective(updated) : null });
}

async function transitionRetrospective(db: D1Database, payload: Record<string, unknown>) {
  const retrospectiveId = requiredText(payload.retrospectiveId, "复盘 ID", 120);
  const targetState = requiredText(payload.targetState, "复盘目标状态", 40);
  if (!retrospectiveStateSet.has(targetState)) throw new LifecycleApiError("复盘状态非法");
  const expectedLockVersion = requiredPositiveInteger(payload.expectedLockVersion, "expectedLockVersion");
  const note = requiredText(payload.note, "复盘状态说明", 4000);
  const row = await rowById(db, "lifecycle_retrospectives", retrospectiveId);
  if (!row) throw new LifecycleApiError("复盘不存在", 404);
  const currentState = String(row.status);
  if (!RETROSPECTIVE_TRANSITIONS[currentState]?.has(targetState)) {
    throw new LifecycleApiError(`不允许从 ${currentState} 直接进入 ${targetState}`, 409);
  }
  const project = await rowById(db, "lifecycle_article_projects", String(row.project_id));
  if (!project || project.phase !== "retrospective" || project.execution_state === "cancelled") {
    throw new LifecycleApiError("项目必须处于 retrospective 阶段才能评审或关闭复盘", 409);
  }
  const evidenceRefs = parseJson<string[]>(row.evidence_refs_json, []);
  if (!cleanText(row.summary, 12_000, true) || evidenceRefs.length === 0) {
    throw new LifecycleApiError("复盘进入评审前必须有总结和至少一条证据引用", 409);
  }
  const now = isoNow();
  const nextLock = expectedLockVersion + 1;
  const inputSha256 = await digest({ action: "transition_retrospective", retrospectiveId, currentState, targetState, expectedLockVersion, note });
  const results = await db.batch([
    db.prepare(`UPDATE lifecycle_retrospectives SET status = ?, lock_version = lock_version + 1, updated_at = ?
      WHERE id = ? AND status = ? AND lock_version = ?
        AND EXISTS (SELECT 1 FROM lifecycle_article_projects p WHERE p.id = lifecycle_retrospectives.project_id
          AND p.phase = 'retrospective' AND p.execution_state <> 'cancelled')`)
      .bind(targetState, now, retrospectiveId, currentState, expectedLockVersion),
    eventFromRow(db, {
      articleId: String(row.article_id), eventType: "retrospective.state_changed", subjectType: "retrospective", subjectId: retrospectiveId,
      payload: { from: currentState, to: targetState, note, evidenceCount: evidenceRefs.length },
    }, inputSha256, "lifecycle_retrospectives", "id = ? AND status = ? AND lock_version = ? AND updated_at = ?", [retrospectiveId, targetState, nextLock, now], now),
  ]);
  assertMutation(results, 0, 1, "复盘或项目状态、锁版本已经变化");
  const updated = await rowById(db, "lifecycle_retrospectives", retrospectiveId);
  return Response.json({ ok: true, retrospective: updated ? parseRetrospective(updated) : null });
}

async function createRuleCandidate(db: D1Database, payload: Record<string, unknown>) {
  const retrospectiveId = requiredText(payload.retrospectiveId, "复盘 ID", 120);
  const title = requiredText(payload.title, "规则候选标题", 240);
  const ruleText = requiredText(payload.ruleText, "规则内容", 8000, true);
  const scope = cleanText(payload.scope, 4000, true);
  const counterexamples = cleanText(payload.counterexamples, 4000, true);
  const owner = cleanText(payload.owner, 120);
  const implementationTarget = cleanText(payload.implementationTarget, 1000);
  const regressionRef = cleanText(payload.regressionRef, 2000);
  const evidenceRefs = stringArray(payload.evidenceRefs, "规则证据引用", false, 100);
  const retrospective = await rowById(db, "lifecycle_retrospectives", retrospectiveId);
  if (!retrospective) throw new LifecycleApiError("复盘不存在", 404);
  if (!["reviewed", "closed"].includes(String(retrospective.status))) {
    throw new LifecycleApiError("规则候选只能从已评审或已关闭的复盘产生", 409);
  }
  const id = `rule-candidate-${crypto.randomUUID()}`;
  const now = isoNow();
  const inputSha256 = await digest({
    action: "create_rule_candidate",
    retrospectiveId,
    title,
    ruleText,
    scope,
    counterexamples,
    owner,
    implementationTarget,
    regressionRef,
    evidenceRefs,
  });
  const results = await db.batch([
    db.prepare(`INSERT INTO lifecycle_rule_candidates
      (id, project_id, article_id, retrospective_id, title, rule_text, scope, counterexamples,
       owner, implementation_target, regression_ref, evidence_refs_json, state, lock_version, created_at, updated_at)
      SELECT ?, project_id, article_id, id, ?, ?, ?, ?, ?, ?, ?, ?, 'candidate', 1, ?, ?
      FROM lifecycle_retrospectives WHERE id = ? AND status IN ('reviewed','closed')`)
      .bind(
        id,
        title,
        ruleText,
        scope,
        counterexamples,
        owner,
        implementationTarget,
        regressionRef,
        canonicalJson(evidenceRefs),
        now,
        now,
        retrospectiveId,
      ),
    eventFromRow(db, {
      articleId: String(retrospective.article_id), eventType: "rule_candidate.created", subjectType: "rule_candidate", subjectId: id,
      payload: { retrospectiveId, state: "candidate", evidenceCount: evidenceRefs.length, adopted: false },
    }, inputSha256, "lifecycle_rule_candidates", "id = ? AND state = 'candidate'", [id], now),
  ]);
  assertMutation(results, 0, 1, "复盘状态已经变化，规则候选未创建");
  const candidate = await rowById(db, "lifecycle_rule_candidates", id);
  return Response.json({ ok: true, ruleCandidate: candidate ? parseRule(candidate) : null }, { status: 201 });
}

async function updateRuleCandidate(db: D1Database, payload: Record<string, unknown>) {
  const ruleCandidateId = requiredText(payload.ruleCandidateId, "规则候选 ID", 120);
  const expectedLockVersion = requiredPositiveInteger(payload.expectedLockVersion, "expectedLockVersion");
  const row = await rowById(db, "lifecycle_rule_candidates", ruleCandidateId);
  if (!row) throw new LifecycleApiError("规则候选不存在", 404);
  if (["adopted", "rejected"].includes(String(row.state))) throw new LifecycleApiError("已采纳或已拒绝规则不可再改写", 409);
  const title = cleanText(payload.title, 240) || String(row.title);
  const ruleText = typeof payload.ruleText === "string" ? requiredText(payload.ruleText, "规则内容", 8000, true) : String(row.rule_text);
  const scope = typeof payload.scope === "string" ? cleanText(payload.scope, 4000, true) : String(row.scope ?? "");
  const counterexamples = typeof payload.counterexamples === "string"
    ? cleanText(payload.counterexamples, 4000, true)
    : String(row.counterexamples ?? "");
  const owner = typeof payload.owner === "string" ? cleanText(payload.owner, 120) : String(row.owner ?? "");
  const implementationTarget = typeof payload.implementationTarget === "string"
    ? cleanText(payload.implementationTarget, 1000)
    : String(row.implementation_target ?? "");
  const regressionRef = typeof payload.regressionRef === "string"
    ? cleanText(payload.regressionRef, 2000)
    : String(row.regression_ref ?? "");
  const evidenceRefs = payload.evidenceRefs === undefined
    ? parseJson<string[]>(row.evidence_refs_json, [])
    : stringArray(payload.evidenceRefs, "规则证据引用", false, 100);
  const now = isoNow();
  const nextLock = expectedLockVersion + 1;
  const inputSha256 = await digest({
    action: "update_rule_candidate",
    ruleCandidateId,
    expectedLockVersion,
    title,
    ruleText,
    scope,
    counterexamples,
    owner,
    implementationTarget,
    regressionRef,
    evidenceRefs,
  });
  const results = await db.batch([
    db.prepare(`UPDATE lifecycle_rule_candidates SET title = ?, rule_text = ?, scope = ?, counterexamples = ?,
      owner = ?, implementation_target = ?, regression_ref = ?, evidence_refs_json = ?,
      lock_version = lock_version + 1, updated_at = ?
      WHERE id = ? AND state NOT IN ('adopted','rejected') AND lock_version = ?`)
      .bind(
        title,
        ruleText,
        scope,
        counterexamples,
        owner,
        implementationTarget,
        regressionRef,
        canonicalJson(evidenceRefs),
        now,
        ruleCandidateId,
        expectedLockVersion,
      ),
    eventFromRow(db, {
      articleId: String(row.article_id), eventType: "rule_candidate.updated", subjectType: "rule_candidate", subjectId: ruleCandidateId,
      payload: { expectedLockVersion, nextLockVersion: nextLock, evidenceCount: evidenceRefs.length },
    }, inputSha256, "lifecycle_rule_candidates", "id = ? AND lock_version = ? AND updated_at = ?", [ruleCandidateId, nextLock, now], now),
  ]);
  assertMutation(results, 0, 1, "规则状态或锁版本已经变化");
  const updated = await rowById(db, "lifecycle_rule_candidates", ruleCandidateId);
  return Response.json({ ok: true, ruleCandidate: updated ? parseRule(updated) : null });
}

async function transitionRuleCandidate(db: D1Database, payload: Record<string, unknown>) {
  const ruleCandidateId = requiredText(payload.ruleCandidateId, "规则候选 ID", 120);
  const targetState = requiredText(payload.targetState, "规则目标状态", 40);
  if (!ruleStateSet.has(targetState)) throw new LifecycleApiError("规则候选状态非法");
  const expectedLockVersion = requiredPositiveInteger(payload.expectedLockVersion, "expectedLockVersion");
  const note = requiredText(payload.note, "规则状态说明", 4000);
  const row = await rowById(db, "lifecycle_rule_candidates", ruleCandidateId);
  if (!row) throw new LifecycleApiError("规则候选不存在", 404);
  const currentState = String(row.state);
  if (!RULE_TRANSITIONS[currentState]?.has(targetState)) {
    throw new LifecycleApiError(`不允许从 ${currentState} 直接进入 ${targetState}`, 409);
  }
  const evidenceRefs = parseJson<string[]>(row.evidence_refs_json, []);
  if (["verified", "adopted"].includes(targetState)) {
    const missing = [
      ["scope", row.scope],
      ["counterexamples", row.counterexamples],
      ["owner", row.owner],
      ["implementationTarget", row.implementation_target],
      ["regressionRef", row.regression_ref],
    ].filter(([, value]) => !cleanText(value, 8000, true)).map(([label]) => label);
    if (evidenceRefs.length === 0) missing.push("evidenceRefs");
    if (missing.length > 0) throw new LifecycleApiError(`进入 ${targetState} 前缺少：${missing.join("、")}`, 409);
  }
  const now = isoNow();
  const nextLock = expectedLockVersion + 1;
  const inputSha256 = await digest({
    action: "transition_rule_candidate",
    ruleCandidateId,
    currentState,
    targetState,
    expectedLockVersion,
    note,
    evidenceRefs,
    regressionRef: row.regression_ref,
  });
  const results = await db.batch([
    db.prepare(`UPDATE lifecycle_rule_candidates SET state = ?, lock_version = lock_version + 1, updated_at = ?
      WHERE id = ? AND state = ? AND lock_version = ?`)
      .bind(targetState, now, ruleCandidateId, currentState, expectedLockVersion),
    eventFromRow(db, {
      articleId: String(row.article_id), eventType: "rule_candidate.state_changed", subjectType: "rule_candidate", subjectId: ruleCandidateId,
      payload: {
        from: currentState,
        to: targetState,
        note,
        evidenceCount: evidenceRefs.length,
        regressionRef: String(row.regression_ref ?? ""),
        claim: targetState === "adopted" ? "evidence_contract_satisfied" : "candidate_state_only",
      },
    }, inputSha256, "lifecycle_rule_candidates", "id = ? AND state = ? AND lock_version = ? AND updated_at = ?", [ruleCandidateId, targetState, nextLock, now], now),
  ]);
  assertMutation(results, 0, 1, "规则候选状态或锁版本已经变化");
  const updated = await rowById(db, "lifecycle_rule_candidates", ruleCandidateId);
  return Response.json({ ok: true, ruleCandidate: updated ? parseRule(updated) : null });
}

async function parseMutationBody(request: Request) {
  const declaredLength = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > 120_000) {
    throw new LifecycleApiError("生命周期写入请求超过 120 KB", 413);
  }
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > 120_000) throw new LifecycleApiError("生命周期写入请求超过 120 KB", 413);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new LifecycleApiError("请求正文必须是 JSON 对象");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new LifecycleApiError("请求正文必须是 JSON 对象");
  const envelope = value as Record<string, unknown>;
  const action = requiredText(envelope.action, "action", 80);
  const commandId = requiredText(envelope.commandId, "commandId", 160);
  if (!COMMAND_ID_RE.test(commandId)) {
    throw new LifecycleApiError("commandId 只能包含字母、数字、点、下划线、冒号和连字符");
  }
  if (!envelope.payload || typeof envelope.payload !== "object" || Array.isArray(envelope.payload)) {
    throw new LifecycleApiError("payload 必须是 JSON 对象");
  }
  return { action, commandId, payload: envelope.payload as Record<string, unknown> };
}

async function updateRelease(db: D1Database, payload: Record<string, unknown>) {
  const operation = requiredText(payload.operation, "Release 更新 operation", 80);
  switch (operation) {
    case "decide_approval": return decideReleaseApproval(db, payload);
    case "mark_ready": return markReleaseReady(db, payload);
    case "start_submission": return startReleaseSubmission(db, payload);
    case "record_submission": return recordReleaseSubmission(db, payload);
    case "record_destination": return recordReleaseDestination(db, payload);
    case "record_public": return recordReleasePublic(db, payload);
    case "transition_lifecycle": return transitionReleaseLifecycle(db, payload);
    default: throw new LifecycleApiError("未知 Release operation");
  }
}

function lifecycleReceiptHeaders(commandId: string, requestSha256: string, replayed: boolean) {
  return {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-wenmai-command-id": commandId,
    "x-wenmai-request-sha256": requestSha256,
    "x-wenmai-replayed": replayed ? "true" : "false",
  };
}

async function inspectLifecycleReceipt(
  db: D1Database,
  commandId: string,
  commandType: string,
  requestSha256: string,
  actorId: string,
) {
  const receipt = await db.prepare("SELECT * FROM command_receipts WHERE id = ? LIMIT 1").bind(commandId).first<D1Row>();
  if (!receipt) return null;
  if (receipt.command_type !== commandType || receipt.actor_id !== actorId || receipt.request_sha256 !== requestSha256) {
    throw new LifecycleApiError("COMMAND_ID_REUSED: 同一 commandId 已绑定不同的动作、身份或请求摘要", 409);
  }
  if (Number(receipt.status_code) > 0) {
    return new Response(String(receipt.response_json), {
      status: Number(receipt.status_code),
      headers: lifecycleReceiptHeaders(commandId, requestSha256, true),
    });
  }
  throw new LifecycleApiError("COMMAND_IN_PROGRESS: 命令仍在处理或上次状态未确认；禁止自动重试", 409);
}

async function dispatchLifecycleAction(db: D1Database, action: string, payload: Record<string, unknown>) {
  switch (action) {
    case "create_project": return createProject(db, payload);
    case "update_project": return updateProject(db, payload);
    case "transition_project_phase": return transitionProjectPhase(db, payload);
    case "transition_project_execution": return transitionProjectExecution(db, payload);
    case "create_platform_target": return createPlatformTarget(db, payload);
    case "create_adaptation_contract": return createAdaptationContract(db, payload);
    case "transition_adaptation_contract": return transitionAdaptationContract(db, payload);
    case "create_build": return createBuild(db, payload);
    case "record_build_result": return recordBuildResult(db, payload);
    case "supersede_build": return supersedeBuild(db, payload);
    case "record_build_gate": return recordBuildGate(db, payload);
    case "create_release": return createRelease(db, payload);
    case "update_release": return updateRelease(db, payload);
    case "decide_release_approval": return decideReleaseApproval(db, payload);
    case "start_release_submission": return startReleaseSubmission(db, payload);
    case "record_release_submission": return recordReleaseSubmission(db, payload);
    case "record_release_destination": return recordReleaseDestination(db, payload);
    case "record_release_public": return recordReleasePublic(db, payload);
    case "transition_release_lifecycle": return transitionReleaseLifecycle(db, payload);
    case "record_metric_snapshot": return recordMetricSnapshot(db, payload);
    case "validate_metric_snapshot": return validateMetricSnapshot(db, payload);
    case "create_retrospective": return createRetrospective(db, payload);
    case "update_retrospective": return updateRetrospective(db, payload);
    case "transition_retrospective": return transitionRetrospective(db, payload);
    case "create_rule_candidate": return createRuleCandidate(db, payload);
    case "update_rule_candidate": return updateRuleCandidate(db, payload);
    case "transition_rule_candidate": return transitionRuleCandidate(db, payload);
    default: throw new LifecycleApiError(`未知 lifecycle action：${action}`);
  }
}

async function executeLifecycleCommand(
  db: D1Database,
  action: string,
  commandId: string,
  actorId: string,
  payload: Record<string, unknown>,
) {
  const commandType = `lifecycle.${action}`;
  const requestSha256 = await digest({ action, actorId, payload });
  const replay = await inspectLifecycleReceipt(db, commandId, commandType, requestSha256, actorId);
  if (replay) return replay;
  const reserved = await db.prepare(`INSERT OR IGNORE INTO command_receipts
    (id, command_type, actor_id, request_sha256, response_json, status_code, created_at)
    VALUES (?, ?, ?, ?, '{}', 0, ?)`)
    .bind(commandId, commandType, actorId, requestSha256, isoNow()).run();
  if (Number(reserved.meta.changes ?? 0) !== 1) {
    const raced = await inspectLifecycleReceipt(db, commandId, commandType, requestSha256, actorId);
    if (raced) return raced;
    throw new LifecycleApiError("COMMAND_IN_PROGRESS: 命令尚未取得唯一执行权", 409);
  }

  let actionResponse: Response;
  try {
    actionResponse = await dispatchLifecycleAction(db, action, payload);
  } catch (error) {
    const status = error instanceof LifecycleApiError ? error.status : 500;
    const body = JSON.stringify({
      ok: false,
      error: error instanceof LifecycleApiError ? error.message : "生命周期写入失败",
    });
    const completed = await db.prepare(`UPDATE command_receipts
      SET response_json = ?, status_code = ?, completed_at = ?
      WHERE id = ? AND command_type = ? AND actor_id = ? AND request_sha256 = ? AND status_code = 0`)
      .bind(body, status, isoNow(), commandId, commandType, actorId, requestSha256).run();
    if (Number(completed.meta.changes ?? 0) !== 1) {
      const raced = await inspectLifecycleReceipt(db, commandId, commandType, requestSha256, actorId);
      if (raced) return raced;
      throw new LifecycleApiError("命令失败回执没有完成；禁止猜测写入结果", 503);
    }
    return new Response(body, { status, headers: lifecycleReceiptHeaders(commandId, requestSha256, false) });
  }

  const body = await actionResponse.text();
  const completed = await db.prepare(`UPDATE command_receipts
    SET response_json = ?, status_code = ?, completed_at = ?
    WHERE id = ? AND command_type = ? AND actor_id = ? AND request_sha256 = ? AND status_code = 0`)
    .bind(body, actionResponse.status, isoNow(), commandId, commandType, actorId, requestSha256).run();
  if (Number(completed.meta.changes ?? 0) !== 1) {
    const raced = await inspectLifecycleReceipt(db, commandId, commandType, requestSha256, actorId);
    if (raced) return raced;
    throw new LifecycleApiError("命令成功结果没有完成回执；禁止猜测写入结果", 503);
  }
  return new Response(body, {
    status: actionResponse.status,
    statusText: actionResponse.statusText,
    headers: lifecycleReceiptHeaders(commandId, requestSha256, false),
  });
}

export async function POST(request: Request) {
  try {
    const managementPrincipal = await requireManagementSession(request, { mutation: true, scope: "lifecycle.write" })
      .catch((error: unknown) => {
        if (error instanceof ManagementAuthError) throw new LifecycleApiError(error.message, error.status);
        throw error;
      });
    assertSameOrigin(request);
    const { action, commandId, payload } = await parseMutationBody(request);
    const db = await ensureLifecycleSchema();
    return await executeLifecycleCommand(db, action, commandId, managementActorId(managementPrincipal), payload);
  } catch (error) {
    const status = error instanceof LifecycleApiError ? error.status : 500;
    return Response.json({
      ok: false,
      error: error instanceof LifecycleApiError ? error.message : "生命周期写入失败",
    }, { status, headers: { "cache-control": "no-store" } });
  }
}
