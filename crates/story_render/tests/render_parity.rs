//! The renderer against the TypeScript one (`scripts/rust/story-render-fixtures.ts`).
//!
//! The copy, line breaks and overlay SVG must match exactly. The pixels
//! cannot: libvips and resvg rasterise and encode differently. A card is
//! compared halved (each 2×2 block averaged, as the reference was) by three
//! numbers: the mean absolute error over every channel; the worst mean
//! absolute error of a 16×16 tile (a 32×32 patch of the card, about a glyph);
//! and the worst tile's mean signed error, which JPEG noise averages away and
//! a missing or misplaced tone does not.
//!
//! Measured on these cards (the reference's own JPEG quality 70 is most of
//! the floor): a faithful render reads at most 3.8 / 9.5 / 2.5. Sabotaged, one
//! thing at a time: the copy drawn at weight 400 instead of 680/440 reads
//! tiles of 116–159; letter-spacing dropped, 88–173; the emoji 4 px low, 33
//! and 38; the background sampled centre-aligned, 16.6; the glow left out,
//! tone 5.3–6.5. Hence the limits below.

use std::path::{Path, PathBuf};

use domain::story_cards::{StoryCardCopy, TEMPLATE_VERSION, story_card_copy};
use image::RgbImage;
use serde::Deserialize;
use serde_json::{Value, json};
use story_render::{
    STORY_CARD_HEIGHT, STORY_CARD_WIDTH, StoryCardRender, emoji_asset_file, render_story_card, story_card_emoji_top,
    story_card_overlay_svg,
};

const MAX_MEAN_ERROR: f64 = 4.5;
const MAX_TILE_ERROR: f64 = 12.0;
const MAX_TONE_ERROR: f64 = 4.0;
const TILE: u32 = 16;

fn root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .unwrap()
}

fn fixtures() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures")
}

fn read<T: for<'de> Deserialize<'de>>(name: &str) -> T {
    serde_json::from_str(&std::fs::read_to_string(fixtures().join(name)).unwrap()).unwrap()
}

/// The copy the worker hands the renderer: rebuilt from the stored headline,
/// with the stored headline and emoji laid back over it.
fn worker_copy(text: &str) -> StoryCardCopy {
    let stored = story_card_copy(text);
    let mut copy = story_card_copy(&stored.headline);
    copy.emoji = stored.emoji;
    copy.headline = stored.headline;
    copy
}

fn copy_json(copy: &StoryCardCopy) -> Value {
    json!({
        "headline": copy.headline,
        "emoji": copy.emoji,
        "lines": copy.lines,
        "boldLineCount": copy.bold_line_count,
        "templateVersion": TEMPLATE_VERSION,
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Layout {
    text: String,
    wordmark: String,
    copy: Value,
    svg: String,
    emoji_file: Option<String>,
    emoji_top: i32,
}

#[test]
fn copy_line_breaks_and_overlay_match_typescript() {
    let mut failures = Vec::new();
    for expected in read::<Vec<Layout>>("copy.json") {
        let copy = worker_copy(&expected.text);
        let actual = (
            copy_json(&copy),
            story_card_overlay_svg(&copy, &expected.wordmark),
            emoji_asset_file(copy.emoji.as_deref()),
            story_card_emoji_top(&copy),
        );
        if actual
            != (
                expected.copy.clone(),
                expected.svg.clone(),
                expected.emoji_file.clone(),
                expected.emoji_top,
            )
        {
            failures.push(format!(
                "{:?} / {:?}:\n  ts:   {} {:?} {}\n  rust: {} {:?} {}",
                expected.text,
                expected.wordmark,
                expected.copy,
                expected.emoji_file,
                expected.emoji_top,
                actual.0,
                actual.2,
                actual.3
            ));
            if actual.1 != expected.svg {
                failures.push(format!("  svg ts:\n{}\n  svg rust:\n{}", expected.svg, actual.1));
            }
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[derive(Deserialize)]
struct Card {
    name: String,
    text: String,
    wordmark: String,
    copy: Value,
}

/// Each 2×2 block averaged, rounding as the fixture script does.
fn halved(image: &RgbImage) -> RgbImage {
    RgbImage::from_fn(image.width() / 2, image.height() / 2, |x, y| {
        let block = [(0, 0), (1, 0), (0, 1), (1, 1)].map(|(dx, dy)| image.get_pixel(2 * x + dx, 2 * y + dy).0);
        image::Rgb(std::array::from_fn(|channel| {
            ((block.iter().map(|pixel| u32::from(pixel[channel])).sum::<u32>() + 2) >> 2) as u8
        }))
    })
}

/// The mean absolute error over every channel; the worst tile's mean
/// absolute error (shapes: a glyph, a line, the emoji out of place); and the
/// worst tile's mean signed error (tone: the glow's halo, which JPEG noise,
/// averaging to zero, does not drown).
fn errors(expected: &RgbImage, actual: &RgbImage) -> (f64, f64, f64) {
    let (width, height) = expected.dimensions();
    let mut total = 0u64;
    let (mut worst, mut worst_tone) = (0.0f64, 0.0f64);
    for tile_y in (0..height).step_by(TILE as usize) {
        for tile_x in (0..width).step_by(TILE as usize) {
            let (mut absolute, mut signed, mut count) = (0u64, 0i64, 0u64);
            for y in tile_y..(tile_y + TILE).min(height) {
                for x in tile_x..(tile_x + TILE).min(width) {
                    let (left, right) = (expected.get_pixel(x, y).0, actual.get_pixel(x, y).0);
                    for channel in 0..3 {
                        absolute += u64::from(left[channel].abs_diff(right[channel]));
                        signed += i64::from(right[channel]) - i64::from(left[channel]);
                        count += 1;
                    }
                }
            }
            total += absolute;
            worst = worst.max(absolute as f64 / count as f64);
            worst_tone = worst_tone.max((signed as f64 / count as f64).abs());
        }
    }
    (total as f64 / f64::from(width * height * 3), worst, worst_tone)
}

#[test]
fn cards_match_typescript_pixels() {
    let cards: Vec<Card> = read("cards.json");
    let out = root().join("_trash-rust/tmp/story-render");
    std::fs::create_dir_all(&out).unwrap();
    let assets = root().join("apps/backend/assets/story-card");
    // A debug-build render is seconds; the cards are independent.
    let measured: Vec<(String, f64, f64, f64)> = std::thread::scope(|scope| {
        let renders: Vec<_> = cards
            .iter()
            .map(|card| {
                let (out, assets) = (&out, &assets);
                scope.spawn(move || {
                    let copy = worker_copy(&card.text);
                    assert_eq!(copy_json(&copy), card.copy, "{}: copy", card.name);
                    let output = out.join(format!("{}.jpg", card.name));
                    render_story_card(&StoryCardRender {
                        assets_dir: assets.clone(),
                        output: output.clone(),
                        wordmark: card.wordmark.clone(),
                        copy,
                    })
                    .unwrap();
                    let actual = image::open(&output).unwrap().into_rgb8();
                    assert_eq!(
                        actual.dimensions(),
                        (STORY_CARD_WIDTH, STORY_CARD_HEIGHT),
                        "{}",
                        card.name
                    );
                    let expected = image::open(fixtures().join(format!("{}.jpg", card.name)))
                        .unwrap()
                        .into_rgb8();
                    assert_eq!(expected.dimensions(), (STORY_CARD_WIDTH / 2, STORY_CARD_HEIGHT / 2));
                    let (mean, tile, tone) = errors(&expected, &halved(&actual));
                    (card.name.clone(), mean, tile, tone)
                })
            })
            .collect();
        renders.into_iter().map(|render| render.join().unwrap()).collect()
    });
    for (name, mean, tile, tone) in &measured {
        eprintln!("{name}: mean error {mean:.2}, worst {TILE}px tile {tile:.2}, worst tile tone {tone:.2}");
    }
    let failures: Vec<_> = measured
        .iter()
        .filter(|(_, mean, tile, tone)| *mean > MAX_MEAN_ERROR || *tile > MAX_TILE_ERROR || *tone > MAX_TONE_ERROR)
        .collect();
    assert!(
        failures.is_empty(),
        "over {MAX_MEAN_ERROR} mean / {MAX_TILE_ERROR} tile / {MAX_TONE_ERROR} tone: {failures:?}"
    );
}
