import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const contract = await readFile(new URL("../governance/interface-copy-contract.md", import.meta.url), "utf8");
const exporter = await readFile(new URL("../scripts/export-interface-copy.mjs", import.meta.url), "utf8");
const workbench = await readFile(new URL("../app/WorkbenchShell.tsx", import.meta.url), "utf8");
const agentConsole = await readFile(new URL("../app/AgentConsole.tsx", import.meta.url), "utf8");
const videoFlow = await readFile(new URL("../app/VideoReleaseFlow.tsx", import.meta.url), "utf8");
const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");

test("界面表达合同冻结机器状态、展示名称与对外 Claim 的分层映射", () => {
  for (const value of [
    "submission_accepted",
    "backend_verified",
    "destination_record_verified",
    "public_verified",
    "public_access_verified",
    "outcome_verified",
  ]) assert.match(contract, new RegExp(`\\b${value}\\b`));
  assert.match(contract, /前一行不能推出后一行/);
  assert.match(contract, /票据被消费[\s\S]*不能自动提升这些 Claim/);
  assert.match(contract, /Build（构建工件）/);
  assert.match(contract, /Release（发行记录）/);
});

test("全站语料导出器覆盖 TS、TSX、JSX 与模板字符串，并输出可扫描纯文本", () => {
  assert.match(exporter, /ts\|tsx\|mjs/);
  assert.match(exporter, /ts\.isJsxText/);
  assert.match(exporter, /ts\.isTemplateExpression/);
  assert.match(exporter, /interface-copy-audit\.txt/);
  assert.match(exporter, /uniqueRecords/);
});

test("已知界面文案事故不再出现", () => {
  assert.doesNotMatch(workbench, /建建设任务/);
  assert.doesNotMatch(workbench, /这里不是日志仓库/);
  assert.doesNotMatch(agentConsole, /Agent 任务已发布/);
  assert.doesNotMatch(videoFlow, /视频发布流已闭环/);
});

test("证据闭环文案仍保留效果验证边界", () => {
  assert.match(videoFlow, /发布证据链已闭环/);
  assert.match(videoFlow, /效果/);
});

test("页面标题交给根模板补上文脉名称，不重复显示品牌", () => {
  assert.match(page, /title: "本地文章工程台"/);
  assert.doesNotMatch(page, /title: "文脉 · 本地文章工程台"/);
});
