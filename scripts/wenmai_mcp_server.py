#!/usr/bin/env python3
"""文脉 MCP stdio 服务器。

服务器只连接显式 loopback IP，或由精确 ASCII Tailscale MagicDNS 主机名构造的
HTTPS 文脉网站；不执行 Shell、不读取任意本地文件、不跟随重定向、不使用系统
代理。Agent 写操作继续经过一次性 Bearer token、任务对象边界、上下文摘要、租约
和 CommandReceipt；MCP 本身不会新增主分支写入、批准、发布或规则采纳权限。
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import uuid
from dataclasses import dataclass
from typing import Any, BinaryIO, Callable
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import ProxyHandler, Request, build_opener

from wenmai_agent_client import (
    DEFAULT_MAX_RESPONSE_BYTES,
    DEFAULT_TIMEOUT_SECONDS,
    DEFAULT_TOKEN_ENV,
    AgentClientError,
    AgentHttpClient,
    NoRedirectHandler,
    WenmaiAgentClient,
    canonical_json,
    resolve_transport_origin,
    safe_text,
    stable_command_id,
    validate_token,
)


MCP_PROTOCOL_VERSION = "2025-06-18"
SUPPORTED_PROTOCOL_VERSIONS = {"2025-06-18", "2025-03-26", "2024-11-05"}
SERVER_NAME = "wenmai-local-article-factory"
SERVER_VERSION = "1.0.0"
MAX_STDIN_LINE_BYTES = 4_194_304
MAX_TOOL_TEXT_BYTES = 1_000_000
MAX_LOCAL_RESPONSE_BYTES = 8_388_608


class McpServerError(RuntimeError):
    def __init__(self, code: str, message: str, *, details: dict[str, Any] | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.details = details


def object_schema(
    properties: dict[str, dict[str, Any]] | None = None,
    required: list[str] | None = None,
    *,
    additional: bool = False,
) -> dict[str, Any]:
    schema: dict[str, Any] = {
        "type": "object",
        "properties": properties or {},
        "additionalProperties": additional,
    }
    if required:
        schema["required"] = required
    return schema


def string(description: str, maximum: int = 160) -> dict[str, Any]:
    return {"type": "string", "minLength": 1, "maxLength": maximum, "description": description}


def integer(description: str, minimum: int = 0, maximum: int = 100) -> dict[str, Any]:
    return {"type": "integer", "minimum": minimum, "maximum": maximum, "description": description}


def string_array(description: str, maximum: int = 50) -> dict[str, Any]:
    return {
        "type": "array",
        "maxItems": maximum,
        "items": {"type": "string", "minLength": 1, "maxLength": 500},
        "description": description,
    }


def tool(
    name: str,
    title: str,
    description: str,
    input_schema: dict[str, Any],
    *,
    read_only: bool,
    idempotent: bool = False,
) -> dict[str, Any]:
    return {
        "name": name,
        "title": title,
        "description": description,
        "inputSchema": input_schema,
        "annotations": {
            "title": title,
            "readOnlyHint": read_only,
            "destructiveHint": False,
            "idempotentHint": idempotent,
            "openWorldHint": False,
        },
    }


ID = string("文脉稳定对象 ID", 120)
COMMAND_ID = string("调用方稳定生成的幂等命令 ID；同一意图重试必须复用", 160)
SHA = {"type": "string", "pattern": "^[a-f0-9]{64}$", "description": "小写 SHA-256"}
PACKAGE_PATCH_OPERATION = {
    "oneOf": [
        {
            "type": "object",
            "additionalProperties": False,
            "required": ["op", "moduleKey", "module"],
            "properties": {
                "op": {"const": "replace_module"},
                "moduleKey": ID,
                "module": {"type": "object", "additionalProperties": True},
            },
        },
        {
            "type": "object",
            "additionalProperties": False,
            "required": ["op", "moduleKey"],
            "properties": {"op": {"const": "remove_module"}, "moduleKey": ID},
        },
        {
            "type": "object",
            "additionalProperties": False,
            "required": ["op", "edge"],
            "properties": {
                "op": {"const": "upsert_edge"},
                "edge": {"type": "object", "additionalProperties": True},
            },
        },
        {
            "type": "object",
            "additionalProperties": False,
            "required": ["op", "edgeKey"],
            "properties": {"op": {"const": "remove_edge"}, "edgeKey": ID},
        },
    ]
}


TOOLS: list[dict[str, Any]] = [
    tool("wenmai_get_manifest", "读取文脉 Agent 说明", "读取机器发现合同、权限边界和 API 版本；不读取文章正文。", object_schema(), read_only=True),
    tool("wenmai_get_health", "检查 Agent 控制面", "使用当前 Agent token 检查连接状态、任务数量和授权客户端，不扩大 token 权限。", object_schema(), read_only=True),
    tool("wenmai_list_tasks", "列出可访问任务", "只返回当前 token 对象边界内的 Agent 任务。", object_schema(), read_only=True),
    tool("wenmai_get_task", "读取任务详情", "读取任务、事件、工件、人工请求、图谱提案和候选 Package Patch 回执；Context 只返回脱敏 packageBaseline 与 guidanceChecklist 摘要，隐藏 bundle 不会通过此工具返回。", object_schema({"taskId": ID}, ["taskId"]), read_only=True),
    tool("wenmai_get_task_context", "读取冻结任务上下文", "使用 context.read 读取绑定 Revision、正文、语料、图谱、规则与 Package 单模块目标的完整不可变 Context；它与脱敏的任务详情不同。", object_schema({"taskId": ID, "contextId": ID}, ["taskId"]), read_only=True),
    tool("wenmai_search_knowledge", "搜索文章知识库", "有界搜索历史文章与资料索引；不返回全库正文。", object_schema({"query": string("搜索词", 160), "limit": integer("返回数量", 1, 30)}, ["query"]), read_only=True),
    tool("wenmai_get_subgraph", "读取知识子图", "按文章或节点读取深度不超过 2 的候选子图。", object_schema({"articleId": ID, "nodeIds": string_array("种子节点", 20), "depth": integer("图深度", 0, 2), "limit": integer("节点或边上限", 1, 100)}), read_only=True),
    tool("wenmai_get_article_lineage", "读取文章开发树", "按文章身份读取有界开发树，追溯制品、来源、质检与发布证据；保留 confirmed/suggested 状态，不返回正文。", object_schema({"articleId": ID, "depth": integer("开发树深度", 0, 3), "status": {"type": "string", "enum": ["all", "confirmed", "suggested"]}, "relationType": string("关系类型；all 表示全部", 80), "limit": integer("节点上限", 1, 240)}, ["articleId"]), read_only=True),
    tool("wenmai_search_capabilities", "搜索本地 Skill 与门禁", "按动态能力索引搜索 Skill、门禁、工作流和模板；入口可找到不等于已经采用。", object_schema({"query": string("名称、标签或用途", 160), "kind": string("skill、gate、workflow、template 或 checker", 40), "stage": string("创作阶段", 40), "dimension": string("能力维度", 40), "limit": integer("返回数量", 1, 50)}), read_only=True),
    tool("wenmai_list_article_projects", "列出文章工程", "通过 Agent Bearer 和 package.read 列出 token 文章边界内的 ArticleProject Package；不返回正文。", object_schema({"articleId": ID, "limit": integer("返回数量", 1, 200)}), read_only=True),
    tool("wenmai_list_project_branches", "列出工程分支", "列出一个已授权 Package 已接入的 ArticleBranch，供后续 branch-qualified 读取选择。", object_schema({"packageId": ID, "limit": integer("返回数量", 1, 200)}, ["packageId"]), read_only=True),
    tool("wenmai_get_article_project", "读取文章工程", "读取一个 Package 指定分支的 Composition 元数据、模块工作文档、分支基线与 project_package.guidanceChecklist；先按清单 nextAction 和单个 workUnit 工作，清单不会授予应用 Patch、完成或发布权限；必须具有 package.read。", object_schema({"packageId": ID, "branchId": ID, "limit": integer("最近提交数量", 1, 200)}, ["packageId", "branchId"]), read_only=True),
    tool("wenmai_get_project_diagnostics", "读取工程诊断", "读取 Package 指定分支的 DiagnosisRun 与模块级 Issue，不执行诊断或修改。", object_schema({"packageId": ID, "branchId": ID, "diagnosisRunId": ID, "compositionId": ID, "limit": integer("返回数量", 1, 200)}, ["packageId", "branchId"]), read_only=True),
    tool("wenmai_get_project_slices", "读取工程切片", "读取 Package 指定分支的完整版、Demo、摘要、宣传或自定义切片冻结选择。", object_schema({"packageId": ID, "branchId": ID, "sliceId": ID, "limit": integer("返回数量", 1, 200)}, ["packageId", "branchId"]), read_only=True),
    tool("wenmai_list_project_groups", "列出 ProjectGroup", "仅通过 Agent Bearer + package.read 读取完整授权的有界摘要；不含 members、edges、topology 或 integrityStatus，detailRequiredForTopology=true。受限 token 不会看到空组或部分授权组。", object_schema({"articleId": ID, "includeArchived": {"type": "boolean"}, "limit": integer("返回数量", 1, 200)}), read_only=True),
    tool("wenmai_get_project_group", "读取 ProjectGroup", "仅通过 Agent Bearer + package.read 读取一个完整授权 ProjectGroup；最多 256 个 members 与 2048 条 edges，超限返回 PROJECT_GROUP_READ_LIMIT_EXCEEDED 409 且无部分数据。不提供任何组写操作。", object_schema({"groupId": ID, "articleId": ID, "includeArchived": {"type": "boolean"}}, ["groupId"]), read_only=True),
    tool("wenmai_create_task", "创建文脉任务", "通过既有 create_task 管理动作创建任务；服务端仍负责角色、scope、文章与状态校验。", object_schema({"commandId": COMMAND_ID, "articleId": ID, "objective": string("任务目标", 8000), "title": string("任务标题", 240), "instructionsMd": string("Markdown 指令", 20000), "acceptance": {"type": "array", "maxItems": 60}, "writeScope": string("写入范围", 40), "targetModuleKey": ID, "targetBranchId": ID, "priority": {"type": "string", "enum": ["P0", "P1", "P2", "P3"]}, "state": {"type": "string", "enum": ["draft", "queued"]}}, ["commandId", "articleId", "objective"]), read_only=False, idempotent=True),
    tool("wenmai_update_task", "更新文脉任务", "通过既有 update_task 管理动作更新未活动任务；服务端负责锁版本、状态和权限校验。", object_schema({"commandId": COMMAND_ID, "taskId": ID, "expectedLockVersion": integer("任务 CAS 锁版本", 1, 2_147_483_647), "title": string("任务标题", 240), "objective": string("任务目标", 8000), "instructionsMd": string("Markdown 指令", 20000), "acceptance": {"type": "array", "maxItems": 60}, "priority": {"type": "string", "enum": ["P0", "P1", "P2", "P3"]}, "state": {"type": "string", "enum": ["draft", "queued", "blocked"]}}, ["commandId", "taskId", "expectedLockVersion"]), read_only=False, idempotent=True),
    tool("wenmai_cancel_task", "取消文脉任务", "通过既有 cancel_task 管理动作取消任务；服务端负责锁版本、状态和权限校验。", object_schema({"commandId": COMMAND_ID, "taskId": ID, "expectedLockVersion": integer("任务 CAS 锁版本", 1, 2_147_483_647), "note": string("取消原因", 2000)}, ["commandId", "taskId", "expectedLockVersion", "note"]), read_only=False, idempotent=True),
    tool("wenmai_claim_task", "领取 Agent 任务", "竞争领取一项排队任务并取得短期租约；不会批准、合并或发布。", object_schema({"commandId": COMMAND_ID, "taskId": ID}, ["commandId", "taskId"]), read_only=False, idempotent=True),
    tool("wenmai_heartbeat", "续约任务租约", "按严格递增 heartbeatSeq 续约当前 attempt。", object_schema({"commandId": COMMAND_ID, "taskId": ID, "attemptId": ID, "leaseId": ID, "leaseToken": string("领取时返回的一次性租约令牌", 500), "contextSha256": SHA, "heartbeatSeq": integer("严格递增序号", 1, 2_147_483_647)}, ["commandId", "taskId", "attemptId", "leaseId", "leaseToken", "contextSha256", "heartbeatSeq"]), read_only=False, idempotent=True),
        tool("wenmai_report_progress", "回写 Agent 进度", "输入当前租约和冻结上下文，追加当前动作、下一动作、阻塞与证据；百分比只是 Agent 报告，不冒充人工验收或完成。", object_schema({"commandId": COMMAND_ID, "taskId": ID, "attemptId": ID, "leaseId": ID, "leaseToken": string("租约令牌", 500), "contextSha256": SHA, "phase": string("阶段", 80), "progressPercent": integer("0 到 100", 0, 100), "currentAction": string("当前正在做什么", 500), "nextAction": string("下一动作", 500), "blocker": string("阻塞条件", 1000), "message": string("给人的进度说明", 4000), "evidence": string_array("证据引用", 30), "eventPayload": {"type": "object", "additionalProperties": True}}, ["commandId", "taskId", "attemptId", "leaseId", "leaseToken", "contextSha256", "currentAction"]), read_only=False, idempotent=True),
    tool("wenmai_add_artifact", "登记 Agent 工件", "追加一个受限工件引用或小型内联工件；不覆盖正文和源语料。", object_schema({"commandId": COMMAND_ID, "taskId": ID, "attemptId": ID, "leaseId": ID, "leaseToken": string("租约令牌", 500), "contextSha256": SHA, "kind": string("工件类型", 80), "title": string("工件标题", 200), "contentRef": string("agent-inline:、artifact: 或 .runner/agent/ 引用", 500), "sha256": SHA, "mediaType": string("MIME 类型", 128), "sizeBytes": integer("字节数", 0, 1_000_000_000), "artifactPayload": {"type": "object", "additionalProperties": True}, "inlineContent": string("小型 UTF-8 内联内容", 220_000)}, ["commandId", "taskId", "attemptId", "leaseId", "leaseToken", "contextSha256", "kind", "title", "contentRef"]), read_only=False, idempotent=True),
    tool("wenmai_propose_revision", "提交候选正文修订", "只在任务专属 Agent 分支基于 expectedHeadRevisionId 追加不可变候选 Revision；不能写 main 或合并。", object_schema({"commandId": COMMAND_ID, "taskId": ID, "attemptId": ID, "leaseId": ID, "leaseToken": string("租约令牌", 500), "contextSha256": SHA, "expectedHeadRevisionId": ID, "title": string("文章标题", 300), "bodyText": string("完整候选 Markdown 正文", 220_000), "summary": string("本次修改摘要", 4000), "revisionTitle": string("候选修订名称", 300)}, ["commandId", "taskId", "attemptId", "leaseId", "leaseToken", "contextSha256", "expectedHeadRevisionId", "title", "bodyText"]), read_only=False, idempotent=True),
    tool("wenmai_propose_package_patch", "提交候选工程 Patch", "使用 package.patch.propose 在任务冻结的 Package、ArticleBranch 与单个既有 targetModuleKey 上提交候选；只允许 replace_module/remove_module 和与目标模块相邻的 upsert_edge/remove_edge，禁止 replace_document、add_module、改名或越界边；只创建 candidate。", object_schema({"commandId": COMMAND_ID, "taskId": ID, "attemptId": ID, "leaseId": ID, "leaseToken": string("租约令牌", 500), "contextSha256": SHA, "packageId": ID, "branchId": ID, "baseRevisionId": ID, "expectedBranchLockVersion": integer("冻结分支 CAS 版本", 1, 2_147_483_647), "baseCompositionId": ID, "expectedBaseCompositionSha256": SHA, "title": string("Patch 标题", 300), "summary": string("变更摘要", 4000), "operations": {"type": "array", "minItems": 1, "maxItems": 50, "items": PACKAGE_PATCH_OPERATION}, "evidence": string_array("证据引用", 60), "diagnosticIssueIds": string_array("对应诊断 Issue ID", 100)}, ["commandId", "taskId", "attemptId", "leaseId", "leaseToken", "contextSha256", "packageId", "branchId", "baseRevisionId", "expectedBranchLockVersion", "baseCompositionId", "expectedBaseCompositionSha256", "title", "operations"]), read_only=False, idempotent=True),
    tool("wenmai_ask_human", "请求人工决定", "暂停当前 attempt 并创建澄清、范围变化或风险接受请求；不替人做决定。", object_schema({"commandId": COMMAND_ID, "taskId": ID, "attemptId": ID, "leaseId": ID, "leaseToken": string("租约令牌", 500), "contextSha256": SHA, "kind": {"type": "string", "enum": ["clarification", "scope_change", "risk_acceptance"]}, "title": string("请求标题", 200), "question": string("需要人回答的问题", 4000), "options": string_array("可选决定", 12)}, ["commandId", "taskId", "attemptId", "leaseId", "leaseToken", "contextSha256", "title", "question"]), read_only=False, idempotent=True),
    tool("wenmai_fail_task", "记录任务失败", "记录当前 attempt 的失败类别和摘要，保留可恢复状态。", object_schema({"commandId": COMMAND_ID, "taskId": ID, "attemptId": ID, "leaseId": ID, "leaseToken": string("租约令牌", 500), "contextSha256": SHA, "errorClass": string("稳定失败类别", 120), "errorSummary": string("失败摘要", 4000)}, ["commandId", "taskId", "attemptId", "leaseId", "leaseToken", "contextSha256", "errorClass", "errorSummary"]), read_only=False, idempotent=True),
    tool("wenmai_release_task_lease", "释放任务租约", "只释放 Agent 任务租约，绝不代表发行或发布文章。", object_schema({"commandId": COMMAND_ID, "taskId": ID, "attemptId": ID, "leaseId": ID, "leaseToken": string("租约令牌", 500), "contextSha256": SHA, "note": string("释放原因", 2000)}, ["commandId", "taskId", "attemptId", "leaseId", "leaseToken", "contextSha256", "note"]), read_only=False, idempotent=True),
]

TOOL_BY_NAME = {item["name"]: item for item in TOOLS}


@dataclass(frozen=True)
class LocalHttpResult:
    status: int
    payload: Any


class LocalHttpClient:
    def __init__(
        self,
        base_url: str | None,
        *,
        trusted_tailscale_host: str | None = None,
        bearer_token: str | None = None,
        send_bearer: bool = False,
        token_environment: str = DEFAULT_TOKEN_ENV,
        timeout_seconds: float,
        max_response_bytes: int = MAX_LOCAL_RESPONSE_BYTES,
    ) -> None:
        self.origin = resolve_transport_origin(base_url, trusted_tailscale_host)
        self.bearer_token = (
            validate_token(bearer_token, token_environment)
            if trusted_tailscale_host is not None or send_bearer
            else None
        )
        self.timeout_seconds = timeout_seconds
        self.max_response_bytes = max_response_bytes
        self.opener = build_opener(ProxyHandler({}), NoRedirectHandler())

    def _headers(self, accept: str) -> dict[str, str]:
        headers = {"Accept": accept, "Origin": self.origin, "User-Agent": "wenmai-mcp/1.0"}
        if self.bearer_token is not None:
            headers["Authorization"] = f"Bearer {self.bearer_token}"
        return headers

    def get_json(self, path: str, query: list[tuple[str, str]] | None = None) -> LocalHttpResult:
        if not path.startswith("/") or ".." in path or "?" in path or "#" in path:
            raise McpServerError("PATH_FORBIDDEN", "本地 API 路径不在固定白名单内")
        url = f"{self.origin}{path}"
        if query:
            url = f"{url}?{urlencode(query)}"
        request = Request(url, headers=self._headers("application/json"), method="GET")
        return self._request(request, expect_json=True)

    def get_text(self, path: str) -> str:
        if path not in {"/agent/manifest.json", "/agent/api/v1.json", "/agent/prompts/system.md"}:
            raise McpServerError("PATH_FORBIDDEN", "资源路径不在固定白名单内")
        request = Request(
            f"{self.origin}{path}",
            headers=self._headers("application/json,text/markdown,text/plain"),
            method="GET",
        )
        result = self._request(request, expect_json=False)
        if not isinstance(result.payload, str):
            raise McpServerError("INVALID_RESPONSE", "资源响应不是 UTF-8 文本")
        return result.payload

    def _request(self, request: Request, *, expect_json: bool) -> LocalHttpResult:
        try:
            with self.opener.open(request, timeout=self.timeout_seconds) as response:
                return self._decode(int(response.status), response.headers, response, expect_json=expect_json)
        except HTTPError as error:
            if 300 <= error.code < 400:
                raise McpServerError("REDIRECT_FORBIDDEN", "本地 HTTP 重定向被拒绝", details={"status": error.code}) from error
            result = self._decode(int(error.code), error.headers, error, expect_json=True)
            server_error = result.payload.get("error") if isinstance(result.payload, dict) else None
            code = server_error.get("code") if isinstance(server_error, dict) else f"HTTP_{error.code}"
            message = server_error.get("message") if isinstance(server_error, dict) else "文脉网站拒绝请求"
            raise McpServerError(str(code), safe_text(message, self.bearer_token), details={"status": error.code}) from error
        except (URLError, TimeoutError, OSError) as error:
            raise McpServerError("NETWORK_ERROR", safe_text(error, self.bearer_token)) from error

    def _decode(self, status: int, headers: Any, stream: BinaryIO, *, expect_json: bool) -> LocalHttpResult:
        length = headers.get("Content-Length") if headers is not None else None
        if length:
            try:
                if int(length) > self.max_response_bytes:
                    raise McpServerError("RESPONSE_TOO_LARGE", "本地响应超过 MCP 上限")
            except ValueError:
                pass
        raw = stream.read(self.max_response_bytes + 1)
        if len(raw) > self.max_response_bytes:
            raise McpServerError("RESPONSE_TOO_LARGE", "本地响应超过 MCP 上限")
        try:
            text = raw.decode("utf-8")
        except UnicodeError as error:
            raise McpServerError("INVALID_RESPONSE", "本地响应不是 UTF-8") from error
        if not expect_json:
            return LocalHttpResult(status, text)
        try:
            payload = json.loads(text, parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
        except (ValueError, json.JSONDecodeError, RecursionError) as error:
            raise McpServerError("INVALID_RESPONSE", "本地响应不是严格 JSON") from error
        return LocalHttpResult(status, payload)


class WenmaiMcpServer:
    def __init__(
        self,
        base_url: str | None,
        token: str | None,
        *,
        trusted_tailscale_host: str | None = None,
        token_environment: str,
        timeout_seconds: float,
        send_bearer: bool = False,
    ) -> None:
        self.local = LocalHttpClient(
            base_url,
            trusted_tailscale_host=trusted_tailscale_host,
            bearer_token=token,
            token_environment=token_environment,
            timeout_seconds=timeout_seconds,
            send_bearer=send_bearer,
        )
        self.agent = WenmaiAgentClient(AgentHttpClient(
            base_url,
            token,
            trusted_tailscale_host=trusted_tailscale_host,
            token_environment=token_environment,
            timeout_seconds=timeout_seconds,
            max_response_bytes=DEFAULT_MAX_RESPONSE_BYTES,
        ))
        self.initialized = False
        self.protocol_version = MCP_PROTOCOL_VERSION

    def handle(self, message: Any) -> dict[str, Any] | None:
        if not isinstance(message, dict) or message.get("jsonrpc") != "2.0":
            return self.error(message.get("id") if isinstance(message, dict) else None, -32600, "Invalid Request")
        method = message.get("method")
        request_id = message.get("id")
        if not isinstance(method, str):
            return self.error(request_id, -32600, "Invalid Request")
        if request_id is None:
            if method == "notifications/initialized":
                self.initialized = True
            return None
        try:
            params = message.get("params", {})
            if not isinstance(params, dict):
                raise McpServerError("INVALID_PARAMS", "params 必须是对象")
            if method == "initialize":
                requested = params.get("protocolVersion")
                self.protocol_version = requested if isinstance(requested, str) and requested in SUPPORTED_PROTOCOL_VERSIONS else MCP_PROTOCOL_VERSION
                return self.success(request_id, {
                    "protocolVersion": self.protocol_version,
                    "capabilities": {"tools": {"listChanged": False}, "resources": {"subscribe": False, "listChanged": False}, "prompts": {"listChanged": False}},
                    "serverInfo": {"name": SERVER_NAME, "title": "文脉本地文章工厂", "version": SERVER_VERSION},
                    "instructions": "输入：任务与冻结上下文。动作：先读取，再按工具合同写回；所有写操作都需要稳定 commandId、有效 Agent token、当前租约和 contextSha256。输出只能是候选、进度或回执；禁止把候选完成写成批准、合并或发布。",
                })
            if method == "ping":
                return self.success(request_id, {})
            if method == "tools/list":
                return self.success(request_id, {"tools": TOOLS})
            if method == "tools/call":
                return self.success(request_id, self.call_tool(params, request_id))
            if method == "resources/list":
                return self.success(request_id, {"resources": self.resources()})
            if method == "resources/read":
                return self.success(request_id, self.read_resource(params))
            if method == "prompts/list":
                return self.success(request_id, {"prompts": [{"name": "execute_wenmai_task", "title": "执行一项文脉任务", "description": "输入 AgentTask ID，读取冻结上下文后按窄权限回写进度与候选工件；不得批准、合并或发布。", "arguments": [{"name": "taskId", "description": "AgentTask ID", "required": True}]}]})
            if method == "prompts/get":
                return self.success(request_id, self.get_prompt(params, request_id))
            return self.error(request_id, -32601, "Method not found")
        except McpServerError as error:
            return self.error(request_id, -32602, str(error), {"code": error.code, "details": error.details})
        except AgentClientError as error:
            return self.error(request_id, -32602, str(error), {"code": error.code, "status": error.status, "details": error.details})
        except Exception as error:  # defensive protocol boundary
            print(f"wenmai-mcp internal error: {safe_text(error)}", file=sys.stderr)
            return self.error(request_id, -32603, "Internal error")

    @staticmethod
    def success(request_id: Any, result: dict[str, Any]) -> dict[str, Any]:
        return {"jsonrpc": "2.0", "id": request_id, "result": result}

    @staticmethod
    def error(request_id: Any, code: int, message: str, data: dict[str, Any] | None = None) -> dict[str, Any]:
        error: dict[str, Any] = {"code": code, "message": message}
        if data:
            error["data"] = data
        return {"jsonrpc": "2.0", "id": request_id, "error": error}

    def call_tool(self, params: dict[str, Any], rpc_request_id: Any) -> dict[str, Any]:
        name = params.get("name")
        arguments = params.get("arguments", {})
        if not isinstance(name, str) or name not in TOOL_BY_NAME:
            raise McpServerError("UNKNOWN_TOOL", "未知 MCP 工具")
        if not isinstance(arguments, dict):
            raise McpServerError("INVALID_ARGUMENTS", "工具 arguments 必须是对象")
        try:
            data = self.dispatch_tool(name, arguments, rpc_request_id)
            structured = data if isinstance(data, dict) else {"result": data}
            text = canonical_json(structured)
            encoded = text.encode("utf-8")
            if len(encoded) > MAX_TOOL_TEXT_BYTES:
                text = canonical_json({"truncated": True, "message": "结构化结果超过文本镜像上限；请缩小查询范围。", "bytes": len(encoded)})
            return {"content": [{"type": "text", "text": text}], "structuredContent": structured, "isError": False}
        except (McpServerError, AgentClientError) as error:
            code = error.code
            details = error.details if isinstance(error, McpServerError) else error.details
            payload = {"ok": False, "error": {"code": code, "message": str(error), "details": details}}
            return {"content": [{"type": "text", "text": canonical_json(payload)}], "structuredContent": payload, "isError": True}

    def dispatch_tool(self, name: str, arguments: dict[str, Any], rpc_request_id: Any) -> Any:
        read_commands = {
            "wenmai_get_health": "status",
            "wenmai_list_tasks": "list_tasks",
            "wenmai_get_task": "get_task",
            "wenmai_get_task_context": "get_context",
            "wenmai_search_knowledge": "search_knowledge",
            "wenmai_get_subgraph": "get_subgraph",
        }
        mutation_commands = {
            "wenmai_claim_task": "claim",
            "wenmai_heartbeat": "heartbeat",
            "wenmai_report_progress": "progress",
            "wenmai_add_artifact": "add_artifact",
            "wenmai_propose_revision": "propose_revision",
            "wenmai_ask_human": "await_human",
            "wenmai_fail_task": "fail",
            "wenmai_release_task_lease": "release",
        }
        admin_tools = {
            "wenmai_create_task": "create_task",
            "wenmai_update_task": "update_task",
            "wenmai_cancel_task": "cancel_task",
        }
        if name == "wenmai_get_manifest":
            return self._local_data("/api/agent/v1", [("view", "manifest")])
        if name in read_commands:
            command = read_commands[name]
            args = dict(arguments)
            if command == "search_knowledge" and "query" not in args:
                raise McpServerError("INVALID_ARGUMENTS", "缺少 query")
            request_id = self._read_request_id(name, rpc_request_id, args)
            return self.agent.execute({"requestId": request_id, "command": command, "args": args})
        if name in mutation_commands:
            args = dict(arguments)
            command_id = args.pop("commandId", None)
            if not isinstance(command_id, str) or not command_id.strip():
                raise McpServerError("COMMAND_ID_REQUIRED", "写工具必须提供稳定 commandId")
            return self.agent.execute({"requestId": command_id.strip(), "command": mutation_commands[name], "args": args})
        if name in admin_tools:
            args = dict(arguments)
            command_id = args.pop("commandId", None)
            if not isinstance(command_id, str) or not command_id.strip():
                raise McpServerError("COMMAND_ID_REQUIRED", "写工具必须提供稳定 commandId")
            return self.agent.execute({
                "requestId": command_id.strip(),
                "command": "admin_action",
                "args": {"action": admin_tools[name], "commandId": command_id.strip(), "payload": args},
            })
        if name == "wenmai_propose_package_patch":
            args = dict(arguments)
            command_id = args.pop("commandId", None)
            if not isinstance(command_id, str) or not command_id.strip():
                raise McpServerError("COMMAND_ID_REQUIRED", "写工具必须提供稳定 commandId")
            return self._agent_post("propose_package_patch", stable_command_id(command_id.strip()), args)
        if name == "wenmai_search_capabilities":
            client = self._current_client()
            if "knowledge.read" not in client.get("scopes", []):
                raise McpServerError("SCOPE_DENIED", "Agent token 缺少 knowledge.read 权限")
            query: list[tuple[str, str]] = []
            for source, target in (("query", "q"), ("kind", "kind"), ("stage", "stage"), ("dimension", "dimension"), ("limit", "limit")):
                if source in arguments and arguments[source] not in (None, ""):
                    query.append((target, str(arguments[source])))
            return self._local_data("/api/capabilities", query)
        if name == "wenmai_get_article_lineage":
            article_id = arguments.get("articleId")
            if not isinstance(article_id, str) or not article_id:
                raise McpServerError("INVALID_ARGUMENTS", "缺少 articleId")
            client = self._current_client()
            if "knowledge.read" not in client.get("scopes", []):
                raise McpServerError("SCOPE_DENIED", "Agent token 缺少 knowledge.read 权限")
            self._assert_article_allowed(client, article_id)
            query = [("view", "lineage"), ("articleId", article_id)]
            for key in ("depth", "status", "relationType", "limit"):
                value = arguments.get(key)
                if value not in (None, ""):
                    query.append((key, str(value)))
            return self._local_data("/api/corpus/v1", query)
        if name == "wenmai_list_article_projects":
            requested_article = arguments.get("articleId")
            query = [("view", "project_packages"), ("limit", str(arguments.get("limit", 200)))]
            if requested_article:
                query.append(("articleId", str(requested_article)))
            return self._agent_data(query)
        if name == "wenmai_list_project_branches":
            package_id = arguments.get("packageId")
            if not isinstance(package_id, str) or not package_id:
                raise McpServerError("INVALID_ARGUMENTS", "缺少 packageId")
            return self._agent_data([
                ("view", "project_branches"), ("packageId", package_id),
                ("limit", str(arguments.get("limit", 200))),
            ])
        if name in {"wenmai_get_article_project", "wenmai_get_project_diagnostics", "wenmai_get_project_slices"}:
            package_id = arguments.get("packageId")
            if not isinstance(package_id, str) or not package_id:
                raise McpServerError("INVALID_ARGUMENTS", "缺少 packageId")
            branch_id = arguments.get("branchId")
            if not isinstance(branch_id, str) or not branch_id:
                raise McpServerError("INVALID_ARGUMENTS", "缺少 branchId")
            view = "project_package" if name == "wenmai_get_article_project" else (
                "project_diagnostics" if name == "wenmai_get_project_diagnostics" else "project_slices"
            )
            query = [
                ("view", view), ("packageId", package_id), ("branchId", branch_id),
                ("limit", str(arguments.get("limit", 200))),
            ]
            for key in ("diagnosisRunId", "compositionId", "sliceId"):
                value = arguments.get(key)
                if value not in (None, ""):
                    query.append((key, str(value)))
            return self._agent_data(query)
        if name == "wenmai_list_project_groups":
            query = [("view", "project_groups"), ("limit", str(arguments.get("limit", 200)))]
            for key in ("articleId", "includeArchived"):
                value = arguments.get(key)
                if value not in (None, ""):
                    query.append((key, str(value).lower() if isinstance(value, bool) else str(value)))
            return self._agent_data(query)
        if name == "wenmai_get_project_group":
            group_id = arguments.get("groupId")
            if not isinstance(group_id, str) or not group_id:
                raise McpServerError("INVALID_ARGUMENTS", "缺少 groupId")
            query = [("view", "project_group"), ("groupId", group_id)]
            for key in ("articleId", "includeArchived"):
                value = arguments.get(key)
                if value not in (None, ""):
                    query.append((key, str(value).lower() if isinstance(value, bool) else str(value)))
            return self._agent_data(query)
        raise McpServerError("UNKNOWN_TOOL", "未知 MCP 工具")

    def _agent_data(self, query: list[tuple[str, str]]) -> dict[str, Any]:
        try:
            result = self.agent.http.request("GET", query=query)
        except AgentClientError as error:
            raise self._project_agent_error(error) from error
        return self._agent_envelope_data(result.status, result.payload)

    def _agent_post(self, action: str, command_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        try:
            result = self.agent.http.request("POST", query=[], body={
                "action": action,
                "commandId": command_id,
                "payload": payload,
            })
        except AgentClientError as error:
            raise self._project_agent_error(error) from error
        return self._agent_envelope_data(result.status, result.payload)

    @staticmethod
    def _project_agent_error(error: AgentClientError) -> McpServerError:
        server_code = error.details.get("serverCode") if isinstance(error.details, dict) else None
        code = server_code if isinstance(server_code, str) and server_code else error.code
        return McpServerError(code, "Agent API 拒绝文章工程请求", details={"status": error.status, "serverCode": server_code})

    @staticmethod
    def _agent_envelope_data(status: int, payload: Any) -> dict[str, Any]:
        if not isinstance(payload, dict) or payload.get("ok") is not True or not isinstance(payload.get("data"), dict):
            raise McpServerError("INVALID_RESPONSE", "Agent API 响应不符合统一 envelope", details={"status": status})
        return payload["data"]

    def _local_data(self, path: str, query: list[tuple[str, str]]) -> dict[str, Any]:
        result = self.local.get_json(path, query)
        if not isinstance(result.payload, dict) or result.payload.get("ok") is not True or not isinstance(result.payload.get("data"), dict):
            raise McpServerError("INVALID_RESPONSE", "网站响应不符合统一 envelope", details={"status": result.status})
        return result.payload["data"]

    def _current_client(self) -> dict[str, Any]:
        result = self.agent.execute({"requestId": f"mcp-scope-{uuid.uuid4().hex}", "command": "status", "args": {}})
        data = result.get("data") if isinstance(result, dict) else None
        clients = data.get("clients") if isinstance(data, dict) else None
        if not isinstance(clients, list) or len(clients) != 1 or not isinstance(clients[0], dict):
            raise McpServerError("AUTH_SCOPE_UNAVAILABLE", "无法确定当前 Agent token 的对象边界")
        return clients[0]

    @staticmethod
    def _article_allowed(client: dict[str, Any], article_id: str) -> bool:
        article_ids = client.get("articleIds", [])
        return isinstance(article_ids, list) and ("*" in article_ids or article_id in article_ids)

    def _assert_article_allowed(self, client: dict[str, Any], article_id: str) -> None:
        if not article_id or not self._article_allowed(client, article_id):
            raise McpServerError("OBJECT_SCOPE_DENIED", "Agent token 不包含这个文章工程")

    @staticmethod
    def _read_request_id(name: str, rpc_request_id: Any, arguments: dict[str, Any]) -> str:
        basis = canonical_json({"rpc": rpc_request_id, "tool": name, "arguments": arguments})
        # UUID5 keeps identifiers bounded and deterministic for this JSON-RPC request.
        return f"mcp-read-{uuid.uuid5(uuid.NAMESPACE_URL, basis).hex}"

    @staticmethod
    def resources() -> list[dict[str, Any]]:
        return [
            {"uri": "wenmai://agent/manifest", "name": "文脉 Agent manifest", "description": "读取顺序、权限和证据边界", "mimeType": "application/json"},
            {"uri": "wenmai://agent/api-contract", "name": "文脉 Agent API 合同", "description": "稳定 GET view、POST action 与字段约束", "mimeType": "application/json"},
            {"uri": "wenmai://agent/system-prompt", "name": "文脉 Agent 系统说明", "description": "任务执行、进度与完结声明规则", "mimeType": "text/markdown"},
            {"uri": "wenmai://article-project/manifest", "name": "文章工程 Package manifest", "description": "模块、Composition、诊断、Patch、切片与导入导出能力", "mimeType": "application/json"},
        ]

    def read_resource(self, params: dict[str, Any]) -> dict[str, Any]:
        uri = params.get("uri")
        if uri == "wenmai://agent/manifest":
            text = self.local.get_text("/agent/manifest.json")
            mime = "application/json"
        elif uri == "wenmai://agent/api-contract":
            text = self.local.get_text("/agent/api/v1.json")
            mime = "application/json"
        elif uri == "wenmai://agent/system-prompt":
            text = self.local.get_text("/agent/prompts/system.md")
            mime = "text/markdown"
        elif uri == "wenmai://article-project/manifest":
            text = canonical_json(self._agent_data([("view", "project_manifest")]))
            mime = "application/json"
        else:
            raise McpServerError("RESOURCE_NOT_FOUND", "未知文脉资源")
        return {"contents": [{"uri": uri, "mimeType": mime, "text": text}]}

    def get_prompt(self, params: dict[str, Any], rpc_request_id: Any) -> dict[str, Any]:
        if params.get("name") != "execute_wenmai_task":
            raise McpServerError("PROMPT_NOT_FOUND", "未知文脉 Prompt")
        arguments = params.get("arguments", {})
        if not isinstance(arguments, dict) or not isinstance(arguments.get("taskId"), str):
            raise McpServerError("INVALID_ARGUMENTS", "execute_wenmai_task 需要 taskId")
        context = self.agent.execute({"requestId": self._read_request_id("prompt-context", rpc_request_id, arguments), "command": "get_context", "args": {"taskId": arguments["taskId"]}})
        context_text = canonical_json(context)
        if len(context_text.encode("utf-8")) > 200_000:
            raise McpServerError("CONTEXT_TOO_LARGE", "冻结上下文超过 Prompt 上限，请改用 wenmai_get_task_context")
        return {
            "description": "输入冻结上下文后按工具合同执行任务；输出只能更新受限状态、进度或候选工件。",
            "messages": [{
                "role": "user",
                "content": {"type": "text", "text": "输入：以下冻结上下文。动作：先核对绑定，再执行合同内步骤，并持续使用 wenmai_report_progress 回写当前动作；需要人决定时调用 wenmai_ask_human。输出：最终只提交候选完成。禁止：不得声称已批准、已合并或已发布。\n\n" + context_text},
            }],
        }


def serve(server: WenmaiMcpServer, input_stream: BinaryIO, output_stream: BinaryIO) -> int:
    while True:
        raw = input_stream.readline(MAX_STDIN_LINE_BYTES + 1)
        if not raw:
            return 0
        if len(raw) > MAX_STDIN_LINE_BYTES:
            while raw and not raw.endswith(b"\n"):
                raw = input_stream.readline(MAX_STDIN_LINE_BYTES + 1)
            response = server.error(None, -32700, "Parse error")
        elif not raw.strip():
            continue
        else:
            try:
                message = json.loads(raw.decode("utf-8"), parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
                if isinstance(message, list):
                    raise ValueError("JSON-RPC batching is not supported")
                response = server.handle(message)
            except (UnicodeError, ValueError, json.JSONDecodeError, RecursionError):
                response = server.error(None, -32700, "Parse error")
        if response is None:
            continue
        encoded = (canonical_json(response) + "\n").encode("utf-8")
        output_stream.write(encoded)
        output_stream.flush()


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="文脉 MCP stdio server")
    transport = parser.add_mutually_exclusive_group()
    transport.add_argument("--base-url", help="显式 127.0.0.1 或 ::1 HTTP origin；默认 http://[::1]:3000")
    transport.add_argument(
        "--trusted-tailscale-host",
        help="精确 ASCII <machine>.<tailnet>.ts.net 主机名；客户端固定构造并校验 HTTPS",
    )
    transport.add_argument("--access-file", help="文脉可携带访问文件")
    parser.add_argument("--token-env", default=DEFAULT_TOKEN_ENV, help="保存一次性 Agent token 的环境变量名")
    parser.add_argument("--timeout", type=float, default=DEFAULT_TIMEOUT_SECONDS, help="单次文脉请求超时秒数")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        if args.access_file is not None:
            from wenmai_agent_access_file import load_access_file
            access = load_access_file(args.access_file)
            if access.origin.startswith("https://"):
                base_url, trusted_host = None, access.origin.removeprefix("https://")
            else:
                base_url, trusted_host = access.origin, None
            token, send_bearer = access.token, True
        else:
            base_url, token, trusted_host, send_bearer = args.base_url, os.environ.get(args.token_env), args.trusted_tailscale_host, False
        server = WenmaiMcpServer(
            base_url,
            token,
            trusted_tailscale_host=trusted_host,
            token_environment=args.token_env,
            timeout_seconds=args.timeout,
            send_bearer=send_bearer,
        )
        return serve(server, sys.stdin.buffer, sys.stdout.buffer)
    except (AgentClientError, McpServerError, ValueError) as error:
        print(f"wenmai-mcp startup failed: {safe_text(error)}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
