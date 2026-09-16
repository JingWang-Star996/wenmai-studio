import corpusData from "../../../../data/corpus.generated.json";
import { libraryBucketForClass, libraryCursor, libraryCursorOffset, libraryFilterDigest } from "../../../corpus-library-api";
import { workbenchArticleDetail } from "../../../corpus-library";
import type { CorpusData } from "../../../types";

export const runtime = "edge";

type JsonRecord = Record<string, unknown>;
type Classification = {
  class: string;
  basis: string;
  confidence: string;
  ruleVersion: string;
  evidenceRefs: string[];
};
type DevelopmentEdge = JsonRecord & { id: string; relationType: string; source: string; target: string; status: string; evidenceRefs: string[] };

const corpus = corpusData as unknown as CorpusData;

const MAX_SEARCH_RESULTS = 100;
const MAX_LIBRARY_RESULTS = 24;
const MAX_LINEAGE_NODES = 240;
const MAX_LINEAGE_EDGES = 480;
const MAX_DEPTH = 3;

function responseId() {
  return `corpus-${crypto.randomUUID()}`;
}

function success(data: unknown, status = 200) {
  return Response.json({ ok: true, requestId: responseId(), data }, { status, headers: { "cache-control": "no-store" } });
}

function failure(code: string, message: string, status: number, details?: unknown) {
  return Response.json({ ok: false, requestId: responseId(), error: { code, message, ...(details === undefined ? {} : { details }) } }, { status, headers: { "cache-control": "no-store" } });
}

function sameOrigin(request: Request) {
  const url = new URL(request.url);
  const origin = request.headers.get("origin");
  const referer = request.headers.get("referer");
  const site = request.headers.get("sec-fetch-site");
  if (site && !["same-origin", "same-site", "none"].includes(site)) return false;
  if (origin && origin !== url.origin) return false;
  if (referer) {
    try {
      if (new URL(referer).origin !== url.origin) return false;
    } catch {
      return false;
    }
  }
  return true;
}

function boundedInteger(value: string | null, fallback: number, minimum: number, maximum: number) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? Math.min(maximum, Math.max(minimum, parsed)) : fallback;
}

type CursorEntry = { id: string; updatedAt?: unknown };

function updatedAtForSort(item: CursorEntry) {
  return typeof item.updatedAt === "string" && item.updatedAt.trim() ? item.updatedAt : "";
}

function stableByUpdatedAt<T extends CursorEntry>(items: T[]) {
  return [...items].sort((left, right) => updatedAtForSort(right).localeCompare(updatedAtForSort(left)) || left.id.localeCompare(right.id));
}

async function opaqueCursor(scope: string, item: CursorEntry) {
  const input = new TextEncoder().encode(`wenmai-corpus-v1:${scope}:${updatedAtForSort(item)}:${item.id}`);
  const digest = await crypto.subtle.digest("SHA-256", input);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function cursorOffset(scope: string, items: CursorEntry[], requested: string | null) {
  if (!requested) return 0;
  for (let index = 0; index < items.length; index += 1) {
    if (await opaqueCursor(scope, items[index]) === requested) return index + 1;
  }
  throw new Error("CURSOR_INVALID");
}

function libraryBucket(article: { classification: Classification }) {
  return libraryBucketForClass(article.classification.class);
}

function facetCounts(items: Array<{ kind: string; editorialState?: unknown; platforms: string[]; classification: Classification }>) {
  const count = (values: string[]) => values.reduce<Record<string, number>>((result, value) => ({ ...result, [value]: (result[value] ?? 0) + 1 }), {});
  return {
    bucket: count(items.map(libraryBucket)),
    kind: count(items.map((item) => item.kind)),
    state: count(items.map((item) => typeof item.editorialState === "string" ? item.editorialState : "未记录")),
    platform: count(items.flatMap((item) => item.platforms)),
  };
}

async function librarySearch(url: URL) {
  const query = (url.searchParams.get("q") ?? "").trim().toLowerCase().slice(0, 160);
  const bucket = (url.searchParams.get("bucket") ?? "all").trim();
  const kind = (url.searchParams.get("kind") ?? "all").trim();
  const state = (url.searchParams.get("state") ?? "all").trim();
  const platform = (url.searchParams.get("platform") ?? "all").trim();
  const limit = boundedInteger(url.searchParams.get("limit"), 12, 1, MAX_LIBRARY_RESULTS);
  const filterDigest = await libraryFilterDigest({ q: query, bucket, kind, state, platform, limit });
  const candidates = corpus.articles.filter((article) => {
    if (bucket !== "all" && libraryBucket(article) !== bucket) return false;
    if (kind !== "all" && article.kind !== kind) return false;
    if (state !== "all" && article.editorialState !== state) return false;
    if (platform !== "all" && !article.platforms.includes(platform)) return false;
    return !query || [article.id, article.title, article.kind, article.summary, article.editorialState, ...article.tags, ...article.platforms].join(" ").toLowerCase().includes(query);
  });
  const sorted = stableByUpdatedAt(candidates);
  const offset = await libraryCursorOffset(filterDigest, sorted, url.searchParams.get("cursor"));
  const pageItems = sorted.slice(offset, offset + limit);
  return {
    items: pageItems.map((article) => ({ id: article.id, title: article.title, canonicalTitle: article.canonicalTitle, kind: article.kind, summary: article.summary, tags: article.tags, platforms: article.platforms, updatedAt: article.updatedAt, versionCount: article.versionCount, editorialState: article.editorialState, publicationState: article.publicationState, classification: article.classification, bucket: libraryBucket(article) })),
    total: sorted.length,
    nextCursor: offset + pageItems.length < sorted.length && pageItems.length ? await libraryCursor(filterDigest, pageItems.at(-1)!) : null,
    page: Math.floor(offset / limit) + 1,
    hasMore: offset + pageItems.length < sorted.length,
    facets: facetCounts(candidates),
    corpus: { schemaVersion: corpus.schemaVersion, algorithmVersion: corpus.algorithmVersion, generatedAt: corpus.generatedAt },
    bodyTextIncluded: false,
  };
}

const MAX_DETAIL_RESPONSE_BYTES = 512 * 1024;

function detail(url: URL) {
  const articleId = (url.searchParams.get("articleId") ?? "").trim();
  if (!/^[A-Za-z0-9._:-]{1,160}$/u.test(articleId)) throw new Error("ARTICLE_ID_INVALID");
  const article = corpus.articles.find((candidate) => candidate.id === articleId);
  if (!article) throw new Error("ARTICLE_NOT_FOUND");
  const payload = { article: workbenchArticleDetail(article), bodyTextIncluded: false };
  if (new TextEncoder().encode(JSON.stringify(payload)).byteLength > MAX_DETAIL_RESPONSE_BYTES) throw new Error("DETAIL_TOO_LARGE");
  return payload;
}

function classificationSearch(url: URL) {
  const query = (url.searchParams.get("q") ?? "").trim().toLowerCase().slice(0, 160);
  const className = (url.searchParams.get("class") ?? "all").trim();
  const cursor = boundedInteger(url.searchParams.get("cursor"), 0, 0, Number.MAX_SAFE_INTEGER);
  const limit = boundedInteger(url.searchParams.get("limit"), 50, 1, MAX_SEARCH_RESULTS);
  const matches = corpus.articles.filter((article) => {
    if (className !== "all" && article.classification.class !== className) return false;
    if (!query) return true;
    return [article.id, article.title, article.kind, article.classification.class, ...article.platforms]
      .join(" ").toLowerCase().includes(query);
  });
  const items = matches.slice(cursor, cursor + limit).map((article) => ({
    id: article.id,
    title: article.title,
    kind: article.kind,
    updatedAt: article.updatedAt,
    versionCount: article.versionCount,
    platforms: article.platforms,
    classification: article.classification,
    versionClassCounts: article.versions.reduce<Record<string, number>>((counts, version) => {
      const key = version.classification.class;
      counts[key] = (counts[key] ?? 0) + 1;
      return counts;
    }, {}),
  }));
  return {
    items,
    total: matches.length,
    nextCursor: cursor + items.length < matches.length ? cursor + items.length : null,
    bodyTextIncluded: false,
  };
}

async function developmentSearch(url: URL) {
  const query = (url.searchParams.get("q") ?? "").trim().toLowerCase().slice(0, 160);
  const nodeType = (url.searchParams.get("nodeType") ?? "all").trim();
  const className = (url.searchParams.get("class") ?? "all").trim();
  const limit = boundedInteger(url.searchParams.get("limit"), 40, 1, MAX_SEARCH_RESULTS);
  const matches = corpus.developmentTree.nodes.filter((node) => {
    if (nodeType !== "all" && node.nodeType !== nodeType) return false;
    if (className !== "all" && node.classification?.class !== className) return false;
    return !query || `${node.id} ${node.label} ${node.nodeType} ${node.classification?.class ?? ""}`.toLowerCase().includes(query);
  });
  const sorted = stableByUpdatedAt(matches.map((node) => ({ ...node, updatedAt: typeof node.updatedAt === "string" ? node.updatedAt : "" })));
  const offset = await cursorOffset("development-search", sorted, url.searchParams.get("cursor"));
  const nodes = sorted.slice(offset, offset + limit);
  return { nodes, totalMatchedBeforeLimit: sorted.length, nextCursor: offset + nodes.length < sorted.length && nodes.length ? await opaqueCursor("development-search", nodes.at(-1)!) : null, bodyTextIncluded: false };
}

function lineage(url: URL) {
  const requestedSeed = (url.searchParams.get("seed") ?? url.searchParams.get("articleId") ?? "").trim();
  if (!requestedSeed) throw new Error("SEED_REQUIRED");
  const nodeById = new Map(corpus.developmentTree.nodes.map((node) => [node.id, node]));
  if (!nodeById.has(requestedSeed)) throw new Error("SEED_NOT_FOUND");
  const depth = boundedInteger(url.searchParams.get("depth"), 2, 0, MAX_DEPTH);
  const nodeLimit = boundedInteger(url.searchParams.get("limit"), 120, 1, MAX_LINEAGE_NODES);
  const status = (url.searchParams.get("status") ?? "all").trim();
  const relationType = (url.searchParams.get("relationType") ?? "all").trim();
  const eligibleEdges = corpus.developmentTree.edges.filter((edge) =>
    edge.relationType === "artifact_of"
    || ((status === "all" || edge.status === status)
      && (relationType === "all" || edge.relationType === relationType)));
  const adjacency = new Map<string, DevelopmentEdge[]>();
  for (const edge of eligibleEdges) {
    adjacency.set(edge.source, [...(adjacency.get(edge.source) ?? []), edge]);
    adjacency.set(edge.target, [...(adjacency.get(edge.target) ?? []), edge]);
  }
  const selected = new Set<string>([requestedSeed]);
  let frontier = [requestedSeed];
  let truncated = false;
  for (let level = 0; level < depth && frontier.length; level += 1) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const edge of adjacency.get(id) ?? []) {
        const neighbor = edge.source === id ? edge.target : edge.source;
        if (selected.has(neighbor)) continue;
        if (selected.size >= nodeLimit) {
          truncated = true;
          break;
        }
        selected.add(neighbor);
        next.push(neighbor);
      }
      if (truncated) break;
    }
    frontier = next;
    if (truncated) break;
  }
  const edges = eligibleEdges.filter((edge) => selected.has(edge.source) && selected.has(edge.target)).slice(0, MAX_LINEAGE_EDGES);
  if (eligibleEdges.filter((edge) => selected.has(edge.source) && selected.has(edge.target)).length > edges.length) truncated = true;
  const evidenceIds = new Set(edges.flatMap((edge) => edge.evidenceRefs));
  return {
    seed: requestedSeed,
    depth,
    nodes: [...selected].map((id) => nodeById.get(id)).filter(Boolean),
    edges,
    evidence: corpus.classification.evidence.filter((item) => evidenceIds.has(item.id)),
    truncated,
    structuralBridgeRelationTypes: ["artifact_of"],
    limits: { nodes: nodeLimit, edges: MAX_LINEAGE_EDGES, depth: MAX_DEPTH },
    bodyTextIncluded: false,
  };
}

export async function GET(request: Request) {
  if (!sameOrigin(request)) return failure("CROSS_ORIGIN_READ_FORBIDDEN", "语料分类与开发树只允许本地同源读取", 403);
  const url = new URL(request.url);
  const view = url.searchParams.get("view") ?? "manifest";
  try {
    if (view === "manifest") return success({
      schemaVersion: "wenmai.corpus-read-api/1.0",
      corpus: { schemaVersion: corpus.schemaVersion, algorithmVersion: corpus.algorithmVersion, generatedAt: corpus.generatedAt },
      classification: {
        schemaVersion: corpus.classification.schemaVersion,
        ruleVersion: corpus.classification.ruleVersion,
        classes: corpus.classification.classes,
        counts: corpus.classification.counts,
        objectCoverage: corpus.classification.objectCoverage,
        policy: corpus.classification.policy,
      },
      artifactBaselineDelta: corpus.artifactBaselineDelta,
      developmentTree: {
        schemaVersion: corpus.developmentTree.schemaVersion,
        ruleVersion: corpus.developmentTree.ruleVersion,
        relationTypes: corpus.developmentTree.relationTypes,
        counts: corpus.developmentTree.counts,
        notes: corpus.developmentTree.notes,
      },
      views: ["manifest", "library", "detail", "classifications", "development-search", "lineage"],
      limits: { search: MAX_SEARCH_RESULTS, detailResponseBytes: MAX_DETAIL_RESPONSE_BYTES, lineageNodes: MAX_LINEAGE_NODES, lineageEdges: MAX_LINEAGE_EDGES, depth: MAX_DEPTH },
      sourceCorpusReadOnly: true,
    });
    if (view === "library") return success(await librarySearch(url));
    if (view === "detail") return success(detail(url));
    if (view === "classifications") return success(classificationSearch(url));
    if (view === "development-search") return success(await developmentSearch(url));
    if (view === "lineage") return success(lineage(url));
    return failure("VIEW_NOT_FOUND", "未知语料读取视图", 404, { view });
  } catch (error) {
    if (error instanceof Error && error.message === "SEED_REQUIRED") return failure("SEED_REQUIRED", "lineage 需要 seed 或 articleId", 400);
    if (error instanceof Error && error.message === "SEED_NOT_FOUND") return failure("SEED_NOT_FOUND", "开发树中没有这个节点", 404);
    if (error instanceof Error && error.message === "CURSOR_INVALID") return failure("CURSOR_INVALID", "分页游标无效或已过期", 400);
    if (error instanceof Error && error.message === "ARTICLE_ID_INVALID") return failure("ARTICLE_ID_INVALID", "articleId 无效", 400);
    if (error instanceof Error && error.message === "ARTICLE_NOT_FOUND") return failure("ARTICLE_NOT_FOUND", "没有找到这篇语料", 404);
    if (error instanceof Error && error.message === "DETAIL_TOO_LARGE") return failure("DETAIL_TOO_LARGE", "文章元数据响应超过安全上限", 413);
    return failure("CORPUS_READ_FAILED", "语料分类或开发树读取失败", 500);
  }
}

export async function POST() {
  return failure("READ_ONLY", "生成语料、分类和开发树是只读投影，不能通过此接口修改", 405);
}
