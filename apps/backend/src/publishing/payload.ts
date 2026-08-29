import { isStoryTarget, targetLocale } from "../botTargets.js";
import { firstLine } from "../content/message.js";
import { payloadMedia } from "../delivery/social/payload.js";
import { selectMediaForTarget } from "./media-policy.js";
import { type PublicationSource, parsePublicationSource } from "./publication-source.js";

/** Resolves the dual-locale publication source into the one durable job shape. */
export function localizeTargetPayload(value: PublicationSource | unknown, target: string): Record<string, unknown> {
  // No default: a target whose locale this build does not know is not English,
  // and guessing was how an unknown target got the English branch and the
  // English text.
  const locale = targetLocale(target);
  if (!locale) return {};
  const payload = parsePublicationSource(value);
  const source = payload.locales[locale];
  const rawMedia = isStoryTarget(target) && source.storyMedia.length ? source.storyMedia : source.media;
  const selectedMedia = selectMediaForTarget(target, rawMedia).map(deliveryMedia);
  const localized = {
    locale,
    title: firstLine(source.text, "Post"),
    text: source.text,
    media: selectedMedia,
    entities: source.entities,
    slug: source.slug,
    postId: payload.postId,
    draftId: payload.draftId,
    threadsChainApproved: payload.threadsChainApproved,
  };
  return { ...localized, media: payloadMedia(localized) };
}

/** Translates the persisted Studio/Telegram media record into the one shape
 * stored on delivery jobs. Provider code never reads persistence field names. */
function deliveryMedia(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const media = value as Record<string, unknown>;
  return {
    type: media.type,
    fileId: media.fileId ?? media.file_id,
    localPath: media.localPath ?? media.local_path ?? media.path,
    vpsUrl: media.vpsUrl ?? media.vps_url ?? media.public_url,
    token: media.token,
    storyLocalPath: media.storyLocalPath ?? media.story_local_path,
    telegramStoryLocalPath: media.telegramStoryLocalPath ?? media.telegram_story_local_path,
    storyVpsUrl: media.storyVpsUrl ?? media.story_vps_url,
  };
}
