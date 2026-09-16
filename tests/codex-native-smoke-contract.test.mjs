import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";

import {
  CODEX_NATIVE_SMOKE_PACKET_SCHEMA,
  CODEX_NATIVE_SMOKE_RESULT_SCHEMA,
  createCodexNativeSmokePacket,
  createCodexNativeSmokeEnvelope,
  createCodexNativeSmokeResult,
  validateCodexNativeSmokeResult,
} from "../app/codex-native-smoke-contract.ts";

const execFileAsync = promisify(execFile);
const profileSha256 = "a".repeat(64);
const now = new Date("2026-08-28T00:05:00.000Z");
const options = { now, expectedProfileSha256: profileSha256 };

test("冻结 packet 与候选 result 有固定 schema、顺序、摘要和独立 receipt 分类", () => {
  const packet = createCodexNativeSmokePacket("smoke-001", { now: new Date("2026-08-28T00:00:00.000Z"), nonce: "b".repeat(32), profileSha256 });
  const envelope = createCodexNativeSmokeEnvelope(packet, options);
  const result = createCodexNativeSmokeResult(envelope, options);
  assert.equal(packet.schemaVersion, CODEX_NATIVE_SMOKE_PACKET_SCHEMA);
  assert.deepEqual(packet.input.rows, [{ id: "a", label: "alpha" }, { id: "b", label: "beta" }]);
  assert.deepEqual(packet.allowedActions, ["read_frozen_input", "emit_strict_json"]);
  assert.deepEqual(packet.forbiddenActions, ["network", "browser", "filesystem_write", "secret_access", "publish", "completion_claim"]);
  assert.equal(result.schemaVersion, CODEX_NATIVE_SMOKE_RESULT_SCHEMA);
  assert.deepEqual(result.output.rows, [{ id: "a", labelUpper: "ALPHA" }, { id: "b", labelUpper: "BETA" }]);
  assert.equal(result.routeReceiptVerification, "profile_reported_not_host_attested");
  const validation = validateCodexNativeSmokeResult(envelope, result, options);
  assert.deepEqual(validation.filesWritten, []);
  assert.equal(validation.actualModelVerification, "unverified");
  assert.equal(validation.nonceUniquenessVerification, "unverified");
  assert.equal(validation.toolUseVerification, "profile_reported_zero_not_host_attested");
});

test("校验拒绝未知字段、字段顺序漂移、错误摘要及一切非候选结果", () => {
  const packet = createCodexNativeSmokePacket("smoke-002", { now: new Date("2026-08-28T00:00:00.000Z"), nonce: "c".repeat(32), profileSha256 });
  const envelope = createCodexNativeSmokeEnvelope(packet, options);
  const result = createCodexNativeSmokeResult(envelope, options);
  assert.throws(() => validateCodexNativeSmokeResult({ ...envelope, extra: true }, result, options));
  const reordered = { workUnitId: packet.workUnitId, schemaVersion: packet.schemaVersion, ...packet };
  assert.throws(() => validateCodexNativeSmokeResult({ ...envelope, packet: reordered }, result, options));
  assert.throws(() => validateCodexNativeSmokeResult(envelope, { ...result, outputSha256: "0".repeat(64) }, options));
  assert.throws(() => validateCodexNativeSmokeResult(envelope, { ...result, result: "completed" }, options));
  assert.throws(() => validateCodexNativeSmokeResult(envelope, { ...result, files_written: ["forbidden.txt"] }, options));
  assert.throws(() => validateCodexNativeSmokeResult(envelope, { ...result, tool_calls: ["forbidden"] }, options));
  assert.throws(() => validateCodexNativeSmokeResult(envelope, { ...result, routeReceiptVerification: "host_attested" }, options));
  for (const drift of [{ agentProfileId: "other" }, { requiredConfiguredModel: "other" }, { fallbackPolicy: "allow" }, { toolPolicy: "read" }, { networkAllowed: true }, { expectedOutputSha256: "d".repeat(64) }, { profileSha256: "e".repeat(64) }]) {
    assert.throws(() => validateCodexNativeSmokeResult({ ...envelope, packet: { ...packet, ...drift } }, result, options));
  }
  assert.throws(() => validateCodexNativeSmokeResult({ ...envelope, packet: { ...packet, nonce: "bad" } }, result, options));
  assert.throws(() => validateCodexNativeSmokeResult(envelope, result, { ...options, knownNonces: new Set([packet.nonce]) }));
  assert.throws(() => validateCodexNativeSmokeResult({ ...envelope, packet: { ...packet, expiresAt: "2026-08-28T00:05:00.000Z" } }, result, options));
  assert.throws(() => validateCodexNativeSmokeResult({ ...envelope, packet: { ...packet, issuedAt: "2026-08-28T00:06:00.000Z" } }, result, options));
  assert.throws(() => validateCodexNativeSmokeResult({ packet, packetSha256: "0".repeat(64) }, result, options));
});

test("只读 CLI 可以 prepare 并校验测试构造的有效 JSON，不调用模型", async () => {
  const root = new URL("../", import.meta.url);
  const workUnitId = "smoke-cli-003";
  const prepared = await execFileAsync(process.execPath, ["--experimental-strip-types", "scripts/codex-native-smoke.mjs", "prepare", workUnitId], { cwd: root });
  const envelope = JSON.parse(prepared.stdout);
  const packet = envelope.packet;
  assert.match(packet.nonce, /^[a-f0-9]{64}$/u);
  assert.equal(Date.parse(packet.expiresAt) - Date.parse(packet.issuedAt), 600000);
  const result = createCodexNativeSmokeResult(envelope, { expectedProfileSha256: packet.profileSha256 });
  const directory = await mkdtemp(join(tmpdir(), "wenmai-codex-native-smoke-"));
  const packetPath = join(directory, "packet.json");
  const resultPath = join(directory, "result.json");
  await Promise.all([writeFile(packetPath, JSON.stringify(envelope)), writeFile(resultPath, JSON.stringify(result))]);
  const validated = await execFileAsync(process.execPath, ["--experimental-strip-types", "scripts/codex-native-smoke.mjs", "validate", packetPath, resultPath], { cwd: root });
  assert.deepEqual(JSON.parse(validated.stdout), {
    packetSha256: result.packetSha256,
    outputSha256: result.outputSha256,
    result: "candidate_only",
    filesWritten: [],
    actualModelVerification: "unverified",
    nonceUniquenessVerification: "unverified",
    toolUseVerification: "profile_reported_zero_not_host_attested",
    hostObservationProvided: false,
  });
});
