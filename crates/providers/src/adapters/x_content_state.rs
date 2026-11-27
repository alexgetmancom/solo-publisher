//! X's rich-text representation for
//! Article bodies, DraftJS raw state with snake_case field names. Blocks carry
//! their own text and ranges; one entity map is shared across them. The
//! source is the form every other target reads — plain text plus
//! offset/length entities — so an article body is written once and rendered
//! per platform. Offsets are UTF-16 units throughout.

use content::message::{Entity, entity_span};
use foundation::text::{TrimText, utf16_slice};
use foundation::url::is_http_url;
use serde_json::{Map, Value, json};

struct Span<'a> {
    start: usize,
    end: usize,
    entity: &'a Entity,
}

fn entity_type(entity: &Entity) -> String {
    entity
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned()
}

fn inline_style(kind: &str) -> Option<&'static str> {
    Some(match kind {
        "bold" => "BOLD",
        "italic" => "ITALIC",
        "underline" => "UNDERLINE",
        "strikethrough" => "STRIKETHROUGH",
        "code" => "CODE",
        _ => return None,
    })
}

fn block_type(kind: &str) -> Option<&'static str> {
    Some(match kind {
        "heading" => "header-two",
        "quote" => "blockquote",
        "list_item" => "unordered-list-item",
        "pre" => "code-block",
        _ => return None,
    })
}

/// `toContentState(text, entities, media)`. Media become trailing atomic
/// blocks: the source carries media beside the text rather than inside it,
/// and inventing a position would put an image where the author never did.
pub fn to_content_state(text: &str, entities: &[Entity], media: &[String]) -> Value {
    let units: Vec<u16> = text.encode_utf16().collect();
    let spans = normalize_spans(units.len(), entities);
    let mut entity_map = Map::new();
    let mut blocks = Vec::new();
    let mut cursor = 0;
    let mut entity_key = 0usize;

    for (index, line) in units.split(|unit| *unit == u16::from(b'\n')).enumerate() {
        let line_start = cursor;
        let line_end = line_start + line.len();
        cursor = line_end + 1;
        let line_text = String::from_utf16_lossy(line);
        // A blank line separates paragraphs in the source and carries no
        // content of its own; emitting it would double every paragraph gap.
        if line_text.trim_text().is_empty() {
            continue;
        }
        let covering: Vec<&Span> = spans
            .iter()
            .filter(|span| span.start < line_end && span.end > line_start)
            .collect();
        let mut inline_ranges = Vec::new();
        let mut entity_ranges = Vec::new();
        for span in &covering {
            let offset = span.start.max(line_start) - line_start;
            let Some(length) = (span.end.min(line_end) - line_start)
                .checked_sub(offset)
                .filter(|length| *length > 0)
            else {
                continue;
            };
            if let Some(style) = inline_style(&entity_type(span.entity)) {
                inline_ranges.push(json!({"offset": offset, "length": length, "style": style}));
                continue;
            }
            let Some(url) = link_url(span, &units) else { continue };
            entity_map.insert(
                entity_key.to_string(),
                json!({"type": "LINK", "mutability": "MUTABLE", "data": {"url": url}}),
            );
            entity_ranges.push(json!({"offset": offset, "length": length, "key": entity_key}));
            entity_key += 1;
        }
        blocks.push(json!({
            "key": format!("b{index}"),
            "text": line_text,
            "type": block_type_of(&covering, line_start, line_end),
            "depth": 0,
            "inline_style_ranges": inline_ranges,
            "entity_ranges": entity_ranges,
        }));
    }

    for (index, media_id) in media.iter().enumerate() {
        entity_map.insert(
            entity_key.to_string(),
            json!({"type": "MEDIA", "mutability": "IMMUTABLE", "data": {"media_id": media_id}}),
        );
        blocks.push(json!({
            "key": format!("m{index}"),
            "text": " ",
            "type": "atomic",
            "depth": 0,
            "inline_style_ranges": [],
            "entity_ranges": [{"offset": 0, "length": 1, "key": entity_key}],
        }));
        entity_key += 1;
    }

    // An Article with no body still needs one block: an empty `blocks` array
    // is rejected by the draft endpoint rather than read as an empty document.
    if blocks.is_empty() {
        blocks.push(json!({
            "key": "b0", "text": "", "type": "unstyled", "depth": 0, "inline_style_ranges": [], "entity_ranges": [],
        }));
    }
    json!({"blocks": blocks, "entity_map": entity_map})
}

/// A block type is declared by an entity covering the whole line; anything
/// partial is inline styling, whatever its type says.
fn block_type_of(covering: &[&Span], line_start: usize, line_end: usize) -> &'static str {
    for span in covering {
        let Some(kind) = block_type(&entity_type(span.entity)) else {
            continue;
        };
        if span.start > line_start || span.end < line_end {
            continue;
        }
        if kind != "header-two" {
            return kind;
        }
        let level = span.entity.get("level").and_then(Value::as_f64).unwrap_or(2.0);
        return if level <= 1.0 { "header-one" } else { "header-two" };
    }
    "unstyled"
}

fn normalize_spans(text_length: usize, entities: &[Entity]) -> Vec<Span<'_>> {
    let mut spans: Vec<Span> = entities
        .iter()
        .filter_map(|entity| {
            let (offset, length) = entity_span(entity)?;
            let (offset, length) = (offset as usize, length as usize);
            if length == 0 || offset + length > text_length {
                return None;
            }
            Some(Span {
                start: offset,
                end: offset + length,
                entity,
            })
        })
        .collect();
    spans.sort_by(|left, right| left.start.cmp(&right.start).then(right.end.cmp(&left.end)));
    spans
}

fn link_url(span: &Span, units: &[u16]) -> Option<String> {
    let kind = entity_type(span.entity);
    if kind == "text_link" {
        return span
            .entity
            .get("url")
            .and_then(Value::as_str)
            .filter(|url| is_http_url(url))
            .map(str::to_owned);
    }
    if kind != "url" {
        return None;
    }
    let raw = utf16_slice(units, span.start, span.end);
    if is_http_url(&raw) {
        return Some(raw);
    }
    let prefixed = format!("https://{raw}");
    is_http_url(&prefixed).then_some(prefixed)
}
