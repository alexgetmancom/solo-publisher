import { and, eq } from "drizzle-orm";
import { firstNonEmptyLine } from "../content/message.js";
import { type BackendDb, unsafeDb } from "../db/client.js";
import { drafts, postLocales, siteJobs } from "../db/schema.js";
import type { BackendConfig } from "../foundation/config.js";
import { jsonObject } from "../json.js";
import { queueDraftStoryCards, readyStoryCardMedia, setStoryPublishMode, storyCardsForDraft } from "../story-cards/store.js";
import { runStoryCardCycle, STORY_CARD_TIMEOUT_SECONDS } from "../story-cards/worker.js";
import { resolvePublicationRef } from "./publication-ref.js";

type LocalePlan = { locale: "ru" | "en"; slug: string; headline: string };

/** Adds generated cards to an already-published site's empty locale media.
 * Social jobs and targets are deliberately outside this operation. */
export async function backfillTextStoryCards(
  backendDb: BackendDb,
  config: BackendConfig,
  input: string,
  apply: boolean,
  force = false,
): Promise<Record<string, unknown>> {
  const ref = resolvePublicationRef(backendDb, input);
  if (!ref?.postId) throw new Error(`publication not found: ${input}`);
  const publication = unsafeDb(backendDb).db.select({ draftId: drafts.id }).from(drafts).where(eq(drafts.postId, ref.postId)).get();
  if (!publication?.draftId) throw new Error(`published draft not found: ${input}`);
  const draft = unsafeDb(backendDb).db.select().from(drafts).where(eq(drafts.id, publication.draftId)).get();
  if (!draft) throw new Error(`draft ${publication.draftId} not found`);
  const sourceLocales = unsafeDb(backendDb).db.select().from(postLocales).where(eq(postLocales.draftId, publication.draftId)).all();
  if (sourceLocales.some((locale) => mediaCount(locale.mediaJson) > 0))
    throw new Error(`draft ${publication.draftId} already has original media`);

  const locales = unsafeDb(backendDb)
    .db.select({
      locale: postLocales.locale,
      slug: postLocales.slug,
      text: postLocales.sourceText,
      mediaJson: postLocales.siteMediaJson,
    })
    .from(postLocales)
    .where(and(eq(postLocales.draftId, publication.draftId), eq(postLocales.siteEnabled, 1)))
    .all();
  const plan = locales
    .filter(
      (locale) =>
        (mediaCount(locale.mediaJson) === 0 || (force && generatedMediaOnly(locale.mediaJson))) &&
        (locale.locale === "ru" || locale.locale === "en"),
    )
    .map(
      (locale): LocalePlan => ({
        locale: locale.locale as "ru" | "en",
        slug: locale.slug ?? String(ref.postId),
        headline: firstNonEmptyLine(locale.text),
      }),
    );
  const base = {
    post_id: ref.postId,
    publication_key: ref.publicationKey,
    draft_id: publication.draftId,
    count: plan.length,
    force,
    plan,
  };
  if (!apply || plan.length === 0) return { ok: true, applied: false, ...base };

  queueDraftStoryCards(unsafeDb(backendDb).db, publication.draftId);
  const cards = await waitForCards(backendDb, config, publication.draftId);
  const now = new Date().toISOString();
  unsafeDb(backendDb).db.transaction((tx) => {
    for (const item of plan) {
      const media = [cards[item.locale]];
      tx.update(postLocales)
        .set({ storyMediaJson: media, siteMediaJson: media, updatedAt: now })
        .where(and(eq(postLocales.draftId, publication.draftId), eq(postLocales.locale, item.locale)))
        .run();
    }
    tx.insert(siteJobs)
      .values({
        publicationKey: ref.publicationKey,
        reason: "text_story_card_backfill",
        status: "queued",
        nextAttemptAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .run();
  });
  setStoryPublishMode(unsafeDb(backendDb).db, publication.draftId, "site_only");
  return { ok: true, applied: true, ...base, cards: storyCardsForDraft(unsafeDb(backendDb).db, publication.draftId) };
}

async function waitForCards(backendDb: BackendDb, config: BackendConfig, draftId: number) {
  const deadline = Date.now() + STORY_CARD_TIMEOUT_SECONDS * 2_000;
  while (Date.now() < deadline) {
    const ready = readyStoryCardMedia(unsafeDb(backendDb).db, draftId);
    if (ready) return ready;
    await runStoryCardCycle(config, backendDb);
    await Bun.sleep(100);
  }
  const states = storyCardsForDraft(unsafeDb(backendDb).db, draftId)
    .map((card) => `${card.locale}:${card.status}`)
    .join(", ");
  throw new Error(`Story card backfill timed out for draft ${draftId}: ${states}`);
}

function mediaCount(value: unknown): number {
  if (Array.isArray(value)) return value.length;
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : [];
    return Array.isArray(parsed) ? parsed.length : 0;
  } catch {
    return 0;
  }
}

function generatedMediaOnly(value: unknown): boolean {
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    return Array.isArray(parsed) && parsed.length > 0 && parsed.every((item) => jsonObject(item).role === "text_story_card");
  } catch {
    return false;
  }
}
