CREATE TABLE `studio_radar_settings` (
	`id` integer PRIMARY KEY DEFAULT 1 NOT NULL,
	`enabled` integer DEFAULT 0 NOT NULL,
	`hour` integer DEFAULT 10 NOT NULL,
	`minute` integer DEFAULT 0 NOT NULL,
	`prompt` text DEFAULT '' NOT NULL,
	`effort` text DEFAULT 'xhigh' NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
INSERT INTO `studio_radar_settings` (`id`, `enabled`, `hour`, `minute`, `prompt`, `effort`, `updated_at`)
SELECT `id`, `enabled`, `hour`, `minute`, `prompt`, `effort`, `updated_at` FROM `studio_news_digest_settings`;
--> statement-breakpoint
DROP TABLE `studio_news_digest_settings`;
--> statement-breakpoint
CREATE TABLE `editorial_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`producer` text NOT NULL,
	`status` text NOT NULL,
	`raw_text` text,
	`error` text,
	`candidate_count` integer DEFAULT 0 NOT NULL,
	`duplicate_count` integer DEFAULT 0 NOT NULL,
	`started_at` text NOT NULL,
	`finished_at` text
);
--> statement-breakpoint
CREATE INDEX `idx_editorial_runs_producer_started` ON `editorial_runs` (`producer`,`started_at`);
--> statement-breakpoint
CREATE TABLE `editorial_candidates` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`run_id` integer NOT NULL,
	`producer` text NOT NULL,
	`cluster_key` text NOT NULL,
	`title` text NOT NULL,
	`summary` text DEFAULT '' NOT NULL,
	`reason` text DEFAULT '' NOT NULL,
	`url` text,
	`source_host` text,
	`related_post_ids_json` text DEFAULT '[]' NOT NULL,
	`entity_slugs_json` text DEFAULT '[]' NOT NULL,
	`score` integer DEFAULT 0 NOT NULL,
	`score_json` text DEFAULT '{}' NOT NULL,
	`status` text DEFAULT 'new' NOT NULL,
	`skip_reason` text,
	`decided_at` text,
	`expires_at` text,
	`offered_at` text,
	`draft_id` integer,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_editorial_candidates_cluster` ON `editorial_candidates` (`cluster_key`);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_editorial_candidates_url` ON `editorial_candidates` (`url`);
--> statement-breakpoint
CREATE INDEX `idx_editorial_candidates_status_score` ON `editorial_candidates` (`status`,`score`);
--> statement-breakpoint
CREATE INDEX `idx_editorial_candidates_run` ON `editorial_candidates` (`run_id`);
--> statement-breakpoint
CREATE INDEX `idx_editorial_candidates_draft` ON `editorial_candidates` (`draft_id`);
--> statement-breakpoint
CREATE TABLE `editorial_outcomes` (
	`candidate_id` integer NOT NULL,
	`horizon` text NOT NULL,
	`views` integer DEFAULT 0 NOT NULL,
	`reactions` integer DEFAULT 0 NOT NULL,
	`shares` integer DEFAULT 0 NOT NULL,
	`replies` integer DEFAULT 0 NOT NULL,
	`captured_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_editorial_outcomes_key` ON `editorial_outcomes` (`candidate_id`,`horizon`);
