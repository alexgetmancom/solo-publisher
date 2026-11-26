//! What Studio calls but does not own, each as the narrowest trait the
//! services use. The real implementations live with their owners
//! (notifications, delivery, observability, the channel adapters); the tests
//! fake them. Publishing's own boundaries (usage, Story cards, the credential
//! breaker, the media prober, the video provider) are reused as they are.

use std::future::Future;

use content::Locale;
use db::rusqlite::Connection;
use foundation::config::Config;
use jiff::Timestamp;
use serde::{Deserialize, Serialize};

use crate::Result;

/// Whether a publication kind is reminded about, and how early.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ReminderPolicy {
    pub enabled: bool,
    pub minutes: i64,
}

/// One reminder before a publication goes out (`scheduleReminder`'s input).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Reminder<'a> {
    pub actor_id: i64,
    pub publication_ref: &'a str,
    pub kind: &'a str,
    pub publish_at: Timestamp,
    pub title: &'a str,
    pub targets: &'a [String],
    pub reminders: ReminderPolicy,
}

/// Publication reminders, on the connection given.
pub trait Reminders {
    /// `scheduleReminder`: nothing when reminders are off or the time passed.
    fn schedule(&self, sqlite: &Connection, reminder: &Reminder<'_>) -> Result<()>;
    /// `cancelScheduledNotifications`: every reminder still queued for it.
    fn cancel(&self, sqlite: &Connection, publication_ref: &str) -> Result<()>;
}

/// The 9:16 Story shapes of a draft's media (`ensureStoryDerivative`). Nobody
/// waits for it: the implementation starts the encode and logs a failure,
/// which the delivery then refuses and the backfill repairs.
pub trait StoryDerivatives {
    fn ensure(&self, local_path: &str, video: bool, draft_id: i64);
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum CapabilityStatus {
    Ready,
    Missing,
}

impl CapabilityStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Ready => "ready",
            Self::Missing => "missing",
        }
    }
}

/// What one capability needs and lacks, by setting name only.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct CapabilityReportEntry {
    pub target: String,
    pub required: Vec<String>,
    pub missing: Vec<String>,
    pub status: CapabilityStatus,
}

/// The readiness report over the channel registry: one entry per connected
/// capability.
pub trait Readiness {
    fn capability_report(&self, sqlite: &Connection) -> Result<Vec<CapabilityReportEntry>>;
}

/// The Meta platforms with an OAuth connection of their own.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MetaOauthPlatform {
    Threads,
    Instagram,
}

/// The platforms `startConnect` knows (`CONNECT_PLATFORMS`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ConnectPlatform {
    Threads,
    Instagram,
    X,
    Youtube,
}

/// A started connection: the link the operator opens, and how long it lives.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectStart {
    pub platform: &'static str,
    pub locale: Option<&'static str>,
    pub kind: &'static str,
    pub url: String,
    pub expires_in_minutes: u32,
}

/// The connection links the channel adapters sign. Each refuses with an error
/// when the platform is not configured.
pub trait ChannelConnectLinks {
    fn meta_oauth_connect_url(&self, config: &Config, platform: MetaOauthPlatform, locale: Locale) -> Result<String>;
    fn meta_oauth_connect_path(&self, config: &Config, platform: MetaOauthPlatform, locale: Locale) -> Result<String>;
    fn x_oauth_connect_url(&self, config: &Config) -> Result<String>;
    fn x_oauth_connect_path(&self, config: &Config) -> Result<String>;
    fn start_connect(
        &self,
        config: &Config,
        platform: ConnectPlatform,
        locale: Locale,
        now: Timestamp,
    ) -> Result<ConnectStart>;
}

/// The synchronous boundaries a Studio handle carries.
#[derive(Clone, Copy)]
pub struct StudioBoundaries<'a> {
    pub reminders: &'a dyn Reminders,
    pub story_derivatives: &'a dyn StoryDerivatives,
    pub readiness: &'a dyn Readiness,
    pub connect_links: &'a dyn ChannelConnectLinks,
}

/// YouTube uploads a cancelled video still has (`keepYouTubeUploadPrivate`).
pub trait YoutubeUploads {
    fn keep_private(&self, config: &Config, video_id: &str, locale: Locale) -> impl Future<Output = Result<()>>;
}

/// One account the Zernio provider holds for this Studio, as it reports it.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct ZernioAccount {
    #[serde(rename = "_id", default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub username: Option<String>,
    #[serde(rename = "displayName", default, skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub platform: Option<String>,
    #[serde(rename = "followersCount", default, skip_serializing_if = "Option::is_none")]
    pub followers_count: Option<f64>,
}

/// The Zernio account list (`listZernioAccounts`).
pub trait ZernioDirectory {
    fn accounts(&self, config: &Config) -> impl Future<Output = Result<Vec<ZernioAccount>>>;
}
