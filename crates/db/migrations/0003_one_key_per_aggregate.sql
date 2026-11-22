DROP TABLE IF EXISTS `schema_migrations`;
--> statement-breakpoint
DROP INDEX IF EXISTS `idx_post_events_post`;
--> statement-breakpoint
DROP INDEX IF EXISTS `idx_creator_profiles_updated_at`;
--> statement-breakpoint
CREATE INDEX `idx_creator_profiles_updated_at` ON `creator_profiles` (`updated_at`);
--> statement-breakpoint
DROP INDEX IF EXISTS `idx_credential_checks_last_checked_at`;
--> statement-breakpoint
CREATE INDEX `idx_credential_checks_last_checked_at` ON `credential_checks` (`last_checked_at`);
--> statement-breakpoint
DROP INDEX IF EXISTS `idx_video_drafts_updated_at`;
--> statement-breakpoint
CREATE INDEX `idx_video_drafts_updated_at` ON `video_drafts` (`updated_at`);
--> statement-breakpoint
DROP INDEX IF EXISTS `idx_x_activity_items_last_seen_at`;
--> statement-breakpoint
CREATE INDEX `idx_x_activity_items_last_seen_at` ON `x_activity_items` (`last_seen_at`);
--> statement-breakpoint
CREATE TABLE `alert_dedup_new` (
	`alert_key` text PRIMARY KEY NOT NULL,
	`last_sent_at` text NOT NULL,
	`suppressed_count` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
INSERT INTO `alert_dedup_new` SELECT `alert_key`, `last_sent_at`, `suppressed_count` FROM `alert_dedup` WHERE `alert_key` IS NOT NULL;
--> statement-breakpoint
DROP TABLE `alert_dedup`;
--> statement-breakpoint
ALTER TABLE `alert_dedup_new` RENAME TO `alert_dedup`;
--> statement-breakpoint
CREATE TABLE `analytics_rollups_new` (
	`rollup_key` text PRIMARY KEY NOT NULL,
	`scope` text NOT NULL,
	`subject` text NOT NULL,
	`metric_json` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
INSERT INTO `analytics_rollups_new` SELECT `rollup_key`, `scope`, `subject`, `metric_json`, `updated_at` FROM `analytics_rollups` WHERE `rollup_key` IS NOT NULL;
--> statement-breakpoint
DROP TABLE `analytics_rollups`;
--> statement-breakpoint
ALTER TABLE `analytics_rollups_new` RENAME TO `analytics_rollups`;
--> statement-breakpoint
CREATE TABLE `credential_checks_new` (
	`target` text PRIMARY KEY NOT NULL,
	`status` text NOT NULL,
	`required_env_json` text NOT NULL,
	`missing_env_json` text NOT NULL,
	`expires_at` text,
	`last_checked_at` text NOT NULL,
	`next_check_at` text,
	`last_error` text,
	`details_json` text
);
--> statement-breakpoint
INSERT INTO `credential_checks_new` SELECT `target`, `status`, `required_env_json`, `missing_env_json`, `expires_at`, `last_checked_at`, `next_check_at`, `last_error`, `details_json` FROM `credential_checks` WHERE `target` IS NOT NULL;
--> statement-breakpoint
DROP TABLE `credential_checks`;
--> statement-breakpoint
ALTER TABLE `credential_checks_new` RENAME TO `credential_checks`;
--> statement-breakpoint
CREATE INDEX `idx_credential_checks_last_checked_at` ON `credential_checks` (`last_checked_at`);
--> statement-breakpoint
CREATE TABLE `maintenance_locks_new` (
	`name` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`expires_at` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
INSERT INTO `maintenance_locks_new` SELECT `name`, `owner`, `expires_at`, `created_at` FROM `maintenance_locks` WHERE `name` IS NOT NULL;
--> statement-breakpoint
DROP TABLE `maintenance_locks`;
--> statement-breakpoint
ALTER TABLE `maintenance_locks_new` RENAME TO `maintenance_locks`;
--> statement-breakpoint
CREATE TABLE `media_test_cases_new` (
	`test_id` text PRIMARY KEY NOT NULL,
	`format_key` text NOT NULL,
	`title` text NOT NULL,
	`input_recipe` text NOT NULL,
	`expected_targets_json` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`last_message_id` integer,
	`notes` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
INSERT INTO `media_test_cases_new` SELECT `test_id`, `format_key`, `title`, `input_recipe`, `expected_targets_json`, `status`, `last_message_id`, `notes`, `created_at`, `updated_at` FROM `media_test_cases` WHERE `test_id` IS NOT NULL;
--> statement-breakpoint
DROP TABLE `media_test_cases`;
--> statement-breakpoint
ALTER TABLE `media_test_cases_new` RENAME TO `media_test_cases`;
--> statement-breakpoint
CREATE TABLE `worker_state_new` (
	`name` text PRIMARY KEY NOT NULL,
	`state_json` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
INSERT INTO `worker_state_new` SELECT `name`, `state_json`, `updated_at` FROM `worker_state` WHERE `name` IS NOT NULL;
--> statement-breakpoint
DROP TABLE `worker_state`;
--> statement-breakpoint
ALTER TABLE `worker_state_new` RENAME TO `worker_state`;
--> statement-breakpoint
CREATE TABLE `publication_events_new` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`publication_key` text,
	`event_type` text NOT NULL,
	`severity` text DEFAULT 'info' NOT NULL,
	`target` text,
	`message` text NOT NULL,
	`details_json` text,
	`created_at` text NOT NULL,
	`acked_at` text
);
--> statement-breakpoint
INSERT INTO `publication_events_new` (`id`, `publication_key`, `event_type`, `severity`, `target`, `message`, `details_json`, `created_at`, `acked_at`)
SELECT `id`, `publication_key`, `event_type`, `severity`, `target`, `message`, `details_json`, `created_at`, `acked_at` FROM `publication_events`;
--> statement-breakpoint
DROP TABLE `publication_events`;
--> statement-breakpoint
ALTER TABLE `publication_events_new` RENAME TO `publication_events`;
--> statement-breakpoint
CREATE INDEX `idx_publication_events_lookup` ON `publication_events` (`publication_key`,`target`,`created_at`);
--> statement-breakpoint
CREATE INDEX `idx_publication_events_created_at` ON `publication_events` (`created_at`);
--> statement-breakpoint
CREATE TABLE `publish_jobs_new` (
	`job_id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`publication_key` text NOT NULL,
	`target` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`current_phase` text,
	`reconcile_attempt_count` integer DEFAULT 0 NOT NULL,
	`publish_at` text,
	`payload_json` text,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` text,
	`locked_by` text,
	`locked_at` text,
	`last_error` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
INSERT INTO `publish_jobs_new` (
	`job_id`, `publication_key`, `target`, `status`, `current_phase`, `reconcile_attempt_count`, `publish_at`,
	`payload_json`, `attempt_count`, `next_attempt_at`, `locked_by`, `locked_at`, `last_error`, `created_at`, `updated_at`
)
SELECT `job_id`, `publication_key`, `target`, `status`, `current_phase`, `reconcile_attempt_count`, `publish_at`,
	`payload_json`, `attempt_count`, `next_attempt_at`, `locked_by`, `locked_at`, `last_error`, `created_at`, `updated_at`
FROM `publish_jobs`;
--> statement-breakpoint
DROP TABLE `publish_jobs`;
--> statement-breakpoint
ALTER TABLE `publish_jobs_new` RENAME TO `publish_jobs`;
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_publish_jobs_publication_target_status` ON `publish_jobs` (`publication_key`,`target`,`status`);
--> statement-breakpoint
CREATE INDEX `idx_publish_jobs_due` ON `publish_jobs` (`status`,`publish_at`,`next_attempt_at`,`created_at`);
--> statement-breakpoint
CREATE INDEX `idx_publish_jobs_lock` ON `publish_jobs` (`locked_by`,`locked_at`);
--> statement-breakpoint
CREATE INDEX `idx_publish_jobs_updated_at` ON `publish_jobs` (`updated_at`);
--> statement-breakpoint
CREATE TABLE `draft_entity_links` (
	`draft_id` integer NOT NULL,
	`entity_id` integer NOT NULL,
	`link_role` text DEFAULT 'mention' NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`draft_id`, `entity_id`)
);
--> statement-breakpoint
INSERT INTO `draft_entity_links` (`draft_id`, `entity_id`, `link_role`, `created_at`)
SELECT d.`id`, l.`entity_id`, l.`link_role`, l.`created_at`
FROM `post_entity_links` l JOIN `drafts` d ON d.`post_id` = l.`post_id`;
--> statement-breakpoint
DROP TABLE `post_entity_links`;
--> statement-breakpoint
CREATE INDEX `idx_draft_entity_links_entity` ON `draft_entity_links` (`entity_id`,`draft_id`);
--> statement-breakpoint
CREATE TABLE `site_jobs_new` (
	`job_id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`publication_key` text NOT NULL,
	`message_id` integer NOT NULL,
	`reason` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` text,
	`locked_by` text,
	`locked_at` text,
	`last_error` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
INSERT INTO `site_jobs_new` (
	`job_id`, `publication_key`, `message_id`, `reason`, `status`, `attempt_count`, `next_attempt_at`,
	`locked_by`, `locked_at`, `last_error`, `created_at`, `updated_at`
)
SELECT `job_id`, 'post:' || `post_id`, `message_id`, `reason`, `status`, `attempt_count`, `next_attempt_at`,
	`locked_by`, `locked_at`, `last_error`, `created_at`, `updated_at`
FROM `site_jobs` WHERE `post_id` IS NOT NULL;
--> statement-breakpoint
DROP TABLE `site_jobs`;
--> statement-breakpoint
ALTER TABLE `site_jobs_new` RENAME TO `site_jobs`;
--> statement-breakpoint
CREATE INDEX `idx_site_jobs_due` ON `site_jobs` (`status`,`next_attempt_at`,`created_at`);
--> statement-breakpoint
CREATE INDEX `idx_site_jobs_lock` ON `site_jobs` (`locked_by`,`locked_at`);
--> statement-breakpoint
CREATE INDEX `idx_site_jobs_publication` ON `site_jobs` (`publication_key`,`status`);
--> statement-breakpoint
CREATE INDEX `idx_site_jobs_updated_at` ON `site_jobs` (`updated_at`);
