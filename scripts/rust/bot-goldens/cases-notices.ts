import { refreshPostPreviewCard } from "../../../apps/backend/src/bot/progress.js";
import { runTranslationCycle } from "../../../apps/backend/src/content/translation-worker.js";
import { unsafeDb } from "../../../apps/backend/src/db/client.js";
import { sendDailyBackup } from "../../../apps/backend/src/interfaces/telegram/backup.js";
import { consumeTelegramEvents } from "../../../apps/backend/src/interfaces/telegram/event-consumer.js";
import { runNotificationCycle } from "../../../apps/backend/src/notifications/jobs.js";
import { deliverPendingAlerts } from "../../../apps/backend/src/observability/alerts.js";
import { addEnglish, newPost, RU_CHANNELS, TEXT_CHANNELS } from "./cases-post.ts";
import { publishedPost } from "./cases-settled.ts";
import { scheduledVideo, VIDEO_CHANNELS } from "./cases-video.ts";
import { deliverPost, settleVideoTarget } from "./delivery.ts";
import { ADMIN, type Case, fileDownload, type Harness, setHttp } from "./harness.ts";

/** One tick of the Telegram event loop (interfaces/telegram/worker.ts). */
function consumeEvents(h: Harness): Promise<void> {
  return h.trigger("telegram-events tick", () => consumeTelegramEvents(h.backendDb, h.bot, h.config));
}

/** One tick of the alert loop, with the transport the worker hands it:
 * `sendMessage` to the first admin (interfaces/telegram/worker.ts). */
function deliverAlerts(h: Harness): Promise<void> {
  return h.trigger("telegram-alerts tick", () =>
    deliverPendingAlerts(h.backendDb, { sendAlert: async (text) => void (await h.bot.api.sendMessage(ADMIN, text)) }),
  );
}

function recordVideoEvent(h: Harness, type: string, videoTargetId: number): void {
  h.backendDb.events.record({
    ref: "video:1",
    type,
    severity: "error",
    message: `${type} for video #1`,
    details: { videoDraftId: 1, videoTargetId },
  });
  h.note(`Event ${type} recorded for video #1 (target row ${videoTargetId}).`);
}

/** Instagram Reels of video #1 went through Zernio and its outcome is unknown. */
function unresolvedReel(h: Harness): void {
  settleVideoTarget(h, 1, "instagram_reels", {
    status: "verification_required",
    lastError: "Provider response was ambiguous",
    deliveryProvider: "zernio",
    providerAccountId: "acc-instagram",
    providerPostId: "zernio-post-1",
  });
}

/** Zernio is configured and answers GET posts/zernio-post-1 with these platform results. */
function zernioPost(h: Harness, platforms: Array<Record<string, string>>): void {
  h.config.ZERNIO_API_KEY = "zernio-test-key";
  const post = { _id: "zernio-post-1", status: "published", platforms };
  h.note(`ZERNIO_API_KEY set on the config; GET https://zernio.com/api/v1/posts/zernio-post-1 answers ${JSON.stringify(post)}.`);
  setHttp((url) => (url === "https://zernio.com/api/v1/posts/zernio-post-1" ? Response.json(post) : fileDownload(url)));
}

export const NOTICE_CASES: Case[] = [
  {
    id: "notice-post-reminder",
    area: "notices",
    specRef: "§10 #86; §7.2 reminder (post)",
    channels: RU_CHANNELS,
    run: async (h) => {
      await newPost(h);
      await h.tapData("p:post:schedule:1");
      await h.tapData("p:post:view:1:schedule_ru");
      await h.tapData("p:post:view:1:schedule_ru_evening");
      await h.tapData("p:post:sched_pick:1:ru:1800");
      h.clock("2026-08-20T14:56:00.000Z");
      h.note("Clock moved to 2026-08-20T14:56:00Z (4 minutes before the 18:00 MSK slot).");
      await h.trigger("notification jobs cycle", () => runNotificationCycle(h.backendDb));
      await consumeEvents(h);
    },
  },
  {
    id: "notice-video-reminder",
    area: "notices",
    specRef: "§10 #86; §7.2 reminder (video)",
    channels: VIDEO_CHANNELS,
    run: async (h) => {
      await scheduledVideo(h);
      h.clock("2026-08-20T14:56:00.000Z");
      h.note("Clock moved to 2026-08-20T14:56:00Z (4 minutes before 18:00 MSK).");
      await h.trigger("notification jobs cycle", () => runNotificationCycle(h.backendDb));
      await consumeEvents(h);
    },
  },
  {
    id: "notice-post-completed",
    area: "notices",
    specRef: "§10 #87; §7.1; §7.3 progress repaint; §7.4 completion",
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
      await consumeEvents(h);
      await consumeEvents(h);
    },
  },
  {
    id: "notice-post-failed",
    area: "notices",
    specRef: "§10 #87 (with unlanded controls), #90 alert; §7.4; §7.7 alerts; §5.2.1 retry from a notice",
    channels: TEXT_CHANNELS,
    run: async (h) => {
      await publishedPost(h);
      deliverPost(h, 1, {
        telegram: { status: "failed", error: "Telegram timed out" },
        threads_ru: { status: "published" },
        threads_en: { status: "verification_required", error: "Threads response was ambiguous" },
        site_ru: { status: "published" },
        site_en: { status: "published" },
      });
      await consumeEvents(h);
      await deliverAlerts(h);
      await deliverAlerts(h);
      await h.tapData("p:post:retry:1:telegram:notice");
      await h.tapData("p:post:skip:1:all:notice");
    },
  },
  {
    id: "notice-post-locale-partial",
    area: "notices",
    specRef: "§10 #87 (locale part); §7.4 delivery.post.locale.completed",
    channels: TEXT_CHANNELS,
    run: async (h) => {
      await newPost(h);
      await addEnglish(h);
      await h.tapData("p:post:schedule:1");
      await h.tapData("p:post:sched_scope:1:en_now");
      await h.tapData("p:post:sched_pick:1:ru:1000");
      deliverPost(h, 1, { threads_en: { status: "published" }, site_en: { status: "published" } });
      await consumeEvents(h);
    },
  },
  {
    id: "notice-video-failed",
    area: "notices",
    specRef: "§10 #88; §7.5 failure; §5.2.1 retry (origin notice)",
    channels: VIDEO_CHANNELS,
    run: async (h) => {
      await scheduledVideo(h);
      const target = settleVideoTarget(h, 1, "youtube_shorts", { status: "failed", lastError: "YouTube quota exceeded" });
      recordVideoEvent(h, "video.target.failed", target);
      await consumeEvents(h);
      await h.tapData("p:video:retry:1:youtube_shorts:notice");
    },
  },
  {
    id: "notice-video-unresolved",
    area: "notices",
    specRef: "§10 #89, #45; §7.5 unresolved; §5.2 step 7 card freshness; §5.2.3 settle",
    channels: VIDEO_CHANNELS,
    run: async (h) => {
      await scheduledVideo(h);
      unresolvedReel(h);
      recordVideoEvent(h, "video.target.unresolved", 2);
      await consumeEvents(h);
      zernioPost(h, [
        { platform: "instagram", status: "published", platformPostId: "ig-1", platformPostUrl: "https://instagram.com/reel/abc" },
      ]);
      // From the notice the card is stale (freshCard): the current card is sent below it.
      await h.tapData("p:video:settle:1:instagram_reels");
      await h.tapData("p:video:settle:1:instagram_reels");
    },
  },
  {
    id: "video-settle-accepted",
    area: "notices",
    specRef: "§5.2.3 settle (provider accepted, no platform link yet)",
    channels: VIDEO_CHANNELS,
    run: async (h) => {
      await scheduledVideo(h);
      unresolvedReel(h);
      zernioPost(h, [{ platform: "instagram", status: "processing" }]);
      await h.callback("p:video:view:1:overview", { messageId: h.button("p:video:edit_menu:1", undefined, true).messageId });
      await h.tapData("p:video:settle:1:instagram_reels");
    },
  },
  {
    id: "notice-video-completed",
    area: "notices",
    specRef: "§10 #87 (video); §7.3 video card repaint; §7.4; §5.2.1 retry (origin card)",
    channels: VIDEO_CHANNELS,
    run: async (h) => {
      await scheduledVideo(h);
      settleVideoTarget(h, 1, "youtube_shorts", { status: "published", externalUrl: "https://youtube.com/shorts/abc" });
      settleVideoTarget(h, 1, "instagram_reels", { status: "failed", lastError: "Instagram rejected the media" });
      unsafeDb(h.backendDb).sqlite.prepare("UPDATE video_drafts SET status='partial' WHERE id=1").run();
      h.backendDb.events.record({
        ref: "video:1",
        type: "delivery.video.completed",
        severity: "warn",
        message: "Video #1 completed with 1 failed target(s)",
        details: { videoDraftId: 1, total: 2, failed: 1, awaiting: 0, published: 1 },
      });
      h.backendDb.events.record({
        ref: "video:1",
        type: "video.job.completed",
        severity: "info",
        message: "done",
        details: { videoDraftId: 1 },
      });
      h.note("Video #1 marked partial; delivery.video.completed and video.job.completed recorded.");
      await consumeEvents(h);
      await h.tapData("p:video:retry:1:instagram_reels:card");
    },
  },
  {
    id: "notice-translation-repaint",
    area: "notices",
    specRef: "§7.3 post preview repaint after translation",
    channels: TEXT_CHANNELS,
    env: { DEEPSEEK_API_KEY: "deepseek-test-key" },
    run: async (h) => {
      setHttp((url) =>
        url.startsWith("https://api.deepseek.com/")
          ? Response.json({ choices: [{ message: { content: "First post\n\nA few words about the launch." } }] })
          : fileDownload(url),
      );
      h.note("DEEPSEEK_API_KEY is set; the translator answers 'First post\\n\\nA few words about the launch.'.");
      await newPost(h);
      await h.trigger("telegram-translations tick", async () => {
        for (const draftId of await runTranslationCycle(h.backendDb, h.config))
          await refreshPostPreviewCard(h.backendDb, h.bot, h.config, draftId);
      });
    },
  },
  {
    id: "notice-daily-backup",
    area: "notices",
    specRef: "§10 #91; §7.7 daily backup document and failure notice",
    channels: RU_CHANNELS,
    run: async (h) => {
      h.telegram.opaqueUploads = true;
      h.note("The backup file's bytes are not recorded (sha256/size written as <sqlite backup>).");
      await h.trigger("telegram-daily-backup tick (12:00 MSK)", () => sendDailyBackup(h.config, h.backendDb, h.bot));
      await h.trigger("telegram-daily-backup tick (again the same day)", () => sendDailyBackup(h.config, h.backendDb, h.bot));
      h.clock("2026-08-21T09:00:00.000Z");
      h.telegram.failures.set("sendDocument", [{ error_code: 400, description: "Bad Request: file is too big" }]);
      h.note("Next day: sendDocument answers 400 'Bad Request: file is too big'.");
      await h.trigger("telegram-daily-backup tick (next day)", () => sendDailyBackup(h.config, h.backendDb, h.bot));
    },
  },
];
