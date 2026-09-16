import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const route = fs.readFileSync(new URL("../app/api/release-control/v2/route.ts", import.meta.url), "utf8");

test("capability issue requires an exact article confirmation payload and all four bound items", () => {
  assert.match(route, /exact\(\s*command\.payload,\s*\["articleId", "confirmationId"\],\s*"capabilities\.issue payload"/);
  assert.match(route, /items\.length !== 4/);
  assert.match(route, /REQUIRED_PLATFORMS\.some/);
  assert.match(route, /current\.articleId !== articleId/);
  assert.match(route, /current\.runId !== String\(confirmationRow\.run_id\)/);
  assert.match(route, /verifyArticlePublishConfirmation/);
  assert.match(route, /CONFIRMATION_BINDING_INVALID/);
  assert.match(route, /RELEASE_CAPABILITY_ALREADY_EXISTS/);
  assert.match(route, /RELEASE_FACTS_DRIFTED/);
  assert.match(route, /RELEASE_FROZEN/);
});

test("capability issue is an atomic four-row batch with no plaintext nonce persistence", () => {
  assert.match(route, /await db\.batch\(\[/);
  assert.match(route, /release_publish_capabilities_v2\(id,confirmation_id/);
  assert.match(route, /await sha256ExecutionText\(entry\.nonce\)/);
  assert.doesNotMatch(route, /nonce_json|nonce: entry\.nonce/);
  assert.match(route, /secretDelivered: true/);
  assert.match(route, /SECRET_ALREADY_DELIVERED/);
});

test("frozen packet and receipt keep capability secrets out of durable command data", () => {
  assert.match(route, /createFrozenExecutionPacket/);
  assert.match(route, /phase: "publish_once"/);
  assert.match(route, /allowedActions: \[\.\.\.PUBLISH_ONCE_ACTIONS\]/);
  assert.match(route, /stopConditions: \[\.\.\.MANDATORY_STOP_CONDITIONS\]/);
  assert.match(route, /const receiptData = \{/);
  assert.doesNotMatch(route, /receiptData[\s\S]{0,600}nonce/);
  assert.match(route, /dom_contract_sha256 TEXT NOT NULL/);
});
