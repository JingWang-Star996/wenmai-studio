CREATE TABLE `article_branches` (
	`id` text PRIMARY KEY NOT NULL,
	`article_id` text NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`color` text DEFAULT 'blue' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`base_source_version_id` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_article_branches_article_slug` ON `article_branches` (`article_id`,`slug`);--> statement-breakpoint
CREATE INDEX `idx_article_branches_article_status` ON `article_branches` (`article_id`,`status`);--> statement-breakpoint
CREATE TABLE `article_revisions` (
	`id` text PRIMARY KEY NOT NULL,
	`article_id` text NOT NULL,
	`branch_id` text NOT NULL,
	`sequence` integer NOT NULL,
	`parent_revision_id` text,
	`merge_parent_revision_id` text,
	`source_version_id` text,
	`title` text NOT NULL,
	`document_title` text NOT NULL,
	`annotation` text DEFAULT '' NOT NULL,
	`body_text` text NOT NULL,
	`body_sha256` text NOT NULL,
	`author_kind` text DEFAULT 'user' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_article_revisions_branch_sequence` ON `article_revisions` (`branch_id`,`sequence`);--> statement-breakpoint
CREATE INDEX `idx_article_revisions_article_created` ON `article_revisions` (`article_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_article_revisions_branch_created` ON `article_revisions` (`branch_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `branch_working_copies` (
	`branch_id` text PRIMARY KEY NOT NULL,
	`article_id` text NOT NULL,
	`base_revision_id` text NOT NULL,
	`title` text NOT NULL,
	`annotation` text DEFAULT '' NOT NULL,
	`body_text` text NOT NULL,
	`body_sha256` text NOT NULL,
	`dirty` integer DEFAULT false NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_branch_working_copies_article` ON `branch_working_copies` (`article_id`,`updated_at`);--> statement-breakpoint
CREATE TABLE `capability_overrides` (
	`capability_id` text PRIMARY KEY NOT NULL,
	`adoption_status` text DEFAULT 'unassessed' NOT NULL,
	`notes` text DEFAULT '' NOT NULL,
	`evidence_ref` text DEFAULT '' NOT NULL,
	`regression_ref` text DEFAULT '' NOT NULL,
	`favorite` integer DEFAULT false NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE `gate_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`run_group_id` text NOT NULL,
	`article_id` text NOT NULL,
	`branch_id` text NOT NULL,
	`revision_id` text,
	`gate_id` text NOT NULL,
	`gate_label` text NOT NULL,
	`result` text NOT NULL,
	`input_sha256` text NOT NULL,
	`evidence_json` text DEFAULT '[]' NOT NULL,
	`details_json` text DEFAULT '{}' NOT NULL,
	`started_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`completed_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_gate_runs_article_completed` ON `gate_runs` (`article_id`,`completed_at`);--> statement-breakpoint
CREATE INDEX `idx_gate_runs_branch_completed` ON `gate_runs` (`branch_id`,`completed_at`);--> statement-breakpoint
CREATE INDEX `idx_gate_runs_group` ON `gate_runs` (`run_group_id`);--> statement-breakpoint
CREATE TABLE `production_run_steps` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`step_id` text NOT NULL,
	`position` integer NOT NULL,
	`title` text NOT NULL,
	`actor_kind` text NOT NULL,
	`capability_id` text,
	`gate_id` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`evidence_json` text DEFAULT '[]' NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_production_run_steps_run_step` ON `production_run_steps` (`run_id`,`step_id`);--> statement-breakpoint
CREATE INDEX `idx_production_run_steps_run_position` ON `production_run_steps` (`run_id`,`position`);--> statement-breakpoint
CREATE TABLE `production_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`recipe_id` text NOT NULL,
	`article_id` text NOT NULL,
	`branch_id` text NOT NULL,
	`title` text NOT NULL,
	`status` text DEFAULT 'planned' NOT NULL,
	`current_step_id` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_production_runs_article_status` ON `production_runs` (`article_id`,`status`);--> statement-breakpoint
CREATE TABLE `work_items` (
	`id` text PRIMARY KEY NOT NULL,
	`article_id` text,
	`branch_id` text,
	`title` text NOT NULL,
	`kind` text DEFAULT 'article' NOT NULL,
	`stage` text DEFAULT 'inbox' NOT NULL,
	`state` text DEFAULT 'open' NOT NULL,
	`priority` text DEFAULT 'P2' NOT NULL,
	`owner` text DEFAULT '我' NOT NULL,
	`next_action` text DEFAULT '' NOT NULL,
	`blocker` text DEFAULT '' NOT NULL,
	`source_capability_id` text,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_work_items_stage_state_order` ON `work_items` (`stage`,`state`,`sort_order`);--> statement-breakpoint
CREATE INDEX `idx_work_items_article_updated` ON `work_items` (`article_id`,`updated_at`);--> statement-breakpoint
CREATE TABLE `workspace_events` (
	`id` text PRIMARY KEY NOT NULL,
	`event_type` text NOT NULL,
	`subject_type` text NOT NULL,
	`subject_id` text NOT NULL,
	`article_id` text,
	`payload_json` text DEFAULT '{}' NOT NULL,
	`input_sha256` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_workspace_events_article_created` ON `workspace_events` (`article_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_workspace_events_subject_created` ON `workspace_events` (`subject_type`,`subject_id`,`created_at`);