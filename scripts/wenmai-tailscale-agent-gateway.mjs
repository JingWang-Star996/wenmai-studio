import { createServer, request as httpRequest } from "node:http";
import process from "node:process";
import { pathToFileURL } from "node:url";

export const GATEWAY_SERVICE = "wenmai-tailscale-agent-gateway";
export const GATEWAY_LISTEN_HOST = "127.0.0.1";
export const GATEWAY_LISTEN_PORT = 43_180;
export const GATEWAY_HEALTH_PATH = "/_wenmai/agent-gateway/health";
export const WENMAI_UPSTREAM_ORIGIN = "http://[::1]:3000";
export const WENMAI_AGENT_PATH = "/api/agent/v1";

const MAX_REQUEST_BYTES = 2_200_000;
const MAX_UPSTREAM_RESPONSE_BYTES = 16_777_216;
const UPSTREAM_TIMEOUT_MS = 60_000;

const MANAGEMENT_ACTIONS = new Set([
  "issue_client",
  "revoke_client",
  "create_task",
  "update_task",
  "cancel_task",
  "decide_approval",
  "decide_graph_proposal",
]);

const REMOTE_ADMINISTRATOR_ACTIONS = new Set([
  "create_task",
  "update_task",
  "cancel_task",
]);

const AGENT_MUTATION_ACTIONS = new Set([
  "claim",
  "heartbeat",
  "progress",
  "add_artifact",
  "await_human",
  "complete",
  "fail",
  "release",
  "create_graph_proposal",
  "propose_revision",
  "propose_package_patch",
]);

const STATIC_AGENT_PATHS = new Set([
  "/.well-known/wenmai-agent.json",
  "/agent/manifest.json",
  "/agent/api/v1.json",
  "/agent/prompts/system.md",
]);

const PROXY_IDENTITY_HEADERS = [
  "forwarded",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-port",
  "x-forwarded-proto",
  "x-real-ip",
];

const STRIPPED_RESPONSE_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "set-cookie",
  "set-cookie2",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

class GatewayError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = "GatewayError";
    this.code = code;
    this.status = status;
  }
}

function writeJson(response, status, body, extraHeaders = {}) {
  const encoded = Buffer.from(JSON.stringify(body), "utf8");
  response.writeHead(status, {
    "cache-control": "no-store, max-age=0",
    "content-length": String(encoded.length),
    "content-type": "application/json; charset=utf-8",
    "x-content-type-options": "nosniff",
    ...extraHeaders,
  });
  response.end(encoded);
}

function writeGatewayError(response, error) {
  const gatewayError = error instanceof GatewayError
    ? error
    : new GatewayError("GATEWAY_INTERNAL_ERROR", "Agent 网关处理请求失败", 500);
  writeJson(response, gatewayError.status, {
    ok: false,
    error: { code: gatewayError.code, message: gatewayError.message },
  });
}

function hasProxyIdentity(request) {
  return PROXY_IDENTITY_HEADERS.some((name) => request.headers[name] !== undefined);
}

function bearerHeader(request) {
  const value = request.headers.authorization;
  if (typeof value !== "string" || !/^Bearer [\x21-\x7e]{16,4096}$/u.test(value)) {
    throw new GatewayError("AUTH_REQUIRED", "Tailscale Agent 请求缺少 Bearer token", 401);
  }
  return value;
}

function contentLength(request) {
  const raw = request.headers["content-length"];
  if (raw === undefined) return null;
  if (Array.isArray(raw) || !/^\d+$/u.test(raw)) {
    throw new GatewayError("INVALID_CONTENT_LENGTH", "请求 Content-Length 无效", 400);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    throw new GatewayError("INVALID_CONTENT_LENGTH", "请求 Content-Length 无效", 400);
  }
  return value;
}

async function readRequestBody(request) {
  const declared = contentLength(request);
  if (declared !== null && declared > MAX_REQUEST_BYTES) {
    request.resume();
    throw new GatewayError("PAYLOAD_TOO_LARGE", "Agent 请求超过 2.2 MB", 413);
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_REQUEST_BYTES) {
      throw new GatewayError("PAYLOAD_TOO_LARGE", "Agent 请求超过 2.2 MB", 413);
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, size);
}

function assertRemoteAdministratorMachineRequest(request) {
  if (request.headers.cookie !== undefined) {
    throw new GatewayError("AMBIGUOUS_AUTH_FORBIDDEN", "远程管理请求不能同时携带浏览器 Cookie", 403);
  }
  if (request.headers.origin !== undefined || request.headers.referer !== undefined) {
    throw new GatewayError("BROWSER_REQUEST_FORBIDDEN", "远程管理动作只接受机器客户端请求", 403);
  }
  const fetchSite = request.headers["sec-fetch-site"];
  if (fetchSite !== undefined && fetchSite !== "none") {
    throw new GatewayError("BROWSER_REQUEST_FORBIDDEN", "远程管理动作只接受机器客户端请求", 403);
  }
}

function parseAgentMutation(body, request) {
  let parsed;
  try {
    parsed = JSON.parse(body.toString("utf8"));
  } catch {
    throw new GatewayError("INVALID_JSON", "Agent 写入必须是有效 JSON", 400);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new GatewayError("INVALID_BODY", "Agent 写入必须是 JSON 对象", 400);
  }
  const action = typeof parsed.action === "string" ? parsed.action : "";
  if (MANAGEMENT_ACTIONS.has(action)) {
    if (!REMOTE_ADMINISTRATOR_ACTIONS.has(action)) {
      throw new GatewayError(
        "MANAGEMENT_ACTION_FORBIDDEN",
        "Tailscale Agent 网关不开放这个管理动作",
        403,
      );
    }
    assertRemoteAdministratorMachineRequest(request);
    const commandId = typeof parsed.commandId === "string" ? parsed.commandId : "";
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u.test(commandId)) {
      throw new GatewayError("COMMAND_ID_REQUIRED", "远程管理动作必须携带稳定 commandId", 400);
    }
    return parsed;
  }
  if (!AGENT_MUTATION_ACTIONS.has(action)) {
    throw new GatewayError(
      "AGENT_ACTION_FORBIDDEN",
      "Tailscale Agent 网关没有开放这个写入动作",
      403,
    );
  }
  return parsed;
}

function upstreamHeaders(request, authorization, body, { localMetadataOrigin = false } = {}) {
  const headers = {
    accept: typeof request.headers.accept === "string" ? request.headers.accept : "application/json",
    authorization,
    "user-agent": "wenmai-tailscale-agent-gateway/1.0",
    "x-wenmai-agent-transport": "tailscale-gateway",
  };
  const protocol = request.headers["x-wenmai-agent-protocol"];
  if (typeof protocol === "string" && protocol.length <= 80) {
    headers["x-wenmai-agent-protocol"] = protocol;
  }
  if (body !== null) {
    headers["content-type"] = "application/json";
    headers["content-length"] = String(body.length);
  }
  // The browser-supplied Origin/Referer and every management credential are
  // deliberately discarded. These two metadata routes are locally same-origin
  // APIs, so the gateway adds its own canonical read-only Origin only after the
  // Agent token has been verified and its knowledge.read scope checked.
  if (localMetadataOrigin) headers.origin = WENMAI_UPSTREAM_ORIGIN;
  return headers;
}

function requestUpstream({
  upstreamOrigin,
  method,
  path,
  headers,
  body = null,
  maxResponseBytes = MAX_UPSTREAM_RESPONSE_BYTES,
}) {
  const target = new URL(path, upstreamOrigin);
  return new Promise((resolve, reject) => {
    const upstream = httpRequest(target, {
      method,
      headers,
      timeout: UPSTREAM_TIMEOUT_MS,
    }, (upstreamResponse) => {
      const chunks = [];
      let size = 0;
      upstreamResponse.on("data", (chunk) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += buffer.length;
        if (size > maxResponseBytes) {
          upstreamResponse.destroy(new GatewayError(
            "UPSTREAM_RESPONSE_TOO_LARGE",
            "文脉响应超过 Agent 网关上限",
            502,
          ));
          return;
        }
        chunks.push(buffer);
      });
      upstreamResponse.once("error", reject);
      upstreamResponse.once("end", () => resolve({
        status: upstreamResponse.statusCode ?? 502,
        headers: upstreamResponse.headers,
        body: Buffer.concat(chunks, size),
      }));
    });
    upstream.once("timeout", () => upstream.destroy(new GatewayError(
      "UPSTREAM_TIMEOUT",
      "文脉 Agent API 响应超时",
      504,
    )));
    upstream.once("error", reject);
    if (body !== null) upstream.end(body);
    else upstream.end();
  });
}

function relayUpstream(response, result) {
  const headers = {};
  for (const [rawName, value] of Object.entries(result.headers)) {
    const name = rawName.toLowerCase();
    if (value === undefined || STRIPPED_RESPONSE_HEADERS.has(name) || name === "content-length") continue;
    headers[name] = value;
  }
  headers["cache-control"] = "no-store, max-age=0";
  headers["content-length"] = String(result.body.length);
  headers["x-content-type-options"] = "nosniff";
  response.writeHead(result.status, headers);
  response.end(result.body);
}

function strictJson(buffer) {
  try {
    return JSON.parse(buffer.toString("utf8"));
  } catch {
    return null;
  }
}

async function validateAgentClient(request, authorization, upstreamOrigin) {
  const result = await requestUpstream({
    upstreamOrigin,
    method: "GET",
    path: `${WENMAI_AGENT_PATH}?view=health`,
    headers: upstreamHeaders(request, authorization, null),
    maxResponseBytes: 1_048_576,
  });
  const payload = strictJson(result.body);
  if (result.status !== 200 || !payload || payload.ok !== true || !payload.data) {
    const status = result.status === 401 || result.status === 403 ? result.status : 502;
    throw new GatewayError(
      status === 401 ? "AUTH_INVALID" : status === 403 ? "AUTH_FORBIDDEN" : "AUTH_VALIDATION_FAILED",
      status === 502 ? "文脉没有返回有效的 Agent 身份边界" : "Agent token 无效或无权访问",
      status,
    );
  }
  const clients = payload.data.clients;
  if (!Array.isArray(clients) || clients.length !== 1 || !clients[0] || typeof clients[0] !== "object") {
    throw new GatewayError("AUTH_VALIDATION_FAILED", "文脉没有返回唯一的 Agent 身份边界", 502);
  }
  const scopes = Array.isArray(clients[0].scopes) ? clients[0].scopes.filter((item) => typeof item === "string") : [];
  const articleIds = Array.isArray(clients[0].articleIds)
    ? clients[0].articleIds.filter((item) => typeof item === "string")
    : [];
  return { scopes, articleIds };
}

function assertKnowledgeScope(client) {
  if (!client.scopes.includes("knowledge.read")) {
    throw new GatewayError("SCOPE_DENIED", "Agent token 缺少 knowledge.read 权限", 403);
  }
}

function assertCorpusBoundary(url, client) {
  const views = url.searchParams.getAll("view");
  if (views.length > 1) throw new GatewayError("INVALID_QUERY", "corpus view 只能出现一次", 400);
  const view = views[0] || "manifest";
  if (view === "manifest") return;
  if (view !== "lineage") {
    throw new GatewayError("VIEW_FORBIDDEN", "Tailscale Agent 只允许 corpus manifest 与有界 lineage", 403);
  }
  const articleIds = url.searchParams.getAll("articleId");
  if (articleIds.length !== 1 || !articleIds[0]) {
    throw new GatewayError("ARTICLE_ID_REQUIRED", "远程 lineage 必须提供唯一 articleId", 400);
  }
  const articleId = articleIds[0];
  if (!client.articleIds.includes("*") && !client.articleIds.includes(articleId)) {
    throw new GatewayError("OBJECT_SCOPE_DENIED", "Agent token 不包含这个 lineage 文章对象", 403);
  }
}

async function proxyAllowedRequest(request, response, url, config) {
  const isMetadataPath = url.pathname === "/api/capabilities" || url.pathname === "/api/corpus/v1";
  if (url.pathname !== WENMAI_AGENT_PATH && !isMetadataPath && !STATIC_AGENT_PATHS.has(url.pathname)) {
    throw new GatewayError("ROUTE_NOT_FOUND", "Tailscale Agent 网关没有开放这个路径", 404);
  }
  const authorization = bearerHeader(request);
  if (url.pathname === WENMAI_AGENT_PATH) {
    let body = null;
    if (request.method === "POST") {
      const contentType = String(request.headers["content-type"] ?? "").toLowerCase();
      if (!contentType.includes("application/json")) {
        throw new GatewayError("UNSUPPORTED_MEDIA_TYPE", "Agent 写入必须使用 application/json", 415);
      }
      body = await readRequestBody(request);
      parseAgentMutation(body, request);
    }
    const result = await requestUpstream({
      upstreamOrigin: config.upstreamOrigin,
      method: request.method,
      path: `${url.pathname}${url.search}`,
      headers: upstreamHeaders(request, authorization, body),
      body,
    });
    relayUpstream(response, result);
    return;
  }

  if (request.method !== "GET") {
    throw new GatewayError("METHOD_NOT_ALLOWED", "这个 Agent 资源只允许 GET", 405);
  }
  const client = await validateAgentClient(request, authorization, config.upstreamOrigin);
  let localMetadataOrigin = false;
  if (url.pathname === "/api/capabilities") {
    assertKnowledgeScope(client);
    localMetadataOrigin = true;
  } else if (url.pathname === "/api/corpus/v1") {
    assertKnowledgeScope(client);
    assertCorpusBoundary(url, client);
    localMetadataOrigin = true;
  }
  const result = await requestUpstream({
    upstreamOrigin: config.upstreamOrigin,
    method: "GET",
    path: `${url.pathname}${url.search}`,
    headers: upstreamHeaders(request, authorization, null, { localMetadataOrigin }),
  });
  relayUpstream(response, result);
}

export function createGateway(options = {}) {
  const config = {
    listenHost: options.listenHost ?? GATEWAY_LISTEN_HOST,
    listenPort: options.listenPort ?? GATEWAY_LISTEN_PORT,
    upstreamOrigin: options.upstreamOrigin ?? WENMAI_UPSTREAM_ORIGIN,
  };
  let actualListenPort = config.listenPort;
  const server = createServer({
    headersTimeout: 10_000,
    maxHeaderSize: 16_384,
    requestTimeout: 65_000,
  }, async (request, response) => {
    try {
      if (!request.url || !["GET", "POST"].includes(request.method ?? "")) {
        throw new GatewayError("METHOD_NOT_ALLOWED", "Agent 网关只允许 GET 与 POST", 405);
      }
      const url = new URL(request.url, `http://${config.listenHost}:${actualListenPort}`);
      if (url.pathname === GATEWAY_HEALTH_PATH) {
        if (request.method !== "GET" || url.search || hasProxyIdentity(request)) {
          throw new GatewayError("ROUTE_NOT_FOUND", "Agent 网关没有开放这个路径", 404);
        }
        writeJson(response, 200, {
          ok: true,
          service: GATEWAY_SERVICE,
          pid: process.pid,
          listenHost: config.listenHost,
          listenPort: actualListenPort,
          upstreamOrigin: config.upstreamOrigin,
          agentPath: WENMAI_AGENT_PATH,
        });
        return;
      }
      await proxyAllowedRequest(request, response, url, config);
    } catch (error) {
      if (!response.headersSent) writeGatewayError(response, error);
      else response.destroy();
    }
  });
  server.on("listening", () => {
    const address = server.address();
    if (address && typeof address === "object") actualListenPort = address.port;
  });
  server.on("upgrade", (_request, socket) => socket.destroy());
  server.on("clientError", (_error, socket) => {
    if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
  });
  return server;
}

export function listenGateway(server, options = {}) {
  const host = options.listenHost ?? GATEWAY_LISTEN_HOST;
  const port = options.listenPort ?? GATEWAY_LISTEN_PORT;
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve(server);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen({ host, port, exclusive: true });
  });
}

async function main() {
  const server = createGateway();
  try {
    await listenGateway(server);
  } catch (error) {
    process.stderr.write(`文脉 Tailscale Agent 网关启动失败：${error instanceof Error ? error.message : "unknown error"}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`文脉 Tailscale Agent 网关已监听 http://${GATEWAY_LISTEN_HOST}:${GATEWAY_LISTEN_PORT}\n`);
  const close = () => server.close(() => { process.exitCode = 0; });
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
}

const entryPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (entryPath === import.meta.url) void main();
