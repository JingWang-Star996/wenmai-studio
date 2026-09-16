import type { CapabilityRecord } from "./workbench-types";
import type { PlatformTargetRecord } from "./lifecycle-types";

export type PlatformContentKind = "article" | "video";

export const PLATFORM_ALIAS_GROUPS = [
  { id: "xiaohongshu", aliases: ["xiaohongshu", "小红书", "xhs"] },
  { id: "bilibili", aliases: ["bilibili", "哔哩哔哩", "哔哩", "b站"] },
  { id: "zhihu", aliases: ["zhihu", "知乎"] },
  { id: "maimai", aliases: ["maimai", "脉脉"] },
  { id: "wechat", aliases: ["wechat", "微信", "公众号"] },
  { id: "douyin", aliases: ["douyin", "抖音"] },
  { id: "website", aliases: ["website", "网站", "sites", "static web"] },
] as const;

const ARTICLE_RELEASE_SIGNAL = /(article|writing|editor|publish|release|content package|markdown|docx|cover|copy|natural chinese|文章|写作|编辑|发布|发行|封面|标题|文案|中文|排版|内容包装|审校)/i;
const ARTICLE_EXPLICIT_SIGNAL = /(article|writing|markdown|docx|long[- ]article|文章|写作|专栏|长文)/i;
const VIDEO_RELEASE_SIGNAL = /(video|motion|ffmpeg|transcod|playback|frame|视频|影像|转码|播放|逐帧|镜头)/i;
const GENERIC_TOOL_EXCLUSION = /(lark[-:]|attendance|calendar|mail|meeting|minutes|okr|approval|contact|drive|sheets|slides|whiteboard|windows|music|audio|3d|tripo|toy|game|weather|finance|repair|browser|chrome|computer-use)/i;

function cleanObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function capabilityHaystack(capability: CapabilityRecord) {
  return [capability.name, capability.description, capability.id, capability.dimension, ...capability.tags].join(" ").toLowerCase();
}

export function platformTargetContentKind(target: PlatformTargetRecord): PlatformContentKind {
  const mediaKind = cleanObject(target.profile).mediaKind;
  return mediaKind === "video" || target.profileKey.endsWith(".video") ? "video" : "article";
}

function matchesContentKind(haystack: string, contentKind: PlatformContentKind) {
  const video = VIDEO_RELEASE_SIGNAL.test(haystack);
  const article = ARTICLE_EXPLICIT_SIGNAL.test(haystack);
  if (contentKind === "video") return video && !(article && !video);
  return !video;
}

export function platformCapabilitiesForTarget(
  capabilities: readonly CapabilityRecord[],
  target: PlatformTargetRecord,
  selectedSkillIds: readonly string[] = [],
  queryValue = "",
) {
  const identity = [target.platform, target.label, target.profileKey].join(" ").toLowerCase();
  const selectedAliasGroup = PLATFORM_ALIAS_GROUPS.find((group) => group.aliases.some((alias) => identity.includes(alias)));
  const contentKind = platformTargetContentKind(target);
  const customAliases = [target.platform, target.label, target.profileKey.split(".")[0]]
    .map((item) => item.trim().toLowerCase())
    .filter((item) => item.length > 1 && !["manual", "article", "video", "content", "platform", "long-article"].includes(item));
  const directAliases = [...new Set([...(selectedAliasGroup?.aliases ?? []), ...customAliases])];
  const query = queryValue.trim().toLowerCase();
  const direct: CapabilityRecord[] = [];
  const generic: CapabilityRecord[] = [];

  for (const capability of capabilities) {
    if (capability.kind !== "skill") continue;
    const haystack = capabilityHaystack(capability);
    if (query && !haystack.includes(query)) continue;
    if (!matchesContentKind(haystack, contentKind)) continue;

    const directMatch = directAliases.some((alias) => haystack.includes(alias));
    if (directMatch) {
      direct.push(capability);
      continue;
    }

    const belongsToAnotherPlatform = PLATFORM_ALIAS_GROUPS.some((group) => group.id !== selectedAliasGroup?.id
      && group.aliases.some((alias) => haystack.includes(alias)));
    const releaseRelevant = capability.stages.some((stage) => ["review", "approved", "distribution", "maintain"].includes(stage));
    const dimensionRelevant = ["language", "visual", "quality", "packaging", "publishing"].includes(capability.dimension);
    const contentSignal = contentKind === "video" ? VIDEO_RELEASE_SIGNAL.test(haystack) : ARTICLE_RELEASE_SIGNAL.test(haystack);
    if (!belongsToAnotherPlatform && !GENERIC_TOOL_EXCLUSION.test(haystack) && contentSignal && (releaseRelevant || dimensionRelevant)) {
      generic.push(capability);
    }
  }

  const compare = (left: CapabilityRecord, right: CapabilityRecord) => Number(selectedSkillIds.includes(right.id))
    - Number(selectedSkillIds.includes(left.id)) || left.name.localeCompare(right.name, "zh-CN");
  return { contentKind, direct: direct.sort(compare), generic: generic.sort(compare) };
}
