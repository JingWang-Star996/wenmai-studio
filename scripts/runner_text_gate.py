#!/usr/bin/env python3
"""Run Wenmai's deterministic Chinese body gates on one frozen Runner input."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
import tempfile
from pathlib import Path
from typing import Any


SCHEMA_VERSION = "wenmai.text-gates/1.0"
INPUT_SCHEMA_VERSION = "wenmai.runner-input/1.0"
RUNNER_ACTION = "text-gates"
GATE_SUITE_ID = "builtin:text-suite-v1"
MAX_INPUT_BYTES = 1_048_576
MAX_BODY_CHARACTERS = 500_000
SHA256_RE = re.compile(r"^[a-f0-9]{64}$")
HEADING_RE = re.compile(r"^\s{0,3}#{1,6}\s+\S")
PLACEHOLDER_RE = re.compile(r"TODO|TBD|FIXME|待补|待核|占位|【[^】]{0,16}(?:待|TODO)[^】]*】", re.IGNORECASE)


class GateInputError(ValueError):
    pass


def sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def utf16_length(value: str) -> int:
    """Match JavaScript string.length for parity with the built-in TypeScript gate."""
    return len(value.encode("utf-16-le")) // 2


def required_string(payload: dict[str, Any], name: str, maximum: int, preserve_whitespace: bool = False) -> str:
    value = payload.get(name)
    if not isinstance(value, str):
        raise GateInputError(f"{name} must be a string")
    normalized = value if preserve_whitespace else value.strip()
    if not normalized.strip():
        raise GateInputError(f"{name} must not be empty")
    if len(normalized) > maximum:
        raise GateInputError(f"{name} exceeds {maximum} characters")
    return normalized


def canonical_json(payload: Any) -> str:
    return json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def required_sha256(payload: dict[str, Any], name: str) -> str:
    value = payload.get(name)
    if not isinstance(value, str) or not SHA256_RE.fullmatch(value):
        raise GateInputError(f"{name} must be a lowercase SHA-256 digest")
    return value


def evaluate_text_gates(envelope: dict[str, Any]) -> dict[str, Any]:
    if envelope.get("schemaVersion") != INPUT_SCHEMA_VERSION:
        raise GateInputError(f"schemaVersion must be {INPUT_SCHEMA_VERSION!r}")
    if envelope.get("action") != RUNNER_ACTION:
        raise GateInputError(f"action must be {RUNNER_ACTION!r}")
    input_sha256 = required_sha256(envelope, "inputSha256")
    payload = envelope.get("input")
    if not isinstance(payload, dict):
        raise GateInputError("input must be a JSON object")
    if sha256_text(canonical_json(payload)) != input_sha256:
        raise GateInputError("inputSha256 does not match the canonical input envelope")

    if payload.get("runnerAction") != RUNNER_ACTION:
        raise GateInputError(f"input.runnerAction must be {RUNNER_ACTION!r}")
    article_id = required_string(payload, "articleId", 120)
    branch_id = required_string(payload, "branchId", 120)
    base_revision_id = required_string(payload, "baseRevisionId", 120)
    title = required_string(payload, "title", 240)
    body = required_string(payload, "bodyText", MAX_BODY_CHARACTERS, preserve_whitespace=True)
    body_sha256 = required_sha256(payload, "bodySha256")
    observed_sha256 = sha256_text(body)
    if observed_sha256 != body_sha256:
        raise GateInputError("bodySha256 does not match bodyText")

    compact_body = re.sub(r"\s", "", body)
    compact_length = utf16_length(compact_body)
    headings = sum(1 for line in body.split("\n") if HEADING_RE.match(line))
    paragraphs = sum(1 for part in re.split(r"\n\s*\n", body) if part.strip())
    sentences = [re.sub(r"\s", "", part) for part in re.split(r"[。！？!?]+", body)]
    sentences = [part for part in sentences if part]
    long_sentences = sum(1 for sentence in sentences if utf16_length(sentence) > 60)
    long_ratio = long_sentences / len(sentences) if sentences else 0.0
    rounded_long_ratio = float(f"{long_ratio:.4f}")
    placeholders = PLACEHOLDER_RE.findall(body)
    distinct_placeholders = list(dict.fromkeys(placeholders))[:8]

    title_length = utf16_length(title.strip())
    gates = [
        {
            "gateId": "builtin:title-v1",
            "gateLabel": "标题长度",
            "result": "pass" if 4 <= title_length <= 120 else "fail",
            "evidence": [f"标题长度 {title_length} 字符；规则范围 4–120。"],
            "details": {"maximum": 120, "minimum": 4, "titleLength": title_length},
        },
        {
            "gateId": "builtin:structure-v1",
            "gateLabel": "长文结构",
            "result": (
                "inconclusive"
                if compact_length < 800
                else "pass"
                if paragraphs >= 3 and (compact_length < 1200 or headings >= 1)
                else "fail"
            ),
            "evidence": [f"正文 {compact_length} 字，{paragraphs} 个段落，{headings} 个 Markdown 标题。"],
            "details": {"compactLength": compact_length, "headings": headings, "paragraphs": paragraphs},
        },
        {
            "gateId": "builtin:long-sentence-v1",
            "gateLabel": "长句提醒",
            "result": "inconclusive" if len(sentences) < 4 else "pass" if long_ratio <= 0.2 else "fail",
            "evidence": [
                f"{len(sentences)} 个可识别句子中有 {long_sentences} 个超过 60 字；占比 {long_ratio * 100:.1f}%。"
            ],
            "details": {
                "longRatio": rounded_long_ratio,
                "longSentences": long_sentences,
                "sentences": len(sentences),
                "threshold": 0.2,
            },
        },
        {
            "gateId": "builtin:placeholder-v1",
            "gateLabel": "占位符扫描",
            "result": "pass" if not placeholders else "fail",
            "evidence": (
                [f"发现 {len(placeholders)} 个待补/占位标记：{'、'.join(distinct_placeholders)}"]
                if placeholders
                else ["未发现内置词表中的待补或占位标记。"]
            ),
            "details": {"placeholderCount": len(placeholders)},
        },
    ]
    results = [gate["result"] for gate in gates]
    suite_result = "fail" if "fail" in results else "inconclusive" if "inconclusive" in results else "pass"
    return {
        "schemaVersion": SCHEMA_VERSION,
        "action": RUNNER_ACTION,
        "gateSuiteId": GATE_SUITE_ID,
        "articleId": article_id,
        "branchId": branch_id,
        "baseRevisionId": base_revision_id,
        "bodySha256": body_sha256,
        "inputSha256": input_sha256,
        "result": suite_result,
        "summary": {
            "fail": results.count("fail"),
            "inconclusive": results.count("inconclusive"),
            "pass": results.count("pass"),
            "total": len(results),
        },
        "gates": gates,
    }


def read_input(path: Path) -> dict[str, Any]:
    try:
        size = path.stat().st_size
    except OSError as exc:
        raise GateInputError(f"input cannot be inspected: {exc}") from exc
    if size > MAX_INPUT_BYTES:
        raise GateInputError(f"input exceeds {MAX_INPUT_BYTES} bytes")
    try:
        payload = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise GateInputError(f"input must be valid UTF-8 JSON: {exc}") from exc
    if not isinstance(payload, dict):
        raise GateInputError("input JSON must be an object")
    return payload


def atomic_write(path: Path, text: str) -> None:
    parent = path.parent
    if not parent.is_dir():
        raise OSError(f"output parent does not exist: {parent}")
    temporary: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            newline="\n",
            prefix=f".{path.name}.",
            suffix=".tmp",
            dir=parent,
            delete=False,
        ) as handle:
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
            temporary = Path(handle.name)
        os.replace(temporary, path)
        temporary = None
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()

    try:
        if args.input.resolve() == args.output.resolve():
            raise GateInputError("input and output paths must differ")
        result = evaluate_text_gates(read_input(args.input))
        output_text = canonical_json(result) + "\n"
        atomic_write(args.output, output_text)
    except GateInputError as exc:
        print(json.dumps({"ok": False, "errorClass": "invalid_input", "error": str(exc)}, ensure_ascii=False), file=sys.stderr)
        return 2
    except OSError as exc:
        print(json.dumps({"ok": False, "errorClass": "output_error", "error": str(exc)}, ensure_ascii=False), file=sys.stderr)
        return 3

    print(
        json.dumps(
            {
                "ok": True,
                "schemaVersion": SCHEMA_VERSION,
                "inputSha256": result["inputSha256"],
                "outputSha256": sha256_text(output_text),
                "result": result["result"],
            },
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
