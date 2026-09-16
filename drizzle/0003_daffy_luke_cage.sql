ALTER TABLE `article_branches` ADD `head_revision_id` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `article_branches` ADD `base_revision_id` text DEFAULT '' NOT NULL;
