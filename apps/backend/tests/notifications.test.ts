import { describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import type { UnsafeBackendDb } from "../src/db/client.js";
import { publicationEvents, studioNotificationJobs } from "../src/db/schema.js";
import { cancelScheduledNotifications, runNotificationCycle, scheduleReminder } from "../src/notifications/jobs.js";
import { postService } from "../src/studio/services/posts.js";
import { settingsService } from "../src/studio/services/settings.js";
import { registerTestChannels, TEXT_TEST_CHANNELS, VIDEO_TEST_CHANNELS } from "./helpers/channels.js";
import { withOpenDb } from "./helpers/db.js";
import { openBackendDb } from "./helpers/open-db.js";
import { loadTestConfig } from "./helpers/studio-config.js";
import { createTestVideoDraft } from "./helpers/video.js";

function openNotificationDb() {
  const memory = ":memory:";
  const backendDb = openBackendDb(memory);
  registerTestChannels(backendDb, [...TEXT_TEST_CHANNELS, ...VIDEO_TEST_CHANNELS]);
  return backendDb;
}

const withNotificationDb = <T>(fn: (backendDb: UnsafeBackendDb) => T | Promise<T>): Promise<T> => withOpenDb(openNotificationDb, fn);

describe("Studio notifications", () => {
  it("creates durable interface-neutral reminders and honours cancellation", () =>
    withNotificationDb(async (backendDb) => {
      const videoId = createTestVideoDraft(backendDb, 42, "owner-video", 24);
      scheduleReminder(backendDb, {
        actorId: 42,
        ref: `video:${videoId}`,
        kind: "video.youtube_shorts",
        publishAt: new Date(Date.now() + 30_000),
        title: "Launch",
        targets: ["youtube_shorts"],
        reminders: { enabled: true, minutes: 5 },
      });
      expect(runNotificationCycle(backendDb)).toBe(1);
      expect(
        backendDb.db.select().from(publicationEvents).where(eq(publicationEvents.eventType, "studio.notification.reminder.due")).get(),
      ).toBeDefined();

      scheduleReminder(backendDb, {
        actorId: 42,
        ref: `video:${videoId}`,
        kind: "video.instagram_reels",
        publishAt: new Date(Date.now() + 60 * 60_000),
        title: "Launch",
        targets: ["instagram_reels"],
        reminders: { enabled: true, minutes: 5 },
      });
      cancelScheduledNotifications(backendDb, `video:${videoId}`);
      expect(runNotificationCycle(backendDb)).toBe(0);
    }));

  it("does not remind about a publication that is already due", () =>
    withNotificationDb(async (backendDb) => {
      scheduleReminder(backendDb, {
        actorId: 42,
        ref: "post:1",
        kind: "post.en",
        publishAt: new Date(Date.now() - 1_000),
        title: "Immediate publication",
        targets: ["threads_en"],
        reminders: { enabled: true, minutes: 5 },
      });

      expect(backendDb.db.select().from(studioNotificationJobs).all()).toHaveLength(0);
    }));

  it("uses the owner's stored reminder interval when scheduling a post", () =>
    withNotificationDb(async (backendDb) => {
      const config = loadTestConfig({ CONTROLLER_ADMIN_IDS: "42" });
      settingsService(backendDb).setNotifications(42, { reminderMinutes: 17 });
      const posts = postService(backendDb, config);
      const draftId = posts.create(42, { text: "Scheduled", textEn: "Scheduled", entities: [], media: [] });
      const postId = posts.schedule(42, draftId, { ruAt: new Date(Date.now() + 60 * 60_000), enAt: null });
      const job = backendDb.db
        .select()
        .from(studioNotificationJobs)
        .where(eq(studioNotificationJobs.ref, `post:${postId}`))
        .get();
      expect(job?.payloadJson).toMatchObject({ minutes: 17 });

      // Text reminders off leaves video reminders alone, so scheduling a post
      // queues nothing at all.
      settingsService(backendDb).setNotifications(42, { postRemindersEnabled: false });
      const secondDraftId = posts.create(42, { text: "Quiet", textEn: "Quiet", entities: [], media: [] });
      const secondPostId = posts.schedule(42, secondDraftId, { ruAt: new Date(Date.now() + 60 * 60_000), enAt: null });
      expect(
        backendDb.db
          .select()
          .from(studioNotificationJobs)
          .where(eq(studioNotificationJobs.ref, `post:${secondPostId}`))
          .all(),
      ).toHaveLength(0);
    }));

  it("cancels queued reminders when the owner disables reminders", () =>
    withNotificationDb(async (backendDb) => {
      const videoId = createTestVideoDraft(backendDb, 42, "owner-video", 24);
      scheduleReminder(backendDb, {
        actorId: 42,
        ref: `video:${videoId}`,
        kind: "video.youtube_shorts",
        publishAt: new Date(Date.now() + 60 * 60_000),
        title: "Launch",
        targets: ["youtube_shorts"],
        reminders: { enabled: true, minutes: 5 },
      });

      settingsService(backendDb).setNotifications(42, { videoRemindersEnabled: false });

      expect(backendDb.db.select({ status: studioNotificationJobs.status }).from(studioNotificationJobs).all()).toEqual([
        { status: "cancelled" },
      ]);
    }));

  it("keeps text reminders when video reminders are switched off", () =>
    withNotificationDb(async (backendDb) => {
      scheduleReminder(backendDb, {
        actorId: 42,
        ref: "post:7",
        kind: "post.ru",
        publishAt: new Date(Date.now() + 60 * 60_000),
        title: "Scheduled",
        targets: ["telegram"],
        reminders: { enabled: true, minutes: 5 },
      });

      settingsService(backendDb).setNotifications(42, { videoRemindersEnabled: false });

      expect(backendDb.db.select({ status: studioNotificationJobs.status }).from(studioNotificationJobs).all()).toEqual([
        { status: "queued" },
      ]);

      // The reverse switch settles the other half: one flag never reaches the
      // other kind's queue.
      settingsService(backendDb).setNotifications(42, { postRemindersEnabled: false });

      expect(backendDb.db.select({ status: studioNotificationJobs.status }).from(studioNotificationJobs).all()).toEqual([
        { status: "cancelled" },
      ]);
    }));
});
