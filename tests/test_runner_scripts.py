from __future__ import annotations

import hashlib
import json
import os
import subprocess
import sys
import tempfile
import threading
import unittest
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any


PROJECT_ROOT = Path(__file__).resolve().parents[1]
TEXT_GATE = PROJECT_ROOT / "scripts" / "runner_text_gate.py"
FACTORY_RUNNER = PROJECT_ROOT / "scripts" / "factory_runner.py"
RUNNER_TOKEN = "secret-runner-token-for-test"
LEASE_TOKEN = "secret-lease-token-for-test"


def sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def passing_input() -> dict[str, Any]:
    short_sentences = "。".join(["这是一个清楚的短句"] * 8) + "。"
    body = "# 先把问题说清楚\n\n" + short_sentences + "\n\n" + ("这一段补足证据和边界。" * 90)
    return {
        "runnerAction": "text-gates",
        "articleId": "article-test-1",
        "branchId": "branch-test-1",
        "baseRevisionId": "revision-test-1",
        "title": "为什么一篇文章需要可验证的门禁",
        "bodyText": body,
        "bodySha256": sha256_text(body),
    }


def gate_envelope(payload: dict[str, Any]) -> dict[str, Any]:
    return {
        "schemaVersion": "wenmai.runner-input/1.0",
        "action": "text-gates",
        "inputSha256": sha256_text(canonical_json(payload)),
        "input": payload,
    }


class MockRunnerState:
    def __init__(
        self,
        runner_action: str = "text-gates",
        stale_body_digest: bool = False,
        step_id: str | None = None,
    ) -> None:
        self.runner_action = runner_action
        self.stale_body_digest = stale_body_digest
        self.step_id = step_id or f"agent-step-test-{uuid.uuid4()}"
        self.agent_run_id = f"agent-run-{uuid.uuid4()}"
        self.actions: list[str] = []
        self.lease_payloads: list[dict[str, Any]] = []
        self.heartbeat_sequences: list[int] = []
        self.fail_command_ids: list[str] = []
        self.completed_payload: dict[str, Any] | None = None
        self.lock = threading.Lock()

    def record(self, action: str) -> None:
        with self.lock:
            self.actions.append(action)


def handler_for(state: MockRunnerState):
    frozen_input = passing_input()
    if state.stale_body_digest:
        frozen_input["bodySha256"] = "0" * 64
    input_digest = sha256_text(canonical_json(frozen_input))

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, _format: str, *_args: Any) -> None:
            return

        def send_json(self, status: int, payload: dict[str, Any]) -> None:
            encoded = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(encoded)))
            self.end_headers()
            self.wfile.write(encoded)

        def do_POST(self) -> None:  # noqa: N802 - stdlib handler contract
            if self.path != "/api/runner":
                self.send_json(404, {"error": "not found"})
                return
            length = int(self.headers.get("content-length", "0"))
            try:
                payload = json.loads(self.rfile.read(length).decode("utf-8"))
            except (UnicodeError, json.JSONDecodeError):
                self.send_json(400, {"error": "invalid JSON"})
                return
            action = payload.get("action")
            state.record(str(action))

            if action == "issue_runner_token":
                if self.headers.get("x-wenmai-runner-token") is not None:
                    self.send_json(400, {"error": "issue must not carry a token"})
                    return
                self.send_json(201, {
                    "runnerId": "runner-test-1",
                    "token": RUNNER_TOKEN,
                    "capabilities": ["text-gates"],
                    "shownOnce": True,
                })
                return

            if action == "revoke_runner":
                self.send_json(200, {"runnerId": "runner-test-1", "status": "revoked"})
                return

            if self.headers.get("x-wenmai-runner-token") != RUNNER_TOKEN:
                self.send_json(401, {"error": "bad runner token"})
                return

            if action == "runner_lease":
                with state.lock:
                    state.lease_payloads.append(dict(payload))
                expected_agent_run_id = payload.get("expectedAgentRunId")
                if expected_agent_run_id is not None and expected_agent_run_id != state.agent_run_id:
                    self.send_json(200, {"recoveredAttempts": 0, "job": None})
                    return
                self.send_json(200, {
                    "recoveredAttempts": 0,
                    "lease": {
                        "id": "lease-test-1",
                        "token": LEASE_TOKEN,
                        "expiresAt": "2099-01-01T00:00:00.000Z",
                        "heartbeatSeconds": 1,
                    },
                    "job": {
                        "stepId": state.step_id,
                        "agentRunId": state.agent_run_id,
                        "attempt": 1,
                        "runnerAction": state.runner_action,
                        "inputSha256": input_digest,
                        "input": frozen_input,
                    },
                })
                return

            if payload.get("leaseToken") != LEASE_TOKEN:
                self.send_json(409, {"error": "bad lease token"})
                return

            if action == "runner_heartbeat":
                heartbeat_seq = payload.get("heartbeatSeq")
                if not isinstance(heartbeat_seq, int) or heartbeat_seq < 1:
                    self.send_json(409, {"error": "bad heartbeat sequence"})
                    return
                with state.lock:
                    if state.heartbeat_sequences and heartbeat_seq <= state.heartbeat_sequences[-1]:
                        self.send_json(409, {"error": "heartbeat sequence did not increase"})
                        return
                    state.heartbeat_sequences.append(heartbeat_seq)
                self.send_json(200, {
                    "stepId": state.step_id,
                    "state": "running",
                    "expiresAt": "2099-01-01T00:00:00.000Z",
                })
                return

            if action == "runner_complete":
                output_text = payload.get("outputText")
                if not isinstance(output_text, str) or sha256_text(output_text) != payload.get("outputSha256"):
                    self.send_json(409, {"error": "bad output digest"})
                    return
                output = json.loads(output_text)
                if (
                    output.get("schemaVersion") != "wenmai.text-gates/1.0"
                    or output.get("action") != "text-gates"
                    or output.get("inputSha256") != input_digest
                ):
                    self.send_json(409, {"error": "bad output binding"})
                    return
                expected_ref = f".runner/artifacts/{state.step_id}-attempt-1.json"
                if payload.get("contentRef") != expected_ref:
                    self.send_json(409, {"error": "bad project-local content reference"})
                    return
                state.completed_payload = payload
                self.send_json(200, {
                    "stepId": state.step_id,
                    "agentRunId": state.agent_run_id,
                    "state": "succeeded",
                    "runState": "succeeded",
                    "artifactId": "agent-artifact-test-1",
                    "outputSha256": payload["outputSha256"],
                    "inputStillCurrent": True,
                })
                return

            if action == "runner_fail":
                command_id = payload.get("commandId")
                if not isinstance(command_id, str) or not command_id.startswith("runner-fail:"):
                    self.send_json(409, {"error": "missing stable fail command ID"})
                    return
                with state.lock:
                    state.fail_command_ids.append(command_id)
                self.send_json(200, {
                    "stepId": state.step_id,
                    "state": "failed",
                    "errorClass": payload.get("errorClass"),
                })
                return

            self.send_json(400, {"error": "unexpected action"})

    return Handler


class RunnerScriptTests(unittest.TestCase):
    maxDiff = 4_000

    def run_gate(self, input_payload: dict[str, Any], output_path: Path) -> subprocess.CompletedProcess[str]:
        input_path = output_path.with_name(output_path.stem + ".input.json")
        input_path.write_text(json.dumps(input_payload, ensure_ascii=False), encoding="utf-8")
        return subprocess.run(
            [sys.executable, "-B", str(TEXT_GATE), "--input", str(input_path), "--output", str(output_path)],
            cwd=PROJECT_ROOT,
            capture_output=True,
            text=True,
            encoding="utf-8",
            timeout=10,
            check=False,
        )

    def test_text_gate_output_is_canonical_and_deterministic(self) -> None:
        with tempfile.TemporaryDirectory(prefix="wenmai-runner-test-") as directory:
            root = Path(directory)
            first = root / "first.json"
            second = root / "second.json"
            payload = passing_input()
            envelope = gate_envelope(payload)
            first_run = self.run_gate(envelope, first)
            second_run = self.run_gate(envelope, second)
            self.assertEqual(first_run.returncode, 0, first_run.stderr)
            self.assertEqual(second_run.returncode, 0, second_run.stderr)
            self.assertEqual(first.read_bytes(), second.read_bytes())
            output = json.loads(first.read_text(encoding="utf-8"))
            self.assertEqual(output["schemaVersion"], "wenmai.text-gates/1.0")
            self.assertEqual(output["action"], "text-gates")
            self.assertEqual(output["inputSha256"], envelope["inputSha256"])
            self.assertEqual(output["bodySha256"], payload["bodySha256"])
            self.assertEqual(output["result"], "pass")
            self.assertEqual(output["summary"], {"fail": 0, "inconclusive": 0, "pass": 4, "total": 4})
            self.assertEqual([gate["gateId"] for gate in output["gates"]], [
                "builtin:title-v1",
                "builtin:structure-v1",
                "builtin:long-sentence-v1",
                "builtin:placeholder-v1",
            ])
            self.assertEqual(output["gates"][0]["gateLabel"], "标题长度")

    def test_text_gate_rejects_a_stale_body_digest(self) -> None:
        with tempfile.TemporaryDirectory(prefix="wenmai-runner-test-") as directory:
            output = Path(directory) / "output.json"
            payload = passing_input()
            payload["bodySha256"] = "0" * 64
            result = self.run_gate(gate_envelope(payload), output)
            self.assertEqual(result.returncode, 2)
            self.assertFalse(output.exists())
            self.assertIn("bodySha256 does not match bodyText", result.stderr)

    def test_text_gate_aggregate_result_uses_fail_then_inconclusive_precedence(self) -> None:
        with tempfile.TemporaryDirectory(prefix="wenmai-runner-test-") as directory:
            root = Path(directory)
            inconclusive_payload = passing_input()
            inconclusive_payload["bodyText"] = "第一句。第二句。第三句。第四句。"
            inconclusive_payload["bodySha256"] = sha256_text(inconclusive_payload["bodyText"])
            inconclusive_output = root / "inconclusive.json"
            inconclusive_run = self.run_gate(gate_envelope(inconclusive_payload), inconclusive_output)
            self.assertEqual(inconclusive_run.returncode, 0, inconclusive_run.stderr)
            self.assertEqual(json.loads(inconclusive_output.read_text(encoding="utf-8"))["result"], "inconclusive")

            failed_payload = dict(inconclusive_payload)
            failed_payload["bodyText"] += "TODO"
            failed_payload["bodySha256"] = sha256_text(failed_payload["bodyText"])
            failed_output = root / "failed.json"
            failed_run = self.run_gate(gate_envelope(failed_payload), failed_output)
            self.assertEqual(failed_run.returncode, 0, failed_run.stderr)
            failed = json.loads(failed_output.read_text(encoding="utf-8"))
            self.assertEqual(failed["result"], "fail")
            self.assertEqual(failed["summary"], {"fail": 1, "inconclusive": 1, "pass": 2, "total": 4})

    def run_factory(
        self,
        state: MockRunnerState,
        expected_agent_run_id: str | None = None,
    ) -> subprocess.CompletedProcess[str]:
        server = ThreadingHTTPServer(("127.0.0.1", 0), handler_for(state))
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        environment = os.environ.copy()
        environment.pop("WENMAI_RUNNER_TOKEN", None)
        try:
            command = [
                sys.executable,
                "-B",
                str(FACTORY_RUNNER),
                "--base-url",
                f"http://127.0.0.1:{server.server_port}",
                "--issue",
                "--once",
            ]
            if expected_agent_run_id is not None:
                command.extend(["--expected-agent-run-id", expected_agent_run_id])
            return subprocess.run(
                command,
                cwd=PROJECT_ROOT,
                env=environment,
                capture_output=True,
                text=True,
                encoding="utf-8",
                timeout=20,
                check=False,
            )
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)

    def test_factory_runner_issues_token_heartbeats_and_completes_without_logging_secrets(self) -> None:
        state = MockRunnerState()
        artifact_path = PROJECT_ROOT / ".runner" / "artifacts" / f"{state.step_id}-attempt-1.json"
        try:
            result = self.run_factory(state)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertEqual(state.actions, [
                "issue_runner_token",
                "runner_lease",
                "runner_heartbeat",
                "runner_complete",
                "revoke_runner",
            ])
            self.assertEqual(state.lease_payloads, [{"action": "runner_lease", "runnerId": "runner-test-1"}])
            self.assertIsNotNone(state.completed_payload)
            self.assertEqual(state.heartbeat_sequences, [1])
            completed_text = str(state.completed_payload["outputText"])
            completed_output = json.loads(completed_text)
            self.assertEqual(completed_output["inputSha256"], sha256_text(canonical_json(passing_input())))
            self.assertTrue(str(state.completed_payload["commandId"]).startswith("runner-complete:"))
            self.assertEqual(artifact_path.read_text(encoding="utf-8"), completed_text)
            combined_logs = result.stdout + result.stderr
            self.assertNotIn(RUNNER_TOKEN, combined_logs)
            self.assertNotIn(LEASE_TOKEN, combined_logs)
            self.assertIn('"event": "runner.job.completed"', result.stdout)
            self.assertIn('"event": "runner.revoked"', result.stdout)
        finally:
            artifact_path.unlink(missing_ok=True)
            for directory in (artifact_path.parent, artifact_path.parent.parent):
                try:
                    directory.rmdir()
                except OSError:
                    pass

    def test_factory_runner_sends_expected_agent_run_id_with_lease(self) -> None:
        state = MockRunnerState()
        artifact_path = PROJECT_ROOT / ".runner" / "artifacts" / f"{state.step_id}-attempt-1.json"
        try:
            result = self.run_factory(state, expected_agent_run_id=state.agent_run_id)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertEqual(len(state.lease_payloads), 1)
            self.assertEqual(state.lease_payloads[0], {
                "action": "runner_lease",
                "runnerId": "runner-test-1",
                "expectedAgentRunId": state.agent_run_id,
            })
            self.assertIsNotNone(state.completed_payload)
            self.assertIn(f'"expectedAgentRunId": "{state.agent_run_id}"', result.stdout)
        finally:
            artifact_path.unlink(missing_ok=True)
            for directory in (artifact_path.parent, artifact_path.parent.parent):
                try:
                    directory.rmdir()
                except OSError:
                    pass

    def test_factory_runner_refuses_non_allowlisted_action(self) -> None:
        state = MockRunnerState(runner_action="shell")
        result = self.run_factory(state)
        self.assertEqual(result.returncode, 1)
        self.assertEqual(state.actions, ["issue_runner_token", "runner_lease", "revoke_runner"])
        self.assertNotIn("runner_complete", state.actions)
        self.assertNotIn(RUNNER_TOKEN, result.stdout + result.stderr)
        self.assertNotIn(LEASE_TOKEN, result.stdout + result.stderr)
        self.assertIn("not allowlisted", result.stdout)

    def test_factory_runner_reports_a_stable_failure_command_id(self) -> None:
        step_id = f"agent-step-failure-{uuid.uuid4()}"
        first_state = MockRunnerState(stale_body_digest=True, step_id=step_id)
        second_state = MockRunnerState(stale_body_digest=True, step_id=step_id)
        first = self.run_factory(first_state)
        second = self.run_factory(second_state)
        self.assertEqual(first.returncode, 1)
        self.assertEqual(second.returncode, 1)
        self.assertEqual(first_state.actions, [
            "issue_runner_token",
            "runner_lease",
            "runner_heartbeat",
            "runner_fail",
            "revoke_runner",
        ])
        self.assertEqual(first_state.heartbeat_sequences, [1])
        self.assertEqual(len(first_state.fail_command_ids), 1)
        self.assertEqual(first_state.fail_command_ids, second_state.fail_command_ids)
        self.assertNotIn(RUNNER_TOKEN, first.stdout + first.stderr)
        self.assertNotIn(LEASE_TOKEN, first.stdout + first.stderr)


if __name__ == "__main__":
    unittest.main()
