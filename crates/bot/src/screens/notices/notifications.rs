//! The Telegram delivery of Studio's publication events
//! (`interfaces/telegram/video-notifications.ts`): reminders,
//! completions, a video target that failed or that nobody can confirm, and the
//! video card redrawn in place. Every notice reaches every administrator.

use content::Locale;
use db::rusqlite::{OptionalExtension, params};
use domain::application::conversation_flow::PublicationKind;
use domain::application::publication_ref::{PublicationRefKind, parse_publication_ref, publication_ref};
use domain::publishing::state::{is_audience_mutation_retryable, is_partial_delivery, is_post_target_retryable};
use domain::publishing::video_types::VideoTarget;
use domain::studio::services::settings::TimeConfig;
use domain::targets::{is_site_target, target_definition, target_locale};
use foundation::i18n::{Key, t};
use foundation::js::number_to_string;
use foundation::logger::{LogLevel, log};
use foundation::time::{Zone, format_zoned_date_time, parse_iso_instant};
use serde_json::{Map, Value, json};

use crate::api::payload::{InlineKeyboard, Payload};
use crate::callback::publication_callback;
use crate::cards;
use crate::context::Ctx;
use crate::effects::error_js_string;
use crate::publication::unlanded::{Origin, UnlandedTarget, append_unlanded_controls};
use crate::publication::{CardRequest, render_card};

/// A journalled event as the notices read it.
pub struct StudioEvent<'a> {
    pub publication_key: Option<&'a str>,
    pub event_type: &'a str,
    pub details: &'a Map<String, Value>,
}

/// One administrator blocking the bot must not keep the shared publication
/// update from the remaining operators.
fn log_undelivered(actor_id: i64, error: &(dyn std::error::Error + 'static)) {
    log(
        LogLevel::Warn,
        "shared Studio notification was not delivered",
        Some(json!({"actorId": actor_id, "error": error_js_string(error)})),
    );
}

/// `typeof value === "number" && Number.isFinite(value)`.
fn number(value: Option<&Value>) -> Option<f64> {
    value.and_then(Value::as_f64).filter(|value| value.is_finite())
}

fn locale_detail(value: Option<&Value>) -> Option<Locale> {
    match value.and_then(Value::as_str) {
        Some("ru") => Some(Locale::Ru),
        Some("en") => Some(Locale::En),
        _ => None,
    }
}

fn locale_name(locale: Locale) -> String {
    t(
        match locale {
            Locale::En => Key::NotifLocaleEn,
            Locale::Ru => Key::NotifLocaleRu,
        },
        &[],
    )
}

/// One label per target, taken from the two vocabularies that own them.
fn friendly_target(target: &str) -> String {
    match VideoTarget::parse(target) {
        Some(video) => video.label().to_owned(),
        None => target_definition(target).map_or_else(|| target.to_owned(), |definition| definition.label.to_owned()),
    }
}

/// `formatVideoTime`: a scheduled instant in the owner's zone.
fn format_video_time(value: &str, time_config: &TimeConfig) -> crate::Result<String> {
    if value.is_empty() {
        return Ok(t(Key::VideoTimeUnset, &[]));
    }
    let zone = Zone::parse(&time_config.timezone)
        .ok_or_else(|| crate::error(format!("Invalid time zone specified: {}", time_config.timezone)))?;
    let at = parse_iso_instant(value).map_err(|_| crate::error("Invalid time value"))?;
    Ok(format_zoned_date_time(Some(at), &zone, &time_config.timezone_label))
}

/// `\s+` → one space, then at most 180 code points.
fn short_error(value: &str) -> String {
    let mut collapsed = String::with_capacity(value.len());
    let mut in_space = false;
    for c in value.chars() {
        if foundation::js::is_whitespace(c) {
            if !in_space {
                collapsed.push(' ');
            }
            in_space = true;
        } else {
            collapsed.push(c);
            in_space = false;
        }
    }
    foundation::text::truncate_unicode(&collapsed, 180).to_owned()
}

fn video_locale_for_ref(ctx: &Ctx, key: Option<&str>) -> crate::Result<Option<Locale>> {
    let Some(publication) = parse_publication_ref(key).filter(|publication| publication.kind == PublicationRefKind::Video)
    else {
        return Ok(None);
    };
    let locale: Option<String> = ctx
        .db()
        .query_row(
            r#"select "locale" from "video_drafts" where "video_drafts"."id" = ?"#,
            [publication.id],
            |row| row.get(0),
        )
        .optional()?;
    Ok(match locale.as_deref() {
        Some("en") => Some(Locale::En),
        Some("ru") => Some(Locale::Ru),
        _ => None,
    })
}

fn draft_for_post(ctx: &Ctx, post_id: i64) -> crate::Result<Option<i64>> {
    Ok(ctx
        .db()
        .query_row(
            r#"select "id" from "drafts" where "drafts"."post_id" = ? limit 1"#,
            [post_id],
            |row| row.get(0),
        )
        .optional()?)
}

/// Notifications go to every administrator, so a ref is only checked for
/// still naming a real publication.
fn publication_exists(ctx: &Ctx, key: Option<&str>) -> crate::Result<bool> {
    let Some(publication) = parse_publication_ref(key) else {
        return Ok(false);
    };
    match publication.kind {
        PublicationRefKind::Draft => Ok(false),
        PublicationRefKind::Video => Ok(ctx
            .db()
            .query_row(
                r#"select "id" from "video_drafts" where "video_drafts"."id" = ? limit 1"#,
                [publication.id],
                |row| row.get::<_, i64>(0),
            )
            .optional()?
            .is_some()),
        _ => Ok(draft_for_post(ctx, publication.id)?.is_some()),
    }
}

/// The id the publication callbacks address: a video ref already carries its
/// draft id, a post ref carries the published post and has to be looked up.
fn publication_draft_id(ctx: &Ctx, key: Option<&str>) -> crate::Result<Option<i64>> {
    match parse_publication_ref(key) {
        Some(publication) if publication.kind == PublicationRefKind::Video => Ok(Some(publication.id)),
        Some(publication) if publication.kind == PublicationRefKind::Post => draft_for_post(ctx, publication.id),
        _ => Ok(None),
    }
}

#[derive(Clone, Debug)]
struct CompletionTarget {
    target: String,
    status: String,
    error: Option<String>,
    partial: bool,
    provider: Option<String>,
}

fn completion_targets(ctx: &Ctx, key: Option<&str>) -> crate::Result<Vec<CompletionTarget>> {
    let Some(publication) = parse_publication_ref(key) else {
        return Ok(Vec::new());
    };
    let sqlite = ctx.db();
    match publication.kind {
        PublicationRefKind::Draft => return Ok(Vec::new()),
        PublicationRefKind::Video => {
            // No order, as Drizzle reads it: the draft/target index decides.
            let mut statement = sqlite.prepare(
                r#"select "target", "status", "last_error", "delivery_provider" from "video_targets" where "video_targets"."video_draft_id" = ?"#,
            )?;
            let rows = statement.query_map([publication.id], |row| {
                Ok(CompletionTarget {
                    target: row.get(0)?,
                    status: row.get(1)?,
                    error: row.get(2)?,
                    partial: false,
                    provider: row.get(3)?,
                })
            })?;
            return Ok(rows.collect::<db::rusqlite::Result<_>>()?);
        }
        _ => {}
    }
    let key = publication_ref(PublicationRefKind::Post, publication.id);
    let jobs: Vec<(String, String, Option<String>)> = sqlite
        .prepare(
            r#"select "target", "status", "last_error", "job_id" from "publish_jobs" where "publish_jobs"."publication_key" = ? order by "publish_jobs"."job_id" desc"#,
        )?
        .query_map([&key], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?
        .collect::<db::rusqlite::Result<_>>()?;
    let delivered: Vec<(String, Option<String>)> = sqlite
        .prepare(
            r#"select "target", "external_id", "status" from "publication_targets" where "publication_targets"."publication_key" = ?"#,
        )?
        .query_map([&key], |row| Ok((row.get(0)?, row.get(1)?)))?
        .collect::<db::rusqlite::Result<_>>()?;
    let mut latest: Vec<CompletionTarget> = Vec::new();
    for (target, status, error) in jobs {
        if latest.iter().any(|known| known.target == target) {
            continue;
        }
        let external_id = delivered
            .iter()
            .find(|(known, _)| *known == target)
            .and_then(|(_, id)| id.as_deref());
        latest.push(CompletionTarget {
            partial: is_partial_delivery(&status, external_id),
            target,
            status,
            error,
            provider: None,
        });
    }
    let site: Vec<(String, String, Option<String>)> = sqlite
        .prepare(
            r#"select "reason", "status", "last_error", "job_id" from "site_jobs" where "site_jobs"."publication_key" = ? order by "site_jobs"."job_id" desc"#,
        )?
        .query_map([&key], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?
        .collect::<db::rusqlite::Result<_>>()?;
    for (reason, status, error) in site {
        if is_site_target(&reason) && !latest.iter().any(|known| known.target == reason) {
            latest.push(CompletionTarget {
                target: reason,
                status,
                error,
                partial: false,
                provider: None,
            });
        }
    }
    Ok(latest)
}

fn status_icon(status: &str) -> &'static str {
    match status {
        "published" | "completed" => "✅",
        "failed" => "❌",
        "verification_required" => "⚠️",
        "cancelled" => "🚫",
        _ => "⏳",
    }
}

fn friendly_status(status: &str) -> String {
    t(
        match status {
            "published" | "completed" => Key::NotifDeliveryPublished,
            "failed" => Key::NotifDeliveryFailed,
            "verification_required" => Key::NotifDeliveryVerification,
            "cancelled" => Key::NotifDeliveryCancelled,
            _ => Key::NotifDeliveryPending,
        },
        &[],
    )
}

fn is_unlanded(status: &str) -> bool {
    status == "failed" || status == "verification_required"
}

fn remaining_schedule_text(details: &Map<String, Value>, time_config: &TimeConfig) -> crate::Result<String> {
    let mut lines = Vec::new();
    for item in details.get("remaining").and_then(Value::as_array).into_iter().flatten() {
        let Some(item) = item.as_object() else { continue };
        let Some(locale) = locale_detail(item.get("locale")) else {
            continue;
        };
        let at = match item.get("scheduled_at").and_then(Value::as_str) {
            Some(at) => Some(format_video_time(at, time_config)?),
            None => None,
        };
        let locale = locale_name(locale);
        lines.push(match &at {
            Some(at) => t(Key::NotifRemainingScheduled, &[("locale", &locale), ("at", at)]),
            None => t(Key::NotifRemainingUnscheduled, &[("locale", &locale), ("at", &"")]),
        });
    }
    Ok(lines.join("\n"))
}

/// `sendStudioReminder`: the reminder reaches every administrator, so the
/// actor only says the event still refers to something real (`admin_id` is
/// the spelling events written before migration 0030 carry).
pub async fn send_studio_reminder(ctx: &Ctx, event: &StudioEvent<'_>) -> crate::Result<()> {
    let details = event.details;
    let known = number(details.get("actor_id")).is_some()
        || number(details.get("admin_id")).is_some()
        || publication_exists(ctx, event.publication_key)?;
    if !known {
        return Ok(());
    }
    let targets: Vec<&str> = details
        .get("targets")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .collect();
    let minutes = number(details.get("minutes")).unwrap_or(5.0);
    let publish_at = details
        .get("publish_at")
        .and_then(Value::as_str)
        .filter(|at| !at.is_empty());
    let video_locale = video_locale_for_ref(ctx, event.publication_key)?;
    // Reminders are enabled per publication kind; only a video ref means video.
    let is_video = parse_publication_ref(event.publication_key)
        .is_some_and(|publication| publication.kind == PublicationRefKind::Video);
    for &actor_id in &ctx.config.controller_admin_ids {
        let result: crate::Result<()> = async {
            let services = ctx.services();
            let notifications = services.settings.notifications(actor_id)?;
            let enabled = if is_video {
                notifications.video_reminders_enabled
            } else {
                notifications.post_reminders_enabled
            };
            if !enabled {
                return Ok(());
            }
            let time_config = services.settings.time_config(actor_id)?;
            let title = match details.get("title").and_then(Value::as_str) {
                Some(title) => title.to_owned(),
                None => event
                    .publication_key
                    .map_or_else(|| t(Key::NotifPublication, &[]), str::to_owned),
            };
            let suffix = video_locale.map_or_else(String::new, |locale| format!(" · {}", locale.as_str().to_uppercase()));
            let lines: Vec<String> = targets
                .iter()
                .map(|target| format!("• {}{suffix}", friendly_target(target)))
                .collect();
            let locale_line = video_locale.map_or_else(String::new, |locale| format!("\n{}", locale_name(locale)));
            let time = match publish_at {
                Some(at) => format!("\n\n{}", format_video_time(at, &time_config)?),
                None => String::new(),
            };
            let text = format!(
                "{}\n\n🎬 {title}{locale_line}\n\n{}{time}",
                t(Key::NotifReminderHead, &[("minutes", &number_to_string(minutes))]),
                lines.join("\n")
            );
            ctx.bot
                .api()
                .send_message(actor_id, foundation::js::trim(&text), Payload::new())
                .await?;
            Ok(())
        }
        .await;
        if let Err(error) = result {
            log_undelivered(actor_id, &*error);
        }
    }
    Ok(())
}

/// `sendStudioCompletion`: a publication (or one language of a post) is done.
pub async fn send_studio_completion(ctx: &Ctx, event: &StudioEvent<'_>) -> crate::Result<()> {
    if !publication_exists(ctx, event.publication_key)? {
        return Ok(());
    }
    let details = event.details;
    let count = |key: &str| number(details.get(key)).unwrap_or(0.0);
    let (total, published, failed, awaiting) = (count("total"), count("published"), count("failed"), count("awaiting"));
    let partial_locale = if event.event_type == "delivery.post.locale.completed" {
        locale_detail(details.get("locale"))
    } else {
        None
    };
    let results: Vec<CompletionTarget> = completion_targets(ctx, event.publication_key)?
        .into_iter()
        .filter(|result| partial_locale.is_none() || target_locale(&result.target) == partial_locale)
        .collect();
    let video_locale = video_locale_for_ref(ctx, event.publication_key)?;
    let failed_targets: Vec<&CompletionTarget> = results.iter().filter(|result| is_unlanded(&result.status)).collect();
    let publication = parse_publication_ref(event.publication_key);
    let kind = publication.map(|publication| publication.kind);
    let retryable_targets: Vec<&CompletionTarget> = failed_targets
        .iter()
        .copied()
        .filter(|result| match kind {
            Some(PublicationRefKind::Video) => is_audience_mutation_retryable(&result.status),
            Some(PublicationRefKind::Post) => {
                is_post_target_retryable(&result.target, &result.status, result.error.as_deref())
            }
            _ => false,
        })
        .collect();
    let draft_id = publication_draft_id(ctx, event.publication_key)?;
    for &actor_id in &ctx.config.controller_admin_ids {
        let result: crate::Result<()> = async {
            let services = ctx.services();
            if !services.settings.notifications(actor_id)?.completion_enabled {
                return Ok(());
            }
            let time_config = services.settings.time_config(actor_id)?;
            let label = t(
                if kind == Some(PublicationRefKind::Video) {
                    Key::NotifLabelVideo
                } else {
                    Key::NotifLabelPost
                },
                &[],
            );
            let n = |value: f64| number_to_string(value);
            // `published || total`: nothing published reads as the total.
            let done = n(if published == 0.0 || published.is_nan() {
                total
            } else {
                published
            });
            let headline = match partial_locale {
                Some(locale) if failed != 0.0 => t(
                    Key::NotifLocaleCompletionFailed,
                    &[
                        ("label", &label),
                        ("locale", &locale_name(locale)),
                        ("published", &n(published)),
                        ("total", &n(total)),
                        ("failed", &n(failed)),
                    ],
                ),
                Some(locale) => t(
                    Key::NotifLocaleCompletionOk,
                    &[
                        ("label", &label),
                        ("locale", &locale_name(locale)),
                        ("done", &done),
                        ("total", &n(total)),
                    ],
                ),
                None if failed != 0.0 => t(
                    Key::NotifCompletionFailed,
                    &[
                        ("label", &label),
                        ("published", &n(published)),
                        ("total", &n(total)),
                        ("failed", &n(failed)),
                    ],
                ),
                None if awaiting != 0.0 => t(
                    Key::NotifCompletionAwaiting,
                    &[
                        ("label", &label),
                        ("published", &n(published)),
                        ("total", &n(total)),
                        ("awaiting", &n(awaiting)),
                    ],
                ),
                None => t(
                    Key::NotifCompletionOk,
                    &[("label", &label), ("done", &done), ("total", &n(total))],
                ),
            };
            let lines: Vec<String> = results
                .iter()
                .map(|result| {
                    let (icon, status) = if result.partial {
                        ("⚠️", t(Key::NotifDeliveryPartial, &[]))
                    } else {
                        (status_icon(&result.status), friendly_status(&result.status))
                    };
                    let error = match result.error.as_deref() {
                        Some(error) if !error.is_empty() && is_unlanded(&result.status) => {
                            format!(" — {}", short_error(error))
                        }
                        _ => String::new(),
                    };
                    format!("{icon} {} — {status}{error}", friendly_target(&result.target))
                })
                .collect();
            let remaining = if partial_locale.is_some() {
                remaining_schedule_text(details, &time_config)?
            } else {
                String::new()
            };
            let mut text = headline;
            if let Some(locale) = video_locale {
                text.push_str(&format!("\n{}", locale_name(locale)));
            }
            if !remaining.is_empty() {
                text.push_str(&format!("\n\n{remaining}"));
            }
            if !lines.is_empty() {
                text.push_str(&format!("\n\n{}", lines.join("\n")));
            }
            let keyboard = completion_keyboard(
                kind,
                draft_id,
                &retryable_targets,
                &failed_targets,
                partial_locale.is_some(),
            )?;
            let options = match keyboard {
                Some(keyboard) => Payload::new().reply_markup(keyboard),
                None => Payload::new(),
            };
            ctx.bot.api().send_message(actor_id, &text, options).await?;
            Ok(())
        }
        .await;
        if let Err(error) = result {
            log_undelivered(actor_id, &*error);
        }
    }
    Ok(())
}

fn completion_keyboard(
    kind: Option<PublicationRefKind>,
    draft_id: Option<i64>,
    retryable_targets: &[&CompletionTarget],
    failed_targets: &[&CompletionTarget],
    partial: bool,
) -> crate::Result<Option<InlineKeyboard>> {
    let kind = match kind {
        Some(PublicationRefKind::Post) => PublicationKind::Post,
        Some(PublicationRefKind::Video) => PublicationKind::Video,
        _ => return Ok(None),
    };
    let Some(draft_id) = draft_id else {
        return Ok(None);
    };
    let mut order: Vec<&str> = Vec::new();
    for target in retryable_targets.iter().chain(failed_targets) {
        if !order.contains(&target.target.as_str()) {
            order.push(&target.target);
        }
    }
    let unlanded: Vec<UnlandedTarget> = order
        .iter()
        .map(|target| UnlandedTarget {
            target: (*target).to_owned(),
            label: friendly_target(target),
            retryable: retryable_targets.iter().any(|known| known.target == *target),
            // Skipping is a post operation; a video target is given up on by
            // cancelling the video, which the video card already offers.
            skippable: kind == PublicationKind::Post,
            fix: None,
        })
        .collect();
    let (mut keyboard, decisions) =
        append_unlanded_controls(InlineKeyboard::new(), kind, draft_id, Origin::Notice, &unlanded)?;
    // The one safe tap for a publication nobody has confirmed: ask the provider.
    let mut askable = false;
    for result in failed_targets {
        if kind == PublicationKind::Video
            && result.status == "verification_required"
            && result.provider.as_deref() == Some("zernio")
        {
            keyboard = keyboard
                .text(
                    t(Key::VpreviewSettle, &[("target", &friendly_target(&result.target))]),
                    publication_callback(PublicationKind::Video, "settle", &[&draft_id, &result.target], None)?,
                )
                .row();
            askable = true;
        }
    }
    // A partially scheduled post is worth opening even when nothing failed:
    // the rest of it still needs a time.
    if !decisions && !askable && !(kind == PublicationKind::Post && partial) {
        return Ok(None);
    }
    Ok(Some(keyboard.text(
        t(Key::NotifOpen, &[]),
        publication_callback(kind, "view", &[&draft_id, &"overview"], None)?,
    )))
}

struct VideoTargetOutcome {
    target: String,
    status: String,
    last_error: Option<String>,
}

fn video_target_outcome(ctx: &Ctx, video_target_id: i64) -> crate::Result<Option<VideoTargetOutcome>> {
    Ok(ctx
        .db()
        .query_row(
            r#"select "target", "status", "last_error" from "video_targets" where "video_targets"."id" = ?"#,
            params![video_target_id],
            |row| {
                Ok(VideoTargetOutcome {
                    target: row.get(0)?,
                    status: row.get(1)?,
                    last_error: row.get(2)?,
                })
            },
        )
        .optional()?)
}

/// The notice about one video target, to every administrator who has
/// completions on.
async fn send_video_target_notice(
    ctx: &Ctx,
    title: &str,
    text: impl Fn(&str) -> String,
    keyboard: &InlineKeyboard,
) -> crate::Result<()> {
    for &actor_id in &ctx.config.controller_admin_ids {
        let result: crate::Result<()> = async {
            // A dead target is the outcome of a publication, so the completion
            // switch silences it like any other outcome.
            if !ctx.services().settings.notifications(actor_id)?.completion_enabled {
                return Ok(());
            }
            ctx.bot
                .api()
                .send_message(actor_id, &text(title), Payload::new().reply_markup(keyboard.clone()))
                .await?;
            Ok(())
        }
        .await;
        if let Err(error) = result {
            log_undelivered(actor_id, &*error);
        }
    }
    Ok(())
}

fn video_title(label: &str) -> String {
    if label.is_empty() {
        t(Key::CommonUntitled, &[])
    } else {
        label.to_owned()
    }
}

fn target_error(target: &VideoTargetOutcome) -> String {
    match target.last_error.as_deref() {
        Some(error) if !error.is_empty() => error.to_owned(),
        _ => t(Key::NotifUnknownError, &[]),
    }
}

/// `notifyFinalVideoFailure`: a target that will not be retried on its own.
pub async fn notify_final_video_failure(ctx: &Ctx, video_draft_id: i64, video_target_id: Option<i64>) -> crate::Result<()> {
    let Some(video_target_id) = video_target_id.filter(|id| *id != 0) else {
        return Ok(());
    };
    let Some(target) = video_target_outcome(ctx, video_target_id)?.filter(|target| target.status == "failed") else {
        return Ok(());
    };
    let draft = ctx.studio().publishing.get_video_draft(video_draft_id)?;
    let label = friendly_target(&target.target);
    let platform = if target.target == "youtube_shorts" {
        "YouTube"
    } else {
        "Instagram"
    };
    let keyboard = InlineKeyboard::new().text(
        t(Key::NotifRetry, &[("platform", &platform)]),
        publication_callback(
            PublicationKind::Video,
            "retry",
            &[&draft.id, &target.target, &"notice"],
            None,
        )?,
    );
    let error = target_error(&target);
    send_video_target_notice(
        ctx,
        &video_title(&draft.label),
        |title| {
            format!(
                "{}\n\n{error}",
                t(Key::NotifVideoFailed, &[("label", &label), ("title", &title)])
            )
        },
        &keyboard,
    )
    .await
}

/// `notifyUnresolvedVideoTarget`: a publication the provider will not
/// resolve, handed to the one person who can open the account and look. Not
/// the failure notice: a retry is exactly what this target must not get.
pub async fn notify_unresolved_video_target(
    ctx: &Ctx,
    video_draft_id: i64,
    video_target_id: Option<i64>,
) -> crate::Result<()> {
    let Some(video_target_id) = video_target_id.filter(|id| *id != 0) else {
        return Ok(());
    };
    let Some(target) =
        video_target_outcome(ctx, video_target_id)?.filter(|target| target.status == "verification_required")
    else {
        return Ok(());
    };
    let draft = ctx.studio().publishing.get_video_draft(video_draft_id)?;
    let label = friendly_target(&target.target);
    let keyboard = InlineKeyboard::new()
        .text(
            t(Key::VpreviewSettle, &[("target", &label)]),
            publication_callback(PublicationKind::Video, "settle", &[&draft.id, &target.target], None)?,
        )
        .row()
        .text(
            t(Key::NotifOpen, &[]),
            publication_callback(PublicationKind::Video, "view", &[&draft.id, &"overview"], None)?,
        );
    let error = target_error(&target);
    send_video_target_notice(
        ctx,
        &video_title(&draft.label),
        |title| {
            format!(
                "{}\n\n{error}",
                t(Key::NotifVideoUnresolved, &[("label", &label), ("title", &title)])
            )
        },
        &keyboard,
    )
    .await
}

/// `refreshVideoControlCard`: the video card redrawn in place, as the
/// registered video card renders it for its owner on the overview.
pub async fn refresh_video_control_card(ctx: &Ctx, video_draft_id: i64) -> crate::Result<()> {
    let Some(card) = cards::video_card(ctx.db(), video_draft_id)? else {
        return Ok(());
    };
    let draft = ctx.studio().publishing.get_video_draft(video_draft_id)?;
    let preview = render_card(
        ctx,
        PublicationKind::Video,
        &CardRequest {
            actor_id: draft.actor_id,
            publication_id: video_draft_id,
            ..CardRequest::default()
        },
    )?;
    let result = ctx
        .bot
        .api()
        .edit_message_text(
            card.chat_id,
            card.message_id,
            &preview.text,
            Payload::new().markdown().reply_markup(preview.keyboard),
        )
        .await;
    // A deleted or hand-edited message must not stop publication, but a
    // malformed card or a broken token has to be visible somewhere.
    if let Err(error) = result {
        log(
            LogLevel::Warn,
            "video control card was not refreshed",
            Some(json!({"videoDraftId": video_draft_id, "error": error_js_string(&error)})),
        );
    }
    Ok(())
}
