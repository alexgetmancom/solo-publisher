//! `Bun.file(path).type` for the files `/media/*` serves: the type Bun's table
//! gives the extension (case-insensitive), `application/octet-stream` for any
//! other. The table holds the media, document and font types this Studio can
//! hold, each recorded from Bun 1.4.

pub(crate) fn bun_file_type(path: &str) -> &'static str {
    let name = path.rsplit('/').next().unwrap_or(path);
    let extension = match name.rfind('.') {
        Some(dot) if dot > 0 => name[dot + 1..].to_ascii_lowercase(),
        _ => return OCTET_STREAM,
    };
    TYPES
        .iter()
        .find(|(known, _)| *known == extension)
        .map_or(OCTET_STREAM, |(_, mime)| mime)
}

const OCTET_STREAM: &str = "application/octet-stream";

const TYPES: &[(&str, &str)] = &[
    ("jpg", "image/jpeg"),
    ("jpeg", "image/jpeg"),
    ("png", "image/png"),
    ("webp", "image/webp"),
    ("gif", "image/gif"),
    ("avif", "image/avif"),
    ("heic", "image/heic"),
    ("heif", "image/heif"),
    ("svg", "image/svg+xml"),
    ("ico", "image/x-icon"),
    ("bmp", "image/x-ms-bmp"),
    ("tif", "image/tiff"),
    ("tiff", "image/tiff"),
    ("mp4", "video/mp4"),
    ("m4v", "video/x-m4v"),
    ("mov", "video/quicktime"),
    ("webm", "video/webm"),
    ("mkv", "video/x-matroska"),
    ("mp3", "audio/mpeg"),
    ("m4a", "audio/x-m4a"),
    ("aac", "audio/x-aac"),
    ("ogg", "audio/ogg"),
    ("opus", "audio/ogg"),
    ("wav", "audio/x-wav"),
    ("flac", "audio/x-flac"),
    ("json", "application/json;charset=utf-8"),
    ("txt", "text/plain;charset=utf-8"),
    ("html", "text/html;charset=utf-8"),
    ("htm", "text/html;charset=utf-8"),
    ("css", "text/css;charset=utf-8"),
    ("js", "text/javascript;charset=utf-8"),
    ("mjs", "text/javascript;charset=utf-8"),
    ("vtt", "text/vtt"),
    ("srt", "application/x-subrip"),
    ("pdf", "application/pdf"),
    ("xml", "application/xml"),
    ("csv", "text/csv"),
    ("md", "text/markdown"),
    ("woff", "font/woff"),
    ("woff2", "font/woff2"),
    ("ttf", "font/ttf"),
    ("otf", "font/otf"),
    ("zip", "application/zip"),
    ("gz", "application/gzip"),
    ("wasm", "application/wasm"),
];

#[cfg(test)]
mod tests {
    use super::bun_file_type;

    #[test]
    fn types_as_bun_names_them() {
        assert_eq!(bun_file_type("/d/a.JPG"), "image/jpeg");
        assert_eq!(bun_file_type("/d/a.tar.gz"), "application/gzip");
        assert_eq!(bun_file_type("/d/.jpg"), "application/octet-stream");
        assert_eq!(bun_file_type("/d.y/a"), "application/octet-stream");
        assert_eq!(bun_file_type("/d/a.unknownext"), "application/octet-stream");
    }
}
