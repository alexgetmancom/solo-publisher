import { describe, expect, it } from "bun:test";
import { analyticsDataVersion } from "../src/analytics/data-version.js";
import { openBackendDb } from "../src/db/client.js";
import { unsafeDb } from "../src/db/unsafe.js";

/**
 * The version is what keeps every loaded history alive, so a change it cannot
 * see is a dashboard showing yesterday's numbers indefinitely. The three cases
 * below are the ones counts and maximum ids miss on their own: a row updated in
 * place, and two tables the answer depends on without being measurements
 * themselves.
 */
function withDb(run: (backendDb: ReturnType<typeof openBackendDb>) => void): void {
  const backendDb = openBackendDb(":memory:");
  try {
    run(backendDb);
  } finally {
    backendDb.close();
  }
}

describe("analytics data version", () => {
  it("moves when an existing video snapshot is updated in place", () =>
    withDb((backendDb) => {
      const sqlite = unsafeDb(backendDb).sqlite;
      const at = "2026-08-01T00:00:00.000Z";
      sqlite.run(
        `INSERT INTO studio_media_assets (id, actor_id, kind, mime_type, filename, local_path, byte_size, sha256, source, created_at)
         VALUES (1, 42, 'video', 'video/mp4', 'clip.mp4', '/tmp/clip.mp4', 1, 'hash', 'test', ?)`,
        [at],
      );
      sqlite.run(`INSERT INTO video_drafts (id, actor_id, studio_media_asset_id, created_at, updated_at) VALUES (1, 42, 1, ?, ?)`, [
        at,
        at,
      ]);
      sqlite.run(
        `INSERT INTO video_targets (id, video_draft_id, target, metadata_json, created_at, updated_at) VALUES (1, 1, 'youtube_shorts', '{}', ?, ?)`,
        [at, at],
      );
      sqlite.run(
        `INSERT INTO video_metric_snapshots (video_target_id, platform, metrics_json, sampled_at) VALUES (1, 'youtube', '{"views":10}', ?)`,
        [at],
      );
      const before = analyticsDataVersion(backendDb);
      // Neither the count nor the maximum id moves here.
      sqlite.run(`UPDATE video_metric_snapshots SET metrics_json = '{"views":99}', sampled_at = '2026-08-02T00:00:00.000Z'`);
      expect(analyticsDataVersion(backendDb)).not.toBe(before);
    }));

  it("moves when a follower snapshot is collected", () =>
    withDb((backendDb) => {
      const sqlite = unsafeDb(backendDb).sqlite;
      const before = analyticsDataVersion(backendDb);
      sqlite.run(
        `INSERT INTO creator_profile_snapshots (platform, account, sampled_on, metrics_json, source, sampled_at)
         VALUES ('youtube', 'main', '2026-08-01', '{"subscriberCount":100}', 'test', '2026-08-01T00:00:00.000Z')`,
      );
      expect(analyticsDataVersion(backendDb)).not.toBe(before);
    }));

  it("moves when a channel is connected", () =>
    withDb((backendDb) => {
      const sqlite = unsafeDb(backendDb).sqlite;
      const before = analyticsDataVersion(backendDb);
      sqlite.run(
        `INSERT INTO channel_connections (id, platform, locale, provider, label, enabled, source, created_at, updated_at)
         VALUES ('youtube_ru', 'youtube', 'ru', 'native', 'YouTube RU', 1, 'test', '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z')`,
      );
      expect(analyticsDataVersion(backendDb)).not.toBe(before);
    }));

  it("stands still when nothing has changed", () =>
    withDb((backendDb) => {
      expect(analyticsDataVersion(backendDb)).toBe(analyticsDataVersion(backendDb));
    }));
});
