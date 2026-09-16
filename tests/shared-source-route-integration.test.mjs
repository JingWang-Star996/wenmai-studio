import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
const route = fs.readFileSync(new URL("../app/api/shared-source/v1/route.ts", import.meta.url), "utf8");
const model = fs.readFileSync(new URL("../app/shared-source-read-model.ts", import.meta.url), "utf8");
test("v1 只读路由保留授权、分页和无敏感投影", () => {
  assert.match(route, /requireManagementSession/); assert.match(route, /cache-control.*no-store/); assert.match(model, /sharedSourceAgentProjection/); assert.match(model, /scopeFiltered: true/);
  for (const forbidden of ["container", "remoteState", "content_ref", "externalId"]) assert.doesNotMatch(model, new RegExp(forbidden, "i"));
});
