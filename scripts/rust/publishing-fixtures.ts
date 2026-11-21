import { writeFileSync } from "node:fs";
import path from "node:path";
import { plannedTargetDeliveries } from "../../apps/backend/src/publishing/chain-plan.js";
import { classifyPublishError, HttpPublishError, nextRetryAt, normalizePublishResult } from "../../apps/backend/src/publishing/errors.js";
import {
  failedJobTransition,
  mayHaveReachedAudience,
  partialPublicationTransition,
  videoStepMayHaveReachedAudience,
} from "../../apps/backend/src/publishing/job-policy.js";
import { mediaPolicyForTarget } from "../../apps/backend/src/publishing/media-policy.js";
import { localizeTargetPayload } from "../../apps/backend/src/publishing/payload.js";
import { formatPlatformText } from "../../apps/backend/src/publishing/platform-profiles.js";
import { publicationPreflight } from "../../apps/backend/src/publishing/preflight.js";
import { effectivePublicationTargets } from "../../apps/backend/src/publishing/publication-plan.js";
import {
  assertFutureSchedule,
  immediateScheduleTime,
  isImmediateSchedule,
  parseManualSchedule,
  publicationSlotTime,
} from "../../apps/backend/src/publishing/schedule.js";
import {
  effectivePublicationStatus,
  hasUnscheduledLocale,
  isPartialDelivery,
  isPostTargetRetryable,
  publicationStatus,
  videoDraftStatus,
} from "../../apps/backend/src/publishing/state.js";
import { threadsBody } from "../../apps/backend/src/publishing/threads-text.js";
import { youtubeTagsLength } from "../../apps/backend/src/publishing/video-metadata-limits.js";

/**
 * Reference outputs of the pure publishing rules, recorded for the Rust
 * `domain::publishing` parity test under crates/domain/tests/fixtures/:
 * schedule and zone math (DST edges included), error classes and retry
 * curves, result normalization, preflight, the per-target job payload, chain
 * cuts and the status folds. The wall clock and `Math.random` are pinned so
 * the jittered curve is reproducible.
 *
 *   bun scripts/rust/publishing-fixtures.ts
 */
const out = path.join(import.meta.dir, "../../crates/domain/tests/fixtures/publishing.json");
const JITTER = 0.25;
const NOW_MS = Date.parse("2026-03-01T10:00:00.000Z");
const RealDate = Date;
class FixedDate extends RealDate {
  constructor(...args: unknown[]) {
    if (args.length === 0) super(NOW_MS);
    else super(...(args as [string]));
  }
  static override now(): number {
    return NOW_MS;
  }
}
globalThis.Date = FixedDate as DateConstructor;
Math.random = () => JITTER;

function outcome(run: () => unknown): unknown {
  try {
    const value = run();
    return { ok: value instanceof Date ? value.toISOString() : (value ?? null) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

const ZONES = [
  "Europe/Moscow",
  "Europe/Berlin",
  "America/New_York",
  "Australia/Lord_Howe",
  "Asia/Kolkata",
  "Pacific/Chatham",
  "America/Sao_Paulo",
  "UTC",
  "+05:30",
];
const NOWS = [
  "2026-07-10T15:00:00.000Z",
  "2026-03-07T12:00:00.000Z",
  "2026-03-08T06:59:00.000Z",
  "2026-03-29T00:30:00.000Z",
  "2026-10-25T00:30:00.000Z",
  "2026-10-31T12:00:00.000Z",
  "2026-04-04T15:30:00.000Z",
  "2026-12-31T22:30:00.000Z",
  "2028-02-28T21:00:00.000Z",
];
const CLOCKS = ["00:00", "01:30", "02:00", "02:30", "03:00", "09:05", "21:00", "23:59"];
const MANUAL = [
  "21:15",
  "09:00",
  " 7:05 ",
  "02:30",
  "25:00",
  "12:60",
  "12.07 10:30",
  "09.07 10:30",
  "10.08 10:30",
  "31.02 10:00",
  "29.02 10:00",
  "08.03 01:30",
  "08.03 02:30",
  "08.03 03:30",
  "29.03  02:30",
  "29.03 03:30",
  "25.10 02:30",
  "01.11 01:30",
  "05.04 02:30",
  "01.01.2020 10:00",
  "01.01.2027 00:15",
  "1.4 7:05",
  "31.12.2026 23:59",
  "10:00 tomorrow",
  "",
];

const schedule = ZONES.flatMap((zone) =>
  NOWS.flatMap((now) => [
    ...CLOCKS.map((clock) => ({
      fn: "publicationSlotTime",
      zone,
      now,
      input: clock,
      result: outcome(() => publicationSlotTime(clock, zone, new Date(now))),
    })),
    ...MANUAL.map((input) => ({
      fn: "parseManualSchedule",
      zone,
      now,
      input,
      result: outcome(() => parseManualSchedule(input, zone, new Date(now))),
    })),
  ]),
);

const NOW = new Date("2026-03-01T10:00:00.000Z");
const bounds = [-1, 0, 1, 59_999, 60_000, 60_001, 30 * 24 * 3_600_000, 30 * 24 * 3_600_000 + 1].map((offset) => ({
  offset,
  immediate: immediateScheduleTime(NOW).toISOString(),
  isImmediate: isImmediateSchedule(new Date(NOW.getTime() + offset), NOW),
  future: outcome(() => assertFutureSchedule(new Date(NOW.getTime() + offset), NOW)),
}));

const FAILURES: Array<{ message: string; status?: number; retryAfterSeconds?: number }> = [
  { message: "nope", status: 401 },
  { message: "nope", status: 403 },
  { message: "bad request", status: 400 },
  { message: "gone", status: 410 },
  { message: "too big", status: 413 },
  { message: "slow down", status: 429, retryAfterSeconds: 45 },
  { message: "slow down", status: 429, retryAfterSeconds: 100_000 },
  { message: "teapot", status: 418 },
  { message: "server", status: 500 },
  { message: "Unauthorized" },
  { message: "auth_circuit_open: test_platform has a failing credential" },
  { message: "delivery_execution_timeout after 120s" },
  { message: "Request timed out" },
  { message: "temporarily unavailable" },
  { message: "id 14290 failed" },
  { message: "HTTP 429 too many" },
  { message: "error 4291" },
  { message: "invalid token supplied" },
  { message: "TEXT_TOO_LONG" },
  { message: "not_translated: no English yet" },
  { message: "permission denied" },
  { message: "HTTP 400 refused" },
  { message: "unexpected parser failure" },
  { message: "" },
];
const POLICY = { maxAttempts: 4, backoffBaseSeconds: 60, backoffMaxSeconds: 3600 };
const failure = ({ message, status, retryAfterSeconds }: (typeof FAILURES)[number]) =>
  status == null ? new Error(message) : new HttpPublishError(message, status, undefined, retryAfterSeconds ?? null);
const errors = FAILURES.map((input) => ({
  input,
  class: classifyPublishError(failure(input)),
  transitions: [0, 1, 2, 3].map((attempt) => failedJobTransition(failure(input), attempt, POLICY)),
}));
const messages = [null, "", "HTTP 503", "payload too large", "Forbidden"].map((message) => ({
  message,
  class: classifyPublishError(message),
}));
const retries = [0, 1, 2, 3, 4, 7, 12].flatMap((attempt) =>
  [null, 0, 30, 5000].map((retryAfter) => ({
    attempt,
    retryAfter,
    at: nextRetryAt(attempt, 60, 3600, NOW, retryAfter),
  })),
);
const partials = [0, 1, 10, 11, 12].map((attempt) => {
  const transition = partialPublicationTransition(attempt, { ...POLICY, maxAttempts: 12 });
  return { attempt, status: transition.status, attemptOut: transition.attempt, nextAttemptAt: transition.nextAttemptAt };
});

const RESULTS: Array<Record<string, unknown>> = [
  { ok: true, id: "m-1" },
  { ok: true, id: 12 },
  { ok: true, ids: ["a", 2, null] },
  { ok: true, url: "https://t.me/c/1" },
  { ok: true, id: "", url: "" },
  { ok: true, id: "https://x.com/i/1" },
  { ok: false, error: "HTTP 503" },
  { ok: false, reason: "refused", retryable: false },
  { ok: false, error: null, reason: "timeout" },
  { ok: false, error: { status: 502 } },
  { ok: false, error: 42 },
  { skipped: true, reason: "nothing to send" },
  { ok: 1, skipped: true },
  {},
  { ok: false, ids: "not a list", id: null, retryable: null },
];
const normalized = RESULTS.map((input) => ({ input, output: normalizePublishResult(input) }));

const phases = [null, "validate", "prepare", "provider.publish", "provider.verify", "something-new"].map((phase) => ({
  phase,
  reached: mayHaveReachedAudience(phase),
}));
const videoSteps = [
  ["prepare", "youtube_shorts"],
  ["prepare", "instagram_reels"],
  ["publish", "instagram_reels"],
  ["reminder", null],
  [null, null],
].map(([kind, target]) => ({ kind, target, reached: videoStepMayHaveReachedAudience(kind, target) }));

const STATUSES = [
  [],
  ["published"],
  ["published", "failed"],
  ["published", "queued"],
  ["cancelled", "cancelled"],
  ["skipped", "cancelled"],
  ["verification_required"],
  ["rendering"],
];
const folds = STATUSES.map((statuses) => ({
  statuses,
  publication: publicationStatus(statuses),
  video: videoDraftStatus(statuses),
}));
const retryable = [
  ["threads_en", "failed", null],
  ["threads_en", "verification_required", null],
  ["site_en", "verification_required", null],
  ["telegram", "failed", "payload too large"],
  ["site_ru", "failed", null],
  ["x", "cancelled", null],
].map(([target, status, error]) => ({
  target,
  status,
  error,
  retryable: isPostTargetRetryable(target as string, status as string, error),
  partial: isPartialDelivery(status as string, status === "failed" ? "id" : null),
}));
const PLAN = {
  mode: "scheduled",
  targets: { telegram: true, x: true, site_en: false, bogus: true },
  scheduled_at: "2026-03-01T10:00:00.000Z",
  scheduled_en_at: null,
};
const effective = [
  { jobs: [{ target: "telegram", status: "published" }], plan: PLAN, registered: ["telegram", "x"] },
  { jobs: [{ target: "telegram", status: "published" }], plan: PLAN, registered: ["telegram"] },
  {
    jobs: [
      { target: "telegram", status: "published" },
      { target: "x", status: "published" },
    ],
    plan: PLAN,
    registered: ["telegram", "x"],
  },
  { jobs: [{ target: "telegram", status: "failed" }], plan: PLAN, registered: ["telegram", "x"] },
  { jobs: [{ target: "telegram", status: "published" }], plan: { ...PLAN, mode: "immediate" }, registered: ["telegram", "x"] },
  { jobs: [], plan: PLAN, registered: ["telegram", "x"] },
].map((input) => ({ ...input, status: effectivePublicationStatus(input.jobs, input.plan, new Set(input.registered)) }));
const unscheduled = [
  [{ telegram: true }, null, null],
  [{ telegram: true }, "2026-01-01T00:00:00.000Z", null],
  [{ x: true, telegram: false }, "2026-01-01T00:00:00.000Z", ""],
  [{ x: true }, null, "2026-01-01T00:00:00.000Z"],
  [{ unknown: true }, null, null],
].map(([targets, ruAt, enAt]) => ({
  targets,
  ruAt,
  enAt,
  pending: hasUnscheduledLocale(targets as Record<string, boolean>, ruAt as string | null, enAt as string | null),
}));
const effectiveTargets = [
  [{ telegram: true, telegram_stories: true, instagram_stories: true }, null, { ru: [], en: [] }, false, null],
  [{ telegram: true, telegram_stories: true, instagram_stories: true }, null, { ru: [{}], en: [] }, false, null],
  [{ telegram: true, telegram_stories: true, instagram_stories: true }, ["telegram", "telegram_stories"], { ru: [], en: [] }, true, "all"],
  [{ telegram_stories: true, instagram_stories_ru: false }, null, { ru: [], en: [] }, true, "site_only"],
].map(([requested, available, media, cards, mode]) => ({
  requested,
  available,
  media,
  cards,
  mode,
  effective: effectivePublicationTargets(
    requested as Record<string, boolean>,
    available ? new Set(available as string[]) : undefined,
    media as Record<"ru" | "en", unknown[]>,
    cards as boolean,
    mode as string | null,
  ),
}));

const LONG_RU = `${"Первое предложение про большой патч. ".repeat(14)}Конец.`;
const LONG_EN = `${"The first sentence about the big patch. ".repeat(14)}The end.`;
const LINK = [{ type: "text_link", offset: 0, length: 5, url: "https://example.com/very/long/path" }];
const photo = (size: number) => ({ type: "photo", file_id: `F${size}`, file_size: size, local_path: `/m/${size}.jpg` });
const DRAFTS: Array<Record<string, unknown>> = [
  {
    text_ru: "Привет, это пост",
    text_en_machine: "Hello, this is a post",
    targets_json: '{"telegram":true,"x":true,"threads_en":true}',
    media_ru_json: null,
  },
  { text_ru: "", text_en_machine: null, targets_json: '{"telegram":true,"threads_en":true}', media_ru_json: JSON.stringify([photo(10)]) },
  {
    text_ru: LONG_RU,
    text_en_machine: LONG_EN,
    targets_json: '{"threads_ru":true,"threads_en":true,"x":true,"discord":true}',
    media_ru_json: null,
  },
  {
    text_ru: "Короткий текст с фото",
    text_en_machine: "A short text with a photo",
    targets_json: '{"telegram":true,"discord":true}',
    media_ru_json: JSON.stringify([photo(20_000_000)]),
  },
  {
    text_ru: "x".repeat(1100),
    text_en_machine: null,
    targets_json: '{"telegram":true}',
    media_ru_json: JSON.stringify([photo(1)]),
  },
  {
    text_ru: "Ссылка внутри текста",
    text_en_machine: "Link inside the text",
    text_en_entities_json: JSON.stringify(LINK),
    targets_json: '{"threads_en":true,"x":true}',
    media_ru_json: null,
  },
  {
    text_ru: "Тред, первая часть",
    text_en_machine: "Thread, the first part",
    targets_json: '{"telegram":true,"threads_ru":true,"threads_en":true,"x":true,"site_ru":true}',
    media_ru_json: JSON.stringify([photo(5)]),
    thread: [
      { position: 2, textRu: "Вторая часть", entitiesRu: [], textEn: "The second part", textEnApproved: null, media: [photo(6), photo(7)] },
      { position: 3, textRu: "Третья часть", entitiesRu: [], textEn: null, textEnApproved: null, media: [] },
    ],
  },
  {
    text_ru: "Длинная подпись к фото. ".repeat(48),
    text_en_machine: "A long caption under the photo. ".repeat(70),
    targets_json: '{"telegram":true,"discord":true}',
    media_ru_json: JSON.stringify([photo(3)]),
  },
  { text_ru: "Очень длинный пост без фото. ".repeat(150), text_en_machine: null, targets_json: '{"telegram":true}', media_ru_json: null },
  {
    text_ru: "Это английский? No.",
    text_en_machine: "Это русский текст в английском поле",
    targets_json: '{"x":true,"bogus":true}',
    media_ru_json: null,
  },
];
const preflight = DRAFTS.map((draft) => ({
  draft,
  issues: publicationPreflight(
    { media_en_json: null, text_ru_entities_json: null, text_en_entities_json: null, ...draft } as Parameters<
      typeof publicationPreflight
    >[0],
    { discord: 15_000_000 },
  ),
  deliveries: plannedTargetDeliveries({ thread: [], ...draft } as unknown as Parameters<typeof plannedTargetDeliveries>[0]),
}));

const locale = (text: string, extra: Record<string, unknown> = {}) => ({
  text,
  entities: [{ type: "bold", offset: 0, length: 3 }],
  media: [
    { type: "photo", file_id: "F1", local_path: "/m/1.jpg", public_url: "https://cdn/1.jpg", file_size: 1 },
    { media_type: "VIDEO", fileId: null, file_id: "V1", path: "/m/v.mp4" },
    { type: "photo", localPath: null },
    { type: "document", file_id: "D1" },
  ],
  storyMedia: [],
  siteMedia: [],
  slug: `slug-${text.length}`,
  publishAt: null,
  siteEnabled: true,
  thread: [
    { text: "Part two", entities: [], media: [{ type: "photo", vps_url: "https://cdn/2.jpg", token: "t" }] },
    { text: "  ", entities: [], media: [] },
  ],
  ...extra,
});
const SOURCE = {
  draftId: 5,
  postId: 50,
  targets: {},
  locales: {
    ru: locale("Русский текст", { storyMedia: [{ type: "IMAGE", local_path: "/s/ru.png", story_local_path: "/s/ru.png" }] }),
    en: locale("English text"),
  },
};
const payloads = [
  "telegram",
  "site_ru",
  "threads_ru",
  "threads_en",
  "x",
  "discord",
  "telegram_stories",
  "instagram_stories",
  "instagram_stories_ru",
  "unknown",
].map((target) => ({ target, payload: localizeTargetPayload(SOURCE, target) }));

const texts = [
  ["x", "Read https://example.com/a  now\nand   then https://x.y/z\n\n  next paragraph  "],
  ["threads_en", "Read https://example.com/a now"],
].map(([target, text]) => ({ target, text, formatted: formatPlatformText(target as string, text as string) }));
const threads = [
  ["threads_ru", "Короткий текст", LINK],
  ["threads_en", "x".repeat(480), LINK],
  ["threads_en", "  spaced  ", []],
].map(([target, text, entities]) => ({
  target,
  text,
  entities,
  body: threadsBody(target as string, text as string, entities as Record<string, unknown>[]),
}));
const media = [
  ["telegram", Array.from({ length: 12 }, () => ({ type: "photo" }))],
  ["telegram_stories", [{ type: "photo" }, { type: "video" }]],
  ["discord", [{ type: "photo" }]],
  ["site_ru", [{ type: "photo" }, { type: "photo" }]],
  ["unknown", [{}, {}]],
].map(([target, items]) => ({ target, items, policy: mediaPolicyForTarget(target as string, items as unknown[]) }));
const tags = [[], ["a"], ["a b", "c"], ["игра", "new game", "x"]].map((list) => ({ tags: list, length: youtubeTagsLength(list) }));

const fixture: Record<string, unknown> = {
  jitter: JITTER,
  now: NOW.toISOString(),
  schedule,
  bounds,
  errors,
  messages,
  retries,
  partials,
  normalized,
  phases,
  videoSteps,
  folds,
  retryable,
  effective,
  unscheduled,
  effectiveTargets,
  preflight,
  source: SOURCE,
  payloads,
  texts,
  threads,
  media,
  tags,
};
/** One array element per line: diffable, without the size of full pretty-printing. */
const sections = Object.entries(fixture).map(([key, value]) =>
  Array.isArray(value)
    ? `  ${JSON.stringify(key)}: [\n${value.map((item) => `    ${JSON.stringify(item)}`).join(",\n")}\n  ]`
    : `  ${JSON.stringify(key)}: ${JSON.stringify(value)}`,
);
writeFileSync(out, `{\n${sections.join(",\n")}\n}\n`);
console.log(`wrote ${out}`);
