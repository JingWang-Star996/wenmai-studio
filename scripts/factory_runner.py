#!/usr/bin/env python3
"""Lease and execute Wenmai's fixed local Runner actions over the loopback API."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit, urlunsplit
from urllib.request import ProxyHandler, Request, build_opener


SCRIPT_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = SCRIPT_DIR.parent
TEXT_GATE_SCRIPT = SCRIPT_DIR / "runner_text_gate.py"
ARTIFACT_DIRECTORY = PROJECT_ROOT / ".runner" / "artifacts"
TOKEN_ENVIRONMENT_VARIABLE = "WENMAI_RUNNER_TOKEN"
ALLOWLIST = {"text-gates": TEXT_GATE_SCRIPT}
GATE_INPUT_SCHEMA_VERSION = "wenmai.runner-input/1.0"
TEXT_GATE_OUTPUT_SCHEMA_VERSION = "wenmai.text-gates/1.0"
TEXT_GATE_ARTIFACT_TITLE = "确定性中文正文门禁"
JSON_MEDIA_TYPE = "application/json"
HTTP_TIMEOUT_SECONDS = 5.0
SUBPROCESS_TIMEOUT_SECONDS = 20.0
POLL_SECONDS = 2.0
MAX_HTTP_RESPONSE_BYTES = 1_048_576
MAX_CHILD_LOG_BYTES = 65_536
MAX_ARTIFACT_BYTES = 500_000
SHA256_RE = re.compile(r"^[a-f0-9]{64}$")
AGENT_RUN_ID_RE = re.compile(r"^agent-run-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
SAFE_FILENAME_SEGMENT_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$")
SENSITIVE_KEY_RE = re.compile(r"token|secret|authorization", re.IGNORECASE)


class RunnerError(RuntimeError):
    error_class = "runner_error"


class RunnerProtocolError(RunnerError):
    error_class = "protocol_error"


class GateProcessError(RunnerError):
    error_class = "gate_process_error"


@dataclass(frozen=True)
class RunnerIdentity:
    runner_id: str
    token: str
    issued_here: bool


@dataclass(frozen=True)
class LeaseJob:
    step_id: str
    agent_run_id: str
    attempt: int
    runner_action: str
    input_sha256: str
    input_payload: dict[str, Any]
    lease_id: str
    lease_token: str
    heartbeat_seconds: int


def sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def safe_message(value: Any, secrets: tuple[str, ...] = ()) -> str:
    message = str(value).replace("\r", " ").replace("\n", " ")[:1_000]
    for secret in secrets:
        if secret:
            message = message.replace(secret, "<redacted>")
    return message


def redact(value: Any) -> Any:
    if isinstance(value, dict):
        return {
            key: "<redacted>" if SENSITIVE_KEY_RE.search(str(key)) else redact(child)
            for key, child in value.items()
        }
    if isinstance(value, list):
        return [redact(child) for child in value]
    return value


def log_event(event: str, **fields: Any) -> None:
    print(json.dumps(redact({"event": event, **fields}), ensure_ascii=False, sort_keys=True), flush=True)


def required_string(payload: dict[str, Any], name: str, maximum: int) -> str:
    value = payload.get(name)
    if not isinstance(value, str) or not value.strip():
        raise RunnerProtocolError(f"response field {name!r} must be a non-empty string")
    value = value.strip()
    if len(value) > maximum:
        raise RunnerProtocolError(f"response field {name!r} exceeds {maximum} characters")
    return value


def required_sha256(payload: dict[str, Any], name: str) -> str:
    value = payload.get(name)
    if not isinstance(value, str) or not SHA256_RE.fullmatch(value):
        raise RunnerProtocolError(f"response field {name!r} must be a lowercase SHA-256 digest")
    return value


def expected_agent_run_id(value: str | None) -> str | None:
    if value is None:
        return None
    candidate = value.strip()
    if not AGENT_RUN_ID_RE.fullmatch(candidate):
        raise RunnerProtocolError("--expected-agent-run-id must be a strict AgentRun ID")
    return candidate


def loopback_runner_url(base_url: str) -> str:
    parsed = urlsplit(base_url)
    if parsed.scheme not in {"http", "https"}:
        raise RunnerProtocolError("base URL must use http or https")
    if parsed.username or parsed.password:
        raise RunnerProtocolError("base URL must not contain credentials")
    if parsed.hostname not in {"127.0.0.1", "::1"}:
        raise RunnerProtocolError("base URL must use a loopback IP literal")
    if parsed.query or parsed.fragment or parsed.path not in {"", "/"}:
        raise RunnerProtocolError("base URL must be an origin without path, query, or fragment")
    origin = urlunsplit((parsed.scheme, parsed.netloc, "", "", "")).rstrip("/")
    return f"{origin}/api/runner"


class RunnerApiClient:
    def __init__(self, base_url: str) -> None:
        self.url = loopback_runner_url(base_url)
        parsed = urlsplit(self.url)
        self.origin = urlunsplit((parsed.scheme, parsed.netloc, "", "", "")).rstrip("/")
        self.opener = build_opener(ProxyHandler({}))

    def post(self, payload: dict[str, Any], token: str | None = None) -> dict[str, Any]:
        body = canonical_json(payload).encode("utf-8")
        headers = {
            "Content-Type": "application/json",
            "Accept": "application/json",
            "Origin": self.origin,
            "User-Agent": "wenmai-local-runner/1.0",
        }
        if token is not None:
            headers["x-wenmai-runner-token"] = token
        request = Request(self.url, data=body, headers=headers, method="POST")
        try:
            with self.opener.open(request, timeout=HTTP_TIMEOUT_SECONDS) as response:
                raw = response.read(MAX_HTTP_RESPONSE_BYTES + 1)
        except HTTPError as exc:
            raw = exc.read(MAX_HTTP_RESPONSE_BYTES + 1)
            try:
                error_payload = json.loads(raw.decode("utf-8"))
                message = error_payload.get("error") if isinstance(error_payload, dict) else None
            except (UnicodeError, json.JSONDecodeError):
                message = None
            raise RunnerProtocolError(
                f"Runner API returned HTTP {exc.code}: {safe_message(message or exc.reason, (token or '',))}"
            ) from exc
        except (URLError, TimeoutError, OSError) as exc:
            raise RunnerProtocolError(f"Runner API request failed: {safe_message(exc)}") from exc
        if len(raw) > MAX_HTTP_RESPONSE_BYTES:
            raise RunnerProtocolError("Runner API response exceeds the fixed size limit")
        try:
            decoded = json.loads(raw.decode("utf-8"))
        except (UnicodeError, json.JSONDecodeError) as exc:
            raise RunnerProtocolError("Runner API response is not valid UTF-8 JSON") from exc
        if not isinstance(decoded, dict):
            raise RunnerProtocolError("Runner API response must be a JSON object")
        return decoded


def issue_identity(client: RunnerApiClient, label: str) -> RunnerIdentity:
    response = client.post({"action": "issue_runner_token", "label": label, "capabilities": ["text-gates"]})
    runner_id = required_string(response, "runnerId", 120)
    token = required_string(response, "token", 500)
    capabilities = response.get("capabilities")
    if response.get("shownOnce") is not True or capabilities != ["text-gates"]:
        raise RunnerProtocolError("issued Runner identity does not match the fixed text-gates capability")
    return RunnerIdentity(runner_id=runner_id, token=token, issued_here=True)


def configured_identity(runner_id: str | None) -> RunnerIdentity:
    if not runner_id:
        raise RunnerProtocolError("--runner-id is required unless --issue is used")
    token = os.environ.get(TOKEN_ENVIRONMENT_VARIABLE, "").strip()
    if not token:
        raise RunnerProtocolError(f"{TOKEN_ENVIRONMENT_VARIABLE} is required for an existing Runner")
    if len(token) > 500:
        raise RunnerProtocolError(f"{TOKEN_ENVIRONMENT_VARIABLE} exceeds 500 characters")
    return RunnerIdentity(runner_id=runner_id, token=token, issued_here=False)


def parse_lease(response: dict[str, Any]) -> LeaseJob | None:
    job = response.get("job")
    if job is None:
        return None
    lease = response.get("lease")
    if not isinstance(job, dict) or not isinstance(lease, dict):
        raise RunnerProtocolError("lease response must contain job and lease objects")
    runner_action = required_string(job, "runnerAction", 80)
    if runner_action not in ALLOWLIST:
        raise RunnerProtocolError(f"runner action {runner_action!r} is not allowlisted")
    input_payload = job.get("input")
    if not isinstance(input_payload, dict):
        raise RunnerProtocolError("job input must be an object")
    input_sha256 = required_sha256(job, "inputSha256")
    if sha256_text(canonical_json(input_payload)) != input_sha256:
        raise RunnerProtocolError("job input digest does not match the canonical input object")
    attempt = job.get("attempt")
    if not isinstance(attempt, int) or attempt < 1:
        raise RunnerProtocolError("job attempt must be a positive integer")
    heartbeat_seconds = lease.get("heartbeatSeconds")
    if not isinstance(heartbeat_seconds, int) or not 1 <= heartbeat_seconds <= 30:
        raise RunnerProtocolError("lease heartbeatSeconds must be between 1 and 30")
    return LeaseJob(
        step_id=required_string(job, "stepId", 120),
        agent_run_id=required_string(job, "agentRunId", 120),
        attempt=attempt,
        runner_action=runner_action,
        input_sha256=input_sha256,
        input_payload=input_payload,
        lease_id=required_string(lease, "id", 120),
        lease_token=required_string(lease, "token", 500),
        heartbeat_seconds=heartbeat_seconds,
    )


def child_environment() -> dict[str, str]:
    allowed = {"SYSTEMROOT", "WINDIR", "COMSPEC", "TEMP", "TMP", "PATH", "PATHEXT"}
    environment = {key: value for key, value in os.environ.items() if key.upper() in allowed}
    environment.update({"PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8", "PYTHONDONTWRITEBYTECODE": "1"})
    return environment


def read_log_tail(path: Path, maximum: int = 2_000) -> str:
    try:
        raw = path.read_bytes()
    except OSError:
        return ""
    return raw[-maximum:].decode("utf-8", errors="replace").strip()


def persist_artifact(job: LeaseJob, output_text: str) -> str:
    if not SAFE_FILENAME_SEGMENT_RE.fullmatch(job.step_id):
        raise GateProcessError("step ID is not safe for the fixed artifact path")
    ARTIFACT_DIRECTORY.mkdir(parents=True, exist_ok=True)
    filename = f"{job.step_id}-attempt-{job.attempt}.json"
    destination = ARTIFACT_DIRECTORY / filename
    encoded = output_text.encode("utf-8")
    temporary: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="wb",
            prefix=f".{filename}.",
            suffix=".tmp",
            dir=ARTIFACT_DIRECTORY,
            delete=False,
        ) as handle:
            handle.write(encoded)
            handle.flush()
            os.fsync(handle.fileno())
            temporary = Path(handle.name)
        try:
            os.link(temporary, destination)
        except FileExistsError:
            try:
                existing = destination.read_bytes()
            except OSError as exc:
                raise GateProcessError(f"existing artifact cannot be read: {safe_message(exc)}") from exc
            if existing != encoded:
                raise GateProcessError("artifact path already contains different output")
        temporary.unlink(missing_ok=True)
        temporary = None
    except OSError as exc:
        raise GateProcessError(f"artifact could not be persisted: {safe_message(exc)}") from exc
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)
    return f".runner/artifacts/{filename}"


def run_gate_process(
    job: LeaseJob,
    heartbeat: Callable[[], None],
) -> tuple[str, dict[str, Any]]:
    script = ALLOWLIST[job.runner_action]
    if script.resolve() != TEXT_GATE_SCRIPT.resolve() or not script.is_file():
        raise GateProcessError("allowlisted gate script is unavailable or changed location")

    with tempfile.TemporaryDirectory(prefix="wenmai-runner-") as temporary_directory:
        workspace = Path(temporary_directory)
        input_path = workspace / "input.json"
        output_path = workspace / "output.json"
        stdout_path = workspace / "stdout.log"
        stderr_path = workspace / "stderr.log"
        gate_envelope = {
            "schemaVersion": GATE_INPUT_SCHEMA_VERSION,
            "action": job.runner_action,
            "inputSha256": job.input_sha256,
            "input": job.input_payload,
        }
        input_path.write_text(canonical_json(gate_envelope) + "\n", encoding="utf-8", newline="\n")
        command = [
            str(Path(sys.executable).resolve()),
            "-B",
            str(script),
            "--input",
            str(input_path),
            "--output",
            str(output_path),
        ]
        creation_flags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
        with stdout_path.open("wb") as stdout_handle, stderr_path.open("wb") as stderr_handle:
            process = subprocess.Popen(
                command,
                cwd=SCRIPT_DIR,
                env=child_environment(),
                stdin=subprocess.DEVNULL,
                stdout=stdout_handle,
                stderr=stderr_handle,
                shell=False,
                creationflags=creation_flags,
            )
            try:
                deadline = time.monotonic() + SUBPROCESS_TIMEOUT_SECONDS
                next_heartbeat = time.monotonic() + job.heartbeat_seconds
                while process.poll() is None:
                    if time.monotonic() >= deadline:
                        process.kill()
                        process.wait(timeout=2)
                        raise GateProcessError(f"gate subprocess exceeded {SUBPROCESS_TIMEOUT_SECONDS:.0f} seconds")
                    log_size = stdout_path.stat().st_size + stderr_path.stat().st_size
                    if log_size > MAX_CHILD_LOG_BYTES:
                        process.kill()
                        process.wait(timeout=2)
                        raise GateProcessError(f"gate subprocess logs exceeded {MAX_CHILD_LOG_BYTES} bytes")
                    if time.monotonic() >= next_heartbeat:
                        heartbeat()
                        next_heartbeat = time.monotonic() + job.heartbeat_seconds
                    time.sleep(0.05)
                exit_code = process.returncode
            except BaseException:
                if process.poll() is None:
                    process.kill()
                    try:
                        process.wait(timeout=2)
                    except subprocess.TimeoutExpired:
                        pass
                raise

        if stdout_path.stat().st_size + stderr_path.stat().st_size > MAX_CHILD_LOG_BYTES:
            raise GateProcessError(f"gate subprocess logs exceeded {MAX_CHILD_LOG_BYTES} bytes")
        if exit_code != 0:
            detail = read_log_tail(stderr_path) or read_log_tail(stdout_path) or "no diagnostic output"
            raise GateProcessError(f"gate subprocess exited {exit_code}: {safe_message(detail)}")
        if not output_path.is_file():
            raise GateProcessError("gate subprocess did not create its fixed output file")
        if output_path.stat().st_size > MAX_ARTIFACT_BYTES:
            raise GateProcessError(f"gate output exceeds {MAX_ARTIFACT_BYTES} bytes")
        try:
            output_text = output_path.read_text(encoding="utf-8")
            output_payload = json.loads(output_text)
        except (OSError, UnicodeError, json.JSONDecodeError) as exc:
            raise GateProcessError("gate output is not valid UTF-8 JSON") from exc
        if not isinstance(output_payload, dict):
            raise GateProcessError("gate output must be a JSON object")
        if output_payload.get("schemaVersion") != TEXT_GATE_OUTPUT_SCHEMA_VERSION:
            raise GateProcessError("gate output schema version is invalid")
        if output_payload.get("action") != job.runner_action:
            raise GateProcessError("gate output action does not match the lease")
        if output_payload.get("inputSha256") != job.input_sha256:
            raise GateProcessError("gate output does not bind to the frozen job input digest")
        if output_payload.get("result") not in {"pass", "fail", "inconclusive"}:
            raise GateProcessError("gate output aggregate result is invalid")
        if not isinstance(output_payload.get("gates"), list):
            raise GateProcessError("gate output gates must be an array")
        return output_text, output_payload


def heartbeat(client: RunnerApiClient, identity: RunnerIdentity, job: LeaseJob, heartbeat_seq: int) -> None:
    response = client.post(
        {
            "action": "runner_heartbeat",
            "runnerId": identity.runner_id,
            "stepId": job.step_id,
            "leaseId": job.lease_id,
            "leaseToken": job.lease_token,
            "heartbeatSeq": heartbeat_seq,
        },
        identity.token,
    )
    if response.get("state") != "running" or response.get("stepId") != job.step_id:
        raise RunnerProtocolError("heartbeat response does not confirm the current step")
    log_event(
        "runner.heartbeat",
        runnerId=identity.runner_id,
        stepId=job.step_id,
        heartbeatSeq=heartbeat_seq,
        expiresAt=response.get("expiresAt"),
    )


def complete_job(
    client: RunnerApiClient,
    identity: RunnerIdentity,
    job: LeaseJob,
    output_text: str,
) -> dict[str, Any]:
    output_sha256 = sha256_text(output_text)
    content_ref = persist_artifact(job, output_text)
    command_digest = sha256_text(canonical_json({
        "stepId": job.step_id,
        "leaseId": job.lease_id,
        "outputSha256": output_sha256,
        "contentRefInput": content_ref,
        "artifactTitle": TEXT_GATE_ARTIFACT_TITLE,
        "mediaType": JSON_MEDIA_TYPE,
    }))
    command_id = f"runner-complete:{command_digest}"
    response = client.post(
        {
            "action": "runner_complete",
            "runnerId": identity.runner_id,
            "stepId": job.step_id,
            "leaseId": job.lease_id,
            "leaseToken": job.lease_token,
            "commandId": command_id,
            "outputText": output_text,
            "outputSha256": output_sha256,
            "contentRef": content_ref,
            "title": TEXT_GATE_ARTIFACT_TITLE,
            "mediaType": JSON_MEDIA_TYPE,
        },
        identity.token,
    )
    if response.get("state") != "succeeded" or response.get("stepId") != job.step_id:
        raise RunnerProtocolError("completion response does not confirm the current step")
    return response


def fail_job(
    client: RunnerApiClient,
    identity: RunnerIdentity,
    job: LeaseJob,
    error: Exception,
) -> None:
    error_class = getattr(error, "error_class", "runner_error")
    error_summary = safe_message(error, (identity.token, job.lease_token))
    command_digest = sha256_text(canonical_json({
        "stepId": job.step_id,
        "leaseId": job.lease_id,
        "errorClass": error_class,
        "errorSummary": error_summary,
    }))
    command_id = f"runner-fail:{command_digest}"
    client.post(
        {
            "action": "runner_fail",
            "runnerId": identity.runner_id,
            "stepId": job.step_id,
            "leaseId": job.lease_id,
            "leaseToken": job.lease_token,
            "commandId": command_id,
            "errorClass": error_class,
            "errorSummary": error_summary,
        },
        identity.token,
    )


def run_one(
    client: RunnerApiClient,
    identity: RunnerIdentity,
    expected_run_id: str | None = None,
) -> tuple[bool, bool]:
    lease_payload = {"action": "runner_lease", "runnerId": identity.runner_id}
    if expected_run_id is not None:
        lease_payload["expectedAgentRunId"] = expected_run_id
    lease_response = client.post(lease_payload, identity.token)
    job = parse_lease(lease_response)
    if job is None:
        log_event("runner.idle", runnerId=identity.runner_id, recoveredAttempts=lease_response.get("recoveredAttempts", 0))
        return False, True

    log_event(
        "runner.job.leased",
        runnerId=identity.runner_id,
        stepId=job.step_id,
        agentRunId=job.agent_run_id,
        action=job.runner_action,
        attempt=job.attempt,
        inputSha256=job.input_sha256,
    )
    try:
        heartbeat_seq = 0

        def send_heartbeat() -> None:
            nonlocal heartbeat_seq
            heartbeat_seq += 1
            heartbeat(client, identity, job, heartbeat_seq)

        send_heartbeat()
        output_text, output_payload = run_gate_process(job, send_heartbeat)
        response = complete_job(client, identity, job, output_text)
        log_event(
            "runner.job.completed",
            runnerId=identity.runner_id,
            stepId=job.step_id,
            artifactId=response.get("artifactId"),
            outputSha256=response.get("outputSha256"),
            gateResult=output_payload.get("result"),
            inputStillCurrent=response.get("inputStillCurrent"),
            runState=response.get("runState"),
        )
        return True, True
    except Exception as exc:
        try:
            fail_job(client, identity, job, exc)
            reported = True
        except Exception as report_error:
            reported = False
            log_event(
                "runner.job.fail-report-error",
                runnerId=identity.runner_id,
                stepId=job.step_id,
                error=safe_message(report_error, (identity.token, job.lease_token)),
            )
        log_event(
            "runner.job.failed",
            runnerId=identity.runner_id,
            stepId=job.step_id,
            errorClass=getattr(exc, "error_class", "runner_error"),
            error=safe_message(exc, (identity.token, job.lease_token)),
            reported=reported,
        )
        return True, False


def revoke_if_issued(client: RunnerApiClient, identity: RunnerIdentity | None) -> None:
    if identity is None or not identity.issued_here:
        return
    try:
        response = client.post({"action": "revoke_runner", "runnerId": identity.runner_id})
        log_event("runner.revoked", runnerId=identity.runner_id, status=response.get("status"))
    except Exception as exc:
        log_event("runner.revoke-failed", runnerId=identity.runner_id, error=safe_message(exc, (identity.token,)))


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-url", default="http://127.0.0.1:3000")
    identity_group = parser.add_mutually_exclusive_group(required=True)
    identity_group.add_argument("--issue", action="store_true", help="Issue an in-memory token, then revoke it when this process exits")
    identity_group.add_argument("--runner-id")
    parser.add_argument("--label", default="本地正文门禁 Runner")
    parser.add_argument("--expected-agent-run-id", help="Only recover and lease work from this exact AgentRun")
    parser.add_argument("--once", action="store_true", help="Lease at most one job and then exit")
    args = parser.parse_args()

    client: RunnerApiClient | None = None
    identity: RunnerIdentity | None = None
    try:
        client = RunnerApiClient(args.base_url)
        identity = issue_identity(client, args.label) if args.issue else configured_identity(args.runner_id)
        expected_run_id = expected_agent_run_id(args.expected_agent_run_id)
        log_event(
            "runner.started",
            runnerId=identity.runner_id,
            capabilities=["text-gates"],
            once=args.once,
            expectedAgentRunId=expected_run_id,
        )
        while True:
            had_job, succeeded = run_one(client, identity, expected_run_id)
            if args.once:
                return 0 if succeeded else 1
            if had_job and not succeeded:
                time.sleep(POLL_SECONDS)
            elif not had_job:
                time.sleep(POLL_SECONDS)
    except KeyboardInterrupt:
        log_event("runner.stopped", runnerId=identity.runner_id if identity else None, reason="keyboard_interrupt")
        return 130
    except Exception as exc:
        secrets = (identity.token,) if identity else ()
        log_event(
            "runner.fatal",
            runnerId=identity.runner_id if identity else None,
            errorClass=getattr(exc, "error_class", "runner_error"),
            error=safe_message(exc, secrets),
        )
        return 1
    finally:
        if client is not None:
            revoke_if_issued(client, identity)


if __name__ == "__main__":
    raise SystemExit(main())
