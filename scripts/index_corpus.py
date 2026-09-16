from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
import statistics
import zipfile
from collections import Counter, defaultdict
from dataclasses import dataclass, replace
from datetime import datetime
from difflib import SequenceMatcher
from pathlib import Path
from typing import Any, Iterable
from xml.etree import ElementTree as ET


ALGORITHM_VERSION = "wenmai-indexer/1.4.1"
IDENTITY_RULE_VERSION = "wenmai-identity/1.3.0"
STATE_RULE_VERSION = "wenmai-state/1.3.0"
CLASSIFICATION_RULE_VERSION = "wenmai-corpus-classification/1.0.0"
DEVELOPMENT_TREE_RULE_VERSION = "wenmai-development-tree/1.2.0"
CONTENT_EXTENSIONS = {".md", ".txt", ".docx"}
EXCLUDED_DIRS = {
    ".wenmai-worktrees",
    ".git",
    ".next",
    ".vinext",
    ".wrangler",
    "node_modules",
    "wenmai-studio",
    "_graph_engineering_render",
    "skill-staging",
    "tools",
    "__pycache__",
}
GENERIC_STEMS = {"article", "readme", "index", "content", "正文", "文稿", "稿件"}
GENERIC_TITLES = {"目录", "正文", "前言", "序言", "摘要", "参考资料", "附录", "readme", "总报告", "index", "content"}
OPERATIONAL_GENERIC_TITLES = {
    "中文自然度扫描报告",
    "自然度扫描报告",
    "翻译腔扫描报告",
    "translationesereport",
    "qa总报告",
    "机器门禁汇总",
    "目视qa记录",
    "人工门禁记录",
    "人工门禁待签单",
    "代理零上下文冷读",
    "代理冷读状态",
    "docx逐页视觉验收",
    "发布信息",
    "视觉决策卡",
    "内容与实验卡",
}

CLASSIFICATION_CLASSES = (
    "published_article",
    "draft_or_intermediate",
    "platform_build",
    "import_artifact",
    "test_or_qa",
    "skill_summary_or_capability",
    "research_governance",
    "tool",
    "source_material",
    "manifest_or_metadata",
    "evidence",
    "catalog_only",
)

DEVELOPMENT_RELATION_TYPES = (
    "same_binary_as",
    "same_extracted_text_as",
    "path_alias_of",
    "artifact_of",
    "derived_from",
    "adapted_from",
    "split_from",
    "supersedes",
    "failed_predecessor",
    "extends_package",
    "packaged_as",
    "import_artifact_of",
    "qa_of",
    "evidence_for",
    "published_as",
    "summarizes",
    "references_capability",
    "parent_revision",
    "merge_parent",
    "restored_from",
    "baseline_of",
)

METADATA_SCALAR_KEYS = {
    "title", "platform", "status", "article_id", "source_article_id", "content_id",
    "package_id", "experiment_id", "version", "revision", "url", "public_url", "note_id",
    "published_at", "submitted_at", "verified_at", "updated_at", "created_at", "word_count",
    "verification_method", "public_verification_method", "method", "public_visibility",
    "backend_record", "backend_status", "publication_state", "platform_draft_state",
    "publication_authorized", "body_sha256", "docx_sha256", "cover_sha256", "artifact_sha256",
    "source_path", "artifact_path", "body_path", "docx_path", "file", "filename",
}

TAXONOMY: dict[str, tuple[str, ...]] = {
    "AI 创作": ("ai", "人工智能", "大模型", "生成式"),
    "Agent": ("agent", "智能体", "多智能体"),
    "Graph Engineering": ("graph engineering", "图工程", "graph", "图式工作流"),
    "游戏开发": ("游戏开发", "游戏制作", "游戏项目", "制作人", "game"),
    "知识管理": ("知识管理", "知识图谱", "知识库", "认知", "知识"),
    "Token": ("token", "上下文窗口", "上下文"),
    "工作流": ("workflow", "工作流", "流程", "门禁"),
    "提示词": ("prompt", "提示词", "超级提示词"),
    "内容创作": ("文章", "写作", "创作", "内容"),
    "个人影响力": ("个人影响力", "影响力", "采访"),
    "版本与证据": ("版本", "证据", "审计", "回执", "验收"),
    "多平台发布": ("小红书", "bilibili", "哔哩哔哩", "知乎", "发布"),
}

STOP_TERMS = {
    "我们", "你们", "他们", "一个", "一种", "这个", "那个", "这些", "那些",
    "什么", "怎么", "如何", "为什么", "可以", "需要", "通过", "以及", "如果",
    "但是", "因为", "所以", "对于", "进行", "已经", "没有", "不是", "就是",
    "文章", "内容", "版本", "发布", "完整", "最终", "详细", "当前", "项目",
}

ABSTRACT_SHELLS = (
    "赋能", "抓手", "闭环", "范式", "维度", "沉淀", "落地", "体系化",
    "方法论", "价值感", "生态位", "颗粒度", "全链路",
)

STAGE_RULES: dict[str, tuple[str, ...]] = {
    "为什么": ("为什么", "问题", "背景", "变化", "误区"),
    "是什么": ("是什么", "解释", "概念", "入门", "认识"),
    "怎么做": ("怎么", "如何", "实践", "启动", "提示词", "教程"),
    "真实案例": ("案例", "采访", "亲历", "项目", "制作人"),
    "失败复盘": ("失败", "踩坑", "教训", "反例", "复盘", "审计"),
    "治理与规模化": ("治理", "团队", "协作", "门禁", "系统化", "工程"),
}


def sha1_text(value: str) -> str:
    return hashlib.sha1(value.encode("utf-8", errors="ignore")).hexdigest()


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def clamp(value: float, lower: float = 0, upper: float = 100) -> int:
    return int(round(max(lower, min(upper, value))))


def normalize_whitespace(value: str) -> str:
    value = value.replace("\u3000", " ").replace("\r\n", "\n").replace("\r", "\n")
    value = re.sub(r"[ \t]+", " ", value)
    value = re.sub(r"\n{3,}", "\n\n", value)
    return value.strip()


def read_text_file(path: Path) -> str:
    raw = path.read_bytes()
    for encoding in ("utf-8-sig", "utf-8", "gb18030", "utf-16"):
        try:
            return raw.decode(encoding)
        except UnicodeDecodeError:
            continue
    return raw.decode("utf-8", errors="replace")


def read_docx(path: Path) -> str:
    try:
        with zipfile.ZipFile(path) as archive:
            xml = archive.read("word/document.xml")
    except (KeyError, zipfile.BadZipFile, OSError):
        return ""

    try:
        root = ET.fromstring(xml)
    except ET.ParseError:
        return ""

    paragraphs: list[str] = []
    for node in root.iter():
        if not node.tag.endswith("}p"):
            continue
        parts: list[str] = []
        for child in node.iter():
            if child.tag.endswith("}t") and child.text:
                parts.append(child.text)
            elif child.tag.endswith("}tab"):
                parts.append("\t")
            elif child.tag.endswith("}br"):
                parts.append("\n")
        paragraph = "".join(parts).strip()
        if paragraph:
            paragraphs.append(paragraph)
    return "\n\n".join(paragraphs)


def extract_text(path: Path) -> str:
    if path.suffix.lower() == ".docx":
        return normalize_whitespace(read_docx(path))
    return normalize_whitespace(read_text_file(path))


def clean_inline_markdown(value: str) -> str:
    value = re.sub(r"!\[[^\]]*\]\([^)]*\)", "", value)
    value = re.sub(r"\[([^\]]+)\]\([^)]*\)", r"\1", value)
    value = re.sub(r"[`*_>#~]", "", value)
    return normalize_whitespace(value)


def title_from_filename(path: Path) -> str:
    value = path.stem.strip()
    value = re.sub(r"^\d{1,3}[_\-.、 ]+", "", value)
    value = re.sub(
        r"(?:[_\- ]?(?:小红书|知乎|b站|bilibili|哔哩哔哩)?(?:发布版|发布稿|导入版|审稿版|审校版|定稿|备份|scrubbed|final|import))+$",
        "",
        value,
        flags=re.IGNORECASE,
    )
    value = re.sub(r"[_\-]+", " ", value).strip()
    return clean_inline_markdown(value).strip(" -—：:")


def is_generic_title(value: str) -> bool:
    normalized = re.sub(r"[^0-9a-z\u4e00-\u9fff]+", "", value.lower())
    return not normalized or normalized in GENERIC_TITLES


def is_identity_weak_title(value: str) -> bool:
    """Return titles that describe a reusable operation, not a target identity."""
    normalized = re.sub(r"[^0-9a-z\u4e00-\u9fff]+", "", value.lower())
    return is_generic_title(value) or normalized in OPERATIONAL_GENERIC_TITLES


def infer_title(path: Path, text: str) -> str:
    if path.suffix.lower() == ".md":
        match = re.search(r"(?m)^#\s+(.{2,160})$", text)
        if match:
            candidate = clean_inline_markdown(match.group(1)).strip(" -—：:")
            if candidate and not is_generic_title(candidate):
                return candidate
            filename_title = title_from_filename(path)
            if filename_title and not is_generic_title(filename_title):
                return filename_title

    stem = path.stem.strip()
    if stem.lower() in GENERIC_STEMS or stem.lower().endswith("import") or len(stem) < 4:
        for line in text.splitlines():
            candidate = clean_inline_markdown(line).strip(" -—：:")
            if 4 <= len(candidate) <= 120 and not is_generic_title(candidate):
                return candidate
    filename_title = title_from_filename(path)
    return filename_title if filename_title and not is_generic_title(filename_title) else clean_inline_markdown(stem).strip(" -—：:")


def normalize_title(title: str) -> str:
    value = title.lower()
    value = re.sub(r"20\d{2}[-_.年/]?\d{1,2}[-_.月/]?\d{0,2}日?", "", value)
    value = re.sub(r"(?<![a-z])v(?:er(?:sion)?)?\d+(?:\.\d+)*", "", value)
    value = re.sub(r"ext\d+", "", value)
    value = re.sub(
        r"小红书|b站|bilibili|哔哩哔哩|知乎|发布包|发布版|导入版|审稿包|"
        r"提词器(?:详细案例)?版|完整内容审计与拆稿建议|采访回复|游戏制作人王鲸|"
        r"最终版|定稿|完整稿|通用版|超级提示词|article|正文",
        "",
        value,
    )
    value = re.sub(r"[^0-9a-z\u4e00-\u9fff]+", "", value)
    return value or re.sub(r"\W+", "", title.lower())


def infer_platforms(path: Path, text: str) -> list[str]:
    filename = path.name.lower()
    filename_platforms: list[str] = []
    if "小红书" in filename or "xiaohongshu" in filename:
        filename_platforms.append("小红书")
    if "b站" in filename or "bilibili" in filename or "哔哩哔哩" in filename:
        filename_platforms.append("Bilibili")
    if "知乎" in filename or "zhihu" in filename:
        filename_platforms.append("知乎")
    if filename_platforms:
        return filename_platforms

    haystack = f"{path.parent.as_posix()} {text[:1200]}".lower()
    platforms: list[str] = []
    if "小红书" in haystack or "xiaohongshu" in haystack:
        platforms.append("小红书")
    if "b站" in haystack or "bilibili" in haystack or "哔哩哔哩" in haystack:
        platforms.append("Bilibili")
    if "知乎" in haystack or "zhihu" in haystack:
        platforms.append("知乎")
    if not platforms:
        platforms.append("源稿")
    return platforms


def infer_kind(path: Path, title: str) -> str:
    haystack = f"{path.as_posix()} {title}".lower()
    if any(term in haystack for term in (
        "readme", "说明", "流程总结", "审计", "分析", "报告", "建议",
        "回执", "验收", "门禁", "状态", "记录", "合同", "扫描", "manifest",
        "release_audit", "naturalness", "decision", "决策", "sop", "简报", "复盘",
        "索引", "审校表", "内参", "质量", "观测", "检查表",
    )):
        return "研究与治理"
    if any(term in haystack for term in ("采访回复", "采访稿", "source_audit", "原始材料", "素材")):
        return "来源材料"
    if any(term in haystack for term in ("提示词", "提词器")):
        return "创作工具"
    return "文章"


def infer_role(path: Path, title: str) -> str:
    haystack = f"{path.name} {title}".lower()
    if any(term in haystack for term in ("发布包", "发布版", "import", "已发布")):
        return "平台发布稿"
    if any(term in haystack for term in ("审稿", "审计", "qa", "校对")):
        return "审校稿"
    if any(term in haystack for term in ("最终", "定稿", "完整稿")):
        return "定稿"
    if any(term in haystack for term in ("采访", "source", "原始", "回复")):
        return "来源稿"
    if any(term in haystack for term in ("提词器", "提示词")):
        return "衍生工具稿"
    if re.search(r"(?:^|[_\-])v\d+", haystack):
        return "迭代稿"
    return "工作稿"


def role_rank(role: str) -> int:
    return {
        "平台发布稿": 60,
        "定稿": 50,
        "审校稿": 40,
        "迭代稿": 30,
        "工作稿": 20,
        "衍生工具稿": 15,
        "来源稿": 10,
    }.get(role, 0)


def infer_identity_confidence(group: list[Document]) -> tuple[str, list[str]]:
    canonical_keys = {document.canonical_key for document in group if document.canonical_key}
    metadata_titles = {str(document.metadata.get("title", "")).strip() for document in group if document.metadata.get("title")}
    explicit_ids = {
        str(document.metadata.get("article_id") or document.metadata.get("source_article_id") or "").strip()
        for document in group
        if document.metadata.get("article_id") or document.metadata.get("source_article_id")
    }
    reasons: list[str] = []
    isolated_auxiliary = any(requires_isolated_aux_identity(document) for document in group)
    if len(group) > 1:
        reasons.append(f"{len(group)} 个文件进入同一候选族")
    if isolated_auxiliary:
        reasons.append("通用 QA/运行报告标题不参与跨目标归组；身份绑定物理路径与 Artifact 哈希")
        if len({document.digest for document in group}) < len(group):
            reasons.append("同一二进制工件存在多个物理路径别名")
            return "中", reasons
        reasons.append("未找到可确认的被检目标关系，保留为独立 QA 工件")
        return "低", reasons
    if len(canonical_keys) == 1 and canonical_keys and not any(is_identity_weak_title(document.title) for document in group):
        reasons.append("非通用规范化标题一致")
    if metadata_titles:
        reasons.append("存在与正文精确绑定的结构化标题元数据")
    if len(explicit_ids) == 1 and explicit_ids:
        reasons.append("精确绑定元数据给出同一显式文章 ID")
        return "高", reasons
    if len({document.digest for document in group}) < len(group):
        reasons.append("含同一内容制品的路径别名")
    if len(group) > 1:
        reasons.append("自动归组仍是候选，需人工确认后才能成为正式文章身份")
        return "中", reasons
    reasons.append("单文件候选，尚未建立人工身份关系")
    return "低", reasons


def publication_state_for_metadata(fields: dict[str, Any]) -> tuple[str | None, str | None]:
    status = str(fields.get("status", "")).strip().lower()
    if re.search(r"not[_ -]?planned|unplanned|未规划", status):
        return "未规划", "结构化状态明确记录该版本×渠道尚未进入发布计划"
    if re.search(r"packaged|release[_ -]?ready|ready[_ -]?to[_ -]?publish|已打包|待发布成品", status):
        return "已打包", "结构化状态记录制品已进入发布包；不推出已提交、后台接受或公开可见"
    if re.search(r"not[_ -]?published|unpublished|pending|draft|未发布|待发布", status):
        return "未发布记录", "结构化状态记录未发布或待处理"
    if re.search(r"published_publicly_verified|public(?:ly)?[_ -]?verified|public_verified", status):
        return "曾公开核验", "结构化状态记录历史公开核验；本次索引未重新访问公开页"
    if re.search(r"backend[_ -]?published|backend[_ -]?verified|published|已发布", status):
        return "有发布记录", "结构化状态记录发布或后台结果；不推出当前公开可见"
    if re.search(r"submitted|submission|sent|已提交", status):
        return "已提交", "结构化状态记录提交；不推出后台接受或公开可见"
    return None, None


def build_publication_variants(group: list[Document], path_to_version: dict[str, str]) -> list[dict[str, Any]]:
    rank = {"未记录": 0, "未规划": 0, "已打包": 1, "未发布记录": 1, "已提交": 2, "有发布记录": 3, "曾公开核验": 4}
    records: dict[tuple[str, str], dict[str, Any]] = {}
    for document in group:
        version_id = path_to_version[document.relative_path]
        platforms = [platform for platform in document.platforms if platform != "源稿"] or ["源稿"]
        for platform in platforms:
            key = (version_id, platform)
            candidate = records.setdefault(key, {
                "id": f"release-{sha1_text(version_id + ':' + platform)[:12]}",
                "versionId": version_id,
                "platform": platform,
                "state": "未记录",
                "evidence": [],
                "conflict": False,
            })
            for metadata_record in document.metadata_records:
                fields = metadata_record["fields"]
                exact_artifact_binding = any(
                    "精确匹配文件哈希" in reason or "精确匹配文件路径" in reason
                    for reason in metadata_record["bindingBasis"]
                )
                if exact_artifact_binding and fields.get("_publicationEligible") is False:
                    continue
                metadata_platform = str(fields.get("platform", "")).lower()
                if metadata_platform and platform != "源稿":
                    aliases = {
                        platform.lower(),
                        "b站" if platform == "Bilibili" else platform.lower(),
                        "bilibili" if platform == "Bilibili" else platform.lower(),
                        "xiaohongshu" if platform == "小红书" else platform.lower(),
                        "zhihu" if platform == "知乎" else platform.lower(),
                    }
                    if metadata_platform not in aliases:
                        continue
                reported_state, explanation = publication_state_for_metadata(fields)
                metadata_stem = Path(metadata_record["path"]).stem.lower()
                explicit_manifest_artifact = exact_artifact_binding and metadata_stem in {
                    "publish_manifest", "release_manifest", "package_manifest",
                }
                if not reported_state and explicit_manifest_artifact:
                    reported_state = "已打包"
                    explanation = "发布 manifest 明确列出该制品；不推出已提交、后台接受或公开可见"
                if not reported_state:
                    continue

                observed_at = str(fields.get("verified_at") or fields.get("published_at") or fields.get("updated_at") or "") or None
                url = str(fields.get("public_url") or fields.get("url") or "") or None
                verification_method = str(
                    fields.get("verification_method")
                    or fields.get("public_verification_method")
                    or fields.get("method")
                    or ""
                ) or None
                qualifies_for_rollup = exact_artifact_binding
                limitations: list[str] = []
                if not exact_artifact_binding:
                    limitations.append("未绑定当前制品的路径或哈希")
                if reported_state == "曾公开核验":
                    if not observed_at:
                        limitations.append("缺少核验时间")
                    if not verification_method:
                        limitations.append("缺少核验方法")
                    if not url:
                        limitations.append("缺少公开页 URL")
                    qualifies_for_rollup = qualifies_for_rollup and not limitations

                event_state = reported_state
                if not qualifies_for_rollup:
                    event_state = "历史状态线索（版本未锁定）"
                    explanation = f"原记录声称“{reported_state}”，但{'、'.join(limitations)}；仅保留为待复核线索"
                event = {
                    "id": f"pub-ev-{sha1_text(metadata_record['path'] + ':' + version_id + ':' + platform + ':' + reported_state)[:12]}",
                    "state": event_state,
                    "reportedState": reported_state,
                    "sourcePath": metadata_record["path"],
                    "bindingBasis": metadata_record["bindingBasis"],
                    "bindingStrength": "strong" if exact_artifact_binding else "weak",
                    "qualifiesForRollup": qualifies_for_rollup,
                    "observedAt": observed_at,
                    "verificationMethod": verification_method,
                    "url": url,
                    "explanation": explanation,
                }
                if event["id"] not in {item["id"] for item in candidate["evidence"]}:
                    candidate["evidence"].append(event)
                if qualifies_for_rollup and rank[reported_state] > rank[candidate["state"]]:
                    candidate["state"] = reported_state
    for candidate in records.values():
        observed_states = {
            item["reportedState"]
            for item in candidate["evidence"]
            if item["qualifiesForRollup"]
        }
        if "未发布记录" in observed_states and any(rank[state] >= 2 for state in observed_states):
            candidate["conflict"] = True
    return sorted(records.values(), key=lambda item: (item["platform"], item["versionId"]))


def infer_state_axes(group: list[Document], representative: Document, publication_variants: list[dict[str, Any]]) -> tuple[str, str, str, list[str]]:
    roles = {document.role for document in group}
    evidence: list[str] = []

    if representative.kind == "研究与治理":
        editorial_state = "已归档"
    elif representative.kind == "来源材料":
        editorial_state = "来源"
    elif representative.kind == "创作工具":
        editorial_state = "工具"
    elif "审校稿" in roles:
        editorial_state = "审校中"
    elif "定稿" in roles or "平台发布稿" in roles:
        editorial_state = "候选定稿"
    else:
        editorial_state = "创作中"

    states = {item["state"] for item in publication_variants if item["state"] != "未记录"}
    if not states:
        publication_state = "未记录"
    elif len(states) == 1:
        publication_state = next(iter(states))
    else:
        publication_state = "多状态（按版本×渠道）"

    bound_event_count = sum(
        1
        for item in publication_variants
        for event in item["evidence"]
        if event["qualifiesForRollup"]
    )
    clue_count = sum(
        1
        for item in publication_variants
        for event in item["evidence"]
        if not event["qualifiesForRollup"]
    )
    if any(item["conflict"] for item in publication_variants):
        evidence_health = "证据冲突"
        evidence.append("同一版本×渠道存在相互冲突的精确绑定状态")
    elif bound_event_count:
        evidence_health = "有精确绑定证据"
        evidence.append(f"{bound_event_count} 条发布事件按版本、渠道与制品路径/哈希精确绑定")
    elif clue_count:
        evidence_health = "存在弱线索"
        evidence.append(f"{clue_count} 条历史状态记录未锁定到当前制品或缺少公开核验要素")
    else:
        evidence_health = "未知"
        evidence.append("没有可绑定到本稿的发布证据；同目录元数据不会自动继承")
    return editorial_state, publication_state, evidence_health, evidence


def infer_tags(title: str, text: str, path: Path) -> list[str]:
    haystack = f"{title}\n{path.as_posix()}\n{text[:16000]}".lower()
    tags = [label for label, terms in TAXONOMY.items() if any(term in haystack for term in terms)]
    english = re.findall(r"\b[A-Z][A-Za-z0-9+.#-]{2,}(?:\s+[A-Z][A-Za-z0-9+.#-]{2,}){0,2}\b", text[:12000])
    counts = Counter(term.strip() for term in english if term.lower() not in {"the", "and", "this"})
    for term, _count in counts.most_common(3):
        if term.lower() not in {tag.lower() for tag in tags}:
            tags.append(term)
    return tags[:8]


def extract_entities(text: str, title: str) -> list[str]:
    quoted = re.findall(r"[“《]([^”》]{2,24})[”》]", text[:16000])
    english = re.findall(r"\b[A-Z][A-Za-z0-9+.#-]{2,}(?:\s+[A-Z][A-Za-z0-9+.#-]{2,}){0,2}\b", f"{title}\n{text[:16000]}")
    candidates = [clean_inline_markdown(item) for item in quoted + english]
    counts = Counter(item for item in candidates if item and item not in STOP_TERMS)
    return [item for item, _count in counts.most_common(10)]


def split_sentences(text: str) -> list[str]:
    return [item.strip() for item in re.split(r"(?<=[。！？!?；;])", text) if item.strip()]


def meaningful_length(text: str) -> int:
    chinese = len(re.findall(r"[\u4e00-\u9fff]", text))
    english = len(re.findall(r"\b[A-Za-z0-9]+\b", text))
    return chinese + english


def analyze_text(text: str, suffix: str) -> dict[str, Any]:
    paragraphs = [clean_inline_markdown(item) for item in re.split(r"\n\s*\n", text) if clean_inline_markdown(item)]
    sentences = split_sentences(clean_inline_markdown(text))
    sentence_lengths = [meaningful_length(item) for item in sentences if meaningful_length(item) > 0]
    avg_sentence = round(statistics.mean(sentence_lengths), 1) if sentence_lengths else 0
    long_sentence_ratio = round(
        sum(1 for length in sentence_lengths if length >= 46) / max(1, len(sentence_lengths)), 3
    )
    headings = len(re.findall(r"(?m)^#{1,4}\s+", text)) if suffix == ".md" else sum(
        1 for paragraph in paragraphs if 2 <= len(paragraph) <= 28 and not re.search(r"[。！？]$", paragraph)
    )
    urls = len(re.findall(r"https?://", text))
    numbers = len(re.findall(r"(?<!\w)\d+(?:\.\d+)?%?", text))
    quotes = len(re.findall(r"[“《][^”》]{2,80}[”》]", text))
    evidence_terms = len(re.findall(r"研究|数据|报告|来源|证据|引用|实验|统计|样本|回执", text))
    example_terms = len(re.findall(r"例如|比如|案例|亲历|当时|具体来说|以.{1,16}为例|我曾|我们曾", text))
    abstract_hits = sum(text.count(term) for term in ABSTRACT_SHELLS)
    chars = meaningful_length(text)
    paragraph_lengths = [meaningful_length(item) for item in paragraphs]
    avg_paragraph = round(statistics.mean(paragraph_lengths), 1) if paragraph_lengths else 0

    clarity = clamp(92 - max(0, avg_sentence - 30) * 1.25 - long_sentence_ratio * 42 - abstract_hits / max(1, chars) * 1200)
    structure = clamp(36 + min(headings, 10) * 5 + min(len(paragraphs), 24) * 1.2 - max(0, avg_paragraph - 260) * 0.08)
    evidence = clamp(18 + min(urls, 6) * 8 + min(numbers, 20) * 1.6 + min(quotes, 10) * 3 + min(evidence_terms, 30) * 1.1)
    specificity = clamp(22 + min(example_terms, 20) * 3.2 + min(numbers, 20) * 1.2 + min(quotes, 8) * 2.5 - abstract_hits * 0.7)

    return {
        "charCount": chars,
        "paragraphCount": len(paragraphs),
        "sentenceCount": len(sentences),
        "headingCount": headings,
        "averageSentenceLength": avg_sentence,
        "averageParagraphLength": avg_paragraph,
        "longSentenceRatio": long_sentence_ratio,
        "urlCount": urls,
        "numberMarkerCount": numbers,
        "quoteCount": quotes,
        "evidenceMarkerCount": evidence_terms,
        "exampleMarkerCount": example_terms,
        "abstractShellCount": abstract_hits,
        "scores": {
            "清晰度代理": clarity,
            "结构度代理": structure,
            "证据密度代理": evidence,
            "具体性代理": specificity,
        },
    }


def summarize(text: str, limit: int = 220) -> str:
    cleaned = clean_inline_markdown(re.sub(r"(?m)^#{1,6}\s+", "", text))
    cleaned = re.sub(r"\n+", " ", cleaned)
    return cleaned[:limit].rstrip("，。；; ") + ("…" if len(cleaned) > limit else "")


def safe_json_value(path: Path) -> dict[str, Any] | list[Any] | None:
    try:
        if path.stat().st_size > 2_000_000:
            return None
        value = json.loads(read_text_file(path))
        return value if isinstance(value, (dict, list)) else None
    except (OSError, json.JSONDecodeError, UnicodeDecodeError):
        return None


def safe_json(path: Path) -> dict[str, Any] | None:
    value = safe_json_value(path)
    return value if isinstance(value, dict) else None


def select_metadata(value: dict[str, Any]) -> dict[str, Any]:
    result: dict[str, Any] = {}

    def walk(node: Any, depth: int = 0) -> None:
        if depth > 4 or len(result) >= 24:
            return
        if isinstance(node, dict):
            for key, item in node.items():
                lowered = str(key).lower()
                if lowered in METADATA_SCALAR_KEYS and isinstance(item, (str, int, float, bool)):
                    result[lowered] = item
                elif isinstance(item, (dict, list)):
                    walk(item, depth + 1)
        elif isinstance(node, list):
            for item in node[:10]:
                walk(item, depth + 1)

    walk(value)
    return result


def direct_metadata_scalars(value: dict[str, Any]) -> dict[str, Any]:
    return {
        str(key).lower(): item
        for key, item in value.items()
        if str(key).lower() in METADATA_SCALAR_KEYS and isinstance(item, (str, int, float, bool))
    }


def json_pointer_token(value: str) -> str:
    return value.replace("~", "~0").replace("/", "~1")


def path_within_root(path: Path, root: Path) -> str | None:
    try:
        return path.resolve().relative_to(root.resolve()).as_posix()
    except (OSError, ValueError):
        return None


def resolve_manifest_artifact_path(metadata_path: Path, raw_path: str, root: Path) -> str | None:
    normalized = raw_path.strip().strip('"').replace("/", str(Path("/")).replace("/", "\\"))
    if not normalized:
        return None
    candidate = Path(normalized)
    if not candidate.is_absolute():
        candidate = metadata_path.parent / candidate
    return path_within_root(candidate, root)


EXPLICIT_MAPPING_ROLE_ROOTS = {"source": ("articles",), "docx": ("deliverables",)}


def explicit_mapping_package_root(metadata_path: Path, root: Path) -> Path | None:
    try:
        relative_metadata = metadata_path.resolve().relative_to(root.resolve())
    except (OSError, ValueError):
        return None
    return root.resolve() if len(relative_metadata.parts) <= 1 else root.resolve() / relative_metadata.parts[0]


def resolve_explicit_mapping_candidates(
    metadata_path: Path, raw_path: str, role: str, root: Path,
) -> list[str]:
    """Resolve source/docx only inside its package's canonical role tree."""
    normalized = str(raw_path or "").strip().strip('"')
    package_root = explicit_mapping_package_root(metadata_path, root)
    if not normalized or package_root is None:
        return []
    path_value = Path(normalized.replace("\\", "/"))
    candidates: set[str] = set()

    def add_candidate(candidate: Path) -> None:
        if not candidate.is_file():
            return
        package_relative = path_within_root(candidate, package_root)
        corpus_relative = path_within_root(candidate, root)
        if package_relative is not None and corpus_relative is not None:
            candidates.add(corpus_relative)

    if path_value.is_absolute():
        add_candidate(path_value)
    elif len(path_value.parts) > 1:
        add_candidate(metadata_path.parent / path_value)
        add_candidate(package_root / path_value)
    else:
        target_name = path_value.name.casefold()
        for role_root_name in EXPLICIT_MAPPING_ROLE_ROOTS.get(role, ()):
            role_root = package_root / role_root_name
            if role_root.is_dir():
                for candidate in role_root.rglob("*"):
                    if candidate.is_file() and candidate.name.casefold() == target_name:
                        add_candidate(candidate)
    return sorted(candidates)


def manifest_group_key(metadata_relative_path: str, pointer: str) -> str:
    platform_match = re.match(r"(.*/platforms/[^/]+)(?:/.*)?$", pointer)
    if platform_match:
        return f"{metadata_relative_path}#{platform_match.group(1)}"
    artifacts_match = re.match(r"(.*/items/\d+)(?:/artifacts/.*)?$", pointer)
    if artifacts_match:
        return f"{metadata_relative_path}#{artifacts_match.group(1)}"
    item_match = re.match(r"(.*/items/\d+)(?:/.*)?$", pointer)
    if item_match:
        return f"{metadata_relative_path}#{item_match.group(1)}"
    parent = pointer.rsplit("/", 1)[0] if "/" in pointer else ""
    return f"{metadata_relative_path}#{parent}"


def publication_eligible_manifest_role(role: str, node: dict[str, Any], expected_sha256: str) -> bool:
    normalized = role.lower()
    if normalized == "article":
        return True
    if normalized in {"published_artifact", "published_import_document"}:
        return True
    if normalized == "import_document":
        published_digest = str(node.get("published_import_document_sha256", "")).strip().lower()
        return published_digest == expected_sha256
    return False


def collect_manifest_evidence(
    metadata_path: Path,
    value: dict[str, Any] | list[Any],
    root: Path,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    metadata_relative_path = metadata_path.relative_to(root).as_posix()
    references: list[dict[str, Any]] = []
    declarations: list[dict[str, Any]] = []
    seen_references: set[tuple[str, str, str]] = set()
    seen_declarations: set[tuple[str, str, str]] = set()

    relation_keys = {
        "supersedes": "supersedes",
        "extends_package_id": "extends_package",
        "extends_manifest": "extends_package",
        "failed_predecessor": "failed_predecessor",
        "failed_predecessor_id": "failed_predecessor",
        "failed_predecessor_package_id": "failed_predecessor",
    }
    paired_paths = {
        "source_markdown": "source_sha256",
        "document": "document_sha256",
        "import_document": "import_document_sha256",
        "source": "source_sha256",
        "output": "output_sha256",
        "source_path": "source_sha256",
        "artifact_path": "artifact_sha256",
        "body_path": "body_sha256",
        "docx_path": "docx_sha256",
        "file": "file_sha256",
        "filename": "file_sha256",
    }

    def add_reference(
        raw_path: Any,
        raw_sha256: Any,
        role: str,
        pointer: str,
        context: dict[str, Any],
        containing_node: dict[str, Any],
    ) -> None:
        path_text = str(raw_path or "").strip()
        expected_sha256 = str(raw_sha256 or "").strip().lower()
        if not path_text or not re.fullmatch(r"[0-9a-f]{64}", expected_sha256):
            return
        key = (pointer, path_text, expected_sha256)
        if key in seen_references:
            return
        seen_references.add(key)
        fields = dict(context)
        fields.update({
            "artifact_path": path_text,
            "artifact_sha256": expected_sha256,
            "_manifestArtifactRole": role,
            "_jsonPointer": pointer,
            "_manifestGroup": manifest_group_key(metadata_relative_path, pointer),
            "_publicationEligible": publication_eligible_manifest_role(role, containing_node, expected_sha256),
        })
        if fields.get("public_visibility") == "verified" and not (
            fields.get("verification_method") or fields.get("public_verification_method") or fields.get("method")
        ):
            fields["public_verification_method"] = "manifest submission.public_visibility=verified"
        references.append({
            "metadataPath": metadata_relative_path,
            "jsonPointer": pointer,
            "role": role,
            "rawPath": path_text,
            "expectedSha256": expected_sha256,
            "targetRelativePath": resolve_manifest_artifact_path(metadata_path, path_text, root),
            "groupKey": fields["_manifestGroup"],
            "publicationEligible": fields["_publicationEligible"],
            "fields": fields,
            "matchedPath": None,
            "matchStatus": "unresolved",
        })

    def walk(node: Any, pointer: str, context: dict[str, Any], labels: list[str]) -> None:
        if isinstance(node, dict):
            local_context = dict(context)
            local_context.update(direct_metadata_scalars(node))
            submission = node.get("submission")
            if isinstance(submission, dict):
                local_context.update(direct_metadata_scalars(submission))
            if len(labels) >= 2 and labels[-2] == "platforms":
                local_context["platform"] = labels[-1]

            if (
                isinstance(node.get("source"), str)
                and isinstance(node.get("docx"), str)
                and not node.get("source_sha256")
                and not node.get("docx_sha256")
            ):
                declaration_pointer = pointer or "/"
                declaration_key = ("derived_from", str(node["source"]), f"{declaration_pointer}:docx")
                if declaration_key not in seen_declarations:
                    seen_declarations.add(declaration_key)
                    derived_candidates = resolve_explicit_mapping_candidates(
                        metadata_path, str(node["docx"]), "docx", root,
                    )
                    source_candidates = resolve_explicit_mapping_candidates(
                        metadata_path, str(node["source"]), "source", root,
                    )
                    unique_mapping = len(derived_candidates) == 1 and len(source_candidates) == 1
                    declarations.append({
                        "metadataPath": metadata_relative_path,
                        "jsonPointer": declaration_pointer,
                        "relationType": "derived_from",
                        "sourceRef": str(node["docx"]).strip(),
                        "targetRef": str(node["source"]).strip(),
                        "targetSha256": None,
                        "weakMapping": not unique_mapping,
                        "explicitUniquePathMapping": unique_mapping,
                        "sourcePathCandidates": derived_candidates,
                        "targetPathCandidates": source_candidates,
                        "resolvedSourcePath": derived_candidates[0] if unique_mapping else None,
                        "resolvedTargetPath": source_candidates[0] if unique_mapping else None,
                    })

            for key, relation_type in relation_keys.items():
                target = node.get(key)
                target_ref: str | None = None
                target_sha256: str | None = None
                if isinstance(target, dict):
                    target_ref = str(target.get("path") or target.get("id") or target.get("package_id") or "").strip() or None
                    target_sha256 = str(target.get("sha256") or "").strip().lower() or None
                elif isinstance(target, (str, int, float)) and str(target).strip():
                    target_ref = str(target).strip()
                if not target_ref:
                    continue
                declaration_pointer = f"{pointer}/{json_pointer_token(key)}"
                declaration_key = (relation_type, target_ref, declaration_pointer)
                if declaration_key in seen_declarations:
                    continue
                seen_declarations.add(declaration_key)
                declarations.append({
                    "metadataPath": metadata_relative_path,
                    "jsonPointer": declaration_pointer,
                    "relationType": relation_type,
                    "targetRef": target_ref,
                    "targetSha256": target_sha256 or str(
                        node.get("extends_manifest_sha256")
                        or node.get("supersedes_sha256")
                        or node.get("failed_predecessor_sha256")
                        or ""
                    ).strip().lower() or None,
                })

            generic_path = node.get("path")
            generic_sha = node.get("sha256")
            if generic_path is not None and generic_sha is not None:
                role = labels[-1] if labels else "artifact"
                add_reference(generic_path, generic_sha, role, pointer, local_context, node)
            elif generic_sha is not None:
                generic_candidates = [
                    key for key in ("document", "source", "output", "artifact", "file")
                    if isinstance(node.get(key), str) and str(node.get(key)).strip()
                ]
                if len(generic_candidates) == 1:
                    role = generic_candidates[0]
                    add_reference(node[role], generic_sha, role, pointer, local_context, node)

            for path_key, sha_key in paired_paths.items():
                if path_key not in node:
                    continue
                role = path_key
                expected = node.get(sha_key)
                if path_key == "import_document" and str(node.get("published_import_document_sha256", "")).strip().lower() == str(expected or "").strip().lower():
                    role = "published_import_document"
                add_reference(
                    node.get(path_key),
                    expected,
                    role,
                    f"{pointer}/{json_pointer_token(path_key)}",
                    local_context,
                    node,
                )

            for key, item in node.items():
                if isinstance(item, (dict, list)):
                    walk(item, f"{pointer}/{json_pointer_token(str(key))}", local_context, labels + [str(key)])
        elif isinstance(node, list):
            for index, item in enumerate(node):
                if isinstance(item, (dict, list)):
                    walk(item, f"{pointer}/{index}", context, labels + [str(index)])

    walk(value, "", {}, [])
    return references, declarations


def register_evidence(
    registry: dict[str, dict[str, Any]],
    *,
    kind: str,
    strength: str,
    source_path: str,
    claim: str,
    locator: str | None = None,
    sha256: str | None = None,
) -> str:
    seed = json.dumps({
        "kind": kind,
        "strength": strength,
        "sourcePath": source_path,
        "locator": locator,
        "sha256": sha256,
        "claim": claim,
    }, ensure_ascii=False, sort_keys=True)
    evidence_id = f"corpus-ev-{sha1_text(seed)[:16]}"
    registry.setdefault(evidence_id, {
        "id": evidence_id,
        "kind": kind,
        "strength": strength,
        "sourcePath": source_path,
        "locator": locator,
        "sha256": sha256,
        "claim": claim,
    })
    return evidence_id


def classification_decision(
    class_name: str,
    basis: str,
    confidence: str,
    evidence_refs: Iterable[str],
) -> dict[str, Any]:
    if class_name not in CLASSIFICATION_CLASSES:
        raise ValueError(f"未知语料分类：{class_name}")
    return {
        "class": class_name,
        "basis": basis,
        "confidence": confidence,
        "ruleVersion": CLASSIFICATION_RULE_VERSION,
        "evidenceRefs": sorted(set(evidence_refs)),
    }


def classify_content_version(
    version: dict[str, Any],
    publication_events: list[dict[str, Any]],
    evidence_registry: dict[str, dict[str, Any]],
) -> dict[str, Any]:
    paths = [str(path) for path in version.get("pathAliases", [])]
    path_haystack = " ".join(paths).lower().replace("\\", "/")
    metadata_bindings = [item for item in version.get("metadataBindings", []) if isinstance(item, dict)]

    published_events = [
        event for event in publication_events
        if event.get("qualifiesForRollup") is True
        and event.get("reportedState") in {"有发布记录", "曾公开核验"}
    ]
    if published_events:
        refs = [
            register_evidence(
                evidence_registry,
                kind="exact_publication_binding",
                strength="explicit",
                source_path=str(event.get("sourcePath", "")),
                locator=str(event.get("id", "")),
                sha256=str(version.get("contentHash", "")),
                claim=f"发布事件按制品路径或 SHA-256 精确绑定，报告状态为 {event.get('reportedState')}",
            )
            for event in published_events
        ]
        return classification_decision("published_article", "explicit_publication_evidence", "high", refs)

    explicit_roles: list[tuple[str, dict[str, Any]]] = []
    for binding in metadata_bindings:
        role = str(binding.get("manifestRole") or binding.get("fields", {}).get("_manifestArtifactRole") or "").lower()
        if role and binding.get("bindingStrength") == "strong":
            explicit_roles.append((role, binding))

    if explicit_roles:
        role_names = {role for role, _binding in explicit_roles}
        explicit_class: str | None = None
        if any("import" in role for role in role_names):
            explicit_class = "import_artifact"
        elif any(role in {"release_audit", "publication_receipt", "receipt", "evidence"} or "evidence" in role or "receipt" in role for role in role_names):
            explicit_class = "evidence"
        elif any(role.startswith("qa") or "audit" in role or "gate" in role or "report" in role for role in role_names):
            explicit_class = "test_or_qa"
        elif any(role in {"source", "source_paper", "source_material"} for role in role_names):
            explicit_class = "source_material"
        elif any(role in {
            "article", "document", "docx", "final_markdown", "source_markdown", "draft",
            "publish_info", "content_card", "visual_card", "platform_copy",
        } for role in role_names):
            explicit_class = "platform_build" if any(platform != "源稿" for platform in version.get("platforms", [])) else "draft_or_intermediate"
        if explicit_class:
            refs = [
                register_evidence(
                    evidence_registry,
                    kind="manifest_artifact_binding",
                    strength="explicit",
                    source_path=str(binding.get("path", "")),
                    locator=str(binding.get("jsonPointer", "")),
                    sha256=str(version.get("contentHash", "")),
                    claim=f"manifest 以路径和 SHA-256 将该制品声明为 {role}",
                )
                for role, binding in explicit_roles
            ]
            return classification_decision(explicit_class, "explicit_manifest_role", "high", refs)

    is_weak_document = any(Path(path).name.lower() == "readme.md" or Path(path).name.lower().startswith("thread_") for path in paths)
    path_strength = "weak" if is_weak_document else "heuristic"
    path_confidence = "low" if is_weak_document else "medium"

    if re.search(r"(?:^|/)(?:evidence|publish-evidence|delivery)(?:/|$)|回执|receipt|release_audit|publication-receipts|验收证据", path_haystack):
        class_name = "evidence"
    elif re.search(r"(?:^|/)(?:qa|test|tests|fixtures?)(?:/|$)|(?:^|[_\-.])qa(?:[_\-.]|$)|测试|门禁待签|审校表|preflight", path_haystack):
        class_name = "test_or_qa"
    elif re.search(r"(?:^|/)_skill_updates(?:/|$)|skill[_ -]?(?:summary|update|promotion)|能力清单|skill总结", path_haystack):
        class_name = "skill_summary_or_capability"
    elif re.search(r"(?:^|/)(?:research|governance|gates?)(?:/|$)|研究|治理|审计|合同|报告|流程总结|复盘|readme", path_haystack):
        class_name = "research_governance"
    elif version.get("role") == "衍生工具稿" or re.search(r"(?:^|/)(?:tools?|prompts?)(?:/|$)|提词器|超级提示词|工具说明", path_haystack):
        class_name = "tool"
    elif version.get("kind") == "来源材料" or re.search(r"(?:^|/)(?:source|sources|素材)(?:/|$)|采访回复|原始材料|来源稿", path_haystack):
        class_name = "source_material"
    elif version.get("format") == "docx" and re.search(r"(?:^|/)(?:import-docx|imports?)(?:/|$)|导入版|[_-]import(?:[_\-.]|$)", path_haystack):
        class_name = "import_artifact"
    elif version.get("role") == "平台发布稿" or (
        any(platform != "源稿" for platform in version.get("platforms", []))
        and re.search(r"发布包|发布版|xiaohongshu|bilibili|小红书|知乎|b站", path_haystack)
    ):
        class_name = "platform_build"
    else:
        class_name = "draft_or_intermediate"

    evidence_ref = register_evidence(
        evidence_registry,
        kind="weak_document_signal" if is_weak_document else "path_role_signal",
        strength=path_strength,
        source_path=paths[0] if paths else str(version.get("path", "")),
        locator=None,
        sha256=str(version.get("contentHash", "")),
        claim=f"文件路径、格式、旧 kind/role 共同产生 {class_name} 候选；这不是发布或血缘证明",
    )
    return classification_decision(class_name, "heuristic_path_and_role", path_confidence, [evidence_ref])


def classify_metadata_object(
    item: dict[str, Any],
    evidence_registry: dict[str, dict[str, Any]],
) -> dict[str, Any]:
    path = str(item.get("path", ""))
    lowered = path.lower().replace("\\", "/")
    fields = item.get("fields", {}) if isinstance(item.get("fields"), dict) else {}
    basename = Path(path).name.lower()
    is_explicit_manifest = (
        "manifest" in basename
        or any(key in fields for key in ("package_id", "content_id", "article_id", "source_article_id"))
        or int(item.get("explicitArtifactRefCount", 0)) > 0
    )
    if re.search(r"(?:^|/)(?:evidence|publish-evidence|delivery)(?:/|$)|receipt|回执|release_audit|publication-receipts", lowered):
        class_name, basis, confidence, strength = "evidence", "heuristic_path_role", "medium", "heuristic"
    elif re.search(r"(?:^|/)(?:qa|test|tests|fixtures?)(?:/|$)|(?:^|[_\-.])qa(?:[_\-.]|$)|preflight|gate", lowered):
        class_name, basis, confidence, strength = "test_or_qa", "heuristic_path_role", "medium", "heuristic"
    elif re.search(r"(?:^|/)_skill_updates(?:/|$)|skill|capabilit", lowered):
        class_name, basis, confidence, strength = "skill_summary_or_capability", "heuristic_path_role", "medium", "heuristic"
    elif re.search(r"(?:^|/)(?:research|governance)(?:/|$)|contract|audit|report|decision|治理|研究|审计", lowered):
        class_name, basis, confidence, strength = "research_governance", "heuristic_path_role", "medium", "heuristic"
    elif is_explicit_manifest:
        class_name, basis, confidence, strength = "manifest_or_metadata", "explicit_structured_metadata", "high", "explicit"
    elif item.get("associationStatus") == "unbound":
        class_name, basis, confidence, strength = "catalog_only", "unbound_catalog_fallback", "low", "heuristic"
    else:
        class_name, basis, confidence, strength = "manifest_or_metadata", "bound_structured_metadata", "medium", "computed"
    evidence_ref = register_evidence(
        evidence_registry,
        kind="structured_metadata_role" if strength in {"explicit", "computed"} else "metadata_path_signal",
        strength=strength,
        source_path=path,
        locator=None,
        sha256=str(item.get("sha256", "")) or None,
        claim=f"JSON 对象按结构字段、绑定状态和文件角色归为 {class_name}",
    )
    return classification_decision(class_name, basis, confidence, [evidence_ref])


def aggregate_article_classification(versions: list[dict[str, Any]]) -> dict[str, Any]:
    priority = {
        "published_article": 120,
        "platform_build": 110,
        "import_artifact": 100,
        "draft_or_intermediate": 90,
        "skill_summary_or_capability": 80,
        "source_material": 70,
        "tool": 60,
        "research_governance": 50,
        "evidence": 40,
        "test_or_qa": 30,
        "manifest_or_metadata": 20,
        "catalog_only": 10,
    }
    decisions = [item["classification"] for item in versions]
    selected = max(decisions, key=lambda item: priority.get(str(item.get("class")), 0))
    selected_class = str(selected["class"])
    matching = [item for item in decisions if item.get("class") == selected_class]
    confidence = "high" if any(item.get("confidence") == "high" for item in matching) else "medium" if any(item.get("confidence") == "medium" for item in matching) else "low"
    evidence_refs = [ref for item in matching for ref in item.get("evidenceRefs", [])]
    basis = "aggregate_exact_publication_evidence" if selected_class == "published_article" else "aggregate_version_classification"
    return classification_decision(selected_class, basis, confidence, evidence_refs)


@dataclass
class Document:
    path: Path
    relative_path: str
    title: str
    canonical_key: str
    text: str
    format: str
    kind: str
    role: str
    platforms: list[str]
    tags: list[str]
    entities: list[str]
    metrics: dict[str, Any]
    digest: str
    modified_at: str
    size_bytes: int
    metadata_files: list[str]
    metadata: dict[str, Any]
    metadata_records: list[dict[str, Any]]

    @property
    def family_class(self) -> str:
        if self.kind == "文章":
            return "article"
        if self.kind == "来源材料":
            return "source"
        if self.kind == "创作工具":
            return "tool"
        return "research"


def requires_isolated_aux_identity(document: Document) -> bool:
    """Keep target-less QA reports independent even when their generic H1 matches."""
    normalized_path = document.relative_path.replace("\\", "/").lower()
    path = f"/{normalized_path}/"
    strong_auxiliary_path_markers = (
        "/qa/",
        "/validation/",
        "/_skill_updates/",
    )
    weak_title_path_markers = (
        "naturalness",
        "translationese",
        "skill-copy-scan",
        "冷读",
        "门禁",
    )
    if document.kind == "研究与治理" and any(marker in path for marker in strong_auxiliary_path_markers):
        return True
    return is_identity_weak_title(document.title) and any(marker in path for marker in weak_title_path_markers)


def metadata_match_basis(meta_path: Path, fields: dict[str, Any], document_path: Path, title: str, digest: str) -> list[str]:
    reasons: list[str] = []
    for key in ("body_sha256", "docx_sha256", "artifact_sha256"):
        value = str(fields.get(key, "")).strip().lower()
        if re.fullmatch(r"[0-9a-f]{64}", value) and value == digest:
            reasons.append(f"{key} 精确匹配文件哈希")

    for key in ("source_path", "artifact_path", "body_path", "docx_path", "file", "filename"):
        value = str(fields.get(key, "")).strip().replace("\\", "/")
        if not value:
            continue
        if Path(value).name.lower() == document_path.name.lower() or value.lower().endswith(document_path.as_posix().lower()):
            reasons.append(f"{key} 精确匹配文件路径")

    metadata_title = str(fields.get("title", "")).strip()
    aggregate_metadata = any(token in meta_path.stem.lower() for token in ("manifest", "queue", "catalog", "state", "index"))
    if metadata_title and not aggregate_metadata and not is_generic_title(metadata_title):
        if normalize_title(metadata_title) == normalize_title(title) and len(normalize_title(title)) >= 4:
            reasons.append("结构化标题与正文标题一致")

    explicit_id = str(fields.get("article_id") or fields.get("source_article_id") or "").strip()
    if len(explicit_id) >= 6:
        haystack = f"{document_path.as_posix()} {title}".lower()
        if explicit_id.lower() in haystack:
            reasons.append("显式文章 ID 出现在文件路径或标题")

    if meta_path.stem.lower() not in {"manifest", "queue_manifest", "queue_state", "publish_manifest", "metadata"}:
        meta_stem = re.sub(r"(?:[_\-.](?:manifest|metadata|receipt|state|qa|audit))+$", "", meta_path.stem, flags=re.IGNORECASE)
        if meta_stem and meta_stem.lower() == document_path.stem.lower():
            reasons.append("元数据文件与正文文件同名配对")
    return reasons


def discover_documents(
    root: Path,
    site_dir: Path,
) -> tuple[list[Document], list[dict[str, Any]], list[dict[str, Any]], list[dict[str, Any]]]:
    metadata_by_dir: dict[Path, list[tuple[Path, dict[str, Any], dict[str, Any]]]] = defaultdict(list)
    metadata_catalog: list[dict[str, Any]] = []
    manifest_references: list[dict[str, Any]] = []
    manifest_declarations: list[dict[str, Any]] = []

    for path in root.rglob("*.json"):
        if site_dir in path.parents or any(part in EXCLUDED_DIRS for part in path.relative_to(root).parts[:-1]):
            continue
        if path.name.startswith("_") and "comments" in path.name:
            continue
        value = safe_json_value(path)
        if value is None:
            continue
        selected = select_metadata(value) if isinstance(value, dict) else {}
        references, declarations = collect_manifest_evidence(path, value, root)
        if not selected and not references and not declarations:
            continue
        rel = path.relative_to(root).as_posix()
        catalog_entry = {
            "path": rel,
            "sha256": sha256_bytes(path.read_bytes()),
            "fields": selected,
            "associationStatus": "unbound",
            "linkedPaths": [],
            "explicitArtifactRefCount": len(references),
            "declaredRelationCount": len(declarations),
        }
        if selected:
            metadata_by_dir[path.parent].append((path, selected, catalog_entry))
        metadata_catalog.append(catalog_entry)
        manifest_references.extend(references)
        manifest_declarations.extend(declarations)

    documents: list[Document] = []
    for path in root.rglob("*"):
        if not path.is_file() or path.suffix.lower() not in CONTENT_EXTENSIONS:
            continue
        if site_dir in path.parents:
            continue
        relative_parts = path.relative_to(root).parts
        if any(part in EXCLUDED_DIRS or part.startswith(".") for part in relative_parts[:-1]):
            continue
        try:
            text = extract_text(path)
            stat = path.stat()
        except OSError:
            continue
        if meaningful_length(text) < 80:
            continue

        title = infer_title(path, text)
        digest = sha256_bytes(path.read_bytes())
        metadata_items = metadata_by_dir.get(path.parent, [])
        selected_metadata: dict[str, Any] = {}
        metadata_files: list[str] = []
        metadata_records: list[dict[str, Any]] = []
        for meta_path, fields, catalog_entry in metadata_items:
            basis = metadata_match_basis(meta_path, fields, path, title, digest)
            if not basis:
                continue
            metadata_files.append(meta_path.relative_to(root).as_posix())
            selected_metadata.update(fields)
            metadata_records.append({
                "path": meta_path.relative_to(root).as_posix(),
                "fields": fields,
                "bindingBasis": basis,
            })
            catalog_entry["associationStatus"] = "bound"
            catalog_entry["linkedPaths"].append(path.relative_to(root).as_posix())
        if isinstance(selected_metadata.get("title"), str) and path.stem.lower() in GENERIC_STEMS:
            title = str(selected_metadata["title"])

        modified_at = datetime.fromtimestamp(stat.st_mtime).astimezone().isoformat(timespec="seconds")
        documents.append(
            Document(
                path=path,
                relative_path=path.relative_to(root).as_posix(),
                title=title,
                canonical_key=normalize_title(title),
                text=text,
                format=path.suffix.lower().lstrip("."),
                kind=infer_kind(path, title),
                role=infer_role(path, title),
                platforms=infer_platforms(path, text),
                tags=infer_tags(title, text, path),
                entities=extract_entities(text, title),
                metrics=analyze_text(text, path.suffix.lower()),
                digest=digest,
                modified_at=modified_at,
                size_bytes=stat.st_size,
                metadata_files=metadata_files,
                metadata=selected_metadata,
                metadata_records=metadata_records,
            )
        )
    documents_by_path = {document.relative_path: document for document in documents}
    documents_by_digest: dict[str, list[Document]] = defaultdict(list)
    for document in documents:
        documents_by_digest[document.digest].append(document)
    catalog_by_path = {item["path"]: item for item in metadata_catalog}

    for reference in manifest_references:
        target_relative_path = reference.get("targetRelativePath")
        expected_sha256 = str(reference.get("expectedSha256", ""))
        matched_document: Document | None = None
        binding_basis: list[str] = []
        if target_relative_path and target_relative_path in documents_by_path:
            candidate = documents_by_path[target_relative_path]
            if candidate.digest == expected_sha256:
                matched_document = candidate
                binding_basis = [
                    "manifest artifact_path 精确匹配文件路径",
                    "manifest artifact_sha256 精确匹配文件哈希",
                ]
            else:
                reference["matchStatus"] = "path_sha256_mismatch"
        elif expected_sha256 in documents_by_digest:
            matched_document = sorted(documents_by_digest[expected_sha256], key=lambda item: item.relative_path)[0]
            binding_basis = ["manifest artifact_sha256 精确匹配文件哈希"]

        if not matched_document:
            continue
        reference["matchedPath"] = matched_document.relative_path
        reference["matchStatus"] = "bound"
        fields = dict(reference["fields"])
        matched_document.metadata_files = sorted(set(matched_document.metadata_files) | {str(reference["metadataPath"])})
        matched_document.metadata.update(fields)
        matched_document.metadata_records.append({
            "path": reference["metadataPath"],
            "fields": fields,
            "bindingBasis": binding_basis,
            "bindingStrength": "strong",
            "jsonPointer": reference["jsonPointer"],
            "manifestRole": reference["role"],
            "manifestGroup": reference["groupKey"],
        })
        catalog_entry = catalog_by_path.get(str(reference["metadataPath"]))
        if catalog_entry is not None:
            catalog_entry["associationStatus"] = "bound"
            catalog_entry["linkedPaths"] = sorted(set(catalog_entry["linkedPaths"]) | {matched_document.relative_path})

    for catalog_entry in metadata_catalog:
        path = str(catalog_entry["path"])
        related_references = [item for item in manifest_references if item["metadataPath"] == path]
        catalog_entry["explicitBoundRefCount"] = sum(1 for item in related_references if item["matchStatus"] == "bound")
        catalog_entry["explicitMismatchRefCount"] = sum(
            1 for item in related_references if item["matchStatus"] == "path_sha256_mismatch"
        )
        catalog_entry["linkedPaths"] = sorted(set(catalog_entry["linkedPaths"]))

    return documents, metadata_catalog, manifest_references, manifest_declarations


class UnionFind:
    def __init__(self, size: int) -> None:
        self.parent = list(range(size))

    def find(self, value: int) -> int:
        while self.parent[value] != value:
            self.parent[value] = self.parent[self.parent[value]]
            value = self.parent[value]
        return value

    def union(self, left: int, right: int) -> None:
        root_left, root_right = self.find(left), self.find(right)
        if root_left != root_right:
            self.parent[root_right] = root_left


def content_signature(text: str) -> str:
    return re.sub(r"[^0-9a-z\u4e00-\u9fff]+", "", text.lower())[:7000]


def content_fingerprint(signature: str) -> set[str]:
    if len(signature) < 80:
        return {signature} if signature else set()
    return {signature[index:index + 12] for index in range(0, len(signature) - 11, 18)}


def group_documents(documents: list[Document]) -> list[list[Document]]:
    union_find = UnionFind(len(documents))
    signatures = [content_signature(document.text) for document in documents]
    fingerprints = [content_fingerprint(signature) for signature in signatures]

    for left in range(len(documents)):
        for right in range(left + 1, len(documents)):
            a, b = documents[left], documents[right]
            if a.digest == b.digest:
                union_find.union(left, right)
                continue
            if a.family_class != b.family_class:
                continue
            # A reusable QA/report title is not a content identity. Unless the
            # bytes are exactly the same (handled above), keep the physical
            # artifact independent; a later explicit qa_of edge may bind it to
            # its inspected target without pretending it is a revision.
            if requires_isolated_aux_identity(a) or requires_isolated_aux_identity(b):
                continue
            a_explicit = str(a.metadata.get("article_id") or a.metadata.get("source_article_id") or "").strip()
            b_explicit = str(b.metadata.get("article_id") or b.metadata.get("source_article_id") or "").strip()
            if a_explicit and a_explicit == b_explicit:
                union_find.union(left, right)
                continue
            title_similarity = SequenceMatcher(None, a.canonical_key, b.canonical_key).ratio()
            shared_tags = set(a.tags) & set(b.tags)
            if not shared_tags or min(len(signatures[left]), len(signatures[right])) < 240:
                continue
            same_near_dir = a.path.parent.name == b.path.parent.name or a.path.parent.parent.name == b.path.parent.parent.name
            length_ratio = min(len(signatures[left]), len(signatures[right])) / max(len(signatures[left]), len(signatures[right]))
            if length_ratio < 0.30:
                continue
            union_size = len(fingerprints[left] | fingerprints[right])
            jaccard = len(fingerprints[left] & fingerprints[right]) / max(1, union_size)
            same_specific_title = (
                a.canonical_key == b.canonical_key
                and len(a.canonical_key) >= 4
                and not is_identity_weak_title(a.title)
                and not is_identity_weak_title(b.title)
            )
            if same_specific_title:
                union_find.union(left, right)
            elif title_similarity >= 0.90 and jaccard >= 0.20:
                union_find.union(left, right)
            elif jaccard >= 0.55 and (title_similarity >= 0.35 or same_near_dir):
                union_find.union(left, right)

    buckets: dict[int, list[Document]] = defaultdict(list)
    for index, document in enumerate(documents):
        buckets[union_find.find(index)].append(document)
    return list(buckets.values())


def load_id_map(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {"version": 1, "articles": []}
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else {"version": 1, "articles": []}
    except (OSError, json.JSONDecodeError):
        return {"version": 1, "articles": []}


def assign_article_ids(groups: list[list[Document]], previous_map: dict[str, Any]) -> tuple[dict[int, str], dict[str, Any]]:
    prior_records = previous_map.get("articles", []) if isinstance(previous_map.get("articles"), list) else []
    used: set[str] = set()
    assignments: dict[int, str] = {}
    next_records: list[dict[str, Any]] = []

    for index, group in enumerate(groups):
        paths = {document.relative_path for document in group}
        artifact_hashes = {document.digest for document in group}
        family_classes = {document.family_class for document in group}
        family_class = next(
            value for value in ("source", "article", "tool", "research")
            if value in family_classes
        )
        best_prior: dict[str, Any] | None = None
        best_score = 0
        for record in prior_records:
            if not isinstance(record, dict) or record.get("id") in used:
                continue
            member_paths = set(record.get("memberPaths", []))
            member_hashes = set(record.get("memberArtifactHashes", []))
            family_bonus = 1 if record.get("familyClass") == family_class else 0
            score = len(artifact_hashes & member_hashes) * 1000 + len(paths & member_paths) * 2 + family_bonus
            if score > best_score:
                best_prior, best_score = record, score
        if best_prior and best_score:
            article_id = str(best_prior["id"])
        else:
            if any(requires_isolated_aux_identity(document) for document in group):
                seed = "isolated-aux:" + min(
                    f"{document.relative_path}:{document.digest}" for document in group
                )
            else:
                seed = min((document.canonical_key for document in group if document.canonical_key), default=min(paths))
            article_id = f"art-{sha1_text(seed)[:10]}"
            suffix = 2
            while article_id in used:
                article_id = f"art-{sha1_text(seed)[:8]}-{suffix}"
                suffix += 1
        used.add(article_id)
        assignments[index] = article_id
        representative = max(group, key=lambda item: (role_rank(item.role), item.modified_at))
        next_records.append({
            "id": article_id,
            "title": representative.title,
            "memberPaths": sorted(paths),
            "memberArtifactHashes": sorted(artifact_hashes),
            "familyClass": family_class,
        })

    baseline = previous_map.get("classificationBaseline") if isinstance(previous_map.get("classificationBaseline"), dict) else None
    if not baseline or not isinstance(baseline.get("artifactHashes"), list):
        baseline = {
            "label": "corpus-1.3.0-pre-classification",
            "capturedFrom": "刷新前 article-id-map.json memberArtifactHashes",
            "artifactHashes": sorted({
                str(digest)
                for record in prior_records
                if isinstance(record, dict)
                for digest in record.get("memberArtifactHashes", [])
                if re.fullmatch(r"[0-9a-f]{64}", str(digest))
            }),
        }
    return assignments, {
        "version": 2,
        "schemaVersion": "wenmai.article-id-map/2.0",
        "algorithmVersion": ALGORITHM_VERSION,
        "generatedAt": datetime.now().astimezone().isoformat(timespec="seconds"),
        "classificationBaseline": baseline,
        "articles": next_records,
    }


def percentile(value: float, values: list[float]) -> int:
    if not values:
        return 50
    below = sum(1 for item in values if item < value)
    equal = sum(1 for item in values if item == value)
    return clamp((below + equal * 0.5) / len(values) * 100)


def infer_stage(title: str, text: str) -> list[str]:
    haystack = f"{title}\n{text[:420]}".lower()
    return [stage for stage, terms in STAGE_RULES.items() if any(term in haystack for term in terms)] or ["是什么"]


def eligible_for_heuristic_adaptation(version: dict[str, Any]) -> bool:
    """Limit candidate-family adaptation inference to readable content builds."""
    classification = str(version.get("classification", {}).get("class", ""))
    if classification not in {
        "published_article",
        "draft_or_intermediate",
        "platform_build",
        "source_material",
    }:
        return False
    if str(version.get("kind", "")) not in {"文章", "来源材料"}:
        return False
    normalized_path = str(version.get("path", "")).replace("\\", "/").lower()
    path = f"/{normalized_path}/"
    auxiliary_markers = (
        "/qa/",
        "/validation/",
        "/_skill_updates/",
        "/governance/",
        "/research/",
        "/evidence/",
        "naturalness",
        "translationese",
        "skill-copy-scan",
        "release_info",
        "publish_info",
        "发布信息",
        "视觉决策",
        "visual_decision",
        "内容与实验卡",
        "content_experiment",
        "冷读",
        "门禁",
        "回执",
        "receipt",
    )
    return not any(marker in path for marker in auxiliary_markers)


def build_development_tree(
    root: Path,
    articles: list[dict[str, Any]],
    artifacts: list[dict[str, Any]],
    metadata_catalog: list[dict[str, Any]],
    manifest_references: list[dict[str, Any]],
    manifest_declarations: list[dict[str, Any]],
    evidence_registry: dict[str, dict[str, Any]],
) -> dict[str, Any]:
    nodes: dict[str, dict[str, Any]] = {}
    edges: dict[str, dict[str, Any]] = {}

    def add_node(node: dict[str, Any]) -> str:
        node_id = str(node["id"])
        nodes.setdefault(node_id, node)
        return node_id

    def add_edge(
        relation_type: str,
        source: str,
        target: str,
        *,
        status: str,
        basis: str,
        confidence: str,
        evidence_refs: Iterable[str],
    ) -> None:
        if relation_type not in DEVELOPMENT_RELATION_TYPES or source == target:
            return
        refs = sorted(set(evidence_refs))
        edge_id = f"dev-edge-{sha1_text('|'.join((relation_type, source, target, basis)))[:16]}"
        edges.setdefault(edge_id, {
            "id": edge_id,
            "relationType": relation_type,
            "source": source,
            "target": target,
            "status": status,
            "basis": basis,
            "confidence": confidence,
            "ruleVersion": DEVELOPMENT_TREE_RULE_VERSION,
            "evidenceRefs": refs,
        })

    article_by_id = {str(item["id"]): item for item in articles}
    artifact_by_id = {str(item["id"]): item for item in artifacts}
    artifact_by_sha = {str(item["sha256"]): item for item in artifacts}
    version_by_id = {
        str(version["id"]): version
        for article in articles
        for version in article.get("versions", [])
    }
    path_to_artifact: dict[str, str] = {}
    path_node_ids: dict[str, str] = {}
    for article in articles:
        add_node({
            "id": article["id"],
            "nodeType": "content_identity",
            "label": article["title"],
            "classification": article["classification"],
        })
    for artifact in artifacts:
        artifact_id = str(artifact["id"])
        add_node({
            "id": artifact_id,
            "nodeType": "artifact",
            "label": artifact_id,
            "sha256": artifact["sha256"],
            "textHash": artifact["textHash"],
            "classification": artifact["classification"],
        })
        alias_paths = sorted(str(path) for path in artifact.get("pathAliases", []))
        for path in alias_paths:
            path_node_id = f"path-{sha1_text(path)[:16]}"
            path_node_ids[path] = path_node_id
            path_to_artifact[path] = artifact_id
            add_node({
                "id": path_node_id,
                "nodeType": "physical_path",
                "label": path,
                "relativePath": path,
                "classification": artifact["classification"],
            })
            evidence_ref = register_evidence(
                evidence_registry,
                kind="computed_binary_identity",
                strength="computed",
                source_path=path,
                locator=None,
                sha256=str(artifact["sha256"]),
                claim="物理文件实算 SHA-256 与 Artifact 身份相同",
            )
            add_edge(
                "path_alias_of",
                path_node_id,
                artifact_id,
                status="confirmed",
                basis="computed_sha256",
                confidence="high",
                evidence_refs=[evidence_ref],
            )
        if len(alias_paths) > 1:
            primary_path = alias_paths[0]
            primary_node = path_node_ids[primary_path]
            for alias_path in alias_paths[1:]:
                evidence_ref = register_evidence(
                    evidence_registry,
                    kind="computed_binary_equivalence",
                    strength="computed",
                    source_path=alias_path,
                    locator=primary_path,
                    sha256=str(artifact["sha256"]),
                    claim="两个物理路径的文件 SHA-256 完全一致",
                )
                add_edge(
                    "same_binary_as",
                    path_node_ids[alias_path],
                    primary_node,
                    status="confirmed",
                    basis="computed_sha256_equality",
                    confidence="high",
                    evidence_refs=[evidence_ref],
                )

    artifacts_by_text_hash: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for artifact in artifacts:
        artifacts_by_text_hash[str(artifact["textHash"])].append(artifact)
    for text_hash, same_text_artifacts in artifacts_by_text_hash.items():
        ordered = sorted(same_text_artifacts, key=lambda item: str(item["id"]))
        if len(ordered) < 2:
            continue
        primary = ordered[0]
        for other in ordered[1:]:
            evidence_ref = register_evidence(
                evidence_registry,
                kind="computed_extracted_text_identity",
                strength="computed",
                source_path=str(other.get("pathAliases", [other["id"]])[0]),
                locator=str(primary.get("pathAliases", [primary["id"]])[0]),
                sha256=text_hash,
                claim="两个不同二进制制品的抽取正文 SHA-256 完全一致",
            )
            add_edge(
                "same_extracted_text_as",
                str(other["id"]),
                str(primary["id"]),
                status="confirmed",
                basis="computed_text_sha256_equality",
                confidence="high",
                evidence_refs=[evidence_ref],
            )

    for article in articles:
        seen_article_artifacts: set[str] = set()
        for version in article.get("versions", []):
            artifact_id = str(version.get("artifactId", ""))
            if not artifact_id or artifact_id in seen_article_artifacts or artifact_id not in artifact_by_id:
                continue
            seen_article_artifacts.add(artifact_id)
            evidence_ref = register_evidence(
                evidence_registry,
                kind="computed_article_membership",
                strength="computed",
                source_path=str(version.get("path", "")),
                locator=f"{article['id']}/versions/{version.get('id')}",
                sha256=str(version.get("contentHash", "")),
                claim="Corpus 版本对象在该 content identity 下显式引用此 artifactId；只确认当前索引成员关系",
            )
            add_edge(
                "artifact_of",
                artifact_id,
                str(article["id"]),
                status="confirmed",
                basis="computed_article_membership",
                confidence="high",
                evidence_refs=[evidence_ref],
            )

    metadata_node_by_path: dict[str, str] = {}
    metadata_by_path = {str(item["path"]): item for item in metadata_catalog}
    metadata_by_sha = {str(item.get("sha256", "")): item for item in metadata_catalog if item.get("sha256")}
    metadata_by_stable_id: dict[str, dict[str, Any]] = {}
    for item in metadata_catalog:
        path = str(item["path"])
        node_id = f"metadata-{sha1_text(path)[:16]}"
        metadata_node_by_path[path] = node_id
        add_node({
            "id": node_id,
            "nodeType": "metadata",
            "label": path,
            "relativePath": path,
            "sha256": item.get("sha256"),
            "classification": item["classification"],
        })
        fields = item.get("fields", {}) if isinstance(item.get("fields"), dict) else {}
        for key in ("package_id", "content_id", "article_id", "source_article_id"):
            if fields.get(key):
                metadata_by_stable_id[str(fields[key])] = item

    refs_by_group: dict[str, list[dict[str, Any]]] = defaultdict(list)
    refs_by_metadata_path: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for reference in manifest_references:
        if reference.get("matchStatus") != "bound" or not reference.get("matchedPath"):
            continue
        matched_path = str(reference["matchedPath"])
        artifact_id = path_to_artifact.get(matched_path)
        metadata_node_id = metadata_node_by_path.get(str(reference["metadataPath"]))
        if not artifact_id or not metadata_node_id:
            continue
        reference["artifactId"] = artifact_id
        refs_by_group[str(reference["groupKey"])].append(reference)
        refs_by_metadata_path[str(reference["metadataPath"])].append(reference)
        role = str(reference.get("role", "")).lower()
        metadata_class = metadata_by_path[str(reference["metadataPath"])]["classification"]["class"]
        if metadata_class == "evidence":
            relation_type = "evidence_for"
        elif metadata_class == "test_or_qa" or any(term in role for term in ("qa", "audit", "gate", "report")):
            relation_type = "qa_of"
        else:
            relation_type = "packaged_as"
        evidence_ref = register_evidence(
            evidence_registry,
            kind="manifest_path_sha256_binding",
            strength="explicit",
            source_path=str(reference["metadataPath"]),
            locator=str(reference["jsonPointer"]),
            sha256=str(reference["expectedSha256"]),
            claim=f"manifest 角色 {reference['role']} 的路径和 SHA-256 均匹配本地制品",
        )
        add_edge(
            relation_type,
            artifact_id,
            metadata_node_id,
            status="confirmed",
            basis="explicit_manifest_path_and_sha256",
            confidence="high",
            evidence_refs=[evidence_ref],
        )

    def role_is_import(role: str) -> bool:
        return "import" in role.lower() or role.lower() == "output"

    def role_is_article(role: str) -> bool:
        return role.lower() in {"article", "final_markdown", "source_markdown", "document", "docx", "draft", "source"}

    for grouped_refs in refs_by_group.values():
        import_refs = [item for item in grouped_refs if role_is_import(str(item.get("role", "")))]
        article_refs = [item for item in grouped_refs if role_is_article(str(item.get("role", ""))) and not role_is_import(str(item.get("role", "")))]
        if import_refs and article_refs:
            target_ref = sorted(article_refs, key=lambda item: ({"article": 0, "source": 1, "final_markdown": 2, "document": 3, "draft": 4}.get(str(item.get("role", "")).lower(), 9), str(item.get("artifactId"))))[0]
            for import_ref in import_refs:
                evidence_ref = register_evidence(
                    evidence_registry,
                    kind="manifest_grouped_roles",
                    strength="explicit",
                    source_path=str(import_ref["metadataPath"]),
                    locator=str(import_ref["groupKey"]),
                    sha256=str(import_ref["expectedSha256"]),
                    claim="同一 manifest item/platform 明确并列 import 与正文角色，且两端 SHA-256 均匹配",
                )
                add_edge(
                    "import_artifact_of",
                    str(import_ref["artifactId"]),
                    str(target_ref["artifactId"]),
                    status="confirmed",
                    basis="explicit_manifest_grouping",
                    confidence="high",
                    evidence_refs=[evidence_ref],
                )

    for metadata_path, bound_refs in refs_by_metadata_path.items():
        source_refs = [item for item in bound_refs if str(item.get("role", "")).lower() in {"source", "source_paper", "source_thought"}]
        platform_article_refs = [item for item in bound_refs if str(item.get("role", "")).lower() in {"article", "final_markdown"}]
        for article_ref in platform_article_refs:
            candidates = [item for item in source_refs if item.get("artifactId") != article_ref.get("artifactId")]
            if not candidates:
                continue
            source_ref = candidates[0]
            evidence_ref = register_evidence(
                evidence_registry,
                kind="manifest_source_adaptation",
                strength="explicit",
                source_path=metadata_path,
                locator=f"{source_ref['jsonPointer']} -> {article_ref['jsonPointer']}",
                sha256=str(article_ref["expectedSha256"]),
                claim="同一 manifest 明确列出 source 与平台 article/final_markdown，且两端 SHA-256 均匹配",
            )
            add_edge(
                "adapted_from",
                str(article_ref["artifactId"]),
                str(source_ref["artifactId"]),
                status="confirmed",
                basis="explicit_manifest_source_and_output",
                confidence="high",
                evidence_refs=[evidence_ref],
            )

    for article in articles:
        versions = [
            version for version in article.get("versions", [])
            if eligible_for_heuristic_adaptation(version)
        ]
        source_versions = [
            version for version in versions
            if version.get("role") == "来源稿" or version.get("platforms") == ["源稿"]
        ]
        platform_versions = [
            version for version in versions
            if any(platform != "源稿" for platform in version.get("platforms", []))
        ]
        if not source_versions or not platform_versions:
            continue
        source_version = source_versions[0]
        for platform_version in platform_versions:
            if platform_version["artifactId"] == source_version["artifactId"]:
                continue
            already_explicit = any(
                edge.get("relationType") == "adapted_from"
                and edge.get("source") == platform_version["artifactId"]
                and edge.get("target") == source_version["artifactId"]
                for edge in edges.values()
            )
            if already_explicit:
                continue
            evidence_ref = register_evidence(
                evidence_registry,
                kind="candidate_family_platform_relation",
                strength="heuristic",
                source_path=str(platform_version.get("path", "")),
                locator=str(source_version.get("path", "")),
                sha256=str(platform_version.get("contentHash", "")),
                claim="候选文章族内存在来源角色与平台角色；归组及方向仍需人工确认",
            )
            add_edge(
                "adapted_from",
                str(platform_version["artifactId"]),
                str(source_version["artifactId"]),
                status="suggested",
                basis="heuristic_candidate_family_roles",
                confidence="low",
                evidence_refs=[evidence_ref],
            )

    def target_for_declaration(declaration: dict[str, Any]) -> tuple[str | None, bool]:
        source_metadata_path = str(declaration["metadataPath"])
        target_ref = str(declaration["targetRef"])
        target_sha256 = str(declaration.get("targetSha256") or "")
        if target_ref in metadata_by_stable_id:
            item = metadata_by_stable_id[target_ref]
            hash_ok = not target_sha256 or item.get("sha256") == target_sha256
            return metadata_node_by_path[str(item["path"])], hash_ok
        if target_sha256 in metadata_by_sha:
            item = metadata_by_sha[target_sha256]
            return metadata_node_by_path[str(item["path"])], True
        if target_sha256 in artifact_by_sha:
            return str(artifact_by_sha[target_sha256]["id"]), True
        source_full_path = root / source_metadata_path
        resolved_target = resolve_manifest_artifact_path(source_full_path, target_ref, root)
        if resolved_target:
            if resolved_target in metadata_node_by_path:
                item = metadata_by_path[resolved_target]
                hash_ok = not target_sha256 or item.get("sha256") == target_sha256
                return metadata_node_by_path[resolved_target], hash_ok
            if resolved_target in path_to_artifact:
                artifact_id = path_to_artifact[resolved_target]
                hash_ok = not target_sha256 or artifact_by_id[artifact_id].get("sha256") == target_sha256
                return artifact_id, hash_ok
            candidate_dir = root / resolved_target
            if candidate_dir.is_dir():
                candidates = [
                    path for path in metadata_node_by_path
                    if Path(path).parent.as_posix() == resolved_target and Path(path).name in {"package_manifest.json", "publish_manifest.json", "manifest.json"}
                ]
                if len(candidates) == 1:
                    item = metadata_by_path[candidates[0]]
                    hash_ok = not target_sha256 or item.get("sha256") == target_sha256
                    return metadata_node_by_path[candidates[0]], hash_ok
        return None, False

    for declaration in manifest_declarations:
        if declaration.get("explicitUniquePathMapping"):
            source_node = path_to_artifact.get(str(declaration.get("resolvedSourcePath") or ""))
            target_node = path_to_artifact.get(str(declaration.get("resolvedTargetPath") or ""))
            if source_node and target_node:
                evidence_ref = register_evidence(
                    evidence_registry,
                    kind="explicit_manifest_unique_path_mapping",
                    strength="explicit",
                    source_path=str(declaration["metadataPath"]),
                    locator=str(declaration["jsonPointer"]),
                    sha256=str(artifact_by_id[source_node].get("sha256") or "") or None,
                    claim="同一显式映射记录的 source 与 docx 在所属 package 角色目录内均唯一解析",
                )
                add_edge(
                    str(declaration["relationType"]), source_node, target_node,
                    status="confirmed", basis="explicit_manifest_unique_path_mapping",
                    confidence="high", evidence_refs=[evidence_ref],
                )
                continue
        if declaration.get("weakMapping"):
            source_paths = [str(path) for path in declaration.get("sourcePathCandidates", [])]
            target_paths = [str(path) for path in declaration.get("targetPathCandidates", [])]
            source_candidates = sorted({path_to_artifact[path] for path in source_paths if path in path_to_artifact})
            target_candidates = sorted({path_to_artifact[path] for path in target_paths if path in path_to_artifact})
            evidence_ref = register_evidence(
                evidence_registry,
                kind="explicit_manifest_non_unique_path_mapping",
                strength="weak",
                source_path=str(declaration["metadataPath"]),
                locator=str(declaration["jsonPointer"]),
                sha256=None,
                claim=f"package 角色目录内 docx 候选 {len(source_paths)} 个、source 候选 {len(target_paths)} 个，只能建议",
            )
            for source_node in source_candidates:
                for target_node in target_candidates:
                    add_edge(
                        str(declaration["relationType"]),
                        source_node,
                        target_node,
                        status="suggested",
                        basis="explicit_manifest_non_unique_path_mapping",
                        confidence="low",
                        evidence_refs=[evidence_ref],
                    )
            continue
        source_node = metadata_node_by_path.get(str(declaration["metadataPath"]))
        declaration_parent = str(declaration["jsonPointer"]).rsplit("/", 1)[0]
        source_artifact_ref = next((
            reference for reference in refs_by_metadata_path.get(str(declaration["metadataPath"]), [])
            if str(reference.get("jsonPointer", "")) == declaration_parent
        ), None)
        if source_artifact_ref:
            source_node = str(source_artifact_ref["artifactId"])
        if not source_node:
            continue
        target_node, target_verified = target_for_declaration(declaration)
        if not target_node:
            external_id = f"external-{sha1_text(str(declaration['targetRef']))[:16]}"
            target_node = add_node({
                "id": external_id,
                "nodeType": "external_reference",
                "label": str(declaration["targetRef"]),
                "declaredSha256": declaration.get("targetSha256"),
            })
        evidence_ref = register_evidence(
            evidence_registry,
            kind="explicit_relation_declaration",
            strength="explicit",
            source_path=str(declaration["metadataPath"]),
            locator=str(declaration["jsonPointer"]),
            sha256=str(declaration.get("targetSha256") or "") or None,
            claim=f"结构化 JSON 显式声明 {declaration['relationType']} -> {declaration['targetRef']}",
        )
        add_edge(
            str(declaration["relationType"]),
            source_node,
            target_node,
            status="confirmed" if target_verified else "suggested",
            basis="explicit_relation_and_verified_target" if target_verified else "explicit_relation_unresolved_target",
            confidence="high" if target_verified else "medium",
            evidence_refs=[evidence_ref],
        )

    for article in articles:
        for variant in article.get("publicationVariants", []):
            version = version_by_id.get(str(variant.get("versionId")))
            if not version:
                continue
            for event in variant.get("evidence", []):
                if event.get("qualifiesForRollup") is not True or event.get("reportedState") not in {"有发布记录", "曾公开核验"}:
                    continue
                publication_id = f"publication-{sha1_text(str(event['id']))[:16]}"
                add_node({
                    "id": publication_id,
                    "nodeType": "publication_record",
                    "label": f"{variant.get('platform')} · {event.get('reportedState')}",
                    "platform": variant.get("platform"),
                    "reportedState": event.get("reportedState"),
                    "url": event.get("url"),
                    "observedAt": event.get("observedAt"),
                })
                evidence_ref = register_evidence(
                    evidence_registry,
                    kind="exact_publication_binding",
                    strength="explicit",
                    source_path=str(event.get("sourcePath", "")),
                    locator=str(event.get("id", "")),
                    sha256=str(version.get("contentHash", "")),
                    claim=f"发布状态 {event.get('reportedState')} 与版本制品精确绑定",
                )
                add_edge(
                    "published_as",
                    str(version["artifactId"]),
                    publication_id,
                    status="confirmed",
                    basis="explicit_exact_publication_evidence",
                    confidence="high",
                    evidence_refs=[evidence_ref],
                )

    relation_descriptions = {
        "same_binary_as": "两个物理路径的文件字节 SHA-256 相同",
        "same_extracted_text_as": "不同二进制制品的抽取正文 SHA-256 相同",
        "path_alias_of": "物理路径映射到按二进制哈希去重的 Artifact",
        "artifact_of": "Artifact 是当前 corpus content identity 下版本对象的成员；不推出身份已人工确认",
        "derived_from": "工件明确或候选地从另一工件派生",
        "adapted_from": "面向平台、受众或载体的适配关系",
        "split_from": "从较大内容拆分出的独立内容",
        "supersedes": "新工件或包显式取代旧对象",
        "failed_predecessor": "新对象显式保留失败前身的证据",
        "extends_package": "包显式扩展另一包且不默认继承授权",
        "packaged_as": "Artifact 被 manifest 以路径和哈希纳入包",
        "import_artifact_of": "平台导入工件对应同一 manifest item 的正文工件",
        "qa_of": "QA 工件或记录检查目标对象",
        "evidence_for": "证据工件支持目标对象或事件",
        "published_as": "精确制品绑定到后台发布或公开核验记录",
        "summarizes": "总结另一对象；无显式证据时只可建议",
        "references_capability": "引用 Skill 或能力元素",
        "parent_revision": "不可变修订的一父关系",
        "merge_parent": "不可变修订的第二父关系",
        "restored_from": "恢复操作显式引用历史修订",
        "baseline_of": "对象被正式选为创作基线",
    }
    ordered_edges = sorted(edges.values(), key=lambda item: str(item["id"]))
    return {
        "schemaVersion": "wenmai.development-tree/1.0",
        "ruleVersion": DEVELOPMENT_TREE_RULE_VERSION,
        "relationTypes": [
            {"type": relation_type, "description": relation_descriptions[relation_type]}
            for relation_type in DEVELOPMENT_RELATION_TYPES
        ],
        "nodes": sorted(nodes.values(), key=lambda item: str(item["id"])),
        "edges": ordered_edges,
        "counts": {
            "nodes": len(nodes),
            "edges": len(ordered_edges),
            "confirmed": sum(1 for edge in ordered_edges if edge["status"] == "confirmed"),
            "suggested": sum(1 for edge in ordered_edges if edge["status"] == "suggested"),
            "byRelationType": dict(sorted(Counter(str(edge["relationType"]) for edge in ordered_edges).items())),
        },
        "notes": [
            "confirmed 仅用于实算哈希相等、精确 manifest 路径+SHA 绑定或已验证目标的显式关系。",
            "标题、目录、候选族、README 与会话只能形成 suggested；关系类型允许零实例，不用无证据边填满图。",
            "parent_revision、merge_parent、restored_from 与 baseline_of 需要不可变修订或人工基线记录，文件时间不够。",
        ],
    }


def build_payload(root: Path, site_dir: Path, id_map_path: Path, max_chars: int) -> tuple[dict[str, Any], dict[str, Any]]:
    documents, metadata_catalog, manifest_references, manifest_declarations = discover_documents(root, site_dir)
    groups = group_documents(documents)
    previous_id_map = load_id_map(id_map_path)
    assignments, next_id_map = assign_article_ids(groups, previous_id_map)
    baseline_hash_values = (
        previous_id_map.get("classificationBaseline", {}).get("artifactHashes", [])
        if isinstance(previous_id_map.get("classificationBaseline"), dict)
        else []
    )
    if not baseline_hash_values:
        baseline_hash_values = [
            digest
            for item in previous_id_map.get("articles", [])
            if isinstance(item, dict)
            for digest in item.get("memberArtifactHashes", [])
        ]
    previous_artifact_hashes = {
        str(digest)
        for digest in baseline_hash_values
        if re.fullmatch(r"[0-9a-f]{64}", str(digest))
    }

    article_rows: list[dict[str, Any]] = []
    metric_values: dict[str, list[float]] = defaultdict(list)
    raw_metrics_by_id: dict[str, dict[str, float]] = {}
    artifact_registry: dict[str, dict[str, Any]] = {}
    evidence_registry: dict[str, dict[str, Any]] = {}

    for index, group in enumerate(groups):
        group.sort(key=lambda item: item.modified_at)
        article_id = assignments[index]
        representative = max(group, key=lambda item: (role_rank(item.role), item.modified_at))
        observed_kinds = {document.kind for document in group}
        group_kind = next(
            kind for kind in ("来源材料", "文章", "创作工具", "研究与治理")
            if kind in observed_kinds
        )
        versions: list[dict[str, Any]] = []
        path_to_version: dict[str, str] = {}
        documents_by_digest: dict[str, list[Document]] = defaultdict(list)
        for document in group:
            documents_by_digest[document.digest].append(document)

        for digest, aliases in documents_by_digest.items():
            document = max(aliases, key=lambda item: (role_rank(item.role), item.modified_at))
            version_id = f"ver-{digest[:12]}"
            artifact_id = f"artifact-{digest[:12]}"
            path_aliases = sorted(item.relative_path for item in aliases)
            for alias in aliases:
                path_to_version[alias.relative_path] = version_id
            metadata_records = {
                f"{item['path']}#{item.get('jsonPointer', '')}#{item.get('manifestRole', '')}": item
                for alias in aliases
                for item in alias.metadata_records
            }
            metadata_files = sorted({item["path"] for item in metadata_records.values()})
            version_text = document.text if max_chars <= 0 else document.text[:max_chars]
            version_platforms = sorted({platform for alias in aliases for platform in alias.platforms})
            versions.append({
                "id": version_id,
                "artifactId": artifact_id,
                "name": document.path.name,
                "path": document.relative_path,
                "pathAliases": path_aliases,
                "format": document.format,
                "kind": document.kind,
                "role": document.role,
                "platforms": version_platforms,
                "modifiedAt": document.modified_at,
                "sizeBytes": document.size_bytes,
                "contentHash": digest,
                "textHash": sha256_bytes(document.text.encode("utf-8")),
                "charCount": document.metrics["charCount"],
                "excerpt": summarize(document.text),
                "text": version_text,
                "textTruncated": len(version_text) < len(document.text),
                "metrics": document.metrics,
                "metadataFiles": metadata_files,
                "metadata": document.metadata,
                "metadataBindings": list(metadata_records.values()),
            })
            artifact = artifact_registry.setdefault(digest, {
                "id": artifact_id,
                "sha256": digest,
                "textHash": sha256_bytes(document.text.encode("utf-8")),
                "pathAliases": [],
                "articleIds": [],
                "formats": [],
            })
            artifact["pathAliases"] = sorted(set(artifact["pathAliases"]) | set(path_aliases))
            artifact["articleIds"] = sorted(set(artifact["articleIds"]) | {article_id})
            artifact["formats"] = sorted(set(artifact["formats"]) | {alias.format for alias in aliases})

        versions.sort(key=lambda item: str(item["modifiedAt"]))
        current_version = max(versions, key=lambda item: (role_rank(str(item["role"])), str(item["modifiedAt"])))
        publication_variants = build_publication_variants(group, path_to_version)
        publication_events_by_version: dict[str, list[dict[str, Any]]] = defaultdict(list)
        for publication_variant in publication_variants:
            publication_events_by_version[str(publication_variant["versionId"])].extend(publication_variant.get("evidence", []))
        for version in versions:
            version["classification"] = classify_content_version(
                version,
                publication_events_by_version.get(str(version["id"]), []),
                evidence_registry,
            )
            artifact_registry[str(version["contentHash"])]["classification"] = dict(version["classification"])
        variants: list[dict[str, Any]] = []
        for platform in sorted({item["platform"] for item in publication_variants}):
            variant_versions = sorted({item["versionId"] for item in publication_variants if item["platform"] == platform})
            representative_version = max(
                (version for version in versions if version["id"] in variant_versions),
                key=lambda item: (role_rank(str(item["role"])), str(item["modifiedAt"])),
            )
            variants.append({
                "id": f"variant-{sha1_text(article_id + ':' + platform)[:12]}",
                "platform": platform,
                "versionIds": variant_versions,
                "representativeVersionId": representative_version["id"],
                "pointerStatus": "suggested",
            })
        tags = [item for item, _count in Counter(tag for document in group for tag in document.tags).most_common(10)]
        entities = [item for item, _count in Counter(entity for document in group for entity in document.entities).most_common(12)]
        platforms = sorted({platform for document in group for platform in document.platforms})
        roles = {document.role for document in group}
        state_representative = replace(representative, kind=group_kind)
        editorial_state, publication_state, evidence_health, publication_evidence = infer_state_axes(group, state_representative, publication_variants)
        identity_confidence, identity_basis = infer_identity_confidence(group)
        revision_score = clamp(18 + len(versions) * 15 + max(role_rank(role) for role in roles) * 0.65)
        current_scores = dict(current_version["metrics"]["scores"])
        current_scores["版本成熟度代理"] = revision_score
        raw_metrics_by_id[article_id] = {key: float(value) for key, value in current_scores.items()}
        if group_kind == "文章":
            for key, value in current_scores.items():
                metric_values[key].append(float(value))

        article_rows.append({
            "id": article_id,
            "title": representative.title,
            "canonicalTitle": representative.title,
            "kind": group_kind,
            "observedKinds": sorted(observed_kinds),
            "status": editorial_state,
            "editorialState": editorial_state,
            "publicationState": publication_state,
            "gateState": "未运行",
            "evidenceHealth": evidence_health,
            "publicationEvidence": publication_evidence,
            "publicationVariants": publication_variants,
            "stateRuleVersion": STATE_RULE_VERSION,
            "stateInputDigest": sha256_bytes(json.dumps({
                "versions": sorted(document.digest for document in group),
                "metadata": sorted(
                    json.dumps({"path": record["path"], "fields": record["fields"]}, ensure_ascii=False, sort_keys=True)
                    for document in group
                    for record in document.metadata_records
                ),
            }, ensure_ascii=False, sort_keys=True).encode("utf-8")),
            "identityConfidence": identity_confidence,
            "identityStatus": "bound-explicit" if identity_confidence == "高" else "candidate",
            "identityRuleVersion": IDENTITY_RULE_VERSION,
            "identityInputDigest": sha256_bytes(json.dumps({
                "artifacts": sorted(document.digest for document in group),
                "canonicalTitles": sorted({document.canonical_key for document in group}),
                "physicalPaths": sorted(document.relative_path for document in group),
            }, ensure_ascii=False, sort_keys=True).encode("utf-8")),
            "identityBasis": identity_basis,
            "summary": summarize(representative.text, 260),
            "tags": tags,
            "entities": entities,
            "platforms": platforms,
            "createdAt": min(item.modified_at for item in group),
            "updatedAt": max(item.modified_at for item in group),
            "versionCount": len(versions),
            "currentVersionId": current_version["id"],
            "representativeVersionId": current_version["id"],
            "charCount": current_version["charCount"],
            "stages": infer_stage(representative.title, representative.text),
            "versions": versions,
            "variants": variants,
            "classification": aggregate_article_classification(versions),
            "baseline": {},
            "relations": [],
        })

    for metadata_item in metadata_catalog:
        metadata_item["classification"] = classify_metadata_object(metadata_item, evidence_registry)

    article_by_id = {article["id"]: article for article in article_rows}
    for article in article_rows:
        raw = raw_metrics_by_id[article["id"]]
        article["baseline"] = {
            "algorithmVersion": ALGORITHM_VERSION,
            "profileVersion": "baseline-structure-proxy/1.1.0",
            "sampleScope": "仅文章候选族的索引推荐稿",
            "sampleSize": len(metric_values.get("清晰度代理", [])),
            "raw": {key: round(value, 1) for key, value in raw.items()},
            "portfolioPercentile": {key: percentile(value, metric_values[key]) for key, value in raw.items()},
            "explanation": "分数是可复核的结构代理，不是文学质量判断；用于和自己的作品集比较。",
        }

    edge_candidates: list[dict[str, Any]] = []
    broad_tags = {"内容创作", "版本与证据", "多平台发布"}
    for left in range(len(article_rows)):
        for right in range(left + 1, len(article_rows)):
            a, b = article_rows[left], article_rows[right]
            shared_tags = sorted(set(a["tags"]) & set(b["tags"]))
            specific_shared_tags = [tag for tag in shared_tags if tag not in broad_tags]
            shared_entities = sorted(set(a["entities"]) & set(b["entities"]))
            if not specific_shared_tags and not shared_entities:
                continue
            weight = min(1.0, len(specific_shared_tags) * 0.24 + len(shared_entities) * 0.12)
            if weight < 0.24:
                continue
            edge = {
                "id": f"edge-{sha1_text(a['id'] + b['id'])[:10]}",
                "source": a["id"],
                "target": b["id"],
                "type": "主题相邻",
                "weight": round(weight, 2),
                "confidence": "中" if len(shared_tags) >= 2 else "低",
                "status": "suggested",
                "algorithmVersion": ALGORITHM_VERSION,
                "createdBy": "wenmai-indexer",
                "evidence": [f"共同主题：{'、'.join(specific_shared_tags)}"] + ([f"共同实体：{'、'.join(shared_entities[:4])}"] if shared_entities else []),
            }
            edge_candidates.append(edge)

    graph_edges: list[dict[str, Any]] = []
    node_degree: Counter[str] = Counter()
    for edge in sorted(edge_candidates, key=lambda item: item["weight"], reverse=True):
        source, target = str(edge["source"]), str(edge["target"])
        if node_degree[source] >= 6 or node_degree[target] >= 6:
            continue
        graph_edges.append(edge)
        node_degree[source] += 1
        node_degree[target] += 1
        article_by_id[source]["relations"].append(edge)
        article_by_id[target]["relations"].append(edge)

    topic_articles: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for article in article_rows:
        for tag in article["tags"][:5]:
            if tag in TAXONOMY:
                topic_articles[tag].append(article)

    topics: list[dict[str, Any]] = []
    for label, linked in topic_articles.items():
        linked_articles = [article for article in linked if article["kind"] == "文章"]
        stage_sources = linked_articles or linked
        published = sum(1 for article in linked_articles if article["publicationState"] in {"有发布记录", "曾公开核验"})
        stages = sorted({stage for article in stage_sources for stage in article["stages"]})
        missing_stages = [stage for stage in STAGE_RULES if stage not in stages]
        opportunity = clamp(42 + min(len(linked), 5) * 7 + len(missing_stages) * 4 - published * 3)
        topics.append({
            "id": f"topic-{sha1_text(label)[:10]}",
            "label": label,
            "articleIds": [article["id"] for article in linked_articles],
            "evidenceObjectIds": [article["id"] for article in linked],
            "articleCount": len(linked_articles),
            "contentObjectCount": len(linked),
            "publishedCount": published,
            "stages": stages,
            "missingStages": missing_stages,
            "opportunityScore": opportunity,
            "lastUpdatedAt": max(article["updatedAt"] for article in linked),
            "signalStrength": "高" if len(linked) >= 3 else "中" if len(linked) == 2 else "低",
        })
    topics.sort(key=lambda item: (item["opportunityScore"], item["articleCount"]), reverse=True)

    opportunities: list[dict[str, Any]] = []
    for article in article_rows:
        if article["kind"] == "文章" and article["versionCount"] >= 3 and article["publicationState"] in {"未记录", "未规划", "未发布记录", "已打包"}:
            opportunities.append({
                "id": f"opp-version-{article['id']}",
                "type": "版本债务",
                "title": f"把《{article['title']}》收束成可发布主线",
                "score": clamp(58 + article["versionCount"] * 6),
                "signalStrength": "高",
                "rationale": f"已有 {article['versionCount']} 个版本，但尚无可汇总的制品级提交或发布证据。",
                "evidence": [f"版本数：{article['versionCount']}", f"编辑状态：{article['editorialState']}", f"发布证据：{article['publicationState']}"],
                "nextAction": "确定唯一主版本，记录取舍，再生成平台变体。",
                "relatedArticleIds": [article["id"]],
                "relatedTopics": article["tags"][:3],
            })
    for topic in topics[:8]:
        has_gap = bool(topic["missingStages"])
        stage = topic["missingStages"][0] if has_gap else "导读与反例"
        opportunities.append({
            "id": f"opp-stage-{topic['id']}-{sha1_text(stage)[:4]}",
            "type": "题型未命中候选" if has_gap else "系列构想候选",
            "title": f"检查“{topic['label']}”是否需要「{stage}」题型" if has_gap else f"检查“{topic['label']}”是否需要导读与反例篇",
            "score": topic["opportunityScore"] if has_gap else clamp(topic["opportunityScore"] - 8),
            "signalStrength": topic["signalStrength"],
            "rationale": f"规则命中 {topic['articleCount']} 个文章族和 {topic['contentObjectCount']} 个相关内容对象。" + (f"当前关键词规则未命中「{stage}」题型；这不证明内容实际缺失。" if has_gap else "题型规则均有命中，但统一入口和反例仍需人工检查。"),
            "evidence": [f"规则已命中：{'、'.join(topic['stages']) or '无明确题型'}", f"规则未命中：{'、'.join(topic['missingStages'][:3])}" if has_gap else "待检查：导读、互链与反例"],
            "nextAction": f"先写一句读者问题，再为「{stage}」列 3 条必须回答的证据。" if has_gap else "把现有文章排成阅读顺序，再写一篇说明边界的反例篇。",
            "relatedArticleIds": topic["articleIds"],
            "relatedTopics": [topic["label"]],
        })
    for article in article_rows:
        if article["kind"] != "文章" or article["publicationState"] not in {"有发布记录", "曾公开核验"}:
            continue
        real_platforms = {platform for platform in article["platforms"] if platform != "源稿"}
        missing_platforms = [platform for platform in ("小红书", "Bilibili", "知乎") if platform not in real_platforms]
        if real_platforms and missing_platforms:
            opportunities.append({
                "id": f"opp-platform-{article['id']}",
                "type": "平台变体",
                "title": f"为《{article['title']}》补 {missing_platforms[0]} 版本",
                "score": clamp(62 + article["versionCount"] * 2 - len(missing_platforms) * 2),
                "signalStrength": "高",
                "rationale": f"已识别平台：{'、'.join(sorted(real_platforms))}；缺少：{'、'.join(missing_platforms)}。",
                "evidence": [f"当前平台：{'、'.join(article['platforms'])}", f"版本数：{article['versionCount']}"],
                "nextAction": "保留同一来源 ID，按目标平台阅读习惯重构标题、开场和证据顺序。",
                "relatedArticleIds": [article["id"]],
                "relatedTopics": article["tags"][:3],
            })
        evidence_score = float(article["baseline"]["raw"].get("证据密度代理", 50))
        if evidence_score < 46:
            opportunities.append({
                "id": f"opp-evidence-{article['id']}",
                "type": "证据缺口",
                "title": f"为《{article['title']}》补一组可核查证据",
                "score": clamp(70 - evidence_score * 0.4),
                "signalStrength": "中",
                "rationale": f"证据密度代理为 {evidence_score:.0f}/100，低于当前门槛 46。",
                "evidence": ["链接、数字、引语与证据提示词较少", "这只是结构代理，不代表事实一定错误"],
                "nextAction": "为最关键的 3 个判断各补来源、案例或可复现实验。",
                "relatedArticleIds": [article["id"]],
                "relatedTopics": article["tags"][:3],
            })
    for article in article_rows:
        if not article["relations"] and article["kind"] == "文章":
            opportunities.append({
                "id": f"opp-orphan-{article['id']}",
                "type": "连接空白",
                "title": f"为《{article['title']}》找到上下游文章",
                "score": 54,
                "signalStrength": "中",
                "rationale": "当前自动图谱没有发现足够强的跨文章连接。",
                "evidence": ["文章关系边：0", f"已识别主题：{'、'.join(article['tags'][:4]) or '无'}"],
                "nextAction": "补一篇前置解释或复盘文章，并在两篇中加入互链。",
                "relatedArticleIds": [article["id"]],
                "relatedTopics": article["tags"][:3],
            })
    opportunities.sort(key=lambda item: item["score"], reverse=True)
    for opportunity in opportunities:
        opportunity["scoreKind"] = "heuristic_order"
        opportunity["scoreBreakdown"] = {
            "ruleSignal": opportunity["score"],
            "editorialValue": None,
            "evidenceReadiness": None,
            "audienceNeed": None,
        }
        opportunity["whyNow"] = "索引检测到当前作品集的结构信号；它可能是假阳性，是否值得现在写必须由编辑确认。"
        opportunity["blockers"] = ["编辑价值未确认", "证据准备度未人工评估", "尚未形成正式委托"]
    for article in article_rows:
        article["relations"] = []

    series_suggestions: list[dict[str, Any]] = []
    for topic in [item for item in topics if item["articleCount"] > 0][:6]:
        linked_titles = [article_by_id[article_id]["title"] for article_id in topic["articleIds"] if article_id in article_by_id]
        series_suggestions.append({
            "id": f"series-{sha1_text(topic['label'])[:10]}",
            "title": f"{topic['label']}：从理解到落地",
            "topic": topic["label"],
            "status": "建议",
            "signalStrength": topic["signalStrength"],
            "articleIds": topic["articleIds"],
            "existingTitles": linked_titles,
            "coveredStages": topic["stages"],
            "missingStages": topic["missingStages"],
            "nextArticle": f"{topic['label']}的{topic['missingStages'][0]}" if topic["missingStages"] else "为现有文章建立导读与互链",
        })

    topic_graph_edges = [
        {
            "id": f"edge-{article['id']}-{topic['id']}",
            "source": article["id"],
            "target": topic["id"],
            "type": "属于主题",
            "weight": 0.72,
            "confidence": "低",
            "status": "suggested",
            "algorithmVersion": ALGORITHM_VERSION,
            "createdBy": "wenmai-indexer",
            "evidence": ["标题、路径或正文关键词命中主题词表"],
        }
        for topic in topics
        for article in (article_by_id[article_id] for article_id in topic["evidenceObjectIds"] if article_id in article_by_id)
    ]

    artifacts = sorted(artifact_registry.values(), key=lambda item: item["id"])
    development_tree = build_development_tree(
        root,
        article_rows,
        artifacts,
        metadata_catalog,
        manifest_references,
        manifest_declarations,
        evidence_registry,
    )
    classified_objects = [
        *(article["classification"] for article in article_rows),
        *(version["classification"] for article in article_rows for version in article["versions"]),
        *(artifact["classification"] for artifact in artifacts),
        *(item["classification"] for item in metadata_catalog),
    ]
    classification_counts = Counter(str(item["class"]) for item in classified_objects)
    classification_payload = {
        "schemaVersion": "wenmai.corpus-classification/1.0",
        "ruleVersion": CLASSIFICATION_RULE_VERSION,
        "classes": [
            {"class": class_name, "description": description}
            for class_name, description in (
                ("published_article", "有精确制品路径/哈希绑定及真实发布状态的文章工件；目录词不够。"),
                ("draft_or_intermediate", "尚未由发布证据提升的工作稿、迭代稿或中间稿。"),
                ("platform_build", "面向特定平台构建但未证明发布的正文、定稿或平台稿。"),
                ("import_artifact", "用于平台导入的 DOCX/文本工件；只有额外精确发布声明才可提升。"),
                ("test_or_qa", "测试、QA、门禁、预检或审校工件。"),
                ("skill_summary_or_capability", "Skill 总结、能力晋升或能力清单工件。"),
                ("research_governance", "研究、治理、合同、流程、复盘或审计工件。"),
                ("tool", "提示词、提词器、构建器或创作工具工件。"),
                ("source_material", "采访、原始材料、来源论文或用户输入。"),
                ("manifest_or_metadata", "结构化 manifest、metadata 或稳定 ID 目录。"),
                ("evidence", "发布、交付、验收或公开核验的证据工件。"),
                ("catalog_only", "已入目录但尚无可验证工件绑定的记录。"),
            )
        ],
        "objectCoverage": {
            "articles": len(article_rows),
            "versions": sum(len(article["versions"]) for article in article_rows),
            "artifacts": len(artifacts),
            "metadata": len(metadata_catalog),
        },
        "counts": {class_name: classification_counts.get(class_name, 0) for class_name in CLASSIFICATION_CLASSES},
        "evidence": sorted(evidence_registry.values(), key=lambda item: str(item["id"])),
        "policy": {
            "publicationPromotion": "仅 qualifiesForRollup=true、按路径或 SHA-256 精确绑定且报告状态为有发布记录/曾公开核验的事件可提升为 published_article。",
            "weakEvidence": "README、会话、目录、标题和候选族只可支持低/中置信分类或 suggested 边。",
            "adoptionBoundary": "文件存在、Skill 名称或研究结论不等于能力已 adopted。",
        },
    }

    extension_counts = Counter(document.format for document in documents)
    kind_counts = Counter(article["kind"] for article in article_rows)
    status_counts = Counter(article["status"] for article in article_rows)
    publication_state_counts = Counter(article["publicationState"] for article in article_rows if article["kind"] == "文章")
    total_chars = sum(document.metrics["charCount"] for document in documents)
    artifact_conflicts = sum(1 for item in artifact_registry.values() if len(item["articleIds"]) > 1)
    current_artifact_hashes = set(artifact_registry)
    added_artifact_hashes = current_artifact_hashes - previous_artifact_hashes
    removed_artifact_hashes = previous_artifact_hashes - current_artifact_hashes
    unbound_metadata = sum(1 for item in metadata_catalog if item["associationStatus"] == "unbound")
    generated_at = datetime.now().astimezone().isoformat(timespec="seconds")
    next_id_map["generatedAt"] = generated_at
    next_id_map["algorithmVersion"] = ALGORITHM_VERSION

    payload = {
        "schemaVersion": "1.3.0",
        "algorithmVersion": ALGORITHM_VERSION,
        "generatedAt": generated_at,
        "sourceRootLabel": root.name,
        "stats": {
            "sourceFiles": len(documents),
            "articleFamilies": kind_counts.get("文章", 0),
            "contentFamilies": len(article_rows),
            "totalCharactersAcrossVersions": total_chars,
            "metadataFiles": len(metadata_catalog),
            "unboundMetadataFiles": unbound_metadata,
            "artifacts": len(artifact_registry),
            "previousBaselineArtifacts": len(previous_artifact_hashes),
            "currentArtifacts": len(current_artifact_hashes),
            "addedArtifactsSinceBaseline": len(added_artifact_hashes),
            "removedArtifactsSinceBaseline": len(removed_artifact_hashes),
            "artifactIdentityConflicts": artifact_conflicts,
            "relationEdges": len(graph_edges) + len(topic_graph_edges),
            "workRelationEdges": len(graph_edges),
            "topicCount": len(topics),
            "opportunityCount": len(opportunities),
            "classifiedObjects": len(classified_objects),
            "classificationCounts": {class_name: classification_counts.get(class_name, 0) for class_name in CLASSIFICATION_CLASSES},
            "developmentTreeNodes": development_tree["counts"]["nodes"],
            "developmentTreeEdges": development_tree["counts"]["edges"],
            "confirmedDevelopmentEdges": development_tree["counts"]["confirmed"],
            "suggestedDevelopmentEdges": development_tree["counts"]["suggested"],
            "extensionCounts": dict(sorted(extension_counts.items())),
            "kindCounts": dict(sorted(kind_counts.items())),
            "statusCounts": dict(sorted(status_counts.items())),
            "publicationStateCounts": dict(sorted(publication_state_counts.items())),
        },
        "baselineDefinitions": [
            {"key": "清晰度代理", "description": "句长、长句比例和抽象壳密度的组合；越高表示阅读阻力代理越低。"},
            {"key": "结构度代理", "description": "标题、段落数量和段落长度均衡度的组合。"},
            {"key": "证据密度代理", "description": "链接、数字、引语与证据提示词的密度。"},
            {"key": "具体性代理", "description": "案例、数字、引语等可核查细节相对抽象壳的密度。"},
            {"key": "版本成熟度代理", "description": "版本数量与当前稿件角色的组合，只说明流程成熟，不说明文字必然更好。"},
        ],
        "classification": classification_payload,
        "artifactBaselineDelta": {
            "basis": "data/article-id-map.json 中刷新前的 memberArtifactHashes 与当前实扫 SHA-256 集合比较",
            "previousBaseline": len(previous_artifact_hashes),
            "current": len(current_artifact_hashes),
            "added": len(added_artifact_hashes),
            "removed": len(removed_artifact_hashes),
            "addedArtifactIds": sorted(f"artifact-{digest[:12]}" for digest in added_artifact_hashes),
            "removedArtifactIds": sorted(f"artifact-{digest[:12]}" for digest in removed_artifact_hashes),
        },
        "developmentTree": development_tree,
        "articles": sorted(article_rows, key=lambda item: item["updatedAt"], reverse=True),
        "artifacts": artifacts,
        "topics": topics,
        "opportunities": opportunities[:18],
        "seriesSuggestions": series_suggestions,
        "graph": {
            "nodes": [
                {"id": article["id"], "label": article["title"], "type": "article", "size": min(28, 10 + article["versionCount"] * 2), "status": article["status"]}
                for article in article_rows
            ] + [
                {"id": topic["id"], "label": topic["label"], "type": "topic", "size": min(34, 12 + topic["articleCount"] * 3), "status": "主题"}
                for topic in topics
            ],
            "edges": graph_edges + topic_graph_edges,
        },
        "metadataCatalog": metadata_catalog,
        "analysisNotes": [
            "作品身份分为文章候选、平台变体、内容制品和路径别名；只有显式绑定才可进入高置信，标题与文本相似度只生成候选。",
            "同目录不构成证据关系；未精确匹配路径、哈希、标题或显式 ID 的 JSON 保留为未归属线索。",
            "DOCX 通过 OOXML 正文抽取；复杂文本框、批注和修订记录可能不完整。",
            "所有基线都是作品集内比较代理，不是文学质量、事实真伪或原创性判定。",
            "源文件保持只读；刷新只重写 wenmai-studio/data 下的生成索引与稳定 ID 映射。",
            "语料分类与开发树为增量字段；旧 graph 继续只承载 suggested 的主题候选关系。",
        ],
    }
    return payload, next_id_map


def main() -> int:
    parser = argparse.ArgumentParser(description="为文脉本地文章中台生成只读语料索引")
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[2])
    parser.add_argument("--output", type=Path, default=Path(__file__).resolve().parents[1] / "data" / "corpus.generated.json")
    parser.add_argument("--text-output", type=Path, default=Path(__file__).resolve().parents[1] / "data" / "version-text.generated.json")
    parser.add_argument("--id-map", type=Path, default=Path(__file__).resolve().parents[1] / "data" / "article-id-map.json")
    parser.add_argument("--max-chars", type=int, default=0, help="0 表示保存完整抽取正文；正数仅用于显式降采样")
    args = parser.parse_args()

    root = args.root.resolve()
    site_dir = Path(__file__).resolve().parents[1]
    payload, id_map = build_payload(root, site_dir, args.id_map, args.max_chars)
    text_blobs: dict[str, str] = {}
    version_text_map: dict[str, str] = {}
    for article in payload["articles"]:
        for version in article["versions"]:
            text = str(version.pop("text", ""))
            text_hash = str(version["textHash"])
            text_blobs.setdefault(text_hash, text)
            previous = version_text_map.get(str(version["id"]))
            if previous and previous != text_hash:
                raise RuntimeError(f"版本 ID 前缀冲突：{version['id']}")
            version_text_map[str(version["id"])] = text_hash
    text_payload = {
        "schemaVersion": "1.0.0",
        "algorithmVersion": ALGORITHM_VERSION,
        "generatedAt": payload["generatedAt"],
        "versions": version_text_map,
        "blobs": text_blobs,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.text_output.parent.mkdir(parents=True, exist_ok=True)
    args.id_map.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    args.text_output.write_text(json.dumps(text_payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    args.id_map.write_text(json.dumps(id_map, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({
        "ok": True,
        "output": str(args.output),
        "textOutput": str(args.text_output),
        "idMap": str(args.id_map),
        "stats": payload["stats"],
    }, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
