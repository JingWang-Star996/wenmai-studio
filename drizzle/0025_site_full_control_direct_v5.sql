PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_agent_clients` (
  `id` text PRIMARY KEY NOT NULL,
  `label` text NOT NULL,
  `client_kind` text NOT NULL DEFAULT 'custom' CONSTRAINT `agent_clients_client_kind_check` CHECK (`client_kind` IN ('codex','mcp','custom')),
  `role` text NOT NULL DEFAULT 'agent' CONSTRAINT `agent_clients_role_check` CHECK (`role` IN ('agent','administrator','super_admin')),
  `token_sha256` text NOT NULL,
  `scopes_json` text NOT NULL DEFAULT '[]',
  `article_ids_json` text NOT NULL DEFAULT '[]',
  `task_ids_json` text NOT NULL DEFAULT '[]',
  `credential_purpose` text NOT NULL DEFAULT 'agent_api' CONSTRAINT `agent_clients_credential_purpose_check` CHECK (`credential_purpose` IN ('agent_api','management_session_exchange','site_full_control')),
  `issued_by_source_client_id` text,
  `exchange_generation` integer NOT NULL DEFAULT 0,
  `status` text NOT NULL DEFAULT 'active' CONSTRAINT `agent_clients_status_check` CHECK (`status` IN ('active','revoked')),
  `expires_at` text NOT NULL,
  `last_seen_at` text,
  `created_at` text NOT NULL,
  `revoked_at` text,
  CONSTRAINT `agent_clients_lineage_not_self_check` CHECK (`issued_by_source_client_id` IS NULL OR `issued_by_source_client_id` <> `id`)
);--> statement-breakpoint
INSERT INTO `__new_agent_clients` (`id`,`label`,`client_kind`,`role`,`token_sha256`,`scopes_json`,`article_ids_json`,`task_ids_json`,`credential_purpose`,`issued_by_source_client_id`,`exchange_generation`,`status`,`expires_at`,`created_at`)
SELECT '__wenmai_orphan_lineage_guard__','invalid lineage guard','custom','agent','invalid-lineage-guard','[]','[]','[]','agent_api','__wenmai_orphan_lineage_guard__',0,'revoked','1970-01-01T00:00:00.000Z','1970-01-01T00:00:00.000Z'
FROM `agent_clients` child
WHERE child.`issued_by_source_client_id` IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM `agent_clients` parent WHERE parent.`id` = child.`issued_by_source_client_id`)
LIMIT 1;--> statement-breakpoint
INSERT INTO `__new_agent_clients` (`id`,`label`,`client_kind`,`role`,`token_sha256`,`scopes_json`,`article_ids_json`,`task_ids_json`,`credential_purpose`,`issued_by_source_client_id`,`exchange_generation`,`status`,`expires_at`,`last_seen_at`,`created_at`,`revoked_at`)
SELECT `id`,`label`,`client_kind`,`role`,`token_sha256`,`scopes_json`,`article_ids_json`,`task_ids_json`,`credential_purpose`,`issued_by_source_client_id`,`exchange_generation`,`status`,`expires_at`,`last_seen_at`,`created_at`,`revoked_at` FROM `agent_clients`;--> statement-breakpoint
DROP TABLE `agent_clients`;--> statement-breakpoint
ALTER TABLE `__new_agent_clients` RENAME TO `agent_clients`;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_agent_clients_token_sha256` ON `agent_clients` (`token_sha256`);--> statement-breakpoint
CREATE INDEX `idx_agent_clients_status_expiry` ON `agent_clients` (`status`,`expires_at`);--> statement-breakpoint
CREATE INDEX `idx_agent_clients_management_exchange` ON `agent_clients` (`credential_purpose`,`status`,`expires_at`);--> statement-breakpoint
CREATE INDEX `idx_agent_clients_source_client` ON `agent_clients` (`issued_by_source_client_id`);--> statement-breakpoint
PRAGMA foreign_keys=ON;
