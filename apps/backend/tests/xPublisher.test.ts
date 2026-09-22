import { describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { publishToX } from "../src/delivery/social/x.js";
import { HttpPublishError } from "../src/publishing/errors.js";
import { loadTestConfig } from "./helpers/studio-config.js";

/**
 * X is the only target with a chunked upload protocol — INIT, APPEND per
 * segment, FINALIZE, then poll STATUS — and each step is a separate chance to
 * publish a tweet with no video attached, or to retry an upload that already
 * succeeded. These tests pin the sequence and the error classification.
 */

const config = Object.assign(loadTestConfig({ X_CLIENT_ID: "client-id", X_CLIENT_SECRET: "client-secret" }), {
  X_ACCESS_TOKEN: "access-token",
  X_REFRESH_TOKEN: "refresh-token",
});
const instantSleep = async (_milliseconds: number): Promise<void> => {};

type Call = { url: string; method: string; command?: string | undefined; authorization?: string | undefined };

function transport(handlers: { status?: string[]; tweetResponse?: () => Response } = {}) {
  const calls: Call[] = [];
  const statuses = [...(handlers.status ?? [])];
  const fetchImpl = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers as HeadersInit);
    let command: string | undefined;
    if (init?.body instanceof URLSearchParams) command = init.body.get("command") ?? undefined;
    else if (init?.body instanceof FormData) command = String(init.body.get("command") ?? "") || undefined;
    if (!command) command = new URL(url).searchParams.get("command") ?? undefined;
    if (!command && url.endsWith("/append")) command = "APPEND";
    if (!command && url.endsWith("/finalize")) command = "FINALIZE";
    if (!command && url.endsWith("/initialize")) command = "INIT";
    if (!command && new URL(url).searchParams.has("media_id")) command = "STATUS";
    calls.push({ url, method, command, authorization: headers.get("Authorization") ?? undefined });

    const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
    if (url.includes("api.x.com/2/tweets")) return handlers.tweetResponse?.() ?? json({ data: { id: "1234" } });
    if (command === "STATUS") return json({ data: { processing_info: { state: statuses.shift() ?? "succeeded", check_after_secs: 1 } } });
    if (command === "FINALIZE")
      return json({ data: { processing_info: statuses.length ? { state: "in_progress", check_after_secs: 1 } : undefined } });
    if (command === "APPEND") return new Response("", { status: 200 });
    if (command === "INIT") return json({ data: { id: "media-1" } });
    return json({ data: { id: "media-1" } });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl, commands: () => calls.map((call) => call.command).filter(Boolean) };
}

function withTempFile<T>(bytes: Buffer, name: string, fn: (file: string) => Promise<T>): Promise<T> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "x-publisher-"));
  const file = path.join(dir, name);
  fs.writeFileSync(file, bytes);
  return fn(file).finally(() => fs.rmSync(dir, { recursive: true, force: true }));
}

describe("publishToX", () => {
  it("refuses to start without complete credentials", async () => {
    await expect(
      publishToX({ text: "hi" }, loadTestConfig({ X_CLIENT_ID: "only-one" }), (() => {
        throw new Error("must not call X");
      }) as unknown as typeof fetch),
    ).rejects.toThrow("missing X OAuth access token");
  });

  it("posts text and signs the request", async () => {
    const { calls, fetchImpl } = transport();
    const result = await publishToX({ text: "hello" }, config, fetchImpl);

    expect(result).toMatchObject({ ok: true, id: "1234", url: "https://x.com/i/web/status/1234" });
    const tweet = calls.at(-1);
    expect(tweet?.url).toBe("https://api.x.com/2/tweets");
    expect(tweet?.method).toBe("POST");
    expect(tweet?.authorization).toBe("Bearer access-token");
  });

  it("skips media whose local file is gone rather than attaching a broken id", async () => {
    const { fetchImpl, commands } = transport();
    const result = await publishToX({ text: "hi", media: [{ type: "IMAGE", localPath: "/definitely/missing.jpg" }] }, config, fetchImpl);
    expect(commands()).toHaveLength(0);
    expect(result.ok).toBe(true);
  });

  it("uploads an image through the v2 chunked protocol and references it on the post", async () => {
    await withTempFile(Buffer.from([0xff, 0xd8, 0xff, 0xd9]), "photo.jpg", async (file) => {
      const uploads: RequestInit[] = [];
      const { fetchImpl } = transport();
      const recording = (async (input: URL | RequestInfo, init?: RequestInit) => {
        if (String(input).includes("/2/media/upload")) uploads.push(init ?? {});
        return fetchImpl(input, init);
      }) as unknown as typeof fetch;

      let tweetBody: Record<string, unknown> = {};
      const capturing = (async (input: URL | RequestInfo, init?: RequestInit) => {
        if (String(input).includes("2/tweets")) tweetBody = JSON.parse(String(init?.body));
        return recording(input, init);
      }) as unknown as typeof fetch;

      await publishToX({ text: "photo", media: [{ type: "IMAGE", localPath: file }] }, config, capturing);
      expect(uploads).toHaveLength(3);
      expect(uploads[1]?.body).toBeInstanceOf(FormData);
      expect(tweetBody.media).toEqual({ media_ids: ["media-1"] });
    });
  });

  it("walks INIT, APPEND and FINALIZE for a video, one APPEND per 2 MiB", async () => {
    // 5 MiB forces three segments; a single-segment fixture would not prove the
    // reusable read buffer is copied per chunk.
    await withTempFile(Buffer.alloc(5 * 1024 * 1024, 7), "clip.mp4", async (file) => {
      const { fetchImpl, calls, commands } = transport();
      await publishToX({ text: "clip", media: [{ type: "VIDEO", localPath: file }] }, config, fetchImpl);

      expect(commands()).toEqual(["INIT", "APPEND", "APPEND", "APPEND", "FINALIZE"]);
      const segments = calls.filter((call) => call.command === "APPEND");
      expect(segments).toHaveLength(3);
    });
  });

  it("waits for asynchronous processing before tweeting the video", async () => {
    await withTempFile(Buffer.alloc(1024, 1), "clip.mp4", async (file) => {
      const { fetchImpl, commands } = transport({ status: ["in_progress", "succeeded"] });
      const result = await publishToX({ text: "clip", media: [{ type: "VIDEO", localPath: file }] }, config, fetchImpl, instantSleep);
      expect(commands().filter((command) => command === "STATUS").length).toBeGreaterThanOrEqual(1);
      expect(result.ok).toBe(true);
    });
  });

  it("fails the target when X reports the video could not be processed", async () => {
    await withTempFile(Buffer.alloc(1024, 1), "clip.mp4", async (file) => {
      const failing = (async (input: URL | RequestInfo, init?: RequestInit) => {
        const url = String(input);
        const params = init?.body instanceof FormData ? init.body : new URLSearchParams(new URL(url).search);
        const command = url.endsWith("/append")
          ? "APPEND"
          : url.endsWith("/finalize")
            ? "FINALIZE"
            : url.endsWith("/initialize")
              ? "INIT"
              : new URL(url).searchParams.has("media_id")
                ? "STATUS"
                : params.get("command");
        const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200 });
        if (command === "INIT") return json({ data: { id: "m" } });
        if (command === "APPEND") return new Response("", { status: 200 });
        if (command === "FINALIZE") return json({ processing_info: { state: "in_progress", check_after_secs: 1 } });
        if (command === "STATUS") return json({ processing_info: { state: "failed", error: { message: "InvalidMedia" } } });
        return json({});
      }) as unknown as typeof fetch;
      await expect(
        publishToX({ text: "clip", media: [{ type: "VIDEO", localPath: file }] }, config, failing, instantSleep),
      ).rejects.toThrow(/InvalidMedia/);
    });
  });

  it("raises a typed HTTP error carrying the retry-after hint", async () => {
    const { fetchImpl } = transport({
      tweetResponse: () => new Response("rate limited", { status: 429, headers: { "retry-after": "42" } }),
    });
    const failure = await publishToX({ text: "hello" }, config, fetchImpl).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(HttpPublishError);
    expect((failure as HttpPublishError).status).toBe(429);
    expect((failure as HttpPublishError).retryAfterSeconds).toBe(42);
  });

  it("reports a tweet without an id as not published", async () => {
    const { fetchImpl } = transport({ tweetResponse: () => new Response(JSON.stringify({ data: {} }), { status: 200 }) });
    const result = await publishToX({ text: "hello" }, config, fetchImpl);
    expect(result).toMatchObject({ ok: false, id: null, url: null });
  });

  it("publishes a thread as a reply chain, and resumes it from what already went out", async () => {
    const bodies: Record<string, unknown>[] = [];
    const responses = [
      () => new Response(JSON.stringify({ data: { id: "t1" } }), { status: 200 }),
      () => new Response("down", { status: 503 }),
      () => new Response(JSON.stringify({ data: { id: "t2" } }), { status: 200 }),
    ];
    const fetchImpl = (async (_input: URL | RequestInfo, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return (responses.shift() as () => Response)();
    }) as unknown as typeof fetch;
    const payload = { text: "first", thread: [{ text: "second", entities: [], media: [] }] };

    const first = await publishToX(payload, config, fetchImpl);
    // The first post is live: the failure is a chain to finish, never a repost.
    expect(first).toMatchObject({ ok: false, partial: true, resumeKey: "_xPublishedIds", ids: ["t1"] });

    const second = await publishToX({ ...payload, _xPublishedIds: ["t1"] }, config, fetchImpl);
    expect(second).toMatchObject({ ok: true, id: "t1", ids: ["t1", "t2"] });
    expect(bodies.map((body) => body.text)).toEqual(["first", "second", "second"]);
    expect(bodies[2]).toMatchObject({ reply: { in_reply_to_tweet_id: "t1" } });
  });
});
