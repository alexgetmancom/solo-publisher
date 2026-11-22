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
);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_audience_demographics_daily` ON `audience_demographics` (`platform`,`account`,`metric`,`dimension`,`label`,`captured_on`);--> statement-breakpoint
CREATE INDEX `idx_audience_demographics_captured_at` ON `audience_demographics` (`captured_at`);
