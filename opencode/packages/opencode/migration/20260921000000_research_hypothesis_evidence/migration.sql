ALTER TABLE `research_hypothesis` ADD `dataset_evidence_paths` text NOT NULL DEFAULT '[]';
--> statement-breakpoint
ALTER TABLE `research_hypothesis` ADD `literature_evidence` text NOT NULL DEFAULT '[]';
--> statement-breakpoint
ALTER TABLE `research_hypothesis` ADD `applicability_assumptions` text NOT NULL DEFAULT '[]';
--> statement-breakpoint
ALTER TABLE `research_hypothesis` ADD `falsification_criteria` text NOT NULL DEFAULT '[]';
--> statement-breakpoint
ALTER TABLE `research_hypothesis` ADD `evidence_level` text NOT NULL DEFAULT 'data_only';
