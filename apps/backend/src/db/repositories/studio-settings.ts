import { and, eq, like } from "drizzle-orm";
import type { StudioSettingsStore } from "../../application/ports.js";
import {
  botUiSettings,
  studioBackupSettings,
  studioMilestoneSettings,
  studioNewsDigestSettings,
  studioNotificationJobs,
  studioNotificationSettings,
  studioProfile,
  studioWeeklyDigestSettings,
  studioYoutubeSettings,
} from "../schema.js";
import type { BackendDatabase } from "../types.js";

/** SQLite adapter for owner and Studio-wide settings. */
export function createStudioSettingsStore(db: BackendDatabase): StudioSettingsStore {
  return {
    profile() {
      const row = db.select().from(studioProfile).where(eq(studioProfile.id, 1)).get();
      // The migration inserts row 1, so a missing row means the file was
      // hand-edited or restored from a partial copy. Failing here is better
      // than silently serving someone a Studio with no identity.
      if (!row) throw new Error("studio_profile row 1 is missing; restore the database or re-run migrations");
      return row;
    },

    saveProfile(input) {
      db.update(studioProfile).set(input).where(eq(studioProfile.id, 1)).run();
    },

    notifications(actorId) {
      return db.select().from(studioNotificationSettings).where(eq(studioNotificationSettings.actorId, actorId)).get() ?? null;
    },

    locale(actorId) {
      return db.select({ value: botUiSettings.locale }).from(botUiSettings).where(eq(botUiSettings.actorId, actorId)).get()?.value ?? null;
    },

    timezone(actorId) {
      return (
        db.select({ value: botUiSettings.timezone }).from(botUiSettings).where(eq(botUiSettings.actorId, actorId)).get()?.value ?? null
      );
    },

    weeklyDigest() {
      return db.select().from(studioWeeklyDigestSettings).where(eq(studioWeeklyDigestSettings.id, 1)).get() ?? null;
    },

    backup() {
      return db.select().from(studioBackupSettings).where(eq(studioBackupSettings.id, 1)).get() ?? null;
    },

    newsDigest() {
      return db.select().from(studioNewsDigestSettings).where(eq(studioNewsDigestSettings.id, 1)).get() ?? null;
    },

    milestones() {
      return db.select().from(studioMilestoneSettings).where(eq(studioMilestoneSettings.id, 1)).get() ?? null;
    },

    saveMilestones(input) {
      db.insert(studioMilestoneSettings)
        .values({ id: 1, ...input })
        .onConflictDoUpdate({ target: studioMilestoneSettings.id, set: input })
        .run();
    },

    saveWeeklyDigest(input) {
      db.insert(studioWeeklyDigestSettings)
        .values({ id: 1, enabled: input.enabled, weekday: input.weekday, updatedAt: input.updatedAt })
        .onConflictDoUpdate({
          target: studioWeeklyDigestSettings.id,
          set: { enabled: input.enabled, weekday: input.weekday, updatedAt: input.updatedAt },
        })
        .run();
    },

    saveBackup(input) {
      db.insert(studioBackupSettings)
        .values({ id: 1, enabled: input.enabled, updatedAt: input.updatedAt })
        .onConflictDoUpdate({ target: studioBackupSettings.id, set: { enabled: input.enabled, updatedAt: input.updatedAt } })
        .run();
    },

    saveNewsDigest(input) {
      db.insert(studioNewsDigestSettings)
        .values({
          id: 1,
          enabled: input.enabled,
          hour: input.hour,
          minute: input.minute,
          prompt: input.prompt,
          effort: input.effort,
          updatedAt: input.updatedAt,
        })
        .onConflictDoUpdate({
          target: studioNewsDigestSettings.id,
          set: {
            enabled: input.enabled,
            hour: input.hour,
            minute: input.minute,
            prompt: input.prompt,
            effort: input.effort,
            updatedAt: input.updatedAt,
          },
        })
        .run();
    },

    saveNotifications(input) {
      db.insert(studioNotificationSettings)
        .values(input)
        .onConflictDoUpdate({
          target: studioNotificationSettings.actorId,
          set: {
            videoRemindersEnabled: input.videoRemindersEnabled,
            postRemindersEnabled: input.postRemindersEnabled,
            reminderMinutes: input.reminderMinutes,
            completionEnabled: input.completionEnabled,
            updatedAt: input.updatedAt,
          },
        })
        .run();
    },

    cancelQueuedReminders(actorId, publicationKind, now) {
      return db
        .update(studioNotificationJobs)
        .set({ status: "cancelled", updatedAt: now })
        .where(
          and(
            eq(studioNotificationJobs.actorId, actorId),
            eq(studioNotificationJobs.status, "queued"),
            like(studioNotificationJobs.kind, `${publicationKind}.%`),
          ),
        )
        .returning({ id: studioNotificationJobs.id })
        .all().length;
    },

    youtubeSettings() {
      return db.select().from(studioYoutubeSettings).where(eq(studioYoutubeSettings.id, 1)).get() ?? null;
    },

    saveYoutubeSettings(input) {
      db.insert(studioYoutubeSettings)
        .values({ id: 1, signature: input.signature, updatedAt: input.updatedAt })
        .onConflictDoUpdate({
          target: studioYoutubeSettings.id,
          set: { signature: input.signature, updatedAt: input.updatedAt },
        })
        .run();
    },

    saveLocale(input) {
      db.insert(botUiSettings)
        .values(input)
        .onConflictDoUpdate({
          target: botUiSettings.actorId,
          set: { locale: input.locale, updatedAt: input.updatedAt },
        })
        .run();
    },

    saveTimezone(input) {
      db.insert(botUiSettings)
        .values(input)
        .onConflictDoUpdate({
          target: botUiSettings.actorId,
          set: { timezone: input.timezone, updatedAt: input.updatedAt },
        })
        .run();
    },
  };
}
