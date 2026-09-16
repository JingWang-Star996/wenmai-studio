CREATE TABLE `article_lineage_model_reviews` (
	`id` text PRIMARY KEY NOT NULL,
	`preparation_id` text NOT NULL,
	`candidate_id` text NOT NULL,
	`candidate_lock_version` integer NOT NULL,
	`input_sha256` text NOT NULL,
	`invocation_id` text NOT NULL,
	`provider` text NOT NULL,
	`model_id` text NOT NULL,
	`output_schema_version` text NOT NULL,
	`output_json` text NOT NULL,
	`output_sha256` text NOT NULL,
	`relation_recommendation` text NOT NULL,
	`confidence_micros` integer NOT NULL,
	`candidate_only` integer DEFAULT true NOT NULL,
	`state` text DEFAULT 'candidate' NOT NULL,
	`max_input_tokens` integer NOT NULL,
	`max_output_tokens` integer NOT NULL,
	`max_cost_cny_micros` integer NOT NULL,
	`reserved_cost_cny_micros` integer NOT NULL,
	`usage_json` text DEFAULT '{}' NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT "article_lineage_model_reviews_candidate_lock_check" CHECK("article_lineage_model_reviews"."candidate_lock_version" >= 1),
	CONSTRAINT "article_lineage_model_reviews_input_sha_check" CHECK(length("article_lineage_model_reviews"."input_sha256") = 64 AND "article_lineage_model_reviews"."input_sha256" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "article_lineage_model_reviews_output_sha_check" CHECK(length("article_lineage_model_reviews"."output_sha256") = 64 AND "article_lineage_model_reviews"."output_sha256" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "article_lineage_model_reviews_provider_check" CHECK("article_lineage_model_reviews"."provider" = 'deepseek'),
	CONSTRAINT "article_lineage_model_reviews_output_json_check" CHECK(json_valid("article_lineage_model_reviews"."output_json") AND json_type("article_lineage_model_reviews"."output_json") = 'object' AND length(CAST("article_lineage_model_reviews"."output_json" AS BLOB)) BETWEEN 2 AND 32768),
	CONSTRAINT "article_lineage_model_reviews_relation_check" CHECK("article_lineage_model_reviews"."relation_recommendation" IN ('same_root','version_of','adaptation_of','split_from','reference_only','not_related','inconclusive')),
	CONSTRAINT "article_lineage_model_reviews_confidence_check" CHECK("article_lineage_model_reviews"."confidence_micros" BETWEEN 0 AND 1000000),
	CONSTRAINT "article_lineage_model_reviews_candidate_only_check" CHECK("article_lineage_model_reviews"."candidate_only" = 1),
	CONSTRAINT "article_lineage_model_reviews_state_check" CHECK("article_lineage_model_reviews"."state" IN ('candidate','superseded')),
	CONSTRAINT "article_lineage_model_reviews_input_token_check" CHECK("article_lineage_model_reviews"."max_input_tokens" BETWEEN 1 AND 64000),
	CONSTRAINT "article_lineage_model_reviews_output_token_check" CHECK("article_lineage_model_reviews"."max_output_tokens" BETWEEN 128 AND 4096),
	CONSTRAINT "article_lineage_model_reviews_cost_check" CHECK("article_lineage_model_reviews"."max_cost_cny_micros" BETWEEN 1 AND 100000000 AND "article_lineage_model_reviews"."reserved_cost_cny_micros" >= 0),
	CONSTRAINT "article_lineage_model_reviews_usage_json_check" CHECK(json_valid("article_lineage_model_reviews"."usage_json") AND json_type("article_lineage_model_reviews"."usage_json") = 'object' AND length(CAST("article_lineage_model_reviews"."usage_json" AS BLOB)) BETWEEN 2 AND 8192)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_lineage_model_reviews_invocation` ON `article_lineage_model_reviews` (`invocation_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_lineage_model_reviews_preparation` ON `article_lineage_model_reviews` (`preparation_id`);--> statement-breakpoint
CREATE INDEX `idx_lineage_model_reviews_candidate` ON `article_lineage_model_reviews` (`candidate_id`,`state`,`created_at`);--> statement-breakpoint
CREATE TABLE `article_lineage_review_preparations` (
	`id` text PRIMARY KEY NOT NULL,
	`candidate_id` text NOT NULL,
	`candidate_lock_version` integer NOT NULL,
	`candidate_input_sha256` text NOT NULL,
	`source_revision_id` text NOT NULL,
	`source_body_sha256` text NOT NULL,
	`target_revision_id` text NOT NULL,
	`target_body_sha256` text NOT NULL,
	`frozen_input_json` text NOT NULL,
	`input_sha256` text NOT NULL,
	`input_token_estimate` integer NOT NULL,
	`budget_estimate_json` text NOT NULL,
	`state` text DEFAULT 'prepared' NOT NULL,
	`lock_version` integer DEFAULT 1 NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "article_lineage_review_preparations_candidate_lock_check" CHECK("article_lineage_review_preparations"."candidate_lock_version" >= 1),
	CONSTRAINT "article_lineage_review_preparations_candidate_sha_check" CHECK(length("article_lineage_review_preparations"."candidate_input_sha256") = 64 AND "article_lineage_review_preparations"."candidate_input_sha256" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "article_lineage_review_preparations_source_sha_check" CHECK(length("article_lineage_review_preparations"."source_body_sha256") = 64 AND "article_lineage_review_preparations"."source_body_sha256" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "article_lineage_review_preparations_target_sha_check" CHECK(length("article_lineage_review_preparations"."target_body_sha256") = 64 AND "article_lineage_review_preparations"."target_body_sha256" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "article_lineage_review_preparations_input_sha_check" CHECK(length("article_lineage_review_preparations"."input_sha256") = 64 AND "article_lineage_review_preparations"."input_sha256" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "article_lineage_review_preparations_input_json_check" CHECK(json_valid("article_lineage_review_preparations"."frozen_input_json") AND json_type("article_lineage_review_preparations"."frozen_input_json") = 'object' AND length(CAST("article_lineage_review_preparations"."frozen_input_json" AS BLOB)) BETWEEN 2 AND 131072),
	CONSTRAINT "article_lineage_review_preparations_budget_json_check" CHECK(json_valid("article_lineage_review_preparations"."budget_estimate_json") AND json_type("article_lineage_review_preparations"."budget_estimate_json") = 'object' AND length(CAST("article_lineage_review_preparations"."budget_estimate_json" AS BLOB)) BETWEEN 2 AND 8192),
	CONSTRAINT "article_lineage_review_preparations_token_check" CHECK("article_lineage_review_preparations"."input_token_estimate" BETWEEN 1 AND 64000),
	CONSTRAINT "article_lineage_review_preparations_state_check" CHECK("article_lineage_review_preparations"."state" IN ('prepared','consumed','superseded')),
	CONSTRAINT "article_lineage_review_preparations_lock_check" CHECK("article_lineage_review_preparations"."lock_version" >= 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_lineage_review_preparation_input` ON `article_lineage_review_preparations` (`candidate_id`,`input_sha256`);--> statement-breakpoint
CREATE INDEX `idx_lineage_review_preparation_state` ON `article_lineage_review_preparations` (`state`,`updated_at`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
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
	CONSTRAINT "model_invocations_provider_check" CHECK("__new_model_invocations"."provider" IN ('deepseek','qwen')),
	CONSTRAINT "model_invocations_state_check" CHECK("__new_model_invocations"."state" IN ('queued','running','succeeded','failed','inconclusive','cancelled')),
	CONSTRAINT "model_invocations_attempt_check" CHECK("__new_model_invocations"."attempt" >= 1),
	CONSTRAINT "model_invocations_usage_check" CHECK(("__new_model_invocations"."input_tokens" IS NULL OR "__new_model_invocations"."input_tokens" >= 0) AND ("__new_model_invocations"."output_tokens" IS NULL OR "__new_model_invocations"."output_tokens" >= 0) AND ("__new_model_invocations"."total_tokens" IS NULL OR "__new_model_invocations"."total_tokens" >= 0) AND ("__new_model_invocations"."estimated_cost_cny_micros" IS NULL OR "__new_model_invocations"."estimated_cost_cny_micros" >= 0)),
	CONSTRAINT "model_invocations_transport_check" CHECK(("__new_model_invocations"."latency_ms" IS NULL OR "__new_model_invocations"."latency_ms" >= 0) AND ("__new_model_invocations"."http_status" IS NULL OR ("__new_model_invocations"."http_status" >= 100 AND "__new_model_invocations"."http_status" <= 599)))
);
--> statement-breakpoint
INSERT INTO `__new_model_invocations`("id", "experiment_id", "lineage_candidate_id", "lineage_preparation_id", "command_id", "purpose", "role", "provider", "model_id", "adapter_version", "prompt_version_id", "provider_policy_sha256", "egress_manifest_sha256", "egress_approval_sha256", "request_sha256", "input_sha256", "response_sha256", "output_ref", "state", "attempt", "budget_reservation_json", "budget_reservation_sha256", "usage_json", "input_tokens", "output_tokens", "total_tokens", "estimated_cost_cny_micros", "latency_ms", "http_status", "finish_reason", "provider_request_id", "error_class", "error_summary", "created_at", "started_at", "finished_at") SELECT "id", "experiment_id", NULL, NULL, "command_id", "purpose", "role", "provider", "model_id", "adapter_version", "prompt_version_id", "provider_policy_sha256", "egress_manifest_sha256", "egress_approval_sha256", "request_sha256", "input_sha256", "response_sha256", "output_ref", "state", "attempt", "budget_reservation_json", "budget_reservation_sha256", "usage_json", "input_tokens", "output_tokens", "total_tokens", "estimated_cost_cny_micros", "latency_ms", "http_status", "finish_reason", "provider_request_id", "error_class", "error_summary", "created_at", "started_at", "finished_at" FROM `model_invocations`;--> statement-breakpoint
DROP TABLE `model_invocations`;--> statement-breakpoint
ALTER TABLE `__new_model_invocations` RENAME TO `model_invocations`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_model_invocations_command` ON `model_invocations` (`command_id`);--> statement-breakpoint
CREATE INDEX `idx_model_invocations_experiment_role` ON `model_invocations` (`experiment_id`,`role`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_model_invocations_purpose_state` ON `model_invocations` (`purpose`,`state`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_model_invocations_provider_state` ON `model_invocations` (`provider`,`state`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_model_invocations_lineage_candidate` ON `model_invocations` (`lineage_candidate_id`,`created_at`);
