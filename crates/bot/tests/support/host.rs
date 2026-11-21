//! The golden host: the boundaries and adapters Studio calls but the bot does
//! not own. Only what the ported areas reach is implemented; anything else
//! panics with its name, so a case that reaches it fails loudly instead of
//! diverging quietly. An area that needs one implements it here, the way the
//! TypeScript bot behaved under the recorder.

use std::cell::Cell;

use bot::{Adapters, Fut, Host};
use content::Locale;
use db::rusqlite::Connection;
use domain::application::ports::{Clock, StoryPublishMode};
use domain::publishing::Boundaries;
use domain::publishing::boundaries::{
    AuthCircuit, AuthCircuitState, Jitter, MediaMetadata, ProviderOutcome, StoryCardMedia, StoryCardState, StoryCards,
    UsageMeter, VideoCompletion, WorkerBell,
};
use domain::studio::boundaries::{
    CapabilityReportEntry, ChannelConnectLinks, ConnectPlatform, ConnectStart, MetaOauthPlatform, Readiness, Reminder,
    Reminders, StoryDerivatives, StudioBoundaries, ZernioAccount,
};
use foundation::config::Config;
use jiff::Timestamp;
use serde_json::Value;

pub struct FixedClock(pub Cell<Timestamp>);

impl Clock for FixedClock {
    fn now(&self) -> Timestamp {
        self.0.get()
    }
}

fn not_in_host(what: &str) -> ! {
    panic!(
        "{what} is not implemented in the golden host (crates/bot/tests/support/host.rs); the area that reaches it adds it"
    )
}

pub struct GoldenHost;

impl Jitter for GoldenHost {
    fn unit(&self) -> f64 {
        not_in_host("retry jitter")
    }
}

/// Ringing the publish worker has no visible effect in a golden.
impl WorkerBell for GoldenHost {
    fn ring_publish(&self) {}
    fn ring_publish_after(&self, _: u64) {}
}

impl AuthCircuit for GoldenHost {
    fn record_failure(&self, _: &Connection, _: &str) -> domain::Result<()> {
        not_in_host("the credential breaker")
    }
    fn record_success(&self, _: &Connection, _: &str) -> domain::Result<()> {
        not_in_host("the credential breaker")
    }
    fn states(&self, _: &Connection) -> domain::Result<Vec<AuthCircuitState>> {
        not_in_host("the credential breaker")
    }
}

/// Usage counters are observability rows no golden shows.
impl UsageMeter for GoldenHost {
    fn record(&self, _: &Connection, _: &str, _: bool, _: u64) {}
}

impl StoryCards for GoldenHost {
    fn queue(&self, _: &Connection, _: i64) -> domain::Result<()> {
        not_in_host("Story cards")
    }
    fn for_draft(&self, _: &Connection, _: i64) -> domain::Result<Vec<StoryCardState>> {
        not_in_host("Story cards")
    }
    fn set_publish_mode(&self, _: &Connection, _: i64, _: StoryPublishMode) -> domain::Result<()> {
        not_in_host("Story cards")
    }
    fn ready_media(&self, _: &Connection, _: i64) -> domain::Result<Option<StoryCardMedia>> {
        not_in_host("Story cards")
    }
    fn discard(&self, _: &Connection, _: i64) -> domain::Result<()> {
        not_in_host("Story cards")
    }
}

impl VideoCompletion for GoldenHost {
    fn record_if_final(&self, _: &Connection, _: i64) -> domain::Result<()> {
        not_in_host("video completion")
    }
}

impl Reminders for GoldenHost {
    fn schedule(&self, _: &Connection, _: &Reminder<'_>) -> domain::Result<()> {
        not_in_host("reminders")
    }
    fn cancel(&self, _: &Connection, _: &str) -> domain::Result<()> {
        not_in_host("reminders")
    }
}

impl StoryDerivatives for GoldenHost {
    fn ensure(&self, _: &str, _: bool, _: i64) {
        not_in_host("Story derivatives")
    }
}

impl Readiness for GoldenHost {
    fn capability_report(&self, _: &Connection) -> domain::Result<Vec<CapabilityReportEntry>> {
        not_in_host("the readiness report")
    }
}

impl ChannelConnectLinks for GoldenHost {
    fn meta_oauth_connect_url(&self, _: &Config, _: MetaOauthPlatform, _: Locale) -> domain::Result<String> {
        not_in_host("connection links")
    }
    fn meta_oauth_connect_path(&self, _: &Config, _: MetaOauthPlatform, _: Locale) -> domain::Result<String> {
        not_in_host("connection links")
    }
    fn x_oauth_connect_url(&self, _: &Config) -> domain::Result<String> {
        not_in_host("connection links")
    }
    fn x_oauth_connect_path(&self, _: &Config) -> domain::Result<String> {
        not_in_host("connection links")
    }
    fn start_connect(&self, _: &Config, _: ConnectPlatform, _: Locale, _: Timestamp) -> domain::Result<ConnectStart> {
        not_in_host("connection links")
    }
}

impl Host for GoldenHost {
    fn publishing(&self) -> Boundaries<'_> {
        Boundaries {
            jitter: self,
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

pub struct GoldenAdapters;

impl Adapters for GoldenAdapters {
    fn probe<'a>(&'a self, _: &'a str) -> Fut<'a, Result<MediaMetadata, String>> {
        not_in_host("ffprobe")
    }
    fn audio_stats<'a>(&'a self, _: &'a str) -> Fut<'a, Result<String, String>> {
        not_in_host("ffmpeg")
    }
    fn post_outcome<'a>(&'a self, _: &'a str, _: &'a str) -> Fut<'a, domain::Result<ProviderOutcome>> {
        not_in_host("the video provider")
    }
    fn publish_instagram_reel<'a>(
        &'a self,
        _: &'a str,
        _: &'a str,
        _: &'a Value,
        _: &'a str,
    ) -> Fut<'a, domain::Result<ProviderOutcome>> {
        not_in_host("the video provider")
    }
    fn keep_youtube_private<'a>(&'a self, _: &'a Config, _: &'a str, _: Locale) -> Fut<'a, domain::Result<()>> {
        not_in_host("YouTube uploads")
    }
    fn zernio_accounts<'a>(&'a self, _: &'a Config) -> Fut<'a, domain::Result<Vec<ZernioAccount>>> {
        not_in_host("the Zernio directory")
    }
}
