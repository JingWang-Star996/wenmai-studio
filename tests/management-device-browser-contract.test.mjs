import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const text = async (path) => readFile(new URL(path, import.meta.url), "utf8");

test("可信设备私钥是 IndexedDB 内不可导出的 P-256 CryptoKey，临时认证秘密不进入 Web Storage", async () => {
  const [deviceKey, gate, binding] = await Promise.all([
    text("../app/management-device-key.ts"),
    text("../app/ManagementSessionGate.tsx"),
    text("../app/management-browser-binding.ts"),
  ]);

  assert.match(deviceKey, /indexedDB\.open\(DATABASE_NAME, 1\)/);
  assert.match(deviceKey, /createObjectStore\(STORE_NAME, \{ keyPath: "slot" \}\)/);
  assert.match(deviceKey, /transaction\(STORE_NAME, "readwrite"\)/);
  assert.match(deviceKey, /transaction\.objectStore\(STORE_NAME\)\.put\(device\)/);
  assert.match(deviceKey, /generateKey\([\s\S]*name: "ECDSA", namedCurve: "P-256"[\s\S]*false,[\s\S]*\["sign", "verify"\]/);
  assert.match(deviceKey, /keyPair\.privateKey\.extractable/);
  assert.match(deviceKey, /key\.extractable === false/);
  assert.match(deviceKey, /key\.type === "private"/);
  assert.match(deviceKey, /key\.usages\.includes\("sign"\)/);
  assert.match(deviceKey, /exportKey\("jwk", keyPair\.publicKey\)/);
  assert.doesNotMatch(deviceKey, /exportKey\([^\n]*privateKey|exportKey\("(?:pkcs8|raw)"/);
  assert.match(deviceKey, /typeof value\.d === "string"/);
  assert.doesNotMatch(deviceKey, /localStorage|sessionStorage|document\.cookie/);

  assert.doesNotMatch(gate, /localStorage|sessionStorage|location\.hash|URLSearchParams/);
  assert.match(gate, /body: JSON\.stringify\(body\)/);
  assert.match(gate, /pairingCode: pairingCode\.trim\(\)/);
  assert.match(binding, /window\.localStorage/);
  assert.doesNotMatch(binding, /pairing|csrf|session[_-]?token|nonce|signature/i);
});

test("客户端先尝试受信恢复，严格复算签名上下文，失败后保留人工配对路径", async () => {
  const [deviceKey, gate] = await Promise.all([
    text("../app/management-device-key.ts"),
    text("../app/ManagementSessionGate.tsx"),
  ]);

  for (const field of ["origin", "boot", "binding"]) {
    assert.match(deviceKey, new RegExp("`" + field + "=\\$\\{input\\."));
  }
  assert.match(deviceKey, /`device=\$\{device\.deviceId\}`/);
  assert.match(deviceKey, /`publicKey=\$\{device\.publicKeySha256\}`/);
  for (const field of ["challenge", "nonce"]) {
    assert.match(deviceKey, new RegExp("`" + field + "=\\$\\{input\\."));
  }
  assert.match(deviceKey, /crypto\.subtle\.sign\([\s\S]*name: "ECDSA", hash: "SHA-256"/);
  assert.match(deviceKey, /navigator\.locks\.request\("wenmai-management-device-resume-v1", \{ mode: "exclusive" \}/);

  assert.match(gate, /action: "device\.begin"/);
  assert.match(gate, /action: "device\.complete"/);
  assert.match(gate, /begin\.signingPayload !== expectedPayload/);
  assert.match(gate, /expiresAt - issuedAt > 60_000/);
  assert.match(gate, /signManagementDeviceMessage\(device, expectedPayload\)/);
  assert.match(gate, /TRUSTED_DEVICE_FALLBACK_CODES/);
  assert.match(gate, /clearManagementTrustedDevice\(\)/);
  assert.match(gate, /setState\("restoring"\)/);
  assert.match(gate, /正在用已信任的本机浏览器安全打开文脉/);

  // Recovery must not be disabled merely because the short manual fallback
  // code has expired. A present device + boot id are the recovery preconditions.
  const restoreFunction = gate.slice(
    gate.indexOf("async function restoreTrustedManagementSession"),
    gate.indexOf("async function enrollCurrentManagementDevice"),
  );
  assert.match(restoreFunction, /if \(!device \|\| !initial\.bootId\) return null/);
  assert.doesNotMatch(restoreFunction, /pairing\?\.available/);

  assert.match(gate, /action: "bootstrap"/);
  assert.match(gate, /type="password"/);
  assert.match(gate, /autoComplete="one-time-code"/);
  assert.match(gate, /自动进入未完成/);
  assert.match(gate, /完成这一次人类确认；同一浏览器在凭据仍有效时可自动进入。/);
  assert.match(gate, /其他 Agent 调用文脉，不要把这里的配对码交给它/);
  assert.match(gate, /Agent 中心 → 权限与 Key/);
  assert.match(gate, /Windows DPAPI 档案名/);
  assert.match(gate, /旧配对码无法找回/);
  assert.match(gate, /pairingInputRef\.current\?\.focus\(\)/);
});

test("设备登记只在现有管理会话内通过 managementFetch 发起，主动退出同时清理本机设备", async () => {
  const gate = await text("../app/ManagementSessionGate.tsx");
  const enroll = gate.slice(
    gate.indexOf("async function enrollCurrentManagementDevice"),
    gate.indexOf("export function useManagementSession"),
  );
  assert.match(enroll, /auth\.authenticated/);
  assert.match(enroll, /auth\.csrfToken/);
  assert.match(enroll, /managementFetch\("\/api\/auth"/);
  assert.match(enroll, /action: "device\.enroll"/);
  assert.match(enroll, /publicKeyJwk: device\.publicKeyJwk/);
  assert.match(enroll, /signature/);

  const logout = gate.slice(gate.indexOf("async function logout"), gate.indexOf("async function authenticatedFetch"));
  assert.match(logout, /action: "logout"/);
  assert.match(logout, /clearManagementTrustedDevice\(\)/);
  assert.match(logout, /clearManagementBrowserBinding\(\)/);
  assert.ok(logout.indexOf("clearManagementTrustedDevice()") > logout.indexOf("await readEnvelope(response)"));
});

test("完整站内管理 Key 仅走 Bearer 兑换，且不登记可信设备", async () => {
  const gate = await text("../app/ManagementSessionGate.tsx");
  const exchange = gate.slice(gate.indexOf("async function exchangeSiteFullControl"), gate.indexOf("async function logout"));
  assert.match(exchange, /authorization: `Bearer \$\{siteFullControlKey\}`/);
  assert.match(exchange, /"X-Wenmai-Browser-Binding": browserBinding/);
  assert.match(exchange, /body: JSON\.stringify\(\{ action: "site_full_control\.exchange", browserBindingSha256, exchangeCommandId:/);
  assert.doesNotMatch(exchange, /siteFullControlKey[\s\S]{0,120}body:/);
  assert.match(exchange, /setSiteFullControlKey\(""\)/);
  assert.match(gate, /auth\.authBasis === "site_full_control_key" \|\| auth\.session\.authBasis === "site_full_control_key"/);
  assert.match(gate, /完整站内管理会话/);
  assert.match(gate, /此会话不会登记为可信设备/);
  const enrollmentEffect = gate.slice(gate.indexOf("useEffect(() => {\n    if (state !== \"ready\""), gate.indexOf("useEffect(() => {\n    if (state === \"locked\""));
  assert.match(enrollmentEffect, /auth\.authBasis === "site_full_control_key"/);
});
