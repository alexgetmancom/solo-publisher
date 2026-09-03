import { and, asc, eq, lte } from "drizzle-orm";
import type { Bot } from "grammy";
import { translateDraftText } from "../content/translation.js";
import { type BackendDb, unsafeDb } from "../db/client.js";
import { pendingAlbums } from "../db/schema.js";
import type { BackendConfig } from "../foundation/config.js";
import { t } from "../foundation/i18n/index.js";
import { log } from "../foundation/logger.js";
import { setTelegramPostCard } from "../interfaces/telegram/control-cards.js";
import { importTelegramMedia } from "../interfaces/telegram/media-ingress.js";
import { jsonRecordArray } from "../json.js";
import { createStudioServices } from "../studio/services/index.js";
import { settingsService } from "../studio/services/settings.js";
import { clearConversationStateIfCurrent, getConversationState } from "./conversation-state.js";
import { type PostSessionStep, type PostWizardStep, postStepData } from "./post-flow.js";
import { postPreviewCard } from "./publication-renderers.js";

/** Telegram delivers an album as separate messages; this is how long the
 * group is left to arrive in full before it is treated as complete. */
const CONTROLLER_ALBUM_SETTLE_SECONDS = 4;

// pending_albums.notified lifecycle: an album is SETTLED once its caption and
// media are collected, then CLAIMED by exactly one worker before finalization.
const ALBUM_SETTLED = 1;
const ALBUM_CLAIMED = 2;
// A claim is durable so a process crash cannot lose the album, but it needs a
// lease so a claim abandoned mid-import can be picked up by the next cycle.
const ALBUM_CLAIM_LEASE_MS = 10 * 60_000;
// A failed finalization goes back to SETTLED and is retried once per settle
// window. Deterministic failures (an expired file_id, a draft deleted mid-flight)
// would loop forever, so give up after a few tries and tell the sender instead
// of retrying silently at ~1 Hz.
const ALBUM_MAX_ATTEMPTS = 5;
// One cycle imports media and translates text per album, so a backlog is worked
// off over several ticks instead of holding claims past their lease.
const ALBUM_FINALIZE_BATCH = 20;

type PendingAlbumInput = {
  actorId: number;
  chatId: number;
  mediaGroupId: string;
  text: string;
  entities: unknown[];
  media: Record<string, unknown>;
  step: PostWizardStep | null;
  draftId: number | null;
  stateRevision: number | null;
};

export function appendPendingAlbum(backendDb: BackendDb, input: PendingAlbumInput): boolean {
  const step = input.step?.type ?? null;
  const id = `${input.actorId}:${input.chatId}:${input.mediaGroupId}:${step ?? "draft"}:${input.draftId ?? ""}`;
  const handle = unsafeDb(backendDb);
  // Album items arrive as separate updates that can be handled concurrently, so
  // read-modify-write of mediaJson has to be one transaction or an item is lost.
  return handle.sqlite.transaction(() => {
    const row = handle.db
      .select({ mediaJson: pendingAlbums.mediaJson, textRu: pendingAlbums.textRu, textEntitiesJson: pendingAlbums.textEntitiesJson })
      .from(pendingAlbums)
      .where(eq(pendingAlbums.id, id))
      .get();
    const media = row ? jsonRecordArray(row.mediaJson) : [];
    media.push(input.media);
    const now = new Date().toISOString();
    const values = {
      id,
      actorId: input.actorId,
      chatId: input.chatId,
      mediaGroupId: input.mediaGroupId,
      step,
      stepDataJson: postStepData(input.step),
      draftId: input.draftId,
      stateRevision: input.stateRevision,
      textRu: input.text || row?.textRu || "",
      textEntitiesJson: JSON.stringify(input.entities.length ? input.entities : jsonRecordArray(row?.textEntitiesJson)),
      mediaJson: JSON.stringify(media),
      notified: ALBUM_SETTLED,
      updatedAt: now,
    };
    handle.db
      .insert(pendingAlbums)
      .values(values)
      .onConflictDoUpdate({
        target: pendingAlbums.id,
        set: {
          step: values.step,
          stepDataJson: values.stepDataJson,
          textRu: values.textRu,
          textEntitiesJson: values.textEntitiesJson,
          mediaJson: values.mediaJson,
          notified: ALBUM_SETTLED,
          updatedAt: now,
        },
      })
      .run();
    return !row;
  })();
}

export async function finalizePendingAlbums(bot: Bot | null, backendDb: BackendDb, config: BackendConfig): Promise<number> {
  if (!bot) return 0;
  const now = new Date();
  const nowIso = now.toISOString();
  const claimCutoff = new Date(now.getTime() - ALBUM_CLAIM_LEASE_MS).toISOString();
  // Recover claims left behind by a crashed worker. Keep updatedAt untouched:
  // the row can be selected in this same cycle if its settle window elapsed.
  unsafeDb(backendDb)
    .db.update(pendingAlbums)
    .set({ notified: ALBUM_SETTLED })
    .where(and(eq(pendingAlbums.notified, ALBUM_CLAIMED), lte(pendingAlbums.updatedAt, claimCutoff)))
    .run();
  const cutoff = new Date(now.getTime() - CONTROLLER_ALBUM_SETTLE_SECONDS * 1000).toISOString();
  const rows = unsafeDb(backendDb)
    .db.select({
      id: pendingAlbums.id,
      actorId: pendingAlbums.actorId,
      chatId: pendingAlbums.chatId,
      step: pendingAlbums.step,
      stepDataJson: pendingAlbums.stepDataJson,
      draftId: pendingAlbums.draftId,
      stateRevision: pendingAlbums.stateRevision,
      attemptCount: pendingAlbums.attemptCount,
      textRu: pendingAlbums.textRu,
      textEntitiesJson: pendingAlbums.textEntitiesJson,
      mediaJson: pendingAlbums.mediaJson,
    })
    .from(pendingAlbums)
    .where(and(eq(pendingAlbums.notified, ALBUM_SETTLED), lte(pendingAlbums.updatedAt, cutoff)))
    .orderBy(asc(pendingAlbums.updatedAt))
    .limit(ALBUM_FINALIZE_BATCH)
    .all();
  let completed = 0;
  for (const row of rows) {
    // Count the attempt when the claim is taken, not when it throws: a crash
    // mid-import would otherwise return the row unchanged and loop forever.
    const attempts = row.attemptCount + 1;
    const claim = unsafeDb(backendDb)
      .db.update(pendingAlbums)
      .set({ notified: ALBUM_CLAIMED, attemptCount: attempts, updatedAt: nowIso })
      .where(and(eq(pendingAlbums.id, row.id), eq(pendingAlbums.notified, ALBUM_SETTLED), lte(pendingAlbums.updatedAt, cutoff)))
      .returning({ id: pendingAlbums.id })
      .get();
    if (!claim) continue;
    if (attempts > ALBUM_MAX_ATTEMPTS) {
      await giveUpAlbum(bot, backendDb, row.id, row.actorId, row.chatId);
      log("error", "album finalization failed", { album: row.id, attempts, exhausted: true, error: "claim attempts exhausted" });
      continue;
    }
    let cardDraftId: number | null = null;
    try {
      const state = getConversationState(backendDb, row.actorId, "post");
      if (row.stateRevision != null && state?.revision !== row.stateRevision) {
        unsafeDb(backendDb)
          .db.delete(pendingAlbums)
          .where(and(eq(pendingAlbums.id, row.id), eq(pendingAlbums.notified, ALBUM_CLAIMED)))
          .run();
        log("warn", "stale album discarded", { album: row.id, actorId: row.actorId, stateRevision: row.stateRevision });
        continue;
      }
      const media = await importTelegramMedia(bot.api, backendDb, config, row.actorId, jsonRecordArray(row.mediaJson));
      const draftId = row.draftId;
      const step = row.step as PostSessionStep | null;
      const locale = resolveLocale(row.stepDataJson.locale) ?? resolveLocale(state?.data.locale);
      // An album sent into an open edit is that language's new media, and its
      // caption -- if it has one -- that language's new text. An album with no
      // caption leaves the text alone, because empty copy is not an edit.
      if (step === "edit_text" && locale !== null && draftId) {
        createStudioServices(backendDb, config).posts.edit(row.actorId, draftId, {
          locale,
          text: row.textRu,
          entities: jsonRecordArray(row.textEntitiesJson),
          media,
        });
        clearConversationStateIfCurrent(backendDb, { kind: "post", step, draftId }, row.actorId, row.stateRevision);
        cardDraftId = draftId;
      } else {
        const text = row.textRu;
        const textEn = await translateDraftText(backendDb, text, config);
        cardDraftId = createStudioServices(backendDb, config).posts.create(row.actorId, {
          text,
          textEn,
          media,
          entities: jsonRecordArray(row.textEntitiesJson),
        });
        if (step) clearConversationStateIfCurrent(backendDb, { kind: "post", step, draftId: row.draftId }, row.actorId, row.stateRevision);
      }
      const removed = unsafeDb(backendDb)
        .db.delete(pendingAlbums)
        .where(and(eq(pendingAlbums.id, row.id), eq(pendingAlbums.notified, ALBUM_CLAIMED)))
        .returning({ id: pendingAlbums.id })
        .get();
      if (removed) completed += 1;
    } catch (error) {
      const exhausted = attempts >= ALBUM_MAX_ATTEMPTS;
      if (exhausted) {
        await giveUpAlbum(bot, backendDb, row.id, row.actorId, row.chatId);
      } else {
        unsafeDb(backendDb)
          .db.update(pendingAlbums)
          .set({ notified: ALBUM_SETTLED, updatedAt: new Date().toISOString() })
          .where(and(eq(pendingAlbums.id, row.id), eq(pendingAlbums.notified, ALBUM_CLAIMED)))
          .run();
      }
      log(exhausted ? "error" : "warn", "album finalization failed", {
        album: row.id,
        attempts,
        exhausted,
        error: String(error),
      });
    }
    // The draft exists and the row is gone: the card is presentation, and a
    // Telegram failure here must never replay finalization into a second draft.
    if (cardDraftId !== null) {
      try {
        await refreshDraftControlCard(bot, backendDb, config, row.actorId, cardDraftId, row.chatId);
      } catch (error) {
        log("warn", "album control card failed", { album: row.id, draftId: cardDraftId, error: String(error) });
      }
    }
  }
  return completed;
}

function resolveLocale(value: unknown): "ru" | "en" | null {
  return value === "ru" || value === "en" ? value : null;
}

/** Last word on an album that will never become a draft. Best-effort: a failed
 * notification must not resurrect the row we just dropped. */
async function giveUpAlbum(bot: Bot, backendDb: BackendDb, albumId: string, actorId: number, chatId: number): Promise<void> {
  unsafeDb(backendDb).db.delete(pendingAlbums).where(eq(pendingAlbums.id, albumId)).run();
  try {
    await bot.api.sendMessage(chatId, t(settingsService(backendDb).locale(actorId), "post.album-failed"));
  } catch (error) {
    log("warn", "album give-up notice failed", { chat: chatId, error: String(error) });
  }
}

async function refreshDraftControlCard(
  bot: Bot,
  backendDb: BackendDb,
  config: BackendConfig,
  actorId: number,
  draftId: number,
  chatId: number,
): Promise<void> {
  const preview = postPreviewCard(backendDb, config, actorId, draftId);
  // A completed chat edit gets a fresh card at the bottom. Previous cards are
  // history, never a moving conversation prompt above the user's reply.
  const control = await bot.api.sendMessage(chatId, preview.text, { parse_mode: "Markdown", reply_markup: preview.keyboard });
  setTelegramPostCard(backendDb, draftId, chatId, control.message_id);
}
