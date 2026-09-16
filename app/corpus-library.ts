import type { CorpusData } from "./types";
import type { WorkbenchArticle, WorkbenchArticleRelation, WorkbenchCorpus } from "./workbench-types";

const INITIAL_LIBRARY_LIMIT = 12;

function articleRelationsForSeed(corpus: CorpusData, articleIds: Set<string>): WorkbenchArticleRelation[] {
  const articleIdsByArtifact = new Map(corpus.artifacts.map((artifact) => [artifact.id, artifact.articleIds]));
  const projected = new Map<string, WorkbenchArticleRelation>();
  for (const edge of corpus.developmentTree.edges) {
    const sourceArticleIds = (articleIdsByArtifact.get(edge.source) ?? []).filter((id) => articleIds.has(id));
    const targetArticleIds = (articleIdsByArtifact.get(edge.target) ?? []).filter((id) => articleIds.has(id));
    for (const sourceArticleId of sourceArticleIds) for (const targetArticleId of targetArticleIds) {
      if (sourceArticleId === targetArticleId) continue;
      const key = `${sourceArticleId}:${targetArticleId}:${edge.relationType}:${edge.status}`;
      const existing = projected.get(key);
      if (existing) existing.evidenceRefs = [...new Set([...existing.evidenceRefs, ...edge.evidenceRefs])];
      else projected.set(key, { id: `article-relation:${edge.id}`, sourceArticleId, targetArticleId, relationType: edge.relationType, status: edge.status, confidence: edge.confidence, basis: edge.basis, evidenceRefs: [...edge.evidenceRefs], sourceArtifactId: edge.source, targetArtifactId: edge.target });
    }
  }
  return [...projected.values()].sort((left, right) => left.status.localeCompare(right.status) || left.relationType.localeCompare(right.relationType) || left.sourceArticleId.localeCompare(right.sourceArticleId) || left.targetArticleId.localeCompare(right.targetArticleId));
}

export function workbenchArticleDetail(article: CorpusData["articles"][number]): WorkbenchArticle {
  return { id: article.id, title: article.title, canonicalTitle: article.canonicalTitle, kind: article.kind, summary: article.summary, tags: article.tags, platforms: article.platforms, updatedAt: article.updatedAt, representativeVersionId: article.representativeVersionId, currentVersionId: article.currentVersionId, versionCount: article.versionCount, identityStatus: article.identityStatus, identityConfidence: article.identityConfidence, publicationState: article.publicationState, evidenceHealth: article.evidenceHealth, editorialState: article.editorialState, classification: article.classification, versions: article.versions.map((version) => ({ id: version.id, name: version.name, path: version.path, pathAliases: version.pathAliases, role: version.role, format: version.format, modifiedAt: version.modifiedAt, textHash: version.textHash, charCount: version.charCount, excerpt: version.excerpt, metrics: version.metrics, classification: version.classification })), baseline: article.baseline };
}

function seedArticle(article: CorpusData["articles"][number]): WorkbenchArticle {
  const version = article.versions.find((item) => item.id === article.currentVersionId) ?? article.versions.find((item) => item.id === article.representativeVersionId) ?? article.versions[0];
  return { ...workbenchArticleDetail(article), versions: version ? [{ id: version.id, name: version.name, path: version.path, pathAliases: version.pathAliases, role: version.role, format: version.format, modifiedAt: version.modifiedAt, textHash: version.textHash, charCount: version.charCount, excerpt: version.excerpt, metrics: version.metrics, classification: version.classification }] : [] };
}

/** 现有 Workbench 的轻量兼容 seed；完整目录经 library API 分页读取。 */
export function createWorkbenchCorpusSeed(corpus: CorpusData, limit = INITIAL_LIBRARY_LIMIT): WorkbenchCorpus {
  const articles = [...corpus.articles].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id)).slice(0, Math.min(INITIAL_LIBRARY_LIMIT, Math.max(1, limit))).map(seedArticle);
  return {
    schemaVersion: corpus.schemaVersion, algorithmVersion: corpus.algorithmVersion, generatedAt: corpus.generatedAt, sourceRootLabel: corpus.sourceRootLabel,
    stats: { sourceFiles: corpus.stats.sourceFiles, articleFamilies: corpus.stats.articleFamilies, contentFamilies: corpus.stats.contentFamilies, opportunityCount: corpus.stats.opportunityCount, topicCount: corpus.stats.topicCount, classificationCounts: corpus.stats.classificationCounts, developmentTreeNodes: corpus.stats.developmentTreeNodes, developmentTreeEdges: corpus.stats.developmentTreeEdges, confirmedDevelopmentEdges: corpus.stats.confirmedDevelopmentEdges, suggestedDevelopmentEdges: corpus.stats.suggestedDevelopmentEdges },
    classification: { schemaVersion: corpus.classification.schemaVersion, ruleVersion: corpus.classification.ruleVersion, classes: corpus.classification.classes, counts: corpus.classification.counts, policy: corpus.classification.policy },
    developmentTree: { schemaVersion: corpus.developmentTree.schemaVersion, ruleVersion: corpus.developmentTree.ruleVersion, relationTypes: corpus.developmentTree.relationTypes, counts: corpus.developmentTree.counts, notes: corpus.developmentTree.notes },
    articles, articleRelations: articleRelationsForSeed(corpus, new Set(articles.map((article) => article.id))), topics: [], opportunities: [], seriesSuggestions: [],
  };
}
