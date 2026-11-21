//! The operations registry (`operations/registry.ts`): one table of every
//! operation. The CLI dispatch, the `--help` and `guide` catalogs and the
//! `ops_*` MCP tools are projections of it — adding an entry is the whole
//! change, and a usage string is never written by hand.

use std::sync::LazyLock;
use std::time::Instant;

use domain::application::ports::{DomainEventInput, Severity};
use domain::repositories::record_event;
use foundation::logger::{LogLevel, log};
use serde_json::{Map, Value, json};

use crate::context::{Fut, Input, OpError, OpResult, OperationContext};
use crate::guide::{OPERATION_SECTIONS, Section};
use crate::handlers::{admin, commands, lifecycle, media, reads};
use crate::schema::{Field, ParseError, Schema, Transform, boolean, coerce_number, enumeration, object, string};

/// Every handler runs as a future; a synchronous one is a ready future.
pub type Handler = for<'a> fn(&'a OperationContext<'a>, &'a Input) -> Fut<'a, OpResult>;
/// Terminal rendering. Without one the result prints as JSON.
pub type Formatter = fn(&Value) -> String;

/// What the mutation journal attaches a run to.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum JournalRef {
    /// The operation's own normalized `ref`.
    Input,
    /// A fixed ref, or none: an operation whose subject no longer exists when
    /// it returns says so by naming no ref.
    Fixed(Option<&'static str>),
}

pub struct OperationDef {
    pub name: &'static str,
    pub summary: &'static str,
    /// Which part of the catalog this is read in.
    pub section: Section,
    /// The question this command is the answer to the start of.
    pub start_here: Option<&'static str>,
    pub schema: Schema,
    pub mutates: bool,
    pub note: Option<&'static str>,
    /// Projected as an MCP tool.
    pub agent: bool,
    /// Runs before a database is available, so database-backed usage is unavailable too.
    pub database_independent: bool,
    pub handler: Handler,
    pub format: Option<Formatter>,
    /// The handler writes bytes to stdout itself; the CLI prints nothing after it.
    pub streams: bool,
    pub journal_ref: JournalRef,
    /// The handler commits its journal event in the same transaction as the
    /// audience mutation, so the registry must not add a second best-effort row.
    pub journals_in_handler: bool,
}

struct Def(OperationDef);

fn op(name: &'static str, section: Section, summary: &'static str, schema: Schema, handler: Handler) -> Def {
    Def(OperationDef {
        name,
        summary,
        section,
        start_here: None,
        schema,
        mutates: false,
        note: None,
        agent: false,
        database_independent: false,
        handler,
        format: None,
        streams: false,
        journal_ref: JournalRef::Input,
        journals_in_handler: false,
    })
}

impl Def {
    fn mutates(mut self) -> Self {
        self.0.mutates = true;
        self
    }
    fn agent(mut self) -> Self {
        self.0.agent = true;
        self
    }
    fn note(mut self, note: &'static str) -> Self {
        self.0.note = Some(note);
        self
    }
    fn start_here(mut self, question: &'static str) -> Self {
        self.0.start_here = Some(question);
        self
    }
    fn format(mut self, format: Formatter) -> Self {
        self.0.format = Some(format);
        self
    }
    fn streams(mut self) -> Self {
        self.0.streams = true;
        self
    }
    fn database_independent(mut self) -> Self {
        self.0.database_independent = true;
        self
    }
    fn journal_ref(mut self, journal_ref: Option<&'static str>) -> Self {
        self.0.journal_ref = JournalRef::Fixed(journal_ref);
        self
    }
    fn journals_in_handler(mut self) -> Self {
        self.0.journals_in_handler = true;
        self
    }
}

// --- Shared option shapes -------------------------------------------------------

const LOCALES: &[&str] = &["ru", "en"];
const SCHEDULE_LOCALES: &[&str] = &["ru", "en", "both"];
/// `targetIdsFor("post")`.
pub const POST_TARGETS: &[&str] = &[
    "telegram",
    "site_ru",
    "site_en",
    "threads_ru",
    "threads_en",
    "x",
    "discord",
    "telegram_stories",
    "instagram_stories_ru",
    "instagram_stories",
];
/// `CONNECT_PLATFORMS`.
pub const CONNECT_PLATFORMS: &[&str] = &["threads", "instagram", "x", "youtube"];
/// `API_KEY_TARGETS`.
pub const API_KEY_TARGETS: &[&str] = &["zernio", "discord"];

fn ref_option() -> Field {
    string()
        .trim()
        .min(1.0)
        .example("post:160")
        .describe("publication ref")
        .transform(Transform::RefSpelling)
}

fn apply_option() -> Field {
    boolean()
        .default(json!(false))
        .describe("perform the change; omitted it reports the plan only")
}

fn draft_option() -> Field {
    coerce_number().int().positive().example("232").describe("draft id")
}

fn schedule_at_option() -> Field {
    string()
        .trim()
        .min(1.0)
        .example("\"06.08.2026 08:00\"")
        .describe("when to publish, in this Studio's time zone unless it carries an offset")
}

fn schedule_locale_option() -> Field {
    enumeration(SCHEDULE_LOCALES)
        .optional()
        .describe("which language to schedule; both by default")
}

fn iso_instant() -> Field {
    string().refine(
        foundation::time::is_iso_instant,
        "must be a full ISO timestamp, for example 2026-08-27T14:01:34Z",
    )
}

fn localized_text_option(description: &'static str) -> Field {
    string()
        .example("{\"en\":\"Alex Getman\",\"ru\":\"Алекс Гетман\"}")
        .optional()
        .describe(description)
        .transform(Transform::JsonParse)
}

fn locale_option() -> Field {
    enumeration(LOCALES).optional().describe("restrict to one language")
}

/// Non-empty wherever it is optional: `--target=` is a mistake, not "no target".
fn target_option() -> Field {
    string()
        .trim()
        .min(1.0)
        .optional()
        .example("x")
        .describe("restrict to one delivery target")
}

fn target_list() -> Field {
    string()
        .trim()
        .min(1.0)
        .example("threads_ru")
        .describe("comma-separated exact publication targets")
        .transform(Transform::SplitList)
}

/// The repair commands share their scope's shape: which publication, which
/// targets, and whether the caller has seen that scope and wants it acted on.
fn repair_schema(extra: Vec<(&'static str, Field)>) -> Schema {
    let mut fields = vec![
        ("ref", ref_option()),
        ("target", target_option()),
        ("locale", locale_option()),
        ("apply", apply_option()),
    ];
    fields.extend(extra);
    object(fields)
}

fn video_draft_option() -> Field {
    coerce_number()
        .int()
        .positive()
        .example("232")
        .describe("video draft id")
}

fn video_target_option() -> Field {
    string()
        .trim()
        .min(1.0)
        .example("instagram_reels")
        .describe("video target")
}

// --- The catalog ----------------------------------------------------------------

#[rustfmt::skip]
fn definitions() -> Vec<OperationDef> {
    use Section::{Channels, Delivery, Health, Host, Media, Studio};
    let defs = vec![
        op("guide", Health, "Which route to run operations through, and the command catalog this build accepts.",
            object(vec![
                ("section", enumeration(OPERATION_SECTIONS).optional().describe("expand one section into full entries")),
                ("all", boolean().default(json!(false)).describe("expand every section at once")),
            ]),
            guide_handler)
            .database_independent()
            .note("start here for any worker, queue, configuration or publication question; it answers with routes and section names; `--section` expands commands and symptoms, and `--all` reads the full catalog")
            .format(crate::guide::format_guide),
        op("settings", Studio, "Studio settings as the bot screens hold them, and what the last daily news digests did.",
            object(vec![]), reads::settings)
            .note("A failed digest records its error and is not due again for a day, so `runs` is where a missing digest is explained.")
            .agent(),
        op("studio-profile", Studio, "What this Studio publishes as, where it publishes by default, its time zone, public site switch and video timing.",
            object(vec![]), reads::studio_profile)
            .agent(),
        op("studio-profile-set", Studio, "Change this Studio's identity, time zone, public site switch or video timing.",
            object(vec![
                ("timezone", string().trim().min(1.0).example("Europe/Moscow").optional().describe("IANA zone for every displayed schedule time")),
                ("timezone_label", string().trim().min(1.0).example("MSK").optional().describe("short suffix shown next to a time")),
                ("site_enabled", boolean().optional().describe("serve the public website, its feeds and sitemap")),
                ("prepare_lead_minutes", coerce_number().int().min(1.0).max(120.0).optional().describe("how long before a slot a video is prepared")),
                ("retention_hours", coerce_number().int().min(24.0).max(720.0).optional().describe("how long prepared media is kept")),
                ("name", localized_text_option("this Studio's name, per language")),
                ("tagline", localized_text_option("one-line description, per language")),
                ("about", localized_text_option("longer description reaching llms.txt and structured data")),
                ("bio", localized_text_option("the About page text, per language; blank lines separate paragraphs")),
                ("site_timezone", localized_text_option("IANA zone the public site dates posts in, per language; blank uses the operator's timezone")),
                ("profiles", string().example("{\"en\":[{\"label\":\"Telegram\",\"url\":\"https://t.me/example\"}],\"ru\":[]}").optional()
                    .describe("social profiles listed in llms.txt and as sameAs, per language").transform(Transform::JsonParse)),
            ]),
            reads::studio_profile_set)
            .note("Takes effect on the next request; no restart. Only the options given are changed, and each locale-keyed option replaces both languages at once.")
            .mutates()
            .journal_ref(Some("studio:profile")),
        op("analytics-export", Channels, "Export existing social read credentials into a private statistics collector.",
            object(vec![]), admin::analytics_export)
            .note("CLI only. Stdout contains credentials: pipe it directly into the receiver, never a terminal or log. This reads the resolved runtime credentials and changes no channels or publications. X credentials remain with publishing; the statistics collector needs a separate authorization.")
            .streams(),
        op("youtube-export", Channels, "Export one YouTube connection directly into another private process.",
            object(vec![("locale", enumeration(LOCALES))]), admin::youtube_export)
            .note("CLI only. Stdout contains client_id, client_secret and refresh_token; pipe it into the receiving credential importer, never a terminal or a log. Uses the same runtime configuration as publishing, including the encrypted stored token.")
            .streams(),
        op("status", Health, "Health summary, worker problems and publication counts; details adds all worker heartbeats and timestamps.",
            object(vec![("details", boolean().default(json!(false)).describe("include all worker records and diagnostic timestamps"))]),
            reads::status)
            .start_here("is this deployment alive and are its workers running")
            .agent(),
        op("doctor", Health, "Configuration, data directories and platform credentials for this deployment.",
            object(vec![]), admin::doctor)
            .start_here("a fresh deployment is not working")
            .agent(),
        op("deployments", Health, "What every deployment this host drives is running, and the release each would roll back to.",
            object(vec![]), admin::deployments)
            .start_here("which revision is actually running, and what a rollback would go back to")
            .note("Asked of the deploy agent, not of this database: `status` reports the revision this container was built from, which is the same answer only when the deployment succeeded. A target mid-rollout reports `deploying`.")
            .agent(),
        op("dates-repair", Health, "Make every stored date a date: normalise SQLite's own spelling, drop readings stamped with a moment that never happened.",
            object(vec![("apply", apply_option())]), admin::dates_repair)
            .mutates()
            .note("run when `audit` reports storedDates; fix whatever wrote them first, or they come back"),
        op("audit", Health, "Failed jobs, stuck targets, publication inconsistencies across both pipelines, and stored dates that are not dates.",
            object(vec![]), admin::audit)
            .start_here("something is failing and it is not clear what")
            .note("event counts cover the last 30 days, reported as `eventsSince`; consistency, delivery state and `storedDates` are current, not windowed. A non-empty `storedDates` means a column is holding a value every query will compare as text and no report will show as wrong: fix the writer, then the rows")
            .agent(),
        op("events", Health, "The journal itself: what was recorded, filtered by family, severity, publication or time.",
            object(vec![
                ("since", iso_instant().example("2026-08-27T14:01:34Z").optional().describe("only events at or after this instant")),
                ("type", string().trim().min(1.0).example("mcp.").optional().describe("event type, or a prefix of one")),
                ("severity", enumeration(&["info", "warn", "error"]).optional().describe("restrict to one severity")),
                ("ref", ref_option().optional()),
                ("limit", coerce_number().int().min(1.0).max(500.0).default(json!(50)).describe("how many of the newest to return")),
            ]),
            reads::events)
            .start_here("a bug report was filed, or the journal recorded something and nothing shows it")
            .note("`audit` counts the delivery window and `timeline` reads one publication; this reads everything else, which is where a feedback report, a restart loop and a token expiry warning land. `--type` matches a prefix, so `runtime.` or `mcp.` reads a whole family.")
            .agent(),
        op("video-library", Media, "Read video scripts, game cards and publication links for the author's library.",
            object(vec![]), reads::video_library)
            .note("Read-only snapshot for Family: operator means the author's original script; other sources are transcripts, not evidence of the planned wording. Includes unpublished drafts with their status. No credentials, media files or delivery controls. Performance statistics belong to Family.")
            .agent(),
        op("video-script", Media, "Store the script a video was written from, from a file on this host or from text.",
            object(vec![
                ("ref", ref_option()),
                ("file", string().optional().example("PATH").describe("a .txt or .md file on this host")),
                ("text", string().optional().describe("the script itself, when it is not in a file")),
                ("source", enumeration(&["operator", "transcript"]).default(json!("operator"))
                    .describe("what this text is: what was written to be said, or what a machine heard afterwards")),
            ]),
            lifecycle::video_script)
            .note("The bot is where Maru attaches one at publishing time; this is the same store, for scripts that already exist somewhere else. Say which it is with `source`: a transcript is what was heard, a script is what was planned, and only one of them is evidence about the words that were chosen.")
            .mutates(),
        op("recent", Delivery, "Recent posts with their delivery targets and the targets each one is missing.",
            object(vec![("limit", coerce_number().int().min(1.0).max(50.0).default(json!(5)).describe("how many posts to report"))]),
            reads::recent)
            .start_here("a post did not reach a target")
            .agent()
            .note("start here for a delivery gap")
            .format(reads::format_recent),
        op("post-text", Delivery, "The full text of one publication, in both languages.",
            object(vec![("ref", ref_option())]), reads::post_text)
            .agent()
            .note("recent and find report a headline only; this is the whole copy")
            .format(reads::format_post_text),
        op("find", Delivery, "Resolve a publication ref from a fragment of the post text.",
            object(vec![("query", string().min(1.0).example("Astra").describe("text to search for"))]), reads::find)
            .start_here("only a fragment of the post text is known")
            .agent()
            .format(reads::format_find),
        op("verify", Delivery, "Fetch every published target of one publication and report whether it is really live.",
            object(vec![("ref", ref_option())]), reads::verify)
            .agent(),
        op("publish", Delivery, "Create and queue one text publication for an exact target list.",
            object(vec![
                ("locale", enumeration(LOCALES)),
                ("targets", target_list()),
                ("text", string().trim().min(1.0).max(20_000.0).example("\"post text\"")),
            ]),
            lifecycle::publish)
            .mutates()
            .agent(),
        op("article-publish", Delivery, "Create and queue one long-form article from Markdown for an exact target list.",
            object(vec![
                ("locale", enumeration(LOCALES)),
                ("targets", target_list()),
                ("markdown", string().trim().min(1.0).max(200_000.0).example("\"# Title\n\nBody\"")),
            ]),
            lifecycle::article_publish)
            .note("The `# Title` heading becomes the article title and leaves the body; targets must be ones that carry articles.")
            .mutates()
            .agent(),
        op("timeline", Delivery, "Jobs, targets and the full event log of one publication, in order.",
            object(vec![("ref", ref_option())]), reads::timeline)
            .start_here("what happened to one publication, in order")
            .agent(),
        op("channels", Channels, "Connected publishing channels and their credential state.",
            object(vec![]), reads::channels)
            .start_here("a target publishes nothing, or an account will not connect")
            .agent(),
        op("format-support", Channels, "Which media formats each target is proven to carry, and what proved it.",
            object(vec![]), reads::format_support)
            .note("About what a platform accepts, not about whether its credentials are ready — `doctor` answers that.")
            .agent(),
        op("usage", Health, "Which features are exercised and which have gone unused.",
            object(vec![
                ("days", coerce_number().int().min(1.0).max(365.0).optional().describe("window to report over")),
                ("unused_days", coerce_number().int().min(1.0).max(365.0).optional().describe("age past which a feature counts as unused")),
            ]),
            reads::usage)
            .start_here("which commands and features are actually being used")
            .note("Each feature carries the window's totals, `recent` for the last 7 days of it, and `worstDay`, the day that failed most. A failure rate averaged over the window cannot tell an outage that ended from one still running: read `recent` before acting on `failures`. An `operations.NAME` key counts one command, whichever surface ran it, and every command appears even at zero.")
            .agent(),
        op("media-status", Media, "Reachability and queue depth of the media processor.",
            object(vec![]), media::media_status)
            .start_here("media is not being processed")
            .agent(),
        op("media-diagnose", Media, "Deeper media processor probe: codecs, storage and round-trip.",
            object(vec![]), media::media_diagnose)
            .agent(),
        op("media-job", Media, "Media assets and processing state behind one publication.",
            object(vec![("ref", ref_option())]), media::media_job)
            .agent(),
        op("retry", Delivery, "Queue a publication again for a target that never went out or failed.",
            repair_schema(vec![]), commands::retry)
            .mutates()
            .journals_in_handler()
            .agent()
            .note("reports the targets in scope; `apply` queues them"),
        op("edit", Delivery, "Rewrite one locale's text, push it to the targets that can be edited and replace those that cannot.",
            repair_schema(vec![
                ("text", string().min(1.0).example("\"new text\"").describe("the replacement text")),
                ("entities_json", string().optional().describe("reviewed formatting entities for the replacement site text")),
                ("expected_text_sha256", string().regex("^[a-f0-9]{64}$").optional().describe("refuse an edit if the published text changed")),
            ]),
            commands::edit)
            .mutates()
            .journals_in_handler()
            .agent()
            .note("reports the targets in scope; `apply` rewrites them"),
        op("set-media", Delivery, "Replace one locale's media from a JSON description, take the published targets down and publish them again.",
            repair_schema(vec![
                ("media_json", string().min(1.0).example("[{\"asset_id\": 12}]").describe("media items, each naming file_id, local_path or asset_id")),
            ]),
            commands::set_media)
            .mutates()
            .journals_in_handler()
            .note("reports the targets in scope; `apply` replaces and republishes them"),
        op("use-other-media", Delivery, "Drop one locale's own media so it falls back to the other locale's, then publish it again.",
            repair_schema(vec![]), commands::use_other_media)
            .mutates()
            .journals_in_handler()
            .agent()
            .note("reports the targets in scope; `apply` republishes them"),
        op("delete", Delivery, "Take a publication down from the targets that support remote deletion.",
            repair_schema(vec![("republish", boolean().default(json!(false)).describe("publish it again after taking it down"))]),
            commands::delete)
            .mutates()
            .journals_in_handler()
            .agent()
            .note("reports the targets in scope; `apply` deletes them"),
        op("purge", Delivery, "Permanently remove an already-absent Studio publication and all of its stored state.",
            object(vec![("ref", ref_option()), ("apply", apply_option())]), commands::purge)
            .mutates()
            .note("reports every row in scope; set `apply` only after the remote publication is gone")
            .journal_ref(None),
        op("resume-from", Delivery, "Point a half-published target at the post it should finish onto, then let the retry write the rest.",
            object(vec![
                ("ref", ref_option()),
                ("target", string().trim().min(1.0).example("threads_ru").describe("the unfinished delivery target")),
                ("external_id", string().trim().min(1.0).example("18049...").describe("the post the remainder should be attached to")),
                ("apply", apply_option()),
            ]),
            commands::resume_from)
            .note("For a publication that goes out in more than one call and now names the wrong post, typically after a duplicate was removed by hand. The ordinary retry continues from whatever the job carries; this is how that is corrected. `apply` performs it.")
            .mutates()
            .agent(),
        op("draft-publish", Delivery, "Send a draft that is already written to every platform it has enabled, now.",
            object(vec![("draft", draft_option()), ("apply", apply_option())]), lifecycle::draft_publish)
            .note("The `publish` command writes a new publication from text; this one publishes a draft that exists. `apply` performs it.")
            .mutates()
            .agent(),
        op("draft-schedule", Delivery, "Put a draft in the queue for a time instead of publishing it now.",
            object(vec![
                ("draft", draft_option()),
                ("at", schedule_at_option()),
                ("locale", schedule_locale_option()),
                ("apply", apply_option()),
            ]),
            lifecycle::draft_schedule)
            .note("A bare wall clock is read in this Studio's time zone; an explicit offset is honoured as written. `reschedule` moves a publication that already has a plan. `apply` performs it.")
            .mutates()
            .agent(),
        op("draft-cancel", Delivery, "Call off a draft and everything of it still waiting in the queue.",
            object(vec![("draft", draft_option()), ("apply", apply_option())]), lifecycle::draft_cancel)
            .note("Nothing already delivered is touched; use `delete` for that. `apply` performs it.")
            .mutates()
            .agent(),
        op("video-publish", Delivery, "Send a video draft to every platform it has chosen, now.",
            object(vec![("draft", draft_option()), ("apply", apply_option())]), lifecycle::video_publish)
            .mutates()
            .agent(),
        op("video-schedule", Delivery, "Put every platform of a video draft in the queue for one time.",
            object(vec![("draft", draft_option()), ("at", schedule_at_option()), ("apply", apply_option())]),
            lifecycle::video_schedule)
            .note("One time for all of them, because a per-platform time is a picker on the card. `apply` performs it.")
            .mutates()
            .agent(),
        op("video-cancel", Delivery, "Call off a video: its queue, its reminders, and the YouTube upload it may already have made.",
            object(vec![("draft", draft_option()), ("apply", apply_option())]), lifecycle::video_cancel)
            .note("An upload YouTube already holds is kept private rather than deleted, and anything published needs removing by hand; the answer says which. `apply` performs it.")
            .mutates()
            .agent(),
        op("skip", Delivery, "Finish a publication without a target that did not land, instead of retrying it.",
            object(vec![
                ("ref", ref_option()),
                ("target", string().trim().min(1.0).optional().example("threads_ru").describe("one target to give up on, or every unlanded one")),
                ("apply", apply_option()),
            ]),
            commands::skip)
            .note("The other answer to what `retry` asks, and the one the bot has always had next to it. Nothing is sent and nothing is removed from a platform: the jobs stop asking to be dealt with and the publication settles. Omit `target` to give up on every target that did not land; `apply` performs it.")
            .mutates()
            .agent(),
        op("resend", Delivery, "Send an already-published post to a platform it never went to.",
            object(vec![
                ("ref", ref_option()),
                ("target", string().trim().min(1.0).example("x").describe("the target to send it to now")),
                ("apply", apply_option()),
            ]),
            commands::resend)
            .note("For a platform remembered after the fact, which `retry` cannot do: retry republishes what a target already delivered. A target that already has the post is refused, so this cannot publish it twice. `apply` performs it.")
            .start_here("The post should have gone to one more platform.")
            .mutates()
            .agent(),
        op("settle", Delivery, "Answer a target stuck in verification_required with what the platform actually shows.",
            object(vec![
                ("ref", ref_option()),
                ("target", string().trim().min(1.0).example("threads_ru").describe("the ambiguous delivery target")),
                ("external_id", string().trim().min(1.0).optional().example("18049...").describe("the id the post has on the platform, if it is there")),
                ("url", string().trim().min(1.0).optional().example("https://...").describe("its public address, if it is there")),
                ("apply", apply_option()),
            ]),
            commands::settle)
            .note("Reconciliation resolves an ambiguous target by asking the platform about its stored id, so a worker lost before recording one leaves nothing to ask about. Name `external-id` to record the post as live, or omit it to report the post absent and queue it again; `apply` performs it.")
            .mutates()
            .agent(),
        op("video-retry", Delivery, "Queue a failed video target again.",
            object(vec![("draft", video_draft_option()), ("target", video_target_option())]), lifecycle::video_retry)
            .note("Only a target that failed, and a provider route is asked before it is repeated: the provider still holding a post id is queried under the fence that already covers that publication, and a new attempt is armed only if the answer is that the audience got nothing. That new attempt carries a new fence, so it can publish what the failed one never did. Answers with `settled` when the question alone resolved the target.")
            .mutates()
            .agent(),
        op("video-settle", Delivery, "Answer a provider-delivered video target stuck awaiting verification.",
            object(vec![
                ("draft", video_draft_option()),
                ("target", video_target_option()),
                ("provider_post_id", string().trim().min(1.0).example("6a80a5e0d45305ab4246ae2a").describe("the provider's own post id").optional()),
                ("external_id", string().trim().min(1.0).example("DcEdQDZDCaq").describe("what the platform shows, when you can see it").optional()),
                ("url", string().trim().min(1.0).example("https://www.instagram.com/reel/DcEdQDZDCaq/").describe("the live publication").optional()),
                ("apply", apply_option()),
            ]),
            lifecycle::video_settle)
            .note("Asks the provider what became of the publication and records the answer: a platform link means published, a provider-side failure sends the target back to `failed` where a retry can pick it up, anything else stays awaiting verification. Give `external_id`/`url` to record what you can see on the platform yourself, which outranks what the provider says. Provider routes only: a native upload has no idempotent replay to ask with.")
            .mutates()
            .agent(),
        op("refresh-site", Delivery, "Re-render one locale's public page without touching social targets.",
            repair_schema(vec![]).extend(vec![
                ("target", target_option().describe("accepted; a public page is not per target")),
                ("apply", boolean().default(json!(true)).describe("accepted; this repair always acts")),
            ]),
            commands::refresh_site)
            .mutates()
            .journals_in_handler()
            .agent(),
        op("replace-media", Delivery, "Swap the media of a published post on one target and re-render the site.",
            object(vec![
                ("ref", ref_option()),
                ("locale", enumeration(LOCALES).describe("which language's media to replace")),
                ("file", string().min(1.0).example("PATH").describe("image or MP4 path on this host")),
                ("target", string().min(1.0).example("threads_en").describe("the delivery target to take down and publish again")),
                ("apply", apply_option()),
            ]),
            commands::replace_media)
            .mutates()
            .journals_in_handler()
            .note("reports the target in scope; `apply` replaces it"),
        op("reschedule", Delivery, "Move a scheduled publication to another time.",
            object(vec![
                ("ref", ref_option()),
                ("schedule_locale", enumeration(SCHEDULE_LOCALES).describe("which language's schedule to move")),
                ("at", string().min(1.0).example("\"06.08.2026 08:00\"").describe("in the configured timezone, or an ISO instant")),
            ]),
            commands::reschedule)
            .mutates()
            .journals_in_handler()
            .agent(),
        op("publication-repair", Delivery, "Reconcile publication rows against their jobs and targets.",
            object(vec![
                ("ref", string().trim().min(1.0).optional().example("post:160")
                    .describe("scope to one publication; omitted it sweeps everything").transform(Transform::RefSpelling)),
                ("apply", apply_option()),
            ]),
            admin::publication_repair)
            .mutates()
            .agent()
            .note("scoped repair is preferred"),
        op("disk", Media, "What the data volume holds, and how much of it nothing points at.",
            object(vec![]), admin::disk)
            .start_here("the data volume is filling up")
            .note("Media caches are supposed to hold something -- they age out on a TTL. Story variants are not a cache: one whose source is gone is a file nothing will read or delete, and `orphaned` counts exactly those."),
        op("media-reprocess", Media, "Re-run media processing for one publication.",
            object(vec![("ref", ref_option()), ("apply", apply_option())]), media::media_reprocess)
            .mutates()
            .agent(),
        op("story-media-backfill", Media, "Render the Story shapes missing from the media this Studio can still publish.",
            object(vec![
                ("apply", apply_option()),
                ("limit", coerce_number().int().positive().default(json!(25)).describe("how many sources to render in this run")),
                ("all", boolean().default(json!(false)).describe("also prepare media no draft has asked a Story of")),
            ]),
            media::story_media_backfill)
            .start_here("a Story is slow to publish, or refuses for want of prepared media")
            .mutates()
            .note("`missing_wanted` is the number to act on: a draft that publishes a Story points at that file, delivery only reads these files, so that publication will refuse. `missing_unused` is media no draft has asked a Story of -- normal, and left alone unless `all` is passed. Reports the plan; `apply` renders `limit` of them, one encode at a time -- a video is 8-12 seconds, so run it again until `remaining` is zero."),
        op("story-media-prune", Media, "Remove Story variants whose source file is gone.",
            object(vec![("apply", apply_option())]), media::story_media_prune)
            .mutates()
            .note("Retention takes a variant with its source, so this is for what accumulated before that and for files named by routes that no longer exist. A file a publish job's payload still names is reported under `held_by_a_publish_job` and never removed."),
        op("backup", Host, "Copy the database to a timestamped file.",
            object(vec![("output", string().optional().example("DIRECTORY").describe("destination directory"))]), admin::backup)
            .mutates(),
        op("backup-stream", Host, "Write one backup stream to stdout for a backup host to pull.",
            object(vec![("what", enumeration(&["media", "db"]).describe("media trees or the database").example("media"))]),
            admin::backup_stream)
            .streams()
            .note("Nothing is written to this host: the stream is meant for `ssh <studio> ops backup-stream --what media > …` from the machine that keeps the backups. `doctor` fails once no media stream has been pulled for a week."),
        op("restore", Host, "Replace the database with a backup.",
            object(vec![
                ("source", string().min(1.0).example("PATH").describe("backup file to restore")),
                ("force", boolean().default(json!(false))),
            ]),
            admin::restore)
            .mutates()
            .note("replaces the database"),
        op("format-record", Channels, "Record the message that proves a target carries a media format.",
            object(vec![
                ("test", string().min(1.0).example("T01").describe("format test id")),
                ("post_id", coerce_number().int().positive().describe("post that demonstrates it")),
                ("notes", string().optional()),
            ]),
            admin::format_record)
            .mutates(),
        op("site-display-repair", Media, "Restore editorial modification dates from a reviewed plan and remove site-only Story cards.",
            object(vec![
                ("file", string().min(1.0).optional().describe("reviewed date restoration JSON file")),
                ("apply", apply_option()),
            ]),
            media::site_display_repair)
            .note("Without file, exports current content fingerprints and dates. A version-1 JSON plan restores only dates whose expected timestamp and editorial fingerprint still match. Removes generated Story cards from published site galleries; keeps their social delivery assets. Does not resend publications.")
            .mutates(),
        op("site-media-backfill", Media, "Restore original proportions to published site galleries, newest posts first.",
            object(vec![
                ("apply", apply_option()),
                ("limit", coerce_number().int().min(1.0).default(json!(20)).describe("maximum posts per run")),
            ]),
            media::site_media_backfill)
            .note("Replaces the old vertical viewer files using original uploads, including videos and thread attachments. Each locale switches after all its files exist. Missing uploads leave the current gallery intact. Does not resend social publications or delete historical URLs; repeat until remaining is zero.")
            .mutates(),
        op("site-responsive-backfill", Media, "Create missing or outdated responsive images and video posters for published site media.",
            object(vec![("apply", apply_option())]), media::site_responsive_backfill)
            .note("Reports the gap; apply writes the publication worker's WebP sizes, one source at a time. Does not change posts or re-encode video.")
            .mutates(),
        op("site-metadata", Media, "Export published image metadata, or import reviewed alt descriptions and SEO titles.",
            object(vec![
                ("file", string().min(1.0).optional().describe("reviewed metadata JSON file")),
                ("apply", apply_option()),
            ]),
            media::site_metadata)
            .note("Without file, exports published text hashes and images. With file, validates the version-1 JSON plan; apply saves it atomically and queues changed public URLs for IndexNow. Changed text and replaced images are protected. To correct existing copy, supply its exact expected_seo_title or expected_alt; stale edits fail. Does not resend publications.")
            .mutates(),
        op("site-media-deduplicate", Media, "Collapse identical assets in media storage.",
            object(vec![("apply", apply_option())]), media::site_media_deduplicate)
            .mutates(),
        op("channel-connect", Channels, "Connect a publishing route.",
            object(vec![
                ("platform", string().min(1.0).example("youtube|instagram").describe("platform to connect").optional()),
                ("locale", enumeration(LOCALES).optional()),
                ("provider", string().default(json!("native")).example("native|zernio").describe("delivery provider")),
                ("target", enumeration(POST_TARGETS).optional()),
                ("account_id", string().optional()),
                ("label", string().optional()),
            ]),
            admin::channel_connect)
            .note("A text or story route needs only `target`: it already names the platform and the language, and asking for them again is a way to store a channel that disagrees with itself. A video account needs `platform` with `locale`. An Instagram account connected for Reels does not carry the Story with it: connect `instagram_stories_ru` or `instagram_stories` when this Studio actually posts them, because a connected target is one the post screens offer and the queue waits for.")
            .mutates()
            .agent(),
        op("connect-link", Channels, "Start connecting an account, and say what has to happen next.",
            object(vec![
                ("platform", enumeration(CONNECT_PLATFORMS).describe("platform to connect")),
                ("locale", enumeration(LOCALES).default(json!("ru")).describe("which language's account, for platforms this Studio keeps two of")),
            ]),
            admin::connect_link)
            .note("Open the signed, short-lived consent link. Threads and Instagram need their app id and secret, X its client id and secret, YouTube its client id and secret for that language, and all of them TOKEN_ENCRYPTION_KEY.")
            .mutates()
            .agent()
            .format(admin::format_connect_link),
        op("channel-disable", Channels, "Disable a channel, keeping its publication history attributable.",
            object(vec![("channel", string().min(1.0).example("youtube_ru").describe("channel id"))]), admin::channel_disable)
            .mutates()
            .agent(),
        op("credential-set", Channels, "Store an API key this Studio is handed rather than negotiates.",
            object(vec![("target", enumeration(API_KEY_TARGETS).describe("service the key belongs to"))]), admin::credential_set)
            .note("Reads the key from standard input, so it never appears in a command line or a shell history: `printf %s \"$KEY\" | ops credential-set --target zernio`. The key is checked against the service before it is stored, and .env is not consulted for it afterwards.")
            .mutates()
            .format(admin::format_credential_set),
        op("telegram-stories-login", Channels, "Sign this Studio's Stories account in and store its session.",
            object(vec![]), admin::telegram_stories_login)
            .note("Telegram Stories are posted by a user, not a bot, so the credential is an MTProto session. Needs TELEGRAM_CHANNEL_STORIES_API_ID, _API_HASH and _SESSION set first; run it with a terminal attached (docker compose exec -it) because it asks for the phone number, the code Telegram sends, and the 2FA password if the account has one.")
            .mutates(),
        op("threads-authorize", Channels, "Terminal fallback for obtaining a long-lived Threads token when the browser callback is unavailable.",
            object(vec![("locale", enumeration(LOCALES))]), admin::threads_authorize)
            .note("The normal path is Studio → Channels. This fallback needs THREADS_APP_ID and THREADS_APP_SECRET, prints a link, then asks for the redirect address. Run it with a terminal attached (docker compose exec -it)."),
    ];
    defs.into_iter().map(|def| def.0).collect()
}

static DEFINITIONS: LazyLock<Vec<OperationDef>> = LazyLock::new(definitions);

/// Every operation, in catalog order.
pub fn operation_defs() -> &'static [OperationDef] {
    &DEFINITIONS
}

pub fn operation_def(name: &str) -> Option<&'static OperationDef> {
    DEFINITIONS.iter().find(|def| def.name == name)
}

fn guide_handler<'a>(context: &'a OperationContext<'a>, input: &'a Input) -> Fut<'a, OpResult> {
    Box::pin(async move {
        let view = crate::guide::GuideView {
            section: input.opt_str("section").and_then(Section::parse),
            all: input.bool("all"),
        };
        Ok(crate::guide::build_guide(context, &operation_catalog(), &view))
    })
}

/// `runOperation`: the one entry every surface passes through. Input is
/// validated once here, usage is counted around the handler, and every
/// mutation reaches the journal.
pub async fn run_operation(name: &str, context: &OperationContext<'_>, args: &Value) -> OpResult {
    let Some(def) = operation_def(name) else {
        return Err(OpError::Input(format!("unknown command: {name}")));
    };
    // zod strips what it does not know, so a misspelled `target` used to
    // arrive as no target at all and widen a scoped command.
    let fields: Vec<&str> = def.schema.fields.iter().map(|field| field.name).collect();
    let empty = Map::new();
    let given = args.as_object().unwrap_or(&empty);
    let unknown: Vec<&str> = given
        .keys()
        .map(String::as_str)
        .filter(|field| !fields.contains(field))
        .collect();
    if !unknown.is_empty() {
        return Err(OpError::Input(format!(
            "{name}: unknown field{} {}; accepts {}",
            if unknown.len() > 1 { "s" } else { "" },
            unknown.join(", "),
            if fields.is_empty() {
                "no arguments".to_owned()
            } else {
                fields.join(", ")
            }
        )));
    }
    let input = match def.schema.parse(given) {
        Ok(parsed) => Input(parsed),
        Err(ParseError::Issue(issue)) => return Err(OpError::Input(format!("{name}: {}", issue.describe()))),
        Err(ParseError::Thrown(message)) => return Err(OpError::Failed(message)),
    };
    let started = Instant::now();
    let result = (def.handler)(context, &input).await;
    // Measured around the handler alone: a caller's typo is rejected above.
    if !def.database_independent
        && let Ok(sqlite) = context.sqlite()
    {
        context.surface.usage().record(
            sqlite,
            &operation_usage_key(name),
            result.is_ok(),
            started.elapsed().as_millis() as u64,
        );
    }
    let result = crate::context::js_numbers(result?);
    if def.mutates && !def.journals_in_handler {
        journal_mutation(context, def, &input);
    }
    Ok(result)
}

/// The usage key of one operation.
fn operation_usage_key(name: &str) -> String {
    format!("operations.{name}")
}

/// Every operation, including the ones nobody has run.
pub fn operation_usage_keys() -> Vec<String> {
    DEFINITIONS.iter().map(|def| operation_usage_key(def.name)).collect()
}

/// Best-effort: the mutation already happened, and reporting a failed journal
/// write as a failed operation invites a retry that publishes twice.
fn journal_mutation(context: &OperationContext<'_>, def: &OperationDef, input: &Input) {
    let publication_ref = match def.journal_ref {
        JournalRef::Input => input.opt_str("ref").map(str::to_owned),
        JournalRef::Fixed(fixed) => fixed.map(str::to_owned),
    };
    let mut details = Map::new();
    details.insert("operation".into(), json!(def.name));
    details.insert("surface".into(), json!(context.actor_type));
    details.insert("status".into(), json!("ok"));
    let event = DomainEventInput {
        publication_ref,
        event_type: "operations.command".into(),
        severity: Severity::Info,
        target: input.opt_str("target").map(str::to_owned),
        message: format!("Operations {} executed", def.name),
        details: Some(details),
        cooldown_seconds: None,
    };
    let recorded = context
        .sqlite()
        .and_then(|sqlite| record_event(sqlite, context.clock, &event).map_err(OpError::from));
    if let Err(error) = recorded {
        log(
            LogLevel::Error,
            "operations audit event failed",
            Some(json!({"operation": def.name, "surface": context.actor_type, "error": error.message()})),
        );
    }
}

// --- Projections ----------------------------------------------------------------

/// `--kebab-case` is the CLI spelling of a snake_case schema field.
pub fn option_flag(field: &str) -> String {
    field.replace('_', "-")
}

/// Derived, never hand-written.
pub fn operation_usage(def: &OperationDef) -> String {
    let schema = def.schema.json_schema();
    let empty = Map::new();
    let properties = schema["properties"].as_object().unwrap_or(&empty);
    let required: Vec<&str> = schema["required"]
        .as_array()
        .map(|items| items.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();
    let mut parts = vec![def.name.to_owned()];
    for (field, property) in properties {
        let flag = option_flag(field);
        let placeholder = match (&property["placeholder"], property["enum"].as_array()) {
            (Value::String(placeholder), _) => placeholder.clone(),
            (_, Some(values)) => values.iter().filter_map(Value::as_str).collect::<Vec<_>>().join("|"),
            _ => "VALUE".to_owned(),
        };
        let token = match property["type"].as_str() {
            Some("boolean") => format!("--{flag}"),
            Some("array") => format!("--{flag} {placeholder} ..."),
            _ => format!("--{flag} {placeholder}"),
        };
        parts.push(if required.contains(&field.as_str()) {
            token
        } else {
            format!("[{token}]")
        });
    }
    parts.join(" ")
}

/// One command as every operator-facing surface describes it.
#[derive(Clone, Debug)]
pub struct CatalogEntry {
    pub name: &'static str,
    pub usage: String,
    pub mutates: bool,
    pub agent: bool,
    pub section: Section,
    pub summary: &'static str,
    pub note: Option<&'static str>,
    pub start_here: Option<&'static str>,
}

impl CatalogEntry {
    pub fn to_json(&self) -> Value {
        let mut out = Map::new();
        out.insert("name".into(), json!(self.name));
        out.insert("usage".into(), json!(self.usage));
        out.insert("mutates".into(), json!(self.mutates));
        out.insert("agent".into(), json!(self.agent));
        out.insert("section".into(), json!(self.section.as_str()));
        out.insert("summary".into(), json!(self.summary));
        if let Some(note) = self.note {
            out.insert("note".into(), json!(note));
        }
        if let Some(start_here) = self.start_here {
            out.insert("startHere".into(), json!(start_here));
        }
        Value::Object(out)
    }
}

pub fn operation_catalog() -> Vec<CatalogEntry> {
    DEFINITIONS
        .iter()
        .map(|def| CatalogEntry {
            name: def.name,
            usage: operation_usage(def),
            mutates: def.mutates,
            agent: def.agent,
            section: def.section,
            summary: def.summary,
            note: def.note,
            start_here: def.start_here,
        })
        .collect()
}
