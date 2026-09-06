CREATE TABLE `games` (
	`name` text PRIMARY KEY NOT NULL,
	`steam_app_id` text,
	`genres` text,
	`player_modes` text,
	`release_date` text,
	`developer` text,
	`source` text NOT NULL,
	`captured_at` text NOT NULL
);--> statement-breakpoint
CREATE INDEX `idx_games_captured_at` ON `games` (`captured_at`);
