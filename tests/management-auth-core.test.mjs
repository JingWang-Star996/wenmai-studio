import assert from "node:assert/strict";
import test from "node:test";

import {
  MANAGEMENT_CANONICAL_ORIGIN,
  MANAGEMENT_SESSION_COOKIE,
  ManagementAuthError,
  assertCanonicalManagementTransport,
  clearManagementSessionCookie,
  constantTimeTextEqual,
  deriveCsrfToken,
  managementSessionCookie,
  parseCookieHeader,
  randomToken,
  sha256Text,
} from "../app/management-auth-core.ts";

test("management auth core 固定在显式 IPv6 loopback origin", () => {
  assert.equal(MANAGEMENT_CANONICAL_ORIGIN, "http://[::1]:3000");
  const accepted = new Request("http://[::1]:3000/api/auth", {
    method: "POST",
    headers: { origin: "http://[::1]:3000", "sec-fetch-site": "same-origin" },
  });
  assert.doesNotThrow(() => assertCanonicalManagementTransport(accepted, MANAGEMENT_CANONICAL_ORIGIN, { mutation: true }));
  const vinextRuntimeMirror = new Request("http://[::1]:3000/api/auth", {
    method: "POST",
    headers: {
      host: "[::1]:3000",
      "x-forwarded-host": "[::1]:3000",
      origin: "http://[::1]:3000",
      "sec-fetch-site": "same-origin",
    },
  });
  assert.doesNotThrow(() => assertCanonicalManagementTransport(vinextRuntimeMirror, MANAGEMENT_CANONICAL_ORIGIN, { mutation: true }));

  for (const request of [
    new Request("http://127.0.0.1:3000/api/auth", { method: "POST", headers: { origin: "http://127.0.0.1:3000" } }),
    new Request("http://[::1]:3000/api/auth", { method: "POST", headers: { origin: "https://attacker.example" } }),
    new Request("http://[::1]:3000/api/auth", { method: "POST", headers: { origin: "http://[::1]:3000", forwarded: "host=attacker.example" } }),
  ]) {
    assert.throws(
      () => assertCanonicalManagementTransport(request, MANAGEMENT_CANONICAL_ORIGIN, { mutation: true }),
      ManagementAuthError,
    );
  }
});

test("管理传输拒绝矩阵区分 canonical、代理、Origin 与 Fetch Metadata", () => {
  const cases = [
    {
      name: "IPv4 loopback 不是 canonical origin",
      request: new Request("http://127.0.0.1:3000/api/workspace", { method: "POST", headers: { origin: "http://127.0.0.1:3000" } }),
      code: "CANONICAL_ORIGIN_REQUIRED",
      status: 421,
    },
    {
      name: "伪造 Host",
      request: new Request("http://[::1]:3000/api/workspace", { method: "POST", headers: { host: "attacker.example", origin: "http://[::1]:3000" } }),
      code: "CANONICAL_HOST_REQUIRED",
      status: 421,
    },
    {
      name: "代理身份头",
      request: new Request("http://[::1]:3000/api/workspace", { method: "POST", headers: { origin: "http://[::1]:3000", "x-forwarded-for": "203.0.113.10" } }),
      code: "FORWARDED_REQUEST_FORBIDDEN",
      status: 421,
    },
    ...[
      { "x-forwarded-host": "[::1]:3000" },
      { host: "[::1]:3000", "x-forwarded-host": "attacker.example" },
      { host: "[::1]:3000", "x-forwarded-host": "[::1]:3000, attacker.example" },
      { host: "[::1]:3000", "x-forwarded-proto": "http" },
      { host: "[::1]:3000", "x-forwarded-port": "3000" },
      { host: "[::1]:3000", "x-real-ip": "::1" },
      { host: "[::1]:3000", forwarded: "for=\"[::1]\";host=\"[::1]:3000\"" },
    ].map((headers, index) => ({
      name: `代理红队矩阵 ${index + 1}`,
      request: new Request("http://[::1]:3000/api/workspace", {
        method: "POST",
        headers: { origin: "http://[::1]:3000", ...headers },
      }),
      code: "FORWARDED_REQUEST_FORBIDDEN",
      status: 421,
    })),
    {
      name: "写入缺失 Origin",
      request: new Request("http://[::1]:3000/api/workspace", { method: "POST" }),
      code: "ORIGIN_MISMATCH",
      status: 403,
    },
    {
      name: "跨站 Fetch Metadata",
      request: new Request("http://[::1]:3000/api/workspace", { method: "POST", headers: { origin: "http://[::1]:3000", "sec-fetch-site": "cross-site" } }),
      code: "CROSS_SITE_REQUEST_FORBIDDEN",
      status: 403,
    },
  ];
  for (const item of cases) {
    assert.throws(
      () => assertCanonicalManagementTransport(item.request, MANAGEMENT_CANONICAL_ORIGIN, { mutation: true }),
      (error) => {
        assert.equal(error instanceof ManagementAuthError, true, item.name);
        assert.equal(error.code, item.code, item.name);
        assert.equal(error.status, item.status, item.name);
        return true;
      },
    );
  }

  assert.doesNotThrow(() => assertCanonicalManagementTransport(
    new Request("http://[::1]:3000/api/auth", { method: "GET" }),
    MANAGEMENT_CANONICAL_ORIGIN,
  ));
  assert.doesNotThrow(() => assertCanonicalManagementTransport(
    new Request("http://[::1]:3000/api/auth", {
      method: "GET",
      headers: { host: "[::1]:3000", "x-forwarded-host": "[::1]:3000" },
    }),
    MANAGEMENT_CANONICAL_ORIGIN,
  ));
  for (const fetchSite of ["same-origin", "none"]) {
    assert.doesNotThrow(() => assertCanonicalManagementTransport(
      new Request("http://[::1]:3000/api/workspace", {
        method: "POST",
        headers: { origin: "http://[::1]:3000", "sec-fetch-site": fetchSite },
      }),
      MANAGEMENT_CANONICAL_ORIGIN,
      { mutation: true },
    ));
  }
});

test("management cookie 是 host-only HttpOnly Strict 且可明确清除", () => {
  const token = `wenmai_management_${randomToken(32)}`;
  const header = managementSessionCookie(token);
  assert.match(header, new RegExp(`^${MANAGEMENT_SESSION_COOKIE}=`));
  assert.match(header, /Path=\//);
  assert.match(header, /HttpOnly/);
  assert.match(header, /SameSite=Strict/);
  assert.doesNotMatch(header, /Domain=/i);
  assert.doesNotMatch(header, /Secure/i, "纯 HTTP loopback 不应虚构 Secure cookie");
  assert.match(clearManagementSessionCookie(), /Max-Age=0/);
  assert.equal(parseCookieHeader(header).get(MANAGEMENT_SESSION_COOKIE), token);
});

test("session 只需持久化摘要，CSRF 由进程密钥稳定派生", async () => {
  const token = `wenmai_management_${randomToken(32)}`;
  const tokenSha = await sha256Text(token);
  assert.match(tokenSha, /^[a-f0-9]{64}$/);
  assert.notEqual(tokenSha, token);
  const key = randomToken(32);
  const first = await deriveCsrfToken(token, key);
  const second = await deriveCsrfToken(token, key);
  const other = await deriveCsrfToken(`${token}x`, key);
  assert.equal(first, second);
  assert.notEqual(first, other);
  assert.equal(constantTimeTextEqual(first, second), true);
  assert.equal(constantTimeTextEqual(first, other), false);
  await assert.rejects(
    () => deriveCsrfToken(token, "too-short"),
    (error) => error instanceof ManagementAuthError
      && error.code === "AUTH_RUNTIME_UNAVAILABLE"
      && error.status === 503,
  );
});
