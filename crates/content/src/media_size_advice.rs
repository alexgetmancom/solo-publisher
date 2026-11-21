use serde_json::Value;

use crate::message::MediaItem;

/// Advice shown when captured media is likely to make delivery slow or fragile.
pub const RECOMMENDED_MEDIA_BYTES: u64 = 50_000_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MediaSizeAdvice {
    pub megabytes: u64,
    pub recommended_megabytes: u64,
}

/// The largest attached item over the recommendation, or None when all of them
/// fit. An item without a numeric `file_size` counts as fitting.
pub fn media_size_advice(media: &[MediaItem]) -> Option<MediaSizeAdvice> {
    let largest = media
        .iter()
        .filter_map(|item| item.get("file_size").and_then(Value::as_f64))
        .fold(0.0, f64::max);
    (largest > RECOMMENDED_MEDIA_BYTES as f64).then(|| MediaSizeAdvice {
        megabytes: megabytes(largest),
        recommended_megabytes: megabytes(RECOMMENDED_MEDIA_BYTES as f64),
    })
}

fn megabytes(bytes: f64) -> u64 {
    (bytes / 1_000_000.0).round() as u64
}
