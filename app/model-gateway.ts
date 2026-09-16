/**
 * Server-only model provider gateway.
 *
 * This module deliberately receives environment bindings from its caller. It
 * never reads global runtime bindings, accepts a caller-controlled upstream URL, or exposes
 * an API key in a return value or error.
 */

export const MODEL_GATEWAY_PROVIDER_IDS = Object.freeze([
  "deepseek",
  "qwen",
  "openai",
  "ollama",
] as const);

export type ModelGatewayProvider = (typeof MODEL_GATEWAY_PROVIDER_IDS)[number];

export const MODEL_GATEWAY_ADAPTER_VERSION = "openai-chat-completions-json/2";

export const MODEL_GATEWAY_ENV_NAMES = Object.freeze({
  deepseek: Object.freeze({ apiKey: "DEEPSEEK_API_KEY", model: "DEEPSEEK_MODEL" }),
  qwen: Object.freeze({ apiKey: "DASHSCOPE_API_KEY", model: "QWEN_MODEL" }),
  openai: Object.freeze({ apiKey: "OPENAI_API_KEY", model: "OPENAI_FAST_MODEL" }),
  ollama: Object.freeze({
    apiKey: "OLLAMA_API_KEY",
    model: "OLLAMA_MODEL",
    baseUrl: "OLLAMA_BASE_URL",
    allowedHosts: "OLLAMA_ALLOWED_HOSTS",
  }),
} as const);

export type ModelGatewayServerEnv = Readonly<Record<string, unknown>>;

export type ModelGatewayChatRole = "system" | "user" | "assistant";

export type ModelGatewayChatMessage = Readonly<{
  role: ModelGatewayChatRole;
  content: string;
}>;

export type ModelGatewayJsonPrimitive = string | number | boolean | null;
export type ModelGatewayJsonValue =
  | ModelGatewayJsonPrimitive
  | ModelGatewayJsonValue[]
  | ModelGatewayJsonObject;
export type ModelGatewayJsonObject = { [key: string]: ModelGatewayJsonValue };

export type ModelGatewayFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export const MODEL_GATEWAY_DEFAULT_TIMEOUT_MS = 120_000;
export const MODEL_GATEWAY_MAX_TIMEOUT_MS = 300_000;
// Match the durable invocation checkpoint ceiling. A paid response that is
// accepted in memory must always fit the server-side recovery record.
export const MODEL_GATEWAY_MAX_RESPONSE_BYTES = 256 * 1024;
export const MODEL_GATEWAY_MAX_INPUT_CHARS = 2 * 1024 * 1024;
export const MODEL_GATEWAY_DEFAULT_OUTPUT_TOKENS = 8_192;
export const MODEL_GATEWAY_MAX_OUTPUT_TOKENS = 32_768;

const MODEL_GATEWAY_MIN_TIMEOUT_MS = 50;
const MODEL_GATEWAY_MAX_MESSAGES = 128;
const MODEL_GATEWAY_MAX_SECRET_CHARS = 4_096;
const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const OLLAMA_MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u;
const OLLAMA_SERVER_CONFIGURED_BASE_URL = "server-configured";
const JSON_SYSTEM_CONTRACT =
  "Return exactly one valid JSON object. Do not use Markdown fences or include text outside the JSON object.";

type ProviderDefinition = Readonly<{
  provider: ModelGatewayProvider;
  protocol: "openai-chat-completions" | "ollama-chat";
  baseUrl: string;
  chatCompletionsUrl: string;
  defaultModel: string;
  apiKeyEnvName: "DEEPSEEK_API_KEY" | "DASHSCOPE_API_KEY" | "OPENAI_API_KEY" | "OLLAMA_API_KEY";
  modelEnvName: "DEEPSEEK_MODEL" | "QWEN_MODEL" | "OPENAI_FAST_MODEL" | "OLLAMA_MODEL";
  modelPrefix?: "deepseek-" | "qwen" | "gpt-";
  apiKeyRequired: boolean;
  explicitModelRequired?: boolean;
  outputTokenField: "max_tokens" | "max_completion_tokens";
}>;

const PROVIDER_DEFINITIONS: Readonly<Record<ModelGatewayProvider, ProviderDefinition>> = Object.freeze({
  deepseek: Object.freeze({
    provider: "deepseek",
    protocol: "openai-chat-completions",
    baseUrl: "https://api.deepseek.com",
    chatCompletionsUrl: "https://api.deepseek.com/chat/completions",
    defaultModel: "deepseek-v4-pro",
    apiKeyEnvName: MODEL_GATEWAY_ENV_NAMES.deepseek.apiKey,
    modelEnvName: MODEL_GATEWAY_ENV_NAMES.deepseek.model,
    modelPrefix: "deepseek-",
    apiKeyRequired: true,
    outputTokenField: "max_tokens",
  }),
  qwen: Object.freeze({
    provider: "qwen",
    protocol: "openai-chat-completions",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    chatCompletionsUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
    defaultModel: "qwen3.7-plus",
    apiKeyEnvName: MODEL_GATEWAY_ENV_NAMES.qwen.apiKey,
    modelEnvName: MODEL_GATEWAY_ENV_NAMES.qwen.model,
    modelPrefix: "qwen",
    apiKeyRequired: true,
    outputTokenField: "max_completion_tokens",
  }),
  openai: Object.freeze({
    provider: "openai",
    protocol: "openai-chat-completions",
    baseUrl: "https://api.openai.com/v1",
    chatCompletionsUrl: "https://api.openai.com/v1/chat/completions",
    defaultModel: "gpt-5.6-luna",
    apiKeyEnvName: MODEL_GATEWAY_ENV_NAMES.openai.apiKey,
    modelEnvName: MODEL_GATEWAY_ENV_NAMES.openai.model,
    modelPrefix: "gpt-",
    apiKeyRequired: true,
    outputTokenField: "max_completion_tokens",
  }),
  ollama: Object.freeze({
    provider: "ollama",
    protocol: "ollama-chat",
    baseUrl: OLLAMA_SERVER_CONFIGURED_BASE_URL,
    chatCompletionsUrl: "",
    defaultModel: "",
    apiKeyEnvName: MODEL_GATEWAY_ENV_NAMES.ollama.apiKey,
    modelEnvName: MODEL_GATEWAY_ENV_NAMES.ollama.model,
    apiKeyRequired: false,
    explicitModelRequired: true,
    outputTokenField: "max_tokens",
  }),
});

export const MODEL_GATEWAY_PROVIDER_DESCRIPTORS = Object.freeze(
  MODEL_GATEWAY_PROVIDER_IDS.map((provider) => {
    const definition = PROVIDER_DEFINITIONS[provider];
    return Object.freeze({
      provider: definition.provider,
      baseUrl: definition.baseUrl,
      defaultModel: definition.defaultModel,
      apiKeyEnvName: definition.apiKeyEnvName,
      modelEnvName: definition.modelEnvName,
    });
  }),
);

export type ModelGatewayErrorCode =
  | "MODEL_GATEWAY_SERVER_ONLY"
  | "MODEL_PROVIDER_UNSUPPORTED"
  | "MODEL_PROVIDER_NOT_CONFIGURED"
  | "MODEL_PROVIDER_KEY_INVALID"
  | "MODEL_PROVIDER_MODEL_INVALID"
  | "MODEL_PROVIDER_ENDPOINT_INVALID"
  | "MODEL_REQUEST_INVALID"
  | "MODEL_REQUEST_TOO_LARGE"
  | "MODEL_REQUEST_TIMEOUT"
  | "MODEL_REQUEST_ABORTED"
  | "MODEL_PROVIDER_AUTH_FAILED"
  | "MODEL_PROVIDER_BILLING_REQUIRED"
  | "MODEL_PROVIDER_RATE_LIMITED"
  | "MODEL_PROVIDER_REQUEST_REJECTED"
  | "MODEL_PROVIDER_UNAVAILABLE"
  | "MODEL_RESPONSE_TOO_LARGE"
  | "MODEL_RESPONSE_INVALID"
  | "MODEL_RESPONSE_INCOMPLETE"
  | "MODEL_PROBE_FAILED";

type ModelGatewayErrorOptions = Readonly<{
  provider?: ModelGatewayProvider;
  retryable?: boolean;
  upstreamStatus?: number;
  limit?: number;
}>;

export type ModelGatewaySafeError = Readonly<{
  name: "ModelGatewayError";
  code: ModelGatewayErrorCode;
  message: string;
  status: number;
  retryable: boolean;
  provider?: ModelGatewayProvider;
  upstreamStatus?: number;
  limit?: number;
}>;

export class ModelGatewayError extends Error {
  readonly code: ModelGatewayErrorCode;
  readonly status: number;
  readonly retryable: boolean;
  readonly provider?: ModelGatewayProvider;
  readonly upstreamStatus?: number;
  readonly limit?: number;

  constructor(
    code: ModelGatewayErrorCode,
    message: string,
    status = 400,
    options: ModelGatewayErrorOptions = {},
  ) {
    super(message);
    this.name = "ModelGatewayError";
    this.code = code;
    this.status = status;
    this.retryable = options.retryable ?? false;
    this.provider = options.provider;
    this.upstreamStatus = options.upstreamStatus;
    this.limit = options.limit;
  }

  toJSON(): ModelGatewaySafeError {
    return toModelGatewaySafeError(this);
  }
}

export function toModelGatewaySafeError(error: unknown): ModelGatewaySafeError {
  if (error instanceof ModelGatewayError) {
    const safe: {
      name: "ModelGatewayError";
      code: ModelGatewayErrorCode;
      message: string;
      status: number;
      retryable: boolean;
      provider?: ModelGatewayProvider;
      upstreamStatus?: number;
      limit?: number;
    } = {
      name: "ModelGatewayError",
      code: error.code,
      message: error.message,
      status: error.status,
      retryable: error.retryable,
    };
    if (error.provider) safe.provider = error.provider;
    if (error.upstreamStatus !== undefined) safe.upstreamStatus = error.upstreamStatus;
    if (error.limit !== undefined) safe.limit = error.limit;
    return Object.freeze(safe);
  }
  return Object.freeze({
    name: "ModelGatewayError",
    code: "MODEL_PROVIDER_UNAVAILABLE",
    message: "模型服务调用失败",
    status: 502,
    retryable: false,
  });
}

export type ModelGatewayProviderStatus = Readonly<{
  provider: ModelGatewayProvider;
  configured: boolean;
  ready: boolean;
  model: string;
  baseUrl: string;
  error?: ModelGatewaySafeError;
}>;

export type ModelGatewayUsage = Readonly<{
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}>;

export type ModelGatewayJsonResult<T extends ModelGatewayJsonObject = ModelGatewayJsonObject> = Readonly<{
  provider: ModelGatewayProvider;
  model: string;
  requestId: string | null;
  finishReason: "stop";
  value: T;
  usage?: ModelGatewayUsage;
}>;

export type ModelGatewayJsonRequest = Readonly<{
  provider: ModelGatewayProvider;
  env: ModelGatewayServerEnv;
  messages: readonly ModelGatewayChatMessage[];
  timeoutMs?: number;
  maxOutputTokens?: number;
  sampling?: Readonly<{
    temperature: number;
    topP: number;
  }>;
  signal?: AbortSignal;
  fetchImpl?: ModelGatewayFetch;
}>;

export type ModelGatewayProbeResult = Readonly<{
  provider: ModelGatewayProvider;
  configured: boolean;
  ok: boolean;
  model: string;
  baseUrl: string;
  checkedAt: string;
  latencyMs: number;
  requestId?: string | null;
  error?: ModelGatewaySafeError;
}>;

export function assertModelGatewayServerRuntime(): void {
  if (typeof window !== "undefined") {
    throw new ModelGatewayError(
      "MODEL_GATEWAY_SERVER_ONLY",
      "模型网关只能在服务端运行",
      500,
    );
  }
}

export function isModelGatewayProvider(value: unknown): value is ModelGatewayProvider {
  return value === "deepseek" || value === "qwen" || value === "openai" || value === "ollama";
}

function providerDefinition(value: unknown): ProviderDefinition {
  if (!isModelGatewayProvider(value)) {
    throw new ModelGatewayError(
      "MODEL_PROVIDER_UNSUPPORTED",
      "不支持的模型供应商",
      400,
    );
  }
  return PROVIDER_DEFINITIONS[value];
}

function envValue(env: ModelGatewayServerEnv, name: string): string {
  if (!env || typeof env !== "object") return "";
  const value = env[name];
  return typeof value === "string" ? value.trim() : "";
}

function resolveModel(definition: ProviderDefinition, env: ModelGatewayServerEnv): string {
  const override = envValue(env, definition.modelEnvName);
  if (!override) {
    if (definition.explicitModelRequired) {
      throw new ModelGatewayError(
        "MODEL_PROVIDER_NOT_CONFIGURED",
        "模型供应商尚未配置服务端模型",
        503,
        { provider: definition.provider },
      );
    }
    return definition.defaultModel;
  }
  const validPattern = definition.protocol === "ollama-chat"
    ? OLLAMA_MODEL_ID_PATTERN.test(override)
    : MODEL_ID_PATTERN.test(override);
  if (
    !validPattern
    || (definition.modelPrefix !== undefined
      && !override.toLowerCase().startsWith(definition.modelPrefix))
  ) {
    throw new ModelGatewayError(
      "MODEL_PROVIDER_MODEL_INVALID",
      "服务端模型覆盖值无效",
      500,
      { provider: definition.provider },
    );
  }
  return override;
}

function resolveApiKey(definition: ProviderDefinition, env: ModelGatewayServerEnv): string {
  const key = envValue(env, definition.apiKeyEnvName);
  if (!key && definition.apiKeyRequired) {
    throw new ModelGatewayError(
      "MODEL_PROVIDER_NOT_CONFIGURED",
      "模型供应商尚未配置服务端凭据",
      503,
      { provider: definition.provider },
    );
  }
  if (!key) return "";
  if (key.length > MODEL_GATEWAY_MAX_SECRET_CHARS || /[\r\n\0]/u.test(key)) {
    throw new ModelGatewayError(
      "MODEL_PROVIDER_KEY_INVALID",
      "模型供应商服务端凭据格式无效",
      503,
      { provider: definition.provider },
    );
  }
  return key;
}

function configuredSecret(definition: ProviderDefinition, env: ModelGatewayServerEnv): boolean {
  const key = envValue(env, definition.apiKeyEnvName);
  if (!key) return !definition.apiKeyRequired;
  return key.length <= MODEL_GATEWAY_MAX_SECRET_CHARS && !/[\r\n\0]/u.test(key);
}

function normalizeHostname(hostname: string): string {
  const lower = hostname.trim().toLowerCase();
  return lower.startsWith("[") && lower.endsWith("]") ? lower.slice(1, -1) : lower;
}

function isIpv4Literal(hostname: string): boolean {
  const parts = hostname.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/u.test(part))) return false;
  const octets = parts.map(Number);
  return !octets.some((part) => part < 0 || part > 255);
}

function isLoopbackIpv4(hostname: string): boolean {
  if (!isIpv4Literal(hostname)) return false;
  const [a] = hostname.split(".").map(Number);
  return a === 127;
}

function isRfc1918Ipv4(hostname: string): boolean {
  if (!isIpv4Literal(hostname)) return false;
  const [a, b] = hostname.split(".").map(Number);
  return a === 10
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168);
}

function isLoopbackIpv6(hostname: string): boolean {
  return hostname === "::1";
}

function isUlaIpv6(hostname: string): boolean {
  if (!hostname.includes(":")) return false;
  const firstGroup = hostname.split(":", 1)[0];
  if (!/^[0-9a-f]{1,4}$/u.test(firstGroup)) return false;
  const first = Number.parseInt(firstGroup, 16);
  return (first & 0xfe00) === 0xfc00;
}

function normalizeExplicitOllamaHostPort(value: string): string | null {
  const normalized = value.trim().toLowerCase();
  const ipv6 = /^\[([0-9a-f:]+)\]:(\d{1,5})$/u.exec(normalized);
  const ipv4 = /^((?:\d{1,3}\.){3}\d{1,3}):(\d{1,5})$/u.exec(normalized);
  const match = ipv6 ?? ipv4;
  if (!match) return null;
  const [, rawHost, rawPort] = match;
  const port = Number(rawPort);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) return null;
  if (ipv4 && !isIpv4Literal(rawHost)) return null;
  if (ipv6 && !isUlaIpv6(rawHost) && !isLoopbackIpv6(rawHost)) return null;
  return ipv6 ? `[${rawHost}]:${port}` : `${rawHost}:${port}`;
}

function allowedOllamaHosts(env: ModelGatewayServerEnv): ReadonlySet<string> {
  const raw = envValue(env, MODEL_GATEWAY_ENV_NAMES.ollama.allowedHosts);
  if (!raw) return new Set();
  if (raw.length > 8_192 || /[\r\n\0]/u.test(raw)) {
    throw new ModelGatewayError(
      "MODEL_PROVIDER_ENDPOINT_INVALID",
      "Ollama 服务端允许主机配置无效",
      503,
      { provider: "ollama" },
    );
  }
  const entries = raw.split(",").map(normalizeExplicitOllamaHostPort);
  if (entries.some((value) => value === null)) {
    throw new ModelGatewayError(
      "MODEL_PROVIDER_ENDPOINT_INVALID",
      "Ollama 服务端允许主机配置无效",
      503,
      { provider: "ollama" },
    );
  }
  return new Set(entries.filter((value): value is string => value !== null));
}

function resolveOllamaBaseUrl(env: ModelGatewayServerEnv): string {
  const configuredUrl = envValue(env, MODEL_GATEWAY_ENV_NAMES.ollama.baseUrl);
  if (!configuredUrl) {
    throw new ModelGatewayError(
      "MODEL_PROVIDER_NOT_CONFIGURED",
      "Ollama 尚未配置服务端地址",
      503,
      { provider: "ollama" },
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(configuredUrl);
  } catch {
    throw new ModelGatewayError(
      "MODEL_PROVIDER_ENDPOINT_INVALID",
      "Ollama 服务端地址无效",
      503,
      { provider: "ollama" },
    );
  }
  if (
    !["http:", "https:"].includes(parsed.protocol)
    || parsed.username !== ""
    || parsed.password !== ""
    || parsed.search !== ""
    || parsed.hash !== ""
    || !["", "/"].includes(parsed.pathname)
  ) {
    throw new ModelGatewayError(
      "MODEL_PROVIDER_ENDPOINT_INVALID",
      "Ollama 服务端地址无效",
      503,
      { provider: "ollama" },
    );
  }
  const hostname = normalizeHostname(parsed.hostname);
  const rawAuthority = configuredUrl.slice(configuredUrl.indexOf("//") + 2).split(/[/?#]/u, 1)[0];
  const normalizedHostPort = normalizeExplicitOllamaHostPort(rawAuthority);
  if (!normalizedHostPort) {
    throw new ModelGatewayError(
      "MODEL_PROVIDER_ENDPOINT_INVALID",
      "Ollama 服务端地址无效",
      503,
      { provider: "ollama" },
    );
  }
  const explicitlyAllowed = allowedOllamaHosts(env);
  const loopback = isLoopbackIpv4(hostname) || isLoopbackIpv6(hostname);
  const privateNetwork = isRfc1918Ipv4(hostname) || isUlaIpv6(hostname);
  const permitted = loopback || (privateNetwork && explicitlyAllowed.has(normalizedHostPort));
  if (!permitted) {
    throw new ModelGatewayError(
      "MODEL_PROVIDER_ENDPOINT_INVALID",
      "Ollama 服务端地址不在允许的本地或私有网络范围内",
      503,
      { provider: "ollama" },
    );
  }
  return parsed.origin;
}

type ResolvedProviderConnection = Readonly<{
  baseUrl: string;
  requestUrl: string;
  apiKey: string;
}>;

function resolveProviderConnection(
  definition: ProviderDefinition,
  env: ModelGatewayServerEnv,
): ResolvedProviderConnection {
  const apiKey = resolveApiKey(definition, env);
  if (definition.protocol === "ollama-chat") {
    const baseUrl = resolveOllamaBaseUrl(env);
    return Object.freeze({ baseUrl, requestUrl: `${baseUrl}/api/chat`, apiKey });
  }
  return Object.freeze({
    baseUrl: definition.baseUrl,
    requestUrl: definition.chatCompletionsUrl,
    apiKey,
  });
}

export function getModelGatewayProviderStatus(
  provider: ModelGatewayProvider,
  env: ModelGatewayServerEnv,
): ModelGatewayProviderStatus {
  assertModelGatewayServerRuntime();
  const definition = providerDefinition(provider);
  const configured = definition.protocol === "ollama-chat"
    ? Boolean(
      envValue(env, MODEL_GATEWAY_ENV_NAMES.ollama.baseUrl)
      && envValue(env, MODEL_GATEWAY_ENV_NAMES.ollama.model)
      && configuredSecret(definition, env)
    )
    : configuredSecret(definition, env);
  let model: string;
  try {
    model = resolveModel(definition, env);
  } catch (error) {
    return Object.freeze({
      provider,
      configured,
      ready: false,
      model: definition.defaultModel,
      baseUrl: definition.baseUrl,
      error: toModelGatewaySafeError(error),
    });
  }
  try {
    const connection = resolveProviderConnection(definition, env);
    return Object.freeze({
      provider,
      configured,
      ready: configured,
      model,
      baseUrl: connection.baseUrl,
    });
  } catch (error) {
    return Object.freeze({
      provider,
      configured,
      ready: false,
      model,
      baseUrl: definition.baseUrl,
      error: toModelGatewaySafeError(error),
    });
  }
}

export function listModelGatewayProviderStatuses(
  env: ModelGatewayServerEnv,
): readonly ModelGatewayProviderStatus[] {
  assertModelGatewayServerRuntime();
  return Object.freeze(
    MODEL_GATEWAY_PROVIDER_IDS.map((provider) => getModelGatewayProviderStatus(provider, env)),
  );
}

function normalizeMessages(messages: readonly ModelGatewayChatMessage[]): ModelGatewayChatMessage[] {
  if (!Array.isArray(messages) || messages.length === 0 || messages.length > MODEL_GATEWAY_MAX_MESSAGES) {
    throw new ModelGatewayError(
      "MODEL_REQUEST_INVALID",
      "模型请求必须包含有效的消息列表",
      400,
    );
  }
  let totalChars = JSON_SYSTEM_CONTRACT.length;
  const normalized: ModelGatewayChatMessage[] = [
    { role: "system", content: JSON_SYSTEM_CONTRACT },
  ];
  for (const message of messages) {
    if (
      !message
      || !["system", "user", "assistant"].includes(message.role)
      || typeof message.content !== "string"
      || message.content.length === 0
    ) {
      throw new ModelGatewayError(
        "MODEL_REQUEST_INVALID",
        "模型请求消息格式无效",
        400,
      );
    }
    totalChars += message.content.length;
    if (totalChars > MODEL_GATEWAY_MAX_INPUT_CHARS) {
      throw new ModelGatewayError(
        "MODEL_REQUEST_TOO_LARGE",
        "模型请求内容超过大小上限",
        413,
        { limit: MODEL_GATEWAY_MAX_INPUT_CHARS },
      );
    }
    normalized.push({ role: message.role, content: message.content });
  }
  return normalized;
}

function normalizeTimeout(value: number | undefined): number {
  const timeout = value ?? MODEL_GATEWAY_DEFAULT_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(timeout)
    || timeout < MODEL_GATEWAY_MIN_TIMEOUT_MS
    || timeout > MODEL_GATEWAY_MAX_TIMEOUT_MS
  ) {
    throw new ModelGatewayError(
      "MODEL_REQUEST_INVALID",
      "模型请求超时时间无效",
      400,
      { limit: MODEL_GATEWAY_MAX_TIMEOUT_MS },
    );
  }
  return timeout;
}

function normalizeOutputTokens(value: number | undefined): number {
  const outputTokens = value ?? MODEL_GATEWAY_DEFAULT_OUTPUT_TOKENS;
  if (
    !Number.isSafeInteger(outputTokens)
    || outputTokens < 1
    || outputTokens > MODEL_GATEWAY_MAX_OUTPUT_TOKENS
  ) {
    throw new ModelGatewayError(
      "MODEL_REQUEST_INVALID",
      "模型输出 Token 上限无效",
      400,
      { limit: MODEL_GATEWAY_MAX_OUTPUT_TOKENS },
    );
  }
  return outputTokens;
}

function normalizeSampling(value: ModelGatewayJsonRequest["sampling"]): Readonly<{
  temperature: number;
  topP: number;
}> {
  const temperature = value?.temperature ?? 0;
  const topP = value?.topP ?? 1;
  if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2
    || !Number.isFinite(topP) || topP <= 0 || topP > 1) {
    throw new ModelGatewayError(
      "MODEL_REQUEST_INVALID",
      "模型采样参数无效",
      400,
    );
  }
  return Object.freeze({ temperature, topP });
}

function buildRequestBody(
  definition: ProviderDefinition,
  model: string,
  messages: readonly ModelGatewayChatMessage[],
  maxOutputTokens: number,
  sampling: Readonly<{ temperature: number; topP: number }>,
): Record<string, unknown> {
  if (definition.protocol === "ollama-chat") {
    return {
      model,
      messages,
      format: "json",
      stream: false,
      options: {
        temperature: sampling.temperature,
        top_p: sampling.topP,
        num_predict: maxOutputTokens,
      },
    };
  }
  return {
    model,
    messages,
    response_format: { type: "json_object" },
    stream: false,
    temperature: sampling.temperature,
    top_p: sampling.topP,
    [definition.outputTokenField]: maxOutputTokens,
  };
}

function createAbortScope(timeoutMs: number, externalSignal?: AbortSignal) {
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const abortFromCaller = () => controller.abort();
  if (externalSignal?.aborted) {
    abortFromCaller();
  } else {
    externalSignal?.addEventListener("abort", abortFromCaller, { once: true });
  }
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    cleanup: () => {
      clearTimeout(timeout);
      externalSignal?.removeEventListener("abort", abortFromCaller);
    },
  };
}

async function cancelBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Cancellation is best-effort and must not replace the structured error.
  }
}

async function readResponseTextLimited(response: Response, provider: ModelGatewayProvider): Promise<string> {
  const contentLength = response.headers.get("content-length");
  if (contentLength && /^\d+$/u.test(contentLength) && Number(contentLength) > MODEL_GATEWAY_MAX_RESPONSE_BYTES) {
    await cancelBody(response);
    throw new ModelGatewayError(
      "MODEL_RESPONSE_TOO_LARGE",
      "模型响应超过大小上限",
      502,
      { provider, limit: MODEL_GATEWAY_MAX_RESPONSE_BYTES },
    );
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let totalBytes = 0;
  let text = "";
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      totalBytes += part.value.byteLength;
      if (totalBytes > MODEL_GATEWAY_MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new ModelGatewayError(
          "MODEL_RESPONSE_TOO_LARGE",
          "模型响应超过大小上限",
          502,
          { provider, limit: MODEL_GATEWAY_MAX_RESPONSE_BYTES },
        );
      }
      text += decoder.decode(part.value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } catch (error) {
    if (error instanceof ModelGatewayError) throw error;
    if (error instanceof TypeError) {
      throw new ModelGatewayError(
        "MODEL_RESPONSE_INVALID",
        "模型响应不是有效的 UTF-8 文本",
        502,
        { provider },
      );
    }
    throw error;
  }
}

function upstreamError(provider: ModelGatewayProvider, upstreamStatus: number): ModelGatewayError {
  if (upstreamStatus === 401 || upstreamStatus === 403) {
    return new ModelGatewayError(
      "MODEL_PROVIDER_AUTH_FAILED",
      "模型供应商鉴权失败",
      503,
      { provider, upstreamStatus },
    );
  }
  if (upstreamStatus === 402) {
    return new ModelGatewayError(
      "MODEL_PROVIDER_BILLING_REQUIRED",
      "模型供应商账户余额或额度不足",
      503,
      { provider, upstreamStatus },
    );
  }
  if (upstreamStatus === 429) {
    return new ModelGatewayError(
      "MODEL_PROVIDER_RATE_LIMITED",
      "模型供应商当前限流",
      429,
      { provider, upstreamStatus, retryable: true },
    );
  }
  if (upstreamStatus >= 500) {
    return new ModelGatewayError(
      "MODEL_PROVIDER_UNAVAILABLE",
      "模型供应商暂时不可用",
      503,
      { provider, upstreamStatus, retryable: true },
    );
  }
  return new ModelGatewayError(
    "MODEL_PROVIDER_REQUEST_REJECTED",
    "模型供应商拒绝了请求",
    502,
    { provider, upstreamStatus },
  );
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function safeShortText(value: unknown): string | null {
  return typeof value === "string" && value.length <= 256 ? value : null;
}

function safeTokenCount(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : undefined;
}

function parseUsage(value: unknown): ModelGatewayUsage | undefined {
  const usage = asRecord(value);
  if (!usage) return undefined;
  const inputTokens = safeTokenCount(usage.prompt_tokens ?? usage.input_tokens);
  const outputTokens = safeTokenCount(usage.completion_tokens ?? usage.output_tokens);
  const totalTokens = safeTokenCount(usage.total_tokens);
  if (inputTokens === undefined && outputTokens === undefined && totalTokens === undefined) return undefined;
  const result: { inputTokens?: number; outputTokens?: number; totalTokens?: number } = {};
  if (inputTokens !== undefined) result.inputTokens = inputTokens;
  if (outputTokens !== undefined) result.outputTokens = outputTokens;
  if (totalTokens !== undefined) result.totalTokens = totalTokens;
  return Object.freeze(result);
}

function parseProviderResponse<T extends ModelGatewayJsonObject>(
  text: string,
  definition: ProviderDefinition,
  model: string,
): ModelGatewayJsonResult<T> {
  let envelopeValue: unknown;
  try {
    envelopeValue = JSON.parse(text.replace(/^\uFEFF/u, ""));
  } catch {
    throw new ModelGatewayError(
      "MODEL_RESPONSE_INVALID",
      "模型供应商返回了无效响应",
      502,
      { provider: definition.provider },
    );
  }
  const envelope = asRecord(envelopeValue);
  if (definition.protocol === "ollama-chat") {
    return parseOllamaResponse<T>(envelope, definition, model);
  }
  const choices = Array.isArray(envelope?.choices) ? envelope.choices : [];
  const choice = asRecord(choices[0]);
  const message = asRecord(choice?.message);
  const content = message?.content;
  const finishReason = choice?.finish_reason;
  if (finishReason !== "stop") {
    throw new ModelGatewayError(
      "MODEL_RESPONSE_INCOMPLETE",
      "模型响应未完整结束",
      502,
      { provider: definition.provider },
    );
  }
  if (typeof content !== "string" || content.length === 0) {
    throw new ModelGatewayError(
      "MODEL_RESPONSE_INVALID",
      "模型响应缺少 JSON 内容",
      502,
      { provider: definition.provider },
    );
  }
  let parsedValue: unknown;
  try {
    parsedValue = JSON.parse(content.replace(/^\uFEFF/u, ""));
  } catch {
    throw new ModelGatewayError(
      "MODEL_RESPONSE_INVALID",
      "模型未返回有效的 JSON 对象",
      502,
      { provider: definition.provider },
    );
  }
  const value = asRecord(parsedValue);
  if (!value) {
    throw new ModelGatewayError(
      "MODEL_RESPONSE_INVALID",
      "模型返回的 JSON 顶层必须是对象",
      502,
      { provider: definition.provider },
    );
  }
  const requestId = safeShortText(envelope?.id);
  const usage = parseUsage(envelope?.usage);
  const result: {
    provider: ModelGatewayProvider;
    model: string;
    requestId: string | null;
    finishReason: "stop";
    value: T;
    usage?: ModelGatewayUsage;
  } = {
    provider: definition.provider,
    model,
    requestId,
    finishReason: "stop",
    value: value as T,
  };
  if (usage) result.usage = usage;
  return Object.freeze(result);
}

function parseOllamaResponse<T extends ModelGatewayJsonObject>(
  envelope: Record<string, unknown> | null,
  definition: ProviderDefinition,
  model: string,
): ModelGatewayJsonResult<T> {
  const message = asRecord(envelope?.message);
  const content = message?.content;
  const done = envelope?.done;
  const doneReason = envelope?.done_reason;
  if (done !== true || (doneReason !== undefined && doneReason !== "stop")) {
    throw new ModelGatewayError(
      "MODEL_RESPONSE_INCOMPLETE",
      "模型响应未完整结束",
      502,
      { provider: definition.provider },
    );
  }
  if (typeof content !== "string" || content.length === 0) {
    throw new ModelGatewayError(
      "MODEL_RESPONSE_INVALID",
      "模型响应缺少 JSON 内容",
      502,
      { provider: definition.provider },
    );
  }
  let parsedValue: unknown;
  try {
    parsedValue = JSON.parse(content.replace(/^\uFEFF/u, ""));
  } catch {
    throw new ModelGatewayError(
      "MODEL_RESPONSE_INVALID",
      "模型未返回有效的 JSON 对象",
      502,
      { provider: definition.provider },
    );
  }
  const value = asRecord(parsedValue);
  if (!value) {
    throw new ModelGatewayError(
      "MODEL_RESPONSE_INVALID",
      "模型返回的 JSON 顶层必须是对象",
      502,
      { provider: definition.provider },
    );
  }
  const inputTokens = safeTokenCount(envelope?.prompt_eval_count);
  const outputTokens = safeTokenCount(envelope?.eval_count);
  const usage = inputTokens === undefined && outputTokens === undefined
    ? undefined
    : Object.freeze({
      ...(inputTokens === undefined ? {} : { inputTokens }),
      ...(outputTokens === undefined ? {} : { outputTokens }),
      ...(inputTokens === undefined || outputTokens === undefined
        ? {}
        : { totalTokens: inputTokens + outputTokens }),
    });
  const result: {
    provider: ModelGatewayProvider;
    model: string;
    requestId: string | null;
    finishReason: "stop";
    value: T;
    usage?: ModelGatewayUsage;
  } = {
    provider: definition.provider,
    model,
    requestId: null,
    finishReason: "stop",
    value: value as T,
  };
  if (usage) result.usage = usage;
  return Object.freeze(result);
}

export async function requestModelGatewayJson<
  T extends ModelGatewayJsonObject = ModelGatewayJsonObject,
>(request: ModelGatewayJsonRequest): Promise<ModelGatewayJsonResult<T>> {
  assertModelGatewayServerRuntime();
  const definition = providerDefinition(request?.provider);
  const model = resolveModel(definition, request.env);
  const connection = resolveProviderConnection(definition, request.env);
  const messages = normalizeMessages(request.messages);
  const timeoutMs = normalizeTimeout(request.timeoutMs);
  const maxOutputTokens = normalizeOutputTokens(request.maxOutputTokens);
  const sampling = normalizeSampling(request.sampling);
  const fetchImpl = request.fetchImpl ?? globalThis.fetch?.bind(globalThis);
  if (!fetchImpl) {
    throw new ModelGatewayError(
      "MODEL_PROVIDER_UNAVAILABLE",
      "服务端缺少 Fetch 实现",
      500,
      { provider: definition.provider },
    );
  }
  const abortScope = createAbortScope(timeoutMs, request.signal);
  try {
    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    if (connection.apiKey) headers.authorization = `Bearer ${connection.apiKey}`;
    const response = await fetchImpl(connection.requestUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(buildRequestBody(definition, model, messages, maxOutputTokens, sampling)),
      cache: "no-store",
      // Cloudflare Workers only implement "follow" and "manual". Keeping
      // redirects manual preserves the fixed-endpoint boundary: every 3xx is
      // handled by the non-ok branch below and is never followed.
      redirect: "manual",
      signal: abortScope.signal,
    });
    if (!response.ok) {
      await cancelBody(response);
      throw upstreamError(definition.provider, response.status);
    }
    const text = await readResponseTextLimited(response, definition.provider);
    return parseProviderResponse<T>(text, definition, model);
  } catch (error) {
    if (error instanceof ModelGatewayError) throw error;
    if (abortScope.timedOut()) {
      throw new ModelGatewayError(
        "MODEL_REQUEST_TIMEOUT",
        "模型请求超时",
        504,
        { provider: definition.provider, retryable: true, limit: timeoutMs },
      );
    }
    if (request.signal?.aborted) {
      throw new ModelGatewayError(
        "MODEL_REQUEST_ABORTED",
        "模型请求已取消",
        499,
        { provider: definition.provider },
      );
    }
    throw new ModelGatewayError(
      "MODEL_PROVIDER_UNAVAILABLE",
      "无法连接模型供应商",
      502,
      { provider: definition.provider, retryable: true },
    );
  } finally {
    abortScope.cleanup();
  }
}

export async function probeModelGatewayProvider(
  provider: ModelGatewayProvider,
  env: ModelGatewayServerEnv,
  options: Readonly<{
    timeoutMs?: number;
    signal?: AbortSignal;
    fetchImpl?: ModelGatewayFetch;
  }> = {},
): Promise<ModelGatewayProbeResult> {
  assertModelGatewayServerRuntime();
  const startedAt = Date.now();
  const checkedAt = new Date().toISOString();
  const status = getModelGatewayProviderStatus(provider, env);
  if (!status.ready) {
    const error = status.error ?? toModelGatewaySafeError(new ModelGatewayError(
      "MODEL_PROVIDER_NOT_CONFIGURED",
      "模型供应商尚未配置服务端凭据",
      503,
      { provider },
    ));
    return Object.freeze({
      provider,
      configured: status.configured,
      ok: false,
      model: status.model,
      baseUrl: status.baseUrl,
      checkedAt,
      latencyMs: Math.max(0, Date.now() - startedAt),
      error,
    });
  }
  try {
    const result = await requestModelGatewayJson({
      provider,
      env,
      messages: [{ role: "user", content: "Reply with JSON exactly: {\"ok\":true}" }],
      timeoutMs: options.timeoutMs,
      maxOutputTokens: 64,
      signal: options.signal,
      fetchImpl: options.fetchImpl,
    });
    if (result.value.ok !== true) {
      throw new ModelGatewayError(
        "MODEL_PROBE_FAILED",
        "模型供应商探针返回了意外结果",
        502,
        { provider },
      );
    }
    return Object.freeze({
      provider,
      configured: true,
      ok: true,
      model: result.model,
      baseUrl: status.baseUrl,
      checkedAt,
      latencyMs: Math.max(0, Date.now() - startedAt),
      requestId: result.requestId,
    });
  } catch (error) {
    return Object.freeze({
      provider,
      configured: true,
      ok: false,
      model: status.model,
      baseUrl: status.baseUrl,
      checkedAt,
      latencyMs: Math.max(0, Date.now() - startedAt),
      error: toModelGatewaySafeError(error),
    });
  }
}
