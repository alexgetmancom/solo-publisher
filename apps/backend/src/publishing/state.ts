import { isSiteTarget, targetLocale } from "../botTargets.js";

const VIDEO_FINAL_TARGET_STATUSES = new Set(["published", "failed", "cancelled", "verification_required"]);
const POST_FINAL_JOB_STATUSES = new Set(["published", "failed", "cancelled", "skipped", "verification_required"]);
const VIDEO_EDITABLE_TARGET_STATUSES = new Set(["editing", "draft"]);
/** `failed` belongs here: nothing reached an audience, and the details are what
 * the platform refused. Without it a target rejected for its own metadata could
 * only be retried into the same rejection. */
const VIDEO_METADATA_EDITABLE_TARGET_STATUSES = new Set(["editing", "draft", "scheduled", "failed"]);
const VIDEO_SCHEDULABLE_TARGET_STATUSES = new Set(["editing", "draft", "scheduled"]);
const ACTIVE_PUBLICATION_JOB_STATUSES = new Set(["queued", "publishing", "rendering"]);
const POST_MUTABLE_STATUSES = new Set(["draft", "needs_review", "scheduled"]);
export const AUDIENCE_MUTATION_RETRYABLE_STATUSES = ["failed"] as const;

export function isVideoTargetFinal(status: string): boolean {
  return VIDEO_FINAL_TARGET_STATUSES.has(status);
}

export function isPostJobFinal(status: string): boolean {
  return POST_FINAL_JOB_STATUSES.has(status);
}

export function isVideoTargetEditable(status: string): boolean {
  return VIDEO_EDITABLE_TARGET_STATUSES.has(status);
}

/** Metadata remains mutable while a target is queued, but not once preparation
 * has started because some providers have already captured the caption. */
export function isVideoTargetMetadataEditable(status: string): boolean {
  return VIDEO_METADATA_EDITABLE_TARGET_STATUSES.has(status);
}

export function isVideoTargetSchedulable(status: string): boolean {
  return VIDEO_SCHEDULABLE_TARGET_STATUSES.has(status);
}

/** Post content and target selection remain mutable until publication is
 * settled. Scheduled posts are deliberately included so edits can replan the
 * unfinished delivery jobs. */
export function isPostDraftMutable(status: string): boolean {
  return POST_MUTABLE_STATUSES.has(status);
}

/** Failed provider mutations are safe to retry because the provider rejected
 * them. An ambiguous mutation is held for reconciliation: retrying it can put
 * the same publication in front of the audience twice. */
export function isAudienceMutationRetryable(status: string): status is "failed" {
  return AUDIENCE_MUTATION_RETRYABLE_STATUSES.some((retryable) => retryable === status);
}

/** Site verification is the exception: rendering the same page again replaces
 * one deterministic artifact, so an ambiguous verification cannot duplicate a
 * publication. */
export function isPostTargetRetryable(target: string, status: string): status is "failed" | "verification_required" {
  return isAudienceMutationRetryable(status) || (isSiteTarget(target) && status === "verification_required");
}

/** An empty status list is "nothing has happened yet", never success: `every`
 * on `[]` is vacuously true, which used to report a draft with no targets — or a
 * draft read before its jobs were created — as fully published. */
export function videoDraftStatus(targetStatuses: string[]): "scheduled" | "published" | "partial" {
  if (targetStatuses.length === 0) return "scheduled";
  if (!targetStatuses.every(isVideoTargetFinal)) return "scheduled";
  return targetStatuses.every((status) => status === "published") ? "published" : "partial";
}

export function publicationStatus(jobStatuses: string[]): "published" | "failed" | "cancelled" | null {
  if (jobStatuses.length === 0) return null;
  if (jobStatuses.some((status) => ACTIVE_PUBLICATION_JOB_STATUSES.has(status))) return null;
  if (jobStatuses.some((status) => status === "failed" || status === "verification_required")) return "failed";
  // Nothing reached an audience and nothing is left to try: a publication whose
  // every target was cancelled or abandoned is not a published one.
  return jobStatuses.every((status) => status === "cancelled") ? "cancelled" : "published";
}

/** A publication whose plan still has an enabled target in a locale with no date
 * is not finished, however its existing jobs settled: the operator has yet to say
 * when that locale goes out.
 *
 * Reconciliation applied this rule and the audit's mismatch scan did not, so the
 * audit reported every such post as a permanent mismatch, and `repair --apply`
 * closed it as published. The next settling job put it back, and when no further
 * job ever settled -- the usual case, since the pending locale has no job yet --
 * the wrong status simply stood. One function now, for both.
 *
 * "Enabled" here means enabled, connected, and not yet queued: a target that
 * already has a job is out of the operator's hands. */
export function effectivePublicationStatus(
  jobs: Array<{ target: string; status: string }>,
  plan: Record<string, unknown> | null,
  registeredTargets: Set<string>,
): "published" | "failed" | "scheduled" | "cancelled" | null {
  const status = publicationStatus(jobs.map((job) => job.status));
  if (!status) return null;
  const queued = new Set(jobs.map((job) => job.target));
  return status === "published" && hasPendingLocaleSchedule(plan, registeredTargets, queued) ? "scheduled" : status;
}

/** A target the Studio no longer publishes to cannot hold a publication open.
 * The queue screen has always read the plan through the channel registry and
 * this rule read the raw plan, so a plan naming a disconnected target showed as
 * finished in the interface and stayed `scheduled` in the data. */
function hasPendingLocaleSchedule(
  plan: Record<string, unknown> | null,
  registeredTargets: Set<string>,
  queuedTargets: Set<string>,
): boolean {
  if (plan?.mode !== "scheduled") return false;
  const targets = Object.fromEntries(
    Object.entries(planObject(plan.targets)).map(([target, enabled]) => [
      target,
      // A target that already has a delivery job is not waiting on a date: the
      // operator said when it goes out by queueing it, whatever the plan's
      // locale field still holds. Without this a publication delivered to every
      // enabled target stayed `scheduled` for good, and the audit reported it
      // as a mismatch that nothing could ever settle.
      Boolean(enabled) && registeredTargets.has(target) && !queuedTargets.has(target),
    ]),
  );
  return hasUnscheduledLocale(targets, planScheduleAt(plan, "ru"), planScheduleAt(plan, "en"));
}

/** An enabled target in a language the operator has not dated yet. Such a
 * publication is unfinished however its other jobs settled, and the queue and
 * the publication status must agree on that: they were two copies of this rule
 * and one of them ignored the channel registry.
 *
 * `targets` is expected to be registry-filtered already — an unconnected target
 * is not enabled. */
export function hasUnscheduledLocale(targets: Record<string, boolean>, ruAt: string | null, enAt: string | null): boolean {
  const enabledLocales = new Set(Object.entries(targets).flatMap(([target, enabled]) => (enabled ? (targetLocale(target) ?? []) : [])));
  return (enabledLocales.has("ru") && !ruAt) || (enabledLocales.has("en") && !enAt);
}

export function planScheduleAt(plan: Record<string, unknown>, locale: "ru" | "en"): string | null {
  const value = plan[locale === "en" ? "scheduled_en_at" : "scheduled_at"];
  return typeof value === "string" ? value : null;
}

export function planObject(value: unknown): Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
