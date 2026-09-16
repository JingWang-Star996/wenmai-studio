import textData from "../../../data/version-text.generated.json";
import { ManagementAuthError } from "../../management-auth-core";
import { requireManagementSession } from "../../management-auth";

const textIndex = textData as { versions: Record<string, string>; blobs: Record<string, string> };

export async function GET(request: Request) {
  try {
    await requireManagementSession(request, { scope: "management.read" });
    const url = new URL(request.url);
    const ids = [...new Set(url.searchParams.getAll("id"))].slice(0, 2);
    if (!ids.length) return Response.json({ error: "缺少版本 ID" }, { status: 400 });

    const versions = Object.fromEntries(
      ids.flatMap((id) => {
        const textHash = textIndex.versions[id];
        const text = textHash ? textIndex.blobs[textHash] : undefined;
        return text !== undefined ? [[id, { text, textHash }]] : [];
      }),
    );
    if (!Object.keys(versions).length) return Response.json({ error: "未找到版本正文" }, { status: 404 });

    return Response.json({ versions }, {
      headers: { "cache-control": "no-store, max-age=0", pragma: "no-cache" },
    });
  } catch (error) {
    const status = error instanceof ManagementAuthError ? error.status : 500;
    return Response.json({
      error: error instanceof Error ? error.message : "版本正文读取失败",
      ...(error instanceof ManagementAuthError ? { code: error.code } : {}),
    }, { status, headers: { "cache-control": "no-store" } });
  }
}
