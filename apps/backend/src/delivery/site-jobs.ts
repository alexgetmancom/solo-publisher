import crypto from "node:crypto";
import { and, asc, desc, eq, inArray, isNotNull, isNull, lt, lte, or } from "drizzle-orm";
import { parsePublicationRef, publicationRef } from "../application/publication-ref.js";
import { type BackendDb, type UnsafeBackendDb, unsafeDb } from "../db/client.js";
import { drafts, postLocales, publicationEvents, siteJobs } from "../db/schema.js";
import type { BackendConfig } from "../foundation/config.js";
import { withJobHeartbeat } from "../foundation/runtime/job-heartbeat.js";
import { recordWorkerState } from "../foundation/runtime/worker-state.js";
import { trackUsageAsync } from "../observability/usage.js";
import { invalidatePublicSiteFeed } from "../public/site-read-model.js";
import { nextRetryAt } from "../publishing/errors.js";
import type { PublicationSource } from "../publishing/publication-source.js";
import { refreshPublicationStatus } from "../publishing/publication-status.js";
import { workerId } from "../publishing/queue.js";
import { publicationSourceFromDb } from "../publishing/source-store.js";
import { publishContentIndex } from "./site-content-index.js";
import { pingIndexNow } from "./site-index-now.js";
import { materializeSiteMedia } from "./site-media.js";

export const SITE_JOB_RESTART_LOCK_GRACE_SECONDS = 30;
const SITE_JOB_CLAIM_LIMIT = 20;
const SITE_JOB_HEARTBEAT_INTERVAL_SECONDS = 60;
const SITE_JOB_LOCK_TIMEOUT_SECONDS = 900;
const SITE_JOB_MAX_ATTEMPTS = 5;
const SITE_JOB_BACKOFF_BASE_SECONDS = 60;
const SITE_JOB_BACKOFF_MAX_SECONDS = 900;

type SiteJob = {
  job_id: number;
  publication_key: string;
  message_id: number;
  attempt_count: number;
  lock_id: string;
};

export async function runSiteJobCycle(config: BackendConfig, backendDb: BackendDb): Promise<number> {
  recoverStaleSiteJobs(backendDb);
  const jobs = claimSiteJobs(backendDb);
  if (jobs.length === 0) {
    recordWorkerState(backendDb, "site", { claimed: 0 });
    return 0;
  }
  try {
    const failures = await withJobHeartbeat(
      SITE_JOB_HEARTBEAT_INTERVAL_SECONDS,
      () => {
        unsafeDb(backendDb)
          .db.update(siteJobs)
          .set({ lockedAt: new Date().toISOString() })
          .where(and(eq(siteJobs.status, "rendering"), eq(siteJobs.lockedBy, jobs[0]?.lock_id ?? "")))
          .run();
      },
      () =>
        trackUsageAsync(backendDb, "publishing.site.materialize", () =>
          materializeSitePosts(config, backendDb, fetch, new Set(jobs.map((job) => job.publication_key))),
        ),
    );
    // Only the jobs whose own publication failed carry its error; the rest
    // published, and their attempt budget is not spent on someone else's post.
    for (const [publicationKey, message] of failures)
      failSiteJobs(
        backendDb,
        jobs.filter((job) => job.publication_key === publicationKey),
        message,
      );
    const completed = completeSiteJobs(
      backendDb,
      jobs.filter((job) => !failures.has(job.publication_key)),
    );
    // A materialization is the one moment this process knows the published site
    // changed, so serve the new shape immediately instead of waiting out the TTL.
    invalidatePublicSiteFeed(backendDb);
    try {
      const urls = publishContentIndex(config, backendDb);
      // IndexNow is an external notification, not a prerequisite for serving
      // the already materialized feed through SSR.
      void pingIndexNow(config, urls).catch((error) => {
        insertSiteEvent(unsafeDb(backendDb).db, "site.indexnow.failed", "warn", String(error instanceof Error ? error.message : error), {
          urls,
        });
      });
    } catch (error) {
      insertSiteEvent(
        unsafeDb(backendDb).db,
        "site.index.build.failed",
        "warn",
        String(error instanceof Error ? error.message : error),
        {},
      );
    }
    recordWorkerState(backendDb, "site", { claimed: jobs.length, published: completed.length });
  } catch (error) {
    const failed = failSiteJobs(backendDb, jobs, error);
    recordWorkerState(
      backendDb,
      "site",
      { claimed: jobs.length, published: 0, failed: failed.length },
      error instanceof Error ? error.message : String(error),
    );
  }
  return jobs.length;
}

export function recoverStaleSiteJobs(backendDb: BackendDb, maxLockAgeSeconds = SITE_JOB_LOCK_TIMEOUT_SECONDS): number {
  const cutoff = new Date(Date.now() - maxLockAgeSeconds * 1000).toISOString();
  const now = new Date().toISOString();
  const stale = unsafeDb(backendDb)
    .db.select()
    .from(siteJobs)
    .where(and(eq(siteJobs.status, "rendering"), isNotNull(siteJobs.lockedAt), lt(siteJobs.lockedAt, cutoff)))
    .all();
  let recovered = 0;
  const terminalKeys = new Set<string>();
  unsafeDb(backendDb).db.transaction((tx) => {
    for (const job of stale) {
      if (!job.lockedAt) continue;
      const attempt = job.attemptCount + 1;
      const retry = attempt < SITE_JOB_MAX_ATTEMPTS;
      const updated = tx
        .update(siteJobs)
        .set({
          status: retry ? "queued" : "failed",
          lockedBy: null,
          lockedAt: null,
          nextAttemptAt: retry ? nextRetryAt(attempt, SITE_JOB_BACKOFF_BASE_SECONDS, SITE_JOB_BACKOFF_MAX_SECONDS) : null,
          updatedAt: now,
          attemptCount: attempt,
          lastError: job.lastError ?? "stale site lock recovered",
        })
        .where(and(eq(siteJobs.jobId, job.jobId), eq(siteJobs.status, "rendering"), eq(siteJobs.lockedAt, job.lockedAt)))
        .returning({ jobId: siteJobs.jobId })
        .get();
      if (!updated) continue;
      recovered += 1;
      if (!retry) terminalKeys.add(job.publicationKey);
    }
  });
  for (const publicationKey of terminalKeys)
    for (const postId of publicationPostId(publicationKey)) refreshPublicationStatus(backendDb, postId);
  return recovered;
}

/** Renders every requested publication and reports the ones that could not be.
 *
 * One `Promise.all` used to carry the whole batch: a single unreachable image
 * rejected it, and the cycle then failed all twenty claimed jobs with that one
 * post's error. Five cycles of that and every publication in the queue was
 * `failed` because of one of them. A publication that cannot render is its own
 * problem now. */
export async function materializeSitePosts(
  config: BackendConfig,
  backendDb: BackendDb,
  fetchImpl: typeof fetch = fetch,
  publicationKeys?: ReadonlySet<string>,
): Promise<Map<string, string>> {
  const sources = sourceItems(backendDb, publicationKeys);
  const failures = new Map<string, string>();
  // Rendering is the slow part, and the manifest written at the end of it was
  // decided before it started. Capture what the locales looked like going in so
  // the write can refuse to land on a source somebody has changed since.
  const sourceVersions = localeVersions(
    backendDb,
    sources.map((source) => source.draftId),
  );
  const prepared = await Promise.all(
    sources.map(async (source) => {
      try {
        return await prepareSiteMedia(config, source, fetchImpl);
      } catch (error) {
        failures.set(publicationRef("post", source.postId), error instanceof Error ? error.message : String(error));
        return null;
      }
    }),
  );
  const stale = persistMaterializedSiteMedia(
    backendDb,
    prepared.filter((item): item is PreparedSiteMedia => item != null),
    sourceVersions,
  );
  // A skipped write is not a rendered publication. Report it so the job retries
  // against the source that displaced it rather than reporting success over a
  // manifest that was never stored.
  for (const postId of stale) failures.set(publicationRef("post", postId), "site source changed while it was rendering");
  return failures;
}
type PreparedSiteMedia = {
  draftId: number;
  postId: number;
  locales: Record<"ru" | "en", { enabled: boolean; media: Record<string, unknown>[] }>;
};

/** Reads the version of every locale about to be rendered, so the write that
 * follows the render can be fenced on it. */
function localeVersions(backendDb: BackendDb, draftIds: number[]): Map<string, string> {
  if (draftIds.length === 0) return new Map();
  const rows = unsafeDb(backendDb)
    .db.select({ draftId: postLocales.draftId, locale: postLocales.locale, updatedAt: postLocales.updatedAt })
    .from(postLocales)
    .where(inArray(postLocales.draftId, draftIds))
    .all();
  return new Map(rows.map((row) => [`${row.draftId}:${row.locale}`, row.updatedAt]));
}

/** Stores the rendered manifests and returns the posts whose source moved while
 * they were rendering. */
function persistMaterializedSiteMedia(backendDb: BackendDb, items: PreparedSiteMedia[], versions: Map<string, string>): number[] {
  const now = new Date().toISOString();
  return unsafeDb(backendDb).db.transaction((tx) => {
    const stale: number[] = [];
    for (const item of items) {
      for (const locale of ["ru", "en"] as const) {
        const value = item.locales[locale];
        if (!value.enabled) continue;
        // Fenced on the version read before the render: an edit landing in that
        // window would otherwise be overwritten by the manifest of the media it
        // replaced, and the site would serve the old attachments until some
        // unrelated render happened to fix them.
        const version = versions.get(`${item.draftId}:${locale}`);
        const written = tx
          .update(postLocales)
          .set({ siteMediaJson: value.media, updatedAt: now })
          .where(
            and(
              eq(postLocales.draftId, item.draftId),
              eq(postLocales.locale, locale),
              version == null ? isNull(postLocales.updatedAt) : eq(postLocales.updatedAt, version),
            ),
          )
          .returning({ draftId: postLocales.draftId })
          .get();
        if (!written) stale.push(item.postId);
      }
    }
    return stale;
  });
}

function claimSiteJobs(backendDb: BackendDb): SiteJob[] {
  const now = new Date().toISOString();
  const lockId = `${workerId("site")}:${crypto.randomUUID()}`;
  const rows = unsafeDb(backendDb)
    .db.select()
    .from(siteJobs)
    .where(and(eq(siteJobs.status, "queued"), or(isNull(siteJobs.nextAttemptAt), lte(siteJobs.nextAttemptAt, now))))
    .orderBy(asc(siteJobs.createdAt), asc(siteJobs.jobId))
    .limit(SITE_JOB_CLAIM_LIMIT)
    .all();
  const claimed: SiteJob[] = [];
  unsafeDb(backendDb).db.transaction((tx) => {
    for (const row of rows) {
      const claimedRow = tx
        .update(siteJobs)
        .set({ status: "rendering", lockedBy: lockId, lockedAt: now, updatedAt: now })
        .where(and(eq(siteJobs.jobId, row.jobId), eq(siteJobs.status, "queued")))
        .returning({ jobId: siteJobs.jobId })
        .get();
      if (claimedRow) {
        claimed.push({
          job_id: row.jobId,
          publication_key: row.publicationKey,
          message_id: row.messageId,
          attempt_count: row.attemptCount,
          lock_id: lockId,
        });
      }
    }
    if (claimed.length > 0) {
      insertSiteEvent(tx, "site.build.claimed", "info", `claimed ${claimed.length} site build job(s)`, {
        job_ids: claimed.map((job) => job.job_id),
      });
    }
  });
  return claimed;
}

function completeSiteJobs(backendDb: BackendDb, jobs: SiteJob[]): SiteJob[] {
  const now = new Date().toISOString();
  const completed: SiteJob[] = [];
  unsafeDb(backendDb).db.transaction((tx) => {
    for (const job of jobs) {
      const updated = tx
        .update(siteJobs)
        .set({ status: "published", lockedBy: null, lockedAt: null, lastError: null, updatedAt: now })
        .where(and(eq(siteJobs.jobId, job.job_id), eq(siteJobs.status, "rendering"), eq(siteJobs.lockedBy, job.lock_id)))
        .returning({ jobId: siteJobs.jobId })
        .get();
      if (updated) completed.push(job);
    }
    if (completed.length > 0)
      insertSiteEvent(tx, "site.build.published", "info", `published ${completed.length} site build job(s)`, {
        job_ids: completed.map((job) => job.job_id),
      });
  });
  for (const postId of new Set(completed.flatMap((job) => publicationPostId(job.publication_key))))
    refreshPublicationStatus(backendDb, postId);
  return completed;
}

function failSiteJobs(backendDb: BackendDb, jobs: SiteJob[], error: unknown): SiteJob[] {
  const now = new Date().toISOString();
  const message = String(error instanceof Error ? error.message : error);
  const failed: SiteJob[] = [];
  unsafeDb(backendDb).db.transaction((tx) => {
    for (const job of jobs) {
      const attempt = Number(job.attempt_count ?? 0) + 1;
      const retry = attempt < SITE_JOB_MAX_ATTEMPTS;
      const updated = tx
        .update(siteJobs)
        .set({
          status: retry ? "queued" : "failed",
          attemptCount: attempt,
          nextAttemptAt: retry ? nextRetryAt(attempt, SITE_JOB_BACKOFF_BASE_SECONDS, SITE_JOB_BACKOFF_MAX_SECONDS) : null,
          lockedBy: null,
          lockedAt: null,
          lastError: message,
          updatedAt: now,
        })
        .where(and(eq(siteJobs.jobId, job.job_id), eq(siteJobs.status, "rendering"), eq(siteJobs.lockedBy, job.lock_id)))
        .returning({ jobId: siteJobs.jobId })
        .get();
      if (updated) failed.push(job);
    }
    if (failed.length > 0) insertSiteEvent(tx, "site.build.failed", "error", message, { job_ids: failed.map((job) => job.job_id) });
  });
  for (const postId of new Set(
    failed
      .filter((job) => Number(job.attempt_count ?? 0) + 1 >= SITE_JOB_MAX_ATTEMPTS)
      .flatMap((job) => publicationPostId(job.publication_key)),
  ))
    refreshPublicationStatus(backendDb, postId);
  return failed;
}

/** Loads only the publications asked for. Loading every published post and
 * filtering afterwards cost two queries per publication on every cycle, to
 * render the handful of jobs one batch had actually claimed. */
function sourceItems(backendDb: BackendDb, publicationKeys?: ReadonlySet<string>): PublicationSource[] {
  const localeStates = siteLocaleStates(backendDb, publicationKeys);
  const rows = unsafeDb(backendDb)
    .db.select({ postId: drafts.postId })
    .from(drafts)
    .where(
      publicationKeys
        ? and(isNotNull(drafts.postId), inArray(drafts.postId, [...publicationKeys].flatMap(publicationPostId)))
        : isNotNull(drafts.postId),
    )
    .orderBy(desc(drafts.postId))
    .all();
  return rows.flatMap((row): PublicationSource[] => {
    if (row.postId == null) return [];
    const source = publicationSourceFromDb(unsafeDb(backendDb).db, row.postId);
    const state = localeStates.get(publicationRef("post", row.postId));
    if (!state || state.seen.size === 0) return [source];
    return [
      {
        ...source,
        locales: {
          ru: { ...source.locales.ru, siteEnabled: state.active.has("ru") },
          en: { ...source.locales.en, siteEnabled: state.active.has("en") },
        },
      },
    ];
  });
}

type SiteLocaleState = { seen: Set<"ru" | "en">; active: Set<"ru" | "en"> };

function publicationPostId(publicationKey: string): number[] {
  const ref = parsePublicationRef(publicationKey);
  return ref?.kind === "post" ? [ref.id] : [];
}

/** Site publication state is the authority after a target is cancelled. */
function siteLocaleStates(backendDb: BackendDb, publicationKeys?: ReadonlySet<string>): Map<string, SiteLocaleState> {
  const states = new Map<string, SiteLocaleState>();
  const query = unsafeDb(backendDb)
    .db.select({ publicationKey: siteJobs.publicationKey, reason: siteJobs.reason, status: siteJobs.status })
    .from(siteJobs);
  const rows = publicationKeys ? query.where(inArray(siteJobs.publicationKey, [...publicationKeys])).all() : query.all();
  for (const row of rows) {
    const locale = row.reason.match(/(?:^|_)(ru|en)(?:_|$)/)?.[1];
    if (locale !== "ru" && locale !== "en") continue;
    const state = states.get(row.publicationKey) ?? { seen: new Set(), active: new Set() };
    state.seen.add(locale);
    if (["queued", "rendering", "published"].includes(row.status)) state.active.add(locale);
    states.set(row.publicationKey, state);
  }
  return states;
}

async function prepareSiteMedia(
  config: BackendConfig,
  source: PublicationSource,
  fetchImpl: typeof fetch,
): Promise<PreparedSiteMedia | null> {
  const postId = source.postId;
  const now = Date.now();
  const hasRu = source.locales.ru.siteEnabled && isDue(source.locales.ru.publishAt, now);
  const hasEn = source.locales.en.siteEnabled && isDue(source.locales.en.publishAt, now);
  if (!hasRu && !hasEn) return null;
  const mediaRuSource = source.locales.ru.siteMedia.length ? source.locales.ru.siteMedia : source.locales.ru.media;
  const mediaRu = hasRu ? await materializeSiteMedia(config, postId, "ru", mediaRuSource, fetchImpl) : [];
  const mediaEnSource = source.locales.en.siteMedia.length ? source.locales.en.siteMedia : source.locales.en.media;
  const mediaEn = hasEn ? await materializeSiteMedia(config, postId, "en", mediaEnSource, fetchImpl) : [];
  return {
    draftId: source.draftId,
    postId,
    locales: { ru: { enabled: hasRu, media: mediaRu }, en: { enabled: hasEn, media: mediaEn } },
  };
}

function isDue(value: unknown, now: number): boolean {
  if (typeof value !== "string" || !value) return true;
  const time = new Date(value).getTime();
  return Number.isNaN(time) || time <= now;
}

function insertSiteEvent(
  db: UnsafeBackendDb["db"],
  eventType: string,
  severity: string,
  message: string,
  details: Record<string, unknown>,
): void {
  db.insert(publicationEvents)
    .values({ eventType, severity, message, detailsJson: JSON.stringify(details), createdAt: new Date().toISOString() })
    .run();
}
