#!/usr/bin/env python3
"""Index local writing Skills, gates, workflows and templates without modifying them."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import stat
from collections import Counter, defaultdict
from datetime import datetime
from pathlib import Path
from typing import Any


SCHEMA_VERSION = "1.0.0"
SCRIPT_VERSION = "wenmai-capability-indexer/1.0.0"
DEFAULT_ROOTS = [
    ("Codex Skills", Path(os.environ.get("CODEX_HOME", Path.home() / ".codex")) / "skills"),
    ("Agent Skills", Path(os.environ.get("AGENTS_HOME", Path.home() / ".agents")) / "skills"),
]
PROJECT_ROOT = Path(__file__).resolve().parents[2]
SITE_ROOT = Path(__file__).resolve().parents[1]
EXCLUDED_PARTS = {
    ".git", "node_modules", ".next", "dist", ".wrangler", "__pycache__",
    "repair_backups", "backups", "backup", "qa", "delivery", "evidence",
}

DIMENSIONS = [
    ("commission", "委托", "是否能把读者、问题、边界和完成定义冻结成可执行委托？"),
    ("research", "研究", "是否能发现、获取、整理并追溯足够的材料？"),
    ("evidence", "证据", "事实、经历、推断和发布状态是否各有证据与边界？"),
    ("structure", "结构", "是否能选择主线、组织段落职责并管理系列关系？"),
    ("drafting", "写作", "是否能从委托和材料形成可编辑、可分支的正文？"),
    ("language", "表达", "中文是否自然、准确、可复述，并保留作者声音？"),
    ("visual", "视觉", "封面、插图和文档版式是否服务内容并可验收？"),
    ("quality", "质检", "机器检查与人工判断是否各守边界并绑定当前工件？"),
    ("packaging", "包装", "正文能否被安全转换为渠道、DOCX 或交付工件？"),
    ("publishing", "发布", "提交、后台发布、公开可见与结果是否分层验证？"),
    ("review", "复盘", "一次任务的经验能否进入候选、验证与回归，而非只留总结？"),
    ("orchestration", "编排", "人、Agent、脚本、门禁和恢复是否组成可追溯路线？"),
]

DIMENSION_RULES = [
    ("language", ["中文", "自然", "翻译腔", "表达", "copy", "文案", "字幕", "台词"]),
    ("publishing", ["发布", "publish", "bilibili", "小红书", "知乎", "飞书交付", "release"]),
    ("visual", ["图像", "图片", "封面", "视觉", "image", "figma", "slide", "幻灯片", "whiteboard"]),
    ("evidence", ["证据", "事实核验", "引用", "source", "reader-context", "回执", "可见性"]),
    ("quality", ["门禁", "gate", "validate", "验证", "qa", "test", "审校", "检查"]),
    ("orchestration", ["agent", "工作流", "workflow", "编排", "orchestrat", "automation", "loop"]),
    ("review", ["复盘", "经验", "learning", "内化", "沉淀", "回归", "retrospective"]),
    ("research", ["调研", "研究", "分析", "analyze", "analysis", "research", "archive", "知识图谱", "video", "chat"]),
    ("packaging", ["docx", "文档", "包装", "package", "交付", "转换"]),
    ("commission", ["选题", "委托", "brief", "策划", "需求"]),
    ("structure", ["结构", "叙事", "系列", "outline", "图谱", "story"]),
    ("drafting", ["写作", "文章", "创作", "write", "editor"]),
]

STAGE_RULES = {
    "commission": ["commission", "inbox"],
    "research": ["research"],
    "evidence": ["research", "review"],
    "structure": ["commission", "research", "draft"],
    "drafting": ["draft"],
    "language": ["draft", "review"],
    "visual": ["draft", "review", "distribution"],
    "quality": ["review", "approved"],
    "packaging": ["approved", "distribution"],
    "publishing": ["distribution", "maintain"],
    "review": ["review", "maintain"],
    "orchestration": ["commission", "research", "draft", "review", "distribution"],
}

LINK_RE = re.compile(r"\[[^\]]+\]\(([^)]+)\)")
URL_RE = re.compile(r"https?://[^\s)>\]}`'\"]+")
FRONTMATTER_RE = re.compile(r"\A---\s*\n(.*?)\n---\s*\n", re.S)


def digest_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def semantic_id(value: str) -> str:
    normalized = value.normalize("NFKC") if hasattr(value, "normalize") else value
    ascii_slug = re.sub(r"[^a-z0-9]+", "-", normalized.lower()).strip("-")
    if ascii_slug:
        return ascii_slug[:72]
    return "zh-" + hashlib.sha1(normalized.encode("utf-8")).hexdigest()[:12]


def read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8-sig", errors="replace")


def is_reparse_point(path: Path) -> bool:
    """Avoid following Windows junctions while discovering project-local files."""
    try:
        metadata = path.lstat()
        return bool(getattr(metadata, "st_file_attributes", 0) & stat.FILE_ATTRIBUTE_REPARSE_POINT) or path.is_symlink()
    except OSError:
        return True


def project_files(root: Path = PROJECT_ROOT) -> tuple[Path, ...]:
    files: list[Path] = []
    for current, directories, names in os.walk(root, topdown=True, followlinks=False):
        current_path = Path(current)
        directories[:] = sorted(directory for directory in directories if directory.lower() not in EXCLUDED_PARTS and not is_reparse_point(current_path / directory))
        files.extend(current_path / name for name in sorted(names))
    return tuple(sorted(files))


def parse_frontmatter(text: str, fallback_name: str) -> tuple[str, str]:
    match = FRONTMATTER_RE.match(text)
    if not match:
        first_heading = re.search(r"^#\s+(.+)$", text, re.M)
        return (first_heading.group(1).strip() if first_heading else fallback_name, "")
    block = match.group(1)
    name_match = re.search(r"^name:\s*['\"]?(.+?)['\"]?\s*$", block, re.M)
    description_match = re.search(r"^description:\s*(.+)$", block, re.M)
    description = description_match.group(1).strip().strip("'\"") if description_match else ""
    return (name_match.group(1).strip().strip("'\"") if name_match else fallback_name, description)


def dimension_for(*parts: str) -> str:
    weighted_parts = [(parts[0].lower() if parts else "", 6), (parts[1].lower() if len(parts) > 1 else "", 2)]
    if len(parts) > 2:
        weighted_parts.append((" ".join(parts[2:]).lower(), 1))
    scores: dict[str, int] = {dimension: 0 for dimension, _tokens in DIMENSION_RULES}
    for dimension, tokens in DIMENSION_RULES:
        for haystack, weight in weighted_parts:
            for token in tokens:
                if token.lower() in haystack:
                    scores[dimension] += weight
    return max(scores, key=scores.get) if any(scores.values()) else "drafting"


def material_kind(locator: str) -> str:
    lower = locator.lower()
    if lower.startswith(("http://", "https://")):
        return "url"
    suffix = Path(locator).suffix.lower()
    if suffix in {".py", ".ps1", ".js", ".ts", ".mjs", ".cmd", ".sh"}:
        return "script"
    if ".template." in lower or "template" in Path(locator).name.lower():
        return "template"
    if suffix in {".md", ".txt", ".docx", ".pdf", ".json", ".yaml", ".yml"}:
        return "document"
    return "local"


def material_record(locator: str, label: str, relation: str, base: Path | None = None) -> dict[str, Any]:
    is_url = locator.startswith(("http://", "https://"))
    resolved: Path | None = None
    if not is_url:
        candidate = Path(locator)
        resolved = candidate if candidate.is_absolute() else (base / candidate if base else candidate)
        try:
            resolved = resolved.resolve()
        except OSError:
            pass
        locator = str(resolved)
    stable = hashlib.sha1(locator.encode("utf-8")).hexdigest()[:12]
    return {
        "id": f"material:{stable}",
        "label": label.strip() or (Path(locator).name if not is_url else locator),
        "locator": locator,
        "kind": material_kind(locator),
        "relation": relation,
        "exists": None if is_url else bool(resolved and resolved.exists()),
    }


def extract_materials(text: str, base: Path, limit: int = 80) -> list[dict[str, Any]]:
    materials: dict[str, dict[str, Any]] = {}
    for target in LINK_RE.findall(text):
        target = target.strip().split("#", 1)[0]
        if not target or target.startswith(("#", "mailto:")):
            continue
        record = material_record(target, Path(target).name or target, "explicit", base)
        materials[record["locator"]] = record
    for url in URL_RE.findall(text):
        record = material_record(url.rstrip(".,;，。；"), url, "explicit")
        materials[record["locator"]] = record
    return list(materials.values())[:limit]


def scripts_for_skill(skill_dir: Path, text: str) -> tuple[list[str], list[dict[str, Any]]]:
    script_dir = skill_dir / "scripts"
    scripts: list[str] = []
    materials: list[dict[str, Any]] = []
    if not script_dir.is_dir():
        return scripts, materials
    for path in sorted(script_dir.rglob("*")):
        if not path.is_file() or path.suffix.lower() not in {".py", ".ps1", ".js", ".mjs", ".ts", ".cmd", ".sh"}:
            continue
        scripts.append(str(path.resolve()))
        relation = "explicit" if path.name in text or str(path.relative_to(skill_dir)).replace("\\", "/") in text else "inferred"
        materials.append(material_record(str(path.resolve()), path.name, relation))
    return scripts[:60], materials[:60]


def skill_records() -> tuple[list[dict[str, Any]], list[str], list[dict[str, str]]]:
    capabilities: list[dict[str, Any]] = []
    notes: list[str] = []
    roots_status: list[dict[str, str]] = []
    seen_names: dict[str, str] = {}
    duplicates: defaultdict[str, list[str]] = defaultdict(list)

    for root_label, root in DEFAULT_ROOTS:
        roots_status.append({"label": root_label, "path": str(root), "status": "available" if root.is_dir() else "missing"})
        if not root.is_dir():
            continue
        for skill_path in sorted(root.rglob("SKILL.md")):
            try:
                text = read_text(skill_path)
            except OSError:
                continue
            name, description = parse_frontmatter(text, skill_path.parent.name)
            normalized = re.sub(r"[^a-z0-9_-]+", "-", name.lower()).strip("-") or hashlib.sha1(str(skill_path).encode()).hexdigest()[:12]
            if normalized in seen_names:
                duplicates[normalized].append(str(skill_path.resolve()))
                continue
            seen_names[normalized] = str(skill_path.resolve())
            dimension = dimension_for(name, description, text[:3500])
            materials = extract_materials(text, skill_path.parent)
            scripts, script_materials = scripts_for_skill(skill_path.parent, text)
            material_map = {item["locator"]: item for item in materials}
            for item in script_materials:
                previous = material_map.get(item["locator"])
                if previous is None or previous["relation"] == "inferred":
                    material_map[item["locator"]] = item
            capabilities.append({
                "id": f"skill:{normalized}",
                "name": name,
                "description": description or "入口文件未提供结构化 description；需要打开原文件审阅。",
                "kind": "skill",
                "dimension": dimension,
                "stages": STAGE_RULES[dimension],
                "availability": "available",
                "indexedAdoption": "unassessed",
                "adoptionBasis": "仅确认当前可找到 Skill 入口；未由本次索引证明真实任务、反例、测试与回归。",
                "entryPath": str(skill_path.resolve()),
                "root": root_label,
                "gateInput": ["按 Skill 工作契约提供任务与所需工件"],
                "gateOutput": ["按 Skill 完成门槛产生工件与证据"],
                "scripts": scripts,
                "materials": list(material_map.values())[:100],
                "tags": sorted(set([dimension, "skill"] + (["has-script"] if scripts else []))),
                "sourceDigest": digest_text(text),
            })
    if duplicates:
        notes.append(f"发现 {sum(len(paths) for paths in duplicates.values())} 个同名 Skill 入口；元素表按名称去重并保留优先根，重复路径不代表多项能力。")
    return capabilities, notes, roots_status


def gate_records_from_skills(skills: list[dict[str, Any]]) -> list[dict[str, Any]]:
    gates: list[dict[str, Any]] = []
    seen: set[str] = set()
    for skill in skills:
        entry = Path(skill["entryPath"])
        skill_dir = entry.parent
        candidates: set[Path] = set()
        for folder_name in ("references", "scripts"):
            folder = skill_dir / folder_name
            if folder.is_dir():
                for path in folder.rglob("*"):
                    if not path.is_file():
                        continue
                    lower = path.name.lower()
                    if "gate" in lower or lower.startswith(("validate_", "scan_", "check_")):
                        if path.suffix.lower() in {".md", ".py", ".ps1", ".js", ".mjs", ".ts"}:
                            candidates.add(path)
        for path in sorted(candidates):
            key = str(path.resolve()).lower()
            if key in seen:
                continue
            seen.add(key)
            text = read_text(path) if path.suffix.lower() == ".md" else ""
            heading = re.search(r"^#\s+(.+)$", text, re.M) if text else None
            name = heading.group(1).strip() if heading else path.stem.replace("_", " ").replace("-", " ")
            dimension = dimension_for(name, text[:2500], skill["name"])
            materials = extract_materials(text, path.parent) if text else []
            gates.append({
                "id": f"gate:{skill['id'].removeprefix('skill:')}:{semantic_id(name)}",
                "name": name,
                "description": f"由 {skill['name']} 关联的本地门禁/检查入口；具体阻断条件以入口文件为准。",
                "kind": "gate" if "gate" in path.name.lower() or path.suffix.lower() == ".md" else "checker",
                "dimension": dimension,
                "stages": STAGE_RULES[dimension],
                "availability": "available",
                "indexedAdoption": "unassessed",
                "adoptionBasis": "文件存在只证明可找到入口；没有自动继承 Skill 的采用状态。",
                "entryPath": str(path.resolve()),
                "root": skill["id"],
                "gateInput": ["当前目标工件及入口说明要求的 manifest/参数"],
                "gateOutput": ["退出码、报告或逐项裁决；输出是否可放行以门禁说明为准"],
                "scripts": [str(path.resolve())] if path.suffix.lower() != ".md" else [],
                "materials": materials,
                "tags": sorted(set([dimension, "gate", "skill-linked"])),
                "sourceDigest": digest_text(text) if text else hashlib.sha256(path.read_bytes()).hexdigest(),
            })
    return gates


def project_gate_records(existing_paths: set[str], files: tuple[Path, ...]) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    registry_roots: set[Path] = set()
    for path in files:
        if path.name == "GATE_REGISTRY.md" and SITE_ROOT not in path.parents:
            registry_roots.add(path.parent)
    for path in files:
        if not path.is_file() or SITE_ROOT in path.parents:
            continue
        lower_parts = {part.lower() for part in path.parts}
        if "gates" in lower_parts:
            registry_roots.add(next((parent for parent in path.parents if parent.name.lower() == "gates"), path.parent))

    candidates: set[Path] = set()
    for root in registry_roots:
        if not root.is_dir():
            continue
        for path in project_files(root):
            if not path.is_file() or path.suffix.lower() not in {".md", ".py", ".ps1", ".js", ".mjs", ".ts", ".json"}:
                continue
            lower = path.name.lower()
            if path.name == "GATE_REGISTRY.md" or "gate" in lower or lower.startswith(("validate_", "scan_", "check_")):
                candidates.add(path)

    for path in sorted(candidates):
        absolute = str(path.resolve())
        if absolute.lower() in existing_paths:
            continue
        text = read_text(path) if path.suffix.lower() in {".md", ".py", ".ps1", ".js", ".mjs", ".ts", ".json"} else ""
        heading = re.search(r"^#\s+(.+)$", text, re.M)
        name = heading.group(1).strip() if heading else path.stem.replace("_", " ").replace("-", " ")
        dimension = dimension_for(name, text[:3000], absolute)
        records.append({
            "id": f"gate:project:{semantic_id(name)}",
            "name": name,
            "description": "项目级门禁、检查器或注册入口；索引不把历史 PASS 报告自动提升为当前采用证据。",
            "kind": "workflow" if path.name == "GATE_REGISTRY.md" else "gate" if path.suffix.lower() == ".md" else "checker",
            "dimension": dimension,
            "stages": STAGE_RULES[dimension],
            "availability": "available",
            "indexedAdoption": "unassessed",
            "adoptionBasis": "入口存在；采用范围、当前工件绑定和回归有效性需要单独审计。",
            "entryPath": absolute,
            "root": "Local article project",
            "gateInput": ["按项目门禁合同提供目标工件、manifest 或事件"],
            "gateOutput": ["报告、退出码或审计决定"],
            "scripts": [absolute] if path.suffix.lower() in {".py", ".ps1", ".js", ".mjs", ".ts"} else [],
            "materials": extract_materials(text, path.parent),
            "tags": sorted(set([dimension, "project-gate"])),
            "sourceDigest": digest_text(text),
        })
    return records


def project_workflow_records(existing_paths: set[str], files: tuple[Path, ...], limit: int = 80) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    candidates: set[Path] = set()
    for path in files:
        if not path.is_file() or path.suffix.lower() not in {".md", ".json", ".yaml", ".yml"}:
            continue
        lower_parts = {part.lower() for part in path.parts}
        if "data" in lower_parts:
            continue
        lower_name = path.name.lower()
        if any(token in lower_name for token in ("workflow", "recipe", "sop", "工作流", "流程")):
            candidates.add(path)
    for path in sorted(candidates, key=lambda item: (0 if SITE_ROOT in item.parents else 1, str(item).lower())):
        absolute = str(path.resolve())
        if absolute.lower() in existing_paths:
            continue
        text = read_text(path)
        heading = re.search(r"^#\s+(.+)$", text, re.M)
        name = heading.group(1).strip() if heading else path.stem.replace("_", " ").replace("-", " ")
        dimension = dimension_for(name, absolute, text[:2500])
        records.append({
            "id": f"workflow:project:{semantic_id(name)}",
            "name": name,
            "description": "本地项目中的工作流、SOP 或生产合同入口；存在不代表当前文章已经按此执行。",
            "kind": "workflow",
            "dimension": dimension,
            "stages": STAGE_RULES[dimension],
            "availability": "available",
            "indexedAdoption": "unassessed",
            "adoptionBasis": "仅确认流程入口可找到；运行记录、权限与当前采用范围需要另行核验。",
            "entryPath": absolute,
            "root": "Local article project",
            "gateInput": ["流程声明的输入、权限与当前工件"],
            "gateOutput": ["步骤工件、状态事件与完成证据"],
            "scripts": [],
            "materials": extract_materials(text, path.parent),
            "tags": sorted(set([dimension, "workflow"])),
            "sourceDigest": digest_text(text),
        })
        if len(records) >= limit:
            break
    return records


def template_records(skills: list[dict[str, Any]], limit: int = 120) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    seen: set[str] = set()
    for skill in skills:
        skill_dir = Path(skill["entryPath"]).parent
        for folder_name in ("assets", "templates"):
            folder = skill_dir / folder_name
            if not folder.is_dir():
                continue
            for path in sorted(folder.rglob("*")):
                if not path.is_file() or ("template" not in path.name.lower() and folder_name != "templates"):
                    continue
                absolute = str(path.resolve())
                if absolute.lower() in seen:
                    continue
                seen.add(absolute.lower())
                dimension = skill["dimension"]
                records.append({
                    "id": f"template:{skill['id'].removeprefix('skill:')}:{semantic_id(path.stem)}",
                    "name": path.name,
                    "description": f"由 {skill['name']} 提供的可复用模板；需要按原 Skill 的输入与验收使用。",
                    "kind": "template",
                    "dimension": dimension,
                    "stages": skill["stages"],
                    "availability": "available",
                    "indexedAdoption": "unassessed",
                    "adoptionBasis": "模板可找到；未单独证明其适用于当前文章。",
                    "entryPath": absolute,
                    "root": skill["id"],
                    "gateInput": ["模板要求的上下文和工件"],
                    "gateOutput": ["填充后的项目工件"],
                    "scripts": [],
                    "materials": [],
                    "tags": [dimension, "template"],
                    "sourceDigest": hashlib.sha256(path.read_bytes()).hexdigest(),
                })
                if len(records) >= limit:
                    return records
    return records


def merge_semantic_duplicates(records: list[dict[str, Any]], notes: list[str]) -> list[dict[str, Any]]:
    merged: dict[str, dict[str, Any]] = {}
    collisions = 0
    for record in records:
        current = merged.get(record["id"])
        if current is None:
            merged[record["id"]] = record
            continue
        collisions += 1
        entries = [current["entryPath"], record["entryPath"]]
        preferred = next((entry for entry in entries if entry.lower().endswith(".md")), entries[0])
        scripts = sorted(set(current["scripts"] + record["scripts"] + [entry for entry in entries if not entry.lower().endswith(".md")]))
        material_map = {item["locator"]: item for item in current["materials"] + record["materials"]}
        for entry in entries:
            if entry != preferred:
                linked = material_record(entry, Path(entry).name, "explicit")
                material_map[linked["locator"]] = linked
        current["entryPath"] = preferred
        current["scripts"] = scripts
        current["materials"] = list(material_map.values())
        current["tags"] = sorted(set(current["tags"] + record["tags"] + ["semantic-merge"]))
        current["sourceDigest"] = digest_text("\n".join(sorted([current["sourceDigest"], record["sourceDigest"]])))
    if collisions:
        notes.append(f"按语义 ID 合并 {collisions} 个同名门禁/脚本/模板入口；重复路径作为显式材料保留。")
    return list(merged.values())


def build_index() -> dict[str, Any]:
    skills, notes, roots = skill_records()
    gates = gate_records_from_skills(skills)
    gate_paths = {item["entryPath"].lower() for item in gates}
    discovered_project_files = project_files()
    project_gates = project_gate_records(gate_paths, discovered_project_files)
    workflow_paths = gate_paths | {item["entryPath"].lower() for item in project_gates}
    workflows = project_workflow_records(workflow_paths, discovered_project_files)
    templates = template_records(skills)
    capabilities = merge_semantic_duplicates(skills + gates + project_gates + workflows + templates, notes)
    capabilities = sorted(capabilities, key=lambda item: (next(i for i, dim in enumerate(DIMENSIONS) if dim[0] == item["dimension"]), item["kind"], item["name"].lower()))

    kind_counts = Counter(item["kind"] for item in capabilities)
    explicit_links = sum(1 for item in capabilities for material in item["materials"] if material["relation"] == "explicit")
    inferred_links = sum(1 for item in capabilities for material in item["materials"] if material["relation"] == "inferred")
    gaps: list[dict[str, Any]] = []
    for dimension, label, _question in DIMENSIONS:
        items = [item for item in capabilities if item["dimension"] == dimension]
        kinds = {item["kind"] for item in items}
        if not items:
            severity = "high"
            rationale = f"当前索引没有发现归入“{label}”维度的能力入口；这是一条待核实缺口，不等于本地一定没有相关经验。"
            missing = ["skill", "gate"]
        elif "skill" not in kinds:
            severity = "medium"
            rationale = f"“{label}”有检查或模板，但没有独立 Skill 入口；执行方法和所有权可能不够清楚。"
            missing = ["skill"]
        elif not ({"gate", "checker"} & kinds):
            severity = "medium"
            rationale = f"“{label}”已有 Skill，但当前索引未发现确定性门禁或检查器；完成标准可能主要依赖人工。"
            missing = ["gate"]
        else:
            severity = "low"
            rationale = f"“{label}”同时有方法与检查入口；仍需逐项核对真实任务证据和采用范围。"
            missing = []
        gaps.append({
            "id": f"gap:{dimension}", "dimension": dimension, "label": f"{label}能力覆盖",
            "severity": severity, "rationale": rationale, "missingKinds": missing,
            "nextAction": "从真实失败或重复返工中选择一个代表任务，补齐范围、反例、入口、负责人和回归。" if missing else "审计现有入口的证据、重复所有权和回归新鲜度。",
        })

    notes.extend([
        f"索引器版本：{SCRIPT_VERSION}。所有源 Skill、门禁和项目文件保持只读。",
        "available 只表示入口可找到；candidate/tested/adopted 不由文件存在或历史 PASS 自动推导。",
        "材料关系来自入口文件中的显式链接或同 Skill 脚本目录的保守推断；推断关系不代表规范所有权。",
        "元素维度由关键词路由，只用于发现和导航，不是能力正确率或质量评分。",
    ])
    return {
        "schemaVersion": SCHEMA_VERSION,
        "generatedAt": datetime.now().astimezone().isoformat(timespec="seconds"),
        "roots": roots + [{"label": "Local article project", "path": str(PROJECT_ROOT), "status": "available"}],
        "dimensions": [{"id": dim, "label": label, "question": question, "order": index} for index, (dim, label, question) in enumerate(DIMENSIONS)],
        "stats": {
            "capabilities": len(capabilities), "skills": kind_counts["skill"], "gates": kind_counts["gate"] + kind_counts["checker"],
            "workflows": kind_counts["workflow"], "templates": kind_counts["template"],
            "explicitMaterialLinks": explicit_links, "inferredMaterialLinks": inferred_links,
        },
        "capabilities": capabilities,
        "gaps": gaps,
        "notes": notes,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, default=SITE_ROOT / "data" / "capabilities.generated.json")
    args = parser.parse_args()
    payload = build_index()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"output": str(args.output), "stats": payload["stats"], "gaps": Counter(item["severity"] for item in payload["gaps"])}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
