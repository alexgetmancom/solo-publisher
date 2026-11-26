//! Commands for post drafts, with draft creation and the Story-media trigger.
//! Transport-free: the single entry point for Telegram, MCP and the CLI.

use content::Locale;
use content::draft_content::draft_locale_content;
use content::message::{DraftMessage, Entity, MediaItem};
use content::text::split_text;
use content::title_emphasis::emphasize_title;
use content::translation::translation_wanted;
use foundation::errors::StudioError;
use foundation::js::string_of;
use foundation::json::json_record_array;
use foundation::time::Zone;
use jiff::Timestamp;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::application::conversation_flow::PublicationKind;
use crate::application::ports::{
    DomainEventInput, DraftEntityCandidate, DraftPatch, DraftRecord, IssueStatus, NewDraft, NewThreadPart,
    PostEventRecord, Severity, StoryPublishMode, StudioMediaAssetRecord,
};
use crate::application::publication_pipeline::{
    Issue, PreviewModel, PublicationCapabilities, PublicationPipeline, PublicationRetrySummary, PublicationSchedule,
    PublicationScheduleAxis, PublicationView,
};
use crate::application::publication_ref::{PublicationRefKind, publication_ref};
use crate::channels::{
    channel_upload_limits, effective_post_targets, post_locales, publishes_story, registered_post_target_ids,
};
use crate::json::stringify;
use crate::publishing::abandon::{AbandonOutcome, AbandonResult};
use crate::publishing::article_publish::{PublishArticleInput, PublishedArticle};
use crate::publishing::boundaries::StoryCardState;
use crate::publishing::cancellation::{CancellationReport, PendingTarget};
use crate::publishing::chain_plan::{draft_content, planned_target_deliveries};
use crate::publishing::extra_delivery::ExtraDeliveryScope;
use crate::publishing::media_policy::{MediaPolicy, media_policy_for_target};
use crate::publishing::platform_profiles::platform_profile;
use crate::publishing::preflight::{PublicationPreflightIssue, publication_preflight};
use crate::publishing::publication_plan::PublishMode;
use crate::publishing::publication_workflow::PublishDraftOptions;
use crate::publishing::requeue::{
    AudienceReached, RequeueOptions, RequeueOutcome, RequeueRefusal, RequeueResult, RequeueScope,
};
use crate::publishing::schedule::{assert_future_schedule, parse_manual_schedule, publication_slot_time};
use crate::publishing::scheduled_draft_mutation::ScheduledDraftMutation;
use crate::publishing::state::{AUDIENCE_MUTATION_RETRYABLE_STATUSES, is_post_target_retryable};
use crate::publishing::threads_text::threads_text_limit;
use crate::studio::Studio;
use crate::studio::boundaries::{Reminder, ReminderPolicy};
use crate::studio::projections::{PostDeliveryProjections, post_delivery_projections};
use crate::targets::{
    PublicationForm, TARGETS, TargetKind, TargetMap, is_site_target, preset, preset_name, target_locale, targets_for,
    targets_record,
};
use crate::{Error, Result};

use super::post_access::{draft_media, require_mutable_draft, require_owned_draft, require_post_edit_allowed};
use super::post_progress::{PostProgressState, post_progress_state};
use super::settings::SettingsService;

/// A content edit for one language.
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EditInput {
    #[serde(with = "crate::json::locale")]
    pub locale: Locale,
    #[serde(default)]
    pub text: String,
    #[serde(default)]
    pub entities: Vec<Entity>,
    #[serde(default)]
    pub media: Vec<MediaItem>,
    #[serde(default)]
    pub replace_media_only: bool,
    /// The caller has already recognized an explicit "clear media" command
    /// in its own transport.
    #[serde(default)]
    pub clear_media: bool,
}

/// The exact targets (and Story mode) a draft is created with, instead of
/// the Studio's defaults.
#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftConfiguration {
    pub targets: Vec<String>,
    #[serde(default)]
    pub story_mode: Option<StoryPublishMode>,
}

fn serialize_optional_instant<S: serde::Serializer>(
    at: &Option<Timestamp>,
    serializer: S,
) -> std::result::Result<S::Ok, S::Error> {
    match at {
        Some(at) => serializer.serialize_str(&foundation::time::to_iso_string(*at)),
        None => serializer.serialize_none(),
    }
}

fn is_false(value: &bool) -> bool {
    !value
}

/// When each language of a post goes out.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PostScheduleInput {
    #[serde(serialize_with = "serialize_optional_instant")]
    pub ru_at: Option<Timestamp>,
    #[serde(serialize_with = "serialize_optional_instant")]
    pub en_at: Option<Timestamp>,
    #[serde(skip_serializing_if = "is_false")]
    pub allow_past: bool,
    #[serde(skip_serializing_if = "Option::is_none", with = "crate::json::optional_locale")]
    pub immediate_locale: Option<Locale>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PostScheduleScope {
    Ru,
    En,
    Both,
}

/// One language of a preview: what it receives at delivery time.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalePreview {
    #[serde(with = "crate::json::locale")]
    pub locale: Locale,
    pub text: String,
    pub entities: Vec<Entity>,
    pub media: Vec<MediaItem>,
    pub own_media: Vec<MediaItem>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PostPreview {
    pub id: i64,
    pub status: String,
    pub issues: Vec<PublicationPreflightIssue>,
    pub locales: Vec<LocalePreview>,
    pub targets: TargetMap,
    pub media_policy: Vec<MediaPolicy>,
    pub delivery: PostDeliveryProjections,
    pub story_cards: Vec<StoryCardState>,
}

/// What one threaded platform will be sent.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct ThreadDeliveryPlan {
    pub label: String,
    pub posts: usize,
    pub chained: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PostRetry {
    pub results: Vec<RequeueResult>,
    pub requeued: usize,
    pub already_queued: usize,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct PostSkip {
    pub results: Vec<AbandonResult>,
    pub abandoned: usize,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct ResendableTarget {
    pub target: &'static str,
    pub label: &'static str,
    #[serde(with = "crate::json::locale")]
    pub locale: Locale,
}

fn json_text(value: &impl Serialize) -> String {
    stringify(&serde_json::to_value(value).expect("serializable"))
}

fn draft_ref(draft_id: i64) -> String {
    publication_ref(PublicationRefKind::Draft, draft_id)
}

fn post_ref(post_id: i64) -> String {
    publication_ref(PublicationRefKind::Post, post_id)
}

fn event(publication_ref: String, event_type: &str, message: String, details: Value) -> DomainEventInput {
    let Value::Object(details) = details else {
        unreachable!("details are built as an object")
    };
    DomainEventInput {
        publication_ref: Some(publication_ref),
        event_type: event_type.into(),
        severity: Severity::Info,
        target: None,
        message,
        details: Some(details),
        cooldown_seconds: None,
    }
}

/// A persisted schedule column as an instant; unset or unparsable is no schedule.
fn scheduled_date(value: Option<&str>) -> Option<Timestamp> {
    value
        .filter(|value| !value.is_empty())
        .and_then(|value| foundation::time::parse_iso_instant(value).ok())
}

fn is_story_publish_mode(draft: &DraftRecord) -> bool {
    matches!(draft.story_publish_mode.as_deref(), Some("all" | "site_only"))
}

fn issue_status(status: IssueStatus) -> &'static str {
    match status {
        IssueStatus::Failed => "failed",
        IssueStatus::VerificationRequired => "verification_required",
    }
}

/// One written post as the thread posts it makes: split at the Threads
/// budget, its links kept where they still fit the first piece, its media on
/// that piece.
fn thread_posts(part: &NewThreadPart) -> Vec<NewThreadPart> {
    split_text(foundation::js::trim(&part.text_ru), threads_text_limit("threads_ru"))
        .into_iter()
        .enumerate()
        .map(|(index, text_ru)| {
            let length = text_ru.encode_utf16().count() as f64;
            NewThreadPart {
                entities_ru: if index == 0 {
                    part.entities_ru
                        .iter()
                        .filter(|entity| {
                            foundation::js::number_of_scalar(entity.get("offset"))
                                + foundation::js::number_of_scalar(entity.get("length"))
                                <= length
                        })
                        .cloned()
                        .collect()
                } else {
                    Vec::new()
                },
                media: if index == 0 { part.media.clone() } else { Vec::new() },
                text_ru,
                text_en: None,
                text_en_approved: None,
            }
        })
        .collect()
}

/// An existing post of the thread as it is rewritten back, English included:
/// rewriting one post used to drop the English of every other.
fn new_thread_part(part: &content::thread::ThreadPart) -> NewThreadPart {
    NewThreadPart {
        text_ru: part.text_ru.clone(),
        entities_ru: part.entities_ru.clone(),
        media: part.media.clone(),
        text_en: part.text_en.clone(),
        text_en_approved: part.text_en_approved.clone(),
    }
}

fn schedule_at(draft: &DraftRecord, scope: PostScheduleScope, value: Timestamp) -> PostScheduleInput {
    PostScheduleInput {
        ru_at: if scope == PostScheduleScope::En {
            scheduled_date(draft.scheduled_at.as_deref())
        } else {
            Some(value)
        },
        en_at: if scope == PostScheduleScope::Ru {
            scheduled_date(draft.scheduled_en_at.as_deref())
        } else {
            Some(value)
        },
        allow_past: false,
        immediate_locale: None,
    }
}

/// Why the queue would not take an extra delivery, in the words the operator
/// needs: each refusal is a different thing to do next.
fn resend_refusal(result: &RequeueResult) -> Error {
    let code = match result.reason {
        Some(RequeueRefusal::AlreadyDelivered) => "err.resend-already",
        _ if result.outcome == RequeueOutcome::AlreadyQueued => "err.resend-already",
        Some(RequeueRefusal::Empty) => "err.resend-empty",
        Some(RequeueRefusal::Language) => "err.resend-language",
        None => "err.resend-refused",
    };
    StudioError::new(code).into()
}

#[derive(Clone, Copy)]
pub struct PostService<'a> {
    studio: Studio<'a>,
}

impl<'a> PostService<'a> {
    pub fn new(studio: Studio<'a>) -> Self {
        Self { studio }
    }

    pub fn kind(&self) -> PublicationKind {
        PublicationKind::Post
    }

    pub fn capabilities(&self) -> PublicationCapabilities {
        PublicationCapabilities {
            schedule_axis: PublicationScheduleAxis::Locale,
        }
    }

    fn owned(&self, actor_id: i64, draft_id: i64) -> Result<DraftRecord> {
        require_owned_draft(self.studio.ports(), self.studio.config, actor_id, draft_id)
    }

    fn mutable(&self, actor_id: i64, draft_id: i64) -> Result<DraftRecord> {
        require_mutable_draft(self.studio.ports(), self.studio.config, actor_id, draft_id)
    }

    fn editable(&self, actor_id: i64, draft_id: i64, locale: Option<Locale>) -> Result<DraftRecord> {
        require_post_edit_allowed(
            self.studio.ports(),
            self.studio.config,
            actor_id,
            draft_id,
            self.studio.now(),
            locale,
        )
    }

    fn effective_targets(&self, targets_json: &str) -> Result<TargetMap> {
        effective_post_targets(self.studio.sqlite(), &TargetMap::parse(Some(targets_json)))
    }

    fn effective_draft(&self, draft: &DraftRecord) -> Result<DraftRecord> {
        Ok(DraftRecord {
            targets_json: self.effective_targets(&draft.targets_json)?.to_json(),
            ..draft.clone()
        })
    }

    fn translation_wanted(&self, text: &str) -> Result<bool> {
        let has_translator = self
            .studio
            .config
            .deepseek_api_key
            .as_deref()
            .is_some_and(|key| !key.is_empty());
        Ok(translation_wanted(
            text,
            has_translator,
            post_locales(self.studio.sqlite())?.contains(&Locale::En),
        ))
    }

    fn assert_known_target(&self, target: &str) -> Result<()> {
        if !TARGETS.iter().any(|definition| definition.id == target)
            || !registered_post_target_ids(self.studio.sqlite())?
                .iter()
                .any(|id| id == target)
        {
            return Err(StudioError::new("err.unknown-target").into());
        }
        Ok(())
    }

    fn exact_targets(&self, selected: &[String]) -> Result<TargetMap> {
        let mut unique: Vec<&str> = Vec::new();
        for target in selected {
            if !unique.contains(&target.as_str()) {
                unique.push(target);
            }
        }
        for target in &unique {
            self.assert_known_target(target)?;
        }
        Ok(targets_record(&unique, PublicationForm::Post))
    }

    /// `prepareDraftStoryMedia`: starts the Story shapes of a draft's media
    /// for a draft that is going to a Story. Called wherever its media or
    /// targets change, so turning a Story target on starts the encode while
    /// the author is still writing.
    fn prepare_draft_story_media(&self, draft_id: i64) -> Result<()> {
        let Some(draft) = self.studio.ports().drafts().get(draft_id)? else {
            return Ok(());
        };
        if !publishes_story(self.studio.sqlite(), &draft.targets_json)? {
            return Ok(());
        }
        let media = json_record_array(draft.media_ru_json.as_deref())
            .into_iter()
            .chain(json_record_array(draft.media_en_json.as_deref()));
        for item in media {
            let local_path = item
                .get("local_path")
                .and_then(Value::as_str)
                .or_else(|| item.get("localPath").and_then(Value::as_str));
            let Some(local_path) = local_path else { continue };
            let kind = match item.get("type") {
                None | Some(Value::Null) => String::new(),
                Some(kind) => string_of(kind),
            };
            self.studio.boundaries.story_derivatives.ensure(
                local_path,
                kind.to_lowercase().contains("video"),
                draft_id,
            );
        }
        Ok(())
    }

    /// `createDraftFromMessage`: the content aggregate of a draft before it
    /// enters a publication plan.
    fn create_draft_from_message(
        &self,
        actor_id: i64,
        message: &DraftMessage,
        configured: Option<(TargetMap, Option<StoryPublishMode>)>,
    ) -> Result<i64> {
        let ports = self.studio.ports();
        let (targets, story_publish_mode) = match configured {
            Some(configured) => configured,
            None => {
                let defaults = ports.studio_settings().profile()?.default_targets_json;
                (
                    targets_record(
                        &defaults.iter().map(String::as_str).collect::<Vec<_>>(),
                        PublicationForm::Post,
                    ),
                    None,
                )
            }
        };
        let draft_id = ports.drafts().create(&NewDraft {
            actor_id,
            text_ru: message.text.clone(),
            text_en_machine: message.text_en.clone(),
            text_en_approved: message.text_en_approved.clone(),
            targets_json: targets.to_json(),
            media_ru_json: (!message.media.is_empty()).then(|| json_text(&message.media)),
            text_ru_entities_json: json_text(&emphasize_title(&message.text, &message.entities)),
            story_publish_mode,
        })?;
        ports.events().record(&event(
            draft_ref(draft_id),
            "content.draft.created",
            format!("Draft #{draft_id} created"),
            json!({ "owner_id": actor_id, "media_count": message.media.len() }),
        ))?;
        self.studio
            .publishing
            .boundaries
            .story_cards
            .queue(self.studio.sqlite(), draft_id)?;
        Ok(draft_id)
    }

    /// Every transport creates drafts through here, so the languages this
    /// Studio publishes are checked once: English copy for a Studio with no
    /// English channel is refused instead of stored where nothing publishes it.
    pub fn create(
        &self,
        actor_id: i64,
        message: &DraftMessage,
        configured: Option<&DraftConfiguration>,
    ) -> Result<i64> {
        self.studio.track("studio.post.create", || {
            let has = |text: &Option<String>| text.as_deref().is_some_and(|text| !text.is_empty());
            let brings_english = has(&message.text_en) || has(&message.text_en_approved);
            if brings_english && !post_locales(self.studio.sqlite())?.contains(&Locale::En) {
                return Err(StudioError::new("err.post-locale-not-served")
                    .with_param("locale", "EN")
                    .into());
            }
            let configured = configured
                .map(|configured| -> Result<_> {
                    Ok((self.exact_targets(&configured.targets)?, configured.story_mode))
                })
                .transpose()?;
            let draft_id = self.create_draft_from_message(actor_id, message, configured)?;
            // English the draft did not arrive with is made after it exists,
            // never while the operator waits for the card.
            if !brings_english && self.translation_wanted(&message.text)? {
                self.studio.ports().draft_translations().queue(draft_id)?;
            }
            self.prepare_draft_story_media(draft_id)?;
            Ok(draft_id)
        })
    }

    pub fn get(&self, actor_id: i64, draft_id: i64) -> Result<DraftRecord> {
        self.owned(actor_id, draft_id)
    }

    /// `limit` defaults to 50.
    pub fn list(&self, actor_id: i64, limit: Option<i64>) -> Result<Vec<DraftRecord>> {
        self.studio
            .ports()
            .drafts()
            .list(&self.studio.accessible_actor_ids(actor_id), limit.unwrap_or(50))
    }

    pub fn validate(&self, actor_id: i64, draft_id: i64) -> Result<Vec<PublicationPreflightIssue>> {
        let draft = self.owned(actor_id, draft_id)?;
        Ok(publication_preflight(
            &self.effective_draft(&draft)?,
            &channel_upload_limits(self.studio.sqlite())?,
        ))
    }

    pub fn preview(&self, actor_id: i64, draft_id: i64) -> Result<PostPreview> {
        let draft = self.owned(actor_id, draft_id)?;
        let source = draft_content(&draft);
        let (ru, en) = (
            draft_locale_content(&source, Locale::Ru),
            draft_locale_content(&source, Locale::En),
        );
        let story_cards = self
            .studio
            .publishing
            .boundaries
            .story_cards
            .for_draft(self.studio.sqlite(), draft_id)?;
        // Ready means every card this draft actually has is rendered: a locale
        // with no text has none, and a one-language Studio never has the other.
        let story_cards_ready = !story_cards.is_empty()
            && story_cards
                .iter()
                .all(|card| card.status == "ready" && card.local_path.as_deref().is_some_and(|path| !path.is_empty()));
        let targets = self.effective_targets(&draft.targets_json)?;
        let effective = DraftRecord {
            targets_json: targets.to_json(),
            ..draft.clone()
        };
        let media_values = |content: &content::draft_content::DraftLocaleContent| -> Vec<Value> {
            content.media.iter().cloned().map(Value::Object).collect()
        };
        let media_policy = targets
            .enabled()
            .map(|target| {
                let media = if target_locale(target) == Some(Locale::Ru) {
                    media_values(&ru)
                } else {
                    media_values(&en)
                };
                media_policy_for_target(target, &media)
            })
            .collect();
        Ok(PostPreview {
            id: draft.id,
            status: draft.status.clone(),
            issues: publication_preflight(&effective, &channel_upload_limits(self.studio.sqlite())?),
            delivery: post_delivery_projections(&draft, story_cards_ready),
            locales: [(Locale::Ru, ru), (Locale::En, en)]
                .into_iter()
                .map(|(locale, content)| LocalePreview {
                    locale,
                    text: content.text,
                    entities: content.entities,
                    media: content.media,
                    own_media: content.own_media,
                })
                .collect(),
            targets,
            media_policy,
            story_cards,
        })
    }

    pub fn progress(&self, actor_id: i64, draft_id: i64) -> Result<PostProgressState> {
        let draft = self.owned(actor_id, draft_id)?;
        post_progress_state(&self.studio, draft.id)
    }

    /// `limit` defaults to 50.
    pub fn history(&self, actor_id: i64, draft_id: i64, limit: Option<i64>) -> Result<Vec<PostEventRecord>> {
        let draft = self.owned(actor_id, draft_id)?;
        self.studio
            .ports()
            .studio_posts()
            .history(draft.id, draft.post_id, limit.unwrap_or(50))
    }

    /// `limit` defaults to 50.
    pub fn media_assets(&self, actor_id: i64, limit: Option<i64>) -> Result<Vec<StudioMediaAssetRecord>> {
        self.studio
            .ports()
            .studio_media_assets()
            .list(&self.studio.accessible_actor_ids(actor_id), limit.unwrap_or(50))
    }

    pub fn attach_media_assets(
        &self,
        actor_id: i64,
        draft_id: i64,
        locale: Locale,
        asset_ids: &[i64],
        replace: bool,
    ) -> Result<()> {
        let draft = self.editable(actor_id, draft_id, None)?;
        let assets = self
            .studio
            .ports()
            .studio_media_assets()
            .require(&self.studio.accessible_actor_ids(actor_id), asset_ids)?;
        let mut media = if replace {
            Vec::new()
        } else {
            draft_media(&draft, locale)
        };
        media.extend(assets.into_iter().map(|asset| {
            let Value::Object(item) = json!({
                "type": asset.asset.kind, "assetId": asset.id, "localPath": asset.asset.local_path,
                "filename": asset.asset.filename, "mimeType": asset.asset.mime_type,
            }) else {
                unreachable!("built as an object")
            };
            item
        }));
        let patch = self.media_patch(locale, Some(json_text(&media)));
        let event = event(
            draft_ref(draft_id),
            "content.draft.media_attached",
            format!("Draft #{draft_id} media attached"),
            json!({ "locale": locale.as_str(), "asset_ids": asset_ids, "replace": replace }),
        );
        self.save_content_mutation(&draft, &patch, event)
    }

    /// Matches media by their `asset_id` field.
    pub fn remove_media(&self, actor_id: i64, draft_id: i64, locale: Locale, asset_ids: &[i64]) -> Result<()> {
        let draft = self.editable(actor_id, draft_id, None)?;
        let media: Vec<MediaItem> = draft_media(&draft, locale)
            .into_iter()
            .filter(|item| {
                let id = foundation::js::number_of_scalar(item.get("asset_id"));
                !asset_ids.iter().any(|removed| *removed as f64 == id)
            })
            .collect();
        let patch = self.media_patch(locale, Some(json_text(&media)));
        let event = event(
            draft_ref(draft_id),
            "content.draft.media_removed",
            format!("Draft #{draft_id} media removed"),
            json!({ "locale": locale.as_str(), "asset_ids": asset_ids }),
        );
        self.save_content_mutation(&draft, &patch, event)
    }

    fn media_patch(&self, locale: Locale, media: Option<String>) -> DraftPatch {
        let mut patch = DraftPatch {
            updated_at: Some(foundation::time::to_iso_string(self.studio.now())),
            ..DraftPatch::default()
        };
        match locale {
            Locale::Ru => patch.media_ru_json = Some(media),
            Locale::En => patch.media_en_json = Some(media),
        }
        patch
    }

    pub fn schedule(&self, actor_id: i64, draft_id: i64, input: &PostScheduleInput) -> Result<i64> {
        self.studio
            .track("studio.post.schedule", || self.schedule_post(actor_id, draft_id, input))
    }

    pub fn has_locale_targets(&self, actor_id: i64, draft_id: i64, locale: Locale) -> Result<bool> {
        let draft = self.owned(actor_id, draft_id)?;
        Ok(self
            .effective_targets(&draft.targets_json)?
            .enabled()
            .any(|target| target_locale(target) == Some(locale)))
    }

    fn zone(&self, actor_id: i64) -> Result<Zone> {
        let timezone = SettingsService::new(self.studio.ports())
            .time_config(actor_id)?
            .timezone;
        Zone::parse(&timezone).ok_or_else(|| Error::message(format!("Invalid time zone: {timezone}")))
    }

    /// A slot-button clock (`HH:MM` in the Studio zone) at its next occurrence.
    pub fn slot_time(&self, actor_id: i64, clock: &str) -> Result<Timestamp> {
        publication_slot_time(clock, &self.zone(actor_id)?, self.studio.now())
    }

    pub fn manual_schedule(
        &self,
        actor_id: i64,
        draft_id: i64,
        scope: PostScheduleScope,
        value: &str,
    ) -> Result<PostScheduleInput> {
        let zone = self.zone(actor_id)?;
        let draft = self.owned(actor_id, draft_id)?;
        Ok(schedule_at(
            &draft,
            scope,
            parse_manual_schedule(value, &zone, self.studio.now())?,
        ))
    }

    pub fn schedule_at(
        &self,
        actor_id: i64,
        draft_id: i64,
        scope: PostScheduleScope,
        value: Timestamp,
    ) -> Result<PostScheduleInput> {
        Ok(schedule_at(&self.owned(actor_id, draft_id)?, scope, value))
    }

    pub fn cancel(&self, actor_id: i64, draft_id: i64) -> Result<()> {
        self.studio.track("studio.post.cancel", || {
            let draft = self.mutable(actor_id, draft_id)?;
            self.studio.publishing.cancel_draft(draft_id, actor_id)?;
            if let Some(post_id) = draft.post_id {
                self.studio
                    .boundaries
                    .reminders
                    .cancel(self.studio.sqlite(), &post_ref(post_id))?;
            }
            Ok(())
        })
    }

    /// What each platform that carries a thread will actually receive: the
    /// posts delivery sends, cut where delivery cuts them.
    pub fn delivery_plan(&self, actor_id: i64, draft_id: i64) -> Result<Vec<ThreadDeliveryPlan>> {
        let draft = self.owned(actor_id, draft_id)?;
        Ok(planned_target_deliveries(&self.effective_draft(&draft)?)
            .into_iter()
            .filter(|delivery| platform_profile(&delivery.target).is_some_and(|profile| profile.thread.is_some()))
            .map(|delivery| ThreadDeliveryPlan {
                label: delivery.label,
                posts: delivery.posts.len(),
                chained: delivery.chained,
            })
            .collect())
    }

    /// The targets a "cancel the rest" would act on, for the confirmation
    /// that has to name them before the operator taps.
    pub fn pending_targets(&self, actor_id: i64, draft_id: i64) -> Result<Vec<PendingTarget>> {
        self.owned(actor_id, draft_id)?;
        self.studio.publishing.pending_delivery_targets(draft_id)
    }

    pub fn cancel_remaining(&self, actor_id: i64, draft_id: i64) -> Result<CancellationReport> {
        let draft = self.owned(actor_id, draft_id)?;
        let report = self.studio.publishing.cancel_remaining_delivery(draft_id, actor_id)?;
        if let Some(post_id) = draft.post_id {
            self.studio
                .boundaries
                .reminders
                .cancel(self.studio.sqlite(), &post_ref(post_id))?;
        }
        Ok(report)
    }

    pub fn set_story_publish_mode(&self, actor_id: i64, draft_id: i64, mode: StoryPublishMode) -> Result<()> {
        self.editable(actor_id, draft_id, None)?;
        self.studio
            .publishing
            .boundaries
            .story_cards
            .set_publish_mode(self.studio.sqlite(), draft_id, mode)?;
        self.replan_scheduled_post_after_mutation(draft_id).map(drop)
    }

    pub fn replace_entity_candidates(
        &self,
        actor_id: i64,
        draft_id: i64,
        candidates: &[DraftEntityCandidate],
    ) -> Result<()> {
        self.editable(actor_id, draft_id, None)?;
        self.studio.ports().studio_posts().replace_entity_candidates(
            draft_id,
            candidates,
            &foundation::time::to_iso_string(self.studio.now()),
        )?;
        self.replan_scheduled_post_after_mutation(draft_id).map(drop)
    }

    pub fn accept_entity_candidates(&self, actor_id: i64, draft_id: i64) -> Result<()> {
        self.editable(actor_id, draft_id, None)?;
        self.studio
            .ports()
            .studio_posts()
            .accept_entity_candidates(draft_id, &foundation::time::to_iso_string(self.studio.now()))?;
        self.replan_scheduled_post_after_mutation(draft_id).map(drop)
    }

    /// Every thread change leaves the English stale and the plan out of date.
    fn thread_changed(&self, draft_id: i64, event_type: &str, message: String) -> Result<()> {
        let ports = self.studio.ports();
        let text = ports
            .drafts()
            .get(draft_id)?
            .map(|draft| draft.text_ru)
            .unwrap_or_default();
        if self.translation_wanted(&text)? {
            ports.draft_translations().queue(draft_id)?;
        }
        self.replan_scheduled_post_after_mutation(draft_id)?;
        ports
            .events()
            .record(&event(draft_ref(draft_id), event_type, message, json!({})))?;
        Ok(())
    }

    /// Splits a long post into a thread at the Threads limit. The media stays
    /// on the first post; the rest of the text becomes the parts after it.
    pub fn make_thread(&self, actor_id: i64, draft_id: i64) -> Result<()> {
        let draft = self.editable(actor_id, draft_id, None)?;
        let mut posts = thread_posts(&NewThreadPart {
            text_ru: draft.text_ru.clone(),
            entities_ru: json_record_array(draft.text_ru_entities_json.as_deref()),
            ..NewThreadPart::default()
        });
        if posts.len() < 2 {
            return Err(StudioError::new("err.thread-too-short").into());
        }
        let rest = posts.split_off(1);
        let first = posts.remove(0);
        let ports = self.studio.ports();
        ports.drafts().update(
            draft_id,
            &DraftPatch {
                text_ru: Some(first.text_ru),
                text_ru_entities_json: Some(Some(json_text(&first.entities_ru))),
                text_en_approved: Some(None),
                updated_at: Some(foundation::time::to_iso_string(self.studio.now())),
                ..DraftPatch::default()
            },
        )?;
        let count = rest.len() + draft.thread.len() + 1;
        // The overflow goes right after the first post, ahead of any posts
        // the thread already had.
        let parts: Vec<NewThreadPart> = rest
            .into_iter()
            .chain(draft.thread.iter().map(new_thread_part))
            .collect();
        ports.thread_parts().replace(draft_id, &parts)?;
        self.thread_changed(
            draft_id,
            "content.draft.thread-made",
            format!("Draft #{draft_id} became a thread of {count} posts"),
        )
    }

    /// A post over the Threads budget becomes as many posts as it takes, the
    /// media staying with the first of them. Returns the last position written.
    pub fn append_thread_part(&self, actor_id: i64, draft_id: i64, part: &NewThreadPart) -> Result<i64> {
        self.editable(actor_id, draft_id, None)?;
        let posts = thread_posts(part);
        if posts.is_empty() {
            return Err(StudioError::new("err.thread-part-empty").into());
        }
        let mut position = 0;
        for post in &posts {
            position = self.studio.ports().thread_parts().append(draft_id, post)?;
        }
        self.thread_changed(
            draft_id,
            "content.draft.thread-part-added",
            format!("Draft #{draft_id} gained thread post {position}"),
        )?;
        Ok(position)
    }

    pub fn edit_thread_part(&self, actor_id: i64, draft_id: i64, position: i64, part: &NewThreadPart) -> Result<()> {
        let draft = self.editable(actor_id, draft_id, None)?;
        let posts = thread_posts(part);
        if posts.is_empty() {
            return Err(StudioError::new("err.thread-part-empty").into());
        }
        if !draft.thread.iter().any(|existing| existing.position == position) {
            return Err(StudioError::new("err.thread-part-missing").into());
        }
        let parts: Vec<NewThreadPart> = draft
            .thread
            .iter()
            .flat_map(|existing| {
                if existing.position == position {
                    posts.clone()
                } else {
                    vec![new_thread_part(existing)]
                }
            })
            .collect();
        self.studio.ports().thread_parts().replace(draft_id, &parts)?;
        self.thread_changed(
            draft_id,
            "content.draft.thread-part-edited",
            format!("Draft #{draft_id} thread post {position} edited"),
        )
    }

    /// English the author wrote for one post of the thread. It is theirs, so
    /// no later translation pass overwrites it, and it is not queued for one.
    pub fn edit_thread_part_english(&self, actor_id: i64, draft_id: i64, position: i64, text_en: &str) -> Result<()> {
        self.editable(actor_id, draft_id, None)?;
        let text = foundation::js::trim(text_en);
        if text.is_empty() {
            return Err(StudioError::new("err.thread-part-empty").into());
        }
        let ports = self.studio.ports();
        if !ports.thread_parts().approve_english(draft_id, position, text)? {
            return Err(StudioError::new("err.thread-part-missing").into());
        }
        self.replan_scheduled_post_after_mutation(draft_id)?;
        ports.events().record(&event(
            draft_ref(draft_id),
            "content.draft.thread-part-edited",
            format!("Draft #{draft_id} thread post {position} English edited"),
            json!({ "locale": "en", "position": position }),
        ))?;
        Ok(())
    }

    pub fn remove_thread_part(&self, actor_id: i64, draft_id: i64, position: i64) -> Result<()> {
        self.editable(actor_id, draft_id, None)?;
        if !self.studio.ports().thread_parts().remove(draft_id, position)? {
            return Err(StudioError::new("err.thread-part-missing").into());
        }
        self.thread_changed(
            draft_id,
            "content.draft.thread-part-removed",
            format!("Draft #{draft_id} lost thread post {position}"),
        )
    }

    /// The one article path, so no surface publishes articles on its own.
    pub fn publish_article(&self, actor_id: i64, input: &PublishArticleInput<'_>) -> Result<PublishedArticle> {
        self.studio.track("studio.post.publish-article", || {
            // Same boundary every other command here checks: one
            // installation, one roster of Studio actors.
            if !self.studio.can_access(actor_id, actor_id) {
                return Err(StudioError::new("err.not-yours").into());
            }
            self.studio.publishing.publish_article(self.studio.config, input)
        })
    }

    pub fn publish(&self, actor_id: i64, draft_id: i64) -> Result<i64> {
        self.studio.track("studio.post.publish", || {
            self.mutable(actor_id, draft_id)?;
            self.studio
                .publishing
                .publish_draft_to_queue(draft_id, PublishDraftOptions::default())
        })
    }

    /// Requeues the failed targets (or the one named) that may be retried.
    pub fn retry_target(&self, actor_id: i64, draft_id: i64, target: Option<&str>) -> Result<PostRetry> {
        self.studio.track("studio.post.retry", || {
            let draft = self.owned(actor_id, draft_id)?;
            let post_id = draft
                .post_id
                .ok_or_else(|| Error::from(StudioError::new("err.retry-only-failed")))?;
            let selected: Vec<String> = self
                .studio
                .ports()
                .studio_posts()
                .failed_publication_targets(post_id)?
                .into_iter()
                .filter(|item| is_post_target_retryable(&item.target, issue_status(item.status), item.error.as_deref()))
                .filter(|item| target.is_none_or(|target| item.target == target))
                .map(|item| item.target)
                .collect();
            if selected.is_empty() {
                return Err(StudioError::new("err.retry-only-failed").into());
            }
            let publishing = &self.studio.publishing;
            let source = || publishing.publication_source_from_db(post_id);
            let results = publishing.requeue_publication_targets(
                &RequeueScope {
                    post_id: Some(post_id),
                    publication_key: post_ref(post_id),
                },
                &selected.iter().map(String::as_str).collect::<Vec<_>>(),
                &RequeueOptions {
                    from: &AUDIENCE_MUTATION_RETRYABLE_STATUSES,
                    create_missing: false,
                    audience_reached: AudienceReached::Resume,
                    source: &source,
                },
            )?;
            let count = |outcome| results.iter().filter(|item| item.outcome == outcome).count();
            let (requeued, already_queued) = (count(RequeueOutcome::Requeued), count(RequeueOutcome::AlreadyQueued));
            // Held back because the target already put something in front of
            // the audience and carries nothing to continue from. Saying "only
            // failed targets can be retried" about a target that plainly
            // failed is how an operator concludes the bot is lying.
            if requeued == 0
                && already_queued == 0
                && results
                    .iter()
                    .any(|item| item.reason == Some(RequeueRefusal::AlreadyDelivered))
            {
                return Err(StudioError::new("err.retry-already-delivered").into());
            }
            if requeued == 0 && already_queued == 0 {
                return Err(StudioError::new("err.retry-only-failed").into());
            }
            Ok(PostRetry {
                results,
                requeued,
                already_queued,
            })
        })
    }

    /// The platforms this settled publication has never been sent to. The
    /// site is absent: its pages are rendered by their own build.
    pub fn resendable_targets(&self, actor_id: i64, draft_id: i64) -> Result<Vec<ResendableTarget>> {
        let draft = self.owned(actor_id, draft_id)?;
        if draft.post_id.is_none() {
            return Ok(Vec::new());
        }
        let targets = self.effective_targets(&draft.targets_json)?;
        let registered = registered_post_target_ids(self.studio.sqlite())?;
        Ok(targets_for(PublicationForm::Post)
            .filter(|definition| {
                definition.kind != TargetKind::Site
                    && registered.iter().any(|id| id == definition.id)
                    && !targets.get(definition.id)
            })
            .map(|definition| ResendableTarget {
                target: definition.id,
                label: definition.label,
                locale: definition.locale,
            })
            .collect())
    }

    /// Sends an already-published post to one more platform.
    pub fn resend_target(&self, actor_id: i64, draft_id: i64, target: &str) -> Result<RequeueResult> {
        self.studio.track("studio.post.resend", || {
            let draft = self.owned(actor_id, draft_id)?;
            let post_id = draft
                .post_id
                .ok_or_else(|| Error::from(StudioError::new("err.resend-unpublished")))?;
            self.assert_known_target(target)?;
            if is_site_target(target) {
                return Err(StudioError::new("err.resend-site").into());
            }
            let publishing = &self.studio.publishing;
            let source = || publishing.publication_source_from_db(post_id);
            let result = publishing.deliver_extra_target(
                &ExtraDeliveryScope {
                    draft_id,
                    post_id,
                    publication_key: post_ref(post_id),
                },
                target,
                &source,
            )?;
            if result.outcome != RequeueOutcome::Requeued {
                return Err(resend_refusal(&result));
            }
            // A Story target just turned on is media that now needs its 9:16
            // shapes, the same as toggling one before publication.
            self.prepare_draft_story_media(draft_id)?;
            Ok(result)
        })
    }

    /// Gives up on a target that did not land: the publication is finished
    /// without it. Unlike a retry, an ambiguous target is included —
    /// abandoning it sends nothing.
    pub fn skip_target(&self, actor_id: i64, draft_id: i64, target: Option<&str>) -> Result<PostSkip> {
        self.studio.track("studio.post.skip", || {
            let draft = self.owned(actor_id, draft_id)?;
            let post_id = draft
                .post_id
                .ok_or_else(|| Error::from(StudioError::new("err.skip-only-failed")))?;
            let selected: Vec<String> = self
                .studio
                .ports()
                .studio_posts()
                .failed_publication_targets(post_id)?
                .into_iter()
                .filter(|item| target.is_none_or(|target| item.target == target))
                .map(|item| item.target)
                .collect();
            if selected.is_empty() {
                return Err(StudioError::new("err.skip-only-failed").into());
            }
            let results = self.studio.publishing.abandon_publication_targets(
                &RequeueScope {
                    post_id: Some(post_id),
                    publication_key: post_ref(post_id),
                },
                &selected.iter().map(String::as_str).collect::<Vec<_>>(),
            )?;
            let abandoned = results
                .iter()
                .filter(|item| item.outcome == AbandonOutcome::Abandoned)
                .count();
            if abandoned == 0 {
                return Err(StudioError::new("err.skip-only-failed").into());
            }
            // The publication was held in `failed` by the very jobs just
            // abandoned; this is what takes it out of the attention list.
            self.studio.publishing.refresh_publication_status(post_id)?;
            Ok(PostSkip { results, abandoned })
        })
    }

    pub fn toggle_target(&self, actor_id: i64, draft_id: i64, target: &str) -> Result<()> {
        let draft = self.editable(actor_id, draft_id, None)?;
        self.assert_known_target(target)?;
        let mut targets = TargetMap::parse(Some(&draft.targets_json));
        let enabled = targets.get(target);
        targets.set(target, !enabled);
        self.save_targets_and_reschedule(&draft, &targets)
    }

    pub fn remove_target(&self, actor_id: i64, draft_id: i64, target: &str) -> Result<()> {
        let draft = self.editable(actor_id, draft_id, None)?;
        self.assert_known_target(target)?;
        let mut targets = TargetMap::parse(Some(&draft.targets_json));
        if !targets.get(target) {
            return Ok(());
        }
        targets.set(target, false);
        self.save_targets_and_reschedule(&draft, &targets)
    }

    /// Moves to the next preset. A preset for a language this Studio
    /// connected nothing for is a draft that publishes nowhere, so it is
    /// skipped rather than offered and then emptied.
    pub fn cycle_mode(&self, actor_id: i64, draft_id: i64) -> Result<&'static str> {
        let draft = self.editable(actor_id, draft_id, None)?;
        let current = preset_name(&TargetMap::parse(Some(&draft.targets_json)));
        let locales = post_locales(self.studio.sqlite())?;
        let order: Vec<&'static str> = ["full", "ru", "en", "tg"]
            .into_iter()
            .filter(|name| *name != "en" || locales.contains(&Locale::En))
            .collect();
        let index = order
            .iter()
            .position(|name| *name == current)
            .map_or(0, |index| index + 1);
        let next = order[index % order.len()];
        let next_preset = preset(next).ok_or_else(|| Error::from(StudioError::new("err.post-mode")))?;
        let targets = effective_post_targets(self.studio.sqlite(), &next_preset)?;
        self.save_targets_and_reschedule(&draft, &targets)?;
        Ok(next)
    }

    pub fn edit(&self, actor_id: i64, draft_id: i64, input: &EditInput) -> Result<()> {
        self.studio.track("studio.post.edit", || {
            // Same rule as create: a language this Studio does not publish
            // has no copy to write, whichever transport is asking.
            if !post_locales(self.studio.sqlite())?.contains(&input.locale) {
                return Err(StudioError::new("err.post-locale-not-served")
                    .with_param("locale", input.locale.as_str().to_uppercase())
                    .into());
            }
            let draft = self.editable(actor_id, draft_id, Some(input.locale))?;
            let mut patch = DraftPatch {
                updated_at: Some(foundation::time::to_iso_string(self.studio.now())),
                ..DraftPatch::default()
            };
            let ru = input.locale == Locale::Ru;
            let mut changed = false;
            if input.clear_media {
                patch = self.media_patch(input.locale, None);
                changed = true;
            } else {
                if !input.media.is_empty() {
                    patch = self.media_patch(input.locale, Some(json_text(&input.media)));
                    changed = true;
                }
                if !input.replace_media_only && !input.text.is_empty() {
                    let entities = Some(json_text(&emphasize_title(&input.text, &input.entities)));
                    if ru {
                        patch.text_ru = Some(input.text.clone());
                        patch.text_ru_entities_json = Some(entities);
                    } else {
                        patch.text_en_approved = Some(Some(input.text.clone()));
                        patch.text_en_entities_json = Some(entities);
                    }
                    changed = true;
                }
            }
            if !changed {
                return Err(StudioError::new("err.post-no-edit").into());
            }
            let event = event(
                draft_ref(draft_id),
                "content.draft.edited",
                format!("Draft #{draft_id} content updated"),
                json!({
                    "locale": input.locale.as_str(),
                    "media_changed": !input.media.is_empty() || input.clear_media,
                    "text_changed": !input.replace_media_only,
                }),
            );
            self.save_content_mutation(&draft, &patch, event)
        })
    }

    fn save_targets_and_reschedule(&self, draft: &DraftRecord, targets: &TargetMap) -> Result<()> {
        let patch = DraftPatch {
            targets_json: Some(targets.to_json()),
            updated_at: Some(foundation::time::to_iso_string(self.studio.now())),
            ..DraftPatch::default()
        };
        if draft.status == "scheduled" {
            let mutation = ScheduledDraftMutation {
                patch,
                queue_story_cards: false,
                event: None,
            };
            if !self.studio.publishing.mutate_scheduled_draft(draft, &mutation)? {
                return Err(StudioError::new("err.post-stale").into());
            }
        } else {
            self.studio.ports().drafts().update(draft.id, &patch)?;
        }
        // A Story target just turned on is media that now needs its 9:16
        // shapes, and this is the moment it becomes true.
        self.prepare_draft_story_media(draft.id)
    }

    fn save_content_mutation(&self, draft: &DraftRecord, patch: &DraftPatch, event: DomainEventInput) -> Result<()> {
        if draft.status == "scheduled" {
            let mutation = ScheduledDraftMutation {
                patch: patch.clone(),
                queue_story_cards: true,
                event: Some(event),
            };
            if !self.studio.publishing.mutate_scheduled_draft(draft, &mutation)? {
                return Err(StudioError::new("err.post-stale").into());
            }
        } else {
            let ports = self.studio.ports();
            ports.drafts().update(draft.id, patch)?;
            self.studio
                .publishing
                .boundaries
                .story_cards
                .queue(self.studio.sqlite(), draft.id)?;
            ports.events().record(&event)?;
        }
        self.prepare_draft_story_media(draft.id)
    }

    fn schedule_post(&self, actor_id: i64, draft_id: i64, input: &PostScheduleInput) -> Result<i64> {
        let draft = self.owned(actor_id, draft_id)?;
        if draft.status == "cancelled" {
            return Err(StudioError::new("err.post-locked").into());
        }
        let now = self.studio.now();
        for (locale, value, existing) in [
            (Locale::Ru, input.ru_at, &draft.scheduled_at),
            (Locale::En, input.en_at, &draft.scheduled_en_at),
        ] {
            let Some(value) = value else { continue };
            let preserves_existing_schedule = scheduled_date(existing.as_deref())
                .is_some_and(|existing| existing.as_millisecond() == value.as_millisecond());
            // A past time is accepted when asked for, for the language going
            // out now, and for the time the draft already carries.
            if !(input.allow_past || input.immediate_locale == Some(locale) || preserves_existing_schedule) {
                assert_future_schedule(value, now)?;
            }
        }
        let post_id = self.studio.publishing.publish_draft_to_queue(
            draft_id,
            PublishDraftOptions {
                mode: Some(PublishMode::Scheduled),
                ru_at: input.ru_at,
                en_at: input.en_at,
                immediate_locale: input.immediate_locale,
            },
        )?;
        let scheduled = self.owned(actor_id, draft_id)?;
        self.reschedule_reminders(actor_id, post_id, &draft, &scheduled)?;
        Ok(post_id)
    }

    fn reschedule_reminders(
        &self,
        actor_id: i64,
        post_id: i64,
        draft: &DraftRecord,
        scheduled: &DraftRecord,
    ) -> Result<()> {
        let notifications = SettingsService::new(self.studio.ports()).notifications(actor_id)?;
        let reminders = ReminderPolicy {
            enabled: notifications.post_reminders_enabled,
            minutes: notifications.reminder_minutes,
        };
        let first_line = foundation::js::trim(&draft.text_ru).split('\n').next().unwrap_or("");
        let title = foundation::text::truncate_unicode(first_line, 100);
        let title = if title.is_empty() {
            format!("Post #{post_id}")
        } else {
            title.to_owned()
        };
        let reference = post_ref(post_id);
        let boundary = self.studio.boundaries.reminders;
        boundary.cancel(self.studio.sqlite(), &reference)?;
        for (locale, scheduled_at) in [
            (Locale::Ru, &scheduled.scheduled_at),
            (Locale::En, &scheduled.scheduled_en_at),
        ] {
            let Some(scheduled_at) = scheduled_at.as_deref().filter(|at| !at.is_empty()) else {
                continue;
            };
            let targets: Vec<String> = self
                .effective_targets(&draft.targets_json)?
                .enabled()
                .filter(|target| target_locale(target) == Some(locale))
                .map(str::to_owned)
                .collect();
            if targets.is_empty() {
                continue;
            }
            let publish_at =
                foundation::time::parse_iso_instant(scheduled_at).map_err(|error| Error::message(error.to_string()))?;
            boundary.schedule(
                self.studio.sqlite(),
                &Reminder {
                    actor_id,
                    publication_ref: &reference,
                    kind: &format!("post.{}", locale.as_str()),
                    publish_at,
                    title: &title,
                    targets: &targets,
                    reminders,
                },
            )?;
        }
        Ok(())
    }

    fn replan_scheduled(&self, draft_id: i64, guard: impl FnOnce(&DraftRecord) -> Result<bool>) -> Result<bool> {
        let Some(draft) = self.studio.ports().drafts().get(draft_id)? else {
            return Ok(false);
        };
        if draft.status != "scheduled" || !guard(&draft)? {
            return Ok(false);
        }
        self.schedule_post(
            draft.actor_id,
            draft_id,
            &PostScheduleInput {
                ru_at: scheduled_date(draft.scheduled_at.as_deref()),
                en_at: scheduled_date(draft.scheduled_en_at.as_deref()),
                allow_past: true,
                immediate_locale: None,
            },
        )?;
        Ok(true)
    }

    fn story_card_failed(&self, draft_id: i64) -> Result<bool> {
        Ok(self
            .studio
            .publishing
            .boundaries
            .story_cards
            .for_draft(self.studio.sqlite(), draft_id)?
            .iter()
            .any(|card| card.status == "failed"))
    }

    /// Replans a scheduled post after a durable content or target mutation,
    /// unless it is a text-only Story post still waiting for its cards.
    fn replan_scheduled_post_after_mutation(&self, draft_id: i64) -> Result<bool> {
        self.replan_scheduled(draft_id, |draft| {
            let has_media = !draft_media(draft, Locale::Ru).is_empty() || !draft_media(draft, Locale::En).is_empty();
            let waits_for_cards = is_story_publish_mode(draft)
                && publishes_story(self.studio.sqlite(), &draft.targets_json)?
                && !has_media
                && !self.story_card_failed(draft_id)?
                && self
                    .studio
                    .publishing
                    .boundaries
                    .story_cards
                    .ready_media(self.studio.sqlite(), draft_id)?
                    .is_none();
            Ok(!waits_for_cards)
        })
    }

    /// Replans a scheduled text-only post after regenerated Story cards are ready.
    pub fn replan_scheduled_post_after_story_cards(&self, draft_id: i64) -> Result<bool> {
        self.replan_scheduled(draft_id, |draft| {
            Ok(is_story_publish_mode(draft)
                && self
                    .studio
                    .publishing
                    .boundaries
                    .story_cards
                    .ready_media(self.studio.sqlite(), draft_id)?
                    .is_some())
        })
    }

    /// Replans ordinary delivery after Story-card rendering gives up.
    pub fn replan_scheduled_post_after_story_card_failure(&self, draft_id: i64) -> Result<bool> {
        let replanned = self.replan_scheduled(draft_id, |draft| {
            Ok(is_story_publish_mode(draft)
                && publishes_story(self.studio.sqlite(), &draft.targets_json)?
                && self.story_card_failed(draft_id)?)
        })?;
        if !replanned {
            return Ok(false);
        }
        self.studio.ports().events().record(&DomainEventInput {
            severity: Severity::Error,
            cooldown_seconds: Some(3600),
            ..event(
                draft_ref(draft_id),
                "studio.notification.story-cards.failed",
                format!("Story cards failed for draft #{draft_id}; Story delivery was skipped"),
                json!({ "draft_id": draft_id }),
            )
        })?;
        Ok(true)
    }
}

/// A preflight issue in the pipeline's vocabulary.
fn pipeline_issue(issue: PublicationPreflightIssue) -> Issue {
    Issue {
        target: Some(issue.target),
        locale: Some(issue.locale),
        code: None,
        kind: Some(issue.kind.as_str().into()),
        label: Some(issue.label),
    }
}

impl PublicationPipeline for PostService<'_> {
    fn kind(&self) -> PublicationKind {
        PostService::kind(self)
    }

    fn capabilities(&self) -> PublicationCapabilities {
        PostService::capabilities(self)
    }

    fn get(&self, actor_id: i64, publication_id: i64) -> Result<PublicationView> {
        let draft = PostService::get(self, actor_id, publication_id)?;
        Ok(PublicationView {
            id: draft.id,
            status: draft.status,
        })
    }

    fn preview(&self, actor_id: i64, publication_id: i64) -> Result<PreviewModel> {
        let preview = PostService::preview(self, actor_id, publication_id)?;
        Ok(PreviewModel {
            view: PublicationView {
                id: preview.id,
                status: preview.status,
            },
            issues: preview.issues.into_iter().map(pipeline_issue).collect(),
        })
    }

    async fn validate(&self, actor_id: i64, publication_id: i64) -> Result<Vec<Issue>> {
        Ok(PostService::validate(self, actor_id, publication_id)?
            .into_iter()
            .map(pipeline_issue)
            .collect())
    }

    async fn schedule(&self, actor_id: i64, publication_id: i64, schedule: &PublicationSchedule) -> Result<()> {
        let value = |key: &str| schedule.values.iter().find(|(name, _)| name == key).map(|(_, at)| *at);
        PostService::schedule(
            self,
            actor_id,
            publication_id,
            &PostScheduleInput {
                ru_at: value("ru"),
                en_at: value("en"),
                allow_past: schedule.allow_past,
                immediate_locale: match schedule.immediate_key.as_deref() {
                    Some("ru") => Some(Locale::Ru),
                    Some("en") => Some(Locale::En),
                    _ => None,
                },
            },
        )
        .map(drop)
    }

    async fn publish(&self, actor_id: i64, publication_id: i64) -> Result<()> {
        PostService::publish(self, actor_id, publication_id).map(drop)
    }

    async fn cancel(&self, actor_id: i64, publication_id: i64) -> Result<()> {
        PostService::cancel(self, actor_id, publication_id)
    }

    async fn retry_target(&self, actor_id: i64, publication_id: i64, target: &str) -> Result<PublicationRetrySummary> {
        // `target ? … : retryable`: an empty target is every retryable one.
        let target = (!target.is_empty()).then_some(target);
        let retry = PostService::retry_target(self, actor_id, publication_id, target)?;
        Ok(PublicationRetrySummary {
            requeued: retry.requeued as u32,
            already_queued: retry.already_queued as u32,
        })
    }

    fn remove_target(&self, actor_id: i64, publication_id: i64, target: &str) -> Result<()> {
        PostService::remove_target(self, actor_id, publication_id, target)
    }

    fn toggle_target(&self, actor_id: i64, publication_id: i64, target: &str) -> Result<()> {
        PostService::toggle_target(self, actor_id, publication_id, target)
    }

    fn slot_time(&self, actor_id: i64, clock: &str) -> Result<Timestamp> {
        PostService::slot_time(self, actor_id, clock)
    }
}
