import fs from "node:fs";
import path from "node:path";
import { SITE_MEDIA_URL_PREFIX, siteMediaVerticalFilename } from "../../../backend/src/content/site-media-naming.js";
import { openBackendDb, unsafeDb } from "../../../backend/src/db/client.js";
import { draftEntityLinks, drafts, knowledgeEntities, postLocales } from "../../../backend/src/db/schema.js";
import { fixtureDayWindow } from "./fixture-utils.js";

/**
 * Builds a throwaway published site: a pipeline database plus the media files
 * the public read model expects to find on disk. Both the SSR smoke test and
 * `scripts/dev-seed.ts` run through here, so a local dev server and CI look at
 * the same shape of data — and a schema change breaks one obvious place
 * instead of every hand-written INSERT.
 */

/** Smallest valid 1x1 JPEG — enough for the media route to read real bytes off disk. */
export const FIXTURE_JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAj/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCdABmX/9k=",
  "base64",
);

type FixtureLocale = {
  slug: string;
  text: string;
  /** Media items for this locale. Two or more turn the story into a gallery. */
  images?: number;
};

export type FixturePost = {
  postId: number;
  ru: FixtureLocale;
  en: FixtureLocale;
  /** Publication date, defaulting to now. Backdated posts are what give the
   * dashboard a history to take a median and draw a sparkline over. */
  dateUtc?: string;
  entities?: Array<{ kind: "company" | "model" | "person" | "product" | "topic"; slug: string; titleRu: string; titleEn: string }>;
};

export const FULL_DEV_HISTORY_DAYS = 30;

export type FullDevFixtureOptions = {
  days?: number;
  minPostsPerDay?: number;
  maxPostsPerDay?: number;
};

/** The exact dataset the SSR smoke test asserts against. Changing it means
 * changing that test's expectations, so it lives here rather than inline. */
const SMOKE_FIXTURE: FixturePost[] = [
  {
    postId: 1,
    en: { slug: "smoke-test-post", text: "Smoke test post body.\nSecond paragraph.", images: 1 },
    ru: { slug: "dymovoy-test-post", text: "Тело дымового теста.\nВторой абзац." },
    entities: [{ kind: "company", slug: "example-ai", titleRu: "Example AI", titleEn: "Example AI" }],
  },
];

/** A hand-drivable dataset: `count` posts where the first one carries
 * `galleryImages` slides, so the segmented progress bar and the gallery swap
 * have something to run against. */
export function devFixture(count: number, galleryImages: number): FixturePost[] {
  return Array.from({ length: count }, (_, index) => {
    const postId = index + 1;
    const images = index === 0 ? Math.max(1, galleryImages) : 1;
    return {
      postId,
      en: { slug: `dev-post-${postId}`, text: `Dev post ${postId}.\nSecond paragraph of post ${postId}.`, images },
      ru: { slug: `dev-post-${postId}-ru`, text: `Тестовый пост ${postId}.\nВторой абзац поста ${postId}.`, images },
    };
  });
}

/** Stable day counts make the fixture feel random without making screenshots
 * and regression checks change on every seed. */
export function fullFixtureDayCounts(days: number, minPostsPerDay = 1, maxPostsPerDay = 5): number[] {
  const safeDays = Math.max(1, Math.floor(days));
  const min = Math.max(1, Math.floor(minPostsPerDay));
  const max = Math.max(min, Math.floor(maxPostsPerDay));
  const random = fixtureRandom(0x51f15e);
  return Array.from({ length: safeDays }, () => min + Math.floor(random() * (max - min + 1)));
}

/** Full local content history: one to five text posts per day for a month. */
export function fullDevFixture(galleryImages: number, options: FullDevFixtureOptions = {}): FixturePost[] {
  const days = Math.max(1, Math.floor(options.days ?? FULL_DEV_HISTORY_DAYS));
  const counts = fullFixtureDayCounts(days, options.minPostsPerDay, options.maxPostsPerDay);
  const random = fixtureRandom(0x7a11ce);
  const topics = [
    ["A practical look at the newest model", "Практический разбор новой модели"],
    ["What changed in the latest release", "Что изменилось в последнем релизе"],
    ["A small experiment with a useful result", "Небольшой эксперимент с полезным результатом"],
    ["The workflow that saved an afternoon", "Процесс, который сэкономил целый вечер"],
    ["Three details worth noticing", "Три детали, на которые стоит обратить внимание"],
  ] as const;
  let postId = 1;
  const posts: FixturePost[] = [];

  counts.forEach((count, day) => {
    const [start, end] = fixtureDayWindow(day);
    const available = Math.max(60_000, end.getTime() - start.getTime());
    for (let index = 0; index < count; index += 1) {
      const [englishTopic, russianTopic] = topics[(postId - 1) % topics.length] ?? topics[0];
      const publishedAt = new Date(Math.min(end.getTime(), start.getTime() + Math.round((available * (index + 1)) / (count + 1))));
      const number = postId;
      const images = day === 0 && index === 0 ? Math.max(1, galleryImages) : 1;
      const premiumMark = random() > 0.9 ? " · premium reach" : "";
      posts.push({
        postId: number,
        dateUtc: publishedAt.toISOString(),
        en: {
          slug: `full-dev-post-${number}`,
          text: `${englishTopic} · fixture post ${number}${premiumMark}.\nSecond paragraph for the reading view.`,
          images,
        },
        ru: {
          slug: `full-dev-post-${number}-ru`,
          text: `${russianTopic} · пост фикстуры ${number}${premiumMark ? " · премиальный охват" : ""}.\nВторой абзац для режима чтения.`,
          images,
        },
      });
      postId += 1;
    }
  });
  return posts;
}

function fixtureRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 4_294_967_296;
  };
}

/** Titles of the six text publications the overview reference layout shows. The
 * dashboard reads a publication's title from its locale text, so the titles have
 * to exist as posts here — the dashboard fixture only adds metrics on top. */
const PARITY_TITLES = [
  "как я снимал ролик про шкаф — тред",
  "разбор: почему короткие форматы душат охват",
  "что не так с медианой в аналитике",
  "shipping a self-hosted dashboard, day 3",
  "мини-итоги недели",
  "why nobody reads your analytics",
] as const;

/** How many days of quiet history back the norm and the sparkline. */
export const PARITY_HISTORY_DAYS = 30;
const PARITY_TODAY_POSTS = PARITY_TITLES.length;

/**
 * The dataset behind `dev-seed --mock`: six titled publications for today plus
 * thirty days of quiet history, so the overview renders with a real norm, a
 * real delta and a thirty-bar sparkline instead of the three-point fixture.
 */
export function overviewParityFixture(): FixturePost[] {
  const today = PARITY_TITLES.map((title, index) => ({
    postId: index + 1,
    en: { slug: `parity-post-${index + 1}`, text: title, images: index === 0 ? 2 : 1 },
    ru: { slug: `parity-post-${index + 1}-ru`, text: title, images: index === 0 ? 2 : 1 },
  }));
  const history = Array.from({ length: PARITY_HISTORY_DAYS }, (_, index) => {
    const postId = PARITY_TODAY_POSTS + index + 1;
    return {
      postId,
      dateUtc: new Date(Date.now() - (index + 1) * 86_400_000).toISOString(),
      en: { slug: `parity-history-${postId}`, text: `Archive post ${index + 1}`, images: 1 },
      ru: { slug: `parity-history-${postId}-ru`, text: `Архивный пост ${index + 1}`, images: 1 },
    };
  });
  return [...today, ...history];
}

export type SeededSite = {
  /** Public paths (no leading slash) of every media file written to disk. */
  imagePaths: string[];
};

export function seedSiteFixture(options: { dbPath: string; publicDir: string; posts?: FixturePost[] }): SeededSite {
  const fixture = options.posts ?? SMOKE_FIXTURE;
  const backendDb = openBackendDb(options.dbPath);
  const rawDb = unsafeDb(backendDb);
  const now = new Date().toISOString();
  const imagePaths: string[] = [];
  try {
    // A site fixture is for a Studio that serves a site. A fresh database does
    // not, so every route under test would answer 404 without this.
    backendDb.studioSettings.saveProfile({ siteEnabled: 1, updatedAt: now });
    for (const post of fixture) {
      const createdAt = post.dateUtc ?? now;
      rawDb.db
        .insert(drafts)
        .values({
          id: post.postId,
          actorId: 1,
          status: "published",
          targetsJson: "{}",
          postId: post.postId,
          createdAt,
          updatedAt: now,
        })
        .run();
      for (const locale of ["en", "ru"] as const) {
        const spec = post[locale];
        const images = spec.images ?? 0;
        rawDb.db
          .insert(postLocales)
          .values({
            draftId: post.postId,
            locale,
            slug: spec.slug,
            sourceText: spec.text,
            siteMediaJson: Array.from({ length: images }, (_, index) => ({
              type: "image",
              path: `media/posts/${post.postId}-${locale}-${index}-vertical.jpg`,
            })),
            siteEnabled: 1,
            publishedAt: now,
            updatedAt: now,
          })
          .run();
        for (let index = 0; index < images; index += 1) imagePaths.push(writeFixtureImage(options.publicDir, post.postId, locale, index));
      }
      for (const entity of post.entities ?? []) {
        const row = rawDb.db
          .insert(knowledgeEntities)
          .values({
            kind: entity.kind,
            slug: entity.slug,
            titleRu: entity.titleRu,
            titleEn: entity.titleEn,
            createdAt: now,
            updatedAt: now,
          })
          .returning({ id: knowledgeEntities.id })
          .get();
        rawDb.db.insert(draftEntityLinks).values({ draftId: post.postId, entityId: row.id, createdAt: now }).run();
      }
    }
  } finally {
    backendDb.close();
  }
  return { imagePaths };
}

/** The site read model only links a vertical composite once its file exists,
 * so the fixture writes real bytes under the production naming convention. */
function writeFixtureImage(publicDir: string, postId: number, locale: "ru" | "en", index: number): string {
  const publicPath = `${SITE_MEDIA_URL_PREFIX}/${siteMediaVerticalFilename(postId, locale, index, "image")}`;
  const absolute = path.join(publicDir, publicPath);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, FIXTURE_JPEG);
  return publicPath;
}
