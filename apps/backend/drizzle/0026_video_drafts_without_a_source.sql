-- A video this Studio did not publish has no source file, and saying it has
-- one is worse than saying nothing: the channel's own back catalogue is real
-- history, and the only thing missing from it is a file that was never here.
--
-- SQLite cannot drop a NOT NULL, so the table is rebuilt. The date guards are
-- reinstalled on every boot and come back on their own.
PRAGMA foreign_keys=OFF;
--> statement-breakpoint
CREATE TABLE `video_drafts_rebuilt` (
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
--> statement-breakpoint
INSERT INTO `video_drafts_rebuilt` SELECT `id`, `actor_id`, `locale`, `label`, `studio_media_asset_id`, `status`, `scheduled_at`, `retention_until`, `source_pruned_at`, `control_chat_id`, `control_message_id`, `created_at`, `updated_at`, `game`, `hook`, `script`, `script_source`, `opening_line` FROM `video_drafts`;
--> statement-breakpoint
DROP TABLE `video_drafts`;
--> statement-breakpoint
ALTER TABLE `video_drafts_rebuilt` RENAME TO `video_drafts`;
--> statement-breakpoint
CREATE INDEX `idx_video_drafts_status_schedule` ON `video_drafts` (`status`,`scheduled_at`);
--> statement-breakpoint
CREATE INDEX `idx_video_drafts_studio_media_asset` ON `video_drafts` (`studio_media_asset_id`);
--> statement-breakpoint
CREATE INDEX `idx_video_drafts_updated_at` ON `video_drafts` (`updated_at`);
--> statement-breakpoint
PRAGMA foreign_keys=ON;
