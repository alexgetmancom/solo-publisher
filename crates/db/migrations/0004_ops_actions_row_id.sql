CREATE TABLE `ops_actions_new` (
	`action_id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`actor_type` text NOT NULL,
	`action` text NOT NULL,
	`message_id` integer,
	`target` text,
	`status` text NOT NULL,
	`details_json` text,
	`created_at` text NOT NULL,
	`completed_at` text
);
--> statement-breakpoint
INSERT INTO `ops_actions_new` (
	`action_id`, `actor_type`, `action`, `message_id`, `target`, `status`, `details_json`, `created_at`, `completed_at`
)
SELECT `action_id`, `actor_type`, `action`, `message_id`, `target`, `status`, `details_json`, `created_at`, `completed_at`
FROM `ops_actions`;
--> statement-breakpoint
DROP TABLE `ops_actions`;
--> statement-breakpoint
ALTER TABLE `ops_actions_new` RENAME TO `ops_actions`;
--> statement-breakpoint
CREATE INDEX `idx_ops_actions_created_at` ON `ops_actions` (`created_at`);
