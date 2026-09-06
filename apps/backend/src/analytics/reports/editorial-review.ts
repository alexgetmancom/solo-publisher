import { type BackendDb, unsafeDb } from "../../db/client.js";
import { socialComments, telegramComments, videoDrafts, videoTargets } from "../../db/schema.js";
import type { BackendConfig } from "../../foundation/config.js";
import { deepSeekChat } from "../../foundation/external/deepseek.js";
import { t } from "../../foundation/i18n/index.js";
import type { StudioLocale } from "../../foundation/locale.js";
import { desc, eq, sql } from "drizzle-orm";
import { commentQuality } from "./comment-quality.js";
import { studioBrief } from "./studio-brief.js";

/** How many comments travel with the numbers. Enough to hear the room, few
 * enough that the figures are not buried under it -- the previous version sent
 * a hundred comments and nothing else, and got back a summary of comments
 * when the question was about the channel. */
const COMMENT_SAMPLE = 60;

/** Longer comments are opinions, shorter ones are noise; both are kept, but a
 * single comment cannot be allowed to fill the prompt. */
const COMMENT_LENGTH = 240;

const SYSTEM_PROMPT = [
  "You are the analyst of a short-video channel. You are given the channel's NUMBERS and a SAMPLE of viewer comments.",
  "Answer in the language named at the end of the user message, briefly, for the person who films the videos rather than for someone reading a dashboard.",
  "",
  "Hard rules:",
  "1. Use only the data you were given. Never invent a metric, a title or a figure that is not there.",
  "2. Name the sample behind every claim. Under five videos, say plainly that this is not enough to conclude anything.",
  "3. Do not confuse correlation with cause: tags and genres were chosen for videos, this is not an experiment.",
  "4. Comments are a fraction of a percent of viewers. Never say the audience liked something because three people wrote so.",
  "5. When the data cannot answer a question, say so instead of guessing.",
  "",
  "Structure:",
  "- What happened this period: two or three sentences with figures.",
  "- What works: only what stands on five or more videos.",
  "- What the audience asks for: from the comments, in the viewers' own words.",
  "- Three actions for next week: concrete, each tied to a figure.",
  "- What this data cannot tell: one honest paragraph.",
].join("\n");

/**
 * The channel's own numbers and its audience's own words, read together.
 *
 * The report this replaces sent a language model a hundred recent comments and
 * nothing else, so it could only ever answer "what are people saying" -- and
 * with a few hundred comments a month against a hundred and seventy videos,
 * that answer was thin enough that nobody opened it. This hands over the
 * measured picture as well, and constrains the model to it.
 */
export async function editorialReview(
  backendDb: BackendDb,
  config: BackendConfig,
  locale: StudioLocale = "ru",
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  if (!config.DEEPSEEK_API_KEY) return `🤖 ${t(locale, "audience.unavailable")}`;
  const facts = {
    brief: studioBrief(backendDb, { days: 7, timeZone: config.TIMEZONE }),
    comments: commentQuality(backendDb, { days: 30, limit: 10 }),
  };
  const comments = recentComments(backendDb);
  if (!comments.length && !facts.brief.week) return `🤖 ${t(locale, "audience.no-comments")}`;
  const content = await deepSeekChat(
    config,
    [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: [
          "CHANNEL NUMBERS (JSON):",
          JSON.stringify(facts),
          "",
          "VIEWER COMMENTS (platform | video | text):",
          ...comments.map((comment) => `${comment.platform} | ${comment.label ?? "—"} | ${comment.text}`),
          "",
          `ANSWER IN: ${locale === "ru" ? "Russian" : "English"}`,
        ].join("\n"),
      },
    ],
    { temperature: 0.2, timeoutMs: 90_000 },
    fetchImpl,
  );
  return `🤖 *${t(locale, "audience.title")}*\n\n${content.trim() || t(locale, "audience.no-report")}`;
}

/** Comments with the video they sit under, because a comment without its video
 * cannot be reasoned about: "огонь" under a hit and under a flop are different
 * facts. */
function recentComments(backendDb: BackendDb): Array<{ platform: string; label: string | null; text: string }> {
  const social = unsafeDb(backendDb)
    .db.select({
      platform: socialComments.platform,
      text: socialComments.text,
      at: socialComments.publishedAt,
      label: videoDrafts.label,
    })
    .from(socialComments)
    .innerJoin(videoTargets, eq(videoTargets.id, socialComments.videoTargetId))
    .innerJoin(videoDrafts, eq(videoDrafts.id, videoTargets.videoDraftId))
    .orderBy(desc(socialComments.publishedAt))
    .limit(COMMENT_SAMPLE)
    .all();
  const telegram = unsafeDb(backendDb)
    .db.select({ platform: sql<string>`'telegram'`, text: telegramComments.text, at: telegramComments.sentAt, label: sql<null>`NULL` })
    .from(telegramComments)
    .where(sql`trim(${telegramComments.text}) <> ''`)
    .orderBy(desc(telegramComments.sentAt))
    .limit(COMMENT_SAMPLE)
    .all();
  return [...social, ...telegram]
    .sort((left, right) => String(right.at ?? "").localeCompare(String(left.at ?? "")))
    .slice(0, COMMENT_SAMPLE)
    .map((comment) => ({ platform: comment.platform, label: comment.label, text: comment.text.slice(0, COMMENT_LENGTH) }));
}
