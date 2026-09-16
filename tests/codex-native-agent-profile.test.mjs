import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const profile = readFileSync(new URL("../../.codex/agents/wenmai-fast-worker.toml", import.meta.url), "utf8");
const schema = JSON.parse(readFileSync(new URL("../contracts/codex-native-smoke-result.schema.json", import.meta.url), "utf8"));

test("Luna fast worker 是只读低推理工位，smoke 只允许逐字段 JSON 输出", () => {
  assert.match(profile, /^name = "wenmai_fast_worker"$/mu);
  assert.match(profile, /^model = "gpt-5\.6-luna"$/mu);
  assert.match(profile, /^model_reasoning_effort = "low"$/mu);
  assert.match(profile, /^sandbox_mode = "read-only"$/mu);
  for (const required of [
    "wenmai.codex-native-smoke/1.0",
    "uppercase-labels/1.0",
    "read_frozen_input",
    "emit_strict_json",
    "不得使用工具、文件、网络或浏览器",
    "profile_reported_not_host_attested",
    "单个原始 JSON 对象",
    "不得 Markdown",
    "schemaVersion、workUnitId、packetSha256、output、outputSha256、result、files_written、tool_calls、routeReceipt、routeReceiptVerification",
    "绝不得调用工具",
    "唯一合法 raw JSON 骨架",
    "wenmai.codex-native-smoke-result/1.0",
    "\"labelUpper\":\"ALPHA\"",
    "\"labelUpper\":\"BETA\"",
  ]) assert.match(profile, new RegExp(required.replaceAll("/", "\\/")));
  for (const forbidden of ["发布授权", "最终完成声明", "completion_claim", "secret_access"]) {
    assert.match(profile, new RegExp(forbidden));
  }
});

test("smoke output schema 固定结果顶层、输出行和 profile receipt，拒绝额外字段", () => {
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, ["schemaVersion", "workUnitId", "packetSha256", "output", "outputSha256", "result", "files_written", "tool_calls", "routeReceipt", "routeReceiptVerification"]);
  assert.equal(schema.properties.schemaVersion.const, "wenmai.codex-native-smoke-result/1.0");
  assert.equal(schema.properties.output.additionalProperties, false);
  assert.equal(schema.properties.output.properties.schemaVersion.const, "uppercase-labels/1.0");
  const rows = schema.properties.output.properties.rows;
  assert.equal(rows.prefixItems, undefined);
  assert.deepEqual(rows.items.required, ["id", "labelUpper"]);
  assert.equal(rows.items.additionalProperties, false);
  assert.deepEqual(rows.items.properties.id.enum, ["a", "b"]);
  assert.deepEqual(rows.items.properties.labelUpper.enum, ["ALPHA", "BETA"]);
  assert.equal(rows.minItems, 2);
  assert.equal(rows.maxItems, 2);
  assert.equal(schema.properties.files_written.maxItems, 0);
  assert.equal(schema.properties.tool_calls.maxItems, 0);
  assert.equal(schema.properties.files_written.items.type, "string");
  assert.equal(schema.properties.tool_calls.items.type, "string");
  assert.equal(schema.properties.routeReceipt.properties.agent.const, "wenmai_fast_worker");
  assert.equal(schema.properties.routeReceiptVerification.const, "profile_reported_not_host_attested");
});
