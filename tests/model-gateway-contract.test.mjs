import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  MODEL_GATEWAY_MAX_RESPONSE_BYTES,
  MODEL_GATEWAY_PROVIDER_DESCRIPTORS,
  MODEL_GATEWAY_PROVIDER_IDS,
  ModelGatewayError,
  assertModelGatewayServerRuntime,
  getModelGatewayProviderStatus,
  listModelGatewayProviderStatuses,
  probeModelGatewayProvider,
  requestModelGatewayJson,
  toModelGatewaySafeError,
} from "../app/model-gateway.ts";

const DEEPSEEK_SECRET = "test-token-deepseek-contract";
const QWEN_SECRET = "test-token-qwen-contract";
const OPENAI_SECRET = "test-token-openai-contract";
const OLLAMA_SECRET = "ollama-contract-secret";

function completionResponse(value, options = {}) {
  return new Response(JSON.stringify({
    id: options.id ?? "chatcmpl-contract",
    model: options.model ?? "upstream-model-name-is-not-trusted",
    choices: [{
      index: 0,
      finish_reason: options.finishReason ?? "stop",
      message: {
        role: "assistant",
        content: options.content ?? JSON.stringify(value),
      },
    }],
    usage: {
      prompt_tokens: 11,
      completion_tokens: 7,
      total_tokens: 18,
    },
  }), {
    status: 200,
    headers: options.headers,
  });
}

function ollamaResponse(value, options = {}) {
  return new Response(JSON.stringify({
    model: options.model ?? "qwen3:8b",
    created_at: "2026-08-24T00:00:00Z",
    message: {
      role: "assistant",
      content: options.content ?? JSON.stringify(value),
    },
    done: options.done ?? true,
    done_reason: options.doneReason ?? "stop",
    prompt_eval_count: 13,
    eval_count: 5,
  }), { status: 200, headers: options.headers });
}

function assertSafeSerialization(value, ...secrets) {
  const serialized = JSON.stringify(value);
  for (const secret of secrets) assert.doesNotMatch(serialized, new RegExp(secret));
}

test("provider allowlist 固定端点，status 只暴露非敏感配置", () => {
  assert.deepEqual([...MODEL_GATEWAY_PROVIDER_IDS], ["deepseek", "qwen", "openai", "ollama"]);
  assert.equal(Object.isFrozen(MODEL_GATEWAY_PROVIDER_IDS), true);
  assert.deepEqual(
    MODEL_GATEWAY_PROVIDER_DESCRIPTORS.map(({ provider, baseUrl }) => ({ provider, baseUrl })),
    [
      { provider: "deepseek", baseUrl: "https://api.deepseek.com" },
      { provider: "qwen", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1" },
      { provider: "openai", baseUrl: "https://api.openai.com/v1" },
      { provider: "ollama", baseUrl: "server-configured" },
    ],
  );
  const env = {
    DEEPSEEK_API_KEY: DEEPSEEK_SECRET,
    DASHSCOPE_API_KEY: QWEN_SECRET,
    DEEPSEEK_MODEL: "deepseek-v4-flash",
    QWEN_MODEL: "qwen3.7-flash",
    OPENAI_API_KEY: OPENAI_SECRET,
    OLLAMA_BASE_URL: "http://192.168.10.20:11434",
    OLLAMA_ALLOWED_HOSTS: "192.168.10.20:11434",
    OLLAMA_MODEL: "qwen3:8b",
    DEEPSEEK_BASE_URL: "https://attacker.example",
    QWEN_BASE_URL: "https://attacker.example",
  };
  const statuses = listModelGatewayProviderStatuses(env);
  assert.equal(statuses[0].ready, true);
  assert.equal(statuses[0].model, "deepseek-v4-flash");
  assert.equal(statuses[1].ready, true);
  assert.equal(statuses[1].model, "qwen3.7-flash");
  assert.equal(statuses[2].ready, true);
  assert.equal(statuses[2].model, "gpt-5.6-luna");
  assert.equal(statuses[3].ready, true);
  assert.equal(statuses[3].baseUrl, "http://192.168.10.20:11434");
  assertSafeSerialization(statuses, DEEPSEEK_SECRET, QWEN_SECRET, OPENAI_SECRET);

  assert.throws(
    () => getModelGatewayProviderStatus("attacker", env),
    (error) => error instanceof ModelGatewayError && error.code === "MODEL_PROVIDER_UNSUPPORTED",
  );
  const invalidOverride = getModelGatewayProviderStatus("qwen", {
    DASHSCOPE_API_KEY: QWEN_SECRET,
    QWEN_MODEL: "https://attacker.example/model",
  });
  assert.equal(invalidOverride.ready, false);
  assert.equal(invalidOverride.error.code, "MODEL_PROVIDER_MODEL_INVALID");
  assert.doesNotMatch(JSON.stringify(invalidOverride), /attacker\.example/u);

  const missingKeyWithValidModel = getModelGatewayProviderStatus("qwen", {
    QWEN_MODEL: "qwen-integration-model",
  });
  assert.equal(missingKeyWithValidModel.configured, false);
  assert.equal(missingKeyWithValidModel.ready, false);
  assert.equal(missingKeyWithValidModel.model, "qwen-integration-model");
  assert.equal(missingKeyWithValidModel.error.code, "MODEL_PROVIDER_NOT_CONFIGURED");
});

test("浏览器运行时不能启用模型网关", () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: {} });
  try {
    assert.throws(
      () => assertModelGatewayServerRuntime(),
      (error) => error instanceof ModelGatewayError && error.code === "MODEL_GATEWAY_SERVER_ONLY",
    );
  } finally {
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
    else delete globalThis.window;
  }
});

test("DeepSeek adapter 只调用一次固定 Chat Completions 并启用 JSON mode", async () => {
  let calls = 0;
  let captured;
  const result = await requestModelGatewayJson({
    provider: "deepseek",
    env: {
      DEEPSEEK_API_KEY: DEEPSEEK_SECRET,
      DEEPSEEK_MODEL: "deepseek-v4-flash",
      DEEPSEEK_BASE_URL: "https://attacker.example",
    },
    messages: [{ role: "user", content: "请输出 JSON 提案" }],
    maxOutputTokens: 321,
    sampling: { temperature: 0, topP: 1 },
    fetchImpl: async (input, init) => {
      calls += 1;
      captured = { input: String(input), init, body: JSON.parse(init.body) };
      return completionResponse({ proposal: "candidate" });
    },
  });
  assert.equal(calls, 1, "网关不得自动重试");
  assert.equal(captured.input, "https://api.deepseek.com/chat/completions");
  assert.equal(captured.init.headers.authorization, `Bearer ${DEEPSEEK_SECRET}`);
  assert.equal(captured.init.redirect, "manual", "Cloudflare Worker 不支持 redirect=error，且固定端点不得自动跟随 3xx");
  assert.equal(captured.body.model, "deepseek-v4-flash");
  assert.deepEqual(captured.body.response_format, { type: "json_object" });
  assert.equal(captured.body.temperature, 0);
  assert.equal(captured.body.top_p, 1);
  assert.equal(captured.body.max_tokens, 321);
  assert.equal("max_completion_tokens" in captured.body, false);
  assert.match(captured.body.messages[0].content, /JSON/u);
  assert.deepEqual(result.value, { proposal: "candidate" });
  assert.equal(result.model, "deepseek-v4-flash");
  assert.deepEqual(result.usage, { inputTokens: 11, outputTokens: 7, totalTokens: 18 });
  assertSafeSerialization(result, DEEPSEEK_SECRET);
});

test("Qwen adapter 使用固定北京端点和 max_completion_tokens", async () => {
  let calls = 0;
  let captured;
  const result = await requestModelGatewayJson({
    provider: "qwen",
    env: {
      DASHSCOPE_API_KEY: QWEN_SECRET,
      QWEN_MODEL: "qwen3.8-max",
      QWEN_BASE_URL: "https://attacker.example",
    },
    messages: [{ role: "system", content: "请按 JSON 输出" }, { role: "user", content: "评审候选" }],
    maxOutputTokens: 456,
    fetchImpl: async (input, init) => {
      calls += 1;
      captured = { input: String(input), init, body: JSON.parse(init.body) };
      return completionResponse({ verdict: "hold" });
    },
  });
  assert.equal(calls, 1);
  assert.equal(captured.input, "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions");
  assert.equal(captured.init.headers.authorization, `Bearer ${QWEN_SECRET}`);
  assert.equal(captured.init.redirect, "manual");
  assert.equal(captured.body.model, "qwen3.8-max");
  assert.deepEqual(captured.body.response_format, { type: "json_object" });
  assert.equal(captured.body.temperature, 0, "默认采样合同必须冻结为 best-effort deterministic");
  assert.equal(captured.body.top_p, 1);
  assert.equal(captured.body.max_completion_tokens, 456);
  assert.equal("max_tokens" in captured.body, false);
  assert.deepEqual(result.value, { verdict: "hold" });
  assertSafeSerialization(result, QWEN_SECRET);
});

test("OpenAI adapter 使用固定官方端点、Luna 默认模型和 JSON mode", async () => {
  let calls = 0;
  let captured;
  const result = await requestModelGatewayJson({
    provider: "openai",
    env: {
      OPENAI_API_KEY: OPENAI_SECRET,
      OPENAI_BASE_URL: "https://attacker.example/v1",
    },
    baseUrl: "https://attacker.example/from-request",
    messages: [{ role: "user", content: "输出 JSON 审核结果" }],
    maxOutputTokens: 222,
    fetchImpl: async (input, init) => {
      calls += 1;
      captured = { input: String(input), init, body: JSON.parse(init.body) };
      return completionResponse({ pass: true });
    },
  });
  assert.equal(calls, 1);
  assert.equal(captured.input, "https://api.openai.com/v1/chat/completions");
  assert.equal(captured.init.headers.authorization, `Bearer ${OPENAI_SECRET}`);
  assert.equal(captured.init.redirect, "manual");
  assert.equal(captured.body.model, "gpt-5.6-luna");
  assert.equal(captured.body.max_completion_tokens, 222);
  assert.equal("max_tokens" in captured.body, false);
  assert.deepEqual(captured.body.response_format, { type: "json_object" });
  assert.deepEqual(result.value, { pass: true });
  assertSafeSerialization(result, OPENAI_SECRET);
});

test("Ollama 必须显式配置地址和模型；loopback literal 可直接配置，私网 IP 必须精确 allowlist", () => {
  for (const env of [
    {},
    { OLLAMA_BASE_URL: "http://127.0.0.1:11434" },
    { OLLAMA_MODEL: "qwen3:8b" },
  ]) {
    const status = getModelGatewayProviderStatus("ollama", env);
    assert.equal(status.configured, false);
    assert.equal(status.ready, false);
    assert.equal(status.error.code, "MODEL_PROVIDER_NOT_CONFIGURED");
  }

  for (const baseUrl of [
    "http://127.0.0.1:11434",
    "http://[::1]:11434",
  ]) {
    const status = getModelGatewayProviderStatus("ollama", {
      OLLAMA_BASE_URL: baseUrl,
      OLLAMA_MODEL: "qwen3:8b",
    });
    assert.equal(status.configured, true, baseUrl);
    assert.equal(status.ready, true, baseUrl);
    assert.equal(status.model, "qwen3:8b");
    assert.notEqual(status.baseUrl, "server-configured");
  }

  for (const [baseUrl, allowedHosts] of [
    ["http://10.0.0.20:11434/", "10.0.0.20:11434"],
    ["http://172.31.5.9:11434", "172.31.5.9:11434"],
    ["http://192.168.8.7:11434", "192.168.8.7:11434"],
    ["http://[fd00::10]:11434", "[fd00::10]:11434"],
  ]) {
    const status = getModelGatewayProviderStatus("ollama", {
      OLLAMA_BASE_URL: baseUrl,
      OLLAMA_ALLOWED_HOSTS: allowedHosts,
      OLLAMA_MODEL: "qwen3:8b",
    });
    assert.equal(status.ready, true, baseUrl);
  }
});

test("Ollama adapter 只调用配置的 /api/chat，使用结构化 JSON 且本地节点可无 Authorization", async () => {
  let calls = 0;
  let captured;
  const result = await requestModelGatewayJson({
    provider: "ollama",
    env: {
      OLLAMA_BASE_URL: "http://192.168.50.8:11434",
      OLLAMA_ALLOWED_HOSTS: "192.168.50.8:11434",
      OLLAMA_MODEL: "library/qwen3:8b",
    },
    upstreamUrl: "https://attacker.example",
    messages: [{ role: "user", content: "批量抽取 JSON" }],
    maxOutputTokens: 333,
    sampling: { temperature: 0.2, topP: 0.9 },
    fetchImpl: async (input, init) => {
      calls += 1;
      captured = { input: String(input), init, body: JSON.parse(init.body) };
      return ollamaResponse({ rows: 4 });
    },
  });
  assert.equal(calls, 1);
  assert.equal(captured.input, "http://192.168.50.8:11434/api/chat");
  assert.equal(captured.init.redirect, "manual");
  assert.equal(captured.init.headers.authorization, undefined);
  assert.equal(captured.body.model, "library/qwen3:8b");
  assert.equal(captured.body.format, "json");
  assert.equal(captured.body.stream, false);
  assert.equal(captured.body.options.temperature, 0.2);
  assert.equal(captured.body.options.top_p, 0.9);
  assert.equal(captured.body.options.num_predict, 333);
  assert.equal("response_format" in captured.body, false);
  assert.deepEqual(result.value, { rows: 4 });
  assert.deepEqual(result.usage, { inputTokens: 13, outputTokens: 5, totalTokens: 18 });
  assert.equal(result.requestId, null);
});

test("Ollama 可选密钥只进入 Authorization，状态、结果和安全错误均不泄露", async () => {
  let capturedAuthorization;
  const env = {
    OLLAMA_BASE_URL: "https://10.20.30.40:11434",
    OLLAMA_ALLOWED_HOSTS: "10.20.30.40:11434",
    OLLAMA_MODEL: "llama3.3:70b",
    OLLAMA_API_KEY: OLLAMA_SECRET,
  };
  const status = getModelGatewayProviderStatus("ollama", env);
  assert.equal(status.ready, true);
  assertSafeSerialization(status, OLLAMA_SECRET);
  const result = await requestModelGatewayJson({
    provider: "ollama",
    env,
    messages: [{ role: "user", content: "Return JSON" }],
    fetchImpl: async (_input, init) => {
      capturedAuthorization = init.headers.authorization;
      return ollamaResponse({ ok: true });
    },
  });
  assert.equal(capturedAuthorization, `Bearer ${OLLAMA_SECRET}`);
  assertSafeSerialization(result, OLLAMA_SECRET);

  await assert.rejects(
    () => requestModelGatewayJson({
      provider: "ollama",
      env,
      messages: [{ role: "user", content: "Return JSON" }],
      fetchImpl: async () => new Response(`leaked ${OLLAMA_SECRET}`, { status: 401 }),
    }),
    (error) => {
      assert.equal(error.code, "MODEL_PROVIDER_AUTH_FAILED");
      assertSafeSerialization(error, OLLAMA_SECRET);
      return true;
    },
  );
});

test("Ollama 地址门禁拒绝缺 allowlist、链路本地、CGNAT、hostname、通配和不安全 URL，且拒绝前零 egress", async () => {
  const cgnatExample = ["100", "127", "9", "4"].join(".");
  const rejected = [
    { OLLAMA_BASE_URL: "https://8.8.8.8:11434", OLLAMA_MODEL: "qwen3:8b" },
    { OLLAMA_BASE_URL: "https://example.com:11434", OLLAMA_MODEL: "qwen3:8b" },
    { OLLAMA_BASE_URL: "http://192.168.8.7:11434", OLLAMA_MODEL: "qwen3:8b" },
    { OLLAMA_BASE_URL: "http://169.254.10.2:11434", OLLAMA_ALLOWED_HOSTS: "169.254.10.2:11434", OLLAMA_MODEL: "qwen3:8b" },
    { OLLAMA_BASE_URL: `http://${cgnatExample}:11434`, OLLAMA_ALLOWED_HOSTS: `${cgnatExample}:11434`, OLLAMA_MODEL: "qwen3:8b" },
    { OLLAMA_BASE_URL: "http://[fe80::1]:11434", OLLAMA_ALLOWED_HOSTS: "[fe80::1]:11434", OLLAMA_MODEL: "qwen3:8b" },
    { OLLAMA_BASE_URL: "file:///etc/passwd", OLLAMA_MODEL: "qwen3:8b" },
    { OLLAMA_BASE_URL: "http://user:pass@127.0.0.1:11434", OLLAMA_MODEL: "qwen3:8b" },
    { OLLAMA_BASE_URL: "http://127.0.0.1:11434/admin", OLLAMA_MODEL: "qwen3:8b" },
    { OLLAMA_BASE_URL: "http://127.0.0.1:11434?next=evil", OLLAMA_MODEL: "qwen3:8b" },
    {
      OLLAMA_BASE_URL: "http://ollama.example:11434",
      OLLAMA_MODEL: "qwen3:8b",
      OLLAMA_ALLOWED_HOSTS: "*.example",
    },
    {
      OLLAMA_BASE_URL: "http://10.0.0.20:11434",
      OLLAMA_MODEL: "qwen3:8b",
      OLLAMA_ALLOWED_HOSTS: "10.0.0.20:11435",
    },
    {
      OLLAMA_BASE_URL: "http://10.0.0.20:11434",
      OLLAMA_MODEL: "qwen3:8b",
      OLLAMA_ALLOWED_HOSTS: "ollama.internal:11434",
    },
  ];
  let calls = 0;
  for (const env of rejected) {
    const status = getModelGatewayProviderStatus("ollama", env);
    assert.equal(status.ready, false);
    assert.equal(status.error.code, "MODEL_PROVIDER_ENDPOINT_INVALID");
    assert.equal(status.baseUrl, "server-configured", "无效地址不得回显到状态对象");
    assert.equal(JSON.stringify(status).includes(env.OLLAMA_BASE_URL), false, "无效地址不得进入脱敏状态或错误");
    await assert.rejects(
      () => requestModelGatewayJson({
        provider: "ollama",
        env,
        messages: [{ role: "user", content: "Return JSON" }],
        fetchImpl: async () => {
          calls += 1;
          return ollamaResponse({ ok: true });
        },
      }),
      (error) => error instanceof ModelGatewayError
        && error.code === "MODEL_PROVIDER_ENDPOINT_INVALID",
    );
  }
  assert.equal(calls, 0);
});

test("采样合同拒绝越界参数且不会发生 egress", async () => {
  let calls = 0;
  await assert.rejects(
    () => requestModelGatewayJson({
      provider: "deepseek",
      env: { DEEPSEEK_API_KEY: DEEPSEEK_SECRET },
      messages: [{ role: "user", content: "Return JSON" }],
      sampling: { temperature: -0.1, topP: 1 },
      fetchImpl: async () => {
        calls += 1;
        return completionResponse({ ok: true });
      },
    }),
    (error) => error instanceof ModelGatewayError && error.code === "MODEL_REQUEST_INVALID",
  );
  assert.equal(calls, 0);
});

test("上游错误被安全映射，既不读取错误正文也不自动重试", async () => {
  let calls = 0;
  await assert.rejects(
    () => requestModelGatewayJson({
      provider: "deepseek",
      env: { DEEPSEEK_API_KEY: DEEPSEEK_SECRET },
      messages: [{ role: "user", content: "Return JSON" }],
      fetchImpl: async () => {
        calls += 1;
        return new Response(`upstream leaked ${DEEPSEEK_SECRET}`, { status: 401 });
      },
    }),
    (error) => {
      assert.equal(error instanceof ModelGatewayError, true);
      assert.equal(error.code, "MODEL_PROVIDER_AUTH_FAILED");
      assert.equal(error.upstreamStatus, 401);
      assertSafeSerialization(error, DEEPSEEK_SECRET);
      return true;
    },
  );
  assert.equal(calls, 1);
  const unknown = toModelGatewaySafeError(new Error(`network ${DEEPSEEK_SECRET}`));
  assert.equal(unknown.code, "MODEL_PROVIDER_UNAVAILABLE");
  assertSafeSerialization(unknown, DEEPSEEK_SECRET);
});

test("Worker 兼容的 manual redirect 仍把 3xx 当作失败且绝不跟随 Location", async () => {
  let calls = 0;
  await assert.rejects(
    () => requestModelGatewayJson({
      provider: "deepseek",
      env: { DEEPSEEK_API_KEY: DEEPSEEK_SECRET },
      messages: [{ role: "user", content: "Return JSON" }],
      fetchImpl: async (input, init) => {
        calls += 1;
        assert.equal(String(input), "https://api.deepseek.com/chat/completions");
        assert.equal(init.redirect, "manual");
        return new Response(null, {
          status: 302,
          headers: { location: "https://attacker.example/credential-capture" },
        });
      },
    }),
    (error) => error instanceof ModelGatewayError
      && error.code === "MODEL_PROVIDER_REQUEST_REJECTED"
      && error.upstreamStatus === 302,
  );
  assert.equal(calls, 1, "网关不得跟随 3xx 或重试到 Location");
});

test("timeout 与响应大小是硬上限", async () => {
  let timeoutCalls = 0;
  await assert.rejects(
    () => requestModelGatewayJson({
      provider: "qwen",
      env: { DASHSCOPE_API_KEY: QWEN_SECRET },
      messages: [{ role: "user", content: "Return JSON" }],
      timeoutMs: 50,
      fetchImpl: async (_input, init) => {
        timeoutCalls += 1;
        return new Promise((_resolve, reject) => {
          init.signal.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"));
          }, { once: true });
        });
      },
    }),
    (error) => error instanceof ModelGatewayError && error.code === "MODEL_REQUEST_TIMEOUT" && error.retryable,
  );
  assert.equal(timeoutCalls, 1);

  await assert.rejects(
    () => requestModelGatewayJson({
      provider: "qwen",
      env: { DASHSCOPE_API_KEY: QWEN_SECRET },
      messages: [{ role: "user", content: "Return JSON" }],
      fetchImpl: async () => new Response("{}", {
        status: 200,
        headers: { "content-length": String(MODEL_GATEWAY_MAX_RESPONSE_BYTES + 1) },
      }),
    }),
    (error) => error instanceof ModelGatewayError && error.code === "MODEL_RESPONSE_TOO_LARGE",
  );
});

test("无效、空白或未完整 JSON 永远不会作为结果返回", async () => {
  for (const response of [
    completionResponse({}, { content: "not-json" }),
    completionResponse([], { content: "[]" }),
    completionResponse({ partial: true }, { finishReason: "length" }),
  ]) {
    await assert.rejects(
      () => requestModelGatewayJson({
        provider: "deepseek",
        env: { DEEPSEEK_API_KEY: DEEPSEEK_SECRET },
        messages: [{ role: "user", content: "Return JSON" }],
        fetchImpl: async () => response,
      }),
      (error) => error instanceof ModelGatewayError
        && ["MODEL_RESPONSE_INVALID", "MODEL_RESPONSE_INCOMPLETE"].includes(error.code),
    );
  }
});

test("probe 缺少密钥时不联网，配置后只发送一次最小调用", async () => {
  let calls = 0;
  const missing = await probeModelGatewayProvider("deepseek", {}, {
    fetchImpl: async () => {
      calls += 1;
      return completionResponse({ ok: true });
    },
  });
  assert.equal(missing.ok, false);
  assert.equal(missing.configured, false);
  assert.equal(missing.error.code, "MODEL_PROVIDER_NOT_CONFIGURED");
  assert.equal(calls, 0);

  const ready = await probeModelGatewayProvider("qwen", { DASHSCOPE_API_KEY: QWEN_SECRET }, {
    fetchImpl: async () => {
      calls += 1;
      return completionResponse({ ok: true }, { id: "probe-request" });
    },
  });
  assert.equal(ready.ok, true);
  assert.equal(ready.configured, true);
  assert.equal(ready.requestId, "probe-request");
  assert.equal(calls, 1);
  assertSafeSerialization([missing, ready], QWEN_SECRET);
});

test("源码契约不读取全局 env、不记录日志、云端固定端点且 Ollama 地址只取服务端配置", async () => {
  const source = await readFile(new URL("../app/model-gateway.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /process\.env/u);
  assert.doesNotMatch(source, /console\s*\./u);
  assert.doesNotMatch(source, /request\.(?:baseUrl|upstreamUrl|url)/u);
  assert.match(source, /https:\/\/api\.deepseek\.com\/chat\/completions/u);
  assert.match(source, /https:\/\/dashscope\.aliyuncs\.com\/compatible-mode\/v1\/chat\/completions/u);
  assert.match(source, /https:\/\/api\.openai\.com\/v1\/chat\/completions/u);
  assert.match(source, /OLLAMA_BASE_URL/u);
  assert.match(source, /OLLAMA_ALLOWED_HOSTS/u);
  assert.match(source, /`\$\{baseUrl\}\/api\/chat`/u);
  assert.match(source, /assertModelGatewayServerRuntime/u);
});
