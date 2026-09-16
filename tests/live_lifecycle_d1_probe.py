#!/usr/bin/env python3
"""Exercise the lifecycle API against real loopback D1 and remove only QA rows."""

from __future__ import annotations

import argparse
import hashlib
import json
import sqlite3
import uuid
from collections import Counter
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from urllib.error import HTTPError
from urllib.parse import quote
from urllib.request import ProxyHandler, Request, build_opener

from live_merge_d1_probe import ManagementClient, management_actor, response_header


MAX_RESPONSE_BYTES = 4_000_000
SHA256_LENGTH = 64


def sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def canonical_digest(value: Any) -> str:
    encoded = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return sha256_text(encoded)


def iso_z(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def read_json_response(request: Request) -> dict[str, Any]:
    try:
        with build_opener(ProxyHandler({})).open(request, timeout=20) as response:
            body = response.read(MAX_RESPONSE_BYTES + 1)
            if len(body) > MAX_RESPONSE_BYTES:
                raise RuntimeError("Lifecycle API response exceeded probe limit")
            payload = json.loads(body.decode("utf-8"))
            if not isinstance(payload, dict):
                raise RuntimeError("Lifecycle API did not return a JSON object")
            return payload
    except HTTPError as error:
        body = error.read(200_000).decode("utf-8", errors="replace")
        raise RuntimeError(f"Lifecycle API HTTP {error.code}: {body}") from error


class LifecycleClient(ManagementClient):
    def __init__(self, base_url: str, command_prefix: str) -> None:
        super().__init__(base_url)
        self.command_prefix = command_prefix

    def lifecycle_result(
        self,
        action: str,
        payload: dict[str, Any],
        command_id: str | None = None,
    ) -> tuple[int, dict[str, Any], dict[str, str], str]:
        command = command_id or f"{self.command_prefix}{uuid.uuid4().hex}"
        status, result, headers = self._request(
            "POST",
            "/api/lifecycle",
            {"action": action, "commandId": command, "payload": payload},
            authenticated=True,
            mutation=True,
        )
        return status, result, headers, command

    def logout(self) -> None:
        status, result, _ = self._request(
            "POST",
            "/api/auth",
            {"action": "logout"},
            authenticated=True,
            mutation=True,
        )
        require(status == 200 and result.get("ok") is True, f"management logout failed: HTTP {status} {result}")


def api_post(client: LifecycleClient, action: str, payload: dict[str, Any]) -> dict[str, Any]:
    status, result, headers, command_id = client.lifecycle_result(action, payload)
    if status >= 400:
        raise RuntimeError(f"Lifecycle API HTTP {status}: {result}")
    if result.get("ok") is not True:
        raise RuntimeError(f"Lifecycle action {action} did not report ok: {result}")
    require(response_header(headers, "x-wenmai-command-id") == command_id, "Lifecycle response omitted its commandId")
    require_sha(response_header(headers, "x-wenmai-request-sha256"), "Lifecycle receipt request digest")
    require(response_header(headers, "x-wenmai-replayed") == "false", "Fresh Lifecycle command claimed replay")
    return result


def api_get(client: LifecycleClient, article_id: str) -> dict[str, Any]:
    status, result, _ = client._request(
        "GET",
        f"/api/lifecycle?articleId={quote(article_id, safe='')}",
        authenticated=True,
        mutation=False,
    )
    require(status == 200, f"Lifecycle snapshot HTTP {status}: {result}")
    if result.get("ok") is not True or result.get("storage") != "d1-local":
        raise RuntimeError(f"Lifecycle snapshot is unavailable: {result}")
    return result


def workspace_get(client: LifecycleClient, article_id: str) -> dict[str, Any]:
    return client.workspace(quote(article_id, safe=""))


def require(condition: bool, message: str) -> None:
    if not condition:
        raise RuntimeError(message)


def require_sha(value: Any, label: str) -> str:
    text = str(value or "")
    require(len(text) == SHA256_LENGTH and all(character in "0123456789abcdef" for character in text), f"{label} is not SHA-256")
    return text


def insert_fixture(database: Path, ids: dict[str, str], title: str, body: str) -> None:
    body_sha256 = sha256_text(body)
    with sqlite3.connect(database, timeout=20) as connection:
        connection.execute("PRAGMA busy_timeout = 20000")
        connection.execute("BEGIN IMMEDIATE")
        required_tables = {"article_branches", "article_revisions", "branch_working_copies"}
        present = {
            row[0]
            for row in connection.execute(
                "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('article_branches','article_revisions','branch_working_copies')"
            )
        }
        require(present == required_tables, "Workspace tables were not initialized")
        connection.execute(
            "INSERT INTO article_branches (id, article_id, name, slug, status, head_revision_id, base_revision_id) "
            "VALUES (?, ?, 'Lifecycle QA', ?, 'active', ?, ?)",
            (ids["branch"], ids["article"], f"lifecycle-{ids['suffix']}", ids["revision"], ids["revision"]),
        )
        connection.execute(
            "INSERT INTO article_revisions "
            "(id, article_id, branch_id, sequence, title, document_title, body_text, body_sha256, author_kind) "
            "VALUES (?, ?, ?, 1, 'Lifecycle QA baseline', ?, ?, ?, 'import')",
            (ids["revision"], ids["article"], ids["branch"], title, body, body_sha256),
        )
        connection.execute(
            "INSERT INTO branch_working_copies "
            "(branch_id, article_id, base_revision_id, title, body_text, body_sha256, dirty, lock_version) "
            "VALUES (?, ?, ?, ?, ?, ?, 0, 1)",
            (ids["branch"], ids["article"], ids["revision"], title, body, body_sha256),
        )
        connection.commit()


ARTICLE_TABLES = [
    "lifecycle_events",
    "lifecycle_rule_candidates",
    "lifecycle_retrospectives",
    "lifecycle_metric_values",
    "lifecycle_metric_snapshots",
    "lifecycle_releases",
    "lifecycle_build_gate_runs",
    "lifecycle_builds",
    "lifecycle_adaptation_contracts",
    "lifecycle_article_projects",
    "branch_working_copies",
    "article_revisions",
    "article_branches",
]


def table_exists(connection: sqlite3.Connection, table: str) -> bool:
    return connection.execute(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1", (table,)
    ).fetchone() is not None


def cleanup(database: Path, article_id: str, command_prefix: str) -> None:
    with sqlite3.connect(database, timeout=20) as connection:
        connection.execute("PRAGMA busy_timeout = 20000")
        connection.execute("BEGIN IMMEDIATE")
        for table in ARTICLE_TABLES:
            if table_exists(connection, table):
                connection.execute(f"DELETE FROM {table} WHERE article_id = ?", (article_id,))
        if table_exists(connection, "command_receipts"):
            connection.execute("DELETE FROM command_receipts WHERE id LIKE ?", (f"{command_prefix}%",))
        connection.commit()


def assert_no_residue(database: Path, article_id: str, command_prefix: str) -> None:
    residue: dict[str, int] = {}
    with sqlite3.connect(database, timeout=20) as connection:
        connection.execute("PRAGMA busy_timeout = 20000")
        for table in ARTICLE_TABLES:
            if table_exists(connection, table):
                count = int(connection.execute(f"SELECT COUNT(*) FROM {table} WHERE article_id = ?", (article_id,)).fetchone()[0])
                if count:
                    residue[table] = count
        if table_exists(connection, "command_receipts"):
            receipt_count = int(connection.execute(
                "SELECT COUNT(*) FROM command_receipts WHERE id LIKE ?", (f"{command_prefix}%",)
            ).fetchone()[0])
            if receipt_count:
                residue["command_receipts"] = receipt_count
    require(not residue, f"Lifecycle QA cleanup left residue: {residue}")


def validate_default_targets(snapshot: dict[str, Any]) -> dict[str, Any]:
    expected = {
        "target-xiaohongshu-manual-v1": "xiaohongshu.article",
        "target-bilibili-manual-v1": "bilibili.article",
        "target-zhihu-manual-v1": "zhihu.article",
        "target-maimai-manual-v1": "maimai.community-post",
        "target-website-manual-v1": "website.article",
    }
    targets = {str(target["id"]): target for target in snapshot.get("platformTargets", [])}
    require(expected.keys() <= targets.keys(), "Default manual platform targets are missing")
    for target_id, profile_key in expected.items():
        target = targets[target_id]
        require(target.get("profileKey") == profile_key, f"Default target {target_id} profile key drifted")
        require(target.get("connectionMode") == "manual", f"Default target {target_id} claimed a connection")
        require(target.get("profile", {}).get("deliveryMode") == "manual", f"Default target {target_id} delivery mode drifted")
        require(target.get("profile", {}).get("connectionStatus") == "not_connected", f"Default target {target_id} claimed connected")
        require_sha(target.get("profileSha256"), f"Default target {target_id} profile digest")
    maimai = targets["target-maimai-manual-v1"]
    constraints = maimai.get("profile", {}).get("constraints", {})
    require(constraints.get("title", {}).get("required") is False, "Maimai title optionality drifted")
    require(constraints.get("title", {}).get("maxCharacters") == 20, "Maimai title limit drifted")
    require(constraints.get("title", {}).get("evidenceRef") == "contract:maimai-visible-counter", "Maimai title evidence drifted")
    require(constraints.get("body", {}).get("maxCharacters") == 1000, "Maimai body limit drifted")
    require(constraints.get("images", {}).get("maxCount") == 9, "Maimai image limit drifted")
    require(constraints.get("images", {}).get("placement") == "bottom_attachments_only", "Maimai image placement drifted")
    require(constraints.get("images", {}).get("inlineSupported") is False, "Maimai inline image boundary drifted")
    require(constraints.get("topics", {}).get("placement") == "inline_body", "Maimai topic placement drifted")
    require(constraints.get("aiAssistance", {}).get("required") is True, "Maimai AI disclosure gate drifted")
    website = targets["target-website-manual-v1"]
    require(website.get("status") == "active", "Website default target is not active")
    return website


def transition_project(base_url: LifecycleClient, project: dict[str, Any], target_phase: str, note: str) -> dict[str, Any]:
    return api_post(base_url, "transition_project_phase", {
        "projectId": project["id"],
        "targetPhase": target_phase,
        "expectedLockVersion": project["lockVersion"],
        "note": note,
    })["project"]


def update_release(base_url: LifecycleClient, release: dict[str, Any], operation: str, **extra: Any) -> dict[str, Any]:
    payload = {
        "releaseId": release["id"],
        "operation": operation,
        "expectedLockVersion": release["lockVersion"],
        **extra,
    }
    return api_post(base_url, "update_release", payload)["release"]


EXPECTED_EVENT_COUNTS = Counter({
    "article_project.created": 1,
    "article_project.execution_changed": 1,
    "article_project.phase_changed": 6,
    "adaptation_contract.created": 1,
    "adaptation_contract.state_changed": 1,
    "build.inputs_frozen": 1,
    "build.artifact_created": 1,
    "build_gate.compatibility_recorded": 1,
    "build_gate.fidelity_recorded": 1,
    "release.draft_created": 1,
    "release.approval_decided": 1,
    "release.manual_submission_started": 1,
    "release.submission_recorded": 1,
    "release.destination_verified": 1,
    "release.public_visibility_verified": 1,
    "metric_snapshot.collected": 1,
    "metric_snapshot.validated": 1,
    "retrospective.created": 1,
    "retrospective.updated": 1,
    "retrospective.state_changed": 2,
    "rule_candidate.created": 1,
    "rule_candidate.updated": 1,
    "rule_candidate.state_changed": 3,
})


def validate_database(database: Path, ids: dict[str, str], expected: dict[str, Any]) -> dict[str, Any]:
    article_id = ids["article"]
    with sqlite3.connect(database, timeout=20) as connection:
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA busy_timeout = 20000")
        project = connection.execute(
            "SELECT phase, execution_state, lock_version FROM lifecycle_article_projects WHERE id = ? AND article_id = ?",
            (expected["project_id"], article_id),
        ).fetchone()
        contract = connection.execute(
            "SELECT status, source_revision_id, source_body_sha256, target_profile_sha256, contract_sha256 FROM lifecycle_adaptation_contracts WHERE id = ?",
            (expected["contract_id"],),
        ).fetchone()
        build = connection.execute(
            "SELECT state, revision_id, source_body_sha256, target_profile_sha256, contract_sha256, artifact_sha256 FROM lifecycle_builds WHERE id = ?",
            (expected["build_id"],),
        ).fetchone()
        release = connection.execute(
            "SELECT approval_state, submission_state, destination_state, public_state, lifecycle_state, build_artifact_sha256 FROM lifecycle_releases WHERE id = ?",
            (expected["release_id"],),
        ).fetchone()
        metric = connection.execute(
            "SELECT validation_state, measurement_sha256, definition_set_sha256 FROM lifecycle_metric_snapshots WHERE id = ?",
            (expected["metric_id"],),
        ).fetchone()
        metric_values = connection.execute(
            "SELECT definition_id,definition_sha256,observation_state,value_json,value_sha256 "
            "FROM lifecycle_metric_values WHERE snapshot_id = ? ORDER BY definition_id",
            (expected["metric_id"],),
        ).fetchall()
        retrospective = connection.execute(
            "SELECT status, summary, lock_version FROM lifecycle_retrospectives WHERE id = ?",
            (expected["retrospective_id"],),
        ).fetchone()
        rule = connection.execute(
            "SELECT state, scope, counterexamples, owner, implementation_target, regression_ref, lock_version FROM lifecycle_rule_candidates WHERE id = ?",
            (expected["rule_id"],),
        ).fetchone()
        gates = connection.execute(
            "SELECT gate_kind, result, artifact_sha256, target_profile_sha256, contract_sha256, input_sha256 "
            "FROM lifecycle_build_gate_runs WHERE build_id = ? ORDER BY gate_kind",
            (expected["build_id"],),
        ).fetchall()
        event_rows = connection.execute(
            "SELECT event_type, subject_id, payload_json, input_sha256 FROM lifecycle_events WHERE article_id = ? ORDER BY rowid",
            (article_id,),
        ).fetchall()
        receipts = connection.execute(
            "SELECT command_type,actor_id,request_sha256,response_json,status_code,completed_at "
            "FROM command_receipts WHERE id LIKE ? ORDER BY created_at",
            (f"{expected['command_prefix']}%",),
        ).fetchall()

    require(project is not None and tuple(project)[:2] == ("retrospective", "active"), "D1 project state mismatch")
    require(contract is not None and tuple(contract) == (
        "approved", ids["revision"], expected["body_sha256"], expected["target_sha256"], expected["contract_sha256"]
    ), "D1 adaptation contract binding mismatch")
    require(build is not None and tuple(build) == (
        "built", ids["revision"], expected["body_sha256"], expected["target_sha256"], expected["contract_sha256"], expected["artifact_sha256"]
    ), "D1 Build frozen binding mismatch")
    require(release is not None and tuple(release) == (
        "approved", "submission_accepted", "backend_verified", "public_verified", "active", expected["artifact_sha256"]
    ), "D1 Release axes were conflated or not persisted")
    require(metric is not None and metric["validation_state"] == "validated", "D1 metric state mismatch")
    require(metric["measurement_sha256"] == expected["measurement_sha256"], "D1 metric digest mismatch")
    require(metric["definition_set_sha256"] == expected["definition_set_sha256"], "D1 metric definition-set digest mismatch")
    require(len(metric_values) == 5, "D1 metric snapshot does not contain the full typed value set")
    for value in metric_values:
        require_sha(value["definition_sha256"], "D1 MetricValue definition digest")
        require_sha(value["value_sha256"], "D1 MetricValue value digest")
        require(value["observation_state"] in {"observed", "missing"}, "D1 MetricValue observation state drifted")
    require(retrospective is not None and retrospective["status"] == "closed" and retrospective["summary"] == expected["retrospective_summary"], "D1 retrospective update/closure mismatch")
    require(rule is not None and rule["state"] == "adopted" and rule["scope"] and rule["counterexamples"] and rule["owner"] and rule["implementation_target"] and rule["regression_ref"], "D1 rule adoption contract mismatch")
    require(len(gates) == 2 and {row["gate_kind"] for row in gates} == {"compatibility", "fidelity"}, "D1 did not persist exactly two gate kinds")
    for gate in gates:
        require(gate["result"] == "pass", f"D1 {gate['gate_kind']} gate did not pass")
        require(gate["artifact_sha256"] == expected["artifact_sha256"], "D1 gate artifact digest drifted")
        require(gate["target_profile_sha256"] == expected["target_sha256"], "D1 gate target digest drifted")
        require(gate["contract_sha256"] == expected["contract_sha256"], "D1 gate contract digest drifted")
        require_sha(gate["input_sha256"], f"D1 {gate['gate_kind']} input digest")
    event_counts = Counter(row["event_type"] for row in event_rows)
    require(event_counts == EXPECTED_EVENT_COUNTS, f"Lifecycle event chain mismatch: {event_counts}")
    for event in event_rows:
        require_sha(event["input_sha256"], f"Event {event['event_type']} input digest")
        payload = json.loads(event["payload_json"])
        require(isinstance(payload, dict) and payload, f"Event {event['event_type']} has no bound payload")
    require(len(receipts) == len(event_rows), "Lifecycle command receipts do not match successful mutation count")
    for receipt in receipts:
        require(str(receipt["command_type"]).startswith("lifecycle."), "Lifecycle receipt command type drifted")
        require(receipt["actor_id"] == expected["actor_id"], "Lifecycle receipt did not bind the management session actor")
        require_sha(receipt["request_sha256"], "Lifecycle receipt request digest")
        require(receipt["status_code"] in {200, 201} and receipt["completed_at"], "Lifecycle receipt was not completed")
        require(isinstance(json.loads(receipt["response_json"]), dict), "Lifecycle receipt response is not JSON")
    return {"eventCount": len(event_rows), "projectLockVersion": project["lock_version"], "ruleLockVersion": rule["lock_version"]}


def run_probe(base_url: LifecycleClient, database: Path, ids: dict[str, str]) -> dict[str, Any]:
    title = f"Lifecycle QA {ids['suffix'][:8]}"
    body = "# Lifecycle QA\n\n这是一篇只用于本地 D1 生命周期验收的临时文章。\n\n## 核心结论\n\n每个状态声明必须绑定当前制品和独立证据。"
    body_sha256 = sha256_text(body)
    initial = api_get(base_url, ids["article"])
    target = validate_default_targets(initial)
    metric_definitions = sorted(
        [definition for definition in initial.get("metricDefinitions", []) if definition.get("status") == "active"],
        key=lambda definition: str(definition.get("definitionKey", "")),
    )
    require(len(metric_definitions) == 5, "Default raw MetricDefinition set is incomplete")
    expected_metric_keys = {"raw.views", "raw.reads", "raw.completionRate", "raw.saves", "raw.comments"}
    require({definition.get("definitionKey") for definition in metric_definitions} == expected_metric_keys, "Raw metric definition keys drifted")
    for definition in metric_definitions:
        require_sha(definition.get("definitionSha256"), f"MetricDefinition {definition.get('definitionKey')} digest")
        scope = definition.get("scope") or {}
        require(scope.get("crossPlatformComparable") is False, "Raw metric definition claimed cross-platform comparability")
        require(scope.get("normalizationApplied") is False, "Raw metric definition claimed normalization")
        require(definition.get("missingPolicy") == "unknown", "Raw metric missing policy drifted")
    workspace_get(base_url, ids["article"])
    insert_fixture(database, ids, title, body)

    create_payload = {
        "articleId": ids["article"], "title": title, "intent": "验证内容工程完整生命周期", "owner": "Lifecycle QA",
    }
    create_command_id = f"{base_url.command_prefix}create-project-replay"
    first_status, first_result, first_headers, _ = base_url.lifecycle_result("create_project", create_payload, create_command_id)
    replay_status, replay_result, replay_headers, _ = base_url.lifecycle_result("create_project", create_payload, create_command_id)
    require(first_status == replay_status == 201 and first_result == replay_result, "Lifecycle command did not replay the original status/body")
    require(response_header(first_headers, "x-wenmai-replayed") == "false", "First Lifecycle result claimed replay")
    require(response_header(replay_headers, "x-wenmai-replayed") == "true", "Lifecycle replay header is missing")
    mismatch_status, mismatch_result, _, _ = base_url.lifecycle_result(
        "create_project", {**create_payload, "title": f"{title} changed"}, create_command_id,
    )
    require(
        mismatch_status == 409 and "COMMAND_ID_REUSED" in str(mismatch_result.get("error", "")),
        f"Lifecycle commandId accepted a different binding: {mismatch_status} {mismatch_result}",
    )
    project = first_result["project"]
    require(project["phase"] == "pitch" and project["executionState"] == "proposed" and project["lockVersion"] == 1, "Project creation state mismatch")
    project = api_post(base_url, "transition_project_execution", {
        "projectId": project["id"], "targetState": "active", "expectedLockVersion": project["lockVersion"], "note": "QA 启动制作",
    })["project"]
    project = transition_project(base_url, project, "planning", "QA 进入策划")
    project = transition_project(base_url, project, "production", "QA 进入写作实现")
    require(project["phase"] == "production" and project["executionState"] == "active", "Project did not reach active production")

    invariants = {"mustPreserve": ["核心结论", "事实边界"], "fidelityOwner": "Lifecycle QA"}
    rules = {"rendering": "Markdown", "maximumLength": 5000, "manualReview": True}
    contract_title = f"{title} 网站 full 适配合同"
    contract_core = {
        "projectId": project["id"],
        "articleId": ids["article"],
        "targetProfileId": target["id"],
        "targetProfileSha256": target["profileSha256"],
        "sourceRevisionId": ids["revision"],
        "sourceBodySha256": body_sha256,
        "sliceKind": "full",
        "title": contract_title,
        "invariants": invariants,
        "rules": rules,
    }
    contract = api_post(base_url, "create_adaptation_contract", {
        "projectId": project["id"], "targetProfileId": target["id"], "sourceRevisionId": ids["revision"],
        "sourceBodySha256": body_sha256, "sliceKind": "full", "title": contract_title,
        "invariants": invariants, "rules": rules,
    })["adaptationContract"]
    require(contract["status"] == "draft" and contract["contractSha256"] == canonical_digest(contract_core), "Contract digest/state mismatch")
    contract = api_post(base_url, "transition_adaptation_contract", {
        "contractId": contract["id"], "targetState": "approved", "expectedLockVersion": contract["lockVersion"], "note": "QA 人工批准",
    })["adaptationContract"]
    require(contract["status"] == "approved", "Contract did not become approved")

    build = api_post(base_url, "create_build", {
        "projectId": project["id"], "contractId": contract["id"], "branchId": ids["branch"],
        "expectedRevisionId": ids["revision"], "expectedBodySha256": body_sha256,
        "expectedContractSha256": contract["contractSha256"], "expectedTargetProfileSha256": target["profileSha256"],
    })["build"]
    require(build["state"] == "planned" and build["revisionId"] == ids["revision"], "Build did not freeze planned revision")
    require(build["sourceBodySha256"] == body_sha256 and build["targetProfileSha256"] == target["profileSha256"] and build["contractSha256"] == contract["contractSha256"], "Build frozen digests mismatch")
    artifact_body = f"# {title}\n\n已完成网站 full 适配。\n\n<!-- qa:{ids['suffix']} -->"
    artifact_sha256 = sha256_text(artifact_body)
    build = api_post(base_url, "record_build_result", {
        "buildId": build["id"], "targetState": "built", "artifactRef": f"qa-artifact:{ids['suffix']}",
        "artifactSha256": artifact_sha256, "artifactMediaType": "text/markdown",
        "artifactManifest": {"mode": "manual", "sliceKind": "full", "sourceRevisionId": ids["revision"], "qa": ids["suffix"]},
    })["build"]
    require(build["state"] == "built" and build["artifactSha256"] == artifact_sha256, "Build artifact result mismatch")

    gates: dict[str, dict[str, Any]] = {}
    for gate_kind, evidence, details in [
        ("compatibility", ["qa://render/normal-reading", "qa://render/markdown"], {"normalReading": True, "rendering": "pass"}),
        ("fidelity", ["qa://fidelity/core-claim", "qa://fidelity/fact-boundary"], {"coreClaimPreserved": True, "factBoundaryPreserved": True}),
    ]:
        gate = api_post(base_url, "record_build_gate", {
            "buildId": build["id"], "gateKind": gate_kind, "result": "pass", "artifactSha256": artifact_sha256,
            "evidence": evidence, "details": details,
        })["buildGate"]
        expected_gate_digest = canonical_digest({
            "action": "record_build_gate", "buildId": build["id"], "gateKind": gate_kind, "result": "pass",
            "artifactSha256": artifact_sha256, "targetProfileSha256": target["profileSha256"],
            "contractSha256": contract["contractSha256"], "evidence": evidence, "details": details,
        })
        require(gate["result"] == "pass" and gate["inputSha256"] == expected_gate_digest, f"{gate_kind} gate digest mismatch")
        gates[gate_kind] = gate

    release = api_post(base_url, "create_release", {"buildId": build["id"]})["release"]
    require((release["approvalState"], release["submissionState"], release["destinationState"], release["publicState"]) == ("draft", "not_submitted", "not_checked", "not_checked"), "Release draft axes mismatch")
    release = update_release(base_url, release, "decide_approval", targetState="approved", note="QA 人工批准 Release")
    require(release["approvalState"] == "approved" and release["submissionState"] == "not_submitted", "Approval improperly advanced submission")
    release = update_release(base_url, release, "start_submission", note="QA 开始人工提交")
    require(release["submissionState"] == "submitting" and release["destinationState"] == "not_checked" and release["publicState"] == "not_checked", "Submission start improperly advanced verification")
    release = update_release(
        base_url, release, "record_submission", targetState="submission_accepted", remoteRecordId=f"qa-remote-{ids['suffix']}",
        evidence=["qa://submission/receipt"],
    )
    require(release["submissionState"] == "submission_accepted" and release["destinationState"] == "not_checked" and release["publicState"] == "not_checked", "Submission receipt improperly claimed destination/public")
    release = update_release(
        base_url, release, "record_destination", targetState="backend_verified",
        destinationUrl=f"https://qa.invalid/backend/{ids['suffix']}", evidence=["qa://destination/query"],
    )
    require(release["destinationState"] == "backend_verified" and release["publicState"] == "not_checked", "Backend verification improperly claimed public access")
    release = update_release(
        base_url, release, "record_public", targetState="public_verified",
        publicUrl=f"https://qa.invalid/public/{ids['suffix']}", evidence=["qa://public/access-probe"],
    )
    require(release["destinationState"] == "backend_verified" and release["publicState"] == "public_verified", "Independent public verification mismatch")

    for phase, note in [("packaging", "QA 进入表达包装"), ("release", "QA 进入发布"), ("operate", "QA 进入数据运营")]:
        project = transition_project(base_url, project, phase, note)
    now = datetime.now(timezone.utc).replace(microsecond=0)
    raw_values: dict[str, float | int | None] = {
        "raw.views": 120,
        "raw.reads": 80,
        "raw.completionRate": 0.67,
        "raw.saves": 9,
        "raw.comments": None,
    }
    typed_measurements = []
    for definition in metric_definitions:
        definition_id = str(definition["id"])
        definition_sha256 = str(definition["definitionSha256"])
        value = raw_values[str(definition["definitionKey"])]
        observation_state = "observed" if value is not None else "missing"
        value_sha256 = canonical_digest({
            "definitionId": definition_id,
            "definitionSha256": definition_sha256,
            "observationState": observation_state,
            "value": value,
        })
        typed_measurements.append({
            "definitionId": definition_id,
            "definitionKey": definition["definitionKey"],
            "definitionSha256": definition_sha256,
            "observationState": observation_state,
            "value": value,
            "valueSha256": value_sha256,
        })
    definition_set_sha256 = canonical_digest([
        {"definitionId": measurement["definitionId"], "definitionSha256": measurement["definitionSha256"]}
        for measurement in typed_measurements
    ])
    metric_result = api_post(base_url, "record_metric_snapshot", {
        "releaseId": release["id"], "sourceMode": "manual", "sourceLabel": "Lifecycle QA 手工导出",
        "windowStart": iso_z(now - timedelta(days=2)), "windowEnd": iso_z(now - timedelta(days=1)), "capturedAt": iso_z(now),
        "measurements": [
            {
                "definitionId": measurement["definitionId"],
                "definitionSha256": measurement["definitionSha256"],
                "observationState": measurement["observationState"],
                "value": measurement["value"],
            }
            for measurement in typed_measurements
        ],
        "evidenceRef": "qa://metric/export",
    })
    metric = metric_result["metricSnapshot"]
    measurement_core = {
        "releaseId": release["id"], "buildId": build["id"], "buildArtifactSha256": artifact_sha256,
        "sourceMode": metric["sourceMode"], "sourceLabel": metric["sourceLabel"], "windowStart": metric["windowStart"],
        "windowEnd": metric["windowEnd"], "capturedAt": metric["capturedAt"],
        "definitionSetSha256": definition_set_sha256, "measurements": typed_measurements,
        "evidenceRef": metric["evidenceRef"],
    }
    require(metric["measurementSha256"] == canonical_digest(measurement_core), "Metric measurement digest mismatch")
    require(metric["definitionSetSha256"] == definition_set_sha256 and metric["schemaState"] == "typed", "Metric definition set was not frozen")
    require(len(metric_result.get("metricValues", [])) == 5, "Metric snapshot did not atomically return all MetricValues")
    metric = api_post(base_url, "validate_metric_snapshot", {
        "metricSnapshotId": metric["id"], "expectedState": "collected", "targetState": "validated", "note": "QA 核对窗口、口径和导出证据",
    })["metricSnapshot"]
    require(metric["validationState"] == "validated", "Metric did not become validated")

    project = transition_project(base_url, project, "retrospective", "QA 进入复盘")
    retrospective = api_post(base_url, "create_retrospective", {
        "projectId": project["id"], "releaseId": release["id"], "title": f"{title} 复盘",
        "summary": "QA 初稿，等待补充。", "evidenceRefs": [f"release:{release['id']}"],
    })["retrospective"]
    final_summary = "QA 完整复盘：Build、两类门禁、提交、后台、公开与指标证据保持独立。"
    retrospective = api_post(base_url, "update_retrospective", {
        "retrospectiveId": retrospective["id"], "expectedLockVersion": retrospective["lockVersion"],
        "title": f"{title} 完整复盘", "summary": final_summary,
        "evidenceRefs": [f"release:{release['id']}", f"metric:{metric['id']}", f"build:{build['id']}"],
    })["retrospective"]
    retrospective = api_post(base_url, "transition_retrospective", {
        "retrospectiveId": retrospective["id"], "targetState": "reviewed", "expectedLockVersion": retrospective["lockVersion"], "note": "QA 完成复盘评审",
    })["retrospective"]
    retrospective = api_post(base_url, "transition_retrospective", {
        "retrospectiveId": retrospective["id"], "targetState": "closed", "expectedLockVersion": retrospective["lockVersion"], "note": "QA 关闭复盘",
    })["retrospective"]
    require(retrospective["status"] == "closed" and retrospective["summary"] == final_summary, "Retrospective update/review/close mismatch")

    rule = api_post(base_url, "create_rule_candidate", {
        "retrospectiveId": retrospective["id"], "title": "Release Claim 必须独立验证", "ruleText": "提交回执不得推出后台记录或公开可见。",
    })["ruleCandidate"]
    rule = api_post(base_url, "update_rule_candidate", {
        "ruleCandidateId": rule["id"], "expectedLockVersion": rule["lockVersion"],
        "title": rule["title"], "ruleText": rule["ruleText"], "scope": "所有人工或自动平台发布流程",
        "counterexamples": "纯本地预览不产生平台提交 Claim", "owner": "Lifecycle QA",
        "implementationTarget": "lifecycle Release 状态机与回归门禁", "regressionRef": "tests/live_lifecycle_d1_probe.py",
        "evidenceRefs": [f"retrospective:{retrospective['id']}", f"metric:{metric['id']}", f"release:{release['id']}"],
    })["ruleCandidate"]
    for state, note in [("testing", "QA 进入测试"), ("verified", "QA 回归验证通过"), ("adopted", "QA 满足采纳证据合同")]:
        rule = api_post(base_url, "transition_rule_candidate", {
            "ruleCandidateId": rule["id"], "targetState": state, "expectedLockVersion": rule["lockVersion"], "note": note,
        })["ruleCandidate"]
    require(rule["state"] == "adopted", "Rule candidate did not reach adopted")

    snapshot = api_get(base_url, ids["article"])
    article_events = [event for event in snapshot["events"] if event.get("articleId") == ids["article"]]
    require(Counter(event["eventType"] for event in article_events) == EXPECTED_EVENT_COUNTS, "API snapshot event chain mismatch")
    for event in article_events:
        require_sha(event.get("inputSha256"), f"API event {event.get('eventType')} input digest")
        require(isinstance(event.get("payload"), dict) and event["payload"], f"API event {event.get('eventType')} lacks payload")
    require(len(snapshot["projects"]) == 1 and snapshot["projects"][0]["phase"] == "retrospective", "API final project snapshot mismatch")
    require(len(snapshot["adaptationContracts"]) == 1 and snapshot["adaptationContracts"][0]["contractSha256"] == contract["contractSha256"], "API final contract snapshot mismatch")
    require(len(snapshot["builds"]) == 1 and snapshot["builds"][0]["artifactSha256"] == artifact_sha256, "API final Build snapshot mismatch")
    require(len(snapshot["buildGates"]) == 2, "API final gate snapshot mismatch")
    require(len(snapshot["releases"]) == 1 and snapshot["releases"][0]["publicState"] == "public_verified", "API final Release snapshot mismatch")
    require(len(snapshot["metricSnapshots"]) == 1 and snapshot["metricSnapshots"][0]["validationState"] == "validated", "API final metric snapshot mismatch")
    require(len(snapshot["metricDefinitions"]) == 5 and len(snapshot["metricValues"]) == 5, "API final typed metric objects mismatch")
    require(snapshot["metricSnapshots"][0]["schemaState"] == "typed", "API final metric snapshot is not typed")
    require(len(snapshot["retrospectives"]) == 1 and snapshot["retrospectives"][0]["status"] == "closed", "API final retrospective snapshot mismatch")
    require(len(snapshot["ruleCandidates"]) == 1 and snapshot["ruleCandidates"][0]["state"] == "adopted", "API final rule snapshot mismatch")

    database_evidence = validate_database(database, ids, {
        "project_id": project["id"], "contract_id": contract["id"], "build_id": build["id"], "release_id": release["id"],
        "metric_id": metric["id"], "retrospective_id": retrospective["id"], "rule_id": rule["id"],
        "body_sha256": body_sha256, "target_sha256": target["profileSha256"], "contract_sha256": contract["contractSha256"],
        "artifact_sha256": artifact_sha256, "measurement_sha256": metric["measurementSha256"], "retrospective_summary": final_summary,
        "definition_set_sha256": definition_set_sha256,
        "command_prefix": base_url.command_prefix,
        "actor_id": management_actor(database, base_url.browser_binding_sha256),
    })
    return {
        "ok": True,
        "articleId": ids["article"],
        "projectId": project["id"],
        "contractSha256": contract["contractSha256"],
        "buildId": build["id"],
        "artifactSha256": artifact_sha256,
        "releaseAxes": {
            "approval": release["approvalState"], "submission": release["submissionState"],
            "destination": release["destinationState"], "public": release["publicState"], "lifecycle": release["lifecycleState"],
        },
        "metricState": metric["validationState"],
        "metricDefinitionSetSha256": definition_set_sha256,
        "metricValueCount": len(metric_result.get("metricValues", [])),
        "crossPlatformNormalization": False,
        "retrospectiveState": retrospective["status"],
        "ruleState": rule["state"],
        "eventCount": database_evidence["eventCount"],
        "defaultTargetsManualAndDisconnected": True,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-url", default="http://[::1]:3000")
    parser.add_argument("--database", type=Path, required=True)
    parser.add_argument("--pairing-code", required=True, help="fresh one-time code printed by start-wenmai.cmd")
    args = parser.parse_args()
    database = args.database.resolve()
    suffix = uuid.uuid4().hex
    ids = {
        "suffix": suffix,
        "article": f"__lifecycle_qa__{suffix}",
        "branch": f"qa-lifecycle-branch-{suffix}",
        "revision": f"qa-lifecycle-revision-{suffix}",
    }
    command_prefix = f"lifecycle-qa:{suffix}:"
    client = LifecycleClient(args.base_url, command_prefix)
    client.bootstrap(args.pairing_code)
    result: dict[str, Any] | None = None
    try:
        result = run_probe(client, database, ids)
    finally:
        cleanup(database, ids["article"], command_prefix)
        assert_no_residue(database, ids["article"], command_prefix)
        client.logout()
    require(result is not None, "Lifecycle probe produced no result")
    result["cleanupVerified"] = True
    result["logoutVerified"] = True
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
