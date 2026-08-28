import { desc, eq } from "drizzle-orm";
import { type Bot, InlineKeyboard } from "grammy";
import { parsePublicationRef, publicationRef } from "../../application/publication-ref.js";
import { publicationCallback } from "../../bot/publication-callback.js";
import { appendUnlandedControls } from "../../bot/unlanded-controls.js";
import { isSiteTarget, targetDefinition, targetLocale } from "../../botTargets.js";
import { type BackendDb, unsafeDb } from "../../db/client.js";
import { drafts, publicationTargets, publishJobs, siteJobs, videoDrafts, videoTargets } from "../../db/schema.js";
import type { BackendConfig } from "../../foundation/config.js";
import type { MessageKey } from "../../foundation/i18n/index.js";
import { t } from "../../foundation/i18n/index.js";
import type { StudioLocale } from "../../foundation/locale.js";
import { log } from "../../foundation/logger.js";
import { truncateUnicode } from "../../foundation/text.js";
import { isAudienceMutationRetryable, isPostTargetRetryable } from "../../publishing/state.js";
import { getVideoDraft } from "../../publishing/video-data.js";
import type { VideoTarget } from "../../publishing/video-types.js";
import { VIDEO_TARGETS, videoTargetLabel } from "../../publishing/video-types.js";
import { settingsService } from "../../studio/services/settings.js";
import { telegramVideoCard } from "./control-cards.js";
import { videoPreview } from "./video-preview.js";
import { formatVideoTime } from "./video-time.js";

/** These adapters render times, so they need the configured zone — nothing more. */
type StudioTimeConfig = Pick<BackendConfig, "TIMEZONE" | "TIMEZONE_LABEL">;

export async function notifyFinalVideoFailure(
  backendDb: BackendDb,
  bot: Bot | null,
  config: Pick<BackendConfig, "CONTROLLER_ADMIN_IDS">,
  videoDraftId: number,
  videoTargetId: number | null,
): Promise<void> {
  if (!bot || !videoTargetId) return;
  const target = unsafeDb(backendDb).db.select().from(videoTargets).where(eq(videoTargets.id, videoTargetId)).get();
  if (target?.status !== "failed") return;
  const draft = getVideoDraft(backendDb, videoDraftId);
  const targetName = target.target as VideoTarget;
  await forEachAdmin(config.CONTROLLER_ADMIN_IDS, async (actorId) => {
    // A dead target is the outcome of a publication, so the completion switch
    // silences it like any other outcome.
    if (!settingsService(backendDb).notifications(actorId).completionEnabled) return;
    const locale = settingsService(backendDb).locale(actorId);
    const title = draft.label || t(locale, "common.untitled");
    await bot.api.sendMessage(
      actorId,
      `${t(locale, "notif.video-failed", { label: videoTargetLabel(targetName), title })}\n\n${target.lastError || t(locale, "notif.unknown-error")}`,
      {
        reply_markup: new InlineKeyboard().text(
          t(locale, "notif.retry", { platform: targetName === "youtube_shorts" ? "YouTube" : "Instagram" }),
          publicationCallback("video", "retry", [draft.id, targetName, "notice"]),
        ),
      },
    );
  });
}

export async function refreshVideoControlCard(
  backendDb: BackendDb,
  bot: Bot | null,
  config: StudioTimeConfig,
  videoDraftId: number,
): Promise<void> {
  if (!bot) return;
  const card = telegramVideoCard(backendDb, videoDraftId);
  if (!card || card.chatId == null || card.messageId == null) return;
  const draft = getVideoDraft(backendDb, videoDraftId);
  const timeConfig = settingsService(backendDb).timeConfig(draft.actorId, config);
  const preview = videoPreview(
    { draft, targets: unsafeDb(backendDb).db.select().from(videoTargets).where(eq(videoTargets.videoDraftId, videoDraftId)).all() },
    timeConfig,
    settingsService(backendDb).locale(draft.actorId),
  );
  try {
    await bot.api.editMessageText(card.chatId, card.messageId, preview.text, {
      parse_mode: "Markdown",
      reply_markup: preview.keyboard,
    });
  } catch (error) {
    // A deleted or manually edited Telegram message must not stop publication,
    // but a malformed card or a broken token has to be visible somewhere.
    log("warn", "video control card was not refreshed", { videoDraftId, error: String(error) });
  }
}

/** Telegram delivery adapter for Studio events. The event and preference live above Telegram. */
export async function sendStudioReminder(
  backendDb: BackendDb,
  bot: Bot | null,
  config: StudioTimeConfig & Pick<BackendConfig, "CONTROLLER_ADMIN_IDS">,
  event: { publicationKey: string | null; detailsJson: unknown },
): Promise<void> {
  if (!bot) return;
  const details = object(event.detailsJson);
  // The reminder reaches every administrator, so the actor is not an address —
  // it only says the event still refers to something real. `admin_id` is the
  // pre-rename spelling, and events written before 0030 are still durable.
  const known = number(details.actor_id) != null || number(details.admin_id) != null || publicationExists(backendDb, event.publicationKey);
  if (!known) return;
  const targets = Array.isArray(details.targets) ? details.targets.filter((value): value is string => typeof value === "string") : [];
  const minutes = number(details.minutes) ?? 5;
  const publishAt = typeof details.publish_at === "string" ? details.publish_at : null;
  const videoLocale = videoLocaleForRef(backendDb, event.publicationKey);
  // Reminders are enabled per publication kind, so the delivery gate reads the
  // same flag the scheduler did. A video reference is the only one that means
  // video; drafts and posts are both reminded about as text.
  const isVideo = parsePublicationRef(event.publicationKey)?.kind === "video";
  await forEachAdmin(config.CONTROLLER_ADMIN_IDS, async (actorId) => {
    const notifications = settingsService(backendDb).notifications(actorId);
    if (!(isVideo ? notifications.videoRemindersEnabled : notifications.postRemindersEnabled)) return;
    const locale = settingsService(backendDb).locale(actorId);
    const timeConfig = settingsService(backendDb).timeConfig(actorId, config);
    const title = typeof details.title === "string" ? details.title : (event.publicationKey ?? t(locale, "notif.publication"));
    const lines = targets.map((target) => `• ${friendlyTarget(target)}${videoLocale ? ` · ${videoLocale.toUpperCase()}` : ""}`);
    await bot.api.sendMessage(
      actorId,
      `${t(locale, "notif.reminder-head", { minutes })}\n\n🎬 ${title}${videoLocale ? `\n${localeName(videoLocale, locale)}` : ""}\n\n${lines.join("\n")}${publishAt ? `\n\n${formatVideoTime(publishAt, locale, timeConfig)}` : ""}`.trim(),
    );
  });
}

export async function sendStudioCompletion(
  backendDb: BackendDb,
  bot: Bot | null,
  config: Pick<BackendConfig, "CONTROLLER_ADMIN_IDS" | "TIMEZONE" | "TIMEZONE_LABEL">,
  event: { publicationKey: string | null; detailsJson: unknown; eventType?: string },
): Promise<void> {
  if (!bot) return;
  if (!publicationExists(backendDb, event.publicationKey)) return;
  const details = object(event.detailsJson);
  const total = number(details.total) ?? 0;
  const published = number(details.published) ?? 0;
  const failed = number(details.failed) ?? 0;
  const partialLocale = event.eventType === "delivery.post.locale.completed" ? localeDetail(details.locale) : null;
  const results = completionTargets(backendDb, event.publicationKey).filter(
    (result) => partialLocale == null || targetLocale(result.target) === partialLocale,
  );
  const videoLocale = videoLocaleForRef(backendDb, event.publicationKey);
  const failedTargets = results.filter((result) => result.status === "failed" || result.status === "verification_required");
  const publication = parsePublicationRef(event.publicationKey);
  const retryableTargets = failedTargets.filter((result) =>
    publication?.kind === "video"
      ? isAudienceMutationRetryable(result.status)
      : publication?.kind === "post" && isPostTargetRetryable(result.target, result.status),
  );
  const draftId = publicationDraftId(backendDb, event.publicationKey);
  await forEachAdmin(config.CONTROLLER_ADMIN_IDS, async (actorId) => {
    if (!settingsService(backendDb).notifications(actorId).completionEnabled) return;
    const locale = settingsService(backendDb).locale(actorId);
    const timeConfig = settingsService(backendDb).timeConfig(actorId, config);
    const label =
      parsePublicationRef(event.publicationKey)?.kind === "video" ? t(locale, "notif.label-video") : t(locale, "notif.label-post");
    const headline = partialLocale
      ? failed
        ? t(locale, "notif.locale-completion-failed", {
            label,
            locale: localeName(partialLocale, locale),
            published,
            total,
            failed,
          })
        : t(locale, "notif.locale-completion-ok", { label, locale: localeName(partialLocale, locale), done: published || total, total })
      : failed
        ? t(locale, "notif.completion-failed", { label, published, total, failed })
        : t(locale, "notif.completion-ok", { label, done: published || total, total });
    const lines = results.map(
      (result) =>
        `${result.partial ? "⚠️" : statusIcon(result.status)} ${friendlyTarget(result.target)} — ${result.partial ? t(locale, "notif.delivery-partial") : friendlyStatus(result.status, locale)}${
          result.error && (result.status === "failed" || result.status === "verification_required") ? ` — ${shortError(result.error)}` : ""
        }`,
    );
    const remaining = partialLocale ? remainingScheduleText(details, locale, timeConfig) : "";
    const text = `${headline}${videoLocale ? `\n${localeName(videoLocale, locale)}` : ""}${remaining ? `\n\n${remaining}` : ""}${lines.length ? `\n\n${lines.join("\n")}` : ""}`;
    const replyMarkup = completionKeyboard(locale, event.publicationKey, draftId, retryableTargets, failedTargets, partialLocale != null);
    await bot.api.sendMessage(actorId, text, replyMarkup ? { reply_markup: replyMarkup } : undefined);
  });
}

function completionKeyboard(
  locale: StudioLocale,
  publicationKey: string | null,
  draftId: number | null,
  retryableTargets: CompletionTarget[],
  failedTargets: CompletionTarget[],
  partial: boolean,
): InlineKeyboard | undefined {
  const publication = parsePublicationRef(publicationKey);
  const kind = publication?.kind === "post" || publication?.kind === "video" ? publication.kind : null;
  if (!kind || draftId == null) return undefined;
  const retryable = new Set(retryableTargets.map((target) => target.target));
  const unlanded = [...new Set([...retryable, ...failedTargets.map((target) => target.target)])].map((target) => ({
    target,
    label: friendlyTarget(target),
    retryable: retryable.has(target),
    // Skipping is a post operation; a video target is given up on by cancelling
    // the video, which the video card already offers.
    skippable: kind === "post",
  }));
  const keyboard = new InlineKeyboard();
  const decisions = appendUnlandedControls(keyboard, { locale, kind, draftId, origin: "notice", targets: unlanded });
  // A partially scheduled post is worth opening even when nothing failed: the
  // rest of it still needs a time.
  if (!decisions && !(kind === "post" && partial)) return undefined;
  keyboard.text(t(locale, "notif.open"), publicationCallback(kind, "view", [draftId, "overview"]));
  return keyboard;
}

async function forEachAdmin(actorIds: number[], deliver: (actorId: number) => Promise<void>): Promise<void> {
  for (const actorId of actorIds) {
    try {
      await deliver(actorId);
    } catch (error) {
      // One administrator blocking the bot must not prevent the remaining
      // trusted operators from receiving the shared publication update.
      log("warn", "shared Studio notification was not delivered", { actorId, error: String(error) });
    }
  }
}

type CompletionTarget = { target: string; status: string; error: string | null; partial: boolean };

/** A target that did not finish while something of it is already live. The
 * status alone cannot say it -- a half-published chain settles as `failed` --
 * and a card that calls that "не опубликовано" is read as the bot lying about
 * a post the author can see on the platform. */
function isPartial(status: string, externalId: string | null): boolean {
  return status !== "published" && Boolean(externalId);
}

function completionTargets(backendDb: BackendDb, ref: string | null): CompletionTarget[] {
  const publication = parsePublicationRef(ref);
  if (!publication || publication.kind === "draft") return [];
  if (publication.kind === "video")
    return unsafeDb(backendDb)
      .db.select({ target: videoTargets.target, status: videoTargets.status, error: videoTargets.lastError })
      .from(videoTargets)
      .where(eq(videoTargets.videoDraftId, publication.id))
      .all()
      .map((row) => ({ ...row, partial: false }));
  const jobs = unsafeDb(backendDb)
    .db.select({ target: publishJobs.target, status: publishJobs.status, error: publishJobs.lastError, jobId: publishJobs.jobId })
    .from(publishJobs)
    .where(eq(publishJobs.publicationKey, publicationRef("post", publication.id)))
    .orderBy(desc(publishJobs.jobId))
    .all();
  const delivered = new Map(
    unsafeDb(backendDb)
      .db.select({ target: publicationTargets.target, externalId: publicationTargets.externalId, status: publicationTargets.status })
      .from(publicationTargets)
      .where(eq(publicationTargets.publicationKey, publicationRef("post", publication.id)))
      .all()
      .map((row) => [row.target, row] as const),
  );
  const latest = new Map<string, CompletionTarget & { jobId: number }>();
  for (const job of jobs)
    if (!latest.has(job.target))
      latest.set(job.target, { ...job, partial: isPartial(job.status, delivered.get(job.target)?.externalId ?? null) });
  const site = unsafeDb(backendDb)
    .db.select({ reason: siteJobs.reason, status: siteJobs.status, error: siteJobs.lastError, jobId: siteJobs.jobId })
    .from(siteJobs)
    .where(eq(siteJobs.publicationKey, publicationRef("post", publication.id)))
    .orderBy(desc(siteJobs.jobId))
    .all();
  for (const job of site) {
    if (isSiteTarget(job.reason) && !latest.has(job.reason))
      latest.set(job.reason, { target: job.reason, status: job.status, error: job.error, jobId: job.jobId, partial: false });
  }
  return [...latest.values()];
}

/** The id the publication callbacks address: a video ref already carries its
 * draft id, a post ref carries the published post and has to be looked up. */
function publicationDraftId(backendDb: BackendDb, ref: string | null): number | null {
  const publication = parsePublicationRef(ref);
  if (publication?.kind === "video") return publication.id;
  if (publication?.kind !== "post") return null;
  return unsafeDb(backendDb).db.select({ id: drafts.id }).from(drafts).where(eq(drafts.postId, publication.id)).get()?.id ?? null;
}

function shortError(value: string): string {
  return truncateUnicode(value.replace(/\s+/g, " "), 180);
}

function videoLocaleForRef(backendDb: BackendDb, ref: string | null): "ru" | "en" | null {
  const publication = parsePublicationRef(ref);
  if (publication?.kind !== "video") return null;
  const locale = unsafeDb(backendDb)
    .db.select({ locale: videoDrafts.locale })
    .from(videoDrafts)
    .where(eq(videoDrafts.id, publication.id))
    .get()?.locale;
  return locale === "en" ? "en" : locale === "ru" ? "ru" : null;
}

/** One label per target, taken from the two vocabularies that own them. */
function friendlyTarget(target: string): string {
  if ((VIDEO_TARGETS as readonly string[]).includes(target)) return videoTargetLabel(target as VideoTarget);
  return targetDefinition(target)?.label ?? target;
}

function localeName(locale: "ru" | "en", interfaceLocale: "ru" | "en"): string {
  return t(interfaceLocale, locale === "en" ? "notif.locale-en" : "notif.locale-ru");
}

function remainingScheduleText(
  details: Record<string, unknown>,
  interfaceLocale: "ru" | "en",
  config: Pick<BackendConfig, "TIMEZONE" | "TIMEZONE_LABEL">,
): string {
  const remaining = Array.isArray(details.remaining) ? details.remaining : [];
  return remaining
    .map((value) => {
      if (value == null || typeof value !== "object" || Array.isArray(value)) return null;
      const item = value as Record<string, unknown>;
      const itemLocale = localeDetail(item.locale);
      if (!itemLocale) return null;
      const at = typeof item.scheduled_at === "string" ? formatVideoTime(item.scheduled_at, interfaceLocale, config) : null;
      return t(interfaceLocale, at ? "notif.remaining-scheduled" : "notif.remaining-unscheduled", {
        locale: localeName(itemLocale, interfaceLocale),
        at: at ?? "",
      });
    })
    .filter((value): value is string => value != null)
    .join("\n");
}

/** The delivery outcomes a notification renders. A row still arrives as a
 * string, so unknown values fall back to "pending" instead of failing here. */
type DeliveryStatus = "published" | "completed" | "failed" | "verification_required" | "cancelled";

const DELIVERY_ICON = {
  published: "✅",
  completed: "✅",
  failed: "❌",
  verification_required: "⚠️",
  cancelled: "🚫",
} as const satisfies Record<DeliveryStatus, string>;

const DELIVERY_LABEL = {
  published: "notif.delivery-published",
  completed: "notif.delivery-published",
  failed: "notif.delivery-failed",
  verification_required: "notif.delivery-verification",
  cancelled: "notif.delivery-cancelled",
} as const satisfies Record<DeliveryStatus, MessageKey>;

function statusIcon(status: string): string {
  return DELIVERY_ICON[status as DeliveryStatus] ?? "⏳";
}

function friendlyStatus(status: string, locale: "ru" | "en"): string {
  return t(locale, DELIVERY_LABEL[status as DeliveryStatus] ?? "notif.delivery-pending");
}

/** Notifications go to every administrator, so a ref is only checked for still
 * naming a real publication. */
function publicationExists(backendDb: BackendDb, ref: string | null): boolean {
  const publication = parsePublicationRef(ref);
  if (!publication || publication.kind === "draft") return false;
  if (publication.kind === "video")
    return unsafeDb(backendDb).db.select({ id: videoDrafts.id }).from(videoDrafts).where(eq(videoDrafts.id, publication.id)).get() != null;
  return unsafeDb(backendDb).db.select({ id: drafts.id }).from(drafts).where(eq(drafts.postId, publication.id)).get() != null;
}

function object(value: unknown): Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function number(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function localeDetail(value: unknown): "ru" | "en" | null {
  return value === "ru" || value === "en" ? value : null;
}
