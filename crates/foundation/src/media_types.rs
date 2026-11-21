/// The lowercased extension of the last path segment of a file name or URL,
/// dot included, ignoring a query or fragment; empty when the name has none or
/// is a dotfile.
pub fn file_extension(value: &str) -> String {
    let name = &value[value.rfind(['/', '\\']).map_or(0, |slash| slash + 1)..];
    let name = &name[..name.find(['?', '#']).unwrap_or(name.len())];
    match name.rfind('.') {
        Some(dot) if dot > 0 => name[dot..].to_lowercase(),
        _ => String::new(),
    }
}

/// The content type a file name's extension implies, for the media this
/// Studio stores and serves.
pub fn media_content_type(value: &str) -> Option<&'static str> {
    match file_extension(value).as_str() {
        ".jpg" | ".jpeg" => Some("image/jpeg"),
        ".png" => Some("image/png"),
        ".webp" => Some("image/webp"),
        ".gif" => Some("image/gif"),
        ".avif" => Some("image/avif"),
        ".mp4" => Some("video/mp4"),
        ".mov" => Some("video/quicktime"),
        ".webm" => Some("video/webm"),
        _ => None,
    }
}

/// The canonical image extension of a file name (`.jpeg` reads as `.jpg`).
pub fn image_extension(value: &str) -> Option<&'static str> {
    match file_extension(value).as_str() {
        ".jpg" | ".jpeg" => Some(".jpg"),
        ".png" => Some(".png"),
        ".webp" => Some(".webp"),
        ".gif" => Some(".gif"),
        ".avif" => Some(".avif"),
        _ => None,
    }
}

pub fn image_extension_for_content_type(content_type: &str) -> Option<&'static str> {
    match content_type {
        "image/png" => Some(".png"),
        "image/webp" => Some(".webp"),
        "image/gif" => Some(".gif"),
        "image/avif" => Some(".avif"),
        "image/jpeg" => Some(".jpg"),
        _ => None,
    }
}
