#!/usr/bin/env python3
"""Exercise the 0009 Package↔ArticleBranch bridge and Agent candidate-patch boundary against local D1."""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import sqlite3
import time
import urllib.error
import urllib.parse
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
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return response.status, json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        error_text = error.read().decode("utf-8", errors="replace")
        try:
            return error.code, json.loads(error_text)
        except json.JSONDecodeError:
            return error.code, {"raw": error_text}


def expect_agent(result: tuple[int, dict[str, Any]], label: str, statuses: set[int] | None = None) -> dict[str, Any]:
    status, payload = result
    if status not in (statuses or {200, 201}) or payload.get("ok") is not True:
        raise ProbeFailure(f"{label}: HTTP {status} {json.dumps(payload, ensure_ascii=False)}")
    return payload["data"]


def post_project(base_url: str, action: str, command_id: str, payload: dict[str, Any]) -> tuple[int, dict[str, Any]]:
    return request_json(base_url, "POST", "/api/project-package/v1", {
        "action": action, "commandId": command_id, "payload": payload,
    }, write=True)


def post_agent(base_url: str, action: str, command_id: str, payload: dict[str, Any], token: str | None = None) -> tuple[int, dict[str, Any]]:
    return request_json(base_url, "POST", "/api/agent/v1", {
        "action": action, "commandId": command_id, "payload": payload,
    }, write=token is None, token=token)


def find_d1_database(root: Path) -> Path:
    folder = root / ".wrangler" / "state" / "v3" / "d1" / "miniflare-D1DatabaseObject"
    for candidate in sorted(folder.glob("*.sqlite"), key=lambda item: item.stat().st_mtime, reverse=True):
        if candidate.name == "metadata.sqlite":
            continue
        try:
            with sqlite3.connect(candidate) as connection:
                if connection.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='article_project_packages'").fetchone():
                    return candidate
        except sqlite3.Error:
            pass
    raise ProbeFailure("cannot locate active local D1")


def pick_article(root: Path, database: Path) -> str:
    corpus = json.loads((root / "data" / "corpus.generated.json").read_text(encoding="utf-8"))
    with sqlite3.connect(database) as connection:
        for article in corpus.get("articles", []):
            article_id = str(article.get("id", ""))
            if article_id and not connection.execute(
                "SELECT 1 FROM article_project_packages WHERE article_id = ?", (article_id,)
            ).fetchone():
                return article_id
    raise ProbeFailure("no corpus article is available for an isolated Package probe")


def cleanup(database: Path, *, package_id: str | None, branch_id: str, task_id: str | None,
            client_id: str | None, command_prefix: str, article_id: str,
            prior_event_ids: set[str]) -> None:
    for attempt in range(8):
        try:
            with sqlite3.connect(database, timeout=15) as connection:
                connection.execute("PRAGMA busy_timeout=15000")
                connection.execute("BEGIN IMMEDIATE")
                if task_id:
                    connection.execute("DELETE FROM agent_progress_events WHERE task_id = ?", (task_id,))
                    connection.execute("DELETE FROM agent_task_artifacts WHERE task_id = ?", (task_id,))
                    connection.execute("DELETE FROM agent_approval_requests WHERE task_id = ?", (task_id,))
                    connection.execute("DELETE FROM graph_proposals WHERE task_id = ?", (task_id,))
                    connection.execute("DELETE FROM agent_task_leases WHERE task_id = ?", (task_id,))
                    connection.execute("DELETE FROM agent_task_attempts WHERE task_id = ?", (task_id,))
                    connection.execute("DELETE FROM agent_context_snapshots WHERE task_id = ?", (task_id,))
                    connection.execute("DELETE FROM agent_tasks WHERE id = ?", (task_id,))
                if client_id:
                    connection.execute("DELETE FROM agent_clients WHERE id = ?", (client_id,))
                if package_id:
                    for table in [
                        "package_module_revision_refs", "package_composition_edges", "package_composition_nodes",
                        "package_composition_materializations", "package_module_revisions", "package_diagnostic_issues",
                        "package_diagnosis_runs", "package_slices", "package_export_runs", "package_import_runs",
                        "package_patch_proposals", "package_assets", "package_source_refs", "package_modules",
                        "package_compositions", "package_working_copies",
                    ]:
                        connection.execute(f"DELETE FROM {table} WHERE package_id = ?", (package_id,))
                    connection.execute("DELETE FROM article_project_packages WHERE id = ?", (package_id,))
                connection.execute("DELETE FROM branch_working_copies WHERE branch_id = ?", (branch_id,))
                connection.execute("DELETE FROM article_revisions WHERE branch_id = ?", (branch_id,))
                connection.execute("DELETE FROM article_branches WHERE id = ?", (branch_id,))
                if prior_event_ids:
                    placeholders = ",".join("?" for _ in prior_event_ids)
                    connection.execute(
                        f"DELETE FROM workspace_events WHERE article_id = ? AND id NOT IN ({placeholders})",
                        (article_id, *sorted(prior_event_ids)),
                    )
                else:
                    connection.execute("DELETE FROM workspace_events WHERE article_id = ?", (article_id,))
                connection.execute("DELETE FROM command_receipts WHERE id LIKE ?", (f"{command_prefix}%",))
                connection.commit()
            return
        except sqlite3.OperationalError:
            if attempt == 7:
                raise
            time.sleep(0.3 * (attempt + 1))


def run_probe(base_url: str, root: Path, keep: bool) -> dict[str, Any]:
    run_id = uuid.uuid4().hex[:12]
    prefix = f"bridge-probe:{run_id}:"
    branch_id = f"bridge-probe-branch-{run_id}"
    seed_revision_id = f"bridge-probe-revision-{run_id}"
    package_id: str | None = None
    task_id: str | None = None
    client_id: str | None = None
    database: Path | None = None
    article_id = ""
    prior_event_ids: set[str] = set()

    def command(name: str) -> str:
        return f"{prefix}{name}"

    try:
        expect_agent(request_json(base_url, "GET", "/api/project-package/v1?view=health"), "project health", {200})
        expect_agent(request_json(base_url, "GET", "/api/agent/v1?view=health"), "agent health", {200})
        database = find_d1_database(root)
        article_id = pick_article(root, database)
        body = f"# Bridge probe {run_id}\n\nThe Package must follow this ArticleBranch."
        body_sha = sha256_text(body)
        now = "2026-08-17T00:00:00.000Z"
        with sqlite3.connect(database, timeout=15) as connection:
            prior_event_ids = {row[0] for row in connection.execute(
                "SELECT id FROM workspace_events WHERE article_id = ?", (article_id,)
            )}
            connection.execute(
                "INSERT INTO article_revisions (id, article_id, branch_id, sequence, parent_revision_id, "
                "merge_parent_revision_id, source_version_id, title, document_title, annotation, body_text, "
                "body_sha256, author_kind, created_at) VALUES (?, ?, ?, 1, NULL, NULL, NULL, ?, ?, '', ?, ?, 'user', ?)",
                (seed_revision_id, article_id, branch_id, f"Probe {run_id}", f"Probe {run_id}", body, body_sha, now),
            )
            connection.execute(
                "INSERT INTO article_branches (id, article_id, name, slug, color, status, head_revision_id, "
                "base_revision_id, base_source_version_id, created_at, updated_at) "
                "VALUES (?, ?, ?, ?, 'cyan', 'active', ?, ?, NULL, ?, ?)",
                (branch_id, article_id, f"probe/{run_id}", f"probe-{run_id}", seed_revision_id, seed_revision_id, now, now),
            )
            connection.execute(
                "INSERT INTO branch_working_copies (branch_id, article_id, base_revision_id, title, annotation, "
                "body_text, body_sha256, dirty, lock_version, updated_at) VALUES (?, ?, ?, ?, '', ?, ?, 0, 1, ?)",
                (branch_id, article_id, seed_revision_id, f"Probe {run_id}", body, body_sha, now),
            )
            connection.commit()

        created = expect_agent(post_project(base_url, "ensure_from_revision", command("ensure"), {
            "articleId": article_id, "revisionId": seed_revision_id, "expectedBodySha256": body_sha,
            "branchId": branch_id, "title": f"Bridge probe {run_id}",
        }), "ensure_from_revision", {201})
        package_id = created["package"]["id"]
        bridge = created.get("branchBridge") or {}
        if bridge.get("branchId") != branch_id or not bridge.get("headRevisionId") or bridge.get("inSync") is not True:
            raise ProbeFailure(f"Package did not bind the selected ArticleBranch head: {json.dumps(created, ensure_ascii=False)}")
        if created.get("boundary", {}).get("branchCreated") is not False:
            raise ProbeFailure("ensure_from_revision silently created a parallel branch")

        document = copy.deepcopy(created["workingCopy"]["document"])
        document["modules"][0]["contentText"] += "\n\nCommitted through dual CAS."
        saved = expect_agent(post_project(base_url, "save_working_package", command("save"), {
            "packageId": package_id,
            "expectedPackageLockVersion": created["package"]["lockVersion"],
            "expectedWorkingLockVersion": created["workingCopy"]["lockVersion"],
            "expectedBaseCompositionId": created["workingCopy"]["baseCompositionId"],
            "document": document,
        }), "save_working_package")
        committed = expect_agent(post_project(base_url, "commit", command("commit"), {
            "packageId": package_id,
            "expectedPackageLockVersion": saved["package"]["lockVersion"],
            "expectedWorkingLockVersion": saved["workingCopy"]["lockVersion"],
            "expectedBaseCompositionId": saved["workingCopy"]["baseCompositionId"],
            "expectedDocumentSha256": saved["workingCopy"]["documentSha256"],
            "compositionTitle": "Bridge dual-CAS commit",
        }), "commit", {201})
        committed_bridge = committed.get("branchBridge") or {}
        committed_revision_id = committed_bridge.get("headRevisionId")
        if not committed_revision_id or committed_revision_id == seed_revision_id or committed_bridge.get("inSync") is not True:
            raise ProbeFailure("commit did not atomically advance the bridge")

        workspace_status, workspace_payload = request_json(base_url, "POST", "/api/workspace", {
            "action": "save_working_copy", "branchId": branch_id,
            "baseRevisionId": committed_revision_id,
            "lockVersion": committed_bridge["workingCopyLockVersion"],
            "title": "must be rejected", "annotation": "", "bodyText": "legacy write",
        })
        if workspace_status != 409 or "ArticleProject Package" not in str(workspace_payload.get("error", "")):
            raise ProbeFailure(f"legacy Workspace write was not blocked: HTTP {workspace_status} {workspace_payload}")

        issued = expect_agent(post_agent(base_url, "issue_client", command("issue-client"), {
            "label": f"bridge-probe-{run_id}", "clientKind": "custom",
            "scopes": ["task.read", "task.claim", "task.progress", "context.read", "package.patch.propose"],
            "articleIds": [article_id],
        }), "issue_client", {201})
        client_id = issued["client"]["id"]
        token = issued["token"]
        task = expect_agent(post_agent(base_url, "create_task", command("create-task"), {
            "articleId": article_id, "targetBranchId": branch_id, "writeScope": "package-patch",
            "title": f"Package patch probe {run_id}", "objective": "Submit one candidate Package Patch without advancing any head.",
            "acceptance": ["candidate patch exists", "Package main and ArticleBranch head remain unchanged"],
            "permissionCeiling": {"allow": ["article.read", "task.progress", "package.patch.propose"]},
        }), "create_task", {201})
        task_id = task["task"]["id"]
        binding = task.get("packageBinding") or {}
        if binding.get("branchId") != branch_id or binding.get("candidateOnly") is not True:
            raise ProbeFailure("Agent task was not bound to the frozen Package branch")
        claimed = expect_agent(post_agent(base_url, "claim", command("claim"), {"taskId": task_id}, token), "claim")
        lease = claimed["lease"]
        context = claimed["context"]
        if context.get("moduleGraphSha256") is None or context.get("diagnosisSummarySha256") is None:
            raise ProbeFailure("claim omitted frozen Package graph/diagnosis digests")

        proposed = expect_agent(post_agent(base_url, "propose_package_patch", command("propose-package-patch"), {
            "taskId": task_id, "attemptId": lease["attemptId"], "leaseId": lease["id"],
            "leaseToken": lease["leaseToken"], "contextSha256": context["sha256"],
            "packageId": package_id, "branchId": branch_id,
            "expectedPackageLockVersion": committed["package"]["lockVersion"],
            "baseCompositionId": committed["composition"]["id"],
            "expectedBaseCompositionSha256": committed["composition"]["compositionSha256"],
            "expectedBranchHeadRevisionId": committed_revision_id,
            "title": "Candidate-only module addition",
            "summary": "Agent candidate; human must review and apply separately.",
            "operations": [{"op": "add_module", "module": {
                "key": f"agent-candidate-{run_id}", "kind": "paragraph", "title": "Agent candidate",
                "contentFormat": "markdown", "contentText": "Candidate only.", "metadata": {}, "refs": [],
            }}],
            "evidence": [f"context:{context['sha256']}"]
        }, token), "propose_package_patch", {201})
        boundary = proposed.get("boundary", {})
        if not boundary.get("candidateOnly") or any(boundary.get(key) for key in [
            "patchApplied", "compositionCreated", "packageMainAdvanced", "articleBranchAdvanced", "revisionCreated"
        ]):
            raise ProbeFailure("Agent candidate response overstated a durable head advance")

        with sqlite3.connect(database) as connection:
            invariant = connection.execute(
                "SELECT package.main_composition_id, package.main_composition_sha256, branch.head_revision_id, "
                "package_copy.base_composition_id, package_copy.base_revision_id, branch_copy.base_revision_id, "
                "bridge.article_revision_id "
                "FROM article_project_packages package "
                "JOIN article_branches branch ON branch.id = package.primary_branch_id "
                "JOIN package_working_copies package_copy ON package_copy.package_id = package.id "
                "JOIN branch_working_copies branch_copy ON branch_copy.branch_id = branch.id "
                "JOIN package_composition_materializations bridge ON bridge.package_id = package.id "
                "AND bridge.composition_id = package.main_composition_id AND bridge.article_revision_id = branch.head_revision_id "
                "WHERE package.id = ?", (package_id,)
            ).fetchone()
            patch_row = connection.execute(
                "SELECT status, task_id, attempt_id, context_sha256, branch_id, base_revision_id, "
                "base_package_lock_version, applied_composition_id FROM package_patch_proposals WHERE id = ?",
                (proposed["patchProposal"]["id"],),
            ).fetchone()
        if (not invariant or invariant[0] != committed["composition"]["id"]
                or invariant[3] != committed["composition"]["id"]
                or any(invariant[index] != committed_revision_id for index in [2, 4, 5, 6])):
            raise ProbeFailure("Package/Branch/materialization invariant diverged after Agent proposal")
        if not patch_row or patch_row[0] != "candidate" or patch_row[1] != task_id or patch_row[7] is not None:
            raise ProbeFailure("Agent Package Patch provenance or candidate state is incomplete")

        return {
            "ok": True, "runId": run_id, "articleId": article_id, "packageId": package_id,
            "branchId": branch_id, "committedRevisionId": committed_revision_id,
            "agentTaskId": task_id, "candidatePatchId": proposed["patchProposal"]["id"],
            "singlePrimaryBranch": True, "parallelBranchCreated": False,
            "workspaceLegacyWriteRejected": True, "agentCandidateOnly": True,
            "moduleGraphFrozen": True, "diagnosisDigestFrozen": True, "database": str(database),
        }
    finally:
        if not keep and database and article_id:
            cleanup(database, package_id=package_id, branch_id=branch_id, task_id=task_id, client_id=client_id,
                    command_prefix=prefix, article_id=article_id, prior_event_ids=prior_event_ids)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-url", default="http://localhost:3000")
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--keep", action="store_true")
    args = parser.parse_args()
    print(json.dumps(run_probe(args.base_url.rstrip("/"), args.root.resolve(), args.keep), ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
