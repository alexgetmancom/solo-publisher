import { Database } from "bun:sqlite";
import { setSystemTime } from "bun:test";
import crypto from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { createBot } from "../../../apps/backend/src/bot.js";
import { openBackendDb, unsafeDb } from "../../../apps/backend/src/db/client.js";
import { configureLogging } from "../../../apps/backend/src/foundation/logger.js";
import { runFfmpeg } from "../../../apps/backend/src/foundation/runtime/ffmpeg.js";
import { loadRuntimeConfig } from "../../../apps/backend/src/runtime/config.js";
import { settingsService } from "../../../apps/backend/src/studio/services/settings.js";
import { registerTestChannels, type TestChannelId } from "../../../apps/backend/tests/helpers/channels.js";

/**
 * Golden recorder for the Telegram bot (plans/rust/PLAN.md, "Parity method for
 * the bot"). It drives the real `createBot` (apps/backend/src/bot.ts + bot/**)
 * with Telegram updates and records every Bot API call the bot puts on the wire,
 * in order, so the Rust port can be diffed byte for byte.
 *
 *   bun scripts/rust/bot-goldens.ts            # all cases
 *   bun scripts/rust/bot-goldens.ts <filter>   # case ids containing <filter> (does not prune others)
 *
 * Output: parity/bot-goldens/<area>/<case-id>.json, one file per case:
 *   { id, specRef, seed, steps: [{ update | trigger, calls: [{ method, payload }], db? }] }
 * A case that calls `h.watch(sql…)` also records, after every later step, what
 * each of those queries returns (`db: [{ sql, rows }]`, columns sorted): the
 * database effects a worker tick leaves, which a replay compares as it does calls.
 *
 * How calls are captured: grammY's `ApiClientOptions.fetch` is injected into
 * every Bot the process creates (by wrapping `createRawApi`, the factory grammY's
 * `Api` reads at construction), so the recorder sits *below* every transformer
 * the bot installs (timing, auto-retry, the unchanged-edit guard, the menu
 * plugin). A call the guard suppresses is therefore absent, exactly as it is
 * absent from the wire. The fake API answers like Telegram: message ids per chat,
 * "message is not modified" for an identical edit, "there is no text in the
 * message to edit" for an edit of a media message, "wrong file_id" for an
 * unknown file. `getFile` returns absolute local paths (the local Bot API server
 * mode the bot supports), so media import copies fixture files and never
 * downloads. Plain `fetch` (Markdown document download, deploy agent) is stubbed
 * globally and recorded as `method: "http"`.
 *
 * Determinism:
 * - The clock is pinned with `setSystemTime` to NOW (2026-08-20T09:00:00Z, 12:00
 *   MSK); a case may move it with `h.clock(...)`. Studio time zone Europe/Moscow
 *   (label MSK), actor time zone left at the Studio's; process TZ=UTC.
 * - The actor (Telegram user 1001, private chat 1001) is the only admin; its
 *   interface locale is stored as `ru` before anything runs (plans/rust/DECISIONS.md;
 *   an actor with no stored locale reads as `en`).
 * - Every case opens a fresh in-memory database, a fresh bot and a fresh fake
 *   Telegram (message ids restart at 1 per case). Update ids and callback query
 *   ids are per case (`<case-id>#<n>`), so the process-wide callback dedupe never
 *   sees one case's tap in another.
 * - The unchanged-edit guard keeps a process-wide LRU of 200 message contents.
 *   Between cases the recorder flushes it by sending 201 unrecorded messages to
 *   a throwaway chat, so no case inherits another's memory.
 * - Video fixtures are generated with ffmpeg in bit-exact mode; their sha256 is
 *   stable for one ffmpeg build.
 * - Background work (video download, deploy request, Story-card waiter) is
 *   awaited explicitly: a step that starts it waits for the call that reports
 *   its outcome; every step then waits until the fake Telegram is quiet. The
 *   Story-card timeout case shortens the waiter's 1 s polls to 1 ms.
 *
 * Normalisations (the only places recorded output differs from the wire):
 * - JSON payloads are re-serialised with object keys sorted recursively (array
 *   order kept). Telegram does not read key order.
 * - Multipart uploads: the random boundary is dropped and the payload is written
 *   as its fields (string values, exactly as sent; JSON-looking fields such as
 *   `reply_markup` and `media` parsed). Each uploaded file becomes
 *   `{ file: { name, contentType, sha256, size } }` in place of its random
 *   `attach://<id>` reference. The daily database backup's sha256 and size are
 *   written as `<sqlite backup>` (its bytes depend on SQLite's page layout); what
 *   is recorded instead is that the file opens as SQLite (`integrity`, from
 *   `PRAGMA integrity_check`) and the tables it holds (`tables`).
 * - `method: "http"` entries carry method and URL; a body is kept only for the
 *   deploy agent (a provider's request — translator, Zernio — is not bot output).
 * - Absolute paths under the run's temporary directory are written as
 *   `<tmp>/...` (they reach payloads only through error texts and file URLs).
 * - OAuth start links (Settings → Connect) carry a random PKCE challenge and a
 *   sealed random state: the `state=` and `code_challenge=` query values are
 *   written as `<random>`.
 *
 * Replay seeds (`--seeds`, for the Rust golden test in crates/bot/tests/goldens.rs):
 * each case also writes, under _trash-rust/tmp/bot-goldens-seeds/<area>/,
 * `<case>.db` (the database right before the first step), `<case>.meta.json`
 * (per step: the clock, the scripted Telegram failures, the held method, the
 * files getFile serves; per case: channels and env) and `<case>.golden.json`.
 * When the case itself changed the database between two steps, that step gets
 * `<case>.step-<n>.db` and `reseed` in its meta, so a replay can load it.
 */

export const ROOT = path.join(import.meta.dir, "../../..");
const BACKEND = path.join(ROOT, "apps/backend");
export const OUT = path.join(ROOT, "parity/bot-goldens");
export const SEEDS = path.join(ROOT, "_trash-rust/tmp/bot-goldens-seeds");
const TMP = path.join(ROOT, "_trash-rust/tmp/bot-goldens");

process.env.TZ = "UTC";
process.env.PATH = `${path.join(process.env.HOME ?? "", ".local/bin")}:${process.env.PATH ?? ""}`;
process.env.TMPDIR = path.join(ROOT, "_trash-rust/tmp");

const NOW = new Date("2026-08-20T09:00:00.000Z");
setSystemTime(NOW);

export const ADMIN = 1001;
export const STRANGER = 2002;
const BOT_TOKEN = "123456:TEST-TOKEN";
const API_ROOT = "http://telegram.invalid";
export const DEPLOY_AGENT_URL = "http://deploy-agent.invalid";
const BOT_USER = { id: 123456, is_bot: true, first_name: "Studio", username: "studio_test_bot" };

// ---- grammY transport hook ---------------------------------------------------

type Fetch = (url: string, init?: { body?: unknown; headers?: Record<string, string> }) => Promise<Response>;
let activeTelegram: FakeTelegram | null = null;

{
  const backendRequire = createRequire(path.join(BACKEND, "src/bot.ts"));
  const client = backendRequire(backendRequire.resolve("grammy").replace(/mod\.js$/, "core/client.js")) as {
    createRawApi: (token: string, options: Record<string, unknown> | undefined, envelope: unknown) => unknown;
  };
  const createRawApi = client.createRawApi;
  const telegramFetch: Fetch = async (url, init) => {
    if (!activeTelegram) throw new Error(`Bot API call outside a case: ${url}`);
    return activeTelegram.handle(url, init);
  };
  client.createRawApi = (token, options, envelope) => createRawApi(token, { ...options, fetch: telegramFetch }, envelope);
}

configureLogging("error");
type Bot = NonNullable<ReturnType<typeof createBot>>;
type BackendDb = ReturnType<typeof openBackendDb>;
type Config = ReturnType<typeof loadRuntimeConfig>;

// ---- recording ---------------------------------------------------------------

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Call = { method: string; transport?: "multipart"; payload: Json };
type Effect = { sql: string; rows: Json[] };
type Step = { update?: Json; trigger?: string; calls: Call[]; db?: Effect[] };
/** What a replay needs to put in place before one step (see the header). */
type StepMeta = {
  at: string;
  files: Record<string, string>;
  failures?: Record<string, TelegramError[]>;
  hold?: string;
  opaqueUploads?: true;
  reseed?: string;
};

/** OAuth start links carry a fresh PKCE challenge and a sealed state every time. */
const RANDOM_QUERY = /([?&](?:state|code_challenge)=)[^&\s"]+/g;

function sortKeys(value: unknown): Json {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
        .map((key) => [key, sortKeys((value as Record<string, unknown>)[key])]),
    );
  if (typeof value === "string") return value.split(TMP).join("<tmp>").replace(RANDOM_QUERY, "$1<random>");
  return (value ?? null) as Json;
}

async function bodyBytes(body: unknown): Promise<Buffer> {
  if (typeof body === "string") return Buffer.from(body);
  const chunks: Buffer[] = [];
  for await (const chunk of body as AsyncIterable<Uint8Array | string>) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

/** Splits a grammY multipart body into its named fields and files. */
function parseMultipart(
  bytes: Buffer,
  contentType: string,
): { fields: Record<string, string>; files: Record<string, Json>; contents: Record<string, Buffer> } {
  const boundary = /boundary=(.+)$/.exec(contentType)?.[1];
  if (!boundary) throw new Error(`multipart without boundary: ${contentType}`);
  const fields: Record<string, string> = {};
  const files: Record<string, Json> = {};
  const contents: Record<string, Buffer> = {};
  const marker = Buffer.from(`--${boundary}`);
  let start = bytes.indexOf(marker) + marker.length;
  while (start > marker.length - 1) {
    const end = bytes.indexOf(marker, start);
    if (end < 0) break;
    const part = bytes.subarray(start + 2, end - 2); // skip CRLF after marker and before the next
    const split = part.indexOf("\r\n\r\n");
    const head = part.subarray(0, split).toString("utf8");
    const content = part.subarray(split + 4);
    const name = /name="([^"]+)"/.exec(head)?.[1] ?? "";
    const filename = /filename=("?)([^\r\n"]*)\1/.exec(head)?.[2];
    if (filename !== undefined) {
      contents[name] = content;
      files[name] = {
        file: {
          name: filename,
          contentType: /content-type:([^\r\n]+)/i.exec(head)?.[1]?.trim() ?? "",
          sha256: crypto.createHash("sha256").update(content).digest("hex"),
          size: content.length,
        },
      };
    } else fields[name] = content.toString("utf8");
    start = end + marker.length;
  }
  return { fields, files, contents };
}

/** What an opaque upload (a SQLite backup) is checked for instead of its bytes. */
function sqliteSummary(content: Buffer): Record<string, Json> {
  const database = Database.deserialize(content, true);
  try {
    const integrity = database.query<{ integrity_check: string }, []>("PRAGMA integrity_check").get()?.integrity_check ?? null;
    const tables = database
      .query<{ name: string }, []>("select name from sqlite_master where type = 'table' order by name")
      .all()
      .map((row) => row.name);
    return { integrity, tables };
  } finally {
    database.close();
  }
}

function multipartPayload(bytes: Buffer, contentType: string, opaque: boolean): Json {
  const { fields, files, contents } = parseMultipart(bytes, contentType);
  if (opaque)
    for (const [name, file] of Object.entries(files)) {
      const descriptor = (file as { file: Record<string, Json> }).file;
      descriptor.sha256 = "<sqlite backup>";
      descriptor.size = "<sqlite backup>";
      Object.assign(descriptor, sqliteSummary(contents[name] ?? Buffer.alloc(0)));
    }
  const attach = (value: unknown): unknown => {
    if (typeof value === "string" && value.startsWith("attach://")) return files[value.slice("attach://".length)] ?? value;
    if (Array.isArray(value)) return value.map(attach);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, attach(item)]));
    return value;
  };
  const payload: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(fields)) {
    if (value.startsWith("attach://")) payload[name] = attach(value);
    else if (value.startsWith("{") || value.startsWith("[")) payload[name] = attach(JSON.parse(value));
    else payload[name] = value;
  }
  return sortKeys(payload);
}

// ---- fake Telegram -----------------------------------------------------------

type StoredMessage = {
  message_id: number;
  chat_id: number;
  text?: string;
  caption?: string;
  media?: string;
  reply_markup?: Json;
  from_bot: boolean;
  content: string;
};

type TelegramError = { error_code: number; description: string };

class FakeTelegram {
  calls: Call[] = [];
  recording = true;
  readonly messages = new Map<string, StoredMessage>();
  private readonly nextMessageId = new Map<number, number>();
  /** file_id -> absolute path; what `getFile` answers. */
  readonly files = new Map<string, string>();
  /** Per-method scripted failures, consumed in order. */
  readonly failures = new Map<string, TelegramError[]>();
  /** Uploads whose bytes are not reproducible (a SQLite backup file). */
  opaqueUploads = false;
  /** Calls whose answer is held until released (to keep a chat busy). */
  hold: { method: string; release: Promise<void> } | null = null;

  newMessageId(chatId: number): number {
    const id = (this.nextMessageId.get(chatId) ?? 0) + 1;
    this.nextMessageId.set(chatId, id);
    return id;
  }

  message(chatId: number, messageId: number): StoredMessage | undefined {
    return this.messages.get(`${chatId}:${messageId}`);
  }

  /** The newest message in the chat. */
  last(chatId: number): StoredMessage | undefined {
    return [...this.messages.values()].filter((message) => message.chat_id === chatId).sort((a, b) => b.message_id - a.message_id)[0];
  }

  async handle(url: string, init?: { body?: unknown; headers?: Record<string, string> }): Promise<Response> {
    const method = url.slice(url.lastIndexOf("/") + 1);
    const contentType = init?.headers?.["content-type"] ?? "";
    const bytes = await bodyBytes(init?.body ?? "{}");
    const multipart = contentType.startsWith("multipart/");
    const payload = multipart
      ? multipartPayload(bytes, contentType, this.opaqueUploads)
      : sortKeys(JSON.parse(bytes.toString("utf8") || "{}"));
    if (this.recording) this.calls.push(multipart ? { method, transport: "multipart", payload } : { method, payload });
    if (this.hold?.method === method) {
      const { release } = this.hold;
      this.hold = null;
      await release;
    }
    const failure = this.failures.get(method)?.shift();
    if (failure) return Response.json({ ok: false, ...failure });
    const outcome = this.answer(method, payload as Record<string, Json>);
    return Response.json("error_code" in outcome ? { ok: false, ...outcome } : { ok: true, result: outcome.result });
  }

  private store(chatId: number, fields: Omit<StoredMessage, "message_id" | "chat_id" | "from_bot" | "content">): Json {
    const message_id = this.newMessageId(chatId);
    const stored: StoredMessage = { message_id, chat_id: chatId, from_bot: true, ...fields, content: "" };
    stored.content = contentKey(stored);
    this.messages.set(`${chatId}:${message_id}`, stored);
    return messageJson(stored);
  }

  private answer(method: string, payload: Record<string, Json>): { result: Json } | TelegramError {
    const chatId = Number(payload.chat_id);
    const markup = inlineMarkup(payload.reply_markup);
    switch (method) {
      case "getMe":
        return { result: BOT_USER };
      case "sendMessage":
        return { result: this.store(chatId, { text: String(payload.text), ...(markup ? { reply_markup: markup } : {}) }) };
      case "sendPhoto":
      case "sendVideo":
      case "sendDocument":
      case "sendAnimation":
        return {
          result: this.store(chatId, {
            media: method.slice(4).toLowerCase(),
            ...(payload.caption != null ? { caption: String(payload.caption) } : {}),
            ...(markup ? { reply_markup: markup } : {}),
          }),
        };
      case "sendMediaGroup": {
        const media = Array.isArray(payload.media) ? payload.media : [];
        return {
          result: media.map((item) => {
            const entry = item as Record<string, Json>;
            return this.store(chatId, { media: String(entry.type), ...(entry.caption != null ? { caption: String(entry.caption) } : {}) });
          }),
        };
      }
      case "editMessageText": {
        const stored = this.message(chatId, Number(payload.message_id));
        if (!stored) return { error_code: 400, description: "Bad Request: message to edit not found" };
        if (stored.media) return { error_code: 400, description: "Bad Request: there is no text in the message to edit" };
        const next: StoredMessage = { ...stored, text: String(payload.text), content: "" };
        if (markup) next.reply_markup = markup;
        else delete next.reply_markup;
        next.content = contentKey(next, payload);
        if (next.content === contentKey(stored, null, stored.content))
          return {
            error_code: 400,
            description:
              "Bad Request: message is not modified: specified new message content and reply markup are exactly the same as a current content and reply markup of the message",
          };
        this.messages.set(`${chatId}:${stored.message_id}`, next);
        return { result: messageJson(next) };
      }
      case "editMessageReplyMarkup": {
        const stored = this.message(chatId, Number(payload.message_id));
        if (!stored) return { error_code: 400, description: "Bad Request: message to edit not found" };
        const next = { ...stored };
        if (markup) next.reply_markup = markup;
        else delete next.reply_markup;
        this.messages.set(`${chatId}:${stored.message_id}`, next);
        return { result: messageJson(next) };
      }
      case "deleteMessage":
        this.messages.delete(`${chatId}:${Number(payload.message_id)}`);
        return { result: true };
      case "getFile": {
        const fileId = String(payload.file_id);
        const file = this.files.get(fileId);
        if (!file) return { error_code: 400, description: "Bad Request: wrong file_id or the file is temporarily unavailable" };
        return { result: { file_id: fileId, file_unique_id: `u-${fileId}`, file_size: fs.statSync(file).size, file_path: file } };
      }
      default:
        return { result: true };
    }
  }

  /** A message someone else put in the chat (the deploy agent), with buttons. */
  inject(chatId: number, text: string, keyboard: Json): StoredMessage {
    const message_id = this.newMessageId(chatId);
    const stored: StoredMessage = { message_id, chat_id: chatId, text, reply_markup: keyboard, from_bot: true, content: "" };
    stored.content = contentKey(stored);
    this.messages.set(`${chatId}:${message_id}`, stored);
    return stored;
  }
}

function inlineMarkup(markup: Json | undefined): Json | undefined {
  if (!markup || typeof markup !== "object" || Array.isArray(markup)) return undefined;
  const rows = (markup as Record<string, Json>).inline_keyboard;
  return Array.isArray(rows) && rows.length ? { inline_keyboard: rows } : undefined;
}

/** What Telegram compares to decide an edit changes nothing: the text with its
 * formatting, and the inline keyboard (an empty one is no keyboard). */
function contentKey(message: StoredMessage, payload: Record<string, Json> | null = null, previous?: string): string {
  if (previous !== undefined) return previous;
  return JSON.stringify({
    text: message.text ?? null,
    parse_mode: payload?.parse_mode ?? null,
    entities: payload?.entities ?? null,
    reply_markup: message.reply_markup ?? null,
  });
}

function messageJson(message: StoredMessage): Json {
  return sortKeys({
    message_id: message.message_id,
    date: Math.floor(Date.now() / 1000),
    chat: { id: message.chat_id, type: "private", first_name: "Admin" },
    from: BOT_USER,
    ...(message.text !== undefined ? { text: message.text } : {}),
    ...(message.caption !== undefined ? { caption: message.caption } : {}),
    ...(message.media === "photo"
      ? { photo: [{ file_id: `sent-photo-${message.message_id}`, file_unique_id: "p", width: 1, height: 1 }] }
      : {}),
    ...(message.media === "video"
      ? { video: { file_id: `sent-video-${message.message_id}`, file_unique_id: "v", width: 1, height: 1, duration: 1 } }
      : {}),
    ...(message.media === "document" ? { document: { file_id: `sent-doc-${message.message_id}`, file_unique_id: "d" } } : {}),
    ...(message.reply_markup ? { reply_markup: message.reply_markup } : {}),
  });
}

// ---- plain fetch (file downloads, deploy agent) ------------------------------

function parseBody(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
}

type HttpHandler = (url: string, init?: RequestInit) => Response | Promise<Response>;
let httpHandler: HttpHandler | null = null;

globalThis.fetch = Object.assign(
  async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (!activeTelegram || !httpHandler) throw new Error(`Unexpected network request: ${url}`);
    // Only the deploy agent's request body is the bot's own output; a provider's
    // (translator, Zernio) is that integration's business, not the bot's.
    const body = typeof init?.body === "string" && url.startsWith(DEPLOY_AGENT_URL) ? init.body : null;
    activeTelegram.calls.push({
      method: "http",
      payload: sortKeys({ method: init?.method ?? "GET", url, ...(body === null ? {} : { body: parseBody(body) }) }),
    });
    return httpHandler(url, init);
  },
  { preconnect: () => {} },
) as typeof fetch;

// ---- fixtures ------------------------------------------------------------------

const FIXTURES = path.join(TMP, "fixtures");

/** Smallest valid 1x1 JPEG (the same bytes scripts/fixtures/site-fixture.ts serves). */
const JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAj/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCdABmX/9k=",
  "base64",
);

export const FIXTURE = {
  photo: path.join(FIXTURES, "photo.jpg"),
  /** 5 s, 270x480 (9:16), H.264 + AAC noise bed: passes every check. */
  clip: path.join(FIXTURES, "clip.mp4"),
  /** 95 s, 9:16: over the 90 s warning. */
  long: path.join(FIXTURES, "long.mp4"),
  /** 4 s, 480x270 (16:9), no audio: the music and aspect warnings. */
  silent: path.join(FIXTURES, "silent.mp4"),
  markdown: path.join(FIXTURES, "article.md"),
};

/** Through the backend's own ffmpeg runner, which is how the Studio calls it. */
async function ffmpeg(target: string, args: string[]): Promise<void> {
  if (fs.existsSync(target)) return;
  await runFfmpeg([
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    ...args,
    "-map_metadata",
    "-1",
    "-fflags",
    "+bitexact",
    "-flags",
    "+bitexact",
    target,
  ]);
}

async function writeFixtures(): Promise<void> {
  fs.mkdirSync(FIXTURES, { recursive: true });
  fs.writeFileSync(FIXTURE.photo, JPEG);
  fs.writeFileSync(
    FIXTURE.markdown,
    "# Как мы считаем охваты\n\nОхват — это число людей, которые увидели публикацию хотя бы раз.\n\n## Методика\n\nМы складываем уникальных зрителей по каждой площадке.\n",
  );
  const video = (size: string, seconds: number) => [
    "-f",
    "lavfi",
    "-i",
    `color=c=0x336699:s=${size}:r=10:d=${seconds}`,
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-g",
    "10",
  ];
  const audio = (seconds: number) => ["-f", "lavfi", "-i", `anoisesrc=d=${seconds}:a=0.2:seed=7`, "-c:a", "aac", "-b:a", "48k"];
  await ffmpeg(FIXTURE.clip, [
    ...video("270x480", 5).slice(0, 4),
    ...audio(5).slice(0, 4),
    ...video("270x480", 5).slice(4),
    ...audio(5).slice(4),
    "-shortest",
  ]);
  await ffmpeg(FIXTURE.long, [
    ...video("90x160", 95).slice(0, 4),
    ...audio(95).slice(0, 4),
    ...video("90x160", 95).slice(4),
    ...audio(95).slice(4),
    "-shortest",
  ]);
  await ffmpeg(FIXTURE.silent, [...video("480x270", 4), "-an"]);
}

// ---- the harness one case drives ------------------------------------------------

type CaseContext = { id: string; specRef: string };

export class Harness {
  readonly telegram = new FakeTelegram();
  readonly steps: Step[] = [];
  readonly seed: string[] = [];
  readonly backendDb: BackendDb;
  readonly config: Config;
  readonly bot: Bot;
  private updateId = 0;
  private callbackId = 0;
  readonly dataDir: string;
  readonly stepMeta: StepMeta[] = [];
  /** The database as the previous step left it, to tell the case's own writes apart. */
  private afterStep: Uint8Array | null = null;
  fastStoryWaits = false;
  /** Queries recorded after every step from `watch` on (see the header). */
  private readonly watched: string[] = [];

  constructor(
    readonly meta: CaseContext,
    options: { channels: readonly TestChannelId[]; env?: Record<string, string> | undefined },
    /** Where this case writes its replay seeds, when it does. */
    private readonly seeds: string | null = null,
  ) {
    this.dataDir = path.join(TMP, "cases", meta.id);
    fs.rmSync(this.dataDir, { recursive: true, force: true });
    fs.mkdirSync(this.dataDir, { recursive: true });
    activeTelegram = this.telegram;
    httpHandler = fileDownload;
    this.backendDb = openBackendDb(":memory:");
    registerTestChannels(unsafeDb(this.backendDb) as never, options.channels);
    this.backendDb.studioSettings.saveProfile({ timezone: "Europe/Moscow", timezoneLabel: "MSK", updatedAt: NOW.toISOString() });
    // An actor without a stored locale reads as `en` (studio/services/settings.ts
    // readLocale), so the Russian interface the goldens record is set explicitly.
    settingsService(this.backendDb).setLocale(ADMIN, "ru");
    this.config = loadRuntimeConfig(
      {
        NODE_ENV: "test",
        DATA_DIR: this.dataDir,
        CONTROLLER_BOT_TOKEN: BOT_TOKEN,
        CONTROLLER_ADMIN_IDS: String(ADMIN),
        TELEGRAM_API_BASE_URL: API_ROOT,
        DEPLOY_AGENT_URL,
        DEPLOY_AGENT_TOKEN: "deploy-agent-test-token",
        // Credentials the video platforms are "configured" with; nothing calls them.
        YOUTUBE_RU_CLIENT_ID: "youtube-ru-client",
        YOUTUBE_RU_CLIENT_SECRET: "youtube-ru-secret",
        YOUTUBE_RU_REFRESH_TOKEN: "youtube-ru-refresh",
        YOUTUBE_EN_CLIENT_ID: "youtube-en-client",
        YOUTUBE_EN_CLIENT_SECRET: "youtube-en-secret",
        YOUTUBE_EN_REFRESH_TOKEN: "youtube-en-refresh",
        INSTAGRAM_RU_ACCESS_TOKEN: "instagram-ru-token",
        INSTAGRAM_RU_USER_ID: "1700000000000001",
        INSTAGRAM_EN_ACCESS_TOKEN: "instagram-en-token",
        INSTAGRAM_EN_USER_ID: "1700000000000002",
        ...options.env,
      },
      this.backendDb,
    );
    const bot = createBot(this.config, this.backendDb);
    if (!bot) throw new Error("bot is disabled");
    this.bot = bot;
    this.bot.botInfo = { ...BOT_USER, can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false } as never;
  }

  /** Construction-time calls (setMyCommands) belong to the bootstrap case only. */
  async bootstrap(): Promise<void> {
    await this.idle();
    if (this.meta.id !== "bootstrap") this.telegram.calls = [];
    else {
      this.checkpoint();
      this.steps.push({ trigger: "createBot", calls: this.telegram.calls.splice(0) });
      this.stepDone();
    }
  }

  /** Writes what a replay of the next step starts from (only with `--seeds`). */
  private checkpoint(): void {
    if (!this.seeds) return;
    const sqlite = unsafeDb(this.backendDb).sqlite;
    const index = this.stepMeta.length;
    const step: StepMeta = { at: new Date().toISOString(), files: Object.fromEntries(this.telegram.files) };
    const failures = [...this.telegram.failures].filter(([, list]) => list.length);
    if (failures.length) step.failures = Object.fromEntries(failures.map(([method, list]) => [method, [...list]]));
    if (this.telegram.hold) step.hold = this.telegram.hold.method;
    if (this.telegram.opaqueUploads) step.opaqueUploads = true;
    fs.mkdirSync(this.seeds, { recursive: true });
    const write = (name: string) => {
      const target = path.join(this.seeds ?? "", name);
      fs.rmSync(target, { force: true });
      sqlite.run("VACUUM INTO ?", [target]);
    };
    if (index === 0) write(`${this.meta.id}.db`);
    else if (this.afterStep && Buffer.compare(Buffer.from(sqlite.serialize()), Buffer.from(this.afterStep)) !== 0) {
      step.reseed = `${this.meta.id}.step-${index}.db`;
      write(step.reseed);
    }
    this.stepMeta.push(step);
  }

  /** Records, after every later step, what these queries return. */
  watch(...queries: string[]): void {
    this.watched.push(...queries);
  }

  /** The step's calls, and what the watched queries return after it. */
  private finish(step: Step): void {
    step.calls = this.telegram.calls.splice(0);
    if (this.watched.length) {
      const { sqlite } = unsafeDb(this.backendDb);
      step.db = this.watched.map((sql) => ({ sql, rows: sqlite.prepare(sql).all().map(sortKeys) }));
    }
    this.stepDone();
  }

  private stepDone(): void {
    if (this.seeds) this.afterStep = unsafeDb(this.backendDb).sqlite.serialize();
  }

  user(id = ADMIN): Json {
    return { id, is_bot: false, first_name: id === ADMIN ? "Admin" : "Stranger", language_code: "ru" };
  }

  private nextUpdateId(): number {
    this.updateId += 1;
    return this.updateId;
  }

  /** A message the operator sends. */
  async send(fields: Record<string, Json>, options: { from?: number | undefined; until?: Until | undefined } = {}): Promise<number> {
    const from = options.from ?? ADMIN;
    const messageId = this.telegram.newMessageId(from);
    const update = {
      update_id: this.nextUpdateId(),
      message: {
        message_id: messageId,
        date: Math.floor(Date.now() / 1000),
        chat: { id: from, type: "private", first_name: from === ADMIN ? "Admin" : "Stranger" },
        from: this.user(from),
        ...fields,
      },
    };
    await this.feed(update, options.until);
    return messageId;
  }

  text(text: string, options: { from?: number | undefined; until?: Until | undefined } = {}): Promise<number> {
    const command = /^\/\w+/.exec(text)?.[0];
    return this.send({ text, ...(command ? { entities: [{ type: "bot_command", offset: 0, length: command.length }] } : {}) }, options);
  }

  photo(fileId: string, caption?: string, extra: Record<string, Json> = {}): Promise<number> {
    this.telegram.files.set(fileId, FIXTURE.photo);
    return this.send({
      photo: [
        { file_id: `${fileId}-small`, file_unique_id: `${fileId}-s`, width: 90, height: 90, file_size: 1200 },
        { file_id: fileId, file_unique_id: `${fileId}-l`, width: 1280, height: 1280, file_size: JPEG.length },
      ],
      ...(caption ? { caption } : {}),
      ...extra,
    });
  }

  video(fileId: string, source: string, extra: Record<string, Json> = {}, until?: Until): Promise<number> {
    this.telegram.files.set(fileId, source);
    const size = fs.statSync(source).size;
    return this.send(
      {
        video: {
          file_id: fileId,
          file_unique_id: `${fileId}-u`,
          width: 270,
          height: 480,
          duration: 5,
          mime_type: "video/mp4",
          file_name: `${fileId}.mp4`,
          file_size: size,
        },
        ...extra,
      },
      { until },
    );
  }

  document(fileId: string, source: string, fileName: string, mime: string, extra: Record<string, Json> = {}): Promise<number> {
    this.telegram.files.set(fileId, source);
    return this.send({
      document: {
        file_id: fileId,
        file_unique_id: `${fileId}-u`,
        file_name: fileName,
        mime_type: mime,
        file_size: fs.statSync(source).size,
      },
      ...extra,
    });
  }

  /** The button whose label (or, with `byData`, whose callback_data) matches, on a
   * message (default: the newest message carrying one). */
  button(label: string | RegExp, messageId?: number, byData = false): { data: string; messageId: number } {
    const candidates = messageId
      ? [this.telegram.message(ADMIN, messageId)].filter((message) => message !== undefined)
      : [...this.telegram.messages.values()].filter((message) => message.chat_id === ADMIN).sort((a, b) => b.message_id - a.message_id);
    for (const message of candidates) {
      const rows = ((message.reply_markup as { inline_keyboard?: Array<Array<Record<string, Json>>> } | undefined)?.inline_keyboard ??
        []) as Array<Array<Record<string, Json>>>;
      for (const row of rows)
        for (const button of row) {
          const text = byData ? String(button.callback_data) : String(button.text);
          if ((typeof label === "string" ? text === label : label.test(text)) && typeof button.callback_data === "string")
            return { data: button.callback_data, messageId: message.message_id };
        }
    }
    throw new Error(`${this.meta.id}: no button ${String(label)}${messageId ? ` on message ${messageId}` : ""}`);
  }

  /** Taps the button with this label. */
  tap(
    label: string | RegExp,
    options: { messageId?: number | undefined; from?: number | undefined; until?: Until | undefined } = {},
  ): Promise<void> {
    const { data, messageId } = this.button(label, options.messageId);
    return this.callback(data, { messageId, from: options.from, until: options.until });
  }

  /** Taps the button carrying this callback_data (exact string, or a pattern). */
  tapData(data: string | RegExp, options: { messageId?: number | undefined; until?: Until | undefined } = {}): Promise<void> {
    const found = this.button(data, options.messageId, true);
    return this.callback(found.data, { messageId: found.messageId, until: options.until });
  }

  callbackUpdate(
    data: string,
    options: { messageId?: number | undefined; from?: number | undefined; id?: string | undefined } = {},
  ): Record<string, Json> {
    const from = options.from ?? ADMIN;
    const message = options.messageId === undefined ? this.telegram.last(from) : this.telegram.message(from, options.messageId);
    if (!message) throw new Error(`${this.meta.id}: no message to tap`);
    this.callbackId += 1;
    return {
      update_id: this.nextUpdateId(),
      callback_query: {
        id: options.id ?? `${this.meta.id}#${this.callbackId}`,
        from: this.user(from),
        chat_instance: "chat-instance-1001",
        data,
        message: messageJson(message),
      },
    };
  }

  /** A tap carrying exactly this callback_data. */
  callback(
    data: string,
    options: { messageId?: number | undefined; from?: number | undefined; until?: Until | undefined; id?: string | undefined } = {},
  ): Promise<void> {
    return this.feed(this.callbackUpdate(data, options), options.until);
  }

  async feed(update: Record<string, Json>, until?: Until): Promise<void> {
    this.checkpoint();
    const step: Step = { update: sortKeys(update), calls: [] };
    this.steps.push(step);
    await this.handle(update);
    await this.idle(until);
    this.finish(step);
  }

  /** One update as the runner hands it to grammY: a handler that throws
   * reaches `bot.catch` (`bot.errorHandler`) and goes no further. */
  private async handle(update: Record<string, Json>): Promise<void> {
    await this.bot.handleUpdate(update as never).catch((error: unknown) => this.bot.errorHandler(error as never));
  }

  /** Feeds several updates at once, the way the runner hands a burst to grammY. */
  async feedTogether(updates: Array<Record<string, Json>>): Promise<void> {
    this.checkpoint();
    const step: Step = { update: updates.map(sortKeys), calls: [] };
    this.steps.push(step);
    await Promise.all(updates.map((update) => this.handle(update)));
    await this.idle();
    this.finish(step);
  }

  /** Anything not driven by an update: a worker tick, a background repaint. */
  async trigger(name: string, run: () => Promise<unknown> | unknown, until?: Until): Promise<void> {
    this.checkpoint();
    const step: Step = { trigger: name, calls: [] };
    this.steps.push(step);
    await run();
    await this.idle(until);
    this.finish(step);
  }

  note(text: string): void {
    this.seed.push(text);
  }

  /** The Story-card waiter polls with `setTimeout(…, 1000)` sixty times; this
   * makes each of those waits 1 ms for the rest of the case (nothing else in the
   * bot waits exactly one second). */
  fastStoryWait(): void {
    const original = this.originalSetTimeout;
    globalThis.setTimeout = ((handler: () => void, ms?: number, ...args: unknown[]) =>
      original(handler, ms === 1000 ? 1 : ms, ...args)) as typeof setTimeout;
    this.fastStoryWaits = true;
    this.note("The Story-card waiter's one-second polls are shortened to 1 ms (60 polls, then the timeout).");
  }

  private readonly originalSetTimeout = globalThis.setTimeout;

  clock(at: string | Date): void {
    setSystemTime(new Date(at));
  }

  /** Waits for background work: either until `until` holds, or until the fake
   * Telegram has been quiet for a while. */
  async idle(until?: Until): Promise<void> {
    if (until) {
      const deadline = performance.now() + (until.timeoutMs ?? 20_000);
      while (!until.done(this.telegram.calls)) {
        if (performance.now() > deadline) throw new Error(`${this.meta.id}: timed out waiting for ${until.what}`);
        await Bun.sleep(10);
      }
    }
    let seen = -1;
    let quiet = 0;
    while (quiet < 4) {
      await Bun.sleep(10);
      if (this.telegram.calls.length === seen) quiet += 1;
      else {
        seen = this.telegram.calls.length;
        quiet = 0;
      }
    }
  }

  /** Empties the unchanged-edit guard's process-wide memory (see header). */
  async flushEditMemory(): Promise<void> {
    this.telegram.recording = false;
    for (let index = 0; index < 201; index += 1) await this.bot.api.sendMessage(999_999_999, "flush");
    this.telegram.recording = true;
  }

  close(): void {
    globalThis.setTimeout = this.originalSetTimeout;
    this.backendDb.close();
    activeTelegram = null;
    httpHandler = null;
    setSystemTime(NOW);
  }
}

type Until = { what: string; done: (calls: Call[]) => boolean; timeoutMs?: number | undefined };

/** Waits until a call satisfying `test` has been recorded. */
export function untilCall(what: string, test: (call: Call) => boolean, timeoutMs?: number): Until {
  return { what, done: (calls) => calls.some(test), timeoutMs };
}

export function textOf(call: Call): string {
  const payload = call.payload as Record<string, Json>;
  return typeof payload.text === "string" ? payload.text : "";
}

/** Serves Telegram file downloads (`{root}/file/bot{token}/{file_path}`) from the
 * paths getFile handed out; any other URL is a case that forgot its stub. */
export const fileDownload: HttpHandler = (url) => {
  const prefix = `${API_ROOT}/file/bot${BOT_TOKEN}/`;
  if (!url.startsWith(prefix)) throw new Error(`no HTTP stub for ${url}`);
  const file = url.slice(prefix.length);
  return new Response(fs.readFileSync(file), { headers: { "content-length": String(fs.statSync(file).size) } });
};

export function setHttp(handler: HttpHandler): void {
  httpHandler = handler;
}

// ---- cases ------------------------------------------------------------------------

/** Every connection a full Studio has: all text targets and both video platforms. */
const ALL_CHANNELS: readonly TestChannelId[] = [
  "site_en",
  "site_ru",
  "telegram",
  "telegram_stories",
  "instagram_stories",
  "instagram_stories_ru",
  "threads_en",
  "threads_ru",
  "x",
  "discord",
  "instagram_en",
  "instagram_ru",
  "youtube_en",
  "youtube_ru",
];

export type Case = {
  id: string;
  area: string;
  specRef: string;
  channels?: readonly TestChannelId[];
  env?: Record<string, string>;
  run: (h: Harness) => Promise<void>;
};

/** Runs one case on its own database, bot and fake Telegram, and returns its golden.
 * With `seeds`, it also writes the replay seeds described in the header. */
export async function record(item: Case, seeds = false): Promise<Json> {
  const channels = item.channels ?? ALL_CHANNELS;
  const seedDir = path.join(SEEDS, item.area);
  const h = new Harness({ id: item.id, specRef: item.specRef }, { channels, env: item.env }, seeds ? seedDir : null);
  try {
    await h.bootstrap();
    await item.run(h);
    await h.flushEditMemory();
  } catch (error) {
    // What the case recorded before it broke, for whoever reads the failure.
    const partial = path.join(TMP, "failed", `${item.id}.json`);
    fs.mkdirSync(path.dirname(partial), { recursive: true });
    fs.writeFileSync(
      partial,
      `${JSON.stringify(sortKeys({ id: item.id, specRef: item.specRef, seed: h.seed, steps: h.steps }), null, 2)}\n`,
    );
    throw error;
  } finally {
    h.close();
  }
  const golden = sortKeys({ id: item.id, specRef: item.specRef, seed: h.seed, steps: h.steps });
  if (seeds) {
    const meta = { id: item.id, area: item.area, channels, env: item.env ?? {}, fastStoryWait: h.fastStoryWaits, steps: h.stepMeta };
    fs.writeFileSync(path.join(seedDir, `${item.id}.meta.json`), `${JSON.stringify(meta, null, 2)}\n`);
    fs.writeFileSync(path.join(seedDir, `${item.id}.golden.json`), `${JSON.stringify(golden, null, 2)}\n`);
  }
  return golden;
}

export function prepareFixtures(): Promise<void> {
  return writeFixtures();
}
