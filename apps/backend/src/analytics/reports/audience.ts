import { and, desc, eq, sql } from "drizzle-orm";
import { type BackendDb, unsafeDb } from "../../db/client.js";
import { socialComments, telegramComments, videoDrafts, videoTargets } from "../../db/schema.js";
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

export type SocialCommentThread = {
  platform: string;
  target: string;
  videoTargetId: number;
  url: string | null;
  label: string;
  comments: { commentId: string; author: string | null; text: string; likeCount: number; publishedAt: string | null }[];
};

/** The comments the video platforms answered with, newest video first.
 *
 * They arrive as enrichment on the video metrics checkpoint, not on a schedule
 * of their own, so an empty answer here means one of two different things --
 * nothing was said, or the checkpoint never reached the comment call. The
 * fetched-at of the newest comment is what tells them apart, which is why it is
 * reported rather than dropped. */
export function recentSocialComments(backendDb: BackendDb, limit: number): SocialCommentThread[] {
  const threads = unsafeDb(backendDb)
    .db.select({
      videoTargetId: socialComments.videoTargetId,
      platform: socialComments.platform,
      target: videoTargets.target,
      url: videoTargets.externalUrl,
      label: videoDrafts.label,
      latest: sql<string>`max(${socialComments.publishedAt})`,
    })
    .from(socialComments)
    .innerJoin(videoTargets, eq(videoTargets.id, socialComments.videoTargetId))
    .innerJoin(videoDrafts, eq(videoDrafts.id, videoTargets.videoDraftId))
    .groupBy(socialComments.videoTargetId, socialComments.platform)
    .orderBy(desc(sql`max(${socialComments.publishedAt})`))
    .limit(limit)
    .all();

  return threads.map((thread) => ({
    platform: thread.platform,
    target: thread.target,
    videoTargetId: thread.videoTargetId,
    url: thread.url,
    label: thread.label,
    comments: unsafeDb(backendDb)
      .db.select({
        commentId: socialComments.commentId,
        author: socialComments.author,
        text: socialComments.text,
        likeCount: socialComments.likeCount,
        publishedAt: socialComments.publishedAt,
      })
      .from(socialComments)
      .where(and(eq(socialComments.videoTargetId, thread.videoTargetId), eq(socialComments.platform, thread.platform)))
      .orderBy(desc(socialComments.publishedAt))
      .all(),
  }));
}
