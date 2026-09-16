CREATE TABLE `lifecycle_metric_definitions` (
	`id` text PRIMARY KEY NOT NULL,
	`definition_key` text NOT NULL,
	`version` text NOT NULL,
	`label` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`value_kind` text NOT NULL,
	`unit` text NOT NULL,
	`missing_policy` text DEFAULT 'unknown' NOT NULL,
	`constraints_json` text DEFAULT '{}' NOT NULL,
	`scope_json` text DEFAULT '{}' NOT NULL,
	`definition_sha256` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT "lifecycle_metric_definitions_value_kind_check" CHECK("lifecycle_metric_definitions"."value_kind" IN ('integer','decimal')),
	CONSTRAINT "lifecycle_metric_definitions_missing_check" CHECK("lifecycle_metric_definitions"."missing_policy" IN ('unknown','reject','not_applicable')),
	CONSTRAINT "lifecycle_metric_definitions_status_check" CHECK("lifecycle_metric_definitions"."status" IN ('active','superseded'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_lifecycle_metric_definitions_key_version` ON `lifecycle_metric_definitions` (`definition_key`,`version`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_lifecycle_metric_definitions_active_key` ON `lifecycle_metric_definitions` (`definition_key`) WHERE "lifecycle_metric_definitions"."status" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX `idx_lifecycle_metric_definitions_sha` ON `lifecycle_metric_definitions` (`definition_sha256`);--> statement-breakpoint
INSERT INTO `lifecycle_metric_definitions`
  (`id`,`definition_key`,`version`,`label`,`description`,`value_kind`,`unit`,`missing_policy`,`constraints_json`,`scope_json`,`definition_sha256`,`status`,`created_at`)
VALUES
  ('metric-definition-raw-views-v1','raw.views','1.0.0','曝光 / Views','来源平台后台显示的原始曝光值；只在同一来源口径下解释，不证明跨平台等价。','integer','count','unknown','{"minimum":0}','{"crossPlatformComparable":false,"kind":"source_platform_raw","normalizationApplied":false,"note":"定义只冻结来源平台原始口径；比较前仍需核对平台、字段和统计窗口。"}','e4823ea13886f01653bb9bec1e15f573ba866a31d8e06e5451a42d0c7fc2a251','active',CURRENT_TIMESTAMP),
  ('metric-definition-raw-reads-v1','raw.reads','1.0.0','有效阅读 / Reads','来源平台后台显示的原始有效阅读值；不同平台可能采用不同判定，不直接横向比较。','integer','count','unknown','{"minimum":0}','{"crossPlatformComparable":false,"kind":"source_platform_raw","normalizationApplied":false,"note":"定义只冻结来源平台原始口径；比较前仍需核对平台、字段和统计窗口。"}','da72af7f0d7cede14f2803b587ba8419480b385ce151888216f321295e964489','active',CURRENT_TIMESTAMP),
  ('metric-definition-raw-completion-rate-v1','raw.completionRate','1.0.0','完成率','来源平台给出的原始完成率，使用 0 到 1 的比例；不推断各平台分母相同。','decimal','ratio_0_1','unknown','{"maximum":1,"minimum":0}','{"crossPlatformComparable":false,"kind":"source_platform_raw","normalizationApplied":false,"note":"定义只冻结来源平台原始口径；比较前仍需核对平台、字段和统计窗口。"}','3c22a3f43593782eee7264ff7291203a86f07ba7e213bf5873c66d2d22da02e7','active',CURRENT_TIMESTAMP),
  ('metric-definition-raw-saves-v1','raw.saves','1.0.0','收藏 / Saves','来源平台后台显示的原始收藏值；只冻结观察，不声称平台行为语义完全相同。','integer','count','unknown','{"minimum":0}','{"crossPlatformComparable":false,"kind":"source_platform_raw","normalizationApplied":false,"note":"定义只冻结来源平台原始口径；比较前仍需核对平台、字段和统计窗口。"}','a356df39b7e5c35dbf48319f10bcf8eeec136c8261dbaaf5705605f10b045340','active',CURRENT_TIMESTAMP),
  ('metric-definition-raw-comments-v1','raw.comments','1.0.0','评论 / Comments','来源平台后台显示的原始评论值；只冻结观察，不含互动质量判断。','integer','count','unknown','{"minimum":0}','{"crossPlatformComparable":false,"kind":"source_platform_raw","normalizationApplied":false,"note":"定义只冻结来源平台原始口径；比较前仍需核对平台、字段和统计窗口。"}','ecf1de3c175fb12637a3e9e36dc5e78ed81a0b758034496a935564b6ab2b70f3','active',CURRENT_TIMESTAMP);--> statement-breakpoint
CREATE TABLE `lifecycle_metric_values` (
	`id` text PRIMARY KEY NOT NULL,
	`snapshot_id` text NOT NULL,
	`release_id` text NOT NULL,
	`project_id` text NOT NULL,
	`article_id` text NOT NULL,
	`definition_id` text NOT NULL,
	`definition_sha256` text NOT NULL,
	`observation_state` text NOT NULL,
	`value_json` text DEFAULT 'null' NOT NULL,
	`value_sha256` text NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT "lifecycle_metric_values_observation_check" CHECK("lifecycle_metric_values"."observation_state" IN ('observed','missing','not_applicable'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_lifecycle_metric_values_snapshot_definition` ON `lifecycle_metric_values` (`snapshot_id`,`definition_id`);--> statement-breakpoint
CREATE INDEX `idx_lifecycle_metric_values_article_snapshot` ON `lifecycle_metric_values` (`article_id`,`snapshot_id`);--> statement-breakpoint
CREATE INDEX `idx_lifecycle_metric_values_definition` ON `lifecycle_metric_values` (`definition_id`,`created_at`);--> statement-breakpoint
ALTER TABLE `lifecycle_metric_snapshots` ADD `definition_set_sha256` text;--> statement-breakpoint
INSERT OR IGNORE INTO `workspace_events`
  (`id`,`event_type`,`subject_type`,`subject_id`,`article_id`,`payload_json`,`input_sha256`,`created_at`)
SELECT
  'event-migration-0012-merge-dedupe-' || ranked.id,
  'merge.migration_staled_duplicate',
  'merge_proposal',
  ranked.id,
  ranked.article_id,
  json_object(
    'migration','0012_hesitant_lorna_dane',
    'reason','duplicate_active_head_tuple',
    'sourceBranchId',ranked.source_branch_id,
    'targetBranchId',ranked.target_branch_id,
    'sourceHeadRevisionId',ranked.source_head_revision_id,
    'targetHeadRevisionId',ranked.target_head_revision_id
  ),
  '203ec52f447ea447c8d53d3f5b794383b605a4f38975cc77bc8c5c6a8a8affd6',
  CURRENT_TIMESTAMP
FROM (
  SELECT id, article_id, source_branch_id, target_branch_id, source_head_revision_id, target_head_revision_id,
    ROW_NUMBER() OVER (
      PARTITION BY source_branch_id,target_branch_id,source_head_revision_id,target_head_revision_id
      ORDER BY created_at DESC,id DESC
    ) AS tuple_rank
  FROM merge_proposals
  WHERE status IN ('prepared','resolving','ready')
) AS ranked
WHERE ranked.tuple_rank > 1;--> statement-breakpoint
UPDATE `work_items`
SET `state` = 'done',
  `blocker` = '',
  `next_action` = '0012 迁移保留了同坐标最新提案；本提案作为重复活动 tuple 关闭',
  `updated_at` = CURRENT_TIMESTAMP
WHERE `id` IN (
  SELECT ranked.work_item_id
  FROM (
    SELECT work_item_id,
      ROW_NUMBER() OVER (
        PARTITION BY source_branch_id,target_branch_id,source_head_revision_id,target_head_revision_id
        ORDER BY created_at DESC,id DESC
      ) AS tuple_rank
    FROM merge_proposals
    WHERE status IN ('prepared','resolving','ready')
  ) AS ranked
  WHERE ranked.tuple_rank > 1
);--> statement-breakpoint
UPDATE `merge_proposals`
SET `status` = 'stale', `lock_version` = `lock_version` + 1, `updated_at` = CURRENT_TIMESTAMP
WHERE `id` IN (
  SELECT ranked.id
  FROM (
    SELECT id,
      ROW_NUMBER() OVER (
        PARTITION BY source_branch_id,target_branch_id,source_head_revision_id,target_head_revision_id
        ORDER BY created_at DESC,id DESC
      ) AS tuple_rank
    FROM merge_proposals
    WHERE status IN ('prepared','resolving','ready')
  ) AS ranked
  WHERE ranked.tuple_rank > 1
);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_merge_proposals_active_heads` ON `merge_proposals` (`source_branch_id`,`target_branch_id`,`source_head_revision_id`,`target_head_revision_id`) WHERE "merge_proposals"."status" IN ('prepared','resolving','ready');
