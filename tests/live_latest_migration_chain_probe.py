#!/usr/bin/env python3
"""Verify the latest Drizzle chain on fresh and representative SQLite baselines."""

from __future__ import annotations

import argparse
import json
import sqlite3
import tempfile
from contextlib import closing
from pathlib import Path
from typing import Any


class ProbeFailure(RuntimeError):
    pass


def statements(path: Path) -> list[str]:
    return [item.strip() for item in path.read_text(encoding="utf-8").split("--> statement-breakpoint") if item.strip()]


def apply_migrations(connection: sqlite3.Connection, files: list[Path]) -> None:
    for path in files:
        for statement in statements(path):
            connection.execute(statement)
    connection.commit()


def one(connection: sqlite3.Connection, sql: str, bindings: tuple[Any, ...] = ()) -> sqlite3.Row:
    row = connection.execute(sql, bindings).fetchone()
    if row is None:
        raise ProbeFailure(f"query returned no row: {sql}")
    return row


def insert_duplicate_active_merge_tuple(connection: sqlite3.Connection) -> None:
    for suffix in ("older", "newer"):
        connection.execute(
            "INSERT INTO work_items (id,article_id,title,kind,stage,state,priority,owner,next_action,blocker,sort_order,created_at,updated_at) "
            "VALUES (?,?,?,'merge','review','open','P1','probe','','',0,?,?)",
            (f"work-{suffix}", "article-merge-upgrade", suffix, f"2026-08-17T00:00:0{1 if suffix == 'older' else 2}.000Z", f"2026-08-17T00:00:0{1 if suffix == 'older' else 2}.000Z"),
        )
        connection.execute(
            "INSERT INTO merge_proposals (id,work_item_id,article_id,source_branch_id,target_branch_id,base_revision_id,"
            "source_head_revision_id,target_head_revision_id,base_sha256,source_head_sha256,target_head_sha256,"
            "algorithm_version,preview_json,preview_sha256,status,lock_version,created_at,updated_at) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?)",
            (
                f"merge-{suffix}", f"work-{suffix}", "article-merge-upgrade", "branch-source", "branch-target",
                "revision-base", "revision-source", "revision-target", "a" * 64, "b" * 64, "c" * 64,
                "manual-three-way-v1", "{}", "d" * 64, "prepared" if suffix == "older" else "resolving",
                f"2026-08-17T00:00:0{1 if suffix == 'older' else 2}.000Z",
                f"2026-08-17T00:00:0{1 if suffix == 'older' else 2}.000Z",
            ),
        )


def insert_legacy_untyped_metric(connection: sqlite3.Connection) -> None:
    connection.execute(
        "INSERT INTO lifecycle_metric_snapshots (id,release_id,project_id,article_id,source_mode,source_label,window_start,"
        "window_end,captured_at,metrics_json,evidence_ref,measurement_sha256,validation_state,validation_note,created_at) "
        "VALUES ('metric-legacy','release-legacy','project-legacy','article-legacy','manual','legacy export',"
        "'2026-08-01T00:00:00.000Z','2026-08-02T00:00:00.000Z','2026-08-03T00:00:00.000Z',"
        "'{\"views\":1}','legacy-evidence',?,'collected','','2026-08-03T00:00:00.000Z')",
        ("e" * 64,),
    )


def assert_0012_shape(connection: sqlite3.Connection) -> None:
    for table in ("lifecycle_metric_definitions", "lifecycle_metric_values"):
        if one(connection, "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?", (table,))[0] != 1:
            raise ProbeFailure(f"latest chain omitted {table}")
    columns = {row[1] for row in connection.execute("PRAGMA table_info(lifecycle_metric_snapshots)")}
    if "definition_set_sha256" not in columns:
        raise ProbeFailure("latest chain omitted definition_set_sha256")
    index_row = one(connection, "SELECT [unique],partial FROM pragma_index_list('merge_proposals') WHERE name='idx_merge_proposals_active_heads'")
    if tuple(index_row) != (1, 1):
        raise ProbeFailure("active merge-head tuple index is not unique and partial")
    definitions = list(connection.execute(
        "SELECT definition_key,value_kind,unit,missing_policy,scope_json,definition_sha256,status "
        "FROM lifecycle_metric_definitions ORDER BY definition_key"
    ))
    if len(definitions) != 5:
        raise ProbeFailure(f"expected 5 frozen raw MetricDefinitions, got {len(definitions)}")
    for definition in definitions:
        scope = json.loads(definition[4])
        if scope.get("crossPlatformComparable") is not False or scope.get("normalizationApplied") is not False:
            raise ProbeFailure(f"definition {definition[0]} claimed cross-platform normalization")
        if definition[3] != "unknown" or definition[6] != "active" or len(definition[5]) != 64:
            raise ProbeFailure(f"definition {definition[0]} contract drifted")


def assert_0013_shape(connection: sqlite3.Connection) -> None:
    required_columns = {
        "management_browser_devices": {
            "id", "principal_id", "public_key_jwk_json", "public_key_sha256",
            "browser_binding_sha256", "status", "enrolled_session_id", "created_at",
            "updated_at", "last_used_at", "revoked_at", "revoke_reason",
        },
        "management_device_challenges": {
            "id", "boot_id", "device_id", "nonce_sha256", "payload_sha256",
            "browser_binding_sha256", "status", "attempts", "max_attempts", "issued_at",
            "expires_at", "consumed_at", "consumed_session_id", "created_at",
        },
    }
    for table, expected in required_columns.items():
        if one(connection, "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?", (table,))[0] != 1:
            raise ProbeFailure(f"0013 omitted {table}")
        columns = {row[1] for row in connection.execute(f"PRAGMA table_info('{table}')")}
        missing = sorted(expected - columns)
        if missing:
            raise ProbeFailure(f"0013 {table} omitted columns: {missing}")

    session_columns = {row[1] for row in connection.execute("PRAGMA table_info('management_sessions')")}
    if "trusted_device_id" not in session_columns:
        raise ProbeFailure("0013 omitted management_sessions.trusted_device_id")

    expected_indexes = {
        "management_browser_devices": {
            "idx_management_browser_devices_public_key": 1,
            "idx_management_browser_devices_binding_status": 0,
        },
        "management_device_challenges": {
            "idx_management_device_challenges_nonce": 1,
            "idx_management_device_challenges_payload": 1,
            "idx_management_device_challenges_device_status": 0,
            "idx_management_device_challenges_boot_status": 0,
        },
        "management_sessions": {"idx_management_sessions_trusted_device": 0},
    }
    for table, indexes in expected_indexes.items():
        actual = {str(row[1]): int(row[2]) for row in connection.execute(f"PRAGMA index_list('{table}')")}
        for name, unique in indexes.items():
            if actual.get(name) != unique:
                raise ProbeFailure(f"0013 index {name} missing or uniqueness drifted: {actual.get(name)}")


def assert_0014_shape(connection: sqlite3.Connection) -> None:
    required_columns = {
        "meta_skill_versions": {
            "id", "skill_key", "version", "role", "parent_version_id", "prompt_text",
            "prompt_sha256", "contract_json", "contract_sha256", "content_sha256",
            "created_by_kind", "created_by_provider", "source_invocation_id", "is_candidate",
            "status", "decision_experiment_id", "activated_at", "decided_at", "lock_version", "created_at",
        },
        "meta_skill_activations": {
            "skill_key", "active_version_id", "lock_version", "updated_at", "decision_experiment_id",
        },
        "meta_improvement_experiments": {
            "id", "target_skill_key", "baseline_version_id", "baseline_content_sha256",
            "candidate_version_id", "cases_sha256", "holdout_cases_sha256", "provider_policy_sha256",
            "budget_sha256", "evaluation_contract_sha256", "frozen_input_sha256", "state",
            "decision", "human_decision_note", "lock_version", "created_at", "updated_at",
        },
        "model_invocations": {
            "id", "experiment_id", "command_id", "purpose", "role", "provider", "model_id",
            "prompt_version_id", "request_sha256", "response_sha256", "state", "usage_json",
            "input_tokens", "output_tokens", "total_tokens", "latency_ms", "http_status",
            "finish_reason", "error_class", "error_summary", "created_at", "finished_at",
        },
        "meta_improvement_evaluations": {
            "id", "experiment_id", "pair_id", "case_id", "arm", "version_id",
            "evaluator_kind", "evaluator_key", "provider", "model_id", "invocation_id",
            "result", "contract_sha256", "input_sha256", "output_sha256", "signals_json",
            "signals_sha256", "evidence_json", "evidence_sha256", "created_at",
        },
        "meta_improvement_events": {
            "id", "experiment_id", "event_type", "from_state", "to_state", "actor_kind",
            "actor_id", "payload_json", "input_sha256", "created_at",
        },
    }
    for table, expected in required_columns.items():
        if one(connection, "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?", (table,))[0] != 1:
            raise ProbeFailure(f"0014 omitted {table}")
        columns = {row[1] for row in connection.execute(f"PRAGMA table_info('{table}')")}
        missing = sorted(expected - columns)
        if missing:
            raise ProbeFailure(f"0014 {table} omitted columns: {missing}")

    active_index = one(
        connection,
        "SELECT [unique],partial FROM pragma_index_list('meta_skill_versions') "
        "WHERE name='idx_meta_skill_versions_active_key'",
    )
    if tuple(active_index) != (1, 1):
        raise ProbeFailure("0014 active meta-skill index is not unique and partial")
    activation_index = one(
        connection,
        "SELECT [unique] FROM pragma_index_list('meta_skill_activations') "
        "WHERE name='idx_meta_skill_activations_active_version'",
    )
    if tuple(activation_index) != (1,):
        raise ProbeFailure("0014 activation version pointer is not unique")

    meta_indexes = one(
        connection,
        "SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND tbl_name IN ("
        "'meta_skill_versions','meta_skill_activations','meta_improvement_experiments',"
        "'model_invocations','meta_improvement_evaluations','meta_improvement_events') "
        "AND sql IS NOT NULL",
    )[0]
    # 0014 creates 18 indexes; 0017 adds one lineage-candidate lookup index to
    # model_invocations without changing the 0014 meta tables.
    if meta_indexes not in (18, 19):
        raise ProbeFailure(f"0014/0017 expected 18 or 19 explicit meta-improvement indexes, got {meta_indexes}")


def assert_0015_shape(connection: sqlite3.Connection) -> None:
    table = "model_invocation_outputs"
    if one(connection, "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?", (table,))[0] != 1:
        raise ProbeFailure(f"0015 omitted {table}")

    expected_columns = {
        "invocation_id", "materialization_kind", "response_json", "response_sha256",
        "usage_json", "usage_sha256", "materialization_state", "materialization_ref",
        "materialization_lease_owner", "materialization_lease_expires_at",
        "materialization_attempts", "materialization_lock_version", "last_error_class",
        "last_error_summary", "created_at", "updated_at", "materialized_at",
    }
    columns = {row[1] for row in connection.execute(f"PRAGMA table_info('{table}')")}
    missing = sorted(expected_columns - columns)
    if missing:
        raise ProbeFailure(f"0015 {table} omitted columns: {missing}")

    primary_key = one(
        connection,
        "SELECT pk FROM pragma_table_info('model_invocation_outputs') WHERE name='invocation_id'",
    )[0]
    if primary_key != 1:
        raise ProbeFailure("0015 invocation checkpoint is not keyed by invocation_id")

    state_index = one(
        connection,
        "SELECT [unique],partial FROM pragma_index_list('model_invocation_outputs') "
        "WHERE name='idx_model_invocation_outputs_state_updated'",
    )
    if tuple(state_index) != (0, 0):
        raise ProbeFailure("0015 checkpoint state index is missing or uniqueness drifted")


def assert_0016_shape(connection: sqlite3.Connection) -> None:
    required_columns = {
        "article_identities": {
            "id", "canonical_article_id", "title", "status", "visibility",
            "lock_version", "created_by", "created_at", "updated_at",
        },
        "article_identity_members": {
            "id", "identity_id", "object_kind", "object_id", "article_id",
            "revision_id", "body_sha256", "role", "state", "hidden_from_primary",
            "evidence_json", "input_sha256", "operation_id", "lock_version",
            "created_at", "updated_at",
        },
        "article_lineage_links": {
            "id", "identity_id", "relation_type", "source_kind", "source_id",
            "source_article_id", "source_revision_id", "source_body_sha256",
            "target_kind", "target_id", "target_article_id", "target_revision_id",
            "target_body_sha256", "status", "evidence_json", "input_sha256",
            "operation_id", "decided_by", "decided_at", "lock_version",
            "created_at", "updated_at",
        },
        "article_identity_operations": {
            "id", "operation_kind", "status", "identity_id", "command_id",
            "actor_id", "plan_json", "plan_sha256", "preconditions_json",
            "preconditions_sha256", "inverse_json", "result_json", "sentinel",
            "lock_version", "planned_at", "updated_at",
        },
    }
    for table, expected in required_columns.items():
        if one(connection, "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?", (table,))[0] != 1:
            raise ProbeFailure(f"0016 omitted {table}")
        columns = {row[1] for row in connection.execute(f"PRAGMA table_info('{table}')")}
        missing = sorted(expected - columns)
        if missing:
            raise ProbeFailure(f"0016 {table} omitted columns: {missing}")

    expected_indexes = {
        "idx_article_identities_canonical_article": 1,
        "idx_article_identity_members_object": 1,
        "idx_article_lineage_links_relation": 1,
        "idx_article_identity_operations_command": 1,
        "idx_article_identity_operations_sentinel": 1,
    }
    actual_indexes = {
        str(row[0]): int(row[1]) for row in connection.execute(
            "SELECT name, [unique] FROM pragma_index_list('article_identities') "
            "UNION ALL SELECT name, [unique] FROM pragma_index_list('article_identity_members') "
            "UNION ALL SELECT name, [unique] FROM pragma_index_list('article_lineage_links') "
            "UNION ALL SELECT name, [unique] FROM pragma_index_list('article_identity_operations')"
        )
    }
    for name, unique in expected_indexes.items():
        if actual_indexes.get(name) != unique:
            raise ProbeFailure(f"0016 identity index {name} missing or uniqueness drifted")


def assert_0017_shape(connection: sqlite3.Connection) -> None:
    invocation_columns = {row[1] for row in connection.execute("PRAGMA table_info('model_invocations')")}
    for column in ("lineage_candidate_id", "lineage_preparation_id"):
        if column not in invocation_columns:
            raise ProbeFailure(f"0017 model_invocations omitted {column}")
    invocation_sql = str(one(
        connection,
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='model_invocations'",
    )[0])
    for marker in ("lineage_review", "lineage_candidate_id", "lineage_preparation_id"):
        if marker not in invocation_sql:
            raise ProbeFailure(f"0017 model invocation constraint omitted {marker}")
    lineage_index = one(
        connection,
        "SELECT [unique],partial FROM pragma_index_list('model_invocations') "
        "WHERE name='idx_model_invocations_lineage_candidate'",
    )
    if tuple(lineage_index) != (0, 0):
        raise ProbeFailure("0017 lineage invocation index is missing or uniqueness drifted")

    required_columns = {
        "article_lineage_review_preparations": {
            "id", "candidate_id", "candidate_lock_version", "candidate_input_sha256",
            "source_revision_id", "source_body_sha256", "target_revision_id",
            "target_body_sha256", "frozen_input_json", "input_sha256",
            "input_token_estimate", "budget_estimate_json", "state", "lock_version",
            "created_by", "created_at", "updated_at",
        },
        "article_lineage_model_reviews": {
            "id", "preparation_id", "candidate_id", "candidate_lock_version",
            "input_sha256", "invocation_id", "provider", "model_id",
            "output_schema_version", "output_json", "output_sha256",
            "relation_recommendation", "confidence_micros", "candidate_only", "state",
            "max_input_tokens", "max_output_tokens", "max_cost_cny_micros",
            "reserved_cost_cny_micros", "usage_json", "created_by", "created_at",
        },
    }
    for table, expected in required_columns.items():
        if one(connection, "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?", (table,))[0] != 1:
            raise ProbeFailure(f"0017 omitted {table}")
        columns = {row[1] for row in connection.execute(f"PRAGMA table_info('{table}')")}
        missing = sorted(expected - columns)
        if missing:
            raise ProbeFailure(f"0017 {table} omitted columns: {missing}")

    expected_indexes = {
        "idx_lineage_review_preparation_input": 1,
        "idx_lineage_review_preparation_state": 0,
        "idx_lineage_model_reviews_invocation": 1,
        "idx_lineage_model_reviews_preparation": 1,
        "idx_lineage_model_reviews_candidate": 0,
    }
    actual_indexes = {
        str(row[0]): int(row[1]) for row in connection.execute(
            "SELECT name, [unique] FROM pragma_index_list('article_lineage_review_preparations') "
            "UNION ALL SELECT name, [unique] FROM pragma_index_list('article_lineage_model_reviews')"
        )
    }
    for name, unique in expected_indexes.items():
        if actual_indexes.get(name) != unique:
            raise ProbeFailure(f"0017 lineage review index {name} missing or uniqueness drifted")


def assert_0018_shape(connection: sqlite3.Connection) -> None:
    required_columns = {
        "article_publication_versions": {
            "id", "package_id", "article_id", "role", "version_key", "platform",
            "branch_id", "branch_lock_version", "revision_id", "body_sha256",
            "composition_id", "composition_sha256", "target_profile_id",
            "target_profile_key", "target_profile_sha256", "baseline_version_id",
            "baseline_branch_id", "baseline_revision_id", "baseline_body_sha256",
            "baseline_composition_id", "baseline_composition_sha256",
            "publication_version_json", "registration_sha256", "state",
            "lock_version", "created_at", "updated_at",
        },
        "lifecycle_build_input_bindings": {
            "build_id", "input_binding_sha256", "package_id", "branch_id",
            "branch_lock_version", "revision_id", "source_body_sha256",
            "composition_id", "composition_sha256", "slice_id", "slice_sha256",
            "publication_version_id", "publication_registration_sha256",
            "cover_run_id", "cover_recipe_id", "cover_recipe_version",
            "cover_recipe_sha256", "cover_receipt_id",
            "cover_receipt_schema_version", "cover_receipt_json",
            "cover_receipt_sha256", "cover_receipt_chain_json",
            "cover_receipt_chain_sha256", "cover_artifact_sha256",
            "cover_baseline_id", "cover_baseline_sha256",
            "cover_profile_sha256", "created_at",
        },
    }
    for table, expected in required_columns.items():
        if one(connection, "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?", (table,))[0] != 1:
            raise ProbeFailure(f"0018 omitted {table}")
        columns = {row[1] for row in connection.execute(f"PRAGMA table_info('{table}')")}
        missing = sorted(expected - columns)
        if missing:
            raise ProbeFailure(f"0018 {table} omitted columns: {missing}")

    publication_sql = str(one(
        connection,
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='article_publication_versions'",
    )[0])
    for marker in ("canonical_baseline", "platform_variant", "maimai", "xiaohongshu", "zhihu", "bilibili"):
        if marker not in publication_sql:
            raise ProbeFailure(f"0018 publication version constraint omitted {marker}")
    binding_sql = str(one(
        connection,
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='lifecycle_build_input_bindings'",
    )[0])
    for marker in ("cover_receipt_json", "cover_receipt_chain_json", "cover_profile_sha256"):
        if marker not in binding_sql:
            raise ProbeFailure(f"0018 build input constraint omitted {marker}")

    expected_indexes = {
        "idx_article_publication_versions_active_key": (1, 1),
        "idx_article_publication_versions_active_branch": (1, 1),
        "idx_article_publication_versions_article_state": (0, 0),
        "idx_lifecycle_build_input_package_branch": (0, 0),
        "idx_lifecycle_build_input_cover_receipt": (0, 0),
    }
    actual_indexes = {
        str(row[0]): (int(row[1]), int(row[2])) for row in connection.execute(
            "SELECT name,[unique],partial FROM pragma_index_list('article_publication_versions') "
            "UNION ALL SELECT name,[unique],partial FROM pragma_index_list('lifecycle_build_input_bindings')"
        )
    }
    for name, identity in expected_indexes.items():
        if actual_indexes.get(name) != identity:
            raise ProbeFailure(f"0018 index {name} missing or uniqueness/partial shape drifted")


def assert_0019_shape(connection: sqlite3.Connection) -> None:
    expected_snapshot_columns = {
        "client_id", "schema_version", "catalog_version", "preset_id", "role",
        "scopes_json", "action_ids_json", "article_ids_json", "task_ids_json",
        "snapshot_json", "snapshot_sha256", "created_at",
    }
    snapshot_columns = {row[1] for row in connection.execute("PRAGMA table_info('agent_client_permission_snapshots')")}
    missing_snapshot_columns = sorted(expected_snapshot_columns - snapshot_columns)
    if missing_snapshot_columns:
        raise ProbeFailure(f"0019 permission snapshot omitted columns: {missing_snapshot_columns}")
    clients_columns = {row[1] for row in connection.execute("PRAGMA table_info('agent_clients')")}
    if "role" not in clients_columns:
        raise ProbeFailure("0019 agent_clients omitted role")
    snapshot_sql = str(one(
        connection,
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='agent_client_permission_snapshots'",
    )[0])
    if "schema_version" not in snapshot_sql or "= 3" not in snapshot_sql:
        raise ProbeFailure("0019 permission snapshot schema version constraint drifted")
    clients_sql = str(one(
        connection,
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='agent_clients'",
    )[0])
    for role in ("'agent'", "'administrator'", "'super_admin'"):
        if role not in clients_sql:
            raise ProbeFailure(f"0019 agent_clients role constraint omitted {role}")


def assert_0020_shape(connection: sqlite3.Connection) -> None:
    columns = {row[1] for row in connection.execute("PRAGMA table_info('merge_proposals')")}
    missing = {"prepare_actor_id", "resolution_actor_id", "apply_actor_id"} - columns
    if missing:
        raise ProbeFailure(f"0020 merge_proposals omitted actor columns: {sorted(missing)}")


def assert_0021_shape(connection: sqlite3.Connection) -> None:
    columns = {row[1] for row in connection.execute("PRAGMA table_info('publish_capabilities')")}
    if "article_id" not in columns:
        raise ProbeFailure("0021 publish_capabilities omitted article_id")
    indexes = {row[1] for row in connection.execute("PRAGMA index_list('publish_capabilities')")}
    if "idx_publish_capabilities_article_status_expiry" not in indexes:
        raise ProbeFailure("0021 publish capability article/status/expiry index is missing")


def assert_0022_shape(connection: sqlite3.Connection) -> None:
    columns = {row[1] for row in connection.execute("PRAGMA table_info('package_patch_proposals')")}
    missing = {"decided_by_kind", "decided_by_id"} - columns
    if missing:
        raise ProbeFailure(f"0022 package_patch_proposals omitted decision actor columns: {sorted(missing)}")


def assert_0023_shape(connection: sqlite3.Connection) -> None:
    client_columns = {row[1] for row in connection.execute("PRAGMA table_info('agent_clients')")}
    missing_client = {"credential_purpose", "issued_by_source_client_id", "exchange_generation"} - client_columns
    if missing_client:
        raise ProbeFailure(f"0023 agent_clients omitted management exchange columns: {sorted(missing_client)}")
    session_columns = {row[1] for row in connection.execute("PRAGMA table_info('management_sessions')")}
    missing_session = {"auth_basis", "authority_class", "source_client_id", "source_key_expires_at", "source_exchange_generation", "source_permission_snapshot_sha256"} - session_columns
    if missing_session:
        raise ProbeFailure(f"0023 management_sessions omitted source-binding columns: {sorted(missing_session)}")


def assert_0025_shape(connection: sqlite3.Connection) -> None:
    columns = {row[1] for row in connection.execute("PRAGMA table_info('agent_clients')")}
    required = {"credential_purpose", "issued_by_source_client_id", "exchange_generation"}
    missing = sorted(required - columns)
    if missing:
        raise ProbeFailure(f"0025 agent_clients omitted purpose/lineage columns: {missing}")

    table_sql = str(one(
        connection,
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='agent_clients'",
    )[0])
    for marker in ("'site_full_control'", "agent_clients_credential_purpose_check", "agent_clients_lineage_not_self_check"):
        if marker not in table_sql:
            raise ProbeFailure(f"0025 agent_clients purpose or self-lineage constraint omitted {marker}")

    expected_indexes = {
        "idx_agent_clients_token_sha256": 1,
        "idx_agent_clients_status_expiry": 0,
        "idx_agent_clients_management_exchange": 0,
        "idx_agent_clients_source_client": 0,
    }
    actual_indexes = {str(row[1]): int(row[2]) for row in connection.execute("PRAGMA index_list('agent_clients')")}
    for name, unique in expected_indexes.items():
        if actual_indexes.get(name) != unique:
            raise ProbeFailure(f"0025 agent_clients index {name} missing or uniqueness drifted")


def insert_pre_0015_model_invocation(connection: sqlite3.Connection) -> None:
    connection.execute(
        "INSERT INTO model_invocations "
        "(id,command_id,purpose,role,provider,model_id,adapter_version,egress_manifest_sha256,"
        "egress_approval_sha256,request_sha256,input_sha256,response_sha256,state,"
        "budget_reservation_sha256,created_at,started_at,finished_at) "
        "VALUES ('invocation-before-0015','command-before-0015','provider_probe','probe','deepseek',"
        "'deepseek-v4-pro','deepseek-chat-completions-v1',?,?,?,?,?,'succeeded',?,"
        "'2026-08-18T00:00:00.000Z','2026-08-18T00:00:00.000Z','2026-08-18T00:00:01.000Z')",
        ("3" * 64, "4" * 64, "5" * 64, "6" * 64, "7" * 64, "8" * 64),
    )


def insert_pre_0017_model_checkpoint(connection: sqlite3.Connection) -> None:
    connection.execute(
        "INSERT INTO model_invocation_outputs "
        "(invocation_id,materialization_kind,response_json,response_sha256,usage_json,usage_sha256,"
        "materialization_state,materialization_ref,materialization_attempts,materialization_lock_version,"
        "created_at,updated_at,materialized_at) "
        "VALUES ('invocation-before-0015','probe','{}',?,'{}',?,'materialized','',0,1,?,?,?)",
        (
            "9" * 64,
            "a" * 64,
            "2026-08-18T00:00:02.000Z",
            "2026-08-18T00:00:02.000Z",
            "2026-08-18T00:00:02.000Z",
        ),
    )


def insert_0012_management_session(connection: sqlite3.Connection) -> None:
    connection.execute(
        "INSERT INTO management_sessions "
        "(id,principal_id,token_sha256,browser_binding_sha256,scopes_json,article_ids_json,object_boundary_json,"
        "status,absolute_expires_at,idle_expires_at,last_seen_at,created_at,revoke_reason) "
        "VALUES ('session-before-0013','principal-before-0013',?,?, '[\"management.read\"]','[\"*\"]',"
        "'{\"articles\":[\"*\"]}','active','2026-08-19T00:00:00.000Z','2026-08-18T23:00:00.000Z',"
        "'2026-08-18T00:00:00.000Z','2026-08-18T00:00:00.000Z','')",
        ("1" * 64, "2" * 64),
    )


def run_probe(root: Path) -> dict[str, Any]:
    migrations = sorted((root / "drizzle").glob("*.sql"))
    journal = json.loads((root / "drizzle" / "meta" / "_journal.json").read_text(encoding="utf-8"))
    journal_files = [f"{entry['tag']}.sql" for entry in journal["entries"]]
    migration_files = [path.name for path in migrations]
    if len(migrations) != 29 or migration_files != journal_files:
        raise ProbeFailure(
            f"expected the exact 29-file journal chain, got {len(migrations)} files: {migration_files}"
        )
    latest = journal["entries"][-1]["tag"]
    expected_file = f"{latest}.sql"
    if latest != "0028_release_control_v2_dom_binding" or not migrations or migrations[-1].name != expected_file:
        raise ProbeFailure(f"latest migration/journal mismatch: {latest} / {migrations[-1].name if migrations else 'none'}")
    through_0011 = [path for path in migrations if int(path.name[:4]) <= 11]
    migration_0012 = root / "drizzle" / "0012_hesitant_lorna_dane.sql"
    migration_0013 = root / "drizzle" / "0013_typical_slipstream.sql"
    migration_0014 = root / "drizzle" / "0014_left_rattler.sql"
    migration_0015 = root / "drizzle" / "0015_strong_maximus.sql"
    migration_0016 = root / "drizzle" / "0016_small_scorpion.sql"
    migration_0017 = root / "drizzle" / "0017_amazing_annihilus.sql"
    migration_0018 = root / "drizzle" / "0018_publication_build_binding.sql"
    migration_0019 = root / "drizzle" / "0019_agent_permission_snapshot.sql"
    migration_0020 = root / "drizzle" / "0020_privileged_merge_actor_separation.sql"
    migration_0021 = root / "drizzle" / "0021_publish_capability_article_binding.sql"
    migration_0022 = root / "drizzle" / "0022_package_patch_decision_actor.sql"
    migration_0023 = root / "drizzle" / "0023_site_full_control_management_session.sql"
    migration_0024 = root / "drizzle" / "0024_oval_polaris.sql"
    migration_0025 = root / "drizzle" / "0025_site_full_control_direct_v5.sql"
    migration_0026 = root / "drizzle" / "0026_release_readiness.sql"
    migration_0027 = root / "drizzle" / "0027_release_control_v2.sql"
    migration_0028 = root / "drizzle" / "0028_release_control_v2_dom_binding.sql"
    if any(path not in migrations for path in (
        migration_0012, migration_0013, migration_0014, migration_0015, migration_0016, migration_0017, migration_0018, migration_0019,
        migration_0020, migration_0021, migration_0022, migration_0023, migration_0024, migration_0025,
        migration_0026, migration_0027, migration_0028,
    )):
        raise ProbeFailure("0012 through 0028 migration files are not all present in the chain")

    with tempfile.TemporaryDirectory(prefix="wenmai-latest-migration-") as temp:
        fresh_path = Path(temp) / "fresh.sqlite"
        with closing(sqlite3.connect(fresh_path)) as fresh:
            fresh.row_factory = sqlite3.Row
            apply_migrations(fresh, migrations)
            assert_0012_shape(fresh)
            assert_0013_shape(fresh)
            assert_0014_shape(fresh)
            assert_0015_shape(fresh)
            assert_0016_shape(fresh)
            assert_0017_shape(fresh)
            assert_0018_shape(fresh)
            assert_0019_shape(fresh)
            assert_0020_shape(fresh)
            assert_0021_shape(fresh)
            assert_0022_shape(fresh)
            assert_0023_shape(fresh)
            assert_0025_shape(fresh)
            if one(fresh, "PRAGMA integrity_check")[0] != "ok":
                raise ProbeFailure("fresh 29-migration chain integrity_check failed")

        upgrade_path = Path(temp) / "upgrade.sqlite"
        with closing(sqlite3.connect(upgrade_path)) as upgrade:
            upgrade.row_factory = sqlite3.Row
            apply_migrations(upgrade, through_0011)
            insert_duplicate_active_merge_tuple(upgrade)
            insert_legacy_untyped_metric(upgrade)
            upgrade.commit()
            apply_migrations(upgrade, [migration_0012])
            assert_0012_shape(upgrade)

            active = list(upgrade.execute("SELECT id,status FROM merge_proposals ORDER BY id"))
            if [tuple(row) for row in active] != [("merge-newer", "resolving"), ("merge-older", "stale")]:
                raise ProbeFailure(f"duplicate active tuple was not deterministically closed: {active}")
            if one(upgrade, "SELECT state FROM work_items WHERE id='work-older'")[0] != "done":
                raise ProbeFailure("staled duplicate merge work item remained open")
            if one(upgrade, "SELECT COUNT(*) FROM workspace_events WHERE id='event-migration-0012-merge-dedupe-merge-older'")[0] != 1:
                raise ProbeFailure("duplicate merge migration audit event is missing")
            if one(upgrade, "SELECT definition_set_sha256 FROM lifecycle_metric_snapshots WHERE id='metric-legacy'")[0] is not None:
                raise ProbeFailure("legacy untyped metric was silently promoted")
            try:
                upgrade.execute(
                    "INSERT INTO merge_proposals (id,work_item_id,article_id,source_branch_id,target_branch_id,base_revision_id,"
                    "source_head_revision_id,target_head_revision_id,base_sha256,source_head_sha256,target_head_sha256,algorithm_version,"
                    "preview_json,preview_sha256,status) VALUES ('merge-third','work-third','article-merge-upgrade','branch-source',"
                    "'branch-target','revision-base','revision-source','revision-target',?,?,?,?, '{}',?,'ready')",
                    ("a" * 64, "b" * 64, "c" * 64, "manual-three-way-v1", "d" * 64),
                )
            except sqlite3.IntegrityError:
                pass
            else:
                raise ProbeFailure("unique active merge-head tuple accepted a duplicate")

            insert_0012_management_session(upgrade)
            upgrade.commit()
            apply_migrations(upgrade, [migration_0013])
            assert_0013_shape(upgrade)
            preserved_session = one(
                upgrade,
                "SELECT principal_id,status,trusted_device_id FROM management_sessions WHERE id='session-before-0013'",
            )
            if tuple(preserved_session) != ("principal-before-0013", "active", None):
                raise ProbeFailure(f"0012 session was not preserved by 0013: {tuple(preserved_session)}")

            pre_0014_tables = {
                row[0] for row in upgrade.execute(
                    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
                )
            }
            apply_migrations(upgrade, [migration_0014])
            assert_0014_shape(upgrade)
            post_0014_tables = {
                row[0] for row in upgrade.execute(
                    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
                )
            }
            if not pre_0014_tables.issubset(post_0014_tables):
                raise ProbeFailure("0014 removed an existing table from the representative upgrade")
            preserved_after_0014 = one(
                upgrade,
                "SELECT principal_id,status,trusted_device_id FROM management_sessions WHERE id='session-before-0013'",
            )
            if tuple(preserved_after_0014) != ("principal-before-0013", "active", None):
                raise ProbeFailure(f"0013 session was not preserved by 0014: {tuple(preserved_after_0014)}")

            insert_pre_0015_model_invocation(upgrade)
            upgrade.commit()
            pre_0015_invocation = tuple(one(
                upgrade,
                "SELECT command_id,provider,model_id,response_sha256,state,created_at,finished_at "
                "FROM model_invocations WHERE id='invocation-before-0015'",
            ))
            pre_0015_tables = {
                row[0] for row in upgrade.execute(
                    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
                )
            }
            apply_migrations(upgrade, [migration_0015])
            assert_0015_shape(upgrade)
            post_0015_tables = {
                row[0] for row in upgrade.execute(
                    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
                )
            }
            if not pre_0015_tables.issubset(post_0015_tables):
                raise ProbeFailure("0015 removed an existing table from the representative upgrade")
            preserved_after_0015 = tuple(one(
                upgrade,
                "SELECT command_id,provider,model_id,response_sha256,state,created_at,finished_at "
                "FROM model_invocations WHERE id='invocation-before-0015'",
            ))
            if preserved_after_0015 != pre_0015_invocation:
                raise ProbeFailure(
                    f"pre-0015 model invocation was not preserved by 0015: {preserved_after_0015}"
                )
            if one(
                upgrade,
                "SELECT COUNT(*) FROM model_invocation_outputs WHERE invocation_id='invocation-before-0015'",
            )[0] != 0:
                raise ProbeFailure("0015 fabricated an output checkpoint for a pre-0015 invocation")

            insert_pre_0017_model_checkpoint(upgrade)
            upgrade.commit()
            apply_migrations(upgrade, [migration_0016])
            assert_0016_shape(upgrade)
            pre_0017_tables = {
                row[0] for row in upgrade.execute(
                    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
                )
            }
            pre_0017_invocation = tuple(one(
                upgrade,
                "SELECT command_id,provider,model_id,response_sha256,output_ref,state,"
                "input_tokens,output_tokens,total_tokens,created_at,finished_at "
                "FROM model_invocations WHERE id='invocation-before-0015'",
            ))
            pre_0017_checkpoint = tuple(one(
                upgrade,
                "SELECT materialization_kind,response_sha256,usage_sha256,materialization_state,materialized_at "
                "FROM model_invocation_outputs WHERE invocation_id='invocation-before-0015'",
            ))
            apply_migrations(upgrade, [migration_0017])
            assert_0017_shape(upgrade)
            post_0017_tables = {
                row[0] for row in upgrade.execute(
                    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
                )
            }
            if not pre_0017_tables.issubset(post_0017_tables):
                raise ProbeFailure("0017 removed an existing table from the representative upgrade")
            preserved_after_0017 = one(
                upgrade,
                "SELECT command_id,provider,model_id,response_sha256,output_ref,state,"
                "input_tokens,output_tokens,total_tokens,created_at,finished_at,"
                "lineage_candidate_id,lineage_preparation_id "
                "FROM model_invocations WHERE id='invocation-before-0015'",
            )
            if tuple(preserved_after_0017[:11]) != pre_0017_invocation or tuple(preserved_after_0017[11:]) != (None, None):
                raise ProbeFailure(f"pre-0017 model invocation was not preserved by 0017: {tuple(preserved_after_0017)}")
            preserved_checkpoint_after_0017 = tuple(one(
                upgrade,
                "SELECT materialization_kind,response_sha256,usage_sha256,materialization_state,materialized_at "
                "FROM model_invocation_outputs WHERE invocation_id='invocation-before-0015'",
            ))
            if preserved_checkpoint_after_0017 != pre_0017_checkpoint:
                raise ProbeFailure(
                    f"pre-0017 response checkpoint was not preserved by 0017: {preserved_checkpoint_after_0017}"
                )
            if one(upgrade, "SELECT COUNT(*) FROM article_lineage_model_reviews")[0] != 0:
                raise ProbeFailure("0017 fabricated a lineage model review for an existing invocation")
            pre_0018_tables = {
                row[0] for row in upgrade.execute(
                    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
                )
            }
            apply_migrations(upgrade, [migration_0018])
            assert_0018_shape(upgrade)
            post_0018_tables = {
                row[0] for row in upgrade.execute(
                    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
                )
            }
            if not pre_0018_tables.issubset(post_0018_tables):
                raise ProbeFailure("0018 removed an existing table from the representative upgrade")
            if one(upgrade, "SELECT COUNT(*) FROM article_publication_versions")[0] != 0:
                raise ProbeFailure("0018 fabricated publication versions")
            if one(upgrade, "SELECT COUNT(*) FROM lifecycle_build_input_bindings")[0] != 0:
                raise ProbeFailure("0018 fabricated Build input bindings")
            upgrade.execute(
                "INSERT INTO agent_clients "
                "(id,label,client_kind,token_sha256,scopes_json,article_ids_json,task_ids_json,status,expires_at,created_at) "
                "VALUES ('client-before-0019','legacy client','custom',?,'[\"task.read\"]','[\"article-1\"]','[]','active',?,?)",
                ("f" * 64, "2026-09-01T00:00:00.000Z", "2026-08-26T00:00:00.000Z"),
            )
            pre_0019_tables = {
                row[0] for row in upgrade.execute(
                    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
                )
            }
            apply_migrations(upgrade, [migration_0019])
            assert_0019_shape(upgrade)
            post_0019_tables = {
                row[0] for row in upgrade.execute(
                    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
                )
            }
            if not pre_0019_tables.issubset(post_0019_tables):
                raise ProbeFailure("0019 removed an existing table from the representative upgrade")
            preserved_client = tuple(one(
                upgrade,
                "SELECT label,client_kind,role,token_sha256,scopes_json,article_ids_json,task_ids_json,status,expires_at,created_at "
                "FROM agent_clients WHERE id='client-before-0019'",
            ))
            if preserved_client != (
                "legacy client", "custom", "agent", "f" * 64, '["task.read"]', '["article-1"]', "[]", "active",
                "2026-09-01T00:00:00.000Z", "2026-08-26T00:00:00.000Z",
            ):
                raise ProbeFailure(f"0019 did not preserve the legacy agent client safely: {preserved_client}")
            if one(upgrade, "SELECT COUNT(*) FROM agent_client_permission_snapshots")[0] != 0:
                raise ProbeFailure("0019 fabricated a permission snapshot for a legacy client")

            apply_migrations(upgrade, [migration_0020])
            assert_0020_shape(upgrade)
            for merge_id in ("merge-older", "merge-newer"):
                if tuple(one(upgrade, "SELECT prepare_actor_id,resolution_actor_id,apply_actor_id FROM merge_proposals WHERE id=?", (merge_id,))) != (None, None, None):
                    raise ProbeFailure("0020 backfilled a legacy merge actor identity")

            capability_baseline = statements(migration_0021)[:-2]
            for statement in capability_baseline:
                upgrade.execute(statement)
            upgrade.execute(
                "INSERT INTO publish_capabilities (id,schema_version,issue_command_id,issue_request_sha256,execution_packet_sha256,nonce_sha256,"
                "ticket_sha256,packet_json_sha256,confirmation_sha256,packet_json,ticket_json,confirmation_json,run_id,attempt,packet_command_id,"
                "contract_revision,contract_sha256,platform,release_id,build_id,artifact_sha256,target_account,action,max_clicks,issuer_actor_id,"
                "issuer_principal_id,status,issued_at,expires_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                ("capability-before-0021", "wenmai.publish-capability/1", "issue-before-0021", "1" * 64, "2" * 64, "3" * 64,
                 "4" * 64, "5" * 64, "6" * 64, "{}", "{}", "{}", "run-before-0021", 1, "packet-before-0021", 1,
                 "7" * 64, "bilibili", "release-before-0021", "build-before-0021", "8" * 64, "account-before-0021", "publish", 1,
                 "owner-before-0021", "principal-before-0021", "issued", "2026-08-26T00:00:00.000Z", "2026-08-27T00:00:00.000Z", "2026-08-26T00:00:00.000Z"),
            )
            apply_migrations(upgrade, [migration_0021])
            assert_0021_shape(upgrade)
            if one(upgrade, "SELECT article_id FROM publish_capabilities WHERE id='capability-before-0021'")[0] is not None:
                raise ProbeFailure("0021 backfilled a legacy publish capability article binding")

            upgrade.execute(
                "INSERT INTO package_patch_proposals (id,package_id,base_composition_id,base_composition_sha256,title,operations_json,patch_sha256,created_by_kind,created_by_id,created_at) "
                "VALUES ('patch-before-0022','package-before-0022','composition-before-0022',?,'legacy patch','[]',?,'user','owner-before-0022','2026-08-26T00:00:00.000Z')",
                ("9" * 64, "a" * 64),
            )
            apply_migrations(upgrade, [migration_0022])
            assert_0022_shape(upgrade)
            if tuple(one(upgrade, "SELECT decided_by_kind,decided_by_id FROM package_patch_proposals WHERE id='patch-before-0022'")) != (None, None):
                raise ProbeFailure("0022 backfilled a legacy patch decision actor")

            apply_migrations(upgrade, [migration_0023])
            assert_0023_shape(upgrade)
            preserved_session_after_0023 = tuple(one(
                upgrade,
                "SELECT auth_basis,authority_class,source_client_id,source_permission_snapshot_sha256 FROM management_sessions WHERE id='session-before-0013'",
            ))
            if preserved_session_after_0023 != ("owner_pairing", "owner", None, None):
                raise ProbeFailure(f"0023 changed a legacy management session authority basis: {preserved_session_after_0023}")

            upgrade.execute(
                "INSERT INTO agent_clients (id,label,client_kind,role,token_sha256,scopes_json,article_ids_json,task_ids_json,"
                "credential_purpose,issued_by_source_client_id,exchange_generation,status,expires_at,created_at) "
                "VALUES ('client-before-0025-v4','legacy v4 exchange','mcp','super_admin',?,'[]','[\"*\"]','[]',"
                "'management_session_exchange',NULL,7,'active',?,?)",
                ("e" * 64, "2026-09-01T00:00:00.000Z", "2026-08-28T00:00:00.000Z"),
            )
            upgrade.commit()
            apply_migrations(upgrade, [migration_0024])
            apply_migrations(upgrade, [migration_0025])
            assert_0025_shape(upgrade)
            preserved_v4 = tuple(one(
                upgrade,
                "SELECT credential_purpose,exchange_generation,role,article_ids_json FROM agent_clients WHERE id='client-before-0025-v4'",
            ))
            if preserved_v4 != ("management_session_exchange", 7, "super_admin", '["*"]'):
                raise ProbeFailure(f"0025 did not preserve the legacy v4 exchange Key values: {preserved_v4}")
            try:
                upgrade.execute(
                    "INSERT INTO agent_clients (id,label,client_kind,role,token_sha256,scopes_json,article_ids_json,task_ids_json,"
                    "credential_purpose,issued_by_source_client_id,exchange_generation,status,expires_at,created_at) "
                    "VALUES ('client-self-lineage','self lineage','codex','super_admin',?,'[]','[\"*\"]','[]',"
                    "'site_full_control','client-self-lineage',0,'active',?,?)",
                    ("f" * 64, "2026-09-01T00:00:00.000Z", "2026-08-28T00:00:00.000Z"),
                )
            except sqlite3.IntegrityError:
                pass
            else:
                raise ProbeFailure("0025 accepted a self-referential agent client lineage")
            apply_migrations(upgrade, [migration_0026, migration_0027, migration_0028])
            if one(upgrade, "PRAGMA integrity_check")[0] != "ok":
                raise ProbeFailure("representative 0024→0028 upgrade integrity_check failed")

    return {
        "ok": True,
        "latestMigration": latest,
        "migrationCount": len(migrations),
        "freshChain": True,
        "upgradeThrough0012": True,
        "upgradeFrom0012To0013": True,
        "upgradeFrom0013To0014": True,
        "upgradeFrom0014To0015": True,
        "upgradeFrom0015To0016": True,
        "upgradeFrom0016To0017": True,
        "upgradeFrom0017To0018": True,
        "upgradeFrom0018To0019": True,
        "upgradeFrom0019To0020": True,
        "upgradeFrom0020To0021": True,
        "upgradeFrom0021To0022": True,
        "upgradeFrom0022To0023": True,
        "upgradeFrom0023To0024": True,
        "upgradeFrom0024To0025": True,
        "upgradeFrom0025To0026": True,
        "upgradeFrom0026To0027": True,
        "upgradeFrom0027To0028": True,
        "metaImprovementTablesAndIndexes": True,
        "modelInvocationOutputCheckpointTableAndIndex": True,
        "articleIdentityTablesAndIndexes": True,
        "articleLineageReviewTablesAndIndexes": True,
        "publicationVersionAndBuildInputTablesAndIndexes": True,
        "agentPermissionSnapshotTableAndRoleUpgrade": True,
        "pre0014TablesPreserved": True,
        "pre0015TablesPreserved": True,
        "pre0017TablesPreserved": True,
        "pre0018TablesPreserved": True,
        "pre0019TablesPreserved": True,
        "pre0019AgentClientPreservedAsAgent": True,
        "pre0020MergeActorsRemainNull": True,
        "pre0021PublishCapabilityArticleBindingRemainsNull": True,
        "pre0022PatchDecisionActorsRemainNull": True,
        "pre0023ManagementSessionAuthorityDefaultsPreserved": True,
        "pre0025V4ManagementSessionExchangePreserved": True,
        "v5AgentClientPurposeAndSelfLineageConstraints": True,
        "v5AgentClientCriticalIndexes": True,
        "freshAndUpgradeIntegrityCheck": True,
        "pre0015InvocationPreservedWithoutSyntheticCheckpoint": True,
        "pre0017InvocationAndCheckpointPreserved": True,
        "lineageReviewCandidateOnly": True,
        "duplicateMergeTupleDeterministicallyStaled": True,
        "legacyMetricRemainsUntyped": True,
        "rawMetricDefinitionCount": 5,
        "crossPlatformNormalization": False,
        "trustedDeviceTablesAndIndexes": True,
        "pre0013SessionPreserved": True,
        "pre0014SessionPreserved": True,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1])
    args = parser.parse_args()
    print(json.dumps(run_probe(args.root.resolve()), ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
