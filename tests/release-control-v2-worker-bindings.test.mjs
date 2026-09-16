import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { createRuntimeAuthentication } from "../scripts/run-vinext.mjs";

function sink() {
  return { text: "", write(value) { this.text += value; } };
}

function generateRuntimeEnvironment() {
  const environment = {};
  const output = sink();
  createRuntimeAuthentication(environment, output, {
    platform: "win32",
    persistLocalImportCredentialImpl: () => {},
  });
  return { environment, output };
}

test("每次本机 serve 启动均生成独立的至少 32 字节 Release Control V2 host HMAC key，且不输出", () => {
  const first = generateRuntimeEnvironment();
  const second = generateRuntimeEnvironment();
  const firstKey = first.environment.WENMAI_RELEASE_CONTROL_V2_HOST_HMAC_KEY;
  const secondKey = second.environment.WENMAI_RELEASE_CONTROL_V2_HOST_HMAC_KEY;

  assert.match(firstKey, /^[A-Za-z0-9_-]+$/);
  assert.equal(Buffer.from(firstKey, "base64url").byteLength, 32);
  assert.notEqual(firstKey, secondKey);
  assert.doesNotMatch(first.output.text, new RegExp(firstKey));
  assert.doesNotMatch(second.output.text, new RegExp(secondKey));
});

test("Worker 仅在 serve 时接收临时 key，控制面默认关闭且 host-route 硬锁 false", async () => {
  const config = await readFile(new URL("../vite.config.ts", import.meta.url), "utf8");

  assert.match(config, /WENMAI_RELEASE_CONTROL_V2_ENABLED:\s*process\.env\.WENMAI_RELEASE_CONTROL_V2_ENABLED\s*\?\?\s*"false"/);
  assert.match(config, /WENMAI_PUBLISH_OPERATOR_HOST_ROUTE_VERIFIED:\s*"false"/);
  assert.match(config, /command === "serve" && process\.env\.WENMAI_RELEASE_CONTROL_V2_HOST_HMAC_KEY/);
  assert.match(config, /\? \{ WENMAI_RELEASE_CONTROL_V2_HOST_HMAC_KEY: process\.env\.WENMAI_RELEASE_CONTROL_V2_HOST_HMAC_KEY \}/);
  assert.doesNotMatch(config, /WENMAI_RELEASE_CONTROL_V2_HOST_HMAC_KEY:\s*["'`](?!process\.env)/);
});
