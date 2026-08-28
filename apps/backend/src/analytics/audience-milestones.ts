import { eq } from "drizzle-orm";
import { type ChannelConnection, listChannels } from "../channels/registry.js";
import { type BackendDb, unsafeDb } from "../db/client.js";
import { analyticsRollups, creatorProfiles } from "../db/schema.js";
import { type AudienceGroup, audienceConnectionIdentity, audienceGroup, uniqueAudienceConnections } from "./audience-groups.js";
import { type MilestoneSettings, milestonePolicy } from "./milestone-policy.js";
import { metricNumber } from "./snapshots/creator-store.js";

const ROLLUP_PREFIX = "audience_milestone:";

type AudienceEntry = {
  id: string;
  identity: string;
  label: string;
  locale: "ru" | "en";
  group: AudienceGroup;
  followers: number;
};

type MilestoneScope = {
  id: string;
  label: string;
  icon: string;
  target: string;
  announce: boolean;
  entries: AudienceEntry[];
};

/** What a scope has already been credited with. `reachedThrough` is the highest
 * follower count it is done announcing — recomputed from the audience whenever
 * the scope's membership changes, never accumulated. An earlier design kept
 * one `alert_dedup` row per crossed threshold, and those rows only ever
 * appeared: a scope inflated for an hour by an account counted twice marked
 * 1000 as done, and the real 1000, weeks later, was silently swallowed. */
type MilestoneState = { followers: number; members: string[]; reachedThrough: number };

/** Evaluates milestones only after every collector in the cycle has had its
 * turn. A channel without durable state is baseline data: its current audience
 * is included in totals, but cannot generate catch-up notifications. */
export function evaluateAudienceMilestones(backendDb: BackendDb): number {
  const settings = milestonePolicy(backendDb);
  const scopes = buildScopes(audienceEntries(backendDb), settings);
  let emitted = 0;
  for (const scope of scopes) emitted += evaluateScope(backendDb, settings, scope);
  return emitted;
}

/** Every scope this Studio's audience currently forms. The one catalogue behind
 * evaluation, the operator's view and a hand-announced achievement. */
export function milestoneScopes(backendDb: BackendDb): MilestoneScope[] {
  return buildScopes(audienceEntries(backendDb), milestonePolicy(backendDb));
}

/** Records the achievement a scope is owed and credits it, for a threshold the
 * Studio passed while it was not being watched. */
export function announceAudienceMilestone(backendDb: BackendDb, scopeId: string, threshold: number): boolean {
  const scope = milestoneScopes(backendDb).find((candidate) => candidate.id === scopeId);
  if (!scope) return false;
  const stored = readState(backendDb, scope.id);
  recordMilestone(backendDb, scope, threshold);
  writeState(backendDb, scope.id, {
    followers: scopeFollowers(scope),
    members: scopeMembers(scope),
    reachedThrough: Math.max(threshold, stored?.reachedThrough ?? 0),
  });
  return true;
}

function buildScopes(entries: AudienceEntry[], settings: MilestoneSettings): MilestoneScope[] {
  const scopes: MilestoneScope[] = [
    ...entries.map((entry) => ({
      id: `channel:${entry.id}`,
      label: entry.label,
      icon: "🎉",
      target: entry.id,
      announce: settings.channelEnabled,
      entries: [entry],
    })),
    ...(["text", "video"] as const).flatMap((group) =>
      (["ru", "en"] as const).map((locale) => ({
        id: `group_locale:${group}:${locale}`,
        label: `${localeIcon(locale)} ${group === "text" ? "Текстовые" : "Видео"} ${locale.toUpperCase()}-каналы`,
        icon: "🏆",
        target: "audience",
        announce: settings.groupLocaleEnabled,
        entries: entries.filter((entry) => entry.group === group && entry.locale === locale),
      })),
    ),
    ...(["ru", "en"] as const).map((locale) => ({
      id: `locale:${locale}`,
      label: `${localeIcon(locale)} Все ${locale.toUpperCase()}-каналы`,
      icon: "🏆",
      target: "audience",
      announce: settings.localeEnabled,
      entries: entries.filter((entry) => entry.locale === locale),
    })),
    { id: "project", label: "Все площадки", icon: "🏆", target: "audience", announce: settings.projectEnabled, entries },
  ];
  return scopes.filter((scope) => scope.entries.length > 0);
}

function audienceEntries(backendDb: BackendDb): AudienceEntry[] {
  const profiles = new Map(
    unsafeDb(backendDb)
      .db.select()
      .from(creatorProfiles)
      .all()
      .map((profile) => [profile.platform, profile]),
  );
  const seen = new Set<string>();
  return uniqueAudienceConnections(listChannels(backendDb)).flatMap((connection) => {
    const group = audienceGroup(connection.platform) ?? audienceGroup(connection.id);
    const profile = profiles.get(connection.id) ?? profiles.get(connection.platform);
    if (!group || !profile || seen.has(connection.id)) return [];
    seen.add(connection.id);
    return [
      {
        id: connection.id,
        identity: audienceConnectionIdentity(connection),
        label: displayLabel(connection),
        locale: connection.locale === "en" ? "en" : "ru",
        group,
        followers: followerCount(profile.dataJson),
      },
    ];
  });
}

function evaluateScope(backendDb: BackendDb, settings: MilestoneSettings, scope: MilestoneScope): number {
  const current = scopeFollowers(scope);
  const members = scopeMembers(scope);
  const stored = readState(backendDb, scope.id);
  // Connecting, removing or replacing an account is not audience growth. A
  // membership change establishes a new baseline for every affected scope, and
  // credits it with everything that baseline already covers — including when
  // the change makes the scope smaller, so a departing account withdraws the
  // thresholds it alone was holding up.
  if (!stored || !sameMembers(stored.members, members)) {
    writeState(backendDb, scope.id, { followers: current, members, reachedThrough: current });
    return 0;
  }
  // One announcement per crossing, naming the highest threshold passed. Several
  // at once is an import or a reconnection catching up, and a burst of them
  // reads as noise where the largest number is the news.
  const crossed = settings.thresholds.filter((threshold) => threshold > stored.reachedThrough && threshold <= current);
  const reached = crossed.at(-1);
  const announced = reached != null && scope.announce ? recordMilestone(backendDb, scope, reached) : false;
  writeState(backendDb, scope.id, { followers: current, members, reachedThrough: Math.max(stored.reachedThrough, reached ?? 0) });
  return announced ? 1 : 0;
}

function recordMilestone(backendDb: BackendDb, scope: MilestoneScope, threshold: number): boolean {
  return backendDb.events.record({
    type: "analytics.milestone.reached",
    severity: "info",
    target: scope.target,
    message: `${scope.icon} ${scope.label}: ${threshold} подписчиков!`,
    details: { scope: scope.id, threshold },
  });
}

function scopeFollowers(scope: MilestoneScope): number {
  return scope.entries.reduce((sum, entry) => sum + entry.followers, 0);
}

function scopeMembers(scope: MilestoneScope): string[] {
  return scope.entries.map((entry) => entry.identity).sort();
}

/** What a scope has been credited with, for an operator's report. */
export function milestoneState(backendDb: BackendDb, scope: string): MilestoneState | null {
  return readState(backendDb, scope);
}

function readState(backendDb: BackendDb, scope: string): MilestoneState | null {
  const row = unsafeDb(backendDb)
    .db.select({ metricJson: analyticsRollups.metricJson })
    .from(analyticsRollups)
    .where(eq(analyticsRollups.rollupKey, `${ROLLUP_PREFIX}${scope}`))
    .get();
  if (!row) return null;
  try {
    const value = JSON.parse(row.metricJson) as { followers?: unknown; members?: unknown; reachedThrough?: unknown };
    return {
      followers: metricNumber(value.followers),
      members: Array.isArray(value.members) ? value.members.filter((member): member is string => typeof member === "string").sort() : [],
      reachedThrough: metricNumber(value.reachedThrough),
    };
  } catch {
    return null;
  }
}

function writeState(backendDb: BackendDb, scope: string, state: MilestoneState): void {
  const now = new Date().toISOString();
  const metricJson = JSON.stringify(state);
  unsafeDb(backendDb)
    .db.insert(analyticsRollups)
    .values({ rollupKey: `${ROLLUP_PREFIX}${scope}`, scope: "audience_milestone", subject: scope, metricJson, updatedAt: now })
    .onConflictDoUpdate({ target: analyticsRollups.rollupKey, set: { metricJson, updatedAt: now } })
    .run();
}

function sameMembers(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((member, index) => member === right[index]);
}

function followerCount(data: Record<string, unknown>): number {
  return metricNumber(data.subscriberCount ?? data.followersCount);
}

function displayLabel(connection: Pick<ChannelConnection, "label" | "platform" | "locale">): string {
  if (connection.label.trim()) return connection.label;
  const platform =
    connection.platform === "youtube"
      ? "YouTube"
      : connection.platform === "instagram"
        ? "Instagram"
        : connection.platform === "telegram"
          ? "Telegram"
          : connection.platform === "threads" || connection.platform === "threads_en"
            ? "Threads"
            : connection.platform === "x"
              ? "X"
              : connection.platform;
  return `${platform} ${connection.locale.toUpperCase()}`;
}

function localeIcon(locale: "ru" | "en"): string {
  return locale === "ru" ? "🇷🇺" : "🇬🇧";
}
