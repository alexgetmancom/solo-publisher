import { listChannels } from "../channels/registry.js";
import type { BackendDb } from "../db/client.js";
import type { BackendConfig } from "../foundation/config.js";
import { PLATFORM_PROFILES } from "../publishing/platform-profiles.js";

type CapabilityStatus = "ready" | "missing";
export type CapabilityReportEntry = { target: string; required: readonly string[]; missing: string[]; status: CapabilityStatus };

const controllerRequirements = ["CONTROLLER_BOT_TOKEN", "CONTROLLER_ADMIN_IDS"] as const;

/** Read-only readiness report shared by diagnostics, observability and future agents. */
export function capabilityReport(config: BackendConfig, backendDb?: BackendDb): CapabilityReportEntry[] {
  const requirements = backendDb ? registeredRequirements(config, backendDb) : capabilityRequirements(config);
  const values = config as unknown as Record<string, unknown>;
  return [...requirements.entries()].map(([target, required]) => {
    const missing = required.filter((name) => (name === "CONTROLLER_ADMIN_IDS" ? config.CONTROLLER_ADMIN_IDS.length === 0 : !values[name]));
    return { target, required, missing: [...missing], status: missing.length ? "missing" : "ready" };
  });
}

function capabilityRequirements(config: BackendConfig): Map<string, readonly string[]> {
  const requirements = new Map<string, readonly string[]>();
  if (config.controllerBotToken || config.CONTROLLER_ADMIN_IDS.length) requirements.set("controller_bot", controllerRequirements);
  if (config.MEDIA_PROCESSOR_PROVIDER === "remote_http")
    requirements.set("media_processor", ["MEDIA_PROCESSOR_URL", "MEDIA_PROCESSOR_TOKEN"]);
  for (const profile of Object.values(PLATFORM_PROFILES))
    if (profile.requirements.length) requirements.set(profile.id, profile.requirements);
  return requirements;
}

/**
 * The channel registry is the deployment's source of truth. A
 * capability for an account that this Studio never connected is not an
 * actionable health failure, even when the shared image knows its env names.
 */
function registeredRequirements(config: BackendConfig, backendDb: BackendDb): Map<string, readonly string[]> {
  const requirements = new Map<string, readonly string[]>();
  if (config.controllerBotToken || config.CONTROLLER_ADMIN_IDS.length) requirements.set("controller_bot", controllerRequirements);
  for (const channel of listChannels(backendDb)) {
    // A target delivered through a provider needs the provider key, not the
    // platform tokens it would have needed natively. Reporting the tokens as
    // missing told the operator to obtain credentials the delivery path never
    // reads, for a channel that was already publishing.
    if (channel.targetId)
      requirements.set(
        channel.targetId,
        channel.provider === "zernio" ? ["ZERNIO_API_KEY"] : (PLATFORM_PROFILES[channel.targetId]?.requirements ?? []),
      );
    else if (channel.platform === "twitch") requirements.set(channel.id, ["TWITCH_CLIENT_ID", "TOKEN_ENCRYPTION_KEY"]);
    else if (channel.platform === "youtube" || channel.platform === "instagram")
      requirements.set(channel.id, videoChannelRequirements(channel.platform, channel.locale, channel.provider));
  }
  if (config.MEDIA_PROCESSOR_PROVIDER === "remote_http")
    requirements.set("media_processor", ["MEDIA_PROCESSOR_URL", "MEDIA_PROCESSOR_TOKEN"]);
  return requirements;
}

function videoChannelRequirements(platform: string, locale: string, provider: string): readonly string[] {
  if (provider === "zernio") return ["ZERNIO_API_KEY"];
  const suffix = locale === "en" ? "EN" : "RU";
  return platform === "youtube"
    ? [`YOUTUBE_${suffix}_CLIENT_ID`, `YOUTUBE_${suffix}_CLIENT_SECRET`, `YOUTUBE_${suffix}_REFRESH_TOKEN`]
    : [`INSTAGRAM_${suffix}_ACCESS_TOKEN`, `INSTAGRAM_${suffix}_USER_ID`];
}

/** Single policy gate for every interface, collector and delivery adapter.
 * A disabled integration must be reported as unavailable, never probed. */
export function isCapabilityReady(config: BackendConfig, target: string): boolean {
  return capabilityReport(config).find((entry) => entry.target === target)?.status !== "missing";
}
