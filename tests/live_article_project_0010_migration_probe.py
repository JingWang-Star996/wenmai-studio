#!/usr/bin/env python3
"""Verify the 0010 migration on fresh and representative 0009 SQLite baselines."""

from __future__ import annotations

import argparse
import hashlib
import json
import sqlite3
import tempfile
from contextlib import closing
from pathlib import Path
from typing import Any


class ProbeFailure(RuntimeError):
    pass


def sha(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def statements(path: Path) -> list[str]:
    return [item.strip() for item in path.read_text(encoding="utf-8").split("--> statement-breakpoint") if item.strip()]


def apply_migrations(connection: sqlite3.Connection, files: list[Path]) -> None:
    for path in files:
        for statement in statements(path):
            connection.execute(statement)
    connection.commit()


def seed_bound_case(connection: sqlite3.Connection, *, suffix: str, dirty: bool,
                    broken_dirty_sha: bool = False) -> dict[str, Any]:
    package_id = f"pkg-migration-{suffix}"
    article_id = f"article-migration-{suffix}"
    branch_id = f"branch-migration-{suffix}"
    revision_id = f"revision-migration-{suffix}"
    composition_id = f"composition-migration-{suffix}"
    module_id = f"module-migration-{suffix}"
    materialization_id = f"materialization-migration-{suffix}"
    now = "2026-08-17T00:00:00.000Z"
    body = f"# {suffix}\n\nlegacy body"
    body_sha = sha(body)
    composition_document = json.dumps({"case": suffix, "version": 1}, separators=(",", ":"))
    composition_document_sha = sha(composition_document)
    working_document = composition_document if not dirty else json.dumps(
        {"case": suffix, "version": 1 if broken_dirty_sha else 2}, separators=(",", ":")
    )
    working_document_sha = sha(working_document)
    composition_sha = sha(f"composition:{suffix}")
    connection.execute(
        "INSERT INTO article_revisions (id,article_id,branch_id,sequence,parent_revision_id,merge_parent_revision_id,"
        "source_version_id,title,document_title,annotation,body_text,body_sha256,author_kind,created_at) "
        "VALUES (?,?,?,1,NULL,NULL,NULL,?,?, '',?,?, 'user',?)",
        (revision_id, article_id, branch_id, suffix, suffix, body, body_sha, now),
    )
    connection.execute(
        "INSERT INTO article_branches (id,article_id,name,slug,color,status,head_revision_id,base_revision_id,"
        "base_source_version_id,created_at,updated_at) VALUES (?,?,?,?,?,'active',?,?,NULL,?,?)",
        (branch_id, article_id, suffix, suffix, "cyan", revision_id, revision_id, now, now),
    )
    connection.execute(
        "INSERT INTO branch_working_copies (branch_id,article_id,base_revision_id,title,annotation,body_text,"
        "body_sha256,dirty,lock_version,updated_at) VALUES (?,?,?,?, '',?,?,0,4,?)",
        (branch_id, article_id, revision_id, suffix, body, body_sha, now),
    )
    connection.execute(
        "INSERT INTO article_project_packages (id,project_id,article_id,title,schema_version,main_composition_id,"
        "main_composition_sha256,status,lock_version,created_at,updated_at,primary_branch_id) "
        "VALUES (?,NULL,?,?, 'wenmai-package-v1',?,?,'active',9,?,?,?)",
        (package_id, article_id, suffix, composition_id, composition_sha, now, now, branch_id),
    )
    connection.execute(
        "INSERT INTO package_compositions (id,package_id,parent_composition_id,title,schema_version,root_module_id,"
        "document_json,document_sha256,manifest_json,composition_sha256,source_article_revision_id,author_kind,"
        "source_patch_id,created_at) VALUES (?,?,NULL,?,'wenmai-composition-v1',?,?,?,'{}',?,?,'user',NULL,?)",
        (composition_id, package_id, suffix, module_id, composition_document, composition_document_sha,
         composition_sha, revision_id, now),
    )
    connection.execute(
        "INSERT INTO package_working_copies (package_id,base_composition_id,document_json,document_sha256,dirty,"
        "lock_version,updated_at,branch_id,base_revision_id) VALUES (?,?,?,?,?,7,?,?,?)",
        (package_id, composition_id, working_document, working_document_sha, 1 if dirty else 0,
         now, branch_id, revision_id),
    )
    connection.execute(
        "INSERT INTO package_composition_materializations (id,package_id,branch_id,composition_id,composition_sha256,"
        "article_revision_id,article_body_sha256,renderer_key,renderer_version,created_by_kind,created_at) "
        "VALUES (?,?,?,?,?,?,?,'wenmai.package-markdown','1','user',?)",
        (materialization_id, package_id, branch_id, composition_id, composition_sha, revision_id, body_sha, now),
    )
    return {
        "package_id": package_id,
        "branch_id": branch_id,
        "revision_id": revision_id,
        "composition_id": composition_id,
        "composition_sha": composition_sha,
        "working_document": working_document,
        "working_document_sha": working_document_sha,
    }


def seed_unbound_case(connection: sqlite3.Connection) -> str:
    package_id = "pkg-migration-unbound"
    composition_id = "composition-migration-unbound"
    document = '{"case":"unbound"}'
    document_sha = sha(document)
    composition_sha = sha("composition:unbound")
    now = "2026-08-17T00:00:00.000Z"
    connection.execute(
        "INSERT INTO article_project_packages (id,project_id,article_id,title,schema_version,main_composition_id,"
        "main_composition_sha256,status,lock_version,created_at,updated_at,primary_branch_id) "
        "VALUES (?,NULL,'article-migration-unbound','unbound','wenmai-package-v1',?,?,'active',1,?,?,NULL)",
        (package_id, composition_id, composition_sha, now, now),
    )
    connection.execute(
        "INSERT INTO package_compositions (id,package_id,parent_composition_id,title,schema_version,root_module_id,"
        "document_json,document_sha256,manifest_json,composition_sha256,source_article_revision_id,author_kind,"
        "source_patch_id,created_at) VALUES (?,?,NULL,'unbound','wenmai-composition-v1','module-unbound',?,?, '{}',?,NULL,'user',NULL,?)",
        (composition_id, package_id, document, document_sha, composition_sha, now),
    )
    connection.execute(
        "INSERT INTO package_working_copies (package_id,base_composition_id,document_json,document_sha256,dirty,"
        "lock_version,updated_at,branch_id,base_revision_id) VALUES (?,?,?,?,0,1,?,NULL,NULL)",
        (package_id, composition_id, document, document_sha, now),
    )
    return package_id


def one(connection: sqlite3.Connection, sql: str, bindings: tuple[Any, ...] = ()) -> sqlite3.Row:
    row = connection.execute(sql, bindings).fetchone()
    if row is None:
        raise ProbeFailure(f"query returned no row: {sql}")
    return row


def run_probe(root: Path) -> dict[str, Any]:
    migrations = sorted((root / "drizzle").glob("*.sql"))
    through_0010 = [path for path in migrations if int(path.name[:4]) <= 10]
    migration_0010 = next((path for path in migrations if path.name == "0010_wide_silver_sable.sql"), None)
    if len(through_0010) != 11 or migration_0010 is None or through_0010[-1] != migration_0010:
        raise ProbeFailure("0010 migration set is incomplete")
    with tempfile.TemporaryDirectory(prefix="wenmai-0010-migration-") as temp:
        fresh_path = Path(temp) / "fresh.sqlite"
        with closing(sqlite3.connect(fresh_path)) as fresh:
            with fresh:
                apply_migrations(fresh, through_0010)
                for table in [
                    "package_branch_states", "package_branch_working_copies",
                    "package_branch_composition_commits", "package_branch_migration_audits",
                ]:
                    if not one(fresh, "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?", (table,))[0]:
                        raise ProbeFailure(f"fresh migration omitted {table}")

        baseline_path = Path(temp) / "baseline.sqlite"
        with closing(sqlite3.connect(baseline_path)) as baseline:
            baseline.row_factory = sqlite3.Row
            with baseline:
                apply_migrations(baseline, through_0010[:-1])
                clean = seed_bound_case(baseline, suffix="clean", dirty=False)
                dirty = seed_bound_case(baseline, suffix="dirty", dirty=True)
                broken = seed_bound_case(baseline, suffix="broken", dirty=True, broken_dirty_sha=True)
                unbound_id = seed_unbound_case(baseline)
                baseline.commit()
                apply_migrations(baseline, [migration_0010])

                expected_states = {
                clean["package_id"]: "migrated_clean",
                dirty["package_id"]: "migrated_dirty",
                broken["package_id"]: "blocked",
                unbound_id: "legacy_unbound",
            }
                actual_states = {
                row["package_id"]: row["state"]
                for row in baseline.execute("SELECT package_id,state FROM package_branch_migration_audits")
            }
                if actual_states != expected_states:
                    raise ProbeFailure(f"unexpected migration audits: {actual_states}")

                dirty_copy = one(baseline,
                "SELECT document_json,document_sha256,dirty,lock_version FROM package_branch_working_copies "
                "WHERE package_id=? AND branch_id=?", (dirty["package_id"], dirty["branch_id"]))
                if tuple(dirty_copy) != (dirty["working_document"], dirty["working_document_sha"], 1, 7):
                    raise ProbeFailure("dirty 0009 working copy was not preserved byte-for-byte")
                clean_copy = one(baseline,
                "SELECT dirty,lock_version FROM package_branch_working_copies WHERE package_id=? AND branch_id=?",
                (clean["package_id"], clean["branch_id"]))
                if tuple(clean_copy) != (0, 7):
                    raise ProbeFailure("clean 0009 working copy was not preserved")
                for item in [clean, dirty]:
                    root_version = one(baseline,
                    "SELECT branch_model_version FROM article_project_packages WHERE id=?", (item["package_id"],))[0]
                    if root_version != 2:
                        raise ProbeFailure(f"valid package {item['package_id']} did not reach branch model v2")
                    if one(baseline,
                    "SELECT COUNT(*) FROM package_branch_composition_commits WHERE package_id=? AND branch_id=?",
                        (item["package_id"], item["branch_id"]))[0] != 1:
                        raise ProbeFailure("migration did not create the initial branch commit reference")
                for package_id in [broken["package_id"], unbound_id]:
                    if one(baseline,
                    "SELECT branch_model_version FROM article_project_packages WHERE id=?", (package_id,))[0] is not None:
                        raise ProbeFailure("blocked/unbound package was silently promoted")
                    if one(baseline,
                    "SELECT COUNT(*) FROM package_branch_states WHERE package_id=?", (package_id,))[0] != 0:
                        raise ProbeFailure("blocked/unbound package received guessed authoritative state")

                index_row = one(baseline,
                "SELECT [unique] FROM pragma_index_list('package_composition_materializations') "
                "WHERE name='idx_package_materializations_branch_composition'")
                if index_row[0] != 0:
                    raise ProbeFailure("branch+composition materialization index is still unique")
                baseline.execute(
                "INSERT INTO package_composition_materializations (id,package_id,branch_id,composition_id,"
                "composition_sha256,article_revision_id,article_body_sha256,renderer_key,renderer_version,"
                "created_by_kind,created_at) VALUES ('materialization-revert',?,?,?,?,?,'body-revert',"
                "'wenmai.package-markdown','1','user','2026-08-17T00:00:01.000Z')",
                (clean["package_id"], clean["branch_id"], clean["composition_id"], clean["composition_sha"],
                 "revision-revert"),
            )
                baseline.commit()

    return {
        "ok": True,
        "freshMigration": True,
        "legacyCleanMigrated": True,
        "legacyDirtyPreservedByteForByte": True,
        "legacyUnboundNotGuessed": True,
        "brokenRelationshipBlocked": True,
        "branchCompositionMaterializationNonUnique": True,
        "migrationCountThrough0010": len(through_0010),
        "latestMigrationPresent": migrations[-1].name,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1])
    args = parser.parse_args()
    print(json.dumps(run_probe(args.root.resolve()), ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
