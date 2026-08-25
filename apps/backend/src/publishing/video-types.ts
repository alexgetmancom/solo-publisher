/** Video-target vocabulary belongs to Publishing, independent of any UI. */
export const VIDEO_TARGETS = ["youtube_shorts", "instagram_reels"] as const;
export type VideoTarget = (typeof VIDEO_TARGETS)[number];
export type VideoLocale = "ru" | "en";

/** The provider platform for each durable video target. */
export const VIDEO_TARGET_PLATFORM = {
  youtube_shorts: "youtube",
  instagram_reels: "instagram",
} as const satisfies Record<VideoTarget, string>;

/** Platforms a Studio can hold an account for. The video pipeline publishes to
 * the two named in VIDEO_TARGET_PLATFORM; TikTok is only ever collected from,
 * through a provider, and Twitch is only ever steered live, so both are real
 * channels that are never delivery targets. */
export const ACCOUNT_PLATFORMS = ["instagram", "tiktok", "twitch", "youtube"] as const;

type VideoSourceMetadata = { videoDurationMs?: number };
export type YouTubeMetadata = { title: string; description: string; tags: string[]; gameUrl?: string } & VideoSourceMetadata;
/** Instagram receives one ready-to-publish caption, including any hashtags. */
export type InstagramMetadata = { caption: string } & VideoSourceMetadata;
export type VideoMetadata = YouTubeMetadata | InstagramMetadata;

export function videoTargetLabel(target: VideoTarget): string {
  return target === "youtube_shorts" ? "YouTube Shorts" : "Instagram Reels";
}

export type VideoDestination = { target: VideoTarget; locale: VideoLocale; label: string; profile: string };

export function videoDestination(
  catalogue: readonly VideoDestination[],
  target: string,
  locale: string | null | undefined,
): VideoDestination | null {
  return catalogue.find((entry) => entry.target === target && entry.locale === locale) ?? null;
}

/** Above this a vertical clip is almost always a bad cut, not an intent: the
 * Shorts and Reels published here run well under it, and the ones that ran over
 * were personal footage the trim had missed. The platforms accept longer video,
 * so this is asked about and never refused. */
export const VIDEO_LENGTH_WARNING_SECONDS = 90;
