CREATE TABLE `studio_news_digest_settings` (
	`id` integer PRIMARY KEY DEFAULT 1 NOT NULL,
	`enabled` integer DEFAULT 0 NOT NULL,
	`hour` integer DEFAULT 10 NOT NULL,
	`minute` integer DEFAULT 0 NOT NULL,
	`prompt` text DEFAULT '' NOT NULL,
	`effort` text DEFAULT 'xhigh' NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
INSERT INTO `studio_news_digest_settings` (`id`, `enabled`, `hour`, `minute`, `prompt`, `effort`, `updated_at`)
SELECT `id`, `enabled`, `hour`, `minute`, `prompt`, `effort`, `updated_at` FROM `studio_radar_settings`;
--> statement-breakpoint
DROP TABLE `studio_radar_settings`;
--> statement-breakpoint
DROP TABLE `editorial_outcomes`;
--> statement-breakpoint
DROP TABLE `editorial_candidates`;
--> statement-breakpoint
DROP TABLE `editorial_runs`;
