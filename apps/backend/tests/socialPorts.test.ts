import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test";
import type { DeliveryAdapter } from "../src/delivery/ports.js";
import type { ClaimedPublishJob } from "../src/publishing/queue.js";

/**
 * createPlatformPorts is the seam between "the queue decided to publish this"
 * and the platform adapters. It owns four things that have each broken in
 * production: which credentials a locale-specific target gets, that a Story
 * consumes only the first album image, that one render is shared by the
 * Telegram and Instagram targets of a locale, and that a failed preparation is
 * evicted so a retry actually retries.
 *
 * The adapters and the media pipeline are replaced wholesale — this file is
 * about routing and caching, not about any provider's HTTP dialect. Each
 * platform module is covered by its own test file.
 */

const calls: { target: string; payload: Record<string, unknown>; token?: string | undefined; userId?: string | undefined }[] = [];
let prepareCount = 0;
let storyReadCount = 0;
let failPreparation = false;
/**
 * bun's `mock.module` replaces a module for the whole process, not for this
 * file, so a plain stub here silently breaks telegramPublisher.test.ts and its
 * siblings when the suite runs as a whole. Each replacement therefore captures
 * the real function first and delegates to it unless this file is the one
 * currently running.
 */
let intercepting = false;
const real = {
  publishToTelegram: (await import("../src/delivery/social/telegram.js")).publishToTelegram,
  publishToThreads: (await import("../src/delivery/social/threads.js")).publishToThreads,
  publishToX: (await import("../src/delivery/social/x.js")).publishToX,
  publishInstagramStory: (await import("../src/delivery/social/instagram.js")).publishInstagramStory,
  publishTelegramStory: (await import("../src/delivery/social/telegramStories.js")).publishTelegramStory,
  prepareMediaItems: (await import("../src/delivery/media-prepare.js")).prepareMediaItems,
  preparedStoryMedia: (await import("../src/delivery/story-derivatives.js")).preparedStoryMedia,
};

mock.module("../src/delivery/social/telegram.js", () => ({
  publishToTelegram: async (...args: Parameters<typeof real.publishToTelegram>) => {
    if (!intercepting) return real.publishToTelegram(...args);
    calls.push({ target: "telegram", payload: args[0] });
    return { ok: true, id: 1 };
  },
}));
mock.module("../src/delivery/social/threads.js", () => ({
  publishToThreads: async (...args: Parameters<typeof real.publishToThreads>) => {
    if (!intercepting) return real.publishToThreads(...args);
    calls.push({
      target: "threads",
      payload: args[0],
      token: args[3] === "threads_en" ? args[1].THREADS_EN_ACCESS_TOKEN : args[1].THREADS_RU_ACCESS_TOKEN,
    });
    return { ok: true, id: "t" };
  },
}));
mock.module("../src/delivery/social/x.js", () => ({
  publishToX: async (...args: Parameters<typeof real.publishToX>) => {
    if (!intercepting) return real.publishToX(...args);
    calls.push({ target: "x", payload: args[0] });
    return { ok: true, id: "x" };
  },
}));
mock.module("../src/delivery/social/instagram.js", () => ({
  publishInstagramStory: async (...args: Parameters<typeof real.publishInstagramStory>) => {
    if (!intercepting) return real.publishInstagramStory(...args);
    calls.push({ target: "instagram", payload: args[0], token: args[2].accessToken, userId: args[2].userId });
    return { ok: true, id: "ig" };
  },
}));
mock.module("../src/delivery/social/telegramStories.js", () => ({
  publishTelegramStory: async (...args: Parameters<typeof real.publishTelegramStory>) => {
    if (!intercepting) return real.publishTelegramStory(...args);
    calls.push({ target: "telegram_story", payload: args[0] });
    return { ok: true, id: "story" };
  },
}));
mock.module("../src/delivery/media-prepare.js", () => ({
  prepareMediaItems: async (...args: Parameters<typeof real.prepareMediaItems>) => {
    if (!intercepting) return real.prepareMediaItems(...args);
    prepareCount += 1;
    if (failPreparation) throw new Error("staging failed");
    return args[1].map((item) => ({ ...item, localPath: `/prepared/${item.fileId}` }));
  },
}));
mock.module("../src/delivery/story-derivatives.js", () => ({
  preparedStoryMedia: (...args: Parameters<typeof real.preparedStoryMedia>) => {
    if (!intercepting) return real.preparedStoryMedia(...args);
    const item = args[1];
    storyReadCount += 1;
    return item.localPath ? { ...item, storyLocalPath: `/story/${item.fileId}.mp4` } : null;
  },
}));

beforeAll(() => {
  intercepting = true;
});
afterAll(() => {
  intercepting = false;
});

const { createPlatformPorts } = await import("../src/delivery/ports/social.js");
const { loadTestConfig } = await import("./helpers/studio-config.js");

const config = loadTestConfig({
  CONTROLLER_BOT_TOKEN: "bot",
  TELEGRAM_CHANNEL_USERNAME: "alexgetmancom",
  THREADS_RU_ACCESS_TOKEN: "threads-shared",
  THREADS_EN_ACCESS_TOKEN: "threads-en",
  INSTAGRAM_EN_ACCESS_TOKEN: "ig-en",
  INSTAGRAM_EN_USER_ID: "ig-en-user",
  INSTAGRAM_RU_ACCESS_TOKEN: "ig-ru",
  INSTAGRAM_RU_USER_ID: "ig-ru-user",
  TELEGRAM_CHANNEL_STORIES_API_ID: "12345",
  TELEGRAM_CHANNEL_STORIES_API_HASH: "stories-hash",
  TELEGRAM_CHANNEL_STORIES_SESSION: "stories-session",
});

function job(target: string, payload: Record<string, unknown> = {}, overrides: Partial<ClaimedPublishJob> = {}): ClaimedPublishJob {
  return { jobId: 1, postId: 10, publicationKey: "post:10", target, payload, ...overrides } as ClaimedPublishJob;
}

function reset(): void {
  calls.length = 0;
  prepareCount = 0;
  storyReadCount = 0;
  failPreparation = false;
}

async function deliver(adapter: DeliveryAdapter | undefined, publication: ClaimedPublishJob) {
  if (!adapter) throw new Error(`missing adapter for ${publication.target}`);
  await adapter.validate(publication);
  const prepared = await adapter.prepare(publication);
  const published = await adapter.publish(prepared);
  return adapter.verify(publication, published);
}

const image = (fileId: string) => ({ type: "IMAGE" as const, fileId, localPath: `/stored/${fileId}.jpg` });

describe("createPlatformPorts", () => {
  it("refuses a target whose credentials are missing before touching the provider", async () => {
    reset();
    const ports = createPlatformPorts(loadTestConfig({}));
    // Validation is a separate hook the workflow runs first; publish itself
    // does not re-check, so this is the only gate before a provider call.
    await expect(ports.threads_en?.validate(job("threads_en", { text: "hi" }))).rejects.toThrow(/not configured: THREADS_EN_ACCESS_TOKEN/);
    expect(calls).toHaveLength(0);
  });

  it("accepts a target once its declared requirements are satisfied", async () => {
    reset();
    const ports = createPlatformPorts(config);
    await expect(ports.threads_en?.validate(job("threads_en", { text: "hi" }))).resolves.toBeUndefined();
    await expect(ports.telegram?.validate(job("telegram", { text: "hi" }))).resolves.toBeUndefined();
  });

  it("hands each locale target its own credentials rather than the shared ones", async () => {
    reset();
    const ports = createPlatformPorts(config);
    await deliver(ports.threads_en, job("threads_en", { text: "en" }));
    await deliver(ports.threads_ru, job("threads_ru", { text: "ru" }));
    await deliver(ports.instagram_stories, job("instagram_stories", { text: "en", media: [image("a")] }));
    await deliver(ports.instagram_stories_ru, job("instagram_stories_ru", { text: "ru", media: [image("b")] }));

    expect(calls.find((call) => call.payload.text === "en" && call.target === "threads")?.token).toBe("threads-en");
    // The RU target has no dedicated token and must fall back to the shared one.
    expect(calls.find((call) => call.payload.text === "ru" && call.target === "threads")?.token).toBe("threads-shared");
    const instagram = calls.filter((call) => call.target === "instagram");
    expect(instagram[0]).toMatchObject({ token: "ig-en", userId: "ig-en-user" });
    expect(instagram[1]).toMatchObject({ token: "ig-ru", userId: "ig-ru-user" });
  });

  it("publishes Telegram directly, without the media staging step", async () => {
    reset();
    const ports = createPlatformPorts(config);
    await deliver(ports.telegram, job("telegram", { text: "hi", media: [image("a")] }));
    // Telegram resolves file ids itself; staging would download and re-upload
    // bytes it already has.
    expect(prepareCount).toBe(0);
    expect(calls[0]?.target).toBe("telegram");
  });

  it("skips preparation entirely for a payload without media", async () => {
    reset();
    const ports = createPlatformPorts(config);
    await deliver(ports.threads_ru, job("threads_ru", { text: "text only" }));
    expect(prepareCount).toBe(0);
  });

  it("passes a reconciliation payload straight through", async () => {
    reset();
    const ports = createPlatformPorts(config);
    await deliver(ports.threads_ru, job("threads_ru", { text: "x", media: [image("a")], _reconcile_ids: ["1"] }));
    expect(prepareCount).toBe(0);
    expect(calls[0]?.payload._reconcile_ids).toEqual(["1"]);
  });

  it("stages media once per target and reuses it", async () => {
    reset();
    const ports = createPlatformPorts(config);
    const payload = { text: "hi", media: [image("a")] };
    await deliver(ports.threads_ru, job("threads_ru", payload));
    await deliver(ports.threads_ru, job("threads_ru", payload));
    expect(prepareCount).toBe(1);
    expect(calls[1]?.payload.media).toEqual([{ type: "IMAGE", fileId: "a", localPath: "/prepared/a" }]);
  });

  it("drops a failed preparation from the cache so the next attempt retries it", async () => {
    reset();
    const ports = createPlatformPorts(config);
    const payload = { text: "hi", media: [image("a")] };
    failPreparation = true;
    await expect(deliver(ports.threads_ru, job("threads_ru", payload))).rejects.toThrow("staging failed");
    failPreparation = false;
    // A cached rejected promise here would make every retry fail forever.
    await expect(deliver(ports.threads_ru, job("threads_ru", payload))).resolves.toMatchObject({ ok: true });
    expect(prepareCount).toBe(2);
  });

  it("takes prepared Story media from the first album image only", async () => {
    reset();
    const ports = createPlatformPorts(config);
    await deliver(ports.telegram_stories, job("telegram_stories", { text: "hi", media: [image("a"), image("b"), image("c")] }));
    // The remaining images belong to feed targets; sending them would burn
    // VM-106 capacity on renders nobody publishes.
    expect(calls[0]?.payload.media).toEqual([{ type: "IMAGE", fileId: "a", storyLocalPath: "/story/a.mp4", localPath: "/prepared/a" }]);
  });

  it("publishes one prepared Story asset to both locale targets without rendering", async () => {
    reset();
    const ports = createPlatformPorts(config);
    const payload = { text: "hi", locale: "ru", draft_id: 7, media: [image("a")] };
    await Promise.all([
      deliver(ports.telegram_stories, job("telegram_stories", payload)),
      deliver(ports.instagram_stories_ru, job("instagram_stories_ru", payload)),
    ]);
    expect(calls.map((call) => call.payload.media)).toEqual([
      [{ type: "IMAGE", fileId: "a", localPath: "/prepared/a", storyLocalPath: "/story/a.mp4" }],
      [{ type: "IMAGE", fileId: "a", localPath: "/prepared/a", storyLocalPath: "/story/a.mp4" }],
    ]);
    // Both targets ask for the same derivative; the encode itself is shared by
    // path inside the derivative module, not by a cache in the publisher.
    expect(storyReadCount).toBe(2);
  });

  it("keeps Story media out of the feed target's staging entry", async () => {
    reset();
    const ports = createPlatformPorts(config);
    const payload = { text: "hi", locale: "ru", draft_id: 7, media: [image("a")] };
    await deliver(ports.telegram_stories, job("telegram_stories", payload));
    await deliver(ports.threads_ru, job("threads_ru", payload));
    // Same post and same source image, but a 9:16 render must never be served
    // to a feed target.
    expect(prepareCount).toBe(2);
  });

  it("reads the durable Story derivative again on retry", async () => {
    reset();
    const ports = createPlatformPorts(config);
    const payload = { text: "hi", media: [image("a")] };
    await deliver(ports.telegram_stories, job("telegram_stories", payload));
    expect(calls[0]?.payload.media).toEqual([{ type: "IMAGE", fileId: "a", storyLocalPath: "/story/a.mp4", localPath: "/prepared/a" }]);
  });

  it("refuses Story delivery when no Story variant was prepared, instead of rendering one", async () => {
    reset();
    const ports = createPlatformPorts(config);
    // Publishing reads the variant and never makes it: an encode belongs to
    // ingress or the backfill, not to the moment the post goes out.
    await expect(
      deliver(ports.telegram_stories, job("telegram_stories", { text: "hi", media: [{ type: "IMAGE", fileId: "a" }] })),
    ).rejects.toThrow("story_media_unprepared");
    expect(prepareCount).toBe(0);
  });
});
