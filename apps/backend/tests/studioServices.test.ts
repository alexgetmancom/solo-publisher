import { describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { flushUsage } from "../src/observability/usage.js";
import { createStudioServices } from "../src/studio/services/index.js";
import { withDb } from "./helpers/db.js";
import { openBackendDb } from "./helpers/open-db.js";
import { loadTestConfig } from "./helpers/studio-config.js";

const PNG_BYTES = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");

describe("Studio service boundaries", () => {
  it("builds one service graph per runtime and reuses a fresh analytics dashboard", () =>
    withDb(async (backendDb) => {
      const config = loadTestConfig({});
      const first = createStudioServices(backendDb, config);
      const second = createStudioServices(backendDb, config);

      expect(second).toBe(first);
      expect(second.analytics.dashboard("overview", 7, "en")).toBe(first.analytics.dashboard("overview", 7, "en"));
      expect(createStudioServices(backendDb, loadTestConfig({}))).not.toBe(first);
    }));

  it("imports byte and file media through one facade with content deduplication", async () => {
    const backendDb = openBackendDb(":memory:");
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "studio-service-media-"));
    try {
      const config = loadTestConfig({ DATA_DIR: directory, STUDIO_MEDIA_MAX_BYTES: "1000" });
      const media = createStudioServices(backendDb, config).media;
      const bytes = PNG_BYTES;
      const first = await media.import(42, {
        filename: "first.jpg",
        contentType: "image/jpeg",
        bytes,
        source: "ops_upload",
      });
      const source = path.join(directory, "incoming.jpg");
      fs.writeFileSync(source, bytes);
      const second = await media.importFile(42, {
        filename: "second.png",
        contentType: "image/png",
        localPath: source,
        source: "http_upload",
      });

      expect(second.id).toBe(first.id);
      expect(second.localPath).toBe(first.localPath);
      expect(fs.existsSync(path.join(directory, "story-media", `${path.parse(first.localPath).name}-story-standard.jpg`))).toBe(true);
    } finally {
      backendDb.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("keeps locale and YouTube signature in the shared settings service", () =>
    withDb(async (backendDb) => {
      const settings = createStudioServices(backendDb, loadTestConfig({})).settings;
      expect(settings.locale(42)).toBe("en");
      settings.setLocale(42, "ru");
      expect(settings.locale(42)).toBe("ru");
      settings.setTimezone(42, "America/New_York");
      expect(settings.timezone(42, "Europe/Moscow")).toBe("America/New_York");
      expect(settings.timeConfig(42, { TIMEZONE: "Europe/Moscow", TIMEZONE_LABEL: "MSK" })).toMatchObject({
        TIMEZONE: "America/New_York",
      });
      settings.setYoutubeSignature("https://example.com\\path");
      expect(settings.youtubeSignature()).toBe("https://example.com/path");
      settings.clearYoutubeSignature();
      expect(settings.youtubeSignature()).toBe("");
    }));

  it("registers channels through the shared channel service", () =>
    withDb(async (backendDb) => {
      const config = loadTestConfig({});
      const channels = createStudioServices(backendDb, config).channels;
      const result = channels.connect({
        platform: "instagram",
        locale: "en",
        provider: "native",
        providerAccountId: "account-1",
      });
      expect(result.source).toBe("interface");
      expect(channels.list().find((channel) => channel.id === "instagram_en")).toMatchObject({ providerAccountId: "account-1" });
      flushUsage(backendDb);
      expect(
        backendDb.sqlite
          .query("SELECT feature_key, calls FROM runtime_usage WHERE feature_key LIKE 'studio.channel.%' ORDER BY feature_key")
          .all(),
      ).toEqual([
        { feature_key: "studio.channel.connect", calls: 1 },
        { feature_key: "studio.channel.list", calls: 1 },
      ]);
    }));

  it("keeps every analytics operation behind the shared Studio boundary", () =>
    withDb(async (backendDb) => {
      const analytics = createStudioServices(backendDb, loadTestConfig({})).analytics;

      expect(analytics.postArchive(0, "en").total).toBe(0);
      expect(typeof analytics.postMetrics(999, "en")).toBe("string");
      expect(analytics.postMedia(999, "en")).toEqual([]);
      expect(analytics.archiveSummary("en").posts).toBe(0);
      expect(analytics.videoArchive(0, "en").total).toBe(0);
      expect(typeof analytics.videoMetrics(999, "en")).toBe("string");
      expect(await analytics.audienceAnalysis("en")).toContain("🤖");
    }));
});
