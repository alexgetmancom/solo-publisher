import { and, eq, inArray, notInArray } from "drizzle-orm";
import { isSiteTarget, targetLocale } from "../botTargets.js";
import type { UnsafeBackendDb } from "../db/client.js";
import { drafts, postLocales, publishJobs, siteJobs } from "../db/schema.js";
import { hasResumeState, newDeliveryPayload } from "./delivery-payload.js";
import { localizeTargetPayload } from "./payload.js";
import type { PublicationPlan } from "./publication-plan.js";
import { enqueuePublishJobTx } from "./queue.js";
import { parsePayload } from "./queue-state.js";

export function persistPublicationPlanTx(tx: UnsafeBackendDb["db"], plan: PublicationPlan): void {
  for (const locale of plan.locales) {
    const publishedAt = locale.source.siteEnabled ? (locale.source.publishAt ?? (plan.mode === "immediate" ? plan.now : null)) : null;
    tx.update(postLocales)
      .set({
        slug: locale.source.slug,
        html: locale.html,
        entitiesJson: typeof locale.entitiesJson === "string" ? locale.entitiesJson : null,
        storyMediaJson: locale.source.storyMedia,
        siteMediaJson: locale.source.siteMedia,
        siteEnabled: locale.source.siteEnabled ? 1 : 0,
        publishAt: locale.source.publishAt,
        publishedAt,
        updatedAt: plan.now,
      })
      .where(and(eq(postLocales.draftId, plan.draftId), eq(postLocales.locale, locale.locale)))
      .run();
  }
  // A job that carries what it has already published is a delivery in progress,
  // whatever its status says: the rest of a Threads chain waits in exactly the
  // `queued` and `failed` rows this deletes. Replacing one with a fresh job
  // republishes the part that is already live, which is the same duplicate an
  // ordinary retry used to produce -- reached by editing the post instead.
  const unfinished = tx
    .select({ jobId: publishJobs.jobId, target: publishJobs.target, payloadJson: publishJobs.payloadJson })
    .from(publishJobs)
    .where(and(eq(publishJobs.publicationKey, plan.publicationKey), inArray(publishJobs.status, ["queued", "failed"])))
    .all()
    .filter((row) => hasResumeState(parsePayload(row.payloadJson)));
  tx.delete(publishJobs)
    .where(
      and(
        eq(publishJobs.publicationKey, plan.publicationKey),
        inArray(publishJobs.status, ["queued", "failed"]),
        ...(unfinished.length
          ? [
              notInArray(
                publishJobs.jobId,
                unfinished.map((row) => row.jobId),
              ),
            ]
          : []),
      ),
    )
    .run();
  tx.delete(siteJobs)
    .where(and(eq(siteJobs.publicationKey, plan.publicationKey), inArray(siteJobs.status, ["queued", "failed"])))
    .run();
  // Targets whose delivery is settled or actively in flight are not replanned.
  // "publishing" counts as final on purpose: a worker already holds that job
  // and may have hit the platform, so rewriting its payload risks a duplicate
  // post. A half-published target counts for the same reason and is read off
  // the job rather than off a status, since it is sitting in `queued` or
  // `failed` while the rest of it waits. Re-planning a publication mid-delivery
  // therefore leaves those targets on the previous plan — visible to the user,
  // and intended.
  const finalTargets = new Set([
    ...tx
      .select({ target: publishJobs.target })
      .from(publishJobs)
      .where(
        and(
          eq(publishJobs.publicationKey, plan.publicationKey),
          inArray(publishJobs.status, ["publishing", "published", "skipped", "verification_required"]),
        ),
      )
      .all()
      .map((row) => row.target),
    ...unfinished.map((row) => row.target),
  ]);
  const finalSiteLocales = new Set(
    tx
      .select({ reason: siteJobs.reason })
      .from(siteJobs)
      .where(and(eq(siteJobs.publicationKey, plan.publicationKey), inArray(siteJobs.status, ["rendering", "published"])))
      .all()
      .map((row) => row.reason.match(/(?:^|_)(ru|en)(?:_|$)/)?.[1])
      .filter((locale): locale is "ru" | "en" => locale === "ru" || locale === "en"),
  );
  for (const [target, enabled] of Object.entries(plan.targets)) {
    const publishAt = publishAtForTarget(plan, target);
    if (enabled && publishAt != null && !isSiteTarget(target) && !finalTargets.has(target))
      enqueuePublishJobTx(tx, {
        publicationKey: plan.publicationKey,
        target,
        // Every target still here is one the plan may build from scratch: the
        // half-delivered ones were kept above and never reach this loop.
        payload: newDeliveryPayload(localizeTargetPayload(plan.payload, target)),
        publishAt,
      });
  }
  for (const [locale, enabled] of [
    ["ru", plan.targets.site_ru],
    ["en", plan.targets.site_en],
  ] as const) {
    const publishAt = publishAtForLocale(plan, locale);
    if (enabled && publishAt != null && !finalSiteLocales.has(locale))
      tx.insert(siteJobs)
        .values({
          publicationKey: plan.publicationKey,
          messageId: plan.messageId,
          reason: `site_${locale}`,
          status: "queued",
          nextAttemptAt: publishAt ?? plan.now,
          createdAt: plan.now,
          updatedAt: plan.now,
        })
        .run();
  }
  tx.update(drafts)
    .set({
      status: "scheduled",
      postId: plan.postId,
      publishMode: plan.mode,
      scheduledAt: plan.ruAt,
      scheduledEnAt: plan.enAt,
      updatedAt: plan.now,
    })
    .where(eq(drafts.id, plan.draftId))
    .run();
}

function publishAtForTarget(plan: PublicationPlan, target: string): string | null {
  const locale = targetLocale(target);
  return locale ? publishAtForLocale(plan, locale) : null;
}

function publishAtForLocale(plan: PublicationPlan, locale: "ru" | "en"): string | null {
  if (plan.mode === "immediate") return plan.now;
  return locale === "en" ? plan.enAt : plan.ruAt;
}
