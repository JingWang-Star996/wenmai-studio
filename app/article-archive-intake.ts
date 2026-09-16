import type { PackageDocument, PackageModuleInput } from "./article-project-types";
import { parseImportWorkflowMetadata, type ImportWorkflowMetadata } from "./import-profile.ts";
import type { VerifiedArticleGuidanceDecision } from "./article-guidance-decision.ts";

export const ARTICLE_ARCHIVE_INTAKE_SCHEMA_VERSION = "wenmai-article-archive-intake/1.0.0" as const;
export const ARTICLE_GUIDANCE_CHECKLIST_SCHEMA_VERSION = "wenmai-article-guidance-checklist/1.0.0" as const;
export const LOCAL_IMPORTER_VERSION = "wenmai-local-import/2.0.0" as const;

export const ARTICLE_INTAKE_CONTENT_KINDS = [
  "article",
  "source_material",
  "research_notes",
  "platform_copy",
  "other",
] as const;
export const ARTICLE_INTAKE_EDITORIAL_STAGES = [
  "unknown",
  "raw",
  "draft",
  "reviewed_claim",
  "final_claim",
] as const;

export type ArticleIntakeContentKind = (typeof ARTICLE_INTAKE_CONTENT_KINDS)[number];
export type ArticleIntakeEditorialStage = (typeof ARTICLE_INTAKE_EDITORIAL_STAGES)[number];

export interface LocalImportIntakeDeclaration {
  schemaVersion: "wenmai-local-import-declaration/1.0.0";
  contentKind: ArticleIntakeContentKind;
  editorialStage: ArticleIntakeEditorialStage;
  goal: string;
  audience: string;
  constraints: string[];
  declarationState: "agent_declared" | "policy_defaulted";
}

export type ArticleGuidanceCheckStatus = "passed" | "pending" | "blocked" | "human_required" | "not_applicable";
export type ArticleGuidanceActor = "deterministic_code" | "agent" | "coordinator" | "human";

export interface ArticleGuidanceCheck {
  id: string;
  phase: "archive" | "triage" | "editorial" | "boundary";
  title: string;
  status: ArticleGuidanceCheckStatus;
  requiredForArchive: boolean;
  responsibleActor: ArticleGuidanceActor;
  evidence: string[];
  instruction: string;
  onFailure: "repair_as_candidate" | "await_human" | "stop_and_report";
}

export interface ArticleGuidanceWorkUnit {
  moduleKey: string;
  title: string;
  kind: string;
  ordinal: number;
  state: "needs_decomposition" | "needs_human_review" | "human_confirmed";
  sourceRefKeys: string[];
  incomingRelations: number;
  outgoingRelations: number;
  allowedWrite: "candidate_patch_only";
}

export interface ArticleGuidanceChecklist {
  schemaVersion: typeof ARTICLE_GUIDANCE_CHECKLIST_SCHEMA_VERSION;
  checklistSha256: string;
  archiveState: "needs_archive_repair" | "archived_pending_human_triage" | "light_archive_ready" | "guided_editorial_work_ready";
  archiveReady: boolean;
  editorialWorkReady: boolean;
  processingProfile: "unselected" | "light_archive" | "full_production";
  profileAuthority: "none" | "policy_default" | "human";
  summary: {
    passed: number;
    pending: number;
    blocked: number;
    humanRequired: number;
    modules: number;
    sources: number;
    relations: number;
  };
  checks: ArticleGuidanceCheck[];
  nextAction: {
    checkId: string | null;
    actor: ArticleGuidanceActor;
    instruction: string;
  };
  workUnits: ArticleGuidanceWorkUnit[];
  permissions: {
    nextAllowedActions: string[];
    forbiddenActions: string[];
    patchDecisionAuthority: "owner_or_authorized_coordinator_only";
    completionAuthority: "coordinator_only";
  };
  completionBoundary: {
    archiveRecordVerified: boolean;
    editorialComplete: false;
    artifactDelivered: false;
    submissionAccepted: false;
    destinationRecordVerified: false;
    publicAccessVerified: false;
    outcomeVerified: false;
  };
  bindings: Record<string, string | number | boolean | null>;
}

export class ArticleArchiveIntakeError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ArticleArchiveIntakeError";
    this.code = code;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function boundedText(value: unknown, label: string, maximum: number, fallback = "") {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "string") throw new ArticleArchiveIntakeError("INVALID_INTAKE_FIELD", `${label} 必须是字符串`);
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum || /[\0\r\n]/u.test(normalized)) {
    throw new ArticleArchiveIntakeError("INVALID_INTAKE_FIELD", `${label} 为空、过长或包含不允许的控制字符`);
  }
  return normalized;
}

function boundedStringList(value: unknown, label: string) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 12) {
    throw new ArticleArchiveIntakeError("INVALID_INTAKE_FIELD", `${label} 必须是不超过 12 项的字符串数组`);
  }
  return value.map((item, index) => boundedText(item, `${label}[${index}]`, 240));
}

export function parseLocalImportIntakeDeclaration(value: unknown): LocalImportIntakeDeclaration {
  if (value === undefined || value === null) {
    return {
      schemaVersion: "wenmai-local-import-declaration/1.0.0",
      contentKind: "article",
      editorialStage: "unknown",
      goal: "保存当前正文并等待人工分流",
      audience: "未声明",
      constraints: [],
      declarationState: "policy_defaulted",
    };
  }
  if (!isObject(value)) throw new ArticleArchiveIntakeError("INVALID_INTAKE", "intake 必须是 JSON 对象");
  const allowed = ["schemaVersion", "contentKind", "editorialStage", "goal", "audience", "constraints"];
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unexpected.length) {
    throw new ArticleArchiveIntakeError("UNKNOWN_INTAKE_FIELD", `intake 包含未允许字段：${unexpected.join("、")}`);
  }
  const missing = allowed.filter((key) => !Object.hasOwn(value, key));
  if (missing.length) {
    throw new ArticleArchiveIntakeError("MISSING_INTAKE_FIELD", `intake 缺少必填字段：${missing.join("、")}`);
  }
  if (value.schemaVersion !== "wenmai-local-import-declaration/1.0.0") {
    throw new ArticleArchiveIntakeError("INVALID_INTAKE_SCHEMA", "intake.schemaVersion 必须是 wenmai-local-import-declaration/1.0.0");
  }
  if (!ARTICLE_INTAKE_CONTENT_KINDS.includes(value.contentKind as ArticleIntakeContentKind)) {
    throw new ArticleArchiveIntakeError("INVALID_CONTENT_KIND", "intake.contentKind 不在冻结枚举中");
  }
  if (!ARTICLE_INTAKE_EDITORIAL_STAGES.includes(value.editorialStage as ArticleIntakeEditorialStage)) {
    throw new ArticleArchiveIntakeError("INVALID_EDITORIAL_STAGE", "intake.editorialStage 不在冻结枚举中");
  }
  return {
    schemaVersion: "wenmai-local-import-declaration/1.0.0",
    contentKind: value.contentKind as ArticleIntakeContentKind,
    editorialStage: value.editorialStage as ArticleIntakeEditorialStage,
    goal: boundedText(value.goal, "intake.goal", 500),
    audience: boundedText(value.audience, "intake.audience", 300),
    constraints: boundedStringList(value.constraints, "intake.constraints"),
    declarationState: "agent_declared",
  };
}

function moduleKind(block: string) {
  const text = block.trimStart();
  if (/^#{1,6}\s/u.test(text)) return "heading";
  if (/^(?:[-*+] |\d+[.)] )/mu.test(text)) return "list";
  if (/^>\s?/mu.test(text)) return "quote";
  if (/^(?:`{3,}|~{3,})/u.test(text)) return "code";
  if (/^!\[[^\]]*\]\([^)]+\)/u.test(text)) return "image";
  if (/^(?:---+|\*\*\*+)$/mu.test(text)) return "divider";
  return "paragraph";
}

function moduleTitle(block: string, kind: string, index: number) {
  const plain = block
    .replace(/^#{1,6}\s+/u, "")
    .replace(/^>\s?/gmu, "")
    .replace(/[`*_~[\]()]/gu, "")
    .trim();
  if (kind === "heading") return plain.slice(0, 80) || `标题 ${index + 1}`;
  return plain.split(/\r?\n/u, 1)[0].slice(0, 52) || `模块 ${index + 1}`;
}

function fencedCodeRanges(text: string) {
  const ranges: Array<{ start: number; end: number }> = [];
  let open: { marker: "`" | "~"; length: number; start: number } | null = null;
  let lineStart = 0;
  while (lineStart < text.length) {
    const newline = text.indexOf("\n", lineStart);
    const lineEnd = newline === -1 ? text.length : newline;
    const line = text.slice(lineStart, lineEnd);
    if (!open) {
      const opening = line.match(/^[ \t]{0,3}(`{3,}|~{3,})/u);
      if (opening) {
        open = {
          marker: opening[1][0] as "`" | "~",
          length: opening[1].length,
          start: lineStart,
        };
      }
    } else {
      const closing = line.match(/^[ \t]{0,3}(`{3,}|~{3,})[ \t]*$/u);
      if (closing && closing[1][0] === open.marker && closing[1].length >= open.length) {
        // 保护到闭合围栏行末；闭合行后的换行仍可作为模块分隔符。
        ranges.push({ start: open.start, end: lineEnd });
        open = null;
      }
    }
    if (newline === -1) break;
    lineStart = newline + 1;
  }
  if (open) ranges.push({ start: open.start, end: text.length });
  return ranges;
}

function splitBlocks(text: string) {
  const normalized = text.replace(/\r\n?/gu, "\n");
  if (!normalized) return ["# 新文章\n\n从这里开始写作。"];
  const blocks: string[] = [];
  const protectedRanges = fencedCodeRanges(normalized);
  const separatorPattern = /\n{2,}(?=\S)/gu;
  let cursor = 0;
  let prefix = "";
  for (const match of normalized.matchAll(separatorPattern)) {
    const index = match.index;
    const separator = match[0];
    if (index === 0) continue;
    if (protectedRanges.some((range) => index >= range.start && index < range.end)) continue;
    blocks.push(`${prefix}${normalized.slice(cursor, index)}`);
    // Package 渲染器会在模块之间固定插入两个换行；把额外换行留在下一模块，确保正文逐字节可回读。
    prefix = separator.slice(2);
    cursor = index + separator.length;
  }
  blocks.push(`${prefix}${normalized.slice(cursor)}`);
  if (blocks.length <= 100) return blocks;
  return [...blocks.slice(0, 99), blocks.slice(99).join("\n\n")];
}

function utf8Bytes(value: string) {
  return new TextEncoder().encode(value).byteLength;
}

export function buildLocalImportPackageDocument(input: {
  title: string;
  bodyText: string;
  bodySha256: string;
  sourceName: string;
  format: "markdown" | "text";
  commandId: string;
  intake: LocalImportIntakeDeclaration;
}): PackageDocument {
  const blocks = splitBlocks(input.bodyText);
  const prefix = input.bodySha256.slice(0, 12);
  const sourceKey = `source-${input.bodySha256.slice(0, 16)}`;
  const source = {
    key: sourceKey,
    sourceKind: input.format === "markdown" ? "markdown_file" : "text_file",
    canonicalRef: input.sourceName,
    title: input.sourceName,
    contentSha256: input.bodySha256,
    excerpt: input.bodyText.slice(0, 500),
    metadata: {
      importer: LOCAL_IMPORTER_VERSION,
      originalFormat: input.format,
      sourceFingerprintSha256: input.bodySha256,
      sourceBytes: utf8Bytes(input.bodyText),
      captureBoundary: "content_received_through_local_import_key",
    },
    rights: {
      basis: "agent_supplied_local_content",
      verificationStatus: "unverified_declaration",
    },
  } satisfies PackageDocument["sources"][number];
  const modules: PackageModuleInput[] = blocks.map((block, index) => {
    const kind = moduleKind(block);
    return {
      key: `module-${prefix}-${String(index + 1).padStart(4, "0")}`,
      kind,
      title: moduleTitle(block, kind, index),
      contentFormat: input.format,
      contentText: block,
      metadata: {
        role: index === 0 ? "opening" : kind === "heading" ? "section_anchor" : "body",
        origin: "deterministic_local_import",
        confirmed: false,
        reviewState: "needs_human_review",
        tags: [],
      },
      refs: [{ refKind: "source", refKey: sourceKey, relationType: "imported_from" }],
    };
  });
  return {
    schemaVersion: "wenmai-package-document-v1",
    title: input.title,
    rootModuleKey: modules[0].key,
    modules,
    edges: modules.slice(1).map((module, index) => ({
      key: `edge-${prefix}-${String(index + 1).padStart(4, "0")}`,
      sourceModuleKey: modules[index].key,
      targetModuleKey: module.key,
      relationType: "precedes",
      ordinal: index,
    })),
    assets: [],
    sources: [source],
    metadata: {
      parser: LOCAL_IMPORTER_VERSION,
      sourceFingerprintSha256: input.bodySha256,
      archiveIntake: {
        schemaVersion: ARTICLE_ARCHIVE_INTAKE_SCHEMA_VERSION,
        ingressKind: "agent_key_local_import",
        commandId: input.commandId,
        declaration: input.intake,
        source: {
          name: input.sourceName,
          format: input.format,
          bodySha256: input.bodySha256,
          bytes: utf8Bytes(input.bodyText),
        },
        policyProfile: {
          currentProfile: "light_archive",
          selectionAuthority: "policy_default",
          confirmationState: "human_required",
          reasonCode: "WEAK_MODEL_SAFE_ARCHIVE_DEFAULT",
        },
        archiveState: "archived_pending_human_triage",
        nextRequiredAction: "human_confirm_processing_profile",
        completionBoundary: {
          archiveIdentityRequested: true,
          fullProductionRequested: false,
          editorialComplete: false,
          publishReady: false,
          deliveryComplete: false,
          publicReleaseVerified: false,
          outcomeVerified: false,
        },
      },
    },
  };
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

async function sha256Json(value: unknown) {
  const bytes = new TextEncoder().encode(JSON.stringify(stableValue(value)));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function metadataObject(value: unknown) {
  return isObject(value) ? value : {};
}

function compiledText(document: PackageDocument) {
  return document.modules.map((module) => typeof module.contentText === "string" ? module.contentText.trim() : "").filter(Boolean).join("\n\n");
}

function evidenceRef(prefix: string, value: unknown) {
  if (typeof value === "string" && value) return `${prefix}:${value}`;
  if (typeof value === "number" && Number.isFinite(value)) return `${prefix}:${value}`;
  return null;
}

export async function buildArticleGuidanceChecklist(input: {
  document: PackageDocument;
  packageStatus?: string | null;
  branchStatus?: string | null;
  workingCopyDirty?: boolean | null;
  branchBridgeInSync?: boolean | null;
  bindings?: Record<string, string | number | boolean | null | undefined>;
  verifiedDecision?: VerifiedArticleGuidanceDecision | null;
}): Promise<ArticleGuidanceChecklist> {
  const document = input.document;
  const archiveIntake = metadataObject(document.metadata?.archiveIntake);
  const importWorkflow = metadataObject(document.metadata?.importWorkflow);
  const archiveSource = metadataObject(archiveIntake.source);
  const policyProfile = metadataObject(archiveIntake.policyProfile);
  const registeredSourceShas = new Set(document.sources.flatMap((source) => source.contentSha256 ? [source.contentSha256] : []));
  const workflowDeclaredSource = metadataObject(importWorkflow.source).sha256;
  let declaredWorkflow: ImportWorkflowMetadata | null = null;
  if (typeof workflowDeclaredSource === "string" && registeredSourceShas.has(workflowDeclaredSource)) {
    try {
      declaredWorkflow = parseImportWorkflowMetadata(importWorkflow, workflowDeclaredSource);
    } catch {
      declaredWorkflow = null;
    }
  }
  const policyLightArchive = archiveIntake.schemaVersion === ARTICLE_ARCHIVE_INTAKE_SCHEMA_VERSION
    && policyProfile.currentProfile === "light_archive"
    && policyProfile.selectionAuthority === "policy_default";
  // Package document metadata is editable package state, not a server-side human decision receipt.
  // A syntactically valid importWorkflow therefore remains only a declaration here.
  const verifiedDecision = input.verifiedDecision ?? null;
  const processingProfile = verifiedDecision?.selectedProfile
    ?? (policyLightArchive ? "light_archive" : "unselected");
  const profileAuthority = verifiedDecision ? "human" : policyLightArchive ? "policy_default" : "none";
  const bodyBlocks = splitBlocks(compiledText(document));
  const documentFingerprint = document.metadata?.sourceFingerprintSha256;
  const archiveFingerprint = archiveSource.bodySha256;
  const targetFingerprints = new Set([
    ...(typeof documentFingerprint === "string" && documentFingerprint ? [documentFingerprint] : []),
    ...(typeof archiveFingerprint === "string" && archiveFingerprint ? [archiveFingerprint] : []),
  ]);
  const qualifiedSourceKeys = new Set(document.sources.flatMap((source) => {
    const rights = metadataObject(source.rights);
    const rightsBasis = typeof rights.basis === "string" ? rights.basis.trim() : "";
    const verificationStatus = typeof rights.verificationStatus === "string" ? rights.verificationStatus.trim() : "";
    return source.contentSha256 && targetFingerprints.has(source.contentSha256) && rightsBasis && verificationStatus
      ? [source.key]
      : [];
  }));
  const hasSourceFingerprint = qualifiedSourceKeys.size > 0;
  const allModulesReferenceSource = document.modules.every((module) =>
    (module.refs ?? []).some((ref) => ref.refKind === "source" && qualifiedSourceKeys.has(ref.refKey)));
  const decomposed = document.modules.length > 1 || bodyBlocks.length <= 1;
  const ordered = document.modules.length <= 1
    ? decomposed
    : document.modules.slice(1).every((module, index) => document.edges.some((edge) =>
      edge.relationType === "precedes"
      && edge.sourceModuleKey === document.modules[index].key
      && edge.targetModuleKey === module.key));
  const identityActive = input.packageStatus === "active" && input.branchStatus === "active";
  const synchronized = input.workingCopyDirty === false && input.branchBridgeInSync === true;
  const contentText = compiledText(document);
  const contentPresent = contentText.trim().length > 0;
  const bindingEvidence = Object.entries(input.bindings ?? {})
    .map(([key, value]) => evidenceRef(key, value))
    .filter((value): value is string => Boolean(value));
  const checks: ArticleGuidanceCheck[] = [
    {
      id: "archive.identity.active",
      phase: "archive",
      title: "文章、工程包与分支身份有效",
      status: identityActive ? "passed" : "blocked",
      requiredForArchive: true,
      responsibleActor: "deterministic_code",
      evidence: identityActive ? bindingEvidence.filter((item) => /^(articleId|packageId|branchId):/u.test(item)) : [],
      instruction: identityActive ? "保持现有对象身份，不重复建立同正文根项目。" : "停止写入，由协调者修复对象身份或分支状态。",
      onFailure: "stop_and_report",
    },
    {
      id: "archive.revision.readback",
      phase: "archive",
      title: "修订、冻结内容版本与工作副本保持同步",
      status: synchronized ? "passed" : "blocked",
      requiredForArchive: true,
      responsibleActor: "deterministic_code",
      evidence: synchronized ? bindingEvidence.filter((item) => /^(revisionId|compositionId|documentSha256|compositionSha256):/u.test(item)) : [],
      instruction: synchronized ? "所有后续候选都必须绑定当前修订、冻结内容版本和正文摘要。" : "冻结写动作，刷新并恢复同一分支基线。",
      onFailure: "stop_and_report",
    },
    {
      id: "archive.content.nonempty",
      phase: "archive",
      title: "正文包含可建档内容",
      status: contentPresent ? "passed" : "blocked",
      requiredForArchive: true,
      responsibleActor: "deterministic_code",
      evidence: contentPresent ? [`contentCharacters:${contentText.length}`] : [],
      instruction: contentPresent ? "保持正文摘要与来源摘要一致。" : "停止建档并要求提交非空原文；不得用占位正文伪造成功。",
      onFailure: "stop_and_report",
    },
    {
      id: "archive.source.registered",
      phase: "archive",
      title: "来源名称、格式、内容摘要与权利边界已登记",
      status: hasSourceFingerprint ? "passed" : "pending",
      requiredForArchive: true,
      responsibleActor: hasSourceFingerprint ? "deterministic_code" : "coordinator",
      evidence: document.sources.flatMap((source) => [
        `source:${source.key}`,
        ...(source.contentSha256 ? [`sourceSha256:${source.contentSha256}`] : []),
        ...(typeof source.rights?.basis === "string" && source.rights.basis.trim() ? [`rightsBasis:${source.rights.basis.trim()}`] : []),
        ...(typeof source.rights?.verificationStatus === "string" && source.rights.verificationStatus.trim()
          ? [`rightsVerificationStatus:${source.rights.verificationStatus.trim()}`]
          : []),
      ]),
      instruction: hasSourceFingerprint
        ? "输入登记 SourceRef（来源引用）后，引用事实或原文时只使用该来源，并保留用途与限制。"
        : "在工作台把原始文件重新导入为当前分支候选；若原文件已丢失，只能输出历史缺口，禁止伪造来源。",
      onFailure: "repair_as_candidate",
    },
    {
      id: "archive.graph.decomposed",
      phase: "archive",
      title: "正文已拆成可定位的模块工作单元",
      status: decomposed ? "passed" : "pending",
      requiredForArchive: true,
      responsibleActor: decomposed ? "deterministic_code" : "coordinator",
      evidence: [`modules:${document.modules.length}`, `sourceBlocks:${bodyBlocks.length}`],
      instruction: decomposed
        ? "按 moduleKey（模块键）逐项工作，不要整篇覆盖。"
        : "由协调者在工作台重新导入原文，或调用确定性解包建立候选文档；弱模型不能用受限补丁猜测拆分，也不能直接改写当前不可变内容版本。",
      onFailure: "repair_as_candidate",
    },
    {
      id: "archive.graph.ordered",
      phase: "archive",
      title: "模块顺序关系完整且可确定性编译",
      status: ordered ? "passed" : "pending",
      requiredForArchive: true,
      responsibleActor: ordered ? "deterministic_code" : "coordinator",
      evidence: [`relations:${document.edges.length}`],
      instruction: ordered ? "保留 precedes（顺序）关系；其他语义关系只能作为候选补充。" : "由协调者通过工作台确定性重导入或建立结构候选，补齐相邻模块的 precedes（顺序）关系；归档修复完成前不派给弱模型。",
      onFailure: "repair_as_candidate",
    },
    {
      id: "archive.module.provenance",
      phase: "archive",
      title: "每个模块都绑定已登记来源",
      status: allModulesReferenceSource ? "passed" : "pending",
      requiredForArchive: true,
      responsibleActor: allModulesReferenceSource ? "deterministic_code" : "coordinator",
      evidence: [`referencedModules:${document.modules.filter((module) => (module.refs ?? []).some((ref) => ref.refKind === "source")).length}`],
      instruction: allModulesReferenceSource ? "改写时保留来源引用；新增事实模块需新增证据引用。" : "由协调者在工作台重导入或建立来源绑定候选，为模块绑定具备摘要与权利合同的真实 SourceRef（来源引用）；归档修复完成前不派给弱模型。",
      onFailure: "repair_as_candidate",
    },
    {
      id: "triage.declaration.present",
      phase: "triage",
      title: "内容类型、阶段、目标与读者声明可读",
      status: archiveIntake.schemaVersion === ARTICLE_ARCHIVE_INTAKE_SCHEMA_VERSION || Boolean(declaredWorkflow) ? "passed" : "pending",
      requiredForArchive: false,
      responsibleActor: "coordinator",
      evidence: archiveIntake.schemaVersion === ARTICLE_ARCHIVE_INTAKE_SCHEMA_VERSION ? [`archiveIntake:${ARTICLE_ARCHIVE_INTAKE_SCHEMA_VERSION}`] : [],
      instruction: "把声明当作任务输入，不当作事实或完成证明；缺失时先补候选建档说明。",
      onFailure: "repair_as_candidate",
    },
    {
      id: "triage.profile.human_decision",
      phase: "triage",
      title: "处理预设已经人工确认",
      status: verifiedDecision ? "passed" : "human_required",
      requiredForArchive: false,
      responsibleActor: "human",
      evidence: verifiedDecision
        ? [
          `humanDecisionReceipt:${verifiedDecision.receiptId}`,
          `decisionActor:${verifiedDecision.actorId}`,
          `decisionRequestSha256:${verifiedDecision.requestSha256}`,
          `selectedProfile:${verifiedDecision.selectedProfile}`,
        ]
        : declaredWorkflow
          ? [`metadataDeclaration:${declaredWorkflow.selectedProfile}`, "humanDecisionReceipt:missing"]
        : policyLightArchive ? ["policyDefault:light_archive", "humanDecisionReceipt:missing"] : ["humanDecisionReceipt:missing"],
      instruction: verifiedDecision
        ? "保持本轮工作绑定人工分流回执与当前三类 CAS（并发摘要检查）；基线变化后必须重新决定。"
        : "请人在工作台通过服务端人工决定流程选择轻量建档或完整生产；输出的回执绑定当前对象。Package metadata（工程包元数据）、小模型、导入键值和策略都不能代替该回执。",
      onFailure: "await_human",
    },
    {
      id: "editorial.production.entry",
      phase: "editorial",
      title: "完整生产工位已获准启动",
      status: verifiedDecision?.selectedProfile === "full_production" ? "passed" : "not_applicable",
      requiredForArchive: false,
      responsibleActor: "coordinator",
      evidence: verifiedDecision?.selectedProfile === "full_production"
        ? [`humanDecisionReceipt:${verifiedDecision.receiptId}`, "selectedProfile:full_production"]
        : declaredWorkflow?.selectedProfile === "full_production"
        ? ["metadataDeclaration:full_production", "humanDecisionReceipt:missing"]
        : [],
      instruction: verifiedDecision?.selectedProfile === "full_production"
        ? "完整生产工位已获准启动；小模型只可按 moduleKey（模块键）提交候选 Patch（补丁），输出不等于编辑完成，也不得批准或发布。"
        : "当前没有完整生产的服务端人工决定回执；禁止进入事实台账、终稿、DOCX、封面、平台稿或交付工位。",
      onFailure: "await_human",
    },
    {
      id: "editorial.module.candidate",
      phase: "editorial",
      title: "从工作单元领取一个模块候选",
      status: verifiedDecision?.selectedProfile === "full_production" ? "pending" : "not_applicable",
      requiredForArchive: false,
      responsibleActor: "agent",
      evidence: verifiedDecision?.selectedProfile === "full_production"
        ? [`humanDecisionReceipt:${verifiedDecision.receiptId}`, `workUnits:${document.modules.length}`]
        : [],
      instruction: verifiedDecision?.selectedProfile === "full_production"
        ? "从 workUnits（工作单元）选择一个 targetModuleKey（目标模块键），只为该模块生成可审查候选 Patch（补丁）；不要覆盖整篇、应用补丁或宣称完成。"
        : "未选择完整生产，不向弱模型开放编辑候选工位。",
      onFailure: "repair_as_candidate",
    },
    {
      id: "boundary.claims.separated",
      phase: "boundary",
      title: "建档、编辑、交付与发布结果分别核验",
      status: "passed",
      requiredForArchive: true,
      responsibleActor: "deterministic_code",
      evidence: [ARTICLE_GUIDANCE_CHECKLIST_SCHEMA_VERSION],
      instruction: "只陈述当前清单直接证明的层级；不得从 clean/inSync（基线一致）、Gate pass（门禁通过）或回执推导完成、交付或公开可见。",
      onFailure: "stop_and_report",
    },
  ];
  const archiveReady = checks.filter((check) => check.requiredForArchive).every((check) => check.status === "passed");
  const editorialWorkReady = archiveReady && verifiedDecision?.selectedProfile === "full_production";
  const archiveState = !archiveReady
    ? "needs_archive_repair"
    : verifiedDecision?.selectedProfile === "full_production"
      ? "guided_editorial_work_ready"
      : verifiedDecision?.selectedProfile === "light_archive"
        ? "light_archive_ready"
        : "archived_pending_human_triage";
  const next = checks.find((check) => check.status === "blocked")
    ?? checks.find((check) => check.status === "pending")
    ?? checks.find((check) => check.status === "human_required")
    ?? null;
  const workUnits: ArticleGuidanceWorkUnit[] = document.modules.map((module, index) => {
    const sourceRefKeys = (module.refs ?? []).filter((ref) => ref.refKind === "source").map((ref) => ref.refKey);
    return {
      moduleKey: module.key,
      title: module.title,
      kind: module.kind,
      ordinal: index,
      state: !decomposed && document.modules.length === 1
        ? "needs_decomposition"
        : "needs_human_review",
      sourceRefKeys,
      incomingRelations: document.edges.filter((edge) => edge.targetModuleKey === module.key).length,
      outgoingRelations: document.edges.filter((edge) => edge.sourceModuleKey === module.key).length,
      allowedWrite: "candidate_patch_only",
    };
  });
  const bindings = Object.fromEntries(Object.entries(input.bindings ?? {}).map(([key, value]) => [key, value ?? null]));
  const checklistWithoutSha: Omit<ArticleGuidanceChecklist, "checklistSha256"> = {
    schemaVersion: ARTICLE_GUIDANCE_CHECKLIST_SCHEMA_VERSION,
    archiveState,
    archiveReady,
    editorialWorkReady,
    processingProfile,
    profileAuthority,
    summary: {
      passed: checks.filter((check) => check.status === "passed").length,
      pending: checks.filter((check) => check.status === "pending").length,
      blocked: checks.filter((check) => check.status === "blocked").length,
      humanRequired: checks.filter((check) => check.status === "human_required").length,
      modules: document.modules.length,
      sources: document.sources.length,
      relations: document.edges.length,
    },
    checks,
    nextAction: next
      ? { checkId: next.id, actor: next.responsibleActor, instruction: next.instruction }
      : { checkId: null, actor: "coordinator" as const, instruction: "当前指导清单没有开放项；由协调者决定是否结束本轮或创建下一工位。" },
    workUnits,
    permissions: {
      nextAllowedActions: editorialWorkReady
        ? ["read_package", "read_diagnostics", "work_one_module", "propose_package_patch", "report_progress", "await_human"]
        : ["read_package", "read_diagnostics", "report_progress", "await_human"],
      forbiddenActions: ["apply_patch", "advance_main", "select_full_production", "approve_editorial", "declare_complete", "publish_external"],
      patchDecisionAuthority: "owner_or_authorized_coordinator_only" as const,
      completionAuthority: "coordinator_only" as const,
    },
    completionBoundary: {
      archiveRecordVerified: archiveReady,
      editorialComplete: false as const,
      artifactDelivered: false as const,
      submissionAccepted: false as const,
      destinationRecordVerified: false as const,
      publicAccessVerified: false as const,
      outcomeVerified: false as const,
    },
    bindings,
  };
  return {
    ...checklistWithoutSha,
    checklistSha256: await sha256Json(checklistWithoutSha),
  };
}

export function articleArchiveIntakeContractManifest() {
  return {
    schemaVersion: ARTICLE_ARCHIVE_INTAKE_SCHEMA_VERSION,
    declarationSchemaVersion: "wenmai-local-import-declaration/1.0.0",
    guidanceChecklistSchemaVersion: ARTICLE_GUIDANCE_CHECKLIST_SCHEMA_VERSION,
    importerVersion: LOCAL_IMPORTER_VERSION,
    backwardCompatibility: {
      oldFiveFieldPayloadAccepted: true,
      omittedIntakeHandling: "policy_defaulted_light_archive_pending_human_triage",
      existingMinimalRootsMutatedOnRetry: false,
    },
    intakeFields: {
      required: ["schemaVersion", "contentKind", "editorialStage", "goal", "audience", "constraints"],
      contentKind: ARTICLE_INTAKE_CONTENT_KINDS,
      editorialStage: ARTICLE_INTAKE_EDITORIAL_STAGES,
    },
    deterministicArchiveWrites: ["source_ref", "source_sha256", "module_graph", "precedes_edges", "archive_intake_metadata"],
    humanOnlyDecisions: ["processing_profile_confirmation", "editorial_approval", "external_publish_authorization"],
    agentWriteBoundary: "candidate_patch_only",
    claimsNeverImpliedByArchive: [
      "editorial_complete",
      "artifact_delivered",
      "submission_accepted",
      "destination_record_verified",
      "public_access_verified",
      "outcome_verified",
    ],
  };
}
