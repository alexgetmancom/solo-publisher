import { and, eq, isNotNull } from "drizzle-orm";
import { type BackendDb, unsafeDb } from "../db/client.js";
import { publicationTargets } from "../db/schema.js";
import type { BackendConfig } from "../foundation/config.js";
import { threadsCredentials } from "../foundation/external/threads.js";
import { ExternalHttpError, requestJson } from "../foundation/http.js";
import { log } from "../foundation/logger.js";
import { recordPostComment } from "./post-comments.js";

type ThreadsReply = {
  id?: string;
  text?: string;
  username?: string;
  timestamp?: string;
  replied_to?: { id?: string };
};

type ThreadsConversation = { data?: ThreadsReply[]; paging?: { next?: string } };

const REPLY_FIELDS = "id,text,username,timestamp,replied_to";
const REPLY_LIMIT = 50;
/** How far a single post is followed. A conversation longer than this is not a
 * conversation any more, and the cap is what stops a paging bug from walking
 * forever on someone else's rate limit. */
const MAX_PAGES = 40;

/** Meta's throttles, as they arrive: HTTP 429, and the codes the Graph family
 * uses for a call count that is spent. Told apart from every other failure
 * because the answer to this one is to stop, not to try the next post. */
function isThrottled(error: unknown): boolean {
  if (error instanceof ExternalHttpError) {
    if (error.status === 429) return true;
    const code = /"code"\s*:\s*(\d+)/.exec(error.body ?? "")?.[1];
    return code === "4" || code === "17" || code === "32" || code === "613";
  }
  return false;
}

/** Whose replies these are, so the Studio's own voice can be left out of them.
 * This Studio publishes Threads chains by replying to itself, and those parts
 * come back in the same conversation: counted as audience they would put the
 * author's own text into a report about what the audience is saying. */
async function ownUsername(config: BackendConfig, target: string, fetchImpl: typeof fetch): Promise<string | null> {
  const { accessToken } = threadsCredentials(config, target === "threads_en" ? "threads_en" : "threads_ru");
  if (!accessToken) return null;
  const me = await requestJson<{ username?: string }>(
    fetchImpl,
    `https://graph.threads.net/v1.0/me?fields=username&access_token=${encodeURIComponent(accessToken)}`,
  );
  return me.username ?? null;
}

/**
 * Reads the replies under Threads posts and records them.
 *
 * `conversation` rather than `replies`: the second returns only the top level,
 * and a question answered three deep is exactly the thing worth reading. Each
 * reply names the one it answers, so the shape survives being stored flat.
 *
 * Threads answers a token without `threads_read_replies` with an empty HTTP 500
 * rather than a permission error, so a Studio whose token predates that scope
 * reads as the platform being down. The caller treats a failure here as
 * enrichment that did not arrive, never as a failed collection.
 */
export async function collectThreadsReplies(
  backendDb: BackendDb,
  config: BackendConfig,
  target: string,
  externalPostIds: readonly string[],
  fetchImpl: typeof fetch = fetch,
  now = new Date(),
  options: { pages?: number; skipAuthor?: string | null } = {},
): Promise<number> {
  const { accessToken: token } = threadsCredentials(config, target === "threads_en" ? "threads_en" : "threads_ru");
  if (!token) return 0;
  const maxPages = options.pages ?? 1;
  const skipAuthor = options.skipAuthor ?? null;
  let stored = 0;
  for (const externalPostId of externalPostIds) {
    let url: string | undefined = conversationUrl(externalPostId, token);
    for (let page = 0; url && page < maxPages; page += 1) {
      const answer: ThreadsConversation = await requestJson<ThreadsConversation>(fetchImpl, url);
      for (const reply of answer.data ?? []) {
        if (!reply.id || !reply.text) continue;
        // The post itself comes back in its own conversation; it is not a
        // comment on itself.
        if (reply.id === externalPostId) continue;
        if (skipAuthor && reply.username === skipAuthor) continue;
        recordPostComment(
          backendDb,
          {
            target,
            commentId: reply.id,
            externalPostId,
            author: reply.username ?? "",
            text: reply.text,
            // A reply to the post names the post; only a reply to a reply names
            // another comment.
            replyToCommentId: reply.replied_to?.id && reply.replied_to.id !== externalPostId ? reply.replied_to.id : null,
            sentAt: reply.timestamp ? new Date(reply.timestamp) : now,
          },
          now,
        );
        stored += 1;
      }
      // Threads hands back a fully formed next link, token included.
      url = answer.paging?.next;
    }
  }
  return stored;
}

function conversationUrl(externalPostId: string, token: string): string {
  const url = new URL(`https://graph.threads.net/v1.0/${externalPostId}/conversation`);
  url.searchParams.set("fields", REPLY_FIELDS);
  url.searchParams.set("limit", String(REPLY_LIMIT));
  url.searchParams.set("access_token", token);
  return url.toString();
}

export type BackfillReport = {
  target: string;
  posts: number;
  visited: number;
  stored: number;
  stoppedEarly: "throttled" | null;
  skippedAuthor: string | null;
};

/**
 * Walks every Threads publication this Studio has and reads its whole
 * conversation.
 *
 * The regular collection rides the metrics checkpoint, which visits a post a
 * few times and then stops for good, and takes one page while it is there.
 * Neither is wrong for keeping up; both are wrong for an archive nobody has
 * ever read. So this exists separately and is run by hand.
 *
 * It stops on the first throttle instead of moving to the next post. Continuing
 * to call after Meta says the count is spent lengthens the block rather than
 * getting more data, and a backfill has nothing that cannot wait until
 * tomorrow.
 */
export async function backfillThreadsReplies(
  backendDb: BackendDb,
  config: BackendConfig,
  target: string,
  fetchImpl: typeof fetch = fetch,
  options: { posts?: number; pause?: (ms: number) => Promise<void> } = {},
): Promise<BackfillReport> {
  const pause = options.pause ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const rows = unsafeDb(backendDb)
    .db.select({ externalId: publicationTargets.externalId })
    .from(publicationTargets)
    .where(and(eq(publicationTargets.target, target), isNotNull(publicationTargets.externalId)))
    .orderBy(publicationTargets.publishedAt)
    .all();
  const ids = rows.map((row) => String(row.externalId)).slice(0, options.posts ?? rows.length);
  const skipAuthor = await ownUsername(config, target, fetchImpl);
  const report: BackfillReport = { target, posts: ids.length, visited: 0, stored: 0, stoppedEarly: null, skippedAuthor: skipAuthor };

  for (const externalPostId of ids) {
    try {
      report.stored += await collectThreadsReplies(backendDb, config, target, [externalPostId], fetchImpl, new Date(), {
        pages: MAX_PAGES,
        skipAuthor,
      });
      report.visited += 1;
    } catch (error) {
      if (isThrottled(error)) {
        report.stoppedEarly = "throttled";
        log("warn", "threads backfill stopped on a throttle", { target, visited: report.visited, stored: report.stored });
        break;
      }
      // One post that cannot be read -- deleted, or never really published --
      // is not a reason to abandon the rest of the archive.
      log("warn", "threads post could not be read", {
        target,
        externalPostId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    // Spread out rather than burst: the limit is generous and the queue is not
    // in a hurry, and a burst is what turns a generous limit into a block.
    await pause(250);
  }
  return report;
}
