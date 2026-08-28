import * as z from "zod";
import { importManualAnalytics } from "../analytics/import-manual-analytics.js";
import { importXAnalyticsCsv } from "../analytics/import-x-csv.js";
import { xReachProbe } from "../analytics/reach/x-reach-probe.js";
import { attachXActivityToPosts } from "../analytics/x-activity-linking.js";
import { xAnalyticsReport } from "../analytics/x-activity-report.js";
import { deleteXImport } from "../analytics/x-import-delete.js";
import type { LocalizedProfiles, LocalizedText } from "../application/ports.js";
import { publicationRef } from "../application/publication-ref.js";
import { targetIdsFor } from "../botTargets.js";
import { API_KEY_TARGETS, storeApiKey } from "../channels/api-keys.js";
import { CONNECT_PLATFORMS, type ConnectStart, startConnect } from "../channels/connect.js";
import type { BackendDb } from "../db/client.js";
import type { BackendConfig } from "../foundation/config.js";
import { log } from "../foundation/logger.js";
import { checkDataDirectoriesWritable, requiredDataDirectories } from "../foundation/runtime/data-dirs.js";
import { capabilityReport } from "../observability/capabilities.js";
import { repairStoredDates } from "../observability/date-repair.js";
import { recordUsage, usageReport } from "../observability/usage.js";
import { publishArticle } from "../publishing/article-publish.js";
import { retryVideoTarget } from "../publishing/video-service.js";
import { settleVideoTarget } from "../publishing/video-settle.js";
import type { VideoTarget } from "../publishing/video-types.js";
import { createStudioServices } from "../studio/services/index.js";
import { streamService } from "../studio/services/streams.js";
import { exportStatus, streamDatabase, streamMediaArchive } from "./backup-export.js";
import { replacePublishedMedia } from "./commands/media-replacement.js";
import { runOperationCommand } from "./commands.js";
import { doctorChecks } from "./doctor.js";
import { formatSupportSummary, recordFormatEvidence } from "./format-support.js";
import { buildOperationsGuide, formatOperationsGuide, type OperationCatalogEntry } from "./guide.js";
import {
  cancelPostDraft,
  cancelVideoDraft,
  publishPostDraft,
  publishVideoDraft,
  schedulePostDraft,
  scheduleVideoDraft,
} from "./lifecycle.js";
import {
  applyMetricsBackfill,
  auditOperations,
  backupDatabase,
  buildMetricsBackfillPlan,
  publicationConsistencyReport,
  repairPublicationConsistency,
  restoreDatabase,
  withMaintenanceLock,
} from "./maintenance.js";
import { diagnoseMediaProcessor, mediaJobReport, mediaProcessorStatus, reprocessPostMedia } from "./media-processor.js";
import { formatPostText, postText } from "./post-text.js";
import { purgePublication } from "./publication-purge.js";
import { resolvePublicationRef } from "./publication-ref.js";
import { publishText } from "./publish.js";
import { findPublication, formatPublicationMatches, formatRecentPublications, recentPublications } from "./recent.js";
import { resumeTargetFrom } from "./resume-from.js";
import { settingsReport } from "./settings-report.js";
import { settleAmbiguousTarget } from "./settle.js";
import { backfillSiteImageMedia } from "./site-media-backfill.js";
import { deduplicateSiteMedia } from "./site-media-deduplicate.js";
import { skipPublicationTargets } from "./skip.js";
import { compactOperationsStatus } from "./status.js";
import { backfillTextStoryCards } from "./story-card-backfill.js";
import { loginTelegramStories } from "./telegram-stories-login.js";
import { authorizeThreads } from "./threads-authorize.js";
import { publicationTimeline } from "./timeline.js";
import { verifyPostTargets } from "./verify.js";

/** Config and the database are resolved on demand: `restore` operates on the
 * file itself and must not have it opened underneath it, and `guide` runs when
 * there is no usable database at all. */
export type OperationContext = {
  dbPath: string;
  config: () => BackendConfig;
  db: () => BackendDb;
  fetchImpl: typeof fetch;
  /** Which surface is running this, for the action journal. The registry is
   * shared, so an operation cannot know it and must be told. */
  actorType: string;
};

export type OperationDef<S extends z.ZodType = z.ZodType> = {
  summary: string;
  schema: S;
  mutates: boolean;
  note?: string;
  /** Projected as an MCP tool. Operations that move the database file, write
   * credentials, or read a path off the host stay CLI-only: an MCP caller is
   * remote, and none of those are meaningful — or safe — from there. */
  agent: boolean;
  handler: (context: OperationContext, input: z.infer<S>) => unknown | Promise<unknown>;
  /** Terminal rendering. Without one the result prints as JSON. */
  format?: (result: never) => string;
  /** The handler writes bytes to stdout itself. The CLI prints nothing after
   * it: a JSON summary appended to an archive corrupts the archive. */
  streams?: true;
  /** What the mutation journal attaches this run to. Defaults to the operation's
   * own normalized `--ref`; an operation whose subject no longer exists when it
   * returns says so by naming no ref. */
  journalRef?: (input: z.infer<S>) => string | null;
};

function operation<S extends z.ZodType>(def: OperationDef<S>): OperationDef<S> {
  return def;
}

// --- Shared option shapes -------------------------------------------------------

/** A usage line reading `--ref VALUE` is what sends a caller to `--ref 160`,
 * and the error it earns arrives one round-trip later. The placeholder is the
 * real invocation, and it reaches both the CLI usage line and the MCP schema. */
const example = <S extends z.ZodType>(schema: S, placeholder: string): S => schema.meta({ placeholder }) as S;

/** One line from whoever is running the command. Only operations that are off
 * the agent surface reach this, which is what makes blocking on a terminal an
 * acceptable thing for an operation to do. */
function ask(question: string): string {
  return (prompt(question) ?? "").trim();
}

/** Callers reach for the bare post number — it is what every other surface
 * shows them — so it is a spelling of the ref, not a mistake to reject. */
const refSpelling = (value: string): string => (/^\d+$/.test(value) ? publicationRef("post", Number(value)) : value);
const refOption = example(z.string().trim().min(1), "post:160").describe("publication ref").transform(refSpelling);
const applyOption = z.boolean().default(false).describe("perform the change; omitted it reports the plan only");
const draftOption = example(z.coerce.number().int().positive(), "232").describe("draft id");
const scheduleAtOption = example(z.string().trim().min(1), '"06.08.2026 08:00"').describe(
  "when to publish, in this Studio's time zone unless it carries an offset",
);
const scheduleLocaleOption = z.enum(["ru", "en", "both"]).optional().describe("which language to schedule; both by default");

/** A full instant, not whatever `Date` will swallow.
 *
 * `new Date("34Z")` is the first of January 2034, so a timestamp mangled on its
 * way through a shell arrived as a valid-looking moment and stamped a whole
 * import with it. Readings are keyed by the moment they were taken, so nothing
 * later corrected them: they simply sorted above every window and vanished from
 * the charts while every report still listed them. */
const isoInstant = z
  .string()
  .refine((value) => !Number.isNaN(Date.parse(value)) && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(value), {
    message: "must be a full ISO timestamp, for example 2026-08-27T14:01:34Z",
  });

/** A string this Studio publishes about itself, given as JSON keyed by language.
 * Both languages are always supplied: an option that merged into the stored
 * value would make clearing one language impossible to express. */
const localizedTextOption = (description: string) =>
  example(z.string(), '{"en":"Alex Getman","ru":"Алекс Гетман"}')
    .optional()
    .describe(description)
    .transform((value) => (value == null ? undefined : (JSON.parse(value) as LocalizedText)));
const localeOption = z.enum(["ru", "en"]).optional().describe("restrict to one language");
/** Which connected YouTube channel to act on. Unlike `localeOption` this is not
 * a filter: every call reaches exactly one channel, and the Russian one is the
 * one that streams. */
/** Non-empty wherever it is optional: `--target=` used to reach the dispatcher
 * as the empty string, which reads as "no target given" and silently widens the
 * command to every target the publication has. An option spelled with nothing
 * after it is a mistake, and the only safe reading of it is an error. */
const targetOption = example(z.string().trim().min(1).optional(), "x").describe("restrict to one delivery target");
const commaList = (what: string) => z.string().trim().min(1).optional().describe(`comma-separated ${what}`);
const targetList = example(z.string().trim().min(1), "threads_ru")
  .describe("comma-separated exact publication targets")
  .transform((value) => splitList(value) ?? []);

function splitList(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  const items = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (!items.length) throw new Error("a comma-separated option must name at least one value");
  return items;
}

const METRIC_BACKFILL_TARGETS = "telegram,threads_ru,threads_en,instagram_stories,instagram_stories_ru,telegram_stories";

/** The repair commands differ only in what they do to the scope they share, so
 * they share its shape too: which publication, which targets, and whether the
 * caller has seen that scope and wants it acted on. */
const repairSchema = <S extends z.ZodRawShape>(extra: S) =>
  z.object({ ref: refOption, target: targetOption, locale: localeOption, apply: applyOption, ...extra });

function runRepair(context: OperationContext, action: string, input: Record<string, unknown>): Promise<Record<string, unknown>> {
  const { ref, ...rest } = input as { ref: string } & Record<string, unknown>;
  return runOperationCommand(context.db(), { action, ref, actor_type: context.actorType, ...rest }, context.config(), context.fetchImpl);
}

// --- The catalog ----------------------------------------------------------------

const operationDefs = {
  guide: operation({
    summary: "Which route to run operations through, and the command catalog this build accepts.",
    schema: z.object({}),
    mutates: false,
    // Probes a host path and the launcher's local .env.local; neither is
    // meaningful to a remote caller.
    agent: false,
    note: "start here for any worker, queue, configuration or publication question",
    handler: (context) => buildOperationsGuide(context.dbPath, operationCatalog()),
    format: formatOperationsGuide,
  }),
  settings: operation({
    summary: "Studio settings as the bot screens hold them, and what the last daily news digests did.",
    note: "A failed digest records its error and is not due again for a day, so `runs` is where a missing digest is explained.",
    schema: z.object({}),
    mutates: false,
    agent: true,
    handler: (context) => settingsReport(context.db(), context.config()),
  }),
  "studio-profile": operation({
    summary: "What this Studio publishes as, its time zone, whether it serves a public site, and video timing.",
    schema: z.object({}),
    mutates: false,
    agent: true,
    handler: (context) => createStudioServices(context.db(), context.config()).settings.studioProfile(),
  }),
  "studio-profile-set": operation({
    summary: "Change this Studio's identity, time zone, public site switch or video timing.",
    note: "Takes effect on the next request; no restart. Only the options given are changed, and each locale-keyed option replaces both languages at once.",
    schema: z.object({
      timezone: example(z.string().trim().min(1), "Europe/Moscow").optional().describe("IANA zone for every displayed schedule time"),
      timezone_label: example(z.string().trim().min(1), "MSK").optional().describe("short suffix shown next to a time"),
      site_enabled: z.boolean().optional().describe("serve the public website, its feeds and sitemap"),
      prepare_lead_minutes: z.coerce.number().int().min(1).max(120).optional().describe("how long before a slot a video is prepared"),
      retention_hours: z.coerce.number().int().min(24).max(720).optional().describe("how long prepared media is kept"),
      name: localizedTextOption("this Studio's name, per language"),
      tagline: localizedTextOption("one-line description, per language"),
      about: localizedTextOption("longer description reaching llms.txt and structured data"),
      profiles: example(z.string(), '{"en":[{"label":"Telegram","url":"https://t.me/example"}],"ru":[]}')
        .optional()
        .describe("social profiles listed in llms.txt and as sameAs, per language")
        .transform((value) => (value == null ? undefined : (JSON.parse(value) as LocalizedProfiles))),
    }),
    mutates: true,
    agent: true,
    journalRef: () => "studio:profile",
    handler: (context, input) =>
      createStudioServices(context.db(), context.config()).settings.setStudioProfile({
        timezone: input.timezone,
        timezoneLabel: input.timezone_label,
        siteEnabled: input.site_enabled,
        prepareLeadMinutes: input.prepare_lead_minutes,
        retentionHours: input.retention_hours,
        name: input.name,
        tagline: input.tagline,
        about: input.about,
        profiles: input.profiles,
      }),
  }),
  live: operation({
    summary: "Every surface this Studio streams on, and what each is showing right now.",
    note: "Twitch carries a channel title that survives the stream ending; YouTube carries a broadcast that exists only around one. Between streams a YouTube channel has nothing to edit, which is the normal answer and not a failure.",
    schema: z.object({}),
    mutates: false,
    agent: true,
    handler: (context) => streamService(context.db(), context.config()).current(context.fetchImpl),
  }),
  "live-set": operation({
    summary: "Change the title or the description of the running stream, everywhere it is running.",
    note: "One line goes to every connected surface, and each answers for itself: Twitch takes a title off the air, YouTube has nothing to rename until a broadcast exists, and only YouTube has a description.",
    schema: z
      .object({
        title: example(z.string().trim().min(1), "Пилим бота в прямом эфире").describe("the new stream title").optional(),
        description: z.string().trim().describe("the new stream description, YouTube only").optional(),
      })
      .refine((input) => input.title !== undefined || input.description !== undefined, {
        message: "name a --title, a --description, or both",
      }),
    mutates: true,
    agent: true,
    handler: async (context, input) => {
      const streams = streamService(context.db(), context.config());
      return {
        ...(input.title === undefined ? {} : { title: await streams.apply("title", input.title, context.fetchImpl) }),
        ...(input.description === undefined
          ? {}
          : { description: await streams.apply("description", input.description, context.fetchImpl) }),
      };
    },
  }),
  "live-say": operation({
    summary: "Say one line in the chat of every stream that is on the air.",
    note: "It goes out as the channel and cannot be taken back, and it is never retried: neither platform offers a deduplication key, so a line that arrived twice is two lines an audience reads.",
    schema: z.object({ message: example(z.string().trim().min(1), "Погнали").describe("the chat message") }),
    mutates: true,
    agent: true,
    handler: (context, input) => streamService(context.db(), context.config()).apply("chat", input.message, context.fetchImpl),
  }),
  status: operation({
    summary: "Worker heartbeats, publication counts and metric schedule health.",
    schema: z.object({}),
    mutates: false,
    agent: true,
    handler: (context) => compactOperationsStatus(context.config(), context.db()),
  }),
  doctor: operation({
    summary: "Configuration, data directories and platform credentials for this deployment.",
    schema: z.object({}),
    mutates: false,
    agent: true,
    handler: (context) => {
      const config = context.config();
      const dataDirectories = checkDataDirectoriesWritable(requiredDataDirectories(config));
      const mediaExport = exportStatus(context.db(), "media");
      const { requiredChecks, checks } = doctorChecks(config, dataDirectories, mediaExport);
      const capabilities = capabilityReport(config, context.db());
      return {
        ok: Object.values(requiredChecks).every(Boolean) && capabilities.every((capability) => capability.status === "ready"),
        siteEnabled: config.studio.siteEnabled,
        video: config.studio.video,
        publicBaseUrl: config.PUBLIC_BASE_URL,
        checks,
        dataDirectories,
        mediaExport,
        capabilities,
      };
    },
  }),
  "dates-repair": operation({
    summary: "Make every stored date a date: normalise SQLite's own spelling, drop readings stamped with a moment that never happened.",
    schema: z.object({ apply: applyOption }),
    mutates: true,
    agent: true,
    note: "run when `audit` reports storedDates; fix whatever wrote them first, or they come back",
    handler: (context, input) => repairStoredDates(context.db(), input.apply),
  }),
  audit: operation({
    summary: "Failed jobs, stuck targets, publication inconsistencies across both pipelines, and stored dates that are not dates.",
    note: "event counts cover the last 30 days, reported as `eventsSince`; consistency, delivery state and `storedDates` are current, not windowed. A non-empty `storedDates` means a column is holding a value every query will compare as text and no report will show as wrong: fix the writer, then the rows",
    schema: z.object({}),
    mutates: false,
    agent: true,
    handler: (context) => auditOperations(context.db()),
  }),
  recent: operation({
    summary: "Recent posts with their delivery targets and the targets each one is missing.",
    schema: z.object({ limit: z.coerce.number().int().min(1).max(50).default(5).describe("how many posts to report") }),
    mutates: false,
    agent: true,
    note: "start here for a delivery gap",
    handler: (context, input) => recentPublications(context.db(), input.limit),
    format: formatRecentPublications,
  }),
  "post-text": operation({
    summary: "The full text of one publication, in both languages.",
    schema: z.object({ ref: refOption }),
    mutates: false,
    agent: true,
    note: "recent and find report a headline only; this is the whole copy",
    handler: (context, input) => postText(context.db(), input.ref),
    format: formatPostText,
  }),
  find: operation({
    summary: "Resolve a publication ref from a fragment of the post text.",
    schema: z.object({ query: example(z.string().min(1), "Astra").describe("text to search for") }),
    mutates: false,
    agent: true,
    handler: (context, input) => findPublication(context.db(), input.query),
    format: formatPublicationMatches,
  }),
  verify: operation({
    summary: "Fetch every published target of one publication and report whether it is really live.",
    schema: z.object({ ref: refOption }),
    mutates: false,
    agent: true,
    handler: (context, input) => verifyPostTargets(context.db(), input.ref),
  }),
  publish: operation({
    summary: "Create and queue one text publication for an exact target list.",
    schema: z.object({
      locale: z.enum(["ru", "en"]),
      targets: targetList,
      text: example(z.string().trim().min(1).max(20_000), '"post text"'),
    }),
    mutates: true,
    agent: true,
    handler: (context, input) => publishText(context.db(), context.config(), input),
  }),
  "article-publish": operation({
    summary: "Create and queue one long-form article from Markdown for an exact target list.",
    note: "The `# Title` heading becomes the article title and leaves the body; targets must be ones that carry articles.",
    schema: z.object({
      locale: z.enum(["ru", "en"]),
      targets: targetList,
      markdown: example(z.string().trim().min(1).max(200_000), '"# Title\n\nBody"'),
    }),
    mutates: true,
    agent: true,
    handler: (context, input) => publishArticle(context.db(), context.config(), input),
  }),
  timeline: operation({
    summary: "Jobs, targets and the full event log of one publication, in order.",
    schema: z.object({ ref: refOption }),
    mutates: false,
    agent: true,
    handler: (context, input) => publicationTimeline(context.db(), input.ref),
  }),
  channels: operation({
    summary: "Connected publishing channels and their credential state.",
    schema: z.object({}),
    mutates: false,
    agent: true,
    handler: (context) => createStudioServices(context.db(), context.config()).channels.report(false),
  }),
  "format-support": operation({
    summary: "Which media formats each target is proven to carry, and what proved it.",
    note: "About what a platform accepts, not about whether its credentials are ready — `doctor` answers that.",
    schema: z.object({}),
    mutates: false,
    agent: true,
    handler: (context) => formatSupportSummary(context.db()),
  }),
  usage: operation({
    summary: "Which features are exercised and which have gone unused.",
    note: "Each feature carries the window's totals, `recent` for the last 7 days of it, and `worstDay`, the day that failed most. A failure rate averaged over the window cannot tell an outage that ended from one still running: read `recent` before acting on `failures`. An `operations.NAME` key counts one command, whichever surface ran it, and every command appears even at zero.",
    schema: z.object({
      days: z.coerce.number().int().min(1).max(365).optional().describe("window to report over"),
      unused_days: z.coerce.number().int().min(1).max(365).optional().describe("age past which a feature counts as unused"),
    }),
    mutates: false,
    agent: true,
    handler: (context, input) =>
      usageReport(context.db(), {
        knownFeatures: operationUsageKeys(),
        ...(input.days === undefined ? {} : { days: input.days }),
        ...(input.unused_days === undefined ? {} : { unusedDays: input.unused_days }),
      }),
  }),
  "x-analytics": operation({
    summary:
      "What the X CSV imports hold: coverage, unlinked activity, and linkCandidates — items matching exactly one post but under the linker's 30-character bar, reported and never linked.",
    schema: z.object({ limit: z.coerce.number().int().min(1).max(100).default(10).describe("how many unlinked items to list") }),
    mutates: false,
    agent: true,
    note: "run after every import-x-analytics",
    handler: (context, input) => xAnalyticsReport(context.db(), input.limit),
  }),
  "x-reach": operation({
    summary: "The daily X reach bars the overview draws, computed here from this database.",
    schema: z.object({
      from: example(z.string().min(1), "ISO").describe("first moment of the window"),
      to: example(z.string().min(1), "ISO").describe("last moment of the window"),
      item: z.string().optional().describe("an X post id, to print its raw published_at and every reading of it"),
    }),
    mutates: false,
    agent: true,
    note: "use when a chart and a CSV disagree: this answers at the source, past the read model and the HTML cache",
    handler: (context, input) => xReachProbe(context.db(), input.from, input.to, context.config().TIMEZONE, input.item),
  }),
  "x-import-delete": operation({
    summary: "Remove one X CSV import and every reading it wrote, leaving its posts in place.",
    schema: z.object({ import: z.coerce.number().int().min(1).describe("the import id from x-analytics"), apply: applyOption }),
    mutates: true,
    agent: true,
    note: "for an import whose readings are stamped with a moment that never happened: a re-import cannot overwrite them",
    handler: (context, input) => deleteXImport(context.db(), input.import, input.apply),
  }),
  "x-relink": operation({
    summary: "Attach already-imported X activity to editorial posts and project its metrics.",
    schema: z.object({ apply: applyOption }),
    mutates: true,
    agent: true,
    note: "an import runs this itself; use it after the matching rule changes, because re-importing a byte-identical CSV will not re-link anything",
    handler: (context, input) => attachXActivityToPosts(context.db(), input.apply),
  }),
  "media-status": operation({
    summary: "Reachability and queue depth of the media processor.",
    schema: z.object({}),
    mutates: false,
    agent: true,
    handler: (context) => mediaProcessorStatus(context.config(), context.fetchImpl),
  }),
  "media-diagnose": operation({
    summary: "Deeper media processor probe: codecs, storage and round-trip.",
    schema: z.object({}),
    mutates: false,
    agent: true,
    handler: (context) => diagnoseMediaProcessor(context.config(), context.fetchImpl),
  }),
  "media-job": operation({
    summary: "Media assets and processing state behind one publication.",
    schema: z.object({ ref: refOption }),
    mutates: false,
    agent: true,
    handler: (context, input) => mediaJobReport(context.db(), input.ref),
  }),
  retry: operation({
    summary: "Queue a publication again for a target that never went out or failed.",
    schema: repairSchema({}),
    mutates: true,
    agent: true,
    note: "reports the targets in scope; `apply` queues them",
    handler: (context, input) => runRepair(context, "retry", input),
  }),
  edit: operation({
    summary: "Rewrite one locale's text, push it to the targets that can be edited and replace those that cannot.",
    schema: repairSchema({ text: example(z.string().min(1), '"new text"').describe("the replacement text") }),
    mutates: true,
    agent: true,
    note: "reports the targets in scope; `apply` rewrites them",
    handler: (context, input) => runRepair(context, "edit", input),
  }),
  "set-media": operation({
    summary: "Replace one locale's media from a JSON description, take the published targets down and publish them again.",
    schema: repairSchema({
      media_json: example(z.string().min(1), '[{"asset_id": 12}]').describe("media items, each naming file_id, local_path or asset_id"),
    }),
    mutates: true,
    // A media item may name `local_path`, which is a path on this host and
    // means nothing to a remote caller -- the same line `replace-media` sits on.
    agent: false,
    note: "reports the targets in scope; `apply` replaces and republishes them",
    handler: (context, input) => runRepair(context, "replace_media", input),
  }),
  "use-other-media": operation({
    summary: "Drop one locale's own media so it falls back to the other locale's, then publish it again.",
    schema: repairSchema({}),
    mutates: true,
    agent: true,
    note: "reports the targets in scope; `apply` republishes them",
    handler: (context, input) => runRepair(context, "use_other_media", input),
  }),
  delete: operation({
    summary: "Take a publication down from the targets that support remote deletion.",
    schema: repairSchema({ republish: z.boolean().default(false).describe("publish it again after taking it down") }),
    mutates: true,
    agent: true,
    note: "reports the targets in scope; `apply` deletes them",
    handler: (context, input) => runRepair(context, "delete", input),
  }),
  purge: operation({
    summary: "Permanently remove an already-absent Studio publication and all of its stored state.",
    schema: z.object({ ref: refOption, apply: applyOption }),
    mutates: true,
    agent: true,
    note: "reports every row in scope; set `apply` only after the remote publication is gone",
    // Purge has just deleted every event carrying this ref. Journalling the run
    // against it would put the first row of a fresh history back.
    journalRef: () => null,
    handler: (context, input) => purgePublication(context.db(), context.config(), input, context.fetchImpl),
  }),
  "resume-from": operation({
    summary: "Point a half-published target at the post it should finish onto, then let the retry write the rest.",
    note: "For a publication that goes out in more than one call and now names the wrong post, typically after a duplicate was removed by hand. The ordinary retry continues from whatever the job carries; this is how that is corrected. `apply` performs it.",
    schema: z.object({
      ref: refOption,
      target: example(z.string().trim().min(1), "threads_ru").describe("the unfinished delivery target"),
      external_id: example(z.string().trim().min(1), "18049...").describe("the post the remainder should be attached to"),
      apply: applyOption,
    }),
    mutates: true,
    agent: true,
    handler: (context, input) => {
      const backendDb = context.db();
      const resolved = resolvePublicationRef(backendDb, input.ref);
      if (!resolved) throw new Error(`publication not found: ${input.ref}`);
      return resumeTargetFrom(backendDb, {
        ref: resolved,
        target: input.target,
        externalId: input.external_id,
        apply: input.apply,
        actorType: context.actorType,
      });
    },
  }),
  "draft-publish": operation({
    summary: "Send a draft that is already written to every platform it has enabled, now.",
    note: "The `publish` command writes a new publication from text; this one publishes a draft that exists. `apply` performs it.",
    schema: z.object({ draft: draftOption, apply: applyOption }),
    mutates: true,
    agent: true,
    handler: (context, input) => publishPostDraft(context.db(), context.config(), { draftId: input.draft, apply: input.apply }),
  }),
  "draft-schedule": operation({
    summary: "Put a draft in the queue for a time instead of publishing it now.",
    note: "A bare wall clock is read in this Studio's time zone; an explicit offset is honoured as written. `reschedule` moves a publication that already has a plan. `apply` performs it.",
    schema: z.object({ draft: draftOption, at: scheduleAtOption, locale: scheduleLocaleOption, apply: applyOption }),
    mutates: true,
    agent: true,
    handler: (context, input) =>
      schedulePostDraft(context.db(), context.config(), {
        draftId: input.draft,
        at: input.at,
        ...(input.locale === undefined ? {} : { locale: input.locale }),
        apply: input.apply,
      }),
  }),
  "draft-cancel": operation({
    summary: "Call off a draft and everything of it still waiting in the queue.",
    note: "Nothing already delivered is touched; use `delete` for that. `apply` performs it.",
    schema: z.object({ draft: draftOption, apply: applyOption }),
    mutates: true,
    agent: true,
    handler: (context, input) => cancelPostDraft(context.db(), context.config(), { draftId: input.draft, apply: input.apply }),
  }),
  "video-publish": operation({
    summary: "Send a video draft to every platform it has chosen, now.",
    schema: z.object({ draft: draftOption, apply: applyOption }),
    mutates: true,
    agent: true,
    handler: (context, input) => publishVideoDraft(context.db(), context.config(), { draftId: input.draft, apply: input.apply }),
  }),
  "video-schedule": operation({
    summary: "Put every platform of a video draft in the queue for one time.",
    note: "One time for all of them, because a per-platform time is a picker on the card. `apply` performs it.",
    schema: z.object({ draft: draftOption, at: scheduleAtOption, apply: applyOption }),
    mutates: true,
    agent: true,
    handler: (context, input) =>
      scheduleVideoDraft(context.db(), context.config(), { draftId: input.draft, at: input.at, apply: input.apply }),
  }),
  "video-cancel": operation({
    summary: "Call off a video: its queue, its reminders, and the YouTube upload it may already have made.",
    note: "An upload YouTube already holds is kept private rather than deleted, and anything published needs removing by hand; the answer says which. `apply` performs it.",
    schema: z.object({ draft: draftOption, apply: applyOption }),
    mutates: true,
    agent: true,
    handler: (context, input) => cancelVideoDraft(context.db(), context.config(), { draftId: input.draft, apply: input.apply }),
  }),
  skip: operation({
    summary: "Finish a publication without a target that did not land, instead of retrying it.",
    note: "The other answer to what `retry` asks, and the one the bot has always had next to it. Nothing is sent and nothing is removed from a platform: the jobs stop asking to be dealt with and the publication settles. Omit `target` to give up on every target that did not land; `apply` performs it.",
    schema: z.object({
      ref: refOption,
      target: example(z.string().trim().min(1).optional(), "threads_ru").describe("one target to give up on, or every unlanded one"),
      apply: applyOption,
    }),
    mutates: true,
    agent: true,
    handler: (context, input) => {
      const backendDb = context.db();
      const resolved = resolvePublicationRef(backendDb, input.ref);
      if (!resolved) throw new Error(`publication not found: ${input.ref}`);
      return skipPublicationTargets(backendDb, {
        ref: resolved,
        ...(input.target === undefined ? {} : { target: input.target }),
        apply: input.apply,
        actorType: context.actorType,
      });
    },
  }),
  settle: operation({
    summary: "Answer a target stuck in verification_required with what the platform actually shows.",
    note: "Reconciliation resolves an ambiguous target by asking the platform about its stored id, so a worker lost before recording one leaves nothing to ask about. Name `external-id` to record the post as live, or omit it to report the post absent and queue it again; `apply` performs it.",
    schema: z.object({
      ref: refOption,
      target: example(z.string().trim().min(1), "threads_ru").describe("the ambiguous delivery target"),
      external_id: example(z.string().trim().min(1).optional(), "18049...").describe("the id the post has on the platform, if it is there"),
      url: example(z.string().trim().min(1).optional(), "https://...").describe("its public address, if it is there"),
      apply: applyOption,
    }),
    mutates: true,
    agent: true,
    handler: (context, input) => {
      const backendDb = context.db();
      const resolved = resolvePublicationRef(backendDb, input.ref);
      if (!resolved) throw new Error(`publication not found: ${input.ref}`);
      return settleAmbiguousTarget(backendDb, {
        ref: resolved,
        target: input.target,
        ...(input.external_id === undefined ? {} : { externalId: input.external_id }),
        ...(input.url === undefined ? {} : { url: input.url }),
        apply: input.apply,
        actorType: context.actorType,
      });
    },
  }),
  "video-retry": operation({
    summary: "Queue a failed video target again.",
    note: "Only a target that failed: a publication whose outcome is unknown is answered with `video-settle` first, because a retry of something that may have landed is a second post. The new attempt carries a new idempotency fence, so it can publish what the failed one never did.",
    schema: z.object({
      draft: example(z.coerce.number().int().positive(), "232").describe("video draft id"),
      target: example(z.string().trim().min(1), "instagram_reels").describe("video target"),
    }),
    mutates: true,
    agent: true,
    handler: (context, input) => {
      retryVideoTarget(context.db(), input.draft, input.target as VideoTarget);
      return { ref: publicationRef("video", input.draft), target: input.target, requeued: 1 };
    },
  }),
  "video-settle": operation({
    summary: "Answer a provider-delivered video target stuck awaiting verification.",
    note: "Asks the provider what became of the publication and records the answer: a platform link means published, a provider-side failure sends the target back to `failed` where a retry can pick it up, anything else stays awaiting verification. Give `external_id`/`url` to record what you can see on the platform yourself, which outranks what the provider says. Provider routes only: a native upload has no idempotent replay to ask with.",
    schema: z.object({
      draft: example(z.coerce.number().int().positive(), "232").describe("video draft id"),
      target: example(z.string().trim().min(1), "instagram_reels").describe("video target"),
      provider_post_id: example(z.string().trim().min(1), "6a80a5e0d45305ab4246ae2a").describe("the provider's own post id").optional(),
      external_id: example(z.string().trim().min(1), "DcEdQDZDCaq").describe("what the platform shows, when you can see it").optional(),
      url: example(z.string().trim().min(1), "https://www.instagram.com/reel/DcEdQDZDCaq/").describe("the live publication").optional(),
      apply: applyOption,
    }),
    mutates: true,
    agent: true,
    handler: (context, input) =>
      settleVideoTarget(
        context.config(),
        context.db(),
        {
          videoDraftId: input.draft,
          target: input.target,
          apply: input.apply,
          known: { providerPostId: input.provider_post_id, externalId: input.external_id, url: input.url },
        },
        context.fetchImpl,
      ),
  }),
  "refresh-site": operation({
    summary: "Re-render one locale's public page without touching social targets.",
    // The same shape as every other repair, because the Command Center's card
    // posts one field set for whichever repair is chosen and an operation that
    // refused a field would be the one the card cannot run. Two of them do
    // nothing here and say so: a public page is per locale, not per delivery
    // target, and there is no plan worth reporting when nothing public moves.
    schema: repairSchema({}).extend({
      target: targetOption.describe("accepted; a public page is not per target"),
      apply: z.boolean().default(true).describe("accepted; this repair always acts"),
    }),
    mutates: true,
    agent: true,
    handler: (context, input) => runRepair(context, "refresh_site", { ...input, apply: true }),
  }),
  "replace-media": operation({
    summary: "Swap the media of a published post on one target and re-render the site.",
    schema: z.object({
      ref: refOption,
      locale: z.enum(["ru", "en"]).describe("which language's media to replace"),
      file: example(z.string().min(1), "PATH").describe("image or MP4 path on this host"),
      target: example(z.string().min(1), "threads_en").describe("the delivery target to take down and publish again"),
      apply: applyOption,
    }),
    mutates: true,
    agent: false,
    note: "reports the target in scope; `apply` replaces it",
    handler: (context, input) => replacePublishedMedia(context.db(), context.config(), input, context.fetchImpl, context.actorType),
  }),
  reschedule: operation({
    summary: "Move a scheduled publication to another time.",
    schema: z.object({
      ref: refOption,
      schedule_locale: z.enum(["ru", "en", "both"]).describe("which language's schedule to move"),
      at: example(z.string().min(1), '"06.08.2026 08:00"').describe("in the configured timezone, or an ISO instant"),
    }),
    mutates: true,
    agent: true,
    handler: (context, input) =>
      runOperationCommand(
        context.db(),
        {
          action: "reschedule",
          ref: input.ref,
          actor_type: context.actorType,
          schedule_locale: input.schedule_locale,
          at: input.at,
        },
        context.config(),
        context.fetchImpl,
      ),
  }),
  "publication-repair": operation({
    summary: "Reconcile publication rows against their jobs and targets.",
    schema: z.object({
      ref: example(z.string().trim().min(1).optional(), "post:160")
        .describe("scope to one publication; omitted it sweeps everything")
        .transform((value) => (value === undefined ? undefined : refSpelling(value))),
      apply: applyOption,
    }),
    mutates: true,
    agent: true,
    note: "scoped repair is preferred",
    handler: (context, input) => {
      const backendDb = context.db();
      const options = input.ref ? { ref: input.ref } : undefined;
      const before = publicationConsistencyReport(backendDb, options);
      const repaired = input.apply ? repairPublicationConsistency(backendDb, options) : null;
      return {
        ...(input.ref ? { ref: input.ref } : {}),
        before,
        repaired,
        after: repaired ? publicationConsistencyReport(backendDb, options) : null,
      };
    },
  }),
  "media-reprocess": operation({
    summary: "Re-run media processing for one publication.",
    schema: z.object({ ref: refOption, apply: applyOption }),
    mutates: true,
    agent: true,
    handler: (context, input) => reprocessPostMedia(context.db(), context.config(), input.ref, input.apply),
  }),
  "story-card-backfill": operation({
    summary: "Render the story card a text publication is missing.",
    schema: z.object({ ref: refOption, apply: applyOption, force: z.boolean().default(false).describe("re-render an existing card") }),
    mutates: true,
    agent: true,
    handler: (context, input) => backfillTextStoryCards(context.db(), context.config(), input.ref, input.apply, input.force),
  }),
  "metrics-backfill": operation({
    summary: "Re-sample metrics for published targets over a date range.",
    schema: z.object({
      targets: commaList("delivery targets").describe(`comma-separated delivery targets (default: ${METRIC_BACKFILL_TARGETS})`),
      refs: commaList("publication refs"),
      from: example(z.string().optional(), "ISO").describe("date lower bound"),
      to: example(z.string().optional(), "ISO").describe("date upper bound"),
      apply: applyOption,
      reset_counts: z.boolean().default(false).describe("clear existing counts before re-sampling"),
    }),
    mutates: true,
    agent: true,
    handler: (context, input) => {
      const backendDb = context.db();
      const refs = splitList(input.refs)?.map(refSpelling);
      const plan = buildMetricsBackfillPlan(backendDb, {
        targets: splitList(input.targets) ?? METRIC_BACKFILL_TARGETS.split(","),
        ...(refs ? { refs } : {}),
        ...(input.from ? { dateFrom: input.from } : {}),
        ...(input.to ? { dateTo: input.to } : {}),
      });
      const applied = input.apply
        ? withMaintenanceLock(backendDb, () => applyMetricsBackfill(backendDb, context.config(), plan, input.reset_counts))
        : 0;
      return { count: plan.length, applied, plan };
    },
  }),
  backup: operation({
    summary: "Copy the database to a timestamped file.",
    schema: z.object({ output: example(z.string().optional(), "DIRECTORY").describe("destination directory") }),
    mutates: true,
    agent: false,
    handler: async (context, input) => ({ ok: true, path: await backupDatabase(context.db(), context.dbPath, input.output) }),
  }),
  "backup-stream": operation({
    summary: "Write one backup stream to stdout for a backup host to pull.",
    schema: z.object({
      what: example(z.enum(["media", "db"]).describe("media trees or the database"), "media"),
    }),
    mutates: false,
    agent: false,
    streams: true,
    note: "Nothing is written to this host: the stream is meant for `ssh <studio> ops backup-stream --what media > …` from the machine that keeps the backups. `doctor` fails once no media stream has been pulled for a week.",
    handler: async (context, input) =>
      input.what === "db"
        ? streamDatabase(context.db(), Bun.stdout.writer())
        : streamMediaArchive(context.config(), context.db(), "inherit"),
  }),
  restore: operation({
    summary: "Replace the database with a backup.",
    schema: z.object({ source: example(z.string().min(1), "PATH").describe("backup file to restore"), force: z.boolean().default(false) }),
    mutates: true,
    agent: false,
    note: "replaces the database",
    handler: (context, input) => {
      restoreDatabase(input.source, context.dbPath, input.force);
      return { ok: true, restored: context.dbPath };
    },
  }),
  "import-x-analytics": operation({
    summary: "Import an X analytics CSV export.",
    schema: z.object({
      file: example(z.string().min(1), "PATH").describe("CSV path on this host"),
      sampled_at: example(isoInstant, "ISO").describe(
        "when the export was taken: the file's own mtime in ISO UTC, never now — it stamps the metric history",
      ),
    }),
    mutates: true,
    agent: false,
    note: "a byte-identical file is a no-op by SHA-256, so a repeat costs nothing; it links the whole table afterwards, so an older export still reaches posts written since",
    handler: (context, input) => importXAnalyticsCsv(context.db(), input.file, input.sampled_at),
  }),
  "import-manual-analytics": operation({
    summary: "Import hand-collected audience numbers.",
    schema: z.object({
      x_file: example(z.string().optional(), "PATH").describe("X analytics CSV path on this host"),
      threads_ru_followers: z.coerce.number().int().min(0).optional(),
      threads_en_followers: z.coerce.number().int().min(0).optional(),
      sampled_at: example(z.string().optional(), "ISO").describe("defaults to now"),
    }),
    mutates: true,
    agent: false,
    handler: (context, input) =>
      importManualAnalytics(context.db(), {
        sampledAt: input.sampled_at ?? new Date().toISOString(),
        ...(input.x_file ? { xFile: input.x_file } : {}),
        ...(input.threads_ru_followers === undefined ? {} : { threadsRuFollowers: input.threads_ru_followers }),
        ...(input.threads_en_followers === undefined ? {} : { threadsEnFollowers: input.threads_en_followers }),
      }),
  }),
  "format-record": operation({
    summary: "Record the message that proves a target carries a media format.",
    schema: z.object({
      test: example(z.string().min(1), "T01").describe("format test id"),
      message_id: z.coerce.number().int().describe("message that demonstrates it"),
      notes: z.string().optional(),
    }),
    mutates: true,
    agent: false,
    handler: (context, input) => ({ ok: true, status: recordFormatEvidence(context.db(), input.test, input.message_id, input.notes) }),
  }),
  "site-media-images": operation({
    summary: "Upload site images that were never pushed to media storage.",
    schema: z.object({
      apply: applyOption,
      max_upload_kbps: z.coerce.number().int().min(1).max(6_250).optional().describe("throttle the upload"),
    }),
    mutates: true,
    agent: false,
    handler: (context, input) => backfillSiteImageMedia(context.db(), context.config(), input.apply, input.max_upload_kbps),
  }),
  "site-media-deduplicate": operation({
    summary: "Collapse identical assets in media storage.",
    schema: z.object({ apply: applyOption }),
    mutates: true,
    agent: false,
    handler: (context, input) => deduplicateSiteMedia(context.config(), input.apply),
  }),
  "channel-connect": operation({
    summary: "Connect a publishing route.",
    note: "A text or story route needs only `target`: it already names the platform and the language, and asking for them again is a way to store a channel that disagrees with itself. A video account needs `platform` with `locale`. An Instagram account connected for Reels does not carry the Story with it: connect `instagram_stories_ru` or `instagram_stories` when this Studio actually posts them, because a connected target is one the post screens offer and the queue waits for.",
    schema: z.object({
      platform: example(z.string().min(1), "youtube|instagram").describe("platform to connect").optional(),
      locale: z.enum(["ru", "en"]).optional(),
      provider: example(z.string().default("native"), "native|zernio").describe("delivery provider"),
      target: z.enum(targetIdsFor("post")).optional(),
      account_id: z.string().optional(),
      label: z.string().optional(),
    }),
    mutates: true,
    agent: true,
    handler: (context, input) => {
      // The target is the whole identity of a text or story route. Deriving
      // both from it removes the combination that stores one platform under
      // another one's id.
      const channels = createStudioServices(context.db(), context.config()).channels;
      if (input.target)
        return { id: channels.connectTarget(input.target, input.provider, input.account_id, input.label, context.actorType).id };
      const platform = input.platform;
      const locale = input.locale;
      if (!platform || !locale) throw new Error("channel-connect needs --target, or --platform with --locale");
      return {
        id: channels.connect(
          {
            platform,
            locale,
            provider: input.provider,
            ...(input.account_id ? { providerAccountId: input.account_id } : {}),
            ...(input.label ? { label: input.label } : {}),
          },
          context.actorType,
        ).id,
      };
    },
  }),
  "connect-link": operation({
    summary: "Start connecting an account, and say what has to happen next.",
    note: "Most platforms answer with a link to open, which carries a signed, short-lived state and authorizes nothing by itself. YouTube answers with an address and a code to type there, because Google's device flow is what a server with no browser can use; approval is picked up on its own within a minute and the account appears in the channel registry. Threads and Instagram need their app id and secret, X its client id and secret, YouTube its client id and secret for that language, and all of them TOKEN_ENCRYPTION_KEY.",
    schema: z.object({
      platform: z.enum(CONNECT_PLATFORMS).describe("platform to connect"),
      locale: z.enum(["ru", "en"]).default("ru").describe("which language's account, for platforms this Studio keeps two of"),
    }),
    mutates: true,
    agent: true,
    handler: (context, input) => startConnect(context.config(), context.db(), input.platform, input.locale, context.fetchImpl),
    format: (result: ConnectStart) =>
      result.kind === "redirect"
        ? `${result.url}\n\nOpen within ${result.expiresInMinutes} minutes.`
        : `${result.verificationUrl}\n\nEnter the code ${result.userCode} there within ${Math.round(result.expiresInSeconds / 60)} minutes. The connection completes on its own.`,
  }),
  "channel-disable": operation({
    summary: "Disable a channel, keeping its publication history attributable.",
    schema: z.object({
      channel: example(z.string().min(1), "youtube_ru").describe("channel id"),
    }),
    mutates: true,
    agent: true,
    handler: (context, input) => ({
      id: createStudioServices(context.db(), context.config()).channels.disable(input.channel).id,
      disabled: true,
    }),
  }),
  "credential-set": operation({
    summary: "Store an API key this Studio is handed rather than negotiates.",
    note: 'Reads the key from standard input, so it never appears in a command line or a shell history: `printf %s "$KEY" | ops credential-set --target zernio`. The key is checked against the service before it is stored, and .env is not consulted for it afterwards.',
    schema: z.object({ target: z.enum(API_KEY_TARGETS).describe("service the key belongs to") }),
    mutates: true,
    // Writes a credential, and reads it from the terminal running the command.
    agent: false,
    handler: async (context, input) => storeApiKey(context.config(), context.db(), input.target, await Bun.stdin.text(), context.fetchImpl),
    format: (result: { target: string; account: string }) => `${result.target} key stored (${result.account})`,
  }),
  "telegram-stories-login": operation({
    summary: "Sign this Studio's Stories account in and store its session.",
    note: "Telegram Stories are posted by a user, not a bot, so the credential is an MTProto session. Needs TELEGRAM_CHANNEL_STORIES_API_ID, _API_HASH and _SESSION set first; run it with a terminal attached (docker compose exec -it) because it asks for the phone number, the code Telegram sends, and the 2FA password if the account has one.",
    schema: z.object({}),
    // It writes a credential -- a session directory that can post as that
    // person. That the credential is a file rather than a row does not make
    // creating it a read, and every surface says "[MUTATION]" about it now, the
    // way it already did for `credential-set`.
    mutates: true,
    // Reads a phone number and a 2FA password from whoever runs it, and writes
    // a session that can post as that person.
    agent: false,
    handler: async (context) =>
      loginTelegramStories(context.config(), {
        phone: async () => ask("Phone number (with country code): "),
        code: async () => ask("Code Telegram just sent: "),
        password: async () => ask("Two-factor password (leave empty if unused): "),
      }),
  }),
  "threads-authorize": operation({
    summary: "Terminal fallback for obtaining a long-lived Threads token when the browser callback is unavailable.",
    note: "The normal path is Studio → Channels. This fallback needs THREADS_APP_ID and THREADS_APP_SECRET, prints a link, then asks for the redirect address. Run it with a terminal attached (docker compose exec -it).",
    schema: z.object({ locale: z.enum(["ru", "en"]) }),
    mutates: false,
    // Prints a credential that can post as the account.
    agent: false,
    handler: async (context, input) =>
      authorizeThreads(context.config(), input.locale, async () => ask("Address the consent screen redirected to: "), {
        fetchImpl: context.fetchImpl,
        onPrompt: (authorizeUrl, redirectUri) =>
          console.log(
            // This link deliberately carries no signed state, so the callback
            // refuses it and leaves the single-use code unspent for the
            // exchange below. The refusal page is the expected outcome here.
            `Open this and approve it as the account you publish from:\n${authorizeUrl}\n\nIt redirects to ${redirectUri}, which will report that the connection failed — that is expected on this path and the code is still good. Copy the whole address from the address bar.\n`,
          ),
      }),
  }),
} satisfies Record<string, OperationDef>;

export function operationDef(name: string): OperationDef | undefined {
  const defs = operationDefs as Record<string, OperationDef>;
  // Own properties only: a plain lookup answers `toString` and `constructor`
  // with something inherited from Object.prototype, and the caller gets an
  // internal type error instead of "unknown command".
  return Object.hasOwn(defs, name) ? defs[name] : undefined;
}

/** What the caller wrote is wrong, as opposed to the operation having failed.
 * MCP reports it as -32602 with the offending field named and the CLI prints
 * it; both come from this one parse rather than validating a second time. */
export class OperationInputError extends Error {}

export async function runOperation(name: string, context: OperationContext, args: unknown): Promise<unknown> {
  const def = operationDef(name);
  if (!def) throw new OperationInputError(`unknown command: ${name}`);
  // Zod strips what it does not know, so a misspelled `target` used to arrive
  // as no target at all and widen a scoped command to the whole publication.
  const fields = Object.keys((inputJsonSchema(def.schema).properties ?? {}) as JsonObject);
  const given = typeof args === "object" && args !== null ? Object.keys(args as JsonObject) : [];
  const unknown = given.filter((field) => !fields.includes(field));
  if (unknown.length)
    throw new OperationInputError(
      `${name}: unknown field${unknown.length > 1 ? "s" : ""} ${unknown.join(", ")}; accepts ${fields.join(", ") || "no arguments"}`,
    );
  const parsed = def.schema.safeParse(args);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue?.path.join(".");
    throw new OperationInputError(`${name}: ${path ? `${path}: ` : ""}${issue?.message ?? "invalid arguments"}`);
  }
  const startedAt = Date.now();
  let result: unknown;
  try {
    result = await def.handler(context, parsed.data);
  } catch (error) {
    recordUsage(context.db(), operationUsageKey(name), false, Date.now() - startedAt);
    throw error;
  }
  // Measured around the handler alone: a caller's typo is rejected above, and
  // counting it would make an operator's misspelling look like a command that
  // fails. Recorded here rather than at each surface, because this is the one
  // place every surface passes through -- and the CLI, which is where most of
  // these are actually run, left no trace at all before it.
  recordUsage(context.db(), operationUsageKey(name), true, Date.now() - startedAt);
  if (def.mutates) journalMutation(context, name, def, parsed.data);
  return result;
}

/** The usage key of one operation. Named here, next to the catalog it is built
 * from, so the report never carries a hand-written copy of these names. */
function operationUsageKey(name: string): string {
  return `operations.${name}`;
}

/** Every operation, including the ones nobody has run: a command that is never
 * called is exactly what the report is asked for. */
export function operationUsageKeys(): string[] {
  return Object.keys(operationDefs).map(operationUsageKey);
}

/** Every mutation reaches the journal from here, so the record of what changed
 * the database does not depend on which surface the operator reached for, and
 * the ref it carries is the normalized one the handler actually ran against.
 * Best-effort: the mutation already happened, and reporting a failed journal
 * write as a failed operation invites a retry that publishes twice. */
function journalMutation(context: OperationContext, name: string, def: OperationDef, input: unknown): void {
  try {
    context.db().events.record({
      ref: def.journalRef ? def.journalRef(input as never) : refOf(input),
      type: "operations.command",
      severity: "info",
      target: context.actorType,
      message: `Operations ${name} executed`,
      details: { operation: name, surface: context.actorType },
    });
  } catch (error) {
    log("error", "operations audit event failed", { operation: name, surface: context.actorType, error });
  }
}

function refOf(input: unknown): string | null {
  const ref = (input as { ref?: unknown } | null)?.ref;
  return typeof ref === "string" ? ref : null;
}

// --- Projections ----------------------------------------------------------------

type JsonObject = Record<string, unknown>;

/** A tool's client-facing schema, stripped of the document-level `$schema` key.
 * The same JSON Schema an MCP client validates against is what the CLI usage
 * line and its option list are derived from, so every surface describes one shape.
 * Described as input because that is what a caller sends: a coerced field has a
 * different output type, and publishing that would document the wrong shape. */
export function inputJsonSchema(schema: z.ZodType): JsonObject {
  const { $schema: _dropped, ...rest } = z.toJSONSchema(schema, { io: "input" }) as JsonObject & { $schema?: unknown };
  return rest;
}

/** `--kebab-case` is the CLI spelling of a snake_case schema field. */
function optionFlag(field: string): string {
  return field.replace(/_/g, "-");
}

/** Derived, never hand-written: a usage line that drifts from the schema it
 * documents is how an operator learns the wrong invocation. */
export function operationUsage(name: string, def: OperationDef): string {
  const schema = inputJsonSchema(def.schema);
  const properties = (schema.properties ?? {}) as Record<string, JsonObject>;
  const required = new Set((schema.required as string[] | undefined) ?? []);
  const parts = Object.entries(properties).map(([field, property]) => {
    const flag = optionFlag(field);
    const enumValues = property.enum as string[] | undefined;
    const placeholder = (property.placeholder as string | undefined) ?? (enumValues ? enumValues.join("|") : "VALUE");
    const token =
      property.type === "boolean" ? `--${flag}` : property.type === "array" ? `--${flag} ${placeholder} ...` : `--${flag} ${placeholder}`;
    return required.has(field) ? token : `[${token}]`;
  });
  return [name, ...parts].join(" ");
}

export function operationCatalog(): OperationCatalogEntry[] {
  return Object.entries(operationDefs as Record<string, OperationDef>).map(([name, def]) => ({
    name,
    usage: operationUsage(name, def),
    mutates: def.mutates,
    agent: def.agent,
    summary: def.summary,
    ...(def.note ? { note: def.note } : {}),
  }));
}
