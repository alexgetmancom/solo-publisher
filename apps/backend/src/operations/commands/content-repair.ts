import { and, eq, inArray } from "drizzle-orm";
import { entitiesToHtml } from "../../content/text.js";
import type { UnsafeBackendDb } from "../../db/client.js";
import { drafts, postLocales, siteJobs } from "../../db/schema.js";
import type { ResolvedPublicationRef } from "../publication-ref.js";

/** Repairs durable English content before Delivery rebuilds the site or retries a target. */
export function editLocaleContentTx(
  db: UnsafeBackendDb["db"],
  ref: ResolvedPublicationRef,
  locale: "ru" | "en",
  text: string,
): Record<string, unknown> {
  const value = text.trim();
  if (!value) throw new Error(`text_${locale} is required`);
  const now = new Date().toISOString();
  if (ref.postId != null) {
    const draft = db.select({ id: drafts.id }).from(drafts).where(eq(drafts.postId, ref.postId)).get();
    if (!draft) throw new Error(`publication ${ref.postId} has no aggregate`);
    db.update(postLocales)
      .set(
        locale === "en"
          ? { approvedText: value, html: entitiesToHtml(value, []), entitiesJson: "[]", updatedAt: now }
          : { sourceText: value, html: entitiesToHtml(value, []), entitiesJson: "[]", updatedAt: now },
      )
      .where(and(eq(postLocales.draftId, draft.id), eq(postLocales.locale, locale)))
      .run();
    db.update(drafts).set({ updatedAt: now }).where(eq(drafts.id, draft.id)).run();
  }
  enqueueRepairSiteJob(db, ref, `edit_${locale}`, now);
  return {
    ok: true,
    post_id: ref.postId,
    publication_key: ref.publicationKey,
    locale,
    text: true,
  };
}

export function replaceLocaleMediaTx(
  db: UnsafeBackendDb["db"],
  ref: ResolvedPublicationRef,
  locale: "ru" | "en",
  media: Record<string, unknown>[] | null,
): Record<string, unknown> {
  const now = new Date().toISOString();
  if (ref.postId != null) {
    const draft = db.select({ id: drafts.id }).from(drafts).where(eq(drafts.postId, ref.postId)).get();
    if (!draft) throw new Error(`publication ${ref.postId} has no aggregate`);
    const other = db
      .select({ mediaJson: postLocales.mediaJson })
      .from(postLocales)
      .where(and(eq(postLocales.draftId, draft.id), eq(postLocales.locale, locale === "en" ? "ru" : "en")))
      .get();
    const nextMedia = media == null ? (other?.mediaJson ?? []) : media;
    db.update(postLocales)
      .set({ mediaJson: nextMedia, siteMediaJson: nextMedia, updatedAt: now })
      .where(and(eq(postLocales.draftId, draft.id), eq(postLocales.locale, locale)))
      .run();
    db.update(drafts).set({ updatedAt: now }).where(eq(drafts.id, draft.id)).run();
  }
  enqueueRepairSiteJob(db, ref, media == null ? `use_other_media_for_${locale}` : `replace_${locale}_media`, now);
  return { ok: true, post_id: ref.postId, publication_key: ref.publicationKey, locale, media: media != null };
}

/** Rebuilds one locale's public projection without touching social targets. */
export function refreshLocaleSiteTx(db: UnsafeBackendDb["db"], ref: ResolvedPublicationRef, locale: "ru" | "en"): Record<string, unknown> {
  const now = new Date().toISOString();
  enqueueRepairSiteJob(db, ref, `refresh_${locale}_site`, now);
  return { ok: true, post_id: ref.postId, publication_key: ref.publicationKey, locale, site_refresh: true };
}

/** Media reaches Delivery either as a Content asset on disk or as a Telegram
 * file id; ingress converts file ids into assets, so requiring one here would
 * reject every item Studio itself produces. */
export function parseLocaleMedia(raw: string | undefined): Record<string, unknown>[] | null {
  if (!raw || ["none", "null", "ru", "fallback"].includes(raw.trim().toLowerCase())) return null;
  const parsed = JSON.parse(raw) as unknown;
  const items = Array.isArray(parsed) ? parsed : parsed && typeof parsed === "object" ? [parsed] : null;
  if (!items || items.some((item) => !item || typeof item !== "object" || !locatesMedia(item as Record<string, unknown>)))
    throw new Error("each media item needs file_id, local_path or asset_id");
  return items as Record<string, unknown>[];
}

function locatesMedia(item: Record<string, unknown>): boolean {
  return ["file_id", "fileId", "local_path", "localPath", "path", "asset_id"].some((key) => item[key] != null);
}

function enqueueRepairSiteJob(db: UnsafeBackendDb["db"], ref: ResolvedPublicationRef, reason: string, now: string): void {
  const activeJob = db
    .select({ jobId: siteJobs.jobId })
    .from(siteJobs)
    .where(
      and(eq(siteJobs.publicationKey, ref.publicationKey), eq(siteJobs.reason, reason), inArray(siteJobs.status, ["queued", "rendering"])),
    )
    .get();
  if (activeJob) return;

  db.insert(siteJobs)
    .values({
      publicationKey: ref.publicationKey,
      reason,
      status: "queued",
      nextAttemptAt: now,
      createdAt: now,
      updatedAt: now,
    })
    .run();
}
