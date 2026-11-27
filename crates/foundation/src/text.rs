//! Text measured and cut in UTF-16 code units, the unit every offset and
//! limit a platform states counts (Telegram entities and message limits, X
//! Article ranges), and in code points where a limit is ours.

/// Truncates text to at most `max_characters` Unicode code points.
///
/// There is no lone UTF-16 surrogate to repair: a Rust `&str` cannot hold one,
/// so counting code points is the whole job.
pub fn truncate_unicode(value: &str, max_characters: usize) -> &str {
    match value.char_indices().nth(max_characters) {
        Some((end, _)) => &value[..end],
        None => value,
    }
}

/// `value.length`.
pub fn utf16_len(value: &str) -> usize {
    value.encode_utf16().count()
}

/// `value.slice(0, units)`, never splitting a character: a surrogate pair the
/// cut would halve is dropped whole.
pub fn utf16_prefix(value: &str, units: usize) -> &str {
    let mut count = 0;
    for (index, c) in value.char_indices() {
        count += c.len_utf16();
        if count > units {
            return &value[..index];
        }
    }
    value
}

/// `value.slice(0, units)` keeping the half of a pair the cut splits, as
/// U+FFFD, which is what a lone surrogate becomes once it is stored or sent.
pub fn utf16_prefix_lossy(value: &str, units: usize) -> String {
    let units: Vec<u16> = value.encode_utf16().take(units).collect();
    String::from_utf16_lossy(&units)
}

/// `value.slice(units)`: from the first character that starts at or after
/// UTF-16 position `units`.
pub fn utf16_slice_from(value: &str, units: usize) -> &str {
    let mut seen = 0;
    for (index, c) in value.char_indices() {
        if seen >= units {
            return &value[index..];
        }
        seen += c.len_utf16();
    }
    ""
}

/// `value.slice(start, end)` over the string's UTF-16 units; a half pair at
/// either edge becomes U+FFFD, as `String.fromCharCode` of the orphan would print.
pub fn utf16_slice(units: &[u16], start: usize, end: usize) -> String {
    String::from_utf16_lossy(&units[start.min(units.len())..end.min(units.len())])
}

/// The byte index of UTF-16 position `unit`, or None when it falls inside a
/// surrogate pair or past the end.
pub fn utf16_to_byte(value: &str, unit: usize) -> Option<usize> {
    let mut units = 0;
    for (byte, c) in value.char_indices() {
        if units == unit {
            return Some(byte);
        }
        units += c.len_utf16();
        if units > unit {
            return None;
        }
    }
    (units == unit).then_some(value.len())
}

/// What reads as blank in text a person wrote or pasted: Unicode whitespace
/// and U+FEFF, the invisible mark a paste can leave at either end, but not
/// U+0085, which post text has always kept.
pub fn is_text_blank(c: char) -> bool {
    c == '\u{feff}' || (c.is_whitespace() && c != '\u{85}')
}

/// Post and user text trimmed of what [`is_text_blank`] calls blank, so an
/// invisible U+FEFF never reaches a publication.
pub trait TrimText {
    fn trim_text(&self) -> &str;
    fn trim_text_start(&self) -> &str;
    fn trim_text_end(&self) -> &str;
}

impl TrimText for str {
    fn trim_text(&self) -> &str {
        self.trim_matches(is_text_blank)
    }
    fn trim_text_start(&self) -> &str {
        self.trim_start_matches(is_text_blank)
    }
    fn trim_text_end(&self) -> &str {
        self.trim_end_matches(is_text_blank)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn text_trims_the_byte_order_mark_but_keeps_next_line() {
        assert_eq!(" \u{feff}\u{a0}текст\u{3000}\u{feff}".trim_text(), "текст");
        assert_eq!("\u{85}начало\u{85}".trim_text(), "\u{85}начало\u{85}");
        assert_eq!("\u{feff} x ".trim_text_start(), "x ");
        assert_eq!(" x \u{feff}".trim_text_end(), " x");
    }
}
