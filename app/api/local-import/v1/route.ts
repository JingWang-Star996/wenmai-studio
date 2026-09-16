import { LocalImportAuthError } from "../../../local-import-auth-core";
import { requireLocalImportOperator } from "../../../local-import-auth";
import { sha256Text } from "../../../management-auth-core";
import {
  ArticleArchiveIntakeError,
  articleArchiveIntakeContractManifest,
  parseLocalImportIntakeDeclaration,
} from "../../../article-archive-intake";
import {
  createLocalImportProjectPackage,
  readLocalImportProjectPackage,
} from "../../project-package/v1/route";

type JsonObject = Record<string, unknown>;

const MAX_REQUEST_BYTES = 2_200_000;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const COMMAND_ID_PATTERN = /^[A-Za-z0-9._:-]{1,160}$/u;
const LOCAL_IMPORT_BODY_SHA256_BASIS = "canonical_utf8_text_after_bom_removal_and_newline_normalization" as const;

function localImportContractManifest() {
  return {
    ...articleArchiveIntakeContractManifest(),
    bodySha256Contract: {
      basis: LOCAL_IMPORT_BODY_SHA256_BASIS,
      originalFileBytesVerified: false,
      instruction: "bodySha256 只绑定去除 BOM 并将换行规范化为 LF 后的 UTF-8 文本，不是原文件字节摘要。",
    },
  };
}

class LocalImportApiError extends Error {
  code: string;
  status: number;
  details?: JsonObject;

  constructor(code: string, message: string, status = 400, details?: JsonObject) {
    super(message);
    this.name = "LocalImportApiError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function requestId() {
  return `local-import-request-${crypto.randomUUID()}`;
}

function jsonResponse(requestIdValue: string, data: JsonObject, status = 200) {
  return Response.json({ ok: true, requestId: requestIdValue, data }, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

function errorResponse(requestIdValue: string, error: unknown) {
  const candidate = error as { code?: string; message?: string; status?: number; details?: JsonObject };
  const status = candidate.status && candidate.status >= 400 && candidate.status <= 599 ? candidate.status : 500;
  const code = candidate.code || "LOCAL_IMPORT_INTERNAL_ERROR";
  const message = status === 500 ? "本机导入接口处理失败" : candidate.message || "本机导入请求失败";
  return Response.json({
    ok: false,
    requestId: requestIdValue,
    error: { code, message, ...(candidate.details ? { details: candidate.details } : {}) },
  }, { status, headers: { "cache-control": "no-store" } });
}

function isObject(value: unknown): value is JsonObject {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function assertExactKeys(value: JsonObject, allowed: string[], label: string) {
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unexpected.length) {
    throw new LocalImportApiError("UNKNOWN_FIELD", `${label} 包含未允许字段`, 400, { unexpected });
  }
}

function requiredText(value: unknown, label: string, maxLength: number, allowNewlines = false) {
  if (typeof value !== "string") throw new LocalImportApiError("INVALID_FIELD", `${label} 必须是字符串`);
  const normalized = allowNewlines ? value : value.trim();
  if (!normalized) throw new LocalImportApiError("INVALID_FIELD", `${label} 不能为空`);
  if (normalized.length > maxLength) throw new LocalImportApiError("INVALID_FIELD", `${label} 超过长度上限`);
  if (!allowNewlines && /[\r\n]/u.test(normalized)) throw new LocalImportApiError("INVALID_FIELD", `${label} 不允许换行`);
  return normalized;
}

function canonicalProjectScalarText(value: unknown, label: string, maxLength: number) {
  if (typeof value !== "string") throw new LocalImportApiError("INVALID_FIELD", `${label} 必须是字符串`);
  const normalized = value.trim().replace(/\s+/gu, " ");
  if (!normalized) throw new LocalImportApiError("INVALID_FIELD", `${label} 不能为空`);
  if (normalized.length > maxLength) throw new LocalImportApiError("INVALID_FIELD", `${label} 超过长度上限`);
  if ([...normalized].some((character) => character.charCodeAt(0) < 32)) {
    throw new LocalImportApiError("INVALID_FIELD", `${label} 包含不允许的控制字符`);
  }
  return normalized;
}

function exactSha256(value: unknown, label: string) {
  const digest = requiredText(value, label, 64).toLowerCase();
  if (!SHA256_PATTERN.test(digest)) throw new LocalImportApiError("INVALID_SHA256", `${label} 必须是 SHA-256`);
  return digest;
}

function normalizedBodyText(value: unknown) {
  const bodyText = requiredText(value, "bodyText", 2_000_000, true)
    .replace(/^\uFEFF/u, "")
    .replace(/\r\n?/gu, "\n");
  if (!bodyText.trim()) {
    throw new LocalImportApiError("EMPTY_DOCUMENT", "待导入正文不含非空白内容；尚未创建文章工程或写入正文。请补充正文后重试。");
  }
  if (new TextEncoder().encode(bodyText).byteLength > 2_000_000) {
    throw new LocalImportApiError("DOCUMENT_TOO_LARGE", "待导入正文超过 2 MB；尚未创建文章工程或写入正文。请拆分或缩短正文后重试。", 413);
  }
  return bodyText;
}

function safeSourceName(value: unknown) {
  const name = canonicalProjectScalarText(value, "sourceName", 255);
  if ([...name].some((character) => character.charCodeAt(0) < 32)
    || name.includes("..") || /[\\/]/u.test(name) || /^[A-Za-z]:/u.test(name)) {
    throw new LocalImportApiError("SOURCE_NAME_ONLY", "导入来源名称包含本机路径；尚未创建文章工程或写入正文。请仅提交文件名后重试。");
  }
  return name;
}

async function parseMutationBody(request: Request) {
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > MAX_REQUEST_BYTES) {
    throw new LocalImportApiError("PAYLOAD_TOO_LARGE", "本机导入请求超过 2.2 MB；尚未创建文章工程或写入正文。请缩小请求后重试。", 413);
  }
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    throw new LocalImportApiError("UNSUPPORTED_MEDIA_TYPE", "本机导入请求的内容类型无效；尚未创建文章工程或写入正文。请使用 application/json 后重试。", 415);
  }
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_REQUEST_BYTES) {
    throw new LocalImportApiError("PAYLOAD_TOO_LARGE", "本机导入请求超过 2.2 MB；尚未创建文章工程或写入正文。请缩小请求后重试。", 413);
  }
  let body: unknown;
  try { body = JSON.parse(text); } catch { throw new LocalImportApiError("INVALID_JSON", "本机导入请求正文不是有效 JSON；尚未创建文章工程或写入正文。请检查请求正文后重试。"); }
  if (!isObject(body)) throw new LocalImportApiError("INVALID_JSON", "本机导入请求正文不是 JSON 对象；尚未创建文章工程或写入正文。请按对象格式提交后重试。");
  assertExactKeys(body, ["action", "commandId", "payload"], "请求");
  const action = requiredText(body.action, "action", 80);
  if (action !== "create_article_from_text") {
    throw new LocalImportApiError("UNKNOWN_ACTION", `本机导入动作未被识别：${action}；现有文章工程未被变更。请检查 action 后重试。`, 404);
  }
  const commandId = requiredText(body.commandId, "commandId", 160);
  if (!COMMAND_ID_PATTERN.test(commandId)) throw new LocalImportApiError("INVALID_COMMAND_ID", "本机导入的 commandId 格式无效；尚未创建文章工程或写入正文。请检查 commandId 后重试。");
  if (!isObject(body.payload)) throw new LocalImportApiError("INVALID_PAYLOAD", "本机导入的 payload 不是 JSON 对象；尚未创建文章工程或写入正文。请按对象格式提交后重试。");
  assertExactKeys(body.payload, ["title", "bodyText", "bodySha256", "sourceName", "format", "intake"], "payload");
  const title = canonicalProjectScalarText(body.payload.title, "title", 300);
  const bodyText = normalizedBodyText(body.payload.bodyText);
  const bodySha256 = exactSha256(body.payload.bodySha256, "bodySha256");
  const actualBodySha256 = await sha256Text(bodyText);
  if (bodySha256 !== actualBodySha256) {
    throw new LocalImportApiError("BODY_SHA256_MISMATCH", "正文 SHA-256 与请求不一致", 409, {
      expected: bodySha256,
      actual: actualBodySha256,
      digestBasis: LOCAL_IMPORT_BODY_SHA256_BASIS,
    });
  }
  const sourceName = safeSourceName(body.payload.sourceName);
  const format = requiredText(body.payload.format, "format", 20);
  if (format !== "markdown" && format !== "text") {
    throw new LocalImportApiError("INVALID_FORMAT", "format 只能是 markdown 或 text");
  }
  let intake;
  try {
    intake = parseLocalImportIntakeDeclaration(body.payload.intake);
  } catch (error) {
    if (error instanceof ArticleArchiveIntakeError) {
      throw new LocalImportApiError(error.code, error.message);
    }
    throw error;
  }
  const identity = bodySha256.slice(0, 32);
  return {
    commandId,
    articleId: `local-article-import-${identity}`,
    projectId: `local-project-import-${identity}`,
    title,
    bodyText,
    bodySha256,
    bodySha256Basis: LOCAL_IMPORT_BODY_SHA256_BASIS,
    originalFileBytesVerified: false as const,
    sourceName,
    format: format as "markdown" | "text",
    intake,
  };
}

export async function GET(request: Request) {
  const id = requestId();
  try {
    const principal = await requireLocalImportOperator(request);
    const url = new URL(request.url);
    const view = url.searchParams.get("view");
    if (view === "health" || view === "contract") {
      const unexpected = [...url.searchParams.keys()].filter((key) => key !== "view");
      if (unexpected.length) throw new LocalImportApiError("UNKNOWN_QUERY", "本机权限探针包含未允许查询参数", 400, { unexpected });
      if (view === "contract") {
        return jsonResponse(id, localImportContractManifest());
      }
      return jsonResponse(id, {
        authorized: true,
        actorId: principal.actorId,
        authorizationKind: principal.authKind,
        scope: "article.import.new_root",
        transport: "exact_ipv6_loopback",
        secretReturned: false,
        archiveIntakeContract: localImportContractManifest(),
      });
    }
    if (view !== null) throw new LocalImportApiError("UNKNOWN_VIEW", `未知本机导入读取视图：${view}`, 404);
    const articleId = requiredText(url.searchParams.get("articleId"), "articleId", 160);
    const bodySha256 = exactSha256(url.searchParams.get("bodySha256"), "bodySha256");
    const data = await readLocalImportProjectPackage(articleId, bodySha256);
    return jsonResponse(id, data);
  } catch (error) {
    return errorResponse(id, error);
  }
}

export async function POST(request: Request) {
  const id = requestId();
  try {
    const principal = await requireLocalImportOperator(request);
    const input = await parseMutationBody(request);
    const result = await createLocalImportProjectPackage(input, principal.actorId);
    return jsonResponse(id, result.data, result.status);
  } catch (error) {
    return errorResponse(id, error);
  }
}

export { LocalImportApiError, LocalImportAuthError };
