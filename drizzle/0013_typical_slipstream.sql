CREATE TABLE `management_browser_devices` (
	`id` text PRIMARY KEY NOT NULL,
	`principal_id` text NOT NULL,
	`public_key_jwk_json` text NOT NULL,
	`public_key_sha256` text NOT NULL,
	`browser_binding_sha256` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`enrolled_session_id` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`last_used_at` text,
	`revoked_at` text,
	`revoke_reason` text DEFAULT '' NOT NULL,
	CONSTRAINT "management_browser_devices_status_check" CHECK("management_browser_devices"."status" IN ('active','revoked'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_management_browser_devices_public_key` ON `management_browser_devices` (`public_key_sha256`);--> statement-breakpoint
CREATE INDEX `idx_management_browser_devices_binding_status` ON `management_browser_devices` (`browser_binding_sha256`,`status`,`updated_at`);--> statement-breakpoint
CREATE TABLE `management_device_challenges` (
	`id` text PRIMARY KEY NOT NULL,
	`boot_id` text NOT NULL,
	`device_id` text NOT NULL,
	`nonce_sha256` text NOT NULL,
	`payload_sha256` text NOT NULL,
	`browser_binding_sha256` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`max_attempts` integer DEFAULT 3 NOT NULL,
	`issued_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`consumed_at` text,
	`consumed_session_id` text,
	`created_at` text NOT NULL,
	CONSTRAINT "management_device_challenges_status_check" CHECK("management_device_challenges"."status" IN ('active','consumed','locked','expired'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_management_device_challenges_nonce` ON `management_device_challenges` (`nonce_sha256`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_management_device_challenges_payload` ON `management_device_challenges` (`payload_sha256`);--> statement-breakpoint
CREATE INDEX `idx_management_device_challenges_device_status` ON `management_device_challenges` (`device_id`,`status`,`expires_at`);--> statement-breakpoint
CREATE INDEX `idx_management_device_challenges_boot_status` ON `management_device_challenges` (`boot_id`,`status`,`expires_at`);--> statement-breakpoint
ALTER TABLE `management_sessions` ADD `trusted_device_id` text;--> statement-breakpoint
CREATE INDEX `idx_management_sessions_trusted_device` ON `management_sessions` (`trusted_device_id`,`status`,`created_at`);