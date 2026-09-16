CREATE TABLE IF NOT EXISTS `agent_client_permission_snapshots` (
	`client_id` text PRIMARY KEY NOT NULL,
	`schema_version` integer DEFAULT 3 NOT NULL,
	`catalog_version` text NOT NULL,
	`preset_id` text NOT NULL,
	`role` text NOT NULL,
	`scopes_json` text NOT NULL,
	`action_ids_json` text NOT NULL,
	`article_ids_json` text NOT NULL,
	`task_ids_json` text NOT NULL,
	`snapshot_json` text NOT NULL,
	`snapshot_sha256` text NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT "agent_client_permission_snapshots_schema_check" CHECK("agent_client_permission_snapshots"."schema_version" = 3)
);
--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_agent_clients` (
	`id` text PRIMARY KEY NOT NULL,
	`label` text NOT NULL,
	`client_kind` text DEFAULT 'custom' NOT NULL,
	`role` text DEFAULT 'agent' NOT NULL,
	`token_sha256` text NOT NULL,
	`scopes_json` text DEFAULT '[]' NOT NULL,
	`article_ids_json` text DEFAULT '[]' NOT NULL,
	`task_ids_json` text DEFAULT '[]' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`expires_at` text NOT NULL,
	`last_seen_at` text,
	`created_at` text NOT NULL,
	`revoked_at` text,
	CONSTRAINT "agent_clients_role_check" CHECK("__new_agent_clients"."role" IN ('agent','administrator','super_admin')),
	CONSTRAINT "agent_clients_status_check" CHECK("__new_agent_clients"."status" IN ('active','revoked'))
);
--> statement-breakpoint
INSERT INTO `__new_agent_clients`("id", "label", "client_kind", "role", "token_sha256", "scopes_json", "article_ids_json", "task_ids_json", "status", "expires_at", "last_seen_at", "created_at", "revoked_at")
SELECT a."id", a."label", a."client_kind",
  CASE
    -- A present v3 snapshot is authoritative only when every persisted mirror
    -- agrees. A malformed or mismatched snapshot never falls back to legacy inference.
    WHEN s."client_id" IS NOT NULL THEN CASE WHEN s."schema_version" = 3
      AND s."role" IN ('administrator','super_admin')
      AND s."scopes_json" = a."scopes_json"
      AND s."article_ids_json" = a."article_ids_json"
      AND s."task_ids_json" = a."task_ids_json"
      THEN s."role" ELSE 'agent' END
    -- Snapshot-free rows may recover only frozen, exact, duplicate-free v1/v2 contracts.
    WHEN json_valid(a."article_ids_json") AND json_type(a."article_ids_json") = 'array'
      AND (SELECT count(*) FROM json_each(a."article_ids_json")) = 1
      AND (SELECT count(*) FROM json_each(a."article_ids_json") WHERE value = '*') = 1
      AND json_valid(a."task_ids_json") AND json_type(a."task_ids_json") = 'array'
      AND (SELECT count(*) FROM json_each(a."task_ids_json")) = 0
      AND json_valid(a."scopes_json") AND json_type(a."scopes_json") = 'array'
      AND (SELECT count(*) FROM json_each(a."scopes_json")) = 6
      AND (SELECT count(DISTINCT value) FROM json_each(a."scopes_json")) = 6
      AND NOT EXISTS (SELECT 1 FROM json_each(a."scopes_json") WHERE value NOT IN ('task.read','context.read','knowledge.read','graph.read','package.read','task.manage'))
      THEN 'administrator'
    WHEN json_valid(a."article_ids_json") AND json_type(a."article_ids_json") = 'array'
      AND (SELECT count(*) FROM json_each(a."article_ids_json")) = 1
      AND (SELECT count(*) FROM json_each(a."article_ids_json") WHERE value = '*') = 1
      AND json_valid(a."task_ids_json") AND json_type(a."task_ids_json") = 'array'
      AND (SELECT count(*) FROM json_each(a."task_ids_json")) = 0
      AND json_valid(a."scopes_json") AND json_type(a."scopes_json") = 'array'
      AND (SELECT count(*) FROM json_each(a."scopes_json")) = 17
      AND (SELECT count(DISTINCT value) FROM json_each(a."scopes_json")) = 17
      AND NOT EXISTS (SELECT 1 FROM json_each(a."scopes_json") WHERE value NOT IN ('task.read','context.read','knowledge.read','graph.read','package.read','task.manage','approval.decide','graph.decide','package.patch.decide','package.patch.apply','workspace.publication_branch.create','package.branch.attach','publication.version.register','workspace.merge.prepare','workspace.merge.resolve','workspace.merge.apply','publish.capability.consume'))
      THEN 'super_admin'
    WHEN json_valid(a."article_ids_json") AND json_type(a."article_ids_json") = 'array'
      AND (SELECT count(*) FROM json_each(a."article_ids_json")) = 1
      AND (SELECT count(*) FROM json_each(a."article_ids_json") WHERE value = '*') = 1
      AND json_valid(a."task_ids_json") AND json_type(a."task_ids_json") = 'array'
      AND (SELECT count(*) FROM json_each(a."task_ids_json")) = 0
      AND json_valid(a."scopes_json") AND json_type(a."scopes_json") = 'array'
      AND (SELECT count(*) FROM json_each(a."scopes_json")) = 20
      AND (SELECT count(DISTINCT value) FROM json_each(a."scopes_json")) = 20
      AND NOT EXISTS (SELECT 1 FROM json_each(a."scopes_json") WHERE value NOT IN ('task.read','context.read','knowledge.read','graph.read','package.read','task.manage','approval.decide','graph.decide','package.patch.decide','package.patch.apply','workspace.publication_branch.create','package.branch.attach','publication.version.register','workspace.merge.prepare','workspace.merge.resolve','workspace.merge.apply','publish.capability.consume','workspace.branch.write','package.working_copy.save','package.revision.commit'))
      THEN 'super_admin'
    ELSE 'agent'
  END,
  a."token_sha256", a."scopes_json", a."article_ids_json", a."task_ids_json", a."status", a."expires_at", a."last_seen_at", a."created_at", a."revoked_at"
FROM `agent_clients` AS a
LEFT JOIN `agent_client_permission_snapshots` AS s ON s."client_id" = a."id";--> statement-breakpoint
DROP TABLE `agent_clients`;--> statement-breakpoint
ALTER TABLE `__new_agent_clients` RENAME TO `agent_clients`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `idx_agent_clients_token_sha256` ON `agent_clients` (`token_sha256`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_agent_clients_status_expiry` ON `agent_clients` (`status`,`expires_at`);
