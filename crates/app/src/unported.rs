//! The boundaries Studio calls whose real implementation belongs to an area
//! this build does not contain yet. Each one refuses with
//! `not available in this build: <area>`, which the bot shows as the error it
//! is; none pretends the work happened. The three that return nothing (the
//! worker bell, usage telemetry, Story derivatives) log instead.

use std::sync::atomic::{AtomicBool, Ordering};

use bot::{Adapters, Fut, Host};
use content::Locale;
use db::rusqlite::Connection;
use domain::application::ports::StoryPublishMode;
use domain::publishing::Boundaries;
use domain::publishing::boundaries::{
    AuthCircuit, AuthCircuitState, MediaMetadata, ProviderOutcome, StoryCardMedia, StoryCardState, StoryCards,
    SystemJitter, UsageMeter, VideoCompletion, WorkerBell,
};
use domain::studio::boundaries::{
    CapabilityReportEntry, ChannelConnectLinks, ConnectPlatform, ConnectStart, MetaOauthPlatform, Readiness, Reminder,
    Reminders, StoryDerivatives, StudioBoundaries, ZernioAccount,
};
use foundation::config::Config;
use foundation::logger::{LogLevel, log};
use jiff::Timestamp;
use serde_json::{Value, json};

const PUBLISH_WORKER: &str = "publish worker";
const CREDENTIAL_BREAKER: &str = "credential breaker (observability)";
const USAGE: &str = "usage telemetry (observability)";
const STORY_CARDS: &str = "Story cards";
const VIDEO_COMPLETION: &str = "video completion notices";
const REMINDERS: &str = "publication reminders (notifications)";
const STORY_DERIVATIVES: &str = "Story derivatives (media runtime)";
const READINESS: &str = "readiness report (observability)";
const CONNECT_LINKS: &str = "channel connect links (channels)";
const MEDIA_PROBE: &str = "media probe (ffprobe/ffmpeg)";
const ZERNIO: &str = "Zernio";
const YOUTUBE: &str = "YouTube uploads";

/// Every area above, for the startup line.
pub const AREAS: [&str; 12] = [
    PUBLISH_WORKER,
    CREDENTIAL_BREAKER,
    USAGE,
    STORY_CARDS,
    VIDEO_COMPLETION,
    REMINDERS,
    STORY_DERIVATIVES,
    READINESS,
    CONNECT_LINKS,
    MEDIA_PROBE,
    ZERNIO,
    YOUTUBE,
];

fn message(area: &str) -> String {
    format!("not available in this build: {area}")
}

fn refuse<T>(area: &str) -> domain::Result<T> {
    Err(domain::Error::message(message(area)))
}

/// The host of this build: real process randomness, everything else refused.
pub struct AppHost;

impl Host for AppHost {
    fn publishing(&self) -> Boundaries<'_> {
        Boundaries {
            jitter: &SystemJitter,
            bell: self,
            auth_circuit: self,
            usage: self,
            story_cards: self,
            video_completion: self,
        }
    }

    fn studio(&self) -> StudioBoundaries<'_> {
        StudioBoundaries {
            reminders: self,
            story_derivatives: self,
            readiness: self,
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

impl AuthCircuit for AppHost {
    fn record_failure(&self, _: &Connection, _: &str) -> domain::Result<()> {
        refuse(CREDENTIAL_BREAKER)
    }
    fn record_success(&self, _: &Connection, _: &str) -> domain::Result<()> {
        refuse(CREDENTIAL_BREAKER)
    }
    fn states(&self, _: &Connection) -> domain::Result<Vec<AuthCircuitState>> {
        refuse(CREDENTIAL_BREAKER)
    }
}

/// Recorded after every update, so it says so once rather than per update.
impl UsageMeter for AppHost {
    fn record(&self, _: &Connection, _: &str, _: bool, _: u64) {
        static WARNED: AtomicBool = AtomicBool::new(false);
        if !WARNED.swap(true, Ordering::Relaxed) {
            log(
                LogLevel::Warn,
                &message(USAGE),
                Some(json!({"hint": "usage records are dropped; said once per process"})),
            );
        }
    }
}

impl StoryCards for AppHost {
    fn queue(&self, _: &Connection, _: i64) -> domain::Result<()> {
        refuse(STORY_CARDS)
    }
    fn for_draft(&self, _: &Connection, _: i64) -> domain::Result<Vec<StoryCardState>> {
        refuse(STORY_CARDS)
    }
    fn ready_media(&self, _: &Connection, _: i64) -> domain::Result<Option<StoryCardMedia>> {
        refuse(STORY_CARDS)
    }
    fn set_publish_mode(&self, _: &Connection, _: i64, _: StoryPublishMode) -> domain::Result<()> {
        refuse(STORY_CARDS)
    }
    fn discard(&self, _: &Connection, _: i64) -> domain::Result<()> {
        refuse(STORY_CARDS)
    }
}

impl VideoCompletion for AppHost {
    fn record_if_final(&self, _: &Connection, _: i64) -> domain::Result<()> {
        refuse(VIDEO_COMPLETION)
    }
}

impl Reminders for AppHost {
    fn schedule(&self, _: &Connection, _: &Reminder<'_>) -> domain::Result<()> {
        refuse(REMINDERS)
    }
    fn cancel(&self, _: &Connection, _: &str) -> domain::Result<()> {
        refuse(REMINDERS)
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

impl Readiness for AppHost {
    fn capability_report(&self, _: &Connection) -> domain::Result<Vec<CapabilityReportEntry>> {
        refuse(READINESS)
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

/// The adapters Studio waits on; none is ported yet.
pub struct AppAdapters;

impl Adapters for AppAdapters {
    fn probe<'a>(&'a self, _: &'a str) -> Fut<'a, Result<MediaMetadata, String>> {
        Box::pin(async { Err(message(MEDIA_PROBE)) })
    }
    fn audio_stats<'a>(&'a self, _: &'a str) -> Fut<'a, Result<String, String>> {
        Box::pin(async { Err(message(MEDIA_PROBE)) })
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
