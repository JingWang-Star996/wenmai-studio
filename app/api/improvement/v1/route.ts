import { env } from "cloudflare:workers";
import { ManagementAuthError, sha256Text } from "../../../management-auth-core";
import { managementActorId, requireManagementSession } from "../../../management-auth";
import { conservativeInputTokenReservation } from "../../../meta-improvement-budget";
import {
  blockModelInvocationOutput,
  checkpointModelInvocationOutput,
  markModelInvocationOutputMaterialized,
  ModelInvocationCheckpointError,
  type ModelInvocationMaterializationKind,
} from "../../../model-invocation-checkpoint";
import {
  META_IMPROVEMENT_GOVERNANCE_SEEDS,
  META_IMPROVEMENT_SCHEMA_VERSION,
  META_IMPROVEMENT_SEED_PROMPTS,
  META_PROPOSAL_SCHEMA_VERSION,
  META_REVIEW_SCHEMA_VERSION,
  MODEL_PROVIDERS,
  isExtendedModelProvider,
  evaluateMetaImprovementAdoptability,
  scoreMetaImprovementSignals,
  transitionMetaImprovementExperiment,
  transitionMetaSkillActivation,
  transitionMetaSkillVersion,
  validateMetaExperimentBudget,
  validateMetaProviderPolicy,
  type DeterministicEvaluationPair,
  type MetaExperimentBudget,
  type MetaExperimentCasExpectation,
  type MetaExperimentSnapshot,
  type MetaExperimentState,
  type MetaImprovementSignal,
  type MetaProviderPolicy,
  type MetaSkillActivationSnapshot,
  type MetaSkillRole,
  type MetaSkillVersionLifecycleSnapshot,
  type ModelProvider,
  type ReviewerEvaluation,
} from "../../../meta-improvement";
import {
  MODEL_GATEWAY_ADAPTER_VERSION,
  getModelGatewayProviderStatus,
  probeModelGatewayProvider,
  requestModelGatewayJson,
  toModelGatewaySafeError,
  type ModelGatewayChatMessage,
  type ModelGatewayJsonObject,
  type ModelGatewayJsonResult,
  type ModelGatewayServerEnv,
} from "../../../model-gateway";

type D1Row = Record<string, string | number | null>;
type JsonObject = Record<string, unknown>;
type MutationResult = { status?: number; data: JsonObject };

const API_VERSION = "wenmai-improvement-v1";
const MAX_BODY_BYTES = 512_000;
const EVALUATION_PROTOCOL_VERSION = "wenmai.meta-evaluation-protocol/2.0";
const EXECUTION_SCHEMA_VERSION = "wenmai.meta-execution/2.0";
const LITERAL_EVALUATOR_KEY = "literal-signals/v1";
const BLIND_REVIEWER_KEY = "provider-neutral-blind-review/v2";
const HUMAN_EVIDENCE_SCHEMA_VERSION = "wenmai.human-adoption-evidence/1.0";
const FROZEN_MODEL_SAMPLING = Object.freeze({ temperature: 0, topP: 1 });
const FROZEN_MAX_OUTPUT_TOKENS = Object.freeze({
  proposer: 4_096,
  execution: 2_048,
  reviewer: 2_048,
});
const MAX_EXPERIMENTS = 50;
const MAX_ARTIFACT_PREVIEW_CHARS = 2_000;
const SHA256_RE = /^[a-f0-9]{64}$/u;
const CASE_ID_RE = /^[A-Za-z0-9._:-]{1,80}$/u;
const COMMAND_ID_RE = /^[A-Za-z0-9._:-]{1,160}$/u;
const ACTION_SCOPES = {
  initialize_workspace: "rule.adopt",
  test_provider: "admin.diagnostics",
  create_experiment: "task.manage",
  generate_candidates: "task.manage",
  run_pairwise_evaluation: "task.manage",
  decide_experiment: "rule.adopt",
} as const;

type ImprovementAction = keyof typeof ACTION_SCOPES;

const TARGET_LABELS: Record<string, string> = {
  "meta.candidate-proposer": "候选生成器",
  "meta.execution": "受限执行器",
  "meta.candidate-reviewer": "独立盲审者",
};

const TARGET_ROLES: Record<string, MetaSkillRole> = {
  "meta.candidate-proposer": "proposer",
  "meta.execution": "execution",
  "meta.candidate-reviewer": "reviewer",
};

class ImprovementApiError extends Error {
  code: string;
  status: number;
  details?: JsonObject;

  constructor(code: string, message: string, status = 400, details?: JsonObject) {
    super(message);
    this.name = "ImprovementApiError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function newRequestId() {
  return `req-${crypto.randomUUID()}`;
}

function isoNow() {
  return new Date().toISOString();
}

function jsonSuccess(id: string, data: JsonObject, status = 200) {
  return Response.json({ ok: true, requestId: id, data }, {
    status,
    headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" },
  });
}

function jsonError(id: string, error: unknown) {
  const apiError = error instanceof ImprovementApiError || error instanceof ManagementAuthError
    ? new ImprovementApiError(error.code, error.message, error.status, error.details)
    : new ImprovementApiError("INTERNAL_ERROR", "元改进控制面处理失败", 500);
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
  if (!env.DB) throw new ImprovementApiError("DB_UNAVAILABLE", "元改进数据库尚未连接", 503);
  return env.DB;
}

function runtimeEnv(): ModelGatewayServerEnv {
  return env as unknown as Readonly<Record<string, unknown>>;
}

function extendedProvidersEnabled() {
  return runtimeEnv().META_IMPROVEMENT_EXTENDED_PROVIDERS_ENABLED === "true";
}

function assertMetaProviderEnabled(provider: ModelProvider) {
  if (isExtendedModelProvider(provider) && !extendedProvidersEnabled()) {
    throw new ImprovementApiError(
      "META_IMPROVEMENT_EXTENDED_PROVIDER_DISABLED",
      "OpenAI 与 Ollama 尚未在元改进服务端启用",
      403,
      { provider, enabled: false },
    );
  }
}

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isMetaModelProvider(value: unknown): value is ModelProvider {
  return typeof value === "string" && MODEL_PROVIDERS.some((provider) => provider === value);
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string") return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function canonicalJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  const object = value as JsonObject;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
}

function cleanText(value: unknown, maximum = 2_000) {
  return typeof value === "string" ? value.trim().slice(0, maximum) : "";
}

function requiredText(value: unknown, field: string, maximum = 2_000) {
  const result = cleanText(value, maximum);
  if (!result) throw new ImprovementApiError("FIELD_REQUIRED", `${field} 不能为空`, 400, { field });
  return result;
}

function requiredInteger(value: unknown, field: string, minimum: number, maximum: number) {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new ImprovementApiError("FIELD_INVALID", `${field} 必须是 ${minimum} 到 ${maximum} 的整数`, 400, { field });
  }
  return Number(value);
}

function requiredSha256(value: unknown, field: string) {
  const result = cleanText(value, 64).toLowerCase();
  if (!SHA256_RE.test(result)) {
    throw new ImprovementApiError("FIELD_INVALID", `${field} 必须是 64 位 SHA-256`, 400, { field });
  }
  return result;
}

function stringList(value: unknown, field: string, options: { required?: boolean; maximumItems?: number; maximumLength?: number } = {}) {
  const maximumItems = options.maximumItems ?? 50;
  const maximumLength = options.maximumLength ?? 500;
  if (!Array.isArray(value) || value.length > maximumItems) {
    throw new ImprovementApiError("FIELD_INVALID", `${field} 必须是最多 ${maximumItems} 项的字符串数组`, 400, { field });
  }
  const result = value.map((item) => cleanText(item, maximumLength));
  if (result.some((item) => !item) || (options.required && result.length === 0)) {
    throw new ImprovementApiError("FIELD_INVALID", `${field} 含空值或缺少必需项`, 400, { field });
  }
  return [...new Set(result)];
}

function rowText(row: D1Row, key: string) {
  return String(row[key] ?? "");
}

function rowNullableText(row: D1Row, key: string) {
  const value = row[key];
  return value === null || value === undefined ? null : String(value);
}

function rowNumber(row: D1Row, key: string) {
  return Number(row[key] ?? 0);
}

async function hashJson(value: unknown) {
  return sha256Text(canonicalJson(value));
}

async function parseMutationBody(request: Request) {
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    throw new ImprovementApiError("PAYLOAD_TOO_LARGE", "元改进请求超过 512 KB", 413);
  }
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    throw new ImprovementApiError("UNSUPPORTED_MEDIA_TYPE", "写接口只接受 application/json", 415);
  }
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) {
    throw new ImprovementApiError("PAYLOAD_TOO_LARGE", "元改进请求超过 512 KB", 413);
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ImprovementApiError("INVALID_JSON", "请求正文不是有效 JSON 对象");
  }
  if (!isObject(value)) throw new ImprovementApiError("INVALID_JSON", "请求正文必须是 JSON 对象");
  const action = requiredText(value.action, "action", 80);
  if (!(action in ACTION_SCOPES)) throw new ImprovementApiError("ACTION_UNSUPPORTED", "不支持的元改进动作", 400);
  const commandId = typeof value.commandId === "string" ? value.commandId.trim() : "";
  if (!COMMAND_ID_RE.test(commandId)) {
    throw new ImprovementApiError(
      "COMMAND_ID_INVALID",
      "commandId 只能包含字母、数字、点、下划线、冒号或连字符，且最长 160 字符",
      400,
      { field: "commandId" },
    );
  }
  if (!isObject(value.payload)) throw new ImprovementApiError("FIELD_INVALID", "payload 必须是 JSON 对象", 400, { field: "payload" });
  return { action: action as ImprovementAction, commandId, payload: value.payload };
}

async function ensureImprovementSchema() {
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
    db.prepare(`CREATE TABLE IF NOT EXISTS meta_skill_versions (
      id TEXT PRIMARY KEY NOT NULL,
      skill_key TEXT NOT NULL,
      version TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('proposer','execution','reviewer','orchestrator')),
      parent_version_id TEXT,
      prompt_text TEXT NOT NULL,
      prompt_sha256 TEXT NOT NULL,
      contract_json TEXT NOT NULL DEFAULT '{}',
      contract_sha256 TEXT NOT NULL,
      content_sha256 TEXT NOT NULL,
      created_by_kind TEXT NOT NULL CHECK (created_by_kind IN ('human','model','system')),
      created_by_provider TEXT CHECK (created_by_provider IS NULL OR created_by_provider IN ('deepseek','qwen','openai','ollama')),
      source_invocation_id TEXT,
      is_candidate INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'candidate' CHECK (status IN ('candidate','adopted','superseded','rejected')),
      decision_experiment_id TEXT,
      activated_at TEXT,
      decided_at TEXT,
      lock_version INTEGER NOT NULL DEFAULT 1 CHECK (lock_version >= 1),
      created_at TEXT NOT NULL,
      CHECK (created_by_kind <> 'model' OR is_candidate = 1),
      CHECK (status = 'candidate' OR (decision_experiment_id IS NOT NULL AND decided_at IS NOT NULL)),
      CHECK (status <> 'adopted' OR activated_at IS NOT NULL)
    )`),
    db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_meta_skill_versions_key_version ON meta_skill_versions(skill_key, version)"),
    db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_meta_skill_versions_key_content ON meta_skill_versions(skill_key, content_sha256)"),
    db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_meta_skill_versions_active_key ON meta_skill_versions(skill_key) WHERE status = 'adopted'"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_meta_skill_versions_key_created ON meta_skill_versions(skill_key, created_at)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_meta_skill_versions_parent ON meta_skill_versions(parent_version_id, created_at)"),
    db.prepare(`CREATE TABLE IF NOT EXISTS meta_skill_activations (
      skill_key TEXT PRIMARY KEY NOT NULL,
      active_version_id TEXT NOT NULL,
      lock_version INTEGER NOT NULL DEFAULT 1 CHECK (lock_version >= 1),
      updated_at TEXT NOT NULL,
      decision_experiment_id TEXT NOT NULL
    )`),
    db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_meta_skill_activations_active_version ON meta_skill_activations(active_version_id)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_meta_skill_activations_experiment ON meta_skill_activations(decision_experiment_id, updated_at)"),
    db.prepare(`CREATE TABLE IF NOT EXISTS meta_improvement_experiments (
      id TEXT PRIMARY KEY NOT NULL,
      target_skill_key TEXT NOT NULL,
      title TEXT NOT NULL,
      objective TEXT NOT NULL,
      hypothesis TEXT NOT NULL,
      baseline_version_id TEXT NOT NULL,
      baseline_content_sha256 TEXT NOT NULL,
      candidate_version_id TEXT,
      cases_json TEXT NOT NULL,
      cases_sha256 TEXT NOT NULL,
      holdout_cases_json TEXT NOT NULL,
      holdout_cases_sha256 TEXT NOT NULL,
      provider_policy_json TEXT NOT NULL,
      provider_policy_sha256 TEXT NOT NULL,
      budget_json TEXT NOT NULL,
      budget_sha256 TEXT NOT NULL,
      evaluation_contract_json TEXT NOT NULL,
      evaluation_contract_sha256 TEXT NOT NULL,
      frozen_input_sha256 TEXT NOT NULL,
      proposer_invocation_id TEXT,
      reviewer_invocation_id TEXT,
      state TEXT NOT NULL DEFAULT 'draft' CHECK (state IN ('draft','baselined','generating','candidate_ready','evaluating','awaiting_human','blocked','completed','failed','cancelled')),
      decision TEXT NOT NULL DEFAULT 'pending' CHECK (decision IN ('pending','adopt','reject','defer','rollback')),
      human_decision_note TEXT NOT NULL DEFAULT '',
      human_decided_by TEXT,
      human_decided_at TEXT,
      lock_version INTEGER NOT NULL DEFAULT 1 CHECK (lock_version >= 1),
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT,
      CHECK (decision = 'pending' OR (human_decided_by IS NOT NULL AND length(trim(human_decision_note)) > 0))
    )`),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_meta_improvement_experiments_target_state ON meta_improvement_experiments(target_skill_key, state, updated_at)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_meta_improvement_experiments_baseline ON meta_improvement_experiments(baseline_version_id, created_at)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_meta_improvement_experiments_candidate ON meta_improvement_experiments(candidate_version_id, created_at)"),
    db.prepare(`CREATE TABLE IF NOT EXISTS model_invocations (
      id TEXT PRIMARY KEY NOT NULL,
      experiment_id TEXT,
      lineage_candidate_id TEXT,
      lineage_preparation_id TEXT,
      command_id TEXT NOT NULL,
      purpose TEXT NOT NULL CHECK (purpose IN ('provider_probe','meta_experiment','lineage_review')),
      role TEXT NOT NULL CHECK (role IN ('probe','proposer','execution','reviewer')),
      provider TEXT NOT NULL CHECK (provider IN ('deepseek','qwen','openai','ollama')),
      model_id TEXT NOT NULL,
      adapter_version TEXT NOT NULL,
      prompt_version_id TEXT,
      provider_policy_sha256 TEXT,
      egress_manifest_sha256 TEXT NOT NULL,
      egress_approval_sha256 TEXT NOT NULL,
      request_sha256 TEXT NOT NULL,
      input_sha256 TEXT NOT NULL,
      response_sha256 TEXT,
      output_ref TEXT NOT NULL DEFAULT '',
      state TEXT NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','running','succeeded','failed','inconclusive','cancelled')),
      attempt INTEGER NOT NULL DEFAULT 1 CHECK (attempt >= 1),
      budget_reservation_json TEXT NOT NULL DEFAULT '{}',
      budget_reservation_sha256 TEXT NOT NULL,
      usage_json TEXT NOT NULL DEFAULT '{}',
      input_tokens INTEGER,
      output_tokens INTEGER,
      total_tokens INTEGER,
      estimated_cost_cny_micros INTEGER,
      latency_ms INTEGER,
      http_status INTEGER,
      finish_reason TEXT,
      provider_request_id TEXT,
      error_class TEXT,
      error_summary TEXT,
      created_at TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT,
      CHECK ((purpose = 'provider_probe' AND role = 'probe')
        OR (purpose = 'meta_experiment' AND role IN ('proposer','execution','reviewer'))
        OR (purpose = 'lineage_review' AND role = 'reviewer' AND provider = 'deepseek')),
      CHECK (purpose = 'provider_probe'
        OR (purpose = 'meta_experiment' AND experiment_id IS NOT NULL AND prompt_version_id IS NOT NULL AND provider_policy_sha256 IS NOT NULL)
        OR (purpose = 'lineage_review' AND experiment_id IS NULL AND lineage_candidate_id IS NOT NULL
          AND lineage_preparation_id IS NOT NULL AND prompt_version_id IS NOT NULL AND provider_policy_sha256 IS NOT NULL)),
      CHECK ((purpose = 'lineage_review' AND lineage_candidate_id IS NOT NULL AND lineage_preparation_id IS NOT NULL)
        OR (purpose <> 'lineage_review' AND lineage_candidate_id IS NULL AND lineage_preparation_id IS NULL)),
      CHECK ((input_tokens IS NULL OR input_tokens >= 0) AND (output_tokens IS NULL OR output_tokens >= 0) AND (total_tokens IS NULL OR total_tokens >= 0) AND (estimated_cost_cny_micros IS NULL OR estimated_cost_cny_micros >= 0)),
      CHECK ((latency_ms IS NULL OR latency_ms >= 0) AND (http_status IS NULL OR (http_status >= 100 AND http_status <= 599)))
    )`),
    db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_model_invocations_command ON model_invocations(command_id)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_model_invocations_experiment_role ON model_invocations(experiment_id, role, created_at)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_model_invocations_purpose_state ON model_invocations(purpose, state, created_at)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_model_invocations_provider_state ON model_invocations(provider, state, created_at)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_model_invocations_lineage_candidate ON model_invocations(lineage_candidate_id, created_at)"),
    db.prepare(`CREATE TABLE IF NOT EXISTS model_invocation_outputs (
      invocation_id TEXT PRIMARY KEY NOT NULL,
      materialization_kind TEXT NOT NULL CHECK (materialization_kind IN ('probe','candidate','evaluation','review')),
      response_json TEXT NOT NULL CHECK (json_valid(response_json) AND json_type(response_json) = 'object' AND length(CAST(response_json AS BLOB)) BETWEEN 2 AND 262144),
      response_sha256 TEXT NOT NULL CHECK (length(response_sha256) = 64 AND response_sha256 NOT GLOB '*[^0-9a-f]*'),
      usage_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(usage_json) AND json_type(usage_json) = 'object' AND length(CAST(usage_json AS BLOB)) BETWEEN 2 AND 8192),
      usage_sha256 TEXT NOT NULL CHECK (length(usage_sha256) = 64 AND usage_sha256 NOT GLOB '*[^0-9a-f]*'),
      materialization_state TEXT NOT NULL DEFAULT 'checkpointed' CHECK (materialization_state IN ('checkpointed','materializing','materialized','blocked')),
      materialization_ref TEXT NOT NULL DEFAULT '' CHECK (length(CAST(materialization_ref AS BLOB)) <= 512),
      materialization_lease_owner TEXT,
      materialization_lease_expires_at TEXT,
      materialization_attempts INTEGER NOT NULL DEFAULT 0 CHECK (materialization_attempts >= 0),
      materialization_lock_version INTEGER NOT NULL DEFAULT 1 CHECK (materialization_lock_version >= 1),
      last_error_class TEXT,
      last_error_summary TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      materialized_at TEXT,
      CHECK ((materialization_state = 'materializing' AND materialization_lease_owner IS NOT NULL AND length(trim(materialization_lease_owner)) > 0 AND materialization_lease_expires_at IS NOT NULL) OR (materialization_state <> 'materializing' AND materialization_lease_owner IS NULL AND materialization_lease_expires_at IS NULL)),
      CHECK ((materialization_state = 'materialized' AND materialized_at IS NOT NULL AND (materialization_kind = 'probe' OR length(trim(materialization_ref)) > 0)) OR (materialization_state <> 'materialized' AND materialized_at IS NULL))
    )`),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_model_invocation_outputs_state_updated ON model_invocation_outputs(materialization_state, updated_at)"),
    db.prepare(`CREATE TABLE IF NOT EXISTS meta_improvement_evaluations (
      id TEXT PRIMARY KEY NOT NULL,
      experiment_id TEXT NOT NULL,
      pair_id TEXT NOT NULL,
      case_id TEXT NOT NULL,
      arm TEXT NOT NULL CHECK (arm IN ('baseline','candidate','pair')),
      version_id TEXT,
      evaluator_kind TEXT NOT NULL CHECK (evaluator_kind IN ('deterministic','model','human')),
      evaluator_key TEXT NOT NULL,
      provider TEXT CHECK (provider IS NULL OR provider IN ('deepseek','qwen','openai','ollama')),
      model_id TEXT,
      invocation_id TEXT,
      result TEXT NOT NULL CHECK (result IN ('pass','fail','inconclusive')),
      contract_sha256 TEXT NOT NULL,
      input_sha256 TEXT NOT NULL,
      output_sha256 TEXT NOT NULL,
      signals_json TEXT NOT NULL DEFAULT '[]',
      signals_sha256 TEXT NOT NULL,
      evidence_json TEXT NOT NULL DEFAULT '[]',
      evidence_sha256 TEXT NOT NULL,
      created_at TEXT NOT NULL,
      CHECK (evaluator_kind <> 'model' OR provider IS NOT NULL)
    )`),
    db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_meta_improvement_evaluations_identity ON meta_improvement_evaluations(experiment_id, pair_id, arm, evaluator_key, input_sha256)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_meta_improvement_evaluations_experiment_result ON meta_improvement_evaluations(experiment_id, result, created_at)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_meta_improvement_evaluations_case ON meta_improvement_evaluations(experiment_id, case_id, created_at)"),
    db.prepare(`CREATE TABLE IF NOT EXISTS meta_improvement_events (
      id TEXT PRIMARY KEY NOT NULL,
      experiment_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      from_state TEXT,
      to_state TEXT,
      actor_kind TEXT NOT NULL CHECK (actor_kind IN ('human','model','system')),
      actor_id TEXT NOT NULL,
      payload_json TEXT NOT NULL DEFAULT '{}',
      input_sha256 TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_meta_improvement_events_experiment_created ON meta_improvement_events(experiment_id, created_at)"),
  ]);
  await seedMetaSkills(db);
  return db;
}

async function requireImprovementSchemaReady() {
  const db = database();
  try {
    const row = await db.prepare(`SELECT COUNT(*) AS seed_count FROM meta_skill_activations
      WHERE skill_key IN (
        'meta.candidate-proposer','meta.execution','meta.candidate-reviewer',
        'meta.governance-executor','meta.governance-reviewer'
      )`)
      .first<D1Row>();
    if (rowNumber(row ?? {}, "seed_count") !== 5) {
      throw new ImprovementApiError(
        "IMPROVEMENT_NOT_INITIALIZED",
        "元改进工作区尚未初始化；请由有规则采用权限的管理会话显式初始化",
        409,
      );
    }
    return db;
  } catch (error) {
    if (error instanceof ImprovementApiError) throw error;
    throw new ImprovementApiError(
      "IMPROVEMENT_NOT_INITIALIZED",
      "元改进工作区尚未初始化；请由有规则采用权限的管理会话显式初始化",
      409,
    );
  }
}

async function seedMetaSkills(db: D1Database) {
  const now = isoNow();
  const seeds: Array<{
    skillKey: string;
    role: MetaSkillRole;
    promptText: string;
    governanceHarness: boolean;
  }> = [
    {
      skillKey: "meta.candidate-proposer",
      role: "proposer",
      promptText: META_IMPROVEMENT_SEED_PROMPTS.proposer,
      governanceHarness: false,
    },
    {
      skillKey: "meta.execution",
      role: "execution",
      promptText: META_IMPROVEMENT_SEED_PROMPTS.execution,
      governanceHarness: false,
    },
    {
      skillKey: "meta.candidate-reviewer",
      role: "reviewer",
      promptText: META_IMPROVEMENT_SEED_PROMPTS.reviewer,
      governanceHarness: false,
    },
    {
      skillKey: "meta.governance-executor",
      role: "execution",
      promptText: META_IMPROVEMENT_GOVERNANCE_SEEDS["meta.governance-executor"],
      governanceHarness: true,
    },
    {
      skillKey: "meta.governance-reviewer",
      role: "reviewer",
      promptText: META_IMPROVEMENT_GOVERNANCE_SEEDS["meta.governance-reviewer"],
      governanceHarness: true,
    },
  ];
  for (const { skillKey, role, promptText, governanceHarness } of seeds) {
    const promptSha256 = await sha256Text(promptText);
    const contract = {
      schemaVersion: META_IMPROVEMENT_SCHEMA_VERSION,
      role,
      candidateOnly: role === "proposer",
      externalSideEffects: false,
      adoptionAuthority: false,
      ...(governanceHarness ? {
        governanceHarness: true,
        improvableTarget: false,
      } : {}),
    };
    const contractJson = canonicalJson(contract);
    const contractSha256 = await sha256Text(contractJson);
    const contentSha256 = await hashJson({ promptSha256, contractSha256 });
    const seedName = governanceHarness
      ? skillKey.replace(/^meta\./u, "").replaceAll(".", "-")
      : role;
    const id = `meta-seed-${seedName}-${contentSha256.slice(0, 24)}`;
    await db.prepare(`INSERT OR IGNORE INTO meta_skill_versions
      (id, skill_key, version, role, parent_version_id, prompt_text, prompt_sha256,
       contract_json, contract_sha256, content_sha256, created_by_kind, created_by_provider,
       source_invocation_id, is_candidate, status, decision_experiment_id, activated_at,
       decided_at, lock_version, created_at)
      VALUES (?, ?, 'seed-v1', ?, NULL, ?, ?, ?, ?, ?, 'system', NULL, NULL, 0,
        'adopted', 'system-seed', ?, ?, 1, ?)`)
      .bind(id, skillKey, role, promptText, promptSha256, contractJson, contractSha256,
        contentSha256, now, now, now).run();
    const active = await db.prepare(`SELECT id FROM meta_skill_versions
      WHERE skill_key = ? AND status = 'adopted' ORDER BY activated_at DESC, created_at DESC LIMIT 1`)
      .bind(skillKey).first<D1Row>();
    if (!active) throw new ImprovementApiError("META_SEED_FAILED", `无法建立 ${skillKey} 的活动种子`, 500);
    await db.prepare(`INSERT OR IGNORE INTO meta_skill_activations
      (skill_key, active_version_id, lock_version, updated_at, decision_experiment_id)
      VALUES (?, ?, 1, ?, 'system-seed')`).bind(skillKey, rowText(active, "id"), now).run();
  }
}

async function inspectReceipt(
  db: D1Database,
  commandId: string,
  commandType: string,
  actorId: string,
  requestSha256: string,
) {
  const row = await db.prepare("SELECT * FROM command_receipts WHERE id = ? LIMIT 1")
    .bind(commandId).first<D1Row>();
  if (!row) return null;
  if (row.command_type !== commandType || row.actor_id !== actorId || row.request_sha256 !== requestSha256) {
    throw new ImprovementApiError("COMMAND_ID_REUSED", "同一 commandId 已绑定不同动作、身份或请求摘要", 409);
  }
  if (Number(row.status_code) === 0) {
    throw new ImprovementApiError("COMMAND_IN_PROGRESS", "这条元改进命令仍在处理，或上次结果尚未写入回执。原 commandId 与请求摘要仍保留；请刷新实验状态并核对回执，确认前不要更换 commandId 或再次发起模型调用。", 409);
  }
  const saved = parseJson<{ data?: JsonObject; error?: { code?: string; message?: string; details?: JsonObject } }>(row.response_json, {});
  if (Number(row.status_code) >= 400) {
    throw new ImprovementApiError(
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
  action: ImprovementAction,
  actorId: string,
  commandId: string,
  payload: JsonObject,
  handler: (requestSha256: string) => Promise<MutationResult>,
) {
  const commandType = `improvement.v1.${action}`;
  const requestSha256 = await hashJson({ action, actorId, payload });
  const replay = await inspectReceipt(db, commandId, commandType, actorId, requestSha256);
  if (replay) return replay;
  try {
    await db.prepare(`INSERT INTO command_receipts
      (id, command_type, actor_id, request_sha256, response_json, status_code)
      VALUES (?, ?, ?, ?, '{}', 0)`)
      .bind(commandId, commandType, actorId, requestSha256).run();
  } catch {
    const raced = await inspectReceipt(db, commandId, commandType, actorId, requestSha256);
    if (raced) return raced;
    throw new ImprovementApiError("COMMAND_IN_PROGRESS", "命令领取竞争未完成，请稍后重试", 409);
  }
  try {
    const result = await handler(requestSha256);
    const status = result.status ?? 200;
    const finalized = await db.prepare(`UPDATE command_receipts SET response_json = ?, status_code = ?, completed_at = ?
      WHERE id = ? AND command_type = ? AND actor_id = ? AND request_sha256 = ? AND status_code = 0`)
      .bind(canonicalJson({ data: result.data }), status, isoNow(), commandId, commandType,
        actorId, requestSha256).run();
    if (Number(finalized.meta.changes ?? 0) !== 1) {
      throw new ImprovementApiError("RECEIPT_FINALIZE_FAILED", "命令回执未能原子完成", 500);
    }
    return { status, data: result.data };
  } catch (error) {
    const failure = error instanceof ImprovementApiError
      ? error
      : new ImprovementApiError("INTERNAL_ERROR", "元改进控制面处理失败", 500);
    await db.prepare(`UPDATE command_receipts SET response_json = ?, status_code = ?, completed_at = ?
      WHERE id = ? AND command_type = ? AND actor_id = ? AND request_sha256 = ? AND status_code = 0`)
      .bind(canonicalJson({ error: { code: failure.code, message: failure.message, details: failure.details } }),
        failure.status, isoNow(), commandId, commandType, actorId, requestSha256).run();
    throw failure;
  }
}

type EvaluationCase = {
  id: string;
  input: string;
  requiredSignals: string[];
  forbiddenSignals: string[];
  holdout: boolean;
};

type FrozenHarness = {
  skillKey: string;
  versionId: string;
  contentSha256: string;
};

type FrozenModelInvocationProtocol = {
  adapterVersion: string;
  sampling: {
    temperature: number;
    topP: number;
  };
  maxOutputTokens: {
    proposer: number;
    execution: number;
    reviewer: number;
  };
};

type FrozenBaselineActivation = {
  skillKey: string;
  activeVersionId: string;
  lockVersion: number;
};

type EvaluationContract = {
  schemaVersion: string;
  evaluationProtocolVersion: string;
  evaluator: typeof LITERAL_EVALUATOR_KEY;
  minimumWeightedScore: number;
  articleId: string | null;
  failureEvidenceRefs: string[];
  baselineActivation: FrozenBaselineActivation;
  harnessVersions: {
    proposer: FrozenHarness;
    governanceExecutor: FrozenHarness;
    governanceReviewer: FrozenHarness;
  };
  modelInvocation: FrozenModelInvocationProtocol;
  cases: Array<{
    id: string;
    requiredSignals: string[];
    forbiddenSignals: string[];
    holdout: boolean;
  }>;
};

type HumanAdoptionExpectation = {
  candidateSha256: string;
  evidenceBundleSha256: string;
  activeVersionId: string;
  activationLockVersion: number;
};

function parseEvaluationCases(value: unknown): EvaluationCase[] {
  if (!Array.isArray(value) || value.length < 2 || value.length > 20) {
    throw new ImprovementApiError("EVALUATION_CASES_INVALID", "评估用例必须为 2 到 20 项", 400);
  }
  const ids = new Set<string>();
  const cases = value.map((item, index) => {
    if (!isObject(item)) {
      throw new ImprovementApiError("EVALUATION_CASE_INVALID", `第 ${index + 1} 个评估用例不是对象`, 400);
    }
    const id = requiredText(item.id, `evaluationCases[${index}].id`, 80);
    if (!CASE_ID_RE.test(id) || ids.has(id)) {
      throw new ImprovementApiError("EVALUATION_CASE_ID_INVALID", "评估用例 ID 必须唯一且只含安全字符", 400, { caseId: id });
    }
    ids.add(id);
    return {
      id,
      input: requiredText(item.input, `evaluationCases[${index}].input`, 40_000),
      requiredSignals: stringList(item.requiredSignals, `evaluationCases[${index}].requiredSignals`, {
        required: true,
        maximumItems: 30,
        maximumLength: 300,
      }),
      forbiddenSignals: stringList(item.forbiddenSignals ?? [], `evaluationCases[${index}].forbiddenSignals`, {
        maximumItems: 30,
        maximumLength: 300,
      }),
      holdout: item.holdout === true,
    };
  });
  if (!cases.some((item) => item.holdout)) {
    throw new ImprovementApiError("HOLDOUT_CASE_REQUIRED", "至少需要一个 holdout 评估用例", 400);
  }
  return cases;
}

function experimentSnapshot(row: D1Row): MetaExperimentSnapshot {
  return {
    id: rowText(row, "id"),
    state: rowText(row, "state") as MetaExperimentState,
    decision: rowText(row, "decision") as MetaExperimentSnapshot["decision"],
    lockVersion: rowNumber(row, "lock_version"),
    candidateVersionId: rowNullableText(row, "candidate_version_id"),
    baselineVersionId: rowText(row, "baseline_version_id"),
    baselineContentSha256: rowText(row, "baseline_content_sha256"),
    casesSha256: rowText(row, "cases_sha256"),
    holdoutCasesSha256: rowText(row, "holdout_cases_sha256"),
    providerPolicySha256: rowText(row, "provider_policy_sha256"),
    budgetSha256: rowText(row, "budget_sha256"),
    evaluationContractSha256: rowText(row, "evaluation_contract_sha256"),
    frozenInputSha256: rowText(row, "frozen_input_sha256"),
  };
}

function experimentExpectation(
  snapshot: MetaExperimentSnapshot,
  expectedState: MetaExperimentState,
  expectedLockVersion: number,
  expectedCandidateVersionId = snapshot.candidateVersionId,
): MetaExperimentCasExpectation {
  return {
    experimentId: snapshot.id,
    expectedState,
    expectedLockVersion,
    expectedCandidateVersionId,
    baselineVersionId: snapshot.baselineVersionId,
    baselineContentSha256: snapshot.baselineContentSha256,
    casesSha256: snapshot.casesSha256,
    holdoutCasesSha256: snapshot.holdoutCasesSha256,
    providerPolicySha256: snapshot.providerPolicySha256,
    budgetSha256: snapshot.budgetSha256,
    evaluationContractSha256: snapshot.evaluationContractSha256,
    frozenInputSha256: snapshot.frozenInputSha256,
  };
}

function skillLifecycle(row: D1Row): MetaSkillVersionLifecycleSnapshot {
  return {
    id: rowText(row, "id"),
    skillKey: rowText(row, "skill_key"),
    contentSha256: rowText(row, "content_sha256"),
    status: rowText(row, "status") as MetaSkillVersionLifecycleSnapshot["status"],
    lockVersion: rowNumber(row, "lock_version"),
    decisionExperimentId: rowNullableText(row, "decision_experiment_id"),
    activatedAt: rowNullableText(row, "activated_at"),
    decidedAt: rowNullableText(row, "decided_at"),
  };
}

function activationSnapshot(row: D1Row): MetaSkillActivationSnapshot {
  return {
    skillKey: rowText(row, "skill_key"),
    activeVersionId: rowText(row, "active_version_id"),
    lockVersion: rowNumber(row, "lock_version"),
    updatedAt: rowText(row, "updated_at"),
    decisionExperimentId: rowText(row, "decision_experiment_id"),
  };
}

async function experimentRow(db: D1Database, experimentId: string) {
  const row = await db.prepare("SELECT * FROM meta_improvement_experiments WHERE id = ? LIMIT 1")
    .bind(experimentId).first<D1Row>();
  if (!row) throw new ImprovementApiError("EXPERIMENT_NOT_FOUND", "元改进实验不存在", 404);
  return row;
}

async function versionRow(db: D1Database, versionId: string) {
  const row = await db.prepare("SELECT * FROM meta_skill_versions WHERE id = ? LIMIT 1")
    .bind(versionId).first<D1Row>();
  if (!row) throw new ImprovementApiError("SKILL_VERSION_NOT_FOUND", "Skill 版本不存在", 404);
  return row;
}

async function activationRow(db: D1Database, skillKey: string) {
  const row = await db.prepare("SELECT * FROM meta_skill_activations WHERE skill_key = ? LIMIT 1")
    .bind(skillKey).first<D1Row>();
  if (!row) throw new ImprovementApiError("SKILL_ACTIVATION_NOT_FOUND", "Skill 活动版本指针不存在", 404);
  return row;
}

async function activeSkillRow(db: D1Database, skillKey: string) {
  const row = await db.prepare(`SELECT version.*, activation.lock_version AS activation_lock_version,
      activation.updated_at AS activation_updated_at, activation.decision_experiment_id AS activation_decision_experiment_id
    FROM meta_skill_activations activation
    JOIN meta_skill_versions version ON version.id = activation.active_version_id
    WHERE activation.skill_key = ? LIMIT 1`).bind(skillKey).first<D1Row>();
  if (!row) throw new ImprovementApiError("SKILL_ACTIVATION_INVALID", `${skillKey} 的活动版本无法解析`, 500);
  return row;
}

function parseProviderPolicy(row: D1Row) {
  const policy = parseJson<MetaProviderPolicy | null>(row.provider_policy_json, null);
  if (!policy || validateMetaProviderPolicy(policy).length > 0) {
    throw new ImprovementApiError("FROZEN_PROVIDER_POLICY_INVALID", "实验冻结的 Provider 策略无效", 500);
  }
  return policy;
}

function parseBudget(row: D1Row) {
  const budget = parseJson<MetaExperimentBudget | null>(row.budget_json, null);
  if (!budget) throw new ImprovementApiError("FROZEN_BUDGET_INVALID", "实验冻结的预算无效", 500);
  return budget;
}

function parseEvaluationContract(row: D1Row) {
  const contract = parseJson<EvaluationContract | null>(row.evaluation_contract_json, null);
  if (!contract || contract.schemaVersion !== META_IMPROVEMENT_SCHEMA_VERSION || !contract.harnessVersions) {
    throw new ImprovementApiError("FROZEN_EVALUATION_CONTRACT_INVALID", "实验冻结的评测合同无效", 500);
  }
  return contract;
}

function assertEvaluationProtocolV2(contract: EvaluationContract) {
  const invocation = contract.modelInvocation;
  const harnesses = contract.harnessVersions;
  const harnessValid = [
    [harnesses?.proposer, "meta.candidate-proposer"],
    [harnesses?.governanceExecutor, "meta.governance-executor"],
    [harnesses?.governanceReviewer, "meta.governance-reviewer"],
  ].every(([harness, skillKey]) => isObject(harness)
    && harness.skillKey === skillKey
    && typeof harness.versionId === "string"
    && SHA256_RE.test(String(harness.contentSha256)));
  if (contract.evaluationProtocolVersion !== EVALUATION_PROTOCOL_VERSION
    || contract.evaluator !== LITERAL_EVALUATOR_KEY
    || !harnessValid
    || !invocation
    || invocation.adapterVersion !== MODEL_GATEWAY_ADAPTER_VERSION
    || invocation.sampling?.temperature !== FROZEN_MODEL_SAMPLING.temperature
    || invocation.sampling?.topP !== FROZEN_MODEL_SAMPLING.topP
    || invocation.maxOutputTokens?.proposer !== FROZEN_MAX_OUTPUT_TOKENS.proposer
    || invocation.maxOutputTokens?.execution !== FROZEN_MAX_OUTPUT_TOKENS.execution
    || invocation.maxOutputTokens?.reviewer !== FROZEN_MAX_OUTPUT_TOKENS.reviewer
    || !isObject(contract.baselineActivation)
    || !(contract.baselineActivation.skillKey in TARGET_ROLES)
    || typeof contract.baselineActivation.activeVersionId !== "string"
    || !Number.isSafeInteger(contract.baselineActivation.lockVersion)
    || contract.baselineActivation.lockVersion < 1) {
    throw new ImprovementApiError(
      "EVALUATION_PROTOCOL_UPGRADE_REQUIRED",
      "该实验不是冻结的 v2 治理评测协议，禁止发生任何模型调用；请创建新实验",
      409,
    );
  }
  return contract;
}

async function assertFrozenBaselineActivation(
  db: D1Database,
  row: D1Row,
  contract: EvaluationContract,
) {
  const frozen = contract.baselineActivation;
  const activation = await activationRow(db, frozen.skillKey);
  const conflicts = [
    rowText(row, "decision") !== "pending" ? "DECISION_NOT_PENDING" : null,
    rowText(row, "target_skill_key") !== frozen.skillKey ? "TARGET_SKILL_CHANGED" : null,
    rowText(row, "baseline_version_id") !== frozen.activeVersionId ? "FROZEN_BASELINE_CHANGED" : null,
    rowText(activation, "active_version_id") !== frozen.activeVersionId ? "ACTIVE_VERSION_CHANGED" : null,
    rowNumber(activation, "lock_version") !== frozen.lockVersion ? "ACTIVATION_LOCK_CHANGED" : null,
  ].filter((item): item is string => item !== null);
  if (conflicts.length > 0) {
    throw new ImprovementApiError(
      "FROZEN_BASELINE_STALE",
      "当前活动基线已变化，本次未调用模型。旧实验及冻结输入仍保留供审计；请以当前 activation 新建实验，不要继续运行旧实验。",
      409,
      { conflicts },
    );
  }
  return activation;
}

function stateTransitionError(conflicts: string[]) {
  return new ImprovementApiError("EXPERIMENT_CAS_CONFLICT", "实验状态或冻结输入已变化", 409, { conflicts });
}

async function insertEvent(
  db: D1Database,
  input: {
    experimentId: string;
    eventType: string;
    fromState?: string | null;
    toState?: string | null;
    actorKind: "human" | "model" | "system";
    actorId: string;
    payload?: JsonObject;
    inputSha256: string;
  },
) {
  await db.prepare(`INSERT INTO meta_improvement_events
    (id, experiment_id, event_type, from_state, to_state, actor_kind, actor_id,
     payload_json, input_sha256, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(`meta-event-${crypto.randomUUID()}`, input.experimentId, input.eventType,
      input.fromState ?? null, input.toState ?? null, input.actorKind, input.actorId,
      canonicalJson(input.payload ?? {}), input.inputSha256, isoNow()).run();
}

async function transitionExperimentState(
  db: D1Database,
  row: D1Row,
  targetState: MetaExperimentState,
  expectedLockVersion: number,
  actor: { kind: "human" | "model" | "system"; id: string },
  inputSha256: string,
) {
  const snapshot = experimentSnapshot(row);
  const expected = experimentExpectation(snapshot, snapshot.state, expectedLockVersion);
  const transition = transitionMetaImprovementExperiment(snapshot, targetState, expected);
  if (!transition.ok) throw stateTransitionError(transition.conflicts);
  const updatedAt = isoNow();
  const result = await db.prepare(`UPDATE meta_improvement_experiments
    SET state = ?, lock_version = ?, updated_at = ?
    WHERE id = ? AND state = ? AND lock_version = ?
      AND baseline_version_id = ? AND baseline_content_sha256 = ? AND ifnull(candidate_version_id, '') = ifnull(?, '')
      AND cases_sha256 = ? AND holdout_cases_sha256 = ? AND provider_policy_sha256 = ?
      AND budget_sha256 = ? AND evaluation_contract_sha256 = ? AND frozen_input_sha256 = ?`)
    .bind(targetState, transition.next.lockVersion, updatedAt, snapshot.id, snapshot.state,
      expectedLockVersion, snapshot.baselineVersionId, snapshot.baselineContentSha256,
      snapshot.candidateVersionId, snapshot.casesSha256, snapshot.holdoutCasesSha256,
      snapshot.providerPolicySha256, snapshot.budgetSha256, snapshot.evaluationContractSha256,
      snapshot.frozenInputSha256).run();
  if (Number(result.meta.changes ?? 0) !== 1) throw stateTransitionError(["DATABASE_CAS_FAILED"]);
  await insertEvent(db, {
    experimentId: snapshot.id,
    eventType: `experiment.${targetState}`,
    fromState: snapshot.state,
    toState: targetState,
    actorKind: actor.kind,
    actorId: actor.id,
    inputSha256,
  });
  return experimentRow(db, snapshot.id);
}

async function blockExperimentAfterFailure(
  db: D1Database,
  experimentId: string,
  inputSha256: string,
  error: ImprovementApiError,
) {
  try {
    const row = await experimentRow(db, experimentId);
    const state = rowText(row, "state") as MetaExperimentState;
    if (state !== "generating" && state !== "evaluating") return;
    const egressGuardFailure = [
      "MODEL_EGRESS_GUARD_REJECTED",
      "EXPERIMENT_CHANGED_AFTER_EGRESS",
      "FROZEN_BASELINE_STALE",
    ].includes(error.code);
    await transitionExperimentState(db, row, "blocked", rowNumber(row, "lock_version"),
      { kind: "system", id: egressGuardFailure ? "paid-egress-guard" : "model-gateway" }, inputSha256);
    await insertEvent(db, {
      experimentId,
      eventType: egressGuardFailure ? "model.egress_guard_frozen" : "model.network_failure_frozen",
      fromState: state,
      toState: "blocked",
      actorKind: "system",
      actorId: egressGuardFailure ? "paid-egress-guard" : "model-gateway",
      payload: { errorCode: error.code, automaticRetry: false },
      inputSha256,
    });
  } catch {
    // The original safe error must remain the response; receipt finalization is authoritative.
  }
}

function gatewayEnv(provider: ModelProvider, modelId: string): ModelGatewayServerEnv {
  const source = runtimeEnv();
  if (provider === "deepseek") {
    return {
      DEEPSEEK_API_KEY: source.DEEPSEEK_API_KEY,
      DEEPSEEK_MODEL: modelId,
    };
  }
  if (provider === "qwen") return {
    DASHSCOPE_API_KEY: source.DASHSCOPE_API_KEY,
    QWEN_MODEL: modelId,
  };
  if (provider === "openai") return {
    OPENAI_API_KEY: source.OPENAI_API_KEY,
    OPENAI_FAST_MODEL: modelId,
  };
  return {
    OLLAMA_API_KEY: source.OLLAMA_API_KEY,
    OLLAMA_MODEL: modelId,
    OLLAMA_BASE_URL: source.OLLAMA_BASE_URL,
    OLLAMA_ALLOWED_HOSTS: source.OLLAMA_ALLOWED_HOSTS,
  };
}

async function invocationUsage(db: D1Database, experimentId: string) {
  const rows = await db.prepare(`SELECT input_tokens, output_tokens, estimated_cost_cny_micros,
      budget_reservation_json FROM model_invocations WHERE experiment_id = ?`)
    .bind(experimentId).all<D1Row>();
  let inputTokens = 0;
  let outputTokens = 0;
  let costMicros = 0;
  let costTracked = true;
  for (const row of rows.results) {
    const reservation = parseJson<{ estimatedInputTokens?: number; reservedOutputTokens?: number }>(
      row.budget_reservation_json,
      {},
    );
    const reservedInput = Number.isFinite(reservation.estimatedInputTokens)
      ? Math.max(0, Number(reservation.estimatedInputTokens))
      : 0;
    const reservedOutput = Number.isFinite(reservation.reservedOutputTokens)
      ? Math.max(0, Number(reservation.reservedOutputTokens))
      : 0;
    inputTokens += row.input_tokens === null ? reservedInput : Math.max(0, rowNumber(row, "input_tokens"));
    outputTokens += row.output_tokens === null ? reservedOutput : Math.max(0, rowNumber(row, "output_tokens"));
    if (row.estimated_cost_cny_micros === null) costTracked = false;
    else costMicros += Math.max(0, rowNumber(row, "estimated_cost_cny_micros"));
  }
  return {
    invocationCount: rows.results.length,
    inputTokens,
    outputTokens,
    costMicros,
    costTracked,
  };
}

async function assertInvocationBudget(
  db: D1Database,
  experimentId: string,
  budget: MetaExperimentBudget,
  messages: readonly ModelGatewayChatMessage[],
  maxOutputTokens: number,
) {
  if (Date.parse(budget.deadlineAt) <= Date.now()) {
    throw new ImprovementApiError("EXPERIMENT_BUDGET_EXPIRED", "实验预算截止时间已过", 409);
  }
  const usage = await invocationUsage(db, experimentId);
  const estimatedInput = conservativeInputTokenReservation(messages);
  if (usage.invocationCount + 1 > budget.maxInvocations
    || usage.inputTokens + estimatedInput > budget.maxInputTokens
    || usage.outputTokens + maxOutputTokens > budget.maxOutputTokens
    || (usage.costTracked && usage.costMicros > Math.round(budget.maxEstimatedCostCny * 1_000_000))) {
    throw new ImprovementApiError("EXPERIMENT_BUDGET_EXCEEDED", "本次模型调用会超过冻结预算", 409, {
      invocationCount: usage.invocationCount,
      maxInvocations: budget.maxInvocations,
    });
  }
  return { estimatedInputTokens: estimatedInput, reservedOutputTokens: maxOutputTokens };
}

type RecordedModelCall = {
  db: D1Database;
  experimentId: string;
  commandId: string;
  role: "proposer" | "execution" | "reviewer";
  provider: ModelProvider;
  modelId: string;
  promptVersionId: string;
  providerPolicySha256: string;
  budget: MetaExperimentBudget;
  messages: readonly ModelGatewayChatMessage[];
  maxOutputTokens: number;
  frozenInvocation: FrozenModelInvocationProtocol;
  targetPromptSha256: string;
  governancePromptSha256: string;
  opaqueBindingSha256: string;
  egressExpectation: {
    expectedState: "generating" | "evaluating";
    expectedCandidateVersionId: string | null;
    evaluationContractSha256: string;
    baselineActivation: FrozenBaselineActivation;
  };
  outputRef?: string;
};

async function paidEgressConflicts(input: RecordedModelCall) {
  const row = await input.db.prepare(`SELECT experiment.*,
      activation.active_version_id AS guard_active_version_id,
      activation.lock_version AS guard_activation_lock_version
    FROM meta_improvement_experiments experiment
    LEFT JOIN meta_skill_activations activation
      ON activation.skill_key = experiment.target_skill_key
    WHERE experiment.id = ? LIMIT 1`).bind(input.experimentId).first<D1Row>();
  if (!row) return { row: null, conflicts: ["EXPERIMENT_NOT_FOUND"] };
  const frozen = input.egressExpectation.baselineActivation;
  const actualCandidateId = rowNullableText(row, "candidate_version_id");
  const conflicts = [
    rowText(row, "state") !== input.egressExpectation.expectedState ? "EXPERIMENT_STATE_CHANGED" : null,
    rowText(row, "decision") !== "pending" ? "DECISION_NOT_PENDING" : null,
    rowText(row, "target_skill_key") !== frozen.skillKey ? "TARGET_SKILL_CHANGED" : null,
    rowText(row, "baseline_version_id") !== frozen.activeVersionId ? "FROZEN_BASELINE_CHANGED" : null,
    rowText(row, "evaluation_contract_sha256") !== input.egressExpectation.evaluationContractSha256
      ? "EVALUATION_CONTRACT_CHANGED" : null,
    actualCandidateId !== input.egressExpectation.expectedCandidateVersionId ? "CANDIDATE_BINDING_CHANGED" : null,
    rowText(row, "guard_active_version_id") !== frozen.activeVersionId ? "ACTIVE_VERSION_CHANGED" : null,
    rowNumber(row, "guard_activation_lock_version") !== frozen.lockVersion ? "ACTIVATION_LOCK_CHANGED" : null,
  ].filter((item): item is string => item !== null);
  return { row, conflicts };
}

async function assertPaidEgressAllowed(
  input: RecordedModelCall,
  phase: "before_dispatch" | "after_checkpoint",
  inputSha256: string,
  invocationId?: string,
) {
  const check = await paidEgressConflicts(input);
  if (check.conflicts.length === 0) return;
  const row = check.row;
  const eventType = phase === "before_dispatch"
    ? "model.egress_cancelled_before_dispatch"
    : "model.response_ignored_after_experiment_change";
  if (phase === "before_dispatch" && invocationId) {
    await input.db.prepare(`UPDATE model_invocations SET state = 'cancelled', error_class = ?,
      error_summary = ?, finished_at = ? WHERE id = ? AND state = 'running'`)
      .bind("MODEL_EGRESS_GUARD_REJECTED",
        "模型尚未派发时实验状态、决定或活动基线已变化",
        isoNow(), invocationId).run();
  }
  if (phase === "after_checkpoint" && invocationId) {
    await input.db.prepare(`UPDATE model_invocations SET error_class = ?, error_summary = ?
      WHERE id = ? AND state = 'succeeded'`)
      .bind("EXPERIMENT_CHANGED_AFTER_EGRESS",
        "Provider 响应已 checkpoint，但实验状态、决定或活动基线已变化；禁止物化与后续调用",
        invocationId).run();
    await blockModelInvocationOutput(input.db, {
      invocationId,
      errorClass: "EXPERIMENT_CHANGED_AFTER_EGRESS",
      errorSummary: "Provider 响应已 checkpoint，但实验已变化，响应不得物化",
      now: isoNow(),
    });
  }
  await insertEvent(input.db, {
    experimentId: input.experimentId,
    eventType,
    fromState: row ? rowText(row, "state") : null,
    toState: row ? rowText(row, "state") : null,
    actorKind: "system",
    actorId: invocationId ?? "paid-egress-guard",
    payload: {
      role: input.role,
      commandId: input.commandId,
      conflicts: check.conflicts,
      providerDispatched: phase === "after_checkpoint",
      responseCheckpointed: phase === "after_checkpoint",
      responseIgnored: phase === "after_checkpoint",
    },
    inputSha256,
  });
  throw new ImprovementApiError(
    phase === "before_dispatch" ? "MODEL_EGRESS_GUARD_REJECTED" : "EXPERIMENT_CHANGED_AFTER_EGRESS",
    phase === "before_dispatch"
      ? "实验状态、人工决定或活动基线已变化，已取消本次模型调用"
      : "模型响应已安全 checkpoint，但实验已变化；响应已忽略且禁止后续调用",
    409,
    {
      conflicts: check.conflicts,
      providerDispatched: phase === "after_checkpoint",
      responseCheckpointed: phase === "after_checkpoint",
      retryable: false,
      automaticRetry: false,
    },
  );
}

async function callModelJson(input: RecordedModelCall): Promise<{ invocationId: string; inputSha256: string; result: ModelGatewayJsonResult }> {
  assertMetaProviderEnabled(input.provider);
  if (input.budget.maxRetriesPerInvocation !== 0) {
    throw new ImprovementApiError("AUTOMATIC_RETRY_FORBIDDEN", "元改进实验必须冻结为零自动重试", 500);
  }
  const expectedMaxOutputTokens = input.frozenInvocation.maxOutputTokens[input.role];
  if (input.frozenInvocation.adapterVersion !== MODEL_GATEWAY_ADAPTER_VERSION
    || input.frozenInvocation.sampling.temperature !== FROZEN_MODEL_SAMPLING.temperature
    || input.frozenInvocation.sampling.topP !== FROZEN_MODEL_SAMPLING.topP
    || input.maxOutputTokens !== expectedMaxOutputTokens
    || !SHA256_RE.test(input.targetPromptSha256)
    || !SHA256_RE.test(input.governancePromptSha256)
    || !SHA256_RE.test(input.opaqueBindingSha256)) {
    throw new ImprovementApiError(
      "MODEL_EGRESS_INTEGRITY_INVALID",
      "模型调用没有完整绑定冻结的 v2 适配器、采样、Prompt 与不透明映射",
      500,
    );
  }
  const reservation = await assertInvocationBudget(input.db, input.experimentId, input.budget,
    input.messages, input.maxOutputTokens);
  const invocationId = `model-invocation-${crypto.randomUUID()}`;
  const startedAt = isoNow();
  const inputSha256 = await hashJson({
    evaluationProtocolVersion: EVALUATION_PROTOCOL_VERSION,
    adapterVersion: input.frozenInvocation.adapterVersion,
    sampling: input.frozenInvocation.sampling,
    maxOutputTokens: input.maxOutputTokens,
    targetPromptSha256: input.targetPromptSha256,
    governancePromptSha256: input.governancePromptSha256,
    opaqueBindingSha256: input.opaqueBindingSha256,
    messages: input.messages,
  });
  const requestSha256 = await hashJson({
    evaluationProtocolVersion: EVALUATION_PROTOCOL_VERSION,
    adapterVersion: input.frozenInvocation.adapterVersion,
    provider: input.provider,
    modelId: input.modelId,
    messages: input.messages,
    responseFormat: "json_object",
    sampling: input.frozenInvocation.sampling,
    maxOutputTokens: input.maxOutputTokens,
    targetPromptSha256: input.targetPromptSha256,
    governancePromptSha256: input.governancePromptSha256,
    opaqueBindingSha256: input.opaqueBindingSha256,
  });
  const egressManifestSha256 = await hashJson({
    evaluationProtocolVersion: EVALUATION_PROTOCOL_VERSION,
    adapterVersion: input.frozenInvocation.adapterVersion,
    provider: input.provider,
    modelId: input.modelId,
    role: input.role,
    inputSha256,
    sampling: input.frozenInvocation.sampling,
    maxOutputTokens: input.maxOutputTokens,
    targetPromptSha256: input.targetPromptSha256,
    governancePromptSha256: input.governancePromptSha256,
    opaqueBindingSha256: input.opaqueBindingSha256,
    fields: ["target_prompt", "governance_prompt", "opaque_arm_binding", "frozen_case"],
  });
  const egressApprovalSha256 = await hashJson({
    providerPolicySha256: input.providerPolicySha256,
    commandId: input.commandId,
    automaticRetry: false,
  });
  await assertPaidEgressAllowed(input, "before_dispatch", inputSha256);
  const budgetReservationJson = canonicalJson(reservation);
  const budgetReservationSha256 = await sha256Text(budgetReservationJson);
  await input.db.prepare(`INSERT INTO model_invocations
    (id, experiment_id, command_id, purpose, role, provider, model_id, adapter_version,
     prompt_version_id, provider_policy_sha256, egress_manifest_sha256, egress_approval_sha256,
     request_sha256, input_sha256, response_sha256, output_ref, state, attempt,
     budget_reservation_json, budget_reservation_sha256, usage_json, created_at, started_at)
    VALUES (?, ?, ?, 'meta_experiment', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, 'running', 1, ?, ?, '{}', ?, ?)`)
    .bind(invocationId, input.experimentId, input.commandId, input.role, input.provider,
      input.modelId, input.frozenInvocation.adapterVersion, input.promptVersionId, input.providerPolicySha256,
      egressManifestSha256, egressApprovalSha256, requestSha256, inputSha256,
      input.outputRef ?? "", budgetReservationJson, budgetReservationSha256, startedAt, startedAt).run();
  await assertPaidEgressAllowed(input, "before_dispatch", inputSha256, invocationId);
  const started = Date.now();
  let result: ModelGatewayJsonResult;
  try {
    result = await requestModelGatewayJson({
      provider: input.provider,
      env: gatewayEnv(input.provider, input.modelId),
      messages: input.messages,
      maxOutputTokens: input.maxOutputTokens,
      sampling: input.frozenInvocation.sampling,
      timeoutMs: 120_000,
    });
  } catch (error) {
    const safe = toModelGatewaySafeError(error);
    await input.db.prepare(`UPDATE model_invocations SET state = 'failed', latency_ms = ?,
      http_status = ?, error_class = ?, error_summary = ?, finished_at = ? WHERE id = ?`)
      .bind(Math.max(0, Date.now() - started), safe.upstreamStatus ?? null,
        safe.code, safe.message, isoNow(), invocationId).run();
    throw new ImprovementApiError(safe.code, safe.message, safe.status, {
      provider: safe.provider ?? input.provider,
      retryable: false,
      automaticRetry: false,
      ...(safe.upstreamStatus ? { upstreamStatus: safe.upstreamStatus } : {}),
    });
  }

  const responseJson = canonicalJson(result.value);
  const responseSha256 = await sha256Text(responseJson);
  const usageJson = canonicalJson(result.usage ?? {});
  const usageSha256 = await sha256Text(usageJson);
  const finishedAt = isoNow();
  const materializationKind: ModelInvocationMaterializationKind = input.role === "proposer"
    ? "candidate"
    : input.role === "execution" ? "evaluation" : "review";
  try {
    await checkpointModelInvocationOutput(input.db, {
      invocationId,
      materializationKind,
      responseJson,
      responseSha256,
      usageJson,
      usageSha256,
      now: finishedAt,
    });
    const invocationUpdated = await input.db.prepare(`UPDATE model_invocations SET state = 'succeeded', response_sha256 = ?,
      usage_json = ?, input_tokens = ?, output_tokens = ?, total_tokens = ?, latency_ms = ?,
      http_status = 200, finish_reason = ?, provider_request_id = ?, finished_at = ?
      WHERE id = ? AND state = 'running'`)
      .bind(responseSha256, usageJson, result.usage?.inputTokens ?? null,
        result.usage?.outputTokens ?? null, result.usage?.totalTokens ?? null,
        Math.max(0, Date.now() - started), result.finishReason, result.requestId,
        finishedAt, invocationId).run();
    if (Number(invocationUpdated.meta.changes ?? 0) !== 1) {
      throw new ModelInvocationCheckpointError(
        "CHECKPOINT_MATERIALIZATION_CONFLICT",
        "模型响应已 checkpoint，但 invocation 状态未能确认成功",
      );
    }
  } catch (error) {
    const checkpointCode = error instanceof ModelInvocationCheckpointError
      ? error.code
      : "PERSISTENCE_AFTER_SUCCESS_UNKNOWN";
    try {
      await input.db.prepare(`UPDATE model_invocations SET latency_ms = ?, http_status = 200,
        error_class = ?, error_summary = ?, finish_reason = ?, provider_request_id = ?,
        finished_at = ? WHERE id = ? AND state = 'running'`)
        .bind(Math.max(0, Date.now() - started), checkpointCode,
          "Provider 已成功返回，但本地 checkpoint/调用状态持久化结果未知",
          result.finishReason, result.requestId, finishedAt, invocationId).run();
    } catch {
      // Preserve the original persistence uncertainty without a second egress.
    }
    throw new ImprovementApiError(
      "MODEL_RESPONSE_PERSISTENCE_UNKNOWN",
      "Provider 已成功返回，但本地响应持久化结果未知；禁止自动重试",
      500,
      {
        provider: input.provider,
        checkpointCode,
        outcomeUnknown: true,
        retryable: false,
        automaticRetry: false,
      },
    );
  }

  const actualUsage = await invocationUsage(input.db, input.experimentId);
  if (actualUsage.invocationCount > input.budget.maxInvocations
    || actualUsage.inputTokens > input.budget.maxInputTokens
    || actualUsage.outputTokens > input.budget.maxOutputTokens) {
    await markInvocationInconclusive(input.db, invocationId, "EXPERIMENT_BUDGET_BREACHED",
      "Provider 报告的实际用量超过冻结预算，已冻结后续调用");
    await blockModelInvocationOutput(input.db, {
      invocationId,
      errorClass: "EXPERIMENT_BUDGET_BREACHED",
      errorSummary: "实际 token 用量超过冻结预算",
      now: isoNow(),
    });
    throw new ImprovementApiError("EXPERIMENT_BUDGET_BREACHED", "实际模型用量超过冻结预算，实验已停止", 409, {
      retryable: false,
      automaticRetry: false,
      inputTokens: actualUsage.inputTokens,
      outputTokens: actualUsage.outputTokens,
    });
  }
  await assertPaidEgressAllowed(input, "after_checkpoint", inputSha256, invocationId);
  return { invocationId, inputSha256, result };
}

async function markInvocationInconclusive(
  db: D1Database,
  invocationId: string,
  code: string,
  message: string,
) {
  await db.prepare(`UPDATE model_invocations SET state = 'inconclusive', error_class = ?,
    error_summary = ?, finished_at = COALESCE(finished_at, ?) WHERE id = ?`)
    .bind(code, message, isoNow(), invocationId).run();
  await blockModelInvocationOutput(db, {
    invocationId,
    errorClass: code,
    errorSummary: message,
    now: isoNow(),
  });
}

async function providerProbeStatus(db: D1Database, provider: ModelProvider) {
  const row = await db.prepare(`SELECT * FROM model_invocations
    WHERE purpose = 'provider_probe' AND provider = ? ORDER BY created_at DESC LIMIT 1`)
    .bind(provider).first<D1Row>();
  if (!row) return null;
  const state = rowText(row, "state");
  return {
    provider,
    model: rowText(row, "model_id"),
    result: state === "succeeded" ? "pass" : state === "failed" ? "fail" : "inconclusive",
    markerMatched: state === "succeeded",
    latencyMs: row.latency_ms === null ? null : rowNumber(row, "latency_ms"),
    testedAt: rowText(row, "finished_at") || rowText(row, "created_at"),
    usage: parseJson<JsonObject>(row.usage_json, {}),
    errorCode: rowNullableText(row, "error_class"),
  };
}

async function providerDashboardStatus(db: D1Database, provider: ModelProvider) {
  const status = getModelGatewayProviderStatus(provider, runtimeEnv());
  const lastTest = await providerProbeStatus(db, provider);
  const enabled = !isExtendedModelProvider(provider) || extendedProvidersEnabled();
  const availability = !enabled
    ? "disabled"
    : !status.configured
    ? "not_configured"
    : lastTest?.result === "fail" ? "degraded" : status.ready ? "ready" : "unavailable";
  return {
    id: provider,
    label: provider === "deepseek" ? "DeepSeek"
      : provider === "qwen" ? "Qwen / DashScope"
        : provider === "openai" ? "OpenAI"
          : "Ollama（本地网络）",
    enabled,
    configured: status.configured,
    status: availability,
    defaultModel: status.model || null,
    allowedModels: status.model ? [status.model] : [],
    lastTest,
  };
}

async function testProviderAction(
  db: D1Database,
  payload: JsonObject,
  commandId: string,
  requestSha256: string,
) {
  if (!isMetaModelProvider(payload.provider)) {
    throw new ImprovementApiError("PROVIDER_INVALID", "provider 必须是 deepseek、qwen、openai 或 ollama", 400);
  }
  const provider = payload.provider;
  assertMetaProviderEnabled(provider);
  const status = getModelGatewayProviderStatus(provider, runtimeEnv());
  const invocationId = `model-invocation-${crypto.randomUUID()}`;
  const now = isoNow();
  const markerInputSha256 = await hashJson({ marker: { ok: true } });
  const egressManifestSha256 = await hashJson({ provider, model: status.model, purpose: "provider_probe" });
  const egressApprovalSha256 = await hashJson({ commandId, requestSha256, automaticRetry: false });
  const reservationJson = canonicalJson({ maxOutputTokens: 64, attempts: 1 });
  await db.prepare(`INSERT INTO model_invocations
    (id, experiment_id, command_id, purpose, role, provider, model_id, adapter_version,
     prompt_version_id, provider_policy_sha256, egress_manifest_sha256, egress_approval_sha256,
     request_sha256, input_sha256, response_sha256, output_ref, state, attempt,
     budget_reservation_json, budget_reservation_sha256, usage_json, created_at, started_at)
    VALUES (?, NULL, ?, 'provider_probe', 'probe', ?, ?, ?, NULL, NULL, ?, ?, ?, ?, NULL,
      '', 'running', 1, ?, ?, '{}', ?, ?)`)
    .bind(invocationId, commandId, provider, status.model, MODEL_GATEWAY_ADAPTER_VERSION,
      egressManifestSha256, egressApprovalSha256, requestSha256, markerInputSha256,
      reservationJson, await sha256Text(reservationJson), now, now).run();
  const probe = await probeModelGatewayProvider(provider, runtimeEnv(), { timeoutMs: 30_000 });
  if (!probe.ok) {
    const safe = probe.error ?? {
      code: "MODEL_PROBE_FAILED" as const,
      message: "模型连通测试失败",
      status: 502,
      retryable: false,
    };
    const upstreamStatus = "upstreamStatus" in safe ? safe.upstreamStatus ?? null : null;
    await db.prepare(`UPDATE model_invocations SET state = 'failed', latency_ms = ?,
      http_status = ?, error_class = ?, error_summary = ?, finished_at = ? WHERE id = ?`)
      .bind(probe.latencyMs, upstreamStatus, safe.code, safe.message,
        probe.checkedAt, invocationId).run();
    throw new ImprovementApiError(safe.code, safe.message, safe.status, {
      provider,
      automaticRetry: false,
      retryable: false,
    });
  }
  const responseJson = canonicalJson({ ok: true });
  const responseSha256 = await sha256Text(responseJson);
  const usageJson = canonicalJson({});
  try {
    await checkpointModelInvocationOutput(db, {
      invocationId,
      materializationKind: "probe",
      responseJson,
      responseSha256,
      usageJson,
      usageSha256: await sha256Text(usageJson),
      now: probe.checkedAt,
    });
    await db.prepare(`UPDATE model_invocations SET state = 'succeeded', response_sha256 = ?,
      usage_json = ?, latency_ms = ?, http_status = 200, finish_reason = 'stop', provider_request_id = ?,
      finished_at = ? WHERE id = ? AND state = 'running'`)
      .bind(responseSha256, usageJson, probe.latencyMs, probe.requestId ?? null,
        probe.checkedAt, invocationId).run();
    await markModelInvocationOutputMaterialized(db, {
      invocationId,
      materializationRef: "",
      now: probe.checkedAt,
    });
  } catch (error) {
    const checkpointCode = error instanceof ModelInvocationCheckpointError
      ? error.code
      : "PERSISTENCE_AFTER_SUCCESS_UNKNOWN";
    throw new ImprovementApiError(
      "MODEL_RESPONSE_PERSISTENCE_UNKNOWN",
      "Provider probe 已成功，但本地响应持久化结果未知；禁止自动重试",
      500,
      { provider, checkpointCode, outcomeUnknown: true, retryable: false, automaticRetry: false },
    );
  }
  return {
    test: await providerProbeStatus(db, provider),
    provider: await providerDashboardStatus(db, provider),
  };
}

async function createExperimentAction(
  db: D1Database,
  payload: JsonObject,
  actorId: string,
  requestSha256: string,
) {
  const targetSkillKey = requiredText(payload.targetSkillKey, "targetSkillKey", 160);
  if (!(targetSkillKey in TARGET_ROLES)) {
    throw new ImprovementApiError("TARGET_SKILL_UNSUPPORTED", "目标 Skill 不在元改进 allowlist", 400);
  }
  const objective = requiredText(payload.objective, "objective", 4_000);
  const articleId = payload.articleId === null || payload.articleId === undefined
    ? null
    : requiredText(payload.articleId, "articleId", 160);
  const failureEvidenceRefs = stringList(payload.failureEvidenceRefs ?? [], "failureEvidenceRefs", {
    maximumItems: 50,
    maximumLength: 300,
  });
  const cases = parseEvaluationCases(payload.evaluationCases);
  const baselineVersion = requiredText(payload.baselineVersion, "baselineVersion", 160);
  const baselineSha256 = requiredSha256(payload.baselineSha256, "baselineSha256");
  const activeTarget = await activeSkillRow(db, targetSkillKey);
  if (rowText(activeTarget, "version") !== baselineVersion
    || rowText(activeTarget, "content_sha256") !== baselineSha256) {
    throw new ImprovementApiError("BASELINE_STALE", "客户端基线不是当前 activation 指针所指版本", 409, {
      activeVersion: rowText(activeTarget, "version"),
      activeSha256: rowText(activeTarget, "content_sha256"),
    });
  }
  const proposerProvider = payload.proposerProvider;
  const executionProvider = payload.executionProvider;
  const reviewerProvider = payload.reviewerProvider;
  if (!isMetaModelProvider(proposerProvider)
    || !isMetaModelProvider(executionProvider)
    || !isMetaModelProvider(reviewerProvider)) {
    throw new ImprovementApiError("PROVIDER_POLICY_INVALID", "Provider 策略包含不支持的 provider", 400);
  }
  const providerPolicy: MetaProviderPolicy = {
    proposerProvider,
    proposerModelId: getModelGatewayProviderStatus(proposerProvider, runtimeEnv()).model,
    executionProvider,
    executionModelId: getModelGatewayProviderStatus(executionProvider, runtimeEnv()).model,
    reviewerProvider,
    reviewerModelId: getModelGatewayProviderStatus(reviewerProvider, runtimeEnv()).model,
    adapterVersion: MODEL_GATEWAY_ADAPTER_VERSION,
  };
  const providerErrors = validateMetaProviderPolicy(providerPolicy);
  if (providerErrors.length > 0) {
    throw new ImprovementApiError("PROVIDER_POLICY_INVALID", "Provider 策略无效", 400, { errors: providerErrors });
  }
  assertMetaProviderEnabled(proposerProvider);
  assertMetaProviderEnabled(executionProvider);
  assertMetaProviderEnabled(reviewerProvider);
  const budgetCalls = requiredInteger(payload.budgetCalls, "budgetCalls", 3, 30);
  const requiredCalls = 2 + cases.length * 2;
  if (budgetCalls < requiredCalls) {
    throw new ImprovementApiError("BUDGET_TOO_SMALL", `一个候选、双臂用例与一次盲审至少需要 ${requiredCalls} 次调用`, 400);
  }
  const budget: MetaExperimentBudget = {
    maxInvocations: budgetCalls,
    maxInputTokens: budgetCalls * 16_000,
    maxOutputTokens: budgetCalls * 4_096,
    maxEstimatedCostCny: 100,
    maxCandidates: 1,
    maxRetriesPerInvocation: 0,
    deadlineAt: new Date(Date.now() + 24 * 60 * 60 * 1_000).toISOString(),
  };
  const budgetErrors = validateMetaExperimentBudget(budget);
  if (budgetErrors.length > 0) {
    throw new ImprovementApiError("BUDGET_INVALID", "实验预算无效", 400, { errors: budgetErrors });
  }
  const proposerHarness = await activeSkillRow(db, "meta.candidate-proposer");
  const governanceExecutorHarness = await activeSkillRow(db, "meta.governance-executor");
  const governanceReviewerHarness = await activeSkillRow(db, "meta.governance-reviewer");
  const harness = (skillKey: string, row: D1Row): FrozenHarness => ({
    skillKey,
    versionId: rowText(row, "id"),
    contentSha256: rowText(row, "content_sha256"),
  });
  const evaluationContract: EvaluationContract = {
    schemaVersion: META_IMPROVEMENT_SCHEMA_VERSION,
    evaluationProtocolVersion: EVALUATION_PROTOCOL_VERSION,
    evaluator: LITERAL_EVALUATOR_KEY,
    minimumWeightedScore: 0,
    articleId,
    failureEvidenceRefs,
    baselineActivation: {
      skillKey: targetSkillKey,
      activeVersionId: rowText(activeTarget, "id"),
      lockVersion: rowNumber(activeTarget, "activation_lock_version"),
    },
    harnessVersions: {
      proposer: harness("meta.candidate-proposer", proposerHarness),
      governanceExecutor: harness("meta.governance-executor", governanceExecutorHarness),
      governanceReviewer: harness("meta.governance-reviewer", governanceReviewerHarness),
    },
    modelInvocation: {
      adapterVersion: MODEL_GATEWAY_ADAPTER_VERSION,
      sampling: { ...FROZEN_MODEL_SAMPLING },
      maxOutputTokens: { ...FROZEN_MAX_OUTPUT_TOKENS },
    },
    cases: cases.map(({ id, requiredSignals, forbiddenSignals, holdout }) => ({
      id,
      requiredSignals,
      forbiddenSignals,
      holdout,
    })),
  };
  const holdoutCases = cases.filter((item) => item.holdout);
  const casesJson = canonicalJson(cases);
  const holdoutCasesJson = canonicalJson(holdoutCases);
  const providerPolicyJson = canonicalJson(providerPolicy);
  const budgetJson = canonicalJson(budget);
  const evaluationContractJson = canonicalJson(evaluationContract);
  const casesSha256 = await sha256Text(casesJson);
  const holdoutCasesSha256 = await sha256Text(holdoutCasesJson);
  const providerPolicySha256 = await sha256Text(providerPolicyJson);
  const budgetSha256 = await sha256Text(budgetJson);
  const evaluationContractSha256 = await sha256Text(evaluationContractJson);
  const baselineVersionId = rowText(activeTarget, "id");
  const frozenInputSha256 = await hashJson({
    targetSkillKey,
    baselineVersionId,
    baselineContentSha256: baselineSha256,
    casesSha256,
    holdoutCasesSha256,
    providerPolicySha256,
    budgetSha256,
    evaluationContractSha256,
  });
  const experimentId = `meta-experiment-${crypto.randomUUID()}`;
  const now = isoNow();
  const inserted = await db.prepare(`INSERT INTO meta_improvement_experiments
    (id, target_skill_key, title, objective, hypothesis, baseline_version_id,
     baseline_content_sha256, candidate_version_id, cases_json, cases_sha256,
     holdout_cases_json, holdout_cases_sha256, provider_policy_json, provider_policy_sha256,
     budget_json, budget_sha256, evaluation_contract_json, evaluation_contract_sha256,
     frozen_input_sha256, proposer_invocation_id, reviewer_invocation_id, state, decision,
     human_decision_note, human_decided_by, human_decided_at, lock_version, created_by,
     created_at, updated_at, completed_at)
    SELECT ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL,
      'baselined', 'pending', '', NULL, NULL, 1, ?, ?, ?, NULL
    WHERE EXISTS (
      SELECT 1 FROM meta_skill_activations
      WHERE skill_key = ? AND active_version_id = ? AND lock_version = ?
    )`)
    .bind(experimentId, targetSkillKey, `${TARGET_LABELS[targetSkillKey]}元改进`, objective,
      `在冻结用例与字面信号下改进：${objective}`, baselineVersionId, baselineSha256,
      casesJson, casesSha256, holdoutCasesJson, holdoutCasesSha256, providerPolicyJson,
      providerPolicySha256, budgetJson, budgetSha256, evaluationContractJson,
      evaluationContractSha256, frozenInputSha256, actorId, now, now, targetSkillKey,
      baselineVersionId, rowNumber(activeTarget, "activation_lock_version")).run();
  if (Number(inserted.meta.changes ?? 0) !== 1) {
    throw new ImprovementApiError("BASELINE_CAS_CONFLICT", "创建实验时活动基线已变化", 409);
  }
  await insertEvent(db, {
    experimentId,
    eventType: "experiment.created",
    fromState: null,
    toState: "baselined",
    actorKind: "human",
    actorId,
    payload: { baselineVersionId, baselineSha256, automaticRetry: false },
    inputSha256: requestSha256,
  });
  return experimentId;
}

function proposalContract(value: ModelGatewayJsonObject) {
  if (value.schemaVersion !== META_PROPOSAL_SCHEMA_VERSION
    || value.candidateOnly !== true
    || value.externalSideEffects !== false) {
    throw new ImprovementApiError("PROPOSAL_CONTRACT_INVALID", "候选生成结果未满足 candidate-only 合同", 502);
  }
  const candidatePrompt = requiredText(value.candidatePrompt, "candidatePrompt", 120_000);
  const changeSummary = stringList(value.changeSummary ?? [], "changeSummary", {
    required: true,
    maximumItems: 30,
    maximumLength: 500,
  });
  return {
    candidatePrompt,
    contract: {
      schemaVersion: META_PROPOSAL_SCHEMA_VERSION,
      hypothesis: requiredText(value.hypothesis, "hypothesis", 4_000),
      changeSummary,
      expectedSignals: Array.isArray(value.expectedSignals) ? value.expectedSignals.slice(0, 30) : [],
      evidenceRefs: Array.isArray(value.evidenceRefs) ? value.evidenceRefs.slice(0, 50) : [],
      risks: Array.isArray(value.risks) ? value.risks.slice(0, 30) : [],
      candidateOnly: true,
      externalSideEffects: false,
    },
    title: changeSummary[0].slice(0, 120),
    summary: changeSummary.join("；").slice(0, 2_000),
  };
}

async function generateCandidateAction(
  db: D1Database,
  payload: JsonObject,
  actorId: string,
  commandId: string,
  requestSha256: string,
) {
  const experimentId = requiredText(payload.experimentId, "experimentId", 160);
  const expectedLockVersion = requiredInteger(payload.expectedLockVersion, "expectedLockVersion", 1, Number.MAX_SAFE_INTEGER);
  let row = await experimentRow(db, experimentId);
  const state = rowText(row, "state") as MetaExperimentState;
  if (!(["baselined", "blocked"] as MetaExperimentState[]).includes(state)
    || rowNullableText(row, "candidate_version_id") !== null) {
    throw new ImprovementApiError("EXPERIMENT_NOT_GENERATABLE", "实验当前不能生成新候选", 409);
  }
  const initialContract = assertEvaluationProtocolV2(parseEvaluationContract(row));
  await assertFrozenBaselineActivation(db, row, initialContract);
  row = await transitionExperimentState(db, row, "generating", expectedLockVersion,
    { kind: "human", id: actorId }, requestSha256);
  try {
    const policy = parseProviderPolicy(row);
    const budget = parseBudget(row);
    const contract = assertEvaluationProtocolV2(parseEvaluationContract(row));
    const proposerVersion = await versionRow(db, contract.harnessVersions.proposer.versionId);
    if (rowText(proposerVersion, "content_sha256") !== contract.harnessVersions.proposer.contentSha256) {
      throw new ImprovementApiError("FROZEN_HARNESS_CHANGED", "冻结的 proposer harness 内容不匹配", 409);
    }
    const cases = parseJson<EvaluationCase[]>(row.cases_json, []);
    const baseline = await versionRow(db, rowText(row, "baseline_version_id"));
    const messages: ModelGatewayChatMessage[] = [
      { role: "system", content: rowText(proposerVersion, "prompt_text") },
      {
        role: "user",
        content: canonicalJson({
          schemaVersion: META_IMPROVEMENT_SCHEMA_VERSION,
          experimentId,
          targetSkillKey: rowText(row, "target_skill_key"),
          baseline: {
            versionId: rowText(row, "baseline_version_id"),
            contentSha256: rowText(row, "baseline_content_sha256"),
            promptText: rowText(await versionRow(db, rowText(row, "baseline_version_id")), "prompt_text"),
          },
          objective: rowText(row, "objective"),
          failureEvidenceRefs: contract.failureEvidenceRefs,
          developmentCases: cases.filter((item) => !item.holdout),
          evaluationContract: {
            evaluator: contract.evaluator,
            minimumWeightedScore: contract.minimumWeightedScore,
          },
          limits: { candidateOnly: true, externalSideEffects: false, automaticRetry: false },
        }),
      },
    ];
    const call = await callModelJson({
      db,
      experimentId,
      commandId: `${commandId}:proposer`,
      role: "proposer",
      provider: policy.proposerProvider,
      modelId: policy.proposerModelId,
      promptVersionId: rowText(proposerVersion, "id"),
      providerPolicySha256: rowText(row, "provider_policy_sha256"),
      budget,
      messages,
      maxOutputTokens: contract.modelInvocation.maxOutputTokens.proposer,
      frozenInvocation: contract.modelInvocation,
      targetPromptSha256: rowText(baseline, "prompt_sha256"),
      governancePromptSha256: rowText(proposerVersion, "prompt_sha256"),
      opaqueBindingSha256: await hashJson({
        evaluationProtocolVersion: contract.evaluationProtocolVersion,
        experimentId,
        role: "proposer",
        frozenInputSha256: rowText(row, "frozen_input_sha256"),
      }),
      egressExpectation: {
        expectedState: "generating",
        expectedCandidateVersionId: null,
        evaluationContractSha256: rowText(row, "evaluation_contract_sha256"),
        baselineActivation: contract.baselineActivation,
      },
    });
    let proposal;
    try {
      proposal = proposalContract(call.result.value);
    } catch (error) {
      await markInvocationInconclusive(db, call.invocationId, "PROPOSAL_CONTRACT_INVALID", "候选生成结果未满足输出合同");
      throw error;
    }
    const promptSha256 = await sha256Text(proposal.candidatePrompt);
    const candidateContract = {
      ...proposal.contract,
      experimentId,
      parentVersionId: rowText(baseline, "id"),
      title: proposal.title,
      summary: proposal.summary,
    };
    const candidateContractJson = canonicalJson(candidateContract);
    const candidateContractSha256 = await sha256Text(candidateContractJson);
    const contentSha256 = await hashJson({ promptSha256, contractSha256: candidateContractSha256 });
    const candidateId = `meta-version-${crypto.randomUUID()}`;
    const now = isoNow();
    const current = experimentSnapshot(row);
    const synthetic = { ...current, candidateVersionId: candidateId };
    const expected = experimentExpectation(synthetic, "generating", current.lockVersion, candidateId);
    const transition = transitionMetaImprovementExperiment(synthetic, "candidate_ready", expected);
    if (!transition.ok) throw stateTransitionError(transition.conflicts);
    const eventId = `meta-event-${crypto.randomUUID()}`;
    await db.batch([
      db.prepare(`INSERT INTO meta_skill_versions
        (id, skill_key, version, role, parent_version_id, prompt_text, prompt_sha256,
         contract_json, contract_sha256, content_sha256, created_by_kind, created_by_provider,
         source_invocation_id, is_candidate, status, decision_experiment_id, activated_at,
         decided_at, lock_version, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'model', ?, ?, 1, 'candidate', NULL, NULL, NULL, 1, ?)`)
        .bind(candidateId, rowText(row, "target_skill_key"), `candidate-${now.replace(/[-:.TZ]/gu, "").slice(0, 14)}`,
          rowText(baseline, "role"), rowText(baseline, "id"), proposal.candidatePrompt,
          promptSha256, candidateContractJson, candidateContractSha256, contentSha256,
          policy.proposerProvider, call.invocationId, now),
      db.prepare(`UPDATE model_invocations SET output_ref = ? WHERE id = ? AND state = 'succeeded'`)
        .bind(`meta_skill_versions:${candidateId}`, call.invocationId),
      db.prepare(`UPDATE meta_improvement_experiments SET candidate_version_id = ?, proposer_invocation_id = ?,
        state = 'candidate_ready', lock_version = ?, updated_at = ?
        WHERE id = ? AND state = 'generating' AND lock_version = ? AND candidate_version_id IS NULL
          AND frozen_input_sha256 = ?`)
        .bind(candidateId, call.invocationId, transition.next.lockVersion, now, experimentId,
          current.lockVersion, current.frozenInputSha256),
      db.prepare(`INSERT INTO meta_improvement_events
        (id, experiment_id, event_type, from_state, to_state, actor_kind, actor_id,
         payload_json, input_sha256, created_at)
        VALUES (?, ?, 'candidate.generated', 'generating', 'candidate_ready', 'model',
          CASE WHEN EXISTS (
            SELECT 1 FROM meta_improvement_experiments WHERE id = ? AND state = 'candidate_ready'
              AND candidate_version_id = ? AND lock_version = ?
          ) THEN ? ELSE NULL END, ?, ?, ?)`)
        .bind(eventId, experimentId, experimentId, candidateId, transition.next.lockVersion,
          call.invocationId, canonicalJson({ candidateId, candidateOnly: true }), requestSha256, now),
    ]);
    await markModelInvocationOutputMaterialized(db, {
      invocationId: call.invocationId,
      materializationRef: `meta_skill_versions:${candidateId}`,
      now: isoNow(),
    });
    return experimentId;
  } catch (error) {
    const safe = error instanceof ImprovementApiError
      ? error
      : new ImprovementApiError("CANDIDATE_GENERATION_FAILED", "候选生成失败", 500);
    await blockExperimentAfterFailure(db, experimentId, requestSha256, safe);
    throw safe;
  }
}

function collectArtifactText(value: unknown, output: string[] = []): string {
  if (typeof value === "string") output.push(value);
  else if (Array.isArray(value)) value.forEach((item) => collectArtifactText(item, output));
  else if (isObject(value)) Object.values(value).forEach((item) => collectArtifactText(item, output));
  return output.join("\n");
}

function validateExecutionOutput(
  value: ModelGatewayJsonObject,
  expected: { caseId: string; armToken: string; inputSha256: string },
) {
  if (value.schemaVersion !== EXECUTION_SCHEMA_VERSION
    || value.caseId !== expected.caseId
    || value.armToken !== expected.armToken
    || value.inputSha256 !== expected.inputSha256
    || value.externalSideEffects !== false
    || !("output" in value)) {
    throw new ImprovementApiError("EXECUTION_CONTRACT_INVALID", "执行模型未返回绑定当前不透明 arm token 的安全工件", 502);
  }
  return value.output;
}

async function insertDeterministicEvaluation(
  db: D1Database,
  input: {
    experimentId: string;
    pairId: string;
    caseItem: EvaluationCase;
    arm: "baseline" | "candidate";
    versionId: string;
    invocationId: string;
    contractSha256: string;
    inputSha256: string;
    modelOutput: ModelGatewayJsonObject;
    artifact: unknown;
  },
) {
  const artifactText = collectArtifactText(input.artifact) || canonicalJson(input.artifact);
  const checks = [
    ...input.caseItem.requiredSignals.map((literal) => ({
      kind: "required",
      literal,
      passed: artifactText.includes(literal),
    })),
    ...input.caseItem.forbiddenSignals.map((literal) => ({
      kind: "forbidden",
      literal,
      passed: !artifactText.includes(literal),
    })),
  ];
  const result = checks.every((check) => check.passed) ? "pass" : "fail";
  const outputSha256 = await hashJson(input.modelOutput);
  const evidence = {
    schemaVersion: META_IMPROVEMENT_SCHEMA_VERSION,
    caseId: input.caseItem.id,
    arm: input.arm,
    versionId: input.versionId,
    artifact: input.artifact,
    literalChecks: checks,
    holdout: input.caseItem.holdout,
  };
  const signalsJson = canonicalJson(checks);
  const evidenceJson = canonicalJson(evidence);
  const evaluationId = `meta-evaluation-${crypto.randomUUID()}`;
  await db.prepare(`INSERT INTO meta_improvement_evaluations
    (id, experiment_id, pair_id, case_id, arm, version_id, evaluator_kind,
     evaluator_key, provider, model_id, invocation_id, result, contract_sha256,
     input_sha256, output_sha256, signals_json, signals_sha256, evidence_json,
     evidence_sha256, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 'deterministic', ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(evaluationId, input.experimentId, input.pairId, input.caseItem.id, input.arm,
      input.versionId, LITERAL_EVALUATOR_KEY, input.invocationId, result,
      input.contractSha256, input.inputSha256, outputSha256, signalsJson,
      await sha256Text(signalsJson), evidenceJson, await sha256Text(evidenceJson), isoNow()).run();
  await db.prepare("UPDATE model_invocations SET output_ref = ? WHERE id = ?")
    .bind(`meta_improvement_evaluations:${evaluationId}`, input.invocationId).run();
  await markModelInvocationOutputMaterialized(db, {
    invocationId: input.invocationId,
    materializationRef: `meta_improvement_evaluations:${evaluationId}`,
    now: isoNow(),
  });
  return { evaluationId, result, evidence, evidenceSha256: await sha256Text(evidenceJson) };
}

async function deterministicRows(db: D1Database, experimentId: string) {
  const result = await db.prepare(`SELECT * FROM meta_improvement_evaluations
    WHERE experiment_id = ? AND evaluator_kind = 'deterministic'
      AND evaluator_key = ? ORDER BY created_at ASC`)
    .bind(experimentId, LITERAL_EVALUATOR_KEY).all<D1Row>();
  return result.results;
}

function boundedEvidenceItems(value: unknown, maximumItems: number, maximumLength: number) {
  const values = Array.isArray(value) ? value : value === null || value === undefined ? [] : [value];
  return values.slice(0, maximumItems).map((item) => {
    const serialized = typeof item === "string" ? item : canonicalJson(item);
    return serialized.trim().slice(0, maximumLength);
  }).filter(Boolean);
}

function boundedArtifactPreview(value: unknown) {
  const serialized = typeof value === "string" ? value : canonicalJson(value);
  return serialized.length <= MAX_ARTIFACT_PREVIEW_CHARS
    ? serialized
    : `${serialized.slice(0, MAX_ARTIFACT_PREVIEW_CHARS)}…`;
}

function literalChecksForDashboard(row: D1Row) {
  const checks = parseJson<unknown[]>(row.signals_json, []);
  return checks.slice(0, 60).flatMap((item) => {
    if (!isObject(item) || !["required", "forbidden"].includes(String(item.kind))) return [];
    const literal = cleanText(item.literal, 300);
    if (!literal) return [];
    return [{
      kind: String(item.kind) as "required" | "forbidden",
      literal,
      passed: item.passed === true,
    }];
  });
}

async function humanAdoptionEvidenceBundle(db: D1Database, row: D1Row) {
  const experimentId = rowText(row, "id");
  const candidateId = rowNullableText(row, "candidate_version_id");
  if (!candidateId) return null;
  const candidate = await versionRow(db, candidateId);
  const activation = await activationRow(db, rowText(row, "target_skill_key"));
  const cases = parseJson<EvaluationCase[]>(row.cases_json, []);
  const deterministic = await deterministicRows(db, experimentId);
  const signals: MetaImprovementSignal[] = [];
  const caseEvidence = [];
  for (const caseItem of cases) {
    const baseline = deterministic.find((item) => rowText(item, "case_id") === caseItem.id && rowText(item, "arm") === "baseline");
    const candidateArm = deterministic.find((item) => rowText(item, "case_id") === caseItem.id && rowText(item, "arm") === "candidate");
    if (!baseline || !candidateArm || rowText(baseline, "pair_id") !== rowText(candidateArm, "pair_id")) continue;
    const baselineEvidence = parseJson<JsonObject>(baseline.evidence_json, {});
    const candidateEvidence = parseJson<JsonObject>(candidateArm.evidence_json, {});
    const baselineArtifact = baselineEvidence.artifact;
    const candidateArtifact = candidateEvidence.artifact;
    signals.push({
      id: `literal-pass:${caseItem.id}`,
      label: `${caseItem.id} 字面合同通过`,
      baseline: rowText(baseline, "result") === "pass" ? 1 : 0,
      candidate: rowText(candidateArm, "result") === "pass" ? 1 : 0,
      direction: "higher_is_better",
      weight: caseItem.holdout ? 2 : 1,
      minimumDelta: 0,
      maximumRegression: 0,
      critical: caseItem.holdout,
    });
    caseEvidence.push({
      caseId: caseItem.id,
      pairId: rowText(baseline, "pair_id"),
      holdout: caseItem.holdout,
      inputPreview: boundedArtifactPreview(caseItem.input),
      requiredSignals: caseItem.requiredSignals.slice(0, 30),
      forbiddenSignals: caseItem.forbiddenSignals.slice(0, 30),
      baseline: {
        result: rowText(baseline, "result"),
        artifactPreview: boundedArtifactPreview(baselineArtifact),
        artifactSha256: await hashJson(baselineArtifact),
        evidenceSha256: rowText(baseline, "evidence_sha256"),
        literalChecks: literalChecksForDashboard(baseline),
      },
      candidate: {
        result: rowText(candidateArm, "result"),
        artifactPreview: boundedArtifactPreview(candidateArtifact),
        artifactSha256: await hashJson(candidateArtifact),
        evidenceSha256: rowText(candidateArm, "evidence_sha256"),
        literalChecks: literalChecksForDashboard(candidateArm),
      },
    });
  }
  const review = await db.prepare(`SELECT * FROM meta_improvement_evaluations
    WHERE experiment_id = ? AND evaluator_kind = 'model' AND evaluator_key = ?
    ORDER BY created_at DESC LIMIT 1`).bind(experimentId, BLIND_REVIEWER_KEY).first<D1Row>();
  const reviewEvidence = review ? parseJson<JsonObject>(review.evidence_json, {}) : null;
  const reviewPayload = reviewEvidence && isObject(reviewEvidence.review) ? reviewEvidence.review : null;
  const reviewer = review && reviewPayload
    ? {
        provider: rowText(review, "provider"),
        model: rowText(review, "model_id"),
        result: rowText(review, "result"),
        preferredArm: cleanText(reviewPayload.preferredArm, 8) || "none",
        findings: boundedEvidenceItems(
          reviewPayload.contractFindings ?? reviewPayload.findings ?? reviewPayload.rationale,
          20,
          800,
        ),
        criticalRisks: boundedEvidenceItems(reviewPayload.criticalRisks, 20, 500),
        evidenceRefs: boundedEvidenceItems(reviewPayload.evidenceRefs, 50, 500),
        evidenceSha256: rowText(review, "evidence_sha256"),
      }
    : null;
  const signalScore = scoreMetaImprovementSignals(signals);
  const coverageComplete = cases.length >= 2
    && cases.some((item) => item.holdout)
    && caseEvidence.length === cases.length
    && new Set(caseEvidence.map((item) => item.caseId)).size === cases.length;
  const bundle = {
    schemaVersion: HUMAN_EVIDENCE_SCHEMA_VERSION,
    experimentId,
    candidate: {
      id: candidateId,
      parentVersionId: rowNullableText(candidate, "parent_version_id"),
      contentSha256: rowText(candidate, "content_sha256"),
    },
    activation: {
      skillKey: rowText(activation, "skill_key"),
      activeVersionId: rowText(activation, "active_version_id"),
      lockVersion: rowNumber(activation, "lock_version"),
    },
    coverage: {
      requiredCases: cases.length,
      pairedCases: caseEvidence.length,
      holdoutCases: cases.filter((item) => item.holdout).length,
      complete: coverageComplete,
    },
    signalSummary: {
      passed: signalScore.passed,
      weightedScore: signalScore.weightedScore,
      totalWeight: signalScore.totalWeight,
      failedSignals: signalScore.failedSignals,
      criticalRegressions: signalScore.criticalRegressions,
    },
    cases: caseEvidence,
    reviewer,
    complete: coverageComplete
      && reviewer !== null
      && rowText(activation, "active_version_id") === rowText(row, "baseline_version_id"),
  };
  return {
    ...bundle,
    evidenceBundleSha256: await hashJson(bundle),
  };
}

function validateReviewerOutput(value: ModelGatewayJsonObject) {
  if (value.schemaVersion !== META_REVIEW_SCHEMA_VERSION
    || !["pass", "fail", "inconclusive"].includes(String(value.result))
    || !["A", "B", "none"].includes(String(value.preferredArm))
    || value.advisoryOnly !== true) {
    throw new ImprovementApiError("REVIEW_CONTRACT_INVALID", "盲审模型未返回 advisory-only 审查合同", 502);
  }
  return {
    result: String(value.result) as "pass" | "fail" | "inconclusive",
    preferredArm: String(value.preferredArm) as "A" | "B" | "none",
  };
}

async function runPairwiseEvaluationAction(
  db: D1Database,
  payload: JsonObject,
  actorId: string,
  commandId: string,
  requestSha256: string,
) {
  const experimentId = requiredText(payload.experimentId, "experimentId", 160);
  const candidateId = requiredText(payload.candidateId, "candidateId", 160);
  const expectedLockVersion = requiredInteger(payload.expectedLockVersion, "expectedLockVersion", 1, Number.MAX_SAFE_INTEGER);
  const reviewerOnly = payload.reviewerOnly === true;
  let row = await experimentRow(db, experimentId);
  const expectedStartState = reviewerOnly ? "awaiting_human" : "candidate_ready";
  if (rowText(row, "state") !== expectedStartState
    || rowText(row, "candidate_version_id") !== candidateId) {
    throw new ImprovementApiError(
      "EXPERIMENT_NOT_EVALUATABLE",
      reviewerOnly ? "实验当前不能只补独立互审" : "实验或候选当前不能开始成对评估",
      409,
    );
  }
  const initialContract = assertEvaluationProtocolV2(parseEvaluationContract(row));
  await assertFrozenBaselineActivation(db, row, initialContract);
  if (reviewerOnly) {
    const frozenCases = parseJson<EvaluationCase[]>(row.cases_json, []);
    const frozenRows = await deterministicRows(db, experimentId);
    const deterministicComplete = frozenCases.length >= 2
      && frozenCases.some((item) => item.holdout)
      && frozenCases.every((caseItem) => {
        const baseline = frozenRows.find((item) => rowText(item, "case_id") === caseItem.id && rowText(item, "arm") === "baseline");
        const candidateArm = frozenRows.find((item) => rowText(item, "case_id") === caseItem.id && rowText(item, "arm") === "candidate");
        return Boolean(baseline && candidateArm && rowText(baseline!, "pair_id") === rowText(candidateArm!, "pair_id"));
      });
    if (!deterministicComplete) {
      throw new ImprovementApiError("PAIR_EVIDENCE_INCOMPLETE", "不能补审：冻结用例的双臂确定性证据不完整", 409);
    }
    const existingReview = await db.prepare(`SELECT id FROM meta_improvement_evaluations
      WHERE experiment_id = ? AND evaluator_kind = 'model' AND evaluator_key = ? LIMIT 1`)
      .bind(experimentId, BLIND_REVIEWER_KEY).first<D1Row>();
    if (existingReview) {
      throw new ImprovementApiError("INDEPENDENT_REVIEW_ALREADY_EXISTS", "当前实验已经有独立互审证据", 409);
    }
    const frozenPolicy = parseProviderPolicy(row);
    const reviewerReady = getModelGatewayProviderStatus(
      frozenPolicy.reviewerProvider,
      gatewayEnv(frozenPolicy.reviewerProvider, frozenPolicy.reviewerModelId),
    ).ready;
    if (!reviewerReady) {
      throw new ImprovementApiError("MODEL_PROVIDER_NOT_CONFIGURED", "独立互审尚未启动：冻结的 reviewer provider 未配置。候选与已有双臂证据均保留；配置对应 provider 后刷新实验，再在同一冻结实验上补互审。", 503, {
        provider: frozenPolicy.reviewerProvider,
      });
    }
  }
  row = await transitionExperimentState(db, row, "evaluating", expectedLockVersion,
    { kind: "human", id: actorId }, requestSha256);
  try {
    const policy = parseProviderPolicy(row);
    const budget = parseBudget(row);
    const contract = assertEvaluationProtocolV2(parseEvaluationContract(row));
    const cases = parseJson<EvaluationCase[]>(row.cases_json, []);
    if (cases.length < 2 || !cases.some((item) => item.holdout)) {
      throw new ImprovementApiError("FROZEN_CASES_INVALID", "冻结用例不满足最小覆盖要求", 500);
    }
    const baseline = await versionRow(db, rowText(row, "baseline_version_id"));
    const candidate = await versionRow(db, candidateId);
    if (rowText(candidate, "parent_version_id") !== rowText(baseline, "id")
      || rowNumber(candidate, "is_candidate") !== 1
      || rowText(candidate, "status") !== "candidate") {
      throw new ImprovementApiError("CANDIDATE_BINDING_INVALID", "候选不再绑定冻结基线或已离开候选态", 409);
    }
    const governanceExecutor = await versionRow(db, contract.harnessVersions.governanceExecutor.versionId);
    if (rowText(governanceExecutor, "content_sha256") !== contract.harnessVersions.governanceExecutor.contentSha256
      || rowText(governanceExecutor, "skill_key") !== "meta.governance-executor") {
      throw new ImprovementApiError("FROZEN_HARNESS_CHANGED", "冻结的 governance executor 内容不匹配", 409);
    }
    const governanceExecutorSystem = `${rowText(governanceExecutor, "prompt_text")}\n\n固定输出信封：返回 JSON {"schemaVersion":"${EXECUTION_SCHEMA_VERSION}","caseId":"原样回传","armToken":"原样回传","inputSha256":"原样回传","output":"仅任务结果","externalSideEffects":false}。`;
    if (!reviewerOnly) for (const caseItem of cases) {
      const pairId = `pair-${(await hashJson({ experimentId, candidateId, caseId: caseItem.id })).slice(0, 32)}`;
      for (const arm of ["baseline", "candidate"] as const) {
        const armVersion = arm === "baseline" ? baseline : candidate;
        const caseInputSha256 = await hashJson({
          evaluationProtocolVersion: contract.evaluationProtocolVersion,
          caseId: caseItem.id,
          input: caseItem.input,
          requiredSignals: caseItem.requiredSignals,
          forbiddenSignals: caseItem.forbiddenSignals,
          holdout: caseItem.holdout,
          contractSha256: rowText(row, "evaluation_contract_sha256"),
        });
        const opaqueBindingSha256 = await hashJson({
          evaluationProtocolVersion: contract.evaluationProtocolVersion,
          experimentId,
          pairId,
          caseId: caseItem.id,
          arm,
          versionId: rowText(armVersion, "id"),
          contractSha256: rowText(row, "evaluation_contract_sha256"),
          nonce: crypto.randomUUID(),
        });
        const armToken = `arm-${opaqueBindingSha256.slice(0, 40)}`;
        const messages: ModelGatewayChatMessage[] = [
          { role: "system", content: rowText(armVersion, "prompt_text") },
          { role: "system", content: governanceExecutorSystem },
          {
            role: "user",
            content: canonicalJson({
              armToken,
              inputSha256: caseInputSha256,
              caseInput: {
                id: caseItem.id,
                content: caseItem.input,
              },
            }),
          },
        ];
        const call = await callModelJson({
          db,
          experimentId,
          commandId: `${commandId}:execution:${caseItem.id}:${arm}`,
          role: "execution",
          provider: policy.executionProvider,
          modelId: policy.executionModelId,
          promptVersionId: rowText(governanceExecutor, "id"),
          providerPolicySha256: rowText(row, "provider_policy_sha256"),
          budget,
          messages,
          maxOutputTokens: contract.modelInvocation.maxOutputTokens.execution,
          frozenInvocation: contract.modelInvocation,
          targetPromptSha256: rowText(armVersion, "prompt_sha256"),
          governancePromptSha256: rowText(governanceExecutor, "prompt_sha256"),
          opaqueBindingSha256,
          egressExpectation: {
            expectedState: "evaluating",
            expectedCandidateVersionId: candidateId,
            evaluationContractSha256: rowText(row, "evaluation_contract_sha256"),
            baselineActivation: contract.baselineActivation,
          },
        });
        let artifact: unknown;
        try {
          artifact = validateExecutionOutput(call.result.value, {
            caseId: caseItem.id,
            armToken,
            inputSha256: caseInputSha256,
          });
        } catch (error) {
          await markInvocationInconclusive(db, call.invocationId, "EXECUTION_CONTRACT_INVALID", "执行工件未绑定当前 arm");
          throw error;
        }
        await insertDeterministicEvaluation(db, {
          experimentId,
          pairId,
          caseItem,
          arm,
          versionId: rowText(armVersion, "id"),
          invocationId: call.invocationId,
          contractSha256: rowText(row, "evaluation_contract_sha256"),
          inputSha256: call.inputSha256,
          modelOutput: call.result.value,
          artifact,
        });
      }
    }
    const reviewerConfigured = getModelGatewayProviderStatus(
      policy.reviewerProvider,
      gatewayEnv(policy.reviewerProvider, policy.reviewerModelId),
    ).ready;
    if (!reviewerConfigured) {
      await transitionExperimentState(db, await experimentRow(db, experimentId), "awaiting_human",
        rowNumber(await experimentRow(db, experimentId), "lock_version"),
        { kind: "system", id: "deterministic-evaluator" }, requestSha256);
      await insertEvent(db, {
        experimentId,
        eventType: "reviewer.not_configured",
        fromState: "evaluating",
        toState: "awaiting_human",
        actorKind: "system",
        actorId: "deterministic-evaluator",
        payload: { deterministicComplete: true, independentReviewPassed: false },
        inputSha256: requestSha256,
      });
      return experimentId;
    }
    const governanceReviewer = await versionRow(db, contract.harnessVersions.governanceReviewer.versionId);
    if (rowText(governanceReviewer, "content_sha256") !== contract.harnessVersions.governanceReviewer.contentSha256
      || rowText(governanceReviewer, "skill_key") !== "meta.governance-reviewer") {
      throw new ImprovementApiError("FROZEN_HARNESS_CHANGED", "冻结的 governance reviewer 内容不匹配", 409);
    }
    const evaluations = await deterministicRows(db, experimentId);
    const candidateIsA = Number.parseInt((await hashJson({ experimentId, candidateId, contract: rowText(row, "evaluation_contract_sha256") })).slice(-1), 16) % 2 === 0;
    const blindCases = cases.map((caseItem) => {
      const baselineEvaluation = evaluations.find((item) => rowText(item, "case_id") === caseItem.id && rowText(item, "arm") === "baseline");
      const candidateEvaluation = evaluations.find((item) => rowText(item, "case_id") === caseItem.id && rowText(item, "arm") === "candidate");
      if (!baselineEvaluation || !candidateEvaluation) {
        throw new ImprovementApiError("PAIR_EVIDENCE_INCOMPLETE", "成对评估缺少一个 arm 的证据", 500);
      }
      const baselineEvidence = parseJson<JsonObject>(baselineEvaluation.evidence_json, {});
      const candidateEvidence = parseJson<JsonObject>(candidateEvaluation.evidence_json, {});
      return {
        caseId: caseItem.id,
        input: caseItem.input,
        requiredSignals: caseItem.requiredSignals,
        forbiddenSignals: caseItem.forbiddenSignals,
        holdout: caseItem.holdout,
        armA: candidateIsA ? candidateEvidence.artifact : baselineEvidence.artifact,
        armB: candidateIsA ? baselineEvidence.artifact : candidateEvidence.artifact,
      };
    });
    const reviewerMessages: ModelGatewayChatMessage[] = [
      { role: "system", content: rowText(governanceReviewer, "prompt_text") },
      {
        role: "user",
        content: canonicalJson({
          schemaVersion: META_REVIEW_SCHEMA_VERSION,
          blind: true,
          evaluatorContract: {
            result: "pass only when the preferred arm is materially at least as safe and complete",
            advisoryOnly: true,
          },
          cases: blindCases,
        }),
      },
    ];
    const reviewerOpaqueBindingSha256 = await hashJson({
      evaluationProtocolVersion: contract.evaluationProtocolVersion,
      experimentId,
      reviewMapping: candidateIsA ? "opaque-a" : "opaque-b",
      candidateId,
      contractSha256: rowText(row, "evaluation_contract_sha256"),
    });
    const reviewedTargetPromptSha256 = await hashJson({
      armA: candidateIsA ? rowText(candidate, "prompt_sha256") : rowText(baseline, "prompt_sha256"),
      armB: candidateIsA ? rowText(baseline, "prompt_sha256") : rowText(candidate, "prompt_sha256"),
    });
    const reviewCall = await callModelJson({
      db,
      experimentId,
      commandId: `${commandId}:reviewer`,
      role: "reviewer",
      provider: policy.reviewerProvider,
      modelId: policy.reviewerModelId,
      promptVersionId: rowText(governanceReviewer, "id"),
      providerPolicySha256: rowText(row, "provider_policy_sha256"),
      budget,
      messages: reviewerMessages,
      maxOutputTokens: contract.modelInvocation.maxOutputTokens.reviewer,
      frozenInvocation: contract.modelInvocation,
      targetPromptSha256: reviewedTargetPromptSha256,
      governancePromptSha256: rowText(governanceReviewer, "prompt_sha256"),
      opaqueBindingSha256: reviewerOpaqueBindingSha256,
      egressExpectation: {
        expectedState: "evaluating",
        expectedCandidateVersionId: candidateId,
        evaluationContractSha256: rowText(row, "evaluation_contract_sha256"),
        baselineActivation: contract.baselineActivation,
      },
    });
    let review;
    try {
      review = validateReviewerOutput(reviewCall.result.value);
    } catch (error) {
      await markInvocationInconclusive(db, reviewCall.invocationId, "REVIEW_CONTRACT_INVALID", "盲审输出不满足 advisory-only 合同");
      throw error;
    }
    const candidateArm = candidateIsA ? "A" : "B";
    const normalizedResult = review.result === "pass" && review.preferredArm === candidateArm
      ? "pass"
      : review.result === "inconclusive" || review.preferredArm === "none" ? "inconclusive" : "fail";
    const reviewEvidence = {
      schemaVersion: META_REVIEW_SCHEMA_VERSION,
      blind: true,
      candidateArm,
      review: reviewCall.result.value,
      advisoryOnly: true,
    };
    const reviewEvidenceJson = canonicalJson(reviewEvidence);
    const reviewSignalsJson = canonicalJson([{ id: "blind-review-preference", result: normalizedResult }]);
    const reviewEvaluationId = `meta-evaluation-${crypto.randomUUID()}`;
    const reviewPairId = `review-${(await hashJson({ experimentId, candidateId })).slice(0, 32)}`;
    await db.prepare(`INSERT INTO meta_improvement_evaluations
      (id, experiment_id, pair_id, case_id, arm, version_id, evaluator_kind,
       evaluator_key, provider, model_id, invocation_id, result, contract_sha256,
       input_sha256, output_sha256, signals_json, signals_sha256, evidence_json,
       evidence_sha256, created_at)
      VALUES (?, ?, ?, '__all__', 'pair', ?, 'model', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(reviewEvaluationId, experimentId, reviewPairId, candidateId, BLIND_REVIEWER_KEY,
        policy.reviewerProvider, policy.reviewerModelId, reviewCall.invocationId,
        normalizedResult, rowText(row, "evaluation_contract_sha256"), reviewCall.inputSha256,
        await hashJson(reviewCall.result.value), reviewSignalsJson, await sha256Text(reviewSignalsJson),
        reviewEvidenceJson, await sha256Text(reviewEvidenceJson), isoNow()).run();
    await db.prepare("UPDATE model_invocations SET output_ref = ? WHERE id = ?")
      .bind(`meta_improvement_evaluations:${reviewEvaluationId}`, reviewCall.invocationId).run();
    await markModelInvocationOutputMaterialized(db, {
      invocationId: reviewCall.invocationId,
      materializationRef: `meta_improvement_evaluations:${reviewEvaluationId}`,
      now: isoNow(),
    });
    await db.prepare(`UPDATE meta_improvement_experiments SET reviewer_invocation_id = ?
      WHERE id = ? AND state = 'evaluating' AND candidate_version_id = ?`)
      .bind(reviewCall.invocationId, experimentId, candidateId).run();
    const evaluating = await experimentRow(db, experimentId);
    await transitionExperimentState(db, evaluating, "awaiting_human", rowNumber(evaluating, "lock_version"),
      { kind: "model", id: reviewCall.invocationId }, requestSha256);
    return experimentId;
  } catch (error) {
    const safe = error instanceof ImprovementApiError
      ? error
      : new ImprovementApiError("PAIRWISE_EVALUATION_FAILED", "成对评估失败", 500);
    await blockExperimentAfterFailure(db, experimentId, requestSha256, safe);
    throw safe;
  }
}

async function adoptabilityFor(
  db: D1Database,
  row: D1Row,
  expectedLockVersion: number,
  actorId: string,
  note: string,
) {
  const snapshot = experimentSnapshot(row);
  const candidateId = snapshot.candidateVersionId;
  const candidateRow = candidateId ? await versionRow(db, candidateId) : null;
  const policy = parseProviderPolicy(row);
  const cases = parseJson<EvaluationCase[]>(row.cases_json, []);
  const evaluations = await deterministicRows(db, snapshot.id);
  const deterministicPairs: DeterministicEvaluationPair[] = [];
  const signals: MetaImprovementSignal[] = [];
  for (const caseItem of cases) {
    const baseline = evaluations.find((item) => rowText(item, "case_id") === caseItem.id && rowText(item, "arm") === "baseline");
    const candidate = evaluations.find((item) => rowText(item, "case_id") === caseItem.id && rowText(item, "arm") === "candidate");
    if (!baseline || !candidate || rowText(baseline, "pair_id") !== rowText(candidate, "pair_id")) continue;
    deterministicPairs.push({
      pairId: rowText(baseline, "pair_id"),
      caseId: caseItem.id,
      contractSha256: rowText(baseline, "contract_sha256"),
      // Row result is the quality signal. Both arms reached this row only after
      // their bound execution contract was validated, so transport/execution
      // validity is kept separate from whether the baseline needs improvement.
      baselineResult: "pass",
      baselineEvidenceSha256: rowText(baseline, "evidence_sha256"),
      candidateResult: "pass",
      candidateEvidenceSha256: rowText(candidate, "evidence_sha256"),
    });
    signals.push({
      id: `literal-pass:${caseItem.id}`,
      label: `${caseItem.id} 字面合同通过`,
      baseline: rowText(baseline, "result") === "pass" ? 1 : 0,
      candidate: rowText(candidate, "result") === "pass" ? 1 : 0,
      direction: "higher_is_better",
      weight: caseItem.holdout ? 2 : 1,
      minimumDelta: 0,
      maximumRegression: 0,
      critical: caseItem.holdout,
    });
  }
  const review = await db.prepare(`SELECT * FROM meta_improvement_evaluations
    WHERE experiment_id = ? AND evaluator_kind = 'model' AND evaluator_key = ?
    ORDER BY created_at DESC LIMIT 1`).bind(snapshot.id, BLIND_REVIEWER_KEY).first<D1Row>();
  const reviewerEvaluation: ReviewerEvaluation | null = review
    ? {
        provider: rowText(review, "provider") as ModelProvider,
        result: rowText(review, "result") as ReviewerEvaluation["result"],
        evidenceSha256: rowText(review, "evidence_sha256"),
        invocationId: rowText(review, "invocation_id"),
      }
    : null;
  const signalScore = scoreMetaImprovementSignals(signals);
  const evaluationContract = parseEvaluationContract(row);
  const cas = experimentExpectation(snapshot, "awaiting_human", expectedLockVersion);
  const result = evaluateMetaImprovementAdoptability({
    experiment: snapshot,
    cas,
    candidate: candidateRow
      ? {
          id: rowText(candidateRow, "id"),
          parentVersionId: rowNullableText(candidateRow, "parent_version_id"),
          isCandidate: rowNumber(candidateRow, "is_candidate") === 1,
          contentSha256: rowText(candidateRow, "content_sha256"),
        }
      : null,
    providerPolicy: policy,
    deterministicPairs,
    reviewerEvaluation,
    humanDecision: { actorId, note },
    signalScore,
    minimumWeightedScore: evaluationContract.minimumWeightedScore,
  });
  const coverageComplete = cases.length >= 2
    && cases.some((item) => item.holdout)
    && deterministicPairs.length === cases.length
    && new Set(deterministicPairs.map((item) => item.caseId)).size === cases.length;
  return { result, coverageComplete, signalScore, deterministicPairs, reviewerEvaluation, candidateRow };
}

function versionTransitionOrThrow(
  row: D1Row,
  targetStatus: MetaSkillVersionLifecycleSnapshot["status"],
  actorId: string,
  note: string,
  experimentId: string,
  decidedAt: string,
) {
  const snapshot = skillLifecycle(row);
  const transition = transitionMetaSkillVersion(snapshot, targetStatus, {
    versionId: snapshot.id,
    skillKey: snapshot.skillKey,
    expectedContentSha256: snapshot.contentSha256,
    expectedStatus: snapshot.status,
    expectedLockVersion: snapshot.lockVersion,
  }, {
    actorId,
    note,
    experimentId,
    decidedAt,
    ...(targetStatus === "adopted" ? { activatedAt: decidedAt } : {}),
  });
  if (!transition.ok) {
    throw new ImprovementApiError("VERSION_CAS_CONFLICT", "Skill 版本生命周期发生冲突", 409, { conflicts: transition.conflicts });
  }
  return transition.next;
}

async function adoptExperiment(
  db: D1Database,
  row: D1Row,
  expectedLockVersion: number,
  candidateId: string,
  evidenceExpectation: HumanAdoptionExpectation,
  actorId: string,
  note: string,
  requestSha256: string,
) {
  if (rowText(row, "state") !== "awaiting_human" || rowText(row, "candidate_version_id") !== candidateId) {
    throw new ImprovementApiError("EXPERIMENT_NOT_ADOPTABLE", "实验尚未到人工采纳阶段或候选不匹配", 409);
  }
  const gate = await adoptabilityFor(db, row, expectedLockVersion, actorId, note);
  if (!gate.result.adoptable || !gate.coverageComplete) {
    throw new ImprovementApiError("ADOPTABILITY_GATE_FAILED", "候选没有通过完整元改进采纳门禁", 409, {
      reasons: gate.result.reasons,
      checks: gate.result.checks,
      coverageComplete: gate.coverageComplete,
    });
  }
  const experiment = experimentSnapshot(row);
  const candidate = gate.candidateRow;
  if (!candidate) throw new ImprovementApiError("CANDIDATE_NOT_FOUND", "候选版本不存在", 404);
  const evidenceBundle = await humanAdoptionEvidenceBundle(db, row);
  if (!evidenceBundle?.complete) {
    throw new ImprovementApiError("HUMAN_EVIDENCE_INCOMPLETE", "人工采纳证据包不完整", 409, {
      coverageComplete: evidenceBundle?.coverage.complete ?? false,
      reviewerPresent: evidenceBundle?.reviewer !== null && evidenceBundle?.reviewer !== undefined,
    });
  }
  const evidenceConflicts = [
    evidenceExpectation.candidateSha256 !== evidenceBundle.candidate.contentSha256 ? "CANDIDATE_SHA_CHANGED" : null,
    evidenceExpectation.evidenceBundleSha256 !== evidenceBundle.evidenceBundleSha256 ? "EVIDENCE_BUNDLE_CHANGED" : null,
    evidenceExpectation.activeVersionId !== evidenceBundle.activation.activeVersionId ? "ACTIVE_VERSION_CHANGED" : null,
    evidenceExpectation.activationLockVersion !== evidenceBundle.activation.lockVersion ? "ACTIVATION_LOCK_CHANGED" : null,
  ].filter((item): item is string => item !== null);
  if (evidenceConflicts.length > 0) {
    throw new ImprovementApiError("HUMAN_EVIDENCE_STALE", "人工核对的证据包或活动版本已经变化", 409, {
      conflicts: evidenceConflicts,
    });
  }
  const activation = await activationRow(db, rowText(row, "target_skill_key"));
  const active = await versionRow(db, rowText(activation, "active_version_id"));
  if (rowText(activation, "active_version_id") !== evidenceExpectation.activeVersionId
    || rowNumber(activation, "lock_version") !== evidenceExpectation.activationLockVersion) {
    throw new ImprovementApiError("HUMAN_EVIDENCE_STALE", "采纳前 activation 已不再匹配人工核对的证据包", 409, {
      conflicts: ["ACTIVATION_CHANGED_AFTER_EVIDENCE_RECOMPUTE"],
    });
  }
  if (rowText(active, "id") !== experiment.baselineVersionId || rowText(active, "status") !== "adopted") {
    throw new ImprovementApiError("ACTIVE_BASELINE_CHANGED", "运行时 activation 已不再指向冻结基线", 409);
  }
  const now = isoNow();
  const activationState = activationSnapshot(activation);
  const activationTransition = transitionMetaSkillActivation(activationState, {
    skillKey: activationState.skillKey,
    expectedActiveVersionId: activationState.activeVersionId,
    expectedLockVersion: activationState.lockVersion,
  }, {
    decision: "adopt",
    targetVersion: {
      id: rowText(candidate, "id"),
      skillKey: rowText(candidate, "skill_key"),
      status: rowText(candidate, "status") as MetaSkillVersionLifecycleSnapshot["status"],
    },
    experimentId: experiment.id,
    humanActorId: actorId,
    humanNote: note,
    updatedAt: now,
    adoptability: gate.result,
  });
  if (!activationTransition.ok) {
    throw new ImprovementApiError("ACTIVATION_CAS_CONFLICT", "活动版本指针采纳 CAS 失败", 409, { conflicts: activationTransition.conflicts });
  }
  const oldNext = versionTransitionOrThrow(active, "superseded", actorId, note, experiment.id, now);
  const candidateNext = versionTransitionOrThrow(candidate, "adopted", actorId, note, experiment.id, now);
  const syntheticExperiment = { ...experiment, decision: "adopt" as const };
  const experimentTransition = transitionMetaImprovementExperiment(
    syntheticExperiment,
    "completed",
    experimentExpectation(syntheticExperiment, "awaiting_human", expectedLockVersion),
  );
  if (!experimentTransition.ok) throw stateTransitionError(experimentTransition.conflicts);
  const eventId = `meta-event-${crypto.randomUUID()}`;
  await db.batch([
    db.prepare(`UPDATE meta_skill_activations SET active_version_id = ?, lock_version = ?,
      updated_at = ?, decision_experiment_id = ? WHERE skill_key = ? AND active_version_id = ? AND lock_version = ?`)
      .bind(activationTransition.next.activeVersionId, activationTransition.next.lockVersion, now,
        experiment.id, activationState.skillKey, activationState.activeVersionId, activationState.lockVersion),
    db.prepare(`UPDATE meta_skill_versions SET status = 'superseded', decision_experiment_id = ?,
      decided_at = ?, lock_version = ? WHERE id = ? AND skill_key = ? AND content_sha256 = ?
      AND status = 'adopted' AND lock_version = ?`)
      .bind(experiment.id, now, oldNext.lockVersion, rowText(active, "id"), rowText(active, "skill_key"),
        rowText(active, "content_sha256"), rowNumber(active, "lock_version")),
    db.prepare(`UPDATE meta_skill_versions SET status = 'adopted', decision_experiment_id = ?,
      activated_at = ?, decided_at = ?, lock_version = ? WHERE id = ? AND skill_key = ?
      AND content_sha256 = ? AND status = 'candidate' AND lock_version = ?`)
      .bind(experiment.id, now, now, candidateNext.lockVersion, candidateId,
        rowText(candidate, "skill_key"), rowText(candidate, "content_sha256"), rowNumber(candidate, "lock_version")),
    db.prepare(`UPDATE meta_improvement_experiments SET state = 'completed', decision = 'adopt',
      human_decision_note = ?, human_decided_by = ?, human_decided_at = ?, completed_at = ?,
      updated_at = ?, lock_version = ? WHERE id = ? AND state = 'awaiting_human'
      AND decision = 'pending' AND lock_version = ? AND candidate_version_id = ? AND frozen_input_sha256 = ?`)
      .bind(note, actorId, now, now, now, experimentTransition.next.lockVersion, experiment.id,
        expectedLockVersion, candidateId, experiment.frozenInputSha256),
    db.prepare(`INSERT INTO meta_improvement_events
      (id, experiment_id, event_type, from_state, to_state, actor_kind, actor_id,
       payload_json, input_sha256, created_at)
      VALUES (?, ?, 'experiment.adopted', 'awaiting_human', 'completed', 'human',
        CASE WHEN EXISTS (SELECT 1 FROM meta_skill_activations WHERE skill_key = ? AND active_version_id = ? AND lock_version = ?)
          AND EXISTS (SELECT 1 FROM meta_skill_versions WHERE id = ? AND status = 'adopted' AND lock_version = ?)
          AND EXISTS (SELECT 1 FROM meta_skill_versions WHERE id = ? AND status = 'superseded' AND lock_version = ?)
          AND EXISTS (SELECT 1 FROM meta_improvement_experiments WHERE id = ? AND decision = 'adopt' AND state = 'completed' AND lock_version = ?)
        THEN ? ELSE NULL END, ?, ?, ?)`)
      .bind(eventId, experiment.id, activationState.skillKey, candidateId, activationTransition.next.lockVersion,
        candidateId, candidateNext.lockVersion, rowText(active, "id"), oldNext.lockVersion,
        experiment.id, experimentTransition.next.lockVersion, actorId,
        canonicalJson({
          candidateId,
          candidateSha256: evidenceExpectation.candidateSha256,
          evidenceBundleSha256: evidenceExpectation.evidenceBundleSha256,
          expectedActiveVersionId: evidenceExpectation.activeVersionId,
          expectedActivationLockVersion: evidenceExpectation.activationLockVersion,
          activationCas: true,
          adoptability: gate.result,
        }), requestSha256, now),
  ]);
}

async function rejectExperiment(
  db: D1Database,
  row: D1Row,
  expectedLockVersion: number,
  actorId: string,
  note: string,
  requestSha256: string,
) {
  if (rowNumber(row, "lock_version") !== expectedLockVersion
    || ["completed", "cancelled"].includes(rowText(row, "state"))) {
    throw new ImprovementApiError("EXPERIMENT_CAS_CONFLICT", "实验已变化或已结束", 409);
  }
  const candidateId = rowNullableText(row, "candidate_version_id");
  const candidate = candidateId ? await versionRow(db, candidateId) : null;
  const now = isoNow();
  const nextLock = expectedLockVersion + 1;
  const statements: D1PreparedStatement[] = [];
  let candidateNextLock: number | null = null;
  if (candidate && rowText(candidate, "status") === "candidate") {
    const next = versionTransitionOrThrow(candidate, "rejected", actorId, note, rowText(row, "id"), now);
    candidateNextLock = next.lockVersion;
    statements.push(db.prepare(`UPDATE meta_skill_versions SET status = 'rejected', decision_experiment_id = ?,
      decided_at = ?, lock_version = ? WHERE id = ? AND status = 'candidate' AND lock_version = ?`)
      .bind(rowText(row, "id"), now, next.lockVersion, candidateId, rowNumber(candidate, "lock_version")));
  }
  statements.push(db.prepare(`UPDATE meta_improvement_experiments SET state = 'completed', decision = 'reject',
    human_decision_note = ?, human_decided_by = ?, human_decided_at = ?, completed_at = ?,
    updated_at = ?, lock_version = ? WHERE id = ? AND lock_version = ? AND state NOT IN ('completed','cancelled')`)
    .bind(note, actorId, now, now, now, nextLock, rowText(row, "id"), expectedLockVersion));
  statements.push(db.prepare(`INSERT INTO meta_improvement_events
    (id, experiment_id, event_type, from_state, to_state, actor_kind, actor_id,
     payload_json, input_sha256, created_at)
    VALUES (?, ?, 'experiment.rejected', ?, 'completed', 'human',
      CASE WHEN EXISTS (SELECT 1 FROM meta_improvement_experiments WHERE id = ? AND state = 'completed' AND decision = 'reject' AND lock_version = ?)
        ${candidateId && candidateNextLock ? "AND EXISTS (SELECT 1 FROM meta_skill_versions WHERE id = ? AND status = 'rejected' AND lock_version = ?)" : ""}
      THEN ? ELSE NULL END, ?, ?, ?)`)
    .bind(`meta-event-${crypto.randomUUID()}`, rowText(row, "id"), rowText(row, "state"),
      rowText(row, "id"), nextLock,
      ...(candidateId && candidateNextLock ? [candidateId, candidateNextLock] : []),
      actorId, canonicalJson({ candidateId }), requestSha256, now));
  await db.batch(statements);
}

async function rollbackExperiment(
  db: D1Database,
  row: D1Row,
  expectedLockVersion: number,
  actorId: string,
  note: string,
  requestSha256: string,
) {
  if (rowText(row, "state") !== "completed" || rowText(row, "decision") !== "adopt"
    || rowNumber(row, "lock_version") !== expectedLockVersion) {
    throw new ImprovementApiError("EXPERIMENT_NOT_ROLLBACKABLE", "只有当前已采纳实验可以人工回滚", 409);
  }
  const candidateId = rowText(row, "candidate_version_id");
  const baselineId = rowText(row, "baseline_version_id");
  const activation = await activationRow(db, rowText(row, "target_skill_key"));
  const candidate = await versionRow(db, candidateId);
  const baseline = await versionRow(db, baselineId);
  if (rowText(activation, "active_version_id") !== candidateId
    || rowText(candidate, "status") !== "adopted"
    || rowText(baseline, "status") !== "superseded") {
    throw new ImprovementApiError("ROLLBACK_TARGET_CHANGED", "activation 或回滚目标已变化", 409);
  }
  const now = isoNow();
  const activationState = activationSnapshot(activation);
  const activationTransition = transitionMetaSkillActivation(activationState, {
    skillKey: activationState.skillKey,
    expectedActiveVersionId: candidateId,
    expectedLockVersion: activationState.lockVersion,
  }, {
    decision: "rollback",
    targetVersion: { id: baselineId, skillKey: rowText(baseline, "skill_key"), status: "superseded" },
    experimentId: rowText(row, "id"),
    humanActorId: actorId,
    humanNote: note,
    updatedAt: now,
  });
  if (!activationTransition.ok) {
    throw new ImprovementApiError("ACTIVATION_CAS_CONFLICT", "活动版本指针回滚 CAS 失败", 409, { conflicts: activationTransition.conflicts });
  }
  const candidateNext = versionTransitionOrThrow(candidate, "superseded", actorId, note, rowText(row, "id"), now);
  const baselineNext = versionTransitionOrThrow(baseline, "adopted", actorId, note, rowText(row, "id"), now);
  const nextLock = expectedLockVersion + 1;
  await db.batch([
    db.prepare(`UPDATE meta_skill_activations SET active_version_id = ?, lock_version = ?, updated_at = ?,
      decision_experiment_id = ? WHERE skill_key = ? AND active_version_id = ? AND lock_version = ?`)
      .bind(baselineId, activationTransition.next.lockVersion, now, rowText(row, "id"),
        activationState.skillKey, candidateId, activationState.lockVersion),
    db.prepare(`UPDATE meta_skill_versions SET status = 'superseded', decision_experiment_id = ?,
      decided_at = ?, lock_version = ? WHERE id = ? AND status = 'adopted' AND lock_version = ?`)
      .bind(rowText(row, "id"), now, candidateNext.lockVersion, candidateId, rowNumber(candidate, "lock_version")),
    db.prepare(`UPDATE meta_skill_versions SET status = 'adopted', decision_experiment_id = ?,
      activated_at = ?, decided_at = ?, lock_version = ? WHERE id = ? AND status = 'superseded' AND lock_version = ?`)
      .bind(rowText(row, "id"), now, now, baselineNext.lockVersion, baselineId, rowNumber(baseline, "lock_version")),
    db.prepare(`UPDATE meta_improvement_experiments SET decision = 'rollback', human_decision_note = ?,
      human_decided_by = ?, human_decided_at = ?, updated_at = ?, lock_version = ?
      WHERE id = ? AND state = 'completed' AND decision = 'adopt' AND lock_version = ?`)
      .bind(note, actorId, now, now, nextLock, rowText(row, "id"), expectedLockVersion),
    db.prepare(`INSERT INTO meta_improvement_events
      (id, experiment_id, event_type, from_state, to_state, actor_kind, actor_id,
       payload_json, input_sha256, created_at)
      VALUES (?, ?, 'experiment.rolled_back', 'completed', 'completed', 'human',
        CASE WHEN EXISTS (SELECT 1 FROM meta_skill_activations WHERE skill_key = ? AND active_version_id = ? AND lock_version = ?)
          AND EXISTS (SELECT 1 FROM meta_skill_versions WHERE id = ? AND status = 'adopted' AND lock_version = ?)
          AND EXISTS (SELECT 1 FROM meta_skill_versions WHERE id = ? AND status = 'superseded' AND lock_version = ?)
          AND EXISTS (SELECT 1 FROM meta_improvement_experiments WHERE id = ? AND decision = 'rollback' AND lock_version = ?)
        THEN ? ELSE NULL END, ?, ?, ?)`)
      .bind(`meta-event-${crypto.randomUUID()}`, rowText(row, "id"), activationState.skillKey,
        baselineId, activationTransition.next.lockVersion, baselineId, baselineNext.lockVersion,
        candidateId, candidateNext.lockVersion, rowText(row, "id"), nextLock, actorId,
        canonicalJson({ fromVersionId: candidateId, toVersionId: baselineId, activationCas: true }),
        requestSha256, now),
  ]);
}

async function decideExperimentAction(
  db: D1Database,
  payload: JsonObject,
  actorId: string,
  requestSha256: string,
) {
  const experimentId = requiredText(payload.experimentId, "experimentId", 160);
  const expectedLockVersion = requiredInteger(payload.expectedLockVersion, "expectedLockVersion", 1, Number.MAX_SAFE_INTEGER);
  const decision = requiredText(payload.decision, "decision", 20);
  const note = requiredText(payload.note, "note", 4_000);
  if (note.length < 8) throw new ImprovementApiError("HUMAN_NOTE_REQUIRED", "人工决定说明至少需要 8 个字符", 400);
  const row = await experimentRow(db, experimentId);
  if (decision === "adopt") {
    const candidateId = requiredText(payload.candidateId, "candidateId", 160);
    const evidenceExpectation: HumanAdoptionExpectation = {
      candidateSha256: requiredSha256(payload.expectedCandidateSha256, "expectedCandidateSha256"),
      evidenceBundleSha256: requiredSha256(payload.expectedEvidenceBundleSha256, "expectedEvidenceBundleSha256"),
      activeVersionId: requiredText(payload.expectedActiveVersionId, "expectedActiveVersionId", 160),
      activationLockVersion: requiredInteger(
        payload.expectedActivationLockVersion,
        "expectedActivationLockVersion",
        1,
        Number.MAX_SAFE_INTEGER,
      ),
    };
    await adoptExperiment(db, row, expectedLockVersion, candidateId, evidenceExpectation, actorId, note, requestSha256);
  } else if (decision === "reject") {
    await rejectExperiment(db, row, expectedLockVersion, actorId, note, requestSha256);
  } else if (decision === "rollback") {
    await rollbackExperiment(db, row, expectedLockVersion, actorId, note, requestSha256);
  } else {
    throw new ImprovementApiError("DECISION_UNSUPPORTED", "decision 必须是 adopt、reject 或 rollback", 400);
  }
  return experimentId;
}

function uiExperimentState(row: D1Row) {
  const state = rowText(row, "state");
  const decision = rowText(row, "decision");
  if (state === "generating") return "generating";
  if (state === "candidate_ready") return "candidate";
  if (state === "evaluating") return "evaluating";
  if (state === "awaiting_human") return "review";
  if (state === "completed" && decision === "adopt") return "adopted";
  if (state === "completed" && decision === "rollback") return "rolled_back";
  if (state === "completed" && ["reject", "defer"].includes(decision)) return "rejected";
  if (["blocked", "cancelled"].includes(state)) return "blocked";
  if (state === "failed") return "failed";
  return "draft";
}

async function experimentDashboard(db: D1Database, row: D1Row) {
  const baseline = await versionRow(db, rowText(row, "baseline_version_id"));
  const policy = parseProviderPolicy(row);
  const budget = parseBudget(row);
  const contract = parseEvaluationContract(row);
  const cases = parseJson<EvaluationCase[]>(row.cases_json, []);
  const usage = await invocationUsage(db, rowText(row, "id"));
  const candidateId = rowNullableText(row, "candidate_version_id");
  const candidate = candidateId ? await versionRow(db, candidateId) : null;
  const candidates = [];
  if (candidate) {
    const candidateContract = parseJson<JsonObject>(candidate.contract_json, {});
    const invocation = candidate.source_invocation_id
      ? await db.prepare("SELECT * FROM model_invocations WHERE id = ? LIMIT 1")
          .bind(candidate.source_invocation_id).first<D1Row>()
      : null;
    const versionStatus = rowText(candidate, "status");
    candidates.push({
      id: rowText(candidate, "id"),
      provider: invocation ? rowText(invocation, "provider") : policy.proposerProvider,
      model: invocation ? rowText(invocation, "model_id") : policy.proposerModelId,
      title: cleanText(candidateContract.title, 120) || "受限候选",
      summary: cleanText(candidateContract.summary, 2_000) || "候选已生成，尚未采纳",
      candidateSha256: rowText(candidate, "content_sha256"),
      parentVersionId: rowNullableText(candidate, "parent_version_id"),
      status: versionStatus === "adopted"
        ? "adopted"
        : versionStatus === "rejected" ? "rejected" : "candidate",
      createdAt: rowText(candidate, "created_at"),
    });
  }
  const deterministic = await deterministicRows(db, rowText(row, "id"));
  const review = await db.prepare(`SELECT * FROM meta_improvement_evaluations
    WHERE experiment_id = ? AND evaluator_kind = 'model' AND evaluator_key = ?
    ORDER BY created_at DESC LIMIT 1`).bind(rowText(row, "id"), BLIND_REVIEWER_KEY).first<D1Row>();
  const humanEvidence = candidate ? await humanAdoptionEvidenceBundle(db, row) : null;
  const evaluationComplete = humanEvidence?.coverage.complete === true
    && ["awaiting_human", "completed"].includes(rowText(row, "state"));
  const dashboardCases = cases.map((item) => item.holdout && !evaluationComplete
    ? {
        id: item.id,
        input: "",
        requiredSignals: [],
        forbiddenSignals: [],
        holdout: true,
        redacted: true,
      }
    : { ...item, redacted: false });
  const evaluations = [];
  if (deterministic.length > 0 && candidateId) {
    const independentReviewPassed = Boolean(review)
      && rowText(review!, "result") === "pass"
      && rowText(review!, "provider") !== policy.proposerProvider
      && rowText(review!, "provider") !== policy.executionProvider;
    evaluations.push({
      id: review ? rowText(review, "id") : `deterministic-${rowText(row, "id")}`,
      baselineVersionId: rowText(row, "baseline_version_id"),
      candidateId,
      evaluatorProviders: [...new Set([
        policy.executionProvider,
        ...(review ? [rowText(review, "provider")] : []),
      ])],
      outcome: independentReviewPassed
        ? "candidate"
        : review && rowText(review, "result") === "fail" ? "baseline" : "inconclusive",
      winnerCandidateId: independentReviewPassed ? candidateId : null,
      independentReviewPassed,
      summary: review
        ? independentReviewPassed
          ? `候选通过独立 ${policy.reviewerProvider} 盲审；仍需人工说明与采纳门禁`
          : "独立盲审未支持候选采纳"
        : "确定性字面评估已完成；reviewer 未配置，不能采纳",
      createdAt: review
        ? rowText(review, "created_at")
        : rowText(deterministic[deterministic.length - 1], "created_at"),
    });
  }
  return {
    id: rowText(row, "id"),
    articleId: contract.articleId,
    targetSkillKey: rowText(row, "target_skill_key"),
    baselineVersion: rowText(baseline, "version"),
    baselineSha256: rowText(row, "baseline_content_sha256"),
    objective: rowText(row, "objective"),
    failureEvidenceRefs: contract.failureEvidenceRefs,
    executionProvider: policy.executionProvider,
    proposerProvider: policy.proposerProvider,
    reviewerProvider: policy.reviewerProvider,
    budgetCalls: budget.maxInvocations,
    usedCalls: usage.invocationCount,
    evaluationCases: dashboardCases,
    state: uiExperimentState(row),
    domainState: rowText(row, "state"),
    lockVersion: rowNumber(row, "lock_version"),
    candidates,
    evaluations,
    humanEvidence: evaluationComplete ? humanEvidence : null,
    selectedCandidateId: ["adopt", "rollback"].includes(rowText(row, "decision")) ? candidateId : null,
    decisionNote: rowText(row, "human_decision_note"),
    createdAt: rowText(row, "created_at"),
    updatedAt: rowText(row, "updated_at"),
    frozen: {
      baselineVersionId: rowText(row, "baseline_version_id"),
      casesSha256: rowText(row, "cases_sha256"),
      holdoutCasesSha256: rowText(row, "holdout_cases_sha256"),
      providerPolicySha256: rowText(row, "provider_policy_sha256"),
      budgetSha256: rowText(row, "budget_sha256"),
      evaluationContractSha256: rowText(row, "evaluation_contract_sha256"),
      frozenInputSha256: rowText(row, "frozen_input_sha256"),
    },
  };
}

async function experimentDashboardById(db: D1Database, experimentId: string) {
  return experimentDashboard(db, await experimentRow(db, experimentId));
}

async function dashboard(db: D1Database) {
  const providerStatuses = await Promise.all(
    MODEL_PROVIDERS.map((provider) => providerDashboardStatus(db, provider)),
  );
  const targetRows = await db.prepare(`SELECT activation.skill_key, activation.active_version_id,
      activation.lock_version, version.version, version.content_sha256
    FROM meta_skill_activations activation
    JOIN meta_skill_versions version ON version.id = activation.active_version_id
    WHERE activation.skill_key IN ('meta.candidate-proposer','meta.execution','meta.candidate-reviewer')
    ORDER BY activation.skill_key ASC`).all<D1Row>();
  const experimentsResult = await db.prepare(`SELECT * FROM meta_improvement_experiments
    ORDER BY created_at DESC LIMIT ?`).bind(MAX_EXPERIMENTS).all<D1Row>();
  const experiments = [];
  for (const row of experimentsResult.results) experiments.push(await experimentDashboard(db, row));
  return {
    schemaVersion: META_IMPROVEMENT_SCHEMA_VERSION,
    apiVersion: API_VERSION,
    targets: targetRows.results.map((row) => ({
      skillKey: rowText(row, "skill_key"),
      label: TARGET_LABELS[rowText(row, "skill_key")] ?? rowText(row, "skill_key"),
      activeVersion: rowText(row, "version"),
      activeSha256: rowText(row, "content_sha256"),
      activeVersionId: rowText(row, "active_version_id"),
      activationLockVersion: rowNumber(row, "lock_version"),
    })),
    providers: providerStatuses,
    policy: {
      browserKeyEntryAllowed: false,
      keyMaterialReturned: false,
      apiConnectionIsMetaImprovement: false,
      independentReviewRequired: true,
      minimumIndependentProviders: 2,
      reviewerProvider: "qwen",
      extendedProvidersEnabled: extendedProvidersEnabled(),
      automaticRetries: 0,
      hardBudgetDimensions: ["invocations", "input_tokens", "output_tokens"],
      estimatedCostBudgetEnforced: false,
    },
    experiments,
  };
}

async function executeAction(
  db: D1Database,
  action: ImprovementAction,
  payload: JsonObject,
  actorId: string,
  commandId: string,
  requestSha256: string,
): Promise<MutationResult> {
  if (action === "initialize_workspace") {
    return { data: { initialized: true, dashboard: await dashboard(db) } };
  }
  if (action === "test_provider") {
    return { data: await testProviderAction(db, payload, commandId, requestSha256) };
  }
  if (action === "create_experiment") {
    const experimentId = await createExperimentAction(db, payload, actorId, requestSha256);
    return { status: 201, data: { experiment: await experimentDashboardById(db, experimentId) } };
  }
  if (action === "generate_candidates") {
    const experimentId = await generateCandidateAction(db, payload, actorId, commandId, requestSha256);
    return { data: { experiment: await experimentDashboardById(db, experimentId) } };
  }
  if (action === "run_pairwise_evaluation") {
    const experimentId = await runPairwiseEvaluationAction(db, payload, actorId, commandId, requestSha256);
    return { data: { experiment: await experimentDashboardById(db, experimentId) } };
  }
  const experimentId = await decideExperimentAction(db, payload, actorId, requestSha256);
  return { data: { experiment: await experimentDashboardById(db, experimentId) } };
}

export async function GET(request: Request) {
  const id = newRequestId();
  try {
    await requireManagementSession(request, { scope: "management.read" });
    const url = new URL(request.url);
    if (url.searchParams.get("view") !== "status") {
      throw new ImprovementApiError("VIEW_UNSUPPORTED", "GET 仅支持 ?view=status", 400);
    }
    const db = await requireImprovementSchemaReady();
    return jsonSuccess(id, await dashboard(db));
  } catch (error) {
    return jsonError(id, error);
  }
}

export async function POST(request: Request) {
  const id = newRequestId();
  try {
    const { action, commandId, payload } = await parseMutationBody(request);
    const principal = await requireManagementSession(request, {
      mutation: true,
      scope: ACTION_SCOPES[action],
    });
    const db = action === "initialize_workspace"
      ? await ensureImprovementSchema()
      : await requireImprovementSchemaReady();
    const actorId = managementActorId(principal);
    const result = await withReceipt(db, action, actorId, commandId, payload,
      (requestSha256) => executeAction(db, action, payload, actorId, commandId, requestSha256));
    return jsonSuccess(id, result.data, result.status);
  } catch (error) {
    return jsonError(id, error);
  }
}
