ALTER TABLE `lifecycle_releases` ADD COLUMN `readiness_state` text NOT NULL DEFAULT 'draft';--> statement-breakpoint
ALTER TABLE `lifecycle_releases` ADD COLUMN `readiness_evidence_sha256` text NOT NULL DEFAULT '';--> statement-breakpoint
ALTER TABLE `lifecycle_releases` ADD COLUMN `ready_at` text;--> statement-breakpoint
ALTER TABLE `lifecycle_releases` ADD COLUMN `expires_at` text;--> statement-breakpoint
CREATE INDEX `idx_lifecycle_releases_readiness_expiry` ON `lifecycle_releases` (`readiness_state`,`expires_at`);
