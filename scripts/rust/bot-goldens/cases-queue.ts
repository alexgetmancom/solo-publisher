import { createStudioServices } from "../../../apps/backend/src/studio/services/index.js";
import { createTestVideoDraft } from "../../../apps/backend/tests/helpers/video.js";
import { RU_CHANNELS } from "./cases-post.ts";
import { VIDEO_CHANNELS } from "./cases-video.ts";
import { deliverPost } from "./delivery.ts";
import { ADMIN, type Case, FIXTURE, type Harness } from "./harness.ts";

const QUEUE_CHANNELS = [...RU_CHANNELS, ...VIDEO_CHANNELS];

/** Posts made through the Studio service (the path every transport shares), each
 * scheduled for RU at the given instant. Returns their draft ids. */
function scheduledPosts(h: Harness, items: Array<{ text: string; at: string }>): number[] {
  const posts = createStudioServices(h.backendDb, h.config).posts;
  const ids = items.map(({ text, at }) => {
    const id = posts.create(ADMIN, { text, media: [], entities: [] });
    posts.schedule(ADMIN, id, { ruAt: new Date(at), enAt: null });
    return id;
  });
  h.note(`Scheduled through the Studio service: ${items.map(({ text, at }) => `"${text}" at ${at}`).join("; ")}`);
  return ids;
}

/** Twelve upcoming posts over three days, two video drafts, one long label. */
function busyQueue(h: Harness): void {
  scheduledPosts(h, [
    { text: "Утренний пост, который уже опоздал", at: "2026-08-20T09:10:00.000Z" },
    { text: "Сегодня в обед", at: "2026-08-20T10:00:00.000Z" },
    { text: "Сегодня вечером: очень длинный заголовок, который не помещается в кнопку очереди целиком", at: "2026-08-20T16:00:00.000Z" },
    { text: "Завтра утро", at: "2026-08-21T06:00:00.000Z" },
    { text: "Завтра день", at: "2026-08-21T09:00:00.000Z" },
    { text: "Завтра вечер", at: "2026-08-21T15:00:00.000Z" },
    { text: "Послезавтра 1", at: "2026-08-22T06:00:00.000Z" },
    { text: "Послезавтра 2", at: "2026-08-22T07:00:00.000Z" },
    { text: "Послезавтра 3", at: "2026-08-22T08:00:00.000Z" },
    { text: "Послезавтра 4", at: "2026-08-22T09:00:00.000Z" },
    { text: "Через неделю", at: "2026-08-27T09:00:00.000Z" },
    { text: "Через неделю, вечер", at: "2026-08-27T16:00:00.000Z" },
  ]);
  const retention = h.config.VIDEO_MEDIA_RETENTION_HOURS;
  createTestVideoDraft(h.backendDb, ADMIN, FIXTURE.clip, retention);
  createTestVideoDraft(h.backendDb, ADMIN, FIXTURE.clip, retention);
  h.note("Two video drafts without a label (createTestVideoDraft).");
  // The first post's time is now in the past: it is overdue.
  h.clock("2026-08-20T09:30:00.000Z");
  h.note("Clock moved to 2026-08-20T09:30:00Z after seeding.");
}

/** Eleven published posts whose Telegram delivery failed: eleven attention items. */
function failedPosts(h: Harness): void {
  const posts = createStudioServices(h.backendDb, h.config).posts;
  for (let index = 1; index <= 11; index += 1) {
    const id = posts.create(ADMIN, { text: `Проблемный пост ${index} с *разметкой*`, media: [], entities: [] });
    posts.publish(ADMIN, id);
    deliverPost(h, id, { telegram: { status: "failed", error: "Telegram timed out" }, threads_ru: { status: "published" } });
    h.clock(new Date(Date.now() + 60_000));
  }
}

export const QUEUE_CASES: Case[] = [
  {
    id: "queue-empty",
    area: "queue",
    specRef: "§10 #11 (empty); §4.3",
    channels: QUEUE_CHANNELS,
    run: async (h) => {
      await h.text("☰ Меню");
      await h.tap(/^📋/);
      await h.tapData("menu_home");
    },
  },
  {
    id: "queue-pages",
    area: "queue",
    specRef: "§10 #2 (headline, count), #11; §4.1 headline; §4.3 paging, overdue, day groups",
    channels: QUEUE_CHANNELS,
    run: async (h) => {
      busyQueue(h);
      await h.text("☰ Меню");
      await h.tap(/^📋/);
      await h.tapData("queue_page:1");
      await h.tapData("noop");
      await h.tapData("queue_page:0");
      await h.callback("queue_page:9");
      await h.tapData("p:post:view:11:overview");
      await h.tapData("queue_home");
      await h.tapData("queue_page:1");
      await h.tapData("p:video:view:1:overview");
    },
  },
  {
    id: "queue-attention-pages",
    area: "queue",
    specRef: "§10 #11 (attention row), #12; §4.4 paging",
    channels: QUEUE_CHANNELS,
    run: async (h) => {
      failedPosts(h);
      await h.text("☰ Меню");
      await h.tap(/^📋/);
      await h.tapData("queue_attention");
      await h.tapData("queue_attention_page:1");
      await h.tapData("queue_attention_page:0");
      await h.tapData("queue_home");
    },
  },
  {
    id: "menu-headline-tomorrow",
    area: "queue",
    specRef: "§4.1 headline (⏭ tomorrow, label cut)",
    channels: QUEUE_CHANNELS,
    run: async (h) => {
      scheduledPosts(h, [{ text: "🚀 Запуск новой рубрики про игровые новинки недели", at: "2026-08-21T07:30:00.000Z" }]);
      await h.text("/start");
    },
  },
];
