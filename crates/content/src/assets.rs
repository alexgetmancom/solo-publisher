//! The pure half of Content-owned media storage: which uploads are accepted,
//! how large they may be, and how a stored file is named. Importing a file —
//! hashing it, copying it into the media volume and recording the asset row —
//! belongs with the store that owns that row.

use foundation::errors::StudioError;
use foundation::media_types::{file_extension, image_extension, image_extension_for_content_type};

/// The mounted media volume is sized around this, and the HTTP upload path
/// rejects a larger body before it reads it.
pub const STUDIO_MEDIA_MAX_BYTES: u64 = 1_000_000_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MediaKind {
    Photo,
    Video,
}

impl MediaKind {
    pub fn as_str(self) -> &'static str {
        match self {
            MediaKind::Photo => "photo",
            MediaKind::Video => "video",
        }
    }
}

/// Images of any type and MP4 video, by content type first and file name second.
pub fn media_kind(content_type: &str, filename: &str) -> Option<MediaKind> {
    let value = content_type.to_lowercase();
    if value.starts_with("image/") {
        return Some(MediaKind::Photo);
    }
    if value == "video/mp4" {
        return Some(MediaKind::Video);
    }
    if image_extension(filename).is_some() {
        return Some(MediaKind::Photo);
    }
    (file_extension(filename) == ".mp4").then_some(MediaKind::Video)
}

pub fn media_extension(kind: MediaKind, content_type: &str, filename: &str) -> &'static str {
    match kind {
        MediaKind::Video => ".mp4",
        MediaKind::Photo => image_extension(filename)
            .or_else(|| image_extension_for_content_type(content_type))
            .unwrap_or(".jpg"),
    }
}

/// The base name of an uploaded file, each run of characters outside
/// `[a-zA-Z0-9._-]` replaced by one `-`, cut to 180 characters.
pub fn safe_filename(value: &str) -> String {
    let base = value.trim_end_matches('/');
    let base = &base[base.rfind('/').map_or(0, |slash| slash + 1)..];
    let mut safe = String::new();
    let mut in_run = false;
    for c in base.chars() {
        let kept = c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-');
        if kept {
            safe.push(c);
        } else if !in_run {
            safe.push('-');
        }
        in_run = !kept;
    }
    safe.truncate(180);
    safe
}

/// Refuses an empty file and one larger than the media volume takes.
pub fn check_studio_media_size(byte_size: u64) -> Result<(), StudioError> {
    if byte_size == 0 {
        return Err(StudioError::new("Media file is empty."));
    }
    if byte_size > STUDIO_MEDIA_MAX_BYTES {
        return Err(StudioError::new(format!(
            "Media file is {} MB; Studio accepts files up to {} MB.",
            megabytes(byte_size),
            megabytes(STUDIO_MEDIA_MAX_BYTES)
        )));
    }
    Ok(())
}

fn megabytes(bytes: u64) -> u64 {
    bytes.div_ceil(1024 * 1024)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kind_and_extension_follow_content_type_then_name() {
        for (content_type, filename, kind, extension) in [
            ("image/png", "photo.JPEG", Some(MediaKind::Photo), ".jpg"),
            ("IMAGE/HEIC", "photo.heic", Some(MediaKind::Photo), ".jpg"),
            ("image/webp", "upload", Some(MediaKind::Photo), ".webp"),
            ("video/mp4", "clip.mov", Some(MediaKind::Video), ".mp4"),
            (
                "application/octet-stream",
                "dir.v2/clip.MP4?x=1",
                Some(MediaKind::Video),
                ".mp4",
            ),
            ("", "C:\\photos\\cat.gif", Some(MediaKind::Photo), ".gif"),
            ("video/quicktime", "clip.mov", None, ""),
            ("", ".png", None, ""),
        ] {
            assert_eq!(media_kind(content_type, filename), kind, "{content_type} {filename}");
            if let Some(kind) = kind {
                assert_eq!(media_extension(kind, content_type, filename), extension, "{filename}");
            }
        }
    }

    #[test]
    fn safe_filename_keeps_the_base_name_in_a_safe_alphabet() {
        assert_eq!(safe_filename("/tmp/upload/Фото с отпуска (1).jpg"), "-1-.jpg");
        assert_eq!(safe_filename("a/b/"), "b");
        assert_eq!(safe_filename("my--file  name.mp4"), "my--file-name.mp4");
        assert_eq!(safe_filename("/"), "");
        assert_eq!(safe_filename(&"x".repeat(200)).len(), 180);
    }

    #[test]
    fn size_is_checked_in_mebibytes_rounded_up() {
        assert_eq!(check_studio_media_size(0).unwrap_err().code, "Media file is empty.");
        assert!(check_studio_media_size(1).is_ok());
        assert!(check_studio_media_size(STUDIO_MEDIA_MAX_BYTES).is_ok());
        assert_eq!(
            check_studio_media_size(STUDIO_MEDIA_MAX_BYTES + 1).unwrap_err().code,
            "Media file is 954 MB; Studio accepts files up to 954 MB."
        );
        assert_eq!(
            check_studio_media_size(5_000_000_000).unwrap_err().code,
            "Media file is 4769 MB; Studio accepts files up to 954 MB."
        );
    }
}
