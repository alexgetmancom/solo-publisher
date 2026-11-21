//! A read-only projection of the delivery contract declared in platform
//! profiles: what each target does with the media it is given.

use serde_json::Value;

use super::platform_profiles::{MediaRule, platform_profile};
use crate::json::js_string;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MediaPolicyMode {
    All,
    Limited,
    First,
    StoryFirst,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MediaPolicy {
    pub target: String,
    pub input_count: usize,
    pub delivered_count: usize,
    pub mode: MediaPolicyMode,
    pub note: Option<String>,
}

pub fn media_policy_for_target(target: &str, media: &[Value]) -> MediaPolicy {
    let input_count = media.len();
    let policy = |delivered_count, mode, note: Option<String>| MediaPolicy {
        target: target.to_owned(),
        input_count,
        delivered_count,
        mode,
        note,
    };
    let first = |mode, note: &str| policy(input_count.min(1), mode, (input_count > 1).then(|| note.to_owned()));
    match selected_rule(target, media) {
        None | Some(MediaRule::All) => policy(input_count, MediaPolicyMode::All, None),
        Some(MediaRule::Limited { limit, label }) => policy(
            input_count.min(limit),
            if input_count > limit {
                MediaPolicyMode::Limited
            } else {
                MediaPolicyMode::All
            },
            (input_count > limit).then(|| format!("{label} receives at most {limit} media items.")),
        ),
        Some(MediaRule::First { note }) => first(MediaPolicyMode::First, note),
        Some(MediaRule::StoryFirst { note }) => first(MediaPolicyMode::StoryFirst, note),
    }
}

/// Applies the same target policy used by previews to the durable delivery payload.
pub fn select_media_for_target<T: Clone>(target: &str, media: &[T], as_value: impl Fn(&T) -> &Value) -> Vec<T> {
    let values: Vec<Value> = media.iter().map(|item| as_value(item).clone()).collect();
    let keep = match selected_rule(target, &values) {
        Some(MediaRule::Limited { limit, .. }) => limit,
        Some(MediaRule::First { .. } | MediaRule::StoryFirst { .. }) => 1,
        None | Some(MediaRule::All) => media.len(),
    };
    media.iter().take(keep).cloned().collect()
}

fn selected_rule(target: &str, media: &[Value]) -> Option<MediaRule> {
    let contract = platform_profile(target)?.media?;
    Some(match contract.when_video {
        Some(rule) if media.iter().any(is_video) => rule,
        _ => contract.rule,
    })
}

fn is_video(item: &Value) -> bool {
    let Value::Object(value) = item else { return false };
    let kind = match value.get("type") {
        Some(kind) if !kind.is_null() => Some(kind),
        _ => value.get("media_type").filter(|kind| !kind.is_null()),
    };
    kind.map_or(String::new(), js_string).to_lowercase() == "video"
}
