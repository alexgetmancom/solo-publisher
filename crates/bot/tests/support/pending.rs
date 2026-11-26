//! The one place that says which areas are not implemented yet.
//!
//! A golden case replays only when its own area and every area it reaches are
//! registered; anything else is reported as "not ported", by name, on every run.
//! When an area lands, delete its line from `PENDING_AREAS` (the consistency
//! test refuses a pending area that is in fact fully registered, and a
//! registered area that still misses a registration).

/// Areas of the bot (`crates/bot/src/screens/<area>.rs`) not implemented yet.
pub const PENDING_AREAS: &[&str] = &[];

/// Areas a case reaches beyond its own directory (callbacks/ and entry/ belong
/// to the core), derived from the updates each case feeds: the screens its
/// buttons route to, the text triggers and the messages it sends.
pub const CASE_NEEDS: &[(&str, &[&str])] = &[
    ("callbacks/callback-action-lock", &["intake", "post"]),
    ("callbacks/callback-duplicate", &["queue"]),
    ("callbacks/callback-menu-legacy", &["settings"]),
    ("callbacks/callback-publication-stale", &["intake", "post", "video"]),
    ("callbacks/callback-stale-card", &["intake", "post"]),
    ("callbacks/callback-superseded", &["queue"]),
    ("callbacks/callback-unknown", &["intake", "post", "queue"]),
    ("intake/intake-kind-post", &["post"]),
    ("intake/intake-markdown-rather-post", &["post"]),
    ("intake/intake-photo-large", &["post"]),
    ("intake/intake-text-entry-video", &["post"]),
    ("intake/post-album-edit", &["post"]),
    ("intake/post-album-give-up", &["post"]),
    ("intake/post-album-thread-part", &["post"]),
    ("intake/post-album", &["post"]),
    ("intake/post-need-new-post", &["post"]),
    ("notices/notice-post-completed", &["intake", "post"]),
    ("notices/notice-post-failed", &["intake", "post"]),
    ("notices/notice-post-locale-partial", &["intake", "post"]),
    ("notices/notice-post-reminder", &["intake", "post"]),
    ("notices/notice-translation-repaint", &["intake", "post"]),
    ("notices/notice-video-completed", &["intake", "post", "video"]),
    ("notices/notice-video-failed", &["intake", "post", "video"]),
    ("notices/notice-video-reminder", &["intake", "post", "video"]),
    ("notices/notice-video-unresolved", &["intake", "post", "video"]),
    ("notices/video-settle-accepted", &["intake", "post", "video"]),
    ("post/post-cancel-scheduled", &["intake"]),
    ("post/post-card-overview-ru-only", &["intake"]),
    ("post/post-card-overview", &["intake"]),
    ("post/post-confirm-publish", &["intake"]),
    ("post/post-cycle-mode", &["intake"]),
    ("post/post-delete", &["intake", "queue"]),
    ("post/post-edit-cancel", &["intake"]),
    ("post/post-edit-ru", &["intake"]),
    ("post/post-platforms", &["intake"]),
    ("post/post-preflight-thread-offer", &["intake"]),
    ("post/post-preflight-toast", &["intake"]),
    ("post/post-previews-with-media", &["intake"]),
    ("post/post-progress-cancel", &["intake"]),
    ("post/post-resend", &["intake"]),
    ("post/post-schedule-both-slots", &["intake"]),
    ("post/post-schedule-chooser-ru-only", &["intake"]),
    ("post/post-schedule-chooser", &["intake"]),
    ("post/post-schedule-manual-errors", &["intake"]),
    ("post/post-schedule-manual", &["intake"]),
    ("post/post-schedule-ru-now", &["intake"]),
    ("post/post-settled-overview", &["intake", "queue"]),
    ("post/post-settled-retry-all", &["intake"]),
    ("post/post-settled-skip-all", &["intake"]),
    ("post/post-slot-grids", &["intake"]),
    ("post/post-thread", &["intake"]),
    ("post/story-cards-timeout", &["intake"]),
    ("post/story-cards-wait", &["intake"]),
    ("post/story-choice-publish", &["intake"]),
    ("post/story-choice-schedule", &["intake"]),
    ("queue/queue-pages", &["post", "video"]),
    ("settings/settings-youtube-signature", &["intake", "post"]),
    ("video/video-card-actions", &["intake", "post"]),
    ("video/video-card-draft-actions", &["intake", "post"]),
    ("video/video-download-cancel", &["intake", "post"]),
    ("video/video-download-failed", &["intake", "post"]),
    ("video/video-intake-destination", &["intake", "post"]),
    ("video/video-intake-rejects-text", &["intake", "post"]),
    ("video/video-intake-single-platform", &["intake", "post"]),
    ("video/video-length-ok", &["intake", "post"]),
    ("video/video-length-replace", &["intake", "post"]),
    ("video/video-music-aspect-warnings", &["intake", "post"]),
    ("video/video-publish-now", &["intake", "post"]),
    ("video/video-remove-all", &["intake", "post"]),
    ("video/video-wizard-cancel-before-draft", &["intake", "post"]),
    ("video/video-wizard-common", &["intake", "post"]),
    ("video/video-wizard-individual", &["intake", "post"]),
    ("video/video-wizard-skip-back", &["intake", "post"]),
];

/// The pending areas a case waits for, its own directory included.
pub fn pending_for(area: &str, case: &str) -> Vec<&'static str> {
    let key = format!("{area}/{case}");
    let needs = CASE_NEEDS
        .iter()
        .find(|(name, _)| *name == key)
        .map_or(&[][..], |(_, needs)| *needs);
    PENDING_AREAS
        .iter()
        .copied()
        .filter(|pending| *pending == area || needs.contains(pending))
        .collect()
}
