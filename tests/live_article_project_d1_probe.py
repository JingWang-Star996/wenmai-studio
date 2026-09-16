#!/usr/bin/env python3
"""Run a destructive-to-test-data-only ArticleProject D1 HTTP probe and clean it up."""

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


PACKAGE_TABLES = [
    "package_module_revision_refs",
    "package_composition_edges",
    "package_composition_nodes",
    "package_composition_materializations",
    "package_module_revisions",
    "package_diagnostic_issues",
    "package_diagnosis_runs",
    "package_slices",
    "package_export_runs",
    "package_import_runs",
    "package_patch_proposals",
    "package_assets",
    "package_source_refs",
    "package_modules",
    "package_compositions",
    "package_working_copies",
]


class ProbeFailure(RuntimeError):
    pass


def sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def request_json(base_url: str, method: str, path: str, body: dict[str, Any] | None = None,
                 *, write_intent: bool = False, origin: bool = True) -> tuple[int, dict[str, Any]]:
    raw = None if body is None else json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    headers = {"Accept": "application/json"}
    if origin:
        headers.update({
            "Origin": base_url,
            "Referer": f"{base_url}/",
            "Sec-Fetch-Site": "same-origin",
        })
    if raw is not None:
        headers["Content-Type"] = "application/json"
    if write_intent:
        headers["X-Wenmai-Write"] = "1"
    request = urllib.request.Request(f"{base_url}{path}", data=raw, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            return response.status, json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        return error.code, json.loads(error.read().decode("utf-8"))


def expect_ok(result: tuple[int, dict[str, Any]], label: str, expected_statuses: set[int] | None = None) -> dict[str, Any]:
    status, payload = result
    allowed = expected_statuses or {200, 201}
    if status not in allowed or payload.get("ok") is not True or not isinstance(payload.get("data"), dict):
        raise ProbeFailure(f"{label} failed: HTTP {status} {json.dumps(payload, ensure_ascii=False)}")
    return payload["data"]


def post_action(base_url: str, action: str, command_id: str, payload: dict[str, Any]) -> tuple[int, dict[str, Any]]:
    return request_json(
        base_url, "POST", "/api/project-package/v1",
        {"action": action, "commandId": command_id, "payload": payload},
        write_intent=True,
    )


def find_d1_database(root: Path) -> Path:
    candidates = sorted(
        (root / ".wrangler" / "state" / "v3" / "d1" / "miniflare-D1DatabaseObject").glob("*.sqlite"),
        key=lambda path: path.stat().st_mtime,
        reverse=True,
    )
    for candidate in candidates:
        if candidate.name == "metadata.sqlite":
            continue
        try:
            with sqlite3.connect(candidate) as connection:
                exists = connection.execute(
                    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='article_project_packages'"
                ).fetchone()
                if exists:
                    return candidate
        except sqlite3.Error:
            continue
    raise ProbeFailure("cannot locate the active local D1 sqlite file")


def cleanup(database_path: Path, package_ids: list[str], article_ids: list[str], command_prefix: str,
            revision_id: str | None) -> None:
    for attempt in range(8):
        try:
            with sqlite3.connect(database_path, timeout=10) as connection:
                connection.execute("PRAGMA busy_timeout=10000")
                connection.execute("BEGIN IMMEDIATE")
                for package_id in package_ids:
                    for table in PACKAGE_TABLES:
                        connection.execute(f"DELETE FROM {table} WHERE package_id = ?", (package_id,))
                    connection.execute("DELETE FROM article_project_packages WHERE id = ?", (package_id,))
                for article_id in article_ids:
                    connection.execute("DELETE FROM workspace_events WHERE article_id = ?", (article_id,))
                    connection.execute("DELETE FROM branch_working_copies WHERE article_id = ?", (article_id,))
                    connection.execute("DELETE FROM article_revisions WHERE article_id = ?", (article_id,))
                    connection.execute("DELETE FROM article_branches WHERE article_id = ?", (article_id,))
                if revision_id:
                    connection.execute("DELETE FROM article_revisions WHERE id = ?", (revision_id,))
                connection.execute("DELETE FROM command_receipts WHERE id LIKE ?", (f"{command_prefix}%",))
                connection.commit()
            return
        except sqlite3.OperationalError:
            if attempt == 7:
                raise
            time.sleep(0.25 * (attempt + 1))


def run_probe(base_url: str, root: Path, keep: bool) -> dict[str, Any]:
    run_id = uuid.uuid4().hex[:12]
    command_prefix = f"project-probe:{run_id}:"
    article_id = f"project-probe-article-{run_id}"
    text_article_id = f"project-probe-text-article-{run_id}"
    project_id = f"project-probe-project-{run_id}"
    package_id: str | None = None
    package_ids: list[str] = []
    revision_id = f"project-probe-revision-{run_id}"
    revision_branch_id = f"project-probe-branch-{run_id}"
    database_path: Path | None = None
    commands: dict[str, str] = {}

    def command(name: str) -> str:
        value = f"{command_prefix}{name}"
        commands[name] = value
        return value

    try:
        health = expect_ok(
            request_json(base_url, "GET", "/api/project-package/v1?view=health"),
            "health", {200},
        )
        unauth_status, unauth = request_json(
            base_url, "POST", "/api/project-package/v1",
            {"action": "create_from_text", "commandId": command("unauth"), "payload": {}},
            write_intent=True, origin=False,
        )
        if unauth_status != 403 or unauth.get("error", {}).get("code") != "ORIGIN_MISMATCH":
            raise ProbeFailure("same-origin negative control did not fail closed")

        database_path = find_d1_database(root)
        revision_body = "# Probe\n\nImmutable revision baseline."
        revision_sha = sha256_text(revision_body)
        with sqlite3.connect(database_path, timeout=10) as connection:
            connection.execute("PRAGMA busy_timeout=10000")
            connection.execute(
                "INSERT INTO article_revisions "
                "(id, article_id, branch_id, sequence, parent_revision_id, merge_parent_revision_id, source_version_id, "
                "title, document_title, annotation, body_text, body_sha256, author_kind, created_at) "
                "VALUES (?, ?, ?, 1, NULL, NULL, NULL, ?, ?, '', ?, ?, 'user', ?)",
                (revision_id, article_id, revision_branch_id, f"Probe {run_id}",
                 f"Probe {run_id}", revision_body, revision_sha, "2026-08-17T00:00:00.000Z"),
            )
            connection.execute(
                "INSERT INTO article_branches (id, article_id, name, slug, color, status, head_revision_id, "
                "base_revision_id, base_source_version_id, created_at, updated_at) "
                "VALUES (?, ?, ?, ?, 'cyan', 'active', ?, ?, NULL, ?, ?)",
                (revision_branch_id, article_id, f"probe/{run_id}", f"probe-{run_id}", revision_id, revision_id,
                 "2026-08-17T00:00:00.000Z", "2026-08-17T00:00:00.000Z"),
            )
            connection.execute(
                "INSERT INTO branch_working_copies (branch_id, article_id, base_revision_id, title, annotation, "
                "body_text, body_sha256, dirty, lock_version, updated_at) VALUES (?, ?, ?, ?, '', ?, ?, 0, 1, ?)",
                (revision_branch_id, article_id, revision_id, f"Probe {run_id}", revision_body, revision_sha,
                 "2026-08-17T00:00:00.000Z"),
            )
            connection.commit()

        created = expect_ok(post_action(base_url, "ensure_from_revision", command("ensure"), {
            "articleId": article_id,
            "projectId": project_id,
            "revisionId": revision_id,
            "expectedBodySha256": revision_sha,
            "title": f"ArticleProject probe {run_id}",
        }), "ensure_from_revision", {201})
        package_id = created["package"]["id"]
        package_ids.append(package_id)
        if created["workingCopy"]["dirty"] is not False:
            raise ProbeFailure("new working copy must be clean")

        text_created = expect_ok(post_action(base_url, "create_from_text", command("create-text"), {
            "articleId": text_article_id,
            "title": f"Text probe {run_id}",
            "bodyText": "# Text probe\n\nIndependent create_from_text coverage.",
        }), "create_from_text", {201})
        package_ids.append(text_created["package"]["id"])

        package_detail = expect_ok(request_json(
            base_url, "GET", "/api/project-package/v1?" + urllib.parse.urlencode({"view": "package", "packageId": package_id}),
        ), "GET package", {200})
        document = copy.deepcopy(package_detail["workingCopy"]["document"])
        document["assets"].append({
            "key": "probe-asset",
            "kind": "text",
            "title": "Probe asset",
            "contentRef": "artifact:.runner/package/probe.txt",
            "mediaType": "text/plain",
            "sha256": sha256_text("probe asset"),
            "sizeBytes": len("probe asset"),
            "metadata": {"probe": True},
            "rights": {"status": "test-only"},
        })
        document["sources"].append({
            "key": "probe-source",
            "sourceKind": "web",
            "canonicalRef": "https://example.invalid/probe",
            "title": "Probe source",
            "contentSha256": sha256_text("probe source"),
            "excerpt": "Test-only source binding.",
            "metadata": {"probe": True},
            "rights": {"status": "test-only"},
        })
        document["modules"][0]["refs"] = [
            {"refKind": "asset", "refKey": "probe-asset", "relationType": "illustrates"},
            {"refKind": "source", "refKey": "probe-source", "relationType": "supports"},
        ]
        document["modules"].append({
            "key": "empty-candidate",
            "kind": "paragraph",
            "title": "Empty candidate",
            "contentFormat": "markdown",
            "contentText": "",
            "metadata": {"probe": True},
            "refs": [],
        })
        saved = expect_ok(post_action(base_url, "save_working_package", command("save"), {
            "packageId": package_id,
            "expectedPackageLockVersion": package_detail["package"]["lockVersion"],
            "expectedWorkingLockVersion": package_detail["workingCopy"]["lockVersion"],
            "expectedBaseCompositionId": package_detail["workingCopy"]["baseCompositionId"],
            "document": document,
        }), "save_working_package")
        if saved["workingCopy"]["dirty"] is not True or saved["boundary"]["immutableCompositionCreated"] is not False:
            raise ProbeFailure("working save crossed the immutable boundary")

        committed = expect_ok(post_action(base_url, "commit", command("commit"), {
            "packageId": package_id,
            "expectedPackageLockVersion": saved["package"]["lockVersion"],
            "expectedWorkingLockVersion": saved["workingCopy"]["lockVersion"],
            "expectedBaseCompositionId": saved["workingCopy"]["baseCompositionId"],
            "expectedDocumentSha256": saved["workingCopy"]["documentSha256"],
            "compositionTitle": "Probe commit",
        }), "commit", {201})
        if committed["workingCopy"]["dirty"] is not False or committed["package"]["mainCompositionId"] != committed["composition"]["id"]:
            raise ProbeFailure("commit did not advance/reset atomically")
        stale_status, stale = post_action(base_url, "save_working_package", command("stale-save"), {
            "packageId": package_id,
            "expectedPackageLockVersion": saved["package"]["lockVersion"],
            "expectedWorkingLockVersion": saved["workingCopy"]["lockVersion"],
            "expectedBaseCompositionId": saved["workingCopy"]["baseCompositionId"],
            "document": document,
        })
        if stale_status != 409 or stale.get("error", {}).get("code") not in {"PACKAGE_CAS_CONFLICT", "PACKAGE_HEAD_CHANGED"}:
            raise ProbeFailure("stale Package CAS was not rejected")

        diagnosed = expect_ok(post_action(base_url, "run_builtin_diagnostics", command("diagnose"), {
            "packageId": package_id,
            "compositionId": committed["composition"]["id"],
            "expectedCompositionSha256": committed["composition"]["compositionSha256"],
        }), "run_builtin_diagnostics", {201})
        fixable = next((issue for issue in diagnosed["issues"] if issue.get("suggestedPatch")), None)
        if not fixable:
            raise ProbeFailure("diagnostics did not bind a fixable issue")

        proposed = expect_ok(post_action(base_url, "create_patch", command("patch"), {
            "packageId": package_id,
            "baseCompositionId": committed["composition"]["id"],
            "expectedBaseCompositionSha256": committed["composition"]["compositionSha256"],
            "title": "Probe diagnostic fix",
            "summary": fixable["message"],
            "operations": fixable["suggestedPatch"],
            "evidence": fixable["evidence"],
            "diagnosticIssueIds": [fixable["id"]],
        }), "create_patch", {201})
        if proposed["boundary"]["packageMainAdvanced"] is not False:
            raise ProbeFailure("candidate patch advanced main")

        decided = expect_ok(post_action(base_url, "decide_patch", command("decide"), {
            "patchProposalId": proposed["patchProposal"]["id"],
            "expectedLockVersion": proposed["patchProposal"]["lockVersion"],
            "decision": "approved",
            "note": "probe approval",
        }), "decide_patch")
        applied = expect_ok(post_action(base_url, "apply_patch", command("apply"), {
            "packageId": package_id,
            "patchProposalId": decided["patchProposal"]["id"],
            "expectedPatchLockVersion": decided["patchProposal"]["lockVersion"],
            "expectedPackageLockVersion": committed["package"]["lockVersion"],
            "expectedMainCompositionId": committed["package"]["mainCompositionId"],
            "expectedMainCompositionSha256": committed["package"]["mainCompositionSha256"],
        }), "apply_patch", {201})
        if applied["patchProposal"]["status"] != "applied" or applied["boundary"]["packageMainAdvanced"] is not True:
            raise ProbeFailure("approved patch did not apply through CAS")

        sliced = expect_ok(post_action(base_url, "create_slice", command("slice"), {
            "packageId": package_id,
            "compositionId": applied["composition"]["id"],
            "expectedCompositionSha256": applied["composition"]["compositionSha256"],
            "title": "Probe full slice",
            "sliceKind": "full",
        }), "create_slice", {201})
        exported = expect_ok(post_action(base_url, "create_export_manifest", command("export"), {
            "packageId": package_id,
            "compositionId": applied["composition"]["id"],
            "expectedCompositionSha256": applied["composition"]["compositionSha256"],
            "sliceId": sliced["slice"]["id"],
            "expectedSliceSha256": sliced["slice"]["sliceSha256"],
            "exportKind": "probe",
            "exporterKey": "live-probe",
            "exporterVersion": "1",
        }), "create_export_manifest", {201})
        if exported["exportRun"]["state"] != "manifest_ready" or exported["boundary"]["artifactCreated"] is not False:
            raise ProbeFailure("manifest export overstated artifact state")

        # Import a document whose IDs belong to a different Package. The API must remap
        # portable IDs by key instead of allowing a global primary-key collision at apply time.
        import_document = copy.deepcopy(text_created["composition"]["document"])
        import_document["modules"].append({
            "key": "imported-probe",
            "kind": "paragraph",
            "title": "Imported probe",
            "contentFormat": "markdown",
            "contentText": "Candidate only.",
            "metadata": {"probe": True},
            "refs": [],
        })
        import_payload = {
            "packageId": package_id,
            "expectedPackageLockVersion": applied["package"]["lockVersion"],
            "baseCompositionId": applied["composition"]["id"],
            "expectedBaseCompositionSha256": applied["composition"]["compositionSha256"],
            "sourceKind": "probe",
            "sourceRef": f"probe:{run_id}",
            "sourceFingerprintSha256": sha256_text(run_id),
            "importerKey": "live-probe",
            "importerVersion": "1",
            "document": import_document,
            "summary": "candidate only",
        }
        import_command = command("import")
        imported = expect_ok(post_action(base_url, "create_import_candidate", import_command, import_payload), "create_import_candidate", {201})
        imported_body_id = imported["patchProposal"]["operations"][0]["document"]["modules"][0]["id"]
        source_body_id = text_created["composition"]["document"]["modules"][0]["id"]
        target_body_id = applied["workingCopy"]["document"]["modules"][0]["id"]
        if imported_body_id == source_body_id or imported_body_id != target_body_id:
            raise ProbeFailure("portable import IDs were not remapped to the target Package identity")
        replayed = expect_ok(post_action(base_url, "create_import_candidate", import_command, import_payload), "import idempotent replay", {201})
        if replayed["importRun"]["id"] != imported["importRun"]["id"]:
            raise ProbeFailure("idempotent replay returned a different ImportRun")
        changed_payload = copy.deepcopy(import_payload)
        changed_payload["summary"] = "different request"
        conflict_status, conflict = post_action(base_url, "create_import_candidate", import_command, changed_payload)
        if conflict_status != 409 or conflict.get("error", {}).get("code") != "COMMAND_ID_REUSED":
            raise ProbeFailure("commandId reuse did not fail closed")

        import_decided = expect_ok(post_action(base_url, "decide_patch", command("decide-import"), {
            "patchProposalId": imported["patchProposal"]["id"],
            "expectedLockVersion": imported["patchProposal"]["lockVersion"],
            "decision": "approved",
            "note": "probe portable import approval",
        }), "decide imported patch")
        import_applied = expect_ok(post_action(base_url, "apply_patch", command("apply-import"), {
            "packageId": package_id,
            "patchProposalId": import_decided["patchProposal"]["id"],
            "expectedPatchLockVersion": import_decided["patchProposal"]["lockVersion"],
            "expectedPackageLockVersion": applied["package"]["lockVersion"],
            "expectedMainCompositionId": applied["composition"]["id"],
            "expectedMainCompositionSha256": applied["composition"]["compositionSha256"],
        }), "apply imported patch", {201})
        import_detail = expect_ok(request_json(
            base_url, "GET", "/api/project-package/v1?" + urllib.parse.urlencode({
                "view": "imports", "importRunId": imported["importRun"]["id"],
            }),
        ), "GET applied ImportRun", {200})
        if import_detail["importRun"]["state"] != "applied":
            raise ProbeFailure("generic Patch apply did not advance the linked ImportRun")

        with sqlite3.connect(database_path) as connection:
            root_row = connection.execute(
                "SELECT main_composition_id, main_composition_sha256, lock_version FROM article_project_packages WHERE id = ?",
                (package_id,),
            ).fetchone()
            orphan_count = connection.execute(
                "SELECT COUNT(*) FROM package_compositions WHERE package_id = ? AND id NOT IN "
                "(SELECT base_composition_id FROM package_working_copies WHERE package_id = ?) "
                "AND id NOT IN (SELECT parent_composition_id FROM package_compositions WHERE package_id = ? AND parent_composition_id IS NOT NULL) "
                "AND id != ?",
                (package_id, package_id, package_id, import_applied["composition"]["id"]),
            ).fetchone()[0]
            working_saved_events = connection.execute(
                "SELECT COUNT(*) FROM workspace_events WHERE article_id = ? AND event_type = 'package.working_saved'",
                (article_id,),
            ).fetchone()[0]
            if not root_row or root_row[0] != import_applied["composition"]["id"]:
                raise ProbeFailure("D1 root pointer does not match the HTTP receipt")
            # Earlier immutable ancestors are expected; this query only catches unreferenced unexpected descendants.
            if orphan_count != 0:
                raise ProbeFailure(f"unexpected orphan compositions: {orphan_count}")
            if working_saved_events != 1:
                raise ProbeFailure(f"stale CAS produced an extra working-save event: {working_saved_events}")

        return {
            "ok": True,
            "runId": run_id,
            "healthStatus": health["status"],
            "packageId": package_id,
            "finalCompositionId": import_applied["composition"]["id"],
            "diagnosticIssueCount": len(diagnosed["issues"]),
            "patchStatus": applied["patchProposal"]["status"],
            "sliceId": sliced["slice"]["id"],
            "exportState": exported["exportRun"]["state"],
            "importCandidateState": imported["importRun"]["state"],
            "importFinalState": import_detail["importRun"]["state"],
            "idempotentReplay": True,
            "commandReuseRejected": True,
            "staleCasRejected": True,
            "database": str(database_path),
        }
    finally:
        if not keep:
            try:
                database_path = database_path or find_d1_database(root)
                cleanup(database_path, package_ids, [article_id, text_article_id], command_prefix, revision_id)
            except Exception as error:  # noqa: BLE001 - cleanup evidence must be surfaced
                raise ProbeFailure(f"probe cleanup failed: {error}") from error


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-url", default="http://localhost:3000")
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--keep", action="store_true")
    args = parser.parse_args()
    result = run_probe(args.base_url.rstrip("/"), args.root.resolve(), args.keep)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
