ALTER TABLE `production_run_steps` ADD `agent_role` text;--> statement-breakpoint
ALTER TABLE `production_run_steps` ADD `depends_on_json` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `production_run_steps` ADD `write_scope` text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE `production_runs` ADD `recipe_version` text DEFAULT '1.0.0' NOT NULL;--> statement-breakpoint
ALTER TABLE `production_runs` ADD `recipe_sha256` text DEFAULT '' NOT NULL;