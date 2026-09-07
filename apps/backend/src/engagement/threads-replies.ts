import type { BackendDb } from "../db/client.js";
import type { BackendConfig } from "../foundation/config.js";
import { threadsCredentials } from "../foundation/external/threads.js";
import { requestJson } from "../foundation/http.js";
import { recordPostComment } from "./post-comments.js";

type ThreadsReply = {
  id?: string;
  text?: string;
  username?: string;
  timestamp?: string;
  replied_to?: { id?: string };
  is_reply?: boolean;
};

const REPLY_FIELDS = "id,text,username,timestamp,replied_to,is_reply";
/** One page. A post that draws more replies than this in a collection interval
 * is not the shape this Studio publishes, and paging on every checkpoint would
 * spend a request per post to learn there is nothing new. */
const REPLY_LIMIT = 50;

/**
 * Reads the replies under one Threads post and records them.
 *
 * `conversation` rather than `replies`: the first returns only the top level,
 * and a question answered three deep is exactly the thing worth reading. Each
 * reply names the one it answers, so the shape survives being stored flat.
 *
 * Threads answers a token without reply permission with an empty HTTP 500 --
 * not a permission error -- so a studio whose token predates that scope reads
 * as the platform being down. The caller treats a failure here as enrichment
 * that did not arrive, never as a failed collection.
 */
export async function collectThreadsReplies(
  backendDb: BackendDb,
  config: BackendConfig,
  target: string,
  externalPostIds: readonly string[],
  fetchImpl: typeof fetch = fetch,
  now = new Date(),
): Promise<number> {
  const { accessToken: token } = threadsCredentials(config, target === "threads_en" ? "threads_en" : "threads_ru");
  if (!token) return 0;
  let stored = 0;
  for (const externalPostId of externalPostIds) {
    const url = new URL(`https://graph.threads.net/v1.0/${externalPostId}/conversation`);
    url.searchParams.set("fields", REPLY_FIELDS);
    url.searchParams.set("limit", String(REPLY_LIMIT));
    url.searchParams.set("access_token", token);
    const answer = await requestJson<{ data?: ThreadsReply[] }>(fetchImpl, url.toString());
    for (const reply of answer.data ?? []) {
      if (!reply.id || !reply.text) continue;
      // The post itself comes back in its own conversation; it is not a comment
      // on itself.
      if (reply.id === externalPostId) continue;
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
  }
  return stored;
}
