export const PROJECT_GROUP_TOPOLOGY_SCHEMA = "wenmai.project-group-topology/1" as const;

export type ProjectGroupMemberTopology = { articleId: string; articleProjectId: string };
export type ProjectGroupEdgeTopology = { sourceArticleId: string; targetArticleId: string; relationType: "precedes" };

export type ProjectGroupTopology = {
  schemaVersion: typeof PROJECT_GROUP_TOPOLOGY_SCHEMA;
  groupId: string;
  members: ProjectGroupMemberTopology[];
  edges: ProjectGroupEdgeTopology[];
};

function compare(a: string, b: string) { return a < b ? -1 : a > b ? 1 : 0; }

/** The wire hash is intentionally a boring JSON.stringify of this exact shape. */
export function canonicalProjectGroupTopology(input: {
  groupId: string;
  members: readonly ProjectGroupMemberTopology[];
  edges: readonly ProjectGroupEdgeTopology[];
}): ProjectGroupTopology {
  return {
    schemaVersion: PROJECT_GROUP_TOPOLOGY_SCHEMA,
    groupId: input.groupId,
    members: [...input.members]
      .map(({ articleId, articleProjectId }) => ({ articleId, articleProjectId }))
      .sort((a, b) => compare(a.articleId, b.articleId) || compare(a.articleProjectId, b.articleProjectId)),
    edges: [...input.edges]
      .map(({ sourceArticleId, targetArticleId, relationType }) => ({ sourceArticleId, targetArticleId, relationType }))
      .sort((a, b) => compare(a.sourceArticleId, b.sourceArticleId) || compare(a.targetArticleId, b.targetArticleId) || compare(a.relationType, b.relationType)),
  };
}

export function canonicalProjectGroupTopologyJson(input: Parameters<typeof canonicalProjectGroupTopology>[0]) {
  return JSON.stringify(canonicalProjectGroupTopology(input));
}

/** Returns true when the candidate source -> target would introduce any cycle. */
export function wouldIntroduceProjectGroupCycle(
  edges: readonly ProjectGroupEdgeTopology[], sourceArticleId: string, targetArticleId: string,
) {
  if (sourceArticleId === targetArticleId) return true;
  const outgoing = new Map<string, string[]>();
  for (const edge of edges) {
    const values = outgoing.get(edge.sourceArticleId) ?? [];
    values.push(edge.targetArticleId);
    outgoing.set(edge.sourceArticleId, values);
  }
  const seen = new Set<string>();
  const pending = [targetArticleId];
  while (pending.length) {
    const current = pending.pop()!;
    if (current === sourceArticleId) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    pending.push(...(outgoing.get(current) ?? []));
  }
  return false;
}

export function isProjectGroupDag(edges: readonly ProjectGroupEdgeTopology[]) {
  return !edges.some((edge, index) => wouldIntroduceProjectGroupCycle(edges.filter((_, i) => i !== index), edge.sourceArticleId, edge.targetArticleId));
}
