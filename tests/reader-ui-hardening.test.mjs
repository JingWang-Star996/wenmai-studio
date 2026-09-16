import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const shell = readFileSync(new URL("../app/WorkbenchShell.tsx", import.meta.url), "utf8");
const agents = readFileSync(new URL("../app/AgentConsole.tsx", import.meta.url), "utf8");
const dag = readFileSync(new URL("../app/VersionDag.tsx", import.meta.url), "utf8");
const review = readFileSync(new URL("../app/HumanReviewPanel.tsx", import.meta.url), "utf8");

test("资料库分页中止旧请求，以 epoch 防止旧筛选响应覆盖新结果", () => {
  assert.match(shell, /libraryAbortRef\.current\?\.abort\(\)/);
  assert.match(shell, /const requestEpoch = \+\+libraryRequestEpochRef\.current/);
  assert.match(shell, /signal: controller\.signal/);
  assert.match(shell, /requestEpoch !== libraryRequestEpochRef\.current \|\| controller\.signal\.aborted/);
});

test("资料库 slim DTO 严格按 24 项替页，保留 cursor 历史和明确页容量", () => {
  assert.match(shell, /limit: "24"/);
  assert.match(shell, /type LibrarySlimItem = \{/);
  assert.match(shell, /type LibrarySlimResponse = \{/);
  assert.match(shell, /payload\.data\.items\.slice\(0, 24\)/);
  assert.doesNotMatch(shell, /slice\(-72\)/);
  assert.match(shell, /本页最多24项/);
  assert.match(shell, /libraryCursorHistory/);
  assert.match(shell, /下一页（替换当前 24 项）/);
  assert.match(shell, /回第一页/);
});

test("远端 slim item 不读取 versions，打开工程必须通过本地身份门禁", () => {
  const slimDto = shell.slice(shell.indexOf("type LibrarySlimItem"), shell.indexOf("type LibrarySlimResponse"));
  assert.doesNotMatch(slimDto, /versions/);
  assert.doesNotMatch(shell, /article\.summary \|\| article\.versions/);
  assert.match(shell, /trustedLocalProjectArticleIds\.has\(article\.id\)/);
  assert.match(shell, /只读语料，尚未建立本地文章工程/);
  assert.match(shell, /disabled=\{!canOpenProject\}/);
});

test("Agent 仅为非终态任务在可见页面安排退避轮询", () => {
  assert.match(agents, /const backoffMs = \[3000, 6000, 12000, 24000, 60000\]/);
  assert.match(agents, /\["succeeded", "failed", "cancelled"\]\.includes\(task\.state\)/);
  assert.match(agents, /document\.visibilityState === "visible"/);
  assert.match(agents, /tasksRef\.current\.some\(\(task\) => !isTerminal\(task\)\)/);
  assert.match(agents, /window\.clearTimeout\(timer\)/);
  assert.match(agents, /const \[pollGeneration, setPollGeneration\] = useState\(0\)/);
  assert.match(agents, /setPollGeneration\(\(generation\) => generation \+ 1\)/);
  assert.match(agents, /\[loadDetail, loadTasks, pollGeneration\]/);
  assert.match(agents, /selectedTaskIdRef\.current !== taskId/);
});

test("DAG 截断为 40 节点且画布宽度由展示节点的最大 x 决定", () => {
  assert.match(dag, /prioritizedNodes\.slice\(0, 40\)/);
  assert.match(dag, /const maxDisplayedX = Math\.max\(178, \.\.\.displayedNodes\.map\(\(node\) => node\.x\)\)/);
  assert.match(dag, /const width = Math\.max\(920, maxDisplayedX \+ 110\)/);
  assert.match(dag, /已截断 \{hiddenCount\} 个节点；展开全部/);
});

test("人工审阅以 immutable article/package/branch/revision/hash 绑定，并拒绝脏工作副本", () => {
  assert.match(shell, /activeBranch\.status !== "active"/);
  assert.match(shell, /activeBranch\.articleId !== selectedArticle\.id/);
  assert.match(shell, /revision\.branchId !== activeBranch\.id/);
  assert.match(shell, /const reviewTarget = useMemo<ReviewTarget>/);
  assert.match(shell, /const articleRevisions = useMemo/);
  assert.match(shell, /identity\.packageStatus !== "active"/);
  assert.match(shell, /<HumanReviewPanel target=\{reviewTarget\}/);
  const target = shell.slice(shell.indexOf("const reviewTarget"), shell.indexOf("const saveWorkingCopy"));
  assert.doesNotMatch(target, /identity\.primaryBranchId|identity\.headRevisionId|identity\.headBodySha256/);
  assert.match(shell, /dirtyWorkingCopy: Boolean\(activeCopy\?\.dirty\)/);
  for (const field of ["articleId", "packageId", "branchId", "revisionId", "bodySha256", "dirtyWorkingCopy"]) assert.match(review, new RegExp(`${field}: (string|boolean)`));
  assert.match(review, /工作副本仍有未保存改动/);
});

test("审阅请求只保留四视图、人工标注和候选批准", () => {
  assert.match(review, /Promise\.all\(\[/);
  for (const view of ["requirements", "annotations", "rule-candidates", "baseline-revisions"]) assert.match(review, new RegExp(view));
  for (const action of ["create_human_annotation", "approve_rule_candidate"]) assert.match(review, new RegExp(action));
  assert.doesNotMatch(review, /review-queue|gate-attestations|record_gate_attestation|snooze/u);
});
