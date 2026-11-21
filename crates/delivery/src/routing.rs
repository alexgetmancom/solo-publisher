//! What the channel registry tells delivery (`channels/registry.ts`
//! `targetRouting`, `channels/destinations.ts` `videoChannelIdentity`).

use adapters::{Route, TargetRouting};
use db::rusqlite::Connection;
use domain::channels::list_channels;
use domain::publishing::video_types::VideoTarget;
use domain::repositories::ChannelStore;

use crate::Result;

/// `targetRouting`: how each connected target is delivered. A later
/// connection naming the same target replaces the earlier one in its place,
/// as assigning a record key does.
pub fn target_routing(sqlite: &Connection) -> Result<TargetRouting> {
    let mut routes: Vec<(String, Route)> = Vec::new();
    for channel in list_channels(sqlite, true)? {
        let connection = channel.connection;
        let Some(target) = connection.target_id.filter(|target| !target.is_empty()) else {
            continue;
        };
        let route = Route {
            provider: connection.provider,
            account_id: connection.provider_account_id,
        };
        match routes.iter_mut().find(|(name, _)| *name == target) {
            Some(entry) => entry.1 = route,
            None => routes.push((target, route)),
        }
    }
    Ok(TargetRouting(routes))
}

/// `videoChannelIdentity`: the connected account a video target's
/// credential checks and failures name; the deterministic `<platform>_<locale>`
/// when the registry row is gone.
pub fn video_channel_identity(sqlite: &Connection, target: VideoTarget, locale: &str) -> Result<String> {
    let platform = target.platform();
    Ok(ChannelStore::new(sqlite)
        .find(platform, locale)?
        .map_or_else(|| format!("{platform}_{locale}"), |channel| channel.connection.id))
}
