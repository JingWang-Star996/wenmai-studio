#!/usr/bin/env python3
"""Verify Agent Package context isolation across two ArticleProject branches on real local D1."""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import sqlite3
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path
from typing import Any


class ProbeFailure(RuntimeError):
    pass


def sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def request_json(base_url: str, method: str, path: str, body: dict[str, Any] | None = None, *,
                 write: bool = False, token: str | None = None) -> tuple[int, dict[str, Any]]:
    raw = None if body is None else json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    headers = {"Accept": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    else:
        headers.update({"Origin": base_url, "Referer": f"{base_url}/", "Sec-Fetch-Site": "same-origin"})
    if raw is not None:
        headers["Content-Type"] = "application/json"
    if write:
        headers["X-Wenmai-Write"] = "1"
    request = urllib.request.Request(f"{base_url}{path}", data=raw, headers=headers, method=method)
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with opener.open(request, timeout=30) as response:
            return response.status, json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        text = error.read().decode("utf-8", errors="replace")
        try:
            return error.code, json.loads(text)
        except json.JSONDecodeError:
            return error.code, {"raw": text}


def expect_ok(result: tuple[int, dict[str, Any]], label: str, statuses: set[int] | None = None) -> dict[str, Any]:
    status, payload = result
    if status not in (statuses or {200, 201}) or payload.get("ok") is not True:
        raise ProbeFailure(f"{label}: HTTP {status} {json.dumps(payload, ensure_ascii=False)}")
    return payload["data"]


def post(base_url: str, endpoint: str, action: str, command_id: str, payload: dict[str, Any],
         token: str | None = None) -> tuple[int, dict[str, Any]]:
    return request_json(base_url, "POST", endpoint, {
        "action": action, "commandId": command_id, "payload": payload,
    }, write=token is None, token=token)


def find_database(root: Path) -> Path:
    folder = root / ".wrangler" / "state" / "v3" / "d1" / "miniflare-D1DatabaseObject"
    for candidate in sorted(folder.glob("*.sqlite"), key=lambda item: item.stat().st_mtime, reverse=True):
        if candidate.name == "metadata.sqlite":
            continue
        try:
            with sqlite3.connect(candidate) as connection:
                required = {"article_project_packages", "package_branch_states", "agent_tasks"}
                existing = {str(row[0]) for row in connection.execute(
                    "SELECT name FROM sqlite_master WHERE type='table'"
                )}
                if required.issubset(existing):
                    return candidate
        except sqlite3.Error:
            pass
    raise ProbeFailure("cannot locate active 0010 local D1")


def pick_article(root: Path, database: Path) -> str:
    corpus = json.loads((root / "data" / "corpus.generated.json").read_text(encoding="utf-8"))
    with sqlite3.connect(database) as connection:
        for article in corpus.get("articles", []):
            article_id = str(article.get("id", ""))
            if article_id and not connection.execute(
                "SELECT 1 FROM article_project_packages WHERE article_id = ?", (article_id,)
            ).fetchone():
                return article_id
    raise ProbeFailure("no unbound corpus article is available")


def insert_branch(database: Path, article_id: str, branch_id: str, revision_id: str, title: str, body: str) -> None:
    now = "2026-08-17T00:00:00.000Z"
    body_sha = sha256_text(body)
    with sqlite3.connect(database, timeout=20) as connection:
        connection.execute("PRAGMA busy_timeout=20000")
        connection.execute(
            "INSERT INTO article_revisions (id, article_id, branch_id, sequence, parent_revision_id, "
            "merge_parent_revision_id, source_version_id, title, document_title, annotation, body_text, "
            "body_sha256, author_kind, created_at) VALUES (?, ?, ?, 1, NULL, NULL, NULL, ?, ?, '', ?, ?, 'user', ?)",
            (revision_id, article_id, branch_id, title, title, body, body_sha, now),
        )
        connection.execute(
            "INSERT INTO article_branches (id, article_id, name, slug, color, status, head_revision_id, "
            "base_revision_id, base_source_version_id, created_at, updated_at) VALUES (?, ?, ?, ?, 'cyan', "
            "'active', ?, ?, NULL, ?, ?)",
            (branch_id, article_id, title, branch_id, revision_id, revision_id, now, now),
        )
        connection.execute(
            "INSERT INTO branch_working_copies (branch_id, article_id, base_revision_id, title, annotation, "
            "body_text, body_sha256, dirty, lock_version, updated_at) VALUES (?, ?, ?, ?, '', ?, ?, 0, 1, ?)",
            (branch_id, article_id, revision_id, title, body, body_sha, now),
        )
        connection.commit()


def mutate_and_commit(base_url: str, command: Any, package_id: str, branch: dict[str, Any], marker: str) -> dict[str, Any]:
    document = copy.deepcopy(branch["workingCopy"]["document"])
    document["modules"][0]["contentText"] += f"\n\n{marker}"
    saved = expect_ok(post(base_url, "/api/project-package/v1", "save_working_package", command(f"save-{marker}"), {
        "packageId": package_id,
        "branchId": branch["branchState"]["branchId"],
        "expectedBranchLockVersion": branch["branchState"]["lockVersion"],
        "expectedWorkingLockVersion": branch["workingCopy"]["lockVersion"],
        "expectedBaseCompositionId": branch["workingCopy"]["baseCompositionId"],
        "expectedBaseRevisionId": branch["workingCopy"]["baseRevisionId"],
        "document": document,
    }), f"save {marker}")
    return expect_ok(post(base_url, "/api/project-package/v1", "commit", command(f"commit-{marker}"), {
        "packageId": package_id,
        "branchId": saved["branchState"]["branchId"],
        "expectedBranchLockVersion": saved["branchState"]["lockVersion"],
        "expectedWorkingLockVersion": saved["workingCopy"]["lockVersion"],
        "expectedBaseCompositionId": saved["workingCopy"]["baseCompositionId"],
        "expectedBaseRevisionId": saved["workingCopy"]["baseRevisionId"],
        "expectedDocumentSha256": saved["workingCopy"]["documentSha256"],
        "compositionTitle": f"Agent isolation {marker}",
    }), f"commit {marker}", {201})


def cleanup(database: Path, article_id: str, branch_ids: list[str], package_id: str | None,
            task_ids: list[str], client_id: str | None, prefix: str, prior_events: set[str]) -> None:
    for attempt in range(8):
        try:
            with sqlite3.connect(database, timeout=20) as connection:
                connection.execute("PRAGMA busy_timeout=20000")
                connection.execute("BEGIN IMMEDIATE")
                for task_id in task_ids:
                    for table in ["agent_progress_events", "agent_task_artifacts", "agent_approval_requests",
                                  "graph_proposals", "agent_task_leases", "agent_task_attempts", "agent_context_snapshots"]:
                        connection.execute(f"DELETE FROM {table} WHERE task_id = ?", (task_id,))
                    connection.execute("DELETE FROM agent_tasks WHERE id = ?", (task_id,))
                if client_id:
                    connection.execute("DELETE FROM agent_clients WHERE id = ?", (client_id,))
                if package_id:
                    for table in ["package_diagnostic_issues", "package_diagnosis_runs", "package_patch_proposals",
                                  "package_slices", "package_export_runs", "package_import_runs",
                                  "package_module_revision_refs", "package_composition_edges", "package_composition_nodes",
                                  "package_composition_materializations", "package_branch_composition_commits",
                                  "package_branch_working_copies", "package_branch_states", "package_branch_migration_audits",
                                  "package_assets", "package_source_refs", "package_module_revisions", "package_modules",
                                  "package_compositions", "package_working_copies"]:
                        connection.execute(f"DELETE FROM {table} WHERE package_id = ?", (package_id,))
                    connection.execute("DELETE FROM article_project_packages WHERE id = ?", (package_id,))
                for branch_id in branch_ids:
                    connection.execute("DELETE FROM branch_working_copies WHERE branch_id = ?", (branch_id,))
                    connection.execute("DELETE FROM article_revisions WHERE branch_id = ?", (branch_id,))
                    connection.execute("DELETE FROM article_branches WHERE id = ?", (branch_id,))
                if prior_events:
                    marks = ",".join("?" for _ in prior_events)
                    connection.execute(f"DELETE FROM workspace_events WHERE article_id = ? AND id NOT IN ({marks})",
                                       (article_id, *sorted(prior_events)))
                else:
                    connection.execute("DELETE FROM workspace_events WHERE article_id = ?", (article_id,))
                connection.execute("DELETE FROM command_receipts WHERE id LIKE ?", (f"{prefix}%",))
                connection.commit()
            return
        except sqlite3.OperationalError:
            if attempt == 7:
                raise
            time.sleep(0.3 * (attempt + 1))


def run_probe(base_url: str, root: Path, keep: bool) -> dict[str, Any]:
    run_id = uuid.uuid4().hex[:12]
    prefix = f"agent-branch-probe:{run_id}:"
    branch_a = f"agent-branch-probe-a-{run_id}"
    branch_b = f"agent-branch-probe-b-{run_id}"
    revision_a = f"agent-branch-probe-rev-a-{run_id}"
    revision_b = f"agent-branch-probe-rev-b-{run_id}"
    package_id: str | None = None
    client_id: str | None = None
    task_ids: list[str] = []
    database = find_database(root)
    article_id = pick_article(root, database)
    with sqlite3.connect(database) as connection:
        prior_events = {str(row[0]) for row in connection.execute(
            "SELECT id FROM workspace_events WHERE article_id = ?", (article_id,)
        )}

    def command(name: str) -> str:
        return f"{prefix}{name}"

    try:
        body = f"# Agent branch isolation {run_id}\n\nShared initial body."
        insert_branch(database, article_id, branch_a, revision_a, f"probe/A/{run_id}", body)
        insert_branch(database, article_id, branch_b, revision_b, f"probe/B/{run_id}", body)
        created_a = expect_ok(post(base_url, "/api/project-package/v1", "ensure_from_revision", command("ensure-a"), {
            "articleId": article_id, "revisionId": revision_a, "expectedBodySha256": sha256_text(body),
            "branchId": branch_a, "title": f"Agent isolation {run_id}",
        }), "ensure A", {201})
        package_id = created_a["package"]["id"]
        attached_b = expect_ok(post(base_url, "/api/project-package/v1", "attach_branch", command("attach-b"), {
            "packageId": package_id, "branchId": branch_b, "expectedBranchHeadRevisionId": revision_b,
            "expectedBranchHeadBodySha256": sha256_text(body), "expectedBranchWorkingLockVersion": 1,
        }), "attach B", {201})

        issued = expect_ok(post(base_url, "/api/agent/v1", "issue_client", command("issue"), {
            "label": f"agent-branch-probe-{run_id}", "clientKind": "custom",
            "scopes": ["task.read", "task.claim", "task.progress", "context.read", "package.patch.propose"],
            "articleIds": [article_id],
        }), "issue client", {201})
        client_id = issued["client"]["id"]
        token = issued["token"]

        frozen_a = expect_ok(post(base_url, "/api/agent/v1", "create_task", command("task-a-before-b"), {
            "articleId": article_id, "targetBranchId": branch_a, "writeScope": "package-patch",
            "title": "A context must ignore B", "objective": "Verify branch-scoped freshness.",
            "permissionCeiling": {"allow": ["article.read", "task.progress", "package.patch.propose"]},
        }), "create frozen A", {201})
        task_a = frozen_a["task"]["id"]
        task_ids.append(task_a)
        frozen_a_sha = frozen_a["contextSnapshot"]["contextSha256"]
        frozen_a_lock = frozen_a["task"]["baseBranchLockVersion"]

        committed_b = mutate_and_commit(base_url, command, package_id, attached_b, "advance-B")
        claimed_a = expect_ok(post(base_url, "/api/agent/v1", "claim", command("claim-a-after-b"), {
            "taskId": task_a,
        }, token), "claim A after B")
        if claimed_a["context"]["sha256"] != frozen_a_sha or claimed_a["context"]["baseBranchLockVersion"] != frozen_a_lock:
            raise ProbeFailure("B advance changed A frozen context")

        current_a = expect_ok(request_json(
            base_url, "GET", f"/api/project-package/v1?view=package&packageId={package_id}&branchId={branch_a}"
        ), "read A")
        committed_a = mutate_and_commit(base_url, command, package_id, current_a, "advance-A")
        lease = claimed_a["lease"]
        context = claimed_a["context"]
        stale_status, stale_payload = post(base_url, "/api/agent/v1", "propose_package_patch", command("stale-a-patch"), {
            "taskId": task_a, "attemptId": lease["attemptId"], "leaseId": lease["id"],
            "leaseToken": lease["leaseToken"], "contextSha256": context["sha256"],
            "packageId": package_id, "branchId": branch_a,
            "baseRevisionId": context["baseRevisionId"],
            "expectedBranchLockVersion": context["baseBranchLockVersion"],
            "baseCompositionId": context["compositionId"],
            "expectedBaseCompositionSha256": context["compositionSha256"],
            "title": "must be stale", "operations": [{"op": "remove_edge", "edgeKey": "missing"}],
        }, token)
        if stale_status != 409 or stale_payload.get("error", {}).get("code") != "PACKAGE_CONTEXT_STALE":
            raise ProbeFailure(f"A advance did not stale A context: HTTP {stale_status} {stale_payload}")

        fresh_a = expect_ok(post(base_url, "/api/agent/v1", "create_task", command("task-a-fresh"), {
            "articleId": article_id, "targetBranchId": branch_a, "writeScope": "package-patch",
            "title": "fresh A candidate", "objective": "Insert candidate only.",
            "permissionCeiling": {"allow": ["article.read", "task.progress", "package.patch.propose"]},
        }), "create fresh A", {201})
        fresh_task_id = fresh_a["task"]["id"]
        task_ids.append(fresh_task_id)
        fresh_claim = expect_ok(post(base_url, "/api/agent/v1", "claim", command("claim-a-fresh"), {
            "taskId": fresh_task_id,
        }, token), "claim fresh A")
        fresh_lease = fresh_claim["lease"]
        fresh_context = fresh_claim["context"]
        candidate = expect_ok(post(base_url, "/api/agent/v1", "propose_package_patch", command("candidate-a"), {
            "taskId": fresh_task_id, "attemptId": fresh_lease["attemptId"], "leaseId": fresh_lease["id"],
            "leaseToken": fresh_lease["leaseToken"], "contextSha256": fresh_context["sha256"],
            "packageId": package_id, "branchId": branch_a,
            "baseRevisionId": fresh_context["baseRevisionId"],
            "expectedBranchLockVersion": fresh_context["baseBranchLockVersion"],
            "baseCompositionId": fresh_context["compositionId"],
            "expectedBaseCompositionSha256": fresh_context["compositionSha256"],
            "title": "branch-scoped candidate", "summary": "candidate only",
            "operations": [{"op": "add_module", "module": {
                "key": f"candidate-{run_id}", "kind": "paragraph", "title": "Candidate",
                "contentFormat": "markdown", "contentText": "Candidate only.", "metadata": {}, "refs": [],
            }}],
        }, token), "candidate A", {201})
        patch = candidate["patchProposal"]
        if patch["status"] != "candidate" or patch["baseRevisionId"] != fresh_context["baseRevisionId"] \
                or patch["baseBranchLockVersion"] != fresh_context["baseBranchLockVersion"]:
            raise ProbeFailure("candidate patch did not persist branch provenance")
        with sqlite3.connect(database) as connection:
            state_a = connection.execute(
                "SELECT head_revision_id, lock_version FROM package_branch_states WHERE package_id = ? AND branch_id = ?",
                (package_id, branch_a),
            ).fetchone()
            state_b = connection.execute(
                "SELECT head_revision_id, lock_version FROM package_branch_states WHERE package_id = ? AND branch_id = ?",
                (package_id, branch_b),
            ).fetchone()
        if state_a != (committed_a["branchState"]["headRevisionId"], committed_a["branchState"]["lockVersion"]):
            raise ProbeFailure("candidate patch advanced A")
        if state_b != (committed_b["branchState"]["headRevisionId"], committed_b["branchState"]["lockVersion"]):
            raise ProbeFailure("A activity changed B")
        return {
            "ok": True, "articleId": article_id, "packageId": package_id,
            "branchA": branch_a, "branchB": branch_b,
            "bAdvanceDidNotStaleA": True, "aAdvanceStaledA": True,
            "candidateOnly": True, "branchProvenancePersisted": True,
            "contextSha256": fresh_context["sha256"], "candidatePatchId": patch["id"],
            "database": str(database),
        }
    finally:
        if not keep:
            cleanup(database, article_id, [branch_a, branch_b], package_id, task_ids, client_id, prefix, prior_events)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-url", default="http://[::1]:3000")
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--keep", action="store_true")
    args = parser.parse_args()
    print(json.dumps(run_probe(args.base_url.rstrip("/"), args.root.resolve(), args.keep), ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
