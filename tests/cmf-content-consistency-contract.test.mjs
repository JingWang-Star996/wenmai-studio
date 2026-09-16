import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workflow = JSON.parse(fs.readFileSync(path.join(root, "governance", "cmf-content-consistency-workflow-contract.json"), "utf8"));
test("CMF workflow keeps judgment and publication boundaries explicit", () => {
  assert.equal(workflow.status, "adopted_local");
  assert.equal(workflow.routing.modelGatewayRequired, false);
  assert.equal(workflow.routing.publishPermissionGranted, false);
  assert.equal(workflow.collaboration.ruleId, "CMF-NC-001");
  assert.match(workflow.claimBoundary, /不授予发布权限/);
});
