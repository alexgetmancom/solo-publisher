import { Menu, type MenuFlavor } from "@grammyjs/menu";
import type { Context } from "grammy";
import { directConnectTargets, TARGETS } from "../../botTargets.js";
import { META_PROVIDERS, type MetaOauthPlatform } from "../../channels/meta-providers.js";
import { listChannels, registeredPostTargetIds } from "../../channels/registry.js";
import { type ZernioConnectionOption, zernioConnectionOptions } from "../../channels/zernio-connections.js";
import type { BackendDb } from "../../db/client.js";
import type { BackendConfig } from "../../foundation/config.js";
import { describeError, t } from "../../foundation/i18n/index.js";
import type { StudioLocale } from "../../foundation/locale.js";
import { escapeMarkdown } from "../../foundation/markdown.js";
import { createStudioServices } from "../../studio/services/index.js";
import { settingsService } from "../../studio/services/settings.js";
import { clearConversationState } from "../conversation-state.js";
import {
  askSettingsInput,
  backToSettings,
  CHANNEL_CONNECT_MENU_ID,
  CHANNEL_DISABLE_MENU_ID,
  CHANNEL_MENU_ID,
  CHANNELS_MENU_ID,
  DEFAULT_TARGETS_MENU_ID,
  PUBLISHING_MENU_ID,
  settingsScreen,
  settingsUpdate,
  switchLabel,
  YOUTUBE_SIGNATURE_MENU_ID,
} from "./shared.js";

const discoveredAccounts = new Map<number, { locale: "ru" | "en"; options: ZernioConnectionOption[] }>();

/** Which channel's card the operator is looking at. The list and the card are
 * two screens over one collection, so the card has to be told which row opened
 * it; grammY menus carry no payload of their own. */
const openChannel = new Map<number, string>();

export function buildPublishingMenu(config: BackendConfig, backendDb: BackendDb): Menu<Context> {
  /** The channel list: one button per channel, two to a row, each carrying its
   * own state. The screen used to print every channel as a line of text and
   * then repeat all of them as full-width "Disable X" buttons -- the same
   * twelve names twice, with connecting, reconnecting and disabling stacked in
   * one column, so the most destructive action sat between two harmless ones. */
  const channels = new Menu<Context>(CHANNELS_MENU_ID, { autoAnswer: false }).dynamic((ctx, range) => {
    const actorId = Number(ctx.from?.id);
    const locale = settingsService(backendDb).locale(actorId);
    const report = createStudioServices(backendDb, config).channels.report();
    report.forEach((channel, index) => {
      range.submenu(
        `${channelGlyph(channel)} ${channel.label}`,
        CHANNEL_MENU_ID,
        settingsScreen(() => {
          openChannel.set(actorId, channel.id);
          return channelCardText(backendDb, config, locale, channel.id);
        }),
      );
      if (index % 2 === 1) range.row();
    });
    if (report.length % 2 === 1) range.row();
    range
      .submenu(
        t(locale, "settings.channels-connect"),
        CHANNEL_CONNECT_MENU_ID,
        settingsScreen(() => connectText(locale), true),
      )
      .row()
      .back(
        t(locale, "settings.back-to-publishing"),
        settingsUpdate({
          apply: () => openChannel.delete(actorId),
          body: () => t(locale, "settings.category-publishing-body"),
          plainText: true,
        }),
      );
  });

  const channelCard = new Menu<Context>(CHANNEL_MENU_ID, { autoAnswer: false }).dynamic((ctx, range) => {
    const actorId = Number(ctx.from?.id);
    const locale = settingsService(backendDb).locale(actorId);
    range
      .submenu(
        t(locale, "settings.disable-channel"),
        CHANNEL_DISABLE_MENU_ID,
        settingsScreen(() => disableConfirmText(backendDb, config, locale, openChannel.get(actorId)), true),
      )
      .row()
      .back(
        t(locale, "settings.back-to-channels"),
        settingsScreen(() => channelsText(backendDb, config, locale), true),
      );
  });

  /** Disabling takes a channel out of every future publication, and the button
   * for it used to be one tap away from the buttons that merely reconnect one.
   * A miss there is not recoverable from this screen. */
  const channelDisable = new Menu<Context>(CHANNEL_DISABLE_MENU_ID, { autoAnswer: false }).dynamic((ctx, range) => {
    const actorId = Number(ctx.from?.id);
    const locale = settingsService(backendDb).locale(actorId);
    range
      // Two levels up, not one: the card it came from is about to describe a
      // channel that no longer exists.
      .text(t(locale, "settings.disable-channel-yes"), async (ctx: Context & MenuFlavor) => {
        const channelId = openChannel.get(actorId);
        if (channelId) createStudioServices(backendDb, config).channels.disable(channelId);
        openChannel.delete(actorId);
        await ctx.answerCallbackQuery({ text: t(locale, "settings.channel-disabled") });
        await ctx.editMessageText(channelsText(backendDb, config, locale));
        ctx.menu.nav(CHANNELS_MENU_ID);
      })
      .row()
      .back(
        t(locale, "common.cancel"),
        settingsScreen(() => channelCardText(backendDb, config, locale, openChannel.get(actorId))),
      );
  });

  const channelConnect = new Menu<Context>(CHANNEL_CONNECT_MENU_ID, { autoAnswer: false }).dynamic((ctx, range) => {
    const actorId = Number(ctx.from?.id);
    const locale = settingsService(backendDb).locale(actorId);
    const studioChannels = createStudioServices(backendDb, config).channels;
    const discovered = discoveredAccounts.get(actorId);
    if (discovered) {
      for (const option of discovered.options) {
        range
          .text(option.label, async (ctx) => {
            await studioChannels.connectZernio(option.accountId, discovered.locale, option.key);
            discoveredAccounts.delete(actorId);
            await ctx.answerCallbackQuery({ text: t(locale, "settings.channel-connected") });
            await ctx.editMessageText(connectText(locale));
          })
          .row();
      }
    }
    for (const platform of Object.keys(META_PROVIDERS) as MetaOauthPlatform[]) {
      const ru = studioChannels.nativeConnectUrl(platform, "ru");
      const en = studioChannels.nativeConnectUrl(platform, "en");
      if (ru) range.url(t(locale, "settings.connect-native", { platform: channelPlatformLabel(platform), locale: "RU" }), ru);
      if (en) range.url(t(locale, "settings.connect-native", { platform: channelPlatformLabel(platform), locale: "EN" }), en);
      if (ru || en) range.row();
    }
    const xUrl = studioChannels.xConnectUrl();
    if (xUrl) range.url(t(locale, "settings.connect-native", { platform: "X", locale: "EN" }), xUrl).row();
    for (const channelLocale of ["ru", "en"] as const)
      range.text(t(locale, "settings.connect-native", { platform: "YouTube", locale: channelLocale.toUpperCase() }), async (ctx) => {
        try {
          const started = await studioChannels.startConnect("youtube", channelLocale);
          if (started.kind !== "device") throw new Error("YouTube is expected to answer with a code");
          await ctx.answerCallbackQuery();
          await ctx.editMessageText(
            t(locale, "settings.device-code", {
              url: started.verificationUrl,
              code: started.userCode,
              minutes: Math.round(started.expiresInSeconds / 60),
            }),
          );
        } catch (error) {
          await ctx.answerCallbackQuery({ text: describeError(locale, error).slice(0, 190), show_alert: true });
        }
      });
    range.row();
    const connectedIds = new Set(studioChannels.list().map(({ id }) => id));
    for (const target of directConnectTargets().filter(({ id }) => !connectedIds.has(id)))
      range
        .text(
          t(locale, "settings.enable-target", { target: target.label }),
          settingsUpdate({
            apply: () => studioChannels.connectTarget(target.id),
            body: () => connectText(locale),
            toast: t(locale, "settings.channel-connected"),
            plainText: true,
          }),
        )
        .row();
    if (config.ZERNIO_API_KEY)
      range
        .text("➕ Zernio · RU", (ctx) => discoverZernio(ctx, actorId, "ru", locale))
        .text("➕ Zernio · EN", (ctx) => discoverZernio(ctx, actorId, "en", locale))
        .row();
    range.back(
      t(locale, "settings.back-to-channels"),
      settingsUpdate({
        apply: () => discoveredAccounts.delete(actorId),
        body: () => channelsText(backendDb, config, locale),
        plainText: true,
      }),
    );
  });

  const defaultTargets = new Menu<Context>(DEFAULT_TARGETS_MENU_ID, { autoAnswer: false }).dynamic((ctx, range) => {
    const actorId = Number(ctx.from?.id);
    const locale = settingsService(backendDb).locale(actorId);
    const studioSettings = createStudioServices(backendDb, config).settings;
    const selected = studioSettings.defaultTargets();
    const rows = connectedTargets(backendDb);
    rows.forEach(({ id, label }, index) => {
      range.text(
        switchLabel(Boolean(selected[id]), label),
        settingsUpdate({ apply: () => studioSettings.toggleDefaultTarget(id), body: () => defaultTargetsText(backendDb, config, locale) }),
      );
      if (index % 2 === 1) range.row();
    });
    if (rows.length % 2 === 1) range.row();
    range.back(
      t(locale, "settings.back-to-publishing"),
      settingsScreen(() => t(locale, "settings.category-publishing-body"), true),
    );
  });

  const youtubeSignature = new Menu<Context>(YOUTUBE_SIGNATURE_MENU_ID, { autoAnswer: false }).dynamic((ctx, range) => {
    const actorId = Number(ctx.from?.id);
    const locale = settingsService(backendDb).locale(actorId);
    range
      .text(t(locale, "settings.edit"), (ctx) =>
        askSettingsInput(ctx, backendDb, actorId, "youtube_signature", youtubeSignature, t(locale, "settings.youtube-edit-prompt")),
      )
      .text(
        t(locale, "settings.clear"),
        settingsUpdate({
          apply: () => createStudioServices(backendDb, config).settings.clearYoutubeSignature(),
          body: () => youtubeSignatureText(backendDb, config, locale),
          toast: t(locale, "settings.cleared"),
        }),
      )
      .row()
      .back(
        t(locale, "settings.back-to-publishing"),
        settingsUpdate({
          apply: () => clearConversationState(backendDb, actorId, "settings"),
          body: () => t(locale, "settings.category-publishing-body"),
          plainText: true,
        }),
      );
  });

  const publishing = new Menu<Context>(PUBLISHING_MENU_ID, { autoAnswer: false }).dynamic((ctx, range) => {
    const actorId = Number(ctx.from?.id);
    const locale = settingsService(backendDb).locale(actorId);
    range
      .submenu(
        t(locale, "settings.channels"),
        CHANNELS_MENU_ID,
        settingsScreen(() => channelsText(backendDb, config, locale), true),
      )
      .submenu(
        t(locale, "settings.default-targets"),
        DEFAULT_TARGETS_MENU_ID,
        settingsScreen(() => defaultTargetsText(backendDb, config, locale)),
      )
      .row();
    if (listChannels(backendDb).some((channel) => channel.platform === "youtube"))
      range
        .submenu(
          t(locale, "settings.youtube-signature"),
          YOUTUBE_SIGNATURE_MENU_ID,
          settingsScreen(() => youtubeSignatureText(backendDb, config, locale)),
        )
        .row();
    range.back(t(locale, "settings.back-to-settings"), backToSettings(backendDb));
  });
  channels.register(channelCard);
  channelCard.register(channelDisable);
  channels.register(channelConnect);
  publishing.register(channels);
  publishing.register(defaultTargets);
  publishing.register(youtubeSignature);
  return publishing;

  async function discoverZernio(ctx: Context & MenuFlavor, actorId: number, channelLocale: "ru" | "en", locale: StudioLocale) {
    try {
      const studioChannels = createStudioServices(backendDb, config).channels;
      const accounts = await studioChannels.discoverZernioAccounts();
      const options = accounts.flatMap((account) => zernioConnectionOptions(account, channelLocale));
      discoveredAccounts.set(actorId, { locale: channelLocale, options });
      const supportedAccounts = new Set(options.map(({ accountId }) => accountId));
      await ctx.answerCallbackQuery({ text: t(locale, "settings.channels-found", { count: options.length }) });
      await ctx.editMessageText(connectText(locale, options.length, accounts.length - supportedAccounts.size));
      await ctx.menu.update();
    } catch {
      await ctx.answerCallbackQuery({ text: t(locale, "settings.channels-error"), show_alert: true });
    }
  }
}

export async function collectYoutubeSignature(
  ctx: Context,
  backendDb: BackendDb,
  config: BackendConfig,
  actorId: number,
  text: string,
  settingsMenu: Menu<Context>,
): Promise<boolean> {
  createStudioServices(backendDb, config).settings.setYoutubeSignature(text);
  const locale = settingsService(backendDb).locale(actorId);
  await ctx.reply(t(locale, "settings.youtube-saved"));
  await ctx.reply(youtubeSignatureText(backendDb, config, locale), {
    parse_mode: "Markdown",
    reply_markup: settingsMenu.at(YOUTUBE_SIGNATURE_MENU_ID),
  });
  return true;
}

function channelPlatformLabel(platform: string): string {
  if (platform === "tiktok") return "TikTok";
  if (platform === "youtube") return "YouTube";
  if (platform === "threads") return "Threads";
  return "Instagram";
}

function channelsText(backendDb: BackendDb, config: BackendConfig, locale: StudioLocale): string {
  const report = createStudioServices(backendDb, config).channels.report();
  if (!report.length) return `${t(locale, "settings.channels-title")}\n\n${t(locale, "settings.channels-none")}`;
  return `${t(locale, "settings.channels-title")}\n\n${t(locale, "settings.channels-count", { count: report.length })}`;
}

/** One channel, in full: the details the list used to repeat for all of them. */
function channelCardText(backendDb: BackendDb, config: BackendConfig, locale: StudioLocale, channelId: string | undefined): string {
  const channel = createStudioServices(backendDb, config)
    .channels.report()
    .find((candidate) => candidate.id === channelId);
  if (!channel) return `${t(locale, "settings.channels-title")}\n\n${t(locale, "settings.channels-none")}`;
  return t(locale, "settings.channel-card", {
    status: channelGlyph(channel),
    label: escapeMarkdown(channel.label),
    provider: escapeMarkdown(channel.provider),
    account: escapeMarkdown(channel.providerAccountId ?? t(locale, "settings.channel-account-none")),
    state: escapeMarkdown(channelState(locale, channel)),
  });
}

function disableConfirmText(backendDb: BackendDb, config: BackendConfig, locale: StudioLocale, channelId: string | undefined): string {
  const channel = createStudioServices(backendDb, config)
    .channels.report()
    .find((candidate) => candidate.id === channelId);
  return t(locale, "settings.disable-channel-confirm", { target: channel?.label ?? "" });
}

function connectText(locale: StudioLocale, discoveredCount?: number, hiddenCount = 0): string {
  const suffix = discoveredCount == null ? "" : `\n\n${t(locale, "settings.channels-pick", { count: discoveredCount })}`;
  const hidden = hiddenCount ? `\n${t(locale, "settings.channels-unsupported", { count: hiddenCount })}` : "";
  return `${t(locale, "settings.channels-connect")}${suffix}${hidden}`;
}

/** A channel's state as one character, so the list reads down its left edge. */
function channelGlyph(channel: { status: string }): string {
  if (channel.status === "ready") return "✅";
  return channel.status === "disabled" ? "⏸" : "⚠️";
}

function channelState(locale: StudioLocale, channel: { status: string; missing: string[] }): string {
  return t(locale, channel.status === "ready" ? "settings.channel-ready" : "settings.channel-missing", { count: channel.missing.length });
}

function connectedTargets(backendDb: BackendDb): (typeof TARGETS)[number][] {
  const registered = registeredPostTargetIds(backendDb);
  return TARGETS.filter(({ id }) => registered.has(id));
}

function defaultTargetsText(backendDb: BackendDb, config: BackendConfig, locale: StudioLocale): string {
  const selected = createStudioServices(backendDb, config).settings.defaultTargets();
  const active = connectedTargets(backendDb)
    .filter(({ id }) => selected[id])
    .map(({ label }) => label)
    .join(", ");
  return `${t(locale, "settings.default-targets-title")}\n\n${t(locale, "settings.default-targets-active")}: *${escapeMarkdown(active || t(locale, "settings.default-targets-none"))}*\n\n${t(locale, "settings.default-targets-hint")}`;
}

function youtubeSignatureText(backendDb: BackendDb, config: BackendConfig, locale: StudioLocale): string {
  const signature = createStudioServices(backendDb, config).settings.youtubeSignature();
  return t(locale, "settings.youtube-body", {
    signature: signature ? escapeMarkdown(signature) : t(locale, "settings.youtube-not-set"),
  });
}
