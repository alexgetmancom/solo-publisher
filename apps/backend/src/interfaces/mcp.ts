import * as z from "zod";
import { publicationRef } from "../application/publication-ref.js";
import type { BackendDb } from "../db/client.js";
import type { BackendConfig } from "../foundation/config.js";
import { STUDIO_LOCALES } from "../foundation/locale.js";
import { log } from "../foundation/logger.js";
import { redactExternalSecrets } from "../foundation/redact.js";
import {
  inputJsonSchema,
  type OperationDef,
  OperationInputError,
  operationCatalog,
  operationDef,
  runOperation,
} from "../operations/registry.js";
import { createStudioServices, type StudioServices } from "../studio/services/index.js";

const feedbackHits = new Map<string, number[]>();

/** The one revision of the wire protocol this server implements. A client that
 * asked for another reads it here and adapts; echoing back whatever it asked
 * for would promise a shape this code does not speak. */
const PROTOCOL_VERSION = "2024-11-05";

// --- Shared zod building blocks -------------------------------------------------

const trimmed = (min: number, max: number) => z.string().trim().min(min).max(max);
const positiveInt = z.number().int().min(1);
/** The language a post is written in. Fixed to the two the channels publish. */
const localeSchema = z.enum(["ru", "en"]);
/** The owner's interface language, which the locale registry may grow. */
const uiLocaleSchema = z.enum(STUDIO_LOCALES);
const videoTargetSchema = z.enum(["youtube_shorts", "instagram_reels"]);

/** Empty string or absent both mean "no value"; otherwise must be a parseable ISO date. */
function isoDateOrNull(maxLength: number) {
  return z
    .string()
    .max(maxLength)
    .optional()
    .transform((value, ctx) => {
      if (value == null || value === "") return null;
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) {
        ctx.addIssue({ code: "custom", message: "must be an ISO date" });
        return z.NEVER;
      }
      return date;
    });
}

function uniqueIntArray(min: number, max: number) {
  return z
    .array(positiveInt)
    .min(min)
    .max(max)
    .transform((values) => [...new Set(values)]);
}

const youtubeMetadataSchema = z.object({
  title: trimmed(1, 100),
  description: trimmed(0, 5_000),
  // Length and budget are the shared limits' business (video-metadata-limits).
  tags: z.array(trimmed(1, 100)),
  game_url: trimmed(1, 500).optional(),
});
const instagramMetadataSchema = z.object({ caption: trimmed(1, 2_200) });

function parseArgs<T>(schema: z.ZodType<T>, args: unknown): T {
  const result = schema.safeParse(args);
  if (!result.success) throw new McpToolError(-32602, describeIssue(result.error.issues[0]));
  return result.data;
}

/** An agent gets one shot at the message, so name the offending field: bare
 * "Too small" leaves it guessing which of ten arguments to fix. */
function describeIssue(issue: z.core.$ZodIssue | undefined): string {
  if (!issue) return "invalid arguments";
  const path = issue.path.join(".");
  return path ? `${path}: ${issue.message}` : issue.message;
}

// --- Tool catalog: one zod schema per tool is both its validator and its client-facing schema ---

const feedbackToolDef = {
  description: "Record feedback or a bug report in this Studio's own journal, where its operator will see it. It is not sent anywhere.",
  schema: z.object({ name: trimmed(0, 120).optional(), message: trimmed(1, 2_000) }),
};

/** A Studio tool is fully described by its schema + handler; runStudioTool no longer
 * needs a parallel switch, and handler input is inferred from `schema` post-transform
 * so call sites need no manual re-typing of parsed args. */
type ToolDef<S extends z.ZodType = z.ZodType> = {
  description: string;
  schema: S;
  /** Set for commands that change state; query tools omit it and skip the audit event. */
  mutates?: boolean;
  /** Domain-event ref for a mutating command; omit when the command has none. */
  ref?: (input: z.infer<S>, result: unknown) => string | null;
  handler: (studio: StudioServices, actorId: number, input: z.infer<S>) => unknown | Promise<unknown>;
};

function tool<S extends z.ZodType>(def: ToolDef<S>): ToolDef<S> {
  return def;
}

const studioToolDefs = {
  studio_capabilities: tool({
    description: "Read Studio capabilities and sanitized platform readiness before selecting a command.",
    schema: z.object({}),
    handler: (studio) => studio.capabilities.report(),
  }),
  studio_queue: tool({
    description: "Read upcoming work, drafts and failures for the authenticated Studio.",
    schema: z.object({}),
    handler: (studio, actorId) => studio.queue.snapshot(actorId),
  }),
  studio_post_list: tool({
    description: "List post drafts visible to the authenticated Studio operator.",
    schema: z.object({ limit: positiveInt.max(100).optional() }),
    handler: (studio, actorId, input) => studio.posts.list(actorId, input.limit ?? 50),
  }),
  studio_notification_settings: tool({
    description: "Read the authenticated owner's Studio notification policy.",
    schema: z.object({}),
    handler: (studio, actorId) => studio.settings.notifications(actorId),
  }),
  studio_locale: tool({
    description: "Read the authenticated owner's Studio interface locale.",
    schema: z.object({}),
    handler: (studio, actorId) => ({ locale: studio.settings.locale(actorId) }),
  }),
  studio_channels: tool({
    description: "List connected Studio channels without exposing stored credentials.",
    schema: z.object({}),
    handler: (studio) =>
      studio.channels.list(false).map(({ id, platform, locale, provider, providerAccountId, targetId, label, enabled, source }) => ({
        id,
        platform,
        locale,
        provider,
        provider_account_id: providerAccountId,
        target_id: targetId,
        label,
        enabled: enabled === 1,
        source,
      })),
  }),
  studio_zernio_connection_options: tool({
    description: "List publishable Zernio account routes for one language without exposing the stored API key.",
    schema: z.object({ locale: z.enum(["ru", "en"]) }),
    handler: async (studio, _actorId, input) =>
      (await studio.channels.discoverZernioConnections(input.locale)).map((option) => ({
        connection: option.key,
        label: option.label,
        channel_connect: option.input.targetId
          ? {
              target: option.input.targetId,
              provider: "zernio",
              account_id: option.accountId,
              label: option.label,
            }
          : {
              platform: option.input.platform,
              locale: option.locale,
              provider: "zernio",
              account_id: option.accountId,
              label: option.label,
            },
      })),
  }),
  studio_locale_update: tool({
    description: "Update the authenticated owner's shared interface locale.",
    schema: z.object({ locale: uiLocaleSchema }),
    mutates: true,
    handler: (studio, actorId, input) => {
      studio.settings.setLocale(actorId, input.locale);
      return { locale: input.locale, updated: true };
    },
  }),
  studio_youtube_signature: tool({
    description: "Read this Studio's YouTube description signature.",
    schema: z.object({}),
    handler: (studio) => ({ signature: studio.settings.youtubeSignature() }),
  }),
  studio_youtube_signature_update: tool({
    description:
      "Set or clear this Studio's YouTube description signature. It reaches every video on the Studio's channel, whoever authored it.",
    schema: z.object({ signature: z.string().max(500) }),
    mutates: true,
    handler: (studio, _actorId, input) => {
      studio.settings.setYoutubeSignature(input.signature);
      return { signature: studio.settings.youtubeSignature(), updated: true };
    },
  }),
  studio_notification_settings_update: tool({
    description: "Update notification policy. These settings apply to every connected interface; Telegram is only one delivery adapter.",
    schema: z.object({
      video_reminders_enabled: z.boolean().optional(),
      post_reminders_enabled: z.boolean().optional(),
      reminder_minutes: z.number().int().min(1).max(60).optional(),
      completion_enabled: z.boolean().optional(),
    }),
    mutates: true,
    handler: (studio, actorId, input) =>
      studio.settings.setNotifications(actorId, {
        ...(input.video_reminders_enabled === undefined ? {} : { videoRemindersEnabled: input.video_reminders_enabled }),
        ...(input.post_reminders_enabled === undefined ? {} : { postRemindersEnabled: input.post_reminders_enabled }),
        ...(input.reminder_minutes === undefined ? {} : { reminderMinutes: input.reminder_minutes }),
        ...(input.completion_enabled === undefined ? {} : { completionEnabled: input.completion_enabled }),
      }),
  }),
  studio_weekly_digest_settings: tool({
    description: "Read the Studio-wide weekly digest policy shared by every administrator.",
    schema: z.object({}),
    handler: (studio) => studio.settings.weeklyDigest(),
  }),
  studio_weekly_digest_settings_update: tool({
    description: "Update the Studio-wide weekly digest policy shared by every administrator.",
    schema: z.object({
      enabled: z.boolean().optional(),
      weekday: z.number().int().min(0).max(6).optional(),
    }),
    mutates: true,
    handler: (studio, _actorId, input) =>
      studio.settings.setWeeklyDigest({
        ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
        ...(input.weekday === undefined ? {} : { weekday: input.weekday }),
      }),
  }),
  studio_media_list: tool({
    description: "List reusable media assets visible to the authenticated Studio operator.",
    schema: z.object({ limit: positiveInt.max(100).optional() }),
    handler: (studio, actorId, input) => studio.posts.mediaAssets(actorId, input.limit ?? 50),
  }),
  studio_post_create: tool({
    description:
      "Create a text-post draft with its exact publication targets. Every target publishes one language and takes that language's text: `text` is Russian, `text_en` is English. A target connected on the EN locale — which is what a single X or Threads account connects as — publishes `text_en`, and refuses a draft that has only `text`. `studio_capabilities` lists each connected target with its locale.",
    schema: z.object({
      text: trimmed(1, 20_000),
      text_en: trimmed(0, 20_000).optional(),
      targets: z
        .array(trimmed(1, 120))
        .min(1)
        .max(10)
        .transform((values) => [...new Set(values)]),
      story_publish_mode: z.enum(["all", "site_only"]).optional(),
    }),
    mutates: true,
    ref: (_input, result) => publicationRef("draft", (result as { draft_id: number }).draft_id),
    handler: (studio, actorId, input) => {
      const draftId = studio.posts.create(
        actorId,
        {
          text: input.text,
          ...(input.text_en === undefined ? {} : { textEn: input.text_en, textEnApproved: input.text_en }),
          entities: [],
          media: [],
        },
        { targets: input.targets, ...(input.story_publish_mode ? { storyMode: input.story_publish_mode } : {}) },
      );
      return { draft_id: draftId, targets: input.targets };
    },
  }),
  studio_post_get: tool({
    description: "Read one owned post draft.",
    schema: z.object({ draft_id: positiveInt }),
    handler: (studio, actorId, input) => studio.posts.get(actorId, input.draft_id),
  }),
  studio_post_validate: tool({
    description: "Validate one owned post draft before publishing.",
    schema: z.object({ draft_id: positiveInt }),
    handler: (studio, actorId, input) => studio.posts.validate(actorId, input.draft_id),
  }),
  studio_post_status: tool({
    description: "Read queue and target status for one owned post draft.",
    schema: z.object({ draft_id: positiveInt }),
    handler: (studio, actorId, input) => studio.posts.progress(actorId, input.draft_id),
  }),
  studio_post_history: tool({
    description: "Read durable event history for one owned post draft.",
    schema: z.object({ draft_id: positiveInt, limit: positiveInt.max(100).optional() }),
    handler: (studio, actorId, input) => studio.posts.history(actorId, input.draft_id, input.limit ?? 50),
  }),
  studio_post_attach_media: tool({
    description: "Attach already uploaded Studio media assets to an owned post locale. Upload files through POST /api/studio/media first.",
    schema: z.object({
      draft_id: positiveInt,
      locale: localeSchema,
      asset_ids: uniqueIntArray(1, 10),
      replace: z.boolean().optional(),
    }),
    mutates: true,
    ref: (input) => publicationRef("draft", input.draft_id),
    handler: (studio, actorId, input) => {
      studio.posts.attachMediaAssets(actorId, input.draft_id, input.locale, input.asset_ids, Boolean(input.replace));
      return {
        draft_id: input.draft_id,
        locale: input.locale,
        asset_ids: input.asset_ids,
        attached: true,
        replace: Boolean(input.replace),
      };
    },
  }),
  studio_post_remove_media: tool({
    description: "Remove selected Studio media assets from one owned post locale.",
    schema: z.object({ draft_id: positiveInt, locale: localeSchema, asset_ids: uniqueIntArray(1, 10) }),
    mutates: true,
    ref: (input) => publicationRef("draft", input.draft_id),
    handler: (studio, actorId, input) => {
      studio.posts.removeMedia(actorId, input.draft_id, input.locale, input.asset_ids);
      return { draft_id: input.draft_id, locale: input.locale, asset_ids: input.asset_ids, removed: true };
    },
  }),
  studio_post_preview: tool({
    description: "Read a transport-neutral preview of one owned post draft.",
    schema: z.object({ draft_id: positiveInt }),
    handler: (studio, actorId, input) => studio.posts.preview(actorId, input.draft_id),
  }),
  studio_post_edit: tool({
    description: "Edit text on one owned post draft.",
    schema: z.object({ draft_id: positiveInt, locale: localeSchema, text: trimmed(0, 20_000) }),
    mutates: true,
    ref: (input) => publicationRef("draft", input.draft_id),
    handler: (studio, actorId, input) => {
      studio.posts.edit(actorId, input.draft_id, { locale: input.locale, text: input.text, entities: [], media: [] });
      return { draft_id: input.draft_id, updated: true };
    },
  }),
  studio_post_publish: tool({
    description: "Queue an owned post draft for immediate publication.",
    schema: z.object({ draft_id: positiveInt }),
    mutates: true,
    ref: (_input, result) => publicationRef("post", (result as { post_id: number }).post_id),
    handler: (studio, actorId, input) => {
      const postId = studio.posts.publish(actorId, input.draft_id);
      return { draft_id: input.draft_id, post_id: postId, queued: true };
    },
  }),
  studio_post_schedule: tool({
    description: "Schedule an owned post draft. ISO dates are optional per locale.",
    schema: z
      .object({ draft_id: positiveInt, ru_at: isoDateOrNull(80), en_at: isoDateOrNull(80) })
      .refine((value) => value.ru_at || value.en_at, { message: "ru_at or en_at is required" }),
    mutates: true,
    ref: (_input, result) => publicationRef("post", (result as { post_id: number }).post_id),
    handler: (studio, actorId, input) => {
      const postId = studio.posts.schedule(actorId, input.draft_id, { ruAt: input.ru_at, enAt: input.en_at });
      return { draft_id: input.draft_id, post_id: postId, scheduled: true };
    },
  }),
  studio_post_cancel: tool({
    description: "Cancel an owned post draft and its remaining work.",
    schema: z.object({ draft_id: positiveInt }),
    mutates: true,
    ref: (input) => publicationRef("draft", input.draft_id),
    handler: (studio, actorId, input) => {
      studio.posts.cancel(actorId, input.draft_id);
      return { draft_id: input.draft_id, cancelled: true };
    },
  }),
  studio_video_create: tool({
    description: "Create an owned video draft from an already-uploaded Studio video asset.",
    schema: z.object({ asset_id: positiveInt, locale: localeSchema.optional() }),
    mutates: true,
    ref: (_input, result) => publicationRef("video", (result as { video_draft_id: number }).video_draft_id),
    handler: (studio, actorId, input) => {
      const publicationId = studio.videos.create(actorId, input.asset_id, input.locale);
      return { video_draft_id: publicationId };
    },
  }),
  studio_video_list: tool({
    description: "List video drafts visible to the authenticated Studio operator.",
    schema: z.object({ limit: positiveInt.max(100).optional() }),
    handler: (studio, actorId, input) => studio.videos.list(actorId, input.limit ?? 50),
  }),
  studio_video_get: tool({
    description: "Read an owned video draft and its targets.",
    schema: z.object({ video_draft_id: positiveInt }),
    handler: (studio, actorId, input) => studio.videos.get(actorId, input.video_draft_id),
  }),
  studio_video_preview: tool({
    description: "Read an owned video draft preview and target metadata.",
    schema: z.object({ video_draft_id: positiveInt }),
    handler: (studio, actorId, input) => studio.videos.preview(actorId, input.video_draft_id),
  }),
  studio_video_status: tool({
    description: "Read owned video targets and durable jobs.",
    schema: z.object({ video_draft_id: positiveInt }),
    handler: (studio, actorId, input) => studio.videos.status(actorId, input.video_draft_id),
  }),
  studio_video_history: tool({
    description: "Read durable event history for one owned video draft.",
    schema: z.object({ video_draft_id: positiveInt, limit: positiveInt.max(100).optional() }),
    handler: (studio, actorId, input) => studio.videos.history(actorId, input.video_draft_id, input.limit ?? 50),
  }),
  studio_video_rename: tool({
    description: "Rename an owned video draft.",
    schema: z.object({ video_draft_id: positiveInt, label: trimmed(1, 500) }),
    mutates: true,
    ref: (input) => publicationRef("video", input.video_draft_id),
    handler: (studio, actorId, input) => {
      studio.videos.rename(actorId, input.video_draft_id, input.label);
      return { video_draft_id: input.video_draft_id, updated: true };
    },
  }),
  studio_video_replace_targets: tool({
    description: "Replace editable video publication targets.",
    schema: z.object({
      video_draft_id: positiveInt,
      targets: z
        .array(videoTargetSchema)
        .min(1)
        .max(2)
        .refine((values) => new Set(values).size === values.length, { message: "targets must not contain duplicates" }),
    }),
    mutates: true,
    ref: (input) => publicationRef("video", input.video_draft_id),
    handler: (studio, actorId, input) => {
      studio.videos.replaceTargets(actorId, input.video_draft_id, input.targets);
      return { video_draft_id: input.video_draft_id, updated: true };
    },
  }),
  studio_video_update_metadata: tool({
    description: "Set target metadata. YouTube requires title, description and tags; Instagram requires caption.",
    schema: z
      .object({ video_draft_id: positiveInt, target: videoTargetSchema, metadata: z.record(z.string(), z.unknown()) })
      .transform((value, ctx) => {
        const parsed =
          value.target === "youtube_shorts"
            ? youtubeMetadataSchema.safeParse(value.metadata)
            : instagramMetadataSchema.safeParse(value.metadata);
        if (!parsed.success) {
          ctx.addIssue({ code: "custom", message: parsed.error.issues[0]?.message ?? "metadata is invalid" });
          return z.NEVER;
        }
        const metadata =
          "game_url" in parsed.data
            ? { title: parsed.data.title, description: parsed.data.description, tags: parsed.data.tags, gameUrl: parsed.data.game_url }
            : parsed.data;
        return { publicationId: value.video_draft_id, target: value.target, metadata };
      }),
    mutates: true,
    ref: (input) => publicationRef("video", input.publicationId),
    handler: (studio, actorId, input) => {
      studio.videos.updateMetadata(actorId, input.publicationId, input.target, input.metadata as never);
      return { video_draft_id: input.publicationId, target: input.target, updated: true };
    },
  }),
  studio_video_schedule: tool({
    description: "Schedule one or both connected video targets at future ISO datetimes.",
    schema: z
      .object({ video_draft_id: positiveInt, youtube_shorts_at: isoDateOrNull(80), instagram_reels_at: isoDateOrNull(80) })
      .refine((value) => value.youtube_shorts_at || value.instagram_reels_at, {
        message: "youtube_shorts_at or instagram_reels_at is required",
      }),
    mutates: true,
    ref: (input) => publicationRef("video", input.video_draft_id),
    handler: async (studio, actorId, input) => {
      const technical = await studio.videos.schedule(actorId, input.video_draft_id, {
        ...(input.youtube_shorts_at ? { youtube_shorts: input.youtube_shorts_at } : {}),
        ...(input.instagram_reels_at ? { instagram_reels: input.instagram_reels_at } : {}),
      });
      return { video_draft_id: input.video_draft_id, scheduled: true, technical };
    },
  }),
  studio_video_preflight: tool({
    description: "Validate an owned video source and configured targets without scheduling it.",
    schema: z.object({ video_draft_id: positiveInt }),
    handler: (studio, actorId, input) => studio.videos.technicalCheck(actorId, input.video_draft_id),
  }),
  studio_video_publish: tool({
    description: "Queue all connected video targets for immediate publication.",
    schema: z.object({ video_draft_id: positiveInt }),
    mutates: true,
    ref: (input) => publicationRef("video", input.video_draft_id),
    handler: async (studio, actorId, input) => {
      const technical = await studio.videos.publish(actorId, input.video_draft_id);
      return { video_draft_id: input.video_draft_id, queued: true, technical };
    },
  }),
  studio_video_retry: tool({
    description: "Retry one failed video target.",
    schema: z.object({ video_draft_id: positiveInt, target: videoTargetSchema }),
    mutates: true,
    ref: (input) => publicationRef("video", input.video_draft_id),
    handler: (studio, actorId, input) => {
      studio.videos.retryTarget(actorId, input.video_draft_id, input.target);
      return { video_draft_id: input.video_draft_id, target: input.target, retried: true };
    },
  }),
  studio_video_remove_target: tool({
    description: "Remove one editable video target.",
    schema: z.object({ video_draft_id: positiveInt, target: videoTargetSchema }),
    mutates: true,
    ref: (input) => publicationRef("video", input.video_draft_id),
    handler: (studio, actorId, input) => ({
      video_draft_id: input.video_draft_id,
      target: input.target,
      ...studio.videos.removeTarget(actorId, input.video_draft_id, input.target),
    }),
  }),
  studio_video_cancel: tool({
    description: "Cancel an owned video publication.",
    schema: z.object({ video_draft_id: positiveInt }),
    mutates: true,
    ref: (input) => publicationRef("video", input.video_draft_id),
    handler: async (studio, actorId, input) => ({
      video_draft_id: input.video_draft_id,
      cancelled: true,
      ...(await studio.videos.cancel(actorId, input.video_draft_id)),
    }),
  }),
  /* Analytics tools below take no actorId: a Studio owns exactly one set of
     platform accounts, so its metrics are deployment-wide rather than per-actor
     (each account runs its own container and database). The `_actorId` these
     handlers ignore is authorization already enforced in mcpResponse, not a
     forgotten ownership check. */
  studio_analytics_dashboard: tool({
    description: "Read an analytics dashboard section for the authenticated Studio.",
    schema: z.object({
      section: z.enum(["overview", "audience", "posts", "video"]).optional(),
      days: z.union([z.literal(1), z.literal(7), z.literal(30)]).optional(),
      locale: localeSchema.optional(),
    }),
    handler: (studio, _actorId, input) => studio.analytics.dashboard(input.section ?? "overview", input.days ?? 7, input.locale ?? "ru"),
  }),
  studio_analytics_post_archive: tool({
    description: "Read a page of post analytics archive.",
    schema: z.object({ offset: z.number().int().min(0).max(10_000).optional(), locale: localeSchema.optional() }),
    handler: (studio, _actorId, input) => studio.analytics.postArchive(input.offset ?? 0, input.locale ?? "ru"),
  }),
  studio_analytics_post_metrics: tool({
    description: "Read analytics for one published post.",
    schema: z.object({ post_id: positiveInt, locale: localeSchema.optional() }),
    handler: (studio, _actorId, input) => studio.analytics.postMetrics(input.post_id, input.locale ?? "ru"),
  }),
  studio_analytics_video_archive: tool({
    description: "Read a page of video analytics archive.",
    schema: z.object({ offset: z.number().int().min(0).max(10_000).optional(), locale: localeSchema.optional() }),
    handler: (studio, _actorId, input) => studio.analytics.videoArchive(input.offset ?? 0, input.locale ?? "ru"),
  }),
  studio_analytics_video_metrics: tool({
    description: "Read analytics for one video draft.",
    schema: z.object({ video_draft_id: positiveInt, locale: localeSchema.optional() }),
    handler: (studio, _actorId, input) => studio.analytics.videoMetrics(input.video_draft_id, input.locale ?? "ru"),
  }),
  studio_analytics_audience: tool({
    description: "Read the creator audience analysis.",
    schema: z.object({ locale: localeSchema.optional() }),
    handler: (studio, _actorId, input) => studio.analytics.audienceAnalysis(input.locale ?? "ru"),
  }),
};

const publicTools = [
  { name: "submit_feedback", description: feedbackToolDef.description, inputSchema: inputJsonSchema(feedbackToolDef.schema) },
];
/** What each Studio tool is called and whether it declares itself a mutation.
 * Published so the read-only half can be swept the way the operations catalog
 * is: a tool that says it only reads is checked against a database. */
export const studioToolCatalog = Object.entries(studioToolDefs).map(([name, def]) => ({
  name,
  mutates: Boolean((def as ToolDef).mutates),
}));

const studioTools = Object.entries(studioToolDefs).map(([name, def]) => ({
  name,
  description: def.description,
  inputSchema: inputJsonSchema(def.schema),
}));

/** Operations reach MCP as a projection of the same registry the CLI dispatches
 * from, so an agent diagnosing a delivery gap has the commands an operator has
 * — minus the ones the registry marks host-only. `ops_` keeps them apart from
 * the Studio authoring tools in a client's tool list. */
const OPS_TOOL_PREFIX = "ops_";

const opsToolNames = new Map(
  operationCatalog()
    .filter((entry) => entry.agent)
    .map((entry) => [`${OPS_TOOL_PREFIX}${entry.name.replace(/-/g, "_")}`, entry.name]),
);

const opsTools = [...opsToolNames].map(([toolName, operation]) => {
  const def = operationDef(operation) as OperationDef;
  return {
    name: toolName,
    description: def.note ? `${def.summary} (${def.note})` : def.summary,
    inputSchema: agentSchema(inputJsonSchema(def.schema)),
  };
});

/** `placeholder` is the CLI usage line's device — it renders `--ref post:160`,
 * and it carries the shell's quoting to do it. Published to an agent it reads
 * as a value to send, which is how `--text` came to advertise `"post text"`
 * with the quotes in it. The CLI keeps it; the wire does not get it. */
function agentSchema(schema: JsonObject): JsonObject {
  const properties = schema.properties as Record<string, JsonObject> | undefined;
  if (!properties) return schema;
  return {
    ...schema,
    properties: Object.fromEntries(
      Object.entries(properties).map(([field, property]) => {
        const { placeholder: _cli, ...rest } = property;
        return [field, rest];
      }),
    ),
  };
}

type JsonObject = Record<string, unknown>;

/** MCP is an adapter: all Studio commands delegate to the same application services as Telegram. */
export async function mcpResponse(
  backendDb: BackendDb,
  config: BackendConfig,
  body: unknown,
  clientKey: string,
  actorId: number | null,
  studio?: StudioServices,
): Promise<Record<string, unknown> | Record<string, unknown>[] | null> {
  // A batch is answered as a batch, minus the notifications in it, and an
  // all-notification batch draws no response at all. Rejecting the array
  // wholesale failed every request a batching client sent.
  if (Array.isArray(body)) {
    if (!body.length) return rpcError(null, -32600, "Invalid request");
    const answers: Record<string, unknown>[] = [];
    for (const entry of body) {
      const answer = await mcpResponse(backendDb, config, entry, clientKey, actorId, studio);
      if (answer) answers.push(...(Array.isArray(answer) ? answer : [answer]));
    }
    return answers.length ? answers : null;
  }
  if (!body || typeof body !== "object") return rpcError(null, -32600, "Invalid request");
  const request = body as JsonObject;
  // A notification carries no id and must draw no response at all — the
  // `notifications/initialized` every client sends right after the handshake
  // used to earn an "unknown method" error object back.
  if (request.id === undefined) return null;
  const id = request.id;
  if (request.method === "initialize")
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: "solo-publisher-studio-mcp", version: "2.1.0" },
      },
    };
  if (request.method === "tools/list")
    return { jsonrpc: "2.0", id, result: { tools: actorId ? [...publicTools, ...studioTools, ...opsTools] : publicTools } };
  if (request.method !== "tools/call") return rpcError(id, -32601, `Unknown method: ${String(request.method)}`);
  const params = object(request.params);
  const name = typeof params.name === "string" ? params.name : "";
  const args = object(params.arguments);
  try {
    if (name === "submit_feedback") return success(id, submitFeedback(backendDb, args, clientKey));
    if (!actorId) return rpcError(id, -32001, "Studio MCP authorization is required");
    const operation = opsToolNames.get(name);
    if (operation) return success(id, await runOpsTool(backendDb, config, operation, args));
    return success(id, await runStudioTool(backendDb, config, actorId, name, args, studio));
  } catch (error) {
    if (error instanceof McpToolError) return rpcError(id, error.code, error.message);
    return rpcError(id, -32603, error instanceof Error ? error.message : String(error));
  }
}

async function runStudioTool(
  backendDb: BackendDb,
  config: BackendConfig,
  actorId: number,
  name: string,
  args: JsonObject,
  studio?: StudioServices,
): Promise<unknown> {
  const def = (studioToolDefs as Record<string, ToolDef>)[name];
  if (!def) throw new McpToolError(-32601, `Unknown Studio tool: ${name}`);
  const resolvedStudio: StudioServices = studio ?? createStudioServices(backendDb, config);
  const input = parseArgs(def.schema, args);
  const result = await def.handler(resolvedStudio, actorId, input);
  // The mutation already happened. Reporting a journal failure as a tool
  // failure would invite the caller to retry it and publish twice, so the audit
  // trail is best-effort and the caller still sees the success it earned.
  if (def.mutates)
    try {
      backendDb.events.record({
        ref: def.ref ? def.ref(input, result) : null,
        type: "studio.mcp.command",
        severity: "info",
        target: "mcp",
        message: `Studio MCP ${name} executed`,
        details: { actorId, tool: name },
      });
    } catch (error) {
      log("error", "studio MCP audit event failed", { actorId, tool: name, error });
    }
  return result;
}

/** Dispatched through `runOperation`, the same entry the CLI uses: validating
 * here as well is how a rejected field on one surface becomes an accepted one
 * on the other, and the mutation journal is written there too, against the ref
 * the operation normalized. Only the error shape is MCP's — -32602 with the
 * field named. */
function runOpsTool(backendDb: BackendDb, config: BackendConfig, operation: string, args: JsonObject): Promise<unknown> {
  // The server owns this handle and this config; the operation borrows both and
  // must not close what it did not open.
  return runOperation(
    operation,
    { dbPath: config.PIPELINE_DB, config: () => config, db: () => backendDb, fetchImpl: fetch, actorType: "ops-mcp" },
    args,
  ).catch((error) => {
    if (error instanceof OperationInputError) throw new McpToolError(-32602, error.message);
    throw error;
  });
}

function submitFeedback(backendDb: BackendDb, args: JsonObject, clientKey: string): string {
  const input = parseArgs(feedbackToolDef.schema, args);
  const name = input.name || "Anonymous Agent";
  if (rateLimited(clientKey)) throw new McpToolError(-32000, "rate limit exceeded");
  backendDb.events.record({
    ref: "mcp:feedback",
    target: "mcp",
    type: "mcp.feedback.received",
    severity: "info",
    message: `MCP Feedback from ${name}: ${input.message}`,
  });
  return `Thank you, ${name}! Your feedback has been logged.`;
}

function success(id: unknown, value: unknown): Record<string, unknown> {
  // The same pass the logger and the CLI make. An agent reading a tool result
  // is one more place a provider's error body can carry a credential.
  return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: redactExternalSecrets(JSON.stringify(value)) }] } };
}

function object(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : {};
}

function rpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  // A failing operation reports what the provider said, which is where a
  // credential travels if one does.
  return { jsonrpc: "2.0", id, error: { code, message: redactExternalSecrets(message) } };
}

class McpToolError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

function rateLimited(key: string): boolean {
  const cutoff = Date.now() - 3_600_000;
  const hits = (feedbackHits.get(key) ?? []).filter((value) => value >= cutoff);
  if (hits.length >= 5) {
    feedbackHits.set(key, hits);
    return true;
  }
  hits.push(Date.now());
  feedbackHits.set(key, hits);
  for (const [otherKey, otherHits] of feedbackHits)
    if (otherHits.length === 0 || otherHits.every((value) => value < cutoff)) feedbackHits.delete(otherKey);
  return false;
}
