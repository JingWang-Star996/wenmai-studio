import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  ARTICLE_PUBLICATION_PLATFORMS,
  ARTICLE_PUBLICATION_TARGET_PROFILE_KEYS,
  ARTICLE_PUBLICATION_VERSION_SCHEMA_VERSION,
  publicationVersionFromDocument,
  validateArticlePublicationVersion,
  validateArticlePublicationVersionSet,
} from "../app/article-publication-version.ts";

const route = readFileSync(new URL("../app/api/project-package/v1/route.ts", import.meta.url), "utf8");
const workspaceRoute = readFileSync(new URL("../app/api/workspace/route.ts", import.meta.url), "utf8");
const migration = readFileSync(new URL("../drizzle/0018_publication_build_binding.sql", import.meta.url), "utf8");
const journal = JSON.parse(readFileSync(new URL("../drizzle/meta/_journal.json", import.meta.url), "utf8"));
const snapshot = JSON.parse(readFileSync(new URL("../drizzle/meta/0018_snapshot.json", import.meta.url), "utf8"));

const sha = (character) => character.repeat(64);
const canonicalIdentity = {
  branchId: "branch-canonical",
  revisionId: "revision-canonical",
  bodySha256: sha("a"),
  compositionId: "composition-canonical",
  compositionSha256: sha("b"),
};

function canonicalVersion() {
  return {
    schemaVersion: ARTICLE_PUBLICATION_VERSION_SCHEMA_VERSION,
    role: "canonical_baseline",
    versionKey: "canonical",
    platform: null,
    targetProfile: null,
    baseline: null,
  };
}

function platformVersion(platform) {
  return {
    schemaVersion: ARTICLE_PUBLICATION_VERSION_SCHEMA_VERSION,
    role: "platform_variant",
    versionKey: platform,
    platform,
    targetProfile: {
      id: `target-${platform}-article-current`,
      profileKey: ARTICLE_PUBLICATION_TARGET_PROFILE_KEYS[platform],
      sha256: sha(platform === "maimai" ? "c" : platform === "xiaohongshu" ? "d" : platform === "zhihu" ? "e" : "f"),
    },
    baseline: canonicalIdentity,
  };
}

function snapshotInput(version, index = 0) {
  if (version.role === "canonical_baseline") {
    return { ...canonicalIdentity, publicationVersion: version };
  }
  return {
    branchId: `branch-${version.platform}`,
    revisionId: `revision-${version.platform}`,
    bodySha256: sha(String(index + 1)),
    compositionId: `composition-${version.platform}`,
    compositionSha256: sha(String(index + 5)),
    publicationVersion: version,
  };
}

test("canonical 与四个平台 PublicationVersion 都有严格的一等身份合同", () => {
  const canonical = validateArticlePublicationVersion(canonicalVersion());
  assert.equal(canonical.valid, true);
  assert.equal(canonical.version?.versionKey, "canonical");

  for (const platform of ARTICLE_PUBLICATION_PLATFORMS) {
    const result = validateArticlePublicationVersion(platformVersion(platform));
    assert.equal(result.valid, true, result.errors.join("\n"));
    assert.equal(result.version?.versionKey, platform);
    assert.equal(result.version?.targetProfile.profileKey, ARTICLE_PUBLICATION_TARGET_PROFILE_KEYS[platform]);
  }

  const embedded = publicationVersionFromDocument({
    metadata: { publicationVersion: platformVersion("zhihu") },
  });
  assert.equal(embedded.valid, true);
  assert.equal(embedded.version?.versionKey, "zhihu");
});

test("validator 拒绝角色错配、平台错配、Target 错配和非 hash-bound baseline", () => {
  const malformedCanonical = { ...canonicalVersion(), platform: "maimai" };
  assert.equal(validateArticlePublicationVersion(malformedCanonical).valid, false);

  const wrongPlatform = { ...platformVersion("maimai"), versionKey: "zhihu" };
  assert.equal(validateArticlePublicationVersion(wrongPlatform).valid, false);

  const wrongTarget = {
    ...platformVersion("xiaohongshu"),
    targetProfile: { ...platformVersion("xiaohongshu").targetProfile, profileKey: "xiaohongshu.video" },
  };
  assert.equal(validateArticlePublicationVersion(wrongTarget).valid, false);

  const unbound = {
    ...platformVersion("bilibili"),
    baseline: { ...canonicalIdentity, bodySha256: "not-a-sha" },
  };
  assert.equal(validateArticlePublicationVersion(unbound).valid, false);
});

test("集合允许渐进注册，但只有 canonical 加四平台齐全且同源才 complete", () => {
  const canonical = snapshotInput(canonicalVersion());
  const partial = validateArticlePublicationVersionSet([canonical]);
  assert.equal(partial.valid, true);
  assert.equal(partial.complete, false);
  assert.deepEqual(partial.missingVersionKeys, [...ARTICLE_PUBLICATION_PLATFORMS]);

  const full = validateArticlePublicationVersionSet([
    canonical,
    ...ARTICLE_PUBLICATION_PLATFORMS.map((platform, index) => snapshotInput(platformVersion(platform), index)),
  ]);
  assert.equal(full.valid, true, full.errors.join("\n"));
  assert.equal(full.complete, true);
  assert.deepEqual(full.missingVersionKeys, []);

  const staleZhihu = platformVersion("zhihu");
  staleZhihu.baseline = { ...staleZhihu.baseline, compositionSha256: sha("0") };
  const stale = validateArticlePublicationVersionSet([canonical, snapshotInput(staleZhihu, 2)]);
  assert.equal(stale.valid, false);
  assert.match(stale.errors.join("\n"), /未绑定当前 canonical baseline/u);
});

test("注册 API 以 Composition metadata 为身份源，并用 current registry 与 Target 双 CAS", () => {
  assert.match(route, /"publication_versions"/u);
  assert.match(route, /"register_publication_version"/u);
  assert.match(route, /publicationVersionFromDocument/u);
  assert.match(route, /PUBLICATION_VERSION_NOT_BOUND_TO_COMPOSITION/u);
  assert.match(route, /expectedActiveRegistrationId/u);
  assert.match(route, /expectedActiveRegistrationLockVersion/u);
  assert.match(route, /SET state = 'superseded',[\s\S]*lock_version = lock_version \+ 1/u);
  assert.match(route, /PUBLICATION_TARGET_STALE/u);
  assert.match(route, /lifecycle_platform_targets target[\s\S]*target\.profile_sha256 = \?/u);
  assert.match(
    route,
    /article_publication_versions canonical[\s\S]*canonical\.state = 'active'[\s\S]*root\.main_composition_sha256 = canonical\.composition_sha256/u,
  );
  assert.match(route, /package\.publication_version_registered/u);
  assert.match(route, /missingVersionKeys/u);
  assert.match(route, /canonical_baseline_changed/u);
  assert.match(route, /target_profile_changed/u);
});

test("PublicationVersion 注册 INSERT 可由 fresh 0018 SQLite 实际编译", () => {
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
  const registrationInsert = route.match(
    /statements\.push\(db\.prepare\(`(INSERT INTO article_publication_versions[\s\S]*?)`\)\.bind\(/u,
  );
  assert.ok(registrationInsert, "missing PublicationVersion registration INSERT");
  assert.doesNotThrow(() => db.prepare(`EXPLAIN ${registrationInsert[1]}`));
  db.close();
});

test("D1 baseRevision 建分支复制本地首 Revision 并保留父链，不跨分支复用 head", () => {
  assert.match(workspaceRoute, /D1 文章请提供有效 baseRevisionId/u);
  assert.match(workspaceRoute, /parentRevisionId = String\(parent\.id\)/u);
  assert.match(workspaceRoute, /rootRevisionId = `revision-\$\{crypto\.randomUUID\(\)\}`/u);
  assert.match(workspaceRoute, /parent_revision_id, source_version_id/u);
  assert.match(workspaceRoute, /headRevisionId: rootRevisionId/u);
});

test("0018 migration、snapshot 与后继 journal 固化两个新增 registry", () => {
  const entry0018 = journal.entries.find((entry) => entry.tag === "0018_publication_build_binding");
  assert.equal(entry0018?.idx, 18);
  assert.equal(journal.entries[entry0018.idx + 1]?.tag, "0019_agent_permission_snapshot");
  assert.equal(journal.entries.at(-1)?.idx, 28);
  assert.equal(journal.entries.at(-1)?.tag, "0028_release_control_v2_dom_binding");
  assert.ok(snapshot.tables.article_publication_versions);
  assert.ok(snapshot.tables.lifecycle_build_input_bindings);
  assert.match(migration, /CREATE TABLE `article_publication_versions`/u);
  assert.match(migration, /idx_article_publication_versions_active_key/u);
  assert.match(migration, /idx_article_publication_versions_active_branch/u);
  assert.match(migration, /article_publication_versions_shape_check/u);
});
