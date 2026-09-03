import { desc, sql } from "drizzle-orm";
import { type BackendDb, unsafeDb } from "../../db/client.js";
import { socialComments, telegramComments } from "../../db/schema.js";
import type { BackendConfig } from "../../foundation/config.js";
import { deepSeekChat } from "../../foundation/external/deepseek.js";
import { t } from "../../foundation/i18n/index.js";
import type { StudioLocale } from "../../foundation/locale.js";

/** How many comments the report is drawn from. One limit, applied to each store
 * and again to the merge, so adding a store cannot quietly grow the prompt. */
const COMMENT_SAMPLE = 100;

const SYSTEM_PROMPT =
  "You are a community editor. From these comments, write a concise report in English: 1) games or topics requested most often, 2) FAQ, 3) audience sentiment, 4) up to 3 ideas for the next Shorts/Reels. Use only these comments, do not invent facts or reveal author names, and use at most 10 bullet points.";

/** Everything the audience wrote, wherever it wrote it.
 *
 * The video platforms answer under a video and Telegram answers under a post,
 * which is why the two are stored apart -- posts and videos are separate
 * aggregates everywhere in this Studio. The report is not about either: it is
 * about what people are saying, so the split ends here rather than becoming a
 * second report nobody remembers to open. */
function recentComments(backendDb: BackendDb): { platform: string; text: string }[] {
  const social = unsafeDb(backendDb)
    .db.select({ platform: socialComments.platform, text: socialComments.text, at: socialComments.publishedAt })
    .from(socialComments)
    .orderBy(desc(socialComments.publishedAt))
    .limit(COMMENT_SAMPLE)
    .all();
  const telegram = unsafeDb(backendDb)
    .db.select({ platform: sql<string>`'telegram'`, text: telegramComments.text, at: telegramComments.sentAt })
    .from(telegramComments)
    .where(sql`trim(${telegramComments.text}) <> ''`)
    .orderBy(desc(telegramComments.sentAt))
    .limit(COMMENT_SAMPLE)
    .all();
  return [...social, ...telegram]
    .sort((left, right) => String(right.at ?? "").localeCompare(String(left.at ?? "")))
    .slice(0, COMMENT_SAMPLE)
    .map(({ platform, text }) => ({ platform, text }));
}

export async function audienceAnalysis(
  backendDb: BackendDb,
  config: BackendConfig,
  locale: StudioLocale = "ru",
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  if (!config.DEEPSEEK_API_KEY) return `🤖 ${t(locale, "audience.unavailable")}`;
  const comments = recentComments(backendDb);
  if (!comments.length) return `🤖 ${t(locale, "audience.no-comments")}`;
  const content = await deepSeekChat(
    config,
    [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: comments.map((comment) => `[${comment.platform}] ${comment.text}`).join("\n") },
    ],
    { temperature: 0.2, timeoutMs: 40_000 },
    fetchImpl,
  );
  return `🤖 *${t(locale, "audience.title")}*\n\n${content || t(locale, "audience.no-report")}`;
}
