import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import test from "node:test";

import {
  GATEWAY_HEALTH_PATH,
  GATEWAY_SERVICE,
  WENMAI_AGENT_PATH,
  createGateway,
  listenGateway,
} from "../scripts/wenmai-tailscale-agent-gateway.mjs";

const TOKEN = "Bearer wenmai_agent_valid_12345678901234567890";
const NO_KNOWLEDGE_TOKEN = "Bearer wenmai_agent_no_knowledge_1234567890";
const WILDCARD_TOKEN = "Bearer wenmai_agent_wildcard_123456789012345";
const INVALID_TOKEN = "Bearer wenmai_agent_invalid_1234567890123456";

const clients = new Map([
  [TOKEN, {
    id: "agent-client-valid",
    scopes: ["task.read", "task.progress", "knowledge.read"],
    articleIds: ["article-allowed"],
  }],
  [NO_KNOWLEDGE_TOKEN, {
    id: "agent-client-no-knowledge",
    scopes: ["task.read"],
    articleIds: ["article-allowed"],
  }],
  [WILDCARD_TOKEN, {
    id: "agent-client-wildcard",
    scopes: ["task.read", "knowledge.read"],
    articleIds: ["*"],
  }],
]);

function json(response, status, body, headers = {}) {
  const encoded = Buffer.from(JSON.stringify(body), "utf8");
  response.writeHead(status, {
    "content-length": String(encoded.length),
    "content-type": "application/json; charset=utf-8",
    ...headers,
  });
  response.end(encoded);
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function fakeWenmai(state) {
  return createServer(async (request, response) => {
    const body = await readBody(request);
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const recorded = {
      method: request.method,
      path: url.pathname,
      query: url.search,
      headers: { ...request.headers },
      body,
    };
    state.requests.push(recorded);
    const authorization = typeof request.headers.authorization === "string" ? request.headers.authorization : "";
    const client = clients.get(authorization);

    if (url.pathname === WENMAI_AGENT_PATH && url.searchParams.get("view") === "health") {
      if (!client) {
        json(response, 401, { ok: false, error: { code: "AUTH_INVALID", message: "invalid" } });
        return;
      }
      json(response, 200, {
        ok: true,
        requestId: "fake-health",
        data: { service: "wenmai-agent-control", clients: [client], counts: {} },
      });
      return;
    }

    if (url.pathname === WENMAI_AGENT_PATH) {
      if (!client) {
        json(response, 401, { ok: false, error: { code: "AUTH_INVALID", message: "invalid" } });
        return;
      }
      json(response, 200, {
        ok: true,
        requestId: "fake-agent",
        data: {
          accepted: true,
          receivedAction: body.length ? JSON.parse(body.toString("utf8")).action : null,
        },
      }, { "set-cookie": "wenmai_management_session=must-not-cross; Path=/; HttpOnly" });
      return;
    }

    if (url.pathname === "/api/capabilities" || url.pathname === "/api/corpus/v1") {
      json(response, 200, {
        ok: true,
        requestId: "fake-metadata",
        data: { path: url.pathname, query: Object.fromEntries(url.searchParams) },
      });
      return;
    }

    if ([
      "/.well-known/wenmai-agent.json",
      "/agent/manifest.json",
      "/agent/api/v1.json",
      "/agent/prompts/system.md",
    ].includes(url.pathname)) {
      const text = url.pathname.endsWith(".md") ? "# Agent contract\n" : JSON.stringify({ path: url.pathname });
      response.writeHead(200, {
        "content-length": String(Buffer.byteLength(text)),
        "content-type": url.pathname.endsWith(".md") ? "text/markdown; charset=utf-8" : "application/json",
        "set-cookie": "wenmai_management_session=must-not-cross; Path=/; HttpOnly",
      });
      response.end(text);
      return;
    }

    json(response, 404, { ok: false, error: { code: "NOT_FOUND" } });
  });
}

function listen(server, host = "127.0.0.1", port = 0) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve(server);
    });
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

async function fixture(t) {
  const state = { requests: [] };
  const upstream = fakeWenmai(state);
  await listen(upstream);
  const upstreamAddress = upstream.address();
  assert.ok(upstreamAddress && typeof upstreamAddress === "object");
  const upstreamOrigin = `http://127.0.0.1:${upstreamAddress.port}`;
  const gateway = createGateway({ listenHost: "127.0.0.1", listenPort: 0, upstreamOrigin });
  await listenGateway(gateway, { listenHost: "127.0.0.1", listenPort: 0 });
  const gatewayAddress = gateway.address();
  assert.ok(gatewayAddress && typeof gatewayAddress === "object");
  const gatewayOrigin = `http://127.0.0.1:${gatewayAddress.port}`;
  t.after(async () => {
    await close(gateway);
    await close(upstream);
  });
  return { gatewayOrigin, state };
}

function call(origin, path, { method = "GET", headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const request = httpRequest(new URL(path, origin), {
      method,
      headers: { connection: "close", ...headers },
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      response.once("error", reject);
      response.once("end", () => {
        const raw = Buffer.concat(chunks);
        resolve({
          status: response.statusCode,
          headers: response.headers,
          raw,
          json: String(response.headers["content-type"] ?? "").includes("application/json")
            ? JSON.parse(raw.toString("utf8"))
            : null,
        });
      });
    });
    request.once("error", reject);
    if (body !== null) request.end(body);
    else request.end();
  });
}

test("health 只暴露直接 loopback 进程合同，所有其他入口限 GET/POST", async (t) => {
  const { gatewayOrigin, state } = await fixture(t);
  const health = await call(gatewayOrigin, GATEWAY_HEALTH_PATH);
  assert.equal(health.status, 200);
  assert.deepEqual(Object.keys(health.json).sort(), [
    "agentPath", "listenHost", "listenPort", "ok", "pid", "service", "upstreamOrigin",
  ].sort());
  assert.equal(health.json.ok, true);
  assert.equal(health.json.service, GATEWAY_SERVICE);
  assert.equal(health.json.listenHost, "127.0.0.1");
  assert.equal(health.json.listenPort, Number(new URL(gatewayOrigin).port));
  assert.equal(health.json.agentPath, WENMAI_AGENT_PATH);
  assert.equal(Number.isInteger(health.json.pid), true);
  assert.equal(state.requests.length, 0);

  const proxiedHealth = await call(gatewayOrigin, GATEWAY_HEALTH_PATH, {
    headers: { "x-forwarded-for": ["100", "64", "0", "10"].join("."), "x-forwarded-proto": "https" },
  });
  assert.equal(proxiedHealth.status, 404);
  const put = await call(gatewayOrigin, WENMAI_AGENT_PATH, { method: "PUT", headers: { authorization: TOKEN } });
  assert.equal(put.status, 405);
});

test("整站和管理路由保持关闭，非 health 请求必须携带 Bearer", async (t) => {
  const { gatewayOrigin, state } = await fixture(t);
  for (const path of ["/", "/api/auth", "/api/workspace", "/_next/static/app.js", "/api/agent/v1/extra"] ) {
    const result = await call(gatewayOrigin, path);
    assert.equal(result.status, 404, path);
  }
  assert.equal(state.requests.length, 0, "未知路径不能触发上游 token 验真");

  const withoutToken = await call(gatewayOrigin, `${WENMAI_AGENT_PATH}?view=tasks`);
  assert.equal(withoutToken.status, 401);
  assert.equal(withoutToken.json.error.code, "AUTH_REQUIRED");

  const readonlyPost = await call(gatewayOrigin, "/agent/manifest.json", {
    method: "POST",
    headers: { authorization: TOKEN, "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(readonlyPost.status, 405);
});

test("Agent API 只额外开放三个任务管理动作，并强制标记 Tailscale 传输", async (t) => {
  const { gatewayOrigin, state } = await fixture(t);
  const blockedManagementActions = ["issue_client", "revoke_client", "decide_approval", "decide_graph_proposal"];
  for (const action of blockedManagementActions) {
    const result = await call(gatewayOrigin, WENMAI_AGENT_PATH, {
      method: "POST",
      headers: { authorization: TOKEN, "content-type": "application/json" },
      body: JSON.stringify({ action, commandId: `wmcmd-${action}`, payload: {} }),
    });
    assert.equal(result.status, 403, action);
    assert.equal(result.json.error.code, "MANAGEMENT_ACTION_FORBIDDEN", action);
  }
  assert.equal(state.requests.length, 0, "管理动作不能触达上游");

  for (const action of ["create_task", "update_task", "cancel_task"]) {
    const result = await call(gatewayOrigin, WENMAI_AGENT_PATH, {
      method: "POST",
      headers: { authorization: TOKEN, "content-type": "application/json" },
      body: JSON.stringify({ action, commandId: `wmcmd-${action}`, payload: {} }),
    });
    assert.equal(result.status, 200, action);
    assert.equal(result.json.data.receivedAction, action);
  }
  assert.equal(state.requests.length, 3);
  assert.ok(state.requests.every((item) => item.headers["x-wenmai-agent-transport"] === "tailscale-gateway"));
  state.requests.length = 0;

  const missingCommandId = await call(gatewayOrigin, WENMAI_AGENT_PATH, {
    method: "POST",
    headers: { authorization: TOKEN, "content-type": "application/json" },
    body: JSON.stringify({ action: "create_task", payload: {} }),
  });
  assert.equal(missingCommandId.status, 400);
  assert.equal(missingCommandId.json.error.code, "COMMAND_ID_REQUIRED");

  const browserManagement = await call(gatewayOrigin, WENMAI_AGENT_PATH, {
    method: "POST",
    headers: {
      authorization: TOKEN,
      "content-type": "application/json",
      origin: "https://attacker.example",
      cookie: "wenmai_management_session=stolen",
    },
    body: JSON.stringify({ action: "create_task", commandId: "wmcmd-browser", payload: {} }),
  });
  assert.equal(browserManagement.status, 403);
  assert.equal(browserManagement.json.error.code, "AMBIGUOUS_AUTH_FORBIDDEN");
  assert.equal(state.requests.length, 0);

  const futureAction = await call(gatewayOrigin, WENMAI_AGENT_PATH, {
    method: "POST",
    headers: { authorization: TOKEN, "content-type": "application/json" },
    body: JSON.stringify({ action: "future_management_action", payload: {} }),
  });
  assert.equal(futureAction.status, 403);
  assert.equal(futureAction.json.error.code, "AGENT_ACTION_FORBIDDEN");
  assert.equal(state.requests.length, 0, "未知写入动作不能触达上游");

  const agentActions = [
    "claim", "heartbeat", "progress", "add_artifact", "await_human", "complete", "fail", "release",
    "create_graph_proposal", "propose_revision", "propose_package_patch",
  ];
  for (const action of agentActions) {
    const result = await call(gatewayOrigin, WENMAI_AGENT_PATH, {
      method: "POST",
      headers: { authorization: TOKEN, "content-type": "application/json" },
      body: JSON.stringify({ action, commandId: `wmcmd-${action}`, payload: {} }),
    });
    assert.equal(result.status, 200, action);
    assert.equal(result.json.data.receivedAction, action);
  }
  assert.equal(state.requests.length, agentActions.length);
  state.requests.length = 0;

  const progressBody = JSON.stringify({ action: "progress", commandId: "wmcmd-test", payload: {} });
  const progress = await call(gatewayOrigin, WENMAI_AGENT_PATH, {
    method: "POST",
    headers: {
      authorization: TOKEN,
      "content-type": "application/json",
      cookie: "wenmai_management_session=stolen",
      origin: "http://[::1]:3000",
      referer: "http://[::1]:3000/",
      "sec-fetch-site": "same-origin",
      "x-forwarded-for": ["100", "64", "0", "20"].join("."),
      "x-wenmai-browser-binding": "browser-secret",
      "x-wenmai-csrf": "csrf-secret",
      "x-wenmai-write": "1",
      "x-wenmai-agent-transport": "client-forged-value",
    },
    body: progressBody,
  });
  assert.equal(progress.status, 200);
  assert.equal(progress.json.data.receivedAction, "progress");
  assert.equal(progress.headers["set-cookie"], undefined);
  assert.equal(state.requests.length, 1);
  const received = state.requests[0];
  assert.equal(received.headers.authorization, TOKEN);
  assert.equal(received.headers.cookie, undefined);
  assert.equal(received.headers.origin, undefined);
  assert.equal(received.headers.referer, undefined);
  assert.equal(received.headers["sec-fetch-site"], undefined);
  assert.equal(received.headers["x-forwarded-for"], undefined);
  assert.equal(received.headers["x-wenmai-browser-binding"], undefined);
  assert.equal(received.headers["x-wenmai-csrf"], undefined);
  assert.equal(received.headers["x-wenmai-write"], undefined);
  assert.equal(received.headers["x-wenmai-agent-transport"], "tailscale-gateway");
  assert.equal(received.body.toString("utf8"), progressBody);

  const invalidJson = await call(gatewayOrigin, WENMAI_AGENT_PATH, {
    method: "POST",
    headers: { authorization: TOKEN, "content-type": "application/json" },
    body: "{",
  });
  assert.equal(invalidJson.status, 400);
  assert.equal(invalidJson.json.error.code, "INVALID_JSON");
});

test("MCP 只读资源先验真 token；能力与语料还执行 scope 和文章边界", async (t) => {
  const { gatewayOrigin, state } = await fixture(t);
  const invalid = await call(gatewayOrigin, "/agent/manifest.json", { headers: { authorization: INVALID_TOKEN } });
  assert.equal(invalid.status, 401);
  assert.equal(state.requests.length, 1);
  assert.equal(state.requests[0].path, WENMAI_AGENT_PATH);
  assert.equal(state.requests[0].query, "?view=health");

  state.requests.length = 0;
  const manifest = await call(gatewayOrigin, "/agent/manifest.json", { headers: { authorization: TOKEN } });
  assert.equal(manifest.status, 200);
  assert.equal(manifest.headers["set-cookie"], undefined);
  assert.deepEqual(state.requests.map((item) => `${item.path}${item.query}`), [
    `${WENMAI_AGENT_PATH}?view=health`,
    "/agent/manifest.json",
  ]);

  state.requests.length = 0;
  const deniedCapabilities = await call(gatewayOrigin, "/api/capabilities?q=test", {
    headers: { authorization: NO_KNOWLEDGE_TOKEN },
  });
  assert.equal(deniedCapabilities.status, 403);
  assert.equal(deniedCapabilities.json.error.code, "SCOPE_DENIED");
  assert.equal(state.requests.length, 1, "缺 scope 时只能触发身份验真");

  state.requests.length = 0;
  const capabilities = await call(gatewayOrigin, "/api/capabilities?q=test", {
    headers: { authorization: TOKEN, origin: "https://attacker.example", cookie: "stolen=1" },
  });
  assert.equal(capabilities.status, 200);
  assert.equal(state.requests.length, 2);
  assert.equal(state.requests[1].headers.origin, "http://[::1]:3000");
  assert.equal(state.requests[1].headers.cookie, undefined);

  state.requests.length = 0;
  const corpusManifest = await call(gatewayOrigin, "/api/corpus/v1?view=manifest", { headers: { authorization: TOKEN } });
  assert.equal(corpusManifest.status, 200);
  assert.equal(state.requests.at(-1).path, "/api/corpus/v1");

  state.requests.length = 0;
  const missingArticle = await call(gatewayOrigin, "/api/corpus/v1?view=lineage", { headers: { authorization: TOKEN } });
  assert.equal(missingArticle.status, 400);
  assert.equal(missingArticle.json.error.code, "ARTICLE_ID_REQUIRED");
  assert.equal(state.requests.length, 1);

  state.requests.length = 0;
  const deniedArticle = await call(gatewayOrigin, "/api/corpus/v1?view=lineage&articleId=article-denied", {
    headers: { authorization: TOKEN },
  });
  assert.equal(deniedArticle.status, 403);
  assert.equal(deniedArticle.json.error.code, "OBJECT_SCOPE_DENIED");
  assert.equal(state.requests.length, 1);

  state.requests.length = 0;
  const allowedArticle = await call(gatewayOrigin, "/api/corpus/v1?view=lineage&articleId=article-allowed", {
    headers: { authorization: TOKEN },
  });
  assert.equal(allowedArticle.status, 200);
  assert.equal(state.requests.length, 2);
  assert.equal(state.requests[1].query, "?view=lineage&articleId=article-allowed");

  state.requests.length = 0;
  const wildcardArticle = await call(gatewayOrigin, "/api/corpus/v1?view=lineage&articleId=article-any", {
    headers: { authorization: WILDCARD_TOKEN },
  });
  assert.equal(wildcardArticle.status, 200);

  state.requests.length = 0;
  const forbiddenView = await call(gatewayOrigin, "/api/corpus/v1?view=classifications", {
    headers: { authorization: TOKEN },
  });
  assert.equal(forbiddenView.status, 403);
  assert.equal(forbiddenView.json.error.code, "VIEW_FORBIDDEN");
  assert.equal(state.requests.length, 1);
});

test("声明长度超过服务上限时在触达上游前失败", async (t) => {
  const { gatewayOrigin, state } = await fixture(t);
  const result = await call(gatewayOrigin, WENMAI_AGENT_PATH, {
    method: "POST",
    headers: {
      authorization: TOKEN,
      "content-type": "application/json",
      "content-length": "2200001",
    },
  });
  assert.equal(result.status, 413);
  assert.equal(result.json.error.code, "PAYLOAD_TOO_LARGE");
  assert.equal(state.requests.length, 0);
});
