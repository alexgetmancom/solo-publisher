import { type Context, InputFile } from "grammy";
import type { BackendDb } from "../../db/client.js";
import { splitText } from "../../delivery/social/payload.js";
import type { BackendConfig } from "../../foundation/config.js";
import { t } from "../../foundation/i18n/index.js";
import type { StudioLocale } from "../../foundation/locale.js";
import { log } from "../../foundation/logger.js";
import { escapeMarkdown } from "../../foundation/markdown.js";
import { threadsBody, threadsTextLimit } from "../../publishing/threads-text.js";
import type { DeliveryProjection } from "../../studio/projections.js";
import { createStudioServices } from "../../studio/services/index.js";
import { settingsService } from "../../studio/services/settings.js";

const TELEGRAM_MEDIA_GROUP_LIMIT = 10;

/** Telegram allows 1024 characters in a caption; a preview stops short of that
 * so the text it shows is the post's own, never a silently trimmed one. Past
 * the budget the media goes first and the text follows as its own message. */
const PREVIEW_CAPTION_LIMIT = 1000;

/** Telegram renderer for Studio delivery projections. It owns no planning decisions. */
export async function sendTelegramDeliveryPreviews(
  ctx: Context,
  projections: DeliveryProjection[],
  locale: StudioLocale = "en",
): Promise<void> {
  for (const projection of projections) {
    // One unrenderable projection — a missing file, a Telegram 400 — must not
    // swallow the previews that follow it.
    try {
      await ctx.reply(...deliveryHeader(projection, locale));
      if (projection.targets.length) await sendProjectionContent(ctx, projection, locale);
      if (projection.notes.length)
        await ctx.reply(projection.notes.map((note) => `ℹ️ ${escapeMarkdown(note)}`).join("\n"), { parse_mode: "Markdown" });
    } catch (error) {
      log("error", "telegram delivery preview failed", { projection: projection.id, error });
    }
  }
}

/** Reuses the same safe Telegram media rendering for a published archive item. */
export async function sendTelegramArchiveMedia(ctx: Context, media: Record<string, unknown>[]): Promise<void> {
  await sendMedia(ctx, media, "", []);
}

async function sendProjectionContent(ctx: Context, projection: DeliveryProjection, locale: StudioLocale = "en"): Promise<void> {
  const metadata = projection.metadata ? formatMetadata(projection.metadata, locale) : "";
  const text = [projection.text, metadata].filter(Boolean).join("\n\n");
  // Metadata is preview-only and has no source entities; retain formatting only
  // when the projection contains its original post text unchanged.
  const entities = metadata ? [] : projection.entities;
  await sendMedia(ctx, projection.media, text, entities);
}

type RenderableMedia = { source: InputFile | string; video: boolean };

/** Sends whatever of `media` Telegram can actually address, with `text` attached once. */
async function sendMedia(ctx: Context, media: Record<string, unknown>[], text: string, entities: Record<string, unknown>[]) {
  // An item with neither a local path nor a file id cannot be sent; dropping it
  // here keeps the rest of the album from riding on the first item's fate.
  const items = media.flatMap<RenderableMedia>((item) => {
    const source = mediaSource(item);
    return source ? [{ source, video: isVideo(item) }] : [];
  });
  const first = items[0];
  if (!first) {
    if (text) await ctx.reply(text, entityOptions(entities, text.length));
    return;
  }
  const hasCaption = Boolean(text && text.length <= PREVIEW_CAPTION_LIMIT);
  const caption = hasCaption ? { caption: text, ...captionEntityOptions(entities, text.length) } : {};
  if (items.length > 1) {
    const group = items.map((item, index) => ({
      type: item.video ? "video" : "photo",
      media: item.source,
      ...(index === 0 ? caption : {}),
    }));
    // Telegram rejects an album larger than 10 outright, which would lose the
    // whole preview; send the first ten as the album and the rest one by one.
    await ctx.replyWithMediaGroup(group.slice(0, TELEGRAM_MEDIA_GROUP_LIMIT) as never);
    for (const item of items.slice(TELEGRAM_MEDIA_GROUP_LIMIT)) {
      if (item.video) await ctx.replyWithVideo(item.source);
      else await ctx.replyWithPhoto(item.source);
    }
  } else if (first.video) await ctx.replyWithVideo(first.source, caption);
  else await ctx.replyWithPhoto(first.source, caption);
  if (text && !hasCaption) await ctx.reply(text, entityOptions(entities, text.length));
}

function isVideo(media: Record<string, unknown>): boolean {
  return String(media.type ?? "photo").toLowerCase() === "video";
}

/** The one deferred view of a delivery: every Threads rendering the draft
 * carries, one message per language. It hangs off the publish confirmation
 * rather than the previews themselves, which is why it takes the publication
 * -- what kind and which one -- and not a single projection. */
export async function sendThreadsPreviews(
  ctx: Context,
  backendDb: BackendDb,
  config: BackendConfig,
  publication: { kind: string; id: number },
): Promise<void> {
  const actorId = Number(ctx.from?.id);
  const locale = settingsService(backendDb).locale(actorId);
  const services = createStudioServices(backendDb, config);
  const delivery =
    publication.kind === "video"
      ? services.videos.preview(actorId, publication.id).delivery
      : publication.kind === "post"
        ? services.posts.preview(actorId, publication.id).delivery
        : null;
  const renderings = (delivery?.projections ?? []).flatMap((projection) => {
    const target = projection.targets.find((item) => item === "threads_ru" || item === "threads_en");
    return target ? [threadsPreviewText(target, projection.text, projection.entities, Boolean(projection.threadsChain), locale)] : [];
  });
  // The confirmation belongs to a draft that has changed since: say so rather
  // than acknowledging a tap that then does nothing.
  await ctx.answerCallbackQuery(renderings.length ? undefined : { text: t(locale, "action.card-stale") });
  for (const rendering of renderings) await ctx.reply(rendering);
}

/** The video behind a publication, sent only when asked for. The previews show
 * what each platform receives as text; the clip itself is the same file for all
 * of them, so it is one button beside the confirmation rather than an upload
 * repeated per platform. */
export async function sendVideoSourcePreview(
  ctx: Context,
  backendDb: BackendDb,
  config: BackendConfig,
  publicationId: number,
): Promise<void> {
  const actorId = Number(ctx.from?.id);
  const locale = settingsService(backendDb).locale(actorId);
  const source = createStudioServices(backendDb, config).videos.preview(actorId, publicationId).delivery.source;
  const media = source ? mediaSource(source) : null;
  await ctx.answerCallbackQuery(media ? undefined : { text: t(locale, "video.source-gone") });
  if (media) await ctx.replyWithVideo(media);
}

function deliveryHeader(projection: DeliveryProjection, locale: StudioLocale): [string, { parse_mode: "Markdown" }] {
  const targets = projection.targets.join(" · ") || t(locale, "preview.no-compatible-target");
  return [`👁 *${escapeMarkdown(projection.label)}*\n${escapeMarkdown(targets)}`, { parse_mode: "Markdown" }];
}

export function threadsPreviewText(
  target: "threads_ru" | "threads_en",
  text: string,
  entities: Record<string, unknown>[] = [],
  chain = false,
  locale: StudioLocale = "en",
): string {
  // Threads takes one post, so the preview is a character budget rather than a
  // numbered chain. The numbered form comes back only for a draft whose author
  // waived the rule — there the chain is the thing they need to proofread.
  const limit = threadsTextLimit(target);
  const decision = threadsBody(target, text, entities, { chain });
  const label = target === "threads_ru" ? "Threads RU" : "Threads EN";
  // The link's fate is stated on the counter line, with how many characters it
  // was short. Without that number a dropped link is just something the bot ate.
  const linkNote = decision.droppedUrl
    ? ` · ${t(locale, "preview.threads-link-dropped", { shortfall: decision.shortfall })}`
    : decision.url
      ? ` · ${t(locale, "preview.threads-link-kept")}`
      : "";
  if (!chain) {
    const budget = `${decision.text.length}/${limit}${decision.text.length > limit ? " ⚠️" : ""}`;
    return `🧵 ${label} · ${budget}${linkNote}\n\n${decision.text}`;
  }
  const parts = splitText(decision.text, limit);
  return `🧵 ${label} · ${parts.length}${linkNote}\n\n${parts.map((part, index) => `${threadMarker(index)} ${part}`).join("\n\n")}`;
}

function threadMarker(index: number): string {
  return ["①", "②", "③", "④", "⑤", "⑥", "⑦", "⑧", "⑨", "⑩"][index] ?? `${index + 1}.`;
}

function entityOptions(entities: Record<string, unknown>[], length: number) {
  const safe = safeEntities(entities, length);
  return safe.length ? { entities: safe as never } : {};
}

function captionEntityOptions(entities: Record<string, unknown>[], length: number) {
  const safe = safeEntities(entities, length);
  return safe.length ? { caption_entities: safe as never } : {};
}

/** An entity reaching past the text it annotates is a 400 from Telegram, so clamp or drop it. */
function safeEntities(entities: Record<string, unknown>[], length: number) {
  return entities.flatMap((entity) => {
    const offset = Number(entity.offset);
    const entityLength = Number(entity.length);
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(entityLength) || offset < 0 || entityLength <= 0 || offset >= length)
      return [];
    return [{ ...entity, offset, length: Math.min(entityLength, length - offset) }];
  });
}

function mediaSource(media: Record<string, unknown>): InputFile | string | null {
  const path = typeof media.local_path === "string" ? media.local_path : typeof media.localPath === "string" ? media.localPath : null;
  if (path) return new InputFile(path);
  if (typeof media.file_id === "string") return media.file_id;
  if (typeof media.fileId === "string") return media.fileId;
  return null;
}

function formatMetadata(metadata: Record<string, unknown>, locale: StudioLocale): string {
  const lines: string[] = [];
  if (metadata.title) lines.push(`${t(locale, "preview.metadata-title")}: ${String(metadata.title)}`);
  if (metadata.description) lines.push(`${t(locale, "preview.metadata-description")}: ${String(metadata.description)}`);
  if (metadata.caption) lines.push(`${t(locale, "preview.metadata-caption")}: ${String(metadata.caption)}`);
  if (Array.isArray(metadata.tags) && metadata.tags.length)
    lines.push(`${t(locale, "preview.metadata-tags")}: ${metadata.tags.join(", ")}`);
  if (metadata.gameUrl) lines.push(`${t(locale, "preview.metadata-game")}: ${String(metadata.gameUrl)}`);
  return lines.join("\n");
}
