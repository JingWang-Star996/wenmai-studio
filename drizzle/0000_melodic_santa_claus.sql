CREATE TABLE `article_overrides` (
	`article_id` text PRIMARY KEY NOT NULL,
	`editorial_state` text DEFAULT 'inbox' NOT NULL,
	`gate_state` text DEFAULT 'not_run' NOT NULL,
	`evidence_health` text DEFAULT 'unknown' NOT NULL,
	`favorite` integer DEFAULT false NOT NULL,
	`notes` text DEFAULT '' NOT NULL,
	`series_id` text,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_article_overrides_editorial_state` ON `article_overrides` (`editorial_state`);--> statement-breakpoint
CREATE TABLE `editorial_items` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`title` text NOT NULL,
	`status` text DEFAULT '候选' NOT NULL,
	`summary` text DEFAULT '' NOT NULL,
	`rationale` text DEFAULT '' NOT NULL,
	`confidence` text DEFAULT '中' NOT NULL,
	`linked_article_ids` text DEFAULT '[]' NOT NULL,
	`next_action` text DEFAULT '' NOT NULL,
	`source_opportunity_id` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_editorial_items_kind_status` ON `editorial_items` (`kind`,`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_editorial_items_source_opportunity` ON `editorial_items` (`source_opportunity_id`);