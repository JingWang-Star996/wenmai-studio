#!/usr/bin/env python3
"""Exercise the Agent control plane against real loopback D1 and clean only probe rows."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sqlite3
import subprocess
import sys
import uuid
from pathlib import Path
from typing import Any
from urllib.error import HTTPError
from urllib.parse import quote, urlsplit, urlunsplit
from urllib.request import ProxyHandler, Request, build_opener


MAX_RESPONSE_BYTES = 5_000_000


def require(condition: bool, message: str) -> None:
    if not condition:
        raise RuntimeError(message)


def sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def request_json(request: Request) -> tuple[int, dict[str, Any]]:
    try:
        with build_opener(ProxyHandler({})).open(request, timeout=20) as response:
            body = response.read(MAX_RESPONSE_BYTES + 1)
            require(len(body) <= MAX_RESPONSE_BYTES, "Agent API response exceeded probe limit")
            payload = json.loads(body.decode("utf-8"))
            require(isinstance(payload, dict), "Agent API response was not a JSON object")
            return int(response.status), payload
    except HTTPError as error:
        body = error.read(MAX_RESPONSE_BYTES + 1)
        require(len(body) <= MAX_RESPONSE_BYTES, "Agent API error response exceeded probe limit")
        payload = json.loads(body.decode("utf-8"))
        require(isinstance(payload, dict), "Agent API error was not a JSON object")
        return int(error.code), payload


def management_post(base_url: str, action: str, payload: dict[str, Any], command_id: str | None = None) -> dict[str, Any]:
    body: dict[str, Any] = {"action": action, "payload": payload}
    if command_id:
        body["commandId"] = command_id
    request = Request(
        f"{base_url}/api/agent/v1",
        data=json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode("utf-8"),
        headers={"content-type": "application/json", "origin": base_url, "x-wenmai-write": "1"},
        method="POST",
    )
    status, result = request_json(request)
    require(status < 400 and result.get("ok") is True, f"management {action} failed: HTTP {status} {result}")
    return result["data"]


def agent_post(
    base_url: str,
    token: str,
    action: str,
    command_id: str,
    payload: dict[str, Any],
    expected_status: int | None = None,
) -> tuple[int, dict[str, Any]]:
    request = Request(
        f"{base_url}/api/agent/v1",
        data=json.dumps({"action": action, "commandId": command_id, "payload": payload}, ensure_ascii=False, separators=(",", ":")).encode("utf-8"),
        headers={"content-type": "application/json", "authorization": f"Bearer {token}"},
        method="POST",
    )
    status, result = request_json(request)
    if expected_status is None:
        require(status < 400 and result.get("ok") is True, f"Agent {action} failed: HTTP {status} {result}")
    else:
        require(status == expected_status and result.get("ok") is False, f"Agent {action} expected HTTP {expected_status}: {status} {result}")
    return status, result


def api_get(base_url: str, query: str, token: str | None = None, same_origin: bool = False) -> tuple[int, dict[str, Any]]:
    headers: dict[str, str] = {}
    if token:
        headers["authorization"] = f"Bearer {token}"
    if same_origin:
        headers["origin"] = base_url
    return request_json(Request(f"{base_url}/api/agent/v1?{query}", headers=headers, method="GET"))


def table_exists(connection: sqlite3.Connection, table: str) -> bool:
    return connection.execute(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1", (table,)
    ).fetchone() is not None


def cleanup(database: Path, task_id: str | None, client_id: str | None, command_ids: list[str]) -> None:
    with sqlite3.connect(database, timeout=20) as connection:
        connection.execute("PRAGMA busy_timeout = 20000")
        connection.execute("BEGIN IMMEDIATE")
        if task_id:
            agent_branch_id = f"agent-branch-{task_id}"
            revision_ids = []
            if table_exists(connection, "article_revisions"):
                revision_ids = [str(row[0]) for row in connection.execute(
                    "SELECT id FROM article_revisions WHERE branch_id = ?", (agent_branch_id,)
                )]
            if table_exists(connection, "workspace_events"):
                subject_ids = [agent_branch_id, *revision_ids]
                placeholders = ",".join("?" for _ in subject_ids)
                connection.execute(f"DELETE FROM workspace_events WHERE subject_id IN ({placeholders})", subject_ids)
            for table in [
                "agent_progress_events", "graph_proposals", "agent_approval_requests", "agent_task_artifacts",
                "agent_task_leases", "agent_task_attempts", "agent_context_snapshots",
            ]:
                if table_exists(connection, table):
                    connection.execute(f"DELETE FROM {table} WHERE task_id = ?", (task_id,))
            if table_exists(connection, "agent_tasks"):
                connection.execute("DELETE FROM agent_tasks WHERE id = ?", (task_id,))
            if table_exists(connection, "branch_working_copies"):
                connection.execute("DELETE FROM branch_working_copies WHERE branch_id = ?", (agent_branch_id,))
            if table_exists(connection, "article_revisions"):
                connection.execute("DELETE FROM article_revisions WHERE branch_id = ?", (agent_branch_id,))
            if table_exists(connection, "article_branches"):
                connection.execute("DELETE FROM article_branches WHERE id = ?", (agent_branch_id,))
        if client_id and table_exists(connection, "agent_clients"):
            connection.execute("DELETE FROM agent_clients WHERE id = ?", (client_id,))
        if command_ids and table_exists(connection, "command_receipts"):
            placeholders = ",".join("?" for _ in command_ids)
            connection.execute(f"DELETE FROM command_receipts WHERE id IN ({placeholders})", command_ids)
        connection.commit()


def assert_cleanup(database: Path, task_id: str | None, client_id: str | None, command_ids: list[str]) -> None:
    residue: dict[str, int] = {}
    with sqlite3.connect(database, timeout=20) as connection:
        connection.execute("PRAGMA busy_timeout = 20000")
        if task_id:
            agent_branch_id = f"agent-branch-{task_id}"
            for table in [
                "agent_progress_events", "graph_proposals", "agent_approval_requests", "agent_task_artifacts",
                "agent_task_leases", "agent_task_attempts", "agent_context_snapshots",
            ]:
                if table_exists(connection, table):
                    count = int(connection.execute(f"SELECT COUNT(*) FROM {table} WHERE task_id = ?", (task_id,)).fetchone()[0])
                    if count:
                        residue[table] = count
            if table_exists(connection, "agent_tasks"):
                count = int(connection.execute("SELECT COUNT(*) FROM agent_tasks WHERE id = ?", (task_id,)).fetchone()[0])
                if count:
                    residue["agent_tasks"] = count
            for table, column in [
                ("branch_working_copies", "branch_id"), ("article_revisions", "branch_id"), ("article_branches", "id"),
            ]:
                if table_exists(connection, table):
                    count = int(connection.execute(f"SELECT COUNT(*) FROM {table} WHERE {column} = ?", (agent_branch_id,)).fetchone()[0])
                    if count:
                        residue[table] = count
            if table_exists(connection, "workspace_events"):
                count = int(connection.execute("SELECT COUNT(*) FROM workspace_events WHERE subject_id = ?", (agent_branch_id,)).fetchone()[0])
                if count:
                    residue["workspace_events"] = count
        if client_id and table_exists(connection, "agent_clients"):
            count = int(connection.execute("SELECT COUNT(*) FROM agent_clients WHERE id = ?", (client_id,)).fetchone()[0])
            if count:
                residue["agent_clients"] = count
        if command_ids and table_exists(connection, "command_receipts"):
            placeholders = ",".join("?" for _ in command_ids)
            count = int(connection.execute(f"SELECT COUNT(*) FROM command_receipts WHERE id IN ({placeholders})", command_ids).fetchone()[0])
            if count:
                residue["command_receipts"] = count
    require(not residue, f"Agent probe cleanup left residue: {residue}")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-url", default="http://localhost:3000")
    parser.add_argument("--database", type=Path, required=True)
    parser.add_argument("--article-id")
    parser.add_argument("--cleanup-task-id")
    parser.add_argument("--cleanup-client-id")
    parser.add_argument("--cleanup-suffix")
    args = parser.parse_args()
    if args.cleanup_task_id or args.cleanup_client_id or args.cleanup_suffix:
        require(bool(args.cleanup_task_id and args.cleanup_client_id and args.cleanup_suffix), "cleanup recovery requires task id, client id, and suffix together")
        recovery_commands = [
            f"agent-probe-{name}-{args.cleanup_suffix}" for name in [
                "create", "claim", "reclaim", "heartbeat", "bad-heartbeat", "progress", "artifact", "graph", "complete", "decide",
                "revision", "revision-stale", "create-revoke", "claim-revoke", "heartbeat-revoke", "cancel-stale", "revoke",
            ]
        ]
        cleanup(args.database.resolve(), args.cleanup_task_id, args.cleanup_client_id, recovery_commands)
        assert_cleanup(args.database.resolve(), args.cleanup_task_id, args.cleanup_client_id, recovery_commands)
        print(json.dumps({"ok": True, "cleanupVerified": True, "recovery": True}, ensure_ascii=False))
        return 0
    project_root = Path(__file__).resolve().parent.parent
    corpus = json.loads((project_root / "data" / "corpus.generated.json").read_text(encoding="utf-8"))
    article_id = args.article_id or str(corpus["articles"][0]["id"])
    suffix = uuid.uuid4().hex
    commands = {name: f"agent-probe-{name}-{suffix}" for name in [
        "create", "claim", "reclaim", "heartbeat", "bad-heartbeat", "progress", "artifact", "graph", "complete", "decide",
        "issue", "revision", "revision-stale", "create-revoke", "claim-revoke", "heartbeat-revoke", "cancel-stale", "revoke",
    ]}
    command_ids = list(commands.values())
    task_id: str | None = None
    revocation_task_id: str | None = None
    client_id: str | None = None
    result: dict[str, Any] | None = None
    try:
        health_status, health = api_get(args.base_url, "view=health", same_origin=True)
        require(health_status == 200 and health.get("ok") is True, f"health unavailable: {health_status} {health}")
        issued = management_post(args.base_url, "issue_client", {
            "label": f"Agent control live probe {suffix[:8]}",
            "clientKind": "custom",
            "articleIds": [article_id],
        }, commands["issue"])
        client_id = str(issued["client"]["id"])
        token = str(issued["token"])
        require(issued.get("shownOnce") is True and token.startswith("wenmai_agent_"), "issue_client token contract drifted")

        parsed_base_url = urlsplit(args.base_url)
        client_host = "::1" if parsed_base_url.hostname == "localhost" else parsed_base_url.hostname
        require(client_host in {"127.0.0.1", "::1"}, "live client probe requires an explicit loopback base URL")
        client_netloc = f"[{client_host}]" if client_host == "::1" else str(client_host)
        if parsed_base_url.port is not None:
            client_netloc = f"{client_netloc}:{parsed_base_url.port}"
        client_base_url = urlunsplit((parsed_base_url.scheme, client_netloc, parsed_base_url.path.rstrip("/"), "", ""))
        client_environment = os.environ.copy()
        client_environment["WENMAI_AGENT_TOKEN"] = token
        client_status = subprocess.run(
            [
                sys.executable,
                "-B",
                str(project_root / "scripts" / "wenmai_agent_client.py"),
                "--base-url",
                client_base_url,
                "status",
            ],
            cwd=project_root,
            env=client_environment,
            capture_output=True,
            text=True,
            encoding="utf-8",
            timeout=20,
            check=False,
        )
        require(client_status.returncode == 0, f"real Agent client status failed: {client_status.stderr.strip()}")
        client_status_payload = json.loads(client_status.stdout.strip())
        require(client_status_payload.get("ok") is True, "real Agent client status returned an error envelope")
        require(client_status_payload.get("data", {}).get("clients", [{}])[0].get("id") == client_id, "real Agent client status escaped or missed its client boundary")

        created = management_post(args.base_url, "create_task", {
            "articleId": article_id,
            "title": f"Agent 控制面探针 {suffix[:8]}",
            "objective": "验证任务、租约、事件、工件、图谱提案与人工验收的真实 D1 闭环。",
            "instructionsMd": "只写临时内联工件，不触碰文章主分支。",
            "acceptance": ["工件摘要可校验", "图谱只形成 candidate", "人工接受后任务 succeeded"],
            "contextSpec": {"graphDepth": 1, "body": "current"},
            "writeScope": "agent-branch",
            "permissionCeiling": {"allow": ["article.read", "artifact.create", "graph.propose", "branch.agent_write", "main.write"]},
            "priority": "P2",
        }, commands["create"])
        task = created["task"]
        task_id = str(task["id"])
        require(task["state"] == "queued", "create_task did not queue the task")
        require(created["agentBranch"]["id"] == f"agent-branch-{task_id}", "create_task did not bind a task-owned Agent branch")
        require(task["targetBranchId"] == created["agentBranch"]["id"], "task target is not the Agent branch")
        require(task["permissionCeiling"]["branchWrite"] is True, "Agent branch task did not freeze branch write permission")
        require("main.write" in task["permissionCeiling"]["deny"], "permission ceiling did not hard-deny main.write")

        tasks_status, tasks_result = api_get(args.base_url, "view=tasks", token=token)
        require(tasks_status == 200 and any(item["id"] == task_id for item in tasks_result["data"]["tasks"]), "Bearer task listing missed bounded task")
        _, claimed_result = agent_post(args.base_url, token, "claim", commands["claim"], {"taskId": task_id})
        claimed = claimed_result["data"]
        attempt_id = str(claimed["attempt"]["id"])
        lease_id = str(claimed["lease"]["id"])
        lease_token = str(claimed["lease"]["leaseToken"])
        context_sha = str(claimed["context"]["sha256"])
        common = {
            "taskId": task_id, "attemptId": attempt_id, "leaseId": lease_id,
            "leaseToken": lease_token, "contextSha256": context_sha,
        }
        _, replay_result = agent_post(args.base_url, token, "claim", commands["claim"], {"taskId": task_id})
        require(replay_result["data"]["lease"]["leaseToken"] == lease_token, "claim idempotency did not replay the same lease")
        _, reused = agent_post(args.base_url, token, "claim", commands["claim"], {"taskId": task_id + "-different"}, 409)
        require(reused["error"]["code"] == "COMMAND_ID_REUSED", "commandId reuse did not fail closed")

        context_status, context_result = api_get(
            args.base_url,
            f"view=context&taskId={quote(task_id, safe='')}&contextId={quote(str(claimed['context']['id']), safe='')}",
            token=token,
        )
        require(context_status == 200, f"context read failed: {context_result}")
        context = context_result["data"]["contextSnapshot"]
        source = context["bundle"]["source"]
        require(sha256_text(source["bodyText"]) == source["bodySha256"], "frozen body digest mismatch")
        require(context["contextSha256"] == context_sha, "claim context SHA drifted")

        first_attempt_id = attempt_id
        with sqlite3.connect(args.database.resolve(), timeout=20) as connection:
            connection.execute("PRAGMA busy_timeout = 20000")
            connection.execute("UPDATE agent_task_leases SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?", (lease_id,))
            connection.commit()
        _, reclaimed_result = agent_post(args.base_url, token, "claim", commands["reclaim"], {"taskId": task_id})
        reclaimed = reclaimed_result["data"]
        attempt_id = str(reclaimed["attempt"]["id"])
        lease_id = str(reclaimed["lease"]["id"])
        lease_token = str(reclaimed["lease"]["leaseToken"])
        context_sha = str(reclaimed["context"]["sha256"])
        common = {
            "taskId": task_id, "attemptId": attempt_id, "leaseId": lease_id,
            "leaseToken": lease_token, "contextSha256": context_sha,
        }
        require(attempt_id != first_attempt_id, "expired lease recovery reused the old attempt")

        agent_post(args.base_url, token, "heartbeat", commands["heartbeat"], {**common, "heartbeatSeq": 1})
        _, bad_heartbeat = agent_post(args.base_url, token, "heartbeat", commands["bad-heartbeat"], {**common, "heartbeatSeq": 3}, 409)
        require(bad_heartbeat["error"]["code"] == "HEARTBEAT_OUT_OF_ORDER", "out-of-order heartbeat did not fail closed")
        agent_post(args.base_url, token, "progress", commands["progress"], {
            **common, "phase": "drafting", "progressPercent": 55, "currentAction": "整理探针证据",
            "nextAction": "提交工件与图谱候选", "message": "真实 D1 写入中", "evidence": ["live-probe"],
        })
        proposed_body = source["bodyText"] + "\n\n## Agent D1 probe\n\nThis paragraph exists only on the task-owned Agent branch."
        _, revision_result = agent_post(args.base_url, token, "propose_revision", commands["revision"], {
            **common, "expectedHeadRevisionId": reclaimed["context"]["revisionId"],
            "title": source["documentTitle"] + " · Agent probe", "bodyText": proposed_body,
            "summary": "验证不可变 agent revision 与 branch-head CAS。",
        })
        revision_data = revision_result["data"]
        proposed_revision_id = str(revision_data["revision"]["id"])
        require(revision_data["revision"]["authorKind"] == "agent", "proposed revision author kind drifted")
        require(revision_data["branch"]["headRevisionId"] == proposed_revision_id, "Agent branch head did not advance")
        require(revision_data["workingCopy"]["baseRevisionId"] == proposed_revision_id, "working-copy base did not follow Agent branch head")
        require(revision_data["boundary"]["mainWritten"] is False and revision_data["boundary"]["mergePerformed"] is False, "Agent revision crossed main/merge boundary")
        _, stale_revision = agent_post(args.base_url, token, "propose_revision", commands["revision-stale"], {
            **common, "expectedHeadRevisionId": reclaimed["context"]["revisionId"],
            "title": "陈旧提案不应写入", "bodyText": proposed_body + "\n\nstale",
        }, 409)
        require(stale_revision["error"]["code"] == "BRANCH_HEAD_STALE", "stale Agent revision did not fail closed")
        inline_content = "# Agent probe artifact\n\nThis is an immutable candidate artifact."
        _, artifact_result = agent_post(args.base_url, token, "add_artifact", commands["artifact"], {
            **common, "kind": "candidate-markdown", "title": "探针候选工件",
            "contentRef": f"agent-inline:{suffix}", "inlineContent": inline_content,
            "sha256": sha256_text(inline_content), "mediaType": "text/markdown",
            "sizeBytes": len(inline_content.encode("utf-8")), "artifactPayload": {"probe": True},
        })
        artifact_id = str(artifact_result["data"]["artifact"]["id"])
        _, graph_result = agent_post(args.base_url, token, "create_graph_proposal", commands["graph"], {
            **common, "proposalKind": "claim", "label": "Agent 控制面闭环已经通过真实 D1 探针",
            "proposalPayload": {"confidence": "probe-only"}, "evidence": [f"artifact:{artifact_id}"],
        })
        require(graph_result["data"]["graphProposal"]["status"] == "candidate", "Agent graph proposal escaped candidate status")
        require(graph_result["data"]["canonicalGraphMutated"] is False, "Agent graph proposal claimed canonical mutation")

        _, completed_result = agent_post(args.base_url, token, "complete", commands["complete"], {
            **common, "summary": "探针动作完成，提交人工技术验收；不代表文章或发布审批。",
            "artifactIds": [artifact_id], "evidence": ["live-d1"],
        })
        approval = completed_result["data"]["approvalRequest"]
        require(completed_result["data"]["task"]["state"] == "review", "complete bypassed review state")
        require(completed_result["data"]["leaseRevoked"] is True, "complete did not revoke lease")

        denied_request = Request(
            f"{args.base_url}/api/agent/v1",
            data=json.dumps({
                "action": "decide_approval", "commandId": f"agent-illegal-decide-{suffix}",
                "payload": {"approvalRequestId": approval["id"], "expectedLockVersion": 1, "decision": "approved"},
            }).encode("utf-8"),
            headers={"content-type": "application/json", "authorization": f"Bearer {token}"},
            method="POST",
        )
        denied_status, denied = request_json(denied_request)
        require(denied_status == 403 and denied["error"]["code"] == "ORIGIN_MISMATCH", "Agent could invoke a management decision")
        accepted = management_post(args.base_url, "decide_approval", {
            "approvalRequestId": approval["id"], "expectedLockVersion": approval["lockVersion"],
            "decision": "approved", "note": "真实 D1 探针技术验收通过。",
        }, commands["decide"])
        require(accepted["task"]["state"] == "succeeded", "human acceptance did not finish task")
        require(accepted["boundary"]["editorialApproved"] is False, "technical acceptance claimed editorial approval")

        revocation_task = management_post(args.base_url, "create_task", {
            "articleId": article_id,
            "title": f"Agent 撤销恢复探针 {suffix[:8]}",
            "objective": "验证活动 Agent token 撤销会回收租约并将任务退回队列。",
            "priority": "P3",
        }, commands["create-revoke"])["task"]
        revocation_task_id = str(revocation_task["id"])
        _, revocation_claim_result = agent_post(
            args.base_url, token, "claim", commands["claim-revoke"], {"taskId": revocation_task_id}
        )
        revocation_claim = revocation_claim_result["data"]
        revocation_common = {
            "taskId": revocation_task_id,
            "attemptId": revocation_claim["attempt"]["id"],
            "leaseId": revocation_claim["lease"]["id"],
            "leaseToken": revocation_claim["lease"]["leaseToken"],
            "contextSha256": revocation_claim["context"]["sha256"],
        }
        agent_post(args.base_url, token, "heartbeat", commands["heartbeat-revoke"], {**revocation_common, "heartbeatSeq": 1})
        stale_cancel_request = Request(
            f"{args.base_url}/api/agent/v1",
            data=json.dumps({
                "action": "cancel_task", "commandId": commands["cancel-stale"],
                "payload": {"taskId": revocation_task_id, "expectedLockVersion": 999_999, "note": "故意使用陈旧锁版本。"},
            }, ensure_ascii=False, separators=(",", ":")).encode("utf-8"),
            headers={"content-type": "application/json", "origin": args.base_url, "x-wenmai-write": "1"},
            method="POST",
        )
        stale_cancel_status, stale_cancel = request_json(stale_cancel_request)
        require(stale_cancel_status == 409 and stale_cancel["error"]["code"] == "TASK_STALE", "stale cancel did not fail closed")
        stale_task_status, stale_task_result = api_get(
            args.base_url, f"view=task&taskId={quote(revocation_task_id, safe='')}", same_origin=True
        )
        require(stale_task_status == 200 and stale_task_result["data"]["task"]["state"] == "running", "stale cancel mutated the active task")
        require(stale_task_result["data"]["attempts"][0]["state"] == "running", "stale cancel mutated the active attempt")
        revoked = management_post(args.base_url, "revoke_client", {
            "clientId": client_id, "note": "探针结束，撤销临时凭证。",
        }, commands["revoke"])
        require(revoked["status"] == "revoked", "client revocation failed")
        require(revocation_task_id in revoked["recoveredTaskIds"], "active task was not reported as recovered on client revocation")
        revoked_status, revoked_read = api_get(args.base_url, "view=tasks", token=token)
        require(revoked_status == 401 and revoked_read["error"]["code"] == "AUTH_INVALID", "revoked token remained usable")

        with sqlite3.connect(args.database.resolve(), timeout=20) as connection:
            token_row = connection.execute("SELECT token_sha256, status FROM agent_clients WHERE id = ?", (client_id,)).fetchone()
            event_count = int(connection.execute("SELECT COUNT(*) FROM agent_progress_events WHERE task_id = ?", (task_id,)).fetchone()[0])
            context_count = int(connection.execute("SELECT COUNT(*) FROM agent_context_snapshots WHERE task_id = ?", (task_id,)).fetchone()[0])
            first_attempt_state = connection.execute("SELECT state, error_class FROM agent_task_attempts WHERE id = ?", (first_attempt_id,)).fetchone()
            proposed_revision_state = connection.execute(
                "SELECT author_kind, body_sha256 FROM article_revisions WHERE id = ?", (proposed_revision_id,)
            ).fetchone()
            revoked_task_state = connection.execute(
                "SELECT state, active_attempt_id, assigned_client_id FROM agent_tasks WHERE id = ?", (revocation_task_id,)
            ).fetchone()
            revoked_attempt_state = connection.execute(
                "SELECT state, error_class FROM agent_task_attempts WHERE id = ?", (revocation_common["attemptId"],)
            ).fetchone()
            persisted_lease_digest = connection.execute(
                "SELECT lease_token_sha256 FROM agent_task_leases WHERE id = ?", (lease_id,)
            ).fetchone()
            receipt_payloads = [str(row[0]) for row in connection.execute(
                f"SELECT response_json FROM command_receipts WHERE id IN ({','.join('?' for _ in command_ids)})",
                command_ids,
            )]
        require(token_row == (sha256_text(token), "revoked"), "D1 did not retain only the revoked client token digest")
        require(persisted_lease_digest == (sha256_text(lease_token),), "D1 lease digest did not match the transient lease token")
        require(all("wenmai_lease_" not in payload for payload in receipt_payloads), "CommandReceipt persisted a plaintext lease token")
        require(first_attempt_state == ("released", "lease_expired"), "expired attempt was not safely released")
        require(proposed_revision_state == ("agent", sha256_text(proposed_body)), "persisted Agent revision digest mismatch")
        require(revoked_task_state == ("queued", None, None), "client revocation did not safely return active task to queue")
        require(revoked_attempt_state == ("released", "client_revoked"), "client revocation did not release active attempt")
        require(event_count >= 11 and context_count == 1, "expected immutable context/event evidence is incomplete")
        result = {
            "ok": True, "articleId": article_id, "taskState": accepted["task"]["state"],
            "graphProposalState": graph_result["data"]["graphProposal"]["status"],
            "eventCount": event_count, "contextCount": context_count,
            "claimReplayStable": True, "expiredLeaseRecovered": True, "agentBranchRevisionProposed": True,
            "staleRevisionRejected": True, "activeClientTaskRecovered": True,
            "staleCancelFailedClosed": True, "revokedTokenRejected": True, "realClientStatusOk": True,
            "leaseSecretsNotPersisted": True,
        }
    finally:
        cleanup(args.database.resolve(), revocation_task_id, None, [])
        cleanup(args.database.resolve(), task_id, client_id, command_ids)
        assert_cleanup(args.database.resolve(), revocation_task_id, None, [])
        assert_cleanup(args.database.resolve(), task_id, client_id, command_ids)
    require(result is not None, "Agent probe completed without result")
    result["cleanupVerified"] = True
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
