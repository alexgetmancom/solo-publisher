//! Video-target vocabulary, independent of any interface.

use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum VideoTarget {
    YoutubeShorts,
    InstagramReels,
}

pub const VIDEO_TARGETS: [VideoTarget; 2] = [VideoTarget::YoutubeShorts, VideoTarget::InstagramReels];

impl VideoTarget {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::YoutubeShorts => "youtube_shorts",
            Self::InstagramReels => "instagram_reels",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        VIDEO_TARGETS.into_iter().find(|target| target.as_str() == value)
    }

    /// The provider platform for each durable video target.
    pub fn platform(self) -> &'static str {
        match self {
            Self::YoutubeShorts => "youtube",
            Self::InstagramReels => "instagram",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::YoutubeShorts => "YouTube Shorts",
            Self::InstagramReels => "Instagram Reels",
        }
    }
}

/// Platforms a Studio can hold an account for. The video pipeline publishes
/// to YouTube and Instagram; TikTok is only ever collected from, through a
/// provider, so it is a channel that is never a delivery target.
pub const ACCOUNT_PLATFORMS: [&str; 3] = ["instagram", "tiktok", "youtube"];

/// Above this a vertical clip is almost always a bad cut, not an intent, so it
/// is asked about and never refused.
pub const VIDEO_LENGTH_WARNING_SECONDS: u32 = 90;

/// What probing a video file answered: the shape a card shows and a schedule checks.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoTechnicalCheck {
    pub width: f64,
    pub height: f64,
    pub seconds: f64,
    pub video_codec: String,
    pub audio_codec: Option<String>,
    pub fps: f64,
    pub size_bytes: u64,
    pub aspect_ok: bool,
    pub background_music_likely_missing: bool,
}
