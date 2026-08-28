import type { ApplicationPorts } from "../application/ports.js";
import { publicationRef } from "../application/publication-ref.js";
import { targetsRecord } from "../botTargets.js";
import type { DraftMessage } from "./message.js";
import { emphasizeTitle } from "./title-emphasis.js";

/** Content aggregate for a draft before it enters a publication plan. */
export function createDraftFromMessage(
  ports: ApplicationPorts,
  actorId: number,
  message: DraftMessage,
  configured?: { targetsJson: string; storyPublishMode?: "all" | "site_only" },
): number {
  const createdId = ports.drafts.create({
    actorId,
    textRu: message.text,
    textEnMachine: message.textEn ?? null,
    textEnApproved: message.textEnApproved ?? null,
    targetsJson: configured?.targetsJson ?? JSON.stringify(targetsRecord(ports.studioSettings.profile().defaultTargetsJson)),
    mediaRuJson: message.media.length ? JSON.stringify(message.media) : null,
    textRuEntitiesJson: JSON.stringify(emphasizeTitle(message.text, message.entities)),
    ...(configured?.storyPublishMode ? { storyPublishMode: configured.storyPublishMode } : {}),
  });
  ports.events.record({
    ref: publicationRef("draft", createdId),
    type: "content.draft.created",
    severity: "info",
    message: `Draft #${createdId} created`,
    details: { owner_id: actorId, media_count: message.media.length },
  });
  ports.storyCards.queue(createdId);
  return createdId;
}

export function requireDraft(ports: Pick<ApplicationPorts, "drafts">, draftId: number) {
  const draft = ports.drafts.get(draftId);
  if (!draft) throw new Error(`draft ${draftId} not found`);
  return draft;
}
