import assert from "node:assert/strict";
import test from "node:test";

import {
  MODEL_ROUTING_MECHANICAL_TASKS,
  MODEL_ROUTING_MATRIX,
  planModelRoute,
} from "../app/model-routing.ts";

const ready = Object.freeze({
  gateways: { openai: true, ollama: true, deepseek: true, qwen: true },
  customAgents: { wenmai_fast_worker: true, wenmai_publish_operator: true },
  coordinator: true,
  human: true,
});

function input(overrides = {}) {
  return {
    phase: "intermediate_fast",
    risk: "low",
    dataSensitivity: "public",
    requiresBrowser: false,
    requiresJudgment: false,
    providerReadiness: ready,
    frozenInput: true,
    contentMutationRequested: false,
    mechanicalTask: "strict_schema_transform",
    inputSha256: "a".repeat(64),
    outputSchemaId: "wenmai.mechanical.rows",
    outputSchemaVersion: "1.0",
    candidateOnly: true,
    ...overrides,
  };
}

test("阶段矩阵固定动作且不把 Spark 当作 API provider", () => {
  assert.equal(Object.isFrozen(MODEL_ROUTING_MATRIX), true);
  assert.deepEqual(MODEL_ROUTING_MATRIX.map((row) => row.automaticRetries), Array(8).fill(0));
  const fast = MODEL_ROUTING_MATRIX.find((row) => row.phase === "intermediate_fast");
  assert.ok(fast);
  assert.ok(fast.orderedSurfaces.includes("codex_custom_agent:wenmai_fast_worker"));
  assert.equal(fast.orderedSurfaces.some((surface) => surface.includes("spark")), false);
  assert.deepEqual(MODEL_ROUTING_MECHANICAL_TASKS, ["classify", "extract", "deduplicate", "format_map", "strict_schema_transform"]);
  assert.equal(fast.modelMayRewriteContent, false);
});

test("中间模型必须接收完整冻结机械任务；敏感数据不会回退到云端", () => {
  const mutable = planModelRoute(input({ frozenInput: false }));
  assert.equal(mutable.state, "escalated");
  assert.equal(mutable.primary.kind, "coordinator");
  assert.ok(mutable.reasonCodes.includes("MECHANICAL_TASK_CONTRACT_REQUIRED"));
  assert.equal(mutable.constraints.externalWriteAllowed, false);

  const restricted = planModelRoute(input({ dataSensitivity: "restricted" }));
  assert.equal(restricted.primary.kind, "gateway");
  assert.equal(restricted.primary.id, "ollama");
  assert.ok(restricted.reasonCodes.includes("SENSITIVE_DATA_BLOCKS_CLOUD"));
  assert.equal(restricted.candidates.some((surface) => surface.kind === "gateway" && surface.id === "openai"), false);
  assert.equal(restricted.constraints.contentRewriteAllowed, false);

  for (const override of [
    { mechanicalTask: undefined },
    { inputSha256: "short" },
    { outputSchemaId: undefined },
    { outputSchemaVersion: undefined },
    { candidateOnly: false },
    { contentMutationRequested: true },
  ]) {
    const rejected = planModelRoute(input(override));
    assert.equal(rejected.primary.kind, "coordinator");
    assert.ok(rejected.reasonCodes.includes("MECHANICAL_TASK_CONTRACT_REQUIRED"));
  }
});

test("未知外部结果强制只读探测，不能自动再次写入", () => {
  const plan = planModelRoute(input({
    phase: "browser_publish_once",
    requiresBrowser: true,
    externalOutcome: "ambiguous",
    frozenInput: true,
  }));
  assert.equal(plan.state, "probe_required");
  assert.equal(plan.effectivePhase, "browser_probe");
  assert.equal(plan.constraints.externalWriteAllowed, false);
  assert.equal(plan.constraints.automaticRetryAllowed, false);
  assert.equal(plan.constraints.probeBeforeRetry, true);
  assert.deepEqual(plan.reasonCodes, ["AMBIGUOUS_RESULT_PROBE_FIRST"]);
});

test("公开发布 planner 永远不能凭调用者自述 capability 变为 ready；完成 Claim 只交协调者", () => {
  const claimed = planModelRoute(input({
    phase: "browser_publish_once",
    requiresBrowser: true,
    frozenInput: true,
    publishCapability: {
      state: "valid", humanApproved: true, action: "publish", singleUse: true, maxClicks: 1,
      boundFields: ["run_id", "platform", "release_id", "artifact_sha256", "target_account", "action", "expires_at", "nonce"],
    },
  }));
  assert.equal(claimed.state, "needs_human");
  assert.equal(claimed.primary.kind, "human");
  assert.equal(claimed.constraints.externalWriteAllowed, false);
  assert.equal(claimed.constraints.maxPublishClicks, 0);
  assert.ok(claimed.reasonCodes.includes("PUBLISH_SERVER_AUTHORITY_REQUIRED"));
  assert.ok(claimed.reasonCodes.includes("PUBLISH_OPERATOR_HOST_ROUTE_UNVERIFIED"));
  assert.ok(claimed.prerequisites.some((item) => item.includes("Release Control V2")));
  assert.ok(claimed.prerequisites.some((item) => item.includes("宿主路由尚未验收")));
  assert.equal(claimed.constraints.completionClaimAllowed, false);

  const completion = planModelRoute(input({ phase: "completion_claim", requiresBrowser: false }));
  assert.equal(completion.primary.kind, "coordinator");
  assert.equal(completion.constraints.completionClaimAllowed, true);
});
