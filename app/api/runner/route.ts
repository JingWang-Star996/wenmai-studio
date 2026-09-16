import { env } from "cloudflare:workers";
import { ManagementAuthError } from "../../management-auth-core";
import { requireManagementSession } from "../../management-auth";

type D1Row = Record<string, string | number | null>;

const SHA256_RE = /^[a-f0-9]{64}$/;
const AGENT_RUN_ID_RE = /^agent-run-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const RUNNER_ACTIONS = new Set(["text-gates"]);
const TERMINAL_AGENT_STATES = new Set(["succeeded", "failed", "cancelled"]);
const LEASE_SECONDS = 30;

class RunnerApiError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

function database() {
  if (!env.DB) throw new RunnerApiError("本地工作区数据库尚未连接", 503);
  return env.DB;
}

async function ensureRunnerSchema() {
  const db = database();
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS runner_registry (
      id TEXT PRIMARY KEY NOT NULL,
      label TEXT NOT NULL,
      token_sha256 TEXT NOT NULL,
      capabilities_json TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
      last_seen_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      revoked_at TEXT
    )`),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_runner_registry_status_seen ON runner_registry(status, last_seen_at)"),
    db.prepare(`CREATE TABLE IF NOT EXISTS agent_runs (
      id TEXT PRIMARY KEY NOT NULL,
      production_run_id TEXT NOT NULL,
      production_step_id TEXT NOT NULL,
      recipe_id TEXT NOT NULL,
      recipe_version TEXT NOT NULL,
      recipe_sha256 TEXT NOT NULL,
      article_id TEXT NOT NULL,
      branch_id TEXT NOT NULL,
      frozen_revision_id TEXT NOT NULL,
      frozen_title TEXT NOT NULL DEFAULT '',
      input_sha256 TEXT NOT NULL,
      permission_snapshot_json TEXT NOT NULL DEFAULT '{}',
      state TEXT NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'running', 'awaiting_human', 'partial', 'succeeded', 'failed', 'cancelled')),
      requested_by TEXT NOT NULL DEFAULT 'user',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      started_at TEXT,
      finished_at TEXT,
      last_heartbeat_at TEXT
    )`),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_agent_runs_article_state ON agent_runs(article_id, state, created_at)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_agent_runs_production_step ON agent_runs(production_run_id, production_step_id)"),
    db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_runs_active_production_step ON agent_runs(production_run_id, production_step_id) WHERE state IN ('queued', 'running')"),
    db.prepare(`CREATE TABLE IF NOT EXISTS agent_steps (
      id TEXT PRIMARY KEY NOT NULL,
      agent_run_id TEXT NOT NULL,
      recipe_step_id TEXT NOT NULL,
      attempt INTEGER NOT NULL DEFAULT 1,
      runner_action TEXT NOT NULL,
      agent_role TEXT,
      state TEXT NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'leased', 'running', 'succeeded', 'failed', 'cancelled')),
      assigned_runner_id TEXT,
      lease_id TEXT,
      terminal_command_id TEXT,
      input_json TEXT NOT NULL,
      input_sha256 TEXT NOT NULL,
      output_sha256 TEXT,
      error_class TEXT,
      error_summary TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      started_at TEXT,
      finished_at TEXT,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_steps_run_step_attempt ON agent_steps(agent_run_id, recipe_step_id, attempt)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_agent_steps_state_action ON agent_steps(state, runner_action, created_at)"),
    db.prepare(`CREATE TABLE IF NOT EXISTS agent_artifacts (
      id TEXT PRIMARY KEY NOT NULL,
      agent_step_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      content_ref TEXT NOT NULL,
      sha256 TEXT NOT NULL,
      media_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      payload_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_agent_artifacts_step_created ON agent_artifacts(agent_step_id, created_at)"),
    db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_artifacts_step_kind_sha ON agent_artifacts(agent_step_id, kind, sha256)"),
    db.prepare(`CREATE TABLE IF NOT EXISTS runner_leases (
      id TEXT PRIMARY KEY NOT NULL,
      agent_step_id TEXT NOT NULL,
      runner_id TEXT NOT NULL,
      lease_token_sha256 TEXT NOT NULL,
      leased_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      heartbeat_at TEXT NOT NULL,
      heartbeat_seq INTEGER NOT NULL DEFAULT 0,
      revoked_at TEXT
    )`),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_runner_leases_step_active ON runner_leases(agent_step_id, revoked_at)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_runner_leases_expiry ON runner_leases(expires_at, revoked_at)"),
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
  const stepColumns = await db.prepare("PRAGMA table_info(agent_steps)").all<D1Row>();
  if (!stepColumns.results.some((column) => column.name === "terminal_command_id")) {
    await db.prepare("ALTER TABLE agent_steps ADD COLUMN terminal_command_id TEXT").run();
  }
  const leaseColumns = await db.prepare("PRAGMA table_info(runner_leases)").all<D1Row>();
  if (!leaseColumns.results.some((column) => column.name === "heartbeat_seq")) {
    await db.prepare("ALTER TABLE runner_leases ADD COLUMN heartbeat_seq INTEGER NOT NULL DEFAULT 0").run();
  }
  const runColumns = await db.prepare("PRAGMA table_info(agent_runs)").all<D1Row>();
  if (!runColumns.results.some((column) => column.name === "frozen_title")) {
    await db.prepare("ALTER TABLE agent_runs ADD COLUMN frozen_title TEXT NOT NULL DEFAULT ''").run();
    await db.prepare(`UPDATE agent_runs SET frozen_title = COALESCE((
      SELECT json_extract(step.input_json, '$.title') FROM agent_steps step
      WHERE step.agent_run_id = agent_runs.id ORDER BY step.attempt LIMIT 1
    ), '') WHERE frozen_title = ''`).run();
  }
  return db;
}

function cleanText(value: unknown, maximum: number, preserveWhitespace = false): string {
  if (typeof value !== "string") return "";
  const text = preserveWhitespace ? value.replace(/\r\n?/g, "\n") : value.trim();
  if (text.length > maximum) throw new RunnerApiError(`输入超过 ${maximum.toLocaleString("zh-CN")} 个字符`);
  return text;
}

function requiredText(value: unknown, label: string, maximum: number, preserveWhitespace = false): string {
  const text = cleanText(value, maximum, preserveWhitespace);
  if (!text) throw new RunnerApiError(`缺少${label}`);
  return text;
}

function optionalExpectedAgentRunId(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const id = requiredText(value, "预期 AgentRun ID", 120);
  if (!AGENT_RUN_ID_RE.test(id)) throw new RunnerApiError("expectedAgentRunId 必须是严格的 AgentRun ID");
  return id;
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
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalValue(child)]));
  }
  return value;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

async function sha256Text(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function isoNow() {
  return new Date().toISOString();
}

function leaseExpiry() {
  return new Date(Date.now() + LEASE_SECONDS * 1000).toISOString();
}

function assertLocalManagementRequest(request: Request) {
  const requestUrl = new URL(request.url);
  const origin = request.headers.get("origin");
  const fetchSite = request.headers.get("sec-fetch-site");
  if (origin !== requestUrl.origin || (fetchSite && !["same-origin", "none"].includes(fetchSite))) {
    throw new RunnerApiError("Runner 管理动作只接受本地站点的同源请求", 403);
  }
}

function parseRunner(row: D1Row) {
  return {
    id: String(row.id), label: String(row.label), capabilities: parseJson<string[]>(row.capabilities_json, []),
    status: String(row.status), lastSeenAt: row.last_seen_at ? String(row.last_seen_at) : null,
    createdAt: String(row.created_at),
  };
}

function parseArtifact(row: D1Row) {
  return {
    id: String(row.id), agentStepId: String(row.agent_step_id), kind: String(row.kind), title: String(row.title),
    contentRef: String(row.content_ref), sha256: String(row.sha256), mediaType: String(row.media_type),
    sizeBytes: Number(row.size_bytes), payload: parseJson<Record<string, unknown>>(row.payload_json, {}), createdAt: String(row.created_at),
  };
}

function parseStep(row: D1Row, artifacts: D1Row[]) {
  return {
    id: String(row.id), agentRunId: String(row.agent_run_id), recipeStepId: String(row.recipe_step_id), attempt: Number(row.attempt),
    runnerAction: String(row.runner_action), agentRole: row.agent_role ? String(row.agent_role) : null, state: String(row.state),
    assignedRunnerId: row.assigned_runner_id ? String(row.assigned_runner_id) : null,
    inputSha256: String(row.input_sha256), outputSha256: row.output_sha256 ? String(row.output_sha256) : null,
    errorClass: row.error_class ? String(row.error_class) : null, errorSummary: row.error_summary ? String(row.error_summary) : null,
    createdAt: String(row.created_at), startedAt: row.started_at ? String(row.started_at) : null,
    finishedAt: row.finished_at ? String(row.finished_at) : null, updatedAt: String(row.updated_at),
    artifacts: artifacts.filter((artifact) => artifact.agent_step_id === row.id).map(parseArtifact),
  };
}

function parseRun(row: D1Row, steps: D1Row[], artifacts: D1Row[]) {
  return {
    id: String(row.id), productionRunId: String(row.production_run_id), productionStepId: String(row.production_step_id),
    recipeId: String(row.recipe_id), recipeVersion: String(row.recipe_version), recipeSha256: String(row.recipe_sha256),
    articleId: String(row.article_id), branchId: String(row.branch_id), frozenRevisionId: String(row.frozen_revision_id),
    inputSha256: String(row.input_sha256), permissions: parseJson<Record<string, unknown>>(row.permission_snapshot_json, {}),
    state: String(row.state), createdAt: String(row.created_at), startedAt: row.started_at ? String(row.started_at) : null,
    finishedAt: row.finished_at ? String(row.finished_at) : null,
    lastHeartbeatAt: row.last_heartbeat_at ? String(row.last_heartbeat_at) : null,
    steps: steps.filter((step) => step.agent_run_id === row.id).map((step) => parseStep(step, artifacts)),
  };
}

async function workspaceReady(db: D1Database) {
  const row = await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'production_run_steps'").first<D1Row>();
  if (!row) throw new RunnerApiError("请先打开一次文脉工作台，让本地工作区完成初始化", 503);
}

async function appendWorkspaceEvent(
  db: D1Database,
  eventType: string,
  subjectType: string,
  subjectId: string,
  articleId: string | null,
  payload: Record<string, unknown>,
  inputSha256: string,
) {
  const ready = await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'workspace_events'").first<D1Row>();
  if (!ready) return null;
  return db.prepare(`INSERT INTO workspace_events
    (id, event_type, subject_type, subject_id, article_id, payload_json, input_sha256)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .bind(`event-${crypto.randomUUID()}`, eventType, subjectType, subjectId, articleId, JSON.stringify(payload), inputSha256);
}

async function authenticateRunner(db: D1Database, request: Request, payload: Record<string, unknown>) {
  const runnerId = requiredText(payload.runnerId, "Runner ID", 120);
  const token = requiredText(request.headers.get("x-wenmai-runner-token"), "Runner token", 500);
  const tokenSha256 = await sha256Text(token);
  const runner = await db.prepare("SELECT * FROM runner_registry WHERE id = ? AND status = 'active' LIMIT 1")
    .bind(runnerId).first<D1Row>();
  if (!runner || runner.token_sha256 !== tokenSha256) throw new RunnerApiError("Runner 身份验证失败", 401);
  const seenAt = isoNow();
  await db.prepare("UPDATE runner_registry SET last_seen_at = ? WHERE id = ?").bind(seenAt, runnerId).run();
  return { runner, runnerId, capabilities: parseJson<string[]>(runner.capabilities_json, []) };
}

async function recoverExpiredLeases(db: D1Database, expectedAgentRunId: string | null = null) {
  const expired = await db.prepare(`SELECT lease.*, step.agent_run_id, step.recipe_step_id, step.attempt
    FROM runner_leases lease JOIN agent_steps step ON step.id = lease.agent_step_id
    WHERE lease.revoked_at IS NULL AND lease.expires_at <= ? AND step.state IN ('leased', 'running')
      AND (? IS NULL OR step.agent_run_id = ?)
    ORDER BY lease.expires_at LIMIT 50`).bind(isoNow(), expectedAgentRunId, expectedAgentRunId).all<D1Row>();
  let recovered = 0;
  for (const lease of expired.results) {
    const oldStepId = String(lease.agent_step_id);
    const newStepId = `agent-step-${crypto.randomUUID()}`;
    const nextAttempt = Number(lease.attempt) + 1;
    try {
      const recoveredAt = isoNow();
      const results = await db.batch([
        db.prepare(`UPDATE agent_steps SET state = 'failed', error_class = 'lease_expired',
          error_summary = 'Runner 心跳过期，已保留旧 attempt 并排入恢复 attempt', finished_at = ?, updated_at = ?
          WHERE id = ? AND lease_id = ? AND state IN ('leased', 'running')
            AND EXISTS (SELECT 1 FROM runner_leases WHERE id = ? AND revoked_at IS NULL AND expires_at <= ?)`)
          .bind(recoveredAt, recoveredAt, oldStepId, lease.id, lease.id, recoveredAt),
        db.prepare(`UPDATE runner_leases SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL
          AND EXISTS (SELECT 1 FROM agent_steps WHERE id = ? AND state = 'failed'
            AND error_class = 'lease_expired' AND finished_at = ?)`)
          .bind(recoveredAt, lease.id, oldStepId, recoveredAt),
        db.prepare(`INSERT INTO agent_steps
          (id, agent_run_id, recipe_step_id, attempt, runner_action, agent_role, state, input_json, input_sha256)
          SELECT ?, agent_run_id, recipe_step_id, ?, runner_action, agent_role, 'queued', input_json, input_sha256
          FROM agent_steps WHERE id = ? AND state = 'failed' AND error_class = 'lease_expired' AND finished_at = ?`)
          .bind(newStepId, nextAttempt, oldStepId, recoveredAt),
        db.prepare(`UPDATE agent_runs SET state = 'queued', finished_at = NULL, last_heartbeat_at = ?
          WHERE id = ? AND EXISTS (SELECT 1 FROM agent_steps WHERE id = ? AND state = 'queued')`)
          .bind(recoveredAt, lease.agent_run_id, newStepId),
      ]);
      if (Number(results[0].meta.changes ?? 0) === 1 && Number(results[2].meta.changes ?? 0) === 1) recovered += 1;
    } catch {
      // Another runner can win the recovery race; the unique attempt index
      // prevents a second recovery attempt from being created.
    }
  }
  return recovered;
}

async function issueRunnerToken(db: D1Database, payload: Record<string, unknown>) {
  const label = cleanText(payload.label, 120) || "本地 Runner";
  const requested = Array.isArray(payload.capabilities) ? payload.capabilities.map(String) : ["text-gates"];
  const capabilities = [...new Set(requested.filter((item) => RUNNER_ACTIONS.has(item)))];
  if (!capabilities.length) throw new RunnerApiError("至少选择一项受允许的 Runner 能力");
  const runnerId = `runner-${crypto.randomUUID()}`;
  const token = `wenmai_${crypto.randomUUID().replaceAll("-", "")}_${crypto.randomUUID().replaceAll("-", "")}`;
  await db.prepare(`INSERT INTO runner_registry
    (id, label, token_sha256, capabilities_json) VALUES (?, ?, ?, ?)`)
    .bind(runnerId, label, await sha256Text(token), JSON.stringify(capabilities)).run();
  return Response.json({ runnerId, token, capabilities, shownOnce: true }, { status: 201 });
}

async function revokeRunner(db: D1Database, payload: Record<string, unknown>) {
  const runnerId = requiredText(payload.runnerId, "Runner ID", 120);
  const now = isoNow();
  const activeLeases = await db.prepare(`SELECT lease.id, lease.agent_step_id, step.agent_run_id
    FROM runner_leases lease JOIN agent_steps step ON step.id = lease.agent_step_id
    WHERE lease.runner_id = ? AND lease.revoked_at IS NULL AND step.state IN ('leased', 'running')`)
    .bind(runnerId).all<D1Row>();
  const statements = [
    db.prepare("UPDATE runner_registry SET status = 'revoked', revoked_at = ? WHERE id = ? AND status = 'active'")
      .bind(now, runnerId),
  ];
  for (const lease of activeLeases.results) {
    statements.push(
      db.prepare(`UPDATE agent_steps SET state = 'queued', assigned_runner_id = NULL, lease_id = NULL,
        started_at = NULL, updated_at = ? WHERE id = ? AND lease_id = ? AND state IN ('leased', 'running')
        AND EXISTS (SELECT 1 FROM runner_registry WHERE id = ? AND status = 'revoked' AND revoked_at = ?)`)
        .bind(now, lease.agent_step_id, lease.id, runnerId, now),
      db.prepare(`UPDATE runner_leases SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL
        AND EXISTS (SELECT 1 FROM agent_steps WHERE id = ? AND state = 'queued' AND lease_id IS NULL AND updated_at = ?)`)
        .bind(now, lease.id, lease.agent_step_id, now),
      db.prepare(`UPDATE agent_runs SET state = 'queued', started_at = NULL, finished_at = NULL, last_heartbeat_at = ?
        WHERE id = ? AND EXISTS (SELECT 1 FROM agent_steps WHERE id = ? AND state = 'queued' AND updated_at = ?)`)
        .bind(now, lease.agent_run_id, lease.agent_step_id, now),
    );
  }
  const results = await db.batch(statements);
  if (Number(results[0].meta.changes ?? 0) !== 1) throw new RunnerApiError("Runner 不存在或已经撤销", 404);
  return Response.json({ runnerId, status: "revoked" });
}

async function queueAgentStep(db: D1Database, payload: Record<string, unknown>) {
  await workspaceReady(db);
  const productionRunId = requiredText(payload.productionRunId, "生产运行 ID", 120);
  const productionStepId = requiredText(payload.productionStepId, "生产工位 ID", 120);
  const [run, step] = await Promise.all([
    db.prepare("SELECT * FROM production_runs WHERE id = ? LIMIT 1").bind(productionRunId).first<D1Row>(),
    db.prepare("SELECT * FROM production_run_steps WHERE run_id = ? AND step_id = ? LIMIT 1")
      .bind(productionRunId, productionStepId).first<D1Row>(),
  ]);
  if (!run || !step) throw new RunnerApiError("生产运行或工位不存在", 404);
  const runnerAction = step.runner_action ? String(step.runner_action) : "";
  if (!RUNNER_ACTIONS.has(runnerAction)) throw new RunnerApiError("该工位没有受允许的本地 Runner 入口", 409);
  if (String(step.status) !== "active") throw new RunnerApiError("只有依赖已满足的 active 工位才能排入 Runner", 409);
  const existing = await db.prepare(`SELECT id FROM agent_runs
    WHERE production_run_id = ? AND production_step_id = ? AND state IN ('queued', 'running') LIMIT 1`)
    .bind(productionRunId, productionStepId).first<D1Row>();
  if (existing) throw new RunnerApiError("该工位已经有等待或运行中的 AgentRun", 409);
  const [branch, copy] = await Promise.all([
    db.prepare("SELECT * FROM article_branches WHERE id = ? AND article_id = ? AND status = 'active' LIMIT 1")
      .bind(run.branch_id, run.article_id).first<D1Row>(),
    db.prepare("SELECT * FROM branch_working_copies WHERE branch_id = ? LIMIT 1").bind(run.branch_id).first<D1Row>(),
  ]);
  if (!branch || !copy || branch.head_revision_id !== copy.base_revision_id) {
    throw new RunnerApiError("分支头与工作副本基线不一致，不能冻结 Runner 输入", 409);
  }
  const input = {
    runnerAction,
    articleId: String(run.article_id),
    branchId: String(run.branch_id),
    baseRevisionId: String(copy.base_revision_id),
    title: String(copy.title),
    bodyText: String(copy.body_text ?? ""),
    bodySha256: String(copy.body_sha256),
  };
  const inputJson = canonicalJson(input);
  const inputSha256 = await sha256Text(inputJson);
  const agentRunId = `agent-run-${crypto.randomUUID()}`;
  const agentStepId = `agent-step-${crypto.randomUUID()}`;
  const permissions = {
    read: [`branch-working-copy:${String(run.branch_id)}`],
    write: ["agent-artifact"],
    branchWrite: false,
    sourceCorpusWrite: false,
    externalSideEffects: false,
  };
  const event = await appendWorkspaceEvent(db, "agent_run.queued", "agent_run", agentRunId, String(run.article_id), {
    productionRunId, productionStepId, runnerAction, permissionSnapshot: permissions,
  }, inputSha256);
  const statements = [
    db.prepare(`INSERT INTO agent_runs
      (id, production_run_id, production_step_id, recipe_id, recipe_version, recipe_sha256,
       article_id, branch_id, frozen_revision_id, frozen_title, input_sha256, permission_snapshot_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(
        agentRunId, productionRunId, productionStepId, run.recipe_id, run.recipe_version, run.recipe_sha256,
        run.article_id, run.branch_id, copy.base_revision_id, copy.title, inputSha256, JSON.stringify(permissions),
      ),
    db.prepare(`INSERT INTO agent_steps
      (id, agent_run_id, recipe_step_id, attempt, runner_action, agent_role, input_json, input_sha256)
      VALUES (?, ?, ?, 1, ?, ?, ?, ?)`)
      .bind(agentStepId, agentRunId, productionStepId, runnerAction, step.agent_role ?? step.actor_kind, inputJson, inputSha256),
  ];
  if (event) statements.push(event);
  try {
    await db.batch(statements);
  } catch (error) {
    const raced = await db.prepare(`SELECT id FROM agent_runs
      WHERE production_run_id = ? AND production_step_id = ? AND state IN ('queued', 'running') LIMIT 1`)
      .bind(productionRunId, productionStepId).first<D1Row>();
    if (raced) throw new RunnerApiError("该工位已经有等待或运行中的 AgentRun", 409);
    throw error;
  }
  return Response.json({ agentRunId, agentStepId, state: "queued", inputSha256 }, { status: 201 });
}

async function leaseAgentStep(db: D1Database, request: Request, payload: Record<string, unknown>) {
  const auth = await authenticateRunner(db, request, payload);
  const expectedAgentRunId = optionalExpectedAgentRunId(payload.expectedAgentRunId);
  if (expectedAgentRunId) {
    const expectedRun = await db.prepare("SELECT id FROM agent_runs WHERE id = ? LIMIT 1").bind(expectedAgentRunId).first<D1Row>();
    if (!expectedRun) throw new RunnerApiError("预期 AgentRun 不存在", 404);
  }
  const recoveredAttempts = await recoverExpiredLeases(db, expectedAgentRunId);
  const queued = await db.prepare(`SELECT * FROM agent_steps WHERE state = 'queued'
    AND (? IS NULL OR agent_run_id = ?) ORDER BY created_at LIMIT 100`)
    .bind(expectedAgentRunId, expectedAgentRunId).all<D1Row>();
  const step = queued.results.find((item) => auth.capabilities.includes(String(item.runner_action)));
  if (!step) return Response.json({ job: null, recoveredAttempts });
  const leaseId = `lease-${crypto.randomUUID()}`;
  const leaseToken = `lease_${crypto.randomUUID().replaceAll("-", "")}_${crypto.randomUUID().replaceAll("-", "")}`;
  const leasedAt = isoNow();
  const expiresAt = leaseExpiry();
  const results = await db.batch([
    db.prepare(`UPDATE agent_steps SET state = 'leased', assigned_runner_id = ?, lease_id = ?,
      started_at = COALESCE(started_at, ?), updated_at = ? WHERE id = ? AND state = 'queued'
        AND (? IS NULL OR agent_run_id = ?)
        AND EXISTS (SELECT 1 FROM runner_registry WHERE id = ? AND status = 'active')`)
      .bind(auth.runnerId, leaseId, leasedAt, leasedAt, step.id, expectedAgentRunId, expectedAgentRunId, auth.runnerId),
    db.prepare(`INSERT INTO runner_leases
      (id, agent_step_id, runner_id, lease_token_sha256, leased_at, expires_at, heartbeat_at)
      SELECT ?, id, ?, ?, ?, ?, ? FROM agent_steps WHERE id = ? AND lease_id = ?
        AND (? IS NULL OR agent_run_id = ?)`)
      .bind(leaseId, auth.runnerId, await sha256Text(leaseToken), leasedAt, expiresAt, leasedAt,
        step.id, leaseId, expectedAgentRunId, expectedAgentRunId),
    db.prepare(`UPDATE agent_runs SET state = 'running', started_at = COALESCE(started_at, ?), last_heartbeat_at = ?
      WHERE id = ? AND (? IS NULL OR id = ?)
        AND EXISTS (SELECT 1 FROM agent_steps WHERE id = ? AND lease_id = ?)`)
      .bind(leasedAt, leasedAt, step.agent_run_id, expectedAgentRunId, expectedAgentRunId, step.id, leaseId),
  ]);
  if (Number(results[0].meta.changes ?? 0) !== 1 || Number(results[1].meta.changes ?? 0) !== 1) {
    throw new RunnerApiError("领取竞争已被另一 Runner 赢得，请再次领取", 409);
  }
  return Response.json({
    recoveredAttempts,
    lease: { id: leaseId, token: leaseToken, expiresAt, heartbeatSeconds: 10 },
    job: {
      stepId: String(step.id), agentRunId: String(step.agent_run_id), attempt: Number(step.attempt),
      runnerAction: String(step.runner_action), inputSha256: String(step.input_sha256),
      input: parseJson<Record<string, unknown>>(step.input_json, {}),
    },
  });
}

async function heartbeat(db: D1Database, request: Request, payload: Record<string, unknown>) {
  const auth = await authenticateRunner(db, request, payload);
  const stepId = requiredText(payload.stepId, "Agent Step ID", 120);
  const leaseId = requiredText(payload.leaseId, "租约 ID", 120);
  const leaseToken = requiredText(payload.leaseToken, "租约 token", 500);
  const heartbeatSeq = Number(payload.heartbeatSeq);
  if (!Number.isSafeInteger(heartbeatSeq) || heartbeatSeq < 1) throw new RunnerApiError("heartbeatSeq 必须是递增正整数");
  const leaseTokenSha256 = await sha256Text(leaseToken);
  const now = isoNow();
  const expiresAt = leaseExpiry();
  const results = await db.batch([
    db.prepare(`UPDATE runner_leases SET heartbeat_at = ?, expires_at = ?, heartbeat_seq = ?
      WHERE id = ? AND agent_step_id = ? AND runner_id = ? AND lease_token_sha256 = ?
        AND revoked_at IS NULL AND expires_at > ? AND heartbeat_seq < ?`)
      .bind(now, expiresAt, heartbeatSeq, leaseId, stepId, auth.runnerId, leaseTokenSha256, now, heartbeatSeq),
    db.prepare(`UPDATE agent_steps SET state = 'running', updated_at = ?
      WHERE id = ? AND lease_id = ? AND state IN ('leased', 'running')
        AND EXISTS (SELECT 1 FROM runner_leases WHERE id = ? AND heartbeat_seq = ?
          AND heartbeat_at = ? AND expires_at = ? AND revoked_at IS NULL)`)
      .bind(now, stepId, leaseId, leaseId, heartbeatSeq, now, expiresAt),
    db.prepare(`UPDATE agent_runs SET state = 'running', last_heartbeat_at = ?
      WHERE id = (SELECT agent_run_id FROM agent_steps WHERE id = ?)
        AND EXISTS (SELECT 1 FROM agent_steps WHERE id = ? AND lease_id = ?
          AND state = 'running' AND updated_at = ?)`)
      .bind(now, stepId, stepId, leaseId, now),
  ]);
  if (Number(results[0].meta.changes ?? 0) !== 1 || Number(results[1].meta.changes ?? 0) !== 1) {
    throw new RunnerApiError("心跳租约已过期、序号未递增或工位已经结束", 409);
  }
  return Response.json({ stepId, state: "running", expiresAt });
}

async function inspectCommandReceipt(
  db: D1Database,
  commandId: string,
  commandType: string,
  actorId: string,
  requestSha256: string,
) {
  const existing = await db.prepare("SELECT * FROM command_receipts WHERE id = ? LIMIT 1").bind(commandId).first<D1Row>();
  if (existing) {
    if (existing.command_type !== commandType || existing.actor_id !== actorId || existing.request_sha256 !== requestSha256) {
      throw new RunnerApiError("同一 commandId 已绑定不同请求摘要", 409);
    }
    if (Number(existing.status_code) > 0) {
      return Response.json({ ...parseJson<Record<string, unknown>>(existing.response_json, {}), replayed: true }, { status: Number(existing.status_code) });
    }
  }
  return null;
}

async function completeStep(db: D1Database, request: Request, payload: Record<string, unknown>) {
  const auth = await authenticateRunner(db, request, payload);
  const stepId = requiredText(payload.stepId, "Agent Step ID", 120);
  const leaseId = requiredText(payload.leaseId, "租约 ID", 120);
  const leaseToken = requiredText(payload.leaseToken, "租约 token", 500);
  const commandId = requiredText(payload.commandId, "commandId", 160);
  const outputText = requiredText(payload.outputText, "输出工件", 500_000, true);
  const outputPayload = parseJson<Record<string, unknown> | null>(outputText, null);
  if (!outputPayload || Array.isArray(outputPayload)) throw new RunnerApiError("Runner 输出必须是 JSON 对象");
  const outputSha256 = requiredText(payload.outputSha256, "输出摘要", 64);
  if (!SHA256_RE.test(outputSha256) || await sha256Text(outputText) !== outputSha256) {
    throw new RunnerApiError("输出摘要与工件正文不一致", 409);
  }
  const contentRefInput = cleanText(payload.contentRef, 1000);
  if (contentRefInput && (!contentRefInput.startsWith(".runner/") || contentRefInput.includes("..") || /^[A-Za-z]:|^[\\/]/.test(contentRefInput))) {
    throw new RunnerApiError("contentRef 只能引用项目内 .runner/ 下的相对工件路径");
  }
  const artifactTitle = cleanText(payload.title, 240) || "text-gates 输出";
  const mediaType = cleanText(payload.mediaType, 120) || "application/json";
  const requestSha256 = await sha256Text(canonicalJson({ stepId, leaseId, outputSha256, contentRefInput, artifactTitle, mediaType }));
  const replay = await inspectCommandReceipt(db, commandId, "runner.complete", auth.runnerId, requestSha256);
  if (replay) return replay;
  const step = await db.prepare("SELECT * FROM agent_steps WHERE id = ? LIMIT 1").bind(stepId).first<D1Row>();
  if (!step) throw new RunnerApiError("Agent Step 不存在", 404);
  const run = await db.prepare("SELECT * FROM agent_runs WHERE id = ? LIMIT 1").bind(step.agent_run_id).first<D1Row>();
  if (!run) throw new RunnerApiError("AgentRun 不存在", 404);
  const frozenInput = parseJson<Record<string, unknown>>(step.input_json, {});
  const gates = Array.isArray(outputPayload.gates) ? outputPayload.gates : [];
  const allowedGateIds = new Set(["builtin:title-v1", "builtin:structure-v1", "builtin:long-sentence-v1", "builtin:placeholder-v1"]);
  const observedGateIds = new Set(gates.map((gate) => gate && typeof gate === "object" ? String((gate as Record<string, unknown>).gateId ?? "") : ""));
  const gateResults = gates.map((gate) => String((gate as Record<string, unknown>).result ?? ""));
  const observedSummary = outputPayload.summary && typeof outputPayload.summary === "object" && !Array.isArray(outputPayload.summary)
    ? outputPayload.summary as Record<string, unknown>
    : {};
  const expectedSummary = {
    pass: gateResults.filter((result) => result === "pass").length,
    fail: gateResults.filter((result) => result === "fail").length,
    inconclusive: gateResults.filter((result) => result === "inconclusive").length,
    total: gates.length,
  };
  const gatesValid = gates.length === allowedGateIds.size
    && [...allowedGateIds].every((gateId) => observedGateIds.has(gateId))
    && gates.every((gate) => gate && typeof gate === "object"
      && ["pass", "fail", "inconclusive"].includes(String((gate as Record<string, unknown>).result ?? ""))
      && Array.isArray((gate as Record<string, unknown>).evidence)
      && ((gate as Record<string, unknown>).evidence as unknown[]).every((item) => typeof item === "string")
      && Boolean((gate as Record<string, unknown>).details)
      && typeof (gate as Record<string, unknown>).details === "object")
    && Object.entries(expectedSummary).every(([key, value]) => Number(observedSummary[key]) === value);
  const expectedAggregate = expectedSummary.fail > 0 ? "fail" : expectedSummary.inconclusive > 0 ? "inconclusive" : "pass";
  if (outputPayload.schemaVersion !== "wenmai.text-gates/1.0"
    || outputPayload.action !== String(step.runner_action)
    || outputPayload.inputSha256 !== String(step.input_sha256)
    || outputPayload.result !== expectedAggregate
    || outputPayload.articleId !== String(run.article_id)
    || outputPayload.branchId !== String(run.branch_id)
    || outputPayload.baseRevisionId !== String(run.frozen_revision_id)
    || outputPayload.bodySha256 !== String(frozenInput.bodySha256 ?? "")
    || !gatesValid) {
    throw new RunnerApiError("Runner 输出没有绑定当前 action、输入摘要或门禁清单", 422);
  }
  const artifactId = `agent-artifact-${(await sha256Text(commandId)).slice(0, 48)}`;
  const contentRef = contentRefInput || `.runner/artifacts/${artifactId}.json`;
  const eventId = `event-runner-complete-${(await sha256Text(commandId)).slice(0, 40)}`;
  const leaseTokenSha256 = await sha256Text(leaseToken);
  const now = isoNow();
  const productionStep = await db.prepare("SELECT * FROM production_run_steps WHERE run_id = ? AND step_id = ? LIMIT 1")
    .bind(run.production_run_id, run.production_step_id).first<D1Row>();
  const productionEvidence = productionStep ? parseJson<string[]>(productionStep.evidence_json, []) : [];
  productionEvidence.push(`Runner ${auth.runnerId} 生成 ${contentRef} · sha256:${outputSha256}`);
  const currentResponse = { stepId, agentRunId: String(run.id), state: "succeeded", runState: "succeeded", artifactId, outputSha256, inputStillCurrent: true };
  const staleResponse = { ...currentResponse, runState: "partial", inputStillCurrent: false };
  const statements = [
    db.prepare(`INSERT INTO command_receipts
      (id, command_type, actor_id, request_sha256, response_json, status_code)
      VALUES (?, 'runner.complete', ?, ?, '{}', 0)
      ON CONFLICT(id) DO UPDATE SET status_code = CASE
        WHEN command_type = excluded.command_type AND actor_id = excluded.actor_id
          AND request_sha256 = excluded.request_sha256 THEN command_receipts.status_code
        ELSE NULL END`)
      .bind(commandId, auth.runnerId, requestSha256),
    db.prepare(`UPDATE agent_steps SET state = 'succeeded', output_sha256 = ?, finished_at = ?, updated_at = ?
      , terminal_command_id = ?
      WHERE id = ? AND lease_id = ? AND assigned_runner_id = ? AND state IN ('leased', 'running')
        AND EXISTS (SELECT 1 FROM command_receipts WHERE id = ? AND command_type = 'runner.complete'
          AND actor_id = ? AND request_sha256 = ? AND status_code = 0)
        AND EXISTS (SELECT 1 FROM runner_leases WHERE id = ? AND agent_step_id = ? AND runner_id = ?
          AND lease_token_sha256 = ? AND revoked_at IS NULL AND expires_at > ?)`)
      .bind(outputSha256, now, now, commandId, stepId, leaseId, auth.runnerId, commandId, auth.runnerId, requestSha256,
        leaseId, stepId, auth.runnerId, leaseTokenSha256, now),
    db.prepare(`INSERT INTO agent_artifacts
      (id, agent_step_id, kind, title, content_ref, sha256, media_type, size_bytes, payload_json)
      SELECT ?, id, 'runner-output', ?, ?, ?, ?, ?, ? FROM agent_steps
      WHERE id = ? AND state = 'succeeded' AND terminal_command_id = ? AND output_sha256 = ?`)
      .bind(artifactId, artifactTitle, contentRef, outputSha256, mediaType,
        new TextEncoder().encode(outputText).byteLength, outputText, stepId, commandId, outputSha256),
    db.prepare(`UPDATE runner_leases SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL
      AND EXISTS (SELECT 1 FROM agent_steps WHERE id = ? AND terminal_command_id = ? AND state = 'succeeded')
      AND EXISTS (SELECT 1 FROM agent_artifacts WHERE id = ?)`)
      .bind(now, leaseId, stepId, commandId, artifactId),
    db.prepare(`UPDATE agent_runs SET state = CASE WHEN EXISTS (
        SELECT 1 FROM branch_working_copies copy JOIN article_branches branch ON branch.id = copy.branch_id
        WHERE copy.branch_id = agent_runs.branch_id AND copy.body_sha256 = ? AND copy.title = agent_runs.frozen_title
          AND copy.base_revision_id = agent_runs.frozen_revision_id
          AND branch.head_revision_id = agent_runs.frozen_revision_id
      ) THEN 'succeeded' ELSE 'partial' END,
      finished_at = ?, last_heartbeat_at = ?
      WHERE id = ? AND EXISTS (SELECT 1 FROM agent_artifacts WHERE id = ?)`)
      .bind(String(parseJson<Record<string, unknown>>(step.input_json, {}).bodySha256 ?? ""), now, now, run.id, artifactId),
  ];
  if (productionStep) {
    statements.push(db.prepare(`UPDATE production_run_steps SET status = 'complete', evidence_json = ?, updated_at = ?
      WHERE run_id = ? AND step_id = ? AND status = 'active'
        AND EXISTS (SELECT 1 FROM agent_artifacts WHERE id = ?)
        AND EXISTS (SELECT 1 FROM agent_runs ar JOIN branch_working_copies copy ON copy.branch_id = ar.branch_id
          JOIN article_branches branch ON branch.id = ar.branch_id
          WHERE ar.id = ? AND ar.state = 'succeeded' AND copy.base_revision_id = ar.frozen_revision_id
            AND copy.title = ar.frozen_title
            AND branch.head_revision_id = ar.frozen_revision_id)`)
      .bind(JSON.stringify(productionEvidence), now, run.production_run_id, run.production_step_id, artifactId, run.id));
    statements.push(db.prepare(`UPDATE production_run_steps AS candidate SET status = 'active', updated_at = ?
      WHERE candidate.run_id = ? AND candidate.status = 'pending'
        AND NOT EXISTS (
          SELECT 1 FROM json_each(candidate.depends_on_json) dependency
          WHERE NOT EXISTS (
            SELECT 1 FROM production_run_steps upstream
            WHERE upstream.run_id = candidate.run_id AND upstream.step_id = dependency.value
              AND upstream.status IN ('complete', 'skipped')
          )
        )`).bind(now, run.production_run_id));
    statements.push(db.prepare(`UPDATE production_runs SET
      status = CASE WHEN NOT EXISTS (
        SELECT 1 FROM production_run_steps WHERE run_id = ? AND status NOT IN ('complete', 'skipped')
      ) THEN 'complete' ELSE 'active' END,
      current_step_id = (
        SELECT step_id FROM production_run_steps WHERE run_id = ? AND status = 'active' ORDER BY position LIMIT 1
      ), updated_at = ? WHERE id = ? AND EXISTS (SELECT 1 FROM agent_artifacts WHERE id = ?)`)
      .bind(run.production_run_id, run.production_run_id, now, run.production_run_id, artifactId));
  }
  statements.push(
    db.prepare(`UPDATE command_receipts SET response_json = CASE
        WHEN (SELECT state FROM agent_runs WHERE id = ?) = 'succeeded' THEN ? ELSE ? END,
      status_code = 200, completed_at = ?
      WHERE id = ? AND status_code = 0 AND EXISTS (SELECT 1 FROM agent_artifacts WHERE id = ?)
        AND EXISTS (SELECT 1 FROM agent_steps WHERE id = ? AND terminal_command_id = ? AND state = 'succeeded')`)
      .bind(run.id, JSON.stringify(currentResponse), JSON.stringify(staleResponse), now, commandId, artifactId, stepId, commandId),
    db.prepare(`INSERT INTO workspace_events
      (id, event_type, subject_type, subject_id, article_id, payload_json, input_sha256)
      SELECT ?, 'agent_step.completed', 'agent_run', ?, ?, receipt.response_json,
        CASE WHEN receipt.status_code = 200
          AND EXISTS (SELECT 1 FROM agent_artifacts WHERE id = ?)
          AND EXISTS (SELECT 1 FROM agent_steps WHERE id = ? AND terminal_command_id = ? AND state = 'succeeded')
          THEN ? ELSE NULL END
      FROM command_receipts receipt WHERE receipt.id = ?`)
      .bind(eventId, run.id, run.article_id, artifactId, stepId, commandId, run.input_sha256, commandId),
  );
  try {
    await db.batch(statements);
  } catch (error) {
    const completed = await inspectCommandReceipt(db, commandId, "runner.complete", auth.runnerId, requestSha256);
    if (completed) return completed;
    const latestStep = await db.prepare("SELECT state, lease_id, terminal_command_id FROM agent_steps WHERE id = ? LIMIT 1")
      .bind(stepId).first<D1Row>();
    if (latestStep && TERMINAL_AGENT_STATES.has(String(latestStep.state))) {
      throw new RunnerApiError("该 Agent Step 已由另一条终态命令完成", 409);
    }
    if (error instanceof RunnerApiError) throw error;
    throw new RunnerApiError("完成回调未通过租约、幂等或工件原子断言", 409);
  }
  const savedReceipt = await db.prepare("SELECT response_json, status_code FROM command_receipts WHERE id = ? LIMIT 1")
    .bind(commandId).first<D1Row>();
  if (!savedReceipt || Number(savedReceipt.status_code) !== 200) throw new RunnerApiError("完成回执缺失", 503);
  return Response.json(parseJson<Record<string, unknown>>(savedReceipt.response_json, {}));
}

async function failStep(db: D1Database, request: Request, payload: Record<string, unknown>) {
  const auth = await authenticateRunner(db, request, payload);
  const stepId = requiredText(payload.stepId, "Agent Step ID", 120);
  const leaseId = requiredText(payload.leaseId, "租约 ID", 120);
  const leaseToken = requiredText(payload.leaseToken, "租约 token", 500);
  const commandId = requiredText(payload.commandId, "commandId", 160);
  const errorClass = cleanText(payload.errorClass, 80) || "runner_error";
  const errorSummary = requiredText(payload.errorSummary, "错误摘要", 2000);
  const requestSha256 = await sha256Text(canonicalJson({ stepId, leaseId, errorClass, errorSummary }));
  const replay = await inspectCommandReceipt(db, commandId, "runner.fail", auth.runnerId, requestSha256);
  if (replay) return replay;
  const step = await db.prepare("SELECT * FROM agent_steps WHERE id = ? LIMIT 1").bind(stepId).first<D1Row>();
  if (!step) throw new RunnerApiError("Agent Step 不存在", 404);
  const run = await db.prepare("SELECT * FROM agent_runs WHERE id = ? LIMIT 1").bind(step.agent_run_id).first<D1Row>();
  if (!run) throw new RunnerApiError("AgentRun 不存在", 404);
  const leaseTokenSha256 = await sha256Text(leaseToken);
  const now = isoNow();
  const responsePayload = { stepId, state: "failed", errorClass };
  const eventId = `event-runner-fail-${(await sha256Text(commandId)).slice(0, 40)}`;
  const statements = [
    db.prepare(`INSERT INTO command_receipts
      (id, command_type, actor_id, request_sha256, response_json, status_code)
      VALUES (?, 'runner.fail', ?, ?, '{}', 0)
      ON CONFLICT(id) DO UPDATE SET status_code = CASE
        WHEN command_type = excluded.command_type AND actor_id = excluded.actor_id
          AND request_sha256 = excluded.request_sha256 THEN command_receipts.status_code
        ELSE NULL END`).bind(commandId, auth.runnerId, requestSha256),
    db.prepare(`UPDATE agent_steps SET state = 'failed', error_class = ?, error_summary = ?, finished_at = ?, updated_at = ?
      , terminal_command_id = ?
      WHERE id = ? AND lease_id = ? AND assigned_runner_id = ? AND state IN ('leased', 'running')
        AND EXISTS (SELECT 1 FROM command_receipts WHERE id = ? AND command_type = 'runner.fail'
          AND actor_id = ? AND request_sha256 = ? AND status_code = 0)
        AND EXISTS (SELECT 1 FROM runner_leases WHERE id = ? AND agent_step_id = ? AND runner_id = ?
          AND lease_token_sha256 = ? AND revoked_at IS NULL AND expires_at > ?)`)
      .bind(errorClass, errorSummary, now, now, commandId, stepId, leaseId, auth.runnerId,
        commandId, auth.runnerId, requestSha256, leaseId, stepId, auth.runnerId, leaseTokenSha256, now),
    db.prepare(`UPDATE runner_leases SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL
      AND EXISTS (SELECT 1 FROM agent_steps WHERE id = ? AND state = 'failed' AND terminal_command_id = ?)`)
      .bind(now, leaseId, stepId, commandId),
    db.prepare(`UPDATE agent_runs SET state = 'failed', finished_at = ?, last_heartbeat_at = ? WHERE id = ?
      AND EXISTS (SELECT 1 FROM agent_steps WHERE id = ? AND state = 'failed' AND terminal_command_id = ?)`)
      .bind(now, now, run.id, stepId, commandId),
    db.prepare(`UPDATE command_receipts SET response_json = ?, status_code = 200, completed_at = ?
      WHERE id = ? AND status_code = 0
        AND EXISTS (SELECT 1 FROM agent_steps WHERE id = ? AND state = 'failed' AND terminal_command_id = ?)`)
      .bind(JSON.stringify(responsePayload), now, commandId, stepId, commandId),
    db.prepare(`INSERT INTO workspace_events
      (id, event_type, subject_type, subject_id, article_id, payload_json, input_sha256)
      SELECT ?, 'agent_step.failed', 'agent_run', ?, ?, receipt.response_json,
        CASE WHEN receipt.status_code = 200
          AND EXISTS (SELECT 1 FROM agent_steps WHERE id = ? AND state = 'failed' AND terminal_command_id = ?)
          THEN ? ELSE NULL END
      FROM command_receipts receipt WHERE receipt.id = ?`)
      .bind(eventId, run.id, run.article_id, stepId, commandId, run.input_sha256, commandId),
  ];
  try {
    await db.batch(statements);
  } catch {
    const completed = await inspectCommandReceipt(db, commandId, "runner.fail", auth.runnerId, requestSha256);
    if (completed) return completed;
    throw new RunnerApiError("失败回调未通过租约或幂等断言", 409);
  }
  return Response.json(responsePayload);
}

async function releaseLease(db: D1Database, request: Request, payload: Record<string, unknown>) {
  const auth = await authenticateRunner(db, request, payload);
  const stepId = requiredText(payload.stepId, "Agent Step ID", 120);
  const leaseId = requiredText(payload.leaseId, "租约 ID", 120);
  const leaseToken = requiredText(payload.leaseToken, "租约 token", 500);
  const leaseTokenSha256 = await sha256Text(leaseToken);
  const now = isoNow();
  const results = await db.batch([
    db.prepare(`UPDATE agent_steps SET state = 'queued', assigned_runner_id = NULL, lease_id = NULL, updated_at = ?
      WHERE id = ? AND lease_id = ? AND assigned_runner_id = ? AND state IN ('leased', 'running')
        AND EXISTS (SELECT 1 FROM runner_leases WHERE id = ? AND agent_step_id = ? AND runner_id = ?
          AND lease_token_sha256 = ? AND revoked_at IS NULL AND expires_at > ?)`)
      .bind(now, stepId, leaseId, auth.runnerId, leaseId, stepId, auth.runnerId, leaseTokenSha256, now),
    db.prepare(`UPDATE runner_leases SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL
      AND EXISTS (SELECT 1 FROM agent_steps WHERE id = ? AND state = 'queued' AND lease_id IS NULL AND updated_at = ?)`)
      .bind(now, leaseId, stepId, now),
    db.prepare(`UPDATE agent_runs SET state = 'queued', finished_at = NULL, last_heartbeat_at = ?
      WHERE id = (SELECT agent_run_id FROM agent_steps WHERE id = ?)
        AND EXISTS (SELECT 1 FROM agent_steps WHERE id = ? AND state = 'queued' AND updated_at = ?)`)
      .bind(now, stepId, stepId, now),
  ]);
  if (Number(results[0].meta.changes ?? 0) !== 1) throw new RunnerApiError("租约已过期、被撤销或工位已经结束", 409);
  return Response.json({ stepId, state: "queued" });
}

export async function GET(request: Request) {
  try {
    await requireManagementSession(request, { scope: "management.read" })
      .catch((error: unknown) => {
        if (error instanceof ManagementAuthError) throw new RunnerApiError(error.message, error.status);
        throw error;
      });
    const db = await ensureRunnerSchema();
    const articleId = cleanText(new URL(request.url).searchParams.get("articleId"), 120);
    const [runners, runs, steps, artifacts] = await db.batch([
      db.prepare("SELECT * FROM runner_registry ORDER BY status, created_at DESC LIMIT 100"),
      articleId
        ? db.prepare("SELECT * FROM agent_runs WHERE article_id = ? ORDER BY created_at DESC LIMIT 200").bind(articleId)
        : db.prepare("SELECT * FROM agent_runs ORDER BY created_at DESC LIMIT 200"),
      db.prepare("SELECT * FROM agent_steps ORDER BY created_at, attempt LIMIT 1000"),
      db.prepare("SELECT * FROM agent_artifacts ORDER BY created_at LIMIT 1000"),
    ]);
    const stepRows = steps.results as D1Row[];
    const artifactRows = artifacts.results as D1Row[];
    return Response.json({
      runners: (runners.results as D1Row[]).map(parseRunner),
      agentRuns: (runs.results as D1Row[]).map((run) => parseRun(run, stepRows, artifactRows)),
    });
  } catch (error) {
    const status = error instanceof RunnerApiError ? error.status : 503;
    return Response.json({ runners: [], agentRuns: [], error: error instanceof Error ? error.message : "Runner 控制面不可用" }, { status });
  }
}

export async function POST(request: Request) {
  try {
    const db = await ensureRunnerSchema();
    const payload = await request.json() as Record<string, unknown>;
    const action = requiredText(payload.action, "动作", 80);
    if (["issue_runner_token", "revoke_runner", "queue_agent_step"].includes(action)) {
      await requireManagementSession(request, { mutation: true, scope: "runner.manage" })
        .catch((error: unknown) => {
          if (error instanceof ManagementAuthError) throw new RunnerApiError(error.message, error.status);
          throw error;
        });
      assertLocalManagementRequest(request);
    }
    if (action === "issue_runner_token") return issueRunnerToken(db, payload);
    if (action === "revoke_runner") return revokeRunner(db, payload);
    if (action === "queue_agent_step") return queueAgentStep(db, payload);
    if (action === "runner_lease") return leaseAgentStep(db, request, payload);
    if (action === "runner_heartbeat") return heartbeat(db, request, payload);
    if (action === "runner_complete") return completeStep(db, request, payload);
    if (action === "runner_fail") return failStep(db, request, payload);
    if (action === "runner_release") return releaseLease(db, request, payload);
    throw new RunnerApiError("未知 Runner 动作", 400);
  } catch (error) {
    const status = error instanceof RunnerApiError ? error.status : 500;
    return Response.json({ error: error instanceof Error ? error.message : "Runner 操作失败" }, { status });
  }
}
