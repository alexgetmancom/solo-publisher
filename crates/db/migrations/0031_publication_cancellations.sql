CREATE TABLE `publication_cancellations` (
	`publication_key` text PRIMARY KEY NOT NULL,
	`actor_id` integer NOT NULL,
	`requested_at` text NOT NULL
);
