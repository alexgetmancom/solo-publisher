//! The host of this build: the ported stores behind Studio's and publishing's
//! boundaries (`domain::story_cards`, `domain::notifications`, the credential
//! breaker, the readiness report, runtime usage, the video completion
//! notice), the worker doorbells, connect links, and the process's media
//! runtime (`delivery::story_derivatives::DeliveryMedia`), plus the adapters
//! Studio waits on.

use adapters::providers::ProviderCalls;
use bot::{Adapters, Fut, Host};
use channels::connect::ConnectLinks;
use channels::entropy::OsEntropy;
use channels::zernio::ZernioAccounts;
use content::Locale;
use db::rusqlite::Connection;
use delivery::story_derivatives::DeliveryMedia;
use domain::application::ports::SystemClock;
use domain::delivery::VideoCompletionNotice;
use domain::notifications::ReminderJobs;
use domain::observability::auth_circuit::AuthCircuitBreaker;
use domain::observability::capabilities::CapabilityReadiness;
use domain::observability::usage::UsageRecorder;
use domain::publishing::Boundaries;
use domain::publishing::boundaries::{MediaMetadata, MediaProbe, ProviderOutcome, SystemJitter, VideoProvider};
use domain::story_cards::StoryCardStore;
use domain::studio::boundaries::{StudioBoundaries, YoutubeUploads, ZernioAccount, ZernioDirectory};
use foundation::config::{Config, SharedConfig};
use runtime::ffmpeg::FfmpegMediaProbe;
use runtime::http::HttpClient;
use runtime::worker_signal::WorkerSignals;
use serde_json::Value;

pub struct AppHost {
    auth_circuit: AuthCircuitBreaker<SystemClock>,
    usage: UsageRecorder<SystemClock>,
    story_cards: StoryCardStore<SystemClock>,
    video_completion: VideoCompletionNotice<SystemClock>,
    reminders: ReminderJobs<SystemClock>,
    readiness: CapabilityReadiness,
    connect_links: ConnectLinks<SystemClock, OsEntropy>,
    /// Platform staging and the Story renders; the publish loop's
    /// `MediaPreparation` and Studio's `StoryDerivatives`.
    pub media: DeliveryMedia,
}

impl AppHost {
    pub fn new(config: SharedConfig, http: HttpClient) -> Self {
        Self {
            auth_circuit: AuthCircuitBreaker::new(SystemClock),
            usage: UsageRecorder::new(SystemClock),
            story_cards: StoryCardStore::new(SystemClock),
            video_completion: VideoCompletionNotice::new(SystemClock),
            reminders: ReminderJobs::new(SystemClock),
            readiness: CapabilityReadiness::new(config.clone()),
            connect_links: ConnectLinks::new(SystemClock, OsEntropy),
            media: DeliveryMedia::new(http, config, std::rc::Rc::new(SystemClock)),
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
            bell: &WorkerSignals,
            auth_circuit: &self.auth_circuit,
            usage: &self.usage,
            story_cards: &self.story_cards,
            video_completion: &self.video_completion,
        }
    }

    fn studio(&self) -> StudioBoundaries<'_> {
        StudioBoundaries {
            reminders: &self.reminders,
            story_derivatives: &self.media,
            readiness: &self.readiness,
            connect_links: &self.connect_links,
        }
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
