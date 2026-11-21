import { writeFileSync } from "node:fs";
import path from "node:path";
import type { EntityEnrichmentStore, ThreadPart } from "../../apps/backend/src/application/ports.js";
import { postLocales } from "../../apps/backend/src/channels/locales.js";
import { registerChannel } from "../../apps/backend/src/channels/registry.js";
import { draftLocaleContent } from "../../apps/backend/src/content/draft-content.js";
import { enrichPublishedPostEntities } from "../../apps/backend/src/content/entity-enrichment.js";
import { parseMarkdownArticle } from "../../apps/backend/src/content/markdown.js";
import { mediaSizeAdvice } from "../../apps/backend/src/content/media-size-advice.js";
import { firstLine, firstNonEmptyLine, fixUrlSlashes, slugify } from "../../apps/backend/src/content/message.js";
import {
  RESPONSIVE_WIDTHS,
  SITE_MEDIA_URL_PREFIX,
  siteMediaFilename,
  siteMediaPosterFilename,
} from "../../apps/backend/src/content/site-media-naming.js";
import { entitiesToHtml, firstTextLinkUrl, splitText } from "../../apps/backend/src/content/text.js";
import { textLocale } from "../../apps/backend/src/content/text-locale.js";
import { chainPosts, joinedThread, localizedThread } from "../../apps/backend/src/content/thread.js";
import { emphasizeTitle } from "../../apps/backend/src/content/title-emphasis.js";
import { translateDraftText, translationWanted } from "../../apps/backend/src/content/translation.js";
import { openBackendDb } from "../../apps/backend/src/db/client.js";
import type { BackendConfig } from "../../apps/backend/src/foundation/config.js";
import { escapeHtml } from "../../apps/backend/src/foundation/html.js";
import { isHttpUrl } from "../../apps/backend/src/foundation/url.js";

/**
 * Reference outputs of the TypeScript content modules, recorded for the Rust
 * `content` crate's parity tests under crates/content/tests/fixtures/.
 * Deterministic: the corpus comes from a seeded generator, and translation runs
 * against a stubbed `fetch`.
 *
 *   bun scripts/rust/content-fixtures.ts
 *
 * The private `importStudioMediaFile` checks of assets.ts are not exported, so
 * the Rust crate pins them with its own unit tests instead.
 */
const fixtures = path.join(import.meta.dir, "../../crates/content/tests/fixtures");

const json = (value: unknown) => JSON.stringify(value, (_key, item) => (item === undefined ? null : item));

/** One array element per line. A lone surrogate cannot cross into Rust, so a
 * recorded one is a generator bug rather than a fixture. */
function write(name: string, value: Record<string, unknown[]>): void {
  const body = `{\n${Object.entries(value)
    .map(([key, items]) => `  ${json(key)}: [\n${items.map((item) => `    ${json(item)}`).join(",\n")}\n  ]`)
    .join(",\n")}\n}\n`;
  if (/\\ud[89a-f][0-9a-f]{2}/i.test(body)) throw new Error(`${name} records a lone surrogate`);
  writeFileSync(path.join(fixtures, name), body);
  console.log(`wrote ${name}`);
}

// Deterministic pseudo-random sequence, so the fixture does not churn.
let seed = 20261121;
function random(): number {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
}
const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
const integer = (min: number, max: number) => min + Math.floor(random() * (max - min + 1));

// ---- corpus ----------------------------------------------------------------

const RU_POST = [
  "🚀 Claude Code получил встроенный браузер",
  "",
  "Теперь агент сам открывает страницу, т.е. не нужен отдельный Playwright. Работает в версии 2.1 и выше… Проверил на трёх проектах!",
  "",
  "Что изменилось:",
  "• скриншоты (без лишних шагов)",
  "• логи консоли — прямо в контексте",
  "• «умные» ожидания?! Да.",
  "",
  "Подробнее: https://alexgetman.com/blog/claude-code и в канале @alexgetman #claude",
].join("\n");

const EN_POST = [
  "Claude Code now ships a built-in browser",
  "",
  "The agent opens the page itself, e.g. no separate Playwright setup. Dr. Smith (U.S. team) said it works vs. the old flow.",
  "It runs on v2.1+ and the screenshots land in context. That's it.",
  "",
  "Read more at https://alexgetman.com/blog/claude-code",
].join("\n");

const EDGE_TEXTS = [
  "",
  "   ",
  "\u00a0\ufeff текст \u3000",
  "\u0085начало с U+0085",
  `${"a".repeat(9)}👨🏽‍🚀${"b".repeat(9)}`,
  "👨‍👩‍👧‍👦".repeat(12),
  "🇷🇺🇺🇸🇮🇱".repeat(8),
  "Конец фразы. 𐐨 deseret после точки. Ещё одна фраза здесь.",
  "Он сказал: «Готово!» Потом ушёл. И т.д. и т.п. Вот так.",
  'Wait... what?! (Really.) "Yes." Okay then, fine.',
  "Первый абзац.\n\nВторой абзац, длинный, очень длинный.\n\nТретий.",
  "line one\nline two\nline three\nline four\nline five",
  "https://example.com/a/very/long/path/that/never/breaks/and/keeps/going/on/and/on/forever",
  "Цена 3.5 руб. за шт. и 4.2 руб. за кг. Вот.",
  "Ёлки и йога! Ёжик? Да… Нет.",
  "x\u2028y\u2029z. Next sentence. Another.",
  "Tab\tseparated\twords\tare\there and there",
];

const WORDS = [
  "Привет",
  "мир",
  "это",
  "длинный",
  "пост",
  "про",
  "Claude",
  "Code",
  "и",
  "агентов",
  "ёжик",
  "йога",
  "Telegram",
  "Threads",
  "API",
  "v2.1",
  "т.е.",
  "e.g.",
  "Dr.",
  "😀",
  "👍🏽",
  "👨‍💻",
  "🇷🇺",
  "𝐁𝐨𝐥𝐝",
  "«цитата»",
  "(скобки)",
  "https://example.com/путь?q=1",
  "@alexgetman",
  "#тег",
  "snake_case",
  "2*3",
  "…",
];
const SEPARATORS = [" ", " ", " ", " ", ", ", ". ", "! ", "? ", "… ", ".\n", "\n\n", " — ", ".» ", ".) ", ":\n• "];

function randomText(words: number): string {
  let text = "";
  for (let index = 0; index < words; index += 1) text += pick(WORDS) + (index === words - 1 ? "" : pick(SEPARATORS));
  return text;
}

const RANDOM_TEXTS = Array.from({ length: 60 }, () => randomText(integer(4, 180)));
const TEXTS = [RU_POST, EN_POST, ...EDGE_TEXTS, ...RANDOM_TEXTS];

// ---- text.ts ---------------------------------------------------------------

const LIMITS = [5, 7, 10, 16, 33, 64, 100, 140, 280, 500, 1000, 4096];
const split = TEXTS.flatMap((text) => [pick(LIMITS), pick(LIMITS), 280].map((limit) => ({ text, limit, parts: splitText(text, limit) })));
// The test-suite cases that pinned bugs: a cut mid-sentence, a surrogate pair
// torn in half on an unbroken run.
const sentence = "Мы починили разбивку тредов, и это заняло больше времени, чем хотелось. Теперь английский режется так же, как русский!";
split.push({
  text: `${sentence} ${"хвост ".repeat(20)}`.trim(),
  limit: 91,
  parts: splitText(`${sentence} ${"хвост ".repeat(20)}`.trim(), 91),
});

const URLS = [
  "https://example.com/?a=1&b=2",
  "http://пример.рф/путь",
  'https://example.com/"quoted"<tag>',
  "javascript:alert(1)",
  "ftp://example.com",
  "example.com",
  "https://",
  " https://padded.example ",
  "HTTPS://UPPER.EXAMPLE/X",
  "http:example.com",
  "https://user:pass@host:8080/p#f",
  "mailto:a@b.c",
];
const TYPES = [
  "bold",
  "italic",
  "underline",
  "strikethrough",
  "spoiler",
  "code",
  "pre",
  "text_link",
  "url",
  "heading",
  "quote",
  "list_item",
  "mention",
  "hashtag",
  "custom_emoji",
  "blockquote",
];
const HTML_TEXTS = [
  "See link\nnext",
  "bold italic under strike code",
  "click here",
  "alpha beta gamma",
  "go example.com now",
  "short",
  "a < b & c > d \"q\" 'apos'",
  "😀 эмодзи 👨‍👩‍👧 и ссылка example.com/путь тут",
  "visit https://example.com/x?y=<1> or javascript:void(0) now",
  "Заголовок\n\nТело поста 🇷🇺 с **разметкой**",
  ...TEXTS.slice(0, 30),
];

function randomEntity(length: number): Record<string, unknown> {
  const type = pick(TYPES);
  const offset = integer(-1, length + 1);
  const entity: Record<string, unknown> = { type, offset, length: integer(-1, Math.max(1, length - offset + 2)) };
  if (type === "text_link") entity.url = random() < 0.1 ? 42 : pick(URLS);
  if (type === "heading" && random() < 0.8) entity.level = pick([0, 1, 2, 3, 6, 7, "4", null, "x", 2.5, -3]);
  if (random() < 0.05) entity.offset = String(entity.offset);
  if (random() < 0.03) delete entity.offset;
  return entity;
}

const html: Array<{ text: string; entities: Record<string, unknown>[]; html: string }> = [
  { text: "See link\nnext", entities: [{ type: "text_link", offset: 4, length: 4, url: "https://example.com/?a=1&b=2" }] },
  {
    text: "bold italic under strike code",
    entities: [
      { type: "bold", offset: 0, length: 4 },
      { type: "italic", offset: 5, length: 6 },
      { type: "underline", offset: 12, length: 5 },
      { type: "strikethrough", offset: 18, length: 6 },
      { type: "code", offset: 25, length: 4 },
    ],
  },
  {
    text: "click here",
    entities: [
      { type: "text_link", offset: 0, length: 10, url: "https://example.com/" },
      { type: "bold", offset: 0, length: 5 },
    ],
  },
  {
    text: "alpha beta gamma",
    entities: [
      { type: "italic", offset: 0, length: 16 },
      { type: "bold", offset: 6, length: 4 },
    ],
  },
  { text: "go example.com now", entities: [{ type: "url", offset: 3, length: 11 }] },
  { text: "short", entities: [{ type: "bold", offset: 2, length: 99 }] },
  // UTF-16 offsets: the emoji before the bold range is two units each.
  { text: "😀😀 жирный", entities: [{ type: "bold", offset: 5, length: 6 }] },
  // A boundary inside a surrogate pair: recorded well-formed, as Rust renders it.
  { text: "a😀b", entities: [{ type: "bold", offset: 2, length: 2 }] },
  { text: "x", entities: [{ type: "heading", offset: 0, length: 1, level: "abc" }] },
  ...HTML_TEXTS.flatMap((text) =>
    Array.from({ length: 4 }, () => ({ text, entities: Array.from({ length: integer(0, 6) }, () => randomEntity(text.length)) })),
  ),
].map((item) => ({ ...item, html: entitiesToHtml(item.text, item.entities).toWellFormed() }));

const textLinks = [
  [],
  [{ type: "bold", offset: 0, length: 1 }],
  [
    { type: "text_link", offset: 10, length: 2, url: "https://late.example" },
    { type: "text_link", offset: 2, length: 2, url: "https://early.example" },
  ],
  [
    { type: "text_link", offset: 0, length: 2, url: "javascript:x" },
    { type: "text_link", offset: 5, length: 2, url: "https://ok.example" },
  ],
  [
    { type: "text_link", length: 2, url: "https://no-offset.example" },
    { type: "text_link", offset: "-1", length: 2, url: "https://string-offset.example" },
  ],
  [{ type: "text_link", offset: 1, length: 2, url: 7 }],
  ...html.map((item) => item.entities),
].map((entities) => ({ entities, url: firstTextLinkUrl(entities as Record<string, unknown>[]) }));

const helpers = {
  is_http_url: [...URLS, "", "https://example.com", "http://[::1]:80/", "https://exa mple.com", "https://%zz", "file:///etc"].map(
    (value) => ({ value, ok: isHttpUrl(value) }),
  ),
  escape_html: ["", "a<b>&\"'c", "😀 & «ёж»"].map((value) => ({ value, html: escapeHtml(value) })),
};

write("text.json", { split, html, first_text_link: textLinks, ...helpers });

// ---- markdown.ts -----------------------------------------------------------

const MARKDOWN = [
  "# Real title\n\nFirst paragraph.",
  "Just prose, no heading.",
  "# T\n\nplain **bold** tail",
  "**one** and *two*",
  "see [the notes](https://example.com/n) here",
  "[click](javascript:alert)",
  "## Section\n\n- first\n2. second",
  "## Section\n\nA **bold** [link](https://example.com).",
  "",
  "\n\n   \n",
  "#no-space title\n\nbody",
  "#   Spaced title   \n\n\n  \nbody\n\n  \n",
  "intro line\n# Late title\nafter",
  "# First\n# Second\nbody",
  "###### six\n####### seven\n#",
  "> quote\n>tight\n>",
  "  - indented\n* star\n+ plus\n-not item",
  "1) first\n10. tenth\n3.no space",
  "Windows\r\nline\r\nendings\rold mac",
  "😀 **жирный** и *курсив* 👨‍👩‍👧 [ссылка](https://пример.рф/путь) `код`",
  "**bold *nested italic* bold**",
  "***both***",
  "_a_b_ and snake_case_word and __dunder__",
  "2*3*4 = 24 and a * b * c",
  "*unclosed and **unclosed bold",
  "`**not bold**` then **bold**",
  "~~strike~~ ~~ not ~~",
  '[a](https://x.example/(paren)) [b](https://y.example "title")',
  "[ftp](ftp://a.example) [ok](http://b.example)",
  "line\u2028separator ## not heading",
  "#\u2028weird",
  "\u00a0 - nbsp item",
  "**a** **b** **c** *d* _e_ `f` ~~g~~ [h](https://h.example)",
  "**multi\nline**",
  "**🚀 Запуск**: _быстро_",
  "*a **b** c*",
  "**x `y` z** and *a `**b**` c*",
  "[**bold link**](https://x.example) **[link](https://y.example)**",
  "# Заголовок статьи\n\nПервый абзац с **жирным** текстом.\n\n## Раздел\n\n> Цитата с [ссылкой](https://example.com)\n\n- пункт один\n- пункт *два*\n\n1. первый\n2. второй",
  ...Array.from({ length: 30 }, () =>
    Array.from(
      { length: integer(1, 8) },
      () =>
        `${pick(["", "", "# ", "## ", "> ", "- ", "1. ", "  * "])}${randomText(integer(1, 12))
          .split(" ")
          .map((word) =>
            random() < 0.15 ? `${pick(["**", "*", "_", "__", "~~", "`"])}${word}${pick(["**", "*", "_", "__", "~~", "`"])}` : word,
          )
          .join(" ")}`,
    ).join(pick(["\n", "\n\n"])),
  ),
];

write("markdown.json", { articles: MARKDOWN.map((source) => ({ source, parsed: parseMarkdownArticle(source) })) });

// ---- thread.ts -------------------------------------------------------------

const threadParts: ThreadPart[] = [
  {
    position: 2,
    textRu: "Второй",
    entitiesRu: [{ type: "bold", offset: 0, length: 6 }],
    textEn: "Second",
    textEnApproved: null,
    media: [],
  },
  {
    position: 3,
    textRu: "Третий",
    entitiesRu: [],
    textEn: "Third",
    textEnApproved: "Third, approved",
    media: [{ type: "photo", fileId: "f" }],
  },
  { position: 4, textRu: "Четвёртый", entitiesRu: [], textEn: null, textEnApproved: null, media: [] },
  { position: 5, textRu: "Пятый", entitiesRu: [], textEn: "Fifth", textEnApproved: "", media: [] },
];
const localized = (["ru", "en"] as const).map((locale) => ({ locale, thread: threadParts, parts: localizedThread(threadParts, locale) }));

const joined = [
  {
    first: { text: "Первый пост  \n", entities: [{ type: "bold", offset: 0, length: 6 }] },
    rest: [
      {
        text: "  \n Второй 😀 пост  ",
        entities: [
          { type: "italic", offset: 4, length: 6 },
          { type: "bold", offset: 1, length: 2 },
        ],
        media: [],
      },
      { text: "   ", entities: [{ type: "bold", offset: 0, length: 1 }], media: [] },
      {
        text: "Третий",
        entities: [
          { type: "bold", offset: 0, length: 7 },
          { type: "code", offset: "2", length: "3" },
        ],
        media: [],
      },
      {
        text: "\u00a0Четвёртый",
        entities: [
          { type: "url", offset: 1, length: 9, extra: true },
          { type: "bold", length: 1 },
        ],
        media: [],
      },
    ],
  },
  { first: { text: "", entities: [] }, rest: [{ text: "Только второй", entities: [{ type: "bold", offset: 0, length: 6 }], media: [] }] },
  { first: { text: "Один", entities: [] }, rest: [] },
  ...TEXTS.slice(0, 20).map((text) => ({
    first: { text, entities: [randomEntity(text.length)] },
    rest: Array.from({ length: integer(0, 3) }, () => {
      const part = `${pick(["", " ", "\n\n"])}${randomText(integer(1, 20))}${pick(["", " ", "\n"])}`;
      return { text: part, entities: Array.from({ length: integer(0, 3) }, () => randomEntity(part.length)), media: [] };
    }),
  })),
].map((input) => ({ ...input, joined: joinedThread(input.first, input.rest) }));

const chains = [
  { posts: [{ text: `${"a".repeat(500)} tail`, entities: [{ type: "bold", offset: 0, length: 4 }], media: ["photo"] }], limit: 500 },
  {
    posts: [
      {
        text: RU_POST,
        entities: [
          { type: "bold", offset: 0, length: 41 },
          { type: "url", offset: 400, length: 10 },
        ],
        media: [{ type: "photo" }],
      },
      { text: EN_POST, entities: [{ type: "italic", offset: "0", length: 5 }, { type: "bold" }], media: [] },
    ],
    limit: 140,
  },
  ...TEXTS.slice(20, 60).map((text) => ({
    posts: [{ text, entities: Array.from({ length: 3 }, () => randomEntity(text.length)), media: [{ type: "video" }] }],
    limit: pick(LIMITS),
  })),
].map((input) => ({ ...input, chain: chainPosts(input.posts, input.limit) }));

write("thread.json", { localized, joined, chains });

// ---- message.ts, title-emphasis.ts, text-locale.ts -------------------------

const LINES = [
  null,
  "",
  "\n\n",
  "  Первая строка  \nвторая",
  "\r\n\r\n  третья\r\n",
  "один\rдва\nтри",
  "\u00a0\n\ufeffx",
  ...TEXTS.slice(0, 10),
];
const message = {
  first_line: LINES.map((text) => ({ text, result: firstLine(text, "fallback") })),
  first_non_empty_line: LINES.map((text) => ({ text, result: firstNonEmptyLine(text, "fallback"), empty: firstNonEmptyLine(text) })),
  fix_url_slashes: [
    "https:\\\\example.com\\path\\file see C:\\Windows\\path",
    "HTTP:/\\host\\a and http:\\\\x.y\\z\tnext\\word",
    "no url here \\ backslash",
    "hTtPs:\\ſ\\x ſtart",
    "https:\\\\a.b\\c\u00a0\\d",
    "httpss:\\\\x",
  ].map((text) => ({ text, fixed: fixUrlSlashes(text) })),
  slugify: [
    "Claude Code получил встроенный браузер",
    "Ёлки и йога",
    "",
    "!!!",
    "😀 эмодзи 👨‍👩‍👧 и всё",
    "Ли\u0306нейка с combining breve",
    "ÄÖÜ ß İstanbul ΣΊΣΥΦΟΣ",
    "--- dashes --- around ---",
    "a".repeat(100),
    `${"слово ".repeat(20)}конец`,
    ...TEXTS.slice(0, 15),
  ].map((text, index) => ({ text, post_id: 100 + index, slug: slugify(text, 100 + index) })),
};
write("message.json", message);

const TITLE_TEXTS = [
  "🚨 OpenAI возвращает лимиты\n\nСо следующей недели.",
  "Заголовок\n\nТело с ссылкой на что-то тут",
  "Одна строка без тела",
  "Строка\nсразу тело без пустой строки",
  `${"д".repeat(121)}\n\nТело`,
  `${"д".repeat(120)}\n\nТело`,
  `${"😀".repeat(60)}\n\nТело`,
  `${"😀".repeat(61)}\n\nТело`,
  "Заголовок\n\nТело",
  "Title with spaces   \r\n \t \r\n  body",
  "Title\n\n   ",
  "Title\n\n\u00a0x",
  "   \n\nbody",
  "\nTitle\n\nbody",
  RU_POST,
  EN_POST,
];
const ENTITY_SETS = [
  [],
  [{ type: "text_link", offset: 30, length: 4, url: "https://example.com" }],
  [{ type: "bold", offset: 0, length: 9 }],
  [{ type: "bold", offset: 50, length: 3 }],
  [{ type: "bold", offset: "2", length: 3 }],
  [{ type: "italic", offset: 0, length: 3 }],
  [{ type: "bold", length: 3 }],
];
write("title-emphasis.json", {
  cases: TITLE_TEXTS.flatMap((text) => ENTITY_SETS.map((entities) => ({ text, entities, result: emphasizeTitle(text, entities) }))),
});

const LOCALE_TEXTS = [
  "Сегодня разобрал, как мы используем React, TypeScript и Bun в проде — вышло короче, чем ожидал",
  "Разбор кейса: как Threads API, Instagram Graph и YouTube Data API считают просмотры по-разному",
  "Вышел новый пост про Threads: https://alexgetman.com/blog/threads-api #threads @alexgetman",
  "Today I shipped the new analytics dashboard and it finally reads the way I wanted",
  "New analytics dashboard shipped today",
  "Astra: Bun, Drizzle, SQLite, Hono, Astro, Biome, Lefthook, GitHub Actions",
  "Astra, Bun, Threads API, YouTube Shorts, Instagram Reels — 2026",
  "🔥🔥🔥",
  "https://alexgetman.com @alexgetman #release",
  "The channel «Алекс Гетман» is now live in English too, same posts, translated",
  "`const x = 1` and `let y` are code, not prose at all here",
  "www.example.com/path www.other.example/x and then some words follow here",
  "Ελληνικά γράμματα δεν είναι ούτε κυριλλικά ούτε λατινικά εδώ",
  "Smart 𝐛𝐨𝐥𝐝 𝐥𝐞𝐭𝐭𝐞𝐫𝐬 and the rest of an ordinary sentence",
  "snake_case_words 9lives _under scored words making the count low",
  "ÀÉÎÕÜ àéîõü çñ — Latin with diacritics written as a sentence here",
  ...TEXTS,
];
write("text-locale.json", { cases: LOCALE_TEXTS.map((text) => ({ text, locale: textLocale(text) })) });

// ---- entity-enrichment.ts --------------------------------------------------

const CATALOG = {
  entities: [
    { id: 1, kind: "company", parentEntityId: null, slug: "openai", titleRu: "OpenAI", titleEn: "OpenAI" },
    { id: 2, kind: "model", parentEntityId: 1, slug: "gpt-5", titleRu: "GPT-5", titleEn: null },
    { id: 3, kind: "company", parentEntityId: null, slug: "meta", titleRu: "Meta", titleEn: "Meta" },
    { id: 4, kind: "company", parentEntityId: null, slug: "anthropic", titleRu: "Anthropic", titleEn: "Anthropic" },
    { id: 5, kind: "model", parentEntityId: 4, slug: "claude-code", titleRu: "Клод Код", titleEn: "Claude Code" },
    { id: 6, kind: "topic", parentEntityId: null, slug: "codex", titleRu: "Codex", titleEn: "Codex" },
    { id: 7, kind: "topic", parentEntityId: null, slug: "agents", titleRu: "Агенты", titleEn: "Agents" },
    { id: 8, kind: "model", parentEntityId: 1, slug: "gpt", titleRu: "GPT", titleEn: "GPT" },
    { id: 9, kind: "model", parentEntityId: 10, slug: "gemini", titleRu: "Джемини", titleEn: "Gemini" },
    { id: 10, kind: "company", parentEntityId: null, slug: "google", titleRu: "Гугл", titleEn: "Google" },
    { id: 11, kind: "company", parentEntityId: null, slug: "x", titleRu: "X", titleEn: null },
    { id: 12, kind: "model", parentEntityId: 4, slug: "claude-opus", titleRu: "Claude Opus", titleEn: "Claude Opus" },
  ],
  aliases: [
    { entityId: 1, alias: "ОпенЭйАй" },
    { entityId: 5, alias: "claude code" },
    { entityId: 5, alias: " CC " },
    { entityId: 9, alias: "gemini 3" },
    { entityId: 12, alias: "Опус" },
  ],
};
const ENRICHMENT_DRAFTS = [
  [{ locale: "ru", text: "Claude Code получил браузер\n\nAnthropic выпустила обновление." }],
  [{ locale: "ru", text: "ChatGPT и метаданные: ничего не должно совпасть с gpt или meta" }],
  [
    { locale: "ru", text: "GPT-5 против Gemini\n\nСравнение моделей OpenAI и Google" },
    { locale: "en", text: "GPT-5 vs Gemini\n\nComparing OpenAI and Google" },
  ],
  [{ locale: "ru", text: "Собрал сайт с помощью Codex\n\nи это было быстро" }],
  [{ locale: "en", text: "Weekend notes\n\nI built a small CLI tool over the weekend, mostly using codex for the boring parts" }],
  [{ locale: "en", text: "Notes\n\nI built 🚀🚀🚀 the thing with codex" }],
  [{ locale: "ru", text: "Codex — новый агент\n\nот OpenAI" }],
  [
    { locale: "ru", text: "   " },
    { locale: "en", text: null },
  ],
  [{ locale: "ru", text: "Опус и CC в деле\n\nКлод Код и Claude Opus пишут код, а Агенты ждут" }],
  [{ locale: "ru", text: "МЕТА и OPENAI заглавными\r\nвторая строка про GPT" }],
  [],
];
const enrichment = ENRICHMENT_DRAFTS.map((locales, index) => {
  const links: Array<{ draft_id: number; entity_id: number; role: string; created_at: string }> = [];
  const store: EntityEnrichmentStore = {
    locales: () => locales,
    entities: () => CATALOG.entities,
    aliases: () => CATALOG.aliases,
    link: (draftId, entityId, role, createdAt) => links.push({ draft_id: draftId, entity_id: entityId, role, created_at: createdAt }),
  };
  const draftId = 500 + index;
  const linked = enrichPublishedPostEntities(store, draftId, "2026-11-21T10:00:00.000Z");
  return { draft_id: draftId, locales, linked, links };
});
write("entity-enrichment.json", { catalog: [CATALOG], drafts: enrichment });

// ---- draft-content.ts ------------------------------------------------------

const DRAFT_SOURCES = [
  {
    text_ru: "Привет",
    text_en_machine: "Hello",
    text_ru_entities_json: '[{"type":"bold","offset":0,"length":6}]',
    media_ru_json: '[{"type":"photo","fileId":"a"}]',
  },
  {
    text_ru: "Привет",
    text_en_approved: "Hi",
    text_en_machine: "Hello",
    media_en_json: '[{"type":"photo","fileId":"en"}]',
    text_en_entities_json: '[{"type":"italic","offset":0,"length":2}]',
  },
  { text_ru: null, text_en_approved: "", text_en_machine: "Machine" },
  { text_ru: "Без английского", media_ru_json: "[]", media_en_json: "" },
  { text_ru: "Сломанный JSON", text_ru_entities_json: "[{", media_ru_json: '{"type":"photo"}' },
  {
    text_ru: "Смешанный массив",
    text_ru_entities_json: '[1, null, "x", [], {"type":"bold","offset":0,"length":1}]',
    media_ru_json: "null",
  },
  {},
];
write("draft-content.json", {
  cases: DRAFT_SOURCES.flatMap((source) =>
    (["ru", "en"] as const).map((locale) => ({ source, locale, content: draftLocaleContent(source, locale) })),
  ),
});

// ---- assets.ts, media-size-advice.ts, site-media-naming.ts -----------------

const MEDIA_SETS = [
  [],
  [{ type: "video", file_size: 50_000_000 }],
  [{ type: "video", file_size: 50_000_001 }],
  [
    { type: "photo", file_size: 120_499_999 },
    { type: "video", file_size: 87_500_000 },
  ],
  [{ type: "photo" }, { type: "video", file_size: "huge" }],
  [
    { type: "video", file_size: -5 },
    { type: "video", file_size: 1_999_999_999.5 },
  ],
  [
    { type: "video", file_size: null },
    { type: "video", file_size: 64_500_000 },
  ],
];
write("media.json", {
  size_advice: MEDIA_SETS.map((media) => ({ media, advice: mediaSizeAdvice(media) })),
  naming: [
    { kind: "url_prefix", value: SITE_MEDIA_URL_PREFIX },
    { kind: "responsive_widths", value: [...RESPONSIVE_WIDTHS] },
    ...[
      [1200, "ru", 0, "jpg"],
      [7, "en", 3, "mp4"],
    ].map(([postId, locale, index, extension]) => ({
      kind: "filenames",
      value: [
        postId,
        locale,
        index,
        extension,
        siteMediaFilename(postId as number, locale as "ru" | "en", index as number, extension as string),
        siteMediaPosterFilename(postId as number, locale as "ru" | "en", index as number),
      ],
    })),
  ],
});

// ---- translation.ts --------------------------------------------------------

const config = (key: string) => ({ DEEPSEEK_API_KEY: key }) as BackendConfig;
const studios = [null, "ru", "en"].map((locale) => {
  const backendDb = openBackendDb(":memory:");
  if (locale) registerChannel(backendDb, { platform: "threads", locale, provider: "native", targetId: `threads_${locale}` });
  return backendDb;
});
const TRANSLATION_TEXTS = ["", "   ", "  Русский текст  ", "English only", "Смешанный text", "Ёж", "Ѐ ѐ Ӿ", "123 🚀", RU_POST];
const RESPONSES = [
  "  Russian text  ",
  "",
  "   ",
  "Please provide the text",
  "I'd be happy to help!",
  "PLEASE PROVIDE",
  "Pleaſe provide",
  "Fine.",
];

const wanted = studios.flatMap((backendDb) =>
  ["", "key"].flatMap((key) =>
    TRANSLATION_TEXTS.map((text) => ({
      text,
      has_translator: Boolean(key),
      publishes_english: postLocales(backendDb).includes("en"),
      wanted: translationWanted(backendDb, text, config(key)),
    })),
  ),
);

const originalFetch = globalThis.fetch;
const englishStudio = studios[2] as (typeof studios)[number];
const translations: unknown[] = [];
for (const key of ["", "key"])
  for (const text of TRANSLATION_TEXTS)
    for (const response of RESPONSES) {
      let request: unknown = null;
      globalThis.fetch = ((_url: string, init: RequestInit) => {
        request = JSON.parse(String(init.body));
        return Promise.resolve(Response.json({ choices: [{ message: { content: response } }] }));
      }) as unknown as typeof fetch;
      const result = await translateDraftText(englishStudio, text, config(key));
      translations.push({ text, has_translator: Boolean(key), response, request, result: result ?? null });
    }
globalThis.fetch = originalFetch;
for (const backendDb of studios) backendDb.close();

write("translation.json", { wanted, translations });
