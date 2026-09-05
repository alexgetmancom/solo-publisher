import type { ApplicationPorts, StudioProfileRecord, StudioSocialProfile } from "./application/ports.js";
import { targetsFor } from "./botTargets.js";

/**
 * A Studio nobody has configured yet: UTC, no public site, and an identity it
 * does not claim. The single source of these values — the table's column
 * defaults and the in-memory profile tests run against both read it, so a fresh
 * install and a fresh test agree by construction. Shipping anything else here
 * would put one person's name, biography and accounts into every install.
 */
export const DEFAULT_STUDIO_PROFILE = {
  timezone: "UTC",
  timezoneLabel: "UTC",
  siteEnabled: 0,
  videoPrepareLeadMinutes: 15,
  videoRetentionHours: 24,
  nameJson: { en: "", ru: "" },
  taglineJson: { en: "", ru: "" },
  aboutJson: { en: "", ru: "" },
  bioJson: { en: "", ru: "" },
  profilesJson: { en: [], ru: [] },
  // X and Discord are published by hand, so a fresh install starts without
  // them; every other target is on until an operator says otherwise.
  defaultTargetsJson: targetsFor("post")
    .filter(({ id }) => id !== "x" && id !== "discord")
    .map(({ id }) => String(id)),
} as const satisfies Omit<StudioProfileRecord, "id" | "updatedAt">;

/** The follower counts a Studio announces by default. An operator narrows or
 * extends the ladder in settings; this is what a fresh install starts from. */
export const DEFAULT_MILESTONE_THRESHOLDS = [
  100, 250, 500, 1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000, 9000, 10_000,
] as const satisfies readonly number[];

export type StudioConfig = {
  timezone: string;
  timezoneLabel: string;
  siteEnabled: boolean;
  /** What this Studio says it is, resolved per language. */
  site: (locale: "en" | "ru") => { name: string; tagline: string; about: string; bio: string; profiles: StudioSocialProfile[] };
  video: { prepare_lead_minutes: number; retention_hours: number };
};

/**
 * The Studio's own settings, read from the database on every access rather than
 * captured at boot: an operator who changes the time zone or turns the public
 * site on expects the next request to reflect it, not the next deploy. Each read
 * is a single indexed row from a local SQLite file, so this is cheaper than the
 * cache invalidation it replaces.
 */
export function studioConfig(ports: Pick<ApplicationPorts, "studioSettings">): StudioConfig {
  const read = () => ports.studioSettings.profile();
  return {
    get timezone() {
      return read().timezone;
    },
    get timezoneLabel() {
      return read().timezoneLabel;
    },
    get siteEnabled() {
      return read().siteEnabled !== 0;
    },
    site: (locale) => {
      const row = read();
      return {
        name: row.nameJson[locale],
        tagline: row.taglineJson[locale],
        about: row.aboutJson[locale],
        bio: row.bioJson[locale],
        profiles: row.profilesJson[locale],
      };
    },
    get video() {
      const row = read();
      return {
        prepare_lead_minutes: row.videoPrepareLeadMinutes,
        retention_hours: row.videoRetentionHours,
      };
    },
  };
}
