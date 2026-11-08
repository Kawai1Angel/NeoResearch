CREATE TABLE `research_memory_write` (
  `id` text PRIMARY KEY NOT NULL,
  `task_id` text NOT NULL REFERENCES `research_task`(`id`) ON DELETE CASCADE,
  `binding` text NOT NULL,
  `draft` text NOT NULL,
  `request_digest` text NOT NULL,
  `library_path` text NOT NULL,
  `payload` text,
  `status` text NOT NULL DEFAULT 'pending',
  `result` text,
  `error` text,
  `time_created` integer NOT NULL,
  `time_updated` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `research_memory_write_task_idx` ON `research_memory_write` (`task_id`, `status`);
