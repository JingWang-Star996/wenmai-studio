#!/usr/bin/env python3
"""受限的文脉 Agent NDJSON stdio 客户端。

客户端只访问显式 loopback IP，或由精确 ASCII Tailscale MagicDNS 主机名构造的
HTTPS 固定 Agent API；不执行 Shell，不读取任意本地文件，不使用代理，也不跟随
重定向。Bearer token 只从一个命名环境变量取得，不进入诊断输出；领取任务时
返回的 leaseToken 是继续协议所必需的一次性凭据，只会在 claim 的成功数据中
原样交给 stdio 调用方。
"""

from __future__ import annotations

import argparse
import hashlib
import ipaddress
import json
import math
import os
import re
import socket
import sys
from dataclasses import dataclass
from typing import Any, BinaryIO, Iterable
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlsplit, urlunsplit
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener


PROTOCOL_VERSION = "wenmai.agent/1.0"
COMMAND_SCHEMA_VERSION = "wenmai.agent-command/1.0"
RESPONSE_SCHEMA_VERSION = "wenmai.agent-client-response/1.0"
API_PATH = "/api/agent/v1"
WORKSPACE_API_PATH = "/api/workspace"
PROJECT_PACKAGE_API_PATH = "/api/project-package/v1"
PUBLISH_CAPABILITY_API_PATH = "/api/publish-capability/v1"
ALLOWED_API_PATHS = frozenset(
    {API_PATH, WORKSPACE_API_PATH, PROJECT_PACKAGE_API_PATH, PUBLISH_CAPABILITY_API_PATH}
)
DEFAULT_BASE_URL = "http://[::1]:3000"
DEFAULT_TOKEN_ENV = "WENMAI_AGENT_TOKEN"
DEFAULT_TIMEOUT_SECONDS = 8.0
DEFAULT_MAX_REQUEST_BYTES = 300_000
DEFAULT_MAX_RESPONSE_BYTES = 4_194_304
DEFAULT_MAX_LINE_BYTES = 1_048_576
SERVER_MAX_REQUEST_BYTES = 2_200_000
MAX_CONFIGURED_BYTES = 16_777_216
MAX_TIMEOUT_SECONDS = 60.0
MAX_INLINE_ARTIFACT_BYTES = 220_000
MAX_REFERENCED_ARTIFACT_BYTES = 1_000_000_000

STABLE_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$")
REQUEST_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$")
SHA256_RE = re.compile(r"^[a-f0-9]{64}$")
ARTIFACT_REF_RE = re.compile(
    r"^(?:agent-inline:|artifact:|\.runner/agent/)[A-Za-z0-9][A-Za-z0-9._:/-]{0,479}$"
)
SENSITIVE_KEY_RE = re.compile(r"token|secret|authorization|credential", re.IGNORECASE)
TAILSCALE_HOST_RE = re.compile(
    r"(?=.{1,253}\Z)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.){2}ts\.net\Z"
)

COMMANDS = (
    "help",
    "manifest",
    "status",
    "list_tasks",
    "get_task",
    "get_context",
    "search_knowledge",
    "get_subgraph",
    "claim",
    "heartbeat",
    "progress",
    "add_artifact",
    "propose_revision",
    "await_human",
    "complete",
    "fail",
    "release",
    "admin_action",
    "super_admin_action",
)
MUTATION_COMMANDS = frozenset(
    {
        "claim", "heartbeat", "progress", "add_artifact", "propose_revision",
        "await_human", "complete", "fail", "release",
    }
)
TASK_STATES = frozenset(
    {"draft", "queued", "claimed", "running", "awaiting_human", "blocked", "review", "succeeded", "failed", "cancelled"}
)
MEDIA_TYPE_RE = re.compile(r"^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}$")
HUMAN_REQUEST_KINDS = frozenset({"clarification", "scope_change", "risk_acceptance"})
ADMIN_ACTIONS = frozenset({"create_task", "update_task", "cancel_task"})
SUPER_ADMIN_ACTION_ROUTES = {
    "create_task": (API_PATH, "envelope", "create_task"),
    "update_task": (API_PATH, "envelope", "update_task"),
    "cancel_task": (API_PATH, "envelope", "cancel_task"),
    "decide_approval": (API_PATH, "envelope", "decide_approval"),
    "decide_graph_proposal": (API_PATH, "envelope", "decide_graph_proposal"),
    "decide_patch": (PROJECT_PACKAGE_API_PATH, "envelope", "decide_patch"),
    "apply_patch": (PROJECT_PACKAGE_API_PATH, "envelope", "apply_patch"),
    "create_publication_branch": (WORKSPACE_API_PATH, "flat", "create_publication_branch"),
    "save_working_copy": (WORKSPACE_API_PATH, "flat", "save_working_copy"),
    "commit_revision": (WORKSPACE_API_PATH, "flat", "commit_revision"),
    "attach_branch": (PROJECT_PACKAGE_API_PATH, "envelope", "attach_branch"),
    "register_publication_version": (PROJECT_PACKAGE_API_PATH, "envelope", "register_publication_version"),
    "prepare_merge": (WORKSPACE_API_PATH, "flat", "prepare_merge"),
    "save_merge_resolution": (WORKSPACE_API_PATH, "flat", "save_merge_resolution"),
    "merge_revision": (WORKSPACE_API_PATH, "flat", "merge_revision"),
    "consume_publish_capability": (PUBLISH_CAPABILITY_API_PATH, "envelope", "consume"),
}
SENSITIVE_CONTROL_KEY_RE = re.compile(
    r"token|secret|password|credential|authorization|cookie|csrf|captcha|otp|2fa",
    re.IGNORECASE,
)


class AgentClientError(RuntimeError):
    def __init__(
        self,
        code: str,
        message: str,
        *,
        status: int | None = None,
        details: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.status = status
        self.details = details


class NoRedirectHandler(HTTPRedirectHandler):
    def redirect_request(self, request: Request, fp: Any, code: int, msg: str, headers: Any, newurl: str) -> None:
        return None


@dataclass(frozen=True)
class HttpResult:
    status: int
    payload: dict[str, Any]


def canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


def stable_command_id(request_id: str) -> str:
    digest = hashlib.sha256(f"{PROTOCOL_VERSION}\0{request_id}".encode("utf-8")).hexdigest()
    return f"wmcmd-{digest[:32]}"


def safe_text(value: Any, bearer_token: str | None = None, maximum: int = 1_000) -> str:
    text = str(value).replace("\r", " ").replace("\n", " ")
    if bearer_token:
        text = text.replace(bearer_token, "<redacted>")
    return text[:maximum]


def redact(value: Any, bearer_token: str | None = None, *, allow_lease_token: bool = False) -> Any:
    if isinstance(value, dict):
        result: dict[str, Any] = {}
        for raw_key, child in value.items():
            key = str(raw_key)
            if key.lower() == "leasetoken" and allow_lease_token:
                result[key] = redact(child, bearer_token, allow_lease_token=True)
            elif SENSITIVE_KEY_RE.search(key):
                result[key] = "<redacted>"
            else:
                result[key] = redact(child, bearer_token, allow_lease_token=allow_lease_token)
        return result
    if isinstance(value, list):
        return [redact(child, bearer_token, allow_lease_token=allow_lease_token) for child in value]
    if isinstance(value, str) and bearer_token:
        return value.replace(bearer_token, "<redacted>")
    return value


def require_object(value: Any, label: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise AgentClientError("INVALID_REQUEST", f"{label} must be a JSON object")
    return value


def require_allowed_keys(value: dict[str, Any], allowed: Iterable[str], required: Iterable[str] = ()) -> None:
    allowed_set = set(allowed)
    unknown = sorted(set(value) - allowed_set)
    if unknown:
        raise AgentClientError("INVALID_REQUEST", f"unsupported fields: {', '.join(unknown)}")
    missing = sorted(field for field in required if field not in value)
    if missing:
        raise AgentClientError("INVALID_REQUEST", f"missing fields: {', '.join(missing)}")


def require_string(value: Any, label: str, *, minimum: int = 1, maximum: int = 2_000) -> str:
    if not isinstance(value, str):
        raise AgentClientError("INVALID_REQUEST", f"{label} must be a string")
    cleaned = value.strip()
    if len(cleaned) < minimum or len(cleaned) > maximum:
        raise AgentClientError("INVALID_REQUEST", f"{label} length must be {minimum}..{maximum}")
    return cleaned


def require_raw_string(value: Any, label: str, *, minimum: int = 1, maximum: int = 220_000) -> str:
    if not isinstance(value, str):
        raise AgentClientError("INVALID_REQUEST", f"{label} must be a string")
    if len(value) < minimum or len(value) > maximum or "\x00" in value:
        raise AgentClientError("INVALID_REQUEST", f"{label} length must be {minimum}..{maximum} and contain no NUL")
    return value


def require_stable_id(value: Any, label: str) -> str:
    candidate = require_string(value, label, maximum=120)
    if not STABLE_ID_RE.fullmatch(candidate):
        raise AgentClientError("INVALID_REQUEST", f"{label} is not a stable ID")
    return candidate


def require_request_id(value: Any) -> str:
    candidate = require_string(value, "requestId", maximum=160)
    if not REQUEST_ID_RE.fullmatch(candidate):
        raise AgentClientError("INVALID_REQUEST", "requestId is not a stable ID")
    return candidate


def require_sha256(value: Any, label: str) -> str:
    candidate = require_string(value, label, minimum=64, maximum=64).lower()
    if not SHA256_RE.fullmatch(candidate):
        raise AgentClientError("INVALID_REQUEST", f"{label} must be lowercase SHA-256")
    return candidate


def require_integer(value: Any, label: str, minimum: int, maximum: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < minimum or value > maximum:
        raise AgentClientError("INVALID_REQUEST", f"{label} must be an integer in {minimum}..{maximum}")
    return value


def require_boolean(value: Any, label: str) -> bool:
    if not isinstance(value, bool):
        raise AgentClientError("INVALID_REQUEST", f"{label} must be a boolean")
    return value


def require_string_list(
    value: Any,
    label: str,
    *,
    maximum_items: int = 100,
    item_maximum: int = 2_000,
    stable_ids: bool = False,
) -> list[str]:
    if not isinstance(value, list) or len(value) > maximum_items:
        raise AgentClientError("INVALID_REQUEST", f"{label} must be an array with at most {maximum_items} items")
    if stable_ids:
        result = [require_stable_id(item, f"{label}[]") for item in value]
    else:
        result = [require_string(item, f"{label}[]", maximum=item_maximum) for item in value]
    if len(set(result)) != len(result):
        raise AgentClientError("INVALID_REQUEST", f"{label} must contain unique values")
    return result


def require_json_object(value: Any, label: str) -> dict[str, Any]:
    root = require_object(value, label)
    seen = 0

    def visit(node: Any, depth: int) -> None:
        nonlocal seen
        seen += 1
        if seen > 10_000 or depth > 24:
            raise AgentClientError("INVALID_REQUEST", f"{label} is too complex")
        if node is None or isinstance(node, (bool, int, str)):
            if isinstance(node, str) and len(node) > 20_000:
                raise AgentClientError("INVALID_REQUEST", f"{label} contains an oversized string")
            return
        if isinstance(node, float):
            if not math.isfinite(node):
                raise AgentClientError("INVALID_REQUEST", f"{label} contains a non-finite number")
            return
        if isinstance(node, list):
            for child in node:
                visit(child, depth + 1)
            return
        if isinstance(node, dict):
            for key, child in node.items():
                if not isinstance(key, str) or len(key) > 500:
                    raise AgentClientError("INVALID_REQUEST", f"{label} contains an invalid key")
                visit(child, depth + 1)
            return
        raise AgentClientError("INVALID_REQUEST", f"{label} contains a non-JSON value")

    visit(root, 0)
    return root


def reject_sensitive_control_fields(value: Any, label: str = "payload") -> None:
    if isinstance(value, dict):
        for raw_key, child in value.items():
            key = str(raw_key)
            if SENSITIVE_CONTROL_KEY_RE.search(key):
                raise AgentClientError("SENSITIVE_FIELD_FORBIDDEN", f"{label} contains a forbidden sensitive field")
            reject_sensitive_control_fields(child, f"{label}.{key}")
    elif isinstance(value, list):
        for child in value:
            reject_sensitive_control_fields(child, label)


def validate_token(token: str | None, environment_name: str = DEFAULT_TOKEN_ENV) -> str:
    if token is None:
        raise AgentClientError("AUTH_REQUIRED", f"Bearer token is required in {environment_name}")
    if len(token) < 16 or len(token) > 4_096 or any(ord(character) < 33 or ord(character) > 126 for character in token):
        raise AgentClientError("TOKEN_INVALID", "Bearer token has an invalid format")
    return token


def loopback_origin(base_url: str) -> str:
    parsed = urlsplit(base_url)
    if parsed.scheme != "http":
        raise AgentClientError("INVALID_BASE_URL", "base URL must use http")
    if parsed.username or parsed.password:
        raise AgentClientError("INVALID_BASE_URL", "base URL must not contain credentials")
    if parsed.query or parsed.fragment or parsed.path not in {"", "/"}:
        raise AgentClientError("INVALID_BASE_URL", "base URL must be an origin without path, query, or fragment")
    host = parsed.hostname
    if not host:
        raise AgentClientError("INVALID_BASE_URL", "base URL is missing a host")
    try:
        address = ipaddress.ip_address(host)
        port = parsed.port
    except ValueError as error:
        raise AgentClientError("INVALID_BASE_URL", "base URL must use a valid loopback IP literal") from error
    if address not in {ipaddress.ip_address("127.0.0.1"), ipaddress.ip_address("::1")}:
        raise AgentClientError("INVALID_BASE_URL", "base URL must use 127.0.0.1 or ::1")
    if port is not None and not 1 <= port <= 65_535:
        raise AgentClientError("INVALID_BASE_URL", "base URL port is invalid")
    return urlunsplit(("http", parsed.netloc, "", "", "")).rstrip("/")


def tailscale_https_origin(hostname: str) -> str:
    if not isinstance(hostname, str) or not hostname or hostname != hostname.strip():
        raise AgentClientError("INVALID_TAILSCALE_HOST", "Tailscale host must be an exact ASCII hostname")
    try:
        hostname.encode("ascii", "strict")
    except UnicodeEncodeError as error:
        raise AgentClientError("INVALID_TAILSCALE_HOST", "Tailscale host must contain ASCII characters only") from error
    normalized = hostname.lower()
    if not TAILSCALE_HOST_RE.fullmatch(normalized):
        raise AgentClientError(
            "INVALID_TAILSCALE_HOST",
            "Tailscale host must be an exact <machine>.<tailnet>.ts.net hostname",
        )
    return f"https://{normalized}"


def resolve_transport_origin(base_url: str | None, trusted_tailscale_host: str | None = None) -> str:
    if trusted_tailscale_host is not None:
        if base_url is not None:
            raise AgentClientError(
                "INVALID_CONFIGURATION",
                "base URL and trusted Tailscale host are mutually exclusive",
            )
        return tailscale_https_origin(trusted_tailscale_host)
    return loopback_origin(DEFAULT_BASE_URL if base_url is None else base_url)


def validate_transport_limits(timeout_seconds: float, max_request_bytes: int, max_response_bytes: int) -> None:
    if not isinstance(timeout_seconds, (int, float)) or not math.isfinite(float(timeout_seconds)):
        raise AgentClientError("INVALID_CONFIGURATION", "timeout must be finite")
    if float(timeout_seconds) < 0.1 or float(timeout_seconds) > MAX_TIMEOUT_SECONDS:
        raise AgentClientError("INVALID_CONFIGURATION", f"timeout must be in 0.1..{MAX_TIMEOUT_SECONDS}")
    if isinstance(max_request_bytes, bool) or not isinstance(max_request_bytes, int):
        raise AgentClientError("INVALID_CONFIGURATION", "max request bytes must be an integer")
    if not 1_024 <= max_request_bytes <= SERVER_MAX_REQUEST_BYTES:
        raise AgentClientError("INVALID_CONFIGURATION", f"max request bytes must be in 1024..{SERVER_MAX_REQUEST_BYTES}")
    if isinstance(max_response_bytes, bool) or not isinstance(max_response_bytes, int):
        raise AgentClientError("INVALID_CONFIGURATION", "max response bytes must be an integer")
    if not 1_024 <= max_response_bytes <= MAX_CONFIGURED_BYTES:
        raise AgentClientError("INVALID_CONFIGURATION", f"max response bytes must be in 1024..{MAX_CONFIGURED_BYTES}")


class AgentHttpClient:
    def __init__(
        self,
        base_url: str | None,
        token: str | None,
        *,
        trusted_tailscale_host: str | None = None,
        token_environment: str = DEFAULT_TOKEN_ENV,
        timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS,
        max_request_bytes: int = DEFAULT_MAX_REQUEST_BYTES,
        max_response_bytes: int = DEFAULT_MAX_RESPONSE_BYTES,
    ) -> None:
        validate_transport_limits(timeout_seconds, max_request_bytes, max_response_bytes)
        self.origin = resolve_transport_origin(base_url, trusted_tailscale_host)
        self.token = token
        self.token_environment = token_environment
        self.timeout_seconds = float(timeout_seconds)
        self.max_request_bytes = max_request_bytes
        self.max_response_bytes = max_response_bytes
        self.opener = build_opener(ProxyHandler({}), NoRedirectHandler())

    def request(
        self,
        method: str,
        *,
        query: list[tuple[str, str]],
        body: dict[str, Any] | None = None,
        api_path: str = API_PATH,
    ) -> HttpResult:
        if method not in {"GET", "POST"}:
            raise AgentClientError("INTERNAL_POLICY_ERROR", "unsupported HTTP method")
        if api_path not in ALLOWED_API_PATHS:
            raise AgentClientError("INTERNAL_POLICY_ERROR", "unsupported Wenmai API path")
        bearer_token = validate_token(self.token, self.token_environment)
        encoded_body: bytes | None = None
        if body is not None:
            try:
                encoded_body = canonical_json(body).encode("utf-8")
            except (TypeError, ValueError, RecursionError) as error:
                raise AgentClientError("INVALID_REQUEST", "request body is not bounded strict JSON") from error
            if len(encoded_body) > self.max_request_bytes:
                raise AgentClientError("PAYLOAD_TOO_LARGE", f"request body exceeds {self.max_request_bytes} bytes")
        url = f"{self.origin}{api_path}"
        if query:
            url = f"{url}?{urlencode(query)}"
        headers = {
            "Accept": "application/json",
            "Authorization": f"Bearer {bearer_token}",
            "User-Agent": "wenmai-agent-client/1.0",
            "X-Wenmai-Agent-Protocol": PROTOCOL_VERSION,
        }
        if encoded_body is not None:
            headers["Content-Type"] = "application/json"
        request = Request(url, data=encoded_body, headers=headers, method=method)
        try:
            with self.opener.open(request, timeout=self.timeout_seconds) as response:
                return self._decode_response(int(response.status), response.headers, response)
        except HTTPError as error:
            if 300 <= error.code < 400:
                raise AgentClientError("REDIRECT_FORBIDDEN", "HTTP redirects are forbidden", status=error.code) from error
            result = self._decode_response(int(error.code), error.headers, error)
            server_error = result.payload.get("error")
            server_code = server_error.get("code") if isinstance(server_error, dict) else None
            raise AgentClientError(
                "SERVER_ERROR",
                f"server rejected the request ({server_code or f'HTTP_{error.code}'})",
                status=error.code,
                details={"serverCode": server_code} if isinstance(server_code, str) else None,
            ) from error
        except AgentClientError:
            raise
        except (URLError, TimeoutError, socket.timeout, OSError) as error:
            raise AgentClientError("NETWORK_ERROR", safe_text(error, bearer_token)) from error

    def _decode_response(self, status: int, headers: Any, stream: BinaryIO) -> HttpResult:
        content_length = headers.get("Content-Length") if headers is not None else None
        if content_length:
            try:
                if int(content_length) > self.max_response_bytes:
                    raise AgentClientError(
                        "RESPONSE_TOO_LARGE",
                        f"response body exceeds {self.max_response_bytes} bytes",
                        status=status,
                    )
            except ValueError:
                pass
        raw = stream.read(self.max_response_bytes + 1)
        if len(raw) > self.max_response_bytes:
            raise AgentClientError(
                "RESPONSE_TOO_LARGE",
                f"response body exceeds {self.max_response_bytes} bytes",
                status=status,
            )
        content_type = str(headers.get("Content-Type", "")) if headers is not None else ""
        if not content_type.lower().startswith("application/json"):
            raise AgentClientError("INVALID_RESPONSE", "server response must be application/json", status=status)
        try:
            payload = json.loads(raw.decode("utf-8"), parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
        except (UnicodeError, ValueError, json.JSONDecodeError, RecursionError) as error:
            raise AgentClientError("INVALID_RESPONSE", "server response is not valid strict UTF-8 JSON", status=status) from error
        if not isinstance(payload, dict):
            raise AgentClientError("INVALID_RESPONSE", "server response must be a JSON object", status=status)
        return HttpResult(status=status, payload=payload)


class WenmaiAgentClient:
    def __init__(self, http: AgentHttpClient) -> None:
        self.http = http

    def execute(self, envelope: dict[str, Any]) -> dict[str, Any]:
        require_allowed_keys(envelope, {"requestId", "command", "args"}, {"requestId", "command"})
        request_id = require_request_id(envelope.get("requestId"))
        command = require_string(envelope.get("command"), "command", maximum=80)
        if command not in COMMANDS:
            raise AgentClientError("UNKNOWN_COMMAND", f"unsupported command: {command}")
        args = require_object(envelope.get("args", {}), "args")

        if command == "help":
            require_allowed_keys(args, set())
            return self._success(request_id, command, 200, self._help())
        if command == "manifest":
            require_allowed_keys(args, set())
            return self._network_success(request_id, command, self._get([("view", "manifest")]))
        if command == "status":
            require_allowed_keys(args, set())
            return self._network_success(request_id, command, self._get([("view", "health")]))
        if command == "list_tasks":
            require_allowed_keys(args, set())
            return self._network_success(request_id, command, self._get([("view", "tasks")]))
        if command in {"get_task", "get_context"}:
            allowed = {"taskId", "contextId"} if command == "get_context" else {"taskId"}
            require_allowed_keys(args, allowed, {"taskId"})
            task_id = require_stable_id(args.get("taskId"), "taskId")
            query = [("view", "context" if command == "get_context" else "task"), ("taskId", task_id)]
            if command == "get_context" and "contextId" in args:
                query.append(("contextId", require_stable_id(args["contextId"], "contextId")))
            return self._network_success(request_id, command, self._get(query))
        if command == "search_knowledge":
            require_allowed_keys(args, {"query", "limit"}, {"query"})
            query = [("view", "knowledge"), ("q", require_string(args.get("query"), "query", maximum=160))]
            if "limit" in args:
                query.append(("limit", str(require_integer(args["limit"], "limit", 1, 30))))
            return self._network_success(request_id, command, self._get(query))
        if command == "get_subgraph":
            query = self._graph_query(args)
            return self._network_success(request_id, command, self._get(query))
        if command == "admin_action":
            require_allowed_keys(args, {"action", "payload", "commandId"}, {"action", "payload", "commandId"})
            action = require_string(args.get("action"), "action", maximum=80)
            if action not in ADMIN_ACTIONS:
                raise AgentClientError("ACTION_FORBIDDEN", f"admin_action does not allow action: {action}")
            command_id = require_string(args.get("commandId"), "commandId", maximum=160)
            if not REQUEST_ID_RE.fullmatch(command_id):
                raise AgentClientError("INVALID_REQUEST", "commandId is not a stable ID")
            payload = require_json_object(args.get("payload"), "payload")
            reject_sensitive_control_fields(payload)
            body = {"action": action, "commandId": command_id, "payload": payload}
            result = self.http.request("POST", query=[], body=body)
            return self._network_success(request_id, command, result, command_id=command_id)
        if command == "super_admin_action":
            require_allowed_keys(args, {"action", "payload", "commandId"}, {"action", "payload", "commandId"})
            if self.http.origin != DEFAULT_BASE_URL:
                raise AgentClientError(
                    "LOCAL_SUPER_ADMIN_REQUIRED",
                    "super_admin_action requires the exact http://[::1]:3000 origin",
                )
            action = require_string(args.get("action"), "action", maximum=80)
            route = SUPER_ADMIN_ACTION_ROUTES.get(action)
            if route is None:
                raise AgentClientError("ACTION_FORBIDDEN", f"super_admin_action does not allow action: {action}")
            command_id = require_string(args.get("commandId"), "commandId", maximum=160)
            if not REQUEST_ID_RE.fullmatch(command_id):
                raise AgentClientError("INVALID_REQUEST", "commandId is not a stable ID")
            payload = require_json_object(args.get("payload"), "payload")
            reject_sensitive_control_fields(payload)
            if "action" in payload or "commandId" in payload:
                raise AgentClientError("RESERVED_FIELD_FORBIDDEN", "payload cannot override action or commandId")
            api_path, envelope_kind, route_action = route
            body = (
                {"action": route_action, "commandId": command_id, "payload": payload}
                if envelope_kind == "envelope"
                else {"action": route_action, "commandId": command_id, **payload}
            )
            result = self.http.request("POST", query=[], body=body, api_path=api_path)
            return self._network_success(request_id, command, result, command_id=command_id)
        if command in MUTATION_COMMANDS:
            payload = self._mutation_payload(command, args)
            command_id = stable_command_id(request_id)
            body = {"action": command, "commandId": command_id, "payload": payload}
            result = self.http.request("POST", query=[], body=body)
            return self._network_success(request_id, command, result, command_id=command_id)
        raise AgentClientError("UNKNOWN_COMMAND", f"unsupported command: {command}")

    def _get(self, query: list[tuple[str, str]]) -> HttpResult:
        return self.http.request("GET", query=query)

    def _graph_query(self, args: dict[str, Any]) -> list[tuple[str, str]]:
        require_allowed_keys(args, {"nodeIds", "articleId", "depth", "limit"})
        seeds = require_string_list(args.get("nodeIds", []), "nodeIds", maximum_items=20, stable_ids=True)
        if "articleId" in args:
            article_id = require_stable_id(args["articleId"], "articleId")
            if article_id not in seeds:
                seeds.append(article_id)
        if not seeds:
            raise AgentClientError("INVALID_REQUEST", "get_subgraph requires nodeIds or articleId")
        query = [("view", "graph"), ("seed", ",".join(seeds))]
        if "depth" in args:
            query.append(("depth", str(require_integer(args["depth"], "depth", 0, 2))))
        if "limit" in args:
            query.append(("limit", str(require_integer(args["limit"], "limit", 1, 100))))
        return query

    @staticmethod
    def _lease_payload(args: dict[str, Any]) -> dict[str, Any]:
        return {
            "taskId": require_stable_id(args.get("taskId"), "taskId"),
            "attemptId": require_stable_id(args.get("attemptId"), "attemptId"),
            "leaseId": require_stable_id(args.get("leaseId"), "leaseId"),
            "leaseToken": require_string(args.get("leaseToken"), "leaseToken", minimum=16, maximum=500),
            "contextSha256": require_sha256(args.get("contextSha256"), "contextSha256"),
        }

    def _mutation_payload(self, command: str, args: dict[str, Any]) -> dict[str, Any]:
        common_fields = {"taskId", "attemptId", "leaseId", "leaseToken", "contextSha256"}
        if command == "claim":
            require_allowed_keys(args, {"taskId"}, {"taskId"})
            return {"taskId": require_stable_id(args.get("taskId"), "taskId")}

        if command == "heartbeat":
            require_allowed_keys(args, common_fields | {"heartbeatSeq"}, common_fields | {"heartbeatSeq"})
            return {
                **self._lease_payload(args),
                "heartbeatSeq": require_integer(args["heartbeatSeq"], "heartbeatSeq", 1, 2_147_483_647),
            }
        if command == "progress":
            progress_fields = {
                "phase", "progressPercent", "currentAction", "nextAction", "blocker", "message", "evidence", "eventPayload",
            }
            require_allowed_keys(
                args,
                common_fields | progress_fields,
                common_fields | {"currentAction"},
            )
            payload = {
                **self._lease_payload(args),
                "currentAction": require_string(args["currentAction"], "currentAction", maximum=1_000),
            }
            if "phase" in args:
                payload["phase"] = require_string(args["phase"], "phase", minimum=0, maximum=80)
            if "progressPercent" in args:
                payload["progressPercent"] = require_integer(args["progressPercent"], "progressPercent", 0, 100)
            if "nextAction" in args:
                payload["nextAction"] = require_string(args["nextAction"], "nextAction", minimum=0, maximum=1_000)
            if "blocker" in args:
                payload["blocker"] = require_string(args["blocker"], "blocker", minimum=0, maximum=2_000)
            if "message" in args:
                payload["message"] = require_string(args["message"], "message", minimum=0, maximum=4_000)
            if "evidence" in args:
                payload["evidence"] = require_string_list(args["evidence"], "evidence", maximum_items=30)
            if "eventPayload" in args:
                payload["eventPayload"] = require_json_object(args["eventPayload"], "eventPayload")
            return payload
        if command == "add_artifact":
            artifact_fields = {"kind", "title", "contentRef", "sha256", "mediaType", "sizeBytes", "artifactPayload", "inlineContent"}
            required_fields = {"kind", "title", "contentRef"}
            require_allowed_keys(args, common_fields | artifact_fields, common_fields | required_fields)
            content_ref = require_string(args["contentRef"], "contentRef", maximum=500)
            if not ARTIFACT_REF_RE.fullmatch(content_ref):
                raise AgentClientError("INVALID_REQUEST", "contentRef must be an allowed safe reference; arbitrary local paths are forbidden")
            media_type = require_string(args.get("mediaType", "application/octet-stream"), "mediaType", maximum=120).lower()
            if not MEDIA_TYPE_RE.fullmatch(media_type):
                raise AgentClientError("INVALID_REQUEST", "mediaType must be a valid bounded MIME type")
            artifact_kind = require_stable_id(args["kind"], "kind")
            if len(artifact_kind) > 80:
                raise AgentClientError("INVALID_REQUEST", "kind length must be at most 80")
            payload = {
                **self._lease_payload(args),
                "kind": artifact_kind,
                "title": require_string(args["title"], "title", maximum=240),
                "contentRef": content_ref,
                "mediaType": media_type,
                "artifactPayload": require_json_object(args.get("artifactPayload", {}), "artifactPayload"),
            }
            if content_ref.startswith("agent-inline:"):
                inline_content = require_raw_string(args.get("inlineContent"), "inlineContent")
                encoded = inline_content.encode("utf-8")
                if len(encoded) > MAX_INLINE_ARTIFACT_BYTES:
                    raise AgentClientError("INVALID_REQUEST", f"inlineContent exceeds {MAX_INLINE_ARTIFACT_BYTES} UTF-8 bytes")
                calculated_digest = hashlib.sha256(encoded).hexdigest()
                if "sha256" in args and require_sha256(args["sha256"], "sha256") != calculated_digest:
                    raise AgentClientError("INVALID_REQUEST", "inlineContent does not match sha256")
                if "sizeBytes" in args and require_integer(args["sizeBytes"], "sizeBytes", 0, MAX_INLINE_ARTIFACT_BYTES) != len(encoded):
                    raise AgentClientError("INVALID_REQUEST", "inlineContent does not match sizeBytes")
                payload["sha256"] = calculated_digest
                payload["sizeBytes"] = len(encoded)
                payload["inlineContent"] = inline_content
            else:
                if "inlineContent" in args:
                    raise AgentClientError("INVALID_REQUEST", "inlineContent is only allowed with agent-inline: contentRef")
                payload["sha256"] = require_sha256(args.get("sha256"), "sha256")
                payload["sizeBytes"] = require_integer(
                    args.get("sizeBytes"), "sizeBytes", 0, MAX_REFERENCED_ARTIFACT_BYTES,
                )
            return payload
        if command == "propose_revision":
            revision_fields = {"expectedHeadRevisionId", "title", "bodyText", "summary", "revisionTitle"}
            require_allowed_keys(
                args,
                common_fields | revision_fields,
                common_fields | {"expectedHeadRevisionId", "title", "bodyText"},
            )
            payload = {
                **self._lease_payload(args),
                "expectedHeadRevisionId": require_stable_id(args["expectedHeadRevisionId"], "expectedHeadRevisionId"),
                "title": require_string(args["title"], "title", maximum=240),
                "bodyText": require_raw_string(args["bodyText"], "bodyText", maximum=2_000_000),
            }
            if "summary" in args:
                payload["summary"] = require_string(args["summary"], "summary", minimum=0, maximum=4_000)
            if "revisionTitle" in args:
                payload["revisionTitle"] = require_string(args["revisionTitle"], "revisionTitle", maximum=160)
            return payload
        if command == "await_human":
            decision_fields = {"kind", "title", "question", "options"}
            require_allowed_keys(args, common_fields | decision_fields, common_fields | {"title", "question"})
            kind = require_string(args.get("kind", "clarification"), "kind", maximum=80)
            if kind not in HUMAN_REQUEST_KINDS:
                raise AgentClientError("INVALID_REQUEST", "kind is not an allowed human request type")
            options = require_string_list(args.get("options", ["批准", "拒绝"]), "options", maximum_items=8, item_maximum=500)
            if len(options) < 2:
                raise AgentClientError("INVALID_REQUEST", "options must contain at least two decisions")
            return {
                **self._lease_payload(args),
                "kind": kind,
                "title": require_string(args["title"], "title", maximum=240),
                "question": require_string(args["question"], "question", maximum=4_000),
                "options": options,
            }
        if command == "complete":
            completion_fields = {"summary", "artifactIds", "evidence"}
            require_allowed_keys(args, common_fields | completion_fields, common_fields | {"summary"})
            return {
                **self._lease_payload(args),
                "summary": require_string(args["summary"], "summary", maximum=6_000),
                "artifactIds": require_string_list(args.get("artifactIds", []), "artifactIds", maximum_items=100, stable_ids=True),
                "evidence": require_string_list(args.get("evidence", []), "evidence", maximum_items=50),
            }
        if command == "fail":
            failure_fields = {"errorClass", "errorSummary"}
            require_allowed_keys(args, common_fields | failure_fields, common_fields | failure_fields)
            return {
                **self._lease_payload(args),
                "errorClass": require_stable_id(args["errorClass"], "errorClass"),
                "errorSummary": require_string(args["errorSummary"], "errorSummary", maximum=4_000),
            }
        if command == "release":
            require_allowed_keys(args, common_fields | {"note"}, common_fields | {"note"})
            return {
                **self._lease_payload(args),
                "note": require_string(args["note"], "note", maximum=2_000),
            }
        raise AgentClientError("UNKNOWN_COMMAND", f"unsupported mutation: {command}")

    @staticmethod
    def _help() -> dict[str, Any]:
        return {
            "protocolVersion": PROTOCOL_VERSION,
            "mode": "ndjson_stdio",
            "commands": list(COMMANDS),
            "mutationCommands": sorted(MUTATION_COMMANDS),
            "requestShape": {"requestId": "stable ID", "command": "command name", "args": {}},
            "commandIdRule": "sha256(protocol + NUL + requestId), first 32 hex, prefixed wmcmd-",
            "api": "single fixed /api/agent/v1 endpoint; GET view query or POST action envelope",
            "longRunningMode": "worker keeps serving NDJSON from an upstream coordinator; it does not poll autonomously",
            "connectivityMode": "status performs one authenticated health request and exits",
            "releaseMeaning": "release task lease only; never publish",
            "adminAction": {
                "actions": sorted(ADMIN_ACTIONS),
                "explicitCommandIdRequired": True,
                "issueOrRevokeKey": False,
            },
            "superAdminAction": {
                "actions": sorted(SUPER_ADMIN_ACTION_ROUTES),
                "transport": "exact http://[::1]:3000 only",
                "explicitCommandIdRequired": True,
                "arbitraryPathOrAction": False,
                "issueOrRevokeKey": False,
                "issuePublishCapability": False,
                "externalPublishClick": False,
            },
            "privilegedBoundary": "only the owner browser session issues/revokes Keys and issues publish capability; the explicit super_admin_action allowlist cannot login, complete 2FA, click external publish, or claim publication/completion",
            "network": "explicit loopback HTTP or exact trusted Tailscale HTTPS host; proxies and redirects disabled",
        }

    def _network_success(
        self,
        request_id: str,
        command: str,
        result: HttpResult,
        *,
        command_id: str | None = None,
    ) -> dict[str, Any]:
        if result.payload.get("ok") is not True or "data" not in result.payload:
            raise AgentClientError("INVALID_RESPONSE", "server success envelope is invalid", status=result.status)
        server_request_id = result.payload.get("requestId")
        return self._success(
            request_id,
            command,
            result.status,
            result.payload["data"],
            command_id=command_id,
            server_request_id=server_request_id if isinstance(server_request_id, str) else None,
        )

    def _success(
        self,
        request_id: str,
        command: str,
        status: int,
        data: Any,
        *,
        command_id: str | None = None,
        server_request_id: str | None = None,
    ) -> dict[str, Any]:
        result: dict[str, Any] = {
            "schemaVersion": RESPONSE_SCHEMA_VERSION,
            "requestId": request_id,
            "command": command,
            "ok": True,
            "status": status,
            "data": redact(data, self.http.token, allow_lease_token=command == "claim"),
        }
        if command_id:
            result["commandId"] = command_id
        if server_request_id:
            result["serverRequestId"] = server_request_id
        return result


def error_response(
    error: AgentClientError,
    *,
    request_id: str = "unknown",
    command: str = "unknown",
    bearer_token: str | None = None,
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "schemaVersion": RESPONSE_SCHEMA_VERSION,
        "requestId": request_id if REQUEST_ID_RE.fullmatch(request_id) else "unknown",
        "command": command if command in COMMANDS else "unknown",
        "ok": False,
        "error": {"code": error.code, "message": safe_text(error, bearer_token)},
    }
    if error.status is not None:
        payload["status"] = error.status
    if error.details:
        payload["error"]["details"] = redact(error.details, bearer_token)
    return payload


def strict_json_loads(text: str) -> Any:
    def reject_constant(value: str) -> None:
        raise ValueError(f"non-standard JSON constant: {value}")

    return json.loads(text, parse_constant=reject_constant)


def process_line(client: WenmaiAgentClient, raw: bytes) -> dict[str, Any]:
    request_id = "unknown"
    command = "unknown"
    try:
        try:
            text = raw.decode("utf-8")
        except UnicodeError as error:
            raise AgentClientError("INVALID_UTF8", "stdin line is not valid UTF-8") from error
        try:
            value = strict_json_loads(text)
        except (ValueError, json.JSONDecodeError, RecursionError) as error:
            raise AgentClientError("INVALID_JSON", "stdin line is not valid strict JSON") from error
        envelope = require_object(value, "request")
        if isinstance(envelope.get("requestId"), str):
            request_id = envelope["requestId"]
        if isinstance(envelope.get("command"), str):
            command = envelope["command"]
        return client.execute(envelope)
    except AgentClientError as error:
        return error_response(
            error,
            request_id=request_id,
            command=command,
            bearer_token=client.http.token,
        )


def bounded_lines(stream: BinaryIO, maximum: int) -> Iterable[bytes | AgentClientError]:
    while True:
        raw = stream.readline(maximum + 1)
        if not raw:
            return
        if len(raw) > maximum:
            while raw and not raw.endswith(b"\n"):
                raw = stream.readline(maximum + 1)
            yield AgentClientError("STDIN_LINE_TOO_LARGE", f"stdin line exceeds {maximum} bytes")
            continue
        if not raw.strip():
            continue
        yield raw


def bounded_request_bytes(value: str) -> int:
    try:
        parsed = int(value)
    except ValueError as error:
        raise argparse.ArgumentTypeError("must be an integer") from error
    if parsed < 1_024 or parsed > SERVER_MAX_REQUEST_BYTES:
        raise argparse.ArgumentTypeError(f"must be in 1024..{SERVER_MAX_REQUEST_BYTES}")
    return parsed


def bounded_configured_bytes(value: str) -> int:
    try:
        parsed = int(value)
    except ValueError as error:
        raise argparse.ArgumentTypeError("must be an integer") from error
    if parsed < 1_024 or parsed > MAX_CONFIGURED_BYTES:
        raise argparse.ArgumentTypeError(f"must be in 1024..{MAX_CONFIGURED_BYTES}")
    return parsed


def bounded_timeout(value: str) -> float:
    try:
        parsed = float(value)
    except ValueError as error:
        raise argparse.ArgumentTypeError("must be a number") from error
    if not math.isfinite(parsed) or parsed < 0.1 or parsed > MAX_TIMEOUT_SECONDS:
        raise argparse.ArgumentTypeError(f"must be finite and in 0.1..{MAX_TIMEOUT_SECONDS}")
    return parsed


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Restricted NDJSON client for the Wenmai Agent API")
    transport = parser.add_mutually_exclusive_group()
    transport.add_argument(
        "--base-url",
        help="explicit HTTP loopback origin; defaults to http://[::1]:3000",
    )
    transport.add_argument(
        "--trusted-tailscale-host",
        help="exact ASCII <machine>.<tailnet>.ts.net host; HTTPS is constructed and verified",
    )
    transport.add_argument("--access-file", help="Wenmai portable access file")
    parser.add_argument("--token-env", default=DEFAULT_TOKEN_ENV)
    parser.add_argument("--timeout-seconds", type=bounded_timeout, default=DEFAULT_TIMEOUT_SECONDS)
    parser.add_argument("--max-request-bytes", type=bounded_request_bytes, default=DEFAULT_MAX_REQUEST_BYTES)
    parser.add_argument("--max-response-bytes", type=bounded_configured_bytes, default=DEFAULT_MAX_RESPONSE_BYTES)
    parser.add_argument("--max-line-bytes", type=bounded_configured_bytes, default=DEFAULT_MAX_LINE_BYTES)
    parser.add_argument("--once", action="store_true", help="process one non-empty NDJSON request and exit")
    parser.add_argument(
        "mode",
        nargs="?",
        choices=["worker", "status"],
        help="worker: keep serving NDJSON on stdio; status: run one health check and exit",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        if args.access_file is not None:
            from wenmai_agent_access_file import load_access_file
            access = load_access_file(args.access_file)
            if access.origin.startswith("https://"):
                base_url, trusted_host = None, access.origin.removeprefix("https://")
            else:
                base_url, trusted_host = access.origin, None
            token = access.token
        else:
            base_url, token, trusted_host = args.base_url, os.environ.get(args.token_env), args.trusted_tailscale_host
        http = AgentHttpClient(
            base_url,
            token,
            trusted_tailscale_host=trusted_host,
            token_environment=args.token_env,
            timeout_seconds=args.timeout_seconds,
            max_request_bytes=args.max_request_bytes,
            max_response_bytes=args.max_response_bytes,
        )
    except AgentClientError as error:
        print(canonical_json(error_response(error)), flush=True)
        return 2
    client = WenmaiAgentClient(http)
    if args.mode == "status":
        envelope = canonical_json({"requestId": "cli-status", "command": "status", "args": {}}).encode("utf-8")
        response = process_line(client, envelope)
        print(canonical_json(response), flush=True)
        return 0 if response.get("ok") else 1
    failed = False
    for item in bounded_lines(sys.stdin.buffer, args.max_line_bytes):
        if isinstance(item, AgentClientError):
            response = error_response(item, bearer_token=http.token)
        else:
            response = process_line(client, item)
        print(canonical_json(response), flush=True)
        failed = failed or not bool(response.get("ok"))
        if args.once:
            break
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
