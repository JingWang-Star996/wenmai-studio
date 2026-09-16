/**
 * Deterministic phase-to-executor routing for Wenmai.
 *
 * This module is intentionally policy-only. It does not invoke a model, read
 * secrets, inspect the network, or let a model choose its own executor.
 */

export const MODEL_ROUTING_SCHEMA_VERSION = "wenmai.model-routing/1.0";

export const MODEL_ROUTING_PHASES = Object.freeze([
  "deterministic_validation",
  "intermediate_private",
  "intermediate_fast",
  "browser_prepare",
  "browser_publish_once",
  "browser_probe",
  "ambiguous_judgment",
  "completion_claim",
] as const);

export type ModelRoutingPhase = (typeof MODEL_ROUTING_PHASES)[number];

export const MODEL_ROUTING_RISKS = Object.freeze(["low", "medium", "high", "critical"] as const);
export type ModelRoutingRisk = (typeof MODEL_ROUTING_RISKS)[number];

export const MODEL_ROUTING_DATA_SENSITIVITIES = Object.freeze([
  "public",
  "internal",
  "confidential",
  "restricted",
] as const);
export type ModelRoutingDataSensitivity = (typeof MODEL_ROUTING_DATA_SENSITIVITIES)[number];

export const MODEL_ROUTING_EXTERNAL_OUTCOMES = Object.freeze([
  "not_applicable",
  "known",
  "ambiguous",
] as const);
export type ModelRoutingExternalOutcome = (typeof MODEL_ROUTING_EXTERNAL_OUTCOMES)[number];

export const MODEL_ROUTING_GATEWAY_PROVIDERS = Object.freeze([
  "openai",
  "ollama",
  "deepseek",
  "qwen",
] as const);
export type ModelRoutingGatewayProvider = (typeof MODEL_ROUTING_GATEWAY_PROVIDERS)[number];

export const MODEL_ROUTING_CUSTOM_AGENTS = Object.freeze([
  "wenmai_publish_operator",
  "wenmai_fast_worker",
] as const);
export type ModelRoutingCustomAgent = (typeof MODEL_ROUTING_CUSTOM_AGENTS)[number];

export type ModelRoutingSurface =
  | Readonly<{ kind: "deterministic"; id: "deterministic" }>
  | Readonly<{ kind: "gateway"; id: ModelRoutingGatewayProvider }>
  | Readonly<{ kind: "codex_custom_agent"; id: ModelRoutingCustomAgent }>
  | Readonly<{ kind: "coordinator"; id: "gpt-5.6-sol" }>
  | Readonly<{ kind: "human"; id: "human" }>;

export type ModelRoutingReadiness = Readonly<{
  gateways?: Readonly<Partial<Record<ModelRoutingGatewayProvider, boolean>>>;
  customAgents?: Readonly<Partial<Record<ModelRoutingCustomAgent, boolean>>>;
  coordinator?: boolean;
  human?: boolean;
}>;

export const MODEL_ROUTING_MECHANICAL_TASKS = Object.freeze([
  "classify",
  "extract",
  "deduplicate",
  "format_map",
  "strict_schema_transform",
] as const);
export type ModelRoutingMechanicalTask = (typeof MODEL_ROUTING_MECHANICAL_TASKS)[number];

export type ModelRoutingInput = Readonly<{
  phase: ModelRoutingPhase;
  risk: ModelRoutingRisk;
  dataSensitivity: ModelRoutingDataSensitivity;
  requiresBrowser: boolean;
  requiresJudgment: boolean;
  providerReadiness: ModelRoutingReadiness;
  externalOutcome?: ModelRoutingExternalOutcome;
  frozenInput?: boolean;
  contentMutationRequested?: boolean;
  mechanicalTask?: ModelRoutingMechanicalTask;
  inputSha256?: string;
  outputSchemaId?: string;
  outputSchemaVersion?: string;
  candidateOnly?: boolean;
}>;

export type ModelRoutingState =
  | "ready"
  | "needs_human"
  | "escalated"
  | "probe_required"
  | "blocked";

export type ModelRoutingReasonCode =
  | "DETERMINISTIC_RULE"
  | "PRIVATE_LOCAL_PROVIDER"
  | "FAST_PROVIDER"
  | "BROWSER_OPERATOR"
  | "PUBLISH_SERVER_AUTHORITY_REQUIRED"
  | "PUBLISH_OPERATOR_HOST_ROUTE_UNVERIFIED"
  | "MECHANICAL_TASK_CONTRACT_REQUIRED"
  | "AMBIGUOUS_RESULT_PROBE_FIRST"
  | "JUDGMENT_REQUIRES_COORDINATOR"
  | "COMPLETION_REQUIRES_COORDINATOR"
  | "SENSITIVE_DATA_BLOCKS_CLOUD"
  | "BROWSER_CONTRACT_MISMATCH"
  | "FROZEN_INPUT_REQUIRED"
  | "CONTENT_MUTATION_FORBIDDEN"
  | "HIGH_RISK_ESCALATION"
  | "EXECUTOR_NOT_READY"
  | "COORDINATOR_NOT_READY";

export type ModelRoutingPlan = Readonly<{
  schemaVersion: typeof MODEL_ROUTING_SCHEMA_VERSION;
  requestedPhase: ModelRoutingPhase;
  effectivePhase: ModelRoutingPhase;
  state: ModelRoutingState;
  primary: ModelRoutingSurface;
  candidates: readonly ModelRoutingSurface[];
  escalation: ModelRoutingSurface;
  reasonCodes: readonly ModelRoutingReasonCode[];
  prerequisites: readonly string[];
  constraints: Readonly<{
    modelMayChooseExecutor: false;
    browserRequired: boolean;
    contentRewriteAllowed: boolean;
    completionClaimAllowed: boolean;
    externalWriteAllowed: boolean;
    automaticRetryAllowed: false;
    probeBeforeRetry: boolean;
    singleUsePublishCapabilityRequired: boolean;
    maxPublishClicks: 0 | 1;
  }>;
}>;

type PhaseMatrixRow = Readonly<{
  phase: ModelRoutingPhase;
  orderedSurfaces: readonly string[];
  browserMode: "none" | "read_only" | "prepare" | "publish_once";
  modelMayRewriteContent: boolean;
  modelMayWriteCompletionClaim: boolean;
  humanCapabilityRequired: boolean;
  automaticRetries: 0;
  onAmbiguousExternalOutcome: "probe_first_no_retry";
}>;

export const MODEL_ROUTING_MATRIX: readonly PhaseMatrixRow[] = Object.freeze([
  Object.freeze({
    phase: "deterministic_validation",
    orderedSurfaces: Object.freeze(["deterministic"]),
    browserMode: "none",
    modelMayRewriteContent: false,
    modelMayWriteCompletionClaim: false,
    humanCapabilityRequired: false,
    automaticRetries: 0,
    onAmbiguousExternalOutcome: "probe_first_no_retry",
  }),
  Object.freeze({
    phase: "intermediate_private",
    orderedSurfaces: Object.freeze(["gateway:ollama", "coordinator:gpt-5.6-sol"]),
    browserMode: "none",
    modelMayRewriteContent: false,
    modelMayWriteCompletionClaim: false,
    humanCapabilityRequired: false,
    automaticRetries: 0,
    onAmbiguousExternalOutcome: "probe_first_no_retry",
  }),
  Object.freeze({
    phase: "intermediate_fast",
    orderedSurfaces: Object.freeze([
      "gateway:openai",
      "codex_custom_agent:wenmai_fast_worker",
      "gateway:qwen",
      "gateway:deepseek",
      "coordinator:gpt-5.6-sol",
    ]),
    browserMode: "none",
    modelMayRewriteContent: false,
    modelMayWriteCompletionClaim: false,
    humanCapabilityRequired: false,
    automaticRetries: 0,
    onAmbiguousExternalOutcome: "probe_first_no_retry",
  }),
  Object.freeze({
    phase: "browser_prepare",
    orderedSurfaces: Object.freeze([
      "codex_custom_agent:wenmai_publish_operator",
      "coordinator:gpt-5.6-sol",
    ]),
    browserMode: "prepare",
    modelMayRewriteContent: false,
    modelMayWriteCompletionClaim: false,
    humanCapabilityRequired: false,
    automaticRetries: 0,
    onAmbiguousExternalOutcome: "probe_first_no_retry",
  }),
  Object.freeze({
    phase: "browser_publish_once",
    orderedSurfaces: Object.freeze([
      "human:human",
      "codex_custom_agent:wenmai_publish_operator",
      "coordinator:gpt-5.6-sol",
    ]),
    browserMode: "publish_once",
    modelMayRewriteContent: false,
    modelMayWriteCompletionClaim: false,
    humanCapabilityRequired: true,
    automaticRetries: 0,
    onAmbiguousExternalOutcome: "probe_first_no_retry",
  }),
  Object.freeze({
    phase: "browser_probe",
    orderedSurfaces: Object.freeze([
      "codex_custom_agent:wenmai_publish_operator",
      "coordinator:gpt-5.6-sol",
    ]),
    browserMode: "read_only",
    modelMayRewriteContent: false,
    modelMayWriteCompletionClaim: false,
    humanCapabilityRequired: false,
    automaticRetries: 0,
    onAmbiguousExternalOutcome: "probe_first_no_retry",
  }),
  Object.freeze({
    phase: "ambiguous_judgment",
    orderedSurfaces: Object.freeze(["coordinator:gpt-5.6-sol", "human:human"]),
    browserMode: "none",
    modelMayRewriteContent: false,
    modelMayWriteCompletionClaim: false,
    humanCapabilityRequired: false,
    automaticRetries: 0,
    onAmbiguousExternalOutcome: "probe_first_no_retry",
  }),
  Object.freeze({
    phase: "completion_claim",
    orderedSurfaces: Object.freeze(["coordinator:gpt-5.6-sol", "human:human"]),
    browserMode: "none",
    modelMayRewriteContent: false,
    modelMayWriteCompletionClaim: true,
    humanCapabilityRequired: false,
    automaticRetries: 0,
    onAmbiguousExternalOutcome: "probe_first_no_retry",
  }),
]);

const DETERMINISTIC_SURFACE = Object.freeze({ kind: "deterministic", id: "deterministic" } as const);
const COORDINATOR_SURFACE = Object.freeze({ kind: "coordinator", id: "gpt-5.6-sol" } as const);
const HUMAN_SURFACE = Object.freeze({ kind: "human", id: "human" } as const);

function gateway(id: ModelRoutingGatewayProvider): ModelRoutingSurface {
  return Object.freeze({ kind: "gateway", id });
}

function customAgent(id: ModelRoutingCustomAgent): ModelRoutingSurface {
  return Object.freeze({ kind: "codex_custom_agent", id });
}

function isReady(surface: ModelRoutingSurface, readiness: ModelRoutingReadiness): boolean {
  if (surface.kind === "deterministic") return true;
  if (surface.kind === "gateway") return readiness.gateways?.[surface.id] === true;
  if (surface.kind === "codex_custom_agent") return readiness.customAgents?.[surface.id] === true;
  if (surface.kind === "coordinator") return readiness.coordinator !== false;
  return readiness.human !== false;
}

function uniqueSurfaces(surfaces: readonly ModelRoutingSurface[]): readonly ModelRoutingSurface[] {
  const seen = new Set<string>();
  return Object.freeze(surfaces.filter((surface) => {
    const key = `${surface.kind}:${surface.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }));
}

function coordinatorOrHuman(readiness: ModelRoutingReadiness): ModelRoutingSurface {
  return isReady(COORDINATOR_SURFACE, readiness) ? COORDINATOR_SURFACE : HUMAN_SURFACE;
}

function constraints(
  effectivePhase: ModelRoutingPhase,
  options: Readonly<{
    externalWriteAllowed?: boolean;
    probeBeforeRetry?: boolean;
    publishTicketRequired?: boolean;
  }> = {},
): ModelRoutingPlan["constraints"] {
  const browserRequired = effectivePhase.startsWith("browser_");
  return Object.freeze({
    modelMayChooseExecutor: false,
    browserRequired,
    contentRewriteAllowed: false,
    completionClaimAllowed: effectivePhase === "completion_claim",
    externalWriteAllowed: options.externalWriteAllowed === true,
    automaticRetryAllowed: false,
    probeBeforeRetry: options.probeBeforeRetry ?? browserRequired,
    singleUsePublishCapabilityRequired: options.publishTicketRequired === true,
    maxPublishClicks: options.externalWriteAllowed === true ? 1 : 0,
  });
}

function makePlan(options: Readonly<{
  input: ModelRoutingInput;
  effectivePhase?: ModelRoutingPhase;
  state: ModelRoutingState;
  primary: ModelRoutingSurface;
  candidates: readonly ModelRoutingSurface[];
  reasonCodes: readonly ModelRoutingReasonCode[];
  prerequisites?: readonly string[];
  externalWriteAllowed?: boolean;
  probeBeforeRetry?: boolean;
  publishTicketRequired?: boolean;
}>): ModelRoutingPlan {
  const effectivePhase = options.effectivePhase ?? options.input.phase;
  return Object.freeze({
    schemaVersion: MODEL_ROUTING_SCHEMA_VERSION,
    requestedPhase: options.input.phase,
    effectivePhase,
    state: options.state,
    primary: options.primary,
    candidates: uniqueSurfaces(options.candidates),
    escalation: coordinatorOrHuman(options.input.providerReadiness),
    reasonCodes: Object.freeze([...options.reasonCodes]),
    prerequisites: Object.freeze([...(options.prerequisites ?? [])]),
    constraints: constraints(effectivePhase, {
      externalWriteAllowed: options.externalWriteAllowed,
      probeBeforeRetry: options.probeBeforeRetry,
      publishTicketRequired: options.publishTicketRequired,
    }),
  });
}

function escalate(
  input: ModelRoutingInput,
  reasonCodes: readonly ModelRoutingReasonCode[],
  prerequisites: readonly string[] = [],
): ModelRoutingPlan {
  const primary = coordinatorOrHuman(input.providerReadiness);
  return makePlan({
    input,
    state: primary.kind === "coordinator" ? "escalated" : "blocked",
    primary,
    candidates: [primary, HUMAN_SURFACE],
    reasonCodes: primary.kind === "coordinator"
      ? reasonCodes
      : [...reasonCodes, "COORDINATOR_NOT_READY"],
    prerequisites,
    probeBeforeRetry: input.requiresBrowser,
  });
}

function firstReady(
  candidates: readonly ModelRoutingSurface[],
  readiness: ModelRoutingReadiness,
): ModelRoutingSurface | undefined {
  return candidates.find((candidate) => isReady(candidate, readiness));
}

/**
 * Build one immutable routing plan. Every branch is an explicit code rule;
 * provider/model output is never accepted as a routing decision.
 */
export function planModelRoute(input: ModelRoutingInput): ModelRoutingPlan {
  const externalOutcome = input.externalOutcome ?? "not_applicable";

  if (externalOutcome === "ambiguous") {
    const probeCandidates = [customAgent("wenmai_publish_operator"), COORDINATOR_SURFACE];
    const primary = firstReady(probeCandidates, input.providerReadiness) ?? HUMAN_SURFACE;
    return makePlan({
      input,
      effectivePhase: "browser_probe",
      state: "probe_required",
      primary,
      candidates: [...probeCandidates, HUMAN_SURFACE],
      reasonCodes: ["AMBIGUOUS_RESULT_PROBE_FIRST"],
      prerequisites: ["只读探测创作后台和公开页；在结果被证实前冻结一切外部写入"],
      probeBeforeRetry: true,
    });
  }

  if (input.phase === "deterministic_validation") {
    return makePlan({
      input,
      state: "ready",
      primary: DETERMINISTIC_SURFACE,
      candidates: [DETERMINISTIC_SURFACE],
      reasonCodes: ["DETERMINISTIC_RULE"],
    });
  }

  if (input.phase === "completion_claim") {
    const primary = coordinatorOrHuman(input.providerReadiness);
    return makePlan({
      input,
      state: primary.kind === "coordinator" ? "ready" : "blocked",
      primary,
      candidates: [COORDINATOR_SURFACE, HUMAN_SURFACE],
      reasonCodes: primary.kind === "coordinator"
        ? ["COMPLETION_REQUIRES_COORDINATOR"]
        : ["COMPLETION_REQUIRES_COORDINATOR", "COORDINATOR_NOT_READY"],
      prerequisites: ["必须读取分层回执后再形成完成声明"],
    });
  }

  if (input.phase === "ambiguous_judgment" || input.requiresJudgment) {
    return escalate(input, ["JUDGMENT_REQUIRES_COORDINATOR"]);
  }

  if (input.risk === "critical" || input.risk === "high") {
    return escalate(input, ["HIGH_RISK_ESCALATION"]);
  }

  const intermediatePhase = input.phase === "intermediate_private" || input.phase === "intermediate_fast";
  if (intermediatePhase && (
    input.frozenInput !== true
    || !/^[a-f0-9]{64}$/u.test(input.inputSha256 ?? "")
    || !MODEL_ROUTING_MECHANICAL_TASKS.includes(input.mechanicalTask as ModelRoutingMechanicalTask)
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(input.outputSchemaId ?? "")
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(input.outputSchemaVersion ?? "")
    || input.candidateOnly !== true
    || input.contentMutationRequested !== false
  )) {
    return escalate(input, ["MECHANICAL_TASK_CONTRACT_REQUIRED"], [
      "中间模型只接受冻结输入、64 位输入摘要、固定机械任务、输出 schema、candidateOnly=true 且禁止内容改写的候选任务",
    ]);
  }

  const browserPhase = input.phase.startsWith("browser_");
  if (browserPhase !== input.requiresBrowser) {
    return escalate(input, ["BROWSER_CONTRACT_MISMATCH"], ["修正阶段与 requiresBrowser 的合同不一致"]);
  }

  if (input.phase === "browser_publish_once") {
    return makePlan({
      input,
      state: "needs_human",
      primary: HUMAN_SURFACE,
      candidates: [HUMAN_SURFACE, COORDINATOR_SURFACE],
      reasonCodes: ["PUBLISH_SERVER_AUTHORITY_REQUIRED", "PUBLISH_OPERATOR_HOST_ROUTE_UNVERIFIED"],
      prerequisites: [
        "Release Control V2 的服务端权威能力消费与唯一 click lease 控制面必须持续通过当前批次校验；路由规划本身不得授权发布",
        "Publish Operator 的宿主路由尚未验收（WENMAI_PUBLISH_OPERATOR_HOST_ROUTE_VERIFIED 必须为 false）；不得生成可点击执行计划",
      ],
      probeBeforeRetry: true,
      publishTicketRequired: true,
    });
  }

  if (input.phase === "browser_prepare" || input.phase === "browser_probe") {
    if (input.contentMutationRequested) {
      return escalate(input, ["CONTENT_MUTATION_FORBIDDEN"], ["浏览器工位只能机械搬运冻结内容"]);
    }
    if (input.phase === "browser_prepare" && input.frozenInput !== true) {
      return escalate(input, ["FROZEN_INPUT_REQUIRED"], ["先冻结内容和工件摘要"]);
    }
    const candidates = [customAgent("wenmai_publish_operator"), COORDINATOR_SURFACE];
    const primary = firstReady(candidates, input.providerReadiness);
    if (!primary) {
      return makePlan({
        input,
        state: "blocked",
        primary: HUMAN_SURFACE,
        candidates: [...candidates, HUMAN_SURFACE],
        reasonCodes: ["EXECUTOR_NOT_READY", "COORDINATOR_NOT_READY"],
        prerequisites: ["等待浏览器执行器就绪"],
        probeBeforeRetry: true,
      });
    }
    return makePlan({
      input,
      state: primary.kind === "coordinator" ? "escalated" : "ready",
      primary,
      candidates: [...candidates, HUMAN_SURFACE],
      reasonCodes: primary.kind === "coordinator"
        ? ["EXECUTOR_NOT_READY"]
        : ["BROWSER_OPERATOR"],
      prerequisites: input.phase === "browser_prepare"
        ? ["精确回读填充内容并停在提交前"]
        : ["只读探测，不执行提交或改写"],
      probeBeforeRetry: true,
    });
  }

  if (input.phase === "intermediate_private") {
    const local = gateway("ollama");
    if (isReady(local, input.providerReadiness)) {
      return makePlan({
        input,
        state: "ready",
        primary: local,
        candidates: [local, COORDINATOR_SURFACE, HUMAN_SURFACE],
        reasonCodes: ["PRIVATE_LOCAL_PROVIDER"],
      });
    }
    return escalate(input, ["SENSITIVE_DATA_BLOCKS_CLOUD", "EXECUTOR_NOT_READY"], [
      "配置服务端允许列表中的本机或局域网 Ollama 节点，或由协调器本地处理",
    ]);
  }

  const fastCandidates: readonly ModelRoutingSurface[] = input.dataSensitivity === "confidential"
    || input.dataSensitivity === "restricted"
    ? [gateway("ollama"), COORDINATOR_SURFACE]
    : [
        gateway("openai"),
        customAgent("wenmai_fast_worker"),
        gateway("qwen"),
        gateway("deepseek"),
        COORDINATOR_SURFACE,
      ];
  const primary = firstReady(fastCandidates, input.providerReadiness) ?? HUMAN_SURFACE;
  const cloudBlocked = input.dataSensitivity === "confidential" || input.dataSensitivity === "restricted";
  return makePlan({
    input,
    state: primary.kind === "coordinator" ? "escalated" : primary.kind === "human" ? "blocked" : "ready",
    primary,
    candidates: [...fastCandidates, HUMAN_SURFACE],
    reasonCodes: [
      ...(cloudBlocked ? ["SENSITIVE_DATA_BLOCKS_CLOUD" as const] : []),
      ...(primary.kind === "coordinator" || primary.kind === "human"
        ? ["EXECUTOR_NOT_READY" as const]
        : ["FAST_PROVIDER" as const]),
      ...(primary.kind === "human" ? ["COORDINATOR_NOT_READY" as const] : []),
    ],
    prerequisites: cloudBlocked && primary.kind === "human"
      ? ["配置受信任的 Ollama 节点或恢复协调器"]
      : [],
  });
}
