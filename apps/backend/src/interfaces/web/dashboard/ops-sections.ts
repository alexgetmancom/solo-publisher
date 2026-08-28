import { metricNumber } from "../../../analytics/snapshots/creator-store.js";
import { AUDIENCE_VIEWS, targetDefinition } from "../../../botTargets.js";
import { listChannels } from "../../../channels/registry.js";
import { type BackendDb, unsafeDb } from "../../../db/client.js";
import { creatorProfiles } from "../../../db/schema.js";
import { escapeHtml } from "../../../foundation/html.js";
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

export function renderQueueSection(ops: OpsPayload, locale: StudioLocale): string {
  const drafts =
    (ops.drafts ?? [])
      .map(
        (row) =>
          `<tr><td>${Number(row.id)}</td><td>${escapeHtml(row.status)}</td><td class="wide">${escapeHtml(shortPipelineText(row.textRu, 20))}</td><td>${escapeHtml(row.scheduledAt)}</td><td>${escapeHtml(row.scheduledEnAt)}</td><td>${escapeHtml(row.channelMessageId)}</td><td>${escapeHtml(row.updatedAt)}</td></tr>`,
      )
      .join("\n") || `<tr><td colspan='7'>${t(locale, "cc.queue.empty")}</td></tr>`;
  const jobs =
    (ops.jobs ?? [])
      .map(
        (row) =>
          `<tr><td>${escapeHtml(row.jobId)}</td><td>${escapeHtml(row.publicationKey)}</td><td>${escapeHtml(row.target)}</td><td>${escapeHtml(row.status)}</td><td>${Number(row.attemptCount ?? 0)}</td><td>${escapeHtml(row.publishAt)}</td><td>${escapeHtml(row.nextAttemptAt)}</td><td class="wide">${escapeHtml(row.lastError)}</td><td>${escapeHtml(row.updatedAt)}</td></tr>`,
      )
      .join("\n") || `<tr><td colspan='9'>${t(locale, "cc.queue.empty")}</td></tr>`;
  return `<section><h2>${t(locale, "cc.queue.drafts")}</h2><table><thead><tr><th>${t(locale, "cc.queue.id")}</th><th>${t(locale, "cc.queue.status")}</th><th>RU</th><th>${t(locale, "cc.queue.ru-slot")}</th><th>${t(locale, "cc.queue.en-slot")}</th><th>${t(locale, "cc.queue.message")}</th><th>${t(locale, "cc.queue.updated")}</th></tr></thead><tbody>${drafts}</tbody></table></section><section><h2>${t(locale, "cc.queue.queue")}</h2><table><thead><tr><th>${t(locale, "cc.queue.job")}</th><th>${t(locale, "cc.queue.post")}</th><th>${t(locale, "cc.queue.target")}</th><th>${t(locale, "cc.queue.status")}</th><th>${t(locale, "cc.queue.attempts")}</th><th>${t(locale, "cc.queue.publish-at")}</th><th>${t(locale, "cc.queue.retry-at")}</th><th>${t(locale, "cc.queue.error")}</th><th>${t(locale, "cc.queue.updated")}</th></tr></thead><tbody>${jobs}</tbody></table></section>`;
}

export function renderCredentialsSection(ops: OpsPayload, locale: StudioLocale): string {
  const rows =
    (ops.credentials ?? [])
      .map(
        (row) =>
          `<tr><td>${escapeHtml(row.target)}</td><td>${escapeHtml(row.status)}</td><td>${escapeHtml(row.missingEnvJson || row.lastError)}</td><td>${escapeHtml(row.lastCheckedAt)}</td></tr>`,
      )
      .join("\n") || `<tr><td colspan='4'>${t(locale, "cc.queue.empty")}</td></tr>`;
  return `<section><h2>${t(locale, "cc.health.credentials")}</h2><table><thead><tr><th>${t(locale, "cc.queue.target")}</th><th>${t(locale, "cc.queue.status")}</th><th>${t(locale, "cc.health.missing")}</th><th>${t(locale, "cc.health.checked")}</th></tr></thead><tbody>${rows}</tbody></table></section>`;
}

export function renderDiagnosticsSection(ops: OpsPayload, locale: StudioLocale): string {
  const errors =
    (ops.pipeline?.metrics?.recent ?? [])
      .filter((row) => row.error || row.status === "failed" || row.status === "verification_required")
      .slice(0, 30)
      .map(
        (row) =>
          `<tr><td>${escapeHtml(row.messageId)}</td><td>${escapeHtml(row.target)}</td><td>${escapeHtml(row.status ?? "failed")}</td><td class="wide">${escapeHtml(row.error)}</td></tr>`,
      )
      .join("\n") || `<tr><td colspan='4'>${t(locale, "cc.queue.empty")}</td></tr>`;
  return `<section><h2>${t(locale, "cc.health.errors")}</h2><table><thead><tr><th>${t(locale, "cc.queue.message")}</th><th>${t(locale, "cc.queue.target")}</th><th>${t(locale, "cc.queue.status")}</th><th>${t(locale, "cc.queue.error")}</th></tr></thead><tbody>${errors}</tbody></table></section>`;
}
