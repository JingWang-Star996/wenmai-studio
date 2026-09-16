import assert from "node:assert/strict";
import test from "node:test";

import {
  canonicalProjectGroupTopology,
  canonicalProjectGroupTopologyJson,
  isProjectGroupDag,
  wouldIntroduceProjectGroupCycle,
} from "../app/project-group-model.ts";

test("ProjectGroup 拓扑序列化稳定且只保留图字段", () => {
  const input = {
    groupId: "group-b",
    members: [
      { articleId: "article-b", articleProjectId: "project-b", ignored: true },
      { articleId: "article-a", articleProjectId: "project-a" },
    ],
    edges: [
      { sourceArticleId: "article-b", targetArticleId: "article-c", relationType: "precedes" },
      { sourceArticleId: "article-a", targetArticleId: "article-b", relationType: "precedes" },
    ],
  };
  assert.deepEqual(canonicalProjectGroupTopology(input), {
    schemaVersion: "wenmai.project-group-topology/1",
    groupId: "group-b",
    members: [
      { articleId: "article-a", articleProjectId: "project-a" },
      { articleId: "article-b", articleProjectId: "project-b" },
    ],
    edges: [
      { sourceArticleId: "article-a", targetArticleId: "article-b", relationType: "precedes" },
      { sourceArticleId: "article-b", targetArticleId: "article-c", relationType: "precedes" },
    ],
  });
  assert.equal(
    canonicalProjectGroupTopologyJson(input),
    canonicalProjectGroupTopologyJson({
      ...input,
      members: [...input.members].reverse(),
      edges: [...input.edges].reverse(),
    }),
  );
});
test("ProjectGroup DAG 判定拒绝自环和闭环", () => {
  const chain = [
    { sourceArticleId: "a", targetArticleId: "b", relationType: "precedes" },
    { sourceArticleId: "b", targetArticleId: "c", relationType: "precedes" },
  ];
  assert.equal(isProjectGroupDag(chain), true);
  assert.equal(wouldIntroduceProjectGroupCycle(chain, "c", "a"), true);
  assert.equal(wouldIntroduceProjectGroupCycle(chain, "a", "c"), false);
  assert.equal(wouldIntroduceProjectGroupCycle(chain, "a", "a"), true);
  assert.equal(isProjectGroupDag([...chain, { sourceArticleId: "c", targetArticleId: "a", relationType: "precedes" }]), false);
});
