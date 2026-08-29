import { type Context, InlineKeyboard } from "grammy";
import { storyCardUse } from "../botTargets.js";
import type { BackendDb } from "../db/client.js";
import type { BackendConfig } from "../foundation/config.js";
import { t } from "../foundation/i18n/index.js";
import { log } from "../foundation/logger.js";
import { createStudioServices } from "../studio/services/index.js";
import { settingsService } from "../studio/services/settings.js";
import { isSupersededCard } from "./card-freshness.js";
import { executePublicationEffects, type PublicationEffect } from "./effects.js";
import { publicationCallback } from "./publication-callback.js";

type StoryCard = { locale: string; status: string; localPath: string | null };

export async function showStoryCardChoice(
  ctx: Context,
  backendDb: BackendDb,
  config: BackendConfig,
  actorId: number,
  draftId: number,
  intent: "publish" | "schedule",
): Promise<PublicationEffect[] | null> {
  const posts = createStudioServices(backendDb, config).posts;
  const preview = posts.preview(actorId, draftId);
  // The choice is whether the generated card also goes to Stories. A site takes
  // it as the page's own illustration either way, and a Studio with neither has
  // nothing to answer -- asking there was a question about nobody.
  if (!storyCardUse(preview.targets).stories) return null;
  const cards = preview.storyCards;
  if (cards.length === 0) return null;
  const locale = settingsService(backendDb).locale(actorId);
  if (!cardsReady(cards)) {
    const effects: PublicationEffect[] = [{ type: "toast", text: t(locale, "post.story-cards-generating") }];
    queueStoryCardChoice(ctx, backendDb, config, actorId, draftId, intent);
    return effects;
  }
  return [...sendStoryCardChoice(backendDb, actorId, draftId, intent, cards)];
}

const pendingStoryCardChoices = new Map<string, Promise<void>>();

/** The Story worker owns rendering. This lightweight continuation only waits
 * for its durable result and sends the choice as a follow-up Telegram message. */
function queueStoryCardChoice(
  ctx: Context,
  backendDb: BackendDb,
  config: BackendConfig,
  actorId: number,
  draftId: number,
  intent: "publish" | "schedule",
): void {
  const key = `${actorId}:${draftId}:${intent}`;
  if (pendingStoryCardChoices.has(key)) return;
  const task = waitForStoryCards(ctx, backendDb, config, actorId, draftId, intent).finally(() => pendingStoryCardChoices.delete(key));
  pendingStoryCardChoices.set(key, task);
  void task.catch((error) => {
    logStoryCardChoiceFailure(error, actorId, draftId);
  });
}

async function waitForStoryCards(
  ctx: Context,
  backendDb: BackendDb,
  config: BackendConfig,
  actorId: number,
  draftId: number,
  intent: "publish" | "schedule",
): Promise<void> {
  const posts = createStudioServices(backendDb, config).posts;
  for (let attempt = 0; attempt < STORY_CARD_WAIT_SECONDS; attempt += 1) {
    await delay(1_000);
    const cards = posts.preview(actorId, draftId).storyCards;
    if (!cardsReady(cards)) continue;
    if (isSupersededCard(ctx, backendDb, "post", draftId)) return;
    await executePublicationEffects(ctx, backendDb, sendStoryCardChoice(backendDb, actorId, draftId, intent, cards));
    return;
  }
  // The renderer never finished. The operator tapped Publish and is owed an
  // answer either way, or the publication silently waits on a question that
  // was never asked.
  if (isSupersededCard(ctx, backendDb, "post", draftId)) return;
  const locale = settingsService(backendDb).locale(actorId);
  await executePublicationEffects(ctx, backendDb, [
    {
      type: "message",
      text: t(locale, "post.story-cards-timeout"),
      options: {
        reply_markup: new InlineKeyboard().text(t(locale, "common.back"), publicationCallback("post", "view", [draftId, "overview"])),
      },
      card: { kind: "post", draftId },
    },
  ]);
}

/** How long the Story renderer is given before the operator is told it did not
 * finish. Rendering both cards is seconds of work; a minute means it is stuck. */
const STORY_CARD_WAIT_SECONDS = 60;

function sendStoryCardChoice(
  backendDb: BackendDb,
  actorId: number,
  draftId: number,
  intent: "publish" | "schedule",
  cards: StoryCard[],
): PublicationEffect[] {
  const locale = settingsService(backendDb).locale(actorId);
  const effects: PublicationEffect[] = [];
  for (const card of cards)
    if (card.localPath) effects.push({ type: "photo", path: card.localPath, options: { caption: `Story · ${card.locale.toUpperCase()}` } });
  const keyboard = new InlineKeyboard();
  if (intent === "publish") {
    keyboard
      .text(t(locale, "post.story-cards-all"), publicationCallback("post", "story_publish_all", [draftId]))
      .row()
      .text(t(locale, "post.story-cards-site-only"), publicationCallback("post", "story_publish_site", [draftId]));
  } else {
    keyboard
      .text(t(locale, "post.story-cards-all-schedule"), publicationCallback("post", "story_schedule_all", [draftId]))
      .row()
      .text(t(locale, "post.story-cards-site-only-schedule"), publicationCallback("post", "story_schedule_site", [draftId]));
  }
  keyboard.row().text(t(locale, "common.back"), publicationCallback("post", "view", [draftId, "overview"]));
  effects.push({
    type: "message",
    text: t(locale, "post.story-cards-question"),
    options: { parse_mode: "Markdown", reply_markup: keyboard },
    card: { kind: "post", draftId },
  });
  return effects;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function logStoryCardChoiceFailure(error: unknown, actorId: number, draftId: number): void {
  log("error", "failed to send Story card choice", {
    actorId,
    draftId,
    error: error instanceof Error ? error.message : String(error),
  });
}

/** Every card this draft has, rendered. Naming RU and EN here waited for a card
 * the queue never renders — a locale with no text, or a language this Studio
 * does not publish — and the choice was then never sent. */
function cardsReady(cards: StoryCard[]): boolean {
  return cards.every((card) => card.status === "ready" && card.localPath);
}
