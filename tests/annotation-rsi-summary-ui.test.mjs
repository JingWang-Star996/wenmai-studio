import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const text = (path) => readFile(new URL(path, root), "utf8");

test("human fallback UI is label-first and omits removed governance panels", async () => {
  const ui = await text("app/HumanReviewPanel.tsx");
  for (const value of ["通过", "失败", "需修改", "supersedesAnnotationId", "approve_rule_candidate", "baseline-revisions"]) assert.match(ui, new RegExp(value));
  assert.doesNotMatch(ui, /review-queue|gate-attestations|record_gate_attestation|snooze/u);
  assert.doesNotMatch(ui, /JSON\.stringify\(\{ action, articleId,/u);
});

test("RSI contract and route expose only the reduced lifecycle", async () => {
  const contract = JSON.parse(await text("governance/vnext-annotation-rsi-contract.json"));
  const source = await text("app/api/annotation-rsi/v1/route.ts") + await text("app/annotation-rsi-lifecycle.ts");
  assert.deepEqual(contract.limits, { requestBytes: 122880, candidateSourceBindings: 64, candidateVariants: 16, ruleJsonBytes: 32768, proposalItems: 32 });
  for (const removed of ["review_queue", "gate_attestation", "decide_review_queue_item", "record_gate_attestation"]) assert.doesNotMatch(source, new RegExp(removed));
  assert.match(source, /LIMIT 32/u);
  assert.match(source, /found\.results\.length !== names\.length/u);
});
