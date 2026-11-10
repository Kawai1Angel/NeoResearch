CREATE TABLE `research_design` (
  `id` text PRIMARY KEY NOT NULL,
  `task_id` text NOT NULL REFERENCES `research_task`(`id`) ON DELETE CASCADE,
  `cycle_id` text NOT NULL REFERENCES `research_cycle`(`id`) ON DELETE CASCADE,
  `hypothesis_id` text,
  `active_task` text UNIQUE,
  `design_digest` text NOT NULL,
  `recipe` text NOT NULL,
  `outer_contract` text,
  `reference` integer NOT NULL DEFAULT 0,
  `status` text NOT NULL DEFAULT 'optimizing',
  `stop_reason` text,
  `best_run_id` text,
  `best_metric` real,
  `no_improve` integer NOT NULL DEFAULT 0,
  `time_created` integer NOT NULL,
  `time_updated` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `research_design_cycle_idx` ON `research_design` (`cycle_id`);
--> statement-breakpoint
CREATE TABLE `research_training_trial` (
  `id` text PRIMARY KEY NOT NULL,
  `design_id` text NOT NULL REFERENCES `research_design`(`id`) ON DELETE CASCADE,
  `trial_index` integer NOT NULL,
  `candidate_id` text NOT NULL UNIQUE REFERENCES `research_candidate`(`id`) ON DELETE CASCADE,
  `contract` text,
  `smoke_run_id` text,
  `full_run_id` text,
  `charged` integer NOT NULL DEFAULT 0,
  `status` text NOT NULL DEFAULT 'pending',
  `result` text,
  `optimizer_decision` text,
  `time_created` integer NOT NULL,
  `time_updated` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `research_training_trial_position_idx` ON `research_training_trial` (`design_id`, `trial_index`);
