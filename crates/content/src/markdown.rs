//! Turns a Markdown article into the representation the rest of the system
//! already reads: plain text plus offset/length entities.
//!
//! Markdown lives only here, at the edge where a file arrives. Nothing
//! downstream knows the body was ever Markdown -- the site renderer and the X
//! Article renderer both read the same text and entities a Telegram message
//! produces, so an article written in a file and one written in a chat are the
//! same thing by the time they are stored.

use std::sync::LazyLock;

use foundation::text::{TrimText, utf16_len};
use foundation::url::is_http_url;
use regex::Regex;
use serde_json::{Map, Value};

use crate::message::{DraftMessage, Entity};

#[derive(Clone, Debug, PartialEq)]
pub struct ParsedArticle {
    pub title: String,
    pub body: DraftMessage,
}

/// A pattern whose `(.*)` stops at any line terminator, `\r` and U+2028/9
/// included, not only at `\n`.
fn regex(pattern: &str) -> Regex {
    Regex::new(&pattern.replace("(.*)", r"([^\n\r\x{2028}\x{2029}]*)")).unwrap()
}

static TITLE_LINE: LazyLock<Regex> = LazyLock::new(|| regex(r"^#\s+\S"));
static TITLE_MARKER: LazyLock<Regex> = LazyLock::new(|| regex(r"^#\s+"));
static HEADING: LazyLock<Regex> = LazyLock::new(|| regex(r"^(#{1,6})\s+(.*)$"));
static QUOTE: LazyLock<Regex> = LazyLock::new(|| regex(r"^>\s?(.*)$"));
static ITEM: LazyLock<Regex> = LazyLock::new(|| regex(r"^\s*[-*+]\s+(.*)$"));
static ORDERED: LazyLock<Regex> = LazyLock::new(|| regex(r"^\s*[0-9]+[.)]\s+(.*)$"));

/// The first `# ` heading is the article's title and leaves the body; a
/// document without one keeps its whole text as the body and reports no title,
/// so the caller decides what to do rather than being handed a guess.
pub fn parse_markdown_article(source: &str) -> ParsedArticle {
    let normalized = source.replace("\r\n", "\n").replace('\r', "\n");
    let mut lines: Vec<&str> = normalized.trim_text_end().split('\n').collect();
    let title = match lines.iter().position(|line| TITLE_LINE.is_match(line)) {
        Some(index) => TITLE_MARKER.replace(lines.remove(index), "").trim_text().to_owned(),
        None => String::new(),
    };
    ParsedArticle {
        title,
        body: render_body(trim_blank_edges(&lines)),
    }
}

fn render_body(lines: &[&str]) -> DraftMessage {
    let mut out = Vec::with_capacity(lines.len());
    let mut entities = Vec::new();
    let mut offset = 0;
    for raw in lines {
        let (block_text, block) = block_of(raw);
        let (text, inline) = inline_entities(block_text);
        let length = utf16_len(&text);
        if let Some((kind, level)) = block {
            let mut entity = entity(kind, offset as i64, length as i64);
            if let Some(level) = level {
                entity.insert("level".into(), level.into());
            }
            entities.push(entity);
        }
        for mut entity in inline {
            let shifted = entity["offset"].as_i64().unwrap() + offset as i64;
            entity.insert("offset".into(), shifted.into());
            entities.push(entity);
        }
        out.push(text);
        offset += length + 1; // the newline that rejoins the lines
    }
    DraftMessage {
        text: out.join("\n"),
        entities,
        ..DraftMessage::default()
    }
}

fn entity(kind: &str, offset: i64, length: i64) -> Entity {
    let mut entity = Map::new();
    entity.insert("type".into(), kind.into());
    entity.insert("offset".into(), offset.into());
    entity.insert("length".into(), length.into());
    entity
}

/// A line's text without its block marker, and the block entity it opens: a
/// heading carries its level.
fn block_of(line: &str) -> (&str, Option<(&'static str, Option<usize>)>) {
    if let Some(heading) = HEADING.captures(line) {
        return (
            heading.get(2).unwrap().as_str().trim_text(),
            Some(("heading", Some(heading[1].len()))),
        );
    }
    if let Some(quote) = QUOTE.captures(line) {
        return (quote.get(1).unwrap().as_str().trim_text(), Some(("quote", None)));
    }
    if let Some(item) = ITEM.captures(line).or_else(|| ORDERED.captures(line)) {
        return (item.get(1).unwrap().as_str().trim_text(), Some(("list_item", None)));
    }
    (line, None)
}

#[derive(Clone, Copy, PartialEq)]
enum Inline {
    TextLink,
    Bold,
    Italic,
    Strikethrough,
    Code,
}

impl Inline {
    fn name(self) -> &'static str {
        match self {
            Inline::TextLink => "text_link",
            Inline::Bold => "bold",
            Inline::Italic => "italic",
            Inline::Strikethrough => "strikethrough",
            Inline::Code => "code",
        }
    }
}

/// A marker found in a line: the byte range it spans, the byte range of the
/// text it wraps, and a link's target.
struct Marked {
    kind: Inline,
    whole: (usize, usize),
    inner: (usize, usize),
    url: Option<String>,
}

static TEXT_LINK: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\[([^\]\n]+)\]\(([^)\s]+)\)").unwrap());
static BOLD_STARS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\*\*([^*\n]+)\*\*").unwrap());
static BOLD_UNDERSCORES: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"__([^_\n]+)__").unwrap());
static STRIKETHROUGH: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"~~([^~\n]+)~~").unwrap());
static CODE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"`([^`\n]+)`").unwrap());

fn captured(kind: Inline, pattern: &Regex, text: &str) -> Option<Marked> {
    let found = pattern.captures(text)?;
    let (whole, inner) = (found.get(0).unwrap(), found.get(1).unwrap());
    Some(Marked {
        kind,
        whole: (whole.start(), whole.end()),
        inner: (inner.start(), inner.end()),
        url: found.get(2).map(|url| url.as_str().to_owned()),
    })
}

/// `(?<![m\w])m([^m\n]+)m(?!m)`: a single `*` or `_` pair that is not part of
/// a doubled marker or a word such as `snake_case`.
fn italic(text: &str, marker: char) -> Option<Marked> {
    let is_word = |c: char| c.is_ascii_alphanumeric() || c == '_';
    text.char_indices().find_map(|(start, c)| {
        if c != marker
            || text[..start]
                .chars()
                .next_back()
                .is_some_and(|prev| prev == marker || is_word(prev))
        {
            return None;
        }
        let body = start + marker.len_utf8();
        let close = body + text[body..].find([marker, '\n'])?;
        if close == body || !text[close..].starts_with(marker) || text[close + 1..].starts_with(marker) {
            return None;
        }
        Some(Marked {
            kind: Inline::Italic,
            whole: (start, close + 1),
            inner: (body, close),
            url: None,
        })
    })
}

/// Strips one line's markers, leftmost first, and records what each covered.
/// Offsets are against the stripped text, which is what every consumer measures
/// against -- computing them over the marked-up source is how a bold range ends
/// up two characters off.
fn inline_entities(line: &str) -> (String, Vec<Entity>) {
    let mut text = line.to_owned();
    let mut inline: Vec<Entity> = Vec::new();
    loop {
        // In pattern order, so the earlier pattern wins a shared start.
        let candidates = [
            captured(Inline::TextLink, &TEXT_LINK, &text),
            captured(Inline::Bold, &BOLD_STARS, &text),
            captured(Inline::Bold, &BOLD_UNDERSCORES, &text),
            italic(&text, '*'),
            italic(&text, '_'),
            captured(Inline::Strikethrough, &STRIKETHROUGH, &text),
            captured(Inline::Code, &CODE, &text),
        ];
        let Some(next) = candidates.into_iter().flatten().reduce(|best, candidate| {
            if candidate.whole.0 < best.whole.0 {
                candidate
            } else {
                best
            }
        }) else {
            break;
        };
        let inner = text[next.inner.0..next.inner.1].to_owned();
        let start = utf16_len(&text[..next.whole.0]) as i64;
        let consumed = (utf16_len(&text[next.whole.0..next.whole.1]) - utf16_len(&inner)) as i64;
        text.replace_range(next.whole.0..next.whole.1, &inner);
        // Everything already recorded that sits after this marker shifts left by
        // exactly what the marker took with it. An entity inside the marker's
        // span shifts by the closing half too, and can land before the marker or
        // below zero; the goldens record exactly that.
        for entity in &mut inline {
            let offset = entity["offset"].as_i64().unwrap();
            if offset > start {
                entity.insert("offset".into(), (offset - consumed).into());
            }
        }
        if next.kind == Inline::TextLink && !is_http_url(next.url.as_deref().unwrap_or("")) {
            continue;
        }
        let mut entity = entity(next.kind.name(), start, utf16_len(&inner) as i64);
        if let Some(url) = next.url {
            entity.insert("url".into(), Value::String(url));
        }
        inline.push(entity);
    }
    (text, inline)
}

fn trim_blank_edges<'a, 'b>(lines: &'b [&'a str]) -> &'b [&'a str] {
    let start = lines
        .iter()
        .position(|line| !line.trim_text().is_empty())
        .unwrap_or(lines.len());
    let end = lines
        .iter()
        .rposition(|line| !line.trim_text().is_empty())
        .map_or(start, |last| last + 1);
    &lines[start..end.max(start)]
}
