//! The delivery repairs: content repair, media replacement, purge, requeue,
//! resume-from, scope plans, settle, skip and resend.
//!
//! Every repair that reaches a live audience reports its scope unless told to
//! act, and one that acts commits its database change and its journal entry
//! in one transaction: the remote calls happen before it, their outcomes are
//! settled inside it.

mod content_repair;
mod media_replacement;
mod purge;
mod requeue;
mod resume_from;
mod scope_plan;
mod settle;
mod skip;

use std::borrow::Cow;
use std::path::Path;
use std::rc::Rc;
use std::sync::Arc;

use adapters::AdapterContext;
use content::Locale;
use db::BackendDb;
use db::rusqlite::{Connection, OptionalExtension, params};
use delivery::Delivery;
use delivery::external_edits::{PublishedTargetEdit, edit_published_targets};
use delivery::external_removals::{
    RemovalOptions, attempt_published_target_removals, settle_published_target_removals,
};
use domain::application::ports::{Clock, DomainEventInput, Severity};
use domain::publishing::Publishing;
use domain::publishing::publication_source::PublicationSource;
use domain::repositories::{record_event, transaction};
use domain::studio::services::posts::PostScheduleScope;
use domain::targets::is_known_target;
use foundation::config::Config;
use foundation::time::to_iso_string;
use jiff::Timestamp;
use runtime::http::HttpClient;
use serde_json::{Map, Value, json};

use self::content_repair::{
    assert_reviewed_text, edit_locale_content_tx, parse_locale_entities, parse_locale_media, refresh_locale_site_tx,
    replace_locale_media_tx,
};
use self::requeue::{attempt_text_fallback_removals, requeue_after_removal_tx, requeue_publication_scope_tx};
use self::scope_plan::{publication_scope, scope_plan};
use super::publication_ref::{ResolvedPublicationRef, resolve_publication_ref};
use crate::context::{Fut, Input, OpError, OpResult, OperationContext};

/// A plain refusal carrying just the message.
fn refusal(message: impl Into<Cow<'static, str>>) -> domain::Error {
    domain::Error::message(message)
}

fn object(value: Value) -> Map<String, Value> {
    match value {
        Value::Object(map) => map,
        _ => Map::new(),
    }
}

/// The instant a command started, as the clock the adapters are handed. The
/// edit, removal and presence ports never read it — only publishing does,
/// and it is never reached from here — so it cannot move under them.
struct Started(Timestamp);

impl Clock for Started {
    fn now(&self) -> Timestamp {
        self.0
    }
}

/// What a repair runs on: publishing over the command's connection and
/// clock, the configuration, and the HTTP client platforms are reached by.
pub(crate) struct CommandHandle<'c> {
    publishing: Publishing<'c>,
    db: &'c BackendDb,
    config: Arc<Config>,
    http: HttpClient,
}

impl<'c> CommandHandle<'c> {
    fn now(&self) -> String {
        to_iso_string(self.publishing.clock.now())
    }

    fn adapter_context(&self) -> AdapterContext {
        AdapterContext {
            config: Arc::clone(&self.config),
            client: self.http.clone(),
            clock: Rc::new(Started(self.publishing.clock.now())),
        }
    }

    fn delivery(&self) -> Delivery<'c> {
        Delivery::new(self.db, self.publishing.boundaries, self.adapter_context())
    }

    fn source(&self, reference: &ResolvedPublicationRef) -> Result<PublicationSource, OpError> {
        Ok(self.publishing.publication_source_from_db(reference.post_id)?)
    }
}

/// Builds the handle and runs `work` on it.
async fn with_handle<'a, T>(
    context: &'a OperationContext<'a>,
    work: impl AsyncFnOnce(&CommandHandle<'_>) -> Result<T, OpError>,
) -> Result<T, OpError> {
    let config = context.config()?;
    let studio = context.studio(&config)?;
    let handle = CommandHandle {
        publishing: studio.publishing,
        db: context.db()?,
        config: Arc::clone(&config),
        http: context.http.clone(),
    };
    work(&handle).await
}

/// The newest publish job of one target.
struct Job {
    job_id: i64,
    publication_key: String,
    status: String,
    payload_json: Option<String>,
}

fn latest_job(sqlite: &Connection, publication_key: &str, target: &str) -> Result<Option<Job>, OpError> {
    Ok(sqlite
        .query_row(
            r#"select "job_id", "publication_key", "status", "payload_json" from "publish_jobs" where ("publish_jobs"."publication_key" = ? and "publish_jobs"."target" = ?) order by "publish_jobs"."job_id" desc"#,
            params![publication_key, target],
            |row| {
                Ok(Job {
                    job_id: row.get(0)?,
                    publication_key: row.get(1)?,
                    status: row.get(2)?,
                    payload_json: row.get(3)?,
                })
            },
        )
        .optional()?)
}

fn resolve(context: &OperationContext<'_>, reference: &str) -> Result<ResolvedPublicationRef, OpError> {
    resolve_publication_ref(context.sqlite()?, reference)?
        .ok_or_else(|| OpError::failed(format!("publication not found: {reference}")))
}

// --- runOperationCommand ----------------------------------------------------------

/// One explicit maintenance command (`commandActionSchema` after its parse).
#[derive(Default)]
struct Command<'i> {
    action: &'static str,
    reference: &'i str,
    target: Option<&'i str>,
    locale: Option<&'i str>,
    text: Option<&'i str>,
    entities_json: Option<&'i str>,
    expected_text_sha256: Option<&'i str>,
    media_json: Option<Cow<'i, str>>,
    at: Option<&'i str>,
    schedule_locale: Option<&'i str>,
    /// Publish the scope again after taking it down; `delete` alone leaves it down.
    republish: bool,
    /// Commands that reach a live audience report their scope unless this is set.
    apply: bool,
    actor_type: &'i str,
}

/// Actions whose effect is visible outside this system.
const AUDIENCE_ACTIONS: [&str; 5] = ["retry", "edit", "replace_media", "use_other_media", "delete"];

/// `runOperationCommand`.
async fn run_operation_command(context: &OperationContext<'_>, input: &Command<'_>) -> OpResult {
    let reference = foundation::js::trim(input.reference);
    if reference.is_empty() {
        return Err(OpError::failed("missing publication ref"));
    }
    let publication = resolve(context, reference)?;
    // An unknown target used to reach a worker as a durable job no publisher
    // serves, failing hours later instead of at the keystroke.
    if let Some(target) = input.target.filter(|target| !target.is_empty())
        && !is_known_target(target)
    {
        return Err(OpError::failed(format!("unknown target: {target}")));
    }
    let target = input.target.filter(|target| !target.is_empty());
    // Every command below either sends something to an audience or takes it
    // away, so each reports its scope until told to act.
    if !input.apply && AUDIENCE_ACTIONS.contains(&input.action) {
        let scope = publication_scope(context.sqlite()?, &publication, target, input.locale)?;
        let mut detail = Map::new();
        if input.action == "delete" {
            detail.insert("republish".into(), json!(input.republish));
        }
        return Ok(scope_plan(input.action, &publication, scope, detail));
    }
    with_handle(context, async |handle| match input.action {
        "retry" => {
            let source = handle.source(&publication)?;
            commit_operation(handle, input, &publication, || {
                requeue_publication_scope_tx(&handle.publishing, &publication, &source, target, input.locale)
            })
        }
        "reschedule" => {
            let result = reschedule_post(context, &publication, input.schedule_locale, input.at)?;
            commit_operation(handle, input, &publication, || Ok(result))
        }
        "refresh_site" => {
            let locale = input.locale.unwrap_or("en");
            let now = handle.now();
            commit_operation(handle, input, &publication, || {
                refresh_locale_site_tx(handle.publishing.sqlite, &now, &publication, locale)
            })
        }
        "edit" => edit_text(handle, input, &publication, target).await,
        "replace_media" | "use_other_media" => replace_locale_media(handle, input, &publication, target).await,
        "delete" => {
            let source = handle.source(&publication)?;
            let delivery = handle.delivery();
            let attempts = attempt_published_target_removals(
                &delivery,
                &RemovalOptions {
                    publication_key: publication.publication_key.clone(),
                    target: target.map(str::to_owned),
                    locale: input.locale.map(str::to_owned),
                },
            )
            .await?;
            let now = handle.now();
            commit_operation(handle, input, &publication, || {
                let removed = settle_published_target_removals(handle.publishing.sqlite, &attempts, &now)?;
                let mut result = object(json!({"ok": true, "removed": removed}));
                if input.republish {
                    result.insert(
                        "republish".into(),
                        requeue_after_removal_tx(&handle.publishing, &publication, &source, &removed, target)?,
                    );
                }
                Ok(result)
            })
        }
        action => Err(OpError::failed(format!("unknown action: {action}"))),
    })
    .await
}

async fn edit_text(
    handle: &CommandHandle<'_>,
    input: &Command<'_>,
    publication: &ResolvedPublicationRef,
    target: Option<&str>,
) -> OpResult {
    let locale = input.locale.unwrap_or("en");
    let text = input.text.unwrap_or_default();
    let trimmed = foundation::js::trim(text);
    if trimmed.is_empty() {
        return Err(OpError::failed(format!("text_{locale} is required")));
    }
    let source = handle.source(publication)?;
    let locale_key = if locale == "ru" { Locale::Ru } else { Locale::En };
    assert_reviewed_text(&source.locale(locale_key).text, input.expected_text_sha256)?;
    let entities = parse_locale_entities(input.entities_json, trimmed).map_err(OpError::Failed)?;
    let delivery = handle.delivery();
    let external = edit_published_targets(
        &delivery,
        &PublishedTargetEdit {
            publication_key: publication.publication_key.clone(),
            text_ru: (locale == "ru").then(|| text.to_owned()),
            text_en: (locale == "en").then(|| text.to_owned()),
            target: target.map(str::to_owned),
            locale: Some(locale.to_owned()),
        },
    )
    .await?;
    let fallbacks = attempt_text_fallback_removals(&delivery, publication, target, locale, &external).await?;
    let mut next_source = source;
    match locale_key {
        Locale::Ru => next_source.ru.text = trimmed.to_owned(),
        Locale::En => next_source.en.text = trimmed.to_owned(),
    }
    let now = handle.now();
    commit_operation(handle, input, publication, || {
        let sqlite = handle.publishing.sqlite;
        let mut result = edit_locale_content_tx(
            sqlite,
            &now,
            publication,
            locale,
            text,
            &entities,
            input.expected_text_sha256,
        )?;
        result.insert(
            "external".into(),
            Value::Array(external.iter().cloned().map(Value::Object).collect()),
        );
        let mut replaced = Vec::new();
        for (target, attempts) in &fallbacks {
            let removed = settle_published_target_removals(sqlite, attempts, &now)?;
            if !removed.iter().any(|item| item.ok) {
                continue;
            }
            let republish =
                requeue_after_removal_tx(&handle.publishing, publication, &next_source, &removed, Some(target))?;
            replaced.push(json!({"target": target, "removed": removed, "republish": republish}));
        }
        result.insert("replaced".into(), Value::Array(replaced));
        Ok(result)
    })
}

async fn replace_locale_media(
    handle: &CommandHandle<'_>,
    input: &Command<'_>,
    publication: &ResolvedPublicationRef,
    target: Option<&str>,
) -> OpResult {
    let locale = input.locale.unwrap_or("en");
    let media = if input.action == "replace_media" {
        parse_locale_media(input.media_json.as_deref()).map_err(OpError::Failed)?
    } else {
        None
    };
    let mut next_source = handle.source(publication)?;
    let next_media = match &media {
        Some(media) => media.clone(),
        None if locale == "en" => next_source.ru.media.clone(),
        None => Vec::new(),
    };
    let own = if locale == "ru" {
        &mut next_source.ru
    } else {
        &mut next_source.en
    };
    own.media = next_media.clone();
    own.site_media = next_media;
    let attempts = attempt_published_target_removals(
        &handle.delivery(),
        &RemovalOptions {
            publication_key: publication.publication_key.clone(),
            target: target.map(str::to_owned),
            locale: Some(locale.to_owned()),
        },
    )
    .await?;
    let now = handle.now();
    commit_operation(handle, input, publication, || {
        let sqlite = handle.publishing.sqlite;
        let mut result = replace_locale_media_tx(sqlite, &now, publication, locale, media.as_deref())?;
        let removed = settle_published_target_removals(sqlite, &attempts, &now)?;
        result.insert("removed".into(), serde_json::to_value(&removed)?);
        result.insert(
            "republish".into(),
            requeue_after_removal_tx(&handle.publishing, publication, &next_source, &removed, target)?,
        );
        Ok(result)
    })
}

/// `commitOperation`: the mutation and its journal entry, one transaction.
fn commit_operation(
    handle: &CommandHandle<'_>,
    input: &Command<'_>,
    publication: &ResolvedPublicationRef,
    mutate: impl FnOnce() -> domain::Result<Map<String, Value>>,
) -> OpResult {
    let sqlite = handle.publishing.sqlite;
    let result = transaction(sqlite, || {
        let mut result = mutate()?;
        result.insert("applied".into(), json!(true));
        let mut details = Map::new();
        details.insert("operation".into(), json!(input.action));
        details.insert("surface".into(), json!(input.actor_type));
        details.insert("post_id".into(), json!(publication.post_id));
        details.insert("status".into(), json!("ok"));
        details.insert("result".into(), Value::Object(result.clone()));
        record_event(
            sqlite,
            handle.publishing.clock,
            &DomainEventInput {
                publication_ref: Some(publication.publication_key.clone()),
                event_type: "operations.command".into(),
                severity: Severity::Info,
                target: input.target.map(str::to_owned),
                message: format!("Operations {} executed", input.action),
                details: Some(details),
                cooldown_seconds: None,
            },
        )?;
        Ok(result)
    })?;
    Ok(Value::Object(result))
}

/// `reschedulePost`.
fn reschedule_post(
    context: &OperationContext<'_>,
    publication: &ResolvedPublicationRef,
    locale: Option<&str>,
    raw_at: Option<&str>,
) -> Result<Map<String, Value>, OpError> {
    let Some(locale) = locale else {
        return Err(OpError::failed("missing schedule locale"));
    };
    let Some(raw_at) = raw_at.filter(|at| !foundation::js::trim(at).is_empty()) else {
        return Err(OpError::failed("missing schedule time"));
    };
    let sqlite = context.sqlite()?;
    let draft: Option<(i64, i64)> = sqlite
        .query_row(
            r#"select "id", "actor_id" from "drafts" where "drafts"."post_id" = ?"#,
            [publication.post_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    let Some((draft_id, actor_id)) = draft else {
        return Err(OpError::failed(format!(
            "draft not found for publication: {}",
            publication.publication_key
        )));
    };
    let at = parse_operation_schedule(context, raw_at)?;
    let config = context.config()?;
    let posts = context.services(&config)?.posts;
    let scope = match locale {
        "ru" => PostScheduleScope::Ru,
        "en" => PostScheduleScope::En,
        _ => PostScheduleScope::Both,
    };
    let schedule = posts.schedule_at(actor_id, draft_id, scope, at)?;
    let post_id = posts.schedule(actor_id, draft_id, &schedule)?;
    let updated = posts.get(actor_id, draft_id)?;
    Ok(object(json!({
        "ok": true,
        "action": "reschedule",
        "draft_id": draft_id,
        "post_id": post_id,
        "locale": locale,
        "at": to_iso_string(at),
        "ru_at": updated.scheduled_at,
        "en_at": updated.scheduled_en_at,
        "status": updated.status,
    })))
}

/// `parseOperationSchedule`, the one reading of a time an operator typed.
fn parse_operation_schedule(context: &OperationContext<'_>, value: &str) -> Result<Timestamp, OpError> {
    super::lifecycle::parse_operation_schedule(context.sqlite()?, value, context.now())
}

// --- The registry entries -----------------------------------------------------------

/// `runRepair`: the repair commands' shared input, the locale an argument.
fn repair<'i>(context: &'i OperationContext<'_>, action: &'static str, input: &'i Input) -> Command<'i> {
    Command {
        action,
        reference: input.str("ref"),
        target: input.opt_str("target"),
        locale: input.opt_str("locale"),
        text: input.opt_str("text"),
        entities_json: input.opt_str("entities_json"),
        expected_text_sha256: input.opt_str("expected_text_sha256"),
        media_json: input.opt_str("media_json").map(Cow::Borrowed),
        at: input.opt_str("at"),
        schedule_locale: input.opt_str("schedule_locale"),
        republish: input.bool("republish"),
        apply: input.bool("apply"),
        actor_type: context.actor_type,
    }
}

pub fn retry<'a>(context: &'a OperationContext<'a>, input: &'a Input) -> Fut<'a, OpResult> {
    Box::pin(async move { run_operation_command(context, &repair(context, "retry", input)).await })
}

pub fn edit<'a>(context: &'a OperationContext<'a>, input: &'a Input) -> Fut<'a, OpResult> {
    Box::pin(async move { run_operation_command(context, &repair(context, "edit", input)).await })
}

/// The action is `replace_media`, the one name it has everywhere it is journalled.
pub fn set_media<'a>(context: &'a OperationContext<'a>, input: &'a Input) -> Fut<'a, OpResult> {
    Box::pin(async move { run_operation_command(context, &repair(context, "replace_media", input)).await })
}

pub fn use_other_media<'a>(context: &'a OperationContext<'a>, input: &'a Input) -> Fut<'a, OpResult> {
    Box::pin(async move { run_operation_command(context, &repair(context, "use_other_media", input)).await })
}

pub fn delete<'a>(context: &'a OperationContext<'a>, input: &'a Input) -> Fut<'a, OpResult> {
    Box::pin(async move { run_operation_command(context, &repair(context, "delete", input)).await })
}

pub fn refresh_site<'a>(context: &'a OperationContext<'a>, input: &'a Input) -> Fut<'a, OpResult> {
    Box::pin(async move {
        let command = Command {
            apply: true,
            ..repair(context, "refresh_site", input)
        };
        run_operation_command(context, &command).await
    })
}

pub fn reschedule<'a>(context: &'a OperationContext<'a>, input: &'a Input) -> Fut<'a, OpResult> {
    Box::pin(async move {
        let command = Command {
            action: "reschedule",
            reference: input.str("ref"),
            schedule_locale: input.opt_str("schedule_locale"),
            at: input.opt_str("at"),
            actor_type: context.actor_type,
            ..Command::default()
        };
        run_operation_command(context, &command).await
    })
}

pub fn replace_media<'a>(context: &'a OperationContext<'a>, input: &'a Input) -> Fut<'a, OpResult> {
    Box::pin(async move {
        media_replacement::replace_published_media(
            context,
            &media_replacement::MediaReplacement {
                reference: input.str("ref"),
                locale: input.str("locale"),
                file: Path::new(input.str("file")),
                target: input.str("target"),
                apply: input.bool("apply"),
            },
        )
        .await
    })
}

pub fn purge<'a>(context: &'a OperationContext<'a>, input: &'a Input) -> Fut<'a, OpResult> {
    Box::pin(async move {
        with_handle(context, async |handle| {
            purge::purge_publication(handle, input.str("ref"), input.bool("apply")).await
        })
        .await
    })
}

pub fn resume_from<'a>(context: &'a OperationContext<'a>, input: &'a Input) -> Fut<'a, OpResult> {
    Box::pin(async move {
        let reference = resolve(context, input.str("ref"))?;
        with_handle(context, async |handle| {
            resume_from::resume_target_from(
                handle,
                &resume_from::ResumeFromInput {
                    reference,
                    target: input.str("target"),
                    external_id: input.str("external_id"),
                    apply: input.bool("apply"),
                    actor_type: context.actor_type,
                },
            )
        })
        .await
    })
}

pub fn skip<'a>(context: &'a OperationContext<'a>, input: &'a Input) -> Fut<'a, OpResult> {
    Box::pin(async move {
        let reference = resolve(context, input.str("ref"))?;
        with_handle(context, async |handle| {
            skip::skip_publication_targets(
                handle,
                &reference,
                input.opt_str("target"),
                input.bool("apply"),
                context.actor_type,
            )
        })
        .await
    })
}

pub fn resend<'a>(context: &'a OperationContext<'a>, input: &'a Input) -> Fut<'a, OpResult> {
    Box::pin(async move {
        let reference = resolve(context, input.str("ref"))?;
        with_handle(context, async |handle| {
            skip::resend_publication_target(
                handle,
                &reference,
                input.str("target"),
                input.bool("apply"),
                context.actor_type,
            )
        })
        .await
    })
}

pub fn settle<'a>(context: &'a OperationContext<'a>, input: &'a Input) -> Fut<'a, OpResult> {
    Box::pin(async move {
        let reference = resolve(context, input.str("ref"))?;
        with_handle(context, async |handle| {
            settle::settle_ambiguous_target(
                handle,
                &settle::SettleInput {
                    reference,
                    target: input.str("target"),
                    external_id: input.opt_str("external_id"),
                    url: input.opt_str("url"),
                    apply: input.bool("apply"),
                    actor_type: context.actor_type,
                },
            )
        })
        .await
    })
}
