#!/usr/bin/env python3
"""Probe the real D1 + HTTP + stdio MCP Package read authentication boundary."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sqlite3
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path
from typing import Any


class ProbeFailure(RuntimeError):
    pass


def canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


def sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def find_database(root: Path) -> Path:
    folder = root / ".wrangler" / "state" / "v3" / "d1" / "miniflare-D1DatabaseObject"
    required = {
        "agent_clients", "article_project_packages", "article_branches", "package_compositions",
        "package_branch_states", "package_branch_working_copies", "package_branch_composition_commits",
        "package_branch_migration_audits", "package_diagnosis_runs", "package_diagnostic_issues", "package_slices",
    }
    for candidate in sorted(folder.glob("*.sqlite"), key=lambda item: item.stat().st_mtime, reverse=True):
        if candidate.name == "metadata.sqlite":
            continue
        try:
            with sqlite3.connect(candidate) as connection:
                tables = {str(row[0]) for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")}
                if required.issubset(tables):
                    return candidate
        except sqlite3.Error:
            pass
    raise ProbeFailure("cannot locate active local D1 with Agent + 0010 Package tables")


def request_json(base_url: str, path: str, *, token: str | None = None) -> tuple[int, dict[str, Any]]:
    headers = {"Accept": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
        headers["X-Wenmai-Agent-Protocol"] = "wenmai.agent/1.0"
    request = urllib.request.Request(f"{base_url}{path}", headers=headers, method="GET")
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with opener.open(request, timeout=20) as response:
            return int(response.status), json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        raw = error.read().decode("utf-8", errors="replace")
        try:
            return int(error.code), json.loads(raw)
        except json.JSONDecodeError:
            return int(error.code), {"raw": raw}


def expect_error(result: tuple[int, dict[str, Any]], status: int, code: str, label: str) -> None:
    actual_status, payload = result
    actual_code = payload.get("error", {}).get("code") if isinstance(payload, dict) else None
    if actual_status != status or actual_code != code:
        raise ProbeFailure(f"{label}: expected {status}/{code}, got {actual_status}/{canonical_json(payload)}")


def expect_ok(result: tuple[int, dict[str, Any]], label: str) -> dict[str, Any]:
    status, payload = result
    if status != 200 or payload.get("ok") is not True or not isinstance(payload.get("data"), dict):
        raise ProbeFailure(f"{label}: HTTP {status} {canonical_json(payload)}")
    return payload["data"]


def insert_fixture(database: Path, run_id: str) -> dict[str, str]:
    now = "2026-08-17T12:00:00.000Z"
    expires = "2099-01-01T00:00:00.000Z"
    ids = {
        "article": f"mcp-auth-article-{run_id}",
        "deniedArticle": f"mcp-auth-denied-article-{run_id}",
        "branch": f"mcp-auth-branch-{run_id}",
        "revision": f"mcp-auth-revision-{run_id}",
        "package": f"mcp-auth-package-{run_id}",
        "composition": f"mcp-auth-composition-{run_id}",
        "module": f"mcp-auth-module-{run_id}",
        "commit": f"mcp-auth-commit-{run_id}",
        "diagnosis": f"mcp-auth-diagnosis-{run_id}",
        "issue": f"mcp-auth-issue-{run_id}",
        "slice": f"mcp-auth-slice-{run_id}",
        "client": f"mcp-auth-client-{run_id}",
        "deniedClient": f"mcp-auth-denied-client-{run_id}",
        "noScopeClient": f"mcp-auth-noscope-client-{run_id}",
        "token": f"wenmai_agent_mcp_auth_{run_id}_{uuid.uuid4().hex}",
        "deniedToken": f"wenmai_agent_mcp_denied_{run_id}_{uuid.uuid4().hex}",
        "noScopeToken": f"wenmai_agent_mcp_noscope_{run_id}_{uuid.uuid4().hex}",
    }
    document = {
        "schemaVersion": "wenmai-package-document-v1",
        "rootModuleKey": "body",
        "modules": [{
            "key": "body", "kind": "paragraph", "title": "MCP auth probe",
            "contentFormat": "markdown", "contentText": "# MCP auth probe", "metadata": {}, "refs": [],
        }],
        "edges": [],
    }
    document_json = canonical_json(document)
    document_sha = sha256_text(document_json)
    composition_sha = sha256_text(f"composition\0{document_sha}")
    diagnosis_input_sha = sha256_text(f"diagnosis\0{run_id}")
    summary_sha = sha256_text(f"summary\0{run_id}")
    issue_sha = sha256_text(f"issue\0{run_id}")
    slice_sha = sha256_text(f"slice\0{run_id}")

    with sqlite3.connect(database, timeout=30) as connection:
        connection.execute("PRAGMA busy_timeout=30000")
        connection.execute("BEGIN IMMEDIATE")
        connection.execute(
            "INSERT INTO article_branches (id,article_id,name,slug,color,status,head_revision_id,base_revision_id,base_source_version_id,created_at,updated_at) "
            "VALUES (?,?,?,?,?,'active',?,?,NULL,?,?)",
            (ids["branch"], ids["article"], "MCP auth", ids["branch"], "cyan", ids["revision"], ids["revision"], now, now),
        )
        connection.execute(
            "INSERT INTO article_project_packages (id,project_id,article_id,title,schema_version,main_composition_id,main_composition_sha256,status,lock_version,created_at,updated_at,primary_branch_id,branch_model_version) "
            "VALUES (?,NULL,?,?,'wenmai-package-v1',?,?,'active',1,?,?,?,2)",
            (ids["package"], ids["article"], "MCP auth package", ids["composition"], composition_sha, now, now, ids["branch"]),
        )
        connection.execute(
            "INSERT INTO package_compositions (id,package_id,parent_composition_id,title,schema_version,root_module_id,document_json,document_sha256,manifest_json,composition_sha256,source_article_revision_id,author_kind,source_patch_id,created_at) "
            "VALUES (?,?,NULL,?,'wenmai-composition-v1',?,?,?,?,?,?,'system',NULL,?)",
            (ids["composition"], ids["package"], "MCP auth composition", ids["module"], document_json, document_sha, canonical_json({"nodes": [], "edges": []}), composition_sha, ids["revision"], now),
        )
        connection.execute(
            "INSERT INTO package_branch_states (package_id,branch_id,head_composition_id,head_composition_sha256,head_revision_id,status,lock_version,created_at,updated_at) "
            "VALUES (?,?,?,?,?,'active',1,?,?)",
            (ids["package"], ids["branch"], ids["composition"], composition_sha, ids["revision"], now, now),
        )
        connection.execute(
            "INSERT INTO package_branch_working_copies (package_id,branch_id,base_composition_id,base_revision_id,document_json,document_sha256,dirty,lock_version,updated_at) "
            "VALUES (?,?,?,?,?,?,0,1,?)",
            (ids["package"], ids["branch"], ids["composition"], ids["revision"], document_json, document_sha, now),
        )
        connection.execute(
            "INSERT INTO package_branch_composition_commits (id,package_id,branch_id,parent_composition_id,composition_id,composition_sha256,previous_revision_id,article_revision_id,source_kind,source_patch_id,created_by_kind,created_at) "
            "VALUES (?,?,?,NULL,?,?,NULL,?,'system',NULL,'system',?)",
            (ids["commit"], ids["package"], ids["branch"], ids["composition"], composition_sha, ids["revision"], now),
        )
        connection.execute(
            "INSERT INTO package_branch_migration_audits (package_id,state,reason_code,detail_json,source_schema_version,created_at,updated_at) "
            "VALUES (?,'migrated_clean','',?,'0010',?,?)",
            (ids["package"], canonical_json({"probe": True}), now, now),
        )
        connection.execute(
            "INSERT INTO package_diagnosis_runs (id,package_id,composition_id,composition_sha256,algorithm_version,result,issue_count,error_count,warning_count,input_sha256,summary_sha256,created_at,branch_id,base_revision_id,base_branch_lock_version) "
            "VALUES (?,?,?,?,'probe/1','fail',1,0,1,?,?,?,?,?,1)",
            (ids["diagnosis"], ids["package"], ids["composition"], composition_sha, diagnosis_input_sha, summary_sha, now, ids["branch"], ids["revision"]),
        )
        connection.execute(
            "INSERT INTO package_diagnostic_issues (id,diagnosis_run_id,package_id,composition_id,module_id,node_id,edge_id,code,severity,title,message,evidence_json,suggested_patch_json,issue_sha256,created_at,branch_id) "
            "VALUES (?,?,?,?,NULL,NULL,NULL,'PROBE','warning','Probe issue','Probe only','[]','[]',?,?,?)",
            (ids["issue"], ids["diagnosis"], ids["package"], ids["composition"], issue_sha, now, ids["branch"]),
        )
        connection.execute(
            "INSERT INTO package_slices (id,package_id,composition_id,composition_sha256,title,slice_kind,selector_json,resolved_manifest_json,slice_sha256,created_by_kind,created_at,branch_id,base_revision_id,base_branch_lock_version) "
            "VALUES (?,?,?,?,'Probe demo','demo',?,?,?,'system',?,?,?,1)",
            (ids["slice"], ids["package"], ids["composition"], composition_sha, canonical_json({"moduleKeys": ["body"]}), canonical_json({"moduleKeys": ["body"]}), slice_sha, now, ids["branch"], ids["revision"]),
        )
        for client_id, token, scopes, article_id in (
            (ids["client"], ids["token"], ["package.read"], ids["article"]),
            (ids["deniedClient"], ids["deniedToken"], ["package.read"], ids["deniedArticle"]),
            (ids["noScopeClient"], ids["noScopeToken"], ["task.read"], ids["article"]),
        ):
            connection.execute(
                "INSERT INTO agent_clients (id,label,client_kind,token_sha256,scopes_json,article_ids_json,task_ids_json,status,expires_at,last_seen_at,created_at,revoked_at) "
                "VALUES (?,?,'mcp',?,?,?,'[]','active',?,NULL,?,NULL)",
                (client_id, "MCP auth probe", sha256_text(token), canonical_json(scopes), canonical_json([article_id]), expires, now),
            )
        connection.commit()
    return ids


def cleanup(database: Path, ids: dict[str, str]) -> None:
    for attempt in range(8):
        try:
            with sqlite3.connect(database, timeout=30) as connection:
                connection.execute("PRAGMA busy_timeout=30000")
                connection.execute("BEGIN IMMEDIATE")
                connection.execute("DELETE FROM package_diagnostic_issues WHERE id = ?", (ids["issue"],))
                connection.execute("DELETE FROM package_diagnosis_runs WHERE id = ?", (ids["diagnosis"],))
                connection.execute("DELETE FROM package_slices WHERE id = ?", (ids["slice"],))
                connection.execute("DELETE FROM package_branch_composition_commits WHERE id = ?", (ids["commit"],))
                connection.execute("DELETE FROM package_branch_working_copies WHERE package_id = ?", (ids["package"],))
                connection.execute("DELETE FROM package_branch_states WHERE package_id = ?", (ids["package"],))
                connection.execute("DELETE FROM package_branch_migration_audits WHERE package_id = ?", (ids["package"],))
                connection.execute("DELETE FROM package_compositions WHERE id = ?", (ids["composition"],))
                connection.execute("DELETE FROM article_project_packages WHERE id = ?", (ids["package"],))
                connection.execute("DELETE FROM article_branches WHERE id = ?", (ids["branch"],))
                connection.execute("DELETE FROM agent_clients WHERE id IN (?,?,?)", (ids["client"], ids["deniedClient"], ids["noScopeClient"]))
                connection.commit()
            return
        except sqlite3.OperationalError:
            if attempt == 7:
                raise
            time.sleep(0.25 * (attempt + 1))


def mcp_call(root: Path, base_url: str, token: str, ids: dict[str, str]) -> dict[str, Any]:
    requests = [
        {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "live-probe", "version": "1"}}},
        {"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {"name": "wenmai_list_article_projects", "arguments": {}}},
        {"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": "wenmai_list_project_branches", "arguments": {"packageId": ids["package"]}}},
        {"jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": {"name": "wenmai_get_article_project", "arguments": {"packageId": ids["package"], "branchId": ids["branch"]}}},
        {"jsonrpc": "2.0", "id": 5, "method": "tools/call", "params": {"name": "wenmai_get_project_diagnostics", "arguments": {"packageId": ids["package"], "branchId": ids["branch"]}}},
        {"jsonrpc": "2.0", "id": 6, "method": "tools/call", "params": {"name": "wenmai_get_project_slices", "arguments": {"packageId": ids["package"], "branchId": ids["branch"]}}},
        {"jsonrpc": "2.0", "id": 7, "method": "resources/read", "params": {"uri": "wenmai://article-project/manifest"}},
    ]
    env = dict(os.environ)
    env["WENMAI_AGENT_TOKEN"] = token
    process = subprocess.run(
        [sys.executable, "-B", str(root / "scripts" / "wenmai_mcp_server.py"), "--base-url", base_url],
        input="".join(canonical_json(request) + "\n" for request in requests),
        text=True,
        encoding="utf-8",
        capture_output=True,
        cwd=root,
        env=env,
        timeout=45,
        check=False,
    )
    if process.returncode != 0:
        raise ProbeFailure(f"MCP process failed: {process.returncode} {process.stderr[-2000:]}")
    responses = [json.loads(line) for line in process.stdout.splitlines() if line.strip()]
    by_id = {response.get("id"): response for response in responses}
    if set(by_id) != set(range(1, 8)):
        raise ProbeFailure(f"MCP response IDs mismatch: {sorted(by_id)} stderr={process.stderr[-1000:]}")
    for request_id in range(2, 7):
        result = by_id[request_id].get("result", {})
        if result.get("isError") is not False:
            raise ProbeFailure(f"MCP tool {request_id} failed: {canonical_json(by_id[request_id])}")
    listed = by_id[2]["result"]["structuredContent"]["packages"]
    branches = by_id[3]["result"]["structuredContent"]["branches"]
    project = by_id[4]["result"]["structuredContent"]
    diagnostics = by_id[5]["result"]["structuredContent"]
    slices = by_id[6]["result"]["structuredContent"]
    resource_text = by_id[7]["result"]["contents"][0]["text"]
    if [item["id"] for item in listed] != [ids["package"]]:
        raise ProbeFailure("MCP project list escaped or missed the article boundary")
    if [item["branchId"] for item in branches] != [ids["branch"]]:
        raise ProbeFailure("MCP branch discovery did not return the attached branch")
    if project.get("selectedBranchId") != ids["branch"]:
        raise ProbeFailure("MCP project detail was not branch-qualified")
    if diagnostics.get("diagnosisRuns", [{}])[0].get("id") != ids["diagnosis"]:
        raise ProbeFailure("MCP diagnostics did not preserve branch selection")
    if slices.get("slices", [{}])[0].get("id") != ids["slice"]:
        raise ProbeFailure("MCP slices did not preserve branch selection")
    if json.loads(resource_text).get("requiredScope") != "package.read":
        raise ProbeFailure("MCP Package resource did not use the Bearer project manifest")
    return {"tools": 5, "resource": True, "stderr": process.stderr.strip()}


def run_probe(base_url: str, root: Path, keep: bool) -> dict[str, Any]:
    database = find_database(root)
    run_id = uuid.uuid4().hex[:12]
    ids = insert_fixture(database, run_id)
    try:
        expect_error(
            request_json(base_url, f"/api/project-package/v1?view=package&packageId={ids['package']}&branchId={ids['branch']}"),
            401, "MANAGEMENT_AUTH_REQUIRED", "management Package route without browser session",
        )
        expect_error(
            request_json(base_url, f"/api/agent/v1?view=project_package&packageId={ids['package']}&branchId={ids['branch']}"),
            401, "AUTH_REQUIRED", "Bearer-only Agent project view without token",
        )
        expect_error(
            request_json(base_url, f"/api/agent/v1?view=project_package&packageId={ids['package']}&branchId={ids['branch']}", token=ids["noScopeToken"]),
            403, "SCOPE_DENIED", "Agent project view without package.read",
        )
        expect_error(
            request_json(base_url, f"/api/agent/v1?view=project_package&packageId={ids['package']}&branchId={ids['branch']}", token=ids["deniedToken"]),
            404, "PACKAGE_NOT_FOUND", "cross-article Package read",
        )
        data = expect_ok(
            request_json(base_url, f"/api/agent/v1?view=project_package&packageId={ids['package']}&branchId={ids['branch']}", token=ids["token"]),
            "authorized Agent Package read",
        )
        if data.get("boundary", {}).get("articleId") != ids["article"] or data.get("selectedBranchId") != ids["branch"]:
            raise ProbeFailure("authorized Agent Package read returned the wrong object boundary")
        mcp = mcp_call(root, base_url, ids["token"], ids)
        return {
            "ok": True,
            "database": str(database),
            "packageId": ids["package"],
            "branchId": ids["branch"],
            "checks": {
                "managementRouteStayedProtected": True,
                "projectViewsRequireBearer": True,
                "packageReadScopeRequired": True,
                "crossArticleReadReturned404": True,
                "mcpUsedAgentProjectViews": True,
                "mcpBranchQualified": True,
                "mcp": mcp,
            },
        }
    finally:
        if not keep:
            cleanup(database, ids)
            with sqlite3.connect(database) as connection:
                remaining = connection.execute("SELECT COUNT(*) FROM agent_clients WHERE id LIKE ?", (f"mcp-auth-%-{run_id}",)).fetchone()[0]
                if remaining != 0:
                    raise ProbeFailure(f"probe cleanup left {remaining} Agent clients")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-url", default="http://[::1]:3000")
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--keep", action="store_true")
    args = parser.parse_args()
    print(canonical_json(run_probe(args.base_url.rstrip("/"), args.root.resolve(), args.keep)))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
