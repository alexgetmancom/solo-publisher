//! The host of this build: the stores behind Studio's and publishing's
//! boundaries (`domain::story_cards`, `domain::notifications`, the credential
//! breaker, the readiness report, runtime usage, the video completion
//! notice), the worker doorbells, connect links, and the process's media
//! runtime (`delivery::story_derivatives::DeliveryMedia`), plus the adapters
//! Studio waits on.

use std::rc::Rc;

use bot::Host;
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
use foundation::config::SharedConfig;
use runtime::http::HttpClient;
use runtime::worker_signal::WorkerSignals;

pub(crate) struct AppHost {
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
    pub(crate) fn new(config: SharedConfig, http: HttpClient) -> Self {
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
    pub(crate) fn flush_usage(&self, sqlite: &Connection) {
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
