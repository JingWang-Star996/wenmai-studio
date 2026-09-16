CREATE TABLE IF NOT EXISTS `publish_capability_receipts` (
  `command_id` text PRIMARY KEY NOT NULL,
  `command_type` text NOT NULL CHECK (`command_type` IN ('publish-capability.issue','publish-capability.consume')),
  `actor_id` text NOT NULL,
  `request_sha256` text NOT NULL,
  `response_json` text NOT NULL DEFAULT '{}',
  `status_code` integer NOT NULL DEFAULT 0,
  `created_at` text NOT NULL,
  `completed_at` text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_publish_capability_receipts_actor_created` ON `publish_capability_receipts` (`actor_id`,`created_at`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `publish_capabilities` (
  `id` text PRIMARY KEY NOT NULL, `schema_version` text NOT NULL, `issue_command_id` text NOT NULL UNIQUE,
  `issue_request_sha256` text NOT NULL, `execution_packet_sha256` text NOT NULL UNIQUE, `nonce_sha256` text NOT NULL UNIQUE,
  `ticket_sha256` text NOT NULL, `packet_json_sha256` text NOT NULL, `confirmation_sha256` text NOT NULL,
  `packet_json` text NOT NULL, `ticket_json` text NOT NULL, `confirmation_json` text NOT NULL,
  `run_id` text NOT NULL, `attempt` integer NOT NULL, `packet_command_id` text NOT NULL,
  `contract_revision` integer NOT NULL, `contract_sha256` text NOT NULL, `platform` text NOT NULL,
  `release_id` text NOT NULL, `build_id` text NOT NULL, `artifact_sha256` text NOT NULL, `target_account` text NOT NULL,
  `action` text NOT NULL CHECK (`action` = 'publish'), `max_clicks` integer NOT NULL CHECK (`max_clicks` = 1),
  `issuer_actor_id` text NOT NULL, `issuer_principal_id` text NOT NULL,
  `status` text NOT NULL DEFAULT 'issued' CHECK (`status` IN ('issued','consumed')),
  `issued_at` text NOT NULL, `expires_at` text NOT NULL, `consumed_at` text, `created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_publish_capabilities_status_expiry` ON `publish_capabilities` (`status`,`expires_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_publish_capabilities_release` ON `publish_capabilities` (`run_id`,`platform`,`release_id`,`build_id`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `publish_capability_consumptions` (
  `id` text PRIMARY KEY NOT NULL, `capability_id` text NOT NULL UNIQUE, `nonce_sha256` text NOT NULL UNIQUE,
  `consumer_actor_id` text NOT NULL, `consumer_client_id` text NOT NULL, `command_id` text NOT NULL UNIQUE,
  `request_sha256` text NOT NULL, `consumed_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_publish_capability_consumptions_consumer` ON `publish_capability_consumptions` (`consumer_client_id`,`consumed_at`);
--> statement-breakpoint
ALTER TABLE `publish_capabilities` ADD COLUMN `article_id` text;
--> statement-breakpoint
CREATE INDEX `idx_publish_capabilities_article_status_expiry`
  ON `publish_capabilities` (`article_id`,`status`,`expires_at`);
