import assert from "node:assert/strict";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Miniflare, NoOpLog, Request as MiniflareRequest } from "miniflare";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const origin = "http://[::1]:3000";

async function modules() {
  const staticPath = path.join(root, "dist", "server", "_next", "static");
  const sources = await Promise.all((await readdir(staticPath)).filter((name) => name.endsWith(".js")).map(async (name) => ({ name, contents: await readFile(path.join(staticPath, name), "utf8"), modified: await stat(path.join(staticPath, name)) })));
  const corpus = sources.find((source) => source.name.startsWith("route-") && source.contents.includes("wenmai.corpus-read-api/1.0"));
  assert.ok(corpus, "production dist 缺少 corpus route");
  assert.ok(corpus.modified.mtimeMs >= (await stat(path.join(root, "app/api/corpus/v1/route.ts"))).mtimeMs, "FRESH_BUILD_REQUIRED: corpus route 早于源文件");
  return [{ type: "ESModule", path: "corpus-detail-test-worker.mjs", contents: `import * as api from ${JSON.stringify(`./${corpus.name}`)};export default {fetch(request){const headers=new Headers(request.headers);headers.set('host','[::1]:3000');return api.GET(new Request(request,{headers}));}};` }, ...sources.map((source) => ({ type: "ESModule", path: source.name, contents: source.contents }))];
}

test("单篇 corpus detail 只返回元数据，严格拒绝无效与不存在 ID", async () => {
  const mf = new Miniflare({ modules: await modules(), compatibilityDate: "2026-05-15", compatibilityFlags: ["nodejs_compat"], publicUrl: origin, log: new NoOpLog() });
  try {
    const manifest = await mf.dispatchFetch(new MiniflareRequest(`${origin}/api/corpus/v1?view=manifest`, { headers: { host: "[::1]:3000" } }));
    const articles = JSON.parse(await readFile(path.join(root, "data", "corpus.generated.json"), "utf8")).articles;
    assert.ok(articles.length > 0, "corpus detail integration requires at least one synthetic or local article");
    const articleId = (await manifest.json()).data.corpus && articles.at(0).id;
    const response = await mf.dispatchFetch(new MiniflareRequest(`${origin}/api/corpus/v1?view=detail&articleId=${encodeURIComponent(articleId)}`, { headers: { host: "[::1]:3000" } }));
    const body = await response.json();
    assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(body.data.article.id, articleId); assert.ok(body.data.article.versions.length > 0); assert.equal(body.data.bodyTextIncluded, false);
    assert.equal(Object.hasOwn(body.data.article.versions[0], "text"), false);
    for (const badId of ["", "not found", "article-missing"]) {
      const bad = await mf.dispatchFetch(new MiniflareRequest(`${origin}/api/corpus/v1?view=detail&articleId=${encodeURIComponent(badId)}`, { headers: { host: "[::1]:3000" } }));
      assert.ok([400, 404].includes(bad.status));
    }
  } finally { await mf.dispose(); }
});
