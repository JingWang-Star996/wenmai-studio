CREATE TABLE `decision_events` (
	`id` text PRIMARY KEY NOT NULL,
	`subject_type` text NOT NULL,
	`subject_id` text NOT NULL,
	`decision_type` text NOT NULL,
	`value_json` text DEFAULT '{}' NOT NULL,
	`notes` text DEFAULT '' NOT NULL,
	`rule_version` text NOT NULL,
	`input_sha256` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_decision_events_subject` ON `decision_events` (`subject_type`,`subject_id`,`created_at`);