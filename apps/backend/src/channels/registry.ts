import type { ChannelConnectionRecord } from "../application/ports.js";
import { storyTargetsEnabled, TARGETS, type TargetId, targetConnection, targetDefinition } from "../botTargets.js";
import type { BackendDb } from "../db/client.js";
import type { VideoLocale } from "../foundation/external/youtube.js";
import { parseTargets } from "../publishing/targets.js";
import { ACCOUNT_PLATFORMS, VIDEO_TARGET_PLATFORM, type VideoTarget } from "../publishing/video-types.js";
import { channelIdentity } from "./identity.js";

export type ChannelConnection = ChannelConnectionRecord;

export function listChannels(backendDb: BackendDb, enabledOnly = true): ChannelConnection[] {
  return backendDb.channels
    .list(enabledOnly)
    .sort((left, right) => left.platform.localeCompare(right.platform) || left.locale.localeCompare(right.locale));
}

export type ChannelInput = {
  platform: string;
  locale: VideoLocale;
  provider: string;
  providerAccountId?: string;
  targetId?: string;
  label?: string;
  source?: string;
};

export function registerChannel(backendDb: BackendDb, input: ChannelInput): ChannelConnection {
  // A channel is either a text target this Studio publishes to or a platform
  // the video pipeline can reach. Anything else is a row that can never
  // publish, and nothing downstream would say so: the credential report asks
  // what such a channel requires, is told nothing, and reports it ready.
  if (!input.targetId && !ACCOUNT_PLATFORMS.includes(input.platform as (typeof ACCOUNT_PLATFORMS)[number])) {
    const known = ACCOUNT_PLATFORMS.join(", ");
    throw new Error(`Unknown platform: ${input.platform}. Account platforms are ${known}; a text channel names its target instead.`);
  }
  const now = new Date().toISOString();
  const id = input.targetId ?? channelIdentity(input.platform, input.locale);
  backendDb.channels.upsert(
    {
      id,
      platform: input.platform,
      locale: input.locale,
      provider: input.provider,
      providerAccountId: input.providerAccountId ?? null,
      targetId: input.targetId ?? null,
      label: input.label ?? `${displayPlatform(input.platform)} ${input.locale.toUpperCase()}`,
      enabled: 1,
      source: input.source ?? "interface",
    },
    now,
  );
  const connection = backendDb.channels.get(id);
  if (!connection) throw new Error(`Channel registration did not persist: ${id}`);
  return connection;
}

/** Registers a text or Story route from the target that already owns its
 * platform identity and language. Every interface uses this entry point, so no
 * surface can persist a target under a conflicting locale. */
export function registerTargetChannel(
  backendDb: BackendDb,
  targetId: TargetId,
  input: { provider: string; providerAccountId?: string; label?: string; source?: string },
): ChannelConnection {
  const target = targetDefinition(targetId);
  if (!target) throw new Error(`Unknown publication target: ${targetId}`);
  return registerChannel(backendDb, {
    platform: targetId,
    locale: target.locale,
    provider: input.provider,
    targetId,
    ...(input.providerAccountId ? { providerAccountId: input.providerAccountId } : {}),
    label: input.label ?? target.label,
    ...(input.source ? { source: input.source } : {}),
  });
}

/** How each connected text or story target is delivered, by target id.
 *
 * The registry has always carried a provider per channel, but only the video
 * pipeline read it, so a Threads or Stories channel connected through a
 * provider still demanded the platform's own tokens and still published
 * natively. Delivery reads this instead of the database: it needs the routing,
 * not the registry.
 */
export function targetRouting(backendDb: BackendDb): Record<string, { provider: string; accountId: string | null }> {
  const routing: Record<string, { provider: string; accountId: string | null }> = {};
  for (const channel of listChannels(backendDb))
    if (channel.targetId) routing[channel.targetId] = { provider: channel.provider, accountId: channel.providerAccountId };
  return routing;
}

/** Every publication target this Studio publishes text or Stories to.
 *
 * A channel names its target or it serves none: an account connected for video
 * used to also register the Story its platform can technically serve, which put
 * an EN Story target in front of a Studio that had connected Instagram purely to
 * upload Reels. A Story is connected the way every other post target is. */
export function registeredPostTargetIds(backendDb: BackendDb): Set<string> {
  const connections = new Set(listChannels(backendDb).flatMap((channel) => (channel.targetId ? [channel.targetId] : [])));
  // A connection delivers every target that names it. One connected X account
  // serves both the post target and the Article target; it is not connected
  // twice to say so.
  return new Set(TARGETS.map(({ id }) => String(id)).filter((target) => connections.has(targetConnection(target))));
}

/**
 * Whether this publication goes to a Story, which is the one question every
 * piece of Story work keys off: whether the operator is asked about Story
 * publishing, and whether the media needs its 9:16 shapes made.
 *
 * It is asked of the publication's own targets, narrowed by the registry -- not
 * of the Studio's default profile, and not of what it merely has connected. A
 * profile nobody has curated ticks targets with no channel behind them, and a
 * draft turns on targets the profile has off. Both of those were answered
 * separately once, and each answer was wrong somewhere: media ingress read the
 * profile and prepared nothing for a Studio whose Story target lives on the
 * draft, then read the connections and prepared an encode for every import.
 * There is one answer, and callers take it from here.
 */
export function publishesStory(backendDb: BackendDb, targetsJson: unknown): boolean {
  return storyTargetsEnabled(effectivePostTargets(backendDb, parseTargets(targetsJson)));
}

/** The registry is the only source of enabled publication targets. */
export function effectivePostTargets(backendDb: BackendDb, targets: Record<string, boolean>): Record<string, boolean> {
  const registered = registeredPostTargetIds(backendDb);
  return Object.fromEntries(Object.entries(targets).map(([target, enabled]) => [target, enabled && registered.has(target)]));
}

export function channelForVideo(backendDb: BackendDb, target: VideoTarget, locale: VideoLocale): ChannelConnection | undefined {
  const platform = VIDEO_TARGET_PLATFORM[target];
  return backendDb.channels.find(platform, locale) ?? undefined;
}

function displayPlatform(platform: string): string {
  return platform === "youtube" ? "YouTube" : platform === "instagram" ? "Instagram" : platform[0]?.toUpperCase() + platform.slice(1);
}
