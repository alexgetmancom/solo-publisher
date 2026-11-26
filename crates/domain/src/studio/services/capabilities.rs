//! The safe capability read model for Studio interfaces and AI operators.
//! It reports enabled features and
//! readiness, never configured values or secret names.

use content::Locale;
use serde::Serialize;

use crate::Result;
use crate::channels::list_channels;
use crate::publishing::platform_profiles::PLATFORM_PROFILES;
use crate::publishing::video_types::VIDEO_TARGETS;
use crate::studio::Studio;
use crate::studio::boundaries::{CapabilityReportEntry, CapabilityStatus};
use crate::targets::TargetKind;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct PlatformCapabilities {
    pub text: bool,
    pub image: bool,
    pub video: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct PlatformReadiness {
    pub id: &'static str,
    pub label: &'static str,
    #[serde(with = "crate::json::locale")]
    pub locale: Locale,
    pub kind: &'static str,
    pub capabilities: PlatformCapabilities,
    pub status: CapabilityStatus,
    pub missing: usize,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct VideoChannelReadiness {
    pub id: String,
    pub target: Option<&'static str>,
    pub locale: String,
    pub status: CapabilityStatus,
    pub missing: usize,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct MediaProcessorReadiness {
    pub provider: &'static str,
    pub status: CapabilityStatus,
    pub missing: usize,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CapabilityReport {
    pub site_enabled: bool,
    pub platforms: Vec<PlatformReadiness>,
    pub video: Vec<VideoChannelReadiness>,
    pub media_processor: MediaProcessorReadiness,
}

pub(crate) fn target_kind(kind: TargetKind) -> &'static str {
    match kind {
        TargetKind::Telegram => "telegram",
        TargetKind::Site => "site",
        TargetKind::Social => "social",
    }
}

#[derive(Clone, Copy)]
pub struct CapabilityService<'a> {
    studio: Studio<'a>,
}

impl<'a> CapabilityService<'a> {
    pub fn new(studio: Studio<'a>) -> Self {
        Self { studio }
    }

    pub fn report(&self) -> Result<CapabilityReport> {
        let studio = &self.studio;
        let readiness = studio.boundaries.readiness.capability_report(studio.sqlite())?;
        let state =
            |target: &str| -> Option<&CapabilityReportEntry> { readiness.iter().find(|entry| entry.target == target) };
        let channels = list_channels(studio.sqlite(), true)?;
        let registered: Vec<&str> = channels
            .iter()
            .filter_map(|channel| channel.connection.target_id.as_deref())
            .collect();
        let platforms = PLATFORM_PROFILES
            .iter()
            .filter(|profile| registered.is_empty() || registered.contains(&profile.id))
            .map(|profile| PlatformReadiness {
                id: profile.id,
                label: profile.label,
                locale: profile.locale,
                kind: target_kind(profile.kind),
                capabilities: PlatformCapabilities {
                    text: profile.capabilities.text,
                    image: profile.capabilities.image,
                    video: profile.capabilities.video,
                },
                status: state(profile.id).map_or(CapabilityStatus::Ready, |entry| entry.status),
                missing: state(profile.id).map_or(0, |entry| entry.missing.len()),
            })
            .collect();
        let video = channels
            .iter()
            .filter(|channel| matches!(channel.connection.platform.as_str(), "youtube" | "instagram"))
            .map(|channel| {
                let entry = state(&channel.connection.id);
                VideoChannelReadiness {
                    id: channel.connection.id.clone(),
                    target: VIDEO_TARGETS
                        .iter()
                        .find(|target| target.platform() == channel.connection.platform)
                        .map(|target| target.as_str()),
                    locale: channel.connection.locale.clone(),
                    status: entry.map_or(CapabilityStatus::Missing, |entry| entry.status),
                    missing: entry.map_or(0, |entry| entry.missing.len()),
                }
            })
            .collect();
        let processor = state("media_processor");
        Ok(CapabilityReport {
            site_enabled: crate::studio::config::studio_config(studio.ports()).site_enabled()?,
            platforms,
            video,
            media_processor: MediaProcessorReadiness {
                provider: studio.config.media_processor_provider.as_str(),
                status: processor.map_or(CapabilityStatus::Ready, |entry| entry.status),
                missing: processor.map_or(0, |entry| entry.missing.len()),
            },
        })
    }
}
