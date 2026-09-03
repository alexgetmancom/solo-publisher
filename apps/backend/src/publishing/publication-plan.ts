import { publicationRef } from "../application/publication-ref.js";
import { isStoryTarget, targetLocale } from "../botTargets.js";
import { draftLocaleContent } from "../content/draft-content.js";
import type { requireDraft } from "../content/drafts.js";
import { firstLine, slugify } from "../content/message.js";
import { entitiesToHtml } from "../content/text.js";
import type { PublicationLocaleSource, PublicationSource } from "./publication-source.js";
import { assertKnownTargets, parseTargets } from "./targets.js";

export type PublishMode = "immediate" | "scheduled";
type PublicationSchedule = { mode: PublishMode; ruAt: string | null; enAt: string | null };
type StoryCardMedia = Record<"ru" | "en", Record<string, unknown>>;

export function effectivePublicationTargets(
  requested: Record<string, boolean>,
  availableTargets: ReadonlySet<string> | undefined,
  media: Record<"ru" | "en", readonly unknown[]>,
  generatedStoryCards: boolean,
  storyPublishMode: string | null,
): Record<string, boolean> {
  return Object.fromEntries(
    Object.entries(requested).map(([target, enabled]) => {
      const locale = targetLocale(target);
      return [
        target,
        enabled &&
          (!isStoryTarget(target) || generatedStoryCards || (locale ? media[locale].length > 0 : false)) &&
          (!generatedStoryCards || !isStoryTarget(target) || storyPublishMode === "all") &&
          (!availableTargets || availableTargets.has(target)),
      ];
    }),
  );
}

/** Pure publishing decision: draft content plus a schedule becomes a complete publication plan. */
export function createPublicationPlan(
  draft: ReturnType<typeof requireDraft>,
  draftId: number,
  postId: number,
  schedule: PublicationSchedule,
  now: string,
  availableTargets?: ReadonlySet<string>,
  storyCards?: StoryCardMedia,
) {
  const parsedTargets = parseTargets(draft.targets_json);
  assertKnownTargets(parsedTargets);
  const publicationKey = publicationRef("post", postId);
  const contentRu = draftLocaleContent(draft, "ru");
  const contentEn = draftLocaleContent(draft, "en");
  const { media: mediaRu, entities: entitiesRu, text: textRu } = contentRu;
  const { media: mediaEn, entities: entitiesEn, text: textEn } = contentEn;
  // A generated card gates a Story target behind the editor's explicit
  // choice, but it never revives a target the editor switched off.
  const targets = effectivePublicationTargets(
    parsedTargets,
    availableTargets,
    { ru: mediaRu, en: mediaEn },
    storyCards != null,
    draft.story_publish_mode,
  );
  // An empty first line leaves the slug to `slugify`, which names the post by
  // its own id rather than by anybody.
  const slugRu = slugify(firstLine(textRu, ""), postId);
  const slugEn = slugify(firstLine(textEn, ""), postId);
  const locale = (
    text: string,
    entities: Record<string, unknown>[],
    media: Record<string, unknown>[],
    storyMedia: Record<string, unknown>[],
    slug: string,
    publishAt: string | null,
    siteEnabled: boolean,
  ): PublicationLocaleSource => ({
    text,
    entities,
    media,
    storyMedia,
    siteMedia: media.length ? media : storyMedia,
    slug,
    publishAt,
    siteEnabled,
  });
  const ru = locale(textRu, entitiesRu, mediaRu, storyCards ? [storyCards.ru] : [], slugRu, schedule.ruAt, Boolean(targets.site_ru));
  const en = locale(textEn, entitiesEn, mediaEn, storyCards ? [storyCards.en] : [], slugEn, schedule.enAt, Boolean(targets.site_en));
  const payload: PublicationSource = {
    draftId,
    postId,
    targets,
    locales: { ru, en },
    // Frozen with the publication source: a later draft edit cannot waive the
    // rule for text the author did not approve.
    threadsChainApproved: Boolean(draft.threads_chain_approved),
  };
  return {
    draftId,
    postId,
    publicationKey,
    mode: schedule.mode,
    ruAt: schedule.ruAt,
    enAt: schedule.enAt,
    now,
    mediaRu,
    targets,
    textRu,
    textEn,
    payload,
    locales: [
      { locale: "ru" as const, source: ru, html: entitiesToHtml(textRu, entitiesRu), entitiesJson: draft.text_ru_entities_json },
      { locale: "en" as const, source: en, html: entitiesToHtml(textEn, entitiesEn), entitiesJson: draft.text_en_entities_json },
    ],
  };
}

export type PublicationPlan = ReturnType<typeof createPublicationPlan>;
