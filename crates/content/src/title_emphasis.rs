use std::sync::LazyLock;

use foundation::text::utf16_len;
use regex::Regex;
use serde_json::{Map, Value};

use crate::message::{Entity, entity_offset};

/// The longest first line still read as a title. Above this the "line, blank
/// line, body" shape is an opening paragraph, not a headline, and bolding it
/// would shout a whole paragraph at the reader.
const TITLE_LIMIT: usize = 120;

static TITLE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^([^\n\r]+)\r?\n[ \t]*\r?\n\s*\S").unwrap());

/// The entities of a text, with its title bold.
///
/// A post written here is a title, a blank line, and a body, and the title is
/// always set bold by hand afterwards. That is a property of the text, not of
/// the interface that carried it or of the language it is in, so both drafting
/// a post and replacing either language's text run through here.
///
/// Text without that shape is left alone, and so is a title the operator
/// already emphasized: the entity is added only when nothing bold covers the
/// first line yet. `length` is the title's UTF-16 length, the unit Telegram
/// entities are measured in.
pub fn emphasize_title(text: &str, entities: &[Entity]) -> Vec<Entity> {
    let Some(title_length) = title_length(text) else {
        return entities.to_vec();
    };
    let covered = entities.iter().any(|entity| {
        entity.get("type").and_then(Value::as_str) == Some("bold")
            && entity_offset(entity).is_some_and(|offset| offset < title_length as u64)
    });
    if covered {
        return entities.to_vec();
    }
    let mut bold = Map::new();
    bold.insert("type".into(), "bold".into());
    bold.insert("offset".into(), 0.into());
    bold.insert("length".into(), title_length.into());
    std::iter::once(bold).chain(entities.iter().cloned()).collect()
}

fn title_length(text: &str) -> Option<usize> {
    let title = TITLE.captures(text)?.get(1)?.as_str().trim_end();
    let length = utf16_len(title);
    (length > 0 && length <= TITLE_LIMIT).then_some(length)
}
