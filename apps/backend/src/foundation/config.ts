import path from "node:path";
import * as z from "zod";
import type { ApplicationPorts } from "../application/ports.js";
import { type StudioConfig, studioConfig } from "../studio.js";

/** Env flags arrive as strings, so the default has to be a string too: a boolean
 * default would be handed to the transform below on any Zod version that does
 * not short-circuit `undefined`, and `true.toLowerCase()` throws at startup. */
const booleanFlag = (fallback: boolean) =>
  z
    .string()
    .default(fallback ? "1" : "0")
    .transform((value) => !["0", "false", "no", "off"].includes(value.toLowerCase()));

const positiveIdList = z
  .string()
  .default("")
  .transform((value) =>
    value
      .split(",")
      .map((part) => Number(part.trim()))
      .filter((value) => Number.isSafeInteger(value) && value > 0),
  );

/** An .env file states a key it has no value for by leaving it empty, and Docker
 * passes that through as "". Without this, every `KEY=` line in the shipped
 * .env.example reaches an `.optional()` field as a present-but-invalid value and
 * the container refuses to start — which is exactly what a fresh install is. */
function blankAsUnset(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([, value]) => value?.trim() !== ""));
}

/** How long a publish lock outlives the worker holding it before the watchdog
 * may reclaim the job. Not env-configurable, and it lives here next to the
 * publish timings that still are, and next to the checks below that read it:
 * it has to exceed PUBLISH_JOB_TIMEOUT_SECONDS or the same job is picked up
 * twice, and outlast two heartbeats or a working job is reclaimed. */
export const PUBLISH_LOCK_TIMEOUT_SECONDS = 900;

/** Ceiling on exponential publish retry backoff. */
export const PUBLISH_BACKOFF_MAX_SECONDS = 3600;

/** Social publish jobs heartbeat while a slow provider call is in flight (see
 * publish-workflow.ts), touching lockedAt so the watchdog does not mistake
 * "still working" for "worker crashed". Two missed beats must still fit inside
 * the lock window, or a working job gets reclaimed. */
export const PUBLISH_HEARTBEAT_INTERVAL_SECONDS = 180;

/** Initial delivery plus three exponential-backoff retries. */
export const PUBLISH_MAX_ATTEMPTS = 4;
export const PUBLISH_BACKOFF_BASE_SECONDS = 60;

const envSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    DEPLOYMENT_ENV: z.enum(["development", "test", "production"]).default("development"),
    LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
    PORT: z.coerce.number().int().positive().default(8788),
    BIND_HOST: z.string().default("127.0.0.1"),
    /** The one mounted volume. Every pipeline path below is derived from it,
     * because five separately settable paths meant five ways to point one of
     * them off the volume — a database or a media tree written to the
     * container's own filesystem looks fine until the container is replaced. */
    DATA_DIR: z.string().default("/data"),
    // Telegram's own API. A deployment that runs a local Bot API server — the
    // way to lift the 50 MB download limit for video — points this at it
    // instead; the default must work for an install that does not.
    TELEGRAM_API_BASE_URL: z.string().default("https://api.telegram.org"),
    CONTROLLER_BOT_TOKEN: z.string().optional(),
    CLIENT_IP_HASH_SALT: z.string().min(16).default("development-only"),
    // Defaulted, not optional: the host proxy sets X-Real-IP on every route, and
    // when this was unset the whole internet collapsed onto one visitor identity
    // (see engagement/identity.ts), making the public rate limit one global budget.
    TRUSTED_CLIENT_IP_HEADER: z.enum(["x-real-ip", "cf-connecting-ip"]).default("x-real-ip"),
    COMMAND_CENTER_TOKEN: z.string().optional(),
    MCP_STUDIO_TOKEN: z.string().min(16).optional(),
    MCP_STUDIO_ACTOR_ID: z.coerce.number().int().positive().optional(),
    DEEPSEEK_API_KEY: z.string().optional(),
    GROK_CLI_PATH: z.string().default("grok"),
    CONTROLLER_ADMIN_IDS: positiveIdList,
    /** Leaving the Studio roster unset uses the Telegram controller roster.
     * Setting it lets Studio own work without granting Telegram access. */
    STUDIO_ACTOR_IDS: positiveIdList,
    // Empty means this Studio has no Telegram channel, which is a Studio that
    // serves only its website. It used to default to a real, live channel, and
    // the production guard below existed to stop a second Studio publishing
    // into the first one's audience. Removing the default removes the hazard,
    // and with it the requirement that every install name a channel.
    TELEGRAM_CHANNEL_USERNAME: z.string().default(""),
    // A provider call must not hold the complete queue loop forever. Timeouts
    // are terminal and require an explicit retry, because the provider may have
    // accepted the request while its response was lost. Stays configurable
    // because it is the one publish timing a test has to be able to shorten.
    PUBLISH_JOB_TIMEOUT_SECONDS: z.coerce.number().int().min(1).max(3_600).default(600),
    METRICS_REFRESH_INTERVAL_SECONDS: z.coerce.number().int().positive().default(10),
    /** Refreshes account-level followers and aggregate platform insights. */
    CREATOR_PROFILE_REFRESH_INTERVAL_SECONDS: z.coerce
      .number()
      .int()
      .min(60)
      .default(60 * 60),
    OBSERVABILITY_INTERVAL_SECONDS: z.coerce.number().int().positive().default(300),
    IDLE_POLL_INTERVAL_SECONDS: z.coerce.number().int().positive().default(5),
    /** Where optional heavy media transforms execute. Remote workers are
     * deliberately opt-in so a stock self-hosted Studio keeps working. */
    MEDIA_PROCESSOR_PROVIDER: z.enum(["local", "remote_http"]).default("local"),
    MEDIA_PROCESSOR_URL: z.url().optional(),
    MEDIA_PROCESSOR_TOKEN: z.string().min(16).optional(),
    MEDIA_PROCESSOR_TIMEOUT_SECONDS: z.coerce.number().int().min(10).max(3600).default(900),
    STORY_CARD_ASSETS_DIR: z.string().default("/app/apps/backend/assets/story-card"),
    STORY_CARD_RENDERER_ENTRY: z.string().default("/app/story-renderer/renderer-process.js"),
    // VIDEO_PREPARE_LEAD_MINUTES / VIDEO_MEDIA_RETENTION_HOURS
    // are owned by the studio_profile row (see withStudioProfile); they are not
    // env-configurable.
    THREADS_RU_ACCESS_TOKEN: z.string().optional(),
    THREADS_EN_ACCESS_TOKEN: z.string().optional(),
    /** The Threads app's own id and secret, which are not the Meta app's — the
     * dashboard shows both pairs. Only `threads-authorize` needs them: they
     * mint the tokens above and are never used to publish. */
    // Both stay configurable: a test has to be able to shorten the wait for a
    // container that never leaves IN_PROGRESS.
    THREADS_CONTAINER_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(180),
    THREADS_RETRY_DELAY_MS: z.coerce.number().int().min(1).max(30_000).default(2_000),
    THREADS_APP_ID: z.string().optional(),
    THREADS_APP_SECRET: z.string().optional(),
    X_CLIENT_ID: z.string().optional(),
    X_CLIENT_SECRET: z.string().optional(),
    ENABLE_X_METRICS: booleanFlag(false),
    DISCORD_CHANNEL_ID: z.string().optional(),
    // Only used to build the message permalink: the create-message response
    // carries the channel but not the guild it lives in.
    DISCORD_GUILD_ID: z.string().optional(),
    ENABLE_X_PROFILE_METRICS: booleanFlag(true),
    INSTAGRAM_EN_ACCESS_TOKEN: z.string().optional(),
    INSTAGRAM_EN_USER_ID: z.string().optional(),
    INSTAGRAM_RU_ACCESS_TOKEN: z.string().optional(),
    INSTAGRAM_RU_USER_ID: z.string().optional(),
    INSTAGRAM_APP_ID: z.string().optional(),
    INSTAGRAM_APP_SECRET: z.string().optional(),
    INSTAGRAM_GRAPH_API_VERSION: z.string().default("v23.0"),
    YOUTUBE_RU_CLIENT_ID: z.string().optional(),
    YOUTUBE_RU_CLIENT_SECRET: z.string().optional(),
    YOUTUBE_RU_REFRESH_TOKEN: z.string().optional(),
    YOUTUBE_EN_CLIENT_ID: z.string().optional(),
    YOUTUBE_EN_CLIENT_SECRET: z.string().optional(),
    YOUTUBE_EN_REFRESH_TOKEN: z.string().optional(),
    TELEGRAM_STORIES_CHANNEL: z.string().optional(),
    TELEGRAM_CHANNEL_STORIES_API_ID: z.coerce.number().int().positive().optional(),
    TELEGRAM_CHANNEL_STORIES_API_HASH: z.string().optional(),
    TELEGRAM_CHANNEL_STORIES_SESSION: z.string().optional(),
    // Override only when a platform-facing media URL lives elsewhere. Otherwise
    // it follows this Studio's own public base URL below.
    PUBLIC_MEDIA_BASE_URL: z.string().optional(),
    PUBLIC_BASE_URL: z.string().default("https://alexgetman.com"),
    /** Seals the platform tokens this Studio renews for itself before they are
     * stored. Absent means it does not renew them: the credentials stay exactly
     * what .env says, which is how every install worked before this existed. */
    TOKEN_ENCRYPTION_KEY: z.string().optional(),
    DEPLOY_AGENT_URL: z.url().optional(),
    DEPLOY_AGENT_TOKEN: z.string().min(16).optional(),
    INDEXNOW_ENABLED: booleanFlag(true),
  })
  .superRefine((env, context) => {
    for (const [id, secret] of [
      ["THREADS_APP_ID", "THREADS_APP_SECRET"],
      ["INSTAGRAM_APP_ID", "INSTAGRAM_APP_SECRET"],
    ] as const) {
      if (Boolean(env[id]) !== Boolean(env[secret]))
        context.addIssue({ code: "custom", path: [id], message: `${id} and ${secret} must be configured together` });
    }
    // The client is a pair; the refresh token is not part of it. It used to be:
    // a connected channel's token could only come from .env, so demanding all
    // three together was how a half-configured YouTube was caught. A token now
    // lives in the database, and keeping it in the rule made removing the dead
    // .env line refuse to start the Studio that no longer needed it.
    for (const suffix of ["RU", "EN"] as const) {
      const id = `YOUTUBE_${suffix}_CLIENT_ID` as const;
      const secret = `YOUTUBE_${suffix}_CLIENT_SECRET` as const;
      if (Boolean(env[id]) !== Boolean(env[secret]))
        context.addIssue({ code: "custom", path: [id], message: `${id} and ${secret} must be configured together` });
    }
    if (Boolean(env.DEPLOY_AGENT_URL) !== Boolean(env.DEPLOY_AGENT_TOKEN)) {
      context.addIssue({
        code: "custom",
        path: ["DEPLOY_AGENT_URL"],
        message: "DEPLOY_AGENT_URL and DEPLOY_AGENT_TOKEN must be configured together",
      });
    }
    if (Boolean(env.MCP_STUDIO_TOKEN) !== Boolean(env.MCP_STUDIO_ACTOR_ID)) {
      context.addIssue({
        code: "custom",
        path: ["MCP_STUDIO_TOKEN"],
        message: "MCP_STUDIO_TOKEN and MCP_STUDIO_ACTOR_ID must be configured together",
      });
    }
    // A provider call may legitimately occupy a worker for the whole job
    // timeout; the lock has to outlive it or the same job gets picked up twice.
    if (env.PUBLISH_JOB_TIMEOUT_SECONDS >= PUBLISH_LOCK_TIMEOUT_SECONDS) {
      context.addIssue({
        code: "custom",
        path: ["PUBLISH_JOB_TIMEOUT_SECONDS"],
        message: `PUBLISH_JOB_TIMEOUT_SECONDS (${env.PUBLISH_JOB_TIMEOUT_SECONDS}s) must be shorter than the ${PUBLISH_LOCK_TIMEOUT_SECONDS}s publish lock window`,
      });
    }
    // The MCP token authorizes an actor, so that actor has to be on the roster.
    // It is not required to be a Telegram admin: a deployment that lists
    // STUDIO_ACTOR_IDS can run the Studio with the bot switched off entirely.
    const roster = env.STUDIO_ACTOR_IDS.length > 0 ? env.STUDIO_ACTOR_IDS : env.CONTROLLER_ADMIN_IDS;
    if (env.MCP_STUDIO_ACTOR_ID && !roster.includes(env.MCP_STUDIO_ACTOR_ID)) {
      context.addIssue({
        code: "custom",
        path: ["MCP_STUDIO_ACTOR_ID"],
        message: "MCP_STUDIO_ACTOR_ID must belong to STUDIO_ACTOR_IDS (or CONTROLLER_ADMIN_IDS when that is the roster)",
      });
    }
  });

/** What .env alone determines. Everything the Studio itself owns is added by
 * withStudioProfile once the database is open. */
export type EnvConfig = z.infer<typeof envSchema> & {
  /** Every pipeline path, derived from DATA_DIR rather than settable. They are
   * fields and not constants because a test and the dev fixture both run
   * against a temporary root. */
  PIPELINE_DB: string;
  /** All media the Studio owns: ingress staging under `.incoming`, per-actor
   * uploads, and the video files delivery reads. One directory, one name. */
  STUDIO_MEDIA_DIR: string;
  MEDIA_CACHE_DIR: string;
  STORY_CARD_DIR: string;
  SITE_PUBLIC_DIR: string;
  /** Temporary public staging for platforms that fetch media by URL. */
  REMOTE_MEDIA_PATH: string;
  controllerBotToken: string | undefined;
  commandCenterToken: string | undefined;
  /** Where this Studio's dashboard lives. Derived, never configured: it is
   * PUBLIC_BASE_URL with one fixed path, and two settings for one address drift
   * into a same-origin check that rejects the real login form. */
  COMMAND_CENTER_URL: string;
  /** Resolved against PUBLIC_BASE_URL when this Studio does not serve its media
   * from a separate location. */
  PUBLIC_MEDIA_BASE_URL: string;
  /** What .env said each renewable platform token was, captured before any
   * renewal replaced it. A renewed token takes the place of the setting it
   * renews, so without this the next comparison would be against the renewal
   * and every check would look like an operator had changed something. */
  metaTokenSeeds: Record<string, string | undefined>;
};

export type BackendConfig = EnvConfig & {
  /** Platform credentials with one home — the `platform_tokens` row a browser
   * connection or `credential-set` wrote. They reach a configuration only
   * through loadRuntimeConfig; .env never carries them. */
  X_ACCESS_TOKEN?: string;
  X_REFRESH_TOKEN?: string;
  ZERNIO_API_KEY?: string;
  DISCORD_BOT_TOKEN?: string;
  VIDEO_PREPARE_LEAD_MINUTES: number;
  VIDEO_MEDIA_RETENTION_HOURS: number;
  TIMEZONE: string;
  TIMEZONE_LABEL: string;
  studio: StudioConfig;
};

/**
 * Attaches the settings the Studio owns to the settings its host owns. Every
 * added field is a getter over the same live `studio` view, so a setting changed
 * through `ops` reaches the next reader without a restart and there is exactly
 * one place the value comes from.
 */
export function withStudioProfile(env: EnvConfig, ports: Pick<ApplicationPorts, "studioSettings">): BackendConfig {
  const studio = studioConfig(ports);
  return Object.defineProperties({ ...env } as BackendConfig, {
    studio: { value: studio, enumerable: true },
    TIMEZONE: { get: () => studio.timezone, enumerable: true },
    TIMEZONE_LABEL: { get: () => studio.timezoneLabel, enumerable: true },
    VIDEO_PREPARE_LEAD_MINUTES: { get: () => studio.video.prepare_lead_minutes, enumerable: true },
    VIDEO_MEDIA_RETENTION_HOURS: { get: () => studio.video.retention_hours, enumerable: true },
  });
}

export function loadConfig(rawEnv: NodeJS.ProcessEnv = process.env): EnvConfig {
  const env = blankAsUnset(rawEnv);
  const parsed = envSchema.parse(env);
  if (parsed.NODE_ENV === "production" && parsed.DEPLOYMENT_ENV !== "production")
    throw new Error("DEPLOYMENT_ENV=production is required when NODE_ENV=production");
  if (parsed.DEPLOYMENT_ENV === "production" && parsed.NODE_ENV !== "production")
    throw new Error("NODE_ENV=production is required when DEPLOYMENT_ENV=production");
  if (parsed.DEPLOYMENT_ENV === "production") {
    if (!parsed.COMMAND_CENTER_TOKEN) throw new Error("COMMAND_CENTER_TOKEN is required in production");
    if (!env.CLIENT_IP_HASH_SALT) throw new Error("CLIENT_IP_HASH_SALT is required in production");
  }
  // Same hazard, different surface: the default is a live site, so a Studio
  // that does not name its own would put the first one's domain in its feeds,
  // its sitemap and its canonical URLs.
  if (parsed.NODE_ENV === "production" && !env.PUBLIC_BASE_URL) throw new Error("PUBLIC_BASE_URL must be set explicitly in production");
  if (parsed.MEDIA_PROCESSOR_PROVIDER === "remote_http" && (!parsed.MEDIA_PROCESSOR_URL || !parsed.MEDIA_PROCESSOR_TOKEN)) {
    throw new Error("MEDIA_PROCESSOR_URL and MEDIA_PROCESSOR_TOKEN are required when MEDIA_PROCESSOR_PROVIDER=remote_http");
  }
  const dataDir = parsed.DATA_DIR;
  return {
    ...parsed,
    PIPELINE_DB: path.join(dataDir, "pipeline.db"),
    STUDIO_MEDIA_DIR: path.join(dataDir, "video-media"),
    MEDIA_CACHE_DIR: path.join(dataDir, "media-cache"),
    STORY_CARD_DIR: path.join(dataDir, "story-cards"),
    SITE_PUBLIC_DIR: path.join(dataDir, "site"),
    REMOTE_MEDIA_PATH: path.join(dataDir, "media"),
    controllerBotToken: parsed.CONTROLLER_BOT_TOKEN,
    commandCenterToken: parsed.COMMAND_CENTER_TOKEN,
    COMMAND_CENTER_URL: `${parsed.PUBLIC_BASE_URL.replace(/\/$/, "")}/command-center`,
    PUBLIC_MEDIA_BASE_URL: parsed.PUBLIC_MEDIA_BASE_URL ?? `${parsed.PUBLIC_BASE_URL.replace(/\/$/, "")}/media/staging`,
    metaTokenSeeds: {
      THREADS_RU_ACCESS_TOKEN: parsed.THREADS_RU_ACCESS_TOKEN,
      THREADS_EN_ACCESS_TOKEN: parsed.THREADS_EN_ACCESS_TOKEN,
      INSTAGRAM_RU_ACCESS_TOKEN: parsed.INSTAGRAM_RU_ACCESS_TOKEN,
      INSTAGRAM_EN_ACCESS_TOKEN: parsed.INSTAGRAM_EN_ACCESS_TOKEN,
    },
  };
}
