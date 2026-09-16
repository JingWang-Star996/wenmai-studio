CREATE TABLE `meta_improvement_evaluations` (
	`id` text PRIMARY KEY NOT NULL,
	`experiment_id` text NOT NULL,
	`pair_id` text NOT NULL,
	`case_id` text NOT NULL,
	`arm` text NOT NULL,
	`version_id` text,
	`evaluator_kind` text NOT NULL,
	`evaluator_key` text NOT NULL,
	`provider` text,
	`model_id` text,
	`invocation_id` text,
	`result` text NOT NULL,
	`contract_sha256` text NOT NULL,
	`input_sha256` text NOT NULL,
	`output_sha256` text NOT NULL,
	`signals_json` text DEFAULT '[]' NOT NULL,
	`signals_sha256` text NOT NULL,
	`evidence_json` text DEFAULT '[]' NOT NULL,
	`evidence_sha256` text NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT "meta_improvement_evaluations_arm_check" CHECK("meta_improvement_evaluations"."arm" IN ('baseline','candidate','pair')),
	CONSTRAINT "meta_improvement_evaluations_kind_check" CHECK("meta_improvement_evaluations"."evaluator_kind" IN ('deterministic','model','human')),
	CONSTRAINT "meta_improvement_evaluations_provider_check" CHECK("meta_improvement_evaluations"."provider" IS NULL OR "meta_improvement_evaluations"."provider" IN ('deepseek','qwen')),
	CONSTRAINT "meta_improvement_evaluations_result_check" CHECK("meta_improvement_evaluations"."result" IN ('pass','fail','inconclusive')),
	CONSTRAINT "meta_improvement_evaluations_model_provider_check" CHECK("meta_improvement_evaluations"."evaluator_kind" <> 'model' OR "meta_improvement_evaluations"."provider" IS NOT NULL)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_meta_improvement_evaluations_identity` ON `meta_improvement_evaluations` (`experiment_id`,`pair_id`,`arm`,`evaluator_key`,`input_sha256`);--> statement-breakpoint
CREATE INDEX `idx_meta_improvement_evaluations_experiment_result` ON `meta_improvement_evaluations` (`experiment_id`,`result`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_meta_improvement_evaluations_case` ON `meta_improvement_evaluations` (`experiment_id`,`case_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `meta_improvement_events` (
	`id` text PRIMARY KEY NOT NULL,
	`experiment_id` text NOT NULL,
	`event_type` text NOT NULL,
	`from_state` text,
	`to_state` text,
	`actor_kind` text NOT NULL,
	`actor_id` text NOT NULL,
	`payload_json` text DEFAULT '{}' NOT NULL,
	`input_sha256` text NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT "meta_improvement_events_actor_check" CHECK("meta_improvement_events"."actor_kind" IN ('human','model','system'))
);
--> statement-breakpoint
CREATE INDEX `idx_meta_improvement_events_experiment_created` ON `meta_improvement_events` (`experiment_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `meta_improvement_experiments` (
	`id` text PRIMARY KEY NOT NULL,
	`target_skill_key` text NOT NULL,
	`title` text NOT NULL,
	`objective` text NOT NULL,
	`hypothesis` text NOT NULL,
	`baseline_version_id` text NOT NULL,
	`baseline_content_sha256` text NOT NULL,
	`candidate_version_id` text,
	`cases_json` text NOT NULL,
	`cases_sha256` text NOT NULL,
	`holdout_cases_json` text NOT NULL,
	`holdout_cases_sha256` text NOT NULL,
	`provider_policy_json` text NOT NULL,
	`provider_policy_sha256` text NOT NULL,
	`budget_json` text NOT NULL,
	`budget_sha256` text NOT NULL,
	`evaluation_contract_json` text NOT NULL,
	`evaluation_contract_sha256` text NOT NULL,
	`frozen_input_sha256` text NOT NULL,
	`proposer_invocation_id` text,
	`reviewer_invocation_id` text,
	`state` text DEFAULT 'draft' NOT NULL,
	`decision` text DEFAULT 'pending' NOT NULL,
	`human_decision_note` text DEFAULT '' NOT NULL,
	`human_decided_by` text,
	`human_decided_at` text,
	`lock_version` integer DEFAULT 1 NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`completed_at` text,
	CONSTRAINT "meta_improvement_experiments_state_check" CHECK("meta_improvement_experiments"."state" IN ('draft','baselined','generating','candidate_ready','evaluating','awaiting_human','blocked','completed','failed','cancelled')),
	CONSTRAINT "meta_improvement_experiments_decision_check" CHECK("meta_improvement_experiments"."decision" IN ('pending','adopt','reject','defer','rollback')),
	CONSTRAINT "meta_improvement_experiments_lock_check" CHECK("meta_improvement_experiments"."lock_version" >= 1),
	CONSTRAINT "meta_improvement_experiments_human_decision_check" CHECK("meta_improvement_experiments"."decision" = 'pending' OR ("meta_improvement_experiments"."human_decided_by" IS NOT NULL AND length(trim("meta_improvement_experiments"."human_decision_note")) > 0))
);
--> statement-breakpoint
CREATE INDEX `idx_meta_improvement_experiments_target_state` ON `meta_improvement_experiments` (`target_skill_key`,`state`,`updated_at`);--> statement-breakpoint
CREATE INDEX `idx_meta_improvement_experiments_baseline` ON `meta_improvement_experiments` (`baseline_version_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_meta_improvement_experiments_candidate` ON `meta_improvement_experiments` (`candidate_version_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `meta_skill_activations` (
	`skill_key` text PRIMARY KEY NOT NULL,
	`active_version_id` text NOT NULL,
	`lock_version` integer DEFAULT 1 NOT NULL,
	`updated_at` text NOT NULL,
	`decision_experiment_id` text NOT NULL,
	CONSTRAINT "meta_skill_activations_lock_check" CHECK("meta_skill_activations"."lock_version" >= 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_meta_skill_activations_active_version` ON `meta_skill_activations` (`active_version_id`);--> statement-breakpoint
CREATE INDEX `idx_meta_skill_activations_experiment` ON `meta_skill_activations` (`decision_experiment_id`,`updated_at`);--> statement-breakpoint
CREATE TABLE `meta_skill_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`skill_key` text NOT NULL,
	`version` text NOT NULL,
	`role` text NOT NULL,
	`parent_version_id` text,
	`prompt_text` text NOT NULL,
	`prompt_sha256` text NOT NULL,
	`contract_json` text DEFAULT '{}' NOT NULL,
	`contract_sha256` text NOT NULL,
	`content_sha256` text NOT NULL,
	`created_by_kind` text NOT NULL,
	`created_by_provider` text,
	`source_invocation_id` text,
	`is_candidate` integer DEFAULT true NOT NULL,
	`status` text DEFAULT 'candidate' NOT NULL,
	`decision_experiment_id` text,
	`activated_at` text,
	`decided_at` text,
	`lock_version` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT "meta_skill_versions_role_check" CHECK("meta_skill_versions"."role" IN ('proposer','execution','reviewer','orchestrator')),
	CONSTRAINT "meta_skill_versions_creator_check" CHECK("meta_skill_versions"."created_by_kind" IN ('human','model','system')),
	CONSTRAINT "meta_skill_versions_provider_check" CHECK("meta_skill_versions"."created_by_provider" IS NULL OR "meta_skill_versions"."created_by_provider" IN ('deepseek','qwen')),
	CONSTRAINT "meta_skill_versions_model_candidate_check" CHECK("meta_skill_versions"."created_by_kind" <> 'model' OR "meta_skill_versions"."is_candidate" = 1),
	CONSTRAINT "meta_skill_versions_status_check" CHECK("meta_skill_versions"."status" IN ('candidate','adopted','superseded','rejected')),
	CONSTRAINT "meta_skill_versions_lock_check" CHECK("meta_skill_versions"."lock_version" >= 1),
	CONSTRAINT "meta_skill_versions_decision_check" CHECK("meta_skill_versions"."status" = 'candidate' OR ("meta_skill_versions"."decision_experiment_id" IS NOT NULL AND "meta_skill_versions"."decided_at" IS NOT NULL)),
	CONSTRAINT "meta_skill_versions_activation_check" CHECK("meta_skill_versions"."status" <> 'adopted' OR "meta_skill_versions"."activated_at" IS NOT NULL)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_meta_skill_versions_key_version` ON `meta_skill_versions` (`skill_key`,`version`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_meta_skill_versions_key_content` ON `meta_skill_versions` (`skill_key`,`content_sha256`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_meta_skill_versions_active_key` ON `meta_skill_versions` (`skill_key`) WHERE "meta_skill_versions"."status" = 'adopted';--> statement-breakpoint
CREATE INDEX `idx_meta_skill_versions_key_created` ON `meta_skill_versions` (`skill_key`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_meta_skill_versions_parent` ON `meta_skill_versions` (`parent_version_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `model_invocations` (
	`id` text PRIMARY KEY NOT NULL,
	`experiment_id` text,
	`command_id` text NOT NULL,
	`purpose` text NOT NULL,
	`role` text NOT NULL,
	`provider` text NOT NULL,
	`model_id` text NOT NULL,
	`adapter_version` text NOT NULL,
	`prompt_version_id` text,
	`provider_policy_sha256` text,
	`egress_manifest_sha256` text NOT NULL,
	`egress_approval_sha256` text NOT NULL,
	`request_sha256` text NOT NULL,
	`input_sha256` text NOT NULL,
	`response_sha256` text,
	`output_ref` text DEFAULT '' NOT NULL,
	`state` text DEFAULT 'queued' NOT NULL,
	`attempt` integer DEFAULT 1 NOT NULL,
	`budget_reservation_json` text DEFAULT '{}' NOT NULL,
	`budget_reservation_sha256` text NOT NULL,
	`usage_json` text DEFAULT '{}' NOT NULL,
	`input_tokens` integer,
	`output_tokens` integer,
	`total_tokens` integer,
	`estimated_cost_cny_micros` integer,
	`latency_ms` integer,
	`http_status` integer,
	`finish_reason` text,
	`provider_request_id` text,
	`error_class` text,
	`error_summary` text,
	`created_at` text NOT NULL,
	`started_at` text,
	`finished_at` text,
	CONSTRAINT "model_invocations_purpose_check" CHECK("model_invocations"."purpose" IN ('provider_probe','meta_experiment')),
	CONSTRAINT "model_invocations_role_check" CHECK("model_invocations"."role" IN ('probe','proposer','execution','reviewer')),
	CONSTRAINT "model_invocations_purpose_role_check" CHECK(("model_invocations"."purpose" = 'provider_probe' AND "model_invocations"."role" = 'probe') OR ("model_invocations"."purpose" = 'meta_experiment' AND "model_invocations"."role" IN ('proposer','execution','reviewer'))),
	CONSTRAINT "model_invocations_experiment_binding_check" CHECK("model_invocations"."purpose" = 'provider_probe' OR ("model_invocations"."experiment_id" IS NOT NULL AND "model_invocations"."prompt_version_id" IS NOT NULL AND "model_invocations"."provider_policy_sha256" IS NOT NULL)),
	CONSTRAINT "model_invocations_provider_check" CHECK("model_invocations"."provider" IN ('deepseek','qwen')),
	CONSTRAINT "model_invocations_state_check" CHECK("model_invocations"."state" IN ('queued','running','succeeded','failed','inconclusive','cancelled')),
	CONSTRAINT "model_invocations_attempt_check" CHECK("model_invocations"."attempt" >= 1),
	CONSTRAINT "model_invocations_usage_check" CHECK(("model_invocations"."input_tokens" IS NULL OR "model_invocations"."input_tokens" >= 0) AND ("model_invocations"."output_tokens" IS NULL OR "model_invocations"."output_tokens" >= 0) AND ("model_invocations"."total_tokens" IS NULL OR "model_invocations"."total_tokens" >= 0) AND ("model_invocations"."estimated_cost_cny_micros" IS NULL OR "model_invocations"."estimated_cost_cny_micros" >= 0)),
	CONSTRAINT "model_invocations_transport_check" CHECK(("model_invocations"."latency_ms" IS NULL OR "model_invocations"."latency_ms" >= 0) AND ("model_invocations"."http_status" IS NULL OR ("model_invocations"."http_status" >= 100 AND "model_invocations"."http_status" <= 599)))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_model_invocations_command` ON `model_invocations` (`command_id`);--> statement-breakpoint
CREATE INDEX `idx_model_invocations_experiment_role` ON `model_invocations` (`experiment_id`,`role`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_model_invocations_purpose_state` ON `model_invocations` (`purpose`,`state`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_model_invocations_provider_state` ON `model_invocations` (`provider`,`state`,`created_at`);