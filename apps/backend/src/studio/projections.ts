import { isStoryTarget, targetLocale } from "../botTargets.js";
import { draftLocaleContent } from "../content/draft-content.js";
import type { BackendDb } from "../db/client.js";
import { mediaPolicyForTarget } from "../publishing/media-policy.js";
import { formatPlatformText, platformProfile } from "../publishing/platform-profiles.js";
import { parseTargets } from "../publishing/targets.js";

export type DeliveryProjection = {
  id: string;
  label: string;
  targets: string[];
  locale?: "ru" | "en";
  text: string;
  /** Native Telegram entities retained for a faithful delivery preview. */
  entities: Record<string, unknown>[];
  media: Record<string, unknown>[];
  unavailableTargets?: string[];
  /** The author waived the single-post Threads rule for this draft. */
  threadsChain?: boolean;
  metadata?: Record<string, unknown>;
  notes: string[];
};

/** Pure delivery-facing view shared by Telegram previews, MCP and future CLI. */
export function postDeliveryProjections(
  draft: {
    id: number;
    text_ru: string;
    text_en_approved: string | null;
    text_en_machine: string | null;
    text_ru_entities_json: string | null;
    text_en_entities_json: string | null;
    media_ru_json: string | null;
    media_en_json: string | null;
    targets_json: string;
    threads_chain_approved?: number | boolean | null;
  },
  storyCardsReady = false,
) {
  const targets = Object.entries(parseTargets(draft.targets_json)).flatMap(([target, enabled]) => (enabled ? [target] : []));
  const content = {
    ru: draftLocaleContent(draft, "ru"),
    en: draftLocaleContent(draft, "en"),
  } as const;
  // One platform-specific deviation note per locale, not a whole separate
  // preview message per platform: with a dozen-plus targets, most differing
  // only by a character limit or a dropped video, a full resend of the media
  // for every single one buried the two previews that actually matter.
  const deviationNotes: Record<"ru" | "en", string[]> = { ru: [], en: [] };
  for (const target of targets) {
    const locale = targetLocale(target) ?? "en";
    const profile = platformProfile(target);
    const text = formatPlatformText(target, content[locale].text);
    const targetMedia = storyCardsReady && isStoryTarget(target) ? [{}] : content[locale].media;
    const mediaPolicy = mediaPolicyForTarget(target, targetMedia);
    const unavailable = mediaPolicy.mode === "story-first" && mediaPolicy.inputCount === 0;
    const notes = [
      ...(text !== content[locale].text ? ["text is shortened/transformed for this platform"] : []),
      ...(unavailable ? ["requires media and will be skipped"] : []),
      ...(mediaPolicy.note ? [mediaPolicy.note] : []),
    ];
    if (notes.length) deviationNotes[locale].push(`${profile?.label ?? target}: ${notes.join("; ")}`);
  }
  const canonical = (["ru", "en"] as const).flatMap((locale) => {
    const selected = targets.filter((target) => targetLocale(target) === locale);
    if (!selected.length) return [];
    const unavailableTargets = selected.filter((target) => {
      const targetMedia = storyCardsReady && isStoryTarget(target) ? [{}] : content[locale].media;
      const policy = mediaPolicyForTarget(target, targetMedia);
      return policy.mode === "story-first" && policy.inputCount === 0;
    });
    return [
      {
        id: `post:${draft.id}:${locale}`,
        label: `Preview · ${locale.toUpperCase()}`,
        targets: selected.filter((target) => !unavailableTargets.includes(target)),
        locale,
        threadsChain: Boolean(draft.threads_chain_approved),
        text: content[locale].text,
        entities: content[locale].entities,
        media: content[locale].media,
        unavailableTargets,
        notes: deviationNotes[locale],
      } satisfies DeliveryProjection,
    ];
  });
  return { kind: "post" as const, draftId: draft.id, projections: canonical };
}

export function videoDeliveryProjections(backendDb: BackendDb, publicationId: number) {
  const draft = backendDb.studioVideos.get(publicationId);
  if (!draft) throw new Error("Video publication was not found.");
  const asset = backendDb.studioMediaAssets.get(draft.studioMediaAssetId);
  const media = asset
    ? [{ type: "video", asset_id: asset.id, local_path: asset.localPath, filename: asset.filename, mime_type: asset.mimeType }]
    : [];
  // The projections carry no media. Every platform of a video publication
  // shows the same one file, and a preview per platform meant the same clip
  // uploaded to the chat twice, above the metadata that is the only thing
  // actually differing. The source is offered once, beside them.
  const projections: DeliveryProjection[] = backendDb.studioVideos.targets(publicationId).map((target) => ({
    id: `video:${publicationId}:${target.target}`,
    label: target.target === "youtube_shorts" ? "Preview · YouTube Shorts" : "Preview · Instagram Reels",
    targets: [target.target],
    text: "",
    entities: [],
    media: [],
    unavailableTargets: [],
    metadata: (target.metadataJson ?? {}) as Record<string, unknown>,
    notes: [],
  }));
  return { kind: "video" as const, publicationId, projections, source: media[0] ?? null, sourceAvailable: media.length === 1 };
}
