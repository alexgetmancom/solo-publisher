CREATE TABLE `metric_samples_new` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`publication_key` text NOT NULL,
	`target` text NOT NULL,
	`metric_name` text DEFAULT 'views' NOT NULL,
	`value` integer,
	`sampled_at` text NOT NULL,
	`source` text,
	`raw_json` text
);
--> statement-breakpoint
INSERT INTO `metric_samples_new` (`id`, `publication_key`, `target`, `metric_name`, `value`, `sampled_at`, `source`, `raw_json`)
SELECT `id`, `publication_key`, `target`, `metric_name`, `value`, `sampled_at`, `source`, `raw_json` FROM `metric_samples`;
--> statement-breakpoint
DROP TABLE `metric_samples`;
--> statement-breakpoint
ALTER TABLE `metric_samples_new` RENAME TO `metric_samples`;
--> statement-breakpoint
CREATE INDEX `idx_metric_samples_lookup` ON `metric_samples` (`publication_key`,`target`,`metric_name`,`sampled_at`);
--> statement-breakpoint
CREATE INDEX `idx_metric_samples_sampled_at` ON `metric_samples` (`sampled_at`);
--> statement-breakpoint
CREATE TABLE `metric_schedule_new` (
	`publication_key` text NOT NULL,
	`target` text NOT NULL,
	`next_check_at` text,
	`last_checked_at` text,
	`check_count` integer DEFAULT 0 NOT NULL,
	`frozen_at` text,
	`last_error` text,
	`locked_by` text,
	`locked_at` text,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`publication_key`, `target`)
);
--> statement-breakpoint
INSERT INTO `metric_schedule_new` (
	`publication_key`, `target`, `next_check_at`, `last_checked_at`, `check_count`, `frozen_at`, `last_error`, `locked_by`, `locked_at`, `updated_at`
)
SELECT `publication_key`, `target`, `next_check_at`, `last_checked_at`, `check_count`, `frozen_at`, `last_error`, `locked_by`, `locked_at`, `updated_at`
FROM `metric_schedule`;
--> statement-breakpoint
DROP TABLE `metric_schedule`;
--> statement-breakpoint
ALTER TABLE `metric_schedule_new` RENAME TO `metric_schedule`;
--> statement-breakpoint
CREATE INDEX `idx_metric_schedule_lock` ON `metric_schedule` (`locked_by`,`locked_at`);
--> statement-breakpoint
CREATE INDEX `idx_metric_schedule_error_updated_at` ON `metric_schedule` (`updated_at`) WHERE "metric_schedule"."last_error" IS NOT NULL AND "metric_schedule"."last_error" <> '';
--> statement-breakpoint
CREATE TABLE `post_metrics_new` (
	`publication_key` text NOT NULL,
	`target` text NOT NULL,
	`metric_name` text DEFAULT 'views' NOT NULL,
	`value` integer,
	`unit` text DEFAULT 'count' NOT NULL,
	`source` text,
	`sampled_at` text,
	`error` text,
	`raw_json` text,
	PRIMARY KEY(`publication_key`, `target`, `metric_name`)
);
--> statement-breakpoint
INSERT INTO `post_metrics_new` (
	`publication_key`, `target`, `metric_name`, `value`, `unit`, `source`, `sampled_at`, `error`, `raw_json`
)
SELECT `publication_key`, `target`, `metric_name`, `value`, `unit`, `source`, `sampled_at`, `error`, `raw_json` FROM `post_metrics`;
--> statement-breakpoint
DROP TABLE `post_metrics`;
--> statement-breakpoint
ALTER TABLE `post_metrics_new` RENAME TO `post_metrics`;
--> statement-breakpoint
CREATE INDEX `idx_post_metrics_sampled_at` ON `post_metrics` (`sampled_at`);
--> statement-breakpoint
CREATE TABLE `publication_targets_new` (
	`publication_key` text NOT NULL,
	`target` text NOT NULL,
	`status` text DEFAULT 'unknown' NOT NULL,
	`external_id` text,
	`external_ids_json` text,
	`url` text,
	`error` text,
	`skipped` integer DEFAULT 0 NOT NULL,
	`published_at` text,
	`confirmation_source` text,
	`verified_at` text,
	`updated_at` text NOT NULL,
	`raw_json` text,
	PRIMARY KEY(`publication_key`, `target`)
);
--> statement-breakpoint
INSERT INTO `publication_targets_new` (
	`publication_key`, `target`, `status`, `external_id`, `external_ids_json`, `url`, `error`, `skipped`,
	`published_at`, `confirmation_source`, `verified_at`, `updated_at`, `raw_json`
)
SELECT `publication_key`, `target`, `status`, `external_id`, `external_ids_json`, `url`, `error`, `skipped`,
	`published_at`, `confirmation_source`, `verified_at`, `updated_at`, `raw_json`
FROM `publication_targets`;
--> statement-breakpoint
DROP TABLE `publication_targets`;
--> statement-breakpoint
ALTER TABLE `publication_targets_new` RENAME TO `publication_targets`;
--> statement-breakpoint
CREATE INDEX `idx_publication_targets_updated_at` ON `publication_targets` (`updated_at`);
