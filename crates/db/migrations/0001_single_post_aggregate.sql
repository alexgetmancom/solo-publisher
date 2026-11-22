CREATE TABLE `drafts_new` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`actor_id` integer NOT NULL,
	`status` text NOT NULL,
	`targets_json` text NOT NULL,
	`channel_message_id` integer,
	`scheduled_at` text,
	`scheduled_en_at` text,
	`publish_mode` text,
	`post_id` integer,
	`threads_chain_approved` integer DEFAULT 0 NOT NULL,
	`story_publish_mode` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
INSERT INTO `drafts_new` (
	`id`, `actor_id`, `status`, `targets_json`, `channel_message_id`, `scheduled_at`, `scheduled_en_at`,
	`publish_mode`, `post_id`, `threads_chain_approved`, `story_publish_mode`, `created_at`, `updated_at`
)
WITH `latest_publications` AS (
	SELECT p.*, row_number() OVER (PARTITION BY p.`draft_id` ORDER BY p.`updated_at` DESC, p.`post_id` DESC) AS `draft_rank`
	FROM `publications` p
	WHERE p.`draft_id` IS NOT NULL
),
`draft_publications` AS (
	SELECT d.*, coalesce(exact.`post_id`, latest.`post_id`) AS `publication_post_id`,
		coalesce(exact.`status`, latest.`status`) AS `publication_status`,
		coalesce(exact.`telegram_message_id`, latest.`telegram_message_id`) AS `publication_message_id`,
		coalesce(exact.`updated_at`, latest.`updated_at`) AS `publication_updated_at`
	FROM `drafts` d
	LEFT JOIN `publications` exact ON exact.`post_id` = d.`post_id` AND exact.`draft_id` = d.`id`
	LEFT JOIN `latest_publications` latest ON latest.`draft_id` = d.`id` AND latest.`draft_rank` = 1
),
`ranked_drafts` AS (
	SELECT d.*,
		coalesce(d.`post_id`, d.`publication_post_id`) AS `candidate_post_id`,
		row_number() OVER (
			PARTITION BY coalesce(d.`post_id`, d.`publication_post_id`)
			ORDER BY CASE WHEN d.`publication_post_id` = coalesce(d.`post_id`, d.`publication_post_id`) THEN 0 ELSE 1 END,
				CASE WHEN d.`publication_updated_at` > d.`updated_at` THEN d.`publication_updated_at` ELSE d.`updated_at` END DESC,
				d.`id`
		) AS `candidate_rank`
	FROM `draft_publications` d
)
SELECT d.`id`, d.`actor_id`, coalesce(d.`publication_status`, d.`status`), d.`targets_json`,
	coalesce(d.`channel_message_id`, d.`publication_message_id`), d.`scheduled_at`, d.`scheduled_en_at`, d.`publish_mode`,
	CASE WHEN d.`candidate_post_id` IS NULL OR d.`candidate_rank` = 1 THEN d.`candidate_post_id` ELSE NULL END,
	d.`threads_chain_approved`, d.`story_publish_mode`, d.`created_at`,
	CASE WHEN d.`publication_updated_at` > d.`updated_at` THEN d.`publication_updated_at` ELSE d.`updated_at` END
FROM `ranked_drafts` d;
--> statement-breakpoint
INSERT INTO `drafts_new` (
	`actor_id`, `status`, `targets_json`, `channel_message_id`, `post_id`, `created_at`, `updated_at`
)
SELECT 0, CASE WHEN p.`status` IS NULL THEN CASE WHEN x.`status` = 'active' THEN 'published' ELSE x.`status` END ELSE p.`status` END,
	coalesce(json_extract(pp.`plan_json`, '$.targets'), '{}'), coalesce(p.`telegram_message_id`, x.`message_id`), x.`post_id`,
	coalesce(p.`created_at`, x.`created_at`), CASE WHEN p.`updated_at` > x.`updated_at` THEN p.`updated_at` ELSE x.`updated_at` END
FROM `posts` x
LEFT JOIN `publications` p ON p.`post_id` = x.`post_id`
LEFT JOIN `publication_plans` pp ON pp.`post_id` = x.`post_id`
WHERE x.`post_id` IS NOT NULL AND NOT EXISTS (SELECT 1 FROM `drafts_new` d WHERE d.`post_id` = x.`post_id`);
--> statement-breakpoint
INSERT INTO `drafts_new` (`actor_id`, `status`, `targets_json`, `channel_message_id`, `post_id`, `created_at`, `updated_at`)
SELECT 0, p.`status`, coalesce(json_extract(pp.`plan_json`, '$.targets'), '{}'), p.`telegram_message_id`, p.`post_id`, p.`created_at`, p.`updated_at`
FROM `publications` p
LEFT JOIN `publication_plans` pp ON pp.`post_id` = p.`post_id`
WHERE NOT EXISTS (SELECT 1 FROM `drafts_new` d WHERE d.`post_id` = p.`post_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `drafts_post_id_unique` ON `drafts_new` (`post_id`);
--> statement-breakpoint
ALTER TABLE `post_locales` RENAME TO `post_locales_old`;
--> statement-breakpoint
CREATE TABLE `post_locales` (
	`draft_id` integer NOT NULL,
	`locale` text NOT NULL,
	`source_text` text DEFAULT '' NOT NULL,
	`approved_text` text,
	`html` text,
	`entities_json` text,
	`media_json` text,
	`story_media_json` text,
	`site_media_json` text,
	`slug` text,
	`site_enabled` integer DEFAULT 0 NOT NULL,
	`publish_at` text,
	`published_at` text,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`draft_id`, `locale`)
);
--> statement-breakpoint
INSERT INTO `post_locales` (
	`draft_id`, `locale`, `source_text`, `approved_text`, `html`, `entities_json`, `media_json`,
	`story_media_json`, `site_media_json`, `slug`, `site_enabled`, `publish_at`, `published_at`, `updated_at`
)
SELECT root.`id`, lang.`locale`,
	CASE lang.`locale`
		WHEN 'ru' THEN coalesce(old_draft.`text_ru`, old_post.`text`, json_extract(source.`item_json`, '$.text_ru'), json_extract(source.`item_json`, '$.text'), '')
		ELSE coalesce(old_draft.`text_en_machine`, old_post.`text_en`, json_extract(source.`item_json`, '$.text_en'), json_extract(source.`item_json`, '$.bodyMarkdown'), '') END,
	CASE lang.`locale` WHEN 'en' THEN old_draft.`text_en_approved` ELSE NULL END,
	old_locale.`html`,
	CASE lang.`locale` WHEN 'ru' THEN old_draft.`text_ru_entities_json` ELSE old_draft.`text_en_entities_json` END,
	CASE lang.`locale`
		WHEN 'ru' THEN coalesce(old_draft.`media_ru_json`, json_extract(source.`item_json`, '$.media'), '[]')
		ELSE coalesce(old_draft.`media_en_json`, old_draft.`media_ru_json`, json_extract(source.`item_json`, '$.media_en'), json_extract(source.`item_json`, '$.media'), '[]') END,
	CASE lang.`locale` WHEN 'ru' THEN json_extract(source.`item_json`, '$.story_media_ru') ELSE json_extract(source.`item_json`, '$.story_media_en') END,
	coalesce(old_locale.`media_json`, CASE lang.`locale` WHEN 'ru' THEN json_extract(source.`item_json`, '$.site_media_ru') ELSE json_extract(source.`item_json`, '$.site_media_en') END, '[]'),
	coalesce(old_locale.`slug`, CASE lang.`locale` WHEN 'ru' THEN json_extract(source.`item_json`, '$.slug_ru') ELSE json_extract(source.`item_json`, '$.slug_en') END),
	coalesce(old_locale.`site_enabled`, CASE lang.`locale` WHEN 'ru' THEN json_extract(source.`item_json`, '$.has_ru') ELSE json_extract(source.`item_json`, '$.has_en') END, 0),
	CASE lang.`locale` WHEN 'ru' THEN old_draft.`scheduled_at` ELSE old_draft.`scheduled_en_at` END,
	old_locale.`published_at`, coalesce(old_locale.`updated_at`, old_draft.`updated_at`, old_post.`updated_at`, root.`updated_at`)
FROM `drafts_new` root
CROSS JOIN (SELECT 'ru' AS `locale` UNION ALL SELECT 'en') lang
LEFT JOIN `drafts` old_draft ON old_draft.`id` = root.`id`
LEFT JOIN `posts` old_post ON old_post.`post_id` = root.`post_id`
LEFT JOIN `publication_sources` source ON source.`post_id` = root.`post_id`
LEFT JOIN `post_locales_old` old_locale ON old_locale.`post_id` = root.`post_id` AND old_locale.`locale` = lang.`locale`;
--> statement-breakpoint
CREATE INDEX `idx_post_locales_published_at` ON `post_locales` (`published_at`);
--> statement-breakpoint
DROP TABLE `post_locales_old`;
--> statement-breakpoint
DROP TABLE `drafts`;
--> statement-breakpoint
ALTER TABLE `drafts_new` RENAME TO `drafts`;
--> statement-breakpoint
DROP TABLE `publication_plans`;
--> statement-breakpoint
DROP TABLE `publication_sources`;
--> statement-breakpoint
DROP TABLE `publications`;
--> statement-breakpoint
DROP TABLE `posts`;
