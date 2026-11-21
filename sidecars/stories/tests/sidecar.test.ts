import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MtArgumentError, tl } from "@mtcute/bun";
import { type Answer, parseStoryRequest, type StoryRequest } from "../src/contract.js";
import { type Deadlines, type StoryClient, sendStory, sendStoryParams } from "../src/send.js";
import { handle, type SidecarOptions } from "../src/server.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stories-sidecar-"));
const video = path.join(dir, "story.mp4");
fs.writeFileSync(video, "MP4");
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

const TOKEN = "t".repeat(40);
const credentials = { apiId: 12345, apiHash: "test-secret-hash", session: path.join(dir, "session") };
const fast: Deadlines = { connectMs: 20, identityMs: 20, sendMs: 20, destroyMs: 20 };
const never = () => new Promise<never>(() => undefined);

/** The body `crates/adapters/tests/behaviour.rs` asserts the Rust client sends. */
const rustBody = (mediaPath = video) => ({
  peer: "studiostories",
  media: { type: "video", path: mediaPath, width: 1080, height: 1920, duration: 12, supportsStreaming: true },
  caption: { text: "Tap here", links: [{ offset: 4, length: 4, url: "https://example.com" }] },
  periodSeconds: 86_400,
});

type Fake = { client: StoryClient; calls: string[]; sent: unknown[] };

function fakeClient(overrides: Partial<Record<keyof StoryClient, () => Promise<unknown>>> = {}): Fake {
  const calls: string[] = [];
  const sent: unknown[] = [];
  const step = (name: keyof StoryClient, fallback: () => Promise<unknown>) => (params?: unknown) => {
    calls.push(name);
    if (name === "sendStory") sent.push(params);
    return (overrides[name] ?? fallback)();
  };
  const client = {
    connect: step("connect", async () => undefined),
    getMe: step("getMe", async () => ({ id: 1 })),
    sendStory: step("sendStory", async () => ({ id: 321 })),
    destroy: step("destroy", async () => undefined),
  } as unknown as StoryClient;
  return { client, calls, sent };
}

function request(body: unknown, init: { token?: string | null; method?: string; url?: string } = {}): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (init.token !== null) headers.authorization = `Bearer ${init.token ?? TOKEN}`;
  return new Request(init.url ?? "http://stories:8790/v1/stories", {
    method: init.method ?? "POST",
    headers,
    ...(init.method === "GET" ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
  });
}

function options(fake: Fake, overrides: Partial<SidecarOptions> = {}): SidecarOptions {
  return { token: TOKEN, credentials, createClient: () => fake.client, log: () => undefined, ...overrides };
}

const story = (body: unknown = rustBody()): StoryRequest => {
  const parsed = parseStoryRequest(body);
  if (!parsed.ok) throw new Error(parsed.reason);
  return parsed.request;
};

describe("the HTTP contract", () => {
  test("posts the Story the Rust client describes and answers its id", async () => {
    const fake = fakeClient();
    const answer = await handle(request(rustBody()), options(fake));
    expect(answer).toEqual({ status: 200, body: { id: 321 } });
    expect(fake.calls).toEqual(["connect", "getMe", "sendStory", "destroy"]);
    expect(fake.sent).toEqual([
      {
        peer: "studiostories",
        media: { type: "video", file: `file:${video}`, width: 1080, height: 1920, duration: 12, supportsStreaming: true },
        caption: { text: "Tap here", entities: [{ _: "messageEntityTextUrl", offset: 4, length: 4, url: "https://example.com" }] },
        period: 86_400,
      },
    ]);
  });

  test("refuses without the bearer token, before reading the body", async () => {
    const fake = fakeClient();
    for (const token of [null, "wrong", `${TOKEN}x`])
      expect(await handle(request(rustBody(), { token }), options(fake))).toEqual({
        status: 401,
        body: { error: { message: "stories_sidecar_unauthorized", sent: false } },
      });
    expect(fake.calls).toEqual([]);
  });

  test("answers health, unknown paths and methods without touching Telegram", async () => {
    const fake = fakeClient();
    expect(await handle(request(null, { method: "GET", url: "http://stories:8790/healthz" }), options(fake))).toBe("healthy");
    expect(await handle(request(rustBody(), { url: "http://stories:8790/v1/story" }), options(fake))).toMatchObject({
      status: 404,
      body: { error: { sent: false } },
    });
    expect(await handle(request(null, { method: "GET" }), options(fake))).toMatchObject({ status: 405, body: { error: { sent: false } } });
    expect(fake.calls).toEqual([]);
  });

  test("rejects malformed requests as not sent", async () => {
    const fake = fakeClient();
    const base = rustBody();
    const invalid: unknown[] = [
      "{not json",
      [],
      { ...base, peer: "" },
      { ...base, periodSeconds: 0 },
      { ...base, periodSeconds: 1.5 },
      { ...base, media: { type: "audio", path: video } },
      { ...base, media: { type: "photo", path: "relative/story.jpg" } },
      { ...base, media: { ...base.media, width: "1080" } },
      { ...base, media: { ...base.media, supportsStreaming: undefined } },
      { ...base, caption: { text: 5, links: [] } },
      { ...base, caption: { text: "Tap here" } },
      { ...base, caption: { text: "Tap here", links: [{ offset: 6, length: 4, url: "https://example.com" }] } },
      { ...base, caption: { text: "Tap here", links: [{ offset: 0, length: 0, url: "https://example.com" }] } },
      { ...base, caption: { text: "Tap here", links: [{ offset: 0, length: 3, url: "" }] } },
    ];
    for (const body of invalid) {
      const answer = (await handle(request(body), options(fake))) as Answer;
      expect(answer.status).toBe(400);
      expect(answer.body).toMatchObject({ error: { sent: false } });
      expect((answer.body as { error: { message: string } }).error.message).toStartWith("invalid_story_request: ");
    }
    expect(fake.calls).toEqual([]);
  });

  test("counts caption offsets in UTF-16 units, as Telegram does", () => {
    const text = "🎬 Tap"; // the emoji is two UTF-16 units
    expect(parseStoryRequest({ ...rustBody(), caption: { text, links: [{ offset: 3, length: 3, url: "https://e.x" }] } }).ok).toBe(true);
    expect(parseStoryRequest({ ...rustBody(), caption: { text, links: [{ offset: 3, length: 4, url: "https://e.x" }] } }).ok).toBe(false);
  });
});

describe("sent or not sent", () => {
  test("nothing configured, or no file, is refused before connecting", async () => {
    const fake = fakeClient();
    expect(await sendStory(story(), null, () => fake.client, fast)).toEqual({
      status: 503,
      body: { error: { message: "missing_channel_story_credentials", sent: false } },
    });
    expect(await sendStory(story(rustBody(path.join(dir, "gone.mp4"))), credentials, () => fake.client, fast)).toMatchObject({
      status: 422,
      body: { error: { sent: false } },
    });
    expect(fake.calls).toEqual([]);
  });

  test("connect and identity failures are not sent, with TypeScript's messages", async () => {
    const cases: [Partial<Record<keyof StoryClient, () => Promise<unknown>>>, string][] = [
      [{ connect: never }, "telegram_channel_story_connect_timeout"],
      [{ connect: async () => Promise.reject(new Error("ECONNREFUSED")) }, "ECONNREFUSED"],
      [{ getMe: never }, "telegram_channel_story_identity_timeout"],
      [{ getMe: async () => Promise.reject(new tl.RpcError(401, "AUTH_KEY_UNREGISTERED")) }, "AUTH_KEY_UNREGISTERED"],
    ];
    for (const [overrides, message] of cases) {
      const fake = fakeClient(overrides);
      const answer = await sendStory(story(), credentials, () => fake.client, fast);
      expect(answer.body).toEqual({ error: { message: expect.stringContaining(message), sent: false } });
      expect(fake.calls).not.toContain("sendStory");
      expect(fake.calls.at(-1)).toBe("destroy");
    }
  });

  test("Telegram refusing sendStory, or mtcute refusing its arguments, is not sent", async () => {
    for (const error of [new tl.RpcError(400, "PEER_ID_INVALID"), new MtArgumentError("caption is too long")]) {
      const fake = fakeClient({ sendStory: async () => Promise.reject(error) });
      const answer = await sendStory(story(), credentials, () => fake.client, fast);
      expect(answer).toEqual({ status: 502, body: { error: { message: error.message, sent: false } } });
    }
  });

  test("a sendStory that times out or breaks otherwise may have posted", async () => {
    const timeout = fakeClient({ sendStory: never });
    expect(await sendStory(story(), credentials, () => timeout.client, fast)).toEqual({
      status: 504,
      body: { error: { message: "telegram_channel_story_timeout", sent: true } },
    });
    const lost = fakeClient({ sendStory: async () => Promise.reject(new Error("connection closed")) });
    expect(await sendStory(story(), credentials, () => lost.client, fast)).toEqual({
      status: 500,
      body: { error: { message: "connection closed", sent: true } },
    });
  });

  test("a stalled teardown does not hold the answer", async () => {
    const fake = fakeClient({ destroy: never });
    expect(await sendStory(story(), credentials, () => fake.client, fast)).toEqual({ status: 200, body: { id: 321 } });
  });
});

describe("what mtcute is given", () => {
  test("a photo with a plain caption when there are no links", () => {
    const params = sendStoryParams(
      story({ ...rustBody(), media: { type: "photo", path: "/data/story.jpg" }, caption: { text: "Hi", links: [] } }),
    );
    expect(params).toEqual({
      peer: "studiostories",
      media: { type: "photo", file: "file:/data/story.jpg" },
      caption: "Hi",
      period: 86_400,
    });
  });
});
