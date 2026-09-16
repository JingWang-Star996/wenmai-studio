import { env } from "cloudflare:workers";
import { listModelGatewayProviderStatuses } from "../../model-gateway";
import {
  MODEL_ROUTING_CUSTOM_AGENTS,
  MODEL_ROUTING_DATA_SENSITIVITIES,
  MODEL_ROUTING_EXTERNAL_OUTCOMES,
  MODEL_ROUTING_GATEWAY_PROVIDERS,
  MODEL_ROUTING_MATRIX,
  MODEL_ROUTING_MECHANICAL_TASKS,
  MODEL_ROUTING_PHASES,
  MODEL_ROUTING_RISKS,
  MODEL_ROUTING_SCHEMA_VERSION,
  planModelRoute,
  type ModelRoutingExternalOutcome,
  type ModelRoutingGatewayProvider,
  type ModelRoutingInput,
  type ModelRoutingMechanicalTask,
  type ModelRoutingPhase,
  type ModelRoutingReadiness,
  type ModelRoutingSurface,
} from "../../model-routing";

export const runtime = "edge";

const MAX_BODY_BYTES = 16 * 1024;
const ALLOWED_PLAN_FIELDS = new Set([
  "phase", "risk", "dataSensitivity", "requiresBrowser", "requiresJudgment",
  "externalOutcome", "frozenInput", "contentMutationRequested", "mechanicalTask",
  "inputSha256", "outputSchemaId", "outputSchemaVersion", "candidateOnly",
]);

type JsonObject = Record<string, unknown>;
type GatewayStatusLike = Readonly<{
  provider?: unknown;
  configured?: unknown;
  ready?: unknown;
  model?: unknown;
}>;

class ModelRoutingApiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = "ModelRoutingApiError";
    this.code = code;
    this.status = status;
  }
}

function runtimeEnv(): Readonly<Record<string, unknown>> {
  return env as unknown as Readonly<Record<string, unknown>>;
}

function boolEnv(name: string, fallback = false): boolean {
  const value = runtimeEnv()[name];
  if (typeof value !== "string") return fallback;
  return value.trim().toLowerCase() === "true";
}

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function includes<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === "string" && (values as readonly string[]).includes(value);
}

function requireBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw new ModelRoutingApiError("FIELD_INVALID", `${field} 必须是布尔值`);
  }
  return value;
}

function optionalBoolean(value: unknown, field: string): boolean | undefined {
  return value === undefined ? undefined : requireBoolean(value, field);
}

function optionalSafeId(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value)) {
    throw new ModelRoutingApiError("FIELD_INVALID", `${field} 必须是安全的固定标识符`);
  }
  return value;
}

function optionalSha256(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new ModelRoutingApiError("FIELD_INVALID", `${field} 必须是 64 位小写 SHA-256`);
  }
  return value;
}

function parsePlanRequest(payload: unknown, readiness: ModelRoutingReadiness): ModelRoutingInput {
  if (!isObject(payload)) throw new ModelRoutingApiError("BODY_INVALID", "路由计划请求正文不是 JSON 对象；尚未生成或变更计划。请按对象格式提交后重试。");
  const unknownFields = Object.keys(payload).filter((field) => !ALLOWED_PLAN_FIELDS.has(field));
  if (unknownFields.length > 0) {
    throw new ModelRoutingApiError(
      "FIELD_UNSUPPORTED",
      `路由接口不接受字段：${unknownFields.slice(0, 5).join(", ")}`,
    );
  }
  if (!includes(MODEL_ROUTING_PHASES, payload.phase)) {
    throw new ModelRoutingApiError("FIELD_INVALID", "phase 不在固定阶段允许列表中");
  }
  if (!includes(MODEL_ROUTING_RISKS, payload.risk)) {
    throw new ModelRoutingApiError("FIELD_INVALID", "risk 不在固定风险允许列表中");
  }
  if (!includes(MODEL_ROUTING_DATA_SENSITIVITIES, payload.dataSensitivity)) {
    throw new ModelRoutingApiError("FIELD_INVALID", "dataSensitivity 不在固定敏感度允许列表中");
  }
  if (payload.externalOutcome !== undefined
    && !includes(MODEL_ROUTING_EXTERNAL_OUTCOMES, payload.externalOutcome)) {
    throw new ModelRoutingApiError("FIELD_INVALID", "externalOutcome 不在固定结果状态允许列表中");
  }
  if (payload.mechanicalTask !== undefined && !includes(MODEL_ROUTING_MECHANICAL_TASKS, payload.mechanicalTask)) {
    throw new ModelRoutingApiError("FIELD_INVALID", "mechanicalTask 不在固定机械任务允许列表中");
  }
  return Object.freeze({
    phase: payload.phase,
    risk: payload.risk,
    dataSensitivity: payload.dataSensitivity,
    requiresBrowser: requireBoolean(payload.requiresBrowser, "requiresBrowser"),
    requiresJudgment: requireBoolean(payload.requiresJudgment, "requiresJudgment"),
    providerReadiness: readiness,
    externalOutcome: payload.externalOutcome as ModelRoutingExternalOutcome | undefined,
    frozenInput: optionalBoolean(payload.frozenInput, "frozenInput"),
    contentMutationRequested: optionalBoolean(payload.contentMutationRequested, "contentMutationRequested"),
    mechanicalTask: payload.mechanicalTask as ModelRoutingMechanicalTask | undefined,
    inputSha256: optionalSha256(payload.inputSha256, "inputSha256"),
    outputSchemaId: optionalSafeId(payload.outputSchemaId, "outputSchemaId"),
    outputSchemaVersion: optionalSafeId(payload.outputSchemaVersion, "outputSchemaVersion"),
    candidateOnly: optionalBoolean(payload.candidateOnly, "candidateOnly"),
  });
}

function endpointClass(provider: ModelRoutingGatewayProvider): "managed_cloud" | "server_configured_lan" {
  return provider === "ollama" ? "server_configured_lan" : "managed_cloud";
}

function safeModel(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(normalized) ? normalized : null;
}

function providerCatalog() {
  let gatewayStatuses: readonly GatewayStatusLike[] = [];
  try {
    gatewayStatuses = listModelGatewayProviderStatuses(runtimeEnv()) as readonly GatewayStatusLike[];
  } catch {
    // Keep the catalog readable while an adapter is absent or misconfigured.
    // Readiness stays false and no raw adapter error is returned.
  }
  const byId = new Map<string, GatewayStatusLike>();
  for (const status of gatewayStatuses) {
    if (typeof status.provider === "string") byId.set(status.provider, status);
  }
  return MODEL_ROUTING_GATEWAY_PROVIDERS.map((id) => {
    const status = byId.get(id);
    return Object.freeze({
      id,
      configured: status?.configured === true,
      ready: status?.ready === true,
      model: safeModel(status?.model),
      endpointClass: endpointClass(id),
    });
  });
}

function controlPlaneCatalog() {
  const customAgentCatalog = Object.freeze({
    wenmai_fast_worker: Object.freeze({
      preferredModel: "gpt-5.6-luna",
      effectiveModel: "gpt-5.6-luna",
      model: "gpt-5.6-luna",
      circuitState: "not_applicable",
      fallbackReason: null,
      readinessSource: "server_runtime_flag",
    }),
    wenmai_publish_operator: Object.freeze({
      preferredModel: "gpt-5.3-codex-spark",
      effectiveModel: "gpt-5.6-terra",
      model: "gpt-5.6-terra",
      circuitState: "open",
      fallbackReason: "spark_runtime_enforcement_unverified",
      fallbackVerification: "not_verified",
      readinessSource: "server_runtime_flag",
    }),
  });
  const customAgents = MODEL_ROUTING_CUSTOM_AGENTS.map((id) => Object.freeze({
    id,
    configured: true,
    ready: id === "wenmai_publish_operator"
      ? boolEnv("WENMAI_PUBLISH_OPERATOR_READY") && boolEnv("WENMAI_PUBLISH_OPERATOR_HOST_ROUTE_VERIFIED")
      : boolEnv("WENMAI_FAST_WORKER_READY"),
    ...customAgentCatalog[id],
  }));
  const coordinator = Object.freeze({
    id: "gpt-5.6-sol" as const,
    configured: true,
    ready: boolEnv("WENMAI_COORDINATOR_READY", true),
    role: "completion_writer_and_exception_owner" as const,
    readinessSource: "server_runtime_flag" as const,
  });
  return { customAgents, coordinator };
}

function readinessFromCatalog(
  providers: ReturnType<typeof providerCatalog>,
  controlPlane: ReturnType<typeof controlPlaneCatalog>,
): ModelRoutingReadiness {
  const gateways: Partial<Record<ModelRoutingGatewayProvider, boolean>> = {};
  for (const provider of providers) gateways[provider.id] = provider.ready;
  return Object.freeze({
    gateways: Object.freeze(gateways),
    customAgents: Object.freeze({
      wenmai_publish_operator: controlPlane.customAgents.find((agent) => agent.id === "wenmai_publish_operator")?.ready === true,
      wenmai_fast_worker: controlPlane.customAgents.find((agent) => agent.id === "wenmai_fast_worker")?.ready === true,
    }),
    coordinator: controlPlane.coordinator.ready,
    human: true,
  });
}

function surfaceRef(surface: ModelRoutingSurface): string {
  return `${surface.kind}:${surface.id}`;
}

function defaultInput(phase: ModelRoutingPhase, readiness: ModelRoutingReadiness): ModelRoutingInput {
  const browser = phase.startsWith("browser_");
  const intermediate = phase === "intermediate_private" || phase === "intermediate_fast";
  return Object.freeze({
    phase,
    risk: "low",
    dataSensitivity: phase === "intermediate_private" ? "confidential" : "public",
    requiresBrowser: browser,
    requiresJudgment: phase === "ambiguous_judgment",
    providerReadiness: readiness,
    externalOutcome: "not_applicable",
    frozenInput: browser || intermediate,
    contentMutationRequested: false,
    mechanicalTask: intermediate ? "strict_schema_transform" : undefined,
    inputSha256: intermediate ? "0".repeat(64) : undefined,
    outputSchemaId: intermediate ? "wenmai.mechanical.default" : undefined,
    outputSchemaVersion: intermediate ? "1.0" : undefined,
    candidateOnly: intermediate ? true : undefined,
  });
}

function forbiddenClaims(surface: ModelRoutingSurface, phase: ModelRoutingPhase): readonly string[] {
  const values = new Set<string>();
  if (phase !== "completion_claim") values.add("completion_claim");
  if (surface.kind === "codex_custom_agent") {
    values.add("content_rewrite");
    values.add("completion_claim");
    values.add("permission_interpretation");
  }
  if (phase.startsWith("browser_")) values.add("public_verified_without_receipt");
  return Object.freeze([...values]);
}

function routeCatalog(readiness: ModelRoutingReadiness) {
  return MODEL_ROUTING_MATRIX.map((row) => {
    const plan = planModelRoute(defaultInput(row.phase, readiness));
    const primaryRef = surfaceRef(plan.primary);
    return Object.freeze({
      phase: row.phase,
      selectedSurface: plan.primary.kind,
      selectedRef: plan.primary.id,
      requiresHumanApproval: row.humanCapabilityRequired,
      fallbackRefs: Object.freeze(plan.candidates
        .map(surfaceRef)
        .filter((candidate) => candidate !== primaryRef)),
      reasonCodes: plan.reasonCodes,
      forbiddenClaims: forbiddenClaims(plan.primary, row.phase),
    });
  });
}

function catalogPayload() {
  const providers = providerCatalog();
  const controlPlane = controlPlaneCatalog();
  const readiness = readinessFromCatalog(providers, controlPlane);
  return {
    schemaVersion: MODEL_ROUTING_SCHEMA_VERSION,
    coordinator: controlPlane.coordinator,
    customAgents: controlPlane.customAgents,
    providers,
    routes: routeCatalog(readiness),
    boundaries: Object.freeze([
      "routing_is_deterministic_code_not_model_choice",
      "api_plans_only_and_never_invokes_models",
      "upstream_url_and_key_material_are_never_accepted_or_returned",
      "browser_operator_cannot_rewrite_content_or_write_completion_claims",
      "publish_requires_human_single_use_capability",
      "publish_planner_requires_server_authoritative_consumption_and_unique_execution_lease",
      "intermediate_models_only_receive_frozen_candidate_only_mechanical_tasks",
      "ambiguous_external_outcome_requires_probe_before_retry",
      "automatic_external_retries_are_disabled",
      "exceptions_escalate_to_gpt_5_6_sol",
      "spark_runtime_is_not_probed_or_invoked_by_this_api",
      "publish_operator_fallback_target_requires_host_route_verification",
    ]),
    readiness,
  };
}

function response(data: JsonObject, status = 200) {
  return Response.json(data, {
    status,
    headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" },
  });
}

export async function GET() {
  const catalog = catalogPayload();
  return response({
    ok: true,
    schemaVersion: catalog.schemaVersion,
    coordinator: catalog.coordinator,
    customAgents: catalog.customAgents,
    providers: catalog.providers,
    routes: catalog.routes,
    boundaries: catalog.boundaries,
  });
}

export async function POST(request: Request) {
  try {
    const contentLength = Number(request.headers.get("content-length") ?? "0");
    if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
      throw new ModelRoutingApiError("BODY_TOO_LARGE", "路由计划请求体过大；尚未生成或变更计划。请缩小请求后重试。", 413);
    }
    const text = await request.text();
    if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) {
      throw new ModelRoutingApiError("BODY_TOO_LARGE", "路由计划请求体过大；尚未生成或变更计划。请缩小请求后重试。", 413);
    }
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new ModelRoutingApiError("BODY_INVALID", "路由计划请求正文不是有效 JSON；尚未生成或变更计划。请检查请求正文后重试。");
    }
    const catalog = catalogPayload();
    const input = parsePlanRequest(payload, catalog.readiness);
    const plan = planModelRoute(input);
    return response({
      ok: true,
      schemaVersion: MODEL_ROUTING_SCHEMA_VERSION,
      plan: {
        ...plan,
        selectedSurface: plan.primary.kind,
        selectedRef: plan.primary.id,
        fallbackRefs: plan.candidates
          .map(surfaceRef)
          .filter((candidate) => candidate !== surfaceRef(plan.primary)),
        forbiddenClaims: forbiddenClaims(plan.primary, plan.effectivePhase),
      },
    });
  } catch (error) {
    const apiError = error instanceof ModelRoutingApiError
      ? error
      : new ModelRoutingApiError("INTERNAL_ERROR", "模型路由计划生成失败", 500);
    return response({
      ok: false,
      schemaVersion: MODEL_ROUTING_SCHEMA_VERSION,
      error: { code: apiError.code, message: apiError.message },
    }, apiError.status);
  }
}
