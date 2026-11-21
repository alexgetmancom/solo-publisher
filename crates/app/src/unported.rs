//! The host of this build: the ported stores behind Studio's boundaries
//! (`domain::story_cards`, `domain::notifications`, the credential breaker,
//! the readiness report, runtime usage, the video completion notice), and the
//! boundaries whose real implementation belongs to an area this build does not
//! contain yet. Each of those refuses with `not available in this build:
//! <area>`, which the bot shows as the error it is; none pretends the work
//! happened. The ones that return nothing (the worker bell, Story
//! derivatives) log instead.

use adapters::providers::ProviderCalls;
use bot::{Adapters, Fut, Host};
use channels::connect::ConnectLinks;
use channels::entropy::OsEntropy;
use channels::zernio::ZernioAccounts;
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
    MediaMetadata, MediaProbe, ProviderOutcome, StoryCardMedia, StoryCardState, StoryCards, SystemJitter,
    VideoProvider, WorkerBell,
};
use domain::story_cards::StoryCardStore;
use domain::studio::boundaries::{StoryDerivatives, StudioBoundaries, YoutubeUploads, ZernioAccount, ZernioDirectory};
use foundation::config::{Config, SharedConfig};
use foundation::logger::{LogLevel, log};
use runtime::ffmpeg::FfmpegMediaProbe;
use runtime::http::HttpClient;
use serde_json::{Value, json};

const PUBLISH_WORKER: &str = "publish worker";
const STORY_DERIVATIVES: &str = "Story derivatives (media runtime)";

/// Every area above, for the startup line.
pub const AREAS: [&str; 2] = [PUBLISH_WORKER, STORY_DERIVATIVES];

fn message(area: &str) -> String {
    format!("not available in this build: {area}")
}

pub struct AppHost {
    auth_circuit: AuthCircuitBreaker<SystemClock>,
    usage: UsageRecorder<SystemClock>,
    story_cards: StoryCardStore<SystemClock>,
    video_completion: VideoCompletionNotice<SystemClock>,
    reminders: ReminderJobs<SystemClock>,
    readiness: CapabilityReadiness,
    connect_links: ConnectLinks<SystemClock, OsEntropy>,
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
            connect_links: ConnectLinks::new(SystemClock, OsEntropy),
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
            connect_links: &self.connect_links,
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

/// The adapters Studio waits on: the media probe is ffprobe/ffmpeg, the
/// provider calls go to the platforms, the Zernio directory is channels'.
pub struct AppAdapters {
    providers: ProviderCalls,
    zernio: ZernioAccounts,
}

impl AppAdapters {
    pub fn new(http: HttpClient, config: SharedConfig) -> Self {
        Self {
            providers: ProviderCalls::new(http.clone(), config),
            zernio: ZernioAccounts::new(http),
        }
    }
}

impl Adapters for AppAdapters {
    fn probe<'a>(&'a self, path: &'a str) -> Fut<'a, Result<MediaMetadata, String>> {
        Box::pin(FfmpegMediaProbe.probe(path))
    }
    fn audio_stats<'a>(&'a self, path: &'a str) -> Fut<'a, Result<String, String>> {
        Box::pin(FfmpegMediaProbe.audio_stats(path))
    }
    fn post_outcome<'a>(
        &'a self,
        provider_post_id: &'a str,
        platform: &'a str,
    ) -> Fut<'a, domain::Result<ProviderOutcome>> {
        Box::pin(self.providers.post_outcome(provider_post_id, platform))
    }
    fn publish_instagram_reel<'a>(
        &'a self,
        account_id: &'a str,
        public_url: &'a str,
        metadata: &'a Value,
        request_id: &'a str,
    ) -> Fut<'a, domain::Result<ProviderOutcome>> {
        Box::pin(
            self.providers
                .publish_instagram_reel(account_id, public_url, metadata, request_id),
        )
    }
    fn keep_youtube_private<'a>(
        &'a self,
        config: &'a Config,
        video_id: &'a str,
        locale: Locale,
    ) -> Fut<'a, domain::Result<()>> {
        Box::pin(self.providers.keep_private(config, video_id, locale))
    }
    fn zernio_accounts<'a>(&'a self, config: &'a Config) -> Fut<'a, domain::Result<Vec<ZernioAccount>>> {
        Box::pin(self.zernio.accounts(config))
    }
}
