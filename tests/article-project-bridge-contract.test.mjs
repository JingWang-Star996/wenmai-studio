import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const projectRoute = readFileSync(new URL("../app/api/project-package/v1/route.ts", import.meta.url), "utf8");
const agentRoute = readFileSync(new URL("../app/api/agent/v1/route.ts", import.meta.url), "utf8");
const workspaceRoute = readFileSync(new URL("../app/api/workspace/route.ts", import.meta.url), "utf8");
const schema = readFileSync(new URL("../db/schema.ts", import.meta.url), "utf8");
const migration = readFileSync(new URL("../drizzle/0009_narrow_edwin_jarvis.sql", import.meta.url), "utf8");
const snapshot = JSON.parse(readFileSync(new URL("../drizzle/meta/0009_snapshot.json", import.meta.url), "utf8"));
const journal = JSON.parse(readFileSync(new URL("../drizzle/meta/_journal.json", import.meta.url), "utf8"));

function functionBody(source, name) {
  const asyncStart = source.indexOf(`async function ${name}`);
  const syncStart = source.indexOf(`function ${name}`);
  const start = asyncStart >= 0 ? asyncStart : syncStart;
  assert.notEqual(start, -1, `缺少 ${name}`);
  const candidates = [
    source.indexOf("\nasync function ", start + 15),
    source.indexOf("\nfunction ", start + 15),
    source.indexOf("\nexport async function ", start + 15),
  ].filter((position) => position >= 0);
  return source.slice(start, candidates.length ? Math.min(...candidates) : source.length);
}

test("0009 只新增 Composition materialization，并以 additive columns 建立单主分支桥", () => {
  assert.deepEqual([...migration.matchAll(/CREATE TABLE `([^`]+)`/g)].map((match) => match[1]), ["package_composition_materializations"]);
  for (const column of [
    "article_project_packages` ADD `primary_branch_id",
    "package_working_copies` ADD `branch_id",
    "package_working_copies` ADD `base_revision_id",
    "package_patch_proposals` ADD `branch_id",
    "package_patch_proposals` ADD `base_revision_id",
    "package_patch_proposals` ADD `base_package_lock_version",
    "agent_tasks` ADD `package_id",
    "agent_context_snapshots` ADD `module_graph_sha256",
    "agent_context_snapshots` ADD `diagnosis_summary_sha256",
  ]) assert.ok(migration.includes(column), `0009 缺少 ${column}`);
  assert.doesNotMatch(migration, /\bDROP\s+TABLE\b/i);
  assert.match(migration, /CREATE UNIQUE INDEX `idx_package_materializations_revision`/);
});

test("0009 journal 与 snapshot 精确登记且 0008 保持历史基线", () => {
  const entry = journal.entries.find((candidate) => candidate.idx === 9);
  assert.equal(entry?.tag, "0009_narrow_edwin_jarvis");
  assert.equal(snapshot.version, "6");
  assert.equal(journal.entries.find((candidate) => candidate.idx === 8)?.tag, "0008_bent_silver_samurai");
});

test("schema 与两个 runtime bootstrap 覆盖桥和 Agent 冻结字段", () => {
  for (const token of [
    "package_composition_materializations", "primary_branch_id", "base_package_lock_version",
    "package_document_sha256", "package_lock_version", "branch_head_revision_id",
    "module_graph_sha256", "diagnosis_summary_sha256",
  ]) assert.ok(schema.includes(token), `schema 缺少 ${token}`);
  assert.match(projectRoute, /CREATE TABLE IF NOT EXISTS package_composition_materializations/);
  assert.match(projectRoute, /addColumnIfMissing\(db, "article_project_packages", "primary_branch_id"/);
  assert.match(agentRoute, /addColumnIfMissing\(db, "agent_context_snapshots", "module_graph_sha256"/);
  assert.match(agentRoute, /addColumnIfMissing\(db, "package_patch_proposals", "base_package_lock_version"/);
});

test("0010 在保留 0009 primary 镜像兼容性的同时启用真实多 ArticleBranch 状态", () => {
  assert.match(projectRoute, /packageBranchMode: "article-branch-qualified"/);
  assert.match(projectRoute, /multiBranchPackageState: true/);
  assert.match(projectRoute, /articleBranchIsSoleBranchIdentity: true/);
  assert.match(projectRoute, /package_branch_states \+ package_branch_working_copies \+ package_branch_composition_commits/);
  assert.match(projectRoute, /attach_branch/);
});

test("ensure_from_revision 绑定 revision 所属 clean active branch，create_from_text 支持显式 branch CAS", () => {
  const ensure = functionBody(projectRoute, "ensureFromRevision");
  const create = functionBody(projectRoute, "createFromText");
  const binding = functionBody(projectRoute, "cleanBranchBinding");
  assert.match(ensure, /revision\.branch_id/);
  assert.match(ensure, /REVISION_BRANCH_MISMATCH/);
  assert.match(ensure, /cleanBranchBinding/);
  assert.match(create, /expectedBranchHeadRevisionId/);
  assert.match(create, /expectedBranchHeadBodySha256/);
  assert.match(binding, /copy\.dirty AS working_dirty/);
  assert.match(binding, /DIRTY_ARTICLE_WORKING_COPY/);
});

test("Package commit CAS 目标 branch state、ArticleBranch head 与两份 working copy", () => {
  const body = functionBody(projectRoute, "commitWorkingPackage");
  assert.match(body, /UPDATE package_branch_states/);
  assert.match(body, /UPDATE article_project_packages/);
  assert.match(body, /UPDATE article_branches SET head_revision_id/);
  assert.match(body, /INSERT INTO article_revisions/);
  assert.match(body, /UPDATE branch_working_copies\s+SET base_revision_id/);
  assert.match(body, /UPDATE package_branch_working_copies/);
  assert.match(body, /INSERT INTO package_composition_materializations/);
  assert.match(body, /INSERT INTO package_branch_composition_commits/);
  assert.match(body, /wenmai-0010-commit-incomplete/);
});

test("人工 apply Patch 走同一双 CAS 与物化证据链", () => {
  const body = functionBody(projectRoute, "applyPatchProposal");
  assert.match(body, /status = 'approved'/);
  assert.match(body, /UPDATE article_branches SET head_revision_id/);
  assert.match(body, /INSERT INTO article_revisions/);
  assert.match(body, /INSERT INTO package_composition_materializations/);
  assert.match(body, /INSERT INTO package_branch_composition_commits/);
  assert.match(body, /wenmai-0010-patch-apply-incomplete/);
});

test("legacy Workspace 写在预检和事务内都阻断所有已接入 Package branch", () => {
  assert.match(workspaceRoute, /assertLegacyWorkspaceBranchesWritable/);
  assert.match(workspaceRoute, /ArticleProject Package/);
  assert.match(workspaceRoute, /NOT EXISTS \(SELECT 1 FROM package_branch_states/);
  for (const name of ["saveWorkingCopy", "commitRevision", "prepareMerge", "saveMergeResolution", "mergeRevision"]) {
    assert.match(functionBody(workspaceRoute, name), /assertLegacyWorkspaceBranchesWritable/);
  }
});

test("Agent manifest 暴露 package-patch scope/action 及 candidate-only 边界", () => {
  assert.match(agentRoute, /"package\.patch\.propose"/);
  assert.match(agentRoute, /"package-patch"/);
  assert.match(agentRoute, /propose_package_patch: "package\.patch\.propose"/);
  assert.match(agentRoute, /packagePatchContract/);
  assert.match(agentRoute, /no Composition\/Revision\/head advance/);
});

test("Agent context 冻结 Package、Composition、模块图和显式诊断 not_run", () => {
  const body = functionBody(agentRoute, "loadFrozenPackageSnapshot");
  assert.match(body, /package_composition_materializations/);
  assert.match(body, /package_composition_nodes/);
  assert.match(body, /package_module_revision_refs/);
  assert.match(body, /moduleGraphSha256/);
  assert.match(body, /status: "not_run"/);
  assert.match(body, /diagnosisSummarySha256/);
  assert.match(body, /PACKAGE_CONTEXT_TOO_LARGE/);
});

test("claim 会复核冻结 Package 分支摘要并在竞争 SQL 中重检 branch head", () => {
  const body = functionBody(agentRoute, "claimTask");
  assert.match(body, /assertFrozenPackageContextCurrent/);
  assert.match(body, /state\.lock_version = \?/);
  assert.match(body, /branch\.head_revision_id = state\.head_revision_id/);
  assert.match(body, /package_copy\.dirty = 0/);
  assert.match(body, /branch_copy\.dirty = 0/);
});

test("Agent propose_package_patch 只插 candidate，不生成或推进正式对象", () => {
  const body = functionBody(agentRoute, "proposePackagePatch");
  assert.match(body, /INSERT INTO package_patch_proposals/);
  assert.match(body, /'candidate'/);
  assert.match(body, /DIAGNOSTIC_ISSUE_NOT_FROZEN/);
  assert.match(body, /humanReviewRequired: true/);
  assert.doesNotMatch(body, /UPDATE article_project_packages/);
  assert.doesNotMatch(body, /INSERT INTO package_compositions/);
  assert.doesNotMatch(body, /UPDATE article_branches SET head_revision_id/);
  assert.doesNotMatch(body, /INSERT INTO article_revisions/);
});

test("Agent 不能用正文 propose_revision 绕开 Package 管理边界", () => {
  const body = functionBody(agentRoute, "proposeRevision");
  assert.match(body, /primary_branch_id = \?/);
  assert.match(body, /PACKAGE_BRANCH_MANAGED/);
  assert.match(body, /只能提交候选 Package Patch/);
});

test("Package Patch 响应逐层否认 apply、Composition、Package main、Branch 与 Revision 推进", () => {
  const body = functionBody(agentRoute, "proposePackagePatch");
  for (const boundary of [
    "candidateOnly: true", "patchApplied: false", "compositionCreated: false",
    "packageMainAdvanced: false", "articleBranchAdvanced: false", "revisionCreated: false",
  ]) assert.ok(body.includes(boundary), `缺少边界 ${boundary}`);
});
