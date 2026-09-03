import { describe, expect, it } from "bun:test";
import { splitText } from "../src/delivery/social/payload.js";
import { publishToThreads as publishToThreadsStep } from "../src/delivery/social/threads.js";
import type { PublishResult } from "../src/publishing/errors.js";
import { loadTestConfig } from "./helpers/studio-config.js";

/**
 * Threads publishes in two phases — build a container, then publish it — and
 * almost every production incident here came from the seam between them:
 * a carousel child Meta accepts and then rejects, a thread that stops halfway,
 * a container that never leaves IN_PROGRESS. The tests drive those sequences
 * through a scripted transport instead of asserting on a single happy call.
 */

const config = loadTestConfig({
  THREADS_RU_ACCESS_TOKEN: "threads-token",
  THREADS_RETRY_DELAY_MS: "1",
  THREADS_CONTAINER_TIMEOUT_SECONDS: "1",
});

type Recorded = { endpoint: string; params: Record<string, string> };

async function publishToThreads(
  payload: Record<string, unknown>,
  effectiveConfig: ReturnType<typeof loadTestConfig>,
  fetchImpl: typeof fetch,
  target: "threads_ru" | "threads_en" = "threads_ru",
): Promise<PublishResult> {
  let current = payload;
  for (let step = 0; step < 100; step += 1) {
    const result = await publishToThreadsStep(current, effectiveConfig, fetchImpl, target);
    if (!result.deferred) return result;
    if (!result.resumeKey) throw new Error("deferred Threads step has no resume key");
    current = { ...current, [result.resumeKey]: result.resumeValue };
  }
  throw new Error("Threads test state machine did not finish");
}

/**
 * Threads talks to one host with the endpoint in the path, so the stub routes
 * on that and hands each endpoint a queue of replies. `status` answers the
 * container polls; anything unqueued is a test bug rather than a default.
 */
function transport(replies: { publishIds?: string[]; containerIds?: string[]; statuses?: string[]; permalink?: string }) {
  const calls: Recorded[] = [];
  const containerIds = [...(replies.containerIds ?? [])];
  const publishIds = [...(replies.publishIds ?? [])];
  const statuses = [...(replies.statuses ?? [])];
  const fetchImpl = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = new URL(String(input));
    const endpoint = url.pathname.replace("/v1.0/", "");
    const params: Record<string, string> = {};
    for (const [key, value] of url.searchParams.entries()) params[key] = value;
    if (init?.body instanceof URLSearchParams) for (const [key, value] of init.body.entries()) params[key] = value;
    calls.push({ endpoint, params });
    const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
    if (params.fields === "id,permalink")
      return json({ id: endpoint, permalink: replies.permalink ?? "https://www.threads.net/@a/post/1" });
    if (params.fields === "status,error_message") return json({ status: statuses.shift() ?? "FINISHED" });
    if (endpoint === "me/threads_publish") return json({ id: publishIds.shift() ?? "published" });
    if (endpoint === "me/threads") return json({ id: containerIds.shift() ?? "container" });
    throw new Error(`unexpected Threads endpoint: ${endpoint}`);
  }) as unknown as typeof fetch;
  return { calls, fetchImpl, creations: () => calls.filter((call) => call.endpoint === "me/threads").map((call) => call.params) };
}

describe("publishToThreads", () => {
  it("skips instead of failing when no token is configured", async () => {
    const result = await publishToThreads({ text: "hi" }, loadTestConfig({}), (() => {
      throw new Error("must not call Threads");
    }) as unknown as typeof fetch);
    expect(result).toEqual({ skipped: true, reason: "missing THREADS_RU_ACCESS_TOKEN" });
  });

  it("uses the selected account token without rewriting the shared config", async () => {
    const { fetchImpl, creations } = transport({});
    const bilingual = loadTestConfig({ THREADS_RU_ACCESS_TOKEN: "ru-token", THREADS_EN_ACCESS_TOKEN: "en-token" });

    await publishToThreads({ text: "hello" }, bilingual, fetchImpl, "threads_en");

    expect(creations()[0]?.access_token).toBe("en-token");
    expect(bilingual.THREADS_RU_ACCESS_TOKEN).toBe("ru-token");
  });

  it("publishes a text post and rewrites the permalink onto threads.com", async () => {
    const { fetchImpl, creations } = transport({ permalink: "https://www.threads.net/@alex/post/abc" });
    const result = await publishToThreads({ text: "hello" }, config, fetchImpl);

    expect(creations()[0]).toMatchObject({ media_type: "TEXT", text: "hello" });
    expect(result.ok).toBe(true);
    expect(result.url).toBe("https://www.threads.com/@alex/post/abc");
  });

  it("persists the container after one API call instead of polling in place", async () => {
    const { fetchImpl, calls } = transport({ containerIds: ["c1"] });
    const result = await publishToThreadsStep({ text: "hello" }, config, fetchImpl);

    expect(calls).toHaveLength(1);
    expect(result).toMatchObject({ deferred: true, retryAfterMs: 250, state: "wait_primary" });
    expect(result.resumeValue).toMatchObject({ containerId: "c1", stage: "wait_primary" });
  });

  it("attaches a single image to the first container rather than posting it separately", async () => {
    const { fetchImpl, creations } = transport({});
    await publishToThreads({ text: "look", media: [{ type: "IMAGE", vpsUrl: "https://cdn/1.jpg" }] }, config, fetchImpl);
    expect(creations()[0]).toMatchObject({ media_type: "IMAGE", text: "look", image_url: "https://cdn/1.jpg" });
  });

  it("ignores media that has no public URL, since Threads fetches it itself", async () => {
    const { fetchImpl, creations } = transport({});
    await publishToThreads({ text: "local only", media: [{ type: "IMAGE", localPath: "/tmp/x.jpg" }] }, config, fetchImpl);
    expect(creations()[0]).toMatchObject({ media_type: "TEXT" });
  });

  it("builds a carousel from several items and captions only the parent", async () => {
    const { fetchImpl, creations } = transport({ containerIds: ["child-1", "child-2", "parent"] });
    await publishToThreads(
      {
        text: "gallery",
        media: [
          { type: "IMAGE", vpsUrl: "https://cdn/1.jpg" },
          { type: "VIDEO", vpsUrl: "https://cdn/2.mp4" },
        ],
      },
      config,
      fetchImpl,
    );
    const [first, second, parent] = creations();
    expect(first).toMatchObject({ media_type: "IMAGE", is_carousel_item: "true", image_url: "https://cdn/1.jpg" });
    expect(second).toMatchObject({ media_type: "VIDEO", is_carousel_item: "true", video_url: "https://cdn/2.mp4" });
    expect(parent).toMatchObject({ media_type: "CAROUSEL", text: "gallery", children: "child-1,child-2" });
  });

  it("rebuilds the carousel once when Meta rejects children it had already accepted", async () => {
    // 4279004 arrives at the parent, after each child reported FINISHED. Those
    // ids are dead, so the only repair is a fresh set.
    let parentAttempts = 0;
    const { calls, fetchImpl } = transport({});
    const failingFirstParent = (async (input: URL | RequestInfo, init?: RequestInit) => {
      const isParent = init?.body instanceof URLSearchParams && init.body.get("media_type") === "CAROUSEL";
      if (isParent) {
        parentAttempts += 1;
        if (parentAttempts === 1) return new Response(JSON.stringify({ error: { message: "Invalid carousel 4279004" } }), { status: 400 });
      }
      return fetchImpl(input, init);
    }) as unknown as typeof fetch;

    const result = await publishToThreads(
      {
        text: "gallery",
        media: [
          { type: "IMAGE", vpsUrl: "https://cdn/1.jpg" },
          { type: "IMAGE", vpsUrl: "https://cdn/2.jpg" },
        ],
      },
      config,
      failingFirstParent,
    );
    expect(parentAttempts).toBe(2);
    expect(result.ok).toBe(true);
    // Children were rebuilt too, not reused: four child creations in total.
    expect(calls.filter((call) => call.params.is_carousel_item === "true")).toHaveLength(4);
  });

  it("gives up rather than looping when the carousel keeps being rejected", async () => {
    const alwaysInvalid = (async (input: URL | RequestInfo, init?: RequestInit) => {
      const params = init?.body instanceof URLSearchParams ? init.body : new URLSearchParams();
      if (params.get("media_type") === "CAROUSEL")
        return new Response(JSON.stringify({ error: { message: "Invalid carousel 4279004" } }), { status: 400 });
      const url = new URL(String(input));
      if (url.searchParams.get("fields") === "status,error_message")
        return new Response(JSON.stringify({ status: "FINISHED" }), { status: 200 });
      return new Response(JSON.stringify({ id: "child" }), { status: 200 });
    }) as unknown as typeof fetch;
    await expect(
      publishToThreads(
        {
          text: "gallery",
          media: [
            { type: "IMAGE", vpsUrl: "https://cdn/1.jpg" },
            { type: "IMAGE", vpsUrl: "https://cdn/2.jpg" },
          ],
        },
        config,
        alwaysInvalid,
      ),
    ).rejects.toThrow();
  });

  it("publishes exactly the limit, and refuses one character more", async () => {
    const exact = transport({ publishIds: ["p1"], containerIds: ["c1"] });
    const atLimit = await publishToThreads({ text: "a".repeat(500) }, config, exact.fetchImpl);
    expect(atLimit.ok).toBe(true);
    expect(exact.creations()[0]?.text).toHaveLength(500);

    // The publisher enforces the limit itself, not only preflight: a payload can
    // reach delivery from a queue written before the rule existed.
    const over = transport({ publishIds: ["p1"], containerIds: ["c1"] });
    const result = await publishToThreads({ text: "a".repeat(501) }, config, over.fetchImpl);
    expect(over.creations()).toHaveLength(0);
    expect(result.error).toBe("threads_text_too_long:501/500");
  });

  it("keeps or drops a boundary link exactly as preflight and the preview decided", async () => {
    const url = "https://example.com/guide";
    const entities = [{ type: "text_link", offset: 0, length: 5, url }];
    // "\n\n🔗 " is 5 UTF-16 units, the url 25: 470 fits, 471 does not.
    const fits = transport({ publishIds: ["p1"], containerIds: ["c1"] });
    await publishToThreads({ text: "a".repeat(470), entities }, config, fits.fetchImpl);
    expect(fits.creations()[0]?.text).toContain(`🔗 ${url}`);

    const doesNot = transport({ publishIds: ["p1"], containerIds: ["c1"] });
    await publishToThreads({ text: "a".repeat(471), entities }, config, doesNot.fetchImpl);
    expect(doesNot.creations()[0]?.text).not.toContain(url);
  });

  it("refuses text that does not fit one post instead of chaining a reply", async () => {
    const { fetchImpl, creations } = transport({ publishIds: ["p1"], containerIds: ["c1"] });
    const result = await publishToThreads({ text: `${"a".repeat(500)} tail` }, config, fetchImpl);

    // Nothing is published: a truncated first half live on Threads is worse than
    // a failed target the author can fix in the draft.
    expect(creations()).toHaveLength(0);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("threads_text_too_long");
  });

  it("builds the reply chain when the draft carries the author's waiver", async () => {
    const { fetchImpl, creations } = transport({ publishIds: ["p1", "p2"], containerIds: ["c1", "c2"] });
    const result = await publishToThreads({ text: `${"a".repeat(500)} tail`, threadsChainApproved: true }, config, fetchImpl);

    expect(creations()).toHaveLength(2);
    // The continuation is a reply to what was just published, not a second
    // independent post.
    expect(creations()[1]).toMatchObject({ media_type: "TEXT", reply_to_id: "p1" });
    expect(result.ids).toEqual(["p1", "p2"]);
  });

  it("resumes a chain from what it already published instead of posting the first message twice", async () => {
    const { fetchImpl, creations } = transport({ publishIds: ["p2"], containerIds: ["c2"] });
    const result = await publishToThreads(
      {
        text: `${"a".repeat(500)} tail`,
        threadsChainApproved: true,
        _threadsState: {
          stage: "create_reply",
          childIds: [],
          itemIndex: 0,
          publishedIds: ["p1"],
          partIndex: 1,
          polls: 0,
          carouselRebuilds: 0,
          startedAtMs: Date.now(),
        },
      },
      config,
      fetchImpl,
    );

    // One creation, and it is the reply: the first message is live and asking
    // for it again is a second copy in front of the audience, not a retry.
    expect(creations()).toHaveLength(1);
    expect(creations()[0]).toMatchObject({ media_type: "TEXT", reply_to_id: "p1" });
    expect(result.ids).toEqual(["p1", "p2"]);
    expect(result.ok).toBe(true);
    expect(result.verification).toMatchObject({ status: "verified", providerId: "p1" });
  });

  it("publishes text that fits as a single post, keeping a typed url and one hidden link", async () => {
    const { fetchImpl, creations } = transport({ publishIds: ["p1"], containerIds: ["c1"] });
    const payload = {
      text: "Short post https://example.com/typed",
      entities: [
        { type: "text_link", offset: 0, length: 5, url: "https://example.com/first" },
        { type: "text_link", offset: 6, length: 4, url: "https://example.com/second" },
      ],
    };
    const result = await publishToThreads(payload, config, fetchImpl);

    expect(creations()).toHaveLength(1);
    // Exactly one hidden link is appended — the first — and the typed url stays
    // where the author put it.
    expect(creations()[0]).toMatchObject({
      media_type: "TEXT",
      text: "Short post https://example.com/typed\n\n🔗 https://example.com/first",
    });
    expect(creations()[0]).not.toHaveProperty("reply_to_id");
    expect(result.ids).toEqual(["p1"]);
  });

  it("fails loudly when a container ends in ERROR", async () => {
    const { fetchImpl } = transport({ statuses: ["ERROR"] });
    await expect(publishToThreads({ text: "hello" }, config, fetchImpl)).rejects.toThrow(/failed/);
  });

  it("stops waiting once the container timeout passes", async () => {
    const { fetchImpl } = transport({ statuses: ["IN_PROGRESS", "IN_PROGRESS", "IN_PROGRESS"] });
    let now = 0;
    let payload: Record<string, unknown> = { text: "hello" };
    let failure: unknown;
    for (let step = 0; step < 5; step += 1) {
      try {
        const result = await publishToThreadsStep(payload, config, fetchImpl, "threads_ru", () => now);
        if (!result.deferred || !result.resumeKey) break;
        payload = { ...payload, [result.resumeKey]: result.resumeValue };
        now += Number(result.retryAfterMs ?? 0);
      } catch (error) {
        failure = error;
        break;
      }
    }
    expect(String(failure)).toContain("timed out");
  });

  it("hands a throttled call back to the durable queue without sleeping", async () => {
    let attempts = 0;
    const { fetchImpl } = transport({});
    const throttledOnce = (async (input: URL | RequestInfo, init?: RequestInit) => {
      if (String(input).endsWith("me/threads") && init?.body) {
        attempts += 1;
        if (attempts === 1) return new Response("rate limited", { status: 429 });
      }
      return fetchImpl(input, init);
    }) as unknown as typeof fetch;
    await expect(publishToThreadsStep({ text: "hello" }, config, throttledOnce)).rejects.toThrow("429");
    expect(attempts).toBe(1);
  });
});

describe("splitText", () => {
  it("never cuts a surrogate pair in half", () => {
    // No spaces, so there is no word boundary to fall back on and the cut lands
    // on the limit itself — with the emoji straddling it.
    const parts = splitText(`${"a".repeat(9)}👨🏽‍🚀${"b".repeat(9)}`, 10);
    for (const part of parts) expect(part).toBe(part.normalize());
    expect(parts.join("")).not.toContain("�");
    expect(parts.some((part) => /[\ud800-\udbff]$/.test(part))).toBe(false);
    expect(parts.join("")).toContain("👨🏽‍🚀");
  });
});
