import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

async function source(file) {
  return await readFile(path.join(root, file), "utf8");
}

test("工作台提供 ProjectGroup 人类后备控制面", async () => {
  const [shell, types, panel] = await Promise.all([
    source("app/WorkbenchShell.tsx"),
    source("app/workbench-types.ts"),
    source("app/ProjectGroupPanel.tsx"),
  ]);

  assert.match(types, /WorkspaceView[\s\S]*"groups"/u);
  assert.match(shell, /id:\s*"groups",\s*label:\s*"项目组图"/u);
  assert.match(shell, /view === "groups"\s*&&\s*<ProjectGroupPanel/u);
  assert.match(panel, /view:\s*filterMode === "article" \? "by-article" : "list"/u);
  assert.match(panel, /new URLSearchParams\(\{ view: "detail", groupId \}\)/u);
  assert.doesNotMatch(panel, /headers:\s*\{[^}]*authorization/iu);
});

test("七种写动作绑定稳定 commandId、锁版本与服务端读回", async () => {
  const panel = await source("app/ProjectGroupPanel.tsx");
  const actions = [
    "create_group",
    "update_group",
    "archive_group",
    "add_member",
    "remove_member",
    "add_edge",
    "remove_edge",
  ];

  for (const action of actions) assert.match(panel, new RegExp(`mutate\\("${action}"`, "u"));
  assert.equal((panel.match(/crypto\.randomUUID\(\)/gu) ?? []).length, 1);
  assert.match(panel, /const requestBody = JSON\.stringify\(\{ action, commandId, payload \}\)/u);
  assert.ok((panel.match(/expectedLockVersion:/gu) ?? []).length >= actions.length);
  assert.match(panel, /const confirmed = await loadDetail\(groupId\)/u);
  assert.match(panel, /写入已由服务器读回确认/u);
});

test("冲突与结果不明会先停止写入并要求只读核对", async () => {
  const panel = await source("app/ProjectGroupPanel.tsx");

  assert.match(panel, /response\.status === 409[\s\S]*await loadGroups\(\)[\s\S]*await loadDetail/u);
  assert.match(panel, /setUncertainCommand\(\{ commandId, action, groupId \}\)/u);
  assert.match(panel, /已冻结继续写入/u);
  assert.match(panel, /busyAction \|\| uncertainCommand \|\| !active \|\| detail\?\.integrityStatus !== "valid"/u);
  assert.match(panel, /只读核对服务器/u);
});

test("界面暴露完整性、版本、危险确认与 Agent 权限边界", async () => {
  const panel = await source("app/ProjectGroupPanel.tsx");

  assert.match(panel, /aria-live="polite"/u);
  assert.match(panel, /role="alert"/u);
  assert.match(panel, /storedTopologySha256/u);
  assert.match(panel, /recomputedTopologySha256/u);
  assert.match(panel, /拓扑有效/u);
  assert.match(panel, /我确认归档后该组将只读/u);
  assert.match(panel, /Agent\/MCP 仍是只读/u);
  assert.match(panel, /不会自动改正文/u);
});
