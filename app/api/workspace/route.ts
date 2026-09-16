import { env } from "cloudflare:workers";
import corpusData from "../../../data/corpus.generated.json";
import versionTextData from "../../../data/version-text.generated.json";
import { FACTORY_RECIPES } from "../../factory-recipes";
import {
  INFORMATION_COVER_CAPABILITY_ID,
  INFORMATION_COVER_RECIPE_STEP_IDS,
  informationCoverPackageReady,
  isInformationCoverRecipeStep,
  validateInformationCoverEvidenceReceipt,
} from "../../information-cover-workflow";
import { ManagementAuthError } from "../../management-auth-core";
import { managementActorId, requireManagementSession } from "../../management-auth";
import { sameAgentAuthorityLineage } from "../../site-full-control-auth";
import { requireManagementOrPrivilegedAgent } from "../../privileged-agent-auth";
import { agentActionAuthorization } from "../../agent-permission-catalog";

type D1Row = Record<string, string | number | null>;

const STAGES = new Set(["inbox", "commission", "research", "draft", "review", "approved", "distribution", "maintain"]);
const WORK_STATES = new Set(["open", "blocked", "done", "cancelled"]);
const PRIORITIES = new Set(["P0", "P1", "P2", "P3"]);
const STEP_STATES = new Set(["pending", "active", "blocked", "complete", "skipped"]);
const ADOPTION_STATES = new Set(["unassessed", "candidate", "tested", "verified", "adopted", "deferred", "rejected"]);
const SHA256_RE = /^[a-f0-9]{64}$/;
const COMMAND_ID_RE = /^[A-Za-z0-9._:-]+$/u;
const ARTICLE_PUBLICATION_PLATFORMS = new Set(["maimai", "xiaohongshu", "zhihu", "bilibili"]);
const PRIVILEGED_WORKSPACE_ACTIONS = {
  save_working_copy: {
    managementScope: "workspace.branch.write",
  },
  commit_revision: {
    managementScope: "workspace.branch.write",
  },
  create_publication_branch: {
    managementScope: "workspace.branch.write",
  },
  prepare_merge: {
    managementScope: "workspace.merge.apply",
  },
  save_merge_resolution: {
    managementScope: "workspace.merge.apply",
  },
  merge_revision: {
    managementScope: "workspace.merge.apply",
  },
} as const;

const indexedCorpus = corpusData as unknown as {
  articles: Array<{
    id: string;
    title: string;
    representativeVersionId: string;
    versions: Array<{ id: string; name: string; textHash: string }>;
  }>;
};
const textIndex = versionTextData as { versions: Record<string, string>; blobs: Record<string, string> };

class ApiError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

const AGENT_ACTOR_ID_PATTERN = /^agent-client:(agent-client-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/u;

function agentClientIdFromActorId(actorId: unknown, label: string) {
  if (typeof actorId !== "string" || !actorId) {
    throw new ApiError(`MERGE_AGENT_ACTOR_BINDING_MISSING: ${label} 缺少持久 Agent actor 绑定`, 409);
  }
  if (actorId.startsWith("management-session:")) return null;
  const match = AGENT_ACTOR_ID_PATTERN.exec(actorId);
  if (!match) throw new ApiError(`MERGE_AGENT_ACTOR_BINDING_MISSING: ${label} 的 Agent actor 绑定非法`, 409);
  return match[1];
}

async function assertDistinctAgentAuthorityLineage(db: D1Database, agentActorId: string, recordedActorId: unknown, label: string) {
  const currentClientId = agentClientIdFromActorId(agentActorId, "当前请求");
  const recordedClientId = agentClientIdFromActorId(recordedActorId, label);
  if (!currentClientId) throw new ApiError("MERGE_AGENT_ACTOR_BINDING_MISSING: Agent 请求未绑定 Agent actor", 409);
  if (recordedClientId && (await sameAgentAuthorityLineage(db, currentClientId, recordedClientId))) {
    throw new ApiError(`MERGE_ACTOR_SEPARATION: Agent 不能执行同一 authority lineage 的${label}阶段`, 403);
  }
}

function database() {
  if (!env.DB) throw new ApiError("本地工作区数据库尚未连接", 503);
  return env.DB;
}

async function ensureSchema() {
  const db = database();
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS article_branches (
      id TEXT PRIMARY KEY NOT NULL,
      article_id TEXT NOT NULL,
      name TEXT NOT NULL,
      slug TEXT NOT NULL,
      color TEXT NOT NULL DEFAULT 'blue',
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
      head_revision_id TEXT NOT NULL,
      base_revision_id TEXT NOT NULL,
      base_source_version_id TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_article_branches_article_slug ON article_branches(article_id, slug)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_article_branches_article_status ON article_branches(article_id, status)"),
    db.prepare(`CREATE TABLE IF NOT EXISTS article_revisions (
      id TEXT PRIMARY KEY NOT NULL,
      article_id TEXT NOT NULL,
      branch_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      parent_revision_id TEXT,
      merge_parent_revision_id TEXT,
      source_version_id TEXT,
      title TEXT NOT NULL,
      document_title TEXT NOT NULL,
      annotation TEXT NOT NULL DEFAULT '',
      body_text TEXT NOT NULL,
      body_sha256 TEXT NOT NULL,
      author_kind TEXT NOT NULL DEFAULT 'user' CHECK (author_kind IN ('user', 'agent', 'import')),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_article_revisions_branch_sequence ON article_revisions(branch_id, sequence)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_article_revisions_article_created ON article_revisions(article_id, created_at)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_article_revisions_branch_created ON article_revisions(branch_id, created_at)"),
    db.prepare(`CREATE TABLE IF NOT EXISTS branch_working_copies (
      branch_id TEXT PRIMARY KEY NOT NULL,
      article_id TEXT NOT NULL,
      base_revision_id TEXT NOT NULL,
      title TEXT NOT NULL,
      annotation TEXT NOT NULL DEFAULT '',
      body_text TEXT NOT NULL,
      body_sha256 TEXT NOT NULL,
      dirty INTEGER NOT NULL DEFAULT 0,
      lock_version INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_branch_working_copies_article ON branch_working_copies(article_id, updated_at)"),
    db.prepare(`CREATE TABLE IF NOT EXISTS work_items (
      id TEXT PRIMARY KEY NOT NULL,
      article_id TEXT,
      branch_id TEXT,
      title TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'article',
      stage TEXT NOT NULL DEFAULT 'inbox',
      state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'blocked', 'done', 'cancelled')),
      priority TEXT NOT NULL DEFAULT 'P2' CHECK (priority IN ('P0', 'P1', 'P2', 'P3')),
      owner TEXT NOT NULL DEFAULT '我',
      next_action TEXT NOT NULL DEFAULT '',
      blocker TEXT NOT NULL DEFAULT '',
      source_capability_id TEXT,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_work_items_stage_state_order ON work_items(stage, state, sort_order)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_work_items_article_updated ON work_items(article_id, updated_at)"),
    db.prepare(`CREATE TABLE IF NOT EXISTS gate_runs (
      id TEXT PRIMARY KEY NOT NULL,
      run_group_id TEXT NOT NULL,
      article_id TEXT NOT NULL,
      branch_id TEXT NOT NULL,
      revision_id TEXT,
      gate_id TEXT NOT NULL,
      gate_label TEXT NOT NULL,
      result TEXT NOT NULL CHECK (result IN ('pass', 'fail', 'inconclusive')),
      input_sha256 TEXT NOT NULL,
      evidence_json TEXT NOT NULL DEFAULT '[]',
      details_json TEXT NOT NULL DEFAULT '{}',
      started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      completed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_gate_runs_article_completed ON gate_runs(article_id, completed_at)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_gate_runs_branch_completed ON gate_runs(branch_id, completed_at)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_gate_runs_group ON gate_runs(run_group_id)"),
    db.prepare(`CREATE TABLE IF NOT EXISTS capability_overrides (
      capability_id TEXT PRIMARY KEY NOT NULL,
      adoption_status TEXT NOT NULL DEFAULT 'unassessed' CHECK (adoption_status IN ('unassessed', 'candidate', 'tested', 'verified', 'adopted', 'deferred', 'rejected')),
      notes TEXT NOT NULL DEFAULT '',
      evidence_ref TEXT NOT NULL DEFAULT '',
      regression_ref TEXT NOT NULL DEFAULT '',
      favorite INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS production_runs (
      id TEXT PRIMARY KEY NOT NULL,
      recipe_id TEXT NOT NULL,
      recipe_version TEXT NOT NULL DEFAULT '1.0.0',
      recipe_sha256 TEXT NOT NULL DEFAULT '',
      article_id TEXT NOT NULL,
      branch_id TEXT NOT NULL,
      title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned', 'active', 'paused', 'complete', 'cancelled')),
      current_step_id TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_production_runs_article_status ON production_runs(article_id, status)"),
    db.prepare(`CREATE TABLE IF NOT EXISTS production_run_steps (
      id TEXT PRIMARY KEY NOT NULL,
      run_id TEXT NOT NULL,
      step_id TEXT NOT NULL,
      position INTEGER NOT NULL,
      title TEXT NOT NULL,
      actor_kind TEXT NOT NULL,
      agent_role TEXT,
      depends_on_json TEXT NOT NULL DEFAULT '[]',
      write_scope TEXT NOT NULL DEFAULT 'none',
      runner_action TEXT,
      capability_id TEXT,
      gate_id TEXT,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'blocked', 'complete', 'skipped')),
      evidence_json TEXT NOT NULL DEFAULT '[]',
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_production_run_steps_run_step ON production_run_steps(run_id, step_id)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_production_run_steps_run_position ON production_run_steps(run_id, position)"),
    db.prepare(`CREATE TABLE IF NOT EXISTS workspace_events (
      id TEXT PRIMARY KEY NOT NULL,
      event_type TEXT NOT NULL,
      subject_type TEXT NOT NULL,
      subject_id TEXT NOT NULL,
      article_id TEXT,
      payload_json TEXT NOT NULL DEFAULT '{}',
      input_sha256 TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_workspace_events_article_created ON workspace_events(article_id, created_at)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_workspace_events_subject_created ON workspace_events(subject_type, subject_id, created_at)"),
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
    db.prepare(`CREATE TABLE IF NOT EXISTS merge_proposals (
      id TEXT PRIMARY KEY NOT NULL,
      work_item_id TEXT NOT NULL UNIQUE,
      article_id TEXT NOT NULL,
      source_branch_id TEXT NOT NULL,
      target_branch_id TEXT NOT NULL,
      base_revision_id TEXT NOT NULL,
      source_head_revision_id TEXT NOT NULL,
      target_head_revision_id TEXT NOT NULL,
      base_sha256 TEXT NOT NULL,
      source_head_sha256 TEXT NOT NULL,
      target_head_sha256 TEXT NOT NULL,
      algorithm_version TEXT NOT NULL,
      preview_json TEXT NOT NULL DEFAULT '{}',
      preview_sha256 TEXT NOT NULL,
      resolved_document_title TEXT NOT NULL DEFAULT '',
      resolved_body_text TEXT NOT NULL DEFAULT '',
      resolved_body_sha256 TEXT NOT NULL DEFAULT '',
      resolution_json TEXT NOT NULL DEFAULT '{}',
      resolution_note TEXT NOT NULL DEFAULT '',
      prepare_actor_id TEXT,
      resolution_actor_id TEXT,
      apply_actor_id TEXT,
      unresolved_count INTEGER NOT NULL DEFAULT 0 CHECK (unresolved_count >= 0),
      status TEXT NOT NULL DEFAULT 'prepared' CHECK (status IN ('prepared', 'resolving', 'ready', 'stale', 'merged', 'cancelled')),
      lock_version INTEGER NOT NULL DEFAULT 1,
      merge_revision_id TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CHECK (source_branch_id <> target_branch_id),
      CHECK (status <> 'ready' OR (unresolved_count = 0 AND length(resolved_body_sha256) = 64)),
      CHECK (status <> 'merged' OR merge_revision_id IS NOT NULL)
    )`),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_merge_proposals_article_status ON merge_proposals(article_id, status, updated_at)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_merge_proposals_target_status ON merge_proposals(target_branch_id, status, updated_at)"),
    db.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS idx_merge_proposals_active_heads
      ON merge_proposals(source_branch_id, target_branch_id, source_head_revision_id, target_head_revision_id)
      WHERE status IN ('prepared', 'resolving', 'ready')`),
    db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_merge_proposals_revision ON merge_proposals(merge_revision_id) WHERE merge_revision_id IS NOT NULL"),
  ]);
  // `CREATE TABLE IF NOT EXISTS` does not evolve a table created by an older
  // local preview. Keep the runtime upgrade additive and project-local so a
  // user can reopen an existing D1 database without deleting their drafts.
  const branchColumns = await db.prepare("PRAGMA table_info(article_branches)").all<D1Row>();
  if (!branchColumns.results.some((column) => column.name === "head_revision_id")) {
    await db.prepare("ALTER TABLE article_branches ADD COLUMN head_revision_id TEXT NOT NULL DEFAULT ''").run();
  }
  if (!branchColumns.results.some((column) => column.name === "base_revision_id")) {
    await db.prepare("ALTER TABLE article_branches ADD COLUMN base_revision_id TEXT NOT NULL DEFAULT ''").run();
  }
  const branchRepairProtection = await packageBranchProtection(db);
  const branchRepairGuard = packageBranchNotExistsSql(branchRepairProtection, ["article_branches.id"]);
  await db.batch([
    db.prepare(`UPDATE article_branches SET head_revision_id = COALESCE((
      SELECT id FROM article_revisions WHERE branch_id = article_branches.id ORDER BY sequence DESC LIMIT 1
    ), '') WHERE head_revision_id = '' ${branchRepairGuard}`),
    db.prepare(`UPDATE article_branches SET base_revision_id = COALESCE((
      SELECT id FROM article_revisions WHERE branch_id = article_branches.id ORDER BY sequence ASC LIMIT 1
    ), '') WHERE base_revision_id = '' ${branchRepairGuard}`),
    db.prepare(`UPDATE article_branches SET status = 'archived'
      WHERE (head_revision_id = '' OR base_revision_id = '') ${branchRepairGuard}`),
  ]);
  const copyColumns = await db.prepare("PRAGMA table_info(branch_working_copies)").all<D1Row>();
  if (!copyColumns.results.some((column) => column.name === "lock_version")) {
    await db.prepare("ALTER TABLE branch_working_copies ADD COLUMN lock_version INTEGER NOT NULL DEFAULT 1").run();
  }
  const mergeProposalColumns = await db.prepare("PRAGMA table_info(merge_proposals)").all<D1Row>();
  for (const column of ["prepare_actor_id", "resolution_actor_id", "apply_actor_id"]) {
    if (!mergeProposalColumns.results.some((candidate) => candidate.name === column)) {
      await db.prepare(`ALTER TABLE merge_proposals ADD COLUMN ${column} TEXT`).run();
    }
  }
  const runColumns = await db.prepare("PRAGMA table_info(production_runs)").all<D1Row>();
  if (!runColumns.results.some((column) => column.name === "recipe_version")) {
    await db.prepare("ALTER TABLE production_runs ADD COLUMN recipe_version TEXT NOT NULL DEFAULT '1.0.0'").run();
  }
  if (!runColumns.results.some((column) => column.name === "recipe_sha256")) {
    await db.prepare("ALTER TABLE production_runs ADD COLUMN recipe_sha256 TEXT NOT NULL DEFAULT ''").run();
  }
  const runStepColumns = await db.prepare("PRAGMA table_info(production_run_steps)").all<D1Row>();
  if (!runStepColumns.results.some((column) => column.name === "agent_role")) {
    await db.prepare("ALTER TABLE production_run_steps ADD COLUMN agent_role TEXT").run();
  }
  if (!runStepColumns.results.some((column) => column.name === "depends_on_json")) {
    await db.prepare("ALTER TABLE production_run_steps ADD COLUMN depends_on_json TEXT NOT NULL DEFAULT '[]'").run();
  }
  if (!runStepColumns.results.some((column) => column.name === "write_scope")) {
    await db.prepare("ALTER TABLE production_run_steps ADD COLUMN write_scope TEXT NOT NULL DEFAULT 'none'").run();
  }
  if (!runStepColumns.results.some((column) => column.name === "runner_action")) {
    await db.prepare("ALTER TABLE production_run_steps ADD COLUMN runner_action TEXT").run();
  }
  return db;
}

async function resolvePrivilegedWorkspaceArticle(
  db: D1Database,
  action: string,
  payload: Record<string, unknown>,
) {
  if (action === "prepare_merge") return requiredText(payload.articleId, "文章 ID", 120);
  if (action === "save_working_copy" || action === "commit_revision") {
    const branchId = requiredText(payload.branchId, "branchId", 160);
    const row = await db.prepare("SELECT article_id FROM article_branches WHERE id = ? LIMIT 1").bind(branchId).first<D1Row>();
    if (!row?.article_id) throw new ApiError("工作区分支不存在", 404);
    return String(row.article_id);
  }
  if (action === "create_publication_branch") {
    const packageId = requiredText(payload.packageId, "packageId", 160);
    const row = await db.prepare("SELECT article_id FROM article_project_packages WHERE id = ? LIMIT 1").bind(packageId).first<D1Row>();
    if (!row?.article_id) throw new ApiError("文章工程包不存在", 404);
    return String(row.article_id);
  }
  if (action === "save_merge_resolution" || action === "merge_revision") {
    const proposalId = requiredText(payload.proposalId, "合并提案 ID", 120);
    const row = await db.prepare("SELECT article_id FROM merge_proposals WHERE id = ? LIMIT 1").bind(proposalId).first<D1Row>();
    if (!row?.article_id) throw new ApiError("合并提案不存在", 404);
    return String(row.article_id);
  }
  return undefined;
}

function assertPrivilegedWorkspaceArticleBoundary(principal: Awaited<ReturnType<typeof requireManagementOrPrivilegedAgent>>, articleId: string | undefined) {
  if (principal.kind === "agent" && articleId && !principal.articleIds.includes("*") && !principal.articleIds.includes(articleId)) {
    throw new ApiError("高权限 Agent Key 不包含当前文章对象", 403);
  }
}

function cleanText(value: unknown, maximum: number, preserveWhitespace = false): string {
  if (typeof value !== "string") return "";
  const text = preserveWhitespace ? value.replace(/\r\n?/g, "\n") : value.trim();
  if (text.length > maximum) throw new ApiError(`输入超过 ${maximum.toLocaleString("zh-CN")} 个字符`);
  return text;
}

function requiredText(value: unknown, label: string, maximum: number): string {
  const text = cleanText(value, maximum);
  if (!text) throw new ApiError(`缺少${label}`);
  return text;
}

function requiredPositiveInteger(value: unknown, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new ApiError(`${label}必须是正整数`);
  return parsed;
}

function parseJson<T>(value: unknown, fallback: T): T {
  try {
    return JSON.parse(String(value ?? "")) as T;
  } catch {
    return fallback;
  }
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record).sort().map((key) => [key, canonicalValue(record[key])]));
  }
  if (value === undefined) return null;
  return value;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

async function sha256Text(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

type PackageBranchProtection = {
  branchStates: boolean;
  legacyPrimary: boolean;
};

async function packageBranchProtection(db: D1Database): Promise<PackageBranchProtection> {
  const tables = await db.prepare(`SELECT name FROM sqlite_master
    WHERE type = 'table' AND name IN ('package_branch_states', 'article_project_packages')`).all<D1Row>();
  const names = new Set(tables.results.map((row) => String(row.name)));
  let branchStates = false;
  let legacyPrimary = false;
  if (names.has("package_branch_states")) {
    const columns = await db.prepare("PRAGMA table_info(package_branch_states)").all<D1Row>();
    const columnNames = new Set(columns.results.map((column) => String(column.name)));
    branchStates = columnNames.has("branch_id") && columnNames.has("status");
  }
  if (names.has("article_project_packages")) {
    const columns = await db.prepare("PRAGMA table_info(article_project_packages)").all<D1Row>();
    const columnNames = new Set(columns.results.map((column) => String(column.name)));
    legacyPrimary = columnNames.has("primary_branch_id") && columnNames.has("status");
  }
  return { branchStates, legacyPrimary };
}

function packageBranchNotExistsSql(protection: PackageBranchProtection, branchExpressions: string[]) {
  const expressions = branchExpressions.join(", ");
  const guards: string[] = [];
  if (protection.branchStates) {
    guards.push(`NOT EXISTS (SELECT 1 FROM package_branch_states package_branch_state
      WHERE package_branch_state.status = 'active'
        AND package_branch_state.branch_id IN (${expressions}))`);
  }
  // Keep the 0009 root mirror as a read-only fallback. This also closes the
  // upgrade window where the 0010 table exists but a legacy Package has not
  // yet been migrated into package_branch_states.
  if (protection.legacyPrimary) {
    guards.push(`NOT EXISTS (SELECT 1 FROM article_project_packages project_package
      WHERE project_package.status = 'active'
        AND project_package.primary_branch_id IN (${expressions}))`);
  }
  return guards.length ? `AND ${guards.join("\n      AND ")}` : "";
}

function packageBranchPairGuardFromProposalSql(protection: PackageBranchProtection) {
  const guards: string[] = [];
  if (protection.branchStates) {
    guards.push(`NOT EXISTS (SELECT 1 FROM package_branch_states package_branch_state
      JOIN merge_proposals guarded_proposal ON guarded_proposal.id = ?
      WHERE package_branch_state.status = 'active'
        AND package_branch_state.branch_id IN (guarded_proposal.source_branch_id, guarded_proposal.target_branch_id))`);
  }
  if (protection.legacyPrimary) {
    guards.push(`NOT EXISTS (SELECT 1 FROM article_project_packages project_package
      JOIN merge_proposals guarded_proposal ON guarded_proposal.id = ?
      WHERE project_package.status = 'active'
        AND project_package.primary_branch_id IN (guarded_proposal.source_branch_id, guarded_proposal.target_branch_id))`);
  }
  return {
    sql: guards.length ? `AND ${guards.join("\n        AND ")}` : "",
    bindCount: guards.length,
  };
}

async function assertLegacyWorkspaceBranchesWritable(db: D1Database, branchIds: string[]) {
  const protection = await packageBranchProtection(db);
  const uniqueBranchIds = [...new Set(branchIds.filter(Boolean))];
  if (!uniqueBranchIds.length || (!protection.branchStates && !protection.legacyPrimary)) return protection;
  const placeholders = uniqueBranchIds.map(() => "?").join(", ");
  const protectedByBranchState = protection.branchStates
    ? await db.prepare(`SELECT branch_id FROM package_branch_states
        WHERE status = 'active' AND branch_id IN (${placeholders}) LIMIT 1`)
      .bind(...uniqueBranchIds).first<D1Row>()
    : null;
  const protectedByLegacyPrimary = protection.legacyPrimary
    ? await db.prepare(`SELECT primary_branch_id FROM article_project_packages
        WHERE status = 'active' AND primary_branch_id IN (${placeholders}) LIMIT 1`)
      .bind(...uniqueBranchIds).first<D1Row>()
    : null;
  if (protectedByBranchState || protectedByLegacyPrimary) {
    throw new ApiError("该 ArticleBranch 已由 active ArticleProject Package 管理；legacy workspace 写入已拒绝，请改用 /api/project-package/v1", 409);
  }
  return protection;
}

function branchSlug(name: string): string {
  const base = name
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return `${base || "branch"}-${crypto.randomUUID().slice(0, 6)}`;
}

function sourceVersion(articleId: string, requestedVersionId: string | null) {
  const article = indexedCorpus.articles.find((item) => item.id === articleId);
  if (!article) throw new ApiError("文章身份不在当前索引中", 404);
  const versionId = requestedVersionId || article.representativeVersionId;
  const version = article.versions.find((item) => item.id === versionId);
  if (!version) throw new ApiError("源版本不属于这篇文章", 409);
  const textHash = textIndex.versions[version.id];
  const body = textHash ? textIndex.blobs[textHash] : undefined;
  if (body === undefined) throw new ApiError("该源版本没有可读取的文本正文", 409);
  return { article, version, body, bodySha256: textHash };
}

function eventInsert(
  db: D1Database,
  eventType: string,
  subjectType: string,
  subjectId: string,
  articleId: string | null,
  payload: Record<string, unknown>,
  inputSha256: string,
) {
  return db.prepare(`INSERT INTO workspace_events
    (id, event_type, subject_type, subject_id, article_id, payload_json, input_sha256)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .bind(`event-${crypto.randomUUID()}`, eventType, subjectType, subjectId, articleId, JSON.stringify(payload), inputSha256);
}

function parseBranch(row: D1Row) {
  return {
    id: String(row.id), articleId: String(row.article_id), name: String(row.name), slug: String(row.slug),
    color: String(row.color), status: String(row.status), headRevisionId: String(row.head_revision_id), baseRevisionId: String(row.base_revision_id),
    baseSourceVersionId: row.base_source_version_id ? String(row.base_source_version_id) : null,
    createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  };
}

function parseRevision(row: D1Row) {
  const bodyText = String(row.body_text ?? "");
  return {
    id: String(row.id), articleId: String(row.article_id), branchId: String(row.branch_id), sequence: Number(row.sequence),
    parentRevisionId: row.parent_revision_id ? String(row.parent_revision_id) : null,
    mergeParentRevisionId: row.merge_parent_revision_id ? String(row.merge_parent_revision_id) : null,
    sourceVersionId: row.source_version_id ? String(row.source_version_id) : null,
    title: String(row.title), documentTitle: String(row.document_title), annotation: String(row.annotation ?? ""),
    bodyText, bodySha256: String(row.body_sha256), authorKind: String(row.author_kind), charCount: bodyText.replace(/\s/g, "").length,
    createdAt: String(row.created_at),
  };
}

function parseWorkingCopy(row: D1Row) {
  return {
    branchId: String(row.branch_id), articleId: String(row.article_id), baseRevisionId: String(row.base_revision_id),
    title: String(row.title), annotation: String(row.annotation ?? ""), bodyText: String(row.body_text ?? ""),
    bodySha256: String(row.body_sha256), dirty: Boolean(row.dirty), lockVersion: Number(row.lock_version ?? 1),
    updatedAt: String(row.updated_at),
  };
}

function parseWorkItem(row: D1Row) {
  return {
    id: String(row.id), articleId: row.article_id ? String(row.article_id) : null, branchId: row.branch_id ? String(row.branch_id) : null,
    title: String(row.title), kind: String(row.kind), stage: String(row.stage), state: String(row.state), priority: String(row.priority),
    owner: String(row.owner), nextAction: String(row.next_action ?? ""), blocker: String(row.blocker ?? ""),
    sourceCapabilityId: row.source_capability_id ? String(row.source_capability_id) : null, sortOrder: Number(row.sort_order),
    createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  };
}

function parseGateRun(row: D1Row) {
  return {
    id: String(row.id), runGroupId: String(row.run_group_id), articleId: String(row.article_id), branchId: String(row.branch_id),
    revisionId: row.revision_id ? String(row.revision_id) : null, gateId: String(row.gate_id), gateLabel: String(row.gate_label),
    result: String(row.result), inputSha256: String(row.input_sha256), evidence: parseJson<string[]>(row.evidence_json, []),
    details: parseJson<Record<string, string | number | boolean | null>>(row.details_json, {}),
    startedAt: String(row.started_at), completedAt: String(row.completed_at),
  };
}

function parseCapabilityOverride(row: D1Row) {
  return {
    capabilityId: String(row.capability_id), adoptionStatus: String(row.adoption_status), notes: String(row.notes ?? ""),
    evidenceRef: String(row.evidence_ref ?? ""), regressionRef: String(row.regression_ref ?? ""), favorite: Boolean(row.favorite),
    updatedAt: String(row.updated_at),
  };
}

function parseProductionStep(row: D1Row) {
  return {
    id: String(row.id), runId: String(row.run_id), stepId: String(row.step_id), position: Number(row.position), title: String(row.title),
    actorKind: String(row.actor_kind), agentRole: row.agent_role ? String(row.agent_role) : null,
    dependsOn: parseJson<string[]>(row.depends_on_json, []), writeScope: String(row.write_scope || "none"),
    runnerAction: row.runner_action ? String(row.runner_action) : null,
    capabilityId: row.capability_id ? String(row.capability_id) : null,
    gateId: row.gate_id ? String(row.gate_id) : null, status: String(row.status), evidence: parseJson<string[]>(row.evidence_json, []),
    updatedAt: String(row.updated_at),
  };
}

function parseProductionRun(row: D1Row, steps: D1Row[]) {
  return {
    id: String(row.id), recipeId: String(row.recipe_id), recipeVersion: String(row.recipe_version || "1.0.0"),
    recipeSha256: String(row.recipe_sha256 || ""), articleId: String(row.article_id), branchId: String(row.branch_id),
    title: String(row.title), status: String(row.status), currentStepId: row.current_step_id ? String(row.current_step_id) : null,
    createdAt: String(row.created_at), updatedAt: String(row.updated_at),
    steps: steps.filter((step) => step.run_id === row.id).sort((a, b) => Number(a.position) - Number(b.position)).map(parseProductionStep),
  };
}

function parseEvent(row: D1Row) {
  return {
    id: String(row.id), eventType: String(row.event_type), subjectType: String(row.subject_type), subjectId: String(row.subject_id),
    articleId: row.article_id ? String(row.article_id) : null, payload: parseJson<Record<string, unknown>>(row.payload_json, {}),
    inputSha256: String(row.input_sha256), createdAt: String(row.created_at),
  };
}

function parseMergeProposal(row: D1Row) {
  return {
    id: String(row.id), workItemId: String(row.work_item_id), articleId: String(row.article_id),
    sourceBranchId: String(row.source_branch_id), targetBranchId: String(row.target_branch_id),
    baseRevisionId: String(row.base_revision_id), sourceHeadRevisionId: String(row.source_head_revision_id),
    targetHeadRevisionId: String(row.target_head_revision_id), baseSha256: String(row.base_sha256),
    sourceHeadSha256: String(row.source_head_sha256), targetHeadSha256: String(row.target_head_sha256),
    algorithmVersion: String(row.algorithm_version), preview: parseJson<Record<string, unknown>>(row.preview_json, {}),
    previewSha256: String(row.preview_sha256), resolvedDocumentTitle: String(row.resolved_document_title ?? ""),
    resolvedBodyText: String(row.resolved_body_text ?? ""), resolvedBodySha256: String(row.resolved_body_sha256 ?? ""),
    resolution: parseJson<Record<string, unknown>>(row.resolution_json, {}), resolutionNote: String(row.resolution_note ?? ""),
    prepareActorId: row.prepare_actor_id ? String(row.prepare_actor_id) : null,
    resolutionActorId: row.resolution_actor_id ? String(row.resolution_actor_id) : null,
    applyActorId: row.apply_actor_id ? String(row.apply_actor_id) : null,
    unresolvedCount: Number(row.unresolved_count), status: String(row.status), lockVersion: Number(row.lock_version),
    mergeRevisionId: row.merge_revision_id ? String(row.merge_revision_id) : null,
    createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  };
}

export async function GET(request: Request) {
  try {
    await requireManagementSession(request, { scope: "management.read" })
      .catch((error: unknown) => {
        if (error instanceof ManagementAuthError) throw new ApiError(error.message, error.status);
        throw error;
      });
    const db = await ensureSchema();
    const url = new URL(request.url);
    const articleId = cleanText(url.searchParams.get("articleId"), 120);
    const [branchesResult, revisionsResult, copiesResult, workItemsResult, gatesResult, overridesResult, runsResult, stepsResult, mergesResult, eventsResult] = await db.batch([
      articleId
        ? db.prepare("SELECT * FROM article_branches WHERE article_id = ? ORDER BY status, updated_at DESC LIMIT 100").bind(articleId)
        : db.prepare("SELECT * FROM article_branches WHERE 1 = 0"),
      articleId
        ? db.prepare("SELECT * FROM article_revisions WHERE article_id = ? ORDER BY created_at, sequence LIMIT 1000").bind(articleId)
        : db.prepare("SELECT * FROM article_revisions WHERE 1 = 0"),
      articleId
        ? db.prepare("SELECT * FROM branch_working_copies WHERE article_id = ? ORDER BY updated_at DESC LIMIT 100").bind(articleId)
        : db.prepare("SELECT * FROM branch_working_copies WHERE 1 = 0"),
      db.prepare("SELECT * FROM work_items ORDER BY state, stage, sort_order, updated_at DESC LIMIT 1000"),
      articleId
        ? db.prepare("SELECT * FROM gate_runs WHERE article_id = ? ORDER BY completed_at DESC LIMIT 500").bind(articleId)
        : db.prepare("SELECT * FROM gate_runs ORDER BY completed_at DESC LIMIT 100"),
      db.prepare("SELECT * FROM capability_overrides ORDER BY favorite DESC, updated_at DESC LIMIT 1000"),
      articleId
        ? db.prepare("SELECT * FROM production_runs WHERE article_id = ? ORDER BY updated_at DESC LIMIT 100").bind(articleId)
        : db.prepare("SELECT * FROM production_runs ORDER BY updated_at DESC LIMIT 100"),
      db.prepare("SELECT * FROM production_run_steps ORDER BY run_id, position LIMIT 1000"),
      articleId
        ? db.prepare("SELECT * FROM merge_proposals WHERE article_id = ? ORDER BY updated_at DESC LIMIT 100").bind(articleId)
        : db.prepare("SELECT * FROM merge_proposals WHERE 1 = 0"),
      articleId
        ? db.prepare("SELECT * FROM workspace_events WHERE article_id = ? OR subject_type = 'capability' ORDER BY created_at DESC LIMIT 300").bind(articleId)
        : db.prepare("SELECT * FROM workspace_events ORDER BY created_at DESC LIMIT 200"),
    ]);
    const stepRows = stepsResult.results as D1Row[];
    return Response.json({
      storage: "d1-local",
      branches: (branchesResult.results as D1Row[]).map(parseBranch),
      revisions: (revisionsResult.results as D1Row[]).map(parseRevision),
      workingCopies: (copiesResult.results as D1Row[]).map(parseWorkingCopy),
      workItems: (workItemsResult.results as D1Row[]).map(parseWorkItem),
      gateRuns: (gatesResult.results as D1Row[]).map(parseGateRun),
      capabilityOverrides: (overridesResult.results as D1Row[]).map(parseCapabilityOverride),
      productionRuns: (runsResult.results as D1Row[]).map((row) => parseProductionRun(row, stepRows)),
      mergeProposals: (mergesResult.results as D1Row[]).map(parseMergeProposal),
      events: (eventsResult.results as D1Row[]).map(parseEvent),
    });
  } catch (error) {
    const status = error instanceof ApiError ? error.status : 503;
    return Response.json({
      storage: "unavailable", branches: [], revisions: [], workingCopies: [], workItems: [], gateRuns: [],
      capabilityOverrides: [], productionRuns: [], mergeProposals: [], events: [], error: error instanceof Error ? error.message : "工作区不可用",
    }, { status });
  }
}

async function storageProbe(db: D1Database) {
  const suffix = crypto.randomUUID();
  const branchId = `qa-branch-${suffix}`;
  const revisionId = `qa-revision-${suffix}`;
  const workId = `qa-work-${suffix}`;
  const gateId = `qa-gate-${suffix}`;
  const runId = `qa-run-${suffix}`;
  const stepId = `qa-step-${suffix}`;
  const eventId = `qa-event-${suffix}`;
  const qaArticleId = `__qa__${suffix}`;
  const digest = await sha256Text(suffix);
  let freshWriteAccepted = false;
  let staleWriteRejected = false;
  let commitAccepted = false;
  let staleCommitRejected = false;
  let factoryForkActivated = false;
  let factoryJoinGuarded = false;
  let cleaned = false;
  try {
    await db.batch([
      db.prepare(`INSERT INTO article_branches
        (id, article_id, name, slug, head_revision_id, base_revision_id)
        VALUES (?, ?, 'QA', ?, ?, ?)`)
        .bind(branchId, qaArticleId, suffix, revisionId, revisionId),
      db.prepare(`INSERT INTO article_revisions
        (id, article_id, branch_id, sequence, title, document_title, body_text, body_sha256)
        VALUES (?, ?, ?, 1, 'QA', 'QA', ?, ?)`)
        .bind(revisionId, qaArticleId, branchId, suffix, digest),
      db.prepare(`INSERT INTO branch_working_copies
        (branch_id, article_id, base_revision_id, title, body_text, body_sha256)
        VALUES (?, ?, ?, 'QA', ?, ?)`)
        .bind(branchId, qaArticleId, revisionId, suffix, digest),
      db.prepare("INSERT INTO work_items (id, article_id, branch_id, title) VALUES (?, ?, ?, 'QA')").bind(workId, qaArticleId, branchId),
      db.prepare(`INSERT INTO gate_runs
        (id, run_group_id, article_id, branch_id, gate_id, gate_label, result, input_sha256)
        VALUES (?, 'qa', ?, ?, 'qa', 'QA', 'pass', ?)`)
        .bind(gateId, qaArticleId, branchId, digest),
      db.prepare("INSERT INTO capability_overrides (capability_id) VALUES (?)").bind(`qa-capability-${suffix}`),
      db.prepare(`INSERT INTO production_runs
        (id, recipe_id, article_id, branch_id, title) VALUES (?, 'qa', ?, ?, 'QA')`)
        .bind(runId, qaArticleId, branchId),
      db.prepare(`INSERT INTO production_run_steps
        (id, run_id, step_id, position, title, actor_kind) VALUES (?, ?, 'qa', 0, 'QA', 'script')`)
        .bind(stepId, runId),
      db.prepare(`INSERT INTO workspace_events
        (id, event_type, subject_type, subject_id, article_id, input_sha256) VALUES (?, 'qa', 'qa', 'qa', ?, ?)`)
        .bind(eventId, qaArticleId, digest),
    ]);
    const fresh = await db.prepare(`UPDATE branch_working_copies
      SET annotation = 'fresh', lock_version = lock_version + 1
      WHERE branch_id = ? AND lock_version = 1`).bind(branchId).run();
    const stale = await db.prepare(`UPDATE branch_working_copies
      SET annotation = 'stale', lock_version = lock_version + 1
      WHERE branch_id = ? AND lock_version = 1`).bind(branchId).run();
    const persisted = await db.prepare("SELECT lock_version, annotation FROM branch_working_copies WHERE branch_id = ?")
      .bind(branchId).first<D1Row>();
    freshWriteAccepted = Number(fresh.meta.changes ?? 0) === 1
      && Number(persisted?.lock_version ?? 0) === 2
      && persisted?.annotation === "fresh";
    staleWriteRejected = Number(stale.meta.changes ?? 0) === 0 && persisted?.annotation === "fresh";
    if (!freshWriteAccepted || !staleWriteRejected) throw new ApiError("D1 并发写入探针未满足预期", 503);
    const commitResponse = await commitRevision(db, {
      branchId,
      baseRevisionId: revisionId,
      lockVersion: 2,
      bodySha256: digest,
      revisionTitle: "QA 原子提交",
      annotation: "运行时探针，完成后清理",
    });
    const commitResult = await commitResponse.json() as { revisionId?: string };
    const committedRevision = commitResult.revisionId
      ? await db.prepare("SELECT * FROM article_revisions WHERE id = ? AND parent_revision_id = ?")
        .bind(commitResult.revisionId, revisionId).first<D1Row>()
      : null;
    commitAccepted = commitResponse.status === 201 && Boolean(committedRevision);
    try {
      await commitRevision(db, {
        branchId,
        baseRevisionId: revisionId,
        lockVersion: 2,
        bodySha256: digest,
        revisionTitle: "QA 过期提交",
      });
    } catch (error) {
      staleCommitRejected = error instanceof ApiError && error.status === 409;
    }
    if (!commitAccepted || !staleCommitRejected) throw new ApiError("D1 原子提交探针未满足预期", 503);
    const factoryResponse = await createProductionRun(db, {
      recipeId: "series-fork-join-v1",
      articleId: qaArticleId,
      branchId,
      title: "QA 受控多 Agent 运行",
    });
    const factoryResult = await factoryResponse.json() as { id?: string };
    if (!factoryResult.id) throw new ApiError("D1 工厂探针未返回运行 ID", 503);
    await updateProductionStep(db, {
      runId: factoryResult.id,
      stepId: "series-commission",
      status: "complete",
      evidenceNote: "QA 委托探针",
    });
    const activeFactorySteps = await db.prepare(`SELECT step_id FROM production_run_steps
      WHERE run_id = ? AND status = 'active' ORDER BY step_id`).bind(factoryResult.id).all<D1Row>();
    const activeStepIds = new Set(activeFactorySteps.results.map((item) => String(item.step_id)));
    factoryForkActivated = ["source-researcher", "series-analyst", "red-team"]
      .every((stepName) => activeStepIds.has(stepName));
    try {
      await updateProductionStep(db, {
        runId: factoryResult.id,
        stepId: "editorial-join",
        status: "complete",
        evidenceNote: "QA 越级探针",
      });
    } catch (error) {
      factoryJoinGuarded = error instanceof ApiError && error.status === 409;
    }
    if (!factoryForkActivated || !factoryJoinGuarded) throw new ApiError("D1 工厂依赖探针未满足预期", 503);
  } finally {
    await db.batch([
      db.prepare("DELETE FROM workspace_events WHERE article_id = ?").bind(qaArticleId),
      db.prepare("DELETE FROM production_run_steps WHERE run_id IN (SELECT id FROM production_runs WHERE article_id = ?)").bind(qaArticleId),
      db.prepare("DELETE FROM production_runs WHERE article_id = ?").bind(qaArticleId),
      db.prepare("DELETE FROM capability_overrides WHERE capability_id = ?").bind(`qa-capability-${suffix}`),
      db.prepare("DELETE FROM gate_runs WHERE id = ?").bind(gateId),
      db.prepare("DELETE FROM work_items WHERE id = ?").bind(workId),
      db.prepare("DELETE FROM branch_working_copies WHERE branch_id = ?").bind(branchId),
      db.prepare("DELETE FROM article_revisions WHERE branch_id = ?").bind(branchId),
      db.prepare("DELETE FROM article_branches WHERE id = ?").bind(branchId),
    ]);
    const residue = await db.prepare("SELECT COUNT(*) AS count FROM article_branches WHERE id = ?").bind(branchId).first<D1Row>();
    cleaned = Number(residue?.count ?? 1) === 0;
  }
  return Response.json({
    storage: "d1-local", writable: true, cleaned, tablesChecked: 9,
    freshWriteAccepted, staleWriteRejected, commitAccepted, staleCommitRejected, factoryForkActivated, factoryJoinGuarded,
  });
}

async function createBranch(db: D1Database, payload: Record<string, unknown>) {
  const articleId = requiredText(payload.articleId, "文章 ID", 120);
  const name = requiredText(payload.name, "分支名称", 80);
  const baseRevisionId = cleanText(payload.baseRevisionId, 120);
  const requestedSourceVersionId = cleanText(payload.baseSourceVersionId, 120);
  const annotation = cleanText(payload.annotation, 1000);
  const article = indexedCorpus.articles.find((item) => item.id === articleId);
  if (!baseRevisionId && !article) throw new ApiError("文章身份不在当前索引中；D1 文章请提供有效 baseRevisionId", 404);

  let body: string;
  let bodySha256: string;
  let documentTitle = article?.title ?? "";
  let rootRevisionId: string;
  let branchBaseRevisionId: string;
  let parentRevisionId: string | null = null;
  let sourceVersionId: string | null = null;
  let baseLabel: string;
  let needsRootRevision = false;

  if (baseRevisionId) {
    const parent = await db.prepare("SELECT * FROM article_revisions WHERE id = ? AND article_id = ? LIMIT 1")
      .bind(baseRevisionId, articleId).first<D1Row>();
    if (!parent) throw new ApiError("基线修订不存在或不属于这篇文章", 409);
    body = String(parent.body_text ?? "");
    bodySha256 = String(parent.body_sha256);
    documentTitle = String(parent.document_title);
    parentRevisionId = String(parent.id);
    branchBaseRevisionId = parentRevisionId;
    rootRevisionId = `revision-${crypto.randomUUID()}`;
    sourceVersionId = parent.source_version_id ? String(parent.source_version_id) : null;
    baseLabel = `修订 ${String(parent.title)}`;
    needsRootRevision = true;
  } else {
    const source = sourceVersion(articleId, requestedSourceVersionId || null);
    body = source.body;
    bodySha256 = source.bodySha256;
    sourceVersionId = source.version.id;
    rootRevisionId = `revision-${crypto.randomUUID()}`;
    branchBaseRevisionId = rootRevisionId;
    needsRootRevision = true;
    baseLabel = `源版本 ${source.version.name}`;
  }

  const branchId = `branch-${crypto.randomUUID()}`;
  const workItemId = `work-${crypto.randomUUID()}`;
  const revisionTitle = `基线 · ${baseLabel}`;
  const branchAnnotation = annotation || `由用户明确选择${baseLabel}建立工作分支；该关系为已确认基线。`;
  const statements = [
    db.prepare(`INSERT INTO article_branches
      (id, article_id, name, slug, color, head_revision_id, base_revision_id, base_source_version_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(branchId, articleId, name, branchSlug(name), cleanText(payload.color, 20) || "blue", rootRevisionId, branchBaseRevisionId, sourceVersionId),
    db.prepare(`INSERT INTO branch_working_copies
      (branch_id, article_id, base_revision_id, title, annotation, body_text, body_sha256, dirty)
      VALUES (?, ?, ?, ?, '', ?, ?, 0)`)
      .bind(branchId, articleId, rootRevisionId, documentTitle, body, bodySha256),
    db.prepare(`INSERT INTO work_items
      (id, article_id, branch_id, title, kind, stage, state, priority, next_action)
      VALUES (?, ?, ?, ?, 'article', 'draft', 'open', 'P2', '完成这条分支的第一轮改写并提交修订')`)
      .bind(workItemId, articleId, branchId, `推进《${documentTitle}》· ${name}`),
    eventInsert(db, "branch.created", "branch", branchId, articleId, {
      name, baseRevisionId: branchBaseRevisionId, headRevisionId: rootRevisionId, baseSourceVersionId: sourceVersionId,
    }, bodySha256),
  ];
  if (needsRootRevision) {
    statements.splice(1, 0, db.prepare(`INSERT INTO article_revisions
      (id, article_id, branch_id, sequence, parent_revision_id, source_version_id,
       title, document_title, annotation, body_text, body_sha256, author_kind)
      VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, 'import')`)
      .bind(rootRevisionId, articleId, branchId, parentRevisionId, sourceVersionId,
        revisionTitle, documentTitle, branchAnnotation, body, bodySha256));
  }
  await db.batch(statements);
  return Response.json({ branchId, revisionId: rootRevisionId, workItemId, createdRootRevision: needsRootRevision }, { status: 201 });
}

async function createPublicationBranch(db: D1Database, payload: Record<string, unknown>, actorId: string) {
  const commandId = requiredText(payload.commandId, "commandId", 160);
  const packageId = requiredText(payload.packageId, "Package ID", 160);
  const platform = requiredText(payload.platform, "发布平台", 40);
  if (!ARTICLE_PUBLICATION_PLATFORMS.has(platform)) {
    throw new ApiError("发布平台只能是 maimai、xiaohongshu、zhihu 或 bilibili");
  }
  const name = requiredText(payload.name, "分支名称", 80);
  const expectedPackageLockVersion = requiredPositiveInteger(payload.expectedPackageLockVersion, "Package lockVersion");
  const expectedCanonicalBranchId = requiredText(payload.expectedCanonicalBranchId, "canonical 分支 ID", 160);
  const expectedCanonicalBranchLockVersion = requiredPositiveInteger(
    payload.expectedCanonicalBranchLockVersion,
    "canonical 分支 lockVersion",
  );
  const expectedCanonicalRevisionId = requiredText(payload.expectedCanonicalRevisionId, "canonical Revision ID", 160);
  const expectedCanonicalBodySha256 = requiredText(payload.expectedCanonicalBodySha256, "canonical 正文摘要", 64);
  const expectedCanonicalCompositionId = requiredText(payload.expectedCanonicalCompositionId, "canonical Composition ID", 160);
  const expectedCanonicalCompositionSha256 = requiredText(
    payload.expectedCanonicalCompositionSha256,
    "canonical Composition 摘要",
    64,
  );
  if (!SHA256_RE.test(expectedCanonicalBodySha256) || !SHA256_RE.test(expectedCanonicalCompositionSha256)) {
    throw new ApiError("canonical 正文与 Composition 摘要必须是 64 位小写 SHA-256");
  }
  const color = cleanText(payload.color, 20) || "violet";
  const requestedAnnotation = cleanText(payload.annotation, 1000);
  const receiptPayload = {
    packageId,
    platform,
    name,
    expectedPackageLockVersion,
    expectedCanonicalBranchId,
    expectedCanonicalBranchLockVersion,
    expectedCanonicalRevisionId,
    expectedCanonicalBodySha256,
    expectedCanonicalCompositionId,
    expectedCanonicalCompositionSha256,
    color,
    annotation: requestedAnnotation,
  };
  const action = "create_publication_branch";
  const commandType = "workspace.create_publication_branch";
  const requestSha256 = await sha256Text(canonicalJson({ action, actorId, payload: receiptPayload }));
  const replay = await inspectWorkspaceReceipt(db, commandId, commandType, requestSha256, actorId);
  if (replay) return replay;

  let baseline: D1Row | null;
  try {
    baseline = await db.prepare(`SELECT package.article_id, package.status AS package_status,
        package.lock_version AS package_lock_version, package.primary_branch_id,
        package.main_composition_id, package.main_composition_sha256,
        state.status AS branch_state_status, state.lock_version AS branch_state_lock_version,
        state.head_revision_id, state.head_composition_id, state.head_composition_sha256,
        branch.status AS article_branch_status, branch.head_revision_id AS article_head_revision_id,
        revision.body_text, revision.body_sha256, revision.document_title, revision.source_version_id,
        article_copy.base_revision_id AS article_copy_base_revision_id, article_copy.dirty AS article_copy_dirty,
        package_copy.base_revision_id AS package_copy_base_revision_id,
        package_copy.base_composition_id AS package_copy_base_composition_id,
        package_copy.dirty AS package_copy_dirty
      FROM article_project_packages package
      JOIN package_branch_states state
        ON state.package_id = package.id AND state.branch_id = package.primary_branch_id
      JOIN article_branches branch
        ON branch.id = state.branch_id AND branch.article_id = package.article_id
      JOIN article_revisions revision
        ON revision.id = state.head_revision_id AND revision.branch_id = state.branch_id
      JOIN branch_working_copies article_copy
        ON article_copy.branch_id = state.branch_id AND article_copy.article_id = package.article_id
      JOIN package_branch_working_copies package_copy
        ON package_copy.package_id = package.id AND package_copy.branch_id = state.branch_id
      WHERE package.id = ? LIMIT 1`).bind(packageId).first<D1Row>();
  } catch {
    throw new ApiError("文章工程多分支存储尚未就绪，不能建立 PublicationVersion 分支", 503);
  }
  const baselineMatches = baseline
    && baseline.package_status === "active"
    && Number(baseline.package_lock_version) === expectedPackageLockVersion
    && baseline.primary_branch_id === expectedCanonicalBranchId
    && baseline.main_composition_id === expectedCanonicalCompositionId
    && baseline.main_composition_sha256 === expectedCanonicalCompositionSha256
    && baseline.branch_state_status === "active"
    && Number(baseline.branch_state_lock_version) === expectedCanonicalBranchLockVersion
    && baseline.head_revision_id === expectedCanonicalRevisionId
    && baseline.head_composition_id === expectedCanonicalCompositionId
    && baseline.head_composition_sha256 === expectedCanonicalCompositionSha256
    && baseline.article_branch_status === "active"
    && baseline.article_head_revision_id === expectedCanonicalRevisionId
    && baseline.body_sha256 === expectedCanonicalBodySha256
    && baseline.article_copy_base_revision_id === expectedCanonicalRevisionId
    && Number(baseline.article_copy_dirty) === 0
    && baseline.package_copy_base_revision_id === expectedCanonicalRevisionId
    && baseline.package_copy_base_composition_id === expectedCanonicalCompositionId
    && Number(baseline.package_copy_dirty) === 0;
  if (!baselineMatches || !baseline) {
    throw new ApiError("PublicationVersion canonical 基线已变化或不是 clean primary head；请重新回读 Package 后再建分支", 409);
  }

  const articleId = String(baseline.article_id);
  const body = String(baseline.body_text ?? "");
  const documentTitle = String(baseline.document_title ?? "");
  const sourceVersionId = baseline.source_version_id ? String(baseline.source_version_id) : null;
  const branchId = `branch-${crypto.randomUUID()}`;
  const revisionId = `revision-${crypto.randomUUID()}`;
  const workItemId = `work-${crypto.randomUUID()}`;
  const eventId = `event-${crypto.randomUUID()}`;
  const branchAnnotation = requestedAnnotation
    || `为 ${platform} PublicationVersion 从当前 canonical 基线建立独立分支；该动作不注册版本、不生成 Build，也不触发外部发布。`;
  const responsePayload = {
    branchId,
    revisionId,
    workItemId,
    articleId,
    packageId,
    platform,
    bodySha256: expectedCanonicalBodySha256,
    workingLockVersion: 1,
    createdRootRevision: true,
    boundary: {
      publicationVersionRegistered: false,
      buildCreated: false,
      releaseCreated: false,
      externalActionPerformed: false,
      publishClicked: false,
    },
  };
  const exactBaselineSql = `EXISTS (
    SELECT 1 FROM article_project_packages package
    JOIN package_branch_states state
      ON state.package_id = package.id AND state.branch_id = package.primary_branch_id
    JOIN article_branches branch
      ON branch.id = state.branch_id AND branch.article_id = package.article_id
    JOIN article_revisions revision
      ON revision.id = state.head_revision_id AND revision.branch_id = state.branch_id
    JOIN branch_working_copies article_copy
      ON article_copy.branch_id = state.branch_id AND article_copy.article_id = package.article_id
    JOIN package_branch_working_copies package_copy
      ON package_copy.package_id = package.id AND package_copy.branch_id = state.branch_id
    WHERE package.id = ? AND package.article_id = ? AND package.status = 'active'
      AND package.lock_version = ? AND package.primary_branch_id = ?
      AND package.main_composition_id = ? AND package.main_composition_sha256 = ?
      AND state.status = 'active' AND state.lock_version = ?
      AND state.head_revision_id = ? AND state.head_composition_id = ? AND state.head_composition_sha256 = ?
      AND branch.status = 'active' AND branch.head_revision_id = ?
      AND revision.body_sha256 = ?
      AND article_copy.base_revision_id = ? AND article_copy.dirty = 0
      AND package_copy.base_revision_id = ? AND package_copy.base_composition_id = ? AND package_copy.dirty = 0
  )`;
  const exactBaselineBindings = [
    packageId,
    articleId,
    expectedPackageLockVersion,
    expectedCanonicalBranchId,
    expectedCanonicalCompositionId,
    expectedCanonicalCompositionSha256,
    expectedCanonicalBranchLockVersion,
    expectedCanonicalRevisionId,
    expectedCanonicalCompositionId,
    expectedCanonicalCompositionSha256,
    expectedCanonicalRevisionId,
    expectedCanonicalBodySha256,
    expectedCanonicalRevisionId,
    expectedCanonicalRevisionId,
    expectedCanonicalCompositionId,
  ];
  const actorKind = actorId.startsWith("agent-client:") ? "agent" : "user";
  const eventPayload = canonicalJson({
    commandId,
    actorId,
    packageId,
    platform,
    name,
    canonical: {
      branchId: expectedCanonicalBranchId,
      revisionId: expectedCanonicalRevisionId,
      bodySha256: expectedCanonicalBodySha256,
      compositionId: expectedCanonicalCompositionId,
      compositionSha256: expectedCanonicalCompositionSha256,
    },
  });
  const statements = [
    db.prepare(`INSERT INTO command_receipts
      (id, command_type, actor_id, request_sha256, response_json, status_code)
      SELECT ?, ?, ?, ?, '{}', 0 WHERE ${exactBaselineSql}`)
      .bind(commandId, commandType, actorId, requestSha256, ...exactBaselineBindings),
    db.prepare(`INSERT INTO article_branches
      (id, article_id, name, slug, color, head_revision_id, base_revision_id, base_source_version_id)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?
      WHERE EXISTS (SELECT 1 FROM command_receipts WHERE id = ? AND command_type = ?
        AND actor_id = ? AND request_sha256 = ? AND status_code = 0)`)
      .bind(branchId, articleId, name, branchSlug(name), color, revisionId, expectedCanonicalRevisionId,
        sourceVersionId, commandId, commandType, actorId, requestSha256),
    db.prepare(`INSERT INTO article_revisions
      (id, article_id, branch_id, sequence, parent_revision_id, source_version_id,
       title, document_title, annotation, body_text, body_sha256, author_kind)
      SELECT ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE EXISTS (SELECT 1 FROM article_branches WHERE id = ? AND article_id = ? AND head_revision_id = ?)`)
      .bind(revisionId, articleId, branchId, expectedCanonicalRevisionId, sourceVersionId,
        `PublicationVersion 基线 · ${platform}`, documentTitle, branchAnnotation, body,
        expectedCanonicalBodySha256, actorKind, branchId, articleId, revisionId),
    db.prepare(`INSERT INTO branch_working_copies
      (branch_id, article_id, base_revision_id, title, annotation, body_text, body_sha256, dirty)
      SELECT ?, ?, ?, ?, '', ?, ?, 0
      WHERE EXISTS (SELECT 1 FROM article_revisions WHERE id = ? AND branch_id = ? AND body_sha256 = ?)`)
      .bind(branchId, articleId, revisionId, documentTitle, body, expectedCanonicalBodySha256,
        revisionId, branchId, expectedCanonicalBodySha256),
    db.prepare(`INSERT INTO work_items
      (id, article_id, branch_id, title, kind, stage, state, priority, next_action)
      SELECT ?, ?, ?, ?, 'article', 'distribution', 'open', 'P1', ?
      WHERE EXISTS (SELECT 1 FROM branch_working_copies WHERE branch_id = ? AND base_revision_id = ? AND dirty = 0)`)
      .bind(workItemId, articleId, branchId, `准备《${documentTitle}》· ${platform} PublicationVersion`,
        "接入 ArticleProject Package 后，通过候选 Patch 完成平台内容并注册 PublicationVersion",
        branchId, revisionId),
    db.prepare(`INSERT INTO workspace_events
      (id, event_type, subject_type, subject_id, article_id, payload_json, input_sha256)
      SELECT ?, 'publication.branch_created', 'branch', ?, ?, ?, ?
      WHERE EXISTS (SELECT 1 FROM work_items WHERE id = ? AND branch_id = ?)`)
      .bind(eventId, branchId, articleId, eventPayload, requestSha256, workItemId, branchId),
    db.prepare(`UPDATE command_receipts SET response_json = ?, status_code = 201, completed_at = CURRENT_TIMESTAMP
      WHERE id = ? AND command_type = ? AND actor_id = ? AND request_sha256 = ? AND status_code = 0
        AND EXISTS (SELECT 1 FROM workspace_events WHERE id = ? AND subject_id = ? AND input_sha256 = ?)`)
      .bind(canonicalJson(responsePayload), commandId, commandType, actorId, requestSha256,
        eventId, branchId, requestSha256),
    db.prepare(`SELECT CASE WHEN EXISTS (
      SELECT 1 FROM command_receipts receipt
      JOIN article_branches branch ON branch.id = ? AND branch.article_id = ?
      JOIN article_revisions revision ON revision.id = ? AND revision.branch_id = branch.id
      JOIN branch_working_copies copy ON copy.branch_id = branch.id AND copy.base_revision_id = revision.id
      JOIN work_items work ON work.id = ? AND work.branch_id = branch.id
      JOIN workspace_events event ON event.id = ? AND event.subject_id = branch.id
      WHERE receipt.id = ? AND receipt.command_type = ? AND receipt.actor_id = ?
        AND receipt.request_sha256 = ? AND receipt.status_code = 201
        AND branch.head_revision_id = revision.id AND revision.body_sha256 = ? AND copy.dirty = 0
    ) THEN 1 ELSE json('wenmai-publication-branch-create-incomplete') END AS committed`)
      .bind(branchId, articleId, revisionId, workItemId, eventId, commandId, commandType,
        actorId, requestSha256, expectedCanonicalBodySha256),
  ];
  try {
    await db.batch(statements);
  } catch (error) {
    const completed = await inspectWorkspaceReceipt(db, commandId, commandType, requestSha256, actorId);
    if (completed) return completed;
    if (error instanceof ApiError) throw error;
    throw new ApiError("PublicationVersion canonical 基线或 commandId 已变化；分支未创建", 409);
  }
  return Response.json(responsePayload, { status: 201 });
}

async function saveWorkingCopy(db: D1Database, payload: Record<string, unknown>) {
  const branchId = requiredText(payload.branchId, "分支 ID", 120);
  const packageProtection = await assertLegacyWorkspaceBranchesWritable(db, [branchId]);
  const expectedBaseRevisionId = requiredText(payload.baseRevisionId, "基线修订 ID", 120);
  const expectedLockVersion = Number(payload.lockVersion);
  if (!Number.isSafeInteger(expectedLockVersion) || expectedLockVersion < 1) throw new ApiError("工作副本锁版本无效");
  const title = requiredText(payload.title, "文章标题", 240);
  const annotation = cleanText(payload.annotation, 2000);
  const bodyText = cleanText(payload.bodyText, 2_000_000, true);
  const copy = await db.prepare("SELECT * FROM branch_working_copies WHERE branch_id = ? LIMIT 1").bind(branchId).first<D1Row>();
  if (!copy) throw new ApiError("工作副本不存在", 404);
  if (String(copy.base_revision_id) !== expectedBaseRevisionId) throw new ApiError("分支头已变化，请重新载入后再保存", 409);
  const base = await db.prepare("SELECT * FROM article_revisions WHERE id = ? LIMIT 1").bind(expectedBaseRevisionId).first<D1Row>();
  if (!base) throw new ApiError("基线修订不存在", 409);
  const bodySha256 = await sha256Text(bodyText);
  const dirty = bodySha256 !== String(base.body_sha256) || title !== String(base.document_title);
  const packageBranchGuard = packageBranchNotExistsSql(packageProtection, ["branch_working_copies.branch_id"]);
  const update = await db.prepare(`UPDATE branch_working_copies
    SET title = ?, annotation = ?, body_text = ?, body_sha256 = ?, dirty = ?,
        lock_version = lock_version + 1, updated_at = CURRENT_TIMESTAMP
    WHERE branch_id = ? AND base_revision_id = ? AND lock_version = ?
      ${packageBranchGuard}`)
    .bind(title, annotation, bodyText, bodySha256, dirty ? 1 : 0, branchId, expectedBaseRevisionId, expectedLockVersion).run();
  if (Number(update.meta.changes ?? 0) !== 1) {
    await assertLegacyWorkspaceBranchesWritable(db, [branchId]);
    throw new ApiError("工作副本已在另一窗口变化；本次保存被停止，请重新载入并人工合并", 409);
  }
  const saved = await db.prepare("SELECT * FROM branch_working_copies WHERE branch_id = ?").bind(branchId).first<D1Row>();
  return Response.json({ workingCopy: saved ? parseWorkingCopy(saved) : null });
}

async function commitRevision(db: D1Database, payload: Record<string, unknown>, authorKind: "user" | "agent" = "user") {
  const branchId = requiredText(payload.branchId, "分支 ID", 120);
  const packageProtection = await assertLegacyWorkspaceBranchesWritable(db, [branchId]);
  const expectedBaseRevisionId = requiredText(payload.baseRevisionId, "基线修订 ID", 120);
  const expectedLockVersion = Number(payload.lockVersion);
  if (!Number.isSafeInteger(expectedLockVersion) || expectedLockVersion < 1) throw new ApiError("工作副本锁版本无效");
  const expectedBodySha256 = requiredText(payload.bodySha256, "正文摘要", 64);
  if (!SHA256_RE.test(expectedBodySha256)) throw new ApiError("正文摘要格式无效");
  const revisionTitle = requiredText(payload.revisionTitle, "修订标题", 160);
  const annotation = cleanText(payload.annotation, 2000);
  const [branch, copy] = await Promise.all([
    db.prepare("SELECT * FROM article_branches WHERE id = ? AND status = 'active' LIMIT 1").bind(branchId).first<D1Row>(),
    db.prepare("SELECT * FROM branch_working_copies WHERE branch_id = ? LIMIT 1").bind(branchId).first<D1Row>(),
  ]);
  if (!branch || !copy) throw new ApiError("活动分支或工作副本不存在", 404);
  const head = await db.prepare("SELECT * FROM article_revisions WHERE id = ? LIMIT 1")
    .bind(branch.head_revision_id).first<D1Row>();
  if (!head) throw new ApiError("分支头修订不存在", 409);
  if (String(copy.base_revision_id) !== expectedBaseRevisionId || String(branch.head_revision_id) !== expectedBaseRevisionId) {
    throw new ApiError("分支头已变化，提交被停止；请重新载入并处理冲突", 409);
  }
  if (String(copy.body_sha256) !== expectedBodySha256) throw new ApiError("工作副本已变化，请等待保存完成后再提交", 409);
  if (Number(copy.lock_version ?? 1) !== expectedLockVersion) {
    throw new ApiError("工作副本已在另一窗口变化，提交被停止；请重新载入并人工合并", 409);
  }
  const revisionId = `revision-${crypto.randomUUID()}`;
  const sequenceRow = await db.prepare("SELECT COALESCE(MAX(sequence), 0) AS maximum FROM article_revisions WHERE branch_id = ?")
    .bind(branchId).first<D1Row>();
  const sequence = Number(sequenceRow?.maximum ?? 0) + 1;
  const articleId = String(branch.article_id);
  const eventId = `event-${crypto.randomUUID()}`;
  const eventPayload = JSON.stringify({
    branchId, parentRevisionId: expectedBaseRevisionId, sequence, title: revisionTitle,
  });
  // D1 batches are transactional, but a conditional UPDATE that changes zero
  // rows is still a successful SQL statement. Advance the branch first with a
  // guard that also binds the working-copy lock, then make every later write
  // depend on that new head. A losing concurrent commit therefore performs no
  // writes and is reported as 409 instead of producing an orphan revision.
  const packageBranchGuard = packageBranchNotExistsSql(packageProtection, ["article_branches.id"]);
  const commitResults = await db.batch([
    db.prepare(`UPDATE article_branches SET head_revision_id = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND article_id = ? AND status = 'active' AND head_revision_id = ?
        AND EXISTS (
          SELECT 1 FROM branch_working_copies copy
          WHERE copy.branch_id = article_branches.id
            AND copy.article_id = article_branches.article_id
            AND copy.base_revision_id = ?
            AND copy.lock_version = ?
            AND copy.body_sha256 = ?
        )
        ${packageBranchGuard}`)
      .bind(
        revisionId, branchId, articleId, expectedBaseRevisionId,
        expectedBaseRevisionId, expectedLockVersion, expectedBodySha256,
      ),
    db.prepare(`INSERT INTO article_revisions
      (id, article_id, branch_id, sequence, parent_revision_id, title, document_title, annotation, body_text, body_sha256, author_kind)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE EXISTS (
        SELECT 1 FROM article_branches WHERE id = ? AND head_revision_id = ?
      )`)
      .bind(
        revisionId, articleId, branchId, sequence, expectedBaseRevisionId, revisionTitle,
        copy.title, annotation, copy.body_text, copy.body_sha256, authorKind, branchId, revisionId,
      ),
    db.prepare(`UPDATE branch_working_copies
      SET base_revision_id = ?, annotation = '', dirty = 0, lock_version = lock_version + 1,
          updated_at = CURRENT_TIMESTAMP
      WHERE branch_id = ? AND base_revision_id = ? AND lock_version = ?
        AND EXISTS (
          SELECT 1 FROM article_branches WHERE id = ? AND head_revision_id = ?
        )`)
      .bind(revisionId, branchId, expectedBaseRevisionId, expectedLockVersion, branchId, revisionId),
    db.prepare(`INSERT INTO workspace_events
      (id, event_type, subject_type, subject_id, article_id, payload_json, input_sha256)
      SELECT ?, 'revision.committed', 'revision', ?, ?, ?, ?
      WHERE EXISTS (
        SELECT 1 FROM article_revisions revision
        JOIN article_branches branch ON branch.id = revision.branch_id AND branch.head_revision_id = revision.id
        JOIN branch_working_copies copy ON copy.branch_id = branch.id AND copy.base_revision_id = revision.id
        WHERE revision.id = ? AND copy.lock_version = ?
      )`)
      .bind(eventId, revisionId, articleId, eventPayload, expectedBodySha256, revisionId, expectedLockVersion + 1),
  ]);
  const changes = commitResults.map((result) => Number(result.meta.changes ?? 0));
  if (changes[0] !== 1) {
    await assertLegacyWorkspaceBranchesWritable(db, [branchId]);
    throw new ApiError("分支头或工作副本已并发变化，提交被停止；请重新载入并人工合并", 409);
  }
  if (changes.some((count) => count !== 1)) {
    throw new ApiError("修订事务未形成完整的分支、正文与事件链；请停止继续编辑并检查本地 D1", 503);
  }
  return Response.json({ revisionId, sequence }, { status: 201 });
}

async function createWorkItem(db: D1Database, payload: Record<string, unknown>) {
  const title = requiredText(payload.title, "工作项标题", 240);
  const stage = cleanText(payload.stage, 40) || "inbox";
  const state = cleanText(payload.state, 20) || "open";
  const priority = cleanText(payload.priority, 8) || "P2";
  if (!STAGES.has(stage) || !WORK_STATES.has(state) || !PRIORITIES.has(priority)) throw new ApiError("工作项状态无效");
  const id = `work-${crypto.randomUUID()}`;
  const articleId = cleanText(payload.articleId, 120) || null;
  const branchId = cleanText(payload.branchId, 120) || null;
  const nextAction = cleanText(payload.nextAction, 1000);
  const sourceCapabilityId = cleanText(payload.sourceCapabilityId, 200) || null;
  const inputSha256 = await sha256Text(JSON.stringify({ title, stage, articleId, branchId, sourceCapabilityId }));
  await db.batch([
    db.prepare(`INSERT INTO work_items
      (id, article_id, branch_id, title, kind, stage, state, priority, owner, next_action, source_capability_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(id, articleId, branchId, title, cleanText(payload.kind, 40) || "article", stage, state, priority, cleanText(payload.owner, 80) || "我", nextAction, sourceCapabilityId),
    eventInsert(db, "work_item.created", "work_item", id, articleId, { title, stage, state, priority, branchId, sourceCapabilityId }, inputSha256),
  ]);
  return Response.json({ id }, { status: 201 });
}

async function updateWorkItem(db: D1Database, payload: Record<string, unknown>) {
  const id = requiredText(payload.id, "工作项 ID", 120);
  const existing = await db.prepare("SELECT * FROM work_items WHERE id = ? LIMIT 1").bind(id).first<D1Row>();
  if (!existing) throw new ApiError("工作项不存在", 404);
  const stage = cleanText(payload.stage, 40) || String(existing.stage);
  const state = cleanText(payload.state, 20) || String(existing.state);
  const priority = cleanText(payload.priority, 8) || String(existing.priority);
  if (!STAGES.has(stage) || !WORK_STATES.has(state) || !PRIORITIES.has(priority)) throw new ApiError("工作项状态无效");
  const nextAction = payload.nextAction === undefined ? String(existing.next_action ?? "") : cleanText(payload.nextAction, 1000);
  const blocker = payload.blocker === undefined ? String(existing.blocker ?? "") : cleanText(payload.blocker, 1000);
  const inputSha256 = await sha256Text(JSON.stringify({ id, stage, state, priority, nextAction, blocker }));
  await db.batch([
    db.prepare(`UPDATE work_items SET stage = ?, state = ?, priority = ?, next_action = ?, blocker = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .bind(stage, state, priority, nextAction, blocker, id),
    eventInsert(db, "work_item.updated", "work_item", id, existing.article_id ? String(existing.article_id) : null, {
      fromStage: existing.stage, stage, fromState: existing.state, state, priority, nextAction, blocker,
    }, inputSha256),
  ]);
  return Response.json({ id, stage, state });
}

function evaluateGates(title: string, body: string) {
  const compactLength = body.replace(/\s/g, "").length;
  const headings = body.split("\n").filter((line) => /^\s{0,3}#{1,6}\s+\S/.test(line)).length;
  const paragraphs = body.split(/\n\s*\n/).filter((part) => part.trim().length > 0).length;
  const sentences = body.split(/[。！？!?]+/).map((part) => part.replace(/\s/g, "")).filter(Boolean);
  const longSentences = sentences.filter((sentence) => sentence.length > 60).length;
  const longRatio = sentences.length ? longSentences / sentences.length : 0;
  const placeholders = body.match(/TODO|TBD|FIXME|待补|待核|占位|【[^】]{0,16}(?:待|TODO)[^】]*】/gi) ?? [];
  return [
    {
      gateId: "builtin:title-v1", gateLabel: "标题长度", result: title.trim().length >= 4 && title.trim().length <= 120 ? "pass" : "fail",
      evidence: [`标题长度 ${title.trim().length} 字符；规则范围 4–120。`], details: { titleLength: title.trim().length, minimum: 4, maximum: 120 },
    },
    {
      gateId: "builtin:structure-v1", gateLabel: "长文结构", result: compactLength < 800 ? "inconclusive" : paragraphs >= 3 && (compactLength < 1200 || headings >= 1) ? "pass" : "fail",
      evidence: [`正文 ${compactLength} 字，${paragraphs} 个段落，${headings} 个 Markdown 标题。`], details: { compactLength, paragraphs, headings },
    },
    {
      gateId: "builtin:long-sentence-v1", gateLabel: "长句提醒", result: sentences.length < 4 ? "inconclusive" : longRatio <= 0.2 ? "pass" : "fail",
      evidence: [`${sentences.length} 个可识别句子中有 ${longSentences} 个超过 60 字；占比 ${(longRatio * 100).toFixed(1)}%。`],
      details: { sentences: sentences.length, longSentences, longRatio: Number(longRatio.toFixed(4)), threshold: 0.2 },
    },
    {
      gateId: "builtin:placeholder-v1", gateLabel: "占位符扫描", result: placeholders.length === 0 ? "pass" : "fail",
      evidence: placeholders.length ? [`发现 ${placeholders.length} 个待补/占位标记：${[...new Set(placeholders)].slice(0, 8).join("、")}`] : ["未发现内置词表中的待补或占位标记。"],
      details: { placeholderCount: placeholders.length },
    },
  ] as const;
}

async function runBuiltinGates(db: D1Database, payload: Record<string, unknown>) {
  const branchId = requiredText(payload.branchId, "分支 ID", 120);
  const expectedBodySha256 = requiredText(payload.bodySha256, "正文摘要", 64);
  const copy = await db.prepare("SELECT * FROM branch_working_copies WHERE branch_id = ? LIMIT 1").bind(branchId).first<D1Row>();
  if (!copy) throw new ApiError("工作副本不存在", 404);
  if (String(copy.body_sha256) !== expectedBodySha256) throw new ApiError("正文已变化，请等待保存完成后再运行门禁", 409);
  const runGroupId = `gate-suite-${crypto.randomUUID()}`;
  const results = evaluateGates(String(copy.title), String(copy.body_text ?? ""));
  const inputSha256 = await sha256Text(JSON.stringify({
    branchId,
    revisionId: copy.base_revision_id,
    documentTitle: copy.title,
    bodySha256: expectedBodySha256,
  }));
  const statements = results.map((result) => db.prepare(`INSERT INTO gate_runs
    (id, run_group_id, article_id, branch_id, revision_id, gate_id, gate_label, result, input_sha256, evidence_json, details_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(
      `gate-${crypto.randomUUID()}`, runGroupId, copy.article_id, branchId, copy.base_revision_id,
      result.gateId, result.gateLabel, result.result, inputSha256, JSON.stringify(result.evidence),
      JSON.stringify({ ...result.details, documentTitle: copy.title, bodySha256: expectedBodySha256, revisionId: copy.base_revision_id }),
    ));
  statements.push(eventInsert(db, "gate_suite.completed", "branch", branchId, String(copy.article_id), {
    runGroupId, results: results.map((item) => ({ gateId: item.gateId, result: item.result })),
  }, inputSha256));
  await db.batch(statements);
  const saved = await db.prepare("SELECT * FROM gate_runs WHERE run_group_id = ? ORDER BY gate_id").bind(runGroupId).all<D1Row>();
  return Response.json({ runGroupId, gateRuns: saved.results.map(parseGateRun) }, { status: 201 });
}

async function updateCapability(db: D1Database, payload: Record<string, unknown>) {
  const capabilityId = requiredText(payload.capabilityId, "能力 ID", 240);
  const adoptionStatus = cleanText(payload.adoptionStatus, 20) || "unassessed";
  if (!ADOPTION_STATES.has(adoptionStatus)) throw new ApiError("能力成熟度无效");
  const notes = cleanText(payload.notes, 3000);
  const evidenceRef = cleanText(payload.evidenceRef, 1000);
  const regressionRef = cleanText(payload.regressionRef, 1000);
  const favorite = Boolean(payload.favorite);
  if (["candidate", "tested", "verified", "adopted", "deferred", "rejected"].includes(adoptionStatus) && notes.length < 8) {
    throw new ApiError("成熟度决定需要至少 8 个字的范围或理由");
  }
  if (["tested", "verified", "adopted"].includes(adoptionStatus) && !evidenceRef) throw new ApiError("tested/verified/adopted 必须绑定测试或任务证据");
  if (adoptionStatus === "adopted" && !regressionRef) throw new ApiError("adopted 必须绑定回归入口");
  const inputSha256 = await sha256Text(JSON.stringify({ capabilityId, adoptionStatus, notes, evidenceRef, regressionRef }));
  await db.batch([
    db.prepare(`INSERT INTO capability_overrides
      (capability_id, adoption_status, notes, evidence_ref, regression_ref, favorite, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(capability_id) DO UPDATE SET
        adoption_status = excluded.adoption_status,
        notes = excluded.notes,
        evidence_ref = excluded.evidence_ref,
        regression_ref = excluded.regression_ref,
        favorite = excluded.favorite,
        updated_at = CURRENT_TIMESTAMP`)
      .bind(capabilityId, adoptionStatus, notes, evidenceRef, regressionRef, favorite ? 1 : 0),
    eventInsert(db, "capability.decision", "capability", capabilityId, null, { adoptionStatus, notes, evidenceRef, regressionRef, favorite }, inputSha256),
  ]);
  return Response.json({ capabilityId, adoptionStatus });
}

async function createProductionRun(db: D1Database, payload: Record<string, unknown>) {
  const recipeId = requiredText(payload.recipeId, "生产路线 ID", 120);
  const articleId = requiredText(payload.articleId, "文章 ID", 120);
  const branchId = requiredText(payload.branchId, "分支 ID", 120);
  const recipe = FACTORY_RECIPES.find((item) => item.id === recipeId);
  if (!recipe) throw new ApiError("生产路线不存在", 404);
  const branch = await db.prepare("SELECT * FROM article_branches WHERE id = ? AND article_id = ? AND status = 'active' LIMIT 1")
    .bind(branchId, articleId).first<D1Row>();
  if (!branch) throw new ApiError("生产路线必须绑定这篇文章的一条活动分支", 409);
  const id = `run-${crypto.randomUUID()}`;
  const title = cleanText(payload.title, 240) || `${recipe.title} · ${String(branch.name)}`;
  const recipeSha256 = await sha256Text(JSON.stringify(recipe));
  const frozenSteps = recipe.steps.map((step, position) => ({
    ...step,
    dependsOn: step.dependsOn ?? (position > 0 ? [recipe.steps[position - 1].id] : []),
    writeScope: step.writeScope ?? (step.actorKind === "agent" ? "artifact-only" : "none"),
  }));
  const initialSteps = frozenSteps.filter((step) => step.dependsOn.length === 0).map((step) => step.id);
  const inputSha256 = await sha256Text(JSON.stringify({ recipeId, recipeVersion: recipe.version, recipeSha256, articleId, branchId, title }));
  const statements = [
    db.prepare(`INSERT INTO production_runs
      (id, recipe_id, recipe_version, recipe_sha256, article_id, branch_id, title, status, current_step_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?)`)
      .bind(id, recipeId, recipe.version, recipeSha256, articleId, branchId, title, initialSteps[0] ?? null),
    ...frozenSteps.map((step, position) => db.prepare(`INSERT INTO production_run_steps
      (id, run_id, step_id, position, title, actor_kind, agent_role, depends_on_json, write_scope, runner_action, capability_id, gate_id, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(
        `run-step-${crypto.randomUUID()}`, id, step.id, position, step.title, step.actorKind,
        step.agentRole ?? null, JSON.stringify(step.dependsOn), step.writeScope,
        step.runnerAction ?? null, step.capabilityId ?? null, step.gateId ?? null,
        step.dependsOn.length === 0 ? "active" : "pending",
      )),
    eventInsert(db, "production_run.created", "production_run", id, articleId, {
      recipeId, recipeVersion: recipe.version, recipeSha256, topology: recipe.topology, branchId, title, initialSteps,
    }, inputSha256),
  ];
  await db.batch(statements);
  return Response.json({ id }, { status: 201 });
}

async function updateProductionStep(db: D1Database, payload: Record<string, unknown>) {
  const runId = requiredText(payload.runId, "生产运行 ID", 120);
  const stepId = requiredText(payload.stepId, "工位 ID", 120);
  const status = requiredText(payload.status, "工位状态", 20);
  if (!STEP_STATES.has(status)) throw new ApiError("工位状态无效");
  let evidenceNote = cleanText(payload.evidenceNote, 50_000);
  const [run, step] = await Promise.all([
    db.prepare("SELECT * FROM production_runs WHERE id = ? LIMIT 1").bind(runId).first<D1Row>(),
    db.prepare("SELECT * FROM production_run_steps WHERE run_id = ? AND step_id = ? LIMIT 1").bind(runId, stepId).first<D1Row>(),
  ]);
  if (!run || !step) throw new ApiError("生产运行或工位不存在", 404);
  const beforeRows = await db.prepare("SELECT * FROM production_run_steps WHERE run_id = ? ORDER BY position")
    .bind(runId).all<D1Row>();
  const isInformationCoverStep = isInformationCoverRecipeStep(String(step.step_id))
    && (String(step.capability_id ?? "") === INFORMATION_COVER_CAPABILITY_ID
      || String(run.recipe_id) === "evidence-led-longform-v1");
  if (isInformationCoverStep && status === "skipped") {
    throw new ApiError("信息型知识封面 v2 的四个工位禁止 skipped；请阻塞、修复证据或退回变更", 409);
  }
  if (["complete", "skipped"].includes(status) && evidenceNote.length < 4) throw new ApiError("完成或跳过工位时需要留下证据或理由");
  let externalArtifactReceiptVerified = false;
  let verifiedCoverBodySha256 = "";
  if (isInformationCoverStep && status === "complete") {
    const currentBinding = await db.prepare(`SELECT
        revision.body_sha256 AS head_body_sha256,
        branch.head_revision_id AS head_revision_id,
        working.base_revision_id AS working_base_revision_id,
        working.body_sha256 AS working_body_sha256,
        working.dirty AS working_dirty
      FROM production_runs run
      JOIN article_branches branch
        ON branch.id = run.branch_id AND branch.article_id = run.article_id AND branch.status = 'active'
      JOIN article_revisions revision
        ON revision.id = branch.head_revision_id AND revision.branch_id = branch.id AND revision.article_id = run.article_id
      JOIN branch_working_copies working
        ON working.branch_id = branch.id AND working.article_id = run.article_id
      WHERE run.id = ? LIMIT 1`).bind(runId).first<D1Row>();
    if (!currentBinding
      || Number(currentBinding.working_dirty ?? 1) !== 0
      || String(currentBinding.working_base_revision_id ?? "") !== String(currentBinding.head_revision_id ?? "")
      || String(currentBinding.working_body_sha256 ?? "") !== String(currentBinding.head_body_sha256 ?? "")) {
      throw new ApiError("当前分支头与干净工作副本未对齐；封面回执按 stale 失败关闭", 409);
    }
    let expectedInputSha256 = String(currentBinding.head_body_sha256);
    const currentCoverStepIndex = INFORMATION_COVER_RECIPE_STEP_IDS.indexOf(stepId as typeof INFORMATION_COVER_RECIPE_STEP_IDS[number]);
    for (const upstreamStepId of INFORMATION_COVER_RECIPE_STEP_IDS.slice(0, currentCoverStepIndex)) {
      const upstreamStep = beforeRows.results.find((item) => String(item.step_id) === upstreamStepId);
      const upstreamEvidence = upstreamStep ? parseJson<string[]>(upstreamStep.evidence_json, []).at(-1) : null;
      if (!upstreamStep || String(upstreamStep.status) !== "complete" || !upstreamEvidence) {
        throw new ApiError(`上游封面工位 ${upstreamStepId} 缺少真实 complete 的 v2 结构化回执`, 409);
      }
      const upstreamValidation = validateInformationCoverEvidenceReceipt(upstreamEvidence, {
        expectedStepId: upstreamStepId,
        expectedArticleBodySha256: String(currentBinding.head_body_sha256),
        expectedInputSha256,
      });
      if (!upstreamValidation.valid || !upstreamValidation.receipt) {
        throw new ApiError(`上游封面工位 ${upstreamStepId} 的回执已 stale：${upstreamValidation.errors.join("；")}`, 409);
      }
      expectedInputSha256 = upstreamValidation.receipt.artifact.sha256;
    }
    const validation = validateInformationCoverEvidenceReceipt(evidenceNote, {
      expectedStepId: stepId,
      expectedArticleBodySha256: String(currentBinding.head_body_sha256),
      expectedInputSha256,
    });
    if (!validation.valid || !validation.receipt) {
      throw new ApiError(`信息型知识封面 v2 外部工件回执无效：${validation.errors.join("；")}`, 409);
    }
    evidenceNote = JSON.stringify(validation.receipt);
    verifiedCoverBodySha256 = validation.receipt.bindings.articleBodySha256;
    externalArtifactReceiptVerified = true;
  }
  if (status === "complete" && String(step.actor_kind) !== "human" && !externalArtifactReceiptVerified) {
    throw new ApiError("Agent 或脚本工位只能由受验证的 Runner 回执完成；人工可以带理由跳过，但不能冒充执行器", 409);
  }
  const dependencies = parseJson<string[]>(step.depends_on_json, []);
  const terminalStepIds = new Set(beforeRows.results
    .filter((item) => ["complete", "skipped"].includes(String(item.status)))
    .map((item) => String(item.step_id)));
  const completeStepIds = new Set(beforeRows.results
    .filter((item) => String(item.status) === "complete")
    .map((item) => String(item.step_id)));
  const requiredDependencyIds = isInformationCoverStep ? completeStepIds : terminalStepIds;
  if (status === "complete" && dependencies.some((dependency) => !requiredDependencyIds.has(dependency))) {
    throw new ApiError(isInformationCoverStep
      ? "信息型知识封面 v2 的上游工位必须真实 complete，skipped 不能满足依赖"
      : "该工位的上游工件尚未完成；先完成或带理由跳过依赖工位", 409);
  }
  const evidence = parseJson<string[]>(step.evidence_json, []);
  if (evidenceNote) evidence.push(evidenceNote);
  const stepUpdate = externalArtifactReceiptVerified
    ? await db.prepare(`UPDATE production_run_steps SET status = ?, evidence_json = ?, updated_at = CURRENT_TIMESTAMP
        WHERE run_id = ? AND step_id = ? AND EXISTS (
          SELECT 1 FROM production_runs run
          JOIN article_branches branch
            ON branch.id = run.branch_id AND branch.article_id = run.article_id AND branch.status = 'active'
          JOIN article_revisions revision
            ON revision.id = branch.head_revision_id AND revision.branch_id = branch.id AND revision.article_id = run.article_id
          JOIN branch_working_copies working
            ON working.branch_id = branch.id AND working.article_id = run.article_id
          WHERE run.id = production_run_steps.run_id
            AND revision.body_sha256 = ?
            AND working.dirty = 0
            AND working.base_revision_id = branch.head_revision_id
            AND working.body_sha256 = revision.body_sha256
        )`)
      .bind(status, JSON.stringify(evidence), runId, stepId, verifiedCoverBodySha256).run()
    : await db.prepare(`UPDATE production_run_steps SET status = ?, evidence_json = ?, updated_at = CURRENT_TIMESTAMP
        WHERE run_id = ? AND step_id = ?`)
      .bind(status, JSON.stringify(evidence), runId, stepId).run();
  if (externalArtifactReceiptVerified && Number(stepUpdate.meta.changes ?? 0) !== 1) {
    throw new ApiError("正文分支头在封面回执核验后发生变化；本次完成未写入，回执已 stale", 409);
  }
  let rows = await db.prepare("SELECT * FROM production_run_steps WHERE run_id = ? ORDER BY position").bind(runId).all<D1Row>();
  if (isInformationCoverStep && status !== "complete") {
    await db.prepare(`UPDATE production_run_steps SET status = 'pending', updated_at = CURRENT_TIMESTAMP
      WHERE run_id = ? AND position > ?
        AND step_id IN ('cover-copy-contract', 'cover-visual-plan', 'cover-render-gates', 'cover-human-acceptance', 'package')`)
      .bind(runId, Number(step.position)).run();
    rows = await db.prepare("SELECT * FROM production_run_steps WHERE run_id = ? ORDER BY position").bind(runId).all<D1Row>();
  }
  const nowTerminal = new Set(rows.results
    .filter((item) => ["complete", "skipped"].includes(String(item.status)))
    .map((item) => String(item.step_id)));
  const coverStepsInRun = rows.results.filter((item) => isInformationCoverRecipeStep(String(item.step_id)));
  const newlyRunnable = rows.results.filter((item) => {
    if (String(item.status) !== "pending") return false;
    const dependenciesSatisfied = parseJson<string[]>(item.depends_on_json, [])
      .every((dependency) => nowTerminal.has(dependency));
    if (!dependenciesSatisfied) return false;
    return String(item.step_id) !== "package"
      || coverStepsInRun.length === 0
      || informationCoverPackageReady(coverStepsInRun.map((coverStep) => ({
        stepId: String(coverStep.step_id),
        status: String(coverStep.status),
      })));
  });
  if (newlyRunnable.length) {
    await db.batch(newlyRunnable.map((item) => db.prepare(`UPDATE production_run_steps
      SET status = 'active', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'pending'`).bind(item.id)));
    rows = await db.prepare("SELECT * FROM production_run_steps WHERE run_id = ? ORDER BY position").bind(runId).all<D1Row>();
  }
  const allTerminal = rows.results.every((item) => ["complete", "skipped"].includes(String(item.status)));
  const next = rows.results.find((item) => String(item.status) === "active")
    ?? rows.results.find((item) => !["complete", "skipped"].includes(String(item.status)));
  const runStatus = allTerminal ? "complete" : "active";
  const inputSha256 = await sha256Text(JSON.stringify({ runId, stepId, status, evidenceNote }));
  await db.batch([
    db.prepare("UPDATE production_runs SET status = ?, current_step_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
      .bind(runStatus, next ? String(next.step_id) : null, runId),
    eventInsert(db, "production_step.updated", "production_run", runId, String(run.article_id), {
      stepId, status, evidenceNote, externalArtifactReceiptVerified, runStatus,
      activatedStepIds: newlyRunnable.map((item) => item.step_id),
    }, inputSha256),
  ]);
  return Response.json({ runId, stepId, status, externalArtifactReceiptVerified, runStatus });
}

function ancestorDistances(headRevisionId: string, revisions: D1Row[]) {
  const byId = new Map(revisions.map((revision) => [String(revision.id), revision]));
  const distances = new Map<string, number>();
  const queue: Array<{ id: string; distance: number }> = [{ id: headRevisionId, distance: 0 }];
  while (queue.length) {
    const current = queue.shift()!;
    const observed = distances.get(current.id);
    if (observed !== undefined && observed <= current.distance) continue;
    distances.set(current.id, current.distance);
    const revision = byId.get(current.id);
    if (!revision) continue;
    for (const parent of [revision.parent_revision_id, revision.merge_parent_revision_id]) {
      if (parent) queue.push({ id: String(parent), distance: current.distance + 1 });
    }
  }
  return distances;
}

function uniqueMergeBase(sourceHead: string, targetHead: string, revisions: D1Row[]) {
  const sourceDistances = ancestorDistances(sourceHead, revisions);
  const targetDistances = ancestorDistances(targetHead, revisions);
  const common = [...sourceDistances.keys()].filter((id) => targetDistances.has(id));
  if (!common.length) throw new ApiError("两条分支没有共同的修订祖先；请从同一修订建立适配分支后再合并", 422);
  const maximal = common.filter((candidate) => !common.some((other) => other !== candidate
    && ancestorDistances(other, revisions).has(candidate)));
  if (maximal.length !== 1) throw new ApiError("分支存在多个不可比较的最佳共同祖先；当前人工合并器不会猜测基线", 422);
  return maximal[0];
}

async function inspectWorkspaceReceipt(db: D1Database, commandId: string, commandType: string, requestSha256: string, actorId: string) {
  const receipt = await db.prepare("SELECT * FROM command_receipts WHERE id = ? LIMIT 1").bind(commandId).first<D1Row>();
  if (!receipt) return null;
  if (receipt.command_type !== commandType || receipt.actor_id !== actorId || receipt.request_sha256 !== requestSha256) {
    throw new ApiError("COMMAND_ID_REUSED: 同一 commandId 已绑定不同的动作、身份或请求摘要", 409);
  }
  if (Number(receipt.status_code) > 0) {
    return Response.json({ ...parseJson<Record<string, unknown>>(receipt.response_json, {}), replayed: true }, { status: Number(receipt.status_code) });
  }
  throw new ApiError("COMMAND_IN_PROGRESS: 命令仍在处理或上次状态未确认；禁止自动重试", 409);
}

async function withAgentWorkspaceReceipt(
  db: D1Database, action: string, actorId: string, commandId: string,
  payload: Record<string, unknown>, handler: () => Promise<Response>,
) {
  const commandType = `workspace.${action}`;
  const requestSha256 = await sha256Text(canonicalJson({ action, actorId, payload }));
  const replay = await inspectWorkspaceReceipt(db, commandId, commandType, requestSha256, actorId);
  if (replay) return replay;
  try {
    await db.prepare(`INSERT INTO command_receipts
      (id, command_type, actor_id, request_sha256, response_json, status_code)
      VALUES (?, ?, ?, ?, '{}', 0)`).bind(commandId, commandType, actorId, requestSha256).run();
  } catch {
    const raced = await inspectWorkspaceReceipt(db, commandId, commandType, requestSha256, actorId);
    if (raced) return raced;
    throw new ApiError("COMMAND_IN_PROGRESS: 命令领取发生竞争；禁止自动重试", 409);
  }
  try {
    const response = await handler();
    const data = await response.clone().json() as Record<string, unknown>;
    await db.prepare(`UPDATE command_receipts SET response_json = ?, status_code = ?, completed_at = CURRENT_TIMESTAMP
      WHERE id = ? AND command_type = ? AND actor_id = ? AND request_sha256 = ? AND status_code = 0`)
      .bind(canonicalJson(data), response.status, commandId, commandType, actorId, requestSha256).run();
    return response;
  } catch (error) {
    const status = error instanceof ApiError ? error.status : 500;
    const message = error instanceof Error ? error.message : "工作区操作失败";
    await db.prepare(`UPDATE command_receipts SET response_json = ?, status_code = ?, completed_at = CURRENT_TIMESTAMP
      WHERE id = ? AND command_type = ? AND actor_id = ? AND request_sha256 = ? AND status_code = 0`)
      .bind(canonicalJson({ error: message, code: "WORKSPACE_COMMAND_FAILED" }), status,
        commandId, commandType, actorId, requestSha256).run();
    throw error;
  }
}

async function prepareMerge(db: D1Database, payload: Record<string, unknown>, actorId: string) {
  const commandId = requiredText(payload.commandId, "commandId", 160);
  const articleId = requiredText(payload.articleId, "文章 ID", 120);
  const sourceBranchId = requiredText(payload.sourceBranchId, "来源分支", 120);
  const targetBranchId = requiredText(payload.targetBranchId, "目标分支", 120);
  const expectedSourceHeadRevisionId = requiredText(payload.expectedSourceHeadRevisionId, "来源分支头", 160);
  const expectedTargetHeadRevisionId = requiredText(payload.expectedTargetHeadRevisionId, "目标分支头", 160);
  const expectedSourceCopyLockVersion = Number(payload.expectedSourceCopyLockVersion);
  const expectedTargetCopyLockVersion = Number(payload.expectedTargetCopyLockVersion);
  if (!Number.isSafeInteger(expectedSourceCopyLockVersion) || expectedSourceCopyLockVersion < 1
    || !Number.isSafeInteger(expectedTargetCopyLockVersion) || expectedTargetCopyLockVersion < 1) {
    throw new ApiError("合并工作副本锁版本无效");
  }
  if (sourceBranchId === targetBranchId) throw new ApiError("来源分支与目标分支不能相同");

  const action = "prepare_merge";
  const receiptPayload = { articleId, sourceBranchId, targetBranchId, expectedSourceHeadRevisionId,
    expectedTargetHeadRevisionId, expectedSourceCopyLockVersion, expectedTargetCopyLockVersion };
  const requestSha256 = await sha256Text(canonicalJson({ action, actorId, payload: receiptPayload }));
  const commandType = "workspace.prepare_merge";
  const replay = await inspectWorkspaceReceipt(db, commandId, commandType, requestSha256, actorId);
  if (replay) return replay;

  const packageProtection = await assertLegacyWorkspaceBranchesWritable(db, [sourceBranchId, targetBranchId]);
  const [branches, copies, revisions] = await db.batch([
    db.prepare("SELECT * FROM article_branches WHERE article_id = ? AND id IN (?, ?) AND status = 'active'")
      .bind(articleId, sourceBranchId, targetBranchId),
    db.prepare("SELECT * FROM branch_working_copies WHERE article_id = ? AND branch_id IN (?, ?)")
      .bind(articleId, sourceBranchId, targetBranchId),
    db.prepare("SELECT * FROM article_revisions WHERE article_id = ?").bind(articleId),
  ]);
  if (branches.results.length !== 2) throw new ApiError("分支不存在或不属于这篇文章", 409);
  const source = branches.results.find((item) => item.id === sourceBranchId)!;
  const target = branches.results.find((item) => item.id === targetBranchId)!;
  const sourceCopy = copies.results.find((item) => item.branch_id === sourceBranchId);
  const targetCopy = copies.results.find((item) => item.branch_id === targetBranchId);
  if (!sourceCopy || !targetCopy
    || String(source.head_revision_id) !== expectedSourceHeadRevisionId
    || String(target.head_revision_id) !== expectedTargetHeadRevisionId
    || Boolean(sourceCopy.dirty) || Boolean(targetCopy.dirty)
    || sourceCopy.base_revision_id !== source.head_revision_id
    || targetCopy.base_revision_id !== target.head_revision_id
    || Number(sourceCopy.lock_version) !== expectedSourceCopyLockVersion
    || Number(targetCopy.lock_version) !== expectedTargetCopyLockVersion) {
    throw new ApiError("合并坐标已过期；两条分支必须保持 active、clean、base=head 且锁版本精确一致", 409);
  }

  const packageBranchGuard = packageBranchNotExistsSql(packageProtection, ["source.id", "target.id"]);
  const exactStateSql = `EXISTS (SELECT 1
    FROM article_branches source
    JOIN article_branches target ON target.id = ? AND target.article_id = source.article_id
    JOIN branch_working_copies source_copy ON source_copy.branch_id = source.id AND source_copy.article_id = source.article_id
    JOIN branch_working_copies target_copy ON target_copy.branch_id = target.id AND target_copy.article_id = target.article_id
    WHERE source.id = ? AND source.article_id = ?
      AND source.status = 'active' AND target.status = 'active'
      AND source.head_revision_id = ? AND target.head_revision_id = ?
      AND source_copy.base_revision_id = source.head_revision_id AND source_copy.dirty = 0 AND source_copy.lock_version = ?
      AND target_copy.base_revision_id = target.head_revision_id AND target_copy.dirty = 0 AND target_copy.lock_version = ?
      ${packageBranchGuard})`;
  const exactStateBindings = [targetBranchId, sourceBranchId, articleId, expectedSourceHeadRevisionId,
    expectedTargetHeadRevisionId, expectedSourceCopyLockVersion, expectedTargetCopyLockVersion];

  const persistWinnerReceipt = async (winner: D1Row, competed: boolean) => {
    const responsePayload = { proposal: parseMergeProposal(winner), reused: true, ...(competed ? { competed: true } : {}) };
    try {
      const result = await db.prepare(`INSERT INTO command_receipts
        (id, command_type, actor_id, request_sha256, response_json, status_code, completed_at)
        SELECT ?, ?, ?, ?, ?, 200, CURRENT_TIMESTAMP
        WHERE ${exactStateSql}
          AND EXISTS (SELECT 1 FROM merge_proposals WHERE id = ?
            AND source_branch_id = ? AND target_branch_id = ?
            AND source_head_revision_id = ? AND target_head_revision_id = ?
            AND status IN ('prepared', 'resolving', 'ready'))`)
        .bind(commandId, commandType, actorId, requestSha256, canonicalJson(responsePayload),
          ...exactStateBindings, winner.id, sourceBranchId, targetBranchId,
          expectedSourceHeadRevisionId, expectedTargetHeadRevisionId).run();
      if (Number(result.meta.changes ?? 0) !== 1) {
        throw new ApiError("合并坐标已变化；未绑定命令回执", 409);
      }
      return Response.json(responsePayload);
    } catch (error) {
      const raced = await inspectWorkspaceReceipt(db, commandId, commandType, requestSha256, actorId);
      if (raced) return raced;
      if (error instanceof ApiError) throw error;
      throw new ApiError("合并坐标已变化；未绑定命令回执", 409);
    }
  };

  const existing = await db.prepare(`SELECT * FROM merge_proposals
    WHERE source_branch_id = ? AND target_branch_id = ?
      AND source_head_revision_id = ? AND target_head_revision_id = ?
      AND status IN ('prepared', 'resolving', 'ready') ORDER BY created_at DESC LIMIT 1`)
    .bind(sourceBranchId, targetBranchId, expectedSourceHeadRevisionId, expectedTargetHeadRevisionId).first<D1Row>();
  if (existing) return persistWinnerReceipt(existing, false);

  const revisionRows = revisions.results as D1Row[];
  const baseRevisionId = uniqueMergeBase(expectedSourceHeadRevisionId, expectedTargetHeadRevisionId, revisionRows);
  const byId = new Map(revisionRows.map((revision) => [String(revision.id), revision]));
  const base = byId.get(baseRevisionId);
  const sourceHead = byId.get(expectedSourceHeadRevisionId);
  const targetHead = byId.get(expectedTargetHeadRevisionId);
  if (!base || !sourceHead || !targetHead) throw new ApiError("合并修订链不完整", 409);

  const proposalId = `merge-${crypto.randomUUID()}`;
  const workItemId = `work-${crypto.randomUUID()}`;
  const bodyConflict = sourceHead.body_sha256 !== targetHead.body_sha256;
  const titleConflict = sourceHead.document_title !== targetHead.document_title;
  const unresolvedCount = Number(bodyConflict) + Number(titleConflict);
  const algorithmVersion = "manual-three-way-v1";
  const preview = {
    algorithmVersion,
    mode: "whole-document-manual-resolution",
    base: { revisionId: baseRevisionId, sha256: base.body_sha256, title: base.document_title, excerpt: String(base.body_text ?? "").slice(0, 360) },
    source: { revisionId: expectedSourceHeadRevisionId, sha256: sourceHead.body_sha256, title: sourceHead.document_title, excerpt: String(sourceHead.body_text ?? "").slice(0, 360) },
    target: { revisionId: expectedTargetHeadRevisionId, sha256: targetHead.body_sha256, title: targetHead.document_title, excerpt: String(targetHead.body_text ?? "").slice(0, 360) },
    conflicts: [
      ...(titleConflict ? [{ id: "document-title", kind: "title", label: "来源与目标标题不同；需要确认解决稿标题" }] : []),
      ...(bodyConflict ? [{ id: "whole-document", kind: "body", label: "来源与目标正文不同；需要确认完整解决稿" }] : []),
    ],
  };
  const previewJson = canonicalJson(preview);
  const previewSha256 = await sha256Text(canonicalJson({ articleId, baseRevisionId,
    sourceHead: expectedSourceHeadRevisionId, targetHead: expectedTargetHeadRevisionId,
    baseSha: base.body_sha256, sourceSha: sourceHead.body_sha256,
    targetSha: targetHead.body_sha256, algorithmVersion, preview }));
  const resolvedBodyText = String(targetHead.body_text ?? "");
  const resolvedBodySha256 = await sha256Text(resolvedBodyText);
  const status = unresolvedCount ? "prepared" : "ready";
  const nextAction = `在合并工位中比较“${String(source.name)}”与“${String(target.name)}”，保存完整解决稿后创建双父修订。`;
  const createdAt = new Date().toISOString();
  const proposalPayload = {
    id: proposalId, workItemId, articleId, sourceBranchId, targetBranchId, baseRevisionId,
    sourceHeadRevisionId: expectedSourceHeadRevisionId, targetHeadRevisionId: expectedTargetHeadRevisionId,
    baseSha256: String(base.body_sha256), sourceHeadSha256: String(sourceHead.body_sha256),
    targetHeadSha256: String(targetHead.body_sha256), algorithmVersion, preview, previewSha256,
    resolvedDocumentTitle: String(targetHead.document_title), resolvedBodyText, resolvedBodySha256,
    resolution: {}, resolutionNote: "", unresolvedCount, status, lockVersion: 1, mergeRevisionId: null,
    createdAt, updatedAt: createdAt,
  };
  const responsePayload = { proposal: proposalPayload };
  const eventId = `event-${crypto.randomUUID()}`;
  const eventPayload = canonicalJson({ commandId, actorId, workItemId, sourceBranchId, targetBranchId,
    baseRevisionId, previewSha256, unresolvedCount });

  const statements = [
    db.prepare(`INSERT INTO command_receipts
      (id, command_type, actor_id, request_sha256, response_json, status_code)
      SELECT ?, ?, ?, ?, '{}', 0 WHERE ${exactStateSql}`)
      .bind(commandId, commandType, actorId, requestSha256, ...exactStateBindings),
    db.prepare(`INSERT INTO work_items
      (id, article_id, branch_id, title, kind, stage, state, priority, next_action)
      SELECT ?, ?, ?, ?, 'merge', 'approved', 'open', 'P1', ?
      WHERE EXISTS (SELECT 1 FROM command_receipts WHERE id = ? AND command_type = ?
        AND actor_id = ? AND request_sha256 = ? AND status_code = 0)
        AND ${exactStateSql}`)
      .bind(workItemId, articleId, targetBranchId, `准备合并：${String(source.name)} → ${String(target.name)}`, nextAction,
        commandId, commandType, actorId, requestSha256, ...exactStateBindings),
    db.prepare(`INSERT INTO merge_proposals
      (id, work_item_id, article_id, source_branch_id, target_branch_id, base_revision_id,
       source_head_revision_id, target_head_revision_id, base_sha256, source_head_sha256, target_head_sha256,
       algorithm_version, preview_json, preview_sha256, resolved_document_title, resolved_body_text,
       resolved_body_sha256, resolution_json, resolution_note, prepare_actor_id, unresolved_count, status, created_at, updated_at)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', '', ?, ?, ?, ?, ?
      WHERE EXISTS (SELECT 1 FROM command_receipts WHERE id = ? AND command_type = ?
        AND actor_id = ? AND request_sha256 = ? AND status_code = 0)
        AND EXISTS (SELECT 1 FROM work_items WHERE id = ? AND kind = 'merge' AND state = 'open')
        AND ${exactStateSql}`)
      .bind(proposalId, workItemId, articleId, sourceBranchId, targetBranchId, baseRevisionId,
        expectedSourceHeadRevisionId, expectedTargetHeadRevisionId, base.body_sha256,
        sourceHead.body_sha256, targetHead.body_sha256, algorithmVersion, previewJson, previewSha256,
        targetHead.document_title, resolvedBodyText, resolvedBodySha256, actorId, unresolvedCount, status, createdAt, createdAt,
        commandId, commandType, actorId, requestSha256, workItemId, ...exactStateBindings),
    db.prepare(`INSERT INTO workspace_events
      (id, event_type, subject_type, subject_id, article_id, payload_json, input_sha256)
      SELECT ?, 'merge.prepared', 'merge_proposal', ?, ?, ?, ?
      WHERE EXISTS (SELECT 1 FROM command_receipts WHERE id = ? AND command_type = ?
        AND actor_id = ? AND request_sha256 = ? AND status_code = 0)
        AND EXISTS (SELECT 1 FROM merge_proposals WHERE id = ? AND work_item_id = ?)
        AND ${exactStateSql}`)
      .bind(eventId, proposalId, articleId, eventPayload, requestSha256,
        commandId, commandType, actorId, requestSha256, proposalId, workItemId, ...exactStateBindings),
    db.prepare(`UPDATE command_receipts SET response_json = ?, status_code = 201, completed_at = CURRENT_TIMESTAMP
      WHERE id = ? AND command_type = ? AND actor_id = ? AND request_sha256 = ? AND status_code = 0
        AND EXISTS (SELECT 1 FROM work_items WHERE id = ? AND kind = 'merge' AND state = 'open')
        AND EXISTS (SELECT 1 FROM merge_proposals WHERE id = ? AND work_item_id = ?)
        AND EXISTS (SELECT 1 FROM workspace_events WHERE id = ? AND subject_id = ?)
        AND ${exactStateSql}`)
      .bind(canonicalJson(responsePayload), commandId, commandType, actorId, requestSha256,
        workItemId, proposalId, workItemId, eventId, proposalId, ...exactStateBindings),
  ];
  try {
    const results = await db.batch(statements);
    if (results.some((result) => Number(result.meta.changes ?? 0) !== 1)) {
      const completed = await inspectWorkspaceReceipt(db, commandId, commandType, requestSha256, actorId);
      if (completed) return completed;
      throw new ApiError("合并分支头或工作副本已变化；合并提案未创建", 409);
    }
  } catch (error) {
    const completed = await inspectWorkspaceReceipt(db, commandId, commandType, requestSha256, actorId);
    if (completed) return completed;
    const winner = await db.prepare(`SELECT * FROM merge_proposals
      WHERE source_branch_id = ? AND target_branch_id = ?
        AND source_head_revision_id = ? AND target_head_revision_id = ?
        AND status IN ('prepared', 'resolving', 'ready') ORDER BY created_at DESC LIMIT 1`)
      .bind(sourceBranchId, targetBranchId, expectedSourceHeadRevisionId, expectedTargetHeadRevisionId).first<D1Row>();
    if (winner) return persistWinnerReceipt(winner, true);
    if (error instanceof ApiError) throw error;
    await assertLegacyWorkspaceBranchesWritable(db, [sourceBranchId, targetBranchId]);
    throw new ApiError("合并分支头或工作副本已变化；合并提案未创建", 409);
  }
  return Response.json(responsePayload, { status: 201 });
}

async function saveMergeResolution(db: D1Database, payload: Record<string, unknown>, actorId: string, agentRequest: boolean) {
  const commandId = requiredText(payload.commandId, "commandId", 160);
  const proposalId = requiredText(payload.proposalId, "合并提案 ID", 120);
  const expectedLockVersion = Number(payload.expectedLockVersion);
  if (!Number.isSafeInteger(expectedLockVersion) || expectedLockVersion < 1) throw new ApiError("合并提案锁版本无效");
  const expectedPreviewSha256 = requiredText(payload.expectedPreviewSha256, "合并预览摘要", 64);
  const expectedSourceHeadRevisionId = requiredText(payload.expectedSourceHeadRevisionId, "来源分支头", 160);
  const expectedTargetHeadRevisionId = requiredText(payload.expectedTargetHeadRevisionId, "目标分支头", 160);
  const expectedSourceCopyLockVersion = Number(payload.expectedSourceCopyLockVersion);
  const expectedTargetCopyLockVersion = Number(payload.expectedTargetCopyLockVersion);
  if (!Number.isSafeInteger(expectedSourceCopyLockVersion) || expectedSourceCopyLockVersion < 1
    || !Number.isSafeInteger(expectedTargetCopyLockVersion) || expectedTargetCopyLockVersion < 1) {
    throw new ApiError("合并工作副本锁版本无效");
  }
  const resolvedDocumentTitle = requiredText(payload.resolvedDocumentTitle, "解决稿标题", 240);
  const resolvedBodyText = cleanText(payload.resolvedBodyText, 2_000_000, true);
  const resolutionNote = cleanText(payload.resolutionNote, 2000);
  const confirmResolved = Boolean(payload.confirmResolved);
  if (confirmResolved && resolutionNote.length < 4) throw new ApiError("确认解决前请留下至少 4 个字的取舍说明");
  const resolvedBodySha256 = await sha256Text(resolvedBodyText);
  const unresolvedCount = confirmResolved ? 0 : 1;
  const status = confirmResolved ? "ready" : "resolving";
  const resolution = { mode: "whole-document", confirmed: confirmResolved };
  const resolutionJson = canonicalJson(resolution);

  const action = "save_merge_resolution";
  const receiptPayload = { proposalId, expectedLockVersion, expectedPreviewSha256,
    expectedSourceHeadRevisionId, expectedTargetHeadRevisionId,
    expectedSourceCopyLockVersion, expectedTargetCopyLockVersion,
    resolvedDocumentTitle, resolvedBodyText, resolutionNote, confirmResolved };
  const requestSha256 = await sha256Text(canonicalJson({ action, actorId, payload: receiptPayload }));
  const commandType = "workspace.save_merge_resolution";
  const replay = await inspectWorkspaceReceipt(db, commandId, commandType, requestSha256, actorId);
  if (replay) return replay;

  const currentProposal = await db.prepare("SELECT * FROM merge_proposals WHERE id = ? LIMIT 1")
    .bind(proposalId).first<D1Row>();
  if (!currentProposal) throw new ApiError("合并提案不存在", 404);
  if (agentRequest) {
    await assertDistinctAgentAuthorityLineage(db, actorId, currentProposal.prepare_actor_id, "准备");
  }
  if (String(currentProposal.source_head_revision_id) !== expectedSourceHeadRevisionId
    || String(currentProposal.target_head_revision_id) !== expectedTargetHeadRevisionId) {
    throw new ApiError("合并提案的冻结分支头与请求坐标不一致", 409);
  }
  const mergeBranchIds = [String(currentProposal.source_branch_id), String(currentProposal.target_branch_id)];
  const packageProtection = await assertLegacyWorkspaceBranchesWritable(db, mergeBranchIds);
  const packageBranchGuard = packageBranchNotExistsSql(packageProtection, [
    "p.source_branch_id", "p.target_branch_id",
  ]);

  const currentStateSql = `EXISTS (SELECT 1 FROM merge_proposals p
    JOIN article_branches source ON source.id = p.source_branch_id AND source.article_id = p.article_id
    JOIN article_branches target ON target.id = p.target_branch_id AND target.article_id = p.article_id
    JOIN branch_working_copies source_copy ON source_copy.branch_id = source.id AND source_copy.article_id = p.article_id
    JOIN branch_working_copies target_copy ON target_copy.branch_id = target.id AND target_copy.article_id = p.article_id
    WHERE p.id = ? AND p.lock_version = ? AND p.preview_sha256 = ?
      AND p.source_head_revision_id = ? AND p.target_head_revision_id = ?
      AND p.status IN ('prepared', 'resolving', 'ready')
      AND (? = 0 OR (p.prepare_actor_id IS NOT NULL AND p.prepare_actor_id <> ?))
      AND source.status = 'active' AND source.head_revision_id = p.source_head_revision_id
      AND target.status = 'active' AND target.head_revision_id = p.target_head_revision_id
      AND source_copy.base_revision_id = source.head_revision_id AND source_copy.dirty = 0 AND source_copy.lock_version = ?
      AND target_copy.base_revision_id = target.head_revision_id AND target_copy.dirty = 0 AND target_copy.lock_version = ?
      ${packageBranchGuard})`;
  const currentStateBindings = [proposalId, expectedLockVersion, expectedPreviewSha256,
    expectedSourceHeadRevisionId, expectedTargetHeadRevisionId,
    agentRequest ? 1 : 0, actorId, expectedSourceCopyLockVersion, expectedTargetCopyLockVersion];
  const nextLockVersion = expectedLockVersion + 1;
  const updatedAt = new Date().toISOString();
  const savedStateSql = `EXISTS (SELECT 1 FROM merge_proposals p
    JOIN article_branches source ON source.id = p.source_branch_id AND source.article_id = p.article_id
    JOIN article_branches target ON target.id = p.target_branch_id AND target.article_id = p.article_id
    JOIN branch_working_copies source_copy ON source_copy.branch_id = source.id AND source_copy.article_id = p.article_id
    JOIN branch_working_copies target_copy ON target_copy.branch_id = target.id AND target_copy.article_id = p.article_id
    WHERE p.id = ? AND p.lock_version = ? AND p.preview_sha256 = ?
      AND p.source_head_revision_id = ? AND p.target_head_revision_id = ?
      AND p.resolved_document_title = ? AND p.resolved_body_text = ? AND p.resolved_body_sha256 = ?
      AND p.resolution_json = ? AND p.resolution_note = ? AND p.unresolved_count = ? AND p.status = ?
      AND p.updated_at = ?
      AND source.status = 'active' AND source.head_revision_id = p.source_head_revision_id
      AND target.status = 'active' AND target.head_revision_id = p.target_head_revision_id
      AND source_copy.base_revision_id = source.head_revision_id AND source_copy.dirty = 0 AND source_copy.lock_version = ?
      AND target_copy.base_revision_id = target.head_revision_id AND target_copy.dirty = 0 AND target_copy.lock_version = ?
      ${packageBranchGuard})`;
  const savedStateBindings = [proposalId, nextLockVersion, expectedPreviewSha256,
    expectedSourceHeadRevisionId, expectedTargetHeadRevisionId, resolvedDocumentTitle, resolvedBodyText,
    resolvedBodySha256, resolutionJson, resolutionNote, unresolvedCount, status, updatedAt,
    expectedSourceCopyLockVersion, expectedTargetCopyLockVersion];
  const savedProposal = {
    ...parseMergeProposal(currentProposal), resolvedDocumentTitle, resolvedBodyText, resolvedBodySha256,
    resolution, resolutionNote, resolutionActorId: actorId, unresolvedCount, status, lockVersion: nextLockVersion, updatedAt,
  };
  const responsePayload = { proposal: savedProposal };
  const eventId = `event-merge-resolution-${proposalId}-${nextLockVersion}`;
  const eventPayload = canonicalJson({ commandId, actorId, status, unresolvedCount, resolutionNote,
    expectedLockVersion, nextLockVersion, resolvedBodySha256 });

  const statements = [
    db.prepare(`INSERT INTO command_receipts
      (id, command_type, actor_id, request_sha256, response_json, status_code)
      SELECT ?, ?, ?, ?, '{}', 0 WHERE ${currentStateSql}`)
      .bind(commandId, commandType, actorId, requestSha256, ...currentStateBindings),
    db.prepare(`UPDATE merge_proposals SET
      resolved_document_title = ?, resolved_body_text = ?, resolved_body_sha256 = ?,
      resolution_json = ?, resolution_note = ?, resolution_actor_id = ?, unresolved_count = ?, status = ?,
      lock_version = lock_version + 1, updated_at = ?
    WHERE id = ? AND EXISTS (SELECT 1 FROM command_receipts WHERE id = ? AND command_type = ?
      AND actor_id = ? AND request_sha256 = ? AND status_code = 0)
      AND ${currentStateSql}`)
      .bind(resolvedDocumentTitle, resolvedBodyText, resolvedBodySha256,
        resolutionJson, resolutionNote, actorId, unresolvedCount, status, updatedAt, proposalId,
        commandId, commandType, actorId, requestSha256, ...currentStateBindings),
    db.prepare(`INSERT INTO workspace_events
      (id, event_type, subject_type, subject_id, article_id, payload_json, input_sha256)
      SELECT ?, 'merge.resolution_saved', 'merge_proposal', p.id, p.article_id, ?, ?
      FROM merge_proposals p WHERE p.id = ?
        AND EXISTS (SELECT 1 FROM command_receipts WHERE id = ? AND command_type = ?
          AND actor_id = ? AND request_sha256 = ? AND status_code = 0)
        AND ${savedStateSql}`)
      .bind(eventId, eventPayload, requestSha256, proposalId,
        commandId, commandType, actorId, requestSha256, ...savedStateBindings),
    db.prepare(`UPDATE command_receipts SET response_json = ?, status_code = 200, completed_at = CURRENT_TIMESTAMP
      WHERE id = ? AND command_type = ? AND actor_id = ? AND request_sha256 = ? AND status_code = 0
        AND EXISTS (SELECT 1 FROM workspace_events WHERE id = ? AND subject_id = ? AND input_sha256 = ?)
        AND ${savedStateSql}`)
      .bind(canonicalJson(responsePayload), commandId, commandType, actorId, requestSha256,
        eventId, proposalId, requestSha256, ...savedStateBindings),
  ];
  try {
    const results = await db.batch(statements);
    if (results.some((result) => Number(result.meta.changes ?? 0) !== 1)) {
      const completed = await inspectWorkspaceReceipt(db, commandId, commandType, requestSha256, actorId);
      if (completed) return completed;
      throw new ApiError("合并提案、分支头、工作副本或解决稿已变化；请重新载入", 409);
    }
  } catch (error) {
    const completed = await inspectWorkspaceReceipt(db, commandId, commandType, requestSha256, actorId);
    if (completed) return completed;
    if (error instanceof ApiError) throw error;
    await assertLegacyWorkspaceBranchesWritable(db, mergeBranchIds);
    throw new ApiError("合并提案、分支头、工作副本或解决稿已变化；请重新载入", 409);
  }
  return Response.json(responsePayload);
}

async function mergeRevision(db: D1Database, payload: Record<string, unknown>, actorId: string, agentRequest: boolean) {
  const commandId = requiredText(payload.commandId, "commandId", 160);
  const proposalId = requiredText(payload.proposalId, "合并提案 ID", 120);
  const expectedProposalLockVersion = Number(payload.expectedProposalLockVersion);
  const expectedTargetCopyLockVersion = Number(payload.expectedTargetCopyLockVersion);
  if (!Number.isSafeInteger(expectedProposalLockVersion) || !Number.isSafeInteger(expectedTargetCopyLockVersion)) {
    throw new ApiError("合并锁版本无效");
  }
  const expectedResolutionSha256 = requiredText(payload.expectedResolutionSha256, "解决稿摘要", 64);
  const revisionTitle = requiredText(payload.revisionTitle, "合并修订标题", 160);
  const annotation = cleanText(payload.annotation, 2000);
  const proposal = await db.prepare("SELECT * FROM merge_proposals WHERE id = ? LIMIT 1").bind(proposalId).first<D1Row>();
  if (!proposal) throw new ApiError("合并提案不存在", 404);
  const mergeBranchIds = [String(proposal.source_branch_id), String(proposal.target_branch_id)];
  const packageProtection = await assertLegacyWorkspaceBranchesWritable(db, mergeBranchIds);
  const requestSha256 = await sha256Text(JSON.stringify({ proposalId, expectedProposalLockVersion,
    expectedTargetCopyLockVersion, expectedResolutionSha256, revisionTitle, annotation,
    sourceHeadRevisionId: proposal.source_head_revision_id, targetHeadRevisionId: proposal.target_head_revision_id }));
  const replay = await inspectWorkspaceReceipt(db, commandId, "workspace.merge_revision", requestSha256, actorId);
  if (replay) return replay;
  if (agentRequest) {
    await assertDistinctAgentAuthorityLineage(db, actorId, proposal.prepare_actor_id, "准备");
    await assertDistinctAgentAuthorityLineage(db, actorId, proposal.resolution_actor_id, "解决");
  }
  const revisionId = `revision-${crypto.randomUUID()}`;
  const responsePayload = { proposalId, revisionId, targetBranchId: proposal.target_branch_id,
    sourceBranchId: proposal.source_branch_id, parentRevisionId: proposal.target_head_revision_id,
    mergeParentRevisionId: proposal.source_head_revision_id };
  const eventId = `event-${crypto.randomUUID()}`;
  const packageBranchGuard = packageBranchPairGuardFromProposalSql(packageProtection);
  const statements = [
    db.prepare(`INSERT INTO command_receipts
      (id, command_type, actor_id, request_sha256, response_json, status_code)
      SELECT ?, 'workspace.merge_revision', ?, ?, '{}', CASE WHEN (
        EXISTS (SELECT 1 FROM merge_proposals p WHERE p.id = ? AND p.status = 'ready'
          AND p.lock_version = ? AND p.resolved_body_sha256 = ? AND p.unresolved_count = 0
          AND (? = 0 OR (p.prepare_actor_id IS NOT NULL AND p.prepare_actor_id <> ?
            AND p.resolution_actor_id IS NOT NULL AND p.resolution_actor_id <> ?)))
        AND EXISTS (SELECT 1 FROM article_branches source JOIN merge_proposals p ON p.source_branch_id = source.id
          WHERE p.id = ? AND source.status = 'active' AND source.head_revision_id = p.source_head_revision_id)
        AND EXISTS (SELECT 1 FROM article_branches target JOIN merge_proposals p ON p.target_branch_id = target.id
          WHERE p.id = ? AND target.status = 'active' AND target.head_revision_id = p.target_head_revision_id)
        AND EXISTS (SELECT 1 FROM branch_working_copies copy JOIN merge_proposals p ON p.target_branch_id = copy.branch_id
          WHERE p.id = ? AND copy.base_revision_id = p.target_head_revision_id AND copy.lock_version = ? AND copy.dirty = 0)
        AND EXISTS (SELECT 1 FROM work_items work JOIN merge_proposals p ON p.work_item_id = work.id
          WHERE p.id = ? AND work.kind = 'merge' AND work.stage = 'approved' AND work.state = 'open')
        ${packageBranchGuard.sql}
      ) THEN 0 ELSE NULL END
      ON CONFLICT(id) DO UPDATE SET status_code = CASE
        WHEN command_type = excluded.command_type AND actor_id = excluded.actor_id
          AND request_sha256 = excluded.request_sha256 THEN command_receipts.status_code ELSE NULL END`)
      .bind(commandId, actorId, requestSha256, proposalId, expectedProposalLockVersion, expectedResolutionSha256,
        agentRequest ? 1 : 0, actorId, actorId,
        proposalId, proposalId, proposalId, expectedTargetCopyLockVersion, proposalId,
        ...Array.from({ length: packageBranchGuard.bindCount }, () => proposalId)),
    db.prepare(`INSERT INTO article_revisions
      (id, article_id, branch_id, sequence, parent_revision_id, merge_parent_revision_id,
       title, document_title, annotation, body_text, body_sha256, author_kind)
      SELECT ?, p.article_id, p.target_branch_id,
        COALESCE((SELECT MAX(sequence) + 1 FROM article_revisions WHERE branch_id = p.target_branch_id), 1),
        p.target_head_revision_id, p.source_head_revision_id, ?, p.resolved_document_title, ?,
        p.resolved_body_text, p.resolved_body_sha256, 'user'
      FROM merge_proposals p WHERE p.id = ?
        AND EXISTS (SELECT 1 FROM command_receipts WHERE id = ? AND status_code = 0)`)
      .bind(revisionId, revisionTitle, annotation, proposalId, commandId),
    db.prepare(`UPDATE article_branches SET head_revision_id = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = (SELECT target_branch_id FROM merge_proposals WHERE id = ?)
        AND head_revision_id = (SELECT target_head_revision_id FROM merge_proposals WHERE id = ?)
        AND EXISTS (SELECT 1 FROM article_revisions WHERE id = ?)`)
      .bind(revisionId, proposalId, proposalId, revisionId),
    db.prepare(`UPDATE branch_working_copies SET base_revision_id = ?,
        title = (SELECT resolved_document_title FROM merge_proposals WHERE id = ?),
        body_text = (SELECT resolved_body_text FROM merge_proposals WHERE id = ?),
        body_sha256 = (SELECT resolved_body_sha256 FROM merge_proposals WHERE id = ?),
        annotation = '', dirty = 0, lock_version = lock_version + 1, updated_at = CURRENT_TIMESTAMP
      WHERE branch_id = (SELECT target_branch_id FROM merge_proposals WHERE id = ?)
        AND base_revision_id = (SELECT target_head_revision_id FROM merge_proposals WHERE id = ?)
        AND lock_version = ? AND EXISTS (SELECT 1 FROM article_revisions WHERE id = ?)`)
      .bind(revisionId, proposalId, proposalId, proposalId, proposalId, proposalId, expectedTargetCopyLockVersion, revisionId),
    db.prepare(`UPDATE merge_proposals SET status = 'merged', merge_revision_id = ?, apply_actor_id = ?,
        lock_version = lock_version + 1, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND status = 'ready' AND lock_version = ?
        AND EXISTS (SELECT 1 FROM article_branches WHERE id = target_branch_id AND head_revision_id = ?)
        AND EXISTS (SELECT 1 FROM branch_working_copies WHERE branch_id = target_branch_id AND base_revision_id = ?)`)
      .bind(revisionId, actorId, proposalId, expectedProposalLockVersion, revisionId, revisionId),
    db.prepare(`UPDATE work_items SET state = 'done', blocker = '',
        next_action = '双父修订已创建；重新运行当前版本门禁', updated_at = CURRENT_TIMESTAMP
      WHERE id = (SELECT work_item_id FROM merge_proposals WHERE id = ?)
        AND kind = 'merge' AND state = 'open'
        AND EXISTS (SELECT 1 FROM merge_proposals WHERE id = ? AND status = 'merged' AND merge_revision_id = ?)`)
      .bind(proposalId, proposalId, revisionId),
    db.prepare(`UPDATE command_receipts SET response_json = ?, status_code = 201, completed_at = CURRENT_TIMESTAMP
      WHERE id = ? AND status_code = 0
        AND EXISTS (SELECT 1 FROM merge_proposals WHERE id = ? AND status = 'merged' AND merge_revision_id = ?)
        AND EXISTS (SELECT 1 FROM work_items WHERE id = (SELECT work_item_id FROM merge_proposals WHERE id = ?) AND state = 'done')`)
      .bind(JSON.stringify(responsePayload), commandId, proposalId, revisionId, proposalId),
    db.prepare(`INSERT INTO workspace_events
      (id, event_type, subject_type, subject_id, article_id, payload_json, input_sha256)
      SELECT ?, 'revision.merged', 'revision', ?, p.article_id, ?,
        CASE WHEN p.status = 'merged' AND p.merge_revision_id = ?
          AND EXISTS (SELECT 1 FROM article_revisions r WHERE r.id = ?
            AND r.parent_revision_id = p.target_head_revision_id AND r.merge_parent_revision_id = p.source_head_revision_id
            AND r.body_sha256 = p.resolved_body_sha256)
          AND EXISTS (SELECT 1 FROM article_branches WHERE id = p.target_branch_id AND head_revision_id = ?)
          AND EXISTS (SELECT 1 FROM branch_working_copies WHERE branch_id = p.target_branch_id AND base_revision_id = ? AND dirty = 0)
          AND EXISTS (SELECT 1 FROM command_receipts WHERE id = ? AND status_code = 201)
        THEN ? ELSE NULL END
      FROM merge_proposals p WHERE p.id = ?`)
      .bind(eventId, revisionId, JSON.stringify(responsePayload), revisionId, revisionId, revisionId, revisionId,
        commandId, expectedResolutionSha256, proposalId),
  ];
  try {
    await db.batch(statements);
  } catch {
    const completed = await inspectWorkspaceReceipt(db, commandId, "workspace.merge_revision", requestSha256, actorId);
    if (completed) return completed;
    await assertLegacyWorkspaceBranchesWritable(db, mergeBranchIds);
    throw new ApiError("合并提案、分支头或工作副本已变化；双父修订未创建", 409);
  }
  return Response.json(responsePayload, { status: 201 });
}

export async function POST(request: Request) {
  try {
    const payload = await request.json() as Record<string, unknown>;
    const action = requiredText(payload.action, "动作", 60);
    const privilegedAction = PRIVILEGED_WORKSPACE_ACTIONS[action as keyof typeof PRIVILEGED_WORKSPACE_ACTIONS];
    // A route may only accept an Agent Key when both its explicit handler map
    // and the centrally-issued permission catalog agree on this wire action.
    // Keeping the management map separate preserves the owner's existing
    // per-action management scopes without turning it into an Agent allowlist.
    const agentAuthorization = agentActionAuthorization("workspace", action);
    const agentRequest = request.headers.has("authorization");
    let actorId: string;
    let agentCommandId: string | null = null;
    let db: D1Database;
    if (privilegedAction) {
      if (agentRequest && !agentAuthorization) {
        throw new ApiError("owner-only 工作区动作不能携带 Agent Bearer Key", 403);
      }
      const principal = await requireManagementOrPrivilegedAgent(request, database(), {
        managementScope: privilegedAction.managementScope,
        // The values are ignored for owner sessions; for Agent sessions they
        // come exclusively from the catalog and are rechecked by auth via ID.
        agentScope: agentAuthorization?.scope ?? "__owner_only__",
        agentActionId: agentAuthorization?.actionId,
        localOnly: agentAuthorization?.localOnly ?? true,
        allowedRoles: agentAuthorization?.allowedRoles ?? [],
      }).catch((error: unknown) => {
        if (error instanceof ManagementAuthError) throw new ApiError(error.message, error.status);
        throw error;
      });
      if (agentRequest || !["save_working_copy", "commit_revision"].includes(action)) {
        const commandId = requiredText(payload.commandId, "commandId", 160);
        if (!COMMAND_ID_RE.test(commandId)) throw new ApiError("commandId 只能包含字母、数字、点、下划线、冒号或短横线", 400);
        // These two handlers do not own a domain receipt, so their Agent
        // command is wrapped here. The publication and merge handlers keep
        // their existing domain-specific receipts and must not be double-wrapped.
        if (agentRequest && ["save_working_copy", "commit_revision"].includes(action)) agentCommandId = commandId;
      }
      db = await ensureSchema();
      // Authentication (including role, scope, transport and snapshot) must
      // finish before a caller-controlled object ID causes a D1 lookup.
      const articleId = await resolvePrivilegedWorkspaceArticle(db, action, payload);
      assertPrivilegedWorkspaceArticleBoundary(principal, articleId);
      actorId = principal.actorId;
    } else {
      if (request.headers.has("authorization")) {
        throw new ApiError("owner-only 工作区动作不能携带 Agent Bearer Key", 403);
      }
      const managementPrincipal = await requireManagementSession(request, { mutation: true, scope: "workspace.branch.write" })
        .catch((error: unknown) => {
          if (error instanceof ManagementAuthError) throw new ApiError(error.message, error.status);
          throw error;
      });
      actorId = managementActorId(managementPrincipal);
      db = await ensureSchema();
    }
    const invoke = async () => {
    // Await action handlers inside this try/catch so asynchronous ApiError
    // rejections are normalized into the same JSON error contract.
    if (action === "storage_probe") return await storageProbe(db);
    if (action === "create_branch") return await createBranch(db, payload);
    if (action === "create_publication_branch") return await createPublicationBranch(db, payload, actorId);
    if (action === "save_working_copy") return await saveWorkingCopy(db, payload);
    if (action === "commit_revision") return await commitRevision(db, payload, agentRequest ? "agent" : "user");
    if (action === "create_work_item") return await createWorkItem(db, payload);
    if (action === "update_work_item") return await updateWorkItem(db, payload);
    if (action === "run_builtin_gates") return await runBuiltinGates(db, payload);
    if (action === "update_capability") return await updateCapability(db, payload);
    if (action === "create_production_run") return await createProductionRun(db, payload);
    if (action === "update_production_step") return await updateProductionStep(db, payload);
    if (action === "prepare_merge") return await prepareMerge(db, payload, actorId);
    if (action === "save_merge_resolution") return await saveMergeResolution(db, payload, actorId, agentRequest);
    if (action === "merge_revision") return await mergeRevision(db, payload, actorId, agentRequest);
    throw new ApiError("未知工作区动作", 400);
    };
    if (agentCommandId) return await withAgentWorkspaceReceipt(db, action, actorId, agentCommandId, payload, invoke);
    return await invoke();
  } catch (error) {
    const status = error instanceof ApiError ? error.status : 500;
    return Response.json({ error: error instanceof Error ? error.message : "工作区操作失败" }, { status });
  }
}
