import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const projectRoute = readFileSync(new URL("../app/api/project-package/v1/route.ts", import.meta.url), "utf8");
const workspaceRoute = readFileSync(new URL("../app/api/workspace/route.ts", import.meta.url), "utf8");
const schema = readFileSync(new URL("../db/schema.ts", import.meta.url), "utf8");
const migration = readFileSync(new URL("../drizzle/0010_wide_silver_sable.sql", import.meta.url), "utf8");
const snapshot = JSON.parse(readFileSync(new URL("../drizzle/meta/0010_snapshot.json", import.meta.url), "utf8"));
const journal = JSON.parse(readFileSync(new URL("../drizzle/meta/_journal.json", import.meta.url), "utf8"));

const branchTables = [
  "package_branch_states",
  "package_branch_working_copies",
  "package_branch_composition_commits",
  "package_branch_migration_audits",
];

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

function viewBlock(name) {
  const startToken = `if (view === "${name}")`;
  const start = projectRoute.indexOf(startToken);
  assert.notEqual(start, -1, `缺少 GET view=${name}`);
  const next = projectRoute.indexOf("\n  if (view === ", start + startToken.length);
  return projectRoute.slice(start, next >= 0 ? next : projectRoute.indexOf("\n  throw new ProjectPackageApiError", start));
}

function assertContainsAll(source, tokens, label) {
  for (const token of tokens) assert.ok(source.includes(token), `${label} 缺少 ${token}`);
}

function snapshotColumns(tableName) {
  const table = snapshot.tables[tableName];
  assert.ok(table, `0010 snapshot 缺少 ${tableName}`);
  return new Set(Object.keys(table.columns));
}

test("0010 schema 与 snapshot 建立四张权威分支表", () => {
  const expectedColumns = {
    package_branch_states: [
      "package_id", "branch_id", "head_composition_id", "head_composition_sha256",
      "head_revision_id", "status", "lock_version", "created_at", "updated_at",
    ],
    package_branch_working_copies: [
      "package_id", "branch_id", "base_composition_id", "base_revision_id",
      "document_json", "document_sha256", "dirty", "lock_version", "updated_at",
    ],
    package_branch_composition_commits: [
      "id", "package_id", "branch_id", "parent_composition_id", "composition_id",
      "composition_sha256", "previous_revision_id", "article_revision_id", "source_kind",
      "source_patch_id", "created_by_kind", "created_at",
    ],
    package_branch_migration_audits: [
      "package_id", "state", "reason_code", "detail_json", "source_schema_version",
      "created_at", "updated_at",
    ],
  };
  for (const table of branchTables) {
    assert.match(schema, new RegExp(`["']${table}["']`), `schema 缺少 ${table}`);
    const columns = snapshotColumns(table);
    for (const column of expectedColumns[table]) assert.ok(columns.has(column), `${table} 缺少 ${column}`);
  }
  assert.ok(snapshotColumns("article_project_packages").has("branch_model_version"));
  assert.match(schema, /branchModelVersion:\s*integer\("branch_model_version"\)/);
});

test("0010 派生对象冻结 branch、revision 与 branch-lock 溯源列", () => {
  const expected = {
    package_slices: ["branch_id", "base_revision_id", "base_branch_lock_version"],
    package_patch_proposals: ["branch_id", "base_revision_id", "base_branch_lock_version"],
    package_diagnosis_runs: ["branch_id", "base_revision_id", "base_branch_lock_version"],
    package_diagnostic_issues: ["branch_id"],
    package_import_runs: ["branch_id", "base_revision_id", "base_branch_lock_version"],
    package_export_runs: ["branch_id", "base_revision_id", "base_branch_lock_version"],
    agent_tasks: ["base_revision_id", "base_branch_lock_version"],
    agent_context_snapshots: ["branch_state_lock_version"],
  };
  for (const [table, requiredColumns] of Object.entries(expected)) {
    const columns = snapshotColumns(table);
    for (const column of requiredColumns) assert.ok(columns.has(column), `${table} 缺少 ${column}`);
  }
});

test("0010 migration 与 journal 精确登记四表和 additive 分支列", () => {
  const created = [...migration.matchAll(/CREATE TABLE `([^`]+)`/g)].map((match) => match[1]).sort();
  assert.deepEqual(created, [...branchTables].sort());
  assert.equal(journal.entries.find((entry) => entry.idx === 10)?.tag, "0010_wide_silver_sable");
  assert.equal(journal.entries.find((entry) => entry.idx === 9)?.tag, "0009_narrow_edwin_jarvis");
  assertContainsAll(migration, [
    "article_project_packages` ADD `branch_model_version",
    "package_slices` ADD `branch_id",
    "package_slices` ADD `base_revision_id",
    "package_slices` ADD `base_branch_lock_version",
    "package_diagnosis_runs` ADD `branch_id",
    "package_diagnostic_issues` ADD `branch_id",
    "package_import_runs` ADD `branch_id",
    "package_export_runs` ADD `branch_id",
    "agent_tasks` ADD `base_branch_lock_version",
    "agent_context_snapshots` ADD `branch_state_lock_version",
  ], "0010 migration");
  assert.doesNotMatch(migration, /\bDROP\s+TABLE\b/i);
});

test("0010 migration 保留 dirty working copy，坏关系 blocked，未绑定关系不猜 primary", () => {
  assert.match(migration, /WHEN package\.primary_branch_id IS NULL THEN 'legacy_unbound'/);
  assert.match(migration, /THEN CASE WHEN legacy_copy\.dirty = 1 THEN 'migrated_dirty' ELSE 'migrated_clean' END/);
  assert.match(migration, /ELSE 'blocked'/);
  assertContainsAll(migration, [
    "'PRIMARY_BRANCH_MISSING'", "'LEGACY_PACKAGE_WORKING_BRANCH_MISMATCH'",
    "'ARTICLE_HEAD_REVISION_INVALID'", "'ARTICLE_WORKING_COPY_NOT_CLEAN_HEAD'",
    "'MATERIALIZATION_INVALID'", "'DIRTY_DOCUMENT_SHA_UNCHANGED'",
  ], "migration audit reason");
  assert.match(migration, /legacy_copy\.document_json, legacy_copy\.document_sha256, legacy_copy\.dirty, legacy_copy\.lock_version/);
  assert.match(migration, /audit\.state IN \('migrated_clean','migrated_dirty'\)/);
  assert.match(migration, /UPDATE article_project_packages SET branch_model_version = 2[\s\S]*JOIN package_branch_states[\s\S]*JOIN package_branch_working_copies[\s\S]*JOIN package_branch_composition_commits/);
  assert.doesNotMatch(migration, /UPDATE article_project_packages SET primary_branch_id/);
});

test("materialization 的 branch+composition 可多次物化，revision 仍保持唯一", () => {
  assert.match(migration, /DROP INDEX `idx_package_materializations_branch_composition`/);
  assert.match(migration, /CREATE INDEX `idx_package_materializations_branch_composition` ON `package_composition_materializations` \(`branch_id`,`composition_id`,`created_at`\)/);
  assert.doesNotMatch(migration, /CREATE UNIQUE INDEX `idx_package_materializations_branch_composition`/);
  assert.match(migration, /CREATE UNIQUE INDEX `idx_package_branch_commits_revision`/);
  assert.match(projectRoute, /CREATE INDEX IF NOT EXISTS idx_package_materializations_branch_composition ON package_composition_materializations\(branch_id, composition_id, created_at\)/);
});

test("runtime bootstrap 与版本迁移具有与 0010 migration 对齐的结构和审计", () => {
  for (const table of branchTables) {
    assert.match(projectRoute, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`), `runtime 缺少 ${table}`);
  }
  const ensure = functionBody(projectRoute, "ensureProjectPackageSchema");
  const migrate = functionBody(projectRoute, "migrateLegacyPackageBranches");
  assertContainsAll(ensure, [
    'addColumnIfMissing(db, "article_project_packages", "branch_model_version"',
    'addColumnIfMissing(db, "package_slices", "base_branch_lock_version"',
    'addColumnIfMissing(db, "package_diagnosis_runs", "base_branch_lock_version"',
    'addColumnIfMissing(db, "package_diagnostic_issues", "branch_id"',
    'addColumnIfMissing(db, "package_import_runs", "base_branch_lock_version"',
    'addColumnIfMissing(db, "package_export_runs", "base_branch_lock_version"',
    'DROP INDEX IF EXISTS idx_package_materializations_branch_composition',
    "migrateLegacyPackageBranches(db)",
  ], "runtime bootstrap");
  assertContainsAll(migrate, [
    '"legacy_unbound"', '"migrated_dirty"', '"migrated_clean"', '"blocked"',
    "INSERT OR IGNORE INTO package_branch_states",
    "INSERT OR IGNORE INTO package_branch_working_copies",
    "INSERT OR IGNORE INTO package_branch_composition_commits",
    "UPDATE article_project_packages SET branch_model_version = 2",
  ], "runtime legacy migration");
  assert.match(migrate, /row\.legacy_document_json[\s\S]*row\.legacy_document_sha256[\s\S]*row\.legacy_dirty[\s\S]*row\.legacy_lock_version/);
});

test("GET branches/package 暴露分支模型、迁移只读态和 branch-commit 历史", () => {
  const branches = viewBlock("branches");
  const packageView = viewBlock("package");
  assertContainsAll(branches, [
    'requiredQuery(url, "packageId")', "packageBranchEntries(db, root, limit)",
    "migrationAuditRow(db, ownerPackageId)", "branchModel:", "writable:",
  ], "GET branches");
  assertContainsAll(packageView, [
    'url.searchParams.get("branchId")', "root.primary_branch_id", "loadSelectedPackageBranch",
    "package_branch_composition_commits", "WHERE package_id = ? AND branch_id = ?",
    "recentBranchCommits", "migrationAudit", "readOnly: true", "readOnly: false",
  ], "GET package");
});

test("所有派生 GET list/detail 都强制 packageId+branchId 同时限定", () => {
  for (const view of ["slices", "patches", "diagnostics", "imports", "exports"]) {
    const block = viewBlock(view);
    assert.match(block, /requiredQuery\(url, "packageId"\)/, `${view} 缺少 packageId`);
    assert.match(block, /requiredQuery\(url, "branchId"\)/, `${view} 缺少 branchId`);
    assert.match(block, /package_id = \? AND branch_id = \?/, `${view} 未同时限定 Package 与 Branch`);
  }
});

test("attach_branch 以干净 ArticleBranch CAS 接入且不推进 ArticleRevision", () => {
  const body = functionBody(projectRoute, "attachBranchToPackage");
  assertContainsAll(body, [
    "expectedBranchWorkingLockVersion", "cleanBranchBinding", "copy.dirty = 0 AND copy.lock_version = ?",
    "INSERT INTO package_branch_states", "INSERT INTO package_branch_working_copies",
    "INSERT INTO package_branch_composition_commits", "'attach'", "wenmai-0010-attach-incomplete",
    "articleBranchAdvanced: false", "revisionCreated: false",
  ], "attach_branch");
  assert.doesNotMatch(body, /UPDATE article_branches SET head_revision_id/);
  assert.doesNotMatch(body, /INSERT INTO article_revisions/);
});

test("set_primary_branch 只切 root/legacy mirror，并对 Package 与目标 Branch 双 CAS", () => {
  const body = functionBody(projectRoute, "setPrimaryPackageBranch");
  assertContainsAll(body, [
    "expectedPackageLockVersion", "expectedBranchLockVersion", "expectedHeadCompositionId",
    "expectedHeadRevisionId", "loadSelectedPackageBranch(db, root, branchId, true)",
    "UPDATE article_project_packages", "UPDATE package_working_copies", "branch_model_version = 2",
    "state.lock_version = ?", "wenmai-0010-set-primary-incomplete",
  ], "set_primary_branch");
  assert.doesNotMatch(body, /UPDATE package_branch_states/);
  assert.doesNotMatch(body, /UPDATE article_branches/);
  assert.doesNotMatch(body, /INSERT INTO article_revisions/);
});

test("save 只 CAS 目标 branch working copy；root mirror 仅在 primary 时更新", () => {
  const body = functionBody(projectRoute, "saveWorkingPackage");
  assertContainsAll(body, [
    "expectedBranchLockVersion", "expectedWorkingLockVersion", "expectedBaseCompositionId",
    "expectedBaseRevisionId", "UPDATE package_branch_working_copies",
    "base_composition_id = ? AND base_revision_id = ? AND lock_version = ?",
    "state.lock_version = ?", "root.primary_branch_id === selected.branchId",
    "UPDATE package_working_copies", "wenmai-0010-save-incomplete",
  ], "save_working_package");
  assert.doesNotMatch(body, /INSERT INTO package_compositions/);
  assert.doesNotMatch(body, /UPDATE package_branch_states/);
});

test("分支基线健康允许有真实内容差异的 dirty 工作副本，但拒绝仅翻 dirty 标志", () => {
  const body = functionBody(projectRoute, "selectedBranchRows");
  assertContainsAll(body, [
    "const packageWorkingClean = Number(row.package_dirty) === 0",
    "row.package_document_sha256 === row.composition_document_sha256",
    "const packageWorkingDraft = Number(row.package_dirty) === 1",
    "row.package_document_sha256 !== row.composition_document_sha256",
    "(packageWorkingClean || packageWorkingDraft)",
  ], "branch working draft baseline");
});

test("commit 以 BranchState 为首个 CAS，并原子推进 branch commit、ArticleRevision 和 working copies", () => {
  const body = functionBody(projectRoute, "commitWorkingPackage");
  assertContainsAll(body, [
    "expectedBranchLockVersion", "expectedWorkingLockVersion", "expectedBaseCompositionId",
    "expectedBaseRevisionId", "const branchStateCas", "UPDATE package_branch_states",
    "INSERT INTO article_revisions", "UPDATE article_branches SET head_revision_id",
    "UPDATE branch_working_copies", "UPDATE package_branch_working_copies",
    "INSERT INTO package_branch_composition_commits", "'commit'",
    "root.primary_branch_id === selected.branchId", "wenmai-0010-commit-incomplete",
  ], "commit");
  assert.match(body, /WHERE package_id = \? AND branch_id = \?[\s\S]*lock_version = \?/);
});

test("apply_patch 对 approved Patch 与同一 Branch 基线双重 CAS，并写 branch commit", () => {
  const body = functionBody(projectRoute, "applyPatchProposal");
  assertContainsAll(body, [
    "expectedPatchLockVersion", "expectedBranchLockVersion", "expectedHeadCompositionId",
    "expectedHeadCompositionSha256", "expectedHeadRevisionId", "proposal.status !== \"approved\"",
    "proposal.base_branch_lock_version", "const branchStateCas", "UPDATE package_branch_states",
    "INSERT INTO article_revisions", "UPDATE article_branches SET head_revision_id",
    "UPDATE package_branch_working_copies", "INSERT INTO package_branch_composition_commits",
    "sourceKind", "status = 'applied'", "wenmai-0010-patch-apply-incomplete",
  ], "apply_patch");
  assert.match(body, /patch\.branch_id = package_branch_states\.branch_id/);
  assert.match(body, /root\.primary_branch_id === selected\.branchId/);
});

test("diagnosis/import/export 都冻结 Branch、Revision、BranchLock 与 branch-commit 证据", () => {
  const cases = [
    ["runBuiltinDiagnostics", "package_diagnosis_runs"],
    ["createImportCandidate", "package_import_runs"],
    ["createExportManifest", "package_export_runs"],
  ];
  for (const [name, table] of cases) {
    const body = functionBody(projectRoute, name);
    assertContainsAll(body, [
      "expectedBranchLockVersion", "baseRevisionId", "package_branch_composition_commits",
      "branchCommit", `INSERT INTO ${table}`, "branch_id", "base_revision_id",
      "base_branch_lock_version", "package_branch_states",
    ], name);
  }
  const diagnosis = functionBody(projectRoute, "runBuiltinDiagnostics");
  assert.match(diagnosis, /INSERT INTO package_diagnostic_issues[\s\S]*package_id, branch_id, composition_id/);
  const importBody = functionBody(projectRoute, "createImportCandidate");
  assert.match(importBody, /INSERT INTO package_patch_proposals[\s\S]*branch_id, base_revision_id/);
  assert.match(importBody, /candidateOnly: true/);
});

test("blocked migration 对写入返回 409；legacy_unbound 要求显式接入；Package GET 仅回只读审计", () => {
  const selector = functionBody(projectRoute, "selectedBranchRows");
  assertContainsAll(selector, [
    'audit?.state === "blocked"', 'audit?.state === "legacy_unbound"',
    "PACKAGE_BRANCH_MIGRATION_REQUIRED", "409", "Number(root.branch_model_version) !== 2",
  ], "branch write gate");
  const attach = functionBody(projectRoute, "attachBranchToPackage");
  assert.match(attach, /audit\?\.state === "blocked"[\s\S]*PACKAGE_BRANCH_MIGRATION_REQUIRED[\s\S]*409/);
  const decide = functionBody(projectRoute, "decidePatchProposal");
  assert.match(decide, /migrationAudit\?\.state === "blocked"[\s\S]*PACKAGE_BRANCH_MIGRATION_REQUIRED[\s\S]*409/);
  const packageView = viewBlock("package");
  assert.match(packageView, /audit\?\.state === "blocked" \|\| Number\(root\.branch_model_version\) !== 2/);
  assert.match(packageView, /branchWorkingCopy: null[\s\S]*migrationAudit:[\s\S]*readOnly: true/);
});

test("Legacy Workspace 封锁所有 active package_branch_states，不只看 root.primary", () => {
  const detect = functionBody(workspaceRoute, "packageBranchProtection");
  const guard = functionBody(workspaceRoute, "packageBranchNotExistsSql");
  const pairGuard = functionBody(workspaceRoute, "packageBranchPairGuardFromProposalSql");
  const preflight = functionBody(workspaceRoute, "assertLegacyWorkspaceBranchesWritable");
  assertContainsAll(detect, ["package_branch_states", "article_project_packages", "PRAGMA table_info(package_branch_states)"], "workspace detection");
  for (const body of [guard, pairGuard, preflight]) {
    assert.match(body, /package_branch_states/);
    assert.match(body, /status = 'active'/);
    assert.match(body, /branch_id/);
  }
  assert.match(preflight, /branch_id IN \(\$\{placeholders\}\)/);
  for (const name of ["saveWorkingCopy", "commitRevision", "prepareMerge", "mergeRevision"]) {
    assert.match(functionBody(workspaceRoute, name), /assertLegacyWorkspaceBranchesWritable/);
  }
});

test("分支当前提交和历史读取来自 package_branch_composition_commits，而非 Composition.parent 猜测", () => {
  const selector = functionBody(projectRoute, "selectedBranchRows");
  const packageView = viewBlock("package");
  assert.match(selector, /LEFT JOIN package_branch_composition_commits commit_ref/);
  assert.match(selector, /commit_ref\.article_revision_id = state\.head_revision_id/);
  assert.match(selector, /row\.commit_composition_id === row\.head_composition_id/);
  assert.match(selector, /row\.commit_composition_sha256 === row\.head_composition_sha256/);
  assert.match(selector, /row\.commit_article_revision_id === row\.head_revision_id/);
  assert.doesNotMatch(selector, /ON[^;]*commit_ref\.composition_id = state\.head_composition_id/,
    "读投影必须保留 composition 漂移行并返回 inSync=false，不能用 INNER JOIN 把问题伪装成 404");
  assert.match(projectRoute, /if \(!row\.branch_commit_id\) return null/);
  assert.match(projectRoute, /composition_id: row\.commit_composition_id/);
  assert.match(projectRoute, /composition_sha256: row\.commit_composition_sha256/);
  assert.match(projectRoute, /article_revision_id: row\.commit_article_revision_id/);
  assert.match(packageView, /SELECT \* FROM package_branch_composition_commits[\s\S]*WHERE package_id = \? AND branch_id = \?[\s\S]*ORDER BY created_at DESC/);
  for (const name of ["attachBranchToPackage", "commitWorkingPackage", "applyPatchProposal"]) {
    assert.match(functionBody(projectRoute, name), /INSERT INTO package_branch_composition_commits/, `${name} 未记录 branch commit`);
  }
});
