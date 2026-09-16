import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test from "node:test";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const route = await readFile(path.join(root, "app", "api", "article-identity", "v1", "route.ts"), "utf8");
const schema = await readFile(path.join(root, "db", "schema.ts"), "utf8");
const migration = await readFile(path.join(root, "drizzle", "0016_small_scorpion.sql"), "utf8");
const journal = JSON.parse(await readFile(path.join(root, "drizzle", "meta", "_journal.json"), "utf8"));

test("article identity exposes a management-session and CSRF protected, receipt-backed API", () => {
  assert.match(route, /requireManagementSession\(request, \{ scope: "management\.read" \}\)/u);
  assert.match(route, /requireManagementSession\(request, \{ mutation: true, scope: "identity\.decide" \}\)/u);
  assert.match(route, /managementActorId\(principal\)/u);
  assert.match(route, /article_identity\.v1\.\$\{action\}/u);
  assert.match(route, /COMMAND_ID_REUSED/u);
  assert.match(route, /status_code = 0/u);
  assert.doesNotMatch(route, /DELETE\s+FROM/iu, "身份 API 不提供删除历史的执行路径");
});

test("article identity freezes candidate-before-plan and candidate-only model boundary", () => {
  for (const action of [
    "scan_candidates", "plan_consolidation", "apply_consolidation",
    "plan_source_owner_repair", "apply_source_owner_repair", "supersede_stale_operation", "rollback_operation",
  ]) assert.match(route, new RegExp(`"${action}"`, "u"));
  assert.match(route, /status='candidate'/u);
  assert.match(route, /CANDIDATE_MISMATCH/u);
  assert.match(route, /autoApplied: false/u);
  assert.match(route, /相似度不会自动确认身份或执行清理/u);
  assert.match(route, /proposedRelation: "same_work" \| "superseded_by"/u);
  assert.match(route, /sourceBodySha256/u);
  assert.match(route, /targetBodySha256/u);
});

test("catalog contract separates local revisions, branches, identities and candidates", () => {
  for (const field of [
    "localArticles", "identities", "candidates", "counts", "revisionCount", "branchCount",
    "activeBranchCount", "archivedBranchCount", "unmergedBranchCount", "dirtyWorkingCopyCount",
    "pendingCandidateCount", "canonicalArticleId", "identityRole", "catalogState", "legacyRootCount",
    "identityMemberCount", "headBodySha256", "canonicalRedirect", "revisions",
  ]) assert.match(route, new RegExp(`\\b${field}\\b`, "u"), `catalog 缺少 ${field}`);
  assert.match(route, /length\(body_text\) char_count/u);
  assert.match(route, /hiddenFromPrimary|hidden_from_primary/u);
  assert.match(route, /p\.status='archived' AND s\.status='active'/u);
});

test("consolidation is additive and archives only the legacy root", () => {
  assert.match(route, /UPDATE article_project_packages SET status='archived'/u);
  assert.match(route, /UPDATE article_branches SET status='archived'/u);
  assert.match(route, /UPDATE package_branch_states SET status='archived'/u);
  assert.match(route, /publicationReferencesMutated: false/u);
  assert.match(route, /["']derived_from["']/u);
  assert.match(route, /["']superseded_by["']/u);
  assert.match(route, /PRECONDITION_FAILED/u);
  assert.match(route, /ROLLBACK_BLOCKED/u);
  assert.doesNotMatch(route, /UPDATE lifecycle_(?:builds|releases|article_projects)/u);
});

test("planned consolidation reuse and supersession preserve audit rows without applying stale plans", () => {
  assert.match(route, /consolidationFrozenKey/u);
  assert.match(route, /reusedPlan: true/u);
  assert.match(route, /otherPlanned/u);
  assert.match(route, /terminalDisposition: "superseded"/u);
  assert.match(route, /storageStatus: "rolled_back"/u);
  assert.match(route, /supersedeStaleOperation/u);
  assert.match(route, /SUPERSESSION_NOT_PROVEN/u);
  assert.match(route, /SUPERSESSION_CAS_FAILED/u);
  assert.match(route, /effectiveStatus/u);
  assert.match(route, /stalePlannedOperations/u);
  assert.match(route, /stalePlannedOperationCount/u);
  assert.match(route, /terminalProof/u);
  assert.match(route, /recommendedAction: "supersede_stale_operation"/u);
  assert.match(route, /status IN \('confirmed','superseded'\)/u);
  assert.match(route, /autoApplied: false/u);
  assert.match(route, /deleted: false/u);
  assert.doesNotMatch(route, /DELETE\s+FROM/iu);
});

test("source owner repair copies immutable history and retains it during rollback", () => {
  assert.match(route, /corpusVersionOwner/u);
  assert.match(route, /SOURCE_OWNER_NOT_UNIQUE/u);
  assert.match(route, /SOURCE_OWNER_EVIDENCE_MISMATCH/u);
  assert.match(route, /WORKING_COPY_NOT_CLEAN/u);
  assert.match(route, /SOURCE_BRANCH_HAS_DOWNSTREAM/u);
  assert.match(route, /INSERT INTO article_revisions/u);
  assert.match(route, /INSERT INTO article_branches/u);
  assert.match(route, /INSERT INTO branch_working_copies/u);
  assert.match(route, /INSERT INTO work_items/u);
  assert.match(route, /article\.identity\.owner_repaired/u);
  assert.match(route, /retainedImmutableRevisionId/u);
});

test("source owner mismatch discovery is read-only and returns corpus evidence plus CAS coordinates", () => {
  assert.match(route, /"source_owner_mismatches"/u);
  assert.match(route, /sourceOwnerMismatchesView/u);
  for (const field of [
    "sourceBranchId", "sourceArticleId", "sourceRevisionId", "sourceVersionId", "sourceBodySha256",
    "currentOwnerArticleId", "currentOwnerTitle", "bodyShaMatchesOwnerTextHash",
    "branchUpdatedAt", "workingCopyLockVersion", "packageBranchLockVersion", "autoRepairAttempted",
  ]) assert.match(route, new RegExp(`\\b${field}\\b`, "u"), `source-owner 扫描缺少 ${field}`);
  assert.match(route, /WHERE b\.status='active' AND b\.base_source_version_id IS NOT NULL/u);
  assert.match(route, /repairAuthority: "read_only_detection_only"/u);
  assert.match(route, /autoRepairAttempted: false/u);
});

test("Drizzle 0016 and runtime bootstrap describe the same four additive tables", () => {
  const tables = ["article_identities", "article_identity_members", "article_lineage_links", "article_identity_operations"];
  for (const table of tables) {
    assert.match(schema, new RegExp(`"${table}"`, "u"));
    assert.match(route, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`, "u"));
    assert.ok(migration.includes(`CREATE TABLE \`${table}\``), `迁移缺少 ${table}`);
  }
  const identityMigration = journal.entries.find((entry) => entry.tag === "0016_small_scorpion");
  assert.ok(identityMigration, "迁移日志必须保留 article identity 的 0016 记录");
  assert.equal(identityMigration.idx, 16);
});
