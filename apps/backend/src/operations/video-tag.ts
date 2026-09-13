import { eq } from "drizzle-orm";
import { HOOK_TYPES } from "../analytics/collection/hook-types.js";
import { type BackendDb, unsafeDb } from "../db/client.js";
import { videoDrafts } from "../db/schema.js";

/** Writes what a video is about and how it opens.
 *
 * The game stays free text: what a video is about is its own name and no list
 * could hold them. The opening does not. It is one of a closed six, and the
 * first month of tagging is what settled which six -- a seventh spelling typed
 * here is a group of one that every report counts and no report can compare,
 * and the classifier next door has been holding that line alone. Passing an
 * empty string clears a field. */
export function tagVideo(backendDb: BackendDb, videoDraftId: number, input: { game?: string; hook?: string }): Record<string, unknown> {
  const draft = unsafeDb(backendDb)
    .db.select({ id: videoDrafts.id, label: videoDrafts.label, game: videoDrafts.game, hook: videoDrafts.hook })
    .from(videoDrafts)
    .where(eq(videoDrafts.id, videoDraftId))
    .get();
  if (!draft) throw new Error(`No video draft ${videoDraftId}. Run \`video-report\` for the videos this Studio has.`);
  const hook = input.hook?.trim();
  if (hook && !(HOOK_TYPES as readonly string[]).includes(hook))
    throw new Error(
      `\`${hook}\` is not one of the kinds of opening: ${HOOK_TYPES.join(", ")}. \`openings\` lists what each video carries.`,
    );
  const update = {
    ...(input.game === undefined ? {} : { game: input.game.trim() || null }),
    ...(input.hook === undefined ? {} : { hook: hook || null }),
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
