//! The video publication command boundary for Telegram, MCP and the CLI.

use content::Locale;
use foundation::errors::StudioError;
use foundation::js::{string_of, truthy};
use foundation::time::Zone;
use jiff::Timestamp;
use serde::Serialize;
use serde_json::{Map, Value, json};

use crate::application::conversation_flow::PublicationKind;
use crate::application::ports::{
    DomainEventInput, JsonObject, PostEventRecord, Severity, StudioVideoDraftRecord, StudioVideoJobRecord,
    StudioVideoTargetRecord,
};
use crate::application::publication_pipeline::{
    Issue, PreviewModel, PublicationCapabilities, PublicationPipeline, PublicationRetrySummary, PublicationSchedule,
    PublicationScheduleAxis, PublicationView,
};
use crate::application::publication_ref::{PublicationRefKind, publication_ref};
use crate::publishing::boundaries::{MediaProbe, VideoProvider};
use crate::publishing::schedule::{
    immediate_schedule_time, is_immediate_schedule, parse_manual_schedule, publication_slot_time,
};
use crate::publishing::state::is_video_target_metadata_editable;
use crate::publishing::video_service::{is_video_source_replaceable, validate_video_source};
use crate::publishing::video_settle::SettleVideoInput;
use crate::publishing::video_types::{VideoTarget, VideoTechnicalCheck};
use crate::studio::Studio;
use crate::studio::boundaries::{Reminder, ReminderPolicy, YoutubeUploads};
use crate::studio::config::studio_config;
use crate::studio::projections::{VideoDeliveryProjections, video_delivery_projections};
use crate::studio::video_fsm::VideoWizardStep;
use crate::{Error, Result};

use super::settings::SettingsService;

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct VideoView {
    pub id: i64,
    pub status: String,
    pub draft: StudioVideoDraftRecord,
    pub targets: Vec<StudioVideoTargetRecord>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct VideoPreview {
    pub id: i64,
    pub status: String,
    pub issues: Vec<Issue>,
    pub draft: StudioVideoDraftRecord,
    pub targets: Vec<StudioVideoTargetRecord>,
    pub delivery: VideoDeliveryProjections,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct VideoStatus {
    pub draft: StudioVideoDraftRecord,
    pub targets: Vec<StudioVideoTargetRecord>,
    pub jobs: Vec<StudioVideoJobRecord>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoRetrySummary {
    pub requeued: u32,
    pub already_queued: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub settled: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct ManualRemoval {
    pub target: String,
    pub url: Option<String>,
}

/// What cancelling did locally, and what the operator still has to do on
/// the platforms: already-public targets are never deleted by automation.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoCancelReport {
    pub manual_removal: Vec<ManualRemoval>,
    #[serde(rename = "holdPrivateYouTubeIds")]
    pub hold_private_youtube_ids: Vec<String>,
    #[serde(rename = "heldPrivateYouTubeIds")]
    pub held_private_youtube_ids: Vec<String>,
    pub hold_failures: Vec<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct TargetRemoval {
    pub cancelled: bool,
}

fn video_ref(publication_id: i64) -> String {
    publication_ref(PublicationRefKind::Video, publication_id)
}

/// YouTube titles the draft whenever it is a destination: it is the only
/// platform with a real title field.
fn labelling_video_target(selected: &[VideoTarget]) -> VideoTarget {
    if selected.contains(&VideoTarget::YoutubeShorts) {
        VideoTarget::YoutubeShorts
    } else {
        VideoTarget::InstagramReels
    }
}

fn wizard_text(value: Option<&Value>) -> String {
    value.and_then(Value::as_str).unwrap_or("").to_owned()
}

fn wizard_metadata(target: VideoTarget, collected: &JsonObject) -> JsonObject {
    let mut metadata = Map::new();
    if target == VideoTarget::InstagramReels {
        metadata.insert("caption".into(), json!(wizard_text(collected.get("instagram_caption"))));
        return metadata;
    }
    metadata.insert("title".into(), json!(wizard_text(collected.get("youtube_title"))));
    metadata.insert(
        "description".into(),
        json!(wizard_text(collected.get("youtube_description"))),
    );
    metadata.insert(
        "tags".into(),
        match collected.get("youtube_tags") {
            Some(Value::Array(tags)) => Value::Array(tags.clone()),
            _ => json!([]),
        },
    );
    let game_url = wizard_text(collected.get("youtube_game_url"));
    if !game_url.is_empty() {
        metadata.insert("gameUrl".into(), json!(game_url));
    }
    metadata
}

fn wizard_label(metadata: &JsonObject) -> String {
    let text = |key| metadata.get(key).and_then(Value::as_str).unwrap_or("");
    if metadata.contains_key("title") {
        let title = text("title");
        if title.is_empty() { "YouTube Shorts" } else { title }.to_owned()
    } else {
        let caption = text("caption");
        if caption.is_empty() { "Instagram Reels" } else { caption }.to_owned()
    }
}

/// The targets a video schedule names, the rest of its keys dropped.
fn video_schedule_values(schedule: &PublicationSchedule) -> Vec<(VideoTarget, Timestamp)> {
    schedule
        .values
        .iter()
        .filter_map(|(target, at)| VideoTarget::parse(target).map(|target| (target, *at)))
        .collect()
}

#[derive(Clone, Copy)]
pub struct VideoService<'a, A> {
    studio: Studio<'a>,
    adapters: &'a A,
}

impl<'a, A: MediaProbe + VideoProvider + YoutubeUploads> VideoService<'a, A> {
    pub fn new(studio: Studio<'a>, adapters: &'a A) -> Self {
        Self { studio, adapters }
    }

    pub fn kind(&self) -> PublicationKind {
        PublicationKind::Video
    }

    pub fn capabilities(&self) -> PublicationCapabilities {
        PublicationCapabilities {
            schedule_axis: PublicationScheduleAxis::Target,
        }
    }

    fn retention_hours(&self) -> Result<i64> {
        Ok(studio_config(self.studio.ports()).video()?.retention_hours)
    }

    fn owned(&self, actor_id: i64, publication_id: i64) -> Result<StudioVideoDraftRecord> {
        let video = self
            .studio
            .ports()
            .studio_videos()
            .get(publication_id)?
            .ok_or_else(|| Error::message("Video publication was not found."))?;
        if !self.studio.can_access(actor_id, video.actor_id) {
            return Err(StudioError::new("err.video-not-yours").into());
        }
        Ok(video)
    }

    fn targets(&self, publication_id: i64) -> Result<Vec<StudioVideoTargetRecord>> {
        self.studio.ports().studio_videos().targets(publication_id)
    }

    /// The stored file behind an accessible video asset. Every path that
    /// reads the source goes through here, so "is it mine and is it a video"
    /// is one answer.
    fn video_asset_path(&self, actor_id: i64, studio_media_asset_id: i64) -> Result<String> {
        let assets = self
            .studio
            .ports()
            .studio_media_assets()
            .require(&self.studio.accessible_actor_ids(actor_id), &[studio_media_asset_id])?;
        match assets.into_iter().next() {
            Some(asset) if asset.asset.kind == "video" => Ok(asset.asset.local_path),
            _ => Err(StudioError::new("err.video-needs-asset").into()),
        }
    }

    fn zone(&self, actor_id: i64) -> Result<Zone> {
        let timezone = SettingsService::new(self.studio.ports())
            .time_config(actor_id)?
            .timezone;
        Zone::parse(&timezone).ok_or_else(|| Error::message(format!("Invalid time zone: {timezone}")))
    }

    /// `locale` defaults to Russian.
    pub fn create(&self, actor_id: i64, studio_media_asset_id: i64, locale: Option<Locale>) -> Result<i64> {
        self.studio.track("studio.video.create", || {
            self.video_asset_path(actor_id, studio_media_asset_id)?;
            self.studio.publishing.create_video_draft(
                actor_id,
                studio_media_asset_id,
                self.retention_hours()?,
                locale.unwrap_or(Locale::Ru),
            )
        })
    }

    pub fn get(&self, actor_id: i64, publication_id: i64) -> Result<VideoView> {
        let draft = self.owned(actor_id, publication_id)?;
        Ok(VideoView {
            id: draft.id,
            status: draft.status.clone(),
            draft,
            targets: self.targets(publication_id)?,
        })
    }

    /// Swaps the uploaded file behind an unprepared draft, for the case the
    /// operator attached the wrong one. The new file passes the same
    /// technical gate as the original before the draft points at it.
    pub async fn replace_source(
        &self,
        actor_id: i64,
        publication_id: i64,
        studio_media_asset_id: i64,
    ) -> Result<VideoTechnicalCheck> {
        self.studio
            .track_async("studio.video.edit", async {
                self.owned(actor_id, publication_id)?;
                let path = self.video_asset_path(actor_id, studio_media_asset_id)?;
                let technical = validate_video_source(self.adapters, &path).await?;
                self.studio.publishing.replace_video_source(
                    publication_id,
                    studio_media_asset_id,
                    technical.seconds,
                )?;
                Ok(technical)
            })
            .await
    }

    /// The same technical check, run on an uploaded file before any draft
    /// points at it: what the file is decides whether a draft is worth creating.
    pub async fn asset_technical_check(
        &self,
        actor_id: i64,
        studio_media_asset_id: i64,
    ) -> Result<VideoTechnicalCheck> {
        let path = self.video_asset_path(actor_id, studio_media_asset_id)?;
        validate_video_source(self.adapters, &path).await
    }

    pub fn source_replaceable(&self, actor_id: i64, publication_id: i64) -> Result<bool> {
        let draft = self.owned(actor_id, publication_id)?;
        let targets = self.targets(publication_id)?;
        let statuses: Vec<&str> = targets.iter().map(|target| target.status.as_str()).collect();
        Ok(!targets.is_empty() && is_video_source_replaceable(&draft.status, &statuses))
    }

    pub fn metadata_editable_targets(&self, actor_id: i64, publication_id: i64) -> Result<Vec<VideoTarget>> {
        self.owned(actor_id, publication_id)?;
        Ok(self
            .targets(publication_id)?
            .iter()
            .filter(|target| is_video_target_metadata_editable(&target.status))
            .filter_map(|target| VideoTarget::parse(&target.target))
            .collect())
    }

    /// `limit` defaults to 50.
    pub fn list(&self, actor_id: i64, limit: Option<i64>) -> Result<Vec<StudioVideoDraftRecord>> {
        self.studio
            .ports()
            .studio_videos()
            .list(&self.studio.accessible_actor_ids(actor_id), limit.unwrap_or(50))
    }

    pub async fn schedule(
        &self,
        actor_id: i64,
        publication_id: i64,
        schedule: &[(VideoTarget, Timestamp)],
    ) -> Result<VideoTechnicalCheck> {
        self.studio
            .track_async(
                "studio.video.schedule",
                self.schedule_owned_video(actor_id, publication_id, schedule),
            )
            .await
    }

    pub async fn validate(&self, actor_id: i64, publication_id: i64) -> Result<Vec<Issue>> {
        self.technical_check(actor_id, publication_id).await?;
        Ok(Vec::new())
    }

    pub async fn technical_check(&self, actor_id: i64, publication_id: i64) -> Result<VideoTechnicalCheck> {
        self.owned(actor_id, publication_id)?;
        self.studio
            .publishing
            .validate_video_draft(self.studio.config, self.adapters, publication_id)
            .await
    }

    pub async fn publish(&self, actor_id: i64, publication_id: i64) -> Result<VideoTechnicalCheck> {
        self.studio
            .track_async("studio.video.publish", async {
                // Access first: otherwise an outsider's draft answers "choose
                // platforms" instead of "not yours", which leaks whether it
                // exists and how it looks.
                self.owned(actor_id, publication_id)?;
                let at = immediate_schedule_time(self.studio.now());
                let schedule: Vec<(VideoTarget, Timestamp)> = self
                    .targets(publication_id)?
                    .iter()
                    .filter_map(|row| VideoTarget::parse(&row.target))
                    .map(|target| (target, at))
                    .collect();
                if schedule.is_empty() {
                    return Err(StudioError::new("err.video-choose-platforms").into());
                }
                self.schedule_owned_video(actor_id, publication_id, &schedule).await
            })
            .await
    }

    /// Answers a provider-delivered target that lost its worker, by asking
    /// the provider with the request id that already fences the publication.
    pub async fn settle_target(&self, actor_id: i64, publication_id: i64, target: VideoTarget) -> Result<JsonObject> {
        self.studio
            .track_async("studio.video.settle", async {
                self.owned(actor_id, publication_id)?;
                self.studio
                    .publishing
                    .settle_video_target(
                        self.studio.config,
                        self.adapters,
                        &SettleVideoInput {
                            video_draft_id: publication_id,
                            target: target.as_str(),
                            apply: true,
                            known: None,
                        },
                    )
                    .await
            })
            .await
    }

    /// A provider route is asked before it is re-sent, so this answers with
    /// what the publication turned out to be rather than with a requeue that
    /// never happened.
    pub async fn retry_target(
        &self,
        actor_id: i64,
        publication_id: i64,
        target: VideoTarget,
    ) -> Result<VideoRetrySummary> {
        self.studio
            .track_async("studio.video.retry", async {
                self.owned(actor_id, publication_id)?;
                let retry = self
                    .studio
                    .publishing
                    .retry_video_target(self.studio.config, self.adapters, publication_id, target)
                    .await?;
                Ok(match retry.settled {
                    None => VideoRetrySummary {
                        requeued: 1,
                        already_queued: 0,
                        settled: None,
                    },
                    Some(settled) => VideoRetrySummary {
                        requeued: 0,
                        already_queued: 0,
                        settled: Some(settled),
                    },
                })
            })
            .await
    }

    pub async fn cancel(&self, actor_id: i64, publication_id: i64) -> Result<VideoCancelReport> {
        self.studio
            .track_async("studio.video.cancel", async {
                let draft = self.owned(actor_id, publication_id)?;
                let cancellation = self
                    .studio
                    .publishing
                    .cancel_video(publication_id, self.retention_hours()?)?;
                let reference = video_ref(publication_id);
                self.studio
                    .boundaries
                    .reminders
                    .cancel(self.studio.sqlite(), &reference)?;
                let locale = if draft.locale == "en" { Locale::En } else { Locale::Ru };
                let (mut held, mut failures) = (Vec::new(), Vec::new());
                for video_id in &cancellation.hold_private_youtube_ids {
                    match self.adapters.keep_private(self.studio.config, video_id, locale).await {
                        Ok(()) => held.push(video_id.clone()),
                        Err(error) => failures.push(error.to_string()),
                    }
                }
                let manual_removal: Vec<ManualRemoval> = cancellation
                    .manual_removal
                    .into_iter()
                    .map(|(target, url)| ManualRemoval { target, url })
                    .collect();
                if !manual_removal.is_empty() || !failures.is_empty() {
                    let Value::Object(details) = json!({
                        "manual_removal": manual_removal,
                        "held_private_youtube_ids": held,
                        "hold_failures": failures,
                    }) else {
                        unreachable!("built as an object")
                    };
                    self.studio.ports().events().record(&DomainEventInput {
                        publication_ref: Some(reference),
                        event_type: "studio.notification.video_cancelled".into(),
                        severity: if failures.is_empty() {
                            Severity::Info
                        } else {
                            Severity::Warn
                        },
                        target: None,
                        message: if manual_removal.is_empty() {
                            format!(
                                "Video #{publication_id} was cancelled locally; YouTube schedule needs attention."
                            )
                        } else {
                            format!(
                                "Video #{publication_id} was cancelled locally; published targets require manual removal."
                            )
                        },
                        details: Some(details),
                        cooldown_seconds: None,
                    })?;
                }
                Ok(VideoCancelReport {
                    manual_removal,
                    hold_private_youtube_ids: cancellation.hold_private_youtube_ids,
                    held_private_youtube_ids: held,
                    hold_failures: failures,
                })
            })
            .await
    }

    pub fn preview(&self, actor_id: i64, publication_id: i64) -> Result<VideoPreview> {
        let draft = self.owned(actor_id, publication_id)?;
        Ok(VideoPreview {
            id: draft.id,
            status: draft.status.clone(),
            issues: Vec::new(),
            targets: self.targets(publication_id)?,
            delivery: video_delivery_projections(self.studio.ports(), publication_id)?,
            draft,
        })
    }

    pub fn status(&self, actor_id: i64, publication_id: i64) -> Result<VideoStatus> {
        let draft = self.owned(actor_id, publication_id)?;
        Ok(VideoStatus {
            draft,
            targets: self.targets(publication_id)?,
            jobs: self.studio.ports().studio_videos().jobs(publication_id)?,
        })
    }

    /// `limit` defaults to 50.
    pub fn history(&self, actor_id: i64, publication_id: i64, limit: Option<i64>) -> Result<Vec<PostEventRecord>> {
        self.owned(actor_id, publication_id)?;
        self.studio
            .ports()
            .studio_videos()
            .history(&video_ref(publication_id), limit.unwrap_or(50))
    }

    pub fn update_metadata(
        &self,
        actor_id: i64,
        publication_id: i64,
        target: VideoTarget,
        metadata: &JsonObject,
    ) -> Result<()> {
        self.studio.track("studio.video.edit", || {
            self.owned(actor_id, publication_id)?;
            self.studio
                .publishing
                .save_video_metadata(publication_id, target, metadata)
        })
    }

    /// One field of one platform's metadata, as an edit menu changes it.
    pub fn edit_metadata_field(
        &self,
        actor_id: i64,
        publication_id: i64,
        field: VideoWizardStep,
        value: &Value,
    ) -> Result<()> {
        self.owned(actor_id, publication_id)?;
        let target = if field == VideoWizardStep::InstagramCaption {
            VideoTarget::InstagramReels
        } else {
            VideoTarget::YoutubeShorts
        };
        let mut metadata = self
            .targets(publication_id)?
            .into_iter()
            .find(|row| row.target == target.as_str())
            .map(|row| row.metadata_json)
            .unwrap_or_default();
        match field {
            VideoWizardStep::YoutubeTitle => {
                metadata.insert("title".into(), value.clone());
            }
            VideoWizardStep::YoutubeDescription => {
                metadata.insert("description".into(), value.clone());
            }
            VideoWizardStep::YoutubeGameUrl => {
                if truthy(value) {
                    metadata.insert("gameUrl".into(), value.clone());
                } else {
                    metadata.remove("gameUrl");
                }
            }
            VideoWizardStep::YoutubeTags => {
                metadata.insert("tags".into(), value.clone());
            }
            VideoWizardStep::InstagramCaption => {
                metadata.insert("caption".into(), value.clone());
                metadata.remove("hashtags");
            }
        }
        self.studio
            .publishing
            .save_video_metadata(publication_id, target, &metadata)?;
        if field == VideoWizardStep::YoutubeTitle {
            let label = if truthy(value) {
                string_of(value)
            } else {
                "YouTube Shorts".into()
            };
            self.studio.publishing.update_video_label(publication_id, &label)?;
        }
        Ok(())
    }

    /// Persists everything a metadata wizard collected for one platform and
    /// titles the draft after it. Which fields a platform stores, and which
    /// of several platforms names the draft, are publication decisions — a
    /// dialog only forwards what the operator typed.
    pub fn complete_wizard_target(
        &self,
        actor_id: i64,
        publication_id: i64,
        target: VideoTarget,
        collected: &JsonObject,
        selected: &[VideoTarget],
    ) -> Result<()> {
        self.owned(actor_id, publication_id)?;
        let metadata = wizard_metadata(target, collected);
        self.studio
            .publishing
            .save_video_metadata(publication_id, target, &metadata)?;
        if target == labelling_video_target(selected) {
            self.studio
                .publishing
                .update_video_label(publication_id, &wizard_label(&metadata))?;
        }
        Ok(())
    }

    pub fn rename(&self, actor_id: i64, publication_id: i64, label: &str) -> Result<()> {
        self.studio.track("studio.video.edit", || {
            self.owned(actor_id, publication_id)?;
            self.studio.publishing.update_video_label(publication_id, label)
        })
    }

    /// Stores the script a video was written from. The hook is its opening,
    /// and everything downstream reads it from here.
    pub fn set_script(&self, actor_id: i64, publication_id: i64, script: &str) -> Result<()> {
        self.studio.track("studio.video.edit", || {
            self.owned(actor_id, publication_id)?;
            self.studio
                .publishing
                .update_video_script(publication_id, script, "operator")
        })
    }

    pub fn replace_targets(&self, actor_id: i64, publication_id: i64, targets: &[VideoTarget]) -> Result<()> {
        self.studio.track("studio.video.edit", || {
            self.owned(actor_id, publication_id)?;
            self.studio.publishing.replace_video_targets(
                publication_id,
                &targets.iter().map(|target| target.as_str()).collect::<Vec<_>>(),
            )
        })
    }

    pub fn remove_target(&self, actor_id: i64, publication_id: i64, target: VideoTarget) -> Result<TargetRemoval> {
        self.owned(actor_id, publication_id)?;
        Ok(TargetRemoval {
            cancelled: self
                .studio
                .publishing
                .remove_video_target(publication_id, target, self.retention_hours()?)?,
        })
    }

    pub fn toggle_target(&self, actor_id: i64, publication_id: i64, target: &str) -> Result<()> {
        self.owned(actor_id, publication_id)?;
        let current: Vec<String> = self
            .targets(publication_id)?
            .into_iter()
            .map(|row| row.target)
            .collect();
        if current.iter().any(|existing| existing == target)
            && let Some(video_target) = VideoTarget::parse(target)
        {
            self.studio
                .publishing
                .remove_video_target(publication_id, video_target, self.retention_hours()?)?;
            return Ok(());
        }
        let mut next: Vec<&str> = current.iter().map(String::as_str).collect();
        next.push(target);
        self.studio.publishing.replace_video_targets(publication_id, &next)
    }

    pub fn manual_schedule(&self, actor_id: i64, publication_id: i64, value: &str) -> Result<Timestamp> {
        self.owned(actor_id, publication_id)?;
        Ok(parse_manual_schedule(value, &self.zone(actor_id)?, self.studio.now())?)
    }

    /// The time "send now" means. Delivery runs off the schedule, so this is
    /// a timestamp like any other and the transport never invents its own.
    pub fn immediate_time(&self) -> Timestamp {
        immediate_schedule_time(self.studio.now())
    }

    pub fn is_immediate(&self, value: Timestamp) -> bool {
        is_immediate_schedule(value, self.studio.now())
    }

    /// A slot-button clock (`HH:MM` in the Studio zone) at its next occurrence.
    pub fn slot_time(&self, actor_id: i64, clock: &str) -> Result<Timestamp> {
        publication_slot_time(clock, &self.zone(actor_id)?, self.studio.now())
    }

    /// Shared by `schedule` (explicit times) and `publish` (about now): both
    /// validate the source, write the schedule and arm reminders identically.
    async fn schedule_owned_video(
        &self,
        actor_id: i64,
        publication_id: i64,
        schedule: &[(VideoTarget, Timestamp)],
    ) -> Result<VideoTechnicalCheck> {
        let draft = self.owned(actor_id, publication_id)?;
        let technical = self
            .studio
            .publishing
            .validate_video_draft(self.studio.config, self.adapters, publication_id)
            .await?;
        let prepare_lead_minutes = studio_config(self.studio.ports()).video()?.prepare_lead_minutes;
        self.studio.publishing.schedule_video(
            publication_id,
            schedule,
            prepare_lead_minutes,
            Some(technical.seconds),
        )?;
        self.schedule_video_reminders(draft.actor_id, publication_id, &draft.label)?;
        Ok(technical)
    }

    fn schedule_video_reminders(&self, owner_id: i64, publication_id: i64, label: &str) -> Result<()> {
        let reference = video_ref(publication_id);
        let boundary = self.studio.boundaries.reminders;
        boundary.cancel(self.studio.sqlite(), &reference)?;
        let notifications = SettingsService::new(self.studio.ports()).notifications(owner_id)?;
        let reminders = ReminderPolicy {
            enabled: notifications.video_reminders_enabled,
            minutes: notifications.reminder_minutes,
        };
        let mut grouped: Vec<(String, Vec<String>)> = Vec::new();
        for target in self.targets(publication_id)? {
            let Some(scheduled_at) = target.scheduled_at.filter(|at| !at.is_empty()) else {
                continue;
            };
            if matches!(
                target.status.as_str(),
                "published" | "cancelled" | "failed" | "verification_required"
            ) {
                continue;
            }
            match grouped.iter_mut().find(|(at, _)| *at == scheduled_at) {
                Some((_, targets)) => targets.push(target.target),
                None => grouped.push((scheduled_at, vec![target.target])),
            }
        }
        let title = if label.is_empty() {
            format!("Video #{publication_id}")
        } else {
            label.to_owned()
        };
        for (publish_at, targets) in grouped {
            boundary.schedule(
                self.studio.sqlite(),
                &Reminder {
                    actor_id: owner_id,
                    publication_ref: &reference,
                    kind: &format!("video.{publish_at}"),
                    publish_at: foundation::time::parse_iso_instant(&publish_at)
                        .map_err(|error| Error::message(error.to_string()))?,
                    title: &title,
                    targets: &targets,
                    reminders,
                },
            )?;
        }
        Ok(())
    }
}

impl<A: MediaProbe + VideoProvider + YoutubeUploads> PublicationPipeline for VideoService<'_, A> {
    fn kind(&self) -> PublicationKind {
        VideoService::kind(self)
    }

    fn capabilities(&self) -> PublicationCapabilities {
        VideoService::capabilities(self)
    }

    fn get(&self, actor_id: i64, publication_id: i64) -> Result<PublicationView> {
        let video = VideoService::get(self, actor_id, publication_id)?;
        Ok(PublicationView {
            id: video.id,
            status: video.status,
        })
    }

    fn preview(&self, actor_id: i64, publication_id: i64) -> Result<PreviewModel> {
        let preview = VideoService::preview(self, actor_id, publication_id)?;
        Ok(PreviewModel {
            view: PublicationView {
                id: preview.id,
                status: preview.status,
            },
            issues: preview.issues,
        })
    }

    async fn validate(&self, actor_id: i64, publication_id: i64) -> Result<Vec<Issue>> {
        VideoService::validate(self, actor_id, publication_id).await
    }

    async fn schedule(&self, actor_id: i64, publication_id: i64, schedule: &PublicationSchedule) -> Result<()> {
        VideoService::schedule(self, actor_id, publication_id, &video_schedule_values(schedule))
            .await
            .map(drop)
    }

    async fn publish(&self, actor_id: i64, publication_id: i64) -> Result<()> {
        VideoService::publish(self, actor_id, publication_id).await.map(drop)
    }

    async fn cancel(&self, actor_id: i64, publication_id: i64) -> Result<()> {
        VideoService::cancel(self, actor_id, publication_id).await.map(drop)
    }

    async fn retry_target(&self, actor_id: i64, publication_id: i64, target: &str) -> Result<PublicationRetrySummary> {
        let target =
            VideoTarget::parse(target).ok_or_else(|| Error::message(format!("{target} is not a video target")))?;
        let retry = VideoService::retry_target(self, actor_id, publication_id, target).await?;
        Ok(PublicationRetrySummary {
            requeued: retry.requeued,
            already_queued: retry.already_queued,
        })
    }

    fn remove_target(&self, actor_id: i64, publication_id: i64, target: &str) -> Result<()> {
        let target =
            VideoTarget::parse(target).ok_or_else(|| Error::message(format!("{target} is not a video target")))?;
        VideoService::remove_target(self, actor_id, publication_id, target).map(drop)
    }

    fn toggle_target(&self, actor_id: i64, publication_id: i64, target: &str) -> Result<()> {
        VideoService::toggle_target(self, actor_id, publication_id, target)
    }

    fn slot_time(&self, actor_id: i64, clock: &str) -> Result<Timestamp> {
        VideoService::slot_time(self, actor_id, clock)
    }
}
