import assert from "node:assert/strict";
import test from "node:test";

import {
  LOCAL_IMPORT_BOOT_HEADER,
  LOCAL_IMPORT_CANONICAL_ORIGIN,
  LocalImportAuthError,
  authenticateLocalImportRequest,
} from "../app/local-import-auth-core.ts";
import { sha256Text } from "../app/management-auth-core.ts";

const token = `wenmai_local_import_${"A".repeat(43)}`;
const runtime = {
  canonicalOrigin: LOCAL_IMPORT_CANONICAL_ORIGIN,
  bootId: `local-import-boot-${"B".repeat(22)}`,
  tokenSha256: await sha256Text(token),
};

function request(overrides = {}) {
  return new Request(overrides.url ?? "http://[::1]:3000/api/local-import/v1", {
    method: overrides.method ?? "POST",
    headers: {
      host: "[::1]:3000",
      authorization: `Bearer ${token}`,
      [LOCAL_IMPORT_BOOT_HEADER]: runtime.bootId,
      ...overrides.headers,
    },
  });
}

test("本机导入凭据只接受当前 boot 的 IPv6 loopback CLI 请求", async () => {
  await assert.doesNotReject(() => authenticateLocalImportRequest(request(), runtime));
  await assert.doesNotReject(() => authenticateLocalImportRequest(request({ headers: {
    "x-forwarded-host": "[0000:0000:0000:0000:0000:0000:0000:0001]:3000",
  } }), runtime));
  await assert.doesNotReject(() => authenticateLocalImportRequest(request({ headers: {
    "x-forwarded-host": "[::1]:3000",
    "x-forwarded-for": "::1",
    "x-forwarded-port": "3000",
    "x-forwarded-proto": "http",
  } }), runtime));

  const rejected = [
    request({ url: "http://127.0.0.1:3000/api/local-import/v1", headers: { host: "127.0.0.1:3000" } }),
    request({ headers: { origin: "http://[::1]:3000" } }),
    request({ headers: { cookie: "wenmai_management_session=wrong-surface" } }),
    request({ headers: { "x-forwarded-for": "::1" } }),
    request({ headers: { "x-forwarded-host": "example.invalid:3000" } }),
    request({ headers: { [LOCAL_IMPORT_BOOT_HEADER]: `local-import-boot-${"C".repeat(22)}` } }),
    request({ headers: { authorization: `Bearer wenmai_local_import_${"D".repeat(43)}` } }),
  ];
  for (const candidate of rejected) {
    await assert.rejects(
      () => authenticateLocalImportRequest(candidate, runtime),
      (error) => error instanceof LocalImportAuthError && error.status >= 401,
    );
  }
});

test("服务重启后旧 DPAPI 凭据因 bootId 轮换而失败关闭", async () => {
  await assert.rejects(
    () => authenticateLocalImportRequest(request(), { ...runtime, bootId: `local-import-boot-${"E".repeat(22)}` }),
    (error) => error instanceof LocalImportAuthError && error.code === "LOCAL_IMPORT_BOOT_MISMATCH",
  );
});
