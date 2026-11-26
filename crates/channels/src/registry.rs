//! The registry answers the channels part of the Studio owns beyond what
//! `domain::channels` reads for publishing (identity, destinations and
//! target routing).

use std::collections::BTreeMap;

use content::Locale;
use db::rusqlite::Connection;
use domain::channels::list_channels;
use domain::publishing::video_types::{VIDEO_TARGETS, VideoTarget};
use domain::repositories::ChannelStore;
use serde::Serialize;

use crate::Result;

/// `channelIdentity`: the durable identity a platform connection, its
/// credential and its analytics profile share (`youtube_ru`, `threads_en`).
pub fn channel_identity(platform: &str, locale: Locale) -> String {
    format!("{platform}_{}", locale.as_str())
}

/// How a connected text or Story target is delivered.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TargetRoute {
    pub provider: String,
    pub account_id: Option<String>,
}

/// `targetRouting`: the provider and account of each connected target, by
/// target id. Delivery reads this, not the registry.
pub fn target_routing(sqlite: &Connection) -> Result<BTreeMap<String, TargetRoute>> {
    let mut routing = BTreeMap::new();
    for channel in list_channels(sqlite, true)? {
        let channel = channel.connection;
        if let Some(target) = channel.target_id {
            routing.insert(
                target,
                TargetRoute {
                    provider: channel.provider,
                    account_id: channel.provider_account_id,
                },
            );
        }
    }
    Ok(routing)
}

/// One video destination this Studio actually has.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct VideoDestination {
    pub target: &'static str,
    pub locale: &'static str,
    pub label: String,
    /// The connection id, which is also the key its audience snapshots use.
    pub profile: String,
}

fn video_target_of(platform: &str) -> Option<VideoTarget> {
    VIDEO_TARGETS.into_iter().find(|target| target.platform() == platform)
}

/// `isPublishableVideoPlatform`.
pub fn is_publishable_video_platform(platform: &str) -> bool {
    video_target_of(platform).is_some()
}

/// `videoDestinations`: by video target, then Russian before English.
pub fn video_destinations(sqlite: &Connection) -> Result<Vec<VideoDestination>> {
    let mut destinations: Vec<(usize, VideoDestination)> = list_channels(sqlite, true)?
        .into_iter()
        .filter_map(|channel| {
            let channel = channel.connection;
            let target = video_target_of(&channel.platform)?;
            let order = VIDEO_TARGETS.iter().position(|candidate| *candidate == target)?;
            Some((
                order,
                VideoDestination {
                    target: target.as_str(),
                    locale: if channel.locale == "en" { "en" } else { "ru" },
                    label: channel.label,
                    profile: channel.id,
                },
            ))
        })
        .collect();
    destinations.sort_by(|(left_order, left), (right_order, right)| {
        left_order
            .cmp(right_order)
            .then_with(|| (left.locale == "en").cmp(&(right.locale == "en")))
    });
    Ok(destinations.into_iter().map(|(_, destination)| destination).collect())
}

/// `videoChannelIdentity`: the connected account a video target and locale
/// name; historical work can outlive a disabled row, so the deterministic id
/// stands in.
pub fn video_channel_identity(sqlite: &Connection, target: VideoTarget, locale: Locale) -> Result<String> {
    Ok(ChannelStore::new(sqlite)
        .find(target.platform(), locale.as_str())?
        .map_or_else(
            || channel_identity(target.platform(), locale),
            |channel| channel.connection.id,
        ))
}
