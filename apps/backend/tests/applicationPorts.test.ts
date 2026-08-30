import { describe, expect, it } from "bun:test";
import type { ApplicationPorts } from "../src/application/ports.js";
import { settingsService } from "../src/studio/services/settings.js";
import { DEFAULT_STUDIO_PROFILE } from "../src/studio.js";

describe("application persistence ports", () => {
  it("runs the settings service without SQLite", () => {
    let weeklyDigest: Parameters<ApplicationPorts["studioSettings"]["saveWeeklyDigest"]>[0] | undefined;
    let newsDigest: Parameters<ApplicationPorts["studioSettings"]["saveNewsDigest"]>[0] | undefined;
    let notifications: Parameters<ApplicationPorts["studioSettings"]["saveNotifications"]>[0] | undefined;
    let timezone: Parameters<ApplicationPorts["studioSettings"]["saveTimezone"]>[0] | undefined;
    let milestones: Parameters<ApplicationPorts["studioSettings"]["saveMilestones"]>[0] | undefined;
    let currentTimezone: string | null = null;
    const ports: Pick<ApplicationPorts, "clock" | "studioSettings"> = {
      clock: { now: () => new Date("2026-01-02T03:04:05.000Z") },
      studioSettings: {
        profile: () => ({ id: 1, ...DEFAULT_STUDIO_PROFILE, updatedAt: "1970-01-01T00:00:00.000Z" }),
        saveProfile: () => {},
        notifications: () => null,
        locale: () => null,
        timezone: () => currentTimezone,
        weeklyDigest: () => null,
        backup: () => null,
        saveBackup: () => {},
        saveWeeklyDigest: (input) => {
          weeklyDigest = input;
        },
        newsDigest: () => null,
        milestones: () => null,
        saveMilestones: (input) => {
          milestones = input;
        },
        saveNewsDigest: (input) => {
          newsDigest = input;
        },
        saveNotifications: (input) => {
          notifications = input;
        },
        cancelQueuedReminders: () => 0,
        youtubeSettings: () => null,
        saveYoutubeSettings: () => {},
        saveLocale: () => {},
        saveTimezone: (input) => {
          timezone = input;
          currentTimezone = input.timezone;
        },
      },
    };

    const settings = settingsService(ports);

    expect(settings.locale(42)).toBe("en");
    expect(settings.timezone(42, "Europe/Moscow")).toBe("Europe/Moscow");
    settings.setTimezone(42, "America/New_York");
    expect(timezone).toEqual({ timezone: "America/New_York", actorId: 42, updatedAt: "2026-01-02T03:04:05.000Z" });
    expect(settings.timezone(42, "Europe/Moscow")).toBe("America/New_York");
    expect(settings.setWeeklyDigest({ enabled: true, weekday: 2 })).toEqual({ enabled: true, weekday: 2 });
    expect(weeklyDigest).toEqual({ enabled: 1, weekday: 2, updatedAt: "2026-01-02T03:04:05.000Z" });
    expect(settings.setNewsDigest({ enabled: true, hour: 8, minute: 30, prompt: "news", effort: "high" })).toEqual({
      enabled: true,
      hour: 8,
      minute: 30,
      prompt: "news",
      effort: "high",
    });
    expect(newsDigest).toEqual({
      enabled: 1,
      hour: 8,
      minute: 30,
      prompt: "news",
      effort: "high",
      updatedAt: "2026-01-02T03:04:05.000Z",
    });
    expect(settings.setNotifications(42, { videoRemindersEnabled: false, reminderMinutes: 15 })).toEqual({
      videoRemindersEnabled: false,
      postRemindersEnabled: true,
      reminderMinutes: 15,
      completionEnabled: true,
    });
    expect(notifications).toEqual({
      actorId: 42,
      videoRemindersEnabled: 0,
      postRemindersEnabled: 1,
      reminderMinutes: 15,
      completionEnabled: 1,
      updatedAt: "2026-01-02T03:04:05.000Z",
    });
    expect(settings.setMilestones({ projectEnabled: false, thresholds: [500, 100, 500] })).toEqual({
      channelEnabled: true,
      groupLocaleEnabled: true,
      localeEnabled: true,
      projectEnabled: false,
      thresholds: [100, 500],
    });
    expect(milestones).toEqual({
      channelEnabled: 1,
      groupLocaleEnabled: 1,
      localeEnabled: 1,
      projectEnabled: 0,
      thresholdsJson: [100, 500],
      updatedAt: "2026-01-02T03:04:05.000Z",
    });
  });
});
