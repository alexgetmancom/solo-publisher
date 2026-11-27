//! Publications written and moved from the CLI: `article-publish`, drafts and
//! videos published, scheduled and cancelled, and the video retry, settle and
//! script commands.
//!
//! Nothing is reimplemented here: each command calls the Studio service the
//! bot's button calls, as the draft's owner.

use std::sync::LazyLock;

use content::Locale;
use content::message::DraftMessage;
use db::rusqlite::{Connection, OptionalExtension};
use domain::application::publication_ref::{PublicationRefKind, parse_publication_ref, publication_ref};
use domain::channels::effective_post_targets;
use domain::publishing::article_publish::PublishArticleInput;
use domain::publishing::schedule::parse_manual_schedule;
use domain::publishing::video_settle::{KnownPublication, SettleVideoInput};
use domain::publishing::video_types::VideoTarget;
use domain::repositories::{StudioSettingsStore, StudioVideoStore, immediate_transaction};
use domain::studio::access::primary_studio_actor_id;
use domain::studio::services::posts::{DraftConfiguration, PostScheduleScope};
use domain::targets::{TargetMap, is_story_target, target_locale};
use foundation::errors::StudioError;
use foundation::time::{Zone, parse_iso_instant, to_iso_string};
use jiff::Timestamp;
use regex::Regex;
use serde_json::{Map, Value, json};

use crate::context::{Fut, Input, OpError, OpResult, OperationContext, to_value};

fn locale(value: &str) -> Locale {
    if value == "en" { Locale::En } else { Locale::Ru }
}

/// `[...new Set(targets)]`.
fn unique(targets: &[String]) -> Vec<String> {
    let mut seen: Vec<String> = Vec::new();
    for target in targets {
        if !seen.contains(target) {
            seen.push(target.clone());
        }
    }
    seen
}

/// `publishText`: the complete operator-authored text publication, in one
/// database transaction.
pub fn publish<'a>(context: &'a OperationContext<'a>, input: &'a Input) -> Fut<'a, OpResult> {
    Box::pin(async move {
        let config = context.config()?;
        let wanted = input.str("locale");
        let targets = unique(&input.strings("targets"));
        if targets.is_empty() {
            return Err(OpError::failed("publish needs at least one target"));
        }
        for target in &targets {
            if is_story_target(target) {
                return Err(OpError::Failed(format!(
                    "publish does not create Story media; use the draft editor for {target}"
                )));
            }
            let Some(locale) = target_locale(target) else {
                return Err(OpError::Failed(format!("unknown publication target: {target}")));
            };
            if locale.as_str() != wanted {
                return Err(OpError::Failed(format!(
                    "{target} is {}, not {wanted}",
                    locale.as_str()
                )));
            }
        }
        // A target with no connected channel is dropped when the plan is
        // built; reporting `queued` for a publication with nothing to deliver
        // told an operator it went out.
        let sqlite = context.sqlite()?;
        let requested: TargetMap = targets.iter().map(|target| (target.clone(), true)).collect();
        let deliverable = effective_post_targets(sqlite, &requested)?;
        let unconnected: Vec<&str> = targets
            .iter()
            .map(String::as_str)
            .filter(|target| !deliverable.get(target))
            .collect();
        if !unconnected.is_empty() {
            return Err(OpError::Failed(format!(
                "no connected channel for {}; run `channels` to see what is connected",
                unconnected.join(", ")
            )));
        }
        let actor_id = primary_studio_actor_id(&config)
            .filter(|id| *id != 0)
            .ok_or_else(|| OpError::failed("publish needs a configured Studio actor"))?;
        let posts = context.services(&config)?.posts;
        let text = input.str("text");
        // The text is in one language and goes to targets in that language:
        // writing it into both marked the Russian original as the approved
        // English text, and an English target then published it.
        let english = wanted == "en";
        let message = DraftMessage {
            text: if english { String::new() } else { text.to_owned() },
            text_en: english.then(|| text.to_owned()),
            text_en_approved: english.then(|| text.to_owned()),
            media: Vec::new(),
            entities: Vec::new(),
        };
        let configuration = DraftConfiguration {
            targets: targets.clone(),
            story_mode: None,
        };
        let (draft_id, post_id) = immediate_transaction(sqlite, || {
            let draft_id = posts.create(actor_id, &message, Some(&configuration))?;
            let post_id = posts.publish(actor_id, draft_id)?;
            Ok((draft_id, post_id))
        })?;
        Ok(json!({
            "ok": true,
            "draft_id": draft_id,
            "post_id": post_id,
            "ref": publication_ref(PublicationRefKind::Post, post_id),
            "targets": targets,
            "queued": true,
        }))
    })
}

/// `publishArticle`.
pub fn article_publish<'a>(context: &'a OperationContext<'a>, input: &'a Input) -> Fut<'a, OpResult> {
    Box::pin(async move {
        let config = context.config()?;
        let targets = input.strings("targets");
        let targets: Vec<&str> = targets.iter().map(String::as_str).collect();
        let published = context.studio(&config)?.publishing.publish_article(
            &config,
            &PublishArticleInput {
                locale: locale(input.str("locale")),
                targets: &targets,
                markdown: input.str("markdown"),
            },
        )?;
        Ok(json!({
            "ok": true,
            "article_id": published.article_id,
            "ref": published.publication_ref,
            "title": published.title,
            "targets": published.targets,
            "queued": true,
        }))
    })
}

static EXPLICIT_OFFSET: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[zZ]|[+-][0-9]{2}:?[0-9]{2}$").unwrap());
static OFFSET_DATE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^([0-9]{4}-[0-9]{2}-[0-9]{2})[T ]([0-9]{2}:[0-9]{2})(:[0-9]{2}(?:\.[0-9]+)?)?(?i:(z)|([+-][0-9]{2}):?([0-9]{2}))$").unwrap()
});

/// `new Date(text)` of a time written with an explicit offset: the ISO
/// shapes JavaScript reads (seconds optional, `T` or a space, `+0300`).
fn offset_instant(text: &str) -> Option<Timestamp> {
    if let Ok(at) = parse_iso_instant(text) {
        return Some(at);
    }
    let parts = OFFSET_DATE.captures(text)?;
    let seconds = parts.get(3).map_or(":00", |m| m.as_str());
    let offset = match (parts.get(4), parts.get(5), parts.get(6)) {
        (Some(_), _, _) => "Z".to_owned(),
        (None, Some(hours), Some(minutes)) => format!("{}:{}", hours.as_str(), minutes.as_str()),
        _ => return None,
    };
    parse_iso_instant(&format!("{}T{}{seconds}{offset}", &parts[1], &parts[2])).ok()
}

/// `parseOperationSchedule`: the one reading of a time an operator typed.
/// An explicit offset is honoured as written; a bare wall clock belongs to
/// the Studio's time zone.
pub(crate) fn parse_operation_schedule(sqlite: &Connection, value: &str, now: Timestamp) -> Result<Timestamp, OpError> {
    let trimmed = value.trim();
    if EXPLICIT_OFFSET.is_match(trimmed) {
        return offset_instant(trimmed).ok_or_else(|| OpError::Failed(format!("invalid schedule time: {value}")));
    }
    let timezone = StudioSettingsStore::new(sqlite).profile()?.timezone;
    let zone = Zone::parse(&timezone).ok_or_else(|| OpError::Failed(format!("Invalid time zone: {timezone}")))?;
    Ok(parse_manual_schedule(trimmed, &zone, now)?)
}

struct PostDraft {
    id: i64,
    actor_id: i64,
    post_id: Option<i64>,
    status: String,
}

fn post_draft(sqlite: &Connection, draft_id: i64) -> Result<PostDraft, OpError> {
    sqlite
        .query_row(
            r#"select "id", "actor_id", "post_id", "status" from "drafts" where "drafts"."id" = ?"#,
            [draft_id],
            |row| {
                Ok(PostDraft {
                    id: row.get(0)?,
                    actor_id: row.get(1)?,
                    post_id: row.get(2)?,
                    status: row.get(3)?,
                })
            },
        )
        .optional()?
        .ok_or_else(|| OpError::Failed(format!("draft not found: {draft_id}")))
}

struct VideoDraft {
    id: i64,
    actor_id: i64,
    status: String,
    label: String,
}

fn video_draft(sqlite: &Connection, draft_id: i64) -> Result<VideoDraft, OpError> {
    sqlite
        .query_row(
            r#"select "id", "actor_id", "status", "label" from "video_drafts" where "video_drafts"."id" = ?"#,
            [draft_id],
            |row| {
                Ok(VideoDraft {
                    id: row.get(0)?,
                    actor_id: row.get(1)?,
                    status: row.get(2)?,
                    label: row.get(3)?,
                })
            },
        )
        .optional()?
        .ok_or_else(|| OpError::Failed(format!("video draft not found: {draft_id}")))
}

/// The answer of a command run without `apply`: what it would do.
fn plan(action: &str, subject: &Map<String, Value>, hint: &str) -> Value {
    let mut out = Map::new();
    out.insert("ok".into(), json!(true));
    out.insert("action".into(), json!(action));
    out.extend(subject.clone());
    out.insert("applied".into(), json!(false));
    out.insert("hint".into(), json!(hint));
    Value::Object(out)
}

/// `{ ok: true, action, ...subject, ...extra, applied: true }`, a key already
/// in `subject` keeping its position.
fn applied(action: &str, subject: &Map<String, Value>, extra: Map<String, Value>) -> Value {
    let mut out = Map::new();
    out.insert("ok".into(), json!(true));
    out.insert("action".into(), json!(action));
    out.extend(subject.clone());
    out.extend(extra);
    out.insert("applied".into(), json!(true));
    Value::Object(out)
}

fn fields(value: Value) -> Map<String, Value> {
    match value {
        Value::Object(fields) => fields,
        _ => unreachable!("built as an object"),
    }
}

/// `publishPostDraft`.
pub fn draft_publish<'a>(context: &'a OperationContext<'a>, input: &'a Input) -> Fut<'a, OpResult> {
    Box::pin(async move {
        let config = context.config()?;
        let draft = post_draft(context.sqlite()?, input.int("draft"))?;
        let subject = fields(json!({"draft_id": draft.id, "post_id": draft.post_id, "status": draft.status}));
        if !input.bool("apply") {
            return Ok(plan(
                "draft-publish",
                &subject,
                "re-run with apply to send it to every enabled platform now",
            ));
        }
        let post_id = context.services(&config)?.posts.publish(draft.actor_id, draft.id)?;
        Ok(applied("draft-publish", &subject, fields(json!({"post_id": post_id}))))
    })
}

/// `schedulePostDraft`.
pub fn draft_schedule<'a>(context: &'a OperationContext<'a>, input: &'a Input) -> Fut<'a, OpResult> {
    Box::pin(async move {
        let config = context.config()?;
        let raw_at = input.str("at");
        if raw_at.trim().is_empty() {
            return Err(OpError::failed("missing schedule time"));
        }
        let scope_name = input.opt_str("locale").unwrap_or("both");
        let sqlite = context.sqlite()?;
        let draft = post_draft(sqlite, input.int("draft"))?;
        let at = parse_operation_schedule(sqlite, raw_at, context.now())?;
        let subject = fields(json!({
            "draft_id": draft.id,
            "post_id": draft.post_id,
            "locale": scope_name,
            "at": to_iso_string(at),
        }));
        if !input.bool("apply") {
            return Ok(plan(
                "draft-schedule",
                &subject,
                "re-run with apply to put it in the queue for that time",
            ));
        }
        let scope = match scope_name {
            "ru" => PostScheduleScope::Ru,
            "en" => PostScheduleScope::En,
            _ => PostScheduleScope::Both,
        };
        let posts = context.services(&config)?.posts;
        let schedule = posts.schedule_at(draft.actor_id, draft.id, scope, at)?;
        let post_id = posts.schedule(draft.actor_id, draft.id, &schedule)?;
        let updated = posts.get(draft.actor_id, draft.id)?;
        Ok(applied(
            "draft-schedule",
            &subject,
            fields(json!({"post_id": post_id, "ru_at": updated.scheduled_at, "en_at": updated.scheduled_en_at})),
        ))
    })
}

/// `cancelPostDraft`.
pub fn draft_cancel<'a>(context: &'a OperationContext<'a>, input: &'a Input) -> Fut<'a, OpResult> {
    Box::pin(async move {
        let config = context.config()?;
        let draft = post_draft(context.sqlite()?, input.int("draft"))?;
        let subject = fields(json!({"draft_id": draft.id, "post_id": draft.post_id, "status": draft.status}));
        if !input.bool("apply") {
            return Ok(plan(
                "draft-cancel",
                &subject,
                "re-run with apply to call it off; anything already delivered stays where it is",
            ));
        }
        context.services(&config)?.posts.cancel(draft.actor_id, draft.id)?;
        Ok(applied("draft-cancel", &subject, Map::new()))
    })
}

/// `publishVideoDraft`.
pub fn video_publish<'a>(context: &'a OperationContext<'a>, input: &'a Input) -> Fut<'a, OpResult> {
    Box::pin(async move {
        let config = context.config()?;
        let draft = video_draft(context.sqlite()?, input.int("draft"))?;
        let subject = fields(json!({"draft_id": draft.id, "label": draft.label, "status": draft.status}));
        if !input.bool("apply") {
            return Ok(plan(
                "video-publish",
                &subject,
                "re-run with apply to send it to every chosen platform",
            ));
        }
        let technical = context
            .services(&config)?
            .videos
            .publish(draft.actor_id, draft.id)
            .await?;
        Ok(applied(
            "video-publish",
            &subject,
            fields(json!({"seconds": technical.seconds})),
        ))
    })
}

/// `scheduleVideoDraft`: every platform this video is going to, at the one
/// time given — a per-target time is a card with a picker behind it.
pub fn video_schedule<'a>(context: &'a OperationContext<'a>, input: &'a Input) -> Fut<'a, OpResult> {
    Box::pin(async move {
        let config = context.config()?;
        let raw_at = input.str("at");
        if raw_at.trim().is_empty() {
            return Err(OpError::failed("missing schedule time"));
        }
        let sqlite = context.sqlite()?;
        let draft = video_draft(sqlite, input.int("draft"))?;
        let at = parse_operation_schedule(sqlite, raw_at, context.now())?;
        let subject = fields(json!({"draft_id": draft.id, "label": draft.label, "at": to_iso_string(at)}));
        if !input.bool("apply") {
            return Ok(plan(
                "video-schedule",
                &subject,
                "re-run with apply to put every chosen platform in the queue for that time",
            ));
        }
        let targets: Vec<String> = StudioVideoStore::new(sqlite)
            .targets(draft.id)?
            .into_iter()
            .map(|row| row.target)
            .collect();
        if targets.is_empty() {
            return Err(OpError::Failed(format!(
                "video draft {} has no platforms chosen",
                draft.id
            )));
        }
        let schedule: Vec<(VideoTarget, Timestamp)> = targets
            .iter()
            .filter_map(|target| VideoTarget::parse(target))
            .map(|target| (target, at))
            .collect();
        let technical = context
            .services(&config)?
            .videos
            .schedule(draft.actor_id, draft.id, &schedule)
            .await?;
        Ok(applied(
            "video-schedule",
            &subject,
            fields(json!({"targets": targets, "seconds": technical.seconds})),
        ))
    })
}

/// `cancelVideoDraft`.
pub fn video_cancel<'a>(context: &'a OperationContext<'a>, input: &'a Input) -> Fut<'a, OpResult> {
    Box::pin(async move {
        let config = context.config()?;
        let draft = video_draft(context.sqlite()?, input.int("draft"))?;
        let subject = fields(json!({"draft_id": draft.id, "label": draft.label, "status": draft.status}));
        if !input.bool("apply") {
            return Ok(plan(
                "video-cancel",
                &subject,
                "re-run with apply to call it off; a YouTube upload already made is held private and anything published needs removing by hand",
            ));
        }
        let cancellation = context
            .services(&config)?
            .videos
            .cancel(draft.actor_id, draft.id)
            .await?;
        Ok(applied("video-cancel", &subject, fields(to_value(cancellation)?)))
    })
}

/// The `video-retry` handler.
pub fn video_retry<'a>(context: &'a OperationContext<'a>, input: &'a Input) -> Fut<'a, OpResult> {
    Box::pin(async move {
        let config = context.config()?;
        let draft_id = input.int("draft");
        let target = input.str("target");
        // A name that is no video target has no row, which `retryVideoTarget`
        // refuses as not failed.
        let video_target = VideoTarget::parse(target).ok_or_else(|| StudioError::new("err.retry-only-failed"))?;
        let retry = context
            .studio(&config)?
            .publishing
            .retry_video_target(&config, context.adapters()?, draft_id, video_target)
            .await?;
        Ok(json!({
            "ref": publication_ref(PublicationRefKind::Video, draft_id),
            "target": target,
            "requeued": if retry.settled.is_none() { 1 } else { 0 },
            "settled": retry.settled,
        }))
    })
}

/// The `video-settle` handler.
pub fn video_settle<'a>(context: &'a OperationContext<'a>, input: &'a Input) -> Fut<'a, OpResult> {
    Box::pin(async move {
        let config = context.config()?;
        let known = KnownPublication {
            provider_post_id: input.opt_str("provider_post_id").map(str::to_owned),
            external_id: input.opt_str("external_id").map(str::to_owned),
            url: input.opt_str("url").map(str::to_owned),
        };
        let answer = context
            .studio(&config)?
            .publishing
            .settle_video_target(
                &config,
                context.adapters()?,
                &SettleVideoInput {
                    video_draft_id: input.int("draft"),
                    target: input.str("target"),
                    apply: input.bool("apply"),
                    known: Some(known),
                },
            )
            .await?;
        Ok(Value::Object(answer))
    })
}

/// The `video-script` handler.
pub fn video_script<'a>(context: &'a OperationContext<'a>, input: &'a Input) -> Fut<'a, OpResult> {
    Box::pin(async move {
        let parsed =
            parse_publication_ref(input.opt_str("ref")).filter(|parsed| parsed.kind == PublicationRefKind::Video);
        let Some(parsed) = parsed else {
            return Err(OpError::failed(
                "--ref must look like video:12; `recent` lists the refs.",
            ));
        };
        let script = match input.opt_str("file").filter(|file| !file.is_empty()) {
            Some(file) => String::from_utf8_lossy(&tokio::fs::read(file).await?).into_owned(),
            None => input.opt_str("text").unwrap_or_default().to_owned(),
        };
        let trimmed = script.trim();
        if trimmed.is_empty() {
            return Err(OpError::failed(
                "Pass --file with a path on this host, or --text with the script itself.",
            ));
        }
        let config = context.config()?;
        context.studio(&config)?.publishing.update_video_script(
            parsed.id,
            &script,
            input.opt_str("source").unwrap_or("operator"),
        )?;
        Ok(json!({
            "ref": publication_ref(PublicationRefKind::Video, parsed.id),
            "characters": trimmed.encode_utf16().count(),
            "lines": trimmed.split('\n').count(),
        }))
    })
}
