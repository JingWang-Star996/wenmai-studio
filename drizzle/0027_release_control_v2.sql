CREATE TABLE `article_publish_confirmation_items` (
	`id` text PRIMARY KEY NOT NULL,
	`confirmation_id` text NOT NULL,
	`platform` text NOT NULL,
	`release_id` text NOT NULL,
	`build_id` text NOT NULL,
	`artifact_sha256` text NOT NULL,
	`target_account` text NOT NULL,
	`readiness_snapshot_sha256` text NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT "article_publish_confirmation_items_platform_check" CHECK("article_publish_confirmation_items"."platform" IN ('xiaohongshu','maimai','zhihu','bilibili'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_confirmation_items_confirmation_platform` ON `article_publish_confirmation_items` (`confirmation_id`,`platform`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_confirmation_items_confirmation_release` ON `article_publish_confirmation_items` (`confirmation_id`,`release_id`);--> statement-breakpoint
CREATE INDEX `idx_confirmation_items_release` ON `article_publish_confirmation_items` (`release_id`,`platform`);--> statement-breakpoint
CREATE TABLE `article_publish_confirmations` (
	`id` text PRIMARY KEY NOT NULL,
	`article_id` text NOT NULL,
	`run_id` text NOT NULL,
	`contract_sha256` text NOT NULL,
	`owner_session_id` text NOT NULL,
	`item_set_sha256` text NOT NULL,
	`confirmation_sha256` text NOT NULL,
	`state` text DEFAULT 'confirmed' NOT NULL,
	`confirmed_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`revoked_at` text,
	`created_at` text NOT NULL,
	CONSTRAINT "article_publish_confirmations_state_check" CHECK("article_publish_confirmations"."state" IN ('confirmed','expired','revoked','consumed')),
	CONSTRAINT "article_publish_confirmations_expiry_check" CHECK("article_publish_confirmations"."expires_at" > "article_publish_confirmations"."confirmed_at")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `article_publish_confirmations_confirmation_sha256_unique` ON `article_publish_confirmations` (`confirmation_sha256`);--> statement-breakpoint
CREATE INDEX `idx_article_publish_confirmations_article_state_expiry` ON `article_publish_confirmations` (`article_id`,`state`,`expires_at`);--> statement-breakpoint
CREATE TABLE `publish_click_leases_v2` (
	`id` text PRIMARY KEY NOT NULL,
	`capability_id` text NOT NULL,
	`confirmation_id` text NOT NULL,
	`article_id` text NOT NULL,
	`run_id` text NOT NULL,
	`build_id` text NOT NULL,
	`release_id` text NOT NULL,
	`platform` text NOT NULL,
	`target_account` text NOT NULL,
	`lease_token_sha256` text NOT NULL,
	`receipt_chain_id` text NOT NULL,
	`host_id` text NOT NULL,
	`route_attestation_sha256` text NOT NULL,
	`dom_contract_sha256` text NOT NULL,
	`packet_sha256` text NOT NULL,
	`artifact_sha256` text NOT NULL,
	`readiness_snapshot_sha256` text NOT NULL,
	`max_clicks` integer DEFAULT 1 NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`issued_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`consumed_at` text,
	`revoked_at` text,
	CONSTRAINT "publish_click_leases_v2_platform_check" CHECK("publish_click_leases_v2"."platform" IN ('xiaohongshu','maimai','zhihu','bilibili')),
	CONSTRAINT "publish_click_leases_v2_max_clicks_check" CHECK("publish_click_leases_v2"."max_clicks" = 1),
	CONSTRAINT "publish_click_leases_v2_status_check" CHECK("publish_click_leases_v2"."status" IN ('active','consumed','expired','revoked','frozen')),
	CONSTRAINT "publish_click_leases_v2_expiry_check" CHECK("publish_click_leases_v2"."expires_at" > "publish_click_leases_v2"."issued_at")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `publish_click_leases_v2_capability_id_unique` ON `publish_click_leases_v2` (`capability_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `publish_click_leases_v2_lease_token_sha256_unique` ON `publish_click_leases_v2` (`lease_token_sha256`);--> statement-breakpoint
CREATE UNIQUE INDEX `publish_click_leases_v2_receipt_chain_id_unique` ON `publish_click_leases_v2` (`receipt_chain_id`);--> statement-breakpoint
CREATE INDEX `idx_publish_click_leases_v2_status_expiry` ON `publish_click_leases_v2` (`status`,`expires_at`);--> statement-breakpoint
CREATE TABLE `publish_execution_receipt_events_v2` (
	`id` text PRIMARY KEY NOT NULL,
	`receipt_chain_id` text NOT NULL,
	`capability_id` text NOT NULL,
	`lease_id` text NOT NULL,
	`confirmation_id` text NOT NULL,
	`article_id` text NOT NULL,
	`run_id` text NOT NULL,
	`build_id` text NOT NULL,
	`release_id` text NOT NULL,
	`platform` text NOT NULL,
	`target_account` text NOT NULL,
	`dom_contract_sha256` text NOT NULL,
	`sequence` integer NOT NULL,
	`previous_event_sha256` text,
	`event_sha256` text NOT NULL,
	`event_type` text NOT NULL,
	`host_id` text NOT NULL,
	`host_invocation_id` text NOT NULL,
	`packet_sha256` text NOT NULL,
	`artifact_sha256` text NOT NULL,
	`readiness_snapshot_sha256` text NOT NULL,
	`result_json` text DEFAULT '{}' NOT NULL,
	`evidence_json` text DEFAULT '{}' NOT NULL,
	`write_disposition` text NOT NULL,
	`recovery_mode` text NOT NULL,
	`observed_at` text NOT NULL,
	`created_at` text NOT NULL,
	`server_sha256` text NOT NULL,
	`signature_sha256` text NOT NULL,
	CONSTRAINT "publish_execution_receipt_events_v2_platform_check" CHECK("publish_execution_receipt_events_v2"."platform" IN ('xiaohongshu','maimai','zhihu','bilibili')),
	CONSTRAINT "publish_execution_receipt_events_v2_type_check" CHECK("publish_execution_receipt_events_v2"."event_type" IN ('capability_consumed','click_invocation_started','click_invoked','click_not_invoked','result_unknown','read_only_probe')),
	CONSTRAINT "publish_execution_receipt_events_v2_disposition_check" CHECK("publish_execution_receipt_events_v2"."write_disposition" IN ('continue','freeze_writes','stop_writes')),
	CONSTRAINT "publish_execution_receipt_events_v2_recovery_check" CHECK("publish_execution_receipt_events_v2"."recovery_mode" IN ('none','probe_first'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `publish_execution_receipt_events_v2_event_sha256_unique` ON `publish_execution_receipt_events_v2` (`event_sha256`);--> statement-breakpoint
CREATE UNIQUE INDEX `publish_execution_receipt_events_v2_host_invocation_id_unique` ON `publish_execution_receipt_events_v2` (`host_invocation_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_receipt_events_v2_chain_sequence` ON `publish_execution_receipt_events_v2` (`receipt_chain_id`,`sequence`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_receipt_events_v2_capability_sequence` ON `publish_execution_receipt_events_v2` (`capability_id`,`sequence`);--> statement-breakpoint
CREATE INDEX `idx_receipt_events_v2_capability_created` ON `publish_execution_receipt_events_v2` (`capability_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `release_authoritative_readbacks_v2` (
	`id` text PRIMARY KEY NOT NULL,
	`release_id` text NOT NULL,
	`capability_id` text,
	`lease_id` text,
	`confirmation_id` text NOT NULL,
	`article_id` text NOT NULL,
	`run_id` text NOT NULL,
	`build_id` text NOT NULL,
	`platform` text NOT NULL,
	`target_account` text NOT NULL,
	`dom_contract_sha256` text NOT NULL,
	`host_id` text NOT NULL,
	`receipt_chain_id` text,
	`packet_sha256` text NOT NULL,
	`artifact_sha256` text NOT NULL,
	`readiness_snapshot_sha256` text NOT NULL,
	`readback_kind` text NOT NULL,
	`result` text NOT NULL,
	`evidence_json` text DEFAULT '{}' NOT NULL,
	`source_url` text DEFAULT '' NOT NULL,
	`observed_at` text NOT NULL,
	`evidence_sha256` text NOT NULL,
	`response_sha256` text NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT "release_authoritative_readbacks_v2_platform_check" CHECK("release_authoritative_readbacks_v2"."platform" IN ('xiaohongshu','maimai','zhihu','bilibili')),
	CONSTRAINT "release_authoritative_readbacks_v2_kind_check" CHECK("release_authoritative_readbacks_v2"."readback_kind" IN ('submission','destination_record','public_access','outcome','read_only_probe')),
	CONSTRAINT "release_authoritative_readbacks_v2_result_check" CHECK("release_authoritative_readbacks_v2"."result" IN ('verified','not_found','not_public','inconclusive','failed'))
);
--> statement-breakpoint
CREATE INDEX `idx_release_authoritative_readbacks_v2_release_kind_observed` ON `release_authoritative_readbacks_v2` (`release_id`,`readback_kind`,`observed_at`);--> statement-breakpoint
CREATE TABLE `release_control_v2_command_receipts` (
	`command_id` text PRIMARY KEY NOT NULL,
	`command_type` text NOT NULL,
	`actor_id` text NOT NULL,
	`request_sha256` text NOT NULL,
	`status` text DEFAULT 'received' NOT NULL,
	`response_json` text DEFAULT '{}' NOT NULL,
	`created_at` text NOT NULL,
	`completed_at` text,
	CONSTRAINT "release_control_v2_command_receipts_status_check" CHECK("release_control_v2_command_receipts"."status" IN ('received','succeeded','rejected','failed'))
);
--> statement-breakpoint
CREATE INDEX `idx_release_control_v2_command_receipts_actor_created` ON `release_control_v2_command_receipts` (`actor_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `release_external_action_freezes_v2` (
	`release_id` text PRIMARY KEY NOT NULL,
	`reason` text NOT NULL,
	`status` text DEFAULT 'frozen' NOT NULL,
	`capability_id` text,
	`lease_id` text,
	`frozen_at` text NOT NULL,
	`cleared_at` text,
	`cleared_by` text,
	CONSTRAINT "release_external_action_freezes_v2_status_check" CHECK("release_external_action_freezes_v2"."status" IN ('frozen','cleared'))
);
--> statement-breakpoint
CREATE TABLE `release_publish_capabilities_v2` (
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
	CONSTRAINT "release_publish_capabilities_v2_platform_check" CHECK("release_publish_capabilities_v2"."platform" IN ('xiaohongshu','maimai','zhihu','bilibili')),
	CONSTRAINT "release_publish_capabilities_v2_max_clicks_check" CHECK("release_publish_capabilities_v2"."max_clicks" = 1),
	CONSTRAINT "release_publish_capabilities_v2_status_check" CHECK("release_publish_capabilities_v2"."status" IN ('issued','leased','consumed','expired','revoked','frozen')),
	CONSTRAINT "release_publish_capabilities_v2_expiry_check" CHECK("release_publish_capabilities_v2"."expires_at" > "release_publish_capabilities_v2"."issued_at"),
	CONSTRAINT "release_publish_capabilities_v2_dom_contract_sha256_check" CHECK(length("release_publish_capabilities_v2"."dom_contract_sha256") = 64 AND "release_publish_capabilities_v2"."dom_contract_sha256" NOT GLOB '*[^0-9A-Fa-f]*')
);
--> statement-breakpoint
CREATE UNIQUE INDEX `release_publish_capabilities_v2_packet_sha256_unique` ON `release_publish_capabilities_v2` (`packet_sha256`);--> statement-breakpoint
CREATE UNIQUE INDEX `release_publish_capabilities_v2_packet_json_sha256_unique` ON `release_publish_capabilities_v2` (`packet_json_sha256`);--> statement-breakpoint
CREATE UNIQUE INDEX `release_publish_capabilities_v2_nonce_sha256_unique` ON `release_publish_capabilities_v2` (`nonce_sha256`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_release_publish_capabilities_v2_confirmation_release` ON `release_publish_capabilities_v2` (`confirmation_id`,`release_id`);--> statement-breakpoint
CREATE INDEX `idx_release_publish_capabilities_v2_status_expiry` ON `release_publish_capabilities_v2` (`status`,`expires_at`);--> statement-breakpoint
CREATE TABLE `release_readiness_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`article_id` text NOT NULL,
	`run_id` text NOT NULL,
	`release_id` text NOT NULL,
	`build_id` text NOT NULL,
	`platform` text NOT NULL,
	`artifact_sha256` text NOT NULL,
	`target_account` text NOT NULL,
	`publication_version_sha256` text NOT NULL,
	`profile_sha256` text NOT NULL,
	`contract_sha256` text NOT NULL,
	`prepare_receipt_head_sha256` text NOT NULL,
	`dom_contract_sha256` text NOT NULL,
	`snapshot_sha256` text NOT NULL,
	`state` text DEFAULT 'ready_to_submit' NOT NULL,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`stale_reason` text,
	`revoked_at` text,
	CONSTRAINT "release_readiness_snapshots_platform_check" CHECK("release_readiness_snapshots"."platform" IN ('xiaohongshu','maimai','zhihu','bilibili')),
	CONSTRAINT "release_readiness_snapshots_state_check" CHECK("release_readiness_snapshots"."state" IN ('ready_to_submit','stale','revoked')),
	CONSTRAINT "release_readiness_snapshots_expiry_check" CHECK("release_readiness_snapshots"."expires_at" > "release_readiness_snapshots"."created_at")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `release_readiness_snapshots_snapshot_sha256_unique` ON `release_readiness_snapshots` (`snapshot_sha256`);--> statement-breakpoint
CREATE INDEX `idx_release_readiness_snapshots_release_state_expiry` ON `release_readiness_snapshots` (`release_id`,`state`,`expires_at`);
--> statement-breakpoint
CREATE TRIGGER `publish_execution_receipt_events_v2_no_update`
BEFORE UPDATE ON `publish_execution_receipt_events_v2`
BEGIN
  SELECT RAISE(ABORT, 'publish_execution_receipt_events_v2 is append-only');
END;
--> statement-breakpoint
CREATE TRIGGER `publish_execution_receipt_events_v2_no_delete`
BEFORE DELETE ON `publish_execution_receipt_events_v2`
BEGIN
  SELECT RAISE(ABORT, 'publish_execution_receipt_events_v2 is append-only');
END;
--> statement-breakpoint
CREATE TRIGGER `release_authoritative_readbacks_v2_no_update`
BEFORE UPDATE ON `release_authoritative_readbacks_v2`
BEGIN
  SELECT RAISE(ABORT, 'release_authoritative_readbacks_v2 is append-only');
END;
--> statement-breakpoint
CREATE TRIGGER `release_authoritative_readbacks_v2_no_delete`
BEFORE DELETE ON `release_authoritative_readbacks_v2`
BEGIN
  SELECT RAISE(ABORT, 'release_authoritative_readbacks_v2 is append-only');
END;
