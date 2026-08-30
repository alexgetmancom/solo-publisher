import { describe, expect, it, mock } from "bun:test";
import { eq } from "drizzle-orm";
import type { UnsafeBackendDb } from "../src/db/client.js";
import { alertDedup, credentialChecks, publicationEvents, publishJobs, siteJobs, workerState } from "../src/db/schema.js";
import { deliverPendingAlerts } from "../src/observability/alerts.js";
import { runObservabilityCycle } from "../src/observability/cycle.js";
import { recordMemoryPressure, recordProcessRestart } from "../src/observability/runtime-health.js";
import { registerTestChannels, TEXT_TEST_CHANNELS, VIDEO_TEST_CHANNELS } from "./helpers/channels.js";
import { withOpenDb } from "./helpers/db.js";
import { openBackendDb } from "./helpers/open-db.js";
import { loadTestConfig } from "./helpers/studio-config.js";

type Harness = {
  backendDb: UnsafeBackendDb;
  sendMessage: ReturnType<typeof mock>;
  alertsPort: { sendAlert: (text: string) => Promise<void> };
  config: ReturnType<typeof loadTestConfig>;
};

/** One observability suite's world: a database with every channel registered, a
 * bot that records what it was asked to send, and the alert cooldown these tests
 * are written against. Closed after the test whichever way it ends. */
function withHarness<T>(fn: (harness: Harness) => T | Promise<T>): Promise<T> {
  return withOpenDb(
    () => {
      const backendDb = openBackendDb(":memory:");
      registerTestChannels(backendDb, [...TEXT_TEST_CHANNELS, ...VIDEO_TEST_CHANNELS]);
      return backendDb;
    },
    (backendDb) => {
      const sendMessage = mock(async () => ({ message_id: 1, date: 1, chat: { id: 42, type: "private" as const } }));
      const alertsPort = { sendAlert: async (_text: string) => void (await sendMessage()) };
      const config = loadTestConfig({ CONTROLLER_ADMIN_IDS: "42", CONTROLLER_BOT_TOKEN: "token", ALERT_COOLDOWN_SECONDS: "3600" });
      return fn({ backendDb, sendMessage, alertsPort, config });
    },
  );
}

function recordFailure(backendDb: ReturnType<typeof openBackendDb>, message: string): void {
  backendDb.db
    .insert(publicationEvents)
    .values({ eventType: "publish.failed", severity: "error", target: "x", message, createdAt: new Date().toISOString() })
    .run();
}

function countEvents(backendDb: ReturnType<typeof openBackendDb>, eventType: string): number {
  return backendDb.db.select().from(publicationEvents).where(eq(publicationEvents.eventType, eventType)).all().length;
}

describe("observability", () => {
  it("checks credentials and alerts the owner on a failure", () =>
    withHarness(async ({ backendDb, sendMessage, alertsPort, config }) => {
      recordFailure(backendDb, "API unavailable");
      expect(await runObservabilityCycle(config, backendDb, alertsPort)).toMatchObject({ alerts: 1 });
      expect(sendMessage).toHaveBeenCalledTimes(1);
      expect(backendDb.db.select().from(credentialChecks).all().length).toBeGreaterThan(8);
    }));

  it("deduplicates a repeated error within the cooldown and counts the suppression", () =>
    withHarness(async ({ backendDb, sendMessage, alertsPort, config }) => {
      recordFailure(backendDb, "API unavailable");
      await runObservabilityCycle(config, backendDb, alertsPort);
      expect(sendMessage).toHaveBeenCalledTimes(1);

      recordFailure(backendDb, "API unavailable");
      expect(await runObservabilityCycle(config, backendDb, alertsPort)).toMatchObject({ alerts: 0 });
      expect(sendMessage).toHaveBeenCalledTimes(1);
      expect(backendDb.db.select({ suppressedCount: alertDedup.suppressedCount }).from(alertDedup).get()?.suppressedCount).toBe(1);
    }));

  it("reserves alerts before delivery and continues after a transport failure", () =>
    withHarness(async ({ backendDb }) => {
      recordFailure(backendDb, "first failure");
      recordFailure(backendDb, "second failure");
      let attempts = 0;
      const sendAlert = mock(async () => {
        attempts += 1;
        expect(
          backendDb.db
            .select()
            .from(publicationEvents)
            .all()
            .filter((event) => event.ackedAt != null),
        ).toHaveLength(attempts);
        if (attempts === 1) throw new Error("ambiguous Telegram response");
      });

      expect(await deliverPendingAlerts(backendDb, { sendAlert })).toBe(1);
      expect(sendAlert).toHaveBeenCalledTimes(2);
      expect(await deliverPendingAlerts(backendDb, { sendAlert })).toBe(0);
      expect(sendAlert).toHaveBeenCalledTimes(2);
    }));

  it("reports a stale queue lock exactly once", () =>
    withHarness(async ({ backendDb, config }) => {
      const now = new Date().toISOString();
      backendDb.db
        .insert(publishJobs)
        .values({
          publicationKey: "post:stale",
          target: "threads_ru",
          status: "publishing",
          lockedAt: "2000-01-01T00:00:00.000Z",
          payloadJson: {},
          createdAt: now,
          updatedAt: now,
        })
        .run();
      await runObservabilityCycle(config, backendDb);
      expect(countEvents(backendDb, "queue.stale")).toBe(1);
      await runObservabilityCycle(config, backendDb);
      expect(countEvents(backendDb, "queue.stale")).toBe(1);
    }));

  it("reports a failed site build", () =>
    withHarness(async ({ backendDb, config }) => {
      const now = new Date().toISOString();
      backendDb.db
        .insert(siteJobs)
        .values({
          publicationKey: "post:7",
          messageId: 7,
          reason: "site_ru",
          status: "failed",
          lastError: "Astro build failed",
          createdAt: now,
          updatedAt: now,
        })
        .run();
      await runObservabilityCycle(config, backendDb);
      expect(countEvents(backendDb, "site.build.failed")).toBe(1);
    }));

  it("does not re-alert on a terminal social job that already reported at its transition", () =>
    withHarness(async ({ backendDb, config }) => {
      // A terminal social job emits publish.job.failed at its state transition.
      // Observability must not generate a fresh target.failed alert every hour.
      const now = new Date().toISOString();
      backendDb.db
        .insert(publishJobs)
        .values({
          publicationKey: "post:terminal",
          target: "telegram_stories",
          status: "failed",
          lastError: "MEDIA_FILE_INVALID",
          payloadJson: {},
          createdAt: now,
          updatedAt: now,
        })
        .run();
      await runObservabilityCycle(config, backendDb);
      await runObservabilityCycle(config, backendDb);
      expect(countEvents(backendDb, "target.failed")).toBe(0);
    }));
});

function seedPreviousBoot(backendDb: ReturnType<typeof openBackendDb>, restartsAt: string[], revision: string | null = null): void {
  const now = new Date().toISOString();
  const stateJson = { bootId: "previous-process", bootedAt: new Date(Date.now() - 60_000).toISOString(), revision, restartsAt };
  backendDb.db
    .insert(workerState)
    .values({ name: "runtime", stateJson, updatedAt: now })
    .onConflictDoUpdate({ target: workerState.name, set: { stateJson, updatedAt: now } })
    .run();
}

describe("runtime health", () => {
  it("adopts the runtime identity silently on a fresh database", () =>
    withHarness(async ({ backendDb, config }) => {
      await runObservabilityCycle(config, backendDb);
      expect(countEvents(backendDb, "runtime.restarted")).toBe(0);
      expect(backendDb.db.select().from(workerState).where(eq(workerState.name, "runtime")).get()).toBeTruthy();
    }));

  it("records a single restart as info so a deploy does not page the owner", () =>
    withHarness(async ({ backendDb, sendMessage, alertsPort, config }) => {
      seedPreviousBoot(backendDb, []);
      await runObservabilityCycle(config, backendDb, alertsPort);
      expect(countEvents(backendDb, "runtime.restarted")).toBe(1);
      // Alert delivery only picks up warn/error, so an ordinary restart must not
      // reach the transport.
      expect(sendMessage).not.toHaveBeenCalled();
    }));

  it("reports the same process only once across repeated cycles", () =>
    withHarness(async ({ backendDb, config }) => {
      seedPreviousBoot(backendDb, []);
      await runObservabilityCycle(config, backendDb);
      await runObservabilityCycle(config, backendDb);
      expect(countEvents(backendDb, "runtime.restarted")).toBe(1);
    }));

  it("escalates to an alert when restarts cluster inside the window", () =>
    withHarness(async ({ backendDb, sendMessage, alertsPort, config }) => {
      const recent = [new Date(Date.now() - 120_000).toISOString(), new Date(Date.now() - 60_000).toISOString()];
      seedPreviousBoot(backendDb, recent);
      await runObservabilityCycle(config, backendDb, alertsPort);
      expect(countEvents(backendDb, "runtime.restart.looping")).toBe(1);
      expect(sendMessage).toHaveBeenCalledTimes(1);
    }));

  // Three deployments inside half an hour is an afternoon of work. Production
  // raised this alert 26 times without the backend ever having crashed: the
  // window counted restarts, and every deployment is one.
  it("does not call a burst of deployments a crash loop", () =>
    withHarness(async ({ backendDb }) => {
      const recent = [new Date(Date.now() - 120_000).toISOString(), new Date(Date.now() - 60_000).toISOString()];
      seedPreviousBoot(backendDb, recent, "1111111");
      recordProcessRestart(backendDb, "2222222");
      expect(countEvents(backendDb, "runtime.restart.looping")).toBe(0);
      expect(countEvents(backendDb, "runtime.restarted")).toBe(1);
    }));

  // The same digest coming back three times is the crash loop the alert exists
  // for, and it has to survive the deployment exemption above.
  it("still alerts when one build keeps restarting", () =>
    withHarness(async ({ backendDb }) => {
      const recent = [new Date(Date.now() - 120_000).toISOString(), new Date(Date.now() - 60_000).toISOString()];
      seedPreviousBoot(backendDb, recent, "1111111");
      recordProcessRestart(backendDb, "1111111");
      expect(countEvents(backendDb, "runtime.restart.looping")).toBe(1);
    }));

  it("ignores restarts that fell out of the window", () =>
    withHarness(async ({ backendDb, config }) => {
      const stale = [new Date(Date.now() - 5 * 3600_000).toISOString(), new Date(Date.now() - 4 * 3600_000).toISOString()];
      seedPreviousBoot(backendDb, stale);
      await runObservabilityCycle(config, backendDb);
      expect(countEvents(backendDb, "runtime.restart.looping")).toBe(0);
      expect(countEvents(backendDb, "runtime.restarted")).toBe(1);
    }));

  it("warns once when rss crosses the container limit threshold", () =>
    withHarness(async ({ backendDb }) => {
      const tightLimit = Math.round(process.memoryUsage().rss / 0.99);
      expect(recordMemoryPressure(backendDb, tightLimit)).toBe(true);
      expect(recordMemoryPressure(backendDb, tightLimit)).toBe(false);
      expect(countEvents(backendDb, "runtime.memory.pressure")).toBe(1);
    }));

  it("stays quiet below the threshold and when no cgroup limit applies", () =>
    withHarness(async ({ backendDb }) => {
      expect(recordMemoryPressure(backendDb, process.memoryUsage().rss * 100)).toBe(false);
      expect(recordMemoryPressure(backendDb, null)).toBe(false);
      expect(countEvents(backendDb, "runtime.memory.pressure")).toBe(0);
    }));
});
