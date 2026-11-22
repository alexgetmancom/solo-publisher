CREATE TABLE `draft_thread_parts` (
	`draft_id` integer NOT NULL,
	`position` integer NOT NULL,
	`text_ru` text NOT NULL,
	`entities_ru_json` text,
	`text_en` text,
	`media_json` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`draft_id`, `position`)
);
--> statement-breakpoint
ALTER TABLE `drafts` DROP COLUMN `threads_chain_approved`;
