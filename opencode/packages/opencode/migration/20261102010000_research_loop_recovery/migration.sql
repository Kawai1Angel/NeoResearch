ALTER TABLE `research_design` ADD `phase_receipts` text NOT NULL DEFAULT '{}';
--> statement-breakpoint
ALTER TABLE `research_training_trial` ADD `repair_run_id` text;
--> statement-breakpoint
ALTER TABLE `research_cycle` ADD `deadline_at` integer;
