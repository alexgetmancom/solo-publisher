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
--> statement-breakpoint
CREATE INDEX `idx_draft_translations_due` ON `draft_translations` (`status`,`next_attempt_at`,`created_at`);
