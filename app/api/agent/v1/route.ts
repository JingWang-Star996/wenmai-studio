import { env } from "cloudflare:workers";
import corpusData from "../../../../data/corpus.generated.json";
import versionTextData from "../../../../data/version-text.generated.json";
import { articleForOperativeKnowledge, filterOperativeArticleIds, projectOperativeGraph } from "../../../operative-retrieval";
import {
  ADMINISTRATOR_SCOPES,
  SUPER_ADMIN_SCOPES,
  isAgentPrivilegeRole,
} from "../../../agent-role-contract";
import { AGENT_PERMISSION_CATALOG, AGENT_PERMISSION_CATALOG_VERSION, actionIdsForPermissionScopes, agentActionAuthorization, agentPermissionCatalogSha256, derivePrivilegeRoleForScopes, expandPermissionPreset, publicAgentPermissionCatalog, validatePermissionScopeCombination } from "../../../agent-permission-catalog";
import { canonicalSiteFullControlManagementProjection, type ManagementScope } from "../../../management-scope-catalog";
import type { PackageDocument, PackagePatchOperation } from "../../../article-project-types";
import {
  ARTICLE_GUIDANCE_CHECKLIST_SCHEMA_VERSION,
  buildArticleGuidanceChecklist,
  type ArticleGuidanceChecklist,
} from "../../../article-archive-intake";
import {
  loadLatestVerifiedArticleGuidanceDecision,
  type ArticleGuidanceDecisionBindings,
} from "../../../article-guidance-decision";
import { ManagementAuthError } from "../../../management-auth-core";
import { requireManagementSession } from "../../../management-auth";
import { canonicalProjectGroupTopology, isProjectGroupDag } from "../../../project-group-model";
import { ANNOTATION_RSI_SCHEMA_VERSION, buildRsiProposalContext, canonicalJson as canonicalRsiJson, sha256Text as sha256RsiText } from "../../../annotation-rsi";
import { canonicalPermissionSnapshotJson } from "../../../permission-snapshot-canonical";
import { assertActiveAgentClientLineage, sameAgentAuthorityLineage } from "../../../site-full-control-auth";
import {
  authenticatePrivilegedAgent,
  requireManagementOrPrivilegedAgent,
  type ControlPrincipal,
} from "../../../privileged-agent-auth";
import { SharedSourceReadError, parseSharedSourcePage, sharedSourceAgentProjection } from "../../../shared-source-read-model";
import {
  collaborationAccessModeForScopes,
  validateCollaborationGrantShape,
} from "../../../collaboration-access";

type D1Row = Record<string, string | number | null>;
type JsonObject = Record<string, unknown>;
type MutationResult = { status?: number; data: JsonObject };
type PackageGuidanceBindings = Omit<ArticleGuidanceDecisionBindings, "baselineChecklistSha256">;
type PackageGuidanceInput = {
  document: PackageDocument;
  packageStatus: string | null;
  branchStatus: string | null;
  workingCopyDirty: boolean;
  branchBridgeInSync: boolean;
  bindings: PackageGuidanceBindings;
};

const API_VERSION = "wenmai-agent-v1";
const LEASE_SECONDS = 60;
const MAX_BODY_BYTES = 2_200_000;
const MAX_INLINE_ARTIFACT_BYTES = 220_000;
const SHA256_RE = /^[a-f0-9]{64}$/;
const TASK_STATES = new Set(["draft", "queued", "claimed", "running", "awaiting_human", "blocked", "review", "succeeded", "failed", "cancelled"]);
const TERMINAL_TASK_STATES = new Set(["succeeded", "failed", "cancelled"]);
const PRIORITIES = new Set(["P0", "P1", "P2", "P3"]);
const SAFE_CLIENT_SCOPES = new Set([
  "article.read", "task.read", "task.claim", "task.progress", "task.complete", "context.read",
  "knowledge.read", "graph.read", "artifact.create", "approval.request", "graph.propose", "branch.agent_write",
  "package.read", "package.patch.propose", "article.import.new_root",
  ...ADMINISTRATOR_SCOPES,
  ...SUPER_ADMIN_SCOPES,
]);
const ORDINARY_CLIENT_SCOPES = new Set([
  "article.read", "task.read", "task.claim", "task.progress", "task.complete", "context.read", "knowledge.read", "graph.read",
  "artifact.create", "approval.request", "graph.propose", "branch.agent_write", "package.read", "package.patch.propose",
  "article.import.new_root",
]);
const LOCAL_IMPORT_SCOPE = "article.import.new_root";
const PROJECT_GROUP_MEMBER_READ_LIMIT = 256;
const PROJECT_GROUP_EDGE_READ_LIMIT = 2048;
const PRIVILEGED_TASK_MANAGEMENT_ACTIONS = new Set(["create_task", "update_task", "cancel_task"]);
const PRIVILEGED_DECISION_ACTION_SCOPES = {
  decide_approval: "approval.decide",
  decide_graph_proposal: "graph.decide",
} as const;
const TASK_PERMISSION_ALLOWLIST = new Set([
  "corpus.read", "graph.read", "article.read", "task.progress", "artifact.create", "graph.propose", "rule.propose", "branch.agent_write",
  "package.patch.propose",
]);
const FORBIDDEN_PERMISSIONS = [
  "main.write", "main.merge", "editorial.approve", "release.approve", "external.submit",
  "rule.adopt", "source.write", "token.issue",
];
const MANAGEMENT_ACTIONS = new Set([
  "issue_client", "revoke_client",
]);
const AGENT_ACTION_SCOPES = {
  claim: "task.claim",
  heartbeat: "task.progress",
  progress: "task.progress",
  add_artifact: "artifact.create",
  await_human: "approval.request",
  complete: "task.complete",
  fail: "task.complete",
  release: "task.complete",
  create_graph_proposal: "graph.propose",
  propose_revision: "branch.agent_write",
  propose_package_patch: "package.patch.propose",
} as const satisfies Record<string, string>;
const ROOT_AGENT_ACTION_MANAGEMENT_SCOPES = {
  claim: "task.manage",
  heartbeat: "task.manage",
  progress: "task.manage",
  add_artifact: "task.manage",
  await_human: "task.manage",
  complete: "task.manage",
  fail: "task.manage",
  release: "task.manage",
  create_graph_proposal: "task.manage",
  propose_revision: "workspace.branch.write",
  propose_package_patch: "package.write",
} as const satisfies Record<keyof typeof AGENT_ACTION_SCOPES, ManagementScope>;

type IndexedCorpusVersion = {
  id: string;
  name: string;
  textHash: string;
  excerpt: string;
  modifiedAt: string;
  path?: string;
  pathAliases?: string[];
};

type IndexedCorpusArticle = {
  id: string;
  title: string;
  summary: string;
  kind: string;
  tags: string[];
  entities: string[];
  updatedAt: string;
  representativeVersionId: string;
  currentVersionId: string;
  identityStatus: string;
  versions: IndexedCorpusVersion[];
};

type SharedArticleProjection = {
  id: string;
  title: string;
  summary: string;
  tags: string[];
  updatedAt: string;
  revisionId: string;
  bodySha256: string;
  bodyText: string;
  source: {
    kind: "d1" | "corpus";
    liveCurrent: boolean;
    packageId: string | null;
    branchId: string | null;
  };
};

const indexedCorpus = corpusData as unknown as {
  schemaVersion: string;
  algorithmVersion: string;
  generatedAt: string;
  stats: Record<string, number>;
  articles: IndexedCorpusArticle[];
  topics: Array<{ id: string; label: string; articleIds: string[]; signalStrength: string; opportunityScore: number }>;
  opportunities: Array<{ id: string; title: string; rationale: string; relatedArticleIds: string[]; relatedTopics: string[]; signalStrength: string }>;
  graph: {
    nodes: Array<{ id: string; label: string; type: string; size: number; status: string }>;
    edges: Array<{ id: string; source: string; target: string; type: string; weight: number; confidence: string; status: string; algorithmVersion: string; evidence: string[] }>;
  };
};
const textIndex = versionTextData as { versions: Record<string, string>; blobs: Record<string, string> };
const operativeArticles = indexedCorpus.articles
  .map(articleForOperativeKnowledge)
  .filter((article): article is IndexedCorpusArticle => article !== null);
const operativeArticleIds = new Set(operativeArticles.map((article) => article.id));
const operativeGraph = projectOperativeGraph(indexedCorpus.graph, operativeArticleIds);

class AgentApiError extends Error {
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

function jsonSuccess(id: string, data: JsonObject, status = 200) {
  return Response.json({ ok: true, requestId: id, data }, {
    status,
    headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" },
  });
}

function jsonError(id: string, error: unknown) {
  const apiError = error instanceof AgentApiError || error instanceof ManagementAuthError || error instanceof SharedSourceReadError
    ? new AgentApiError(error.code, error.message, error.status, error.details)
    : new AgentApiError("INTERNAL_ERROR", "Agent 控制面处理失败", 500);
  return Response.json({
    ok: false,
    requestId: id,
    error: { code: apiError.code, message: apiError.message, ...(apiError.details ? { details: apiError.details } : {}) },
  }, {
    status: apiError.status,
    headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" },
  });
}

function database() {
  if (!env.DB) throw new AgentApiError("DB_UNAVAILABLE", "本地 Agent 控制面数据库尚未连接", 503);
  return env.DB;
}

async function addColumnIfMissing(db: D1Database, table: string, column: string, definition: string) {
  const columns = await db.prepare(`PRAGMA table_info(${table})`).all<D1Row>();
  if (!columns.results.some((item) => item.name === column)) {
    await db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`).run();
  }
}

async function ensureAgentClientsV5Contract(db: D1Database) {
  const table = await db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'agent_clients'").first<D1Row>();
  const normalizedSql = String(table?.sql ?? "").toLowerCase().replaceAll(/\s+/g, "")
    .replaceAll('"', "").replaceAll("`", "").replaceAll("[", "").replaceAll("]", "");
  const hasV5Contract = [
    "credential_purposein('agent_api','management_session_exchange','site_full_control')",
    "client_kindin('codex','mcp','custom')",
    "issued_by_source_client_idisnullorissued_by_source_client_id<>id",
  ].every((fragment) => normalizedSql.includes(fragment));
  if (hasV5Contract) {
    await db.prepare("CREATE INDEX IF NOT EXISTS idx_agent_clients_source_client ON agent_clients(issued_by_source_client_id)").run();
    return;
  }
  // D1 batch is transactional. A conditional sentinel insert deliberately
  // violates the self-lineage CHECK when any orphan exists; this works in D1
  // environments that reject CREATE TRIGGER during runtime bootstrap.
  await db.batch([
    db.prepare(`CREATE TABLE __new_agent_clients_v5 (
      id TEXT PRIMARY KEY NOT NULL,
      label TEXT NOT NULL,
      client_kind TEXT NOT NULL DEFAULT 'custom' CONSTRAINT agent_clients_client_kind_check CHECK (client_kind IN ('codex','mcp','custom')),
      role TEXT NOT NULL DEFAULT 'agent' CONSTRAINT agent_clients_role_check CHECK (role IN ('agent','administrator','super_admin')),
      token_sha256 TEXT NOT NULL,
      scopes_json TEXT NOT NULL DEFAULT '[]',
      article_ids_json TEXT NOT NULL DEFAULT '[]',
      task_ids_json TEXT NOT NULL DEFAULT '[]',
      credential_purpose TEXT NOT NULL DEFAULT 'agent_api' CONSTRAINT agent_clients_credential_purpose_check CHECK (credential_purpose IN ('agent_api','management_session_exchange','site_full_control')),
      issued_by_source_client_id TEXT,
      exchange_generation INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active' CONSTRAINT agent_clients_status_check CHECK (status IN ('active','revoked')),
      expires_at TEXT NOT NULL,
      last_seen_at TEXT,
      created_at TEXT NOT NULL,
      revoked_at TEXT,
      CONSTRAINT agent_clients_lineage_not_self_check CHECK (issued_by_source_client_id IS NULL OR issued_by_source_client_id <> id)
    )`),
    db.prepare(`INSERT INTO __new_agent_clients_v5
      (id,label,client_kind,role,token_sha256,scopes_json,article_ids_json,task_ids_json,credential_purpose,issued_by_source_client_id,exchange_generation,status,expires_at,created_at)
      SELECT '__wenmai_orphan_lineage_guard__','invalid lineage guard','custom','agent',
        'invalid-lineage-guard','[]','[]','[]','agent_api','__wenmai_orphan_lineage_guard__',0,'revoked',
        '1970-01-01T00:00:00.000Z','1970-01-01T00:00:00.000Z'
      FROM agent_clients child
      WHERE child.issued_by_source_client_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM agent_clients parent WHERE parent.id = child.issued_by_source_client_id)
      LIMIT 1`),
    db.prepare(`INSERT INTO __new_agent_clients_v5
      (id,label,client_kind,role,token_sha256,scopes_json,article_ids_json,task_ids_json,credential_purpose,issued_by_source_client_id,exchange_generation,status,expires_at,last_seen_at,created_at,revoked_at)
      SELECT id,label,client_kind,role,token_sha256,scopes_json,article_ids_json,task_ids_json,credential_purpose,issued_by_source_client_id,exchange_generation,status,expires_at,last_seen_at,created_at,revoked_at FROM agent_clients`),
    db.prepare("DROP TABLE agent_clients"),
    db.prepare("ALTER TABLE __new_agent_clients_v5 RENAME TO agent_clients"),
    db.prepare("CREATE UNIQUE INDEX idx_agent_clients_token_sha256 ON agent_clients(token_sha256)"),
    db.prepare("CREATE INDEX idx_agent_clients_status_expiry ON agent_clients(status, expires_at)"),
    db.prepare("CREATE INDEX idx_agent_clients_management_exchange ON agent_clients(credential_purpose, status, expires_at)"),
    db.prepare("CREATE INDEX idx_agent_clients_source_client ON agent_clients(issued_by_source_client_id)"),
  ]);
}

async function ensureAgentSchema() {
  const db = database();
  await db.batch([
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
    db.prepare(`CREATE TABLE IF NOT EXISTS article_branches (
      id TEXT PRIMARY KEY NOT NULL,
      article_id TEXT NOT NULL,
      name TEXT NOT NULL,
      slug TEXT NOT NULL,
      color TEXT NOT NULL DEFAULT 'blue',
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
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
      author_kind TEXT NOT NULL DEFAULT 'user' CHECK (author_kind IN ('user','agent','import')),
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
    db.prepare(`CREATE TABLE IF NOT EXISTS agent_clients (
      id TEXT PRIMARY KEY NOT NULL,
      label TEXT NOT NULL,
      client_kind TEXT NOT NULL DEFAULT 'custom' CONSTRAINT agent_clients_client_kind_check CHECK (client_kind IN ('codex','mcp','custom')),
      role TEXT NOT NULL DEFAULT 'agent' CONSTRAINT agent_clients_role_check CHECK (role IN ('agent','administrator','super_admin')),
      token_sha256 TEXT NOT NULL,
      scopes_json TEXT NOT NULL DEFAULT '[]',
      article_ids_json TEXT NOT NULL DEFAULT '[]',
      task_ids_json TEXT NOT NULL DEFAULT '[]',
      credential_purpose TEXT NOT NULL DEFAULT 'agent_api' CONSTRAINT agent_clients_credential_purpose_check CHECK (credential_purpose IN ('agent_api','management_session_exchange','site_full_control')),
      issued_by_source_client_id TEXT,
      exchange_generation INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active' CONSTRAINT agent_clients_status_check CHECK (status IN ('active','revoked')),
      expires_at TEXT NOT NULL,
      last_seen_at TEXT,
      created_at TEXT NOT NULL,
      revoked_at TEXT,
      CONSTRAINT agent_clients_lineage_not_self_check CHECK (issued_by_source_client_id IS NULL OR issued_by_source_client_id <> id)
    )`),
    db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_clients_token_sha256 ON agent_clients(token_sha256)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_agent_clients_status_expiry ON agent_clients(status, expires_at)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_agent_clients_management_exchange ON agent_clients(credential_purpose, status, expires_at)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_agent_clients_source_client ON agent_clients(issued_by_source_client_id)"),
    db.prepare(`CREATE TABLE IF NOT EXISTS agent_client_permission_snapshots (
      client_id TEXT PRIMARY KEY NOT NULL, schema_version INTEGER NOT NULL DEFAULT 3, catalog_version TEXT NOT NULL,
      preset_id TEXT NOT NULL, role TEXT NOT NULL, scopes_json TEXT NOT NULL, action_ids_json TEXT NOT NULL,
      article_ids_json TEXT NOT NULL, task_ids_json TEXT NOT NULL, snapshot_json TEXT NOT NULL,
      snapshot_sha256 TEXT NOT NULL, created_at TEXT NOT NULL,
      CHECK (schema_version = 3)
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS agent_tasks (
      id TEXT PRIMARY KEY NOT NULL,
      work_item_id TEXT,
      article_id TEXT NOT NULL,
      project_id TEXT,
      package_id TEXT,
      base_composition_id TEXT,
      base_composition_sha256 TEXT,
      base_revision_id TEXT,
      base_branch_lock_version INTEGER,
      target_branch_id TEXT,
      current_context_snapshot_id TEXT,
      active_attempt_id TEXT,
      assigned_client_id TEXT,
      title TEXT NOT NULL,
      objective TEXT NOT NULL,
      instructions_md TEXT NOT NULL DEFAULT '',
      acceptance_json TEXT NOT NULL DEFAULT '[]',
      context_spec_json TEXT NOT NULL DEFAULT '{}',
      permission_ceiling_json TEXT NOT NULL DEFAULT '{}',
      priority TEXT NOT NULL DEFAULT 'P2' CHECK (priority IN ('P0','P1','P2','P3')),
      state TEXT NOT NULL DEFAULT 'queued' CHECK (state IN ('draft','queued','claimed','running','awaiting_human','blocked','review','succeeded','failed','cancelled')),
      lock_version INTEGER NOT NULL DEFAULT 1,
      created_by TEXT NOT NULL DEFAULT 'user',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      finished_at TEXT,
      cancelled_at TEXT
    )`),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_agent_tasks_article_state ON agent_tasks(article_id, state, updated_at)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_agent_tasks_assignee_state ON agent_tasks(assigned_client_id, state, updated_at)"),
    db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_tasks_active_attempt ON agent_tasks(active_attempt_id) WHERE active_attempt_id IS NOT NULL"),
    db.prepare(`CREATE TABLE IF NOT EXISTS agent_context_snapshots (
      id TEXT PRIMARY KEY NOT NULL,
      task_id TEXT NOT NULL,
      article_id TEXT NOT NULL,
      branch_id TEXT,
      revision_id TEXT NOT NULL,
      body_sha256 TEXT NOT NULL,
      corpus_schema_version TEXT NOT NULL,
      corpus_algorithm_version TEXT NOT NULL,
      corpus_generated_at TEXT NOT NULL,
      corpus_sha256 TEXT NOT NULL,
      graph_sha256 TEXT NOT NULL,
      rules_sha256 TEXT NOT NULL,
      package_id TEXT,
      composition_id TEXT,
      composition_sha256 TEXT,
      package_document_sha256 TEXT,
      package_lock_version INTEGER,
      branch_head_revision_id TEXT,
      branch_state_lock_version INTEGER,
      module_graph_sha256 TEXT,
      diagnosis_summary_sha256 TEXT,
      bundle_json TEXT NOT NULL,
      context_sha256 TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_agent_context_task_created ON agent_context_snapshots(task_id, created_at)"),
    db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_context_task_sha ON agent_context_snapshots(task_id, context_sha256)"),
    db.prepare(`CREATE TABLE IF NOT EXISTS agent_task_attempts (
      id TEXT PRIMARY KEY NOT NULL,
      task_id TEXT NOT NULL,
      attempt INTEGER NOT NULL DEFAULT 1,
      client_id TEXT NOT NULL,
      context_snapshot_id TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'claimed' CHECK (state IN ('claimed','running','awaiting_human','succeeded','failed','released','cancelled')),
      last_heartbeat_at TEXT,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      error_class TEXT,
      error_summary TEXT
    )`),
    db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_task_attempt_number ON agent_task_attempts(task_id, attempt)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_agent_task_attempts_client_state ON agent_task_attempts(client_id, state, started_at)"),
    db.prepare(`CREATE TABLE IF NOT EXISTS agent_task_leases (
      id TEXT PRIMARY KEY NOT NULL,
      task_id TEXT NOT NULL,
      attempt_id TEXT NOT NULL,
      client_id TEXT NOT NULL,
      lease_token_sha256 TEXT NOT NULL,
      leased_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      heartbeat_at TEXT NOT NULL,
      heartbeat_seq INTEGER NOT NULL DEFAULT 0,
      revoked_at TEXT
    )`),
    db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_task_leases_active_attempt ON agent_task_leases(attempt_id) WHERE revoked_at IS NULL"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_agent_task_leases_expiry ON agent_task_leases(expires_at, revoked_at)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_agent_task_leases_task ON agent_task_leases(task_id, revoked_at)"),
    db.prepare(`CREATE TABLE IF NOT EXISTS agent_progress_events (
      cursor INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      attempt_id TEXT,
      event_type TEXT NOT NULL,
      phase TEXT NOT NULL DEFAULT '',
      progress_percent INTEGER CHECK (progress_percent IS NULL OR (progress_percent >= 0 AND progress_percent <= 100)),
      current_action TEXT NOT NULL DEFAULT '',
      next_action TEXT NOT NULL DEFAULT '',
      blocker TEXT NOT NULL DEFAULT '',
      message TEXT NOT NULL DEFAULT '',
      evidence_json TEXT NOT NULL DEFAULT '[]',
      payload_json TEXT NOT NULL DEFAULT '{}',
      actor_kind TEXT NOT NULL CHECK (actor_kind IN ('user','agent','system')),
      actor_id TEXT NOT NULL,
      command_id TEXT,
      input_sha256 TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`),
    db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_progress_event_id ON agent_progress_events(id)"),
    db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_progress_command ON agent_progress_events(command_id) WHERE command_id IS NOT NULL"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_agent_progress_task_cursor ON agent_progress_events(task_id, cursor)"),
    db.prepare(`CREATE TABLE IF NOT EXISTS agent_task_artifacts (
      id TEXT PRIMARY KEY NOT NULL,
      task_id TEXT NOT NULL,
      attempt_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      content_ref TEXT NOT NULL,
      sha256 TEXT NOT NULL,
      media_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      payload_json TEXT NOT NULL DEFAULT '{}',
      context_sha256 TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`),
    db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_task_artifact_attempt_sha ON agent_task_artifacts(attempt_id, kind, sha256)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_agent_task_artifacts_task_created ON agent_task_artifacts(task_id, created_at)"),
    db.prepare(`CREATE TABLE IF NOT EXISTS agent_approval_requests (
      id TEXT PRIMARY KEY NOT NULL,
      task_id TEXT NOT NULL,
      attempt_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      question TEXT NOT NULL,
      options_json TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','cancelled')),
      requested_by_client_id TEXT NOT NULL,
      decision_note TEXT NOT NULL DEFAULT '',
      lock_version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      decided_at TEXT,
      decided_by TEXT
    )`),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_agent_approval_task_status ON agent_approval_requests(task_id, status, created_at)"),
    db.prepare(`CREATE TABLE IF NOT EXISTS graph_proposals (
      id TEXT PRIMARY KEY NOT NULL,
      task_id TEXT NOT NULL,
      attempt_id TEXT NOT NULL,
      article_id TEXT NOT NULL,
      proposal_kind TEXT NOT NULL CHECK (proposal_kind IN ('node','edge','claim')),
      source_id TEXT,
      target_id TEXT,
      relation_type TEXT NOT NULL DEFAULT '',
      label TEXT NOT NULL DEFAULT '',
      payload_json TEXT NOT NULL DEFAULT '{}',
      evidence_json TEXT NOT NULL DEFAULT '[]',
      context_sha256 TEXT NOT NULL,
      input_sha256 TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'candidate' CHECK (status IN ('candidate','confirmed','rejected')),
      lock_version INTEGER NOT NULL DEFAULT 1,
      created_by_client_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      reviewed_at TEXT,
      reviewed_by TEXT,
      review_note TEXT NOT NULL DEFAULT ''
    )`),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_graph_proposals_article_status ON graph_proposals(article_id, status, created_at)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_graph_proposals_task_status ON graph_proposals(task_id, status, created_at)"),
  ]);
  // Existing previews may have workspace tables created by an older runtime
  // bootstrap. Keep the Agent control plane additive so it can safely open
  // those databases without pretending their Drizzle migration history moved.
  const branchColumns = await db.prepare("PRAGMA table_info(article_branches)").all<D1Row>();
  if (!branchColumns.results.some((column) => column.name === "head_revision_id")) {
    await db.prepare("ALTER TABLE article_branches ADD COLUMN head_revision_id TEXT NOT NULL DEFAULT ''").run();
  }
  if (!branchColumns.results.some((column) => column.name === "base_revision_id")) {
    await db.prepare("ALTER TABLE article_branches ADD COLUMN base_revision_id TEXT NOT NULL DEFAULT ''").run();
  }
  const copyColumns = await db.prepare("PRAGMA table_info(branch_working_copies)").all<D1Row>();
  if (!copyColumns.results.some((column) => column.name === "lock_version")) {
    await db.prepare("ALTER TABLE branch_working_copies ADD COLUMN lock_version INTEGER NOT NULL DEFAULT 1").run();
  }
  await addColumnIfMissing(db, "agent_clients", "role", "TEXT NOT NULL DEFAULT 'agent'");
  await addColumnIfMissing(db, "agent_clients", "credential_purpose", "TEXT NOT NULL DEFAULT 'agent_api'");
  await addColumnIfMissing(db, "agent_clients", "issued_by_source_client_id", "TEXT");
  await addColumnIfMissing(db, "agent_clients", "exchange_generation", "INTEGER NOT NULL DEFAULT 0");
  await ensureAgentClientsV5Contract(db);
  await addColumnIfMissing(db, "agent_tasks", "package_id", "TEXT");
  await addColumnIfMissing(db, "agent_tasks", "base_composition_id", "TEXT");
  await addColumnIfMissing(db, "agent_tasks", "base_composition_sha256", "TEXT");
  await addColumnIfMissing(db, "agent_tasks", "base_revision_id", "TEXT");
  await addColumnIfMissing(db, "agent_tasks", "base_branch_lock_version", "INTEGER");
  await addColumnIfMissing(db, "agent_context_snapshots", "package_id", "TEXT");
  await addColumnIfMissing(db, "agent_context_snapshots", "composition_id", "TEXT");
  await addColumnIfMissing(db, "agent_context_snapshots", "composition_sha256", "TEXT");
  await addColumnIfMissing(db, "agent_context_snapshots", "package_document_sha256", "TEXT");
  await addColumnIfMissing(db, "agent_context_snapshots", "package_lock_version", "INTEGER");
  await addColumnIfMissing(db, "agent_context_snapshots", "branch_head_revision_id", "TEXT");
  await addColumnIfMissing(db, "agent_context_snapshots", "branch_state_lock_version", "INTEGER");
  await addColumnIfMissing(db, "agent_context_snapshots", "module_graph_sha256", "TEXT");
  await addColumnIfMissing(db, "agent_context_snapshots", "diagnosis_summary_sha256", "TEXT");
  await db.prepare("CREATE INDEX IF NOT EXISTS idx_agent_tasks_package_state ON agent_tasks(package_id, state, updated_at)").run();
  await db.prepare("CREATE INDEX IF NOT EXISTS idx_agent_context_package_composition ON agent_context_snapshots(package_id, composition_id, created_at)").run();
  if (await tableExists(db, "package_patch_proposals")) {
    await addColumnIfMissing(db, "package_patch_proposals", "branch_id", "TEXT");
    await addColumnIfMissing(db, "package_patch_proposals", "base_revision_id", "TEXT");
    await addColumnIfMissing(db, "package_patch_proposals", "base_package_lock_version", "INTEGER");
    await addColumnIfMissing(db, "package_patch_proposals", "base_branch_lock_version", "INTEGER");
  }
  return db;
}

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseJson<T>(value: unknown, fallback: T): T {
  try {
    return JSON.parse(String(value ?? "")) as T;
  } catch {
    return fallback;
  }
}

function cleanText(value: unknown, maximum: number, preserveWhitespace = false) {
  if (typeof value !== "string") return "";
  const result = preserveWhitespace ? value.replace(/\r\n?/g, "\n") : value.trim();
  if (result.length > maximum) throw new AgentApiError("FIELD_TOO_LARGE", `输入超过 ${maximum.toLocaleString("zh-CN")} 个字符`, 413);
  return result;
}

function requiredText(value: unknown, label: string, maximum: number, preserveWhitespace = false) {
  const result = cleanText(value, maximum, preserveWhitespace);
  if (!result) throw new AgentApiError("MISSING_FIELD", `缺少${label}`, 400, { field: label });
  return result;
}

function stringArray(value: unknown, label: string, limit = 100) {
  if (!Array.isArray(value)) throw new AgentApiError("INVALID_FIELD", `${label}必须是字符串数组`);
  const result = [...new Set(value.map((item) => cleanText(item, 240)).filter(Boolean))];
  if (result.length > limit) throw new AgentApiError("FIELD_TOO_LARGE", `${label}最多 ${limit} 项`, 413);
  return result;
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (isObject(value)) return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));
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

async function buildVerifiedPackageGuidanceChecklist(db: D1Database, input: PackageGuidanceInput) {
  const baselineChecklist = await buildArticleGuidanceChecklist(input);
  const verifiedDecision = await loadLatestVerifiedArticleGuidanceDecision(db, {
    ...input.bindings,
    baselineChecklistSha256: baselineChecklist.checklistSha256,
  });
  return verifiedDecision
    ? buildArticleGuidanceChecklist({ ...input, verifiedDecision })
    : baselineChecklist;
}

function packageGuidanceFromContextRow(row: D1Row) {
  const contextBundle = parseJson<JsonObject>(row.bundle_json, {});
  const packageContext = isObject(contextBundle.packageContext) ? contextBundle.packageContext : null;
  return packageContext && isObject(packageContext.guidanceChecklist) ? packageContext.guidanceChecklist : null;
}

function assertPackagePatchAgentGuidance(
  value: unknown,
  gateStage: "create_task" | "claim" | "propose_package_patch",
  checklistSource: "current" | "frozen",
): asserts value is ArticleGuidanceChecklist {
  if (!isObject(value) || value.schemaVersion !== ARTICLE_GUIDANCE_CHECKLIST_SCHEMA_VERSION) {
    throw new AgentApiError("GUIDANCE_CHECKLIST_REQUIRED", "package-patch 写动作缺少可验证的机器指导清单", 409, {
      gateStage,
      checklistSource,
    });
  }
  const nextAction = isObject(value.nextAction) ? value.nextAction : {};
  const permissions = isObject(value.permissions) ? value.permissions : {};
  const summary = isObject(value.summary) ? value.summary : {};
  const checks = Array.isArray(value.checks) ? value.checks.filter(isObject) : [];
  const checkId = cleanText(nextAction.checkId, 160);
  const nextCheck = checks.find((check) => cleanText(check.id, 160) === checkId) ?? null;
  const nextActor = cleanText(nextAction.actor, 40);
  const checkActor = nextCheck ? cleanText(nextCheck.responsibleActor, 40) : "";
  const checkStatus = nextCheck ? cleanText(nextCheck.status, 40) : "";
  const onFailure = nextCheck ? cleanText(nextCheck.onFailure, 40) : "";
  const nextAllowedActions = Array.isArray(permissions.nextAllowedActions)
    ? permissions.nextAllowedActions.map(String)
    : [];
  let gateReason = "agent_repair_required";
  if (checkStatus === "blocked" || Number(summary.blocked ?? 0) > 0) gateReason = "blocked";
  else if (nextActor === "human" || checkActor === "human" || checkStatus === "human_required") gateReason = "human_required";
  else if (nextActor === "coordinator" || checkActor === "coordinator") gateReason = "coordinator_required";
  else if (nextActor === "agent"
    && nextCheck
    && checkActor === "agent"
    && checkStatus === "pending"
    && onFailure === "repair_as_candidate"
    && nextAllowedActions.includes("propose_package_patch")) return;
  else if (!nextAllowedActions.includes("propose_package_patch")) gateReason = "propose_action_not_allowed";
  throw new AgentApiError(
    "GUIDANCE_CHECKLIST_OPEN",
    "当前指导清单没有把唯一下一步授权为 Agent 可修复的 Package Patch 候选；不得派发、领取或提交",
    409,
    {
      gateStage,
      checklistSource,
      gateReason,
      checklistSha256: value.checklistSha256 ?? null,
      checkId: checkId || null,
      nextActor: nextActor || null,
      checkActor: checkActor || null,
      checkStatus: checkStatus || null,
      onFailure: onFailure || null,
      proposePackagePatchAllowed: nextAllowedActions.includes("propose_package_patch"),
    },
  );
}

async function deriveLeaseToken(clientToken: string, leaseId: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(clientToken),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`wenmai-agent-lease-v1\0${leaseId}`));
  const hex = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `wenmai_lease_${hex}`;
}

function isoNow() {
  return new Date().toISOString();
}

function leaseExpiry() {
  return new Date(Date.now() + LEASE_SECONDS * 1000).toISOString();
}

function sameOrigin(request: Request) {
  const url = new URL(request.url);
  const origin = request.headers.get("origin");
  const fetchSite = request.headers.get("sec-fetch-site");
  if (origin) return origin === url.origin && (!fetchSite || ["same-origin", "none"].includes(fetchSite));
  if (request.method !== "GET") return false;
  if (fetchSite) return ["same-origin", "none"].includes(fetchSite);
  const referer = request.headers.get("referer");
  if (!referer) return false;
  try { return new URL(referer).origin === url.origin; } catch { return false; }
}

function assertManagementWrite(request: Request) {
  if (!sameOrigin(request)) throw new AgentApiError("ORIGIN_MISMATCH", "管理写入只接受当前文脉页面的同源请求", 403);
  if (request.headers.get("x-wenmai-write") !== "1") {
    throw new AgentApiError("WRITE_INTENT_REQUIRED", "管理写入缺少 X-Wenmai-Write: 1", 403);
  }
}

function eventStatement(db: D1Database, input: {
  taskId: string; attemptId?: string | null; eventType: string; phase?: string; progressPercent?: number | null;
  currentAction?: string; nextAction?: string; blocker?: string; message?: string; evidence?: string[];
  payload?: JsonObject; actorKind: "user" | "agent" | "system"; actorId: string; commandId?: string | null;
  inputSha256: string; createdAt: string;
}) {
  return db.prepare(`INSERT INTO agent_progress_events
    (id, task_id, attempt_id, event_type, phase, progress_percent, current_action, next_action, blocker,
     message, evidence_json, payload_json, actor_kind, actor_id, command_id, input_sha256, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(
      `agent-event-${crypto.randomUUID()}`, input.taskId, input.attemptId ?? null, input.eventType,
      input.phase ?? "", input.progressPercent ?? null, input.currentAction ?? "", input.nextAction ?? "",
      input.blocker ?? "", input.message ?? "", canonicalJson(input.evidence ?? []), canonicalJson(input.payload ?? {}),
      input.actorKind, input.actorId, input.commandId ?? null, input.inputSha256, input.createdAt,
    );
}

function parseClient(row: D1Row, permissionProfile?: JsonObject | null) {
  const scopes = parseJson<string[]>(row.scopes_json, []);
  const storedStatus = String(row.status);
  const expiryTime = Date.parse(String(row.expires_at));
  const effectiveStatus = storedStatus === "revoked"
    ? "revoked"
    : Number.isFinite(expiryTime) && expiryTime > Date.now() ? "active" : "expired";
  return {
    id: String(row.id), label: String(row.label), clientKind: String(row.client_kind), role: String(row.role ?? "agent"),
    scopes, articleIds: parseJson<string[]>(row.article_ids_json, []),
    taskIds: parseJson<string[]>(row.task_ids_json, []), status: storedStatus, effectiveStatus, expiresAt: String(row.expires_at),
    lastSeenAt: row.last_seen_at ? String(row.last_seen_at) : null, createdAt: String(row.created_at),
    revokedAt: row.revoked_at ? String(row.revoked_at) : null,
    credentialPurpose: row.credential_purpose === "management_session_exchange"
      ? "management_session_exchange"
      : row.credential_purpose === "site_full_control" ? "site_full_control" : "agent_api",
    issuedBySourceClientId: row.issued_by_source_client_id ? String(row.issued_by_source_client_id) : null,
    collaborationAccessMode: collaborationAccessModeForScopes(scopes),
    permissionProfile: permissionProfile ?? null,
  };
}

function parsePermissionProfile(row: D1Row): JsonObject | null {
  const actionIds = parseJson<unknown>(row.action_ids_json, null);
  const articleIds = parseJson<unknown>(row.article_ids_json, null);
  if (!Array.isArray(actionIds) || !Array.isArray(articleIds) || !actionIds.every((value) => typeof value === "string") || !articleIds.every((value) => typeof value === "string")) return null;
  const snapshot = parseJson<unknown>(row.snapshot_json, null);
  const catalogSha256 = snapshot && typeof snapshot === "object" && !Array.isArray(snapshot) && typeof (snapshot as Record<string, unknown>).catalogSha256 === "string"
    ? (snapshot as Record<string, unknown>).catalogSha256 : null;
  const rootProjection = snapshot && typeof snapshot === "object" && !Array.isArray(snapshot)
    ? snapshot as Record<string, unknown> : null;
  const managementProjectionVersion = typeof rootProjection?.managementProjectionVersion === "string" ? rootProjection.managementProjectionVersion : null;
  const managementScopes = Array.isArray(rootProjection?.managementScopes) && rootProjection.managementScopes.every((value) => typeof value === "string") ? rootProjection.managementScopes : null;
  const managementProjectionSha256 = typeof rootProjection?.managementProjectionSha256 === "string" && SHA256_RE.test(rootProjection.managementProjectionSha256) ? rootProjection.managementProjectionSha256 : null;
  return {
    schemaVersion: rootProjection?.schemaVersion === 5 ? 5 : rootProjection?.schemaVersion === 4 ? 4 : Number(row.schema_version), catalogVersion: String(row.catalog_version),
    ...(catalogSha256 && SHA256_RE.test(catalogSha256) ? { catalogSha256 } : {}), presetId: String(row.preset_id), actionIds, articleIds, snapshotSha256: String(row.snapshot_sha256),
    ...(rootProjection?.directAgentApi === true ? { directAgentApi: true } : {}),
    ...(managementProjectionVersion && managementScopes && managementProjectionSha256 ? { managementProjectionVersion, managementScopes, managementProjectionSha256 } : {}),
  };
}

async function knownArticleIds(db: D1Database) {
  const known = new Set(operativeArticleIds);
  for (const [table, status] of [["article_branches", "active"], ["article_project_packages", "active"]] as const) {
    if (!await tableExists(db, table)) continue;
    const rows = await db.prepare(`SELECT DISTINCT article_id FROM ${table} WHERE status = ?`).bind(status).all<D1Row>();
    for (const row of rows.results ?? []) {
      const articleId = cleanText(row.article_id, 120);
      if (articleId) known.add(articleId);
    }
  }
  return known;
}

async function sharedArticleProjection(db: D1Database, articleId: string): Promise<SharedArticleProjection> {
  const corpusArticle = operativeArticles.find((article) => article.id === articleId) ?? null;
  if (await tableExists(db, "article_project_packages")) {
    const packageCounts = await db.prepare(`SELECT COUNT(*) AS total_count,
      SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active_count
      FROM article_project_packages WHERE article_id = ?`).bind(articleId).first<D1Row>();
    const totalPackages = Number(packageCounts?.total_count ?? 0);
    const activePackages = Number(packageCounts?.active_count ?? 0);
    if (totalPackages > 0) {
      if (activePackages !== 1) {
        throw new AgentApiError(
          "SHARED_ARTICLE_SOURCE_AMBIGUOUS",
          activePackages > 1 ? "共享文章存在多个活动 Package，无法确定唯一当前正文" : "共享文章的本地 Package 已停用，拒绝回退到旧语料正文",
          409,
        );
      }
      const row = await db.prepare(`SELECT package.id AS package_id, package.title AS package_title,
        package.primary_branch_id, package.updated_at AS package_updated_at,
        branch.id AS branch_id, branch.article_id AS branch_article_id, branch.status AS branch_status,
        branch.head_revision_id, branch.updated_at AS branch_updated_at,
        revision.id AS revision_id, revision.article_id AS revision_article_id, revision.branch_id AS revision_branch_id,
        revision.title AS revision_title, revision.document_title, revision.annotation,
        revision.body_text, revision.body_sha256, revision.created_at AS revision_created_at
        FROM article_project_packages package
        LEFT JOIN article_branches branch ON branch.id = package.primary_branch_id
        LEFT JOIN article_revisions revision ON revision.id = branch.head_revision_id
        WHERE package.article_id = ? AND package.status = 'active' LIMIT 1`)
        .bind(articleId).first<D1Row>();
      if (!row
        || !row.primary_branch_id
        || row.branch_id !== row.primary_branch_id
        || row.branch_article_id !== articleId
        || row.branch_status !== "active"
        || row.revision_id !== row.head_revision_id
        || row.revision_article_id !== articleId
        || row.revision_branch_id !== row.branch_id) {
        throw new AgentApiError("SHARED_ARTICLE_SOURCE_INVALID", "共享文章的活动 Package、主分支与当前修订没有形成一致绑定", 409);
      }
      const bodyText = String(row.body_text ?? "");
      const bodySha256 = String(row.body_sha256 ?? "");
      if (!bodyText || !SHA256_RE.test(bodySha256)
        || new TextEncoder().encode(bodyText).byteLength > MAX_BODY_BYTES
        || await sha256Text(bodyText) !== bodySha256) {
        throw new AgentApiError("SHARED_ARTICLE_SOURCE_INVALID", "共享文章的 D1 当前正文缺失、过大或摘要校验失败", 409);
      }
      return {
        id: articleId,
        title: cleanText(row.document_title, 500) || cleanText(row.revision_title, 500) || cleanText(row.package_title, 500) || articleId,
        summary: cleanText(row.annotation, 2000, true) || "文脉本地文章工程的当前主分支修订。",
        tags: ["本地文章工程"],
        updatedAt: String(row.branch_updated_at ?? row.revision_created_at ?? row.package_updated_at ?? ""),
        revisionId: String(row.revision_id),
        bodySha256,
        bodyText,
        source: { kind: "d1", liveCurrent: true, packageId: String(row.package_id), branchId: String(row.branch_id) },
      };
    }
  }

  if (!corpusArticle) throw new AgentApiError("SHARED_ARTICLE_NOT_FOUND", "共享文章不存在或没有可验证的当前正文", 404);
  const version = corpusArticle.versions.find((item) => item.id === corpusArticle.representativeVersionId) ?? null;
  if (!version || !SHA256_RE.test(version.textHash)) throw new AgentApiError("SHARED_ARTICLE_SOURCE_INVALID", "共享文章缺少可验证的语料正文", 409);
  const bodyText = textIndex.blobs[version.textHash] ?? textIndex.versions[version.id] ?? "";
  if (!bodyText || new TextEncoder().encode(bodyText).byteLength > MAX_BODY_BYTES || await sha256Text(bodyText) !== version.textHash) {
    throw new AgentApiError("SHARED_ARTICLE_SOURCE_INVALID", "共享文章语料正文缺失、过大或摘要校验失败", 409);
  }
  return {
    id: corpusArticle.id,
    title: corpusArticle.title,
    summary: corpusArticle.summary,
    tags: corpusArticle.tags,
    updatedAt: corpusArticle.updatedAt,
    revisionId: `source:${version.id}`,
    bodySha256: version.textHash,
    bodyText,
    source: { kind: "corpus", liveCurrent: false, packageId: null, branchId: null },
  };
}

async function requireShareEditorTask(db: D1Database, taskId: string, articleId: string, status: 400 | 403) {
  const row = await db.prepare(`SELECT task.article_id, task.state, task.target_branch_id, task.permission_ceiling_json,
    branch.article_id AS branch_article_id, branch.name AS branch_name, branch.slug AS branch_slug, branch.status AS branch_status,
    context.task_id AS context_task_id, context.article_id AS context_article_id, context.branch_id AS context_branch_id
    FROM agent_tasks task
    LEFT JOIN article_branches branch ON branch.id = task.target_branch_id
    LEFT JOIN agent_context_snapshots context ON context.id = task.current_context_snapshot_id
    WHERE task.id = ? LIMIT 1`).bind(taskId).first<D1Row>();
  const permission = parseJson<JsonObject>(row?.permission_ceiling_json, {});
  const allow = Array.isArray(permission.allow) ? permission.allow.map(String) : [];
  const deny = Array.isArray(permission.deny) ? permission.deny.map(String) : [];
  const requiredTaskAllows = ["article.read", "task.progress", "artifact.create", "branch.agent_write"];
  const expectedBranch = agentBranchIdentity(taskId);
  const valid = Boolean(row)
    && row?.article_id === articleId
    && !TERMINAL_TASK_STATES.has(String(row?.state ?? ""))
    && permission.writeScope === "agent-branch"
    && permission.branchWrite === true
    && requiredTaskAllows.every((scope) => allow.includes(scope))
    && FORBIDDEN_PERMISSIONS.every((scope) => deny.includes(scope))
    && permission.externalSideEffects === false
    && permission.humanApprovalRequired === true
    && row?.target_branch_id === expectedBranch.id
    && row?.branch_article_id === articleId
    && row?.branch_name === expectedBranch.name
    && row?.branch_slug === expectedBranch.slug
    && row?.branch_status === "active"
    && row?.context_task_id === taskId
    && row?.context_article_id === articleId
    && row?.context_branch_id === expectedBranch.id;
  if (!valid) {
    throw new AgentApiError("SHARE_TASK_INVALID", "任务协作通行证必须绑定同一文章的一项有效 Agent Branch 任务", status);
  }
  return row!;
}

function parseTask(row: D1Row) {
  return {
    id: String(row.id), workItemId: row.work_item_id ? String(row.work_item_id) : null,
    articleId: String(row.article_id), projectId: row.project_id ? String(row.project_id) : null,
    packageId: row.package_id ? String(row.package_id) : null,
    baseCompositionId: row.base_composition_id ? String(row.base_composition_id) : null,
    baseCompositionSha256: row.base_composition_sha256 ? String(row.base_composition_sha256) : null,
    baseRevisionId: row.base_revision_id ? String(row.base_revision_id) : null,
    baseBranchLockVersion: row.base_branch_lock_version === null ? null : Number(row.base_branch_lock_version),
    targetBranchId: row.target_branch_id ? String(row.target_branch_id) : null,
    currentContextSnapshotId: row.current_context_snapshot_id ? String(row.current_context_snapshot_id) : null,
    activeAttemptId: row.active_attempt_id ? String(row.active_attempt_id) : null,
    assignedClientId: row.assigned_client_id ? String(row.assigned_client_id) : null,
    title: String(row.title), objective: String(row.objective), instructionsMd: String(row.instructions_md ?? ""),
    acceptance: parseJson<unknown[]>(row.acceptance_json, []), contextSpec: parseJson<JsonObject>(row.context_spec_json, {}),
    permissionCeiling: parseJson<JsonObject>(row.permission_ceiling_json, {}), priority: String(row.priority),
    state: String(row.state), lockVersion: Number(row.lock_version), createdBy: String(row.created_by),
    createdAt: String(row.created_at), updatedAt: String(row.updated_at),
    finishedAt: row.finished_at ? String(row.finished_at) : null,
    cancelledAt: row.cancelled_at ? String(row.cancelled_at) : null,
  };
}

function parseContext(row: D1Row) {
  return {
    id: String(row.id), taskId: String(row.task_id), articleId: String(row.article_id),
    branchId: row.branch_id ? String(row.branch_id) : null, revisionId: String(row.revision_id), bodySha256: String(row.body_sha256),
    corpusSchemaVersion: String(row.corpus_schema_version), corpusAlgorithmVersion: String(row.corpus_algorithm_version),
    corpusGeneratedAt: String(row.corpus_generated_at), corpusSha256: String(row.corpus_sha256), graphSha256: String(row.graph_sha256),
    rulesSha256: String(row.rules_sha256), bundle: parseJson<JsonObject>(row.bundle_json, {}),
    packageId: row.package_id ? String(row.package_id) : null,
    compositionId: row.composition_id ? String(row.composition_id) : null,
    compositionSha256: row.composition_sha256 ? String(row.composition_sha256) : null,
    packageDocumentSha256: row.package_document_sha256 ? String(row.package_document_sha256) : null,
    packageLockVersion: row.package_lock_version === null ? null : Number(row.package_lock_version),
    branchHeadRevisionId: row.branch_head_revision_id ? String(row.branch_head_revision_id) : null,
    baseRevisionId: row.branch_head_revision_id ? String(row.branch_head_revision_id) : String(row.revision_id),
    baseBranchLockVersion: row.branch_state_lock_version === null ? null : Number(row.branch_state_lock_version),
    moduleGraphSha256: row.module_graph_sha256 ? String(row.module_graph_sha256) : null,
    diagnosisSummarySha256: row.diagnosis_summary_sha256 ? String(row.diagnosis_summary_sha256) : null,
    contextSha256: String(row.context_sha256), createdAt: String(row.created_at),
  };
}

function safePackageContextProjection(row: D1Row) {
  const bundle = parseJson<JsonObject>(row.bundle_json, {});
  const packageBaseline = isObject(bundle.packageBaseline) ? bundle.packageBaseline : null;
  const packageContext = isObject(bundle.packageContext) ? bundle.packageContext : null;
  const guidanceChecklist = packageContext && isObject(packageContext.guidanceChecklist)
    ? packageContext.guidanceChecklist
    : null;
  const summary = guidanceChecklist && isObject(guidanceChecklist.summary) ? guidanceChecklist.summary : null;
  const nextAction = guidanceChecklist && isObject(guidanceChecklist.nextAction) ? guidanceChecklist.nextAction : null;
  return {
    packageBaseline: packageBaseline ? {
      packageId: packageBaseline.packageId ?? null,
      branchId: packageBaseline.branchId ?? null,
      baseRevisionId: packageBaseline.baseRevisionId ?? null,
      baseBranchLockVersion: packageBaseline.baseBranchLockVersion ?? null,
      compositionId: packageBaseline.compositionId ?? null,
      compositionSha256: packageBaseline.compositionSha256 ?? null,
      moduleGraphSha256: packageBaseline.moduleGraphSha256 ?? null,
      diagnosisSummarySha256: packageBaseline.diagnosisSummarySha256 ?? null,
      guidanceChecklistSha256: packageBaseline.guidanceChecklistSha256 ?? null,
      targetModuleKey: packageBaseline.targetModuleKey ?? null,
    } : null,
    guidanceChecklist: guidanceChecklist ? {
      schemaVersion: guidanceChecklist.schemaVersion ?? null,
      checklistSha256: guidanceChecklist.checklistSha256 ?? null,
      archiveState: guidanceChecklist.archiveState ?? null,
      archiveReady: guidanceChecklist.archiveReady === true,
      editorialWorkReady: guidanceChecklist.editorialWorkReady === true,
      processingProfile: guidanceChecklist.processingProfile ?? null,
      profileAuthority: guidanceChecklist.profileAuthority ?? null,
      summary: summary ? {
        passed: Number(summary.passed ?? 0),
        pending: Number(summary.pending ?? 0),
        blocked: Number(summary.blocked ?? 0),
        humanRequired: Number(summary.humanRequired ?? 0),
        modules: Number(summary.modules ?? 0),
        sources: Number(summary.sources ?? 0),
        relations: Number(summary.relations ?? 0),
      } : null,
      nextAction: nextAction ? {
        checkId: nextAction.checkId ?? null,
        actor: nextAction.actor ?? null,
        instruction: nextAction.instruction ?? null,
      } : null,
    } : null,
  };
}

function parseAttempt(row: D1Row) {
  return {
    id: String(row.id), taskId: String(row.task_id), attempt: Number(row.attempt), clientId: String(row.client_id),
    contextSnapshotId: String(row.context_snapshot_id), state: String(row.state),
    lastHeartbeatAt: row.last_heartbeat_at ? String(row.last_heartbeat_at) : null,
    startedAt: String(row.started_at), finishedAt: row.finished_at ? String(row.finished_at) : null,
    errorClass: row.error_class ? String(row.error_class) : null, errorSummary: row.error_summary ? String(row.error_summary) : null,
  };
}

function parseEvent(row: D1Row) {
  return {
    cursor: Number(row.cursor), id: String(row.id), taskId: String(row.task_id),
    attemptId: row.attempt_id ? String(row.attempt_id) : null, eventType: String(row.event_type), phase: String(row.phase ?? ""),
    progressPercent: row.progress_percent === null ? null : Number(row.progress_percent), currentAction: String(row.current_action ?? ""),
    nextAction: String(row.next_action ?? ""), blocker: String(row.blocker ?? ""), message: String(row.message ?? ""),
    evidence: parseJson<string[]>(row.evidence_json, []), payload: parseJson<JsonObject>(row.payload_json, {}),
    actorKind: String(row.actor_kind), actorId: String(row.actor_id), commandId: row.command_id ? String(row.command_id) : null,
    inputSha256: String(row.input_sha256), createdAt: String(row.created_at),
  };
}

function parseArtifact(row: D1Row) {
  return {
    id: String(row.id), taskId: String(row.task_id), attemptId: String(row.attempt_id), kind: String(row.kind),
    title: String(row.title), contentRef: String(row.content_ref), sha256: String(row.sha256), mediaType: String(row.media_type),
    sizeBytes: Number(row.size_bytes), payload: parseJson<JsonObject>(row.payload_json, {}), contextSha256: String(row.context_sha256),
    createdAt: String(row.created_at),
  };
}

function parseAgentBranch(row: D1Row) {
  return {
    id: String(row.id), articleId: String(row.article_id), name: String(row.name), slug: String(row.slug),
    color: String(row.color), status: String(row.status), headRevisionId: String(row.head_revision_id),
    baseRevisionId: String(row.base_revision_id), baseSourceVersionId: row.base_source_version_id ? String(row.base_source_version_id) : null,
    createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  };
}

function parseAgentRevision(row: D1Row) {
  return {
    id: String(row.id), articleId: String(row.article_id), branchId: String(row.branch_id), sequence: Number(row.sequence),
    parentRevisionId: row.parent_revision_id ? String(row.parent_revision_id) : null,
    mergeParentRevisionId: row.merge_parent_revision_id ? String(row.merge_parent_revision_id) : null,
    sourceVersionId: row.source_version_id ? String(row.source_version_id) : null,
    title: String(row.title), documentTitle: String(row.document_title), annotation: String(row.annotation ?? ""),
    bodySha256: String(row.body_sha256), authorKind: String(row.author_kind), createdAt: String(row.created_at),
  };
}

function parseAgentWorkingCopy(row: D1Row) {
  return {
    branchId: String(row.branch_id), articleId: String(row.article_id), baseRevisionId: String(row.base_revision_id),
    title: String(row.title), annotation: String(row.annotation ?? ""), bodySha256: String(row.body_sha256),
    dirty: Boolean(row.dirty), lockVersion: Number(row.lock_version), updatedAt: String(row.updated_at),
  };
}

function parseApproval(row: D1Row) {
  return {
    id: String(row.id), taskId: String(row.task_id), attemptId: String(row.attempt_id), kind: String(row.kind),
    title: String(row.title), question: String(row.question), options: parseJson<string[]>(row.options_json, []), status: String(row.status),
    requestedByClientId: String(row.requested_by_client_id), decisionNote: String(row.decision_note ?? ""),
    lockVersion: Number(row.lock_version), createdAt: String(row.created_at), decidedAt: row.decided_at ? String(row.decided_at) : null,
    decidedBy: row.decided_by ? String(row.decided_by) : null,
  };
}

function parseGraphProposal(row: D1Row) {
  return {
    id: String(row.id), taskId: String(row.task_id), attemptId: String(row.attempt_id), articleId: String(row.article_id),
    proposalKind: String(row.proposal_kind), sourceId: row.source_id ? String(row.source_id) : null,
    targetId: row.target_id ? String(row.target_id) : null, relationType: String(row.relation_type ?? ""), label: String(row.label ?? ""),
    payload: parseJson<JsonObject>(row.payload_json, {}), evidence: parseJson<string[]>(row.evidence_json, []),
    contextSha256: String(row.context_sha256), inputSha256: String(row.input_sha256), status: String(row.status),
    lockVersion: Number(row.lock_version), createdByClientId: String(row.created_by_client_id), createdAt: String(row.created_at),
    reviewedAt: row.reviewed_at ? String(row.reviewed_at) : null, reviewedBy: row.reviewed_by ? String(row.reviewed_by) : null,
    reviewNote: String(row.review_note ?? ""),
  };
}

function parsePackagePatchProposal(row: D1Row) {
  return {
    id: String(row.id), packageId: String(row.package_id), baseCompositionId: String(row.base_composition_id),
    baseCompositionSha256: String(row.base_composition_sha256), branchId: row.branch_id ? String(row.branch_id) : null,
    baseRevisionId: row.base_revision_id ? String(row.base_revision_id) : null,
    basePackageLockVersion: row.base_package_lock_version === null ? null : Number(row.base_package_lock_version),
    baseBranchLockVersion: row.base_branch_lock_version === null ? null : Number(row.base_branch_lock_version),
    taskId: row.task_id ? String(row.task_id) : null, attemptId: row.attempt_id ? String(row.attempt_id) : null,
    contextSha256: row.context_sha256 ? String(row.context_sha256) : null, title: String(row.title),
    summary: String(row.summary ?? ""), operations: parseJson<PackagePatchOperation[]>(row.operations_json, []),
    patchSha256: String(row.patch_sha256), evidence: parseJson<string[]>(row.evidence_json, []),
    diagnosticIssueIds: parseJson<string[]>(row.diagnostic_issue_ids_json, []), status: String(row.status),
    lockVersion: Number(row.lock_version), createdByKind: String(row.created_by_kind), createdById: String(row.created_by_id),
    decisionNote: String(row.decision_note ?? ""), appliedCompositionId: row.applied_composition_id ? String(row.applied_composition_id) : null,
    createdAt: String(row.created_at), reviewedAt: row.reviewed_at ? String(row.reviewed_at) : null,
    appliedAt: row.applied_at ? String(row.applied_at) : null,
  };
}

function parseProjectPackage(row: D1Row) {
  return {
    id: String(row.id), projectId: row.project_id === null ? null : String(row.project_id), articleId: String(row.article_id),
    title: String(row.title), schemaVersion: String(row.schema_version),
    branchModelVersion: row.branch_model_version === null ? null : Number(row.branch_model_version),
    primaryBranchId: row.primary_branch_id === null ? null : String(row.primary_branch_id),
    mainCompositionId: String(row.main_composition_id), mainCompositionSha256: String(row.main_composition_sha256),
    status: String(row.status), lockVersion: Number(row.lock_version), createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  };
}

function parseProjectBranchState(row: D1Row) {
  return {
    packageId: String(row.package_id), branchId: String(row.branch_id), headCompositionId: String(row.head_composition_id),
    headCompositionSha256: String(row.head_composition_sha256), headRevisionId: String(row.head_revision_id),
    status: String(row.status), lockVersion: Number(row.lock_version), createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  };
}

function parseProjectBranchWorking(row: D1Row, includeDocument = true) {
  const base = {
    packageId: String(row.package_id), branchId: String(row.branch_id), baseCompositionId: String(row.base_composition_id),
    baseRevisionId: String(row.base_revision_id), documentSha256: String(row.document_sha256), dirty: Number(row.dirty) === 1,
    lockVersion: Number(row.lock_version), updatedAt: String(row.updated_at),
  };
  return includeDocument ? { ...base, document: parseJson<JsonObject>(row.document_json, {}) } : base;
}

function parseProjectComposition(row: D1Row) {
  return {
    id: String(row.id), packageId: String(row.package_id),
    parentCompositionId: row.parent_composition_id === null ? null : String(row.parent_composition_id),
    title: String(row.title), schemaVersion: String(row.schema_version), rootModuleId: String(row.root_module_id),
    documentSha256: String(row.document_sha256), compositionSha256: String(row.composition_sha256),
    sourceArticleRevisionId: row.source_article_revision_id === null ? null : String(row.source_article_revision_id),
    authorKind: String(row.author_kind), sourcePatchId: row.source_patch_id === null ? null : String(row.source_patch_id),
    manifest: parseJson<JsonObject>(row.manifest_json, {}), createdAt: String(row.created_at),
  };
}

function parseProjectBranchCommit(row: D1Row) {
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

function parseProjectMigrationAudit(row: D1Row) {
  return {
    packageId: String(row.package_id), state: String(row.state), reasonCode: String(row.reason_code),
    detail: parseJson<JsonObject>(row.detail_json, {}), sourceSchemaVersion: String(row.source_schema_version),
    createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  };
}

function parseProjectSlice(row: D1Row, detail = false) {
  const base = {
    id: String(row.id), packageId: String(row.package_id), branchId: String(row.branch_id),
    baseRevisionId: row.base_revision_id === null ? null : String(row.base_revision_id),
    baseBranchLockVersion: row.base_branch_lock_version === null ? null : Number(row.base_branch_lock_version),
    compositionId: String(row.composition_id), compositionSha256: String(row.composition_sha256), title: String(row.title),
    sliceKind: String(row.slice_kind), sliceSha256: String(row.slice_sha256), createdByKind: String(row.created_by_kind),
    createdAt: String(row.created_at),
  };
  return detail ? {
    ...base, selector: parseJson<JsonObject>(row.selector_json, {}),
    resolvedManifest: parseJson<JsonObject>(row.resolved_manifest_json, {}),
  } : base;
}

function parseProjectDiagnosisRun(row: D1Row) {
  return {
    id: String(row.id), packageId: String(row.package_id), branchId: String(row.branch_id),
    baseRevisionId: row.base_revision_id === null ? null : String(row.base_revision_id),
    baseBranchLockVersion: row.base_branch_lock_version === null ? null : Number(row.base_branch_lock_version),
    compositionId: String(row.composition_id), compositionSha256: String(row.composition_sha256),
    algorithmVersion: String(row.algorithm_version), result: String(row.result), issueCount: Number(row.issue_count),
    errorCount: Number(row.error_count), warningCount: Number(row.warning_count), inputSha256: String(row.input_sha256),
    summarySha256: String(row.summary_sha256), createdAt: String(row.created_at),
  };
}

function parseProjectDiagnosticIssue(row: D1Row) {
  return {
    id: String(row.id), diagnosisRunId: String(row.diagnosis_run_id), packageId: String(row.package_id),
    branchId: String(row.branch_id), compositionId: String(row.composition_id),
    moduleId: row.module_id === null ? null : String(row.module_id), nodeId: row.node_id === null ? null : String(row.node_id),
    edgeId: row.edge_id === null ? null : String(row.edge_id), code: String(row.code), severity: String(row.severity),
    title: String(row.title), message: String(row.message), evidence: parseJson<string[]>(row.evidence_json, []),
    suggestedPatch: parseJson<PackagePatchOperation[]>(row.suggested_patch_json, []), issueSha256: String(row.issue_sha256),
    createdAt: String(row.created_at),
  };
}

type ClientAuth = {
  row: D1Row;
  id: string;
  role: string;
  token: string;
  scopes: string[];
  articleIds: string[];
  taskIds: string[];
  /** Revalidated root, never a one-hop issuer hint. */
  authorityLineageId: string;
  credentialPurpose: string;
  permissionProfile?: { schemaVersion: 3 | 4 | 5; catalogVersion: string; catalogSha256?: string; presetId: string; actionIds: string[]; snapshotSha256: string; directAgentApi?: true; managementProjectionVersion?: string; managementScopes?: string[]; managementProjectionSha256?: string };
};

async function authenticateClient(
  db: D1Database,
  request: Request,
  requiredScope = "task.read",
  rootManagementScope?: ManagementScope,
): Promise<ClientAuth> {
  const authorization = request.headers.get("authorization") ?? "";
  if (!authorization.startsWith("Bearer ")) throw new AgentApiError("AUTH_REQUIRED", "Agent 请求缺少 Bearer token", 401);
  const token = authorization.slice(7).trim();
  if (!token) throw new AgentApiError("AUTH_REQUIRED", "Agent token 为空", 401);
  const tokenSha256 = await sha256Text(token);
  const now = isoNow();
  const row = await db.prepare("SELECT * FROM agent_clients WHERE token_sha256 = ? LIMIT 1").bind(tokenSha256).first<D1Row>();
  if (!row || row.status !== "active") throw new AgentApiError("AUTH_INVALID", "Agent token 无效或已经撤销", 401);
  if (String(row.expires_at) <= now) throw new AgentApiError("AUTH_EXPIRED", "Agent token 已过期", 401);
  if (isAgentPrivilegeRole(row.role)) {
    try {
      const siteRoot = row.credential_purpose === "site_full_control";
      if (siteRoot && !rootManagementScope) {
        throw new AgentApiError("SITE_FULL_CONTROL_ROUTE_SCOPE_REQUIRED", "v5 根 Key 当前调用点没有明确的站内管理 scope 映射", 403);
      }
      const principal = await authenticatePrivilegedAgent(request, db, requiredScope, siteRoot ? { managementScope: rootManagementScope } : {});
      if (!principal.authorityLineageId) throw new AgentApiError("PRIVILEGED_AUTH_INVALID", "高权限 Agent 缺少已重验的授权谱系根", 403);
      return {
        row,
        id: principal.clientId,
        role: principal.role,
        token,
        scopes: siteRoot ? [...principal.scopes, requiredScope] : principal.scopes,
        articleIds: principal.articleIds,
        taskIds: principal.taskIds,
        authorityLineageId: principal.authorityLineageId,
        credentialPurpose: String(row.credential_purpose ?? "agent_api"),
        permissionProfile: principal.permissionProfile,
      };
    } catch (error) {
      const failure = error as { code?: string; message?: string; status?: number; details?: JsonObject };
      throw new AgentApiError(failure.code || "PRIVILEGED_AUTH_INVALID", failure.message || "高权限 Agent 鉴权失败", failure.status || 403, failure.details);
    }
  }
  const authorityLineageId = await assertActiveAgentClientLineage(db, String(row.id), Date.parse(now));
  const refreshed = await db.prepare("UPDATE agent_clients SET last_seen_at = ? WHERE id = ? AND status = 'active' AND expires_at > ?")
    .bind(now, row.id, now).run();
  if (Number(refreshed.meta.changes ?? 0) !== 1) throw new AgentApiError("AUTH_INVALID", "Agent token 在认证期间失效", 401);
  const scopes = parseJson<string[]>(row.scopes_json, []);
  const articleIds = parseJson<string[]>(row.article_ids_json, []);
  const taskIds = parseJson<string[]>(row.task_ids_json, []);
  if (scopes.includes("article.read")) {
    const collaborationMode = collaborationAccessModeForScopes(scopes);
    if (!collaborationMode) throw new AgentApiError("SHARE_SCOPE_INVALID", "共享通行证权限集合已漂移，已拒绝访问", 403);
    const shape = validateCollaborationGrantShape({
      mode: collaborationMode,
      articleIds,
      taskIds,
      expiresAtMs: Date.parse(String(row.expires_at)),
      nowMs: Date.parse(now),
    });
    if (!shape.valid) throw new AgentApiError(shape.code || "SHARE_GRANT_INVALID", shape.message || "共享通行证边界无效", 403);
    await sharedArticleProjection(db, articleIds[0]);
    if (collaborationMode === "editor") {
      await requireShareEditorTask(db, taskIds[0], articleIds[0], 403);
    }
  }
  return {
    row, id: String(row.id), role: String(row.role ?? "agent"), token, scopes,
    articleIds, taskIds,
    authorityLineageId, credentialPurpose: String(row.credential_purpose ?? "agent_api"),
  };
}

function requireScope(auth: ClientAuth, scope: string) {
  if (!auth.scopes.includes(scope)) throw new AgentApiError("SCOPE_DENIED", `Agent client 缺少 ${scope} 权限`, 403);
}

function controlAuthorityClientId(actor: ControlPrincipal) {
  if (actor.kind === "agent") return actor.clientId;
  return actor.management.authBasis === "site_full_control_key" && actor.management.sourceClientId
    ? actor.management.sourceClientId
    : null;
}

function clientCanAccess(auth: ClientAuth, taskId: string, articleId: string) {
  const taskAllowed = auth.taskIds.length === 0 || auth.taskIds.includes("*") || auth.taskIds.includes(taskId);
  const articleAllowed = auth.articleIds.includes("*") || auth.articleIds.includes(articleId);
  if (!taskAllowed || !articleAllowed) {
    throw new AgentApiError("OBJECT_SCOPE_DENIED", "Agent token 不包含这项任务或文章的对象边界", 403);
  }
}

function taskBoundary(auth: ClientAuth | null, tableAlias = "") {
  if (!auth) return { sql: "1 = 1", bindings: [] as string[] };
  const prefix = tableAlias ? `${tableAlias}.` : "";
  const clauses: string[] = [];
  const bindings: string[] = [];
  if (!auth.articleIds.includes("*")) {
    if (!auth.articleIds.length) return { sql: "1 = 0", bindings };
    clauses.push(`${prefix}article_id IN (${auth.articleIds.map(() => "?").join(",")})`);
    bindings.push(...auth.articleIds);
  }
  if (auth.taskIds.length && !auth.taskIds.includes("*")) {
    clauses.push(`${prefix}id IN (${auth.taskIds.map(() => "?").join(",")})`);
    bindings.push(...auth.taskIds);
  }
  return { sql: clauses.join(" AND ") || "1 = 1", bindings };
}

async function authorizeRead(db: D1Database, request: Request, scope?: string) {
  if (sameOrigin(request)) {
    await requireManagementSession(request, { scope: "management.read" });
    return null;
  }
  const auth = await authenticateClient(db, request, scope, "management.read");
  if (scope) requireScope(auth, scope);
  return auth;
}

async function tableExists(db: D1Database, table: string) {
  const row = await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1").bind(table).first<D1Row>();
  return Boolean(row);
}

function projectArticleBoundary(auth: ClientAuth, tableAlias = "") {
  const prefix = tableAlias ? `${tableAlias}.` : "";
  if (auth.articleIds.includes("*")) return { sql: "1 = 1", bindings: [] as string[] };
  if (!auth.articleIds.length) return { sql: "1 = 0", bindings: [] as string[] };
  return {
    sql: `${prefix}article_id IN (${auth.articleIds.map(() => "?").join(",")})`,
    bindings: [...auth.articleIds],
  };
}

function projectReadLimit(url: URL, fallback = 50) {
  const raw = url.searchParams.get("limit");
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 200) {
    throw new AgentApiError("INVALID_LIMIT", "limit 必须是 1 到 200 之间的整数");
  }
  return parsed;
}

async function requireProjectReadTables(db: D1Database, tables: string[]) {
  const checks = await Promise.all(tables.map(async (table) => ({ table, exists: await tableExists(db, table) })));
  const missingTables = checks.filter((item) => !item.exists).map((item) => item.table);
  if (missingTables.length) {
    throw new AgentApiError("PROJECT_STORAGE_UNAVAILABLE", "文章工程存储尚未初始化", 503, { missingTables });
  }
}

async function projectGroupDetail(db: D1Database, groupId: string) {
  const [groupResult, memberRows, edgeRows] = await db.batch<D1Row>([
    db.prepare("SELECT * FROM project_groups WHERE id = ? LIMIT 1").bind(groupId),
    db.prepare("SELECT article_id, article_project_id FROM project_group_members WHERE group_id = ? ORDER BY article_id ASC, article_project_id ASC LIMIT ?").bind(groupId, PROJECT_GROUP_MEMBER_READ_LIMIT + 1),
    db.prepare("SELECT source_article_id, target_article_id, relation_type FROM project_group_edges WHERE group_id = ? ORDER BY source_article_id ASC, target_article_id ASC, relation_type ASC LIMIT ?").bind(groupId, PROJECT_GROUP_EDGE_READ_LIMIT + 1),
  ]);
  const group = groupResult.results[0] as D1Row | undefined;
  if (!group) throw new AgentApiError("GROUP_NOT_FOUND", "ProjectGroup 不存在", 404);
  if (memberRows.results.length > PROJECT_GROUP_MEMBER_READ_LIMIT || edgeRows.results.length > PROJECT_GROUP_EDGE_READ_LIMIT) {
    throw new AgentApiError("PROJECT_GROUP_READ_LIMIT_EXCEEDED", "ProjectGroup 拓扑超过 Agent 详情读取上限", 409, {
      memberLimit: PROJECT_GROUP_MEMBER_READ_LIMIT,
      edgeLimit: PROJECT_GROUP_EDGE_READ_LIMIT,
    });
  }
  const topology = canonicalProjectGroupTopology({ groupId, members: memberRows.results.map((row) => ({ articleId: String(row.article_id), articleProjectId: String(row.article_project_id) })), edges: edgeRows.results.map((row) => ({ sourceArticleId: String(row.source_article_id), targetArticleId: String(row.target_article_id), relationType: String(row.relation_type) as "precedes" })) });
  const recomputedTopologySha256 = await sha256Text(JSON.stringify(topology)), storedTopologySha256 = String(group.topology_sha256);
  return { group: { id: groupId, title: String(group.title), status: String(group.status), lockVersion: Number(group.lock_version), createdAt: String(group.created_at), updatedAt: String(group.updated_at), archivedAt: group.archived_at === null ? null : String(group.archived_at) }, members: topology.members, edges: topology.edges, topology, storedTopologySha256, recomputedTopologySha256, integrityStatus: storedTopologySha256 === recomputedTopologySha256 && isProjectGroupDag(topology.edges) ? "valid" : "drifted" };
}
function assertProjectGroupArticleFilter(auth: ClientAuth, articleId: string | null) { if (articleId && !auth.articleIds.includes("*") && !auth.articleIds.includes(articleId)) throw new AgentApiError("OBJECT_SCOPE_DENIED", "articleId 不在 Agent token 的文章对象边界内", 403); }
async function agentCanReadWholeProjectGroup(db: D1Database, auth: ClientAuth, groupId: string) {
  if (auth.articleIds.includes("*")) return true;
  if (!auth.articleIds.length) return false;
  const row = await db.prepare(`SELECT COUNT(*) AS member_count, SUM(CASE WHEN article_id NOT IN (${auth.articleIds.map(() => "?").join(",")}) THEN 1 ELSE 0 END) AS denied_count FROM project_group_members WHERE group_id = ?`).bind(...auth.articleIds, groupId).first<D1Row>();
  return Number(row?.member_count ?? 0) > 0 && Number(row?.denied_count ?? 0) === 0;
}
async function handleProjectGroupRead(db: D1Database, auth: ClientAuth, view: string, url: URL) {
  if (view === "project_group_manifest") return {
    apiVersion: "wenmai-agent-project-group-read-v1",
    endpoint: "/api/agent/v1",
    authentication: "Authorization: Bearer <Agent token>",
    requiredScope: "package.read",
    views: ["project_group_manifest", "project_groups", "project_group"],
    readOnly: true,
    scopeContract: "A restricted token receives a non-empty group only when every member articleId is within agent_clients.article_ids_json. Star-scoped tokens may read empty groups. Partial groups are never redacted or returned.",
    listProjection: { boundedSummary: true, excludes: ["members", "edges", "topology", "integrityStatus"], detailRequiredForTopology: true },
    detailReadLimits: { members: PROJECT_GROUP_MEMBER_READ_LIMIT, edges: PROJECT_GROUP_EDGE_READ_LIMIT, exceeded: "PROJECT_GROUP_READ_LIMIT_EXCEEDED", status: 409, partialDataReturned: false },
    topologyIntegrity: "storedTopologySha256 is recomputed from stable canonical members and edges; integrityStatus is valid only for matching SHA-256 and DAG topology.",
    boundaries: { managementCookieAccepted: false, browserBindingAccepted: false, csrfAcceptedAsAuthorization: false, projectGroupBusinessWrites: false, tablesEventsReceiptsUnchanged: true, authenticationLastSeenTelemetryMayUpdate: true, mutations: "ProjectGroup writes remain owner management API only" },
  };
  await requireProjectReadTables(db, ["project_groups", "project_group_members", "project_group_edges"]);
  const limit = projectReadLimit(url), includeArchived = url.searchParams.get("includeArchived") === "true", articleId = cleanText(url.searchParams.get("articleId"), 160) || null;
  assertProjectGroupArticleFilter(auth, articleId);
  if (view === "project_group") { const groupId = requiredText(url.searchParams.get("groupId"), "groupId", 200); if (!await agentCanReadWholeProjectGroup(db, auth, groupId)) throw new AgentApiError("OBJECT_SCOPE_DENIED", "ProjectGroup 包含不在 Agent token 文章对象边界内的成员", 403); const detail = await projectGroupDetail(db, groupId); if (articleId && !detail.members.some((member) => member.articleId === articleId)) throw new AgentApiError("GROUP_NOT_FOUND", "ProjectGroup 不属于指定文章", 404); if (!includeArchived && detail.group.status !== "active") throw new AgentApiError("GROUP_NOT_FOUND", "ProjectGroup 不存在或已归档", 404); return { ...detail, readOnly: true, scopeFiltered: !auth.articleIds.includes("*"), scopeContract: "complete_group_membership_required" }; }
  const clauses = ["(? = 1 OR g.status = 'active')"], bindings: (string | number)[] = [includeArchived ? 1 : 0];
  if (articleId) { clauses.push("EXISTS (SELECT 1 FROM project_group_members filter_member WHERE filter_member.group_id = g.id AND filter_member.article_id = ?)"); bindings.push(articleId); }
  if (!auth.articleIds.includes("*")) {
    if (!auth.articleIds.length) return { groups: [], limit, readOnly: true, scopeFiltered: true, scopeContract: "complete_nonempty_group_membership_required" };
    clauses.push("EXISTS (SELECT 1 FROM project_group_members nonempty_member WHERE nonempty_member.group_id = g.id)");
    clauses.push(`NOT EXISTS (SELECT 1 FROM project_group_members scope_member WHERE scope_member.group_id = g.id AND scope_member.article_id NOT IN (${auth.articleIds.map(() => "?").join(",")}))`);
    bindings.push(...auth.articleIds);
  }
  const rows = await db.prepare(`SELECT g.id,g.title,g.status,g.lock_version,g.created_at,g.updated_at,g.archived_at,g.topology_sha256,
      (SELECT COUNT(*) FROM project_group_members member_count WHERE member_count.group_id = g.id) AS member_count,
      (SELECT COUNT(*) FROM project_group_edges edge_count WHERE edge_count.group_id = g.id) AS edge_count
    FROM project_groups g WHERE ${clauses.join(" AND ")}
    ORDER BY g.updated_at DESC, g.id ASC LIMIT ?`).bind(...bindings, limit).all<D1Row>();
  return {
    groups: rows.results.map((row) => ({
      group: { id: String(row.id), title: String(row.title), status: String(row.status), lockVersion: Number(row.lock_version), createdAt: String(row.created_at), updatedAt: String(row.updated_at), archivedAt: row.archived_at === null ? null : String(row.archived_at) },
      memberCount: Number(row.member_count),
      edgeCount: Number(row.edge_count),
      storedTopologySha256: String(row.topology_sha256),
      detailRequiredForTopology: true,
    })),
    limit,
    readOnly: true,
    scopeFiltered: !auth.articleIds.includes("*"),
    scopeContract: "complete_nonempty_group_membership_required",
  };
}

async function authorizedProjectPackageRow(db: D1Database, auth: ClientAuth, packageId: string) {
  await requireProjectReadTables(db, ["article_project_packages"]);
  const boundary = projectArticleBoundary(auth, "root");
  const row = await db.prepare(`SELECT root.* FROM article_project_packages root
    WHERE root.id = ? AND ${boundary.sql} LIMIT 1`).bind(packageId, ...boundary.bindings).first<D1Row>();
  if (!row) throw new AgentApiError("PACKAGE_NOT_FOUND", "文章工程不存在或不在 Agent token 的文章边界内", 404);
  return row;
}

async function projectMigrationAuditRow(db: D1Database, packageId: string) {
  if (!await tableExists(db, "package_branch_migration_audits")) return null;
  return db.prepare("SELECT * FROM package_branch_migration_audits WHERE package_id = ? LIMIT 1")
    .bind(packageId).first<D1Row>();
}

function projectWorkingFromJoined(row: D1Row, includeDocument = true) {
  return parseProjectBranchWorking({
    package_id: row.package_id, branch_id: row.branch_id,
    base_composition_id: row.package_base_composition_id, base_revision_id: row.package_base_revision_id,
    document_json: row.package_document_json, document_sha256: row.package_document_sha256,
    dirty: row.package_dirty, lock_version: row.package_working_lock_version, updated_at: row.package_working_updated_at,
  }, includeDocument);
}

function projectBranchEntry(row: D1Row) {
  return {
    branchId: String(row.branch_id), name: String(row.branch_name), slug: String(row.branch_slug),
    articleStatus: String(row.article_status), articleHeadRevisionId: String(row.article_head_revision_id),
    branchState: parseProjectBranchState(row), packageWorking: projectWorkingFromJoined(row, false),
  };
}

async function authorizedProjectBranch(db: D1Database, auth: ClientAuth, packageId: string, branchId: string) {
  await requireProjectReadTables(db, [
    "article_project_packages", "article_branches", "article_revisions", "branch_working_copies",
    "package_branch_states", "package_branch_working_copies", "package_compositions", "package_composition_materializations",
    "package_branch_composition_commits",
  ]);
  const root = await authorizedProjectPackageRow(db, auth, packageId);
  const audit = await projectMigrationAuditRow(db, packageId);
  if (Number(root.branch_model_version) !== 2 || audit?.state === "blocked" || audit?.state === "legacy_unbound") {
    throw new AgentApiError("PACKAGE_BRANCH_UNAVAILABLE", "文章工程多分支状态未完成迁移或已被审计阻断", 409, {
      packageId, branchId, branchModelVersion: root.branch_model_version === null ? null : Number(root.branch_model_version),
      migrationState: audit ? String(audit.state) : "missing",
    });
  }
  const row = await db.prepare(`SELECT state.*,
      branch.article_id AS branch_article_id, branch.name AS branch_name, branch.slug AS branch_slug,
      branch.status AS article_status, branch.head_revision_id AS article_head_revision_id,
      head.id AS revision_record_id, head.body_sha256 AS head_body_sha256,
      article_copy.base_revision_id AS article_working_base_revision_id,
      article_copy.body_sha256 AS article_working_body_sha256,
      article_copy.dirty AS article_working_dirty,
      article_copy.lock_version AS article_working_lock_version,
      package_copy.base_composition_id AS package_base_composition_id,
      package_copy.base_revision_id AS package_base_revision_id,
      package_copy.document_json AS package_document_json,
      package_copy.document_sha256 AS package_document_sha256,
      package_copy.dirty AS package_dirty, package_copy.lock_version AS package_working_lock_version,
      package_copy.updated_at AS package_working_updated_at,
      composition.id AS composition_record_id, composition.document_sha256 AS composition_document_sha256,
      composition.composition_sha256 AS stored_composition_sha256,
      materialization.id AS materialization_id,
      materialization.composition_id AS materialization_composition_id,
      materialization.composition_sha256 AS materialization_composition_sha256,
      materialization.article_revision_id AS materialization_revision_id,
      materialization.article_body_sha256 AS materialization_body_sha256,
      commit_ref.id AS branch_commit_id,
      commit_ref.composition_id AS commit_composition_id,
      commit_ref.composition_sha256 AS commit_composition_sha256,
      commit_ref.article_revision_id AS commit_revision_id
    FROM package_branch_states state
    JOIN article_branches branch ON branch.id = state.branch_id
    JOIN article_revisions head
      ON head.id = state.head_revision_id AND head.branch_id = state.branch_id AND head.article_id = branch.article_id
    JOIN branch_working_copies article_copy
      ON article_copy.branch_id = state.branch_id AND article_copy.article_id = branch.article_id
    JOIN package_branch_working_copies package_copy
      ON package_copy.package_id = state.package_id AND package_copy.branch_id = state.branch_id
    JOIN package_compositions composition
      ON composition.id = state.head_composition_id AND composition.package_id = state.package_id
    LEFT JOIN package_composition_materializations materialization
      ON materialization.package_id = state.package_id AND materialization.branch_id = state.branch_id
      AND materialization.article_revision_id = state.head_revision_id
    LEFT JOIN package_branch_composition_commits commit_ref
      ON commit_ref.package_id = state.package_id AND commit_ref.branch_id = state.branch_id
      AND commit_ref.article_revision_id = state.head_revision_id
    WHERE state.package_id = ? AND state.branch_id = ? LIMIT 1`)
    .bind(packageId, branchId).first<D1Row>();
  if (!row) throw new AgentApiError("PACKAGE_BRANCH_NOT_FOUND", "分支未接入该文章工程或不在文章对象边界内", 404);
  const inSync = String(row.branch_article_id) === String(root.article_id)
    && String(row.article_head_revision_id) === String(row.head_revision_id)
    && String(row.revision_record_id) === String(row.head_revision_id)
    && String(row.package_base_composition_id) === String(row.head_composition_id)
    && String(row.package_base_revision_id) === String(row.head_revision_id)
    && Number(row.package_dirty) === 0
    && String(row.package_document_sha256) === String(row.composition_document_sha256)
    && String(row.composition_record_id) === String(row.head_composition_id)
    && String(row.stored_composition_sha256) === String(row.head_composition_sha256)
    && String(row.article_working_base_revision_id) === String(row.head_revision_id)
    && String(row.article_working_body_sha256) === String(row.head_body_sha256)
    && Number(row.article_working_dirty) === 0
    && String(row.materialization_composition_id) === String(row.head_composition_id)
    && String(row.materialization_composition_sha256) === String(row.head_composition_sha256)
    && String(row.materialization_revision_id) === String(row.head_revision_id)
    && String(row.materialization_body_sha256) === String(row.head_body_sha256)
    && String(row.commit_composition_id) === String(row.head_composition_id)
    && String(row.commit_composition_sha256) === String(row.head_composition_sha256)
    && String(row.commit_revision_id) === String(row.head_revision_id);
  return { root, audit, row, inSync };
}

async function handleProjectRead(db: D1Database, auth: ClientAuth, view: string, url: URL) {
  if (view === "project_manifest") {
    return {
      apiVersion: "wenmai-agent-project-read-v1",
      endpoint: "/api/agent/v1",
      authentication: "Authorization: Bearer <Agent token>",
      requiredScope: "package.read",
      views: ["project_manifest", "project_packages", "project_branches", "project_package", "project_diagnostics", "project_slices"],
      branchContract: {
        list: "project_branches lists branches already attached to an authorized Package",
        qualifiedViews: ["project_package", "project_diagnostics", "project_slices"],
        required: ["packageId", "branchId"],
      },
      boundaries: {
        sqlObjectBoundary: "agent_clients.article_ids_json",
        crossArticleReads: false,
        managementCookieAccepted: false,
        browserBindingAccepted: false,
        duplicateCompositionDocumentReturned: false,
        mutations: "Package mutations remain Agent actions or browser management commands; this projection is read-only",
      },
      packagePatchAction: "propose_package_patch",
      guidanceChecklist: {
        schemaVersion: ARTICLE_GUIDANCE_CHECKLIST_SCHEMA_VERSION,
        returnedBy: "project_package",
        order: "read checklist -> obey nextAction -> work one module -> propose candidate patch -> await owner decision",
        completionAuthority: "coordinator_only",
      },
    };
  }

  const limit = projectReadLimit(url);
  if (view === "project_packages") {
    await requireProjectReadTables(db, ["article_project_packages"]);
    const boundary = projectArticleBoundary(auth, "root");
    const articleId = cleanText(url.searchParams.get("articleId"), 160) || null;
    const projectId = cleanText(url.searchParams.get("projectId"), 160) || null;
    const status = cleanText(url.searchParams.get("status"), 20) || null;
    if (status && !["active", "archived"].includes(status)) {
      throw new AgentApiError("INVALID_STATUS", "status 只能是 active 或 archived");
    }
    const rows = await db.prepare(`SELECT root.* FROM article_project_packages root
      WHERE ${boundary.sql} AND (? IS NULL OR root.article_id = ?)
        AND (? IS NULL OR root.project_id = ?) AND (? IS NULL OR root.status = ?)
      ORDER BY root.updated_at DESC, root.id ASC LIMIT ?`)
      .bind(...boundary.bindings, articleId, articleId, projectId, projectId, status, status, limit).all<D1Row>();
    return { packages: rows.results.map(parseProjectPackage), limit, scopeFiltered: true };
  }

  const packageId = requiredText(url.searchParams.get("packageId"), "packageId", 160);
  if (view === "project_branches") {
    await requireProjectReadTables(db, [
      "article_project_packages", "article_branches", "package_branch_states", "package_branch_working_copies",
    ]);
    const root = await authorizedProjectPackageRow(db, auth, packageId);
    const audit = await projectMigrationAuditRow(db, packageId);
    const rows = await db.prepare(`SELECT state.*,
        branch.name AS branch_name, branch.slug AS branch_slug, branch.status AS article_status,
        branch.head_revision_id AS article_head_revision_id,
        package_copy.base_composition_id AS package_base_composition_id,
        package_copy.base_revision_id AS package_base_revision_id,
        package_copy.document_sha256 AS package_document_sha256, package_copy.dirty AS package_dirty,
        package_copy.lock_version AS package_working_lock_version, package_copy.updated_at AS package_working_updated_at
      FROM package_branch_states state
      JOIN article_branches branch ON branch.id = state.branch_id AND branch.article_id = ?
      JOIN package_branch_working_copies package_copy
        ON package_copy.package_id = state.package_id AND package_copy.branch_id = state.branch_id
      WHERE state.package_id = ?
      ORDER BY CASE WHEN state.branch_id = ? THEN 0 ELSE 1 END, state.updated_at DESC, state.branch_id ASC LIMIT ?`)
      .bind(root.article_id, packageId, root.primary_branch_id, limit).all<D1Row>();
    return {
      package: parseProjectPackage(root), primaryBranchId: root.primary_branch_id ? String(root.primary_branch_id) : null,
      branchModel: {
        version: root.branch_model_version === null ? null : Number(root.branch_model_version),
        migrationState: audit ? String(audit.state) : "missing",
        readable: Number(root.branch_model_version) === 2 && audit?.state !== "blocked" && audit?.state !== "legacy_unbound",
      },
      branches: rows.results.map(projectBranchEntry), migrationAudit: audit ? parseProjectMigrationAudit(audit) : null, limit,
    };
  }

  const branchId = requiredText(url.searchParams.get("branchId"), "branchId", 160);
  const selected = await authorizedProjectBranch(db, auth, packageId, branchId);
  if (view === "project_package") {
    await requireProjectReadTables(db, ["package_compositions", "package_branch_composition_commits"]);
    const [composition, commits] = await Promise.all([
      db.prepare("SELECT * FROM package_compositions WHERE id = ? AND package_id = ? LIMIT 1")
        .bind(selected.row.head_composition_id, packageId).first<D1Row>(),
      db.prepare(`SELECT * FROM package_branch_composition_commits
        WHERE package_id = ? AND branch_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`)
        .bind(packageId, branchId, limit).all<D1Row>(),
    ]);
    if (!composition) throw new AgentApiError("PACKAGE_COMPOSITION_UNAVAILABLE", "分支头 Composition 缺失，文章工程状态不完整", 409);
    const workingCopy = projectWorkingFromJoined(selected.row, true);
    const parsedComposition = parseProjectComposition(composition);
    const guidanceChecklist = await buildVerifiedPackageGuidanceChecklist(db, {
      document: workingCopy.document as PackageDocument,
      packageStatus: String(selected.root.status),
      branchStatus: String(selected.row.status),
      workingCopyDirty: workingCopy.dirty,
      branchBridgeInSync: selected.inSync,
      bindings: {
        articleId: String(selected.root.article_id),
        projectId: selected.root.project_id === null ? null : String(selected.root.project_id),
        packageId, branchId,
        revisionId: String(selected.row.head_revision_id),
        compositionId: parsedComposition.id,
        bodySha256: String(selected.row.head_body_sha256),
        compositionSha256: parsedComposition.compositionSha256,
        documentSha256: workingCopy.documentSha256,
        packageLockVersion: Number(selected.root.lock_version),
        branchLockVersion: Number(selected.row.lock_version),
        workingCopyLockVersion: workingCopy.lockVersion,
      },
    });
    return {
      package: parseProjectPackage(selected.root), selectedBranchId: branchId,
      selectedBranch: projectBranchEntry(selected.row), branchState: parseProjectBranchState(selected.row),
      branchWorkingCopy: workingCopy, workingCopy, composition: parsedComposition,
      recentBranchCommits: commits.results.map(parseProjectBranchCommit),
      migrationAudit: selected.audit ? parseProjectMigrationAudit(selected.audit) : null,
      readOnly: true, guidanceChecklist,
      boundary: { scope: "package.read", articleId: String(selected.root.article_id), packageId, branchId, inSync: selected.inSync },
    };
  }
  if (view === "project_diagnostics") {
    await requireProjectReadTables(db, ["package_diagnosis_runs", "package_diagnostic_issues"]);
    const diagnosisRunId = cleanText(url.searchParams.get("diagnosisRunId"), 160) || null;
    if (diagnosisRunId) {
      const run = await db.prepare(`SELECT * FROM package_diagnosis_runs
        WHERE id = ? AND package_id = ? AND branch_id = ? LIMIT 1`)
        .bind(diagnosisRunId, packageId, branchId).first<D1Row>();
      if (!run) throw new AgentApiError("DIAGNOSIS_RUN_NOT_FOUND", "诊断不存在或不属于指定文章工程分支", 404);
      const issues = await db.prepare(`SELECT * FROM package_diagnostic_issues
        WHERE diagnosis_run_id = ? AND package_id = ? AND branch_id = ?
        ORDER BY severity ASC, code ASC, id ASC LIMIT ?`)
        .bind(diagnosisRunId, packageId, branchId, limit).all<D1Row>();
      return { diagnosisRun: parseProjectDiagnosisRun(run), issues: issues.results.map(parseProjectDiagnosticIssue), limit };
    }
    const compositionId = cleanText(url.searchParams.get("compositionId"), 160) || null;
    const [runs, issues] = await Promise.all([
      db.prepare(`SELECT * FROM package_diagnosis_runs
        WHERE package_id = ? AND branch_id = ? AND (? IS NULL OR composition_id = ?)
        ORDER BY created_at DESC, id DESC LIMIT ?`)
        .bind(packageId, branchId, compositionId, compositionId, limit).all<D1Row>(),
      db.prepare(`SELECT * FROM package_diagnostic_issues
        WHERE package_id = ? AND branch_id = ? AND (? IS NULL OR composition_id = ?)
        ORDER BY created_at DESC, id DESC LIMIT ?`)
        .bind(packageId, branchId, compositionId, compositionId, limit).all<D1Row>(),
    ]);
    return { diagnosisRuns: runs.results.map(parseProjectDiagnosisRun), issues: issues.results.map(parseProjectDiagnosticIssue), limit };
  }
  if (view === "project_slices") {
    await requireProjectReadTables(db, ["package_slices"]);
    const sliceId = cleanText(url.searchParams.get("sliceId"), 160) || null;
    if (sliceId) {
      const row = await db.prepare(`SELECT * FROM package_slices
        WHERE id = ? AND package_id = ? AND branch_id = ? LIMIT 1`)
        .bind(sliceId, packageId, branchId).first<D1Row>();
      if (!row) throw new AgentApiError("SLICE_NOT_FOUND", "切片不存在或不属于指定文章工程分支", 404);
      return { slice: parseProjectSlice(row, true) };
    }
    const rows = await db.prepare(`SELECT * FROM package_slices
      WHERE package_id = ? AND branch_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`)
      .bind(packageId, branchId, limit).all<D1Row>();
    return { slices: rows.results.map((row) => parseProjectSlice(row)), limit };
  }
  throw new AgentApiError("UNKNOWN_VIEW", `未知 Agent Project GET view：${view}`, 404);
}

let corpusShaPromise: Promise<string> | null = null;
const REVIEW_CONTEXT_TABLES = ["agent_clients", "article_requirements", "human_annotations", "lifecycle_retrospectives", "agent_tasks", "agent_context_snapshots", "agent_progress_events", "lifecycle_events", "lifecycle_rule_candidates"] as const;
const REVIEW_CONTEXT_LIMITS = { requirements: 512, annotations: 2048, retrospectives: 512, tasks: 512, progressEvents: 4096, externalObservations: 512, ruleCandidates: 1024 } as const;
function reviewContextArticleScope(auth: ClientAuth | null, articleId: string) { if (auth && !auth.articleIds.includes("*") && !auth.articleIds.includes(articleId)) throw new AgentApiError("OBJECT_SCOPE_DENIED", "Agent Key 不包含此文章", 403); }
async function requireReviewContextSchema(db: D1Database) { const present = await Promise.all(REVIEW_CONTEXT_TABLES.map((table) => tableExists(db, table))); if (!present.every(Boolean)) throw new AgentApiError("REVIEW_CONTEXT_UNAVAILABLE", "review_context 所需的只读 schema 尚未初始化", 503); }
async function boundedReviewRows(db: D1Database, label: keyof typeof REVIEW_CONTEXT_LIMITS, sql: string, bindings: unknown[]) { const limit = REVIEW_CONTEXT_LIMITS[label]; const result = await db.prepare(`${sql} LIMIT ?`).bind(...bindings, limit + 1).all<D1Row>(); if (result.results.length > limit) throw new AgentApiError("REVIEW_CONTEXT_LIMIT_EXCEEDED", `${label} 超出完整只读投影上限`, 409); return result.results; }
function reviewRequirement(row: D1Row) { return { id: String(row.id), articleId: String(row.article_id), requirementKey: String(row.requirement_key), revision: Number(row.revision), supersedesRequirementId: row.supersedes_requirement_id ? String(row.supersedes_requirement_id) : null, packageId: row.package_id ? String(row.package_id) : null, branchId: row.branch_id ? String(row.branch_id) : null, baseRevisionId: String(row.base_revision_id), baseBodySha256: String(row.base_body_sha256), title: String(row.title), requirementText: String(row.requirement_text), acceptance: parseJson<unknown>(row.acceptance_json, []), priority: String(row.priority), inputSha256: String(row.input_sha256), status: String(row.status), lockVersion: Number(row.lock_version), createdAt: String(row.created_at), acceptedAt: row.accepted_at ? String(row.accepted_at) : null }; }
function reviewAnnotation(row: D1Row) { return { id: String(row.id), articleId: String(row.article_id), requirementId: String(row.requirement_id), subjectType: String(row.subject_type), subjectId: String(row.subject_id), snapshotSha256: String(row.snapshot_sha256), labelSchemaVersion: Number(row.label_schema_version), labelKind: String(row.label_kind), verdict: String(row.verdict), severity: String(row.severity), note: String(row.note), details: parseJson<unknown>(row.details_json, {}), evidenceRefs: parseJson<string[]>(row.evidence_refs_json, []), annotationSha256: String(row.annotation_sha256), inputSha256: String(row.input_sha256), supersedesAnnotationId: row.supersedes_annotation_id ? String(row.supersedes_annotation_id) : null, createdAt: String(row.created_at) }; }
async function handleReviewContextRead(db: D1Database, auth: ClientAuth | null, url: URL) {
  const articleId = requiredText(url.searchParams.get("articleId"), "articleId", 120); reviewContextArticleScope(auth, articleId); await requireReviewContextSchema(db);
  const generatedAt = isoNow(), asOf = cleanText(url.searchParams.get("asOf"), 40) || generatedAt;
  if (!Number.isFinite(new Date(asOf).getTime()) || new Date(asOf).toISOString() !== asOf) throw new AgentApiError("AS_OF_INVALID", "asOf 必须是 ISO 8601 时间戳");
  const [requirementRows, annotationRows, reviewRows, taskRows, progressRows, observationRows, candidateRows] = await Promise.all([
    boundedReviewRows(db, "requirements", "SELECT * FROM article_requirements WHERE article_id=? AND status='accepted' ORDER BY id", [articleId]),
    boundedReviewRows(db, "annotations", "SELECT a.* FROM human_annotations a JOIN article_requirements r ON r.id=a.requirement_id WHERE a.article_id=? AND r.article_id=? AND r.status='accepted' AND NOT EXISTS(SELECT 1 FROM human_annotations replacement WHERE replacement.supersedes_annotation_id=a.id) ORDER BY a.id", [articleId, articleId]),
    boundedReviewRows(db, "retrospectives", "SELECT * FROM lifecycle_retrospectives WHERE article_id=? AND status IN ('reviewed','closed') ORDER BY id", [articleId]),
    boundedReviewRows(db, "tasks", "SELECT t.id,t.state,t.created_at,t.finished_at,t.base_revision_id,t.current_context_snapshot_id,c.revision_id,c.body_sha256,c.context_sha256 FROM agent_tasks t LEFT JOIN agent_context_snapshots c ON c.id=t.current_context_snapshot_id AND c.task_id=t.id AND c.article_id=t.article_id WHERE t.article_id=? ORDER BY t.id", [articleId]),
    boundedReviewRows(db, "progressEvents", "SELECT e.id,e.task_id,e.event_type,e.input_sha256,e.created_at FROM agent_progress_events e JOIN agent_tasks t ON t.id=e.task_id WHERE t.article_id=? ORDER BY e.task_id,e.created_at,e.id", [articleId]),
    boundedReviewRows(db, "externalObservations", "SELECT id,payload_json,input_sha256,created_at FROM lifecycle_events WHERE article_id=? AND event_type='external_ai_change.recorded' ORDER BY id", [articleId]),
    boundedReviewRows(db, "ruleCandidates", "SELECT id,state,evidence_refs_json FROM lifecycle_rule_candidates WHERE article_id=? AND state<>'rejected' ORDER BY id", [articleId]),
  ]);
  const requirements = requirementRows.map(reviewRequirement), annotations = annotationRows.map(reviewAnnotation);
  const tasks = taskRows.map((task) => { const bound = requirements.filter((requirement) => requirement.baseRevisionId === task.revision_id && requirement.baseBodySha256 === task.body_sha256); return { id: String(task.id), state: String(task.state), createdAt: String(task.created_at), finishedAt: task.finished_at ? String(task.finished_at) : null, currentContextSnapshotId: task.current_context_snapshot_id ? String(task.current_context_snapshot_id) : null, contextSha256: task.context_sha256 ? String(task.context_sha256) : null, requirementIds: bound.map((requirement) => requirement.id), annotationIds: annotations.filter((annotation) => bound.some((requirement) => requirement.id === annotation.requirementId)).map((annotation) => annotation.id), progressEvents: progressRows.filter((event) => event.task_id === task.id).map((event) => ({ id: String(event.id), eventType: String(event.event_type), inputSha256: String(event.input_sha256), createdAt: String(event.created_at) })) }; });
  const observations = observationRows.map((row) => ({ ...parseJson<JsonObject>(row.payload_json, {}), id: String(row.id), observedAt: String(row.created_at), eventInputSha256: String(row.input_sha256) }));
  const candidates = candidateRows.flatMap((row) => { const digest = parseJson<unknown[]>(row.evidence_refs_json, []).find((value) => typeof value === "string" && /^source-digest:[a-f0-9]{64}$/u.test(value)); return typeof digest === "string" ? [{ id: String(row.id), sourceDigest: digest.slice(14) }] : []; });
  const proposalContext = await buildRsiProposalContext({ asOf, tasks, acceptedRequirements: requirements.map((requirement) => ({ id: requirement.id, articleId: requirement.articleId, priority: requirement.priority as "must", status: "accepted", createdAt: requirement.createdAt, acceptedAt: requirement.acceptedAt, inputSha256: requirement.inputSha256, lockVersion: requirement.lockVersion })), activeAnnotations: annotations, reviewedOrClosedRetrospectives: reviewRows.map((row) => ({ id: String(row.id), articleId: String(row.article_id), projectId: String(row.project_id), releaseId: row.release_id ? String(row.release_id) : null, title: String(row.title), summary: String(row.summary), state: String(row.status), evidenceRefs: parseJson<string[]>(row.evidence_refs_json, []), lockVersion: Number(row.lock_version), updatedAt: String(row.updated_at) })), externalObservations: observations, existingRuleCandidates: candidates, requestedSourceSetSha256: cleanText(url.searchParams.get("sourceSetSha256"), 64) || undefined });
  const source = { articleId, requirements, annotations, proposalSourceSetSha256: proposalContext.sourceSetSha256 };
  return { schemaVersion: "wenmai-agent-review-context/1.0", annotationRsiSchemaVersion: ANNOTATION_RSI_SCHEMA_VERSION, view: "review_context", articleId, generatedAt, asOf, bodyTextIncluded: false, advisoryOnly: true, autoAdopt: false, canonicalSourceSha256: await sha256RsiText(canonicalRsiJson(source)), collectionDigests: { acceptedRequirementsSha256: await sha256RsiText(canonicalRsiJson({ articleId, requirements })), activeAnnotationsSha256: await sha256RsiText(canonicalRsiJson({ articleId, annotations })), proposalSourceSetSha256: proposalContext.sourceSetSha256 }, counts: { acceptedRequirements: requirements.length, activeAnnotations: annotations.length, reviewedOrClosedRetrospectives: reviewRows.length, tasks: taskRows.length, progressEvents: progressRows.length, externalObservations: observationRows.length, ruleCandidates: candidateRows.length }, requirements: { items: requirements, page: { limit: REVIEW_CONTEXT_LIMITS.requirements, nextCursor: null } }, annotations: { items: annotations, page: { limit: REVIEW_CONTEXT_LIMITS.annotations, nextCursor: null } }, proposalContext };
}
function corpusSha256() {
  if (!corpusShaPromise) {
    corpusShaPromise = sha256Text(canonicalJson({
      schemaVersion: indexedCorpus.schemaVersion,
      algorithmVersion: indexedCorpus.algorithmVersion,
      generatedAt: indexedCorpus.generatedAt,
      articles: operativeArticles.map((article) => ({
        id: article.id,
        updatedAt: article.updatedAt,
        representativeVersionId: article.representativeVersionId,
        textHash: article.versions.find((version) => version.id === article.representativeVersionId)?.textHash ?? "",
      })),
      graphEdges: operativeGraph.edges.map((edge) => ({ id: edge.id, source: edge.source, target: edge.target, algorithmVersion: edge.algorithmVersion })),
    }));
  }
  return corpusShaPromise;
}

function boundedSubgraph(seedIds: string[], depth: number, limit: number) {
  const maxDepth = Math.max(0, Math.min(2, depth));
  const maxItems = Math.max(1, Math.min(100, limit));
  const observed = new Set(seedIds.slice(0, 20));
  let frontier = [...observed];
  const edges: typeof operativeGraph.edges = [];
  for (let level = 0; level < maxDepth && frontier.length && edges.length < maxItems; level += 1) {
    const next = new Set<string>();
    for (const edge of operativeGraph.edges) {
      if (edges.length >= maxItems) break;
      if (!frontier.includes(edge.source) && !frontier.includes(edge.target)) continue;
      if (!edges.some((item) => item.id === edge.id)) edges.push(edge);
      for (const id of [edge.source, edge.target]) if (!observed.has(id)) { observed.add(id); next.add(id); }
    }
    frontier = [...next];
  }
  const nodes = operativeGraph.nodes.filter((node) => observed.has(node.id)).slice(0, maxItems);
  const nodeIds = new Set(nodes.map((node) => node.id));
  const filteredEdges = edges.filter((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target)).slice(0, maxItems);
  return { nodes, edges: filteredEdges, truncated: observed.size > nodes.length || edges.length >= maxItems };
}

function sanitizePermissionCeiling(value: unknown, forcedWriteScope?: string) {
  const object = isObject(value) ? value : {};
  const rawRequested = Array.isArray(object.allow) ? object.allow : Array.isArray(object.scopes) ? object.scopes : [...TASK_PERMISSION_ALLOWLIST];
  const writeScope = forcedWriteScope || cleanText(object.writeScope, 40) || "artifact-only";
  if (!["artifact-only", "agent-branch", "graph-proposal", "package-patch"].includes(writeScope)) {
    throw new AgentApiError("INVALID_WRITE_SCOPE", "writeScope 只能是 artifact-only、agent-branch、graph-proposal 或 package-patch");
  }
  const requested = rawRequested.map(String);
  if (writeScope === "agent-branch" && !requested.includes("branch.agent_write")) requested.push("branch.agent_write");
  if (writeScope === "package-patch" && !requested.includes("package.patch.propose")) requested.push("package.patch.propose");
  let allow = [...new Set(requested.filter((item) => TASK_PERMISSION_ALLOWLIST.has(item)))];
  const branchWrite = writeScope === "agent-branch" && allow.includes("branch.agent_write");
  const packagePatch = writeScope === "package-patch" && allow.includes("package.patch.propose");
  if (!branchWrite) allow = allow.filter((item) => item !== "branch.agent_write");
  if (!packagePatch) allow = allow.filter((item) => item !== "package.patch.propose");
  return {
    allow, deny: [...FORBIDDEN_PERMISSIONS], writeScope, branchWrite, packagePatch,
    externalSideEffects: false, humanApprovalRequired: true,
  };
}

function agentTaskCode(taskId: string) {
  return taskId.replace(/^agent-task-/, "").replaceAll("-", "").slice(0, 12);
}

function agentBranchIdentity(taskId: string) {
  const code = agentTaskCode(taskId);
  return { id: `agent-branch-${taskId}`, name: `agent/${code}`, slug: `agent-${code}` };
}

type FrozenSourceOverride = {
  branchId: string;
  revisionId: string;
  documentTitle: string;
  bodyText: string;
  bodySha256: string;
};

async function prepareAgentBranch(db: D1Database, taskId: string, articleId: string, baseBranchId: string | null) {
  const article = operativeArticles.find((item) => item.id === articleId);
  if (!article) throw new AgentApiError("ARTICLE_NOT_FOUND", "文章不在当前 corpus 索引中", 404);
  const identity = agentBranchIdentity(taskId);
  let revisionId: string;
  let bodyText: string;
  let bodySha256: string;
  let documentTitle: string;
  let sourceVersionId: string | null;
  let rootRevision: {
    id: string; sourceVersionId: string; title: string; annotation: string; bodyText: string; bodySha256: string;
  } | null = null;
  if (baseBranchId) {
    const base = await db.prepare(`SELECT branch.id AS branch_id, branch.name AS branch_name, branch.head_revision_id,
      revision.document_title, revision.body_text, revision.body_sha256, revision.source_version_id
      FROM article_branches branch JOIN article_revisions revision ON revision.id = branch.head_revision_id
      WHERE branch.id = ? AND branch.article_id = ? AND branch.status = 'active' LIMIT 1`)
      .bind(baseBranchId, articleId).first<D1Row>();
    if (!base) throw new AgentApiError("BASE_BRANCH_NOT_FOUND", "Agent 分支基线不存在、不活动或不属于任务文章", 409);
    revisionId = String(base.head_revision_id);
    bodyText = String(base.body_text ?? "");
    bodySha256 = String(base.body_sha256 ?? "");
    documentTitle = String(base.document_title ?? article.title);
    sourceVersionId = base.source_version_id ? String(base.source_version_id) : null;
  } else {
    const sourceVersion = article.versions.find((version) => version.id === article.representativeVersionId);
    if (!sourceVersion) throw new AgentApiError("CONTEXT_SOURCE_UNAVAILABLE", "代表源版本不在 corpus 索引中", 409);
    bodySha256 = sourceVersion.textHash;
    bodyText = textIndex.blobs[bodySha256] ?? textIndex.versions[sourceVersion.id] ?? "";
    documentTitle = article.title;
    sourceVersionId = sourceVersion.id;
    revisionId = `revision-${crypto.randomUUID()}`;
    rootRevision = {
      id: revisionId,
      sourceVersionId: sourceVersion.id,
      title: `Agent 分支基线 · ${sourceVersion.name}`,
      annotation: "由任务创建时冻结的代表源版本建立；该修订只作为 Agent 专属分支基线。",
      bodyText,
      bodySha256,
    };
  }
  if (!bodyText || !SHA256_RE.test(bodySha256) || await sha256Text(bodyText) !== bodySha256) {
    throw new AgentApiError("CONTEXT_SOURCE_UNAVAILABLE", "Agent 分支基线正文或摘要不可验证", 409);
  }
  if (bodyText.length > 2_000_000) throw new AgentApiError("CONTEXT_TOO_LARGE", "Agent 分支基线正文超过 200 万字符", 413);
  return {
    ...identity, articleId, baseBranchId, baseRevisionId: revisionId, sourceVersionId, rootRevision,
    sourceOverride: { branchId: identity.id, revisionId, documentTitle, bodyText, bodySha256 } satisfies FrozenSourceOverride,
  };
}

async function adoptedRules(db: D1Database, articleId: string) {
  if (!(await tableExists(db, "lifecycle_rule_candidates"))) return [];
  const rows = await db.prepare(`SELECT id, title, rule_text, scope, counterexamples, implementation_target, regression_ref, evidence_refs_json, updated_at
    FROM lifecycle_rule_candidates WHERE article_id = ? AND state = 'adopted' ORDER BY updated_at DESC LIMIT 40`)
    .bind(articleId).all<D1Row>();
  return rows.results.map((row) => ({
    id: String(row.id), title: String(row.title), ruleText: String(row.rule_text), scope: String(row.scope ?? ""),
    counterexamples: String(row.counterexamples ?? ""), implementationTarget: String(row.implementation_target ?? ""),
    regressionRef: String(row.regression_ref ?? ""), evidenceRefs: parseJson<string[]>(row.evidence_refs_json, []), updatedAt: String(row.updated_at),
  }));
}

type FrozenPackageSnapshot = {
  packageId: string;
  compositionId: string;
  compositionSha256: string;
  documentSha256: string;
  packageLockVersion: number;
  branchId: string;
  baseRevisionId: string;
  baseBranchLockVersion: number;
  branchHeadBodySha256: string;
  packageWorkingLockVersion: number;
  articleWorkingLockVersion: number;
  branchCommitId: string;
  primaryBranch: boolean;
  moduleGraphSha256: string;
  diagnosisRunId: string | null;
  diagnosisSummarySha256: string;
  guidanceChecklistSha256: string;
  diagnosticIssueIds: string[];
  bundle: JsonObject;
};

function frozenPackageDocument(snapshot: FrozenPackageSnapshot) {
  const packageContext = isObject(snapshot.bundle.package) ? snapshot.bundle.package : null;
  const document = packageContext && isObject(packageContext.document) ? packageContext.document : null;
  if (!document || !Array.isArray(document.modules) || !Array.isArray(document.edges)) {
    throw new AgentApiError("PACKAGE_DOCUMENT_INVALID", "冻结 Package 上下文缺少可校验的模块文档", 409);
  }
  return document;
}

function assertFrozenTargetModule(snapshot: FrozenPackageSnapshot, value: unknown) {
  const targetModuleKey = requiredText(value, "targetModuleKey", 120);
  const document = frozenPackageDocument(snapshot);
  const moduleKeys = document.modules
    .filter(isObject)
    .map((module) => cleanText(module.key, 120))
    .filter(Boolean);
  if (!moduleKeys.includes(targetModuleKey)) {
    throw new AgentApiError("PACKAGE_TARGET_MODULE_NOT_FOUND", "targetModuleKey 不属于冻结 Composition", 409, {
      targetModuleKey,
      availableModuleKeys: moduleKeys.slice(0, 100),
    });
  }
  return targetModuleKey;
}

async function packageStorageAvailable(db: D1Database) {
  const required = [
    "article_project_packages", "package_compositions", "package_composition_nodes",
    "package_composition_edges", "package_modules", "package_module_revisions",
    "package_module_revision_refs", "package_branch_states", "package_branch_working_copies",
    "package_branch_composition_commits", "package_branch_migration_audits",
    "package_composition_materializations", "package_diagnosis_runs", "package_diagnostic_issues",
  ];
  const results = await Promise.all(required.map((table) => tableExists(db, table)));
  return results.every(Boolean);
}

async function loadFrozenPackageSnapshot(
  db: D1Database,
  articleId: string,
  requestedBranchId: string | null,
  required: boolean,
): Promise<FrozenPackageSnapshot | null> {
  if (!(await packageStorageAvailable(db))) {
    if (required) throw new AgentApiError("PACKAGE_STORAGE_UNAVAILABLE", "ArticleProject Package 存储尚未初始化", 409);
    return null;
  }
  const packageRoot = await db.prepare(`SELECT package.*, audit.state AS migration_state, audit.reason_code AS migration_reason
    FROM article_project_packages package
    LEFT JOIN package_branch_migration_audits audit ON audit.package_id = package.id
    WHERE package.article_id = ? AND package.status = 'active' LIMIT 1`).bind(articleId).first<D1Row>();
  if (!packageRoot) {
    if (required) throw new AgentApiError("PACKAGE_NOT_FOUND", "任务文章尚未建立 ArticleProject Package", 409);
    return null;
  }
  if (Number(packageRoot.branch_model_version) !== 2
    || !packageRoot.migration_state
    || ["blocked", "legacy_unbound"].includes(String(packageRoot.migration_state))) {
    throw new AgentApiError("PACKAGE_BRANCH_MIGRATION_REQUIRED", "Package 分支状态未完成 0010 迁移或迁移审计已阻断", 409, {
      packageId: packageRoot.id,
      branchModelVersion: packageRoot.branch_model_version === null ? null : Number(packageRoot.branch_model_version),
      migrationState: packageRoot.migration_state ?? null,
      reasonCode: packageRoot.migration_reason ?? null,
    });
  }
  const primaryBranchId = packageRoot.primary_branch_id ? String(packageRoot.primary_branch_id) : "";
  const selectedBranchId = requestedBranchId || primaryBranchId;
  if (!selectedBranchId) throw new AgentApiError("PACKAGE_BRANCH_REQUIRED", "Package 任务必须显式绑定已接入的 ArticleBranch", 409);
  const row = await db.prepare(`SELECT package.id AS package_id, package.project_id, package.title AS package_title,
      package.primary_branch_id, package.lock_version AS package_lock_version,
      state.head_composition_id, state.head_composition_sha256, state.head_revision_id,
      state.status AS package_branch_status, state.lock_version AS branch_state_lock_version,
      composition.document_json, composition.document_sha256,
      package_copy.base_composition_id, package_copy.base_revision_id,
      package_copy.document_sha256 AS package_copy_document_sha256,
      package_copy.dirty AS package_copy_dirty, package_copy.lock_version AS package_copy_lock_version,
      branch.id AS branch_id, branch.name AS branch_name, branch.slug AS branch_slug,
      branch.status AS article_branch_status, branch.head_revision_id AS article_head_revision_id,
      head.body_sha256 AS head_body_sha256, head.document_title,
      branch_copy.base_revision_id AS branch_copy_base_revision_id,
      branch_copy.body_sha256 AS branch_copy_body_sha256, branch_copy.dirty AS branch_copy_dirty,
      branch_copy.lock_version AS branch_copy_lock_version,
      bridge.id AS materialization_id, bridge.article_revision_id, bridge.article_body_sha256,
      bridge.renderer_key, bridge.renderer_version,
      commit_ref.id AS branch_commit_id, commit_ref.parent_composition_id,
      commit_ref.previous_revision_id, commit_ref.source_kind, commit_ref.source_patch_id,
      commit_ref.created_by_kind AS commit_created_by_kind, commit_ref.created_at AS commit_created_at
    FROM article_project_packages package
    JOIN package_branch_states state
      ON state.package_id = package.id AND state.branch_id = ?
    JOIN package_compositions composition
      ON composition.id = state.head_composition_id AND composition.package_id = state.package_id
      AND composition.composition_sha256 = state.head_composition_sha256
    JOIN package_branch_working_copies package_copy
      ON package_copy.package_id = state.package_id AND package_copy.branch_id = state.branch_id
    JOIN article_branches branch ON branch.id = state.branch_id AND branch.article_id = package.article_id
    JOIN article_revisions head ON head.id = state.head_revision_id AND head.branch_id = state.branch_id
      AND head.article_id = package.article_id
    JOIN branch_working_copies branch_copy ON branch_copy.branch_id = state.branch_id AND branch_copy.article_id = package.article_id
    JOIN package_composition_materializations bridge
      ON bridge.package_id = state.package_id AND bridge.branch_id = state.branch_id
      AND bridge.composition_id = state.head_composition_id
      AND bridge.composition_sha256 = state.head_composition_sha256
      AND bridge.article_revision_id = head.id AND bridge.article_body_sha256 = head.body_sha256
    JOIN package_branch_composition_commits commit_ref
      ON commit_ref.package_id = state.package_id AND commit_ref.branch_id = state.branch_id
      AND commit_ref.composition_id = state.head_composition_id
      AND commit_ref.composition_sha256 = state.head_composition_sha256
      AND commit_ref.article_revision_id = state.head_revision_id
    WHERE package.id = ? AND package.status = 'active' AND package.branch_model_version = 2 LIMIT 1`)
    .bind(selectedBranchId, packageRoot.id).first<D1Row>();
  if (!row) throw new AgentApiError("PACKAGE_BRIDGE_BROKEN", "Package、Composition、ArticleBranch 与 Revision 的证据链不完整", 409);
  const branchBridgeInSync = row.package_branch_status === "active"
    && row.article_branch_status === "active"
    && row.article_head_revision_id === row.head_revision_id
    && row.base_composition_id === row.head_composition_id
    && row.base_revision_id === row.head_revision_id
    && row.package_copy_document_sha256 === row.document_sha256
    && Number(row.package_copy_dirty) === 0
    && row.branch_copy_base_revision_id === row.head_revision_id
    && row.branch_copy_body_sha256 === row.head_body_sha256
    && Number(row.branch_copy_dirty) === 0;
  if (!branchBridgeInSync) {
    throw new AgentApiError("PACKAGE_BRIDGE_STALE", "Package 或 ArticleBranch 工作副本不在冻结所需的 clean head", 409, {
      packageId: row.package_id, branchId: row.branch_id, headRevisionId: row.head_revision_id,
    });
  }
  const ownerPackageId = String(row.package_id);
  const compositionId = String(row.head_composition_id);
  const nodesResult = await db.prepare(`SELECT node.id AS node_id, node.node_key, node.slot, node.ordinal, node.required,
      node.config_json, module.id AS module_id, module.module_key, module.module_kind, module.schema_key, module.schema_version,
      revision.id AS module_revision_id, revision.parent_revision_id, revision.title AS module_title,
      revision.content_format, revision.content_text, revision.content_json, revision.content_sha256,
      revision.metadata_json, revision.revision_sha256, revision.author_kind
    FROM package_composition_nodes node
    JOIN package_modules module ON module.id = node.module_id AND module.package_id = node.package_id
    JOIN package_module_revisions revision
      ON revision.id = node.module_revision_id AND revision.module_id = module.id AND revision.package_id = node.package_id
    WHERE node.package_id = ? AND node.composition_id = ?
    ORDER BY node.slot, node.ordinal, node.node_key LIMIT 201`)
    .bind(ownerPackageId, compositionId).all<D1Row>();
  if (nodesResult.results.length > 200) throw new AgentApiError("PACKAGE_CONTEXT_TOO_LARGE", "Package 模块数超过 Agent 冻结上限 200", 413);
  const edgesResult = await db.prepare(`SELECT id, edge_key, source_node_id, target_node_id, relation_type,
      ordinal, condition_json, edge_sha256 FROM package_composition_edges
    WHERE package_id = ? AND composition_id = ? ORDER BY ordinal, edge_key LIMIT 401`)
    .bind(ownerPackageId, compositionId).all<D1Row>();
  if (edgesResult.results.length > 400) throw new AgentApiError("PACKAGE_CONTEXT_TOO_LARGE", "Package 边数超过 Agent 冻结上限 400", 413);
  const refsResult = await db.prepare(`SELECT ref.module_revision_id, ref.ref_kind, ref.ref_id, ref.relation_type, ref.anchor_json
    FROM package_module_revision_refs ref
    WHERE ref.package_id = ? AND EXISTS (
      SELECT 1 FROM package_composition_nodes node
      WHERE node.composition_id = ? AND node.module_revision_id = ref.module_revision_id
    ) ORDER BY ref.module_revision_id, ref.ref_kind, ref.ref_id, ref.relation_type LIMIT 401`)
    .bind(ownerPackageId, compositionId).all<D1Row>();
  if (refsResult.results.length > 400) throw new AgentApiError("PACKAGE_CONTEXT_TOO_LARGE", "Package 引用数超过 Agent 冻结上限 400", 413);
  const refsByRevision = new Map<string, JsonObject[]>();
  for (const ref of refsResult.results) {
    const key = String(ref.module_revision_id);
    const list = refsByRevision.get(key) ?? [];
    list.push({
      refKind: String(ref.ref_kind), refId: String(ref.ref_id), relationType: String(ref.relation_type),
      anchor: parseJson<JsonObject>(ref.anchor_json, {}),
    });
    refsByRevision.set(key, list);
  }
  const moduleGraph = {
    schemaVersion: "wenmai-package-module-graph-v1",
    nodes: nodesResult.results.map((node) => ({
      nodeId: String(node.node_id), nodeKey: String(node.node_key), slot: String(node.slot), ordinal: Number(node.ordinal),
      required: Number(node.required) === 1, config: parseJson<JsonObject>(node.config_json, {}),
      module: {
        id: String(node.module_id), key: String(node.module_key), kind: String(node.module_kind),
        schemaKey: String(node.schema_key), schemaVersion: String(node.schema_version),
      },
      revision: {
        id: String(node.module_revision_id), parentRevisionId: node.parent_revision_id ? String(node.parent_revision_id) : null,
        title: String(node.module_title), contentFormat: String(node.content_format),
        contentText: String(node.content_text ?? ""), content: parseJson<JsonObject>(node.content_json, {}),
        contentSha256: String(node.content_sha256), revisionSha256: String(node.revision_sha256),
        metadata: parseJson<JsonObject>(node.metadata_json, {}), authorKind: String(node.author_kind),
        refs: refsByRevision.get(String(node.module_revision_id)) ?? [],
      },
    })),
    edges: edgesResult.results.map((edge) => ({
      id: String(edge.id), key: String(edge.edge_key), sourceNodeId: String(edge.source_node_id),
      targetNodeId: String(edge.target_node_id), relationType: String(edge.relation_type), ordinal: Number(edge.ordinal),
      condition: parseJson<JsonObject>(edge.condition_json, {}), edgeSha256: String(edge.edge_sha256),
    })),
  };
  const moduleGraphSha256 = await sha256Text(canonicalJson(moduleGraph));
  const diagnosisRun = await db.prepare(`SELECT * FROM package_diagnosis_runs
    WHERE package_id = ? AND branch_id = ? AND base_revision_id = ? AND base_branch_lock_version = ?
      AND composition_id = ? AND composition_sha256 = ?
    ORDER BY created_at DESC LIMIT 1`).bind(
    ownerPackageId, row.branch_id, row.head_revision_id, row.branch_state_lock_version,
    compositionId, row.head_composition_sha256,
  ).first<D1Row>();
  const issues = diagnosisRun
    ? await db.prepare(`SELECT id, module_id, node_id, edge_id, code, severity, title, message,
        evidence_json, issue_sha256 FROM package_diagnostic_issues
      WHERE diagnosis_run_id = ? AND package_id = ? AND branch_id = ? AND composition_id = ?
      ORDER BY severity, code, id LIMIT 101`).bind(diagnosisRun.id, ownerPackageId, row.branch_id, compositionId).all<D1Row>()
    : { results: [] as D1Row[] };
  if (issues.results.length > 100) throw new AgentApiError("PACKAGE_CONTEXT_TOO_LARGE", "诊断问题超过 Agent 冻结上限 100", 413);
  const diagnosis = diagnosisRun ? {
    status: "completed", runId: String(diagnosisRun.id), result: String(diagnosisRun.result),
    algorithmVersion: String(diagnosisRun.algorithm_version), inputSha256: String(diagnosisRun.input_sha256),
    summarySha256: String(diagnosisRun.summary_sha256), issueCount: Number(diagnosisRun.issue_count),
    errorCount: Number(diagnosisRun.error_count), warningCount: Number(diagnosisRun.warning_count),
    issues: issues.results.map((issue) => ({
      id: String(issue.id), moduleId: issue.module_id ? String(issue.module_id) : null,
      nodeId: issue.node_id ? String(issue.node_id) : null, edgeId: issue.edge_id ? String(issue.edge_id) : null,
      code: String(issue.code), severity: String(issue.severity), title: String(issue.title), message: String(issue.message),
      evidence: parseJson<unknown[]>(issue.evidence_json, []), issueSha256: String(issue.issue_sha256),
    })),
  } : { status: "not_run", runId: null, result: null, issues: [] };
  const diagnosisSummarySha256 = await sha256Text(canonicalJson(diagnosis));
  const document = parseJson<PackageDocument>(row.document_json, {} as PackageDocument);
  const guidanceChecklist = await buildVerifiedPackageGuidanceChecklist(db, {
    document,
    packageStatus: "active",
    branchStatus: String(row.package_branch_status),
    workingCopyDirty: Number(row.package_copy_dirty) === 1,
    branchBridgeInSync,
    bindings: {
      articleId,
      projectId: row.project_id === null ? null : String(row.project_id),
      packageId: ownerPackageId, branchId: String(row.branch_id),
      revisionId: String(row.head_revision_id), compositionId,
      bodySha256: String(row.head_body_sha256),
      compositionSha256: String(row.head_composition_sha256),
      documentSha256: String(row.document_sha256),
      packageLockVersion: Number(row.package_lock_version),
      branchLockVersion: Number(row.branch_state_lock_version),
      workingCopyLockVersion: Number(row.package_copy_lock_version),
    },
  });
  const bundle: JsonObject = {
    schemaVersion: "wenmai-agent-package-context-v2",
    package: {
      id: ownerPackageId, projectId: row.project_id ? String(row.project_id) : null, articleId,
      title: String(row.package_title), lockVersion: Number(row.package_lock_version),
      primaryBranchId: row.primary_branch_id ? String(row.primary_branch_id) : null,
      selectedBranchIsPrimary: row.primary_branch_id === row.branch_id,
      selectedCompositionId: compositionId, selectedCompositionSha256: String(row.head_composition_sha256),
      documentSha256: String(row.document_sha256), document,
    },
    branch: {
      id: String(row.branch_id), name: String(row.branch_name), slug: String(row.branch_slug),
      headRevisionId: String(row.head_revision_id), headBodySha256: String(row.head_body_sha256),
      stateLockVersion: Number(row.branch_state_lock_version),
      packageWorkingCopyLockVersion: Number(row.package_copy_lock_version),
      articleWorkingCopyLockVersion: Number(row.branch_copy_lock_version), clean: true,
    },
    branchCommit: {
      id: String(row.branch_commit_id), parentCompositionId: row.parent_composition_id ? String(row.parent_composition_id) : null,
      compositionId, compositionSha256: String(row.head_composition_sha256),
      previousRevisionId: row.previous_revision_id ? String(row.previous_revision_id) : null,
      articleRevisionId: String(row.head_revision_id), sourceKind: String(row.source_kind),
      sourcePatchId: row.source_patch_id ? String(row.source_patch_id) : null,
      createdByKind: String(row.commit_created_by_kind), createdAt: String(row.commit_created_at),
    },
    materialization: {
      id: String(row.materialization_id), articleRevisionId: String(row.article_revision_id),
      articleBodySha256: String(row.article_body_sha256), rendererKey: String(row.renderer_key),
      rendererVersion: String(row.renderer_version),
    },
    moduleGraph: { ...moduleGraph, sha256: moduleGraphSha256 },
    diagnosis: { ...diagnosis, sha256: diagnosisSummarySha256 },
    guidanceChecklist,
    allowedPatchOperations: ["replace_module", "remove_module", "upsert_edge", "remove_edge"],
    writeBoundary: { candidateOnly: true, directApply: false, compositionAdvance: false, articleBranchAdvance: false,
      singleExistingModuleOnly: true, incidentEdgesOnly: true },
  };
  const bundleSize = new TextEncoder().encode(canonicalJson(bundle)).byteLength;
  if (bundleSize > 1_200_000) throw new AgentApiError("PACKAGE_CONTEXT_TOO_LARGE", "Package 冻结上下文超过 1.2 MB", 413);
  return {
    packageId: ownerPackageId, compositionId, compositionSha256: String(row.head_composition_sha256),
    documentSha256: String(row.document_sha256), packageLockVersion: Number(row.package_lock_version),
    branchId: String(row.branch_id), baseRevisionId: String(row.head_revision_id),
    baseBranchLockVersion: Number(row.branch_state_lock_version), branchHeadBodySha256: String(row.head_body_sha256),
    packageWorkingLockVersion: Number(row.package_copy_lock_version), articleWorkingLockVersion: Number(row.branch_copy_lock_version),
    branchCommitId: String(row.branch_commit_id), primaryBranch: row.primary_branch_id === row.branch_id,
    moduleGraphSha256, diagnosisRunId: diagnosisRun ? String(diagnosisRun.id) : null,
    diagnosisSummarySha256, guidanceChecklistSha256: guidanceChecklist.checklistSha256,
    diagnosticIssueIds: issues.results.map((issue) => String(issue.id)), bundle,
  };
}

async function buildContextSnapshot(db: D1Database, task: {
  id: string; articleId: string; targetBranchId: string | null; title: string; objective: string; instructionsMd: string;
  acceptance: unknown[]; contextSpec: JsonObject; permissionCeiling: JsonObject; sourceOverride?: FrozenSourceOverride;
  packageSnapshot?: FrozenPackageSnapshot | null;
}) {
  const writeScope = cleanText(task.permissionCeiling.writeScope, 40) || "artifact-only";
  // Source/workspace tasks remain independent from ArticleProject Package state.
  // Only package-patch tasks freeze and later revalidate a branch-scoped Package baseline.
  const packageSnapshot = writeScope === "package-patch"
    ? (task.packageSnapshot !== undefined
      ? task.packageSnapshot
      : await loadFrozenPackageSnapshot(db, task.articleId, task.targetBranchId, true))
    : null;
  const targetModuleKey = writeScope === "package-patch"
    ? assertFrozenTargetModule(packageSnapshot as FrozenPackageSnapshot, task.contextSpec.targetModuleKey)
    : null;
  const article = operativeArticles.find((item) => item.id === task.articleId) ?? null;
  if (!article && !packageSnapshot) {
    throw new AgentApiError("ARTICLE_NOT_FOUND", "任务文章不在当前 corpus 索引中，且没有可冻结的 ArticleProject Package", 404);
  }
  let branchId: string | null = null;
  let revisionId = article ? `source:${article.representativeVersionId}` : "";
  const packageBundle = packageSnapshot?.bundle;
  const packageIdentity = packageBundle && isObject(packageBundle.package) ? packageBundle.package : {};
  let documentTitle = article?.title ?? (cleanText(packageIdentity.title, 300) || task.title);
  let bodySha256 = article?.versions.find((version) => version.id === article.representativeVersionId)?.textHash ?? "";
  let bodyText = bodySha256 ? textIndex.blobs[bodySha256] ?? "" : "";
  if (task.sourceOverride) {
    branchId = task.sourceOverride.branchId;
    revisionId = task.sourceOverride.revisionId;
    documentTitle = task.sourceOverride.documentTitle;
    bodyText = task.sourceOverride.bodyText;
    bodySha256 = task.sourceOverride.bodySha256;
  } else if (task.targetBranchId && await tableExists(db, "article_branches") && await tableExists(db, "article_revisions")) {
    const row = await db.prepare(`SELECT b.id AS branch_id, b.head_revision_id, r.document_title, r.body_text, r.body_sha256
      FROM article_branches b JOIN article_revisions r ON r.id = b.head_revision_id
      WHERE b.id = ? AND b.article_id = ? AND b.status = 'active' LIMIT 1`)
      .bind(task.targetBranchId, task.articleId).first<D1Row>();
    if (!row) throw new AgentApiError("BRANCH_NOT_FOUND", "目标分支不存在、不活动或不属于任务文章", 409);
    branchId = String(row.branch_id);
    revisionId = String(row.head_revision_id);
    documentTitle = String(row.document_title);
    bodyText = String(row.body_text ?? "");
    bodySha256 = String(row.body_sha256);
  }
  if (!SHA256_RE.test(bodySha256) || !bodyText) throw new AgentApiError("CONTEXT_SOURCE_UNAVAILABLE", "无法冻结任务正文与摘要", 409);
  if (bodyText.length > 600_000) throw new AgentApiError("CONTEXT_TOO_LARGE", "目标文章正文超过 Agent 上下文冻结上限", 413);
  if (writeScope === "package-patch") {
    if (!packageSnapshot) throw new AgentApiError("PACKAGE_CONTEXT_REQUIRED", "package-patch 任务缺少冻结 Package 上下文", 409);
    if (branchId !== packageSnapshot.branchId
      || revisionId !== packageSnapshot.baseRevisionId
      || bodySha256 !== packageSnapshot.branchHeadBodySha256) {
      throw new AgentApiError("PACKAGE_SOURCE_MISMATCH", "任务正文基线与 Package 目标 ArticleBranch 不一致", 409);
    }
  }
  const graph = boundedSubgraph([task.articleId], 1, 60);
  const rules = await adoptedRules(db, task.articleId);
  const [corpusSha, graphSha, rulesSha] = await Promise.all([
    corpusSha256(), sha256Text(canonicalJson(graph)), sha256Text(canonicalJson(rules)),
  ]);
  const boundPackageContext = packageSnapshot ? {
    ...packageSnapshot.bundle,
    allowedPatchOperations: ["replace_module", "remove_module", "upsert_edge", "remove_edge"],
    patchTarget: {
      targetModuleKey,
      moduleScope: "single_existing_module",
      edgeScope: "incident_to_target_only",
      allowModuleRename: false,
      allowAddModule: false,
      allowReplaceDocument: false,
    },
    writeBoundary: {
      ...(isObject(packageSnapshot.bundle.writeBoundary) ? packageSnapshot.bundle.writeBoundary : {}),
      targetModuleKey,
      singleExistingModuleOnly: true,
      incidentEdgesOnly: true,
    },
  } : null;
  const bundle = {
    schemaVersion: API_VERSION,
    task: {
      id: task.id, title: task.title, objective: task.objective, instructionsMd: task.instructionsMd,
      acceptance: task.acceptance, contextSpec: task.contextSpec, targetModuleKey,
    },
    source: { articleId: task.articleId, branchId, revisionId, documentTitle, bodySha256, bodyText },
    corpus: {
      schemaVersion: indexedCorpus.schemaVersion, algorithmVersion: indexedCorpus.algorithmVersion,
      generatedAt: indexedCorpus.generatedAt, sha256: corpusSha,
    },
    graph,
    adoptedRules: rules,
    packageBaseline: packageSnapshot ? {
      packageId: packageSnapshot.packageId,
      branchId: packageSnapshot.branchId,
      baseRevisionId: packageSnapshot.baseRevisionId,
      baseBranchLockVersion: packageSnapshot.baseBranchLockVersion,
      compositionId: packageSnapshot.compositionId,
      compositionSha256: packageSnapshot.compositionSha256,
      moduleGraphSha256: packageSnapshot.moduleGraphSha256,
      diagnosisSummarySha256: packageSnapshot.diagnosisSummarySha256,
      guidanceChecklistSha256: packageSnapshot.guidanceChecklistSha256,
      targetModuleKey,
    } : null,
    packageContext: boundPackageContext,
    permissionCeiling: task.permissionCeiling,
    immutableRules: {
      generatedCorpusReadOnly: true,
      directMainWrite: false,
      mergeMain: false,
      editorialApproval: false,
      releaseApproval: false,
      externalSubmit: false,
      ruleAdoption: false,
      graphMutation: "proposal_only",
      packageMutation: packageSnapshot ? "candidate_patch_only" : "unavailable",
      outputStatus: "candidate_or_draft",
    },
  };
  const contextSha256 = await sha256Text(canonicalJson(bundle));
  if (new TextEncoder().encode(canonicalJson(bundle)).byteLength > 1_900_000) {
    throw new AgentApiError("CONTEXT_TOO_LARGE", "冻结任务上下文超过 1.9 MB", 413);
  }
  const boundPackageSnapshot = writeScope === "package-patch" ? packageSnapshot : null;
  return {
    id: `agent-context-${crypto.randomUUID()}`, taskId: task.id, articleId: task.articleId, branchId, revisionId,
    bodySha256, corpusSchemaVersion: indexedCorpus.schemaVersion, corpusAlgorithmVersion: indexedCorpus.algorithmVersion,
    corpusGeneratedAt: indexedCorpus.generatedAt, corpusSha256: corpusSha, graphSha256: graphSha, rulesSha256: rulesSha,
    packageId: boundPackageSnapshot?.packageId ?? null,
    compositionId: boundPackageSnapshot?.compositionId ?? null,
    compositionSha256: boundPackageSnapshot?.compositionSha256 ?? null,
    packageDocumentSha256: boundPackageSnapshot?.documentSha256 ?? null,
    packageLockVersion: boundPackageSnapshot?.packageLockVersion ?? null,
    branchHeadRevisionId: boundPackageSnapshot?.baseRevisionId ?? null,
    branchStateLockVersion: boundPackageSnapshot?.baseBranchLockVersion ?? null,
    moduleGraphSha256: boundPackageSnapshot?.moduleGraphSha256 ?? null,
    diagnosisSummarySha256: boundPackageSnapshot?.diagnosisSummarySha256 ?? null,
    bundle, contextSha256, createdAt: isoNow(),
  };
}

function contextInsert(db: D1Database, context: Awaited<ReturnType<typeof buildContextSnapshot>>) {
  const prefix = `INSERT INTO agent_context_snapshots
    (id, task_id, article_id, branch_id, revision_id, body_sha256, corpus_schema_version, corpus_algorithm_version,
     corpus_generated_at, corpus_sha256, graph_sha256, rules_sha256, package_id, composition_id, composition_sha256,
      package_document_sha256, package_lock_version, branch_head_revision_id, branch_state_lock_version, module_graph_sha256,
     diagnosis_summary_sha256, bundle_json, context_sha256, created_at)`;
  const values = [
      context.id, context.taskId, context.articleId, context.branchId, context.revisionId, context.bodySha256,
      context.corpusSchemaVersion, context.corpusAlgorithmVersion, context.corpusGeneratedAt, context.corpusSha256,
      context.graphSha256, context.rulesSha256, context.packageId, context.compositionId, context.compositionSha256,
      context.packageDocumentSha256, context.packageLockVersion, context.branchHeadRevisionId, context.branchStateLockVersion,
      context.moduleGraphSha256, context.diagnosisSummarySha256, canonicalJson(context.bundle), context.contextSha256,
      context.createdAt,
  ];
  if (!context.packageId) {
    return db.prepare(`${prefix} VALUES (${values.map(() => "?").join(",")})`).bind(...values);
  }
  return db.prepare(`${prefix}
    SELECT ${values.map(() => "?").join(",")} WHERE EXISTS (
      SELECT 1 FROM article_project_packages package
      JOIN package_branch_migration_audits audit ON audit.package_id = package.id
        AND audit.state NOT IN ('blocked','legacy_unbound')
      JOIN package_branch_states state ON state.package_id = package.id AND state.branch_id = ?
      JOIN package_compositions composition ON composition.id = state.head_composition_id AND composition.package_id = state.package_id
      JOIN package_branch_working_copies package_copy
        ON package_copy.package_id = state.package_id AND package_copy.branch_id = state.branch_id
      JOIN article_branches branch ON branch.id = state.branch_id AND branch.article_id = package.article_id
      JOIN article_revisions head ON head.id = state.head_revision_id AND head.branch_id = state.branch_id
        AND head.article_id = package.article_id
      JOIN branch_working_copies branch_copy ON branch_copy.branch_id = state.branch_id AND branch_copy.article_id = package.article_id
      JOIN package_composition_materializations bridge
        ON bridge.package_id = state.package_id AND bridge.branch_id = state.branch_id
        AND bridge.composition_id = state.head_composition_id
        AND bridge.composition_sha256 = state.head_composition_sha256
        AND bridge.article_revision_id = state.head_revision_id AND bridge.article_body_sha256 = head.body_sha256
      JOIN package_branch_composition_commits commit_ref
        ON commit_ref.package_id = state.package_id AND commit_ref.branch_id = state.branch_id
        AND commit_ref.composition_id = state.head_composition_id
        AND commit_ref.composition_sha256 = state.head_composition_sha256
        AND commit_ref.article_revision_id = state.head_revision_id
      WHERE package.id = ? AND package.status = 'active' AND package.branch_model_version = 2
        AND state.lock_version = ? AND state.head_composition_id = ? AND state.head_composition_sha256 = ?
        AND state.head_revision_id = ? AND state.status = 'active' AND composition.document_sha256 = ?
        AND package_copy.base_composition_id = state.head_composition_id
        AND package_copy.base_revision_id = state.head_revision_id
        AND package_copy.document_sha256 = composition.document_sha256 AND package_copy.dirty = 0
        AND branch.head_revision_id = state.head_revision_id AND branch.status = 'active'
        AND branch_copy.base_revision_id = state.head_revision_id
        AND branch_copy.body_sha256 = head.body_sha256 AND branch_copy.dirty = 0
    )`).bind(
      ...values, context.branchId, context.packageId, context.branchStateLockVersion,
      context.compositionId, context.compositionSha256, context.branchHeadRevisionId, context.packageDocumentSha256,
    );
}

async function parseMutationBody(request: Request) {
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw new AgentApiError("PAYLOAD_TOO_LARGE", "Agent 请求超过 2.2 MB", 413);
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    throw new AgentApiError("UNSUPPORTED_MEDIA_TYPE", "写接口只接受 application/json", 415);
  }
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) throw new AgentApiError("PAYLOAD_TOO_LARGE", "Agent 请求超过 2.2 MB", 413);
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new AgentApiError("INVALID_JSON", "请求正文不是有效 JSON 对象"); }
  if (!isObject(value)) throw new AgentApiError("INVALID_JSON", "请求正文必须是 JSON 对象");
  const action = requiredText(value.action, "action", 80);
  const payload = isObject(value.payload)
    ? value.payload
    : Object.fromEntries(Object.entries(value).filter(([key]) => !["action", "commandId"].includes(key)));
  const commandId = cleanText(value.commandId, 160);
  return { action, commandId, payload };
}

async function inspectReceipt(db: D1Database, commandId: string, commandType: string, actorId: string, requestSha256: string) {
  const row = await db.prepare("SELECT * FROM command_receipts WHERE id = ? LIMIT 1").bind(commandId).first<D1Row>();
  if (!row) return null;
  if (row.command_type !== commandType || row.actor_id !== actorId || row.request_sha256 !== requestSha256) {
    throw new AgentApiError("COMMAND_ID_REUSED", "同一 commandId 已绑定不同动作、身份或请求摘要", 409);
  }
  if (Number(row.status_code) === 0) throw new AgentApiError("COMMAND_IN_PROGRESS", "同一命令仍在处理或需要恢复审计", 409);
  const saved = parseJson<{ status?: number; data?: JsonObject; error?: { code?: string; message?: string; details?: JsonObject } }>(row.response_json, {});
  if (Number(row.status_code) >= 400) {
    throw new AgentApiError(
      cleanText(saved.error?.code, 120) || "COMMAND_FAILED",
      cleanText(saved.error?.message, 2000) || "该幂等命令此前已经失败",
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
  const commandType = `agent.${action}`;
  const requestSha256 = await sha256Text(canonicalJson({ action, actorId, payload }));
  const replay = await inspectReceipt(db, commandId, commandType, actorId, requestSha256);
  if (replay) return replay;
  try {
    await db.prepare(`INSERT INTO command_receipts
      (id, command_type, actor_id, request_sha256, response_json, status_code)
      VALUES (?, ?, ?, ?, '{}', 0)`).bind(commandId, commandType, actorId, requestSha256).run();
  } catch {
    const raced = await inspectReceipt(db, commandId, commandType, actorId, requestSha256);
    if (raced) return raced;
    throw new AgentApiError("COMMAND_IN_PROGRESS", "命令领取竞争未完成，请稍后重试", 409);
  }
  try {
    const result = await handler(requestSha256);
    const status = result.status ?? 200;
    const persistedData = { ...result.data };
    if (action === "claim" && isObject(persistedData.lease)) {
      const persistedLease = { ...persistedData.lease };
      delete persistedLease.leaseToken;
      persistedData.lease = persistedLease;
    }
    if (action === "issue_client") {
      delete persistedData.token;
      persistedData.shownOnce = false;
      persistedData.secretRecoverable = false;
      persistedData.recovery = "secret_unavailable_revoke_and_reissue";
    }
    await db.prepare(`UPDATE command_receipts SET response_json = ?, status_code = ?, completed_at = ?
      WHERE id = ? AND command_type = ? AND actor_id = ? AND request_sha256 = ? AND status_code = 0`)
      .bind(canonicalJson({ data: persistedData }), status, isoNow(), commandId, commandType, actorId, requestSha256).run();
    return { status, data: result.data };
  } catch (error) {
    const failure = error instanceof AgentApiError
      ? error
      : new AgentApiError("INTERNAL_ERROR", "Agent 控制面处理失败", 500);
    await db.prepare(`UPDATE command_receipts SET response_json = ?, status_code = ?, completed_at = ?
      WHERE id = ? AND command_type = ? AND actor_id = ? AND request_sha256 = ? AND status_code = 0`)
      .bind(canonicalJson({ error: { code: failure.code, message: failure.message, details: failure.details } }),
        failure.status, isoNow(), commandId, commandType, actorId, requestSha256)
      .run();
    throw error;
  }
}

async function taskRow(db: D1Database, taskId: string) {
  const row = await db.prepare("SELECT * FROM agent_tasks WHERE id = ? LIMIT 1").bind(taskId).first<D1Row>();
  if (!row) throw new AgentApiError("TASK_NOT_FOUND", "AgentTask 不存在", 404);
  return row;
}

async function authorizeTask(db: D1Database, auth: ClientAuth, taskId: string, scope: string) {
  requireScope(auth, scope);
  const row = await taskRow(db, taskId);
  clientCanAccess(auth, taskId, String(row.article_id));
  return row;
}

async function leaseGuard(db: D1Database, auth: ClientAuth, payload: JsonObject) {
  const taskId = requiredText(payload.taskId, "taskId", 120);
  const attemptId = requiredText(payload.attemptId, "attemptId", 120);
  const leaseId = requiredText(payload.leaseId, "leaseId", 120);
  const leaseToken = requiredText(payload.leaseToken, "leaseToken", 500);
  const task = await taskRow(db, taskId);
  clientCanAccess(auth, taskId, String(task.article_id));
  const now = isoNow();
  const leaseTokenSha256 = await sha256Text(leaseToken);
  const row = await db.prepare(`SELECT lease.*, attempt.state AS attempt_state, attempt.context_snapshot_id,
      context.context_sha256, context.bundle_json, task.state AS task_state
    FROM agent_task_leases lease
    JOIN agent_task_attempts attempt ON attempt.id = lease.attempt_id
    JOIN agent_context_snapshots context ON context.id = attempt.context_snapshot_id
    JOIN agent_tasks task ON task.id = lease.task_id
    WHERE lease.id = ? AND lease.task_id = ? AND lease.attempt_id = ? AND lease.client_id = ?
      AND lease.lease_token_sha256 = ? AND lease.revoked_at IS NULL AND lease.expires_at > ?
      AND attempt.state IN ('claimed','running') AND task.active_attempt_id = attempt.id LIMIT 1`)
    .bind(leaseId, taskId, attemptId, auth.id, leaseTokenSha256, now).first<D1Row>();
  if (!row) throw new AgentApiError("LEASE_INVALID", "当前租约不能用于写回；任务、attempt 和服务器当前状态未被本请求改写。停止使用旧 leaseToken，刷新任务；仅在任务回到 queued 后重新 claim。", 409);
  const suppliedContextSha = requiredText(payload.contextSha256, "contextSha256", 64).toLowerCase();
  if (suppliedContextSha !== row.context_sha256) throw new AgentApiError("CONTEXT_STALE", "写回上下文摘要与领取时冻结快照不一致", 409);
  return { task, lease: row, taskId, attemptId, leaseId, leaseTokenSha256, contextSha256: suppliedContextSha, now };
}

async function assertFrozenPackageContextCurrent(
  db: D1Database,
  task: D1Row,
  context: D1Row,
  currentSnapshot?: FrozenPackageSnapshot | null,
) {
  const taskPackageId = task.package_id ? String(task.package_id) : null;
  if (!taskPackageId) return null;
  const targetBranchId = String(task.target_branch_id ?? "");
  if (!targetBranchId || String(context.branch_id ?? "") !== targetBranchId) {
    throw new AgentApiError("PACKAGE_BRANCH_CONTEXT_MISMATCH", "任务目标分支与冻结上下文分支不一致", 409);
  }
  const snapshot = currentSnapshot === undefined
    ? await loadFrozenPackageSnapshot(db, String(task.article_id), targetBranchId, true)
    : currentSnapshot;
  const frozenBundle = parseJson<JsonObject>(context.bundle_json, {});
  const frozenPackageBaseline = isObject(frozenBundle.packageBaseline) ? frozenBundle.packageBaseline : {};
  const taskContextSpec = parseJson<JsonObject>(task.context_spec_json, {});
  const taskTargetModuleKey = cleanText(taskContextSpec.targetModuleKey, 120);
  const frozenTargetModuleKey = cleanText(frozenPackageBaseline.targetModuleKey, 120);
  if (!taskTargetModuleKey || !frozenTargetModuleKey || taskTargetModuleKey !== frozenTargetModuleKey) {
    throw new AgentApiError("PACKAGE_TARGET_MODULE_CONTEXT_MISMATCH", "任务合同与冻结上下文的 targetModuleKey 不一致", 409, {
      taskTargetModuleKey: taskTargetModuleKey || null,
      frozenTargetModuleKey: frozenTargetModuleKey || null,
    });
  }
  if (snapshot) assertFrozenTargetModule(snapshot, frozenTargetModuleKey);
  const expected = {
    packageId: String(context.package_id ?? ""), compositionId: String(context.composition_id ?? ""),
    compositionSha256: String(context.composition_sha256 ?? ""), documentSha256: String(context.package_document_sha256 ?? ""),
    baseRevisionId: String(context.branch_head_revision_id ?? ""),
    baseBranchLockVersion: Number(context.branch_state_lock_version),
    moduleGraphSha256: String(context.module_graph_sha256 ?? ""), diagnosisSummarySha256: String(context.diagnosis_summary_sha256 ?? ""),
    guidanceChecklistSha256: String(frozenPackageBaseline.guidanceChecklistSha256 ?? ""),
    targetModuleKey: frozenTargetModuleKey,
  };
  if (!snapshot || taskPackageId !== snapshot.packageId
    || String(task.target_branch_id ?? "") !== snapshot.branchId
    || task.base_composition_id !== snapshot.compositionId
    || task.base_composition_sha256 !== snapshot.compositionSha256
    || task.base_revision_id !== snapshot.baseRevisionId
    || Number(task.base_branch_lock_version) !== snapshot.baseBranchLockVersion
    || expected.packageId !== snapshot.packageId || expected.compositionId !== snapshot.compositionId
    || expected.compositionSha256 !== snapshot.compositionSha256 || expected.documentSha256 !== snapshot.documentSha256
    || expected.baseRevisionId !== snapshot.baseRevisionId
    || expected.baseBranchLockVersion !== snapshot.baseBranchLockVersion
    || expected.moduleGraphSha256 !== snapshot.moduleGraphSha256
    || expected.diagnosisSummarySha256 !== snapshot.diagnosisSummarySha256
    || expected.guidanceChecklistSha256 !== snapshot.guidanceChecklistSha256) {
    throw new AgentApiError("PACKAGE_CONTEXT_STALE", "冻结的目标分支、Revision、Composition、模块图或诊断摘要已不再是当前基线", 409, {
      expected, current: snapshot ? {
        packageId: snapshot.packageId, branchId: snapshot.branchId, compositionId: snapshot.compositionId,
        compositionSha256: snapshot.compositionSha256, documentSha256: snapshot.documentSha256,
        baseRevisionId: snapshot.baseRevisionId, baseBranchLockVersion: snapshot.baseBranchLockVersion,
        moduleGraphSha256: snapshot.moduleGraphSha256, diagnosisSummarySha256: snapshot.diagnosisSummarySha256,
        guidanceChecklistSha256: snapshot.guidanceChecklistSha256, targetModuleKey: frozenTargetModuleKey,
      } : null,
    });
  }
  return snapshot;
}

async function manifestData() {
  return {
    name: "Wenmai Agent Control Plane",
    apiVersion: API_VERSION,
    discovery: "/.well-known/wenmai-agent.json",
    endpoint: "/api/agent/v1",
    responseEnvelope: { success: "{ok:true,requestId,data}", failure: "{ok:false,requestId,error:{code,message,details?}}" },
    views: [
      "manifest", "health", "articles", "article", "tasks", "task", "context", "events", "knowledge", "graph",
      "project_manifest", "project_packages", "project_branches", "project_package", "project_diagnostics", "project_slices",
      "project_group_manifest", "project_groups", "project_group",
    ],
    taskStates: [...TASK_STATES],
    actions: [
      "issue_client", "revoke_client", "create_task", "update_task", "cancel_task", "claim", "heartbeat", "progress",
      "add_artifact", "propose_revision", "propose_package_patch", "await_human", "decide_approval", "complete", "fail", "release",
      "create_graph_proposal", "decide_graph_proposal",
    ],
    agentBootSequence: [
      "read manifest",
      "list assigned tasks",
      "claim one task",
      "read frozen context",
      "heartbeat and report progress",
      "submit artifacts or proposals",
      "write a progress checkpoint",
      "call await_human or hand off to the coordinator; never call complete for package-patch",
    ],
    authentication: {
      agent: "Authorization: Bearer <one-time-issued-token>",
      management: "browser-only HttpOnly management session + origin-bound X-Wenmai-Browser-Binding + in-memory X-Wenmai-CSRF; first use, cleared browser site data, or explicit logout requires the startup one-time pairing code at fixed http://[::1]:3000, then an IndexedDB non-extractable ECDSA P-256 trusted-device key may auto-resume; D1 stores public key and digests only; logout revokes the device",
      separation: "Agent Bearer credentials never substitute for a management session, and browser management credentials are never exposed to stdio Agents",
      browserReadBoundary: "browser management reads use the management session; project_* views are deliberately Bearer-only and require package.read, so browser credentials never flow into MCP",
    },
    collaborationShare: {
      schemaVersion: "wenmai.share-grant/1",
      modes: ["viewer", "editor"],
      views: ["health (minimal identity for viewer)", "articles", "article"],
      objectBoundary: "exactly one existing article; wildcard and future-article access are forbidden",
      articleRevisionPolicy: "authoritative-current: a unique active D1 Package primary Branch head wins and invalid Package identity fails closed; otherwise use the operative corpus representative source",
      lifetime: "default 7 days; maximum 30 days",
      editorBoundary: "exactly one valid non-terminal task whose permission ceiling, current context and active deterministic task-owned Agent Branch are revalidated on every request; no main, merge, release or publish authority",
      secretDelivery: "connection card never contains the Bearer secret; deliver the one-time Key separately",
      networkBoundary: "a connection card never implies that the Tailscale gateway has been enabled or verified",
    },
    projectReadContract: {
      scope: "package.read",
      authentication: "Agent Bearer only; management Cookie, browser binding and CSRF are not accepted as substitutes",
      objectBoundary: "Package SQL is constrained by the authenticated client's articleIds before rows are returned",
      branchQualified: ["project_package", "project_diagnostics", "project_slices"],
      branchDiscovery: "project_branches lists attached branches for one authorized Package",
    },
    projectGroupReadContract: {
      scope: "package.read",
      authentication: "Agent Bearer only; management Cookie, browser binding and CSRF are not accepted as substitutes",
      objectBoundary: "A restricted token receives a non-empty ProjectGroup only when every member articleId is in its articleIds; star-scoped tokens may read empty groups; partial topology, title, edge and hash disclosure is forbidden",
      listProjection: { boundedSummary: true, fields: ["group", "memberCount", "edgeCount", "storedTopologySha256", "detailRequiredForTopology"], excludes: ["members", "edges", "topology", "integrityStatus"] },
      detailReadLimits: { members: PROJECT_GROUP_MEMBER_READ_LIMIT, edges: PROJECT_GROUP_EDGE_READ_LIMIT, exceeded: "PROJECT_GROUP_READ_LIMIT_EXCEEDED (409), no partial data" },
      readOnly: true,
      sideEffects: "ProjectGroup tables, events and receipts remain unchanged; authentication lastSeen telemetry may update",
      ownerWrites: "ProjectGroup mutations remain exclusively on the owner management API",
    },
    commandContract: { agentWritesRequire: ["commandId", "contextSha256", "active lease"], idempotency: "CommandReceipt + canonical request SHA-256" },
    agentBranchContract: {
      createTask: "writeScope=agent-branch creates and binds agent/<task-code>; baseBranchId is read-only input, never the write target",
      proposeRevision: ["expectedHeadRevisionId", "title", "bodyText", "summary?"],
      invariants: ["task-owned branch identity", "clean working copy", "working-copy base equals branch head", "CAS head advance", "immutable agent revision"],
    },
    packagePatchContract: {
      createTask: "writeScope=package-patch binds the task to one attached ArticleBranch and freezes that branch's Revision/lock/Composition/commit/module/diagnosis digests",
      proposePackagePatch: [
        "packageId", "branchId", "baseRevisionId", "expectedBranchLockVersion", "baseCompositionId",
        "expectedBaseCompositionSha256", "title", "operations", "evidence?", "diagnosticIssueIds?",
      ],
      compatibility: "expectedPackageLockVersion is accepted only for the current primary branch and never substitutes for branch-scoped freshness on non-primary branches",
      invariants: ["active lease", "exact target branch", "exact context SHA", "branch head and branch lock CAS", "frozen module and diagnosis digests", "candidate insert only", "no Composition/Revision/head advance"],
    },
    safety: {
      packagePatchCompleteAccepted: false,
      packagePatchCompletionAuthority: "coordinator_only",
      weakModelCompletionToolExposed: false,
      candidateHandoff: "progress checkpoint followed by await_human or coordinator handoff",
      completionErrorCode: "COORDINATOR_COMPLETION_REQUIRED",
      candidateOnly: true,
      editorialApproval: false,
      externalSubmission: false,
      completionClaim: false,
    },
    permissionCeiling: { allow: [...TASK_PERMISSION_ALLOWLIST], deny: [...FORBIDDEN_PERMISSIONS] },
    completionBoundary: "Package-patch Agent completion is rejected and reserved for the coordinator. Any separately authorized legacy Agent completion is only a technical candidate awaiting human acceptance; it never approves an article, release, rule adoption, merge, external submission, or completion claim.",
    migrationBoundary: "Drizzle 0007 creates the Agent control plane; 0008 creates ArticleProject Package; 0009 adds the compatibility bridge; 0010 makes Package state branch-scoped. Blocked, unbound, or missing 0010 branch state fails closed. Existing runtime-bootstrap D1 databases must be structurally baselined before migration history is advanced.",
    corpus: {
      schemaVersion: indexedCorpus.schemaVersion,
      algorithmVersion: indexedCorpus.algorithmVersion,
      generatedAt: indexedCorpus.generatedAt,
      sha256: await corpusSha256(),
    },
  };
}

export async function GET(request: Request) {
  const id = requestId();
  try {
    const url = new URL(request.url);
    const view = cleanText(url.searchParams.get("view"), 40) || "manifest";
    if (view === "manifest") return jsonSuccess(id, await manifestData());
    const db = database();
    if (view === "shared_source_manifest" || view === "shared_source") {
      const auth = await authorizeRead(db, request, "shared_source.read");
      if (!auth) throw new AgentApiError("SCOPE_DENIED", "共享来源 Agent 读取需要 Bearer token", 403);
      const sourceId = view === "shared_source" ? cleanText(url.searchParams.get("id"), 200) : undefined;
      if (view === "shared_source" && !sourceId) throw new AgentApiError("SHARED_SOURCE_NOT_FOUND", "共享来源不存在或不在 Agent 可读边界内", 404);
      if (view === "shared_source" && (url.searchParams.has("limit") || url.searchParams.has("cursor"))) throw new AgentApiError("INVALID_QUERY", "共享来源详情不接受分页参数", 400);
      const page = view === "shared_source_manifest" ? parseSharedSourcePage(url.searchParams.get("limit"), url.searchParams.get("cursor")) : undefined;
      return jsonSuccess(id, await sharedSourceAgentProjection(db, { ...auth, expiresAt: String(auth.row.expires_at), permissionSnapshotSha256: auth.permissionProfile?.snapshotSha256 ?? null }, sourceId, page));
    }
    // Unlike the broader Agent control plane, this source projection must not
    // bootstrap tables: an uninitialized review schema is an explicit 503.
    if (view === "review_context") {
      const auth = await authorizeRead(db, request, "context.read");
      return jsonSuccess(id, await handleReviewContextRead(db, auth, url));
    }
    await ensureAgentSchema();
    if (view === "permission_catalog") {
      if (request.headers.has("authorization")) throw new AgentApiError("AMBIGUOUS_AUTH_FORBIDDEN", "Bearer Agent 不得读取所有者权限目录", 403);
      await requireManagementSession(request, { scope: "token.issue" });
      const catalog = publicAgentPermissionCatalog();
      const known = await knownArticleIds(db);
      const includeArticles = url.searchParams.get("includeArticles") === "1";
      const articleObjects = includeArticles ? await Promise.all([...known].sort().map(async (articleId) => {
        let branchCount = 0; let packageCount = 0;
        try { branchCount = Number((await db.prepare("SELECT COUNT(*) AS count FROM article_branches WHERE article_id = ?").bind(articleId).first<D1Row>())?.count ?? 0); } catch { /* optional */ }
        try { packageCount = Number((await db.prepare("SELECT COUNT(*) AS count FROM article_project_packages WHERE article_id = ?").bind(articleId).first<D1Row>())?.count ?? 0); } catch { /* optional */ }
        return { id: articleId, label: operativeArticles.find((article) => article.id === articleId)?.title, branchCount, packageCount };
      })) : undefined;
      return jsonSuccess(id, { catalog: { ...catalog, catalogSha256: await agentPermissionCatalogSha256(), articleObjectCount: known.size, ...(articleObjects ? { articleObjects } : {}) } });
    }
    if (view === "articles" || view === "article") {
      const auth = await authenticateClient(db, request, "article.read");
      requireScope(auth, "article.read");
      const collaborationMode = collaborationAccessModeForScopes(auth.scopes);
      if (!collaborationMode) throw new AgentApiError("SHARE_SCOPE_INVALID", "只有资源级共享通行证可以读取共享文章接口", 403);
      const allowedArticleId = auth.articleIds[0];
      const article = await sharedArticleProjection(db, allowedArticleId);
      const summary = {
        id: article.id,
        title: article.title,
        summary: article.summary,
        tags: article.tags,
        updatedAt: article.updatedAt,
        revisionId: article.revisionId,
        bodySha256: article.bodySha256,
        source: article.source,
        accessMode: collaborationMode,
        readOnly: true,
      };
      if (view === "articles") return jsonSuccess(id, { articles: [summary], scopeFiltered: true });
      const requestedArticleId = requiredText(url.searchParams.get("id") ?? url.searchParams.get("articleId"), "articleId", 160);
      if (requestedArticleId !== allowedArticleId) throw new AgentApiError("SHARED_ARTICLE_NOT_FOUND", "共享文章不存在或不在当前通行证边界内", 404);
      return jsonSuccess(id, { article: { ...summary, bodyText: article.bodyText }, scopeFiltered: true });
    }
    if (["project_manifest", "project_packages", "project_branches", "project_package", "project_diagnostics", "project_slices"].includes(view)) {
      const auth = await authenticateClient(db, request, "package.read", "management.read");
      requireScope(auth, "package.read");
      return jsonSuccess(id, await handleProjectRead(db, auth, view, url));
    }
    if (["project_group_manifest", "project_groups", "project_group"].includes(view)) {
      const auth = await authenticateClient(db, request, "package.read", "management.read");
      requireScope(auth, "package.read");
      return jsonSuccess(id, await handleProjectGroupRead(db, auth, view, url));
    }
    if (view === "health") {
      const auth = await authorizeRead(db, request);
      const serverTime = isoNow();
      if (auth && !auth.scopes.includes("task.read")) {
        const collaborationMode = collaborationAccessModeForScopes(auth.scopes);
        if (!collaborationMode) requireScope(auth, "task.read");
        return jsonSuccess(id, {
          service: "wenmai-agent-control", apiVersion: API_VERSION, storage: "d1-local", status: "ready",
          clients: [parseClient(auth.row)],
          minimal: true,
          collaborationAccessMode: collaborationMode,
          serverTime,
        });
      }
      const boundary = taskBoundary(auth, "task");
      const [activeClients, totalClients, tasks, active, pendingApprovals, clientRows] = await db.batch([
        auth
          ? db.prepare("SELECT COUNT(*) AS count FROM agent_clients WHERE id = ? AND status = 'active' AND expires_at > ?").bind(auth.id, serverTime)
          : db.prepare("SELECT COUNT(*) AS count FROM agent_clients WHERE status = 'active' AND expires_at > ?").bind(serverTime),
        auth
          ? db.prepare("SELECT COUNT(*) AS count FROM agent_clients WHERE id = ?").bind(auth.id)
          : db.prepare("SELECT COUNT(*) AS count FROM agent_clients"),
        db.prepare(`SELECT COUNT(*) AS count FROM agent_tasks task WHERE ${boundary.sql}`).bind(...boundary.bindings),
        db.prepare(`SELECT COUNT(*) AS count FROM agent_tasks task WHERE ${boundary.sql}
          AND task.state IN ('claimed','running','awaiting_human','review')`).bind(...boundary.bindings),
        db.prepare(`SELECT COUNT(*) AS count FROM agent_approval_requests approval
          JOIN agent_tasks task ON task.id = approval.task_id WHERE approval.status = 'pending' AND ${boundary.sql}`)
          .bind(...boundary.bindings),
        auth
          ? db.prepare("SELECT * FROM agent_clients WHERE id = ? LIMIT 1").bind(auth.id)
          : db.prepare("SELECT * FROM agent_clients ORDER BY created_at DESC LIMIT 300"),
      ]);
      const listedClients = clientRows.results as D1Row[];
      const clientIds = listedClients.map((client) => String(client.id));
      const permissionProfiles = new Map<string, JsonObject>();
      if (clientIds.length) {
        const snapshots = await db.prepare(`SELECT * FROM agent_client_permission_snapshots WHERE client_id IN (${clientIds.map(() => "?").join(",")})`)
          .bind(...clientIds).all<D1Row>();
        for (const snapshot of snapshots.results) {
          const profile = parsePermissionProfile(snapshot);
          if (profile) permissionProfiles.set(String(snapshot.client_id), profile);
        }
      }
      return jsonSuccess(id, {
        service: "wenmai-agent-control", apiVersion: API_VERSION, storage: "d1-local", status: "ready",
        clients: listedClients.map((client) => parseClient(client, permissionProfiles.get(String(client.id)) ?? null)),
        counts: {
          activeClients: Number((activeClients.results[0] as D1Row | undefined)?.count ?? 0),
          totalClients: Number((totalClients.results[0] as D1Row | undefined)?.count ?? 0),
          tasks: Number((tasks.results[0] as D1Row | undefined)?.count ?? 0),
          activeTasks: Number((active.results[0] as D1Row | undefined)?.count ?? 0),
          pendingApprovals: Number((pendingApprovals.results[0] as D1Row | undefined)?.count ?? 0),
        },
        serverTime,
      });
    }
    const requiredScope = view === "knowledge" ? "knowledge.read" : view === "graph" ? "graph.read" : "task.read";
    const auth = await authorizeRead(db, request, requiredScope);
    if (view === "tasks") {
      const boundary = taskBoundary(auth);
      const rows = await db.prepare(`SELECT * FROM agent_tasks WHERE ${boundary.sql} ORDER BY updated_at DESC LIMIT 300`)
        .bind(...boundary.bindings).all<D1Row>();
      const eventRows = await db.prepare("SELECT * FROM agent_progress_events ORDER BY cursor DESC LIMIT 1000").all<D1Row>();
      const latestByTask = new Map<string, ReturnType<typeof parseEvent>>();
      for (const row of eventRows.results) if (!latestByTask.has(String(row.task_id))) latestByTask.set(String(row.task_id), parseEvent(row));
      const tasks = rows.results.map((row) => ({ ...parseTask(row), latestEvent: latestByTask.get(String(row.id)) ?? null }));
      return jsonSuccess(id, { tasks });
    }
    if (view === "task") {
      const taskId = requiredText(url.searchParams.get("id") ?? url.searchParams.get("taskId"), "taskId", 120);
      const task = await taskRow(db, taskId);
      if (auth) clientCanAccess(auth, taskId, String(task.article_id));
      const [contexts, attempts, events, artifacts, approvals, proposals] = await db.batch([
        db.prepare("SELECT * FROM agent_context_snapshots WHERE task_id = ? ORDER BY created_at DESC LIMIT 20").bind(taskId),
        db.prepare("SELECT * FROM agent_task_attempts WHERE task_id = ? ORDER BY attempt DESC LIMIT 50").bind(taskId),
        db.prepare("SELECT * FROM agent_progress_events WHERE task_id = ? ORDER BY cursor DESC LIMIT 300").bind(taskId),
        db.prepare("SELECT * FROM agent_task_artifacts WHERE task_id = ? ORDER BY created_at DESC LIMIT 200").bind(taskId),
        db.prepare("SELECT * FROM agent_approval_requests WHERE task_id = ? ORDER BY created_at DESC LIMIT 100").bind(taskId),
        db.prepare("SELECT * FROM graph_proposals WHERE task_id = ? ORDER BY created_at DESC LIMIT 200").bind(taskId),
      ]);
      const packagePatches = await tableExists(db, "package_patch_proposals")
        ? await db.prepare("SELECT * FROM package_patch_proposals WHERE task_id = ? ORDER BY created_at DESC, id DESC LIMIT 200").bind(taskId).all<D1Row>()
        : { results: [] as D1Row[] };
      return jsonSuccess(id, {
        task: parseTask(task),
        contextSnapshots: (contexts.results as D1Row[]).map((row) => ({
          ...parseContext(row),
          bundle: undefined,
          ...safePackageContextProjection(row),
        })),
        attempts: (attempts.results as D1Row[]).map(parseAttempt),
        events: (events.results as D1Row[]).map(parseEvent).reverse(),
        artifacts: (artifacts.results as D1Row[]).map(parseArtifact),
        approvalRequests: (approvals.results as D1Row[]).map(parseApproval),
        graphProposals: (proposals.results as D1Row[]).map(parseGraphProposal),
        packagePatchProposals: packagePatches.results.map(parsePackagePatchProposal),
      });
    }
    if (view === "context") {
      const taskId = requiredText(url.searchParams.get("taskId"), "taskId", 120);
      const task = await taskRow(db, taskId);
      if (auth) { requireScope(auth, "context.read"); clientCanAccess(auth, taskId, String(task.article_id)); }
      const contextId = cleanText(url.searchParams.get("contextId"), 120) || String(task.current_context_snapshot_id ?? "");
      if (!contextId) throw new AgentApiError("CONTEXT_NOT_FOUND", "任务尚未建立上下文快照", 404);
      const context = await db.prepare("SELECT * FROM agent_context_snapshots WHERE id = ? AND task_id = ? LIMIT 1")
        .bind(contextId, taskId).first<D1Row>();
      if (!context) throw new AgentApiError("CONTEXT_NOT_FOUND", "上下文快照不存在或不属于这项任务", 404);
      return jsonSuccess(id, { contextSnapshot: parseContext(context) });
    }
    if (view === "events") {
      const taskId = requiredText(url.searchParams.get("taskId"), "taskId", 120);
      const task = await taskRow(db, taskId);
      if (auth) clientCanAccess(auth, taskId, String(task.article_id));
      const after = Math.max(0, Number(url.searchParams.get("after") ?? 0) || 0);
      const limit = Math.max(1, Math.min(300, Number(url.searchParams.get("limit") ?? 120) || 120));
      const rows = await db.prepare("SELECT * FROM agent_progress_events WHERE task_id = ? AND cursor > ? ORDER BY cursor LIMIT ?")
        .bind(taskId, after, limit).all<D1Row>();
      const events = rows.results.map(parseEvent);
      return jsonSuccess(id, { events, nextCursor: events.at(-1)?.cursor ?? after, hasMore: events.length === limit });
    }
    if (view === "knowledge") {
      const query = requiredText(url.searchParams.get("q"), "q", 160).toLocaleLowerCase("zh-CN");
      const limit = Math.max(1, Math.min(30, Number(url.searchParams.get("limit") ?? 20) || 20));
      const articles = operativeArticles
        .filter((article) => !auth || auth.articleIds.includes("*") || auth.articleIds.includes(article.id))
        .map((article) => {
          const haystack = [article.title, article.summary, ...article.tags, ...article.entities].join(" ").toLocaleLowerCase("zh-CN");
          const score = (article.title.toLocaleLowerCase("zh-CN").includes(query) ? 5 : 0)
            + article.tags.filter((tag) => tag.toLocaleLowerCase("zh-CN").includes(query)).length * 2
            + (haystack.includes(query) ? 1 : 0);
          return { article, score };
        })
        .filter((item) => item.score > 0)
        .sort((left, right) => right.score - left.score)
        .slice(0, limit)
        .map(({ article, score }) => ({
          type: "article", id: article.id, title: article.title, summary: article.summary.slice(0, 600),
          tags: article.tags.slice(0, 12), entities: article.entities.slice(0, 12), updatedAt: article.updatedAt,
          identityStatus: article.identityStatus, representativeVersionId: article.representativeVersionId, score,
        }));
      const topics = indexedCorpus.topics
        .filter((topic) => topic.label.toLocaleLowerCase("zh-CN").includes(query))
        .map((topic) => ({
          ...topic,
          articleIds: filterOperativeArticleIds(topic.articleIds, operativeArticleIds, auth?.articleIds),
        }))
        .filter((topic) => topic.articleIds.length > 0)
        .slice(0, Math.min(10, limit))
        .map((topic) => ({ type: "topic", ...topic }));
      return jsonSuccess(id, {
        query, results: [...articles, ...topics].slice(0, limit),
        corpus: { schemaVersion: indexedCorpus.schemaVersion, algorithmVersion: indexedCorpus.algorithmVersion, generatedAt: indexedCorpus.generatedAt },
        bodyTextIncluded: false,
      });
    }
    if (view === "graph") {
      const seeds = [...new Set((url.searchParams.get("seed") ?? "").split(",").map((item) => item.trim()).filter(Boolean))].slice(0, 20);
      if (!seeds.length) throw new AgentApiError("MISSING_FIELD", "graph 查询至少需要一个 seed");
      if (auth) {
        const articleNodeIds = operativeArticleIds;
        for (const seed of seeds.filter((seed) => articleNodeIds.has(seed))) {
          if (!auth.articleIds.includes("*") && !auth.articleIds.includes(seed)) throw new AgentApiError("OBJECT_SCOPE_DENIED", "图谱 seed 超出 token 文章边界", 403);
        }
      }
      const requestedDepth = Number(url.searchParams.get("depth") ?? 1);
      const depth = Number.isFinite(requestedDepth) ? Math.max(0, Math.min(2, Math.trunc(requestedDepth))) : 1;
      const limit = Math.max(1, Math.min(100, Number(url.searchParams.get("limit") ?? 60) || 60));
      let graph = boundedSubgraph(seeds, depth, limit);
      if (auth && !auth.articleIds.includes("*")) {
        const allowedArticleNodes = new Set(graph.nodes
          .filter((node) => node.type === "article" && auth.articleIds.includes(node.id))
          .map((node) => node.id));
        if (!allowedArticleNodes.size) throw new AgentApiError("OBJECT_SCOPE_DENIED", "图谱结果不包含 token 边界内文章", 403);
        const unauthorizedArticleNodes = new Set(graph.nodes
          .filter((node) => node.type === "article" && !allowedArticleNodes.has(node.id))
          .map((node) => node.id));
        const safeEdges = graph.edges.filter((edge) => !unauthorizedArticleNodes.has(edge.source) && !unauthorizedArticleNodes.has(edge.target));
        const reachable = new Set(allowedArticleNodes);
        let changed = true;
        while (changed) {
          changed = false;
          for (const edge of safeEdges) {
            if (reachable.has(edge.source) && !reachable.has(edge.target)) { reachable.add(edge.target); changed = true; }
            if (reachable.has(edge.target) && !reachable.has(edge.source)) { reachable.add(edge.source); changed = true; }
          }
        }
        const nodes = graph.nodes.filter((node) => reachable.has(node.id));
        const nodeIds = new Set(nodes.map((node) => node.id));
        const edges = safeEdges.filter((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target));
        graph = { nodes, edges, truncated: graph.truncated || nodes.length < graph.nodes.length || edges.length < graph.edges.length };
      }
      const articleIds = graph.nodes.filter((node) => node.type === "article").map((node) => node.id);
      const overlays = articleIds.length
        ? await db.prepare(`SELECT * FROM graph_proposals WHERE article_id IN (${articleIds.map(() => "?").join(",")})
            AND status IN ('candidate','confirmed') ORDER BY created_at DESC LIMIT 100`).bind(...articleIds).all<D1Row>()
        : { results: [] as D1Row[] };
      return jsonSuccess(id, {
        ...graph, proposals: (overlays.results as D1Row[]).map(parseGraphProposal), depth, limit,
        corpus: { schemaVersion: indexedCorpus.schemaVersion, algorithmVersion: indexedCorpus.algorithmVersion, generatedAt: indexedCorpus.generatedAt },
        bodyTextIncluded: false,
      });
    }
    throw new AgentApiError("UNKNOWN_VIEW", `未知 Agent GET view：${view}`, 404);
  } catch (error) {
    return jsonError(id, error);
  }
}

function eventFromTask(
  db: D1Database,
  input: Parameters<typeof eventStatement>[1],
  where: string,
  bindings: Array<string | number | null>,
) {
  const allowedWhere = new Set([
    "id = ? AND state = ? AND lock_version = ?",
    "id = ? AND active_attempt_id = ? AND state = ?",
    "id = ? AND current_context_snapshot_id = ? AND lock_version = ?",
    "id = ? AND active_attempt_id IS NULL AND state = ? AND lock_version = ?",
  ]);
  if (!allowedWhere.has(where)) throw new AgentApiError("INTERNAL_POLICY_ERROR", "内部 Agent 事件条件不受允许", 500);
  return db.prepare(`INSERT INTO agent_progress_events
    (id, task_id, attempt_id, event_type, phase, progress_percent, current_action, next_action, blocker,
     message, evidence_json, payload_json, actor_kind, actor_id, command_id, input_sha256, created_at)
    SELECT ?, id, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? FROM agent_tasks WHERE ${where} LIMIT 1`)
    .bind(
      `agent-event-${crypto.randomUUID()}`, input.attemptId ?? null, input.eventType, input.phase ?? "",
      input.progressPercent ?? null, input.currentAction ?? "", input.nextAction ?? "", input.blocker ?? "",
      input.message ?? "", canonicalJson(input.evidence ?? []), canonicalJson(input.payload ?? {}), input.actorKind,
      input.actorId, input.commandId ?? null, input.inputSha256, input.createdAt, ...bindings,
    );
}

function guardedContextInsert(
  db: D1Database,
  context: Awaited<ReturnType<typeof buildContextSnapshot>>,
  expectedLockVersion: number,
) {
  const prefix = `INSERT INTO agent_context_snapshots
    (id, task_id, article_id, branch_id, revision_id, body_sha256, corpus_schema_version, corpus_algorithm_version,
     corpus_generated_at, corpus_sha256, graph_sha256, rules_sha256, package_id, composition_id, composition_sha256,
      package_document_sha256, package_lock_version, branch_head_revision_id, branch_state_lock_version, module_graph_sha256,
     diagnosis_summary_sha256, bundle_json, context_sha256, created_at)`;
  const values = [
      context.id, context.taskId, context.articleId, context.branchId, context.revisionId, context.bodySha256,
      context.corpusSchemaVersion, context.corpusAlgorithmVersion, context.corpusGeneratedAt, context.corpusSha256,
      context.graphSha256, context.rulesSha256, context.packageId, context.compositionId, context.compositionSha256,
      context.packageDocumentSha256, context.packageLockVersion, context.branchHeadRevisionId, context.branchStateLockVersion,
      context.moduleGraphSha256, context.diagnosisSummarySha256, canonicalJson(context.bundle), context.contextSha256,
      context.createdAt,
  ];
  const packageGuard = context.packageId ? `AND EXISTS (
      SELECT 1 FROM article_project_packages package
      JOIN package_branch_migration_audits audit ON audit.package_id = package.id
        AND audit.state NOT IN ('blocked','legacy_unbound')
      JOIN package_branch_states state ON state.package_id = package.id AND state.branch_id = ?
      JOIN package_compositions composition ON composition.id = state.head_composition_id AND composition.package_id = state.package_id
      JOIN package_branch_working_copies package_copy
        ON package_copy.package_id = state.package_id AND package_copy.branch_id = state.branch_id
      JOIN article_branches branch ON branch.id = state.branch_id AND branch.article_id = package.article_id
      JOIN article_revisions head ON head.id = state.head_revision_id AND head.branch_id = state.branch_id
        AND head.article_id = package.article_id
      JOIN branch_working_copies branch_copy ON branch_copy.branch_id = state.branch_id AND branch_copy.article_id = package.article_id
      JOIN package_composition_materializations bridge
        ON bridge.package_id = state.package_id AND bridge.branch_id = state.branch_id
        AND bridge.composition_id = state.head_composition_id
        AND bridge.composition_sha256 = state.head_composition_sha256
        AND bridge.article_revision_id = state.head_revision_id AND bridge.article_body_sha256 = head.body_sha256
      JOIN package_branch_composition_commits commit_ref
        ON commit_ref.package_id = state.package_id AND commit_ref.branch_id = state.branch_id
        AND commit_ref.composition_id = state.head_composition_id
        AND commit_ref.composition_sha256 = state.head_composition_sha256
        AND commit_ref.article_revision_id = state.head_revision_id
      WHERE package.id = ? AND package.status = 'active' AND package.branch_model_version = 2
        AND state.lock_version = ? AND state.head_composition_id = ? AND state.head_composition_sha256 = ?
        AND state.head_revision_id = ? AND state.status = 'active' AND composition.document_sha256 = ?
        AND package_copy.base_composition_id = state.head_composition_id
        AND package_copy.base_revision_id = state.head_revision_id
        AND package_copy.document_sha256 = composition.document_sha256 AND package_copy.dirty = 0
        AND branch.head_revision_id = state.head_revision_id AND branch.status = 'active'
        AND branch_copy.base_revision_id = state.head_revision_id
        AND branch_copy.body_sha256 = head.body_sha256 AND branch_copy.dirty = 0
    )` : "";
  const packageBindings = context.packageId ? [
    context.branchId, context.packageId, context.branchStateLockVersion,
    context.compositionId, context.compositionSha256, context.branchHeadRevisionId, context.packageDocumentSha256,
  ] : [];
  return db.prepare(`${prefix}
    SELECT ${values.map(() => "?").join(",")} FROM agent_tasks
    WHERE id = ? AND lock_version = ? AND active_attempt_id IS NULL ${packageGuard} LIMIT 1`)
    .bind(...values, context.taskId, expectedLockVersion, ...packageBindings);
}

function requireLockVersion(value: unknown) {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 1) throw new AgentApiError("INVALID_LOCK_VERSION", "expectedLockVersion 必须是正整数");
  return result;
}

type AgentClientIssuer = {
  objectBoundary?: Record<string, unknown>;
  authBasis?: string;
  sourceExpiresAt?: string;
  absoluteExpiresAt?: string;
  sourceClientId?: string | null;
};

function issuerSourceClientId(issuer?: AgentClientIssuer) {
  if (typeof issuer?.sourceClientId === "string" && issuer.sourceClientId) return issuer.sourceClientId;
  return typeof issuer?.objectBoundary?.sourceClientId === "string" && issuer.objectBoundary.sourceClientId
    ? issuer.objectBoundary.sourceClientId
    : null;
}

function issuerExpiryTime(issuer?: AgentClientIssuer) {
  // Owner/trusted browser sessions authorize issuance but do not become the
  // new Key's authority ancestor. Only root-derived issuance is capped by the
  // recorded parent Key expiry.
  if (!issuerSourceClientId(issuer)) return Number.POSITIVE_INFINITY;
  const value = issuer?.sourceExpiresAt || issuer?.absoluteExpiresAt;
  if (!value) throw new AgentApiError("ISSUER_EXPIRY_INVALID", "派生签发缺少父 Key 到期时间", 403);
  const expiry = Date.parse(value);
  if (!Number.isFinite(expiry)) throw new AgentApiError("ISSUER_EXPIRY_INVALID", "签发者到期时间无效", 403);
  return expiry;
}

function insertAgentClientStatement(db: D1Database, input: {
  id: string; label: string; clientKind: string; role: string; tokenSha256: string;
  scopesJson: string; articleIdsJson: string; taskIdsJson: string; credentialPurpose: string;
  sourceClientId: string | null; expiresAt: string; createdAt: string;
}) {
  const bindings = [
    input.id, input.label, input.clientKind, input.role, input.tokenSha256, input.scopesJson,
    input.articleIdsJson, input.taskIdsJson, input.credentialPurpose, input.sourceClientId,
    input.expiresAt, input.createdAt,
  ];
  if (!input.sourceClientId) {
    return db.prepare(`INSERT INTO agent_clients
      (id,label,client_kind,role,token_sha256,scopes_json,article_ids_json,task_ids_json,credential_purpose,issued_by_source_client_id,status,expires_at,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,'active',?,?)`).bind(...bindings);
  }
  return db.prepare(`INSERT INTO agent_clients
    (id,label,client_kind,role,token_sha256,scopes_json,article_ids_json,task_ids_json,credential_purpose,issued_by_source_client_id,status,expires_at,created_at)
    SELECT ?,?,?,?,?,?,?,?,?,?,'active',?,? FROM agent_clients parent
    WHERE parent.id = ? AND parent.status = 'active' AND parent.expires_at >= ?
      AND parent.credential_purpose IN ('site_full_control','management_session_exchange') LIMIT 1`)
    .bind(...bindings, input.sourceClientId, input.expiresAt);
}

async function issueClient(db: D1Database, payload: JsonObject, issuer?: AgentClientIssuer): Promise<MutationResult> {
  const label = requiredText(payload.label, "client label", 120);
  const clientKind = cleanText(payload.clientKind, 20) || "custom";
  if (!["codex", "mcp", "custom"].includes(clientKind)) throw new AgentApiError("INVALID_CLIENT_KIND", "clientKind 只能是 codex、mcp 或 custom");
  const requestedRole = cleanText(payload.role, 40);
  if (payload.scopes === undefined) throw new AgentApiError("SCOPE_SET_REQUIRED", "签发 Agent Key 必须显式选择 scope", 400);
  if (Array.isArray(payload.scopes)) {
    const cleanedRequestedScopes = payload.scopes.map((scope) => cleanText(scope, 240)).filter(Boolean);
    if (new Set(cleanedRequestedScopes).size !== cleanedRequestedScopes.length) throw new AgentApiError("DUPLICATE_SCOPE", "scopes 不允许重复", 400);
  }
  const requestedScopes = stringArray(payload.scopes, "scopes", 30);
  if (new Set(requestedScopes).size !== requestedScopes.length) throw new AgentApiError("DUPLICATE_SCOPE", "scopes 不允许重复", 400);
  const catalogScopes = new Set(AGENT_PERMISSION_CATALOG.map((entry) => entry.scope));
  const requestsPrivilegedScope = requestedScopes.some((scope) => catalogScopes.has(scope) && !ORDINARY_CLIENT_SCOPES.has(scope));
  if (!requestedRole || requestedRole === "agent") {
    if (requestsPrivilegedScope) throw new AgentApiError("PRIVILEGED_ROLE_REQUIRED", "特权 scope 必须显式指定 administrator 或 super_admin role", 400);
    return issueOrdinaryClient(db, { label, clientKind, requestedScopes, payload, issuer });
  }
  if (!isAgentPrivilegeRole(requestedRole)) throw new AgentApiError("INVALID_CLIENT_ROLE", "role 只能为 agent、administrator 或 super_admin", 400);
  const presetId = cleanText(payload.permissionPresetId, 80);
  if (!presetId) throw new AgentApiError("PERMISSION_PRESET_REQUIRED", "v3 签发必须指定 permissionPresetId", 400);
  const currentCatalogSha256 = await agentPermissionCatalogSha256();
  if (cleanText(payload.catalogVersion, 80) !== AGENT_PERMISSION_CATALOG_VERSION || cleanText(payload.catalogSha256, 80) !== currentCatalogSha256) {
    throw new AgentApiError("PERMISSION_CATALOG_STALE", "权限目录已变化，请刷新后重试", 409, { catalogVersion: AGENT_PERMISSION_CATALOG_VERSION, catalogSha256: currentCatalogSha256 });
  }
  const rejectedScopes = requestedScopes.filter((scope) => {
    const entry = AGENT_PERMISSION_CATALOG.find((candidate) => candidate.scope === scope);
    return !entry || !entry.delegable || !entry.newIssuance || !entry.allowedRoles.includes(requestedRole);
  });
  if (rejectedScopes.length) throw new AgentApiError("INVALID_SCOPE", "请求包含 Agent 控制面不允许签发的 scope", 400, { rejectedScopes });
  const scopeCombination = validatePermissionScopeCombination(requestedScopes);
  if (!scopeCombination.valid) {
    throw new AgentApiError(
      "PERMISSION_SCOPE_COMBINATION_CONFLICT",
      scopeCombination.message ?? "请求的权限 scope 组合互斥",
      400,
      { conflicts: scopeCombination.conflicts, message: scopeCombination.message },
    );
  }
  const scopes = [...requestedScopes].sort();
  if (!scopes.length) throw new AgentApiError("EMPTY_SCOPE", "Agent client 至少需要一项安全 scope");
  if (!Array.isArray(payload.confirmedActionIds)) throw new AgentApiError("CONFIRMED_ACTIONS_REQUIRED", "v3 签发必须提交 confirmedActionIds", 400);
  const rawConfirmedActionIds = payload.confirmedActionIds.map((item) => cleanText(item, 240));
  if (rawConfirmedActionIds.some((item) => !item) || new Set(rawConfirmedActionIds).size !== rawConfirmedActionIds.length) throw new AgentApiError("CONFIRMED_ACTIONS_INVALID", "confirmedActionIds 必须是排序去重的非空字符串数组", 400);
  const confirmedActionIds = [...rawConfirmedActionIds].sort();
  if (rawConfirmedActionIds.some((item, index) => item !== confirmedActionIds[index])) throw new AgentApiError("CONFIRMED_ACTIONS_INVALID", "confirmedActionIds 必须按字典序排序", 400);
  const actionIds = actionIdsForPermissionScopes(scopes);
  if (confirmedActionIds.length !== actionIds.length || confirmedActionIds.some((actionId, index) => actionId !== actionIds[index])) throw new AgentApiError("CONFIRMED_ACTIONS_MISMATCH", "确认动作与当前 scope 推导动作不完全一致", 409, { actionIds });
  const rawArticleIds = payload.articleIds === undefined ? [] : (Array.isArray(payload.articleIds) ? payload.articleIds.map(String) : []);
  const articleScope = payload.articleScope && typeof payload.articleScope === "object" && !Array.isArray(payload.articleScope) ? payload.articleScope as JsonObject : null;
  const articleMode = cleanText(articleScope?.mode, 40);
  const nestedArticleIds = articleScope?.articleIds === undefined ? null : (Array.isArray(articleScope.articleIds) ? articleScope.articleIds.map(String) : []);
  if (nestedArticleIds && canonicalJson(nestedArticleIds) !== canonicalJson(rawArticleIds)) {
    throw new AgentApiError("OBJECT_BOUNDARY_MISMATCH", "articleScope.articleIds 必须与顶层 articleIds 完全一致", 400);
  }
  const suppliedArticleIds = nestedArticleIds ?? rawArticleIds;
  const articleIds = suppliedArticleIds.map((id) => id.trim()).sort();
  const taskIds = payload.taskIds === undefined ? [] : stringArray(payload.taskIds, "taskIds", 200);
  if (articleMode === "all_articles") {
    if (articleIds.length !== 1 || articleIds[0] !== "*") throw new AgentApiError("OBJECT_BOUNDARY_REQUIRED", "all_articles 必须使用 articleIds=['*']", 400);
  } else if (articleMode === "selected_articles") {
    if (!articleIds.length || articleIds.length > 200 || articleIds.includes("*") || new Set(articleIds).size !== articleIds.length || suppliedArticleIds.some((id, index) => id !== articleIds[index])) throw new AgentApiError("OBJECT_BOUNDARY_REQUIRED", "selected_articles 必须绑定 1..200 个排序去重后的具体 articleId", 400);
  } else {
    throw new AgentApiError("OBJECT_BOUNDARY_REQUIRED", "v3 必须指定 articleScope.mode", 400);
  }
  if (taskIds.length) throw new AgentApiError("TASK_BOUNDARY_FORBIDDEN", "v3 taskIds 必须为空", 400);
  const known = await knownArticleIds(db); const unknownArticleIds = articleMode === "selected_articles" ? articleIds.filter((id) => !known.has(id)) : [];
  if (unknownArticleIds.length) throw new AgentApiError("ARTICLE_NOT_FOUND", "articleIds 包含服务端不可识别文章", 400, { unknownArticleIds });
  const presetScopes = presetId === "custom" ? null : expandPermissionPreset(presetId);
  if (presetId !== "custom" && !presetScopes) throw new AgentApiError("PERMISSION_PRESET_INVALID", "未知权限预设", 400);
  if (presetScopes && (presetScopes.length !== scopes.length || presetScopes.some((scope) => !scopes.includes(scope)))) throw new AgentApiError("PERMISSION_PRESET_MISMATCH", "预设与 scopes 必须精确一致", 400);
  const derivedRole = derivePrivilegeRoleForScopes(scopes);
  if (derivedRole !== requestedRole) throw new AgentApiError("PRIVILEGED_ROLE_MISMATCH", "role 必须由 scopes 服务端推导", 400);
  const issuanceNow = Date.now();
  const requestedExpiry = cleanText(payload.expiresAt, 80);
  const defaultLifetimeDays = requestedRole === "super_admin" ? 7 : 30;
  const issuerExpiry = issuerExpiryTime(issuer);
  if (issuerExpiry <= issuanceNow) throw new AgentApiError("ISSUER_EXPIRED", "签发者已经到期，不能继续派生 Key", 403);
  const defaultExpiryTime = Math.min(issuanceNow + defaultLifetimeDays * 24 * 60 * 60 * 1000, issuerExpiry);
  const expiryCandidate = requestedExpiry || new Date(defaultExpiryTime).toISOString();
  const expiryTime = Date.parse(expiryCandidate);
  if (!Number.isFinite(expiryTime) || expiryTime <= issuanceNow || expiryTime > issuanceNow + 366 * 24 * 60 * 60 * 1000) {
    throw new AgentApiError("INVALID_EXPIRY", "expiresAt 必须在当前时间之后且不超过 366 天");
  }
  if (expiryTime > issuanceNow + defaultLifetimeDays * 24 * 60 * 60 * 1000) throw new AgentApiError("INVALID_EXPIRY", "v3 有效期超过角色上限", 400);
  if (expiryTime > issuerExpiry) throw new AgentApiError("DERIVED_KEY_EXPIRY_EXCEEDS_ISSUER", "派生 Key 不得晚于根 Key 到期", 400);
  const role = derivedRole;
  const isSiteFullControl = scopes.length === 1 && scopes[0] === "site.full_control";
  if (isSiteFullControl) {
    if (!issuer?.authBasis || !["owner_pairing", "trusted_device", "site_full_control_key"].includes(issuer.authBasis)) {
      throw new AgentApiError("SITE_FULL_CONTROL_MANAGEMENT_SESSION_REQUIRED", "v5 Agent 站内全权 Key 只能由有效的所有者、可信设备或根 Key 会话签发", 403);
    }
    if (presetId !== "site_full_control" || role !== "super_admin" || articleMode !== "all_articles" || articleIds.length !== 1 || articleIds[0] !== "*" || taskIds.length) {
      throw new AgentApiError("SITE_FULL_CONTROL_CONTRACT_INVALID", "完整站内管理 Key 必须使用独占预设、super_admin、all_articles、articleIds=['*'] 且 taskIds=[]", 400);
    }
  }
  const expiresAt = new Date(expiryTime).toISOString();
  const id = `agent-client-${crypto.randomUUID()}`;
  const token = `wenmai_agent_${crypto.randomUUID().replaceAll("-", "")}_${crypto.randomUUID().replaceAll("-", "")}`;
  const createdAt = isoNow();
  const sourceClientId = issuerSourceClientId(issuer);
  const credentialPurpose = isSiteFullControl ? "site_full_control" : "agent_api";
  const managementProjection = isSiteFullControl ? canonicalSiteFullControlManagementProjection() : null;
  const managementProjectionSha256 = managementProjection ? await sha256Text(canonicalPermissionSnapshotJson(managementProjection)) : null;
  const snapshot = isSiteFullControl
    ? { schemaVersion: 5, catalogVersion: AGENT_PERMISSION_CATALOG_VERSION, catalogSha256: currentCatalogSha256, presetId, role, scopes, actionIds, credentialPurpose, directAgentApi: true, issuedBySourceClientId: sourceClientId, objectBoundary: { schemaVersion: "wenmai.agent-object-boundary/articles-v2", mode: articleMode, articleIds, includesFutureArticles: articleMode === "all_articles" }, taskIds, issuedAt: createdAt, expiresAt, ...managementProjection, managementProjectionSha256 }
    : { schemaVersion: 3, catalogVersion: AGENT_PERMISSION_CATALOG_VERSION, catalogSha256: currentCatalogSha256, presetId, role, scopes, actionIds, credentialPurpose, issuedBySourceClientId: sourceClientId, objectBoundary: { schemaVersion: "wenmai.agent-object-boundary/articles-v2", mode: articleMode, articleIds, includesFutureArticles: articleMode === "all_articles" }, taskIds, issuedAt: createdAt, expiresAt };
  const snapshotJson = canonicalPermissionSnapshotJson(snapshot);
  const snapshotSha256 = await sha256Text(snapshotJson);
  const insertResults = await db.batch([insertAgentClientStatement(db, {
    id, label, clientKind, role, tokenSha256: await sha256Text(token), scopesJson: canonicalJson(scopes),
    articleIdsJson: canonicalJson(articleIds), taskIdsJson: canonicalJson(taskIds), credentialPurpose,
    sourceClientId, expiresAt, createdAt,
  }),
    db.prepare(`INSERT INTO agent_client_permission_snapshots
      (client_id, schema_version, catalog_version, preset_id, role, scopes_json, action_ids_json, article_ids_json, task_ids_json, snapshot_json, snapshot_sha256, created_at)
      SELECT ?, 3, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE EXISTS (SELECT 1 FROM agent_clients WHERE id = ? AND status = 'active' AND expires_at = ?)`)
      .bind(id, AGENT_PERMISSION_CATALOG_VERSION, presetId, role, canonicalJson(scopes), canonicalJson(actionIds), canonicalJson(articleIds), canonicalJson(taskIds), snapshotJson, snapshotSha256, createdAt, id, expiresAt),
  ]);
  if (insertResults.some((result) => Number(result.meta.changes ?? 0) !== 1)) {
    throw new AgentApiError("ISSUER_CHANGED_DURING_ISSUANCE", "签发期间父 Key 已失效，未生成派生 Key", 409);
  }
  const row = await db.prepare("SELECT * FROM agent_clients WHERE id = ?").bind(id).first<D1Row>();
  return { status: 201, data: { client: row ? { ...parseClient(row), permissionProfile: { schemaVersion: isSiteFullControl ? 5 : 3, catalogVersion: AGENT_PERMISSION_CATALOG_VERSION, catalogSha256: currentCatalogSha256, presetId, actionIds, articleIds, snapshotSha256, ...(isSiteFullControl ? { directAgentApi: true } : {}), ...(managementProjection && managementProjectionSha256 ? { ...managementProjection, managementProjectionSha256 } : {}) } } : null, token, shownOnce: true } };
}

async function issueOrdinaryClient(db: D1Database, input: { label: string; clientKind: string; requestedScopes: string[]; payload: JsonObject; issuer?: AgentClientIssuer }): Promise<MutationResult> {
  const { label, clientKind, requestedScopes, payload, issuer } = input;
  const rejectedScopes = requestedScopes.filter((scope) => !SAFE_CLIENT_SCOPES.has(scope) || !ORDINARY_CLIENT_SCOPES.has(scope));
  if (rejectedScopes.length) throw new AgentApiError("INVALID_SCOPE", "请求包含普通 Agent 不允许签发的 scope", 400, { rejectedScopes });
  const scopes = [...requestedScopes].sort();
  if (!scopes.length) throw new AgentApiError("EMPTY_SCOPE", "Agent client 至少需要一项安全 scope");
  const collaborationMode = collaborationAccessModeForScopes(scopes);
  if (scopes.includes("article.read") && !collaborationMode) {
    throw new AgentApiError("SHARE_SCOPE_INVALID", "共享通行证必须精确使用 viewer 或 editor 权限档，不能混入其他 scope", 400);
  }
  const rawArticleIds = payload.articleIds === undefined ? [] : (Array.isArray(payload.articleIds) ? payload.articleIds.map(String) : []);
  const articleScope = payload.articleScope && typeof payload.articleScope === "object" && !Array.isArray(payload.articleScope) ? payload.articleScope as JsonObject : null;
  const articleMode = cleanText(articleScope?.mode, 40);
  const nestedArticleIds = articleScope?.articleIds === undefined ? null : (Array.isArray(articleScope.articleIds) ? articleScope.articleIds.map(String) : []);
  if (nestedArticleIds && canonicalJson(nestedArticleIds) !== canonicalJson(rawArticleIds)) throw new AgentApiError("OBJECT_BOUNDARY_MISMATCH", "articleScope.articleIds 必须与顶层 articleIds 完全一致", 400);
  const suppliedArticleIds = nestedArticleIds ?? rawArticleIds;
  const articleIds = suppliedArticleIds.map((id) => id.trim()).sort();
  const taskIds = payload.taskIds === undefined ? [] : stringArray(payload.taskIds, "taskIds", 200);
  if (scopes.includes(LOCAL_IMPORT_SCOPE)) {
    if (scopes.length !== 1) throw new AgentApiError("IMPORT_SCOPE_EXCLUSIVE_REQUIRED", "local import scope 必须独占", 400);
    if (articleIds.length !== 1 || articleIds[0] !== "*" || taskIds.length) throw new AgentApiError("IMPORT_BOUNDARY_REQUIRED", "local import 必须使用 articleIds=['*'] 且 taskIds 为空", 400);
  } else {
    if (articleMode === "all_articles") {
      if (suppliedArticleIds.length !== 1 || suppliedArticleIds[0] !== "*" || articleIds.length !== 1 || articleIds[0] !== "*") throw new AgentApiError("OBJECT_BOUNDARY_REQUIRED", "all_articles 必须使用 articleIds=['*']", 400);
    } else if (articleMode === "selected_articles") {
      if (!articleIds.length || articleIds.length > 200 || articleIds.includes("*") || new Set(articleIds).size !== articleIds.length || suppliedArticleIds.some((id, index) => id !== articleIds[index])) throw new AgentApiError("OBJECT_BOUNDARY_REQUIRED", "selected_articles 必须绑定 1..200 个排序去重后的具体 articleId", 400);
    } else {
      throw new AgentApiError("OBJECT_BOUNDARY_REQUIRED", "普通 Agent 必须指定 articleScope.mode", 400);
    }
  }
  const nowMs = Date.now(); const requestedExpiry = cleanText(payload.expiresAt, 80);
  const issuerExpiry = issuerExpiryTime(issuer);
  if (issuerExpiry <= nowMs) throw new AgentApiError("ISSUER_EXPIRED", "签发者已经到期，不能继续派生 Key", 403);
  const expiryTime = Date.parse(requestedExpiry || new Date(Math.min(nowMs + 30 * 24 * 60 * 60 * 1000, issuerExpiry)).toISOString());
  if (!Number.isFinite(expiryTime) || expiryTime <= nowMs || expiryTime > nowMs + 366 * 24 * 60 * 60 * 1000) throw new AgentApiError("INVALID_EXPIRY", "expiresAt 必须在当前时间之后且不超过 366 天");
  if (expiryTime > issuerExpiry) throw new AgentApiError("DERIVED_KEY_EXPIRY_EXCEEDS_ISSUER", "派生 Key 不得晚于根 Key 到期", 400);
  if (collaborationMode) {
    const shape = validateCollaborationGrantShape({ mode: collaborationMode, articleIds, taskIds, expiresAtMs: expiryTime, nowMs });
    if (!shape.valid) throw new AgentApiError(shape.code || "SHARE_GRANT_INVALID", shape.message || "共享通行证边界无效", 400);
    await sharedArticleProjection(db, articleIds[0]);
    if (collaborationMode === "editor") {
      await requireShareEditorTask(db, taskIds[0], articleIds[0], 400);
    }
  }
  const id = `agent-client-${crypto.randomUUID()}`; const token = `wenmai_agent_${crypto.randomUUID().replaceAll("-", "")}_${crypto.randomUUID().replaceAll("-", "")}`;
  const createdAt = isoNow(); const expiresAt = new Date(expiryTime).toISOString();
  const sourceClientId = issuerSourceClientId(issuer);
  const inserted = await insertAgentClientStatement(db, {
    id, label, clientKind, role: "agent", tokenSha256: await sha256Text(token), scopesJson: canonicalJson(scopes),
    articleIdsJson: canonicalJson(articleIds), taskIdsJson: canonicalJson(taskIds), credentialPurpose: "agent_api",
    sourceClientId, expiresAt, createdAt,
  }).run();
  if (Number(inserted.meta.changes ?? 0) !== 1) throw new AgentApiError("ISSUER_CHANGED_DURING_ISSUANCE", "签发期间父 Key 已失效，未生成派生 Key", 409);
  const row = await db.prepare("SELECT * FROM agent_clients WHERE id = ?").bind(id).first<D1Row>();
  return { status: 201, data: { client: row ? parseClient(row) : null, token, shownOnce: true } };
}

async function revokeClient(db: D1Database, payload: JsonObject, commandId: string, inputSha256: string, actorId: string): Promise<MutationResult> {
  const clientId = requiredText(payload.clientId, "clientId", 120);
  const note = requiredText(payload.note, "撤销说明", 1000);
  const now = isoNow();
  const target = await db.prepare("SELECT id, role, issued_by_source_client_id FROM agent_clients WHERE id = ? AND status = 'active' LIMIT 1").bind(clientId).first<D1Row>();
  if (!target) throw new AgentApiError("CLIENT_NOT_FOUND", "Agent client 不存在或已经撤销", 404);
  const lineageCte = `WITH RECURSIVE revoked_lineage(id) AS (
    SELECT id FROM agent_clients WHERE id = ?
    UNION
    SELECT child.id FROM agent_clients child
    JOIN revoked_lineage parent ON child.issued_by_source_client_id = parent.id
  )`;
  const lineageRows = await db.prepare(`${lineageCte}
    SELECT client.* FROM agent_clients client JOIN revoked_lineage lineage ON lineage.id = client.id ORDER BY client.created_at, client.id`)
    .bind(clientId).all<D1Row>();
  const revokedClientIds = lineageRows.results.map((row) => String(row.id));
  if (!revokedClientIds.includes(clientId)) throw new AgentApiError("CLIENT_NOT_FOUND", "Agent client 不存在或已经撤销", 404);
  const activeTasks = await db.prepare(`${lineageCte}
    SELECT task.* FROM agent_tasks task
    WHERE task.assigned_client_id IN (SELECT id FROM revoked_lineage) AND task.state IN ('claimed','running')`)
    .bind(clientId).all<D1Row>();
  const statements = [
    db.prepare(`${lineageCte}
      UPDATE agent_clients SET status = 'revoked', revoked_at = ?
      WHERE id IN (SELECT id FROM revoked_lineage) AND status = 'active'`).bind(clientId, now),
    db.prepare(`${lineageCte}
      UPDATE management_sessions SET status = 'revoked', revoked_at = ?, revoke_reason = 'source_key_lineage_revoked'
      WHERE auth_basis = 'site_full_control_key' AND source_client_id IN (SELECT id FROM revoked_lineage) AND status = 'active'`)
      .bind(clientId, now),
    db.prepare(`${lineageCte}
      UPDATE agent_task_leases SET revoked_at = ?
      WHERE client_id IN (SELECT id FROM revoked_lineage) AND revoked_at IS NULL`)
      .bind(clientId, now),
    db.prepare(`${lineageCte}
      UPDATE agent_task_attempts SET state = 'released', finished_at = ?, error_class = 'client_revoked', error_summary = ?
      WHERE client_id IN (SELECT id FROM revoked_lineage) AND state IN ('claimed','running')`)
      .bind(clientId, now, note),
    db.prepare(`${lineageCte}
      UPDATE agent_tasks SET state = 'queued', active_attempt_id = NULL, assigned_client_id = NULL,
        finished_at = NULL, lock_version = lock_version + 1, updated_at = ?
      WHERE assigned_client_id IN (SELECT id FROM revoked_lineage) AND state IN ('claimed','running')`)
      .bind(clientId, now),
    db.prepare(`INSERT INTO management_auth_events (id,event_type,principal_id,session_id,outcome,request_id,details_json,created_at)
      SELECT ?, 'agent_key.lifecycle.revoked', ?, ?, 'revoked', ?, ?, ?
      WHERE EXISTS (SELECT 1 FROM agent_clients WHERE id = ? AND status = 'revoked' AND revoked_at = ?)`)
      .bind(
        `management-auth-event-${crypto.randomUUID()}`,
        actorId,
        actorId.startsWith("management-session:") ? actorId.slice("management-session:".length) : null,
        commandId,
        canonicalJson({ targetClientId: clientId, targetRole: String(target.role ?? "agent"), issuedBySourceClientId: target.issued_by_source_client_id ? String(target.issued_by_source_client_id) : null, revokedClientIds, reason: note, commandId, inputSha256 }),
        now,
        clientId,
        now,
      ),
  ];
  activeTasks.results.forEach((task, index) => statements.push(eventFromTask(db, {
    taskId: String(task.id), attemptId: task.active_attempt_id ? String(task.active_attempt_id) : null,
    eventType: "client.revoked", message: note, payload: { clientId, revokedClientIds, taskReturnedToQueue: true }, actorKind: "user",
    actorId, commandId: index === 0 ? commandId : null, inputSha256, createdAt: now,
  }, "id = ? AND active_attempt_id IS NULL AND state = ? AND lock_version = ?",
  [String(task.id), "queued", Number(task.lock_version) + 1])));
  const results = await db.batch(statements);
  const newlyRevokedCount = Number(results[0].meta.changes ?? 0);
  if (newlyRevokedCount < 1) throw new AgentApiError("CLIENT_NOT_FOUND", "Agent client 不存在或已经撤销", 404);
  return { data: { clientId, status: "revoked", revokedClientIds, newlyRevokedCount, recoveredTaskIds: activeTasks.results.map((task) => String(task.id)) } };
}

async function createTask(
  db: D1Database,
  payload: JsonObject,
  commandId: string,
  inputSha256: string,
  actor: ControlPrincipal,
): Promise<MutationResult> {
  const articleId = requiredText(payload.articleId, "articleId", 120);
  if (actor.kind === "agent" && !actor.articleIds.includes("*") && !actor.articleIds.includes(articleId)) throw new AgentApiError("OBJECT_SCOPE_DENIED", "Agent Key 不包含此文章", 403);
  const article = operativeArticles.find((item) => item.id === articleId) ?? null;
  const id = `agent-task-${crypto.randomUUID()}`;
  const title = cleanText(payload.title, 240) || `Agent 任务 · ${article?.title ?? articleId}`;
  const objective = requiredText(payload.objective, "任务目标", 8000, true);
  const instructionsMd = cleanText(payload.instructionsMd, 20_000, true);
  const acceptance = payload.acceptance === undefined ? [] : (Array.isArray(payload.acceptance) ? payload.acceptance.slice(0, 60) : (() => { throw new AgentApiError("INVALID_ACCEPTANCE", "acceptance 必须是数组"); })());
  const rawContextSpec = payload.contextSpec === undefined ? {} : (isObject(payload.contextSpec) ? payload.contextSpec : (() => { throw new AgentApiError("INVALID_CONTEXT_SPEC", "contextSpec 必须是对象"); })());
  const permissionObject = isObject(payload.permissionCeiling) ? payload.permissionCeiling : {};
  const writeScope = cleanText(payload.writeScope, 40) || cleanText(permissionObject.writeScope, 40) || "artifact-only";
  const contextSpec: JsonObject = { ...rawContextSpec };
  const requestedTargetModuleKey = writeScope === "package-patch"
    ? requiredText(payload.targetModuleKey ?? rawContextSpec.targetModuleKey, "targetModuleKey", 120)
    : null;
  if (requestedTargetModuleKey) contextSpec.targetModuleKey = requestedTargetModuleKey;
  else delete contextSpec.targetModuleKey;
  const permissionCeiling = sanitizePermissionCeiling(payload.permissionCeiling, writeScope);
  const priority = cleanText(payload.priority, 8) || "P2";
  if (!PRIORITIES.has(priority)) throw new AgentApiError("INVALID_PRIORITY", "priority 只能是 P0、P1、P2 或 P3");
  const state = cleanText(payload.state, 20) || "queued";
  if (!["draft", "queued"].includes(state)) throw new AgentApiError("INVALID_INITIAL_STATE", "新任务只能建立为 draft 或 queued");
  const requestedTargetBranchId = cleanText(payload.targetBranchId, 120) || null;
  const requestedBaseBranchId = cleanText(payload.baseBranchId, 120) || requestedTargetBranchId;
  const packageSnapshot = writeScope === "package-patch"
    ? await loadFrozenPackageSnapshot(db, articleId, requestedTargetBranchId || requestedBaseBranchId, true)
    : undefined;
  if (packageSnapshot) {
    assertFrozenTargetModule(packageSnapshot, requestedTargetModuleKey);
    assertPackagePatchAgentGuidance(packageSnapshot.bundle.guidanceChecklist, "create_task", "current");
  }
  if (!article && !packageSnapshot) {
    throw new AgentApiError(
      "ARTICLE_NOT_FOUND",
      "未进入 corpus 的本地文章只能建立绑定现有 Package/ArticleBranch 的 package-patch 任务",
      404,
    );
  }
  const agentBranch = writeScope === "agent-branch"
    ? await prepareAgentBranch(db, id, articleId, requestedBaseBranchId)
    : null;
  const targetBranchId = packageSnapshot?.branchId ?? agentBranch?.id ?? requestedTargetBranchId;
  const projectId = cleanText(payload.projectId, 120) || null;
  const workItemId = cleanText(payload.workItemId, 120) || null;
  const createdAt = isoNow();
  const context = await buildContextSnapshot(db, {
    id, articleId, targetBranchId, title, objective, instructionsMd, acceptance, contextSpec, permissionCeiling,
    ...(agentBranch ? { sourceOverride: agentBranch.sourceOverride } : {}),
    ...(packageSnapshot !== undefined ? { packageSnapshot } : {}),
  });
  const statements = [];
  if (agentBranch?.rootRevision) {
    statements.push(db.prepare(`INSERT INTO article_revisions
      (id, article_id, branch_id, sequence, source_version_id, title, document_title, annotation,
       body_text, body_sha256, author_kind, created_at)
      VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, 'import', ?)`)
      .bind(agentBranch.rootRevision.id, articleId, agentBranch.id, agentBranch.rootRevision.sourceVersionId,
        agentBranch.rootRevision.title, agentBranch.sourceOverride.documentTitle, agentBranch.rootRevision.annotation,
        agentBranch.rootRevision.bodyText, agentBranch.rootRevision.bodySha256, createdAt));
  }
  if (agentBranch) {
    statements.push(
      db.prepare(`INSERT INTO article_branches
        (id, article_id, name, slug, color, status, head_revision_id, base_revision_id, base_source_version_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'purple', 'active', ?, ?, ?, ?, ?)`)
        .bind(agentBranch.id, articleId, agentBranch.name, agentBranch.slug, agentBranch.baseRevisionId,
          agentBranch.baseRevisionId, agentBranch.sourceVersionId, createdAt, createdAt),
      db.prepare(`INSERT INTO branch_working_copies
        (branch_id, article_id, base_revision_id, title, annotation, body_text, body_sha256, dirty, lock_version, updated_at)
        VALUES (?, ?, ?, ?, '', ?, ?, 0, 1, ?)`)
        .bind(agentBranch.id, articleId, agentBranch.baseRevisionId, agentBranch.sourceOverride.documentTitle,
          agentBranch.sourceOverride.bodyText, agentBranch.sourceOverride.bodySha256, createdAt),
      db.prepare(`INSERT INTO workspace_events
        (id, event_type, subject_type, subject_id, article_id, payload_json, input_sha256, created_at)
        VALUES (?, 'agent.branch_created', 'branch', ?, ?, ?, ?, ?)`)
        .bind(`event-${crypto.randomUUID()}`, agentBranch.id, articleId, canonicalJson({
          taskId: id, name: agentBranch.name, baseBranchId: agentBranch.baseBranchId,
          baseRevisionId: agentBranch.baseRevisionId, directMainWrite: false,
        }), inputSha256, createdAt),
    );
  }
  statements.push(
    db.prepare(`INSERT INTO agent_tasks
      (id, work_item_id, article_id, project_id, package_id, base_composition_id, base_composition_sha256,
       base_revision_id, base_branch_lock_version,
       target_branch_id, current_context_snapshot_id, title, objective,
       instructions_md, acceptance_json, context_spec_json, permission_ceiling_json, priority, state, lock_version,
       created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`)
      .bind(
        id, workItemId, articleId, projectId, context.packageId, context.compositionId, context.compositionSha256,
        context.branchHeadRevisionId, context.branchStateLockVersion,
        targetBranchId, context.id, title, objective, instructionsMd,
        canonicalJson(acceptance), canonicalJson(contextSpec), canonicalJson(permissionCeiling), priority, state,
        actor.kind === "agent" ? actor.actorId : "user", createdAt, createdAt,
      ),
    contextInsert(db, context),
    eventStatement(db, {
      taskId: id, eventType: "task.created", phase: "commission", progressPercent: 0,
      currentAction: state === "queued" ? "等待 Agent 领取" : "等待人工发布",
      nextAction: state === "queued" ? "Agent claim" : "切换为 queued", message: objective.slice(0, 1000),
      payload: {
        articleId, targetBranchId, writeScope, baseBranchId: agentBranch?.baseBranchId ?? null,
        packageId: context.packageId, baseCompositionId: context.compositionId,
        baseRevisionId: context.branchHeadRevisionId, baseBranchLockVersion: context.branchStateLockVersion,
        contextSnapshotId: context.id, contextSha256: context.contextSha256, permissionCeiling,
      },
      actorKind: actor.kind === "agent" ? "agent" : "user", actorId: actor.actorId,
      commandId, inputSha256, createdAt,
    }),
  );
  const results = await db.batch(statements);
  if (results.some((result) => Number(result.meta.changes ?? 0) !== 1)) {
    throw new AgentApiError("TASK_CREATE_INCOMPLETE", "任务、上下文与事件未形成完整事务", 503);
  }
  const row = await taskRow(db, id);
  const contextRow = await db.prepare("SELECT * FROM agent_context_snapshots WHERE id = ?").bind(context.id).first<D1Row>();
  return {
    status: 201,
    data: {
      task: parseTask(row), contextSnapshot: contextRow ? parseContext(contextRow) : null,
      agentBranch: agentBranch ? {
        id: agentBranch.id, articleId, name: agentBranch.name, slug: agentBranch.slug,
        headRevisionId: agentBranch.baseRevisionId, baseRevisionId: agentBranch.baseRevisionId,
        baseBranchId: agentBranch.baseBranchId, writeScope: "agent-branch",
      } : null,
      packageBinding: packageSnapshot ? {
        packageId: packageSnapshot.packageId, branchId: packageSnapshot.branchId,
        baseCompositionId: packageSnapshot.compositionId, baseCompositionSha256: packageSnapshot.compositionSha256,
        baseRevisionId: packageSnapshot.baseRevisionId, baseBranchLockVersion: packageSnapshot.baseBranchLockVersion,
        packageLockVersion: packageSnapshot.packageLockVersion,
        writeScope: "package-patch", candidateOnly: true,
      } : null,
    },
  };
}

async function updateTask(
  db: D1Database,
  payload: JsonObject,
  commandId: string,
  inputSha256: string,
  actor: ControlPrincipal,
): Promise<MutationResult> {
  const taskId = requiredText(payload.taskId, "taskId", 120);
  const expectedLockVersion = requireLockVersion(payload.expectedLockVersion);
  const row = await taskRow(db, taskId);
  if (Number(row.lock_version) !== expectedLockVersion || row.active_attempt_id) {
    throw new AgentApiError("TASK_STALE", "任务锁版本已变化或仍有活动 attempt", 409);
  }
  if (!["draft", "queued", "blocked", "failed"].includes(String(row.state))) {
    throw new AgentApiError("TASK_NOT_EDITABLE", "运行中、评审中或终态任务不能改写合同", 409);
  }
  const title = payload.title === undefined ? String(row.title) : requiredText(payload.title, "任务标题", 240);
  const objective = payload.objective === undefined ? String(row.objective) : requiredText(payload.objective, "任务目标", 8000, true);
  const instructionsMd = payload.instructionsMd === undefined ? String(row.instructions_md ?? "") : cleanText(payload.instructionsMd, 20_000, true);
  const acceptance = payload.acceptance === undefined ? parseJson<unknown[]>(row.acceptance_json, [])
    : Array.isArray(payload.acceptance) ? payload.acceptance.slice(0, 60) : (() => { throw new AgentApiError("INVALID_ACCEPTANCE", "acceptance 必须是数组"); })();
  const existingContextSpec = parseJson<JsonObject>(row.context_spec_json, {});
  const requestedContextSpec = payload.contextSpec === undefined ? existingContextSpec
    : isObject(payload.contextSpec) ? payload.contextSpec : (() => { throw new AgentApiError("INVALID_CONTEXT_SPEC", "contextSpec 必须是对象"); })();
  const contextSpec: JsonObject = { ...requestedContextSpec };
  const existingPermission = parseJson<JsonObject>(row.permission_ceiling_json, sanitizePermissionCeiling(undefined));
  const existingWriteScope = cleanText(existingPermission.writeScope, 40) || "artifact-only";
  if (existingWriteScope === "package-patch") {
    const existingTargetModuleKey = requiredText(existingContextSpec.targetModuleKey, "冻结 targetModuleKey", 120);
    const requestedTargetModuleKey = cleanText(payload.targetModuleKey ?? requestedContextSpec.targetModuleKey, 120);
    if (requestedTargetModuleKey && requestedTargetModuleKey !== existingTargetModuleKey) {
      throw new AgentApiError("PACKAGE_TARGET_MODULE_IMMUTABLE", "Package Patch 任务的 targetModuleKey 不能在原任务内改指向其他模块", 409, {
        expectedTargetModuleKey: existingTargetModuleKey,
        requestedTargetModuleKey,
      });
    }
    contextSpec.targetModuleKey = existingTargetModuleKey;
  } else {
    delete contextSpec.targetModuleKey;
  }
  const permissionCeiling = payload.permissionCeiling === undefined
    ? existingPermission
    : sanitizePermissionCeiling(payload.permissionCeiling, existingWriteScope);
  const priority = cleanText(payload.priority, 8) || String(row.priority);
  if (!PRIORITIES.has(priority)) throw new AgentApiError("INVALID_PRIORITY", "priority 非法");
  const targetState = cleanText(payload.state, 20) || String(row.state);
  if (!["draft", "queued", "blocked"].includes(targetState)) throw new AgentApiError("INVALID_TASK_TRANSITION", "人工编辑只能把非活动任务设为 draft、queued 或 blocked");
  const targetBranchId = payload.targetBranchId === undefined ? (row.target_branch_id ? String(row.target_branch_id) : null) : cleanText(payload.targetBranchId, 120) || null;
  const ownedBranchId = agentBranchIdentity(taskId).id;
  if (permissionCeiling.branchWrite === true && targetBranchId !== ownedBranchId) {
    throw new AgentApiError("AGENT_BRANCH_REQUIRED", "branch.agent_write 只能绑定 create_task 为该任务建立的 Agent 专属分支", 409);
  }
  if (existingPermission.branchWrite === true && targetBranchId !== String(row.target_branch_id)) {
    throw new AgentApiError("AGENT_BRANCH_IMMUTABLE", "Agent 专属分支与 task 的绑定不能被改指向其他分支", 409);
  }
  const packageSnapshot = existingWriteScope === "package-patch"
    ? await loadFrozenPackageSnapshot(db, String(row.article_id), targetBranchId, true)
    : undefined;
  if (packageSnapshot && targetBranchId !== packageSnapshot.branchId) {
    throw new AgentApiError("PACKAGE_BRANCH_IMMUTABLE", "Package Patch 任务只能继续绑定原目标 ArticleBranch", 409);
  }
  if (packageSnapshot) assertFrozenTargetModule(packageSnapshot, contextSpec.targetModuleKey);
  const context = await buildContextSnapshot(db, {
    id: taskId, articleId: String(row.article_id), targetBranchId, title, objective, instructionsMd, acceptance, contextSpec, permissionCeiling,
    ...(packageSnapshot !== undefined ? { packageSnapshot } : {}),
  });
  const now = isoNow();
  const nextLock = expectedLockVersion + 1;
  const results = await db.batch([
    guardedContextInsert(db, context, expectedLockVersion),
    db.prepare(`UPDATE agent_tasks SET title = ?, objective = ?, instructions_md = ?, acceptance_json = ?, context_spec_json = ?,
      permission_ceiling_json = ?, priority = ?, target_branch_id = ?, package_id = ?, base_composition_id = ?,
      base_composition_sha256 = ?, base_revision_id = ?, base_branch_lock_version = ?,
      state = ?, current_context_snapshot_id = ?,
      finished_at = NULL, cancelled_at = NULL, lock_version = lock_version + 1, updated_at = ?
      WHERE id = ? AND lock_version = ? AND active_attempt_id IS NULL AND state IN ('draft','queued','blocked','failed')`)
      .bind(title, objective, instructionsMd, canonicalJson(acceptance), canonicalJson(contextSpec), canonicalJson(permissionCeiling),
        priority, targetBranchId, context.packageId, context.compositionId, context.compositionSha256,
        context.branchHeadRevisionId, context.branchStateLockVersion,
        targetState, context.id, now, taskId, expectedLockVersion),
    eventFromTask(db, {
      taskId, eventType: "task.updated", phase: "commission", progressPercent: 0,
      currentAction: targetState === "queued" ? "等待 Agent 领取" : "等待人工处理", message: "任务合同和冻结上下文已更新",
      payload: {
        contextSnapshotId: context.id, contextSha256: context.contextSha256, previousLockVersion: expectedLockVersion,
        baseRevisionId: context.branchHeadRevisionId, baseBranchLockVersion: context.branchStateLockVersion,
      },
      actorKind: actor.kind === "agent" ? "agent" : "user", actorId: actor.actorId,
      commandId, inputSha256, createdAt: now,
    }, "id = ? AND current_context_snapshot_id = ? AND lock_version = ?", [taskId, context.id, nextLock]),
  ]);
  if (Number(results[0].meta.changes ?? 0) !== 1 || Number(results[1].meta.changes ?? 0) !== 1 || Number(results[2].meta.changes ?? 0) !== 1) {
    throw new AgentApiError("TASK_STALE", "任务在更新时发生并发变化", 409);
  }
  const updated = await taskRow(db, taskId);
  return { data: { task: parseTask(updated), contextSnapshot: { ...context } } };
}

async function cancelTask(
  db: D1Database,
  payload: JsonObject,
  commandId: string,
  inputSha256: string,
  actor: ControlPrincipal,
): Promise<MutationResult> {
  const taskId = requiredText(payload.taskId, "taskId", 120);
  const expectedLockVersion = requireLockVersion(payload.expectedLockVersion);
  const note = requiredText(payload.note, "取消说明", 2000);
  const row = await taskRow(db, taskId);
  if (["succeeded", "cancelled"].includes(String(row.state))) throw new AgentApiError("TASK_TERMINAL", "已成功或已取消任务不能再次取消", 409);
  const now = isoNow();
  const nextLock = expectedLockVersion + 1;
  const attemptId = row.active_attempt_id ? String(row.active_attempt_id) : null;
  const results = await db.batch([
    db.prepare(`UPDATE agent_tasks SET state = 'cancelled', cancelled_at = ?, finished_at = ?, active_attempt_id = NULL,
      assigned_client_id = NULL, lock_version = lock_version + 1, updated_at = ?
      WHERE id = ? AND lock_version = ? AND state NOT IN ('succeeded','cancelled')`)
      .bind(now, now, now, taskId, expectedLockVersion),
    db.prepare(`UPDATE agent_task_attempts SET state = 'cancelled', finished_at = ?
      WHERE task_id = ? AND state IN ('claimed','running','awaiting_human')
      AND EXISTS (SELECT 1 FROM agent_tasks WHERE id = ? AND state = 'cancelled' AND lock_version = ?)`)
      .bind(now, taskId, taskId, nextLock),
    db.prepare(`UPDATE agent_task_leases SET revoked_at = ? WHERE task_id = ? AND revoked_at IS NULL
      AND EXISTS (SELECT 1 FROM agent_tasks WHERE id = ? AND state = 'cancelled' AND lock_version = ?)`)
      .bind(now, taskId, taskId, nextLock),
    db.prepare(`UPDATE agent_approval_requests SET status = 'cancelled', decided_at = ?, decided_by = ?, decision_note = ?
      WHERE task_id = ? AND status = 'pending'
      AND EXISTS (SELECT 1 FROM agent_tasks WHERE id = ? AND state = 'cancelled' AND lock_version = ?)`)
      .bind(now, actor.actorId, note, taskId, taskId, nextLock),
    eventFromTask(db, {
      taskId, attemptId, eventType: "task.cancelled", phase: "cancelled", progressPercent: null,
      message: note, payload: { priorState: row.state }, actorKind: actor.kind === "agent" ? "agent" : "user",
      actorId: actor.actorId,
      commandId, inputSha256, createdAt: now,
    }, "id = ? AND state = ? AND lock_version = ?", [taskId, "cancelled", nextLock]),
  ]);
  if (Number(results[0].meta.changes ?? 0) !== 1 || Number(results[4].meta.changes ?? 0) !== 1) {
    throw new AgentApiError("TASK_STALE", "任务锁版本或状态已经变化", 409);
  }
  return { data: { task: parseTask(await taskRow(db, taskId)) } };
}

async function recoverExpiredLeaseForTask(db: D1Database, taskId: string) {
  const now = isoNow();
  const expired = await db.prepare(`SELECT lease.id AS lease_id, lease.attempt_id, task.lock_version
    FROM agent_task_leases lease
    JOIN agent_tasks task ON task.id = lease.task_id AND task.active_attempt_id = lease.attempt_id
    JOIN agent_task_attempts attempt ON attempt.id = lease.attempt_id
    WHERE lease.task_id = ? AND lease.revoked_at IS NULL AND lease.expires_at <= ?
      AND task.state IN ('claimed','running') AND attempt.state IN ('claimed','running') LIMIT 1`)
    .bind(taskId, now).first<D1Row>();
  if (!expired) return false;
  const leaseId = String(expired.lease_id);
  const attemptId = String(expired.attempt_id);
  const nextLock = Number(expired.lock_version) + 1;
  const systemInputSha = await sha256Text(canonicalJson({ action: "lease_expired", taskId, attemptId, leaseId, observedAt: now }));
  const results = await db.batch([
    db.prepare("UPDATE agent_task_leases SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL AND expires_at <= ?")
      .bind(now, leaseId, now),
    db.prepare(`UPDATE agent_task_attempts SET state = 'released', finished_at = ?, error_class = 'lease_expired',
      error_summary = 'Agent lease expired before heartbeat' WHERE id = ? AND state IN ('claimed','running')
      AND EXISTS (SELECT 1 FROM agent_task_leases WHERE id = ? AND revoked_at = ?)`)
      .bind(now, attemptId, leaseId, now),
    db.prepare(`UPDATE agent_tasks SET state = 'queued', active_attempt_id = NULL, assigned_client_id = NULL,
      lock_version = lock_version + 1, updated_at = ? WHERE id = ? AND active_attempt_id = ?
      AND state IN ('claimed','running') AND EXISTS (SELECT 1 FROM agent_task_leases WHERE id = ? AND revoked_at = ?)`)
      .bind(now, taskId, attemptId, leaseId, now),
    eventFromTask(db, {
      taskId, attemptId, eventType: "lease.expired", phase: "recovery", progressPercent: null,
      currentAction: "任务已经自动退回队列", nextAction: "等待新的 Agent claim",
      message: "租约超过心跳期限，控制面已撤销旧 attempt。", payload: { leaseId },
      actorKind: "system", actorId: "agent-control", inputSha256: systemInputSha, createdAt: now,
    }, "id = ? AND active_attempt_id IS NULL AND state = ? AND lock_version = ?", [taskId, "queued", nextLock]),
  ]);
  return Number(results[0].meta.changes ?? 0) === 1;
}

async function claimTask(
  db: D1Database,
  auth: ClientAuth,
  payload: JsonObject,
  commandId: string,
  inputSha256: string,
): Promise<MutationResult> {
  const taskId = requiredText(payload.taskId, "taskId", 120);
  await recoverExpiredLeaseForTask(db, taskId);
  const task = await authorizeTask(db, auth, taskId, "task.claim");
  if (task.state !== "queued" || task.active_attempt_id) {
    throw new AgentApiError("TASK_NOT_CLAIMABLE", "任务不在 queued 状态或已有活动 attempt", 409, { state: String(task.state) });
  }
  const permissionCeiling = parseJson<JsonObject>(task.permission_ceiling_json, {});
  if (permissionCeiling.writeScope === "package-patch" && !auth.scopes.includes("package.patch.propose")) {
    throw new AgentApiError("CLIENT_SCOPE_INSUFFICIENT_FOR_TASK", "当前 Agent Key 缺少该 Package Patch 任务所需的 package.patch.propose scope", 403, {
      taskId,
      requiredScope: "package.patch.propose",
      clientId: auth.id,
    });
  }
  const contextId = String(task.current_context_snapshot_id ?? "");
  const context = contextId
    ? await db.prepare("SELECT * FROM agent_context_snapshots WHERE id = ? AND task_id = ? LIMIT 1").bind(contextId, taskId).first<D1Row>()
    : null;
  if (!context) throw new AgentApiError("CONTEXT_NOT_FOUND", "任务没有可领取的冻结上下文", 409);
  let currentPackageSnapshot: FrozenPackageSnapshot | null | undefined;
  if (permissionCeiling.writeScope === "package-patch") {
    assertPackagePatchAgentGuidance(packageGuidanceFromContextRow(context), "claim", "frozen");
    currentPackageSnapshot = await loadFrozenPackageSnapshot(
      db,
      String(task.article_id),
      String(task.target_branch_id ?? ""),
      true,
    );
    assertPackagePatchAgentGuidance(currentPackageSnapshot?.bundle.guidanceChecklist, "claim", "current");
  }
  const packageSnapshot = await assertFrozenPackageContextCurrent(db, task, context, currentPackageSnapshot);
  const attemptCount = await db.prepare("SELECT COALESCE(MAX(attempt), 0) AS attempt FROM agent_task_attempts WHERE task_id = ?")
    .bind(taskId).first<D1Row>();
  const attemptNumber = Number(attemptCount?.attempt ?? 0) + 1;
  const attemptId = `agent-attempt-${crypto.randomUUID()}`;
  const leaseId = `agent-lease-${crypto.randomUUID()}`;
  const leaseToken = await deriveLeaseToken(auth.token, leaseId);
  const leaseTokenSha256 = await sha256Text(leaseToken);
  const now = isoNow();
  const expiresAt = leaseExpiry();
  const packageClaimGuard = packageSnapshot ? `AND EXISTS (
        SELECT 1 FROM article_project_packages package
        JOIN package_branch_migration_audits audit ON audit.package_id = package.id
          AND audit.state NOT IN ('blocked','legacy_unbound')
        JOIN package_branch_states state ON state.package_id = package.id AND state.branch_id = agent_tasks.target_branch_id
        JOIN package_compositions composition ON composition.id = state.head_composition_id AND composition.package_id = state.package_id
        JOIN package_branch_working_copies package_copy
          ON package_copy.package_id = state.package_id AND package_copy.branch_id = state.branch_id
        JOIN article_branches branch ON branch.id = state.branch_id AND branch.article_id = package.article_id
        JOIN article_revisions head ON head.id = state.head_revision_id AND head.branch_id = state.branch_id
          AND head.article_id = package.article_id
        JOIN branch_working_copies branch_copy ON branch_copy.branch_id = state.branch_id AND branch_copy.article_id = package.article_id
        JOIN package_composition_materializations bridge
          ON bridge.package_id = state.package_id AND bridge.branch_id = state.branch_id
          AND bridge.composition_id = state.head_composition_id
          AND bridge.composition_sha256 = state.head_composition_sha256
          AND bridge.article_revision_id = state.head_revision_id AND bridge.article_body_sha256 = head.body_sha256
        JOIN package_branch_composition_commits commit_ref
          ON commit_ref.package_id = state.package_id AND commit_ref.branch_id = state.branch_id
          AND commit_ref.composition_id = state.head_composition_id
          AND commit_ref.composition_sha256 = state.head_composition_sha256
          AND commit_ref.article_revision_id = state.head_revision_id
        WHERE package.id = agent_tasks.package_id AND package.status = 'active' AND package.branch_model_version = 2
          AND state.lock_version = ? AND state.head_composition_id = ? AND state.head_composition_sha256 = ?
          AND state.head_revision_id = ? AND state.status = 'active'
          AND composition.document_sha256 = ?
          AND agent_tasks.base_revision_id = state.head_revision_id
          AND agent_tasks.base_branch_lock_version = state.lock_version
          AND package_copy.base_composition_id = state.head_composition_id
          AND package_copy.base_revision_id = state.head_revision_id
          AND package_copy.document_sha256 = composition.document_sha256 AND package_copy.dirty = 0
          AND branch.head_revision_id = state.head_revision_id AND branch.status = 'active'
          AND branch_copy.base_revision_id = state.head_revision_id
          AND branch_copy.body_sha256 = head.body_sha256 AND branch_copy.dirty = 0
      )` : "";
  const packageClaimBindings = packageSnapshot ? [
    packageSnapshot.baseBranchLockVersion, packageSnapshot.compositionId, packageSnapshot.compositionSha256,
    packageSnapshot.baseRevisionId, packageSnapshot.documentSha256,
  ] : [];
  const results = await db.batch([
    db.prepare(`INSERT INTO agent_task_attempts
      (id, task_id, attempt, client_id, context_snapshot_id, state, last_heartbeat_at, started_at)
      SELECT ?, id, ?, ?, current_context_snapshot_id, 'claimed', ?, ? FROM agent_tasks
      WHERE id = ? AND state = 'queued' AND active_attempt_id IS NULL AND current_context_snapshot_id = ?
      ${packageClaimGuard} LIMIT 1`)
      .bind(attemptId, attemptNumber, auth.id, now, now, taskId, contextId, ...packageClaimBindings),
    db.prepare(`INSERT INTO agent_task_leases
      (id, task_id, attempt_id, client_id, lease_token_sha256, leased_at, expires_at, heartbeat_at, heartbeat_seq)
      SELECT ?, task_id, id, client_id, ?, ?, ?, ?, 0 FROM agent_task_attempts WHERE id = ? AND state = 'claimed' LIMIT 1`)
      .bind(leaseId, leaseTokenSha256, now, expiresAt, now, attemptId),
    db.prepare(`UPDATE agent_tasks SET state = 'claimed', active_attempt_id = ?, assigned_client_id = ?,
      lock_version = lock_version + 1, updated_at = ? WHERE id = ? AND state = 'queued' AND active_attempt_id IS NULL
      AND EXISTS (SELECT 1 FROM agent_task_attempts WHERE id = ? AND task_id = agent_tasks.id)`)
      .bind(attemptId, auth.id, now, taskId, attemptId),
    eventFromTask(db, {
      taskId, attemptId, eventType: "task.claimed", phase: "claim", progressPercent: 0,
      currentAction: "Agent 已领取任务", nextAction: "读取冻结上下文并发送 heartbeat",
      message: "任务已经通过竞争领取建立独立 attempt 与短租约。",
      payload: { leaseId, contextSnapshotId: contextId, contextSha256: String(context.context_sha256), attempt: attemptNumber },
      actorKind: "agent", actorId: auth.id, commandId, inputSha256, createdAt: now,
    }, "id = ? AND active_attempt_id = ? AND state = ?", [taskId, attemptId, "claimed"]),
  ]);
  if (results.some((result) => Number(result.meta.changes ?? 0) !== 1)) {
    throw new AgentApiError("CLAIM_CONFLICT", "任务已被其他 Agent 领取，或任务上下文在领取时发生变化", 409);
  }
  const [claimedTask, attempt] = await Promise.all([
    taskRow(db, taskId),
    db.prepare("SELECT * FROM agent_task_attempts WHERE id = ?").bind(attemptId).first<D1Row>(),
  ]);
  return {
    data: {
      task: parseTask(claimedTask),
      attempt: attempt ? parseAttempt(attempt) : null,
      lease: { id: leaseId, taskId, attemptId, expiresAt, heartbeatSeq: 0, leaseToken, shownOnce: true },
      context: {
        id: contextId, sha256: String(context.context_sha256), revisionId: String(context.revision_id),
        bodySha256: String(context.body_sha256), corpusSha256: String(context.corpus_sha256),
        branchId: context.branch_id ? String(context.branch_id) : null,
        packageId: context.package_id ? String(context.package_id) : null,
        compositionId: context.composition_id ? String(context.composition_id) : null,
        compositionSha256: context.composition_sha256 ? String(context.composition_sha256) : null,
        packageLockVersion: context.package_lock_version === null ? null : Number(context.package_lock_version),
        baseRevisionId: context.branch_head_revision_id ? String(context.branch_head_revision_id) : String(context.revision_id),
        baseBranchLockVersion: context.branch_state_lock_version === null ? null : Number(context.branch_state_lock_version),
        moduleGraphSha256: context.module_graph_sha256 ? String(context.module_graph_sha256) : null,
        diagnosisSummarySha256: context.diagnosis_summary_sha256 ? String(context.diagnosis_summary_sha256) : null,
      },
      contextUrl: `/api/agent/v1?view=context&taskId=${encodeURIComponent(taskId)}&contextId=${encodeURIComponent(contextId)}`,
    },
  };
}

async function heartbeatTask(
  db: D1Database,
  auth: ClientAuth,
  payload: JsonObject,
  commandId: string,
  inputSha256: string,
): Promise<MutationResult> {
  const guard = await leaseGuard(db, auth, payload);
  const heartbeatSeq = Number(payload.heartbeatSeq);
  if (!Number.isSafeInteger(heartbeatSeq) || heartbeatSeq < 1) {
    throw new AgentApiError("INVALID_HEARTBEAT_SEQ", "heartbeatSeq 必须是从 1 开始的整数");
  }
  const previousSeq = Number(guard.lease.heartbeat_seq);
  if (heartbeatSeq !== previousSeq + 1) {
    throw new AgentApiError("HEARTBEAT_OUT_OF_ORDER", "heartbeatSeq 必须严格递增且不能跳号", 409, { expected: previousSeq + 1 });
  }
  const now = isoNow();
  const expiresAt = leaseExpiry();
  const results = await db.batch([
    db.prepare(`UPDATE agent_task_leases SET heartbeat_seq = ?, heartbeat_at = ?, expires_at = ?
      WHERE id = ? AND task_id = ? AND attempt_id = ? AND client_id = ? AND lease_token_sha256 = ?
      AND heartbeat_seq = ? AND revoked_at IS NULL AND expires_at > ?`)
      .bind(heartbeatSeq, now, expiresAt, guard.leaseId, guard.taskId, guard.attemptId, auth.id,
        guard.leaseTokenSha256, previousSeq, now),
    db.prepare(`UPDATE agent_task_attempts SET state = 'running', last_heartbeat_at = ? WHERE id = ?
      AND state IN ('claimed','running') AND EXISTS (SELECT 1 FROM agent_task_leases
      WHERE id = ? AND heartbeat_seq = ? AND heartbeat_at = ? AND revoked_at IS NULL)`)
      .bind(now, guard.attemptId, guard.leaseId, heartbeatSeq, now),
    db.prepare(`UPDATE agent_tasks SET state = 'running', lock_version = lock_version + 1, updated_at = ?
      WHERE id = ? AND active_attempt_id = ? AND assigned_client_id = ? AND state IN ('claimed','running')
      AND EXISTS (SELECT 1 FROM agent_task_leases WHERE id = ? AND heartbeat_seq = ? AND heartbeat_at = ? AND revoked_at IS NULL)`)
      .bind(now, guard.taskId, guard.attemptId, auth.id, guard.leaseId, heartbeatSeq, now),
    eventFromTask(db, {
      taskId: guard.taskId, attemptId: guard.attemptId, eventType: "lease.heartbeat", phase: "execution",
      currentAction: "Agent 租约保持活动", nextAction: "继续任务并报告进度",
      payload: { leaseId: guard.leaseId, heartbeatSeq, expiresAt }, actorKind: "agent", actorId: auth.id,
      commandId, inputSha256, createdAt: now,
    }, "id = ? AND active_attempt_id = ? AND state = ?", [guard.taskId, guard.attemptId, "running"]),
  ]);
  if (results.some((result) => Number(result.meta.changes ?? 0) !== 1)) {
    throw new AgentApiError("HEARTBEAT_CONFLICT", "心跳序号、租约或任务状态已经变化", 409);
  }
  return {
    data: {
      task: parseTask(await taskRow(db, guard.taskId)),
      lease: { id: guard.leaseId, taskId: guard.taskId, attemptId: guard.attemptId, heartbeatSeq, expiresAt },
      serverTime: now,
    },
  };
}

async function progressTask(
  db: D1Database,
  auth: ClientAuth,
  payload: JsonObject,
  commandId: string,
  inputSha256: string,
): Promise<MutationResult> {
  const guard = await leaseGuard(db, auth, payload);
  const progressPercent = payload.progressPercent === undefined || payload.progressPercent === null
    ? null
    : Number(payload.progressPercent);
  if (progressPercent !== null && (!Number.isInteger(progressPercent) || progressPercent < 0 || progressPercent > 100)) {
    throw new AgentApiError("INVALID_PROGRESS", "progressPercent 必须是 0 到 100 的整数");
  }
  const phase = cleanText(payload.phase, 80);
  const currentAction = requiredText(payload.currentAction, "currentAction", 1000);
  const nextAction = cleanText(payload.nextAction, 1000);
  const blocker = cleanText(payload.blocker, 2000, true);
  const message = cleanText(payload.message, 4000, true);
  const evidence = payload.evidence === undefined ? [] : stringArray(payload.evidence, "evidence", 30);
  const eventPayload = payload.eventPayload === undefined
    ? {}
    : isObject(payload.eventPayload) ? payload.eventPayload : (() => { throw new AgentApiError("INVALID_EVENT_PAYLOAD", "eventPayload 必须是对象"); })();
  const now = isoNow();
  const results = await db.batch([
    db.prepare(`UPDATE agent_task_attempts SET state = 'running' WHERE id = ? AND state IN ('claimed','running')
      AND EXISTS (SELECT 1 FROM agent_task_leases WHERE id = ? AND lease_token_sha256 = ?
      AND revoked_at IS NULL AND expires_at > ?)`)
      .bind(guard.attemptId, guard.leaseId, guard.leaseTokenSha256, now),
    db.prepare(`UPDATE agent_tasks SET state = 'running', lock_version = lock_version + 1, updated_at = ?
      WHERE id = ? AND active_attempt_id = ? AND assigned_client_id = ? AND state IN ('claimed','running')
      AND EXISTS (SELECT 1 FROM agent_task_leases WHERE id = ? AND lease_token_sha256 = ?
      AND revoked_at IS NULL AND expires_at > ?)`)
      .bind(now, guard.taskId, guard.attemptId, auth.id, guard.leaseId, guard.leaseTokenSha256, now),
    eventFromTask(db, {
      taskId: guard.taskId, attemptId: guard.attemptId, eventType: blocker ? "progress.blocked" : "progress.reported",
      phase, progressPercent, currentAction, nextAction, blocker, message, evidence, payload: eventPayload,
      actorKind: "agent", actorId: auth.id, commandId, inputSha256, createdAt: now,
    }, "id = ? AND active_attempt_id = ? AND state = ?", [guard.taskId, guard.attemptId, "running"]),
  ]);
  if (results.some((result) => Number(result.meta.changes ?? 0) !== 1)) {
    throw new AgentApiError("PROGRESS_CONFLICT", "报告进度时租约已经失效或任务状态已经变化", 409);
  }
  const event = await db.prepare("SELECT * FROM agent_progress_events WHERE command_id = ? LIMIT 1").bind(commandId).first<D1Row>();
  return { data: { task: parseTask(await taskRow(db, guard.taskId)), event: event ? parseEvent(event) : null } };
}

function safeArtifactReference(value: string) {
  if (value.includes("..") || value.includes("\\") || /[\r\n\0]/.test(value)) return false;
  return value.startsWith("agent-inline:") || value.startsWith("artifact:") || value.startsWith(".runner/agent/");
}

async function addArtifact(
  db: D1Database,
  auth: ClientAuth,
  payload: JsonObject,
  commandId: string,
  inputSha256: string,
): Promise<MutationResult> {
  const guard = await leaseGuard(db, auth, payload);
  const kind = requiredText(payload.kind, "artifact kind", 80);
  const title = requiredText(payload.title, "artifact title", 240);
  const contentRef = requiredText(payload.contentRef, "contentRef", 500);
  if (!safeArtifactReference(contentRef)) {
    throw new AgentApiError("UNSAFE_ARTIFACT_REFERENCE", "contentRef 只允许 agent-inline:、artifact: 或 .runner/agent/ 安全引用");
  }
  const mediaType = cleanText(payload.mediaType, 120) || "application/octet-stream";
  const artifactPayload = payload.artifactPayload === undefined
    ? {}
    : isObject(payload.artifactPayload) ? payload.artifactPayload : (() => { throw new AgentApiError("INVALID_ARTIFACT_PAYLOAD", "artifactPayload 必须是对象"); })();
  const inlineContent = payload.inlineContent === undefined ? null : cleanText(payload.inlineContent, MAX_INLINE_ARTIFACT_BYTES, true);
  let sha256 = cleanText(payload.sha256, 64).toLowerCase();
  let sizeBytes = Number(payload.sizeBytes);
  if (contentRef.startsWith("agent-inline:")) {
    if (inlineContent === null) throw new AgentApiError("INLINE_CONTENT_REQUIRED", "agent-inline: 引用必须携带 inlineContent");
    const encodedSize = new TextEncoder().encode(inlineContent).byteLength;
    if (encodedSize > MAX_INLINE_ARTIFACT_BYTES) throw new AgentApiError("ARTIFACT_TOO_LARGE", "内联工件超过 220 KB", 413);
    const calculatedSha = await sha256Text(inlineContent);
    if (sha256 && sha256 !== calculatedSha) throw new AgentApiError("ARTIFACT_SHA_MISMATCH", "工件声明摘要与内联内容不一致", 409);
    if (Number.isFinite(sizeBytes) && sizeBytes !== encodedSize) throw new AgentApiError("ARTIFACT_SIZE_MISMATCH", "工件声明大小与内联内容不一致", 409);
    sha256 = calculatedSha;
    sizeBytes = encodedSize;
  }
  if (!SHA256_RE.test(sha256)) throw new AgentApiError("INVALID_ARTIFACT_SHA", "sha256 必须是 64 位小写十六进制摘要");
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0 || sizeBytes > 1_000_000_000) {
    throw new AgentApiError("INVALID_ARTIFACT_SIZE", "sizeBytes 必须是 0 到 1 GB 的整数");
  }
  const existing = await db.prepare(`SELECT * FROM agent_task_artifacts
    WHERE attempt_id = ? AND kind = ? AND sha256 = ? LIMIT 1`).bind(guard.attemptId, kind, sha256).first<D1Row>();
  if (existing) return { data: { artifact: parseArtifact(existing), duplicate: true } };
  const id = `agent-artifact-${crypto.randomUUID()}`;
  const now = isoNow();
  const storedPayload = inlineContent === null ? artifactPayload : { ...artifactPayload, inlineContent };
  const results = await db.batch([
    db.prepare(`UPDATE agent_task_attempts SET state = 'running' WHERE id = ? AND state IN ('claimed','running')
      AND EXISTS (SELECT 1 FROM agent_task_leases WHERE id = ? AND lease_token_sha256 = ?
      AND revoked_at IS NULL AND expires_at > ?)`)
      .bind(guard.attemptId, guard.leaseId, guard.leaseTokenSha256, now),
    db.prepare(`UPDATE agent_tasks SET state = 'running', lock_version = lock_version + 1, updated_at = ?
      WHERE id = ? AND active_attempt_id = ? AND assigned_client_id = ? AND state IN ('claimed','running')
      AND EXISTS (SELECT 1 FROM agent_task_leases WHERE id = ? AND lease_token_sha256 = ?
      AND revoked_at IS NULL AND expires_at > ?)`)
      .bind(now, guard.taskId, guard.attemptId, auth.id, guard.leaseId, guard.leaseTokenSha256, now),
    db.prepare(`INSERT INTO agent_task_artifacts
      (id, task_id, attempt_id, kind, title, content_ref, sha256, media_type, size_bytes, payload_json, context_sha256, created_at)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? FROM agent_task_leases
      WHERE id = ? AND task_id = ? AND attempt_id = ? AND client_id = ? AND lease_token_sha256 = ?
      AND revoked_at IS NULL AND expires_at > ? LIMIT 1`)
      .bind(id, guard.taskId, guard.attemptId, kind, title, contentRef, sha256, mediaType, sizeBytes,
        canonicalJson(storedPayload), guard.contextSha256, now, guard.leaseId, guard.taskId, guard.attemptId,
        auth.id, guard.leaseTokenSha256, now),
    eventFromTask(db, {
      taskId: guard.taskId, attemptId: guard.attemptId, eventType: "artifact.added", phase: "execution",
      currentAction: `已提交工件：${title}`, nextAction: "继续执行或提交完成候选",
      message: contentRef, payload: { artifactId: id, kind, sha256, mediaType, sizeBytes },
      actorKind: "agent", actorId: auth.id, commandId, inputSha256, createdAt: now,
    }, "id = ? AND active_attempt_id = ? AND state = ?", [guard.taskId, guard.attemptId, "running"]),
  ]);
  if (results.some((result) => Number(result.meta.changes ?? 0) !== 1)) {
    throw new AgentApiError("ARTIFACT_CONFLICT", "添加工件时租约失效、任务变化或同一工件已经存在", 409);
  }
  const row = await db.prepare("SELECT * FROM agent_task_artifacts WHERE id = ?").bind(id).first<D1Row>();
  return { status: 201, data: { artifact: row ? parseArtifact(row) : null, duplicate: false } };
}

async function pauseForHuman(
  db: D1Database,
  auth: ClientAuth,
  payload: JsonObject,
  commandId: string,
  inputSha256: string,
  request: { kind: string; title: string; question: string; options: string[]; targetState: "awaiting_human" | "review"; eventType: string; eventPayload?: JsonObject },
): Promise<MutationResult> {
  const guard = await leaseGuard(db, auth, payload);
  const pending = await db.prepare("SELECT id FROM agent_approval_requests WHERE task_id = ? AND status = 'pending' LIMIT 1")
    .bind(guard.taskId).first<D1Row>();
  if (pending) throw new AgentApiError("APPROVAL_ALREADY_PENDING", "任务已经有一个待处理的人类请求", 409, { approvalRequestId: String(pending.id) });
  const approvalId = `agent-approval-${crypto.randomUUID()}`;
  const now = isoNow();
  const results = await db.batch([
    db.prepare(`INSERT INTO agent_approval_requests
      (id, task_id, attempt_id, kind, title, question, options_json, status, requested_by_client_id, lock_version, created_at)
      SELECT ?, ?, ?, ?, ?, ?, ?, 'pending', ?, 1, ? FROM agent_task_leases
      WHERE id = ? AND task_id = ? AND attempt_id = ? AND client_id = ? AND lease_token_sha256 = ?
      AND revoked_at IS NULL AND expires_at > ? LIMIT 1`)
      .bind(approvalId, guard.taskId, guard.attemptId, request.kind, request.title, request.question,
        canonicalJson(request.options), auth.id, now, guard.leaseId, guard.taskId, guard.attemptId,
        auth.id, guard.leaseTokenSha256, now),
    db.prepare(`UPDATE agent_task_attempts SET state = 'awaiting_human', finished_at = NULL WHERE id = ?
      AND state IN ('claimed','running') AND EXISTS (SELECT 1 FROM agent_approval_requests WHERE id = ? AND status = 'pending')`)
      .bind(guard.attemptId, approvalId),
    db.prepare(`UPDATE agent_task_leases SET revoked_at = ? WHERE id = ? AND attempt_id = ? AND client_id = ?
      AND lease_token_sha256 = ? AND revoked_at IS NULL AND expires_at > ?
      AND EXISTS (SELECT 1 FROM agent_approval_requests WHERE id = ? AND status = 'pending')`)
      .bind(now, guard.leaseId, guard.attemptId, auth.id, guard.leaseTokenSha256, now, approvalId),
    db.prepare(`UPDATE agent_tasks SET state = ?, lock_version = lock_version + 1, updated_at = ?
      WHERE id = ? AND active_attempt_id = ? AND assigned_client_id = ? AND state IN ('claimed','running')
      AND EXISTS (SELECT 1 FROM agent_approval_requests WHERE id = ? AND status = 'pending')`)
      .bind(request.targetState, now, guard.taskId, guard.attemptId, auth.id, approvalId),
    eventFromTask(db, {
      taskId: guard.taskId, attemptId: guard.attemptId, eventType: request.eventType,
      phase: request.targetState === "review" ? "review" : "awaiting_human", progressPercent: null,
      currentAction: request.title, nextAction: "等待管理端人工决定", message: request.question,
      payload: { approvalRequestId: approvalId, kind: request.kind, ...(request.eventPayload ?? {}) },
      actorKind: "agent", actorId: auth.id, commandId, inputSha256, createdAt: now,
    }, "id = ? AND active_attempt_id = ? AND state = ?", [guard.taskId, guard.attemptId, request.targetState]),
  ]);
  if (results.some((result) => Number(result.meta.changes ?? 0) !== 1)) {
    throw new AgentApiError("AWAIT_HUMAN_CONFLICT", "建立人工请求时租约或任务状态已经变化", 409);
  }
  const [approval, task] = await Promise.all([
    db.prepare("SELECT * FROM agent_approval_requests WHERE id = ?").bind(approvalId).first<D1Row>(),
    taskRow(db, guard.taskId),
  ]);
  return { status: 201, data: { approvalRequest: approval ? parseApproval(approval) : null, task: parseTask(task), leaseRevoked: true } };
}

async function awaitHuman(
  db: D1Database,
  auth: ClientAuth,
  payload: JsonObject,
  commandId: string,
  inputSha256: string,
) {
  const kind = cleanText(payload.kind, 80) || "clarification";
  if (!["clarification", "scope_change", "risk_acceptance"].includes(kind)) {
    throw new AgentApiError("INVALID_APPROVAL_KIND", "Agent 只能请求 clarification、scope_change 或 risk_acceptance；不能伪造发布或编辑审批");
  }
  const title = requiredText(payload.title, "approval title", 240);
  const question = requiredText(payload.question, "approval question", 4000, true);
  const options = payload.options === undefined ? ["批准", "拒绝"] : stringArray(payload.options, "options", 8);
  if (options.length < 2) throw new AgentApiError("INVALID_APPROVAL_OPTIONS", "人工请求至少需要两个可选决定");
  return pauseForHuman(db, auth, payload, commandId, inputSha256, {
    kind, title, question, options, targetState: "awaiting_human", eventType: "approval.requested",
  });
}

async function completeTask(
  db: D1Database,
  auth: ClientAuth,
  payload: JsonObject,
  commandId: string,
  inputSha256: string,
) {
  const guard = await leaseGuard(db, auth, payload);
  const permissionCeiling = parseJson<JsonObject>(guard.task.permission_ceiling_json, {});
  const packagePatchTask = permissionCeiling.writeScope === "package-patch";
  if (packagePatchTask) {
    throw new AgentApiError(
      "COORDINATOR_COMPLETION_REQUIRED",
      "package-patch 候选只能写 progress checkpoint 后调用 await_human；Agent 不拥有 complete 权限",
      409,
      {
        completionAuthority: "coordinator_only",
        allowedActions: ["progress", "await_human"],
      },
    );
  }
  const summary = requiredText(payload.summary, "completion summary", 6000, true);
  const artifactIds = payload.artifactIds === undefined ? [] : stringArray(payload.artifactIds, "artifactIds", 100);
  const evidence = payload.evidence === undefined ? [] : stringArray(payload.evidence, "evidence", 50);
  if (artifactIds.length) {
    const placeholders = artifactIds.map(() => "?").join(",");
    const rows = await db.prepare(`SELECT id FROM agent_task_artifacts WHERE task_id = ? AND attempt_id = ? AND id IN (${placeholders})`)
      .bind(guard.taskId, guard.attemptId, ...artifactIds).all<D1Row>();
    if (rows.results.length !== artifactIds.length) throw new AgentApiError("ARTIFACT_SCOPE_MISMATCH", "completion artifactIds 包含不属于当前 attempt 的工件", 409);
  }
  return pauseForHuman(db, auth, payload, commandId, inputSha256, {
    kind: "task_completion", title: "验收 Agent 完成候选", question: summary,
    options: ["接受任务结果", "退回修改"], targetState: "review", eventType: "task.completion_submitted",
    eventPayload: {
      artifactIds, evidence, packagePatchIds: [],
      technicalCandidateOnly: true, editorialApproved: false, releaseApproved: false,
    },
  });
}

async function decideApproval(
  db: D1Database,
  payload: JsonObject,
  commandId: string,
  inputSha256: string,
  actor: ControlPrincipal,
): Promise<MutationResult> {
  const approvalId = requiredText(payload.approvalRequestId, "approvalRequestId", 120);
  const expectedLockVersion = requireLockVersion(payload.expectedLockVersion);
  const decision = requiredText(payload.decision, "decision", 20);
  if (!["approved", "rejected"].includes(decision)) throw new AgentApiError("INVALID_DECISION", "decision 只能是 approved 或 rejected");
  const note = cleanText(payload.note, 4000, true);
  if (decision === "rejected" && !note) throw new AgentApiError("DECISION_NOTE_REQUIRED", "拒绝人工请求时必须说明原因");
  const approval = await db.prepare("SELECT * FROM agent_approval_requests WHERE id = ? LIMIT 1").bind(approvalId).first<D1Row>();
  if (!approval) throw new AgentApiError("APPROVAL_NOT_FOUND", "人工请求不存在", 404);
  if (approval.status !== "pending" || Number(approval.lock_version) !== expectedLockVersion) {
    throw new AgentApiError("APPROVAL_STALE", "人工请求已经处理或锁版本已变化", 409);
  }
  const decisionAuthorityClientId = controlAuthorityClientId(actor);
  if (decisionAuthorityClientId && await sameAgentAuthorityLineage(db, String(approval.requested_by_client_id), decisionAuthorityClientId)) {
    throw new AgentApiError("SELF_APPROVAL_FORBIDDEN", "超级管理员不能决定由自身 Agent Key 发起的审批请求", 403);
  }
  const task = await taskRow(db, String(approval.task_id));
  const completion = approval.kind === "task_completion";
  const expectedTaskState = completion ? "review" : "awaiting_human";
  if (task.state !== expectedTaskState || task.active_attempt_id !== approval.attempt_id) {
    throw new AgentApiError("APPROVAL_TASK_STALE", "人工请求对应的任务或 attempt 已经变化", 409);
  }
  const targetState = completion && decision === "approved"
    ? "succeeded"
    : completion && decision === "rejected"
      ? "blocked"
      : decision === "approved" ? "queued" : "blocked";
  const attemptState = completion && decision === "approved"
    ? "succeeded"
    : completion && decision === "rejected"
      ? "failed"
      : decision === "approved" ? "released" : "failed";
  const now = isoNow();
  const taskLock = Number(task.lock_version);
  const nextApprovalLock = expectedLockVersion + 1;
  const nextTaskLock = taskLock + 1;
  const finishedAt = targetState === "succeeded" ? now : null;
  const results = await db.batch([
    db.prepare(`UPDATE agent_approval_requests SET status = ?, decision_note = ?, lock_version = lock_version + 1,
      decided_at = ?, decided_by = ? WHERE id = ? AND status = 'pending' AND lock_version = ?
      AND EXISTS (SELECT 1 FROM agent_tasks WHERE id = ? AND active_attempt_id = ? AND state = ? AND lock_version = ?)`)
      .bind(decision, note, now, actor.actorId, approvalId, expectedLockVersion,
        task.id, approval.attempt_id, expectedTaskState, taskLock),
    db.prepare(`UPDATE agent_tasks SET state = ?, active_attempt_id = NULL, assigned_client_id = NULL,
      finished_at = ?, lock_version = lock_version + 1, updated_at = ?
      WHERE id = ? AND active_attempt_id = ? AND state = ? AND lock_version = ?
      AND EXISTS (SELECT 1 FROM agent_approval_requests WHERE id = ? AND status = ? AND lock_version = ?)`)
      .bind(targetState, finishedAt, now, task.id, approval.attempt_id, expectedTaskState, taskLock,
        approvalId, decision, nextApprovalLock),
    db.prepare(`UPDATE agent_task_attempts SET state = ?, finished_at = ?, error_class = ?, error_summary = ?
      WHERE id = ? AND state = 'awaiting_human'
      AND EXISTS (SELECT 1 FROM agent_tasks WHERE id = ? AND state = ? AND active_attempt_id IS NULL AND lock_version = ?)`)
      .bind(attemptState, now, decision === "rejected" ? "human_rejected" : null,
        decision === "rejected" ? note : null, approval.attempt_id, task.id, targetState, nextTaskLock),
    eventFromTask(db, {
      taskId: String(task.id), attemptId: String(approval.attempt_id), eventType: "approval.decided",
      phase: targetState, progressPercent: targetState === "succeeded" ? 100 : null,
      currentAction: decision === "approved" ? "人工已接受" : "人工已退回",
      nextAction: targetState === "queued" ? "等待新的 Agent claim" : targetState === "blocked" ? "等待管理端调整" : "任务技术验收完成",
      message: note, payload: { approvalRequestId: approvalId, decision, taskCompletion: completion,
        editorialApproved: false, releaseApproved: false, publicAccessVerified: false, overallComplete: false },
      actorKind: actor.kind === "agent" ? "agent" : "user", actorId: actor.actorId,
      commandId, inputSha256, createdAt: now,
    }, "id = ? AND active_attempt_id IS NULL AND state = ? AND lock_version = ?", [task.id, targetState, nextTaskLock]),
  ]);
  if (results.some((result) => Number(result.meta.changes ?? 0) !== 1)) {
    throw new AgentApiError("APPROVAL_DECISION_CONFLICT", "决定写入时人工请求或任务发生并发变化", 409);
  }
  const [updatedApproval, updatedTask] = await Promise.all([
    db.prepare("SELECT * FROM agent_approval_requests WHERE id = ?").bind(approvalId).first<D1Row>(),
    taskRow(db, String(task.id)),
  ]);
  return {
    data: {
      approvalRequest: updatedApproval ? parseApproval(updatedApproval) : null,
      task: parseTask(updatedTask),
      boundary: {
        taskAccepted: targetState === "succeeded",
        editorialApproved: false,
        releaseApproved: false,
        mainMerged: false,
        publicAccessVerified: false,
        overallComplete: false,
      },
    },
  };
}

async function endAttempt(
  db: D1Database,
  auth: ClientAuth,
  payload: JsonObject,
  commandId: string,
  inputSha256: string,
  mode: "failed" | "released",
): Promise<MutationResult> {
  const guard = await leaseGuard(db, auth, payload);
  const now = isoNow();
  const targetTaskState = mode === "failed" ? "failed" : "queued";
  const errorClass = mode === "failed" ? requiredText(payload.errorClass, "errorClass", 120) : null;
  const message = mode === "failed"
    ? requiredText(payload.errorSummary, "errorSummary", 4000, true)
    : requiredText(payload.note, "release note", 2000, true);
  const results = await db.batch([
    db.prepare(`UPDATE agent_task_leases SET revoked_at = ? WHERE id = ? AND task_id = ? AND attempt_id = ?
      AND client_id = ? AND lease_token_sha256 = ? AND revoked_at IS NULL AND expires_at > ?`)
      .bind(now, guard.leaseId, guard.taskId, guard.attemptId, auth.id, guard.leaseTokenSha256, now),
    db.prepare(`UPDATE agent_task_attempts SET state = ?, finished_at = ?, error_class = ?, error_summary = ?
      WHERE id = ? AND state IN ('claimed','running')
      AND EXISTS (SELECT 1 FROM agent_task_leases WHERE id = ? AND revoked_at = ?)`)
      .bind(mode, now, errorClass, message, guard.attemptId, guard.leaseId, now),
    db.prepare(`UPDATE agent_tasks SET state = ?, active_attempt_id = NULL, assigned_client_id = NULL,
      finished_at = ?, lock_version = lock_version + 1, updated_at = ? WHERE id = ? AND active_attempt_id = ?
      AND state IN ('claimed','running') AND EXISTS (SELECT 1 FROM agent_task_attempts WHERE id = ? AND state = ?)`)
      .bind(targetTaskState, mode === "failed" ? now : null, now, guard.taskId, guard.attemptId, guard.attemptId, mode),
    eventFromTask(db, {
      taskId: guard.taskId, attemptId: guard.attemptId,
      eventType: mode === "failed" ? "task.failed" : "lease.released",
      phase: targetTaskState, progressPercent: null,
      currentAction: mode === "failed" ? "Agent 报告任务失败" : "Agent 主动释放任务租约",
      nextAction: mode === "failed" ? "等待管理端调整或重新排队" : "等待新的 Agent claim",
      message, payload: { errorClass, leaseId: guard.leaseId, publicationRelease: false },
      actorKind: "agent", actorId: auth.id, commandId, inputSha256, createdAt: now,
    }, "id = ? AND active_attempt_id IS NULL AND state = ? AND lock_version = ?",
    [guard.taskId, targetTaskState, Number(guard.task.lock_version) + 1]),
  ]);
  if (results.some((result) => Number(result.meta.changes ?? 0) !== 1)) {
    throw new AgentApiError("ATTEMPT_END_CONFLICT", "结束 attempt 时租约或任务状态已经变化", 409);
  }
  return {
    data: {
      task: parseTask(await taskRow(db, guard.taskId)), attemptId: guard.attemptId, leaseRevoked: true,
      boundary: { publicationReleased: false, editorialApproved: false, mainMerged: false },
    },
  };
}

async function proposeRevision(
  db: D1Database,
  auth: ClientAuth,
  payload: JsonObject,
  commandId: string,
  inputSha256: string,
): Promise<MutationResult> {
  const guard = await leaseGuard(db, auth, payload);
  const permission = parseJson<JsonObject>(guard.task.permission_ceiling_json, {});
  const allowed = Array.isArray(permission.allow) ? permission.allow.map(String) : [];
  if (permission.branchWrite !== true || !allowed.includes("branch.agent_write")) {
    throw new AgentApiError("TASK_PERMISSION_DENIED", "任务没有 Agent 专属分支写权限", 403);
  }
  const branchId = String(guard.task.target_branch_id ?? "");
  const identity = agentBranchIdentity(guard.taskId);
  if (!branchId || branchId !== identity.id) {
    throw new AgentApiError("AGENT_BRANCH_MISMATCH", "任务未绑定由控制面建立的 Agent 专属分支", 409);
  }
  if (await tableExists(db, "article_project_packages")) {
    const managed = await db.prepare(`SELECT id FROM article_project_packages
      WHERE primary_branch_id = ? AND status = 'active' LIMIT 1`).bind(branchId).first<D1Row>();
    if (managed) {
      throw new AgentApiError("PACKAGE_BRANCH_MANAGED", "该 ArticleBranch 已由 ArticleProject Package 双 CAS 管理；Agent 只能提交候选 Package Patch", 409, {
        packageId: managed.id,
      });
    }
  }
  const expectedHeadRevisionId = requiredText(payload.expectedHeadRevisionId, "expectedHeadRevisionId", 120);
  const documentTitle = requiredText(payload.title, "article title", 240);
  const bodyText = requiredText(payload.bodyText, "bodyText", 2_000_000, true);
  const summary = cleanText(payload.summary, 4000, true);
  const revisionTitle = cleanText(payload.revisionTitle, 160) || `Agent 提案 · ${String(guard.task.title).slice(0, 120)}`;
  const branch = await db.prepare(`SELECT branch.*, copy.base_revision_id AS copy_base_revision_id,
    copy.dirty AS copy_dirty, copy.lock_version AS copy_lock_version,
    head.document_title AS head_document_title, head.body_sha256 AS head_body_sha256
    FROM article_branches branch
    JOIN branch_working_copies copy ON copy.branch_id = branch.id AND copy.article_id = branch.article_id
    JOIN article_revisions head ON head.id = branch.head_revision_id
    WHERE branch.id = ? AND branch.article_id = ? AND branch.status = 'active' LIMIT 1`)
    .bind(branchId, String(guard.task.article_id)).first<D1Row>();
  if (!branch || branch.name !== identity.name || branch.slug !== identity.slug) {
    throw new AgentApiError("AGENT_BRANCH_MISMATCH", "分支名称、slug 或文章归属不符合 task 绑定", 409);
  }
  if (String(branch.head_revision_id) !== expectedHeadRevisionId
    || String(branch.copy_base_revision_id) !== expectedHeadRevisionId
    || Number(branch.copy_dirty) !== 0) {
    throw new AgentApiError("BRANCH_HEAD_STALE", "Agent 分支必须保持 clean 且 working-copy base 等于预期 head", 409, {
      expectedHeadRevisionId,
      actualHeadRevisionId: String(branch.head_revision_id),
      workingCopyBaseRevisionId: String(branch.copy_base_revision_id),
      workingCopyDirty: Boolean(branch.copy_dirty),
    });
  }
  const [bodySha256, titleSha256] = await Promise.all([sha256Text(bodyText), sha256Text(documentTitle)]);
  if (bodySha256 === String(branch.head_body_sha256) && documentTitle === String(branch.head_document_title)) {
    throw new AgentApiError("REVISION_NO_CHANGE", "新正文与当前 Agent 分支 head 完全相同", 409);
  }
  const revisionInputSha256 = await sha256Text(canonicalJson({
    taskId: guard.taskId, branchId, expectedHeadRevisionId, documentTitle, titleSha256, bodySha256, summary,
  }));
  const sequenceRow = await db.prepare("SELECT COALESCE(MAX(sequence), 0) AS maximum FROM article_revisions WHERE branch_id = ?")
    .bind(branchId).first<D1Row>();
  const sequence = Number(sequenceRow?.maximum ?? 0) + 1;
  const revisionId = `revision-${crypto.randomUUID()}`;
  const now = isoNow();
  const eventId = `agent-event-${crypto.randomUUID()}`;
  const workspaceEventId = `event-${crypto.randomUUID()}`;
  const nextCopyLock = Number(branch.copy_lock_version) + 1;
  const results = await db.batch([
    db.prepare(`UPDATE article_branches SET head_revision_id = ?, updated_at = ?
      WHERE id = ? AND article_id = ? AND name = ? AND slug = ? AND status = 'active' AND head_revision_id = ?
      AND EXISTS (SELECT 1 FROM branch_working_copies copy WHERE copy.branch_id = article_branches.id
        AND copy.article_id = article_branches.article_id AND copy.base_revision_id = ? AND copy.dirty = 0
        AND copy.lock_version = ?)
      AND EXISTS (SELECT 1 FROM agent_tasks task
        JOIN agent_task_attempts attempt ON attempt.id = task.active_attempt_id
        JOIN agent_context_snapshots context ON context.id = attempt.context_snapshot_id
        JOIN agent_task_leases lease ON lease.attempt_id = attempt.id AND lease.task_id = task.id
        WHERE task.id = ? AND task.target_branch_id = article_branches.id AND task.assigned_client_id = ?
          AND task.state IN ('claimed','running') AND attempt.id = ? AND attempt.state IN ('claimed','running')
          AND context.context_sha256 = ? AND lease.id = ? AND lease.client_id = ?
          AND lease.lease_token_sha256 = ? AND lease.revoked_at IS NULL AND lease.expires_at > ?)`)
      .bind(revisionId, now, branchId, String(guard.task.article_id), identity.name, identity.slug,
        expectedHeadRevisionId, expectedHeadRevisionId, Number(branch.copy_lock_version), guard.taskId, auth.id,
        guard.attemptId, guard.contextSha256, guard.leaseId, auth.id, guard.leaseTokenSha256, now),
    db.prepare(`INSERT INTO article_revisions
      (id, article_id, branch_id, sequence, parent_revision_id, title, document_title, annotation,
       body_text, body_sha256, author_kind, created_at)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'agent', ?
      WHERE EXISTS (SELECT 1 FROM article_branches WHERE id = ? AND head_revision_id = ?)`)
      .bind(revisionId, String(guard.task.article_id), branchId, sequence, expectedHeadRevisionId, revisionTitle,
        documentTitle, summary, bodyText, bodySha256, now, branchId, revisionId),
    db.prepare(`UPDATE branch_working_copies SET base_revision_id = ?, title = ?, annotation = '',
      body_text = ?, body_sha256 = ?, dirty = 0, lock_version = lock_version + 1, updated_at = ?
      WHERE branch_id = ? AND article_id = ? AND base_revision_id = ? AND dirty = 0 AND lock_version = ?
      AND EXISTS (SELECT 1 FROM article_branches WHERE id = ? AND head_revision_id = ?)
      AND EXISTS (SELECT 1 FROM article_revisions WHERE id = ? AND branch_id = ? AND body_sha256 = ?)`)
      .bind(revisionId, documentTitle, bodyText, bodySha256, now, branchId, String(guard.task.article_id),
        expectedHeadRevisionId, Number(branch.copy_lock_version), branchId, revisionId, revisionId, branchId, bodySha256),
    db.prepare(`UPDATE agent_task_attempts SET state = 'running' WHERE id = ? AND state IN ('claimed','running')
      AND EXISTS (SELECT 1 FROM article_branches WHERE id = ? AND head_revision_id = ?)
      AND EXISTS (SELECT 1 FROM branch_working_copies WHERE branch_id = ? AND base_revision_id = ? AND lock_version = ?)`)
      .bind(guard.attemptId, branchId, revisionId, branchId, revisionId, nextCopyLock),
    db.prepare(`UPDATE agent_tasks SET state = 'running', lock_version = lock_version + 1, updated_at = ?
      WHERE id = ? AND active_attempt_id = ? AND assigned_client_id = ? AND target_branch_id = ?
      AND state IN ('claimed','running')
      AND EXISTS (SELECT 1 FROM article_revisions WHERE id = ? AND branch_id = ? AND author_kind = 'agent')
      AND EXISTS (SELECT 1 FROM branch_working_copies WHERE branch_id = ? AND base_revision_id = ? AND lock_version = ?)`)
      .bind(now, guard.taskId, guard.attemptId, auth.id, branchId, revisionId, branchId, branchId, revisionId, nextCopyLock),
    db.prepare(`INSERT INTO agent_progress_events
      (id, task_id, attempt_id, event_type, phase, progress_percent, current_action, next_action, blocker,
       message, evidence_json, payload_json, actor_kind, actor_id, command_id, input_sha256, created_at)
      SELECT ?, id, ?, 'revision.proposed', 'drafting', NULL, '已推进 Agent 专属分支',
       '继续改写或提交技术验收', '', ?, ?, ?, 'agent', ?, ?, ?, ? FROM agent_tasks
      WHERE id = ? AND active_attempt_id = ? AND assigned_client_id = ? AND target_branch_id = ? AND state = 'running'
      AND EXISTS (SELECT 1 FROM article_revisions WHERE id = ? AND branch_id = ? AND body_sha256 = ?)
      AND EXISTS (SELECT 1 FROM branch_working_copies WHERE branch_id = ? AND base_revision_id = ? AND lock_version = ?)`)
      .bind(eventId, guard.attemptId, summary, canonicalJson([`revision:${revisionId}`, `sha256:${bodySha256}`]),
        canonicalJson({
          revisionId, branchId, parentRevisionId: expectedHeadRevisionId, sequence,
          bodySha256, titleSha256, revisionInputSha256, directMainWrite: false, mergePerformed: false,
        }), auth.id, commandId, inputSha256, now, guard.taskId, guard.attemptId, auth.id, branchId,
        revisionId, branchId, bodySha256, branchId, revisionId, nextCopyLock),
    db.prepare(`INSERT INTO workspace_events
      (id, event_type, subject_type, subject_id, article_id, payload_json, input_sha256, created_at)
      SELECT ?, 'agent.revision_proposed', 'revision', ?, ?, ?, ?, ?
      WHERE EXISTS (SELECT 1 FROM article_revisions WHERE id = ? AND branch_id = ? AND body_sha256 = ?)
      AND EXISTS (SELECT 1 FROM article_branches WHERE id = ? AND head_revision_id = ?)
      AND EXISTS (SELECT 1 FROM branch_working_copies WHERE branch_id = ? AND base_revision_id = ? AND lock_version = ?)`)
      .bind(workspaceEventId, revisionId, String(guard.task.article_id), canonicalJson({
        taskId: guard.taskId, attemptId: guard.attemptId, branchId, parentRevisionId: expectedHeadRevisionId,
        sequence, bodySha256, titleSha256, revisionInputSha256, candidateOnly: true,
      }), revisionInputSha256, now, revisionId, branchId, bodySha256, branchId, revisionId, branchId, revisionId, nextCopyLock),
  ]);
  if (results.some((result) => Number(result.meta.changes ?? 0) !== 1)) {
    throw new AgentApiError("REVISION_PROPOSAL_CONFLICT", "Agent 分支、working copy、租约或 task 在提交时发生并发变化", 409);
  }
  const [updatedTask, revision, updatedBranch, workingCopy, event] = await Promise.all([
    taskRow(db, guard.taskId),
    db.prepare("SELECT * FROM article_revisions WHERE id = ?").bind(revisionId).first<D1Row>(),
    db.prepare("SELECT * FROM article_branches WHERE id = ?").bind(branchId).first<D1Row>(),
    db.prepare("SELECT * FROM branch_working_copies WHERE branch_id = ?").bind(branchId).first<D1Row>(),
    db.prepare("SELECT * FROM agent_progress_events WHERE id = ?").bind(eventId).first<D1Row>(),
  ]);
  return {
    status: 201,
    data: {
      task: parseTask(updatedTask), revision: revision ? parseAgentRevision(revision) : null,
      branch: updatedBranch ? parseAgentBranch(updatedBranch) : null,
      workingCopy: workingCopy ? parseAgentWorkingCopy(workingCopy) : null,
      event: event ? parseEvent(event) : null,
      hashes: { bodySha256, titleSha256, revisionInputSha256 },
      boundary: { candidateOnly: true, mainWritten: false, mergePerformed: false, editorialApproved: false, releaseApproved: false },
    },
  };
}

function packagePatchOperations(value: unknown): PackagePatchOperation[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 50) {
    throw new AgentApiError("INVALID_PACKAGE_PATCH", "operations 必须包含 1 到 50 个 Package Patch 操作");
  }
  const allowed = new Set(["replace_module", "remove_module", "upsert_edge", "remove_edge"]);
  value.forEach((item, index) => {
    if (isObject(item) && cleanText(item.op, 40) === "replace_document") {
      throw new AgentApiError("PACKAGE_PATCH_DOCUMENT_REPLACE_FORBIDDEN", "单模块 Package Patch 任务禁止 replace_document；必须提交绑定 targetModuleKey 的局部候选", 403, { operationIndex: index });
    }
    if (isObject(item) && cleanText(item.op, 40) === "add_module") {
      throw new AgentApiError("PACKAGE_PATCH_TARGET_SCOPE_VIOLATION", "单模块 Package Patch 任务只处理冻结的既有 targetModuleKey，不能 add_module", 409, { operationIndex: index });
    }
    if (!isObject(item) || !allowed.has(cleanText(item.op, 40))) {
      throw new AgentApiError("INVALID_PACKAGE_PATCH", `operations[${index}] 的 op 不受支持`);
    }
    const op = String(item.op);
    if (["replace_module", "remove_module"].includes(op) && !cleanText(item.moduleKey, 120)) {
      throw new AgentApiError("INVALID_PACKAGE_PATCH", `operations[${index}] 缺少 moduleKey`);
    }
    if (op === "replace_module" && !isObject(item.module)) {
      throw new AgentApiError("INVALID_PACKAGE_PATCH", `operations[${index}] 缺少 module`);
    }
    if (op === "upsert_edge" && !isObject(item.edge)) {
      throw new AgentApiError("INVALID_PACKAGE_PATCH", `operations[${index}] 缺少 edge`);
    }
    if (op === "remove_edge" && !cleanText(item.edgeKey, 120)) {
      throw new AgentApiError("INVALID_PACKAGE_PATCH", `operations[${index}] 缺少 edgeKey`);
    }
  });
  if (new TextEncoder().encode(canonicalJson(value)).byteLength > 1_600_000) {
    throw new AgentApiError("PACKAGE_PATCH_TOO_LARGE", "Package Patch operations 超过 1.6 MB", 413);
  }
  return canonicalValue(value) as PackagePatchOperation[];
}

function assertSingleTargetPackagePatch(
  operations: PackagePatchOperation[],
  targetModuleKey: string,
  snapshot: FrozenPackageSnapshot,
) {
  const document = frozenPackageDocument(snapshot);
  const moduleKeys = new Set(document.modules.filter(isObject).map((module) => cleanText(module.key, 120)).filter(Boolean));
  const edgesByKey = new Map(document.edges.filter(isObject).map((edge) => [cleanText(edge.key, 120), edge] as const).filter(([key]) => Boolean(key)));
  operations.forEach((operation, operationIndex) => {
    if (operation.op === "replace_document") {
      throw new AgentApiError("PACKAGE_PATCH_DOCUMENT_REPLACE_FORBIDDEN", "单模块 Package Patch 任务禁止 replace_document", 403, { operationIndex });
    }
    if (operation.op === "add_module") {
      throw new AgentApiError("PACKAGE_PATCH_TARGET_SCOPE_VIOLATION", "冻结目标模块已经存在；单模块任务不能新增其他模块", 409, {
        operationIndex,
        targetModuleKey,
        requestedModuleKey: cleanText(operation.module?.key, 120) || null,
      });
    }
    if (operation.op === "replace_module") {
      const replacementKey = cleanText(operation.module?.key, 120);
      if (operation.moduleKey !== targetModuleKey || replacementKey !== targetModuleKey) {
        throw new AgentApiError("PACKAGE_PATCH_TARGET_SCOPE_VIOLATION", "replace_module 只能原位替换冻结的 targetModuleKey，不能改名或触及其他模块", 409, {
          operationIndex, targetModuleKey, moduleKey: operation.moduleKey, replacementKey: replacementKey || null,
        });
      }
      return;
    }
    if (operation.op === "remove_module") {
      if (operation.moduleKey !== targetModuleKey) {
        throw new AgentApiError("PACKAGE_PATCH_TARGET_SCOPE_VIOLATION", "remove_module 只能指向冻结的 targetModuleKey", 409, {
          operationIndex, targetModuleKey, moduleKey: operation.moduleKey,
        });
      }
      return;
    }
    if (operation.op === "upsert_edge") {
      const sourceModuleKey = cleanText(operation.edge?.sourceModuleKey, 120);
      const targetEdgeModuleKey = cleanText(operation.edge?.targetModuleKey, 120);
      if (!moduleKeys.has(sourceModuleKey) || !moduleKeys.has(targetEdgeModuleKey)
        || (sourceModuleKey !== targetModuleKey && targetEdgeModuleKey !== targetModuleKey)) {
        throw new AgentApiError("PACKAGE_PATCH_TARGET_SCOPE_VIOLATION", "upsert_edge 必须连接冻结目标模块与当前 Composition 中的既有模块", 409, {
          operationIndex, frozenTargetModuleKey: targetModuleKey,
          edgeSourceModuleKey: sourceModuleKey || null, edgeTargetModuleKey: targetEdgeModuleKey || null,
        });
      }
      return;
    }
    if (operation.op === "remove_edge") {
      const frozenEdge = edgesByKey.get(operation.edgeKey);
      const sourceModuleKey = frozenEdge ? cleanText(frozenEdge.sourceModuleKey, 120) : "";
      const targetEdgeModuleKey = frozenEdge ? cleanText(frozenEdge.targetModuleKey, 120) : "";
      if (!frozenEdge || (sourceModuleKey !== targetModuleKey && targetEdgeModuleKey !== targetModuleKey)) {
        throw new AgentApiError("PACKAGE_PATCH_TARGET_SCOPE_VIOLATION", "remove_edge 只能删除冻结 Composition 中与 targetModuleKey 相连的边", 409, {
          operationIndex, targetModuleKey, edgeKey: operation.edgeKey,
        });
      }
    }
  });
}

async function proposePackagePatch(
  db: D1Database,
  auth: ClientAuth,
  payload: JsonObject,
  commandId: string,
  inputSha256: string,
): Promise<MutationResult> {
  if (!(await tableExists(db, "package_patch_proposals"))) {
    throw new AgentApiError("PACKAGE_STORAGE_UNAVAILABLE", "Package Patch 存储尚未初始化", 409);
  }
  const guard = await leaseGuard(db, auth, payload);
  const permission = parseJson<JsonObject>(guard.task.permission_ceiling_json, {});
  const allow = Array.isArray(permission.allow) ? permission.allow.map(String) : [];
  if (permission.writeScope !== "package-patch" || permission.packagePatch !== true || !allow.includes("package.patch.propose")) {
    throw new AgentApiError("TASK_PERMISSION_DENIED", "任务没有候选 Package Patch 提案权限", 403);
  }
  const context = await db.prepare(`SELECT context.* FROM agent_context_snapshots context
    JOIN agent_task_attempts attempt ON attempt.context_snapshot_id = context.id
    WHERE attempt.id = ? AND attempt.task_id = ? AND context.context_sha256 = ? LIMIT 1`)
    .bind(guard.attemptId, guard.taskId, guard.contextSha256).first<D1Row>();
  if (!context) throw new AgentApiError("CONTEXT_STALE", "活动 attempt 的冻结上下文不存在", 409);
  assertPackagePatchAgentGuidance(packageGuidanceFromContextRow(context), "propose_package_patch", "frozen");
  const currentPackageSnapshot = await loadFrozenPackageSnapshot(
    db,
    String(guard.task.article_id),
    String(guard.task.target_branch_id ?? ""),
    true,
  );
  assertPackagePatchAgentGuidance(currentPackageSnapshot?.bundle.guidanceChecklist, "propose_package_patch", "current");
  const snapshot = await assertFrozenPackageContextCurrent(db, guard.task, context, currentPackageSnapshot);
  if (!snapshot) throw new AgentApiError("PACKAGE_CONTEXT_REQUIRED", "任务没有冻结 Package 上下文", 409);
  const packageId = requiredText(payload.packageId, "packageId", 160);
  const branchId = requiredText(payload.branchId, "branchId", 160);
  const baseRevisionId = requiredText(payload.baseRevisionId, "baseRevisionId", 160);
  let expectedBranchLockVersion: number;
  let legacyExpectedPackageLockVersion: number | null = null;
  if (payload.expectedBranchLockVersion !== undefined) {
    expectedBranchLockVersion = Number(payload.expectedBranchLockVersion);
    if (!Number.isSafeInteger(expectedBranchLockVersion) || expectedBranchLockVersion < 1) {
      throw new AgentApiError("INVALID_BRANCH_LOCK_VERSION", "expectedBranchLockVersion 必须是正整数");
    }
  } else {
    legacyExpectedPackageLockVersion = Number(payload.expectedPackageLockVersion);
    if (!snapshot.primaryBranch) {
      throw new AgentApiError("BRANCH_LOCK_VERSION_REQUIRED", "非 primary 分支必须提供 expectedBranchLockVersion", 409);
    }
    if (!Number.isSafeInteger(legacyExpectedPackageLockVersion) || legacyExpectedPackageLockVersion < 1) {
      throw new AgentApiError("INVALID_PACKAGE_LOCK_VERSION", "primary 兼容模式的 expectedPackageLockVersion 必须是正整数");
    }
    if (legacyExpectedPackageLockVersion !== snapshot.packageLockVersion) {
      throw new AgentApiError("PACKAGE_BASELINE_MISMATCH", "primary 兼容模式的 Package lockVersion 已变化", 409);
    }
    expectedBranchLockVersion = snapshot.baseBranchLockVersion;
  }
  const baseCompositionId = requiredText(payload.baseCompositionId, "baseCompositionId", 160);
  const baseCompositionSha256 = requiredText(payload.expectedBaseCompositionSha256, "expectedBaseCompositionSha256", 64).toLowerCase();
  if (!SHA256_RE.test(baseCompositionSha256)) throw new AgentApiError("INVALID_SHA256", "expectedBaseCompositionSha256 必须是 SHA-256");
  if (packageId !== snapshot.packageId || branchId !== snapshot.branchId
    || baseRevisionId !== snapshot.baseRevisionId
    || expectedBranchLockVersion !== snapshot.baseBranchLockVersion
    || baseCompositionId !== snapshot.compositionId || baseCompositionSha256 !== snapshot.compositionSha256
    || String(guard.task.target_branch_id ?? "") !== snapshot.branchId
    || String(guard.task.base_revision_id ?? "") !== snapshot.baseRevisionId
    || Number(guard.task.base_branch_lock_version) !== snapshot.baseBranchLockVersion) {
    throw new AgentApiError("PACKAGE_BASELINE_MISMATCH", "提案基线与租约冻结的 Package/Branch 基线不一致", 409, {
      frozen: {
        packageId: snapshot.packageId, branchId: snapshot.branchId, baseRevisionId: snapshot.baseRevisionId,
        baseBranchLockVersion: snapshot.baseBranchLockVersion,
        compositionId: snapshot.compositionId, compositionSha256: snapshot.compositionSha256,
      },
    });
  }
  const title = requiredText(payload.title, "title", 300);
  const summary = cleanText(payload.summary, 4000, true);
  const taskContextSpec = parseJson<JsonObject>(guard.task.context_spec_json, {});
  const targetModuleKey = assertFrozenTargetModule(snapshot, taskContextSpec.targetModuleKey);
  const operations = packagePatchOperations(payload.operations);
  assertSingleTargetPackagePatch(operations, targetModuleKey, snapshot);
  const evidence = payload.evidence === undefined ? [] : stringArray(payload.evidence, "evidence", 60);
  const diagnosticIssueIds = payload.diagnosticIssueIds === undefined
    ? [] : stringArray(payload.diagnosticIssueIds, "diagnosticIssueIds", 100);
  const frozenIssues = new Set(snapshot.diagnosticIssueIds);
  const unknownIssueIds = diagnosticIssueIds.filter((issueId) => !frozenIssues.has(issueId));
  if (unknownIssueIds.length) {
    throw new AgentApiError("DIAGNOSTIC_ISSUE_NOT_FROZEN", "Patch 只能引用当前冻结诊断中的问题", 409, { unknownIssueIds });
  }
  const patchSha256 = await sha256Text(canonicalJson({
    schemaVersion: "wenmai-agent-package-patch-v2", taskId: guard.taskId, attemptId: guard.attemptId,
    contextSha256: guard.contextSha256, packageId, branchId, baseRevisionId, expectedBranchLockVersion,
    baseCompositionId, baseCompositionSha256, targetModuleKey,
    title, summary, operations, evidence, diagnosticIssueIds,
  }));
  const existing = await db.prepare(`SELECT * FROM package_patch_proposals
    WHERE package_id = ? AND patch_sha256 = ? LIMIT 1`).bind(packageId, patchSha256).first<D1Row>();
  if (existing) {
    if (existing.task_id !== guard.taskId || existing.attempt_id !== guard.attemptId || existing.context_sha256 !== guard.contextSha256) {
      throw new AgentApiError("PACKAGE_PATCH_HASH_CONFLICT", "相同 Patch 摘要已绑定其他任务来源", 409);
    }
    return {
      data: {
        patchProposal: parsePackagePatchProposal(existing), reused: true,
        boundary: {
          candidateOnly: true, patchApplied: false, compositionCreated: false,
          packageMainAdvanced: false, articleBranchAdvanced: false, revisionCreated: false,
          humanReviewRequired: true, targetModuleKey,
        },
      },
    };
  }
  const proposalId = `package-patch-${crypto.randomUUID()}`;
  const eventId = `agent-event-${crypto.randomUUID()}`;
  const now = isoNow();
  const diagnosisGuard = snapshot.diagnosisRunId
    ? `AND (SELECT id FROM package_diagnosis_runs WHERE package_id = package.id
        AND branch_id = state.branch_id AND base_revision_id = state.head_revision_id
        AND base_branch_lock_version = state.lock_version
        AND composition_id = state.head_composition_id AND composition_sha256 = state.head_composition_sha256
        ORDER BY created_at DESC LIMIT 1) = ?`
    : `AND NOT EXISTS (SELECT 1 FROM package_diagnosis_runs WHERE package_id = package.id
        AND branch_id = state.branch_id AND base_revision_id = state.head_revision_id
        AND base_branch_lock_version = state.lock_version
        AND composition_id = state.head_composition_id AND composition_sha256 = state.head_composition_sha256)`;
  const diagnosisBindings = snapshot.diagnosisRunId ? [snapshot.diagnosisRunId] : [];
  const legacyPrimaryGuard = legacyExpectedPackageLockVersion === null
    ? ""
    : "AND package.primary_branch_id = state.branch_id AND package.lock_version = ?";
  const legacyPrimaryBindings = legacyExpectedPackageLockVersion === null ? [] : [legacyExpectedPackageLockVersion];
  const results = await db.batch([
    db.prepare(`INSERT INTO package_patch_proposals
      (id, package_id, base_composition_id, base_composition_sha256, branch_id, base_revision_id,
       base_package_lock_version, base_branch_lock_version, task_id, attempt_id, context_sha256, title, summary, operations_json,
       patch_sha256, evidence_json, diagnostic_issue_ids_json, status, lock_version, created_by_kind,
       created_by_id, decision_note, created_at)
      SELECT ?, package.id, state.head_composition_id, state.head_composition_sha256, state.branch_id,
       state.head_revision_id, CASE WHEN package.primary_branch_id = state.branch_id THEN package.lock_version ELSE NULL END,
       state.lock_version, task.id, attempt.id, context.context_sha256,
       ?, ?, ?, ?, ?, ?, 'candidate', 1, 'agent', ?, '', ?
      FROM agent_task_leases lease
      JOIN agent_task_attempts attempt ON attempt.id = lease.attempt_id AND attempt.task_id = lease.task_id
      JOIN agent_tasks task ON task.id = lease.task_id AND task.active_attempt_id = attempt.id
      JOIN agent_context_snapshots context ON context.id = attempt.context_snapshot_id
      JOIN article_project_packages package ON package.id = task.package_id AND package.article_id = task.article_id
      JOIN package_branch_migration_audits audit ON audit.package_id = package.id
        AND audit.state NOT IN ('blocked','legacy_unbound')
      JOIN package_branch_states state ON state.package_id = package.id AND state.branch_id = task.target_branch_id
      JOIN package_compositions composition ON composition.id = state.head_composition_id AND composition.package_id = state.package_id
      JOIN package_branch_working_copies package_copy
        ON package_copy.package_id = state.package_id AND package_copy.branch_id = state.branch_id
      JOIN article_branches branch ON branch.id = state.branch_id AND branch.article_id = package.article_id
      JOIN article_revisions head ON head.id = state.head_revision_id AND head.branch_id = state.branch_id
        AND head.article_id = package.article_id
      JOIN branch_working_copies branch_copy ON branch_copy.branch_id = state.branch_id AND branch_copy.article_id = package.article_id
      JOIN package_composition_materializations bridge
        ON bridge.package_id = state.package_id AND bridge.branch_id = state.branch_id
        AND bridge.composition_id = state.head_composition_id
        AND bridge.composition_sha256 = state.head_composition_sha256
        AND bridge.article_revision_id = state.head_revision_id AND bridge.article_body_sha256 = head.body_sha256
      JOIN package_branch_composition_commits commit_ref
        ON commit_ref.package_id = state.package_id AND commit_ref.branch_id = state.branch_id
        AND commit_ref.composition_id = state.head_composition_id
        AND commit_ref.composition_sha256 = state.head_composition_sha256
        AND commit_ref.article_revision_id = state.head_revision_id
      WHERE lease.id = ? AND lease.task_id = ? AND lease.attempt_id = ? AND lease.client_id = ?
        AND lease.lease_token_sha256 = ? AND lease.revoked_at IS NULL AND lease.expires_at > ?
        AND attempt.state IN ('claimed','running') AND task.state IN ('claimed','running')
        AND task.assigned_client_id = ? AND context.context_sha256 = ?
        AND package.status = 'active' AND package.branch_model_version = 2
        AND task.target_branch_id = state.branch_id AND task.base_revision_id = state.head_revision_id
        AND task.base_branch_lock_version = state.lock_version
        AND task.base_composition_id = state.head_composition_id
        AND task.base_composition_sha256 = state.head_composition_sha256
        AND context.package_id = package.id AND context.branch_id = state.branch_id
        AND context.composition_id = state.head_composition_id
        AND context.composition_sha256 = state.head_composition_sha256
        AND context.package_document_sha256 = composition.document_sha256
        AND context.branch_head_revision_id = state.head_revision_id
        AND context.branch_state_lock_version = state.lock_version
        AND package.id = ? AND state.branch_id = ? AND state.lock_version = ?
        AND state.head_composition_id = ? AND state.head_composition_sha256 = ?
        AND state.head_revision_id = ? AND state.status = 'active' AND composition.document_sha256 = ?
        AND package_copy.base_composition_id = state.head_composition_id
        AND package_copy.base_revision_id = state.head_revision_id
        AND package_copy.document_sha256 = composition.document_sha256 AND package_copy.dirty = 0
        AND branch.head_revision_id = state.head_revision_id AND branch.status = 'active'
        AND branch_copy.base_revision_id = state.head_revision_id
        AND branch_copy.body_sha256 = head.body_sha256 AND branch_copy.dirty = 0
        ${diagnosisGuard} ${legacyPrimaryGuard} LIMIT 1`)
      .bind(
        proposalId, title, summary, canonicalJson(operations), patchSha256, canonicalJson(evidence), canonicalJson(diagnosticIssueIds),
        auth.id, now, guard.leaseId, guard.taskId, guard.attemptId, auth.id, guard.leaseTokenSha256, now,
        auth.id, guard.contextSha256, packageId, branchId, expectedBranchLockVersion, baseCompositionId,
        baseCompositionSha256, baseRevisionId, snapshot.documentSha256,
        ...diagnosisBindings, ...legacyPrimaryBindings,
      ),
    db.prepare(`UPDATE agent_task_attempts SET state = 'running' WHERE id = ? AND task_id = ? AND state IN ('claimed','running')
      AND EXISTS (SELECT 1 FROM package_patch_proposals WHERE id = ? AND task_id = ? AND attempt_id = ?
        AND context_sha256 = ? AND status = 'candidate')`)
      .bind(guard.attemptId, guard.taskId, proposalId, guard.taskId, guard.attemptId, guard.contextSha256),
    db.prepare(`UPDATE agent_tasks SET state = 'running', lock_version = lock_version + 1, updated_at = ?
      WHERE id = ? AND active_attempt_id = ? AND assigned_client_id = ? AND state IN ('claimed','running')
      AND EXISTS (SELECT 1 FROM package_patch_proposals WHERE id = ? AND task_id = agent_tasks.id
        AND attempt_id = agent_tasks.active_attempt_id AND context_sha256 = ? AND status = 'candidate')`)
      .bind(now, guard.taskId, guard.attemptId, auth.id, proposalId, guard.contextSha256),
    db.prepare(`INSERT INTO agent_progress_events
      (id, task_id, attempt_id, event_type, phase, progress_percent, current_action, next_action, blocker,
       message, evidence_json, payload_json, actor_kind, actor_id, command_id, input_sha256, created_at)
      SELECT ?, task.id, task.active_attempt_id, 'package.patch_proposed', 'drafting', NULL,
       '已提交候选 Package Patch', '等待人工审查；Agent 不得直接 apply', '', ?, ?, ?,
       'agent', ?, ?, ?, ? FROM agent_tasks task
      JOIN package_patch_proposals patch ON patch.id = ? AND patch.task_id = task.id AND patch.attempt_id = task.active_attempt_id
      WHERE task.id = ? AND task.state = 'running' AND patch.status = 'candidate' LIMIT 1`)
      .bind(
        eventId, summary, canonicalJson(evidence), canonicalJson({
          patchProposalId: proposalId, packageId, branchId, baseRevisionId,
          baseBranchLockVersion: expectedBranchLockVersion, baseCompositionId, baseCompositionSha256,
          targetModuleKey,
          candidateOnly: true, patchApplied: false, packageMainAdvanced: false, articleBranchAdvanced: false,
        }), auth.id, commandId, inputSha256, now, proposalId, guard.taskId,
      ),
  ]);
  if (results.some((result) => Number(result.meta.changes ?? 0) !== 1)) {
    throw new AgentApiError("PACKAGE_PATCH_CONFLICT", "Package/Branch/诊断基线、租约或任务状态在提交候选 Patch 时发生变化", 409);
  }
  const [proposal, updatedTask, event] = await Promise.all([
    db.prepare("SELECT * FROM package_patch_proposals WHERE id = ?").bind(proposalId).first<D1Row>(),
    taskRow(db, guard.taskId),
    db.prepare("SELECT * FROM agent_progress_events WHERE id = ?").bind(eventId).first<D1Row>(),
  ]);
  return {
    status: 201,
    data: {
      task: parseTask(updatedTask), patchProposal: proposal ? parsePackagePatchProposal(proposal) : null,
      event: event ? parseEvent(event) : null, reused: false,
      boundary: {
        candidateOnly: true, patchApplied: false, compositionCreated: false,
        packageMainAdvanced: false, articleBranchAdvanced: false, revisionCreated: false,
        humanReviewRequired: true, targetModuleKey,
      },
    },
  };
}

async function createGraphProposal(
  db: D1Database,
  auth: ClientAuth,
  payload: JsonObject,
  commandId: string,
  inputSha256: string,
): Promise<MutationResult> {
  const guard = await leaseGuard(db, auth, payload);
  const proposalKind = requiredText(payload.proposalKind, "proposalKind", 20);
  if (!["node", "edge", "claim"].includes(proposalKind)) throw new AgentApiError("INVALID_PROPOSAL_KIND", "proposalKind 只能是 node、edge 或 claim");
  const sourceId = cleanText(payload.sourceId, 160) || null;
  const targetId = cleanText(payload.targetId, 160) || null;
  const relationType = cleanText(payload.relationType, 120);
  const label = cleanText(payload.label, 500, true);
  if (proposalKind === "edge" && (!sourceId || !targetId || !relationType)) {
    throw new AgentApiError("INCOMPLETE_EDGE_PROPOSAL", "edge 提案必须包含 sourceId、targetId 和 relationType");
  }
  if (proposalKind !== "edge" && !label) throw new AgentApiError("PROPOSAL_LABEL_REQUIRED", "node 或 claim 提案必须包含 label");
  const proposalPayload = payload.proposalPayload === undefined
    ? {}
    : isObject(payload.proposalPayload) ? payload.proposalPayload : (() => { throw new AgentApiError("INVALID_PROPOSAL_PAYLOAD", "proposalPayload 必须是对象"); })();
  const evidence = stringArray(payload.evidence, "evidence", 30);
  if (!evidence.length) throw new AgentApiError("PROPOSAL_EVIDENCE_REQUIRED", "图谱提案必须携带至少一项可核查 evidence");
  const id = `graph-proposal-${crypto.randomUUID()}`;
  const now = isoNow();
  const results = await db.batch([
    db.prepare(`UPDATE agent_task_attempts SET state = 'running' WHERE id = ? AND state IN ('claimed','running')
      AND EXISTS (SELECT 1 FROM agent_task_leases WHERE id = ? AND lease_token_sha256 = ?
      AND revoked_at IS NULL AND expires_at > ?)`)
      .bind(guard.attemptId, guard.leaseId, guard.leaseTokenSha256, now),
    db.prepare(`UPDATE agent_tasks SET state = 'running', lock_version = lock_version + 1, updated_at = ?
      WHERE id = ? AND active_attempt_id = ? AND assigned_client_id = ? AND state IN ('claimed','running')
      AND EXISTS (SELECT 1 FROM agent_task_leases WHERE id = ? AND lease_token_sha256 = ?
      AND revoked_at IS NULL AND expires_at > ?)`)
      .bind(now, guard.taskId, guard.attemptId, auth.id, guard.leaseId, guard.leaseTokenSha256, now),
    db.prepare(`INSERT INTO graph_proposals
      (id, task_id, attempt_id, article_id, proposal_kind, source_id, target_id, relation_type, label,
       payload_json, evidence_json, context_sha256, input_sha256, status, lock_version, created_by_client_id, created_at)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'candidate', 1, ?, ? FROM agent_task_leases
      WHERE id = ? AND task_id = ? AND attempt_id = ? AND client_id = ? AND lease_token_sha256 = ?
      AND revoked_at IS NULL AND expires_at > ? LIMIT 1`)
      .bind(id, guard.taskId, guard.attemptId, String(guard.task.article_id), proposalKind, sourceId, targetId,
        relationType, label, canonicalJson(proposalPayload), canonicalJson(evidence), guard.contextSha256,
        inputSha256, auth.id, now, guard.leaseId, guard.taskId, guard.attemptId, auth.id, guard.leaseTokenSha256, now),
    eventFromTask(db, {
      taskId: guard.taskId, attemptId: guard.attemptId, eventType: "graph.proposal_created", phase: "knowledge",
      currentAction: "已建立候选图谱提案", nextAction: "等待人工确认或继续任务", message: label || relationType,
      evidence, payload: { graphProposalId: id, proposalKind, status: "candidate", canonicalGraphMutated: false },
      actorKind: "agent", actorId: auth.id, commandId, inputSha256, createdAt: now,
    }, "id = ? AND active_attempt_id = ? AND state = ?", [guard.taskId, guard.attemptId, "running"]),
  ]);
  if (results.some((result) => Number(result.meta.changes ?? 0) !== 1)) {
    throw new AgentApiError("GRAPH_PROPOSAL_CONFLICT", "建立图谱提案时租约或任务状态已经变化", 409);
  }
  const row = await db.prepare("SELECT * FROM graph_proposals WHERE id = ?").bind(id).first<D1Row>();
  return {
    status: 201,
    data: { graphProposal: row ? parseGraphProposal(row) : null, canonicalGraphMutated: false, corpusRegenerationRequired: false },
  };
}

async function decideGraphProposal(
  db: D1Database,
  payload: JsonObject,
  commandId: string,
  inputSha256: string,
  actor: ControlPrincipal,
): Promise<MutationResult> {
  const proposalId = requiredText(payload.graphProposalId, "graphProposalId", 120);
  const expectedLockVersion = requireLockVersion(payload.expectedLockVersion);
  const decision = requiredText(payload.decision, "decision", 20);
  if (!["confirmed", "rejected"].includes(decision)) throw new AgentApiError("INVALID_DECISION", "decision 只能是 confirmed 或 rejected");
  const note = cleanText(payload.note, 4000, true);
  if (decision === "rejected" && !note) throw new AgentApiError("DECISION_NOTE_REQUIRED", "拒绝图谱提案时必须说明原因");
  const proposal = await db.prepare("SELECT * FROM graph_proposals WHERE id = ? LIMIT 1").bind(proposalId).first<D1Row>();
  if (!proposal) throw new AgentApiError("GRAPH_PROPOSAL_NOT_FOUND", "图谱提案不存在", 404);
  if (proposal.status !== "candidate" || Number(proposal.lock_version) !== expectedLockVersion) {
    throw new AgentApiError("GRAPH_PROPOSAL_STALE", "图谱提案已经处理或锁版本已变化", 409);
  }
  const decisionAuthorityClientId = controlAuthorityClientId(actor);
  if (decisionAuthorityClientId && await sameAgentAuthorityLineage(db, String(proposal.created_by_client_id), decisionAuthorityClientId)) {
    throw new AgentApiError("SELF_APPROVAL_FORBIDDEN", "超级管理员不能决定由自身 Agent Key 创建的图谱提案", 403);
  }
  const now = isoNow();
  const eventId = `agent-event-${crypto.randomUUID()}`;
  const results = await db.batch([
    db.prepare(`UPDATE graph_proposals SET status = ?, lock_version = lock_version + 1, reviewed_at = ?,
      reviewed_by = ?, review_note = ? WHERE id = ? AND status = 'candidate' AND lock_version = ?`)
      .bind(decision, now, actor.actorId, note, proposalId, expectedLockVersion),
    db.prepare(`INSERT INTO agent_progress_events
      (id, task_id, attempt_id, event_type, phase, progress_percent, current_action, next_action, blocker,
       message, evidence_json, payload_json, actor_kind, actor_id, command_id, input_sha256, created_at)
      SELECT ?, task_id, attempt_id, 'graph.proposal_decided', 'knowledge', NULL, ?, ?, '', ?, evidence_json,
       ?, ?, ?, ?, ?, ? FROM graph_proposals
      WHERE id = ? AND status = ? AND lock_version = ? LIMIT 1`)
      .bind(eventId, decision === "confirmed" ? "人工已确认图谱候选" : "人工已拒绝图谱候选",
        decision === "confirmed" ? "等待独立 corpus 再生成流程" : "无需写入 canonical graph", note,
        canonicalJson({ graphProposalId: proposalId, decision, canonicalGraphMutated: false }),
        actor.kind === "agent" ? "agent" : "user", actor.actorId,
        commandId, inputSha256, now, proposalId, decision, expectedLockVersion + 1),
  ]);
  if (results.some((result) => Number(result.meta.changes ?? 0) !== 1)) {
    throw new AgentApiError("GRAPH_DECISION_CONFLICT", "图谱提案决定发生并发冲突", 409);
  }
  const row = await db.prepare("SELECT * FROM graph_proposals WHERE id = ?").bind(proposalId).first<D1Row>();
  return {
    data: {
      graphProposal: row ? parseGraphProposal(row) : null,
      canonicalGraphMutated: false,
      corpusRegenerationRequired: decision === "confirmed",
      boundary: {
        editorialApproved: false,
        releaseApproved: false,
        publicAccessVerified: false,
        overallComplete: false,
      },
    },
  };
}

export async function POST(request: Request) {
  const id = requestId();
  try {
    const { action, commandId, payload } = await parseMutationBody(request);
    const db = await ensureAgentSchema();
    if (PRIVILEGED_TASK_MANAGEMENT_ACTIONS.has(action)) {
      const taskAuthorization = agentActionAuthorization("agent-v1", action);
      const principal = await requireManagementOrPrivilegedAgent(request, db, {
        managementScope: "task.manage",
        agentScope: "task.manage",
        allowedRoles: ["administrator", "super_admin"],
        agentActionId: taskAuthorization?.actionId,
      });
      if (principal.kind === "management") assertManagementWrite(request);
      const effectiveCommandId = principal.kind === "agent"
        ? requiredText(commandId, "commandId", 160)
        : commandId || `manager-command-${crypto.randomUUID()}`;
      const actionArticleId = action === "create_task"
        ? requiredText(payload.articleId, "articleId", 120)
        : String((await taskRow(db, requiredText(payload.taskId, "taskId", 120))).article_id);
      if (principal.kind === "agent" && !principal.articleIds.includes("*") && !principal.articleIds.includes(actionArticleId)) {
        throw new AgentApiError("OBJECT_SCOPE_DENIED", "Agent Key 不包含此文章", 403);
      }
      const result = await withReceipt(db, action, principal.actorId, effectiveCommandId, payload, async (inputSha256) => {
        if (action === "create_task") return createTask(db, payload, effectiveCommandId, inputSha256, principal);
        if (action === "update_task") return updateTask(db, payload, effectiveCommandId, inputSha256, principal);
        if (action === "cancel_task") return cancelTask(db, payload, effectiveCommandId, inputSha256, principal);
        throw new AgentApiError("UNKNOWN_ACTION", `未知管理员动作：${action}`, 404);
      });
      return jsonSuccess(id, result.data, result.status);
    }
    const decisionScope = PRIVILEGED_DECISION_ACTION_SCOPES[
      action as keyof typeof PRIVILEGED_DECISION_ACTION_SCOPES
    ];
    if (decisionScope) {
      // A v3 snapshot must name this exact wire action.  The scope alone is
      // deliberately insufficient: a signed decision capability is action-
      // addressable and must not be widened by a later handler change.
      const decisionAuthorization = agentActionAuthorization("agent-v1", action);
      const principal = await requireManagementOrPrivilegedAgent(request, db, {
        managementScope: "task.manage",
        agentScope: decisionScope,
        allowedRoles: ["super_admin"],
        localOnly: true,
        agentActionId: decisionAuthorization?.actionId,
      });
      if (principal.kind === "management") assertManagementWrite(request);
      const effectiveCommandId = principal.kind === "agent"
        ? requiredText(commandId, "commandId", 160)
        : commandId || `manager-command-${crypto.randomUUID()}`;
      const result = await withReceipt(
        db,
        action,
        principal.actorId,
        effectiveCommandId,
        payload,
        async (inputSha256) => {
          if (action === "decide_approval") {
            return decideApproval(db, payload, effectiveCommandId, inputSha256, principal);
          }
          if (action === "decide_graph_proposal") {
            return decideGraphProposal(db, payload, effectiveCommandId, inputSha256, principal);
          }
          throw new AgentApiError("UNKNOWN_ACTION", `未知超级管理员动作：${action}`, 404);
        },
      );
      return jsonSuccess(id, result.data, result.status);
    }
    if (MANAGEMENT_ACTIONS.has(action)) {
      const managementScope = action === "issue_client" ? "token.issue"
        : action === "revoke_client" ? "token.revoke"
          : "task.manage";
      const principal = await requireManagementOrPrivilegedAgent(request, db, {
        managementScope, agentScope: "site.full_control", allowedRoles: ["super_admin"], localOnly: true,
      });
      if (principal.kind === "management") assertManagementWrite(request);
      if (action === "issue_client") {
        const issueCommandId = requiredText(commandId, "commandId", 160);
        const result = await withReceipt(
          db,
          action,
          principal.actorId,
          issueCommandId,
          payload,
          async () => issueClient(db, payload, principal.kind === "management"
            ? principal.management
            : { authBasis: "site_full_control_key", sourceClientId: principal.clientId, sourceExpiresAt: principal.sourceExpiresAt }),
        );
        return jsonSuccess(id, result.data, result.status ?? 200);
      }
      const managerCommandId = commandId || `manager-command-${crypto.randomUUID()}`;
      const result = await withReceipt(db, action, principal.actorId, managerCommandId, payload, async (inputSha256) => {
        if (action === "revoke_client") return revokeClient(db, payload, managerCommandId, inputSha256, principal.actorId);
        throw new AgentApiError("UNKNOWN_ACTION", `未知管理动作：${action}`, 404);
      });
      return jsonSuccess(id, result.data, result.status);
    }
    const scope = AGENT_ACTION_SCOPES[action as keyof typeof AGENT_ACTION_SCOPES];
    if (!scope) throw new AgentApiError("UNKNOWN_ACTION", `未知 Agent 动作：${action}`, 404);
    const rootManagementScope = ROOT_AGENT_ACTION_MANAGEMENT_SCOPES[action as keyof typeof ROOT_AGENT_ACTION_MANAGEMENT_SCOPES];
    const auth = await authenticateClient(db, request, scope, rootManagementScope);
    requireScope(auth, scope);
    const requiredCommandId = requiredText(commandId, "commandId", 160);
    const result = await withReceipt(db, action, auth.id, requiredCommandId, payload, async (inputSha256) => {
      if (action === "claim") return claimTask(db, auth, payload, requiredCommandId, inputSha256);
      if (action === "heartbeat") return heartbeatTask(db, auth, payload, requiredCommandId, inputSha256);
      if (action === "progress") return progressTask(db, auth, payload, requiredCommandId, inputSha256);
      if (action === "add_artifact") return addArtifact(db, auth, payload, requiredCommandId, inputSha256);
      if (action === "propose_revision") return proposeRevision(db, auth, payload, requiredCommandId, inputSha256);
      if (action === "propose_package_patch") return proposePackagePatch(db, auth, payload, requiredCommandId, inputSha256);
      if (action === "await_human") return awaitHuman(db, auth, payload, requiredCommandId, inputSha256);
      if (action === "complete") return completeTask(db, auth, payload, requiredCommandId, inputSha256);
      if (action === "fail") return endAttempt(db, auth, payload, requiredCommandId, inputSha256, "failed");
      if (action === "release") return endAttempt(db, auth, payload, requiredCommandId, inputSha256, "released");
      if (action === "create_graph_proposal") return createGraphProposal(db, auth, payload, requiredCommandId, inputSha256);
      throw new AgentApiError("UNKNOWN_ACTION", `未知 Agent 动作：${action}`, 404);
    });
    if (action === "claim") {
      if (!isObject(result.data.lease)) throw new AgentApiError("CLAIM_RECEIPT_INVALID", "claim 回执缺少租约对象", 500);
      const leaseId = requiredText(result.data.lease.id, "lease.id", 120);
      result.data = {
        ...result.data,
        lease: { ...result.data.lease, leaseToken: await deriveLeaseToken(auth.token, leaseId) },
      };
    }
    return jsonSuccess(id, result.data, result.status);
  } catch (error) {
    return jsonError(id, error);
  }
}
