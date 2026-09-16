CREATE TABLE `annotation_rsi_baseline_revisions` (
	`id` text PRIMARY KEY NOT NULL,
	`candidate_id` text NOT NULL,
	`candidate_sha256` text NOT NULL,
	`article_id` text NOT NULL,
	`revision` integer NOT NULL,
	`parent_revision_id` text,
	`parent_revision_sha256` text,
	`revision_json` text NOT NULL,
	`revision_sha256` text NOT NULL,
	`approval_command_id` text NOT NULL,
	`approval_actor_id` text NOT NULL,
	`approval_principal_id` text NOT NULL,
	`approval_auth_basis` text NOT NULL,
	`approval_note` text NOT NULL,
	`approved_at` text NOT NULL,
	FOREIGN KEY (`candidate_id`) REFERENCES `annotation_rsi_rule_candidates`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`parent_revision_id`) REFERENCES `annotation_rsi_baseline_revisions`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "annotation_rsi_baseline_revision_check" CHECK("annotation_rsi_baseline_revisions"."revision" >= 1),
	CONSTRAINT "annotation_rsi_baseline_json_check" CHECK(json_valid("annotation_rsi_baseline_revisions"."revision_json") AND json_type("annotation_rsi_baseline_revisions"."revision_json") = 'object'),
	CONSTRAINT "annotation_rsi_baseline_sha_check" CHECK(length("annotation_rsi_baseline_revisions"."revision_sha256") = 64 AND "annotation_rsi_baseline_revisions"."revision_sha256" NOT GLOB '*[^0-9a-f]*' AND (("annotation_rsi_baseline_revisions"."parent_revision_id" IS NULL AND "annotation_rsi_baseline_revisions"."parent_revision_sha256" IS NULL AND "annotation_rsi_baseline_revisions"."revision"=1) OR ("annotation_rsi_baseline_revisions"."parent_revision_id" IS NOT NULL AND length("annotation_rsi_baseline_revisions"."parent_revision_sha256")=64 AND "annotation_rsi_baseline_revisions"."parent_revision_sha256" NOT GLOB '*[^0-9a-f]*' AND "annotation_rsi_baseline_revisions"."revision">1))),
	CONSTRAINT "annotation_rsi_baseline_approval_check" CHECK("annotation_rsi_baseline_revisions"."approval_auth_basis" IN ('owner_pairing','trusted_device'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_annotation_rsi_baseline_candidate` ON `annotation_rsi_baseline_revisions` (`candidate_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_annotation_rsi_baseline_article_revision` ON `annotation_rsi_baseline_revisions` (`article_id`,`revision`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_annotation_rsi_baseline_revision_sha` ON `annotation_rsi_baseline_revisions` (`revision_sha256`);--> statement-breakpoint
CREATE TABLE `annotation_rsi_due_checks` (
	`id` text PRIMARY KEY NOT NULL,
	`article_id` text NOT NULL,
	`project_id` text NOT NULL,
	`trigger_kind` text NOT NULL,
	`last_checked_at` text NOT NULL,
	`next_due_at` text NOT NULL,
	`source_set_sha256` text NOT NULL,
	`source_summary_json` text NOT NULL,
	CONSTRAINT "annotation_rsi_due_check_trigger_check" CHECK("annotation_rsi_due_checks"."trigger_kind" IN ('new_task','task_terminal','review_due','external_ai_change')),
	CONSTRAINT "annotation_rsi_due_check_summary_check" CHECK(json_valid("annotation_rsi_due_checks"."source_summary_json") AND json_type("annotation_rsi_due_checks"."source_summary_json")='object' AND length("annotation_rsi_due_checks"."source_set_sha256")=64 AND "annotation_rsi_due_checks"."source_set_sha256" NOT GLOB '*[^0-9a-f]*')
);
--> statement-breakpoint
CREATE INDEX `idx_annotation_rsi_due_check_next_due` ON `annotation_rsi_due_checks` (`next_due_at`,`article_id`);--> statement-breakpoint
CREATE TABLE `annotation_rsi_rule_candidates` (
	`id` text PRIMARY KEY NOT NULL,
	`article_id` text NOT NULL,
	`project_id` text,
	`variant_scope_json` text DEFAULT '[]' NOT NULL,
	`source_bindings_json` text NOT NULL,
	`source_set_sha256` text NOT NULL,
	`canonical_rule_json` text NOT NULL,
	`canonical_rule_sha256` text NOT NULL,
	`candidate_sha256` text NOT NULL,
	`status` text DEFAULT 'candidate' NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL,
	`decided_by` text,
	`decided_at` text,
	`decision_note` text,
	`lock_version` integer DEFAULT 1 NOT NULL,
	CONSTRAINT "annotation_rsi_rule_candidate_status_check" CHECK("annotation_rsi_rule_candidates"."status" IN ('candidate','approved')),
	CONSTRAINT "annotation_rsi_rule_candidate_json_check" CHECK(json_valid("annotation_rsi_rule_candidates"."variant_scope_json") AND json_type("annotation_rsi_rule_candidates"."variant_scope_json") = 'array' AND json_valid("annotation_rsi_rule_candidates"."source_bindings_json") AND json_type("annotation_rsi_rule_candidates"."source_bindings_json") = 'array' AND json_array_length("annotation_rsi_rule_candidates"."source_bindings_json") > 0 AND json_valid("annotation_rsi_rule_candidates"."canonical_rule_json") AND json_type("annotation_rsi_rule_candidates"."canonical_rule_json") = 'object'),
	CONSTRAINT "annotation_rsi_rule_candidate_sha_check" CHECK(length("annotation_rsi_rule_candidates"."source_set_sha256") = 64 AND "annotation_rsi_rule_candidates"."source_set_sha256" NOT GLOB '*[^0-9a-f]*' AND length("annotation_rsi_rule_candidates"."canonical_rule_sha256") = 64 AND "annotation_rsi_rule_candidates"."canonical_rule_sha256" NOT GLOB '*[^0-9a-f]*' AND length("annotation_rsi_rule_candidates"."candidate_sha256") = 64 AND "annotation_rsi_rule_candidates"."candidate_sha256" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "annotation_rsi_rule_candidate_decision_check" CHECK(("annotation_rsi_rule_candidates"."status"='candidate' AND "annotation_rsi_rule_candidates"."decided_by" IS NULL AND "annotation_rsi_rule_candidates"."decided_at" IS NULL AND "annotation_rsi_rule_candidates"."decision_note" IS NULL) OR ("annotation_rsi_rule_candidates"."status"='approved' AND "annotation_rsi_rule_candidates"."decided_by" IS NOT NULL AND "annotation_rsi_rule_candidates"."decided_at" IS NOT NULL AND "annotation_rsi_rule_candidates"."decision_note" IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_annotation_rsi_rule_candidate_sha` ON `annotation_rsi_rule_candidates` (`article_id`,`candidate_sha256`);--> statement-breakpoint
CREATE INDEX `idx_annotation_rsi_rule_candidate_article_status` ON `annotation_rsi_rule_candidates` (`article_id`,`status`,`created_at`);--> statement-breakpoint
CREATE TABLE `shared_source_access_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`source_id` text NOT NULL,
	`version_id` text NOT NULL,
	`subject_kind` text NOT NULL,
	`subject_ref` text NOT NULL,
	`capability` text NOT NULL,
	`result` text NOT NULL,
	`authz_fingerprint_sha256` text NOT NULL,
	`evidence_kind` text NOT NULL,
	`provider_account_ref_sha256` text,
	`observed_at` text NOT NULL,
	`valid_until` text,
	`snapshot_json` text NOT NULL,
	`snapshot_sha256` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`version_id`,`source_id`) REFERENCES `shared_source_versions`(`id`,`source_id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "shared_source_access_snapshots_capability_check" CHECK("shared_source_access_snapshots"."capability" IN ('metadata','content','bind')),
	CONSTRAINT "shared_source_access_snapshots_result_check" CHECK("shared_source_access_snapshots"."result" IN ('granted','denied','unknown')),
	CONSTRAINT "shared_source_access_snapshots_evidence_kind_check" CHECK("shared_source_access_snapshots"."evidence_kind" IN ('manual_declaration','local_readback','provider_readback')),
	CONSTRAINT "shared_source_access_snapshots_json_check" CHECK(json_valid("shared_source_access_snapshots"."snapshot_json") AND json_type("shared_source_access_snapshots"."snapshot_json") = 'object'),
	CONSTRAINT "shared_source_access_snapshots_sha_check" CHECK(length("shared_source_access_snapshots"."authz_fingerprint_sha256") = 64 AND "shared_source_access_snapshots"."authz_fingerprint_sha256" NOT GLOB '*[^0-9a-f]*' AND length("shared_source_access_snapshots"."snapshot_sha256") = 64 AND "shared_source_access_snapshots"."snapshot_sha256" NOT GLOB '*[^0-9a-f]*' AND ("shared_source_access_snapshots"."provider_account_ref_sha256" IS NULL OR (length("shared_source_access_snapshots"."provider_account_ref_sha256") = 64 AND "shared_source_access_snapshots"."provider_account_ref_sha256" NOT GLOB '*[^0-9a-f]*'))),
	CONSTRAINT "shared_source_access_snapshots_time_check" CHECK(("shared_source_access_snapshots"."result" <> 'granted' AND ("shared_source_access_snapshots"."valid_until" IS NULL OR "shared_source_access_snapshots"."valid_until" > "shared_source_access_snapshots"."observed_at")) OR ("shared_source_access_snapshots"."result" = 'granted' AND "shared_source_access_snapshots"."valid_until" IS NOT NULL AND "shared_source_access_snapshots"."valid_until" > "shared_source_access_snapshots"."observed_at"))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_shared_source_access_observation` ON `shared_source_access_snapshots` (`source_id`,`version_id`,`subject_kind`,`subject_ref`,`capability`,`observed_at`);--> statement-breakpoint
CREATE INDEX `idx_shared_source_access_source_version_observed` ON `shared_source_access_snapshots` (`source_id`,`version_id`,`observed_at`);--> statement-breakpoint
CREATE TABLE `shared_source_bindings` (
	`id` text PRIMARY KEY NOT NULL,
	`source_id` text NOT NULL,
	`version_id` text NOT NULL,
	`package_id` text,
	`project_group_id` text,
	`package_source_ref_id` text,
	`target_key` text NOT NULL,
	`generation` integer NOT NULL,
	`action` text NOT NULL,
	`supersedes_binding_id` text,
	`actor` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`version_id`,`source_id`) REFERENCES `shared_source_versions`(`id`,`source_id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`project_group_id`) REFERENCES `project_groups`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`package_source_ref_id`,`package_id`) REFERENCES `package_source_refs`(`id`,`package_id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`supersedes_binding_id`) REFERENCES `shared_source_bindings`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "shared_source_bindings_target_check" CHECK(("shared_source_bindings"."package_id" IS NOT NULL AND "shared_source_bindings"."project_group_id" IS NULL AND "shared_source_bindings"."package_source_ref_id" IS NOT NULL) OR ("shared_source_bindings"."package_id" IS NULL AND "shared_source_bindings"."project_group_id" IS NOT NULL AND "shared_source_bindings"."package_source_ref_id" IS NULL)),
	CONSTRAINT "shared_source_bindings_generation_check" CHECK("shared_source_bindings"."generation" >= 1),
	CONSTRAINT "shared_source_bindings_action_check" CHECK("shared_source_bindings"."action" IN ('attach','tombstone'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_shared_source_bindings_package_generation` ON `shared_source_bindings` (`package_id`,`target_key`,`generation`) WHERE "shared_source_bindings"."package_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_shared_source_bindings_group_generation` ON `shared_source_bindings` (`project_group_id`,`target_key`,`generation`) WHERE "shared_source_bindings"."project_group_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_shared_source_bindings_successor` ON `shared_source_bindings` (`supersedes_binding_id`) WHERE "shared_source_bindings"."supersedes_binding_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_shared_source_bindings_source_version_created` ON `shared_source_bindings` (`source_id`,`version_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `shared_source_effective_access_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`source_id` text NOT NULL,
	`version_id` text NOT NULL,
	`subject_kind` text NOT NULL,
	`subject_ref_hmac_sha256` text NOT NULL,
	`hmac_key_id` text NOT NULL,
	`authority_plane` text NOT NULL,
	`capability` text NOT NULL,
	`result` text NOT NULL,
	`grant_origin` text NOT NULL,
	`inherited_from_source_id` text,
	`inherited_from_version_id` text,
	`authz_fingerprint_sha256` text NOT NULL,
	`evidence_kind` text NOT NULL,
	`observed_at` text NOT NULL,
	`valid_until` text,
	`snapshot_sha256` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`version_id`,`source_id`) REFERENCES `shared_source_versions`(`id`,`source_id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`inherited_from_version_id`,`inherited_from_source_id`) REFERENCES `shared_source_versions`(`id`,`source_id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "shared_source_effective_access_subject_check" CHECK("shared_source_effective_access_snapshots"."subject_kind" IN ('agent_client','management_principal','service') AND length("shared_source_effective_access_snapshots"."subject_ref_hmac_sha256") = 64 AND "shared_source_effective_access_snapshots"."subject_ref_hmac_sha256" NOT GLOB '*[^0-9a-f]*' AND length("shared_source_effective_access_snapshots"."hmac_key_id") BETWEEN 1 AND 80),
	CONSTRAINT "shared_source_effective_access_plane_check" CHECK("shared_source_effective_access_snapshots"."authority_plane" IN ('provider','wenmai')),
	CONSTRAINT "shared_source_effective_access_capability_check" CHECK("shared_source_effective_access_snapshots"."capability" IN ('metadata','content','children','bind','edit_metadata','edit_content')),
	CONSTRAINT "shared_source_effective_access_result_check" CHECK("shared_source_effective_access_snapshots"."result" IN ('granted','denied','unknown','expired','not_applicable')),
	CONSTRAINT "shared_source_effective_access_origin_check" CHECK("shared_source_effective_access_snapshots"."grant_origin" IN ('direct','inherited','owner','local_policy','unknown') AND (("shared_source_effective_access_snapshots"."grant_origin" = 'inherited' AND "shared_source_effective_access_snapshots"."inherited_from_source_id" IS NOT NULL AND "shared_source_effective_access_snapshots"."inherited_from_version_id" IS NOT NULL) OR ("shared_source_effective_access_snapshots"."grant_origin" <> 'inherited' AND "shared_source_effective_access_snapshots"."inherited_from_source_id" IS NULL AND "shared_source_effective_access_snapshots"."inherited_from_version_id" IS NULL))),
	CONSTRAINT "shared_source_effective_access_fingerprint_check" CHECK(length("shared_source_effective_access_snapshots"."authz_fingerprint_sha256") = 64 AND "shared_source_effective_access_snapshots"."authz_fingerprint_sha256" NOT GLOB '*[^0-9a-f]*' AND length("shared_source_effective_access_snapshots"."snapshot_sha256") = 64 AND "shared_source_effective_access_snapshots"."snapshot_sha256" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "shared_source_effective_access_evidence_check" CHECK("shared_source_effective_access_snapshots"."evidence_kind" IN ('provider_readback','local_readback','manual_declaration')),
	CONSTRAINT "shared_source_effective_access_grant_check" CHECK("shared_source_effective_access_snapshots"."result" <> 'granted' OR ("shared_source_effective_access_snapshots"."valid_until" IS NOT NULL AND "shared_source_effective_access_snapshots"."valid_until" > "shared_source_effective_access_snapshots"."observed_at")),
	CONSTRAINT "shared_source_effective_access_provider_check" CHECK("shared_source_effective_access_snapshots"."authority_plane" <> 'provider' OR "shared_source_effective_access_snapshots"."result" <> 'granted' OR "shared_source_effective_access_snapshots"."evidence_kind" = 'provider_readback'),
	CONSTRAINT "shared_source_effective_access_time_check" CHECK(("shared_source_effective_access_snapshots"."valid_until" IS NULL OR "shared_source_effective_access_snapshots"."valid_until" > "shared_source_effective_access_snapshots"."observed_at") AND "shared_source_effective_access_snapshots"."observed_at" <= "shared_source_effective_access_snapshots"."created_at")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_shared_source_effective_access_observation` ON `shared_source_effective_access_snapshots` (`source_id`,`version_id`,`subject_kind`,`subject_ref_hmac_sha256`,`hmac_key_id`,`authority_plane`,`capability`,`observed_at`);--> statement-breakpoint
CREATE TABLE `shared_source_events` (
	`id` text PRIMARY KEY NOT NULL,
	`command_id` text NOT NULL,
	`source_id` text,
	`version_id` text,
	`binding_id` text,
	`event_type` text NOT NULL,
	`actor` text NOT NULL,
	`request_sha256` text NOT NULL,
	`before_status` text,
	`after_status` text,
	`readback_json` text DEFAULT '{}' NOT NULL,
	`created_at` text NOT NULL,
	`completed_at` text NOT NULL,
	FOREIGN KEY (`source_id`) REFERENCES `shared_sources`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`version_id`,`source_id`) REFERENCES `shared_source_versions`(`id`,`source_id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`binding_id`) REFERENCES `shared_source_bindings`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "shared_source_events_source_presence_check" CHECK(("shared_source_events"."version_id" IS NULL OR "shared_source_events"."source_id" IS NOT NULL) AND (("shared_source_events"."before_status" IS NULL AND "shared_source_events"."after_status" IS NULL) OR "shared_source_events"."source_id" IS NOT NULL) AND ("shared_source_events"."binding_id" IS NULL OR "shared_source_events"."source_id" IS NOT NULL)),
	CONSTRAINT "shared_source_events_request_sha_check" CHECK(length("shared_source_events"."request_sha256") = 64 AND "shared_source_events"."request_sha256" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "shared_source_events_status_check" CHECK(("shared_source_events"."before_status" IS NULL OR "shared_source_events"."before_status" IN ('active','access_suspended','tombstoned')) AND ("shared_source_events"."after_status" IS NULL OR "shared_source_events"."after_status" IN ('active','access_suspended','tombstoned'))),
	CONSTRAINT "shared_source_events_readback_json_check" CHECK(json_valid("shared_source_events"."readback_json") AND json_type("shared_source_events"."readback_json") = 'object'),
	CONSTRAINT "shared_source_events_time_check" CHECK("shared_source_events"."completed_at" >= "shared_source_events"."created_at")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_shared_source_events_command` ON `shared_source_events` (`command_id`);--> statement-breakpoint
CREATE INDEX `idx_shared_source_events_source_created` ON `shared_source_events` (`source_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `shared_source_object_profiles` (
	`id` text PRIMARY KEY NOT NULL,
	`source_id` text NOT NULL,
	`object_kind` text NOT NULL,
	`ingestion_surface` text NOT NULL,
	`space_kind` text NOT NULL,
	`provider_namespace` text,
	`provider_tenant_hmac_sha256` text,
	`provider_object_hmac_sha256` text,
	`provider_account_hmac_sha256` text,
	`provider_occurrence_hmac_sha256` text,
	`hmac_key_id` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`source_id`) REFERENCES `shared_sources`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "shared_source_object_profiles_kind_check" CHECK("shared_source_object_profiles"."object_kind" IN ('file','folder','collection')),
	CONSTRAINT "shared_source_object_profiles_surface_check" CHECK("shared_source_object_profiles"."ingestion_surface" IN ('manual','chatgpt_library','google_drive','unknown')),
	CONSTRAINT "shared_source_object_profiles_space_check" CHECK("shared_source_object_profiles"."space_kind" IN ('local','chatgpt_library','google_my_drive','google_shared_with_me','google_shared_drive','unknown')),
	CONSTRAINT "shared_source_object_profiles_provider_tuple_check" CHECK(("shared_source_object_profiles"."provider_namespace" IS NULL AND "shared_source_object_profiles"."provider_tenant_hmac_sha256" IS NULL AND "shared_source_object_profiles"."provider_object_hmac_sha256" IS NULL AND "shared_source_object_profiles"."provider_account_hmac_sha256" IS NULL AND "shared_source_object_profiles"."provider_occurrence_hmac_sha256" IS NULL AND "shared_source_object_profiles"."hmac_key_id" IS NULL) OR ("shared_source_object_profiles"."provider_namespace" IS NOT NULL AND length("shared_source_object_profiles"."provider_namespace") BETWEEN 1 AND 80 AND "shared_source_object_profiles"."hmac_key_id" IS NOT NULL AND length("shared_source_object_profiles"."hmac_key_id") BETWEEN 1 AND 80 AND length("shared_source_object_profiles"."provider_tenant_hmac_sha256") = 64 AND "shared_source_object_profiles"."provider_tenant_hmac_sha256" NOT GLOB '*[^0-9a-f]*' AND length("shared_source_object_profiles"."provider_object_hmac_sha256") = 64 AND "shared_source_object_profiles"."provider_object_hmac_sha256" NOT GLOB '*[^0-9a-f]*' AND length("shared_source_object_profiles"."provider_account_hmac_sha256") = 64 AND "shared_source_object_profiles"."provider_account_hmac_sha256" NOT GLOB '*[^0-9a-f]*' AND length("shared_source_object_profiles"."provider_occurrence_hmac_sha256") = 64 AND "shared_source_object_profiles"."provider_occurrence_hmac_sha256" NOT GLOB '*[^0-9a-f]*'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_shared_source_object_profile_source` ON `shared_source_object_profiles` (`source_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_shared_source_object_profile_provider_identity` ON `shared_source_object_profiles` (`provider_namespace`,`provider_tenant_hmac_sha256`,`provider_object_hmac_sha256`,`provider_account_hmac_sha256`,`provider_occurrence_hmac_sha256`,`hmac_key_id`) WHERE "shared_source_object_profiles"."provider_namespace" IS NOT NULL;--> statement-breakpoint
CREATE TABLE `shared_source_provider_capability_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`surface` text NOT NULL,
	`space_kind` text NOT NULL,
	`provider_namespace` text,
	`provider_account_hmac_sha256` text,
	`hmac_key_id` text,
	`capability` text NOT NULL,
	`result` text NOT NULL,
	`conditions_json` text DEFAULT '{}' NOT NULL,
	`evidence_kind` text NOT NULL,
	`evidence_sha256` text NOT NULL,
	`observed_at` text NOT NULL,
	`valid_until` text,
	`snapshot_sha256` text NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT "shared_source_provider_capability_surface_check" CHECK("shared_source_provider_capability_snapshots"."surface" IN ('chatgpt_library_ui','google_drive_ui','general_api','wenmai_connector')),
	CONSTRAINT "shared_source_provider_capability_space_check" CHECK("shared_source_provider_capability_snapshots"."space_kind" IN ('local','chatgpt_library','google_my_drive','google_shared_with_me','google_shared_drive','unknown')),
	CONSTRAINT "shared_source_provider_capability_name_check" CHECK("shared_source_provider_capability_snapshots"."capability" IN ('file_reuse','folder_selection','my_drive','shared_with_me','shared_drive','metadata','content','children','bind','edit_metadata','edit_content')),
	CONSTRAINT "shared_source_provider_capability_result_check" CHECK("shared_source_provider_capability_snapshots"."result" IN ('supported','unsupported','conditional','unverified','unconfigured','blocked')),
	CONSTRAINT "shared_source_provider_capability_provider_check" CHECK(("shared_source_provider_capability_snapshots"."provider_namespace" IS NULL AND "shared_source_provider_capability_snapshots"."provider_account_hmac_sha256" IS NULL AND "shared_source_provider_capability_snapshots"."hmac_key_id" IS NULL) OR ("shared_source_provider_capability_snapshots"."provider_namespace" IS NOT NULL AND length("shared_source_provider_capability_snapshots"."provider_account_hmac_sha256") = 64 AND "shared_source_provider_capability_snapshots"."provider_account_hmac_sha256" NOT GLOB '*[^0-9a-f]*' AND length("shared_source_provider_capability_snapshots"."hmac_key_id") BETWEEN 1 AND 80)),
	CONSTRAINT "shared_source_provider_capability_json_check" CHECK(json_valid("shared_source_provider_capability_snapshots"."conditions_json") AND json_type("shared_source_provider_capability_snapshots"."conditions_json") = 'object'),
	CONSTRAINT "shared_source_provider_capability_sha_check" CHECK(length("shared_source_provider_capability_snapshots"."evidence_sha256") = 64 AND "shared_source_provider_capability_snapshots"."evidence_sha256" NOT GLOB '*[^0-9a-f]*' AND length("shared_source_provider_capability_snapshots"."snapshot_sha256") = 64 AND "shared_source_provider_capability_snapshots"."snapshot_sha256" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "shared_source_provider_capability_evidence_check" CHECK("shared_source_provider_capability_snapshots"."evidence_kind" IN ('official_release_notes','official_help','provider_readback','local_readback','manual_declaration')),
	CONSTRAINT "shared_source_provider_capability_time_check" CHECK(("shared_source_provider_capability_snapshots"."valid_until" IS NULL OR "shared_source_provider_capability_snapshots"."valid_until" > "shared_source_provider_capability_snapshots"."observed_at") AND "shared_source_provider_capability_snapshots"."observed_at" <= "shared_source_provider_capability_snapshots"."created_at")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_shared_source_provider_capability_observation` ON `shared_source_provider_capability_snapshots` (`surface`,`space_kind`,`provider_namespace`,`provider_account_hmac_sha256`,`hmac_key_id`,`capability`,`observed_at`);--> statement-breakpoint
CREATE TABLE `shared_source_remote_state_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`source_id` text NOT NULL,
	`version_id` text NOT NULL,
	`state` text NOT NULL,
	`evidence_kind` text NOT NULL,
	`evidence_sha256` text NOT NULL,
	`observed_at` text NOT NULL,
	`snapshot_sha256` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`version_id`,`source_id`) REFERENCES `shared_source_versions`(`id`,`source_id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "shared_source_remote_state_name_check" CHECK("shared_source_remote_state_snapshots"."state" IN ('present','deleted','access_lost','unknown')),
	CONSTRAINT "shared_source_remote_state_evidence_check" CHECK("shared_source_remote_state_snapshots"."evidence_kind" IN ('provider_readback','local_readback','manual_declaration')),
	CONSTRAINT "shared_source_remote_state_sha_check" CHECK(length("shared_source_remote_state_snapshots"."evidence_sha256") = 64 AND "shared_source_remote_state_snapshots"."evidence_sha256" NOT GLOB '*[^0-9a-f]*' AND length("shared_source_remote_state_snapshots"."snapshot_sha256") = 64 AND "shared_source_remote_state_snapshots"."snapshot_sha256" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "shared_source_remote_state_time_check" CHECK("shared_source_remote_state_snapshots"."observed_at" <= "shared_source_remote_state_snapshots"."created_at")
);
--> statement-breakpoint
CREATE INDEX `idx_shared_source_remote_state_version_observed` ON `shared_source_remote_state_snapshots` (`source_id`,`version_id`,`observed_at`,`created_at`,`id`);--> statement-breakpoint
CREATE TABLE `shared_source_rights_assertions` (
	`id` text PRIMARY KEY NOT NULL,
	`source_id` text NOT NULL,
	`version_id` text NOT NULL,
	`rights_holder_kind` text,
	`rights_holder_ref` text,
	`decision` text NOT NULL,
	`basis` text NOT NULL,
	`allowed_uses_json` text DEFAULT '[]' NOT NULL,
	`restrictions_json` text DEFAULT '[]' NOT NULL,
	`valid_from` text NOT NULL,
	`valid_until` text,
	`asserted_by_kind` text NOT NULL,
	`asserted_by_ref` text NOT NULL,
	`evidence_sha256` text NOT NULL,
	`supersedes_assertion_id` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`version_id`,`source_id`) REFERENCES `shared_source_versions`(`id`,`source_id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`supersedes_assertion_id`,`source_id`,`version_id`) REFERENCES `shared_source_rights_assertions`(`id`,`source_id`,`version_id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "shared_source_rights_assertions_decision_check" CHECK("shared_source_rights_assertions"."decision" IN ('allow','deny','unknown')),
	CONSTRAINT "shared_source_rights_assertions_holder_tuple_check" CHECK(("shared_source_rights_assertions"."rights_holder_kind" IS NULL AND "shared_source_rights_assertions"."rights_holder_ref" IS NULL) OR ("shared_source_rights_assertions"."rights_holder_kind" IS NOT NULL AND "shared_source_rights_assertions"."rights_holder_ref" IS NOT NULL)),
	CONSTRAINT "shared_source_rights_assertions_json_check" CHECK(json_valid("shared_source_rights_assertions"."allowed_uses_json") AND json_type("shared_source_rights_assertions"."allowed_uses_json") = 'array' AND json_valid("shared_source_rights_assertions"."restrictions_json") AND json_type("shared_source_rights_assertions"."restrictions_json") = 'array'),
	CONSTRAINT "shared_source_rights_assertions_evidence_sha_check" CHECK(length("shared_source_rights_assertions"."evidence_sha256") = 64 AND "shared_source_rights_assertions"."evidence_sha256" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "shared_source_rights_assertions_time_check" CHECK("shared_source_rights_assertions"."valid_until" IS NULL OR "shared_source_rights_assertions"."valid_until" >= "shared_source_rights_assertions"."valid_from")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_shared_source_rights_id_source_version` ON `shared_source_rights_assertions` (`id`,`source_id`,`version_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_shared_source_rights_initial` ON `shared_source_rights_assertions` (`source_id`,`version_id`) WHERE "shared_source_rights_assertions"."supersedes_assertion_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_shared_source_rights_successor` ON `shared_source_rights_assertions` (`supersedes_assertion_id`) WHERE "shared_source_rights_assertions"."supersedes_assertion_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_shared_source_rights_source_version_created` ON `shared_source_rights_assertions` (`source_id`,`version_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `shared_source_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`source_id` text NOT NULL,
	`version_no` integer NOT NULL,
	`materialization_kind` text NOT NULL,
	`content_ref` text,
	`media_type` text NOT NULL,
	`size_bytes` integer,
	`content_sha256` text,
	`metadata_json` text DEFAULT '{}' NOT NULL,
	`snapshot_sha256` text NOT NULL,
	`provider_revision_key_sha256` text,
	`captured_at` text NOT NULL,
	`uploader_kind` text NOT NULL,
	`uploader_ref` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`source_id`) REFERENCES `shared_sources`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "shared_source_versions_materialization_check" CHECK("shared_source_versions"."materialization_kind" IN ('local_copy','reference_only')),
	CONSTRAINT "shared_source_versions_version_no_check" CHECK("shared_source_versions"."version_no" >= 1),
	CONSTRAINT "shared_source_versions_content_shape_check" CHECK(("shared_source_versions"."materialization_kind" = 'local_copy' AND "shared_source_versions"."content_ref" IS NOT NULL AND "shared_source_versions"."content_sha256" IS NOT NULL AND length("shared_source_versions"."content_sha256") = 64 AND "shared_source_versions"."content_sha256" NOT GLOB '*[^0-9a-f]*') OR ("shared_source_versions"."materialization_kind" = 'reference_only' AND "shared_source_versions"."content_ref" IS NULL AND "shared_source_versions"."content_sha256" IS NULL)),
	CONSTRAINT "shared_source_versions_size_check" CHECK("shared_source_versions"."size_bytes" IS NULL OR "shared_source_versions"."size_bytes" >= 0),
	CONSTRAINT "shared_source_versions_metadata_json_check" CHECK(json_valid("shared_source_versions"."metadata_json") AND json_type("shared_source_versions"."metadata_json") = 'object'),
	CONSTRAINT "shared_source_versions_snapshot_sha_check" CHECK(length("shared_source_versions"."snapshot_sha256") = 64 AND "shared_source_versions"."snapshot_sha256" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "shared_source_versions_provider_revision_sha_check" CHECK("shared_source_versions"."provider_revision_key_sha256" IS NULL OR (length("shared_source_versions"."provider_revision_key_sha256") = 64 AND "shared_source_versions"."provider_revision_key_sha256" NOT GLOB '*[^0-9a-f]*'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_shared_source_versions_id_source` ON `shared_source_versions` (`id`,`source_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_shared_source_versions_source_no` ON `shared_source_versions` (`source_id`,`version_no`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_shared_source_versions_source_snapshot` ON `shared_source_versions` (`source_id`,`snapshot_sha256`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_shared_source_versions_source_provider_revision` ON `shared_source_versions` (`source_id`,`provider_revision_key_sha256`) WHERE "shared_source_versions"."provider_revision_key_sha256" IS NOT NULL;--> statement-breakpoint
CREATE TABLE `shared_sources` (
	`id` text PRIMARY KEY NOT NULL,
	`source_key` text NOT NULL,
	`origin_kind` text NOT NULL,
	`provider_namespace` text,
	`provider_tenant_key_sha256` text,
	`external_object_key_sha256` text,
	`owner_kind` text NOT NULL,
	`owner_ref` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`lock_version` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`tombstoned_at` text,
	CONSTRAINT "shared_sources_origin_kind_check" CHECK("shared_sources"."origin_kind" IN ('manual_upload','manual_reference')),
	CONSTRAINT "shared_sources_provider_tuple_check" CHECK(("shared_sources"."provider_namespace" IS NULL AND "shared_sources"."provider_tenant_key_sha256" IS NULL AND "shared_sources"."external_object_key_sha256" IS NULL) OR ("shared_sources"."provider_namespace" IS NOT NULL AND "shared_sources"."provider_tenant_key_sha256" IS NOT NULL AND "shared_sources"."external_object_key_sha256" IS NOT NULL AND length("shared_sources"."provider_tenant_key_sha256") = 64 AND "shared_sources"."provider_tenant_key_sha256" NOT GLOB '*[^0-9a-f]*' AND length("shared_sources"."external_object_key_sha256") = 64 AND "shared_sources"."external_object_key_sha256" NOT GLOB '*[^0-9a-f]*')),
	CONSTRAINT "shared_sources_status_check" CHECK("shared_sources"."status" IN ('active','access_suspended','tombstoned')),
	CONSTRAINT "shared_sources_time_check" CHECK("shared_sources"."updated_at" >= "shared_sources"."created_at" AND (("shared_sources"."status" = 'tombstoned' AND "shared_sources"."tombstoned_at" = "shared_sources"."updated_at") OR ("shared_sources"."status" <> 'tombstoned' AND "shared_sources"."tombstoned_at" IS NULL))),
	CONSTRAINT "shared_sources_lock_version_check" CHECK("shared_sources"."lock_version" >= 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_shared_sources_source_key` ON `shared_sources` (`source_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_shared_sources_provider_identity` ON `shared_sources` (`provider_namespace`,`provider_tenant_key_sha256`,`external_object_key_sha256`) WHERE "shared_sources"."provider_namespace" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_package_source_refs_id_package` ON `package_source_refs` (`id`,`package_id`);
--> statement-breakpoint
CREATE TRIGGER `human_annotations_immutable_update` BEFORE UPDATE ON `human_annotations` BEGIN SELECT RAISE(ABORT, 'human-annotation-immutable'); END;
--> statement-breakpoint
CREATE TRIGGER `human_annotations_immutable_delete` BEFORE DELETE ON `human_annotations` BEGIN SELECT RAISE(ABORT, 'human-annotation-immutable'); END;
--> statement-breakpoint
CREATE TRIGGER `annotation_rsi_baseline_revisions_immutable_update` BEFORE UPDATE ON `annotation_rsi_baseline_revisions` BEGIN SELECT RAISE(ABORT, 'annotation-rsi-baseline-immutable'); END;
--> statement-breakpoint
CREATE TRIGGER `annotation_rsi_baseline_revisions_immutable_delete` BEFORE DELETE ON `annotation_rsi_baseline_revisions` BEGIN SELECT RAISE(ABORT, 'annotation-rsi-baseline-immutable'); END;
