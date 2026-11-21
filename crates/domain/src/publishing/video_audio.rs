//! Whether a video's audio is likely missing its background bed.

use std::sync::LazyLock;

use regex::Regex;

use super::boundaries::MediaProbe;

const BACKGROUND_AUDIO_FLOOR_DB: f64 = -55.0;

/// Detects the quiet floor that distinguishes a voice/game-only track from
/// one carrying a persistent background bed. A failed optional probe stays
/// quiet, so an upload is never rejected because of this advisory check.
pub async fn background_music_likely_missing(probe: &impl MediaProbe, source: &str, audio_codec: Option<&str>) -> bool {
    if audio_codec.is_none_or(str::is_empty) {
        return true;
    }
    let Ok(output) = probe.audio_stats(source).await else {
        return false;
    };
    match (
        last_overall_metric(&output, &RMS_TROUGH),
        last_overall_metric(&output, &NOISE_FLOOR),
    ) {
        (Some(trough), Some(floor)) => trough < BACKGROUND_AUDIO_FLOOR_DB && floor < BACKGROUND_AUDIO_FLOOR_DB,
        _ => false,
    }
}

static RMS_TROUGH: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"lavfi\.astats\.Overall\.RMS_trough=(-?[0-9]+(?:\.[0-9]+)?)").unwrap());
static NOISE_FLOOR: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"lavfi\.astats\.Overall\.Noise_floor=(-?[0-9]+(?:\.[0-9]+)?)").unwrap());

fn last_overall_metric(output: &str, metric: &Regex) -> Option<f64> {
    let value = metric
        .captures_iter(output)
        .last()?
        .get(1)?
        .as_str()
        .parse::<f64>()
        .ok()?;
    value.is_finite().then_some(value)
}
