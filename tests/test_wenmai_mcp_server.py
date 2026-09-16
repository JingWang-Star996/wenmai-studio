from __future__ import annotations

import contextlib
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
SCRIPTS = ROOT / "scripts"


def load_module(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"unable to load {name}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


client_module = load_module("wenmai_agent_client", SCRIPTS / "wenmai_agent_client.py")
access_module = load_module("wenmai_agent_access_file", SCRIPTS / "wenmai_agent_access_file.py")
mcp_module = load_module("wenmai_mcp_server", SCRIPTS / "wenmai_mcp_server.py")

TOKEN = f"wenmai_agent_{'c' * 32}_{'d' * 32}"
LEASE_TOKEN = "lease-token-safe-to-return-1234567890"
SHA = "a" * 64
TAILSCALE_HOST = "agent.example.ts.net"
ACCESS_CLIENT_ID = "agent-client-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"


def mcp_access_document() -> dict[str, object]:
    origin = "http://[::1]:3000"
    expires_at = (datetime.now(timezone.utc) + timedelta(days=1)).isoformat().replace("+00:00", "Z")
    return {"schemaVersion": "wenmai.agent-access-file/1", "kind": "portable-share-grant", "secret": True, "possessionIsAuthority": True, "exportedAt": "2026-01-01T00:00:00Z", "connectionCard": {"schemaVersion": "wenmai.share-grant/1", "label": "test", "origin": origin, "client": {"id": ACCESS_CLIENT_ID, "kind": "agent", "profileName": None}, "endpoints": {"discovery": f"{origin}/.well-known/wenmai-agent.json", "api": f"{origin}/api/agent/v1", "health": f"{origin}/api/agent/v1?view=health", "articleList": f"{origin}/api/agent/v1?view=articles", "articleDetail": f"{origin}/api/agent/v1?view=article&articleId=article-allowed"}, "authentication": {"header": "Authorization: Bearer <Share Grant>", "credentialInUrl": False, "note": "test"}, "networkPrerequisite": {"transport": "local-loopback", "gatewayActivationImplied": False, "note": "test"}, "grant": {"mode": "viewer", "resource": {"type": "article", "id": "article-allowed", "label": None, "revisionPolicy": "authoritative-current"}, "taskId": None, "expiresAt": expires_at}, "allowedOperations": {"scopes": ["article.read"], "requiresTask": False}, "ownerOnlyBoundary": {"enforced": True, "forbiddenCapabilities": ["publish"], "note": "test"}}, "credential": {"type": "bearer", "header": "Authorization", "scheme": "Bearer", "token": TOKEN}, "handling": {"recommendedUnixMode": "0600", "serverStateAuthoritative": True, "gatewayActivationImplied": False, "revokeByClientId": ACCESS_CLIENT_ID, "note": "test"}}


class State:
    def __init__(self) -> None:
        self.requests: list[dict[str, object]] = []
        self.package_article = "article-allowed"
        self.scopes = ["knowledge.read", "task.read", "task.claim", "task.progress", "package.read", "package.patch.propose"]


class Handler(BaseHTTPRequestHandler):
    server_version = "WenmaiMcpTest/1.0"

    @property
    def state(self) -> State:
        return self.server.state  # type: ignore[attr-defined]

    def log_message(self, format: str, *args: object) -> None:
        return

    def do_GET(self) -> None:
        parsed = urlsplit(self.path)
        query = parse_qs(parsed.query)
        self._record(None)
        if parsed.path in {"/agent/manifest.json", "/agent/api/v1.json"}:
            self._text(200, json.dumps({"schemaVersion": "test/1.0", "path": parsed.path}, ensure_ascii=False), "application/json")
            return
        if parsed.path == "/agent/prompts/system.md":
            self._text(200, "# 文脉 Agent\n\n候选完成不等于批准。", "text/markdown")
            return
        if parsed.path == "/api/capabilities":
            self._json({"elements": [{"id": "skill-1", "kind": "skill", "name": "示例 Skill"}], "total": 1})
            return
        if parsed.path == "/api/corpus/v1":
            if query.get("view", [""])[0] != "lineage":
                self._error(404, "VIEW_NOT_FOUND", "unknown corpus view")
                return
            article_id = query.get("articleId", [""])[0]
            self._json({
                "seed": article_id,
                "depth": int(query.get("depth", ["2"])[0]),
                "nodes": [{"id": article_id, "nodeType": "content_identity"}, {"id": "artifact-1", "nodeType": "artifact"}],
                "edges": [{"id": "edge-1", "relationType": "artifact_of", "source": "artifact-1", "target": article_id, "status": "confirmed", "evidenceRefs": ["evidence-1"]}],
                "evidence": [{"id": "evidence-1", "strength": "strong"}],
                "bodyTextIncluded": False,
            })
            return
        if parsed.path == "/api/project-package/v1":
            self._error(401, "MANAGEMENT_AUTH_REQUIRED", "browser management credentials required")
            return
        if parsed.path == "/api/agent/v1":
            view = query.get("view", [""])[0]
            if view != "manifest" and self.headers.get("authorization") != f"Bearer {TOKEN}":
                self._error(401, "AUTH_REQUIRED", "missing token")
                return
            if view.startswith("project_") and "package.read" not in self.state.scopes:
                self._error(403, "SCOPE_DENIED", "package.read required")
                return
            if view == "manifest":
                self._json({"schemaVersion": "wenmai.agent-manifest/1.0", "status": "available"})
            elif view == "health":
                self._json({
                    "service": "wenmai-agent-control",
                    "clients": [{
                        "id": "client-1",
                        "scopes": self.state.scopes,
                        "articleIds": ["article-allowed"],
                        "taskIds": ["task-1"],
                        "note": TOKEN,
                    }],
                    "counts": {"tasks": 1},
                })
            elif view == "tasks":
                self._json({"tasks": [{"id": "task-1", "articleId": "article-allowed"}]})
            elif view == "task":
                self._json({
                    "task": {"id": query.get("taskId", [""])[0]},
                    "contextSnapshots": [{
                        "id": "context-1",
                        "packageBaseline": {"packageId": "package-allowed", "targetModuleKey": "module-target"},
                        "guidanceChecklist": {
                            "schemaVersion": "wenmai-article-guidance-checklist/1.0.0",
                            "checklistSha256": SHA,
                            "summary": {"passed": 8, "pending": 0, "blocked": 0, "humanRequired": 0},
                        },
                    }],
                    "packagePatchProposals": [{"id": "patch-1", "status": "candidate", "targetModuleKey": "module-target"}],
                    "events": [],
                })
            elif view == "context":
                self._json({"contextSnapshot": {"id": "context-1", "sha256": SHA}})
            elif view == "knowledge":
                self._json({"results": [{"articleId": "article-allowed", "title": "知识结果"}]})
            elif view == "graph":
                self._json({"nodes": [{"id": "article-allowed"}], "edges": []})
            elif view == "project_manifest":
                self._json({"apiVersion": "wenmai-agent-project-read-v1", "requiredScope": "package.read"})
            elif view == "project_groups":
                self._json({"groups": [{
                    "group": {"id": "group-allowed", "title": "完整授权组", "status": "active", "lockVersion": 1},
                    "memberCount": 1,
                    "edgeCount": 0,
                    "storedTopologySha256": SHA,
                    "detailRequiredForTopology": True,
                }], "readOnly": True, "scopeContract": "complete_nonempty_group_membership_required"})
            elif view == "project_group":
                group_id = query.get("groupId", [""])[0]
                if group_id != "group-allowed":
                    self._error(403, "OBJECT_SCOPE_DENIED", "partial group")
                    return
                self._json({"group": {"id": group_id, "title": "完整授权组"}, "members": [{"articleId": "article-allowed"}], "edges": [], "topology": {"groupId": group_id}, "integrityStatus": "valid", "readOnly": True, "scopeContract": "complete_group_membership_required"})
            elif view == "project_packages":
                self._json({"packages": [
                    {"id": "package-allowed", "articleId": "article-allowed", "title": "可访问工程"},
                ], "scopeFiltered": True})
            elif view == "project_branches":
                package_id = query.get("packageId", [""])[0]
                if package_id != "package-allowed":
                    self._error(404, "PACKAGE_NOT_FOUND", "not found")
                    return
                self._json({"package": {"id": package_id, "articleId": "article-allowed"}, "branches": [
                    {"branchId": "branch-main", "name": "main", "attached": True},
                ]})
            elif view in {"project_package", "project_diagnostics", "project_slices"}:
                package_id = query.get("packageId", [""])[0]
                branch_id = query.get("branchId", [""])[0]
                if package_id != "package-allowed":
                    self._error(404, "PACKAGE_NOT_FOUND", "not found")
                    return
                if branch_id != "branch-main":
                    self._error(404, "PACKAGE_BRANCH_NOT_FOUND", "not found")
                    return
                if view == "project_package":
                    self._json({"package": {"id": package_id, "articleId": "article-allowed"}, "selectedBranchId": branch_id, "composition": {"id": "composition-1"}, "workingCopy": {"dirty": False}})
                elif view == "project_diagnostics":
                    self._json({"diagnosisRuns": [{"id": "diagnosis-1", "branchId": branch_id}], "issues": []})
                else:
                    self._json({"slices": [{"id": "slice-1", "branchId": branch_id, "sliceKind": "demo"}]})
            else:
                self._error(404, "VIEW_NOT_FOUND", "unknown agent view")
            return
        self._error(404, "NOT_FOUND", "unknown path")

    def do_POST(self) -> None:
        length = int(self.headers.get("content-length", "0"))
        raw = self.rfile.read(length)
        body = json.loads(raw.decode("utf-8"))
        self._record(body)
        if urlsplit(self.path).path != "/api/agent/v1":
            self._error(404, "NOT_FOUND", "unknown path")
            return
        if self.headers.get("authorization") != f"Bearer {TOKEN}":
            self._error(401, "AUTH_REQUIRED", "missing token")
            return
        action = body.get("action")
        if action == "propose_package_patch":
            if "package.patch.propose" not in self.state.scopes:
                self._error(403, "SCOPE_DENIED", "package.patch.propose required")
                return
            self._json({
                "patchProposal": {"id": "patch-1", "status": "candidate", "packageId": body["payload"]["packageId"], "branchId": body["payload"]["branchId"]},
                "boundary": {"candidateOnly": True, "compositionCreated": False, "articleBranchAdvanced": False, "targetModuleKey": "module-target"},
            })
            return
        if action == "claim":
            self._json({
                "task": {"id": body["payload"]["taskId"]},
                "attempt": {"id": "attempt-1"},
                "lease": {"id": "lease-1", "leaseToken": LEASE_TOKEN},
                "bearerEcho": TOKEN,
            })
            return
        self._json({"accepted": action})

    def _record(self, body: object) -> None:
        self.state.requests.append({
            "method": self.command,
            "path": self.path,
            "authorization": self.headers.get("authorization"),
            "origin": self.headers.get("origin"),
            "cookie": self.headers.get("cookie"),
            "browserBinding": self.headers.get("x-wenmai-browser-binding"),
            "csrf": self.headers.get("x-wenmai-csrf"),
            "body": body,
        })

    def _json(self, data: dict[str, object]) -> None:
        self._raw(200, {"ok": True, "requestId": "server-request", "data": data})

    def _error(self, status: int, code: str, message: str) -> None:
        self._raw(status, {"ok": False, "requestId": "server-error", "error": {"code": code, "message": message}})

    def _raw(self, status: int, payload: dict[str, object]) -> None:
        raw = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("content-length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def _text(self, status: int, text: str, content_type: str) -> None:
        raw = text.encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", f"{content_type}; charset=utf-8")
        self.send_header("content-length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)


class LoopbackServer:
    def __init__(self) -> None:
        self.state = State()
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
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


def rpc(request_id: object, method: str, params: dict[str, object] | None = None) -> dict[str, object]:
    message: dict[str, object] = {"jsonrpc": "2.0", "id": request_id, "method": method}
    if params is not None:
        message["params"] = params
    return message


class WenmaiMcpTests(unittest.TestCase):
    def setUp(self) -> None:
        self.loopback = LoopbackServer()
        self.loopback.__enter__()
        self.server = mcp_module.WenmaiMcpServer(
            self.loopback.origin,
            TOKEN,
            token_environment="WENMAI_AGENT_TOKEN",
            timeout_seconds=2,
        )

    def tearDown(self) -> None:
        self.loopback.__exit__(None, None, None)

    def tool_call(self, name: str, arguments: dict[str, object] | None = None) -> dict[str, object]:
        response = self.server.handle(rpc("rpc-1", "tools/call", {"name": name, "arguments": arguments or {}}))
        self.assertIsInstance(response, dict)
        return response["result"]  # type: ignore[index]

    def test_initialize_and_discovery_are_protocol_complete(self) -> None:
        response = self.server.handle(rpc(1, "initialize", {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "test", "version": "1"}}))
        result = response["result"]  # type: ignore[index]
        self.assertEqual(result["protocolVersion"], "2025-06-18")
        self.assertEqual(set(result["capabilities"]), {"tools", "resources", "prompts"})
        tools = self.server.handle(rpc(2, "tools/list"))["result"]["tools"]  # type: ignore[index]
        self.assertGreaterEqual(len(tools), 22)
        self.assertNotIn("wenmai_complete_task", {item["name"] for item in tools})
        mutation = next(item for item in tools if item["name"] == "wenmai_report_progress")
        self.assertIn("commandId", mutation["inputSchema"]["required"])
        self.assertFalse(mutation["annotations"]["readOnlyHint"])
        self.assertTrue(mutation["annotations"]["idempotentHint"])
        for name in ("wenmai_get_article_project", "wenmai_get_project_diagnostics", "wenmai_get_project_slices"):
            package_tool = next(item for item in tools if item["name"] == name)
            self.assertIn("packageId", package_tool["inputSchema"]["required"])
            self.assertIn("branchId", package_tool["inputSchema"]["required"])
        group_tool = next(item for item in tools if item["name"] == "wenmai_get_project_group")
        self.assertIn("groupId", group_tool["inputSchema"]["required"])
        self.assertTrue(group_tool["annotations"]["readOnlyHint"])
        patch_tool = next(item for item in tools if item["name"] == "wenmai_propose_package_patch")
        self.assertIn("expectedBranchLockVersion", patch_tool["inputSchema"]["required"])
        self.assertFalse(patch_tool["annotations"]["readOnlyHint"])
        operations = patch_tool["inputSchema"]["properties"]["operations"]
        self.assertEqual(operations["maxItems"], 50)
        self.assertEqual(
            {entry["properties"]["op"]["const"] for entry in operations["items"]["oneOf"]},
            {"replace_module", "remove_module", "upsert_edge", "remove_edge"},
        )
        self.assertIn("targetModuleKey", patch_tool["description"])
        self.assertNotIn("replace_document", json.dumps(operations, ensure_ascii=False))
        self.assertNotIn("add_module", json.dumps(operations, ensure_ascii=False))
        for name, required in {
            "wenmai_create_task": {"commandId", "articleId", "objective"},
            "wenmai_update_task": {"commandId", "taskId", "expectedLockVersion"},
            "wenmai_cancel_task": {"commandId", "taskId", "expectedLockVersion", "note"},
        }.items():
            item = next(tool for tool in tools if tool["name"] == name)
            self.assertEqual(set(item["inputSchema"]["required"]), required)
            self.assertFalse(item["annotations"]["readOnlyHint"])

    def test_task_manager_tools_dispatch_only_existing_admin_actions(self) -> None:
        calls = [
            ("wenmai_create_task", "create_task", {"commandId": "mcp-create-1", "articleId": "article-allowed", "objective": "整理文章"}),
            ("wenmai_update_task", "update_task", {"commandId": "mcp-update-1", "taskId": "task-1", "expectedLockVersion": 1, "title": "更新标题"}),
            ("wenmai_cancel_task", "cancel_task", {"commandId": "mcp-cancel-1", "taskId": "task-1", "expectedLockVersion": 1, "note": "不再需要"}),
        ]
        for name, action, arguments in calls:
            with self.subTest(name=name):
                result = self.tool_call(name, arguments)
                self.assertFalse(result["isError"])
                request = self.loopback.state.requests[-1]
                self.assertEqual(request["body"]["action"], action)
                self.assertEqual(request["body"]["commandId"], arguments["commandId"])
                self.assertEqual(request["body"]["payload"], {key: value for key, value in arguments.items() if key != "commandId"})

    def test_public_discovery_points_to_the_tested_stdio_server(self) -> None:
        discovery = json.loads((ROOT / "public" / ".well-known" / "wenmai-agent.json").read_text(encoding="utf-8"))
        manifest = json.loads((ROOT / "public" / "agent" / "manifest.json").read_text(encoding="utf-8"))
        mcp = json.loads((ROOT / "public" / "agent" / "mcp.json").read_text(encoding="utf-8"))
        self.assertEqual(discovery["mcp"], "/agent/mcp.json")
        self.assertEqual(discovery["dataInterfaces"]["corpusClassificationAndLineage"], "/api/corpus/v1?view=manifest")
        self.assertEqual(manifest["dataInterfaces"], discovery["dataInterfaces"])
        self.assertEqual(manifest["mcpServer"]["implementation"], "scripts/wenmai_mcp_server.py")
        self.assertEqual(mcp["mcpProtocolVersion"], mcp_module.MCP_PROTOCOL_VERSION)
        self.assertEqual(mcp["implementation"]["script"], "scripts/wenmai_mcp_server.py")
        self.assertIn("--trusted-tailscale-host", mcp["implementation"]["tailscaleCommandTemplate"])
        self.assertEqual(mcp["transport"]["tailscaleHttps"]["hostnamePolicy"], "exact_ascii_machine_tailnet_ts_net")
        self.assertEqual(mcp["packageTools"]["candidatePatch"]["requiresClientScope"], "package.patch.propose")
        self.assertEqual(mcp["packageTools"]["candidatePatch"]["edgeScope"], "incident_to_target_only")
        self.assertFalse(mcp["packageTools"]["taskDetailProjection"]["frozenBundleReturned"])
        self.assertFalse(mcp["writeContract"]["weakModelCompletionToolExposed"])
        self.assertFalse(mcp["boundaries"]["mainBranchWrite"])
        self.assertFalse(mcp["boundaries"]["externalSubmission"])

    def test_manifest_task_and_context_reads_use_fixed_agent_api(self) -> None:
        manifest = self.tool_call("wenmai_get_manifest")
        self.assertFalse(manifest["isError"])
        task = self.tool_call("wenmai_get_task", {"taskId": "task-1"})
        self.assertEqual(task["structuredContent"]["data"]["task"]["id"], "task-1")
        task_data = task["structuredContent"]["data"]
        self.assertNotIn("bundle", task_data["contextSnapshots"][0])
        self.assertEqual(task_data["contextSnapshots"][0]["packageBaseline"]["targetModuleKey"], "module-target")
        self.assertEqual(task_data["packagePatchProposals"][0]["status"], "candidate")
        context = self.tool_call("wenmai_get_task_context", {"taskId": "task-1"})
        self.assertEqual(context["structuredContent"]["data"]["contextSnapshot"]["sha256"], SHA)
        self.assertTrue(all(urlsplit(str(item["path"])).path in {"/api/agent/v1", "/api/capabilities", "/api/corpus/v1"} or str(item["path"]).startswith("/agent/") for item in self.loopback.state.requests))

    def test_capability_search_requires_scope_and_reads_dynamic_index(self) -> None:
        result = self.tool_call("wenmai_search_capabilities", {"query": "写作", "kind": "skill", "limit": 5})
        self.assertFalse(result["isError"])
        self.assertEqual(result["structuredContent"]["elements"][0]["id"], "skill-1")
        self.loopback.state.scopes = ["task.read"]
        denied = self.tool_call("wenmai_search_capabilities", {"query": "写作"})
        self.assertTrue(denied["isError"])
        self.assertEqual(denied["structuredContent"]["error"]["code"], "SCOPE_DENIED")

    def test_article_lineage_is_bounded_by_token_article_scope(self) -> None:
        result = self.tool_call("wenmai_get_article_lineage", {"articleId": "article-allowed", "depth": 3, "status": "confirmed", "limit": 40})
        self.assertFalse(result["isError"])
        self.assertEqual(result["structuredContent"]["seed"], "article-allowed")
        self.assertEqual(result["structuredContent"]["edges"][0]["relationType"], "artifact_of")
        self.assertFalse(result["structuredContent"]["bodyTextIncluded"])
        request = next(item for item in reversed(self.loopback.state.requests) if urlsplit(str(item["path"])).path == "/api/corpus/v1")
        query = parse_qs(urlsplit(str(request["path"])).query)
        self.assertEqual(query["depth"], ["3"])
        self.assertEqual(query["status"], ["confirmed"])
        denied = self.tool_call("wenmai_get_article_lineage", {"articleId": "article-denied"})
        self.assertTrue(denied["isError"])
        self.assertEqual(denied["structuredContent"]["error"]["code"], "OBJECT_SCOPE_DENIED")

    def test_package_reads_use_bearer_only_agent_views_and_enforce_article_scope(self) -> None:
        listed = self.tool_call("wenmai_list_article_projects")
        packages = listed["structuredContent"]["packages"]
        self.assertEqual([item["id"] for item in packages], ["package-allowed"])
        self.assertTrue(listed["structuredContent"]["scopeFiltered"])
        branches = self.tool_call("wenmai_list_project_branches", {"packageId": "package-allowed"})
        self.assertEqual(branches["structuredContent"]["branches"][0]["branchId"], "branch-main")
        allowed = self.tool_call("wenmai_get_article_project", {"packageId": "package-allowed", "branchId": "branch-main"})
        self.assertFalse(allowed["isError"])
        missing_branch = self.tool_call("wenmai_get_article_project", {"packageId": "package-allowed"})
        self.assertTrue(missing_branch["isError"])
        self.assertEqual(missing_branch["structuredContent"]["error"]["code"], "INVALID_ARGUMENTS")
        denied = self.tool_call("wenmai_get_article_project", {"packageId": "package-denied", "branchId": "branch-main"})
        self.assertTrue(denied["isError"])
        self.assertEqual(denied["structuredContent"]["error"]["code"], "PACKAGE_NOT_FOUND")
        package_requests = [item for item in self.loopback.state.requests if parse_qs(urlsplit(str(item["path"])).query).get("view", [""])[0].startswith("project_")]
        self.assertGreaterEqual(len(package_requests), 4)
        for request in package_requests:
            self.assertEqual(urlsplit(str(request["path"])).path, "/api/agent/v1")
            self.assertEqual(request["authorization"], f"Bearer {TOKEN}")
            self.assertIsNone(request["origin"])
            self.assertIsNone(request["cookie"])
            self.assertIsNone(request["browserBinding"])
            self.assertIsNone(request["csrf"])
        self.assertFalse(any(urlsplit(str(item["path"])).path == "/api/project-package/v1" for item in self.loopback.state.requests))

        self.loopback.state.scopes = [scope for scope in self.loopback.state.scopes if scope != "package.read"]
        no_scope = self.tool_call("wenmai_list_article_projects")
        self.assertTrue(no_scope["isError"])
        self.assertEqual(no_scope["structuredContent"]["error"]["code"], "SCOPE_DENIED")

    def test_project_group_reads_use_agent_bearer_only_and_expose_no_write_tool(self) -> None:
        listed = self.tool_call("wenmai_list_project_groups", {"articleId": "article-allowed", "limit": 10})
        self.assertFalse(listed["isError"])
        summary = listed["structuredContent"]["groups"][0]
        self.assertEqual(summary["group"]["id"], "group-allowed")
        self.assertEqual(summary["memberCount"], 1)
        self.assertEqual(summary["edgeCount"], 0)
        self.assertEqual(summary["storedTopologySha256"], SHA)
        self.assertTrue(summary["detailRequiredForTopology"])
        for forbidden in ("members", "edges", "topology", "integrityStatus"):
            self.assertNotIn(forbidden, summary)
        detail = self.tool_call("wenmai_get_project_group", {"groupId": "group-allowed"})
        self.assertFalse(detail["isError"])
        self.assertTrue(detail["structuredContent"]["readOnly"])
        denied = self.tool_call("wenmai_get_project_group", {"groupId": "group-partial"})
        self.assertTrue(denied["isError"])
        self.assertEqual(denied["structuredContent"]["error"]["code"], "OBJECT_SCOPE_DENIED")
        requests = [item for item in self.loopback.state.requests if parse_qs(urlsplit(str(item["path"])).query).get("view", [""])[0].startswith("project_group")]
        self.assertGreaterEqual(len(requests), 3)
        for request in requests:
            self.assertEqual(urlsplit(str(request["path"])).path, "/api/agent/v1")
            self.assertEqual(request["authorization"], f"Bearer {TOKEN}")
            self.assertIsNone(request["origin"])
            self.assertIsNone(request["cookie"])
            self.assertIsNone(request["browserBinding"])
            self.assertIsNone(request["csrf"])
        tools = self.server.handle(rpc(99, "tools/list"))["result"]["tools"]
        group_tools = [item for item in tools if "project_group" in item["name"]]
        self.assertEqual({item["name"] for item in group_tools}, {"wenmai_list_project_groups", "wenmai_get_project_group"})
        self.assertTrue(all(item["annotations"]["readOnlyHint"] for item in group_tools))
        self.assertIn("不含 members", next(item for item in group_tools if item["name"] == "wenmai_list_project_groups")["description"])
        self.assertIn("256", next(item for item in group_tools if item["name"] == "wenmai_get_project_group")["description"])
        self.assertIn("2048", next(item for item in group_tools if item["name"] == "wenmai_get_project_group")["description"])

    def test_diagnostics_and_slices_are_read_only_views(self) -> None:
        diagnostics = self.tool_call("wenmai_get_project_diagnostics", {"packageId": "package-allowed", "branchId": "branch-main", "limit": 10})
        slices = self.tool_call("wenmai_get_project_slices", {"packageId": "package-allowed", "branchId": "branch-main", "limit": 10})
        self.assertEqual(diagnostics["structuredContent"]["diagnosisRuns"][0]["id"], "diagnosis-1")
        self.assertEqual(slices["structuredContent"]["slices"][0]["sliceKind"], "demo")

    def test_package_patch_tool_is_branch_scoped_candidate_only(self) -> None:
        result = self.tool_call("wenmai_propose_package_patch", {
            "commandId": "mcp-package-patch-1",
            "taskId": "task-1",
            "attemptId": "attempt-1",
            "leaseId": "lease-1",
            "leaseToken": LEASE_TOKEN,
            "contextSha256": SHA,
            "packageId": "package-allowed",
            "branchId": "branch-main",
            "baseRevisionId": "revision-1",
            "expectedBranchLockVersion": 3,
            "baseCompositionId": "composition-1",
            "expectedBaseCompositionSha256": SHA,
            "title": "模块修复候选",
            "operations": [{"op": "remove_edge", "edgeKey": "edge-old"}],
        })
        self.assertFalse(result["isError"])
        self.assertEqual(result["structuredContent"]["patchProposal"]["status"], "candidate")
        self.assertFalse(result["structuredContent"]["boundary"]["compositionCreated"])
        self.assertEqual(result["structuredContent"]["boundary"]["targetModuleKey"], "module-target")
        request = next(item for item in reversed(self.loopback.state.requests) if item["method"] == "POST")
        self.assertEqual(urlsplit(str(request["path"])).path, "/api/agent/v1")
        self.assertEqual(request["authorization"], f"Bearer {TOKEN}")
        self.assertIsNone(request["origin"])
        self.assertIsNone(request["cookie"])
        body = request["body"]
        self.assertEqual(body["action"], "propose_package_patch")
        self.assertTrue(str(body["commandId"]).startswith("wmcmd-"))
        self.assertEqual(body["payload"]["branchId"], "branch-main")

    def test_mutations_require_stable_command_id_and_preserve_agent_boundary(self) -> None:
        denied = self.tool_call("wenmai_claim_task", {"taskId": "task-1"})
        self.assertTrue(denied["isError"])
        self.assertEqual(denied["structuredContent"]["error"]["code"], "COMMAND_ID_REQUIRED")
        claimed = self.tool_call("wenmai_claim_task", {"commandId": "mcp-command-1", "taskId": "task-1"})
        self.assertFalse(claimed["isError"])
        self.assertIn(LEASE_TOKEN, json.dumps(claimed, ensure_ascii=False))
        rendered = json.dumps(claimed, ensure_ascii=False)
        self.assertNotIn(TOKEN, rendered)
        self.assertIn("wmcmd-", claimed["structuredContent"]["commandId"])

    def test_resources_and_prompt_are_bounded_machine_context(self) -> None:
        resources = self.server.handle(rpc(3, "resources/list"))["result"]["resources"]  # type: ignore[index]
        self.assertEqual(len(resources), 4)
        read = self.server.handle(rpc(4, "resources/read", {"uri": "wenmai://agent/system-prompt"}))["result"]  # type: ignore[index]
        self.assertIn("候选完成不等于批准", read["contents"][0]["text"])
        project = self.server.handle(rpc(41, "resources/read", {"uri": "wenmai://article-project/manifest"}))["result"]  # type: ignore[index]
        self.assertIn("package.read", project["contents"][0]["text"])
        prompt = self.server.handle(rpc(5, "prompts/get", {"name": "execute_wenmai_task", "arguments": {"taskId": "task-1"}}))["result"]  # type: ignore[index]
        self.assertIn("contextSnapshot", prompt["messages"][0]["content"]["text"])

    def test_unknown_tools_are_protocol_errors_and_known_failures_are_tool_errors(self) -> None:
        unknown = self.server.handle(rpc(6, "tools/call", {"name": "shell", "arguments": {}}))
        self.assertEqual(unknown["error"]["code"], -32602)  # type: ignore[index]
        known = self.tool_call("wenmai_search_knowledge", {})
        self.assertTrue(known["isError"])

    def test_stdio_is_newline_delimited_and_rejects_batches(self) -> None:
        input_stream = io.BytesIO(
            (json.dumps(rpc(7, "ping"), separators=(",", ":")) + "\n" + json.dumps([rpc(8, "ping")], separators=(",", ":")) + "\n").encode("utf-8")
        )
        output_stream = io.BytesIO()
        self.assertEqual(mcp_module.serve(self.server, input_stream, output_stream), 0)
        lines = output_stream.getvalue().decode("utf-8").splitlines()
        self.assertEqual(len(lines), 2)
        self.assertEqual(json.loads(lines[0])["id"], 7)
        self.assertEqual(json.loads(lines[1])["error"]["code"], -32700)

    def test_non_loopback_urls_are_rejected_but_exact_tailscale_host_is_propagated(self) -> None:
        with self.assertRaises(client_module.AgentClientError):
            mcp_module.WenmaiMcpServer("https://example.com", TOKEN, token_environment="WENMAI_AGENT_TOKEN", timeout_seconds=1)
        server = mcp_module.WenmaiMcpServer(
            None,
            TOKEN,
            trusted_tailscale_host=TAILSCALE_HOST,
            token_environment="WENMAI_AGENT_TOKEN",
            timeout_seconds=1,
        )
        self.assertEqual(server.local.origin, f"https://{TAILSCALE_HOST}")
        self.assertEqual(server.agent.http.origin, f"https://{TAILSCALE_HOST}")
        with self.assertRaises(client_module.AgentClientError):
            mcp_module.WenmaiMcpServer(
                None,
                TOKEN,
                trusted_tailscale_host="example.com",
                token_environment="WENMAI_AGENT_TOKEN",
                timeout_seconds=1,
            )

    def test_mcp_transport_cli_modes_are_mutually_exclusive(self) -> None:
        args = mcp_module.build_parser().parse_args(["--trusted-tailscale-host", TAILSCALE_HOST])
        self.assertIsNone(args.base_url)
        self.assertEqual(args.trusted_tailscale_host, TAILSCALE_HOST)
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
            mcp_module.build_parser().parse_args([
                "--base-url", "http://127.0.0.1:3000",
                "--trusted-tailscale-host", TAILSCALE_HOST,
            ])

    def test_mcp_access_file_overrides_environment_and_enables_in_memory_bearer(self) -> None:
        captured: dict[str, object] = {}

        class CapturingServer:
            def __init__(self, origin: str | None, token: str | None, **kwargs: object) -> None:
                captured.update({"origin": origin, "token": token, **kwargs})

        with tempfile.TemporaryDirectory() as raw_directory:
            path = Path(raw_directory) / "access.json"
            path.write_text(json.dumps(mcp_access_document()), encoding="utf-8")
            with mock.patch.dict(os.environ, {"WENMAI_AGENT_TOKEN": "wrong-environment-token-123456"}, clear=False), mock.patch.object(mcp_module, "WenmaiMcpServer", CapturingServer), mock.patch.object(mcp_module, "serve", return_value=0):
                self.assertEqual(mcp_module.main(["--access-file", str(path)]), 0)
        self.assertEqual(captured["origin"], "http://[::1]:3000")
        self.assertEqual(captured["token"], TOKEN)
        self.assertTrue(captured["send_bearer"])

    def test_mcp_local_metadata_transport_keeps_no_proxy_and_no_redirect_policy(self) -> None:
        source = (SCRIPTS / "wenmai_mcp_server.py").read_text(encoding="utf-8")
        self.assertIn("build_opener(ProxyHandler({}), NoRedirectHandler())", source)
        self.assertNotIn("_create_unverified_context", source)
        remote = mcp_module.LocalHttpClient(
            None,
            trusted_tailscale_host=TAILSCALE_HOST,
            bearer_token=TOKEN,
            token_environment="WENMAI_AGENT_TOKEN",
            timeout_seconds=1,
        )
        self.assertTrue(any(isinstance(handler, client_module.NoRedirectHandler) for handler in remote.opener.handlers))

    def test_remote_metadata_uses_same_agent_bearer_while_loopback_metadata_stays_unauthenticated(self) -> None:
        captured: list[object] = []

        class Response(io.BytesIO):
            status = 200
            headers = {"Content-Type": "application/json", "Content-Length": "2"}

            def __enter__(self) -> "Response":
                return self

            def __exit__(self, exc_type: object, exc: object, traceback: object) -> None:
                self.close()

        class Opener:
            def open(self, request: object, timeout: float) -> Response:
                captured.append(request)
                return Response(b"{}")

        remote = mcp_module.LocalHttpClient(
            None,
            trusted_tailscale_host=TAILSCALE_HOST,
            bearer_token=TOKEN,
            token_environment="WENMAI_AGENT_TOKEN",
            timeout_seconds=1,
        )
        remote.opener = Opener()
        self.assertEqual(remote.get_text("/agent/manifest.json"), "{}")
        request = captured.pop()
        headers = {key.lower(): value for key, value in request.header_items()}
        self.assertEqual(request.full_url, f"https://{TAILSCALE_HOST}/agent/manifest.json")
        self.assertEqual(headers["authorization"], f"Bearer {TOKEN}")
        self.assertEqual(headers["origin"], f"https://{TAILSCALE_HOST}")
        for forbidden in ("cookie", "x-wenmai-browser-binding", "x-wenmai-csrf", "x-wenmai-write"):
            self.assertNotIn(forbidden, headers)

        local = mcp_module.LocalHttpClient(
            "http://127.0.0.1:3000",
            bearer_token=TOKEN,
            token_environment="WENMAI_AGENT_TOKEN",
            timeout_seconds=1,
        )
        local.opener = Opener()
        self.assertEqual(local.get_text("/agent/manifest.json"), "{}")
        local_headers = {key.lower(): value for key, value in captured.pop().header_items()}
        self.assertNotIn("authorization", local_headers)
        with self.assertRaises(client_module.AgentClientError):
            mcp_module.LocalHttpClient(
                None,
                trusted_tailscale_host=TAILSCALE_HOST,
                bearer_token=None,
                token_environment="WENMAI_AGENT_TOKEN",
                timeout_seconds=1,
            )


if __name__ == "__main__":
    unittest.main(verbosity=2)
