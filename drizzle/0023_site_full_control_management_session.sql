ALTER TABLE `agent_clients` ADD `credential_purpose` text DEFAULT 'agent_api' NOT NULL;--> statement-breakpoint
ALTER TABLE `agent_clients` ADD `issued_by_source_client_id` text;--> statement-breakpoint
ALTER TABLE `agent_clients` ADD `exchange_generation` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_agent_clients_management_exchange` ON `agent_clients` (`credential_purpose`,`status`,`expires_at`);--> statement-breakpoint
ALTER TABLE `management_sessions` ADD `auth_basis` text DEFAULT 'owner_pairing' NOT NULL;--> statement-breakpoint
ALTER TABLE `management_sessions` ADD `authority_class` text DEFAULT 'owner' NOT NULL;--> statement-breakpoint
ALTER TABLE `management_sessions` ADD `source_client_id` text;--> statement-breakpoint
ALTER TABLE `management_sessions` ADD `source_key_expires_at` text;--> statement-breakpoint
ALTER TABLE `management_sessions` ADD `source_exchange_generation` integer;--> statement-breakpoint
ALTER TABLE `management_sessions` ADD `source_permission_snapshot_sha256` text;--> statement-breakpoint
CREATE INDEX `idx_management_sessions_source_client` ON `management_sessions` (`source_client_id`,`status`,`source_exchange_generation`);
