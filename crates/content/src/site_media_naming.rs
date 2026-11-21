//! Shared naming convention for publication media materialized onto the public
//! site. Materializing site media writes files under these names; the public
//! site read model synthesizes the same names for legacy rows whose stored media
//! JSON predates having its own `path`.

use crate::Locale;

/// Filesystem/URL directory segments holding materialized post media, relative to the site public root.
pub const SITE_MEDIA_DIR_SEGMENTS: [&str; 2] = ["media", "posts"];
pub const SITE_MEDIA_URL_PREFIX: &str = "media/posts";
/// The article column is 680 CSS pixels; common phone DPRs need the steps
/// around 720 and 800, while 1280 also covers larger article images.
pub const RESPONSIVE_WIDTHS: [u32; 7] = [360, 480, 640, 720, 800, 960, 1280];

pub fn site_media_filename(post_id: i64, locale: Locale, index: usize, extension: &str) -> String {
    format!("{}.{extension}", base_name(post_id, locale, index))
}

pub fn site_media_poster_filename(post_id: i64, locale: Locale, index: usize) -> String {
    format!("{}-original-poster.jpg", base_name(post_id, locale, index))
}

fn base_name(post_id: i64, locale: Locale, index: usize) -> String {
    format!("{post_id}-{}-{index}", locale.as_str())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn url_prefix_is_the_directory_segments() {
        assert_eq!(SITE_MEDIA_DIR_SEGMENTS.join("/"), SITE_MEDIA_URL_PREFIX);
    }
}
