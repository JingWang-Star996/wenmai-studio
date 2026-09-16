const CURSOR_PREFIX = "wenmai-corpus-v1";

type LibraryFilters = { q: string; bucket: string; kind: string; state: string; platform: string; limit: number };
type LibraryCursorItem = { id: string; updatedAt: string };

export const libraryBucketForClass = (className: string) => {
  switch (className) {
    case "published_article": return "已发布文章";
    case "platform_build":
    case "import_artifact": return "平台成品";
    case "draft_or_intermediate": return "创作草稿";
    case "source_material": return "来源素材";
    case "research_governance":
    case "test_or_qa": return "研究与质检";
    case "skill_summary_or_capability":
    case "tool": return "能力与工具";
    case "manifest_or_metadata":
    case "evidence":
    case "catalog_only":
    default: return "证据与目录";
  }
};

export const canonicalLibraryFilters = ({ q, bucket, kind, state, platform, limit }: LibraryFilters) => JSON.stringify({
  q,
  bucket,
  kind,
  state,
  platform,
  limit,
});

const sha256 = async (value: string) => {
  const input = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", input);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

export const libraryFilterDigest = async (filters: LibraryFilters) => sha256(`${CURSOR_PREFIX}:filters:${canonicalLibraryFilters(filters)}`);

export const libraryCursor = async (filterDigest: string, item: LibraryCursorItem) => sha256(`${CURSOR_PREFIX}:library:${filterDigest}:${item.updatedAt}:${item.id}`);

export const libraryCursorOffset = async (filterDigest: string, items: LibraryCursorItem[], requested: string | null) => {
  if (!requested) return 0;
  for (let index = 0; index < items.length; index += 1) {
    if (await libraryCursor(filterDigest, items[index]) === requested) return index + 1;
  }
  throw new Error("CURSOR_INVALID");
};
