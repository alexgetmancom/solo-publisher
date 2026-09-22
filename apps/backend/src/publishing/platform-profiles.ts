import { TARGETS, type TargetLocale } from "../botTargets.js";

type PlatformId = (typeof TARGETS)[number]["id"];
/** A discriminated union on purpose: a `limited` rule without its limit/label, or
 * a first/story-first rule without its note, used to type-check and then degrade
 * silently into "deliver everything" inside mediaPolicyForTarget — the opposite
 * of what the profile declared. Each mode now carries what it needs to be applied. */
type MediaRule = { mode: "all" } | { mode: "limited"; limit: number; label: string } | { mode: "first" | "story-first"; note: string };

type PlatformProfile = {
  id: string;
  label: string;
  locale: TargetLocale;
  kind: "telegram" | "site" | "social";
  capabilities: { text: boolean; image: boolean; video: boolean };
  requirements: readonly string[];
  text?: { removeUrls?: boolean };
  limits?: { text?: number; caption?: number };
  /** Delivery-facing media contract. Interfaces use this for previews; ports own execution. */
  media?: MediaRule & { whenVideo?: MediaRule };
  /** How a thread reaches this platform. `chain` posts each part as a reply to
   * the one before; `rich` sends the whole thread as one message; absent, the
   * platform publishes a single post and the parts are joined into it. */
  thread?: { mode: "chain"; replyMediaLimit: number } | { mode: "rich"; textLimit: number; mediaLimit: number };
  video?: { landscape: readonly [number, number]; portrait: readonly [number, number]; square: readonly [number, number] };
  analytics?: { enabled: boolean; source: string };
};

const analyticsSources: Record<string, string> = {
  telegram: "t_me_public",
  threads_ru: "threads_insights_api",
  threads_en: "threads_insights_api",
  x: "x_api",
  telegram_stories: "telegram_story_api",
  instagram_stories: "instagram_graph_api",
  instagram_stories_ru: "instagram_graph_api",
};

const requirements: Record<string, readonly string[]> = {
  telegram: ["CONTROLLER_BOT_TOKEN"],
  threads_ru: ["THREADS_RU_ACCESS_TOKEN"],
  threads_en: ["THREADS_EN_ACCESS_TOKEN"],
  x: ["X_CLIENT_ID", "X_CLIENT_SECRET", "X_ACCESS_TOKEN", "X_REFRESH_TOKEN"],
  x_article: ["X_CLIENT_ID", "X_CLIENT_SECRET", "X_ACCESS_TOKEN", "X_REFRESH_TOKEN"],
  discord: ["DISCORD_BOT_TOKEN", "DISCORD_CHANNEL_ID"],
  telegram_stories: ["TELEGRAM_CHANNEL_STORIES_API_ID", "TELEGRAM_CHANNEL_STORIES_API_HASH", "TELEGRAM_CHANNEL_STORIES_SESSION"],
  instagram_stories: ["INSTAGRAM_EN_USER_ID", "INSTAGRAM_EN_ACCESS_TOKEN"],
  instagram_stories_ru: ["INSTAGRAM_RU_USER_ID", "INSTAGRAM_RU_ACCESS_TOKEN"],
};

const threadsVideo = { landscape: [1920, 1080], portrait: [1080, 1920], square: [1080, 1080] } as const;

/**
 * Every current post target is described here. This is intentionally data, not
 * a set of target checks spread between UI and delivery code. A new target gets
 * its locale, capabilities, limits and media semantics in one place.
 */
const platformOverrides: Record<PlatformId, Omit<PlatformProfile, "id" | "label" | "locale" | "kind" | "requirements">> = {
  telegram: {
    capabilities: { text: true, image: true, video: true },
    limits: { text: 4096, caption: 1024 },
    media: { mode: "limited", limit: 10, label: "Telegram" },
    // Bot API 10.1 sendRichMessage: one message, 32768 characters, 50 media.
    thread: { mode: "rich", textLimit: 32768, mediaLimit: 50 },
  },
  site_ru: { capabilities: { text: true, image: true, video: false }, media: { mode: "all" } },
  site_en: { capabilities: { text: true, image: true, video: false }, media: { mode: "all" } },
  // 500 is the Threads API's own hard cap on a single post, and it binds every
  // part of a thread: nothing is split at delivery, a longer text becomes a
  // thread by the author's choice. URLs are not stripped the way X strips them —
  // threads-text.ts decides what a Threads post carries.
  threads_ru: {
    capabilities: { text: true, image: true, video: true },
    limits: { text: 500 },
    // A reply here is a single image or video; a carousel reply is not built.
    thread: { mode: "chain", replyMediaLimit: 1 },
    media: { mode: "all" },
    video: threadsVideo,
  },
  threads_en: {
    capabilities: { text: true, image: true, video: true },
    limits: { text: 500 },
    // A reply here is a single image or video; a carousel reply is not built.
    thread: { mode: "chain", replyMediaLimit: 1 },
    media: { mode: "all" },
    video: threadsVideo,
  },
  x: {
    capabilities: { text: true, image: true, video: true },
    text: { removeUrls: true },
    media: { mode: "all" },
    thread: { mode: "chain", replyMediaLimit: 4 },
  },
  // An Article carries its links inside the body's entities rather than in the
  // post text, so the URL stripping that `x` needs would delete the article's
  // own references. No text limit is declared: X does not publish one, and a
  // guessed cap would reject long form for no reason.
  x_article: { capabilities: { text: true, image: true, video: false }, media: { mode: "all" } },
  // 2000 is Discord's own cap on `content`. Unlike Threads, going over it is not
  // a preflight rejection: the adapter splits the text across consecutive
  // messages in the same channel, which is how a Discord channel reads anyway.
  discord: {
    capabilities: { text: true, image: true, video: true },
    limits: { text: 2000 },
    media: { mode: "limited", limit: 10, label: "Discord" },
  },
  telegram_stories: {
    capabilities: { text: true, image: true, video: true },
    media: { mode: "story-first", note: "Stories use a single rendered asset made from the first source item." },
  },
  instagram_stories_ru: {
    capabilities: { text: true, image: true, video: true },
    media: { mode: "story-first", note: "Stories use a single rendered asset made from the first source item." },
  },
  instagram_stories: {
    capabilities: { text: true, image: true, video: true },
    media: { mode: "story-first", note: "Stories use a single rendered asset made from the first source item." },
  },
};

/** The single publishing-facing catalogue of a target's capabilities and runtime requirements. */
export const PLATFORM_PROFILES: Record<string, PlatformProfile> = Object.fromEntries(
  TARGETS.map(({ id, label, locale, kind }) => [
    id,
    {
      id,
      label,
      locale,
      kind,
      requirements: requirements[id] ?? [],
      analytics: analyticsSources[id] ? { enabled: true, source: analyticsSources[id] } : { enabled: false, source: "unsupported" },
      ...platformOverrides[id],
    },
  ]),
);

export function platformProfile(target: string): PlatformProfile | null {
  return PLATFORM_PROFILES[target] ?? null;
}

/** One catalogue for publishing, validation and analytics capability. */
export function platformAnalyticsProfile(target: string): { enabled: boolean; source: string } {
  return platformProfile(target)?.analytics ?? { enabled: false, source: "unsupported" };
}

export function formatPlatformText(target: string, text: string): string {
  return platformProfile(target)?.text?.removeUrls
    ? text
        .replace(/https?:\/\/\S+/g, "")
        // Keep paragraph breaks: `\s` also matches newlines, which used to turn
        // two paragraphs into a single sentence on X after a URL was removed.
        .replace(/[ \t]{2,}/g, " ")
        .replace(/[ \t]+\n/g, "\n")
        .replace(/\n[ \t]+/g, "\n")
        .trim()
    : text;
}

export function videoBounds(target: string, width: number, height: number): { maxWidth: number; maxHeight: number } | null {
  const profile = platformProfile(target);
  const bounds = profile?.video;
  if (!bounds) return null;
  const [maxWidth, maxHeight] = width > height ? bounds.landscape : height > width ? bounds.portrait : bounds.square;
  return { maxWidth, maxHeight };
}
