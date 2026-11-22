ALTER TABLE `video_drafts` ADD `game` text;--> statement-breakpoint
ALTER TABLE `video_drafts` ADD `hook` text;--> statement-breakpoint
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
);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_audience_activity_slot` ON `audience_activity` (`platform`,`account`,`metric`,`captured_at`,`weekday`,`hour_local`);--> statement-breakpoint
CREATE INDEX `idx_audience_activity_captured_at` ON `audience_activity` (`captured_at`);
