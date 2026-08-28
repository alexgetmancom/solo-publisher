import { metricNumber } from "../../../analytics/snapshots/creator-store.js";
import { AUDIENCE_VIEWS, targetDefinition } from "../../../botTargets.js";
import { listChannels } from "../../../channels/registry.js";
import { type BackendDb, unsafeDb } from "../../../db/client.js";
import { creatorProfiles } from "../../../db/schema.js";
import { escapeHtml } from "../../../foundation/html.js";
import { type MessageKey, t } from "../../../foundation/i18n/index.js";
import type { StudioLocale } from "../../../foundation/locale.js";
import { ORDERED_TARGETS } from "./assets.js";
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

/** The value is the operation name, because the form posts to the same
 * dispatch the CLI and the MCP tools go through. The card used to speak its own
 * dialect -- `replace_media`, `use_other_media` -- which is how one of these
 * came to exist on the dashboard and nowhere else. */
const REPAIR_ACTIONS: [operation: string, key: MessageKey][] = [
  ["retry", "cc.repair.retry"],
  ["refresh-site", "cc.repair.refresh-site"],
  ["edit", "cc.repair.edit"],
  ["set-media", "cc.repair.replace-media"],
  ["use-other-media", "cc.repair.use-other-media"],
  ["delete", "cc.repair.delete"],
];

/** Named so the parity test can read them without re-deriving the markup. */
export function repairOperations(): string[] {
  return REPAIR_ACTIONS.map(([operation]) => operation);
}

/** The form authenticates through the HttpOnly `command_token` cookie; the
 * endpoint pairs that with a same-origin check, which is what actually stops a
 * cross-site POST from riding the session. */
export function renderRepairSection(ref: string, locale: StudioLocale): string {
  const options = ORDERED_TARGETS.map((target) => `<option value="${escapeHtml(target.id)}">${escapeHtml(target.label)}</option>`).join(
    "\n",
  );
  const actions = REPAIR_ACTIONS.map(([value, key]) => `<option value="${value}">${escapeHtml(t(locale, key))}</option>`).join("");
  return [
    "<section>",
    `<p class="note">${escapeHtml(t(locale, "cc.repair.note"))}</p>`,
    '<form method="post" action="/api/command-center/action">',
    `<select name="action">${actions}</select>`,
    `<select name="locale"><option value="">${t(locale, "cc.repair.both-locales")}</option><option value="ru">RU</option><option value="en">EN</option></select>`,
    `<input name="ref" placeholder="${t(locale, "cc.repair.ref-placeholder")}" value="${escapeHtml(ref)}">`,
    `<select name="target"><option value="">${t(locale, "cc.repair.all-targets")}</option>${options}</select>`,
    `<textarea name="text" placeholder="${t(locale, "cc.repair.text-placeholder")}"></textarea>`,
    `<textarea name="media_json" placeholder='${t(locale, "cc.repair.media-placeholder")}'></textarea>`,
    `<label><input type="checkbox" name="republish" value="1"> ${escapeHtml(t(locale, "cc.repair.republish-after-delete"))}</label>`,
    // The form is the deliberate surface: choosing an action and pressing Apply
    // is the confirmation the CLI and MCP spell as --apply.
    '<input type="hidden" name="apply" value="1">',
    `<button type="submit">${t(locale, "cc.repair.apply")}</button>`,
    "</form></section>",
  ].join("");
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
