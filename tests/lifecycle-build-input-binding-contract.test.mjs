import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const route = readFileSync(new URL("../app/api/lifecycle/route.ts", import.meta.url), "utf8");
const schema = readFileSync(new URL("../db/schema.ts", import.meta.url), "utf8");
const types = readFileSync(new URL("../app/lifecycle-types.ts", import.meta.url), "utf8");
const migration = readFileSync(new URL("../drizzle/0018_publication_build_binding.sql", import.meta.url), "utf8");
const consoleSource = readFileSync(new URL("../app/LifecycleConsole.tsx", import.meta.url), "utf8");

function functionBody(name, nextName) {
  const start = route.indexOf(`async function ${name}`);
  const end = route.indexOf(`async function ${nextName}`, start + 1);
  assert.ok(start >= 0, `missing function ${name}`);
  assert.ok(end > start, `missing boundary after ${name}`);
  return route.slice(start, end);
}

test("Build 输入绑定一等保存 Composition、Slice、PublicationVersion 与封面回执链", () => {
  for (const marker of [
    "lifecycle_build_input_bindings",
    "input_binding_sha256",
    "branch_lock_version",
    "composition_id",
    "composition_sha256",
    "slice_id",
    "slice_sha256",
    "publication_version_id",
    "publication_registration_sha256",
    "cover_run_id",
    "cover_recipe_sha256",
    "cover_receipt_id",
    "cover_receipt_sha256",
    "cover_receipt_chain_sha256",
    "cover_artifact_sha256",
    "cover_baseline_id",
    "cover_profile_sha256",
  ]) {
    assert.ok(route.includes(marker), `runtime DDL/route missing ${marker}`);
    assert.ok(schema.includes(marker) || schema.includes(marker.replaceAll(/_([a-z])/gu, (_, value) => value.toUpperCase())),
      `Drizzle schema missing ${marker}`);
    assert.ok(migration.includes(marker), `0018 missing ${marker}`);
  }
  assert.match(types, /BuildInputCurrentness = "current" \| "stale" \| "legacy_unbound"/u);
  assert.match(types, /ContentBuildInputBindingRecord/u);
  assert.match(types, /buildInputCurrentness\?: BuildInputCurrentness/u);
});

test("create_build 只保留新冻结路径，且所有调用方必须提交精确摘要", () => {
  assert.doesNotMatch(route, /createBuildLegacy/u);
  const create = functionBody("createBuild", "recordBuildResult");
  for (const marker of [
    "expectedBranchLockVersion",
    "expectedRevisionId",
    "expectedBodySha256",
    "expectedCompositionId",
    "expectedCompositionSha256",
    "expectedSliceSha256",
    "publicationVersionId",
    "expectedPublicationRegistrationSha256",
    "coverRunId",
    "expectedCoverReceiptId",
    "expectedCoverReceiptSha256",
    "expectedCoverArtifactSha256",
    "expectedCoverProfileSha256",
    "expectedContractSha256",
    "expectedTargetProfileSha256",
  ]) assert.ok(create.includes(marker), `create_build missing ${marker}`);
  assert.match(create, /readCurrentCoverReceiptChain/u);
  assert.match(create, /INFORMATION_COVER_BASELINE_ID/u);
  assert.match(create, /INFORMATION_COVER_PROFILE_SHA256/u);
  assert.match(create, /cover\.receiptChainSha256/u);
  assert.match(create, /composition_slice_cover_and_publication_inputs_frozen/u);
  for (const marker of [
    "packageId",
    "expectedBranchLockVersion",
    "expectedCompositionId",
    "expectedCompositionSha256",
    "sliceId",
    "expectedSliceSha256",
    "publicationVersionId",
    "expectedPublicationRegistrationSha256",
    "coverRunId",
    "expectedCoverReceiptId",
    "expectedCoverReceiptSha256",
    "expectedCoverArtifactSha256",
    "expectedCoverProfileSha256",
  ]) assert.ok(consoleSource.includes(marker), `LifecycleConsole create_build missing ${marker}`);
  assert.match(consoleSource, /strictBuildInput\(strictBuildInputJson\)/u);
  assert.ok(consoleSource.includes("disabled={!cleanBaseline || !strictBuildPayload"));
});

test("currentness 同时重算所有源身份，并把旧 Build 明示为 legacy_unbound", () => {
  const evaluator = route.slice(
    route.indexOf("async function evaluateBuildInputBinding"),
    route.indexOf("function eventFromRow"),
  );
  for (const table of [
    "article_project_packages",
    "lifecycle_article_projects",
    "lifecycle_adaptation_contracts",
    "package_branch_states",
    "package_branch_working_copies",
    "article_branches",
    "article_revisions",
    "branch_working_copies",
    "package_compositions",
    "package_composition_materializations",
    "package_slices",
    "article_publication_versions",
    "lifecycle_platform_targets",
    "production_runs",
    "production_run_steps",
  ]) assert.ok(evaluator.includes(table), `currentness missing ${table}`);
  for (const blocker of [
    "package_branch_head_changed",
    "adaptation_contract_changed",
    "article_revision_changed",
    "composition_materialization_changed",
    "slice_changed",
    "publication_version_changed",
    "canonical_baseline_changed",
    "target_profile_changed",
    "cover_profile_changed",
    "cover_recipe_changed",
    "cover_receipt_changed",
    "cover_receipt_chain_stale",
  ]) assert.ok(evaluator.includes(blocker), `currentness missing blocker ${blocker}`);
  assert.match(route, /Build 缺少 0018 输入绑定；历史 Build 只读，必须重新 Build/u);
  assert.match(route, /inputCurrentness: inputBinding\?\.currentness \?\? "legacy_unbound"/u);
  assert.match(route, /buildInputCurrentness: input\.currentness/u);
  assert.match(evaluator, /canonical_state\.lock_version = canonical\.branch_lock_version/u);
  assert.match(evaluator, /canonical_article_copy\.dirty = 0/u);
  assert.match(evaluator, /canonical_materialization\.article_body_sha256 = canonical\.body_sha256/u);
});

test("built、门禁、建 Release、批准与开始提交都 fail closed，并在 SQL 中原子复核", () => {
  const result = functionBody("recordBuildResult", "supersedeBuild");
  const gate = functionBody("recordBuildGate", "createRelease");
  const release = functionBody("createRelease", "decideReleaseApproval");
  const approval = functionBody("decideReleaseApproval", "startReleaseSubmission");
  const submit = functionBody("startReleaseSubmission", "recordReleaseSubmission");

  for (const body of [result, gate, release, approval, submit]) {
    assert.match(body, /requireCurrentBuildInputBinding/u);
    assert.match(body, /inputBindingSha256/u);
    assert.match(body, /currentBuildInputSql/u);
  }
  assert.match(approval, /targetState === "approved"[\s\S]*requireCurrentBuildInputBinding/u);
  assert.match(submit, /approval_state = 'approved'/u);
  assert.match(release, /latestPassingGate\("compatibility"\)/u);
  assert.match(release, /latestPassingGate\("fidelity"\)/u);
});

test("封面回执 currentness 绑定四工位原始 evidence 文本和当前 V2 Profile", () => {
  const sql = route.slice(route.indexOf("function currentBuildInputSql"), route.indexOf("function eventFromRow"));
  for (const stepId of [
    "cover-copy-contract",
    "cover-visual-plan",
    "cover-render-gates",
    "cover-human-acceptance",
  ]) assert.ok(sql.includes(stepId), `atomic cover guard missing ${stepId}`);
  assert.match(sql, /cover_receipt_chain_json/u);
  assert.match(sql, /json_extract\(cover_acceptance\.evidence_json, '\$\[#-1\]'\)/u);
  assert.match(sql, /INFORMATION_COVER_BASELINE_ID/u);
  assert.match(sql, /INFORMATION_COVER_PROFILE_SHA256/u);
  assert.match(sql, /binding\.cover_recipe_version = '1\.4\.0'/u);
  assert.match(sql, /adaptation\.status = 'approved'/u);
  assert.match(sql, /canonical_state\.head_revision_id = canonical\.revision_id/u);
  assert.match(sql, /canonical_package_copy\.dirty = 0/u);
});

test("create_build 与 currentBuildInputSql 可由 fresh 0018 SQLite 实际编译", () => {
  const db = new DatabaseSync(":memory:");
  const migrationNames = readdirSync(new URL("../drizzle/", import.meta.url))
    .filter((name) => /^\d{4}_.+\.sql$/u.test(name))
    .sort();
  for (const name of migrationNames) {
    const sql = readFileSync(new URL(`../drizzle/${name}`, import.meta.url), "utf8");
    for (const statement of sql.split("--> statement-breakpoint").map((value) => value.trim()).filter(Boolean)) {
      db.exec(statement);
    }
  }
  const match = route.match(/function currentBuildInputSql[\s\S]*?return `([\s\S]*?)`;\s*\}/u);
  assert.ok(match, "missing currentBuildInputSql template");
  const predicate = match[1]
    .replaceAll("${buildRef}", "b")
    .replaceAll("${INFORMATION_COVER_BASELINE_ID}", "information-knowledge-cover-v2")
    .replaceAll(
      "${INFORMATION_COVER_PROFILE_SHA256}",
      "df34a572f77af5f0fa048a2e9546a356127c9f7f1c3d28d8c0fe719f75a61120",
    );
  assert.doesNotThrow(() => db.prepare(`EXPLAIN SELECT 1 FROM lifecycle_builds b WHERE ${predicate}`));
  const buildInsert = route.match(/const buildInsert = db\.prepare\(`([\s\S]*?)`\)\.bind\(/u);
  assert.ok(buildInsert, "missing create_build atomic INSERT");
  assert.doesNotThrow(() => db.prepare(`EXPLAIN ${buildInsert[1].replace("${coverStepGuard}", "")}`));
  const evaluatorSource = functionBody("evaluateBuildInputBinding", "requireCurrentBuildInputBinding");
  const evaluationQuery = evaluatorSource.match(/const current = await db\.prepare\(`(SELECT[\s\S]*?)`\)\s*\.bind\(/u);
  assert.ok(evaluationQuery, "missing currentness evaluation SELECT");
  assert.doesNotThrow(() => db.prepare(`EXPLAIN ${evaluationQuery[1]}`));
  db.close();
});

test("0018 对 Build 绑定实施主键、JSON、摘要与检索约束", () => {
  assert.match(migration, /CREATE TABLE `lifecycle_build_input_bindings`/u);
  assert.match(migration, /`build_id` text PRIMARY KEY NOT NULL/u);
  assert.match(migration, /lifecycle_build_input_binding_receipt_json_check/u);
  assert.match(migration, /lifecycle_build_input_binding_chain_json_check/u);
  assert.match(migration, /lifecycle_build_input_binding_sha_check/u);
  assert.match(migration, /idx_lifecycle_build_input_package_branch/u);
  assert.match(migration, /idx_lifecycle_build_input_cover_receipt/u);
});
