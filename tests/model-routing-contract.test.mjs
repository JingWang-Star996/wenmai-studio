import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const route = readFileSync(new URL("../app/api/model-routing/route.ts", import.meta.url), "utf8");
const routing = readFileSync(new URL("../app/model-routing.ts", import.meta.url), "utf8");
const panel = readFileSync(new URL("../app/ModelRoutingPanel.tsx", import.meta.url), "utf8");

test("路由 API 只生成计划：不接收秘密、上游地址或调用模型的字段", () => {
  const fields = route.match(/const ALLOWED_PLAN_FIELDS = new Set\(\[([\s\S]*?)\]\);/)?.[1] ?? "";
  for (const forbidden of ["publishCapability", "ticket", "nonce", "capability", "receipt", "lease", "apiKey", "baseUrl", "upstreamUrl", "providerReadiness"]) {
    assert.doesNotMatch(fields, new RegExp(`['"]${forbidden}['"]`));
  }
  assert.match(route, /api_plans_only_and_never_invokes_models/);
  assert.match(route, /upstream_url_and_key_material_are_never_accepted_or_returned/);
  assert.doesNotMatch(route, /requestModelGatewayJson\s*\(/);
  assert.match(route, /BODY_TOO_LARGE/);
  assert.match(route, /FIELD_UNSUPPORTED/);
});

test("API 将不可用、合同异常和重试边界结构化返回", () => {
  assert.match(route, /ready: status\?\.ready === true/);
  assert.match(route, /automatic_external_retries_are_disabled/);
  assert.match(route, /catch \(error\)[\s\S]*?error: \{ code: apiError\.code, message: apiError\.message \}/);
  assert.match(routing, /externalOutcome === "ambiguous"[\s\S]*?effectivePhase: "browser_probe"/);
  assert.match(routing, /automaticRetryAllowed: false/);
  assert.match(routing, /MECHANICAL_TASK_CONTRACT_REQUIRED[\s\S]*?64 位输入摘要[\s\S]*?candidateOnly=true/);
  assert.match(route, /"mechanicalTask",\s*[\s\S]*?"candidateOnly"/);
  assert.match(route, /intermediate \? "strict_schema_transform"/);
});

test("控制面目录如实显示 Terra browser fallback 与 Luna fast worker，且不把 Spark 放进就绪或执行候选", () => {
  assert.match(route, /wenmai_fast_worker:[\s\S]*?preferredModel: "gpt-5\.6-luna"[\s\S]*?effectiveModel: "gpt-5\.6-luna"[\s\S]*?circuitState: "not_applicable"/);
  assert.match(route, /wenmai_publish_operator:[\s\S]*?preferredModel: "gpt-5\.3-codex-spark"[\s\S]*?effectiveModel: "gpt-5\.6-terra"[\s\S]*?model: "gpt-5\.6-terra"[\s\S]*?circuitState: "open"[\s\S]*?fallbackReason: "spark_runtime_enforcement_unverified"[\s\S]*?fallbackVerification: "not_verified"/);
  assert.match(route, /boolEnv\("WENMAI_PUBLISH_OPERATOR_READY"\) && boolEnv\("WENMAI_PUBLISH_OPERATOR_HOST_ROUTE_VERIFIED"\)/);
  assert.match(route, /spark_runtime_is_not_probed_or_invoked_by_this_api/);
  assert.doesNotMatch(route, /ready:\s*[^\n]*gpt-5\.3-codex-spark/);
  assert.match(panel, /effectiveModel\?: string/);
  assert.match(panel, /circuitState\?: "open" \| "disabled" \| "not_applicable"/);
  assert.match(panel, /有效模型：\{agent\.effectiveModel \|\| agent\.model\}/);
  assert.match(panel, /熔断：\{agent\.circuitState \|\| "未声明"\}/);
  assert.match(panel, /fallback：\$\{agent\.fallbackReason\}/);
  assert.match(panel, /验证：\$\{agent\.fallbackVerification\}/);
});

test("浏览器执行者没有改写内容、权限解释、完成或跨层公开 Claim 的权限", () => {
  assert.match(route, /values\.add\("content_rewrite"\)/);
  assert.match(route, /values\.add\("completion_claim"\)/);
  assert.match(route, /values\.add\("permission_interpretation"\)/);
  assert.match(route, /values\.add\("public_verified_without_receipt"\)/);
  assert.match(route, /publish_requires_human_single_use_capability/);
  assert.match(route, /publish_planner_requires_server_authoritative_consumption_and_unique_execution_lease/);
  assert.match(routing, /reasonCodes: \["PUBLISH_SERVER_AUTHORITY_REQUIRED", "PUBLISH_OPERATOR_HOST_ROUTE_UNVERIFIED"\]/);
  assert.match(routing, /Release Control V2 的服务端权威能力消费与唯一 click lease 控制面必须持续通过当前批次校验/);
  assert.match(routing, /Publish Operator 的宿主路由尚未验收[\s\S]*?WENMAI_PUBLISH_OPERATOR_HOST_ROUTE_VERIFIED 必须为 false/);
  assert.doesNotMatch(routing, /服务端权威能力票据消费 CAS 尚未实现/);
  assert.doesNotMatch(routing, /服务端唯一 Execution lease 尚未实现/);
  assert.doesNotMatch(routing, /externalWriteAllowed: true/);
  assert.match(routing, /contentRewriteAllowed: false/);
});
