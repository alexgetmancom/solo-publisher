import { addEnglish, newPost, TEXT_CHANNELS } from "./cases-post.ts";
import { deliverPost } from "./delivery.ts";
import type { Case, Harness } from "./harness.ts";

/** Draft 1 published to the text Studio's five default targets, as queued by Publish. */
export async function publishedPost(h: Harness): Promise<void> {
  await newPost(h);
  await addEnglish(h);
  await h.tapData("p:post:publish:1");
  await h.tapData("p:post:publish_confirm:1");
}

/** Telegram timed out, Threads EN refused the text, the rest landed. */
function partlyFailed(h: Harness): void {
  deliverPost(h, 1, {
    telegram: { status: "failed", error: "Telegram timed out" },
    threads_ru: { status: "published" },
    threads_en: { status: "failed", error: "Threads: text is too large" },
    site_ru: { status: "published" },
    site_en: { status: "published" },
  });
}

export const SETTLED_CASES: Case[] = [
  {
    id: "post-settled-overview",
    area: "post",
    specRef: "§10 #15, #42 (issues); §4.5.3 unlanded controls; §5.2.1 retry; §5.2.2 skip",
    channels: TEXT_CHANNELS,
    run: async (h) => {
      await publishedPost(h);
      partlyFailed(h);
      await h.tapData("progress_details:1");
      await h.text("☰ Меню");
      await h.tap(/^📋/);
      await h.tapData("queue_attention");
      await h.tapData("p:post:view:1:overview");
      await h.tapData("p:post:skip:1:threads_en:card");
      await h.tapData("p:post:retry:1:telegram:card");
    },
  },
  {
    id: "post-settled-retry-all",
    area: "post",
    specRef: "§4.5.3; §5.2.1 retry all",
    channels: TEXT_CHANNELS,
    run: async (h) => {
      await publishedPost(h);
      partlyFailed(h);
      await h.callback("p:post:view:1:overview", { messageId: h.button("progress_details:1", undefined, true).messageId });
      await h.tapData("p:post:retry:1:all:card");
    },
  },
  {
    id: "post-settled-skip-all",
    area: "post",
    specRef: "§4.5.3; §5.2.2 skip all",
    channels: TEXT_CHANNELS,
    run: async (h) => {
      await publishedPost(h);
      partlyFailed(h);
      await h.callback("p:post:view:1:overview", { messageId: h.button("progress_details:1", undefined, true).messageId });
      await h.tapData("p:post:skip:1:all:card");
    },
  },
  {
    id: "post-resend",
    area: "post",
    specRef: "§10 #27; §4.5.9; §5.2.2 resend",
    channels: TEXT_CHANNELS,
    run: async (h) => {
      await publishedPost(h);
      deliverPost(h, 1, {
        telegram: { status: "published" },
        threads_ru: { status: "published" },
        threads_en: { status: "published" },
        site_ru: { status: "published" },
        site_en: { status: "published" },
      });
      await h.callback("p:post:view:1:overview", { messageId: h.button("progress_details:1", undefined, true).messageId });
      await h.tapData("p:post:view:1:resend");
      await h.tapData("p:post:resend:1:x");
      await h.tapData("p:post:view:1:overview");
    },
  },
];
