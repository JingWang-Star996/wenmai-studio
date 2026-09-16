#!/usr/bin/env python3
"""Run the real launcher management-auth matrix without persisting credentials."""

from __future__ import annotations

import argparse
import base64
import getpass
import hashlib
import json
import os
import sys
import time
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import ProxyHandler, Request, build_opener


def digest(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def require(condition: bool, message: str) -> None:
    if not condition:
        raise RuntimeError(message)


def header_value(headers: dict[str, str], name: str) -> str:
    expected = name.lower()
    return next((value for key, value in headers.items() if key.lower() == expected), "")


def read_pairing_code() -> str:
    if sys.stdin.isatty():
        return getpass.getpass("Fresh one-time pairing code (not echoed): ").strip()
    return sys.stdin.readline().strip()


class LiveAuthClient:
    def __init__(self, base_url: str) -> None:
        self.base_url = base_url.rstrip("/")
        self.browser_binding = base64.urlsafe_b64encode(os.urandom(32)).decode("ascii").rstrip("=")
        self.wrong_binding = base64.urlsafe_b64encode(os.urandom(32)).decode("ascii").rstrip("=")
        self.cookie = ""
        self.csrf = ""

    def request(
        self,
        method: str,
        path: str,
        payload: dict[str, Any] | None = None,
        *,
        cookie: str = "",
        binding: str = "",
        csrf: str = "",
        origin: bool = False,
        extra_headers: dict[str, str] | None = None,
    ) -> tuple[int, dict[str, Any], dict[str, str]]:
        headers = {"accept": "application/json", **(extra_headers or {})}
        body = None
        if payload is not None:
            headers["content-type"] = "application/json"
            body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        if cookie:
            headers["cookie"] = cookie
        if binding:
            headers["x-wenmai-browser-binding"] = binding
        if origin:
            headers["origin"] = self.base_url
        if csrf:
            headers["x-wenmai-csrf"] = csrf
            headers["x-wenmai-write"] = "1"
        request = Request(f"{self.base_url}{path}", data=body, headers=headers, method=method)
        opener = build_opener(ProxyHandler({}))
        try:
            with opener.open(request, timeout=30) as response:
                raw = response.read(4_000_000).decode("utf-8")
                return response.status, json.loads(raw), dict(response.headers.items())
        except HTTPError as error:
            raw = error.read(4_000_000).decode("utf-8")
            return error.code, json.loads(raw), dict(error.headers.items())

    def bootstrap(self, pairing_code: str) -> tuple[int, dict[str, Any]]:
        status, envelope, headers = self.request(
            "POST",
            "/api/auth",
            {
                "action": "bootstrap",
                "pairingCode": pairing_code,
                "browserBindingSha256": digest(self.browser_binding),
            },
            origin=True,
        )
        if status == 201 and envelope.get("ok") is True:
            self.cookie = header_value(headers, "set-cookie").split(";", 1)[0]
            self.csrf = str((envelope.get("data") or {}).get("csrfToken") or "")
        return status, envelope


def error_code(payload: dict[str, Any]) -> str:
    error = payload.get("error")
    return str(error.get("code") or "") if isinstance(error, dict) else ""


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-url", default="http://[::1]:3000")
    args = parser.parse_args()
    pairing_code = read_pairing_code()
    require(bool(pairing_code), "pairing code is required")

    client = LiveAuthClient(args.base_url)
    checks: dict[str, Any] = {}

    deadline = time.monotonic() + 30
    while True:
        try:
            status, initial, _ = client.request("GET", "/api/auth")
            break
        except (OSError, TimeoutError, URLError):
            if time.monotonic() >= deadline:
                raise RuntimeError("fresh launcher did not become reachable within 30 seconds")
            time.sleep(0.25)
    require(status == 200 and initial.get("ok") is True, f"lock screen failed: HTTP {status} {initial}")
    initial_data = initial.get("data") or {}
    require(initial_data.get("authenticated") is False, "fresh launcher did not expose the unauthenticated lock state")
    require((initial_data.get("pairing") or {}).get("available") is True, "fresh pairing challenge is not available")
    checks["unauthenticatedLock"] = status

    for name, (headers, accepted_codes) in {
        "badForwardedHost": (
            {"x-forwarded-host": "attacker.example"},
            {"FORWARDED_REQUEST_FORBIDDEN"},
        ),
        "forwardedChain": (
            {"x-forwarded-host": "[::1]:3000, attacker.example"},
            {"FORWARDED_REQUEST_FORBIDDEN"},
        ),
        "forwardedFor": (
            {"x-forwarded-for": "203.0.113.10"},
            {"FORWARDED_REQUEST_FORBIDDEN"},
        ),
        "forwardedProto": (
            {"x-forwarded-proto": "https"},
            {"FORWARDED_REQUEST_FORBIDDEN", "CANONICAL_ORIGIN_REQUIRED"},
        ),
        "forwardedPort": (
            {"x-forwarded-port": "443"},
            {"FORWARDED_REQUEST_FORBIDDEN", "CANONICAL_ORIGIN_REQUIRED"},
        ),
        "realIp": (
            {"x-real-ip": "203.0.113.10"},
            {"FORWARDED_REQUEST_FORBIDDEN"},
        ),
        "forwardedStandard": (
            {"forwarded": "for=203.0.113.10"},
            {"FORWARDED_REQUEST_FORBIDDEN"},
        ),
    }.items():
        rejected_status, rejected, _ = client.request("GET", "/api/auth", extra_headers=headers)
        require(
            rejected_status == 421 and error_code(rejected) in accepted_codes,
            f"{name} was not rejected: HTTP {rejected_status} {rejected}",
        )
        checks[name] = rejected_status

    unauth_status, unauth_workspace, _ = client.request("GET", "/api/workspace")
    require(unauth_status == 401, f"sensitive GET was public before pairing: HTTP {unauth_status} {unauth_workspace}")
    checks["unauthenticatedSensitiveGet"] = unauth_status

    bootstrap_status, bootstrap = client.bootstrap(pairing_code)
    require(bootstrap_status == 201 and bootstrap.get("ok") is True, f"bootstrap failed: HTTP {bootstrap_status} {bootstrap}")
    require(bool(client.cookie and client.csrf), "bootstrap did not yield the in-memory cookie + CSRF pair")
    checks["bootstrap"] = bootstrap_status

    replay_status, replay = client.bootstrap(pairing_code)
    require(
        replay_status == 409 and error_code(replay) == "PAIRING_CONSUMED",
        f"pairing replay was not rejected: HTTP {replay_status} {replay}",
    )
    checks["pairingReplay"] = replay_status

    cookie_only_status, cookie_only, _ = client.request("GET", "/api/auth", cookie=client.cookie)
    require(
        cookie_only_status == 401 and error_code(cookie_only) == "MANAGEMENT_BROWSER_BINDING_REQUIRED",
        f"cookie-only request was accepted: HTTP {cookie_only_status} {cookie_only}",
    )
    checks["cookieOnly"] = cookie_only_status

    wrong_binding_status, wrong_binding, _ = client.request(
        "GET", "/api/auth", cookie=client.cookie, binding=client.wrong_binding,
    )
    require(
        wrong_binding_status == 401 and error_code(wrong_binding) == "MANAGEMENT_BROWSER_BINDING_INVALID",
        f"wrong browser binding was accepted: HTTP {wrong_binding_status} {wrong_binding}",
    )
    checks["wrongBinding"] = wrong_binding_status

    session_status, session, _ = client.request(
        "GET", "/api/auth", cookie=client.cookie, binding=client.browser_binding,
    )
    require(
        session_status == 200 and (session.get("data") or {}).get("authenticated") is True,
        f"paired session read failed: HTTP {session_status} {session}",
    )
    checks["authenticatedSession"] = session_status

    sensitive_status, sensitive, _ = client.request(
        "GET", "/api/workspace", cookie=client.cookie, binding=client.browser_binding,
    )
    require(sensitive_status == 200 and sensitive.get("storage") == "d1-local", f"sensitive GET failed: HTTP {sensitive_status} {sensitive}")
    checks["sensitiveGet"] = sensitive_status

    missing_csrf_status, missing_csrf, _ = client.request(
        "POST",
        "/api/workspace",
        {"action": "storage_probe"},
        cookie=client.cookie,
        binding=client.browser_binding,
        origin=True,
    )
    require(missing_csrf_status == 403, f"write without CSRF was accepted: HTTP {missing_csrf_status} {missing_csrf}")
    checks["missingCsrf"] = missing_csrf_status

    write_status, write, _ = client.request(
        "POST",
        "/api/workspace",
        {"action": "storage_probe"},
        cookie=client.cookie,
        binding=client.browser_binding,
        csrf=client.csrf,
        origin=True,
    )
    require(write_status == 200 and write.get("writable") is True, f"authenticated write failed: HTTP {write_status} {write}")
    checks["authenticatedWrite"] = write_status

    logout_status, logout, logout_headers = client.request(
        "POST",
        "/api/auth",
        {"action": "logout"},
        cookie=client.cookie,
        binding=client.browser_binding,
        csrf=client.csrf,
        origin=True,
    )
    require(logout_status == 200 and logout.get("ok") is True, f"logout failed: HTTP {logout_status} {logout}")
    require("Max-Age=0" in header_value(logout_headers, "set-cookie"), "logout did not clear the session cookie")
    checks["logout"] = logout_status

    revoked_status, revoked, _ = client.request(
        "GET", "/api/auth", cookie=client.cookie, binding=client.browser_binding,
    )
    require(
        revoked_status == 401 and error_code(revoked) == "MANAGEMENT_SESSION_INVALID",
        f"revoked session remained usable: HTTP {revoked_status} {revoked}",
    )
    checks["revokedSession"] = revoked_status

    pairing_code = ""
    client.cookie = ""
    client.csrf = ""
    print(json.dumps({"ok": True, "checks": checks}, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
