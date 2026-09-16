import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const route = fs.readFileSync(new URL("../app/api/release-control/v2/route.ts", import.meta.url), "utf8");
const lifecycle = fs.readFileSync(new URL("../app/api/lifecycle/route.ts", import.meta.url), "utf8");

test("management route keeps the V2 management boundary explicit", () => {
  assert.match(route, /new Set\(\[\s*"readiness\.record",\s*"confirmation\.create",\s*"capabilities\.issue"/);
  assert.match(route, /async function issueCapabilities/);
  assert.match(route, /SECRET_ALREADY_DELIVERED/);
  assert.doesNotMatch(route, /capability\.consume|receipt\.append|readback\.append/);
  assert.match(route, /release_id IN \(SELECT id FROM lifecycle_releases WHERE article_id=\?\)/);
  assert.match(route, /ORDER BY frozen_at DESC/);
  assert.match(route, /MAX\(sequence\) AS sequence/);
  assert.doesNotMatch(route, /MAX\(event_sha256\)/);
  assert.match(route, /requireCurrentReleaseControlFacts\(db,\s*String\(row\.id\)\)/);
  assert.match(route, /verifyReleaseReadinessSnapshot\(snapshot,\s*current\)/);
  assert.match(route, /noCapabilityIssued:\s*true,\s*noExternalAction:\s*true/);
  assert.match(route, /NOT EXISTS \(SELECT 1 FROM release_publish_capabilities_v2/);
  assert.match(route, /'issued'/);
  assert.match(route, /READINESS_RUN_MISMATCH/);
});

test("schema bootstrap is additive and retains V2 constraints", () => {
  assert.doesNotMatch(route, /\b(?:DROP|ALTER)\s+TABLE\b/i);
  for (const name of ["release_control_v2_command_receipts", "release_readiness_snapshots", "article_publish_confirmations", "article_publish_confirmation_items", "release_publish_capabilities_v2", "publish_click_leases_v2", "release_external_action_freezes_v2", "publish_execution_receipt_events_v2", "release_authoritative_readbacks_v2"]) assert.match(route, new RegExp(`CREATE TABLE IF NOT EXISTS ${name}`));
  for (const trigger of ["publish_execution_receipt_events_v2_no_update", "publish_execution_receipt_events_v2_no_delete", "release_authoritative_readbacks_v2_no_update", "release_authoritative_readbacks_v2_no_delete"]) assert.match(route, new RegExp(trigger));
});

test("lifecycle current helper reads target enabled from profile json", () => {
  assert.match(lifecycle, /JSON\.parse\(String\(target\.profile_json/);
  assert.doesNotMatch(lifecycle, /target\.enabled/);
});
