//! The host of this build: the ported stores behind Studio's boundaries
//! (`domain::story_cards`, `domain::notifications`, the credential breaker,
//! the readiness report, runtime usage, the video completion notice), and the
//! boundaries whose real implementation belongs to an area this build does not
//! contain yet. Each of those refuses with `not available in this build:
//! <area>`, which the bot shows as the error it is; none pretends the work
//! happened. The ones that return nothing (the worker bell, Story
//! derivatives) log instead.

use bot::{Adapters, Fut, Host};
use content::Locale;
use db::rusqlite::Connection;
use domain::application::ports::{StoryPublishMode, SystemClock};
use domain::delivery::VideoCompletionNotice;
use domain::notifications::ReminderJobs;
use domain::observability::auth_circuit::AuthCircuitBreaker;
use domain::observability::capabilities::CapabilityReadiness;
use domain::observability::usage::UsageRecorder;
use domain::publishing::Boundaries;
use domain::publishing::boundaries::{
    MediaMetadata, MediaProbe, ProviderOutcome, StoryCardMedia, StoryCardState, StoryCards, SystemJitter, WorkerBell,
};
use domain::story_cards::StoryCardStore;
use domain::studio::boundaries::{
    ChannelConnectLinks, ConnectPlatform, ConnectStart, MetaOauthPlatform, StoryDerivatives, StudioBoundaries,
    ZernioAccount,
};
use foundation::config::{Config, SharedConfig};
use foundation::logger::{LogLevel, log};
use jiff::Timestamp;
use runtime::ffmpeg::FfmpegMediaProbe;
use serde_json::{Value, json};

const PUBLISH_WORKER: &str = "publish worker";
const STORY_DERIVATIVES: &str = "Story derivatives (media runtime)";
const CONNECT_LINKS: &str = "channel connect links (channels)";
const ZERNIO: &str = "Zernio";
const YOUTUBE: &str = "YouTube uploads";

/// Every area above, for the startup line.
pub const AREAS: [&str; 5] = [PUBLISH_WORKER, STORY_DERIVATIVES, CONNECT_LINKS, ZERNIO, YOUTUBE];

fn message(area: &str) -> String {
    format!("not available in this build: {area}")
}

fn refuse<T>(area: &str) -> domain::Result<T> {
    Err(domain::Error::message(message(area)))
}

pub struct AppHost {
    auth_circuit: AuthCircuitBreaker<SystemClock>,
    usage: UsageRecorder<SystemClock>,
    story_cards: StoryCardStore<SystemClock>,
    video_completion: VideoCompletionNotice<SystemClock>,
    reminders: ReminderJobs<SystemClock>,
    readiness: CapabilityReadiness,
}

impl AppHost {
    pub fn new(config: SharedConfig) -> Self {
        Self {
            auth_circuit: AuthCircuitBreaker::new(SystemClock),
            usage: UsageRecorder::new(SystemClock),
            story_cards: StoryCardStore::new(SystemClock),
            video_completion: VideoCompletionNotice::new(SystemClock),
            reminders: ReminderJobs::new(SystemClock),
            readiness: CapabilityReadiness::new(config),
        }
    }

    /// Writes the usage still buffered; called once polling has stopped.
    pub fn flush_usage(&self, sqlite: &Connection) {
        self.usage.flush(sqlite);
    }
}

impl Host for AppHost {
    fn publishing(&self) -> Boundaries<'_> {
        Boundaries {
            jitter: &SystemJitter,
            bell: self,
            auth_circuit: &self.auth_circuit,
            usage: &self.usage,
            story_cards: self,
            video_completion: &self.video_completion,
        }
    }

    fn studio(&self) -> StudioBoundaries<'_> {
        StudioBoundaries {
            reminders: &self.reminders,
            story_derivatives: self,
            readiness: &self.readiness,
            connect_links: self,
        }
    }
}

/// The job is durable; only the wake-up is missing, so a ring is logged.
impl WorkerBell for AppHost {
    fn ring_publish(&self) {
        log(
            LogLevel::Warn,
            &message(PUBLISH_WORKER),
            Some(json!({"hint": "the publish job stays queued until a build with workers runs"})),
        );
    }
    fn ring_publish_after(&self, delay_ms: u64) {
        log(
            LogLevel::Warn,
            &message(PUBLISH_WORKER),
            Some(json!({"delayMs": delay_ms, "hint": "the publish job stays queued until a build with workers runs"})),
        );
    }
}

/// The store; the story-cards loop renders what it queues.
impl StoryCards for AppHost {
    fn queue(&self, sqlite: &Connection, draft_id: i64) -> domain::Result<()> {
        self.story_cards.queue(sqlite, draft_id)
    }
    fn for_draft(&self, sqlite: &Connection, draft_id: i64) -> domain::Result<Vec<StoryCardState>> {
        self.story_cards.for_draft(sqlite, draft_id)
    }
    fn ready_media(&self, sqlite: &Connection, draft_id: i64) -> domain::Result<Option<StoryCardMedia>> {
        self.story_cards.ready_media(sqlite, draft_id)
    }
    fn set_publish_mode(&self, sqlite: &Connection, draft_id: i64, mode: StoryPublishMode) -> domain::Result<()> {
        self.story_cards.set_publish_mode(sqlite, draft_id, mode)
    }
    fn discard(&self, sqlite: &Connection, draft_id: i64) -> domain::Result<()> {
        self.story_cards.discard(sqlite, draft_id)
    }
}

/// Nobody waits for it: a failure is logged, as the real encode's is.
impl StoryDerivatives for AppHost {
    fn ensure(&self, local_path: &str, video: bool, draft_id: i64) {
        log(
            LogLevel::Error,
            &message(STORY_DERIVATIVES),
            Some(json!({"localPath": local_path, "video": video, "draftId": draft_id})),
        );
    }
}

impl ChannelConnectLinks for AppHost {
    fn meta_oauth_connect_url(&self, _: &Config, _: MetaOauthPlatform, _: Locale) -> domain::Result<String> {
        refuse(CONNECT_LINKS)
    }
    fn meta_oauth_connect_path(&self, _: &Config, _: MetaOauthPlatform, _: Locale) -> domain::Result<String> {
        refuse(CONNECT_LINKS)
    }
    fn x_oauth_connect_url(&self, _: &Config) -> domain::Result<String> {
        refuse(CONNECT_LINKS)
    }
    fn x_oauth_connect_path(&self, _: &Config) -> domain::Result<String> {
        refuse(CONNECT_LINKS)
    }
    fn start_connect(&self, _: &Config, _: ConnectPlatform, _: Locale, _: Timestamp) -> domain::Result<ConnectStart> {
        refuse(CONNECT_LINKS)
    }
}

/// The adapters Studio waits on: the media probe is ffprobe/ffmpeg; the
/// provider calls are not ported yet.
pub struct AppAdapters;

impl Adapters for AppAdapters {
    fn probe<'a>(&'a self, path: &'a str) -> Fut<'a, Result<MediaMetadata, String>> {
        Box::pin(FfmpegMediaProbe.probe(path))
    }
    fn audio_stats<'a>(&'a self, path: &'a str) -> Fut<'a, Result<String, String>> {
        Box::pin(FfmpegMediaProbe.audio_stats(path))
    }
    fn post_outcome<'a>(&'a self, _: &'a str, _: &'a str) -> Fut<'a, domain::Result<ProviderOutcome>> {
        Box::pin(async { refuse(ZERNIO) })
    }
    fn publish_instagram_reel<'a>(
        &'a self,
        _: &'a str,
        _: &'a str,
        _: &'a Value,
        _: &'a str,
    ) -> Fut<'a, domain::Result<ProviderOutcome>> {
        Box::pin(async { refuse(ZERNIO) })
    }
    fn keep_youtube_private<'a>(&'a self, _: &'a Config, _: &'a str, _: Locale) -> Fut<'a, domain::Result<()>> {
        Box::pin(async { refuse(YOUTUBE) })
    }
    fn zernio_accounts<'a>(&'a self, _: &'a Config) -> Fut<'a, domain::Result<Vec<ZernioAccount>>> {
        Box::pin(async { refuse(ZERNIO) })
    }
}
