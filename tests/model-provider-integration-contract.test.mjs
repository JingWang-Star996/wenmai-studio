import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const vite = await readFile(new URL("../vite.config.ts", import.meta.url), "utf8");
const launcher = await readFile(new URL("../scripts/start-wenmai.ps1", import.meta.url), "utf8");
const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");

test("本地开发 Worker 只从进程环境接收 OpenAI 与 Ollama 配置", () => {
  for (const name of ["OPENAI_API_KEY", "OPENAI_FAST_MODEL", "OLLAMA_BASE_URL", "OLLAMA_MODEL", "OLLAMA_API_KEY"]) {
    assert.match(vite, new RegExp(`process\\.env\\.${name}`));
    assert.match(launcher, new RegExp(`"${name}"`));
    assert.match(readme, new RegExp(`\\$env:${name}`));
  }
  assert.match(vite, /command === "serve"/);
  assert.match(launcher, /不会显示其值/);
});

test("导入推荐默认本地规则，扩展 provider 仅在服务端 feature flag 下接受显式选择", async () => {
  const route = await readFile(new URL("../app/api/improvement/v1/route.ts", import.meta.url), "utf8");
  const packageRoute = await readFile(new URL("../app/api/project-package/v1/route.ts", import.meta.url), "utf8");
  assert.match(route, /META_IMPROVEMENT_EXTENDED_PROVIDERS_ENABLED/u);
  assert.match(route, /META_IMPROVEMENT_EXTENDED_PROVIDER_DISABLED/u);
  assert.match(route, /OPENAI_FAST_MODEL/u);
  assert.match(route, /OLLAMA_BASE_URL/u);
  assert.match(packageRoute, /selectedProvider === "local_rules"/u);
  assert.match(packageRoute, /INVALID_IMPORT_RECOMMENDATION_PROVIDER/u);
  assert.match(packageRoute, /selected === "openai" \|\| selected === "ollama"\) && !extendedProvidersEnabled\(\)/u);
  assert.match(packageRoute, /META_IMPROVEMENT_EXTENDED_PROVIDER_DISABLED/u);
  assert.match(packageRoute, /routeDecisionSha256/u);
  assert.doesNotMatch(packageRoute, /statuses\.find\(\(status\) => status\.ready\)/u);
});
