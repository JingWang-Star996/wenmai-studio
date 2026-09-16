import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../app/model-invocation-checkpoint.ts", import.meta.url), "utf8");

test("模型响应必须先按 invocation 唯一 checkpoint 再物化", () => {
  assert.match(source, /INSERT INTO model_invocation_outputs/u);
  assert.match(source, /FROM model_invocations WHERE id = \? AND state = 'running'/u);
  assert.match(source, /ON CONFLICT\(invocation_id\) DO NOTHING/u);
  assert.match(source, /CHECKPOINT_DIGEST_CONFLICT/u);
  assert.match(source, /materialization_state = 'materialized'/u);
  assert.match(source, /materialization_ref = \?/u);
  assert.match(source, /materialization_state = 'blocked'/u);
});

test("checkpoint 合同不包含凭据或请求头字段", () => {
  assert.doesNotMatch(source, /api.?key|authorization|request_headers/iu);
  assert.match(source, /response_sha256/u);
  assert.match(source, /usage_sha256/u);
});
