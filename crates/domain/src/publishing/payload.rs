//! The one durable job shape a publication source becomes for one target.

use content::message::{Entity, MediaItem, first_line};
use content::thread::{LocalizedThreadPart, joined_thread};
use foundation::js::string_of;
use serde_json::{Map, Value, json};

use super::media_policy::select_media_for_target;
use super::platform_profiles::platform_profile;
use super::publication_source::PublicationSource;
use crate::targets::{is_story_target, target_locale};

/// Resolves the dual-locale publication source into the job payload for one
/// target. A target whose locale this build does not know gets nothing: it is
/// not English, and guessing was how an unknown target got the English text.
pub fn localize_target_payload(source: &PublicationSource, target: &str) -> Map<String, Value> {
    let Some(locale) = target_locale(target) else {
        return Map::new();
    };
    let value = source.locale(locale);
    let story = is_story_target(target);
    // A Story is drawn from the first post alone. A platform that carries a
    // thread gets the parts as they are; any other publishes one post holding
    // the whole thread, its parts as paragraphs and their media after the first.
    let carries_thread = platform_profile(target).is_some_and(|profile| profile.thread.is_some());
    let joined = !story && !carries_thread;
    let (text, entities) = if joined {
        joined_thread(&value.text, &value.entities, &value.thread)
    } else {
        (value.text.clone(), value.entities.clone())
    };
    let raw_media: Vec<MediaItem> = if story && !value.story_media.is_empty() {
        value.story_media.clone()
    } else if joined {
        value
            .media
            .iter()
            .chain(value.thread.iter().flat_map(|part| part.media.iter()))
            .cloned()
            .collect()
    } else {
        value.media.clone()
    };
    let media_values: Vec<Value> = raw_media.into_iter().map(Value::Object).collect();
    let selected: Vec<Value> = select_media_for_target(target, &media_values, |item| item)
        .iter()
        .map(delivery_media)
        .collect();
    let thread: Vec<Value> = if carries_thread {
        value
            .thread
            .iter()
            .map(|part| {
                json!({
                    "text": part.text,
                    "entities": part.entities,
                    "media": part.media.iter().map(|item| delivery_media(&Value::Object(item.clone()))).collect::<Vec<_>>(),
                })
            })
            .collect()
    } else {
        Vec::new()
    };
    let mut localized = Map::new();
    localized.insert("locale".into(), json!(locale.as_str()));
    localized.insert("title".into(), json!(first_line(Some(&value.text), "Post")));
    localized.insert("text".into(), json!(text));
    localized.insert("media".into(), Value::Array(selected));
    localized.insert("entities".into(), entities_value(&entities));
    localized.insert("slug".into(), json!(value.slug));
    localized.insert("postId".into(), json!(source.post_id));
    localized.insert("draftId".into(), json!(source.draft_id));
    localized.insert("thread".into(), Value::Array(thread));
    let media = payload_media(&localized);
    localized.insert(
        "media".into(),
        Value::Array(media.into_iter().map(Value::Object).collect()),
    );
    localized
}

fn entities_value(entities: &[Entity]) -> Value {
    Value::Array(entities.iter().cloned().map(Value::Object).collect())
}

/// `a ?? b ?? c` over keys of one record: the first present and not null, else
/// whatever the last key holds (`null`, or absent).
fn coalesce(record: &Map<String, Value>, keys: &[&str]) -> Option<Value> {
    keys.iter()
        .find_map(|key| record.get(*key).filter(|value| !value.is_null()).cloned())
        .or_else(|| keys.last().and_then(|key| record.get(*key).cloned()))
}

/// The persisted Studio/Telegram media record in the one shape stored on
/// delivery jobs. Provider code never reads persistence field names. Absent
/// fields stay absent, as `JSON.stringify` drops `undefined`.
fn delivery_media(value: &Value) -> Value {
    let Value::Object(media) = value else {
        return value.clone();
    };
    let mut out = Map::new();
    for (key, sources) in [
        ("type", &["type"][..]),
        ("fileId", &["fileId", "file_id"]),
        ("localPath", &["localPath", "local_path", "path"]),
        ("vpsUrl", &["vpsUrl", "vps_url", "public_url"]),
        ("token", &["token"]),
        ("storyLocalPath", &["storyLocalPath", "story_local_path"]),
        (
            "telegramStoryLocalPath",
            &["telegramStoryLocalPath", "telegram_story_local_path"],
        ),
        ("storyVpsUrl", &["storyVpsUrl", "story_vps_url"]),
    ] {
        if let Some(found) = coalesce(media, sources) {
            out.insert(key.into(), found);
        }
    }
    Value::Object(out)
}

const MEDIA_STRING_FIELDS: [&str; 7] = [
    "localPath",
    "fileId",
    "token",
    "vpsUrl",
    "storyLocalPath",
    "telegramStoryLocalPath",
    "storyVpsUrl",
];

/// The media items a delivery adapter can actually send. An item without a type
/// it knows, or without a file, path or URL to send, is dropped; so is one whose
/// fields are not text.
pub fn payload_media(payload: &Map<String, Value>) -> Vec<Map<String, Value>> {
    if !publish_payload_parses(payload) {
        return Vec::new();
    }
    let values: Vec<&Value> = match payload.get("media") {
        Some(Value::Array(items)) => items.iter().collect(),
        Some(item @ Value::Object(_)) => vec![item],
        _ => Vec::new(),
    };
    values
        .into_iter()
        .filter_map(|value| {
            let Value::Object(record) = value else { return None };
            if MEDIA_STRING_FIELDS
                .iter()
                .any(|key| record.get(*key).is_some_and(|field| !field.is_string()))
            {
                return None;
            }
            let kind = match record.get("type") {
                None | Some(Value::Null) => String::new(),
                Some(kind) => string_of(kind).to_lowercase(),
            };
            let kind = match kind.as_str() {
                "image" | "photo" => "IMAGE",
                "video" => "VIDEO",
                _ => return None,
            };
            let field = |key: &str| {
                record
                    .get(key)
                    .and_then(Value::as_str)
                    .map(foundation::js::trim)
                    .unwrap_or("")
                    .to_owned()
            };
            let (local_path, file_id, vps_url) = (field("localPath"), field("fileId"), field("vpsUrl"));
            if local_path.is_empty() && file_id.is_empty() && vps_url.is_empty() {
                return None;
            }
            let mut item = Map::new();
            item.insert("type".into(), json!(kind));
            for (key, value) in [
                ("localPath", local_path),
                ("fileId", file_id),
                ("token", field("token")),
                ("vpsUrl", vps_url),
                ("storyLocalPath", field("storyLocalPath")),
                ("telegramStoryLocalPath", field("telegramStoryLocalPath")),
                ("storyVpsUrl", field("storyVpsUrl")),
            ] {
                if !value.is_empty() {
                    item.insert(key.into(), json!(value));
                }
            }
            Some(item)
        })
        .collect()
}

/// `payloadText`: the payload's text, trimmed; empty when the payload does
/// not parse.
pub fn payload_text(payload: &Map<String, Value>) -> String {
    if !publish_payload_parses(payload) {
        return String::new();
    }
    payload
        .get("text")
        .and_then(Value::as_str)
        .map_or("", foundation::js::trim)
        .to_owned()
}

/// `payloadThread`: the posts after the first, each with the media a
/// delivery adapter can send. Empty for an ordinary post.
pub fn payload_thread(payload: &Map<String, Value>) -> Vec<LocalizedThreadPart> {
    if !publish_payload_parses(payload) {
        return Vec::new();
    }
    let Some(Value::Array(parts)) = payload.get("thread") else {
        return Vec::new();
    };
    parts
        .iter()
        .map(|part| {
            let mut media = Map::new();
            if let Some(value) = part.get("media") {
                media.insert("media".into(), value.clone());
            }
            LocalizedThreadPart {
                text: part["text"].as_str().unwrap_or_default().to_owned(),
                entities: part["entities"]
                    .as_array()
                    .map(|entities| {
                        entities
                            .iter()
                            .filter_map(|entity| entity.as_object().cloned())
                            .collect()
                    })
                    .unwrap_or_default(),
                media: payload_media(&media),
            }
        })
        .collect()
}

/// The payload schema `payloadMedia` reads through: a payload whose known
/// fields have the wrong type yields no media at all.
fn publish_payload_parses(payload: &Map<String, Value>) -> bool {
    fn records(value: &Value) -> bool {
        value.as_array().is_some_and(|items| items.iter().all(Value::is_object))
    }
    fn thread(value: &Value) -> bool {
        value.as_array().is_some_and(|parts| {
            parts
                .iter()
                .all(|part| part.get("text").is_some_and(Value::is_string) && part.get("entities").is_some_and(records))
        })
    }
    let optional = |key: &str, valid: fn(&Value) -> bool| payload.get(key).is_none_or(valid);
    optional("text", Value::is_string)
        && optional("title", Value::is_string)
        && optional("locale", Value::is_string)
        && optional("postId", |value| value.is_string() || value.is_number())
        && optional("draftId", |value| value.is_string() || value.is_number())
        && optional("slug", Value::is_string)
        && optional("entities", records)
        && optional("thread", thread)
}
