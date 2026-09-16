CREATE TABLE `article_project_packages` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text,
	`article_id` text NOT NULL,
	`title` text NOT NULL,
	`schema_version` text DEFAULT 'wenmai-package-v1' NOT NULL,
	`main_composition_id` text NOT NULL,
	`main_composition_sha256` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`lock_version` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "article_project_packages_status_check" CHECK("article_project_packages"."status" IN ('active','archived'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_article_project_packages_article` ON `article_project_packages` (`article_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_article_project_packages_project` ON `article_project_packages` (`project_id`) WHERE "article_project_packages"."project_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_article_project_packages_status_updated` ON `article_project_packages` (`status`,`updated_at`);--> statement-breakpoint
CREATE TABLE `package_assets` (
	`id` text PRIMARY KEY NOT NULL,
	`package_id` text NOT NULL,
	`asset_key` text NOT NULL,
	`kind` text NOT NULL,
	`title` text NOT NULL,
	`content_ref` text NOT NULL,
	`media_type` text NOT NULL,
	`sha256` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`metadata_json` text DEFAULT '{}' NOT NULL,
	`rights_json` text DEFAULT '{}' NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_package_assets_package_key` ON `package_assets` (`package_id`,`asset_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_package_assets_package_sha` ON `package_assets` (`package_id`,`sha256`);--> statement-breakpoint
CREATE TABLE `package_composition_edges` (
	`id` text PRIMARY KEY NOT NULL,
	`package_id` text NOT NULL,
	`composition_id` text NOT NULL,
	`edge_key` text NOT NULL,
	`source_node_id` text NOT NULL,
	`target_node_id` text NOT NULL,
	`relation_type` text NOT NULL,
	`ordinal` integer DEFAULT 0 NOT NULL,
	`condition_json` text DEFAULT '{}' NOT NULL,
	`edge_sha256` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_package_composition_edges_key` ON `package_composition_edges` (`composition_id`,`edge_key`);--> statement-breakpoint
CREATE INDEX `idx_package_composition_edges_source` ON `package_composition_edges` (`composition_id`,`source_node_id`,`ordinal`);--> statement-breakpoint
CREATE INDEX `idx_package_composition_edges_target` ON `package_composition_edges` (`composition_id`,`target_node_id`);--> statement-breakpoint
CREATE TABLE `package_composition_nodes` (
	`id` text PRIMARY KEY NOT NULL,
	`package_id` text NOT NULL,
	`composition_id` text NOT NULL,
	`module_id` text NOT NULL,
	`module_revision_id` text NOT NULL,
	`node_key` text NOT NULL,
	`slot` text DEFAULT 'body' NOT NULL,
	`ordinal` integer DEFAULT 0 NOT NULL,
	`required` integer DEFAULT true NOT NULL,
	`config_json` text DEFAULT '{}' NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_package_composition_nodes_key` ON `package_composition_nodes` (`composition_id`,`node_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_package_composition_nodes_module` ON `package_composition_nodes` (`composition_id`,`module_id`);--> statement-breakpoint
CREATE INDEX `idx_package_composition_nodes_order` ON `package_composition_nodes` (`composition_id`,`slot`,`ordinal`);--> statement-breakpoint
CREATE TABLE `package_compositions` (
	`id` text PRIMARY KEY NOT NULL,
	`package_id` text NOT NULL,
	`parent_composition_id` text,
	`title` text NOT NULL,
	`schema_version` text DEFAULT 'wenmai-composition-v1' NOT NULL,
	`root_module_id` text NOT NULL,
	`document_json` text NOT NULL,
	`document_sha256` text NOT NULL,
	`manifest_json` text NOT NULL,
	`composition_sha256` text NOT NULL,
	`source_article_revision_id` text,
	`author_kind` text NOT NULL,
	`source_patch_id` text,
	`created_at` text NOT NULL,
	CONSTRAINT "package_compositions_author_check" CHECK("package_compositions"."author_kind" IN ('user','agent','import','system'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_package_compositions_package_sha` ON `package_compositions` (`package_id`,`composition_sha256`);--> statement-breakpoint
CREATE INDEX `idx_package_compositions_package_created` ON `package_compositions` (`package_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `package_diagnosis_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`package_id` text NOT NULL,
	`composition_id` text NOT NULL,
	`composition_sha256` text NOT NULL,
	`algorithm_version` text NOT NULL,
	`result` text NOT NULL,
	`issue_count` integer NOT NULL,
	`error_count` integer NOT NULL,
	`warning_count` integer NOT NULL,
	`input_sha256` text NOT NULL,
	`summary_sha256` text NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT "package_diagnosis_runs_result_check" CHECK("package_diagnosis_runs"."result" IN ('pass','fail','inconclusive'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_package_diagnosis_runs_input` ON `package_diagnosis_runs` (`package_id`,`input_sha256`);--> statement-breakpoint
CREATE INDEX `idx_package_diagnosis_runs_composition` ON `package_diagnosis_runs` (`composition_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `package_diagnostic_issues` (
	`id` text PRIMARY KEY NOT NULL,
	`diagnosis_run_id` text NOT NULL,
	`package_id` text NOT NULL,
	`composition_id` text NOT NULL,
	`module_id` text,
	`node_id` text,
	`edge_id` text,
	`code` text NOT NULL,
	`severity` text NOT NULL,
	`title` text NOT NULL,
	`message` text NOT NULL,
	`evidence_json` text DEFAULT '[]' NOT NULL,
	`suggested_patch_json` text DEFAULT '[]' NOT NULL,
	`issue_sha256` text NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT "package_diagnostic_issues_severity_check" CHECK("package_diagnostic_issues"."severity" IN ('error','warning','info'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_package_diagnostic_issues_run_sha` ON `package_diagnostic_issues` (`diagnosis_run_id`,`issue_sha256`);--> statement-breakpoint
CREATE INDEX `idx_package_diagnostic_issues_composition` ON `package_diagnostic_issues` (`composition_id`,`severity`);--> statement-breakpoint
CREATE TABLE `package_export_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`package_id` text NOT NULL,
	`composition_id` text NOT NULL,
	`composition_sha256` text NOT NULL,
	`slice_id` text,
	`slice_sha256` text,
	`export_kind` text NOT NULL,
	`exporter_key` text NOT NULL,
	`exporter_version` text NOT NULL,
	`manifest_json` text NOT NULL,
	`manifest_sha256` text NOT NULL,
	`artifact_ref` text DEFAULT '' NOT NULL,
	`artifact_sha256` text DEFAULT '' NOT NULL,
	`artifact_media_type` text DEFAULT 'application/json' NOT NULL,
	`state` text NOT NULL,
	`lock_version` integer DEFAULT 1 NOT NULL,
	`failure_summary` text DEFAULT '' NOT NULL,
	`created_at` text NOT NULL,
	`verified_at` text,
	CONSTRAINT "package_export_runs_state_check" CHECK("package_export_runs"."state" IN ('manifest_ready','verified','failed','cancelled'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_package_export_runs_manifest` ON `package_export_runs` (`package_id`,`manifest_sha256`);--> statement-breakpoint
CREATE INDEX `idx_package_export_runs_package_state` ON `package_export_runs` (`package_id`,`state`,`created_at`);--> statement-breakpoint
CREATE TABLE `package_import_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`package_id` text NOT NULL,
	`base_composition_id` text NOT NULL,
	`base_composition_sha256` text NOT NULL,
	`source_kind` text NOT NULL,
	`source_ref` text NOT NULL,
	`source_fingerprint_sha256` text NOT NULL,
	`importer_key` text NOT NULL,
	`importer_version` text NOT NULL,
	`manifest_json` text NOT NULL,
	`manifest_sha256` text NOT NULL,
	`patch_proposal_id` text NOT NULL,
	`state` text NOT NULL,
	`lock_version` integer DEFAULT 1 NOT NULL,
	`error_summary` text DEFAULT '' NOT NULL,
	`created_at` text NOT NULL,
	`finished_at` text,
	CONSTRAINT "package_import_runs_state_check" CHECK("package_import_runs"."state" IN ('candidate_ready','applied','failed','cancelled'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_package_import_runs_manifest` ON `package_import_runs` (`package_id`,`manifest_sha256`);--> statement-breakpoint
CREATE INDEX `idx_package_import_runs_package_state` ON `package_import_runs` (`package_id`,`state`,`created_at`);--> statement-breakpoint
CREATE TABLE `package_module_revision_refs` (
	`id` text PRIMARY KEY NOT NULL,
	`package_id` text NOT NULL,
	`module_revision_id` text NOT NULL,
	`ref_kind` text NOT NULL,
	`ref_id` text NOT NULL,
	`relation_type` text NOT NULL,
	`anchor_json` text DEFAULT '{}' NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT "package_module_revision_refs_kind_check" CHECK("package_module_revision_refs"."ref_kind" IN ('asset','source'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_package_module_revision_refs_unique` ON `package_module_revision_refs` (`module_revision_id`,`ref_kind`,`ref_id`,`relation_type`);--> statement-breakpoint
CREATE INDEX `idx_package_module_revision_refs_ref` ON `package_module_revision_refs` (`package_id`,`ref_kind`,`ref_id`);--> statement-breakpoint
CREATE TABLE `package_module_revisions` (
	`id` text PRIMARY KEY NOT NULL,
	`package_id` text NOT NULL,
	`module_id` text NOT NULL,
	`parent_revision_id` text,
	`title` text NOT NULL,
	`content_format` text NOT NULL,
	`content_text` text DEFAULT '' NOT NULL,
	`content_json` text DEFAULT '{}' NOT NULL,
	`content_sha256` text NOT NULL,
	`metadata_json` text DEFAULT '{}' NOT NULL,
	`revision_sha256` text NOT NULL,
	`author_kind` text NOT NULL,
	`source_patch_id` text,
	`created_at` text NOT NULL,
	CONSTRAINT "package_module_revisions_format_check" CHECK("package_module_revisions"."content_format" IN ('markdown','text','json')),
	CONSTRAINT "package_module_revisions_author_check" CHECK("package_module_revisions"."author_kind" IN ('user','agent','import','system'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_package_module_revisions_module_sha` ON `package_module_revisions` (`module_id`,`revision_sha256`);--> statement-breakpoint
CREATE INDEX `idx_package_module_revisions_package_created` ON `package_module_revisions` (`package_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `package_modules` (
	`id` text PRIMARY KEY NOT NULL,
	`package_id` text NOT NULL,
	`module_key` text NOT NULL,
	`module_kind` text NOT NULL,
	`schema_key` text DEFAULT 'wenmai.module' NOT NULL,
	`schema_version` text DEFAULT '1' NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_package_modules_package_key` ON `package_modules` (`package_id`,`module_key`);--> statement-breakpoint
CREATE INDEX `idx_package_modules_package_kind` ON `package_modules` (`package_id`,`module_kind`);--> statement-breakpoint
CREATE TABLE `package_patch_proposals` (
	`id` text PRIMARY KEY NOT NULL,
	`package_id` text NOT NULL,
	`base_composition_id` text NOT NULL,
	`base_composition_sha256` text NOT NULL,
	`task_id` text,
	`attempt_id` text,
	`context_sha256` text,
	`title` text NOT NULL,
	`summary` text DEFAULT '' NOT NULL,
	`operations_json` text NOT NULL,
	`patch_sha256` text NOT NULL,
	`evidence_json` text DEFAULT '[]' NOT NULL,
	`diagnostic_issue_ids_json` text DEFAULT '[]' NOT NULL,
	`status` text DEFAULT 'candidate' NOT NULL,
	`lock_version` integer DEFAULT 1 NOT NULL,
	`created_by_kind` text NOT NULL,
	`created_by_id` text NOT NULL,
	`decision_note` text DEFAULT '' NOT NULL,
	`applied_composition_id` text,
	`created_at` text NOT NULL,
	`reviewed_at` text,
	`applied_at` text,
	CONSTRAINT "package_patch_proposals_status_check" CHECK("package_patch_proposals"."status" IN ('candidate','approved','rejected','applied','stale','cancelled')),
	CONSTRAINT "package_patch_proposals_creator_check" CHECK("package_patch_proposals"."created_by_kind" IN ('user','agent','import','diagnostic'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_package_patch_proposals_package_sha` ON `package_patch_proposals` (`package_id`,`patch_sha256`);--> statement-breakpoint
CREATE INDEX `idx_package_patch_proposals_package_status` ON `package_patch_proposals` (`package_id`,`status`,`created_at`);--> statement-breakpoint
CREATE TABLE `package_slices` (
	`id` text PRIMARY KEY NOT NULL,
	`package_id` text NOT NULL,
	`composition_id` text NOT NULL,
	`composition_sha256` text NOT NULL,
	`title` text NOT NULL,
	`slice_kind` text NOT NULL,
	`selector_json` text DEFAULT '{}' NOT NULL,
	`resolved_manifest_json` text NOT NULL,
	`slice_sha256` text NOT NULL,
	`created_by_kind` text NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT "package_slices_kind_check" CHECK("package_slices"."slice_kind" IN ('full','demo','excerpt','promo','custom'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_package_slices_composition_sha` ON `package_slices` (`composition_id`,`slice_sha256`);--> statement-breakpoint
CREATE INDEX `idx_package_slices_package_created` ON `package_slices` (`package_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `package_source_refs` (
	`id` text PRIMARY KEY NOT NULL,
	`package_id` text NOT NULL,
	`source_key` text NOT NULL,
	`source_kind` text NOT NULL,
	`canonical_ref` text NOT NULL,
	`title` text NOT NULL,
	`captured_at` text,
	`content_sha256` text,
	`excerpt` text DEFAULT '' NOT NULL,
	`metadata_json` text DEFAULT '{}' NOT NULL,
	`rights_json` text DEFAULT '{}' NOT NULL,
	`ref_sha256` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_package_sources_package_key` ON `package_source_refs` (`package_id`,`source_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_package_sources_package_sha` ON `package_source_refs` (`package_id`,`ref_sha256`);--> statement-breakpoint
CREATE TABLE `package_working_copies` (
	`package_id` text PRIMARY KEY NOT NULL,
	`base_composition_id` text NOT NULL,
	`document_json` text NOT NULL,
	`document_sha256` text NOT NULL,
	`dirty` integer DEFAULT false NOT NULL,
	`lock_version` integer DEFAULT 1 NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_package_working_copies_updated` ON `package_working_copies` (`updated_at`);