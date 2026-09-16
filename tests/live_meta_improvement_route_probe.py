#!/usr/bin/env python3
"""Probe the real local meta-improvement route without persisting credentials."""

from __future__ import annotations

import json

from live_management_auth_probe import LiveAuthClient, error_code, read_pairing_code, require


BASE_URL = "http://[::1]:3000"


def data_of(envelope: dict) -> dict:
    value = envelope.get("data")
    return value if isinstance(value, dict) else {}


def post_action(client: LiveAuthClient, action: str, command_id: str, payload: dict) -> tuple[int, dict]:
    status, envelope, _ = client.request(
        "POST",
        "/api/improvement/v1",
        {"action": action, "commandId": command_id, "payload": payload},
        cookie=client.cookie,
        binding=client.browser_binding,
        csrf=client.csrf,
        origin=True,
    )
    return status, envelope


def main() -> int:
    pairing_code = read_pairing_code()
    require(bool(pairing_code), "pairing code is required")
    client = LiveAuthClient(BASE_URL)
    checks: dict[str, object] = {}

    bootstrap_status, bootstrap = client.bootstrap(pairing_code)
    require(bootstrap_status == 201 and bootstrap.get("ok") is True, "management bootstrap failed")
    require(bool(client.cookie and client.csrf), "management bootstrap omitted session credentials")

    try:
        before_status, before, _ = client.request(
            "GET",
            "/api/improvement/v1?view=status",
            cookie=client.cookie,
            binding=client.browser_binding,
        )
        require(
            before_status in {200, 409},
            f"unexpected pre-initialization status: HTTP {before_status} {error_code(before)}",
        )
        if before_status == 409:
            require(error_code(before) == "IMPROVEMENT_NOT_INITIALIZED", "GET returned an unrelated initialization error")
        checks["preInitialization"] = "ready" if before_status == 200 else "explicit_write_required"

        initialize_status, initialize = post_action(
            client,
            "initialize_workspace",
            "live-meta.initialize.001",
            {},
        )
        require(initialize_status == 200 and initialize.get("ok") is True, "explicit initialization failed")
        require(data_of(initialize).get("initialized") is True, "initialization receipt was incomplete")
        checks["explicitInitialization"] = initialize_status

        status_code, status_envelope, _ = client.request(
            "GET",
            "/api/improvement/v1?view=status",
            cookie=client.cookie,
            binding=client.browser_binding,
        )
        require(status_code == 200 and status_envelope.get("ok") is True, "dashboard read failed")
        dashboard = data_of(status_envelope)
        targets = dashboard.get("targets") if isinstance(dashboard.get("targets"), list) else []
        providers = dashboard.get("providers") if isinstance(dashboard.get("providers"), list) else []
        require(len(targets) == 3, f"expected three meta targets, got {len(targets)}")
        provider_by_id = {item.get("id"): item for item in providers if isinstance(item, dict)}
        require(provider_by_id.get("deepseek", {}).get("configured") is True, "DeepSeek was not configured in the local Worker")
        require(provider_by_id.get("qwen", {}).get("configured") is False, "Qwen unexpectedly appeared configured")
        policy = dashboard.get("policy") if isinstance(dashboard.get("policy"), dict) else {}
        require(policy.get("apiConnectionIsMetaImprovement") is False, "dashboard collapsed API connectivity into meta-improvement")
        require(policy.get("estimatedCostBudgetEnforced") is False, "dashboard overstated CNY cost enforcement")
        checks["dashboard"] = {"targets": len(targets), "deepseekConfigured": True, "qwenConfigured": False}

        probe_status, probe = post_action(
            client,
            "test_provider",
            "live-meta.deepseek-probe.001",
            {"provider": "deepseek"},
        )
        require(probe_status == 200 and probe.get("ok") is True, "DeepSeek route probe failed")
        test_result = data_of(probe).get("test")
        require(isinstance(test_result, dict), "DeepSeek route probe omitted its safe result")
        require(test_result.get("result") == "pass" and test_result.get("markerMatched") is True, "DeepSeek marker did not pass")
        checks["deepseekRouteProbe"] = {
            "result": "pass",
            "markerMatched": True,
            "model": test_result.get("model"),
            "latencyMs": test_result.get("latencyMs"),
        }
    finally:
        if client.cookie and client.csrf:
            client.request(
                "POST",
                "/api/auth",
                {"action": "logout"},
                cookie=client.cookie,
                binding=client.browser_binding,
                csrf=client.csrf,
                origin=True,
            )
        pairing_code = ""
        client.cookie = ""
        client.csrf = ""

    print(json.dumps({"ok": True, "checks": checks}, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
