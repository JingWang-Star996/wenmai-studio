import { env } from "cloudflare:workers";
import type {
  PackageDocument,
  PackageEdgeInput,
  PackageModuleInput,
  PackagePatchOperation,
} from "../../../article-project-types";
import {
  buildArticleGuidanceChecklist,
  buildLocalImportPackageDocument,
  parseLocalImportIntakeDeclaration,
  type LocalImportIntakeDeclaration,
} from "../../../article-archive-intake";
import {
  ARTICLE_GUIDANCE_DECISION_SCHEMA_VERSION,
  ARTICLE_GUIDANCE_PROFILES,
  loadLatestVerifiedArticleGuidanceDecision,
  type ArticleGuidanceDecisionBindings,
  type VerifiedArticleGuidanceDecision,
} from "../../../article-guidance-decision";
import {
  ARTICLE_PUBLICATION_PLATFORMS,
  publicationVersionFromDocument,
  validateArticlePublicationVersion,
  validateArticlePublicationVersionSet,
} from "../../../article-publication-version";
import {
  ARTICLE_PUBLICATION_SEMANTIC_GATE_SCHEMA_VERSION,
  ARTICLE_PUBLICATION_SEMANTIC_INVARIANT_IDS,
  ARTICLE_PUBLICATION_SEMANTIC_LEAD_WINDOW_CHARACTERS,
  semanticGateReadState,
  validateArticlePublicationSemanticGate,
  validatePlatformCanonicalContractBinding,
} from "../../../article-publication-semantic-gate";
import { ManagementAuthError } from "../../../management-auth-core";
import { sameAgentAuthorityLineage } from "../../../site-full-control-auth";
import { managementActorId, requireManagementSession } from "../../../management-auth";
import { requireManagementOrPrivilegedAgent, type ControlPrincipal } from "../../../privileged-agent-auth";
import { agentActionAuthorization } from "../../../agent-permission-catalog";
import {
  buildImportProfileMessages,
  fallbackImportProfileRecommendation,
  freezeImportProfileInput,
  ImportProfileContractError,
  parseImportProfileModelOutput,
  parseImportWorkflowMetadata,
  type ImportProfileRequestInput,
  type ImportWorkflowMetadata,
} from "../../../import-profile";
import {
  getModelGatewayProviderStatus,
  requestModelGatewayJson,
  toModelGatewaySafeError,
  type ModelGatewayProvider,
  type ModelGatewayServerEnv,
} from "../../../model-gateway";

type D1Row = Record<string, string | number | null>;
type JsonObject = Record<string, unknown>;
type MutationResult = { status?: number; data: JsonObject };
type D1Mutation = Awaited<ReturnType<D1PreparedStatement["run"]>>;

const API_VERSION = "wenmai-project-package-v1";
const DOCUMENT_SCHEMA_VERSION = "wenmai-package-document-v1";
const COMPOSITION_SCHEMA_VERSION = "wenmai-composition-v1";
const DIAGNOSTIC_ALGORITHM_VERSION = "wenmai-package-diagnostics-v2";
const PACKAGE_RENDERER_KEY = "wenmai.package-markdown";
const PACKAGE_RENDERER_VERSION = "1";
const MAX_REQUEST_BYTES = 2_500_000;
const MAX_DOCUMENT_BYTES = 1_900_000;
const MAX_MODULES = 100;
const MAX_EDGES = 300;
const MAX_RESOURCES = 200;
const MAX_REFS_PER_MODULE = 50;
const MAX_TOTAL_REFS = 500;
const MAX_PATCH_OPERATIONS = 50;
const MAX_LIST_LIMIT = 100;
const SHA256_RE = /^[a-f0-9]{64}$/;
const KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const CONTENT_FORMATS = new Set(["markdown", "text", "json"]);
const SLICE_KINDS = new Set(["full", "demo", "excerpt", "promo", "custom"]);
const PATCH_DECISIONS = new Set(["approved", "rejected"]);
const STRUCTURAL_EDGE_RELATIONS = new Set(["precedes", "contains", "next", "sequence", "child", "part_of"]);
const VIEWS = new Set([
  "manifest", "health", "packages", "package", "composition", "module", "working",
  "branches", "branch_bridge", "publication_versions", "resources", "slices", "patches", "diagnostics", "imports", "exports",
]);
const ACTIONS = new Set([
  "ensure_from_revision", "create_from_text", "ensure_branch_bridge", "attach_branch", "set_primary_branch",
  "save_working_package", "commit", "register_publication_version",
  "create_slice", "create_patch", "decide_patch", "apply_patch",
  "recommend_import_profile", "create_import_candidate", "create_export_manifest", "run_builtin_diagnostics",
  "decide_guidance_profile",
]);
const PRIVILEGED_PACKAGE_ACTIONS = {
  save_working_package: {
    managementScope: "package.write",
  },
  commit: {
    managementScope: "package.write",
  },
  attach_branch: {
    managementScope: "package.write",
  },
  register_publication_version: {
    managementScope: "package.write",
  },
  decide_patch: {
    managementScope: "package.patch.decide",
  },
  apply_patch: {
    managementScope: "package.patch.decide",
  },
} as const;

function runtimeEnv(): ModelGatewayServerEnv {
  return env as unknown as Readonly<Record<string, unknown>>;
}

function extendedProvidersEnabled() {
  return runtimeEnv().META_IMPROVEMENT_EXTENDED_PROVIDERS_ENABLED === "true";
}

class ProjectPackageApiError extends Error {
  status: number;
  code: string;
  details?: JsonObject;

  constructor(code: string, message: string, status = 400, details?: JsonObject) {
    super(message);
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function requestId() {
  return `req-${crypto.randomUUID()}`;
}

async function resolvePrivilegedPackageArticle(db: D1Database, action: string, payload: JsonObject) {
  if (action === "decide_patch") {
    const patchProposalId = requiredText(payload.patchProposalId, "patchProposalId", 160);
    const row = await db.prepare(`SELECT p.article_id FROM article_project_packages p
      JOIN package_patch_proposals proposal ON proposal.package_id = p.id WHERE proposal.id = ? LIMIT 1`)
      .bind(patchProposalId).first<D1Row>();
    if (!row?.article_id) throw new ProjectPackageApiError("PATCH_NOT_FOUND", "PatchProposal 不存在", 404);
    return String(row.article_id);
  }
  const packageId = requiredText(payload.packageId, "packageId", 160);
  const packageRow = await db.prepare("SELECT article_id FROM article_project_packages WHERE id = ? LIMIT 1").bind(packageId).first<D1Row>();
  if (!packageRow?.article_id) throw new ProjectPackageApiError("PACKAGE_NOT_FOUND", "文章工程包不存在", 404);
  const articleId = String(packageRow.article_id);
  if (action === "attach_branch" || action === "register_publication_version") {
    const branchId = requiredText(payload.branchId, "branchId", 160);
    const branchRow = await db.prepare("SELECT article_id FROM article_branches WHERE id = ? LIMIT 1").bind(branchId).first<D1Row>();
    if (!branchRow?.article_id || String(branchRow.article_id) !== articleId) {
      throw new ProjectPackageApiError("ARTICLE_SCOPE_DENIED", "Package 与分支不属于同一文章", 403);
    }
  }
  return articleId;
}

function assertPrivilegedPackageArticleBoundary(principal: Awaited<ReturnType<typeof requireManagementOrPrivilegedAgent>>, articleId: string) {
  if (principal.kind === "agent" && !principal.articleIds.includes("*") && !principal.articleIds.includes(articleId)) {
    throw new ProjectPackageApiError("PRIVILEGED_OBJECT_DENIED", "高权限 Agent Key 不包含当前文章对象", 403);
  }
}

function packageId() {
  return `pkg-${crypto.randomUUID()}`;
}

function jsonSuccess(id: string, data: JsonObject, status = 200) {
  return Response.json({ ok: true, requestId: id, data }, {
    status,
    headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" },
  });
}

function jsonError(id: string, error: unknown) {
  const apiError = error instanceof ProjectPackageApiError || error instanceof ManagementAuthError
    ? new ProjectPackageApiError(error.code, error.message, error.status, error.details)
    : new ProjectPackageApiError("INTERNAL_ERROR", "文章工程中台处理失败", 500);
  return Response.json({
    ok: false,
    requestId: id,
    error: {
      code: apiError.code,
      message: apiError.message,
      ...(apiError.details ? { details: apiError.details } : {}),
    },
  }, {
    status: apiError.status,
    headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" },
  });
}

function database() {
  if (!env.DB) throw new ProjectPackageApiError("DB_UNAVAILABLE", "本地文章工程数据库尚未连接", 503);
  return env.DB;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizedText(value: unknown, preserveWhitespace = false) {
  if (typeof value !== "string") return "";
  return preserveWhitespace ? value.replace(/\r\n?/g, "\n") : value.trim().replace(/\s+/g, " ");
}

function cleanText(value: unknown, maximum = 240, preserveWhitespace = false) {
  return normalizedText(value, preserveWhitespace).slice(0, maximum);
}

function requiredText(value: unknown, field: string, maximum = 240, preserveWhitespace = false) {
  const text = normalizedText(value, preserveWhitespace);
  if (!text) throw new ProjectPackageApiError("MISSING_FIELD", `缺少 ${field}`, 400, { field });
  if (text.length > maximum) throw new ProjectPackageApiError("FIELD_TOO_LARGE", `${field} 不得超过 ${maximum} 个字符`, 413, { field, maximum });
  return text;
}

function optionalText(value: unknown, maximum = 240, preserveWhitespace = false) {
  if (value === undefined || value === null) return "";
  const text = normalizedText(value, preserveWhitespace);
  if (text.length > maximum) throw new ProjectPackageApiError("FIELD_TOO_LARGE", `字段不得超过 ${maximum} 个字符`, 413, { maximum });
  return text;
}

function exactSha256(value: unknown, field: string) {
  const sha = requiredText(value, field, 64).toLowerCase();
  if (!SHA256_RE.test(sha)) throw new ProjectPackageApiError("INVALID_SHA256", `${field} 必须是 64 位小写 SHA-256`, 400, { field });
  return sha;
}

function optionalSha256(value: unknown, field: string) {
  if (value === undefined || value === null || value === "") return null;
  return exactSha256(value, field);
}

function exactInteger(value: unknown, field: string, minimum: number, maximum: number) {
  const number = typeof value === "number" ? value : Number.NaN;
  if (!Number.isInteger(number) || number < minimum || number > maximum) {
    throw new ProjectPackageApiError("INVALID_FIELD", `${field} 必须是 ${minimum} 到 ${maximum} 之间的整数`, 400, { field });
  }
  return number;
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string" || !value) return fallback;
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

function assertBoundedJson(value: unknown, field: string, maximumDepth = 20, maximumNodes = 50_000) {
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  let nodes = 0;
  while (stack.length) {
    const current = stack.pop()!;
    nodes += 1;
    if (nodes > maximumNodes) throw new ProjectPackageApiError("JSON_TOO_COMPLEX", `${field} 的 JSON 节点过多`, 413, { field, maximumNodes });
    if (current.depth > maximumDepth) throw new ProjectPackageApiError("JSON_TOO_DEEP", `${field} 的 JSON 嵌套过深`, 413, { field, maximumDepth });
    if (Array.isArray(current.value)) {
      for (const item of current.value) stack.push({ value: item, depth: current.depth + 1 });
    } else if (isObject(current.value)) {
      for (const item of Object.values(current.value)) stack.push({ value: item, depth: current.depth + 1 });
    }
  }
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (isObject(value)) {
    return Object.fromEntries(
      Object.keys(value).sort().filter((key) => value[key] !== undefined).map((key) => [key, canonicalValue(value[key])]),
    );
  }
  if (value === undefined) return null;
  return value;
}

function canonicalJson(value: unknown) {
  return JSON.stringify(canonicalValue(value));
}

async function sha256Text(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function isoNow() {
  return new Date().toISOString();
}

function resultChanges(result: D1Mutation) {
  return Number(result.meta.changes ?? 0);
}

function assertAllChanged(results: D1Mutation[], code: string, message: string) {
  if (results.some((result) => resultChanges(result) !== 1)) {
    throw new ProjectPackageApiError(code, message, 409);
  }
}

function sameOrigin(request: Request) {
  const url = new URL(request.url);
  const origin = request.headers.get("origin");
  const fetchSite = request.headers.get("sec-fetch-site");
  if (origin) return origin === url.origin && (!fetchSite || fetchSite === "same-origin" || fetchSite === "none");
  if (request.method !== "GET") return false;
  if (fetchSite) return fetchSite === "same-origin" || fetchSite === "none";
  const referer = request.headers.get("referer");
  if (!referer) return false;
  try { return new URL(referer).origin === url.origin; } catch { return false; }
}

function assertReadable(request: Request) {
  if (!sameOrigin(request)) throw new ProjectPackageApiError("ORIGIN_MISMATCH", "文章工程读取只接受当前工作台的同源请求", 403);
}

function assertManagementWrite(request: Request) {
  if (!sameOrigin(request)) throw new ProjectPackageApiError("ORIGIN_MISMATCH", "文章工程写入只接受当前工作台的同源请求", 403);
  if (request.headers.get("x-wenmai-write") !== "1") {
    throw new ProjectPackageApiError("WRITE_INTENT_REQUIRED", "文章工程写入缺少 X-Wenmai-Write: 1", 403);
  }
}

async function parseMutationBody(request: Request) {
  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.includes("application/json")) {
    throw new ProjectPackageApiError("UNSUPPORTED_MEDIA_TYPE", "请求正文必须使用 application/json", 415);
  }
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES) {
    throw new ProjectPackageApiError("REQUEST_TOO_LARGE", `请求正文不得超过 ${MAX_REQUEST_BYTES} 字节`, 413);
  }
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > MAX_REQUEST_BYTES) {
    throw new ProjectPackageApiError("REQUEST_TOO_LARGE", `请求正文不得超过 ${MAX_REQUEST_BYTES} 字节`, 413);
  }
  let body: unknown;
  try { body = JSON.parse(raw); } catch { throw new ProjectPackageApiError("INVALID_JSON", "请求正文不是有效 JSON"); }
  if (!isObject(body)) throw new ProjectPackageApiError("INVALID_JSON", "请求正文必须是 JSON 对象");
  const action = requiredText(body.action, "action", 80);
  if (!ACTIONS.has(action)) throw new ProjectPackageApiError("UNKNOWN_ACTION", `未知文章工程动作：${action}`, 404);
  if (!isObject(body.payload)) throw new ProjectPackageApiError("INVALID_PAYLOAD", "payload 必须是 JSON 对象");
  assertBoundedJson(body.payload, "payload");
  return { action, commandId: body.commandId, payload: body.payload };
}

// Compatibility boundary: this CREATE IF NOT EXISTS bootstrap upgrades existing local preview D1 files.
// Drizzle 0008 creates the Package model and 0009 adds its single-primary-ArticleBranch bridge.
// Neither migration may be blindly replayed over a runtime-bootstrapped preview whose journal lacks that baseline.
const RUNTIME_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS command_receipts (
    id TEXT PRIMARY KEY NOT NULL, command_type TEXT NOT NULL, actor_id TEXT NOT NULL,
    request_sha256 TEXT NOT NULL, response_json TEXT NOT NULL DEFAULT '{}',
    status_code INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, completed_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS workspace_events (
    id TEXT PRIMARY KEY NOT NULL, event_type TEXT NOT NULL, subject_type TEXT NOT NULL, subject_id TEXT NOT NULL,
    article_id TEXT, payload_json TEXT NOT NULL DEFAULT '{}', input_sha256 TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS article_branches (
    id TEXT PRIMARY KEY NOT NULL, article_id TEXT NOT NULL, name TEXT NOT NULL, slug TEXT NOT NULL,
    color TEXT NOT NULL DEFAULT 'blue', status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
    head_revision_id TEXT NOT NULL, base_revision_id TEXT NOT NULL, base_source_version_id TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS article_revisions (
    id TEXT PRIMARY KEY NOT NULL, article_id TEXT NOT NULL, branch_id TEXT NOT NULL, sequence INTEGER NOT NULL,
    parent_revision_id TEXT, merge_parent_revision_id TEXT, source_version_id TEXT, title TEXT NOT NULL,
    document_title TEXT NOT NULL, annotation TEXT NOT NULL DEFAULT '', body_text TEXT NOT NULL, body_sha256 TEXT NOT NULL,
    author_kind TEXT NOT NULL DEFAULT 'user' CHECK (author_kind IN ('user','agent','import')),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS branch_working_copies (
    branch_id TEXT PRIMARY KEY NOT NULL, article_id TEXT NOT NULL, base_revision_id TEXT NOT NULL,
    title TEXT NOT NULL, annotation TEXT NOT NULL DEFAULT '', body_text TEXT NOT NULL, body_sha256 TEXT NOT NULL,
    dirty INTEGER NOT NULL DEFAULT 0, lock_version INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS article_project_packages (
    id TEXT PRIMARY KEY NOT NULL, project_id TEXT, article_id TEXT NOT NULL, title TEXT NOT NULL,
    schema_version TEXT NOT NULL DEFAULT 'wenmai-package-v1', branch_model_version INTEGER, primary_branch_id TEXT, main_composition_id TEXT NOT NULL,
    main_composition_sha256 TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
    lock_version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS article_publication_versions (
    id TEXT PRIMARY KEY NOT NULL, package_id TEXT NOT NULL, article_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('canonical_baseline','platform_variant')),
    version_key TEXT NOT NULL, platform TEXT, branch_id TEXT NOT NULL, branch_lock_version INTEGER NOT NULL,
    revision_id TEXT NOT NULL, body_sha256 TEXT NOT NULL, composition_id TEXT NOT NULL, composition_sha256 TEXT NOT NULL,
    target_profile_id TEXT, target_profile_key TEXT, target_profile_sha256 TEXT,
    baseline_version_id TEXT, baseline_branch_id TEXT, baseline_revision_id TEXT, baseline_body_sha256 TEXT,
    baseline_composition_id TEXT, baseline_composition_sha256 TEXT,
    publication_version_json TEXT NOT NULL CHECK (json_valid(publication_version_json) AND json_type(publication_version_json) = 'object'),
    registration_sha256 TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active','superseded')),
    lock_version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    CHECK (branch_lock_version >= 1 AND lock_version >= 1),
    CHECK (length(body_sha256) = 64 AND length(composition_sha256) = 64 AND length(registration_sha256) = 64),
    CHECK (
      (role = 'canonical_baseline' AND version_key = 'canonical' AND platform IS NULL
        AND target_profile_id IS NULL AND target_profile_key IS NULL AND target_profile_sha256 IS NULL
        AND baseline_version_id IS NULL AND baseline_branch_id IS NULL AND baseline_revision_id IS NULL
        AND baseline_body_sha256 IS NULL AND baseline_composition_id IS NULL AND baseline_composition_sha256 IS NULL)
      OR
      (role = 'platform_variant' AND version_key IN ('maimai','xiaohongshu','zhihu','bilibili')
        AND platform = version_key AND target_profile_id IS NOT NULL AND target_profile_key IS NOT NULL
        AND length(target_profile_sha256) = 64 AND baseline_version_id IS NOT NULL
        AND baseline_branch_id IS NOT NULL AND baseline_revision_id IS NOT NULL
        AND length(baseline_body_sha256) = 64 AND baseline_composition_id IS NOT NULL
        AND length(baseline_composition_sha256) = 64)
    )
  )`,
  `CREATE TABLE IF NOT EXISTS package_modules (
    id TEXT PRIMARY KEY NOT NULL, package_id TEXT NOT NULL, module_key TEXT NOT NULL, module_kind TEXT NOT NULL,
    schema_key TEXT NOT NULL DEFAULT 'wenmai.module', schema_version TEXT NOT NULL DEFAULT '1', created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS package_module_revisions (
    id TEXT PRIMARY KEY NOT NULL, package_id TEXT NOT NULL, module_id TEXT NOT NULL, parent_revision_id TEXT,
    title TEXT NOT NULL, content_format TEXT NOT NULL CHECK (content_format IN ('markdown','text','json')),
    content_text TEXT NOT NULL DEFAULT '', content_json TEXT NOT NULL DEFAULT '{}', content_sha256 TEXT NOT NULL,
    metadata_json TEXT NOT NULL DEFAULT '{}', revision_sha256 TEXT NOT NULL,
    author_kind TEXT NOT NULL CHECK (author_kind IN ('user','agent','import','system')),
    source_patch_id TEXT, created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS package_assets (
    id TEXT PRIMARY KEY NOT NULL, package_id TEXT NOT NULL, asset_key TEXT NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL,
    content_ref TEXT NOT NULL, media_type TEXT NOT NULL, sha256 TEXT NOT NULL, size_bytes INTEGER NOT NULL,
    metadata_json TEXT NOT NULL DEFAULT '{}', rights_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS package_source_refs (
    id TEXT PRIMARY KEY NOT NULL, package_id TEXT NOT NULL, source_key TEXT NOT NULL, source_kind TEXT NOT NULL,
    canonical_ref TEXT NOT NULL, title TEXT NOT NULL, captured_at TEXT, content_sha256 TEXT, excerpt TEXT NOT NULL DEFAULT '',
    metadata_json TEXT NOT NULL DEFAULT '{}', rights_json TEXT NOT NULL DEFAULT '{}', ref_sha256 TEXT NOT NULL, created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS package_module_revision_refs (
    id TEXT PRIMARY KEY NOT NULL, package_id TEXT NOT NULL, module_revision_id TEXT NOT NULL,
    ref_kind TEXT NOT NULL CHECK (ref_kind IN ('asset','source')), ref_id TEXT NOT NULL,
    relation_type TEXT NOT NULL, anchor_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS package_compositions (
    id TEXT PRIMARY KEY NOT NULL, package_id TEXT NOT NULL, parent_composition_id TEXT, title TEXT NOT NULL,
    schema_version TEXT NOT NULL DEFAULT 'wenmai-composition-v1', root_module_id TEXT NOT NULL, document_json TEXT NOT NULL,
    document_sha256 TEXT NOT NULL, manifest_json TEXT NOT NULL, composition_sha256 TEXT NOT NULL,
    source_article_revision_id TEXT, author_kind TEXT NOT NULL CHECK (author_kind IN ('user','agent','import','system')),
    source_patch_id TEXT, created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS package_composition_materializations (
    id TEXT PRIMARY KEY NOT NULL, package_id TEXT NOT NULL, branch_id TEXT NOT NULL,
    composition_id TEXT NOT NULL, composition_sha256 TEXT NOT NULL, article_revision_id TEXT NOT NULL,
    article_body_sha256 TEXT NOT NULL, renderer_key TEXT NOT NULL DEFAULT 'wenmai.package-markdown',
    renderer_version TEXT NOT NULL DEFAULT '1', created_by_kind TEXT NOT NULL
      CHECK (created_by_kind IN ('user','agent','import','system')), created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS package_branch_states (
    package_id TEXT NOT NULL, branch_id TEXT NOT NULL, head_composition_id TEXT NOT NULL,
    head_composition_sha256 TEXT NOT NULL, head_revision_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
    lock_version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    PRIMARY KEY (package_id, branch_id)
  )`,
  `CREATE TABLE IF NOT EXISTS package_branch_working_copies (
    package_id TEXT NOT NULL, branch_id TEXT NOT NULL, base_composition_id TEXT NOT NULL,
    base_revision_id TEXT NOT NULL, document_json TEXT NOT NULL, document_sha256 TEXT NOT NULL,
    dirty INTEGER NOT NULL DEFAULT 0, lock_version INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL,
    PRIMARY KEY (package_id, branch_id)
  )`,
  `CREATE TABLE IF NOT EXISTS package_branch_composition_commits (
    id TEXT PRIMARY KEY NOT NULL, package_id TEXT NOT NULL, branch_id TEXT NOT NULL,
    parent_composition_id TEXT, composition_id TEXT NOT NULL, composition_sha256 TEXT NOT NULL,
    previous_revision_id TEXT, article_revision_id TEXT NOT NULL,
    source_kind TEXT NOT NULL CHECK (source_kind IN ('attach','commit','patch','import','system')),
    source_patch_id TEXT, created_by_kind TEXT NOT NULL CHECK (created_by_kind IN ('user','agent','import','system')),
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS package_branch_migration_audits (
    package_id TEXT PRIMARY KEY NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('legacy_unbound','migrated_clean','migrated_dirty','blocked')),
    reason_code TEXT NOT NULL DEFAULT '', detail_json TEXT NOT NULL DEFAULT '{}',
    source_schema_version TEXT NOT NULL DEFAULT '0009', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS package_composition_nodes (
    id TEXT PRIMARY KEY NOT NULL, package_id TEXT NOT NULL, composition_id TEXT NOT NULL, module_id TEXT NOT NULL,
    module_revision_id TEXT NOT NULL, node_key TEXT NOT NULL, slot TEXT NOT NULL DEFAULT 'body', ordinal INTEGER NOT NULL DEFAULT 0,
    required INTEGER NOT NULL DEFAULT 1, config_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS package_composition_edges (
    id TEXT PRIMARY KEY NOT NULL, package_id TEXT NOT NULL, composition_id TEXT NOT NULL, edge_key TEXT NOT NULL,
    source_node_id TEXT NOT NULL, target_node_id TEXT NOT NULL, relation_type TEXT NOT NULL, ordinal INTEGER NOT NULL DEFAULT 0,
    condition_json TEXT NOT NULL DEFAULT '{}', edge_sha256 TEXT NOT NULL, created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS package_working_copies (
    package_id TEXT PRIMARY KEY NOT NULL, branch_id TEXT, base_composition_id TEXT NOT NULL, base_revision_id TEXT,
    document_json TEXT NOT NULL,
    document_sha256 TEXT NOT NULL, dirty INTEGER NOT NULL DEFAULT 0, lock_version INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS package_slices (
    id TEXT PRIMARY KEY NOT NULL, package_id TEXT NOT NULL, branch_id TEXT, base_revision_id TEXT,
    base_branch_lock_version INTEGER, composition_id TEXT NOT NULL, composition_sha256 TEXT NOT NULL,
    title TEXT NOT NULL, slice_kind TEXT NOT NULL CHECK (slice_kind IN ('full','demo','excerpt','promo','custom')),
    selector_json TEXT NOT NULL DEFAULT '{}', resolved_manifest_json TEXT NOT NULL, slice_sha256 TEXT NOT NULL,
    created_by_kind TEXT NOT NULL CHECK (created_by_kind IN ('user','agent','import','system')), created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS package_patch_proposals (
    id TEXT PRIMARY KEY NOT NULL, package_id TEXT NOT NULL, base_composition_id TEXT NOT NULL, base_composition_sha256 TEXT NOT NULL,
    branch_id TEXT, base_revision_id TEXT, base_package_lock_version INTEGER, base_branch_lock_version INTEGER,
    task_id TEXT, attempt_id TEXT, context_sha256 TEXT, title TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '',
    operations_json TEXT NOT NULL, patch_sha256 TEXT NOT NULL, evidence_json TEXT NOT NULL DEFAULT '[]',
    diagnostic_issue_ids_json TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'candidate'
      CHECK (status IN ('candidate','approved','rejected','applied','stale','cancelled')),
    lock_version INTEGER NOT NULL DEFAULT 1, created_by_kind TEXT NOT NULL
      CHECK (created_by_kind IN ('user','agent','import','diagnostic')), created_by_id TEXT NOT NULL,
    decision_note TEXT NOT NULL DEFAULT '', applied_composition_id TEXT, created_at TEXT NOT NULL,
    reviewed_at TEXT, decided_by_kind TEXT, decided_by_id TEXT, applied_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS package_diagnosis_runs (
    id TEXT PRIMARY KEY NOT NULL, package_id TEXT NOT NULL, branch_id TEXT, base_revision_id TEXT,
    base_branch_lock_version INTEGER, composition_id TEXT NOT NULL, composition_sha256 TEXT NOT NULL,
    algorithm_version TEXT NOT NULL, result TEXT NOT NULL CHECK (result IN ('pass','fail','inconclusive')),
    issue_count INTEGER NOT NULL, error_count INTEGER NOT NULL, warning_count INTEGER NOT NULL,
    input_sha256 TEXT NOT NULL, summary_sha256 TEXT NOT NULL, created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS package_diagnostic_issues (
    id TEXT PRIMARY KEY NOT NULL, diagnosis_run_id TEXT NOT NULL, package_id TEXT NOT NULL, branch_id TEXT, composition_id TEXT NOT NULL,
    module_id TEXT, node_id TEXT, edge_id TEXT, code TEXT NOT NULL,
    severity TEXT NOT NULL CHECK (severity IN ('error','warning','info')), title TEXT NOT NULL, message TEXT NOT NULL,
    evidence_json TEXT NOT NULL DEFAULT '[]', suggested_patch_json TEXT NOT NULL DEFAULT '[]', issue_sha256 TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS package_import_runs (
    id TEXT PRIMARY KEY NOT NULL, package_id TEXT NOT NULL, branch_id TEXT, base_revision_id TEXT,
    base_branch_lock_version INTEGER, base_composition_id TEXT NOT NULL,
    base_composition_sha256 TEXT NOT NULL, source_kind TEXT NOT NULL, source_ref TEXT NOT NULL,
    source_fingerprint_sha256 TEXT NOT NULL, importer_key TEXT NOT NULL, importer_version TEXT NOT NULL,
    manifest_json TEXT NOT NULL, manifest_sha256 TEXT NOT NULL, patch_proposal_id TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('candidate_ready','applied','failed','cancelled')),
    lock_version INTEGER NOT NULL DEFAULT 1, error_summary TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, finished_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS package_export_runs (
    id TEXT PRIMARY KEY NOT NULL, package_id TEXT NOT NULL, branch_id TEXT, base_revision_id TEXT,
    base_branch_lock_version INTEGER, composition_id TEXT NOT NULL, composition_sha256 TEXT NOT NULL,
    slice_id TEXT, slice_sha256 TEXT, export_kind TEXT NOT NULL, exporter_key TEXT NOT NULL, exporter_version TEXT NOT NULL,
    manifest_json TEXT NOT NULL, manifest_sha256 TEXT NOT NULL, artifact_ref TEXT NOT NULL DEFAULT '',
    artifact_sha256 TEXT NOT NULL DEFAULT '', artifact_media_type TEXT NOT NULL DEFAULT 'application/json',
    state TEXT NOT NULL CHECK (state IN ('manifest_ready','verified','failed','cancelled')),
    lock_version INTEGER NOT NULL DEFAULT 1, failure_summary TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, verified_at TEXT
  )`,
];

const RUNTIME_INDEXES = [
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_article_branches_article_slug ON article_branches(article_id, slug)",
  "CREATE INDEX IF NOT EXISTS idx_article_branches_article_status ON article_branches(article_id, status)",
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_article_revisions_branch_sequence ON article_revisions(branch_id, sequence)",
  "CREATE INDEX IF NOT EXISTS idx_article_revisions_article_created ON article_revisions(article_id, created_at)",
  "CREATE INDEX IF NOT EXISTS idx_article_revisions_branch_created ON article_revisions(branch_id, created_at)",
  "CREATE INDEX IF NOT EXISTS idx_branch_working_copies_article ON branch_working_copies(article_id, updated_at)",
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_article_project_packages_article ON article_project_packages(article_id)",
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_article_project_packages_project ON article_project_packages(project_id) WHERE project_id IS NOT NULL",
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_article_project_packages_primary_branch ON article_project_packages(primary_branch_id) WHERE primary_branch_id IS NOT NULL",
  "CREATE INDEX IF NOT EXISTS idx_article_project_packages_status_updated ON article_project_packages(status, updated_at)",
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_article_publication_versions_active_key ON article_publication_versions(package_id, version_key) WHERE state = 'active'",
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_article_publication_versions_active_branch ON article_publication_versions(package_id, branch_id) WHERE state = 'active'",
  "CREATE INDEX IF NOT EXISTS idx_article_publication_versions_article_state ON article_publication_versions(article_id, state, updated_at)",
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_package_modules_package_key ON package_modules(package_id, module_key)",
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_package_module_revisions_module_sha ON package_module_revisions(module_id, revision_sha256)",
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_package_assets_package_key ON package_assets(package_id, asset_key)",
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_package_assets_package_sha ON package_assets(package_id, sha256)",
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_package_sources_package_key ON package_source_refs(package_id, source_key)",
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_package_sources_package_sha ON package_source_refs(package_id, ref_sha256)",
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_package_module_revision_refs_unique ON package_module_revision_refs(module_revision_id, ref_kind, ref_id, relation_type)",
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_package_compositions_package_sha ON package_compositions(package_id, composition_sha256)",
  "CREATE INDEX IF NOT EXISTS idx_package_materializations_branch_composition ON package_composition_materializations(branch_id, composition_id, created_at)",
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_package_materializations_revision ON package_composition_materializations(article_revision_id)",
  "CREATE INDEX IF NOT EXISTS idx_package_materializations_package_created ON package_composition_materializations(package_id, created_at)",
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_package_branch_states_branch ON package_branch_states(branch_id)",
  "CREATE INDEX IF NOT EXISTS idx_package_branch_states_package_status ON package_branch_states(package_id, status, updated_at)",
  "CREATE INDEX IF NOT EXISTS idx_package_branch_working_dirty ON package_branch_working_copies(package_id, dirty, updated_at)",
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_package_branch_commits_revision ON package_branch_composition_commits(branch_id, article_revision_id)",
  "CREATE INDEX IF NOT EXISTS idx_package_branch_commits_history ON package_branch_composition_commits(package_id, branch_id, created_at)",
  "CREATE INDEX IF NOT EXISTS idx_package_branch_migration_audits_state ON package_branch_migration_audits(state, updated_at)",
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_package_composition_nodes_key ON package_composition_nodes(composition_id, node_key)",
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_package_composition_nodes_module ON package_composition_nodes(composition_id, module_id)",
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_package_composition_edges_key ON package_composition_edges(composition_id, edge_key)",
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_package_slices_composition_sha ON package_slices(composition_id, slice_sha256)",
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_package_patch_proposals_package_sha ON package_patch_proposals(package_id, patch_sha256)",
  "CREATE INDEX IF NOT EXISTS idx_package_patch_proposals_package_status ON package_patch_proposals(package_id, status, created_at)",
  "CREATE INDEX IF NOT EXISTS idx_package_patch_proposals_branch_status ON package_patch_proposals(package_id, branch_id, status, created_at)",
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_package_diagnosis_runs_input ON package_diagnosis_runs(package_id, input_sha256)",
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_package_diagnostic_issues_run_sha ON package_diagnostic_issues(diagnosis_run_id, issue_sha256)",
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_package_import_runs_manifest ON package_import_runs(package_id, manifest_sha256)",
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_package_export_runs_manifest ON package_export_runs(package_id, manifest_sha256)",
  "CREATE INDEX IF NOT EXISTS idx_package_slices_branch_created ON package_slices(package_id, branch_id, created_at)",
  "CREATE INDEX IF NOT EXISTS idx_package_diagnosis_runs_branch_created ON package_diagnosis_runs(package_id, branch_id, created_at)",
  "CREATE INDEX IF NOT EXISTS idx_package_diagnostic_issues_branch ON package_diagnostic_issues(package_id, branch_id, created_at)",
  "CREATE INDEX IF NOT EXISTS idx_package_import_runs_branch_state ON package_import_runs(package_id, branch_id, state, created_at)",
  "CREATE INDEX IF NOT EXISTS idx_package_export_runs_branch_state ON package_export_runs(package_id, branch_id, state, created_at)",
  "CREATE INDEX IF NOT EXISTS idx_workspace_events_subject_created ON workspace_events(subject_type, subject_id, created_at)",
];

let schemaBootstrap: Promise<unknown> | null = null;

async function addColumnIfMissing(db: D1Database, table: string, column: string, definition: string) {
  const columns = await db.prepare(`PRAGMA table_info(${table})`).all<D1Row>();
  if (!columns.results.some((item) => item.name === column)) {
    await db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`).run();
  }
}

async function writeBranchMigrationAudit(
  db: D1Database,
  packageIdValue: string,
  state: "legacy_unbound" | "migrated_clean" | "migrated_dirty" | "blocked",
  reasonCode: string,
  detail: JsonObject,
  now: string,
) {
  await db.prepare(`INSERT INTO package_branch_migration_audits
    (package_id, state, reason_code, detail_json, source_schema_version, created_at, updated_at)
    VALUES (?, ?, ?, ?, '0009', ?, ?)
    ON CONFLICT(package_id) DO UPDATE SET state = excluded.state, reason_code = excluded.reason_code,
      detail_json = excluded.detail_json, updated_at = excluded.updated_at`)
    .bind(packageIdValue, state, reasonCode, canonicalJson(detail), now, now).run();
}

async function migrateLegacyPackageBranches(db: D1Database) {
  const packages = await db.prepare(`SELECT package.*,
      composition.id AS composition_present, composition.document_sha256 AS composition_document_sha256,
      legacy_copy.branch_id AS legacy_branch_id, legacy_copy.base_composition_id AS legacy_base_composition_id,
      legacy_copy.base_revision_id AS legacy_base_revision_id, legacy_copy.document_json AS legacy_document_json,
      legacy_copy.document_sha256 AS legacy_document_sha256, legacy_copy.dirty AS legacy_dirty,
      legacy_copy.lock_version AS legacy_lock_version, legacy_copy.updated_at AS legacy_updated_at,
      branch.article_id AS branch_article_id, branch.status AS branch_status, branch.head_revision_id AS branch_head_revision_id,
      revision.branch_id AS revision_branch_id, revision.article_id AS revision_article_id,
      revision.parent_revision_id AS revision_parent_revision_id, revision.body_sha256 AS revision_body_sha256,
      article_copy.base_revision_id AS article_copy_base_revision_id, article_copy.dirty AS article_copy_dirty,
      materialization.id AS materialization_id, materialization.composition_sha256 AS materialization_composition_sha256,
      materialization.article_revision_id AS materialization_revision_id,
      materialization.article_body_sha256 AS materialization_body_sha256,
      audit.state AS audit_state, audit.reason_code AS audit_reason_code
    FROM article_project_packages package
    LEFT JOIN package_compositions composition ON composition.id = package.main_composition_id
      AND composition.package_id = package.id AND composition.composition_sha256 = package.main_composition_sha256
    LEFT JOIN package_working_copies legacy_copy ON legacy_copy.package_id = package.id
    LEFT JOIN article_branches branch ON branch.id = package.primary_branch_id
    LEFT JOIN article_revisions revision ON revision.id = branch.head_revision_id
    LEFT JOIN branch_working_copies article_copy ON article_copy.branch_id = branch.id
    LEFT JOIN package_composition_materializations materialization
      ON materialization.package_id = package.id AND materialization.branch_id = branch.id
      AND materialization.composition_id = package.main_composition_id
      AND materialization.article_revision_id = branch.head_revision_id
    LEFT JOIN package_branch_migration_audits audit ON audit.package_id = package.id
    ORDER BY package.created_at ASC, package.id ASC LIMIT 5000`).all<D1Row>();
  for (const row of packages.results) {
    const ownerPackageId = String(row.id);
    const now = isoNow();
    const primaryBranchId = row.primary_branch_id ? String(row.primary_branch_id) : null;
    const detail = {
      primaryBranchId,
      mainCompositionId: row.main_composition_id,
      branchHeadRevisionId: row.branch_head_revision_id,
      packageBaseCompositionId: row.legacy_base_composition_id,
      packageBaseRevisionId: row.legacy_base_revision_id,
      packageWorkingDirty: row.legacy_dirty === null ? null : Number(row.legacy_dirty) === 1,
      packageWorkingLockVersion: row.legacy_lock_version,
      articleWorkingBaseRevisionId: row.article_copy_base_revision_id,
      articleWorkingDirty: row.article_copy_dirty === null ? null : Number(row.article_copy_dirty) === 1,
      materializationId: row.materialization_id,
    };
    if (Number(row.branch_model_version) === 2) {
      const invariant = primaryBranchId ? await db.prepare(`SELECT 1 AS valid
        FROM package_branch_states state
        JOIN package_branch_working_copies package_copy
          ON package_copy.package_id = state.package_id AND package_copy.branch_id = state.branch_id
        JOIN article_branches branch ON branch.id = state.branch_id AND branch.article_id = ?
        JOIN article_revisions revision ON revision.id = state.head_revision_id AND revision.branch_id = state.branch_id
        JOIN branch_working_copies article_copy ON article_copy.branch_id = state.branch_id
        JOIN package_composition_materializations materialization
          ON materialization.package_id = state.package_id AND materialization.branch_id = state.branch_id
          AND materialization.composition_id = state.head_composition_id
          AND materialization.article_revision_id = state.head_revision_id
        JOIN package_branch_composition_commits commit_ref
          ON commit_ref.package_id = state.package_id AND commit_ref.branch_id = state.branch_id
          AND commit_ref.composition_id = state.head_composition_id
          AND commit_ref.article_revision_id = state.head_revision_id
        WHERE state.package_id = ? AND state.branch_id = ?
          AND state.head_composition_id = ? AND state.head_composition_sha256 = ?
          AND package_copy.base_composition_id = state.head_composition_id
          AND package_copy.base_revision_id = state.head_revision_id
          AND branch.head_revision_id = state.head_revision_id
          AND article_copy.base_revision_id = state.head_revision_id AND article_copy.dirty = 0 LIMIT 1`)
        .bind(row.article_id, ownerPackageId, primaryBranchId, row.main_composition_id, row.main_composition_sha256)
        .first<D1Row>() : null;
      if (!invariant) await writeBranchMigrationAudit(db, ownerPackageId, "blocked", "MULTIBRANCH_INVARIANT_FAILED", detail, now);
      continue;
    }
    if (row.audit_state === "blocked") continue;
    if (!primaryBranchId) {
      await writeBranchMigrationAudit(db, ownerPackageId, "legacy_unbound", "PRIMARY_BRANCH_MISSING", detail, now);
      continue;
    }
    let reasonCode = "";
    if (!row.composition_present) reasonCode = "MAIN_COMPOSITION_INVALID";
    else if (row.legacy_branch_id === null) reasonCode = "LEGACY_PACKAGE_WORKING_COPY_MISSING";
    else if (row.legacy_branch_id !== primaryBranchId) reasonCode = "LEGACY_PACKAGE_WORKING_BRANCH_MISMATCH";
    else if (row.branch_article_id !== row.article_id) reasonCode = "ARTICLE_BRANCH_INVALID";
    else if (row.revision_branch_id !== primaryBranchId || row.revision_article_id !== row.article_id) reasonCode = "ARTICLE_HEAD_REVISION_INVALID";
    else if (row.legacy_base_composition_id !== row.main_composition_id || row.legacy_base_revision_id !== row.branch_head_revision_id) reasonCode = "LEGACY_PACKAGE_BASE_MISMATCH";
    else if (row.article_copy_base_revision_id !== row.branch_head_revision_id || Number(row.article_copy_dirty) !== 0) reasonCode = "ARTICLE_WORKING_COPY_NOT_CLEAN_HEAD";
    else if (!row.materialization_id || row.materialization_composition_sha256 !== row.main_composition_sha256
      || row.materialization_revision_id !== row.branch_head_revision_id || row.materialization_body_sha256 !== row.revision_body_sha256) reasonCode = "MATERIALIZATION_INVALID";
    else if (Number(row.legacy_dirty) === 0 && row.legacy_document_sha256 !== row.composition_document_sha256) reasonCode = "CLEAN_DOCUMENT_SHA_MISMATCH";
    else if (Number(row.legacy_dirty) === 1 && row.legacy_document_sha256 === row.composition_document_sha256) reasonCode = "DIRTY_DOCUMENT_SHA_UNCHANGED";
    if (reasonCode) {
      await writeBranchMigrationAudit(db, ownerPackageId, "blocked", reasonCode, detail, now);
      continue;
    }
    const auditState = Number(row.legacy_dirty) === 1 ? "migrated_dirty" : "migrated_clean";
    const commitId = `branch-commit-legacy-${ownerPackageId.replace(/^pkg-/, "")}`;
    const results = await db.batch([
      db.prepare(`INSERT OR IGNORE INTO package_branch_states
        (package_id, branch_id, head_composition_id, head_composition_sha256, head_revision_id,
         status, lock_version, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`)
        .bind(ownerPackageId, primaryBranchId, row.main_composition_id, row.main_composition_sha256,
          row.branch_head_revision_id, row.branch_status === "archived" ? "archived" : "active", row.created_at, row.updated_at),
      db.prepare(`INSERT OR IGNORE INTO package_branch_working_copies
        (package_id, branch_id, base_composition_id, base_revision_id, document_json, document_sha256,
         dirty, lock_version, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(ownerPackageId, primaryBranchId, row.legacy_base_composition_id, row.legacy_base_revision_id,
          row.legacy_document_json, row.legacy_document_sha256, row.legacy_dirty, row.legacy_lock_version, row.legacy_updated_at),
      db.prepare(`INSERT OR IGNORE INTO package_branch_composition_commits
        (id, package_id, branch_id, parent_composition_id, composition_id, composition_sha256,
         previous_revision_id, article_revision_id, source_kind, source_patch_id, created_by_kind, created_at)
        SELECT ?, ?, ?, composition.parent_composition_id, ?, ?, ?, ?, 'system', NULL, 'system', ?
        FROM package_compositions composition WHERE composition.id = ? AND composition.package_id = ? LIMIT 1`)
        .bind(commitId, ownerPackageId, primaryBranchId, row.main_composition_id, row.main_composition_sha256,
          row.revision_parent_revision_id, row.branch_head_revision_id, row.updated_at, row.main_composition_id, ownerPackageId),
    ]);
    if (results.some((result) => resultChanges(result) > 1)) {
      await writeBranchMigrationAudit(db, ownerPackageId, "blocked", "BACKFILL_MULTIPLE_ROWS", detail, now);
      continue;
    }
    await writeBranchMigrationAudit(db, ownerPackageId, auditState, "", detail, now);
    const updated = await db.prepare(`UPDATE article_project_packages SET branch_model_version = 2
      WHERE id = ? AND branch_model_version IS NULL
        AND EXISTS (SELECT 1 FROM package_branch_states WHERE package_id = ? AND branch_id = ?)
        AND EXISTS (SELECT 1 FROM package_branch_working_copies WHERE package_id = ? AND branch_id = ?)
        AND EXISTS (SELECT 1 FROM package_branch_composition_commits WHERE package_id = ? AND branch_id = ?
          AND composition_id = ? AND article_revision_id = ?)`)
      .bind(ownerPackageId, ownerPackageId, primaryBranchId, ownerPackageId, primaryBranchId,
        ownerPackageId, primaryBranchId, row.main_composition_id, row.branch_head_revision_id).run();
    if (resultChanges(updated) !== 1) {
      await writeBranchMigrationAudit(db, ownerPackageId, "blocked", "BACKFILL_SENTINEL_FAILED", detail, now);
    }
  }
}

async function ensureProjectPackageSchema() {
  const db = database();
  if (!schemaBootstrap) {
    schemaBootstrap = (async () => {
      await db.batch(RUNTIME_SCHEMA.map((sql) => db.prepare(sql)));
      await addColumnIfMissing(db, "article_branches", "head_revision_id", "TEXT NOT NULL DEFAULT ''");
      await addColumnIfMissing(db, "article_branches", "base_revision_id", "TEXT NOT NULL DEFAULT ''");
      await addColumnIfMissing(db, "branch_working_copies", "lock_version", "INTEGER NOT NULL DEFAULT 1");
      await addColumnIfMissing(db, "article_project_packages", "primary_branch_id", "TEXT");
      await addColumnIfMissing(db, "article_project_packages", "branch_model_version", "INTEGER");
      await addColumnIfMissing(db, "package_working_copies", "branch_id", "TEXT");
      await addColumnIfMissing(db, "package_working_copies", "base_revision_id", "TEXT");
      await addColumnIfMissing(db, "package_patch_proposals", "branch_id", "TEXT");
      await addColumnIfMissing(db, "package_patch_proposals", "base_revision_id", "TEXT");
      await addColumnIfMissing(db, "package_patch_proposals", "base_package_lock_version", "INTEGER");
      await addColumnIfMissing(db, "package_patch_proposals", "base_branch_lock_version", "INTEGER");
      await addColumnIfMissing(db, "package_patch_proposals", "decided_by_kind", "TEXT");
      await addColumnIfMissing(db, "package_patch_proposals", "decided_by_id", "TEXT");
      await addColumnIfMissing(db, "package_slices", "branch_id", "TEXT");
      await addColumnIfMissing(db, "package_slices", "base_revision_id", "TEXT");
      await addColumnIfMissing(db, "package_slices", "base_branch_lock_version", "INTEGER");
      await addColumnIfMissing(db, "package_diagnosis_runs", "branch_id", "TEXT");
      await addColumnIfMissing(db, "package_diagnosis_runs", "base_revision_id", "TEXT");
      await addColumnIfMissing(db, "package_diagnosis_runs", "base_branch_lock_version", "INTEGER");
      await addColumnIfMissing(db, "package_diagnostic_issues", "branch_id", "TEXT");
      await addColumnIfMissing(db, "package_import_runs", "branch_id", "TEXT");
      await addColumnIfMissing(db, "package_import_runs", "base_revision_id", "TEXT");
      await addColumnIfMissing(db, "package_import_runs", "base_branch_lock_version", "INTEGER");
      await addColumnIfMissing(db, "package_export_runs", "branch_id", "TEXT");
      await addColumnIfMissing(db, "package_export_runs", "base_revision_id", "TEXT");
      await addColumnIfMissing(db, "package_export_runs", "base_branch_lock_version", "INTEGER");
      await db.prepare("DROP INDEX IF EXISTS idx_package_materializations_branch_composition").run();
      await db.batch(RUNTIME_INDEXES.map((sql) => db.prepare(sql)));
      await migrateLegacyPackageBranches(db);
    })()
      .catch((error) => { schemaBootstrap = null; throw error; });
  }
  await schemaBootstrap;
  return db;
}

async function inspectReceipt(db: D1Database, commandId: string, commandType: string, actorId: string, requestSha256: string) {
  const row = await db.prepare("SELECT * FROM command_receipts WHERE id = ? LIMIT 1").bind(commandId).first<D1Row>();
  if (!row) return null;
  if (row.command_type !== commandType || row.actor_id !== actorId || row.request_sha256 !== requestSha256) {
    throw new ProjectPackageApiError("COMMAND_ID_REUSED", "同一 commandId 已绑定不同动作、身份或请求摘要", 409);
  }
  if (Number(row.status_code) === 0) throw new ProjectPackageApiError("COMMAND_IN_PROGRESS", "同一命令仍在处理或需要恢复审计", 409);
  const saved = parseJson<{ data?: JsonObject; error?: { code?: string; message?: string; details?: JsonObject } }>(row.response_json, {});
  if (Number(row.status_code) >= 400) {
    throw new ProjectPackageApiError(
      cleanText(saved.error?.code, 120) || "COMMAND_FAILED",
      cleanText(saved.error?.message, 2_000) || "该幂等命令此前已经失败",
      Number(row.status_code),
      saved.error?.details,
    );
  }
  return { status: Number(row.status_code), data: saved.data ?? {} };
}

async function withReceipt(
  db: D1Database,
  action: string,
  actorId: string,
  commandId: string,
  payload: JsonObject,
  handler: (requestSha256: string) => Promise<MutationResult>,
) {
  const commandType = `project_package.v1.${action}`;
  const requestSha256 = await sha256Text(canonicalJson({ action, actorId, payload }));
  const replay = await inspectReceipt(db, commandId, commandType, actorId, requestSha256);
  if (replay) return { ...replay, replayed: true };
  try {
    await db.prepare(`INSERT INTO command_receipts
      (id, command_type, actor_id, request_sha256, response_json, status_code)
      VALUES (?, ?, ?, ?, '{}', 0)`).bind(commandId, commandType, actorId, requestSha256).run();
  } catch {
    const raced = await inspectReceipt(db, commandId, commandType, actorId, requestSha256);
    if (raced) return { ...raced, replayed: true };
    throw new ProjectPackageApiError("COMMAND_IN_PROGRESS", "命令领取发生竞争，请稍后重试", 409);
  }
  try {
    const result = await handler(requestSha256);
    const status = result.status ?? 200;
    await db.prepare(`UPDATE command_receipts SET response_json = ?, status_code = ?, completed_at = ?
      WHERE id = ? AND command_type = ? AND actor_id = ? AND request_sha256 = ? AND status_code = 0`)
      .bind(canonicalJson({ data: result.data }), status, isoNow(), commandId, commandType, actorId, requestSha256).run();
    return { status, data: result.data, replayed: false };
  } catch (error) {
    const failure = error instanceof ProjectPackageApiError
      ? error
      : new ProjectPackageApiError("INTERNAL_ERROR", "文章工程中台处理失败", 500);
    await db.prepare(`UPDATE command_receipts SET response_json = ?, status_code = ?, completed_at = ?
      WHERE id = ? AND command_type = ? AND actor_id = ? AND request_sha256 = ? AND status_code = 0`)
      .bind(
        canonicalJson({ error: { code: failure.code, message: failure.message, details: failure.details } }),
        failure.status, isoNow(), commandId, commandType, actorId, requestSha256,
      ).run();
    throw failure;
  }
}

function selectedGuidanceBindings(
  root: D1Row,
  selected: Awaited<ReturnType<typeof loadSelectedPackageBranch>>,
  baselineChecklistSha256: string,
): ArticleGuidanceDecisionBindings {
  return {
    articleId: String(root.article_id),
    projectId: root.project_id === null ? null : String(root.project_id),
    packageId: String(root.id),
    branchId: selected.branchId,
    revisionId: selected.branchBridge.headRevisionId,
    bodySha256: selected.branchBridge.headBodySha256,
    compositionId: String(selected.composition.id),
    compositionSha256: String(selected.composition.composition_sha256),
    documentSha256: selected.workingCopy.documentSha256,
    packageLockVersion: Number(root.lock_version),
    branchLockVersion: selected.branchState.lockVersion,
    workingCopyLockVersion: selected.workingCopy.lockVersion,
    baselineChecklistSha256,
  };
}

function boundedLimit(url: URL, fallback = 30) {
  const raw = url.searchParams.get("limit");
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_LIST_LIMIT) {
    throw new ProjectPackageApiError("INVALID_LIMIT", `limit 必须是 1 到 ${MAX_LIST_LIMIT} 之间的整数`);
  }
  return parsed;
}

function parsePackageRow(row: D1Row) {
  return {
    id: String(row.id), projectId: row.project_id === null ? null : String(row.project_id), articleId: String(row.article_id),
    title: String(row.title), schemaVersion: String(row.schema_version),
    branchModelVersion: row.branch_model_version === null ? null : Number(row.branch_model_version),
    primaryBranchId: row.primary_branch_id === null ? null : String(row.primary_branch_id),
    mainCompositionId: String(row.main_composition_id),
    mainCompositionSha256: String(row.main_composition_sha256), status: String(row.status), lockVersion: Number(row.lock_version),
    createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  };
}

function parseWorkingRow(row: D1Row) {
  return {
    packageId: String(row.package_id), branchId: row.branch_id === null ? null : String(row.branch_id),
    baseCompositionId: String(row.base_composition_id), baseRevisionId: row.base_revision_id === null ? null : String(row.base_revision_id),
    document: parseJson<PackageDocument>(row.document_json, {} as PackageDocument), documentSha256: String(row.document_sha256),
    dirty: Number(row.dirty) === 1, lockVersion: Number(row.lock_version), updatedAt: String(row.updated_at),
  };
}

function parseMaterializationRow(row: D1Row) {
  return {
    id: String(row.id), packageId: String(row.package_id), branchId: String(row.branch_id),
    compositionId: String(row.composition_id), compositionSha256: String(row.composition_sha256),
    articleRevisionId: String(row.article_revision_id), articleBodySha256: String(row.article_body_sha256),
    rendererKey: String(row.renderer_key), rendererVersion: String(row.renderer_version),
    createdByKind: String(row.created_by_kind), createdAt: String(row.created_at),
  };
}

function parseBranchStateRow(row: D1Row) {
  return {
    packageId: String(row.package_id), branchId: String(row.branch_id),
    headCompositionId: String(row.head_composition_id), headCompositionSha256: String(row.head_composition_sha256),
    headRevisionId: String(row.head_revision_id), status: String(row.status), lockVersion: Number(row.lock_version),
    createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  };
}

function parseBranchWorkingRow(row: D1Row, includeDocument: true): {
  packageId: string; branchId: string; baseCompositionId: string; baseRevisionId: string;
  documentSha256: string; dirty: boolean; lockVersion: number; updatedAt: string; document: PackageDocument;
};
function parseBranchWorkingRow(row: D1Row, includeDocument: false): {
  packageId: string; branchId: string; baseCompositionId: string; baseRevisionId: string;
  documentSha256: string; dirty: boolean; lockVersion: number; updatedAt: string;
};
function parseBranchWorkingRow(row: D1Row, includeDocument?: boolean): {
  packageId: string; branchId: string; baseCompositionId: string; baseRevisionId: string;
  documentSha256: string; dirty: boolean; lockVersion: number; updatedAt: string; document?: PackageDocument;
};
function parseBranchWorkingRow(row: D1Row, includeDocument = true) {
  const base = {
    packageId: String(row.package_id), branchId: String(row.branch_id),
    baseCompositionId: String(row.base_composition_id), baseRevisionId: String(row.base_revision_id),
    documentSha256: String(row.document_sha256), dirty: Number(row.dirty) === 1,
    lockVersion: Number(row.lock_version), updatedAt: String(row.updated_at),
  };
  return includeDocument ? { ...base, document: parseJson<PackageDocument>(row.document_json, {} as PackageDocument) } : base;
}

function parseBranchCommitRow(row: D1Row) {
  return {
    id: String(row.id), packageId: String(row.package_id), branchId: String(row.branch_id),
    parentCompositionId: row.parent_composition_id === null ? null : String(row.parent_composition_id),
    compositionId: String(row.composition_id), compositionSha256: String(row.composition_sha256),
    previousRevisionId: row.previous_revision_id === null ? null : String(row.previous_revision_id),
    articleRevisionId: String(row.article_revision_id), sourceKind: String(row.source_kind),
    sourcePatchId: row.source_patch_id === null ? null : String(row.source_patch_id),
    createdByKind: String(row.created_by_kind), createdAt: String(row.created_at),
  };
}

function parseMigrationAuditRow(row: D1Row) {
  return {
    packageId: String(row.package_id), state: String(row.state), reasonCode: String(row.reason_code),
    detail: parseJson<JsonObject>(row.detail_json, {}), sourceSchemaVersion: String(row.source_schema_version),
    createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  };
}

function parseCompositionRow(row: D1Row, detail: true): {
  id: string; packageId: string; parentCompositionId: string | null; title: string; schemaVersion: string;
  rootModuleId: string; documentSha256: string; compositionSha256: string; sourceArticleRevisionId: string | null;
  authorKind: string; sourcePatchId: string | null; createdAt: string; document: PackageDocument; manifest: JsonObject;
};
function parseCompositionRow(row: D1Row, detail: false): {
  id: string; packageId: string; parentCompositionId: string | null; title: string; schemaVersion: string;
  rootModuleId: string; documentSha256: string; compositionSha256: string; sourceArticleRevisionId: string | null;
  authorKind: string; sourcePatchId: string | null; createdAt: string;
};
function parseCompositionRow(row: D1Row, detail?: boolean): {
  id: string; packageId: string; parentCompositionId: string | null; title: string; schemaVersion: string;
  rootModuleId: string; documentSha256: string; compositionSha256: string; sourceArticleRevisionId: string | null;
  authorKind: string; sourcePatchId: string | null; createdAt: string; document?: PackageDocument; manifest?: JsonObject;
};
function parseCompositionRow(row: D1Row, detail = false) {
  const base = {
    id: String(row.id), packageId: String(row.package_id),
    parentCompositionId: row.parent_composition_id === null ? null : String(row.parent_composition_id),
    title: String(row.title), schemaVersion: String(row.schema_version), rootModuleId: String(row.root_module_id),
    documentSha256: String(row.document_sha256), compositionSha256: String(row.composition_sha256),
    sourceArticleRevisionId: row.source_article_revision_id === null ? null : String(row.source_article_revision_id),
    authorKind: String(row.author_kind), sourcePatchId: row.source_patch_id === null ? null : String(row.source_patch_id),
    createdAt: String(row.created_at),
  };
  return detail
    ? { ...base, document: parseJson<PackageDocument>(row.document_json, {} as PackageDocument), manifest: parseJson<JsonObject>(row.manifest_json, {}) }
    : base;
}

function parseModuleRow(row: D1Row) {
  return {
    id: String(row.id), packageId: String(row.package_id), moduleKey: String(row.module_key), moduleKind: String(row.module_kind),
    schemaKey: String(row.schema_key), schemaVersion: String(row.schema_version), createdAt: String(row.created_at),
  };
}

function parseModuleRevisionRow(row: D1Row, includeContent = false) {
  const base = {
    id: String(row.id), packageId: String(row.package_id), moduleId: String(row.module_id),
    parentRevisionId: row.parent_revision_id === null ? null : String(row.parent_revision_id), title: String(row.title),
    contentFormat: String(row.content_format), contentSha256: String(row.content_sha256),
    metadata: parseJson<JsonObject>(row.metadata_json, {}), revisionSha256: String(row.revision_sha256),
    authorKind: String(row.author_kind), sourcePatchId: row.source_patch_id === null ? null : String(row.source_patch_id),
    createdAt: String(row.created_at),
  };
  if (!includeContent) return base;
  return String(row.content_format) === "json"
    ? { ...base, content: parseJson<JsonObject>(row.content_json, {}) }
    : { ...base, contentText: String(row.content_text) };
}

function parseNodeRow(row: D1Row) {
  return {
    id: String(row.id), packageId: String(row.package_id), compositionId: String(row.composition_id),
    moduleId: String(row.module_id), moduleRevisionId: String(row.module_revision_id), nodeKey: String(row.node_key),
    slot: String(row.slot), ordinal: Number(row.ordinal), required: Number(row.required) === 1,
    config: parseJson<JsonObject>(row.config_json, {}),
  };
}

function parseEdgeRow(row: D1Row) {
  return {
    id: String(row.id), packageId: String(row.package_id), compositionId: String(row.composition_id), edgeKey: String(row.edge_key),
    sourceNodeId: String(row.source_node_id), targetNodeId: String(row.target_node_id), relationType: String(row.relation_type),
    ordinal: Number(row.ordinal), condition: parseJson<JsonObject>(row.condition_json, {}), edgeSha256: String(row.edge_sha256),
  };
}

function parseSliceRow(row: D1Row, detail = false) {
  const base = {
    id: String(row.id), packageId: String(row.package_id),
    branchId: row.branch_id === null ? null : String(row.branch_id),
    baseRevisionId: row.base_revision_id === null ? null : String(row.base_revision_id),
    baseBranchLockVersion: row.base_branch_lock_version === null ? null : Number(row.base_branch_lock_version),
    compositionId: String(row.composition_id),
    compositionSha256: String(row.composition_sha256), title: String(row.title), sliceKind: String(row.slice_kind),
    sliceSha256: String(row.slice_sha256), createdByKind: String(row.created_by_kind), createdAt: String(row.created_at),
  };
  return detail ? {
    ...base, selector: parseJson<JsonObject>(row.selector_json, {}),
    resolvedManifest: parseJson<JsonObject>(row.resolved_manifest_json, {}),
  } : base;
}

function parsePatchRow(row: D1Row, detail = false) {
  const base = {
    id: String(row.id), packageId: String(row.package_id), baseCompositionId: String(row.base_composition_id),
    baseCompositionSha256: String(row.base_composition_sha256),
    branchId: row.branch_id === null ? null : String(row.branch_id),
    baseRevisionId: row.base_revision_id === null ? null : String(row.base_revision_id),
    basePackageLockVersion: row.base_package_lock_version === null ? null : Number(row.base_package_lock_version),
    baseBranchLockVersion: row.base_branch_lock_version === null ? null : Number(row.base_branch_lock_version),
    taskId: row.task_id === null ? null : String(row.task_id),
    attemptId: row.attempt_id === null ? null : String(row.attempt_id), contextSha256: row.context_sha256 === null ? null : String(row.context_sha256),
    title: String(row.title), summary: String(row.summary), patchSha256: String(row.patch_sha256), status: String(row.status),
    lockVersion: Number(row.lock_version), createdByKind: String(row.created_by_kind), createdById: String(row.created_by_id),
    decisionNote: String(row.decision_note),
    decidedByKind: row.decided_by_kind === null ? null : String(row.decided_by_kind),
    decidedById: row.decided_by_id === null ? null : String(row.decided_by_id),
    appliedCompositionId: row.applied_composition_id === null ? null : String(row.applied_composition_id),
    createdAt: String(row.created_at), reviewedAt: row.reviewed_at === null ? null : String(row.reviewed_at),
    appliedAt: row.applied_at === null ? null : String(row.applied_at),
  };
  return detail ? {
    ...base, operations: parseJson<PackagePatchOperation[]>(row.operations_json, []),
    evidence: parseJson<string[]>(row.evidence_json, []), diagnosticIssueIds: parseJson<string[]>(row.diagnostic_issue_ids_json, []),
  } : base;
}

function parseDiagnosisRunRow(row: D1Row) {
  return {
    id: String(row.id), packageId: String(row.package_id),
    branchId: row.branch_id === null ? null : String(row.branch_id),
    baseRevisionId: row.base_revision_id === null ? null : String(row.base_revision_id),
    baseBranchLockVersion: row.base_branch_lock_version === null ? null : Number(row.base_branch_lock_version),
    compositionId: String(row.composition_id),
    compositionSha256: String(row.composition_sha256), algorithmVersion: String(row.algorithm_version), result: String(row.result),
    issueCount: Number(row.issue_count), errorCount: Number(row.error_count), warningCount: Number(row.warning_count),
    inputSha256: String(row.input_sha256), summarySha256: String(row.summary_sha256), createdAt: String(row.created_at),
  };
}

function parseIssueRow(row: D1Row) {
  return {
    id: String(row.id), diagnosisRunId: String(row.diagnosis_run_id), packageId: String(row.package_id),
    branchId: row.branch_id === null ? null : String(row.branch_id),
    compositionId: String(row.composition_id), moduleId: row.module_id === null ? null : String(row.module_id),
    nodeId: row.node_id === null ? null : String(row.node_id), edgeId: row.edge_id === null ? null : String(row.edge_id),
    code: String(row.code), severity: String(row.severity), title: String(row.title), message: String(row.message),
    evidence: parseJson<string[]>(row.evidence_json, []), suggestedPatch: parseJson<PackagePatchOperation[]>(row.suggested_patch_json, []),
    issueSha256: String(row.issue_sha256), createdAt: String(row.created_at),
  };
}

function parsePublicationVersionRow(row: D1Row) {
  const validation = validateArticlePublicationVersion(parseJson<unknown>(row.publication_version_json, null));
  const semanticGateState = semanticGateReadState(validation.version?.semanticGate);
  return {
    id: String(row.id),
    packageId: String(row.package_id),
    articleId: String(row.article_id),
    role: String(row.role),
    versionKey: String(row.version_key),
    platform: row.platform === null ? null : String(row.platform),
    branchId: String(row.branch_id),
    branchLockVersion: Number(row.branch_lock_version),
    revisionId: String(row.revision_id),
    bodySha256: String(row.body_sha256),
    compositionId: String(row.composition_id),
    compositionSha256: String(row.composition_sha256),
    targetProfileId: row.target_profile_id === null ? null : String(row.target_profile_id),
    targetProfileKey: row.target_profile_key === null ? null : String(row.target_profile_key),
    targetProfileSha256: row.target_profile_sha256 === null ? null : String(row.target_profile_sha256),
    baselineVersionId: row.baseline_version_id === null ? null : String(row.baseline_version_id),
    publicationVersion: validation.version,
    semanticGateState,
    registrationSha256: String(row.registration_sha256),
    state: String(row.state),
    lockVersion: Number(row.lock_version),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

async function publicationVersionSnapshot(db: D1Database, ownerPackageId: string) {
  const root = await packageRow(db, ownerPackageId);
  const rows = await db.prepare(`SELECT version.*,
      state.head_composition_id AS current_composition_id,
      state.head_composition_sha256 AS current_composition_sha256,
      state.head_revision_id AS current_revision_id,
      state.lock_version AS current_branch_lock_version,
      state.status AS current_branch_state_status,
      branch.head_revision_id AS article_head_revision_id,
      branch.status AS article_branch_status,
      revision.body_sha256 AS current_body_sha256,
      article_copy.base_revision_id AS article_working_base_revision_id,
      article_copy.body_sha256 AS article_working_body_sha256,
      article_copy.dirty AS article_working_dirty,
      package_copy.base_composition_id AS package_working_base_composition_id,
      package_copy.base_revision_id AS package_working_base_revision_id,
      package_copy.document_sha256 AS package_working_document_sha256,
      package_copy.dirty AS package_working_dirty,
      composition.document_json AS current_document_json,
      composition.document_sha256 AS current_document_sha256,
      composition.composition_sha256 AS stored_composition_sha256,
      materialization.article_revision_id AS materialized_revision_id,
      materialization.article_body_sha256 AS materialized_body_sha256,
      target.id AS current_target_profile_id,
      target.profile_key AS current_target_profile_key,
      target.profile_sha256 AS current_target_profile_sha256,
      target.status AS current_target_status,
      target.connection_mode AS current_target_connection_mode,
      COALESCE(json_extract(target.profile_json, '$.enabled'), 1) AS current_target_enabled
    FROM article_publication_versions version
    LEFT JOIN package_branch_states state
      ON state.package_id = version.package_id AND state.branch_id = version.branch_id
    LEFT JOIN article_branches branch
      ON branch.id = version.branch_id AND branch.article_id = version.article_id
    LEFT JOIN article_revisions revision
      ON revision.id = branch.head_revision_id AND revision.branch_id = branch.id AND revision.article_id = version.article_id
    LEFT JOIN branch_working_copies article_copy
      ON article_copy.branch_id = branch.id AND article_copy.article_id = version.article_id
    LEFT JOIN package_branch_working_copies package_copy
      ON package_copy.package_id = version.package_id AND package_copy.branch_id = version.branch_id
    LEFT JOIN package_compositions composition
      ON composition.id = state.head_composition_id AND composition.package_id = version.package_id
    LEFT JOIN package_composition_materializations materialization
      ON materialization.package_id = version.package_id AND materialization.branch_id = version.branch_id
      AND materialization.composition_id = state.head_composition_id
      AND materialization.article_revision_id = state.head_revision_id
    LEFT JOIN lifecycle_platform_targets target ON target.id = version.target_profile_id
    WHERE version.package_id = ? AND version.state = 'active'
    ORDER BY CASE version.version_key WHEN 'canonical' THEN 0 ELSE 1 END, version.version_key`)
    .bind(ownerPackageId).all<D1Row>();
  const evaluated = rows.results.map((row) => {
    const parsed = parsePublicationVersionRow(row);
    const blockers: string[] = [];
    if (!parsed.publicationVersion) blockers.push("publication_version_invalid");
    if (String(row.current_branch_state_status ?? "") !== "active") blockers.push("package_branch_not_active");
    if (String(row.article_branch_status ?? "") !== "active") blockers.push("article_branch_not_active");
    if (Number(row.current_branch_lock_version ?? 0) !== parsed.branchLockVersion
      || row.current_composition_id !== parsed.compositionId
      || row.current_composition_sha256 !== parsed.compositionSha256
      || row.current_revision_id !== parsed.revisionId) blockers.push("package_branch_head_changed");
    if (row.article_head_revision_id !== parsed.revisionId || row.current_body_sha256 !== parsed.bodySha256) {
      blockers.push("article_revision_changed");
    }
    if (Number(row.article_working_dirty ?? 1) !== 0
      || row.article_working_base_revision_id !== parsed.revisionId
      || row.article_working_body_sha256 !== parsed.bodySha256) blockers.push("article_working_copy_not_clean_head");
    if (Number(row.package_working_dirty ?? 1) !== 0
      || row.package_working_base_composition_id !== parsed.compositionId
      || row.package_working_base_revision_id !== parsed.revisionId) blockers.push("package_working_copy_not_clean_head");
    if (row.stored_composition_sha256 !== parsed.compositionSha256
      || row.materialized_revision_id !== parsed.revisionId
      || row.materialized_body_sha256 !== parsed.bodySha256) blockers.push("composition_materialization_changed");
    const documentValidation = publicationVersionFromDocument(parseJson<unknown>(row.current_document_json, null));
    if (!documentValidation.valid || !documentValidation.version
      || canonicalJson(documentValidation.version) !== canonicalJson(parsed.publicationVersion)) {
      blockers.push("composition_publication_version_changed");
    }
    if (parsed.role === "canonical_baseline"
      && (root.primary_branch_id !== parsed.branchId
        || root.main_composition_id !== parsed.compositionId
        || root.main_composition_sha256 !== parsed.compositionSha256)) blockers.push("canonical_is_not_package_primary");
    if (parsed.role === "platform_variant"
      && (row.current_target_profile_id !== parsed.targetProfileId
        || row.current_target_profile_key !== parsed.targetProfileKey
        || row.current_target_profile_sha256 !== parsed.targetProfileSha256
        || row.current_target_status !== "active"
        || row.current_target_connection_mode !== "manual"
        || Number(row.current_target_enabled ?? 0) === 0)) blockers.push("target_profile_changed");
    return { ...parsed, currentness: blockers.length === 0 ? "current" : "stale", blockers };
  });
  const canonical = evaluated.find((item) => item.versionKey === "canonical") ?? null;
  for (const item of evaluated) {
    if (item.role !== "platform_variant" || !item.publicationVersion || item.publicationVersion.role !== "platform_variant") continue;
    const baseline = item.publicationVersion.baseline;
    if (!canonical
      || item.baselineVersionId !== canonical.id
      || baseline.branchId !== canonical.branchId
      || baseline.revisionId !== canonical.revisionId
      || baseline.bodySha256 !== canonical.bodySha256
      || baseline.compositionId !== canonical.compositionId
      || baseline.compositionSha256 !== canonical.compositionSha256
      || canonical.currentness !== "current") {
      item.blockers.push("canonical_baseline_changed");
      item.currentness = "stale";
    }
  }
  const setInput = evaluated.flatMap((item) => item.publicationVersion ? [{
    id: item.id,
    packageId: item.packageId,
    articleId: item.articleId,
    branchId: item.branchId,
    revisionId: item.revisionId,
    bodySha256: item.bodySha256,
    compositionId: item.compositionId,
    compositionSha256: item.compositionSha256,
    publicationVersion: item.publicationVersion,
  }] : []);
  const setValidation = validateArticlePublicationVersionSet(setInput);
  const variants = Object.fromEntries(ARTICLE_PUBLICATION_PLATFORMS.map((platform) => [
    platform,
    evaluated.find((item) => item.versionKey === platform) ?? null,
  ]));
  const currentComplete = Boolean(setValidation.complete && canonical?.currentness === "current"
    && ARTICLE_PUBLICATION_PLATFORMS.every((platform) => variants[platform]?.currentness === "current"));
  return {
    package: parsePackageRow(root),
    schemaVersion: "wenmai.article-publication-version-set/1.0.0",
    canonical,
    variants,
    versions: evaluated,
    requiredVersionKeys: ["canonical", ...ARTICLE_PUBLICATION_PLATFORMS],
    valid: setValidation.valid,
    errors: setValidation.errors,
    missingVersionKeys: setValidation.missingVersionKeys,
    complete: currentComplete,
  };
}

function parseImportRow(row: D1Row, detail = false) {
  const base = {
    id: String(row.id), packageId: String(row.package_id),
    branchId: row.branch_id === null ? null : String(row.branch_id),
    baseRevisionId: row.base_revision_id === null ? null : String(row.base_revision_id),
    baseBranchLockVersion: row.base_branch_lock_version === null ? null : Number(row.base_branch_lock_version),
    baseCompositionId: String(row.base_composition_id),
    baseCompositionSha256: String(row.base_composition_sha256), sourceKind: String(row.source_kind), sourceRef: String(row.source_ref),
    sourceFingerprintSha256: String(row.source_fingerprint_sha256), importerKey: String(row.importer_key),
    importerVersion: String(row.importer_version), manifestSha256: String(row.manifest_sha256),
    patchProposalId: String(row.patch_proposal_id), state: String(row.state), lockVersion: Number(row.lock_version),
    errorSummary: String(row.error_summary), createdAt: String(row.created_at), finishedAt: row.finished_at === null ? null : String(row.finished_at),
  };
  return detail ? { ...base, manifest: parseJson<JsonObject>(row.manifest_json, {}) } : base;
}

function parseExportRow(row: D1Row, detail = false) {
  const base = {
    id: String(row.id), packageId: String(row.package_id),
    branchId: row.branch_id === null ? null : String(row.branch_id),
    baseRevisionId: row.base_revision_id === null ? null : String(row.base_revision_id),
    baseBranchLockVersion: row.base_branch_lock_version === null ? null : Number(row.base_branch_lock_version),
    compositionId: String(row.composition_id),
    compositionSha256: String(row.composition_sha256), sliceId: row.slice_id === null ? null : String(row.slice_id),
    sliceSha256: row.slice_sha256 === null ? null : String(row.slice_sha256), exportKind: String(row.export_kind),
    exporterKey: String(row.exporter_key), exporterVersion: String(row.exporter_version), manifestSha256: String(row.manifest_sha256),
    artifactRef: String(row.artifact_ref), artifactSha256: String(row.artifact_sha256), artifactMediaType: String(row.artifact_media_type),
    state: String(row.state), lockVersion: Number(row.lock_version), failureSummary: String(row.failure_summary),
    createdAt: String(row.created_at), verifiedAt: row.verified_at === null ? null : String(row.verified_at),
  };
  return detail ? { ...base, manifest: parseJson<JsonObject>(row.manifest_json, {}) } : base;
}

async function packageRow(db: D1Database, id: string) {
  const row = await db.prepare("SELECT * FROM article_project_packages WHERE id = ? LIMIT 1").bind(id).first<D1Row>();
  if (!row) throw new ProjectPackageApiError("PACKAGE_NOT_FOUND", "ArticleProjectPackage 不存在", 404, { packageId: id });
  return row;
}

async function workingRow(db: D1Database, id: string) {
  const row = await db.prepare("SELECT * FROM package_working_copies WHERE package_id = ? LIMIT 1").bind(id).first<D1Row>();
  if (!row) throw new ProjectPackageApiError("WORKING_COPY_NOT_FOUND", "Package 工作副本不存在", 404, { packageId: id });
  return row;
}

async function migrationAuditRow(db: D1Database, ownerPackageId: string) {
  return db.prepare("SELECT * FROM package_branch_migration_audits WHERE package_id = ? LIMIT 1")
    .bind(ownerPackageId).first<D1Row>();
}

async function selectedBranchRows(db: D1Database, root: D1Row, requestedBranchId?: string, forWrite = false) {
  const audit = await migrationAuditRow(db, String(root.id));
  if (forWrite && audit?.state === "blocked") {
    throw new ProjectPackageApiError("PACKAGE_BRANCH_MIGRATION_REQUIRED", "Package 多分支迁移审计被阻断；当前仅允许只读检查，禁止猜测写入", 409, {
      packageId: root.id, migrationAudit: parseMigrationAuditRow(audit),
    });
  }
  if (forWrite && (audit?.state === "legacy_unbound" || !root.primary_branch_id)) {
    throw new ProjectPackageApiError("PACKAGE_BRANCH_REQUIRED", "Package 尚未绑定 ArticleBranch；请先显式接入分支", 428, {
      packageId: root.id, migrationAudit: audit ? parseMigrationAuditRow(audit) : null,
    });
  }
  if (forWrite && Number(root.branch_model_version) !== 2) {
    throw new ProjectPackageApiError("PACKAGE_BRANCH_MIGRATION_REQUIRED", "Package 尚未完成 0010 分支状态迁移", 409, {
      packageId: root.id, migrationAudit: audit ? parseMigrationAuditRow(audit) : null,
    });
  }
  const branchId = requestedBranchId || (root.primary_branch_id ? String(root.primary_branch_id) : "");
  if (!branchId) {
    throw new ProjectPackageApiError("PACKAGE_BRANCH_REQUIRED", "必须指定已接入的 ArticleBranch", 428, {
      packageId: root.id, migrationAudit: audit ? parseMigrationAuditRow(audit) : null,
    });
  }
  const row = await db.prepare(`SELECT state.*,
      package_copy.base_composition_id AS package_base_composition_id,
      package_copy.base_revision_id AS package_base_revision_id,
      package_copy.document_json AS package_document_json,
      package_copy.document_sha256 AS package_document_sha256,
      package_copy.dirty AS package_dirty, package_copy.lock_version AS package_working_lock_version,
      package_copy.updated_at AS package_working_updated_at,
      composition.id AS composition_record_id, composition.composition_sha256 AS composition_record_sha256,
      composition.document_sha256 AS composition_document_sha256,
      branch.article_id AS branch_article_id, branch.name AS branch_name, branch.slug AS branch_slug,
      branch.status AS article_branch_status, branch.head_revision_id AS article_head_revision_id,
      revision.id AS revision_record_id, revision.body_sha256 AS article_head_body_sha256,
      revision.document_title AS article_head_document_title,
      article_copy.base_revision_id AS article_working_base_revision_id,
      article_copy.body_sha256 AS article_working_body_sha256,
      article_copy.dirty AS article_working_dirty, article_copy.lock_version AS article_working_lock_version,
      materialization.id AS materialization_id, materialization.composition_id AS materialization_composition_id,
      materialization.article_revision_id AS materialization_revision_id,
      materialization.composition_sha256 AS materialization_composition_sha256,
      materialization.article_body_sha256 AS materialization_body_sha256,
      commit_ref.id AS branch_commit_id, commit_ref.parent_composition_id AS commit_parent_composition_id,
      commit_ref.composition_id AS commit_composition_id, commit_ref.composition_sha256 AS commit_composition_sha256,
      commit_ref.article_revision_id AS commit_article_revision_id,
      commit_ref.previous_revision_id AS commit_previous_revision_id, commit_ref.source_kind AS commit_source_kind,
      commit_ref.source_patch_id AS commit_source_patch_id, commit_ref.created_by_kind AS commit_created_by_kind,
      commit_ref.created_at AS commit_created_at
    FROM package_branch_states state
    JOIN package_branch_working_copies package_copy
      ON package_copy.package_id = state.package_id AND package_copy.branch_id = state.branch_id
    JOIN package_compositions composition
      ON composition.id = state.head_composition_id AND composition.package_id = state.package_id
    JOIN article_branches branch ON branch.id = state.branch_id
    JOIN article_revisions revision
      ON revision.id = state.head_revision_id AND revision.branch_id = state.branch_id
      AND revision.article_id = branch.article_id
    JOIN branch_working_copies article_copy
      ON article_copy.branch_id = state.branch_id AND article_copy.article_id = branch.article_id
    LEFT JOIN package_composition_materializations materialization
      ON materialization.package_id = state.package_id AND materialization.branch_id = state.branch_id
      AND materialization.article_revision_id = state.head_revision_id
    LEFT JOIN package_branch_composition_commits commit_ref
      ON commit_ref.package_id = state.package_id AND commit_ref.branch_id = state.branch_id
      AND commit_ref.article_revision_id = state.head_revision_id
    WHERE state.package_id = ? AND state.branch_id = ? LIMIT 1`)
    .bind(root.id, branchId).first<D1Row>();
  if (!row) {
    throw new ProjectPackageApiError("PACKAGE_BRANCH_NOT_ATTACHED", "该 ArticleBranch 尚未接入当前 Package", 404, {
      packageId: root.id, branchId, migrationAudit: audit ? parseMigrationAuditRow(audit) : null,
    });
  }
  const packageWorkingClean = Number(row.package_dirty) === 0
    && row.package_document_sha256 === row.composition_document_sha256;
  const packageWorkingDraft = Number(row.package_dirty) === 1
    && row.package_document_sha256 !== row.composition_document_sha256;
  const inSync = row.branch_article_id === root.article_id
    && row.article_head_revision_id === row.head_revision_id
    && row.revision_record_id === row.head_revision_id
    && row.package_base_composition_id === row.head_composition_id
    && row.package_base_revision_id === row.head_revision_id
    && (packageWorkingClean || packageWorkingDraft)
    && row.composition_record_id === row.head_composition_id
    && row.composition_record_sha256 === row.head_composition_sha256
    && row.article_working_base_revision_id === row.head_revision_id
    && Number(row.article_working_dirty) === 0
    && row.article_working_body_sha256 === row.article_head_body_sha256
    && row.materialization_composition_id === row.head_composition_id
    && row.materialization_revision_id === row.head_revision_id
    && row.materialization_composition_sha256 === row.head_composition_sha256
    && row.materialization_body_sha256 === row.article_head_body_sha256
    && row.commit_composition_id === row.head_composition_id
    && row.commit_composition_sha256 === row.head_composition_sha256
    && row.commit_article_revision_id === row.head_revision_id;
  if (forWrite && (!inSync || row.status !== "active" || row.article_branch_status !== "active")) {
    throw new ProjectPackageApiError("PACKAGE_BRANCH_STATE_STALE", "Package 分支状态、ArticleBranch 或两份工作副本不在同一基线", 409, {
      packageId: root.id, branchId, inSync, branchStatus: row.status, articleBranchStatus: row.article_branch_status,
    });
  }
  return { row, audit, branchId, inSync };
}

function branchWorkingFromJoinedRow(row: D1Row) {
  return parseBranchWorkingRow({
    package_id: row.package_id, branch_id: row.branch_id,
    base_composition_id: row.package_base_composition_id, base_revision_id: row.package_base_revision_id,
    document_json: row.package_document_json, document_sha256: row.package_document_sha256,
    dirty: row.package_dirty, lock_version: row.package_working_lock_version, updated_at: row.package_working_updated_at,
  }, true);
}

function branchCommitFromJoinedRow(row: D1Row) {
  if (!row.branch_commit_id) return null;
  return parseBranchCommitRow({
    id: row.branch_commit_id, package_id: row.package_id, branch_id: row.branch_id,
    parent_composition_id: row.commit_parent_composition_id, composition_id: row.commit_composition_id,
    composition_sha256: row.commit_composition_sha256, previous_revision_id: row.commit_previous_revision_id,
    article_revision_id: row.commit_article_revision_id, source_kind: row.commit_source_kind,
    source_patch_id: row.commit_source_patch_id, created_by_kind: row.commit_created_by_kind, created_at: row.commit_created_at,
  });
}

async function loadSelectedPackageBranch(db: D1Database, root: D1Row, requestedBranchId?: string, forWrite = false) {
  const selected = await selectedBranchRows(db, root, requestedBranchId, forWrite);
  const [composition, materialization] = await Promise.all([
    compositionRow(db, String(selected.row.head_composition_id), String(root.id)),
    db.prepare(`SELECT * FROM package_composition_materializations
      WHERE package_id = ? AND branch_id = ? AND composition_id = ? AND article_revision_id = ? LIMIT 1`)
      .bind(root.id, selected.branchId, selected.row.head_composition_id, selected.row.head_revision_id).first<D1Row>(),
  ]);
  const workingCopy = branchWorkingFromJoinedRow(selected.row);
  return {
    ...selected,
    composition,
    materialization,
    workingCopy,
    branchState: parseBranchStateRow(selected.row),
    branchCommit: branchCommitFromJoinedRow(selected.row),
    branchBridge: {
      packageId: String(root.id), branchId: selected.branchId,
      branchName: String(selected.row.branch_name), branchSlug: String(selected.row.branch_slug),
      branchStatus: String(selected.row.article_branch_status),
      headRevisionId: String(selected.row.head_revision_id), headBodySha256: String(selected.row.article_head_body_sha256),
      workingBaseRevisionId: String(selected.row.article_working_base_revision_id),
      workingCopyDirty: Number(selected.row.article_working_dirty) === 1,
      workingCopyLockVersion: Number(selected.row.article_working_lock_version),
      packageBaseRevisionId: String(selected.row.package_base_revision_id),
      materialization: materialization ? parseMaterializationRow(materialization) : null,
      inSync: selected.inSync,
    },
  };
}

async function compositionRow(db: D1Database, id: string, expectedPackageId?: string) {
  const row = await db.prepare("SELECT * FROM package_compositions WHERE id = ? LIMIT 1").bind(id).first<D1Row>();
  if (!row || (expectedPackageId && row.package_id !== expectedPackageId)) {
    throw new ProjectPackageApiError("COMPOSITION_NOT_FOUND", "Composition 不存在或不属于指定 Package", 404, { compositionId: id });
  }
  return row;
}

async function patchRow(db: D1Database, id: string, expectedPackageId?: string) {
  const row = await db.prepare("SELECT * FROM package_patch_proposals WHERE id = ? LIMIT 1").bind(id).first<D1Row>();
  if (!row || (expectedPackageId && row.package_id !== expectedPackageId)) {
    throw new ProjectPackageApiError("PATCH_NOT_FOUND", "PatchProposal 不存在或不属于指定 Package", 404, { patchProposalId: id });
  }
  return row;
}

function assertPackageCas(row: D1Row, expectedLock: number, expectedCompositionId?: string, expectedSha?: string) {
  if (String(row.status) !== "active") throw new ProjectPackageApiError("PACKAGE_ARCHIVED", "归档 Package 不允许继续写入", 409);
  if (Number(row.lock_version) !== expectedLock) {
    throw new ProjectPackageApiError("PACKAGE_CAS_CONFLICT", "Package lockVersion 已变化", 409, { currentLockVersion: Number(row.lock_version) });
  }
  if (expectedCompositionId && row.main_composition_id !== expectedCompositionId) {
    throw new ProjectPackageApiError("PACKAGE_HEAD_CHANGED", "Package 主 Composition 已变化", 409, { currentCompositionId: row.main_composition_id });
  }
  if (expectedSha && row.main_composition_sha256 !== expectedSha) {
    throw new ProjectPackageApiError("PACKAGE_HEAD_CHANGED", "Package 主 Composition 摘要已变化", 409, { currentCompositionSha256: row.main_composition_sha256 });
  }
}

function assertCompositionSha(row: D1Row, expectedSha: string) {
  if (row.composition_sha256 !== expectedSha) {
    throw new ProjectPackageApiError("COMPOSITION_SHA_MISMATCH", "Composition 摘要与请求基线不一致", 409, {
      compositionId: row.id, currentCompositionSha256: row.composition_sha256,
    });
  }
}

function safeKey(value: unknown, field: string) {
  const key = requiredText(value, field, 120);
  if (!KEY_RE.test(key)) throw new ProjectPackageApiError("INVALID_KEY", `${field} 只能包含字母、数字、点、下划线、冒号或短横线`, 400, { field });
  return key;
}

function safeOptionalId(value: unknown, field: string) {
  const id = optionalText(value, 160);
  if (!id) return "";
  if (!ID_RE.test(id)) throw new ProjectPackageApiError("INVALID_ID", `${field} 格式无效`, 400, { field });
  return id;
}

function safeReference(value: unknown, field: string, maximum = 2_000) {
  const reference = requiredText(value, field, maximum, true);
  if ([...reference].some((character) => character.charCodeAt(0) < 32) || reference.includes("\\") || reference.includes("..")) {
    throw new ProjectPackageApiError("UNSAFE_REFERENCE", `${field} 含有不安全路径片段`, 400, { field });
  }
  return reference;
}

function objectValue(value: unknown, field: string) {
  if (value === undefined || value === null) return {};
  if (!isObject(value)) throw new ProjectPackageApiError("INVALID_FIELD", `${field} 必须是 JSON 对象`, 400, { field });
  assertBoundedJson(value, field, 12, 10_000);
  return canonicalValue(value) as JsonObject;
}

function stringArray(value: unknown, field: string, limit = 100, maximum = 500) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new ProjectPackageApiError("INVALID_FIELD", `${field} 必须是字符串数组`, 400, { field });
  if (value.length > limit) throw new ProjectPackageApiError("FIELD_TOO_LARGE", `${field} 最多 ${limit} 项`, 413, { field });
  return [...new Set(value.map((item) => requiredText(item, field, maximum)))];
}

type PreparedDocument = Omit<PackageDocument, "modules" | "assets" | "sources" | "edges"> & {
  modules: Array<PackageModuleInput & { id: string }>;
  assets: Array<PackageDocument["assets"][number] & { id: string }>;
  sources: Array<PackageDocument["sources"][number] & { id: string }>;
  edges: Array<PackageEdgeInput & { id: string }>;
};

function normalizeModuleInput(value: unknown, index: number) {
  if (!isObject(value)) throw new ProjectPackageApiError("INVALID_MODULE", `modules[${index}] 必须是对象`);
  const key = safeKey(value.key, `modules[${index}].key`);
  const format = optionalText(value.contentFormat, 20) || "markdown";
  if (!CONTENT_FORMATS.has(format)) throw new ProjectPackageApiError("INVALID_CONTENT_FORMAT", `${key} 的 contentFormat 无效`);
  const refsRaw = value.refs ?? [];
  if (!Array.isArray(refsRaw) || refsRaw.length > MAX_REFS_PER_MODULE) {
    throw new ProjectPackageApiError("INVALID_REFS", `${key} 的 refs 必须是不超过 ${MAX_REFS_PER_MODULE} 项的数组`);
  }
  const refs = refsRaw.map((raw, refIndex) => {
    if (!isObject(raw)) throw new ProjectPackageApiError("INVALID_REF", `${key}.refs[${refIndex}] 必须是对象`);
    const refKind = requiredText(raw.refKind, `${key}.refs[${refIndex}].refKind`, 20);
    if (refKind !== "asset" && refKind !== "source") throw new ProjectPackageApiError("INVALID_REF_KIND", "refKind 只能是 asset 或 source");
    return {
      refKind,
      refKey: safeKey(raw.refKey, `${key}.refs[${refIndex}].refKey`),
      relationType: requiredText(raw.relationType, `${key}.refs[${refIndex}].relationType`, 80),
      anchor: objectValue(raw.anchor, `${key}.refs[${refIndex}].anchor`),
    };
  });
  const refIdentities = new Set<string>();
  for (const ref of refs) {
    const identity = canonicalJson([ref.refKind, ref.refKey, ref.relationType]);
    if (refIdentities.has(identity)) throw new ProjectPackageApiError("DUPLICATE_MODULE_REF", `${key} 包含重复资源引用`);
    refIdentities.add(identity);
  }
  const contentText = format === "json" ? "" : optionalText(value.contentText, 2_000_000, true);
  if (contentText.includes("\0")) throw new ProjectPackageApiError("INVALID_TEXT_CONTENT", `${key}.contentText 含有空字符`);
  const content = format === "json" ? objectValue(value.content, `${key}.content`) : undefined;
  return {
    id: safeOptionalId(value.id, `${key}.id`), key,
    kind: requiredText(value.kind, `${key}.kind`, 80), title: requiredText(value.title, `${key}.title`, 300),
    contentFormat: format as "markdown" | "text" | "json", contentText,
    ...(content ? { content } : {}), metadata: objectValue(value.metadata, `${key}.metadata`), refs,
  };
}

function normalizeEdgeInput(value: unknown, index: number) {
  if (!isObject(value)) throw new ProjectPackageApiError("INVALID_EDGE", `edges[${index}] 必须是对象`);
  return {
    id: safeOptionalId(value.id, `edges[${index}].id`), key: safeKey(value.key, `edges[${index}].key`),
    sourceModuleKey: safeKey(value.sourceModuleKey, `edges[${index}].sourceModuleKey`),
    targetModuleKey: safeKey(value.targetModuleKey, `edges[${index}].targetModuleKey`),
    relationType: requiredText(value.relationType, `edges[${index}].relationType`, 80),
    ordinal: value.ordinal === undefined ? 0 : exactInteger(value.ordinal, `edges[${index}].ordinal`, 0, 100_000),
    condition: objectValue(value.condition, `edges[${index}].condition`),
  };
}

async function globallyUsedIds(db: D1Database, table: string, ids: string[]) {
  const uniqueIds = [...new Set(ids.filter(Boolean))];
  if (uniqueIds.length === 0) return new Set<string>();
  const result = await db.prepare(`SELECT id FROM ${table} WHERE id IN (${uniqueIds.map(() => "?").join(", ")})`)
    .bind(...uniqueIds).all<D1Row>();
  return new Set(result.results.map((row: D1Row) => String(row.id)));
}

async function prepareDocument(db: D1Database, ownerPackageId: string, value: unknown, identitySeed?: PackageDocument) {
  if (!isObject(value)) throw new ProjectPackageApiError("INVALID_DOCUMENT", "document 必须是 JSON 对象");
  const schemaVersion = optionalText(value.schemaVersion, 80) || DOCUMENT_SCHEMA_VERSION;
  if (schemaVersion !== DOCUMENT_SCHEMA_VERSION) {
    throw new ProjectPackageApiError("UNSUPPORTED_DOCUMENT_SCHEMA", `只支持 ${DOCUMENT_SCHEMA_VERSION}`);
  }
  if (!Array.isArray(value.modules) || value.modules.length < 1 || value.modules.length > MAX_MODULES) {
    throw new ProjectPackageApiError("INVALID_MODULE_COUNT", `document.modules 必须包含 1 到 ${MAX_MODULES} 个模块`);
  }
  if (!Array.isArray(value.edges) || value.edges.length > MAX_EDGES) {
    throw new ProjectPackageApiError("INVALID_EDGE_COUNT", `document.edges 最多 ${MAX_EDGES} 项`);
  }
  if (!Array.isArray(value.assets) || value.assets.length > MAX_RESOURCES) {
    throw new ProjectPackageApiError("INVALID_ASSET_COUNT", `document.assets 最多 ${MAX_RESOURCES} 项`);
  }
  if (!Array.isArray(value.sources) || value.sources.length > MAX_RESOURCES) {
    throw new ProjectPackageApiError("INVALID_SOURCE_COUNT", `document.sources 最多 ${MAX_RESOURCES} 项`);
  }
  const modules = value.modules.map(normalizeModuleInput);
  const edges = value.edges.map(normalizeEdgeInput);
  const assets = value.assets.map((raw, index) => {
    if (!isObject(raw)) throw new ProjectPackageApiError("INVALID_ASSET", `assets[${index}] 必须是对象`);
    return {
      id: safeOptionalId(raw.id, `assets[${index}].id`), key: safeKey(raw.key, `assets[${index}].key`),
      kind: requiredText(raw.kind, `assets[${index}].kind`, 80), title: requiredText(raw.title, `assets[${index}].title`, 300),
      contentRef: safeReference(raw.contentRef, `assets[${index}].contentRef`), mediaType: requiredText(raw.mediaType, `assets[${index}].mediaType`, 120),
      sha256: exactSha256(raw.sha256, `assets[${index}].sha256`), sizeBytes: exactInteger(raw.sizeBytes, `assets[${index}].sizeBytes`, 0, 2_147_483_647),
      metadata: objectValue(raw.metadata, `assets[${index}].metadata`), rights: objectValue(raw.rights, `assets[${index}].rights`),
    };
  });
  const sources = value.sources.map((raw, index) => {
    if (!isObject(raw)) throw new ProjectPackageApiError("INVALID_SOURCE", `sources[${index}] 必须是对象`);
    const capturedAt = optionalText(raw.capturedAt, 80) || null;
    if (capturedAt && Number.isNaN(Date.parse(capturedAt))) throw new ProjectPackageApiError("INVALID_DATE", `sources[${index}].capturedAt 无效`);
    return {
      id: safeOptionalId(raw.id, `sources[${index}].id`), key: safeKey(raw.key, `sources[${index}].key`),
      sourceKind: requiredText(raw.sourceKind, `sources[${index}].sourceKind`, 80),
      canonicalRef: safeReference(raw.canonicalRef, `sources[${index}].canonicalRef`),
      title: requiredText(raw.title, `sources[${index}].title`, 300), capturedAt,
      contentSha256: optionalSha256(raw.contentSha256, `sources[${index}].contentSha256`),
      excerpt: optionalText(raw.excerpt, 2_000, true), metadata: objectValue(raw.metadata, `sources[${index}].metadata`),
      rights: objectValue(raw.rights, `sources[${index}].rights`),
    };
  });
  const duplicate = <T>(items: T[], key: (item: T) => string) => {
    const seen = new Set<string>();
    for (const item of items) { const current = key(item); if (seen.has(current)) return current; seen.add(current); }
    return "";
  };
  const repeatedModule = duplicate(modules, (item) => item.key);
  const repeatedEdge = duplicate(edges, (item) => item.key);
  const repeatedAsset = duplicate(assets, (item) => item.key);
  const repeatedSource = duplicate(sources, (item) => item.key);
  if (repeatedModule) throw new ProjectPackageApiError("DUPLICATE_KEY", `module key 重复：${repeatedModule}`);
  if (repeatedEdge) throw new ProjectPackageApiError("DUPLICATE_KEY", `edge key 重复：${repeatedEdge}`);
  if (repeatedAsset) throw new ProjectPackageApiError("DUPLICATE_KEY", `asset key 重复：${repeatedAsset}`);
  if (repeatedSource) throw new ProjectPackageApiError("DUPLICATE_KEY", `source key 重复：${repeatedSource}`);
  const totalTextBytes = modules.reduce((sum, module) => sum + new TextEncoder().encode(module.contentText ?? canonicalJson(module.content ?? {})).byteLength, 0);
  if (totalTextBytes > 2_000_000) throw new ProjectPackageApiError("DOCUMENT_TOO_LARGE", "模块内容总量不得超过 2,000,000 字节", 413);
  const totalRefs = modules.reduce((sum, module) => sum + module.refs.length, 0);
  if (totalRefs > MAX_TOTAL_REFS) throw new ProjectPackageApiError("TOO_MANY_RESOURCE_REFS", `document 最多包含 ${MAX_TOTAL_REFS} 个模块资源引用`, 413);

  const [moduleResult, assetResult, sourceResult] = await Promise.all([
    db.prepare("SELECT * FROM package_modules WHERE package_id = ? ORDER BY created_at ASC").bind(ownerPackageId).all<D1Row>(),
    db.prepare("SELECT * FROM package_assets WHERE package_id = ? ORDER BY created_at ASC").bind(ownerPackageId).all<D1Row>(),
    db.prepare("SELECT * FROM package_source_refs WHERE package_id = ? ORDER BY created_at ASC").bind(ownerPackageId).all<D1Row>(),
  ]);
  const moduleRows = new Map<string, D1Row>(moduleResult.results.map((row: D1Row) => [String(row.module_key), row]));
  const assetRows = new Map<string, D1Row>(assetResult.results.map((row: D1Row) => [String(row.asset_key), row]));
  const sourceRows = new Map<string, D1Row>(sourceResult.results.map((row: D1Row) => [String(row.source_key), row]));
  const seedModules = new Map((identitySeed?.modules ?? []).map((item) => [item.key, item.id ?? ""]));
  const seedAssets = new Map((identitySeed?.assets ?? []).map((item) => [item.key, item.id ?? ""]));
  const seedSources = new Map((identitySeed?.sources ?? []).map((item) => [item.key, item.id ?? ""]));
  const [usedModuleIds, usedAssetIds, usedSourceIds] = await Promise.all([
    globallyUsedIds(db, "package_modules", modules.map((item) => item.id || seedModules.get(item.key) || "")),
    globallyUsedIds(db, "package_assets", assets.map((item) => item.id || seedAssets.get(item.key) || "")),
    globallyUsedIds(db, "package_source_refs", sources.map((item) => item.id || seedSources.get(item.key) || "")),
  ]);
  const hydratedModules = modules.map((module) => {
    const existing = moduleRows.get(module.key);
    if (existing && existing.module_kind !== module.kind) throw new ProjectPackageApiError("MODULE_KIND_IMMUTABLE", `${module.key} 的 kind 已固定为 ${existing.module_kind}`, 409);
    const requestedId = module.id || seedModules.get(module.key) || "";
    return { ...module, id: String(existing?.id ?? (requestedId && !usedModuleIds.has(requestedId) ? requestedId : `mod-${crypto.randomUUID()}`)) };
  });
  const hydratedAssets = assets.map((asset) => {
    const existing = assetRows.get(asset.key);
    const sameContent = assetResult.results.find((row: D1Row) => row.sha256 === asset.sha256);
    if (!existing && sameContent) {
      throw new ProjectPackageApiError("ASSET_SHA_ALREADY_BOUND", `${asset.key} 的内容摘要已由 asset key ${sameContent.asset_key} 使用`, 409);
    }
    if (existing) {
      const expected = canonicalJson({ kind: asset.kind, title: asset.title, contentRef: asset.contentRef, mediaType: asset.mediaType, sha256: asset.sha256, sizeBytes: asset.sizeBytes, metadata: asset.metadata, rights: asset.rights });
      const current = canonicalJson({ kind: existing.kind, title: existing.title, contentRef: existing.content_ref, mediaType: existing.media_type, sha256: existing.sha256, sizeBytes: Number(existing.size_bytes), metadata: parseJson(existing.metadata_json, {}), rights: parseJson(existing.rights_json, {}) });
      if (expected !== current) throw new ProjectPackageApiError("ASSET_KEY_IMMUTABLE", `${asset.key} 已绑定另一份不可变资源，请使用新 key`, 409);
    }
    const requestedId = asset.id || seedAssets.get(asset.key) || "";
    return { ...asset, id: String(existing?.id ?? (requestedId && !usedAssetIds.has(requestedId) ? requestedId : `asset-${crypto.randomUUID()}`)) };
  });
  const hydratedSources = await Promise.all(sources.map(async (source) => {
    const refSha256 = await sha256Text(canonicalJson({
      sourceKind: source.sourceKind, canonicalRef: source.canonicalRef, title: source.title, capturedAt: source.capturedAt,
      contentSha256: source.contentSha256, excerpt: source.excerpt, metadata: source.metadata, rights: source.rights,
    }));
    const existing = sourceRows.get(source.key);
    const sameSource = sourceResult.results.find((row: D1Row) => row.ref_sha256 === refSha256);
    if (!existing && sameSource) {
      throw new ProjectPackageApiError("SOURCE_SHA_ALREADY_BOUND", `${source.key} 的来源摘要已由 source key ${sameSource.source_key} 使用`, 409);
    }
    if (existing && existing.ref_sha256 !== refSha256) throw new ProjectPackageApiError("SOURCE_KEY_IMMUTABLE", `${source.key} 已绑定另一份不可变来源，请使用新 key`, 409);
    const requestedId = source.id || seedSources.get(source.key) || "";
    return { ...source, id: String(existing?.id ?? (requestedId && !usedSourceIds.has(requestedId) ? requestedId : `source-${crypto.randomUUID()}`)), refSha256 };
  }));
  const repeatedAssetSha = duplicate(hydratedAssets, (item) => item.sha256);
  if (repeatedAssetSha) throw new ProjectPackageApiError("DUPLICATE_ASSET_SHA", `document 中 asset SHA 重复：${repeatedAssetSha}`);
  const repeatedSourceSha = duplicate(hydratedSources, (item) => item.refSha256);
  if (repeatedSourceSha) throw new ProjectPackageApiError("DUPLICATE_SOURCE_SHA", `document 中 SourceRef SHA 重复：${repeatedSourceSha}`);
  for (const id of [
    ...hydratedModules.map((item) => item.id), ...hydratedAssets.map((item) => item.id),
    ...hydratedSources.map((item) => item.id),
  ]) {
    if (!ID_RE.test(id)) throw new ProjectPackageApiError("INVALID_ID", `document 中存在无效 id：${id}`);
  }
  const repeatedId = duplicate([
    ...hydratedModules.map((item) => ({ id: item.id })), ...hydratedAssets.map((item) => ({ id: item.id })),
    ...hydratedSources.map((item) => ({ id: item.id })),
  ], (item) => item.id);
  if (repeatedId) throw new ProjectPackageApiError("DUPLICATE_ID", `document id 重复：${repeatedId}`);
  const moduleKeys = new Set(hydratedModules.map((item) => item.key));
  const assetKeys = new Set(hydratedAssets.map((item) => item.key));
  const sourceKeys = new Set(hydratedSources.map((item) => item.key));
  const rootModuleKey = safeKey(value.rootModuleKey, "document.rootModuleKey");
  if (!moduleKeys.has(rootModuleKey)) throw new ProjectPackageApiError("ROOT_MODULE_NOT_FOUND", "rootModuleKey 必须指向 document.modules 中的模块");
  for (const edge of edges) {
    if (!moduleKeys.has(edge.sourceModuleKey) || !moduleKeys.has(edge.targetModuleKey)) {
      throw new ProjectPackageApiError("EDGE_ENDPOINT_NOT_FOUND", `${edge.key} 指向不存在的模块`);
    }
    if (edge.sourceModuleKey === edge.targetModuleKey) throw new ProjectPackageApiError("SELF_EDGE_FORBIDDEN", `${edge.key} 不允许自环`);
  }
  for (const moduleItem of hydratedModules) {
    for (const ref of moduleItem.refs ?? []) {
      if (ref.refKind === "asset" && !assetKeys.has(ref.refKey)) throw new ProjectPackageApiError("REF_TARGET_NOT_FOUND", `${moduleItem.key} 引用不存在的 asset：${ref.refKey}`);
      if (ref.refKind === "source" && !sourceKeys.has(ref.refKey)) throw new ProjectPackageApiError("REF_TARGET_NOT_FOUND", `${moduleItem.key} 引用不存在的 source：${ref.refKey}`);
    }
  }
  const seedEdges = new Map((identitySeed?.edges ?? []).map((item) => [item.key, item.id ?? ""]));
  const hydratedEdges = edges.map((edge) => ({ ...edge, id: edge.id || seedEdges.get(edge.key) || `logical-edge-${crypto.randomUUID()}` }));
  const prepared = canonicalValue({
    schemaVersion: DOCUMENT_SCHEMA_VERSION,
    title: requiredText(value.title, "document.title", 300), rootModuleKey,
    modules: hydratedModules, edges: hydratedEdges,
    assets: hydratedAssets,
    sources: hydratedSources.map((source) => ({
      id: source.id, key: source.key, sourceKind: source.sourceKind, canonicalRef: source.canonicalRef,
      title: source.title, capturedAt: source.capturedAt, contentSha256: source.contentSha256,
      excerpt: source.excerpt, metadata: source.metadata, rights: source.rights,
    })),
    metadata: objectValue(value.metadata, "document.metadata"),
  }) as PreparedDocument;
  if (new TextEncoder().encode(canonicalJson(prepared)).byteLength > MAX_DOCUMENT_BYTES) {
    throw new ProjectPackageApiError("DOCUMENT_TOO_LARGE", `canonical document 不得超过 ${MAX_DOCUMENT_BYTES} 字节`, 413);
  }
  return prepared;
}

async function documentSha(document: PackageDocument) {
  return sha256Text(canonicalJson(document));
}

function renderPackageDocument(document: PackageDocument) {
  const bodyText = document.modules.map((module) => (
    module.contentFormat === "json"
      ? canonicalJson(module.content ?? {})
      : normalizedText(module.contentText ?? "", true)
  )).join("\n\n");
  if (new TextEncoder().encode(bodyText).byteLength > 2_000_000) {
    throw new ProjectPackageApiError("RENDERED_BODY_TOO_LARGE", "Package 渲染正文超过 ArticleRevision 上限", 413);
  }
  return { documentTitle: document.title, bodyText };
}

type ExpectedStatement = { statement: D1PreparedStatement; expectedChanges: number; label: string };
type ModuleRevisionPlan = {
  id: string; packageId: string; moduleId: string; moduleKey: string; parentRevisionId: string | null;
  title: string; contentFormat: string; contentText: string; contentJson: string; contentSha256: string;
  metadataJson: string; revisionSha256: string; authorKind: string; sourcePatchId: string | null; createdAt: string;
  refs: Array<{ id: string; refKind: "asset" | "source"; refId: string; relationType: string; anchorJson: string }>;
};
type MaterializationPlan = {
  packageId: string;
  compositionId: string;
  compositionSha256: string;
  document: PreparedDocument;
  documentSha256: string;
  manifest: JsonObject;
  parentCompositionId: string | null;
  title: string;
  rootModuleId: string;
  sourceArticleRevisionId: string | null;
  authorKind: "user" | "agent" | "import" | "system";
  sourcePatchId: string | null;
  createdAt: string;
  newModules: Array<{ id: string; moduleKey: string; moduleKind: string; createdAt: string }>;
  newAssets: PreparedDocument["assets"];
  newSources: Array<PreparedDocument["sources"][number] & { refSha256: string }>;
  newRevisions: ModuleRevisionPlan[];
  nodes: Array<{ id: string; moduleId: string; revisionId: string; nodeKey: string; ordinal: number }>;
  edges: Array<{ id: string; edgeKey: string; sourceNodeId: string; targetNodeId: string; relationType: string; ordinal: number; conditionJson: string; edgeSha256: string }>;
  createdModuleRevisionIds: string[];
};

function guardedBulkInsert(
  db: D1Database,
  table: string,
  columns: string[],
  rows: Array<Array<string | number | null>>,
  guard: {
    packageId: string; compositionId: string; compositionSha256: string; lockVersion: number;
    branchId?: string; headRevisionId?: string;
  },
  label: string,
): ExpectedStatement | null {
  if (rows.length === 0) return null;
  const selectedColumns = columns.map((column) => `rows.${column}`).join(", ");
  const jsonColumns = columns.map((_, index) => `json_extract(value, '$[${index}]')`).join(", ");
  const guardSql = guard.branchId
    ? `SELECT 1 WHERE EXISTS (
        SELECT 1 FROM package_branch_states
        WHERE package_id = ? AND branch_id = ? AND head_composition_id = ?
          AND head_composition_sha256 = ? AND head_revision_id = ? AND lock_version = ?
      )`
    : `SELECT 1 WHERE EXISTS (
        SELECT 1 FROM article_project_packages
        WHERE id = ? AND main_composition_id = ? AND main_composition_sha256 = ? AND lock_version = ?
      )`;
  const sql = `WITH gate(ok) AS (
      ${guardSql}
    ), rows(${columns.join(", ")}) AS (
      SELECT ${jsonColumns} FROM json_each(?)
    )
    INSERT INTO ${table} (${columns.join(", ")})
    SELECT ${selectedColumns} FROM rows, gate`;
  const guardBindings = guard.branchId
    ? [guard.packageId, guard.branchId, guard.compositionId, guard.compositionSha256, guard.headRevisionId ?? "", guard.lockVersion]
    : [guard.packageId, guard.compositionId, guard.compositionSha256, guard.lockVersion];
  return {
    statement: db.prepare(sql).bind(...guardBindings, canonicalJson(rows)),
    expectedChanges: rows.length,
    label,
  };
}

async function loadCompositionDetail(db: D1Database, compositionId: string, expectedPackageId?: string) {
  const row = await compositionRow(db, compositionId, expectedPackageId);
  const [nodeResult, edgeResult, revisionResult, refResult] = await Promise.all([
    db.prepare("SELECT * FROM package_composition_nodes WHERE composition_id = ? ORDER BY slot ASC, ordinal ASC, id ASC")
      .bind(compositionId).all<D1Row>(),
    db.prepare("SELECT * FROM package_composition_edges WHERE composition_id = ? ORDER BY ordinal ASC, edge_key ASC")
      .bind(compositionId).all<D1Row>(),
    db.prepare(`SELECT revision.* FROM package_module_revisions revision
      JOIN package_composition_nodes node ON node.module_revision_id = revision.id
      WHERE node.composition_id = ? ORDER BY node.slot ASC, node.ordinal ASC`).bind(compositionId).all<D1Row>(),
    db.prepare(`SELECT ref.* FROM package_module_revision_refs ref
      JOIN package_composition_nodes node ON node.module_revision_id = ref.module_revision_id
      WHERE node.composition_id = ? ORDER BY ref.module_revision_id ASC, ref.ref_kind ASC, ref.relation_type ASC`)
      .bind(compositionId).all<D1Row>(),
  ]);
  const refsByRevision = new Map<string, Array<JsonObject>>();
  for (const ref of refResult.results) {
    const revisionId = String(ref.module_revision_id);
    const list = refsByRevision.get(revisionId) ?? [];
    list.push({
      id: String(ref.id), refKind: String(ref.ref_kind), refId: String(ref.ref_id),
      relationType: String(ref.relation_type), anchor: parseJson<JsonObject>(ref.anchor_json, {}),
    });
    refsByRevision.set(revisionId, list);
  }
  return {
    row,
    composition: parseCompositionRow(row, true),
    nodes: nodeResult.results.map(parseNodeRow),
    edges: edgeResult.results.map(parseEdgeRow),
    moduleRevisions: revisionResult.results.map((revision) => ({
      ...parseModuleRevisionRow(revision, true), refs: refsByRevision.get(String(revision.id)) ?? [],
    })),
  };
}

async function buildMaterializationPlan(db: D1Database, input: {
  packageId: string;
  document: PreparedDocument;
  parentCompositionId: string | null;
  title: string;
  authorKind: "user" | "agent" | "import" | "system";
  sourceArticleRevisionId?: string | null;
  sourcePatchId?: string | null;
}) {
  const createdAt = isoNow();
  const compositionId = `composition-${crypto.randomUUID()}`;
  const [moduleResult, assetResult, sourceResult, parentNodeResult] = await Promise.all([
    db.prepare("SELECT * FROM package_modules WHERE package_id = ?").bind(input.packageId).all<D1Row>(),
    db.prepare("SELECT * FROM package_assets WHERE package_id = ?").bind(input.packageId).all<D1Row>(),
    db.prepare("SELECT * FROM package_source_refs WHERE package_id = ?").bind(input.packageId).all<D1Row>(),
    input.parentCompositionId
      ? db.prepare(`SELECT node.module_id, node.module_revision_id, revision.revision_sha256
          FROM package_composition_nodes node
          JOIN package_module_revisions revision ON revision.id = node.module_revision_id
          WHERE node.composition_id = ?`).bind(input.parentCompositionId).all<D1Row>()
      : Promise.resolve({ results: [] as D1Row[] }),
  ]);
  const moduleRows = new Map(moduleResult.results.map((row) => [String(row.module_key), row]));
  const assetRows = new Map(assetResult.results.map((row) => [String(row.asset_key), row]));
  const sourceRows = new Map(sourceResult.results.map((row) => [String(row.source_key), row]));
  const parentByModule = new Map(parentNodeResult.results.map((row) => [String(row.module_id), row]));
  const newModules: MaterializationPlan["newModules"] = [];
  for (const moduleItem of input.document.modules) {
    const existing = moduleRows.get(moduleItem.key);
    if (!existing) newModules.push({ id: moduleItem.id, moduleKey: moduleItem.key, moduleKind: moduleItem.kind, createdAt });
  }
  const newAssets = input.document.assets.filter((asset) => !assetRows.has(asset.key));
  const sourceWithSha = await Promise.all(input.document.sources.map(async (source) => ({
    ...source,
    refSha256: await sha256Text(canonicalJson({
      sourceKind: source.sourceKind, canonicalRef: source.canonicalRef, title: source.title,
      capturedAt: source.capturedAt ?? null, contentSha256: source.contentSha256 ?? null,
      excerpt: source.excerpt ?? "", metadata: source.metadata ?? {}, rights: source.rights ?? {},
    })),
  })));
  const newSources = sourceWithSha.filter((source) => !sourceRows.has(source.key));
  const assetByKey = new Map(input.document.assets.map((asset) => [asset.key, asset]));
  const sourceByKey = new Map(sourceWithSha.map((source) => [source.key, source]));

  const candidates = await Promise.all(input.document.modules.map(async (moduleItem) => {
    const contentText = moduleItem.contentFormat === "json" ? "" : moduleItem.contentText ?? "";
    const contentJson = moduleItem.contentFormat === "json" ? canonicalJson(moduleItem.content ?? {}) : "{}";
    const contentSha256 = await sha256Text(moduleItem.contentFormat === "json" ? contentJson : contentText);
    const normalizedRefs = (moduleItem.refs ?? []).map((ref) => {
      const target = ref.refKind === "asset" ? assetByKey.get(ref.refKey) : sourceByKey.get(ref.refKey);
      if (!target) throw new ProjectPackageApiError("REF_TARGET_NOT_FOUND", `${moduleItem.key} 的引用目标不存在`);
      return {
        refKind: ref.refKind, refId: target.id, refKey: ref.refKey,
        relationType: ref.relationType, anchor: ref.anchor ?? {},
      };
    });
    const revisionSha256 = await sha256Text(canonicalJson({
      moduleKey: moduleItem.key, moduleKind: moduleItem.kind, title: moduleItem.title,
      contentFormat: moduleItem.contentFormat ?? "markdown", contentText, content: moduleItem.content ?? {},
      metadata: moduleItem.metadata ?? {}, refs: normalizedRefs,
    }));
    return { moduleItem, contentText, contentJson, contentSha256, normalizedRefs, revisionSha256 };
  }));
  const exactRevisionResult = candidates.length
    ? await db.prepare(`WITH candidates(module_id, revision_sha256) AS (
        SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]') FROM json_each(?)
      )
      SELECT revision.id, revision.module_id, revision.revision_sha256
      FROM package_module_revisions revision
      JOIN candidates candidate
        ON candidate.module_id = revision.module_id AND candidate.revision_sha256 = revision.revision_sha256`)
      .bind(canonicalJson(candidates.map((candidate) => [candidate.moduleItem.id, candidate.revisionSha256])))
      .all<D1Row>()
    : { results: [] as D1Row[] };
  const exactRevisionByIdentity = new Map<string, D1Row>(exactRevisionResult.results.map((row: D1Row) => [
    canonicalJson([row.module_id, row.revision_sha256]), row,
  ]));
  const revisions: Array<ModuleRevisionPlan & { reused: boolean }> = [];
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    const exact = exactRevisionByIdentity.get(canonicalJson([candidate.moduleItem.id, candidate.revisionSha256])) ?? null;
    const parent = parentByModule.get(candidate.moduleItem.id);
    const revisionId = exact ? String(exact.id) : `module-revision-${crypto.randomUUID()}`;
    revisions.push({
      id: revisionId, packageId: input.packageId, moduleId: candidate.moduleItem.id, moduleKey: candidate.moduleItem.key,
      parentRevisionId: parent ? String(parent.module_revision_id) : null, title: candidate.moduleItem.title,
      contentFormat: candidate.moduleItem.contentFormat ?? "markdown", contentText: candidate.contentText,
      contentJson: candidate.contentJson, contentSha256: candidate.contentSha256,
      metadataJson: canonicalJson(candidate.moduleItem.metadata ?? {}), revisionSha256: candidate.revisionSha256,
      authorKind: input.authorKind, sourcePatchId: input.sourcePatchId ?? null, createdAt,
      refs: exact ? [] : candidate.normalizedRefs.map((ref) => ({
        id: `module-ref-${crypto.randomUUID()}`, refKind: ref.refKind, refId: ref.refId,
        relationType: ref.relationType, anchorJson: canonicalJson(ref.anchor),
      })),
      reused: Boolean(exact),
    });
  }
  const revisionByModule = new Map(revisions.map((revision) => [revision.moduleId, revision]));
  const nodes = input.document.modules.map((module, ordinal) => ({
    id: `composition-node-${crypto.randomUUID()}`, moduleId: module.id,
    revisionId: revisionByModule.get(module.id)!.id, nodeKey: module.key, ordinal,
  }));
  const nodeByKey = new Map(nodes.map((node) => [node.nodeKey, node]));
  const edges = await Promise.all(input.document.edges.map(async (edge) => ({
    id: `composition-edge-${crypto.randomUUID()}`, edgeKey: edge.key,
    sourceNodeId: nodeByKey.get(edge.sourceModuleKey)!.id, targetNodeId: nodeByKey.get(edge.targetModuleKey)!.id,
    relationType: edge.relationType, ordinal: edge.ordinal ?? 0, conditionJson: canonicalJson(edge.condition ?? {}),
    edgeSha256: await sha256Text(canonicalJson({
      edgeKey: edge.key, sourceModuleKey: edge.sourceModuleKey, targetModuleKey: edge.targetModuleKey,
      relationType: edge.relationType, ordinal: edge.ordinal ?? 0, condition: edge.condition ?? {},
    })),
  })));
  const documentSha256 = await documentSha(input.document);
  let parentCompositionSha256: string | null = null;
  if (input.parentCompositionId) {
    const parent = await compositionRow(db, input.parentCompositionId, input.packageId);
    parentCompositionSha256 = String(parent.composition_sha256);
  }
  const rootModuleId = input.document.modules.find((module) => module.key === input.document.rootModuleKey)!.id;
  const manifest = canonicalValue({
    schemaVersion: "wenmai-package-manifest-v1", packageId: input.packageId, documentSha256,
    rootModuleKey: input.document.rootModuleKey, rootModuleId,
    modules: revisions.map((revision) => ({
      key: revision.moduleKey, moduleId: revision.moduleId, moduleRevisionId: revision.id,
      contentSha256: revision.contentSha256, revisionSha256: revision.revisionSha256,
    })),
    edges: edges.map((edge) => ({ key: edge.edgeKey, edgeSha256: edge.edgeSha256 })),
    assets: input.document.assets.map((asset) => ({ key: asset.key, id: asset.id, sha256: asset.sha256, sizeBytes: asset.sizeBytes })),
    sources: sourceWithSha.map((source) => ({ key: source.key, id: source.id, refSha256: source.refSha256, contentSha256: source.contentSha256 ?? null })),
  }) as JsonObject;
  const compositionSha256 = await sha256Text(canonicalJson({
    schemaVersion: COMPOSITION_SCHEMA_VERSION, packageId: input.packageId, parentCompositionSha256,
    title: input.title, documentSha256, rootModuleKey: input.document.rootModuleKey,
    modules: revisions.map((revision) => ({ key: revision.moduleKey, revisionSha256: revision.revisionSha256 })),
    edges: edges.map((edge) => ({ key: edge.edgeKey, edgeSha256: edge.edgeSha256 })),
    assets: input.document.assets.map((asset) => ({ key: asset.key, sha256: asset.sha256 })),
    sources: sourceWithSha.map((source) => ({ key: source.key, refSha256: source.refSha256 })),
    sourceArticleRevisionId: input.sourceArticleRevisionId ?? null, authorKind: input.authorKind,
    sourcePatchId: input.sourcePatchId ?? null,
  }));
  const plan: MaterializationPlan = {
    packageId: input.packageId, compositionId, compositionSha256, document: input.document, documentSha256, manifest,
    parentCompositionId: input.parentCompositionId, title: input.title, rootModuleId,
    sourceArticleRevisionId: input.sourceArticleRevisionId ?? null, authorKind: input.authorKind,
    sourcePatchId: input.sourcePatchId ?? null, createdAt, newModules, newAssets, newSources,
    newRevisions: revisions.filter((revision) => !revision.reused), nodes, edges,
    createdModuleRevisionIds: revisions.filter((revision) => !revision.reused).map((revision) => revision.id),
  };
  return plan;
}

function materializationStatements(
  db: D1Database,
  plan: MaterializationPlan,
  lockVersion: number,
  branchGuard?: { branchId: string; headRevisionId: string },
) {
  const guard = {
    packageId: plan.packageId, compositionId: plan.compositionId,
    compositionSha256: plan.compositionSha256, lockVersion,
    ...(branchGuard ? { branchId: branchGuard.branchId, headRevisionId: branchGuard.headRevisionId } : {}),
  };
  const statements: Array<ExpectedStatement | null> = [];
  statements.push(guardedBulkInsert(db, "package_modules",
    ["id", "package_id", "module_key", "module_kind", "schema_key", "schema_version", "created_at"],
    plan.newModules.map((module) => [module.id, plan.packageId, module.moduleKey, module.moduleKind, "wenmai.module", "1", module.createdAt]),
    guard, "modules"));
  statements.push(guardedBulkInsert(db, "package_assets",
    ["id", "package_id", "asset_key", "kind", "title", "content_ref", "media_type", "sha256", "size_bytes", "metadata_json", "rights_json", "created_at"],
    plan.newAssets.map((asset) => [
      asset.id, plan.packageId, asset.key, asset.kind, asset.title, asset.contentRef, asset.mediaType,
      asset.sha256, asset.sizeBytes, canonicalJson(asset.metadata ?? {}), canonicalJson(asset.rights ?? {}), plan.createdAt,
    ]), guard, "assets"));
  statements.push(guardedBulkInsert(db, "package_source_refs",
    ["id", "package_id", "source_key", "source_kind", "canonical_ref", "title", "captured_at", "content_sha256", "excerpt", "metadata_json", "rights_json", "ref_sha256", "created_at"],
    plan.newSources.map((source) => [
      source.id, plan.packageId, source.key, source.sourceKind, source.canonicalRef, source.title,
      source.capturedAt ?? null, source.contentSha256 ?? null, source.excerpt ?? "", canonicalJson(source.metadata ?? {}),
      canonicalJson(source.rights ?? {}), source.refSha256, plan.createdAt,
    ]), guard, "sources"));
  statements.push(guardedBulkInsert(db, "package_module_revisions",
    ["id", "package_id", "module_id", "parent_revision_id", "title", "content_format", "content_text", "content_json", "content_sha256", "metadata_json", "revision_sha256", "author_kind", "source_patch_id", "created_at"],
    plan.newRevisions.map((revision) => [
      revision.id, revision.packageId, revision.moduleId, revision.parentRevisionId, revision.title, revision.contentFormat,
      revision.contentText, revision.contentJson, revision.contentSha256, revision.metadataJson, revision.revisionSha256,
      revision.authorKind, revision.sourcePatchId, revision.createdAt,
    ]), guard, "module revisions"));
  statements.push(guardedBulkInsert(db, "package_module_revision_refs",
    ["id", "package_id", "module_revision_id", "ref_kind", "ref_id", "relation_type", "anchor_json", "created_at"],
    plan.newRevisions.flatMap((revision) => revision.refs.map((ref) => [
      ref.id, plan.packageId, revision.id, ref.refKind, ref.refId, ref.relationType, ref.anchorJson, plan.createdAt,
    ])), guard, "module revision refs"));
  statements.push(guardedBulkInsert(db, "package_compositions",
    ["id", "package_id", "parent_composition_id", "title", "schema_version", "root_module_id", "document_json", "document_sha256", "manifest_json", "composition_sha256", "source_article_revision_id", "author_kind", "source_patch_id", "created_at"],
    [[
      plan.compositionId, plan.packageId, plan.parentCompositionId, plan.title, COMPOSITION_SCHEMA_VERSION,
      plan.rootModuleId, canonicalJson(plan.document), plan.documentSha256, canonicalJson(plan.manifest), plan.compositionSha256,
      plan.sourceArticleRevisionId, plan.authorKind, plan.sourcePatchId, plan.createdAt,
    ]], guard, "composition"));
  statements.push(guardedBulkInsert(db, "package_composition_nodes",
    ["id", "package_id", "composition_id", "module_id", "module_revision_id", "node_key", "slot", "ordinal", "required", "config_json", "created_at"],
    plan.nodes.map((node) => [
      node.id, plan.packageId, plan.compositionId, node.moduleId, node.revisionId,
      node.nodeKey, "body", node.ordinal, 1, "{}", plan.createdAt,
    ]), guard, "composition nodes"));
  statements.push(guardedBulkInsert(db, "package_composition_edges",
    ["id", "package_id", "composition_id", "edge_key", "source_node_id", "target_node_id", "relation_type", "ordinal", "condition_json", "edge_sha256", "created_at"],
    plan.edges.map((edge) => [
      edge.id, plan.packageId, plan.compositionId, edge.edgeKey, edge.sourceNodeId, edge.targetNodeId,
      edge.relationType, edge.ordinal, edge.conditionJson, edge.edgeSha256, plan.createdAt,
    ]), guard, "composition edges"));
  return statements.filter((statement): statement is ExpectedStatement => statement !== null);
}

function guardedEventStatement(db: D1Database, input: {
  packageId: string; articleId: string; compositionId: string; compositionSha256: string; lockVersion: number;
  eventType: string; subjectType: string; subjectId: string; payload: JsonObject; inputSha256: string; createdAt: string;
}) {
  return db.prepare(`INSERT INTO workspace_events
    (id, event_type, subject_type, subject_id, article_id, payload_json, input_sha256, created_at)
    SELECT ?, ?, ?, ?, ?, ?, ?, ?
    WHERE EXISTS (
      SELECT 1 FROM article_project_packages
      WHERE id = ? AND main_composition_id = ? AND main_composition_sha256 = ? AND lock_version = ?
    )`).bind(
      `workspace-event-${crypto.randomUUID()}`, input.eventType, input.subjectType, input.subjectId, input.articleId,
      canonicalJson(input.payload), input.inputSha256, input.createdAt,
      input.packageId, input.compositionId, input.compositionSha256, input.lockVersion,
    );
}

async function currentPackageState(db: D1Database, ownerPackageId: string) {
  const root = await packageRow(db, ownerPackageId);
  const [composition, working] = await Promise.all([
    compositionRow(db, String(root.main_composition_id), ownerPackageId), workingRow(db, ownerPackageId),
  ]);
  return { root, composition, working };
}

type PackageBranchBridgeState = {
  row: D1Row;
  materialization: D1Row | null;
};

async function packageBranchBridgeState(
  db: D1Database,
  root: D1Row,
  working?: D1Row,
): Promise<PackageBranchBridgeState | null> {
  const branchId = root.primary_branch_id ? String(root.primary_branch_id) : "";
  if (!branchId) return null;
  const row = await db.prepare(`SELECT branch.id AS branch_id, branch.name AS branch_name, branch.slug AS branch_slug,
      branch.status AS branch_status, branch.head_revision_id, branch.base_revision_id AS branch_base_revision_id,
      head.body_sha256 AS head_body_sha256, head.body_text AS head_body_text,
      head.document_title AS head_document_title,
      copy.base_revision_id AS working_base_revision_id, copy.dirty AS branch_working_dirty,
      copy.lock_version AS branch_working_lock_version, copy.body_sha256 AS branch_working_body_sha256,
      copy.body_text AS branch_working_body_text
    FROM article_branches branch
    JOIN article_revisions head ON head.id = branch.head_revision_id AND head.branch_id = branch.id
    JOIN branch_working_copies copy ON copy.branch_id = branch.id AND copy.article_id = branch.article_id
    WHERE branch.id = ? AND branch.article_id = ? LIMIT 1`)
    .bind(branchId, root.article_id).first<D1Row>();
  if (!row) throw new ProjectPackageApiError("PACKAGE_BRANCH_BRIDGE_BROKEN", "Package 绑定的 ArticleBranch 或 Revision 不完整", 409, { branchId });
  const materialization = await db.prepare(`SELECT * FROM package_composition_materializations
    WHERE package_id = ? AND branch_id = ? AND composition_id = ? AND composition_sha256 = ?
    ORDER BY created_at DESC LIMIT 1`).bind(
    root.id, branchId, root.main_composition_id, root.main_composition_sha256,
  ).first<D1Row>();
  if (working && (working.branch_id !== branchId || working.base_revision_id !== row.head_revision_id)) {
    throw new ProjectPackageApiError("PACKAGE_BRANCH_BASE_STALE", "Package 工作副本与 ArticleBranch 头修订不一致", 409, {
      branchId, branchHeadRevisionId: row.head_revision_id,
      packageBaseRevisionId: working.base_revision_id,
    });
  }
  return { row, materialization };
}

function parsePackageBranchBridge(root: D1Row, working: D1Row, state: PackageBranchBridgeState | null) {
  if (!state) return null;
  const materialization = state.materialization ? parseMaterializationRow(state.materialization) : null;
  const inSync = Boolean(materialization
    && state.row.branch_status === "active"
    && state.row.head_revision_id === state.row.working_base_revision_id
    && Number(state.row.branch_working_dirty) === 0
    && state.row.branch_working_body_sha256 === state.row.head_body_sha256
    && working.branch_id === state.row.branch_id
    && working.base_revision_id === state.row.head_revision_id
    && materialization.articleRevisionId === state.row.head_revision_id
    && materialization.articleBodySha256 === state.row.head_body_sha256
    && materialization.compositionId === root.main_composition_id
    && materialization.compositionSha256 === root.main_composition_sha256);
  return {
    packageId: String(root.id), branchId: String(state.row.branch_id), branchName: String(state.row.branch_name),
    branchSlug: String(state.row.branch_slug), branchStatus: String(state.row.branch_status),
    headRevisionId: String(state.row.head_revision_id), headBodySha256: String(state.row.head_body_sha256),
    workingBaseRevisionId: String(state.row.working_base_revision_id),
    workingCopyDirty: Number(state.row.branch_working_dirty) === 1,
    workingCopyLockVersion: Number(state.row.branch_working_lock_version),
    packageBaseRevisionId: working.base_revision_id ? String(working.base_revision_id) : null,
    materialization, inSync,
  };
}

function bridgeRevisionAuthor(kind: "user" | "agent" | "import" | "system") {
  return kind === "agent" ? "agent" : kind === "import" ? "import" : "user";
}

function appendEventStatement(db: D1Database, input: {
  eventType: string; subjectType: string; subjectId: string; articleId: string | null;
  payload: JsonObject; inputSha256: string; createdAt: string;
}) {
  return db.prepare(`INSERT INTO workspace_events
    (id, event_type, subject_type, subject_id, article_id, payload_json, input_sha256, created_at)
    SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE changes() = 1`).bind(
      `workspace-event-${crypto.randomUUID()}`, input.eventType, input.subjectType, input.subjectId, input.articleId,
      canonicalJson(input.payload), input.inputSha256, input.createdAt,
    );
}

function initialDocument(title: string, bodyText: string, importWorkflow?: ImportWorkflowMetadata): PackageDocument {
  return {
    schemaVersion: DOCUMENT_SCHEMA_VERSION,
    title,
    rootModuleKey: "body",
    modules: [{
      key: "body", kind: "article_body", title,
      contentFormat: "markdown", contentText: bodyText, metadata: {}, refs: [],
    }],
    edges: [], assets: [], sources: [], metadata: importWorkflow ? { importWorkflow } : {},
  };
}

async function createInitialPackage(db: D1Database, input: {
  articleId: string; projectId: string | null; title: string; bodyText: string;
  sourceArticleRevisionId: string | null; authorKind: "user" | "agent" | "import";
  document?: PackageDocument;
  importWorkflow?: ImportWorkflowMetadata;
  branchBinding?: {
    branchId: string; headRevisionId: string; headBodySha256: string; headDocumentTitle: string;
    workingLockVersion: number;
  };
}, inputSha256: string) {
  const existing = await db.prepare(`SELECT * FROM article_project_packages
    WHERE article_id = ? OR (? IS NOT NULL AND project_id = ?) LIMIT 1`)
    .bind(input.articleId, input.projectId, input.projectId).first<D1Row>();
  if (existing) {
    if (existing.article_id !== input.articleId) {
      throw new ProjectPackageApiError("PROJECT_ID_CONFLICT", "projectId 已绑定另一篇文章", 409);
    }
    if (input.projectId && existing.project_id !== input.projectId) {
      throw new ProjectPackageApiError("PROJECT_BINDING_MISMATCH", "该文章 Package 已绑定另一 projectId", 409, {
        currentProjectId: existing.project_id,
      });
    }
    if (input.branchBinding) {
      return attachBranchToPackage(db, {
        packageId: String(existing.id), branchId: input.branchBinding.branchId,
        expectedBranchHeadRevisionId: input.branchBinding.headRevisionId,
        expectedBranchHeadBodySha256: input.branchBinding.headBodySha256,
        expectedArticleWorkingLockVersion: input.branchBinding.workingLockVersion,
      }, inputSha256);
    }
    const state = await currentPackageState(db, String(existing.id));
    if (input.importWorkflow) {
      const existingDocument = parseJson<PackageDocument>(state.composition.document_json, {} as PackageDocument);
      let currentWorkflow: ImportWorkflowMetadata;
      try {
        currentWorkflow = parseImportWorkflowMetadata(
          existingDocument.metadata?.importWorkflow,
          input.importWorkflow.source.sha256,
        );
      } catch {
        throw new ProjectPackageApiError(
          "IMPORT_WORKFLOW_PROFILE_CONFLICT",
          "同一来源身份已经存在，但旧 Package 没有相同的处理预设；请在原 Article 上建立升级候选，不要重复建根",
          409,
          { articleId: input.articleId, packageId: existing.id },
        );
      }
      if (currentWorkflow.selectedProfile !== input.importWorkflow.selectedProfile) {
        throw new ProjectPackageApiError(
          "IMPORT_WORKFLOW_PROFILE_CONFLICT",
          "同一来源身份已经选择另一处理预设；请在原 Article 上建立升级候选",
          409,
          {
            articleId: input.articleId,
            packageId: existing.id,
            currentProfile: currentWorkflow.selectedProfile,
            requestedProfile: input.importWorkflow.selectedProfile,
          },
        );
      }
    }
    const bridgeState = await packageBranchBridgeState(db, state.root, state.working);
    return {
      status: 200,
      data: {
        package: parsePackageRow(state.root), composition: parseCompositionRow(state.composition, true),
        workingCopy: parseWorkingRow(state.working), branchBridge: parsePackageBranchBridge(state.root, state.working, bridgeState),
        created: false, reused: true,
        boundary: { immutableCompositionCreated: false, packageMainAdvanced: false },
      },
    } satisfies MutationResult;
  }
  const ownerPackageId = packageId();
  const prepared = await prepareDocument(
    db,
    ownerPackageId,
    input.document ?? initialDocument(input.title, input.bodyText, input.importWorkflow),
  );
  const plan = await buildMaterializationPlan(db, {
    packageId: ownerPackageId, document: prepared, parentCompositionId: null, title: input.title,
    authorKind: input.authorKind, sourceArticleRevisionId: input.sourceArticleRevisionId,
  });
  const now = plan.createdAt;
  const rendered = renderPackageDocument(plan.document);
  const renderedBodySha256 = await sha256Text(rendered.bodyText);
  const branchId = input.branchBinding?.branchId ?? `branch-${crypto.randomUUID()}`;
  const branchCreated = !input.branchBinding;
  const reuseBoundHead = Boolean(input.branchBinding
    && input.branchBinding.headBodySha256 === renderedBodySha256
    && input.branchBinding.headDocumentTitle === rendered.documentTitle);
  const revisionId = reuseBoundHead && input.branchBinding
    ? input.branchBinding.headRevisionId
    : `revision-${crypto.randomUUID()}`;
  const revisionCreated = !reuseBoundHead;
  const materializationId = `package-materialization-${crypto.randomUUID()}`;
  const branchCommitId = `branch-commit-${crypto.randomUUID()}`;
  const branchCode = ownerPackageId.replace(/^pkg-/, "").replaceAll("-", "").slice(0, 12);
  const branchName = branchCreated ? `文章工程/${branchCode}` : "";
  const branchSlug = branchCreated ? `project-${branchCode}` : "";
  const rootStatement = db.prepare(`INSERT INTO article_project_packages
    (id, project_id, article_id, title, schema_version, branch_model_version, primary_branch_id, main_composition_id, main_composition_sha256,
     status, lock_version, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'wenmai-package-v1', 2, ?, ?, ?, 'active', 1, ?, ?)`)
    .bind(ownerPackageId, input.projectId, input.articleId, input.title, branchId, plan.compositionId, plan.compositionSha256, now, now);
  const immutableStatements = materializationStatements(db, plan, 1);
  const branchStatements: D1PreparedStatement[] = [];
  if (branchCreated) {
    branchStatements.push(
      db.prepare(`INSERT INTO article_revisions
        (id, article_id, branch_id, sequence, parent_revision_id, merge_parent_revision_id, source_version_id,
         title, document_title, annotation, body_text, body_sha256, author_kind, created_at)
        SELECT ?, ?, ?, 1, NULL, NULL, NULL, ?, ?, ?, ?, ?, ?, ?
        WHERE EXISTS (SELECT 1 FROM article_project_packages
          WHERE id = ? AND primary_branch_id = ? AND main_composition_id = ? AND main_composition_sha256 = ? AND lock_version = 1)`)
        .bind(
          revisionId, input.articleId, branchId, `文章工程基线 · ${input.title}`, rendered.documentTitle,
          "由 ArticleProject Package 的确定性渲染器建立；正文修订与 Composition 通过物化证据绑定。",
          rendered.bodyText, renderedBodySha256, bridgeRevisionAuthor(input.authorKind), now,
          ownerPackageId, branchId, plan.compositionId, plan.compositionSha256,
        ),
      db.prepare(`INSERT INTO article_branches
        (id, article_id, name, slug, color, status, head_revision_id, base_revision_id, base_source_version_id, created_at, updated_at)
        SELECT ?, ?, ?, ?, 'cyan', 'active', ?, ?, NULL, ?, ?
        WHERE EXISTS (SELECT 1 FROM article_revisions WHERE id = ? AND article_id = ? AND branch_id = ? AND body_sha256 = ?)`)
        .bind(branchId, input.articleId, branchName, branchSlug, revisionId, revisionId, now, now,
          revisionId, input.articleId, branchId, renderedBodySha256),
      db.prepare(`INSERT INTO branch_working_copies
        (branch_id, article_id, base_revision_id, title, annotation, body_text, body_sha256, dirty, lock_version, updated_at)
        SELECT ?, ?, ?, ?, '', ?, ?, 0, 1, ?
        WHERE EXISTS (SELECT 1 FROM article_branches WHERE id = ? AND article_id = ? AND head_revision_id = ? AND status = 'active')`)
        .bind(branchId, input.articleId, revisionId, rendered.documentTitle, rendered.bodyText, renderedBodySha256, now,
          branchId, input.articleId, revisionId),
    );
  } else if (revisionCreated && input.branchBinding) {
    const sequenceRow = await db.prepare("SELECT COALESCE(MAX(sequence), 0) AS maximum FROM article_revisions WHERE branch_id = ?")
      .bind(branchId).first<D1Row>();
    const sequence = Number(sequenceRow?.maximum ?? 0) + 1;
    branchStatements.push(
      db.prepare(`UPDATE article_branches SET head_revision_id = ?, updated_at = ?
        WHERE id = ? AND article_id = ? AND status = 'active' AND head_revision_id = ?
          AND EXISTS (SELECT 1 FROM branch_working_copies copy WHERE copy.branch_id = article_branches.id
            AND copy.base_revision_id = ? AND copy.dirty = 0 AND copy.lock_version = ?)
          AND EXISTS (SELECT 1 FROM article_project_packages WHERE id = ? AND primary_branch_id = ? AND lock_version = 1)`)
        .bind(revisionId, now, branchId, input.articleId, input.branchBinding.headRevisionId,
          input.branchBinding.headRevisionId, input.branchBinding.workingLockVersion, ownerPackageId, branchId),
      db.prepare(`INSERT INTO article_revisions
        (id, article_id, branch_id, sequence, parent_revision_id, merge_parent_revision_id, source_version_id,
         title, document_title, annotation, body_text, body_sha256, author_kind, created_at)
        SELECT ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?
        WHERE EXISTS (SELECT 1 FROM article_branches WHERE id = ? AND head_revision_id = ?)
          AND EXISTS (SELECT 1 FROM article_project_packages WHERE id = ? AND primary_branch_id = ? AND lock_version = 1)`)
        .bind(
          revisionId, input.articleId, branchId, sequence, input.branchBinding.headRevisionId,
          `文章工程基线 · ${input.title}`, rendered.documentTitle,
          "创建 ArticleProject Package 时从所选 ArticleBranch 的 clean head 原子物化。",
          rendered.bodyText, renderedBodySha256, bridgeRevisionAuthor(input.authorKind), now,
          branchId, revisionId, ownerPackageId, branchId,
        ),
      db.prepare(`UPDATE branch_working_copies SET base_revision_id = ?, title = ?, annotation = '', body_text = ?,
          body_sha256 = ?, dirty = 0, lock_version = lock_version + 1, updated_at = ?
        WHERE branch_id = ? AND article_id = ? AND base_revision_id = ? AND dirty = 0 AND lock_version = ?
          AND EXISTS (SELECT 1 FROM article_branches WHERE id = ? AND head_revision_id = ?)
          AND EXISTS (SELECT 1 FROM article_revisions WHERE id = ? AND branch_id = ? AND body_sha256 = ?)`)
        .bind(revisionId, rendered.documentTitle, rendered.bodyText, renderedBodySha256, now,
          branchId, input.articleId, input.branchBinding.headRevisionId, input.branchBinding.workingLockVersion,
          branchId, revisionId, revisionId, branchId, renderedBodySha256),
    );
  }
  const bridgeStatement = db.prepare(`INSERT INTO package_composition_materializations
    (id, package_id, branch_id, composition_id, composition_sha256, article_revision_id, article_body_sha256,
     renderer_key, renderer_version, created_by_kind, created_at)
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    WHERE EXISTS (SELECT 1 FROM article_project_packages
      WHERE id = ? AND primary_branch_id = ? AND main_composition_id = ? AND main_composition_sha256 = ? AND lock_version = 1)
      AND EXISTS (SELECT 1 FROM article_branches WHERE id = ? AND head_revision_id = ?)
      AND EXISTS (SELECT 1 FROM article_revisions WHERE id = ? AND branch_id = ? AND body_sha256 = ?)`)
    .bind(
      materializationId, ownerPackageId, branchId, plan.compositionId, plan.compositionSha256, revisionId,
      renderedBodySha256, PACKAGE_RENDERER_KEY, PACKAGE_RENDERER_VERSION, input.authorKind, now,
      ownerPackageId, branchId, plan.compositionId, plan.compositionSha256,
      branchId, revisionId, revisionId, branchId, renderedBodySha256,
    );
  const workingStatement = db.prepare(`INSERT INTO package_working_copies
    (package_id, branch_id, base_composition_id, base_revision_id, document_json, document_sha256, dirty, lock_version, updated_at)
    SELECT ?, ?, ?, ?, ?, ?, 0, 1, ?
    WHERE EXISTS (
      SELECT 1 FROM article_project_packages
      WHERE id = ? AND primary_branch_id = ? AND main_composition_id = ? AND main_composition_sha256 = ? AND lock_version = 1
    ) AND EXISTS (SELECT 1 FROM package_composition_materializations
      WHERE id = ? AND article_revision_id = ? AND article_body_sha256 = ?)`)
    .bind(
      ownerPackageId, branchId, plan.compositionId, revisionId, canonicalJson(plan.document), plan.documentSha256, now,
      ownerPackageId, branchId, plan.compositionId, plan.compositionSha256,
      materializationId, revisionId, renderedBodySha256,
    );
  const branchStateStatement = db.prepare(`INSERT INTO package_branch_states
    (package_id, branch_id, head_composition_id, head_composition_sha256, head_revision_id,
     status, lock_version, created_at, updated_at)
    SELECT ?, ?, ?, ?, ?, 'active', 1, ?, ?
    WHERE EXISTS (SELECT 1 FROM package_composition_materializations
      WHERE id = ? AND package_id = ? AND branch_id = ? AND article_revision_id = ?)`)
    .bind(ownerPackageId, branchId, plan.compositionId, plan.compositionSha256, revisionId, now, now,
      materializationId, ownerPackageId, branchId, revisionId);
  const branchWorkingStatement = db.prepare(`INSERT INTO package_branch_working_copies
    (package_id, branch_id, base_composition_id, base_revision_id, document_json, document_sha256,
     dirty, lock_version, updated_at)
    SELECT ?, ?, ?, ?, ?, ?, 0, 1, ?
    WHERE EXISTS (SELECT 1 FROM package_branch_states WHERE package_id = ? AND branch_id = ?
      AND head_composition_id = ? AND head_revision_id = ? AND lock_version = 1)`)
    .bind(ownerPackageId, branchId, plan.compositionId, revisionId, canonicalJson(plan.document), plan.documentSha256, now,
      ownerPackageId, branchId, plan.compositionId, revisionId);
  const branchCommitStatement = db.prepare(`INSERT INTO package_branch_composition_commits
    (id, package_id, branch_id, parent_composition_id, composition_id, composition_sha256,
     previous_revision_id, article_revision_id, source_kind, source_patch_id, created_by_kind, created_at)
    SELECT ?, ?, ?, NULL, ?, ?, NULL, ?, ?, NULL, ?, ?
    WHERE EXISTS (SELECT 1 FROM package_branch_states WHERE package_id = ? AND branch_id = ?
      AND head_composition_id = ? AND head_revision_id = ?)`)
    .bind(branchCommitId, ownerPackageId, branchId, plan.compositionId, plan.compositionSha256, revisionId,
      branchCreated ? "system" : "attach", input.authorKind, now,
      ownerPackageId, branchId, plan.compositionId, revisionId);
  const migrationAuditStatement = db.prepare(`INSERT INTO package_branch_migration_audits
    (package_id, state, reason_code, detail_json, source_schema_version, created_at, updated_at)
    SELECT ?, 'migrated_clean', '', ?, '0010', ?, ?
    WHERE EXISTS (SELECT 1 FROM package_branch_working_copies WHERE package_id = ? AND branch_id = ? AND dirty = 0)`)
    .bind(ownerPackageId, canonicalJson({ createdBy: "0010", primaryBranchId: branchId }), now, now, ownerPackageId, branchId);
  const event = guardedEventStatement(db, {
    packageId: ownerPackageId, articleId: input.articleId, compositionId: plan.compositionId,
    compositionSha256: plan.compositionSha256, lockVersion: 1, eventType: "package.created",
    subjectType: "article_project_package", subjectId: ownerPackageId,
    payload: {
      compositionId: plan.compositionId, sourceArticleRevisionId: input.sourceArticleRevisionId,
      primaryBranchId: branchId, materializedRevisionId: revisionId, rendererKey: PACKAGE_RENDERER_KEY,
      rendererVersion: PACKAGE_RENDERER_VERSION,
    },
    inputSha256, createdAt: now,
  });
  let results: D1Mutation[];
  try {
    results = await db.batch([
      rootStatement, ...immutableStatements.map((item) => item.statement), ...branchStatements,
      bridgeStatement, workingStatement, branchStateStatement, branchWorkingStatement, branchCommitStatement,
      migrationAuditStatement, event,
      db.prepare(`SELECT CASE WHEN EXISTS (
        SELECT 1 FROM article_project_packages package
        JOIN package_working_copies package_copy ON package_copy.package_id = package.id
        JOIN article_branches branch ON branch.id = package.primary_branch_id
        JOIN article_revisions revision ON revision.id = branch.head_revision_id AND revision.branch_id = branch.id
        JOIN branch_working_copies branch_copy ON branch_copy.branch_id = branch.id
        JOIN package_composition_materializations bridge
          ON bridge.package_id = package.id AND bridge.branch_id = branch.id
          AND bridge.composition_id = package.main_composition_id AND bridge.article_revision_id = revision.id
        JOIN package_branch_states state
          ON state.package_id = package.id AND state.branch_id = branch.id
          AND state.head_composition_id = package.main_composition_id AND state.head_revision_id = revision.id
        JOIN package_branch_working_copies branch_package_copy
          ON branch_package_copy.package_id = package.id AND branch_package_copy.branch_id = branch.id
          AND branch_package_copy.base_composition_id = state.head_composition_id
          AND branch_package_copy.base_revision_id = state.head_revision_id
        JOIN package_branch_composition_commits branch_commit
          ON branch_commit.package_id = package.id AND branch_commit.branch_id = branch.id
          AND branch_commit.composition_id = state.head_composition_id
          AND branch_commit.article_revision_id = state.head_revision_id
        WHERE package.id = ? AND package.main_composition_id = ? AND package.main_composition_sha256 = ?
          AND package_copy.branch_id = branch.id AND package_copy.base_composition_id = package.main_composition_id
          AND package_copy.base_revision_id = revision.id AND package_copy.dirty = 0
          AND branch_copy.base_revision_id = revision.id AND branch_copy.dirty = 0
      ) THEN 1 ELSE json('wenmai-package-bridge-incomplete') END AS committed`)
        .bind(ownerPackageId, plan.compositionId, plan.compositionSha256),
    ]);
  } catch (error) {
    const raced = await db.prepare("SELECT * FROM article_project_packages WHERE article_id = ? LIMIT 1")
      .bind(input.articleId).first<D1Row>();
    if (raced) throw new ProjectPackageApiError("PACKAGE_ALREADY_EXISTS", "该文章已经建立 ArticleProjectPackage", 409, { packageId: raced.id });
    throw error;
  }
  if (resultChanges(results[0]) !== 1) throw new ProjectPackageApiError("PACKAGE_CREATE_CONFLICT", "Package 创建失败", 409);
  immutableStatements.forEach((expected, index) => {
    if (resultChanges(results[index + 1]) !== expected.expectedChanges) {
      throw new ProjectPackageApiError("PACKAGE_MATERIALIZATION_INCOMPLETE", `${expected.label} 未完整写入`, 500);
    }
  });
  const tail = results.slice(1 + immutableStatements.length, -1);
  assertAllChanged(tail, "PACKAGE_CREATE_INCOMPLETE", "Package 工作副本或事件未完整写入");
  const state = await currentPackageState(db, ownerPackageId);
  const bridgeState = await packageBranchBridgeState(db, state.root, state.working);
  return {
    status: 201,
    data: {
      package: parsePackageRow(state.root), composition: parseCompositionRow(state.composition, true),
      workingCopy: parseWorkingRow(state.working), branchBridge: parsePackageBranchBridge(state.root, state.working, bridgeState),
      created: true, reused: false,
      boundary: {
        immutableCompositionCreated: true, packageMainAdvanced: true,
        primaryBranchId: branchId, branchCreated, revisionCreated,
        singlePrimaryBranch: false, multiBranchPackageState: true,
      },
    },
  } satisfies MutationResult;
}

async function cleanBranchBinding(
  db: D1Database,
  articleId: string,
  branchId: string,
  expectedHeadRevisionId: string,
  expectedHeadBodySha256: string,
) {
  const row = await db.prepare(`SELECT branch.id AS branch_id, branch.head_revision_id, branch.status,
      head.body_sha256 AS head_body_sha256, head.body_text AS head_body_text,
      head.document_title AS head_document_title,
      copy.base_revision_id AS working_base_revision_id, copy.dirty AS working_dirty,
      copy.lock_version AS working_lock_version
    FROM article_branches branch
    JOIN article_revisions head ON head.id = branch.head_revision_id AND head.branch_id = branch.id
    JOIN branch_working_copies copy ON copy.branch_id = branch.id AND copy.article_id = branch.article_id
    WHERE branch.id = ? AND branch.article_id = ? LIMIT 1`)
    .bind(branchId, articleId).first<D1Row>();
  if (!row || row.status !== "active") {
    throw new ProjectPackageApiError("BRANCH_NOT_FOUND", "待绑定 ArticleBranch 不存在、不活动或不属于该文章", 404, { branchId });
  }
  if (row.head_revision_id !== expectedHeadRevisionId || row.head_body_sha256 !== expectedHeadBodySha256) {
    throw new ProjectPackageApiError("BRANCH_HEAD_CAS_CONFLICT", "待绑定 ArticleBranch 的 head revision 或正文摘要已经变化", 409, {
      expectedHeadRevisionId, expectedHeadBodySha256,
      currentHeadRevisionId: row.head_revision_id, currentHeadBodySha256: row.head_body_sha256,
    });
  }
  if (row.working_base_revision_id !== expectedHeadRevisionId || Number(row.working_dirty) !== 0) {
    throw new ProjectPackageApiError("DIRTY_ARTICLE_WORKING_COPY", "建立文章工程前，目标 ArticleBranch 必须处于 clean head", 409, {
      branchId, workingBaseRevisionId: row.working_base_revision_id, workingDirty: Number(row.working_dirty) === 1,
    });
  }
  return {
    branchId, headRevisionId: expectedHeadRevisionId, headBodySha256: expectedHeadBodySha256,
    headBodyText: String(row.head_body_text), headDocumentTitle: String(row.head_document_title),
    workingLockVersion: Number(row.working_lock_version),
  };
}

async function attachBranchToPackage(db: D1Database, payload: JsonObject, inputSha256: string) {
  const ownerPackageId = requiredText(payload.packageId, "packageId", 160);
  const branchId = requiredText(payload.branchId, "branchId", 160);
  const expectedHeadRevisionId = requiredText(payload.expectedBranchHeadRevisionId, "expectedBranchHeadRevisionId", 160);
  const expectedHeadBodySha256 = exactSha256(payload.expectedBranchHeadBodySha256, "expectedBranchHeadBodySha256");
  const expectedArticleWorkingLockVersion = exactInteger(
    payload.expectedBranchWorkingLockVersion ?? payload.expectedArticleWorkingLockVersion,
    "expectedBranchWorkingLockVersion",
    1,
    2_147_483_647,
  );
  const root = await packageRow(db, ownerPackageId);
  if (root.status !== "active") throw new ProjectPackageApiError("PACKAGE_ARCHIVED", "归档 Package 不允许接入新分支", 409);
  const audit = await migrationAuditRow(db, ownerPackageId);
  if (audit?.state === "blocked") {
    throw new ProjectPackageApiError("PACKAGE_BRANCH_MIGRATION_REQUIRED", "Package 迁移审计被阻断；接入分支前需先人工修复旧关系", 409, {
      migrationAudit: parseMigrationAuditRow(audit),
    });
  }
  const binding = await cleanBranchBinding(
    db,
    String(root.article_id),
    branchId,
    expectedHeadRevisionId,
    expectedHeadBodySha256,
  );
  if (binding.workingLockVersion !== expectedArticleWorkingLockVersion) {
    throw new ProjectPackageApiError("ARTICLE_WORKING_COPY_CAS_CONFLICT", "ArticleBranch 工作副本 lockVersion 已变化", 409, {
      currentLockVersion: binding.workingLockVersion,
    });
  }
  const existingState = await db.prepare("SELECT * FROM package_branch_states WHERE branch_id = ? LIMIT 1")
    .bind(branchId).first<D1Row>();
  if (existingState) {
    if (existingState.package_id !== ownerPackageId) {
      throw new ProjectPackageApiError("BRANCH_ATTACHED_TO_ANOTHER_PACKAGE", "该 ArticleBranch 已接入另一 ArticleProject Package", 409, {
        branchId, packageId: existingState.package_id,
      });
    }
    const selected = await loadSelectedPackageBranch(db, root, branchId);
    if (selected.row.head_revision_id !== expectedHeadRevisionId || selected.row.article_head_body_sha256 !== expectedHeadBodySha256) {
      throw new ProjectPackageApiError("ATTACHED_BRANCH_HEAD_DIVERGED", "已接入分支的 Package head 与 ArticleBranch head 不一致", 409);
    }
    return {
      data: {
        package: parsePackageRow(root), branchState: selected.branchState,
        branchWorkingCopy: selected.workingCopy, workingCopy: selected.workingCopy,
        composition: parseCompositionRow(selected.composition, true), branchCommit: selected.branchCommit,
        branchBridge: selected.branchBridge, attached: true, created: false, reused: true,
        boundary: { articleBranchCreated: false, articleBranchAdvanced: false, revisionCreated: false, primaryChanged: false },
      },
    };
  }

  const materialization = await db.prepare(`SELECT materialization.*, composition.document_json, composition.document_sha256
    FROM package_composition_materializations materialization
    JOIN package_compositions composition ON composition.id = materialization.composition_id AND composition.package_id = materialization.package_id
    WHERE materialization.package_id = ? AND materialization.branch_id = ? AND materialization.article_revision_id = ? LIMIT 1`)
    .bind(ownerPackageId, branchId, expectedHeadRevisionId).first<D1Row>();
  let composition: D1Row | null = null;
  let plan: MaterializationPlan | null = null;
  let preparedDocument: PreparedDocument;
  if (materialization) {
    composition = await compositionRow(db, String(materialization.composition_id), ownerPackageId);
    preparedDocument = parseJson<PreparedDocument>(composition.document_json, {} as PreparedDocument);
  } else {
    preparedDocument = await prepareDocument(
      db,
      ownerPackageId,
      initialDocument(binding.headDocumentTitle || String(root.title), binding.headBodyText),
    );
    plan = await buildMaterializationPlan(db, {
      packageId: ownerPackageId,
      document: preparedDocument,
      parentCompositionId: null,
      title: binding.headDocumentTitle || String(root.title),
      authorKind: "system",
      sourceArticleRevisionId: expectedHeadRevisionId,
    });
    const rendered = renderPackageDocument(plan.document);
    const renderedSha = await sha256Text(rendered.bodyText);
    if (renderedSha !== expectedHeadBodySha256) {
      throw new ProjectPackageApiError("ATTACH_RENDER_MISMATCH", "ArticleRevision 正文无法由确定性 Package 文档无损还原", 409, {
        expectedHeadBodySha256, renderedBodySha256: renderedSha,
      });
    }
    const reusedComposition = await db.prepare("SELECT * FROM package_compositions WHERE package_id = ? AND composition_sha256 = ? LIMIT 1")
      .bind(ownerPackageId, plan.compositionSha256).first<D1Row>();
    if (reusedComposition) {
      composition = reusedComposition;
      preparedDocument = parseJson<PreparedDocument>(reusedComposition.document_json, preparedDocument);
      plan = null;
    }
  }
  const compositionIdValue = plan?.compositionId ?? String(composition!.id);
  const compositionSha256 = plan?.compositionSha256 ?? String(composition!.composition_sha256);
  const documentSha256 = plan?.documentSha256 ?? String(composition!.document_sha256);
  const now = isoNow();
  const materializationId = materialization ? String(materialization.id) : `package-materialization-${crypto.randomUUID()}`;
  const branchCommitId = `branch-commit-${crypto.randomUUID()}`;
  const stateInsert = db.prepare(`INSERT INTO package_branch_states
    (package_id, branch_id, head_composition_id, head_composition_sha256, head_revision_id,
     status, lock_version, created_at, updated_at)
    SELECT ?, ?, ?, ?, ?, 'active', 1, ?, ?
    FROM article_branches branch
    JOIN article_revisions revision ON revision.id = branch.head_revision_id AND revision.branch_id = branch.id
    JOIN branch_working_copies copy ON copy.branch_id = branch.id AND copy.article_id = branch.article_id
    WHERE branch.id = ? AND branch.article_id = ? AND branch.status = 'active'
      AND branch.head_revision_id = ? AND revision.body_sha256 = ?
      AND copy.base_revision_id = branch.head_revision_id AND copy.dirty = 0 AND copy.lock_version = ?
      AND NOT EXISTS (SELECT 1 FROM package_branch_states WHERE branch_id = branch.id) LIMIT 1`)
    .bind(ownerPackageId, branchId, compositionIdValue, compositionSha256, expectedHeadRevisionId, now, now,
      branchId, root.article_id, expectedHeadRevisionId, expectedHeadBodySha256, expectedArticleWorkingLockVersion);
  const immutableStatements = plan ? materializationStatements(db, plan, 1, { branchId, headRevisionId: expectedHeadRevisionId }) : [];
  const materializationStatement = materialization
    ? null
    : db.prepare(`INSERT INTO package_composition_materializations
      (id, package_id, branch_id, composition_id, composition_sha256, article_revision_id, article_body_sha256,
       renderer_key, renderer_version, created_by_kind, created_at)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, 'system', ?
      WHERE EXISTS (SELECT 1 FROM package_branch_states WHERE package_id = ? AND branch_id = ?
        AND head_composition_id = ? AND head_composition_sha256 = ? AND head_revision_id = ? AND lock_version = 1)
        AND EXISTS (SELECT 1 FROM package_compositions WHERE id = ? AND package_id = ? AND composition_sha256 = ?)`)
      .bind(materializationId, ownerPackageId, branchId, compositionIdValue, compositionSha256, expectedHeadRevisionId,
        expectedHeadBodySha256, PACKAGE_RENDERER_KEY, PACKAGE_RENDERER_VERSION, now,
        ownerPackageId, branchId, compositionIdValue, compositionSha256, expectedHeadRevisionId,
        compositionIdValue, ownerPackageId, compositionSha256);
  const branchWorkingInsert = db.prepare(`INSERT INTO package_branch_working_copies
    (package_id, branch_id, base_composition_id, base_revision_id, document_json, document_sha256,
     dirty, lock_version, updated_at)
    SELECT ?, ?, ?, ?, ?, ?, 0, 1, ?
    WHERE EXISTS (SELECT 1 FROM package_composition_materializations WHERE id = ? AND package_id = ?
      AND branch_id = ? AND composition_id = ? AND article_revision_id = ?)`)
    .bind(ownerPackageId, branchId, compositionIdValue, expectedHeadRevisionId, canonicalJson(preparedDocument), documentSha256, now,
      materializationId, ownerPackageId, branchId, compositionIdValue, expectedHeadRevisionId);
  const branchCommitInsert = db.prepare(`INSERT INTO package_branch_composition_commits
    (id, package_id, branch_id, parent_composition_id, composition_id, composition_sha256,
     previous_revision_id, article_revision_id, source_kind, source_patch_id, created_by_kind, created_at)
    SELECT ?, ?, ?, NULL, ?, ?, revision.parent_revision_id, ?, 'attach', NULL, 'system', ?
    FROM article_revisions revision
    WHERE revision.id = ? AND revision.branch_id = ?
      AND EXISTS (SELECT 1 FROM package_branch_working_copies WHERE package_id = ? AND branch_id = ?
        AND base_composition_id = ? AND base_revision_id = ?)`)
    .bind(branchCommitId, ownerPackageId, branchId, compositionIdValue, compositionSha256,
      expectedHeadRevisionId, now, expectedHeadRevisionId, branchId,
      ownerPackageId, branchId, compositionIdValue, expectedHeadRevisionId);
  const rootWasUnbound = root.primary_branch_id === null;
  const rootUpdate = rootWasUnbound
    ? db.prepare(`UPDATE article_project_packages
      SET primary_branch_id = ?, main_composition_id = ?, main_composition_sha256 = ?, branch_model_version = 2,
        lock_version = lock_version + 1, updated_at = ?
      WHERE id = ? AND primary_branch_id IS NULL AND status = 'active'
        AND EXISTS (SELECT 1 FROM package_branch_composition_commits WHERE id = ? AND package_id = ? AND branch_id = ?)`)
      .bind(branchId, compositionIdValue, compositionSha256, now, ownerPackageId, branchCommitId, ownerPackageId, branchId)
    : null;
  const auditStatement = db.prepare(`INSERT INTO package_branch_migration_audits
    (package_id, state, reason_code, detail_json, source_schema_version, created_at, updated_at)
    SELECT ?, 'migrated_clean', '', ?, '0010', ?, ?
    WHERE EXISTS (SELECT 1 FROM package_branch_composition_commits WHERE id = ? AND package_id = ? AND branch_id = ?)
    ON CONFLICT(package_id) DO UPDATE SET
      state = CASE WHEN package_branch_migration_audits.state = 'legacy_unbound' THEN 'migrated_clean' ELSE package_branch_migration_audits.state END,
      reason_code = CASE WHEN package_branch_migration_audits.state = 'legacy_unbound' THEN '' ELSE package_branch_migration_audits.reason_code END,
      updated_at = excluded.updated_at`)
    .bind(ownerPackageId, canonicalJson({ explicitAttach: true, branchId }), now, now,
      branchCommitId, ownerPackageId, branchId);
  const eventStatement = db.prepare(`INSERT INTO workspace_events
    (id, event_type, subject_type, subject_id, article_id, payload_json, input_sha256, created_at)
    SELECT ?, 'package.branch_attached', 'package_branch_state', ?, ?, ?, ?, ?
    WHERE EXISTS (SELECT 1 FROM package_branch_composition_commits WHERE id = ? AND package_id = ? AND branch_id = ?)`)
    .bind(`workspace-event-${crypto.randomUUID()}`, `${ownerPackageId}:${branchId}`, root.article_id,
      canonicalJson({ packageId: ownerPackageId, branchId, compositionId: compositionIdValue,
        articleRevisionId: expectedHeadRevisionId, articleBranchAdvanced: false }), inputSha256, now,
      branchCommitId, ownerPackageId, branchId);
  const statements = [
    stateInsert,
    ...immutableStatements.map((item) => item.statement),
    ...(materializationStatement ? [materializationStatement] : []),
    branchWorkingInsert,
    branchCommitInsert,
    ...(rootUpdate ? [rootUpdate] : []),
    auditStatement,
    eventStatement,
    db.prepare(`SELECT CASE WHEN EXISTS (
      SELECT 1 FROM package_branch_states state
      JOIN package_branch_working_copies copy ON copy.package_id = state.package_id AND copy.branch_id = state.branch_id
      JOIN article_branches branch ON branch.id = state.branch_id
      JOIN branch_working_copies article_copy ON article_copy.branch_id = state.branch_id
      JOIN package_composition_materializations materialization
        ON materialization.package_id = state.package_id AND materialization.branch_id = state.branch_id
        AND materialization.composition_id = state.head_composition_id
        AND materialization.article_revision_id = state.head_revision_id
      JOIN package_branch_composition_commits commit_ref
        ON commit_ref.package_id = state.package_id AND commit_ref.branch_id = state.branch_id
        AND commit_ref.composition_id = state.head_composition_id
        AND commit_ref.article_revision_id = state.head_revision_id
      WHERE state.package_id = ? AND state.branch_id = ? AND state.head_composition_id = ?
        AND state.head_revision_id = ? AND state.lock_version = 1
        AND copy.base_composition_id = state.head_composition_id AND copy.base_revision_id = state.head_revision_id
        AND branch.head_revision_id = state.head_revision_id
        AND article_copy.base_revision_id = state.head_revision_id AND article_copy.dirty = 0
    ) THEN 1 ELSE json('wenmai-0010-attach-incomplete') END AS committed`)
      .bind(ownerPackageId, branchId, compositionIdValue, expectedHeadRevisionId),
  ];
  let results: D1Mutation[];
  try { results = await db.batch(statements); } catch (error) {
    const raced = await db.prepare("SELECT * FROM package_branch_states WHERE branch_id = ? LIMIT 1").bind(branchId).first<D1Row>();
    if (raced) throw new ProjectPackageApiError("BRANCH_ATTACH_CONFLICT", "ArticleBranch 接入发生并发冲突", 409, { branchId });
    throw error;
  }
  if (resultChanges(results[0]) !== 1) throw new ProjectPackageApiError("BRANCH_ATTACH_CONFLICT", "ArticleBranch 接入基线已变化", 409);
  immutableStatements.forEach((expected, index) => {
    if (resultChanges(results[index + 1]) !== expected.expectedChanges) {
      throw new ProjectPackageApiError("BRANCH_ATTACH_MATERIALIZATION_INCOMPLETE", `${expected.label} 未完整写入`, 500);
    }
  });
  const currentRoot = await packageRow(db, ownerPackageId);
  const selected = await loadSelectedPackageBranch(db, currentRoot, branchId);
  return {
    status: 201,
    data: {
      package: parsePackageRow(currentRoot), branchState: selected.branchState,
      branchWorkingCopy: selected.workingCopy, workingCopy: selected.workingCopy,
      composition: parseCompositionRow(selected.composition, true), branchCommit: selected.branchCommit,
      branchBridge: selected.branchBridge, attached: true, created: true, reused: false,
      boundary: {
        articleBranchCreated: false, articleBranchAdvanced: false, revisionCreated: false,
        primaryChanged: rootWasUnbound, packageMainAdvanced: rootWasUnbound,
      },
    },
  };
}

async function setPrimaryPackageBranch(db: D1Database, payload: JsonObject, inputSha256: string) {
  const ownerPackageId = requiredText(payload.packageId, "packageId", 160);
  const branchId = requiredText(payload.branchId, "branchId", 160);
  const expectedPackageLockVersion = exactInteger(payload.expectedPackageLockVersion, "expectedPackageLockVersion", 1, 2_147_483_647);
  const expectedBranchLockVersion = exactInteger(payload.expectedBranchLockVersion, "expectedBranchLockVersion", 1, 2_147_483_647);
  const expectedHeadCompositionId = requiredText(payload.expectedHeadCompositionId, "expectedHeadCompositionId", 160);
  const expectedHeadRevisionId = requiredText(payload.expectedHeadRevisionId, "expectedHeadRevisionId", 160);
  const root = await packageRow(db, ownerPackageId);
  if (Number(root.lock_version) !== expectedPackageLockVersion || root.status !== "active") {
    throw new ProjectPackageApiError("PACKAGE_CAS_CONFLICT", "设置 primary 分支时 Package 元数据已变化", 409, {
      currentLockVersion: Number(root.lock_version),
    });
  }
  const selected = await loadSelectedPackageBranch(db, root, branchId, true);
  if (selected.branchState.lockVersion !== expectedBranchLockVersion
    || selected.branchState.headCompositionId !== expectedHeadCompositionId
    || selected.branchState.headRevisionId !== expectedHeadRevisionId) {
    throw new ProjectPackageApiError("PACKAGE_BRANCH_CAS_CONFLICT", "目标分支 head 或 lockVersion 已变化", 409);
  }
  if (root.primary_branch_id === branchId
    && root.main_composition_id === expectedHeadCompositionId
    && root.main_composition_sha256 === selected.branchState.headCompositionSha256) {
    return {
      data: {
        package: parsePackageRow(root), selectedBranchId: branchId,
        branchState: selected.branchState, workingCopy: selected.workingCopy,
        branchWorkingCopy: selected.workingCopy, branchCommit: selected.branchCommit,
        unchanged: true, boundary: { branchAdvanced: false, articleBranchAdvanced: false, primaryChanged: false },
      },
    };
  }
  const now = isoNow();
  const rootUpdate = db.prepare(`UPDATE article_project_packages
    SET primary_branch_id = ?, main_composition_id = ?, main_composition_sha256 = ?,
      title = ?, lock_version = lock_version + 1, updated_at = ?
    WHERE id = ? AND status = 'active' AND branch_model_version = 2 AND lock_version = ?
      AND EXISTS (SELECT 1 FROM package_branch_states state
        JOIN package_branch_working_copies copy ON copy.package_id = state.package_id AND copy.branch_id = state.branch_id
        WHERE state.package_id = article_project_packages.id AND state.branch_id = ?
          AND state.head_composition_id = ? AND state.head_revision_id = ? AND state.lock_version = ?
          AND copy.base_composition_id = state.head_composition_id AND copy.base_revision_id = state.head_revision_id)`)
    .bind(branchId, expectedHeadCompositionId, selected.branchState.headCompositionSha256,
      String(selected.composition.title), now, ownerPackageId, expectedPackageLockVersion,
      branchId, expectedHeadCompositionId, expectedHeadRevisionId, expectedBranchLockVersion);
  const legacyMirror = db.prepare(`UPDATE package_working_copies
    SET branch_id = ?, base_composition_id = ?, base_revision_id = ?, document_json = ?,
      document_sha256 = ?, dirty = ?, lock_version = ?, updated_at = ?
    WHERE package_id = ?
      AND EXISTS (SELECT 1 FROM article_project_packages WHERE id = ? AND primary_branch_id = ?
        AND main_composition_id = ? AND lock_version = ?)`)
    .bind(branchId, selected.workingCopy.baseCompositionId, selected.workingCopy.baseRevisionId,
      canonicalJson(selected.workingCopy.document), selected.workingCopy.documentSha256,
      selected.workingCopy.dirty ? 1 : 0, selected.workingCopy.lockVersion, selected.workingCopy.updatedAt,
      ownerPackageId, ownerPackageId, branchId, expectedHeadCompositionId, expectedPackageLockVersion + 1);
  const event = db.prepare(`INSERT INTO workspace_events
    (id, event_type, subject_type, subject_id, article_id, payload_json, input_sha256, created_at)
    SELECT ?, 'package.primary_branch_changed', 'article_project_package', ?, ?, ?, ?, ?
    WHERE EXISTS (SELECT 1 FROM article_project_packages WHERE id = ? AND primary_branch_id = ?
      AND main_composition_id = ? AND lock_version = ?)`)
    .bind(`workspace-event-${crypto.randomUUID()}`, ownerPackageId, root.article_id,
      canonicalJson({ packageId: ownerPackageId, previousPrimaryBranchId: root.primary_branch_id,
        primaryBranchId: branchId, compositionId: expectedHeadCompositionId,
        branchAdvanced: false, articleBranchAdvanced: false }), inputSha256, now,
      ownerPackageId, branchId, expectedHeadCompositionId, expectedPackageLockVersion + 1);
  const sentinel = db.prepare(`SELECT CASE WHEN EXISTS (
      SELECT 1 FROM article_project_packages root
      JOIN package_branch_states state ON state.package_id = root.id AND state.branch_id = root.primary_branch_id
      JOIN package_branch_working_copies branch_copy
        ON branch_copy.package_id = state.package_id AND branch_copy.branch_id = state.branch_id
      JOIN package_working_copies legacy ON legacy.package_id = root.id
      WHERE root.id = ? AND root.primary_branch_id = ? AND root.main_composition_id = state.head_composition_id
        AND root.main_composition_sha256 = state.head_composition_sha256
        AND state.head_composition_id = ? AND state.head_revision_id = ? AND state.lock_version = ?
        AND legacy.branch_id = state.branch_id AND legacy.base_composition_id = branch_copy.base_composition_id
        AND legacy.base_revision_id = branch_copy.base_revision_id
        AND legacy.document_sha256 = branch_copy.document_sha256 AND legacy.lock_version = branch_copy.lock_version
    ) THEN 1 ELSE json('wenmai-0010-set-primary-incomplete') END AS committed`)
    .bind(ownerPackageId, branchId, expectedHeadCompositionId, expectedHeadRevisionId, expectedBranchLockVersion);
  const results = await db.batch([rootUpdate, legacyMirror, event, sentinel]);
  if (resultChanges(results[0]) !== 1) throw new ProjectPackageApiError("PACKAGE_CAS_CONFLICT", "设置 primary 分支发生并发冲突", 409);
  const nextRoot = await packageRow(db, ownerPackageId);
  const next = await loadSelectedPackageBranch(db, nextRoot, branchId);
  return {
    data: {
      package: parsePackageRow(nextRoot), selectedBranchId: branchId,
      branchState: next.branchState, branchWorkingCopy: next.workingCopy, workingCopy: next.workingCopy,
      branchCommit: next.branchCommit, branchBridge: next.branchBridge, unchanged: false,
      boundary: { branchAdvanced: false, articleBranchAdvanced: false, primaryChanged: true, packageMainAdvanced: true },
    },
  };
}

async function ensureFromRevision(db: D1Database, payload: JsonObject, inputSha256: string) {
  const articleId = requiredText(payload.articleId, "articleId", 160);
  const revisionId = requiredText(payload.revisionId, "revisionId", 160);
  const expectedBodySha256 = exactSha256(payload.expectedBodySha256, "expectedBodySha256");
  const projectId = optionalText(payload.projectId, 160) || null;
  const revisionStorage = await db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'article_revisions' LIMIT 1")
    .first<D1Row>();
  if (!revisionStorage) {
    throw new ProjectPackageApiError("REVISION_STORAGE_UNAVAILABLE", "文章修订存储尚未初始化，请先打开一次文章工作区", 503);
  }
  const revision = await db.prepare("SELECT * FROM article_revisions WHERE id = ? LIMIT 1").bind(revisionId).first<D1Row>();
  if (!revision || revision.article_id !== articleId) {
    throw new ProjectPackageApiError("ARTICLE_REVISION_NOT_FOUND", "文章修订不存在或不属于指定文章", 404, { revisionId, articleId });
  }
  if (revision.body_sha256 !== expectedBodySha256) {
    throw new ProjectPackageApiError("ARTICLE_REVISION_SHA_MISMATCH", "文章修订正文摘要与请求不一致", 409, { currentBodySha256: revision.body_sha256 });
  }
  const title = optionalText(payload.title, 300) || String(revision.document_title ?? revision.title);
  const bodyText = String(revision.body_text ?? "");
  if (new TextEncoder().encode(bodyText).byteLength > 2_000_000) {
    throw new ProjectPackageApiError("DOCUMENT_TOO_LARGE", "文章修订正文超过 Package 导入上限", 413);
  }
  const revisionBranchId = String(revision.branch_id ?? "");
  if (!revisionBranchId) {
    throw new ProjectPackageApiError("REVISION_BRANCH_REQUIRED", "文章修订没有可绑定的 ArticleBranch 身份", 409, { revisionId });
  }
  const requestedBranchId = optionalText(payload.branchId, 160) || revisionBranchId;
  if (requestedBranchId !== revisionBranchId) {
    throw new ProjectPackageApiError("REVISION_BRANCH_MISMATCH", "ensure_from_revision 必须绑定该 revision 所属的 ArticleBranch", 409, {
      revisionBranchId, requestedBranchId,
    });
  }
  const branchBinding = await cleanBranchBinding(db, articleId, requestedBranchId, revisionId, expectedBodySha256);
  return createInitialPackage(db, {
    articleId, projectId, title, bodyText, sourceArticleRevisionId: revisionId, authorKind: "import", branchBinding,
  }, inputSha256);
}

async function createFromText(
  db: D1Database,
  payload: JsonObject,
  inputSha256: string,
  options: { authorKind?: "user" | "agent" | "import"; document?: PackageDocument } = {},
) {
  const articleId = requiredText(payload.articleId, "articleId", 160);
  const projectId = optionalText(payload.projectId, 160) || null;
  const title = requiredText(payload.title, "title", 300);
  const bodyText = requiredText(payload.bodyText, "bodyText", 2_000_000, true);
  let importWorkflow: ImportWorkflowMetadata | undefined;
  if (payload.importWorkflow !== undefined) {
    try {
      importWorkflow = parseImportWorkflowMetadata(
        payload.importWorkflow,
        exactSha256(payload.sourceFingerprintSha256, "sourceFingerprintSha256"),
      );
    } catch (error) {
      if (error instanceof ImportProfileContractError) {
        throw new ProjectPackageApiError(error.code, error.message, 400);
      }
      throw error;
    }
  }
  const branchId = optionalText(payload.branchId, 160) || null;
  const branchBinding = branchId
    ? await cleanBranchBinding(
      db, articleId, branchId,
      requiredText(payload.expectedBranchHeadRevisionId, "expectedBranchHeadRevisionId", 160),
      exactSha256(payload.expectedBranchHeadBodySha256, "expectedBranchHeadBodySha256"),
    )
    : undefined;
  return createInitialPackage(db, {
    articleId, projectId, title, bodyText, sourceArticleRevisionId: branchBinding?.headRevisionId ?? null,
    authorKind: options.authorKind ?? "user", ...(options.document ? { document: options.document } : {}),
    ...(branchBinding ? { branchBinding } : {}), ...(importWorkflow ? { importWorkflow } : {}),
  }, inputSha256);
}

type LocalImportCreateInput = {
  commandId: string;
  articleId: string;
  projectId: string;
  title: string;
  bodyText: string;
  bodySha256: string;
  bodySha256Basis?: "canonical_utf8_text_after_bom_removal_and_newline_normalization";
  originalFileBytesVerified?: false;
  sourceName: string;
  format: "markdown" | "text";
  intake: LocalImportIntakeDeclaration;
};

const LOCAL_IMPORT_BODY_SHA256_BASIS = "canonical_utf8_text_after_bom_removal_and_newline_normalization" as const;

function localImportRecordIncomplete(message: string, issues: string[], details: JsonObject = {}): never {
  throw new ProjectPackageApiError("LOCAL_IMPORT_RECORD_INCOMPLETE", message, 409, {
    issues: [...new Set(issues)].sort(),
    ...details,
  });
}

async function verifyLocalImportStorage(db: D1Database, input: {
  root: D1Row;
  compositionRow: D1Row;
  workingRow: D1Row;
  bridgeState: PackageBranchBridgeState;
  document: PackageDocument;
  expectedBodySha256: string;
}) {
  const packageIdValue = String(input.root.id);
  const compositionIdValue = String(input.compositionRow.id);
  const branchIdValue = String(input.bridgeState.row.branch_id);
  let canonicalDocument: PackageDocument;
  let canonicalDocumentSha256: string;
  let rendered: ReturnType<typeof renderPackageDocument>;
  let renderedBodySha256: string;
  try {
    canonicalDocument = await prepareDocument(db, packageIdValue, input.document, input.document) as PackageDocument;
    canonicalDocumentSha256 = await documentSha(canonicalDocument);
    rendered = renderPackageDocument(canonicalDocument);
    renderedBodySha256 = await sha256Text(rendered.bodyText);
  } catch (error) {
    const cause = error instanceof ProjectPackageApiError ? error.code : "CANONICAL_DOCUMENT_INVALID";
    return localImportRecordIncomplete("本机导入的 canonical Document 无法重建", [cause]);
  }
  const [sources, assets, modules, nodeRevisions, refs, edges, packageBranchState, packageBranchWorking] = await Promise.all([
    db.prepare("SELECT * FROM package_source_refs WHERE package_id = ? ORDER BY source_key ASC")
      .bind(packageIdValue).all<D1Row>(),
    db.prepare("SELECT * FROM package_assets WHERE package_id = ? ORDER BY asset_key ASC")
      .bind(packageIdValue).all<D1Row>(),
    db.prepare("SELECT * FROM package_modules WHERE package_id = ? ORDER BY module_key ASC")
      .bind(packageIdValue).all<D1Row>(),
    db.prepare(`SELECT node.id AS node_id, node.module_id, node.module_revision_id, node.node_key, node.ordinal,
        module.id AS module_record_id, module.module_key, module.module_kind,
        revision.module_id AS revision_module_id, revision.title AS revision_title,
        revision.content_format, revision.content_text, revision.content_json, revision.content_sha256,
        revision.metadata_json, revision.revision_sha256
      FROM package_composition_nodes node
      JOIN package_modules module ON module.id = node.module_id AND module.package_id = node.package_id
      JOIN package_module_revisions revision ON revision.id = node.module_revision_id
        AND revision.module_id = node.module_id AND revision.package_id = node.package_id
      WHERE node.package_id = ? AND node.composition_id = ? ORDER BY node.ordinal ASC, node.node_key ASC`)
      .bind(packageIdValue, compositionIdValue).all<D1Row>(),
    db.prepare(`SELECT ref.*, node.node_key,
        source.source_key AS source_key, asset.asset_key AS asset_key
      FROM package_composition_nodes node
      JOIN package_module_revision_refs ref ON ref.package_id = node.package_id
        AND ref.module_revision_id = node.module_revision_id
      LEFT JOIN package_source_refs source ON ref.ref_kind = 'source' AND source.id = ref.ref_id AND source.package_id = ref.package_id
      LEFT JOIN package_assets asset ON ref.ref_kind = 'asset' AND asset.id = ref.ref_id AND asset.package_id = ref.package_id
      WHERE node.package_id = ? AND node.composition_id = ?
      ORDER BY node.ordinal ASC, ref.ref_kind ASC, ref.ref_id ASC, ref.relation_type ASC`)
      .bind(packageIdValue, compositionIdValue).all<D1Row>(),
    db.prepare("SELECT * FROM package_composition_edges WHERE package_id = ? AND composition_id = ? ORDER BY edge_key ASC")
      .bind(packageIdValue, compositionIdValue).all<D1Row>(),
    db.prepare("SELECT * FROM package_branch_states WHERE package_id = ? AND branch_id = ? LIMIT 1")
      .bind(packageIdValue, branchIdValue).first<D1Row>(),
    db.prepare("SELECT * FROM package_branch_working_copies WHERE package_id = ? AND branch_id = ? LIMIT 1")
      .bind(packageIdValue, branchIdValue).first<D1Row>(),
  ]);
  const issues: string[] = [];
  const expect = (condition: boolean, issue: string) => { if (!condition) issues.push(issue); };
  const canonicalDocumentJson = canonicalJson(canonicalDocument);
  expect(canonicalJson(input.document) === canonicalDocumentJson, "DOCUMENT_NOT_CANONICAL");
  expect(String(input.compositionRow.document_sha256) === canonicalDocumentSha256, "COMPOSITION_DOCUMENT_SHA_MISMATCH");
  expect(String(input.compositionRow.document_json) === canonicalDocumentJson, "COMPOSITION_DOCUMENT_JSON_MISMATCH");
  expect(String(input.compositionRow.title) === canonicalDocument.title, "COMPOSITION_TITLE_MISMATCH");
  expect(String(input.root.title) === canonicalDocument.title, "PACKAGE_TITLE_MISMATCH");
  expect(String(input.root.main_composition_id) === compositionIdValue, "PACKAGE_COMPOSITION_ID_MISMATCH");
  expect(String(input.root.main_composition_sha256) === String(input.compositionRow.composition_sha256), "PACKAGE_COMPOSITION_SHA_MISMATCH");
  const packageWorkingDocument = parseJson<PackageDocument>(input.workingRow.document_json, {} as PackageDocument);
  const packageWorkingDocumentSha256 = await documentSha(packageWorkingDocument);
  expect(String(input.workingRow.document_sha256) === packageWorkingDocumentSha256, "PACKAGE_WORKING_DOCUMENT_SHA_INVALID");
  expect(packageWorkingDocumentSha256 === canonicalDocumentSha256, "PACKAGE_WORKING_DOCUMENT_SHA_MISMATCH");
  expect(canonicalJson(packageWorkingDocument) === canonicalDocumentJson, "PACKAGE_WORKING_DOCUMENT_JSON_MISMATCH");
  expect(String(input.workingRow.base_composition_id) === compositionIdValue, "PACKAGE_WORKING_COMPOSITION_ID_MISMATCH");
  expect(String(input.workingRow.base_revision_id) === String(input.bridgeState.row.head_revision_id), "PACKAGE_WORKING_REVISION_ID_MISMATCH");
  expect(Number(input.workingRow.dirty) === 0, "PACKAGE_WORKING_DIRTY");
  expect(Boolean(packageBranchState), "PACKAGE_BRANCH_STATE_MISSING");
  expect(Boolean(packageBranchWorking), "PACKAGE_BRANCH_WORKING_MISSING");
  if (packageBranchState) {
    expect(String(packageBranchState.status) === "active", "PACKAGE_BRANCH_STATE_INACTIVE");
    expect(String(packageBranchState.head_composition_id) === compositionIdValue, "BRANCH_COMPOSITION_ID_MISMATCH");
    expect(String(packageBranchState.head_composition_sha256) === String(input.compositionRow.composition_sha256), "BRANCH_COMPOSITION_SHA_MISMATCH");
    expect(String(packageBranchState.head_revision_id) === String(input.bridgeState.row.head_revision_id), "BRANCH_REVISION_ID_MISMATCH");
  }
  if (packageBranchWorking) {
    const branchDocument = parseJson<PackageDocument>(packageBranchWorking.document_json, {} as PackageDocument);
    const branchDocumentSha256 = await documentSha(branchDocument);
    expect(String(packageBranchWorking.document_sha256) === branchDocumentSha256, "BRANCH_WORKING_DOCUMENT_SHA_INVALID");
    expect(branchDocumentSha256 === canonicalDocumentSha256, "BRANCH_WORKING_DOCUMENT_SHA_MISMATCH");
    expect(canonicalJson(branchDocument) === canonicalDocumentJson, "BRANCH_WORKING_DOCUMENT_JSON_MISMATCH");
    expect(String(packageBranchWorking.base_composition_id) === compositionIdValue, "BRANCH_WORKING_COMPOSITION_ID_MISMATCH");
    expect(String(packageBranchWorking.base_revision_id) === String(input.bridgeState.row.head_revision_id), "BRANCH_WORKING_REVISION_ID_MISMATCH");
    expect(Number(packageBranchWorking.dirty) === 0, "BRANCH_PACKAGE_WORKING_DIRTY");
  }
  const materialization = input.bridgeState.materialization;
  expect(Boolean(materialization), "MATERIALIZATION_MISSING");
  if (materialization) {
    expect(String(materialization.composition_id) === compositionIdValue, "MATERIALIZATION_COMPOSITION_ID_MISMATCH");
    expect(String(materialization.composition_sha256) === String(input.compositionRow.composition_sha256), "MATERIALIZATION_COMPOSITION_SHA_MISMATCH");
    expect(String(materialization.article_revision_id) === String(input.bridgeState.row.head_revision_id), "MATERIALIZATION_REVISION_ID_MISMATCH");
    expect(String(materialization.article_body_sha256) === renderedBodySha256, "MATERIALIZATION_BODY_SHA_MISMATCH");
  }
  expect(renderedBodySha256 === input.expectedBodySha256, "RENDERED_BODY_SHA_MISMATCH");
  expect(String(input.bridgeState.row.head_body_sha256) === renderedBodySha256, "ARTICLE_HEAD_BODY_SHA_MISMATCH");
  expect(await sha256Text(String(input.bridgeState.row.head_body_text)) === renderedBodySha256, "ARTICLE_HEAD_BODY_TEXT_MISMATCH");
  expect(String(input.bridgeState.row.branch_working_body_sha256) === renderedBodySha256, "ARTICLE_WORKING_BODY_SHA_MISMATCH");
  expect(await sha256Text(String(input.bridgeState.row.branch_working_body_text)) === renderedBodySha256, "ARTICLE_WORKING_BODY_TEXT_MISMATCH");
  expect(Number(input.bridgeState.row.branch_working_dirty) === 0, "ARTICLE_WORKING_DIRTY");

  expect(sources.results.length === canonicalDocument.sources.length, "SOURCE_COUNT_MISMATCH");
  const sourceRows = new Map(sources.results.map((row) => [String(row.source_key), row]));
  for (const source of canonicalDocument.sources) {
    const row = sourceRows.get(source.key);
    if (!row) { issues.push(`SOURCE_MISSING:${source.key}`); continue; }
    const expectedRefSha256 = await sha256Text(canonicalJson({
      sourceKind: source.sourceKind, canonicalRef: source.canonicalRef, title: source.title,
      capturedAt: source.capturedAt ?? null, contentSha256: source.contentSha256 ?? null,
      excerpt: source.excerpt ?? "", metadata: source.metadata ?? {}, rights: source.rights ?? {},
    }));
    expect(String(row.id) === source.id, `SOURCE_ID_MISMATCH:${source.key}`);
    expect(String(row.source_kind) === source.sourceKind, `SOURCE_KIND_MISMATCH:${source.key}`);
    expect(String(row.canonical_ref) === source.canonicalRef, `SOURCE_REF_MISMATCH:${source.key}`);
    expect(String(row.title) === source.title, `SOURCE_TITLE_MISMATCH:${source.key}`);
    expect((row.captured_at === null ? null : String(row.captured_at)) === (source.capturedAt ?? null), `SOURCE_CAPTURED_AT_MISMATCH:${source.key}`);
    expect((row.content_sha256 === null ? null : String(row.content_sha256)) === (source.contentSha256 ?? null), `SOURCE_CONTENT_SHA_MISMATCH:${source.key}`);
    expect(String(row.excerpt) === (source.excerpt ?? ""), `SOURCE_EXCERPT_MISMATCH:${source.key}`);
    expect(canonicalJson(parseJson(row.metadata_json, {})) === canonicalJson(source.metadata ?? {}), `SOURCE_METADATA_MISMATCH:${source.key}`);
    expect(canonicalJson(parseJson(row.rights_json, {})) === canonicalJson(source.rights ?? {}), `SOURCE_RIGHTS_MISMATCH:${source.key}`);
    expect(String(row.ref_sha256) === expectedRefSha256, `SOURCE_REF_SHA_MISMATCH:${source.key}`);
  }
  expect(assets.results.length === canonicalDocument.assets.length, "ASSET_COUNT_MISMATCH");
  expect(modules.results.length === canonicalDocument.modules.length, "MODULE_COUNT_MISMATCH");
  expect(nodeRevisions.results.length === canonicalDocument.modules.length, "COMPOSITION_NODE_COUNT_MISMATCH");
  const moduleRows = new Map(modules.results.map((row) => [String(row.module_key), row]));
  const nodeRows = new Map(nodeRevisions.results.map((row) => [String(row.node_key), row]));
  const nodeIdByKey = new Map(nodeRevisions.results.map((row) => [String(row.node_key), String(row.node_id)]));
  for (let index = 0; index < canonicalDocument.modules.length; index += 1) {
    const moduleItem = canonicalDocument.modules[index];
    const moduleRow = moduleRows.get(moduleItem.key);
    const node = nodeRows.get(moduleItem.key);
    if (!moduleRow || !node) { issues.push(`MODULE_OR_NODE_MISSING:${moduleItem.key}`); continue; }
    const format = moduleItem.contentFormat ?? "markdown";
    const contentText = format === "json" ? "" : moduleItem.contentText ?? "";
    const contentJson = format === "json" ? canonicalJson(moduleItem.content ?? {}) : "{}";
    const contentSha256 = await sha256Text(format === "json" ? contentJson : contentText);
    expect(String(moduleRow.id) === moduleItem.id, `MODULE_ID_MISMATCH:${moduleItem.key}`);
    expect(String(moduleRow.module_kind) === moduleItem.kind, `MODULE_KIND_MISMATCH:${moduleItem.key}`);
    expect(String(node.module_id) === moduleItem.id, `NODE_MODULE_ID_MISMATCH:${moduleItem.key}`);
    expect(String(node.module_record_id) === moduleItem.id, `NODE_MODULE_RECORD_MISMATCH:${moduleItem.key}`);
    expect(Number(node.ordinal) === index, `NODE_ORDINAL_MISMATCH:${moduleItem.key}`);
    expect(String(node.revision_module_id) === moduleItem.id, `REVISION_MODULE_ID_MISMATCH:${moduleItem.key}`);
    expect(String(node.revision_title) === moduleItem.title, `REVISION_TITLE_MISMATCH:${moduleItem.key}`);
    expect(String(node.content_format) === format, `REVISION_FORMAT_MISMATCH:${moduleItem.key}`);
    expect(String(node.content_text) === contentText, `REVISION_TEXT_MISMATCH:${moduleItem.key}`);
    expect(String(node.content_json) === contentJson, `REVISION_JSON_MISMATCH:${moduleItem.key}`);
    expect(String(node.content_sha256) === contentSha256, `REVISION_CONTENT_SHA_MISMATCH:${moduleItem.key}`);
    expect(canonicalJson(parseJson(node.metadata_json, {})) === canonicalJson(moduleItem.metadata ?? {}), `REVISION_METADATA_MISMATCH:${moduleItem.key}`);
  }
  const rootModule = canonicalDocument.modules.find((module) => module.key === canonicalDocument.rootModuleKey);
  expect(Boolean(rootModule?.id) && String(input.compositionRow.root_module_id) === rootModule?.id, "ROOT_MODULE_ID_MISMATCH");
  const expectedRefCount = canonicalDocument.modules.reduce((count, module) => count + (module.refs?.length ?? 0), 0);
  expect(refs.results.length === expectedRefCount, "MODULE_REF_COUNT_MISMATCH");
  for (const moduleItem of canonicalDocument.modules) {
    const revisionId = nodeRows.get(moduleItem.key)?.module_revision_id;
    for (const ref of moduleItem.refs ?? []) {
      const target = ref.refKind === "source"
        ? canonicalDocument.sources.find((source) => source.key === ref.refKey)
        : canonicalDocument.assets.find((asset) => asset.key === ref.refKey);
      const row = refs.results.find((candidate) => candidate.module_revision_id === revisionId
        && candidate.ref_kind === ref.refKind && candidate.ref_id === target?.id
        && candidate.relation_type === ref.relationType);
      if (!row) { issues.push(`MODULE_REF_MISSING:${moduleItem.key}:${ref.refKey}`); continue; }
      expect((ref.refKind === "source" ? row.source_key : row.asset_key) === ref.refKey, `MODULE_REF_KEY_MISMATCH:${moduleItem.key}:${ref.refKey}`);
      expect(canonicalJson(parseJson(row.anchor_json, {})) === canonicalJson(ref.anchor ?? {}), `MODULE_REF_ANCHOR_MISMATCH:${moduleItem.key}:${ref.refKey}`);
    }
  }
  expect(edges.results.length === canonicalDocument.edges.length, "EDGE_COUNT_MISMATCH");
  const edgeRows = new Map(edges.results.map((row) => [String(row.edge_key), row]));
  for (const edge of canonicalDocument.edges) {
    const row = edgeRows.get(edge.key);
    if (!row) { issues.push(`EDGE_MISSING:${edge.key}`); continue; }
    const expectedEdgeSha256 = await sha256Text(canonicalJson({
      edgeKey: edge.key, sourceModuleKey: edge.sourceModuleKey, targetModuleKey: edge.targetModuleKey,
      relationType: edge.relationType, ordinal: edge.ordinal ?? 0, condition: edge.condition ?? {},
    }));
    expect(String(row.source_node_id) === nodeIdByKey.get(edge.sourceModuleKey), `EDGE_SOURCE_MISMATCH:${edge.key}`);
    expect(String(row.target_node_id) === nodeIdByKey.get(edge.targetModuleKey), `EDGE_TARGET_MISMATCH:${edge.key}`);
    expect(String(row.relation_type) === edge.relationType, `EDGE_RELATION_MISMATCH:${edge.key}`);
    expect(Number(row.ordinal) === (edge.ordinal ?? 0), `EDGE_ORDINAL_MISMATCH:${edge.key}`);
    expect(canonicalJson(parseJson(row.condition_json, {})) === canonicalJson(edge.condition ?? {}), `EDGE_CONDITION_MISMATCH:${edge.key}`);
    expect(String(row.edge_sha256) === expectedEdgeSha256, `EDGE_SHA_MISMATCH:${edge.key}`);
  }
  const manifest = parseJson<JsonObject>(input.compositionRow.manifest_json, {});
  const manifestModules = Array.isArray(manifest.modules) ? manifest.modules : [];
  const manifestSources = Array.isArray(manifest.sources) ? manifest.sources : [];
  const manifestEdges = Array.isArray(manifest.edges) ? manifest.edges : [];
  expect(manifest.documentSha256 === canonicalDocumentSha256, "MANIFEST_DOCUMENT_SHA_MISMATCH");
  expect(manifest.rootModuleKey === canonicalDocument.rootModuleKey, "MANIFEST_ROOT_KEY_MISMATCH");
  expect(manifest.rootModuleId === rootModule?.id, "MANIFEST_ROOT_ID_MISMATCH");
  expect(manifestModules.length === canonicalDocument.modules.length, "MANIFEST_MODULE_COUNT_MISMATCH");
  expect(manifestSources.length === canonicalDocument.sources.length, "MANIFEST_SOURCE_COUNT_MISMATCH");
  expect(manifestEdges.length === canonicalDocument.edges.length, "MANIFEST_EDGE_COUNT_MISMATCH");
  if (issues.length) {
    return localImportRecordIncomplete("本机导入的规范化存储投影读回不一致", issues, {
      packageId: packageIdValue, compositionId: compositionIdValue, branchId: branchIdValue,
      canonicalDocumentSha256, renderedBodySha256,
    });
  }
  return {
    canonicalDocument,
    canonicalDocumentSha256,
    renderedBodySha256,
    packageBranchState,
    storageProjectionVerified: true as const,
  };
}

async function localImportSnapshot(
  db: D1Database,
  articleId: string,
  expectedTitle: string | null,
  expectedBodySha256: string,
) {
  const root = await db.prepare("SELECT * FROM article_project_packages WHERE article_id = ? LIMIT 1")
    .bind(articleId).first<D1Row>();
  if (!root) {
    throw new ProjectPackageApiError("LOCAL_IMPORT_RECORD_NOT_FOUND", "本机导入记录不存在", 404, { articleId });
  }
  const state = await currentPackageState(db, String(root.id));
  const bridgeState = await packageBranchBridgeState(db, state.root, state.working);
  const packageValue = parsePackageRow(state.root);
  const composition = parseCompositionRow(state.composition, true);
  const workingCopy = parseWorkingRow(state.working);
  const branchBridge = parsePackageBranchBridge(state.root, state.working, bridgeState);
  const document = composition.document as PackageDocument;
  const bodySha256 = branchBridge?.headBodySha256 ?? "";
  const titleMatches = expectedTitle === null
    || (packageValue.title === expectedTitle && composition.title === expectedTitle && document.title === expectedTitle);
  if (!titleMatches) {
    throw new ProjectPackageApiError("LOCAL_IMPORT_TITLE_CONFLICT", "同一内容身份已经绑定不同标题", 409, {
      articleId,
      currentTitle: packageValue.title,
    });
  }
  if (bodySha256 !== expectedBodySha256) {
    throw new ProjectPackageApiError("LOCAL_IMPORT_BODY_CONFLICT", "同一内容身份的正文摘要不一致", 409, {
      articleId,
      currentBodySha256: bodySha256,
    });
  }
  if (packageValue.status !== "active" || branchBridge?.branchStatus !== "active"
    || workingCopy.dirty || !branchBridge?.inSync) {
    throw new ProjectPackageApiError("LOCAL_IMPORT_RECORD_INCOMPLETE", "本机导入记录未通过 clean/inSync 门禁", 409, {
      articleId,
      packageStatus: packageValue.status,
      branchStatus: branchBridge?.branchStatus ?? null,
      workingCopyDirty: workingCopy.dirty,
      branchBridgeInSync: branchBridge?.inSync ?? false,
    });
  }
  if (!bridgeState) {
    return localImportRecordIncomplete("本机导入记录缺少 Article/Package 物化桥", ["PACKAGE_BRANCH_BRIDGE_MISSING"], { articleId });
  }
  const storage = await verifyLocalImportStorage(db, {
    root: state.root, compositionRow: state.composition, workingRow: state.working,
    bridgeState, document, expectedBodySha256,
  });
  const verifiedDocument = storage.canonicalDocument;
  const persistedImport = persistedLocalImportIdentity(verifiedDocument, expectedBodySha256);
  const packageBranchState = storage.packageBranchState!;
  const checklistBindings = {
    articleId: packageValue.articleId,
    projectId: packageValue.projectId,
    packageId: packageValue.id,
    branchId: branchBridge.branchId,
    revisionId: branchBridge.headRevisionId,
    compositionId: composition.id,
    bodySha256,
    compositionSha256: composition.compositionSha256,
    documentSha256: storage.canonicalDocumentSha256,
    packageLockVersion: packageValue.lockVersion,
    branchLockVersion: Number(packageBranchState.lock_version),
    workingCopyLockVersion: workingCopy.lockVersion,
  };
  const checklistInput = {
    document: verifiedDocument,
    packageStatus: packageValue.status,
    branchStatus: branchBridge.branchStatus,
    workingCopyDirty: workingCopy.dirty,
    branchBridgeInSync: branchBridge.inSync,
    bindings: checklistBindings,
  };
  const baselineChecklist = await buildArticleGuidanceChecklist(checklistInput);
  const verifiedDecision = await loadLatestVerifiedArticleGuidanceDecision(db, {
    ...checklistBindings,
    baselineChecklistSha256: baselineChecklist.checklistSha256,
  });
  const guidanceChecklist = verifiedDecision
    ? await buildArticleGuidanceChecklist({ ...checklistInput, verifiedDecision })
    : baselineChecklist;
  return {
    articleId: packageValue.articleId,
    title: packageValue.title,
    projectId: packageValue.projectId,
    packageId: packageValue.id,
    branchId: branchBridge.branchId,
    revisionId: branchBridge.headRevisionId,
    compositionId: composition.id,
    bodySha256,
    bodySha256Basis: LOCAL_IMPORT_BODY_SHA256_BASIS,
    originalFileBytesVerified: false,
    compositionSha256: composition.compositionSha256,
    documentSha256: storage.canonicalDocumentSha256,
    packageStatus: packageValue.status,
    branchStatus: branchBridge.branchStatus,
    workingCopyDirty: workingCopy.dirty,
    branchBridgeInSync: branchBridge.inSync,
    storageProjectionVerified: storage.storageProjectionVerified,
    sourceName: persistedImport.sourceName,
    format: persistedImport.format,
    intake: persistedImport.intake,
    archiveRecordVerified: guidanceChecklist.archiveReady,
    guidedAgentWorkReady: guidanceChecklist.editorialWorkReady,
    guidanceChecklist,
  };
}

function persistedLocalImportIdentity(document: PackageDocument, expectedBodySha256: string) {
  const incomplete = (reason: string, details: JsonObject = {}) => {
    throw new ProjectPackageApiError("LOCAL_IMPORT_RECORD_INCOMPLETE", reason, 409, details);
  };
  const sources = Array.isArray(document.sources)
    ? document.sources.filter((source) => source.contentSha256 === expectedBodySha256)
    : [];
  if (sources.length !== 1) {
    return incomplete("本机导入记录未唯一绑定正文 SourceRef", { matchingSources: sources.length });
  }
  const source = sources[0];
  const sourceMetadata = isObject(source.metadata) ? source.metadata : {};
  const archiveIntake = isObject(document.metadata?.archiveIntake) ? document.metadata.archiveIntake : null;
  const archiveSource = archiveIntake && isObject(archiveIntake.source) ? archiveIntake.source : null;
  const rawDeclaration = archiveIntake && isObject(archiveIntake.declaration) ? archiveIntake.declaration : null;
  if (!archiveSource || !rawDeclaration) {
    return incomplete("本机导入记录缺少 archiveIntake 来源或声明");
  }
  const sourceName = typeof source.canonicalRef === "string" ? source.canonicalRef : "";
  const archiveSourceName = typeof archiveSource.name === "string" ? archiveSource.name : "";
  const sourceFormat = sourceMetadata.originalFormat;
  const archiveFormat = archiveSource.format;
  if (!sourceName || sourceName !== archiveSourceName || source.title !== sourceName
    || (sourceFormat !== "markdown" && sourceFormat !== "text") || archiveFormat !== sourceFormat
    || archiveSource.bodySha256 !== expectedBodySha256
    || document.metadata?.sourceFingerprintSha256 !== expectedBodySha256) {
    return incomplete("本机导入的 Document、SourceRef 与 archiveIntake 来源身份不一致", {
      sourceName: sourceName || null,
      archiveSourceName: archiveSourceName || null,
      sourceFormat: typeof sourceFormat === "string" ? sourceFormat : null,
      archiveFormat: typeof archiveFormat === "string" ? archiveFormat : null,
    });
  }
  let intake: LocalImportIntakeDeclaration;
  try {
    if (rawDeclaration.declarationState === "policy_defaulted") {
      intake = parseLocalImportIntakeDeclaration(undefined);
    } else if (rawDeclaration.declarationState === "agent_declared") {
      intake = parseLocalImportIntakeDeclaration({
        schemaVersion: rawDeclaration.schemaVersion,
        contentKind: rawDeclaration.contentKind,
        editorialStage: rawDeclaration.editorialStage,
        goal: rawDeclaration.goal,
        audience: rawDeclaration.audience,
        constraints: rawDeclaration.constraints,
      });
    } else {
      return incomplete("本机导入声明缺少可验证的 declarationState");
    }
  } catch {
    return incomplete("本机导入声明不符合冻结契约");
  }
  if (canonicalJson(rawDeclaration) !== canonicalJson(intake)) {
    return incomplete("本机导入声明与冻结契约不一致");
  }
  return { sourceName, format: sourceFormat, intake };
}

function assertLocalImportDeclarationMatches(
  persisted: { sourceName: string; format: "markdown" | "text"; intake: LocalImportIntakeDeclaration },
  requested: Pick<LocalImportCreateInput, "sourceName" | "format" | "intake">,
) {
  const changedFields = [
    ...(persisted.sourceName === requested.sourceName ? [] : ["sourceName"]),
    ...(persisted.format === requested.format ? [] : ["format"]),
    ...(canonicalJson(persisted.intake) === canonicalJson(requested.intake) ? [] : ["intake"]),
  ];
  if (changedFields.length) {
    throw new ProjectPackageApiError(
      "LOCAL_IMPORT_DECLARATION_CONFLICT",
      "同一正文根已绑定不同的来源或建档声明；不得以新请求字段覆盖持久化记录",
      409,
      { changedFields },
    );
  }
}

export async function createLocalImportProjectPackage(
  input: LocalImportCreateInput,
  actorId = "local-import-operator",
) {
  if (!/^[A-Za-z0-9._:-]{1,160}$/u.test(actorId)) {
    throw new ProjectPackageApiError("INVALID_LOCAL_IMPORT_ACTOR", "本机导入身份无效", 400);
  }
  const db = await ensureProjectPackageSchema();
  const receiptPayload: JsonObject = {
    articleId: input.articleId,
    projectId: input.projectId,
    title: input.title,
    bodyText: input.bodyText,
    bodySha256: input.bodySha256,
    bodySha256Basis: input.bodySha256Basis ?? "canonical_utf8_text_after_bom_removal_and_newline_normalization",
    originalFileBytesVerified: false,
    sourceName: input.sourceName,
    format: input.format,
    intake: input.intake,
  };
  const receipt = await withReceipt(
    db,
    "local_import_create_from_text",
    actorId,
    input.commandId,
    receiptPayload,
    async (inputSha256) => {
      const document = buildLocalImportPackageDocument({
        title: input.title,
        bodyText: input.bodyText,
        bodySha256: input.bodySha256,
        sourceName: input.sourceName,
        format: input.format,
        commandId: input.commandId,
        intake: input.intake,
      });
      const created = await createFromText(db, {
        articleId: input.articleId,
        projectId: input.projectId,
        title: input.title,
        bodyText: input.bodyText,
      }, inputSha256, { authorKind: "agent", document });
      const snapshot = await localImportSnapshot(db, input.articleId, input.title, input.bodySha256);
      assertLocalImportDeclarationMatches(snapshot, input);
      return {
        status: created.status,
        data: {
          created: created.data.created === true,
          reused: created.data.reused === true,
        },
      } satisfies MutationResult;
    },
  );
  // CommandReceipt 只证明历史命令结果；无论首次还是 replay，都必须从当前存储重建读回证据。
  const snapshot = await localImportSnapshot(db, input.articleId, input.title, input.bodySha256);
  assertLocalImportDeclarationMatches(snapshot, input);
  return {
    status: receipt.status,
    data: {
      ...snapshot,
      created: receipt.data.created === true,
      reused: receipt.data.reused === true,
      commandReplay: receipt.replayed === true,
      readbackFresh: true,
      boundary: {
        newRootOnly: true,
        existingRootMutated: false,
        externalSideEffects: false,
      },
    },
  } satisfies MutationResult;
}

export async function readLocalImportProjectPackage(articleId: string, expectedBodySha256: string) {
  const db = await ensureProjectPackageSchema();
  return localImportSnapshot(db, articleId, null, expectedBodySha256);
}

async function recommendImportProfile(payload: JsonObject, inputSha256: string): Promise<MutationResult> {
  const formatValue = requiredText(payload.format, "format", 20);
  if (formatValue !== "markdown" && formatValue !== "text" && formatValue !== "wenmai") {
    throw new ProjectPackageApiError("INVALID_IMPORT_FORMAT", "format 必须是 markdown、text 或 wenmai");
  }
  const packageValue = payload.packageSignals === undefined || payload.packageSignals === null
    ? null
    : objectValue(payload.packageSignals, "packageSignals");
  let frozen;
  try {
    const recommendationInput: ImportProfileRequestInput = {
      name: requiredText(payload.name, "name", 300),
      format: formatValue,
      title: requiredText(payload.title, "title", 300),
      text: requiredText(payload.text, "text", 2_000_000, true),
      sourceSha256: exactSha256(payload.sourceFingerprintSha256, "sourceFingerprintSha256"),
      bytes: exactInteger(payload.bytes, "bytes", 0, 2_000_000),
      headings: exactInteger(payload.headings, "headings", 0, 100_000),
      paragraphs: exactInteger(payload.paragraphs, "paragraphs", 0, 100_000),
      packageSignals: packageValue ? {
        modules: exactInteger(packageValue.modules, "packageSignals.modules", 0, 100_000),
        sources: exactInteger(packageValue.sources, "packageSignals.sources", 0, 100_000),
        assets: exactInteger(packageValue.assets, "packageSignals.assets", 0, 100_000),
        hasWorkflowProfile: packageValue.hasWorkflowProfile === true,
      } : null,
    };
    frozen = freezeImportProfileInput(recommendationInput);
  } catch (error) {
    if (error instanceof ImportProfileContractError) {
      throw new ProjectPackageApiError(error.code, error.message, 400);
    }
    throw error;
  }
  const frozenInputSha256 = await sha256Text(canonicalJson(frozen));
  const selectedProvider = payload.recommendationProvider === undefined
    ? "local_rules"
    : requiredText(payload.recommendationProvider, "recommendationProvider", 24);
  if (selectedProvider !== "local_rules"
    && selectedProvider !== "deepseek"
    && selectedProvider !== "qwen"
    && selectedProvider !== "openai"
    && selectedProvider !== "ollama") {
    throw new ProjectPackageApiError("INVALID_IMPORT_RECOMMENDATION_PROVIDER", "recommendationProvider 必须是 local_rules、deepseek、qwen、openai 或 ollama");
  }
  const providerPolicy = selectedProvider === "local_rules" ? "local_rules" : "explicit_single_provider";
  const routeDecisionSha256 = await sha256Text(canonicalJson({
    schemaVersion: "wenmai-import-profile-route-decision/1.0.0",
    frozenInputSha256,
    selectedProvider,
    providerPolicy,
    automaticRetry: false,
  }));
  const routeDecision = {
    selectedProvider,
    providerPolicy,
    frozenInputSha256,
    routeDecisionSha256,
    automaticRetry: false,
  };
  const boundary = {
    recommendationOnly: true,
    humanConfirmationRequired: true,
    bodyDisclosedToModel: false,
    articleMutated: false,
    importCommitted: false,
    automaticRetry: false,
  };
  if (selectedProvider === "local_rules") {
    return {
      data: {
        recommendation: fallbackImportProfileRecommendation(frozen, frozenInputSha256, "LOCAL_RULES_SELECTED"),
        recommendationInputSha256: frozenInputSha256,
        requestReceiptSha256: inputSha256,
        routeDecision,
        boundary,
      },
    };
  }
  const selected = selectedProvider as ModelGatewayProvider;
  if ((selected === "openai" || selected === "ollama") && !extendedProvidersEnabled()) {
    return {
      data: {
        recommendation: fallbackImportProfileRecommendation(frozen, frozenInputSha256, "META_IMPROVEMENT_EXTENDED_PROVIDER_DISABLED"),
        recommendationInputSha256: frozenInputSha256,
        requestReceiptSha256: inputSha256,
        routeDecision,
        boundary,
      },
    };
  }
  const selectedStatus = getModelGatewayProviderStatus(selected, runtimeEnv());
  if (!selectedStatus.ready) {
    return {
      data: {
        recommendation: fallbackImportProfileRecommendation(frozen, frozenInputSha256, "MODEL_PROVIDER_NOT_CONFIGURED"),
        recommendationInputSha256: frozenInputSha256,
        requestReceiptSha256: inputSha256,
        routeDecision,
        boundary,
      },
    };
  }
  const messages = buildImportProfileMessages(frozen);
  let result;
  try {
    result = await requestModelGatewayJson({
      provider: selected,
      env: runtimeEnv(),
      messages,
      maxOutputTokens: 512,
      sampling: { temperature: 0, topP: 1 },
      timeoutMs: 45_000,
    });
  } catch (error) {
    const safe = toModelGatewaySafeError(error);
    return {
      data: {
        recommendation: fallbackImportProfileRecommendation(frozen, frozenInputSha256, safe.code, {
          paidEgressPerformed: true,
          provider: selected,
          model: selectedStatus.model,
        }),
        recommendationInputSha256: frozenInputSha256,
        requestReceiptSha256: inputSha256,
        boundary,
      },
    };
  }
  try {
    const recommendation = parseImportProfileModelOutput(result.value, {
      inputSha256: frozenInputSha256,
      sourceSha256: frozen.source.sourceSha256,
      provider: selected,
      model: result.model,
      egressTextCharacters: 0,
    });
    return {
      data: {
        recommendation,
        recommendationInputSha256: frozenInputSha256,
        requestReceiptSha256: inputSha256,
        usage: result.usage ?? {},
        providerRequestId: result.requestId,
        routeDecision,
        boundary,
      },
    };
  } catch (error) {
    const failureCode = error instanceof ImportProfileContractError
      ? error.code
      : "MODEL_RECOMMENDATION_INVALID";
    return {
      data: {
        recommendation: fallbackImportProfileRecommendation(frozen, frozenInputSha256, failureCode, {
          paidEgressPerformed: true,
          provider: selected,
          model: result.model,
        }),
        recommendationInputSha256: frozenInputSha256,
        requestReceiptSha256: inputSha256,
        routeDecision,
        boundary,
      },
    };
  }
}

async function ensureBranchBridge(db: D1Database, payload: JsonObject, inputSha256: string) {
  const ownerPackageId = requiredText(payload.packageId, "packageId", 160);
  const expectedPackageLockVersion = exactInteger(payload.expectedPackageLockVersion, "expectedPackageLockVersion", 1, 2_147_483_647);
  const requestedBranchId = optionalText(payload.branchId, 160) || null;
  const state = await currentPackageState(db, ownerPackageId);
  assertPackageCas(state.root, expectedPackageLockVersion, String(state.root.main_composition_id), String(state.root.main_composition_sha256));
  if (Number(state.working.dirty) !== 0 || state.working.base_composition_id !== state.root.main_composition_id) {
    throw new ProjectPackageApiError("DIRTY_WORKING_COPY", "Branch bridge 尚未建立；当前 Package 工作副本和主 Composition 均保留。请先提交或恢复工作副本，再重新建立 Branch bridge。", 409);
  }
  const currentBridge = await packageBranchBridgeState(db, state.root, state.working);
  if (currentBridge) {
    if (requestedBranchId && requestedBranchId !== currentBridge.row.branch_id) {
      throw new ProjectPackageApiError("PACKAGE_BRANCH_ALREADY_BOUND", "Package 已绑定另一 ArticleBranch", 409, {
        primaryBranchId: currentBridge.row.branch_id,
      });
    }
    return {
      data: {
        package: parsePackageRow(state.root), composition: parseCompositionRow(state.composition, true),
        workingCopy: parseWorkingRow(state.working), branchBridge: parsePackageBranchBridge(state.root, state.working, currentBridge),
        created: false, reused: true,
        boundary: { packageMainAdvanced: false, compositionCreated: false, revisionCreated: false },
      },
    } satisfies MutationResult;
  }

  const document = parseJson<PackageDocument>(state.composition.document_json, {} as PackageDocument);
  const rendered = renderPackageDocument(document);
  const renderedBodySha256 = await sha256Text(rendered.bodyText);
  const now = isoNow();
  const branchId = requestedBranchId ?? `branch-${crypto.randomUUID()}`;
  let branchName = "";
  let branchSlug = "";
  let previousRevisionId: string | null = null;
  let revisionId = `revision-${crypto.randomUUID()}`;
  let revisionCreated = true;
  const branchCreated = !requestedBranchId;
  let branchWorkingLockVersion = 0;
  let sequence = 1;

  if (requestedBranchId) {
    const expectedBranchHeadRevisionId = requiredText(payload.expectedBranchHeadRevisionId, "expectedBranchHeadRevisionId", 160);
    const expectedBranchHeadBodySha256 = exactSha256(payload.expectedBranchHeadBodySha256, "expectedBranchHeadBodySha256");
    const target = await db.prepare(`SELECT branch.*, head.body_sha256 AS head_body_sha256,
        copy.base_revision_id AS working_base_revision_id, copy.dirty AS working_dirty,
        copy.lock_version AS working_lock_version
      FROM article_branches branch
      JOIN article_revisions head ON head.id = branch.head_revision_id AND head.branch_id = branch.id
      JOIN branch_working_copies copy ON copy.branch_id = branch.id AND copy.article_id = branch.article_id
      WHERE branch.id = ? AND branch.article_id = ? AND branch.status = 'active' LIMIT 1`)
      .bind(requestedBranchId, state.root.article_id).first<D1Row>();
    if (!target) throw new ProjectPackageApiError("BRANCH_NOT_FOUND", "待绑定 ArticleBranch 不存在、不活动或不属于此文章", 404);
    if (target.head_revision_id !== expectedBranchHeadRevisionId || target.head_body_sha256 !== expectedBranchHeadBodySha256) {
      throw new ProjectPackageApiError("BRANCH_HEAD_CAS_CONFLICT", "待绑定 ArticleBranch 头修订已变化", 409, {
        currentHeadRevisionId: target.head_revision_id, currentHeadBodySha256: target.head_body_sha256,
      });
    }
    if (target.working_base_revision_id !== expectedBranchHeadRevisionId || Number(target.working_dirty) !== 0) {
      throw new ProjectPackageApiError("DIRTY_ARTICLE_WORKING_COPY", "待绑定 ArticleBranch 必须处于 clean head", 409);
    }
    branchName = String(target.name);
    branchSlug = String(target.slug);
    previousRevisionId = expectedBranchHeadRevisionId;
    branchWorkingLockVersion = Number(target.working_lock_version);
    if (expectedBranchHeadBodySha256 === renderedBodySha256) {
      revisionId = expectedBranchHeadRevisionId;
      revisionCreated = false;
    } else {
      const sequenceRow = await db.prepare("SELECT COALESCE(MAX(sequence), 0) AS maximum FROM article_revisions WHERE branch_id = ?")
        .bind(branchId).first<D1Row>();
      sequence = Number(sequenceRow?.maximum ?? 0) + 1;
    }
  } else {
    const code = ownerPackageId.replace(/^pkg-/, "").replaceAll("-", "").slice(0, 12);
    branchName = `文章工程/${code}`;
    branchSlug = `project-${code}`;
  }

  const nextPackageLock = expectedPackageLockVersion + 1;
  const rootCas = db.prepare(`UPDATE article_project_packages SET primary_branch_id = ?, lock_version = lock_version + 1, updated_at = ?
    WHERE id = ? AND status = 'active' AND primary_branch_id IS NULL AND lock_version = ?
      AND main_composition_id = ? AND main_composition_sha256 = ?
      AND EXISTS (SELECT 1 FROM package_working_copies
        WHERE package_id = ? AND branch_id IS NULL AND base_revision_id IS NULL
          AND base_composition_id = ? AND dirty = 0)`)
    .bind(
      branchId, now, ownerPackageId, expectedPackageLockVersion,
      state.root.main_composition_id, state.root.main_composition_sha256,
      ownerPackageId, state.root.main_composition_id,
    );
  const statements: D1PreparedStatement[] = [rootCas];
  if (branchCreated) {
    statements.push(
      db.prepare(`INSERT INTO article_revisions
        (id, article_id, branch_id, sequence, parent_revision_id, merge_parent_revision_id, source_version_id,
         title, document_title, annotation, body_text, body_sha256, author_kind, created_at)
        SELECT ?, ?, ?, 1, NULL, NULL, NULL, ?, ?, ?, ?, ?, 'user', ?
        WHERE EXISTS (SELECT 1 FROM article_project_packages WHERE id = ? AND primary_branch_id = ? AND lock_version = ?)`)
        .bind(
          revisionId, state.root.article_id, branchId, `文章工程基线 · ${document.title}`, rendered.documentTitle,
          "由 ensure_branch_bridge 建立的 ArticleProject 基线修订。", rendered.bodyText, renderedBodySha256, now,
          ownerPackageId, branchId, nextPackageLock,
        ),
      db.prepare(`INSERT INTO article_branches
        (id, article_id, name, slug, color, status, head_revision_id, base_revision_id, base_source_version_id, created_at, updated_at)
        SELECT ?, ?, ?, ?, 'cyan', 'active', ?, ?, NULL, ?, ?
        WHERE EXISTS (SELECT 1 FROM article_revisions WHERE id = ? AND branch_id = ? AND body_sha256 = ?)`)
        .bind(branchId, state.root.article_id, branchName, branchSlug, revisionId, revisionId, now, now,
          revisionId, branchId, renderedBodySha256),
      db.prepare(`INSERT INTO branch_working_copies
        (branch_id, article_id, base_revision_id, title, annotation, body_text, body_sha256, dirty, lock_version, updated_at)
        SELECT ?, ?, ?, ?, '', ?, ?, 0, 1, ?
        WHERE EXISTS (SELECT 1 FROM article_branches WHERE id = ? AND head_revision_id = ? AND status = 'active')`)
        .bind(branchId, state.root.article_id, revisionId, rendered.documentTitle, rendered.bodyText, renderedBodySha256, now,
          branchId, revisionId),
    );
  } else if (revisionCreated) {
    statements.push(
      db.prepare(`UPDATE article_branches SET head_revision_id = ?, updated_at = ?
        WHERE id = ? AND article_id = ? AND status = 'active' AND head_revision_id = ?
          AND EXISTS (SELECT 1 FROM branch_working_copies copy
            WHERE copy.branch_id = article_branches.id AND copy.base_revision_id = ? AND copy.dirty = 0 AND copy.lock_version = ?)
          AND EXISTS (SELECT 1 FROM article_project_packages WHERE id = ? AND primary_branch_id = ? AND lock_version = ?)`)
        .bind(revisionId, now, branchId, state.root.article_id, previousRevisionId,
          previousRevisionId, branchWorkingLockVersion, ownerPackageId, branchId, nextPackageLock),
      db.prepare(`INSERT INTO article_revisions
        (id, article_id, branch_id, sequence, parent_revision_id, merge_parent_revision_id, source_version_id,
         title, document_title, annotation, body_text, body_sha256, author_kind, created_at)
        SELECT ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, 'user', ?
        WHERE EXISTS (SELECT 1 FROM article_branches WHERE id = ? AND head_revision_id = ?)
          AND EXISTS (SELECT 1 FROM article_project_packages WHERE id = ? AND primary_branch_id = ? AND lock_version = ?)`)
        .bind(
          revisionId, state.root.article_id, branchId, sequence, previousRevisionId,
          `文章工程桥接 · ${document.title}`, rendered.documentTitle,
          "绑定 ArticleProject Package 时由确定性渲染器建立。", rendered.bodyText, renderedBodySha256, now,
          branchId, revisionId, ownerPackageId, branchId, nextPackageLock,
        ),
      db.prepare(`UPDATE branch_working_copies SET base_revision_id = ?, title = ?, annotation = '', body_text = ?, body_sha256 = ?,
          dirty = 0, lock_version = lock_version + 1, updated_at = ?
        WHERE branch_id = ? AND base_revision_id = ? AND dirty = 0 AND lock_version = ?
          AND EXISTS (SELECT 1 FROM article_branches WHERE id = ? AND head_revision_id = ?)
          AND EXISTS (SELECT 1 FROM article_revisions WHERE id = ? AND branch_id = ? AND body_sha256 = ?)`)
        .bind(revisionId, rendered.documentTitle, rendered.bodyText, renderedBodySha256, now,
          branchId, previousRevisionId, branchWorkingLockVersion, branchId, revisionId,
          revisionId, branchId, renderedBodySha256),
    );
  }

  const materializationId = `package-materialization-${crypto.randomUUID()}`;
  statements.push(
    db.prepare(`INSERT INTO package_composition_materializations
      (id, package_id, branch_id, composition_id, composition_sha256, article_revision_id, article_body_sha256,
       renderer_key, renderer_version, created_by_kind, created_at)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, 'user', ?
      WHERE EXISTS (SELECT 1 FROM article_project_packages
        WHERE id = ? AND primary_branch_id = ? AND main_composition_id = ? AND main_composition_sha256 = ? AND lock_version = ?)
        AND EXISTS (SELECT 1 FROM article_branches WHERE id = ? AND head_revision_id = ? AND status = 'active')
        AND EXISTS (SELECT 1 FROM article_revisions WHERE id = ? AND branch_id = ? AND body_sha256 = ?)`)
      .bind(
        materializationId, ownerPackageId, branchId, state.root.main_composition_id, state.root.main_composition_sha256,
        revisionId, renderedBodySha256, PACKAGE_RENDERER_KEY, PACKAGE_RENDERER_VERSION, now,
        ownerPackageId, branchId, state.root.main_composition_id, state.root.main_composition_sha256, nextPackageLock,
        branchId, revisionId, revisionId, branchId, renderedBodySha256,
      ),
    db.prepare(`UPDATE package_working_copies SET branch_id = ?, base_revision_id = ?, lock_version = lock_version + 1, updated_at = ?
      WHERE package_id = ? AND branch_id IS NULL AND base_revision_id IS NULL AND base_composition_id = ? AND dirty = 0
        AND EXISTS (SELECT 1 FROM package_composition_materializations
          WHERE id = ? AND branch_id = ? AND composition_id = ? AND article_revision_id = ?)`)
      .bind(branchId, revisionId, now, ownerPackageId, state.root.main_composition_id,
        materializationId, branchId, state.root.main_composition_id, revisionId),
    guardedEventStatement(db, {
      packageId: ownerPackageId, articleId: String(state.root.article_id), compositionId: String(state.root.main_composition_id),
      compositionSha256: String(state.root.main_composition_sha256), lockVersion: nextPackageLock,
      eventType: "package.branch_bridge_created", subjectType: "article_project_package", subjectId: ownerPackageId,
      payload: { branchId, revisionId, revisionCreated, rendererKey: PACKAGE_RENDERER_KEY, rendererVersion: PACKAGE_RENDERER_VERSION },
      inputSha256, createdAt: now,
    }),
    db.prepare(`SELECT CASE WHEN EXISTS (
      SELECT 1 FROM article_project_packages package
      JOIN package_working_copies package_copy ON package_copy.package_id = package.id
      JOIN article_branches branch ON branch.id = package.primary_branch_id
      JOIN article_revisions revision ON revision.id = branch.head_revision_id AND revision.branch_id = branch.id
      JOIN branch_working_copies branch_copy ON branch_copy.branch_id = branch.id
      JOIN package_composition_materializations bridge
        ON bridge.package_id = package.id AND bridge.branch_id = branch.id
        AND bridge.composition_id = package.main_composition_id AND bridge.article_revision_id = revision.id
      WHERE package.id = ? AND package.lock_version = ? AND package_copy.branch_id = branch.id
        AND package_copy.base_composition_id = package.main_composition_id AND package_copy.base_revision_id = revision.id
        AND package_copy.dirty = 0 AND branch_copy.base_revision_id = revision.id AND branch_copy.dirty = 0
    ) THEN 1 ELSE json('wenmai-package-bridge-incomplete') END AS committed`)
      .bind(ownerPackageId, nextPackageLock),
  );
  const results = await db.batch(statements);
  if (results.slice(0, -1).some((result) => resultChanges(result) !== 1)) {
    throw new ProjectPackageApiError("PACKAGE_BRANCH_BRIDGE_CONFLICT", "建立 Package Branch bridge 时发生并发冲突", 409);
  }
  const next = await currentPackageState(db, ownerPackageId);
  const nextBridge = await packageBranchBridgeState(db, next.root, next.working);
  return {
    status: 201,
    data: {
      package: parsePackageRow(next.root), composition: parseCompositionRow(next.composition, true),
      workingCopy: parseWorkingRow(next.working), branchBridge: parsePackageBranchBridge(next.root, next.working, nextBridge),
      created: true, reused: false,
      boundary: { packageMainAdvanced: false, compositionCreated: false, revisionCreated },
    },
  } satisfies MutationResult;
}

async function _saveWorkingPackage0009(db: D1Database, payload: JsonObject, inputSha256: string) {
  const ownerPackageId = requiredText(payload.packageId, "packageId", 160);
  const expectedPackageLockVersion = exactInteger(payload.expectedPackageLockVersion, "expectedPackageLockVersion", 1, 2_147_483_647);
  const expectedWorkingLockVersion = exactInteger(payload.expectedWorkingLockVersion, "expectedWorkingLockVersion", 1, 2_147_483_647);
  const expectedBaseCompositionId = requiredText(payload.expectedBaseCompositionId, "expectedBaseCompositionId", 160);
  const state = await currentPackageState(db, ownerPackageId);
  assertPackageCas(state.root, expectedPackageLockVersion, expectedBaseCompositionId, String(state.composition.composition_sha256));
  const bridgeState = await packageBranchBridgeState(db, state.root, state.working);
  if (bridgeState && (bridgeState.row.branch_status !== "active"
    || bridgeState.row.working_base_revision_id !== bridgeState.row.head_revision_id
    || Number(bridgeState.row.branch_working_dirty) !== 0
    || !bridgeState.materialization
    || bridgeState.materialization.article_revision_id !== bridgeState.row.head_revision_id)) {
    throw new ProjectPackageApiError("PACKAGE_BRANCH_CAS_CONFLICT", "Package 主 Composition 与 ArticleBranch clean head 不一致", 409, {
      branchId: bridgeState.row.branch_id, headRevisionId: bridgeState.row.head_revision_id,
    });
  }
  if (Number(state.working.lock_version) !== expectedWorkingLockVersion || state.working.base_composition_id !== expectedBaseCompositionId) {
    throw new ProjectPackageApiError("WORKING_COPY_CAS_CONFLICT", "工作副本版本或基线已变化", 409, {
      currentLockVersion: Number(state.working.lock_version), currentBaseCompositionId: state.working.base_composition_id,
    });
  }
  const seed = parseJson<PackageDocument>(state.working.document_json, {} as PackageDocument);
  const prepared = await prepareDocument(db, ownerPackageId, payload.document, seed);
  const nextDocumentSha256 = await documentSha(prepared);
  if (nextDocumentSha256 === state.working.document_sha256) {
    return {
      data: {
        package: parsePackageRow(state.root), workingCopy: parseWorkingRow(state.working), unchanged: true,
        branchBridge: parsePackageBranchBridge(state.root, state.working, bridgeState),
        boundary: { immutableCompositionCreated: false, packageMainAdvanced: false },
      },
    };
  }
  const now = isoNow();
  const dirty = nextDocumentSha256 === state.composition.document_sha256 ? 0 : 1;
  const update = db.prepare(`UPDATE package_working_copies
    SET document_json = ?, document_sha256 = ?, dirty = ?, lock_version = lock_version + 1, updated_at = ?
    WHERE package_id = ? AND base_composition_id = ? AND lock_version = ?
      AND EXISTS (
        SELECT 1 FROM article_project_packages
        WHERE id = ? AND lock_version = ? AND main_composition_id = ? AND main_composition_sha256 = ? AND status = 'active'
      )`).bind(
      canonicalJson(prepared), nextDocumentSha256, dirty, now,
      ownerPackageId, expectedBaseCompositionId, expectedWorkingLockVersion,
      ownerPackageId, expectedPackageLockVersion, expectedBaseCompositionId, state.composition.composition_sha256,
    );
  const event = db.prepare(`INSERT INTO workspace_events
    (id, event_type, subject_type, subject_id, article_id, payload_json, input_sha256, created_at)
    SELECT ?, 'package.working_saved', 'article_project_package', ?, ?, ?, ?, ?
    WHERE changes() = 1 AND EXISTS (
      SELECT 1 FROM package_working_copies copy
      JOIN article_project_packages package ON package.id = copy.package_id
      WHERE copy.package_id = ? AND copy.base_composition_id = ? AND copy.lock_version = ?
        AND copy.document_sha256 = ? AND package.lock_version = ? AND package.main_composition_id = ?
    )`).bind(
      `workspace-event-${crypto.randomUUID()}`, ownerPackageId, state.root.article_id,
      canonicalJson({ documentSha256: nextDocumentSha256, dirty: dirty === 1 }), inputSha256, now,
      ownerPackageId, expectedBaseCompositionId, expectedWorkingLockVersion + 1,
      nextDocumentSha256, expectedPackageLockVersion, expectedBaseCompositionId,
    );
  const results = await db.batch([update, event]);
  assertAllChanged(results, "WORKING_COPY_CAS_CONFLICT", "工作副本保存发生并发冲突");
  const next = await currentPackageState(db, ownerPackageId);
  const nextBridge = await packageBranchBridgeState(db, next.root, next.working);
  return {
    data: {
      package: parsePackageRow(next.root), workingCopy: parseWorkingRow(next.working), unchanged: false,
      branchBridge: parsePackageBranchBridge(next.root, next.working, nextBridge),
      boundary: { immutableCompositionCreated: false, packageMainAdvanced: false },
    },
  };
}

async function _commitWorkingPackage0009(db: D1Database, payload: JsonObject, inputSha256: string) {
  const ownerPackageId = requiredText(payload.packageId, "packageId", 160);
  const expectedPackageLockVersion = exactInteger(payload.expectedPackageLockVersion, "expectedPackageLockVersion", 1, 2_147_483_647);
  const expectedWorkingLockVersion = exactInteger(payload.expectedWorkingLockVersion, "expectedWorkingLockVersion", 1, 2_147_483_647);
  const expectedBaseCompositionId = requiredText(payload.expectedBaseCompositionId, "expectedBaseCompositionId", 160);
  const expectedDocumentSha256 = exactSha256(payload.expectedDocumentSha256, "expectedDocumentSha256");
  const state = await currentPackageState(db, ownerPackageId);
  assertPackageCas(state.root, expectedPackageLockVersion, expectedBaseCompositionId, String(state.composition.composition_sha256));
  const bridgeState = await packageBranchBridgeState(db, state.root, state.working);
  if (bridgeState && (bridgeState.row.branch_status !== "active"
    || bridgeState.row.working_base_revision_id !== bridgeState.row.head_revision_id
    || Number(bridgeState.row.branch_working_dirty) !== 0
    || !bridgeState.materialization
    || bridgeState.materialization.article_revision_id !== bridgeState.row.head_revision_id)) {
    throw new ProjectPackageApiError("PACKAGE_BRANCH_CAS_CONFLICT", "Package 主 Composition 与 ArticleBranch clean head 不一致", 409, {
      branchId: bridgeState.row.branch_id, headRevisionId: bridgeState.row.head_revision_id,
    });
  }
  if (state.working.base_composition_id !== expectedBaseCompositionId || Number(state.working.lock_version) !== expectedWorkingLockVersion) {
    throw new ProjectPackageApiError("WORKING_COPY_CAS_CONFLICT", "工作副本版本或基线已变化", 409, {
      currentLockVersion: Number(state.working.lock_version), currentBaseCompositionId: state.working.base_composition_id,
    });
  }
  if (state.working.document_sha256 !== expectedDocumentSha256) {
    throw new ProjectPackageApiError("WORKING_DOCUMENT_SHA_MISMATCH", "工作副本文档摘要已变化", 409, { currentDocumentSha256: state.working.document_sha256 });
  }
  if (Number(state.working.dirty) !== 1 || state.working.document_sha256 === state.composition.document_sha256) {
    return {
      data: {
        package: parsePackageRow(state.root), composition: parseCompositionRow(state.composition, true),
        workingCopy: parseWorkingRow(state.working), createdModuleRevisions: [], unchanged: true,
        branchBridge: parsePackageBranchBridge(state.root, state.working, bridgeState),
        boundary: { immutableCompositionCreated: false, packageMainAdvanced: false },
      },
    };
  }
  const draft = parseJson<PackageDocument>(state.working.document_json, {} as PackageDocument);
  const prepared = await prepareDocument(db, ownerPackageId, draft, draft);
  const verifiedSha = await documentSha(prepared);
  if (verifiedSha !== expectedDocumentSha256) throw new ProjectPackageApiError("WORKING_DOCUMENT_CORRUPT", "工作副本 canonical 摘要校验失败", 409);
  const title = optionalText(payload.compositionTitle, 300) || prepared.title;
  const rendered = renderPackageDocument(prepared);
  const renderedBodySha256 = await sha256Text(rendered.bodyText);
  const materializedRevisionId = bridgeState ? `revision-${crypto.randomUUID()}` : null;
  const plan = await buildMaterializationPlan(db, {
    packageId: ownerPackageId, document: prepared, parentCompositionId: expectedBaseCompositionId,
    title, authorKind: "user", sourceArticleRevisionId: materializedRevisionId,
  });
  const nextPackageLock = expectedPackageLockVersion + 1;
  const rootCas = bridgeState
    ? db.prepare(`UPDATE article_project_packages
        SET title = ?, main_composition_id = ?, main_composition_sha256 = ?, lock_version = lock_version + 1, updated_at = ?
        WHERE id = ? AND status = 'active' AND lock_version = ? AND primary_branch_id = ?
          AND main_composition_id = ? AND main_composition_sha256 = ?
          AND EXISTS (SELECT 1 FROM package_working_copies copy
            WHERE copy.package_id = ? AND copy.branch_id = ? AND copy.base_revision_id = ?
              AND copy.base_composition_id = ? AND copy.document_sha256 = ? AND copy.dirty = 1 AND copy.lock_version = ?)
          AND EXISTS (SELECT 1 FROM article_branches branch
            JOIN branch_working_copies copy ON copy.branch_id = branch.id
            WHERE branch.id = ? AND branch.article_id = ? AND branch.status = 'active' AND branch.head_revision_id = ?
              AND copy.base_revision_id = ? AND copy.dirty = 0 AND copy.lock_version = ?)
          AND EXISTS (SELECT 1 FROM package_composition_materializations bridge
            WHERE bridge.package_id = ? AND bridge.branch_id = ? AND bridge.composition_id = ?
              AND bridge.composition_sha256 = ? AND bridge.article_revision_id = ?)`)
      .bind(
        prepared.title, plan.compositionId, plan.compositionSha256, plan.createdAt,
        ownerPackageId, expectedPackageLockVersion, bridgeState.row.branch_id,
        expectedBaseCompositionId, state.composition.composition_sha256,
        ownerPackageId, bridgeState.row.branch_id, bridgeState.row.head_revision_id,
        expectedBaseCompositionId, expectedDocumentSha256, expectedWorkingLockVersion,
        bridgeState.row.branch_id, state.root.article_id, bridgeState.row.head_revision_id,
        bridgeState.row.head_revision_id, bridgeState.row.branch_working_lock_version,
        ownerPackageId, bridgeState.row.branch_id, expectedBaseCompositionId,
        state.composition.composition_sha256, bridgeState.row.head_revision_id,
      )
    : db.prepare(`UPDATE article_project_packages
        SET title = ?, main_composition_id = ?, main_composition_sha256 = ?, lock_version = lock_version + 1, updated_at = ?
        WHERE id = ? AND status = 'active' AND lock_version = ? AND primary_branch_id IS NULL
          AND main_composition_id = ? AND main_composition_sha256 = ?
          AND EXISTS (SELECT 1 FROM package_working_copies copy
            WHERE copy.package_id = ? AND copy.base_composition_id = ? AND copy.document_sha256 = ?
              AND copy.dirty = 1 AND copy.lock_version = ?)`)
      .bind(
        prepared.title, plan.compositionId, plan.compositionSha256, plan.createdAt,
        ownerPackageId, expectedPackageLockVersion, expectedBaseCompositionId, state.composition.composition_sha256,
        ownerPackageId, expectedBaseCompositionId, expectedDocumentSha256, expectedWorkingLockVersion,
      );
  const immutableStatements = materializationStatements(db, plan, nextPackageLock);
  const bridgeStatements: D1PreparedStatement[] = [];
  if (bridgeState && materializedRevisionId) {
    const sequenceRow = await db.prepare("SELECT COALESCE(MAX(sequence), 0) AS maximum FROM article_revisions WHERE branch_id = ?")
      .bind(bridgeState.row.branch_id).first<D1Row>();
    const nextSequence = Number(sequenceRow?.maximum ?? 0) + 1;
    const materializationId = `package-materialization-${crypto.randomUUID()}`;
    bridgeStatements.push(
      db.prepare(`UPDATE article_branches SET head_revision_id = ?, updated_at = ?
        WHERE id = ? AND article_id = ? AND status = 'active' AND head_revision_id = ?
          AND EXISTS (SELECT 1 FROM branch_working_copies copy WHERE copy.branch_id = article_branches.id
            AND copy.base_revision_id = ? AND copy.dirty = 0 AND copy.lock_version = ?)
          AND EXISTS (SELECT 1 FROM article_project_packages WHERE id = ? AND primary_branch_id = ?
            AND main_composition_id = ? AND main_composition_sha256 = ? AND lock_version = ?)`)
        .bind(
          materializedRevisionId, plan.createdAt, bridgeState.row.branch_id, state.root.article_id,
          bridgeState.row.head_revision_id, bridgeState.row.head_revision_id, bridgeState.row.branch_working_lock_version,
          ownerPackageId, bridgeState.row.branch_id, plan.compositionId, plan.compositionSha256, nextPackageLock,
        ),
      db.prepare(`INSERT INTO article_revisions
        (id, article_id, branch_id, sequence, parent_revision_id, merge_parent_revision_id, source_version_id,
         title, document_title, annotation, body_text, body_sha256, author_kind, created_at)
        SELECT ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, 'user', ?
        WHERE EXISTS (SELECT 1 FROM article_branches WHERE id = ? AND head_revision_id = ?)
          AND EXISTS (SELECT 1 FROM article_project_packages WHERE id = ? AND main_composition_id = ?
            AND main_composition_sha256 = ? AND lock_version = ?)`)
        .bind(
          materializedRevisionId, state.root.article_id, bridgeState.row.branch_id, nextSequence,
          bridgeState.row.head_revision_id, `文章工程提交 · ${title}`, rendered.documentTitle,
          `由 ${PACKAGE_RENDERER_KEY}@${PACKAGE_RENDERER_VERSION} 从 Composition ${plan.compositionId} 确定性渲染。`,
          rendered.bodyText, renderedBodySha256, plan.createdAt,
          bridgeState.row.branch_id, materializedRevisionId,
          ownerPackageId, plan.compositionId, plan.compositionSha256, nextPackageLock,
        ),
      db.prepare(`UPDATE branch_working_copies SET base_revision_id = ?, title = ?, annotation = '',
          body_text = ?, body_sha256 = ?, dirty = 0, lock_version = lock_version + 1, updated_at = ?
        WHERE branch_id = ? AND base_revision_id = ? AND dirty = 0 AND lock_version = ?
          AND EXISTS (SELECT 1 FROM article_branches WHERE id = ? AND head_revision_id = ?)
          AND EXISTS (SELECT 1 FROM article_revisions WHERE id = ? AND branch_id = ? AND body_sha256 = ?)`)
        .bind(
          materializedRevisionId, rendered.documentTitle, rendered.bodyText, renderedBodySha256, plan.createdAt,
          bridgeState.row.branch_id, bridgeState.row.head_revision_id, bridgeState.row.branch_working_lock_version,
          bridgeState.row.branch_id, materializedRevisionId,
          materializedRevisionId, bridgeState.row.branch_id, renderedBodySha256,
        ),
      db.prepare(`INSERT INTO package_composition_materializations
        (id, package_id, branch_id, composition_id, composition_sha256, article_revision_id, article_body_sha256,
         renderer_key, renderer_version, created_by_kind, created_at)
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, 'user', ?
        WHERE EXISTS (SELECT 1 FROM article_project_packages WHERE id = ? AND primary_branch_id = ?
          AND main_composition_id = ? AND main_composition_sha256 = ? AND lock_version = ?)
          AND EXISTS (SELECT 1 FROM article_branches WHERE id = ? AND head_revision_id = ?)
          AND EXISTS (SELECT 1 FROM article_revisions WHERE id = ? AND branch_id = ? AND body_sha256 = ?)`)
        .bind(
          materializationId, ownerPackageId, bridgeState.row.branch_id, plan.compositionId, plan.compositionSha256,
          materializedRevisionId, renderedBodySha256, PACKAGE_RENDERER_KEY, PACKAGE_RENDERER_VERSION, plan.createdAt,
          ownerPackageId, bridgeState.row.branch_id, plan.compositionId, plan.compositionSha256, nextPackageLock,
          bridgeState.row.branch_id, materializedRevisionId,
          materializedRevisionId, bridgeState.row.branch_id, renderedBodySha256,
        ),
    );
  }
  const resetWorking = db.prepare(`UPDATE package_working_copies
    SET base_composition_id = ?, base_revision_id = ?, document_json = ?, document_sha256 = ?, dirty = 0,
      lock_version = lock_version + 1, updated_at = ?
    WHERE package_id = ? AND base_composition_id = ? AND document_sha256 = ? AND dirty = 1 AND lock_version = ?
      AND EXISTS (
        SELECT 1 FROM article_project_packages
        WHERE id = ? AND main_composition_id = ? AND main_composition_sha256 = ? AND lock_version = ?
      )
      AND (? IS NULL OR EXISTS (SELECT 1 FROM package_composition_materializations
        WHERE package_id = ? AND branch_id = ? AND composition_id = ? AND article_revision_id = ?))`).bind(
      plan.compositionId, materializedRevisionId, canonicalJson(plan.document), plan.documentSha256, plan.createdAt,
      ownerPackageId, expectedBaseCompositionId, expectedDocumentSha256, expectedWorkingLockVersion,
      ownerPackageId, plan.compositionId, plan.compositionSha256, nextPackageLock,
      materializedRevisionId, ownerPackageId, bridgeState?.row.branch_id ?? null,
      plan.compositionId, materializedRevisionId,
    );
  const event = guardedEventStatement(db, {
    packageId: ownerPackageId, articleId: String(state.root.article_id), compositionId: plan.compositionId,
    compositionSha256: plan.compositionSha256, lockVersion: nextPackageLock,
    eventType: "package.committed", subjectType: "package_composition", subjectId: plan.compositionId,
    payload: {
      parentCompositionId: expectedBaseCompositionId, documentSha256: plan.documentSha256,
      primaryBranchId: bridgeState?.row.branch_id ?? null, materializedRevisionId,
      rendererKey: bridgeState ? PACKAGE_RENDERER_KEY : null,
      rendererVersion: bridgeState ? PACKAGE_RENDERER_VERSION : null,
    },
    inputSha256, createdAt: plan.createdAt,
  });
  const sentinel = bridgeState && materializedRevisionId
    ? db.prepare(`SELECT CASE WHEN EXISTS (
        SELECT 1 FROM article_project_packages package
        JOIN package_working_copies package_copy ON package_copy.package_id = package.id
        JOIN article_branches branch ON branch.id = package.primary_branch_id
        JOIN article_revisions revision ON revision.id = branch.head_revision_id AND revision.branch_id = branch.id
        JOIN branch_working_copies branch_copy ON branch_copy.branch_id = branch.id
        JOIN package_composition_materializations bridge
          ON bridge.package_id = package.id AND bridge.branch_id = branch.id
          AND bridge.composition_id = package.main_composition_id
          AND bridge.composition_sha256 = package.main_composition_sha256
          AND bridge.article_revision_id = revision.id AND bridge.article_body_sha256 = revision.body_sha256
        WHERE package.id = ? AND package.main_composition_id = ? AND package.main_composition_sha256 = ? AND package.lock_version = ?
          AND package_copy.branch_id = branch.id AND package_copy.base_composition_id = package.main_composition_id
          AND package_copy.base_revision_id = revision.id AND package_copy.dirty = 0
          AND branch_copy.base_revision_id = revision.id AND branch_copy.dirty = 0
      ) THEN 1 ELSE json('wenmai-package-commit-incomplete') END AS committed`)
      .bind(ownerPackageId, plan.compositionId, plan.compositionSha256, nextPackageLock)
    : db.prepare(`SELECT CASE WHEN EXISTS (
        SELECT 1 FROM article_project_packages package
        JOIN package_working_copies copy ON copy.package_id = package.id
        WHERE package.id = ? AND package.primary_branch_id IS NULL
          AND package.main_composition_id = ? AND package.main_composition_sha256 = ? AND package.lock_version = ?
          AND copy.base_composition_id = package.main_composition_id AND copy.dirty = 0
      ) THEN 1 ELSE json('wenmai-package-legacy-commit-incomplete') END AS committed`)
      .bind(ownerPackageId, plan.compositionId, plan.compositionSha256, nextPackageLock);
  const results = await db.batch([
    rootCas, ...immutableStatements.map((item) => item.statement), ...bridgeStatements, resetWorking, event, sentinel,
  ]);
  if (resultChanges(results[0]) !== 1) throw new ProjectPackageApiError("PACKAGE_COMMIT_CAS_CONFLICT", "提交时 Package 或工作副本基线已变化", 409);
  immutableStatements.forEach((expected, index) => {
    if (resultChanges(results[index + 1]) !== expected.expectedChanges) {
      throw new ProjectPackageApiError("PACKAGE_COMMIT_INCOMPLETE", `${expected.label} 未完整写入`, 500);
    }
  });
  const tailOffset = 1 + immutableStatements.length;
  if (results.slice(tailOffset, -1).some((result) => resultChanges(result) !== 1)) {
    throw new ProjectPackageApiError("PACKAGE_COMMIT_INCOMPLETE", "提交后的 Revision、桥接、工作副本或事件未完整推进", 500);
  }
  const next = await currentPackageState(db, ownerPackageId);
  const nextBridge = await packageBranchBridgeState(db, next.root, next.working);
  return {
    status: 201,
    data: {
      package: parsePackageRow(next.root), composition: parseCompositionRow(next.composition, true),
      workingCopy: parseWorkingRow(next.working), createdModuleRevisions: plan.createdModuleRevisionIds, unchanged: false,
      branchBridge: parsePackageBranchBridge(next.root, next.working, nextBridge),
      articleRevision: nextBridge ? {
        id: nextBridge.row.head_revision_id, bodySha256: nextBridge.row.head_body_sha256,
        branchId: nextBridge.row.branch_id,
      } : null,
      boundary: {
        immutableCompositionCreated: true, packageMainAdvanced: true,
        articleBranchAdvanced: Boolean(nextBridge), revisionCreated: Boolean(nextBridge),
      },
    },
  };
}

function branchMutationBaseline(payload: JsonObject, root: D1Row, selected: Awaited<ReturnType<typeof loadSelectedPackageBranch>>) {
  const explicitBranchLock = payload.expectedBranchLockVersion === undefined
    ? null
    : exactInteger(payload.expectedBranchLockVersion, "expectedBranchLockVersion", 1, 2_147_483_647);
  if (explicitBranchLock === null) {
    const legacyPackageLock = exactInteger(payload.expectedPackageLockVersion, "expectedPackageLockVersion", 1, 2_147_483_647);
    if (selected.branchId !== root.primary_branch_id || legacyPackageLock !== Number(root.lock_version)) {
      throw new ProjectPackageApiError("BRANCH_BASELINE_REQUIRED", "非 primary 分支写入必须显式提供 expectedBranchLockVersion", 409);
    }
  }
  const expectedBranchLockVersion = explicitBranchLock ?? selected.branchState.lockVersion;
  const expectedBaseCompositionId = requiredText(payload.expectedBaseCompositionId, "expectedBaseCompositionId", 160);
  const expectedBaseRevisionId = optionalText(payload.expectedBaseRevisionId, 160) || selected.branchState.headRevisionId;
  if (expectedBranchLockVersion !== selected.branchState.lockVersion
    || expectedBaseCompositionId !== selected.branchState.headCompositionId
    || expectedBaseRevisionId !== selected.branchState.headRevisionId) {
    throw new ProjectPackageApiError("PACKAGE_BRANCH_CAS_CONFLICT", "Package 分支 head 或 lockVersion 已变化", 409, {
      currentBranchLockVersion: selected.branchState.lockVersion,
      currentCompositionId: selected.branchState.headCompositionId,
      currentRevisionId: selected.branchState.headRevisionId,
    });
  }
  return { expectedBranchLockVersion, expectedBaseCompositionId, expectedBaseRevisionId };
}

async function saveWorkingPackage(db: D1Database, payload: JsonObject, inputSha256: string) {
  const ownerPackageId = requiredText(payload.packageId, "packageId", 160);
  const root = await packageRow(db, ownerPackageId);
  const requestedBranchId = optionalText(payload.branchId, 160) || undefined;
  const selected = await loadSelectedPackageBranch(db, root, requestedBranchId, true);
  const baseline = branchMutationBaseline(payload, root, selected);
  const expectedWorkingLockVersion = exactInteger(payload.expectedWorkingLockVersion, "expectedWorkingLockVersion", 1, 2_147_483_647);
  if (selected.workingCopy.lockVersion !== expectedWorkingLockVersion
    || selected.workingCopy.baseCompositionId !== baseline.expectedBaseCompositionId
    || selected.workingCopy.baseRevisionId !== baseline.expectedBaseRevisionId) {
    throw new ProjectPackageApiError("WORKING_COPY_CAS_CONFLICT", "分支工作副本版本或基线已变化", 409, {
      currentLockVersion: selected.workingCopy.lockVersion,
      currentBaseCompositionId: selected.workingCopy.baseCompositionId,
      currentBaseRevisionId: selected.workingCopy.baseRevisionId,
    });
  }
  const seed = selected.workingCopy.document;
  const prepared = await prepareDocument(db, ownerPackageId, payload.document, seed);
  const nextDocumentSha256 = await documentSha(prepared);
  if (nextDocumentSha256 === selected.workingCopy.documentSha256) {
    return {
      data: {
        package: parsePackageRow(root), selectedBranchId: selected.branchId,
        branchState: selected.branchState, branchWorkingCopy: selected.workingCopy,
        workingCopy: selected.workingCopy, branchCommit: selected.branchCommit,
        branchBridge: selected.branchBridge, unchanged: true,
        boundary: { compositionCreated: false, branchAdvanced: false, packageMainAdvanced: false },
      },
    };
  }
  const now = isoNow();
  const dirty = nextDocumentSha256 === String(selected.composition.document_sha256) ? 0 : 1;
  const branchUpdate = db.prepare(`UPDATE package_branch_working_copies
    SET document_json = ?, document_sha256 = ?, dirty = ?, lock_version = lock_version + 1, updated_at = ?
    WHERE package_id = ? AND branch_id = ? AND base_composition_id = ? AND base_revision_id = ? AND lock_version = ?
      AND EXISTS (SELECT 1 FROM package_branch_states state
        WHERE state.package_id = package_branch_working_copies.package_id
          AND state.branch_id = package_branch_working_copies.branch_id
          AND state.head_composition_id = ? AND state.head_composition_sha256 = ?
          AND state.head_revision_id = ? AND state.lock_version = ? AND state.status = 'active')`)
    .bind(canonicalJson(prepared), nextDocumentSha256, dirty, now,
      ownerPackageId, selected.branchId, baseline.expectedBaseCompositionId, baseline.expectedBaseRevisionId,
      expectedWorkingLockVersion, baseline.expectedBaseCompositionId, selected.branchState.headCompositionSha256,
      baseline.expectedBaseRevisionId, baseline.expectedBranchLockVersion);
  const isPrimary = root.primary_branch_id === selected.branchId;
  const legacyMirror = isPrimary ? db.prepare(`UPDATE package_working_copies
    SET branch_id = ?, base_composition_id = ?, base_revision_id = ?, document_json = ?, document_sha256 = ?,
      dirty = ?, lock_version = lock_version + 1, updated_at = ?
    WHERE package_id = ? AND branch_id = ? AND base_composition_id = ? AND base_revision_id = ? AND lock_version = ?
      AND EXISTS (SELECT 1 FROM package_branch_working_copies copy
        WHERE copy.package_id = ? AND copy.branch_id = ? AND copy.document_sha256 = ?
          AND copy.lock_version = ? AND copy.dirty = ?)`)
    .bind(selected.branchId, baseline.expectedBaseCompositionId, baseline.expectedBaseRevisionId,
      canonicalJson(prepared), nextDocumentSha256, dirty, now,
      ownerPackageId, selected.branchId, baseline.expectedBaseCompositionId, baseline.expectedBaseRevisionId,
      expectedWorkingLockVersion, ownerPackageId, selected.branchId, nextDocumentSha256,
      expectedWorkingLockVersion + 1, dirty) : null;
  const event = db.prepare(`INSERT INTO workspace_events
    (id, event_type, subject_type, subject_id, article_id, payload_json, input_sha256, created_at)
    SELECT ?, 'package.branch_working_saved', 'package_branch_state', ?, ?, ?, ?, ?
    WHERE EXISTS (SELECT 1 FROM package_branch_working_copies copy
      JOIN package_branch_states state ON state.package_id = copy.package_id AND state.branch_id = copy.branch_id
      WHERE copy.package_id = ? AND copy.branch_id = ? AND copy.base_composition_id = state.head_composition_id
        AND copy.base_revision_id = state.head_revision_id AND copy.document_sha256 = ?
        AND copy.lock_version = ? AND state.lock_version = ?)`)
    .bind(`workspace-event-${crypto.randomUUID()}`, `${ownerPackageId}:${selected.branchId}`, root.article_id,
      canonicalJson({ packageId: ownerPackageId, branchId: selected.branchId, documentSha256: nextDocumentSha256,
        dirty: dirty === 1, branchAdvanced: false }), inputSha256, now,
      ownerPackageId, selected.branchId, nextDocumentSha256, expectedWorkingLockVersion + 1,
      baseline.expectedBranchLockVersion);
  const sentinel = db.prepare(`SELECT CASE WHEN EXISTS (
      SELECT 1 FROM package_branch_states state
      JOIN package_branch_working_copies copy ON copy.package_id = state.package_id AND copy.branch_id = state.branch_id
      WHERE state.package_id = ? AND state.branch_id = ? AND state.head_composition_id = ?
        AND state.head_revision_id = ? AND state.lock_version = ?
        AND copy.base_composition_id = state.head_composition_id AND copy.base_revision_id = state.head_revision_id
        AND copy.document_sha256 = ? AND copy.lock_version = ? AND copy.dirty = ?
        AND (? = 0 OR EXISTS (SELECT 1 FROM package_working_copies legacy
          WHERE legacy.package_id = state.package_id AND legacy.branch_id = state.branch_id
            AND legacy.document_sha256 = copy.document_sha256 AND legacy.lock_version = copy.lock_version))
    ) THEN 1 ELSE json('wenmai-0010-save-incomplete') END AS committed`)
    .bind(ownerPackageId, selected.branchId, baseline.expectedBaseCompositionId, baseline.expectedBaseRevisionId,
      baseline.expectedBranchLockVersion, nextDocumentSha256, expectedWorkingLockVersion + 1, dirty, isPrimary ? 1 : 0);
  const results = await db.batch([branchUpdate, ...(legacyMirror ? [legacyMirror] : []), event, sentinel]);
  if (resultChanges(results[0]) !== 1) throw new ProjectPackageApiError("WORKING_COPY_CAS_CONFLICT", "分支工作副本保存发生并发冲突", 409);
  const nextRoot = await packageRow(db, ownerPackageId);
  const next = await loadSelectedPackageBranch(db, nextRoot, selected.branchId);
  return {
    data: {
      package: parsePackageRow(nextRoot), selectedBranchId: next.branchId,
      branchState: next.branchState, branchWorkingCopy: next.workingCopy, workingCopy: next.workingCopy,
      branchCommit: next.branchCommit, branchBridge: next.branchBridge, unchanged: false,
      boundary: { compositionCreated: false, branchAdvanced: false, packageMainAdvanced: false },
    },
  };
}

async function commitWorkingPackage(
  db: D1Database,
  payload: JsonObject,
  inputSha256: string,
  authorKind: "user" | "agent" = "user",
) {
  const ownerPackageId = requiredText(payload.packageId, "packageId", 160);
  const root = await packageRow(db, ownerPackageId);
  const requestedBranchId = optionalText(payload.branchId, 160) || undefined;
  const selected = await loadSelectedPackageBranch(db, root, requestedBranchId, true);
  const baseline = branchMutationBaseline(payload, root, selected);
  const expectedWorkingLockVersion = exactInteger(payload.expectedWorkingLockVersion, "expectedWorkingLockVersion", 1, 2_147_483_647);
  const expectedDocumentSha256 = exactSha256(payload.expectedDocumentSha256, "expectedDocumentSha256");
  if (selected.workingCopy.lockVersion !== expectedWorkingLockVersion
    || selected.workingCopy.baseCompositionId !== baseline.expectedBaseCompositionId
    || selected.workingCopy.baseRevisionId !== baseline.expectedBaseRevisionId) {
    throw new ProjectPackageApiError("WORKING_COPY_CAS_CONFLICT", "分支工作副本版本或基线已变化", 409);
  }
  if (selected.workingCopy.documentSha256 !== expectedDocumentSha256) {
    throw new ProjectPackageApiError("WORKING_DOCUMENT_SHA_MISMATCH", "分支工作副本文档摘要已变化", 409, {
      currentDocumentSha256: selected.workingCopy.documentSha256,
    });
  }
  if (!selected.workingCopy.dirty || selected.workingCopy.documentSha256 === selected.composition.document_sha256) {
    return {
      data: {
        package: parsePackageRow(root), selectedBranchId: selected.branchId,
        branchState: selected.branchState, composition: parseCompositionRow(selected.composition, true),
        branchWorkingCopy: selected.workingCopy, workingCopy: selected.workingCopy,
        branchCommit: selected.branchCommit, branchBridge: selected.branchBridge,
        createdModuleRevisions: [], unchanged: true, compatibilityMirrorUpdated: false,
        boundary: { immutableCompositionCreated: false, branchAdvanced: false, packageMainAdvanced: false },
      },
    };
  }
  const draft = selected.workingCopy.document;
  const prepared = await prepareDocument(db, ownerPackageId, draft, draft);
  if (await documentSha(prepared) !== expectedDocumentSha256) {
    throw new ProjectPackageApiError("WORKING_DOCUMENT_CORRUPT", "分支工作副本 canonical 摘要校验失败", 409);
  }
  const title = optionalText(payload.compositionTitle, 300) || prepared.title;
  const rendered = renderPackageDocument(prepared);
  const renderedBodySha256 = await sha256Text(rendered.bodyText);
  const revisionId = `revision-${crypto.randomUUID()}`;
  const materializationId = `package-materialization-${crypto.randomUUID()}`;
  const branchCommitId = `branch-commit-${crypto.randomUUID()}`;
  const plan = await buildMaterializationPlan(db, {
    packageId: ownerPackageId, document: prepared, parentCompositionId: baseline.expectedBaseCompositionId,
    title, authorKind, sourceArticleRevisionId: revisionId,
  });
  const sequenceRow = await db.prepare("SELECT COALESCE(MAX(sequence), 0) AS maximum FROM article_revisions WHERE branch_id = ?")
    .bind(selected.branchId).first<D1Row>();
  const nextSequence = Number(sequenceRow?.maximum ?? 0) + 1;
  const nextBranchLock = baseline.expectedBranchLockVersion + 1;
  const branchStateCas = db.prepare(`UPDATE package_branch_states
    SET head_composition_id = ?, head_composition_sha256 = ?, head_revision_id = ?,
      lock_version = lock_version + 1, updated_at = ?
    WHERE package_id = ? AND branch_id = ? AND status = 'active' AND lock_version = ?
      AND head_composition_id = ? AND head_composition_sha256 = ? AND head_revision_id = ?
      AND EXISTS (SELECT 1 FROM package_branch_working_copies copy
        WHERE copy.package_id = package_branch_states.package_id AND copy.branch_id = package_branch_states.branch_id
          AND copy.base_composition_id = ? AND copy.base_revision_id = ? AND copy.document_sha256 = ?
          AND copy.dirty = 1 AND copy.lock_version = ?)
      AND EXISTS (SELECT 1 FROM article_branches branch
        JOIN branch_working_copies copy ON copy.branch_id = branch.id
        WHERE branch.id = package_branch_states.branch_id AND branch.article_id = ? AND branch.status = 'active'
          AND branch.head_revision_id = ? AND copy.base_revision_id = ? AND copy.dirty = 0 AND copy.lock_version = ?)
      AND EXISTS (SELECT 1 FROM package_composition_materializations materialization
        WHERE materialization.package_id = package_branch_states.package_id
          AND materialization.branch_id = package_branch_states.branch_id
          AND materialization.composition_id = ? AND materialization.composition_sha256 = ?
          AND materialization.article_revision_id = ?)
      AND EXISTS (SELECT 1 FROM package_branch_composition_commits commit_ref
        WHERE commit_ref.package_id = package_branch_states.package_id
          AND commit_ref.branch_id = package_branch_states.branch_id
          AND commit_ref.composition_id = ? AND commit_ref.article_revision_id = ?)`)
    .bind(plan.compositionId, plan.compositionSha256, revisionId, plan.createdAt,
      ownerPackageId, selected.branchId, baseline.expectedBranchLockVersion,
      baseline.expectedBaseCompositionId, selected.branchState.headCompositionSha256, baseline.expectedBaseRevisionId,
      baseline.expectedBaseCompositionId, baseline.expectedBaseRevisionId, expectedDocumentSha256, expectedWorkingLockVersion,
      root.article_id, baseline.expectedBaseRevisionId, baseline.expectedBaseRevisionId,
      selected.row.article_working_lock_version,
      baseline.expectedBaseCompositionId, selected.branchState.headCompositionSha256, baseline.expectedBaseRevisionId,
      baseline.expectedBaseCompositionId, baseline.expectedBaseRevisionId);
  const immutableStatements = materializationStatements(db, plan, nextBranchLock, {
    branchId: selected.branchId, headRevisionId: revisionId,
  });
  const articleBranchCas = db.prepare(`UPDATE article_branches SET head_revision_id = ?, updated_at = ?
    WHERE id = ? AND article_id = ? AND status = 'active' AND head_revision_id = ?
      AND EXISTS (SELECT 1 FROM package_branch_states state WHERE state.package_id = ? AND state.branch_id = article_branches.id
        AND state.head_composition_id = ? AND state.head_composition_sha256 = ?
        AND state.head_revision_id = ? AND state.lock_version = ?)`)
    .bind(revisionId, plan.createdAt, selected.branchId, root.article_id, baseline.expectedBaseRevisionId,
      ownerPackageId, plan.compositionId, plan.compositionSha256, revisionId, nextBranchLock);
  const revisionInsert = db.prepare(`INSERT INTO article_revisions
    (id, article_id, branch_id, sequence, parent_revision_id, merge_parent_revision_id, source_version_id,
     title, document_title, annotation, body_text, body_sha256, author_kind, created_at)
    SELECT ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?
    WHERE EXISTS (SELECT 1 FROM article_branches WHERE id = ? AND head_revision_id = ?)
      AND EXISTS (SELECT 1 FROM package_branch_states WHERE package_id = ? AND branch_id = ?
        AND head_composition_id = ? AND head_revision_id = ? AND lock_version = ?)`)
    .bind(revisionId, root.article_id, selected.branchId, nextSequence, baseline.expectedBaseRevisionId,
      `文章工程提交 · ${title}`, rendered.documentTitle,
      `由 ${PACKAGE_RENDERER_KEY}@${PACKAGE_RENDERER_VERSION} 从 Composition ${plan.compositionId} 确定性渲染。`,
      rendered.bodyText, renderedBodySha256, authorKind, plan.createdAt,
      selected.branchId, revisionId, ownerPackageId, selected.branchId,
      plan.compositionId, revisionId, nextBranchLock);
  const articleWorkingUpdate = db.prepare(`UPDATE branch_working_copies
    SET base_revision_id = ?, title = ?, annotation = '', body_text = ?, body_sha256 = ?, dirty = 0,
      lock_version = lock_version + 1, updated_at = ?
    WHERE branch_id = ? AND article_id = ? AND base_revision_id = ? AND dirty = 0 AND lock_version = ?
      AND EXISTS (SELECT 1 FROM article_branches WHERE id = ? AND head_revision_id = ?)
      AND EXISTS (SELECT 1 FROM article_revisions WHERE id = ? AND branch_id = ? AND body_sha256 = ?)`)
    .bind(revisionId, rendered.documentTitle, rendered.bodyText, renderedBodySha256, plan.createdAt,
      selected.branchId, root.article_id, baseline.expectedBaseRevisionId, selected.row.article_working_lock_version,
      selected.branchId, revisionId, revisionId, selected.branchId, renderedBodySha256);
  const materializationInsert = db.prepare(`INSERT INTO package_composition_materializations
    (id, package_id, branch_id, composition_id, composition_sha256, article_revision_id, article_body_sha256,
     renderer_key, renderer_version, created_by_kind, created_at)
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    WHERE EXISTS (SELECT 1 FROM package_branch_states WHERE package_id = ? AND branch_id = ?
      AND head_composition_id = ? AND head_composition_sha256 = ? AND head_revision_id = ? AND lock_version = ?)
      AND EXISTS (SELECT 1 FROM article_revisions WHERE id = ? AND branch_id = ? AND body_sha256 = ?)`)
    .bind(materializationId, ownerPackageId, selected.branchId, plan.compositionId, plan.compositionSha256,
      revisionId, renderedBodySha256, PACKAGE_RENDERER_KEY, PACKAGE_RENDERER_VERSION, authorKind, plan.createdAt,
      ownerPackageId, selected.branchId, plan.compositionId, plan.compositionSha256, revisionId, nextBranchLock,
      revisionId, selected.branchId, renderedBodySha256);
  const commitInsert = db.prepare(`INSERT INTO package_branch_composition_commits
    (id, package_id, branch_id, parent_composition_id, composition_id, composition_sha256,
     previous_revision_id, article_revision_id, source_kind, source_patch_id, created_by_kind, created_at)
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, 'commit', NULL, ?, ?
    WHERE EXISTS (SELECT 1 FROM package_composition_materializations WHERE id = ? AND article_revision_id = ?)
      AND EXISTS (SELECT 1 FROM package_branch_composition_commits WHERE package_id = ? AND branch_id = ?
        AND composition_id = ? AND article_revision_id = ?)`)
    .bind(branchCommitId, ownerPackageId, selected.branchId, baseline.expectedBaseCompositionId,
      plan.compositionId, plan.compositionSha256, baseline.expectedBaseRevisionId, revisionId, authorKind, plan.createdAt,
      materializationId, revisionId, ownerPackageId, selected.branchId,
      baseline.expectedBaseCompositionId, baseline.expectedBaseRevisionId);
  const branchWorkingReset = db.prepare(`UPDATE package_branch_working_copies
    SET base_composition_id = ?, base_revision_id = ?, document_json = ?, document_sha256 = ?, dirty = 0,
      lock_version = lock_version + 1, updated_at = ?
    WHERE package_id = ? AND branch_id = ? AND base_composition_id = ? AND base_revision_id = ?
      AND document_sha256 = ? AND dirty = 1 AND lock_version = ?
      AND EXISTS (SELECT 1 FROM package_branch_composition_commits WHERE id = ? AND package_id = ? AND branch_id = ?
        AND composition_id = ? AND article_revision_id = ?)`)
    .bind(plan.compositionId, revisionId, canonicalJson(plan.document), plan.documentSha256, plan.createdAt,
      ownerPackageId, selected.branchId, baseline.expectedBaseCompositionId, baseline.expectedBaseRevisionId,
      expectedDocumentSha256, expectedWorkingLockVersion,
      branchCommitId, ownerPackageId, selected.branchId, plan.compositionId, revisionId);
  const isPrimary = root.primary_branch_id === selected.branchId;
  const rootMirror = isPrimary ? db.prepare(`UPDATE article_project_packages
    SET title = ?, main_composition_id = ?, main_composition_sha256 = ?, lock_version = lock_version + 1, updated_at = ?
    WHERE id = ? AND primary_branch_id = ? AND main_composition_id = ? AND main_composition_sha256 = ?
      AND status = 'active' AND branch_model_version = 2
      AND EXISTS (SELECT 1 FROM package_branch_states WHERE package_id = ? AND branch_id = ?
        AND head_composition_id = ? AND head_revision_id = ? AND lock_version = ?)`)
    .bind(prepared.title, plan.compositionId, plan.compositionSha256, plan.createdAt,
      ownerPackageId, selected.branchId, baseline.expectedBaseCompositionId, selected.branchState.headCompositionSha256,
      ownerPackageId, selected.branchId, plan.compositionId, revisionId, nextBranchLock) : null;
  const legacyMirror = isPrimary ? db.prepare(`UPDATE package_working_copies
    SET branch_id = ?, base_composition_id = ?, base_revision_id = ?, document_json = ?, document_sha256 = ?,
      dirty = 0, lock_version = lock_version + 1, updated_at = ?
    WHERE package_id = ? AND branch_id = ? AND base_composition_id = ? AND base_revision_id = ?
      AND document_sha256 = ? AND dirty = 1 AND lock_version = ?
      AND EXISTS (SELECT 1 FROM package_branch_working_copies WHERE package_id = ? AND branch_id = ?
        AND base_composition_id = ? AND base_revision_id = ? AND dirty = 0 AND lock_version = ?)`)
    .bind(selected.branchId, plan.compositionId, revisionId, canonicalJson(plan.document), plan.documentSha256, plan.createdAt,
      ownerPackageId, selected.branchId, baseline.expectedBaseCompositionId, baseline.expectedBaseRevisionId,
      expectedDocumentSha256, expectedWorkingLockVersion,
      ownerPackageId, selected.branchId, plan.compositionId, revisionId, expectedWorkingLockVersion + 1) : null;
  const event = db.prepare(`INSERT INTO workspace_events
    (id, event_type, subject_type, subject_id, article_id, payload_json, input_sha256, created_at)
    SELECT ?, 'package.branch_committed', 'package_branch_commit', ?, ?, ?, ?, ?
    WHERE EXISTS (SELECT 1 FROM package_branch_composition_commits WHERE id = ? AND package_id = ? AND branch_id = ?)`)
    .bind(`workspace-event-${crypto.randomUUID()}`, branchCommitId, root.article_id,
      canonicalJson({ packageId: ownerPackageId, branchId: selected.branchId,
        oldCompositionId: baseline.expectedBaseCompositionId, newCompositionId: plan.compositionId,
        oldRevisionId: baseline.expectedBaseRevisionId, newRevisionId: revisionId,
        previousBranchLockVersion: baseline.expectedBranchLockVersion, branchLockVersion: nextBranchLock,
        compatibilityMirrorUpdated: isPrimary }), inputSha256, plan.createdAt,
      branchCommitId, ownerPackageId, selected.branchId);
  const sentinel = db.prepare(`SELECT CASE WHEN EXISTS (
      SELECT 1 FROM package_branch_states state
      JOIN package_branch_working_copies package_copy
        ON package_copy.package_id = state.package_id AND package_copy.branch_id = state.branch_id
      JOIN article_branches branch ON branch.id = state.branch_id
      JOIN branch_working_copies article_copy ON article_copy.branch_id = state.branch_id
      JOIN package_composition_materializations materialization
        ON materialization.package_id = state.package_id AND materialization.branch_id = state.branch_id
        AND materialization.composition_id = state.head_composition_id
        AND materialization.article_revision_id = state.head_revision_id
      JOIN package_branch_composition_commits commit_ref
        ON commit_ref.package_id = state.package_id AND commit_ref.branch_id = state.branch_id
        AND commit_ref.composition_id = state.head_composition_id
        AND commit_ref.article_revision_id = state.head_revision_id
      WHERE state.package_id = ? AND state.branch_id = ? AND state.head_composition_id = ?
        AND state.head_composition_sha256 = ? AND state.head_revision_id = ? AND state.lock_version = ?
        AND package_copy.base_composition_id = state.head_composition_id
        AND package_copy.base_revision_id = state.head_revision_id AND package_copy.dirty = 0
        AND branch.head_revision_id = state.head_revision_id
        AND article_copy.base_revision_id = state.head_revision_id AND article_copy.dirty = 0
        AND ((SELECT primary_branch_id FROM article_project_packages WHERE id = state.package_id) <> state.branch_id
          OR EXISTS (SELECT 1 FROM article_project_packages root
            JOIN package_working_copies legacy ON legacy.package_id = root.id
            WHERE root.id = state.package_id AND root.primary_branch_id = state.branch_id
              AND root.main_composition_id = state.head_composition_id
              AND root.main_composition_sha256 = state.head_composition_sha256
              AND legacy.branch_id = state.branch_id
              AND legacy.base_composition_id = state.head_composition_id
              AND legacy.base_revision_id = state.head_revision_id AND legacy.dirty = 0))
    ) THEN 1 ELSE json('wenmai-0010-commit-incomplete') END AS committed`)
    .bind(ownerPackageId, selected.branchId, plan.compositionId, plan.compositionSha256, revisionId, nextBranchLock);
  const statements = [branchStateCas, ...immutableStatements.map((item) => item.statement), articleBranchCas,
    revisionInsert, articleWorkingUpdate, materializationInsert, commitInsert, branchWorkingReset,
    ...(rootMirror ? [rootMirror] : []), ...(legacyMirror ? [legacyMirror] : []), event, sentinel];
  let results: D1Mutation[];
  try { results = await db.batch(statements); } catch (error) {
    const current = await db.prepare("SELECT lock_version, head_composition_id, head_revision_id FROM package_branch_states WHERE package_id = ? AND branch_id = ?")
      .bind(ownerPackageId, selected.branchId).first<D1Row>();
    if (!current || Number(current.lock_version) !== baseline.expectedBranchLockVersion
      || current.head_composition_id !== baseline.expectedBaseCompositionId
      || current.head_revision_id !== baseline.expectedBaseRevisionId) {
      throw new ProjectPackageApiError("PACKAGE_BRANCH_CAS_CONFLICT", "提交时目标分支基线已变化", 409, { current });
    }
    throw error;
  }
  if (resultChanges(results[0]) !== 1) throw new ProjectPackageApiError("PACKAGE_BRANCH_CAS_CONFLICT", "提交时目标分支基线已变化", 409);
  immutableStatements.forEach((expected, index) => {
    if (resultChanges(results[index + 1]) !== expected.expectedChanges) {
      throw new ProjectPackageApiError("PACKAGE_COMMIT_INCOMPLETE", `${expected.label} 未完整写入`, 500);
    }
  });
  const nextRoot = await packageRow(db, ownerPackageId);
  const next = await loadSelectedPackageBranch(db, nextRoot, selected.branchId);
  return {
    status: 201,
    data: {
      package: parsePackageRow(nextRoot), selectedBranchId: next.branchId,
      branchState: next.branchState, composition: parseCompositionRow(next.composition, true),
      branchWorkingCopy: next.workingCopy, workingCopy: next.workingCopy,
      branchCommit: next.branchCommit, branchBridge: next.branchBridge,
      articleRevision: { id: revisionId, bodySha256: renderedBodySha256, branchId: selected.branchId },
      createdModuleRevisions: plan.createdModuleRevisionIds, unchanged: false,
      compatibilityMirrorUpdated: nextRoot.primary_branch_id === selected.branchId,
      boundary: {
        immutableCompositionCreated: true, branchAdvanced: true, articleBranchAdvanced: true,
        revisionCreated: true, packageMainAdvanced: nextRoot.primary_branch_id === selected.branchId,
      },
    },
  };
}

void _saveWorkingPackage0009;
void _commitWorkingPackage0009;

async function registerPublicationVersion(db: D1Database, payload: JsonObject, inputSha256: string): Promise<MutationResult> {
  const ownerPackageId = requiredText(payload.packageId, "packageId", 160);
  const branchId = requiredText(payload.branchId, "branchId", 160);
  const expectedBranchLockVersion = exactInteger(payload.expectedBranchLockVersion, "expectedBranchLockVersion", 1, 2_147_483_647);
  const expectedRevisionId = requiredText(payload.expectedRevisionId, "expectedRevisionId", 160);
  const expectedBodySha256 = exactSha256(payload.expectedBodySha256, "expectedBodySha256");
  const expectedCompositionId = requiredText(payload.expectedCompositionId, "expectedCompositionId", 160);
  const expectedCompositionSha256 = exactSha256(payload.expectedCompositionSha256, "expectedCompositionSha256");
  const versionValidation = validateArticlePublicationVersion(payload.publicationVersion);
  if (!versionValidation.valid || !versionValidation.version) {
    throw new ProjectPackageApiError("PUBLICATION_VERSION_INVALID", versionValidation.errors.join("；"), 400);
  }
  const publicationVersion = versionValidation.version;
  const target = publicationVersion.role === "platform_variant" ? publicationVersion.targetProfile : null;
  const root = await packageRow(db, ownerPackageId);
  const selected = await loadSelectedPackageBranch(db, root, branchId, true);
  if (selected.branchState.lockVersion !== expectedBranchLockVersion
    || selected.branchState.headRevisionId !== expectedRevisionId
    || selected.branchState.headCompositionId !== expectedCompositionId
    || selected.branchState.headCompositionSha256 !== expectedCompositionSha256
    || selected.branchBridge.headBodySha256 !== expectedBodySha256) {
    throw new ProjectPackageApiError("PUBLICATION_VERSION_CAS_CONFLICT", "分支、Revision、正文或 Composition 基线已变化", 409);
  }
  if (!selected.inSync || selected.workingCopy.dirty) {
    throw new ProjectPackageApiError("PUBLICATION_VERSION_BRANCH_NOT_CLEAN", "PublicationVersion 只能注册在完全同步的干净分支头", 409);
  }
  const documentVersion = publicationVersionFromDocument(parseJson<unknown>(selected.composition.document_json, null));
  if (!documentVersion.valid || !documentVersion.version
    || canonicalJson(documentVersion.version) !== canonicalJson(publicationVersion)) {
    throw new ProjectPackageApiError(
      "PUBLICATION_VERSION_NOT_BOUND_TO_COMPOSITION",
      "当前 Composition metadata.publicationVersion 未精确绑定请求身份",
      409,
    );
  }
  const currentBody = await db.prepare(`SELECT body_text FROM article_revisions
    WHERE id = ? AND branch_id = ? AND body_sha256 = ? LIMIT 1`)
    .bind(expectedRevisionId, branchId, expectedBodySha256).first<D1Row>();
  const semanticGate = await validateArticlePublicationSemanticGate(
    publicationVersion.semanticGate,
    currentBody ? String(currentBody.body_text) : "",
    expectedBodySha256,
  );
  if (!semanticGate.valid) {
    throw new ProjectPackageApiError("PUBLICATION_SEMANTIC_GATE_FAILED", semanticGate.errors.join("；"), 422, {
      semanticGateState: semanticGate.state,
    });
  }
  if (publicationVersion.role === "canonical_baseline") {
    if (root.primary_branch_id !== branchId
      || root.main_composition_id !== expectedCompositionId
      || root.main_composition_sha256 !== expectedCompositionSha256) {
      throw new ProjectPackageApiError("CANONICAL_BASELINE_NOT_PRIMARY", "canonical baseline 必须注册在 Package 当前 primary Composition", 409);
    }
  } else if (root.primary_branch_id === branchId) {
    throw new ProjectPackageApiError("PLATFORM_VARIANT_IS_PRIMARY", "平台版本必须使用独立的非 primary 分支", 409);
  }
  if (target) {
    const currentTarget = await db.prepare(`SELECT id FROM lifecycle_platform_targets
      WHERE id = ? AND profile_key = ? AND profile_sha256 = ? AND status = 'active'
        AND connection_mode = 'manual'
        AND COALESCE(json_extract(profile_json, '$.enabled'), 1) != 0
      LIMIT 1`).bind(target.id, target.profileKey, target.sha256).first<D1Row>();
    if (!currentTarget) {
      throw new ProjectPackageApiError("PUBLICATION_TARGET_STALE", "平台 PublicationVersion 未绑定当前启用的正式文章 Target", 409);
    }
  }

  let baselineVersion: D1Row | null = null;
  if (publicationVersion.role === "platform_variant") {
    baselineVersion = await db.prepare(`SELECT * FROM article_publication_versions
      WHERE package_id = ? AND version_key = 'canonical' AND role = 'canonical_baseline' AND state = 'active' LIMIT 1`)
      .bind(ownerPackageId).first<D1Row>();
    const baseline = publicationVersion.baseline;
    if (!baselineVersion
      || baselineVersion.branch_id !== baseline.branchId
      || baselineVersion.revision_id !== baseline.revisionId
      || baselineVersion.body_sha256 !== baseline.bodySha256
      || baselineVersion.composition_id !== baseline.compositionId
      || baselineVersion.composition_sha256 !== baseline.compositionSha256
      || root.primary_branch_id !== baseline.branchId
      || root.main_composition_id !== baseline.compositionId
      || root.main_composition_sha256 !== baseline.compositionSha256) {
      throw new ProjectPackageApiError("CANONICAL_BASELINE_STALE", "平台版本未绑定当前已注册 canonical baseline", 409);
    }
    const canonicalVersion = validateArticlePublicationVersion(parseJson<unknown>(baselineVersion.publication_version_json, null));
    const canonicalBody = await db.prepare(`SELECT body_text FROM article_revisions
      WHERE id = ? AND branch_id = ? AND body_sha256 = ? LIMIT 1`)
      .bind(baseline.revisionId, baseline.branchId, baseline.bodySha256).first<D1Row>();
    const canonicalGate = await validateArticlePublicationSemanticGate(
      canonicalVersion.version?.semanticGate,
      canonicalBody ? String(canonicalBody.body_text) : "",
      baseline.bodySha256,
    );
    if (!canonicalGate.valid) {
      throw new ProjectPackageApiError("CANONICAL_SEMANTIC_GATE_STALE", "当前 canonical semantic gate 无法复验", 409, { semanticGateState: canonicalGate.state });
    }
    const canonicalGateRecord = canonicalVersion.version?.semanticGate !== null
      && typeof canonicalVersion.version?.semanticGate === "object"
      && !Array.isArray(canonicalVersion.version?.semanticGate)
      ? canonicalVersion.version.semanticGate as Record<string, unknown> : {};
    const canonicalContractSha256 = String(canonicalGateRecord.contractSha256 ?? "").toLowerCase();
    const canonicalPrimaryThesisSha256 = String(canonicalGateRecord.primaryThesisSha256 ?? "").toLowerCase();
    const bindingErrors = validatePlatformCanonicalContractBinding(publicationVersion.semanticGate, canonicalContractSha256, canonicalPrimaryThesisSha256);
    if (bindingErrors.length) {
      throw new ProjectPackageApiError("PLATFORM_CANONICAL_SEMANTIC_BINDING_INVALID", bindingErrors.join("；"), 422);
    }
  }

  const conflicts = await db.prepare(`SELECT * FROM article_publication_versions
    WHERE package_id = ? AND state = 'active' AND (version_key = ? OR branch_id = ?)
    ORDER BY created_at DESC`).bind(ownerPackageId, publicationVersion.versionKey, branchId).all<D1Row>();
  if (conflicts.results.length > 1) {
    throw new ProjectPackageApiError("PUBLICATION_VERSION_REGISTRY_CONFLICT", "current PublicationVersion 注册表存在重复身份，禁止猜测修复", 409);
  }
  const current = conflicts.results[0] ?? null;
  if (current && (current.version_key !== publicationVersion.versionKey || current.branch_id !== branchId)) {
    throw new ProjectPackageApiError("PUBLICATION_VERSION_BRANCH_CONFLICT", "versionKey 或分支已绑定其他 current PublicationVersion", 409);
  }
  const expectedActiveRegistrationId = optionalText(payload.expectedActiveRegistrationId, 160) || null;
  const expectedActiveRegistrationLockVersion = payload.expectedActiveRegistrationLockVersion === undefined
    ? null
    : exactInteger(payload.expectedActiveRegistrationLockVersion, "expectedActiveRegistrationLockVersion", 1, 2_147_483_647);
  if (current && (expectedActiveRegistrationId !== current.id
    || expectedActiveRegistrationLockVersion !== Number(current.lock_version))) {
    throw new ProjectPackageApiError("PUBLICATION_VERSION_REGISTRATION_CAS_CONFLICT", "替换 current 注册必须绑定其 ID 与 lockVersion", 409, {
      currentRegistrationId: current.id,
      currentLockVersion: Number(current.lock_version),
    });
  }
  if (!current && (expectedActiveRegistrationId !== null || expectedActiveRegistrationLockVersion !== null)) {
    throw new ProjectPackageApiError("PUBLICATION_VERSION_REGISTRATION_CAS_CONFLICT", "请求绑定的 current 注册已不存在", 409);
  }

  const now = isoNow();
  const versionJson = canonicalJson(publicationVersion);
  const registrationSha256 = await sha256Text(canonicalJson({
    schemaVersion: "wenmai.article-publication-version-registration/1.0.0",
    packageId: ownerPackageId,
    articleId: root.article_id,
    branchId,
    branchLockVersion: expectedBranchLockVersion,
    revisionId: expectedRevisionId,
    bodySha256: expectedBodySha256,
    compositionId: expectedCompositionId,
    compositionSha256: expectedCompositionSha256,
    publicationVersion,
    baselineVersionId: baselineVersion?.id ?? null,
  }));
  if (current && current.registration_sha256 === registrationSha256) {
    return { data: { ...(await publicationVersionSnapshot(db, ownerPackageId)), registration: parsePublicationVersionRow(current), unchanged: true } };
  }
  const id = `publication-version-${crypto.randomUUID()}`;
  const baseline = publicationVersion.role === "platform_variant" ? publicationVersion.baseline : null;
  const statements: D1PreparedStatement[] = [];
  if (current) {
    statements.push(db.prepare(`UPDATE article_publication_versions SET state = 'superseded',
      lock_version = lock_version + 1, updated_at = ?
      WHERE id = ? AND package_id = ? AND state = 'active' AND lock_version = ?`)
      .bind(now, current.id, ownerPackageId, current.lock_version));
  }
  const replacementId = current ? String(current.id) : null;
  const replacementNextLock = current ? Number(current.lock_version) + 1 : null;
  statements.push(db.prepare(`INSERT INTO article_publication_versions
    (id, package_id, article_id, role, version_key, platform, branch_id, branch_lock_version,
     revision_id, body_sha256, composition_id, composition_sha256,
     target_profile_id, target_profile_key, target_profile_sha256,
     baseline_version_id, baseline_branch_id, baseline_revision_id, baseline_body_sha256,
     baseline_composition_id, baseline_composition_sha256,
     publication_version_json, registration_sha256, state, lock_version, created_at, updated_at)
    SELECT ?, root.id, root.article_id, ?, ?, ?, state.branch_id, state.lock_version,
      state.head_revision_id, revision.body_sha256, state.head_composition_id, state.head_composition_sha256,
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 1, ?, ?
    FROM article_project_packages root
    JOIN package_branch_states state ON state.package_id = root.id AND state.branch_id = ?
    JOIN package_branch_working_copies package_copy
      ON package_copy.package_id = state.package_id AND package_copy.branch_id = state.branch_id
    JOIN article_branches branch ON branch.id = state.branch_id AND branch.article_id = root.article_id
    JOIN article_revisions revision
      ON revision.id = state.head_revision_id AND revision.branch_id = branch.id AND revision.article_id = root.article_id
    JOIN branch_working_copies article_copy ON article_copy.branch_id = branch.id AND article_copy.article_id = root.article_id
    JOIN package_compositions composition
      ON composition.id = state.head_composition_id AND composition.package_id = root.id
    JOIN package_composition_materializations materialization
      ON materialization.package_id = root.id AND materialization.branch_id = state.branch_id
      AND materialization.composition_id = state.head_composition_id
      AND materialization.article_revision_id = state.head_revision_id
    WHERE root.id = ? AND root.status = 'active' AND root.branch_model_version = 2
      AND state.status = 'active' AND state.lock_version = ?
      AND state.head_revision_id = ? AND revision.body_sha256 = ?
      AND state.head_composition_id = ? AND state.head_composition_sha256 = ?
      AND composition.composition_sha256 = state.head_composition_sha256
      AND materialization.composition_sha256 = state.head_composition_sha256
      AND materialization.article_body_sha256 = revision.body_sha256
      AND branch.status = 'active' AND branch.head_revision_id = state.head_revision_id
      AND article_copy.dirty = 0 AND article_copy.base_revision_id = state.head_revision_id
      AND article_copy.body_sha256 = revision.body_sha256
      AND package_copy.dirty = 0 AND package_copy.base_composition_id = state.head_composition_id
      AND package_copy.base_revision_id = state.head_revision_id
      AND (? <> 'canonical_baseline' OR (root.primary_branch_id = state.branch_id
        AND root.main_composition_id = state.head_composition_id
        AND root.main_composition_sha256 = state.head_composition_sha256))
      AND (? <> 'platform_variant' OR root.primary_branch_id <> state.branch_id)
      AND (? <> 'platform_variant' OR EXISTS (SELECT 1 FROM lifecycle_platform_targets target
        WHERE target.id = ? AND target.profile_key = ? AND target.profile_sha256 = ?
          AND target.status = 'active' AND target.connection_mode = 'manual'
          AND COALESCE(json_extract(target.profile_json, '$.enabled'), 1) != 0))
      AND (? <> 'platform_variant' OR EXISTS (
        SELECT 1 FROM article_publication_versions canonical
        WHERE canonical.id = ? AND canonical.package_id = root.id
          AND canonical.role = 'canonical_baseline' AND canonical.version_key = 'canonical'
          AND canonical.state = 'active'
          AND canonical.branch_id = ? AND canonical.revision_id = ?
          AND canonical.body_sha256 = ? AND canonical.composition_id = ?
          AND canonical.composition_sha256 = ?
          AND root.primary_branch_id = canonical.branch_id
          AND root.main_composition_id = canonical.composition_id
          AND root.main_composition_sha256 = canonical.composition_sha256))
      AND (? IS NULL OR EXISTS (SELECT 1 FROM article_publication_versions previous
        WHERE previous.id = ? AND previous.package_id = root.id AND previous.state = 'superseded'
          AND previous.lock_version = ?))
      AND NOT EXISTS (SELECT 1 FROM article_publication_versions active
        WHERE active.package_id = root.id AND active.state = 'active'
          AND (active.version_key = ? OR active.branch_id = state.branch_id))
    LIMIT 1`).bind(
      id, publicationVersion.role, publicationVersion.versionKey, publicationVersion.platform,
      target?.id ?? null, target?.profileKey ?? null, target?.sha256 ?? null,
      baselineVersion?.id ?? null, baseline?.branchId ?? null, baseline?.revisionId ?? null,
      baseline?.bodySha256 ?? null, baseline?.compositionId ?? null, baseline?.compositionSha256 ?? null,
      versionJson, registrationSha256, now, now,
      branchId, ownerPackageId, expectedBranchLockVersion, expectedRevisionId, expectedBodySha256,
      expectedCompositionId, expectedCompositionSha256,
      publicationVersion.role, publicationVersion.role,
      publicationVersion.role, target?.id ?? null, target?.profileKey ?? null, target?.sha256 ?? null,
      publicationVersion.role, baselineVersion?.id ?? null, baseline?.branchId ?? null,
      baseline?.revisionId ?? null, baseline?.bodySha256 ?? null,
      baseline?.compositionId ?? null, baseline?.compositionSha256 ?? null,
      replacementId, replacementId, replacementNextLock,
      publicationVersion.versionKey,
    ));
  statements.push(
    db.prepare(`INSERT INTO workspace_events
      (id, event_type, subject_type, subject_id, article_id, payload_json, input_sha256, created_at)
      SELECT ?, 'package.publication_version_registered', 'article_publication_version', ?,
        article_id, ?, ?, ? FROM article_publication_versions
      WHERE id = ? AND state = 'active' AND registration_sha256 = ?`)
      .bind(`workspace-event-${crypto.randomUUID()}`, id,
        canonicalJson({ packageId: ownerPackageId, branchId, versionKey: publicationVersion.versionKey,
          registrationSha256, replacedRegistrationId: replacementId }),
        inputSha256, now, id, registrationSha256),
    db.prepare(`SELECT CASE WHEN EXISTS (
      SELECT 1 FROM article_publication_versions WHERE id = ? AND package_id = ?
        AND state = 'active' AND registration_sha256 = ?
    ) THEN 1 ELSE json('wenmai-publication-version-registration-incomplete') END AS committed`)
      .bind(id, ownerPackageId, registrationSha256),
  );
  let results: D1Mutation[];
  try {
    results = await db.batch(statements);
  } catch (error) {
    throw new ProjectPackageApiError("PUBLICATION_VERSION_REGISTRATION_CONFLICT", "PublicationVersion 注册发生 CAS 或唯一性冲突", 409, {
      cause: error instanceof Error ? error.message : "unknown",
    });
  }
  const insertIndex = current ? 1 : 0;
  const eventIndex = insertIndex + 1;
  if (current && resultChanges(results[0]) !== 1) {
    throw new ProjectPackageApiError("PUBLICATION_VERSION_REGISTRATION_CAS_CONFLICT", "current 注册已变化", 409);
  }
  if (resultChanges(results[insertIndex]) !== 1 || resultChanges(results[eventIndex]) !== 1) {
    throw new ProjectPackageApiError("PUBLICATION_VERSION_REGISTRATION_INCOMPLETE", "PublicationVersion 或审计事件未完整写入", 500);
  }
  const registered = await db.prepare("SELECT * FROM article_publication_versions WHERE id = ? LIMIT 1").bind(id).first<D1Row>();
  return {
    status: 201,
    data: {
      ...(await publicationVersionSnapshot(db, ownerPackageId)),
      registration: registered ? parsePublicationVersionRow(registered) : null,
      unchanged: false,
    },
  };
}

async function createSlice(db: D1Database, payload: JsonObject, inputSha256: string) {
  const ownerPackageId = requiredText(payload.packageId, "packageId", 160);
  const root = await packageRow(db, ownerPackageId);
  const selectedBranch = await loadSelectedPackageBranch(db, root, optionalText(payload.branchId, 160) || undefined, true);
  const baseRevisionId = optionalText(payload.baseRevisionId, 160) || selectedBranch.branchState.headRevisionId;
  const expectedBranchLockVersion = payload.expectedBranchLockVersion === undefined
    ? selectedBranch.branchState.lockVersion
    : exactInteger(payload.expectedBranchLockVersion, "expectedBranchLockVersion", 1, 2_147_483_647);
  if (expectedBranchLockVersion !== selectedBranch.branchState.lockVersion) {
    throw new ProjectPackageApiError("PACKAGE_BRANCH_CAS_CONFLICT", "创建 Slice 时分支 lockVersion 已变化", 409);
  }
  const compositionId = requiredText(payload.compositionId, "compositionId", 160);
  const expectedCompositionSha256 = exactSha256(payload.expectedCompositionSha256, "expectedCompositionSha256");
  const title = requiredText(payload.title, "title", 300);
  const sliceKind = requiredText(payload.sliceKind, "sliceKind", 40);
  if (!SLICE_KINDS.has(sliceKind)) throw new ProjectPackageApiError("INVALID_SLICE_KIND", "sliceKind 无效");
  const detail = await loadCompositionDetail(db, compositionId, ownerPackageId);
  assertCompositionSha(detail.row, expectedCompositionSha256);
  const branchCommit = await db.prepare(`SELECT * FROM package_branch_composition_commits
    WHERE package_id = ? AND branch_id = ? AND composition_id = ? AND composition_sha256 = ?
      AND article_revision_id = ? LIMIT 1`)
    .bind(ownerPackageId, selectedBranch.branchId, compositionId, expectedCompositionSha256, baseRevisionId).first<D1Row>();
  if (!branchCommit) throw new ProjectPackageApiError("BRANCH_COMPOSITION_NOT_FOUND", "Composition 不在指定 ArticleBranch 的提交历史中", 409);
  const requestedKeys = stringArray(payload.moduleKeys, "moduleKeys", MAX_MODULES, 120);
  if (sliceKind === "custom" && requestedKeys.length === 0) throw new ProjectPackageApiError("MODULE_KEYS_REQUIRED", "custom Slice 必须指定 moduleKeys");
  const allKeys = detail.nodes.map((node) => node.nodeKey);
  const selectedKeys = requestedKeys.length > 0
    ? requestedKeys
    : sliceKind === "full" ? allKeys : sliceKind === "demo" ? allKeys.slice(0, 3) : allKeys.slice(0, 1);
  const unknown = selectedKeys.find((key) => !allKeys.includes(key));
  if (unknown) throw new ProjectPackageApiError("SLICE_MODULE_NOT_FOUND", `Slice 指定的模块不存在：${unknown}`);
  const selected = new Set(selectedKeys);
  const selectedNodes = detail.nodes.filter((node) => selected.has(node.nodeKey));
  const selectedNodeIds = new Set(selectedNodes.map((node) => node.id));
  const selectedRevisions = new Set(selectedNodes.map((node) => node.moduleRevisionId));
  const selector = canonicalValue({ ...objectValue(payload.selector, "selector"), moduleKeys: selectedKeys }) as JsonObject;
  const resolvedManifest = canonicalValue({
    schemaVersion: "wenmai-slice-manifest-v1", packageId: ownerPackageId,
    branchId: selectedBranch.branchId, baseRevisionId, baseBranchLockVersion: expectedBranchLockVersion,
    branchCommitId: branchCommit.id, compositionId,
    compositionSha256: expectedCompositionSha256,
    modules: detail.moduleRevisions.filter((revision) => selectedRevisions.has(String(revision.id))).map((revision) => ({
      moduleId: revision.moduleId, moduleRevisionId: revision.id, revisionSha256: revision.revisionSha256, contentSha256: revision.contentSha256,
    })),
    edges: detail.edges.filter((edge) => selectedNodeIds.has(edge.sourceNodeId) && selectedNodeIds.has(edge.targetNodeId)).map((edge) => ({
      edgeKey: edge.edgeKey, edgeSha256: edge.edgeSha256,
    })),
  }) as JsonObject;
  const sliceSha256 = await sha256Text(canonicalJson({
    packageId: ownerPackageId, branchId: selectedBranch.branchId, baseRevisionId,
    baseBranchLockVersion: expectedBranchLockVersion, compositionSha256: expectedCompositionSha256,
    sliceKind, selector, resolvedManifest,
  }));
  const existing = await db.prepare("SELECT * FROM package_slices WHERE package_id = ? AND branch_id = ? AND slice_sha256 = ? LIMIT 1")
    .bind(ownerPackageId, selectedBranch.branchId, sliceSha256).first<D1Row>();
  if (existing) return { data: { slice: parseSliceRow(existing, true), reused: true } };
  const id = `slice-${crypto.randomUUID()}`;
  const now = isoNow();
  const results = await db.batch([
    db.prepare(`INSERT INTO package_slices
      (id, package_id, branch_id, base_revision_id, base_branch_lock_version,
       composition_id, composition_sha256, title, slice_kind, selector_json,
       resolved_manifest_json, slice_sha256, created_by_kind, created_at)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'user', ?
      WHERE EXISTS (SELECT 1 FROM package_branch_states WHERE package_id = ? AND branch_id = ?
        AND lock_version = ? AND status = 'active')
        AND EXISTS (SELECT 1 FROM package_branch_composition_commits WHERE id = ? AND package_id = ?
          AND branch_id = ? AND composition_id = ? AND article_revision_id = ?)`)
      .bind(id, ownerPackageId, selectedBranch.branchId, baseRevisionId, expectedBranchLockVersion,
        compositionId, expectedCompositionSha256, title, sliceKind, canonicalJson(selector), canonicalJson(resolvedManifest), sliceSha256, now,
        ownerPackageId, selectedBranch.branchId, expectedBranchLockVersion,
        branchCommit.id, ownerPackageId, selectedBranch.branchId, compositionId, baseRevisionId),
    appendEventStatement(db, {
      eventType: "package.slice_created", subjectType: "package_slice", subjectId: id,
      articleId: String(root.article_id), payload: {
        packageId: ownerPackageId, branchId: selectedBranch.branchId, baseRevisionId,
        baseBranchLockVersion: expectedBranchLockVersion, compositionId, sliceSha256,
      }, inputSha256, createdAt: now,
    }),
  ]);
  assertAllChanged(results, "SLICE_CREATE_CONFLICT", "Slice 创建发生并发冲突");
  const row = await db.prepare("SELECT * FROM package_slices WHERE id = ?").bind(id).first<D1Row>();
  return { status: 201, data: { slice: parseSliceRow(row!, true), reused: false } };
}

async function applyPatchOperations(
  db: D1Database,
  ownerPackageId: string,
  baseDocument: PackageDocument,
  operationsValue: unknown,
) {
  if (!Array.isArray(operationsValue) || operationsValue.length < 1 || operationsValue.length > MAX_PATCH_OPERATIONS) {
    throw new ProjectPackageApiError("INVALID_PATCH_OPERATIONS", `operations 必须包含 1 到 ${MAX_PATCH_OPERATIONS} 项`);
  }
  let current = await prepareDocument(db, ownerPackageId, baseDocument, baseDocument);
  const normalized: PackagePatchOperation[] = [];
  for (let index = 0; index < operationsValue.length; index += 1) {
    const raw = operationsValue[index];
    if (!isObject(raw)) throw new ProjectPackageApiError("INVALID_PATCH_OPERATION", `operations[${index}] 必须是对象`);
    const op = requiredText(raw.op, `operations[${index}].op`, 40);
    const draft = JSON.parse(canonicalJson(current)) as PackageDocument;
    if (op === "replace_document") {
      current = await prepareDocument(db, ownerPackageId, raw.document, current);
      normalized.push({ op, document: current });
      continue;
    }
    if (op === "replace_module") {
      const moduleKey = safeKey(raw.moduleKey, `operations[${index}].moduleKey`);
      const target = draft.modules.findIndex((module) => module.key === moduleKey);
      if (target < 0) throw new ProjectPackageApiError("PATCH_MODULE_NOT_FOUND", `待替换模块不存在：${moduleKey}`);
      if (!isObject(raw.module)) throw new ProjectPackageApiError("INVALID_PATCH_MODULE", "replace_module.module 必须是对象");
      draft.modules[target] = { ...raw.module, key: moduleKey } as unknown as PackageModuleInput;
      current = await prepareDocument(db, ownerPackageId, draft, current);
      normalized.push({ op, moduleKey, module: current.modules.find((module) => module.key === moduleKey)! });
      continue;
    }
    if (op === "add_module") {
      if (!isObject(raw.module)) throw new ProjectPackageApiError("INVALID_PATCH_MODULE", "add_module.module 必须是对象");
      const moduleKey = safeKey(raw.module.key, `operations[${index}].module.key`);
      if (draft.modules.some((module) => module.key === moduleKey)) throw new ProjectPackageApiError("PATCH_MODULE_EXISTS", `模块已存在：${moduleKey}`);
      draft.modules.push(raw.module as unknown as PackageModuleInput);
      current = await prepareDocument(db, ownerPackageId, draft, current);
      normalized.push({ op, module: current.modules.find((module) => module.key === moduleKey)! });
      continue;
    }
    if (op === "remove_module") {
      const moduleKey = safeKey(raw.moduleKey, `operations[${index}].moduleKey`);
      if (moduleKey === draft.rootModuleKey) throw new ProjectPackageApiError("ROOT_MODULE_REMOVE_FORBIDDEN", "不能移除根模块");
      if (!draft.modules.some((module) => module.key === moduleKey)) throw new ProjectPackageApiError("PATCH_MODULE_NOT_FOUND", `待移除模块不存在：${moduleKey}`);
      draft.modules = draft.modules.filter((module) => module.key !== moduleKey);
      draft.edges = draft.edges.filter((edge) => edge.sourceModuleKey !== moduleKey && edge.targetModuleKey !== moduleKey);
      current = await prepareDocument(db, ownerPackageId, draft, current);
      normalized.push({ op, moduleKey });
      continue;
    }
    if (op === "upsert_edge") {
      if (!isObject(raw.edge)) throw new ProjectPackageApiError("INVALID_PATCH_EDGE", "upsert_edge.edge 必须是对象");
      const edgeKey = safeKey(raw.edge.key, `operations[${index}].edge.key`);
      const target = draft.edges.findIndex((edge) => edge.key === edgeKey);
      if (target >= 0) draft.edges[target] = raw.edge as unknown as PackageEdgeInput;
      else draft.edges.push(raw.edge as unknown as PackageEdgeInput);
      current = await prepareDocument(db, ownerPackageId, draft, current);
      normalized.push({ op, edge: current.edges.find((edge) => edge.key === edgeKey)! });
      continue;
    }
    if (op === "remove_edge") {
      const edgeKey = safeKey(raw.edgeKey, `operations[${index}].edgeKey`);
      if (!draft.edges.some((edge) => edge.key === edgeKey)) throw new ProjectPackageApiError("PATCH_EDGE_NOT_FOUND", `待移除 Edge 不存在：${edgeKey}`);
      draft.edges = draft.edges.filter((edge) => edge.key !== edgeKey);
      current = await prepareDocument(db, ownerPackageId, draft, current);
      normalized.push({ op, edgeKey });
      continue;
    }
    throw new ProjectPackageApiError("UNKNOWN_PATCH_OPERATION", `未知 Patch operation：${op}`);
  }
  return { document: current, operations: normalized };
}

async function validateDiagnosticIssueIds(
  db: D1Database,
  ownerPackageId: string,
  branchId: string,
  compositionId: string,
  issueIds: string[],
) {
  if (issueIds.length === 0) return;
  const row = await db.prepare(`SELECT COUNT(DISTINCT id) AS count FROM package_diagnostic_issues
    WHERE package_id = ? AND branch_id = ? AND composition_id = ? AND id IN (SELECT value FROM json_each(?))`)
    .bind(ownerPackageId, branchId, compositionId, canonicalJson(issueIds)).first<D1Row>();
  if (Number(row?.count ?? 0) !== issueIds.length) {
    throw new ProjectPackageApiError("DIAGNOSTIC_ISSUE_BOUNDARY_MISMATCH", "diagnosticIssueIds 含有不存在或不属于基线 Composition 的 Issue", 409);
  }
}

async function createPatchProposal(db: D1Database, payload: JsonObject, inputSha256: string) {
  const ownerPackageId = requiredText(payload.packageId, "packageId", 160);
  const baseCompositionId = requiredText(payload.baseCompositionId, "baseCompositionId", 160);
  const expectedBaseCompositionSha256 = exactSha256(payload.expectedBaseCompositionSha256, "expectedBaseCompositionSha256");
  const title = requiredText(payload.title, "title", 300);
  const summary = optionalText(payload.summary, 2_000, true);
  const evidence = stringArray(payload.evidence, "evidence", 100, 1_000);
  const diagnosticIssueIds = stringArray(payload.diagnosticIssueIds, "diagnosticIssueIds", 100, 160);
  const root = await packageRow(db, ownerPackageId);
  const selectedBranch = await loadSelectedPackageBranch(db, root, optionalText(payload.branchId, 160) || undefined, true);
  const baseRevisionId = optionalText(payload.baseRevisionId, 160) || selectedBranch.branchState.headRevisionId;
  const expectedBranchLockVersion = payload.expectedBranchLockVersion === undefined
    ? selectedBranch.branchState.lockVersion
    : exactInteger(payload.expectedBranchLockVersion, "expectedBranchLockVersion", 1, 2_147_483_647);
  if (expectedBranchLockVersion !== selectedBranch.branchState.lockVersion) {
    throw new ProjectPackageApiError("PACKAGE_BRANCH_CAS_CONFLICT", "创建 Patch 时分支 lockVersion 已变化", 409);
  }
  const base = await compositionRow(db, baseCompositionId, ownerPackageId);
  assertCompositionSha(base, expectedBaseCompositionSha256);
  const branchCommit = await db.prepare(`SELECT id FROM package_branch_composition_commits
    WHERE package_id = ? AND branch_id = ? AND composition_id = ? AND composition_sha256 = ?
      AND article_revision_id = ? LIMIT 1`)
    .bind(ownerPackageId, selectedBranch.branchId, baseCompositionId, expectedBaseCompositionSha256, baseRevisionId).first<D1Row>();
  if (!branchCommit) throw new ProjectPackageApiError("BRANCH_COMPOSITION_NOT_FOUND", "Patch 基线不在指定 ArticleBranch 的提交历史中", 409);
  await validateDiagnosticIssueIds(db, ownerPackageId, selectedBranch.branchId, baseCompositionId, diagnosticIssueIds);
  const baseDocument = parseJson<PackageDocument>(base.document_json, {} as PackageDocument);
  const applied = await applyPatchOperations(db, ownerPackageId, baseDocument, payload.operations);
  const nextDocumentSha256 = await documentSha(applied.document);
  if (nextDocumentSha256 === base.document_sha256) throw new ProjectPackageApiError("PATCH_HAS_NO_CHANGES", "Patch 应用后没有产生文档变化");
  const patchSha256 = await sha256Text(canonicalJson({
    packageId: ownerPackageId, baseCompositionId, baseCompositionSha256: expectedBaseCompositionSha256,
    branchId: selectedBranch.branchId, baseRevisionId,
    baseBranchLockVersion: expectedBranchLockVersion,
    title, summary, operations: applied.operations, evidence, diagnosticIssueIds,
  }));
  const existing = await db.prepare("SELECT * FROM package_patch_proposals WHERE package_id = ? AND patch_sha256 = ? LIMIT 1")
    .bind(ownerPackageId, patchSha256).first<D1Row>();
  if (existing) {
    return {
      data: {
        patchProposal: parsePatchRow(existing, true), reused: true,
        boundary: { candidateOnly: true, packageMainAdvanced: false, compositionCreated: false },
      },
    };
  }
  const id = `patch-${crypto.randomUUID()}`;
  const now = isoNow();
  const results = await db.batch([
    db.prepare(`INSERT INTO package_patch_proposals
      (id, package_id, base_composition_id, base_composition_sha256, branch_id, base_revision_id,
       base_package_lock_version, base_branch_lock_version,
       task_id, attempt_id, context_sha256,
       title, summary, operations_json, patch_sha256, evidence_json, diagnostic_issue_ids_json,
       status, lock_version, created_by_kind, created_by_id, decision_note, created_at)
      SELECT ?, ?, ?, ?, ?, ?, NULL, ?, NULL, NULL, NULL, ?, ?, ?, ?, ?, ?, 'candidate', 1, ?, 'local-user', '', ?
      WHERE EXISTS (SELECT 1 FROM package_branch_states WHERE package_id = ? AND branch_id = ?
        AND lock_version = ? AND status = 'active')
        AND EXISTS (SELECT 1 FROM package_branch_composition_commits WHERE id = ? AND package_id = ?
          AND branch_id = ? AND composition_id = ? AND article_revision_id = ?)`)
      .bind(
        id, ownerPackageId, baseCompositionId, expectedBaseCompositionSha256,
        selectedBranch.branchId, baseRevisionId, expectedBranchLockVersion, title, summary,
        canonicalJson(applied.operations), patchSha256, canonicalJson(evidence), canonicalJson(diagnosticIssueIds),
        diagnosticIssueIds.length > 0 ? "diagnostic" : "user", now,
        ownerPackageId, selectedBranch.branchId, expectedBranchLockVersion,
        branchCommit.id, ownerPackageId, selectedBranch.branchId, baseCompositionId, baseRevisionId,
      ),
    appendEventStatement(db, {
      eventType: "package.patch_proposed", subjectType: "package_patch_proposal", subjectId: id,
      articleId: String(root.article_id), payload: {
        packageId: ownerPackageId, branchId: selectedBranch.branchId, baseRevisionId,
        baseBranchLockVersion: expectedBranchLockVersion, baseCompositionId, patchSha256, candidateOnly: true,
      },
      inputSha256, createdAt: now,
    }),
  ]);
  assertAllChanged(results, "PATCH_CREATE_CONFLICT", "PatchProposal 创建发生并发冲突");
  const row = await patchRow(db, id, ownerPackageId);
  return {
    status: 201,
    data: {
      patchProposal: parsePatchRow(row, true), reused: false,
      boundary: { candidateOnly: true, packageMainAdvanced: false, compositionCreated: false },
    },
  };
}

async function decidePatchProposal(
  db: D1Database,
  payload: JsonObject,
  inputSha256: string,
  principal: ControlPrincipal,
) {
  const patchProposalId = requiredText(payload.patchProposalId, "patchProposalId", 160);
  const expectedLockVersion = exactInteger(payload.expectedLockVersion, "expectedLockVersion", 1, 2_147_483_647);
  const decision = requiredText(payload.decision, "decision", 20);
  if (!PATCH_DECISIONS.has(decision)) throw new ProjectPackageApiError("INVALID_PATCH_DECISION", "decision 只能是 approved 或 rejected");
  const note = optionalText(payload.note, 2_000, true);
  if (decision === "rejected" && !note) throw new ProjectPackageApiError("DECISION_NOTE_REQUIRED", "拒绝 Patch 时必须填写 note");
  const current = await patchRow(db, patchProposalId);
  if (current.status !== "candidate" || Number(current.lock_version) !== expectedLockVersion) {
    throw new ProjectPackageApiError("PATCH_DECISION_CONFLICT", "Patch 已被决定或 lockVersion 已变化", 409, {
      currentStatus: current.status, currentLockVersion: Number(current.lock_version),
    });
  }
  if (principal.kind === "agent" && current.created_by_kind === "agent") {
    if (!current.created_by_id) {
      throw new ProjectPackageApiError("AGENT_PATCH_CREATOR_BINDING_MISSING", "Agent Patch 缺少持久的创建者绑定", 409);
    }
    if (await sameAgentAuthorityLineage(db, String(current.created_by_id), principal.clientId)) {
      throw new ProjectPackageApiError("AGENT_PATCH_SELF_DECISION_FORBIDDEN", "Agent 不能决定同一 authority lineage 创建的 PatchProposal", 403);
    }
  }
  const root = await packageRow(db, String(current.package_id));
  const migrationAudit = await migrationAuditRow(db, String(root.id));
  if (migrationAudit?.state === "blocked") {
    throw new ProjectPackageApiError("PACKAGE_BRANCH_MIGRATION_REQUIRED", "Package 分支迁移审计被阻断；修复前禁止决定 Patch", 409, {
      migrationAudit: parseMigrationAuditRow(migrationAudit),
    });
  }
  const now = isoNow();
  const decidedByKind = principal.kind === "agent" ? "agent" : "owner";
  const decidedById = principal.kind === "agent" ? principal.clientId : principal.actorId;
  const update = db.prepare(`UPDATE package_patch_proposals
    SET status = ?, lock_version = lock_version + 1, decision_note = ?, reviewed_at = ?,
      decided_by_kind = ?, decided_by_id = ?
    WHERE id = ? AND status = 'candidate' AND lock_version = ?`)
    .bind(decision, note, now, decidedByKind, decidedById, patchProposalId, expectedLockVersion);
  const event = db.prepare(`INSERT INTO workspace_events
    (id, event_type, subject_type, subject_id, article_id, payload_json, input_sha256, created_at)
    SELECT ?, 'package.patch_decided', 'package_patch_proposal', ?, ?, ?, ?, ?
    WHERE changes() = 1 AND EXISTS (
      SELECT 1 FROM package_patch_proposals WHERE id = ? AND status = ? AND lock_version = ?
    )`).bind(
      `workspace-event-${crypto.randomUUID()}`, patchProposalId, root.article_id,
      canonicalJson({ decision, note, decidedByKind, decidedById, packageMainAdvanced: false }), inputSha256, now,
      patchProposalId, decision, expectedLockVersion + 1,
    );
  const results = await db.batch([update, event]);
  assertAllChanged(results, "PATCH_DECISION_CONFLICT", "Patch 决定发生并发冲突");
  const next = await patchRow(db, patchProposalId);
  return {
    data: {
      patchProposal: parsePatchRow(next, true),
      boundary: { candidateOnly: decision === "approved", packageMainAdvanced: false, compositionCreated: false },
    },
  };
}

async function _applyPatchProposal0009(db: D1Database, payload: JsonObject, inputSha256: string) {
  const ownerPackageId = requiredText(payload.packageId, "packageId", 160);
  const patchProposalId = requiredText(payload.patchProposalId, "patchProposalId", 160);
  const expectedPatchLockVersion = exactInteger(payload.expectedPatchLockVersion, "expectedPatchLockVersion", 1, 2_147_483_647);
  const expectedPackageLockVersion = exactInteger(payload.expectedPackageLockVersion, "expectedPackageLockVersion", 1, 2_147_483_647);
  const expectedMainCompositionId = requiredText(payload.expectedMainCompositionId, "expectedMainCompositionId", 160);
  const expectedMainCompositionSha256 = exactSha256(payload.expectedMainCompositionSha256, "expectedMainCompositionSha256");
  const state = await currentPackageState(db, ownerPackageId);
  assertPackageCas(state.root, expectedPackageLockVersion, expectedMainCompositionId, expectedMainCompositionSha256);
  const bridgeState = await packageBranchBridgeState(db, state.root, state.working);
  if (bridgeState && (bridgeState.row.branch_status !== "active"
    || bridgeState.row.working_base_revision_id !== bridgeState.row.head_revision_id
    || Number(bridgeState.row.branch_working_dirty) !== 0
    || !bridgeState.materialization
    || bridgeState.materialization.article_revision_id !== bridgeState.row.head_revision_id)) {
    throw new ProjectPackageApiError("PACKAGE_BRANCH_CAS_CONFLICT", "Patch 基线与 ArticleBranch clean head 不一致", 409);
  }
  if (Number(state.working.dirty) !== 0 || state.working.base_composition_id !== expectedMainCompositionId) {
    throw new ProjectPackageApiError("DIRTY_WORKING_COPY", "应用 Patch 前必须先提交或恢复当前工作副本", 409, {
      workingBaseCompositionId: state.working.base_composition_id, dirty: Number(state.working.dirty) === 1,
    });
  }
  const proposal = await patchRow(db, patchProposalId, ownerPackageId);
  if (proposal.status !== "approved" || Number(proposal.lock_version) !== expectedPatchLockVersion) {
    throw new ProjectPackageApiError("PATCH_APPLY_CONFLICT", "Patch 未获批准或 lockVersion 已变化", 409, {
      currentStatus: proposal.status, currentLockVersion: Number(proposal.lock_version),
    });
  }
  if (proposal.base_composition_id !== expectedMainCompositionId || proposal.base_composition_sha256 !== expectedMainCompositionSha256) {
    throw new ProjectPackageApiError("PATCH_BASE_STALE", "Patch 未应用：它绑定的基线已不是当前主 Composition。当前 Composition 与原 Patch 记录均保留；请基于最新 Composition 重新生成并审批 Patch，不要强行套用旧 Patch。", 409, {
      patchBaseCompositionId: proposal.base_composition_id, patchBaseCompositionSha256: proposal.base_composition_sha256,
    });
  }
  if (proposal.created_by_kind === "agent" && (!proposal.branch_id || !proposal.base_revision_id || proposal.base_package_lock_version === null)) {
    throw new ProjectPackageApiError("AGENT_PATCH_BRIDGE_BINDING_MISSING", "Agent Package Patch 缺少冻结 Branch/Revision/Package lock 绑定", 409);
  }
  if (proposal.branch_id && (!bridgeState
    || proposal.branch_id !== bridgeState.row.branch_id
    || proposal.base_revision_id !== bridgeState.row.head_revision_id
    || Number(proposal.base_package_lock_version) !== expectedPackageLockVersion)) {
    throw new ProjectPackageApiError("PATCH_BRANCH_BASE_STALE", "Patch 的 Branch/Revision/Package lock 基线已过期", 409, {
      patchBranchId: proposal.branch_id, patchBaseRevisionId: proposal.base_revision_id,
      currentBranchId: bridgeState?.row.branch_id ?? null, currentRevisionId: bridgeState?.row.head_revision_id ?? null,
    });
  }
  const baseDocument = parseJson<PackageDocument>(state.composition.document_json, {} as PackageDocument);
  const applied = await applyPatchOperations(
    db, ownerPackageId, baseDocument, parseJson<PackagePatchOperation[]>(proposal.operations_json, []),
  );
  const appliedDocumentSha256 = await documentSha(applied.document);
  if (appliedDocumentSha256 === state.composition.document_sha256) {
    throw new ProjectPackageApiError("PATCH_HAS_NO_CHANGES", "Patch 对当前基线不再产生变化", 409);
  }
  const rendered = renderPackageDocument(applied.document);
  const renderedBodySha256 = await sha256Text(rendered.bodyText);
  const materializedRevisionId = bridgeState ? `revision-${crypto.randomUUID()}` : null;
  const proposalAuthorKind = proposal.created_by_kind === "agent" ? "agent" : proposal.created_by_kind === "import" ? "import" : "user";
  const plan = await buildMaterializationPlan(db, {
    packageId: ownerPackageId, document: applied.document, parentCompositionId: expectedMainCompositionId,
    title: String(proposal.title), authorKind: proposalAuthorKind,
    sourcePatchId: patchProposalId, sourceArticleRevisionId: materializedRevisionId,
  });
  const expectedWorkingLockVersion = Number(state.working.lock_version);
  const nextPackageLock = expectedPackageLockVersion + 1;
  const rootCas = bridgeState
    ? db.prepare(`UPDATE article_project_packages
        SET title = ?, main_composition_id = ?, main_composition_sha256 = ?, lock_version = lock_version + 1, updated_at = ?
        WHERE id = ? AND status = 'active' AND lock_version = ? AND primary_branch_id = ?
          AND main_composition_id = ? AND main_composition_sha256 = ?
          AND EXISTS (SELECT 1 FROM package_patch_proposals patch
            WHERE patch.id = ? AND patch.package_id = ? AND patch.status = 'approved' AND patch.lock_version = ?
              AND patch.base_composition_id = ? AND patch.base_composition_sha256 = ?
              AND (patch.branch_id IS NULL OR (patch.branch_id = ? AND patch.base_revision_id = ?
                AND patch.base_package_lock_version = ?)))
          AND EXISTS (SELECT 1 FROM package_working_copies copy
            WHERE copy.package_id = ? AND copy.branch_id = ? AND copy.base_revision_id = ?
              AND copy.base_composition_id = ? AND copy.dirty = 0 AND copy.lock_version = ?)
          AND EXISTS (SELECT 1 FROM article_branches branch
            JOIN branch_working_copies copy ON copy.branch_id = branch.id
            WHERE branch.id = ? AND branch.article_id = ? AND branch.status = 'active' AND branch.head_revision_id = ?
              AND copy.base_revision_id = ? AND copy.dirty = 0 AND copy.lock_version = ?)
          AND EXISTS (SELECT 1 FROM package_composition_materializations bridge
            WHERE bridge.package_id = ? AND bridge.branch_id = ? AND bridge.composition_id = ?
              AND bridge.composition_sha256 = ? AND bridge.article_revision_id = ?)`)
      .bind(
        applied.document.title, plan.compositionId, plan.compositionSha256, plan.createdAt,
        ownerPackageId, expectedPackageLockVersion, bridgeState.row.branch_id,
        expectedMainCompositionId, expectedMainCompositionSha256,
        patchProposalId, ownerPackageId, expectedPatchLockVersion, expectedMainCompositionId, expectedMainCompositionSha256,
        bridgeState.row.branch_id, bridgeState.row.head_revision_id, expectedPackageLockVersion,
        ownerPackageId, bridgeState.row.branch_id, bridgeState.row.head_revision_id,
        expectedMainCompositionId, expectedWorkingLockVersion,
        bridgeState.row.branch_id, state.root.article_id, bridgeState.row.head_revision_id,
        bridgeState.row.head_revision_id, bridgeState.row.branch_working_lock_version,
        ownerPackageId, bridgeState.row.branch_id, expectedMainCompositionId,
        expectedMainCompositionSha256, bridgeState.row.head_revision_id,
      )
    : db.prepare(`UPDATE article_project_packages
        SET title = ?, main_composition_id = ?, main_composition_sha256 = ?, lock_version = lock_version + 1, updated_at = ?
        WHERE id = ? AND status = 'active' AND lock_version = ? AND primary_branch_id IS NULL
          AND main_composition_id = ? AND main_composition_sha256 = ?
          AND EXISTS (SELECT 1 FROM package_patch_proposals patch
            WHERE patch.id = ? AND patch.package_id = ? AND patch.status = 'approved' AND patch.lock_version = ?
              AND patch.base_composition_id = ? AND patch.base_composition_sha256 = ? AND patch.branch_id IS NULL)
          AND EXISTS (SELECT 1 FROM package_working_copies copy
            WHERE copy.package_id = ? AND copy.base_composition_id = ? AND copy.dirty = 0 AND copy.lock_version = ?)`)
      .bind(
        applied.document.title, plan.compositionId, plan.compositionSha256, plan.createdAt,
        ownerPackageId, expectedPackageLockVersion, expectedMainCompositionId, expectedMainCompositionSha256,
        patchProposalId, ownerPackageId, expectedPatchLockVersion, expectedMainCompositionId, expectedMainCompositionSha256,
        ownerPackageId, expectedMainCompositionId, expectedWorkingLockVersion,
      );
  const immutableStatements = materializationStatements(db, plan, nextPackageLock);
  const bridgeStatements: D1PreparedStatement[] = [];
  if (bridgeState && materializedRevisionId) {
    const sequenceRow = await db.prepare("SELECT COALESCE(MAX(sequence), 0) AS maximum FROM article_revisions WHERE branch_id = ?")
      .bind(bridgeState.row.branch_id).first<D1Row>();
    const nextSequence = Number(sequenceRow?.maximum ?? 0) + 1;
    const materializationId = `package-materialization-${crypto.randomUUID()}`;
    bridgeStatements.push(
      db.prepare(`UPDATE article_branches SET head_revision_id = ?, updated_at = ?
        WHERE id = ? AND article_id = ? AND status = 'active' AND head_revision_id = ?
          AND EXISTS (SELECT 1 FROM branch_working_copies copy WHERE copy.branch_id = article_branches.id
            AND copy.base_revision_id = ? AND copy.dirty = 0 AND copy.lock_version = ?)
          AND EXISTS (SELECT 1 FROM article_project_packages WHERE id = ? AND primary_branch_id = ?
            AND main_composition_id = ? AND main_composition_sha256 = ? AND lock_version = ?)`)
        .bind(
          materializedRevisionId, plan.createdAt, bridgeState.row.branch_id, state.root.article_id,
          bridgeState.row.head_revision_id, bridgeState.row.head_revision_id, bridgeState.row.branch_working_lock_version,
          ownerPackageId, bridgeState.row.branch_id, plan.compositionId, plan.compositionSha256, nextPackageLock,
        ),
      db.prepare(`INSERT INTO article_revisions
        (id, article_id, branch_id, sequence, parent_revision_id, merge_parent_revision_id, source_version_id,
         title, document_title, annotation, body_text, body_sha256, author_kind, created_at)
        SELECT ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?
        WHERE EXISTS (SELECT 1 FROM article_branches WHERE id = ? AND head_revision_id = ?)
          AND EXISTS (SELECT 1 FROM article_project_packages WHERE id = ? AND main_composition_id = ?
            AND main_composition_sha256 = ? AND lock_version = ?)`)
        .bind(
          materializedRevisionId, state.root.article_id, bridgeState.row.branch_id, nextSequence,
          bridgeState.row.head_revision_id, `文章工程 Patch · ${proposal.title}`, rendered.documentTitle,
          `人工应用候选 ${patchProposalId}；由 ${PACKAGE_RENDERER_KEY}@${PACKAGE_RENDERER_VERSION} 确定性渲染。`,
          rendered.bodyText, renderedBodySha256, bridgeRevisionAuthor(proposalAuthorKind), plan.createdAt,
          bridgeState.row.branch_id, materializedRevisionId,
          ownerPackageId, plan.compositionId, plan.compositionSha256, nextPackageLock,
        ),
      db.prepare(`UPDATE branch_working_copies SET base_revision_id = ?, title = ?, annotation = '',
          body_text = ?, body_sha256 = ?, dirty = 0, lock_version = lock_version + 1, updated_at = ?
        WHERE branch_id = ? AND base_revision_id = ? AND dirty = 0 AND lock_version = ?
          AND EXISTS (SELECT 1 FROM article_branches WHERE id = ? AND head_revision_id = ?)
          AND EXISTS (SELECT 1 FROM article_revisions WHERE id = ? AND branch_id = ? AND body_sha256 = ?)`)
        .bind(
          materializedRevisionId, rendered.documentTitle, rendered.bodyText, renderedBodySha256, plan.createdAt,
          bridgeState.row.branch_id, bridgeState.row.head_revision_id, bridgeState.row.branch_working_lock_version,
          bridgeState.row.branch_id, materializedRevisionId,
          materializedRevisionId, bridgeState.row.branch_id, renderedBodySha256,
        ),
      db.prepare(`INSERT INTO package_composition_materializations
        (id, package_id, branch_id, composition_id, composition_sha256, article_revision_id, article_body_sha256,
         renderer_key, renderer_version, created_by_kind, created_at)
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        WHERE EXISTS (SELECT 1 FROM article_project_packages WHERE id = ? AND primary_branch_id = ?
          AND main_composition_id = ? AND main_composition_sha256 = ? AND lock_version = ?)
          AND EXISTS (SELECT 1 FROM article_branches WHERE id = ? AND head_revision_id = ?)
          AND EXISTS (SELECT 1 FROM article_revisions WHERE id = ? AND branch_id = ? AND body_sha256 = ?)`)
        .bind(
          materializationId, ownerPackageId, bridgeState.row.branch_id, plan.compositionId, plan.compositionSha256,
          materializedRevisionId, renderedBodySha256, PACKAGE_RENDERER_KEY, PACKAGE_RENDERER_VERSION,
          proposalAuthorKind, plan.createdAt,
          ownerPackageId, bridgeState.row.branch_id, plan.compositionId, plan.compositionSha256, nextPackageLock,
          bridgeState.row.branch_id, materializedRevisionId,
          materializedRevisionId, bridgeState.row.branch_id, renderedBodySha256,
        ),
    );
  }
  const resetWorking = db.prepare(`UPDATE package_working_copies
    SET base_composition_id = ?, base_revision_id = ?, document_json = ?, document_sha256 = ?, dirty = 0,
      lock_version = lock_version + 1, updated_at = ?
    WHERE package_id = ? AND base_composition_id = ? AND dirty = 0 AND lock_version = ?
      AND EXISTS (
        SELECT 1 FROM article_project_packages
        WHERE id = ? AND main_composition_id = ? AND main_composition_sha256 = ? AND lock_version = ?
      )
      AND (? IS NULL OR EXISTS (SELECT 1 FROM package_composition_materializations
        WHERE package_id = ? AND branch_id = ? AND composition_id = ? AND article_revision_id = ?))`).bind(
      plan.compositionId, materializedRevisionId, canonicalJson(plan.document), plan.documentSha256, plan.createdAt,
      ownerPackageId, expectedMainCompositionId, expectedWorkingLockVersion,
      ownerPackageId, plan.compositionId, plan.compositionSha256, nextPackageLock,
      materializedRevisionId, ownerPackageId, bridgeState?.row.branch_id ?? null,
      plan.compositionId, materializedRevisionId,
    );
  const markApplied = db.prepare(`UPDATE package_patch_proposals
    SET status = 'applied', lock_version = lock_version + 1, applied_composition_id = ?, applied_at = ?
    WHERE id = ? AND package_id = ? AND status = 'approved' AND lock_version = ?
      AND base_composition_id = ? AND base_composition_sha256 = ?
      AND EXISTS (
        SELECT 1 FROM article_project_packages
        WHERE id = ? AND main_composition_id = ? AND main_composition_sha256 = ? AND lock_version = ?
      )`).bind(
      plan.compositionId, plan.createdAt, patchProposalId, ownerPackageId, expectedPatchLockVersion,
      expectedMainCompositionId, expectedMainCompositionSha256,
      ownerPackageId, plan.compositionId, plan.compositionSha256, nextPackageLock,
    );
  const markImport = db.prepare(`UPDATE package_import_runs
    SET state = 'applied', lock_version = lock_version + 1, finished_at = ?
    WHERE patch_proposal_id = ? AND state = 'candidate_ready'
      AND EXISTS (
        SELECT 1 FROM package_patch_proposals
        WHERE id = ? AND status = 'applied' AND applied_composition_id = ?
      )`).bind(plan.createdAt, patchProposalId, patchProposalId, plan.compositionId);
  const event = guardedEventStatement(db, {
    packageId: ownerPackageId, articleId: String(state.root.article_id), compositionId: plan.compositionId,
    compositionSha256: plan.compositionSha256, lockVersion: nextPackageLock,
    eventType: "package.patch_applied", subjectType: "package_patch_proposal", subjectId: patchProposalId,
    payload: {
      baseCompositionId: expectedMainCompositionId, appliedCompositionId: plan.compositionId,
      primaryBranchId: bridgeState?.row.branch_id ?? null, materializedRevisionId,
      candidateCreatedByKind: proposal.created_by_kind,
    },
    inputSha256, createdAt: plan.createdAt,
  });
  const sentinel = bridgeState && materializedRevisionId
    ? db.prepare(`SELECT CASE WHEN EXISTS (
        SELECT 1 FROM article_project_packages package
        JOIN package_working_copies package_copy ON package_copy.package_id = package.id
        JOIN article_branches branch ON branch.id = package.primary_branch_id
        JOIN article_revisions revision ON revision.id = branch.head_revision_id AND revision.branch_id = branch.id
        JOIN branch_working_copies branch_copy ON branch_copy.branch_id = branch.id
        JOIN package_composition_materializations bridge
          ON bridge.package_id = package.id AND bridge.branch_id = branch.id
          AND bridge.composition_id = package.main_composition_id AND bridge.composition_sha256 = package.main_composition_sha256
          AND bridge.article_revision_id = revision.id AND bridge.article_body_sha256 = revision.body_sha256
        JOIN package_patch_proposals patch ON patch.id = ? AND patch.package_id = package.id
          AND patch.status = 'applied' AND patch.applied_composition_id = package.main_composition_id
        WHERE package.id = ? AND package.main_composition_id = ? AND package.main_composition_sha256 = ? AND package.lock_version = ?
          AND package_copy.branch_id = branch.id AND package_copy.base_composition_id = package.main_composition_id
          AND package_copy.base_revision_id = revision.id AND package_copy.dirty = 0
          AND branch_copy.base_revision_id = revision.id AND branch_copy.dirty = 0
      ) THEN 1 ELSE json('wenmai-package-patch-apply-incomplete') END AS committed`)
      .bind(patchProposalId, ownerPackageId, plan.compositionId, plan.compositionSha256, nextPackageLock)
    : db.prepare(`SELECT CASE WHEN EXISTS (
        SELECT 1 FROM article_project_packages package
        JOIN package_working_copies copy ON copy.package_id = package.id
        JOIN package_patch_proposals patch ON patch.id = ? AND patch.package_id = package.id
        WHERE package.id = ? AND package.primary_branch_id IS NULL
          AND package.main_composition_id = ? AND package.main_composition_sha256 = ? AND package.lock_version = ?
          AND copy.base_composition_id = package.main_composition_id AND copy.dirty = 0
          AND patch.status = 'applied' AND patch.applied_composition_id = package.main_composition_id
      ) THEN 1 ELSE json('wenmai-package-legacy-patch-incomplete') END AS committed`)
      .bind(patchProposalId, ownerPackageId, plan.compositionId, plan.compositionSha256, nextPackageLock);
  const results = await db.batch([
    rootCas, ...immutableStatements.map((item) => item.statement), ...bridgeStatements,
    resetWorking, markApplied, markImport, event, sentinel,
  ]);
  if (resultChanges(results[0]) !== 1) throw new ProjectPackageApiError("PATCH_APPLY_CAS_CONFLICT", "应用 Patch 时基线发生并发变化", 409);
  immutableStatements.forEach((expected, index) => {
    if (resultChanges(results[index + 1]) !== expected.expectedChanges) {
      throw new ProjectPackageApiError("PATCH_APPLY_INCOMPLETE", `${expected.label} 未完整写入`, 500);
    }
  });
  const tailOffset = 1 + immutableStatements.length + bridgeStatements.length;
  if (bridgeStatements.some((_, index) => resultChanges(results[1 + immutableStatements.length + index]) !== 1)
    || resultChanges(results[tailOffset]) !== 1
    || resultChanges(results[tailOffset + 1]) !== 1
    || resultChanges(results[tailOffset + 3]) !== 1) {
    throw new ProjectPackageApiError("PATCH_APPLY_INCOMPLETE", "Patch 状态、工作副本或事件未完整推进", 500);
  }
  const next = await currentPackageState(db, ownerPackageId);
  const nextBridge = await packageBranchBridgeState(db, next.root, next.working);
  const nextProposal = await patchRow(db, patchProposalId, ownerPackageId);
  return {
    status: 201,
    data: {
      package: parsePackageRow(next.root), composition: parseCompositionRow(next.composition, true),
      workingCopy: parseWorkingRow(next.working), patchProposal: parsePatchRow(nextProposal, true),
      createdModuleRevisions: plan.createdModuleRevisionIds,
      branchBridge: parsePackageBranchBridge(next.root, next.working, nextBridge),
      articleRevision: nextBridge ? {
        id: nextBridge.row.head_revision_id, bodySha256: nextBridge.row.head_body_sha256,
        branchId: nextBridge.row.branch_id,
      } : null,
      boundary: {
        candidateOnly: false, packageMainAdvanced: true, compositionCreated: true,
        articleBranchAdvanced: Boolean(nextBridge), revisionCreated: Boolean(nextBridge),
      },
    },
  };
}

async function applyPatchProposal(
  db: D1Database,
  payload: JsonObject,
  inputSha256: string,
  principal: ControlPrincipal,
) {
  const ownerPackageId = requiredText(payload.packageId, "packageId", 160);
  const patchProposalId = requiredText(payload.patchProposalId, "patchProposalId", 160);
  const expectedPatchLockVersion = exactInteger(payload.expectedPatchLockVersion, "expectedPatchLockVersion", 1, 2_147_483_647);
  const root = await packageRow(db, ownerPackageId);
  const selected = await loadSelectedPackageBranch(db, root, optionalText(payload.branchId, 160) || undefined, true);
  let expectedBranchLockVersion: number;
  if (payload.expectedBranchLockVersion === undefined) {
    const legacyPackageLockVersion = exactInteger(payload.expectedPackageLockVersion, "expectedPackageLockVersion", 1, 2_147_483_647);
    if (selected.branchId !== root.primary_branch_id || legacyPackageLockVersion !== Number(root.lock_version)) {
      throw new ProjectPackageApiError("BRANCH_BASELINE_REQUIRED", "应用 Patch 必须显式提供目标分支 expectedBranchLockVersion", 409);
    }
    expectedBranchLockVersion = selected.branchState.lockVersion;
  } else {
    expectedBranchLockVersion = exactInteger(payload.expectedBranchLockVersion, "expectedBranchLockVersion", 1, 2_147_483_647);
  }
  const expectedHeadCompositionId = requiredText(
    payload.expectedHeadCompositionId ?? payload.expectedMainCompositionId,
    "expectedHeadCompositionId",
    160,
  );
  const expectedHeadCompositionSha256 = exactSha256(
    payload.expectedHeadCompositionSha256 ?? payload.expectedMainCompositionSha256,
    "expectedHeadCompositionSha256",
  );
  const expectedHeadRevisionId = optionalText(payload.expectedHeadRevisionId, 160) || selected.branchState.headRevisionId;
  if (selected.branchState.lockVersion !== expectedBranchLockVersion
    || selected.branchState.headCompositionId !== expectedHeadCompositionId
    || selected.branchState.headCompositionSha256 !== expectedHeadCompositionSha256
    || selected.branchState.headRevisionId !== expectedHeadRevisionId) {
    throw new ProjectPackageApiError("PACKAGE_BRANCH_CAS_CONFLICT", "应用 Patch 时目标分支基线已变化", 409, {
      currentBranchLockVersion: selected.branchState.lockVersion,
      currentCompositionId: selected.branchState.headCompositionId,
      currentCompositionSha256: selected.branchState.headCompositionSha256,
      currentRevisionId: selected.branchState.headRevisionId,
    });
  }
  if (selected.workingCopy.dirty
    || selected.workingCopy.baseCompositionId !== expectedHeadCompositionId
    || selected.workingCopy.baseRevisionId !== expectedHeadRevisionId
    || selected.workingCopy.documentSha256 !== String(selected.composition.document_sha256)) {
    throw new ProjectPackageApiError("DIRTY_WORKING_COPY", "应用 Patch 前目标分支的 Package 工作副本必须处于 clean head", 409, {
      branchId: selected.branchId,
      workingCopy: selected.workingCopy,
    });
  }
  const proposal = await patchRow(db, patchProposalId, ownerPackageId);
  if (proposal.status !== "approved" || Number(proposal.lock_version) !== expectedPatchLockVersion) {
    throw new ProjectPackageApiError("PATCH_APPLY_CONFLICT", "Patch 未获批准或 lockVersion 已变化", 409, {
      currentStatus: proposal.status,
      currentLockVersion: Number(proposal.lock_version),
    });
  }
  if (proposal.branch_id !== selected.branchId
    || proposal.base_composition_id !== expectedHeadCompositionId
    || proposal.base_composition_sha256 !== expectedHeadCompositionSha256
    || proposal.base_revision_id !== expectedHeadRevisionId
    || Number(proposal.base_branch_lock_version) !== expectedBranchLockVersion) {
    throw new ProjectPackageApiError("PATCH_BRANCH_BASE_STALE", "Patch 的 ArticleBranch、Composition、Revision 或 branch lock 基线已过期", 409, {
      patchBranchId: proposal.branch_id,
      patchBaseCompositionId: proposal.base_composition_id,
      patchBaseRevisionId: proposal.base_revision_id,
      patchBaseBranchLockVersion: proposal.base_branch_lock_version,
    });
  }
  if (proposal.created_by_kind === "agent"
    && (!proposal.context_sha256 || !proposal.task_id || !proposal.attempt_id)) {
    throw new ProjectPackageApiError("AGENT_PATCH_CONTEXT_BINDING_MISSING", "Agent Package Patch 缺少冻结 context/task/attempt 证据", 409);
  }
  if (principal.kind === "agent") {
    if (proposal.created_by_kind === "agent") {
      if (!proposal.created_by_id) {
        throw new ProjectPackageApiError("AGENT_PATCH_CREATOR_BINDING_MISSING", "Agent Patch 缺少持久的创建者绑定", 409);
      }
      if (await sameAgentAuthorityLineage(db, String(proposal.created_by_id), principal.clientId)) {
        throw new ProjectPackageApiError("AGENT_PATCH_SELF_APPLY_FORBIDDEN", "Agent 不能应用同一 authority lineage 创建的 PatchProposal", 403);
      }
    }
    // Older decisions have no durable decision actor.  An owner can take over
    // those rows, but an Agent must fail closed rather than infer identity from
    // a receipt or free-form decision note.
    if (!proposal.decided_by_kind || !proposal.decided_by_id) {
      throw new ProjectPackageApiError("AGENT_PATCH_DECISION_BINDING_MISSING", "Agent 应用 Patch 前必须具有持久的决定者绑定", 409);
    }
    if (proposal.decided_by_kind === "agent"
      && await sameAgentAuthorityLineage(db, String(proposal.decided_by_id), principal.clientId)) {
      throw new ProjectPackageApiError("AGENT_PATCH_SELF_APPLY_FORBIDDEN", "Agent 不能应用由同一 authority lineage 决定的 PatchProposal", 403);
    }
  }
  const baseDocument = parseJson<PackageDocument>(selected.composition.document_json, {} as PackageDocument);
  const applied = await applyPatchOperations(
    db,
    ownerPackageId,
    baseDocument,
    parseJson<PackagePatchOperation[]>(proposal.operations_json, []),
  );
  const appliedDocumentSha256 = await documentSha(applied.document);
  if (appliedDocumentSha256 === String(selected.composition.document_sha256)) {
    throw new ProjectPackageApiError("PATCH_HAS_NO_CHANGES", "Patch 对当前分支基线不再产生变化", 409);
  }
  const proposalAuthorKind = proposal.created_by_kind === "agent"
    ? "agent"
    : proposal.created_by_kind === "import" ? "import" : "user";
  const rendered = renderPackageDocument(applied.document);
  const renderedBodySha256 = await sha256Text(rendered.bodyText);
  const revisionId = `revision-${crypto.randomUUID()}`;
  const materializationId = `package-materialization-${crypto.randomUUID()}`;
  const branchCommitId = `branch-commit-${crypto.randomUUID()}`;
  const plan = await buildMaterializationPlan(db, {
    packageId: ownerPackageId,
    document: applied.document,
    parentCompositionId: expectedHeadCompositionId,
    title: String(proposal.title),
    authorKind: proposalAuthorKind,
    sourcePatchId: patchProposalId,
    sourceArticleRevisionId: revisionId,
  });
  const sequenceRow = await db.prepare("SELECT COALESCE(MAX(sequence), 0) AS maximum FROM article_revisions WHERE branch_id = ?")
    .bind(selected.branchId).first<D1Row>();
  const nextSequence = Number(sequenceRow?.maximum ?? 0) + 1;
  const nextBranchLockVersion = expectedBranchLockVersion + 1;
  const expectedWorkingLockVersion = selected.workingCopy.lockVersion;
  const branchStateCas = db.prepare(`UPDATE package_branch_states
    SET head_composition_id = ?, head_composition_sha256 = ?, head_revision_id = ?,
      lock_version = lock_version + 1, updated_at = ?
    WHERE package_id = ? AND branch_id = ? AND status = 'active' AND lock_version = ?
      AND head_composition_id = ? AND head_composition_sha256 = ? AND head_revision_id = ?
      AND EXISTS (SELECT 1 FROM package_patch_proposals patch
        WHERE patch.id = ? AND patch.package_id = package_branch_states.package_id
          AND patch.branch_id = package_branch_states.branch_id
          AND patch.status = 'approved' AND patch.lock_version = ?
          AND patch.base_composition_id = ? AND patch.base_composition_sha256 = ?
          AND patch.base_revision_id = ? AND patch.base_branch_lock_version = ?)
      AND EXISTS (SELECT 1 FROM package_branch_working_copies copy
        WHERE copy.package_id = package_branch_states.package_id AND copy.branch_id = package_branch_states.branch_id
          AND copy.base_composition_id = ? AND copy.base_revision_id = ?
          AND copy.document_sha256 = ? AND copy.dirty = 0 AND copy.lock_version = ?)
      AND EXISTS (SELECT 1 FROM article_branches branch
        JOIN branch_working_copies copy ON copy.branch_id = branch.id
        WHERE branch.id = package_branch_states.branch_id AND branch.article_id = ? AND branch.status = 'active'
          AND branch.head_revision_id = ? AND copy.base_revision_id = ? AND copy.dirty = 0 AND copy.lock_version = ?)
      AND EXISTS (SELECT 1 FROM package_composition_materializations materialization
        WHERE materialization.package_id = package_branch_states.package_id
          AND materialization.branch_id = package_branch_states.branch_id
          AND materialization.composition_id = ? AND materialization.composition_sha256 = ?
          AND materialization.article_revision_id = ?)
      AND EXISTS (SELECT 1 FROM package_branch_composition_commits commit_ref
        WHERE commit_ref.package_id = package_branch_states.package_id
          AND commit_ref.branch_id = package_branch_states.branch_id
          AND commit_ref.composition_id = ? AND commit_ref.article_revision_id = ?)`)
    .bind(
      plan.compositionId, plan.compositionSha256, revisionId, plan.createdAt,
      ownerPackageId, selected.branchId, expectedBranchLockVersion,
      expectedHeadCompositionId, expectedHeadCompositionSha256, expectedHeadRevisionId,
      patchProposalId, expectedPatchLockVersion, expectedHeadCompositionId,
      expectedHeadCompositionSha256, expectedHeadRevisionId, expectedBranchLockVersion,
      expectedHeadCompositionId, expectedHeadRevisionId, String(selected.composition.document_sha256), expectedWorkingLockVersion,
      root.article_id, expectedHeadRevisionId, expectedHeadRevisionId, selected.row.article_working_lock_version,
      expectedHeadCompositionId, expectedHeadCompositionSha256, expectedHeadRevisionId,
      expectedHeadCompositionId, expectedHeadRevisionId,
    );
  const immutableStatements = materializationStatements(db, plan, nextBranchLockVersion, {
    branchId: selected.branchId,
    headRevisionId: revisionId,
  });
  const articleBranchCas = db.prepare(`UPDATE article_branches SET head_revision_id = ?, updated_at = ?
    WHERE id = ? AND article_id = ? AND status = 'active' AND head_revision_id = ?
      AND EXISTS (SELECT 1 FROM package_branch_states state
        WHERE state.package_id = ? AND state.branch_id = article_branches.id
          AND state.head_composition_id = ? AND state.head_composition_sha256 = ?
          AND state.head_revision_id = ? AND state.lock_version = ?)`)
    .bind(revisionId, plan.createdAt, selected.branchId, root.article_id, expectedHeadRevisionId,
      ownerPackageId, plan.compositionId, plan.compositionSha256, revisionId, nextBranchLockVersion);
  const revisionInsert = db.prepare(`INSERT INTO article_revisions
    (id, article_id, branch_id, sequence, parent_revision_id, merge_parent_revision_id, source_version_id,
     title, document_title, annotation, body_text, body_sha256, author_kind, created_at)
    SELECT ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?
    WHERE EXISTS (SELECT 1 FROM article_branches WHERE id = ? AND head_revision_id = ?)
      AND EXISTS (SELECT 1 FROM package_branch_states WHERE package_id = ? AND branch_id = ?
        AND head_composition_id = ? AND head_revision_id = ? AND lock_version = ?)`)
    .bind(
      revisionId, root.article_id, selected.branchId, nextSequence, expectedHeadRevisionId,
      `文章工程 Patch · ${proposal.title}`, rendered.documentTitle,
      `人工应用候选 ${patchProposalId}；由 ${PACKAGE_RENDERER_KEY}@${PACKAGE_RENDERER_VERSION} 确定性渲染。`,
      rendered.bodyText, renderedBodySha256, bridgeRevisionAuthor(proposalAuthorKind), plan.createdAt,
      selected.branchId, revisionId, ownerPackageId, selected.branchId,
      plan.compositionId, revisionId, nextBranchLockVersion,
    );
  const articleWorkingUpdate = db.prepare(`UPDATE branch_working_copies
    SET base_revision_id = ?, title = ?, annotation = '', body_text = ?, body_sha256 = ?, dirty = 0,
      lock_version = lock_version + 1, updated_at = ?
    WHERE branch_id = ? AND article_id = ? AND base_revision_id = ? AND dirty = 0 AND lock_version = ?
      AND EXISTS (SELECT 1 FROM article_branches WHERE id = ? AND head_revision_id = ?)
      AND EXISTS (SELECT 1 FROM article_revisions WHERE id = ? AND branch_id = ? AND body_sha256 = ?)`)
    .bind(
      revisionId, rendered.documentTitle, rendered.bodyText, renderedBodySha256, plan.createdAt,
      selected.branchId, root.article_id, expectedHeadRevisionId, selected.row.article_working_lock_version,
      selected.branchId, revisionId, revisionId, selected.branchId, renderedBodySha256,
    );
  const materializationInsert = db.prepare(`INSERT INTO package_composition_materializations
    (id, package_id, branch_id, composition_id, composition_sha256, article_revision_id, article_body_sha256,
     renderer_key, renderer_version, created_by_kind, created_at)
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    WHERE EXISTS (SELECT 1 FROM package_branch_states WHERE package_id = ? AND branch_id = ?
      AND head_composition_id = ? AND head_composition_sha256 = ? AND head_revision_id = ? AND lock_version = ?)
      AND EXISTS (SELECT 1 FROM article_revisions WHERE id = ? AND branch_id = ? AND body_sha256 = ?)`)
    .bind(
      materializationId, ownerPackageId, selected.branchId, plan.compositionId, plan.compositionSha256,
      revisionId, renderedBodySha256, PACKAGE_RENDERER_KEY, PACKAGE_RENDERER_VERSION, proposalAuthorKind, plan.createdAt,
      ownerPackageId, selected.branchId, plan.compositionId, plan.compositionSha256, revisionId, nextBranchLockVersion,
      revisionId, selected.branchId, renderedBodySha256,
    );
  const sourceKind = proposal.created_by_kind === "import" ? "import" : "patch";
  const branchCommitInsert = db.prepare(`INSERT INTO package_branch_composition_commits
    (id, package_id, branch_id, parent_composition_id, composition_id, composition_sha256,
     previous_revision_id, article_revision_id, source_kind, source_patch_id, created_by_kind, created_at)
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    WHERE EXISTS (SELECT 1 FROM package_composition_materializations WHERE id = ? AND article_revision_id = ?)
      AND EXISTS (SELECT 1 FROM package_branch_composition_commits WHERE package_id = ? AND branch_id = ?
        AND composition_id = ? AND article_revision_id = ?)`)
    .bind(
      branchCommitId, ownerPackageId, selected.branchId, expectedHeadCompositionId,
      plan.compositionId, plan.compositionSha256, expectedHeadRevisionId, revisionId,
      sourceKind, patchProposalId, proposalAuthorKind, plan.createdAt,
      materializationId, revisionId, ownerPackageId, selected.branchId,
      expectedHeadCompositionId, expectedHeadRevisionId,
    );
  const branchWorkingReset = db.prepare(`UPDATE package_branch_working_copies
    SET base_composition_id = ?, base_revision_id = ?, document_json = ?, document_sha256 = ?, dirty = 0,
      lock_version = lock_version + 1, updated_at = ?
    WHERE package_id = ? AND branch_id = ? AND base_composition_id = ? AND base_revision_id = ?
      AND document_sha256 = ? AND dirty = 0 AND lock_version = ?
      AND EXISTS (SELECT 1 FROM package_branch_composition_commits WHERE id = ? AND package_id = ? AND branch_id = ?
        AND composition_id = ? AND article_revision_id = ?)`)
    .bind(
      plan.compositionId, revisionId, canonicalJson(plan.document), plan.documentSha256, plan.createdAt,
      ownerPackageId, selected.branchId, expectedHeadCompositionId, expectedHeadRevisionId,
      String(selected.composition.document_sha256), expectedWorkingLockVersion,
      branchCommitId, ownerPackageId, selected.branchId, plan.compositionId, revisionId,
    );
  const markApplied = db.prepare(`UPDATE package_patch_proposals
    SET status = 'applied', lock_version = lock_version + 1, applied_composition_id = ?, applied_at = ?
    WHERE id = ? AND package_id = ? AND branch_id = ? AND status = 'approved' AND lock_version = ?
      AND base_composition_id = ? AND base_composition_sha256 = ?
      AND base_revision_id = ? AND base_branch_lock_version = ?
      AND EXISTS (SELECT 1 FROM package_branch_composition_commits WHERE id = ? AND package_id = ?
        AND branch_id = ? AND composition_id = ? AND article_revision_id = ?)`)
    .bind(
      plan.compositionId, plan.createdAt, patchProposalId, ownerPackageId, selected.branchId,
      expectedPatchLockVersion, expectedHeadCompositionId, expectedHeadCompositionSha256,
      expectedHeadRevisionId, expectedBranchLockVersion,
      branchCommitId, ownerPackageId, selected.branchId, plan.compositionId, revisionId,
    );
  const markImport = db.prepare(`UPDATE package_import_runs
    SET state = 'applied', lock_version = lock_version + 1, finished_at = ?
    WHERE patch_proposal_id = ? AND package_id = ? AND branch_id = ? AND state = 'candidate_ready'
      AND EXISTS (SELECT 1 FROM package_patch_proposals WHERE id = ? AND status = 'applied'
        AND applied_composition_id = ?)`)
    .bind(plan.createdAt, patchProposalId, ownerPackageId, selected.branchId, patchProposalId, plan.compositionId);
  const isPrimary = root.primary_branch_id === selected.branchId;
  const rootMirror = isPrimary ? db.prepare(`UPDATE article_project_packages
    SET title = ?, main_composition_id = ?, main_composition_sha256 = ?, lock_version = lock_version + 1, updated_at = ?
    WHERE id = ? AND primary_branch_id = ? AND main_composition_id = ? AND main_composition_sha256 = ?
      AND status = 'active' AND branch_model_version = 2
      AND EXISTS (SELECT 1 FROM package_branch_states WHERE package_id = ? AND branch_id = ?
        AND head_composition_id = ? AND head_revision_id = ? AND lock_version = ?)`)
    .bind(
      applied.document.title, plan.compositionId, plan.compositionSha256, plan.createdAt,
      ownerPackageId, selected.branchId, expectedHeadCompositionId, expectedHeadCompositionSha256,
      ownerPackageId, selected.branchId, plan.compositionId, revisionId, nextBranchLockVersion,
    ) : null;
  const legacyMirror = isPrimary ? db.prepare(`UPDATE package_working_copies
    SET branch_id = ?, base_composition_id = ?, base_revision_id = ?, document_json = ?, document_sha256 = ?,
      dirty = 0, lock_version = lock_version + 1, updated_at = ?
    WHERE package_id = ? AND branch_id = ? AND base_composition_id = ? AND base_revision_id = ?
      AND document_sha256 = ? AND dirty = 0 AND lock_version = ?
      AND EXISTS (SELECT 1 FROM package_branch_working_copies WHERE package_id = ? AND branch_id = ?
        AND base_composition_id = ? AND base_revision_id = ? AND dirty = 0 AND lock_version = ?)`)
    .bind(
      selected.branchId, plan.compositionId, revisionId, canonicalJson(plan.document), plan.documentSha256, plan.createdAt,
      ownerPackageId, selected.branchId, expectedHeadCompositionId, expectedHeadRevisionId,
      String(selected.composition.document_sha256), expectedWorkingLockVersion,
      ownerPackageId, selected.branchId, plan.compositionId, revisionId, expectedWorkingLockVersion + 1,
    ) : null;
  const event = db.prepare(`INSERT INTO workspace_events
    (id, event_type, subject_type, subject_id, article_id, payload_json, input_sha256, created_at)
    SELECT ?, 'package.branch_patch_applied', 'package_patch_proposal', ?, ?, ?, ?, ?
    WHERE EXISTS (SELECT 1 FROM package_patch_proposals WHERE id = ? AND package_id = ? AND branch_id = ?
      AND status = 'applied' AND applied_composition_id = ?)`)
    .bind(
      `workspace-event-${crypto.randomUUID()}`, patchProposalId, root.article_id,
      canonicalJson({ packageId: ownerPackageId, branchId: selected.branchId,
        oldCompositionId: expectedHeadCompositionId, newCompositionId: plan.compositionId,
        oldRevisionId: expectedHeadRevisionId, newRevisionId: revisionId,
        previousBranchLockVersion: expectedBranchLockVersion, branchLockVersion: nextBranchLockVersion,
        compatibilityMirrorUpdated: isPrimary, candidateCreatedByKind: proposal.created_by_kind }),
      inputSha256, plan.createdAt, patchProposalId, ownerPackageId, selected.branchId, plan.compositionId,
    );
  const sentinel = db.prepare(`SELECT CASE WHEN EXISTS (
      SELECT 1 FROM package_branch_states state
      JOIN package_branch_working_copies package_copy
        ON package_copy.package_id = state.package_id AND package_copy.branch_id = state.branch_id
      JOIN article_branches branch ON branch.id = state.branch_id
      JOIN branch_working_copies article_copy ON article_copy.branch_id = state.branch_id
      JOIN package_composition_materializations materialization
        ON materialization.package_id = state.package_id AND materialization.branch_id = state.branch_id
        AND materialization.composition_id = state.head_composition_id
        AND materialization.article_revision_id = state.head_revision_id
      JOIN package_branch_composition_commits commit_ref
        ON commit_ref.package_id = state.package_id AND commit_ref.branch_id = state.branch_id
        AND commit_ref.composition_id = state.head_composition_id
        AND commit_ref.article_revision_id = state.head_revision_id
      JOIN package_patch_proposals patch ON patch.id = ? AND patch.package_id = state.package_id
        AND patch.branch_id = state.branch_id AND patch.status = 'applied'
        AND patch.applied_composition_id = state.head_composition_id
      WHERE state.package_id = ? AND state.branch_id = ? AND state.head_composition_id = ?
        AND state.head_composition_sha256 = ? AND state.head_revision_id = ? AND state.lock_version = ?
        AND package_copy.base_composition_id = state.head_composition_id
        AND package_copy.base_revision_id = state.head_revision_id AND package_copy.dirty = 0
        AND branch.head_revision_id = state.head_revision_id
        AND article_copy.base_revision_id = state.head_revision_id AND article_copy.dirty = 0
        AND (NOT EXISTS (SELECT 1 FROM package_import_runs WHERE patch_proposal_id = patch.id)
          OR EXISTS (SELECT 1 FROM package_import_runs WHERE patch_proposal_id = patch.id
            AND package_id = state.package_id AND branch_id = state.branch_id AND state = 'applied'))
        AND ((SELECT primary_branch_id FROM article_project_packages WHERE id = state.package_id) <> state.branch_id
          OR EXISTS (SELECT 1 FROM article_project_packages root
            JOIN package_working_copies legacy ON legacy.package_id = root.id
            WHERE root.id = state.package_id AND root.primary_branch_id = state.branch_id
              AND root.main_composition_id = state.head_composition_id
              AND root.main_composition_sha256 = state.head_composition_sha256
              AND legacy.branch_id = state.branch_id
              AND legacy.base_composition_id = state.head_composition_id
              AND legacy.base_revision_id = state.head_revision_id AND legacy.dirty = 0))
    ) THEN 1 ELSE json('wenmai-0010-patch-apply-incomplete') END AS committed`)
    .bind(
      patchProposalId, ownerPackageId, selected.branchId, plan.compositionId,
      plan.compositionSha256, revisionId, nextBranchLockVersion,
    );
  const statements = [
    branchStateCas,
    ...immutableStatements.map((item) => item.statement),
    articleBranchCas,
    revisionInsert,
    articleWorkingUpdate,
    materializationInsert,
    branchCommitInsert,
    branchWorkingReset,
    markApplied,
    markImport,
    ...(rootMirror ? [rootMirror] : []),
    ...(legacyMirror ? [legacyMirror] : []),
    event,
    sentinel,
  ];
  let results: D1Mutation[];
  try {
    results = await db.batch(statements);
  } catch (error) {
    const [currentBranch, currentPatch] = await Promise.all([
      db.prepare("SELECT lock_version, head_composition_id, head_revision_id FROM package_branch_states WHERE package_id = ? AND branch_id = ?")
        .bind(ownerPackageId, selected.branchId).first<D1Row>(),
      db.prepare("SELECT status, lock_version FROM package_patch_proposals WHERE id = ? AND package_id = ?")
        .bind(patchProposalId, ownerPackageId).first<D1Row>(),
    ]);
    if (!currentBranch || Number(currentBranch.lock_version) !== expectedBranchLockVersion
      || currentBranch.head_composition_id !== expectedHeadCompositionId
      || currentBranch.head_revision_id !== expectedHeadRevisionId) {
      throw new ProjectPackageApiError("PACKAGE_BRANCH_CAS_CONFLICT", "应用 Patch 时目标分支基线已变化", 409, { currentBranch });
    }
    if (!currentPatch || currentPatch.status !== "approved" || Number(currentPatch.lock_version) !== expectedPatchLockVersion) {
      throw new ProjectPackageApiError("PATCH_APPLY_CONFLICT", "Patch 状态或 lockVersion 已变化", 409, { currentPatch });
    }
    throw error;
  }
  if (resultChanges(results[0]) !== 1) {
    throw new ProjectPackageApiError("PACKAGE_BRANCH_CAS_CONFLICT", "应用 Patch 时目标分支基线已变化", 409);
  }
  immutableStatements.forEach((expected, index) => {
    if (resultChanges(results[index + 1]) !== expected.expectedChanges) {
      throw new ProjectPackageApiError("PATCH_APPLY_INCOMPLETE", `${expected.label} 未完整写入`, 500);
    }
  });
  const nextRoot = await packageRow(db, ownerPackageId);
  const next = await loadSelectedPackageBranch(db, nextRoot, selected.branchId);
  const nextProposal = await patchRow(db, patchProposalId, ownerPackageId);
  return {
    status: 201,
    data: {
      package: parsePackageRow(nextRoot),
      selectedBranchId: next.branchId,
      branchState: next.branchState,
      composition: parseCompositionRow(next.composition, true),
      branchWorkingCopy: next.workingCopy,
      workingCopy: next.workingCopy,
      branchCommit: next.branchCommit,
      branchBridge: next.branchBridge,
      patchProposal: parsePatchRow(nextProposal, true),
      articleRevision: { id: revisionId, bodySha256: renderedBodySha256, branchId: selected.branchId },
      createdModuleRevisions: plan.createdModuleRevisionIds,
      compatibilityMirrorUpdated: nextRoot.primary_branch_id === selected.branchId,
      boundary: {
        candidateOnly: false,
        compositionCreated: true,
        branchAdvanced: true,
        articleBranchAdvanced: true,
        revisionCreated: true,
        packageMainAdvanced: nextRoot.primary_branch_id === selected.branchId,
      },
    },
  };
}

void _applyPatchProposal0009;

async function _createImportCandidate0009(db: D1Database, payload: JsonObject, inputSha256: string) {
  const ownerPackageId = requiredText(payload.packageId, "packageId", 160);
  const expectedPackageLockVersion = exactInteger(payload.expectedPackageLockVersion, "expectedPackageLockVersion", 1, 2_147_483_647);
  const baseCompositionId = requiredText(payload.baseCompositionId, "baseCompositionId", 160);
  const expectedBaseCompositionSha256 = exactSha256(payload.expectedBaseCompositionSha256, "expectedBaseCompositionSha256");
  const sourceKind = requiredText(payload.sourceKind, "sourceKind", 80);
  const sourceRef = safeReference(payload.sourceRef, "sourceRef", 2_000);
  const sourceFingerprintSha256 = exactSha256(payload.sourceFingerprintSha256, "sourceFingerprintSha256");
  const importerKey = requiredText(payload.importerKey, "importerKey", 120);
  const importerVersion = requiredText(payload.importerVersion, "importerVersion", 80);
  const summary = optionalText(payload.summary, 2_000, true);
  const evidence = stringArray(payload.evidence, "evidence", 100, 1_000);
  const state = await currentPackageState(db, ownerPackageId);
  assertPackageCas(state.root, expectedPackageLockVersion, baseCompositionId, expectedBaseCompositionSha256);
  const bridgeState = await packageBranchBridgeState(db, state.root, state.working);
  const baseDocument = parseJson<PackageDocument>(state.composition.document_json, {} as PackageDocument);
  const candidateDocument = await prepareDocument(db, ownerPackageId, payload.document, baseDocument);
  const candidateDocumentSha256 = await documentSha(candidateDocument);
  if (candidateDocumentSha256 === state.composition.document_sha256) {
    throw new ProjectPackageApiError("IMPORT_HAS_NO_CHANGES", "导入候选与当前 Composition 完全相同");
  }
  const operations: PackagePatchOperation[] = [{ op: "replace_document", document: candidateDocument }];
  const patchSha256 = await sha256Text(canonicalJson({
    packageId: ownerPackageId, baseCompositionId, baseCompositionSha256: expectedBaseCompositionSha256,
    branchId: bridgeState?.row.branch_id ?? null, baseRevisionId: bridgeState?.row.head_revision_id ?? null,
    basePackageLockVersion: bridgeState ? expectedPackageLockVersion : null,
    sourceKind, sourceRef, sourceFingerprintSha256, importerKey, importerVersion, operations,
  }));
  const manifest = canonicalValue({
    schemaVersion: "wenmai-import-candidate-manifest-v1", packageId: ownerPackageId,
    baseCompositionId, baseCompositionSha256: expectedBaseCompositionSha256,
    sourceKind, sourceRef, sourceFingerprintSha256, importerKey, importerVersion,
    candidateDocumentSha256, moduleCount: candidateDocument.modules.length, edgeCount: candidateDocument.edges.length,
    assets: candidateDocument.assets.map((asset) => ({ key: asset.key, sha256: asset.sha256 })),
    sources: await Promise.all(candidateDocument.sources.map(async (source) => ({
      key: source.key, refSha256: await sha256Text(canonicalJson({
        sourceKind: source.sourceKind, canonicalRef: source.canonicalRef, title: source.title,
        capturedAt: source.capturedAt ?? null, contentSha256: source.contentSha256 ?? null,
        excerpt: source.excerpt ?? "", metadata: source.metadata ?? {}, rights: source.rights ?? {},
      })),
    }))),
  }) as JsonObject;
  const manifestSha256 = await sha256Text(canonicalJson(manifest));
  const existing = await db.prepare("SELECT * FROM package_import_runs WHERE package_id = ? AND manifest_sha256 = ? LIMIT 1")
    .bind(ownerPackageId, manifestSha256).first<D1Row>();
  if (existing) {
    const existingPatch = await patchRow(db, String(existing.patch_proposal_id), ownerPackageId);
    return {
      data: {
        importRun: parseImportRow(existing, true), patchProposal: parsePatchRow(existingPatch, true), reused: true,
        boundary: { candidateOnly: true, packageMainAdvanced: false, compositionCreated: false, sourceWritten: false },
      },
    };
  }
  const patchProposalId = `patch-${crypto.randomUUID()}`;
  const importRunId = `import-${crypto.randomUUID()}`;
  const title = optionalText(payload.title, 300) || `导入候选：${sourceKind}`;
  const now = isoNow();
  const patchInsert = db.prepare(`INSERT INTO package_patch_proposals
    (id, package_id, base_composition_id, base_composition_sha256, branch_id, base_revision_id, base_package_lock_version,
     task_id, attempt_id, context_sha256,
     title, summary, operations_json, patch_sha256, evidence_json, diagnostic_issue_ids_json,
     status, lock_version, created_by_kind, created_by_id, decision_note, created_at)
    SELECT ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?, ?, ?, ?, '[]', 'candidate', 1, 'import', ?, '', ?
    WHERE EXISTS (
      SELECT 1 FROM article_project_packages
      WHERE id = ? AND status = 'active' AND lock_version = ?
        AND main_composition_id = ? AND main_composition_sha256 = ?
    )`).bind(
      patchProposalId, ownerPackageId, baseCompositionId, expectedBaseCompositionSha256,
      bridgeState?.row.branch_id ?? null, bridgeState?.row.head_revision_id ?? null,
      bridgeState ? expectedPackageLockVersion : null,
      title, summary, canonicalJson(operations), patchSha256, canonicalJson(evidence), importerKey, now,
      ownerPackageId, expectedPackageLockVersion, baseCompositionId, expectedBaseCompositionSha256,
    );
  const importInsert = db.prepare(`INSERT INTO package_import_runs
    (id, package_id, base_composition_id, base_composition_sha256, source_kind, source_ref,
     source_fingerprint_sha256, importer_key, importer_version, manifest_json, manifest_sha256,
     patch_proposal_id, state, lock_version, error_summary, created_at, finished_at)
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'candidate_ready', 1, '', ?, ?
    WHERE EXISTS (
      SELECT 1 FROM package_patch_proposals
      WHERE id = ? AND package_id = ? AND status = 'candidate' AND patch_sha256 = ?
    )`).bind(
      importRunId, ownerPackageId, baseCompositionId, expectedBaseCompositionSha256,
      sourceKind, sourceRef, sourceFingerprintSha256, importerKey, importerVersion,
      canonicalJson(manifest), manifestSha256, patchProposalId, now, now,
      patchProposalId, ownerPackageId, patchSha256,
    );
  const event = db.prepare(`INSERT INTO workspace_events
    (id, event_type, subject_type, subject_id, article_id, payload_json, input_sha256, created_at)
    SELECT ?, 'package.import_candidate_ready', 'package_import_run', ?, ?, ?, ?, ?
    WHERE changes() = 1 AND EXISTS (
      SELECT 1 FROM package_import_runs WHERE id = ? AND state = 'candidate_ready' AND patch_proposal_id = ?
    )`).bind(
      `workspace-event-${crypto.randomUUID()}`, importRunId, state.root.article_id,
      canonicalJson({ packageId: ownerPackageId, patchProposalId, candidateOnly: true }), inputSha256, now,
      importRunId, patchProposalId,
    );
  const results = await db.batch([patchInsert, importInsert, event]);
  assertAllChanged(results, "IMPORT_CANDIDATE_CONFLICT", "导入候选创建时 Package 基线发生变化");
  const [importRow, proposalRow] = await Promise.all([
    db.prepare("SELECT * FROM package_import_runs WHERE id = ?").bind(importRunId).first<D1Row>(),
    patchRow(db, patchProposalId, ownerPackageId),
  ]);
  return {
    status: 201,
    data: {
      importRun: parseImportRow(importRow!, true), patchProposal: parsePatchRow(proposalRow, true), reused: false,
      boundary: { candidateOnly: true, packageMainAdvanced: false, compositionCreated: false, sourceWritten: false },
    },
  };
}

async function createImportCandidate(db: D1Database, payload: JsonObject, inputSha256: string) {
  const ownerPackageId = requiredText(payload.packageId, "packageId", 160);
  const root = await packageRow(db, ownerPackageId);
  const selected = await loadSelectedPackageBranch(db, root, optionalText(payload.branchId, 160) || undefined, true);
  let expectedBranchLockVersion: number;
  if (payload.expectedBranchLockVersion === undefined) {
    const legacyPackageLockVersion = exactInteger(payload.expectedPackageLockVersion, "expectedPackageLockVersion", 1, 2_147_483_647);
    if (selected.branchId !== root.primary_branch_id || legacyPackageLockVersion !== Number(root.lock_version)) {
      throw new ProjectPackageApiError("BRANCH_BASELINE_REQUIRED", "创建导入候选必须提供 expectedBranchLockVersion", 409);
    }
    expectedBranchLockVersion = selected.branchState.lockVersion;
  } else {
    expectedBranchLockVersion = exactInteger(payload.expectedBranchLockVersion, "expectedBranchLockVersion", 1, 2_147_483_647);
  }
  const baseCompositionId = requiredText(payload.baseCompositionId, "baseCompositionId", 160);
  const expectedBaseCompositionSha256 = exactSha256(payload.expectedBaseCompositionSha256, "expectedBaseCompositionSha256");
  const baseRevisionId = optionalText(payload.baseRevisionId, 160) || selected.branchState.headRevisionId;
  if (selected.branchState.lockVersion !== expectedBranchLockVersion
    || selected.branchState.headCompositionId !== baseCompositionId
    || selected.branchState.headCompositionSha256 !== expectedBaseCompositionSha256
    || selected.branchState.headRevisionId !== baseRevisionId) {
    throw new ProjectPackageApiError("PACKAGE_BRANCH_CAS_CONFLICT", "创建导入候选时目标分支基线已变化", 409);
  }
  const branchCommit = await db.prepare(`SELECT id FROM package_branch_composition_commits
    WHERE package_id = ? AND branch_id = ? AND composition_id = ? AND composition_sha256 = ?
      AND article_revision_id = ? LIMIT 1`)
    .bind(ownerPackageId, selected.branchId, baseCompositionId, expectedBaseCompositionSha256, baseRevisionId)
    .first<D1Row>();
  if (!branchCommit) {
    throw new ProjectPackageApiError("BRANCH_COMPOSITION_NOT_FOUND", "导入候选基线不在目标 ArticleBranch 的提交历史中", 409);
  }
  const sourceKind = requiredText(payload.sourceKind, "sourceKind", 80);
  const sourceRef = safeReference(payload.sourceRef, "sourceRef", 2_000);
  const sourceFingerprintSha256 = exactSha256(payload.sourceFingerprintSha256, "sourceFingerprintSha256");
  const importerKey = requiredText(payload.importerKey, "importerKey", 120);
  const importerVersion = requiredText(payload.importerVersion, "importerVersion", 80);
  const summary = optionalText(payload.summary, 2_000, true);
  const evidence = stringArray(payload.evidence, "evidence", 100, 1_000);
  const baseDocument = parseJson<PackageDocument>(selected.composition.document_json, {} as PackageDocument);
  const candidateDocument = await prepareDocument(db, ownerPackageId, payload.document, baseDocument);
  if (candidateDocument.metadata.importWorkflow !== undefined) {
    try {
      candidateDocument.metadata.importWorkflow = parseImportWorkflowMetadata(
        candidateDocument.metadata.importWorkflow,
        sourceFingerprintSha256,
      );
    } catch (error) {
      if (error instanceof ImportProfileContractError) {
        throw new ProjectPackageApiError(error.code, error.message, 400);
      }
      throw error;
    }
  }
  const candidateDocumentSha256 = await documentSha(candidateDocument);
  if (candidateDocumentSha256 === String(selected.composition.document_sha256)) {
    throw new ProjectPackageApiError("IMPORT_HAS_NO_CHANGES", "导入候选与目标分支 Composition 完全相同");
  }
  const operations: PackagePatchOperation[] = [{ op: "replace_document", document: candidateDocument }];
  const patchSha256 = await sha256Text(canonicalJson({
    packageId: ownerPackageId,
    branchId: selected.branchId,
    baseCompositionId,
    baseCompositionSha256: expectedBaseCompositionSha256,
    baseRevisionId,
    baseBranchLockVersion: expectedBranchLockVersion,
    sourceKind,
    sourceRef,
    sourceFingerprintSha256,
    importerKey,
    importerVersion,
    operations,
  }));
  const manifest = canonicalValue({
    schemaVersion: "wenmai-import-candidate-manifest-v2",
    packageId: ownerPackageId,
    branchId: selected.branchId,
    baseCompositionId,
    baseCompositionSha256: expectedBaseCompositionSha256,
    baseRevisionId,
    baseBranchLockVersion: expectedBranchLockVersion,
    sourceKind,
    sourceRef,
    sourceFingerprintSha256,
    importerKey,
    importerVersion,
    importWorkflow: candidateDocument.metadata.importWorkflow ?? null,
    candidateDocumentSha256,
    moduleCount: candidateDocument.modules.length,
    edgeCount: candidateDocument.edges.length,
    assets: candidateDocument.assets.map((asset) => ({ key: asset.key, sha256: asset.sha256 })),
    sources: await Promise.all(candidateDocument.sources.map(async (source) => ({
      key: source.key,
      refSha256: await sha256Text(canonicalJson({
        sourceKind: source.sourceKind,
        canonicalRef: source.canonicalRef,
        title: source.title,
        capturedAt: source.capturedAt ?? null,
        contentSha256: source.contentSha256 ?? null,
        excerpt: source.excerpt ?? "",
        metadata: source.metadata ?? {},
        rights: source.rights ?? {},
      })),
    }))),
  }) as JsonObject;
  const manifestSha256 = await sha256Text(canonicalJson(manifest));
  const existing = await db.prepare(`SELECT * FROM package_import_runs
    WHERE package_id = ? AND branch_id = ? AND manifest_sha256 = ? LIMIT 1`)
    .bind(ownerPackageId, selected.branchId, manifestSha256).first<D1Row>();
  if (existing) {
    const existingPatch = await patchRow(db, String(existing.patch_proposal_id), ownerPackageId);
    return {
      data: {
        importRun: parseImportRow(existing, true),
        patchProposal: parsePatchRow(existingPatch, true),
        reused: true,
        boundary: { candidateOnly: true, packageMainAdvanced: false, branchAdvanced: false,
          compositionCreated: false, sourceWritten: false },
      },
    };
  }
  const patchProposalId = `patch-${crypto.randomUUID()}`;
  const importRunId = `import-${crypto.randomUUID()}`;
  const title = optionalText(payload.title, 300) || `导入候选：${sourceKind}`;
  const now = isoNow();
  const patchInsert = db.prepare(`INSERT INTO package_patch_proposals
    (id, package_id, base_composition_id, base_composition_sha256, branch_id, base_revision_id,
     base_package_lock_version, base_branch_lock_version, task_id, attempt_id, context_sha256,
     title, summary, operations_json, patch_sha256, evidence_json, diagnostic_issue_ids_json,
     status, lock_version, created_by_kind, created_by_id, decision_note, created_at)
    SELECT ?, ?, ?, ?, ?, ?, NULL, ?, NULL, NULL, NULL, ?, ?, ?, ?, ?, '[]',
      'candidate', 1, 'import', ?, '', ?
    WHERE EXISTS (SELECT 1 FROM package_branch_states WHERE package_id = ? AND branch_id = ?
      AND head_composition_id = ? AND head_composition_sha256 = ? AND head_revision_id = ?
      AND lock_version = ? AND status = 'active')
      AND EXISTS (SELECT 1 FROM package_branch_composition_commits WHERE id = ? AND package_id = ?
        AND branch_id = ? AND composition_id = ? AND article_revision_id = ?)`)
    .bind(
      patchProposalId, ownerPackageId, baseCompositionId, expectedBaseCompositionSha256,
      selected.branchId, baseRevisionId, expectedBranchLockVersion,
      title, summary, canonicalJson(operations), patchSha256, canonicalJson(evidence), importerKey, now,
      ownerPackageId, selected.branchId, baseCompositionId, expectedBaseCompositionSha256,
      baseRevisionId, expectedBranchLockVersion,
      branchCommit.id, ownerPackageId, selected.branchId, baseCompositionId, baseRevisionId,
    );
  const importInsert = db.prepare(`INSERT INTO package_import_runs
    (id, package_id, branch_id, base_revision_id, base_branch_lock_version,
     base_composition_id, base_composition_sha256, source_kind, source_ref,
     source_fingerprint_sha256, importer_key, importer_version, manifest_json, manifest_sha256,
     patch_proposal_id, state, lock_version, error_summary, created_at, finished_at)
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'candidate_ready', 1, '', ?, ?
    WHERE EXISTS (SELECT 1 FROM package_patch_proposals WHERE id = ? AND package_id = ?
      AND branch_id = ? AND base_revision_id = ? AND base_branch_lock_version = ?
      AND status = 'candidate' AND patch_sha256 = ?)`)
    .bind(
      importRunId, ownerPackageId, selected.branchId, baseRevisionId, expectedBranchLockVersion,
      baseCompositionId, expectedBaseCompositionSha256, sourceKind, sourceRef,
      sourceFingerprintSha256, importerKey, importerVersion, canonicalJson(manifest), manifestSha256,
      patchProposalId, now, now,
      patchProposalId, ownerPackageId, selected.branchId, baseRevisionId, expectedBranchLockVersion, patchSha256,
    );
  const event = db.prepare(`INSERT INTO workspace_events
    (id, event_type, subject_type, subject_id, article_id, payload_json, input_sha256, created_at)
    SELECT ?, 'package.branch_import_candidate_ready', 'package_import_run', ?, ?, ?, ?, ?
    WHERE changes() = 1 AND EXISTS (SELECT 1 FROM package_import_runs WHERE id = ? AND package_id = ?
      AND branch_id = ? AND state = 'candidate_ready' AND patch_proposal_id = ?)`)
    .bind(
      `workspace-event-${crypto.randomUUID()}`, importRunId, root.article_id,
      canonicalJson({ packageId: ownerPackageId, branchId: selected.branchId,
        baseRevisionId, baseBranchLockVersion: expectedBranchLockVersion,
        patchProposalId, candidateOnly: true }),
      inputSha256, now, importRunId, ownerPackageId, selected.branchId, patchProposalId,
    );
  const results = await db.batch([patchInsert, importInsert, event]);
  assertAllChanged(results, "IMPORT_CANDIDATE_CONFLICT", "导入候选创建时目标分支基线发生变化");
  const [importRowValue, proposalRow] = await Promise.all([
    db.prepare("SELECT * FROM package_import_runs WHERE id = ?").bind(importRunId).first<D1Row>(),
    patchRow(db, patchProposalId, ownerPackageId),
  ]);
  return {
    status: 201,
    data: {
      importRun: parseImportRow(importRowValue!, true),
      patchProposal: parsePatchRow(proposalRow, true),
      reused: false,
      boundary: { candidateOnly: true, packageMainAdvanced: false, branchAdvanced: false,
        compositionCreated: false, sourceWritten: false },
    },
  };
}

void _createImportCandidate0009;

async function _createExportManifest0009(db: D1Database, payload: JsonObject, inputSha256: string) {
  const ownerPackageId = requiredText(payload.packageId, "packageId", 160);
  const compositionId = requiredText(payload.compositionId, "compositionId", 160);
  const expectedCompositionSha256 = exactSha256(payload.expectedCompositionSha256, "expectedCompositionSha256");
  const exportKind = optionalText(payload.exportKind, 80) || "manifest";
  const exporterKey = optionalText(payload.exporterKey, 120) || "wenmai.package-manifest";
  const exporterVersion = optionalText(payload.exporterVersion, 80) || "1";
  const detail = await loadCompositionDetail(db, compositionId, ownerPackageId);
  assertCompositionSha(detail.row, expectedCompositionSha256);
  let slice: D1Row | null = null;
  const sliceId = optionalText(payload.sliceId, 160) || null;
  const expectedSliceSha256 = optionalSha256(payload.expectedSliceSha256, "expectedSliceSha256");
  if (sliceId) {
    if (!expectedSliceSha256) throw new ProjectPackageApiError("SLICE_SHA_REQUIRED", "指定 sliceId 时必须提供 expectedSliceSha256");
    slice = await db.prepare("SELECT * FROM package_slices WHERE id = ? AND package_id = ? AND composition_id = ? LIMIT 1")
      .bind(sliceId, ownerPackageId, compositionId).first<D1Row>();
    if (!slice) throw new ProjectPackageApiError("SLICE_NOT_FOUND", "Slice 不存在或不属于指定 Composition", 404);
    if (slice.slice_sha256 !== expectedSliceSha256) throw new ProjectPackageApiError("SLICE_SHA_MISMATCH", "Slice 摘要与请求不一致", 409);
  } else if (expectedSliceSha256) {
    throw new ProjectPackageApiError("SLICE_ID_REQUIRED", "指定 expectedSliceSha256 时必须提供 sliceId");
  }
  const root = await packageRow(db, ownerPackageId);
  const manifest = canonicalValue({
    schemaVersion: "wenmai-package-export-manifest-v1", apiVersion: API_VERSION,
    package: { id: ownerPackageId, articleId: root.article_id, title: root.title },
    composition: {
      id: compositionId, sha256: expectedCompositionSha256, documentSha256: detail.row.document_sha256,
      manifest: parseJson<JsonObject>(detail.row.manifest_json, {}),
    },
    slice: slice ? {
      id: slice.id, sha256: slice.slice_sha256, kind: slice.slice_kind,
      resolvedManifest: parseJson<JsonObject>(slice.resolved_manifest_json, {}),
    } : null,
    exportKind, exporterKey, exporterVersion,
    boundaries: { containsFullBody: false, artifactCreated: false, releaseCreated: false, published: false, publiclyVisible: false },
  }) as JsonObject;
  const manifestSha256 = await sha256Text(canonicalJson(manifest));
  const existing = await db.prepare("SELECT * FROM package_export_runs WHERE package_id = ? AND manifest_sha256 = ? LIMIT 1")
    .bind(ownerPackageId, manifestSha256).first<D1Row>();
  if (existing) {
    return {
      data: {
        exportRun: parseExportRow(existing, true), manifest, reused: true,
        boundary: { artifactCreated: false, releaseCreated: false, published: false, publiclyVisible: false },
      },
    };
  }
  const exportRunId = `export-${crypto.randomUUID()}`;
  const now = isoNow();
  const results = await db.batch([
    db.prepare(`INSERT INTO package_export_runs
      (id, package_id, composition_id, composition_sha256, slice_id, slice_sha256,
       export_kind, exporter_key, exporter_version, manifest_json, manifest_sha256,
       artifact_ref, artifact_sha256, artifact_media_type, state, lock_version,
       failure_summary, created_at, verified_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', '', 'application/json', 'manifest_ready', 1, '', ?, NULL)`)
      .bind(
        exportRunId, ownerPackageId, compositionId, expectedCompositionSha256,
        sliceId, expectedSliceSha256, exportKind, exporterKey, exporterVersion,
        canonicalJson(manifest), manifestSha256, now,
      ),
    appendEventStatement(db, {
      eventType: "package.export_manifest_ready", subjectType: "package_export_run", subjectId: exportRunId,
      articleId: String(root.article_id), payload: { packageId: ownerPackageId, compositionId, sliceId, artifactCreated: false, releaseCreated: false },
      inputSha256, createdAt: now,
    }),
  ]);
  assertAllChanged(results, "EXPORT_MANIFEST_CONFLICT", "Export manifest 创建发生并发冲突");
  const row = await db.prepare("SELECT * FROM package_export_runs WHERE id = ?").bind(exportRunId).first<D1Row>();
  return {
    status: 201,
    data: {
      exportRun: parseExportRow(row!, true), manifest, reused: false,
      boundary: { artifactCreated: false, releaseCreated: false, published: false, publiclyVisible: false },
    },
  };
}

async function createExportManifest(db: D1Database, payload: JsonObject, inputSha256: string) {
  const ownerPackageId = requiredText(payload.packageId, "packageId", 160);
  const root = await packageRow(db, ownerPackageId);
  const selected = await loadSelectedPackageBranch(db, root, optionalText(payload.branchId, 160) || undefined, true);
  let expectedBranchLockVersion: number;
  if (payload.expectedBranchLockVersion === undefined) {
    const legacyPackageLockVersion = exactInteger(payload.expectedPackageLockVersion, "expectedPackageLockVersion", 1, 2_147_483_647);
    if (selected.branchId !== root.primary_branch_id || legacyPackageLockVersion !== Number(root.lock_version)) {
      throw new ProjectPackageApiError("BRANCH_BASELINE_REQUIRED", "创建 Export manifest 必须提供 expectedBranchLockVersion", 409);
    }
    expectedBranchLockVersion = selected.branchState.lockVersion;
  } else {
    expectedBranchLockVersion = exactInteger(payload.expectedBranchLockVersion, "expectedBranchLockVersion", 1, 2_147_483_647);
  }
  if (selected.branchState.lockVersion !== expectedBranchLockVersion) {
    throw new ProjectPackageApiError("PACKAGE_BRANCH_CAS_CONFLICT", "创建 Export manifest 时目标分支 lockVersion 已变化", 409);
  }
  const compositionId = requiredText(payload.compositionId, "compositionId", 160);
  const expectedCompositionSha256 = exactSha256(payload.expectedCompositionSha256, "expectedCompositionSha256");
  const baseRevisionId = optionalText(payload.baseRevisionId, 160) || selected.branchState.headRevisionId;
  const detail = await loadCompositionDetail(db, compositionId, ownerPackageId);
  assertCompositionSha(detail.row, expectedCompositionSha256);
  const branchCommit = await db.prepare(`SELECT id FROM package_branch_composition_commits
    WHERE package_id = ? AND branch_id = ? AND composition_id = ? AND composition_sha256 = ?
      AND article_revision_id = ? LIMIT 1`)
    .bind(ownerPackageId, selected.branchId, compositionId, expectedCompositionSha256, baseRevisionId)
    .first<D1Row>();
  if (!branchCommit) {
    throw new ProjectPackageApiError("BRANCH_COMPOSITION_NOT_FOUND", "Export Composition 不在目标 ArticleBranch 的提交历史中", 409);
  }
  const exportKind = optionalText(payload.exportKind, 80) || "manifest";
  const exporterKey = optionalText(payload.exporterKey, 120) || "wenmai.package-manifest";
  const exporterVersion = optionalText(payload.exporterVersion, 80) || "2";
  let slice: D1Row | null = null;
  const sliceId = optionalText(payload.sliceId, 160) || null;
  const expectedSliceSha256 = optionalSha256(payload.expectedSliceSha256, "expectedSliceSha256");
  if (sliceId) {
    if (!expectedSliceSha256) {
      throw new ProjectPackageApiError("SLICE_SHA_REQUIRED", "指定 sliceId 时必须提供 expectedSliceSha256");
    }
    slice = await db.prepare(`SELECT * FROM package_slices
      WHERE id = ? AND package_id = ? AND branch_id = ? AND base_revision_id = ?
        AND composition_id = ? LIMIT 1`)
      .bind(sliceId, ownerPackageId, selected.branchId, baseRevisionId, compositionId).first<D1Row>();
    if (!slice) throw new ProjectPackageApiError("SLICE_NOT_FOUND", "Slice 不存在或不属于目标分支快照", 404);
    if (slice.slice_sha256 !== expectedSliceSha256) {
      throw new ProjectPackageApiError("SLICE_SHA_MISMATCH", "Slice 摘要与请求不一致", 409);
    }
  } else if (expectedSliceSha256) {
    throw new ProjectPackageApiError("SLICE_ID_REQUIRED", "指定 expectedSliceSha256 时必须提供 sliceId");
  }
  const manifest = canonicalValue({
    schemaVersion: "wenmai-package-export-manifest-v2",
    apiVersion: API_VERSION,
    package: { id: ownerPackageId, articleId: root.article_id, title: root.title },
    branch: {
      id: selected.branchId,
      baseRevisionId,
      branchStateLockVersion: expectedBranchLockVersion,
      branchCommitId: branchCommit.id,
    },
    composition: {
      id: compositionId,
      sha256: expectedCompositionSha256,
      documentSha256: detail.row.document_sha256,
      manifest: parseJson<JsonObject>(detail.row.manifest_json, {}),
    },
    slice: slice ? {
      id: slice.id,
      sha256: slice.slice_sha256,
      kind: slice.slice_kind,
      resolvedManifest: parseJson<JsonObject>(slice.resolved_manifest_json, {}),
    } : null,
    exportKind,
    exporterKey,
    exporterVersion,
    boundaries: {
      containsFullBody: false,
      artifactCreated: false,
      releaseCreated: false,
      published: false,
      publiclyVisible: false,
    },
  }) as JsonObject;
  const manifestSha256 = await sha256Text(canonicalJson(manifest));
  const existing = await db.prepare(`SELECT * FROM package_export_runs
    WHERE package_id = ? AND branch_id = ? AND manifest_sha256 = ? LIMIT 1`)
    .bind(ownerPackageId, selected.branchId, manifestSha256).first<D1Row>();
  if (existing) {
    return {
      data: {
        exportRun: parseExportRow(existing, true),
        manifest,
        reused: true,
        boundary: { artifactCreated: false, releaseCreated: false, published: false, publiclyVisible: false },
      },
    };
  }
  const exportRunId = `export-${crypto.randomUUID()}`;
  const now = isoNow();
  const results = await db.batch([
    db.prepare(`INSERT INTO package_export_runs
      (id, package_id, branch_id, base_revision_id, base_branch_lock_version,
       composition_id, composition_sha256, slice_id, slice_sha256,
       export_kind, exporter_key, exporter_version, manifest_json, manifest_sha256,
       artifact_ref, artifact_sha256, artifact_media_type, state, lock_version,
       failure_summary, created_at, verified_at)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', '', 'application/json',
        'manifest_ready', 1, '', ?, NULL
      WHERE EXISTS (SELECT 1 FROM package_branch_states WHERE package_id = ? AND branch_id = ?
        AND lock_version = ? AND status = 'active')
        AND EXISTS (SELECT 1 FROM package_branch_composition_commits WHERE id = ? AND package_id = ?
          AND branch_id = ? AND composition_id = ? AND article_revision_id = ?)
        AND (? IS NULL OR EXISTS (SELECT 1 FROM package_slices WHERE id = ? AND package_id = ?
          AND branch_id = ? AND base_revision_id = ? AND composition_id = ? AND slice_sha256 = ?))`)
      .bind(
        exportRunId, ownerPackageId, selected.branchId, baseRevisionId, expectedBranchLockVersion,
        compositionId, expectedCompositionSha256, sliceId, expectedSliceSha256,
        exportKind, exporterKey, exporterVersion, canonicalJson(manifest), manifestSha256, now,
        ownerPackageId, selected.branchId, expectedBranchLockVersion,
        branchCommit.id, ownerPackageId, selected.branchId, compositionId, baseRevisionId,
        sliceId, sliceId, ownerPackageId, selected.branchId, baseRevisionId, compositionId, expectedSliceSha256,
      ),
    appendEventStatement(db, {
      eventType: "package.branch_export_manifest_ready",
      subjectType: "package_export_run",
      subjectId: exportRunId,
      articleId: String(root.article_id),
      payload: {
        packageId: ownerPackageId,
        branchId: selected.branchId,
        baseRevisionId,
        baseBranchLockVersion: expectedBranchLockVersion,
        compositionId,
        sliceId,
        artifactCreated: false,
        releaseCreated: false,
      },
      inputSha256,
      createdAt: now,
    }),
  ]);
  assertAllChanged(results, "EXPORT_MANIFEST_CONFLICT", "Export manifest 创建时目标分支基线发生变化");
  const row = await db.prepare("SELECT * FROM package_export_runs WHERE id = ?").bind(exportRunId).first<D1Row>();
  return {
    status: 201,
    data: {
      exportRun: parseExportRow(row!, true),
      manifest,
      reused: false,
      boundary: { artifactCreated: false, releaseCreated: false, published: false, publiclyVisible: false },
    },
  };
}

void _createExportManifest0009;

async function decideGuidanceProfile(
  db: D1Database,
  payload: JsonObject,
  inputSha256: string,
  receiptId: string,
  actorId: string,
) {
  const allowedFields = new Set([
    "packageId", "branchId", "expectedChecklistSha256", "expectedPackageLockVersion",
    "expectedBranchLockVersion", "expectedWorkingLockVersion", "selectedProfile", "decisionNote",
  ]);
  const unexpectedFields = Object.keys(payload).filter((key) => !allowedFields.has(key));
  if (unexpectedFields.length) {
    throw new ProjectPackageApiError("UNKNOWN_GUIDANCE_DECISION_FIELD", "人工分流 payload 包含未允许字段", 400, {
      unexpectedFields,
    });
  }
  const ownerPackageId = requiredText(payload.packageId, "packageId", 160);
  const branchId = requiredText(payload.branchId, "branchId", 160);
  const expectedChecklistSha256 = exactSha256(payload.expectedChecklistSha256, "expectedChecklistSha256");
  const expectedPackageLockVersion = exactInteger(payload.expectedPackageLockVersion, "expectedPackageLockVersion", 1, 2_147_483_647);
  const expectedBranchLockVersion = exactInteger(payload.expectedBranchLockVersion, "expectedBranchLockVersion", 1, 2_147_483_647);
  const expectedWorkingLockVersion = exactInteger(payload.expectedWorkingLockVersion, "expectedWorkingLockVersion", 1, 2_147_483_647);
  const selectedProfile = requiredText(payload.selectedProfile, "selectedProfile", 40);
  if (!ARTICLE_GUIDANCE_PROFILES.includes(selectedProfile as (typeof ARTICLE_GUIDANCE_PROFILES)[number])) {
    throw new ProjectPackageApiError("INVALID_GUIDANCE_PROFILE", "selectedProfile 只能是 light_archive 或 full_production", 400);
  }
  const decisionNote = requiredText(payload.decisionNote, "decisionNote", 1_000);
  const root = await packageRow(db, ownerPackageId);
  if (Number(root.lock_version) !== expectedPackageLockVersion) {
    throw new ProjectPackageApiError("GUIDANCE_PACKAGE_CAS_CONFLICT", "人工分流时 Package lockVersion 已变化", 409, {
      currentPackageLockVersion: Number(root.lock_version),
    });
  }
  const selected = await loadSelectedPackageBranch(db, root, branchId, true);
  if (selected.branchState.lockVersion !== expectedBranchLockVersion) {
    throw new ProjectPackageApiError("GUIDANCE_BRANCH_CAS_CONFLICT", "人工分流时 Branch lockVersion 已变化", 409, {
      currentBranchLockVersion: selected.branchState.lockVersion,
    });
  }
  if (selected.workingCopy.lockVersion !== expectedWorkingLockVersion) {
    throw new ProjectPackageApiError("GUIDANCE_WORKING_CAS_CONFLICT", "人工分流时工作副本 lockVersion 已变化", 409, {
      currentWorkingLockVersion: selected.workingCopy.lockVersion,
    });
  }
  const checklistBindings = {
    articleId: String(root.article_id), projectId: root.project_id === null ? null : String(root.project_id),
    packageId: ownerPackageId, branchId: selected.branchId,
    revisionId: selected.branchBridge.headRevisionId, bodySha256: selected.branchBridge.headBodySha256,
    compositionId: String(selected.composition.id), compositionSha256: String(selected.composition.composition_sha256),
    documentSha256: selected.workingCopy.documentSha256,
    packageLockVersion: Number(root.lock_version), branchLockVersion: selected.branchState.lockVersion,
    workingCopyLockVersion: selected.workingCopy.lockVersion,
  };
  const baselineChecklist = await buildArticleGuidanceChecklist({
    document: selected.workingCopy.document as PackageDocument,
    packageStatus: String(root.status), branchStatus: selected.branchState.status,
    workingCopyDirty: selected.workingCopy.dirty, branchBridgeInSync: selected.branchBridge.inSync,
    bindings: checklistBindings,
  });
  const bindings = selectedGuidanceBindings(root, selected, baselineChecklist.checklistSha256);
  const previousDecision = await loadLatestVerifiedArticleGuidanceDecision(db, bindings);
  const currentChecklist = previousDecision
    ? await buildArticleGuidanceChecklist({
      document: selected.workingCopy.document as PackageDocument,
      packageStatus: String(root.status), branchStatus: selected.branchState.status,
      workingCopyDirty: selected.workingCopy.dirty, branchBridgeInSync: selected.branchBridge.inSync,
      bindings: checklistBindings, verifiedDecision: previousDecision,
    })
    : baselineChecklist;
  if (currentChecklist.checklistSha256 !== expectedChecklistSha256) {
    throw new ProjectPackageApiError("GUIDANCE_CHECKLIST_CAS_CONFLICT", "人工分流时当前指导清单已变化", 409, {
      currentChecklistSha256: currentChecklist.checklistSha256,
      currentDecisionReceiptId: previousDecision?.receiptId ?? null,
    });
  }
  if (!baselineChecklist.archiveReady) {
    throw new ProjectPackageApiError("GUIDANCE_ARCHIVE_NOT_READY", "建档必需检查尚未通过，不能确认处理档位", 409, {
      checklistSha256: baselineChecklist.checklistSha256,
    });
  }
  const completedAt = isoNow();
  const verifiedDecision: VerifiedArticleGuidanceDecision = {
    schemaVersion: ARTICLE_GUIDANCE_DECISION_SCHEMA_VERSION,
    receiptId,
    actorId,
    requestSha256: inputSha256,
    selectedProfile: selectedProfile as VerifiedArticleGuidanceDecision["selectedProfile"],
    decisionNote,
    decidedAt: completedAt,
    bindings,
  };
  const guidanceChecklist = await buildArticleGuidanceChecklist({
    document: selected.workingCopy.document as PackageDocument,
    packageStatus: String(root.status), branchStatus: selected.branchState.status,
    workingCopyDirty: selected.workingCopy.dirty, branchBridgeInSync: selected.branchBridge.inSync,
    bindings: checklistBindings,
    verifiedDecision,
  });
  return {
    status: 201,
    data: {
      guidanceDecision: {
        schemaVersion: ARTICLE_GUIDANCE_DECISION_SCHEMA_VERSION,
        receiptId, actorId, requestSha256: inputSha256,
        selectedProfile, decisionNote, bindings,
        supersedesReceiptId: previousDecision?.receiptId ?? null,
      },
      guidanceChecklist,
      previousDecision: previousDecision ? {
        receiptId: previousDecision.receiptId,
        selectedProfile: previousDecision.selectedProfile,
        checklistSha256: currentChecklist.checklistSha256,
      } : null,
      boundary: {
        bodyChanged: false, compositionChanged: false, locksChanged: false,
        editorialComplete: false, artifactDelivered: false, published: false,
      },
    },
  };
}

type BuiltDiagnosticIssue = {
  id: string; moduleId: string | null; nodeId: string | null; edgeId: string | null;
  code: string; severity: "error" | "warning" | "info"; title: string; message: string;
  evidence: string[]; suggestedPatch: PackagePatchOperation[]; issueSha256: string;
};

async function runBuiltinDiagnostics(db: D1Database, payload: JsonObject, inputSha256: string) {
  const ownerPackageId = requiredText(payload.packageId, "packageId", 160);
  const root = await packageRow(db, ownerPackageId);
  const selected = await loadSelectedPackageBranch(db, root, optionalText(payload.branchId, 160) || undefined, true);
  let expectedBranchLockVersion: number;
  if (payload.expectedBranchLockVersion === undefined) {
    const legacyPackageLockVersion = exactInteger(payload.expectedPackageLockVersion, "expectedPackageLockVersion", 1, 2_147_483_647);
    if (selected.branchId !== root.primary_branch_id || legacyPackageLockVersion !== Number(root.lock_version)) {
      throw new ProjectPackageApiError("BRANCH_BASELINE_REQUIRED", "运行诊断必须提供 expectedBranchLockVersion", 409);
    }
    expectedBranchLockVersion = selected.branchState.lockVersion;
  } else {
    expectedBranchLockVersion = exactInteger(payload.expectedBranchLockVersion, "expectedBranchLockVersion", 1, 2_147_483_647);
  }
  if (selected.branchState.lockVersion !== expectedBranchLockVersion) {
    throw new ProjectPackageApiError("PACKAGE_BRANCH_CAS_CONFLICT", "运行诊断时目标分支 lockVersion 已变化", 409);
  }
  const compositionId = requiredText(payload.compositionId, "compositionId", 160);
  const expectedCompositionSha256 = exactSha256(payload.expectedCompositionSha256, "expectedCompositionSha256");
  const baseRevisionId = optionalText(payload.baseRevisionId, 160) || selected.branchState.headRevisionId;
  const detail = await loadCompositionDetail(db, compositionId, ownerPackageId);
  assertCompositionSha(detail.row, expectedCompositionSha256);
  const branchCommit = await db.prepare(`SELECT id FROM package_branch_composition_commits
    WHERE package_id = ? AND branch_id = ? AND composition_id = ? AND composition_sha256 = ?
      AND article_revision_id = ? LIMIT 1`)
    .bind(ownerPackageId, selected.branchId, compositionId, expectedCompositionSha256, baseRevisionId)
    .first<D1Row>();
  if (!branchCommit) {
    throw new ProjectPackageApiError("BRANCH_COMPOSITION_NOT_FOUND", "诊断 Composition 不在目标 ArticleBranch 的提交历史中", 409);
  }
  const document = parseJson<PreparedDocument>(detail.row.document_json, {} as PreparedDocument);
  const checklistBindings = {
    articleId: String(root.article_id), projectId: root.project_id === null ? null : String(root.project_id),
    packageId: ownerPackageId, branchId: selected.branchId,
    revisionId: baseRevisionId, bodySha256: selected.branchBridge.headBodySha256,
    compositionId, compositionSha256: expectedCompositionSha256,
    documentSha256: String(detail.row.document_sha256),
    packageLockVersion: Number(root.lock_version), branchLockVersion: selected.branchState.lockVersion,
    workingCopyLockVersion: selected.workingCopy.lockVersion,
  };
  const checklistInput = {
    document: document as PackageDocument,
    packageStatus: String(root.status),
    branchStatus: selected.branchState.status,
    workingCopyDirty: selected.workingCopy.dirty,
    branchBridgeInSync: selected.branchBridge.inSync,
    bindings: checklistBindings,
  };
  const baselineChecklist = await buildArticleGuidanceChecklist(checklistInput);
  const verifiedDecision = await loadLatestVerifiedArticleGuidanceDecision(db, {
    ...checklistBindings,
    baselineChecklistSha256: baselineChecklist.checklistSha256,
  });
  const guidanceChecklist = verifiedDecision
    ? await buildArticleGuidanceChecklist({ ...checklistInput, verifiedDecision })
    : baselineChecklist;
  const diagnosticInputSha256 = await sha256Text(canonicalJson({
    algorithmVersion: DIAGNOSTIC_ALGORITHM_VERSION, packageId: ownerPackageId,
    branchId: selected.branchId, baseRevisionId, baseBranchLockVersion: expectedBranchLockVersion,
    compositionId, compositionSha256: expectedCompositionSha256,
    guidanceChecklistSha256: guidanceChecklist.checklistSha256,
  }));
  const existing = await db.prepare(`SELECT * FROM package_diagnosis_runs
    WHERE package_id = ? AND branch_id = ? AND input_sha256 = ? LIMIT 1`)
    .bind(ownerPackageId, selected.branchId, diagnosticInputSha256).first<D1Row>();
  if (existing) {
    const issues = await db.prepare("SELECT * FROM package_diagnostic_issues WHERE diagnosis_run_id = ? ORDER BY severity ASC, code ASC, id ASC LIMIT 100")
      .bind(existing.id).all<D1Row>();
    return {
      data: {
        diagnosisRun: parseDiagnosisRunRow(existing), issues: issues.results.map(parseIssueRow), reused: true,
        boundary: { diagnosticsOnly: true, patchProposalCreated: false, packageMainAdvanced: false, compositionCreated: false },
      },
    };
  }
  const nodesByModule = new Map(detail.nodes.map((node) => [node.moduleId, node]));
  const revisionsById = new Map(detail.moduleRevisions.map((revision) => [String(revision.id), revision as JsonObject]));
  const nodeById = new Map(detail.nodes.map((node) => [node.id, node]));
  const rootModuleId = String(detail.row.root_module_id);
  const issueInputs: Array<Omit<BuiltDiagnosticIssue, "id" | "issueSha256">> = [];
  const removablePatch = (moduleKey: string, moduleId: string): PackagePatchOperation[] =>
    moduleId === rootModuleId ? [] : [{ op: "remove_module", moduleKey }];

  const guidanceDiagnosticCodes: Record<string, { code: string; severity: "error" | "warning" | "info" }> = {
    "archive.source.registered": { code: "SOURCE_REGISTER_MISSING", severity: "warning" },
    "archive.graph.decomposed": { code: "ARCHIVE_GRAPH_DECOMPOSITION_MISSING", severity: "warning" },
    "archive.graph.ordered": { code: "ARCHIVE_GRAPH_ORDER_MISSING", severity: "warning" },
    "archive.module.provenance": { code: "MODULE_PROVENANCE_MISSING", severity: "warning" },
    "triage.declaration.present": { code: "ARCHIVE_CONTRACT_MISSING", severity: "info" },
    "triage.profile.human_decision": { code: "PROFILE_DECISION_MISSING", severity: "info" },
  };
  for (const check of guidanceChecklist.checks) {
    const mapped = guidanceDiagnosticCodes[check.id];
    if (!mapped || check.status === "passed" || check.status === "not_applicable") continue;
    issueInputs.push({
      moduleId: null, nodeId: null, edgeId: null,
      code: mapped.code, severity: mapped.severity, title: check.title,
      message: check.instruction,
      evidence: [`checkId=${check.id}`, `checkStatus=${check.status}`, `checklistSha256=${guidanceChecklist.checklistSha256}`],
      suggestedPatch: [],
    });
  }

  const contentOwnerBySha = new Map<string, { moduleId: string; moduleKey: string }>();
  for (const moduleItem of document.modules) {
    const node = nodesByModule.get(moduleItem.id);
    if (!node) continue;
    const revision = revisionsById.get(node.moduleRevisionId);
    const contentSha256 = String(revision?.contentSha256 ?? "");
    const isEmpty = moduleItem.contentFormat === "json"
      ? Object.keys(moduleItem.content ?? {}).length === 0
      : !(moduleItem.contentText ?? "").trim();
    if (isEmpty) {
      issueInputs.push({
        moduleId: moduleItem.id, nodeId: node.id, edgeId: null,
        code: "EMPTY_MODULE_CONTENT", severity: "warning", title: "模块内容为空",
        message: `模块「${moduleItem.title}」尚未包含可交付内容。`,
        evidence: [`moduleKey=${moduleItem.key}`, `moduleRevisionId=${node.moduleRevisionId}`],
        suggestedPatch: removablePatch(moduleItem.key, moduleItem.id),
      });
    }
    const sourceSensitive = /claim|evidence|quote|fact|citation|论点|证据|引用|事实/i.test(moduleItem.kind);
    const refs = Array.isArray(revision?.refs) ? revision.refs as JsonObject[] : [];
    if (sourceSensitive && !refs.some((ref) => ref.refKind === "source")) {
      issueInputs.push({
        moduleId: moduleItem.id, nodeId: node.id, edgeId: null,
        code: "MODULE_WITHOUT_SOURCE", severity: "info", title: "论证模块缺少来源绑定",
        message: `模块「${moduleItem.title}」承担论证或证据职责，但当前 ModuleRevision 没有 SourceRef。`,
        evidence: [`moduleKind=${moduleItem.kind}`, `moduleRevisionId=${node.moduleRevisionId}`], suggestedPatch: [],
      });
    }
    if (contentSha256 && !isEmpty) {
      const previous = contentOwnerBySha.get(contentSha256);
      if (previous) {
        issueInputs.push({
          moduleId: moduleItem.id, nodeId: node.id, edgeId: null,
          code: "DUPLICATE_MODULE_CONTENT", severity: "warning", title: "模块内容重复",
          message: `模块「${moduleItem.title}」与 ${previous.moduleKey} 的内容摘要相同。`,
          evidence: [`contentSha256=${contentSha256}`, `duplicateOf=${previous.moduleKey}`],
          suggestedPatch: removablePatch(moduleItem.key, moduleItem.id),
        });
      } else contentOwnerBySha.set(contentSha256, { moduleId: moduleItem.id, moduleKey: moduleItem.key });
    }
  }

  const undirected = new Map<string, Set<string>>(detail.nodes.map((node) => [node.id, new Set<string>()]));
  const directed = new Map<string, Array<{ target: string; edgeId: string; edgeKey: string }>>(
    detail.nodes.map((node) => [node.id, []]),
  );
  const orderedNodes = [...detail.nodes].sort((left, right) => left.slot.localeCompare(right.slot) || left.ordinal - right.ordinal);
  for (let index = 1; index < orderedNodes.length; index += 1) {
    const previous = orderedNodes[index - 1];
    const current = orderedNodes[index];
    if (previous.slot !== current.slot) continue;
    undirected.get(previous.id)?.add(current.id);
    undirected.get(current.id)?.add(previous.id);
  }
  for (const edge of detail.edges) {
    undirected.get(edge.sourceNodeId)?.add(edge.targetNodeId);
    undirected.get(edge.targetNodeId)?.add(edge.sourceNodeId);
    if (STRUCTURAL_EDGE_RELATIONS.has(edge.relationType)) {
      directed.get(edge.sourceNodeId)?.push({ target: edge.targetNodeId, edgeId: edge.id, edgeKey: edge.edgeKey });
    }
  }
  const rootNode = detail.nodes.find((node) => node.moduleId === rootModuleId);
  if (rootNode) {
    const visited = new Set<string>([rootNode.id]);
    const queue = [rootNode.id];
    while (queue.length) {
      const current = queue.shift()!;
      for (const next of undirected.get(current) ?? []) {
        if (!visited.has(next)) { visited.add(next); queue.push(next); }
      }
    }
    for (const node of detail.nodes) {
      if (visited.has(node.id)) continue;
      const moduleItem = document.modules.find((candidate) => candidate.id === node.moduleId);
      issueInputs.push({
        moduleId: node.moduleId, nodeId: node.id, edgeId: null,
        code: "DISCONNECTED_MODULE", severity: "warning", title: "模块未连接到主结构",
        message: `模块「${moduleItem?.title ?? node.nodeKey}」无法从根模块沿图结构到达。`,
        evidence: [`nodeKey=${node.nodeKey}`, `rootModuleId=${rootModuleId}`],
        suggestedPatch: removablePatch(node.nodeKey, node.moduleId),
      });
    }
  }
  const colors = new Map<string, 0 | 1 | 2>();
  const cycleEdges = new Set<string>();
  const visit = (nodeId: string) => {
    colors.set(nodeId, 1);
    for (const link of directed.get(nodeId) ?? []) {
      if ((colors.get(link.target) ?? 0) === 0) visit(link.target);
      else if (colors.get(link.target) === 1) cycleEdges.add(link.edgeId);
    }
    colors.set(nodeId, 2);
  };
  for (const node of detail.nodes) if ((colors.get(node.id) ?? 0) === 0) visit(node.id);
  for (const edgeId of cycleEdges) {
    const edge = detail.edges.find((candidate) => candidate.id === edgeId);
    if (!edge) continue;
    issueInputs.push({
      moduleId: nodeById.get(edge.sourceNodeId)?.moduleId ?? null, nodeId: edge.sourceNodeId, edgeId,
      code: "DIRECTED_CYCLE", severity: "error", title: "模块图包含有向环",
      message: `Edge「${edge.edgeKey}」形成有向环，可能导致线性构建或阅读顺序无法收敛。`,
      evidence: [`edgeKey=${edge.edgeKey}`, `relationType=${edge.relationType}`],
      suggestedPatch: [{ op: "remove_edge", edgeKey: edge.edgeKey }],
    });
  }
  const issues: BuiltDiagnosticIssue[] = await Promise.all(issueInputs.map(async (issue) => ({
    ...issue, id: `diagnostic-issue-${crypto.randomUUID()}`,
    issueSha256: await sha256Text(canonicalJson({
      branchId: selected.branchId, baseRevisionId, compositionSha256: expectedCompositionSha256,
      code: issue.code, moduleId: issue.moduleId,
      nodeId: issue.nodeId, edgeId: issue.edgeId, evidence: issue.evidence,
    })),
  })));
  const errorCount = issues.filter((issue) => issue.severity === "error").length;
  const warningCount = issues.filter((issue) => issue.severity === "warning").length;
  const result = errorCount > 0 ? "fail" : warningCount > 0 ? "inconclusive" : "pass";
  const summarySha256 = await sha256Text(canonicalJson({
    branchId: selected.branchId, baseRevisionId, baseBranchLockVersion: expectedBranchLockVersion,
    result, issueCount: issues.length, errorCount, warningCount,
    issues: issues.map((issue) => ({ code: issue.code, severity: issue.severity, issueSha256: issue.issueSha256 })),
  }));
  const diagnosisRunId = `diagnosis-${crypto.randomUUID()}`;
  const now = isoNow();
  const statements = [
    db.prepare(`INSERT INTO package_diagnosis_runs
      (id, package_id, branch_id, base_revision_id, base_branch_lock_version,
       composition_id, composition_sha256, algorithm_version, result,
       issue_count, error_count, warning_count, input_sha256, summary_sha256, created_at)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE EXISTS (SELECT 1 FROM package_branch_states WHERE package_id = ? AND branch_id = ?
        AND lock_version = ? AND status = 'active')
        AND EXISTS (SELECT 1 FROM package_branch_composition_commits WHERE id = ? AND package_id = ?
          AND branch_id = ? AND composition_id = ? AND article_revision_id = ?)`)
      .bind(
        diagnosisRunId, ownerPackageId, selected.branchId, baseRevisionId, expectedBranchLockVersion,
        compositionId, expectedCompositionSha256,
        DIAGNOSTIC_ALGORITHM_VERSION, result, issues.length, errorCount, warningCount,
        diagnosticInputSha256, summarySha256, now,
        ownerPackageId, selected.branchId, expectedBranchLockVersion,
        branchCommit.id, ownerPackageId, selected.branchId, compositionId, baseRevisionId,
      ),
    ...issues.map((issue) => db.prepare(`INSERT INTO package_diagnostic_issues
      (id, diagnosis_run_id, package_id, branch_id, composition_id, module_id, node_id, edge_id,
       code, severity, title, message, evidence_json, suggested_patch_json, issue_sha256, created_at)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE EXISTS (SELECT 1 FROM package_diagnosis_runs WHERE id = ? AND package_id = ?
        AND branch_id = ? AND base_revision_id = ? AND base_branch_lock_version = ?
        AND composition_id = ? AND input_sha256 = ?)`)
      .bind(
        issue.id, diagnosisRunId, ownerPackageId, selected.branchId, compositionId,
        issue.moduleId, issue.nodeId, issue.edgeId,
        issue.code, issue.severity, issue.title, issue.message, canonicalJson(issue.evidence),
        canonicalJson(issue.suggestedPatch), issue.issueSha256, now,
        diagnosisRunId, ownerPackageId, selected.branchId, baseRevisionId,
        expectedBranchLockVersion, compositionId, diagnosticInputSha256,
      )),
    appendEventStatement(db, {
      eventType: "package.branch_diagnostics_completed", subjectType: "package_diagnosis_run", subjectId: diagnosisRunId,
      articleId: String(root.article_id), payload: {
        packageId: ownerPackageId, branchId: selected.branchId, baseRevisionId,
        baseBranchLockVersion: expectedBranchLockVersion, compositionId, result, issueCount: issues.length,
        patchProposalCreated: false, packageMainAdvanced: false, branchAdvanced: false,
      }, inputSha256, createdAt: now,
    }),
  ];
  let results: D1Mutation[];
  try { results = await db.batch(statements); } catch (error) {
    const raced = await db.prepare(`SELECT * FROM package_diagnosis_runs
      WHERE package_id = ? AND branch_id = ? AND input_sha256 = ? LIMIT 1`)
      .bind(ownerPackageId, selected.branchId, diagnosticInputSha256).first<D1Row>();
    if (raced) {
      const racedIssues = await db.prepare("SELECT * FROM package_diagnostic_issues WHERE diagnosis_run_id = ? ORDER BY severity ASC, code ASC LIMIT 100")
        .bind(raced.id).all<D1Row>();
      return {
        data: {
          diagnosisRun: parseDiagnosisRunRow(raced), issues: racedIssues.results.map(parseIssueRow), reused: true,
          boundary: { diagnosticsOnly: true, patchProposalCreated: false, packageMainAdvanced: false, compositionCreated: false },
        },
      };
    }
    throw error;
  }
  assertAllChanged(results, "DIAGNOSTIC_WRITE_INCOMPLETE", "诊断运行或 Issue 未完整写入");
  const run = await db.prepare("SELECT * FROM package_diagnosis_runs WHERE id = ?").bind(diagnosisRunId).first<D1Row>();
  const storedIssues = await db.prepare("SELECT * FROM package_diagnostic_issues WHERE diagnosis_run_id = ? ORDER BY severity ASC, code ASC LIMIT 100")
    .bind(diagnosisRunId).all<D1Row>();
  return {
    status: 201,
    data: {
      diagnosisRun: parseDiagnosisRunRow(run!), issues: storedIssues.results.map(parseIssueRow), reused: false,
      boundary: { diagnosticsOnly: true, patchProposalCreated: false, packageMainAdvanced: false, compositionCreated: false },
    },
  };
}

function requiredQuery(url: URL, name: string) {
  return requiredText(url.searchParams.get(name), name, 160);
}

function countFrom(result: D1Result<unknown>) {
  const row = result.results[0] as D1Row | undefined;
  return Number(row?.count ?? 0);
}

function parseAssetRow(row: D1Row) {
  return {
    id: String(row.id), packageId: String(row.package_id), key: String(row.asset_key), kind: String(row.kind),
    title: String(row.title), contentRef: String(row.content_ref), mediaType: String(row.media_type),
    sha256: String(row.sha256), sizeBytes: Number(row.size_bytes), metadata: parseJson<JsonObject>(row.metadata_json, {}),
    rights: parseJson<JsonObject>(row.rights_json, {}), createdAt: String(row.created_at),
  };
}

function parseSourceRow(row: D1Row) {
  return {
    id: String(row.id), packageId: String(row.package_id), key: String(row.source_key), sourceKind: String(row.source_kind),
    canonicalRef: String(row.canonical_ref), title: String(row.title), capturedAt: row.captured_at === null ? null : String(row.captured_at),
    contentSha256: row.content_sha256 === null ? null : String(row.content_sha256), excerpt: String(row.excerpt).slice(0, 2_000),
    metadata: parseJson<JsonObject>(row.metadata_json, {}), rights: parseJson<JsonObject>(row.rights_json, {}),
    refSha256: String(row.ref_sha256), createdAt: String(row.created_at),
  };
}

async function packageBranchEntries(db: D1Database, root: D1Row, limit = MAX_LIST_LIMIT) {
  const result = await db.prepare(`SELECT branch.id AS branch_id, branch.name, branch.slug,
      branch.status AS article_status, branch.head_revision_id, revision.body_sha256 AS head_body_sha256,
      article_copy.dirty AS article_working_dirty, article_copy.lock_version AS article_working_lock_version,
      state.package_id AS state_package_id, state.head_composition_id, state.head_composition_sha256,
      state.head_revision_id AS state_head_revision_id, state.status AS state_status,
      state.lock_version AS state_lock_version, state.created_at AS state_created_at, state.updated_at AS state_updated_at,
      package_copy.base_composition_id, package_copy.base_revision_id,
      package_copy.document_sha256, package_copy.dirty AS package_dirty,
      package_copy.lock_version AS package_working_lock_version, package_copy.updated_at AS package_working_updated_at
    FROM article_branches branch
    JOIN article_revisions revision ON revision.id = branch.head_revision_id AND revision.branch_id = branch.id
    JOIN branch_working_copies article_copy ON article_copy.branch_id = branch.id AND article_copy.article_id = branch.article_id
    LEFT JOIN package_branch_states state ON state.package_id = ? AND state.branch_id = branch.id
    LEFT JOIN package_branch_working_copies package_copy
      ON package_copy.package_id = state.package_id AND package_copy.branch_id = state.branch_id
    WHERE branch.article_id = ?
    ORDER BY CASE WHEN branch.id = ? THEN 0 ELSE 1 END, branch.updated_at DESC, branch.id ASC LIMIT ?`)
    .bind(root.id, root.article_id, root.primary_branch_id, limit).all<D1Row>();
  return result.results.map((row) => ({
    branchId: String(row.branch_id), name: String(row.name), slug: String(row.slug),
    articleStatus: String(row.article_status), headRevisionId: String(row.head_revision_id),
    headBodySha256: String(row.head_body_sha256), articleWorkingDirty: Number(row.article_working_dirty) === 1,
    articleWorkingLockVersion: Number(row.article_working_lock_version), attached: row.state_package_id !== null,
    branchState: row.state_package_id === null ? null : {
      packageId: String(row.state_package_id), branchId: String(row.branch_id),
      headCompositionId: String(row.head_composition_id), headCompositionSha256: String(row.head_composition_sha256),
      headRevisionId: String(row.state_head_revision_id), status: String(row.state_status),
      lockVersion: Number(row.state_lock_version), createdAt: String(row.state_created_at), updatedAt: String(row.state_updated_at),
    },
    packageWorking: row.state_package_id === null || row.base_composition_id === null ? null : {
      packageId: String(row.state_package_id), branchId: String(row.branch_id),
      baseCompositionId: String(row.base_composition_id), baseRevisionId: String(row.base_revision_id),
      documentSha256: String(row.document_sha256), dirty: Number(row.package_dirty) === 1,
      lockVersion: Number(row.package_working_lock_version), updatedAt: String(row.package_working_updated_at),
    },
  }));
}

async function getManifest() {
  return {
    apiVersion: API_VERSION,
    envelope: {
      success: { ok: true, requestId: "req-...", data: {} },
      failure: { ok: false, requestId: "req-...", error: { code: "...", message: "...", details: {} } },
    },
    writeAuthentication: {
      scheme: "wenmai-management-session-v1",
      canonicalOrigin: "http://[::1]:3000",
      sameOrigin: true,
      httpOnlyCookie: true,
      browserBindingHeader: "X-Wenmai-Browser-Binding",
      browserBindingStorage: "raw 256-bit secret in exact-origin localStorage; SHA-256 only on server",
      csrfHeader: "X-Wenmai-CSRF",
      legacyIntentHeader: "X-Wenmai-Write: 1 (intent marker only; never authorization)",
      commandReceiptRequired: true,
    },
    limits: {
      maxRequestBytes: MAX_REQUEST_BYTES, maxDocumentBytes: MAX_DOCUMENT_BYTES, maxModules: MAX_MODULES, maxEdges: MAX_EDGES,
      maxResourcesPerKind: MAX_RESOURCES, maxRefsPerModule: MAX_REFS_PER_MODULE, maxTotalRefs: MAX_TOTAL_REFS,
      maxPatchOperations: MAX_PATCH_OPERATIONS, maxListLimit: MAX_LIST_LIMIT,
    },
    getViews: [...VIEWS],
    postActions: {
      ensure_from_revision: ["articleId", "revisionId", "expectedBodySha256", "branchId?", "projectId?", "title?"],
      create_from_text: ["articleId", "projectId?", "title", "bodyText", "sourceFingerprintSha256?", "importWorkflow?", "branchId?", "expectedBranchHeadRevisionId?", "expectedBranchHeadBodySha256?"],
      recommend_import_profile: ["name", "format", "title", "text", "sourceFingerprintSha256", "bytes", "headings", "paragraphs", "packageSignals?", "recommendationProvider?"],
      ensure_branch_bridge: ["packageId", "expectedPackageLockVersion", "branchId?", "expectedBranchHeadRevisionId?", "expectedBranchHeadBodySha256?"],
      attach_branch: ["packageId", "branchId", "expectedBranchHeadRevisionId", "expectedBranchHeadBodySha256", "expectedBranchWorkingLockVersion"],
      set_primary_branch: ["packageId", "branchId", "expectedPackageLockVersion", "expectedBranchLockVersion", "expectedHeadCompositionId", "expectedHeadRevisionId"],
      save_working_package: ["packageId", "branchId", "expectedBranchLockVersion", "expectedWorkingLockVersion", "expectedBaseCompositionId", "expectedBaseRevisionId", "document"],
      commit: ["packageId", "branchId", "expectedBranchLockVersion", "expectedWorkingLockVersion", "expectedBaseCompositionId", "expectedBaseRevisionId", "expectedDocumentSha256", "compositionTitle?"],
      register_publication_version: ["packageId", "branchId", "expectedBranchLockVersion", "expectedRevisionId", "expectedBodySha256", "expectedCompositionId", "expectedCompositionSha256", "publicationVersion", "expectedActiveRegistrationId?", "expectedActiveRegistrationLockVersion?"],
      create_slice: ["packageId", "branchId", "baseRevisionId", "expectedBranchLockVersion", "compositionId", "expectedCompositionSha256", "title", "sliceKind", "moduleKeys?", "selector?"],
      create_patch: ["packageId", "branchId", "baseRevisionId", "expectedBranchLockVersion", "baseCompositionId", "expectedBaseCompositionSha256", "title", "summary?", "operations", "evidence?", "diagnosticIssueIds?"],
      decide_patch: ["patchProposalId", "expectedLockVersion", "decision", "note?"],
      apply_patch: ["packageId", "branchId", "patchProposalId", "expectedPatchLockVersion", "expectedBranchLockVersion", "expectedHeadCompositionId", "expectedHeadCompositionSha256", "expectedHeadRevisionId"],
      create_import_candidate: ["packageId", "branchId", "baseRevisionId", "expectedBranchLockVersion", "baseCompositionId", "expectedBaseCompositionSha256", "sourceKind", "sourceRef", "sourceFingerprintSha256", "importerKey", "importerVersion", "document", "title?", "summary?", "evidence?"],
      create_export_manifest: ["packageId", "branchId", "baseRevisionId", "expectedBranchLockVersion", "compositionId", "expectedCompositionSha256", "sliceId?", "expectedSliceSha256?", "exportKind?", "exporterKey?", "exporterVersion?"],
      run_builtin_diagnostics: ["packageId", "branchId", "baseRevisionId", "expectedBranchLockVersion", "compositionId", "expectedCompositionSha256"],
      decide_guidance_profile: ["packageId", "branchId", "expectedChecklistSha256", "expectedPackageLockVersion", "expectedBranchLockVersion", "expectedWorkingLockVersion", "selectedProfile", "decisionNote"],
    },
    documentSchema: {
      schemaVersion: DOCUMENT_SCHEMA_VERSION,
      fields: ["title", "rootModuleKey", "modules", "edges", "assets", "sources", "metadata"],
      moduleFields: ["id?", "key", "kind", "title", "contentFormat?", "contentText?", "content?", "metadata?", "refs?"],
      edgeFields: ["id?", "key", "sourceModuleKey", "targetModuleKey", "relationType", "ordinal?", "condition?"],
    },
    publicationVersionSemanticGate: {
      schemaVersion: ARTICLE_PUBLICATION_SEMANTIC_GATE_SCHEMA_VERSION,
      requiredForNewRegistration: true,
      revalidatedByCreateBuild: true,
      invariantIds: [...ARTICLE_PUBLICATION_SEMANTIC_INVARIANT_IDS],
      leadInvariantIds: ["author_entry", "problem_origin", "first_term_explanation", "reading_route"],
      leadWindowCharacters: ARTICLE_PUBLICATION_SEMANTIC_LEAD_WINDOW_CHARACTERS,
      primaryThesis: "non_empty_hash_bound_exact_quote_in_lead_before_boundaries",
      primaryThesisEvidence: "primaryThesisEvidenceQuote must be exact reader-visible body text in lead before character 800; code verifies structure and position only",
      corePropositionPriority: "core_proposition exact quote must occur before character 800 and no later than either boundary quote",
      evidenceMode: "exact_reader_visible_quote_only",
      independentReaderEvidence: "coordinator_recorded_not_server_identity_authenticated; answers require author_entry, problem_origin, first_term_explanation, reading_route, primary_thesis, boundary_relation",
      platformCanonicalContractBindingRequired: true,
      platformCanonicalPrimaryThesisBindingRequired: true,
      documentation: "governance/article-publication-semantic-gate.md",
    },
    boundaries: {
      workingSaveCreatesComposition: false, diagnosticsCreatePatch: false, importAdvancesMain: false,
      importProfileRecommendationRequiresHumanConfirmation: true, importProfileRecommendationDisclosesBody: false,
      exportCreatesArtifact: false, exportCreatesRelease: false, exportPublishes: false,
      patchRequiresHumanDecision: true, immutableCompositionProjection: true,
      guidanceProfileDecision: "owner-only completed command receipt bound to current Revision, Composition, document and three CAS locks",
      articleBranchIsSoleBranchIdentity: true, packageBranchMode: "article-branch-qualified",
      multiBranchPackageState: true, branchSwitchRequiresExplicitBinding: true,
      publicationVersionIdentity: "immutable Composition metadata + CAS current registry",
      publicationVersionReplacementStalesDependents: true,
    },
    branchBridge: {
      model: "0010-multi-article-branch",
      sourceOfTruth: "ArticleBranch",
      packageState: "package_branch_states + package_branch_working_copies + package_branch_composition_commits",
      compatibilityMirror: "article_project_packages.main_composition_* and package_working_copies mirror only primary_branch_id",
      createBinding: "attach_branch binds an existing clean ArticleBranch without creating or advancing ArticleRevision",
      switching: "each attached ArticleBranch retains an independent Composition head, working copy and CAS lock",
    },
    migrationBoundary: "0010 adds per-ArticleBranch Package state. It preserves a valid dirty 0009 working copy byte-for-byte; broken legacy relations remain read-only with a blocked migration audit and are never guessed. Runtime-bootstrap databases require structural baseline audit before replaying versioned migrations.",
  };
}

async function handleGet(db: D1Database, url: URL) {
  const view = url.searchParams.get("view") || "manifest";
  if (!VIEWS.has(view)) throw new ProjectPackageApiError("UNKNOWN_VIEW", `未知文章工程视图：${view}`, 404);
  const limit = boundedLimit(url);
  if (view === "manifest") return getManifest();
  if (view === "health") {
    const results = await db.batch([
      db.prepare("SELECT COUNT(*) AS count FROM article_project_packages"),
      db.prepare("SELECT COUNT(*) AS count FROM package_compositions"),
      db.prepare("SELECT COUNT(*) AS count FROM package_branch_working_copies WHERE dirty = 1"),
      db.prepare("SELECT COUNT(*) AS count FROM package_patch_proposals WHERE status = 'candidate'"),
      db.prepare("SELECT COUNT(*) AS count FROM package_patch_proposals WHERE status = 'approved'"),
      db.prepare("SELECT COUNT(*) AS count FROM package_diagnostic_issues"),
      db.prepare("SELECT COUNT(*) AS count FROM package_import_runs WHERE state = 'candidate_ready'"),
      db.prepare("SELECT COUNT(*) AS count FROM package_export_runs WHERE state = 'manifest_ready'"),
      db.prepare("SELECT COUNT(*) AS count FROM package_branch_states"),
      db.prepare("SELECT COUNT(*) AS count FROM package_branch_migration_audits WHERE state = 'blocked'"),
    ]);
    return {
      apiVersion: API_VERSION, status: "ok", serverTime: isoNow(),
      counts: {
        packages: countFrom(results[0]), compositions: countFrom(results[1]), dirtyWorkingCopies: countFrom(results[2]),
        candidatePatches: countFrom(results[3]), approvedPatches: countFrom(results[4]), diagnosticIssues: countFrom(results[5]),
        importCandidates: countFrom(results[6]), exportManifests: countFrom(results[7]),
        attachedBranches: countFrom(results[8]), blockedBranchMigrations: countFrom(results[9]),
      },
    };
  }
  if (view === "packages") {
    const articleId = optionalText(url.searchParams.get("articleId"), 160) || null;
    const projectId = optionalText(url.searchParams.get("projectId"), 160) || null;
    const status = optionalText(url.searchParams.get("status"), 20) || null;
    if (status && status !== "active" && status !== "archived") throw new ProjectPackageApiError("INVALID_STATUS", "status 只能是 active 或 archived");
    const rows = await db.prepare(`SELECT * FROM article_project_packages
      WHERE (? IS NULL OR article_id = ?) AND (? IS NULL OR project_id = ?) AND (? IS NULL OR status = ?)
      ORDER BY updated_at DESC, id ASC LIMIT ?`)
      .bind(articleId, articleId, projectId, projectId, status, status, limit).all<D1Row>();
    return { packages: rows.results.map(parsePackageRow), limit };
  }
  if (view === "branches") {
    const ownerPackageId = requiredQuery(url, "packageId");
    const root = await packageRow(db, ownerPackageId);
    const [branches, audit] = await Promise.all([
      packageBranchEntries(db, root, limit),
      migrationAuditRow(db, ownerPackageId),
    ]);
    return {
      package: parsePackageRow(root), primaryBranchId: root.primary_branch_id ? String(root.primary_branch_id) : null,
      branchModel: {
        version: root.branch_model_version === null ? null : Number(root.branch_model_version),
        primaryBranchId: root.primary_branch_id ? String(root.primary_branch_id) : null,
        migrationState: audit ? String(audit.state) : "uninitialized",
        writable: Number(root.branch_model_version) === 2 && audit?.state !== "blocked" && audit?.state !== "legacy_unbound",
      },
      branches, migrationAudit: audit ? parseMigrationAuditRow(audit) : null, limit,
    };
  }
  if (view === "package") {
    const ownerPackageId = requiredQuery(url, "packageId");
    const root = await packageRow(db, ownerPackageId);
    const requestedBranchId = optionalText(url.searchParams.get("branchId"), 160)
      || (root.primary_branch_id ? String(root.primary_branch_id) : "");
    const [branches, audit, packageCounts] = await Promise.all([
      packageBranchEntries(db, root, limit), migrationAuditRow(db, ownerPackageId),
      db.batch([
        db.prepare("SELECT COUNT(*) AS count FROM package_modules WHERE package_id = ?").bind(ownerPackageId),
        db.prepare("SELECT COUNT(*) AS count FROM package_assets WHERE package_id = ?").bind(ownerPackageId),
        db.prepare("SELECT COUNT(*) AS count FROM package_source_refs WHERE package_id = ?").bind(ownerPackageId),
        db.prepare("SELECT COUNT(*) AS count FROM package_branch_states WHERE package_id = ?").bind(ownerPackageId),
      ]),
    ]);
    if (audit?.state === "blocked" || Number(root.branch_model_version) !== 2) {
      const [composition, working] = await Promise.all([
        db.prepare("SELECT * FROM package_compositions WHERE id = ? AND package_id = ? LIMIT 1")
          .bind(root.main_composition_id, ownerPackageId).first<D1Row>(),
        db.prepare("SELECT * FROM package_working_copies WHERE package_id = ? LIMIT 1")
          .bind(ownerPackageId).first<D1Row>(),
      ]);
      const parsedComposition = composition ? parseCompositionRow(composition, true) : null;
      const parsedWorking = working ? parseWorkingRow(working) : null;
      const guidanceChecklist = parsedComposition && parsedWorking
        ? await buildArticleGuidanceChecklist({
          document: parsedWorking.document as PackageDocument,
          packageStatus: String(root.status),
          branchStatus: null,
          workingCopyDirty: parsedWorking.dirty,
          branchBridgeInSync: false,
          bindings: {
            articleId: String(root.article_id), projectId: root.project_id === null ? null : String(root.project_id),
            packageId: ownerPackageId,
            branchId: requestedBranchId || null,
            compositionId: parsedComposition.id,
            compositionSha256: parsedComposition.compositionSha256,
            documentSha256: parsedWorking.documentSha256,
            packageLockVersion: Number(root.lock_version),
            branchLockVersion: null,
            workingCopyLockVersion: parsedWorking.lockVersion,
          },
        })
        : null;
      return {
        package: parsePackageRow(root), branches, selectedBranchId: requestedBranchId || null,
        selectedBranch: branches.find((item) => item.branchId === requestedBranchId) ?? null,
        composition: parsedComposition,
        workingCopy: parsedWorking,
        branchWorkingCopy: null, branchState: null, branchCommit: null, branchBridge: null,
        recentBranchCommits: [], migrationAudit: audit ? parseMigrationAuditRow(audit) : null,
        readOnly: true, guidanceChecklist,
        counts: {
          branch: { openPatches: 0, slices: 0, diagnostics: 0, imports: 0, exports: 0 },
          package: {
            modules: countFrom(packageCounts[0]), assets: countFrom(packageCounts[1]),
            sources: countFrom(packageCounts[2]), attachedBranches: countFrom(packageCounts[3]),
          },
        },
      };
    }
    const selected = await loadSelectedPackageBranch(db, root, requestedBranchId);
    const [recentCommits, branchCounts] = await Promise.all([
      db.prepare(`SELECT * FROM package_branch_composition_commits
        WHERE package_id = ? AND branch_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`)
        .bind(ownerPackageId, selected.branchId, limit).all<D1Row>(),
      db.batch([
        db.prepare("SELECT COUNT(*) AS count FROM package_patch_proposals WHERE package_id = ? AND branch_id = ? AND status IN ('candidate','approved')").bind(ownerPackageId, selected.branchId),
        db.prepare("SELECT COUNT(*) AS count FROM package_slices WHERE package_id = ? AND branch_id = ?").bind(ownerPackageId, selected.branchId),
        db.prepare("SELECT COUNT(*) AS count FROM package_diagnosis_runs WHERE package_id = ? AND branch_id = ?").bind(ownerPackageId, selected.branchId),
        db.prepare("SELECT COUNT(*) AS count FROM package_import_runs WHERE package_id = ? AND branch_id = ?").bind(ownerPackageId, selected.branchId),
        db.prepare("SELECT COUNT(*) AS count FROM package_export_runs WHERE package_id = ? AND branch_id = ?").bind(ownerPackageId, selected.branchId),
      ]),
    ]);
    const checklistBindings = {
      articleId: String(root.article_id), projectId: root.project_id === null ? null : String(root.project_id),
      packageId: ownerPackageId, branchId: selected.branchId,
      revisionId: selected.branchBridge.headRevisionId,
      bodySha256: selected.branchBridge.headBodySha256,
      compositionId: String(selected.composition.id),
      compositionSha256: String(selected.composition.composition_sha256),
      documentSha256: selected.workingCopy.documentSha256,
      packageLockVersion: Number(root.lock_version),
      branchLockVersion: selected.branchState.lockVersion,
      workingCopyLockVersion: selected.workingCopy.lockVersion,
    };
    const checklistInput = {
      document: selected.workingCopy.document as PackageDocument,
      packageStatus: String(root.status),
      branchStatus: selected.branchState.status,
      workingCopyDirty: selected.workingCopy.dirty,
      branchBridgeInSync: selected.branchBridge.inSync,
      bindings: checklistBindings,
    };
    const baselineChecklist = await buildArticleGuidanceChecklist(checklistInput);
    const verifiedDecision = await loadLatestVerifiedArticleGuidanceDecision(db, {
      ...checklistBindings,
      baselineChecklistSha256: baselineChecklist.checklistSha256,
    });
    const guidanceChecklist = verifiedDecision
      ? await buildArticleGuidanceChecklist({ ...checklistInput, verifiedDecision })
      : baselineChecklist;
    return {
      package: parsePackageRow(root), branches, selectedBranchId: selected.branchId,
      selectedBranch: branches.find((item) => item.branchId === selected.branchId) ?? null,
      composition: parseCompositionRow(selected.composition, true),
      workingCopy: selected.workingCopy, branchWorkingCopy: selected.workingCopy,
      branchState: selected.branchState, branchCommit: selected.branchCommit, branchBridge: selected.branchBridge,
      recentBranchCommits: recentCommits.results.map(parseBranchCommitRow),
      migrationAudit: audit ? parseMigrationAuditRow(audit) : null, readOnly: false, guidanceChecklist,
      counts: {
        branch: {
          openPatches: countFrom(branchCounts[0]), slices: countFrom(branchCounts[1]), diagnostics: countFrom(branchCounts[2]),
          imports: countFrom(branchCounts[3]), exports: countFrom(branchCounts[4]),
        },
        package: {
          modules: countFrom(packageCounts[0]), assets: countFrom(packageCounts[1]),
          sources: countFrom(packageCounts[2]), attachedBranches: countFrom(packageCounts[3]),
        },
      },
    };
  }
  if (view === "composition") {
    const compositionId = requiredQuery(url, "compositionId");
    const expectedPackageId = optionalText(url.searchParams.get("packageId"), 160) || undefined;
    const detail = await loadCompositionDetail(db, compositionId, expectedPackageId);
    const materializations = await db.prepare(`SELECT * FROM package_composition_materializations
      WHERE composition_id = ? ORDER BY created_at DESC LIMIT ?`).bind(compositionId, limit).all<D1Row>();
    return {
      composition: detail.composition, nodes: detail.nodes, edges: detail.edges,
      moduleRevisions: detail.moduleRevisions,
      materializations: materializations.results.map(parseMaterializationRow),
    };
  }
  if (view === "module") {
    const moduleId = requiredQuery(url, "moduleId");
    const row = await db.prepare("SELECT * FROM package_modules WHERE id = ? LIMIT 1").bind(moduleId).first<D1Row>();
    if (!row) throw new ProjectPackageApiError("MODULE_NOT_FOUND", "Module 不存在", 404);
    const requestedRevisionId = optionalText(url.searchParams.get("revisionId"), 160) || null;
    const revisions = await db.prepare("SELECT * FROM package_module_revisions WHERE module_id = ? ORDER BY created_at DESC, id DESC LIMIT ?")
      .bind(moduleId, limit).all<D1Row>();
    let selected: D1Row | null = null;
    if (requestedRevisionId) {
      selected = await db.prepare("SELECT * FROM package_module_revisions WHERE id = ? AND module_id = ? LIMIT 1")
        .bind(requestedRevisionId, moduleId).first<D1Row>();
      if (!selected) throw new ProjectPackageApiError("MODULE_REVISION_NOT_FOUND", "ModuleRevision 不存在", 404);
    } else selected = revisions.results[0] ?? null;
    return {
      module: parseModuleRow(row), revisions: revisions.results.map((revision) => parseModuleRevisionRow(revision)),
      selectedRevision: selected ? parseModuleRevisionRow(selected, true) : null,
    };
  }
  if (view === "working") {
    const ownerPackageId = requiredQuery(url, "packageId");
    const root = await packageRow(db, ownerPackageId);
    const audit = await migrationAuditRow(db, ownerPackageId);
    const requestedBranchId = optionalText(url.searchParams.get("branchId"), 160)
      || (root.primary_branch_id ? String(root.primary_branch_id) : "");
    if (audit?.state === "blocked" || Number(root.branch_model_version) !== 2) {
      const working = await db.prepare("SELECT * FROM package_working_copies WHERE package_id = ? LIMIT 1")
        .bind(ownerPackageId).first<D1Row>();
      return {
        package: parsePackageRow(root), selectedBranchId: requestedBranchId || null,
        workingCopy: working ? parseWorkingRow(working) : null,
        branchWorkingCopy: null, branchState: null, branchBridge: null,
        migrationAudit: audit ? parseMigrationAuditRow(audit) : null, readOnly: true,
      };
    }
    const selected = await loadSelectedPackageBranch(db, root, requestedBranchId);
    return {
      package: parsePackageRow(root), selectedBranchId: selected.branchId,
      workingCopy: selected.workingCopy, branchWorkingCopy: selected.workingCopy,
      branchState: selected.branchState, branchCommit: selected.branchCommit,
      branchBridge: selected.branchBridge, migrationAudit: audit ? parseMigrationAuditRow(audit) : null, readOnly: false,
    };
  }
  if (view === "branch_bridge") {
    const ownerPackageId = requiredQuery(url, "packageId");
    const root = await packageRow(db, ownerPackageId);
    const audit = await migrationAuditRow(db, ownerPackageId);
    const requestedBranchId = optionalText(url.searchParams.get("branchId"), 160)
      || (root.primary_branch_id ? String(root.primary_branch_id) : "");
    if (audit?.state === "blocked" || Number(root.branch_model_version) !== 2) {
      return {
        package: parsePackageRow(root), selectedBranchId: requestedBranchId || null,
        branchState: null, branchBridge: null, bridged: false,
        migrationAudit: audit ? parseMigrationAuditRow(audit) : null, readOnly: true,
      };
    }
    const selected = await loadSelectedPackageBranch(db, root, requestedBranchId);
    return {
      package: parsePackageRow(root), selectedBranchId: selected.branchId,
      branchState: selected.branchState, branchBridge: selected.branchBridge,
      branchCommit: selected.branchCommit, bridged: true,
      migrationAudit: audit ? parseMigrationAuditRow(audit) : null, readOnly: false,
    };
  }
  if (view === "publication_versions") {
    const ownerPackageId = requiredQuery(url, "packageId");
    return publicationVersionSnapshot(db, ownerPackageId);
  }
  if (view === "resources") {
    const ownerPackageId = requiredQuery(url, "packageId");
    await packageRow(db, ownerPackageId);
    const [assets, sources] = await Promise.all([
      db.prepare("SELECT * FROM package_assets WHERE package_id = ? ORDER BY created_at DESC, id DESC LIMIT ?")
        .bind(ownerPackageId, limit).all<D1Row>(),
      db.prepare("SELECT * FROM package_source_refs WHERE package_id = ? ORDER BY created_at DESC, id DESC LIMIT ?")
        .bind(ownerPackageId, limit).all<D1Row>(),
    ]);
    return { assets: assets.results.map(parseAssetRow), sources: sources.results.map(parseSourceRow), limit };
  }
  if (view === "slices") {
    const ownerPackageId = requiredQuery(url, "packageId");
    const branchId = requiredQuery(url, "branchId");
    const sliceId = optionalText(url.searchParams.get("sliceId"), 160) || null;
    if (sliceId) {
      const row = await db.prepare(`SELECT * FROM package_slices
        WHERE id = ? AND package_id = ? AND branch_id = ? LIMIT 1`)
        .bind(sliceId, ownerPackageId, branchId).first<D1Row>();
      if (!row) throw new ProjectPackageApiError("SLICE_NOT_FOUND", "Slice 不存在", 404);
      return { slice: parseSliceRow(row, true) };
    }
    const rows = await db.prepare(`SELECT * FROM package_slices
      WHERE package_id = ? AND branch_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`)
      .bind(ownerPackageId, branchId, limit).all<D1Row>();
    return { slices: rows.results.map((row) => parseSliceRow(row)), limit };
  }
  if (view === "patches") {
    const ownerPackageId = requiredQuery(url, "packageId");
    const branchId = requiredQuery(url, "branchId");
    const patchProposalId = optionalText(url.searchParams.get("patchProposalId"), 160) || null;
    if (patchProposalId) {
      const row = await db.prepare(`SELECT * FROM package_patch_proposals
        WHERE id = ? AND package_id = ? AND branch_id = ? LIMIT 1`)
        .bind(patchProposalId, ownerPackageId, branchId).first<D1Row>();
      if (!row) throw new ProjectPackageApiError("PATCH_NOT_FOUND", "PatchProposal 不存在", 404);
      return { patchProposal: parsePatchRow(row, true) };
    }
    const status = optionalText(url.searchParams.get("status"), 20) || null;
    if (status && !["candidate", "approved", "rejected", "applied", "stale", "cancelled"].includes(status)) {
      throw new ProjectPackageApiError("INVALID_PATCH_STATUS", "Patch status 无效");
    }
    const rows = await db.prepare(`SELECT * FROM package_patch_proposals
      WHERE package_id = ? AND branch_id = ? AND (? IS NULL OR status = ?)
      ORDER BY created_at DESC, id DESC LIMIT ?`)
      .bind(ownerPackageId, branchId, status, status, limit).all<D1Row>();
    return { patchProposals: rows.results.map((row) => parsePatchRow(row)), limit };
  }
  if (view === "diagnostics") {
    const ownerPackageId = requiredQuery(url, "packageId");
    const branchId = requiredQuery(url, "branchId");
    const diagnosisRunId = optionalText(url.searchParams.get("diagnosisRunId"), 160) || null;
    if (diagnosisRunId) {
      const run = await db.prepare(`SELECT * FROM package_diagnosis_runs
        WHERE id = ? AND package_id = ? AND branch_id = ? LIMIT 1`)
        .bind(diagnosisRunId, ownerPackageId, branchId).first<D1Row>();
      if (!run) throw new ProjectPackageApiError("DIAGNOSIS_RUN_NOT_FOUND", "DiagnosisRun 不存在", 404);
      const issues = await db.prepare(`SELECT * FROM package_diagnostic_issues
        WHERE diagnosis_run_id = ? AND package_id = ? AND branch_id = ?
        ORDER BY severity ASC, code ASC LIMIT ?`)
        .bind(diagnosisRunId, ownerPackageId, branchId, limit).all<D1Row>();
      return { diagnosisRun: parseDiagnosisRunRow(run), issues: issues.results.map(parseIssueRow), limit };
    }
    const compositionId = optionalText(url.searchParams.get("compositionId"), 160) || null;
    const [runs, issues] = await Promise.all([
      db.prepare(`SELECT * FROM package_diagnosis_runs
        WHERE package_id = ? AND branch_id = ? AND (? IS NULL OR composition_id = ?)
        ORDER BY created_at DESC, id DESC LIMIT ?`)
        .bind(ownerPackageId, branchId, compositionId, compositionId, limit).all<D1Row>(),
      db.prepare(`SELECT * FROM package_diagnostic_issues
        WHERE package_id = ? AND branch_id = ? AND (? IS NULL OR composition_id = ?)
        ORDER BY created_at DESC, id DESC LIMIT ?`)
        .bind(ownerPackageId, branchId, compositionId, compositionId, limit).all<D1Row>(),
    ]);
    return { diagnosisRuns: runs.results.map(parseDiagnosisRunRow), issues: issues.results.map(parseIssueRow), limit };
  }
  if (view === "imports") {
    const ownerPackageId = requiredQuery(url, "packageId");
    const branchId = requiredQuery(url, "branchId");
    const importRunId = optionalText(url.searchParams.get("importRunId"), 160) || null;
    if (importRunId) {
      const row = await db.prepare(`SELECT * FROM package_import_runs
        WHERE id = ? AND package_id = ? AND branch_id = ? LIMIT 1`)
        .bind(importRunId, ownerPackageId, branchId).first<D1Row>();
      if (!row) throw new ProjectPackageApiError("IMPORT_RUN_NOT_FOUND", "ImportRun 不存在", 404);
      return { importRun: parseImportRow(row, true) };
    }
    const rows = await db.prepare(`SELECT * FROM package_import_runs
      WHERE package_id = ? AND branch_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`)
      .bind(ownerPackageId, branchId, limit).all<D1Row>();
    return { importRuns: rows.results.map((row) => parseImportRow(row)), limit };
  }
  if (view === "exports") {
    const ownerPackageId = requiredQuery(url, "packageId");
    const branchId = requiredQuery(url, "branchId");
    const exportRunId = optionalText(url.searchParams.get("exportRunId"), 160) || null;
    if (exportRunId) {
      const row = await db.prepare(`SELECT * FROM package_export_runs
        WHERE id = ? AND package_id = ? AND branch_id = ? LIMIT 1`)
        .bind(exportRunId, ownerPackageId, branchId).first<D1Row>();
      if (!row) throw new ProjectPackageApiError("EXPORT_RUN_NOT_FOUND", "ExportRun 不存在", 404);
      return { exportRun: parseExportRow(row, true) };
    }
    const rows = await db.prepare(`SELECT * FROM package_export_runs
      WHERE package_id = ? AND branch_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`)
      .bind(ownerPackageId, branchId, limit).all<D1Row>();
    return { exportRuns: rows.results.map((row) => parseExportRow(row)), limit };
  }
  throw new ProjectPackageApiError("UNKNOWN_VIEW", `未知文章工程视图：${view}`, 404);
}

export async function GET(request: Request) {
  const id = requestId();
  try {
    await requireManagementSession(request, { scope: "management.read" });
    assertReadable(request);
    const db = await ensureProjectPackageSchema();
    const data = await handleGet(db, new URL(request.url));
    return jsonSuccess(id, data);
  } catch (error) {
    return jsonError(id, error);
  }
}

export async function POST(request: Request) {
  const id = requestId();
  try {
    const { action, commandId: suppliedCommandId, payload } = await parseMutationBody(request);
    const privilegedAction = PRIVILEGED_PACKAGE_ACTIONS[action as keyof typeof PRIVILEGED_PACKAGE_ACTIONS];
    // An Agent action requires both this route's concrete handler map and a
    // matching, snapshot-addressable catalog entry. package.write remains an
    // owner management scope and is never used as an Agent authorization.
    const agentAuthorization = agentActionAuthorization("project-package", action);
    const agentRequest = request.headers.has("authorization");
    let actorId: string;
    let commandId: string;
    let db: D1Database;
    let principal: ControlPrincipal | null = null;
    if (privilegedAction) {
      if (agentRequest && !agentAuthorization) {
        throw new ProjectPackageApiError(
          "AMBIGUOUS_AUTH_FORBIDDEN",
          "owner-only 文章工程动作不能携带 Agent Bearer Key",
          403,
        );
      }
      principal = await requireManagementOrPrivilegedAgent(request, database(), {
        managementScope: privilegedAction.managementScope,
        agentScope: agentAuthorization?.scope ?? "__owner_only__",
        agentActionId: agentAuthorization?.actionId,
        localOnly: agentAuthorization?.localOnly ?? true,
        allowedRoles: agentAuthorization?.allowedRoles ?? [],
      });
      commandId = requiredText(suppliedCommandId, "commandId", 160);
      if (!ID_RE.test(commandId)) throw new ProjectPackageApiError("INVALID_COMMAND_ID", "commandId 只能包含字母、数字、点、下划线、冒号或短横线");
      db = await ensureProjectPackageSchema();
      // Do not resolve package, branch or proposal IDs until the complete
      // privileged credential contract has accepted this request.
      const articleId = await resolvePrivilegedPackageArticle(db, action, payload);
      assertPrivilegedPackageArticleBoundary(principal, articleId);
      if (principal.kind === "management") assertManagementWrite(request);
      actorId = principal.actorId;
    } else {
      if (request.headers.has("authorization")) {
        throw new ProjectPackageApiError(
          "AMBIGUOUS_AUTH_FORBIDDEN",
          "owner-only 文章工程动作不能携带 Agent Bearer Key",
          403,
        );
      }
      const managementPrincipal = await requireManagementSession(request, { mutation: true, scope: "package.write" });
      assertManagementWrite(request);
      actorId = managementActorId(managementPrincipal);
      commandId = requiredText(suppliedCommandId, "commandId", 160);
      if (!ID_RE.test(commandId)) throw new ProjectPackageApiError("INVALID_COMMAND_ID", "commandId 只能包含字母、数字、点、下划线、冒号或短横线");
      db = await ensureProjectPackageSchema();
    }
    const result = await withReceipt(db, action, actorId, commandId, payload, async (inputSha256) => {
      if (action === "ensure_from_revision") return ensureFromRevision(db, payload, inputSha256);
      if (action === "create_from_text") return createFromText(db, payload, inputSha256);
      if (action === "ensure_branch_bridge") return ensureBranchBridge(db, payload, inputSha256);
      if (action === "attach_branch") return attachBranchToPackage(db, payload, inputSha256);
      if (action === "set_primary_branch") return setPrimaryPackageBranch(db, payload, inputSha256);
      if (action === "save_working_package") return saveWorkingPackage(db, payload, inputSha256);
      if (action === "commit") return commitWorkingPackage(db, payload, inputSha256, agentRequest ? "agent" : "user");
      if (action === "register_publication_version") return registerPublicationVersion(db, payload, inputSha256);
      if (action === "create_slice") return createSlice(db, payload, inputSha256);
      if (action === "create_patch") return createPatchProposal(db, payload, inputSha256);
      if (action === "decide_patch") return decidePatchProposal(db, payload, inputSha256, principal!);
      if (action === "apply_patch") return applyPatchProposal(db, payload, inputSha256, principal!);
      if (action === "recommend_import_profile") return recommendImportProfile(payload, inputSha256);
      if (action === "create_import_candidate") return createImportCandidate(db, payload, inputSha256);
      if (action === "create_export_manifest") return createExportManifest(db, payload, inputSha256);
      if (action === "run_builtin_diagnostics") return runBuiltinDiagnostics(db, payload, inputSha256);
      if (action === "decide_guidance_profile") return decideGuidanceProfile(db, payload, inputSha256, commandId, actorId);
      throw new ProjectPackageApiError("UNKNOWN_ACTION", `未知文章工程动作：${action}`, 404);
    });
    return jsonSuccess(id, result.data, result.status);
  } catch (error) {
    return jsonError(id, error);
  }
}
