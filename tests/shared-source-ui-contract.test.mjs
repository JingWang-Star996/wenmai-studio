import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
test("面板只请求 v1，并明确没有正文与 Library 接通", () => {
  const panel = fs.readFileSync(new URL("../app/SharedSourcePanel.tsx", import.meta.url), "utf8");
  assert.match(panel, /\/api\/shared-source\/v1\?view=manifest/); assert.doesNotMatch(panel, /\/v2|container/i); assert.match(panel, /没有导入、正文读取、MCP 工具或已配置的 Library 连接/);
});
