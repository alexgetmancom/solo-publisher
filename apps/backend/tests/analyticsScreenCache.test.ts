import { describe, expect, it } from "bun:test";
import { openBackendDb } from "../src/db/client.js";
import { unsafeDb } from "../src/db/unsafe.js";
import { analyticsService } from "../src/studio/services/analytics.js";
import { loadTestConfig } from "./helpers/studio-config.js";

/**
 * The screen an operator opens most, and the heaviest one the bot builds. It is
 * kept until its numbers move, so stepping between sections and back is free
 * while a freshly collected metric is never hidden.
 */
describe("analytics screen cache", () => {
  it("reuses the built screen and drops it when the numbers move", () => {
    const backendDb = openBackendDb(":memory:");
    try {
      const analytics = analyticsService(backendDb, loadTestConfig({}));
      const first = analytics.dashboard("overview", 7, "en");
      // Same object, not merely equal text: nothing was rebuilt.
      expect(analytics.dashboard("overview", 7, "en")).toBe(first);

      unsafeDb(backendDb).sqlite.run(
        `INSERT INTO metric_samples (publication_key, target, metric_name, value, sampled_at, source)
         VALUES ('post:1', 'telegram', 'views', 10, '2026-08-01T00:00:00.000Z', 'test')`,
      );
      expect(analytics.dashboard("overview", 7, "en")).not.toBe(first);
    } finally {
      backendDb.close();
    }
  });

  it("keeps each section, period and language apart", () => {
    const backendDb = openBackendDb(":memory:");
    try {
      const analytics = analyticsService(backendDb, loadTestConfig({}));
      const overview = analytics.dashboard("overview", 7, "en");
      expect(analytics.dashboard("posts", 7, "en")).not.toBe(overview);
      expect(analytics.dashboard("overview", 30, "en")).not.toBe(overview);
      expect(analytics.dashboard("overview", 7, "ru")).not.toBe(overview);
      expect(analytics.dashboard("overview", 7, "en")).toBe(overview);
    } finally {
      backendDb.close();
    }
  });
});
