import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const routePath = path.join(root, "app", "api", "project-package", "v1", "route.ts");
const typesPath = path.join(root, "app", "article-project-types.ts");
const importProfilePath = path.join(root, "app", "import-profile.ts");
const schemaPath = path.join(root, "db", "schema.ts");
const migrationPath = path.join(root, "drizzle", "0008_bent_silver_samurai.sql");
const journalPath = path.join(root, "drizzle", "meta", "_journal.json");
const snapshotPath = path.join(root, "drizzle", "meta", "0008_snapshot.json");

const route = fs.readFileSync(routePath, "utf8");
const types = fs.readFileSync(typesPath, "utf8");
const importProfile = fs.readFileSync(importProfilePath, "utf8");
const schema = fs.readFileSync(schemaPath, "utf8");
const migration = fs.readFileSync(migrationPath, "utf8");
const journal = JSON.parse(fs.readFileSync(journalPath, "utf8"));
const snapshot = JSON.parse(fs.readFileSync(snapshotPath, "utf8"));

const packageTables = [
  "article_project_packages",
  "package_modules",
  "package_module_revisions",
  "package_assets",
  "package_source_refs",
  "package_module_revision_refs",
  "package_compositions",
  "package_composition_nodes",
  "package_composition_edges",
  "package_working_copies",
  "package_slices",
  "package_patch_proposals",
  "package_diagnosis_runs",
  "package_diagnostic_issues",
  "package_import_runs",
  "package_export_runs",
];

function functionBody(name) {
  const asyncStart = route.indexOf(`async function ${name}`);
  const syncStart = route.indexOf(`function ${name}`);
  const start = asyncStart >= 0 ? asyncStart : syncStart;
  assert.notEqual(start, -1, `缺少 ${name}`);
  const next = route.indexOf("\nasync function ", start + 15);
  const exported = route.indexOf("\nexport async function ", start + 15);
  const ends = [next, exported].filter((value) => value >= 0);
  return route.slice(start, ends.length ? Math.min(...ends) : route.length);
}

test("0008 是精确的 16 张 ArticleProject 新表且保持纯新增", () => {
  const migratedTables = [...migration.matchAll(/CREATE TABLE `([^`]+)`/g)].map((match) => match[1]).sort();
  assert.deepEqual(migratedTables, [...packageTables].sort());
  assert.doesNotMatch(migration, /\b(?:ALTER|DROP)\s+TABLE\b/i);
  assert.doesNotMatch(migration, /CREATE TABLE `(?:command_receipts|article_revisions|article_branches|branch_working_copies|lifecycle_[^`]+)`/);
});

test("Drizzle journal 与 snapshot 精确登记 0008", () => {
  const entry = journal.entries.find((candidate) => candidate.idx === 8);
  assert.equal(entry.idx, 8);
  assert.equal(entry.tag, "0008_bent_silver_samurai");
  assert.equal(snapshot.version, "6");
});

test("schema、runtime bootstrap 与 migration 同时覆盖 16 张表", () => {
  for (const table of packageTables) {
    assert.match(schema, new RegExp(`["']${table}["']`), `schema 缺少 ${table}`);
    assert.match(route, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`), `runtime bootstrap 缺少 ${table}`);
    assert.ok(migration.includes(`CREATE TABLE \`${table}\``), `0008 缺少 ${table}`);
  }
  assert.doesNotMatch(route, /CREATE TABLE IF NOT EXISTS package_events\b/);
  assert.match(route, /Drizzle 0008 creates the Package model and 0009 adds its single-primary-ArticleBranch bridge/);
  assert.match(route, /blindly replayed over a runtime-bootstrapped/);
});

test("核心 TS 类型冻结 PackageDocument、不可变 Composition、诊断与 Patch", () => {
  for (const symbol of [
    "PackageDocument", "PackageModuleInput", "PackageEdgeInput", "PackagePatchOperation",
    "ArticleProjectPackageRecord", "PackageWorkingCopyRecord", "PackageCompositionRecord",
    "PackagePatchProposalRecord", "DiagnosisRunRecord", "DiagnosticIssueRecord",
  ]) assert.match(types, new RegExp(`(?:interface|type) ${symbol}\\b`));
  assert.match(types, /wenmai-package-document-v1/);
  assert.match(types, /replace_document/);
  assert.match(types, /remove_edge/);
});

test("GET/POST 使用统一 envelope，写入要求同源与显式写意图", () => {
  assert.match(route, /ok: true, requestId: id, data/);
  assert.match(route, /ok: false,[\s\S]*requestId: id,[\s\S]*error:/);
  assert.match(route, /function sameOrigin\(/);
  assert.match(route, /assertManagementWrite\(request\)/);
  assert.match(route, /request\.headers\.get\("x-wenmai-write"\) !== "1"/);
  assert.match(route, /WRITE_INTENT_REQUIRED/);
  assert.match(route, /if \(fetchSite\) return fetchSite === "same-origin" \|\| fetchSite === "none"/,
    "已认证浏览器 GET 不能因隐私策略省略 Referer 而误判为跨站");
});

test("所有写动作使用必填 commandId、canonical SHA 与全局 receipt", () => {
  assert.match(route, /const \{ action, commandId: suppliedCommandId, payload \} = await parseMutationBody\(request\)/);
  const commandIdValidation = /commandId = requiredText\(suppliedCommandId, "commandId", 160\);\s*if \(!ID_RE\.test\(commandId\)\) throw new ProjectPackageApiError\("INVALID_COMMAND_ID"/g;
  assert.equal([...route.matchAll(commandIdValidation)].length, 2, "owner 与 Agent 授权路径都必须校验由解析层传入的 commandId");
  assert.match(route, /const result = await withReceipt\(db, action, actorId, commandId, payload,/);
  assert.match(route, /const commandType = `project_package\.v1\.\$\{action\}`/);
  assert.match(route, /sha256Text\(canonicalJson\(\{ action, actorId, payload \}\)\)/);
  assert.match(route, /INSERT INTO command_receipts/);
  assert.match(route, /COMMAND_ID_REUSED/);
  assert.match(route, /COMMAND_IN_PROGRESS/);
  assert.doesNotMatch(route, /DELETE FROM command_receipts/);
});

test("GET 与 POST 合同冻结所需视图和动作", () => {
  for (const view of [
    "manifest", "health", "packages", "package", "composition", "module", "working",
    "resources", "slices", "patches", "diagnostics", "imports", "exports",
  ]) assert.match(route, new RegExp(`"${view}"`), `缺少 GET view=${view}`);
  for (const action of [
    "ensure_from_revision", "create_from_text", "save_working_package", "commit", "create_slice",
    "create_patch", "decide_patch", "apply_patch", "recommend_import_profile", "create_import_candidate",
    "create_export_manifest", "run_builtin_diagnostics",
  ]) assert.match(route, new RegExp(`"${action}"`), `缺少 POST action=${action}`);
});

test("不可变对象没有 UPDATE 或 DELETE 路径", () => {
  for (const table of [
    "package_module_revisions", "package_assets", "package_source_refs", "package_module_revision_refs",
    "package_compositions", "package_composition_nodes", "package_composition_edges", "package_slices",
    "package_diagnosis_runs", "package_diagnostic_issues",
  ]) {
    assert.doesNotMatch(route, new RegExp(`(?:UPDATE|DELETE FROM) ${table}\\b`, "i"), `${table} 不应可变`);
  }
});

test("保存 branch working copy 不创建 Composition，也不推进分支或 Package main", () => {
  const body = functionBody("saveWorkingPackage");
  assert.match(body, /UPDATE package_branch_working_copies/);
  assert.match(body, /base_composition_id = \? AND base_revision_id = \?/);
  assert.match(body, /expectedBranchLockVersion/);
  assert.match(body, /expectedWorkingLockVersion/);
  assert.match(body, /wenmai-0010-save-incomplete/);
  assert.doesNotMatch(body, /INSERT INTO package_compositions/);
  assert.doesNotMatch(body, /UPDATE article_project_packages/);
  assert.match(body, /compositionCreated: false, branchAdvanced: false, packageMainAdvanced: false/);
});

test("commit 同时门禁目标 branch state、两份 working copy 与 dirty 基线", () => {
  const body = functionBody("commitWorkingPackage");
  assert.match(body, /expectedBranchLockVersion/);
  assert.match(body, /expectedWorkingLockVersion/);
  assert.match(body, /expectedBaseCompositionId/);
  assert.match(body, /expectedBaseRevisionId/);
  assert.match(body, /expectedDocumentSha256/);
  assert.match(body, /UPDATE package_branch_states/);
  assert.match(body, /UPDATE article_branches SET head_revision_id/);
  assert.match(body, /UPDATE article_project_packages/);
  assert.match(body, /copy\.dirty = 1 AND copy\.lock_version = \?/);
  assert.match(body, /primary_branch_id = \?/);
  assert.match(body, /dirty = 0/);
  assert.match(body, /wenmai-0010-commit-incomplete/);
  assert.match(body, /immutableCompositionCreated: true, branchAdvanced: true, articleBranchAdvanced: true/);
});

test("Composition 投影插入依赖推进后的同一主指针 CAS", () => {
  const body = functionBody("guardedBulkInsert");
  assert.match(body, /WITH gate\(ok\) AS/);
  assert.match(body, /main_composition_id = \?/);
  assert.match(body, /main_composition_sha256 = \?/);
  assert.match(body, /lock_version = \?/);
  assert.match(body, /SELECT .* FROM rows, gate/s);
});

test("Patch 创建和决定不推进主线，只有 apply 执行 CAS", () => {
  const create = functionBody("createPatchProposal");
  const decide = functionBody("decidePatchProposal");
  const apply = functionBody("applyPatchProposal");
  assert.match(create, /'candidate'/);
  assert.match(create, /candidateOnly: true, packageMainAdvanced: false, compositionCreated: false/);
  assert.doesNotMatch(create, /UPDATE article_project_packages/);
  assert.match(decide, /status = \?, lock_version = lock_version \+ 1/);
  assert.doesNotMatch(decide, /INSERT INTO package_compositions/);
  assert.doesNotMatch(decide, /UPDATE article_project_packages/);
  assert.match(apply, /patch\.status = 'approved'/);
  assert.match(apply, /UPDATE package_branch_states/);
  assert.match(apply, /UPDATE article_project_packages/);
  assert.match(apply, /PATCH_BRANCH_BASE_STALE/);
  assert.match(apply, /compositionCreated: true/);
  assert.match(apply, /branchAdvanced: true/);
});

test("诊断只写 DiagnosisRun/Issue，修复建议必须另建 Patch", () => {
  const body = functionBody("runBuiltinDiagnostics");
  assert.match(body, /INSERT INTO package_diagnosis_runs/);
  assert.match(body, /INSERT INTO package_diagnostic_issues/);
  assert.match(body, /suggested_patch_json/);
  assert.match(body, /patchProposalCreated: false/);
  assert.doesNotMatch(body, /UPDATE article_project_packages/);
  assert.doesNotMatch(body, /UPDATE package_working_copies/);
  assert.doesNotMatch(body, /INSERT INTO package_compositions/);
  assert.match(route, /diagnostic_issue_ids_json/);
});

test("Import 只形成 candidate Patch，不存在 apply_import 捷径", () => {
  const body = functionBody("createImportCandidate");
  assert.match(body, /INSERT INTO package_patch_proposals/);
  assert.match(body, /INSERT INTO package_import_runs/);
  assert.match(body, /'candidate_ready'/);
  assert.match(body, /candidateOnly: true, packageMainAdvanced: false, branchAdvanced: false/);
  assert.match(body, /compositionCreated: false, sourceWritten: false/);
  assert.doesNotMatch(body, /UPDATE article_project_packages/);
  assert.doesNotMatch(body, /INSERT INTO package_compositions/);
  assert.doesNotMatch(route, /"apply_import"/);
});

test("导入处理预设由 LLM 提出候选、人工确认，失败回退不改变文章", () => {
  const recommend = functionBody("recommendImportProfile");
  assert.match(recommend, /requestModelGatewayJson/);
  assert.match(recommend, /parseImportProfileModelOutput/);
  assert.match(recommend, /fallbackImportProfileRecommendation/);
  assert.match(recommend, /humanConfirmationRequired: true/);
  assert.match(recommend, /bodyDisclosedToModel: false/);
  assert.match(recommend, /articleMutated: false/);
  assert.match(recommend, /importCommitted: false/);
  assert.match(recommend, /automaticRetry: false/);
  assert.match(recommend, /payload\.recommendationProvider === undefined/);
  assert.match(recommend, /"local_rules"/);
  assert.match(recommend, /INVALID_IMPORT_RECOMMENDATION_PROVIDER/);
  assert.match(recommend, /routeDecisionSha256/);
  assert.doesNotMatch(recommend, /statuses\.find\(\(status\) => status\.ready\)/);
  assert.match(route, /recommend_import_profile: \["name", "format", "title", "text", "sourceFingerprintSha256", "bytes", "headings", "paragraphs", "packageSignals\?", "recommendationProvider\?"\]/);
  assert.match(recommend, /catch \(error\)[\s\S]*paidEgressPerformed: true/);
  assert.doesNotMatch(recommend, /INSERT INTO article_|UPDATE article_|createInitialPackage|createImportCandidate/);
  assert.match(importProfile, /bodyIncluded: false/);
  assert.match(importProfile, /fileNameIncluded: false/);
  assert.match(importProfile, /titleIncluded: false/);
  assert.match(importProfile, /sourceShaIncluded: false/);
});

test("人工选择的轻量或完整预设进入不可变 Document metadata，并绑定来源 SHA", () => {
  const create = functionBody("createFromText");
  const initial = functionBody("initialDocument");
  const candidate = functionBody("createImportCandidate");
  const packageCreate = functionBody("createInitialPackage");
  assert.match(create, /parseImportWorkflowMetadata/);
  assert.match(create, /sourceFingerprintSha256/);
  assert.match(create, /importWorkflow/);
  assert.match(initial, /metadata: importWorkflow \? \{ importWorkflow \} : \{\}/);
  assert.match(candidate, /parseImportWorkflowMetadata/);
  assert.match(candidate, /candidateDocument\.metadata\.importWorkflow/);
  assert.match(candidate, /importWorkflow: candidateDocument\.metadata\.importWorkflow \?\? null/);
  assert.match(packageCreate, /IMPORT_WORKFLOW_PROFILE_CONFLICT/);
  assert.match(packageCreate, /currentWorkflow\.selectedProfile !== input\.importWorkflow\.selectedProfile/);
  assert.match(importProfile, /selectedBy: "human"/);
  assert.match(importProfile, /publishReady: false/);
  assert.match(importProfile, /deliveryComplete: false/);
  assert.match(importProfile, /publicReleaseVerified: false/);
});

test("Export manifest 不伪造 Artifact、Release、发布或公开可见", () => {
  const body = functionBody("createExportManifest");
  assert.match(body, /'manifest_ready'/);
  assert.match(body, /artifact_ref, artifact_sha256/);
  assert.match(body, /'', '', 'application\/json'/);
  assert.match(body, /artifactCreated: false, releaseCreated: false, published: false, publiclyVisible: false/);
  assert.doesNotMatch(route, /(?:INSERT INTO|UPDATE) lifecycle_releases/);
});

test("列表全部受 MAX_LIST_LIMIT 约束，正文只在 detail/working 路径返回", () => {
  assert.match(route, /const MAX_LIST_LIMIT = 100/);
  assert.match(route, /function boundedLimit/);
  assert.match(route, /LIMIT \?/g);
  assert.match(route, /parseCompositionRow\(composition, true\)/);
  assert.match(route, /selectedRevision: selected \? parseModuleRevisionRow\(selected, true\)/);
  assert.match(route, /workingCopy: working \? parseWorkingRow\(working\) : null/);
});

test("UI 所需 Package、Patch、Diagnosis 与 Slice 响应字段保持稳定", () => {
  assert.match(route, /package: parsePackageRow\(root\), branches, selectedBranchId: selected\.branchId/);
  assert.match(route, /composition: parseCompositionRow\(selected\.composition, true\)/);
  assert.match(route, /workingCopy: selected\.workingCopy, branchWorkingCopy: selected\.workingCopy/);
  assert.match(route, /return \{ patchProposals:/);
  assert.match(route, /return \{ diagnosisRuns:/);
  assert.match(route, /return \{ slices:/);
});
