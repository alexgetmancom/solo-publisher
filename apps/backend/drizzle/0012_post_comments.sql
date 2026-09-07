CREATE TABLE `post_comments` (
	`target` text NOT NULL,
	`comment_id` text NOT NULL,
	`external_post_id` text,
	`container_id` text,
	`author_id` text,
	`author` text DEFAULT '' NOT NULL,
	`text` text DEFAULT '' NOT NULL,
	`reply_to_comment_id` text,
	`sent_at` text NOT NULL,
	`edited_at` text,
	`fetched_at` text NOT NULL,
	PRIMARY KEY(`target`, `comment_id`)
);
--> statement-breakpoint
INSERT INTO `post_comments` (
	`target`, `comment_id`, `external_post_id`, `container_id`, `author_id`, `author`, `text`,
	`reply_to_comment_id`, `sent_at`, `edited_at`, `fetched_at`
)
SELECT
	'telegram',
	`chat_id` || ':' || `message_id`,
	`channel_post_id`,
	`chat_id` || ':' || `thread_id`,
	`author_id`,
	`author_name`,
	`text`,
	CASE WHEN `reply_to_message_id` IS NULL THEN NULL ELSE `chat_id` || ':' || `reply_to_message_id` END,
	`sent_at`,
	`edited_at`,
	`sent_at`
FROM `telegram_comments`;
--> statement-breakpoint
DROP TABLE `telegram_comments`;
--> statement-breakpoint
CREATE INDEX `idx_post_comments_post` ON `post_comments` (`external_post_id`,`sent_at`);
--> statement-breakpoint
CREATE INDEX `idx_post_comments_container` ON `post_comments` (`target`,`container_id`);
--> statement-breakpoint
CREATE INDEX `idx_post_comments_sent_at` ON `post_comments` (`sent_at`);
