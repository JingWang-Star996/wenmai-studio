import { env } from "cloudflare:workers";
import { ManagementAuthError } from "../../../management-auth-core";
import { requireManagementSession } from "../../../management-auth";
import { SharedSourceReadError, parseSharedSourcePage, sharedSourceManagementProjection } from "../../../shared-source-read-model";

function response(body: Record<string, unknown>, status = 200) { return Response.json(body, { status, headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" } }); }
export async function GET(request: Request) {
  const requestId = `req-${crypto.randomUUID()}`;
  try {
    await requireManagementSession(request, { scope: "management.read" });
    if (!env.DB) throw new SharedSourceReadError("SHARED_SOURCE_NOT_INITIALIZED", "共享来源只读存储尚未完成初始化", 503);
    const url = new URL(request.url), view = url.searchParams.get("view") ?? "manifest", sourceId = url.searchParams.get("id");
    if (view !== "manifest" && view !== "source") throw new SharedSourceReadError("INVALID_VIEW", "view 仅支持 manifest 或 source", 400);
    if (view === "source" && (!sourceId || sourceId.length > 200)) throw new SharedSourceReadError("SHARED_SOURCE_NOT_FOUND", "共享来源不存在", 404);
    if (view === "manifest" && sourceId) throw new SharedSourceReadError("INVALID_QUERY", "manifest 不接受 id", 400);
    if (view === "source" && (url.searchParams.has("limit") || url.searchParams.has("cursor"))) throw new SharedSourceReadError("INVALID_QUERY", "source 详情不接受分页参数", 400);
    const page = view === "manifest" ? parseSharedSourcePage(url.searchParams.get("limit"), url.searchParams.get("cursor")) : undefined;
    return response({ ok: true, requestId, data: await sharedSourceManagementProjection(env.DB, sourceId ?? undefined, page) });
  } catch (error) {
    const known = error instanceof SharedSourceReadError || error instanceof ManagementAuthError ? error : new SharedSourceReadError("INTERNAL_ERROR", "共享来源只读投影处理失败", 500);
    return response({ ok: false, requestId, error: { code: known.code, message: known.message, ...(known.details ? { details: known.details } : {}) } }, known.status);
  }
}
