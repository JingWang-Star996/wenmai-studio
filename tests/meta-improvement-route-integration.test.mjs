import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test from "node:test";

import { Miniflare, NoOpLog, Request as MiniflareRequest } from "miniflare";

const projectRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const serverPath = path.join(projectRoot, "dist", "server");
const staticPath = path.join(serverPath, "_next", "static");
const canonicalOrigin = "http://[::1]:3000";
const deepseekUrl = "https://api.deepseek.com/chat/completions";
const qwenUrl = "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions";
// Miniflare otherwise asks the OS for an arbitrary port. Undici correctly
// blocks several Fetch-spec "bad ports" (for example 5060/6000/6667), so a
// rapid create/dispose cycle can randomly make dispatchFetch fail before the
// Worker sees the request. Keep this test process on one non-ephemeral,
// Fetch-safe port; every harness remains strictly serial and fully disposed.
const miniflareFixturePort = 40_000 + (process.pid % 8_000);

// These are inert test markers, not credentials. The integration assertions
// below prove they are used only as outbound Authorization values and never
// persisted to D1 or returned by the management route.
const fakeDeepseekKey = "integration-only-deepseek-token";
const fakeQwenKey = "integration-only-qwen-token";

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function request(pathname, init = {}) {
  const headers = new Headers(init.headers);
  headers.set("host", "[::1]:3000");
  if (!headers.has("x-forwarded-host")) headers.set("x-forwarded-host", "[::1]:3000");
  return new MiniflareRequest(`${canonicalOrigin}${pathname}`, {
    redirect: "manual",
    ...init,
    headers,
  });
}

async function json(response) {
  const payload = await response.json();
  return { response, payload };
}

function cookieFrom(response) {
  return (response.headers.get("set-cookie") ?? "").split(";", 1)[0];
}

function within(promise, label, timeoutMs = 5_000) {
  let timeout;
  return Promise.race([
    promise.finally(() => clearTimeout(timeout)),
    new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error(`${label} 超时`)), timeoutMs);
    }),
  ]);
}

async function compiledRouteModules() {
  const names = (await readdir(staticPath)).filter((name) => name.endsWith(".js"));
  const sources = await Promise.all(names.map(async (name) => ({
    name,
    contents: await readFile(path.join(staticPath, name), "utf8"),
  })));
  const route = (marker) => {
    const match = sources.find((source) => source.name.startsWith("route-") && source.contents.includes(marker));
    assert.ok(match, `没有在 production build 中找到 ${marker} 路由`);
    return `./${match.name}`;
  };
  const authRoute = route("PAIRING_CODE_REQUIRED");
  const improvementRoute = route("wenmai-improvement-v1");
  const entry = `
    import * as auth from ${JSON.stringify(authRoute)};
    import * as improvement from ${JSON.stringify(improvementRoute)};
    export default {
      async fetch(request) {
        const pathname = new URL(request.url).pathname;
        const route = pathname === "/api/auth" ? auth
          : pathname === "/api/improvement/v1" ? improvement
            : null;
        const handler = route?.[request.method];
        const headers = new Headers(request.headers);
        headers.set("host", "[::1]:3000");
        const routeRequest = new Request(request, { headers });
        return handler ? handler(routeRequest) : new Response("not found", { status: 404 });
      }
    };
  `;
  return [
    { type: "ESModule", path: "meta-improvement-route-test-worker.mjs", contents: entry },
    ...sources.map((source) => ({
      type: "ESModule",
      path: source.name,
      contents: source.contents,
    })),
  ];
}

function fakeProviderResponse(provider, value, sequence) {
  return JSON.stringify({
    id: `fake-${provider}-${sequence}`,
    choices: [{
      finish_reason: "stop",
      message: { role: "assistant", content: JSON.stringify(value) },
    }],
    usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
  });
}

function parseLastUserMessage(body) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const message = [...messages].reverse().find((item) => item?.role === "user");
  assert.equal(typeof message?.content, "string", "fake provider 需要收到 user message");
  if (message.content === "Reply with JSON exactly: {\"ok\":true}") return { probe: true };
  return JSON.parse(message.content);
}

function mockHeader(headers, name) {
  if (Array.isArray(headers)) {
    for (let index = 0; index < headers.length - 1; index += 2) {
      if (String(headers[index]).toLowerCase() === name.toLowerCase()) return String(headers[index + 1]);
    }
    return null;
  }
  for (const [key, value] of Object.entries(headers ?? {})) {
    if (key.toLowerCase() === name.toLowerCase()) return Array.isArray(value) ? value.join(", ") : String(value);
  }
  return null;
}

function fakeProviderReply(provider, url, options, callLog) {
    assert.equal(options.method, "POST");
    const expectedKey = provider === "deepseek" ? fakeDeepseekKey : fakeQwenKey;
    assert.equal(mockHeader(options.headers, "authorization"), `Bearer ${expectedKey}`);
    assert.match(mockHeader(options.headers, "content-type") ?? "", /^application\/json/u);
    const body = options.body;
    assert.deepEqual(body.response_format, { type: "json_object" });
    assert.equal(body.stream, false);
    assert.equal(body.temperature, 0, "元改进调用必须冻结 temperature=0");
    assert.equal(body.top_p, 1, "元改进调用必须冻结 top_p=1");
    if (provider === "deepseek") {
      assert.equal(body.model, "deepseek-integration-model");
      assert.ok(Number.isSafeInteger(body.max_tokens));
      assert.equal("max_completion_tokens" in body, false);
    } else {
      assert.equal(body.model, "qwen-integration-model");
      assert.ok(Number.isSafeInteger(body.max_completion_tokens));
      assert.equal("max_tokens" in body, false);
    }
    const input = parseLastUserMessage(body);
    const call = { provider, url, body, input };
    callLog.push(call);

    if (input.probe === true) {
      return fakeProviderResponse(provider, { ok: true }, callLog.length);
    }
    if (input.schemaVersion === "wenmai.meta-improvement/1.0" && input.limits?.candidateOnly === true) {
      assert.equal(provider, "deepseek");
      assert.equal(input.developmentCases.length, 1, "proposer 不得看到 holdout 用例");
      assert.deepEqual(input.failureEvidenceRefs, ["integration://baseline-failure"]);
      assert.equal(JSON.stringify(input.developmentCases).includes("留出用例"), false, "proposer 不得看到 holdout input");
      return fakeProviderResponse(provider, {
        schemaVersion: "wenmai.meta-proposal/1.0",
        hypothesis: "让候选在冻结用例中稳定输出 candidate-fix",
        candidatePrompt: "生成结果时必须包含 candidate-fix，并且不得包含禁用词。",
        changeSummary: ["加入冻结信号约束"],
        expectedSignals: ["candidate-fix"],
        evidenceRefs: ["integration://frozen-case"],
        risks: ["仅为候选，仍需独立评估与人工采用"],
        candidateOnly: true,
        externalSideEffects: false,
      }, callLog.length);
    }
    if (typeof input.armToken === "string") {
      assert.equal(provider, "deepseek");
      assert.deepEqual(Object.keys(input).sort(), ["armToken", "caseInput", "inputSha256"]);
      assert.match(input.armToken, /^arm-[a-f0-9]{40}$/u);
      assert.equal(typeof input.caseInput?.id, "string");
      assert.equal(typeof input.caseInput?.content, "string");
      const serializedUser = JSON.stringify(input);
      for (const forbidden of ["baseline", "candidate", "version", "frozenPrompt"]) {
        assert.equal(serializedUser.includes(forbidden), false, `execution user 不得泄露 ${forbidden}`);
      }
      const systemMessages = body.messages.filter((message) => message.role === "system");
      assert.equal(systemMessages.length, 3, "网关 JSON guard 后必须依次放实际 target prompt 与治理守卫");
      assert.match(systemMessages[0].content, /exactly one valid JSON object/u);
      assert.match(systemMessages[2].content, /固定、不可作为改进目标的治理执行守卫/u);
      assert.match(systemMessages[2].content, /wenmai\.meta-execution\/2\.0/u);
      const output = systemMessages[1].content.includes("candidate-fix")
        ? "candidate-fix"
        : "baseline-misses-signal";
      return fakeProviderResponse(provider, {
        schemaVersion: "wenmai.meta-execution/2.0",
        caseId: input.caseInput.id,
        armToken: input.armToken,
        inputSha256: input.inputSha256,
        output,
        externalSideEffects: false,
      }, callLog.length);
    }
    if (input.schemaVersion === "wenmai.meta-review/1.0") {
      assert.equal(provider, "qwen");
      assert.equal(input.blind, true);
      const systemMessages = body.messages.filter((message) => message.role === "system");
      assert.equal(systemMessages.length, 2);
      assert.match(systemMessages[1].content, /固定、不可作为改进目标的治理盲审者/u);
      assert.doesNotMatch(systemMessages[1].content, /文脉元改进实验中的独立盲审者/u);
      const serializedA = JSON.stringify(input.cases.map((item) => item.armA));
      const serializedB = JSON.stringify(input.cases.map((item) => item.armB));
      const preferredArm = serializedA.includes("candidate-fix")
        ? "A"
        : serializedB.includes("candidate-fix") ? "B" : "none";
      assert.notEqual(preferredArm, "none", "盲审输入必须包含候选工件，但不得包含候选标签");
      return fakeProviderResponse(provider, {
        schemaVersion: "wenmai.meta-review/1.0",
        result: "pass",
        preferredArm,
        rationale: "优选 arm 满足冻结信号且没有禁用词。",
        advisoryOnly: true,
      }, callLog.length);
    }
    throw new Error(`fake provider 不认识请求合同：${JSON.stringify(input).slice(0, 500)}`);
}

function buildFakeOutbound(callLog, onProviderCall) {
  return async (providerRequest) => {
    const url = String(providerRequest.url);
    const provider = url === deepseekUrl ? "deepseek" : url === qwenUrl ? "qwen" : null;
    assert.ok(provider, `模型网关试图访问未授权地址：${url}`);
    const responseBody = fakeProviderReply(provider, url, {
      method: providerRequest.method,
      headers: Object.fromEntries(providerRequest.headers),
      body: await providerRequest.json(),
    }, callLog);
    if (onProviderCall) await onProviderCall(callLog.at(-1));
    return new Response(responseBody, {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
}

async function createHarness({ qwenConfigured = true, onProviderCall = null } = {}) {
  const pairingSelector = randomBytes(16).toString("base64url");
  const pairingSecret = randomBytes(16).toString("base64url");
  const pairingCode = `wenmai1.${pairingSelector}.${pairingSecret}`;
  const browserBinding = randomBytes(32).toString("base64url");
  const browserBindingSha256 = sha256(browserBinding);
  const createdAt = new Date();
  const expiresAt = new Date(createdAt.getTime() + 5 * 60 * 1000);
  const callLog = [];
  const modules = await compiledRouteModules();
  const databaseId = `meta-improvement-route-test-${randomUUID()}`;
  const baseBindings = {
    WENMAI_AUTH_CANONICAL_ORIGIN: canonicalOrigin,
    WENMAI_AUTH_BOOT_ID: `management-boot-${randomBytes(16).toString("base64url")}`,
    WENMAI_AUTH_CHALLENGE_ID: `management-challenge-${pairingSelector}`,
    WENMAI_AUTH_PAIRING_SHA256: sha256(pairingCode),
    WENMAI_AUTH_CHALLENGE_CREATED_AT: createdAt.toISOString(),
    WENMAI_AUTH_CHALLENGE_EXPIRES_AT: expiresAt.toISOString(),
    WENMAI_AUTH_CSRF_HMAC_KEY: randomBytes(32).toString("base64url"),
    DEEPSEEK_API_KEY: fakeDeepseekKey,
    DEEPSEEK_MODEL: "deepseek-integration-model",
    QWEN_MODEL: "qwen-integration-model",
  };
  const options = (withQwen) => ({
    modules,
    compatibilityDate: "2026-05-15",
    compatibilityFlags: ["nodejs_compat"],
    host: "127.0.0.1",
    port: miniflareFixturePort,
    publicUrl: canonicalOrigin,
    d1Databases: { DB: databaseId },
    d1Persist: false,
    bindings: {
      ...baseBindings,
      ...(withQwen ? { DASHSCOPE_API_KEY: fakeQwenKey } : {}),
    },
    outboundService: buildFakeOutbound(callLog, onProviderCall),
    log: new NoOpLog(),
  });
  const mf = new Miniflare(options(qwenConfigured));
  return {
    mf,
    callLog,
    pairingCode,
    browserBinding,
    browserBindingSha256,
    async configureQwen() {
      await mf.setOptions(options(true));
    },
  };
}

async function initializeAuth(harness) {
  const initial = await json(await harness.mf.dispatchFetch(request("/api/auth")));
  assert.equal(initial.response.status, 200, JSON.stringify(initial.payload));
  const paired = await json(await harness.mf.dispatchFetch(request("/api/auth", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: canonicalOrigin,
      "sec-fetch-site": "same-origin",
      "X-Wenmai-Browser-Binding": harness.browserBinding,
    },
    body: JSON.stringify({
      action: "bootstrap",
      pairingCode: harness.pairingCode,
      browserBindingSha256: harness.browserBindingSha256,
    }),
  })));
  assert.equal(paired.response.status, 201, JSON.stringify(paired.payload));
  return {
    cookie: cookieFrom(paired.response),
    csrf: paired.payload.data.csrfToken,
  };
}

async function improvementPost(harness, session, action, payload, commandId, { csrf = true } = {}) {
  const headers = {
    "content-type": "application/json",
    origin: canonicalOrigin,
    "sec-fetch-site": "same-origin",
    cookie: session.cookie,
    "X-Wenmai-Browser-Binding": harness.browserBinding,
    "X-Wenmai-Write": "1",
    ...(csrf ? { "X-Wenmai-CSRF": session.csrf } : {}),
  };
  return json(await harness.mf.dispatchFetch(request("/api/improvement/v1", {
    method: "POST",
    headers,
    body: JSON.stringify({ action, commandId, payload }),
  })));
}

async function improvementStatus(harness, session) {
  return json(await harness.mf.dispatchFetch(request("/api/improvement/v1?view=status", {
    headers: {
      cookie: session.cookie,
      "X-Wenmai-Browser-Binding": harness.browserBinding,
    },
  })));
}

function evaluationCases() {
  return [
    {
      id: "development-case",
      input: "开发用例：修复缺少关键信号的问题。",
      requiredSignals: ["candidate-fix"],
      forbiddenSignals: ["unsafe-output"],
      holdout: false,
    },
    {
      id: "holdout-case",
      input: "留出用例：验证候选没有只记住开发样本。",
      requiredSignals: ["candidate-fix"],
      forbiddenSignals: ["unsafe-output"],
      holdout: true,
    },
  ];
}

function createPayload(target, suffix = "") {
  return {
    targetSkillKey: target.skillKey,
    objective: `动态路由集成测试${suffix}：候选必须通过开发与留出用例`,
    articleId: null,
    failureEvidenceRefs: ["integration://baseline-failure"],
    evaluationCases: evaluationCases(),
    baselineVersion: target.activeVersion,
    baselineSha256: target.activeSha256,
    proposerProvider: "deepseek",
    executionProvider: "deepseek",
    reviewerProvider: "qwen",
    budgetCalls: 6,
  };
}

async function assertD1DoesNotContainSecrets(db) {
  const tables = (await db.prepare(`SELECT name FROM sqlite_schema
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\'
    ORDER BY name`).all()).results;
  for (const { name } of tables) {
    assert.match(String(name), /^[A-Za-z0-9_]+$/u);
    const rows = (await db.prepare(`SELECT * FROM "${name}"`).all()).results;
    const serialized = JSON.stringify(rows);
    assert.equal(serialized.includes(fakeDeepseekKey), false, `${name} 不得保存 DeepSeek key`);
    assert.equal(serialized.includes(fakeQwenKey), false, `${name} 不得保存 Qwen key`);
  }
}

test("真实 production 路由 + 内存 D1 + fake providers 完成初始化、生成、配对评估、采纳、下一轮基线绑定与回滚", async (context) => {
  const harness = await createHarness();
  context.after(() => harness.mf.dispose());

  const unauthenticated = await json(await harness.mf.dispatchFetch(request("/api/improvement/v1?view=status")));
  assert.equal(unauthenticated.response.status, 401);
  assert.equal(unauthenticated.payload.error.code, "MANAGEMENT_AUTH_REQUIRED");

  const session = await initializeAuth(harness);
  const missingCsrf = await improvementPost(
    harness,
    session,
    "initialize_workspace",
    {},
    "meta-route:init:missing-csrf",
    { csrf: false },
  );
  assert.equal(missingCsrf.response.status, 403);
  assert.equal(missingCsrf.payload.error.code, "CSRF_TOKEN_INVALID");

  const init = await improvementPost(harness, session, "initialize_workspace", {}, "meta-route:init");
  assert.equal(init.response.status, 200, JSON.stringify(init.payload));
  assert.equal(init.payload.data.initialized, true);
  assert.equal(init.payload.data.dashboard.targets.length, 3);
  const dashboardProviders = init.payload.data.dashboard.providers;
  assert.deepEqual(
    dashboardProviders.map(({ id }) => id),
    ["deepseek", "qwen", "openai", "ollama"],
  );
  assert.deepEqual(
    dashboardProviders.map(({ id, configured, enabled, status }) => [id, configured, enabled, status]),
    [
      ["deepseek", true, true, "ready"],
      ["qwen", true, true, "ready"],
      ["openai", false, false, "disabled"],
      ["ollama", false, false, "disabled"],
    ],
  );
  const serializedDashboardProviders = JSON.stringify(dashboardProviders);
  assert.equal(serializedDashboardProviders.includes(fakeDeepseekKey), false);
  assert.equal(serializedDashboardProviders.includes(fakeQwenKey), false);
  for (const provider of dashboardProviders) {
    assert.equal("endpoint" in provider, false, `${provider.id} 不得暴露 endpoint`);
    assert.equal("baseUrl" in provider, false, `${provider.id} 不得暴露 baseUrl`);
    assert.equal("apiKey" in provider, false, `${provider.id} 不得暴露 apiKey`);
  }

  const callsBeforeProviderProbe = harness.callLog.length;
  const missingProbeCsrf = await improvementPost(
    harness,
    session,
    "test_provider",
    { provider: "deepseek" },
    "meta-route:provider-probe:missing-csrf",
    { csrf: false },
  );
  assert.equal(missingProbeCsrf.response.status, 403);
  assert.equal(missingProbeCsrf.payload.error.code, "CSRF_TOKEN_INVALID");
  assert.equal(harness.callLog.length, callsBeforeProviderProbe, "缺少 CSRF 的诊断不得触发 provider probe");

  const providerProbe = await improvementPost(
    harness,
    session,
    "test_provider",
    { provider: "deepseek" },
    "meta-route:provider-probe:once",
  );
  assert.equal(providerProbe.response.status, 200, JSON.stringify(providerProbe.payload));
  assert.equal(providerProbe.payload.data.test.result, "pass");
  assert.equal(harness.callLog.length, callsBeforeProviderProbe + 1, "诊断只允许一次受预算约束的 probe");
  const providerProbeReplay = await improvementPost(
    harness,
    session,
    "test_provider",
    { provider: "deepseek" },
    "meta-route:provider-probe:once",
  );
  assert.equal(providerProbeReplay.response.status, 200, JSON.stringify(providerProbeReplay.payload));
  assert.deepEqual(providerProbeReplay.payload.data, providerProbe.payload.data);
  assert.equal(harness.callLog.length, callsBeforeProviderProbe + 1, "同一 commandId 的诊断重放不得再次调用 provider");
  const probeDb = await harness.mf.getD1Database("DB");
  const probeInvocation = await probeDb.prepare(`SELECT purpose, state, attempt, budget_reservation_json
    FROM model_invocations WHERE command_id = ? LIMIT 1`).bind("meta-route:provider-probe:once").first();
  assert.deepEqual(
    { purpose: probeInvocation.purpose, state: probeInvocation.state, attempt: probeInvocation.attempt, budget: JSON.parse(probeInvocation.budget_reservation_json) },
    { purpose: "provider_probe", state: "succeeded", attempt: 1, budget: { attempts: 1, maxOutputTokens: 64 } },
  );

  const initReplay = await improvementPost(harness, session, "initialize_workspace", {}, "meta-route:init");
  assert.equal(initReplay.response.status, 200, JSON.stringify(initReplay.payload));
  assert.deepEqual(initReplay.payload.data, init.payload.data);
  const initReuse = await improvementPost(harness, session, "initialize_workspace", { changed: true }, "meta-route:init");
  assert.equal(initReuse.response.status, 409);
  assert.equal(initReuse.payload.error.code, "COMMAND_ID_REUSED");

  const target = init.payload.data.dashboard.targets.find((item) => item.skillKey === "meta.candidate-proposer");
  assert.ok(target);
  const tooSmall = createPayload(target, "预算拒绝");
  tooSmall.budgetCalls = 5;
  const budgetRejected = await improvementPost(
    harness,
    session,
    "create_experiment",
    tooSmall,
    "meta-route:create:budget-too-small",
  );
  assert.equal(budgetRejected.response.status, 400);
  assert.equal(budgetRejected.payload.error.code, "BUDGET_TOO_SMALL");
  const budgetRejectedReplay = await improvementPost(
    harness,
    session,
    "create_experiment",
    tooSmall,
    "meta-route:create:budget-too-small",
  );
  assert.equal(budgetRejectedReplay.response.status, 400);
  assert.equal(budgetRejectedReplay.payload.error.code, "BUDGET_TOO_SMALL");

  const created = await improvementPost(
    harness,
    session,
    "create_experiment",
    createPayload(target),
    "meta-route:create:happy",
  );
  assert.equal(created.response.status, 201, JSON.stringify(created.payload));
  const experimentId = created.payload.data.experiment.id;
  assert.equal(created.payload.data.experiment.domainState, "baselined");
  assert.equal(created.payload.data.experiment.usedCalls, 0);
  const createReplay = await improvementPost(
    harness,
    session,
    "create_experiment",
    createPayload(target),
    "meta-route:create:happy",
  );
  assert.equal(createReplay.response.status, 201, JSON.stringify(createReplay.payload));
  assert.equal(createReplay.payload.data.experiment.id, experimentId);

  const generated = await improvementPost(
    harness,
    session,
    "generate_candidates",
    { experimentId, expectedLockVersion: created.payload.data.experiment.lockVersion },
    "meta-route:generate:happy",
  );
  assert.equal(generated.response.status, 200, JSON.stringify({ payload: generated.payload, calls: harness.callLog }));
  assert.equal(generated.payload.data.experiment.domainState, "candidate_ready");
  assert.equal(generated.payload.data.experiment.candidates.length, 1);
  assert.equal(generated.payload.data.experiment.usedCalls, 1);
  const candidateId = generated.payload.data.experiment.candidates[0].id;
  const callsAfterGenerate = harness.callLog.length;
  const generateReplay = await improvementPost(
    harness,
    session,
    "generate_candidates",
    { experimentId, expectedLockVersion: created.payload.data.experiment.lockVersion },
    "meta-route:generate:happy",
  );
  assert.equal(generateReplay.response.status, 200, JSON.stringify(generateReplay.payload));
  assert.equal(generateReplay.payload.data.experiment.candidates[0].id, candidateId);
  assert.equal(harness.callLog.length, callsAfterGenerate, "幂等重放不得再次调用 proposer");

  const evaluated = await improvementPost(
    harness,
    session,
    "run_pairwise_evaluation",
    {
      experimentId,
      candidateId,
      expectedLockVersion: generated.payload.data.experiment.lockVersion,
    },
    "meta-route:evaluate:happy",
  );
  assert.equal(evaluated.response.status, 200, JSON.stringify({ payload: evaluated.payload, calls: harness.callLog }));
  assert.equal(evaluated.payload.data.experiment.domainState, "awaiting_human");
  assert.equal(evaluated.payload.data.experiment.usedCalls, 6);
  assert.equal(evaluated.payload.data.experiment.evaluations.length, 1);
  assert.equal(evaluated.payload.data.experiment.evaluations[0].outcome, "candidate");
  assert.equal(evaluated.payload.data.experiment.evaluations[0].independentReviewPassed, true);
  assert.deepEqual(
    harness.callLog.reduce((counts, call) => ({ ...counts, [call.provider]: (counts[call.provider] ?? 0) + 1 }), {}),
    { deepseek: 6, qwen: 1 },
  );
  const callsAfterEvaluation = harness.callLog.length;
  const evaluationReplay = await improvementPost(
    harness,
    session,
    "run_pairwise_evaluation",
    {
      experimentId,
      candidateId,
      expectedLockVersion: generated.payload.data.experiment.lockVersion,
    },
    "meta-route:evaluate:happy",
  );
  assert.equal(evaluationReplay.response.status, 200, JSON.stringify(evaluationReplay.payload));
  assert.equal(harness.callLog.length, callsAfterEvaluation, "幂等重放不得再次执行四个 arm 或 reviewer");

  const adopted = await improvementPost(
    harness,
    session,
    "decide_experiment",
    {
      experimentId,
      candidateId,
      expectedLockVersion: evaluated.payload.data.experiment.lockVersion,
      decision: "adopt",
      note: "动态集成证据完整，人工确认采纳。",
      expectedCandidateSha256: evaluated.payload.data.experiment.humanEvidence.candidate.contentSha256,
      expectedEvidenceBundleSha256: evaluated.payload.data.experiment.humanEvidence.evidenceBundleSha256,
      expectedActiveVersionId: evaluated.payload.data.experiment.humanEvidence.activation.activeVersionId,
      expectedActivationLockVersion: evaluated.payload.data.experiment.humanEvidence.activation.lockVersion,
    },
    "meta-route:adopt:happy",
  );
  assert.equal(adopted.response.status, 200, JSON.stringify(adopted.payload));
  assert.equal(adopted.payload.data.experiment.domainState, "completed");
  assert.equal(adopted.payload.data.experiment.state, "adopted");
  const adoptedReplay = await improvementPost(
    harness,
    session,
    "decide_experiment",
    {
      experimentId,
      candidateId,
      expectedLockVersion: evaluated.payload.data.experiment.lockVersion,
      decision: "adopt",
      note: "动态集成证据完整，人工确认采纳。",
      expectedCandidateSha256: evaluated.payload.data.experiment.humanEvidence.candidate.contentSha256,
      expectedEvidenceBundleSha256: evaluated.payload.data.experiment.humanEvidence.evidenceBundleSha256,
      expectedActiveVersionId: evaluated.payload.data.experiment.humanEvidence.activation.activeVersionId,
      expectedActivationLockVersion: evaluated.payload.data.experiment.humanEvidence.activation.lockVersion,
    },
    "meta-route:adopt:happy",
  );
  assert.equal(adoptedReplay.response.status, 200, JSON.stringify(adoptedReplay.payload));
  assert.equal(adoptedReplay.payload.data.experiment.state, "adopted");

  const afterAdopt = await improvementStatus(harness, session);
  assert.equal(afterAdopt.response.status, 200, JSON.stringify(afterAdopt.payload));
  const adoptedTarget = afterAdopt.payload.data.targets.find((item) => item.skillKey === target.skillKey);
  assert.equal(adoptedTarget.activeVersionId, candidateId, "采纳必须真实移动 activation 指针");
  assert.notEqual(adoptedTarget.activeSha256, target.activeSha256);

  const nextCreated = await improvementPost(
    harness,
    session,
    "create_experiment",
    createPayload(adoptedTarget, "第二轮"),
    "meta-route:create:next-generation",
  );
  assert.equal(nextCreated.response.status, 201, JSON.stringify(nextCreated.payload));
  assert.equal(nextCreated.payload.data.experiment.frozen.baselineVersionId, candidateId);
  assert.equal(nextCreated.payload.data.experiment.baselineSha256, adoptedTarget.activeSha256);
  assert.equal(nextCreated.payload.data.experiment.domainState, "baselined");

  const rolledBack = await improvementPost(
    harness,
    session,
    "decide_experiment",
    {
      experimentId,
      expectedLockVersion: adopted.payload.data.experiment.lockVersion,
      decision: "rollback",
      note: "验证活动指针可由人工原子回滚。",
    },
    "meta-route:rollback:happy",
  );
  assert.equal(rolledBack.response.status, 200, JSON.stringify(rolledBack.payload));
  assert.equal(rolledBack.payload.data.experiment.state, "rolled_back");
  const rollbackReplay = await improvementPost(
    harness,
    session,
    "decide_experiment",
    {
      experimentId,
      expectedLockVersion: adopted.payload.data.experiment.lockVersion,
      decision: "rollback",
      note: "验证活动指针可由人工原子回滚。",
    },
    "meta-route:rollback:happy",
  );
  assert.equal(rollbackReplay.response.status, 200, JSON.stringify(rollbackReplay.payload));
  assert.equal(rollbackReplay.payload.data.experiment.state, "rolled_back");

  const afterRollback = await improvementStatus(harness, session);
  assert.equal(afterRollback.response.status, 200, JSON.stringify(afterRollback.payload));
  const restoredTarget = afterRollback.payload.data.targets.find((item) => item.skillKey === target.skillKey);
  assert.equal(restoredTarget.activeVersionId, target.activeVersionId);
  assert.equal(restoredTarget.activeSha256, target.activeSha256);

  const db = await harness.mf.getD1Database("DB");
  assert.equal((await db.prepare("SELECT COUNT(*) AS count FROM meta_improvement_experiments").first()).count, 2);
  assert.equal((await db.prepare("SELECT COUNT(*) AS count FROM model_invocations WHERE experiment_id = ?")
    .bind(experimentId).first()).count, 6, "冻结预算只允许本轮所需的 6 次调用");
  assert.equal((await db.prepare(`SELECT COUNT(*) AS count FROM model_invocation_outputs output
      JOIN model_invocations invocation ON invocation.id = output.invocation_id
      WHERE invocation.experiment_id = ? AND output.materialization_state = 'materialized'
        AND output.response_sha256 = invocation.response_sha256
        AND length(output.materialization_ref) > 0`)
    .bind(experimentId).first()).count, 6,
  "每次付费响应必须先 checkpoint，并与最终候选/评估工件及 invocation 摘要绑定");
  assert.equal((await db.prepare("SELECT COUNT(*) AS count FROM meta_improvement_evaluations WHERE experiment_id = ?")
    .bind(experimentId).first()).count, 5, "四个 deterministic arm 加一次独立盲审");
  assert.equal((await db.prepare("SELECT COUNT(*) AS count FROM command_receipts WHERE id = ?")
    .bind("meta-route:create:happy").first()).count, 1);
  await assertD1DoesNotContainSecrets(db);
  assert.deepEqual([...new Set(harness.callLog.map((call) => call.url))].sort(), [deepseekUrl, qwenUrl].sort());
});

test("空 D1 经 production 初始化后，四 provider schema 与 fail-closed action 一致", async (context) => {
  const harness = await createHarness();
  context.after(() => harness.mf.dispose());
  const session = await initializeAuth(harness);
  const initialized = await improvementPost(harness, session, "initialize_workspace", {}, "meta-route:fresh-provider-schema:init");
  assert.equal(initialized.response.status, 200, JSON.stringify(initialized.payload));

  const callsBeforeDisabledProbe = harness.callLog.length;
  const disabledProbe = await improvementPost(harness, session, "test_provider", { provider: "openai" }, "meta-route:fresh-provider-schema:openai");
  assert.equal(disabledProbe.response.status, 403);
  assert.equal(disabledProbe.payload.error.code, "META_IMPROVEMENT_EXTENDED_PROVIDER_DISABLED");
  assert.equal(harness.callLog.length, callsBeforeDisabledProbe, "默认 feature flag 不得触发 provider egress");

  const db = await harness.mf.getD1Database("DB");
  const digest = "a".repeat(64);
  for (const provider of ["openai", "ollama"]) {
    await db.prepare(`INSERT INTO meta_skill_versions
      (id,skill_key,version,role,prompt_text,prompt_sha256,contract_sha256,content_sha256,
       created_by_kind,created_by_provider,is_candidate,status,lock_version,created_at)
      VALUES (?,?,?,?,?,?,?,?,? ,?,1,'candidate',1,?)`)
      .bind(`fresh-skill-${provider}`, `fresh-skill-${provider}`, "1.0.0", "proposer", "fixture", digest, digest, `${provider}${digest.slice(provider.length)}`, "model", provider, "2026-08-28T00:00:00.000Z").run();
    await db.prepare(`INSERT INTO model_invocations
      (id,command_id,purpose,role,provider,model_id,adapter_version,egress_manifest_sha256,
       egress_approval_sha256,request_sha256,input_sha256,budget_reservation_sha256,created_at)
      VALUES (?,?,?,?,?,'fixture-model','adapter-v2',?,?,?,?,?,?)`)
      .bind(`fresh-invocation-${provider}`, `fresh-command-${provider}`, "provider_probe", "probe", provider,
        digest, digest, digest, digest, digest, "2026-08-28T00:00:00.000Z").run();
    await db.prepare(`INSERT INTO meta_improvement_evaluations
      (id,experiment_id,pair_id,case_id,arm,evaluator_kind,evaluator_key,provider,model_id,
       result,contract_sha256,input_sha256,output_sha256,signals_sha256,evidence_sha256,created_at)
      VALUES (?,?,?,?,?,'model','fixture',?,'fixture-model','pass',?,?,?,?,?,?)`)
      .bind(`fresh-evaluation-${provider}`, `fresh-experiment-${provider}`, "pair", "case", "pair", provider,
        digest, digest, digest, digest, digest, "2026-08-28T00:00:00.000Z").run();
  }
  for (const statement of [
    `INSERT INTO meta_skill_versions (id,skill_key,version,role,prompt_text,prompt_sha256,contract_sha256,content_sha256,created_by_kind,created_by_provider,is_candidate,status,lock_version,created_at) VALUES ('fresh-skill-unknown','fresh-skill-unknown','1.0.0','proposer','fixture','${digest}','${digest}','${"b".repeat(64)}','model','unknown',1,'candidate',1,'2026-08-28T00:00:00.000Z')`,
    `INSERT INTO model_invocations (id,command_id,purpose,role,provider,model_id,adapter_version,egress_manifest_sha256,egress_approval_sha256,request_sha256,input_sha256,budget_reservation_sha256,created_at) VALUES ('fresh-invocation-unknown','fresh-command-unknown','provider_probe','probe','unknown','fixture-model','adapter-v2','${digest}','${digest}','${digest}','${digest}','${digest}','2026-08-28T00:00:00.000Z')`,
    `INSERT INTO meta_improvement_evaluations (id,experiment_id,pair_id,case_id,arm,evaluator_kind,evaluator_key,provider,model_id,result,contract_sha256,input_sha256,output_sha256,signals_sha256,evidence_sha256,created_at) VALUES ('fresh-evaluation-unknown','fresh-experiment-unknown','pair','case','pair','model','fixture','unknown','fixture-model','pass','${digest}','${digest}','${digest}','${digest}','${digest}','2026-08-28T00:00:00.000Z')`,
  ]) await assert.rejects(() => db.exec(statement));
  await assert.rejects(() => db.prepare(`INSERT INTO model_invocations
    (id,lineage_candidate_id,lineage_preparation_id,command_id,purpose,role,provider,model_id,
     adapter_version,prompt_version_id,provider_policy_sha256,egress_manifest_sha256,
     egress_approval_sha256,request_sha256,input_sha256,budget_reservation_sha256,created_at)
    VALUES ('fresh-lineage-openai','candidate','preparation','fresh-lineage-command','lineage_review','reviewer','openai','fixture-model','adapter-v2','prompt','${digest}','${digest}','${digest}','${digest}','${digest}','${digest}','2026-08-28T00:00:00.000Z')`).run());
});

test("显式 initialize 幂等补齐两套治理 seed，旧 v1 合同在任何 egress 前拒绝", async (context) => {
  const harness = await createHarness();
  context.after(() => harness.mf.dispose());
  const session = await initializeAuth(harness);
  const initialized = await improvementPost(harness, session, "initialize_workspace", {}, "meta-route:upgrade:init");
  assert.equal(initialized.response.status, 200, JSON.stringify(initialized.payload));
  assert.equal(initialized.payload.data.dashboard.targets.length, 3);
  assert.equal(initialized.payload.data.dashboard.targets.some((item) => item.skillKey.startsWith("meta.governance-")), false);

  const db = await harness.mf.getD1Database("DB");
  assert.equal((await db.prepare("SELECT COUNT(*) AS count FROM meta_skill_activations").first()).count, 5);
  assert.equal((await db.prepare("SELECT COUNT(*) AS count FROM meta_skill_activations WHERE skill_key LIKE 'meta.governance-%'").first()).count, 2);

  await db.batch([
    db.prepare("DELETE FROM meta_skill_activations WHERE skill_key LIKE 'meta.governance-%'"),
    db.prepare("DELETE FROM meta_skill_versions WHERE skill_key LIKE 'meta.governance-%'"),
  ]);
  const legacyStatus = await improvementStatus(harness, session);
  assert.equal(legacyStatus.response.status, 409);
  assert.equal(legacyStatus.payload.error.code, "IMPROVEMENT_NOT_INITIALIZED");

  const upgraded = await improvementPost(harness, session, "initialize_workspace", {}, "meta-route:upgrade:additive");
  assert.equal(upgraded.response.status, 200, JSON.stringify(upgraded.payload));
  assert.equal(upgraded.payload.data.dashboard.targets.length, 3);
  assert.equal((await db.prepare("SELECT COUNT(*) AS count FROM meta_skill_activations").first()).count, 5);

  const target = upgraded.payload.data.dashboard.targets.find((item) => item.skillKey === "meta.execution");
  const created = await improvementPost(
    harness,
    session,
    "create_experiment",
    createPayload(target, "旧协议拒绝"),
    "meta-route:upgrade:create",
  );
  assert.equal(created.response.status, 201, JSON.stringify(created.payload));
  const experimentId = created.payload.data.experiment.id;
  const frozenRow = await db.prepare("SELECT evaluation_contract_json FROM meta_improvement_experiments WHERE id = ?")
    .bind(experimentId).first();
  const frozenContract = JSON.parse(frozenRow.evaluation_contract_json);
  assert.equal(frozenContract.evaluationProtocolVersion, "wenmai.meta-evaluation-protocol/2.0");
  assert.equal(frozenContract.modelInvocation.adapterVersion, "openai-chat-completions-json/2");
  assert.deepEqual(frozenContract.modelInvocation.sampling, { temperature: 0, topP: 1 });
  assert.deepEqual(Object.keys(frozenContract.harnessVersions).sort(), [
    "governanceExecutor",
    "governanceReviewer",
    "proposer",
  ]);

  delete frozenContract.evaluationProtocolVersion;
  delete frozenContract.modelInvocation;
  await db.prepare("UPDATE meta_improvement_experiments SET evaluation_contract_json = ? WHERE id = ?")
    .bind(JSON.stringify(frozenContract), experimentId).run();
  const callsBeforeRejectedEgress = harness.callLog.length;
  const rejected = await improvementPost(
    harness,
    session,
    "generate_candidates",
    { experimentId, expectedLockVersion: created.payload.data.experiment.lockVersion },
    "meta-route:upgrade:reject-v1",
  );
  assert.equal(rejected.response.status, 409, JSON.stringify(rejected.payload));
  assert.equal(rejected.payload.error.code, "EVALUATION_PROTOCOL_UPGRADE_REQUIRED");
  assert.equal(harness.callLog.length, callsBeforeRejectedEgress, "旧协议不得触发模型 egress");
  assert.equal((await db.prepare("SELECT state FROM meta_improvement_experiments WHERE id = ?").bind(experimentId).first()).state, "baselined");
});

test("活动 baseline lock 漂移后，冻结 v2 实验在 proposer egress 前停止且不产生 invocation", async (context) => {
  const harness = await createHarness();
  context.after(() => harness.mf.dispose());
  const session = await initializeAuth(harness);
  const init = await improvementPost(harness, session, "initialize_workspace", {}, "meta-route:stale:init");
  assert.equal(init.response.status, 200, JSON.stringify(init.payload));
  const target = init.payload.data.dashboard.targets.find((item) => item.skillKey === "meta.execution");
  const created = await improvementPost(
    harness,
    session,
    "create_experiment",
    createPayload(target, "baseline activation 漂移"),
    "meta-route:stale:create",
  );
  assert.equal(created.response.status, 201, JSON.stringify(created.payload));
  const experimentId = created.payload.data.experiment.id;
  const db = await harness.mf.getD1Database("DB");
  const frozen = await db.prepare("SELECT evaluation_contract_json FROM meta_improvement_experiments WHERE id = ?")
    .bind(experimentId).first();
  const contract = JSON.parse(frozen.evaluation_contract_json);
  assert.deepEqual(contract.baselineActivation, {
    skillKey: target.skillKey,
    activeVersionId: target.activeVersionId,
    lockVersion: target.activationLockVersion,
  });
  await db.prepare("UPDATE meta_skill_activations SET lock_version = lock_version + 1 WHERE skill_key = ?")
    .bind(target.skillKey).run();

  const callsBefore = harness.callLog.length;
  const generation = await improvementPost(
    harness,
    session,
    "generate_candidates",
    { experimentId, expectedLockVersion: created.payload.data.experiment.lockVersion },
    "meta-route:stale:generate",
  );
  assert.equal(generation.response.status, 409, JSON.stringify(generation.payload));
  assert.equal(generation.payload.error.code, "FROZEN_BASELINE_STALE");
  assert.deepEqual(generation.payload.error.details.conflicts, ["ACTIVATION_LOCK_CHANGED"]);
  assert.equal(harness.callLog.length, callsBefore, "stale activation 不得调用 provider");
  assert.equal((await db.prepare("SELECT COUNT(*) AS count FROM model_invocations WHERE experiment_id = ?")
    .bind(experimentId).first()).count, 0);
  assert.equal((await db.prepare("SELECT state FROM meta_improvement_experiments WHERE id = ?")
    .bind(experimentId).first()).state, "baselined");
});

test("首个 execution 请求在途时人工 reject：响应仅 checkpoint 并明确忽略，不再发出后续调用", async (context) => {
  let releaseFirstExecution;
  let signalFirstExecution;
  let held = false;
  const firstExecutionStarted = new Promise((resolve) => { signalFirstExecution = resolve; });
  const firstExecutionRelease = new Promise((resolve) => { releaseFirstExecution = resolve; });
  const harness = await createHarness({
    onProviderCall: async (call) => {
      if (!held && typeof call?.input?.armToken === "string") {
        held = true;
        signalFirstExecution();
        await firstExecutionRelease;
      }
    },
  });
  context.after(() => {
    releaseFirstExecution?.();
    return harness.mf.dispose();
  });
  const session = await initializeAuth(harness);
  const init = await improvementPost(harness, session, "initialize_workspace", {}, "meta-route:reject-race:init");
  assert.equal(init.response.status, 200, JSON.stringify(init.payload));
  const target = init.payload.data.dashboard.targets.find((item) => item.skillKey === "meta.candidate-proposer");
  const created = await improvementPost(
    harness,
    session,
    "create_experiment",
    createPayload(target, "reject 竞态"),
    "meta-route:reject-race:create",
  );
  assert.equal(created.response.status, 201, JSON.stringify(created.payload));
  const experimentId = created.payload.data.experiment.id;
  const generated = await improvementPost(
    harness,
    session,
    "generate_candidates",
    { experimentId, expectedLockVersion: created.payload.data.experiment.lockVersion },
    "meta-route:reject-race:generate",
  );
  assert.equal(generated.response.status, 200, JSON.stringify(generated.payload));
  const candidateId = generated.payload.data.experiment.candidates[0].id;

  const evaluationPromise = improvementPost(
    harness,
    session,
    "run_pairwise_evaluation",
    { experimentId, candidateId, expectedLockVersion: generated.payload.data.experiment.lockVersion },
    "meta-route:reject-race:evaluate",
  );
  await within(firstExecutionStarted, "首个 execution 到达 fake provider");
  const db = await harness.mf.getD1Database("DB");
  const evaluating = await db.prepare("SELECT state, decision, lock_version FROM meta_improvement_experiments WHERE id = ?")
    .bind(experimentId).first();
  assert.equal(evaluating.state, "evaluating");
  assert.equal(evaluating.decision, "pending");
  const rejected = await within(improvementPost(
    harness,
    session,
    "decide_experiment",
    {
      experimentId,
      expectedLockVersion: evaluating.lock_version,
      decision: "reject",
      note: "在首个调用仍在途时由人工明确拒绝。",
    },
    "meta-route:reject-race:reject",
  ), "并发人工 reject");
  assert.equal(rejected.response.status, 200, JSON.stringify(rejected.payload));
  assert.equal(rejected.payload.data.experiment.domainState, "completed");
  assert.equal(rejected.payload.data.experiment.state, "rejected");

  releaseFirstExecution();
  const evaluated = await within(evaluationPromise, "被 reject 的评估请求收敛");
  assert.equal(evaluated.response.status, 409, JSON.stringify(evaluated.payload));
  assert.equal(evaluated.payload.error.code, "EXPERIMENT_CHANGED_AFTER_EGRESS");
  assert.equal(evaluated.payload.error.details.providerDispatched, true);
  assert.equal(evaluated.payload.error.details.responseCheckpointed, true);
  assert.equal(harness.callLog.filter((call) => typeof call.input.armToken === "string").length, 1,
    "reject 后不得发出第二个 execution arm 或 reviewer");
  assert.equal(harness.callLog.filter((call) => call.provider === "qwen").length, 0);
  assert.equal((await db.prepare("SELECT COUNT(*) AS count FROM meta_improvement_evaluations WHERE experiment_id = ?")
    .bind(experimentId).first()).count, 0, "被拒绝后在途响应不得物化为评估证据");
  const output = await db.prepare(`SELECT output.materialization_state, output.last_error_class, invocation.state
    FROM model_invocation_outputs output
    JOIN model_invocations invocation ON invocation.id = output.invocation_id
    WHERE invocation.experiment_id = ? AND invocation.role = 'execution' LIMIT 1`)
    .bind(experimentId).first();
  assert.deepEqual(output, {
    materialization_state: "blocked",
    last_error_class: "EXPERIMENT_CHANGED_AFTER_EGRESS",
    state: "succeeded",
  });
  const ignoredEvent = await db.prepare(`SELECT event_type, payload_json FROM meta_improvement_events
    WHERE experiment_id = ? AND event_type = 'model.response_ignored_after_experiment_change' LIMIT 1`)
    .bind(experimentId).first();
  assert.equal(ignoredEvent.event_type, "model.response_ignored_after_experiment_change");
  assert.equal(JSON.parse(ignoredEvent.payload_json).responseIgnored, true);
});

test("改进 reviewer 目标时，执行 arm 使用真实 reviewer prompt，最终盲审仍由固定治理 reviewer 完成", async (context) => {
  const harness = await createHarness();
  context.after(() => harness.mf.dispose());
  const session = await initializeAuth(harness);
  const init = await improvementPost(harness, session, "initialize_workspace", {}, "meta-route:reviewer-target:init");
  assert.equal(init.response.status, 200, JSON.stringify(init.payload));
  const target = init.payload.data.dashboard.targets.find((item) => item.skillKey === "meta.candidate-reviewer");
  assert.ok(target);
  const created = await improvementPost(
    harness,
    session,
    "create_experiment",
    createPayload(target, "reviewer 目标隔离"),
    "meta-route:reviewer-target:create",
  );
  assert.equal(created.response.status, 201, JSON.stringify(created.payload));
  const experimentId = created.payload.data.experiment.id;
  const generated = await improvementPost(
    harness,
    session,
    "generate_candidates",
    { experimentId, expectedLockVersion: created.payload.data.experiment.lockVersion },
    "meta-route:reviewer-target:generate",
  );
  assert.equal(generated.response.status, 200, JSON.stringify(generated.payload));
  const candidateId = generated.payload.data.experiment.candidates[0].id;
  const evaluated = await improvementPost(
    harness,
    session,
    "run_pairwise_evaluation",
    { experimentId, candidateId, expectedLockVersion: generated.payload.data.experiment.lockVersion },
    "meta-route:reviewer-target:evaluate",
  );
  assert.equal(evaluated.response.status, 200, JSON.stringify({ payload: evaluated.payload, calls: harness.callLog }));
  assert.equal(evaluated.payload.data.experiment.evaluations[0].independentReviewPassed, true);

  const executionCalls = harness.callLog.filter((call) => typeof call.input.armToken === "string");
  assert.equal(executionCalls.length, 4);
  assert.equal(executionCalls.some((call) => call.body.messages[1].content.includes("文脉元改进实验中的独立盲审者")), true,
    "baseline arm 必须真实执行 reviewer 目标 Prompt");
  const finalReviewCall = harness.callLog.find((call) => call.provider === "qwen");
  assert.ok(finalReviewCall);
  assert.match(finalReviewCall.body.messages[1].content, /固定、不可作为改进目标的治理盲审者/u);
  assert.doesNotMatch(finalReviewCall.body.messages[1].content, /文脉元改进实验中的独立盲审者/u);

  const db = await harness.mf.getD1Database("DB");
  const reviewerInvocation = await db.prepare(`SELECT invocation.prompt_version_id, activation.active_version_id
    FROM model_invocations invocation
    JOIN meta_skill_activations activation ON activation.skill_key = 'meta.governance-reviewer'
    WHERE invocation.experiment_id = ? AND invocation.role = 'reviewer' LIMIT 1`)
    .bind(experimentId).first();
  assert.equal(reviewerInvocation.prompt_version_id, reviewerInvocation.active_version_id,
    "reviewer invocation 必须绑定冻结治理 reviewer 版本");
});

test("reviewer 后配置恢复只补一次盲审，不重跑四个 execution arm", async (context) => {
  const harness = await createHarness({ qwenConfigured: false });
  context.after(() => harness.mf.dispose());
  const session = await initializeAuth(harness);
  const init = await improvementPost(harness, session, "initialize_workspace", {}, "meta-route:recovery:init");
  assert.equal(init.response.status, 200, JSON.stringify(init.payload));
  const target = init.payload.data.dashboard.targets.find((item) => item.skillKey === "meta.candidate-proposer");
  const created = await improvementPost(
    harness,
    session,
    "create_experiment",
    createPayload(target, "reviewer 恢复"),
    "meta-route:recovery:create",
  );
  assert.equal(created.response.status, 201, JSON.stringify(created.payload));
  const experimentId = created.payload.data.experiment.id;
  const generated = await improvementPost(
    harness,
    session,
    "generate_candidates",
    { experimentId, expectedLockVersion: created.payload.data.experiment.lockVersion },
    "meta-route:recovery:generate",
  );
  assert.equal(generated.response.status, 200, JSON.stringify(generated.payload));
  const candidateId = generated.payload.data.experiment.candidates[0].id;
  const deterministicOnly = await improvementPost(
    harness,
    session,
    "run_pairwise_evaluation",
    { experimentId, candidateId, expectedLockVersion: generated.payload.data.experiment.lockVersion },
    "meta-route:recovery:evaluate-without-reviewer",
  );
  assert.equal(deterministicOnly.response.status, 200, JSON.stringify(deterministicOnly.payload));
  assert.equal(deterministicOnly.payload.data.experiment.domainState, "awaiting_human");
  assert.equal(deterministicOnly.payload.data.experiment.usedCalls, 5);
  assert.equal(harness.callLog.filter((call) => typeof call.input.armToken === "string").length, 4);
  assert.equal(harness.callLog.filter((call) => call.provider === "qwen").length, 0);

  await harness.configureQwen();
  const recovered = await improvementPost(
    harness,
    session,
    "run_pairwise_evaluation",
    {
      experimentId,
      candidateId,
      expectedLockVersion: deterministicOnly.payload.data.experiment.lockVersion,
      reviewerOnly: true,
    },
    "meta-route:recovery:reviewer-only",
  );
  // Desired behavior: configuration recovery consumes exactly the remaining
  // reviewer reservation and reuses the four frozen deterministic rows.
  assert.equal(recovered.response.status, 200, JSON.stringify(recovered.payload));
  assert.equal(recovered.payload.data.experiment.domainState, "awaiting_human");
  assert.equal(recovered.payload.data.experiment.usedCalls, 6);
  assert.equal(recovered.payload.data.experiment.evaluations[0].independentReviewPassed, true);
  assert.equal(harness.callLog.filter((call) => typeof call.input.armToken === "string").length, 4);
  assert.equal(harness.callLog.filter((call) => call.provider === "qwen").length, 1);
});
