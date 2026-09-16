CREATE TABLE `package_branch_composition_commits` (
	`id` text PRIMARY KEY NOT NULL,
	`package_id` text NOT NULL,
	`branch_id` text NOT NULL,
	`parent_composition_id` text,
	`composition_id` text NOT NULL,
	`composition_sha256` text NOT NULL,
	`previous_revision_id` text,
	`article_revision_id` text NOT NULL,
	`source_kind` text NOT NULL,
	`source_patch_id` text,
	`created_by_kind` text NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT "package_branch_commits_source_check" CHECK("package_branch_composition_commits"."source_kind" IN ('attach','commit','patch','import','system')),
	CONSTRAINT "package_branch_commits_author_check" CHECK("package_branch_composition_commits"."created_by_kind" IN ('user','agent','import','system'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_package_branch_commits_revision` ON `package_branch_composition_commits` (`branch_id`,`article_revision_id`);--> statement-breakpoint
CREATE INDEX `idx_package_branch_commits_history` ON `package_branch_composition_commits` (`package_id`,`branch_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `package_branch_migration_audits` (
	`package_id` text PRIMARY KEY NOT NULL,
	`state` text NOT NULL,
	`reason_code` text DEFAULT '' NOT NULL,
	`detail_json` text DEFAULT '{}' NOT NULL,
	`source_schema_version` text DEFAULT '0009' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "package_branch_migration_audits_state_check" CHECK("package_branch_migration_audits"."state" IN ('legacy_unbound','migrated_clean','migrated_dirty','blocked'))
);
--> statement-breakpoint
CREATE INDEX `idx_package_branch_migration_audits_state` ON `package_branch_migration_audits` (`state`,`updated_at`);--> statement-breakpoint
CREATE TABLE `package_branch_states` (
	`package_id` text NOT NULL,
	`branch_id` text NOT NULL,
	`head_composition_id` text NOT NULL,
	`head_composition_sha256` text NOT NULL,
	`head_revision_id` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`lock_version` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`package_id`, `branch_id`),
	CONSTRAINT "package_branch_states_status_check" CHECK("package_branch_states"."status" IN ('active','archived'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_package_branch_states_branch` ON `package_branch_states` (`branch_id`);--> statement-breakpoint
CREATE INDEX `idx_package_branch_states_package_status` ON `package_branch_states` (`package_id`,`status`,`updated_at`);--> statement-breakpoint
CREATE TABLE `package_branch_working_copies` (
	`package_id` text NOT NULL,
	`branch_id` text NOT NULL,
	`base_composition_id` text NOT NULL,
	`base_revision_id` text NOT NULL,
	`document_json` text NOT NULL,
	`document_sha256` text NOT NULL,
	`dirty` integer DEFAULT false NOT NULL,
	`lock_version` integer DEFAULT 1 NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`package_id`, `branch_id`)
);
--> statement-breakpoint
CREATE INDEX `idx_package_branch_working_dirty` ON `package_branch_working_copies` (`package_id`,`dirty`,`updated_at`);--> statement-breakpoint
DROP INDEX `idx_package_materializations_branch_composition`;--> statement-breakpoint
CREATE INDEX `idx_package_materializations_branch_composition` ON `package_composition_materializations` (`branch_id`,`composition_id`,`created_at`);--> statement-breakpoint
ALTER TABLE `agent_context_snapshots` ADD `branch_state_lock_version` integer;--> statement-breakpoint
ALTER TABLE `agent_tasks` ADD `base_revision_id` text;--> statement-breakpoint
ALTER TABLE `agent_tasks` ADD `base_branch_lock_version` integer;--> statement-breakpoint
ALTER TABLE `article_project_packages` ADD `branch_model_version` integer;--> statement-breakpoint
ALTER TABLE `package_diagnosis_runs` ADD `branch_id` text;--> statement-breakpoint
ALTER TABLE `package_diagnosis_runs` ADD `base_revision_id` text;--> statement-breakpoint
ALTER TABLE `package_diagnosis_runs` ADD `base_branch_lock_version` integer;--> statement-breakpoint
CREATE INDEX `idx_package_diagnosis_runs_branch_created` ON `package_diagnosis_runs` (`package_id`,`branch_id`,`created_at`);--> statement-breakpoint
ALTER TABLE `package_diagnostic_issues` ADD `branch_id` text;--> statement-breakpoint
CREATE INDEX `idx_package_diagnostic_issues_branch` ON `package_diagnostic_issues` (`package_id`,`branch_id`,`created_at`);--> statement-breakpoint
ALTER TABLE `package_export_runs` ADD `branch_id` text;--> statement-breakpoint
ALTER TABLE `package_export_runs` ADD `base_revision_id` text;--> statement-breakpoint
ALTER TABLE `package_export_runs` ADD `base_branch_lock_version` integer;--> statement-breakpoint
CREATE INDEX `idx_package_export_runs_branch_state` ON `package_export_runs` (`package_id`,`branch_id`,`state`,`created_at`);--> statement-breakpoint
ALTER TABLE `package_import_runs` ADD `branch_id` text;--> statement-breakpoint
ALTER TABLE `package_import_runs` ADD `base_revision_id` text;--> statement-breakpoint
ALTER TABLE `package_import_runs` ADD `base_branch_lock_version` integer;--> statement-breakpoint
CREATE INDEX `idx_package_import_runs_branch_state` ON `package_import_runs` (`package_id`,`branch_id`,`state`,`created_at`);--> statement-breakpoint
ALTER TABLE `package_patch_proposals` ADD `base_branch_lock_version` integer;--> statement-breakpoint
CREATE INDEX `idx_package_patch_proposals_branch_status` ON `package_patch_proposals` (`package_id`,`branch_id`,`status`,`created_at`);--> statement-breakpoint
ALTER TABLE `package_slices` ADD `branch_id` text;--> statement-breakpoint
ALTER TABLE `package_slices` ADD `base_revision_id` text;--> statement-breakpoint
ALTER TABLE `package_slices` ADD `base_branch_lock_version` integer;--> statement-breakpoint
CREATE INDEX `idx_package_slices_branch_created` ON `package_slices` (`package_id`,`branch_id`,`created_at`);
--> statement-breakpoint
INSERT INTO `package_branch_migration_audits`
  (`package_id`,`state`,`reason_code`,`detail_json`,`source_schema_version`,`created_at`,`updated_at`)
SELECT package.id,
  CASE
    WHEN package.primary_branch_id IS NULL THEN 'legacy_unbound'
    WHEN composition.id IS NOT NULL
      AND legacy_copy.package_id IS NOT NULL
      AND legacy_copy.branch_id = package.primary_branch_id
      AND legacy_copy.base_composition_id = package.main_composition_id
      AND legacy_copy.base_revision_id = branch.head_revision_id
      AND branch.id IS NOT NULL AND branch.article_id = package.article_id
      AND revision.id IS NOT NULL AND revision.branch_id = branch.id AND revision.article_id = package.article_id
      AND article_copy.branch_id IS NOT NULL AND article_copy.base_revision_id = branch.head_revision_id AND article_copy.dirty = 0
      AND materialization.id IS NOT NULL
      AND materialization.composition_sha256 = package.main_composition_sha256
      AND materialization.article_revision_id = branch.head_revision_id
      AND materialization.article_body_sha256 = revision.body_sha256
      AND ((legacy_copy.dirty = 0 AND legacy_copy.document_sha256 = composition.document_sha256)
        OR (legacy_copy.dirty = 1 AND legacy_copy.document_sha256 <> composition.document_sha256))
    THEN CASE WHEN legacy_copy.dirty = 1 THEN 'migrated_dirty' ELSE 'migrated_clean' END
    ELSE 'blocked'
  END,
  CASE
    WHEN package.primary_branch_id IS NULL THEN 'PRIMARY_BRANCH_MISSING'
    WHEN composition.id IS NULL THEN 'MAIN_COMPOSITION_INVALID'
    WHEN legacy_copy.package_id IS NULL THEN 'LEGACY_PACKAGE_WORKING_COPY_MISSING'
    WHEN legacy_copy.branch_id IS NULL OR legacy_copy.branch_id <> package.primary_branch_id THEN 'LEGACY_PACKAGE_WORKING_BRANCH_MISMATCH'
    WHEN branch.id IS NULL OR branch.article_id <> package.article_id THEN 'ARTICLE_BRANCH_INVALID'
    WHEN revision.id IS NULL OR revision.branch_id <> branch.id OR revision.article_id <> package.article_id THEN 'ARTICLE_HEAD_REVISION_INVALID'
    WHEN legacy_copy.base_composition_id <> package.main_composition_id OR legacy_copy.base_revision_id <> branch.head_revision_id THEN 'LEGACY_PACKAGE_BASE_MISMATCH'
    WHEN article_copy.branch_id IS NULL OR article_copy.base_revision_id <> branch.head_revision_id OR article_copy.dirty <> 0 THEN 'ARTICLE_WORKING_COPY_NOT_CLEAN_HEAD'
    WHEN materialization.id IS NULL OR materialization.composition_sha256 <> package.main_composition_sha256
      OR materialization.article_revision_id <> branch.head_revision_id OR materialization.article_body_sha256 <> revision.body_sha256
      THEN 'MATERIALIZATION_INVALID'
    WHEN legacy_copy.dirty = 0 AND legacy_copy.document_sha256 <> composition.document_sha256 THEN 'CLEAN_DOCUMENT_SHA_MISMATCH'
    WHEN legacy_copy.dirty = 1 AND legacy_copy.document_sha256 = composition.document_sha256 THEN 'DIRTY_DOCUMENT_SHA_UNCHANGED'
    ELSE ''
  END,
  json_object(
    'primaryBranchId', package.primary_branch_id,
    'mainCompositionId', package.main_composition_id,
    'branchHeadRevisionId', branch.head_revision_id,
    'packageBaseCompositionId', legacy_copy.base_composition_id,
    'packageBaseRevisionId', legacy_copy.base_revision_id,
    'packageWorkingDirty', legacy_copy.dirty,
    'packageWorkingLockVersion', legacy_copy.lock_version,
    'articleWorkingBaseRevisionId', article_copy.base_revision_id,
    'articleWorkingDirty', article_copy.dirty,
    'materializationId', materialization.id
  ),
  '0009', package.updated_at, package.updated_at
FROM article_project_packages package
LEFT JOIN package_compositions composition
  ON composition.id = package.main_composition_id AND composition.package_id = package.id
  AND composition.composition_sha256 = package.main_composition_sha256
LEFT JOIN package_working_copies legacy_copy ON legacy_copy.package_id = package.id
LEFT JOIN article_branches branch ON branch.id = package.primary_branch_id
LEFT JOIN article_revisions revision ON revision.id = branch.head_revision_id
LEFT JOIN branch_working_copies article_copy ON article_copy.branch_id = branch.id
LEFT JOIN package_composition_materializations materialization
  ON materialization.package_id = package.id AND materialization.branch_id = branch.id
  AND materialization.composition_id = package.main_composition_id
  AND materialization.article_revision_id = branch.head_revision_id
WHERE 1 = 1
ON CONFLICT(package_id) DO NOTHING;
--> statement-breakpoint
INSERT OR IGNORE INTO `package_branch_states`
  (`package_id`,`branch_id`,`head_composition_id`,`head_composition_sha256`,`head_revision_id`,`status`,`lock_version`,`created_at`,`updated_at`)
SELECT package.id, package.primary_branch_id, package.main_composition_id, package.main_composition_sha256,
  branch.head_revision_id, CASE WHEN branch.status = 'archived' THEN 'archived' ELSE 'active' END,
  1, package.created_at, package.updated_at
FROM article_project_packages package
JOIN package_branch_migration_audits audit ON audit.package_id = package.id AND audit.state IN ('migrated_clean','migrated_dirty')
JOIN article_branches branch ON branch.id = package.primary_branch_id;
--> statement-breakpoint
INSERT OR IGNORE INTO `package_branch_working_copies`
  (`package_id`,`branch_id`,`base_composition_id`,`base_revision_id`,`document_json`,`document_sha256`,`dirty`,`lock_version`,`updated_at`)
SELECT package.id, package.primary_branch_id, legacy_copy.base_composition_id, legacy_copy.base_revision_id,
  legacy_copy.document_json, legacy_copy.document_sha256, legacy_copy.dirty, legacy_copy.lock_version, legacy_copy.updated_at
FROM article_project_packages package
JOIN package_branch_migration_audits audit ON audit.package_id = package.id AND audit.state IN ('migrated_clean','migrated_dirty')
JOIN package_working_copies legacy_copy ON legacy_copy.package_id = package.id;
--> statement-breakpoint
INSERT OR IGNORE INTO `package_branch_composition_commits`
  (`id`,`package_id`,`branch_id`,`parent_composition_id`,`composition_id`,`composition_sha256`,`previous_revision_id`,
   `article_revision_id`,`source_kind`,`source_patch_id`,`created_by_kind`,`created_at`)
SELECT 'branch-commit-legacy-' || replace(package.id, 'pkg-', ''), package.id, package.primary_branch_id,
  composition.parent_composition_id, package.main_composition_id, package.main_composition_sha256,
  revision.parent_revision_id, branch.head_revision_id, 'system', NULL, 'system', package.updated_at
FROM article_project_packages package
JOIN package_branch_migration_audits audit ON audit.package_id = package.id AND audit.state IN ('migrated_clean','migrated_dirty')
JOIN package_compositions composition ON composition.id = package.main_composition_id AND composition.package_id = package.id
JOIN article_branches branch ON branch.id = package.primary_branch_id
JOIN article_revisions revision ON revision.id = branch.head_revision_id;
--> statement-breakpoint
UPDATE article_project_packages SET branch_model_version = 2
WHERE EXISTS (
  SELECT 1 FROM package_branch_migration_audits audit
  JOIN package_branch_states state ON state.package_id = audit.package_id
  JOIN package_branch_working_copies copy ON copy.package_id = state.package_id AND copy.branch_id = state.branch_id
  JOIN package_branch_composition_commits commit_ref
    ON commit_ref.package_id = state.package_id AND commit_ref.branch_id = state.branch_id
    AND commit_ref.composition_id = state.head_composition_id AND commit_ref.article_revision_id = state.head_revision_id
  WHERE audit.package_id = article_project_packages.id AND audit.state IN ('migrated_clean','migrated_dirty')
);
