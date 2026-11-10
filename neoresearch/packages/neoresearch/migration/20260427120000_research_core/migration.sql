CREATE TABLE `research_task` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL REFERENCES `project`(`id`) ON DELETE cascade,
	`session_id` text REFERENCES `session`(`id`) ON DELETE set null,
	`title` text NOT NULL,
	`domain_id` text NOT NULL,
	`mode` text NOT NULL,
	`status` text NOT NULL,
	`task_spec` text NOT NULL,
	`objective` text NOT NULL,
	`budget` text NOT NULL,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `research_task_project_idx` ON `research_task` (`project_id`);
--> statement-breakpoint
CREATE INDEX `research_task_domain_idx` ON `research_task` (`domain_id`);
--> statement-breakpoint
CREATE INDEX `research_task_status_idx` ON `research_task` (`status`);
--> statement-breakpoint
CREATE TABLE `research_candidate` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL REFERENCES `research_task`(`id`) ON DELETE cascade,
	`parent_candidate_id` text,
	`domain_id` text NOT NULL,
	`candidate_spec` text NOT NULL,
	`rationale` text NOT NULL,
	`risk_level` text NOT NULL,
	`approval_status` text NOT NULL,
	`generated_by` text NOT NULL,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `research_candidate_task_idx` ON `research_candidate` (`task_id`);
--> statement-breakpoint
CREATE INDEX `research_candidate_parent_idx` ON `research_candidate` (`parent_candidate_id`);
--> statement-breakpoint
CREATE INDEX `research_candidate_approval_idx` ON `research_candidate` (`approval_status`);
--> statement-breakpoint
CREATE TABLE `research_run` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL REFERENCES `research_task`(`id`) ON DELETE cascade,
	`candidate_id` text NOT NULL REFERENCES `research_candidate`(`id`) ON DELETE cascade,
	`stage` text NOT NULL,
	`status` text NOT NULL,
	`metrics` text NOT NULL,
	`resource_usage` text NOT NULL,
	`artifact_refs` text NOT NULL,
	`error` text,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL,
	`time_started` integer,
	`time_finished` integer
);
--> statement-breakpoint
CREATE INDEX `research_run_task_idx` ON `research_run` (`task_id`);
--> statement-breakpoint
CREATE INDEX `research_run_candidate_idx` ON `research_run` (`candidate_id`);
--> statement-breakpoint
CREATE INDEX `research_run_status_idx` ON `research_run` (`status`);
--> statement-breakpoint
CREATE TABLE `research_artifact` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL REFERENCES `research_task`(`id`) ON DELETE cascade,
	`run_id` text REFERENCES `research_run`(`id`) ON DELETE set null,
	`kind` text NOT NULL,
	`uri` text NOT NULL,
	`metadata` text NOT NULL,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `research_artifact_task_idx` ON `research_artifact` (`task_id`);
--> statement-breakpoint
CREATE INDEX `research_artifact_run_idx` ON `research_artifact` (`run_id`);
--> statement-breakpoint
CREATE TABLE `research_memory` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL REFERENCES `research_task`(`id`) ON DELETE cascade,
	`domain_id` text NOT NULL,
	`fingerprint_summary` text NOT NULL,
	`candidate_summary` text NOT NULL,
	`outcome` text NOT NULL,
	`lesson` text NOT NULL,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `research_memory_task_idx` ON `research_memory` (`task_id`);
--> statement-breakpoint
CREATE INDEX `research_memory_domain_idx` ON `research_memory` (`domain_id`);
--> statement-breakpoint
CREATE TABLE `research_approval` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL REFERENCES `research_task`(`id`) ON DELETE cascade,
	`candidate_id` text REFERENCES `research_candidate`(`id`) ON DELETE set null,
	`kind` text NOT NULL,
	`status` text NOT NULL,
	`reason` text NOT NULL,
	`reply_message` text,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL,
	`time_replied` integer
);
--> statement-breakpoint
CREATE INDEX `research_approval_task_idx` ON `research_approval` (`task_id`);
--> statement-breakpoint
CREATE INDEX `research_approval_status_idx` ON `research_approval` (`status`);
--> statement-breakpoint
CREATE TABLE `research_champion` (
	`task_id` text PRIMARY KEY NOT NULL REFERENCES `research_task`(`id`) ON DELETE cascade,
	`candidate_id` text NOT NULL REFERENCES `research_candidate`(`id`) ON DELETE cascade,
	`run_id` text NOT NULL REFERENCES `research_run`(`id`) ON DELETE cascade,
	`primary_metric` real NOT NULL,
	`utility` real NOT NULL,
	`accepted_at` integer NOT NULL,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL
);
