import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const panel = await readFile(new URL("../app/ModelRoutingPanel.tsx", import.meta.url), "utf8");
const hub = await readFile(new URL("../app/DistributionHub.tsx", import.meta.url), "utf8");

test("路由面板只读取同源脱敏目录，不接受上游配置", () => {
  assert.match(panel, /managementFetch\("\/api\/model-routing"/);
  assert.match(panel, /openai.*ollama.*deepseek.*qwen/s);
  assert.match(panel, /不接收密钥、上游 URL 或发布授权/);
  assert.match(panel, /配置有效，连通性未验证/);
  assert.match(panel, /setCatalog\(null\)/);
  assert.match(panel, /先前状态已过期/);
  assert.doesNotMatch(panel, /baseUrl|apiKey|OLLAMA_BASE_URL/);
  assert.doesNotMatch(panel, /input[^\n]*API_KEY|textarea[^\n]*endpoint|fetch\([^\n]*provider/i);
});

test("DistributionHub 提供只读模型路由页签", () => {
  assert.match(hub, /ModelRoutingPanel/);
  assert.match(hub, /setPanel\("routing"\)/);
  assert.match(hub, /panel === "routing" && <ModelRoutingPanel/);
});
