CREATE TABLE `package_composition_materializations` (
	`id` text PRIMARY KEY NOT NULL,
	`package_id` text NOT NULL,
	`branch_id` text NOT NULL,
	`composition_id` text NOT NULL,
	`composition_sha256` text NOT NULL,
	`article_revision_id` text NOT NULL,
	`article_body_sha256` text NOT NULL,
	`renderer_key` text DEFAULT 'wenmai.package-markdown' NOT NULL,
	`renderer_version` text DEFAULT '1' NOT NULL,
	`created_by_kind` text NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT "package_composition_materializations_author_check" CHECK("package_composition_materializations"."created_by_kind" IN ('user','agent','import','system'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_package_materializations_branch_composition` ON `package_composition_materializations` (`branch_id`,`composition_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_package_materializations_revision` ON `package_composition_materializations` (`article_revision_id`);--> statement-breakpoint
CREATE INDEX `idx_package_materializations_package_created` ON `package_composition_materializations` (`package_id`,`created_at`);--> statement-breakpoint
ALTER TABLE `agent_context_snapshots` ADD `package_id` text;--> statement-breakpoint
ALTER TABLE `agent_context_snapshots` ADD `composition_id` text;--> statement-breakpoint
ALTER TABLE `agent_context_snapshots` ADD `composition_sha256` text;--> statement-breakpoint
ALTER TABLE `agent_context_snapshots` ADD `package_document_sha256` text;--> statement-breakpoint
ALTER TABLE `agent_context_snapshots` ADD `package_lock_version` integer;--> statement-breakpoint
ALTER TABLE `agent_context_snapshots` ADD `branch_head_revision_id` text;--> statement-breakpoint
ALTER TABLE `agent_context_snapshots` ADD `module_graph_sha256` text;--> statement-breakpoint
ALTER TABLE `agent_context_snapshots` ADD `diagnosis_summary_sha256` text;--> statement-breakpoint
CREATE INDEX `idx_agent_context_package_composition` ON `agent_context_snapshots` (`package_id`,`composition_id`);--> statement-breakpoint
ALTER TABLE `agent_tasks` ADD `package_id` text;--> statement-breakpoint
ALTER TABLE `agent_tasks` ADD `base_composition_id` text;--> statement-breakpoint
ALTER TABLE `agent_tasks` ADD `base_composition_sha256` text;--> statement-breakpoint
CREATE INDEX `idx_agent_tasks_package_state` ON `agent_tasks` (`package_id`,`state`,`updated_at`);--> statement-breakpoint
ALTER TABLE `article_project_packages` ADD `primary_branch_id` text;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_article_project_packages_primary_branch` ON `article_project_packages` (`primary_branch_id`) WHERE "article_project_packages"."primary_branch_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE `package_patch_proposals` ADD `branch_id` text;--> statement-breakpoint
ALTER TABLE `package_patch_proposals` ADD `base_revision_id` text;--> statement-breakpoint
ALTER TABLE `package_patch_proposals` ADD `base_package_lock_version` integer;--> statement-breakpoint
ALTER TABLE `package_working_copies` ADD `branch_id` text;--> statement-breakpoint
ALTER TABLE `package_working_copies` ADD `base_revision_id` text;