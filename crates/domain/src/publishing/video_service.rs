//! A video publication from upload to cancellation: its targets, metadata,
//! source, schedule, retry and technical check.

use std::sync::LazyLock;

use content::Locale;
use db::rusqlite::{OptionalExtension, params};
use foundation::config::Config;
use foundation::errors::StudioError;
use jiff::Timestamp;
use regex::Regex;
use serde_json::{Map, Value, json};

use super::boundaries::{MediaProbe, VideoProvider};
use super::schedule::assert_future_schedule;
use super::state::{
    is_audience_mutation_retryable, is_video_target_editable, is_video_target_metadata_editable,
    is_video_target_schedulable,
};
use super::video_assets::video_source_path;
use super::video_audio::background_music_likely_missing;
use super::video_data::{VideoJobKind, video_target};
use super::video_metadata_limits::assert_video_metadata;
use super::video_settle::SettleVideoInput;
use super::video_types::{VideoTarget, VideoTechnicalCheck};
use super::{Publishing, iso_at, parse_ms};
use crate::application::ports::{DomainEventInput, Severity};
use crate::application::publication_ref::{PublicationRefKind, publication_ref};
use crate::channels::channel_for_video;
use crate::publishing::publication_status::object;
use crate::repositories::{record_event, transaction};
use crate::{Error, Result};

/// Telegram refuses larger uploads, and the mounted media volume is sized
/// around this.
const VIDEO_MAX_BYTES: u64 = 1_000_000_000;

/// JavaScript's whitespace, for patterns written with `\s`.
const JS_SPACE: &str =
    r"\t\n\x0B\x0C\r \x{a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}";

/// Pronunciation written for whoever reads the script aloud — "Capcom
/// (Кáпком)" — and never said.
static SAID_ALOUD: LazyLock<Regex> = LazyLock::new(|| Regex::new(&format!(r"[{JS_SPACE}]*[(\[][^)\]]*[)\]]")).unwrap());
static SPACE_RUN: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[ \t]+").unwrap());
static PARAGRAPH_BREAK: LazyLock<Regex> = LazyLock::new(|| Regex::new(&format!(r"\n[{JS_SPACE}]*\n")).unwrap());
static FIRST_SENTENCE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[^.!?]{10,}?[.!?]").unwrap());

/// `Math.round(seconds * 1000)`.
fn duration_ms(seconds: f64) -> i64 {
    (seconds * 1000.0 + 0.5).floor() as i64
}

/// The words a video opens with. A written script puts the hook in its own
/// first paragraph; a transcript has no paragraphs, so its first sentence is
/// the closest proxy.
fn opening_line(text: &str, source: &str) -> String {
    let cleaned = SAID_ALOUD.replace_all(text, "");
    let cleaned = SPACE_RUN.replace_all(&cleaned, " ");
    if source == "operator"
        && let Some(paragraph) = PARAGRAPH_BREAK.split(&cleaned).next().map(foundation::js::trim)
        && !paragraph.is_empty()
    {
        return paragraph.to_owned();
    }
    let trimmed = foundation::js::trim(&cleaned);
    let line = match FIRST_SENTENCE.find(trimmed) {
        Some(sentence) => sentence.as_str().to_owned(),
        None => String::from_utf16_lossy(&trimmed.encode_utf16().take(160).collect::<Vec<_>>()),
    };
    foundation::js::trim(&line).to_owned()
}

/// Already-public targets are deliberately not deleted by automation; private
/// scheduled uploads can safely be kept private.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct VideoCancellation {
    pub manual_removal: Vec<(String, Option<String>)>,
    pub hold_private_youtube_ids: Vec<String>,
}

/// What the provider answered before a retry; `None` when nothing was asked.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VideoRetry {
    pub settled: Option<String>,
}

/// How one video target is delivered: natively, or through the provider
/// account its channel names.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VideoRoute {
    pub provider: &'static str,
    pub account_id: Option<String>,
}

fn locked(code: &str) -> Error {
    StudioError::new(code).into()
}

impl Publishing<'_> {
    fn retention_until(&self, retention_hours: i64) -> String {
        iso_at(self.now_ms() + retention_hours * 60 * 60_000)
    }

    pub fn create_video_draft(
        &self,
        actor_id: i64,
        studio_media_asset_id: i64,
        retention_hours: i64,
        locale: Locale,
    ) -> Result<i64> {
        let now = self.now();
        Ok(self.sqlite.query_row(
            r#"insert into "video_drafts" ("actor_id", "locale", "studio_media_asset_id", "status", "retention_until", "created_at", "updated_at") values (?, ?, ?, ?, ?, ?, ?) returning "id""#,
            params![
                actor_id,
                locale.as_str(),
                studio_media_asset_id,
                "editing",
                self.retention_until(retention_hours),
                now,
                now
            ],
            |row| row.get(0),
        )?)
    }

    /// Stores the script behind a video, at any stage: a video that has gone
    /// out is exactly the one whose opening is worth knowing.
    pub fn update_video_script(&self, id: i64, script: &str, source: &str) -> Result<()> {
        self.get_video_draft(id)?;
        let text = foundation::js::trim(script);
        let present = !text.is_empty();
        self.sqlite.execute(
            r#"update "video_drafts" set "script" = ?, "script_source" = ?, "opening_line" = ?, "updated_at" = ? where "video_drafts"."id" = ?"#,
            params![
                present.then_some(text),
                present.then_some(source),
                present.then(|| opening_line(text, source)),
                self.now(),
                id
            ],
        )?;
        Ok(())
    }

    pub fn update_video_label(&self, id: i64, label: &str) -> Result<()> {
        let draft = self.get_video_draft(id)?;
        if !matches!(draft.status.as_str(), "draft" | "editing" | "scheduled") {
            return Err(locked("err.video-draft-locked"));
        }
        self.sqlite.execute(
            r#"update "video_drafts" set "label" = ?, "updated_at" = ? where "video_drafts"."id" = ?"#,
            params![foundation::js::trim(label), self.now(), id],
        )?;
        Ok(())
    }

    pub fn replace_video_targets(&self, video_draft_id: i64, targets: &[&str]) -> Result<()> {
        let mut allowed: Vec<VideoTarget> = Vec::new();
        for target in targets.iter().filter_map(|target| VideoTarget::parse(target)) {
            if !allowed.contains(&target) {
                allowed.push(target);
            }
        }
        if allowed.is_empty() {
            return Err(locked("err.video-pick-platform"));
        }
        let now = self.now();
        let sqlite = self.sqlite;
        transaction(sqlite, || {
            if self
                .list_video_targets(video_draft_id)?
                .iter()
                .any(|target| !is_video_target_editable(&target.status))
            {
                return Err(locked("err.video-targets-locked"));
            }
            // Foreign keys cascade: deleting the target rows removes their
            // comments, metric snapshots and schedules. Reminder jobs carry a
            // null target, so the draft's jobs are cleared explicitly.
            sqlite.execute(
                r#"delete from "video_jobs" where "video_jobs"."video_draft_id" = ?"#,
                [video_draft_id],
            )?;
            sqlite.execute(
                r#"delete from "video_targets" where "video_targets"."video_draft_id" = ?"#,
                [video_draft_id],
            )?;
            for target in &allowed {
                sqlite.execute(
                    r#"insert into "video_targets" ("video_draft_id", "target", "metadata_json", "status", "created_at", "updated_at") values (?, ?, ?, ?, ?, ?)"#,
                    params![video_draft_id, target.as_str(), "{}", "editing", now, now],
                )?;
            }
            sqlite.execute(
                r#"update "video_drafts" set "status" = ?, "updated_at" = ? where "video_drafts"."id" = ?"#,
                params!["editing", now, video_draft_id],
            )?;
            Ok(())
        })
    }

    /// Removes one editable target and every dependent job and metric row
    /// atomically; `true` when it was the last one and the draft is cancelled.
    pub fn remove_video_target(&self, video_draft_id: i64, target: VideoTarget, retention_hours: i64) -> Result<bool> {
        let row = video_target(self.sqlite, video_draft_id, target.as_str())?
            .ok_or_else(|| locked("err.video-target-missing"))?;
        if !is_video_target_editable(&row.status) {
            return Err(locked("err.video-target-locked"));
        }
        let now = self.now();
        let sqlite = self.sqlite;
        let remaining = transaction(sqlite, || {
            // Fenced on the status the editability check read: a worker can
            // publish this target in between, and deleting it then would drop
            // a live publication and its whole history.
            let deleted = sqlite
                .query_row(
                    r#"delete from "video_targets" where ("video_targets"."id" = ? and "video_targets"."status" = ?) returning "id""#,
                    params![row.id, row.status],
                    |found| found.get::<_, i64>(0),
                )
                .optional()?;
            if deleted.is_none() {
                return Err(locked("err.video-target-locked"));
            }
            let remaining: i64 = sqlite.query_row(
                r#"select count(*) from "video_targets" where "video_targets"."video_draft_id" = ?"#,
                [video_draft_id],
                |found| found.get(0),
            )?;
            if remaining == 0 {
                sqlite.execute(
                    r#"update "video_drafts" set "status" = ?, "retention_until" = ?, "updated_at" = ? where "video_drafts"."id" = ?"#,
                    params!["cancelled", self.retention_until(retention_hours), now, video_draft_id],
                )?;
            }
            Ok(remaining)
        })?;
        if remaining > 0 {
            self.refresh_video_draft_status(video_draft_id, retention_hours)?;
        }
        Ok(remaining == 0)
    }

    /// Every interface writes metadata through here, so this is where the
    /// platform's limits are enforced. A partial publication is half-finished,
    /// not locked: a refused target usually needs exactly the details it was
    /// refused for.
    pub fn save_video_metadata(
        &self,
        video_draft_id: i64,
        target: VideoTarget,
        metadata: &Map<String, Value>,
    ) -> Result<()> {
        let draft = self.get_video_draft(video_draft_id)?;
        if !matches!(draft.status.as_str(), "draft" | "editing" | "scheduled" | "partial") {
            return Err(locked("err.video-draft-locked"));
        }
        let existing = video_target(self.sqlite, video_draft_id, target.as_str())?
            .ok_or_else(|| locked("err.video-target-missing"))?;
        assert_video_metadata(target, metadata)?;
        if !is_video_target_metadata_editable(&existing.status) {
            return Err(locked("err.video-metadata-locked"));
        }
        if self.running_video_job(r#""video_jobs"."video_target_id" = ?"#, existing.id)? {
            return Err(locked("err.video-job-running"));
        }
        // Fenced on the status the checks above read: a prepare job can claim
        // this target in that window, and the platform would then receive the
        // old title while Studio shows the new one.
        let updated = self
            .sqlite
            .query_row(
                r#"update "video_targets" set "metadata_json" = ?, "updated_at" = ? where ("video_targets"."id" = ? and "video_targets"."status" = ?) returning "id""#,
                params![crate::json::stringify_object(metadata), self.now(), existing.id, existing.status],
                |row| row.get::<_, i64>(0),
            )
            .optional()?;
        if updated.is_none() {
            return Err(locked("err.video-metadata-locked"));
        }
        Ok(())
    }

    fn running_video_job(&self, condition: &str, id: i64) -> Result<bool> {
        Ok(self
            .sqlite
            .query_row(
                &format!(r#"select "id" from "video_jobs" where ({condition} and "video_jobs"."status" = ?)"#),
                params![id, "running"],
                |row| row.get::<_, i64>(0),
            )
            .optional()?
            .is_some())
    }

    /// Replaces the source file. The probed duration travels with it: it is
    /// recorded per target and describes the source.
    pub fn replace_video_source(
        &self,
        video_draft_id: i64,
        studio_media_asset_id: i64,
        duration_seconds: f64,
    ) -> Result<()> {
        let now = self.now();
        let sqlite = self.sqlite;
        transaction(sqlite, || {
            let draft = self.get_video_draft(video_draft_id)?;
            let targets = self.list_video_targets(video_draft_id)?;
            let statuses: Vec<&str> = targets.iter().map(|target| target.status.as_str()).collect();
            if !is_video_source_replaceable(&draft.status, &statuses) {
                return Err(locked("err.video-source-locked"));
            }
            if self.running_video_job(r#""video_jobs"."video_draft_id" = ?"#, video_draft_id)? {
                return Err(locked("err.video-job-running"));
            }
            for target in &targets {
                let mut metadata = target.metadata.clone();
                if duration_seconds > 0.0 {
                    metadata.insert("videoDurationMs".into(), json!(duration_ms(duration_seconds)));
                }
                // Fenced on the status the replaceability check read: a
                // prepare job can claim this target and upload the old file.
                let updated = sqlite
                    .query_row(
                        r#"update "video_targets" set "metadata_json" = ?, "updated_at" = ? where ("video_targets"."id" = ? and "video_targets"."status" = ?) returning "id""#,
                        params![crate::json::stringify_object(&metadata), now, target.id, target.status],
                        |row| row.get::<_, i64>(0),
                    )
                    .optional()?;
                if updated.is_none() {
                    return Err(locked("err.video-source-locked"));
                }
            }
            // The new file is present, so the retention sweep has to see the
            // draft again.
            let replaced = sqlite
                .query_row(
                    r#"update "video_drafts" set "studio_media_asset_id" = ?, "source_pruned_at" = null, "updated_at" = ? where ("video_drafts"."id" = ? and "video_drafts"."status" = ?) returning "id""#,
                    params![studio_media_asset_id, now, video_draft_id, draft.status],
                    |row| row.get::<_, i64>(0),
                )
                .optional()?;
            if replaced.is_none() {
                return Err(locked("err.video-source-locked"));
            }
            Ok(())
        })
    }

    pub fn schedule_video(
        &self,
        video_draft_id: i64,
        schedule: &[(VideoTarget, Timestamp)],
        prepare_lead_minutes: i64,
        duration_seconds: Option<f64>,
    ) -> Result<()> {
        let now = self.clock.now();
        let targets = self.list_video_targets(video_draft_id)?;
        if targets.is_empty() {
            return Err(locked("err.video-choose-platforms"));
        }
        let when = |target: &str| {
            schedule
                .iter()
                .find(|(scheduled, _)| scheduled.as_str() == target)
                .map(|(_, at)| *at)
        };
        let selected: Vec<_> = targets.iter().filter(|target| when(&target.target).is_some()).collect();
        if selected.is_empty() {
            return Err(locked("err.video-pick-platform"));
        }
        for target in &selected {
            // The card hides the control for a settled target, but reaching
            // this service another way used to arm a second prepare/publish
            // pair for something already delivered.
            if !is_video_target_schedulable(&target.status) {
                return Err(locked("err.video-target-not-schedulable"));
            }
            assert_future_schedule(when(&target.target).expect("selected"), now)?;
        }
        let now_iso = foundation::time::to_iso_string(now);
        let sqlite = self.sqlite;
        transaction(sqlite, || {
            for target in &selected {
                let at = when(&target.target).expect("selected");
                let publish_at = foundation::time::to_iso_string(at);
                let prepared_at = iso_at(at.as_millisecond() - prepare_lead_minutes * 60_000);
                let draft = self.get_video_draft(video_draft_id)?;
                let kind = VideoTarget::parse(&target.target).expect("stored targets are video targets");
                let route = self.video_delivery_route(kind, if draft.locale == "en" { "en" } else { "ru" })?;
                let mut metadata = target.metadata.clone();
                if let Some(seconds) = duration_seconds.filter(|seconds| *seconds > 0.0)
                    && metadata.get("videoDurationMs").is_none_or(Value::is_null)
                {
                    metadata.insert("videoDurationMs".into(), json!(duration_ms(seconds)));
                }
                // Fenced on the status the schedulability check read, or a
                // target published in that window is armed a second time.
                let scheduled = sqlite
                    .query_row(
                        r#"update "video_targets" set "scheduled_at" = ?, "status" = ?, "metadata_json" = ?, "last_error" = null, "delivery_provider" = ?, "provider_account_id" = ?, "updated_at" = ? where ("video_targets"."id" = ? and "video_targets"."status" = ?) returning "id""#,
                        params![
                            publish_at,
                            "scheduled",
                            crate::json::stringify_object(&metadata),
                            route.provider,
                            route.account_id,
                            now_iso,
                            target.id,
                            target.status
                        ],
                        |row| row.get::<_, i64>(0),
                    )
                    .optional()?;
                if scheduled.is_none() {
                    return Err(locked("err.video-target-not-schedulable"));
                }
                self.insert_video_job(video_draft_id, Some(target.id), VideoJobKind::Prepare, &prepared_at)?;
                self.insert_video_job(video_draft_id, Some(target.id), VideoJobKind::Publish, &publish_at)?;
            }
            let active: Vec<Option<String>> = sqlite
                .prepare(
                    r#"select "scheduled_at" from "video_targets" where ("video_targets"."video_draft_id" = ? and "video_targets"."status" <> ? and "video_targets"."status" <> ?)"#,
                )?
                .query_map(params![video_draft_id, "published", "cancelled"], |row| row.get(0))?
                .collect::<db::rusqlite::Result<_>>()?;
            // `Math.min` over a stored time that is no instant is NaN, and
            // writing it refuses the whole schedule: nothing is armed.
            let common = active
                .iter()
                .flatten()
                .filter(|at| !at.is_empty())
                .map(|at| parse_ms(at).ok_or_else(|| Error::message("Invalid Date")))
                .collect::<Result<Vec<i64>>>()?
                .into_iter()
                .min();
            sqlite.execute(
                r#"update "video_drafts" set "status" = ?, "scheduled_at" = ?, "retention_until" = null, "updated_at" = ? where "video_drafts"."id" = ?"#,
                params!["scheduled", common.map(iso_at), now_iso, video_draft_id],
            )?;
            Ok(())
        })
    }

    /// Requeues only an explicitly selected failed platform. A provider route
    /// is asked first: its report is not the account, and it has called a
    /// Reel failed that was live — exactly the state this button is pressed
    /// in. A new attempt is armed only if the answer is that the audience got
    /// nothing.
    pub async fn retry_video_target(
        &self,
        config: &Config,
        provider: &impl VideoProvider,
        video_draft_id: i64,
        target: VideoTarget,
    ) -> Result<VideoRetry> {
        let asked = self
            .ask_provider_before_retry(config, provider, video_draft_id, target)
            .await?;
        if let Some(status) = asked.filter(|status| status != "failed") {
            return Ok(VideoRetry { settled: Some(status) });
        }
        let row = video_target(self.sqlite, video_draft_id, target.as_str())?
            .filter(|row| is_audience_mutation_retryable(&row.status))
            .ok_or_else(|| locked("err.retry-only-failed"))?;
        let now_ms = self.now_ms();
        let now = iso_at(now_ms);
        // A delivery that carries what it already put on the platform is
        // continued; one that carries nothing starts over. A YouTube upload
        // survives a failed publish and is what the retry continues from.
        let external_id = row.external_id.clone().filter(|id| !id.is_empty());
        let continues_from_upload = target == VideoTarget::YoutubeShorts && external_id.is_some();
        let sqlite = self.sqlite;
        transaction(sqlite, || {
            let identity = if continues_from_upload {
                ""
            } else {
                r#", "external_id" = null, "external_url" = null, "prepared_at" = null"#
            };
            // Fenced on the retryable status read above.
            let requeued = sqlite
                .query_row(
                    &format!(
                        r#"update "video_targets" set "status" = ?{identity}, "last_error" = null, "updated_at" = ? where ("video_targets"."id" = ? and "video_targets"."status" = ?) returning "id""#
                    ),
                    params![
                        if continues_from_upload { "prepared" } else { "scheduled" },
                        now,
                        row.id,
                        row.status
                    ],
                    |found| found.get::<_, i64>(0),
                )
                .optional()?;
            if requeued.is_none() {
                return Err(locked("err.retry-only-failed"));
            }
            if !continues_from_upload {
                self.insert_video_job(video_draft_id, Some(row.id), VideoJobKind::Prepare, &now)?;
            }
            self.insert_video_job(
                video_draft_id,
                Some(row.id),
                VideoJobKind::Publish,
                &iso_at(now_ms + 60_000),
            )?;
            sqlite.execute(
                r#"update "video_drafts" set "status" = ?, "retention_until" = null, "updated_at" = ? where "video_drafts"."id" = ?"#,
                params!["scheduled", now, video_draft_id],
            )?;
            Ok(())
        })?;
        // The id this row named is now referenced by nothing; the journal is
        // the only record that object ever existed.
        if !continues_from_upload && let Some(external_id) = external_id {
            record_event(
                sqlite,
                self.clock,
                &DomainEventInput {
                    publication_ref: Some(publication_ref(PublicationRefKind::Video, video_draft_id)),
                    event_type: "publish.target.identity_dropped".into(),
                    severity: Severity::Warn,
                    target: Some(target.as_str().into()),
                    message: format!(
                        "{} was retried while it still named a live upload; that upload is no longer referenced",
                        target.as_str()
                    ),
                    details: Some(object(json!({
                        "external_id": external_id, "url": row.external_url, "provider_post_id": row.provider_post_id,
                    }))),
                    cooldown_seconds: None,
                },
            )?;
        }
        Ok(VideoRetry { settled: None })
    }

    /// What the provider says about the publication a retry is about to
    /// repeat, for the routes that can be asked.
    async fn ask_provider_before_retry(
        &self,
        config: &Config,
        provider: &impl VideoProvider,
        video_draft_id: i64,
        target: VideoTarget,
    ) -> Result<Option<String>> {
        let Some(row) = video_target(self.sqlite, video_draft_id, target.as_str())? else {
            return Ok(None);
        };
        if row.delivery_provider != "zernio" || row.provider_post_id.as_deref().is_none_or(str::is_empty) {
            return Ok(None);
        }
        // A target that already names its platform publication has been answered.
        if row.external_id.as_deref().is_some_and(|id| !id.is_empty())
            || row.external_url.as_deref().is_some_and(|url| !url.is_empty())
        {
            return Ok(None);
        }
        if !matches!(row.status.as_str(), "failed" | "verification_required") {
            return Ok(None);
        }
        let answer = self
            .settle_video_target(
                config,
                provider,
                &SettleVideoInput {
                    video_draft_id,
                    target: target.as_str(),
                    apply: true,
                    known: None,
                },
            )
            .await?;
        Ok(answer
            .get("status")
            .and_then(Value::as_str)
            .filter(|status| matches!(*status, "published" | "failed" | "verification_required"))
            .map(str::to_owned))
    }

    pub async fn validate_video_draft(
        &self,
        config: &Config,
        probe: &impl MediaProbe,
        video_draft_id: i64,
    ) -> Result<VideoTechnicalCheck> {
        let draft = self.get_video_draft(video_draft_id)?;
        let english = draft.locale == "en";
        let source =
            video_source_path(self.sqlite, draft.studio_media_asset_id)?.ok_or_else(|| locked("err.source-missing"))?;
        let set = |value: &Option<String>| value.as_deref().is_some_and(|value| !value.is_empty());
        for target in self.list_video_targets(video_draft_id)? {
            if target.target == "youtube_shorts" {
                let (id, secret, refresh) = if english {
                    (
                        &config.youtube_en_client_id,
                        &config.youtube_en_client_secret,
                        &config.youtube_en_refresh_token,
                    )
                } else {
                    (
                        &config.youtube_ru_client_id,
                        &config.youtube_ru_client_secret,
                        &config.youtube_ru_refresh_token,
                    )
                };
                if !set(id) || !set(secret) || !set(refresh) {
                    return Err(locked("err.youtube-not-configured"));
                }
            }
            if target.target == "instagram_reels" {
                let route =
                    self.video_delivery_route(VideoTarget::InstagramReels, if english { "en" } else { "ru" })?;
                if route.provider == "zernio" && (!set(&config.zernio_api_key) || !set(&route.account_id)) {
                    return Err(locked("err.instagram-not-configured"));
                }
                let (token, user) = if english {
                    (&config.instagram_en_access_token, &config.instagram_en_user_id)
                } else {
                    (&config.instagram_ru_access_token, &config.instagram_ru_user_id)
                };
                if route.provider == "native" && (!set(token) || !set(user)) {
                    return Err(locked("err.instagram-not-configured"));
                }
            }
        }
        validate_video_source(probe, &source).await
    }

    pub fn video_delivery_route(&self, target: VideoTarget, locale: &str) -> Result<VideoRoute> {
        let connection = channel_for_video(self.sqlite, target, locale)?
            .ok_or_else(|| Error::message(format!("Video channel is not connected: {}/{locale}", target.as_str())))?;
        Ok(VideoRoute {
            provider: if connection.connection.provider == "zernio" {
                "zernio"
            } else {
                "native"
            },
            account_id: connection.connection.provider_account_id.filter(|id| !id.is_empty()),
        })
    }

    pub fn cancel_video(&self, video_draft_id: i64, retention_hours: i64) -> Result<VideoCancellation> {
        let now = self.now();
        let now_ms = self.now_ms();
        let targets = self.list_video_targets(video_draft_id)?;
        let cancellation = VideoCancellation {
            manual_removal: targets
                .iter()
                .filter(|target| target.status == "published")
                .map(|target| (target.target.clone(), target.external_url.clone()))
                .collect(),
            hold_private_youtube_ids: targets
                .iter()
                .filter(|target| {
                    target.target == "youtube_shorts"
                        && target.status != "published"
                        && target.external_id.is_some()
                        && target
                            .scheduled_at
                            .as_deref()
                            .and_then(parse_ms)
                            .is_some_and(|at| at > now_ms)
                })
                .filter_map(|target| target.external_id.clone())
                .collect(),
        };
        let sqlite = self.sqlite;
        transaction(sqlite, || {
            let active = sqlite
                .query_row(
                    r#"select "id" from "video_jobs" where ("video_jobs"."video_draft_id" = ? and "video_jobs"."kind" in (?, ?) and "video_jobs"."status" = ?)"#,
                    params![video_draft_id, "prepare", "publish", "running"],
                    |row| row.get::<_, i64>(0),
                )
                .optional()?;
            if active.is_some() {
                return Err(locked("err.video-cancel-in-progress"));
            }
            sqlite.execute(
                r#"update "video_jobs" set "status" = ?, "locked_at" = null, "locked_by" = null, "updated_at" = ? where ("video_jobs"."video_draft_id" = ? and "video_jobs"."status" = ?)"#,
                params!["cancelled", now, video_draft_id, "queued"],
            )?;
            sqlite.execute(
                r#"update "video_targets" set "status" = ?, "updated_at" = ? where ("video_targets"."video_draft_id" = ? and "video_targets"."status" <> ?)"#,
                params!["cancelled", now, video_draft_id, "published"],
            )?;
            sqlite.execute(
                r#"update "video_drafts" set "status" = ?, "retention_until" = ?, "updated_at" = ? where "video_drafts"."id" = ?"#,
                params!["cancelled", self.retention_until(retention_hours), now, video_draft_id],
            )?;
            Ok(())
        })?;
        Ok(cancellation)
    }
}

/// The source file may still be swapped while every platform is only holding
/// metadata. From "prepared" on, a platform already has the bytes.
pub fn is_video_source_replaceable(draft_status: &str, target_statuses: &[&str]) -> bool {
    matches!(draft_status, "draft" | "editing" | "scheduled")
        && target_statuses
            .iter()
            .all(|status| is_video_target_metadata_editable(status))
}

/// Everything the technical check can say about a file on its own: the same
/// gate a replacement source passes before it is adopted.
pub async fn validate_video_source(probe: &impl MediaProbe, source: &str) -> Result<VideoTechnicalCheck> {
    let is_mp4 = std::path::Path::new(source)
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("mp4"));
    if !is_mp4 {
        return Err(locked("err.need-mp4"));
    }
    let size = std::fs::metadata(source)
        .map_err(|error| Error::message(error.to_string()))?
        .len();
    if size == 0 {
        return Err(locked("err.video-empty"));
    }
    if size > VIDEO_MAX_BYTES {
        return Err(StudioError::new("err.video-too-big")
            .with_param("size", size.div_ceil(1024 * 1024))
            .with_param("limit", VIDEO_MAX_BYTES / 1024 / 1024)
            .into());
    }
    let metadata = probe.probe(source).await.map_err(|message| {
        locked(if message.contains("did not find a video stream") {
            "err.no-video-stream"
        } else {
            "err.ffprobe-failed"
        })
    })?;
    Ok(VideoTechnicalCheck {
        width: metadata.width,
        height: metadata.height,
        seconds: (metadata.duration_seconds + 0.5).floor(),
        aspect_ok: (metadata.width / metadata.height - 9.0 / 16.0).abs() <= 0.02,
        background_music_likely_missing: background_music_likely_missing(
            probe,
            source,
            metadata.audio_codec.as_deref(),
        )
        .await,
        video_codec: metadata.video_codec,
        audio_codec: metadata.audio_codec,
        fps: metadata.fps,
        size_bytes: size,
    })
}

#[cfg(test)]
mod tests {
    use super::opening_line;

    #[test]
    fn opening_line_drops_pronunciation_and_reads_the_hook() {
        assert_eq!(
            opening_line("Capcom (Кáпком) is back.\n\nSecond paragraph", "operator"),
            "Capcom is back."
        );
        assert_eq!(
            opening_line("one two three four five. six", "transcript"),
            "one two three four five."
        );
        assert_eq!(opening_line("short", "transcript"), "short");
    }
}
