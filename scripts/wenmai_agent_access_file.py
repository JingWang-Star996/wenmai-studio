"""严格读取可携带的 Wenmai Share Grant 或 Role Grant 访问文件。

本模块只返回已经校验过的 origin 与 Bearer token；所有失败消息均不包含
文件路径、文件内容或 token。
"""
from __future__ import annotations

import json
import os
import re
import stat
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from urllib.parse import quote

from wenmai_agent_client import AgentClientError, tailscale_https_origin, validate_token


ACCESS_FILE_SCHEMA_VERSION = "wenmai.agent-access-file/1"
MAX_ACCESS_FILE_BYTES = 64 * 1024
AGENT_CLIENT_ID_PATTERN = re.compile(r"^agent-client-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
AGENT_TOKEN_PATTERN = re.compile(r"^wenmai_agent_[a-f0-9]{32}_[a-f0-9]{32}$")
VIEWER_SCOPES = ["article.read"]
EDITOR_SCOPES = [
    "article.read", "task.read", "task.claim", "task.progress", "context.read",
    "artifact.create", "approval.request", "branch.agent_write",
]
ROLE_PROFILES = {
    "content-steward": {
        "serverRole": "administrator", "permissionPresetId": "task_admin", "maxDays": 7,
        "scopes": ["task.read", "context.read", "knowledge.read", "graph.read", "package.read", "shared_source.read", "task.manage"],
        "actionIds": ["agent.v1.create_task", "agent.v1.update_task", "agent.v1.cancel_task"],
        "localOnly": False,
    },
    "article-worker": {
        "serverRole": "agent", "permissionPresetId": None, "maxDays": 7,
        "scopes": ["task.read", "task.claim", "task.progress", "context.read", "knowledge.read", "graph.read", "artifact.create", "approval.request", "graph.propose", "branch.agent_write", "package.read", "package.patch.propose"],
        "actionIds": [], "localOnly": False,
    },
    "local-registrar": {
        "serverRole": "agent", "permissionPresetId": None, "maxDays": 1,
        "scopes": ["article.import.new_root"], "actionIds": [], "localOnly": True,
    },
}


@dataclass(frozen=True)
class AccessFileGrant:
    origin: str
    token: str


def _invalid() -> AgentClientError:
    return AgentClientError("ACCESS_FILE_INVALID", "access file is invalid")


def _object(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise _invalid()
    return value


def _keys(value: dict[str, Any], allowed: set[str], required: set[str]) -> None:
    if set(value) - allowed or required - set(value):
        raise _invalid()


def _string(value: Any, *, maximum: int = 4096) -> str:
    if not isinstance(value, str) or not value or len(value) > maximum or value != value.strip():
        raise _invalid()
    return value


def _timestamp(value: Any, *, future: bool = False) -> datetime:
    text = _string(value, maximum=64)
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError as error:
        raise _invalid() from error
    if parsed.tzinfo is None or (future and parsed.astimezone(timezone.utc) <= datetime.now(timezone.utc)):
        raise _invalid()
    return parsed.astimezone(timezone.utc)


def _origin(value: Any) -> str:
    origin = _string(value, maximum=300)
    if origin == "http://[::1]:3000":
        return origin
    if not origin.startswith("https://"):
        raise _invalid()
    try:
        return tailscale_https_origin(origin.removeprefix("https://"))
    except AgentClientError as error:
        raise _invalid() from error


def _concrete_id(value: Any) -> str:
    candidate = _string(value, maximum=120)
    if candidate == "*":
        raise _invalid()
    return candidate


def _same_scopes(value: Any, expected: list[str]) -> bool:
    return isinstance(value, list) and len(value) == len(expected) and len(set(value)) == len(value) and all(isinstance(item, str) for item in value) and set(value) == set(expected)


def _read(path: str | os.PathLike[str]) -> bytes:
    candidate = Path(path)
    try:
        before = candidate.lstat()
        if stat.S_ISLNK(before.st_mode) or not stat.S_ISREG(before.st_mode):
            raise _invalid()
        if os.name == "posix" and before.st_mode & (stat.S_IRWXG | stat.S_IRWXO):
            raise _invalid()
        flags = os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
        descriptor = os.open(candidate, flags)
        try:
            current = os.fstat(descriptor)
            if not stat.S_ISREG(current.st_mode) or current.st_ino != before.st_ino or current.st_dev != before.st_dev:
                raise _invalid()
            if os.name == "posix" and current.st_mode & (stat.S_IRWXG | stat.S_IRWXO):
                raise _invalid()
            content = os.read(descriptor, MAX_ACCESS_FILE_BYTES + 1)
        finally:
            os.close(descriptor)
    except AgentClientError:
        raise
    except (OSError, ValueError) as error:
        raise _invalid() from error
    if len(content) > MAX_ACCESS_FILE_BYTES:
        raise _invalid()
    return content


def _credential_and_handling(root: dict[str, Any], client_id: str) -> str:
    credential = _object(root["credential"])
    _keys(credential, {"type", "header", "scheme", "token"}, {"type", "header", "scheme", "token"})
    if credential["type"] != "bearer" or credential["header"] != "Authorization" or credential["scheme"] != "Bearer":
        raise _invalid()
    token = validate_token(credential["token"])
    if AGENT_TOKEN_PATTERN.fullmatch(token) is None:
        raise _invalid()
    handling = _object(root["handling"])
    _keys(handling, {"recommendedUnixMode", "serverStateAuthoritative", "gatewayActivationImplied", "revokeByClientId", "note"}, {"recommendedUnixMode", "serverStateAuthoritative", "gatewayActivationImplied", "revokeByClientId", "note"})
    if handling["recommendedUnixMode"] != "0600" or handling["serverStateAuthoritative"] is not True or handling["gatewayActivationImplied"] is not False or handling["revokeByClientId"] != client_id:
        raise _invalid()
    _string(handling["note"], maximum=1_000)
    return token


def _load_role_grant(root: dict[str, Any]) -> AccessFileGrant:
    card = _object(root["connectionCard"])
    _keys(card, {"schemaVersion", "label", "origin", "client", "endpoints", "authentication", "networkPrerequisite", "grant", "allowedOperations", "ownerOnlyBoundary"}, {"schemaVersion", "label", "origin", "client", "endpoints", "authentication", "networkPrerequisite", "grant", "allowedOperations", "ownerOnlyBoundary"})
    if card["schemaVersion"] != "wenmai.role-grant/1":
        raise _invalid()
    _string(card["label"], maximum=500)
    origin = _origin(card["origin"])
    client = _object(card["client"])
    _keys(client, {"id", "kind", "profileName"}, {"id", "kind", "profileName"})
    client_id = _concrete_id(client["id"])
    if AGENT_CLIENT_ID_PATTERN.fullmatch(client_id) is None:
        raise _invalid()
    _string(client["kind"], maximum=120)
    if client["profileName"] is not None and not isinstance(client["profileName"], str):
        raise _invalid()
    grant = _object(card["grant"])
    _keys(grant, {"roleId", "serverRole", "permissionPresetId", "articleScope", "taskIds", "expiresAt"}, {"roleId", "serverRole", "permissionPresetId", "articleScope", "taskIds", "expiresAt"})
    role_id = grant["roleId"]
    profile = ROLE_PROFILES.get(role_id) if isinstance(role_id, str) else None
    if profile is None or grant["serverRole"] != profile["serverRole"] or grant["permissionPresetId"] != profile["permissionPresetId"]:
        raise _invalid()
    article_scope = _object(grant["articleScope"])
    _keys(article_scope, {"mode", "articleIds", "includesFutureArticles"}, {"mode", "articleIds", "includesFutureArticles"})
    if article_scope != {"mode": "all_articles", "articleIds": ["*"], "includesFutureArticles": True} or grant["taskIds"] != []:
        raise _invalid()
    expires_at = _timestamp(grant["expiresAt"], future=True)
    if expires_at > datetime.now(timezone.utc) + timedelta(days=int(profile["maxDays"])):
        raise _invalid()
    if profile["localOnly"] and origin != "http://[::1]:3000":
        raise _invalid()
    endpoints = _object(card["endpoints"])
    _keys(endpoints, {"discovery", "api", "health", "mcpManifest", "localImport"}, {"discovery", "api", "health", "mcpManifest", "localImport"})
    expected_local_import = f"{origin}/api/local-import/v1" if profile["localOnly"] else None
    if endpoints != {"discovery": f"{origin}/.well-known/wenmai-agent.json", "api": f"{origin}/api/agent/v1", "health": f"{origin}/api/agent/v1?view=health", "mcpManifest": f"{origin}/agent/mcp.json", "localImport": expected_local_import}:
        raise _invalid()
    authentication = _object(card["authentication"])
    _keys(authentication, {"header", "credentialInUrl", "note"}, {"header", "credentialInUrl", "note"})
    if authentication["header"] != "Authorization: Bearer <Role Grant>" or authentication["credentialInUrl"] is not False or not isinstance(authentication["note"], str):
        raise _invalid()
    network = _object(card["networkPrerequisite"])
    _keys(network, {"transport", "gatewayActivationImplied", "note"}, {"transport", "gatewayActivationImplied", "note"})
    expected_transport = "local-loopback" if origin.startswith("http://") else "tailscale-https"
    if network["transport"] != expected_transport or network["gatewayActivationImplied"] is not False or not isinstance(network["note"], str):
        raise _invalid()
    operations = _object(card["allowedOperations"])
    _keys(operations, {"scopes", "actionIds"}, {"scopes", "actionIds"})
    if not _same_scopes(operations["scopes"], profile["scopes"]) or not _same_scopes(operations["actionIds"], profile["actionIds"]):
        raise _invalid()
    boundary = _object(card["ownerOnlyBoundary"])
    _keys(boundary, {"enforced", "forbiddenCapabilities", "note"}, {"enforced", "forbiddenCapabilities", "note"})
    if boundary["enforced"] is not True or not isinstance(boundary["forbiddenCapabilities"], list) or not isinstance(boundary["note"], str):
        raise _invalid()
    return AccessFileGrant(origin=origin, token=_credential_and_handling(root, client_id))


def load_access_file(path: str | os.PathLike[str]) -> AccessFileGrant:
    try:
        raw = _read(path)
        document = json.loads(raw.decode("utf-8"), parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
        root = _object(document)
        _keys(root, {"schemaVersion", "kind", "secret", "possessionIsAuthority", "exportedAt", "connectionCard", "credential", "handling"}, {"schemaVersion", "kind", "secret", "possessionIsAuthority", "exportedAt", "connectionCard", "credential", "handling"})
        if root["schemaVersion"] != ACCESS_FILE_SCHEMA_VERSION or root["kind"] not in {"portable-share-grant", "portable-role-grant"} or root["secret"] is not True or root["possessionIsAuthority"] is not True:
            raise _invalid()
        _timestamp(root["exportedAt"])
        if root["kind"] == "portable-role-grant":
            return _load_role_grant(root)
        card = _object(root["connectionCard"])
        _keys(card, {"schemaVersion", "label", "origin", "client", "endpoints", "authentication", "networkPrerequisite", "grant", "allowedOperations", "ownerOnlyBoundary"}, {"schemaVersion", "label", "origin", "client", "endpoints", "authentication", "networkPrerequisite", "grant", "allowedOperations", "ownerOnlyBoundary"})
        if card["schemaVersion"] != "wenmai.share-grant/1":
            raise _invalid()
        _string(card["label"], maximum=500)
        origin = _origin(card["origin"])
        client = _object(card["client"])
        _keys(client, {"id", "kind", "profileName"}, {"id", "kind", "profileName"})
        client_id = _string(client["id"], maximum=120)
        if AGENT_CLIENT_ID_PATTERN.fullmatch(client_id) is None:
            raise _invalid()
        _string(client["kind"], maximum=120)
        if client["profileName"] is not None and not isinstance(client["profileName"], str):
            raise _invalid()
        grant = _object(card["grant"])
        _keys(grant, {"mode", "resource", "taskId", "expiresAt"}, {"mode", "resource", "taskId", "expiresAt"})
        mode = grant["mode"]
        resource = _object(grant["resource"])
        _keys(resource, {"type", "id", "label", "revisionPolicy"}, {"type", "id", "label", "revisionPolicy"})
        article_id = _concrete_id(resource["id"])
        if resource["type"] != "article" or resource["revisionPolicy"] != "authoritative-current" or (resource["label"] is not None and not isinstance(resource["label"], str)):
            raise _invalid()
        task_id = grant["taskId"]
        if mode == "viewer":
            if task_id is not None:
                raise _invalid()
            expected_scopes = VIEWER_SCOPES
        elif mode == "editor":
            _concrete_id(task_id)
            expected_scopes = EDITOR_SCOPES
        else:
            raise _invalid()
        expires_at = _timestamp(grant["expiresAt"], future=True)
        if expires_at > datetime.now(timezone.utc) + timedelta(days=30):
            raise _invalid()
        endpoints = _object(card["endpoints"])
        _keys(endpoints, {"discovery", "api", "health", "articleList", "articleDetail"}, {"discovery", "api", "health", "articleList", "articleDetail"})
        expected_endpoints = {"discovery": f"{origin}/.well-known/wenmai-agent.json", "api": f"{origin}/api/agent/v1", "health": f"{origin}/api/agent/v1?view=health", "articleList": f"{origin}/api/agent/v1?view=articles", "articleDetail": f"{origin}/api/agent/v1?view=article&articleId={quote(article_id, safe='')}"}
        if endpoints != expected_endpoints:
            raise _invalid()
        authentication = _object(card["authentication"])
        _keys(authentication, {"header", "credentialInUrl", "note"}, {"header", "credentialInUrl", "note"})
        if authentication["header"] != "Authorization: Bearer <Share Grant>" or authentication["credentialInUrl"] is not False or not isinstance(authentication["note"], str):
            raise _invalid()
        network = _object(card["networkPrerequisite"])
        _keys(network, {"transport", "gatewayActivationImplied", "note"}, {"transport", "gatewayActivationImplied", "note"})
        expected_transport = "local-loopback" if origin.startswith("http://") else "tailscale-https"
        if network["transport"] != expected_transport or network["gatewayActivationImplied"] is not False or not isinstance(network["note"], str):
            raise _invalid()
        operations = _object(card["allowedOperations"])
        _keys(operations, {"scopes", "requiresTask"}, {"scopes", "requiresTask"})
        if not _same_scopes(operations["scopes"], expected_scopes) or operations["requiresTask"] != (mode == "editor"):
            raise _invalid()
        boundary = _object(card["ownerOnlyBoundary"])
        _keys(boundary, {"enforced", "forbiddenCapabilities", "note"}, {"enforced", "forbiddenCapabilities", "note"})
        if boundary["enforced"] is not True or not isinstance(boundary["forbiddenCapabilities"], list) or not isinstance(boundary["note"], str):
            raise _invalid()
        return AccessFileGrant(origin=origin, token=_credential_and_handling(root, client_id))
    except AgentClientError as error:
        if error.code == "ACCESS_FILE_INVALID":
            raise
        raise _invalid() from error
    except (UnicodeError, ValueError, TypeError, RecursionError) as error:
        raise _invalid() from error
