CREATE TABLE `studio_milestone_settings` (
	`id` integer PRIMARY KEY DEFAULT 1 NOT NULL,
	`channel_enabled` integer DEFAULT 1 NOT NULL,
	`group_locale_enabled` integer DEFAULT 1 NOT NULL,
	`locale_enabled` integer DEFAULT 1 NOT NULL,
	`project_enabled` integer DEFAULT 1 NOT NULL,
	`thresholds_json` text DEFAULT '[100,250,500,1000,2000,3000,4000,5000,6000,7000,8000,9000,10000]' NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
INSERT INTO `studio_milestone_settings` (`id`, `updated_at`) VALUES (1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
--> statement-breakpoint
UPDATE `analytics_rollups`
SET `metric_json` = json_set(
	`metric_json`,
	'$.reachedThrough',
	COALESCE(
		(
			SELECT MAX(CAST(SUBSTR(`alert_key`, LENGTH('analytics:milestone:v2:' || `analytics_rollups`.`subject`) + 2) AS INTEGER))
			FROM `alert_dedup`
			WHERE `alert_key` LIKE 'analytics:milestone:v2:' || `analytics_rollups`.`subject` || ':%'
		),
		0
	)
)
WHERE `scope` = 'audience_milestone' AND json_valid(`metric_json`);
--> statement-breakpoint
DELETE FROM `alert_dedup` WHERE `alert_key` LIKE 'analytics:milestone:%';
