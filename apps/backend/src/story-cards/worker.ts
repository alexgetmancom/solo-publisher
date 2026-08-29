import fs from "node:fs";
import path from "node:path";
import { and, asc, eq, isNull, lt, lte, or } from "drizzle-orm";
import { type BackendDb, unsafeDb } from "../db/client.js";
import { draftStoryCards } from "../db/schema.js";
import type { BackendConfig } from "../foundation/config.js";
import { escapeXml } from "../foundation/html.js";
import { log } from "../foundation/logger.js";
import { recordWorkerState } from "../foundation/runtime/worker-state.js";
import { trackUsageAsync } from "../observability/usage.js";
import { replanScheduledPostAfterStoryCardFailure, replanScheduledPostAfterStoryCards } from "../studio/services/posts.js";
import { buildStoryCardCopy } from "./copy.js";

export const STORY_CARD_MAX_ATTEMPTS = 3;

/** A Story card render is a headless browser shot; past this it is hung. */
export const STORY_CARD_TIMEOUT_SECONDS = 15;

type ClaimedCard = typeof draftStoryCards.$inferSelect & { lockedBy: string; lockedAt: string };

/** Renders at most one queued card. `preferDraftId` puts that draft's cards at the
 * head of the queue: the bot drives this loop synchronously while an editor waits
 * on the Story choice screen, and spending that budget on an unrelated draft's
 * card is what makes the screen time out. */
export async function runStoryCardCycle(config: BackendConfig, backendDb: BackendDb, preferDraftId?: number): Promise<number> {
  recoverStoryCardJobs(backendDb);
  const card = claimStoryCard(backendDb, preferDraftId);
  if (!card) {
    recordWorkerState(backendDb, "story-cards", { claimed: 0 });
    return 0;
  }
  try {
    const output = outputPath(config, card);
    await trackUsageAsync(backendDb, "content.story_card.render", () => renderStoryCard(config, card, output));
    const now = new Date().toISOString();
    unsafeDb(backendDb)
      .db.update(draftStoryCards)
      .set({
        status: "ready",
        localPath: output,
        lockedBy: null,
        lockedAt: null,
        nextAttemptAt: null,
        lastError: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(draftStoryCards.draftId, card.draftId),
          eq(draftStoryCards.locale, card.locale),
          eq(draftStoryCards.status, "rendering"),
          eq(draftStoryCards.lockedBy, card.lockedBy),
        ),
      )
      .run();
    replanScheduledPostAfterStoryCards(backendDb, config, card.draftId);
    recordWorkerState(backendDb, "story-cards", { claimed: 1, published: 1 });
  } catch (error) {
    const attempt = card.attemptCount + 1;
    const retry = attempt < STORY_CARD_MAX_ATTEMPTS;
    const now = new Date().toISOString();
    unsafeDb(backendDb)
      .db.update(draftStoryCards)
      .set({
        status: retry ? "queued" : "failed",
        attemptCount: attempt,
        nextAttemptAt: retry ? new Date(Date.now() + attempt * 5_000).toISOString() : null,
        lockedBy: null,
        lockedAt: null,
        lastError: error instanceof Error ? error.message : String(error),
        updatedAt: now,
      })
      .where(
        and(
          eq(draftStoryCards.draftId, card.draftId),
          eq(draftStoryCards.locale, card.locale),
          eq(draftStoryCards.status, "rendering"),
          eq(draftStoryCards.lockedBy, card.lockedBy),
        ),
      )
      .run();
    if (!retry) {
      try {
        replanScheduledPostAfterStoryCardFailure(backendDb, config, card.draftId);
      } catch (replanError) {
        log("error", "failed to replan after Story card failure", {
          draftId: card.draftId,
          error: replanError instanceof Error ? replanError.message : String(replanError),
        });
      }
    }
    recordWorkerState(backendDb, "story-cards", { claimed: 1, failed: 1 }, error instanceof Error ? error.message : String(error));
  }
  return 1;
}

export function recoverStoryCardJobs(backendDb: BackendDb, staleAfterMs = 60_000): number {
  const cutoff = new Date(Date.now() - staleAfterMs).toISOString();
  const now = new Date().toISOString();
  return (
    unsafeDb(backendDb)
      .db.update(draftStoryCards)
      .set({ status: "queued", lockedBy: null, lockedAt: null, nextAttemptAt: now, updatedAt: now })
      // A row left "rendering" with no lock timestamp cannot age out of a `<
      // cutoff` comparison, so it would stay claimed forever. It is already
      // unowned, so recover it on sight.
      .where(and(eq(draftStoryCards.status, "rendering"), or(isNull(draftStoryCards.lockedAt), lt(draftStoryCards.lockedAt, cutoff))))
      .returning({ draftId: draftStoryCards.draftId })
      .all().length
  );
}

function claimStoryCard(backendDb: BackendDb, preferDraftId?: number): ClaimedCard | null {
  const now = new Date().toISOString();
  const due = and(eq(draftStoryCards.status, "queued"), or(isNull(draftStoryCards.nextAttemptAt), lte(draftStoryCards.nextAttemptAt, now)));
  const order = [asc(draftStoryCards.createdAt), asc(draftStoryCards.draftId), asc(draftStoryCards.locale)] as const;
  const preferred =
    preferDraftId === undefined
      ? undefined
      : unsafeDb(backendDb)
          .db.select()
          .from(draftStoryCards)
          .where(and(due, eq(draftStoryCards.draftId, preferDraftId)))
          .orderBy(...order)
          .get();
  const candidate =
    preferred ??
    unsafeDb(backendDb)
      .db.select()
      .from(draftStoryCards)
      .where(due)
      .orderBy(...order)
      .get();
  if (!candidate) return null;
  const lockId = `story-card:${process.pid}:${crypto.randomUUID()}`;
  const claimed = unsafeDb(backendDb)
    .db.update(draftStoryCards)
    .set({ status: "rendering", lockedBy: lockId, lockedAt: now, updatedAt: now })
    .where(
      and(
        eq(draftStoryCards.draftId, candidate.draftId),
        eq(draftStoryCards.locale, candidate.locale),
        eq(draftStoryCards.status, "queued"),
      ),
    )
    .returning()
    .get();
  return claimed?.lockedBy && claimed.lockedAt ? (claimed as ClaimedCard) : null;
}

async function renderStoryCard(config: BackendConfig, card: ClaimedCard, output: string): Promise<void> {
  const startedAt = Date.now();
  let prepareMs = 0;
  let rendererMs = 0;
  let outputBytes = 0;
  let success = false;
  let failure: unknown;
  try {
    const prepareStartedAt = Date.now();
    fs.mkdirSync(config.STORY_CARD_DIR, { recursive: true });
    const fontConfig = path.join(config.STORY_CARD_DIR, "fontconfig.xml");
    if (!fs.existsSync(fontConfig)) fs.writeFileSync(fontConfig, fontConfigXml(config.STORY_CARD_ASSETS_DIR));
    const copy = buildStoryCardCopy(card.headline);
    copy.emoji = card.emoji;
    copy.headline = card.headline;
    const input = Buffer.from(
      JSON.stringify({
        backgroundPath: path.join(config.STORY_CARD_ASSETS_DIR, "strata-master-background.png"),
        assetsDir: config.STORY_CARD_ASSETS_DIR,
        outputPath: output,
        wordmark: config.studio.site(card.locale === "ru" ? "ru" : "en").name,
        copy,
      }),
    );
    prepareMs = Date.now() - prepareStartedAt;

    const rendererStartedAt = Date.now();
    const child = Bun.spawn([process.execPath, config.STORY_CARD_RENDERER_ENTRY], {
      stdin: input,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, FONTCONFIG_FILE: fontConfig },
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, STORY_CARD_TIMEOUT_SECONDS * 1000);
    try {
      // stdout is drained alongside stderr rather than left unread: an unread pipe
      // that fills stalls the child on write, and the kill above would then read as
      // a render timeout instead of a stuck reader.
      const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text(), new Response(child.stdout).text()]);
      rendererMs = Date.now() - rendererStartedAt;
      if (timedOut) throw new Error(`story_card_renderer_failed: timed out after ${STORY_CARD_TIMEOUT_SECONDS}s`);
      if (exitCode !== 0) throw new Error(`story_card_renderer_failed: ${stderr.slice(0, 800) || `exit ${exitCode}`}`);
      if (!fs.existsSync(output)) throw new Error("story_card_renderer_failed: output missing");
      outputBytes = fs.statSync(output).size;
      success = true;
    } finally {
      clearTimeout(timer);
    }
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    log(success ? "info" : "warn", "operation timing", {
      operation: "content.story_card.render",
      draftId: card.draftId,
      locale: card.locale,
      success,
      totalMs: Date.now() - startedAt,
      prepareMs,
      rendererMs,
      outputBytes,
      ...(failure === undefined ? {} : { error: failure instanceof Error ? failure.message : String(failure) }),
    });
  }
}

function outputPath(config: BackendConfig, card: ClaimedCard): string {
  return path.join(config.STORY_CARD_DIR, `draft-${card.draftId}-${card.locale}-${card.sourceHash.slice(0, 16)}.jpg`);
}

function fontConfigXml(assetsDir: string): string {
  return `<?xml version="1.0"?><!DOCTYPE fontconfig SYSTEM "fonts.dtd"><fontconfig><dir>${escapeXml(
    assetsDir,
  )}</dir><cachedir>/tmp/story-card-font-cache</cachedir></fontconfig>`;
}
