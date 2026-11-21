//! `story-cards/worker.ts`: one queued card per cycle, claimed under a lease,
//! rendered, and settled — ready, queued again with a back-off, or failed
//! once its attempts run out — by writes that carry the lease in their
//! `WHERE`.

use std::path::PathBuf;
use std::time::{Duration, Instant};

use content::Locale;
use db::rusqlite::{Connection, OptionalExtension, params};
use domain::application::ports::{ApplicationPorts, Clock};
use domain::story_cards::story_card_copy;
use domain::studio::Studio;
use domain::studio::config::studio_config;
use domain::studio::services::posts::PostService;
use foundation::logger::{LogLevel, log};
use foundation::time::to_iso_string;
use jiff::SignedDuration;
use serde_json::{Map, Value, json};

use crate::render::{StoryCardRender, render_story_card};

/// The name the cycle's worker state is recorded under.
pub const STORY_CARD_WORKER: &str = "story-cards";
const STORY_CARD_MAX_ATTEMPTS: i64 = 3;
/// A render is seconds of work; past this it is hung.
const STORY_CARD_TIMEOUT: Duration = Duration::from_secs(15);
/// How long a `rendering` lease outlives the process that took it.
const STALE_AFTER: SignedDuration = SignedDuration::from_secs(60);
const RENDER_USAGE: &str = "content.story_card.render";

/// What one cycle did, for the worker state the caller records under
/// [`STORY_CARD_WORKER`] (`recordWorkerState(db, "story-cards", state, error)`).
#[derive(Clone, Debug, PartialEq)]
pub struct StoryCardCycle {
    /// Cards claimed: 0 or 1.
    pub claimed: u32,
    /// `{claimed}`, `{claimed, published}` or `{claimed, failed}`.
    pub state: Map<String, Value>,
    /// Why the claimed card did not render.
    pub error: Option<String>,
}

struct ClaimedCard {
    draft_id: i64,
    locale: String,
    source_hash: String,
    headline: String,
    emoji: Option<String>,
    attempt_count: i64,
    locked_by: String,
}

/// `recoverStoryCardJobs`: leases older than a minute go back to the queue,
/// due now. A `rendering` row with no lock timestamp cannot age out of the
/// comparison, and nothing owns it, so it is recovered on sight. Returns how
/// many were recovered.
pub fn recover_story_card_jobs(sqlite: &Connection, clock: &dyn Clock) -> domain::Result<usize> {
    let now = clock.now();
    let cutoff = to_iso_string(now - STALE_AFTER);
    let now = to_iso_string(now);
    Ok(sqlite
        .prepare(
            r#"update "draft_story_cards" set "status" = 'queued', "locked_by" = null, "locked_at" = null, "next_attempt_at" = ?1, "updated_at" = ?1 where ("draft_story_cards"."status" = 'rendering' and ("draft_story_cards"."locked_at" is null or "draft_story_cards"."locked_at" < ?2)) returning "draft_id""#,
        )?
        .query_map(params![now, cutoff], |_| Ok(()))?
        .count())
}

/// `runStoryCardCycle`: recovers stale leases, then renders at most one due
/// card. Errors are the database's; a card that fails to render is settled
/// and reported in the result.
pub async fn run_story_card_cycle(studio: Studio<'_>) -> domain::Result<StoryCardCycle> {
    let sqlite = studio.publishing.sqlite;
    let clock = studio.publishing.clock;
    recover_story_card_jobs(sqlite, clock)?;
    let Some(card) = claim_story_card(sqlite, clock)? else {
        return Ok(cycle(None, None));
    };
    let settled = async {
        let output = output_path(studio, &card);
        let started = Instant::now();
        let rendered = render(studio, &card, output.clone()).await;
        studio.publishing.boundaries.usage.record(
            sqlite,
            RENDER_USAGE,
            rendered.is_ok(),
            started.elapsed().as_millis() as u64,
        );
        rendered?;
        let now = to_iso_string(clock.now());
        sqlite.execute(
            r#"update "draft_story_cards" set "status" = 'ready', "local_path" = ?, "locked_by" = null, "locked_at" = null, "next_attempt_at" = null, "last_error" = null, "updated_at" = ? where ("draft_story_cards"."draft_id" = ? and "draft_story_cards"."locale" = ? and "draft_story_cards"."status" = 'rendering' and "draft_story_cards"."locked_by" = ?)"#,
            params![output.to_string_lossy(), now, card.draft_id, card.locale, card.locked_by],
        )?;
        PostService::new(studio).replan_scheduled_post_after_story_cards(card.draft_id)?;
        domain::Result::Ok(())
    };
    let Err(error) = settled.await else {
        return Ok(cycle(Some("published"), None));
    };
    let message = error.to_string();
    let attempt = card.attempt_count + 1;
    let retry = attempt < STORY_CARD_MAX_ATTEMPTS;
    let now = clock.now();
    let next_attempt_at = retry.then(|| to_iso_string(now + SignedDuration::from_millis(attempt * 5_000)));
    sqlite.execute(
        r#"update "draft_story_cards" set "status" = ?, "attempt_count" = ?, "next_attempt_at" = ?, "locked_by" = null, "locked_at" = null, "last_error" = ?, "updated_at" = ? where ("draft_story_cards"."draft_id" = ? and "draft_story_cards"."locale" = ? and "draft_story_cards"."status" = 'rendering' and "draft_story_cards"."locked_by" = ?)"#,
        params![
            if retry { "queued" } else { "failed" },
            attempt,
            next_attempt_at,
            message,
            to_iso_string(now),
            card.draft_id,
            card.locale,
            card.locked_by
        ],
    )?;
    if !retry
        && let Err(replan) = PostService::new(studio).replan_scheduled_post_after_story_card_failure(card.draft_id)
    {
        log(
            LogLevel::Error,
            "failed to replan after Story card failure",
            Some(json!({"draftId": card.draft_id, "error": replan.to_string()})),
        );
    }
    Ok(cycle(Some("failed"), Some(message)))
}

/// The cycle's counters: the claim, and how the claimed card settled.
fn cycle(settled: Option<&str>, error: Option<String>) -> StoryCardCycle {
    let claimed = u32::from(settled.is_some());
    let mut state = Map::new();
    state.insert("claimed".into(), claimed.into());
    if let Some(settled) = settled {
        state.insert(settled.into(), 1.into());
    }
    StoryCardCycle { claimed, state, error }
}

/// `claimStoryCard`: the oldest due card, taken only if it is still queued
/// when the lease is written.
fn claim_story_card(sqlite: &Connection, clock: &dyn Clock) -> domain::Result<Option<ClaimedCard>> {
    let now = to_iso_string(clock.now());
    let candidate: Option<(i64, String)> = sqlite
        .query_row(
            r#"select "draft_id", "locale" from "draft_story_cards" where ("draft_story_cards"."status" = 'queued' and ("draft_story_cards"."next_attempt_at" is null or "draft_story_cards"."next_attempt_at" <= ?)) order by "draft_story_cards"."created_at" asc, "draft_story_cards"."draft_id" asc, "draft_story_cards"."locale" asc limit 1"#,
            [&now],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    let Some((draft_id, locale)) = candidate else {
        return Ok(None);
    };
    let lock_id = format!(
        "story-card:{}:{}",
        std::process::id(),
        domain::repositories::random_uuid()
    );
    Ok(sqlite
        .query_row(
            r#"update "draft_story_cards" set "status" = 'rendering', "locked_by" = ?1, "locked_at" = ?2, "updated_at" = ?2 where ("draft_story_cards"."draft_id" = ?3 and "draft_story_cards"."locale" = ?4 and "draft_story_cards"."status" = 'queued') returning "draft_id", "locale", "source_hash", "headline", "emoji", "attempt_count", "locked_by""#,
            params![lock_id, now, draft_id, locale],
            |row| {
                Ok(ClaimedCard {
                    draft_id: row.get(0)?,
                    locale: row.get(1)?,
                    source_hash: row.get(2)?,
                    headline: row.get(3)?,
                    emoji: row.get(4)?,
                    attempt_count: row.get(5)?,
                    locked_by: row.get(6)?,
                })
            },
        )
        .optional()?)
}

fn output_path(studio: Studio<'_>, card: &ClaimedCard) -> PathBuf {
    let hash: String = card.source_hash.chars().take(16).collect();
    studio
        .config
        .story_card_dir
        .join(format!("draft-{}-{}-{hash}.jpg", card.draft_id, card.locale))
}

/// `renderStoryCard`, logging its timing either way.
async fn render(studio: Studio<'_>, card: &ClaimedCard, output: PathBuf) -> domain::Result<()> {
    let started = Instant::now();
    let mut prepare_ms = 0;
    let mut renderer_ms = 0;
    let mut output_bytes = 0;
    let result = async {
        let prepare_started = Instant::now();
        std::fs::create_dir_all(&studio.config.story_card_dir)
            .map_err(|error| domain::Error::message(error.to_string()))?;
        // The copy the renderer draws comes from the stored headline; the
        // stored headline and emoji are what it shows.
        let mut copy = story_card_copy(&card.headline);
        copy.emoji = card.emoji.clone();
        copy.headline = card.headline.clone();
        let locale = if card.locale == "ru" { Locale::Ru } else { Locale::En };
        let wordmark = studio_config(ApplicationPorts::within(
            studio.publishing.sqlite,
            studio.publishing.clock,
        ))
        .site(locale)?
        .name;
        let job = StoryCardRender {
            assets_dir: PathBuf::from(&studio.config.story_card_assets_dir),
            output,
            wordmark,
            copy,
        };
        prepare_ms = prepare_started.elapsed().as_millis();
        let renderer_started = Instant::now();
        let rendered = tokio::time::timeout(
            STORY_CARD_TIMEOUT,
            tokio::task::spawn_blocking(move || render_story_card(&job)),
        )
        .await;
        renderer_ms = renderer_started.elapsed().as_millis();
        output_bytes = match rendered {
            Err(_) => Err(format!("timed out after {}s", STORY_CARD_TIMEOUT.as_secs())),
            Ok(Err(panic)) => Err(format!("renderer panicked: {panic}")),
            Ok(Ok(written)) => written,
        }
        .map_err(|error| domain::Error::message(format!("story_card_renderer_failed: {error}")))?;
        domain::Result::Ok(())
    }
    .await;
    let mut details = json!({
        "operation": RENDER_USAGE,
        "draftId": card.draft_id,
        "locale": card.locale,
        "success": result.is_ok(),
        "totalMs": started.elapsed().as_millis() as u64,
        "prepareMs": prepare_ms as u64,
        "rendererMs": renderer_ms as u64,
        "outputBytes": output_bytes,
    });
    if let Err(error) = &result {
        details["error"] = error.to_string().into();
    }
    log(
        if result.is_ok() { LogLevel::Info } else { LogLevel::Warn },
        "operation timing",
        Some(details),
    );
    result
}
