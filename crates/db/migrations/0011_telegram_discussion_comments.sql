CREATE TABLE `telegram_discussion_threads` (
	`chat_id` text NOT NULL,
	`thread_id` integer NOT NULL,
	`channel_post_id` text NOT NULL,
	`seen_at` text NOT NULL,
	PRIMARY KEY(`chat_id`, `thread_id`)
);
--> statement-breakpoint
CREATE INDEX `idx_telegram_discussion_threads_post` ON `telegram_discussion_threads` (`channel_post_id`);
--> statement-breakpoint
CREATE TABLE `telegram_comments` (
	`chat_id` text NOT NULL,
	`message_id` integer NOT NULL,
	`thread_id` integer NOT NULL,
	`channel_post_id` text,
	`author_id` text,
	`author_name` text DEFAULT '' NOT NULL,
	`text` text DEFAULT '' NOT NULL,
	`reply_to_message_id` integer,
	`sent_at` text NOT NULL,
	`edited_at` text,
	PRIMARY KEY(`chat_id`, `message_id`)
);
--> statement-breakpoint
CREATE INDEX `idx_telegram_comments_post` ON `telegram_comments` (`channel_post_id`,`sent_at`);
--> statement-breakpoint
CREATE INDEX `idx_telegram_comments_sent_at` ON `telegram_comments` (`sent_at`);
