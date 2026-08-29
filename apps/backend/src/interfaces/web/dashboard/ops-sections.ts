import { metricNumber } from "../../../analytics/snapshots/creator-store.js";
import { AUDIENCE_VIEWS, targetDefinition } from "../../../botTargets.js";
import { listChannels } from "../../../channels/registry.js";
import { type BackendDb, unsafeDb } from "../../../db/client.js";
import { creatorProfiles } from "../../../db/schema.js";
import { type Html, html } from "../../../foundation/html.js";
import { t } from "../../../foundation/i18n/index.js";
import type { StudioLocale } from "../../../foundation/locale.js";
import { shortPipelineText } from "./format.js";
import type { OpsPayload } from "./types.js";

type AudiencePlatform = { key: string; label: string; metricTarget: string };

/** The catalogue is a presentation projection over platform profiles and the
 * generic metric ledger. A missing value stays visible as —: it must never
 * erase a connected publishing target from the operator's view. */
const AUDIENCE_PLATFORMS: AudiencePlatform[] = AUDIENCE_VIEWS.map((key) => ({
  key,
  label: key === "x" ? "X" : (targetDefinition(key)?.label ?? key),
  metricTarget: key,
}));

/** The follower counts alone, for callers that lay the platforms out
 * themselves — the unified overview pairs them with this period's reach. */
export function audiencePlatformFollowers(backendDb: BackendDb): Array<{ key: string; label: string; followers: number | null }> {
  const platforms = activeAudiencePlatforms(backendDb);
  const profiles = new Map(
    unsafeDb(backendDb)
      .db.select()
      .from(creatorProfiles)
      .all()
      .map((profile) => [profile.platform, profile.dataJson]),
  );
  return platforms.map((platform) => {
    const data = (profiles.get(platform.key) ?? {}) as Record<string, unknown>;
    const followers = metricNumber(data.subscriberCount ?? data.followersCount);
    return { key: platform.key, label: platform.label, followers: followers > 0 ? followers : null };
  });
}

function activeAudiencePlatforms(backendDb: BackendDb): AudiencePlatform[] {
  const registeredTargets = new Set(
    listChannels(backendDb)
      .map((channel) => channel.targetId)
      .filter(Boolean),
  );
  return AUDIENCE_PLATFORMS.filter((platform) => registeredTargets.has(platform.metricTarget));
}

export function renderQueueSection(ops: OpsPayload, locale: StudioLocale): Html {
  const drafts = (ops.drafts ?? []).map(
    (row) =>
      html`<tr><td>${Number(row.id)}</td><td>${row.status}</td><td class="wide">${shortPipelineText(row.textRu, 20)}</td><td>${row.scheduledAt}</td><td>${row.scheduledEnAt}</td><td>${row.channelMessageId}</td><td>${row.updatedAt}</td></tr>`,
  );
  const jobs = (ops.jobs ?? []).map(
    (row) =>
      html`<tr><td>${row.jobId}</td><td>${row.publicationKey}</td><td>${row.target}</td><td>${row.status}</td><td>${Number(row.attemptCount ?? 0)}</td><td>${row.publishAt}</td><td>${row.nextAttemptAt}</td><td class="wide">${row.lastError}</td><td>${row.updatedAt}</td></tr>`,
  );
  return html`<section><h2>${t(locale, "cc.queue.drafts")}</h2><table><thead><tr><th>${t(locale, "cc.queue.id")}</th><th>${t(locale, "cc.queue.status")}</th><th>RU</th><th>${t(locale, "cc.queue.ru-slot")}</th><th>${t(locale, "cc.queue.en-slot")}</th><th>${t(locale, "cc.queue.message")}</th><th>${t(locale, "cc.queue.updated")}</th></tr></thead><tbody>${orEmpty(drafts, 7, locale)}</tbody></table></section><section><h2>${t(locale, "cc.queue.queue")}</h2><table><thead><tr><th>${t(locale, "cc.queue.job")}</th><th>${t(locale, "cc.queue.post")}</th><th>${t(locale, "cc.queue.target")}</th><th>${t(locale, "cc.queue.status")}</th><th>${t(locale, "cc.queue.attempts")}</th><th>${t(locale, "cc.queue.publish-at")}</th><th>${t(locale, "cc.queue.retry-at")}</th><th>${t(locale, "cc.queue.error")}</th><th>${t(locale, "cc.queue.updated")}</th></tr></thead><tbody>${orEmpty(jobs, 9, locale)}</tbody></table></section>`;
}

export function renderCredentialsSection(ops: OpsPayload, locale: StudioLocale): Html {
  const rows = (ops.credentials ?? []).map(
    (row) =>
      html`<tr><td>${row.target}</td><td>${row.status}</td><td>${row.missingEnvJson || row.lastError}</td><td>${row.lastCheckedAt}</td></tr>`,
  );
  return html`<section><h2>${t(locale, "cc.health.credentials")}</h2><table><thead><tr><th>${t(locale, "cc.queue.target")}</th><th>${t(locale, "cc.queue.status")}</th><th>${t(locale, "cc.health.missing")}</th><th>${t(locale, "cc.health.checked")}</th></tr></thead><tbody>${orEmpty(rows, 4, locale)}</tbody></table></section>`;
}

export function renderDiagnosticsSection(ops: OpsPayload, locale: StudioLocale): Html {
  const errors = (ops.pipeline?.metrics?.recent ?? [])
    .filter((row) => row.error || row.status === "failed" || row.status === "verification_required")
    .slice(0, 30)
    .map(
      (row) =>
        html`<tr><td>${row.messageId}</td><td>${row.target}</td><td>${row.status ?? "failed"}</td><td class="wide">${row.error}</td></tr>`,
    );
  return html`<section><h2>${t(locale, "cc.health.errors")}</h2><table><thead><tr><th>${t(locale, "cc.queue.message")}</th><th>${t(locale, "cc.queue.target")}</th><th>${t(locale, "cc.queue.status")}</th><th>${t(locale, "cc.queue.error")}</th></tr></thead><tbody>${orEmpty(errors, 4, locale)}</tbody></table></section>`;
}

/** A table with nothing in it says so, across its own width. */
function orEmpty(rows: readonly Html[], columns: number, locale: StudioLocale): Html {
  return rows.length ? html`${rows}` : html`<tr><td colspan="${columns}">${t(locale, "cc.queue.empty")}</td></tr>`;
}
