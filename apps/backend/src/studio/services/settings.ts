import { milestonePolicy, normalizeMilestoneThresholds } from "../../analytics/milestone-policy.js";
import type { ApplicationPorts, LocalizedProfiles, LocalizedText } from "../../application/ports.js";
import { isKnownTarget, targetsRecord } from "../../botTargets.js";
import { fixUrlSlashes } from "../../content/message.js";
import type { BackendConfig } from "../../foundation/config.js";
import { StudioError } from "../../foundation/errors.js";
import { parseStudioLocale, type StudioLocale } from "../../foundation/locale.js";
import { isValidTimeZone, timeZoneOffsetLabel } from "../../foundation/time.js";

type SettingsDependencies = Pick<ApplicationPorts, "clock" | "studioSettings">;

/** Read as a plain function, not a method: the service is an object literal, so
 * a method reading it through `this` breaks the moment it is destructured. */
function readNotifications(backendDb: SettingsDependencies, actorId: number) {
  const row = backendDb.studioSettings.notifications(actorId);
  return {
    videoRemindersEnabled: row?.videoRemindersEnabled !== 0,
    postRemindersEnabled: row?.postRemindersEnabled !== 0,
    reminderMinutes: row?.reminderMinutes ?? 5,
    completionEnabled: row?.completionEnabled !== 0,
  };
}

function readLocale(backendDb: SettingsDependencies, actorId: number): StudioLocale {
  // English for an owner who never chose: the stored value is the only signal,
  // and an unset one predates the picker.
  return parseStudioLocale(backendDb.studioSettings.locale(actorId), "en");
}

function readTimezone(backendDb: SettingsDependencies, actorId: number, fallback: string): string {
  const timezone = backendDb.studioSettings.timezone(actorId)?.trim();
  return timezone && isValidTimeZone(timezone) ? timezone : fallback;
}

function writeYoutubeSignature(backendDb: SettingsDependencies, value: string): void {
  backendDb.studioSettings.saveYoutubeSettings({
    signature: value === "-" ? "" : fixUrlSlashes(value),
    updatedAt: backendDb.clock.now().toISOString(),
  });
}

function readWeeklyDigest(backendDb: SettingsDependencies) {
  const row = backendDb.studioSettings.weeklyDigest();
  return { enabled: row?.enabled !== 0, weekday: row?.weekday ?? 0 };
}

/** Absent means enabled: a Studio that has never opened settings still gets a
 * copy of its database, which is the case the backup exists for. */
function readBackup(backendDb: SettingsDependencies) {
  return { enabled: backendDb.studioSettings.backup()?.enabled !== 0 };
}

/** How hard Grok thinks. The CLI's own scale, narrowed to what this Studio has
 * a reason to pick between. */
export const NEWS_DIGEST_EFFORTS = ["low", "medium", "high", "xhigh"] as const;
export type NewsDigestEffort = (typeof NEWS_DIGEST_EFFORTS)[number];

function parseEffort(value: string | undefined): NewsDigestEffort {
  return NEWS_DIGEST_EFFORTS.includes(value as NewsDigestEffort) ? (value as NewsDigestEffort) : "xhigh";
}

function readNewsDigest(backendDb: SettingsDependencies) {
  const row = backendDb.studioSettings.newsDigest();
  return {
    enabled: row?.enabled === 1,
    hour: row?.hour ?? 10,
    minute: row?.minute ?? 0,
    prompt: row?.prompt?.trim() ?? "",
    effort: parseEffort(row?.effort),
  };
}

/** What this Studio is and how its deployment behaves, as an operator sees it. */
function readProfile(backendDb: SettingsDependencies) {
  const row = backendDb.studioSettings.profile();
  return {
    timezone: row.timezone,
    timezoneLabel: row.timezoneLabel,
    siteEnabled: row.siteEnabled !== 0,
    // The platforms the bot's default-targets screen has ticked. They decide
    // what every new draft goes to and what preparation is worth doing, and
    // until now no read-only command could show them.
    defaultTargets: row.defaultTargetsJson,
    video: {
      prepareLeadMinutes: row.videoPrepareLeadMinutes,
      retentionHours: row.videoRetentionHours,
    },
    name: row.nameJson,
    tagline: row.taglineJson,
    about: row.aboutJson,
    profiles: row.profilesJson,
  };
}

export type StudioProfileInput = {
  timezone?: string | undefined;
  timezoneLabel?: string | undefined;
  siteEnabled?: boolean | undefined;
  prepareLeadMinutes?: number | undefined;
  retentionHours?: number | undefined;
  name?: LocalizedText | undefined;
  tagline?: LocalizedText | undefined;
  about?: LocalizedText | undefined;
  profiles?: LocalizedProfiles | undefined;
};

/** Owner settings commands used by Telegram today and any future Studio adapter. */
export function settingsService(backendDb: SettingsDependencies) {
  return {
    studioProfile() {
      return readProfile(backendDb);
    },
    setStudioProfile(input: StudioProfileInput) {
      if (input.timezone != null && !isValidTimeZone(input.timezone.trim())) throw new StudioError("err.timezone-invalid");
      if (
        input.prepareLeadMinutes != null &&
        (!Number.isInteger(input.prepareLeadMinutes) || input.prepareLeadMinutes < 1 || input.prepareLeadMinutes > 120)
      )
        throw new StudioError("err.video-prepare-lead-range");
      if (
        input.retentionHours != null &&
        (!Number.isInteger(input.retentionHours) || input.retentionHours < 24 || input.retentionHours > 720)
      )
        throw new StudioError("err.video-retention-range");
      backendDb.studioSettings.saveProfile({
        ...(input.timezone != null ? { timezone: input.timezone.trim() } : {}),
        ...(input.timezoneLabel != null ? { timezoneLabel: input.timezoneLabel.trim() } : {}),
        ...(input.siteEnabled != null ? { siteEnabled: Number(input.siteEnabled) } : {}),
        ...(input.prepareLeadMinutes != null ? { videoPrepareLeadMinutes: input.prepareLeadMinutes } : {}),
        ...(input.retentionHours != null ? { videoRetentionHours: input.retentionHours } : {}),
        ...(input.name != null ? { nameJson: input.name } : {}),
        ...(input.tagline != null ? { taglineJson: input.tagline } : {}),
        ...(input.about != null ? { aboutJson: input.about } : {}),
        ...(input.profiles != null ? { profilesJson: input.profiles } : {}),
        updatedAt: backendDb.clock.now().toISOString(),
      });
      return readProfile(backendDb);
    },
    locale(actorId: number): StudioLocale {
      return readLocale(backendDb, actorId);
    },
    timezone(actorId: number, fallback: string): string {
      return readTimezone(backendDb, actorId, fallback);
    },
    timeConfig(
      actorId: number,
      config: Pick<BackendConfig, "TIMEZONE" | "TIMEZONE_LABEL">,
    ): Pick<BackendConfig, "TIMEZONE" | "TIMEZONE_LABEL"> {
      const timezone = readTimezone(backendDb, actorId, config.TIMEZONE);
      return {
        TIMEZONE: timezone,
        TIMEZONE_LABEL:
          timezone === config.TIMEZONE ? config.TIMEZONE_LABEL : timeZoneOffsetLabel(timezone, readLocale(backendDb, actorId)),
      };
    },
    notifications(actorId: number) {
      return readNotifications(backendDb, actorId);
    },
    weeklyDigest() {
      return readWeeklyDigest(backendDb);
    },
    newsDigest() {
      return readNewsDigest(backendDb);
    },
    backup() {
      return readBackup(backendDb);
    },
    milestones() {
      return milestonePolicy(backendDb);
    },
    setMilestones(
      input: Partial<{ channelEnabled: boolean; groupLocaleEnabled: boolean; localeEnabled: boolean; projectEnabled: boolean }> & {
        thresholds?: number[];
      },
    ) {
      if (input.thresholds?.some((value) => !Number.isSafeInteger(value) || value < 1 || value > 100_000_000))
        throw new StudioError("err.milestone-threshold-range");
      const current = milestonePolicy(backendDb);
      const next = {
        channelEnabled: input.channelEnabled ?? current.channelEnabled,
        groupLocaleEnabled: input.groupLocaleEnabled ?? current.groupLocaleEnabled,
        localeEnabled: input.localeEnabled ?? current.localeEnabled,
        projectEnabled: input.projectEnabled ?? current.projectEnabled,
        thresholds: input.thresholds == null ? current.thresholds : normalizeMilestoneThresholds(input.thresholds),
      };
      backendDb.studioSettings.saveMilestones({
        channelEnabled: Number(next.channelEnabled),
        groupLocaleEnabled: Number(next.groupLocaleEnabled),
        localeEnabled: Number(next.localeEnabled),
        projectEnabled: Number(next.projectEnabled),
        thresholdsJson: next.thresholds,
        updatedAt: backendDb.clock.now().toISOString(),
      });
      return next;
    },
    setBackup(input: { enabled: boolean }) {
      backendDb.studioSettings.saveBackup({ enabled: Number(input.enabled), updatedAt: backendDb.clock.now().toISOString() });
      return { enabled: input.enabled };
    },
    setWeeklyDigest(input: Partial<{ enabled: boolean; weekday: number }>) {
      if (input.weekday != null && (!Number.isInteger(input.weekday) || input.weekday < 0 || input.weekday > 6))
        throw new StudioError("err.weekday-range");
      const current = readWeeklyDigest(backendDb);
      const next = { enabled: input.enabled ?? current.enabled, weekday: input.weekday ?? current.weekday };
      backendDb.studioSettings.saveWeeklyDigest({
        enabled: Number(next.enabled),
        weekday: next.weekday,
        updatedAt: backendDb.clock.now().toISOString(),
      });
      return next;
    },
    setNewsDigest(input: Partial<{ enabled: boolean; hour: number; minute: number; prompt: string; effort: NewsDigestEffort }>) {
      if (input.hour != null && (!Number.isInteger(input.hour) || input.hour < 0 || input.hour > 23))
        throw new StudioError("err.news-digest-hour-range");
      if (input.minute != null && (!Number.isInteger(input.minute) || input.minute < 0 || input.minute > 59))
        throw new StudioError("err.news-digest-minute-range");
      if (input.prompt != null && input.prompt.trim().length > 10_000) throw new StudioError("err.news-digest-prompt-length");
      if (input.effort != null && !NEWS_DIGEST_EFFORTS.includes(input.effort)) throw new StudioError("err.news-digest-effort-invalid");
      const current = readNewsDigest(backendDb);
      const next = {
        enabled: input.enabled ?? current.enabled,
        hour: input.hour ?? current.hour,
        minute: input.minute ?? current.minute,
        prompt: input.prompt == null ? current.prompt : input.prompt.trim(),
        effort: input.effort ?? current.effort,
      };
      backendDb.studioSettings.saveNewsDigest({
        enabled: Number(next.enabled),
        hour: next.hour,
        minute: next.minute,
        prompt: next.prompt,
        effort: next.effort,
        updatedAt: backendDb.clock.now().toISOString(),
      });
      return next;
    },
    setNotifications(
      actorId: number,
      input: Partial<{
        videoRemindersEnabled: boolean;
        postRemindersEnabled: boolean;
        reminderMinutes: number;
        completionEnabled: boolean;
      }>,
    ) {
      if (
        input.reminderMinutes != null &&
        (!Number.isInteger(input.reminderMinutes) || input.reminderMinutes < 1 || input.reminderMinutes > 60)
      )
        throw new StudioError("err.reminder-range");
      const current = readNotifications(backendDb, actorId);
      const now = backendDb.clock.now().toISOString();
      const next = {
        videoRemindersEnabled: input.videoRemindersEnabled ?? current.videoRemindersEnabled,
        postRemindersEnabled: input.postRemindersEnabled ?? current.postRemindersEnabled,
        reminderMinutes: input.reminderMinutes ?? current.reminderMinutes,
        completionEnabled: input.completionEnabled ?? current.completionEnabled,
      };
      backendDb.studioSettings.saveNotifications({
        actorId,
        videoRemindersEnabled: Number(next.videoRemindersEnabled),
        postRemindersEnabled: Number(next.postRemindersEnabled),
        reminderMinutes: next.reminderMinutes,
        completionEnabled: Number(next.completionEnabled),
        updatedAt: now,
      });
      if (current.videoRemindersEnabled && !next.videoRemindersEnabled)
        backendDb.studioSettings.cancelQueuedReminders(actorId, "video", now);
      if (current.postRemindersEnabled && !next.postRemindersEnabled) backendDb.studioSettings.cancelQueuedReminders(actorId, "post", now);
      return next;
    },
    youtubeSignature(): string {
      return backendDb.studioSettings.youtubeSettings()?.signature.trim() ?? "";
    },
    setYoutubeSignature(value: string): void {
      writeYoutubeSignature(backendDb, value);
    },
    clearYoutubeSignature(): void {
      writeYoutubeSignature(backendDb, "-");
    },
    /** The platforms a new draft starts with, as a full on/off record. */
    defaultTargets(): Record<string, boolean> {
      return targetsRecord(backendDb.studioSettings.profile().defaultTargetsJson);
    },
    toggleDefaultTarget(target: string): Record<string, boolean> {
      if (!isKnownTarget(target)) throw new StudioError("err.unknown-target");
      const current = targetsRecord(backendDb.studioSettings.profile().defaultTargetsJson);
      const next = { ...current, [target]: !current[target] };
      backendDb.studioSettings.saveProfile({
        defaultTargetsJson: Object.entries(next)
          .filter(([, enabled]) => enabled)
          .map(([id]) => id),
        updatedAt: backendDb.clock.now().toISOString(),
      });
      return next;
    },
    setLocale(actorId: number, locale: StudioLocale): void {
      backendDb.studioSettings.saveLocale({ actorId, locale, updatedAt: backendDb.clock.now().toISOString() });
    },
    setTimezone(actorId: number, timezone: string): void {
      const value = timezone.trim();
      if (!isValidTimeZone(value)) throw new StudioError("err.timezone-invalid");
      backendDb.studioSettings.saveTimezone({ actorId, timezone: value, updatedAt: backendDb.clock.now().toISOString() });
    },
  };
}
