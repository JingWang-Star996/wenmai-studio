CREATE TABLE `article_identities` (
	`id` text PRIMARY KEY NOT NULL,
	`canonical_article_id` text NOT NULL,
	`title` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`visibility` text DEFAULT 'primary' NOT NULL,
	`lock_version` integer DEFAULT 1 NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "article_identities_status_check" CHECK("article_identities"."status" IN ('active','archived')),
	CONSTRAINT "article_identities_visibility_check" CHECK("article_identities"."visibility" IN ('primary','hidden')),
	CONSTRAINT "article_identities_lock_check" CHECK("article_identities"."lock_version" >= 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_article_identities_canonical_article` ON `article_identities` (`canonical_article_id`);--> statement-breakpoint
CREATE INDEX `idx_article_identities_status_updated` ON `article_identities` (`status`,`updated_at`);--> statement-breakpoint
CREATE TABLE `article_identity_members` (
	`id` text PRIMARY KEY NOT NULL,
	`identity_id` text NOT NULL,
	`object_kind` text NOT NULL,
	`object_id` text NOT NULL,
	`article_id` text,
	`revision_id` text,
	`body_sha256` text,
	`role` text NOT NULL,
	`state` text DEFAULT 'active' NOT NULL,
	`hidden_from_primary` integer DEFAULT false NOT NULL,
	`evidence_json` text DEFAULT '[]' NOT NULL,
	`input_sha256` text NOT NULL,
	`operation_id` text NOT NULL,
	`lock_version` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "article_identity_members_kind_check" CHECK("article_identity_members"."object_kind" IN ('article','branch','revision','package','corpus_article','corpus_version','artifact')),
	CONSTRAINT "article_identity_members_role_check" CHECK("article_identity_members"."role" IN ('canonical','legacy_root','branch','revision','adaptation','source','auxiliary','owner_repair')),
	CONSTRAINT "article_identity_members_state_check" CHECK("article_identity_members"."state" IN ('active','superseded','archived')),
	CONSTRAINT "article_identity_members_sha_check" CHECK("article_identity_members"."body_sha256" IS NULL OR (length("article_identity_members"."body_sha256") = 64 AND "article_identity_members"."body_sha256" NOT GLOB '*[^0-9a-f]*')),
	CONSTRAINT "article_identity_members_input_sha_check" CHECK(length("article_identity_members"."input_sha256") = 64 AND "article_identity_members"."input_sha256" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "article_identity_members_lock_check" CHECK("article_identity_members"."lock_version" >= 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_article_identity_members_object` ON `article_identity_members` (`object_kind`,`object_id`);--> statement-breakpoint
CREATE INDEX `idx_article_identity_members_identity_state` ON `article_identity_members` (`identity_id`,`state`,`object_kind`);--> statement-breakpoint
CREATE INDEX `idx_article_identity_members_article` ON `article_identity_members` (`article_id`,`state`);--> statement-breakpoint
CREATE INDEX `idx_article_identity_members_operation` ON `article_identity_members` (`operation_id`);--> statement-breakpoint
CREATE TABLE `article_identity_operations` (
	`id` text PRIMARY KEY NOT NULL,
	`operation_kind` text NOT NULL,
	`status` text DEFAULT 'planned' NOT NULL,
	`identity_id` text,
	`command_id` text NOT NULL,
	`actor_id` text NOT NULL,
	`applied_by` text,
	`rolled_back_by` text,
	`plan_json` text NOT NULL,
	`plan_sha256` text NOT NULL,
	`preconditions_json` text NOT NULL,
	`preconditions_sha256` text NOT NULL,
	`inverse_json` text NOT NULL,
	`result_json` text DEFAULT '{}' NOT NULL,
	`sentinel` text NOT NULL,
	`lock_version` integer DEFAULT 1 NOT NULL,
	`planned_at` text NOT NULL,
	`applied_at` text,
	`rolled_back_at` text,
	`updated_at` text NOT NULL,
	CONSTRAINT "article_identity_operations_kind_check" CHECK("article_identity_operations"."operation_kind" IN ('candidate_scan','consolidation','source_owner_repair','candidate_decision')),
	CONSTRAINT "article_identity_operations_status_check" CHECK("article_identity_operations"."status" IN ('planned','applied','rolled_back')),
	CONSTRAINT "article_identity_operations_plan_sha_check" CHECK(length("article_identity_operations"."plan_sha256") = 64 AND "article_identity_operations"."plan_sha256" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "article_identity_operations_precondition_sha_check" CHECK(length("article_identity_operations"."preconditions_sha256") = 64 AND "article_identity_operations"."preconditions_sha256" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "article_identity_operations_lock_check" CHECK("article_identity_operations"."lock_version" >= 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_article_identity_operations_command` ON `article_identity_operations` (`command_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_article_identity_operations_sentinel` ON `article_identity_operations` (`sentinel`);--> statement-breakpoint
CREATE INDEX `idx_article_identity_operations_identity_status` ON `article_identity_operations` (`identity_id`,`status`,`updated_at`);--> statement-breakpoint
CREATE TABLE `article_lineage_links` (
	`id` text PRIMARY KEY NOT NULL,
	`identity_id` text,
	`relation_type` text NOT NULL,
	`source_kind` text NOT NULL,
	`source_id` text NOT NULL,
	`source_article_id` text,
	`source_revision_id` text,
	`source_body_sha256` text,
	`target_kind` text NOT NULL,
	`target_id` text NOT NULL,
	`target_article_id` text,
	`target_revision_id` text,
	`target_body_sha256` text,
	`status` text DEFAULT 'candidate' NOT NULL,
	`evidence_json` text DEFAULT '[]' NOT NULL,
	`input_sha256` text NOT NULL,
	`operation_id` text NOT NULL,
	`decided_by` text,
	`decided_at` text,
	`lock_version` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "article_lineage_links_status_check" CHECK("article_lineage_links"."status" IN ('candidate','confirmed','rejected','superseded')),
	CONSTRAINT "article_lineage_links_source_sha_check" CHECK("article_lineage_links"."source_body_sha256" IS NULL OR (length("article_lineage_links"."source_body_sha256") = 64 AND "article_lineage_links"."source_body_sha256" NOT GLOB '*[^0-9a-f]*')),
	CONSTRAINT "article_lineage_links_target_sha_check" CHECK("article_lineage_links"."target_body_sha256" IS NULL OR (length("article_lineage_links"."target_body_sha256") = 64 AND "article_lineage_links"."target_body_sha256" NOT GLOB '*[^0-9a-f]*')),
	CONSTRAINT "article_lineage_links_input_sha_check" CHECK(length("article_lineage_links"."input_sha256") = 64 AND "article_lineage_links"."input_sha256" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "article_lineage_links_lock_check" CHECK("article_lineage_links"."lock_version" >= 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_article_lineage_links_relation` ON `article_lineage_links` (`relation_type`,`source_kind`,`source_id`,`target_kind`,`target_id`);--> statement-breakpoint
CREATE INDEX `idx_article_lineage_links_identity_status` ON `article_lineage_links` (`identity_id`,`status`,`updated_at`);--> statement-breakpoint
CREATE INDEX `idx_article_lineage_links_operation` ON `article_lineage_links` (`operation_id`);--> statement-breakpoint
CREATE INDEX `idx_article_lineage_links_articles` ON `article_lineage_links` (`source_article_id`,`target_article_id`);