import { describe, expect, it } from "bun:test";
import type { Bot, Context } from "grammy";
import { runCallbackBoundary } from "../src/bot/callback-boundary.js";
import { handlePublicationCallback } from "../src/bot/callback-router.js";
import { publicationCallback } from "../src/bot/publication-callback.js";
import { publicationTargets, publishJobs } from "../src/db/schema.js";
import { consumeTelegramEvents } from "../src/interfaces/telegram/event-consumer.js";
import { newDeliveryPayload } from "../src/publishing/delivery-payload.js";
import { HttpPublishError } from "../src/publishing/errors.js";
import { claimDuePublishJobs, enqueuePublishJobTx, failPublishJob } from "../src/publishing/queue.js";
import { withDb } from "./helpers/db.js";
import { seedTextPost } from "./helpers/post.js";
import { loadTestConfig } from "./helpers/studio-config.js";

const config = loadTestConfig({ CONTROLLER_ADMIN_IDS: "42" });

describe("post recovery scenario", () => {
  it("notifies once, retries all failed targets once, and exposes no duplicate queue rows", async () =>
    withDb(async (backendDb) => {
      const now = new Date().toISOString();
      seedTextPost(backendDb, {
        draftId: 7,
        postId: 700,
        actorId: 42,
        status: "scheduled",
        targets: { telegram: true, threads_ru: true },
        ru: "Night post",
        en: "Night post",
        now,
      });
      for (const target of ["telegram", "threads_ru"])
        enqueuePublishJobTx(backendDb.db, {
          publicationKey: "post:700",
          target,
          payload: newDeliveryPayload({ text: "Night post" }),
        });

      const claimed = claimDuePublishJobs(backendDb, 2, "scenario-worker");
      expect(claimed).toHaveLength(2);
      for (const job of claimed) failPublishJob(backendDb, job.jobId, new HttpPublishError("Provider rejected the post", 400), job.lockId);

      const messages: Array<{ chatId: number; text: string; options: unknown }> = [];
      const bot = {
        api: {
          sendMessage: async (chatId: number, text: string, options: unknown) => {
            messages.push({ chatId, text, options });
            return { message_id: 1, date: 1, chat: { id: chatId, type: "private" as const } };
          },
        },
      } as unknown as Bot;
      await consumeTelegramEvents(backendDb, bot, config);

      expect(messages).toHaveLength(1);
      expect(messages[0]?.text).toContain("Telegram");
      expect(messages[0]?.text).toContain("Threads");
      expect(JSON.stringify(messages[0]?.options)).toContain("p:post:retry:7:all:notice");

      const answers: Array<{ text?: string } | undefined> = [];
      const retryContext = (id: string, callbackAnswers: Array<{ text?: string } | undefined>): Context =>
        ({
          callbackQuery: { id, data: publicationCallback("post", "retry", [7, "all", "notice"]) },
          from: { id: 42 },
          answerCallbackQuery: async () => true,
          reply: async (text: string) => {
            callbackAnswers.push({ text });
            return true;
          },
        }) as unknown as Context;
      const firstRetry = retryContext("post-recovery-retry", answers);
      await runCallbackBoundary(firstRetry, backendDb, async () => {
        await handlePublicationCallback(firstRetry, backendDb, config);
      });

      expect(answers[0]?.text).toContain("Queued again: 2");
      expect(backendDb.db.select({ status: publishJobs.status }).from(publishJobs).all()).toEqual([
        { status: "queued" },
        { status: "queued" },
      ]);
      expect(backendDb.db.select().from(publishJobs).all()).toHaveLength(2);
      expect(backendDb.db.select({ status: publicationTargets.status }).from(publicationTargets).all()).toEqual([
        { status: "queued" },
        { status: "queued" },
      ]);

      const duplicateAnswers: Array<{ text?: string } | undefined> = [];
      const duplicateRetry = retryContext("post-recovery-retry-again", duplicateAnswers);
      await runCallbackBoundary(duplicateRetry, backendDb, async () => {
        await handlePublicationCallback(duplicateRetry, backendDb, config);
      });

      expect(duplicateAnswers[0]?.text).toContain("Only a failed platform can be retried.");
      expect(backendDb.db.select().from(publishJobs).all()).toHaveLength(2);
    }));
});
