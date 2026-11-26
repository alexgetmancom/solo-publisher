//! What publishing calls but does not own, each as the narrowest trait the
//! code uses. Every one has its real implementation in the area that owns it
//! (delivery, observability, story cards, the media runtime) and a fake in the
//! tests.

use std::future::Future;

use db::rusqlite::Connection;
use serde::Serialize;
use serde_json::Value;

use crate::Result;
use crate::application::ports::StoryPublishMode;

/// Process randomness for retry jitter (`Math.random()`): a value in `[0, 1)`.
pub trait Jitter {
    fn unit(&self) -> f64;
}

/// The operating system's randomness.
pub struct SystemJitter;

impl Jitter for SystemJitter {
    fn unit(&self) -> f64 {
        let mut bytes = [0u8; 8];
        getrandom::getrandom(&mut bytes).expect("the operating system has no randomness source");
        // 53 random bits, as a double in [0, 1).
        (u64::from_le_bytes(bytes) >> 11) as f64 / (1u64 << 53) as f64
    }
}

/// The publish worker's doorbell. A ring made
/// inside a transaction must wake the worker only after the commit; the
/// implementation defers it.
pub trait WorkerBell {
    /// `ringWorker("publish")`.
    fn ring_publish(&self);
    /// `ringWorkerAfter("publish", delayMs)`: a durable `next_attempt_at` is due then.
    fn ring_publish_after(&self, delay_ms: u64);
}

/// What the breaker holds for one target's credential (`AuthCircuitState`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthCircuitState {
    pub target: String,
    /// Publishing to this target is paused until the breaker closes.
    pub blocked: bool,
    pub blocked_until: Option<String>,
    pub auth_failure_streak: i64,
    pub last_auth_failure_at: Option<String>,
    pub last_ping_at: Option<String>,
    pub token_expires_at: Option<String>,
}

/// The credential circuit breaker, told how
/// each settled attempt went and asked what it holds. It owns its table and
/// works on the connection given.
pub trait AuthCircuit {
    fn record_failure(&self, sqlite: &Connection, target: &str) -> Result<()>;
    fn record_success(&self, sqlite: &Connection, target: &str) -> Result<()>;
    /// `authCircuitStates`: every target the breaker has a record for.
    fn states(&self, sqlite: &Connection) -> Result<Vec<AuthCircuitState>>;
}

/// Runtime usage telemetry.
pub trait UsageMeter {
    fn record(&self, sqlite: &Connection, feature_key: &str, success: bool, duration_ms: u64);
    /// `flushUsage`: what is buffered, written now. A meter that buffers
    /// nothing has nothing to write.
    fn flush(&self, _sqlite: &Connection) {}
}

/// A draft's generated Story cards, one per locale, as Story media items.
#[derive(Clone, Debug, PartialEq)]
pub struct StoryCardMedia {
    pub ru: content::message::MediaItem,
    pub en: content::message::MediaItem,
}

/// One generated Story card as a caller reads it: only the fields anyone reads.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoryCardState {
    pub locale: String,
    pub status: String,
    pub local_path: Option<String>,
}

/// Generated Story cards, on the connection given so
/// a caller's transaction covers them.
pub trait StoryCards {
    /// `queueDraftStoryCards`.
    fn queue(&self, sqlite: &Connection, draft_id: i64) -> Result<()>;
    /// `storyCardsForDraft`: every card the draft has.
    fn for_draft(&self, sqlite: &Connection, draft_id: i64) -> Result<Vec<StoryCardState>>;
    /// `readyStoryCardMedia`: both cards, only when both are rendered.
    fn ready_media(&self, sqlite: &Connection, draft_id: i64) -> Result<Option<StoryCardMedia>>;
    /// `setStoryPublishMode`: the operator's answer to where a text-only
    /// post's Story goes, written on the draft.
    fn set_publish_mode(&self, sqlite: &Connection, draft_id: i64, mode: StoryPublishMode) -> Result<()>;
    /// `discardDraftStoryCards`: the rows and their files.
    fn discard(&self, sqlite: &Connection, draft_id: i64) -> Result<()>;
}

/// The video worker's completion notice (`recordVideoCompletionIfFinal`).
pub trait VideoCompletion {
    fn record_if_final(&self, sqlite: &Connection, video_draft_id: i64) -> Result<()>;
}

/// The everything-else a `Publishing` handle carries.
#[derive(Clone, Copy)]
pub struct Boundaries<'a> {
    pub jitter: &'a dyn Jitter,
    pub bell: &'a dyn WorkerBell,
    pub auth_circuit: &'a dyn AuthCircuit,
    pub usage: &'a dyn UsageMeter,
    pub story_cards: &'a dyn StoryCards,
    pub video_completion: &'a dyn VideoCompletion,
}

/// What the provider reports about a publication it holds.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProviderOutcome {
    pub provider_post_id: Option<String>,
    pub external_id: Option<String>,
    pub url: Option<String>,
    pub failure: Option<String>,
}

/// The video publication provider: the two calls
/// settling a video target makes. Requests are fenced by `request_id`, so
/// asking twice returns the publication already made.
pub trait VideoProvider {
    /// `zernioPostOutcome(config, providerPostId, platform)`.
    fn post_outcome(&self, provider_post_id: &str, platform: &str) -> impl Future<Output = Result<ProviderOutcome>>;
    /// `publishZernioInstagramReel(config, { accountId, publicUrl, metadata, requestId })`;
    /// `failure` is always `None` in its answer.
    fn publish_instagram_reel(
        &self,
        account_id: &str,
        public_url: &str,
        metadata: &Value,
        request_id: &str,
    ) -> impl Future<Output = Result<ProviderOutcome>>;
}

/// What probing a media file answered.
#[derive(Clone, Debug, PartialEq)]
pub struct MediaMetadata {
    pub width: f64,
    pub height: f64,
    pub duration_seconds: f64,
    pub video_codec: String,
    pub audio_codec: Option<String>,
    pub fps: f64,
    /// The audio stream's bit rate, when ffprobe reports a positive one.
    pub audio_bitrate: Option<f64>,
}

/// ffprobe and ffmpeg, as the video checks call them.
pub trait MediaProbe {
    /// `probeMediaMetadata(path)`; the error message is ffprobe's.
    fn probe(&self, path: &str) -> impl Future<Output = std::result::Result<MediaMetadata, String>>;
    /// `runFfmpegCapture([...astats...])` decoded as text.
    fn audio_stats(&self, path: &str) -> impl Future<Output = std::result::Result<String, String>>;
}
