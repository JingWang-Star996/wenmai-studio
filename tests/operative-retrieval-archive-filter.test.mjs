import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  articleForOperativeKnowledge,
  capabilityForOperativeRetrieval,
  filterOperativeArticleIds,
  hasOperativePath,
  isArchivedSkillUpdatePath,
  projectOperativeGraph,
} from "../app/operative-retrieval.ts";

const agentRoute = readFileSync(new URL("../app/api/agent/v1/route.ts", import.meta.url), "utf8");
const capabilitiesRoute = readFileSync(new URL("../app/api/capabilities/route.ts", import.meta.url), "utf8");

test("归档路径按段落、大小写和 Windows/POSIX 分隔符识别", () => {
  for (const value of [
    "_skill_updates/current.md",
    "C:\\work\\_SKILL_UPDATES\\history\\skill.md",
    "/workspace/_Skill_Updates/history/skill.md",
  ]) assert.equal(isArchivedSkillUpdatePath(value), true, value);
  assert.equal(isArchivedSkillUpdatePath("C:\\Users\\example\\.codex\\skills\\current\\SKILL.md"), false);
  assert.equal(isArchivedSkillUpdatePath("/workspace/skill_updates/current.md"), false);
  assert.equal(hasOperativePath({ path: undefined, pathAliases: [] }), false, "缺失路径默认 fail-closed");
  assert.equal(hasOperativePath({ path: "C:\\Users\\example\\.codex\\skills\\current\\SKILL.md", pathAliases: ["_skill_updates\\old\\SKILL.md"] }), false);
  assert.equal(hasOperativePath({ path: "C:\\Users\\example\\.codex\\skills\\current\\SKILL.md", pathAliases: [] }), true);
  assert.match(agentRoute, /from "\.\.\/\.\.\/\.\.\/operative-retrieval"/);
  assert.match(capabilitiesRoute, /from "\.\.\/\.\.\/operative-retrieval"/);
});

test("知识投影排除 archived-only 文章，并从混合文章选择非归档代表版本", () => {
  const archivedOnly = articleForOperativeKnowledge({
    representativeVersionId: "archived", currentVersionId: "archived",
    versions: [{ id: "archived", path: "_skill_updates/old.md", pathAliases: ["C:\\repo\\_skill_updates\\old.md"] }],
  });
  assert.equal(archivedOnly, null);

  const mixed = articleForOperativeKnowledge({
    representativeVersionId: "archived", currentVersionId: "archived",
    versions: [
      { id: "archived", path: "_skill_updates/old.md", pathAliases: [] },
      { id: "current", path: "C:\\Users\\example\\.codex\\skills\\current\\SKILL.md", pathAliases: [] },
    ],
  });
  assert.equal(mixed?.representativeVersionId, "current");
  assert.equal(mixed?.currentVersionId, "current");

  const normal = articleForOperativeKnowledge({
    representativeVersionId: "current", currentVersionId: "current",
    versions: [{ id: "current", path: "articles/current.md", pathAliases: [] }],
  });
  assert.equal(normal?.representativeVersionId, "current");
  const aliasArchived = articleForOperativeKnowledge({
    representativeVersionId: "alias-archived", currentVersionId: "alias-archived",
    versions: [{ id: "alias-archived", path: "C:\\Users\\example\\.codex\\skills\\current\\SKILL.md", pathAliases: ["_skill_updates/old/SKILL.md"] }],
  });
  assert.equal(aliasArchived, null);
  assert.deepEqual(mixed?.versions.map((version) => version.id), ["current"]);
  assert.match(agentRoute, /const operativeArticles = indexedCorpus\.articles[\s\S]*\.map\(articleForOperativeKnowledge\)/);
});

test("能力目录默认排除 archived workflow，保留 canonical Skill", () => {
  const entries = [
    "C:\\workspace\\_skill_updates\\old\\workflow.md",
    "C:\\Users\\example\\.codex\\skills\\write-experience-led-knowledge-article\\SKILL.md",
  ];
  const capability = capabilityForOperativeRetrieval({
    entryPath: entries[1], pathAliases: [],
    materials: [
      { id: "archived", locator: "E:\\work\\_skill_updates\\old.md", pathAliases: [] },
      { id: "unknown", locator: "", pathAliases: [] },
      { id: "current", locator: "C:\\Users\\example\\.codex\\skills\\current\\reference.md", pathAliases: [] },
      { id: "alias-archived", locator: "C:\\Users\\example\\.codex\\skills\\current\\alias.md", pathAliases: ["/archive/alias.md"] },
    ],
  });
  assert.deepEqual(capability?.materials.map((material) => material.id), ["current"]);
  assert.equal(capabilityForOperativeRetrieval({ entryPath: entries[0], materials: [] }), null);
  assert.match(capabilitiesRoute, /\.map\(capabilityForOperativeRetrieval\)/);
  assert.match(capabilitiesRoute, /hasOperativePath\(\{ path: auditCandidate\.canonicalEntry \}\)/);
});

test("知识 topic 复用 operative 文章集合，并与 Agent 授权边界叠加", () => {
  const topic = { label: "Skill", articleIds: ["archived-only", "mixed-current", "ordinary"] };
  const operativeArticleIds = new Set(["mixed-current", "ordinary"]);
  assert.deepEqual(filterOperativeArticleIds(topic.articleIds, operativeArticleIds), ["mixed-current", "ordinary"]);
  assert.deepEqual(filterOperativeArticleIds(topic.articleIds, operativeArticleIds, ["mixed-current"]), ["mixed-current"]);
  assert.deepEqual(filterOperativeArticleIds(["archived-only"], operativeArticleIds), []);
  assert.match(agentRoute, /const operativeArticleIds = new Set\(operativeArticles\.map\(\(article\) => article\.id\)\)/);
  assert.match(agentRoute, /filterOperativeArticleIds\(topic\.articleIds, operativeArticleIds, auth\?\.articleIds\)/);
  assert.match(agentRoute, /\.filter\(\(topic\) => topic\.articleIds\.length > 0\)/);
});

test("operative graph 排除 archived/unknown article 节点及其边，direct ID 复用同一集合", () => {
  const graph = projectOperativeGraph({
    nodes: [
      { id: "current", type: "article" },
      { id: "archived", type: "article" },
      { id: "unknown", type: "article" },
      { id: "topic", type: "topic" },
    ],
    edges: [
      { source: "current", target: "topic" },
      { source: "archived", target: "topic" },
      { source: "unknown", target: "topic" },
    ],
  }, new Set(["current"]));
  assert.deepEqual(graph.nodes.map((node) => node.id), ["current", "topic"]);
  assert.deepEqual(graph.edges, [{ source: "current", target: "topic" }]);
  assert.match(agentRoute, /const operativeGraph = projectOperativeGraph\(indexedCorpus\.graph, operativeArticleIds\)/);
  assert.match(agentRoute, /const article = operativeArticles\.find\(\(item\) => item\.id === articleId\)/);
  assert.match(agentRoute, /const known = new Set\(operativeArticleIds\)/);
  assert.match(agentRoute, /SELECT DISTINCT article_id FROM \$\{table\} WHERE status = \?/);
  assert.match(agentRoute, /\["article_branches", "active"\].*\["article_project_packages", "active"\]/s);
});
