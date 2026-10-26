DROP TABLE IF EXISTS device_authorizations;
--> statement-breakpoint
DELETE FROM channel_connections WHERE platform = 'twitch';
--> statement-breakpoint
DELETE FROM platform_tokens WHERE target = 'twitch';
--> statement-breakpoint
DELETE FROM conversation_sessions WHERE kind = 'stream';
--> statement-breakpoint
DELETE FROM worker_state WHERE name = 'youtube-live';
