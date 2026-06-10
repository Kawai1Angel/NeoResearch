CREATE TABLE `research_hypothesis` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL REFERENCES `research_task`(`id`) ON DELETE cascade,
	`hypo_id` text NOT NULL,
	`statement` text NOT NULL,
	`motivation` text NOT NULL,
	`expected_outcome` text NOT NULL,
	`suggested_backbones` text NOT NULL,
	`suggested_preprocessing` text NOT NULL,
	`priority` text NOT NULL,
	`risk` text NOT NULL,
	`testable` integer NOT NULL,
	`status` text NOT NULL DEFAULT 'pending',
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `research_hypothesis_task_idx` ON `research_hypothesis` (`task_id`);
--> statement-breakpoint
CREATE INDEX `research_hypothesis_status_idx` ON `research_hypothesis` (`status`);
