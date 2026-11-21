//! The read-only reports: `status.ts`, `recent.ts`, `post-text.ts`,
//! `timeline.ts`, `journal.ts`, `video-library.ts`, `verify.ts`,
//! `read-model.ts`, `pipeline-presenter.ts`, `settings-report.ts`,
//! `format-support.ts` (summary), the Studio profile and channel reports, and
//! the usage report.

use serde_json::Value;

use super::not_ported;

not_ported!(
    settings,
    studio_profile,
    studio_profile_set,
    status,
    events,
    video_library,
    recent,
    post_text,
    find,
    verify,
    timeline,
    channels,
    format_support,
    usage,
);

pub fn format_recent(result: &Value) -> String {
    serde_json::to_string_pretty(result).unwrap_or_default()
}

pub fn format_post_text(result: &Value) -> String {
    serde_json::to_string_pretty(result).unwrap_or_default()
}

pub fn format_find(result: &Value) -> String {
    serde_json::to_string_pretty(result).unwrap_or_default()
}
