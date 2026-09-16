import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const read = (relative) => readFile(path.join(root, relative), "utf8");

test("高风险 decision 必须把 v3 snapshot actionId 传入认证门禁", async () => {
  const route = await read("app/api/agent/v1/route.ts");
  for (const action of ["decide_approval", "decide_graph_proposal"]) {
    assert.match(route, new RegExp(`agentActionAuthorization\\("agent-v1", action\\)[\\s\\S]{0,500}agentActionId: decisionAuthorization\\?\\.actionId`, "u"), action);
  }
});

test("v3 特权签发在目录可签发校验后、任何 D1 写入前执行 scope 组合门禁", async () => {
  const route = await read("app/api/agent/v1/route.ts");
  assert.match(route, /validatePermissionScopeCombination/u);
  const issuableValidation = route.indexOf('if (rejectedScopes.length) throw new AgentApiError("INVALID_SCOPE"');
  const combinationValidation = route.indexOf("const scopeCombination = validatePermissionScopeCombination(requestedScopes)");
  const firstD1Write = route.indexOf("const id = `agent-client-${crypto.randomUUID()}`");
  assert.ok(issuableValidation >= 0 && combinationValidation > issuableValidation && firstD1Write > combinationValidation);
  assert.match(route, /"PERMISSION_SCOPE_COMBINATION_CONFLICT"[\s\S]{0,300}\{ conflicts: scopeCombination\.conflicts, message: scopeCombination\.message \}/u);
});

test("Package Patch 按共同 authority lineage 分离创建、决定和应用，并对旧决定 fail closed", async () => {
  const route = await read("app/api/project-package/v1/route.ts");
  assert.match(route, /import \{ sameAgentAuthorityLineage \} from "\.\.\/\.\.\/\.\.\/site-full-control-auth"/u);
  assert.match(route, /sameAgentAuthorityLineage\(db, String\(current\.created_by_id\), principal\.clientId\)[\s\S]{0,180}AGENT_PATCH_SELF_DECISION_FORBIDDEN/u);
  assert.match(route, /decided_by_kind = \?, decided_by_id = \?/u);
  assert.match(route, /AGENT_PATCH_SELF_APPLY_FORBIDDEN/u);
  assert.match(route, /AGENT_PATCH_DECISION_BINDING_MISSING/u);
  assert.match(route, /sameAgentAuthorityLineage\(db, String\(proposal\.created_by_id\), principal\.clientId\)/u);
  assert.match(route, /sameAgentAuthorityLineage\(db, String\(proposal\.decided_by_id\), principal\.clientId\)/u);
  assert.match(route, /decidedByKind = principal\.kind === "agent" \? "agent" : "owner"/u);
  assert.match(route, /AGENT_PATCH_CREATOR_BINDING_MISSING/u);
});

test("决定者绑定有独立迁移，旧行仅限制 Agent apply 而未封锁 owner 接管", async () => {
  const migration = await read("drizzle/0022_package_patch_decision_actor.sql");
  assert.match(migration, /ADD COLUMN `decided_by_kind` text/u);
  assert.match(migration, /ADD COLUMN `decided_by_id` text/u);
  const route = await read("app/api/project-package/v1/route.ts");
  const guard = route.indexOf('if (principal.kind === "agent") {\n    if (proposal.created_by_kind === "agent")');
  assert.ok(guard >= 0, "only Agent apply path may enforce the legacy decision binding");
});
