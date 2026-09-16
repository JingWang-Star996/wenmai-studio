from __future__ import annotations

import ast
import contextlib
import hashlib
import importlib.util
import io
import json
import os
import sys
import tempfile
import threading
import unittest
from unittest import mock
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

ROOT = Path(__file__).resolve().parents[1]
CLIENT_PATH = ROOT / "scripts" / "wenmai_agent_client.py"
CLIENT_SPEC = importlib.util.spec_from_file_location("wenmai_agent_client", CLIENT_PATH)
if CLIENT_SPEC is None or CLIENT_SPEC.loader is None:
    raise RuntimeError("unable to load wenmai_agent_client")
client_module = importlib.util.module_from_spec(CLIENT_SPEC)
sys.modules[CLIENT_SPEC.name] = client_module
CLIENT_SPEC.loader.exec_module(client_module)
ACCESS_PATH = ROOT / "scripts" / "wenmai_agent_access_file.py"
ACCESS_SPEC = importlib.util.spec_from_file_location("wenmai_agent_access_file", ACCESS_PATH)
if ACCESS_SPEC is None or ACCESS_SPEC.loader is None:
    raise RuntimeError("unable to load wenmai_agent_access_file")
access_module = importlib.util.module_from_spec(ACCESS_SPEC)
sys.modules[ACCESS_SPEC.name] = access_module
ACCESS_SPEC.loader.exec_module(access_module)


TOKEN = f"wenmai_agent_{'a' * 32}_{'b' * 32}"
LEASE_TOKEN = "lease-test-token-1234567890"
SHA = "a" * 64
TAILSCALE_HOST = "agent.example.ts.net"
CLIENT_ID = "agent-client-11111111-2222-4333-8444-555555555555"
ROLE_CLIENT_ID = "agent-client-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"


def access_document(origin: str = "http://[::1]:3000", *, mode: str = "viewer", token: str = TOKEN) -> dict[str, object]:
    article_id = "article-allowed"
    task_id: str | None = "task-1" if mode == "editor" else None
    scopes = access_module.EDITOR_SCOPES if mode == "editor" else access_module.VIEWER_SCOPES
    card = {
        "schemaVersion": "wenmai.share-grant/1", "label": "test", "origin": origin,
        "client": {"id": CLIENT_ID, "kind": "agent", "profileName": None},
        "endpoints": {
            "discovery": f"{origin}/.well-known/wenmai-agent.json", "api": f"{origin}/api/agent/v1",
            "health": f"{origin}/api/agent/v1?view=health", "articleList": f"{origin}/api/agent/v1?view=articles",
            "articleDetail": f"{origin}/api/agent/v1?view=article&articleId={article_id}",
        },
        "authentication": {"header": "Authorization: Bearer <Share Grant>", "credentialInUrl": False, "note": "test"},
        "networkPrerequisite": {"transport": "local-loopback" if origin.startswith("http:") else "tailscale-https", "gatewayActivationImplied": False, "note": "test"},
        "grant": {"mode": mode, "resource": {"type": "article", "id": article_id, "label": None, "revisionPolicy": "authoritative-current"}, "taskId": task_id, "expiresAt": (datetime.now(timezone.utc) + timedelta(days=1)).isoformat().replace("+00:00", "Z")},
        "allowedOperations": {"scopes": scopes, "requiresTask": mode == "editor"},
        "ownerOnlyBoundary": {"enforced": True, "forbiddenCapabilities": ["publish"], "note": "test"},
    }
    return {"schemaVersion": "wenmai.agent-access-file/1", "kind": "portable-share-grant", "secret": True, "possessionIsAuthority": True, "exportedAt": "2026-01-01T00:00:00Z", "connectionCard": card, "credential": {"type": "bearer", "header": "Authorization", "scheme": "Bearer", "token": token}, "handling": {"recommendedUnixMode": "0600", "serverStateAuthoritative": True, "gatewayActivationImplied": False, "revokeByClientId": CLIENT_ID, "note": "test"}}


def write_access_file(directory: Path, document: dict[str, object]) -> Path:
    path = directory / "access.json"
    path.write_text(json.dumps(document), encoding="utf-8")
    return path


def role_access_document(role_id: str, origin: str = "http://[::1]:3000") -> dict[str, object]:
    profile = access_module.ROLE_PROFILES[role_id]
    expires_at = (datetime.now(timezone.utc) + timedelta(hours=12)).isoformat().replace("+00:00", "Z")
    local_import = f"{origin}/api/local-import/v1" if profile["localOnly"] else None
    return {"schemaVersion": "wenmai.agent-access-file/1", "kind": "portable-role-grant", "secret": True, "possessionIsAuthority": True, "exportedAt": "2026-01-01T00:00:00Z", "connectionCard": {"schemaVersion": "wenmai.role-grant/1", "label": "role test", "origin": origin, "client": {"id": ROLE_CLIENT_ID, "kind": "agent", "profileName": None}, "endpoints": {"discovery": f"{origin}/.well-known/wenmai-agent.json", "api": f"{origin}/api/agent/v1", "health": f"{origin}/api/agent/v1?view=health", "mcpManifest": f"{origin}/agent/mcp.json", "localImport": local_import}, "authentication": {"header": "Authorization: Bearer <Role Grant>", "credentialInUrl": False, "note": "test"}, "networkPrerequisite": {"transport": "local-loopback" if origin.startswith("http:") else "tailscale-https", "gatewayActivationImplied": False, "note": "test"}, "grant": {"roleId": role_id, "serverRole": profile["serverRole"], "permissionPresetId": profile["permissionPresetId"], "articleScope": {"mode": "all_articles", "articleIds": ["*"], "includesFutureArticles": True}, "taskIds": [], "expiresAt": expires_at}, "allowedOperations": {"scopes": profile["scopes"], "actionIds": profile["actionIds"]}, "ownerOnlyBoundary": {"enforced": True, "forbiddenCapabilities": ["publish"], "note": "test"}}, "credential": {"type": "bearer", "header": "Authorization", "scheme": "Bearer", "token": TOKEN}, "handling": {"recommendedUnixMode": "0600", "serverStateAuthoritative": True, "gatewayActivationImplied": False, "revokeByClientId": ROLE_CLIENT_ID, "note": "test"}}


class ServerState:
    def __init__(self) -> None:
        self.requests: list[dict[str, object]] = []
        self.mode = "normal"
        self.response_data: dict[str, object] | None = None


class TestHandler(BaseHTTPRequestHandler):
    server_version = "WenmaiTest/1.0"

    @property
    def state(self) -> ServerState:
        return self.server.state  # type: ignore[attr-defined]

    def log_message(self, format: str, *args: object) -> None:
        return

    def do_GET(self) -> None:
        self._handle()

    def do_POST(self) -> None:
        self._handle()

    def _handle(self) -> None:
        length = int(self.headers.get("content-length", "0"))
        raw = self.rfile.read(length) if length else b""
        body = json.loads(raw.decode("utf-8")) if raw else None
        self.state.requests.append(
            {
                "method": self.command,
                "path": self.path,
                "headers": {key.lower(): value for key, value in self.headers.items()},
                "body": body,
            }
        )
        if self.state.mode == "redirect":
            self.send_response(302)
            self.send_header("location", "http://127.0.0.1:9/forbidden")
            self.send_header("content-length", "0")
            self.end_headers()
            return
        if self.state.mode == "large":
            self._json(200, {"ok": True, "requestId": "server-large", "data": {"text": "x" * 5000}})
            return
        if self.state.mode == "error_echo":
            self._json(
                409,
                {
                    "ok": False,
                    "requestId": "server-error",
                    "error": {
                        "code": "LEASE_INVALID",
                        "message": f"Bearer {TOKEN} leaseToken={LEASE_TOKEN}",
                    },
                },
            )
            return
        data = self.state.response_data
        if data is None:
            if isinstance(body, dict) and body.get("action") == "claim":
                data = {
                    "task": {"id": body["payload"]["taskId"]},
                    "attempt": {"id": "attempt-1"},
                    "lease": {
                        "id": "lease-1",
                        "taskId": body["payload"]["taskId"],
                        "attemptId": "attempt-1",
                        "expiresAt": "2026-08-17T12:00:00Z",
                        "heartbeatSeq": 0,
                        "leaseToken": LEASE_TOKEN,
                        "shownOnce": True,
                    },
                    "context": {
                        "id": "context-1",
                        "sha256": SHA,
                        "revisionId": "revision-1",
                        "bodySha256": SHA,
                        "corpusSha256": SHA,
                    },
                    "contextUrl": "/api/agent/v1?view=context&taskId=task-1",
                    "bearerEcho": TOKEN,
                }
            else:
                data = {"accepted": body, "path": self.path}
        self._json(200, {"ok": True, "requestId": "server-request-1", "data": data})

    def _json(self, status: int, payload: dict[str, object]) -> None:
        raw = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("content-length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)


class LoopbackServer:
    def __init__(self) -> None:
        self.state = ServerState()
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), TestHandler)
        self.server.state = self.state  # type: ignore[attr-defined]
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    @property
    def origin(self) -> str:
        host, port = self.server.server_address
        return f"http://{host}:{port}"

    def __enter__(self) -> "LoopbackServer":
        self.thread.start()
        return self

    def __exit__(self, exc_type: object, exc: object, traceback: object) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)


def make_client(origin: str, token: str | None = TOKEN, **kwargs: object) -> client_module.WenmaiAgentClient:
    return client_module.WenmaiAgentClient(client_module.AgentHttpClient(origin, token, **kwargs))


def command(name: str, args: dict[str, object] | None = None, request_id: str = "req-test-1") -> dict[str, object]:
    return {"requestId": request_id, "command": name, "args": args or {}}


def run(agent: client_module.WenmaiAgentClient, envelope: dict[str, object]) -> dict[str, object]:
    raw = json.dumps(envelope, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    return client_module.process_line(agent, raw)


def lease_args() -> dict[str, object]:
    return {
        "taskId": "task-1",
        "attemptId": "attempt-1",
        "leaseId": "lease-1",
        "leaseToken": LEASE_TOKEN,
        "contextSha256": SHA,
    }


class ContractTests(unittest.TestCase):
    def test_role_access_files_accept_all_fixed_roles_and_transports(self) -> None:
        with tempfile.TemporaryDirectory() as raw_directory:
            directory = Path(raw_directory)
            for role_id in ("content-steward", "article-worker", "local-registrar"):
                with self.subTest(role_id=role_id):
                    grant = access_module.load_access_file(write_access_file(directory, role_access_document(role_id)))
                    self.assertEqual(grant.origin, "http://[::1]:3000")
            remote_origin = f"https://{TAILSCALE_HOST}"
            grant = access_module.load_access_file(write_access_file(directory, role_access_document("content-steward", remote_origin)))
            self.assertEqual(grant.origin, remote_origin)

    def test_role_access_files_reject_field_ttl_transport_endpoint_scope_and_action_deviation(self) -> None:
        cases: list[dict[str, object]] = []
        unknown = role_access_document("content-steward")
        unknown["connectionCard"]["extra"] = True  # type: ignore[index]
        cases.append(unknown)
        ttl = role_access_document("article-worker")
        ttl["connectionCard"]["grant"]["expiresAt"] = (datetime.now(timezone.utc) + timedelta(days=8)).isoformat().replace("+00:00", "Z")  # type: ignore[index]
        cases.append(ttl)
        transport = role_access_document("local-registrar", f"https://{TAILSCALE_HOST}")
        transport["connectionCard"]["endpoints"]["localImport"] = f"https://{TAILSCALE_HOST}/api/local-import/v1"  # type: ignore[index]
        cases.append(transport)
        endpoint = role_access_document("content-steward")
        endpoint["connectionCard"]["endpoints"]["mcpManifest"] = "http://[::1]:3000/other"  # type: ignore[index]
        cases.append(endpoint)
        scope = role_access_document("article-worker")
        scope["connectionCard"]["allowedOperations"]["scopes"] = ["task.read"]  # type: ignore[index]
        cases.append(scope)
        action = role_access_document("content-steward")
        action["connectionCard"]["allowedOperations"]["actionIds"] = []  # type: ignore[index]
        cases.append(action)
        with tempfile.TemporaryDirectory() as raw_directory:
            directory = Path(raw_directory)
            for index, document in enumerate(cases):
                with self.subTest(index=index):
                    with self.assertRaises(client_module.AgentClientError) as raised:
                        access_module.load_access_file(write_access_file(directory, document))
                    self.assertEqual(raised.exception.code, "ACCESS_FILE_INVALID")

    def test_access_file_accepts_exact_local_and_tailscale_cards(self) -> None:
        with tempfile.TemporaryDirectory() as raw_directory:
            directory = Path(raw_directory)
            local = access_module.load_access_file(write_access_file(directory, access_document()))
            self.assertEqual(local.origin, "http://[::1]:3000")
            self.assertEqual(local.token, TOKEN)
            remote_origin = f"https://{TAILSCALE_HOST}"
            remote = access_module.load_access_file(write_access_file(directory, access_document(remote_origin, mode="editor")))
            self.assertEqual(remote.origin, remote_origin)
            self.assertEqual(remote.token, TOKEN)

    def test_access_file_rejects_unknown_fields_url_token_host_spoof_expiry_and_scope_task_mismatch(self) -> None:
        cases: list[dict[str, object]] = []
        unknown = access_document()
        unknown["extra"] = True
        cases.append(unknown)
        url_token = access_document()
        url_token["connectionCard"]["origin"] = f"http://[::1]:3000?token={TOKEN}"  # type: ignore[index]
        cases.append(url_token)
        spoofed = access_document()
        spoofed["connectionCard"]["origin"] = f"https://{TAILSCALE_HOST}.evil.example"  # type: ignore[index]
        cases.append(spoofed)
        expired = access_document()
        expired["connectionCard"]["grant"]["expiresAt"] = "2000-01-01T00:00:00Z"  # type: ignore[index]
        cases.append(expired)
        mismatch = access_document(mode="editor")
        mismatch["connectionCard"]["grant"]["taskId"] = None  # type: ignore[index]
        cases.append(mismatch)
        with tempfile.TemporaryDirectory() as raw_directory:
            directory = Path(raw_directory)
            for index, document in enumerate(cases):
                with self.subTest(index=index):
                    path = write_access_file(directory, document)
                    with self.assertRaises(client_module.AgentClientError) as raised:
                        access_module.load_access_file(path)
                    self.assertEqual(raised.exception.code, "ACCESS_FILE_INVALID")
                    self.assertNotIn(TOKEN, str(raised.exception))

    def test_access_file_rejects_large_files_and_symlinks_when_supported(self) -> None:
        with tempfile.TemporaryDirectory() as raw_directory:
            directory = Path(raw_directory)
            large = directory / "large.json"
            large.write_bytes(b"x" * (access_module.MAX_ACCESS_FILE_BYTES + 1))
            with self.assertRaises(client_module.AgentClientError):
                access_module.load_access_file(large)
            target = write_access_file(directory, access_document())
            link = directory / "link.json"
            try:
                link.symlink_to(target)
            except (NotImplementedError, OSError):
                self.skipTest("symlink creation unavailable on this platform")
            with self.assertRaises(client_module.AgentClientError):
                access_module.load_access_file(link)

    def test_access_file_cli_uses_file_token_not_environment_token(self) -> None:
        captured: dict[str, object] = {}

        class CapturingHttp:
            def __init__(self, origin: str | None, token: str | None, **kwargs: object) -> None:
                captured["origin"] = origin
                captured["token"] = token
                self.origin = origin or "unused"
                self.token = token

            def request(self, *args: object, **kwargs: object) -> client_module.HttpResult:
                return client_module.HttpResult(200, {"ok": True, "data": {"status": "ok"}})

        with tempfile.TemporaryDirectory() as raw_directory:
            document = access_document()
            path = write_access_file(Path(raw_directory), document)
            with mock.patch.dict(os.environ, {client_module.DEFAULT_TOKEN_ENV: "wrong-environment-token-123456"}, clear=False), mock.patch.object(client_module, "AgentHttpClient", CapturingHttp), contextlib.redirect_stdout(io.StringIO()):
                exit_code = client_module.main(["--access-file", str(path), "status"])
            self.assertEqual(exit_code, 0)
            self.assertEqual(captured["token"], TOKEN)

    def test_public_contracts_are_parseable_linked_and_strict(self) -> None:
        discovery_path = ROOT / "public" / ".well-known" / "wenmai-agent.json"
        discovery = json.loads(discovery_path.read_text(encoding="utf-8"))
        self.assertEqual(discovery["runtime"]["endpoint"], "/api/agent/v1")
        self.assertEqual(discovery["runtime"]["status"], "implemented")
        self.assertEqual(
            discovery["runtime"]["networkModes"]["tailscaleHttps"]["configuration"],
            "--trusted-tailscale-host",
        )
        linked = [discovery["manifest"], discovery["apiContract"], *discovery["schemas"].values()]
        for public_path in linked:
            local_path = ROOT / "public" / str(public_path).lstrip("/")
            self.assertTrue(local_path.is_file(), public_path)
            if local_path.suffix == ".json":
                parsed = json.loads(local_path.read_text(encoding="utf-8"))
                if "schemas" in local_path.parts:
                    self.assertEqual(parsed["$schema"], "https://json-schema.org/draft/2020-12/schema")
                    self.assertFalse(parsed["additionalProperties"])
        api = json.loads((ROOT / "public" / "agent" / "api" / "v1.json").read_text(encoding="utf-8"))
        manifest = json.loads((ROOT / "public" / "agent" / "manifest.json").read_text(encoding="utf-8"))
        self.assertEqual(api["endpoint"], "/api/agent/v1")
        self.assertEqual(
            manifest["client"]["transports"]["tailscaleHttps"]["configuration"],
            "--trusted-tailscale-host <machine>.<tailnet>.ts.net",
        )
        self.assertEqual(api["transport"]["tailscaleHttps"]["configuration"], "--trusted-tailscale-host")
        self.assertEqual(api["transport"]["tailscaleHttps"]["defaultPort"], 443)
        self.assertFalse(api["transport"]["tailscaleHttps"]["rawTailscaleIpAccepted"])
        self.assertEqual(
            set(api["getViews"]),
            {
                "manifest", "health", "tasks", "task", "context", "events", "knowledge", "graph",
                "project_manifest", "project_packages", "project_branches", "project_package",
                "project_diagnostics", "project_slices",
                "project_group_manifest", "project_groups", "project_group",
                "shared_source_manifest", "shared_source", "articles", "article",
            },
        )
        self.assertEqual(
            set(api["authentication"]["projectReads"]["views"]),
            {"project_manifest", "project_packages", "project_branches", "project_package", "project_diagnostics", "project_slices"},
        )
        self.assertFalse(api["authentication"]["projectReads"]["managementCookieAccepted"])
        self.assertEqual(
            set(api["authentication"]["projectReads"]["branchQualifiedViews"]),
            {"project_package", "project_diagnostics", "project_slices"},
        )
        self.assertTrue(set(client_module.MUTATION_COMMANDS).issubset(api["agentActions"]))

    def test_client_source_has_no_arbitrary_execution_or_file_read_primitive(self) -> None:
        source_path = ROOT / "scripts" / "wenmai_agent_client.py"
        tree = ast.parse(source_path.read_text(encoding="utf-8"))
        imported = {
            alias.name.split(".", 1)[0]
            for node in ast.walk(tree)
            if isinstance(node, (ast.Import, ast.ImportFrom))
            for alias in node.names
        }
        self.assertTrue({"subprocess", "pathlib", "shutil"}.isdisjoint(imported))
        forbidden_names = {"open", "exec", "eval", "compile", "__import__"}
        calls = [node for node in ast.walk(tree) if isinstance(node, ast.Call)]
        self.assertFalse(any(isinstance(node.func, ast.Name) and node.func.id in forbidden_names for node in calls))
        self.assertFalse(
            any(
                isinstance(node.func, ast.Attribute)
                and isinstance(node.func.value, ast.Name)
                and node.func.value.id == "os"
                and node.func.attr in {"system", "popen", "startfile"}
                for node in calls
            )
        )


class ClientTests(unittest.TestCase):
    def test_help_works_without_token_and_lists_exact_commands(self) -> None:
        client = make_client("http://127.0.0.1:9", token=None)
        result = client.execute(command("help"))
        self.assertTrue(result["ok"])
        self.assertEqual(tuple(result["data"]["commands"]), client_module.COMMANDS)
        self.assertIn("never publish", result["data"]["releaseMeaning"])

    def test_only_exact_loopback_ip_origins_or_explicit_tailscale_host_are_accepted(self) -> None:
        self.assertEqual(client_module.loopback_origin("http://127.0.0.1:3000/"), "http://127.0.0.1:3000")
        self.assertEqual(client_module.loopback_origin("http://[::1]:3000"), "http://[::1]:3000")
        self.assertEqual(client_module.tailscale_https_origin(TAILSCALE_HOST), f"https://{TAILSCALE_HOST}")
        self.assertEqual(client_module.tailscale_https_origin(TAILSCALE_HOST.upper()), f"https://{TAILSCALE_HOST}")
        self.assertEqual(client_module.resolve_transport_origin(None, TAILSCALE_HOST), f"https://{TAILSCALE_HOST}")
        rejected = [
            "https://127.0.0.1:3000",
            "http://localhost:3000",
            "http://127.0.0.2:3000",
            "http://10.0.0.1:3000",
            "http://user:pass@127.0.0.1:3000",
            "http://127.0.0.1:3000/api",
            "http://127.0.0.1:3000?x=1",
        ]
        for value in rejected:
            with self.subTest(value=value), self.assertRaises(client_module.AgentClientError):
                client_module.loopback_origin(value)
        with self.assertRaises(client_module.AgentClientError):
            client_module.resolve_transport_origin("")
        rejected_tailscale_hosts = [
            "",
            " agent.example.ts.net",
            "agent.example.ts.net ",
            "agent.example.ts.net.",
            "*.example.ts.net",
            "example.ts.net",
            "agent.ts.net",
            "evil.agent.example.ts.net",
            "agent.example.ts.net.evil.example",
            "agent.example.ts.net:443",
            "https://agent.example.ts.net",
            "192.0.2.10",
            "机器.example.ts.net",
        ]
        for value in rejected_tailscale_hosts:
            with self.subTest(value=value), self.assertRaises(client_module.AgentClientError):
                client_module.tailscale_https_origin(value)
        with self.assertRaises(client_module.AgentClientError):
            client_module.resolve_transport_origin("http://127.0.0.1:3000", TAILSCALE_HOST)

    def test_tailscale_mode_constructs_fixed_https_agent_url_and_preserves_header_boundary(self) -> None:
        captured: list[object] = []

        class Response(io.BytesIO):
            status = 200
            headers = {"Content-Type": "application/json", "Content-Length": "65"}

            def __enter__(self) -> "Response":
                return self

            def __exit__(self, exc_type: object, exc: object, traceback: object) -> None:
                self.close()

        class Opener:
            def open(self, request: object, timeout: float) -> Response:
                captured.append(request)
                return Response(b'{"ok":true,"requestId":"remote-1","data":{"status":"available"}}')

        http = client_module.AgentHttpClient(None, TOKEN, trusted_tailscale_host=TAILSCALE_HOST)
        http.opener = Opener()
        result = client_module.WenmaiAgentClient(http).execute(command("manifest"))
        self.assertTrue(result["ok"])
        self.assertEqual(len(captured), 1)
        request = captured[0]
        self.assertEqual(request.full_url, f"https://{TAILSCALE_HOST}/api/agent/v1?view=manifest")
        headers = {key.lower(): value for key, value in request.header_items()}
        self.assertEqual(headers["authorization"], f"Bearer {TOKEN}")
        self.assertEqual(headers["x-wenmai-agent-protocol"], "wenmai.agent/1.0")
        for forbidden in ("origin", "cookie", "x-wenmai-browser-binding", "x-wenmai-csrf", "x-wenmai-write"):
            self.assertNotIn(forbidden, headers)

    def test_transport_cli_modes_are_mutually_exclusive(self) -> None:
        args = client_module.parse_args(["--trusted-tailscale-host", TAILSCALE_HOST, "status"])
        self.assertIsNone(args.base_url)
        self.assertEqual(args.trusted_tailscale_host, TAILSCALE_HOST)
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
            client_module.parse_args([
                "--base-url", "http://127.0.0.1:3000",
                "--trusted-tailscale-host", TAILSCALE_HOST,
                "status",
            ])

    def test_manifest_uses_fixed_endpoint_bearer_and_no_browser_write_headers(self) -> None:
        with LoopbackServer() as server:
            result = make_client(server.origin).execute(command("manifest"))
            self.assertTrue(result["ok"])
            request = server.state.requests[-1]
            self.assertEqual(request["method"], "GET")
            parsed = urlsplit(str(request["path"]))
            self.assertEqual(parsed.path, "/api/agent/v1")
            self.assertEqual(parse_qs(parsed.query), {"view": ["manifest"]})
            headers = request["headers"]
            self.assertEqual(headers["authorization"], f"Bearer {TOKEN}")
            self.assertEqual(headers["x-wenmai-agent-protocol"], "wenmai.agent/1.0")
            self.assertNotIn("origin", headers)
            self.assertNotIn("x-wenmai-write", headers)

    def test_ui_status_positional_command_runs_once_against_health_view(self) -> None:
        with LoopbackServer() as server:
            output = io.StringIO()
            prior = os.environ.get(client_module.DEFAULT_TOKEN_ENV)
            os.environ[client_module.DEFAULT_TOKEN_ENV] = TOKEN
            try:
                with contextlib.redirect_stdout(output):
                    exit_code = client_module.main(["--base-url", server.origin, "status"])
            finally:
                if prior is None:
                    os.environ.pop(client_module.DEFAULT_TOKEN_ENV, None)
                else:
                    os.environ[client_module.DEFAULT_TOKEN_ENV] = prior
            self.assertEqual(exit_code, 0)
            response = json.loads(output.getvalue())
            self.assertTrue(response["ok"])
            self.assertEqual(response["command"], "status")
            parsed = urlsplit(str(server.state.requests[-1]["path"]))
            self.assertEqual(parsed.path, "/api/agent/v1")
            self.assertEqual(parse_qs(parsed.query), {"view": ["health"]})

    def test_worker_positional_mode_selects_long_running_stdio_contract(self) -> None:
        args = client_module.parse_args(["--base-url", "http://[::1]:3000", "worker"])
        self.assertEqual(args.mode, "worker")
        self.assertFalse(args.once)
        self.assertEqual(client_module.loopback_origin(args.base_url), "http://[::1]:3000")

    def test_all_read_commands_map_to_stable_query_views(self) -> None:
        cases = [
            ("list_tasks", {}, {"view": ["tasks"]}),
            ("get_task", {"taskId": "task-1"}, {"view": ["task"], "taskId": ["task-1"]}),
            (
                "get_context",
                {"taskId": "task-1", "contextId": "context-1"},
                {"view": ["context"], "taskId": ["task-1"], "contextId": ["context-1"]},
            ),
            ("search_knowledge", {"query": "图谱", "limit": 7}, {"view": ["knowledge"], "q": ["图谱"], "limit": ["7"]}),
            (
                "get_subgraph",
                {"nodeIds": ["article-1", "topic-1"], "depth": 2, "limit": 80},
                {"view": ["graph"], "seed": ["article-1,topic-1"], "depth": ["2"], "limit": ["80"]},
            ),
        ]
        with LoopbackServer() as server:
            agent = make_client(server.origin)
            for index, (name, args, expected) in enumerate(cases):
                with self.subTest(command=name):
                    result = agent.execute(command(name, args, request_id=f"req-read-{index}"))
                    self.assertTrue(result["ok"])
                    parsed = urlsplit(str(server.state.requests[-1]["path"]))
                    self.assertEqual(parsed.path, "/api/agent/v1")
                    self.assertEqual(parse_qs(parsed.query), expected)

    def test_claim_uses_stable_command_id_and_exposes_only_required_lease_token(self) -> None:
        with LoopbackServer() as server:
            agent = make_client(server.origin)
            result = agent.execute(command("claim", {"taskId": "task-1"}, request_id="req-stable-1"))
            expected = "wmcmd-" + hashlib.sha256(b"wenmai.agent/1.0\x00req-stable-1").hexdigest()[:32]
            self.assertEqual(result["commandId"], expected)
            self.assertEqual(result["data"]["lease"]["leaseToken"], LEASE_TOKEN)
            self.assertEqual(result["data"]["bearerEcho"], "<redacted>")
            request = server.state.requests[-1]
            self.assertEqual(request["method"], "POST")
            self.assertEqual(urlsplit(str(request["path"])).path, "/api/agent/v1")
            self.assertEqual(
                request["body"],
                {"action": "claim", "commandId": expected, "payload": {"taskId": "task-1"}},
            )
            second = agent.execute(command("claim", {"taskId": "task-2"}, request_id="req-stable-1"))
            self.assertEqual(second["commandId"], expected)

    def test_administrator_bridge_accepts_only_three_task_actions_and_explicit_command_id(self) -> None:
        args = {
            "action": "cancel_task",
            "commandId": "admin-cancel-task-1",
            "payload": {"taskId": "task-1", "expectedLockVersion": 3, "note": "owner delegated task cancellation"},
        }
        with LoopbackServer() as server:
            agent = make_client(server.origin)
            result = agent.execute(command("admin_action", args, request_id="admin-request-1"))
            self.assertTrue(result["ok"])
            self.assertEqual(result["commandId"], args["commandId"])
            request = server.state.requests[-1]
            self.assertEqual(urlsplit(str(request["path"])).path, "/api/agent/v1")
            self.assertEqual(
                request["body"],
                {"action": "cancel_task", "commandId": args["commandId"], "payload": args["payload"]},
            )

            for forbidden_action in (
                "issue_client", "revoke_client", "decide_approval", "merge_revision",
                "create_publication_branch", "attach_branch", "register_publication_version",
                "publish.capability.consume", "login", "external_publish",
            ):
                with self.subTest(action=forbidden_action):
                    before = len(server.state.requests)
                    rejected = run(agent, command("admin_action", {**args, "action": forbidden_action}, f"reject-{forbidden_action}"))
                    self.assertFalse(rejected["ok"])
                    self.assertEqual(rejected["error"]["code"], "ACTION_FORBIDDEN")
                    self.assertEqual(len(server.state.requests), before)

    def test_administrator_bridge_rejects_sensitive_payload_fields_before_network(self) -> None:
        with LoopbackServer() as server:
            agent = make_client(server.origin)
            result = run(agent, command("admin_action", {
                "action": "update_task",
                "commandId": "admin-update-task-1",
                "payload": {"taskId": "task-1", "metadata": {"password": "forbidden"}},
            }, "admin-sensitive-1"))
            self.assertFalse(result["ok"])
            self.assertEqual(result["error"]["code"], "SENSITIVE_FIELD_FORBIDDEN")
            self.assertEqual(server.state.requests, [])

    def test_super_administrator_bridge_is_exact_local_and_routes_only_frozen_actions(self) -> None:
        class RecordingHttp:
            def __init__(self, origin: str = client_module.DEFAULT_BASE_URL) -> None:
                self.origin = origin
                self.token = TOKEN
                self.calls: list[dict[str, object]] = []

            def request(
                self,
                method: str,
                *,
                query: list[tuple[str, str]],
                body: dict[str, object] | None = None,
                api_path: str = client_module.API_PATH,
            ) -> client_module.HttpResult:
                self.calls.append({"method": method, "query": query, "body": body, "apiPath": api_path})
                return client_module.HttpResult(
                    200,
                    {"ok": True, "requestId": "super-admin-server", "data": {"accepted": True}},
                )

        expected = {
            "decide_approval": (client_module.API_PATH, "decide_approval", "envelope"),
            "decide_patch": (client_module.PROJECT_PACKAGE_API_PATH, "decide_patch", "envelope"),
            "create_publication_branch": (client_module.WORKSPACE_API_PATH, "create_publication_branch", "flat"),
            "save_working_copy": (client_module.WORKSPACE_API_PATH, "save_working_copy", "flat"),
            "commit_revision": (client_module.WORKSPACE_API_PATH, "commit_revision", "flat"),
            "attach_branch": (client_module.PROJECT_PACKAGE_API_PATH, "attach_branch", "envelope"),
            "register_publication_version": (
                client_module.PROJECT_PACKAGE_API_PATH,
                "register_publication_version",
                "envelope",
            ),
            "merge_revision": (client_module.WORKSPACE_API_PATH, "merge_revision", "flat"),
            "consume_publish_capability": (client_module.PUBLISH_CAPABILITY_API_PATH, "consume", "envelope"),
        }
        for index, (action, (api_path, route_action, envelope_kind)) in enumerate(expected.items(), start=1):
            with self.subTest(action=action):
                http = RecordingHttp()
                agent = client_module.WenmaiAgentClient(http)
                command_id = f"super-admin-command-{index}"
                payload = {"marker": action}
                result = agent.execute(command("super_admin_action", {
                    "action": action,
                    "commandId": command_id,
                    "payload": payload,
                }, request_id=f"super-admin-request-{index}"))
                self.assertTrue(result["ok"])
                self.assertEqual(len(http.calls), 1)
                call = http.calls[0]
                self.assertEqual(call["apiPath"], api_path)
                expected_body = (
                    {"action": route_action, "commandId": command_id, "payload": payload}
                    if envelope_kind == "envelope"
                    else {"action": route_action, "commandId": command_id, **payload}
                )
                self.assertEqual(call["body"], expected_body)

        forbidden_http = RecordingHttp()
        forbidden = run(client_module.WenmaiAgentClient(forbidden_http), command("super_admin_action", {
            "action": "issue_client",
            "commandId": "super-admin-forbidden-1",
            "payload": {},
        }, "super-admin-forbidden-request"))
        self.assertFalse(forbidden["ok"])
        self.assertEqual(forbidden["error"]["code"], "ACTION_FORBIDDEN")
        self.assertEqual(forbidden_http.calls, [])

        remote_http = RecordingHttp("https://machine.tailnet.ts.net")
        remote = run(client_module.WenmaiAgentClient(remote_http), command("super_admin_action", {
            "action": "decide_approval",
            "commandId": "super-admin-remote-1",
            "payload": {},
        }, "super-admin-remote-request"))
        self.assertFalse(remote["ok"])
        self.assertEqual(remote["error"]["code"], "LOCAL_SUPER_ADMIN_REQUIRED")
        self.assertEqual(remote_http.calls, [])

        reserved_http = RecordingHttp()
        reserved = run(client_module.WenmaiAgentClient(reserved_http), command("super_admin_action", {
            "action": "merge_revision",
            "commandId": "super-admin-reserved-1",
            "payload": {"action": "issue_client"},
        }, "super-admin-reserved-request"))
        self.assertFalse(reserved["ok"])
        self.assertEqual(reserved["error"]["code"], "RESERVED_FIELD_FORBIDDEN")
        self.assertEqual(reserved_http.calls, [])

    def test_heartbeat_binds_full_lease_and_requires_positive_sequence(self) -> None:
        with LoopbackServer() as server:
            args = {**lease_args(), "heartbeatSeq": 4}
            result = make_client(server.origin).execute(command("heartbeat", args))
            self.assertTrue(result["ok"])
            body = server.state.requests[-1]["body"]
            self.assertEqual(body["action"], "heartbeat")
            self.assertEqual(body["payload"], args)
            bad = run(make_client(server.origin), command("heartbeat", {**args, "heartbeatSeq": 0}, "req-bad-heartbeat"))
            self.assertFalse(bad["ok"])
            self.assertEqual(bad["error"]["code"], "INVALID_REQUEST")

    def test_progress_and_release_use_real_route_payloads(self) -> None:
        progress = {
            **lease_args(),
            "phase": "drafting",
            "progressPercent": 50,
            "currentAction": "重写第二节",
            "nextAction": "运行门禁",
            "blocker": "",
            "message": "已完成结构调整",
            "evidence": ["artifact-1"],
        }
        with LoopbackServer() as server:
            agent = make_client(server.origin)
            self.assertTrue(agent.execute(command("progress", progress))["ok"])
            self.assertEqual(server.state.requests[-1]["body"]["payload"], progress)
            release = {**lease_args(), "note": "保存 checkpoint 后释放租约"}
            self.assertTrue(agent.execute(command("release", release, "req-release"))["ok"])
            self.assertEqual(server.state.requests[-1]["body"]["action"], "release")
            self.assertEqual(server.state.requests[-1]["body"]["payload"], release)

    def test_propose_revision_binds_cas_head_and_only_posts_candidate_payload(self) -> None:
        args = {
            **lease_args(),
            "expectedHeadRevisionId": "revision-base-1",
            "title": "候选文章标题",
            "bodyText": "# 候选正文\n\n只推进 Agent 专属分支。",
            "summary": "结构性改写",
            "revisionTitle": "Agent 提案一",
        }
        with LoopbackServer() as server:
            result = make_client(server.origin).execute(command("propose_revision", args, "req-revision-1"))
            self.assertTrue(result["ok"])
            request = server.state.requests[-1]
            self.assertEqual(request["body"]["action"], "propose_revision")
            self.assertEqual(request["body"]["payload"], args)
            self.assertTrue(str(result["commandId"]).startswith("wmcmd-"))
            missing_head = run(
                make_client(server.origin),
                command("propose_revision", {key: value for key, value in args.items() if key != "expectedHeadRevisionId"}, "req-revision-bad"),
            )
            self.assertFalse(missing_head["ok"])
            self.assertEqual(missing_head["error"]["code"], "INVALID_REQUEST")

    def test_artifact_rejects_local_paths_and_enforces_size(self) -> None:
        base = {
            **lease_args(),
            "kind": "article_draft",
            "title": "候选稿",
            "contentRef": "artifact:task-1/draft-1",
            "sha256": SHA,
            "mediaType": "text/markdown",
            "sizeBytes": 123,
            "artifactPayload": {"status": "draft", "claims": ["artifact_created"]},
        }
        with LoopbackServer() as server:
            agent = make_client(server.origin)
            accepted = agent.execute(command("add_artifact", base))
            self.assertTrue(accepted["ok"])
            self.assertEqual(server.state.requests[-1]["body"]["payload"], base)
            for invalid in [
                {**base, "contentRef": "C:\\Users\\example\\draft.md"},
                {**base, "contentRef": "file:///tmp/draft.md"},
                {**base, "sizeBytes": 1_000_000_001},
                {**base, "mediaType": "bad mime"},
            ]:
                with self.subTest(invalid=invalid):
                    result = run(agent, command("add_artifact", invalid, "req-invalid-artifact"))
                    self.assertFalse(result["ok"])
                    self.assertEqual(result["error"]["code"], "INVALID_REQUEST")

    def test_inline_artifact_is_bound_to_utf8_size_and_sha_without_file_read(self) -> None:
        inline = "候选正文\n第二行"
        encoded = inline.encode("utf-8")
        args = {
            **lease_args(),
            "kind": "article_draft",
            "title": "内联候选稿",
            "contentRef": "agent-inline:task-1-draft-2",
            "mediaType": "text/markdown",
            "artifactPayload": {"status": "draft"},
            "inlineContent": inline,
        }
        with LoopbackServer() as server:
            agent = make_client(server.origin)
            accepted = agent.execute(command("add_artifact", args, "req-inline"))
            self.assertTrue(accepted["ok"])
            posted = server.state.requests[-1]["body"]["payload"]
            self.assertEqual(posted["inlineContent"], inline)
            self.assertEqual(posted["sha256"], hashlib.sha256(encoded).hexdigest())
            self.assertEqual(posted["sizeBytes"], len(encoded))
            mismatch = run(agent, command("add_artifact", {**args, "sha256": SHA}, "req-inline-bad"))
            self.assertFalse(mismatch["ok"])
            self.assertEqual(mismatch["error"]["code"], "INVALID_REQUEST")

    def test_request_limit_fails_before_network(self) -> None:
        with LoopbackServer() as server:
            agent = make_client(server.origin, max_request_bytes=1024)
            args = {
                **lease_args(),
                "kind": "article_draft",
                "title": "候选稿",
                "contentRef": "artifact:task-1/draft-1",
                "sha256": SHA,
                "mediaType": "text/markdown",
                "sizeBytes": 100,
                "artifactPayload": {"text": "字" * 2000},
            }
            result = run(agent, command("add_artifact", args))
            self.assertFalse(result["ok"])
            self.assertEqual(result["error"]["code"], "PAYLOAD_TOO_LARGE")
            self.assertEqual(server.state.requests, [])

    def test_response_limit_and_redirect_are_rejected(self) -> None:
        with LoopbackServer() as server:
            server.state.mode = "large"
            oversized = run(make_client(server.origin, max_response_bytes=1024), command("manifest"))
            self.assertFalse(oversized["ok"])
            self.assertEqual(oversized["error"]["code"], "RESPONSE_TOO_LARGE")
        with LoopbackServer() as server:
            server.state.mode = "redirect"
            redirected = run(make_client(server.origin), command("manifest"))
            self.assertFalse(redirected["ok"])
            self.assertEqual(redirected["error"]["code"], "REDIRECT_FORBIDDEN")
            self.assertEqual(len(server.state.requests), 1)

    def test_http_openers_disable_system_proxies_and_source_keeps_tls_verification(self) -> None:
        clients = [
            client_module.AgentHttpClient("http://127.0.0.1:3000", TOKEN),
            client_module.AgentHttpClient(None, TOKEN, trusted_tailscale_host=TAILSCALE_HOST),
        ]
        for client in clients:
            self.assertTrue(any(isinstance(handler, client_module.NoRedirectHandler) for handler in client.opener.handlers))
        source = CLIENT_PATH.read_text(encoding="utf-8")
        self.assertIn("build_opener(ProxyHandler({}), NoRedirectHandler())", source)
        for forbidden in ("_create_unverified_context", "CERT_NONE", "check_hostname = False", "check_hostname=False"):
            self.assertNotIn(forbidden, source)

    def test_bearer_and_lease_tokens_are_redacted_from_error_output(self) -> None:
        with LoopbackServer() as server:
            server.state.mode = "error_echo"
            result = run(make_client(server.origin), command("manifest"))
            serialized = json.dumps(result)
            self.assertFalse(result["ok"])
            self.assertNotIn(TOKEN, serialized)
            self.assertNotIn(LEASE_TOKEN, serialized)
            self.assertEqual(result["error"]["details"]["serverCode"], "LEASE_INVALID")

    def test_strict_ndjson_and_bounded_lines(self) -> None:
        agent = make_client("http://127.0.0.1:9", token=None)
        invalid = client_module.process_line(agent, b'{"requestId":"r","command":"help","args":{"x":NaN}}')
        self.assertFalse(invalid["ok"])
        self.assertEqual(invalid["error"]["code"], "INVALID_JSON")
        stream = io.BytesIO(b"x" * 20 + b"\n" + b'{}\n')
        items = list(client_module.bounded_lines(stream, 10))
        self.assertIsInstance(items[0], client_module.AgentClientError)
        self.assertEqual(items[1], b'{}\n')

    def test_timeout_and_byte_configuration_are_bounded_even_for_direct_use(self) -> None:
        for kwargs in [
            {"timeout_seconds": float("inf")},
            {"timeout_seconds": 0.01},
            {"max_request_bytes": 2_200_001},
            {"max_response_bytes": 16_777_217},
        ]:
            with self.subTest(kwargs=kwargs), self.assertRaises(client_module.AgentClientError):
                client_module.AgentHttpClient("http://127.0.0.1:3000", TOKEN, **kwargs)

    def test_unknown_fields_and_missing_lease_binding_are_rejected(self) -> None:
        agent = make_client("http://127.0.0.1:9")
        unknown = run(agent, {"requestId": "req-1", "command": "help", "args": {}, "shell": "whoami"})
        self.assertFalse(unknown["ok"])
        self.assertEqual(unknown["error"]["code"], "INVALID_REQUEST")
        missing = run(agent, command("release", {"taskId": "task-1", "note": "release"}, "req-missing"))
        self.assertFalse(missing["ok"])
        self.assertEqual(missing["error"]["code"], "INVALID_REQUEST")


if __name__ == "__main__":
    unittest.main(verbosity=2)
