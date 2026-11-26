//! The status vocabulary of publications, delivery jobs and video targets,
//! and the folds from many statuses into one.

use foundation::time::parse_iso_ms;
use serde_json::{Map, Value};

use super::errors::{PublishErrorClass, classify_message};
use crate::targets::{TargetMap, is_site_target, target_locale};
use content::Locale;

const VIDEO_FINAL_TARGET_STATUSES: [&str; 4] = ["published", "failed", "cancelled", "verification_required"];
const POST_FINAL_JOB_STATUSES: [&str; 5] = ["published", "failed", "cancelled", "skipped", "verification_required"];
const VIDEO_EDITABLE_TARGET_STATUSES: [&str; 2] = ["editing", "draft"];
/// `failed` belongs here: nothing reached an audience, and the details are
/// what the platform refused.
const VIDEO_METADATA_EDITABLE_TARGET_STATUSES: [&str; 4] = ["editing", "draft", "scheduled", "failed"];
const VIDEO_SCHEDULABLE_TARGET_STATUSES: [&str; 3] = ["editing", "draft", "scheduled"];
const ACTIVE_PUBLICATION_JOB_STATUSES: [&str; 3] = ["queued", "publishing", "rendering"];
const POST_MUTABLE_STATUSES: [&str; 3] = ["draft", "needs_review", "scheduled"];
/// Failed provider mutations are safe to retry because the provider rejected
/// them; nothing else is.
pub const AUDIENCE_MUTATION_RETRYABLE_STATUSES: [&str; 1] = ["failed"];

pub fn is_video_target_final(status: &str) -> bool {
    VIDEO_FINAL_TARGET_STATUSES.contains(&status)
}

pub fn is_post_job_final(status: &str) -> bool {
    POST_FINAL_JOB_STATUSES.contains(&status)
}

pub fn is_video_target_editable(status: &str) -> bool {
    VIDEO_EDITABLE_TARGET_STATUSES.contains(&status)
}

/// Metadata remains mutable while a target is queued, but not once
/// preparation has started because some providers have already captured it.
pub fn is_video_target_metadata_editable(status: &str) -> bool {
    VIDEO_METADATA_EDITABLE_TARGET_STATUSES.contains(&status)
}

pub fn is_video_target_schedulable(status: &str) -> bool {
    VIDEO_SCHEDULABLE_TARGET_STATUSES.contains(&status)
}

/// Post content and target selection remain mutable until publication is
/// settled; scheduled posts are included so edits replan unfinished jobs.
pub fn is_post_draft_mutable(status: &str) -> bool {
    POST_MUTABLE_STATUSES.contains(&status)
}

/// An ambiguous mutation is held for reconciliation: retrying it can put the
/// same publication in front of the audience twice.
pub fn is_audience_mutation_retryable(status: &str) -> bool {
    AUDIENCE_MUTATION_RETRYABLE_STATUSES.contains(&status)
}

/// A delivery that did not finish while something of it is already live: a
/// chain whose first message went out, a locale that published and then failed.
pub fn is_partial_delivery(status: &str, external_id: Option<&str>) -> bool {
    status != "published" && external_id.is_some_and(|id| !id.is_empty())
}

/// A refusal about what the post contains is never retryable, whatever its
/// status. Site verification is the exception the other way: rendering the
/// same page again replaces one deterministic artifact.
pub fn is_post_target_retryable(target: &str, status: &str, error: Option<&str>) -> bool {
    if classify_message(error) == PublishErrorClass::Content {
        return false;
    }
    is_audience_mutation_retryable(status) || (is_site_target(target) && status == "verification_required")
}

/// Whether what went wrong is the post's own content.
pub fn is_content_refusal(error: Option<&str>) -> bool {
    classify_message(error) == PublishErrorClass::Content
}

/// An empty status list is "nothing has happened yet", never success.
pub fn video_draft_status<S: AsRef<str>>(target_statuses: &[S]) -> &'static str {
    if target_statuses.is_empty()
        || !target_statuses
            .iter()
            .all(|status| is_video_target_final(status.as_ref()))
    {
        return "scheduled";
    }
    if target_statuses.iter().all(|status| status.as_ref() == "published") {
        "published"
    } else {
        "partial"
    }
}

pub fn publication_status<S: AsRef<str>>(job_statuses: &[S]) -> Option<&'static str> {
    if job_statuses.is_empty()
        || job_statuses
            .iter()
            .any(|status| ACTIVE_PUBLICATION_JOB_STATUSES.contains(&status.as_ref()))
    {
        return None;
    }
    if job_statuses
        .iter()
        .any(|status| matches!(status.as_ref(), "failed" | "verification_required"))
    {
        return Some("failed");
    }
    // Nothing reached an audience and nothing is left to try.
    Some(if job_statuses.iter().all(|status| status.as_ref() == "cancelled") {
        "cancelled"
    } else {
        "published"
    })
}

/// The publication plan as `publicationPlanFromDb` returns it.
pub type PlanRecord = Map<String, Value>;

/// A publication whose plan still has an enabled, connected, not yet queued
/// target in a locale with no date is not finished, however its jobs settled.
pub fn effective_publication_status(
    jobs: &[(String, String)],
    plan: Option<&PlanRecord>,
    registered_targets: &[String],
) -> Option<&'static str> {
    let statuses: Vec<&str> = jobs.iter().map(|(_, status)| status.as_str()).collect();
    let status = publication_status(&statuses)?;
    let queued: Vec<&str> = jobs.iter().map(|(target, _)| target.as_str()).collect();
    Some(
        if status == "published" && has_pending_locale_schedule(plan, registered_targets, &queued) {
            "scheduled"
        } else {
            status
        },
    )
}

fn has_pending_locale_schedule(plan: Option<&PlanRecord>, registered: &[String], queued: &[&str]) -> bool {
    let Some(plan) = plan.filter(|plan| plan.get("mode").and_then(Value::as_str) == Some("scheduled")) else {
        return false;
    };
    let targets: TargetMap = crate::json::object_entries(&plan_object(plan.get("targets")))
        .map(|(target, enabled)| {
            (
                target.clone(),
                foundation::js::truthy(enabled)
                    && registered.iter().any(|known| known == target)
                    && !queued.contains(&target.as_str()),
            )
        })
        .collect();
    has_unscheduled_locale(
        &targets,
        plan_schedule_at(plan, Locale::Ru),
        plan_schedule_at(plan, Locale::En),
    )
}

/// An enabled target in a language the operator has not dated yet.
/// `targets` is expected to be registry-filtered already.
pub fn has_unscheduled_locale(targets: &TargetMap, ru_at: Option<&str>, en_at: Option<&str>) -> bool {
    let enabled = |locale| targets.enabled().any(|target| target_locale(target) == Some(locale));
    (enabled(Locale::Ru) && ru_at.is_none_or(str::is_empty)) || (enabled(Locale::En) && en_at.is_none_or(str::is_empty))
}

pub fn plan_schedule_at(plan: &PlanRecord, locale: Locale) -> Option<&str> {
    plan.get(match locale {
        Locale::En => "scheduled_en_at",
        Locale::Ru => "scheduled_at",
    })
    .and_then(Value::as_str)
}

pub fn plan_object(value: Option<&Value>) -> Map<String, Value> {
    match value {
        Some(Value::Object(object)) => object.clone(),
        _ => Map::new(),
    }
}

/// Whether the remaining locale goes out after the completed one.
pub(crate) fn is_deferred_locale(plan: &PlanRecord, completed: Locale, remaining: Locale) -> bool {
    let (Some(completed_at), Some(remaining_at)) = (
        plan_schedule_at(plan, completed).filter(|at| !at.is_empty()),
        plan_schedule_at(plan, remaining).filter(|at| !at.is_empty()),
    ) else {
        return true;
    };
    match (parse_iso_ms(completed_at), parse_iso_ms(remaining_at)) {
        (Some(completed), Some(remaining)) => remaining > completed,
        _ => false,
    }
}
