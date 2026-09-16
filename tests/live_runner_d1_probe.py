#!/usr/bin/env python3
"""Exercise the real loopback Runner API and local D1, then remove only QA rows."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sqlite3
import subprocess
import sys
import uuid
from pathlib import Path
from typing import Any
from urllib.request import ProxyHandler, Request, build_opener


SAFE_STEP_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$")


def sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def api_post(base_url: str, payload: dict[str, Any], token: str | None = None) -> dict[str, Any]:
    headers = {"content-type": "application/json", "origin": base_url}
    if token:
        headers["x-wenmai-runner-token"] = token
    request = Request(
        f"{base_url}/api/runner",
        data=json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8"),
        headers=headers,
        method="POST",
    )
    with build_opener(ProxyHandler({})).open(request, timeout=15) as response:
        body = response.read(1_048_577)
        if len(body) > 1_048_576:
            raise RuntimeError("Runner API response exceeded probe limit")
        return json.loads(body.decode("utf-8"))


def api_get(base_url: str, article_id: str) -> dict[str, Any]:
    request = Request(f"{base_url}/api/runner?articleId={article_id}", method="GET")
    with build_opener(ProxyHandler({})).open(request, timeout=15) as response:
        return json.loads(response.read(1_048_576).decode("utf-8"))


def insert_fixture(database_path: Path, ids: dict[str, str], body: str) -> None:
    digest = sha256_text(body)
    with sqlite3.connect(database_path, timeout=20) as connection:
        connection.execute("PRAGMA busy_timeout = 20000")
        connection.execute("BEGIN IMMEDIATE")
        connection.execute(
            "INSERT INTO article_branches (id, article_id, name, slug, head_revision_id, base_revision_id) VALUES (?, ?, 'Runner QA', ?, ?, ?)",
            (ids["branch"], ids["article"], ids["suffix"], ids["revision"], ids["revision"]),
        )
        connection.execute(
            "INSERT INTO article_revisions (id, article_id, branch_id, sequence, title, document_title, body_text, body_sha256) VALUES (?, ?, ?, 1, 'Runner QA', 'Runner QA', ?, ?)",
            (ids["revision"], ids["article"], ids["branch"], body, digest),
        )
        connection.execute(
            "INSERT INTO branch_working_copies (branch_id, article_id, base_revision_id, title, body_text, body_sha256, dirty, lock_version) VALUES (?, ?, ?, 'Runner QA', ?, ?, 0, 1)",
            (ids["branch"], ids["article"], ids["revision"], body, digest),
        )
        connection.execute(
            "INSERT INTO production_runs (id, recipe_id, recipe_version, recipe_sha256, article_id, branch_id, title, status, current_step_id) VALUES (?, 'standard-longform-v1', '1.0.0', ?, ?, ?, 'Runner QA', 'active', 'machine-gates')",
            (ids["production_run"], sha256_text("runner-qa-recipe"), ids["article"], ids["branch"]),
        )
        connection.execute(
            "INSERT INTO production_run_steps (id, run_id, step_id, position, title, actor_kind, depends_on_json, write_scope, runner_action, status) VALUES (?, ?, 'machine-gates', 0, 'Runner QA text gates', 'script', '[]', 'artifact-only', 'text-gates', 'active')",
            (ids["production_step_row"], ids["production_run"]),
        )
        connection.commit()


def artifact_files(project_root: Path, step_ids: set[str]) -> set[Path]:
    artifacts_directory = project_root / ".runner" / "artifacts"
    files: set[Path] = set()
    if not artifacts_directory.is_dir():
        return files
    for step_id in step_ids:
        if not SAFE_STEP_ID_RE.fullmatch(step_id):
            raise RuntimeError(f"unsafe tracked AgentStep ID: {step_id!r}")
        files.update(artifacts_directory.glob(f"{step_id}-attempt-*.json"))
        files.update(artifacts_directory.glob(f".{step_id}-attempt-*.json.*.tmp"))
    return files


def cleanup(
    database_path: Path,
    ids: dict[str, str],
    runner_id: str | None,
    project_root: Path,
    tracked_step_ids: set[str],
) -> None:
    database_error: Exception | None = None
    try:
        with sqlite3.connect(database_path, timeout=20) as connection:
            connection.execute("PRAGMA busy_timeout = 20000")
            connection.execute("BEGIN IMMEDIATE")
            run_ids = [row[0] for row in connection.execute("SELECT id FROM agent_runs WHERE article_id = ?", (ids["article"],))]
            if ids.get("agent_run"):
                run_ids.append(ids["agent_run"])
            run_ids = sorted(set(run_ids))
            if run_ids:
                placeholders = ",".join("?" for _ in run_ids)
                tracked_step_ids.update(
                    str(row[0])
                    for row in connection.execute(f"SELECT id FROM agent_steps WHERE agent_run_id IN ({placeholders})", run_ids)
                )
            step_ids = sorted(tracked_step_ids)
            if step_ids:
                placeholders = ",".join("?" for _ in step_ids)
                connection.execute(f"DELETE FROM agent_artifacts WHERE agent_step_id IN ({placeholders})", step_ids)
                connection.execute(f"DELETE FROM runner_leases WHERE agent_step_id IN ({placeholders})", step_ids)
                connection.execute(f"DELETE FROM agent_steps WHERE id IN ({placeholders})", step_ids)
            if run_ids:
                placeholders = ",".join("?" for _ in run_ids)
                connection.execute(f"DELETE FROM agent_runs WHERE id IN ({placeholders})", run_ids)
            if runner_id:
                connection.execute("DELETE FROM command_receipts WHERE actor_id = ?", (runner_id,))
                connection.execute("DELETE FROM runner_registry WHERE id = ?", (runner_id,))
            connection.execute("DELETE FROM workspace_events WHERE article_id = ?", (ids["article"],))
            connection.execute("DELETE FROM production_run_steps WHERE run_id = ?", (ids["production_run"],))
            connection.execute("DELETE FROM production_runs WHERE id = ?", (ids["production_run"],))
            connection.execute("DELETE FROM branch_working_copies WHERE branch_id = ?", (ids["branch"],))
            connection.execute("DELETE FROM article_revisions WHERE id = ?", (ids["revision"],))
            connection.execute("DELETE FROM article_branches WHERE id = ?", (ids["branch"],))
            connection.commit()
    except Exception as exc:  # File cleanup must still run after a D1 cleanup failure.
        database_error = exc
    finally:
        for path in artifact_files(project_root, tracked_step_ids):
            path.unlink(missing_ok=True)
        artifacts_directory = project_root / ".runner" / "artifacts"
        runner_directory = artifacts_directory.parent
        if artifacts_directory.is_dir() and not any(artifacts_directory.iterdir()):
            artifacts_directory.rmdir()
        if runner_directory.is_dir() and not any(runner_directory.iterdir()):
            runner_directory.rmdir()
    if database_error is not None:
        raise database_error


def assert_cleanup(
    database_path: Path,
    ids: dict[str, str],
    runner_id: str | None,
    project_root: Path,
    tracked_step_ids: set[str],
) -> None:
    residue: dict[str, int] = {}
    with sqlite3.connect(database_path, timeout=20) as connection:
        connection.execute("PRAGMA busy_timeout = 20000")
        checks = {
            "agent_runs": ("SELECT COUNT(*) FROM agent_runs WHERE article_id = ?", (ids["article"],)),
            "production_runs": ("SELECT COUNT(*) FROM production_runs WHERE id = ?", (ids["production_run"],)),
            "production_run_steps": ("SELECT COUNT(*) FROM production_run_steps WHERE run_id = ?", (ids["production_run"],)),
            "workspace_events": ("SELECT COUNT(*) FROM workspace_events WHERE article_id = ?", (ids["article"],)),
            "branch_working_copies": ("SELECT COUNT(*) FROM branch_working_copies WHERE branch_id = ?", (ids["branch"],)),
            "article_revisions": ("SELECT COUNT(*) FROM article_revisions WHERE id = ?", (ids["revision"],)),
            "article_branches": ("SELECT COUNT(*) FROM article_branches WHERE id = ?", (ids["branch"],)),
        }
        if runner_id:
            checks["runner_registry"] = ("SELECT COUNT(*) FROM runner_registry WHERE id = ?", (runner_id,))
            checks["command_receipts"] = ("SELECT COUNT(*) FROM command_receipts WHERE actor_id = ?", (runner_id,))
        for table, (statement, bindings) in checks.items():
            count = int(connection.execute(statement, bindings).fetchone()[0])
            if count:
                residue[table] = count
        if tracked_step_ids:
            step_ids = sorted(tracked_step_ids)
            placeholders = ",".join("?" for _ in step_ids)
            for table, column in [("agent_steps", "id"), ("agent_artifacts", "agent_step_id"), ("runner_leases", "agent_step_id")]:
                count = int(connection.execute(f"SELECT COUNT(*) FROM {table} WHERE {column} IN ({placeholders})", step_ids).fetchone()[0])
                if count:
                    residue[table] = count
    files = sorted(str(path) for path in artifact_files(project_root, tracked_step_ids))
    if files:
        residue["artifact_files"] = len(files)
    if residue:
        raise RuntimeError(f"Runner QA cleanup left residue: {residue}; files={files}")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-url", default="http://[::1]:3000")
    parser.add_argument("--database", type=Path, required=True)
    parser.add_argument("--python", type=Path, default=Path(sys.executable))
    args = parser.parse_args()
    project_root = Path(__file__).resolve().parent.parent
    suffix = uuid.uuid4().hex
    ids = {
        "suffix": suffix,
        "article": f"__runner_qa__{suffix}",
        "branch": f"qa-branch-{suffix}",
        "revision": f"qa-revision-{suffix}",
        "production_run": f"qa-production-{suffix}",
        "production_step_row": f"qa-production-step-{suffix}",
    }
    runner_id: str | None = None
    tracked_step_ids: set[str] = set()
    result: dict[str, Any] | None = None
    body = "# Runner QA\n\n" + "这是用于真实 D1 与本地执行器闭环验证的临时正文。" * 90 + "\n\n## 结论\n\n验证结束后只清理带本次随机标识的行。"
    try:
        insert_fixture(args.database.resolve(), ids, body)
        issued = api_post(args.base_url, {"action": "issue_runner_token", "label": "Runner D1 QA", "capabilities": ["text-gates"]})
        runner_id = str(issued["runnerId"])
        token = str(issued["token"])
        queued = api_post(args.base_url, {
            "action": "queue_agent_step",
            "productionRunId": ids["production_run"],
            "productionStepId": "machine-gates",
        })
        queued_agent_run_id = str(queued.get("agentRunId") or "")
        queued_agent_step_id = str(queued.get("agentStepId") or "")
        if not queued_agent_run_id or not SAFE_STEP_ID_RE.fullmatch(queued_agent_step_id):
            raise RuntimeError("queue_agent_step did not return stable AgentRun/AgentStep IDs")
        ids["agent_run"] = queued_agent_run_id
        tracked_step_ids.add(queued_agent_step_id)
        environment = {
            "PATH": os.environ.get("PATH", ""),
            "SYSTEMROOT": os.environ.get("SYSTEMROOT", ""),
            "WENMAI_RUNNER_TOKEN": token,
        }
        completed = subprocess.run(
            [str(args.python.resolve()), "-B", str(project_root / "scripts" / "factory_runner.py"),
             "--base-url", args.base_url, "--runner-id", runner_id,
             "--expected-agent-run-id", queued_agent_run_id, "--once"],
            cwd=project_root,
            env=environment,
            capture_output=True,
            text=True,
            encoding="utf-8",
            timeout=45,
            check=False,
        )
        if completed.returncode != 0:
            raise RuntimeError(f"factory runner failed: {completed.stderr[-2000:]}")
        if queued_agent_run_id not in completed.stdout:
            raise RuntimeError("factory runner log did not bind the expected AgentRun ID")
        snapshot = api_get(args.base_url, ids["article"])
        runs = snapshot.get("agentRuns", [])
        if len(runs) != 1 or runs[0].get("state") != "succeeded":
            raise RuntimeError(f"unexpected AgentRun state: {runs}")
        steps = runs[0].get("steps", [])
        tracked_step_ids.update(str(step.get("id")) for step in steps if step.get("id"))
        artifacts = steps[0].get("artifacts", []) if steps else []
        if (
            runs[0].get("id") != queued_agent_run_id
            or len(artifacts) != 1
            or steps[0].get("id") != queued_agent_step_id
            or steps[0].get("state") != "succeeded"
        ):
            raise RuntimeError("real Runner did not create exactly one immutable artifact")
        content_ref = str(artifacts[0]["contentRef"])
        artifact_path = project_root / Path(content_ref)
        if not artifact_path.is_file() or sha256_text(artifact_path.read_text(encoding="utf-8")) != artifacts[0]["sha256"]:
            raise RuntimeError("persisted Runner artifact does not match D1 evidence")
        with sqlite3.connect(args.database.resolve(), timeout=20) as connection:
            production_status = connection.execute(
                "SELECT status FROM production_run_steps WHERE run_id = ? AND step_id = 'machine-gates'",
                (ids["production_run"],),
            ).fetchone()
            event_count = connection.execute(
                "SELECT COUNT(*) FROM workspace_events WHERE article_id = ? AND event_type = 'agent_step.completed'",
                (ids["article"],),
            ).fetchone()[0]
        if production_status != ("complete",) or event_count != 1:
            raise RuntimeError("Runner completion did not atomically advance production evidence")
        result = {
            "ok": True,
            "queuedAgentRunId": queued_agent_run_id,
            "queuedAgentStepId": queued_agent_step_id,
            "runnerId": runner_id,
            "agentRunState": runs[0]["state"],
            "productionStep": production_status[0],
            "artifactSha256": artifacts[0]["sha256"],
            "eventCount": event_count,
        }
    finally:
        cleanup(args.database.resolve(), ids, runner_id, project_root, tracked_step_ids)
        assert_cleanup(args.database.resolve(), ids, runner_id, project_root, tracked_step_ids)
    if result is None:
        raise RuntimeError("Runner probe completed without a result")
    result["cleanupVerified"] = True
    result["trackedAgentStepIds"] = sorted(tracked_step_ids)
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
