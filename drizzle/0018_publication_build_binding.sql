CREATE TABLE `article_publication_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`package_id` text NOT NULL,
	`article_id` text NOT NULL,
	`role` text NOT NULL,
	`version_key` text NOT NULL,
	`platform` text,
	`branch_id` text NOT NULL,
	`branch_lock_version` integer NOT NULL,
	`revision_id` text NOT NULL,
	`body_sha256` text NOT NULL,
	`composition_id` text NOT NULL,
	`composition_sha256` text NOT NULL,
	`target_profile_id` text,
	`target_profile_key` text,
	`target_profile_sha256` text,
	`baseline_version_id` text,
	`baseline_branch_id` text,
	`baseline_revision_id` text,
	`baseline_body_sha256` text,
	`baseline_composition_id` text,
	`baseline_composition_sha256` text,
	`publication_version_json` text NOT NULL,
	`registration_sha256` text NOT NULL,
	`state` text DEFAULT 'active' NOT NULL,
	`lock_version` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "article_publication_versions_role_check" CHECK("article_publication_versions"."role" IN ('canonical_baseline','platform_variant')),
	CONSTRAINT "article_publication_versions_state_check" CHECK("article_publication_versions"."state" IN ('active','superseded')),
	CONSTRAINT "article_publication_versions_lock_check" CHECK("article_publication_versions"."branch_lock_version" >= 1 AND "article_publication_versions"."lock_version" >= 1),
	CONSTRAINT "article_publication_versions_json_check" CHECK(json_valid("article_publication_versions"."publication_version_json") AND json_type("article_publication_versions"."publication_version_json") = 'object'),
	CONSTRAINT "article_publication_versions_sha_check" CHECK(
      length("article_publication_versions"."body_sha256") = 64
      AND length("article_publication_versions"."composition_sha256") = 64
      AND length("article_publication_versions"."registration_sha256") = 64
    ),
	CONSTRAINT "article_publication_versions_shape_check" CHECK(
      ("article_publication_versions"."role" = 'canonical_baseline'
        AND "article_publication_versions"."version_key" = 'canonical'
        AND "article_publication_versions"."platform" IS NULL
        AND "article_publication_versions"."target_profile_id" IS NULL
        AND "article_publication_versions"."target_profile_key" IS NULL
        AND "article_publication_versions"."target_profile_sha256" IS NULL
        AND "article_publication_versions"."baseline_version_id" IS NULL
        AND "article_publication_versions"."baseline_branch_id" IS NULL
        AND "article_publication_versions"."baseline_revision_id" IS NULL
        AND "article_publication_versions"."baseline_body_sha256" IS NULL
        AND "article_publication_versions"."baseline_composition_id" IS NULL
        AND "article_publication_versions"."baseline_composition_sha256" IS NULL)
      OR
      ("article_publication_versions"."role" = 'platform_variant'
        AND "article_publication_versions"."version_key" IN ('maimai','xiaohongshu','zhihu','bilibili')
        AND "article_publication_versions"."platform" = "article_publication_versions"."version_key"
        AND "article_publication_versions"."target_profile_id" IS NOT NULL
        AND "article_publication_versions"."target_profile_key" IS NOT NULL
        AND length("article_publication_versions"."target_profile_sha256") = 64
        AND "article_publication_versions"."baseline_version_id" IS NOT NULL
        AND "article_publication_versions"."baseline_branch_id" IS NOT NULL
        AND "article_publication_versions"."baseline_revision_id" IS NOT NULL
        AND length("article_publication_versions"."baseline_body_sha256") = 64
        AND "article_publication_versions"."baseline_composition_id" IS NOT NULL
        AND length("article_publication_versions"."baseline_composition_sha256") = 64)
    )
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_article_publication_versions_active_key` ON `article_publication_versions` (`package_id`,`version_key`) WHERE "article_publication_versions"."state" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX `idx_article_publication_versions_active_branch` ON `article_publication_versions` (`package_id`,`branch_id`) WHERE "article_publication_versions"."state" = 'active';--> statement-breakpoint
CREATE INDEX `idx_article_publication_versions_article_state` ON `article_publication_versions` (`article_id`,`state`,`updated_at`);--> statement-breakpoint
CREATE TABLE `lifecycle_build_input_bindings` (
	`build_id` text PRIMARY KEY NOT NULL,
	`input_binding_sha256` text NOT NULL,
	`package_id` text NOT NULL,
	`branch_id` text NOT NULL,
	`branch_lock_version` integer NOT NULL,
	`revision_id` text NOT NULL,
	`source_body_sha256` text NOT NULL,
	`composition_id` text NOT NULL,
	`composition_sha256` text NOT NULL,
	`slice_id` text NOT NULL,
	`slice_sha256` text NOT NULL,
	`publication_version_id` text NOT NULL,
	`publication_registration_sha256` text NOT NULL,
	`cover_run_id` text NOT NULL,
	`cover_recipe_id` text NOT NULL,
	`cover_recipe_version` text NOT NULL,
	`cover_recipe_sha256` text NOT NULL,
	`cover_receipt_id` text NOT NULL,
	`cover_receipt_schema_version` text NOT NULL,
	`cover_receipt_json` text NOT NULL,
	`cover_receipt_sha256` text NOT NULL,
	`cover_receipt_chain_json` text NOT NULL,
	`cover_receipt_chain_sha256` text NOT NULL,
	`cover_artifact_sha256` text NOT NULL,
	`cover_baseline_id` text NOT NULL,
	`cover_baseline_sha256` text NOT NULL,
	`cover_profile_sha256` text NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT "lifecycle_build_input_binding_branch_lock_check" CHECK("lifecycle_build_input_bindings"."branch_lock_version" >= 1),
	CONSTRAINT "lifecycle_build_input_binding_receipt_json_check" CHECK(json_valid("lifecycle_build_input_bindings"."cover_receipt_json") AND json_type("lifecycle_build_input_bindings"."cover_receipt_json") = 'object'),
	CONSTRAINT "lifecycle_build_input_binding_chain_json_check" CHECK(json_valid("lifecycle_build_input_bindings"."cover_receipt_chain_json") AND json_type("lifecycle_build_input_bindings"."cover_receipt_chain_json") = 'array'),
	CONSTRAINT "lifecycle_build_input_binding_sha_check" CHECK(
      length("lifecycle_build_input_bindings"."input_binding_sha256") = 64
      AND length("lifecycle_build_input_bindings"."source_body_sha256") = 64
      AND length("lifecycle_build_input_bindings"."composition_sha256") = 64
      AND length("lifecycle_build_input_bindings"."slice_sha256") = 64
      AND length("lifecycle_build_input_bindings"."publication_registration_sha256") = 64
      AND length("lifecycle_build_input_bindings"."cover_recipe_sha256") = 64
      AND length("lifecycle_build_input_bindings"."cover_receipt_sha256") = 64
      AND length("lifecycle_build_input_bindings"."cover_receipt_chain_sha256") = 64
      AND length("lifecycle_build_input_bindings"."cover_artifact_sha256") = 64
      AND length("lifecycle_build_input_bindings"."cover_baseline_sha256") = 64
      AND length("lifecycle_build_input_bindings"."cover_profile_sha256") = 64
    )
);
--> statement-breakpoint
CREATE INDEX `idx_lifecycle_build_input_package_branch` ON `lifecycle_build_input_bindings` (`package_id`,`branch_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_lifecycle_build_input_cover_receipt` ON `lifecycle_build_input_bindings` (`cover_run_id`,`cover_receipt_id`);
