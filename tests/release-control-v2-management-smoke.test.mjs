import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const route = fs.readFileSync(new URL("../app/api/release-control/v2/route.ts", import.meta.url), "utf8");

test("schema bootstrap declares all indexes and append-only triggers for an empty D1", () => {
  assert.match(route, /export async function ensureReleaseControlV2Schema/);
  assert.match(route, /CREATE UNIQUE INDEX IF NOT EXISTS idx_receipt_events_v2_chain_sequence/);
  assert.match(route, /CREATE INDEX IF NOT EXISTS idx_release_authoritative_readbacks_v2_release_kind_observed/);
  assert.match(route, /CREATE TRIGGER IF NOT EXISTS publish_execution_receipt_events_v2_no_update/);
});

test("unauthorized, cross-origin and secret-safe paths remain delegated to management auth", () => {
  assert.match(route, /requireManagementSession\(request, \{ scope, mutation, articleId \}\)/);
  assert.match(route, /management\(request,\s*"management\.read",\s*false,\s*articleId\)/);
  assert.match(route, /management\(\s*request,\s*command\.action === "readiness\.record"\s*\? "release\.record"\s*:\s*"release\.approve",\s*true/);
  assert.match(route, /!\/\(packet_json\|nonce\|token\|hmac\|signature\)\/iu\.test\(key\)/);
  assert.match(route, /boundary\(principal,\s*current\.articleId\)/);
  assert.match(route, /boundary\(principal,\s*articleId\);\s*owner\(principal\)/);
});

test("host actions are not accepted and capability issuance stays management-only", () => {
  assert.match(route, /const ACTIONS: ReadonlySet<string> = new Set\(\[\s*"readiness\.record",\s*"confirmation\.create",\s*"capabilities\.issue"/);
  assert.match(route, /await issueCapabilities\(db, command, principal, actor, requestSha\)/);
  assert.match(route, /CAPABILITY_ALREADY_ISSUED/);
});
