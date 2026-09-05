import { publishesStory } from "../channels/registry.js";
import type { BackendDb } from "../db/client.js";
import type { BackendConfig } from "../foundation/config.js";
import { log } from "../foundation/logger.js";
import { jsonRecordArray } from "../json.js";
import { ensureStoryDerivative } from "./story-derivatives.js";

/**
 * Makes the Story shapes of a draft's media, for a draft that is going to a
 * Story.
 *
 * The trigger is the draft, not the file: media arrives long before anyone has
 * said where the post goes, and the two rules tried before this both guessed.
 * Reading the Studio's default profile prepared nothing for a Studio whose Story
 * target is turned on per draft -- Maru, whose only connected Story channel is
 * not in its profile, had every one of its Story publications pay for the encode
 * at delivery. Reading the connections instead prepared an encode for every
 * import, most of which no Story ever reads.
 *
 * Called wherever a draft's media or targets change, so turning a Story target
 * on starts the encode while the author is still writing. Publishing reads the
 * result and never makes it.
 */
export function prepareDraftStoryMedia(backendDb: BackendDb, config: BackendConfig, draftId: number): void {
  const draft = backendDb.drafts.get(draftId);
  if (!draft || !publishesStory(backendDb, draft.targets_json)) return;
  for (const item of [...jsonRecordArray(draft.media_ru_json), ...jsonRecordArray(draft.media_en_json)]) {
    const localPath = typeof item.local_path === "string" ? item.local_path : typeof item.localPath === "string" ? item.localPath : null;
    if (!localPath) continue;
    // Nobody waits for this: the draft is saved and its card is drawn while the
    // encode runs. A failure leaves the asset unprepared, which the delivery
    // refuses and `story-media-backfill` repairs.
    void ensureStoryDerivative(
      config,
      localPath,
      String(item.type ?? "")
        .toLowerCase()
        .includes("video"),
      {
        draftId,
        source: "draft",
      },
    ).catch((error: unknown) => {
      log("warn", "story derivative not prepared for draft", { draftId, error: error instanceof Error ? error.message : String(error) });
    });
  }
}
