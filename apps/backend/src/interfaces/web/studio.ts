import { directConnectTargets } from "../../botTargets.js";
import type { BackendDb } from "../../db/client.js";
import type { BackendConfig } from "../../foundation/config.js";
import { type Html, html, raw } from "../../foundation/html.js";
import { t } from "../../foundation/i18n/index.js";
import type { StudioLocale } from "../../foundation/locale.js";
import { formatZonedDateTime } from "../../foundation/time.js";
import { createStudioServices } from "../../studio/services/index.js";
import { localeQuery, renderLocaleSwitcher } from "./dashboard/locale-links.js";

/**
 * Studio section of the Command Center: a second adapter over the same
 * createStudioServices Telegram and MCP use. Business logic stays in those
 * services; this module only renders their results.
 */
export function renderStudioSection(config: BackendConfig, backendDb: BackendDb, actorId: number | null, locale: StudioLocale): Html {
  const services = createStudioServices(backendDb, config);
  const channels = services.channels;
  const analytics = services.analytics.dashboard("overview", 7, locale);
  const queue = actorId ? services.queue.snapshot(actorId) : null;
  const zone = { timeZone: config.TIMEZONE, label: config.TIMEZONE_LABEL };
  return html`
    <nav class="studio-toolbar">${renderLocaleSwitcher(locale, (target) => `/command-center?tab=studio${localeQuery(target)}`)}</nav>
    ${renderChannels(channels, config, locale)}
    <section class="studio-analytics">${raw(analytics.richHtml)}</section>
    ${
      queue
        ? html`<section>
      <h2>${t(locale, "cc.studio.queue")}</h2>
      ${renderQueueTable(t(locale, "cc.studio.upcoming"), queue.upcoming, zone, locale)}
      ${renderQueueTable(t(locale, "cc.studio.drafts"), queue.drafts, zone, locale)}
      ${renderAttention(queue.attention, locale)}
    </section>`
        : html`<section class="studio-owner-missing"><h2>${t(locale, "cc.studio.authoring")}</h2><p class="note">${t(locale, "cc.studio.authoring-missing")}</p></section>`
    }`;
}

export function renderStudioOnboarding(config: BackendConfig, connectedChannelCount: number, locale: StudioLocale): Html {
  const telegramReady = Boolean(config.controllerBotToken && config.CONTROLLER_ADMIN_IDS.length);
  const mcpReady = Boolean(config.MCP_STUDIO_TOKEN && config.MCP_STUDIO_ACTOR_ID);
  const authoringReady = telegramReady || mcpReady;
  const authoring = telegramReady && mcpReady ? "Telegram + MCP" : telegramReady ? "Telegram" : mcpReady ? "MCP" : null;
  const ops = "docker compose exec app bun /app/ops/cli.js";
  const siteTarget = locale === "ru" ? "site_ru" : "site_en";
  return html`<section class="first-run">
    <div class="first-run__intro"><span class="first-run__eyebrow">${t(locale, "cc.first-run.eyebrow")}</span><h1>${t(locale, "cc.first-run.title")}</h1><p>${t(locale, "cc.first-run.body")}</p></div>
    <ol class="first-run__steps">
      <li class="first-run__step${authoringReady ? " first-run__step--done" : ""}"><span class="first-run__number">${authoringReady ? "✓" : "1"}</span><div><h2>${t(locale, "cc.first-run.authoring-title")}</h2><p>${authoring ? t(locale, "cc.first-run.authoring-ready", { interface: authoring }) : t(locale, "cc.first-run.authoring-body")}</p>${authoring ? "" : html`<code>CONTROLLER_BOT_TOKEN=… &nbsp; CONTROLLER_ADMIN_IDS=…</code><span class="first-run__or">${t(locale, "cc.first-run.or")}</span><code>MCP_STUDIO_TOKEN=… &nbsp; MCP_STUDIO_ACTOR_ID=…</code>`}</div></li>
      <li class="first-run__step${connectedChannelCount ? " first-run__step--done" : ""}"><span class="first-run__number">${connectedChannelCount ? "✓" : "2"}</span><div><h2>${t(locale, "cc.first-run.channel-title")}</h2><p>${connectedChannelCount ? t(locale, "cc.first-run.channel-ready", { count: connectedChannelCount }) : t(locale, "cc.first-run.channel-body")}</p><a class="first-run__action" href="/command-center?tab=studio">${t(locale, "cc.first-run.channel-action")}</a></div></li>
      <li class="first-run__step"><span class="first-run__number">3</span><div><h2>${t(locale, "cc.first-run.draft-title")}</h2><p>${t(locale, "cc.first-run.draft-body")}</p></div></li>
    </ol>
    <aside class="first-run__optional"><strong>${t(locale, "cc.first-run.site-title")}</strong><span>${t(locale, "cc.first-run.site-body")}</span><code>${ops} studio-profile-set --site-enabled<br />${ops} channel-connect --target ${siteTarget}</code></aside>
  </section>`;
}

function renderChannels(channels: ReturnType<typeof createStudioServices>["channels"], config: BackendConfig, locale: StudioLocale): Html {
  const channelRows = channels.report();
  const connectedIds = new Set(channelRows.map(({ id }) => id));
  const connected = channelRows.map(
    (channel) =>
      html`<li>${channel.label} — ${channel.provider} · ${t(locale, channel.status === "ready" ? "cc.studio.channel-ready" : "cc.studio.channel-missing", { count: channel.missing.length })}<form method="post" action="/command-center/channels/disable"><input type="hidden" name="channel" value="${channel.id}"><button class="period-quick-link" type="submit">${t(locale, "cc.studio.disable-channel")}</button></form></li>`,
  );
  const metaButtons = (["threads", "instagram"] as const).flatMap((platform) =>
    (["ru", "en"] as const).flatMap((targetLocale) => {
      const url = channels.nativeConnectPath(platform, targetLocale);
      return url
        ? [
            html`<a class="period-quick-link" href="${url}">${t(locale, "cc.studio.connect-native", { platform: platform === "threads" ? "Threads" : "Instagram", locale: targetLocale.toUpperCase() })}</a>`,
          ]
        : [];
    }),
  );
  const xUrl = channels.xConnectPath();
  const directButtons = directConnectTargets()
    .filter(({ id }) => !connectedIds.has(id))
    .map(
      ({ id, label }) =>
        html`<form method="post" action="/command-center/channels/connect"><input type="hidden" name="target" value="${id}"><button class="period-quick-link" type="submit">${t(locale, "cc.studio.enable-target", { target: label })}</button></form>`,
    );
  const youtubeButtons = (["ru", "en"] as const)
    .filter((targetLocale) => !connectedIds.has(`youtube_${targetLocale}`))
    .map(
      (targetLocale) =>
        html`<form method="post" action="/command-center/channels/connect"><input type="hidden" name="platform" value="youtube"><input type="hidden" name="locale" value="${targetLocale}"><button class="period-quick-link" type="submit">${t(locale, "cc.studio.connect-native", { platform: "YouTube", locale: targetLocale.toUpperCase() })}</button></form>`,
    );
  const buttons = [
    ...metaButtons,
    ...(xUrl
      ? [html`<a class="period-quick-link" href="${xUrl}">${t(locale, "cc.studio.connect-native", { platform: "X", locale: "EN" })}</a>`]
      : []),
    ...youtubeButtons,
    ...directButtons,
    ...(config.ZERNIO_API_KEY
      ? [
          html`<a class="period-quick-link" href="/command-center/channels/zernio?locale=ru">Zernio RU</a><a class="period-quick-link" href="/command-center/channels/zernio?locale=en">Zernio EN</a>`,
        ]
      : []),
  ];
  return html`<section><h2>${t(locale, "cc.studio.channels")}</h2>${connected.length ? html`<ul>${connected}</ul>` : html`<p class="note">${t(locale, "settings.channels-none")}</p>`}${buttons.length ? html`<nav class="studio-toolbar studio-toolbar--wrap">${buttons}</nav>` : html`<p class="note">${t(locale, "cc.studio.native-unconfigured")}</p>`}</section>`;
}

type QueueItem = { id: number; label: string; time: Date; kind: "post" | "video"; targets: number };
type AttentionItem = { id: number; label: string; kind: "post" | "video" };

function renderQueueTable(title: string, items: QueueItem[], zone: { timeZone: string; label: string }, locale: StudioLocale): Html {
  if (!items.length) return html`<h3>${title}</h3><p class="note">${t(locale, "cc.studio.empty")}</p>`;
  const rows = items.map(
    (item) =>
      html`<tr><td>${item.label}</td><td>${item.kind}</td><td>${item.targets}</td><td class="nowrap">${formatZonedDateTime(item.time, zone.timeZone, zone.label)}</td></tr>`,
  );
  return html`<h3>${title}</h3><table><thead><tr><th>${t(locale, "cc.studio.name")}</th><th>${t(locale, "cc.studio.type")}</th><th>${t(locale, "cc.studio.platforms")}</th><th>${t(locale, "cc.studio.time")}</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function renderAttention(items: AttentionItem[], locale: StudioLocale): Html {
  if (!items.length) return html``;
  const rows = items.map((item) => html`<li>${item.kind === "video" ? "🎬" : "📝"} ${item.label}</li>`);
  return html`<h3>${t(locale, "cc.studio.attention")}</h3><ul class="attention-list">${rows}</ul>`;
}
