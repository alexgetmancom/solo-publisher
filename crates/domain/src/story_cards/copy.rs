//! `buildStoryCardCopy` as far as the store needs it: the headline and the
//! leading emoji a card row stores. The line wrapping is the renderer's.

use foundation::js::{is_whitespace, slice_utf16, trim};
use regex::Regex;
use std::sync::LazyLock;
use unicode_segmentation::UnicodeSegmentation;

/// Part of every card's source hash, so bumping it re-renders each stored
/// card (`TEMPLATE_VERSION`).
pub const TEMPLATE_VERSION: &str = "strata-v3";

/// A safety net only; the renderer's line budget normally decides the cut.
const MAX_HEADLINE_CHARACTERS: usize = 210;

static EMOJI: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\p{Extended_Pictographic}|\p{Regional_Indicator}").unwrap());

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StoryCardCopy {
    pub headline: String,
    pub emoji: Option<String>,
}

/// `buildStoryCardCopy(text)`: the first sentence of the first line of the
/// first paragraph, its leading emoji apart.
pub fn story_card_copy(text: &str) -> StoryCardCopy {
    let normalized = text.replace('\r', "");
    let normalized = trim(&normalized);
    let first_paragraph = first_paragraph(normalized);
    let first_line = first_paragraph
        .split('\n')
        .find(|line| !trim(line).is_empty())
        .map(trim)
        .unwrap_or_default();
    let sentence = if first_line.is_empty() {
        first_sentence(trim(&collapse_whitespace(first_paragraph)))
    } else {
        first_sentence(first_line)
    };
    let (emoji, body) = leading_emoji(&sentence);
    let headline = truncate_at_word(if body.is_empty() { &sentence } else { body }, MAX_HEADLINE_CHARACTERS);
    StoryCardCopy {
        headline,
        emoji: emoji.map(str::to_owned),
    }
}

/// `text.split(/\n\s*\n/, 1)[0]`: up to the first line break followed, past
/// nothing but whitespace, by another.
fn first_paragraph(text: &str) -> &str {
    for (index, c) in text.char_indices() {
        if c != '\n' {
            continue;
        }
        let rest = &text[index + 1..];
        if rest.chars().take_while(|c| is_whitespace(*c)).any(|c| c == '\n') {
            return &text[..index];
        }
    }
    text
}

/// `value.replace(/\s+/g, " ")`.
fn collapse_whitespace(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut in_space = false;
    for c in value.chars() {
        if is_whitespace(c) {
            if !in_space {
                out.push(' ');
            }
            in_space = true;
        } else {
            out.push(c);
            in_space = false;
        }
    }
    out
}

/// `value.match(/^.*?[.!?](?=\s|$)/u)?.[0] ?? value`, trimmed: `.` stops at a
/// line terminator.
fn first_sentence(value: &str) -> String {
    let mut chars = value.char_indices().peekable();
    while let Some((index, c)) = chars.next() {
        if matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}') {
            break;
        }
        if matches!(c, '.' | '!' | '?') && chars.peek().is_none_or(|(_, next)| is_whitespace(*next)) {
            return trim(&value[..index + c.len_utf8()]).to_owned();
        }
    }
    trim(value).to_owned()
}

/// `leadingEmoji`: the first grapheme, when it is a pictograph or a flag.
fn leading_emoji(value: &str) -> (Option<&str>, &str) {
    match value.graphemes(true).next() {
        Some(candidate) if EMOJI.is_match(candidate) => (Some(candidate), trim(&value[candidate.len()..])),
        _ => (None, trim(value)),
    }
}

/// `truncateAtWord(value, limit)`, lengths in UTF-16 code units as in
/// JavaScript. A cut through a surrogate pair drops the pair whole, as
/// [`slice_utf16`] does everywhere; JavaScript keeps the lone high half, which
/// bun's SQLite binding then fuses with the ellipsis into an unrelated emoji.
fn truncate_at_word(value: &str, limit: usize) -> String {
    if utf16_len(value) <= limit {
        return value.to_owned();
    }
    let window = slice_utf16(value, limit + 1);
    let boundary = window.rfind(' ').map(|index| utf16_len(&window[..index]));
    let cut = match boundary {
        Some(boundary) if boundary as f64 > limit as f64 * 0.6 => boundary,
        _ => limit,
    };
    format!("{}…", trim(slice_utf16(value, cut)))
}

fn utf16_len(value: &str) -> usize {
    value.encode_utf16().count()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_cut_through_a_surrogate_pair_drops_the_pair() {
        let text = format!("{}😀{}", "a".repeat(209), " tail".repeat(10));
        assert_eq!(story_card_copy(&text).headline, format!("{}…", "a".repeat(209)));
    }
}
