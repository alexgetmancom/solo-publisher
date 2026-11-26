//! The site build queue. A cycle claims queued site
//! jobs under one lease, renders the media of their publications into the
//! public site, stores the manifests fenced on the source version read before
//! the render, and settles each job under that lease; IndexNow hears about the
//! pages that changed without the cycle waiting on it.

use std::collections::{BTreeSet, HashMap};
use std::time::Duration;

use content::Locale;
use content::message::MediaItem;
use db::rusqlite::{Connection, OptionalExtension as _, params, params_from_iter};
use domain::application::publication_ref::{PublicationRefKind, parse_publication_ref, publication_ref};
use domain::publishing::cancellation::DELIVERY_NOT_CANCELLED;
use domain::publishing::errors::next_retry_at;
use domain::publishing::publication_source::{PublicationLocaleSource, PublicationSource};
use domain::publishing::queue::worker_id;
use domain::repositories::{StudioSettingsStore, random_uuid, transaction};
use runtime::job_heartbeat::with_job_heartbeat;
use runtime::worker_state::record_worker_state;
use serde_json::{Map, Value, json};

use crate::site_content_index::site_urls_for_index_now;
use crate::site_index_now::{index_now_settled, notify_index_now, take_index_now_failures};
use crate::site_media::{materialize_site_media, site_media_source};
use crate::{Delivery, Result};

/// The lock age after which a restarted Studio takes its own unfinished
/// builds back: no other process can still be rendering them.
pub const SITE_JOB_RESTART_LOCK_GRACE_SECONDS: u64 = 30;
/// The lock age after which the watchdog takes a build back from a worker
/// whose heartbeat stopped.
pub const SITE_JOB_LOCK_TIMEOUT_SECONDS: u64 = 900;
const SITE_JOB_CLAIM_LIMIT: i64 = 20;
const SITE_JOB_HEARTBEAT_INTERVAL: Duration = Duration::from_secs(60);
const SITE_JOB_MAX_ATTEMPTS: i64 = 5;
const SITE_JOB_BACKOFF_BASE_SECONDS: u64 = 60;
const SITE_JOB_BACKOFF_MAX_SECONDS: u64 = 900;
const SOURCE_CHANGED: &str = "site source changed while it was rendering";

#[derive(Clone, Debug)]
struct SiteJob {
    job_id: i64,
    publication_key: String,
    attempt_count: i64,
    lock_id: String,
}

/// `config.studio.siteEnabled`: whether this Studio publishes a site at all,
/// the gate of the site and site-watchdog loops.
pub fn site_enabled(delivery: &Delivery<'_>) -> Result<bool> {
    Ok(StudioSettingsStore::new(delivery.sqlite()).profile()?.site_enabled != 0)
}

/// Publications that could not be rendered, with why, in the order they were
/// found (a later reason replaces an earlier one).
#[derive(Default)]
pub struct SiteFailures(Vec<(String, String)>);

impl SiteFailures {
    fn set(&mut self, publication_key: String, message: String) {
        match self.0.iter_mut().find(|(key, _)| *key == publication_key) {
            Some(entry) => entry.1 = message,
            None => self.0.push((publication_key, message)),
        }
    }

    pub fn has(&self, publication_key: &str) -> bool {
        self.0.iter().any(|(key, _)| key == publication_key)
    }

    pub fn entries(&self) -> &[(String, String)] {
        &self.0
    }
}

fn object(value: Value) -> Map<String, Value> {
    match value {
        Value::Object(map) => map,
        _ => unreachable!("built as an object"),
    }
}

/// `runSiteJobCycle`: one pass of the site loop; the number of jobs claimed.
pub async fn run_site_job_cycle(delivery: &Delivery<'_>) -> Result<usize> {
    record_index_now_failures(delivery)?;
    recover_stale_site_jobs(delivery, SITE_JOB_LOCK_TIMEOUT_SECONDS)?;
    let jobs = claim_site_jobs(delivery)?;
    if jobs.is_empty() {
        notify_index_now_or_journal(delivery, &[])?;
        record_worker_state(
            delivery.db,
            "site",
            object(json!({"claimed": 0})),
            None,
            delivery.clock().now(),
        )?;
        return Ok(0);
    }
    let cycle = async {
        let lock_id = jobs[0].lock_id.clone();
        let keys: BTreeSet<String> = jobs.iter().map(|job| job.publication_key.clone()).collect();
        let heartbeat = || {
            delivery
                .sqlite()
                .execute(
                    r#"update "site_jobs" set "locked_at" = ? where ("site_jobs"."status" = ? and "site_jobs"."locked_by" = ?)"#,
                    params![delivery.now(), "rendering", lock_id],
                )
                .map(drop)
        };
        let failures = with_job_heartbeat(SITE_JOB_HEARTBEAT_INTERVAL, heartbeat, async {
            // `trackUsageAsync` times the work on the cycle's clock.
            let started = delivery.now_ms();
            let rendered = materialize_site_posts(delivery, Some(&keys)).await;
            delivery.boundaries.usage.record(
                delivery.sqlite(),
                "publishing.site.materialize",
                rendered.is_ok(),
                (delivery.now_ms() - started).max(0) as u64,
            );
            rendered
        })
        .await?;
        // Only the jobs whose own publication failed carry its error; the rest
        // published, and their attempt budget is not spent on someone else's post.
        for (publication_key, message) in failures.entries() {
            let own: Vec<SiteJob> = jobs
                .iter()
                .filter(|job| job.publication_key == *publication_key)
                .cloned()
                .collect();
            fail_site_jobs(delivery, &own, message)?;
        }
        let rendered: Vec<SiteJob> = jobs
            .iter()
            .filter(|job| !failures.has(&job.publication_key))
            .cloned()
            .collect();
        let completed = complete_site_jobs(delivery, &rendered)?;
        let completed_keys: BTreeSet<String> = completed.iter().map(|job| job.publication_key.clone()).collect();
        // IndexNow is an external notification, not a prerequisite for
        // serving the already materialized feed through SSR.
        match site_urls_for_index_now(delivery.db, delivery.config(), delivery.clock(), &completed_keys) {
            Ok(urls) => notify_index_now_or_journal(delivery, &urls)?,
            Err(error) => insert_site_event(
                delivery.sqlite(),
                "site.index.build.failed",
                "warn",
                &error.to_string(),
                &json!({}),
                &delivery.now(),
            )?,
        }
        record_worker_state(
            delivery.db,
            "site",
            object(json!({"claimed": jobs.len(), "published": completed.len()})),
            None,
            delivery.clock().now(),
        )?;
        Ok::<(), crate::Error>(())
    }
    .await;
    if let Err(error) = cycle {
        let message = error.to_string();
        let failed = fail_site_jobs(delivery, &jobs, &message)?;
        record_worker_state(
            delivery.db,
            "site",
            object(json!({"claimed": jobs.len(), "published": 0, "failed": failed.len()})),
            Some(&message),
            delivery.clock().now(),
        )?;
    }
    Ok(jobs.len())
}

/// `notifyIndexNow`: a send that fails later is journalled by the next cycle
/// ([`record_index_now_failures`]); one that cannot even be queued, now.
fn notify_index_now_or_journal(delivery: &Delivery<'_>, urls: &[String]) -> Result<()> {
    match notify_index_now(&delivery.adapters, urls) {
        Ok(()) => Ok(()),
        Err(message) => insert_site_event(
            delivery.sqlite(),
            "site.indexnow.failed",
            "warn",
            &message,
            &json!({"urls": urls}),
            &delivery.now(),
        ),
    }
}

/// Journals the IndexNow sends that failed since the last cycle, each at the
/// instant it failed.
pub fn record_index_now_failures(delivery: &Delivery<'_>) -> Result<()> {
    for failure in take_index_now_failures() {
        insert_site_event(
            delivery.sqlite(),
            "site.indexnow.failed",
            "warn",
            &failure.message,
            &json!({"urls": failure.urls}),
            &failure.at,
        )?;
    }
    Ok(())
}

/// Waits for the IndexNow sends in flight and journals the ones that failed.
pub async fn settle_index_now(delivery: &Delivery<'_>) -> Result<()> {
    index_now_settled().await;
    record_index_now_failures(delivery)
}

/// `recoverStaleSiteJobs`: builds whose lock is older than the given age go
/// back to the queue, or fail once their attempts are spent. Each write is
/// fenced on the lock it found stale.
pub fn recover_stale_site_jobs(delivery: &Delivery<'_>, max_lock_age_seconds: u64) -> Result<usize> {
    let sqlite = delivery.sqlite();
    let cutoff = foundation::time::iso_at(delivery.now_ms() - (max_lock_age_seconds as i64) * 1000);
    let now = delivery.now();
    let stale: Vec<(i64, String, i64, String, Option<String>)> = sqlite
        .prepare(
            r#"select "job_id", "publication_key", "attempt_count", "locked_at", "last_error" from "site_jobs" where ("site_jobs"."status" = ? and "site_jobs"."locked_at" is not null and "site_jobs"."locked_at" < ?)"#,
        )?
        .query_map(params!["rendering", cutoff], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?))
        })?
        .collect::<db::rusqlite::Result<_>>()?;
    let mut terminal_keys: Vec<String> = Vec::new();
    let recovered = transaction(sqlite, || {
        let mut recovered = 0;
        for (job_id, publication_key, attempt_count, locked_at, last_error) in &stale {
            let attempt = attempt_count + 1;
            let retry = attempt < SITE_JOB_MAX_ATTEMPTS;
            let updated = sqlite
                .query_row(
                    r#"update "site_jobs" set "status" = ?, "attempt_count" = ?, "next_attempt_at" = ?, "locked_by" = null, "locked_at" = null, "last_error" = ?, "updated_at" = ? where ("site_jobs"."job_id" = ? and "site_jobs"."status" = ? and "site_jobs"."locked_at" = ?) returning "job_id""#,
                    params![
                        if retry { "queued" } else { "failed" },
                        attempt,
                        retry.then(|| retry_at(delivery, attempt)),
                        last_error.as_deref().unwrap_or("stale site lock recovered"),
                        now,
                        job_id,
                        "rendering",
                        locked_at,
                    ],
                    |row| row.get::<_, i64>(0),
                )
                .optional()?;
            if updated.is_none() {
                continue;
            }
            recovered += 1;
            if !retry && !terminal_keys.contains(publication_key) {
                terminal_keys.push(publication_key.clone());
            }
        }
        Ok(recovered)
    })?;
    for post_id in terminal_keys.iter().filter_map(|key| publication_post_id(key)) {
        delivery.publishing().refresh_publication_status(post_id)?;
    }
    Ok(recovered)
}

fn retry_at(delivery: &Delivery<'_>, attempt: i64) -> String {
    next_retry_at(
        attempt as u32,
        SITE_JOB_BACKOFF_BASE_SECONDS,
        SITE_JOB_BACKOFF_MAX_SECONDS,
        delivery.now_ms(),
        None,
        delivery.boundaries.jitter,
    )
}

/// What one publication's render produced, per locale it renders.
struct PreparedSiteMedia {
    draft_id: i64,
    post_id: i64,
    /// `ru`, then `en`: `None` for a locale this build does not render.
    locales: [(Locale, Option<Vec<MediaItem>>); 2],
}

/// `materializeSitePosts`: renders every requested publication (all of them
/// without keys) and reports the ones that could not be.
///
/// One failure used to carry the whole batch: a single unreachable image
/// failed all twenty claimed jobs with that one post's error, and five cycles
/// of that left every publication in the queue `failed`. A publication that
/// cannot render is its own problem.
pub async fn materialize_site_posts(
    delivery: &Delivery<'_>,
    publication_keys: Option<&BTreeSet<String>>,
) -> Result<SiteFailures> {
    let sources = source_items(delivery, publication_keys)?;
    let mut failures = SiteFailures::default();
    // Rendering is the slow part, and the manifest written at the end of it
    // was decided before it started. Capture what the locales looked like
    // going in so the write can refuse to land on a source changed since.
    let versions = locale_versions(
        delivery.sqlite(),
        &sources.iter().map(|source| source.draft_id).collect::<Vec<_>>(),
    )?;
    let rendered =
        futures_util::future::join_all(sources.iter().map(|source| prepare_site_media(delivery, source))).await;
    let mut prepared = Vec::new();
    for (source, outcome) in sources.iter().zip(rendered) {
        match outcome {
            Ok(Some(item)) => prepared.push(item),
            Ok(None) => {}
            Err(message) => failures.set(publication_ref(PublicationRefKind::Post, source.post_id), message),
        }
    }
    // A skipped write is not a rendered publication. Report it so the job
    // retries against the source that displaced it rather than reporting
    // success over a manifest that was never stored.
    for post_id in persist_materialized_site_media(delivery, &prepared, &versions)? {
        failures.set(
            publication_ref(PublicationRefKind::Post, post_id),
            SOURCE_CHANGED.into(),
        );
    }
    Ok(failures)
}

/// The version of every locale about to be rendered, so the write that
/// follows the render can be fenced on it.
fn locale_versions(sqlite: &Connection, draft_ids: &[i64]) -> Result<HashMap<(i64, String), String>> {
    if draft_ids.is_empty() {
        return Ok(HashMap::new());
    }
    let marks = vec!["?"; draft_ids.len()].join(", ");
    let rows = sqlite
        .prepare(&format!(
            r#"select "draft_id", "locale", "updated_at" from "post_locales" where "post_locales"."draft_id" in ({marks})"#
        ))?
        .query_map(params_from_iter(draft_ids), |row| {
            Ok(((row.get(0)?, row.get(1)?), row.get(2)?))
        })?
        .collect::<db::rusqlite::Result<_>>()?;
    Ok(rows)
}

/// Stores the rendered manifests and returns the posts whose source moved
/// while they were rendering.
fn persist_materialized_site_media(
    delivery: &Delivery<'_>,
    items: &[PreparedSiteMedia],
    versions: &HashMap<(i64, String), String>,
) -> Result<Vec<i64>> {
    let sqlite = delivery.sqlite();
    let now = delivery.now();
    transaction(sqlite, || {
        let mut stale = Vec::new();
        for item in items {
            for (locale, media) in &item.locales {
                let Some(media) = media else { continue };
                // Fenced on the version read before the render: an edit landing
                // in that window would otherwise be overwritten by the manifest
                // of the media it replaced, and the site would serve the old
                // attachments until some unrelated render happened to fix them.
                // A locale that had no row then matches none now.
                let version = versions.get(&(item.draft_id, locale.as_str().to_owned()));
                let manifest =
                    domain::json::stringify(&Value::Array(media.iter().cloned().map(Value::Object).collect()));
                let written = sqlite
                    .query_row(
                        r#"update "post_locales" set "site_media_json" = ?, "updated_at" = ? where ("post_locales"."draft_id" = ? and "post_locales"."locale" = ? and "post_locales"."updated_at" is ?) returning "draft_id""#,
                        params![manifest, now, item.draft_id, locale.as_str(), version],
                        |row| row.get::<_, i64>(0),
                    )
                    .optional()?;
                if written.is_none() {
                    stale.push(item.post_id);
                }
            }
        }
        Ok(stale)
    })
}

fn job_ids_detail(job_ids: &[SiteJob]) -> Value {
    json!({"job_ids": job_ids.iter().map(|job| job.job_id).collect::<Vec<_>>()})
}

fn claim_site_jobs(delivery: &Delivery<'_>) -> Result<Vec<SiteJob>> {
    let sqlite = delivery.sqlite();
    let now = delivery.now();
    let lock_id = format!("{}:{}", worker_id("site"), random_uuid());
    let rows: Vec<(i64, String, i64)> = sqlite
        .prepare(
            r#"select "job_id", "publication_key", "attempt_count" from "site_jobs" where ("site_jobs"."status" = ? and ("site_jobs"."next_attempt_at" is null or "site_jobs"."next_attempt_at" <= ?)) order by "site_jobs"."created_at" asc, "site_jobs"."job_id" asc limit ?"#,
        )?
        .query_map(params!["queued", now, SITE_JOB_CLAIM_LIMIT], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        })?
        .collect::<db::rusqlite::Result<_>>()?;
    transaction(sqlite, || {
        let mut claimed = Vec::new();
        for (job_id, publication_key, attempt_count) in rows {
            // A site build the operator has cancelled the rest of the
            // publication for must not start: the condition rides in the claim
            // itself, so a cancellation declared while this row was being read
            // still binds.
            let won = sqlite
                .query_row(
                    &format!(
                        r#"update "site_jobs" set "status" = ?, "locked_by" = ?, "locked_at" = ?, "updated_at" = ? where ("site_jobs"."job_id" = ? and "site_jobs"."status" = ? and {DELIVERY_NOT_CANCELLED}) returning "job_id""#
                    ),
                    params!["rendering", lock_id, now, now, job_id, "queued", publication_key],
                    |row| row.get::<_, i64>(0),
                )
                .optional()?;
            if won.is_some() {
                claimed.push(SiteJob {
                    job_id,
                    publication_key,
                    attempt_count,
                    lock_id: lock_id.clone(),
                });
            }
        }
        if !claimed.is_empty() {
            insert_site_event(
                sqlite,
                "site.build.claimed",
                "info",
                &format!("claimed {} site build job(s)", claimed.len()),
                &job_ids_detail(&claimed),
                &now,
            )?;
        }
        Ok(claimed)
    })
}

fn complete_site_jobs(delivery: &Delivery<'_>, jobs: &[SiteJob]) -> Result<Vec<SiteJob>> {
    let sqlite = delivery.sqlite();
    let now = delivery.now();
    let completed = transaction(sqlite, || {
        let mut completed = Vec::new();
        for job in jobs {
            let updated = sqlite
                .query_row(
                    r#"update "site_jobs" set "status" = ?, "locked_by" = null, "locked_at" = null, "last_error" = null, "updated_at" = ? where ("site_jobs"."job_id" = ? and "site_jobs"."status" = ? and "site_jobs"."locked_by" = ?) returning "job_id""#,
                    params!["published", now, job.job_id, "rendering", job.lock_id],
                    |row| row.get::<_, i64>(0),
                )
                .optional()?;
            if updated.is_some() {
                completed.push(job.clone());
            }
        }
        if !completed.is_empty() {
            insert_site_event(
                sqlite,
                "site.build.published",
                "info",
                &format!("published {} site build job(s)", completed.len()),
                &job_ids_detail(&completed),
                &now,
            )?;
        }
        Ok(completed)
    })?;
    refresh_posts(delivery, completed.iter())?;
    Ok(completed)
}

fn fail_site_jobs(delivery: &Delivery<'_>, jobs: &[SiteJob], message: &str) -> Result<Vec<SiteJob>> {
    let sqlite = delivery.sqlite();
    let now = delivery.now();
    let failed = transaction(sqlite, || {
        let mut failed = Vec::new();
        for job in jobs {
            let attempt = job.attempt_count + 1;
            let retry = attempt < SITE_JOB_MAX_ATTEMPTS;
            let updated = sqlite
                .query_row(
                    r#"update "site_jobs" set "status" = ?, "attempt_count" = ?, "next_attempt_at" = ?, "locked_by" = null, "locked_at" = null, "last_error" = ?, "updated_at" = ? where ("site_jobs"."job_id" = ? and "site_jobs"."status" = ? and "site_jobs"."locked_by" = ?) returning "job_id""#,
                    params![
                        if retry { "queued" } else { "failed" },
                        attempt,
                        retry.then(|| retry_at(delivery, attempt)),
                        message,
                        now,
                        job.job_id,
                        "rendering",
                        job.lock_id,
                    ],
                    |row| row.get::<_, i64>(0),
                )
                .optional()?;
            if updated.is_some() {
                failed.push(job.clone());
            }
        }
        if !failed.is_empty() {
            insert_site_event(
                sqlite,
                "site.build.failed",
                "error",
                message,
                &job_ids_detail(&failed),
                &now,
            )?;
        }
        Ok(failed)
    })?;
    refresh_posts(
        delivery,
        failed
            .iter()
            .filter(|job| job.attempt_count + 1 >= SITE_JOB_MAX_ATTEMPTS),
    )?;
    Ok(failed)
}

/// `refreshPublicationStatus` once per post, in the order first seen.
fn refresh_posts<'j>(delivery: &Delivery<'_>, jobs: impl Iterator<Item = &'j SiteJob>) -> Result<()> {
    let mut seen = Vec::new();
    for post_id in jobs.flat_map(|job| publication_post_id(&job.publication_key)) {
        if !seen.contains(&post_id) {
            seen.push(post_id);
        }
    }
    for post_id in seen {
        delivery.publishing().refresh_publication_status(post_id)?;
    }
    Ok(())
}

fn publication_post_id(publication_key: &str) -> Option<i64> {
    parse_publication_ref(Some(publication_key))
        .filter(|parsed| parsed.kind == PublicationRefKind::Post)
        .map(|parsed| parsed.id)
}

/// `sourceItems`: only the publications asked for. Loading every published
/// post and filtering afterwards cost two queries per publication on every
/// cycle, to render the handful of jobs one batch had actually claimed.
fn source_items(
    delivery: &Delivery<'_>,
    publication_keys: Option<&BTreeSet<String>>,
) -> Result<Vec<PublicationSource>> {
    let sqlite = delivery.sqlite();
    let states = site_locale_states(sqlite, publication_keys)?;
    let post_ids: Vec<i64> = match publication_keys {
        Some(keys) => {
            let ids: Vec<i64> = keys.iter().filter_map(|key| publication_post_id(key)).collect();
            if ids.is_empty() {
                return Ok(Vec::new());
            }
            let marks = vec!["?"; ids.len()].join(", ");
            sqlite
                .prepare(&format!(
                    r#"select "post_id" from "drafts" where ("drafts"."post_id" is not null and "drafts"."post_id" in ({marks})) order by "drafts"."post_id" desc"#
                ))?
                .query_map(params_from_iter(&ids), |row| row.get(0))?
                .collect::<db::rusqlite::Result<_>>()?
        }
        None => sqlite
            .prepare(r#"select "post_id" from "drafts" where "drafts"."post_id" is not null order by "drafts"."post_id" desc"#)?
            .query_map([], |row| row.get(0))?
            .collect::<db::rusqlite::Result<_>>()?,
    };
    let publishing = delivery.publishing();
    post_ids
        .into_iter()
        .map(|post_id| {
            let mut source = publishing.publication_source_from_db(post_id)?;
            if let Some(state) = states.get(&publication_ref(PublicationRefKind::Post, post_id))
                && !state.seen.is_empty()
            {
                source.ru.site_enabled = state.active.contains(&Locale::Ru);
                source.en.site_enabled = state.active.contains(&Locale::En);
            }
            Ok(source)
        })
        .collect()
}

#[derive(Default)]
struct SiteLocaleState {
    seen: Vec<Locale>,
    active: Vec<Locale>,
}

/// `(?:^|_)(ru|en)(?:_|$)`: the first `_`-separated part of a job reason that
/// names a locale.
fn reason_locale(reason: &str) -> Option<Locale> {
    reason.split('_').find_map(|part| match part {
        "ru" => Some(Locale::Ru),
        "en" => Some(Locale::En),
        _ => None,
    })
}

/// `siteLocaleStates`: site publication state is the authority after a
/// target is cancelled.
fn site_locale_states(
    sqlite: &Connection,
    publication_keys: Option<&BTreeSet<String>>,
) -> Result<HashMap<String, SiteLocaleState>> {
    let select = r#"select "publication_key", "reason", "status" from "site_jobs""#;
    let (sql, keys): (String, Vec<&String>) = match publication_keys {
        Some(keys) if keys.is_empty() => return Ok(HashMap::new()),
        Some(keys) => (
            format!(
                r#"{select} where "site_jobs"."publication_key" in ({})"#,
                vec!["?"; keys.len()].join(", ")
            ),
            keys.iter().collect(),
        ),
        None => (select.to_owned(), Vec::new()),
    };
    let rows: Vec<(String, String, String)> = sqlite
        .prepare(&sql)?
        .query_map(params_from_iter(keys), |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        })?
        .collect::<db::rusqlite::Result<_>>()?;
    let mut states: HashMap<String, SiteLocaleState> = HashMap::new();
    for (publication_key, reason, status) in rows {
        let Some(locale) = reason_locale(&reason) else { continue };
        let state = states.entry(publication_key).or_default();
        if !state.seen.contains(&locale) {
            state.seen.push(locale);
        }
        if matches!(status.as_str(), "queued" | "rendering" | "published") && !state.active.contains(&locale) {
            state.active.push(locale);
        }
    }
    Ok(states)
}

async fn prepare_site_media(
    delivery: &Delivery<'_>,
    source: &PublicationSource,
) -> std::result::Result<Option<PreparedSiteMedia>, String> {
    let now = delivery.now_ms();
    let renders = |locale: &PublicationLocaleSource| locale.site_enabled && is_due(locale.publish_at.as_deref(), now);
    let (has_ru, has_en) = (renders(&source.ru), renders(&source.en));
    if !has_ru && !has_en {
        return Ok(None);
    }
    let mut locales = [(Locale::Ru, None), (Locale::En, None)];
    for (entry, (locale, has)) in locales.iter_mut().zip([(&source.ru, has_ru), (&source.en, has_en)]) {
        if has {
            entry.1 = Some(
                materialize_site_media(&delivery.adapters, source.post_id, entry.0, &site_media_source(locale)).await?,
            );
        }
    }
    Ok(Some(PreparedSiteMedia {
        draft_id: source.draft_id,
        post_id: source.post_id,
        locales,
    }))
}

/// An absent or unreadable date does not hold a locale back.
fn is_due(value: Option<&str>, now_ms: i64) -> bool {
    match value.filter(|value| !value.is_empty()) {
        None => true,
        Some(value) => {
            foundation::time::parse_iso_instant(value).map_or(true, |instant| instant.as_millisecond() <= now_ms)
        }
    }
}

fn insert_site_event(
    sqlite: &Connection,
    event_type: &str,
    severity: &str,
    message: &str,
    details: &Value,
    created_at: &str,
) -> Result<()> {
    sqlite.execute(
        r#"insert into "publication_events" ("id", "publication_key", "event_type", "severity", "target", "message", "details_json", "created_at", "acked_at") values (null, null, ?, ?, null, ?, ?, ?, null)"#,
        params![event_type, severity, message, domain::json::stringify(details), created_at],
    )?;
    Ok(())
}
