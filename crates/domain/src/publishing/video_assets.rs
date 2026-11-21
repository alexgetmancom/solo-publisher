//! Where a video's source file is, and the address platforms fetch it from
//! (`content/video-assets.ts`).

use db::rusqlite::Connection;
use foundation::config::Config;

use crate::repositories::StudioMediaAssetStore;
use crate::{Error, Result};

/// The source file on this host, when it is still a video and still here.
pub fn video_source_path(sqlite: &Connection, studio_media_asset_id: Option<i64>) -> Result<Option<String>> {
    let Some(id) = studio_media_asset_id else {
        return Ok(None);
    };
    Ok(StudioMediaAssetStore::new(sqlite)
        .get(id)?
        .filter(|asset| asset.asset.kind == "video" && std::path::Path::new(&asset.asset.local_path).exists())
        .map(|asset| asset.asset.local_path))
}

/// The public media route is content-addressed by sha256 so the unguessable
/// digest, not the enumerable asset id, is what grants read access.
pub fn video_public_url(sqlite: &Connection, config: &Config, studio_media_asset_id: Option<i64>) -> Result<String> {
    let base = config
        .public_base_url
        .strip_suffix('/')
        .unwrap_or(&config.public_base_url);
    let asset = match studio_media_asset_id {
        Some(id) => StudioMediaAssetStore::new(sqlite).get(id)?,
        None => None,
    };
    let asset = asset.ok_or_else(|| {
        Error::message(format!(
            "Studio media asset {} has no public URL",
            studio_media_asset_id.map_or("null".to_owned(), |id| id.to_string())
        ))
    })?;
    Ok(format!("{base}/media/video/asset/{}", asset.asset.sha256))
}
