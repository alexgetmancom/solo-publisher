import { setSystemTime } from "bun:test";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { AmbiguousPublicationError } from "../../apps/backend/src/delivery/ambiguous-publication.js";
import { createPlatformAdapters, type TargetRouting, textTargetIsAbsent } from "../../apps/backend/src/delivery/platform-adapters.js";
import { processVerticalMediaRemotely } from "../../apps/backend/src/delivery/remote-media-processor.js";
import { InstagramContainerInvalidError } from "../../apps/backend/src/delivery/social/instagram-container.js";
import { telegramStoryCaptionInput, telegramStoryUploadMedia } from "../../apps/backend/src/delivery/social/telegramStories.js";
import { publishToX, publishXArticle } from "../../apps/backend/src/delivery/social/x.js";
import {
  InstagramContainerProcessingError,
  instagramContainerReady,
  keepYouTubeUploadPrivate,
  prepareInstagramReel,
  prepareYouTubeVideo,
  publishInstagramReel,
  verifyYouTubeVideo,
  videoTargetIsAbsent,
} from "../../apps/backend/src/delivery/video-publishers.js";
import { publishZernioInstagramReel, verifyZernioPost, zernioPostOutcome } from "../../apps/backend/src/delivery/zernio.js";
import { type BackendConfig, loadConfig } from "../../apps/backend/src/foundation/config.js";
import { instagramCredentialsForLocale } from "../../apps/backend/src/foundation/external/instagram.js";
import { ExternalHttpError, ExternalTransportError } from "../../apps/backend/src/foundation/http.js";
import { OperationTimeoutError } from "../../apps/backend/src/foundation/runtime/timeout.js";
import { classifyPublishError, HttpPublishError } from "../../apps/backend/src/publishing/errors.js";
import type { ClaimedPublishJob } from "../../apps/backend/src/publishing/queue.js";

/**
 * Request goldens for the Rust `adapters` crate (crates/adapters/tests/goldens.rs).
 * Every case runs one TypeScript adapter operation over a recording `fetchImpl`
 * that answers canned responses, under a fixed clock, and records what went
 * out and what came back:
 *
 *   {name, operation, inputs, config: {env, credentials}, files, responses,
 *    requests: [{method, url, headers, body}], sleptMs, written, outcome}
 *
 * `outcome` is `{ok: <result>}` or `{error: {kind, message, class, ...}}`.
 * Credentials never appear as values outside `config`: every occurrence in a
 * URL, header or body is replaced by `{{NAME}}`, and the scratch directory
 * the media files live in by `$FILES`. Multipart bodies are recorded as their
 * parsed parts; bodies over 16 KiB or not UTF-8 as their size and sha256.
 *
 *   bun scripts/rust/adapter-goldens.ts        writes parity/adapter-goldens/<platform>/<case>.json
 */
const root = path.join(import.meta.dir, "../..");
const out = path.join(root, "parity/adapter-goldens");
const scratch = path.join(root, "_trash-rust/tmp/adapter-goldens");
const FILES = path.join(scratch, "files");

const NOW_MS = Date.parse("2026-11-21T10:00:00.000Z");
setSystemTime(new Date(NOW_MS));

// ---- configuration --------------------------------------------------------

const BASE_ENV: Record<string, string> = {
  DATA_DIR: "/data",
  CONTROLLER_BOT_TOKEN: "test-token-telegram",
  TELEGRAM_API_BASE_URL: "https://bot-api.example/",
  TELEGRAM_CHANNEL_USERNAME: "@studiochannel",
  THREADS_RU_ACCESS_TOKEN: "test-token-threads-ru",
  THREADS_EN_ACCESS_TOKEN: "test-token-threads-en",
  X_CLIENT_ID: "test-x-client",
  X_CLIENT_SECRET: "test-secret-x-client",
  DISCORD_CHANNEL_ID: "555",
  DISCORD_GUILD_ID: "777",
  INSTAGRAM_RU_ACCESS_TOKEN: "EAtest-token-instagram-ru",
  INSTAGRAM_RU_USER_ID: "ig-ru-user",
  INSTAGRAM_EN_ACCESS_TOKEN: "IGtest-token-instagram-en",
  INSTAGRAM_EN_USER_ID: "ig-en-user",
  YOUTUBE_RU_CLIENT_ID: "test-youtube-ru-client",
  YOUTUBE_RU_CLIENT_SECRET: "test-secret-youtube-ru",
  YOUTUBE_RU_REFRESH_TOKEN: "test-token-youtube-ru-refresh",
  YOUTUBE_EN_CLIENT_ID: "test-youtube-en-client",
  YOUTUBE_EN_CLIENT_SECRET: "test-secret-youtube-en",
  YOUTUBE_EN_REFRESH_TOKEN: "test-token-youtube-en-refresh",
  MEDIA_PROCESSOR_URL: "https://media-processor.example/",
  MEDIA_PROCESSOR_TOKEN: "test-token-media-processor-000000000000",
};
/** Settings whose one home is the `platform_tokens` table: never read from env. */
const BASE_CREDENTIALS: Record<string, string> = {
  X_ACCESS_TOKEN: "test-token-x",
  X_REFRESH_TOKEN: "test-token-x-refresh",
  ZERNIO_API_KEY: "test-token-zernio",
  DISCORD_BOT_TOKEN: "test-token-discord",
};
const SECRET_NAME = /TOKEN|SECRET|KEY/;

type Overrides = Record<string, string | null>;
type CaseConfig = { env: Record<string, string>; credentials: Record<string, string> };

function merged(base: Record<string, string>, overrides: Overrides = {}): Record<string, string> {
  const result = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === null) delete result[key];
    else result[key] = value;
  }
  return result;
}

function backendConfig({ env, credentials }: CaseConfig): BackendConfig {
  return { ...loadConfig(env), ...credentials } as BackendConfig;
}

function scrubber({ env, credentials }: CaseConfig): (value: string) => string {
  const secrets = Object.entries({ ...env, ...credentials })
    .filter(([name, value]) => SECRET_NAME.test(name) && value.length >= 6)
    .sort((left, right) => right[1].length - left[1].length);
  return (value) => {
    let text = value.replaceAll(FILES, "$FILES");
    for (const [name, secret] of secrets) text = text.replaceAll(secret, `{{${name}}}`);
    return text;
  };
}

function scrubDeep(value: unknown, scrub: (text: string) => string): unknown {
  if (typeof value === "string") return scrub(value);
  if (Array.isArray(value)) return value.map((item) => scrubDeep(item, scrub));
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, scrubDeep(item, scrub)]));
  return value;
}

// ---- files ----------------------------------------------------------------

type FileSpec = { fill: string; size: number };
const FILE_SPECS: Record<string, FileSpec> = {
  "photo.jpg": { fill: "J", size: 64 },
  "second.png": { fill: "P", size: 48 },
  "clip.mp4": { fill: "V", size: 96 },
  "big.mp4": { fill: "B", size: 2 * 1024 * 1024 + 4096 },
  "upload.mp4": { fill: "U", size: 32 },
  "story.jpg": { fill: "S", size: 40 },
};
const file = (name: string) => path.join(FILES, name);

function writeFiles(): void {
  fs.rmSync(scratch, { recursive: true, force: true });
  fs.mkdirSync(path.join(FILES, "out"), { recursive: true });
  for (const [name, spec] of Object.entries(FILE_SPECS)) fs.writeFileSync(file(name), spec.fill.repeat(spec.size));
}

const sha256 = (bytes: Uint8Array) => crypto.createHash("sha256").update(bytes).digest("hex");

// ---- recording fetch ------------------------------------------------------

type Canned = { status: number; headers?: [string, string][]; body?: string } | { throws: string } | { hang: true };
type Recorded = { method: string; url: string; headers: [string, string][]; body: unknown };

const MAX_TEXT_BODY = 16 * 1024;

function bytesShape(bytes: Uint8Array, scrub: (text: string) => string): Record<string, unknown> {
  if (bytes.length <= MAX_TEXT_BODY) {
    try {
      return { text: scrub(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) };
    } catch {
      // Not text: recorded by digest below.
    }
  }
  return { size: bytes.length, sha256: sha256(bytes) };
}

/** The parts as they went on the wire: each one's header lines, then its content. */
function multipartParts(bytes: Uint8Array, boundary: string, scrub: (text: string) => string): unknown[] {
  const body = Buffer.from(bytes);
  const delimiter = Buffer.from(`--${boundary}`);
  const parts = [];
  let start = body.indexOf(delimiter) + delimiter.length;
  while (start >= delimiter.length && body.subarray(start, start + 2).toString() === "\r\n") {
    const end = body.indexOf(delimiter, start);
    const part = body.subarray(start + 2, end - 2);
    const split = part.indexOf("\r\n\r\n");
    parts.push({ headers: part.subarray(0, split).toString().split("\r\n").map(scrub), ...bytesShape(part.subarray(split + 4), scrub) });
    start = end + delimiter.length;
  }
  return parts;
}

async function recordedBody(request: Request, scrub: (text: string) => string): Promise<unknown> {
  const bytes = new Uint8Array(await request.arrayBuffer());
  const boundary = request.headers.get("content-type")?.match(/^multipart\/form-data; boundary=(.+)$/)?.[1];
  return boundary ? { parts: multipartParts(bytes, boundary, scrub) } : bytesShape(bytes, scrub);
}

function recorder(responses: Canned[], scrub: (text: string) => string) {
  const requests: Recorded[] = [];
  const queue = [...responses];
  const fetchImpl = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const request = new Request(input, init);
    const multipart = request.headers.get("content-type")?.startsWith("multipart/form-data") ?? false;
    requests.push({
      method: request.method,
      url: scrub(request.url),
      headers: [...request.headers].map(([name, value]) => [
        name,
        multipart && name === "content-type" ? "multipart/form-data" : scrub(value),
      ]),
      body: await recordedBody(request, scrub),
    });
    const next = queue.shift();
    if (!next) throw new Error("no canned response left");
    if ("throws" in next) throw new TypeError(next.throws);
    if ("hang" in next)
      return new Promise<Response>((_, reject) => init.signal?.addEventListener("abort", () => reject(init.signal?.reason)));
    return new Response(next.body ?? "", { status: next.status, headers: next.headers ?? [] });
  }) as typeof fetch;
  return { requests, fetchImpl, unused: () => queue.length };
}

function errorShape(error: unknown, scrub: (text: string) => string): Record<string, unknown> {
  const message = scrub(error instanceof Error ? error.message : String(error));
  const shape = (kind: string, extra: Record<string, unknown> = {}) => ({ kind, message, class: classifyPublishError(error), ...extra });
  if (error instanceof AmbiguousPublicationError) return shape("ambiguous", { provider: error.provider });
  if (error instanceof InstagramContainerInvalidError) return shape("container_invalid");
  if (error instanceof InstagramContainerProcessingError) return shape("container_processing");
  if (error instanceof ExternalHttpError || error instanceof HttpPublishError)
    return shape("http", { status: error.status, retryAfterSeconds: error.retryAfterSeconds });
  if (error instanceof ExternalTransportError) return shape("transport");
  if (error instanceof OperationTimeoutError) return shape("timeout");
  return shape("message");
}

// ---- operations -----------------------------------------------------------

type Inputs = Record<string, unknown>;
type Context = { config: BackendConfig; fetchImpl: typeof fetch; sleeps: number[] };
type Operation = (inputs: Inputs, context: Context) => Promise<unknown>;

function job(target: string, payload: Record<string, unknown>, jobId = 7): ClaimedPublishJob {
  return { jobId, publicationKey: "post:12", target, payload: payload as ClaimedPublishJob["payload"], attemptCount: 1, lockId: "lock-1" };
}

const adapters = (inputs: Inputs, { config, fetchImpl }: Context) =>
  createPlatformAdapters(config, fetchImpl, async (claimed) => claimed, (inputs.routing ?? {}) as TargetRouting);
const adapter = (inputs: Inputs, context: Context) => {
  const found = adapters(inputs, context)[String(inputs.target)];
  if (!found) throw new Error(`no adapter for ${inputs.target}`);
  return found;
};
const jobOf = (inputs: Inputs) => job(String(inputs.target), (inputs.payload ?? {}) as Record<string, unknown>, Number(inputs.jobId ?? 7));
const locale = (inputs: Inputs) => (inputs.locale === "en" ? "en" : "ru");

/** Global `fetch` for the publishers that take none (video-publishers.ts). */
async function withGlobalFetch<T>(fetchImpl: typeof fetch, run: () => Promise<T>): Promise<T> {
  const real = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    return await run();
  } finally {
    globalThis.fetch = real;
  }
}

const OPERATIONS: Record<string, Operation> = {
  "adapter.publish": (inputs, context) => adapter(inputs, context).publish(jobOf(inputs)),
  "adapter.validate": (inputs, context) => adapter(inputs, context).validate(jobOf(inputs)),
  "adapter.verify": (inputs, context) =>
    adapter(inputs, context).verify(jobOf(inputs), inputs.result as Awaited<ReturnType<ReturnType<typeof adapter>["publish"]>>),
  "adapter.edit": async (inputs, context) => {
    const edit = adapter(inputs, context).edit;
    if (!edit) throw new Error(`no edit port for ${inputs.target}`);
    return edit(inputs.edit as Parameters<typeof edit>[0]);
  },
  "adapter.remove": async (inputs, context) => {
    const remove = adapter(inputs, context).remove;
    if (!remove) throw new Error(`no remove port for ${inputs.target}`);
    return remove(String(inputs.externalId));
  },
  "x.publish": (inputs, { config, fetchImpl, sleeps }) =>
    publishToX(inputs.payload as Record<string, unknown>, config, fetchImpl, async (ms) => {
      sleeps.push(ms);
    }),
  "x.article": (inputs, { config, fetchImpl, sleeps }) =>
    publishXArticle(inputs.payload as Record<string, unknown>, config, fetchImpl, async (ms) => {
      sleeps.push(ms);
    }),
  "platform.text_absent": (inputs, { config, fetchImpl }) =>
    textTargetIsAbsent(String(inputs.target), String(inputs.externalId), config, fetchImpl),
  "zernio.reel": (inputs, { config, fetchImpl }) =>
    publishZernioInstagramReel(config, inputs.input as Parameters<typeof publishZernioInstagramReel>[1], fetchImpl),
  "zernio.outcome": (inputs, { config, fetchImpl }) =>
    zernioPostOutcome(config, String(inputs.providerPostId), inputs.platform as "instagram", fetchImpl),
  "zernio.verify": (inputs, { config, fetchImpl }) =>
    verifyZernioPost(config, String(inputs.providerPostId), inputs.platform as "instagram", fetchImpl),
  "youtube.prepare": (inputs, { config, fetchImpl }) =>
    withGlobalFetch(fetchImpl, () =>
      prepareYouTubeVideo(
        config,
        file(String(inputs.file)),
        inputs.metadata as Parameters<typeof prepareYouTubeVideo>[2],
        String(inputs.publishAt),
        locale(inputs),
      ),
    ),
  "youtube.keep_private": (inputs, { config, fetchImpl }) =>
    withGlobalFetch(fetchImpl, () => keepYouTubeUploadPrivate(config, String(inputs.videoId), locale(inputs))),
  "youtube.verify": (inputs, { config, fetchImpl }) => verifyYouTubeVideo(config, String(inputs.videoId), locale(inputs), fetchImpl),
  "reels.prepare": (inputs, { config, fetchImpl }) =>
    withGlobalFetch(fetchImpl, () =>
      prepareInstagramReel(
        config,
        instagramCredentialsForLocale(config, locale(inputs)),
        String(inputs.publicUrl),
        inputs.metadata as Parameters<typeof prepareInstagramReel>[3],
      ),
    ),
  "reels.ready": (inputs, { config, fetchImpl }) =>
    withGlobalFetch(fetchImpl, () =>
      instagramContainerReady(config, instagramCredentialsForLocale(config, locale(inputs)), String(inputs.containerId)),
    ),
  "reels.publish": (inputs, { config, fetchImpl }) =>
    withGlobalFetch(fetchImpl, () =>
      publishInstagramReel(config, instagramCredentialsForLocale(config, locale(inputs)), String(inputs.containerId)),
    ),
  "video.absent": (inputs, { config, fetchImpl }) =>
    withGlobalFetch(fetchImpl, () =>
      videoTargetIsAbsent(config, inputs.videoTarget as Parameters<typeof videoTargetIsAbsent>[1], locale(inputs), fetchImpl),
    ),
  "remote_media.process": (inputs, { config, fetchImpl }) =>
    processVerticalMediaRemotely({
      config,
      source: file(String(inputs.source)),
      kind: inputs.kind as "image" | "video",
      variants: (inputs.variants as { name: string; output: string }[]).map((variant) => ({ ...variant, output: file(variant.output) })),
      timeoutMs: Number(inputs.timeoutMs),
      fetchImpl,
    }),
  "stories.caption": async (inputs) => telegramStoryCaptionInput(String(inputs.text), inputs.entities as unknown[]),
  "stories.upload_media": async (inputs) =>
    telegramStoryUploadMedia(
      String(inputs.path),
      inputs.type as "IMAGE" | "VIDEO",
      inputs.metadata as { width: number; height: number; duration: number },
    ),
};

// ---- cases ----------------------------------------------------------------

type Case = {
  platform: string;
  name: string;
  operation: keyof typeof OPERATIONS;
  inputs: Inputs;
  responses?: Canned[];
  env?: Overrides;
  credentials?: Overrides;
  /** Files the operation writes, recorded by digest afterwards. */
  writes?: string[];
};

const ok = (value: unknown, headers: [string, string][] = []): Canned => ({
  status: 200,
  headers: [["content-type", "application/json"], ...headers],
  body: JSON.stringify(value),
});
const status = (code: number, value: unknown, headers: [string, string][] = []): Canned => ({
  status: code,
  headers: [["content-type", "application/json"], ...headers],
  body: typeof value === "string" ? value : JSON.stringify(value),
});
const lost = (message = "connection reset by peer"): Canned => ({ throws: message });
const tgOk = (messageId: number) => ok({ ok: true, result: { message_id: messageId } });
const tgTrue = ok({ ok: true, result: true });

const telegram = (name: string, payload: Record<string, unknown>, responses: Canned[], extra: Partial<Case> = {}): Case => ({
  platform: "telegram",
  name,
  operation: "adapter.publish",
  inputs: { target: "telegram", payload },
  responses,
  ...extra,
});

const telegramCases: Case[] = [
  telegram("text", { text: "hello" }, [tgOk(42), tgTrue]),
  telegram(
    "text-link-preview",
    {
      text: "see this",
      entities: [
        { type: "bold", offset: 0, length: 3 },
        { type: "text_link", url: "javascript:alert(1)" },
        { type: "text_link", url: "https://example.com/post", offset: 4, length: 4 },
      ],
    },
    [tgOk(43), tgTrue],
  ),
  telegram("reaction-refused", { text: "hello" }, [tgOk(7), status(400, { ok: false, description: "Bad Request: not enough rights" })]),
  telegram("reaction-lost", { text: "hello" }, [tgOk(8), lost()]),
  telegram(
    "photo-caption-clamped",
    {
      text: "x".repeat(1200),
      media: [{ type: "IMAGE", fileId: "file-1" }],
      entities: [
        { type: "bold", offset: 1020, length: 100 },
        { type: "italic", offset: 1100, length: 10 },
        { type: "code", offset: "3", length: 2 },
        "junk",
      ],
    },
    [tgOk(44), tgTrue],
  ),
  telegram("photo-surrogate-boundary", { text: `${"a".repeat(1023)}😀tail`, media: [{ type: "photo", fileId: "file-2" }] }, [
    tgOk(45),
    tgTrue,
  ]),
  telegram("video-file-id", { text: "clip", media: [{ type: "video", fileId: "vid-1", localPath: file("clip.mp4") }] }, [tgOk(46), tgTrue]),
  telegram("photo-vps-url", { text: "remote", media: [{ type: "IMAGE", vpsUrl: "https://media.example/staging/a.jpg" }] }, [
    tgOk(47),
    tgTrue,
  ]),
  telegram(
    "photo-local-upload",
    { text: "local", entities: [{ type: "bold", offset: 0, length: 5 }], media: [{ type: "IMAGE", localPath: file("photo.jpg") }] },
    [tgOk(48), tgTrue],
  ),
  telegram("video-local-upload", { text: "", media: [{ type: "VIDEO", localPath: file("clip.mp4") }] }, [tgOk(49), tgTrue]),
  telegram(
    "album-file-ids",
    {
      text: "album",
      entities: [{ type: "italic", offset: 0, length: 5 }],
      media: [
        { type: "IMAGE", fileId: "a" },
        { type: "VIDEO", fileId: "b" },
        { type: "IMAGE", fileId: "c" },
      ],
    },
    [ok({ ok: true, result: [{ message_id: 50 }, { message_id: 51 }, { message_id: 52 }] }), tgTrue],
  ),
  telegram(
    "album-mixed-upload",
    {
      text: "mixed",
      media: [
        { type: "IMAGE", localPath: file("photo.jpg") },
        { type: "IMAGE", fileId: "b" },
        { type: "IMAGE", localPath: file("second.png") },
      ],
    },
    [ok({ ok: true, result: [{ message_id: 53 }, { message_id: 54 }, { message_id: 55 }] }), tgTrue],
  ),
  telegram("album-capped", { text: "many", media: Array.from({ length: 12 }, (_, index) => ({ type: "IMAGE", fileId: `f${index}` })) }, [
    ok({ ok: true, result: [{ message_id: 56 }] }),
    tgTrue,
  ]),
  telegram(
    "thread-rich-message",
    {
      text: "First <part> & more",
      entities: [{ type: "bold", offset: 0, length: 5 }],
      media: [{ type: "IMAGE", fileId: "lead" }],
      thread: [
        { text: "Second", entities: [{ type: "spoiler", offset: 0, length: 6 }], media: [{ type: "VIDEO", localPath: file("clip.mp4") }] },
        { text: "  ", entities: [], media: [{ type: "IMAGE", vpsUrl: "https://media.example/c.jpg" }] },
        { text: "Last", entities: [{ type: "text_link", offset: 0, length: 4, url: "https://example.com" }], media: [] },
      ],
    },
    [tgOk(57), tgTrue],
  ),
  telegram("thread-text-only", { text: "One", thread: [{ text: "Two", entities: [], media: [] }] }, [tgOk(58), tgTrue]),
  telegram("api-not-ok", { text: "hello" }, [ok({ ok: false, description: "Bad Request: chat not found" })]),
  telegram("api-not-ok-no-description", { text: "hello" }, [ok({ ok: false })]),
  telegram("refused-400", { text: "hello" }, [
    status(400, { ok: false, error_code: 400, description: "Bad Request: message is too long" }),
  ]),
  telegram("rate-limited", { text: "hello" }, [
    status(429, { ok: false, error_code: 429, description: "Too Many Requests: retry after 17" }, [["retry-after", "17"]]),
  ]),
  telegram("server-error", { text: "hello" }, [status(502, "<html>Bad Gateway</html>")]),
  telegram("transport-lost", { text: "hello" }, [lost()]),
  telegram("non-json", { text: "hello" }, [{ status: 200, body: "<html>proxy</html>" }]),
  telegram("no-message-id", { text: "hello" }, [ok({ ok: true, result: true })]),
  telegram("missing-token", { text: "hello" }, [], { env: { CONTROLLER_BOT_TOKEN: null } }),
  telegram("missing-channel", { text: "hello" }, [], { env: { TELEGRAM_CHANNEL_USERNAME: null } }),
  {
    platform: "telegram",
    name: "edit-text",
    operation: "adapter.edit",
    inputs: { target: "telegram", edit: { externalId: "42", text: "edited", mediaCount: 0, externalIdCount: 1 } },
    responses: [ok({ ok: true, result: { message_id: 42 } })],
  },
  {
    platform: "telegram",
    name: "edit-caption",
    operation: "adapter.edit",
    inputs: { target: "telegram", edit: { externalId: "43", text: "caption", chatId: -1001, mediaCount: 2, externalIdCount: 2 } },
    responses: [ok({ ok: false, description: "message is not modified" })],
  },
  {
    platform: "telegram",
    name: "edit-missing-token",
    operation: "adapter.edit",
    inputs: { target: "telegram", edit: { externalId: "42", text: "edited", mediaCount: 0, externalIdCount: 1 } },
    env: { CONTROLLER_BOT_TOKEN: null },
  },
  {
    platform: "telegram",
    name: "remove",
    operation: "adapter.remove",
    inputs: { target: "telegram", externalId: "42" },
    responses: [tgTrue],
  },
  {
    platform: "telegram",
    name: "remove-refused",
    operation: "adapter.remove",
    inputs: { target: "telegram", externalId: "42" },
    responses: [status(400, { ok: false, description: "Bad Request: message to delete not found" })],
  },
  {
    platform: "telegram",
    name: "remove-missing-token",
    operation: "adapter.remove",
    inputs: { target: "telegram", externalId: "42" },
    env: { CONTROLLER_BOT_TOKEN: null },
  },
];

const tweet = (id: string) => ok({ data: { id, text: "t" } });
const x = (name: string, payload: Record<string, unknown>, responses: Canned[], extra: Partial<Case> = {}): Case => ({
  platform: "x",
  name,
  operation: "x.publish",
  inputs: { payload },
  responses,
  ...extra,
});
const xMediaInit = (id: string) => ok({ data: { id, media_key: `3_${id}` } });

const xCases: Case[] = [
  x("text", { text: "Hello https://example.com/a  world\n\nnext" }, [tweet("100")]),
  {
    platform: "x",
    name: "text-through-adapter",
    operation: "adapter.publish",
    inputs: { target: "x", payload: { text: "Through the port" } },
    responses: [tweet("101")],
  },
  x("image-upload", { text: "pic", media: [{ type: "IMAGE", localPath: file("photo.jpg") }] }, [
    xMediaInit("m1"),
    { status: 204 },
    ok({ data: { id: "m1" } }),
    tweet("102"),
  ]),
  x("missing-file-skipped", { text: "pic", media: [{ type: "IMAGE", localPath: file("gone.jpg") }] }, [tweet("103")]),
  x("video-processing", { text: "vid", media: [{ type: "VIDEO", localPath: file("clip.mp4") }] }, [
    xMediaInit("m2"),
    { status: 204 },
    ok({ data: { id: "m2", processing_info: { state: "pending", check_after_secs: 2 } } }),
    ok({ data: { processing_info: { state: "in_progress", check_after_secs: 0 } } }),
    ok({ processing_info: { state: "succeeded" } }),
    tweet("104"),
  ]),
  x("video-processing-failed", { text: "vid", media: [{ type: "VIDEO", localPath: file("clip.mp4") }] }, [
    xMediaInit("m3"),
    { status: 204 },
    ok({ data: { processing_info: { state: "pending" } } }),
    ok({ data: { processing_info: { state: "failed", error: { message: "InvalidMedia" } } } }),
  ]),
  x("video-two-segments", { text: "big", media: [{ type: "VIDEO", localPath: file("big.mp4") }] }, [
    xMediaInit("m4"),
    { status: 204 },
    { status: 204 },
    ok({ data: { id: "m4" } }),
    tweet("105"),
  ]),
  x("init-missing-id", { text: "pic", media: [{ type: "IMAGE", localPath: file("photo.jpg") }] }, [ok({ data: {} })]),
  x("append-refused", { text: "pic", media: [{ type: "IMAGE", localPath: file("photo.jpg") }] }, [
    xMediaInit("m5"),
    status(500, { title: "Internal Error", token: "test-token-x" }),
  ]),
  x("rate-limited", { text: "hello" }, [
    status(429, { title: "Too Many Requests" }, [
      ["x-rate-limit-reset", "0"],
      ["retry-after", "60"],
    ]),
  ]),
  x("unauthorized", { text: "hello" }, [status(401, { title: "Unauthorized" })]),
  x("missing-id", { text: "hello" }, [ok({ data: {} })]),
  x("transport-lost", { text: "hello" }, [lost()]),
  x(
    "thread-chain",
    {
      text: "One",
      thread: [
        { text: "Two https://example.com/x", entities: [], media: [] },
        { text: "Three", entities: [], media: [{ type: "IMAGE", localPath: file("photo.jpg") }] },
      ],
    },
    [tweet("200"), tweet("201"), xMediaInit("m6"), { status: 204 }, ok({ data: { id: "m6" } }), tweet("202")],
  ),
  x(
    "thread-partial",
    {
      text: "One",
      thread: [
        { text: "Two", entities: [], media: [] },
        { text: "Three", entities: [], media: [] },
      ],
    },
    [tweet("210"), status(503, { title: "Service Unavailable" })],
  ),
  x("thread-part-missing-id", { text: "One", thread: [{ text: "Two", entities: [], media: [] }] }, [tweet("215"), ok({ data: {} })]),
  x(
    "thread-resume",
    {
      text: "One",
      _xPublishedIds: ["220", "", 5],
      thread: [
        { text: "Two", entities: [], media: [] },
        { text: "Three", entities: [], media: [] },
      ],
    },
    [tweet("221"), tweet("222")],
  ),
  x("thread-ambiguous-after-first", { text: "One", thread: [{ text: "Two", entities: [], media: [] }] }, [tweet("230"), lost()]),
  x("missing-token", { text: "hello" }, [], { credentials: { X_ACCESS_TOKEN: null } }),
  {
    platform: "x",
    name: "article",
    operation: "x.article",
    inputs: {
      payload: {
        title: "  Title  ",
        text: "Heading\nPlain line with link\n\n- item\nquote here\ncode()\nsee example.com now",
        entities: [
          { type: "heading", offset: 0, length: 7, level: 1 },
          { type: "bold", offset: 8, length: 5 },
          { type: "text_link", offset: 19, length: 4, url: "https://example.com/l" },
          { type: "text_link", offset: 14, length: 4, url: "ftp://nope" },
          { type: "list_item", offset: 25, length: 6 },
          { type: "quote", offset: 32, length: 10 },
          { type: "pre", offset: 43, length: 6 },
          { type: "url", offset: 54, length: 11 },
          { type: "italic", offset: 3, length: 20 },
          { type: "heading", offset: 32, length: 3 },
          { type: "bold", offset: 200, length: 4 },
        ],
        media: [
          { type: "IMAGE", localPath: file("photo.jpg") },
          { type: "VIDEO", localPath: file("clip.mp4") },
        ],
      },
    },
    responses: [
      xMediaInit("m7"),
      { status: 204 },
      ok({ data: { id: "m7" } }),
      ok({ data: { id: "art-1" } }),
      ok({ data: { id: "art-1" } }),
    ],
  },
  {
    platform: "x",
    name: "article-empty-body",
    operation: "x.article",
    inputs: { payload: { title: "Only title", text: "" } },
    responses: [ok({ data: { id: "art-2" } }), ok({})],
  },
  {
    platform: "x",
    name: "article-missing-title",
    operation: "x.article",
    inputs: { payload: { title: "  ", text: "body" } },
  },
  {
    platform: "x",
    name: "article-draft-missing-id",
    operation: "x.article",
    inputs: { payload: { title: "T", text: "body" } },
    responses: [ok({ data: {} })],
  },
  {
    platform: "x",
    name: "article-draft-lost",
    operation: "x.article",
    inputs: { payload: { title: "T", text: "body" } },
    responses: [lost()],
  },
  {
    platform: "x",
    name: "article-publish-refused",
    operation: "x.article",
    inputs: { payload: { title: "T", text: "body" } },
    responses: [ok({ data: { id: "art-3" } }), status(500, { title: "Internal" })],
  },
  {
    platform: "x",
    name: "article-resume",
    operation: "x.article",
    inputs: { payload: { title: "T", text: "body", _xArticleDraftId: [7, "art-4"] } },
    responses: [ok({ data: { id: "post-4" } })],
  },
  {
    platform: "x",
    name: "article-publish-lost",
    operation: "x.article",
    inputs: { payload: { title: "T", text: "body" } },
    responses: [ok({ data: { id: "art-5" } }), lost()],
  },
  {
    platform: "x",
    name: "verify",
    operation: "adapter.verify",
    inputs: { target: "x", payload: {}, result: { ok: true, id: "300", url: "https://x.com/i/web/status/300" } },
    responses: [tweet("300")],
  },
  {
    platform: "x",
    name: "verify-mismatch",
    operation: "adapter.verify",
    inputs: { target: "x", payload: {}, result: { ok: true, id: 301 } },
    responses: [tweet("999")],
  },
  {
    platform: "x",
    name: "verify-article-unsupported",
    operation: "adapter.verify",
    inputs: { target: "x_article", payload: {}, result: { ok: true, id: "art-1" } },
  },
  {
    platform: "x",
    name: "verify-skips-failed-result",
    operation: "adapter.verify",
    inputs: { target: "x", payload: {}, result: { ok: false, error: "nope" } },
  },
  {
    platform: "x",
    name: "validate-missing",
    operation: "adapter.validate",
    inputs: { target: "x" },
    env: { X_CLIENT_ID: null },
    credentials: { X_REFRESH_TOKEN: null },
  },
  { platform: "x", name: "validate-ready", operation: "adapter.validate", inputs: { target: "x_article" } },
];

const THREADS_NOW = NOW_MS;
const threads = (name: string, payload: Record<string, unknown>, responses: Canned[], extra: Partial<Case> = {}): Case => ({
  platform: "threads",
  name,
  operation: "adapter.publish",
  inputs: { target: "threads_ru", payload },
  responses,
  ...extra,
});
const progress = (state: Record<string, unknown>) => ({
  childIds: [],
  itemIndex: 0,
  publishedIds: [],
  partIndex: 0,
  polls: 0,
  carouselRebuilds: 0,
  mediaFetchRetries: 0,
  startedAtMs: THREADS_NOW - 1000,
  ...state,
});
const twoImages = [
  { type: "IMAGE", vpsUrl: "https://media.example/staging/1.jpg" },
  { type: "VIDEO", vpsUrl: "https://media.example/staging/2.mp4" },
];
const mediaFetchError = status(400, {
  error: { message: "Media download has failed.", type: "OAuthException", code: 9004, error_subcode: 2207052, is_transient: false },
});

const threadsCases: Case[] = [
  threads("create-text", { text: "  hello threads  " }, [ok({ id: "c1" })]),
  threads("create-text-en", { text: "hello" }, [ok({ id: "c1en" })], { inputs: { target: "threads_en", payload: { text: "hello" } } }),
  threads(
    "create-link-appended",
    { text: "read more", entities: [{ type: "text_link", offset: 0, length: 4, url: "https://example.com/r" }] },
    [ok({ id: "c2" })],
  ),
  threads("create-image", { text: "pic", media: [{ type: "IMAGE", vpsUrl: "https://media.example/staging/p.jpg", localPath: "/x" }] }, [
    ok({ id: "c3" }),
  ]),
  threads("create-ignores-unstaged", { text: "pic", media: [{ type: "IMAGE", localPath: file("photo.jpg") }] }, [ok({ id: "c4" })]),
  threads("create-missing-id", { text: "hello" }, [ok({})]),
  threads("create-long-chain", { text: `${"Sentence one. ".repeat(30)}\n\n${"Second paragraph. ".repeat(10)}` }, [ok({ id: "c5" })]),
  threads("create-rate-limited", { text: "hello" }, [status(429, { error: { message: "rate" } }, [["retry-after", "120"]])]),
  threads("create-media-fetch-retry", { text: "pic", media: [twoImages[0]] }, [
    mediaFetchError,
    { status: 200, headers: [["content-type", "image/jpeg"]], body: "JPEG" },
  ]),
  threads(
    "create-media-fetch-exhausted",
    { text: "pic", media: [twoImages[0]], threadsProgress: progress({ stage: "create_primary", mediaFetchRetries: 3 }) },
    [mediaFetchError, lost("connect ECONNREFUSED")],
  ),
  threads("create-other-error", { text: "pic", media: [twoImages[0]] }, [status(400, { error: { message: "Invalid parameter" } })]),
  threads("wait-finished", { text: "hello", threadsProgress: progress({ stage: "wait_primary", containerId: "c1" }) }, [
    ok({ status: "FINISHED", id: "c1" }),
  ]),
  threads("wait-in-progress", { text: "hello", threadsProgress: progress({ stage: "wait_primary", containerId: "c1", polls: 2 }) }, [
    ok({ status: "IN_PROGRESS" }),
  ]),
  threads("wait-error", { text: "hello", threadsProgress: progress({ stage: "wait_primary", containerId: "c1" }) }, [
    ok({ status: "ERROR", error_message: "FAILED_PROCESSING_VIDEO" }),
  ]),
  threads(
    "wait-timeout",
    { text: "hello", threadsProgress: progress({ stage: "wait_primary", containerId: "c1", startedAtMs: THREADS_NOW - 181_000 }) },
    [ok({ status: "IN_PROGRESS" })],
  ),
  threads("wait-state-invalid", { text: "hello", threadsProgress: { stage: "bogus" } }, [ok({ id: "c9" })]),
  threads("publish", { text: "hello", threadsProgress: progress({ stage: "publish", containerId: "c1" }) }, [ok({ id: "p1" })]),
  threads("publish-lost", { text: "hello", threadsProgress: progress({ stage: "publish", containerId: "c1" }) }, [lost()]),
  threads("publish-missing-id", { text: "hello", threadsProgress: progress({ stage: "publish", containerId: "c1" }) }, [ok({})]),
  threads("verify", { text: "hello", threadsProgress: progress({ stage: "verify", publishedIds: ["p1", "p2"], partIndex: 2 }) }, [
    ok({ id: "p1", permalink: "https://www.threads.net/@studio/post/abc" }),
  ]),
  threads("verify-mismatch", { text: "hello", threadsProgress: progress({ stage: "verify", publishedIds: ["p1"] }) }, [ok({ id: "zz" })]),
  threads("carousel-child", { text: "two", media: twoImages }, [ok({ id: "ch1" })]),
  threads(
    "carousel-child-finished",
    {
      text: "two",
      media: twoImages,
      threadsProgress: progress({ stage: "wait_child", containerId: "ch2", childIds: ["ch1"], itemIndex: 1 }),
    },
    [ok({ status: "FINISHED" })],
  ),
  threads(
    "carousel-parent",
    { text: "two", media: twoImages, threadsProgress: progress({ stage: "create_parent", childIds: ["ch1", "ch2"], itemIndex: 2 }) },
    [ok({ id: "par1" })],
  ),
  threads(
    "carousel-parent-rebuild",
    {
      text: "two",
      media: twoImages,
      threadsProgress: progress({ stage: "create_parent", childIds: ["ch1", "ch2"], itemIndex: 2, containerId: "old" }),
    },
    [status(400, { error: { message: "The carousel is invalid", code: 4279004 } })],
  ),
  threads(
    "carousel-parent-rebuild-spent",
    {
      text: "two",
      media: twoImages,
      threadsProgress: progress({ stage: "create_parent", childIds: ["ch1", "ch2"], itemIndex: 2, carouselRebuilds: 1 }),
    },
    [status(400, { error: { message: "The carousel is invalid", code: 4279004 } })],
  ),
  threads(
    "reply",
    {
      text: "One",
      thread: [{ text: "Two", entities: [], media: [{ type: "VIDEO", vpsUrl: "https://media.example/staging/r.mp4" }] }],
      threadsProgress: progress({ stage: "create_reply", publishedIds: ["p1"], partIndex: 1 }),
      _threadsPublishedIds: ["p1"],
    },
    [ok({ id: "r1" })],
  ),
  threads("reply-state-invalid", { text: "One", threadsProgress: progress({ stage: "create_reply", publishedIds: [], partIndex: 1 }) }, []),
  threads("missing-token", { text: "hello" }, [], { env: { THREADS_RU_ACCESS_TOKEN: null } }),
  {
    platform: "threads",
    name: "remove",
    operation: "adapter.remove",
    inputs: { target: "threads_en", externalId: "p/1" },
    responses: [ok({ success: true })],
  },
  {
    platform: "threads",
    name: "remove-missing-token",
    operation: "adapter.remove",
    inputs: { target: "threads_en", externalId: "p1" },
    env: { THREADS_EN_ACCESS_TOKEN: null },
  },
  {
    platform: "threads",
    name: "adapter-verify",
    operation: "adapter.verify",
    inputs: { target: "threads_ru", payload: {}, result: { ok: true, id: "p1", url: null } },
    responses: [ok({ id: "p1", permalink: "https://www.threads.net/@s/post/1" })],
  },
  {
    platform: "threads",
    name: "adapter-verify-deferred-untouched",
    operation: "adapter.verify",
    inputs: { target: "threads_ru", payload: {}, result: { deferred: true, retryAfterMs: 250 } },
  },
  {
    platform: "threads",
    name: "zernio-routed",
    operation: "adapter.publish",
    inputs: {
      target: "threads_ru",
      routing: { threads_ru: { provider: "zernio", accountId: "acc-threads" } },
      jobId: 31,
      payload: {
        text: "  through provider  ",
        media: [
          { type: "IMAGE", vpsUrl: "https://media.example/z.jpg" },
          { type: "VIDEO", localPath: "/v" },
        ],
      },
    },
    responses: [
      ok({ post: { _id: "zp1", platforms: [{ platform: "threads", platformPostId: "t1", platformPostUrl: "https://threads.com/t1" }] } }),
    ],
  },
  {
    platform: "threads",
    name: "zernio-routed-no-account",
    operation: "adapter.publish",
    inputs: { target: "threads_en", routing: { threads_en: { provider: "zernio", accountId: null } }, payload: { text: "x" } },
  },
  {
    platform: "threads",
    name: "zernio-routed-verify",
    operation: "adapter.verify",
    inputs: {
      target: "threads_ru",
      routing: { threads_ru: { provider: "zernio", accountId: "acc" } },
      payload: {},
      result: { ok: true, id: "zp1", url: null, providerPostId: "zp1" },
    },
    responses: [ok({ _id: "zp1", platforms: [{ platform: "threads", platformPostId: "t9", platformPostUrl: "https://threads.com/t9" }] })],
  },
  {
    platform: "threads",
    name: "zernio-routed-verify-pending",
    operation: "adapter.verify",
    inputs: {
      target: "threads_ru",
      routing: { threads_ru: { provider: "zernio", accountId: "acc" } },
      payload: {},
      result: { ok: true, id: "zp1", providerPostId: "zp1" },
    },
    responses: [ok({ _id: "zp1", platforms: [{ platform: "threads", status: "pending" }] })],
  },
  {
    platform: "threads",
    name: "zernio-routed-verify-no-provider-id",
    operation: "adapter.verify",
    inputs: {
      target: "threads_ru",
      routing: { threads_ru: { provider: "zernio", accountId: "acc" } },
      payload: {},
      result: { ok: true, id: "x" },
    },
  },
  {
    platform: "threads",
    name: "validate-routed-without-key",
    operation: "adapter.validate",
    inputs: { target: "threads_ru", routing: { threads_ru: { provider: "zernio", accountId: "acc" } } },
    credentials: { ZERNIO_API_KEY: null },
  },
  {
    platform: "threads",
    name: "absent-missing",
    operation: "platform.text_absent",
    inputs: { target: "threads_ru", externalId: "p1" },
    responses: [status(400, { error: { message: "Object with ID 'p1' does not exist", code: 100, error_subcode: 33 } })],
  },
  {
    platform: "threads",
    name: "absent-present",
    operation: "platform.text_absent",
    inputs: { target: "threads_ru", externalId: "p1" },
    responses: [ok({ id: "p1" })],
  },
  {
    platform: "threads",
    name: "absent-unprovable",
    operation: "platform.text_absent",
    inputs: { target: "threads_ru", externalId: "p1" },
    responses: [status(401, { error: { message: "Session has expired" } })],
  },
  {
    platform: "threads",
    name: "absent-telegram-unknown",
    operation: "platform.text_absent",
    inputs: { target: "telegram", externalId: "1" },
  },
];

const story = (name: string, target: string, payload: Record<string, unknown>, responses: Canned[], extra: Partial<Case> = {}): Case => ({
  platform: "instagram",
  name,
  operation: "adapter.publish",
  inputs: { target, payload },
  responses,
  ...extra,
});
const igState = (state: Record<string, unknown>) => ({ polls: 0, rebuilds: 0, publishAttempts: 0, ...state });
const storyMedia = [{ type: "IMAGE", vpsUrl: "https://media.example/feed.jpg", storyVpsUrl: "https://media.example/story.jpg" }];

const instagramCases: Case[] = [
  story("create-en", "instagram_stories", { media: storyMedia }, [ok({ id: "ct1" })]),
  story("create-ru-video", "instagram_stories_ru", { media: [{ type: "VIDEO", vpsUrl: "https://media.example/s.mp4" }] }, [
    ok({ id: "ct2" }),
  ]),
  story("create-missing-url", "instagram_stories", { media: [{ type: "IMAGE", localPath: "/local.jpg" }] }, []),
  story("create-missing-id", "instagram_stories", { media: storyMedia }, [ok({ error: { message: "x" } })]),
  story("create-refused", "instagram_stories", { media: storyMedia }, [
    status(400, { error: { code: 100, message: "Invalid parameter" } }),
  ]),
  story("processing-finished", "instagram_stories", { instagramStoryProgress: igState({ stage: "processing", containerId: "ct1" }) }, [
    ok({ status_code: "FINISHED" }),
  ]),
  story(
    "processing-waiting",
    "instagram_stories",
    { instagramStoryProgress: igState({ stage: "processing", containerId: "ct1", polls: 3 }) },
    [ok({ status: "IN_PROGRESS" })],
  ),
  story(
    "processing-timeout",
    "instagram_stories",
    { instagramStoryProgress: igState({ stage: "processing", containerId: "ct1", polls: 29 }) },
    [ok({ status_code: "IN_PROGRESS" })],
  ),
  story("processing-error-rebuild", "instagram_stories", { instagramStoryProgress: igState({ stage: "processing", containerId: "ct1" }) }, [
    ok({ status_code: "ERROR", status: "Error: media" }),
  ]),
  story(
    "processing-error-final",
    "instagram_stories",
    { media: storyMedia, instagramStoryProgress: igState({ stage: "processing", containerId: "ct1", rebuilds: 1 }) },
    [
      ok({ status_code: "ERROR", status: "Error: 2207026", error: { code: 2207026, message: "unsupported" } }),
      {
        status: 200,
        headers: [
          ["content-type", "image/jpeg"],
          ["content-length", "1234"],
        ],
      },
    ],
  ),
  story(
    "processing-error-unreachable",
    "instagram_stories",
    { media: storyMedia, instagramStoryProgress: igState({ stage: "processing", containerId: "ct1", rebuilds: 1 }) },
    [ok({ status_code: "EXPIRED" }), lost("getaddrinfo ENOTFOUND")],
  ),
  story("ready-publish", "instagram_stories", { instagramStoryProgress: igState({ stage: "ready", containerId: "ct1" }) }, [
    ok({ id: "m1" }),
  ]),
  story("ready-publish-lost", "instagram_stories", { instagramStoryProgress: igState({ stage: "ready", containerId: "ct1" }) }, [lost()]),
  story("ready-publish-no-id", "instagram_stories", { instagramStoryProgress: igState({ stage: "ready", containerId: "ct1" }) }, [ok({})]),
  story("ready-expired-retry", "instagram_stories", { instagramStoryProgress: igState({ stage: "ready", containerId: "ct1" }) }, [
    status(400, { error: { message: "Media ID is not available", code: 9007, error_subcode: 2207027 } }),
  ]),
  story(
    "ready-expired-rebuild",
    "instagram_stories",
    { instagramStoryProgress: igState({ stage: "ready", containerId: "ct1", publishAttempts: 4 }) },
    [status(400, { error: { message: "Media ID is not available", code: 9007, error_subcode: 2207027 } })],
  ),
  story(
    "ready-expired-final",
    "instagram_stories",
    { instagramStoryProgress: igState({ stage: "ready", containerId: "ct1", publishAttempts: 4, rebuilds: 1 }) },
    [status(400, { error: { message: "Media ID is not available", code: 9007, error_subcode: 2207027 } })],
  ),
  story("ready-other-error", "instagram_stories", { instagramStoryProgress: igState({ stage: "ready", containerId: "ct1" }) }, [
    status(500, { error: { message: "unknown" } }),
  ]),
  story(
    "publish-sent-verify",
    "instagram_stories_ru",
    { instagramStoryProgress: igState({ stage: "publish_sent", containerId: "ct1", publishedId: "m1" }), _instagramPublishedId: ["m1"] },
    [ok({ id: "m1", permalink: "https://www.instagram.com/stories/s/1/" })],
  ),
  story("missing-credentials", "instagram_stories", { media: storyMedia }, [], { env: { INSTAGRAM_EN_USER_ID: null } }),
  {
    platform: "instagram",
    name: "adapter-verify",
    operation: "adapter.verify",
    inputs: { target: "instagram_stories_ru", payload: {}, result: { ok: true, id: "m2" } },
    responses: [ok({ id: "m2", permalink: "https://www.instagram.com/stories/s/2/" })],
  },
  {
    platform: "instagram",
    name: "adapter-verify-already",
    operation: "adapter.verify",
    inputs: { target: "instagram_stories", payload: {}, result: { ok: true, id: "m2", verification: { status: "verified" } } },
  },
  {
    platform: "instagram",
    name: "validate-missing",
    operation: "adapter.validate",
    inputs: { target: "instagram_stories_ru" },
    env: { INSTAGRAM_RU_ACCESS_TOKEN: null, INSTAGRAM_RU_USER_ID: null },
  },
  {
    platform: "instagram",
    name: "zernio-routed-story",
    operation: "adapter.publish",
    inputs: {
      target: "instagram_stories",
      routing: { instagram_stories: { provider: "zernio", accountId: "acc-ig" } },
      payload: {
        text: "caption",
        media: [
          { type: "IMAGE", vpsUrl: "https://media.example/1.jpg" },
          { type: "IMAGE", vpsUrl: "https://media.example/2.jpg" },
        ],
      },
    },
    responses: [ok({ _id: "zs1" })],
  },
  {
    platform: "instagram",
    name: "zernio-routed-story-no-media",
    operation: "adapter.publish",
    inputs: {
      target: "instagram_stories",
      routing: { instagram_stories: { provider: "zernio", accountId: "acc-ig" } },
      payload: { text: "c" },
    },
  },
  {
    platform: "instagram",
    name: "absent-missing",
    operation: "platform.text_absent",
    inputs: { target: "instagram_stories", externalId: "m1" },
    responses: [status(400, { error: { message: "Unsupported get request. Object with ID 'm1' does not exist" } })],
  },
];

const discordMessage = (id: string) => ok({ id, channel_id: "555" });
const discord = (name: string, payload: Record<string, unknown>, responses: Canned[], extra: Partial<Case> = {}): Case => ({
  platform: "discord",
  name,
  operation: "adapter.publish",
  inputs: { target: "discord", payload },
  responses,
  ...extra,
});

const discordCases: Case[] = [
  discord("message", { text: "Hello discord" }, [discordMessage("d1"), discordMessage("d1")]),
  discord("crosspost-refused", { text: "Hello" }, [discordMessage("d2"), status(403, { message: "Missing Permissions", code: 50013 })]),
  discord("crosspost-lost", { text: "Hello" }, [discordMessage("d3"), lost()]),
  discord("split", { text: `${"Paragraph one is here. ".repeat(80)}\n\n${"Second part. ".repeat(40)}` }, [
    discordMessage("d4"),
    { status: 200, body: "{}" },
    discordMessage("d5"),
    { status: 200, body: "{}" },
  ]),
  discord(
    "attachments",
    {
      text: "With media",
      media: [
        { type: "IMAGE", localPath: file("photo.jpg") },
        { type: "VIDEO", localPath: file("clip.mp4") },
        { type: "IMAGE", localPath: file("gone.jpg") },
        { type: "IMAGE", fileId: "tg-only" },
      ],
    },
    [discordMessage("d6"), discordMessage("d6")],
  ),
  discord("no-guild", { text: "Hello" }, [discordMessage("d7"), discordMessage("d7")], { env: { DISCORD_GUILD_ID: null } }),
  discord("missing-credentials", { text: "Hello" }, [], { env: { DISCORD_CHANNEL_ID: null }, credentials: { DISCORD_BOT_TOKEN: null } }),
  discord("create-lost", { text: "Hello" }, [lost()]),
  discord("create-refused", { text: "Hello" }, [
    status(429, { message: "You are being rate limited.", retry_after: 1.5 }, [["retry-after", "2"]]),
  ]),
  discord("create-no-id", { text: "Hello" }, [ok({})]),
  {
    platform: "discord",
    name: "verify",
    operation: "adapter.verify",
    inputs: { target: "discord", payload: {}, result: { ok: true, id: "d1", ids: ["d1"], url: null } },
    responses: [discordMessage("d1")],
  },
  {
    platform: "discord",
    name: "verify-mismatch",
    operation: "adapter.verify",
    inputs: { target: "discord", payload: {}, result: { ok: true, id: "d1" } },
    responses: [discordMessage("other")],
  },
  {
    platform: "discord",
    name: "edit",
    operation: "adapter.edit",
    inputs: { target: "discord", edit: { externalId: "d1", text: "edited", mediaCount: 0, externalIdCount: 1 } },
    responses: [ok({ id: "d1", content: "edited" })],
  },
  {
    platform: "discord",
    name: "edit-split",
    operation: "adapter.edit",
    inputs: { target: "discord", edit: { externalId: "d1", text: "edited", mediaCount: 0, externalIdCount: 2 } },
  },
  {
    platform: "discord",
    name: "edit-too-long",
    operation: "adapter.edit",
    inputs: { target: "discord", edit: { externalId: "d1", text: "y".repeat(2001), mediaCount: 0, externalIdCount: 1 } },
  },
  {
    platform: "discord",
    name: "remove",
    operation: "adapter.remove",
    inputs: { target: "discord", externalId: "d1" },
    responses: [{ status: 204 }],
  },
  {
    platform: "discord",
    name: "remove-missing",
    operation: "adapter.remove",
    inputs: { target: "discord", externalId: "d1" },
    responses: [status(404, { message: "Unknown Message", code: 10008 })],
  },
  {
    platform: "discord",
    name: "absent-missing",
    operation: "platform.text_absent",
    inputs: { target: "discord", externalId: "d1" },
    responses: [status(404, { message: "Unknown Message", code: 10008 })],
  },
];

const reelInput = {
  accountId: "acc-ig",
  publicUrl: "https://studio.example/media/video/asset/abc",
  metadata: { caption: "  Reel caption #tag  " },
  requestId: "video-publish:9:2026-11-21T10:00:00.000Z",
};
const duplicate = (
  accountId: string,
  platform: string,
  error = "This exact content is already scheduled, publishing, or was posted to this account within the last 24 hours.",
) => status(409, { error, details: { accountId, platform, existingPostId: "zp-existing" } });

const zernioCases: Case[] = [
  {
    platform: "zernio",
    name: "reel",
    operation: "zernio.reel",
    inputs: { input: reelInput },
    responses: [
      ok({
        post: {
          _id: "zp1",
          platforms: [{ platform: "instagram", platformPostId: "ig1", platformPostUrl: "https://instagram.com/reel/ig1" }],
        },
      }),
    ],
  },
  {
    platform: "zernio",
    name: "reel-replayed",
    operation: "zernio.reel",
    inputs: { input: reelInput },
    responses: [lost(), ok({ existingPost: { id: "zp2" } })],
  },
  {
    platform: "zernio",
    name: "reel-lost-twice",
    operation: "zernio.reel",
    inputs: { input: reelInput },
    responses: [lost(), lost("socket hang up")],
  },
  {
    platform: "zernio",
    name: "reel-analytics-permalink",
    operation: "zernio.reel",
    inputs: { input: reelInput },
    responses: [
      ok({
        _id: "zp3",
        platforms: [{ platform: "tiktok", platformPostId: "tt" }],
        platformAnalytics: [{ platform: "instagram", platformPostId: "ig3", platformPostUrl: "https://instagram.com/reel/ig3" }],
      }),
    ],
  },
  {
    platform: "zernio",
    name: "reel-duplicate-reconciled",
    operation: "zernio.reel",
    inputs: { input: reelInput },
    responses: [
      duplicate("acc-ig", "instagram"),
      ok({ _id: "zp-existing", platforms: [{ platform: "instagram", platformPostId: "ig4" }] }),
    ],
  },
  {
    platform: "zernio",
    name: "reel-duplicate-lookup-fails",
    operation: "zernio.reel",
    inputs: { input: reelInput },
    responses: [duplicate("acc-ig", "instagram"), status(500, "oops")],
  },
  {
    platform: "zernio",
    name: "reel-duplicate-other-account",
    operation: "zernio.reel",
    inputs: { input: reelInput },
    responses: [duplicate("acc-other", "instagram")],
  },
  {
    platform: "zernio",
    name: "reel-duplicate-other-reason",
    operation: "zernio.reel",
    inputs: { input: reelInput },
    responses: [duplicate("acc-ig", "instagram", "Something else")],
  },
  {
    platform: "zernio",
    name: "reel-no-post-id",
    operation: "zernio.reel",
    inputs: { input: reelInput },
    responses: [ok({ status: "ok" })],
  },
  {
    platform: "zernio",
    name: "reel-no-key",
    operation: "zernio.reel",
    inputs: { input: reelInput },
    credentials: { ZERNIO_API_KEY: null },
  },
  {
    platform: "zernio",
    name: "reel-refused-redacted",
    operation: "zernio.reel",
    inputs: { input: reelInput },
    responses: [status(401, { error: "Invalid API key test-token-zernio" })],
  },
  {
    platform: "zernio",
    name: "outcome-published",
    operation: "zernio.outcome",
    inputs: { providerPostId: "zp/1", platform: "instagram" },
    responses: [
      ok({
        post: { _id: "zp/1", status: "published", platforms: [{ platform: "instagram", platformPostId: "ig5", platformPostUrl: "u5" }] },
      }),
    ],
  },
  {
    platform: "zernio",
    name: "outcome-failed",
    operation: "zernio.outcome",
    inputs: { providerPostId: "zp6", platform: "instagram" },
    responses: [ok({ _id: "zp6", status: "failed", platforms: [{ platform: "instagram", status: "failed", error: "Media too short" }] })],
  },
  {
    platform: "zernio",
    name: "outcome-failed-analytics",
    operation: "zernio.outcome",
    inputs: { providerPostId: "zp7", platform: "instagram" },
    responses: [ok({ _id: "zp7", platformAnalytics: [{ platform: "instagram", status: "failed", errorMessage: "Rejected" }] })],
  },
  {
    platform: "zernio",
    name: "outcome-failed-no-detail",
    operation: "zernio.outcome",
    inputs: { providerPostId: "zp8", platform: "instagram" },
    responses: [ok({ _id: "zp8", status: "failed" })],
  },
  {
    platform: "zernio",
    name: "outcome-mismatch",
    operation: "zernio.outcome",
    inputs: { providerPostId: "zp9", platform: "instagram" },
    responses: [ok({ _id: "other" })],
  },
  {
    platform: "zernio",
    name: "verify-pending",
    operation: "zernio.verify",
    inputs: { providerPostId: "zp10", platform: "instagram" },
    responses: [ok({ _id: "zp10", platforms: [] })],
  },
];

const ytToken = ok({ access_token: "test-token-youtube-access", expires_in: 3599 });
const ytMetadata = { title: "Title", description: "Body", tags: ["a", "b"] };
const ytSession: Canned = { status: 200, headers: [["location", "https://upload.example/session/1?upload_id=u1"]] };
const youtube = (name: string, responses: Canned[], extra: Partial<Case> = {}): Case => ({
  platform: "youtube",
  name,
  operation: "youtube.prepare",
  inputs: { file: "upload.mp4", metadata: ytMetadata, publishAt: "2026-12-01T10:00:00.000Z", locale: "ru" },
  responses,
  ...extra,
});

const youtubeCases: Case[] = [
  youtube("upload", [ytToken, ytSession, ok({ id: "vid1", snippet: {} })]),
  youtube("upload-en", [ytToken, ytSession, ok({ id: "vid2" })], {
    inputs: { file: "upload.mp4", metadata: { title: "T", description: "D", tags: [] }, publishAt: "2026-12-02T08:30:00Z", locale: "en" },
  }),
  youtube("upload-lost-then-complete", [ytToken, ytSession, lost(), ok({ id: "vid3" })]),
  youtube("upload-lost-then-resume", [ytToken, ytSession, lost(), { status: 308, headers: [["range", "bytes=0-9"]] }, ok({ id: "vid4" })]),
  youtube("upload-lost-then-nothing-committed", [ytToken, ytSession, lost(), { status: 308 }, ok({ id: "vid5" })]),
  youtube("upload-lost-resume-lost", [ytToken, ytSession, lost(), { status: 308, headers: [["range", "bytes=0-9"]] }, lost()]),
  youtube("upload-lost-all-committed-confirmed", [
    ytToken,
    ytSession,
    lost(),
    { status: 308, headers: [["range", "bytes=0-31"]] },
    ok({ id: "vid6" }),
  ]),
  youtube("upload-lost-all-committed-unconfirmed", [
    ytToken,
    ytSession,
    lost(),
    { status: 308, headers: [["range", "bytes=0-31"]] },
    { status: 308, headers: [["range", "bytes=0-31"]] },
  ]),
  youtube("upload-lost-status-refused", [ytToken, ytSession, lost(), status(404, { error: { message: "session expired" } })]),
  youtube("upload-refused", [ytToken, ytSession, status(400, { error: { message: "invalid metadata" } })]),
  youtube("session-no-location", [ytToken, { status: 200 }]),
  youtube("session-unauthorized", [ytToken, status(401, { error: { code: 401, message: "Invalid Credentials" } })]),
  youtube("session-quota", [ytToken, status(403, { error: { message: "quotaExceeded" } }, [["retry-after", "3600"]])]),
  youtube("token-refused", [status(400, { error: "invalid_grant" })]),
  {
    platform: "youtube",
    name: "keep-private",
    operation: "youtube.keep_private",
    inputs: { videoId: "vid/1", locale: "en" },
    responses: [
      ytToken,
      ok({
        items: [
          {
            status: {
              privacyStatus: "private",
              publishAt: "2026-12-01T10:00:00Z",
              license: "creativeCommon",
              embeddable: false,
              publicStatsViewable: true,
              selfDeclaredMadeForKids: false,
              containsSyntheticMedia: true,
              uploadStatus: "processed",
            },
          },
        ],
      }),
      ok({ id: "vid/1" }),
    ],
  },
  {
    platform: "youtube",
    name: "keep-private-sparse",
    operation: "youtube.keep_private",
    inputs: { videoId: "vid2", locale: "ru" },
    responses: [ytToken, ok({ items: [{ status: { privacyStatus: "private", embeddable: null } }] }), ok({})],
  },
  {
    platform: "youtube",
    name: "keep-private-not-found",
    operation: "youtube.keep_private",
    inputs: { videoId: "vid3", locale: "ru" },
    responses: [ytToken, ok({ items: [] })],
  },
  {
    platform: "youtube",
    name: "verify",
    operation: "youtube.verify",
    inputs: { videoId: "vid4", locale: "ru" },
    responses: [ytToken, ok({ items: [{ id: "vid4", status: { privacyStatus: "public" } }] })],
  },
  {
    platform: "youtube",
    name: "verify-missing",
    operation: "youtube.verify",
    inputs: { videoId: "vid5", locale: "en" },
    responses: [ytToken, ok({ items: [] })],
  },
  {
    platform: "youtube",
    name: "absent",
    operation: "video.absent",
    inputs: {
      locale: "ru",
      videoTarget: { target: "youtube_shorts", externalId: "vid6", deliveryProvider: "native", providerPostId: null },
    },
    responses: [ytToken, ok({ items: [] })],
  },
  {
    platform: "youtube",
    name: "absent-no-external-id",
    operation: "video.absent",
    inputs: { locale: "ru", videoTarget: { target: "youtube_shorts", externalId: null, deliveryProvider: "native", providerPostId: null } },
  },
];

const reels = (name: string, operation: keyof typeof OPERATIONS, inputs: Inputs, responses: Canned[], extra: Partial<Case> = {}): Case => ({
  platform: "reels",
  name,
  operation,
  inputs,
  responses,
  ...extra,
});

const reelsCases: Case[] = [
  reels(
    "prepare-facebook-host",
    "reels.prepare",
    { locale: "ru", publicUrl: "https://studio.example/v.mp4", metadata: { caption: "  Cap  " } },
    [ok({ id: "rc1" })],
  ),
  reels(
    "prepare-instagram-host",
    "reels.prepare",
    { locale: "en", publicUrl: "https://studio.example/v.mp4", metadata: { caption: "Cap" } },
    [ok({ id: "rc2" })],
  ),
  reels("prepare-missing-credentials", "reels.prepare", { locale: "en", publicUrl: "u", metadata: { caption: "c" } }, [], {
    env: { INSTAGRAM_EN_USER_ID: null },
  }),
  reels("ready", "reels.ready", { locale: "ru", containerId: "rc1" }, [ok({ status_code: "FINISHED" })]),
  reels("ready-processing", "reels.ready", { locale: "ru", containerId: "rc1" }, [ok({ status_code: "IN_PROGRESS" })]),
  reels("ready-unknown", "reels.ready", { locale: "ru", containerId: "rc1" }, [ok({})]),
  reels("ready-error", "reels.ready", { locale: "ru", containerId: "rc1" }, [ok({ status_code: "ERROR", status: "Error: bad media" })]),
  reels("ready-expired", "reels.ready", { locale: "en", containerId: "rc1" }, [ok({ status_code: "EXPIRED" })]),
  reels("publish", "reels.publish", { locale: "ru", containerId: "rc1" }, [ok({ id: "reel1" })]),
  reels("publish-expired", "reels.publish", { locale: "ru", containerId: "rc1" }, [
    status(400, { error: { message: "The creation_id is not valid", error_subcode: 2207006 } }),
  ]),
  reels("publish-500-matching", "reels.publish", { locale: "ru", containerId: "rc1" }, [
    status(500, { error: { message: "invalid container" } }),
  ]),
  reels("publish-lost", "reels.publish", { locale: "ru", containerId: "rc1" }, [lost()]),
  reels(
    "absent-instagram",
    "video.absent",
    { locale: "en", videoTarget: { target: "instagram_reels", externalId: "reel1", deliveryProvider: "native", providerPostId: null } },
    [status(404, { error: { message: "not found" } })],
  ),
  reels(
    "absent-instagram-present",
    "video.absent",
    { locale: "ru", videoTarget: { target: "instagram_reels", externalId: "reel1", deliveryProvider: "native", providerPostId: null } },
    [ok({ id: "reel1" })],
  ),
  reels(
    "absent-zernio",
    "video.absent",
    { locale: "ru", videoTarget: { target: "instagram_reels", externalId: null, deliveryProvider: "zernio", providerPostId: "zp1" } },
    [status(404, { error: "Post not found" })],
  ),
  reels(
    "absent-zernio-no-id",
    "video.absent",
    { locale: "ru", videoTarget: { target: "instagram_reels", externalId: null, deliveryProvider: "zernio", providerPostId: null } },
    [],
  ),
];

const manifest = (outputs: Record<string, unknown>) =>
  ok({ job: "j1", requestId: "r1", timings: { uploadMs: 10, ffmpegMs: 900, totalMs: 950, cacheHit: false }, outputs });
const variant = (body: string): Canned => ({ status: 200, headers: [["content-type", "video/mp4"]], body });
const remote = (name: string, inputs: Partial<Inputs>, responses: Canned[], extra: Partial<Case> = {}): Case => ({
  platform: "remote-media",
  name,
  operation: "remote_media.process",
  inputs: {
    source: "clip.mp4",
    kind: "video",
    variants: [
      { name: "standard", output: "out/story.mp4" },
      { name: "telegram", output: "out/story-telegram.mp4" },
    ],
    timeoutMs: 60_000,
    ...inputs,
  },
  responses,
  writes: ["out/story.mp4", "out/story-telegram.mp4"],
  ...extra,
});

const remoteCases: Case[] = [
  remote("video", {}, [manifest({ standard: { bytes: 5 }, telegram: { bytes: 4 } }), variant("STD-1"), variant("TG-1")]),
  remote(
    "image",
    { source: "photo.jpg", kind: "image", variants: [{ name: "standard", output: "out/story.jpg" }] },
    [manifest({ standard: { bytes: 3 } }), variant("IMG")],
    { writes: ["out/story.jpg"] },
  ),
  remote("busy", {}, [status(503, "encoder busy", [["retry-after", "30"]])]),
  remote("refused-long", {}, [status(422, "e".repeat(900))]),
  remote("not-json", {}, [{ status: 200, headers: [["content-type", "text/plain"]], body: "ok" }]),
  remote("missing-variant", {}, [manifest({ standard: { bytes: 5 } })]),
  remote("variant-failed", {}, [manifest({ standard: { bytes: 5 }, telegram: { bytes: 4 } }), { status: 404, body: "gone" }]),
  remote("timeout", { timeoutMs: 5 }, [{ hang: true }]),
  remote("upload-lost", {}, [lost()]),
  remote("not-configured", {}, [], { env: { MEDIA_PROCESSOR_TOKEN: null } }),
];

const captionCases: Case[] = [
  ["plain", "  Hello story  ", []],
  [
    "urls-stripped",
    "Read https://example.com/a now \n\n\n\nnext http://x.y",
    [{ type: "text_link", offset: 0, length: 4, url: "https://e.com" }],
  ],
  ["hidden-link", "Tap here for more", [{ type: "text_link", offset: 4, length: 4, url: "https://example.com/more" }]],
  ["hidden-link-bad-range", "Tap here", [{ type: "text_link", offset: 4, length: 40, url: "https://example.com" }]],
  [
    "mixed-entities",
    "Bold and link",
    [{ type: "bold", offset: 0, length: 4 }, null, "x", [1], { type: "text_link", offset: "9", length: 4, url: "u" }],
  ],
  ["long", "z".repeat(2100), [{ type: "text_link", offset: 0, length: 2, url: "https://example.com" }]],
  ["trimmed-offsets", "  Tap here", [{ type: "text_link", offset: 0, length: 3, url: "https://example.com" }]],
].map(([name, text, entities]) => ({
  platform: "stories",
  name: `caption-${name}`,
  operation: "stories.caption" as const,
  inputs: { text, entities },
}));

const storiesCases: Case[] = [
  ...captionCases,
  {
    platform: "stories",
    name: "upload-media-video",
    operation: "stories.upload_media",
    inputs: { path: "/data/story.mp4", type: "VIDEO", metadata: { width: 1080, height: 1920, duration: 12 } },
  },
  {
    platform: "stories",
    name: "upload-media-photo",
    operation: "stories.upload_media",
    inputs: { path: "/data/story.jpg", type: "IMAGE", metadata: { width: 1, height: 2, duration: 3 } },
  },
  {
    platform: "stories",
    name: "publish-missing-media",
    operation: "adapter.publish",
    inputs: { target: "telegram_stories", payload: { text: "t", media: [{ type: "IMAGE", vpsUrl: "https://media.example/a.jpg" }] } },
  },
  {
    platform: "stories",
    name: "publish-missing-credentials",
    operation: "adapter.publish",
    inputs: { target: "telegram_stories", payload: { text: "t", media: [{ type: "IMAGE", localPath: file("story.jpg") }] } },
    env: { TELEGRAM_CHANNEL_STORIES_API_ID: "12345", TELEGRAM_CHANNEL_STORIES_API_HASH: "test-secret-hash" },
  },
  {
    platform: "stories",
    name: "publish-missing-channel",
    operation: "adapter.publish",
    inputs: {
      target: "telegram_stories",
      payload: { text: "t", media: [{ type: "IMAGE", localPath: file("photo.jpg"), storyLocalPath: file("story.jpg") }] },
    },
    env: {
      TELEGRAM_CHANNEL_STORIES_API_ID: "12345",
      TELEGRAM_CHANNEL_STORIES_API_HASH: "test-secret-hash",
      TELEGRAM_CHANNEL_STORIES_SESSION: "/data/stories.session",
    },
  },
  {
    platform: "stories",
    name: "validate-missing",
    operation: "adapter.validate",
    inputs: { target: "telegram_stories" },
    env: { TELEGRAM_CHANNEL_STORIES_API_ID: "12345" },
  },
];

const CASES: Case[] = [
  ...telegramCases,
  ...xCases,
  ...threadsCases,
  ...instagramCases,
  ...discordCases,
  ...zernioCases,
  ...youtubeCases,
  ...reelsCases,
  ...remoteCases,
  ...storiesCases,
];

// ---- run ------------------------------------------------------------------

writeFiles();
fs.rmSync(out, { recursive: true, force: true });
const seen = new Set<string>();
const counts: Record<string, number> = {};
for (const spec of CASES) {
  const key = `${spec.platform}/${spec.name}`;
  if (seen.has(key)) throw new Error(`duplicate case ${key}`);
  seen.add(key);
  const caseConfig: CaseConfig = { env: merged(BASE_ENV, spec.env), credentials: merged(BASE_CREDENTIALS, spec.credentials) };
  const scrub = scrubber(caseConfig);
  const { requests, fetchImpl, unused } = recorder(spec.responses ?? [], scrub);
  const sleeps: number[] = [];
  for (const written of spec.writes ?? []) fs.rmSync(file(written), { force: true });
  const run = OPERATIONS[spec.operation];
  if (!run) throw new Error(`unknown operation ${spec.operation}`);
  let outcome: Record<string, unknown>;
  try {
    const result = await run(spec.inputs, { config: backendConfig(caseConfig), fetchImpl, sleeps });
    outcome = { ok: scrubDeep(JSON.parse(JSON.stringify(result ?? null)), scrub) };
  } catch (error) {
    outcome = { error: errorShape(error, scrub) };
  }
  if (unused() > 0) throw new Error(`${key}: ${unused()} canned responses were never asked for`);
  const written = Object.fromEntries(
    (spec.writes ?? []).map((name) => [name, fs.existsSync(file(name)) ? sha256(fs.readFileSync(file(name))) : null]),
  );
  const golden = {
    name: spec.name,
    operation: spec.operation,
    inputs: scrubDeep(spec.inputs, (text) => text.replaceAll(FILES, "$FILES")),
    config: caseConfig,
    files: FILE_SPECS,
    responses: spec.responses ?? [],
    requests,
    sleptMs: sleeps.reduce((sum, ms) => sum + ms, 0),
    written,
    outcome,
  };
  fs.mkdirSync(path.join(out, spec.platform), { recursive: true });
  fs.writeFileSync(path.join(out, spec.platform, `${spec.name}.json`), `${JSON.stringify(golden, null, 2)}\n`);
  counts[spec.platform] = (counts[spec.platform] ?? 0) + 1;
}
fs.rmSync(scratch, { recursive: true, force: true });
// The repository's formatter has the last word on layout (it folds short
// arrays onto one line), so a re-run leaves `biome check parity` clean.
const format = spawnSync(path.join(root, "node_modules/.bin/biome"), ["format", "--write", out], { cwd: root, stdio: "ignore" });
if (format.status !== 0) throw new Error("biome format failed on the goldens");
console.log(JSON.stringify({ cases: CASES.length, counts }));
