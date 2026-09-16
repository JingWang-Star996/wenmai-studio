type PathEvidence = { path?: unknown; pathAliases?: unknown[] };

type CorpusVersion = PathEvidence & { id: string };
type CorpusArticle = { representativeVersionId: string; currentVersionId: string; versions: CorpusVersion[] };
type GraphNode = { id: string; type: string };
type GraphEdge = { source: string; target: string };
type CorpusGraph<Node extends GraphNode, Edge extends GraphEdge> = { nodes: Node[]; edges: Edge[] };
type CapabilityMaterial = PathEvidence & { locator?: unknown };
type Capability<Material extends CapabilityMaterial> = PathEvidence & { entryPath?: unknown; materials?: Material[] };

function strings(values: unknown[]) {
  return values.filter((value): value is string => typeof value === "string" && value.trim().length > 0);
}

export function isArchivedSkillUpdatePath(value: string | null | undefined) {
  return (value ?? "").split(/[\\/]+/).some((segment) => {
    const normalized = segment.toLocaleLowerCase("en-US");
    return normalized === "_skill_updates" || normalized === "_archive" || normalized === "archive" || normalized === "archived";
  });
}

export function hasOperativePath(evidence: PathEvidence & { locator?: unknown }) {
  const paths = strings([evidence.path, evidence.locator, ...(Array.isArray(evidence.pathAliases) ? evidence.pathAliases : [])]);
  return paths.length > 0 && paths.every((path) => !isArchivedSkillUpdatePath(path));
}

export function isOperativeCorpusVersion(version: CorpusVersion) {
  return hasOperativePath(version);
}

export function articleForOperativeKnowledge<Article extends CorpusArticle>(article: Article): Article | null {
  const operativeVersions = article.versions.filter(isOperativeCorpusVersion);
  if (!operativeVersions.length) return null;
  const representativeVersionId = operativeVersions.some((version) => version.id === article.representativeVersionId)
    ? article.representativeVersionId
    : operativeVersions.find((version) => version.id === article.currentVersionId)?.id ?? operativeVersions[0].id;
  const currentVersionId = operativeVersions.some((version) => version.id === article.currentVersionId)
    ? article.currentVersionId
    : representativeVersionId;
  return { ...article, representativeVersionId, currentVersionId, versions: operativeVersions };
}

export function filterOperativeArticleIds(articleIds: string[], operativeArticleIds: ReadonlySet<string>, allowedArticleIds?: readonly string[]) {
  return articleIds.filter((articleId) => operativeArticleIds.has(articleId)
    && (!allowedArticleIds || allowedArticleIds.includes("*") || allowedArticleIds.includes(articleId)));
}

export function projectOperativeGraph<Node extends GraphNode, Edge extends GraphEdge>(
  graph: CorpusGraph<Node, Edge>,
  operativeArticleIds: ReadonlySet<string>,
) {
  const nodes = graph.nodes.filter((node) => node.type !== "article" || operativeArticleIds.has(node.id));
  const nodeIds = new Set(nodes.map((node) => node.id));
  return { nodes, edges: graph.edges.filter((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target)) };
}

export function materialForOperativeCapability<Material extends CapabilityMaterial>(material: Material): Material | null {
  return hasOperativePath(material) ? material : null;
}

export function capabilityForOperativeRetrieval<IndexedCapability extends Capability<Material>, Material extends CapabilityMaterial>(
  capability: IndexedCapability,
): (IndexedCapability & { materials: Material[] }) | null {
  if (!hasOperativePath({ path: capability.entryPath, pathAliases: capability.pathAliases })) return null;
  const materials = (capability.materials ?? [])
    .map(materialForOperativeCapability)
    .filter((material): material is Material => material !== null);
  return { ...capability, materials };
}
