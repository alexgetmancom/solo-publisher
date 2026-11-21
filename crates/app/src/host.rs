//! The host of this build: the ported stores behind Studio's and publishing's
//! boundaries (`domain::story_cards`, `domain::notifications`, the credential
//! breaker, the readiness report, runtime usage, the video completion
//! notice), the worker doorbells, connect links, and the process's media
//! runtime (`delivery::story_derivatives::DeliveryMedia`), plus the adapters
//! Studio waits on.

use std::rc::Rc;

use adapters::telegram_stories::{SidecarError, StoryRequest};
use adapters::{HttpStoriesSidecar, StoriesSidecar};
use bot::{Fut, Host};
use channels::connect::ConnectLinks;
use channels::entropy::OsEntropy;
use db::rusqlite::Connection;
use delivery::story_derivatives::DeliveryMedia;
use domain::application::ports::SystemClock;
use domain::delivery::VideoCompletionNotice;
use domain::notifications::ReminderJobs;
use domain::observability::auth_circuit::AuthCircuitBreaker;
use domain::observability::capabilities::CapabilityReadiness;
use domain::observability::usage::UsageRecorder;
use domain::publishing::Boundaries;
use domain::publishing::boundaries::SystemJitter;
use domain::story_cards::StoryCardStore;
use domain::studio::boundaries::StudioBoundaries;
use foundation::config::{Config, SharedConfig};
use runtime::http::HttpClient;
use runtime::worker_signal::WorkerSignals;

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
            media: DeliveryMedia::new(http, config, Rc::new(SystemClock)),
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

/// Where Telegram channel Stories go out: the sidecar the entrypoint starts,
/// or, without one configured, a refusal naming the settings.
pub fn stories_sidecar(http: HttpClient, config: &Config) -> Rc<dyn StoriesSidecar> {
    match (
        config.stories_sidecar_url.as_deref(),
        config.stories_sidecar_token.as_deref(),
    ) {
        (Some(url), Some(token)) => Rc::new(HttpStoriesSidecar::new(http, url, token)),
        _ => Rc::new(NoStoriesSidecar),
    }
}

/// Nothing is sent, so the Story fails plainly rather than as ambiguous.
struct NoStoriesSidecar;

impl StoriesSidecar for NoStoriesSidecar {
    fn send_story<'a>(&'a self, _: &'a StoryRequest) -> Fut<'a, Result<i64, SidecarError>> {
        Box::pin(async {
            Err(SidecarError::Refused(
                "Telegram Stories sidecar is not configured: set STORIES_SIDECAR_URL and STORIES_SIDECAR_TOKEN".into(),
            ))
        })
    }
}
