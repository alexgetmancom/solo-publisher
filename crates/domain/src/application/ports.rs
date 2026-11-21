//! The records application use cases read and write, the clock they run on,
//! and [`ApplicationPorts`], the composition root that hands out the
//! repositories. Database naming stays at the repository boundary; field names
//! serialize as the TypeScript ports name them.

use content::message::{Entity, MediaItem};
use content::thread::ThreadPart;
use db::rusqlite::Connection;
use db::{BackendDb, unsafe_db};
use jiff::Timestamp;
use serde::ser::SerializeStruct;
use serde::{Deserialize, Serialize, Serializer};
use serde_json::{Map, Value};

use crate::json::double_option;
use crate::repositories::{
    ActionableIssueStore, ChannelStore, ConversationSessionStore, DraftStore, DraftTranslationStore,
    EntityEnrichmentStore, EventStore, StudioMediaAssetStore, StudioPostStore, StudioQueueStore, StudioSettingsStore,
    StudioVideoStore, ThreadPartStore,
};

/// A JSON object as a column or argument holds it.
pub type JsonObject = Map<String, Value>;

/// The time boundary of every use case; tests pin it.
pub trait Clock {
    fn now(&self) -> Timestamp;
}

pub struct SystemClock;

impl Clock for SystemClock {
    fn now(&self) -> Timestamp {
        Timestamp::now()
    }
}

/// The repositories, bound to one connection and clock.
#[derive(Clone, Copy)]
pub struct ApplicationPorts<'a> {
    sqlite: &'a Connection,
    clock: &'a dyn Clock,
}

impl<'a> ApplicationPorts<'a> {
    pub fn new(backend_db: &'a BackendDb, clock: &'a dyn Clock) -> Self {
        Self::within(unsafe_db(backend_db), clock)
    }

    /// Repositories over a connection the caller already holds — typically an
    /// open transaction, whose writes they then join (a repository that opens
    /// its own transaction nests as a savepoint).
    pub fn within(sqlite: &'a Connection, clock: &'a dyn Clock) -> Self {
        Self { sqlite, clock }
    }

    pub fn clock(&self) -> &'a dyn Clock {
        self.clock
    }

    pub fn drafts(&self) -> DraftStore<'a> {
        DraftStore::new(self.sqlite, self.clock)
    }

    pub fn thread_parts(&self) -> ThreadPartStore<'a> {
        ThreadPartStore::new(self.sqlite, self.clock)
    }

    pub fn events(&self) -> EventStore<'a> {
        EventStore::new(self.sqlite, self.clock)
    }

    pub fn studio_posts(&self) -> StudioPostStore<'a> {
        StudioPostStore::new(self.sqlite)
    }

    pub fn conversation_sessions(&self) -> ConversationSessionStore<'a> {
        ConversationSessionStore::new(self.sqlite)
    }

    pub fn studio_queue(&self) -> StudioQueueStore<'a> {
        StudioQueueStore::new(self.sqlite)
    }

    pub fn actionable_issues(&self) -> ActionableIssueStore<'a> {
        ActionableIssueStore::new(self.sqlite)
    }

    pub fn studio_settings(&self) -> StudioSettingsStore<'a> {
        StudioSettingsStore::new(self.sqlite)
    }

    pub fn studio_media_assets(&self) -> StudioMediaAssetStore<'a> {
        StudioMediaAssetStore::new(self.sqlite)
    }

    pub fn studio_videos(&self) -> StudioVideoStore<'a> {
        StudioVideoStore::new(self.sqlite)
    }

    pub fn entity_enrichment(&self) -> EntityEnrichmentStore<'a> {
        EntityEnrichmentStore::new(self.sqlite)
    }

    pub fn channels(&self) -> ChannelStore<'a> {
        ChannelStore::new(self.sqlite)
    }

    pub fn draft_translations(&self) -> DraftTranslationStore<'a> {
        DraftTranslationStore::new(self.sqlite, self.clock)
    }
}

// ---------------------------------------------------------------- events

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    Info,
    Warn,
    Error,
}

impl Severity {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Info => "info",
            Self::Warn => "warn",
            Self::Error => "error",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DomainEventInput {
    #[serde(rename = "ref", default)]
    pub publication_ref: Option<String>,
    #[serde(rename = "type")]
    pub event_type: String,
    pub severity: Severity,
    #[serde(default)]
    pub target: Option<String>,
    pub message: String,
    #[serde(default)]
    pub details: Option<JsonObject>,
    /// Suppress the event when the same one (publication, type, target) was
    /// recorded this many seconds ago or later. Zero means no cooldown.
    #[serde(default)]
    pub cooldown_seconds: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PostEventRecord {
    pub id: i64,
    pub publication_key: Option<String>,
    pub event_type: String,
    pub severity: String,
    pub target: Option<String>,
    pub message: String,
    pub details_json: Option<String>,
    pub created_at: String,
    pub acked_at: Option<String>,
}

// ---------------------------------------------------------------- drafts

/// Stable application representation of a draft.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct DraftRecord {
    pub id: i64,
    pub actor_id: i64,
    pub status: String,
    pub text_ru: String,
    pub text_en_machine: Option<String>,
    pub text_en_approved: Option<String>,
    pub targets_json: String,
    pub media_ru_json: Option<String>,
    pub media_en_json: Option<String>,
    pub scheduled_at: Option<String>,
    pub scheduled_en_at: Option<String>,
    pub post_id: Option<i64>,
    pub text_ru_entities_json: Option<String>,
    pub text_en_entities_json: Option<String>,
    pub story_publish_mode: Option<String>,
    pub updated_at: String,
    /// The posts after the first; empty for an ordinary post.
    #[serde(serialize_with = "serialize_thread")]
    pub thread: Vec<ThreadPart>,
}

/// `content::thread::ThreadPart` under the TypeScript port's field names.
fn serialize_thread<S: Serializer>(thread: &[ThreadPart], serializer: S) -> Result<S::Ok, S::Error> {
    struct Part<'a>(&'a ThreadPart);
    impl Serialize for Part<'_> {
        fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
            let mut part = serializer.serialize_struct("ThreadPart", 6)?;
            part.serialize_field("position", &self.0.position)?;
            part.serialize_field("textRu", &self.0.text_ru)?;
            part.serialize_field("entitiesRu", &self.0.entities_ru)?;
            part.serialize_field("textEn", &self.0.text_en)?;
            part.serialize_field("textEnApproved", &self.0.text_en_approved)?;
            part.serialize_field("media", &self.0.media)?;
            part.end()
        }
    }
    serializer.collect_seq(thread.iter().map(Part))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StoryPublishMode {
    All,
    SiteOnly,
}

impl StoryPublishMode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::All => "all",
            Self::SiteOnly => "site_only",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewDraft {
    pub actor_id: i64,
    pub text_ru: String,
    pub text_en_machine: Option<String>,
    pub text_en_approved: Option<String>,
    pub targets_json: String,
    /// JSON text; anything but an array is stored as no media.
    pub media_ru_json: Option<String>,
    pub text_ru_entities_json: String,
    #[serde(default)]
    pub story_publish_mode: Option<StoryPublishMode>,
}

/// `None` leaves a field alone; for the nullable ones `Some(None)` clears it.
#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct DraftPatch {
    pub text_ru: Option<String>,
    pub text_en_machine: Option<String>,
    #[serde(deserialize_with = "double_option")]
    pub text_en_approved: Option<Option<String>>,
    #[serde(deserialize_with = "double_option")]
    pub text_ru_entities_json: Option<Option<String>>,
    #[serde(deserialize_with = "double_option")]
    pub text_en_entities_json: Option<Option<String>>,
    pub targets_json: Option<String>,
    /// JSON text; anything but an array is stored as no media.
    #[serde(deserialize_with = "double_option")]
    pub media_ru_json: Option<Option<String>>,
    #[serde(deserialize_with = "double_option")]
    pub media_en_json: Option<Option<String>>,
    pub updated_at: Option<String>,
}

// ---------------------------------------------------------------- threads

/// A post of a thread as it is written. The English travels with it so that
/// rewriting one post does not throw away the English of its neighbours.
#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewThreadPart {
    pub text_ru: String,
    pub entities_ru: Vec<Entity>,
    pub media: Vec<MediaItem>,
    #[serde(default)]
    pub text_en: Option<String>,
    #[serde(default)]
    pub text_en_approved: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadEnglish {
    pub position: i64,
    pub text_en: String,
}

// ---------------------------------------------------------------- translations

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranslationClaim {
    pub draft_id: i64,
    pub attempt_count: i64,
    pub locked_by: String,
}

// ---------------------------------------------------------------- studio posts

/// A delivery target that did not land: it either failed outright or reached a
/// state only a human can settle. Whether it may be retried or only abandoned
/// is a publishing rule, applied by the caller, not by the query.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct FailedPublicationTarget {
    pub target: String,
    pub status: IssueStatus,
    pub error: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftEntityCandidate {
    pub kind: String,
    pub slug: String,
    pub title_ru: String,
    pub title_en: Option<String>,
}

/// Persistence projection behind the transport-neutral post progress view.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StudioPostProgress {
    pub draft: ProgressDraft,
    pub publish_jobs: Vec<ProgressPublishJob>,
    pub site_jobs: Vec<ProgressSiteJob>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProgressDraft {
    pub id: i64,
    pub actor_id: i64,
    pub post_id: Option<i64>,
    pub targets_json: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProgressPublishJob {
    pub target: String,
    pub status: String,
    pub last_error: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProgressSiteJob {
    pub reason: String,
    pub status: String,
    pub last_error: Option<String>,
}

// ---------------------------------------------------------------- conversations

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ConversationSessionKind {
    Intake,
    Post,
    Video,
    Settings,
}

impl ConversationSessionKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Intake => "intake",
            Self::Post => "post",
            Self::Video => "video",
            Self::Settings => "settings",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationSessionRecord {
    pub actor_id: i64,
    pub kind: ConversationSessionKind,
    pub draft_id: Option<i64>,
    pub step: Option<String>,
    pub data: JsonObject,
    pub control_message_id: Option<i64>,
    pub revision: i64,
    pub active: i64,
    pub updated_at: String,
    pub expires_at: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveConversationSession {
    pub actor_id: i64,
    pub kind: ConversationSessionKind,
    pub draft_id: Option<i64>,
    pub step: Option<String>,
    pub data: JsonObject,
    pub control_message_id: Option<i64>,
    pub active: i64,
    /// Refuse the save when the stored revision is another one.
    #[serde(default)]
    pub expected_revision: Option<i64>,
    /// Keep the stored revision instead of consuming a new one.
    #[serde(default)]
    pub preserve_revision: bool,
    pub updated_at: String,
    pub expires_at: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClearConversationSession {
    pub draft_id: Option<i64>,
    pub actor_id: i64,
    pub kind: ConversationSessionKind,
    #[serde(default)]
    pub step: Option<String>,
    #[serde(default)]
    pub expected_revision: Option<i64>,
    pub updated_at: String,
}

// ---------------------------------------------------------------- issues

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum IssueKind {
    Post,
    Site,
    Story,
    Video,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum IssueStatus {
    Failed,
    VerificationRequired,
}

/// One thing that needs a human: a publication that failed, or one that
/// reached the audience without a proof we could read back.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionableIssue {
    pub kind: IssueKind,
    /// `None` only for a Story card on a draft that never entered Delivery.
    pub publication_key: Option<String>,
    pub draft_id: i64,
    pub actor_id: i64,
    /// Delivery target, site job reason, Story locale — whatever names the
    /// half of the publication that is stuck.
    pub target: String,
    pub status: IssueStatus,
    pub updated_at: String,
}

// ---------------------------------------------------------------- queue

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StudioQueuePublished {
    pub id: i64,
    pub label: String,
    pub kind: super::conversation_flow::PublicationKind,
    pub published_at: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StudioQueuePost {
    pub id: i64,
    pub actor_id: i64,
    pub status: String,
    pub text_ru: String,
    pub targets_json: String,
    pub updated_at: String,
    pub scheduled_at: Option<String>,
    pub scheduled_en_at: Option<String>,
    pub post_id: Option<i64>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StudioQueueVideo {
    pub id: i64,
    pub actor_id: i64,
    pub status: String,
    pub label: String,
    pub updated_at: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StudioQueueVideoTarget {
    pub publication_id: i64,
    pub status: String,
    pub scheduled_at: Option<String>,
}

// ---------------------------------------------------------------- settings

/// A string this Studio publishes about itself, in each language it serves.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct LocalizedText {
    pub en: String,
    pub ru: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct StudioSocialProfile {
    pub label: String,
    pub url: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct LocalizedProfiles {
    pub en: Vec<StudioSocialProfile>,
    pub ru: Vec<StudioSocialProfile>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StudioProfileRecord {
    pub id: i64,
    pub timezone: String,
    pub timezone_label: String,
    pub site_enabled: i64,
    pub video_prepare_lead_minutes: i64,
    pub video_retention_hours: i64,
    pub name_json: LocalizedText,
    pub tagline_json: LocalizedText,
    pub about_json: LocalizedText,
    pub bio_json: LocalizedText,
    pub site_timezone_json: LocalizedText,
    pub profiles_json: LocalizedProfiles,
    pub default_targets_json: Vec<String>,
    pub updated_at: String,
}

/// The profile fields to change; `updated_at` always is.
#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StudioProfilePatch {
    #[serde(default)]
    pub timezone: Option<String>,
    #[serde(default)]
    pub timezone_label: Option<String>,
    #[serde(default)]
    pub site_enabled: Option<i64>,
    #[serde(default)]
    pub video_prepare_lead_minutes: Option<i64>,
    #[serde(default)]
    pub video_retention_hours: Option<i64>,
    #[serde(default)]
    pub name_json: Option<LocalizedText>,
    #[serde(default)]
    pub tagline_json: Option<LocalizedText>,
    #[serde(default)]
    pub about_json: Option<LocalizedText>,
    #[serde(default)]
    pub bio_json: Option<LocalizedText>,
    #[serde(default)]
    pub site_timezone_json: Option<LocalizedText>,
    #[serde(default)]
    pub profiles_json: Option<LocalizedProfiles>,
    #[serde(default)]
    pub default_targets_json: Option<Vec<String>>,
    pub updated_at: String,
}

/// Owner-level notification policy; also what `save_notifications` writes.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StudioNotificationSettingsRecord {
    pub actor_id: i64,
    pub video_reminders_enabled: i64,
    pub post_reminders_enabled: i64,
    pub reminder_minutes: i64,
    pub completion_enabled: i64,
    pub updated_at: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StudioBackupSettingsRecord {
    pub id: i64,
    pub enabled: i64,
    pub updated_at: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StudioYoutubeSettingsRecord {
    pub id: i64,
    pub signature: String,
    pub updated_at: String,
}

// ---------------------------------------------------------------- media

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StudioMediaAssetRecord {
    pub id: i64,
    #[serde(flatten)]
    pub asset: NewStudioMediaAsset,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewStudioMediaAsset {
    pub actor_id: i64,
    pub kind: String,
    pub mime_type: String,
    pub filename: String,
    pub local_path: String,
    pub byte_size: i64,
    pub sha256: String,
    pub source: String,
    pub created_at: String,
}

// ---------------------------------------------------------------- video

/// Every column of `video_drafts`, as the read returns them.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StudioVideoDraftRecord {
    pub id: i64,
    pub actor_id: i64,
    pub locale: String,
    pub label: String,
    pub studio_media_asset_id: Option<i64>,
    pub status: String,
    pub scheduled_at: Option<String>,
    pub retention_until: Option<String>,
    pub source_pruned_at: Option<String>,
    pub control_chat_id: Option<i64>,
    pub control_message_id: Option<i64>,
    pub game: Option<String>,
    pub hook: Option<String>,
    pub script: Option<String>,
    pub script_source: Option<String>,
    pub opening_line: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StudioVideoTargetRecord {
    pub id: i64,
    pub publication_id: i64,
    pub target: String,
    pub metadata_json: JsonObject,
    pub scheduled_at: Option<String>,
    pub status: String,
    pub delivery_provider: String,
    pub provider_account_id: Option<String>,
    pub provider_post_id: Option<String>,
    pub external_id: Option<String>,
    pub external_url: Option<String>,
    pub prepared_at: Option<String>,
    pub published_at: Option<String>,
    pub confirmation_source: Option<String>,
    pub verified_at: Option<String>,
    pub last_error: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StudioVideoJobRecord {
    pub id: i64,
    pub publication_id: i64,
    pub video_target_id: Option<i64>,
    pub kind: String,
    pub run_at: String,
    pub status: String,
    pub reconcile_attempt_count: i64,
    pub attempt_count: i64,
    pub next_attempt_at: Option<String>,
    pub last_error: Option<String>,
    pub locked_by: Option<String>,
    pub locked_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

// ---------------------------------------------------------------- channels

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChannelConnectionRecord {
    #[serde(flatten)]
    pub connection: ChannelConnection,
    pub created_at: String,
    pub updated_at: String,
}

/// A channel connection as it is written.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChannelConnection {
    pub id: String,
    pub platform: String,
    pub locale: String,
    pub provider: String,
    pub provider_account_id: Option<String>,
    pub target_id: Option<String>,
    pub label: String,
    pub enabled: i64,
    pub source: String,
}
