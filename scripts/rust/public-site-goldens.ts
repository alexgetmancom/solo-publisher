import { Database } from "bun:sqlite";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createApiHandler } from "../../apps/backend/src/api.js";
import { openBackendDb, unsafeDb } from "../../apps/backend/src/db/client.js";
import { loadConfig, withStudioProfile } from "../../apps/backend/src/foundation/config.js";
import { runFfmpeg } from "../../apps/backend/src/foundation/runtime/ffmpeg.js";

/**
 * The TypeScript side of the Rust public site parity test
 * (crates/public_site/tests/goldens.rs): every case drives the real
 * `GET /api/public/site` route (`createApiHandler`) on its own database and
 * DATA_DIR under a fixed clock, and records every response — status,
 * headers, body — and the events the read model journalled.
 *
 *   bun scripts/rust/public-site-goldens.ts              writes parity/public-site/goldens.json
 *   bun scripts/rust/public-site-goldens.ts --prod <db> <now>
 *       answers once over a copy of a database and prints only the body's
 *       sha256, the ETag and the item count (never row contents).
 *
 * A step is
 *   {"clock": "<ISO>"} | {"sql": "<statements>"} | {"external_sql": "<statements>"}
 *   {"write": "<path under SITE_PUBLIC_DIR>", "base64": "<bytes>", "mtime": <unix seconds>}
 *   {"request": {"if_none_match"?: "<etag>" | "$previous", "prefer"?: "<value>"}, "during"?: [<step>...]}
 * `during` steps run 20 ms after the request started, while it may be waiting.
 */

type Request = { if_none_match?: string; prefer?: string };
type Step =
  | { clock: string }
  | { sql: string }
  | { external_sql: string }
  | { write: string; base64: string; mtime: number }
  | { request: Request; during?: Step[] };
type Case = { name: string; steps: Step[] };
type Recorded = { status: number; headers: Record<string, string | null>; body: string | null };

let nowMs = Date.parse("2026-11-01T10:00:00.000Z");
const RealDate = Date;
class FixedDate extends RealDate {
  constructor(...args: unknown[]) {
    if (args.length === 0) super(nowMs);
    else super(...(args as [string]));
  }
  static override now(): number {
    return nowMs;
  }
}
globalThis.Date = FixedDate as DateConstructor;

// ---------------------------------------------------------------- fixtures

const T0 = "2026-11-01T10:00:00.000Z";
const at = (offsetMs: number) => new RealDate(RealDate.parse(T0) + offsetMs).toISOString();
const HOUR = 3_600_000;
const MTIME = 1_790_000_000;

const q = (value: unknown): string => {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") return String(value);
  if (typeof value === "object" && "raw" in (value as object)) return (value as { raw: string }).raw;
  return `'${String(value).replaceAll("'", "''")}'`;
};

type LocaleSeed = {
  text?: string;
  approved?: string | null;
  html?: string | null;
  slug?: string | null | { raw: string };
  seo?: string | null;
  site?: boolean;
  publishedAt?: string | null;
  siteUpdatedAt?: string | null;
  /** A JSON value, or `{raw: "<SQL>"}` for what the column holds verbatim. */
  media?: unknown;
};
type PostSeed = {
  draftId: number;
  postId?: number | null | { raw: string };
  status?: string;
  createdAt?: string;
  updatedAt?: string;
  scheduledAt?: string | null;
  scheduledEnAt?: string | null;
  ru?: LocaleSeed;
  en?: LocaleSeed;
};

function post(seed: PostSeed): string {
  const createdAt = seed.createdAt ?? at(-24 * HOUR);
  const updatedAt = seed.updatedAt ?? createdAt;
  const postId = seed.postId === undefined ? seed.draftId : seed.postId;
  const statements = [
    `INSERT INTO drafts (id, actor_id, status, targets_json, scheduled_at, scheduled_en_at, post_id, created_at, updated_at)
     VALUES (${seed.draftId}, 7, ${q(seed.status ?? "published")}, '{}', ${q(seed.scheduledAt)}, ${q(seed.scheduledEnAt)}, ${q(postId)}, ${q(createdAt)}, ${q(updatedAt)});`,
  ];
  for (const [locale, value] of [
    ["ru", seed.ru],
    ["en", seed.en],
  ] as const) {
    if (!value) continue;
    const media =
      value.media === undefined
        ? "'[]'"
        : typeof value.media === "object" && value.media !== null && "raw" in value.media
          ? (value.media as { raw: string }).raw
          : q(JSON.stringify(value.media));
    const site = value.site ?? true;
    const publishedAt = value.publishedAt === undefined ? (site ? at(-2 * HOUR) : null) : value.publishedAt;
    statements.push(
      `INSERT INTO post_locales (draft_id, locale, source_text, approved_text, html, site_media_json, slug, seo_title, site_updated_at, site_enabled, published_at, updated_at)
       VALUES (${seed.draftId}, '${locale}', ${q(value.text ?? "")}, ${q(value.approved)}, ${q(value.html)}, ${media}, ${q(value.slug === undefined ? `post-${seed.draftId}-${locale}` : value.slug)}, ${q(value.seo)}, ${q(value.siteUpdatedAt)}, ${site ? 1 : 0}, ${q(publishedAt)}, ${q(updatedAt)});`,
    );
  }
  return statements.join("\n");
}

const SITE_ON = "UPDATE studio_profile SET site_enabled = 1;";

type ImageKind = "jpeg" | "png" | "gif" | "avif" | "webp" | "webp-lossless" | "webp-alpha";
const IMAGE_ARGS: Record<ImageKind, string[]> = {
  jpeg: ["-c:v", "mjpeg", "-f", "image2"],
  png: ["-c:v", "png", "-f", "image2"],
  gif: ["-f", "gif"],
  avif: ["-c:v", "libaom-av1", "-still-picture", "1", "-f", "avif"],
  webp: ["-c:v", "libwebp", "-f", "webp"],
  "webp-lossless": ["-c:v", "libwebp", "-lossless", "1", "-f", "webp"],
  "webp-alpha": ["-c:v", "libwebp", "-pix_fmt", "yuva420p", "-f", "webp"],
};

/** A real encoder's file, made with ffmpeg; `orientation` adds an EXIF block
 * (big-endian, one IFD entry) right after a JPEG's SOI marker. */
async function image(kind: ImageKind, width: number, height: number, orientation?: number): Promise<string> {
  const file = path.resolve(`_trash-rust/tmp/public-site-images/${kind}-${width}x${height}`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const color = kind === "webp-alpha" ? "color=c=black@0.5:s=" : "color=c=white:s=";
  await runFfmpeg([
    "-v",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    `${color}${width}x${height}:d=1${kind === "webp-alpha" ? ",format=rgba" : ""}`,
    "-frames:v",
    "1",
    ...IMAGE_ARGS[kind],
    file,
  ]);
  let bytes = fs.readFileSync(file);
  if (orientation) {
    const tiff = Buffer.from([0x4d, 0x4d, 0, 0x2a, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, orientation, 0, 0, 0, 0, 0, 0]);
    const payload = Buffer.concat([Buffer.from("Exif\0\0", "binary"), tiff]);
    const segment = Buffer.concat([Buffer.from([0xff, 0xe1, (payload.length + 2) >> 8, (payload.length + 2) & 0xff]), payload]);
    bytes = Buffer.concat([bytes.subarray(0, 2), segment, bytes.subarray(2)]);
  }
  return bytes.toString("base64");
}

const placeholder = Buffer.from("bytes").toString("base64");
const write = (file: string, base64 = placeholder, mtime = MTIME): Step => ({ write: file, base64, mtime });
const request = (headers: Request = {}, during?: Step[]): Step => (during ? { request: headers, during } : { request: headers });
const matching = (prefer?: string): Step => request(prefer ? { if_none_match: "$previous", prefer } : { if_none_match: "$previous" });

async function cases(): Promise<Case[]> {
  const jpeg = await image("jpeg", 48, 32);
  const rotated = await image("jpeg", 48, 32, 6);
  const png = await image("png", 30, 20);
  const gif = await image("gif", 21, 13);
  const avif = await image("avif", 40, 24);
  const lossy = await image("webp", 36, 18);
  const lossless = await image("webp-lossless", 37, 19);
  const extended = await image("webp-alpha", 38, 22);
  const small = await image("webp", 20, 10);
  const smaller = await image("webp", 18, 9);
  return [
    {
      name: "site disabled",
      steps: [{ sql: post({ draftId: 1, en: { text: "English" } }) }, request(), request({ prefer: "wait=2" })],
    },
    {
      name: "empty feed, conditional requests and an unchanged wait",
      steps: [
        { sql: SITE_ON },
        request(),
        matching(),
        request({ if_none_match: '"older"', prefer: "wait=25" }),
        matching("wait=invalid"),
        matching("wait=1"),
        matching("wait=4"),
      ],
    },
    {
      name: "identity in both languages",
      steps: [
        {
          sql: `${SITE_ON}
          UPDATE studio_profile SET timezone = 'Europe/Moscow', timezone_label = 'MSK',
            name_json = '{"en":"Alex","ru":"Алекс"}', tagline_json = '{"en":"Notes \\"quoted\\"","ru":"Заметки"}',
            about_json = '{"en":"About\\nme","ru":""}', bio_json = '{"en":"","ru":"Био"}',
            site_timezone_json = '{"en":"America/New_York","ru":"  "}',
            profiles_json = '{"en":[{"label":"X","url":"https://x.com/a"}],"ru":[{"label":"Telegram","url":"https://t.me/a"},{"label":"YouTube","url":"https://youtube.com/@a"}]}';`,
        },
        request(),
      ],
    },
    {
      name: "locales, statuses and views",
      steps: [
        { sql: SITE_ON },
        {
          sql: [
            post({
              draftId: 1,
              updatedAt: at(-10 * HOUR),
              ru: { text: "Только русский «текст»", seo: "SEO ru" },
              en: { text: "hidden", site: false },
            }),
            post({
              draftId: 2,
              updatedAt: at(-9 * HOUR),
              ru: { text: "скрыт", site: false, seo: "hidden seo" },
              en: { text: "English only", seo: "SEO en", siteUpdatedAt: at(-HOUR) },
            }),
            post({
              draftId: 3,
              updatedAt: at(-8 * HOUR),
              ru: { text: "Исходный", approved: "Одобренный", html: "<p>Одобренный</p>", siteUpdatedAt: at(-3 * HOUR) },
              en: { text: "Machine", approved: "Approved", html: null, slug: null },
            }),
            post({ draftId: 4, status: "failed", updatedAt: at(-7 * HOUR), en: { text: "Failed but public line\ttab\u0001" } }),
            post({ draftId: 5, status: "scheduled", updatedAt: at(-7 * HOUR), en: { text: "Scheduled status" } }),
            post({ draftId: 6, status: "draft", updatedAt: at(-6 * HOUR), en: { text: "Private draft" } }),
            post({ draftId: 7, postId: null, updatedAt: at(-6 * HOUR), en: { text: "No post id" } }),
            post({ draftId: 8, updatedAt: at(-5 * HOUR), ru: { text: "off", site: false }, en: { text: "off", site: false } }),
            post({ draftId: 9, postId: 20, updatedAt: at(-7 * HOUR), en: { text: "Same updated_at, higher post id" } }),
            post({ draftId: 10, updatedAt: at(-4 * HOUR), en: { text: "", html: null } }),
            post({ draftId: 11, updatedAt: at(-4 * HOUR) }),
            `INSERT INTO post_metrics (publication_key, target, metric_name, value) VALUES
               ('post:1', 'telegram', 'views', 1234), ('post:2', 'telegram', 'views', 12.5),
               ('post:3', 'threads_ru', 'views', 99), ('post:3', 'telegram', 'reactions', 5);`,
          ].join("\n"),
        },
        request(),
      ],
    },
    {
      name: "scheduled locales appear when the clock reaches them",
      steps: [
        { sql: SITE_ON },
        {
          sql: [
            post({ draftId: 1, ru: { text: "Позже", publishedAt: at(HOUR) }, en: { text: "Now", publishedAt: at(-HOUR) } }),
            post({ draftId: 2, ru: { text: "Будущее", publishedAt: at(2 * HOUR) }, en: { text: "Future", publishedAt: at(3 * HOUR) } }),
            post({ draftId: 3, scheduledAt: at(-5 * HOUR), ru: { text: "Без даты", publishedAt: null } }),
            post({ draftId: 4, scheduledEnAt: at(-6 * HOUR), en: { text: "No date", publishedAt: null } }),
            post({ draftId: 5, en: { text: "Created only", publishedAt: null } }),
          ].join("\n"),
        },
        request(),
        matching(),
        { clock: at(HOUR) },
        matching(),
        { clock: at(2 * HOUR + 1) },
        request(),
        { clock: at(3 * HOUR) },
        request(),
      ],
    },
    {
      name: "media filtered to files on disk",
      steps: [
        { sql: SITE_ON },
        write("media/posts/present.jpg"),
        write("media/posts/clip.mp4"),
        write("media/posts/poster.jpg"),
        write("media/posts/en-only.jpg"),
        {
          sql: [
            post({
              draftId: 1,
              ru: {
                text: "Медиа",
                media: [
                  { type: "image", path: "media/posts/missing.jpg?v=abcdef012345" },
                  {
                    type: "image",
                    path: "/media/posts/present.jpg?v=abcdef012345",
                    alt: "Подпись",
                    width: 12,
                    height: 34,
                    file_id: "x",
                    asset_id: 4,
                    local_path: "/private/a.jpg",
                  },
                  { type: "video", path: "media/posts/clip.mp4", poster: "media/posts/missing-poster.jpg", responsive: [{ path: "x" }] },
                  { type: "video", path: "media/posts/clip.mp4?v=1", poster: "media/posts/poster.jpg", width: 1920 },
                  { type: "video", path: "media/posts/clip.mp4#t=2", poster: "" },
                  { type: "image", path: "media/posts/present.jpg", role: "text_story_card" },
                  { path: "media/posts/present.jpg", extra: { nested: [1, 2.5, null] }, poster_responsive: 7 },
                ],
              },
              en: { text: "Media" },
            }),
            post({
              draftId: 2,
              ru: { text: "Не тот формат", media: [{ type: "image", path: "media/posts/present.jpg", alt: null }] },
              en: { text: "Own media", media: [{ type: "image", path: "media/posts/en-only.jpg" }] },
            }),
            post({
              draftId: 3,
              ru: { text: "Объект", media: { path: "media/posts/present.jpg" } },
              en: { text: "Empty path", media: [{ path: "" }] },
            }),
            post({
              draftId: 4,
              en: {
                text: "Only a video",
                media: [
                  { type: "video", path: "media/posts/clip.mp4" },
                  { type: "image", path: "media/posts/missing.jpg" },
                ],
              },
            }),
            post({
              draftId: 5,
              ru: { text: "Нет колонки", media: { raw: "NULL" } },
              en: { text: "Story card only", media: [{ type: "image", path: "media/posts/present.jpg", role: "text_story_card" }] },
            }),
          ].join("\n"),
        },
        request(),
      ],
    },
    {
      name: "image dimensions and responsive variants",
      steps: [
        { sql: SITE_ON },
        write("media/posts/photo.jpg", jpeg, MTIME + 100),
        write("generated/responsive/media-posts-photo-360.webp", lossy, MTIME + 100),
        write("generated/responsive/media-posts-photo-640.webp", small, MTIME + 200),
        write("generated/responsive/media-posts-photo-720.webp", small, MTIME + 200),
        write("generated/responsive/media-posts-photo-800.webp", smaller, MTIME + 200),
        write("generated/responsive/media-posts-photo-960.webp", lossless, MTIME),
        write("media/posts/rotated.jpg", rotated),
        write("media/posts/plain.png", png),
        write("media/posts/anim.gif", gif),
        write("media/posts/pic.avif", avif),
        write("media/posts/lossless.webp", lossless),
        write("media/posts/alpha.webp", extended),
        write("media/posts/unversioned.jpg", jpeg, MTIME + 300),
        write("generated/responsive/media-posts-unversioned-480.webp", small, MTIME + 300),
        write("media/posts/full.png", png),
        ...[360, 480, 640, 720, 800, 960, 1280].map((width) => write(`generated/responsive/media-posts-full-${width}.webp`, small)),
        write("media/posts/film.mp4"),
        write("media/posts/film-poster.jpg", rotated),
        write("generated/responsive/media-posts-film-poster-1280.webp", extended),
        write("media/posts/broken.jpg", Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 4]).toString("base64")),
        {
          sql: post({
            draftId: 1,
            ru: {
              text: "Картинки",
              media: [
                { type: "image", path: "media/posts/photo.jpg?v=abc", width: 2560, height: 1440 },
                { type: "image", path: "media/posts/rotated.jpg?v=r" },
                { type: "image", path: "media/posts/plain.png" },
                { type: "image", path: "media/posts/anim.gif?v=g" },
                { type: "image", path: "media/posts/pic.avif?v=a" },
                { type: "image", path: "media/posts/lossless.webp?v=l" },
                { type: "image", path: "media/posts/alpha.webp?v=x" },
                { type: "image", path: "media/posts/unversioned.jpg" },
                { type: "image", path: "media/posts/full.png?v=abcdef012345" },
                { type: "video", path: "media/posts/film.mp4", poster: "media/posts/film-poster.jpg?v=p", width: 1, height: 2 },
                { type: "image", path: "media/posts/broken.jpg?v=b", width: 5, height: 6 },
              ],
            },
          }),
        },
        request(),
        // A replaced historical image is read again under a new version key.
        write("media/posts/unversioned.jpg", png, MTIME + 400),
        { clock: at(3001) },
        request(),
        // A late derivative is found without a database change.
        write("generated/responsive/media-posts-photo-1280.webp", extended, MTIME + 200),
        { clock: at(6002) },
        request(),
      ],
    },
    {
      name: "entities",
      steps: [
        { sql: SITE_ON },
        {
          sql: [
            post({ draftId: 1, en: { text: "Linked" } }),
            post({ draftId: 2, status: "draft", en: { text: "Private" } }),
            post({ draftId: 3, en: { text: "No links" } }),
            `INSERT INTO knowledge_entities (id, kind, slug, title_ru, title_en, created_at, updated_at) VALUES
               (101, 'company', 'acme', 'Акме', 'Acme', '${T0}', '${T0}'),
               (102, 'model', 'gpt', 'GPT', NULL, '${T0}', '${T0}'),
               (103, 'company', 'beta', 'Бета', 'Beta', '${T0}', '${T0}'),
               (104, 'legacy', 'old', 'Старое', 'Old', '${T0}', '${T0}'),
               (105, 'topic', 'ai', 'ИИ', 'AI', '${T0}', '${T0}');
             INSERT INTO draft_entity_links (draft_id, entity_id, link_role, created_at) VALUES
               (1, 101, 'focus', '${T0}'), (1, 102, 'mention', '${T0}'), (1, 103, 'other', '${T0}'),
               (1, 104, 'focus', '${T0}'), (1, 105, 'focus', '${T0}'), (1, 7, 'mention', '${T0}'),
               (2, 101, 'focus', '${T0}'), (3, 5, 'focus', '${T0}');`,
          ].join("\n"),
        },
        request(),
        { sql: "UPDATE knowledge_entities SET title_en = 'Acme Inc' WHERE id = 101;" },
        matching(),
        { sql: "UPDATE knowledge_entities SET title_en = 'Hidden' WHERE id = 6;" },
        matching(),
      ],
    },
    {
      name: "cache invalidation",
      steps: [
        {
          sql: `${SITE_ON}\n${post({ draftId: 1, en: { text: "First", media: [{ type: "image", path: "media/posts/late.jpg?v=abcdef012345" }] } })}`,
        },
        request(),
        // A file that appears is seen only after the refresh interval.
        write("media/posts/late.jpg", jpeg),
        matching(),
        { clock: at(3001) },
        matching(),
        // Private drafts and unrelated metrics leave the answer alone.
        {
          sql: `${post({ draftId: 2, status: "draft", en: { text: "Private" } })}\nUPDATE drafts SET updated_at = '${at(HOUR)}' WHERE id = 2;`,
        },
        { sql: "INSERT INTO post_metrics (publication_key, target, metric_name, value) VALUES ('post:1', 'threads_en', 'views', 3);" },
        matching(),
        { sql: "INSERT INTO post_metrics (publication_key, target, metric_name, value) VALUES ('post:1', 'telegram', 'views', 42);" },
        matching(),
        { sql: "UPDATE post_metrics SET value = 43 WHERE publication_key = 'post:1' AND target = 'telegram';" },
        matching(),
        // A write by another connection does not run this connection's triggers.
        { external_sql: post({ draftId: 3, updatedAt: at(HOUR), en: { text: "Written elsewhere" } }) },
        matching(),
        { sql: "UPDATE post_locales SET site_enabled = 0 WHERE draft_id = 3;" },
        matching(),
        { sql: "DELETE FROM drafts WHERE id = 1;" },
        matching(),
      ],
    },
    {
      name: "changes returned during a wait",
      steps: [
        {
          sql: `${SITE_ON}\n${post({ draftId: 1, en: { text: "First", media: [{ type: "image", path: "media/posts/wait.jpg?v=abcdef012345" }] } })}\n${post({ draftId: 2, en: { text: "Scheduled", publishedAt: at(1000) } })}`,
        },
        request(),
        request({ if_none_match: "$previous", prefer: "wait=4" }, [{ sql: post({ draftId: 3, en: { text: "New post" } }) }]),
        request({ if_none_match: "$previous", prefer: "wait=2" }, [{ clock: at(1000) }]),
        request({ if_none_match: "$previous", prefer: "wait=2" }, [write("media/posts/wait.jpg", png)]),
        request({ if_none_match: "$previous", prefer: "wait=4" }, [{ clock: at(5000) }]),
        request({ if_none_match: "$previous", prefer: "wait=1" }),
      ],
    },
    {
      name: "malformed rows are dropped and journalled",
      steps: [
        { sql: SITE_ON },
        {
          sql: [
            post({ draftId: 1, en: { text: "Valid" } }),
            post({ draftId: 2, en: { text: "Text views" } }),
            post({ draftId: 3, postId: -4, en: { text: "Negative post id" } }),
            post({ draftId: 4, postId: { raw: "2.5" }, en: { text: "Fractional post id", slug: { raw: "X'0102'" } } }),
            post({ draftId: 5, en: { text: "Infinite views" } }),
            `INSERT INTO post_metrics (publication_key, target, metric_name, value) VALUES
               ('post:2', 'telegram', 'views', 'many'), ('post:5', 'telegram', 'views', 1e999);`,
          ].join("\n"),
        },
        request(),
        { clock: at(1000) },
        { sql: post({ draftId: 6, en: { text: "Another" } }) },
        request(),
      ],
    },
  ];
}

// ---------------------------------------------------------------- runner

/** One statement at a time: `exec` of several skips a failing one silently. */
function execAll(sqlite: Database, sql: string): void {
  for (const statement of sql.split(/;\s*(?:\n|$)/)) if (statement.trim()) sqlite.run(statement);
}

function headers(response: Response): Record<string, string | null> {
  return Object.fromEntries(["content-type", "etag", "cache-control"].map((name) => [name, response.headers.get(name)]));
}

async function run(spec: Case, base: string) {
  const dataDir = path.join(base, spec.name.replace(/[^a-z0-9]+/gi, "-"));
  fs.mkdirSync(dataDir, { recursive: true });
  nowMs = RealDate.parse(T0);
  const dbPath = path.join(dataDir, "pipeline.db");
  const backendDb = openBackendDb(dbPath, 5000);
  const config = withStudioProfile(loadConfig({ DATA_DIR: dataDir, PUBLIC_BASE_URL: "https://studio.example.com" }), backendDb);
  const handler = createApiHandler({ config, backendDb });
  const external = new Database(dbPath);
  external.exec("PRAGMA busy_timeout = 5000");
  const results: Recorded[] = [];
  let previous = "";
  async function step(item: Step): Promise<void> {
    if ("clock" in item) nowMs = RealDate.parse(item.clock);
    else if ("sql" in item) execAll(unsafeDb(backendDb).sqlite, item.sql);
    else if ("external_sql" in item) execAll(external, item.external_sql);
    else if ("write" in item) {
      const file = path.join(config.SITE_PUBLIC_DIR, item.write);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, Buffer.from(item.base64, "base64"));
      fs.utimesSync(file, item.mtime, item.mtime);
    } else {
      const init: Record<string, string> = {};
      if (item.request.if_none_match !== undefined)
        init["if-none-match"] = item.request.if_none_match === "$previous" ? previous : item.request.if_none_match;
      if (item.request.prefer !== undefined) init.prefer = item.request.prefer;
      const pending = handler(new Request("http://localhost/api/public/site", { headers: init }));
      if (item.during) {
        await Bun.sleep(20);
        for (const inner of item.during) await step(inner);
      }
      const response = await pending;
      const body = response.status === 304 ? null : await response.text();
      results.push({ status: response.status, headers: headers(response), body });
      previous = response.headers.get("etag") ?? previous;
    }
  }
  for (const item of spec.steps) await step(item);
  const events = unsafeDb(backendDb)
    .sqlite.query(
      "SELECT publication_key, event_type, severity, target, message, details_json, created_at FROM publication_events ORDER BY id",
    )
    .all();
  external.close();
  unsafeDb(backendDb).sqlite.close();
  return { name: spec.name, steps: spec.steps, results, events };
}

async function prod(dbPath: string, now: string) {
  nowMs = RealDate.parse(now);
  const dataDir = fs.mkdtempSync(path.join(path.dirname(dbPath), "ts-data-"));
  const backendDb = openBackendDb(dbPath, 5000);
  const config = withStudioProfile(loadConfig({ DATA_DIR: dataDir, PUBLIC_BASE_URL: "https://studio.example.com" }), backendDb);
  const response = await createApiHandler({ config, backendDb })(new Request("http://localhost/api/public/site"));
  const body = await response.text();
  const items = response.status === 200 ? (JSON.parse(body) as { items: unknown[] }).items.length : null;
  const sha256 = crypto.createHash("sha256").update(body).digest("hex");
  console.log(JSON.stringify({ status: response.status, sha256, etag: response.headers.get("etag"), items }));
}

if (process.argv[2] === "--prod") {
  const [dbPath, now] = process.argv.slice(3);
  if (!dbPath || !now) throw new Error("usage: public-site-goldens.ts --prod <db> <now>");
  await prod(dbPath, now);
} else {
  const base = path.resolve("_trash-rust/tmp/public-site-goldens-ts");
  fs.rmSync(base, { recursive: true, force: true });
  const out = [];
  for (const spec of await cases()) out.push(await run(spec, base));
  const target = path.resolve("parity/public-site/goldens.json");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify({ cases: out }, null, 2)}\n`);
  console.error(`${out.length} cases, ${out.reduce((sum, item) => sum + item.results.length, 0)} responses -> ${target}`);
}
