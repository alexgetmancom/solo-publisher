import { and, asc, eq, gte, inArray, notExists, notInArray, or, sql } from "drizzle-orm";
import type { Bot } from "grammy";
import { parsePublicationRef } from "../../application/publication-ref.js";
import { refreshPostControlCard } from "../../bot/progress.js";
import { type BackendDb, unsafeDb } from "../../db/client.js";
import { alertDedup, drafts, publicationEvents } from "../../db/schema.js";
import type { BackendConfig } from "../../foundation/config.js";
import { log } from "../../foundation/logger.js";
import {
  notifyFinalVideoFailure,
  notifyUnresolvedVideoTarget,
  refreshVideoControlCard,
  sendStudioCompletion,
  sendStudioReminder,
} from "./video-notifications.js";

const TELEGRAM_EVENT_TYPES = [
  "delivery.post.settled",
  "delivery.post.locale.completed",
  "publish.job.claimed",
  "publish.job.published",
  "publish.job.failed",
  "publish.job.retry",
  "video.target.failed",
  "video.target.unresolved",
  "video.job.completed",
  "video.job.failed",
  "studio.notification.reminder.due",
  "delivery.post.completed",
  "delivery.video.completed",
  "analytics.milestone.reached",
];
// Telegram is an immediate interface, not an archival notification transport.
// Older undelivered events remain in the durable audit journal, but must never
// be replayed after a restart and drown current reminders/completions. A
// reminder anchored to a specific moment ("5 minutes before") is meaningless
// hours late, so it keeps a short window. A failure or completion describes
// something that already happened and must survive an outage or deploy that
// outlasts the short window, so it gets a much longer one.
const REMINDER_EVENT_TYPES = ["studio.notification.reminder.due"];
const REMINDER_EVENT_MAX_AGE_MS = 30 * 60 * 1000;
const OUTCOME_EVENT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Consumes durable domain events and renders Telegram-only side effects once. */
export async function consumeTelegramEvents(backendDb: BackendDb, bot: Bot | null, config: BackendConfig): Promise<number> {
  if (!bot) return 0;
  // Filter in SQL, before LIMIT. Filtering after LIMIT starves new events once
  // the first page is occupied by historically delivered Telegram effects.
  const delivered = unsafeDb(backendDb)
    .db.select({ one: sql<number>`1` })
    .from(alertDedup)
    .where(eq(alertDedup.alertKey, sql<string>`'telegram:event:' || ${publicationEvents.id}`));
  const events = unsafeDb(backendDb)
    .db.select()
    .from(publicationEvents)
    .where(
      and(
        inArray(publicationEvents.eventType, TELEGRAM_EVENT_TYPES),
        or(
          and(
            inArray(publicationEvents.eventType, REMINDER_EVENT_TYPES),
            gte(publicationEvents.createdAt, new Date(Date.now() - REMINDER_EVENT_MAX_AGE_MS).toISOString()),
          ),
          and(
            notInArray(publicationEvents.eventType, REMINDER_EVENT_TYPES),
            gte(publicationEvents.createdAt, new Date(Date.now() - OUTCOME_EVENT_MAX_AGE_MS).toISOString()),
          ),
        ),
        notExists(delivered),
      ),
    )
    .orderBy(asc(publicationEvents.createdAt), asc(publicationEvents.id))
    .limit(50)
    .all();
  let handled = 0;
  for (const event of events) {
    if (!claimDelivery(backendDb, event.id)) continue;
    // Delivery is at-most-once by design: the durable reservation is committed
    // before Telegram is called. A failed or interrupted send is never retried,
    // because its external outcome may be ambiguous and a duplicate audience
    // notification is worse than a missing one.
    try {
      await deliverEvent(backendDb, bot, config, event);
      handled += 1;
    } catch (error) {
      log("error", "telegram event delivery failed", { event: event.id, type: event.eventType, error: String(error) });
    }
  }
  return handled;
}

async function deliverEvent(
  backendDb: BackendDb,
  bot: Bot,
  config: BackendConfig,
  event: typeof publicationEvents.$inferSelect,
): Promise<void> {
  const details = eventDetails(event.detailsJson);
  const videoDraftId = numberDetail(details, "videoDraftId");
  const videoTargetId = numberDetail(details, "videoTargetId");
  if (event.eventType === "studio.notification.reminder.due") {
    await sendStudioReminder(backendDb, bot, config, { ...event, detailsJson: details });
  } else if (
    event.eventType === "delivery.post.completed" ||
    event.eventType === "delivery.post.locale.completed" ||
    event.eventType === "delivery.video.completed"
  ) {
    await sendStudioCompletion(backendDb, bot, config, { ...event, detailsJson: details });
  } else if (event.eventType === "analytics.milestone.reached") {
    for (const actorId of config.CONTROLLER_ADMIN_IDS) await bot.api.sendMessage(actorId, event.message);
  } else if (event.eventType === "delivery.post.settled" || event.eventType.startsWith("publish.job.")) {
    const postId = numberDetail(details, "post_id") ?? postIdFromRef(event.publicationKey);
    const draft =
      postId == null ? null : unsafeDb(backendDb).db.select({ id: drafts.id }).from(drafts).where(eq(drafts.postId, postId)).get();
    if (draft) await refreshPostControlCard(backendDb, bot, draft.id);
  } else if (event.eventType === "video.target.failed" && videoDraftId != null)
    await notifyFinalVideoFailure(backendDb, bot, config, videoDraftId, videoTargetId);
  else if (event.eventType === "video.target.unresolved" && videoDraftId != null)
    await notifyUnresolvedVideoTarget(backendDb, bot, config, videoDraftId, videoTargetId);
  else if (videoDraftId != null) await refreshVideoControlCard(backendDb, bot, config, videoDraftId);
}

function postIdFromRef(value: string | null): number | null {
  const publication = parsePublicationRef(value);
  return publication?.kind === "post" ? publication.id : null;
}

function claimDelivery(backendDb: BackendDb, eventId: number): boolean {
  return (
    unsafeDb(backendDb)
      .db.insert(alertDedup)
      .values({ alertKey: `telegram:event:${eventId}`, lastSentAt: new Date().toISOString(), suppressedCount: 0 })
      .onConflictDoNothing()
      .returning({ alertKey: alertDedup.alertKey })
      .get() != null
  );
}

function numberDetail(details: unknown, key: string): number | null {
  if (!details || typeof details !== "object" || !(key in details)) return null;
  const value = (details as Record<string, unknown>)[key];
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

function eventDetails(value: unknown): Record<string, unknown> {
  if (value != null && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed != null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
