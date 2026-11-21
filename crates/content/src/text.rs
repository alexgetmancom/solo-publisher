use std::collections::BTreeMap;

use foundation::html::escape_html;
use foundation::js::{is_integer, is_whitespace, number_to_string, trim, trim_start};
use foundation::url::is_http_url;
use serde_json::Value;

use crate::js::{number, utf16_len, utf16_prefix, utf16_to_byte};
use crate::message::Entity;

struct Wrapper {
    open: String,
    close: String,
}

/// Renders Telegram entities over `text` in a single left-to-right pass,
/// emitting close tags before open tags at each boundary.
///
/// The obvious alternative — wrapping one entity at a time by slicing the
/// accumulated HTML — is wrong for nested entities (Telegram routinely sends
/// bold and text_link over the same range): the first wrap shifts every later
/// offset, but those offsets are still computed against the original plain
/// text, so the second wrap slices in the wrong place and tears the markup.
/// Offsets here are only ever read against `text`, never against the output.
///
/// An offset inside a surrogate pair splits the character; each orphaned half
/// renders as U+FFFD.
pub fn entities_to_html(text: &str, entities: &[Entity]) -> String {
    let units: Vec<u16> = text.encode_utf16().collect();
    let mut spans: Vec<(usize, usize, Wrapper)> = entities
        .iter()
        .filter_map(|entity| {
            let (offset, length) = (number(entity.get("offset")), number(entity.get("length")));
            if !(is_integer(offset) && is_integer(length) && offset >= 0.0 && length > 0.0) {
                return None;
            }
            if offset + length > units.len() as f64 {
                return None;
            }
            let (start, end) = (offset as usize, (offset + length) as usize);
            let wrapper = entity_wrapper(entity, &String::from_utf16_lossy(&units[start..end]))?;
            Some((start, end, wrapper))
        })
        .collect();
    // Outermost first at a shared start, so a longer span opens before the
    // shorter one it contains and the close order stays a mirror image.
    spans.sort_by(|left, right| left.0.cmp(&right.0).then(right.1.cmp(&left.1)));

    let mut opens: BTreeMap<usize, Vec<&Wrapper>> = BTreeMap::new();
    let mut closes: BTreeMap<usize, Vec<&Wrapper>> = BTreeMap::new();
    for (start, end, wrapper) in &spans {
        opens.entry(*start).or_default().push(wrapper);
        // Innermost closes first: prepend, mirroring the open order at this point.
        closes.entry(*end).or_default().insert(0, wrapper);
    }

    let mut boundaries: Vec<usize> = opens.keys().chain(closes.keys()).copied().collect();
    boundaries.sort_unstable();
    boundaries.dedup();
    let mut html = String::new();
    let mut cursor = 0;
    for boundary in boundaries {
        html.push_str(&render_text(&units[cursor..boundary]));
        for wrapper in closes.get(&boundary).into_iter().flatten() {
            html.push_str(&wrapper.close);
        }
        for wrapper in opens.get(&boundary).into_iter().flatten() {
            html.push_str(&wrapper.open);
        }
        cursor = boundary;
    }
    html.push_str(&render_text(&units[cursor..]));
    html
}

fn entity_wrapper(entity: &Entity, raw: &str) -> Option<Wrapper> {
    let wrap = |open: &str, close: &str| {
        Some(Wrapper {
            open: open.into(),
            close: close.into(),
        })
    };
    let link = |href: String| {
        Some(Wrapper {
            open: format!(r#"<a href="{href}" rel="noopener noreferrer">"#),
            close: "</a>".into(),
        })
    };
    match entity.get("type").and_then(Value::as_str).unwrap_or("") {
        // Block entities an article body carries. Telegram cannot express them, so
        // they only ever arrive from a Markdown file -- but they render here, beside
        // every inline style, because the site must show the same document the X
        // Article renderer builds from the same text and entities.
        "heading" => {
            let level = match entity.get("level") {
                None | Some(Value::Null) => 2.0,
                level => number(level),
            };
            // `Math.min(Math.max(level, 1), 6)`: NaN survives both, as `<hNaN>`.
            let level = number_to_string(if level.is_nan() { level } else { level.clamp(1.0, 6.0) });
            Some(Wrapper {
                open: format!("<h{level}>"),
                close: format!("</h{level}>"),
            })
        }
        "quote" => wrap("<blockquote>", "</blockquote>"),
        "list_item" => wrap("<li>", "</li>"),
        "bold" => wrap("<strong>", "</strong>"),
        "italic" => wrap("<em>", "</em>"),
        "underline" => wrap("<u>", "</u>"),
        "strikethrough" => wrap("<s>", "</s>"),
        "spoiler" => wrap(r#"<span class="spoiler">"#, "</span>"),
        "code" => wrap("<code>", "</code>"),
        "pre" => wrap("<pre><code>", "</code></pre>"),
        "text_link" => match entity.get("url").and_then(Value::as_str) {
            Some(url) if is_http_url(url) => link(escape_html(url)),
            _ => None,
        },
        // A bare `url` entity's href is its own text. Telegram also auto-detects
        // schemeless domains, so it gets the same protocol check as text_link.
        "url" if is_http_url(raw) => link(escape_html(raw)),
        "url" if is_http_url(&format!("https://{raw}")) => link(format!("https://{}", escape_html(raw))),
        _ => None,
    }
}

fn render_text(units: &[u16]) -> String {
    escape_html(&String::from_utf16_lossy(units)).replace('\n', "<br>")
}

/// The first hidden link in reading order, for platforms that append at most one.
/// Telegram sends entities in offset order, but a payload can be re-serialized on
/// the way here, so the order is established rather than assumed. A missing or
/// null offset reads as 0; a non-numeric one sorts last.
pub fn first_text_link_url(entities: &[Entity]) -> Option<&str> {
    let offset = |entity: &Entity| match entity.get("offset") {
        None | Some(Value::Null) => 0.0,
        offset => number(offset),
    };
    let mut ordered: Vec<&Entity> = entities.iter().collect();
    ordered.sort_by(|left, right| offset(left).total_cmp(&offset(right)));
    ordered.into_iter().find_map(|entity| {
        let url = entity.get("url").and_then(Value::as_str)?;
        (entity.get("type").and_then(Value::as_str) == Some("text_link") && is_http_url(url)).then_some(url)
    })
}

/// One text as the posts a chain platform carries it in: cut at the last
/// boundary that ends a thought -- a paragraph, then a sentence, then a word --
/// because a cut in the middle of a sentence is what makes a thread read like a
/// machine wrote it. Every piece fits `limit` UTF-16 units, and nothing is dropped.
pub fn split_text(text: &str, limit: usize) -> Vec<String> {
    let normalized = trim(text);
    if normalized.is_empty() {
        return vec![String::new()];
    }
    let mut parts = Vec::new();
    let mut remaining = normalized;
    while utf16_len(remaining) > limit {
        let take = cut_point(remaining, limit);
        parts.push(trim(&remaining[..take]).to_owned());
        remaining = trim(&remaining[take..]);
    }
    if !remaining.is_empty() {
        parts.push(remaining.to_owned());
    }
    parts
}

/// A piece shorter than half of the budget is a worse read than a cut closer
/// to the limit, so a boundary that early is not taken.
fn cut_point(text: &str, limit: usize) -> usize {
    // A character straddling the window's end is left out: its first half could
    // not have matched any boundary.
    let window = utf16_prefix(text, limit + 1);
    let floor = limit / 2;
    let boundaries = [
        window.rfind("\n\n"),
        last_sentence_end(window, limit),
        window.rfind('\n'),
        window.rfind(' '),
    ];
    for boundary in boundaries.into_iter().flatten() {
        let units = utf16_len(&window[..boundary]);
        if units > floor && units <= limit {
            return boundary;
        }
    }
    // No boundary at all -- a single unbroken run of characters. The cut lands on
    // `limit` exactly unless that falls between the halves of a surrogate pair;
    // then it backs off one unit and the whole character travels with the next part.
    utf16_to_byte(text, limit)
        .or_else(|| utf16_to_byte(text, limit - 1))
        .expect("a position inside a surrogate pair follows a character boundary")
}

const SENTENCE_TERMINATORS: [char; 4] = ['.', '!', '?', '\u{2026}'];
const SENTENCE_CLOSERS: [char; 7] = ['"', '\'', '\u{bb}', '\u{201d}', '\u{2019}', ')', ']'];

/// Where the last sentence ending inside the window finishes, its closing
/// quotes and brackets included: terminators, closers, then whitespace. A dot
/// followed by a lowercase letter ends an abbreviation rather than a sentence,
/// and cutting there splits one.
fn last_sentence_end(window: &str, limit: usize) -> Option<usize> {
    let mut end = None;
    let mut cursor = 0;
    while let Some(c) = window[cursor..].chars().next() {
        if !SENTENCE_TERMINATORS.contains(&c) {
            cursor += c.len_utf8();
            continue;
        }
        let rest = &window[cursor..];
        let terminators = rest.find(|c| !SENTENCE_TERMINATORS.contains(&c)).unwrap_or(rest.len());
        let closers = rest[terminators..]
            .find(|c| !SENTENCE_CLOSERS.contains(&c))
            .map_or(rest.len(), |closers| terminators + closers);
        if !rest[closers..].chars().next().is_some_and(is_whitespace) {
            cursor += c.len_utf8();
            continue;
        }
        let match_end = cursor + closers;
        let after = trim_start(&window[match_end..]).chars().next();
        if !after.is_some_and(is_lowercase_letter) && utf16_len(&window[..match_end]) <= limit {
            end = Some(match_end);
        }
        cursor = match_end;
    }
    end
}

/// `after.toLowerCase() === after && after.toUpperCase() !== after` over one
/// UTF-16 unit: a character outside the BMP was only its high surrogate there,
/// which has no case.
fn is_lowercase_letter(c: char) -> bool {
    c.len_utf16() == 1 && c.to_lowercase().eq(std::iter::once(c)) && !c.to_uppercase().eq(std::iter::once(c))
}
