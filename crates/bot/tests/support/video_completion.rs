//! The golden host's video completion notice (`delivery/video-worker.ts`,
//! `recordVideoCompletionIfFinal`): once every target of a video is final and
//! none still waits for the provider's answer, `delivery.video.completed` is
//! journalled, at most once an hour.

use db::rusqlite::Connection;
use domain::application::ports::{Clock, DomainEventInput, Severity};
use domain::application::publication_ref::{PublicationRefKind, publication_ref};
use domain::publishing::boundaries::VideoCompletion;
use domain::publishing::state::is_video_target_final;
use domain::repositories::record_event;
use foundation::time::parse_iso_instant;
use serde_json::{Map, json};

use super::host::GoldenHost;

/// How long the provider gets to confirm before the operator hears about it.
const PROVIDER_CONFIRMATION_GRACE_MS: i64 = 15 * 60 * 1000;

impl VideoCompletion for GoldenHost {
    fn record_if_final(&self, sqlite: &Connection, video_draft_id: i64) -> domain::Result<()> {
        let targets: Vec<(String, Option<String>, String)> = sqlite
            .prepare(
                r#"select "status", "provider_post_id", "updated_at" from "video_targets" where "video_targets"."video_draft_id" = ?"#,
            )?
            .query_map([video_draft_id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?
            .collect::<Result<_, _>>()?;
        if targets.is_empty() || !targets.iter().all(|(status, ..)| is_video_target_final(status)) {
            return Ok(());
        }
        let now = self.clock.now().as_millisecond();
        let awaiting_provider = targets.iter().any(|(status, provider_post_id, updated_at)| {
            status == "verification_required"
                && provider_post_id.as_deref().is_some_and(|id| !id.is_empty())
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
        let details: Map<_, _> = json!({
            "videoDraftId": video_draft_id,
            "total": targets.len(),
            "failed": failed,
            "awaiting": awaiting,
            "published": published,
        })
        .as_object()
        .cloned()
        .unwrap_or_default();
        record_event(
            sqlite,
            &*self.clock,
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
