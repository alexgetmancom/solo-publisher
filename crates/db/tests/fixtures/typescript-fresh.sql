-- A database the TypeScript backend created and migrated (openBackendDb on an
-- empty file), recorded before the cutover: its schema in creation order, then
-- its migration bookkeeping. Then sqlite_sequence as it was.
CREATE TABLE "__drizzle_migrations" (
				id SERIAL PRIMARY KEY,
				hash text NOT NULL,
				created_at numeric
			);
CREATE TABLE `analytics_sync` (
	`source` text PRIMARY KEY NOT NULL,
	`last_synced_at` text NOT NULL,
	`last_success_at` text,
	`last_error` text,
	`locked_by` text,
	`locked_at` text
);
CREATE TABLE `creator_profile_snapshots` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`platform` text NOT NULL,
	`account` text NOT NULL,
	`sampled_on` text NOT NULL,
	`metrics_json` text NOT NULL,
	`source` text NOT NULL,
	`sampled_at` text NOT NULL
);
CREATE UNIQUE INDEX `idx_creator_profile_snapshots_daily` ON `creator_profile_snapshots` (`platform`,`account`,`sampled_on`);
CREATE INDEX `idx_creator_profile_snapshots_history` ON `creator_profile_snapshots` (`platform`,`account`,`sampled_at`);
CREATE INDEX `idx_creator_profile_snapshots_sampled_at` ON `creator_profile_snapshots` (`sampled_at`);
CREATE TABLE `creator_profiles` (
	`platform` text PRIMARY KEY NOT NULL,
	`data_json` text NOT NULL,
	`updated_at` text NOT NULL
);
CREATE TABLE `x_activity_imports` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`checksum` text NOT NULL,
	`source_file` text NOT NULL,
	`period_start` text,
	`period_end` text,
	`sampled_at` text NOT NULL,
	`imported_at` text NOT NULL,
	`row_count` integer NOT NULL
);
CREATE UNIQUE INDEX `idx_x_activity_imports_checksum` ON `x_activity_imports` (`checksum`);
CREATE TABLE `x_activity_items` (
	`x_post_id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`published_at` text,
	`text` text NOT NULL,
	`url` text NOT NULL,
	`linked_publication_key` text,
	`first_seen_at` text NOT NULL,
	`last_seen_at` text NOT NULL,
	`raw_json` text
, opening_line text, opening_kind text);
CREATE INDEX `idx_x_activity_items_published` ON `x_activity_items` (`published_at`);
CREATE INDEX `idx_x_activity_items_linked_post` ON `x_activity_items` (`linked_publication_key`);
CREATE TABLE `x_activity_metric_snapshots` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`x_post_id` text NOT NULL,
	`metric_name` text NOT NULL,
	`value` integer NOT NULL,
	`sampled_at` text NOT NULL,
	`import_id` integer,
	`raw_json` text
);
CREATE UNIQUE INDEX `idx_x_activity_metric_snapshot` ON `x_activity_metric_snapshots` (`x_post_id`,`metric_name`,`sampled_at`);
CREATE INDEX `idx_x_activity_metric_history` ON `x_activity_metric_snapshots` (`x_post_id`,`sampled_at`);
CREATE INDEX `idx_x_activity_metric_sampled_at` ON `x_activity_metric_snapshots` (`sampled_at`);
CREATE TABLE `article_locales` (
	`article_id` integer NOT NULL,
	`locale` text NOT NULL,
	`slug` text NOT NULL,
	`title` text DEFAULT '' NOT NULL,
	`body_text` text,
	`entities_json` text,
	`media_json` text,
	`published_at` text,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`article_id`, `locale`)
);
CREATE TABLE `articles` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`actor_id` integer NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
CREATE INDEX `idx_articles_status` ON `articles` (`status`,`updated_at`);
CREATE TABLE `conversation_sessions` (
	`actor_id` integer NOT NULL,
	`kind` text NOT NULL,
	`draft_id` integer,
	`step` text,
	`data_json` text DEFAULT '{}' NOT NULL,
	`control_message_id` integer,
	`revision` integer DEFAULT 0 NOT NULL,
	`active` integer DEFAULT 1 NOT NULL,
	`updated_at` text NOT NULL,
	`expires_at` text,
	PRIMARY KEY(`actor_id`, `kind`)
);
CREATE INDEX `idx_conversation_sessions_expiry` ON `conversation_sessions` (`active`,`expires_at`);
CREATE TABLE `draft_entity_candidates` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`draft_id` integer NOT NULL,
	`kind` text NOT NULL,
	`slug` text NOT NULL,
	`title_ru` text NOT NULL,
	`title_en` text,
	`status` text DEFAULT 'suggested' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
CREATE UNIQUE INDEX `idx_draft_entity_candidates_unique` ON `draft_entity_candidates` (`draft_id`,`kind`,`slug`);
CREATE INDEX `idx_draft_entity_candidates_draft_status` ON `draft_entity_candidates` (`draft_id`,`status`);
CREATE TABLE `knowledge_entities` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kind` text NOT NULL,
	`parent_entity_id` integer,
	`slug` text NOT NULL,
	`title_ru` text NOT NULL,
	`title_en` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
CREATE UNIQUE INDEX `idx_knowledge_entities_kind_slug` ON `knowledge_entities` (`kind`,`slug`);
CREATE INDEX `idx_knowledge_entities_kind` ON `knowledge_entities` (`kind`);
CREATE INDEX `idx_knowledge_entities_parent` ON `knowledge_entities` (`parent_entity_id`);
CREATE TABLE `knowledge_entity_aliases` (
	`entity_id` integer NOT NULL,
	`alias` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`entity_id`, `alias`)
);
CREATE TABLE `format_support` (
	`target` text NOT NULL,
	`format_key` text NOT NULL,
	`status` text DEFAULT 'unknown' NOT NULL,
	`evidence_test_id` text,
	`evidence_message_id` integer,
	`evidence_url` text,
	`notes` text,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`target`, `format_key`)
);
CREATE TABLE `platform_tokens` (
	`target` text PRIMARY KEY NOT NULL,
	`sealed_token` text NOT NULL,
	`seed_fingerprint` text,
	`account_id` text,
	`sealed_refresh_token` text,
	`expires_at` text,
	`refreshed_at` text NOT NULL,
	`updated_at` text NOT NULL
, `upload_limit_bytes` integer);
CREATE TABLE `runtime_usage` (
	`feature_key` text NOT NULL,
	`bucket_day` text NOT NULL,
	`calls` integer DEFAULT 0 NOT NULL,
	`successes` integer DEFAULT 0 NOT NULL,
	`failures` integer DEFAULT 0 NOT NULL,
	`total_duration_ms` integer DEFAULT 0 NOT NULL,
	`first_seen_at` text NOT NULL,
	`last_seen_at` text NOT NULL,
	PRIMARY KEY(`feature_key`, `bucket_day`)
);
CREATE INDEX `idx_runtime_usage_bucket_day` ON `runtime_usage` (`bucket_day`);
CREATE INDEX `idx_runtime_usage_feature_last_seen` ON `runtime_usage` (`feature_key`,`last_seen_at`);
CREATE TABLE `draft_story_cards` (
	`draft_id` integer NOT NULL,
	`locale` text NOT NULL,
	`source_hash` text NOT NULL,
	`headline` text NOT NULL,
	`emoji` text,
	`status` text DEFAULT 'queued' NOT NULL,
	`local_path` text,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` text,
	`locked_by` text,
	`locked_at` text,
	`last_error` text,
	`template_version` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`draft_id`, `locale`)
);
CREATE INDEX `idx_draft_story_cards_due` ON `draft_story_cards` (`status`,`next_attempt_at`,`created_at`);
CREATE INDEX `idx_draft_story_cards_lock` ON `draft_story_cards` (`locked_by`,`locked_at`);
CREATE TABLE `pending_albums` (
	`id` text PRIMARY KEY NOT NULL,
	`actor_id` integer NOT NULL,
	`chat_id` integer NOT NULL,
	`media_group_id` text NOT NULL,
	`step` text,
	`step_data_json` text DEFAULT '{}' NOT NULL,
	`draft_id` integer,
	`state_revision` integer,
	`text_ru` text DEFAULT '' NOT NULL,
	`text_entities_json` text,
	`media_json` text NOT NULL,
	`notified` integer DEFAULT 0 NOT NULL,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`updated_at` text NOT NULL
);
CREATE TABLE `site_pageviews` (
	`day` text NOT NULL,
	`path` text NOT NULL,
	`count` integer DEFAULT 0 NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`day`, `path`)
);
CREATE INDEX `idx_site_pageviews_day` ON `site_pageviews` (`day`);
CREATE TABLE `bot_ui_settings` (
	`actor_id` integer PRIMARY KEY NOT NULL,
	`locale` text DEFAULT 'en' NOT NULL,
	`timezone` text,
	`updated_at` text NOT NULL
);
CREATE TABLE `channel_connections` (
	`id` text PRIMARY KEY NOT NULL,
	`platform` text NOT NULL,
	`locale` text NOT NULL,
	`provider` text NOT NULL,
	`provider_account_id` text,
	`target_id` text,
	`label` text NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	`source` text DEFAULT 'config' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
CREATE INDEX `idx_channel_connections_enabled` ON `channel_connections` (`enabled`,`platform`);
CREATE UNIQUE INDEX `idx_channel_connections_route` ON `channel_connections` (`platform`,`locale`,`provider`,`provider_account_id`);
CREATE UNIQUE INDEX `idx_channel_connections_target` ON `channel_connections` (`target_id`);
CREATE TABLE `interface_bindings` (
	`interface_id` text NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` integer NOT NULL,
	`conversation_id` text NOT NULL,
	`message_id` text NOT NULL,
	`state_json` text DEFAULT '{}' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`interface_id`, `entity_type`, `entity_id`)
);
CREATE INDEX `idx_interface_bindings_lookup` ON `interface_bindings` (`entity_type`,`entity_id`);
CREATE TABLE `studio_backup_settings` (
	`id` integer PRIMARY KEY DEFAULT 1 NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	`updated_at` text NOT NULL
);
CREATE TABLE `studio_media_assets` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`actor_id` integer NOT NULL,
	`kind` text NOT NULL,
	`mime_type` text NOT NULL,
	`filename` text NOT NULL,
	`local_path` text NOT NULL,
	`byte_size` integer NOT NULL,
	`sha256` text NOT NULL,
	`source` text NOT NULL,
	`created_at` text NOT NULL
);
CREATE INDEX `idx_studio_media_assets_owner` ON `studio_media_assets` (`actor_id`,`created_at`);
CREATE INDEX `idx_studio_media_assets_hash` ON `studio_media_assets` (`sha256`);
CREATE UNIQUE INDEX `idx_studio_media_assets_owner_hash` ON `studio_media_assets` (`actor_id`,`sha256`);
CREATE TABLE `studio_notification_jobs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`actor_id` integer NOT NULL,
	`ref` text NOT NULL,
	`kind` text NOT NULL,
	`run_at` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`payload_json` text DEFAULT '{}' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
CREATE INDEX `idx_studio_notification_jobs_due` ON `studio_notification_jobs` (`status`,`run_at`);
CREATE UNIQUE INDEX `idx_studio_notification_jobs_ref_kind` ON `studio_notification_jobs` (`ref`,`kind`);
CREATE TABLE `studio_notification_settings` (
	`actor_id` integer PRIMARY KEY NOT NULL,
	`video_reminders_enabled` integer DEFAULT 1 NOT NULL,
	`post_reminders_enabled` integer DEFAULT 1 NOT NULL,
	`reminder_minutes` integer DEFAULT 5 NOT NULL,
	`completion_enabled` integer DEFAULT 1 NOT NULL,
	`updated_at` text NOT NULL
);
CREATE TABLE `studio_profile` (
	`id` integer PRIMARY KEY DEFAULT 1 NOT NULL,
	`timezone` text DEFAULT 'UTC' NOT NULL,
	`timezone_label` text DEFAULT 'UTC' NOT NULL,
	`site_enabled` integer DEFAULT 0 NOT NULL,
	`video_prepare_lead_minutes` integer DEFAULT 15 NOT NULL,
	`video_retention_hours` integer DEFAULT 24 NOT NULL,
	`name_json` text DEFAULT '{"en":"","ru":""}' NOT NULL,
	`tagline_json` text DEFAULT '{"en":"","ru":""}' NOT NULL,
	`about_json` text DEFAULT '{"en":"","ru":""}' NOT NULL,
	`profiles_json` text DEFAULT '{"en":[],"ru":[]}' NOT NULL,
	`default_targets_json` text DEFAULT '["telegram","site_ru","site_en","threads_ru","threads_en","telegram_stories","instagram_stories_ru","instagram_stories"]' NOT NULL,
	`updated_at` text NOT NULL
, `bio_json` text DEFAULT '{"en":"","ru":""}' NOT NULL, `site_timezone_json` text DEFAULT '{"en":"","ru":""}' NOT NULL);
CREATE TABLE `studio_weekly_digest_settings` (
	`id` integer PRIMARY KEY DEFAULT 1 NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	`weekday` integer DEFAULT 0 NOT NULL,
	`updated_at` text NOT NULL
);
CREATE TABLE `social_comments` (
	`platform` text NOT NULL,
	`comment_id` text NOT NULL,
	`video_target_id` integer NOT NULL,
	`author` text,
	`text` text NOT NULL,
	`like_count` integer DEFAULT 0 NOT NULL,
	`published_at` text,
	`fetched_at` text NOT NULL, `parent_comment_id` text,
	PRIMARY KEY(`platform`, `comment_id`),
	FOREIGN KEY (`video_target_id`) REFERENCES `video_targets`(`id`) ON UPDATE no action ON DELETE cascade
);
CREATE INDEX `idx_social_comments_target` ON `social_comments` (`video_target_id`,`published_at`);
CREATE TABLE `video_jobs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`video_draft_id` integer NOT NULL,
	`video_target_id` integer,
	`kind` text NOT NULL,
	`run_at` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`reconcile_attempt_count` integer DEFAULT 0 NOT NULL,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` text,
	`locked_by` text,
	`locked_at` text,
	`last_error` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`video_draft_id`) REFERENCES `video_drafts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`video_target_id`) REFERENCES `video_targets`(`id`) ON UPDATE no action ON DELETE cascade
);
CREATE INDEX `idx_video_jobs_due` ON `video_jobs` (`status`,`run_at`,`next_attempt_at`);
CREATE INDEX `idx_video_jobs_lock` ON `video_jobs` (`status`,`locked_at`);
CREATE UNIQUE INDEX `idx_video_jobs_unique` ON `video_jobs` (`video_draft_id`,`video_target_id`,`kind`);
CREATE TABLE `video_metric_schedule` (
	`video_target_id` integer PRIMARY KEY NOT NULL,
	`checkpoint_index` integer DEFAULT 0 NOT NULL,
	`next_check_at` text NOT NULL,
	`last_checked_at` text,
	`last_error` text,
	`error_count` integer DEFAULT 0 NOT NULL,
	`frozen_at` text,
	`locked_by` text,
	`locked_at` text,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`video_target_id`) REFERENCES `video_targets`(`id`) ON UPDATE no action ON DELETE cascade
);
CREATE INDEX `idx_video_metric_schedule_lock` ON `video_metric_schedule` (`locked_by`,`locked_at`);
CREATE TABLE `video_metric_snapshots` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`video_target_id` integer NOT NULL,
	`platform` text NOT NULL,
	`metrics_json` text NOT NULL,
	`checkpoint_index` integer,
	`sampled_at` text NOT NULL,
	FOREIGN KEY (`video_target_id`) REFERENCES `video_targets`(`id`) ON UPDATE no action ON DELETE cascade
);
CREATE INDEX `idx_video_metric_snapshots_target_sampled` ON `video_metric_snapshots` (`video_target_id`,`sampled_at`);
CREATE INDEX `idx_video_metric_snapshots_sampled_at` ON `video_metric_snapshots` (`sampled_at`);
CREATE UNIQUE INDEX `idx_video_metric_snapshots_checkpoint` ON `video_metric_snapshots` (`video_target_id`,`checkpoint_index`) WHERE "video_metric_snapshots"."checkpoint_index" IS NOT NULL;
CREATE TABLE `video_targets` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`video_draft_id` integer NOT NULL,
	`target` text NOT NULL,
	`metadata_json` text NOT NULL,
	`scheduled_at` text,
	`status` text DEFAULT 'draft' NOT NULL,
	`delivery_provider` text DEFAULT 'native' NOT NULL,
	`provider_account_id` text,
	`provider_post_id` text,
	`external_id` text,
	`external_url` text,
	`prepared_at` text,
	`published_at` text,
	`confirmation_source` text,
	`verified_at` text,
	`last_error` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`video_draft_id`) REFERENCES `video_drafts`(`id`) ON UPDATE no action ON DELETE cascade
);
CREATE UNIQUE INDEX `idx_video_targets_draft_target` ON `video_targets` (`video_draft_id`,`target`);
CREATE INDEX `idx_video_targets_status_schedule` ON `video_targets` (`status`,`scheduled_at`);
CREATE TABLE "drafts" (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`actor_id` integer NOT NULL,
	`status` text NOT NULL,
	`targets_json` text NOT NULL,
	`scheduled_at` text,
	`scheduled_en_at` text,
	`publish_mode` text,
	`post_id` integer,
	`story_publish_mode` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
CREATE UNIQUE INDEX `drafts_post_id_unique` ON "drafts" (`post_id`);
CREATE TABLE `post_locales` (
	`draft_id` integer NOT NULL,
	`locale` text NOT NULL,
	`source_text` text DEFAULT '' NOT NULL,
	`approved_text` text,
	`html` text,
	`entities_json` text,
	`media_json` text,
	`story_media_json` text,
	`site_media_json` text,
	`slug` text,
	`site_enabled` integer DEFAULT 0 NOT NULL,
	`publish_at` text,
	`published_at` text,
	`updated_at` text NOT NULL, seo_title TEXT, site_updated_at TEXT,
	PRIMARY KEY(`draft_id`, `locale`)
);
CREATE INDEX `idx_post_locales_published_at` ON `post_locales` (`published_at`);
CREATE TABLE "metric_samples" (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`publication_key` text NOT NULL,
	`target` text NOT NULL,
	`metric_name` text DEFAULT 'views' NOT NULL,
	`value` integer,
	`sampled_at` text NOT NULL,
	`source` text,
	`raw_json` text
);
CREATE INDEX `idx_metric_samples_lookup` ON `metric_samples` (`publication_key`,`target`,`metric_name`,`sampled_at`);
CREATE INDEX `idx_metric_samples_sampled_at` ON `metric_samples` (`sampled_at`);
CREATE TABLE "metric_schedule" (
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
CREATE INDEX `idx_metric_schedule_lock` ON `metric_schedule` (`locked_by`,`locked_at`);
CREATE INDEX `idx_metric_schedule_error_updated_at` ON `metric_schedule` (`updated_at`) WHERE "metric_schedule"."last_error" IS NOT NULL AND "metric_schedule"."last_error" <> '';
CREATE TABLE "post_metrics" (
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
CREATE INDEX `idx_post_metrics_sampled_at` ON `post_metrics` (`sampled_at`);
CREATE TABLE "publication_targets" (
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
CREATE INDEX `idx_publication_targets_updated_at` ON `publication_targets` (`updated_at`);
CREATE INDEX `idx_creator_profiles_updated_at` ON `creator_profiles` (`updated_at`);
CREATE INDEX `idx_x_activity_items_last_seen_at` ON `x_activity_items` (`last_seen_at`);
CREATE TABLE "alert_dedup" (
	`alert_key` text PRIMARY KEY NOT NULL,
	`last_sent_at` text NOT NULL,
	`suppressed_count` integer DEFAULT 0 NOT NULL
);
CREATE TABLE "analytics_rollups" (
	`rollup_key` text PRIMARY KEY NOT NULL,
	`scope` text NOT NULL,
	`subject` text NOT NULL,
	`metric_json` text NOT NULL,
	`updated_at` text NOT NULL
);
CREATE TABLE "credential_checks" (
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
CREATE INDEX `idx_credential_checks_last_checked_at` ON `credential_checks` (`last_checked_at`);
CREATE TABLE "maintenance_locks" (
	`name` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`expires_at` text NOT NULL,
	`created_at` text NOT NULL
);
CREATE TABLE "media_test_cases" (
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
CREATE TABLE "worker_state" (
	`name` text PRIMARY KEY NOT NULL,
	`state_json` text NOT NULL,
	`updated_at` text NOT NULL
);
CREATE TABLE "publication_events" (
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
CREATE INDEX `idx_publication_events_lookup` ON `publication_events` (`publication_key`,`target`,`created_at`);
CREATE INDEX `idx_publication_events_created_at` ON `publication_events` (`created_at`);
CREATE TABLE "publish_jobs" (
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
CREATE UNIQUE INDEX `idx_publish_jobs_publication_target_status` ON `publish_jobs` (`publication_key`,`target`,`status`);
CREATE INDEX `idx_publish_jobs_due` ON `publish_jobs` (`status`,`publish_at`,`next_attempt_at`,`created_at`);
CREATE INDEX `idx_publish_jobs_lock` ON `publish_jobs` (`locked_by`,`locked_at`);
CREATE INDEX `idx_publish_jobs_updated_at` ON `publish_jobs` (`updated_at`);
CREATE TABLE `draft_entity_links` (
	`draft_id` integer NOT NULL,
	`entity_id` integer NOT NULL,
	`link_role` text DEFAULT 'mention' NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`draft_id`, `entity_id`)
);
CREATE INDEX `idx_draft_entity_links_entity` ON `draft_entity_links` (`entity_id`,`draft_id`);
CREATE TABLE "site_jobs" (
	`job_id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`publication_key` text NOT NULL,
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
CREATE INDEX `idx_site_jobs_due` ON `site_jobs` (`status`,`next_attempt_at`,`created_at`);
CREATE INDEX `idx_site_jobs_lock` ON `site_jobs` (`locked_by`,`locked_at`);
CREATE INDEX `idx_site_jobs_publication` ON `site_jobs` (`publication_key`,`status`);
CREATE INDEX `idx_site_jobs_updated_at` ON `site_jobs` (`updated_at`);
CREATE TABLE `studio_youtube_settings` (
	`id` integer PRIMARY KEY DEFAULT 1 NOT NULL,
	`signature` text DEFAULT '' NOT NULL,
	`updated_at` text NOT NULL
);
CREATE TABLE `studio_milestone_settings` (
	`id` integer PRIMARY KEY DEFAULT 1 NOT NULL,
	`channel_enabled` integer DEFAULT 1 NOT NULL,
	`group_locale_enabled` integer DEFAULT 1 NOT NULL,
	`locale_enabled` integer DEFAULT 1 NOT NULL,
	`project_enabled` integer DEFAULT 1 NOT NULL,
	`thresholds_json` text DEFAULT '[100,250,500,1000,2000,3000,4000,5000,6000,7000,8000,9000,10000]' NOT NULL,
	`updated_at` text NOT NULL
);
CREATE TABLE `studio_news_digest_settings` (
	`id` integer PRIMARY KEY DEFAULT 1 NOT NULL,
	`enabled` integer DEFAULT 0 NOT NULL,
	`hour` integer DEFAULT 10 NOT NULL,
	`minute` integer DEFAULT 0 NOT NULL,
	`prompt` text DEFAULT '' NOT NULL,
	`effort` text DEFAULT 'xhigh' NOT NULL,
	`updated_at` text NOT NULL
);
CREATE TABLE `telegram_discussion_threads` (
	`chat_id` text NOT NULL,
	`thread_id` integer NOT NULL,
	`channel_post_id` text NOT NULL,
	`seen_at` text NOT NULL,
	PRIMARY KEY(`chat_id`, `thread_id`)
);
CREATE INDEX `idx_telegram_discussion_threads_post` ON `telegram_discussion_threads` (`channel_post_id`);
CREATE TABLE `draft_translations` (
	`draft_id` integer PRIMARY KEY NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` text,
	`locked_by` text,
	`locked_at` text,
	`last_error` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
CREATE INDEX `idx_draft_translations_due` ON `draft_translations` (`status`,`next_attempt_at`,`created_at`);
CREATE TABLE `audience_activity` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`platform` text NOT NULL,
	`account` text NOT NULL,
	`metric` text NOT NULL,
	`weekday` text NOT NULL,
	`hour_local` integer NOT NULL,
	`value` integer NOT NULL,
	`time_zone` text NOT NULL,
	`period_start` text,
	`period_end` text,
	`captured_at` text NOT NULL,
	`source` text
);
CREATE UNIQUE INDEX `idx_audience_activity_slot` ON `audience_activity` (`platform`,`account`,`metric`,`captured_at`,`weekday`,`hour_local`);
CREATE INDEX `idx_audience_activity_captured_at` ON `audience_activity` (`captured_at`);
CREATE TABLE `audience_demographics` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`platform` text NOT NULL,
	`account` text NOT NULL,
	`metric` text NOT NULL,
	`dimension` text NOT NULL,
	`label` text NOT NULL,
	`value` integer NOT NULL,
	`timeframe` text NOT NULL,
	`captured_on` text NOT NULL,
	`captured_at` text NOT NULL,
	`source` text NOT NULL
, `unit` text DEFAULT 'count' NOT NULL);
CREATE UNIQUE INDEX `idx_audience_demographics_daily` ON `audience_demographics` (`platform`,`account`,`metric`,`dimension`,`label`,`captured_on`);
CREATE INDEX `idx_audience_demographics_captured_at` ON `audience_demographics` (`captured_at`);
CREATE TABLE `games` (
	`name` text PRIMARY KEY NOT NULL,
	`steam_app_id` text,
	`genres` text,
	`player_modes` text,
	`release_date` text,
	`developer` text,
	`source` text NOT NULL,
	`captured_at` text NOT NULL
);
CREATE INDEX `idx_games_captured_at` ON `games` (`captured_at`);
CREATE TABLE `video_frame_features` (
	`video_draft_id` integer NOT NULL,
	`at_seconds` integer NOT NULL,
	`features_json` text NOT NULL,
	`source` text NOT NULL,
	`captured_at` text NOT NULL, image_path text,
	PRIMARY KEY(`video_draft_id`, `at_seconds`),
	FOREIGN KEY (`video_draft_id`) REFERENCES `video_drafts`(`id`) ON UPDATE no action ON DELETE cascade
);
CREATE TABLE "video_drafts" (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`actor_id` integer NOT NULL,
	`locale` text DEFAULT 'ru' NOT NULL,
	`label` text DEFAULT '' NOT NULL,
	`studio_media_asset_id` integer REFERENCES `studio_media_assets`(`id`),
	`status` text DEFAULT 'draft' NOT NULL,
	`scheduled_at` text,
	`retention_until` text,
	`source_pruned_at` text,
	`control_chat_id` integer,
	`control_message_id` integer,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`game` text,
	`hook` text,
	`script` text,
	`script_source` text,
	`opening_line` text
);
CREATE INDEX `idx_video_drafts_status_schedule` ON `video_drafts` (`status`,`scheduled_at`);
CREATE INDEX `idx_video_drafts_studio_media_asset` ON `video_drafts` (`studio_media_asset_id`);
CREATE INDEX `idx_video_drafts_updated_at` ON `video_drafts` (`updated_at`);
CREATE TABLE `post_comments` (
	`target` text NOT NULL,
	`comment_id` text NOT NULL,
	`external_post_id` text,
	`container_id` text,
	`author_id` text,
	`author` text DEFAULT '' NOT NULL,
	`text` text DEFAULT '' NOT NULL,
	`reply_to_comment_id` text,
	`sent_at` text NOT NULL,
	`edited_at` text,
	`fetched_at` text NOT NULL,
	PRIMARY KEY(`target`, `comment_id`)
);
CREATE INDEX `idx_post_comments_post` ON `post_comments` (`external_post_id`,`sent_at`);
CREATE INDEX `idx_post_comments_container` ON `post_comments` (`target`,`container_id`);
CREATE INDEX `idx_post_comments_sent_at` ON `post_comments` (`sent_at`);
CREATE TABLE `draft_thread_parts` (
	`draft_id` integer NOT NULL,
	`position` integer NOT NULL,
	`text_ru` text NOT NULL,
	`entities_ru_json` text,
	`text_en` text,
	`media_json` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL, `text_en_approved` text,
	PRIMARY KEY(`draft_id`, `position`)
);
CREATE TABLE `publication_cancellations` (
	`publication_key` text PRIMARY KEY NOT NULL,
	`actor_id` integer NOT NULL,
	`requested_at` text NOT NULL
);
CREATE TRIGGER post_locales_site_content_updated
AFTER UPDATE OF source_text, approved_text, html, site_media_json, slug, seo_title ON post_locales
WHEN OLD.site_enabled = 1 AND NEW.site_enabled = 1
  AND julianday(NEW.published_at) <= julianday('now')
  AND (coalesce(OLD.approved_text, OLD.source_text) IS NOT coalesce(NEW.approved_text, NEW.source_text)
    OR OLD.html IS NOT NEW.html OR OLD.slug IS NOT NEW.slug OR OLD.seo_title IS NOT NEW.seo_title
    OR (SELECT json_group_array(json_object(
      'id', coalesce(json_extract(value, '$.asset_id'), json_extract(value, '$.file_id'), json_extract(value, '$.fileId'),
        json_extract(value, '$.local_path'), json_extract(value, '$.localPath'),
        replace(replace(CASE WHEN instr(json_extract(value, '$.path'), '?') > 0
          THEN substr(json_extract(value, '$.path'), 1, instr(json_extract(value, '$.path'), '?') - 1)
          ELSE json_extract(value, '$.path') END, '-vertical.jpg', '.jpg'), '-vertical.mp4', '.mp4')),
      'type', CASE WHEN lower(json_extract(value, '$.type')) = 'video' THEN 'video' ELSE 'image' END,
      'alt', coalesce(json_extract(value, '$.alt'), '')))
    FROM json_each(coalesce(OLD.site_media_json, '[]'))
    WHERE coalesce(json_extract(value, '$.role'), '') <> 'text_story_card') IS NOT (SELECT json_group_array(json_object(
      'id', coalesce(json_extract(value, '$.asset_id'), json_extract(value, '$.file_id'), json_extract(value, '$.fileId'),
        json_extract(value, '$.local_path'), json_extract(value, '$.localPath'),
        replace(replace(CASE WHEN instr(json_extract(value, '$.path'), '?') > 0
          THEN substr(json_extract(value, '$.path'), 1, instr(json_extract(value, '$.path'), '?') - 1)
          ELSE json_extract(value, '$.path') END, '-vertical.jpg', '.jpg'), '-vertical.mp4', '.mp4')),
      'type', CASE WHEN lower(json_extract(value, '$.type')) = 'video' THEN 'video' ELSE 'image' END,
      'alt', coalesce(json_extract(value, '$.alt'), '')))
    FROM json_each(coalesce(NEW.site_media_json, '[]'))
    WHERE coalesce(json_extract(value, '$.role'), '') <> 'text_story_card'))
BEGIN
  UPDATE post_locales SET site_updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE draft_id = NEW.draft_id AND locale = NEW.locale;
END;
CREATE TRIGGER "date_guard_analytics_sync_last_synced_at_insert" BEFORE INSERT ON "analytics_sync"
         FOR EACH ROW WHEN NEW."last_synced_at" IS NOT NULL AND NEW."last_synced_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'analytics_sync.last_synced_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_analytics_sync_last_synced_at_update" BEFORE UPDATE OF "last_synced_at" ON "analytics_sync"
         FOR EACH ROW WHEN NEW."last_synced_at" IS NOT NULL AND NEW."last_synced_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'analytics_sync.last_synced_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_analytics_sync_last_success_at_insert" BEFORE INSERT ON "analytics_sync"
         FOR EACH ROW WHEN NEW."last_success_at" IS NOT NULL AND NEW."last_success_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'analytics_sync.last_success_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_analytics_sync_last_success_at_update" BEFORE UPDATE OF "last_success_at" ON "analytics_sync"
         FOR EACH ROW WHEN NEW."last_success_at" IS NOT NULL AND NEW."last_success_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'analytics_sync.last_success_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_analytics_sync_locked_at_insert" BEFORE INSERT ON "analytics_sync"
         FOR EACH ROW WHEN NEW."locked_at" IS NOT NULL AND NEW."locked_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'analytics_sync.locked_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_analytics_sync_locked_at_update" BEFORE UPDATE OF "locked_at" ON "analytics_sync"
         FOR EACH ROW WHEN NEW."locked_at" IS NOT NULL AND NEW."locked_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'analytics_sync.locked_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_creator_profile_snapshots_sampled_on_insert" BEFORE INSERT ON "creator_profile_snapshots"
         FOR EACH ROW WHEN NEW."sampled_on" IS NOT NULL AND NEW."sampled_on" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND NEW."sampled_on" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]'
         BEGIN SELECT RAISE(ABORT, 'creator_profile_snapshots.sampled_on must be a calendar day such as 2026-08-27, or an hour bucket such as 2026-08-27T15'); END;
CREATE TRIGGER "date_guard_creator_profile_snapshots_sampled_on_update" BEFORE UPDATE OF "sampled_on" ON "creator_profile_snapshots"
         FOR EACH ROW WHEN NEW."sampled_on" IS NOT NULL AND NEW."sampled_on" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND NEW."sampled_on" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]'
         BEGIN SELECT RAISE(ABORT, 'creator_profile_snapshots.sampled_on must be a calendar day such as 2026-08-27, or an hour bucket such as 2026-08-27T15'); END;
CREATE TRIGGER "date_guard_creator_profile_snapshots_sampled_at_insert" BEFORE INSERT ON "creator_profile_snapshots"
         FOR EACH ROW WHEN NEW."sampled_at" IS NOT NULL AND NEW."sampled_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'creator_profile_snapshots.sampled_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_creator_profile_snapshots_sampled_at_update" BEFORE UPDATE OF "sampled_at" ON "creator_profile_snapshots"
         FOR EACH ROW WHEN NEW."sampled_at" IS NOT NULL AND NEW."sampled_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'creator_profile_snapshots.sampled_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_creator_profiles_updated_at_insert" BEFORE INSERT ON "creator_profiles"
         FOR EACH ROW WHEN NEW."updated_at" IS NOT NULL AND NEW."updated_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'creator_profiles.updated_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_creator_profiles_updated_at_update" BEFORE UPDATE OF "updated_at" ON "creator_profiles"
         FOR EACH ROW WHEN NEW."updated_at" IS NOT NULL AND NEW."updated_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'creator_profiles.updated_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_x_activity_imports_period_start_insert" BEFORE INSERT ON "x_activity_imports"
         FOR EACH ROW WHEN NEW."period_start" IS NOT NULL AND NEW."period_start" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND NEW."period_start" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]'
         BEGIN SELECT RAISE(ABORT, 'x_activity_imports.period_start must be a calendar day such as 2026-08-27, or an hour bucket such as 2026-08-27T15'); END;
CREATE TRIGGER "date_guard_x_activity_imports_period_start_update" BEFORE UPDATE OF "period_start" ON "x_activity_imports"
         FOR EACH ROW WHEN NEW."period_start" IS NOT NULL AND NEW."period_start" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND NEW."period_start" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]'
         BEGIN SELECT RAISE(ABORT, 'x_activity_imports.period_start must be a calendar day such as 2026-08-27, or an hour bucket such as 2026-08-27T15'); END;
CREATE TRIGGER "date_guard_x_activity_imports_period_end_insert" BEFORE INSERT ON "x_activity_imports"
         FOR EACH ROW WHEN NEW."period_end" IS NOT NULL AND NEW."period_end" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND NEW."period_end" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]'
         BEGIN SELECT RAISE(ABORT, 'x_activity_imports.period_end must be a calendar day such as 2026-08-27, or an hour bucket such as 2026-08-27T15'); END;
CREATE TRIGGER "date_guard_x_activity_imports_period_end_update" BEFORE UPDATE OF "period_end" ON "x_activity_imports"
         FOR EACH ROW WHEN NEW."period_end" IS NOT NULL AND NEW."period_end" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND NEW."period_end" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]'
         BEGIN SELECT RAISE(ABORT, 'x_activity_imports.period_end must be a calendar day such as 2026-08-27, or an hour bucket such as 2026-08-27T15'); END;
CREATE TRIGGER "date_guard_x_activity_imports_sampled_at_insert" BEFORE INSERT ON "x_activity_imports"
         FOR EACH ROW WHEN NEW."sampled_at" IS NOT NULL AND NEW."sampled_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'x_activity_imports.sampled_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_x_activity_imports_sampled_at_update" BEFORE UPDATE OF "sampled_at" ON "x_activity_imports"
         FOR EACH ROW WHEN NEW."sampled_at" IS NOT NULL AND NEW."sampled_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'x_activity_imports.sampled_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_x_activity_imports_imported_at_insert" BEFORE INSERT ON "x_activity_imports"
         FOR EACH ROW WHEN NEW."imported_at" IS NOT NULL AND NEW."imported_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'x_activity_imports.imported_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_x_activity_imports_imported_at_update" BEFORE UPDATE OF "imported_at" ON "x_activity_imports"
         FOR EACH ROW WHEN NEW."imported_at" IS NOT NULL AND NEW."imported_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'x_activity_imports.imported_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_x_activity_items_published_at_insert" BEFORE INSERT ON "x_activity_items"
         FOR EACH ROW WHEN NEW."published_at" IS NOT NULL AND NEW."published_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'x_activity_items.published_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_x_activity_items_published_at_update" BEFORE UPDATE OF "published_at" ON "x_activity_items"
         FOR EACH ROW WHEN NEW."published_at" IS NOT NULL AND NEW."published_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'x_activity_items.published_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_x_activity_items_first_seen_at_insert" BEFORE INSERT ON "x_activity_items"
         FOR EACH ROW WHEN NEW."first_seen_at" IS NOT NULL AND NEW."first_seen_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'x_activity_items.first_seen_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_x_activity_items_first_seen_at_update" BEFORE UPDATE OF "first_seen_at" ON "x_activity_items"
         FOR EACH ROW WHEN NEW."first_seen_at" IS NOT NULL AND NEW."first_seen_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'x_activity_items.first_seen_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_x_activity_items_last_seen_at_insert" BEFORE INSERT ON "x_activity_items"
         FOR EACH ROW WHEN NEW."last_seen_at" IS NOT NULL AND NEW."last_seen_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'x_activity_items.last_seen_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_x_activity_items_last_seen_at_update" BEFORE UPDATE OF "last_seen_at" ON "x_activity_items"
         FOR EACH ROW WHEN NEW."last_seen_at" IS NOT NULL AND NEW."last_seen_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'x_activity_items.last_seen_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_x_activity_metric_snapshots_sampled_at_insert" BEFORE INSERT ON "x_activity_metric_snapshots"
         FOR EACH ROW WHEN NEW."sampled_at" IS NOT NULL AND NEW."sampled_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'x_activity_metric_snapshots.sampled_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_x_activity_metric_snapshots_sampled_at_update" BEFORE UPDATE OF "sampled_at" ON "x_activity_metric_snapshots"
         FOR EACH ROW WHEN NEW."sampled_at" IS NOT NULL AND NEW."sampled_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'x_activity_metric_snapshots.sampled_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_article_locales_published_at_insert" BEFORE INSERT ON "article_locales"
         FOR EACH ROW WHEN NEW."published_at" IS NOT NULL AND NEW."published_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'article_locales.published_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_article_locales_published_at_update" BEFORE UPDATE OF "published_at" ON "article_locales"
         FOR EACH ROW WHEN NEW."published_at" IS NOT NULL AND NEW."published_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'article_locales.published_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_article_locales_updated_at_insert" BEFORE INSERT ON "article_locales"
         FOR EACH ROW WHEN NEW."updated_at" IS NOT NULL AND NEW."updated_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'article_locales.updated_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_article_locales_updated_at_update" BEFORE UPDATE OF "updated_at" ON "article_locales"
         FOR EACH ROW WHEN NEW."updated_at" IS NOT NULL AND NEW."updated_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'article_locales.updated_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_articles_created_at_insert" BEFORE INSERT ON "articles"
         FOR EACH ROW WHEN NEW."created_at" IS NOT NULL AND NEW."created_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'articles.created_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_articles_created_at_update" BEFORE UPDATE OF "created_at" ON "articles"
         FOR EACH ROW WHEN NEW."created_at" IS NOT NULL AND NEW."created_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'articles.created_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_articles_updated_at_insert" BEFORE INSERT ON "articles"
         FOR EACH ROW WHEN NEW."updated_at" IS NOT NULL AND NEW."updated_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'articles.updated_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_articles_updated_at_update" BEFORE UPDATE OF "updated_at" ON "articles"
         FOR EACH ROW WHEN NEW."updated_at" IS NOT NULL AND NEW."updated_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'articles.updated_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_conversation_sessions_updated_at_insert" BEFORE INSERT ON "conversation_sessions"
         FOR EACH ROW WHEN NEW."updated_at" IS NOT NULL AND NEW."updated_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'conversation_sessions.updated_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_conversation_sessions_updated_at_update" BEFORE UPDATE OF "updated_at" ON "conversation_sessions"
         FOR EACH ROW WHEN NEW."updated_at" IS NOT NULL AND NEW."updated_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'conversation_sessions.updated_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_conversation_sessions_expires_at_insert" BEFORE INSERT ON "conversation_sessions"
         FOR EACH ROW WHEN NEW."expires_at" IS NOT NULL AND NEW."expires_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'conversation_sessions.expires_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_conversation_sessions_expires_at_update" BEFORE UPDATE OF "expires_at" ON "conversation_sessions"
         FOR EACH ROW WHEN NEW."expires_at" IS NOT NULL AND NEW."expires_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'conversation_sessions.expires_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_draft_entity_candidates_created_at_insert" BEFORE INSERT ON "draft_entity_candidates"
         FOR EACH ROW WHEN NEW."created_at" IS NOT NULL AND NEW."created_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'draft_entity_candidates.created_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_draft_entity_candidates_created_at_update" BEFORE UPDATE OF "created_at" ON "draft_entity_candidates"
         FOR EACH ROW WHEN NEW."created_at" IS NOT NULL AND NEW."created_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'draft_entity_candidates.created_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_draft_entity_candidates_updated_at_insert" BEFORE INSERT ON "draft_entity_candidates"
         FOR EACH ROW WHEN NEW."updated_at" IS NOT NULL AND NEW."updated_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'draft_entity_candidates.updated_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_draft_entity_candidates_updated_at_update" BEFORE UPDATE OF "updated_at" ON "draft_entity_candidates"
         FOR EACH ROW WHEN NEW."updated_at" IS NOT NULL AND NEW."updated_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'draft_entity_candidates.updated_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_knowledge_entities_created_at_insert" BEFORE INSERT ON "knowledge_entities"
         FOR EACH ROW WHEN NEW."created_at" IS NOT NULL AND NEW."created_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'knowledge_entities.created_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_knowledge_entities_created_at_update" BEFORE UPDATE OF "created_at" ON "knowledge_entities"
         FOR EACH ROW WHEN NEW."created_at" IS NOT NULL AND NEW."created_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'knowledge_entities.created_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_knowledge_entities_updated_at_insert" BEFORE INSERT ON "knowledge_entities"
         FOR EACH ROW WHEN NEW."updated_at" IS NOT NULL AND NEW."updated_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'knowledge_entities.updated_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_knowledge_entities_updated_at_update" BEFORE UPDATE OF "updated_at" ON "knowledge_entities"
         FOR EACH ROW WHEN NEW."updated_at" IS NOT NULL AND NEW."updated_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'knowledge_entities.updated_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_knowledge_entity_aliases_created_at_insert" BEFORE INSERT ON "knowledge_entity_aliases"
         FOR EACH ROW WHEN NEW."created_at" IS NOT NULL AND NEW."created_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'knowledge_entity_aliases.created_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_knowledge_entity_aliases_created_at_update" BEFORE UPDATE OF "created_at" ON "knowledge_entity_aliases"
         FOR EACH ROW WHEN NEW."created_at" IS NOT NULL AND NEW."created_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'knowledge_entity_aliases.created_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_format_support_updated_at_insert" BEFORE INSERT ON "format_support"
         FOR EACH ROW WHEN NEW."updated_at" IS NOT NULL AND NEW."updated_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'format_support.updated_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_format_support_updated_at_update" BEFORE UPDATE OF "updated_at" ON "format_support"
         FOR EACH ROW WHEN NEW."updated_at" IS NOT NULL AND NEW."updated_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'format_support.updated_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_platform_tokens_expires_at_insert" BEFORE INSERT ON "platform_tokens"
         FOR EACH ROW WHEN NEW."expires_at" IS NOT NULL AND NEW."expires_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'platform_tokens.expires_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_platform_tokens_expires_at_update" BEFORE UPDATE OF "expires_at" ON "platform_tokens"
         FOR EACH ROW WHEN NEW."expires_at" IS NOT NULL AND NEW."expires_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'platform_tokens.expires_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_platform_tokens_refreshed_at_insert" BEFORE INSERT ON "platform_tokens"
         FOR EACH ROW WHEN NEW."refreshed_at" IS NOT NULL AND NEW."refreshed_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'platform_tokens.refreshed_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_platform_tokens_refreshed_at_update" BEFORE UPDATE OF "refreshed_at" ON "platform_tokens"
         FOR EACH ROW WHEN NEW."refreshed_at" IS NOT NULL AND NEW."refreshed_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'platform_tokens.refreshed_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_platform_tokens_updated_at_insert" BEFORE INSERT ON "platform_tokens"
         FOR EACH ROW WHEN NEW."updated_at" IS NOT NULL AND NEW."updated_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'platform_tokens.updated_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_platform_tokens_updated_at_update" BEFORE UPDATE OF "updated_at" ON "platform_tokens"
         FOR EACH ROW WHEN NEW."updated_at" IS NOT NULL AND NEW."updated_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'platform_tokens.updated_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_runtime_usage_first_seen_at_insert" BEFORE INSERT ON "runtime_usage"
         FOR EACH ROW WHEN NEW."first_seen_at" IS NOT NULL AND NEW."first_seen_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'runtime_usage.first_seen_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_runtime_usage_first_seen_at_update" BEFORE UPDATE OF "first_seen_at" ON "runtime_usage"
         FOR EACH ROW WHEN NEW."first_seen_at" IS NOT NULL AND NEW."first_seen_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'runtime_usage.first_seen_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_runtime_usage_last_seen_at_insert" BEFORE INSERT ON "runtime_usage"
         FOR EACH ROW WHEN NEW."last_seen_at" IS NOT NULL AND NEW."last_seen_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'runtime_usage.last_seen_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_runtime_usage_last_seen_at_update" BEFORE UPDATE OF "last_seen_at" ON "runtime_usage"
         FOR EACH ROW WHEN NEW."last_seen_at" IS NOT NULL AND NEW."last_seen_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'runtime_usage.last_seen_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_draft_story_cards_next_attempt_at_insert" BEFORE INSERT ON "draft_story_cards"
         FOR EACH ROW WHEN NEW."next_attempt_at" IS NOT NULL AND NEW."next_attempt_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'draft_story_cards.next_attempt_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_draft_story_cards_next_attempt_at_update" BEFORE UPDATE OF "next_attempt_at" ON "draft_story_cards"
         FOR EACH ROW WHEN NEW."next_attempt_at" IS NOT NULL AND NEW."next_attempt_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'draft_story_cards.next_attempt_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_draft_story_cards_locked_at_insert" BEFORE INSERT ON "draft_story_cards"
         FOR EACH ROW WHEN NEW."locked_at" IS NOT NULL AND NEW."locked_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'draft_story_cards.locked_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_draft_story_cards_locked_at_update" BEFORE UPDATE OF "locked_at" ON "draft_story_cards"
         FOR EACH ROW WHEN NEW."locked_at" IS NOT NULL AND NEW."locked_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'draft_story_cards.locked_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_draft_story_cards_created_at_insert" BEFORE INSERT ON "draft_story_cards"
         FOR EACH ROW WHEN NEW."created_at" IS NOT NULL AND NEW."created_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'draft_story_cards.created_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_draft_story_cards_created_at_update" BEFORE UPDATE OF "created_at" ON "draft_story_cards"
         FOR EACH ROW WHEN NEW."created_at" IS NOT NULL AND NEW."created_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'draft_story_cards.created_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_draft_story_cards_updated_at_insert" BEFORE INSERT ON "draft_story_cards"
         FOR EACH ROW WHEN NEW."updated_at" IS NOT NULL AND NEW."updated_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'draft_story_cards.updated_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_draft_story_cards_updated_at_update" BEFORE UPDATE OF "updated_at" ON "draft_story_cards"
         FOR EACH ROW WHEN NEW."updated_at" IS NOT NULL AND NEW."updated_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'draft_story_cards.updated_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_pending_albums_updated_at_insert" BEFORE INSERT ON "pending_albums"
         FOR EACH ROW WHEN NEW."updated_at" IS NOT NULL AND NEW."updated_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'pending_albums.updated_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_pending_albums_updated_at_update" BEFORE UPDATE OF "updated_at" ON "pending_albums"
         FOR EACH ROW WHEN NEW."updated_at" IS NOT NULL AND NEW."updated_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'pending_albums.updated_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_site_pageviews_updated_at_insert" BEFORE INSERT ON "site_pageviews"
         FOR EACH ROW WHEN NEW."updated_at" IS NOT NULL AND NEW."updated_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'site_pageviews.updated_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_site_pageviews_updated_at_update" BEFORE UPDATE OF "updated_at" ON "site_pageviews"
         FOR EACH ROW WHEN NEW."updated_at" IS NOT NULL AND NEW."updated_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'site_pageviews.updated_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_bot_ui_settings_updated_at_insert" BEFORE INSERT ON "bot_ui_settings"
         FOR EACH ROW WHEN NEW."updated_at" IS NOT NULL AND NEW."updated_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'bot_ui_settings.updated_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_bot_ui_settings_updated_at_update" BEFORE UPDATE OF "updated_at" ON "bot_ui_settings"
         FOR EACH ROW WHEN NEW."updated_at" IS NOT NULL AND NEW."updated_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'bot_ui_settings.updated_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_channel_connections_created_at_insert" BEFORE INSERT ON "channel_connections"
         FOR EACH ROW WHEN NEW."created_at" IS NOT NULL AND NEW."created_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'channel_connections.created_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_channel_connections_created_at_update" BEFORE UPDATE OF "created_at" ON "channel_connections"
         FOR EACH ROW WHEN NEW."created_at" IS NOT NULL AND NEW."created_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'channel_connections.created_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_channel_connections_updated_at_insert" BEFORE INSERT ON "channel_connections"
         FOR EACH ROW WHEN NEW."updated_at" IS NOT NULL AND NEW."updated_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'channel_connections.updated_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_channel_connections_updated_at_update" BEFORE UPDATE OF "updated_at" ON "channel_connections"
         FOR EACH ROW WHEN NEW."updated_at" IS NOT NULL AND NEW."updated_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'channel_connections.updated_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_interface_bindings_created_at_insert" BEFORE INSERT ON "interface_bindings"
         FOR EACH ROW WHEN NEW."created_at" IS NOT NULL AND NEW."created_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'interface_bindings.created_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_interface_bindings_created_at_update" BEFORE UPDATE OF "created_at" ON "interface_bindings"
         FOR EACH ROW WHEN NEW."created_at" IS NOT NULL AND NEW."created_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'interface_bindings.created_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_interface_bindings_updated_at_insert" BEFORE INSERT ON "interface_bindings"
         FOR EACH ROW WHEN NEW."updated_at" IS NOT NULL AND NEW."updated_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'interface_bindings.updated_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_interface_bindings_updated_at_update" BEFORE UPDATE OF "updated_at" ON "interface_bindings"
         FOR EACH ROW WHEN NEW."updated_at" IS NOT NULL AND NEW."updated_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'interface_bindings.updated_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_studio_backup_settings_updated_at_insert" BEFORE INSERT ON "studio_backup_settings"
         FOR EACH ROW WHEN NEW."updated_at" IS NOT NULL AND NEW."updated_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'studio_backup_settings.updated_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_studio_backup_settings_updated_at_update" BEFORE UPDATE OF "updated_at" ON "studio_backup_settings"
         FOR EACH ROW WHEN NEW."updated_at" IS NOT NULL AND NEW."updated_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'studio_backup_settings.updated_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_studio_media_assets_created_at_insert" BEFORE INSERT ON "studio_media_assets"
         FOR EACH ROW WHEN NEW."created_at" IS NOT NULL AND NEW."created_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'studio_media_assets.created_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_studio_media_assets_created_at_update" BEFORE UPDATE OF "created_at" ON "studio_media_assets"
         FOR EACH ROW WHEN NEW."created_at" IS NOT NULL AND NEW."created_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'studio_media_assets.created_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_studio_notification_jobs_run_at_insert" BEFORE INSERT ON "studio_notification_jobs"
         FOR EACH ROW WHEN NEW."run_at" IS NOT NULL AND NEW."run_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'studio_notification_jobs.run_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_studio_notification_jobs_run_at_update" BEFORE UPDATE OF "run_at" ON "studio_notification_jobs"
         FOR EACH ROW WHEN NEW."run_at" IS NOT NULL AND NEW."run_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'studio_notification_jobs.run_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_studio_notification_jobs_created_at_insert" BEFORE INSERT ON "studio_notification_jobs"
         FOR EACH ROW WHEN NEW."created_at" IS NOT NULL AND NEW."created_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'studio_notification_jobs.created_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_studio_notification_jobs_created_at_update" BEFORE UPDATE OF "created_at" ON "studio_notification_jobs"
         FOR EACH ROW WHEN NEW."created_at" IS NOT NULL AND NEW."created_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'studio_notification_jobs.created_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_studio_notification_jobs_updated_at_insert" BEFORE INSERT ON "studio_notification_jobs"
         FOR EACH ROW WHEN NEW."updated_at" IS NOT NULL AND NEW."updated_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'studio_notification_jobs.updated_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_studio_notification_jobs_updated_at_update" BEFORE UPDATE OF "updated_at" ON "studio_notification_jobs"
         FOR EACH ROW WHEN NEW."updated_at" IS NOT NULL AND NEW."updated_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'studio_notification_jobs.updated_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_studio_notification_settings_updated_at_insert" BEFORE INSERT ON "studio_notification_settings"
         FOR EACH ROW WHEN NEW."updated_at" IS NOT NULL AND NEW."updated_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'studio_notification_settings.updated_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_studio_notification_settings_updated_at_update" BEFORE UPDATE OF "updated_at" ON "studio_notification_settings"
         FOR EACH ROW WHEN NEW."updated_at" IS NOT NULL AND NEW."updated_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'studio_notification_settings.updated_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_studio_profile_updated_at_insert" BEFORE INSERT ON "studio_profile"
         FOR EACH ROW WHEN NEW."updated_at" IS NOT NULL AND NEW."updated_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'studio_profile.updated_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_studio_profile_updated_at_update" BEFORE UPDATE OF "updated_at" ON "studio_profile"
         FOR EACH ROW WHEN NEW."updated_at" IS NOT NULL AND NEW."updated_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'studio_profile.updated_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_studio_weekly_digest_settings_updated_at_insert" BEFORE INSERT ON "studio_weekly_digest_settings"
         FOR EACH ROW WHEN NEW."updated_at" IS NOT NULL AND NEW."updated_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'studio_weekly_digest_settings.updated_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_studio_weekly_digest_settings_updated_at_update" BEFORE UPDATE OF "updated_at" ON "studio_weekly_digest_settings"
         FOR EACH ROW WHEN NEW."updated_at" IS NOT NULL AND NEW."updated_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'studio_weekly_digest_settings.updated_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_social_comments_published_at_insert" BEFORE INSERT ON "social_comments"
         FOR EACH ROW WHEN NEW."published_at" IS NOT NULL AND NEW."published_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'social_comments.published_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_social_comments_published_at_update" BEFORE UPDATE OF "published_at" ON "social_comments"
         FOR EACH ROW WHEN NEW."published_at" IS NOT NULL AND NEW."published_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'social_comments.published_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_social_comments_fetched_at_insert" BEFORE INSERT ON "social_comments"
         FOR EACH ROW WHEN NEW."fetched_at" IS NOT NULL AND NEW."fetched_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'social_comments.fetched_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_social_comments_fetched_at_update" BEFORE UPDATE OF "fetched_at" ON "social_comments"
         FOR EACH ROW WHEN NEW."fetched_at" IS NOT NULL AND NEW."fetched_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'social_comments.fetched_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_video_jobs_run_at_insert" BEFORE INSERT ON "video_jobs"
         FOR EACH ROW WHEN NEW."run_at" IS NOT NULL AND NEW."run_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'video_jobs.run_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_video_jobs_run_at_update" BEFORE UPDATE OF "run_at" ON "video_jobs"
         FOR EACH ROW WHEN NEW."run_at" IS NOT NULL AND NEW."run_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'video_jobs.run_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_video_jobs_next_attempt_at_insert" BEFORE INSERT ON "video_jobs"
         FOR EACH ROW WHEN NEW."next_attempt_at" IS NOT NULL AND NEW."next_attempt_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'video_jobs.next_attempt_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_video_jobs_next_attempt_at_update" BEFORE UPDATE OF "next_attempt_at" ON "video_jobs"
         FOR EACH ROW WHEN NEW."next_attempt_at" IS NOT NULL AND NEW."next_attempt_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'video_jobs.next_attempt_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_video_jobs_locked_at_insert" BEFORE INSERT ON "video_jobs"
         FOR EACH ROW WHEN NEW."locked_at" IS NOT NULL AND NEW."locked_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'video_jobs.locked_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_video_jobs_locked_at_update" BEFORE UPDATE OF "locked_at" ON "video_jobs"
         FOR EACH ROW WHEN NEW."locked_at" IS NOT NULL AND NEW."locked_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'video_jobs.locked_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_video_jobs_created_at_insert" BEFORE INSERT ON "video_jobs"
         FOR EACH ROW WHEN NEW."created_at" IS NOT NULL AND NEW."created_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'video_jobs.created_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_video_jobs_created_at_update" BEFORE UPDATE OF "created_at" ON "video_jobs"
         FOR EACH ROW WHEN NEW."created_at" IS NOT NULL AND NEW."created_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'video_jobs.created_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_video_jobs_updated_at_insert" BEFORE INSERT ON "video_jobs"
         FOR EACH ROW WHEN NEW."updated_at" IS NOT NULL AND NEW."updated_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'video_jobs.updated_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_video_jobs_updated_at_update" BEFORE UPDATE OF "updated_at" ON "video_jobs"
         FOR EACH ROW WHEN NEW."updated_at" IS NOT NULL AND NEW."updated_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'video_jobs.updated_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_video_metric_schedule_next_check_at_insert" BEFORE INSERT ON "video_metric_schedule"
         FOR EACH ROW WHEN NEW."next_check_at" IS NOT NULL AND NEW."next_check_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'video_metric_schedule.next_check_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_video_metric_schedule_next_check_at_update" BEFORE UPDATE OF "next_check_at" ON "video_metric_schedule"
         FOR EACH ROW WHEN NEW."next_check_at" IS NOT NULL AND NEW."next_check_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'video_metric_schedule.next_check_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_video_metric_schedule_last_checked_at_insert" BEFORE INSERT ON "video_metric_schedule"
         FOR EACH ROW WHEN NEW."last_checked_at" IS NOT NULL AND NEW."last_checked_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'video_metric_schedule.last_checked_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_video_metric_schedule_last_checked_at_update" BEFORE UPDATE OF "last_checked_at" ON "video_metric_schedule"
         FOR EACH ROW WHEN NEW."last_checked_at" IS NOT NULL AND NEW."last_checked_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'video_metric_schedule.last_checked_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_video_metric_schedule_frozen_at_insert" BEFORE INSERT ON "video_metric_schedule"
         FOR EACH ROW WHEN NEW."frozen_at" IS NOT NULL AND NEW."frozen_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'video_metric_schedule.frozen_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_video_metric_schedule_frozen_at_update" BEFORE UPDATE OF "frozen_at" ON "video_metric_schedule"
         FOR EACH ROW WHEN NEW."frozen_at" IS NOT NULL AND NEW."frozen_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'video_metric_schedule.frozen_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_video_metric_schedule_locked_at_insert" BEFORE INSERT ON "video_metric_schedule"
         FOR EACH ROW WHEN NEW."locked_at" IS NOT NULL AND NEW."locked_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'video_metric_schedule.locked_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_video_metric_schedule_locked_at_update" BEFORE UPDATE OF "locked_at" ON "video_metric_schedule"
         FOR EACH ROW WHEN NEW."locked_at" IS NOT NULL AND NEW."locked_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'video_metric_schedule.locked_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_video_metric_schedule_updated_at_insert" BEFORE INSERT ON "video_metric_schedule"
         FOR EACH ROW WHEN NEW."updated_at" IS NOT NULL AND NEW."updated_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'video_metric_schedule.updated_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_video_metric_schedule_updated_at_update" BEFORE UPDATE OF "updated_at" ON "video_metric_schedule"
         FOR EACH ROW WHEN NEW."updated_at" IS NOT NULL AND NEW."updated_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'video_metric_schedule.updated_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_video_metric_snapshots_sampled_at_insert" BEFORE INSERT ON "video_metric_snapshots"
         FOR EACH ROW WHEN NEW."sampled_at" IS NOT NULL AND NEW."sampled_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'video_metric_snapshots.sampled_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_video_metric_snapshots_sampled_at_update" BEFORE UPDATE OF "sampled_at" ON "video_metric_snapshots"
         FOR EACH ROW WHEN NEW."sampled_at" IS NOT NULL AND NEW."sampled_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'video_metric_snapshots.sampled_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_video_targets_scheduled_at_insert" BEFORE INSERT ON "video_targets"
         FOR EACH ROW WHEN NEW."scheduled_at" IS NOT NULL AND NEW."scheduled_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'video_targets.scheduled_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_video_targets_scheduled_at_update" BEFORE UPDATE OF "scheduled_at" ON "video_targets"
         FOR EACH ROW WHEN NEW."scheduled_at" IS NOT NULL AND NEW."scheduled_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'video_targets.scheduled_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_video_targets_prepared_at_insert" BEFORE INSERT ON "video_targets"
         FOR EACH ROW WHEN NEW."prepared_at" IS NOT NULL AND NEW."prepared_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'video_targets.prepared_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_video_targets_prepared_at_update" BEFORE UPDATE OF "prepared_at" ON "video_targets"
         FOR EACH ROW WHEN NEW."prepared_at" IS NOT NULL AND NEW."prepared_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'video_targets.prepared_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_video_targets_published_at_insert" BEFORE INSERT ON "video_targets"
         FOR EACH ROW WHEN NEW."published_at" IS NOT NULL AND NEW."published_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'video_targets.published_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_video_targets_published_at_update" BEFORE UPDATE OF "published_at" ON "video_targets"
         FOR EACH ROW WHEN NEW."published_at" IS NOT NULL AND NEW."published_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'video_targets.published_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_video_targets_verified_at_insert" BEFORE INSERT ON "video_targets"
         FOR EACH ROW WHEN NEW."verified_at" IS NOT NULL AND NEW."verified_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'video_targets.verified_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_video_targets_verified_at_update" BEFORE UPDATE OF "verified_at" ON "video_targets"
         FOR EACH ROW WHEN NEW."verified_at" IS NOT NULL AND NEW."verified_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'video_targets.verified_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_video_targets_created_at_insert" BEFORE INSERT ON "video_targets"
         FOR EACH ROW WHEN NEW."created_at" IS NOT NULL AND NEW."created_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'video_targets.created_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_video_targets_created_at_update" BEFORE UPDATE OF "created_at" ON "video_targets"
         FOR EACH ROW WHEN NEW."created_at" IS NOT NULL AND NEW."created_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'video_targets.created_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_video_targets_updated_at_insert" BEFORE INSERT ON "video_targets"
         FOR EACH ROW WHEN NEW."updated_at" IS NOT NULL AND NEW."updated_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'video_targets.updated_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_video_targets_updated_at_update" BEFORE UPDATE OF "updated_at" ON "video_targets"
         FOR EACH ROW WHEN NEW."updated_at" IS NOT NULL AND NEW."updated_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'video_targets.updated_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_drafts_scheduled_at_insert" BEFORE INSERT ON "drafts"
         FOR EACH ROW WHEN NEW."scheduled_at" IS NOT NULL AND NEW."scheduled_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'drafts.scheduled_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_drafts_scheduled_at_update" BEFORE UPDATE OF "scheduled_at" ON "drafts"
         FOR EACH ROW WHEN NEW."scheduled_at" IS NOT NULL AND NEW."scheduled_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'drafts.scheduled_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_drafts_scheduled_en_at_insert" BEFORE INSERT ON "drafts"
         FOR EACH ROW WHEN NEW."scheduled_en_at" IS NOT NULL AND NEW."scheduled_en_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'drafts.scheduled_en_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_drafts_scheduled_en_at_update" BEFORE UPDATE OF "scheduled_en_at" ON "drafts"
         FOR EACH ROW WHEN NEW."scheduled_en_at" IS NOT NULL AND NEW."scheduled_en_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'drafts.scheduled_en_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_drafts_created_at_insert" BEFORE INSERT ON "drafts"
         FOR EACH ROW WHEN NEW."created_at" IS NOT NULL AND NEW."created_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'drafts.created_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_drafts_created_at_update" BEFORE UPDATE OF "created_at" ON "drafts"
         FOR EACH ROW WHEN NEW."created_at" IS NOT NULL AND NEW."created_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'drafts.created_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_drafts_updated_at_insert" BEFORE INSERT ON "drafts"
         FOR EACH ROW WHEN NEW."updated_at" IS NOT NULL AND NEW."updated_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'drafts.updated_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_drafts_updated_at_update" BEFORE UPDATE OF "updated_at" ON "drafts"
         FOR EACH ROW WHEN NEW."updated_at" IS NOT NULL AND NEW."updated_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'drafts.updated_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_post_locales_publish_at_insert" BEFORE INSERT ON "post_locales"
         FOR EACH ROW WHEN NEW."publish_at" IS NOT NULL AND NEW."publish_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'post_locales.publish_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_post_locales_publish_at_update" BEFORE UPDATE OF "publish_at" ON "post_locales"
         FOR EACH ROW WHEN NEW."publish_at" IS NOT NULL AND NEW."publish_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'post_locales.publish_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_post_locales_published_at_insert" BEFORE INSERT ON "post_locales"
         FOR EACH ROW WHEN NEW."published_at" IS NOT NULL AND NEW."published_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'post_locales.published_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_post_locales_published_at_update" BEFORE UPDATE OF "published_at" ON "post_locales"
         FOR EACH ROW WHEN NEW."published_at" IS NOT NULL AND NEW."published_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'post_locales.published_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_post_locales_updated_at_insert" BEFORE INSERT ON "post_locales"
         FOR EACH ROW WHEN NEW."updated_at" IS NOT NULL AND NEW."updated_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'post_locales.updated_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_post_locales_updated_at_update" BEFORE UPDATE OF "updated_at" ON "post_locales"
         FOR EACH ROW WHEN NEW."updated_at" IS NOT NULL AND NEW."updated_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'post_locales.updated_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_post_locales_site_updated_at_insert" BEFORE INSERT ON "post_locales"
         FOR EACH ROW WHEN NEW."site_updated_at" IS NOT NULL AND NEW."site_updated_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'post_locales.site_updated_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_post_locales_site_updated_at_update" BEFORE UPDATE OF "site_updated_at" ON "post_locales"
         FOR EACH ROW WHEN NEW."site_updated_at" IS NOT NULL AND NEW."site_updated_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'post_locales.site_updated_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_metric_samples_sampled_at_insert" BEFORE INSERT ON "metric_samples"
         FOR EACH ROW WHEN NEW."sampled_at" IS NOT NULL AND NEW."sampled_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'metric_samples.sampled_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_metric_samples_sampled_at_update" BEFORE UPDATE OF "sampled_at" ON "metric_samples"
         FOR EACH ROW WHEN NEW."sampled_at" IS NOT NULL AND NEW."sampled_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'metric_samples.sampled_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_metric_schedule_next_check_at_insert" BEFORE INSERT ON "metric_schedule"
         FOR EACH ROW WHEN NEW."next_check_at" IS NOT NULL AND NEW."next_check_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'metric_schedule.next_check_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_metric_schedule_next_check_at_update" BEFORE UPDATE OF "next_check_at" ON "metric_schedule"
         FOR EACH ROW WHEN NEW."next_check_at" IS NOT NULL AND NEW."next_check_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'metric_schedule.next_check_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_metric_schedule_last_checked_at_insert" BEFORE INSERT ON "metric_schedule"
         FOR EACH ROW WHEN NEW."last_checked_at" IS NOT NULL AND NEW."last_checked_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'metric_schedule.last_checked_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_metric_schedule_last_checked_at_update" BEFORE UPDATE OF "last_checked_at" ON "metric_schedule"
         FOR EACH ROW WHEN NEW."last_checked_at" IS NOT NULL AND NEW."last_checked_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'metric_schedule.last_checked_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_metric_schedule_frozen_at_insert" BEFORE INSERT ON "metric_schedule"
         FOR EACH ROW WHEN NEW."frozen_at" IS NOT NULL AND NEW."frozen_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'metric_schedule.frozen_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_metric_schedule_frozen_at_update" BEFORE UPDATE OF "frozen_at" ON "metric_schedule"
         FOR EACH ROW WHEN NEW."frozen_at" IS NOT NULL AND NEW."frozen_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'metric_schedule.frozen_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_metric_schedule_locked_at_insert" BEFORE INSERT ON "metric_schedule"
         FOR EACH ROW WHEN NEW."locked_at" IS NOT NULL AND NEW."locked_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'metric_schedule.locked_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_metric_schedule_locked_at_update" BEFORE UPDATE OF "locked_at" ON "metric_schedule"
         FOR EACH ROW WHEN NEW."locked_at" IS NOT NULL AND NEW."locked_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'metric_schedule.locked_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_metric_schedule_updated_at_insert" BEFORE INSERT ON "metric_schedule"
         FOR EACH ROW WHEN NEW."updated_at" IS NOT NULL AND NEW."updated_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'metric_schedule.updated_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_metric_schedule_updated_at_update" BEFORE UPDATE OF "updated_at" ON "metric_schedule"
         FOR EACH ROW WHEN NEW."updated_at" IS NOT NULL AND NEW."updated_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'metric_schedule.updated_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_post_metrics_sampled_at_insert" BEFORE INSERT ON "post_metrics"
         FOR EACH ROW WHEN NEW."sampled_at" IS NOT NULL AND NEW."sampled_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'post_metrics.sampled_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_post_metrics_sampled_at_update" BEFORE UPDATE OF "sampled_at" ON "post_metrics"
         FOR EACH ROW WHEN NEW."sampled_at" IS NOT NULL AND NEW."sampled_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'post_metrics.sampled_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_publication_targets_published_at_insert" BEFORE INSERT ON "publication_targets"
         FOR EACH ROW WHEN NEW."published_at" IS NOT NULL AND NEW."published_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'publication_targets.published_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_publication_targets_published_at_update" BEFORE UPDATE OF "published_at" ON "publication_targets"
         FOR EACH ROW WHEN NEW."published_at" IS NOT NULL AND NEW."published_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'publication_targets.published_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_publication_targets_verified_at_insert" BEFORE INSERT ON "publication_targets"
         FOR EACH ROW WHEN NEW."verified_at" IS NOT NULL AND NEW."verified_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'publication_targets.verified_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_publication_targets_verified_at_update" BEFORE UPDATE OF "verified_at" ON "publication_targets"
         FOR EACH ROW WHEN NEW."verified_at" IS NOT NULL AND NEW."verified_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'publication_targets.verified_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_publication_targets_updated_at_insert" BEFORE INSERT ON "publication_targets"
         FOR EACH ROW WHEN NEW."updated_at" IS NOT NULL AND NEW."updated_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'publication_targets.updated_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_publication_targets_updated_at_update" BEFORE UPDATE OF "updated_at" ON "publication_targets"
         FOR EACH ROW WHEN NEW."updated_at" IS NOT NULL AND NEW."updated_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'publication_targets.updated_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_alert_dedup_last_sent_at_insert" BEFORE INSERT ON "alert_dedup"
         FOR EACH ROW WHEN NEW."last_sent_at" IS NOT NULL AND NEW."last_sent_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'alert_dedup.last_sent_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_alert_dedup_last_sent_at_update" BEFORE UPDATE OF "last_sent_at" ON "alert_dedup"
         FOR EACH ROW WHEN NEW."last_sent_at" IS NOT NULL AND NEW."last_sent_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'alert_dedup.last_sent_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_analytics_rollups_updated_at_insert" BEFORE INSERT ON "analytics_rollups"
         FOR EACH ROW WHEN NEW."updated_at" IS NOT NULL AND NEW."updated_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'analytics_rollups.updated_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_analytics_rollups_updated_at_update" BEFORE UPDATE OF "updated_at" ON "analytics_rollups"
         FOR EACH ROW WHEN NEW."updated_at" IS NOT NULL AND NEW."updated_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'analytics_rollups.updated_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_credential_checks_expires_at_insert" BEFORE INSERT ON "credential_checks"
         FOR EACH ROW WHEN NEW."expires_at" IS NOT NULL AND NEW."expires_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'credential_checks.expires_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_credential_checks_expires_at_update" BEFORE UPDATE OF "expires_at" ON "credential_checks"
         FOR EACH ROW WHEN NEW."expires_at" IS NOT NULL AND NEW."expires_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'credential_checks.expires_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_credential_checks_last_checked_at_insert" BEFORE INSERT ON "credential_checks"
         FOR EACH ROW WHEN NEW."last_checked_at" IS NOT NULL AND NEW."last_checked_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'credential_checks.last_checked_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_credential_checks_last_checked_at_update" BEFORE UPDATE OF "last_checked_at" ON "credential_checks"
         FOR EACH ROW WHEN NEW."last_checked_at" IS NOT NULL AND NEW."last_checked_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'credential_checks.last_checked_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_credential_checks_next_check_at_insert" BEFORE INSERT ON "credential_checks"
         FOR EACH ROW WHEN NEW."next_check_at" IS NOT NULL AND NEW."next_check_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'credential_checks.next_check_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_credential_checks_next_check_at_update" BEFORE UPDATE OF "next_check_at" ON "credential_checks"
         FOR EACH ROW WHEN NEW."next_check_at" IS NOT NULL AND NEW."next_check_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'credential_checks.next_check_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_maintenance_locks_expires_at_insert" BEFORE INSERT ON "maintenance_locks"
         FOR EACH ROW WHEN NEW."expires_at" IS NOT NULL AND NEW."expires_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'maintenance_locks.expires_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_maintenance_locks_expires_at_update" BEFORE UPDATE OF "expires_at" ON "maintenance_locks"
         FOR EACH ROW WHEN NEW."expires_at" IS NOT NULL AND NEW."expires_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'maintenance_locks.expires_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_maintenance_locks_created_at_insert" BEFORE INSERT ON "maintenance_locks"
         FOR EACH ROW WHEN NEW."created_at" IS NOT NULL AND NEW."created_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'maintenance_locks.created_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_maintenance_locks_created_at_update" BEFORE UPDATE OF "created_at" ON "maintenance_locks"
         FOR EACH ROW WHEN NEW."created_at" IS NOT NULL AND NEW."created_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'maintenance_locks.created_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_media_test_cases_created_at_insert" BEFORE INSERT ON "media_test_cases"
         FOR EACH ROW WHEN NEW."created_at" IS NOT NULL AND NEW."created_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'media_test_cases.created_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_media_test_cases_created_at_update" BEFORE UPDATE OF "created_at" ON "media_test_cases"
         FOR EACH ROW WHEN NEW."created_at" IS NOT NULL AND NEW."created_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'media_test_cases.created_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_media_test_cases_updated_at_insert" BEFORE INSERT ON "media_test_cases"
         FOR EACH ROW WHEN NEW."updated_at" IS NOT NULL AND NEW."updated_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'media_test_cases.updated_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_media_test_cases_updated_at_update" BEFORE UPDATE OF "updated_at" ON "media_test_cases"
         FOR EACH ROW WHEN NEW."updated_at" IS NOT NULL AND NEW."updated_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'media_test_cases.updated_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_worker_state_updated_at_insert" BEFORE INSERT ON "worker_state"
         FOR EACH ROW WHEN NEW."updated_at" IS NOT NULL AND NEW."updated_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'worker_state.updated_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_worker_state_updated_at_update" BEFORE UPDATE OF "updated_at" ON "worker_state"
         FOR EACH ROW WHEN NEW."updated_at" IS NOT NULL AND NEW."updated_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'worker_state.updated_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_publication_events_created_at_insert" BEFORE INSERT ON "publication_events"
         FOR EACH ROW WHEN NEW."created_at" IS NOT NULL AND NEW."created_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'publication_events.created_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_publication_events_created_at_update" BEFORE UPDATE OF "created_at" ON "publication_events"
         FOR EACH ROW WHEN NEW."created_at" IS NOT NULL AND NEW."created_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'publication_events.created_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_publication_events_acked_at_insert" BEFORE INSERT ON "publication_events"
         FOR EACH ROW WHEN NEW."acked_at" IS NOT NULL AND NEW."acked_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'publication_events.acked_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_publication_events_acked_at_update" BEFORE UPDATE OF "acked_at" ON "publication_events"
         FOR EACH ROW WHEN NEW."acked_at" IS NOT NULL AND NEW."acked_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'publication_events.acked_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_publish_jobs_publish_at_insert" BEFORE INSERT ON "publish_jobs"
         FOR EACH ROW WHEN NEW."publish_at" IS NOT NULL AND NEW."publish_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'publish_jobs.publish_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_publish_jobs_publish_at_update" BEFORE UPDATE OF "publish_at" ON "publish_jobs"
         FOR EACH ROW WHEN NEW."publish_at" IS NOT NULL AND NEW."publish_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'publish_jobs.publish_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_publish_jobs_next_attempt_at_insert" BEFORE INSERT ON "publish_jobs"
         FOR EACH ROW WHEN NEW."next_attempt_at" IS NOT NULL AND NEW."next_attempt_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'publish_jobs.next_attempt_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_publish_jobs_next_attempt_at_update" BEFORE UPDATE OF "next_attempt_at" ON "publish_jobs"
         FOR EACH ROW WHEN NEW."next_attempt_at" IS NOT NULL AND NEW."next_attempt_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'publish_jobs.next_attempt_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_publish_jobs_locked_at_insert" BEFORE INSERT ON "publish_jobs"
         FOR EACH ROW WHEN NEW."locked_at" IS NOT NULL AND NEW."locked_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'publish_jobs.locked_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_publish_jobs_locked_at_update" BEFORE UPDATE OF "locked_at" ON "publish_jobs"
         FOR EACH ROW WHEN NEW."locked_at" IS NOT NULL AND NEW."locked_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'publish_jobs.locked_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_publish_jobs_created_at_insert" BEFORE INSERT ON "publish_jobs"
         FOR EACH ROW WHEN NEW."created_at" IS NOT NULL AND NEW."created_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'publish_jobs.created_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_publish_jobs_created_at_update" BEFORE UPDATE OF "created_at" ON "publish_jobs"
         FOR EACH ROW WHEN NEW."created_at" IS NOT NULL AND NEW."created_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'publish_jobs.created_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_publish_jobs_updated_at_insert" BEFORE INSERT ON "publish_jobs"
         FOR EACH ROW WHEN NEW."updated_at" IS NOT NULL AND NEW."updated_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'publish_jobs.updated_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_publish_jobs_updated_at_update" BEFORE UPDATE OF "updated_at" ON "publish_jobs"
         FOR EACH ROW WHEN NEW."updated_at" IS NOT NULL AND NEW."updated_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'publish_jobs.updated_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_draft_entity_links_created_at_insert" BEFORE INSERT ON "draft_entity_links"
         FOR EACH ROW WHEN NEW."created_at" IS NOT NULL AND NEW."created_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'draft_entity_links.created_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_draft_entity_links_created_at_update" BEFORE UPDATE OF "created_at" ON "draft_entity_links"
         FOR EACH ROW WHEN NEW."created_at" IS NOT NULL AND NEW."created_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'draft_entity_links.created_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_site_jobs_next_attempt_at_insert" BEFORE INSERT ON "site_jobs"
         FOR EACH ROW WHEN NEW."next_attempt_at" IS NOT NULL AND NEW."next_attempt_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'site_jobs.next_attempt_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_site_jobs_next_attempt_at_update" BEFORE UPDATE OF "next_attempt_at" ON "site_jobs"
         FOR EACH ROW WHEN NEW."next_attempt_at" IS NOT NULL AND NEW."next_attempt_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'site_jobs.next_attempt_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_site_jobs_locked_at_insert" BEFORE INSERT ON "site_jobs"
         FOR EACH ROW WHEN NEW."locked_at" IS NOT NULL AND NEW."locked_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'site_jobs.locked_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_site_jobs_locked_at_update" BEFORE UPDATE OF "locked_at" ON "site_jobs"
         FOR EACH ROW WHEN NEW."locked_at" IS NOT NULL AND NEW."locked_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'site_jobs.locked_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_site_jobs_created_at_insert" BEFORE INSERT ON "site_jobs"
         FOR EACH ROW WHEN NEW."created_at" IS NOT NULL AND NEW."created_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'site_jobs.created_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_site_jobs_created_at_update" BEFORE UPDATE OF "created_at" ON "site_jobs"
         FOR EACH ROW WHEN NEW."created_at" IS NOT NULL AND NEW."created_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'site_jobs.created_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_site_jobs_updated_at_insert" BEFORE INSERT ON "site_jobs"
         FOR EACH ROW WHEN NEW."updated_at" IS NOT NULL AND NEW."updated_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'site_jobs.updated_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_site_jobs_updated_at_update" BEFORE UPDATE OF "updated_at" ON "site_jobs"
         FOR EACH ROW WHEN NEW."updated_at" IS NOT NULL AND NEW."updated_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'site_jobs.updated_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_studio_youtube_settings_updated_at_insert" BEFORE INSERT ON "studio_youtube_settings"
         FOR EACH ROW WHEN NEW."updated_at" IS NOT NULL AND NEW."updated_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'studio_youtube_settings.updated_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_studio_youtube_settings_updated_at_update" BEFORE UPDATE OF "updated_at" ON "studio_youtube_settings"
         FOR EACH ROW WHEN NEW."updated_at" IS NOT NULL AND NEW."updated_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'studio_youtube_settings.updated_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_studio_milestone_settings_updated_at_insert" BEFORE INSERT ON "studio_milestone_settings"
         FOR EACH ROW WHEN NEW."updated_at" IS NOT NULL AND NEW."updated_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'studio_milestone_settings.updated_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_studio_milestone_settings_updated_at_update" BEFORE UPDATE OF "updated_at" ON "studio_milestone_settings"
         FOR EACH ROW WHEN NEW."updated_at" IS NOT NULL AND NEW."updated_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'studio_milestone_settings.updated_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_studio_news_digest_settings_updated_at_insert" BEFORE INSERT ON "studio_news_digest_settings"
         FOR EACH ROW WHEN NEW."updated_at" IS NOT NULL AND NEW."updated_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'studio_news_digest_settings.updated_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_studio_news_digest_settings_updated_at_update" BEFORE UPDATE OF "updated_at" ON "studio_news_digest_settings"
         FOR EACH ROW WHEN NEW."updated_at" IS NOT NULL AND NEW."updated_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'studio_news_digest_settings.updated_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_telegram_discussion_threads_seen_at_insert" BEFORE INSERT ON "telegram_discussion_threads"
         FOR EACH ROW WHEN NEW."seen_at" IS NOT NULL AND NEW."seen_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'telegram_discussion_threads.seen_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_telegram_discussion_threads_seen_at_update" BEFORE UPDATE OF "seen_at" ON "telegram_discussion_threads"
         FOR EACH ROW WHEN NEW."seen_at" IS NOT NULL AND NEW."seen_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'telegram_discussion_threads.seen_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_draft_translations_next_attempt_at_insert" BEFORE INSERT ON "draft_translations"
         FOR EACH ROW WHEN NEW."next_attempt_at" IS NOT NULL AND NEW."next_attempt_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'draft_translations.next_attempt_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_draft_translations_next_attempt_at_update" BEFORE UPDATE OF "next_attempt_at" ON "draft_translations"
         FOR EACH ROW WHEN NEW."next_attempt_at" IS NOT NULL AND NEW."next_attempt_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'draft_translations.next_attempt_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_draft_translations_locked_at_insert" BEFORE INSERT ON "draft_translations"
         FOR EACH ROW WHEN NEW."locked_at" IS NOT NULL AND NEW."locked_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'draft_translations.locked_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_draft_translations_locked_at_update" BEFORE UPDATE OF "locked_at" ON "draft_translations"
         FOR EACH ROW WHEN NEW."locked_at" IS NOT NULL AND NEW."locked_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'draft_translations.locked_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_draft_translations_created_at_insert" BEFORE INSERT ON "draft_translations"
         FOR EACH ROW WHEN NEW."created_at" IS NOT NULL AND NEW."created_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'draft_translations.created_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_draft_translations_created_at_update" BEFORE UPDATE OF "created_at" ON "draft_translations"
         FOR EACH ROW WHEN NEW."created_at" IS NOT NULL AND NEW."created_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'draft_translations.created_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_draft_translations_updated_at_insert" BEFORE INSERT ON "draft_translations"
         FOR EACH ROW WHEN NEW."updated_at" IS NOT NULL AND NEW."updated_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'draft_translations.updated_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_draft_translations_updated_at_update" BEFORE UPDATE OF "updated_at" ON "draft_translations"
         FOR EACH ROW WHEN NEW."updated_at" IS NOT NULL AND NEW."updated_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'draft_translations.updated_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_audience_activity_period_start_insert" BEFORE INSERT ON "audience_activity"
         FOR EACH ROW WHEN NEW."period_start" IS NOT NULL AND NEW."period_start" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND NEW."period_start" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]'
         BEGIN SELECT RAISE(ABORT, 'audience_activity.period_start must be a calendar day such as 2026-08-27, or an hour bucket such as 2026-08-27T15'); END;
CREATE TRIGGER "date_guard_audience_activity_period_start_update" BEFORE UPDATE OF "period_start" ON "audience_activity"
         FOR EACH ROW WHEN NEW."period_start" IS NOT NULL AND NEW."period_start" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND NEW."period_start" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]'
         BEGIN SELECT RAISE(ABORT, 'audience_activity.period_start must be a calendar day such as 2026-08-27, or an hour bucket such as 2026-08-27T15'); END;
CREATE TRIGGER "date_guard_audience_activity_period_end_insert" BEFORE INSERT ON "audience_activity"
         FOR EACH ROW WHEN NEW."period_end" IS NOT NULL AND NEW."period_end" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND NEW."period_end" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]'
         BEGIN SELECT RAISE(ABORT, 'audience_activity.period_end must be a calendar day such as 2026-08-27, or an hour bucket such as 2026-08-27T15'); END;
CREATE TRIGGER "date_guard_audience_activity_period_end_update" BEFORE UPDATE OF "period_end" ON "audience_activity"
         FOR EACH ROW WHEN NEW."period_end" IS NOT NULL AND NEW."period_end" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND NEW."period_end" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]'
         BEGIN SELECT RAISE(ABORT, 'audience_activity.period_end must be a calendar day such as 2026-08-27, or an hour bucket such as 2026-08-27T15'); END;
CREATE TRIGGER "date_guard_audience_activity_captured_at_insert" BEFORE INSERT ON "audience_activity"
         FOR EACH ROW WHEN NEW."captured_at" IS NOT NULL AND NEW."captured_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'audience_activity.captured_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_audience_activity_captured_at_update" BEFORE UPDATE OF "captured_at" ON "audience_activity"
         FOR EACH ROW WHEN NEW."captured_at" IS NOT NULL AND NEW."captured_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'audience_activity.captured_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_audience_demographics_captured_on_insert" BEFORE INSERT ON "audience_demographics"
         FOR EACH ROW WHEN NEW."captured_on" IS NOT NULL AND NEW."captured_on" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND NEW."captured_on" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]'
         BEGIN SELECT RAISE(ABORT, 'audience_demographics.captured_on must be a calendar day such as 2026-08-27, or an hour bucket such as 2026-08-27T15'); END;
CREATE TRIGGER "date_guard_audience_demographics_captured_on_update" BEFORE UPDATE OF "captured_on" ON "audience_demographics"
         FOR EACH ROW WHEN NEW."captured_on" IS NOT NULL AND NEW."captured_on" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND NEW."captured_on" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]'
         BEGIN SELECT RAISE(ABORT, 'audience_demographics.captured_on must be a calendar day such as 2026-08-27, or an hour bucket such as 2026-08-27T15'); END;
CREATE TRIGGER "date_guard_audience_demographics_captured_at_insert" BEFORE INSERT ON "audience_demographics"
         FOR EACH ROW WHEN NEW."captured_at" IS NOT NULL AND NEW."captured_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'audience_demographics.captured_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_audience_demographics_captured_at_update" BEFORE UPDATE OF "captured_at" ON "audience_demographics"
         FOR EACH ROW WHEN NEW."captured_at" IS NOT NULL AND NEW."captured_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'audience_demographics.captured_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_games_captured_at_insert" BEFORE INSERT ON "games"
         FOR EACH ROW WHEN NEW."captured_at" IS NOT NULL AND NEW."captured_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'games.captured_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_games_captured_at_update" BEFORE UPDATE OF "captured_at" ON "games"
         FOR EACH ROW WHEN NEW."captured_at" IS NOT NULL AND NEW."captured_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'games.captured_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_video_frame_features_captured_at_insert" BEFORE INSERT ON "video_frame_features"
         FOR EACH ROW WHEN NEW."captured_at" IS NOT NULL AND NEW."captured_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'video_frame_features.captured_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_video_frame_features_captured_at_update" BEFORE UPDATE OF "captured_at" ON "video_frame_features"
         FOR EACH ROW WHEN NEW."captured_at" IS NOT NULL AND NEW."captured_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'video_frame_features.captured_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_video_drafts_scheduled_at_insert" BEFORE INSERT ON "video_drafts"
         FOR EACH ROW WHEN NEW."scheduled_at" IS NOT NULL AND NEW."scheduled_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'video_drafts.scheduled_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_video_drafts_scheduled_at_update" BEFORE UPDATE OF "scheduled_at" ON "video_drafts"
         FOR EACH ROW WHEN NEW."scheduled_at" IS NOT NULL AND NEW."scheduled_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'video_drafts.scheduled_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_video_drafts_source_pruned_at_insert" BEFORE INSERT ON "video_drafts"
         FOR EACH ROW WHEN NEW."source_pruned_at" IS NOT NULL AND NEW."source_pruned_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'video_drafts.source_pruned_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_video_drafts_source_pruned_at_update" BEFORE UPDATE OF "source_pruned_at" ON "video_drafts"
         FOR EACH ROW WHEN NEW."source_pruned_at" IS NOT NULL AND NEW."source_pruned_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'video_drafts.source_pruned_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_video_drafts_created_at_insert" BEFORE INSERT ON "video_drafts"
         FOR EACH ROW WHEN NEW."created_at" IS NOT NULL AND NEW."created_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'video_drafts.created_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_video_drafts_created_at_update" BEFORE UPDATE OF "created_at" ON "video_drafts"
         FOR EACH ROW WHEN NEW."created_at" IS NOT NULL AND NEW."created_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'video_drafts.created_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_video_drafts_updated_at_insert" BEFORE INSERT ON "video_drafts"
         FOR EACH ROW WHEN NEW."updated_at" IS NOT NULL AND NEW."updated_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'video_drafts.updated_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_video_drafts_updated_at_update" BEFORE UPDATE OF "updated_at" ON "video_drafts"
         FOR EACH ROW WHEN NEW."updated_at" IS NOT NULL AND NEW."updated_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'video_drafts.updated_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_post_comments_sent_at_insert" BEFORE INSERT ON "post_comments"
         FOR EACH ROW WHEN NEW."sent_at" IS NOT NULL AND NEW."sent_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'post_comments.sent_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_post_comments_sent_at_update" BEFORE UPDATE OF "sent_at" ON "post_comments"
         FOR EACH ROW WHEN NEW."sent_at" IS NOT NULL AND NEW."sent_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'post_comments.sent_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_post_comments_edited_at_insert" BEFORE INSERT ON "post_comments"
         FOR EACH ROW WHEN NEW."edited_at" IS NOT NULL AND NEW."edited_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'post_comments.edited_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_post_comments_edited_at_update" BEFORE UPDATE OF "edited_at" ON "post_comments"
         FOR EACH ROW WHEN NEW."edited_at" IS NOT NULL AND NEW."edited_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'post_comments.edited_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_post_comments_fetched_at_insert" BEFORE INSERT ON "post_comments"
         FOR EACH ROW WHEN NEW."fetched_at" IS NOT NULL AND NEW."fetched_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'post_comments.fetched_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_post_comments_fetched_at_update" BEFORE UPDATE OF "fetched_at" ON "post_comments"
         FOR EACH ROW WHEN NEW."fetched_at" IS NOT NULL AND NEW."fetched_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'post_comments.fetched_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_draft_thread_parts_created_at_insert" BEFORE INSERT ON "draft_thread_parts"
         FOR EACH ROW WHEN NEW."created_at" IS NOT NULL AND NEW."created_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'draft_thread_parts.created_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_draft_thread_parts_created_at_update" BEFORE UPDATE OF "created_at" ON "draft_thread_parts"
         FOR EACH ROW WHEN NEW."created_at" IS NOT NULL AND NEW."created_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'draft_thread_parts.created_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_draft_thread_parts_updated_at_insert" BEFORE INSERT ON "draft_thread_parts"
         FOR EACH ROW WHEN NEW."updated_at" IS NOT NULL AND NEW."updated_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'draft_thread_parts.updated_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_draft_thread_parts_updated_at_update" BEFORE UPDATE OF "updated_at" ON "draft_thread_parts"
         FOR EACH ROW WHEN NEW."updated_at" IS NOT NULL AND NEW."updated_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'draft_thread_parts.updated_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_publication_cancellations_requested_at_insert" BEFORE INSERT ON "publication_cancellations"
         FOR EACH ROW WHEN NEW."requested_at" IS NOT NULL AND NEW."requested_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'publication_cancellations.requested_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
CREATE TRIGGER "date_guard_publication_cancellations_requested_at_update" BEFORE UPDATE OF "requested_at" ON "publication_cancellations"
         FOR EACH ROW WHEN NEW."requested_at" IS NOT NULL AND NEW."requested_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
         BEGIN SELECT RAISE(ABORT, 'publication_cancellations.requested_at must be an ISO instant such as 2026-08-27T14:01:34Z'); END;
INSERT INTO "__drizzle_migrations" ("id", "hash", "created_at") VALUES (NULL, '2474654f04fc4ea84a9bfc51095ffad581fbee3dd22dcaefa3ee06072aa52c23', 1783727704995);
INSERT INTO "__drizzle_migrations" ("id", "hash", "created_at") VALUES (NULL, '3dabde8784dc6a57c429afb7280d12f62bc5def508cd995657355fb0936db8bd', 1787300000000);
INSERT INTO "__drizzle_migrations" ("id", "hash", "created_at") VALUES (NULL, '9f623095ca44829e5abad60f49f2c473704e8ab62b0c722648d1584b52259c52', 1787400000000);
INSERT INTO "__drizzle_migrations" ("id", "hash", "created_at") VALUES (NULL, 'ab159206f43ec456b82167523fdcbcda9df50d9be5fc8e4cfb7b5d95a297aea5', 1787500000000);
INSERT INTO "__drizzle_migrations" ("id", "hash", "created_at") VALUES (NULL, 'e7665f0602d3f5dde126aa3457084036c835857022c89258ccf516e975500163', 1787600000000);
INSERT INTO "__drizzle_migrations" ("id", "hash", "created_at") VALUES (NULL, '7d8eb97ee7593127e451bba37fdd35771c890660b6d6387dc49edefb211601d4', 1787700000000);
INSERT INTO "__drizzle_migrations" ("id", "hash", "created_at") VALUES (NULL, '237693fa9c6e4f6320abe1d26b715f074b05dea0cd798d8ac0149af21d514af2', 1787800000000);
INSERT INTO "__drizzle_migrations" ("id", "hash", "created_at") VALUES (NULL, '965cacb14524704b5cdd97fbb4d3acd7208f02ff84696a2a0c5ddf067cd4715f', 1788050000000);
INSERT INTO "__drizzle_migrations" ("id", "hash", "created_at") VALUES (NULL, '2e2b83e236d5737eb665457c2c36d5230a080c4f81f6122f0479b39609ab237a', 1788150000000);
INSERT INTO "__drizzle_migrations" ("id", "hash", "created_at") VALUES (NULL, '3703fb1ef72b3c0abda22da908a68454c49e273aefb944438025f9ddb18fd0cb', 1788200000000);
INSERT INTO "__drizzle_migrations" ("id", "hash", "created_at") VALUES (NULL, '17bee1c6d711fbd478e1f1122372a5f87ad472356ceba8764fa39b6f2d80ef8a', 1788500000000);
INSERT INTO "__drizzle_migrations" ("id", "hash", "created_at") VALUES (NULL, '4df45eb6c2a31bac8b7a0ae808ef670b112d7f62e143decabc5e1b12c452132e', 1788600000000);
INSERT INTO "__drizzle_migrations" ("id", "hash", "created_at") VALUES (NULL, '50551170e81b3d7ed7b14b791e2fcb2ceb0c1fa36ee3a7b62ee5365ad0b0b876', 1788700000000);
INSERT INTO "__drizzle_migrations" ("id", "hash", "created_at") VALUES (NULL, '742f4c3b1d56566808fb26baa18adccef3438f3860c0d69ba241a489862d03b4', 1788800000000);
INSERT INTO "__drizzle_migrations" ("id", "hash", "created_at") VALUES (NULL, 'd6922ac600f7fde8841a7202a675688212aa9cdef447ee606efd9bfa2837779c', 1788900000000);
INSERT INTO "__drizzle_migrations" ("id", "hash", "created_at") VALUES (NULL, 'c687d01ba38d683d38b1bc653b369ca56154378205dd87e094dd6aa2a668ec1f', 1789000000000);
INSERT INTO "__drizzle_migrations" ("id", "hash", "created_at") VALUES (NULL, '778d505aecf77b1932c667c65d488720ffa32b0cfa5b447b9646825f543f48b8', 1789100000000);
INSERT INTO "__drizzle_migrations" ("id", "hash", "created_at") VALUES (NULL, 'eb601e2c15799cf62406c0d3dcbfd10dd31535e669513072582c40d84adf285e', 1789300000000);
INSERT INTO "__drizzle_migrations" ("id", "hash", "created_at") VALUES (NULL, 'cfbc1b6bdef294e7fb53476fe78ca8a9e0711fe00ec8ff1ba45c7f6677011080', 1789400000000);
INSERT INTO "__drizzle_migrations" ("id", "hash", "created_at") VALUES (NULL, '4a6edf268cf331fe902fca8372ed4440c4da78b39739f72c84749f67679af87b', 1789500000000);
INSERT INTO "__drizzle_migrations" ("id", "hash", "created_at") VALUES (NULL, 'a10c5a35214a5e11baa64225d89ea189bdd160393718d36286fa8ab8a629f583', 1789600000000);
INSERT INTO "__drizzle_migrations" ("id", "hash", "created_at") VALUES (NULL, '89240067134cb1566ec97ec7f1d99ac15c4558ac6e0a4397495b0e9b272588b9', 1789700000000);
INSERT INTO "__drizzle_migrations" ("id", "hash", "created_at") VALUES (NULL, 'a3f4c1b21fafb7d391525779d8df97b8b04ee7e77365faf9f0551a215af4856c', 1789800000000);
INSERT INTO "__drizzle_migrations" ("id", "hash", "created_at") VALUES (NULL, '82d4059d0507bf7de761a3a389e297e62adb04171c19712813b27d2287d5b46a', 1789900000000);
INSERT INTO "__drizzle_migrations" ("id", "hash", "created_at") VALUES (NULL, '2f5b7fa2221ff0c3286846bb9a0c347f12d861faeefbd30866793a4071afb3ac', 1790000000000);
INSERT INTO "__drizzle_migrations" ("id", "hash", "created_at") VALUES (NULL, 'b108b04046eb749f8e3a1a41e2cd3ae0e5409a27483597bd466a8f0d05c2b916', 1790100000000);
INSERT INTO "__drizzle_migrations" ("id", "hash", "created_at") VALUES (NULL, 'e5031e998971c99b78a052ea6bc90cd359ba23567d8cc2a0471901aab0742d60', 1790200000000);
INSERT INTO "__drizzle_migrations" ("id", "hash", "created_at") VALUES (NULL, '694bbbe3683d208dc1e24b35c1e88089afdb7fe56d9f83ca55a744c659cd4e7c', 1790300000000);
INSERT INTO "__drizzle_migrations" ("id", "hash", "created_at") VALUES (NULL, 'a1b1a98257e7ce5cd697c15b575b915cb7a162a8f221c518a13e344283409f41', 1790300060000);
INSERT INTO "__drizzle_migrations" ("id", "hash", "created_at") VALUES (NULL, 'd3bc7c3cfc66f5242f9c488c76f2d85cf982d3c191fec4edeb2a95b371a09189', 1790300120000);
INSERT INTO "__drizzle_migrations" ("id", "hash", "created_at") VALUES (NULL, 'c0b73b9db440ff21ed8c23e6062ca26d3cc5b8f969db35142ad16530fc44fe12', 1790300180000);
INSERT INTO "__drizzle_migrations" ("id", "hash", "created_at") VALUES (NULL, 'dece272ec8b01f3c370acf100b872a79a063c85b7935bd060335317496a88aa6', 1790693645697);
INSERT INTO "__drizzle_migrations" ("id", "hash", "created_at") VALUES (NULL, 'c040cb933abfb02f46f1bcb0e3ba98da737a41baca1959827b455f51a943a3f2', 1790693700000);
INSERT INTO "__drizzle_migrations" ("id", "hash", "created_at") VALUES (NULL, '854e6cdd88b02b569575768903bec0edea57f124b26dea1907c51003e4799292', 1793030038703);
INSERT INTO "__drizzle_migrations" ("id", "hash", "created_at") VALUES (NULL, '8492b653be1cbccf7c04bb0a6c20153ba41713ee2c72cb7bb717975b317c84df', 1793476800000);
INSERT INTO "__drizzle_migrations" ("id", "hash", "created_at") VALUES (NULL, '16c78209293b6a2d9c7a980a267c1bee12ecb059affc6f15285f551083163717', 1793484000000);
INSERT INTO "__drizzle_migrations" ("id", "hash", "created_at") VALUES (NULL, '311d9a3af65ee0086ec2df97d4d39d9dff38121b7cf70c8dcbc5dc7e56b684af', 1793538000000);
DELETE FROM sqlite_sequence;
INSERT INTO sqlite_sequence (name, seq) VALUES ('knowledge_entities', 12);
INSERT INTO sqlite_sequence (name, seq) VALUES ('drafts', 0);
INSERT INTO sqlite_sequence (name, seq) VALUES ('metric_samples', 0);
INSERT INTO sqlite_sequence (name, seq) VALUES ('publication_events', 0);
INSERT INTO sqlite_sequence (name, seq) VALUES ('publish_jobs', 0);
INSERT INTO sqlite_sequence (name, seq) VALUES ('site_jobs', 0);
INSERT INTO sqlite_sequence (name, seq) VALUES ('video_drafts', 0);
