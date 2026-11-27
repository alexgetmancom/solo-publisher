//! `buildStoryCardCopy`: the headline and leading emoji a card row stores,
//! and the lines the renderer draws them on.

use foundation::text::{TrimText, is_text_blank, utf16_len, utf16_prefix};
use regex::Regex;
use std::sync::LazyLock;
use unicode_segmentation::UnicodeSegmentation;

/// Part of every card's source hash, so bumping it re-renders each stored
/// card (`TEMPLATE_VERSION`).
pub const TEMPLATE_VERSION: &str = "strata-v3";

/// A safety net only; the line budget below normally decides the cut: at
/// [`MAX_LINE_UNITS`] per line eight lines hold roughly 155 characters.
const MAX_HEADLINE_CHARACTERS: usize = 210;
pub const MAX_LINES: usize = 8;
const MAX_LINE_UNITS: f64 = 10.6;
const ELLIPSIS: &str = "…";

static EMOJI: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\p{Extended_Pictographic}|\p{Regional_Indicator}").unwrap());

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StoryCardCopy {
    pub headline: String,
    pub emoji: Option<String>,
    /// The headline wrapped into the card's line box, at most [`MAX_LINES`].
    pub lines: Vec<String>,
    /// How many leading lines are drawn bold.
    pub bold_line_count: usize,
}

/// `buildStoryCardCopy(text)`: the first sentence of the first line of the
/// first paragraph, its leading emoji apart.
pub fn story_card_copy(text: &str) -> StoryCardCopy {
    let normalized = text.replace('\r', "");
    let normalized = normalized.trim_text();
    let first_paragraph = first_paragraph(normalized);
    let first_line = first_paragraph
        .split('\n')
        .find(|line| !line.trim_text().is_empty())
        .map(TrimText::trim_text)
        .unwrap_or_default();
    let sentence = if first_line.is_empty() {
        first_sentence(collapse_whitespace(first_paragraph).trim_text())
    } else {
        first_sentence(first_line)
    };
    let (emoji, body) = leading_emoji(&sentence);
    let headline = truncate_at_word(if body.is_empty() { &sentence } else { body }, MAX_HEADLINE_CHARACTERS);
    let lines = wrap_headline(&headline);
    StoryCardCopy {
        headline,
        emoji: emoji.map(str::to_owned),
        bold_line_count: lines.len().min(if lines.len() <= 2 { 1 } else { 2 }),
        lines,
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
        if rest.chars().take_while(|c| is_text_blank(*c)).any(|c| c == '\n') {
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
        if is_text_blank(c) {
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
        if matches!(c, '.' | '!' | '?') && chars.peek().is_none_or(|(_, next)| is_text_blank(*next)) {
            return value[..index + c.len_utf8()].trim_text().to_owned();
        }
    }
    value.trim_text().to_owned()
}

/// `leadingEmoji`: the first grapheme, when it is a pictograph or a flag.
fn leading_emoji(value: &str) -> (Option<&str>, &str) {
    match value.graphemes(true).next() {
        Some(candidate) if EMOJI.is_match(candidate) => (Some(candidate), value[candidate.len()..].trim_text()),
        _ => (None, value.trim_text()),
    }
}

/// `truncateAtWord(value, limit)`, lengths in UTF-16 code units as in
/// JavaScript. A cut through a surrogate pair drops the pair whole, as
/// [`utf16_prefix`] does everywhere; JavaScript keeps the lone high half, which
/// bun's SQLite binding then fuses with the ellipsis into an unrelated emoji.
fn truncate_at_word(value: &str, limit: usize) -> String {
    if utf16_len(value) <= limit {
        return value.to_owned();
    }
    let window = utf16_prefix(value, limit + 1);
    let boundary = window.rfind(' ').map(|index| utf16_len(&window[..index]));
    let cut = match boundary {
        Some(boundary) if boundary as f64 > limit as f64 * 0.6 => boundary,
        _ => limit,
    };
    format!("{}…", utf16_prefix(value, cut).trim_text())
}

/// `wrapHeadline`: words into lines of at most [`MAX_LINE_UNITS`]; a word
/// wider than a line is broken by width (SVG text does not clip, so it would
/// run off the card), and a headline that does not fit ends in an ellipsis.
fn wrap_headline(headline: &str) -> Vec<String> {
    let words: Vec<&str> = headline.split(is_text_blank).filter(|word| !word.is_empty()).collect();
    let mut lines: Vec<String> = Vec::new();
    let mut current = String::new();
    let mut index = 0;
    while index < words.len() {
        let word = words[index];
        let candidate = if current.is_empty() {
            word.to_owned()
        } else {
            format!("{current} {word}")
        };
        if text_units(&candidate) <= MAX_LINE_UNITS {
            current = candidate;
            index += 1;
            continue;
        }
        if !current.is_empty() {
            lines.push(std::mem::take(&mut current));
        }
        if lines.len() >= MAX_LINES {
            break;
        }
        let mut rest = word;
        while text_units(rest) > MAX_LINE_UNITS && lines.len() < MAX_LINES {
            let head = take_units(rest, MAX_LINE_UNITS);
            rest = &rest[head.len()..];
            lines.push(head.to_owned());
        }
        if lines.len() >= MAX_LINES {
            break;
        }
        current = rest.to_owned();
        index += 1;
    }
    let overflowed = index < words.len() || (!current.is_empty() && lines.len() >= MAX_LINES);
    if !current.is_empty() && lines.len() < MAX_LINES {
        lines.push(current);
    }
    if overflowed && let Some(last) = lines.last_mut() {
        *last = ellipsize(last);
    }
    if lines.is_empty() {
        lines.push("Update".to_owned());
    }
    lines
}

/// `takeUnits`: the longest prefix that still fits `limit`, at least one
/// character.
fn take_units(value: &str, limit: f64) -> &str {
    let mut end = 0;
    for (index, c) in value.char_indices() {
        if end > 0 && text_units(&value[..index + c.len_utf8()]) > limit {
            break;
        }
        end = index + c.len_utf8();
    }
    &value[..end]
}

fn ellipsize(line: &str) -> String {
    let base = line.strip_suffix(ELLIPSIS).unwrap_or(line);
    format!(
        "{}{ELLIPSIS}",
        take_units(base, MAX_LINE_UNITS - text_units(ELLIPSIS)).trim_text_end()
    )
}

/// `textUnits`: a width estimate per character, summed in order as
/// JavaScript sums it, so the floating-point totals match.
fn text_units(value: &str) -> f64 {
    let mut units = 0.0;
    for c in value.chars() {
        units += match c {
            ' ' | 'i' | 'l' | 'I' | '1' | '|' | '.' | ',' | ':' | ';' | '!' | '\'' | '`' => 0.28,
            'm' | 'w' | 'M' | 'W' | 'Ж' | 'Ш' | 'Щ' | 'Ю' | 'Ф' => 0.82,
            'A'..='Z' | 'А'..='Я' | 'Ё' | '0'..='9' => 0.64,
            _ => 0.55,
        };
    }
    units
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
