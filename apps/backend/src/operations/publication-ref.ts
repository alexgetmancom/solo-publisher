import { eq, or } from "drizzle-orm";
import { publicationRef } from "../application/publication-ref.js";
import { type BackendDb, unsafeDb } from "../db/client.js";
import { drafts } from "../db/schema.js";

export type ResolvedPublicationRef = { input: string; postId: number | null; publicationKey: string; messageId: number };

/** Resolves external command input to the stable publication identity used by Operations commands. */
export function resolvePublicationRef(backendDb: BackendDb, ref: string): ResolvedPublicationRef | null {
  const trimmed = ref.trim();
  const postKeyRef = trimmed.startsWith("post:") ? trimmed : null;
  const numeric = trimmed.match(/^post:(\d+)$/)?.[1] ?? (/^\d+$/.test(trimmed) ? trimmed : null);
  if (postKeyRef) {
    const id = Number(postKeyRef.slice(5));
    const post = unsafeDb(backendDb).db.select().from(drafts).where(eq(drafts.postId, id)).get();
    if (post?.postId)
      return { input: ref, postId: post.postId, publicationKey: postKeyRef, messageId: post.channelMessageId ?? post.postId };
  }
  if (!numeric) return null;
  const id = Number(numeric);
  const publication = unsafeDb(backendDb)
    .db.select({ postId: drafts.postId, channelMessageId: drafts.channelMessageId })
    .from(drafts)
    .where(or(eq(drafts.postId, id), eq(drafts.channelMessageId, id)))
    .get();
  if (publication?.postId) {
    return {
      input: ref,
      postId: publication.postId,
      publicationKey: publicationRef("post", publication.postId),
      messageId: publication.channelMessageId ?? publication.postId,
    };
  }
  return null;
}
