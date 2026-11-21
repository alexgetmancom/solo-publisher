//! What Delivery owns that the Studio reaches without the delivery workers:
//! the video completion notice (`delivery/video-worker.ts`,
//! `recordVideoCompletionIfFinal`). The publish and video workers themselves
//! are not here.

use db::rusqlite::Connection;
use foundation::time::parse_iso_instant;
use serde_json::{Value, json};

use crate::Result;
use crate::application::ports::{Clock, DomainEventInput, Severity};
use crate::application::publication_ref::{PublicationRefKind, publication_ref};
use crate::publishing::boundaries::VideoCompletion;
use crate::publishing::state::is_video_target_final;
use crate::repositories::record_event;

/// How long the provider gets to confirm before the operator hears about it
/// (`PROVIDER_CONFIRMATION_GRACE_MS`).
pub const PROVIDER_CONFIRMATION_GRACE_MS: i64 = 15 * 60 * 1000;

/// Journals `delivery.video.completed` once every target of a video is
/// final and none still waits for the provider's answer, at most once an hour.
#[derive(Clone, Copy)]
pub struct VideoCompletionNotice<C> {
    clock: C,
}

impl<C: Clock> VideoCompletionNotice<C> {
    pub fn new(clock: C) -> Self {
        Self { clock }
    }
}

impl<C: Clock> VideoCompletion for VideoCompletionNotice<C> {
    fn record_if_final(&self, sqlite: &Connection, video_draft_id: i64) -> Result<()> {
        let targets: Vec<(String, Option<String>, String)> = sqlite
            .prepare(
                r#"select "status", "provider_post_id", "updated_at" from "video_targets" where "video_targets"."video_draft_id" = ?"#,
            )?
            .query_map([video_draft_id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?
            .collect::<db::rusqlite::Result<_>>()?;
        if targets.is_empty() || !targets.iter().all(|(status, ..)| is_video_target_final(status)) {
            return Ok(());
        }
        // A target the provider still owes an answer for is in flight; bounded,
        // because a provider that never answers must not turn into silence.
        let now = self.clock.now().as_millisecond();
        let awaiting_provider = targets.iter().any(|(status, provider_post_id, updated_at)| {
            status == "verification_required"
                && provider_post_id.as_deref().is_some_and(|id| !id.is_empty())
                // `now - new Date(updatedAt)`: an unreadable instant is NaN, and NaN < grace is false.
                && parse_iso_instant(updated_at)
                    .is_ok_and(|updated| now - updated.as_millisecond() < PROVIDER_CONFIRMATION_GRACE_MS)
        });
        if awaiting_provider {
            return Ok(());
        }
        let count = |wanted: &str| targets.iter().filter(|(status, ..)| status == wanted).count();
        let (failed, awaiting, published) = (count("failed"), count("verification_required"), count("published"));
        let message = if failed > 0 {
            format!("Video #{video_draft_id} completed with {failed} failed target(s)")
        } else if awaiting > 0 {
            format!("Video #{video_draft_id} completed with {awaiting} unconfirmed target(s)")
        } else {
            format!("Video #{video_draft_id} published successfully")
        };
        let Value::Object(details) = json!({
            "videoDraftId": video_draft_id,
            "total": targets.len(),
            "failed": failed,
            "awaiting": awaiting,
            "published": published,
        }) else {
            unreachable!("built as an object")
        };
        record_event(
            sqlite,
            &self.clock,
            &DomainEventInput {
                publication_ref: Some(publication_ref(PublicationRefKind::Video, video_draft_id)),
                event_type: "delivery.video.completed".into(),
                severity: if failed > 0 || awaiting > 0 {
                    Severity::Warn
                } else {
                    Severity::Info
                },
                target: None,
                message,
                details: Some(details),
                cooldown_seconds: Some(60 * 60),
            },
        )?;
        Ok(())
    }
}
