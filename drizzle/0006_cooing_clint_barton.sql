CREATE TABLE `agent_artifacts` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_step_id` text NOT NULL,
	`kind` text NOT NULL,
	`title` text NOT NULL,
	`content_ref` text NOT NULL,
	`sha256` text NOT NULL,
	`media_type` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`payload_json` text DEFAULT '{}' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_agent_artifacts_step_created` ON `agent_artifacts` (`agent_step_id`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_agent_artifacts_step_kind_sha` ON `agent_artifacts` (`agent_step_id`,`kind`,`sha256`);--> statement-breakpoint
CREATE TABLE `agent_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`production_run_id` text NOT NULL,
	`production_step_id` text NOT NULL,
	`recipe_id` text NOT NULL,
	`recipe_version` text NOT NULL,
	`recipe_sha256` text NOT NULL,
	`article_id` text NOT NULL,
	`branch_id` text NOT NULL,
	`frozen_revision_id` text NOT NULL,
	`frozen_title` text DEFAULT '' NOT NULL,
	`input_sha256` text NOT NULL,
	`permission_snapshot_json` text DEFAULT '{}' NOT NULL,
	`state` text DEFAULT 'queued' NOT NULL,
	`requested_by` text DEFAULT 'user' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`started_at` text,
	`finished_at` text,
	`last_heartbeat_at` text
);
--> statement-breakpoint
CREATE INDEX `idx_agent_runs_article_state` ON `agent_runs` (`article_id`,`state`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_agent_runs_production_step` ON `agent_runs` (`production_run_id`,`production_step_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_agent_runs_active_production_step` ON `agent_runs` (`production_run_id`,`production_step_id`) WHERE "agent_runs"."state" IN ('queued', 'running');--> statement-breakpoint
CREATE TABLE `agent_steps` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_run_id` text NOT NULL,
	`recipe_step_id` text NOT NULL,
	`attempt` integer DEFAULT 1 NOT NULL,
	`runner_action` text NOT NULL,
	`agent_role` text,
	`state` text DEFAULT 'queued' NOT NULL,
	`assigned_runner_id` text,
	`lease_id` text,
	`terminal_command_id` text,
	`input_json` text NOT NULL,
	`input_sha256` text NOT NULL,
	`output_sha256` text,
	`error_class` text,
	`error_summary` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`started_at` text,
	`finished_at` text,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_agent_steps_run_step_attempt` ON `agent_steps` (`agent_run_id`,`recipe_step_id`,`attempt`);--> statement-breakpoint
CREATE INDEX `idx_agent_steps_state_action` ON `agent_steps` (`state`,`runner_action`,`created_at`);--> statement-breakpoint
CREATE TABLE `command_receipts` (
	`id` text PRIMARY KEY NOT NULL,
	`command_type` text NOT NULL,
	`actor_id` text NOT NULL,
	`request_sha256` text NOT NULL,
	`response_json` text DEFAULT '{}' NOT NULL,
	`status_code` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`completed_at` text
);
--> statement-breakpoint
CREATE INDEX `idx_command_receipts_actor_created` ON `command_receipts` (`actor_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `lifecycle_adaptation_contracts` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`article_id` text NOT NULL,
	`target_profile_id` text NOT NULL,
	`target_profile_sha256` text NOT NULL,
	`source_revision_id` text NOT NULL,
	`source_body_sha256` text NOT NULL,
	`slice_kind` text NOT NULL,
	`title` text NOT NULL,
	`invariants_json` text DEFAULT '{}' NOT NULL,
	`rules_json` text DEFAULT '{}' NOT NULL,
	`contract_sha256` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`approval_note` text DEFAULT '' NOT NULL,
	`lock_version` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "lifecycle_contracts_slice_check" CHECK("lifecycle_adaptation_contracts"."slice_kind" IN ('full','demo','excerpt','promo')),
	CONSTRAINT "lifecycle_contracts_status_check" CHECK("lifecycle_adaptation_contracts"."status" IN ('draft','approved','superseded','cancelled'))
);
--> statement-breakpoint
CREATE INDEX `idx_lifecycle_contracts_article_status` ON `lifecycle_adaptation_contracts` (`article_id`,`status`,`updated_at`);--> statement-breakpoint
CREATE TABLE `lifecycle_article_projects` (
	`id` text PRIMARY KEY NOT NULL,
	`article_id` text NOT NULL,
	`title` text NOT NULL,
	`intent` text DEFAULT '' NOT NULL,
	`owner` text DEFAULT '我' NOT NULL,
	`phase` text DEFAULT 'pitch' NOT NULL,
	`execution_state` text DEFAULT 'proposed' NOT NULL,
	`lock_version` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "lifecycle_projects_phase_check" CHECK("lifecycle_article_projects"."phase" IN ('pitch','planning','production','packaging','release','operate','retrospective')),
	CONSTRAINT "lifecycle_projects_execution_check" CHECK("lifecycle_article_projects"."execution_state" IN ('proposed','active','blocked','paused','completed','cancelled'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `lifecycle_article_projects_article_id_unique` ON `lifecycle_article_projects` (`article_id`);--> statement-breakpoint
CREATE INDEX `idx_lifecycle_projects_article_state` ON `lifecycle_article_projects` (`article_id`,`execution_state`,`updated_at`);--> statement-breakpoint
CREATE TABLE `lifecycle_build_gate_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`build_id` text NOT NULL,
	`project_id` text NOT NULL,
	`article_id` text NOT NULL,
	`gate_kind` text NOT NULL,
	`result` text NOT NULL,
	`artifact_sha256` text NOT NULL,
	`target_profile_sha256` text NOT NULL,
	`contract_sha256` text NOT NULL,
	`evidence_json` text DEFAULT '[]' NOT NULL,
	`details_json` text DEFAULT '{}' NOT NULL,
	`input_sha256` text NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT "lifecycle_gates_kind_check" CHECK("lifecycle_build_gate_runs"."gate_kind" IN ('compatibility','fidelity')),
	CONSTRAINT "lifecycle_gates_result_check" CHECK("lifecycle_build_gate_runs"."result" IN ('pass','fail','inconclusive'))
);
--> statement-breakpoint
CREATE INDEX `idx_lifecycle_gates_build_kind` ON `lifecycle_build_gate_runs` (`build_id`,`gate_kind`,`created_at`);--> statement-breakpoint
CREATE TABLE `lifecycle_builds` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`article_id` text NOT NULL,
	`branch_id` text NOT NULL,
	`revision_id` text NOT NULL,
	`source_title` text NOT NULL,
	`source_body_sha256` text NOT NULL,
	`target_profile_id` text NOT NULL,
	`target_profile_sha256` text NOT NULL,
	`adaptation_contract_id` text NOT NULL,
	`contract_sha256` text NOT NULL,
	`slice_kind` text NOT NULL,
	`state` text DEFAULT 'planned' NOT NULL,
	`artifact_ref` text DEFAULT '' NOT NULL,
	`artifact_sha256` text DEFAULT '' NOT NULL,
	`artifact_media_type` text DEFAULT '' NOT NULL,
	`artifact_manifest_json` text DEFAULT '{}' NOT NULL,
	`failure_summary` text DEFAULT '' NOT NULL,
	`created_at` text NOT NULL,
	`built_at` text,
	`updated_at` text NOT NULL,
	CONSTRAINT "lifecycle_builds_slice_check" CHECK("lifecycle_builds"."slice_kind" IN ('full','demo','excerpt','promo')),
	CONSTRAINT "lifecycle_builds_state_check" CHECK("lifecycle_builds"."state" IN ('planned','built','failed','superseded'))
);
--> statement-breakpoint
CREATE INDEX `idx_lifecycle_builds_article_state` ON `lifecycle_builds` (`article_id`,`state`,`updated_at`);--> statement-breakpoint
CREATE TABLE `lifecycle_events` (
	`id` text PRIMARY KEY NOT NULL,
	`article_id` text,
	`event_type` text NOT NULL,
	`subject_type` text NOT NULL,
	`subject_id` text NOT NULL,
	`payload_json` text DEFAULT '{}' NOT NULL,
	`input_sha256` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_lifecycle_events_article_created` ON `lifecycle_events` (`article_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `lifecycle_metric_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`release_id` text NOT NULL,
	`project_id` text NOT NULL,
	`article_id` text NOT NULL,
	`source_mode` text NOT NULL,
	`source_label` text NOT NULL,
	`window_start` text NOT NULL,
	`window_end` text NOT NULL,
	`captured_at` text NOT NULL,
	`metrics_json` text NOT NULL,
	`evidence_ref` text NOT NULL,
	`measurement_sha256` text NOT NULL,
	`validation_state` text DEFAULT 'collected' NOT NULL,
	`validation_note` text DEFAULT '' NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT "lifecycle_metrics_source_check" CHECK("lifecycle_metric_snapshots"."source_mode" IN ('manual','export')),
	CONSTRAINT "lifecycle_metrics_validation_check" CHECK("lifecycle_metric_snapshots"."validation_state" IN ('collected','validated','inconclusive'))
);
--> statement-breakpoint
CREATE INDEX `idx_lifecycle_metrics_release_time` ON `lifecycle_metric_snapshots` (`release_id`,`captured_at`);--> statement-breakpoint
CREATE TABLE `lifecycle_platform_targets` (
	`id` text PRIMARY KEY NOT NULL,
	`profile_key` text NOT NULL,
	`platform` text NOT NULL,
	`label` text NOT NULL,
	`version` text NOT NULL,
	`connection_mode` text DEFAULT 'manual' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`profile_json` text DEFAULT '{}' NOT NULL,
	`profile_sha256` text NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT "lifecycle_targets_connection_check" CHECK("lifecycle_platform_targets"."connection_mode" = 'manual'),
	CONSTRAINT "lifecycle_targets_status_check" CHECK("lifecycle_platform_targets"."status" IN ('active','superseded'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `lifecycle_platform_targets_profile_key_version_unique` ON `lifecycle_platform_targets` (`profile_key`,`version`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_lifecycle_targets_active_key` ON `lifecycle_platform_targets` (`profile_key`) WHERE "lifecycle_platform_targets"."status" = 'active';--> statement-breakpoint
CREATE TABLE `lifecycle_releases` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`article_id` text NOT NULL,
	`build_id` text NOT NULL,
	`build_artifact_sha256` text NOT NULL,
	`target_profile_id` text NOT NULL,
	`target_profile_sha256` text NOT NULL,
	`approval_state` text DEFAULT 'draft' NOT NULL,
	`submission_state` text DEFAULT 'not_submitted' NOT NULL,
	`destination_state` text DEFAULT 'not_checked' NOT NULL,
	`public_state` text DEFAULT 'not_checked' NOT NULL,
	`lifecycle_state` text DEFAULT 'active' NOT NULL,
	`remote_record_id` text DEFAULT '' NOT NULL,
	`destination_url` text DEFAULT '' NOT NULL,
	`public_url` text DEFAULT '' NOT NULL,
	`approval_note` text DEFAULT '' NOT NULL,
	`submission_evidence_json` text DEFAULT '[]' NOT NULL,
	`destination_evidence_json` text DEFAULT '[]' NOT NULL,
	`public_evidence_json` text DEFAULT '[]' NOT NULL,
	`lock_version` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "lifecycle_releases_approval_check" CHECK("lifecycle_releases"."approval_state" IN ('draft','approved','rejected')),
	CONSTRAINT "lifecycle_releases_submission_check" CHECK("lifecycle_releases"."submission_state" IN ('not_submitted','submitting','submission_accepted','submission_failed')),
	CONSTRAINT "lifecycle_releases_destination_check" CHECK("lifecycle_releases"."destination_state" IN ('not_checked','backend_verified','not_found','inconclusive')),
	CONSTRAINT "lifecycle_releases_public_check" CHECK("lifecycle_releases"."public_state" IN ('not_checked','public_verified','not_public','inconclusive')),
	CONSTRAINT "lifecycle_releases_lifecycle_check" CHECK("lifecycle_releases"."lifecycle_state" IN ('active','withdrawn','superseded'))
);
--> statement-breakpoint
CREATE INDEX `idx_lifecycle_releases_article_state` ON `lifecycle_releases` (`article_id`,`lifecycle_state`,`updated_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_lifecycle_releases_active_build` ON `lifecycle_releases` (`build_id`) WHERE "lifecycle_releases"."lifecycle_state" = 'active';--> statement-breakpoint
CREATE TABLE `lifecycle_retrospectives` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`article_id` text NOT NULL,
	`release_id` text,
	`title` text NOT NULL,
	`summary` text DEFAULT '' NOT NULL,
	`evidence_refs_json` text DEFAULT '[]' NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`lock_version` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "lifecycle_retrospectives_status_check" CHECK("lifecycle_retrospectives"."status" IN ('draft','reviewed','closed'))
);
--> statement-breakpoint
CREATE INDEX `idx_lifecycle_retrospectives_article_status` ON `lifecycle_retrospectives` (`article_id`,`status`,`updated_at`);--> statement-breakpoint
CREATE TABLE `lifecycle_rule_candidates` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`article_id` text NOT NULL,
	`retrospective_id` text NOT NULL,
	`title` text NOT NULL,
	`rule_text` text NOT NULL,
	`scope` text DEFAULT '' NOT NULL,
	`counterexamples` text DEFAULT '' NOT NULL,
	`owner` text DEFAULT '' NOT NULL,
	`implementation_target` text DEFAULT '' NOT NULL,
	`regression_ref` text DEFAULT '' NOT NULL,
	`evidence_refs_json` text DEFAULT '[]' NOT NULL,
	`state` text DEFAULT 'candidate' NOT NULL,
	`lock_version` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "lifecycle_rules_state_check" CHECK("lifecycle_rule_candidates"."state" IN ('candidate','testing','verified','adopted','deferred','rejected'))
);
--> statement-breakpoint
CREATE INDEX `idx_lifecycle_rules_article_state` ON `lifecycle_rule_candidates` (`article_id`,`state`,`updated_at`);--> statement-breakpoint
CREATE TABLE `merge_proposals` (
	`id` text PRIMARY KEY NOT NULL,
	`work_item_id` text NOT NULL,
	`article_id` text NOT NULL,
	`source_branch_id` text NOT NULL,
	`target_branch_id` text NOT NULL,
	`base_revision_id` text NOT NULL,
	`source_head_revision_id` text NOT NULL,
	`target_head_revision_id` text NOT NULL,
	`base_sha256` text NOT NULL,
	`source_head_sha256` text NOT NULL,
	`target_head_sha256` text NOT NULL,
	`algorithm_version` text NOT NULL,
	`preview_json` text DEFAULT '{}' NOT NULL,
	`preview_sha256` text NOT NULL,
	`resolved_document_title` text DEFAULT '' NOT NULL,
	`resolved_body_text` text DEFAULT '' NOT NULL,
	`resolved_body_sha256` text DEFAULT '' NOT NULL,
	`resolution_json` text DEFAULT '{}' NOT NULL,
	`resolution_note` text DEFAULT '' NOT NULL,
	`unresolved_count` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'prepared' NOT NULL,
	`lock_version` integer DEFAULT 1 NOT NULL,
	`merge_revision_id` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `merge_proposals_work_item_id_unique` ON `merge_proposals` (`work_item_id`);--> statement-breakpoint
CREATE INDEX `idx_merge_proposals_article_status` ON `merge_proposals` (`article_id`,`status`,`updated_at`);--> statement-breakpoint
CREATE INDEX `idx_merge_proposals_target_status` ON `merge_proposals` (`target_branch_id`,`status`,`updated_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_merge_proposals_revision` ON `merge_proposals` (`merge_revision_id`) WHERE "merge_proposals"."merge_revision_id" IS NOT NULL;--> statement-breakpoint
CREATE TABLE `runner_leases` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_step_id` text NOT NULL,
	`runner_id` text NOT NULL,
	`lease_token_sha256` text NOT NULL,
	`leased_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`heartbeat_at` text NOT NULL,
	`heartbeat_seq` integer DEFAULT 0 NOT NULL,
	`revoked_at` text
);
--> statement-breakpoint
CREATE INDEX `idx_runner_leases_step_active` ON `runner_leases` (`agent_step_id`,`revoked_at`);--> statement-breakpoint
CREATE INDEX `idx_runner_leases_expiry` ON `runner_leases` (`expires_at`,`revoked_at`);--> statement-breakpoint
CREATE TABLE `runner_registry` (
	`id` text PRIMARY KEY NOT NULL,
	`label` text NOT NULL,
	`token_sha256` text NOT NULL,
	`capabilities_json` text DEFAULT '[]' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`last_seen_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`revoked_at` text
);
--> statement-breakpoint
CREATE INDEX `idx_runner_registry_status_seen` ON `runner_registry` (`status`,`last_seen_at`);--> statement-breakpoint
ALTER TABLE `production_run_steps` ADD `runner_action` text;