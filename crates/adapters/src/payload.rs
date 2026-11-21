//! `delivery/social/payload.ts`. The readers themselves (`payloadText`,
//! `payloadThread`, `payloadMedia`) live in `domain::publishing::payload`,
//! where preflight reads the same payload; these are the file helpers only
//! delivery needs.

use content::message::MediaItem;
use foundation::media_types::{file_extension, media_content_type};

pub use domain::publishing::payload::{payload_media, payload_text, payload_thread};

/// A media item's text field, when set (`item.localPath`, `item.vpsUrl`, …).
pub fn field<'a>(item: &'a MediaItem, key: &str) -> Option<&'a str> {
    crate::js::non_empty(item, key)
}

pub fn is_video(item: &MediaItem) -> bool {
    field(item, "type") == Some("VIDEO")
}

/// `mediaExtension`: the local file's extension, else the type's default.
pub fn media_extension(item: &MediaItem) -> String {
    if let Some(path) = field(item, "localPath") {
        let extension = file_extension(path);
        if !extension.is_empty() {
            return extension;
        }
    }
    if is_video(item) { ".mp4" } else { ".jpg" }.to_owned()
}

/// `guessContentType`.
pub fn guess_content_type(path: &str) -> &'static str {
    media_content_type(path).unwrap_or("application/octet-stream")
}

/// `path.basename`.
pub fn basename(path: &str) -> &str {
    path.trim_end_matches('/').rsplit('/').next().unwrap_or(path)
}

/// `fs.existsSync(path)`.
pub fn exists(path: &str) -> bool {
    std::path::Path::new(path).exists()
}
