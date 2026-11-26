//! The video a platform importer fetches by content hash while it imports a Reel.
//! Anything that is not a video under that hash does not exist here.

use db::rusqlite::OptionalExtension;
use db::{BackendDb, unsafe_db};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VideoAsset {
    pub local_path: String,
    pub mime_type: Option<String>,
}

/// `publicVideoAsset(backendDb, sha256)`: the first asset stored under the hash,
/// when it is a video.
pub fn public_video_asset(db: &BackendDb, sha256: &str) -> domain::Result<Option<VideoAsset>> {
    let asset = unsafe_db(db)
        .query_row(
            r#"select "kind", "local_path", "mime_type" from "studio_media_assets" where "studio_media_assets"."sha256" = ?"#,
            [sha256],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    VideoAsset {
                        local_path: row.get(1)?,
                        mime_type: row.get(2)?,
                    },
                ))
            },
        )
        .optional()?;
    Ok(asset.and_then(|(kind, asset)| (kind == "video").then_some(asset)))
}
