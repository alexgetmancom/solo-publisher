CREATE TABLE `analytics_rollups` (
	`rollup_key` text PRIMARY KEY NOT NULL,
	`scope` text NOT NULL,
	`subject` text NOT NULL,
	`metric_json` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `analytics_sync` (
	`source` text PRIMARY KEY NOT NULL,
	`last_synced_at` text NOT NULL,
	`last_success_at` text,
	`last_error` text,
	`locked_by` text,
	`locked_at` text
);
--> statement-breakpoint
CREATE TABLE `creator_profile_snapshots` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`platform` text NOT NULL,
	`account` text NOT NULL,
	`sampled_on` text NOT NULL,
	`metrics_json` text NOT NULL,
	`source` text NOT NULL,
	`sampled_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_creator_profile_snapshots_daily` ON `creator_profile_snapshots` (`platform`,`account`,`sampled_on`);--> statement-breakpoint
CREATE INDEX `idx_creator_profile_snapshots_history` ON `creator_profile_snapshots` (`platform`,`account`,`sampled_at`);--> statement-breakpoint
CREATE INDEX `idx_creator_profile_snapshots_sampled_at` ON `creator_profile_snapshots` (`sampled_at`);--> statement-breakpoint
CREATE TABLE `creator_profiles` (
	`platform` text PRIMARY KEY NOT NULL,
	`data_json` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_creator_profiles_updated_at` ON `creator_profiles` (`updated_at`);--> statement-breakpoint
CREATE TABLE `metric_samples` (
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
CREATE INDEX `idx_metric_samples_lookup` ON `metric_samples` (`publication_key`,`target`,`metric_name`,`sampled_at`);--> statement-breakpoint
CREATE INDEX `idx_metric_samples_sampled_at` ON `metric_samples` (`sampled_at`);--> statement-breakpoint
CREATE TABLE `metric_schedule` (
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
CREATE INDEX `idx_metric_schedule_lock` ON `metric_schedule` (`locked_by`,`locked_at`);--> statement-breakpoint
CREATE INDEX `idx_metric_schedule_error_updated_at` ON `metric_schedule` (`updated_at`) WHERE "metric_schedule"."last_error" IS NOT NULL AND "metric_schedule"."last_error" <> '';--> statement-breakpoint
CREATE TABLE `post_metrics` (
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
CREATE INDEX `idx_post_metrics_sampled_at` ON `post_metrics` (`sampled_at`);--> statement-breakpoint
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
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_x_activity_imports_checksum` ON `x_activity_imports` (`checksum`);--> statement-breakpoint
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
);
--> statement-breakpoint
CREATE INDEX `idx_x_activity_items_published` ON `x_activity_items` (`published_at`);--> statement-breakpoint
CREATE INDEX `idx_x_activity_items_linked_post` ON `x_activity_items` (`linked_publication_key`);--> statement-breakpoint
CREATE INDEX `idx_x_activity_items_last_seen_at` ON `x_activity_items` (`last_seen_at`);--> statement-breakpoint
CREATE TABLE `x_activity_metric_snapshots` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`x_post_id` text NOT NULL,
	`metric_name` text NOT NULL,
	`value` integer NOT NULL,
	`sampled_at` text NOT NULL,
	`import_id` integer,
	`raw_json` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_x_activity_metric_snapshot` ON `x_activity_metric_snapshots` (`x_post_id`,`metric_name`,`sampled_at`);--> statement-breakpoint
CREATE INDEX `idx_x_activity_metric_history` ON `x_activity_metric_snapshots` (`x_post_id`,`sampled_at`);--> statement-breakpoint
CREATE INDEX `idx_x_activity_metric_sampled_at` ON `x_activity_metric_snapshots` (`sampled_at`);--> statement-breakpoint
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
--> statement-breakpoint
CREATE TABLE `articles` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`actor_id` integer NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_articles_status` ON `articles` (`status`,`updated_at`);--> statement-breakpoint
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
--> statement-breakpoint
CREATE INDEX `idx_conversation_sessions_expiry` ON `conversation_sessions` (`active`,`expires_at`);--> statement-breakpoint
CREATE TABLE `post_locales` (
	`post_id` integer NOT NULL,
	`locale` text NOT NULL,
	`slug` text NOT NULL,
	`text` text,
	`html` text,
	`entities_json` text,
	`media_json` text,
	`site_enabled` integer DEFAULT 0 NOT NULL,
	`published_at` text,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`post_id`, `locale`)
);
--> statement-breakpoint
CREATE TABLE `posts` (
	`publication_key` text PRIMARY KEY NOT NULL,
	`post_id` integer,
	`source` text DEFAULT 'studio' NOT NULL,
	`channel` text NOT NULL,
	`chat_id` text,
	`message_id` integer NOT NULL,
	`date_utc` text,
	`date_msk` text,
	`text` text,
	`text_en` text,
	`html` text,
	`html_en` text,
	`media_json` text,
	`media_count` integer DEFAULT 0 NOT NULL,
	`site_ru_path` text,
	`site_en_path` text,
	`telegram_url` text,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_posts_updated_at` ON `posts` (`updated_at`);--> statement-breakpoint
CREATE TABLE `publication_targets` (
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
CREATE INDEX `idx_publication_targets_updated_at` ON `publication_targets` (`updated_at`);--> statement-breakpoint
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
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_draft_entity_candidates_unique` ON `draft_entity_candidates` (`draft_id`,`kind`,`slug`);--> statement-breakpoint
CREATE INDEX `idx_draft_entity_candidates_draft_status` ON `draft_entity_candidates` (`draft_id`,`status`);--> statement-breakpoint
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
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_knowledge_entities_kind_slug` ON `knowledge_entities` (`kind`,`slug`);--> statement-breakpoint
CREATE INDEX `idx_knowledge_entities_kind` ON `knowledge_entities` (`kind`);--> statement-breakpoint
CREATE INDEX `idx_knowledge_entities_parent` ON `knowledge_entities` (`parent_entity_id`);--> statement-breakpoint
CREATE TABLE `knowledge_entity_aliases` (
	`entity_id` integer NOT NULL,
	`alias` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`entity_id`, `alias`)
);
--> statement-breakpoint
CREATE TABLE `post_entity_links` (
	`post_id` integer NOT NULL,
	`entity_id` integer NOT NULL,
	`link_role` text DEFAULT 'mention' NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`post_id`, `entity_id`)
);
--> statement-breakpoint
CREATE INDEX `idx_post_entity_links_entity` ON `post_entity_links` (`entity_id`,`post_id`);--> statement-breakpoint
CREATE TABLE `alert_dedup` (
	`alert_key` text PRIMARY KEY NOT NULL,
	`last_sent_at` text NOT NULL,
	`suppressed_count` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `credential_checks` (
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
CREATE INDEX `idx_credential_checks_last_checked_at` ON `credential_checks` (`last_checked_at`);--> statement-breakpoint
CREATE TABLE `device_authorizations` (
	`target` text PRIMARY KEY NOT NULL,
	`sealed_device_code` text NOT NULL,
	`user_code` text NOT NULL,
	`verification_url` text NOT NULL,
	`interval_seconds` integer NOT NULL,
	`expires_at` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
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
--> statement-breakpoint
CREATE TABLE `maintenance_locks` (
	`name` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`expires_at` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `media_test_cases` (
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
CREATE TABLE `ops_actions` (
	`action_id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`actor_type` text NOT NULL,
	`action` text NOT NULL,
	`message_id` integer,
	`target` text,
	`status` text NOT NULL,
	`details_json` text,
	`created_at` text NOT NULL,
	`completed_at` text
);
--> statement-breakpoint
CREATE INDEX `idx_ops_actions_created_at` ON `ops_actions` (`created_at`);--> statement-breakpoint
CREATE TABLE `platform_tokens` (
	`target` text PRIMARY KEY NOT NULL,
	`sealed_token` text NOT NULL,
	`seed_fingerprint` text,
	`account_id` text,
	`sealed_refresh_token` text,
	`expires_at` text,
	`refreshed_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `publication_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`publication_key` text,
	`event_type` text DEFAULT 'ops.event' NOT NULL,
	`severity` text DEFAULT 'info' NOT NULL,
	`target` text,
	`message` text NOT NULL,
	`details_json` text,
	`created_at` text NOT NULL,
	`acked_at` text
);
--> statement-breakpoint
CREATE INDEX `idx_publication_events_lookup` ON `publication_events` (`publication_key`,`target`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_publication_events_created_at` ON `publication_events` (`created_at`);--> statement-breakpoint
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
--> statement-breakpoint
CREATE INDEX `idx_runtime_usage_bucket_day` ON `runtime_usage` (`bucket_day`);--> statement-breakpoint
CREATE INDEX `idx_runtime_usage_feature_last_seen` ON `runtime_usage` (`feature_key`,`last_seen_at`);--> statement-breakpoint
CREATE TABLE `worker_state` (
	`name` text PRIMARY KEY NOT NULL,
	`state_json` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
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
--> statement-breakpoint
CREATE INDEX `idx_draft_story_cards_due` ON `draft_story_cards` (`status`,`next_attempt_at`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_draft_story_cards_lock` ON `draft_story_cards` (`locked_by`,`locked_at`);--> statement-breakpoint
CREATE TABLE `drafts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`actor_id` integer NOT NULL,
	`status` text NOT NULL,
	`text_ru` text NOT NULL,
	`text_en_machine` text,
	`text_en_approved` text,
	`targets_json` text NOT NULL,
	`media_ru_json` text,
	`media_en_json` text,
	`channel_message_id` integer,
	`scheduled_at` text,
	`scheduled_en_at` text,
	`publish_mode` text,
	`post_id` integer,
	`text_ru_entities_json` text,
	`text_en_entities_json` text,
	`threads_chain_approved` integer DEFAULT 0 NOT NULL,
	`story_publish_mode` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
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
--> statement-breakpoint
CREATE TABLE `publication_plans` (
	`post_id` integer PRIMARY KEY NOT NULL,
	`plan_json` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `publication_sources` (
	`post_id` integer PRIMARY KEY NOT NULL,
	`item_json` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `publications` (
	`post_id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`draft_id` integer,
	`status` text DEFAULT 'draft' NOT NULL,
	`telegram_message_id` integer,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_publications_created_at` ON `publications` (`created_at`);--> statement-breakpoint
CREATE TABLE `publish_jobs` (
	`job_id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`publication_id` integer NOT NULL,
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
CREATE UNIQUE INDEX `idx_publish_jobs_publication_target_status` ON `publish_jobs` (`publication_key`,`target`,`status`);--> statement-breakpoint
CREATE INDEX `idx_publish_jobs_due` ON `publish_jobs` (`status`,`publish_at`,`next_attempt_at`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_publish_jobs_lock` ON `publish_jobs` (`locked_by`,`locked_at`);--> statement-breakpoint
CREATE INDEX `idx_publish_jobs_publication` ON `publish_jobs` (`publication_id`,`target`,`status`);--> statement-breakpoint
CREATE INDEX `idx_publish_jobs_updated_at` ON `publish_jobs` (`updated_at`);--> statement-breakpoint
CREATE TABLE `site_jobs` (
	`job_id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`post_id` integer,
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
CREATE INDEX `idx_site_jobs_due` ON `site_jobs` (`status`,`next_attempt_at`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_site_jobs_lock` ON `site_jobs` (`locked_by`,`locked_at`);--> statement-breakpoint
CREATE INDEX `idx_site_jobs_post` ON `site_jobs` (`post_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_site_jobs_updated_at` ON `site_jobs` (`updated_at`);--> statement-breakpoint
CREATE TABLE `site_pageviews` (
	`day` text NOT NULL,
	`path` text NOT NULL,
	`count` integer DEFAULT 0 NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`day`, `path`)
);
--> statement-breakpoint
CREATE INDEX `idx_site_pageviews_day` ON `site_pageviews` (`day`);--> statement-breakpoint
CREATE TABLE `bot_settings` (
	`actor_id` integer PRIMARY KEY NOT NULL,
	`youtube_signature` text DEFAULT '' NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `bot_ui_settings` (
	`actor_id` integer PRIMARY KEY NOT NULL,
	`locale` text DEFAULT 'en' NOT NULL,
	`timezone` text,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
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
--> statement-breakpoint
CREATE INDEX `idx_channel_connections_enabled` ON `channel_connections` (`enabled`,`platform`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_channel_connections_route` ON `channel_connections` (`platform`,`locale`,`provider`,`provider_account_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_channel_connections_target` ON `channel_connections` (`target_id`);--> statement-breakpoint
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
--> statement-breakpoint
CREATE INDEX `idx_interface_bindings_lookup` ON `interface_bindings` (`entity_type`,`entity_id`);--> statement-breakpoint
CREATE TABLE `studio_backup_settings` (
	`id` integer PRIMARY KEY DEFAULT 1 NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
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
--> statement-breakpoint
CREATE INDEX `idx_studio_media_assets_owner` ON `studio_media_assets` (`actor_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_studio_media_assets_hash` ON `studio_media_assets` (`sha256`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_studio_media_assets_owner_hash` ON `studio_media_assets` (`actor_id`,`sha256`);--> statement-breakpoint
CREATE TABLE `studio_news_digest_settings` (
	`id` integer PRIMARY KEY DEFAULT 1 NOT NULL,
	`enabled` integer DEFAULT 0 NOT NULL,
	`hour` integer DEFAULT 10 NOT NULL,
	`minute` integer DEFAULT 0 NOT NULL,
	`prompt` text DEFAULT '' NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
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
--> statement-breakpoint
CREATE INDEX `idx_studio_notification_jobs_due` ON `studio_notification_jobs` (`status`,`run_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_studio_notification_jobs_ref_kind` ON `studio_notification_jobs` (`ref`,`kind`);--> statement-breakpoint
CREATE TABLE `studio_notification_settings` (
	`actor_id` integer PRIMARY KEY NOT NULL,
	`video_reminders_enabled` integer DEFAULT 1 NOT NULL,
	`post_reminders_enabled` integer DEFAULT 1 NOT NULL,
	`reminder_minutes` integer DEFAULT 5 NOT NULL,
	`completion_enabled` integer DEFAULT 1 NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `studio_profile` (
	`id` integer PRIMARY KEY DEFAULT 1 NOT NULL,
	`timezone` text DEFAULT 'UTC' NOT NULL,
	`timezone_label` text DEFAULT 'UTC' NOT NULL,
	`site_enabled` integer DEFAULT 0 NOT NULL,
	`video_prepare_lead_minutes` integer DEFAULT 15 NOT NULL,
	`video_reminder_minutes` integer DEFAULT 5 NOT NULL,
	`video_retention_hours` integer DEFAULT 24 NOT NULL,
	`name_json` text DEFAULT '{"en":"","ru":""}' NOT NULL,
	`tagline_json` text DEFAULT '{"en":"","ru":""}' NOT NULL,
	`about_json` text DEFAULT '{"en":"","ru":""}' NOT NULL,
	`profiles_json` text DEFAULT '{"en":[],"ru":[]}' NOT NULL,
	`default_targets_json` text DEFAULT '["telegram","site_ru","site_en","threads_ru","threads_en","telegram_stories","instagram_stories_ru","instagram_stories"]' NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `studio_weekly_digest_settings` (
	`id` integer PRIMARY KEY DEFAULT 1 NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	`weekday` integer DEFAULT 0 NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `social_comments` (
	`platform` text NOT NULL,
	`comment_id` text NOT NULL,
	`video_target_id` integer NOT NULL,
	`author` text,
	`text` text NOT NULL,
	`like_count` integer DEFAULT 0 NOT NULL,
	`published_at` text,
	`fetched_at` text NOT NULL,
	PRIMARY KEY(`platform`, `comment_id`),
	FOREIGN KEY (`video_target_id`) REFERENCES `video_targets`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_social_comments_target` ON `social_comments` (`video_target_id`,`published_at`);--> statement-breakpoint
CREATE TABLE `video_drafts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`actor_id` integer NOT NULL,
	`locale` text DEFAULT 'ru' NOT NULL,
	`label` text DEFAULT '' NOT NULL,
	`studio_media_asset_id` integer NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`scheduled_at` text,
	`retention_until` text,
	`source_pruned_at` text,
	`control_chat_id` integer,
	`control_message_id` integer,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`studio_media_asset_id`) REFERENCES `studio_media_assets`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_video_drafts_status_schedule` ON `video_drafts` (`status`,`scheduled_at`);--> statement-breakpoint
CREATE INDEX `idx_video_drafts_studio_media_asset` ON `video_drafts` (`studio_media_asset_id`);--> statement-breakpoint
CREATE INDEX `idx_video_drafts_updated_at` ON `video_drafts` (`updated_at`);--> statement-breakpoint
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
--> statement-breakpoint
CREATE INDEX `idx_video_jobs_due` ON `video_jobs` (`status`,`run_at`,`next_attempt_at`);--> statement-breakpoint
CREATE INDEX `idx_video_jobs_lock` ON `video_jobs` (`status`,`locked_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_video_jobs_unique` ON `video_jobs` (`video_draft_id`,`video_target_id`,`kind`);--> statement-breakpoint
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
--> statement-breakpoint
CREATE INDEX `idx_video_metric_schedule_lock` ON `video_metric_schedule` (`locked_by`,`locked_at`);--> statement-breakpoint
CREATE TABLE `video_metric_snapshots` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`video_target_id` integer NOT NULL,
	`platform` text NOT NULL,
	`metrics_json` text NOT NULL,
	`checkpoint_index` integer,
	`sampled_at` text NOT NULL,
	FOREIGN KEY (`video_target_id`) REFERENCES `video_targets`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_video_metric_snapshots_target_sampled` ON `video_metric_snapshots` (`video_target_id`,`sampled_at`);--> statement-breakpoint
CREATE INDEX `idx_video_metric_snapshots_sampled_at` ON `video_metric_snapshots` (`sampled_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_video_metric_snapshots_checkpoint` ON `video_metric_snapshots` (`video_target_id`,`checkpoint_index`) WHERE "video_metric_snapshots"."checkpoint_index" IS NOT NULL;--> statement-breakpoint
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
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_video_targets_draft_target` ON `video_targets` (`video_draft_id`,`target`);--> statement-breakpoint
CREATE INDEX `idx_video_targets_status_schedule` ON `video_targets` (`status`,`scheduled_at`);
--> statement-breakpoint
INSERT INTO knowledge_entities ("id", "kind", "slug", "title_ru", "title_en", "created_at", "updated_at", "parent_entity_id") VALUES
  (3, 'company', 'anthropic', 'Anthropic', 'Anthropic', '1970-01-01T00:00:00.000Z', '1970-01-01T00:00:00.000Z', NULL),
  (4, 'company', 'openai', 'OpenAI', 'OpenAI', '1970-01-01T00:00:00.000Z', '1970-01-01T00:00:00.000Z', NULL),
  (5, 'company', 'google', 'Google', 'Google', '1970-01-01T00:00:00.000Z', '1970-01-01T00:00:00.000Z', NULL),
  (6, 'company', 'moonshot-ai', 'Moonshot AI', 'Moonshot AI', '1970-01-01T00:00:00.000Z', '1970-01-01T00:00:00.000Z', NULL),
  (7, 'model', 'claude', 'Claude', 'Claude', '1970-01-01T00:00:00.000Z', '1970-01-01T00:00:00.000Z', 3),
  (8, 'model', 'fable-5', 'Fable 5', 'Fable 5', '1970-01-01T00:00:00.000Z', '1970-01-01T00:00:00.000Z', 3),
  (9, 'model', 'gpt-5-6-sol', 'GPT-5.6 Sol', 'GPT-5.6 Sol', '1970-01-01T00:00:00.000Z', '1970-01-01T00:00:00.000Z', 4),
  (10, 'model', 'gemini-3-6-flash', 'Gemini 3.6 Flash', 'Gemini 3.6 Flash', '1970-01-01T00:00:00.000Z', '1970-01-01T00:00:00.000Z', 5),
  (11, 'model', 'kimi-k3', 'Kimi K3', 'Kimi K3', '1970-01-01T00:00:00.000Z', '1970-01-01T00:00:00.000Z', 6),
  (12, 'topic', 'codex', 'Codex', 'Codex', '1970-01-01T00:00:00.000Z', '1970-01-01T00:00:00.000Z', NULL);
--> statement-breakpoint
INSERT INTO knowledge_entity_aliases ("entity_id", "alias", "created_at") VALUES
  (3, 'Anthropic', '1970-01-01T00:00:00.000Z'),
  (4, 'OpenAI', '1970-01-01T00:00:00.000Z'),
  (5, 'Google', '1970-01-01T00:00:00.000Z'),
  (6, 'Moonshot AI', '1970-01-01T00:00:00.000Z'),
  (7, 'Claude', '1970-01-01T00:00:00.000Z'),
  (8, 'Fable 5', '1970-01-01T00:00:00.000Z'),
  (9, 'GPT-5.6 Sol', '1970-01-01T00:00:00.000Z'),
  (10, 'Gemini 3.6 Flash', '1970-01-01T00:00:00.000Z'),
  (11, 'Kimi K3', '1970-01-01T00:00:00.000Z'),
  (8, 'Fable', '1970-01-01T00:00:00.000Z'),
  (9, 'GPT 5.6 Sol', '1970-01-01T00:00:00.000Z');
--> statement-breakpoint
INSERT INTO `studio_profile` (`id`, `updated_at`) VALUES (1, '1970-01-01T00:00:00.000Z');
