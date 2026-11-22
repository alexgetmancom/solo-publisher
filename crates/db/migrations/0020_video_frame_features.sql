CREATE TABLE `video_frame_features` (
	`video_draft_id` integer NOT NULL,
	`at_seconds` integer NOT NULL,
	`features_json` text NOT NULL,
	`source` text NOT NULL,
	`captured_at` text NOT NULL,
	PRIMARY KEY(`video_draft_id`, `at_seconds`),
	FOREIGN KEY (`video_draft_id`) REFERENCES `video_drafts`(`id`) ON UPDATE no action ON DELETE cascade
);
