import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
// sharp is a dependency of the backend, not of the root scripts.
import sharp from "../../apps/backend/node_modules/sharp/dist/index.mjs";
import { buildStoryCardCopy } from "../../apps/backend/src/story-cards/copy.js";
import { emojiAssetFile, storyCardEmojiTop, storyCardOverlaySvg } from "../../apps/backend/src/story-cards/svg.js";

/**
 * Reference outputs of the TypeScript Story-card renderer, recorded for the
 * Rust `story_render` crate's parity tests under
 * crates/story_render/tests/fixtures/:
 *
 * - `copy.json`: the copy the worker builds from a stored card headline
 *   (`buildStoryCardCopy(card.headline)`), its overlay SVG and the emoji's
 *   asset name and box, for a corpus of headlines — the line breaking has to
 *   match exactly;
 * - `cards.json` + `<name>.jpg`: a handful of cards rendered by the real
 *   renderer (`renderer-process.ts`, sharp/libvips), spawned exactly as the
 *   worker spawns it, with the font configuration the worker writes. The
 *   card's noisy background makes a full-size JPEG about 500 KB, so what is
 *   kept is the card halved (each 2×2 block averaged) at JPEG quality
 *   REFERENCE_QUALITY; the full-size renders stay in the scratch directory.
 *
 *   bun scripts/rust/story-render-fixtures.ts
 */
const fixtures = path.join(import.meta.dir, "../../crates/story_render/tests/fixtures");
const assetsDir = path.join(import.meta.dir, "../../apps/backend/assets/story-card");
const renderer = path.join(import.meta.dir, "../../apps/backend/src/story-cards/renderer-process.ts");
const scratch = path.join(import.meta.dir, "../../_trash-rust/tmp/story-render-fixtures");

const REFERENCE_QUALITY = 70;

const json = (value: unknown) => JSON.stringify(value, (_key, item) => (item === undefined ? null : item));

function write(name: string, items: unknown[]): void {
  writeFileSync(path.join(fixtures, name), `[\n${items.map((item) => `  ${json(item)}`).join(",\n")}\n]\n`);
  console.log(`wrote ${name}`);
}

/** What the store keeps on a card row (`queueDraftStoryCards`), then what the
 * worker hands the renderer (`renderStoryCard`): the copy rebuilt from the
 * stored headline, with the stored headline and emoji laid back over it. */
function workerCopy(text: string) {
  const stored = buildStoryCardCopy(text);
  const copy = buildStoryCardCopy(stored.headline);
  copy.emoji = stored.emoji;
  copy.headline = stored.headline;
  return copy;
}

function layout(text: string, wordmark: string) {
  const copy = workerCopy(text);
  return {
    text,
    wordmark,
    copy,
    svg: storyCardOverlaySvg(copy, wordmark),
    emojiFile: emojiAssetFile(copy.emoji),
    emojiTop: storyCardEmojiTop(copy),
  };
}

const corpus = [
  "Коротко.",
  "Одно слово",
  "",
  "🔥",
  "Update",
  "🚨 СЛИВ: Две модели OpenAI с кодовыми именами Zinc и Magnesium были замечены в DesignArena. Остальной пост не нужен.",
  "⚡ ChatGPT достиг примерно миллиарда еженедельно активных пользователей.",
  "⚡️ ChatGPT reached approximately one billion weekly active users.",
  `Ссылка ${"a".repeat(120)} внутри поста.`,
  "a".repeat(400),
  "🔥 ".concat("длинное слово ".repeat(40)),
  "Mmmm Wwww ЖЖЖЖ ШШШШ ЩЩЩЩ ЮЮЮЮ ФФФФ mmmm wwww",
  "illi 1111 |||| .... ,,,, :::: ;;;; !!!! '''' ````",
  "ABCDEFGHIJKLMNOPQRSTUVWXYZ АБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯ 0123456789",
  "Запуск 🚀 сегодня: новая версия уже в магазине приложений.",
  "🔥 Запуск 🚀 сегодня: «новая» версия & <теги>.",
  "Цитата «в кавычках» & <теги> \"двойные\" и 'одинарные'.",
  "Первая строка.\nВторая строка, которая не попадёт на карточку.",
  "\n\n  Пустые строки сначала. Потом текст.",
  "Что? Да.",
  "v1.2 release is out. Next",
  "🇷🇺 Россия сегодня обновила правила для разработчиков мобильных приложений и сервисов.",
  "1️⃣ первый пункт списка дел на сегодня.",
  "OpenAI, Anthropic, Google DeepMind и Meta договорились о совместном стандарте безопасности для открытых моделей следующего поколения, который вступит в силу в начале будущего года.",
  "https://example.com/a/very/long/path/that/does/not/break/naturally?query=string&and=more тут текст",
  "Слово\tс неразрывным пробелом и табуляцией внутри строки.",
  "Ёлка ёжик ЁЁЁ ёё Ё",
  "x".repeat(19),
  "x".repeat(20),
  "Ш".repeat(13),
  "Ш".repeat(14),
  "Mixed CASE words With Capitals Everywhere In This Headline Today",
];

mkdirSync(fixtures, { recursive: true });
write(
  "copy.json",
  corpus.flatMap((text) => [layout(text, "Strata"), ...(text.length > 60 ? [] : [layout(text, "")])]),
);

/** The cards whose pixels are compared: wrapping, both weights, Cyrillic and
 * Latin, the Twemoji asset, the ellipsis, a word broken by width, and a card
 * with no wordmark. An emoji inside the headline is in `copy.json` only:
 * librsvg draws it as a traced silhouette, resvg in colour. */
const cards = [
  { name: "short-ru", text: "Коротко.", wordmark: "Страта" },
  {
    name: "emoji-wrap-ru",
    text: "🚨 СЛИВ: Две модели OpenAI с кодовыми именами Zinc и Magnesium были замечены в DesignArena.",
    wordmark: "Страта",
  },
  { name: "emoji-en", text: "⚡️ ChatGPT reached approximately one billion weekly active users.", wordmark: "Strata" },
  {
    name: "overflow-no-wordmark",
    text: "OpenAI, Anthropic, Google DeepMind и Meta договорились о совместном стандарте безопасности для открытых моделей следующего поколения, который вступит в силу в начале будущего года.",
    wordmark: "",
  },
  { name: "long-word", text: `Ссылка ${"a".repeat(120)} внутри поста.`, wordmark: "Strata" },
];

/** The card halved, each 2×2 block averaged, as the Rust test halves its own. */
async function halved(file: string): Promise<Buffer> {
  const { data, info } = await sharp(file).raw().toBuffer({ resolveWithObject: true });
  const [width, height, channels] = [info.width / 2, info.height / 2, info.channels];
  const out = Buffer.alloc(width * height * channels);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      for (let c = 0; c < channels; c++) {
        const at = (dx: number, dy: number) => data[((2 * y + dy) * info.width + 2 * x + dx) * channels + c] ?? 0;
        out[(y * width + x) * channels + c] = (at(0, 0) + at(1, 0) + at(0, 1) + at(1, 1) + 2) >> 2;
      }
  return sharp(out, { raw: { width, height, channels } }).jpeg({ quality: REFERENCE_QUALITY, chromaSubsampling: "4:4:4" }).toBuffer();
}

rmSync(scratch, { recursive: true, force: true });
mkdirSync(scratch, { recursive: true });
const fontConfig = path.join(scratch, "fontconfig.xml");
writeFileSync(
  fontConfig,
  `<?xml version="1.0"?><!DOCTYPE fontconfig SYSTEM "fonts.dtd"><fontconfig><dir>${assetsDir}</dir><cachedir>/tmp/story-card-font-cache</cachedir></fontconfig>`,
);
const rendered = [];
for (const card of cards) {
  const copy = workerCopy(card.text);
  const outputPath = path.join(scratch, `${card.name}.jpg`);
  const child = Bun.spawn([process.execPath, renderer], {
    stdin: Buffer.from(
      JSON.stringify({
        backgroundPath: path.join(assetsDir, "strata-master-background.png"),
        assetsDir,
        outputPath,
        wordmark: card.wordmark,
        copy,
      }),
    ),
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, FONTCONFIG_FILE: fontConfig },
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(`renderer failed for ${card.name}: ${stderr}`);
  writeFileSync(path.join(fixtures, `${card.name}.jpg`), await halved(outputPath));
  rendered.push({ ...card, copy, result: JSON.parse(stdout) as { emoji: boolean } });
  console.log(`rendered ${card.name}.jpg`);
}
write(
  "cards.json",
  rendered.map((card) => ({ name: card.name, text: card.text, wordmark: card.wordmark, copy: card.copy, emoji: card.result.emoji })),
);
