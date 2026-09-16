#!/usr/bin/env python3
"""Exercise the additive 0015 provider-response checkpoint migration."""

from __future__ import annotations

import hashlib
import json
import sqlite3
import tempfile
from contextlib import closing
from pathlib import Path
from typing import Any


class ProbeFailure(RuntimeError):
    pass


def statements(path: Path) -> list[str]:
    return [part.strip() for part in path.read_text(encoding="utf-8").split("--> statement-breakpoint") if part.strip()]


def apply_migrations(connection: sqlite3.Connection, paths: list[Path]) -> None:
    for path in paths:
        for statement in statements(path):
            connection.execute(statement)
    connection.commit()


def sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def expect_integrity_error(connection: sqlite3.Connection, sql: str, bindings: tuple[Any, ...]) -> None:
    try:
        connection.execute(sql, bindings)
    except sqlite3.IntegrityError:
        return
    raise ProbeFailure("invalid checkpoint row unexpectedly passed its SQL constraint")


def insert_invocation(connection: sqlite3.Connection) -> None:
    connection.execute(
        "INSERT INTO model_invocations ("
        "id,command_id,purpose,role,provider,model_id,adapter_version,egress_manifest_sha256,"
        "egress_approval_sha256,request_sha256,input_sha256,output_ref,state,attempt,"
        "budget_reservation_json,budget_reservation_sha256,usage_json,created_at"
        ") VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        (
            "invocation-checkpoint-1", "checkpoint-probe:1", "provider_probe", "probe", "deepseek",
            "deepseek-chat", "openai-compatible-json-v1", "1" * 64, "2" * 64, "3" * 64,
            "4" * 64, "", "running", 1, "{}", "5" * 64, "{}", "2026-08-18T10:00:00.000Z",
        ),
    )
    connection.commit()


def checkpoint_bindings(invocation_id: str = "invocation-checkpoint-1") -> tuple[Any, ...]:
    response = json.dumps({"marker": "fixed-probe-marker"}, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    usage = json.dumps({"inputTokens": 7, "outputTokens": 4, "totalTokens": 11}, sort_keys=True, separators=(",", ":"))
    now = "2026-08-18T10:00:01.000Z"
    return invocation_id, "probe", response, sha256_text(response), usage, sha256_text(usage), now, now


INSERT_CHECKPOINT = (
    "INSERT INTO model_invocation_outputs (invocation_id,materialization_kind,response_json,response_sha256,"
    "usage_json,usage_sha256,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)"
)


def assert_checkpoint_contract(connection: sqlite3.Connection) -> None:
    connection.execute(INSERT_CHECKPOINT, checkpoint_bindings())
    connection.commit()
    row = connection.execute(
        "SELECT materialization_state,materialization_attempts,materialization_lock_version,response_sha256,usage_sha256 "
        "FROM model_invocation_outputs WHERE invocation_id='invocation-checkpoint-1'"
    ).fetchone()
    if row is None or tuple(row[:3]) != ("checkpointed", 0, 1) or len(row[3]) != 64 or len(row[4]) != 64:
        raise ProbeFailure(f"checkpoint defaults or digests drifted: {row}")

    expect_integrity_error(connection, INSERT_CHECKPOINT, checkpoint_bindings())

    invalid_json = list(checkpoint_bindings("invalid-json"))
    invalid_json[2] = "not-json"
    invalid_json[3] = sha256_text("not-json")
    expect_integrity_error(connection, INSERT_CHECKPOINT, tuple(invalid_json))

    oversized = list(checkpoint_bindings("oversized"))
    oversized[2] = json.dumps({"value": "x" * 262144}, separators=(",", ":"))
    oversized[3] = sha256_text(oversized[2])
    expect_integrity_error(connection, INSERT_CHECKPOINT, tuple(oversized))

    bad_sha = list(checkpoint_bindings("bad-sha"))
    bad_sha[3] = "g" * 64
    expect_integrity_error(connection, INSERT_CHECKPOINT, tuple(bad_sha))

    invalid_usage = list(checkpoint_bindings("invalid-usage"))
    invalid_usage[4] = "[]"
    invalid_usage[5] = sha256_text("[]")
    expect_integrity_error(connection, INSERT_CHECKPOINT, tuple(invalid_usage))

    cursor = connection.execute(
        "UPDATE model_invocation_outputs SET materialization_state='materializing',"
        "materialization_lease_owner=?,materialization_lease_expires_at=?,materialization_attempts=materialization_attempts+1,"
        "materialization_lock_version=materialization_lock_version+1,updated_at=? "
        "WHERE invocation_id=? AND materialization_state='checkpointed' AND materialization_lock_version=?",
        ("worker-a", "2026-08-18T10:05:00.000Z", "2026-08-18T10:00:02.000Z", "invocation-checkpoint-1", 1),
    )
    if cursor.rowcount != 1:
        raise ProbeFailure("checkpoint CAS claim failed")
    stale_claim = connection.execute(
        "UPDATE model_invocation_outputs SET materialization_attempts=materialization_attempts+1 "
        "WHERE invocation_id=? AND materialization_state='checkpointed' AND materialization_lock_version=?",
        ("invocation-checkpoint-1", 1),
    )
    if stale_claim.rowcount != 0:
        raise ProbeFailure("stale materialization CAS unexpectedly succeeded")

    cursor = connection.execute(
        "UPDATE model_invocation_outputs SET materialization_state='materialized',materialization_ref=?,"
        "materialization_lease_owner=NULL,materialization_lease_expires_at=NULL,materialized_at=?,"
        "materialization_lock_version=materialization_lock_version+1,updated_at=? "
        "WHERE invocation_id=? AND materialization_state='materializing' AND materialization_lock_version=?",
        (
            "model-invocation:invocation-checkpoint-1", "2026-08-18T10:00:03.000Z",
            "2026-08-18T10:00:03.000Z", "invocation-checkpoint-1", 2,
        ),
    )
    if cursor.rowcount != 1:
        raise ProbeFailure("materialization completion CAS failed")
    connection.commit()


def run_probe(root: Path) -> dict[str, Any]:
    migrations = sorted((root / "drizzle").glob("*.sql"))
    journal = json.loads((root / "drizzle" / "meta" / "_journal.json").read_text(encoding="utf-8"))
    journal_files = [f"{entry['tag']}.sql" for entry in journal["entries"]]
    if [path.name for path in migrations] != journal_files:
        raise ProbeFailure("migration files and journal entries diverged")
    through_0014 = [path for path in migrations if int(path.name[:4]) <= 14]
    migration_0015 = root / "drizzle" / "0015_strong_maximus.sql"
    if migration_0015 not in migrations:
        raise ProbeFailure("0015 checkpoint migration is missing from the current chain")

    with tempfile.TemporaryDirectory(prefix="wenmai-checkpoint-migration-") as directory:
        fresh_path = Path(directory) / "fresh.sqlite"
        with closing(sqlite3.connect(fresh_path)) as fresh:
            apply_migrations(fresh, migrations)
            columns = {row[1] for row in fresh.execute("PRAGMA table_info('model_invocation_outputs')")}
            if {"invocation_id", "response_json", "usage_json", "materialization_state", "updated_at"} - columns:
                raise ProbeFailure("fresh migration chain omitted checkpoint columns")

        upgrade_path = Path(directory) / "upgrade.sqlite"
        with closing(sqlite3.connect(upgrade_path)) as upgrade:
            apply_migrations(upgrade, through_0014)
            insert_invocation(upgrade)
            before = upgrade.execute(
                "SELECT command_id,state,response_sha256 FROM model_invocations WHERE id='invocation-checkpoint-1'"
            ).fetchone()
            apply_migrations(upgrade, [migration_0015])
            after = upgrade.execute(
                "SELECT command_id,state,response_sha256 FROM model_invocations WHERE id='invocation-checkpoint-1'"
            ).fetchone()
            if before != after:
                raise ProbeFailure(f"0015 mutated the existing invocation: {before} -> {after}")
            assert_checkpoint_contract(upgrade)

    return {
        "ok": True,
        "latestMigration": journal["entries"][-1]["tag"],
        "checkpointMigration": "0015_strong_maximus",
        "freshChain": True,
        "representative0014To0015Upgrade": True,
        "existingInvocationPreserved": True,
        "uniqueInvocationCheckpoint": True,
        "boundedStructuredJsonChecks": True,
        "leasedMaterializationCas": True,
    }


def main() -> int:
    root = Path(__file__).resolve().parents[1]
    print(json.dumps(run_probe(root), ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
