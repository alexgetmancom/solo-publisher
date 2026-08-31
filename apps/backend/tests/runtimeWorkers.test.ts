import { afterEach, beforeEach, describe, expect, it, jest } from "bun:test";
import { eq } from "drizzle-orm";
import { workerState } from "../src/db/schema.js";
import { loadConfig, withStudioProfile } from "../src/foundation/config.js";
import { startCoreWorkers } from "../src/runtime/workers.js";
import { withDb } from "./helpers/db.js";
import { loadTestConfig, SITE_STUDIO_PROFILE } from "./helpers/studio-config.js";

const EXPECTED_WORKERS = [
  "platform-tokens",
  "credentials",
  "x-token",
  "story-derivatives",
  "story-cards",
  "queue",
  "publish-watchdog",
  "publication-reconciliation",
  "notifications",
  "video",
  "metrics",
  "creator-analytics",
  "metric-retention",
  "site",
  "site-watchdog",
  "media-cache",
  "operational-retention",
  "observability",
];

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  if (jest.isFakeTimers()) jest.clearAllTimers();
  jest.useRealTimers();
});

describe("core worker runtime", () => {
  it("starts every enabled loop and persists lifecycle heartbeats", async () => {
    await withDb(async (backendDb) => {
      const config = loadTestConfig({ WORKER_HEARTBEAT_INTERVAL_SECONDS: "1" }, SITE_STUDIO_PROFILE);
      const loops = startCoreWorkers(config, backendDb);

      try {
        expect(loops.map((loop) => loop.name)).toEqual(EXPECTED_WORKERS);
        jest.advanceTimersByTime(1_000);
        await Promise.resolve();

        const states = backendDb.db
          .select()
          .from(workerState)
          .all()
          .filter((state) => EXPECTED_WORKERS.includes(state.name));
        expect(states.map((state) => state.name).sort()).toEqual([...EXPECTED_WORKERS].sort());
        expect(states.every((state) => state.stateJson.scheduler_error === null)).toBe(true);
        expect(states.every((state) => typeof state.stateJson.last_heartbeat_at === "string")).toBe(true);
        expect(
          backendDb.db.select({ name: workerState.name }).from(workerState).where(eq(workerState.name, "observability")).get(),
        ).toEqual({ name: "observability" });
      } finally {
        for (const loop of loops) loop.stop();
        jest.useRealTimers();
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    });
  });

  it("picks up a site turned on while it is already running", async () => {
    // The regression this encodes reached production: the site loops used to be
    // chosen at startup from siteEnabled, so turning the site on left the pages
    // served — those are read per request — with nothing building them until
    // someone restarted the container.
    await withDb(async (backendDb) => {
      const config = withStudioProfile(loadConfig({ WORKER_HEARTBEAT_INTERVAL_SECONDS: "60" }), backendDb);
      backendDb.studioSettings.saveProfile({ siteEnabled: 0, updatedAt: new Date().toISOString() });
      const loops = startCoreWorkers(config, backendDb);

      try {
        // Present either way: whether they do anything is the tick's business.
        expect(loops.map((loop) => loop.name)).toEqual(EXPECTED_WORKERS);
        expect(config.studio.siteEnabled).toBe(false);

        backendDb.studioSettings.saveProfile({ siteEnabled: 1, updatedAt: new Date().toISOString() });
        // No restart, no new loops: the running config sees the new value.
        expect(config.studio.siteEnabled).toBe(true);
      } finally {
        for (const loop of loops) loop.stop();
        jest.useRealTimers();
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    });
  });
});
