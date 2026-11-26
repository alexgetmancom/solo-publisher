//! The Studio service layer shared by the Telegram bot, MCP and the CLI
//! (`studio/services/**`): one capability set for every interface, so only
//! rendering and transport live outside it.

pub mod capabilities;
pub mod channels;
pub mod media;
pub mod post_access;
pub mod post_progress;
pub mod posts;
pub mod queue;
pub mod settings;
pub mod videos;

use capabilities::CapabilityService;
use channels::ChannelService;
use media::MediaService;
use posts::PostService;
use queue::QueueService;
use settings::SettingsService;
use videos::VideoService;

use super::Studio;
use super::boundaries::{YoutubeUploads, ZernioDirectory};
use crate::publishing::boundaries::{MediaProbe, VideoProvider};

/// Every Studio service over one handle and one set of adapters.
#[derive(Clone, Copy)]
pub struct StudioServices<'a, A> {
    pub posts: PostService<'a>,
    pub media: MediaService<'a>,
    pub channels: ChannelService<'a, A>,
    pub videos: VideoService<'a, A>,
    pub queue: QueueService<'a>,
    pub capabilities: CapabilityService<'a>,
    pub settings: SettingsService<'a>,
}

/// `createStudioServices`.
pub fn create_studio_services<'a, A: MediaProbe + VideoProvider + YoutubeUploads + ZernioDirectory>(
    studio: Studio<'a>,
    adapters: &'a A,
) -> StudioServices<'a, A> {
    StudioServices {
        posts: PostService::new(studio),
        media: MediaService::new(studio),
        channels: ChannelService::new(studio, adapters),
        videos: VideoService::new(studio, adapters),
        queue: QueueService::new(studio),
        capabilities: CapabilityService::new(studio),
        settings: SettingsService::new(studio.ports()),
    }
}
