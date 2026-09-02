import type { TargetId } from "../../botTargets.js";
import { type ConnectPlatform, startConnect } from "../../channels/connect.js";
import { isPublishableVideoPlatform } from "../../channels/destinations.js";
import { type MetaOauthPlatform, metaOauthConnectPath, metaOauthConnectUrl } from "../../channels/meta-oauth.js";
import { type ChannelInput, listChannels, registerChannel, registerTargetChannel } from "../../channels/registry.js";
import { xOauthConnectPath, xOauthConnectUrl } from "../../channels/x-oauth.js";
import { type ZernioConnectionKey, type ZernioConnectionOption, zernioConnectionOptions } from "../../channels/zernio-connections.js";
import type { BackendDb } from "../../db/client.js";
import type { BackendConfig } from "../../foundation/config.js";
import { listZernioAccounts, type ZernioAccount, zernioAccount } from "../../foundation/external/zernio.js";
import { authCircuitStates } from "../../observability/auth-circuit.js";
import { capabilityReport } from "../../observability/capabilities.js";
import { trackUsageAsync, trackUsageSync } from "../../observability/usage.js";

export type StudioZernioAccount = ZernioAccount;

/** What a channel looks like to every surface that shows one. */
export type ChannelReport = {
  id: string;
  platform: string;
  locale: string;
  provider: string;
  providerAccountId: string | null;
  label: string;
  enabled: boolean;
  source: string;
  publishable: boolean;
  status: "ready" | "missing" | "disabled";
  missing: string[];
  /** What the publish path's breaker holds for this channel's credential.
   * `ready` describes what is stored; this describes whether it still works. */
  credential: {
    /** Publishing to this target is paused until the breaker closes. */
    blocked: boolean;
    blockedUntil: string | null;
    authFailureStreak: number;
    lastAuthFailureAt: string | null;
    tokenExpiresAt: string | null;
  };
};

const NO_CIRCUIT = {
  blocked: false,
  blockedUntil: null,
  authFailureStreak: 0,
  lastAuthFailureAt: null,
  tokenExpiresAt: null,
} as const;

/** Channel administration shared by Studio interfaces.
 *
 * Telegram renders the connection wizard, but it no longer owns channel
 * persistence, credential validation or provider discovery. Operations drives
 * the same service: two implementations of report/connect/disable is two
 * answers to "is this channel connected", and only one of them can be right.
 */
export function channelService(backendDb: BackendDb, config: BackendConfig, fetchImpl: typeof fetch = fetch) {
  return {
    list(enabledOnly = true) {
      return trackUsageSync(backendDb, "studio.channel.list", () => listChannels(backendDb, enabledOnly));
    },
    /** Credentials are only ever reported by name: an operator must be able to
     * see what a channel is missing without the report printing what it has. */
    report(enabledOnly = true): ChannelReport[] {
      return trackUsageSync(backendDb, "studio.channel.list", () => {
        const readiness = new Map(capabilityReport(config, backendDb).map((entry) => [entry.target, entry]));
        const circuits = new Map(authCircuitStates(backendDb).map((entry) => [entry.target, entry]));
        return listChannels(backendDb, enabledOnly).map((channel) => {
          const state = readiness.get(channel.targetId ?? channel.id);
          return {
            id: channel.id,
            platform: channel.platform,
            locale: channel.locale,
            provider: channel.provider,
            providerAccountId: channel.providerAccountId,
            label: channel.label,
            enabled: channel.enabled === 1,
            source: channel.source,
            // A text channel has no video target and is not expected to have one.
            publishable: channel.targetId ? true : isPublishableVideoPlatform(channel.platform),
            status: channel.enabled === 0 ? "disabled" : (state?.status ?? "ready"),
            missing: state?.missing ?? [],
            credential: (() => {
              const circuit = circuits.get(channel.targetId ?? channel.id);
              if (!circuit) return NO_CIRCUIT;
              const { target: _target, lastPingAt: _lastPingAt, ...rest } = circuit;
              return rest;
            })(),
          };
        });
      });
    },
    connect(input: Omit<ChannelInput, "source">, source = "interface") {
      return trackUsageSync(backendDb, "studio.channel.connect", () => registerChannel(backendDb, { ...input, source }));
    },
    connectTarget(targetId: TargetId, provider = "native", providerAccountId?: string, label?: string, source = "interface") {
      return trackUsageSync(backendDb, "studio.channel.connect", () =>
        registerTargetChannel(backendDb, targetId, {
          provider,
          ...(providerAccountId ? { providerAccountId } : {}),
          ...(label ? { label } : {}),
          source,
        }),
      );
    },
    disable(channelId: string) {
      return trackUsageSync(backendDb, "studio.channel.disable", () => {
        const channel = backendDb.channels.get(channelId);
        if (!channel) throw new Error(`Unknown channel: ${channelId}`);
        backendDb.channels.disable(channelId, new Date().toISOString());
        return channel;
      });
    },
    nativeConnectUrl(platform: MetaOauthPlatform, locale: "ru" | "en"): string | null {
      try {
        return metaOauthConnectUrl(config, platform, locale);
      } catch {
        return null;
      }
    },
    nativeConnectPath(platform: MetaOauthPlatform, locale: "ru" | "en"): string | null {
      try {
        return metaOauthConnectPath(config, platform, locale);
      } catch {
        return null;
      }
    },
    /** Starts a connection the way the CLI and the dashboard do. The bot needs
     * it for platforms whose flow is a code rather than a link. */
    startConnect(platform: ConnectPlatform, locale: "ru" | "en") {
      return startConnect(config, backendDb, platform, locale, fetchImpl);
    },
    xConnectUrl(): string | null {
      try {
        return xOauthConnectUrl(config);
      } catch {
        return null;
      }
    },
    xConnectPath(): string | null {
      try {
        return xOauthConnectPath(config);
      } catch {
        return null;
      }
    },
    async discoverZernioAccounts(): Promise<StudioZernioAccount[]> {
      return trackUsageAsync(backendDb, "studio.channel.discover", () => listZernioAccounts(config, fetchImpl));
    },
    async discoverZernioConnections(locale: "ru" | "en"): Promise<ZernioConnectionOption[]> {
      return trackUsageAsync(backendDb, "studio.channel.discover", async () =>
        (await listZernioAccounts(config, fetchImpl)).flatMap((account) => zernioConnectionOptions(account, locale)),
      );
    },
    async connectZernio(accountId: string, locale: "ru" | "en", key: ZernioConnectionKey) {
      return trackUsageAsync(backendDb, "studio.channel.connect", async () => {
        const account = await zernioAccount(config, accountId, fetchImpl);
        const option = zernioConnectionOptions(account, locale).find((candidate) => candidate.key === key);
        if (!option) throw new Error("Zernio account does not serve that publication route");
        return registerChannel(backendDb, { ...option.input, source: "interface" });
      });
    },
  };
}
