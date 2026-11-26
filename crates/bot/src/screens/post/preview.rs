//! The post card (`bot/preview.ts`, the post half of
//! `bot/publication-renderers.ts`): one draft, rendered as the
//! screen it is on.

use content::Locale;
use content::draft_content::{DraftContentSource, draft_locale_content};
use domain::application::conversation_flow::PublicationKind;
use domain::application::ports::DraftRecord;
use domain::channels::{effective_post_targets, post_locales, registered_post_target_ids};
use domain::publishing::media_policy::{MediaPolicyMode, media_policy_for_target};
use domain::publishing::state::{is_content_refusal, is_post_draft_mutable, is_post_target_retryable};
use domain::studio::services::post_access::require_post_edit_allowed;
use domain::studio::services::post_progress::{PostProgressStatus, post_progress_state};
use domain::studio::services::posts::ThreadDeliveryPlan;
use domain::targets::{TARGETS, TargetMap, preset_name, target_locale};
use foundation::i18n::{Key, t};
use foundation::logger::{LogLevel, log};
use foundation::markdown::escape_markdown;
use foundation::text::truncate_unicode;
use foundation::time::{Zone, format_zoned_date_time, parse_iso_instant};
use serde_json::{Value, json};

use crate::api::payload::InlineKeyboard;
use crate::callback::{ScreenId, publication_callback, screen};
use crate::context::Ctx;
use crate::dialog_ui::{DialogButton, append_result_navigation, confirmation_keyboard};
use crate::publication::scheduling::{ScheduleAxis, ScheduleButton, ScheduleEngine, schedule_time_keyboard};
use crate::publication::unlanded::{Origin, UnlandedTarget, append_unlanded_controls};
use crate::publication::{CardRequest, PublicationCard};

/// Every screen a post card can show.
pub const DRAFT_VIEWS: [&str; 13] = [
    "overview",
    "schedule",
    "schedule_ru",
    "schedule_ru_day",
    "schedule_ru_evening",
    "schedule_en",
    "schedule_en_us",
    "confirm_publish",
    "confirm_delete",
    "confirm_cancel",
    "platforms",
    "resend",
    "thread",
];

/// Both draft texts share one Telegram message with the header, media line
/// and card status, so each gets a quarter of the 4096-character budget.
const PREVIEW_TEXT_LIMIT: usize = 1000;

pub fn is_draft_view(value: &str) -> bool {
    DRAFT_VIEWS.contains(&value)
}

/// RU and EN slot pickers differ only in their grids, title and the extra
/// sub-views reachable from the main one, so they are data rendered once.
struct ScheduleGrid {
    target: &'static str,
    main_view: &'static str,
    title: Key,
    slots: &'static [(&'static str, &'static [&'static str])],
    extra_views: &'static [(Key, &'static str)],
}

const SCHEDULE_GRIDS: [ScheduleGrid; 2] = [
    ScheduleGrid {
        target: "ru",
        main_view: "schedule_ru",
        title: Key::PostScheduleRuTitle,
        slots: &[
            ("schedule_ru", &["08:00", "09:00", "10:00", "11:00"]),
            (
                "schedule_ru_day",
                &["12:00", "13:00", "14:00", "15:00", "16:00", "17:00"],
            ),
            ("schedule_ru_evening", &["18:00", "19:00", "20:00", "21:00", "22:00"]),
        ],
        extra_views: &[
            (Key::PostRuDay, "schedule_ru_day"),
            (Key::PostRuEvening, "schedule_ru_evening"),
        ],
    },
    ScheduleGrid {
        target: "en",
        main_view: "schedule_en",
        title: Key::PostScheduleEnTitle,
        slots: &[
            ("schedule_en", &["18:00", "19:00", "20:00", "21:00", "22:00", "23:00"]),
            ("schedule_en_us", &["00:00", "01:00", "02:00", "03:00", "04:00"]),
        ],
        extra_views: &[(Key::PostEnUsNight, "schedule_en_us")],
    },
];

fn callback(action: &str, args: &[&dyn std::fmt::Display]) -> crate::Result<String> {
    Ok(publication_callback(PublicationKind::Post, action, args, None)?)
}

fn view_callback(draft_id: i64, view: &str) -> crate::Result<String> {
    callback("view", &[&draft_id, &view])
}

/// The post renderer (`publicationRenderers.post.card`): an unknown view reads
/// as the overview.
pub fn render_card(ctx: &Ctx, request: &CardRequest) -> crate::Result<PublicationCard> {
    let view = request.view.as_deref().filter(|view| is_draft_view(view));
    let (text, keyboard) = draft_preview(ctx, request.publication_id, view.unwrap_or("overview"))?;
    Ok(PublicationCard {
        kind: PublicationKind::Post,
        draft_id: request.publication_id,
        text,
        keyboard,
        view: view.map(str::to_owned),
    })
}

/// `postPreviewCard`: the card as every Telegram path renders it.
pub fn post_preview_card(ctx: &Ctx, actor_id: i64, draft_id: i64, view: Option<&str>) -> crate::Result<PublicationCard> {
    render_card(
        ctx,
        &CardRequest {
            actor_id,
            publication_id: draft_id,
            view: view.map(str::to_owned),
            ..CardRequest::default()
        },
    )
}

fn content_source(draft: &DraftRecord) -> DraftContentSource<'_> {
    DraftContentSource {
        text_ru: Some(&draft.text_ru),
        text_en_approved: draft.text_en_approved.as_deref(),
        text_en_machine: draft.text_en_machine.as_deref(),
        text_ru_entities_json: draft.text_ru_entities_json.as_deref(),
        text_en_entities_json: draft.text_en_entities_json.as_deref(),
        media_ru_json: draft.media_ru_json.as_deref(),
        media_en_json: draft.media_en_json.as_deref(),
    }
}

/// `value || fallback` for a stored text.
fn or_text(value: &str, fallback: Key) -> String {
    if value.is_empty() {
        t(fallback, &[])
    } else {
        value.to_owned()
    }
}

/// `escapeMarkdown(truncateUnicode(value, limit))`.
fn clipped(value: &str, limit: usize) -> String {
    escape_markdown(truncate_unicode(value, limit))
}

/// `draftPreview`.
pub fn draft_preview(ctx: &Ctx, draft_id: i64, view: &str) -> crate::Result<(String, InlineKeyboard)> {
    let db = ctx.db();
    let draft = ctx
        .ports()
        .drafts()
        .get(draft_id)?
        .ok_or_else(|| crate::error(format!("draft {draft_id} not found")))?;
    let services = ctx.services();
    let time_config = services.settings.time_config(draft.actor_id)?;
    let zone = Zone::parse(&time_config.timezone)
        .ok_or_else(|| crate::error(format!("Invalid time zone specified: {}", time_config.timezone)))?;
    // Only a thread has more than one post to account for.
    let thread_plan = if draft.thread.is_empty() {
        Vec::new()
    } else {
        services.posts.delivery_plan(draft.actor_id, draft_id)?
    };
    let targets = effective_post_targets(db, &TargetMap::parse(Some(&draft.targets_json)))?;
    let registered = registered_post_target_ids(db)?;
    let target_rows: Vec<_> = TARGETS
        .iter()
        .filter(|target| registered.iter().any(|id| id == target.id))
        .collect();
    // A language this Studio has connected nothing for has no screens.
    let serves_en = post_locales(db)?.contains(&Locale::En);
    let mut keyboard = InlineKeyboard::new();
    let mode = preset_name(&targets);
    let mutable = is_post_draft_mutable(&draft.status);

    // A frozen draft only ever shows the overview -- and "resend", the one
    // thing a settled publication can still be asked for.
    if !mutable && view != "overview" && view != "resend" {
        return draft_preview(ctx, draft_id, "overview");
    }
    if !serves_en && view.starts_with("schedule_en") {
        return draft_preview(ctx, draft_id, "overview");
    }
    let header = draft_header(draft_id, &targets);

    if view == "resend" {
        let candidates = if mutable {
            Vec::new()
        } else {
            services.posts.resendable_targets(draft.actor_id, draft_id)?
        };
        for pair in candidates.chunks(2) {
            for candidate in pair {
                keyboard = keyboard.text(candidate.label, callback("resend", &[&draft_id, &candidate.target])?);
            }
            keyboard = keyboard.row();
        }
        keyboard = keyboard.text(t(Key::PostBackToPreview, &[]), view_callback(draft_id, "overview")?);
        let hint = if candidates.is_empty() {
            t(Key::PostResendNone, &[])
        } else {
            t(Key::PostResendHint, &[])
        };
        return Ok((
            format!("📝 *{}*\n\n{hint}", t(Key::PostResendTitle, &[("id", &draft_id)])),
            keyboard,
        ));
    }

    if view == "thread" {
        // Both languages on one screen, post by post; the first post is the
        // draft itself.
        let parts = &draft.thread;
        for part in parts {
            let position = part.position.to_string();
            keyboard = keyboard.text(
                t(Key::PostThreadEditPart, &[("locale", &"RU"), ("part", &part.position)]),
                callback("thread_edit", &[&draft_id, &position, &"ru"])?,
            );
            if serves_en {
                keyboard = keyboard.text(
                    t(Key::PostThreadEditPart, &[("locale", &"EN"), ("part", &part.position)]),
                    callback("thread_edit", &[&draft_id, &position, &"en"])?,
                );
            }
            keyboard = keyboard
                .text(
                    t(Key::PostThreadRemovePart, &[("part", &part.position)]),
                    callback("thread_remove", &[&draft_id, &position, &"ru"])?,
                )
                .row();
        }
        keyboard = keyboard
            .text(t(Key::PostThreadAdd, &[]), callback("thread_add", &[&draft_id])?)
            .row()
            .text(t(Key::PostBackToPreview, &[]), view_callback(draft_id, "overview")?);
        // Two languages share the message budget.
        let per_post = 3000 / ((parts.len() + 1) * if serves_en { 2 } else { 1 });
        let english = draft_locale_content(&content_source(&draft), Locale::En).text;
        let mut written = vec![(1, draft.text_ru.clone(), english, safe_media_count(draft.media_ru_json.as_deref()))];
        written.extend(parts.iter().map(|part| {
            let en = part
                .text_en_approved
                .clone()
                .or_else(|| part.text_en.clone())
                .unwrap_or_default();
            (part.position, part.text_ru.clone(), en, part.media.len())
        }));
        let body: Vec<String> = written
            .iter()
            .map(|(position, ru, en, media)| {
                let head = format!(
                    "*{position}.*{}",
                    if *media > 0 { format!(" 🖼 {media}") } else { String::new() }
                );
                let fallback = if *media > 0 { Key::PostMediaOnly } else { Key::PostNotTranslated };
                let ru = clipped(&or_text(ru, fallback), per_post);
                let en = if serves_en {
                    format!("\nEN: {}", clipped(&or_text(en, Key::PostNotTranslated), per_post))
                } else {
                    String::new()
                };
                format!("{head}\nRU: {ru}{en}")
            })
            .collect();
        let title = match thread_plan_line(&thread_plan) {
            line if line.is_empty() => format!(
                "🧵 *{}*",
                t(Key::PostThreadTitle, &[("id", &draft_id), ("parts", &(parts.len() + 1))])
            ),
            line => line,
        };
        return Ok((format!("{title}\n\n{}", body.join("\n\n")), keyboard));
    }

    if view == "platforms" {
        for pair in target_rows.chunks(2) {
            for target in pair {
                let mark = if targets.get(target.id) { "✓" } else { "□" };
                keyboard = keyboard.text(
                    format!("{mark} {}", target.label),
                    callback("toggle", &[&draft_id, &target.id])?,
                );
            }
            keyboard = keyboard.row();
        }
        keyboard = keyboard.text(t(Key::PostBackToPreview, &[]), view_callback(draft_id, "overview")?);
        let enabled = match enabled_target_labels(&targets, 1, 1) {
            labels if labels.is_empty() => t(Key::PostNone, &[]),
            labels => labels,
        };
        return Ok((
            format!(
                "📝 *{}*\n\n{}: *{enabled}*\n\n{}",
                t(Key::PostPlatformsTitle, &[("id", &draft_id)]),
                t(Key::PostActive, &[]),
                t(Key::PostToggleHint, &[])
            ),
            keyboard,
        ));
    }

    if view == "schedule" {
        if draft.status == "scheduled" {
            // One language means one time: the chooser would be a single
            // button in front of the grid it opens.
            if !serves_en {
                return draft_preview(ctx, draft_id, "schedule_ru");
            }
            keyboard = keyboard
                .text(t(Key::PostChangeTimeRu, &[]), view_callback(draft_id, "schedule_ru")?)
                .row()
                .text(t(Key::PostChangeTimeEn, &[]), view_callback(draft_id, "schedule_en")?)
                .row()
                .text(t(Key::CommonBack, &[]), view_callback(draft_id, "overview")?);
            return Ok((
                format!(
                    "{header}\n\n📅 *{}*\n{}",
                    t(Key::PostChangeTimeTitle, &[]),
                    t(Key::PostChangeTimeHint, &[])
                ),
                keyboard,
            ));
        }
        // Without EN there is nothing to stagger against.
        keyboard = if serves_en {
            keyboard
                .text(t(Key::PostScopeRuNow, &[]), callback("sched_scope", &[&draft_id, &"ru_now"])?)
                .row()
                .text(t(Key::PostScopeEnNow, &[]), callback("sched_scope", &[&draft_id, &"en_now"])?)
                .row()
                .text(t(Key::PostScopeBoth, &[]), callback("sched_scope", &[&draft_id, &"both"])?)
                .row()
        } else {
            keyboard
                .text(
                    t(Key::PostScopeRuOnlyNow, &[]),
                    callback("sched_scope", &[&draft_id, &"ru_now"])?,
                )
                .row()
                .text(t(Key::PostScopeRuOnlyLater, &[]), view_callback(draft_id, "schedule_ru")?)
                .row()
        };
        keyboard = keyboard.text(t(Key::CommonBack, &[]), view_callback(draft_id, "overview")?);
        let hint = if serves_en { Key::PostScheduleHint } else { Key::PostScheduleHintRuOnly };
        return Ok((
            format!(
                "{header}\n\n📅 *{}*\n{}",
                t(Key::PostScheduleTitle, &[]),
                t(hint, &[])
            ),
            keyboard,
        ));
    }

    let grid = SCHEDULE_GRIDS
        .iter()
        .find_map(|grid| grid.slots.iter().find(|(name, _)| *name == view).map(|(_, slots)| (grid, *slots)));
    if let Some((grid, slots)) = grid {
        let engine = ScheduleEngine {
            kind: PublicationKind::Post,
            publication_id: draft_id,
            axis_keys: &[grid.target],
            slot_values: slots,
        };
        let label = |clock: &str| clock.to_owned();
        let pick = |clock: &str| engine.pick_callback(Some(grid.target), clock);
        let axis = ScheduleAxis {
            values: engine.slot_values,
            label: &label,
            callback: &pick,
        };
        let mut schedule_keyboard = schedule_time_keyboard(
            &axis,
            None,
            None,
            ScheduleButton {
                label: t(Key::PostEnterTime, &[]),
                callback: engine.manual_callback(Some(grid.target))?,
            },
            ScheduleButton {
                label: t(Key::CommonBack, &[]),
                callback: view_callback(draft_id, "overview")?,
            },
        )?;
        if view == grid.main_view {
            for (label, extra) in grid.extra_views {
                schedule_keyboard = schedule_keyboard
                    .row()
                    .text(t(*label, &[]), view_callback(draft_id, extra)?);
            }
        } else {
            schedule_keyboard = schedule_keyboard
                .row()
                .text(t(Key::CommonBack, &[]), view_callback(draft_id, grid.main_view)?);
        }
        return Ok((
            format!(
                "{header}\n\n📅 *{}*\n{}",
                t(grid.title, &[]),
                t(Key::PostPickSlotHint, &[])
            ),
            schedule_keyboard,
        ));
    }

    if view == "confirm_publish" {
        let media = media_counts(&draft);
        let available = match enabled_target_labels(&targets, media.ru, media.en_effective) {
            labels if labels.is_empty() => t(Key::PostNoPlatforms, &[]),
            labels => labels,
        };
        let unavailable = unavailable_target_labels(&targets, media.ru, media.en_effective);
        let skipped = if unavailable.is_empty() {
            String::new()
        } else {
            format!("\n⚠️ {}", t(Key::PostWillSkipNoMedia, &[("targets", &unavailable)]))
        };
        let keyboard = InlineKeyboard::new()
            .text(t(Key::PostPublishNowBtn, &[]), callback("publish_confirm", &[&draft_id])?)
            .row()
            .text(t(Key::CommonBack, &[]), view_callback(draft_id, "overview")?);
        return Ok((
            format!(
                "{header}\n\n⚠️ *{}*\n{}: {available}.{skipped}",
                t(Key::PostPublishNowQ, &[]),
                t(Key::PostWillSendTo, &[])
            ),
            keyboard,
        ));
    }

    if view == "confirm_delete" || view == "confirm_cancel" {
        let (question, warning, button) = if view == "confirm_delete" {
            (Key::PostDeleteQ, Key::PostDeleteWarn, Key::PostDeleteBtn)
        } else {
            (
                Key::PostCancelPublicationQ,
                Key::PostCancelPublicationWarn,
                Key::PostCancelPublicationBtn,
            )
        };
        let (label, back) = (t(button, &[]), t(Key::CommonBack, &[]));
        let (confirm, overview) = (callback("cancel_confirm", &[&draft_id])?, view_callback(draft_id, "overview")?);
        return Ok((
            format!("{header}\n\n⚠️ *{}*\n{}", t(question, &[]), t(warning, &[])),
            confirmation_keyboard(
                DialogButton {
                    label: &label,
                    callback: &confirm,
                },
                DialogButton {
                    label: &back,
                    callback: &overview,
                },
                None,
            ),
        ));
    }

    let scheduled = |value: &Option<String>| {
        let at = value
            .as_deref()
            .filter(|value| !value.is_empty())
            .and_then(|value| parse_iso_instant(value).ok());
        format_zoned_date_time(at, &zone, &time_config.timezone_label)
    };
    if draft.status == "scheduled" {
        keyboard = keyboard
            .text(t(Key::PostChangeTime, &[]), callback("schedule", &[&draft_id])?)
            .text(t(Key::PostChoosePlatforms, &[]), view_callback(draft_id, "platforms")?)
            .row();
        keyboard = append_locale_edit_buttons(ctx, keyboard, draft.actor_id, draft_id, serves_en)?;
        keyboard = keyboard
            .text(
                t(Key::PostCancelPublication, &[]),
                callback("cancel", &[&draft_id, &"confirm_cancel"])?,
            )
            .row()
            .text(t(Key::QueueBackBtn, &[]), screen(ScreenId::QueueHome));
        let en = if serves_en {
            format!("\n{}: {}", t(Key::PostScheduledEn, &[]), scheduled(&draft.scheduled_en_at))
        } else {
            String::new()
        };
        return Ok((
            format!(
                "{header}\n\n{}: {}{en}",
                t(Key::PostScheduledRu, &[]),
                scheduled(&draft.scheduled_at)
            ),
            keyboard,
        ));
    }

    let mode_emoji = if mode == "manual" { "🛞" } else { "⚙️" };
    if mutable {
        // Everything a draft needs, on the draft itself: one screen is what
        // the author actually works on.
        keyboard = keyboard
            .text(
                format!("{mode_emoji} {}: {}", t(Key::PostMode, &[]), mode_label(mode)),
                callback("cycle_mode", &[&draft_id])?,
            )
            .text(t(Key::PostChoosePlatforms, &[]), view_callback(draft_id, "platforms")?)
            .row();
        keyboard = append_locale_edit_buttons(ctx, keyboard, draft.actor_id, draft_id, serves_en)?;
        if !draft.thread.is_empty() {
            keyboard = keyboard.text(
                t(Key::PostThreadBtn, &[("parts", &(draft.thread.len() + 1))]),
                view_callback(draft_id, "thread")?,
            );
        }
        // Now, later, or never, side by side.
        keyboard = keyboard
            .text(t(Key::PostThreadAdd, &[]), callback("thread_add", &[&draft_id])?)
            .row()
            .text(t(Key::PostPublishBtn, &[]), callback("publish", &[&draft_id])?)
            .text(t(Key::PostScheduleBtn, &[]), callback("schedule", &[&draft_id])?)
            .text(
                t(Key::PostDeleteBtn, &[]),
                callback("cancel", &[&draft_id, &"confirm_delete"])?,
            );
    } else {
        let unlanded = unlanded_targets(ctx, draft_id);
        keyboard = append_unlanded_controls(keyboard, PublicationKind::Post, draft_id, Origin::Card, &unlanded)?.0;
        if !services.posts.resendable_targets(draft.actor_id, draft_id)?.is_empty() {
            keyboard = keyboard
                .text(t(Key::PostResendBtn, &[]), view_callback(draft_id, "resend")?)
                .row();
        }
        keyboard = append_result_navigation(keyboard);
    }

    let media = media_counts(&draft);
    let story_cards = ctx
        .studio()
        .publishing
        .boundaries
        .story_cards
        .for_draft(db, draft_id)?;
    let ready_status = if serves_en { "✓ RU · ✓ EN" } else { "✓ RU" };
    let story_card_status = if story_cards.is_empty() {
        String::new()
    } else if story_cards.iter().all(|card| card.status == "ready") {
        format!("\n{}", t(Key::PostStoryCardsStatus, &[("status", &ready_status)]))
    } else {
        let status: Vec<String> = story_cards
            .iter()
            .map(|card| format!("{} {}", card.locale.to_uppercase(), card.status))
            .collect();
        format!("\n{}", t(Key::PostStoryCardsStatus, &[("status", &status.join(" · "))]))
    };
    let media_line = if media.ru > 0 || media.en > 0 {
        let en = if serves_en { format!(" · {} EN", media.en_effective) } else { String::new() };
        format!("\n{}: {} RU{en}", t(Key::PostMedia, &[]), media.ru)
    } else {
        String::new()
    };
    let en_media_warning = if serves_en && media.ru > 0 && media.en == 0 {
        format!("\n⚠️ {}", t(Key::PostEnUsesRuMedia, &[]))
    } else {
        String::new()
    };
    // "Not translated" and "being translated" are different answers, and the
    // card is the only place the operator can tell them apart.
    let missing_en = if ctx.ports().draft_translations().pending(draft_id)? {
        Key::PostTranslating
    } else {
        Key::PostNotTranslated
    };
    let en_text = if serves_en {
        let english = draft
            .text_en_approved
            .as_deref()
            .filter(|text| !text.is_empty())
            .or(draft.text_en_machine.as_deref().filter(|text| !text.is_empty()))
            .map_or_else(|| t(missing_en, &[]), str::to_owned);
        format!("\n\nEN:\n{}", clipped(&english, PREVIEW_TEXT_LIMIT))
    } else {
        String::new()
    };
    Ok((
        format!(
            "{header}{}{media_line}{story_card_status}{en_media_warning}\n\nRU:\n{}{en_text}",
            thread_plan_line(&thread_plan),
            clipped(&or_text(&draft.text_ru, Key::PostMediaOnly), PREVIEW_TEXT_LIMIT)
        ),
        keyboard,
    ))
}

/// "Edit RU" and "Edit EN", for the languages this Studio publishes and this
/// publication still allows to be changed.
fn append_locale_edit_buttons(
    ctx: &Ctx,
    mut keyboard: InlineKeyboard,
    actor_id: i64,
    draft_id: i64,
    serves_en: bool,
) -> crate::Result<InlineKeyboard> {
    let can_edit = |locale| {
        require_post_edit_allowed(ctx.ports(), &ctx.config, actor_id, draft_id, ctx.now(), Some(locale)).is_ok()
    };
    let can_edit_ru = can_edit(Locale::Ru);
    let can_edit_en = serves_en && can_edit(Locale::En);
    if can_edit_ru {
        keyboard = keyboard.text(t(Key::PostEditRu, &[]), callback("edit_ru", &[&draft_id])?);
    }
    if can_edit_en {
        keyboard = keyboard.text(t(Key::PostEditEn, &[]), callback("edit_en", &[&draft_id])?);
    }
    if can_edit_ru || can_edit_en {
        keyboard = keyboard.row();
    }
    Ok(keyboard)
}

fn progress_status(status: PostProgressStatus) -> &'static str {
    match status {
        PostProgressStatus::Published => "published",
        PostProgressStatus::Publishing => "publishing",
        PostProgressStatus::Failed => "failed",
        PostProgressStatus::VerificationRequired => "verification_required",
        PostProgressStatus::Waiting => "waiting",
        PostProgressStatus::Cancelled => "cancelled",
    }
}

/// Every target that did not land, retryable or not: each one can be
/// skipped, and only some can be retried.
fn unlanded_targets(ctx: &Ctx, draft_id: i64) -> Vec<UnlandedTarget> {
    match post_progress_state(&ctx.studio(), draft_id) {
        Ok(state) => state
            .targets
            .into_iter()
            .filter(|item| {
                matches!(
                    item.status,
                    PostProgressStatus::Failed | PostProgressStatus::VerificationRequired
                )
            })
            .map(|item| UnlandedTarget {
                retryable: is_post_target_retryable(&item.target, progress_status(item.status), item.error.as_deref()),
                skippable: true,
                // A refusal about the post's own content is fixed in the post.
                fix: is_content_refusal(item.error.as_deref())
                    .then(|| target_locale(&item.target).unwrap_or(Locale::Ru)),
                target: item.target,
                label: item.label,
            })
            .collect(),
        Err(error) => {
            // A card without its retry buttons is still a card, but the reason
            // must not disappear with them.
            log(
                LogLevel::Warn,
                "post card could not read publication progress",
                Some(json!({"draftId": draft_id, "error": format!("Error: {error}")})),
            );
            Vec::new()
        }
    }
}

struct MediaCounts {
    ru: usize,
    en: usize,
    en_effective: usize,
}

/// EN falls back to RU media at publish time, so the card counts both the raw
/// EN attachments (to warn about the fallback) and the effective ones.
fn media_counts(draft: &DraftRecord) -> MediaCounts {
    let ru = safe_media_count(draft.media_ru_json.as_deref());
    let en = safe_media_count(draft.media_en_json.as_deref());
    MediaCounts {
        ru,
        en,
        en_effective: if en > 0 { en } else { ru },
    }
}

fn safe_media_count(value: Option<&str>) -> usize {
    match value.filter(|value| !value.is_empty()).map(serde_json::from_str::<Value>) {
        Some(Ok(Value::Array(media))) => media.len(),
        _ => 0,
    }
}

fn draft_header(draft_id: i64, targets: &TargetMap) -> String {
    format!(
        "📝 *{}*\n{}: *{}* · {}: *{}*",
        t(Key::PostHeading, &[("id", &draft_id)]),
        t(Key::PostMode, &[]),
        mode_label(preset_name(targets)),
        t(Key::PostPlatforms, &[]),
        targets.enabled().count()
    )
}

fn enabled_target_labels(targets: &TargetMap, media_ru: usize, media_en: usize) -> String {
    target_labels(targets, |target, locale| {
        !is_unavailable_for_media(target, locale, media_ru, media_en)
    })
}

fn unavailable_target_labels(targets: &TargetMap, media_ru: usize, media_en: usize) -> String {
    target_labels(targets, |target, locale| {
        is_unavailable_for_media(target, locale, media_ru, media_en)
    })
}

fn target_labels(targets: &TargetMap, keep: impl Fn(&str, Locale) -> bool) -> String {
    TARGETS
        .iter()
        .filter(|target| targets.get(target.id) && keep(target.id, target.locale))
        .map(|target| target.label)
        .collect::<Vec<_>>()
        .join(", ")
}

fn is_unavailable_for_media(target: &str, locale: Locale, media_ru: usize, media_en: usize) -> bool {
    let count = if locale == Locale::Ru { media_ru } else { media_en };
    let policy = media_policy_for_target(target, &vec![Value::Null; count]);
    policy.mode == MediaPolicyMode::StoryFirst && policy.input_count == 0
}

/// `modeLabel`.
pub fn mode_label(mode: &str) -> String {
    t(
        match mode {
            "full" => Key::ModeFull,
            "ru" => Key::ModeRu,
            "en" => Key::ModeEn,
            "tg" => Key::ModeTg,
            _ => Key::ModeManual,
        },
        &[],
    )
}

/// What each platform carrying a thread receives, counted the way delivery
/// cuts it.
fn thread_plan_line(plan: &[ThreadDeliveryPlan]) -> String {
    if plan.is_empty() {
        return String::new();
    }
    let parts: Vec<String> = plan
        .iter()
        .map(|entry| {
            if entry.chained {
                t(
                    Key::PostThreadPlanPosts,
                    &[("label", &entry.label), ("posts", &entry.posts)],
                )
            } else {
                t(Key::PostThreadPlanSingle, &[("label", &entry.label)])
            }
        })
        .collect();
    format!("\n🧵 {}", parts.join(" · "))
}
