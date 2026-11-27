//! What an operator's message carries, captured transport-neutral:
//! its text or caption, their entities, and the one file
//! of each kind it attached.

use std::sync::LazyLock;

use content::message::{DraftMessage, MediaItem};
use regex::Regex;
use serde_json::{Map, Value};

use crate::api::types::{MediaFile, Message};
use crate::context::Ctx;

static VIDEO_DOCUMENT_NAME: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)\.(mp4|m4v|mov|webm|mkv|gif)$").unwrap());

/// `extractMessage(ctx)`: the update's message, or nothing at all.
pub fn extract_message(ctx: &Ctx) -> DraftMessage {
    ctx.update.message.as_ref().map(extract).unwrap_or_default()
}

fn extract(message: &Message) -> DraftMessage {
    let text = message
        .text
        .clone()
        .or_else(|| message.caption.clone())
        .unwrap_or_default();
    let entities = message
        .entities
        .as_ref()
        .or(message.caption_entities.as_ref())
        .map(|entities| {
            entities
                .iter()
                .filter_map(|entity| match serde_json::to_value(entity) {
                    Ok(Value::Object(object)) => Some(object),
                    _ => None,
                })
                .collect()
        })
        .unwrap_or_default();
    let mut media = Vec::new();
    if let Some(photo) = message.photo.as_ref().and_then(|sizes| sizes.last()) {
        media.push(item("photo", photo, &["width", "height", "file_size"]));
    }
    if let Some(video) = &message.video {
        media.push(item("video", video, &["width", "height", "duration", "file_size"]));
    }
    // A soundless video arrives as an animation, and the Bot API fills
    // `document` with the same file for backward compatibility. Taking both
    // put one attached file into the draft twice, and the album carrying the
    // twin file id was rejected whole by the Bot API server.
    if let Some(animation) = &message.animation {
        media.push(item(
            "video",
            animation,
            &["width", "height", "duration", "file_name", "mime_type", "file_size"],
        ));
    }
    let document = message.document.as_ref().filter(|_| message.animation.is_none());
    if let Some(document) = document {
        let name = document.file_name.as_deref().unwrap_or_default();
        let mime = document.mime_type.as_deref().unwrap_or_default();
        if mime.to_lowercase().starts_with("video/") || VIDEO_DOCUMENT_NAME.is_match(name) {
            // An empty name or type is left out, as `|| undefined` leaves it.
            let mut fields: Vec<&str> = Vec::new();
            if !name.is_empty() {
                fields.push("file_name");
            }
            if !mime.is_empty() {
                fields.push("mime_type");
            }
            fields.push("file_size");
            media.push(item("video", document, &fields));
        }
    }
    DraftMessage {
        text,
        media,
        entities,
        ..DraftMessage::default()
    }
}

/// `{ type, file_id, ...fields }` in this order, an absent field left out
/// (`JSON.stringify` drops `undefined`).
fn item(kind: &str, file: &MediaFile, fields: &[&str]) -> MediaItem {
    let mut item = Map::new();
    item.insert("type".into(), kind.into());
    item.insert("file_id".into(), file.file_id.clone().into());
    for field in fields {
        let value = match *field {
            "width" => file.width.map(Value::from),
            "height" => file.height.map(Value::from),
            "duration" => file.duration.map(Value::from),
            "file_size" => file.file_size.map(Value::from),
            "file_name" => file.file_name.clone().map(Value::from),
            "mime_type" => file.mime_type.clone().map(Value::from),
            other => unreachable!("no media field {other}"),
        };
        if let Some(value) = value {
            item.insert((*field).into(), value);
        }
    }
    item
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn message(fields: Value) -> Message {
        let mut base = json!({"message_id": 1, "date": 0, "chat": {"id": 1, "type": "private"}});
        base.as_object_mut()
            .unwrap()
            .extend(fields.as_object().unwrap().clone());
        serde_json::from_value(base).unwrap()
    }

    #[test]
    fn takes_the_largest_photo_and_the_caption() {
        let captured = extract(&message(json!({
            "caption": "c",
            "caption_entities": [{"type": "bold", "offset": 0, "length": 1}],
            "photo": [
                {"file_id": "s", "file_unique_id": "s", "width": 90, "height": 90, "file_size": 10},
                {"file_id": "l", "file_unique_id": "l", "width": 900, "height": 900}
            ]
        })));
        assert_eq!(captured.text, "c");
        assert_eq!(
            Value::Array(captured.media.into_iter().map(Value::Object).collect()),
            json!([{"type": "photo", "file_id": "l", "width": 900, "height": 900}])
        );
        assert_eq!(
            Value::Object(captured.entities[0].clone()),
            json!({"type": "bold", "offset": 0, "length": 1})
        );
    }

    #[test]
    fn an_animation_is_one_video_and_its_document_twin_is_dropped() {
        let file = json!({"file_id": "a", "file_unique_id": "a", "width": 2, "height": 2, "duration": 3, "file_name": "a.mp4", "mime_type": "video/mp4"});
        let captured = extract(&message(json!({"animation": file, "document": file})));
        assert_eq!(
            Value::Array(captured.media.into_iter().map(Value::Object).collect()),
            json!([{"type": "video", "file_id": "a", "width": 2, "height": 2, "duration": 3, "file_name": "a.mp4", "mime_type": "video/mp4"}])
        );
    }

    #[test]
    fn a_document_is_a_video_by_its_type_or_its_name_only() {
        let video = extract(&message(
            json!({"document": {"file_id": "d", "file_name": "clip.MOV", "file_size": 5}}),
        ));
        assert_eq!(
            Value::Object(video.media[0].clone()),
            json!({"type": "video", "file_id": "d", "file_name": "clip.MOV", "file_size": 5})
        );
        let markdown = extract(&message(
            json!({"document": {"file_id": "m", "file_name": "a.md", "mime_type": "text/markdown"}}),
        ));
        assert!(markdown.media.is_empty());
        assert_eq!(markdown.text, "");
    }
}
