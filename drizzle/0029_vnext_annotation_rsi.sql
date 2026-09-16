CREATE TABLE `article_requirements` (
  `id` text PRIMARY KEY NOT NULL, `article_id` text NOT NULL, `requirement_key` text NOT NULL, `revision` integer DEFAULT 1 NOT NULL, `supersedes_requirement_id` text,
  `package_id` text NOT NULL, `branch_id` text NOT NULL, `base_revision_id` text NOT NULL, `base_body_sha256` text NOT NULL, `title` text NOT NULL, `requirement_text` text NOT NULL,
  `acceptance_json` text DEFAULT '{}' NOT NULL, `priority` text DEFAULT 'should' NOT NULL, `input_sha256` text NOT NULL, `status` text DEFAULT 'draft' NOT NULL, `lock_version` integer DEFAULT 1 NOT NULL,
  `created_by_kind` text NOT NULL, `created_by` text NOT NULL, `accepted_by` text, `accepted_at` text, `superseded_at` text, `cancelled_at` text,
  `create_command_id` text NOT NULL, `last_command_id` text NOT NULL, `created_at` text NOT NULL, `updated_at` text NOT NULL,
  CONSTRAINT "article_requirements_priority_check" CHECK("article_requirements"."priority" IN ('must','should','could')),
  CONSTRAINT "article_requirements_status_check" CHECK("article_requirements"."status" IN ('draft','accepted','superseded','cancelled')),
  CONSTRAINT "article_requirements_created_by_kind_check" CHECK("article_requirements"."created_by_kind" IN ('human','agent')),
  CONSTRAINT "article_requirements_revision_lock_check" CHECK("article_requirements"."revision" >= 1 AND "article_requirements"."lock_version" >= 1),
  CONSTRAINT "article_requirements_sha_check" CHECK(length("article_requirements"."base_body_sha256") = 64 AND "article_requirements"."base_body_sha256" NOT GLOB '*[^0-9a-f]*' AND length("article_requirements"."input_sha256") = 64 AND "article_requirements"."input_sha256" NOT GLOB '*[^0-9a-f]*'),
  CONSTRAINT "article_requirements_acceptance_json_check" CHECK(json_valid("article_requirements"."acceptance_json") AND json_type("article_requirements"."acceptance_json") = 'object'),
  CONSTRAINT "article_requirements_self_supersede_check" CHECK("article_requirements"."supersedes_requirement_id" IS NULL OR "article_requirements"."supersedes_requirement_id" <> "article_requirements"."id"),
  CONSTRAINT "article_requirements_status_time_check" CHECK(("article_requirements"."status" = 'draft' AND "article_requirements"."accepted_at" IS NULL AND "article_requirements"."superseded_at" IS NULL AND "article_requirements"."cancelled_at" IS NULL) OR ("article_requirements"."status" = 'accepted' AND "article_requirements"."accepted_at" IS NOT NULL AND "article_requirements"."superseded_at" IS NULL AND "article_requirements"."cancelled_at" IS NULL) OR ("article_requirements"."status" = 'superseded' AND "article_requirements"."accepted_at" IS NOT NULL AND "article_requirements"."superseded_at" IS NOT NULL AND "article_requirements"."cancelled_at" IS NULL) OR ("article_requirements"."status" = 'cancelled' AND "article_requirements"."accepted_at" IS NULL AND "article_requirements"."superseded_at" IS NULL AND "article_requirements"."cancelled_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_article_requirements_article_key_revision` ON `article_requirements` (`article_id`,`requirement_key`,`revision`);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_article_requirements_create_command` ON `article_requirements` (`create_command_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_article_requirements_accepted_key` ON `article_requirements` (`article_id`,`requirement_key`) WHERE "article_requirements"."status" = 'accepted';
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_article_requirements_supersedes_active` ON `article_requirements` (`supersedes_requirement_id`) WHERE "article_requirements"."supersedes_requirement_id" IS NOT NULL AND "article_requirements"."status" <> 'cancelled';
--> statement-breakpoint
CREATE INDEX `idx_article_requirements_article_status_updated_id` ON `article_requirements` (`article_id`,`status`,`updated_at`,`id`);
--> statement-breakpoint
CREATE INDEX `idx_article_requirements_article_package_branch_base_revision` ON `article_requirements` (`article_id`,`package_id`,`branch_id`,`base_revision_id`);
--> statement-breakpoint
CREATE TABLE `human_annotations` (
  `id` text PRIMARY KEY NOT NULL, `article_id` text NOT NULL, `requirement_id` text NOT NULL, `subject_type` text NOT NULL, `subject_id` text NOT NULL,
  `snapshot_sha256` text NOT NULL, `label_schema_version` integer NOT NULL, `label_kind` text NOT NULL, `verdict` text NOT NULL, `severity` text NOT NULL,
  `note` text DEFAULT '' NOT NULL, `details_json` text DEFAULT '{}' NOT NULL, `evidence_refs_json` text DEFAULT '[]' NOT NULL, `annotation_sha256` text NOT NULL, `supersedes_annotation_id` text,
  `input_sha256` text NOT NULL, `human_actor_id` text NOT NULL, `command_id` text NOT NULL, `created_at` text NOT NULL,
  CONSTRAINT "human_annotations_subject_type_check" CHECK("human_annotations"."subject_type" IN ('article_revision','publication_version','build')),
  CONSTRAINT "human_annotations_label_schema_version_check" CHECK("human_annotations"."label_schema_version" >= 1),
  CONSTRAINT "human_annotations_label_kind_check" CHECK("human_annotations"."label_kind" IN ('requirement_fit','quality','defect','preference')),
  CONSTRAINT "human_annotations_verdict_check" CHECK("human_annotations"."verdict" IN ('pass','fail','inconclusive','not_applicable')),
  CONSTRAINT "human_annotations_severity_check" CHECK("human_annotations"."severity" IN ('info','minor','major','critical')),
  CONSTRAINT "human_annotations_json_check" CHECK(json_valid("human_annotations"."details_json") AND json_type("human_annotations"."details_json") = 'object' AND json_valid("human_annotations"."evidence_refs_json") AND json_type("human_annotations"."evidence_refs_json") = 'array'),
  CONSTRAINT "human_annotations_sha_check" CHECK(length("human_annotations"."snapshot_sha256") = 64 AND "human_annotations"."snapshot_sha256" NOT GLOB '*[^0-9a-f]*' AND length("human_annotations"."annotation_sha256") = 64 AND "human_annotations"."annotation_sha256" NOT GLOB '*[^0-9a-f]*' AND length("human_annotations"."input_sha256") = 64 AND "human_annotations"."input_sha256" NOT GLOB '*[^0-9a-f]*'),
  CONSTRAINT "human_annotations_self_supersede_check" CHECK("human_annotations"."supersedes_annotation_id" IS NULL OR "human_annotations"."supersedes_annotation_id" <> "human_annotations"."id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_human_annotations_command` ON `human_annotations` (`command_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_human_annotations_supersedes` ON `human_annotations` (`supersedes_annotation_id`) WHERE "human_annotations"."supersedes_annotation_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX `idx_human_annotations_article_created_id` ON `human_annotations` (`article_id`,`created_at`,`id`);
--> statement-breakpoint
CREATE INDEX `idx_human_annotations_requirement_created_id` ON `human_annotations` (`requirement_id`,`created_at`,`id`);
--> statement-breakpoint
CREATE INDEX `idx_human_annotations_subject_created_id` ON `human_annotations` (`subject_type`,`subject_id`,`snapshot_sha256`,`created_at`,`id`);
