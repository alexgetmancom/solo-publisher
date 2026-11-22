CREATE TABLE `studio_youtube_settings` (
	`id` integer PRIMARY KEY DEFAULT 1 NOT NULL,
	`signature` text DEFAULT '' NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
INSERT INTO `studio_youtube_settings` (`id`, `signature`, `updated_at`)
SELECT 1, `youtube_signature`, `updated_at`
FROM `bot_settings`
WHERE TRIM(`youtube_signature`) <> ''
ORDER BY `updated_at` DESC
LIMIT 1;
--> statement-breakpoint
DROP TABLE `bot_settings`;
--> statement-breakpoint
ALTER TABLE `studio_news_digest_settings` ADD `effort` text DEFAULT 'xhigh' NOT NULL;
--> statement-breakpoint
ALTER TABLE `studio_profile` DROP COLUMN `video_reminder_minutes`;
