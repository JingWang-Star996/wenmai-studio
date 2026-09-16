#!/usr/bin/env python3
"""Exercise authenticated merge receipts, CAS guards, competition, and double-parent closure."""

from __future__ import annotations

import argparse
import base64
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
import os
import sqlite3
import threading
import uuid
from pathlib import Path
from typing import Any
from urllib.error import HTTPError
from urllib.request import ProxyHandler, Request, build_opener


def digest(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def require(condition: bool, message: str) -> None:
    if not condition:
        raise RuntimeError(message)


def response_header(headers: dict[str, str], name: str) -> str:
    expected = name.lower()
    return next((value for key, value in headers.items() if key.lower() == expected), "")


class ManagementClient:
    def __init__(self, base_url: str) -> None:
        self.base_url = base_url.rstrip("/")
        self.browser_binding = base64.urlsafe_b64encode(os.urandom(32)).decode("ascii").rstrip("=")
        self.browser_binding_sha256 = digest(self.browser_binding)
        self.cookie = ""
        self.csrf_token = ""

    def _request(
        self,
        method: str,
        path: str,
        payload: dict[str, Any] | None = None,
        *,
        authenticated: bool,
        mutation: bool,
        include_origin: bool = False,
    ) -> tuple[int, dict[str, Any], dict[str, str]]:
        headers = {"accept": "application/json"}
        body = None
        if payload is not None:
            headers["content-type"] = "application/json"
            body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        if authenticated:
            headers["cookie"] = self.cookie
            headers["x-wenmai-browser-binding"] = self.browser_binding
        if include_origin or mutation:
            headers["origin"] = self.base_url
        if mutation:
            headers["x-wenmai-csrf"] = self.csrf_token
            headers["x-wenmai-write"] = "1"
        request = Request(f"{self.base_url}{path}", data=body, headers=headers, method=method)
        opener = build_opener(ProxyHandler({}))
        try:
            with opener.open(request, timeout=30) as response:
                raw = response.read(4_000_000).decode("utf-8")
                return response.status, json.loads(raw), dict(response.headers.items())
        except HTTPError as error:
            raw = error.read(4_000_000).decode("utf-8")
            return error.code, json.loads(raw), dict(error.headers.items())

    def bootstrap(self, pairing_code: str) -> None:
        status, envelope, headers = self._request(
            "POST",
            "/api/auth",
            {
                "action": "bootstrap",
                "pairingCode": pairing_code,
                "browserBindingSha256": self.browser_binding_sha256,
            },
            authenticated=False,
            mutation=False,
            include_origin=True,
        )
        require(status == 201 and envelope.get("ok") is True, f"management pairing failed: HTTP {status} {envelope}")
        data = envelope.get("data") or {}
        self.csrf_token = str(data.get("csrfToken") or "")
        self.cookie = response_header(headers, "set-cookie").split(";", 1)[0]
        require(bool(self.csrf_token and self.cookie), "management pairing did not return cookie + CSRF")

    def post_result(self, payload: dict[str, Any]) -> tuple[int, dict[str, Any]]:
        status, result, _ = self._request(
            "POST",
            "/api/workspace",
            payload,
            authenticated=True,
            mutation=True,
        )
        return status, result

    def post(self, payload: dict[str, Any]) -> dict[str, Any]:
        status, result = self.post_result(payload)
        require(status < 400, f"workspace mutation failed: HTTP {status} {result}")
        return result

    def workspace(self, article_id: str) -> dict[str, Any]:
        status, result, _ = self._request(
            "GET",
            f"/api/workspace?articleId={article_id}",
            authenticated=True,
            mutation=False,
        )
        require(status == 200, f"workspace read failed: HTTP {status} {result}")
        return result

    def logout(self) -> None:
        if not self.cookie or not self.csrf_token:
            return
        status, envelope, _ = self._request(
            "POST",
            "/api/auth",
            {"action": "logout"},
            authenticated=True,
            mutation=True,
        )
        require(status == 200 and envelope.get("ok") is True, f"management logout failed: HTTP {status} {envelope}")
        self.cookie = ""
        self.csrf_token = ""


def insert_fixture(database: Path, ids: dict[str, str]) -> None:
    base_body = "# 共同基线\n\n这是共同祖先。"
    source_body = base_body + "\n\n## 来源分支\n\n来源增加了事实段。"
    target_body = base_body + "\n\n## 目标分支\n\n目标改善了叙事。"
    with sqlite3.connect(database, timeout=20) as connection:
        connection.execute("PRAGMA busy_timeout = 20000")
        connection.execute("BEGIN IMMEDIATE")
        connection.execute(
            "INSERT INTO article_branches (id, article_id, name, slug, head_revision_id, base_revision_id) VALUES (?, ?, '目标', ?, ?, ?)",
            (ids["target_branch"], ids["article"], f"target-{ids['suffix']}", ids["target_revision"], ids["base_revision"]),
        )
        connection.execute(
            "INSERT INTO article_branches (id, article_id, name, slug, head_revision_id, base_revision_id) VALUES (?, ?, '来源', ?, ?, ?)",
            (ids["source_branch"], ids["article"], f"source-{ids['suffix']}", ids["source_revision"], ids["base_revision"]),
        )
        connection.execute(
            "INSERT INTO article_revisions (id, article_id, branch_id, sequence, title, document_title, body_text, body_sha256) VALUES (?, ?, ?, 1, '共同基线', '合并 QA', ?, ?)",
            (ids["base_revision"], ids["article"], ids["target_branch"], base_body, digest(base_body)),
        )
        connection.execute(
            "INSERT INTO article_revisions (id, article_id, branch_id, sequence, parent_revision_id, title, document_title, body_text, body_sha256) VALUES (?, ?, ?, 2, ?, '目标修订', '合并 QA', ?, ?)",
            (ids["target_revision"], ids["article"], ids["target_branch"], ids["base_revision"], target_body, digest(target_body)),
        )
        connection.execute(
            "INSERT INTO article_revisions (id, article_id, branch_id, sequence, parent_revision_id, title, document_title, body_text, body_sha256) VALUES (?, ?, ?, 1, ?, '来源修订', '合并 QA', ?, ?)",
            (ids["source_revision"], ids["article"], ids["source_branch"], ids["base_revision"], source_body, digest(source_body)),
        )
        connection.execute(
            "INSERT INTO branch_working_copies (branch_id, article_id, base_revision_id, title, body_text, body_sha256, dirty, lock_version) VALUES (?, ?, ?, '合并 QA', ?, ?, 0, 1)",
            (ids["target_branch"], ids["article"], ids["target_revision"], target_body, digest(target_body)),
        )
        connection.execute(
            "INSERT INTO branch_working_copies (branch_id, article_id, base_revision_id, title, body_text, body_sha256, dirty, lock_version) VALUES (?, ?, ?, '合并 QA', ?, ?, 0, 1)",
            (ids["source_branch"], ids["article"], ids["source_revision"], source_body, digest(source_body)),
        )
        connection.commit()


def article_counts(database: Path, article_id: str, command_prefix: str) -> tuple[int, int, int, int]:
    with sqlite3.connect(database, timeout=20) as connection:
        return (
            int(connection.execute("SELECT COUNT(*) FROM merge_proposals WHERE article_id = ?", (article_id,)).fetchone()[0]),
            int(connection.execute("SELECT COUNT(*) FROM work_items WHERE article_id = ? AND kind = 'merge'", (article_id,)).fetchone()[0]),
            int(connection.execute("SELECT COUNT(*) FROM workspace_events WHERE article_id = ?", (article_id,)).fetchone()[0]),
            int(connection.execute("SELECT COUNT(*) FROM command_receipts WHERE id LIKE ?", (f"{command_prefix}%",)).fetchone()[0]),
        )


def management_actor(database: Path, browser_binding_sha256: str) -> str:
    with sqlite3.connect(database, timeout=20) as connection:
        row = connection.execute(
            "SELECT id FROM management_sessions WHERE browser_binding_sha256 = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1",
            (browser_binding_sha256,),
        ).fetchone()
    require(row is not None, "paired management session was not persisted")
    return f"management-session:{row[0]}"


def insert_pending_prepare_receipt(
    database: Path,
    command_id: str,
    actor_id: str,
    receipt_payload: dict[str, Any],
) -> None:
    request_sha256 = digest(canonical_json({
        "action": "prepare_merge",
        "actorId": actor_id,
        "payload": receipt_payload,
    }))
    with sqlite3.connect(database, timeout=20) as connection:
        connection.execute(
            """INSERT INTO command_receipts
               (id, command_type, actor_id, request_sha256, response_json, status_code)
               VALUES (?, 'workspace.prepare_merge', ?, ?, '{}', 0)""",
            (command_id, actor_id, request_sha256),
        )
        connection.commit()


def cleanup(database: Path, ids: dict[str, str], command_prefix: str) -> None:
    with sqlite3.connect(database, timeout=20) as connection:
        connection.execute("PRAGMA busy_timeout = 20000")
        connection.execute("BEGIN IMMEDIATE")
        connection.execute("DELETE FROM workspace_events WHERE article_id = ?", (ids["article"],))
        connection.execute("DELETE FROM command_receipts WHERE id LIKE ?", (f"{command_prefix}%",))
        connection.execute("DELETE FROM merge_proposals WHERE article_id = ?", (ids["article"],))
        connection.execute("DELETE FROM work_items WHERE article_id = ?", (ids["article"],))
        connection.execute("DELETE FROM branch_working_copies WHERE article_id = ?", (ids["article"],))
        connection.execute("DELETE FROM article_revisions WHERE article_id = ?", (ids["article"],))
        connection.execute("DELETE FROM article_branches WHERE article_id = ?", (ids["article"],))
        connection.commit()


def parallel_posts(
    client: ManagementClient,
    requests: list[dict[str, Any]],
) -> list[tuple[int, dict[str, Any]]]:
    barrier = threading.Barrier(len(requests))

    def send(payload: dict[str, Any]) -> tuple[int, dict[str, Any]]:
        barrier.wait(timeout=10)
        return client.post_result(payload)

    with ThreadPoolExecutor(max_workers=len(requests)) as pool:
        return list(pool.map(send, requests))


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-url", default="http://[::1]:3000")
    parser.add_argument("--database", type=Path, required=True)
    parser.add_argument("--pairing-code", required=True, help="fresh one-time code printed by start-wenmai.cmd")
    args = parser.parse_args()
    database = args.database.resolve()
    client = ManagementClient(args.base_url)
    client.bootstrap(args.pairing_code)
    # Authenticated read initializes the workspace runtime schema and active-heads unique index.
    client.workspace("__merge_schema_probe__")

    suffix = uuid.uuid4().hex
    ids = {
        "suffix": suffix,
        "article": f"__merge_qa__{suffix}",
        "target_branch": f"qa-target-{suffix}",
        "source_branch": f"qa-source-{suffix}",
        "base_revision": f"qa-base-{suffix}",
        "target_revision": f"qa-target-rev-{suffix}",
        "source_revision": f"qa-source-rev-{suffix}",
    }
    command_prefix = f"workspace-merge-qa:{suffix}:"
    merged_body = "# 合并结果\n\n保留目标叙事。\n\n## 共同事实\n\n也纳入来源事实。"
    try:
        insert_fixture(database, ids)
        prepare_payload = {
            "articleId": ids["article"],
            "sourceBranchId": ids["source_branch"],
            "targetBranchId": ids["target_branch"],
            "expectedSourceHeadRevisionId": ids["source_revision"],
            "expectedTargetHeadRevisionId": ids["target_revision"],
            "expectedSourceCopyLockVersion": 1,
            "expectedTargetCopyLockVersion": 1,
        }

        before_stale = article_counts(database, ids["article"], command_prefix)
        stale_status, stale_result = client.post_result({
            "action": "prepare_merge",
            "commandId": f"{command_prefix}prepare-stale",
            **prepare_payload,
            "expectedSourceCopyLockVersion": 2,
        })
        after_stale = article_counts(database, ids["article"], command_prefix)
        require(stale_status == 409, f"stale prepare was not rejected: {stale_status} {stale_result}")
        require(before_stale == after_stale, f"stale prepare left objects: {before_stale} -> {after_stale}")

        prepare_requests = [
            {"action": "prepare_merge", "commandId": f"{command_prefix}prepare-{index}", **prepare_payload}
            for index in range(6)
        ]
        prepare_results = parallel_posts(client, prepare_requests)
        require(all(status in (200, 201) for status, _ in prepare_results), f"prepare competition failed: {prepare_results}")
        proposal_ids = {str(result.get("proposal", {}).get("id")) for _, result in prepare_results}
        require(len(proposal_ids) == 1 and "" not in proposal_ids, f"prepare competition returned different winners: {proposal_ids}")
        proposal = prepare_results[0][1]["proposal"]
        require(
            proposal["baseRevisionId"] == ids["base_revision"] and proposal["unresolvedCount"] == 1,
            "prepare_merge did not freeze the expected common ancestor",
        )
        replayed_prepare = client.post(prepare_requests[0])
        require(
            replayed_prepare["proposal"]["id"] == proposal["id"] and replayed_prepare.get("replayed") is True,
            "prepare command did not replay idempotently",
        )
        reused_status, reused_result = client.post_result({
            **prepare_requests[0],
            "expectedTargetCopyLockVersion": 2,
        })
        require(
            reused_status == 409 and "COMMAND_ID_REUSED" in str(reused_result.get("error", "")),
            f"prepare command accepted a different binding: {reused_status} {reused_result}",
        )
        with sqlite3.connect(database, timeout=20) as connection:
            proposal_count = int(connection.execute(
                "SELECT COUNT(*) FROM merge_proposals WHERE article_id = ?", (ids["article"],),
            ).fetchone()[0])
            work_count = int(connection.execute(
                "SELECT COUNT(*) FROM work_items WHERE article_id = ? AND kind = 'merge'", (ids["article"],),
            ).fetchone()[0])
            orphan_count = int(connection.execute(
                """SELECT COUNT(*) FROM work_items work
                   LEFT JOIN merge_proposals proposal ON proposal.work_item_id = work.id
                   WHERE work.article_id = ? AND work.kind = 'merge' AND proposal.id IS NULL""",
                (ids["article"],),
            ).fetchone()[0])
            prepared_event_count = int(connection.execute(
                "SELECT COUNT(*) FROM workspace_events WHERE article_id = ? AND event_type = 'merge.prepared'",
                (ids["article"],),
            ).fetchone()[0])
        require(
            (proposal_count, work_count, orphan_count, prepared_event_count) == (1, 1, 0, 1),
            "prepare competition created a duplicate proposal, orphan work item, or duplicate event",
        )

        pending_command_id = f"{command_prefix}prepare-pending"
        actor_id = management_actor(database, client.browser_binding_sha256)
        insert_pending_prepare_receipt(database, pending_command_id, actor_id, prepare_payload)
        pending_status, pending_result = client.post_result({
            "action": "prepare_merge",
            "commandId": pending_command_id,
            **prepare_payload,
        })
        require(
            pending_status == 409 and "COMMAND_IN_PROGRESS" in str(pending_result.get("error", "")),
            f"pending receipt was not fail-closed: {pending_status} {pending_result}",
        )

        save_payload = {
            "proposalId": proposal["id"],
            "expectedLockVersion": proposal["lockVersion"],
            "expectedPreviewSha256": proposal["previewSha256"],
            "expectedSourceHeadRevisionId": proposal["sourceHeadRevisionId"],
            "expectedTargetHeadRevisionId": proposal["targetHeadRevisionId"],
            "expectedSourceCopyLockVersion": 1,
            "expectedTargetCopyLockVersion": 1,
            "resolvedDocumentTitle": "合并 QA",
            "resolvedBodyText": merged_body,
            "resolutionNote": "人工纳入来源事实并保留目标叙事",
            "confirmResolved": True,
        }
        save_requests = [
            {"action": "save_merge_resolution", "commandId": f"{command_prefix}save-{index}", **save_payload}
            for index in range(5)
        ]
        save_results = parallel_posts(client, save_requests)
        successful_saves = [
            (request, result)
            for request, (status, result) in zip(save_requests, save_results, strict=True)
            if status == 200
        ]
        require(len(successful_saves) == 1, f"resolution CAS had {len(successful_saves)} winners: {save_results}")
        winner_request, winner_result = successful_saves[0]
        saved = winner_result["proposal"]
        require(saved["status"] == "ready" and saved["resolvedBodySha256"] == digest(merged_body), "resolution winner is not ready")
        replayed_save = client.post(winner_request)
        require(
            replayed_save["proposal"]["lockVersion"] == saved["lockVersion"] and replayed_save.get("replayed") is True,
            "save resolution command did not replay idempotently",
        )
        save_reused_status, save_reused_result = client.post_result({
            **winner_request,
            "resolutionNote": "不同的解决说明",
        })
        require(
            save_reused_status == 409 and "COMMAND_ID_REUSED" in str(save_reused_result.get("error", "")),
            f"save command accepted a different binding: {save_reused_status} {save_reused_result}",
        )
        expected_resolution_event_id = f"event-merge-resolution-{proposal['id']}-{saved['lockVersion']}"
        with sqlite3.connect(database, timeout=20) as connection:
            saved_row = connection.execute(
                "SELECT status, lock_version, resolved_body_sha256 FROM merge_proposals WHERE id = ?",
                (proposal["id"],),
            ).fetchone()
            resolution_events = connection.execute(
                """SELECT id FROM workspace_events
                   WHERE article_id = ? AND event_type = 'merge.resolution_saved'""",
                (ids["article"],),
            ).fetchall()
            completed_save_receipts = int(connection.execute(
                """SELECT COUNT(*) FROM command_receipts
                   WHERE id LIKE ? AND command_type = 'workspace.save_merge_resolution' AND status_code = 200""",
                (f"{command_prefix}save-%",),
            ).fetchone()[0])
        require(
            saved_row == ("ready", 2, digest(merged_body))
            and resolution_events == [(expected_resolution_event_id,)]
            and completed_save_receipts == 1,
            "resolution concurrency advanced more than once or duplicated its audit event",
        )

        before_stale_save = article_counts(database, ids["article"], command_prefix)
        stale_save_status, stale_save_result = client.post_result({
            "action": "save_merge_resolution",
            "commandId": f"{command_prefix}save-stale",
            **save_payload,
        })
        after_stale_save = article_counts(database, ids["article"], command_prefix)
        require(stale_save_status == 409, f"stale save was not rejected: {stale_save_status} {stale_save_result}")
        require(before_stale_save == after_stale_save, "stale save left a receipt, event, proposal, or work item")

        workspace = client.workspace(ids["article"])
        target_copy = next(copy for copy in workspace["workingCopies"] if copy["branchId"] == ids["target_branch"])
        merge_request = {
            "action": "merge_revision",
            "commandId": f"{command_prefix}merge",
            "proposalId": proposal["id"],
            "expectedProposalLockVersion": saved["lockVersion"],
            "expectedTargetCopyLockVersion": target_copy["lockVersion"],
            "expectedResolutionSha256": saved["resolvedBodySha256"],
            "revisionTitle": "QA 双父合并",
            "annotation": "人工纳入来源事实并保留目标叙事",
        }
        merged = client.post(merge_request)
        replayed_merge = client.post(merge_request)
        require(
            merged["revisionId"] == replayed_merge["revisionId"] and replayed_merge.get("replayed") is True,
            "merge_revision regressed its idempotent replay",
        )
        with sqlite3.connect(database, timeout=20) as connection:
            revision = connection.execute(
                "SELECT parent_revision_id, merge_parent_revision_id, body_sha256 FROM article_revisions WHERE id = ?",
                (merged["revisionId"],),
            ).fetchone()
            heads = dict(connection.execute(
                "SELECT id, head_revision_id FROM article_branches WHERE article_id = ?",
                (ids["article"],),
            ).fetchall())
            proposal_row = connection.execute(
                "SELECT status, merge_revision_id FROM merge_proposals WHERE id = ?",
                (proposal["id"],),
            ).fetchone()
            merge_event_count = int(connection.execute(
                "SELECT COUNT(*) FROM workspace_events WHERE article_id = ? AND event_type = 'revision.merged'",
                (ids["article"],),
            ).fetchone()[0])
        expected_revision = (ids["target_revision"], ids["source_revision"], digest(merged_body))
        require(revision == expected_revision, f"double-parent revision mismatch: {revision}")
        require(
            heads[ids["source_branch"]] == ids["source_revision"]
            and heads[ids["target_branch"]] == merged["revisionId"],
            "merge moved the wrong branch head",
        )
        require(
            proposal_row == ("merged", merged["revisionId"]) and merge_event_count == 1,
            "merge proposal/event closure mismatch",
        )
        print(json.dumps({
            "ok": True,
            "proposalId": proposal["id"],
            "revisionId": merged["revisionId"],
            "parentRevisionId": revision[0],
            "mergeParentRevisionId": revision[1],
            "prepareCompetition": len(prepare_requests),
            "prepareSingleWinner": True,
            "resolutionCasWinnerCount": len(successful_saves),
            "deterministicResolutionEventId": expected_resolution_event_id,
            "staleCreatesZeroObjects": True,
            "pendingFailClosed": True,
            "idempotentReplay": True,
            "eventCount": merge_event_count,
        }, ensure_ascii=False))
        return 0
    finally:
        try:
            cleanup(database, ids, command_prefix)
        finally:
            client.logout()


if __name__ == "__main__":
    raise SystemExit(main())
