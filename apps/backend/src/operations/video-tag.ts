import { eq } from "drizzle-orm";
import { type BackendDb, unsafeDb } from "../db/client.js";
import { videoDrafts } from "../db/schema.js";

/** Writes what a video is about and how it opens.
 *
 * Both fields are free text on purpose: a fixed vocabulary would have to be
 * guessed now, and the first month of tagging is what tells anyone what the
 * vocabulary should be. Passing an empty string clears a field. */
export function tagVideo(backendDb: BackendDb, videoDraftId: number, input: { game?: string; hook?: string }): Record<string, unknown> {
  const draft = unsafeDb(backendDb)
    .db.select({ id: videoDrafts.id, label: videoDrafts.label, game: videoDrafts.game, hook: videoDrafts.hook })
    .from(videoDrafts)
    .where(eq(videoDrafts.id, videoDraftId))
    .get();
  if (!draft) throw new Error(`No video draft ${videoDraftId}. Run \`video-report\` for the videos this Studio has.`);
  const update = {
    ...(input.game === undefined ? {} : { game: input.game.trim() || null }),
    ...(input.hook === undefined ? {} : { hook: input.hook.trim() || null }),
  };
  if (!Object.keys(update).length)
    return { ref: `video:${videoDraftId}`, label: draft.label, game: draft.game, hook: draft.hook, changed: false };
  unsafeDb(backendDb)
    .db.update(videoDrafts)
    .set({ ...update, updatedAt: new Date().toISOString() })
    .where(eq(videoDrafts.id, videoDraftId))
    .run();
  return { ref: `video:${videoDraftId}`, label: draft.label, ...{ game: draft.game, hook: draft.hook }, ...update, changed: true };
}
