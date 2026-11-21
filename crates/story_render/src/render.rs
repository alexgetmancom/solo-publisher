//! `story-cards/renderer-process.ts`: the background resized to the card with
//! `fit: cover`, the text overlay and the leading emoji's Twemoji asset drawn
//! over it, encoded as JPEG quality 92 without chroma subsampling.
//!
//! TypeScript ran this in a child process because sharp is libvips over
//! N-API: native memory and a native crash belonged in a process the worker
//! could kill. resvg, tiny-skia and the encoders here are safe Rust, so the
//! render runs in-process on the blocking pool; a panic comes back as an
//! error, and the worker's timeout stops waiting for it.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use domain::story_cards::StoryCardCopy;
use resvg::tiny_skia::{Pixmap, PixmapPaint, PremultipliedColorU8, Transform};
use resvg::usvg;

use crate::svg::{
    STORY_CARD_EMOJI_LEFT, STORY_CARD_EMOJI_SIZE, STORY_CARD_HEIGHT, STORY_CARD_WIDTH, emoji_asset_file,
    story_card_emoji_top, story_card_overlay_svg, variable_weight_style_sheet,
};

/// The card's background, under `STORY_CARD_ASSETS_DIR`.
const STORY_CARD_BACKGROUND: &str = "strata-master-background.png";
const JPEG_QUALITY: u8 = 92;

/// One card to draw: what the worker handed the renderer process on stdin.
#[derive(Clone, Debug)]
pub struct StoryCardRender {
    /// `STORY_CARD_ASSETS_DIR`: the background, the fonts (Manrope, Noto
    /// Color Emoji) and `emoji/<codepoints>.svg`.
    pub assets_dir: PathBuf,
    pub output: PathBuf,
    pub wordmark: String,
    pub copy: StoryCardCopy,
}

/// Draws the card into `output` and returns its size in bytes. The file is
/// written beside its final name and renamed into place, so a reader never
/// sees half a card.
pub fn render_story_card(card: &StoryCardRender) -> Result<u64, String> {
    let mut canvas = background(&card.assets_dir.join(STORY_CARD_BACKGROUND))?;
    let overlay = usvg::Tree::from_str(
        &story_card_overlay_svg(&card.copy, &card.wordmark),
        &usvg::Options {
            fontdb: Arc::new(fonts(&card.assets_dir)),
            style_sheet: Some(variable_weight_style_sheet()),
            ..usvg::Options::default()
        },
    )
    .map_err(|error| format!("overlay: {error}"))?;
    resvg::render(&overlay, Transform::identity(), &mut canvas.as_mut());
    if let Some(file) = emoji_asset_file(card.copy.emoji.as_deref()) {
        let path = card.assets_dir.join("emoji").join(file);
        if path.exists() {
            let emoji = emoji(&path)?;
            canvas.draw_pixmap(
                STORY_CARD_EMOJI_LEFT,
                story_card_emoji_top(&card.copy),
                emoji.as_ref(),
                &PixmapPaint::default(),
                Transform::identity(),
                None,
            );
        }
    }
    let jpeg = encode(&canvas)?;
    write_into_place(&card.output, &jpeg)?;
    Ok(jpeg.len() as u64)
}

/// The fonts the TypeScript renderer's fontconfig saw: every font file in the
/// assets directory, Manrope standing for `sans-serif`; a glyph Manrope lacks
/// (an emoji inside the text) falls back to whichever font has it.
fn fonts(assets_dir: &Path) -> fontdb::Database {
    let mut fonts = fontdb::Database::new();
    fonts.load_fonts_dir(assets_dir);
    fonts.set_sans_serif_family("Manrope");
    fonts
}

/// `resize(1080, 1920, { fit: "cover" })` as sharp does it: both axes scaled
/// by the larger ratio, then cropped about the centre with sharp's rounding.
fn background(path: &Path) -> Result<Pixmap, String> {
    let source = Pixmap::load_png(path).map_err(|error| format!("background {}: {error}", path.display()))?;
    let (width, height) = (source.width(), source.height());
    // sharp divides input by target per axis and keeps the smaller shrink.
    let shrink = f64::min(
        f64::from(width) / f64::from(STORY_CARD_WIDTH),
        f64::from(height) / f64::from(STORY_CARD_HEIGHT),
    );
    let scale = 1.0 / shrink;
    let scaled = |side: u32| (f64::from(side) * scale).round() as u32;
    let left = (scaled(width).max(STORY_CARD_WIDTH) - STORY_CARD_WIDTH).div_ceil(2);
    let top = (scaled(height).max(STORY_CARD_HEIGHT) - STORY_CARD_HEIGHT).div_ceil(2);
    let columns = taps(STORY_CARD_WIDTH, left, scale, width);
    let rows = taps(STORY_CARD_HEIGHT, top, scale, height);
    let pixels = source.pixels();
    // Horizontal pass over every source row, then vertical.
    let mut across = vec![[0f32; 3]; (height * STORY_CARD_WIDTH) as usize];
    for y in 0..height as usize {
        let row = &pixels[y * width as usize..][..width as usize];
        for (x, (indices, weights)) in columns.iter().enumerate() {
            let mut sum = [0f32; 3];
            for (index, weight) in indices.iter().zip(weights) {
                let pixel = row[*index];
                for (channel, value) in sum.iter_mut().zip([pixel.red(), pixel.green(), pixel.blue()]) {
                    *channel += weight * f32::from(value);
                }
            }
            across[y * STORY_CARD_WIDTH as usize + x] = sum;
        }
    }
    let mut canvas = Pixmap::new(STORY_CARD_WIDTH, STORY_CARD_HEIGHT).expect("the card has a size");
    let target = canvas.pixels_mut();
    for (y, (indices, weights)) in rows.iter().enumerate() {
        for x in 0..STORY_CARD_WIDTH as usize {
            let mut sum = [0f32; 3];
            for (index, weight) in indices.iter().zip(weights) {
                let pixel = across[index * STORY_CARD_WIDTH as usize + x];
                for (channel, value) in sum.iter_mut().zip(pixel) {
                    *channel += weight * value;
                }
            }
            let [r, g, b] = sum.map(|value| value.round().clamp(0.0, 255.0) as u8);
            target[y * STORY_CARD_WIDTH as usize + x] = PremultipliedColorU8::from_rgba(r, g, b, 255).expect("opaque");
        }
    }
    Ok(canvas)
}

/// The four source pixels and Catmull-Rom weights behind each output pixel
/// of one axis. libvips enlarges through `vips_affine` with its bicubic
/// interpolator, which samples output pixel `i` at source
/// `(i + crop) / scale − 0.5` (not at the centre-aligned
/// `(i + 0.5) / scale − 0.5`), with edges extended. Against sharp's own output on the shipped background this
/// mapping leaves a mean error of 1.1 per channel (its JPEG noise); the
/// centre-aligned one leaves 2.7.
fn taps(count: u32, crop: u32, scale: f64, source: u32) -> Vec<([usize; 4], [f32; 4])> {
    (0..count)
        .map(|index| {
            let position = f64::from(index + crop) / scale - 0.5;
            let base = position.floor();
            let t = position - base;
            let indices =
                [-1.0, 0.0, 1.0, 2.0].map(|offset| (base + offset).clamp(0.0, f64::from(source - 1)) as usize);
            let weights = [t + 1.0, t, 1.0 - t, 2.0 - t].map(|distance| catmull_rom(distance) as f32);
            (indices, weights)
        })
        .collect()
}

/// The cubic convolution kernel with `a = -0.5`.
fn catmull_rom(distance: f64) -> f64 {
    let x = distance.abs();
    if x < 1.0 {
        (1.5 * x - 2.5) * x * x + 1.0
    } else if x < 2.0 {
        ((-0.5 * x + 2.5) * x - 4.0) * x + 2.0
    } else {
        0.0
    }
}

/// The Twemoji asset scaled into the emoji box (`fit: "contain"`).
fn emoji(path: &Path) -> Result<Pixmap, String> {
    let data = std::fs::read(path).map_err(|error| format!("emoji {}: {error}", path.display()))?;
    let tree = usvg::Tree::from_data(&data, &usvg::Options::default())
        .map_err(|error| format!("emoji {}: {error}", path.display()))?;
    let side = STORY_CARD_EMOJI_SIZE as f32;
    let size = tree.size();
    let scale = f32::min(side / size.width(), side / size.height());
    let mut pixmap = Pixmap::new(STORY_CARD_EMOJI_SIZE, STORY_CARD_EMOJI_SIZE).expect("the emoji box has a size");
    resvg::render(
        &tree,
        Transform::from_scale(scale, scale).post_translate(
            (side - size.width() * scale) / 2.0,
            (side - size.height() * scale) / 2.0,
        ),
        &mut pixmap.as_mut(),
    );
    Ok(pixmap)
}

fn encode(canvas: &Pixmap) -> Result<Vec<u8>, String> {
    // The canvas is opaque, so its premultiplied pixels are the colours.
    let rgb: Vec<u8> = canvas
        .data()
        .as_chunks::<4>()
        .0
        .iter()
        .flat_map(|&[r, g, b, _]| [r, g, b])
        .collect();
    let mut jpeg = Vec::new();
    let mut encoder = jpeg_encoder::Encoder::new(&mut jpeg, JPEG_QUALITY);
    encoder.set_sampling_factor(jpeg_encoder::SamplingFactor::F_1_1);
    encoder
        .encode(
            &rgb,
            STORY_CARD_WIDTH as u16,
            STORY_CARD_HEIGHT as u16,
            jpeg_encoder::ColorType::Rgb,
        )
        .map_err(|error| format!("jpeg: {error}"))?;
    Ok(jpeg)
}

fn write_into_place(output: &Path, bytes: &[u8]) -> Result<(), String> {
    let failed = |error: std::io::Error| format!("output {}: {error}", output.display());
    if let Some(parent) = output.parent() {
        std::fs::create_dir_all(parent).map_err(failed)?;
    }
    let mut partial = output.as_os_str().to_owned();
    partial.push(format!(".{}.partial", domain::repositories::random_uuid()));
    let partial = PathBuf::from(partial);
    let written = std::fs::File::create(&partial)
        .and_then(|mut file| file.write_all(bytes))
        .and_then(|()| std::fs::rename(&partial, output));
    if let Err(error) = written {
        let _ = std::fs::remove_file(&partial);
        return Err(failed(error));
    }
    Ok(())
}
