//! `story-cards/svg.ts`: the card's geometry and its text overlay.

use domain::story_cards::StoryCardCopy;
use foundation::html::escape_xml;
use foundation::js::number_to_string;

pub const STORY_CARD_WIDTH: u32 = 1080;
pub const STORY_CARD_HEIGHT: u32 = 1920;
pub(crate) const STORY_CARD_EMOJI_LEFT: i32 = 108;
pub(crate) const STORY_CARD_EMOJI_SIZE: u32 = 58;

// One source for the text block's metrics: the emoji is composited against
// the same baseline the SVG draws the copy on, so a layout tweak made in one
// of the two places would silently pull them apart.
const FONT_SIZE: f64 = 74.0;
const LINE_HEIGHT: f64 = 94.0;
const BLOCK_CENTER: f64 = 1020.0;
const TEXT_LEFT: u32 = 190;
/// Nudges the emoji's box off the text baseline onto its optical centre.
const EMOJI_BASELINE_OFFSET: f64 = 7.0;
const BOLD_WEIGHT: u16 = 680;
const REGULAR_WEIGHT: u16 = 440;
const WORDMARK_WEIGHT: u16 = 430;

/// The weights above as positions on Manrope's `wght` axis. librsvg hands a
/// numeric `font-weight` to the variable font as is; usvg maps only the
/// hundreds and reads any other weight as its parent's, so the renderer
/// injects this style sheet to say what the SVG already means.
pub(crate) fn variable_weight_style_sheet() -> String {
    [BOLD_WEIGHT, REGULAR_WEIGHT, WORDMARK_WEIGHT]
        .map(|weight| format!(r#"[font-weight="{weight}"] {{ font-variation-settings: "wght" {weight} }}"#))
        .join("\n")
}

fn first_baseline(copy: &StoryCardCopy) -> f64 {
    BLOCK_CENTER - ((copy.lines.len() as f64 - 1.0) * LINE_HEIGHT) / 2.0 + FONT_SIZE * 0.25
}

/// `storyCardEmojiTop`: `Math.round`, which rounds halves up.
pub fn story_card_emoji_top(copy: &StoryCardCopy) -> i32 {
    (first_baseline(copy) - f64::from(STORY_CARD_EMOJI_SIZE) + EMOJI_BASELINE_OFFSET + 0.5).floor() as i32
}

/// `emojiAssetFile`: the Twemoji file name for a leading emoji — codepoints in
/// lowercase hex joined by `-`, the FE0F variation selector dropped — whether
/// or not the file exists; the renderer checks the assets directory, so wider
/// emoji coverage is a matter of dropping an SVG in.
pub fn emoji_asset_file(emoji: Option<&str>) -> Option<String> {
    let points: Vec<String> = emoji?
        .chars()
        .filter(|c| *c != '\u{fe0f}')
        .map(|c| format!("{:x}", u32::from(c)))
        .collect();
    (!points.is_empty()).then(|| format!("{}.svg", points.join("-")))
}

/// `storyCardOverlaySvg`. The wordmark is this Studio's own name, empty on an
/// installation that has not claimed one.
pub fn story_card_overlay_svg(copy: &StoryCardCopy, wordmark: &str) -> String {
    let baseline = first_baseline(copy);
    let text: String = copy
        .lines
        .iter()
        .enumerate()
        .map(|(index, line)| {
            format!(
                r#"<text x="{TEXT_LEFT}" y="{}" class="copy" font-weight="{}">{}</text>"#,
                number_to_string(baseline + index as f64 * LINE_HEIGHT),
                if index < copy.bold_line_count {
                    BOLD_WEIGHT
                } else {
                    REGULAR_WEIGHT
                },
                escape_xml(line)
            )
        })
        .collect();
    let wordmark = if wordmark.is_empty() {
        String::new()
    } else {
        format!(
            r#"<text x="540" y="150" text-anchor="middle" font-size="29" font-weight="{WORDMARK_WEIGHT}"
        letter-spacing="10" fill-opacity=".8" filter="url(#glow)">{}</text>"#,
            escape_xml(wordmark)
        )
    };
    format!(
        r##"<svg xmlns="http://www.w3.org/2000/svg" width="{STORY_CARD_WIDTH}" height="{STORY_CARD_HEIGHT}">
  <defs>
    <filter id="glow" x="-15%" y="-25%" width="130%" height="150%">
      <feGaussianBlur in="SourceAlpha" stdDeviation="3.2" result="blur"/>
      <feFlood flood-color="#f0d19a" flood-opacity=".18" result="warm"/>
      <feComposite in="warm" in2="blur" operator="in" result="halo"/>
      <feMerge><feMergeNode in="halo"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
    <style>
      text {{ font-family: Manrope, sans-serif; fill: #f3eee4; }}
      .copy {{ font-size: {}px; letter-spacing: -1.15px; }}
    </style>
  </defs>
  {wordmark}
  <g filter="url(#glow)">{text}</g>
</svg>"##,
        number_to_string(FONT_SIZE)
    )
}
