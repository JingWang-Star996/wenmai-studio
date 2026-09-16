CREATE TABLE `management_auth_events` (
	`id` text PRIMARY KEY NOT NULL,
	`event_type` text NOT NULL,
	`principal_id` text,
	`session_id` text,
	`outcome` text NOT NULL,
	`request_id` text NOT NULL,
	`details_json` text DEFAULT '{}' NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT "management_auth_events_outcome_check" CHECK("management_auth_events"."outcome" IN ('accepted','rejected','expired','revoked'))
);
--> statement-breakpoint
CREATE INDEX `idx_management_auth_events_created` ON `management_auth_events` (`created_at`);--> statement-breakpoint
CREATE INDEX `idx_management_auth_events_session` ON `management_auth_events` (`session_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `management_bootstrap_challenges` (
	`id` text PRIMARY KEY NOT NULL,
	`pairing_sha256` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`max_attempts` integer DEFAULT 5 NOT NULL,
	`expires_at` text NOT NULL,
	`consumed_at` text,
	`consumed_session_id` text,
	`created_at` text NOT NULL,
	CONSTRAINT "management_bootstrap_status_check" CHECK("management_bootstrap_challenges"."status" IN ('active','consumed','locked','expired'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_management_bootstrap_pairing_sha` ON `management_bootstrap_challenges` (`pairing_sha256`);--> statement-breakpoint
CREATE INDEX `idx_management_bootstrap_status_expiry` ON `management_bootstrap_challenges` (`status`,`expires_at`);--> statement-breakpoint
CREATE TABLE `management_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`principal_id` text NOT NULL,
	`token_sha256` text NOT NULL,
	`browser_binding_sha256` text NOT NULL,
	`scopes_json` text DEFAULT '[]' NOT NULL,
	`article_ids_json` text DEFAULT '[]' NOT NULL,
	`object_boundary_json` text DEFAULT '{}' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`absolute_expires_at` text NOT NULL,
	`idle_expires_at` text NOT NULL,
	`last_seen_at` text NOT NULL,
	`created_at` text NOT NULL,
	`revoked_at` text,
	`revoke_reason` text DEFAULT '' NOT NULL,
	CONSTRAINT "management_sessions_status_check" CHECK("management_sessions"."status" IN ('active','revoked','expired'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_management_sessions_token_sha` ON `management_sessions` (`token_sha256`);--> statement-breakpoint
CREATE INDEX `idx_management_sessions_principal_status` ON `management_sessions` (`principal_id`,`status`,`absolute_expires_at`);--> statement-breakpoint
CREATE INDEX `idx_management_sessions_expiry` ON `management_sessions` (`status`,`idle_expires_at`,`absolute_expires_at`);
