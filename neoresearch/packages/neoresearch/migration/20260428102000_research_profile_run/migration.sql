PRAGMA foreign_keys=off;
--> statement-breakpoint
CREATE TABLE `__new_research_run` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL REFERENCES `research_task`(`id`) ON DELETE cascade,
	`candidate_id` text REFERENCES `research_candidate`(`id`) ON DELETE cascade,
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
INSERT INTO `__new_research_run` (
	`id`,
	`task_id`,
	`candidate_id`,
	`stage`,
	`status`,
	`metrics`,
	`resource_usage`,
	`artifact_refs`,
	`error`,
	`time_created`,
	`time_updated`,
	`time_started`,
	`time_finished`
)
SELECT
	`id`,
	`task_id`,
	`candidate_id`,
	`stage`,
	`status`,
	`metrics`,
	`resource_usage`,
	`artifact_refs`,
	`error`,
	`time_created`,
	`time_updated`,
	`time_started`,
	`time_finished`
FROM `research_run`;
--> statement-breakpoint
DROP TABLE `research_run`;
--> statement-breakpoint
ALTER TABLE `__new_research_run` RENAME TO `research_run`;
--> statement-breakpoint
CREATE INDEX `research_run_task_idx` ON `research_run` (`task_id`);
--> statement-breakpoint
CREATE INDEX `research_run_candidate_idx` ON `research_run` (`candidate_id`);
--> statement-breakpoint
CREATE INDEX `research_run_status_idx` ON `research_run` (`status`);
--> statement-breakpoint
PRAGMA foreign_keys=on;
