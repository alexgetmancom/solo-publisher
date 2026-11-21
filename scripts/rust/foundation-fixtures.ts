import { writeFileSync } from "node:fs";
import path from "node:path";
import { loadConfig } from "../../apps/backend/src/foundation/config.js";
import { escapeMarkdown } from "../../apps/backend/src/foundation/markdown.js";
import { redactExternalSecrets } from "../../apps/backend/src/foundation/redact.js";
import { encryptionKey, fingerprint, open, seal } from "../../apps/backend/src/foundation/secret-box.js";
import { truncateUnicode } from "../../apps/backend/src/foundation/text.js";
import {
  formatZonedClock,
  formatZonedDateTime,
  formatZonedDayMonth,
  formatZonedSortable,
  isValidTimeZone,
  manualScheduleExample,
  parseIsoInstant,
  timezoneOffsetMs,
  zonedCalendarDay,
  zonedDateParts,
  zonedDayDistance,
  zonedRollingPeriodBounds,
  zonedSlot,
  zonedWeekBounds,
} from "../../apps/backend/src/foundation/time.js";

/**
 * Reference outputs of the TypeScript foundation modules, recorded for the Rust
 * `foundation` crate's parity tests under crates/foundation/tests/fixtures/.
 * Deterministic on the same Bun/ICU, except the sealed secrets: seal() draws a
 * fresh IV every time, as it does in production.
 *
 *   bun scripts/rust/foundation-fixtures.ts
 */
const fixtures = path.join(import.meta.dir, "../../crates/foundation/tests/fixtures");

const json = (value: unknown) => JSON.stringify(value, (_key, item) => (item === undefined ? null : item));

/** One array element per line: diffable, without the size of full pretty-printing. */
function write(name: string, value: Record<string, unknown> | unknown[]): void {
  const rows = (items: unknown[], indent: string) => `[\n${items.map((item) => `${indent}  ${json(item)}`).join(",\n")}\n${indent}]`;
  const body = Array.isArray(value)
    ? rows(value, "")
    : `{\n${Object.entries(value)
        .map(([key, item]) => `  ${json(key)}: ${Array.isArray(item) ? rows(item, "  ") : json(item)}`)
        .join(",\n")}\n}`;
  writeFileSync(path.join(fixtures, name), `${body}\n`);
  console.log(`wrote ${name}`);
}

function attempt<T>(run: () => T): { ok: T } | { error: string } {
  try {
    return { ok: run() };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

// Deterministic pseudo-random sequence, so the fixture does not churn.
let seed = 20261121;
function random(): number {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
}

// ---- time ----------------------------------------------------------------

const ZONES = [
  "Europe/Moscow",
  "Asia/Jerusalem",
  "America/New_York",
  "UTC",
  "Europe/London",
  "Asia/Kolkata",
  "Asia/Kathmandu",
  "Australia/Lord_Howe",
  "Pacific/Chatham",
  "Pacific/Apia",
  "America/Sao_Paulo",
  "+03:00",
  "-0530",
  "europe/moscow",
];
const TRANSITION_YEARS = [2010, 2011, 2014, 2019, 2025, 2026, 2027];

function transitions(zone: string): number[] {
  const found: number[] = [];
  for (const year of TRANSITION_YEARS) {
    let previous = Date.UTC(year, 0, 1);
    for (let day = 1; day <= 366; day += 1) {
      const next = Date.UTC(year, 0, 1 + day);
      if (timezoneOffsetMs(new Date(previous), zone) !== timezoneOffsetMs(new Date(next), zone)) {
        let low = previous;
        let high = next;
        while (high - low > 1) {
          const middle = Math.floor((low + high) / 2);
          if (timezoneOffsetMs(new Date(middle), zone) === timezoneOffsetMs(new Date(low), zone)) low = middle;
          else high = middle;
        }
        found.push(high);
      }
      previous = next;
    }
  }
  return found;
}

const instants: unknown[] = [];
const slots: unknown[] = [];
const dayDistance: unknown[] = [];
const weekBounds: unknown[] = [];
const rollingBounds: unknown[] = [];
const CLOCKS = ["00:00", "01:30", "02:00", "02:30", "03:00", "03:30", "12:00", "23:59"];

for (const zone of ZONES) {
  const moments: number[] = [];
  for (const edge of transitions(zone)) {
    for (const delta of [-1_800_000, -1, 0, 1, 1_800_000]) moments.push(edge + delta);
  }
  for (let index = 0; index < 24; index += 1) {
    moments.push(Math.floor(random() * Date.UTC(2037, 11, 31)));
  }
  moments.push(Date.UTC(2026, 10, 21, 12, 0, 0, 500), Date.UTC(2026, 11, 31, 23, 59, 59, 999), Date.UTC(2027, 0, 1));
  for (const ms of moments) {
    const at = new Date(ms);
    const parts = zonedDateParts(at, zone);
    instants.push({
      zone,
      at: at.toISOString(),
      offset_ms: timezoneOffsetMs(at, zone),
      calendar_day: zonedCalendarDay(at, zone),
      parts: [parts.year, parts.month, parts.day],
      clock: formatZonedClock(at, "ru", zone),
      day_month: formatZonedDayMonth(at, "ru", zone),
      date_time: formatZonedDateTime(at, zone, "LBL"),
      sortable: formatZonedSortable(at.toISOString(), zone),
      manual_example: manualScheduleExample(zone, at),
      // timeZoneOffsetLabel reads the offset at `new Date()`; this is its exact Intl call at `at`.
      offset_label:
        new Intl.DateTimeFormat("ru-RU", { timeZone: zone, timeZoneName: "shortOffset" })
          .formatToParts(at)
          .find((part) => part.type === "timeZoneName")?.value ?? zone,
    });
  }
  for (let index = 0; index + 1 < moments.length; index += 3) {
    const [date, now] = [new Date(moments[index] as number), new Date(moments[index + 1] as number)];
    dayDistance.push({ zone, date: date.toISOString(), now: now.toISOString(), days: zonedDayDistance(date, now, zone) });
  }
  for (let index = 0; index < moments.length; index += 9) {
    const now = new Date(moments[index] as number);
    for (const offset of [-1, 0, 1, 2]) {
      const [start, end] = zonedWeekBounds(offset, zone, now);
      weekBounds.push({ zone, offset, now: now.toISOString(), start, end });
    }
    for (const offset of [0, 1, 0.5, 7 / 3]) {
      for (const days of [1, 7, 30]) {
        const [start, end] = zonedRollingPeriodBounds(offset, days, zone, now);
        rollingBounds.push({ zone, offset, days, now: now.toISOString(), start, end });
      }
    }
  }
  const slotDays = transitions(zone).flatMap((edge) => [0, 86_400_000].map((delta) => zonedDateParts(new Date(edge + delta), zone)));
  slotDays.push({ year: 2026, month: 11, day: 21 }, { year: 2011, month: 12, day: 30 }, { year: 2024, month: 2, day: 29 });
  for (const day of slotDays) {
    for (const clock of CLOCKS) {
      const result = attempt(() => zonedSlot(day.year, day.month, day.day, clock, zone).toISOString());
      slots.push({ zone, year: day.year, month: day.month, day: day.day, clock, result });
    }
  }
}
// Date.UTC's own overflow rules, reached through odd clocks and dates.
for (const [year, month, day, clock] of [
  [2026, 1, 1, "24:00"],
  [2026, 1, 1, "9:5"],
  [2026, 1, 1, "12:60"],
  [2026, 1, 1, "1.5:30"],
  [2026, 1, 1, "x:00"],
  [2026, 1, 1, "18"],
  [2026, 1, 1, " 7: 05"],
  [2026, 13, 1, "10:00"],
  [2026, 0, 1, "10:00"],
  [2026, 2, 30, "10:00"],
  [2026, 1, 0, "10:00"],
  [2026, -1, 35, "10:00"],
  [2026, 3, 29, "02:30"],
] as const) {
  for (const zone of ["Europe/Moscow", "America/New_York"]) {
    slots.push({ zone, year, month, day, clock, result: attempt(() => zonedSlot(year, month, day, clock, zone).toISOString()) });
  }
}

const parseInputs = [
  "2026-08-27T14:01:34Z",
  "2026-08-27T14:01:34.5Z",
  "2026-08-27T14:01:34.123456+03:00",
  "2026-01-01T00:00:00.9999Z",
  "2026-02-29T00:00:00Z",
  "2026-02-30T00:00:00Z",
  "2026-02-31T10:00:00Z",
  "2026-04-31T00:00:00Z",
  "2026-13-01T00:00:00Z",
  "2026-00-01T00:00:00Z",
  "2026-01-00T00:00:00Z",
  "2026-01-32T00:00:00Z",
  "2026-01-01T24:00:00Z",
  "2026-01-01T24:00:00.000Z",
  "2026-01-01T24:00:00.5Z",
  "2026-01-01T24:00:01Z",
  "2026-01-01T23:60:00Z",
  "2026-01-01T23:59:60Z",
  "2026-01-01T00:00:00+24:00",
  "2026-01-01T00:00:00+23:59",
  "2026-01-01T00:00:00-23:59",
  "2026-01-01T00:00:00+05:60",
  "0000-01-01T00:00:00Z",
  "0001-01-01T00:00:00+01:00",
  "9999-12-30T21:59:59.999+00:00",
  "2026-08-27 14:01:34Z",
  "2026-08-27T14:01Z",
  "2026-08-27T14:01:34",
  "2026-08-27T14:01:34+0300",
  "Thu, Aug 20, 2026",
  "2026-08-27T14:01:34.Z",
  " 2026-08-27T14:01:34Z",
];
const parse = parseInputs.map((input) => ({ input, result: attempt(() => parseIsoInstant(input).toISOString()) }));

const zoneNames = [
  ...ZONES,
  "EUROPE/MOSCOW",
  "utc",
  "Etc/UTC",
  "etc/utc",
  "GMT",
  "UCT",
  "Universal",
  "Zulu",
  "GMT0",
  "Greenwich",
  "Etc/GMT+3",
  "Etc/GMT-14",
  "Asia/Calcutta",
  "US/Eastern",
  "EST",
  "EST5EDT",
  "CST6CDT",
  "Europe/Kiev",
  "Europe/Kyiv",
  "America/Ciudad_Juarez",
  "Antarctica/Troll",
  "+03",
  "+3",
  "+0300",
  "-05",
  "+14:00",
  "+23:59",
  "+24:00",
  "+03:00:00",
  "−03:00",
  "+00:00",
  "-00:00",
  "",
  "Invalid/Zone",
  "Moscow",
  "Z",
  "UTC+3",
  "GMT+3",
  "Asia/Kyiv",
  "SystemV/AST4",
  "localtime",
  "Factory",
  "factory",
  "US/Pacific-New",
  "posixrules",
  "Europe/Moscow ",
];
const validZones = zoneNames.map((name) => ({ name, valid: isValidTimeZone(name) }));

write("time.json", {
  valid_zones: validZones,
  parse,
  instants,
  day_distance: dayDistance,
  slots,
  week_bounds: weekBounds,
  rolling_bounds: rollingBounds,
});

// ---- plural ---------------------------------------------------------------

const pluralNumbers = [
  ...Array.from({ length: 201 }, (_, n) => n),
  1000,
  1001,
  1011,
  1021,
  1111,
  1112,
  1122,
  1_000_000,
  1_000_001,
  2 ** 53 - 1,
];
const pluralRules = new Intl.PluralRules("ru-RU");
write(
  "plural.json",
  pluralNumbers.map((n) => ({ n, category: pluralRules.select(n) })),
);

// ---- config ---------------------------------------------------------------

const production = {
  NODE_ENV: "production",
  DEPLOYMENT_ENV: "production",
  COMMAND_CENTER_TOKEN: "command-center-token",
  CLIENT_IP_HASH_SALT: "0123456789abcdef",
  PUBLIC_BASE_URL: "https://studio.example.org/",
};
const blank = Object.fromEntries(
  [
    "NODE_ENV",
    "LOG_LEVEL",
    "PORT",
    "DATA_DIR",
    "CLIENT_IP_HASH_SALT",
    "MCP_STUDIO_TOKEN",
    "MCP_STUDIO_ACTOR_ID",
    "CONTROLLER_ADMIN_IDS",
    "MEDIA_PROCESSOR_URL",
    "PUBLIC_MEDIA_BASE_URL",
    "PUBLIC_BASE_URL",
    "ENABLE_X_METRICS",
    "THREADS_APP_ID",
  ].map((key, index) => [key, ["", " ", "\t\n", " ﻿　"][index % 4] as string]),
);
const everything = {
  NODE_ENV: "test",
  DEPLOYMENT_ENV: "test",
  LOG_LEVEL: "debug",
  PORT: " 0x1F90 ",
  BIND_HOST: "0.0.0.0",
  DATA_DIR: "./var//studio/../data/",
  TELEGRAM_API_BASE_URL: "http://bot-api:8081",
  CONTROLLER_BOT_TOKEN: "123456:abc",
  CLIENT_IP_HASH_SALT: "🙂".repeat(16),
  TRUSTED_CLIENT_IP_HEADER: "cf-connecting-ip",
  COMMAND_CENTER_TOKEN: "cc",
  MCP_STUDIO_TOKEN: "mcp-token-0123456789",
  MCP_STUDIO_ACTOR_ID: "1e3",
  DEEPSEEK_API_KEY: "sk-deepseek",
  GROK_CLI_PATH: "/usr/bin/grok",
  CONTROLLER_ADMIN_IDS: "1, 2,x,0,-3,1e3,0x10, 2.5,9007199254740993,,  42  ",
  STUDIO_ACTOR_IDS: "7",
  TELEGRAM_CHANNEL_USERNAME: "@channel",
  PUBLISH_JOB_TIMEOUT_SECONDS: "899",
  METRICS_REFRESH_INTERVAL_SECONDS: "11",
  CREATOR_PROFILE_REFRESH_INTERVAL_SECONDS: "60",
  OBSERVABILITY_INTERVAL_SECONDS: "301",
  IDLE_POLL_INTERVAL_SECONDS: "6",
  MEDIA_PROCESSOR_PROVIDER: "remote_http",
  MEDIA_PROCESSOR_URL: "  https://media.example.org/run\t ",
  MEDIA_PROCESSOR_TOKEN: "media-token-0123456789",
  MEDIA_PROCESSOR_TIMEOUT_SECONDS: "10",
  STORY_CARD_ASSETS_DIR: "/assets",
  STORY_CARD_RENDERER_ENTRY: "/renderer.js",
  THREADS_RU_ACCESS_TOKEN: "threads-ru",
  THREADS_EN_ACCESS_TOKEN: "threads-en",
  THREADS_CONTAINER_TIMEOUT_SECONDS: "181",
  THREADS_APP_ID: "threads-app",
  THREADS_APP_SECRET: "threads-secret",
  X_CLIENT_ID: "x-client",
  X_CLIENT_SECRET: "x-secret",
  ENABLE_X_METRICS: "Yes",
  DISCORD_CHANNEL_ID: "discord-channel",
  DISCORD_GUILD_ID: "discord-guild",
  ENABLE_X_PROFILE_METRICS: "OFF",
  INSTAGRAM_EN_ACCESS_TOKEN: "ig-en",
  INSTAGRAM_EN_USER_ID: "ig-en-user",
  INSTAGRAM_RU_ACCESS_TOKEN: "ig-ru",
  INSTAGRAM_RU_USER_ID: "ig-ru-user",
  INSTAGRAM_APP_ID: "ig-app",
  INSTAGRAM_APP_SECRET: "ig-secret",
  INSTAGRAM_GRAPH_API_VERSION: "v24.0",
  YOUTUBE_RU_CLIENT_ID: "yt-ru",
  YOUTUBE_RU_CLIENT_SECRET: "yt-ru-secret",
  YOUTUBE_RU_REFRESH_TOKEN: "yt-ru-refresh",
  YOUTUBE_EN_CLIENT_ID: "yt-en",
  YOUTUBE_EN_CLIENT_SECRET: "yt-en-secret",
  YOUTUBE_EN_REFRESH_TOKEN: "yt-en-refresh",
  TELEGRAM_STORIES_CHANNEL: "@stories",
  TELEGRAM_CHANNEL_STORIES_API_ID: "12345",
  TELEGRAM_CHANNEL_STORIES_API_HASH: "hash",
  TELEGRAM_CHANNEL_STORIES_SESSION: "session",
  PUBLIC_MEDIA_BASE_URL: "https://cdn.example.org/media",
  PUBLIC_BASE_URL: "https://studio.example.org//",
  TOKEN_ENCRYPTION_KEY: "00".repeat(32),
  DEPLOY_AGENT_URL: "http://deploy-agent:9000",
  DEPLOY_AGENT_TOKEN: "deploy-token-0123456789",
  INDEXNOW_ENABLED: "false",
  UNRELATED_VARIABLE: "ignored",
};
const configCases: Record<string, Record<string, string>> = {
  minimal: {},
  blank,
  everything,
  production,
  "production without token": { ...production, COMMAND_CENTER_TOKEN: "" },
  "production without salt": { ...production, CLIENT_IP_HASH_SALT: " " },
  "production without base url": { ...production, PUBLIC_BASE_URL: "" },
  "node production only": { NODE_ENV: "production" },
  "deployment production only": { DEPLOYMENT_ENV: "production" },
  "remote processor without url": { MEDIA_PROCESSOR_PROVIDER: "remote_http", MEDIA_PROCESSOR_TOKEN: "media-token-0123456789" },
  "remote processor without token": { MEDIA_PROCESSOR_PROVIDER: "remote_http", MEDIA_PROCESSOR_URL: "https://m.example.org" },
  "port NaN": { PORT: "abc" },
  "port fraction": { PORT: "-1.5" },
  "port negative": { PORT: "-1" },
  "port zero": { PORT: "0" },
  "port minus zero": { PORT: "-0" },
  "port infinity": { PORT: "Infinity" },
  "port inf": { PORT: "inf" },
  "port huge": { PORT: "1e20" },
  "port huge negative": { PORT: "-1e20" },
  "port unsafe": { PORT: "9007199254740993" },
  "port exponent": { PORT: "1e3" },
  "port octal": { PORT: "0o17" },
  "port binary": { PORT: "0b101" },
  "port signed hex": { PORT: "-0x10" },
  "port dot": { PORT: "80." },
  "port leading dot": { PORT: ".5e1" },
  "port separator": { PORT: "8_000" },
  "port nel": { PORT: "\u008580" },
  "enum invalid": { NODE_ENV: "prod", LOG_LEVEL: "INFO", TRUSTED_CLIENT_IP_HEADER: "x-forwarded-for" },
  "enum nel": { NODE_ENV: "\u0085" },
  "salt short": { CLIENT_IP_HASH_SALT: "short" },
  "salt astral short": { CLIENT_IP_HASH_SALT: "🙂🙂🙂🙂🙂🙂🙂" },
  "url invalid": { MEDIA_PROCESSOR_URL: "not a url" },
  "url mailto": { MEDIA_PROCESSOR_URL: "mailto:x@y" },
  "url spaced": { DEPLOY_AGENT_URL: " http://a\tb/c d ", DEPLOY_AGENT_TOKEN: "deploy-token-0123456789" },
  "url and refine": { DEPLOY_AGENT_URL: "nope", THREADS_APP_ID: "x" },
  "threads pair": { THREADS_APP_ID: "1" },
  "instagram pair": { INSTAGRAM_APP_SECRET: "1" },
  "youtube pair": { YOUTUBE_RU_CLIENT_ID: "1", YOUTUBE_EN_CLIENT_SECRET: "2" },
  "deploy pair": { DEPLOY_AGENT_TOKEN: "deploy-token-0123456789" },
  "mcp pair": { MCP_STUDIO_TOKEN: "mcp-token-0123456789" },
  "mcp actor zero": { MCP_STUDIO_TOKEN: "mcp-token-0123456789", MCP_STUDIO_ACTOR_ID: "0" },
  "mcp short token": { MCP_STUDIO_TOKEN: "short", MCP_STUDIO_ACTOR_ID: "5" },
  "type error skips refine": { PORT: "x", THREADS_APP_ID: "1" },
  "int error skips refine": { PORT: "1.5", THREADS_APP_ID: "1" },
  "timeout at lock": { PUBLISH_JOB_TIMEOUT_SECONDS: "900" },
  "timeout above max": { PUBLISH_JOB_TIMEOUT_SECONDS: "5000" },
  "timeout zero": { PUBLISH_JOB_TIMEOUT_SECONDS: "0" },
  "creator refresh too small": { CREATOR_PROFILE_REFRESH_INTERVAL_SECONDS: "59" },
  "processor timeout range": { MEDIA_PROCESSOR_TIMEOUT_SECONDS: "9" },
  flags: { ENABLE_X_METRICS: "TRUE", ENABLE_X_PROFILE_METRICS: "no", INDEXNOW_ENABLED: "0" },
  "flags odd": { ENABLE_X_METRICS: "off ", ENABLE_X_PROFILE_METRICS: "Off", INDEXNOW_ENABLED: "nope" },
  "data dir root": { DATA_DIR: "/" },
  "data dir relative": { DATA_DIR: "data" },
  "data dir parent": { DATA_DIR: "../../x/./y/.." },
  "data dir dot": { DATA_DIR: "." },
  "base url without slash": { PUBLIC_BASE_URL: "http://example.org" },
};
write(
  "config.json",
  Object.entries(configCases).map(([name, env]) => {
    const result = attempt(() => {
      const { controllerBotToken: _bot, commandCenterToken: _center, ...config } = loadConfig(env);
      return config;
    });
    return { name, env, result };
  }),
);

// ---- secret box -----------------------------------------------------------

const keyHex = "8f2b6c1d9e0a47f3b5c2d8e1f6a3b9c0d7e4f1a2b3c4d5e6f708192a3b4c5d6e"; // gitleaks:allow (public test key, not a secret)
const key = encryptionKey(keyHex) as Buffer;
const secretValues = ["EAAG-token-value", "токен", "🙂 emoji 👨‍👩‍👧 and \u0000 nul", "x".repeat(5000), "a"];
write("secret-box.json", {
  key: keyHex,
  sealed: secretValues.map((value) => ({ value, sealed: seal(value, key) })),
  open_errors: ["", "abc", "a.b", "..", seal("", key), `${seal("tampered", key).slice(0, -4)}AAAA`].map((sealed) => ({
    sealed,
    result: attempt(() => open(sealed, key)),
  })),
  fingerprints: ["", ...secretValues].map((value) => ({ value, fingerprint: fingerprint(value) })),
  keys: [
    keyHex,
    keyHex.toUpperCase(),
    ` \t${keyHex}\n`,
    `${keyHex}zz`,
    `${keyHex}0`,
    keyHex.slice(0, 63),
    keyHex.slice(0, 62),
    `0x${keyHex}`,
    "not hex",
    `${keyHex.slice(0, 10)}g${keyHex.slice(11)}`,
  ].map((raw) => ({ raw, result: attempt(() => (encryptionKey(raw) as Buffer).toString("hex")) })),
});

// ---- text -----------------------------------------------------------------

const texts = [
  "",
  "plain ascii text",
  "Привет, мир",
  "🙂🙃😉",
  "👨‍👩‍👧‍👦 family",
  "🇮🇱🇷🇺 flags",
  "é combining",
  "a‍b‍c",
  "𝔘𝔫𝔦𝔠𝔬𝔡𝔢 math",
  "mixed 🙂 текст 👍🏽 end",
];
const truncate = texts.flatMap((value) => [0, 1, 2, 3, 5, 8, 100].map((max) => ({ value, max, result: truncateUnicode(value, max) })));
const markdownInputs = [
  "",
  "nothing special",
  "a_b*c[d]e`f\\g",
  "[link](url) and _italic_ **bold**",
  "\\\\ double",
  "emoji 🙂_🙃 and ZWJ 👨‍💻*",
  "dots.and-hyphens(parens)!",
];
const redactInputs = [
  "https://x.example/cb?access_token=EAAG123&next=1",
  'API_KEY=abc123 api-key=def apikey=ghi Password=hunter2 TOKEN=xyz"tail',
  "GET https://api.telegram.org/bot123456789:AAH-x_yZ/getMe",
  "GET https://api.telegram.org/bot12345:short/getMe",
  "Authorization: Bearer abc.def-ghi_jkl rest",
  "authorization: bearer\t\tqwe",
  "token= spaced token=a\u0085b",
  "ſecret token=keep aCCeSS_ToKeN=hidden",
  "\u212aey token=x pa\u017f\u017fword=x to\u212aen=y",
  "/bot١٢٣٤٥٦:abc",
  "nothing to redact here",
];
write("text.json", {
  truncate,
  markdown: markdownInputs.map((value) => ({ value, result: escapeMarkdown(value) })),
  redact: redactInputs.map((value) => ({ value, result: redactExternalSecrets(value) })),
});
