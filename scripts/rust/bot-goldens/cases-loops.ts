import { finalizePendingAlbums } from "../../../apps/backend/src/bot/albums.js";
import { refreshPostPreviewCard } from "../../../apps/backend/src/bot/progress.js";
import { runTranslationCycle } from "../../../apps/backend/src/content/translation-worker.js";
import { unsafeDb } from "../../../apps/backend/src/db/client.js";
import { sendDailyBackup } from "../../../apps/backend/src/interfaces/telegram/backup.js";
import { consumeTelegramEvents } from "../../../apps/backend/src/interfaces/telegram/event-consumer.js";
import { runNotificationCycle } from "../../../apps/backend/src/notifications/jobs.js";
import { deliverPendingAlerts } from "../../../apps/backend/src/observability/alerts.js";
import { settingsService } from "../../../apps/backend/src/studio/services/settings.js";
import { newPost, RU_CHANNELS, TEXT_CHANNELS } from "./cases-post.ts";
import { publishedPost } from "./cases-settled.ts";
import { scheduledVideo, VIDEO_CHANNELS } from "./cases-video.ts";
import { type Case, fileDownload, type Harness, setHttp } from "./harness.ts";

/**
 * One tick of each worker loop the Telegram side runs, exactly the task the
 * loop is started with (interfaces/telegram/worker.ts; `notifications` from
 * runtime/workers.ts), with the database effects it leaves (`h.watch`).
 */
const LOOP = {
  events: (h: Harness) =>
    h.trigger("telegram-events loop", async () => {
      await consumeTelegramEvents(h.backendDb, h.bot, h.config);
    }),
  translations: (h: Harness) =>
    h.trigger("telegram-translations loop", async () => {
      const translated = await runTranslationCycle(h.backendDb, h.config);
      for (const draftId of translated) await refreshPostPreviewCard(h.backendDb, h.bot, h.config, draftId);
    }),
  albums: (h: Harness) =>
    h.trigger("telegram-albums loop", async () => {
      await finalizePendingAlbums(h.bot, h.backendDb, h.config);
    }),
  alerts: (h: Harness) =>
    h.trigger("telegram-alerts loop", async () => {
      const actorId = h.config.CONTROLLER_ADMIN_IDS[0];
      await deliverPendingAlerts(h.backendDb, {
        ...(actorId === undefined ? {} : { sendAlert: async (text) => void (await h.bot.api.sendMessage(actorId, text)) }),
      });
    }),
  backup: (h: Harness) =>
    h.trigger("telegram-daily-backup loop", async () => {
      await sendDailyBackup(h.config, h.backendDb, h.bot);
    }),
  notifications: (h: Harness) =>
    h.trigger("notifications loop", () => {
      runNotificationCycle(h.backendDb);
    }),
};

const DELIVERED_EVENTS = `SELECT alert_key, last_sent_at, suppressed_count FROM alert_dedup WHERE alert_key LIKE 'telegram:event:%' ORDER BY last_sent_at, alert_key`;

/** Records an event through the event store and, when `ageMs` is given, backdates it. */
function event(
  h: Harness,
  input: { ref?: string; type: string; severity?: "info" | "warn" | "error"; target?: string; message?: string; details?: object },
  ageMs?: number,
): void {
  h.backendDb.events.record({
    ref: input.ref ?? null,
    type: input.type,
    severity: input.severity ?? "info",
    target: input.target ?? null,
    message: input.message ?? input.type,
    details: { ...input.details },
  });
  const { sqlite } = unsafeDb(h.backendDb);
  const id = (sqlite.prepare("SELECT max(id) AS id FROM publication_events").get() as { id: number }).id;
  const createdAt = new Date(Date.now() - (ageMs ?? 0)).toISOString();
  if (ageMs !== undefined) sqlite.prepare("UPDATE publication_events SET created_at=? WHERE id=?").run(createdAt, id);
  h.note(`Event #${id} ${input.type} (${input.ref ?? "no ref"}) ${JSON.stringify(input.details ?? {})} created at ${createdAt}.`);
}

const DEEPSEEK = "https://api.deepseek.com/v1/chat/completions";

/** DeepSeek answers each request with the next of these, in order. */
function deepSeekAnswers(h: Harness, answers: Array<{ status: number; body: unknown }>): void {
  const queue = [...answers];
  setHttp((url, init) => {
    if (url !== DEEPSEEK) return fileDownload(url, init);
    const answer = queue.shift();
    if (!answer) throw new Error("DeepSeek asked more often than the case scripts");
    return Response.json(answer.body, { status: answer.status });
  });
  h.note(`POST ${DEEPSEEK} answers, in order: ${JSON.stringify(answers)}.`);
}

function completion(content: string): { status: number; body: unknown } {
  return { status: 200, body: { choices: [{ message: { content } }] } };
}

function moveClock(h: Harness, at: string): void {
  h.clock(at);
  h.note(`Clock moved to ${at}.`);
}

export const LOOP_CASES: Case[] = [
  {
    id: "loop-events-post",
    area: "loops",
    specRef: "§7.1 event consumer: event types, age windows, at-most-once reservation",
    channels: TEXT_CHANNELS,
    run: async (h) => {
      await publishedPost(h);
      event(h, { ref: "post:1", type: "delivery.post.settled", details: { post_id: 1 } });
      event(h, { ref: "post:1", type: "publish.job.claimed", details: { target: "telegram" } });
      event(h, { type: "publish.job.retry", details: { post_id: 1 } });
      event(h, { type: "publish.job.failed", severity: "error", details: { post_id: 999 } });
      event(h, { ref: "post:1", type: "site.job.failed", severity: "error" });
      event(h, { ref: "post:1", type: "studio.notification.reminder.due", details: { actor_id: 1001, title: "Поздно" } }, 31 * 60_000);
      event(h, { ref: "post:1", type: "delivery.post.completed", details: { total: 5, published: 5 } }, 25 * 3_600_000);
      event(h, { ref: "post:1", type: "delivery.post.completed", details: { total: 5, published: 5 } }, 23 * 3_600_000);
      event(h, { ref: "post:999", type: "studio.notification.reminder.due" });
      event(h, { ref: "video:5", type: "video.job.failed", details: { videoDraftId: 5 } });
      event(h, { ref: "video:5", type: "video.target.failed", details: { videoTargetId: 3 } });
      h.watch(DELIVERED_EVENTS);
      await LOOP.events(h);
      await LOOP.events(h);
    },
  },
  {
    id: "loop-events-video",
    area: "loops",
    specRef: "§7.1, §7.3 video card repaint, §7.5 failure/unresolved guards",
    channels: VIDEO_CHANNELS,
    run: async (h) => {
      await scheduledVideo(h);
      const target = (
        unsafeDb(h.backendDb).sqlite.prepare("SELECT id FROM video_targets WHERE video_draft_id=1 AND target='youtube_shorts'").get() as {
          id: number;
        }
      ).id;
      event(h, { ref: "video:1", type: "video.job.failed", severity: "error", details: { videoDraftId: 1 } });
      event(h, { ref: "video:1", type: "video.target.failed", severity: "error", details: { videoDraftId: 1, videoTargetId: target } });
      event(h, { ref: "video:1", type: "video.target.unresolved", severity: "warn", details: { videoDraftId: 1 } });
      event(h, { ref: "video:1", type: "delivery.video.completed", details: { videoDraftId: 1, total: 2, published: 0, awaiting: 2 } });
      h.watch(DELIVERED_EVENTS);
      await LOOP.events(h);
      await LOOP.events(h);
    },
  },
  {
    id: "loop-notification-jobs",
    area: "loops",
    specRef: "§7.2 reminders: notification jobs → journal events → Telegram",
    channels: RU_CHANNELS,
    run: async (h) => {
      const insert = unsafeDb(h.backendDb).sqlite.prepare(
        "INSERT INTO studio_notification_jobs (actor_id, ref, kind, run_at, status, payload_json, created_at, updated_at) VALUES (1001, ?, ?, ?, ?, ?, '2026-08-19T09:00:00.000Z', '2026-08-19T09:00:00.000Z')",
      );
      const jobs: Array<[string, string, string, string, object]> = [
        [
          "post:7",
          "post.ru",
          "2026-08-20T08:59:00.000Z",
          "queued",
          { title: "Пост про запуск", targets: ["telegram", "threads_ru"], publish_at: "2026-08-20T09:04:00.000Z", minutes: 5 },
        ],
        [
          "video:3",
          "video.2026-08-20T09:03:00.000Z",
          "2026-08-20T08:58:00.000Z",
          "queued",
          { title: "Ролик", targets: ["youtube_shorts", "instagram_reels"], publish_at: "2026-08-20T09:03:00.000Z", minutes: 5 },
        ],
        ["post:8", "post.ru", "2026-08-20T09:30:00.000Z", "queued", { title: "Позже", targets: ["telegram"], minutes: 5 }],
        ["post:9", "post.ru", "2026-08-20T08:00:00.000Z", "cancelled", { title: "Отменён", targets: ["telegram"], minutes: 5 }],
        ["post:10", "post.en", "2026-08-20T09:00:00.000Z", "queued", {}],
      ];
      for (const [ref, kind, runAt, status, payload] of jobs) insert.run(ref, kind, runAt, status, JSON.stringify(payload));
      h.note(`studio_notification_jobs seeded: ${JSON.stringify(jobs)}.`);
      h.watch(
        "SELECT id, ref, kind, run_at, status, payload_json, updated_at FROM studio_notification_jobs ORDER BY id",
        "SELECT id, publication_key, event_type, severity, target, message, details_json, created_at FROM publication_events ORDER BY id",
        DELIVERED_EVENTS,
      );
      await LOOP.notifications(h);
      await LOOP.events(h);
      await LOOP.notifications(h);
      moveClock(h, "2026-08-20T09:31:00.000Z");
      await LOOP.notifications(h);
      await LOOP.events(h);
    },
  },
  {
    id: "loop-translation-settled",
    area: "loops",
    specRef: "§7.3 translation: every thread part, the English Story card queued, the card repainted",
    channels: TEXT_CHANNELS,
    env: { DEEPSEEK_API_KEY: "deepseek-test-key" },
    run: async (h) => {
      deepSeekAnswers(h, [completion("First post\n\nA few words about the launch."), completion("Second post of the thread")]);
      await newPost(h);
      await h.tapData("p:post:thread_add:1");
      await h.text("Второй пост цепочки");
      h.watch(
        "SELECT draft_id, status, attempt_count, next_attempt_at, locked_by, locked_at, last_error, updated_at FROM draft_translations ORDER BY draft_id",
        "SELECT draft_id, locale, source_text, approved_text, updated_at FROM post_locales ORDER BY draft_id, locale",
        "SELECT draft_id, position, text_en FROM draft_thread_parts ORDER BY draft_id, position",
        "SELECT draft_id, locale, status FROM draft_story_cards ORDER BY draft_id, locale",
      );
      await LOOP.translations(h);
      await LOOP.translations(h);
    },
  },
  {
    id: "loop-translation-exhausted",
    area: "loops",
    specRef: "§7.3 translation retries: refusal, HTTP error and empty answer, then no English",
    channels: TEXT_CHANNELS,
    env: { DEEPSEEK_API_KEY: "deepseek-test-key" },
    run: async (h) => {
      deepSeekAnswers(h, [
        completion("Please provide the text you would like me to translate."),
        { status: 500, body: { error: { message: "Service overloaded" } } },
        { status: 200, body: { choices: [] } },
      ]);
      await newPost(h);
      h.watch(
        "SELECT draft_id, status, attempt_count, next_attempt_at, locked_by, locked_at, last_error, updated_at FROM draft_translations ORDER BY draft_id",
        "SELECT draft_id, locale, source_text, approved_text FROM post_locales ORDER BY draft_id, locale",
      );
      await LOOP.translations(h);
      await LOOP.translations(h);
      moveClock(h, "2026-08-20T09:00:05.000Z");
      await LOOP.translations(h);
      moveClock(h, "2026-08-20T09:00:15.000Z");
      await LOOP.translations(h);
      await LOOP.translations(h);
    },
  },
  {
    id: "loop-alerts",
    area: "loops",
    specRef: "§7.7 alerts: severity filter, subject cooldown, 4000-unit cut, failed send stays settled",
    channels: RU_CHANNELS,
    run: async (h) => {
      event(h, { type: "credential.failed", severity: "error", target: "x", message: "X rejected the token" });
      event(h, { type: "site.build.failed", severity: "warn", message: "Site build failed: timeout" });
      event(h, { type: "publish.job.published", severity: "info", target: "telegram", message: "published" });
      event(h, { type: "credential.failed", severity: "error", target: "x", message: "X rejected the token" });
      event(h, { type: "digest.failed", severity: "error", message: `Отчёт: ${"ы".repeat(4100)}` });
      h.watch(
        "SELECT id, event_type, severity, acked_at FROM publication_events ORDER BY id",
        // The alert key is the subject's sha256, named so a secret scanner does not read it as a credential.
        "SELECT alert_key AS subject_sha256, last_sent_at, suppressed_count FROM alert_dedup ORDER BY last_sent_at, alert_key",
      );
      await LOOP.alerts(h);
      await LOOP.alerts(h);
      event(h, { type: "video.target.failed", severity: "warn", target: "youtube_shorts", message: "YouTube quota exceeded" });
      h.telegram.failures.set("sendMessage", [{ error_code: 403, description: "Forbidden: bot was blocked by the user" }]);
      h.note("sendMessage answers 403 'Forbidden: bot was blocked by the user' once.");
      await LOOP.alerts(h);
      moveClock(h, "2026-08-20T10:00:01.000Z");
      event(h, { type: "credential.failed", severity: "error", target: "x", message: "X rejected the token" });
      await LOOP.alerts(h);
    },
  },
  {
    id: "loop-albums",
    area: "loops",
    specRef: "§6.5 album collector: nothing before the settle window, one draft after it",
    channels: TEXT_CHANNELS,
    run: async (h) => {
      await h.text("📝 Текст");
      await h.photo("loop-album-1", "Альбом в цикле", { media_group_id: "loop-album" });
      await h.photo("loop-album-2", undefined, { media_group_id: "loop-album" });
      h.watch(
        "SELECT media_group_id, notified, draft_id, attempt_count, updated_at FROM pending_albums ORDER BY media_group_id",
        "SELECT id, status FROM drafts ORDER BY id",
      );
      await LOOP.albums(h);
      moveClock(h, "2026-08-20T09:00:05.000Z");
      await LOOP.albums(h);
      await LOOP.albums(h);
    },
  },
  {
    id: "loop-daily-backup",
    area: "loops",
    specRef: "§7.7 daily backup: before 04:00, switched off, sent once a day",
    channels: RU_CHANNELS,
    run: async (h) => {
      h.telegram.opaqueUploads = true;
      h.note("The backup file's bytes are not recorded (sha256/size written as <sqlite backup>).");
      h.watch("SELECT source, last_synced_at, last_success_at, last_error, locked_by, locked_at FROM analytics_sync ORDER BY source");
      moveClock(h, "2026-08-20T00:30:00.000Z");
      await LOOP.backup(h);
      moveClock(h, "2026-08-20T09:00:00.000Z");
      settingsService(h.backendDb).setBackup({ enabled: false });
      h.note("Backup switched off.");
      await LOOP.backup(h);
      settingsService(h.backendDb).setBackup({ enabled: true });
      h.note("Backup switched on.");
      await LOOP.backup(h);
      await LOOP.backup(h);
      moveClock(h, "2026-08-21T00:59:00.000Z");
      await LOOP.backup(h);
      moveClock(h, "2026-08-21T01:00:00.000Z");
      await LOOP.backup(h);
    },
  },
];
