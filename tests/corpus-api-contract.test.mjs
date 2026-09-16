import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const route = readFileSync(new URL("../app/api/corpus/v1/route.ts", import.meta.url), "utf8");
const libraryApi = readFileSync(new URL("../app/corpus-library-api.ts", import.meta.url), "utf8");
const executableLibraryApi = libraryApi
  .replace(/^type .*;\r?\n/gm, "")
  .replace(/: (LibraryFilters|LibraryCursorItem\[\]|LibraryCursorItem|string \| null|string)/g, "");
const library = await import(`data:text/javascript;base64,${Buffer.from(executableLibraryApi).toString("base64")}`);

test("语料读接口按需暴露分页目录、分类、节点搜索和局部开发树", () => {
  for (const view of ["manifest", "library", "classifications", "development-search", "lineage"]) {
    assert.match(route, new RegExp(`"${view}"`));
  }
  assert.match(route, /bodyTextIncluded: false/);
  assert.match(route, /sourceCorpusReadOnly: true/);
  assert.match(route, /MAX_LINEAGE_NODES = 240/);
  assert.match(route, /MAX_LINEAGE_EDGES = 480/);
  assert.match(route, /MAX_DEPTH = 3/);
});

test("目录与开发树搜索使用稳定、不透明的 seek 游标，且卡片不含正文", () => {
  assert.match(route, /MAX_LIBRARY_RESULTS = 24/);
  assert.match(route, /crypto\.subtle\.digest\("SHA-256"/);
  assert.match(route, /async function cursorOffset/);
  assert.match(route, /throw new Error\("CURSOR_INVALID"\)/);
  assert.match(route, /stableByUpdatedAt/);
  assert.match(route, /left\.id\.localeCompare\(right\.id\)/);
  assert.match(route, /nextCursor:/);
  assert.match(route, /facets: facetCounts/);
  assert.match(route, /bodyTextIncluded: false/);
  assert.doesNotMatch(route, /bodyText: article\./);
});

test("资料库将真实生成分类完整映射到七个书架，未知分类安全归入证据与目录", () => {
  const expected = {
    published_article: "已发布文章",
    platform_build: "平台成品",
    import_artifact: "平台成品",
    draft_or_intermediate: "创作草稿",
    source_material: "来源素材",
    research_governance: "研究与质检",
    test_or_qa: "研究与质检",
    skill_summary_or_capability: "能力与工具",
    tool: "能力与工具",
    manifest_or_metadata: "证据与目录",
    evidence: "证据与目录",
    catalog_only: "证据与目录",
  };
  for (const [className, bucket] of Object.entries(expected)) assert.equal(library.libraryBucketForClass(className), bucket);
  assert.equal(library.libraryBucketForClass("future_class"), "证据与目录");
});

test("资料库游标只在相同规范化筛选器和限制下有效，且卡片投影不含版本或正文", async () => {
  const base = { q: "graph", bucket: "all", kind: "article", state: "published", platform: "wenmai", limit: 12 };
  const item = { id: "article-1", updatedAt: "2026-09-04T00:00:00.000Z" };
  const digest = await library.libraryFilterDigest(base);
  const cursor = await library.libraryCursor(digest, item);
  assert.equal(await library.libraryCursorOffset(digest, [item], cursor), 1);
  for (const field of Object.keys(base)) {
    const changed = { ...base, [field]: field === "limit" ? 13 : `${base[field]}-changed` };
    await assert.rejects(library.libraryCursorOffset(await library.libraryFilterDigest(changed), [item], cursor), /CURSOR_INVALID/);
  }
  assert.doesNotMatch(route, /versions: article\.versions|bodyText: article\./);
});

test("开发树遍历保留方向、状态、证据并拒绝任意写入", () => {
  assert.match(route, /edge\.source === id \? edge\.target : edge\.source/);
  assert.match(route, /edge\.evidenceRefs/);
  assert.match(route, /edge\.relationType === "artifact_of"/);
  assert.match(route, /status === "all" \|\| edge\.status === status/);
  assert.match(route, /relationType === "all" \|\| edge\.relationType === relationType/);
  assert.match(route, /structuralBridgeRelationTypes: \["artifact_of"\]/);
  assert.match(route, /export async function POST/);
  assert.match(route, /"READ_ONLY"/);
});

test("本地语料接口拒绝跨源读取且不接受路径参数", () => {
  assert.match(route, /CROSS_ORIGIN_READ_FORBIDDEN/);
  assert.match(route, /sec-fetch-site/);
  assert.match(route, /origin !== url\.origin/);
  assert.doesNotMatch(route, /readFile|node:fs|path=/);
});
