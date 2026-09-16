CREATE TABLE `project_group_command_receipts` (
	`command_id` text PRIMARY KEY NOT NULL,
	`action` text NOT NULL,
	`actor_id` text NOT NULL,
	`request_sha256` text NOT NULL,
	`mutation_readback_json` text NOT NULL,
	`result_lock_version` integer NOT NULL,
	`topology_sha256` text NOT NULL,
	`status` text DEFAULT 'succeeded' NOT NULL,
	`status_code` integer NOT NULL,
	`created_at` text NOT NULL,
	`completed_at` text NOT NULL,
	CONSTRAINT "project_group_command_receipts_terminal_check" CHECK("project_group_command_receipts"."status" = 'succeeded'),
	CONSTRAINT "project_group_command_receipts_lock_version_check" CHECK("project_group_command_receipts"."result_lock_version" >= 1),
	CONSTRAINT "project_group_command_receipts_request_sha256_check" CHECK(length("project_group_command_receipts"."request_sha256") = 64 AND "project_group_command_receipts"."request_sha256" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "project_group_command_receipts_topology_sha256_check" CHECK(length("project_group_command_receipts"."topology_sha256") = 64 AND "project_group_command_receipts"."topology_sha256" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "project_group_command_receipts_status_code_check" CHECK("project_group_command_receipts"."status_code" > 0)
);
--> statement-breakpoint
CREATE INDEX `idx_project_group_command_receipts_actor_created` ON `project_group_command_receipts` (`actor_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `project_group_edges` (
	`id` text PRIMARY KEY NOT NULL,
	`group_id` text NOT NULL,
	`source_article_id` text NOT NULL,
	`target_article_id` text NOT NULL,
	`relation_type` text DEFAULT 'precedes' NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`group_id`) REFERENCES `project_groups`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`group_id`,`source_article_id`) REFERENCES `project_group_members`(`group_id`,`article_id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`group_id`,`target_article_id`) REFERENCES `project_group_members`(`group_id`,`article_id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "project_group_edges_relation_type_check" CHECK("project_group_edges"."relation_type" = 'precedes'),
	CONSTRAINT "project_group_edges_no_self_check" CHECK("project_group_edges"."source_article_id" <> "project_group_edges"."target_article_id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_project_group_edges_semantic` ON `project_group_edges` (`group_id`,`source_article_id`,`target_article_id`,`relation_type`);--> statement-breakpoint
CREATE INDEX `idx_project_group_edges_target` ON `project_group_edges` (`group_id`,`target_article_id`);--> statement-breakpoint
CREATE TABLE `project_group_events` (
	`id` text PRIMARY KEY NOT NULL,
	`group_id` text NOT NULL,
	`event_type` text NOT NULL,
	`actor_id` text NOT NULL,
	`command_id` text NOT NULL,
	`request_sha256` text NOT NULL,
	`before_lock_version` integer NOT NULL,
	`after_lock_version` integer NOT NULL,
	`result_topology_sha256` text NOT NULL,
	`details_json` text DEFAULT '{}' NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`group_id`) REFERENCES `project_groups`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "project_group_events_request_sha256_check" CHECK(length("project_group_events"."request_sha256") = 64 AND "project_group_events"."request_sha256" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "project_group_events_result_topology_sha256_check" CHECK(length("project_group_events"."result_topology_sha256") = 64 AND "project_group_events"."result_topology_sha256" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "project_group_events_lock_transition_check" CHECK("project_group_events"."after_lock_version" = "project_group_events"."before_lock_version" + 1)
);
--> statement-breakpoint
CREATE INDEX `idx_project_group_events_group_created` ON `project_group_events` (`group_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `project_group_members` (
	`id` text PRIMARY KEY NOT NULL,
	`group_id` text NOT NULL,
	`article_id` text NOT NULL,
	`article_project_id` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`group_id`) REFERENCES `project_groups`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`article_project_id`,`article_id`) REFERENCES `lifecycle_article_projects`(`id`,`article_id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_project_group_members_group_article` ON `project_group_members` (`group_id`,`article_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_project_group_members_group_article_project` ON `project_group_members` (`group_id`,`article_project_id`);--> statement-breakpoint
CREATE INDEX `idx_project_group_members_article` ON `project_group_members` (`article_id`,`group_id`);--> statement-breakpoint
CREATE TABLE `project_groups` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`topology_sha256` text NOT NULL,
	`lock_version` integer DEFAULT 1 NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`archived_at` text,
	CONSTRAINT "project_groups_status_check" CHECK("project_groups"."status" IN ('active','archived')),
	CONSTRAINT "project_groups_lock_version_check" CHECK("project_groups"."lock_version" >= 1),
	CONSTRAINT "project_groups_topology_sha256_check" CHECK(length("project_groups"."topology_sha256") = 64 AND "project_groups"."topology_sha256" NOT GLOB '*[^0-9a-f]*')
);
--> statement-breakpoint
CREATE INDEX `idx_project_groups_status_updated` ON `project_groups` (`status`,`updated_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_lifecycle_article_projects_id_article` ON `lifecycle_article_projects` (`id`,`article_id`);
--> statement-breakpoint
CREATE TRIGGER `project_group_events_no_update` BEFORE UPDATE ON `project_group_events` BEGIN SELECT RAISE(ABORT, 'project_group_events are append-only'); END;
--> statement-breakpoint
CREATE TRIGGER `project_group_events_no_delete` BEFORE DELETE ON `project_group_events` BEGIN SELECT RAISE(ABORT, 'project_group_events are append-only'); END;
--> statement-breakpoint
CREATE TRIGGER `project_group_command_receipts_no_update` BEFORE UPDATE ON `project_group_command_receipts` BEGIN SELECT RAISE(ABORT, 'project_group_command_receipts are append-only'); END;
--> statement-breakpoint
CREATE TRIGGER `project_group_command_receipts_no_delete` BEFORE DELETE ON `project_group_command_receipts` BEGIN SELECT RAISE(ABORT, 'project_group_command_receipts are append-only'); END;
