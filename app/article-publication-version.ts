export const ARTICLE_PUBLICATION_VERSION_SCHEMA_VERSION = "wenmai.article-publication-version/1.0.0";

export const ARTICLE_PUBLICATION_PLATFORMS = [
  "maimai",
  "xiaohongshu",
  "zhihu",
  "bilibili",
] as const;

export type ArticlePublicationPlatform = typeof ARTICLE_PUBLICATION_PLATFORMS[number];
export type ArticlePublicationVersionKey = "canonical" | ArticlePublicationPlatform;

const PLATFORM_SET = new Set<string>(ARTICLE_PUBLICATION_PLATFORMS);
const SHA256_RE = /^[a-f0-9]{64}$/u;

export const ARTICLE_PUBLICATION_TARGET_PROFILE_KEYS: Readonly<Record<ArticlePublicationPlatform, string>> = Object.freeze({
  maimai: "maimai.community-post",
  xiaohongshu: "xiaohongshu.article",
  zhihu: "zhihu.article",
  bilibili: "bilibili.article",
});

export interface ArticlePublicationBaselineBinding {
  branchId: string;
  revisionId: string;
  bodySha256: string;
  compositionId: string;
  compositionSha256: string;
}

export interface ArticlePublicationTargetBinding {
  id: string;
  profileKey: string;
  sha256: string;
}

export type ArticlePublicationVersion = {
  schemaVersion: typeof ARTICLE_PUBLICATION_VERSION_SCHEMA_VERSION;
  role: "canonical_baseline";
  versionKey: "canonical";
  platform: null;
  targetProfile: null;
  baseline: null;
  /** Optional only for historical read compatibility. New registrations enforce it at the route boundary. */
  semanticGate?: unknown;
} | {
  schemaVersion: typeof ARTICLE_PUBLICATION_VERSION_SCHEMA_VERSION;
  role: "platform_variant";
  versionKey: ArticlePublicationPlatform;
  platform: ArticlePublicationPlatform;
  targetProfile: ArticlePublicationTargetBinding;
  baseline: ArticlePublicationBaselineBinding;
  /** Hash-bound semantic continuity evidence, validated against the persisted body by registration/build routes. */
  semanticGate?: unknown;
};

export interface ArticlePublicationVersionValidationResult {
  valid: boolean;
  errors: string[];
  version: ArticlePublicationVersion | null;
}

type PublicationVersionSnapshot = {
  id?: string;
  packageId?: string;
  articleId?: string;
  branchId: string;
  revisionId: string;
  bodySha256: string;
  compositionId: string;
  compositionSha256: string;
  publicationVersion: ArticlePublicationVersion;
};

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function sha256(value: unknown): string {
  return text(value).toLowerCase();
}

function normalizeBaseline(value: unknown): ArticlePublicationBaselineBinding {
  const input = record(value);
  return {
    branchId: text(input.branchId),
    revisionId: text(input.revisionId),
    bodySha256: sha256(input.bodySha256),
    compositionId: text(input.compositionId),
    compositionSha256: sha256(input.compositionSha256),
  };
}

function normalizeTarget(value: unknown): ArticlePublicationTargetBinding {
  const input = record(value);
  return {
    id: text(input.id),
    profileKey: text(input.profileKey),
    sha256: sha256(input.sha256),
  };
}

function requireIdentity(errors: string[], value: string, label: string) {
  if (!value) errors.push(`缺少 ${label}`);
}

function requireSha(errors: string[], value: string, label: string) {
  if (!SHA256_RE.test(value)) errors.push(`${label} 必须是 64 位小写 SHA-256`);
}

export function validateArticlePublicationVersion(input: unknown): ArticlePublicationVersionValidationResult {
  const source = record(input);
  const errors: string[] = [];
  const schemaVersion = text(source.schemaVersion);
  const role = text(source.role);
  const versionKey = text(source.versionKey);
  const platformText = source.platform === null ? null : text(source.platform);

  if (schemaVersion !== ARTICLE_PUBLICATION_VERSION_SCHEMA_VERSION) {
    errors.push(`schemaVersion 必须是 ${ARTICLE_PUBLICATION_VERSION_SCHEMA_VERSION}`);
  }

  if (role === "canonical_baseline") {
    if (versionKey !== "canonical") errors.push("canonical_baseline 的 versionKey 必须是 canonical");
    if (source.platform !== null) errors.push("canonical_baseline 的 platform 必须显式为 null");
    if (source.targetProfile !== null) errors.push("canonical_baseline 的 targetProfile 必须显式为 null");
    if (source.baseline !== null) errors.push("canonical_baseline 的 baseline 必须显式为 null");
    const version: ArticlePublicationVersion = {
      schemaVersion: ARTICLE_PUBLICATION_VERSION_SCHEMA_VERSION,
      role: "canonical_baseline",
      versionKey: "canonical",
      platform: null,
      targetProfile: null,
      baseline: null,
      ...(source.semanticGate === undefined ? {} : { semanticGate: source.semanticGate }),
    };
    return { valid: errors.length === 0, errors, version: errors.length === 0 ? version : null };
  }

  if (role !== "platform_variant") errors.push("role 只能是 canonical_baseline 或 platform_variant");
  if (!platformText || !PLATFORM_SET.has(platformText)) errors.push("platform 只能是 maimai、xiaohongshu、zhihu 或 bilibili");
  if (versionKey !== platformText) errors.push("platform_variant 的 versionKey 必须与 platform 完全一致");

  const targetProfile = normalizeTarget(source.targetProfile);
  const baseline = normalizeBaseline(source.baseline);
  requireIdentity(errors, targetProfile.id, "targetProfile.id");
  requireIdentity(errors, targetProfile.profileKey, "targetProfile.profileKey");
  requireSha(errors, targetProfile.sha256, "targetProfile.sha256");
  requireIdentity(errors, baseline.branchId, "baseline.branchId");
  requireIdentity(errors, baseline.revisionId, "baseline.revisionId");
  requireSha(errors, baseline.bodySha256, "baseline.bodySha256");
  requireIdentity(errors, baseline.compositionId, "baseline.compositionId");
  requireSha(errors, baseline.compositionSha256, "baseline.compositionSha256");

  if (platformText && PLATFORM_SET.has(platformText)) {
    const platform = platformText as ArticlePublicationPlatform;
    if (targetProfile.profileKey !== ARTICLE_PUBLICATION_TARGET_PROFILE_KEYS[platform]) {
      errors.push(`targetProfile.profileKey 与 ${platform} 正式文章目标不匹配`);
    }
  }

  if (errors.length > 0 || !platformText || !PLATFORM_SET.has(platformText)) {
    return { valid: false, errors, version: null };
  }
  const platform = platformText as ArticlePublicationPlatform;
  return {
    valid: true,
    errors: [],
    version: {
      schemaVersion: ARTICLE_PUBLICATION_VERSION_SCHEMA_VERSION,
      role: "platform_variant",
      versionKey: platform,
      platform,
      targetProfile,
      baseline,
      ...(source.semanticGate === undefined ? {} : { semanticGate: source.semanticGate }),
    },
  };
}

export function publicationVersionFromDocument(document: unknown): ArticlePublicationVersionValidationResult {
  const metadata = record(record(document).metadata);
  return validateArticlePublicationVersion(metadata.publicationVersion);
}

export function validateArticlePublicationVersionSet(input: readonly PublicationVersionSnapshot[]) {
  const errors: string[] = [];
  const requiredVersionKeys: readonly ArticlePublicationVersionKey[] = [
    "canonical",
    ...ARTICLE_PUBLICATION_PLATFORMS,
  ];
  const canonical = input.filter((item) => item.publicationVersion.role === "canonical_baseline");
  if (canonical.length !== 1) errors.push("同一 Article 必须恰好有一个 current canonical baseline");
  const keys = new Set<string>();
  const branches = new Set<string>();
  for (const item of input) {
    const key = item.publicationVersion.versionKey;
    if (keys.has(key)) errors.push(`publication versionKey 重复：${key}`);
    keys.add(key);
    if (branches.has(item.branchId)) errors.push(`同一分支不能注册多个 current publication version：${item.branchId}`);
    branches.add(item.branchId);
  }
  const baseline = canonical[0];
  if (baseline) {
    for (const item of input) {
      if (item.publicationVersion.role !== "platform_variant") continue;
      const binding = item.publicationVersion.baseline;
      if (binding.branchId !== baseline.branchId
        || binding.revisionId !== baseline.revisionId
        || binding.bodySha256 !== baseline.bodySha256
        || binding.compositionId !== baseline.compositionId
        || binding.compositionSha256 !== baseline.compositionSha256) {
        errors.push(`${item.publicationVersion.versionKey} 未绑定当前 canonical baseline`);
      }
    }
  }
  const missingVersionKeys = requiredVersionKeys.filter((key) => !keys.has(key));
  return {
    valid: errors.length === 0,
    errors,
    complete: errors.length === 0 && missingVersionKeys.length === 0,
    missingVersionKeys,
    canonical: baseline ?? null,
    variants: Object.fromEntries(input
      .filter((item) => item.publicationVersion.role === "platform_variant")
      .map((item) => [item.publicationVersion.versionKey, item])),
  };
}
