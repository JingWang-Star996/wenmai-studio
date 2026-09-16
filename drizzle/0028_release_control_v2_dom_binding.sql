-- Cloudflare D1 owns the migration transaction and rejects explicit SQL
-- BEGIN/COMMIT.  Keep the destructive steps after the single INSERT: an
-- invalid legacy packet therefore leaves the canonical table untouched.  The
-- disposable staging table is cleared on a retry before it is recreated.
DROP TABLE IF EXISTS `__new_release_publish_capabilities_v2`;--> statement-breakpoint
CREATE TABLE `__new_release_publish_capabilities_v2` (
	`id` text PRIMARY KEY NOT NULL,
	`confirmation_id` text NOT NULL,
	`article_id` text NOT NULL,
	`run_id` text NOT NULL,
	`build_id` text NOT NULL,
	`release_id` text NOT NULL,
	`platform` text NOT NULL,
	`execution_packet_json` text NOT NULL,
	`packet_json_sha256` text NOT NULL,
	`packet_sha256` text NOT NULL,
	`artifact_sha256` text NOT NULL,
	`readiness_snapshot_sha256` text NOT NULL,
	`dom_contract_sha256` text NOT NULL,
	`target_account` text NOT NULL,
	`nonce_sha256` text NOT NULL,
	`max_clicks` integer DEFAULT 1 NOT NULL,
	`status` text DEFAULT 'issued' NOT NULL,
	`issued_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`consumed_at` text,
	CONSTRAINT "release_publish_capabilities_v2_platform_check" CHECK("__new_release_publish_capabilities_v2"."platform" IN ('xiaohongshu','maimai','zhihu','bilibili')),
	CONSTRAINT "release_publish_capabilities_v2_max_clicks_check" CHECK("__new_release_publish_capabilities_v2"."max_clicks" = 1),
	CONSTRAINT "release_publish_capabilities_v2_status_check" CHECK("__new_release_publish_capabilities_v2"."status" IN ('issued','leased','consumed','expired','revoked','frozen')),
	CONSTRAINT "release_publish_capabilities_v2_expiry_check" CHECK("__new_release_publish_capabilities_v2"."expires_at" > "__new_release_publish_capabilities_v2"."issued_at"),
	CONSTRAINT "release_publish_capabilities_v2_dom_contract_sha256_check" CHECK(length("__new_release_publish_capabilities_v2"."dom_contract_sha256") = 64 AND "__new_release_publish_capabilities_v2"."dom_contract_sha256" NOT GLOB '*[^0-9A-Fa-f]*')
);
--> statement-breakpoint
INSERT INTO `__new_release_publish_capabilities_v2`("id", "confirmation_id", "article_id", "run_id", "build_id", "release_id", "platform", "execution_packet_json", "packet_json_sha256", "packet_sha256", "artifact_sha256", "readiness_snapshot_sha256", "dom_contract_sha256", "target_account", "nonce_sha256", "max_clicks", "status", "issued_at", "expires_at", "consumed_at") SELECT "id", "confirmation_id", "article_id", "run_id", "build_id", "release_id", "platform", "execution_packet_json", "packet_json_sha256", "packet_sha256", "artifact_sha256", "readiness_snapshot_sha256", json_extract("execution_packet_json", '$.domContractSha256'), "target_account", "nonce_sha256", "max_clicks", "status", "issued_at", "expires_at", "consumed_at" FROM `release_publish_capabilities_v2`;--> statement-breakpoint
DROP TABLE `release_publish_capabilities_v2`;--> statement-breakpoint
ALTER TABLE `__new_release_publish_capabilities_v2` RENAME TO `release_publish_capabilities_v2`;--> statement-breakpoint
CREATE UNIQUE INDEX `release_publish_capabilities_v2_packet_json_sha256_unique` ON `release_publish_capabilities_v2` (`packet_json_sha256`);--> statement-breakpoint
CREATE UNIQUE INDEX `release_publish_capabilities_v2_packet_sha256_unique` ON `release_publish_capabilities_v2` (`packet_sha256`);--> statement-breakpoint
CREATE UNIQUE INDEX `release_publish_capabilities_v2_nonce_sha256_unique` ON `release_publish_capabilities_v2` (`nonce_sha256`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_release_publish_capabilities_v2_confirmation_release` ON `release_publish_capabilities_v2` (`confirmation_id`,`release_id`);--> statement-breakpoint
CREATE INDEX `idx_release_publish_capabilities_v2_status_expiry` ON `release_publish_capabilities_v2` (`status`,`expires_at`);--> statement-breakpoint
