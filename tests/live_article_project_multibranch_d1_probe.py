#!/usr/bin/env python3
"""Exercise the 0010 ArticleProject multi-ArticleBranch state against local D1."""

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


def request_json(base_url: str, method: str, path: str, body: dict[str, Any] | None = None,
                 *, write: bool = False) -> tuple[int, dict[str, Any]]:
    raw = None if body is None else json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    headers = {
        "Accept": "application/json",
        "Origin": base_url,
        "Referer": f"{base_url}/",
        "Sec-Fetch-Site": "same-origin",
    }
    if raw is not None:
        headers["Content-Type"] = "application/json"
    if write:
        headers["X-Wenmai-Write"] = "1"
    request = urllib.request.Request(f"{base_url}{path}", data=raw, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=40) as response:
            return response.status, json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        text = error.read().decode("utf-8", errors="replace")
        try:
            return error.code, json.loads(text)
        except json.JSONDecodeError:
            return error.code, {"raw": text}


def expect(result: tuple[int, dict[str, Any]], label: str,
           statuses: set[int] | None = None) -> dict[str, Any]:
    status, payload = result
    if status not in (statuses or {200, 201}) or payload.get("ok") is not True:
        raise ProbeFailure(f"{label}: HTTP {status} {json.dumps(payload, ensure_ascii=False)}")
    return payload["data"]


def post_project(base_url: str, action: str, command_id: str,
                 payload: dict[str, Any]) -> tuple[int, dict[str, Any]]:
    return request_json(base_url, "POST", "/api/project-package/v1", {
        "action": action,
        "commandId": command_id,
        "payload": payload,
    }, write=True)


def get_project(base_url: str, view: str, **params: str) -> dict[str, Any]:
    query = urllib.parse.urlencode({"view": view, **params})
    return expect(request_json(base_url, "GET", f"/api/project-package/v1?{query}"), f"GET {view}", {200})


def find_d1_database(root: Path) -> Path:
    folder = root / ".wrangler" / "state" / "v3" / "d1" / "miniflare-D1DatabaseObject"
    for candidate in sorted(folder.glob("*.sqlite"), key=lambda item: item.stat().st_mtime, reverse=True):
        if candidate.name == "metadata.sqlite":
            continue
        try:
            with sqlite3.connect(candidate) as connection:
                if connection.execute(
                    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='article_project_packages'"
                ).fetchone():
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
    raise ProbeFailure("no corpus article is available for an isolated multi-branch probe")


def seed_branch(connection: sqlite3.Connection, *, article_id: str, branch_id: str,
                revision_id: str, slug: str, title: str, body: str, now: str) -> None:
    body_sha = sha256_text(body)
    connection.execute(
        "INSERT INTO article_revisions (id, article_id, branch_id, sequence, parent_revision_id, "
        "merge_parent_revision_id, source_version_id, title, document_title, annotation, body_text, "
        "body_sha256, author_kind, created_at) VALUES (?, ?, ?, 1, NULL, NULL, NULL, ?, ?, '', ?, ?, 'user', ?)",
        (revision_id, article_id, branch_id, title, title, body, body_sha, now),
    )
    connection.execute(
        "INSERT INTO article_branches (id, article_id, name, slug, color, status, head_revision_id, "
        "base_revision_id, base_source_version_id, created_at, updated_at) "
        "VALUES (?, ?, ?, ?, 'cyan', 'active', ?, ?, NULL, ?, ?)",
        (branch_id, article_id, title, slug, revision_id, revision_id, now, now),
    )
    connection.execute(
        "INSERT INTO branch_working_copies (branch_id, article_id, base_revision_id, title, annotation, "
        "body_text, body_sha256, dirty, lock_version, updated_at) VALUES (?, ?, ?, ?, '', ?, ?, 0, 1, ?)",
        (branch_id, article_id, revision_id, title, body, body_sha, now),
    )


def cleanup(database: Path, *, package_id: str | None, branch_ids: list[str],
            command_prefix: str, article_id: str, prior_event_ids: set[str]) -> None:
    for attempt in range(10):
        try:
            with sqlite3.connect(database, timeout=20) as connection:
                connection.execute("PRAGMA busy_timeout=20000")
                connection.execute("BEGIN IMMEDIATE")
                if package_id:
                    for table in [
                        "package_module_revision_refs", "package_composition_edges", "package_composition_nodes",
                        "package_branch_composition_commits", "package_composition_materializations",
                        "package_module_revisions", "package_diagnostic_issues", "package_diagnosis_runs",
                        "package_slices", "package_export_runs", "package_import_runs", "package_patch_proposals",
                        "package_assets", "package_source_refs", "package_modules", "package_compositions",
                        "package_branch_working_copies", "package_branch_states", "package_branch_migration_audits",
                        "package_working_copies",
                    ]:
                        connection.execute(f"DELETE FROM {table} WHERE package_id = ?", (package_id,))
                    connection.execute("DELETE FROM article_project_packages WHERE id = ?", (package_id,))
                for branch_id in branch_ids:
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
            if attempt == 9:
                raise
            time.sleep(0.35 * (attempt + 1))


def mutate_document(document: dict[str, Any], marker: str) -> dict[str, Any]:
    result = copy.deepcopy(document)
    result["modules"][0]["contentText"] = str(result["modules"][0].get("contentText", "")) + f"\n\n{marker}"
    return result


def save_payload(package_id: str, branch_id: str, detail: dict[str, Any],
                 document: dict[str, Any]) -> dict[str, Any]:
    return {
        "packageId": package_id,
        "branchId": branch_id,
        "expectedBranchLockVersion": detail["branchState"]["lockVersion"],
        "expectedWorkingLockVersion": detail["workingCopy"]["lockVersion"],
        "expectedBaseCompositionId": detail["workingCopy"]["baseCompositionId"],
        "expectedBaseRevisionId": detail["workingCopy"]["baseRevisionId"],
        "document": document,
    }


def commit_payload(package_id: str, branch_id: str, saved: dict[str, Any], title: str) -> dict[str, Any]:
    return {
        "packageId": package_id,
        "branchId": branch_id,
        "expectedBranchLockVersion": saved["branchState"]["lockVersion"],
        "expectedWorkingLockVersion": saved["workingCopy"]["lockVersion"],
        "expectedBaseCompositionId": saved["workingCopy"]["baseCompositionId"],
        "expectedBaseRevisionId": saved["workingCopy"]["baseRevisionId"],
        "expectedDocumentSha256": saved["workingCopy"]["documentSha256"],
        "compositionTitle": title,
    }


def run_probe(base_url: str, root: Path, keep: bool) -> dict[str, Any]:
    run_id = uuid.uuid4().hex[:12]
    prefix = f"multibranch-probe:{run_id}:"
    branch_a = f"multibranch-a-{run_id}"
    branch_b = f"multibranch-b-{run_id}"
    revision_a = f"multibranch-a-revision-{run_id}"
    revision_b = f"multibranch-b-revision-{run_id}"
    package_id: str | None = None
    database: Path | None = None
    article_id = ""
    prior_event_ids: set[str] = set()

    def command(name: str) -> str:
        return f"{prefix}{name}"

    try:
        get_project(base_url, "health")
        database = find_d1_database(root)
        article_id = pick_article(root, database)
        now = "2026-08-17T00:00:00.000Z"
        body_a = f"# Multi branch A {run_id}\n\nArticleBranch A baseline."
        body_b = f"# Multi branch B {run_id}\n\nArticleBranch B baseline."
        with sqlite3.connect(database, timeout=20) as connection:
            prior_event_ids = {row[0] for row in connection.execute(
                "SELECT id FROM workspace_events WHERE article_id = ?", (article_id,)
            )}
            seed_branch(connection, article_id=article_id, branch_id=branch_a, revision_id=revision_a,
                        slug=f"multibranch-a-{run_id}", title=f"Multi A {run_id}", body=body_a, now=now)
            seed_branch(connection, article_id=article_id, branch_id=branch_b, revision_id=revision_b,
                        slug=f"multibranch-b-{run_id}", title=f"Multi B {run_id}", body=body_b, now=now)
            connection.commit()

        created = expect(post_project(base_url, "ensure_from_revision", command("ensure-a"), {
            "articleId": article_id,
            "revisionId": revision_a,
            "expectedBodySha256": sha256_text(body_a),
            "branchId": branch_a,
            "title": f"Multi branch Package {run_id}",
        }), "ensure A", {201})
        package_id = created["package"]["id"]
        detail_a = get_project(base_url, "package", packageId=package_id, branchId=branch_a)
        attached_b = expect(post_project(base_url, "attach_branch", command("attach-b"), {
            "packageId": package_id,
            "branchId": branch_b,
            "expectedBranchHeadRevisionId": revision_b,
            "expectedBranchHeadBodySha256": sha256_text(body_b),
            "expectedBranchWorkingLockVersion": 1,
        }), "attach B", {201})
        if attached_b["boundary"].get("articleBranchAdvanced") or attached_b["boundary"].get("revisionCreated"):
            raise ProbeFailure("attach_branch advanced ArticleBranch or created a Revision")
        branches = get_project(base_url, "branches", packageId=package_id)
        if {item["branchId"] for item in branches["branches"] if item.get("attached")} != {branch_a, branch_b}:
            raise ProbeFailure("branches view did not expose both attached ArticleBranches")
        detail_b = get_project(base_url, "package", packageId=package_id, branchId=branch_b)

        saved_a = expect(post_project(base_url, "save_working_package", command("save-a"),
            save_payload(package_id, branch_a, detail_a, mutate_document(detail_a["workingCopy"]["document"], "A draft"))), "save A")
        untouched_b = get_project(base_url, "package", packageId=package_id, branchId=branch_b)
        if untouched_b["workingCopy"]["dirty"] or untouched_b["workingCopy"]["documentSha256"] != detail_b["workingCopy"]["documentSha256"]:
            raise ProbeFailure("saving A changed B working copy")
        saved_b = expect(post_project(base_url, "save_working_package", command("save-b"),
            save_payload(package_id, branch_b, detail_b, mutate_document(detail_b["workingCopy"]["document"], "B draft"))), "save B")
        restored_a = get_project(base_url, "package", packageId=package_id, branchId=branch_a)
        if not restored_a["workingCopy"]["dirty"] or restored_a["workingCopy"]["documentSha256"] != saved_a["workingCopy"]["documentSha256"]:
            raise ProbeFailure("switching back to A did not restore its exact dirty working copy")
        stale_status, stale_payload = post_project(base_url, "save_working_package", command("stale-save-a"),
            save_payload(package_id, branch_a, detail_a, mutate_document(detail_a["workingCopy"]["document"], "stale")))
        if stale_status != 409 or stale_payload.get("error", {}).get("code") != "WORKING_COPY_CAS_CONFLICT":
            raise ProbeFailure(f"same-branch stale save was not rejected: {stale_status} {stale_payload}")

        primary_before_b = saved_b["package"]["mainCompositionId"]
        committed_b = expect(post_project(base_url, "commit", command("commit-b"),
            commit_payload(package_id, branch_b, saved_b, "B independent commit")), "commit B", {201})
        if committed_b["package"]["mainCompositionId"] != primary_before_b or committed_b["boundary"].get("packageMainAdvanced"):
            raise ProbeFailure("secondary B commit changed the primary compatibility mirror")
        committed_a = expect(post_project(base_url, "commit", command("commit-a"),
            commit_payload(package_id, branch_a, saved_a, "A primary commit")), "commit A", {201})
        if committed_a["package"]["mainCompositionId"] != committed_a["composition"]["id"] or not committed_a["boundary"].get("packageMainAdvanced"):
            raise ProbeFailure("primary A commit did not update the compatibility mirror")

        primary_b = expect(post_project(base_url, "set_primary_branch", command("primary-b"), {
            "packageId": package_id,
            "branchId": branch_b,
            "expectedPackageLockVersion": committed_a["package"]["lockVersion"],
            "expectedBranchLockVersion": committed_b["branchState"]["lockVersion"],
            "expectedHeadCompositionId": committed_b["composition"]["id"],
            "expectedHeadRevisionId": committed_b["articleRevision"]["id"],
        }), "set primary B")
        if primary_b["package"]["primaryBranchId"] != branch_b or primary_b["package"]["mainCompositionId"] != committed_b["composition"]["id"]:
            raise ProbeFailure("set_primary_branch did not atomically mirror B")

        current_a = get_project(base_url, "package", packageId=package_id, branchId=branch_a)
        current_b = get_project(base_url, "package", packageId=package_id, branchId=branch_b)
        diagnosis_a = expect(post_project(base_url, "run_builtin_diagnostics", command("diagnose-a"), {
            "packageId": package_id,
            "branchId": branch_a,
            "baseRevisionId": current_a["branchState"]["headRevisionId"],
            "expectedBranchLockVersion": current_a["branchState"]["lockVersion"],
            "compositionId": current_a["composition"]["id"],
            "expectedCompositionSha256": current_a["composition"]["compositionSha256"],
        }), "diagnose A", {201})
        if diagnosis_a["diagnosisRun"].get("branchId") != branch_a:
            raise ProbeFailure("diagnosis omitted branch provenance")
        slice_a = expect(post_project(base_url, "create_slice", command("slice-a"), {
            "packageId": package_id,
            "branchId": branch_a,
            "baseRevisionId": current_a["branchState"]["headRevisionId"],
            "expectedBranchLockVersion": current_a["branchState"]["lockVersion"],
            "compositionId": current_a["composition"]["id"],
            "expectedCompositionSha256": current_a["composition"]["compositionSha256"],
            "title": "A full slice",
            "sliceKind": "full",
        }), "slice A", {201})
        exported_a = expect(post_project(base_url, "create_export_manifest", command("export-a"), {
            "packageId": package_id,
            "branchId": branch_a,
            "baseRevisionId": current_a["branchState"]["headRevisionId"],
            "expectedBranchLockVersion": current_a["branchState"]["lockVersion"],
            "compositionId": current_a["composition"]["id"],
            "expectedCompositionSha256": current_a["composition"]["compositionSha256"],
            "sliceId": slice_a["slice"]["id"],
            "expectedSliceSha256": slice_a["slice"]["sliceSha256"],
        }), "export A", {201})
        if exported_a["exportRun"].get("branchId") != branch_a:
            raise ProbeFailure("export manifest omitted branch provenance")

        import_document_b = mutate_document(current_b["composition"]["document"], "B import candidate")
        imported_b = expect(post_project(base_url, "create_import_candidate", command("import-b"), {
            "packageId": package_id,
            "branchId": branch_b,
            "baseRevisionId": current_b["branchState"]["headRevisionId"],
            "expectedBranchLockVersion": current_b["branchState"]["lockVersion"],
            "baseCompositionId": current_b["composition"]["id"],
            "expectedBaseCompositionSha256": current_b["composition"]["compositionSha256"],
            "sourceKind": "probe",
            "sourceRef": f"probe://{run_id}/b",
            "sourceFingerprintSha256": sha256_text(f"probe-import-{run_id}"),
            "importerKey": "wenmai.probe",
            "importerVersion": "1",
            "document": import_document_b,
        }), "import B", {201})
        if imported_b["importRun"].get("branchId") != branch_b or not imported_b["boundary"].get("candidateOnly"):
            raise ProbeFailure("import candidate crossed branch boundary or advanced a head")

        patch_document_a = mutate_document(current_a["composition"]["document"], "A approved patch")
        proposed_a = expect(post_project(base_url, "create_patch", command("patch-a"), {
            "packageId": package_id,
            "branchId": branch_a,
            "baseRevisionId": current_a["branchState"]["headRevisionId"],
            "expectedBranchLockVersion": current_a["branchState"]["lockVersion"],
            "baseCompositionId": current_a["composition"]["id"],
            "expectedBaseCompositionSha256": current_a["composition"]["compositionSha256"],
            "title": "A approved patch",
            "operations": [{"op": "replace_document", "document": patch_document_a}],
        }), "propose patch A", {201})
        approved_a = expect(post_project(base_url, "decide_patch", command("approve-a"), {
            "patchProposalId": proposed_a["patchProposal"]["id"],
            "expectedLockVersion": proposed_a["patchProposal"]["lockVersion"],
            "decision": "approved",
        }), "approve patch A")
        b_snapshot = get_project(base_url, "package", packageId=package_id, branchId=branch_b)
        apply_payload = {
            "packageId": package_id,
            "branchId": branch_a,
            "patchProposalId": approved_a["patchProposal"]["id"],
            "expectedPatchLockVersion": approved_a["patchProposal"]["lockVersion"],
            "expectedBranchLockVersion": current_a["branchState"]["lockVersion"],
            "expectedHeadCompositionId": current_a["composition"]["id"],
            "expectedHeadCompositionSha256": current_a["composition"]["compositionSha256"],
            "expectedHeadRevisionId": current_a["branchState"]["headRevisionId"],
        }
        applied_a = expect(post_project(base_url, "apply_patch", command("apply-a"), apply_payload), "apply patch A", {201})
        retried_a = expect(post_project(base_url, "apply_patch", command("apply-a"), apply_payload), "retry apply A", {201})
        if retried_a["composition"]["id"] != applied_a["composition"]["id"]:
            raise ProbeFailure("command receipt retry created a different Composition")
        if applied_a["package"]["mainCompositionId"] != b_snapshot["composition"]["id"] or applied_a["boundary"].get("packageMainAdvanced"):
            raise ProbeFailure("secondary A patch changed primary B compatibility mirror")
        b_after = get_project(base_url, "package", packageId=package_id, branchId=branch_b)
        for key in ["headCompositionId", "headCompositionSha256", "headRevisionId", "lockVersion"]:
            if b_after["branchState"][key] != b_snapshot["branchState"][key]:
                raise ProbeFailure(f"applying A patch changed B branch state field {key}")

        workspace_status, workspace_payload = request_json(base_url, "POST", "/api/workspace", {
            "action": "save_working_copy",
            "branchId": branch_a,
            "baseRevisionId": applied_a["articleRevision"]["id"],
            "lockVersion": applied_a["branchBridge"]["workingCopyLockVersion"],
            "title": "must be rejected",
            "annotation": "",
            "bodyText": "legacy Workspace write",
        })
        if workspace_status != 409 or "ArticleProject Package" not in str(workspace_payload.get("error", "")):
            raise ProbeFailure(f"Workspace did not reject an attached secondary branch: {workspace_status} {workspace_payload}")

        with sqlite3.connect(database) as connection:
            invariant_rows = connection.execute(
                "SELECT state.branch_id, state.head_composition_id, state.head_revision_id, state.lock_version, "
                "package_copy.base_composition_id, package_copy.base_revision_id, package_copy.dirty, "
                "article_branch.head_revision_id, article_copy.base_revision_id, article_copy.dirty, "
                "materialization.article_revision_id, commit_ref.article_revision_id "
                "FROM package_branch_states state "
                "JOIN package_branch_working_copies package_copy ON package_copy.package_id=state.package_id AND package_copy.branch_id=state.branch_id "
                "JOIN article_branches article_branch ON article_branch.id=state.branch_id "
                "JOIN branch_working_copies article_copy ON article_copy.branch_id=state.branch_id "
                "JOIN package_composition_materializations materialization ON materialization.package_id=state.package_id "
                "AND materialization.branch_id=state.branch_id AND materialization.composition_id=state.head_composition_id "
                "AND materialization.article_revision_id=state.head_revision_id "
                "JOIN package_branch_composition_commits commit_ref ON commit_ref.package_id=state.package_id "
                "AND commit_ref.branch_id=state.branch_id AND commit_ref.composition_id=state.head_composition_id "
                "AND commit_ref.article_revision_id=state.head_revision_id WHERE state.package_id=? ORDER BY state.branch_id",
                (package_id,),
            ).fetchall()
        if len(invariant_rows) != 2:
            raise ProbeFailure("final invariant query did not return both branches")
        for row in invariant_rows:
            if not (row[1] == row[4] and row[2] == row[5] == row[7] == row[8] == row[10] == row[11]
                    and row[6] == 0 and row[9] == 0):
                raise ProbeFailure(f"final branch invariant diverged: {row}")

        return {
            "ok": True,
            "runId": run_id,
            "articleId": article_id,
            "packageId": package_id,
            "branches": [branch_a, branch_b],
            "dirtyWorkingCopiesPreservedAcrossSwitch": True,
            "sameBranchStaleRejected": True,
            "independentBranchCommits": True,
            "primaryMirrorConditional": True,
            "diagnosticBranchBound": True,
            "sliceAndExportBranchBound": True,
            "importCandidateBranchBound": True,
            "patchApplyBranchBound": True,
            "commandReceiptIdempotent": True,
            "workspaceAllAttachedBranchesRejected": True,
            "finalInvariantRows": len(invariant_rows),
            "database": str(database),
        }
    finally:
        if not keep and database and article_id:
            cleanup(database, package_id=package_id, branch_ids=[branch_a, branch_b],
                    command_prefix=prefix, article_id=article_id, prior_event_ids=prior_event_ids)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-url", default="http://[::1]:3000")
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--keep", action="store_true")
    args = parser.parse_args()
    result = run_probe(args.base_url.rstrip("/"), args.root.resolve(), args.keep)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
