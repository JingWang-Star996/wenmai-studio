#!/usr/bin/env python3
"""Validate Wenmai's generated capability index without mutating it."""

from __future__ import annotations

import argparse
import json
import re
import sys
from collections import Counter
from datetime import datetime
from pathlib import Path
from typing import Any


EXPECTED_SCHEMA_VERSION = "1.0.0"
ALLOWED_AVAILABILITY = {"available", "missing", "unreadable"}
ALLOWED_ADOPTION = {"unassessed", "candidate", "tested", "verified", "adopted", "deferred", "rejected"}
ALLOWED_KINDS = {"skill", "gate", "checker", "workflow", "template"}
ALLOWED_RELATIONS = {"explicit", "inferred"}
ALLOWED_GAP_SEVERITY = {"low", "medium", "high"}
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")


def is_nonempty_string(value: Any) -> bool:
    return isinstance(value, str) and bool(value.strip())


def add_error(errors: list[str], location: str, message: str) -> None:
    errors.append(f"{location}: {message}")


def validate_material(
    material: Any,
    location: str,
    errors: list[str],
    relations: Counter[str],
) -> None:
    if not isinstance(material, dict):
        add_error(errors, location, "must be an object")
        return

    for field in ("id", "label", "locator", "kind", "relation"):
        if not is_nonempty_string(material.get(field)):
            add_error(errors, f"{location}.{field}", "must be a non-empty string")

    material_id = material.get("id")
    if is_nonempty_string(material_id) and not material_id.startswith("material:"):
        add_error(errors, f"{location}.id", "must start with 'material:'")

    relation = material.get("relation")
    if relation not in ALLOWED_RELATIONS:
        add_error(errors, f"{location}.relation", f"must be one of {sorted(ALLOWED_RELATIONS)}")
    else:
        relations[relation] += 1

    exists = material.get("exists", "__missing__")
    if exists == "__missing__":
        add_error(errors, f"{location}.exists", "is required to distinguish unresolved local links from URLs")
    elif exists is not None and not isinstance(exists, bool):
        add_error(errors, f"{location}.exists", "must be true, false, or null")
    elif material.get("kind") == "url" and exists is not None:
        add_error(errors, f"{location}.exists", "must be null for URL materials")
    elif material.get("kind") != "url" and exists is None:
        add_error(errors, f"{location}.exists", "must be boolean for local materials")


def validate_payload(payload: Any) -> tuple[list[str], list[str], dict[str, Any]]:
    errors: list[str] = []
    warnings: list[str] = []

    if not isinstance(payload, dict):
        return ["$: top-level value must be an object"], warnings, {}

    schema_version = payload.get("schemaVersion")
    if schema_version != EXPECTED_SCHEMA_VERSION:
        add_error(errors, "$.schemaVersion", f"expected {EXPECTED_SCHEMA_VERSION!r}, got {schema_version!r}")

    generated_at = payload.get("generatedAt")
    if not is_nonempty_string(generated_at):
        add_error(errors, "$.generatedAt", "must be a non-empty ISO-8601 string")
    else:
        try:
            datetime.fromisoformat(generated_at.replace("Z", "+00:00"))
        except ValueError:
            add_error(errors, "$.generatedAt", "must be a valid ISO-8601 timestamp")

    dimensions = payload.get("dimensions")
    dimension_ids: set[str] = set()
    if not isinstance(dimensions, list) or not dimensions:
        add_error(errors, "$.dimensions", "must be a non-empty array")
    else:
        for index, dimension in enumerate(dimensions):
            location = f"$.dimensions[{index}]"
            if not isinstance(dimension, dict):
                add_error(errors, location, "must be an object")
                continue
            dimension_id = dimension.get("id")
            if not is_nonempty_string(dimension_id):
                add_error(errors, f"{location}.id", "must be a non-empty string")
            elif dimension_id in dimension_ids:
                add_error(errors, f"{location}.id", f"duplicate dimension ID {dimension_id!r}")
            else:
                dimension_ids.add(dimension_id)
            for field in ("label", "question"):
                if not is_nonempty_string(dimension.get(field)):
                    add_error(errors, f"{location}.{field}", "must be a non-empty string")
            if not isinstance(dimension.get("order"), int):
                add_error(errors, f"{location}.order", "must be an integer")

    roots = payload.get("roots")
    if not isinstance(roots, list) or not roots:
        add_error(errors, "$.roots", "must be a non-empty array")
    else:
        for index, root in enumerate(roots):
            location = f"$.roots[{index}]"
            if not isinstance(root, dict):
                add_error(errors, location, "must be an object")
                continue
            for field in ("label", "path"):
                if not is_nonempty_string(root.get(field)):
                    add_error(errors, f"{location}.{field}", "must be a non-empty string")
            if root.get("status") not in ALLOWED_AVAILABILITY:
                add_error(errors, f"{location}.status", f"must be one of {sorted(ALLOWED_AVAILABILITY)}")

    capabilities = payload.get("capabilities")
    capability_ids: set[str] = set()
    kind_counts: Counter[str] = Counter()
    availability_counts: Counter[str] = Counter()
    adoption_counts: Counter[str] = Counter()
    relation_counts: Counter[str] = Counter()
    unresolved_local = 0

    if not isinstance(capabilities, list) or not capabilities:
        add_error(errors, "$.capabilities", "must be a non-empty array")
        capabilities = []

    for index, capability in enumerate(capabilities):
        location = f"$.capabilities[{index}]"
        if not isinstance(capability, dict):
            add_error(errors, location, "must be an object")
            continue

        capability_id = capability.get("id")
        if not is_nonempty_string(capability_id):
            add_error(errors, f"{location}.id", "must be a non-empty string")
        elif capability_id in capability_ids:
            add_error(errors, f"{location}.id", f"duplicate capability ID {capability_id!r}")
        else:
            capability_ids.add(capability_id)

        for field in ("name", "description", "entryPath", "root", "adoptionBasis"):
            if not is_nonempty_string(capability.get(field)):
                add_error(errors, f"{location}.{field}", "must be a non-empty string")

        kind = capability.get("kind")
        if kind not in ALLOWED_KINDS:
            add_error(errors, f"{location}.kind", f"must be one of {sorted(ALLOWED_KINDS)}")
        else:
            kind_counts[kind] += 1

        dimension = capability.get("dimension")
        if dimension not in dimension_ids:
            add_error(errors, f"{location}.dimension", f"unknown dimension {dimension!r}")

        availability = capability.get("availability")
        if availability not in ALLOWED_AVAILABILITY:
            add_error(errors, f"{location}.availability", f"must be one of {sorted(ALLOWED_AVAILABILITY)}")
        else:
            availability_counts[availability] += 1

        adoption = capability.get("indexedAdoption")
        if adoption not in ALLOWED_ADOPTION:
            add_error(errors, f"{location}.indexedAdoption", f"must be one of {sorted(ALLOWED_ADOPTION)}")
        else:
            adoption_counts[adoption] += 1
            if adoption != "unassessed":
                evidence = capability.get("adoptionEvidence")
                if not isinstance(evidence, list) or not evidence:
                    add_error(
                        errors,
                        f"{location}.adoptionEvidence",
                        "is required when indexedAdoption is not 'unassessed'; availability alone is not adoption evidence",
                    )

        for field in ("stages", "gateInput", "gateOutput", "scripts", "tags"):
            value = capability.get(field)
            if not isinstance(value, list):
                add_error(errors, f"{location}.{field}", "must be an array")
            elif field in {"stages", "gateInput", "gateOutput"} and not value:
                add_error(errors, f"{location}.{field}", "must not be empty")
            elif any(not is_nonempty_string(item) for item in value):
                add_error(errors, f"{location}.{field}", "must contain only non-empty strings")

        source_digest = capability.get("sourceDigest")
        if not is_nonempty_string(source_digest) or not SHA256_RE.fullmatch(source_digest):
            add_error(errors, f"{location}.sourceDigest", "must be a lowercase SHA-256 hex digest")

        materials = capability.get("materials")
        if not isinstance(materials, list):
            add_error(errors, f"{location}.materials", "must be an array")
            continue
        material_ids: set[str] = set()
        material_locators: set[str] = set()
        for material_index, material in enumerate(materials):
            material_location = f"{location}.materials[{material_index}]"
            validate_material(material, material_location, errors, relation_counts)
            if not isinstance(material, dict):
                continue
            material_id = material.get("id")
            locator = material.get("locator")
            if is_nonempty_string(material_id):
                if material_id in material_ids:
                    add_error(errors, f"{material_location}.id", f"duplicate material ID within capability: {material_id!r}")
                material_ids.add(material_id)
            if is_nonempty_string(locator):
                if locator in material_locators:
                    add_error(errors, f"{material_location}.locator", f"duplicate locator within capability: {locator!r}")
                material_locators.add(locator)
            if material.get("kind") != "url" and material.get("exists") is False:
                unresolved_local += 1

    stats = payload.get("stats")
    expected_stats = {
        "capabilities": len(capabilities),
        "skills": kind_counts["skill"],
        "gates": kind_counts["gate"] + kind_counts["checker"],
        "workflows": kind_counts["workflow"],
        "templates": kind_counts["template"],
        "explicitMaterialLinks": relation_counts["explicit"],
        "inferredMaterialLinks": relation_counts["inferred"],
    }
    if not isinstance(stats, dict):
        add_error(errors, "$.stats", "must be an object")
    else:
        for field, expected in expected_stats.items():
            if stats.get(field) != expected:
                add_error(errors, f"$.stats.{field}", f"expected {expected}, got {stats.get(field)!r}")

    gaps = payload.get("gaps")
    gap_ids: set[str] = set()
    if not isinstance(gaps, list):
        add_error(errors, "$.gaps", "must be an array")
    else:
        for index, gap in enumerate(gaps):
            location = f"$.gaps[{index}]"
            if not isinstance(gap, dict):
                add_error(errors, location, "must be an object")
                continue
            gap_id = gap.get("id")
            if not is_nonempty_string(gap_id):
                add_error(errors, f"{location}.id", "must be a non-empty string")
            elif gap_id in gap_ids:
                add_error(errors, f"{location}.id", f"duplicate gap ID {gap_id!r}")
            else:
                gap_ids.add(gap_id)
            if gap.get("dimension") not in dimension_ids:
                add_error(errors, f"{location}.dimension", f"unknown dimension {gap.get('dimension')!r}")
            if gap.get("severity") not in ALLOWED_GAP_SEVERITY:
                add_error(errors, f"{location}.severity", f"must be one of {sorted(ALLOWED_GAP_SEVERITY)}")
            for field in ("label", "rationale", "nextAction"):
                if not is_nonempty_string(gap.get(field)):
                    add_error(errors, f"{location}.{field}", "must be a non-empty string")
            if not isinstance(gap.get("missingKinds"), list):
                add_error(errors, f"{location}.missingKinds", "must be an array")

    notes = payload.get("notes")
    if not isinstance(notes, list) or any(not is_nonempty_string(note) for note in notes):
        add_error(errors, "$.notes", "must be an array of non-empty strings")

    if unresolved_local:
        warnings.append(f"{unresolved_local} local material links are unresolved; they remain indexed and are not schema failures")

    summary = {
        "schemaVersion": schema_version,
        "capabilities": len(capabilities),
        "uniqueCapabilityIds": len(capability_ids),
        "availability": dict(sorted(availability_counts.items())),
        "adoption": dict(sorted(adoption_counts.items())),
        "materials": {
            "total": sum(relation_counts.values()),
            "explicit": relation_counts["explicit"],
            "inferred": relation_counts["inferred"],
            "unresolvedLocal": unresolved_local,
        },
    }
    return errors, warnings, summary


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", type=Path, required=True, help="Path to capabilities.generated.json")
    args = parser.parse_args()

    try:
        payload = json.loads(args.input.read_text(encoding="utf-8-sig"))
    except FileNotFoundError:
        result = {"valid": False, "errors": [f"input file not found: {args.input}"]}
        print(json.dumps(result, ensure_ascii=False), file=sys.stderr)
        return 1
    except (OSError, json.JSONDecodeError) as exc:
        result = {"valid": False, "errors": [f"could not read valid JSON from {args.input}: {exc}"]}
        print(json.dumps(result, ensure_ascii=False), file=sys.stderr)
        return 1

    errors, warnings, summary = validate_payload(payload)
    result = {"valid": not errors, **summary, "warnings": warnings, "errors": errors}
    stream = sys.stdout if not errors else sys.stderr
    print(json.dumps(result, ensure_ascii=False), file=stream)
    return 0 if not errors else 1


if __name__ == "__main__":
    raise SystemExit(main())
