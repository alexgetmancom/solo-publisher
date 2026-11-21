//! What the channel registry answers publishing (`channels/registry.ts`,
//! `channelUploadLimits`): which targets this Studio has a connection for,
//! which account a video goes to, and how large an attachment each channel
//! takes. Registering and disabling channels belongs to the Studio's channel
//! service.

use db::rusqlite::Connection;

use crate::Result;
use crate::application::ports::ChannelConnectionRecord;
use crate::publishing::preflight::UploadLimits;
use crate::publishing::video_types::VideoTarget;
use crate::repositories::ChannelStore;
use crate::targets::{TARGETS, TargetMap, story_targets_enabled, target_connection};

/// Every publication target this Studio publishes text or Stories to. A
/// connection delivers every target that names it: one connected X account
/// serves both the post target and the Article target.
pub fn registered_post_target_ids(sqlite: &Connection) -> Result<Vec<String>> {
    let connections: Vec<String> = ChannelStore::new(sqlite)
        .list(true)?
        .into_iter()
        .filter_map(|channel| channel.connection.target_id)
        .collect();
    Ok(TARGETS
        .iter()
        .filter(|target| connections.iter().any(|id| id == target_connection(target.id)))
        .map(|target| target.id.to_owned())
        .collect())
}

/// The registry is the only source of enabled publication targets.
pub fn effective_post_targets(sqlite: &Connection, targets: &TargetMap) -> Result<TargetMap> {
    let registered = registered_post_target_ids(sqlite)?;
    Ok(targets.map(|target, enabled| enabled && registered.iter().any(|id| id == target)))
}

/// Whether this publication goes to a Story, asked of its own targets
/// narrowed by the registry.
pub fn publishes_story(sqlite: &Connection, targets_json: &str) -> Result<bool> {
    Ok(story_targets_enabled(&effective_post_targets(
        sqlite,
        &TargetMap::parse(Some(targets_json)),
    )?))
}

pub fn channel_for_video(
    sqlite: &Connection,
    target: VideoTarget,
    locale: &str,
) -> Result<Option<ChannelConnectionRecord>> {
    ChannelStore::new(sqlite).find(target.platform(), locale)
}

/// The attachment limit each connected channel reported for itself.
pub fn channel_upload_limits(sqlite: &Connection) -> Result<UploadLimits> {
    let mut statement = sqlite.prepare(r#"select "target", "upload_limit_bytes" from "platform_tokens""#)?;
    let rows = statement.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<i64>>(1)?)))?;
    let mut limits = UploadLimits::new();
    for row in rows {
        if let (target, Some(bytes)) = row? {
            limits.insert(target, bytes.max(0) as u64);
        }
    }
    Ok(limits)
}
