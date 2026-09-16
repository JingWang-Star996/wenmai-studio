CREATE TABLE `agent_approval_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`attempt_id` text NOT NULL,
	`kind` text NOT NULL,
	`title` text NOT NULL,
	`question` text NOT NULL,
	`options_json` text DEFAULT '[]' NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`requested_by_client_id` text NOT NULL,
	`decision_note` text DEFAULT '' NOT NULL,
	`lock_version` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	`decided_at` text,
	`decided_by` text,
	CONSTRAINT "agent_approval_requests_status_check" CHECK("agent_approval_requests"."status" IN ('pending','approved','rejected','cancelled'))
);
--> statement-breakpoint
CREATE INDEX `idx_agent_approval_task_status` ON `agent_approval_requests` (`task_id`,`status`,`created_at`);--> statement-breakpoint
CREATE TABLE `agent_clients` (
	`id` text PRIMARY KEY NOT NULL,
	`label` text NOT NULL,
	`client_kind` text DEFAULT 'custom' NOT NULL,
	`token_sha256` text NOT NULL,
	`scopes_json` text DEFAULT '[]' NOT NULL,
	`article_ids_json` text DEFAULT '[]' NOT NULL,
	`task_ids_json` text DEFAULT '[]' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`expires_at` text NOT NULL,
	`last_seen_at` text,
	`created_at` text NOT NULL,
	`revoked_at` text,
	CONSTRAINT "agent_clients_status_check" CHECK("agent_clients"."status" IN ('active','revoked'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_agent_clients_token_sha256` ON `agent_clients` (`token_sha256`);--> statement-breakpoint
CREATE INDEX `idx_agent_clients_status_expiry` ON `agent_clients` (`status`,`expires_at`);--> statement-breakpoint
CREATE TABLE `agent_context_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`article_id` text NOT NULL,
	`branch_id` text,
	`revision_id` text NOT NULL,
	`body_sha256` text NOT NULL,
	`corpus_schema_version` text NOT NULL,
	`corpus_algorithm_version` text NOT NULL,
	`corpus_generated_at` text NOT NULL,
	`corpus_sha256` text NOT NULL,
	`graph_sha256` text NOT NULL,
	`rules_sha256` text NOT NULL,
	`bundle_json` text NOT NULL,
	`context_sha256` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_agent_context_task_created` ON `agent_context_snapshots` (`task_id`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_agent_context_task_sha` ON `agent_context_snapshots` (`task_id`,`context_sha256`);--> statement-breakpoint
CREATE TABLE `agent_progress_events` (
	`cursor` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`id` text NOT NULL,
	`task_id` text NOT NULL,
	`attempt_id` text,
	`event_type` text NOT NULL,
	`phase` text DEFAULT '' NOT NULL,
	`progress_percent` integer,
	`current_action` text DEFAULT '' NOT NULL,
	`next_action` text DEFAULT '' NOT NULL,
	`blocker` text DEFAULT '' NOT NULL,
	`message` text DEFAULT '' NOT NULL,
	`evidence_json` text DEFAULT '[]' NOT NULL,
	`payload_json` text DEFAULT '{}' NOT NULL,
	`actor_kind` text NOT NULL,
	`actor_id` text NOT NULL,
	`command_id` text,
	`input_sha256` text NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT "agent_progress_percent_check" CHECK("agent_progress_events"."progress_percent" IS NULL OR ("agent_progress_events"."progress_percent" >= 0 AND "agent_progress_events"."progress_percent" <= 100))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_agent_progress_event_id` ON `agent_progress_events` (`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_agent_progress_command` ON `agent_progress_events` (`command_id`) WHERE "agent_progress_events"."command_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_agent_progress_task_cursor` ON `agent_progress_events` (`task_id`,`cursor`);--> statement-breakpoint
CREATE TABLE `agent_task_artifacts` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`attempt_id` text NOT NULL,
	`kind` text NOT NULL,
	`title` text NOT NULL,
	`content_ref` text NOT NULL,
	`sha256` text NOT NULL,
	`media_type` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`payload_json` text DEFAULT '{}' NOT NULL,
	`context_sha256` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_agent_task_artifact_attempt_sha` ON `agent_task_artifacts` (`attempt_id`,`kind`,`sha256`);--> statement-breakpoint
CREATE INDEX `idx_agent_task_artifacts_task_created` ON `agent_task_artifacts` (`task_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `agent_task_attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`attempt` integer DEFAULT 1 NOT NULL,
	`client_id` text NOT NULL,
	`context_snapshot_id` text NOT NULL,
	`state` text DEFAULT 'claimed' NOT NULL,
	`last_heartbeat_at` text,
	`started_at` text NOT NULL,
	`finished_at` text,
	`error_class` text,
	`error_summary` text,
	CONSTRAINT "agent_task_attempts_state_check" CHECK("agent_task_attempts"."state" IN ('claimed','running','awaiting_human','succeeded','failed','released','cancelled'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_agent_task_attempt_number` ON `agent_task_attempts` (`task_id`,`attempt`);--> statement-breakpoint
CREATE INDEX `idx_agent_task_attempts_client_state` ON `agent_task_attempts` (`client_id`,`state`,`started_at`);--> statement-breakpoint
CREATE TABLE `agent_task_leases` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`attempt_id` text NOT NULL,
	`client_id` text NOT NULL,
	`lease_token_sha256` text NOT NULL,
	`leased_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`heartbeat_at` text NOT NULL,
	`heartbeat_seq` integer DEFAULT 0 NOT NULL,
	`revoked_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_agent_task_leases_active_attempt` ON `agent_task_leases` (`attempt_id`) WHERE "agent_task_leases"."revoked_at" IS NULL;--> statement-breakpoint
CREATE INDEX `idx_agent_task_leases_expiry` ON `agent_task_leases` (`expires_at`,`revoked_at`);--> statement-breakpoint
CREATE INDEX `idx_agent_task_leases_task` ON `agent_task_leases` (`task_id`,`revoked_at`);--> statement-breakpoint
CREATE TABLE `agent_tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`work_item_id` text,
	`article_id` text NOT NULL,
	`project_id` text,
	`target_branch_id` text,
	`current_context_snapshot_id` text,
	`active_attempt_id` text,
	`assigned_client_id` text,
	`title` text NOT NULL,
	`objective` text NOT NULL,
	`instructions_md` text DEFAULT '' NOT NULL,
	`acceptance_json` text DEFAULT '[]' NOT NULL,
	`context_spec_json` text DEFAULT '{}' NOT NULL,
	`permission_ceiling_json` text DEFAULT '{}' NOT NULL,
	`priority` text DEFAULT 'P2' NOT NULL,
	`state` text DEFAULT 'queued' NOT NULL,
	`lock_version` integer DEFAULT 1 NOT NULL,
	`created_by` text DEFAULT 'user' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`finished_at` text,
	`cancelled_at` text,
	CONSTRAINT "agent_tasks_priority_check" CHECK("agent_tasks"."priority" IN ('P0','P1','P2','P3')),
	CONSTRAINT "agent_tasks_state_check" CHECK("agent_tasks"."state" IN ('draft','queued','claimed','running','awaiting_human','blocked','review','succeeded','failed','cancelled'))
);
--> statement-breakpoint
CREATE INDEX `idx_agent_tasks_article_state` ON `agent_tasks` (`article_id`,`state`,`updated_at`);--> statement-breakpoint
CREATE INDEX `idx_agent_tasks_assignee_state` ON `agent_tasks` (`assigned_client_id`,`state`,`updated_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_agent_tasks_active_attempt` ON `agent_tasks` (`active_attempt_id`) WHERE "agent_tasks"."active_attempt_id" IS NOT NULL;--> statement-breakpoint
CREATE TABLE `graph_proposals` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`attempt_id` text NOT NULL,
	`article_id` text NOT NULL,
	`proposal_kind` text NOT NULL,
	`source_id` text,
	`target_id` text,
	`relation_type` text DEFAULT '' NOT NULL,
	`label` text DEFAULT '' NOT NULL,
	`payload_json` text DEFAULT '{}' NOT NULL,
	`evidence_json` text DEFAULT '[]' NOT NULL,
	`context_sha256` text NOT NULL,
	`input_sha256` text NOT NULL,
	`status` text DEFAULT 'candidate' NOT NULL,
	`lock_version` integer DEFAULT 1 NOT NULL,
	`created_by_client_id` text NOT NULL,
	`created_at` text NOT NULL,
	`reviewed_at` text,
	`reviewed_by` text,
	`review_note` text DEFAULT '' NOT NULL,
	CONSTRAINT "graph_proposals_kind_check" CHECK("graph_proposals"."proposal_kind" IN ('node','edge','claim')),
	CONSTRAINT "graph_proposals_status_check" CHECK("graph_proposals"."status" IN ('candidate','confirmed','rejected'))
);
--> statement-breakpoint
CREATE INDEX `idx_graph_proposals_article_status` ON `graph_proposals` (`article_id`,`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_graph_proposals_task_status` ON `graph_proposals` (`task_id`,`status`,`created_at`);