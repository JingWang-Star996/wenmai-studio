PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_meta_improvement_evaluations` (
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
	CONSTRAINT "meta_improvement_evaluations_arm_check" CHECK("__new_meta_improvement_evaluations"."arm" IN ('baseline','candidate','pair')),
	CONSTRAINT "meta_improvement_evaluations_kind_check" CHECK("__new_meta_improvement_evaluations"."evaluator_kind" IN ('deterministic','model','human')),
	CONSTRAINT "meta_improvement_evaluations_provider_check" CHECK("__new_meta_improvement_evaluations"."provider" IS NULL OR "__new_meta_improvement_evaluations"."provider" IN ('deepseek','qwen','openai','ollama')),
	CONSTRAINT "meta_improvement_evaluations_result_check" CHECK("__new_meta_improvement_evaluations"."result" IN ('pass','fail','inconclusive')),
	CONSTRAINT "meta_improvement_evaluations_model_provider_check" CHECK("__new_meta_improvement_evaluations"."evaluator_kind" <> 'model' OR "__new_meta_improvement_evaluations"."provider" IS NOT NULL)
);
--> statement-breakpoint
INSERT INTO `__new_meta_improvement_evaluations`("id", "experiment_id", "pair_id", "case_id", "arm", "version_id", "evaluator_kind", "evaluator_key", "provider", "model_id", "invocation_id", "result", "contract_sha256", "input_sha256", "output_sha256", "signals_json", "signals_sha256", "evidence_json", "evidence_sha256", "created_at") SELECT "id", "experiment_id", "pair_id", "case_id", "arm", "version_id", "evaluator_kind", "evaluator_key", "provider", "model_id", "invocation_id", "result", "contract_sha256", "input_sha256", "output_sha256", "signals_json", "signals_sha256", "evidence_json", "evidence_sha256", "created_at" FROM `meta_improvement_evaluations`;--> statement-breakpoint
DROP TABLE `meta_improvement_evaluations`;--> statement-breakpoint
ALTER TABLE `__new_meta_improvement_evaluations` RENAME TO `meta_improvement_evaluations`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_meta_improvement_evaluations_identity` ON `meta_improvement_evaluations` (`experiment_id`,`pair_id`,`arm`,`evaluator_key`,`input_sha256`);--> statement-breakpoint
CREATE INDEX `idx_meta_improvement_evaluations_experiment_result` ON `meta_improvement_evaluations` (`experiment_id`,`result`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_meta_improvement_evaluations_case` ON `meta_improvement_evaluations` (`experiment_id`,`case_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `__new_meta_skill_versions` (
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
	CONSTRAINT "meta_skill_versions_role_check" CHECK("__new_meta_skill_versions"."role" IN ('proposer','execution','reviewer','orchestrator')),
	CONSTRAINT "meta_skill_versions_creator_check" CHECK("__new_meta_skill_versions"."created_by_kind" IN ('human','model','system')),
	CONSTRAINT "meta_skill_versions_provider_check" CHECK("__new_meta_skill_versions"."created_by_provider" IS NULL OR "__new_meta_skill_versions"."created_by_provider" IN ('deepseek','qwen','openai','ollama')),
	CONSTRAINT "meta_skill_versions_model_candidate_check" CHECK("__new_meta_skill_versions"."created_by_kind" <> 'model' OR "__new_meta_skill_versions"."is_candidate" = 1),
	CONSTRAINT "meta_skill_versions_status_check" CHECK("__new_meta_skill_versions"."status" IN ('candidate','adopted','superseded','rejected')),
	CONSTRAINT "meta_skill_versions_lock_check" CHECK("__new_meta_skill_versions"."lock_version" >= 1),
	CONSTRAINT "meta_skill_versions_decision_check" CHECK("__new_meta_skill_versions"."status" = 'candidate' OR ("__new_meta_skill_versions"."decision_experiment_id" IS NOT NULL AND "__new_meta_skill_versions"."decided_at" IS NOT NULL)),
	CONSTRAINT "meta_skill_versions_activation_check" CHECK("__new_meta_skill_versions"."status" <> 'adopted' OR "__new_meta_skill_versions"."activated_at" IS NOT NULL)
);
--> statement-breakpoint
INSERT INTO `__new_meta_skill_versions`("id", "skill_key", "version", "role", "parent_version_id", "prompt_text", "prompt_sha256", "contract_json", "contract_sha256", "content_sha256", "created_by_kind", "created_by_provider", "source_invocation_id", "is_candidate", "status", "decision_experiment_id", "activated_at", "decided_at", "lock_version", "created_at") SELECT "id", "skill_key", "version", "role", "parent_version_id", "prompt_text", "prompt_sha256", "contract_json", "contract_sha256", "content_sha256", "created_by_kind", "created_by_provider", "source_invocation_id", "is_candidate", "status", "decision_experiment_id", "activated_at", "decided_at", "lock_version", "created_at" FROM `meta_skill_versions`;--> statement-breakpoint
DROP TABLE `meta_skill_versions`;--> statement-breakpoint
ALTER TABLE `__new_meta_skill_versions` RENAME TO `meta_skill_versions`;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_meta_skill_versions_key_version` ON `meta_skill_versions` (`skill_key`,`version`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_meta_skill_versions_key_content` ON `meta_skill_versions` (`skill_key`,`content_sha256`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_meta_skill_versions_active_key` ON `meta_skill_versions` (`skill_key`) WHERE "meta_skill_versions"."status" = 'adopted';--> statement-breakpoint
CREATE INDEX `idx_meta_skill_versions_key_created` ON `meta_skill_versions` (`skill_key`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_meta_skill_versions_parent` ON `meta_skill_versions` (`parent_version_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `__new_model_invocations` (
	`id` text PRIMARY KEY NOT NULL,
	`experiment_id` text,
	`lineage_candidate_id` text,
	`lineage_preparation_id` text,
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
	CONSTRAINT "model_invocations_purpose_check" CHECK("__new_model_invocations"."purpose" IN ('provider_probe','meta_experiment','lineage_review')),
	CONSTRAINT "model_invocations_role_check" CHECK("__new_model_invocations"."role" IN ('probe','proposer','execution','reviewer')),
	CONSTRAINT "model_invocations_purpose_role_check" CHECK(("__new_model_invocations"."purpose" = 'provider_probe' AND "__new_model_invocations"."role" = 'probe') OR ("__new_model_invocations"."purpose" = 'meta_experiment' AND "__new_model_invocations"."role" IN ('proposer','execution','reviewer')) OR ("__new_model_invocations"."purpose" = 'lineage_review' AND "__new_model_invocations"."role" = 'reviewer' AND "__new_model_invocations"."provider" = 'deepseek')),
	CONSTRAINT "model_invocations_experiment_binding_check" CHECK("__new_model_invocations"."purpose" = 'provider_probe' OR ("__new_model_invocations"."purpose" = 'meta_experiment' AND "__new_model_invocations"."experiment_id" IS NOT NULL AND "__new_model_invocations"."prompt_version_id" IS NOT NULL AND "__new_model_invocations"."provider_policy_sha256" IS NOT NULL) OR ("__new_model_invocations"."purpose" = 'lineage_review' AND "__new_model_invocations"."experiment_id" IS NULL AND "__new_model_invocations"."lineage_candidate_id" IS NOT NULL AND "__new_model_invocations"."lineage_preparation_id" IS NOT NULL AND "__new_model_invocations"."prompt_version_id" IS NOT NULL AND "__new_model_invocations"."provider_policy_sha256" IS NOT NULL)),
	CONSTRAINT "model_invocations_lineage_binding_check" CHECK(("__new_model_invocations"."purpose" = 'lineage_review' AND "__new_model_invocations"."lineage_candidate_id" IS NOT NULL AND "__new_model_invocations"."lineage_preparation_id" IS NOT NULL) OR ("__new_model_invocations"."purpose" <> 'lineage_review' AND "__new_model_invocations"."lineage_candidate_id" IS NULL AND "__new_model_invocations"."lineage_preparation_id" IS NULL)),
	CONSTRAINT "model_invocations_provider_check" CHECK("__new_model_invocations"."provider" IN ('deepseek','qwen','openai','ollama')),
	CONSTRAINT "model_invocations_state_check" CHECK("__new_model_invocations"."state" IN ('queued','running','succeeded','failed','inconclusive','cancelled')),
	CONSTRAINT "model_invocations_attempt_check" CHECK("__new_model_invocations"."attempt" >= 1),
	CONSTRAINT "model_invocations_usage_check" CHECK(("__new_model_invocations"."input_tokens" IS NULL OR "__new_model_invocations"."input_tokens" >= 0) AND ("__new_model_invocations"."output_tokens" IS NULL OR "__new_model_invocations"."output_tokens" >= 0) AND ("__new_model_invocations"."total_tokens" IS NULL OR "__new_model_invocations"."total_tokens" >= 0) AND ("__new_model_invocations"."estimated_cost_cny_micros" IS NULL OR "__new_model_invocations"."estimated_cost_cny_micros" >= 0)),
	CONSTRAINT "model_invocations_transport_check" CHECK(("__new_model_invocations"."latency_ms" IS NULL OR "__new_model_invocations"."latency_ms" >= 0) AND ("__new_model_invocations"."http_status" IS NULL OR ("__new_model_invocations"."http_status" >= 100 AND "__new_model_invocations"."http_status" <= 599)))
);
--> statement-breakpoint
INSERT INTO `__new_model_invocations`("id", "experiment_id", "lineage_candidate_id", "lineage_preparation_id", "command_id", "purpose", "role", "provider", "model_id", "adapter_version", "prompt_version_id", "provider_policy_sha256", "egress_manifest_sha256", "egress_approval_sha256", "request_sha256", "input_sha256", "response_sha256", "output_ref", "state", "attempt", "budget_reservation_json", "budget_reservation_sha256", "usage_json", "input_tokens", "output_tokens", "total_tokens", "estimated_cost_cny_micros", "latency_ms", "http_status", "finish_reason", "provider_request_id", "error_class", "error_summary", "created_at", "started_at", "finished_at") SELECT "id", "experiment_id", "lineage_candidate_id", "lineage_preparation_id", "command_id", "purpose", "role", "provider", "model_id", "adapter_version", "prompt_version_id", "provider_policy_sha256", "egress_manifest_sha256", "egress_approval_sha256", "request_sha256", "input_sha256", "response_sha256", "output_ref", "state", "attempt", "budget_reservation_json", "budget_reservation_sha256", "usage_json", "input_tokens", "output_tokens", "total_tokens", "estimated_cost_cny_micros", "latency_ms", "http_status", "finish_reason", "provider_request_id", "error_class", "error_summary", "created_at", "started_at", "finished_at" FROM `model_invocations`;--> statement-breakpoint
DROP TABLE `model_invocations`;--> statement-breakpoint
ALTER TABLE `__new_model_invocations` RENAME TO `model_invocations`;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_model_invocations_command` ON `model_invocations` (`command_id`);--> statement-breakpoint
CREATE INDEX `idx_model_invocations_experiment_role` ON `model_invocations` (`experiment_id`,`role`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_model_invocations_purpose_state` ON `model_invocations` (`purpose`,`state`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_model_invocations_provider_state` ON `model_invocations` (`provider`,`state`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_model_invocations_lineage_candidate` ON `model_invocations` (`lineage_candidate_id`,`created_at`);