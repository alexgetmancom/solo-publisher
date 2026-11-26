//! The transport-free progress read model shared by Telegram cards and
//! other clients.

use content::Locale;
use serde::Serialize;

use crate::channels::effective_post_targets;
use crate::studio::Studio;
use crate::targets::{TARGETS, TargetMap, is_site_target};
use crate::{Error, Result};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PostProgressStatus {
    Published,
    Publishing,
    Failed,
    VerificationRequired,
    Waiting,
    Cancelled,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct PostProgressTarget {
    pub target: String,
    pub label: String,
    #[serde(with = "crate::json::locale")]
    pub locale: Locale,
    pub status: PostProgressStatus,
    pub error: Option<String>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
pub struct PostProgressCounts {
    pub published: u32,
    pub publishing: u32,
    pub failed: u32,
    pub verification_required: u32,
    pub waiting: u32,
    pub cancelled: u32,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PostProgressState {
    pub draft_id: i64,
    pub actor_id: i64,
    pub targets: Vec<PostProgressTarget>,
    pub counts: PostProgressCounts,
}

pub fn post_progress_state(studio: &Studio<'_>, draft_id: i64) -> Result<PostProgressState> {
    let progress = studio
        .ports()
        .studio_posts()
        .progress(draft_id)?
        .ok_or_else(|| Error::message(format!("draft {draft_id} not found")))?;
    let mut statuses: Vec<(String, (PostProgressStatus, Option<String>))> = Vec::new();
    let mut set = |target: &str, status| match statuses.iter_mut().find(|(key, _)| key == target) {
        Some(entry) => entry.1 = status,
        None => statuses.push((target.to_owned(), status)),
    };
    for job in &progress.publish_jobs {
        set(&job.target, normalize(&job.status, job.last_error.as_deref()));
    }
    for job in &progress.site_jobs {
        if is_site_target(&job.reason) {
            set(&job.reason, normalize(&job.status, job.last_error.as_deref()));
        }
    }
    let targets = effective_post_targets(studio.sqlite(), &TargetMap::parse(Some(&progress.draft.targets_json)))?;
    let mut counts = PostProgressCounts::default();
    let items: Vec<PostProgressTarget> = TARGETS
        .iter()
        .filter(|definition| targets.get(definition.id))
        .map(|definition| {
            let (status, error) = statuses
                .iter()
                .find(|(key, _)| key == definition.id)
                .map_or((PostProgressStatus::Waiting, None), |(_, current)| current.clone());
            *match status {
                PostProgressStatus::Published => &mut counts.published,
                PostProgressStatus::Publishing => &mut counts.publishing,
                PostProgressStatus::Failed => &mut counts.failed,
                PostProgressStatus::VerificationRequired => &mut counts.verification_required,
                PostProgressStatus::Waiting => &mut counts.waiting,
                PostProgressStatus::Cancelled => &mut counts.cancelled,
            } += 1;
            PostProgressTarget {
                target: definition.id.to_owned(),
                label: definition.label.to_owned(),
                locale: definition.locale,
                status,
                error,
            }
        })
        .collect();
    Ok(PostProgressState {
        draft_id,
        actor_id: progress.draft.actor_id,
        targets: items,
        counts,
    })
}

fn normalize(status: &str, error: Option<&str>) -> (PostProgressStatus, Option<String>) {
    let error = error.map(str::to_owned);
    match status {
        "published" | "skipped" => (PostProgressStatus::Published, None),
        "publishing" => (PostProgressStatus::Publishing, None),
        "failed" => (PostProgressStatus::Failed, error),
        "verification_required" => (PostProgressStatus::VerificationRequired, error),
        "cancelled" => (PostProgressStatus::Cancelled, None),
        _ => (PostProgressStatus::Waiting, None),
    }
}
